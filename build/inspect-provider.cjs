// quick CDP inspect: dump renderer provider state + settings, optionally clear+reload
const WebSocket = require('../node_modules/ws');
const port = process.argv[2] || 9333;
const mode = process.argv[3] || 'dump';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0; const pending = new Map(); const logs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
    if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
  });
  await new Promise((r) => ws.on('open', r));
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  await send('Runtime.enable');
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) return 'EXC ' + r.exceptionDetails.text;
    return r.result.value;
  };
  if (mode === 'clear') {
    console.log(await ev(`(()=>{localStorage.removeItem('autobot:provider');localStorage.removeItem('autobot:providerKeys');return 'cleared'})()`));
    await send('Page.reload');
    await sleep(7000);
  }
  const st = await ev(`(async () => {
    const raw = (k) => { try { return localStorage.getItem(k); } catch(_) { return null; } };
    const s = await window.autobot.getSettings();
    return {
      lsProvider: raw('autobot:provider'),
      lsKeys: raw('autobot:providerKeys'),
      savedBase: (s.provider||{}).baseURL,
      savedKeyLen: String((s.provider||{}).apiKey||'').length,
      savedModel: (s.provider||{}).model,
      pill: (document.querySelector('.model-name')||{}).textContent || '',
    };
  })()`);
  console.log(JSON.stringify(st, null, 2));
  if (logs.length) console.log('LOGS:', logs.slice(-10));
  ws.close();
})().catch((e) => { console.error(e.message); process.exit(1); });
