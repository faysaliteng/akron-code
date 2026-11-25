// Show exactly what the app puts on the wire for a plain turn: system prompt
// size, tool-schema size, message bytes, and the app's own token estimate.
// A local stub stands in for Anthropic so nothing is spent.
// Usage: node build/probe-body.cjs [port]
const http = require('http');
const WebSocket = require('../node_modules/ws');

const PORT = Number(process.argv[2] || 9333);
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
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { seen.push(JSON.parse(body)); } catch (_) { seen.push({ raw: body }); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: ' + JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'stub-ok' } }) + '\n\n');
      res.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } }) + '\n\n');
      res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
      res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  const runId = 'body' + Date.now();
  await ev(cdp, `(() => {
    window.__bd = { done: false, err: null };
    const off = window.autobot.onEvent((e) => {
      if (!e || e.runId !== '${runId}') return;
      if (e.type === 'complete') { window.__bd.done = true; off(); }
      if (e.type === 'error') { window.__bd.err = e.error || 'error'; window.__bd.done = true; off(); }
    });
    window.autobot.run({
      runId: '${runId}',
      messages: [{ role: 'user', content: 'say hi' }],
      provider: { transport: 'anthropic', model: 'claude-sonnet-4-5-20250929', accessToken: 'stub', oauth: true, baseURL: 'http://127.0.0.1:${port}', supportsTools: true, reasoningLevel: 'auto' },
      permissions: 'auto', title: 'body check',
    }).catch((e) => { window.__bd.err = String(e && e.message || e); window.__bd.done = true; });
    return true;
  })()`);
  for (let i = 0; i < 90; i++) {
    await sleep(500);
    const s = await ev(cdp, 'window.__bd');
    if (s.done) { if (s.err) console.log('run error:', s.err); break; }
  }
  cdp.close();
  srv.close();
  if (!seen.length) { console.log('no request captured'); return; }
  const b = seen[0];
  const sys = Array.isArray(b.system) ? b.system.map((s) => s.text || '').join('\n') : String(b.system || '');
  const sysTok = sys.length / 3.4;
  const tools = b.tools || [];
  const toolChars = JSON.stringify(tools).length;
  const msgChars = JSON.stringify(b.messages || b.input || '').length;
  const all = JSON.stringify(b).length;
  console.log('requests        :', seen.length);
  console.log('keys            :', Object.keys(b).join(', '));
  console.log('system chars    :', sys.length, '≈', Math.round(sysTok), 'tok');
  console.log('tool count      :', tools.length, 'schema chars', toolChars, '≈', Math.round(toolChars / 3.4), 'tok');
  console.log('messages chars  :', msgChars);
  console.log('total body chars:', all, '≈', Math.round(all / 3.4), 'tok');
  console.log('beta header     :', 'n/a (headers not logged)');
  console.log('max_tokens      :', b.max_tokens);
  // Rank the biggest tool schemas, so a fat one is obvious.
  const ranked = tools.map((t) => [t.name || (t.function && t.function.name), JSON.stringify(t).length])
    .sort((a, c) => c[1] - a[1]).slice(0, 8);
  console.log('biggest tools   :', JSON.stringify(ranked));
  const sysHead = sys.slice(0, 300).replace(/\s+/g, ' ');
  console.log('system head     :', sysHead);
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
