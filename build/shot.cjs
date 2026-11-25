// Screenshot the current renderer (evidence capture).
// Usage: node build/shot.cjs [port] [outfile]
const WebSocket = require('../node_modules/ws');
const fs = require('fs');
const port = Number(process.argv[2] || 9333);
const out = process.argv[3] || 'shot.png';
(async () => {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find(t => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
  if (!page) throw new Error('no page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
  let id = 0; const pending = new Map();
  ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); } });
  await new Promise(r => ws.on('open', r));
  const send = (method, params) => new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
  const r = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log('wrote', out, fs.statSync(out).size, 'bytes');
  ws.close(); process.exit(0);
})().catch(e => { console.error('SHOT FAILED', e.message); process.exit(1); });
