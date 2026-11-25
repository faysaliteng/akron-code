// Packaged-app probe: branding, palette, and the FreeLLMAPI bridge.
// Usage: node build/probe-packaged.cjs [port]
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9444);
const BASE = `http://127.0.0.1:${port}`;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function findPage() {
  for (let i = 0; i < 90; i++) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find(t => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) { /* not up yet */ }
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
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      }
    });
    ws.on('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => {
          pending.set(mid, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
        });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}

async function evaluate(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', {
    expression, awaitPromise: true, returnByValue: true, userGesture: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}));
  return r.result.value;
}

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await sleep(1500);

  const out = {};
  out.url = await evaluate(cdp, 'location.href');
  out.title = await evaluate(cdp, 'document.title');
  out.accent = await evaluate(cdp,
    'getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()');
  out.accentStrong = await evaluate(cdp,
    'getComputedStyle(document.documentElement).getPropertyValue("--accent-strong").trim()');
  out.logo = await evaluate(cdp, `(() => {
    const el = document.querySelector('.titlebar .logo') || document.querySelector('svg.logo');
    if (!el) return null;
    const svg = el.tagName.toLowerCase() === 'svg' ? el : el.querySelector('svg');
    if (!svg) return null;
    const fills = [...new Set([...svg.querySelectorAll('[fill]')].map(n => n.getAttribute('fill')).filter(f => f && f !== 'none'))];
    return { tag: svg.tagName, viewBox: svg.getAttribute('viewBox'), fills, hasFilter: !!svg.querySelector('filter') };
  })()`);
  out.freellmStatus = await evaluate(cdp, 'window.autobot && window.autobot.freellmStatus ? window.autobot.freellmStatus() : "no bridge"');
  out.freellmProviders = await evaluate(cdp, `(async () => {
    if (!window.autobot || !window.autobot.freellmProviders) return 'no bridge';
    const r = await window.autobot.freellmProviders();
    return { ok: r && r.ok, ids: (r && r.providers || []).map(p => p.id), defaults: (r && r.providers || []).map(p => p.defaultModel) };
  })()`);
  out.preset = await evaluate(cdp, `(() => {
    const s = document.querySelector('select');
    if (!s) return null;
    return [...s.options].map(o => o.textContent.trim()).filter(t => /FreeLLMAPI/i.test(t));
  })()`);
  out.emeraldAnywhere = await evaluate(cdp, `(() => {
    const bad = [];
    for (const n of document.querySelectorAll('*')) {
      const s = (n.getAttribute && n.getAttribute('style')) || '';
      if (/d97757/i.test(s)) bad.push(n.className || n.tagName);
    }
    return bad.slice(0, 5);
  })()`);
  out.tabs = await evaluate(cdp, `[...document.querySelectorAll('.artifact-tabs button')].map(b => b.textContent.trim())`);
  out.html = await evaluate(cdp, 'document.documentElement.outerHTML.length');

  console.log(JSON.stringify(out, null, 2));
  cdp.close();
  process.exit(0);
})().catch(err => { console.error('PROBE FAILED:', err.message); process.exit(1); });
