// Capability probe for a plain OpenAI-compatible provider (no OAuth), e.g. the
// local FreeLLMAPI router on :3001. Proves the model writes a file, runs a
// shell command, and opens the built-in browser through the real app.
// Usage: node probe-local.cjs [port] [baseURL] [model]
const WebSocket = require('/Users/saimon/Documents/Default Project/autobot/node_modules/ws');
const port = Number(process.argv[2] || 9333);
const BASEURL = process.argv[3] || 'http://localhost:3001/v1';
const MODEL = process.argv[4] || 'auto';
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
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); }
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

const PROMPT = [
  'Prove your capabilities using tools, not prose. Do these steps in order:',
  '1. Use the Write tool to create a file named toolcap.txt in the current working directory containing exactly: TOOLCAP-OK',
  '2. Use the Bash tool to run: cat toolcap.txt',
  '3. Use browser_open to open https://example.com, then browser_snapshot and report the page title.',
  'Then answer with three lines: WRITE=<yes/no> RUN=<output> BROWSE=<title>.',
].join('\n');

(async () => {
  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  await ev(cdp, `localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL:${JSON.stringify(BASEURL)}, apiKey:'', model:${JSON.stringify(MODEL)}, supportsTools:true,
      oauth:false, temperature:0.4, maxTokens:4000, reasoningLevel:'auto' })); 'set'`);
  await cdp.send('Page.reload');
  await sleep(5000);

  await ev(cdp, `(() => {
    const b = [...document.querySelectorAll('button')].find(x => /new chat|new/i.test((x.getAttribute('aria-label')||'') + ' ' + (x.textContent||'')) && x.offsetParent);
    if (b) { b.click(); return 'new'; } return 'none';
  })()`);
  await sleep(2200);
  await ev(cdp, `(() => {
    const ta = document.querySelector('.composer textarea');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true })); ta.focus(); return 'typed';
  })()`);
  await sleep(400);
  await ev(cdp, `(() => { document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', bubbles:true, cancelable:true })); return 'sent'; })()`);

  let snap = null;
  const toolNames = new Set();
  for (let i = 0; i < 180; i++) {
    await sleep(1000);
    snap = await ev(cdp, `(() => {
      const cards = [...document.querySelectorAll('.toolcard')];
      const names = cards.map(c => {
        const v = c.querySelector('.tool-name'); const t = c.querySelector('.tool-args');
        return ((v && v.textContent) || '').trim() + ':' + ((t && t.textContent) || '').trim().slice(0, 60);
      });
      const msgs = [...document.querySelectorAll('.msg.assistant')];
      const el = msgs[msgs.length - 1];
      const err = document.querySelector('.errorbar');
      return {
        names,
        text: el ? (el.textContent || '').trim() : '',
        err: err ? (err.textContent || '').trim().slice(0, 300) : null,
        leak: err ? /<[a-z!\\/][^>]*>/i.test(err.textContent || '') : false,
        streaming: !!document.querySelector('.streaming, .thinking'),
      };
    })()`);
    for (const n of snap.names) toolNames.add(n);
    if (snap.err) break;
    if (!snap.streaming && /WRITE=/.test(snap.text)) break;
  }

  const joined = [...toolNames].join(' | ');
  const lower = joined.toLowerCase();
  const result = {
    baseURL: BASEURL, model: MODEL, toolsCalled: [...toolNames],
    wroteFile: /writ(e|ing):/.test(lower) && /toolcap\.txt/.test(lower),
    ranShell: /(run|bash|shell|command)/.test(lower) && /cat toolcap\.txt/.test(lower),
    usedBrowser: /(brows|navigat)/.test(lower) && /example\.com/.test(lower),
    answerHasOk: /TOOLCAP-OK/.test(snap ? snap.text : ''),
    browserTitle: (snap && /BROWSE=([^\n]+)/.exec(snap.text) || [])[1] || null,
    markupLeak: !!(snap && snap.leak),
    error: snap && snap.err,
    tail: snap ? snap.text.slice(-500) : null,
  };
  result.pass = !!(result.wroteFile && result.ranShell && result.answerHasOk && !result.markupLeak && !result.error);
  console.log(JSON.stringify({ pass: result.pass, ...result }, null, 2));
  cdp.close();
  process.exit(result.pass ? 0 : 1);
})().catch((e) => { console.error('LOCAL CAPABILITY PROBE FAILED:', e.message); process.exit(1); });
