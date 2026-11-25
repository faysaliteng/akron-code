// Live in-app turn against the Grok subscription account (dev app, CDP).
// Proves the 402 "out of allowance" prose reaches the banner instead of the
// vendor JSON envelope. Usage: node build/probe-grok-turn.cjs [port] [model]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'grok-4.5';
const KIND = process.argv[4] || 'grok';
const ACCOUNTS = {
  grok: { oauthProvider: 'grok:primox2014-gmail-com', transport: 'grok' },
  claude: { oauthProvider: 'claude:rxpromedbd-gmail-com', transport: 'anthropic' },
};
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

  // Point the app at the stored Grok subscription account (the same shape the
  // account picker writes: transport + oauthProvider, no key, no baseURL).
  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL: '', apiKey: '', model: ${JSON.stringify(MODEL)},
      supportsTools: true, oauthProvider: ${JSON.stringify(ACCOUNTS[KIND].oauthProvider)},
      transport: ${JSON.stringify(ACCOUNTS[KIND].transport)}, oauth: true, accessToken: '',
      temperature: 0.7, maxTokens: 300, reasoningLevel: 'auto'
    })); 'set'`);
  await cdp.send('Page.reload', { ignoreCache: false });
  await sleep(4000);

  const opened = await ev(cdp, `(async () => {
    const row = document.querySelector('.conv');
    if (row) { row.click(); return 'clicked-conv'; }
    const btn = [...document.querySelectorAll('button')].find(b => /new chat|new/i.test(b.textContent || ''));
    if (btn) { btn.click(); return 'clicked-new'; }
    return 'none';
  })()`);
  await sleep(2500);

  const pill = await ev(cdp, `(() => { const p = document.querySelector('.model-pill'); return p ? p.textContent.trim() : null; })()`);

  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, 'Reply with exactly: GROK-OK');
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

  let last = null;
  for (let i = 0; i < 45; i++) {
    await sleep(1000);
    last = await ev(cdp, `(() => {
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const err = document.querySelector('.errorbar');
      return {
        text: el ? (el.textContent || '').trim().slice(0, 300) : '',
        error: err ? (err.textContent || '').trim().slice(0, 400) : null,
        markupLeak: err ? /<[a-z!\\/][^>]*>/i.test(err.textContent || '') : false,
        hasEnvelope: err ? /\\{"error"|"request_id"|"rate_limit_error"/.test(err.textContent || '') : false,
        thinking: !!document.querySelector('.thinking, .streaming'),
      };
    })()`);
    if (last.error || (last.text && !last.thinking && !/^Thinking/i.test(last.text))) break;
  }

  console.log(JSON.stringify({ opened, pill, final: last }, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('GROK TURN FAILED:', e.message); process.exit(1); });
