// Capture the REAL 1M-beta negotiation. A local proxy sits between the app and
// api.anthropic.com, logs the beta header on every attempt, and tees the
// upstream status + body so a rejection is legible instead of inferred.
// Usage: LC_LINES=8600 node build/probe-longctx-raw.cjs [port] [model]
const http = require('http');
const https = require('https');
const WebSocket = require('../node_modules/ws');

const PORT = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'claude-sonnet-4-5-20250929';
const ACCOUNT = process.env.LC_ACCOUNT || 'rxpromedbd-gmail-com';
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64e6 });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
    ws.on('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

(async () => {
  const attempts = [];
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const beta = String(req.headers['anthropic-beta'] || '');
      const rec = { beta, bodyChars: body.length, status: 0, note: '' };
      attempts.push(rec);
      console.log('→ attempt', attempts.length, '| beta:', beta, '| body:', body.length, 'chars');

      const up = https.request({
        host: 'api.anthropic.com',
        path: req.url,
        method: req.method,
        headers: Object.assign({}, req.headers, { host: 'api.anthropic.com' }),
      }, (ur) => {
        rec.status = ur.statusCode;
        const out = [];
        ur.on('data', (c) => { out.push(c); res.write(c); });
        ur.on('end', () => {
          res.end();
          const text = Buffer.concat(out).toString();
          if (ur.statusCode >= 400) {
            rec.note = text.slice(0, 700);
            console.log('← ', ur.statusCode, rec.note);
          } else {
            console.log('← ', ur.statusCode, '(streamed', text.length, 'chars)');
          }
        });
      });
      up.on('error', (e) => { rec.status = -1; rec.note = e.message; console.log('← proxy error', e.message); try { res.writeHead(502); res.end(); } catch (_) {} });
      up.write(body);
      up.end();
    });
  });
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  const proxyPort = proxy.address().port;
  console.log('proxy on 127.0.0.1:' + proxyPort);

  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');

  const before = await ev(cdp, `(async () => {
    const r = await window.autobot.providerModels('${ACCOUNT}');
    const m = (r && r.models || []).find(x => x.id === '${MODEL}');
    return m || null;
  })()`);
  console.log('window before:', before && before.windowLabel, before && before.contextWindow);

  const TOKEN = 'LONGRAW' + Math.floor(Math.random() * 1e6);
  const LINES = Number(process.env.LC_LINES || 8600);
  const pad = Array.from({ length: LINES }, (_, i) =>
    'Filler ' + String(i).padStart(4, '0') + ': the quick brown fox jumps over the lazy dog while the band plays on.').join('\n');
  console.log('pad chars   :', pad.length);

  const started = Date.now();
  await ev(cdp, `(() => {
    window.__lr = { events: [], done: false, usage: null, last: null };
    const off = window.autobot.onEvent((e) => {
      if (!e || !e.runId || e.runId !== window.__lrRun) return;
      if (e.type === 'usage' && e.usage) window.__lr.usage = e.usage;
      window.__lr.events.push({ type: e.type, error: e.error || null });
      if (e.type === 'complete' && e.messages) window.__lr.last = e.messages[e.messages.length - 1];
      if (e.type === 'complete' || e.type === 'error') { window.__lr.done = true; off(); }
    });
    window.__lrRun = 'lr' + Date.now();
    window.autobot.run({
      runId: window.__lrRun,
      messages: [{ role: 'user', content: ${JSON.stringify(pad + '\n\nIgnore every filler line above. Reply with exactly this token and nothing else: ' + TOKEN + '. Do not call any tool.')} }],
      provider: { oauthProvider: '${ACCOUNT}', model: '${MODEL}', baseURL: 'http://127.0.0.1:${proxyPort}', supportsTools: true, reasoningLevel: 'auto' },
      permissions: 'auto',
      title: 'long-context raw check',
    }).catch((e) => { window.__lr.events.push({ type: 'error', error: String(e && e.message || e) }); window.__lr.done = true; });
    return true;
  })()`);

  let snap = null;
  for (let i = 0; i < 420; i++) {
    await sleep(1000);
    snap = await ev(cdp, `({ done: window.__lr.done, events: window.__lr.events, last: window.__lr.last, usage: window.__lr.usage })`);
    if (snap.done) break;
  }
  const after = await ev(cdp, `(async () => {
    const r = await window.autobot.providerModels('${ACCOUNT}');
    const m = (r && r.models || []).find(x => x.id === '${MODEL}');
    return m || null;
  })()`);
  cdp.close();
  proxy.close();

  const text = String((snap.last && snap.last.content) || '');
  const usage = snap.usage || {};
  const inTok = Number(usage.prompt_tokens || usage.input_tokens || 0);
  console.log('\n--- attempts ---');
  attempts.forEach((a, i) => console.log(i + 1, '| status', a.status, '| beta:', a.beta, a.note ? '\n    ' + a.note.replace(/\n/g, ' ') : ''));
  console.log('\n--- result ---');
  console.log('seconds        :', Math.round((Date.now() - started) / 1000));
  console.log('answer has tok :', text.includes(TOKEN));
  console.log('answer tail    :', JSON.stringify(text.slice(-140)));
  console.log('prompt_tokens  :', inTok);
  console.log('window after   :', after && after.windowLabel, after && after.contextWindow);
  console.log('beta sent      :', attempts.some((a) => /context-1m/.test(a.beta)));
  console.log('PASS           :', !!snap.done && text.includes(TOKEN) && inTok > 190000);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
