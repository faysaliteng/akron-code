// App-build probe: can the selected model actually SHIP a small working web app?
// Sends a real product task, then verifies the artefacts on disk (not the prose).
// Usage: node build/probe-build-app.cjs [port] [model] [account] [transport] [baseURL]
const fs = require('fs');
const path = require('path');
const os = require('os');
const WebSocket = require('../node_modules/ws');

const port = Number(process.argv[2] || 9333);
const MODEL = process.argv[3] || 'claude-opus-4-5';
const ACCOUNT = process.argv[4] || '';
const TRANSPORT = process.argv[5] || 'openai';
const BASEURL = process.argv[6] || 'http://127.0.0.1:3001/v1';
const BASE = `http://127.0.0.1:${port}`;
const SESSIONS_ROOT = path.join(os.homedir(), 'Akron Bot');
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

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

const PROMPT = [
  'Build a small but real e-commerce storefront in the current working directory. Use tools, do not just describe it.',
  'Requirements:',
  '1. Create index.html, styles.css and app.js — a product grid (at least 4 products with price), an Add to cart button per product, a cart sidebar showing quantities and a running total, and a checkout button that shows an order-confirmation message.',
  '2. Persist the cart in localStorage so it survives a reload.',
  '3. Run a shell command to verify the three files exist (for example: ls -l index.html styles.css app.js).',
  '4. Open the page in the built-in browser with browser_open using a file:// URL to index.html, then browser_snapshot once to confirm it rendered.',
  '5. Finish with one line: APP=<n> files, CART=yes/no, BROWSE=<page title>.',
].join('\n');

