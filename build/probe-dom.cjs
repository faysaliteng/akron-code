// Dump the conversation DOM state for the currently open chat (dev, CDP).
// Usage: node build/probe-dom.cjs [port]
const WebSocket = require('../node_modules/ws');
const port = Number(process.argv[2] || 9333);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
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

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      const msgs = [...document.querySelectorAll('.msg')].map(m => ({
        cls: m.className,
        text: (m.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
      }));
      const errs = [...document.querySelectorAll('.errorbar')].map(e => (e.textContent || '').trim().slice(0, 200));
      const pill = document.querySelector('.model-pill');
      return { pill: pill ? pill.textContent.trim() : null, count: msgs.length, msgs: msgs.slice(-6), errs };
    })()`,
    returnByValue: true,
  });
  console.log(JSON.stringify(r.result.value, null, 2));
  cdp.close();
  process.exit(0);
})().catch(e => { console.error('DOM FAILED:', e.message); process.exit(1); });
