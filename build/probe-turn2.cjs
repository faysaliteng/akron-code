// Precise live-turn probe: new chat, unique token, wait for that token.
// Usage: node build/probe-turn2.cjs [port] [model] [account] [transport]
const WebSocket = require('../node_modules/ws');
const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'claude-opus-4-5';
const ACCOUNT = process.argv[4] || 'claude:rxpromedbd-gmail-com';
const TRANSPORT = process.argv[5] || 'anthropic';
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TOKEN = 'PING' + Math.floor(Math.random() * 1e6);

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target');
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    let id = 0; const pending = new Map();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); }
    });
    ws.on('open', () => resolve({
      send(method, params) { const mid = ++id; return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); }); },
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
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL:'', apiKey:'', model:${JSON.stringify(MODEL)}, supportsTools:true,
      oauthProvider:${JSON.stringify(ACCOUNT)}, transport:${JSON.stringify(TRANSPORT)}, oauth:true,
      accessToken:'', temperature:0.7, maxTokens:300, reasoningLevel:'auto' })); 'set'`);
  await cdp.send('Page.reload'); await sleep(5000);

  // always start a fresh conversation
  const newChat = await ev(cdp, `(async () => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) { b.click(); return 'clicked:' + (b.textContent||'').trim().slice(0,20); }
    return 'no-button';
  })()`);
  await sleep(2500);
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Reply with exactly: ${TOKEN}'); ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return 'typed';
  })()`);
  await sleep(400);
  await ev(cdp, `(() => { document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true })); return 'sent'; })()`);

  let last = null, done = false;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    last = await ev(cdp, `(() => {
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const txt = el ? (el.textContent||'').trim() : '';
      const err = document.querySelector('.errorbar');
      return { count: msgs.length, text: txt.slice(0,400), err: err ? (err.textContent||'').trim().slice(0,400) : null,
        leak: err ? /<[a-z!\\\\/][^>]*>/i.test(err.textContent||'') : false,
        streaming: !!document.querySelector('.streaming, .thinking') };
    })()`);
    if (last.text.includes('${TOKEN}') || last.err) { done = true; break; }
  }
  console.log(JSON.stringify({ token: TOKEN, newChat, ms: (last && last.count), done, final: last, pill: null }, null, 2));
  cdp.close(); process.exit(0);
})().catch(e => { console.error('TURN FAILED:', e.message); process.exit(1); });
