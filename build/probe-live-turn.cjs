// Live in-app turn against the FreeLLMAPI preset (packaged app, CDP).
// Usage: node build/probe-live-turn.cjs [port]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9444);
const MODEL = process.argv[3] || 'auto';
const BASE = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
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
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  // 1. point the app at the local router
  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      name: 'FreeLLMAPI', baseURL: 'http://localhost:3001/v1', model: ${JSON.stringify(MODEL)},
      apiKey: '', temperature: 0.7, maxTokens: 300, reasoningLevel: 'auto', supportsTools: true
    })); 'set'`);
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(3500);

  // 2. open (or create) a conversation
  const opened = await ev(cdp, `(async () => {
    const row = document.querySelector('.conv');
    if (row) { row.click(); return 'clicked-conv'; }
    const btn = [...document.querySelectorAll('button')].find(b => /new chat|new/i.test(b.textContent || ''));
    if (btn) { btn.click(); return 'clicked-new'; }
    return 'none';
  })()`);
  await sleep(2500);

  const providerSeen = await ev(cdp, `(() => {
    const pill = document.querySelector('.model-pill');
    return { pill: pill ? pill.textContent.trim() : null, convs: document.querySelectorAll('.conv').length };
  })()`);

  // 3. type and send
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Reply with exactly: ROUTER-OK');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return 'typed';
  })()`);
  await sleep(300);
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    return 'sent';
  })()`);

  // 4. poll for the assistant reply
  let last = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    last = await ev(cdp, `(() => {
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const err = document.querySelector('.errorbar');
      const tools = [...document.querySelectorAll('.toolcard')].map(t => (t.textContent || '').trim().slice(0, 60));
      return {
        count: msgs.length,
        text: el ? (el.textContent || '').trim().slice(0, 400) : '',
        error: err ? (err.textContent || '').trim().slice(0, 300) : null,
        markupLeak: err ? /<[a-z!\\/][^>]*>/i.test(err.textContent || '') : false,
        tools,
        thinking: !!document.querySelector('.thinking, .msg.assistant .cursor, .streaming'),
      };
    })()`);
    if (last.text && !last.thinking) break;
  }

  console.log(JSON.stringify({ opened, providerSeen, final: last }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('LIVE FAILED:', e.message); process.exit(1); });