// Newest session directory the app created for this run.
function newestSessionDir(since) {
  let best = null;
  let bestM = 0;
  try {
    for (const name of fs.readdirSync(SESSIONS_ROOT)) {
      const full = path.join(SESSIONS_ROOT, name);
      let st;
      try { st = fs.statSync(full); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      const m = st.mtimeMs;
      if (m >= since && m > bestM) { bestM = m; best = full; }
    }
  } catch (_) {}
  return best;
}

function readIf(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

const preserveProvider = require('./lib/preserve-provider.cjs');
let preserve = null;

(async () => {
  const startedAt = Date.now() - 5000;
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  preserve = preserveProvider(ev, cdp, {});
  await preserve.snapshot();

  // Same two shapes probe-capability uses: a bare OpenAI-compatible gateway, or
  // an in-app OAuth account (Claude/ChatGPT/Grok/Antigravity). Passing an
  // account used to be ignored, so every "build an app" run silently went to
  // the FreeLLMAPI gateway and failed on the Claude model name.
  const providerObj = ACCOUNT
    ? { baseURL: '', apiKey: '', model: MODEL, supportsTools: true,
        oauthProvider: ACCOUNT, transport: TRANSPORT, oauth: true,
        accessToken: '', temperature: 0.4, maxTokens: 8000, reasoningLevel: 'auto' }
    : { baseURL: BASEURL, apiKey: '', model: MODEL, supportsTools: true,
        temperature: 0.4, maxTokens: 8000, reasoningLevel: 'auto' };
  await ev(cdp, `localStorage.setItem('autobot:provider', ${JSON.stringify(JSON.stringify(providerObj))}); 'set'`);
  await cdp.send('Page.reload');
  await sleep(5500);

  await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) { b.click(); return 'new'; }
    return 'none';
  })()`);
  await sleep(2500);

  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.focus();
    return 'typed';
  })()`);
  await sleep(400);
  await ev(cdp, `(() => {
    document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true }));
    return 'sent';
  })()`);

  let snap = null;
  const toolNames = new Set();
  let dir = null;
  let idleTicks = 0;
  for (let i = 0; i < 300; i++) {
    await sleep(1000);
    snap = await ev(cdp, `(() => {
      const cards = [...document.querySelectorAll('.toolcard')];
      const names = cards.map(c => {
        const v = c.querySelector('.tool-name');
        const t = c.querySelector('.tool-args');
        return ((v && v.textContent) || '').trim() + ':' + ((t && t.textContent) || '').trim().slice(0, 70);
      });
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const err = document.querySelector('.errorbar');
      return {
        names,
        text: el ? (el.textContent || '').trim() : '',
        err: err ? (err.textContent || '').trim().slice(0, 400) : null,
        leak: err ? /<[a-z!\\/][^>]*>/i.test(err.textContent || '') : false,
        streaming: !!document.querySelector('.streaming, .thinking'),
      };
    })()`);
    for (const n of snap.names) toolNames.add(n);
    if (!dir) dir = newestSessionDir(startedAt);
    if (snap.err) break;
    if (dir && fs.existsSync(path.join(dir, 'index.html')) && fs.existsSync(path.join(dir, 'app.js'))) {
      // Files are on disk; wait for the model to finish the browser step.
      idleTicks = snap.streaming ? 0 : idleTicks + 1;
      if (!snap.streaming && /APP=|CART=/i.test(snap.text)) break;
    }
  }

  // Let a late write land, then judge the artefacts, not the prose.
  await sleep(1500);
  dir = dir || newestSessionDir(startedAt);
  const files = dir ? fs.readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
  const html = dir ? readIf(path.join(dir, 'index.html')) : null;
  const js = dir ? readIf(path.join(dir, 'app.js')) : null;
  const css = dir ? readIf(path.join(dir, 'styles.css')) : null;
  const lower = [...toolNames].join(' | ').toLowerCase();
  const text = (snap && snap.text) || '';

  // A grid may be authored in HTML or rendered from JS. Accept either: product
  // nodes in the markup, or a >=4-entry product list in the script that feeds a
  // grid container.
  const htmlProductNodes = (html && (html.match(/class="[^"]*(product|card|item)/gi) || []).length) || 0;
  const jsProductList = !!(js && /\bprice\b/i.test(js) && (js.match(/\bprice\s*[:=]/gi) || []).length >= 4);
  const gridTarget = !!((html && /id="[^"]*(grid|products|store)[^"]*"/i.test(html)) || (js && /(grid|products)\b/i.test(js)));
  const hasGrid = htmlProductNodes >= 1 || (jsProductList && gridTarget);
  const hasPrice = !!(html && /[$৳€£]|\bprice\b/i.test(html)) || jsProductList;
  // A cart can be named (addToCart/addItem), pushed to, or mutated in place
  // (`cart[id] = q`, the shape the last run actually produced). Only requiring
  // the named forms failed a working cart whose arithmetic lives in update().
  const cartMutation = /(addToCart|add_to_cart|addItem|removeFromCart|setQuantity|updateItem|updateCart)/i.test(js)
    || /cart[^\n;]{0,30}\.push\s*\(/i.test(js)
    || /cart\s*\[[^\]]+\]\s*(?:=|\+=|-=|\+\+|--)/i.test(js)
    || /localStorage\.setItem\([^)]*cart/i.test(js);
  const hasCartLogic = !!(js && /cart/i.test(js) && cartMutation);
  const hasTotal = !!(js && /(total|sum|reduce)/i.test(js));
  const hasLocalStorage = !!(js && /localStorage/i.test(js));
  const hasCss = !!(css && css.length > 200);
  const filesListed = /ls\b|ls -l|ls -la/.test(lower) || /ran \d+ commands?/.test(text.toLowerCase());

  const result = {
    model: MODEL,
    transport: TRANSPORT,
    dir: dir ? dir.replace(os.homedir(), '~') : null,
    files,
    toolCount: toolNames.size,
    toolsCalled: [...toolNames].slice(0, 30),
    checks: { html: !!html, css: hasCss, js: !!js, hasGrid, hasPrice, hasCartLogic, hasTotal, hasLocalStorage, filesListed },
    productCount: js ? (js.match(/\bprice\s*[:=]/gi) || []).length : 0,
    finalLine: (/APP=[^\n]*/i.exec(text) || [])[0] || null,
    browserTitle: (/BROWSE=([^\n]+)/i.exec(text) || [])[1] || null,
    markupLeak: !!(snap && snap.leak),
    error: snap && snap.err,
    tail: text.slice(-500),
  };
  // A passing build needs a real 3-file app with cart logic AND the model having
  // actually inspected it. Prose claiming success without files fails.
  result.pass = !!(
    result.checks.html && result.checks.css && result.checks.js &&
    result.checks.hasGrid && result.checks.hasCartLogic && result.checks.hasTotal &&
    result.checks.filesListed && !result.markupLeak && !result.error
  );
  console.log(JSON.stringify(result, null, 2));
  await preserve.restore();
  cdp.close();
  process.exit(result.pass ? 0 : 1);
})().catch(async (e) => {
  console.error('APP BUILD PROBE FAILED:', e.message);
  if (preserve) await preserve.restore();
  process.exit(1);
});
