// UI probe: open the built-in browser pane, exercise the ··· menu, and capture
// the renderer so the chrome can be eyeballed. Usage: node build/probe-ui.cjs [port] [out.png]
const fs = require('fs');
const WebSocket = require('../node_modules/ws');
const port = Number(process.argv[2] || 9333);
const out = process.argv[3] || '/tmp/akron-ui.png';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && /index\.html|127\.0\.0\.1:5173/.test(t.url || ''));
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

const ev = (cdp, expression) => cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  .then((r) => (r.exceptionDetails ? { __err: r.exceptionDetails.text } : r.result.value));

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await sleep(4000);

  // Open the browser pane from the sidebar rail.
  const opened = await ev(cdp, `(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => /Browser\s*$/.test((x.textContent || '').trim()));
    if (!b) return 'no rail button';
    b.click();
    return 'clicked';
  })()`);
  await sleep(2500);

  const info = await ev(cdp, `(() => {
    const q = (s) => document.querySelector(s);
    const panel = q('.browser-panel');
    return {
      opened: !!panel,
      toolbarBtns: [...(q('.browser-toolbar')?.querySelectorAll('button') || [])].length,
      hasMenuBtn: !!q('.browser-menu-btn'),
      devCard: q('.devfound') ? q('.devfound').textContent.replace(/\\s+/g, ' ').trim() : null,
      devDetail: window.autobot?.devServerDetect ? null : 'no api',
      placeholder: q('.omnibox input')?.placeholder || null,
      composerHint: q('.composer-hint') ? q('.composer-hint').textContent.trim() : null,
      ctxBtn: !!q('.ctx-btn'),
      ctxTitle: q('.ctx-btn')?.title || null,
      envBtn: !!q('.conv-env-btn'),
    };
  })()`);

  // Live dev-server detection for the current folder.
  const dev = await ev(cdp, `(async () => {
    const r = await window.autobot.devServerDetect(undefined).catch(e => ({ error: String(e) }));
    return r;
  })()`);

  // Open the ··· menu.
  await ev(cdp, `(() => { const b = document.querySelector('.browser-menu-btn'); if (b) b.click(); return true; })()`);
  await sleep(600);
  const menu = await ev(cdp, `(() => {
    const m = document.querySelector('.browser-menu');
    if (!m) return null;
    return { items: [...m.querySelectorAll('.bm-item')].map(x => x.textContent.replace(/\\s+/g, ' ').trim()), clipped: m.getBoundingClientRect().bottom > window.innerHeight };
  })()`);

  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));

  console.log(JSON.stringify({ opened, info, dev, menu, shot: out }, null, 2));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('UI FAILED:', e.message); process.exit(1); });
