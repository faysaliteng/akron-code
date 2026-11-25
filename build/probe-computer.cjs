// Prove PC control end-to-end: model calls the computer tool, the consent modal
// is answered, and the executor returns real screen geometry. (live, CDP)
// Usage: node build/probe-computer.cjs [port] [model] [account] [transport]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'gemini-4-hydrogen-high';
const ACCOUNT = process.argv[4] || 'antigravity:6969loavbal-gmail-com';
const TRANSPORT = process.argv[5] || 'google';
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

// The model sees the ADVERTISED name (mcp__computer__screen_size), not the
// executor name (computer_screen_size) — asking for the executor is a no-op.
const PROMPT = 'Call the tool named mcp__computer__screen_size right now. Do not answer from memory. Then reply with exactly one line: SCREEN=WxH using the numbers the tool returned.';

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  let advertised = null;
  try {
    advertised = await ev(cdp, `(async () => {
      if (!window.autobot || typeof window.autobot.toolNames !== 'function') return null;
      const r = await window.autobot.toolNames();
      return Array.isArray(r) ? r.length : r;
    })()`);
  } catch (_) { advertised = null; }

  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL:'', apiKey:'', model:${JSON.stringify(MODEL)}, supportsTools:true,
      oauthProvider:${JSON.stringify(ACCOUNT)}, transport:${JSON.stringify(TRANSPORT)}, oauth:true,
      accessToken:'', temperature:0.7, maxTokens:2000, reasoningLevel:'auto' })); 'set'`);
  await cdp.send('Page.reload');
  await sleep(5000);

  await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(2200);

  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus(); return 'typed';
  })()`);
  await sleep(400);
  await ev(cdp, `(() => {
    document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    return 'sent';
  })()`);

  let consented = 0;
  const consentLabels = [];
  let snap = null;
  for (let i = 0; i < 120; i++) {
    await sleep(1000);
    const modal = await ev(cdp, `(() => {
      const overlay = [...document.querySelectorAll('.modal-overlay')].find(o => /Allow Computer Use/i.test(o.textContent || ''));
      if (!overlay) return null;
      const btn = [...overlay.querySelectorAll('button')].find(b => /allow/i.test(b.textContent || ''));
      const label = overlay.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300);
      if (btn) { btn.click(); return { clicked: true, label }; }
      return { clicked: false, label };
    })()`);
    if (modal) {
      consented += 1;
      consentLabels.push(modal.label);
      await sleep(1500);
    }
    snap = await ev(cdp, `(() => {
      const cards = [...document.querySelectorAll('.toolcard')];
      const names = cards.map(c => {
        const v = c.querySelector('.tool-name'); const t = c.querySelector('.tool-args');
        const res = c.querySelector('.tool-result');
        return ((v && v.textContent) || '').trim() + ':' + ((t && t.textContent) || '').trim().slice(0, 60)
          + ((res && res.textContent) ? ' => ' + res.textContent.trim().slice(0, 120) : '');
      });
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const text = msgs.map(m => (m.textContent || '').trim()).join(' ~ ').slice(-2000);
      const err = document.querySelector('.errorbar');
      return {
        names,
        text,
        err: err ? (err.textContent || '').trim().slice(0, 240) : null,
        streaming: !!document.querySelector('.streaming, .thinking'),
      };
    })()`);
    if (snap.err) break;
    if (!snap.streaming && /SCREEN=\d+/.test(snap.text)) break;
  }

  const joined = (snap && snap.names || []).join(' | ');
  const size = (snap && /SCREEN=(\d+)\s*[xX]\s*(\d+)/.exec(snap.text) || []);
  const result = {
    account: ACCOUNT,
    model: MODEL,
    transport: TRANSPORT,
    advertisedToolNames: Array.isArray(advertised) ? advertised.length : advertised,
    consentPrompts: consented,
    consentLabels,
    toolsCalled: snap ? snap.names : [],
    sawScreenTool: /screen_size/.test(joined),
    screen: size.length > 2 ? size[1] + 'x' + size[2] : null,
    error: snap && snap.err,
    tail: snap ? snap.text.slice(-400) : null,
  };
  result.pass = !!(result.sawScreenTool && result.screen && !result.error);
  console.log(JSON.stringify({ pass: result.pass, ...result }, null, 2));
  cdp.close();
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error('COMPUTER PROBE FAILED:', e.message); process.exit(1); });
