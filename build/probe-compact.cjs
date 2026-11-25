// Prove the "token limit" fix: an oversized single message is compacted and/or
// chunked, the turn still completes, and no raw provider token-limit markup
// reaches the user. (live, CDP)
// Usage: node build/probe-compact.cjs [port] [model] [account] [transport] [chars]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'tab_flash_lite_preview';
const ACCOUNT = process.argv[4] || 'antigravity:6969loavbal-gmail-com';
const TRANSPORT = process.argv[5] || 'google';
const CHARS = Number(process.argv[6] || 30000);
const BASE = `http://127.0.0.1:${port}`;
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
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error)));
        else p.resolve(m.result);
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value) || r.exceptionDetails.text || 'eval error');
  return r.result.value;
}

const TOKEN = 'CMPCT' + Math.floor(Math.random() * 1e6);
const FILLER = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu';

// Build a paste bigger than the 16K window's char budget, with the actual
// instruction LAST so the final chunk carries it.
function buildPrompt() {
  const lines = [];
  let size = 0;
  let i = 0;
  while (size < CHARS) {
    const line = 'filler line ' + (++i) + ': ' + FILLER;
    lines.push(line);
    size += line.length + 1;
  }
  lines.push('Ignore all of the filler above. Reply with exactly this token and nothing else: ' + TOKEN);
  return lines.join('\n');
}

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL:'', apiKey:'', model:${JSON.stringify(MODEL)}, supportsTools:true,
      oauthProvider:${JSON.stringify(ACCOUNT)}, transport:${JSON.stringify(TRANSPORT)}, oauth:true,
      accessToken:'', temperature:0.5, maxTokens:1500, reasoningLevel:'auto' })); 'set'`);
  await cdp.send('Page.reload');
  await sleep(5000);

  await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(2200);

  const prompt = buildPrompt();
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(prompt)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus(); return 'typed';
  })()`);
  await sleep(500);
  const typedLen = await ev(cdp, `document.querySelector('.composer textarea').value.length`);
  await ev(cdp, `(() => {
    document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    return 'sent';
  })()`);

  const notices = new Set();
  let snap = null;
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    snap = await ev(cdp, `(() => {
      const n = document.querySelector('.noticebar');
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const text = msgs.map(m => (m.textContent || '').trim()).join(' ~ ');
      const err = document.querySelector('.errorbar');
      return {
        notice: n ? (n.textContent || '').trim() : null,
        text,
        err: err ? (err.textContent || '').trim().slice(0, 300) : null,
        streaming: !!document.querySelector('.streaming, .thinking, .activity'),
      };
    })()`);
    if (snap.notice) notices.add(snap.notice);
    if (snap.err) break;
    if (!snap.streaming && snap.text.includes(TOKEN)) break;
    if (!snap.streaming && i > 25 && snap.text && !snap.streaming) {
      // give it a couple more idle polls, then stop
      if (i > 30) break;
    }
  }

  const all = [snap && snap.notice, snap && snap.err, snap && snap.text].filter(Boolean).join('\n');
  const result = {
    account: ACCOUNT,
    model: MODEL,
    transport: TRANSPORT,
    sentChars: prompt.length,
    typedLen,
    notices: [...notices],
    compacted: [...notices].some((n) => /compact/i.test(n)),
    gotToken: !!(snap && snap.text.includes(TOKEN)),
    rawLimitLeak: /token limit reached|maximum context length|prompt is too long|context_length_exceeded|too many tokens|request too large/i.test(all),
    markupLeak: /<[a-z!\/][^>]*>/i.test(all),
    error: snap && snap.err,
    tail: snap ? snap.text.slice(-400) : null,
  };
  result.pass = !!(result.gotToken && !result.rawLimitLeak && !result.markupLeak && !result.error);
  console.log(JSON.stringify({ pass: result.pass, ...result }, null, 2));
  cdp.close();
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error('COMPACT PROBE FAILED:', e.message); process.exit(1); });
