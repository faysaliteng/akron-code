// Read-only probe of the currently running Helio Bot window.
// Prints the last assistant transcript shape, run status and browser pane URL
// so a long real-model run can be checked without spending another API run.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function rpc(ws, method, params) {
  return new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e9);
    const onMsg = (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.id !== id) return;
      ws.off('message', onMsg);
      if (m.error) return reject(new Error(JSON.stringify(m.error)));
      resolve(m.result);
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(ws, expression) {
  const r = await rpc(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  const res = r.result || {};
  if (res.subtype === 'error') throw new Error(res.description || 'eval error');
  return res.value !== undefined ? res.value : res.description;
}

const PROBE = `(() => {
  const txt = (s) => (document.querySelector(s)?.innerText || '').trim();
  const msgs = [...document.querySelectorAll('.msg.assistant')];
  const last = msgs[msgs.length - 1];
  const blocks = last ? [...last.querySelectorAll('.md, .toolcard, .thinkblock')].map((e) => (
    e.classList.contains('toolcard') ? 'tool' : e.classList.contains('thinkblock') ? 'think' : 'text'
  )) : [];
  return {
    assistantMsgs: msgs.length,
    blocks: blocks.length,
    blockOrder: blocks.join('>'),
    toolRows: [...document.querySelectorAll('.toolcard')].length,
    workedFor: txt('.worked-for'),
    activity: txt('.activity'),
    streaming: !!document.querySelector('.md.streaming, .cursor, .stream-caret'),
    cwd: txt('.cwdbar'),
    notice: txt('.notice'),
    error: txt('.error-banner, .run-error'),
    wv: [...document.querySelectorAll('webview')].map((w) => w.getAttribute('src') || w.src || ''),
    tail: last ? last.innerText.replace(/\\s+/g, ' ').trim().slice(-260) : '',
  };
})()`;

(async () => {
  const list = JSON.parse(await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json/list', (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); }).on('error', reject);
  }));
  const page = list.find((t) => t.type === 'page' && /Helio Bot|index\.html/.test(t.title + t.url));
  if (!page) throw new Error('no page target');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  await sleep(1500);
  const state = await evaluate(ws, PROBE);
  const urls = state.wv.filter(Boolean);
  const fileUrl = urls.find((u) => /^file:\/\//.test(u) && /\.html?$/i.test(u));
  const cwdGuess = (String(state.cwd || '').match(/\/Users\/[^\n]+/) || [])[0];
  let disk = null;
  if (fileUrl) {
    const abs = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
    disk = { source: 'file://', file: abs, exists: fs.existsSync(abs), bytes: fs.existsSync(abs) ? fs.statSync(abs).size : 0, dir: fs.existsSync(path.dirname(abs)) ? fs.readdirSync(path.dirname(abs)) : [] };
  } else if (cwdGuess && fs.existsSync(path.join(cwdGuess, 'index.html'))) {
    const f = path.join(cwdGuess, 'index.html');
    disk = { source: 'served', file: f, exists: true, bytes: fs.statSync(f).size, dir: fs.readdirSync(cwdGuess) };
  }
  const report = { ...state, urls, disk };
  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync(path.join(__dirname, '..', '..', 'screenshots', 'probe-state.png'), Buffer.from(shot.data, 'base64'));
  ws.close();
  console.log(JSON.stringify(report, null, 2));

  const okShape = /^think>?/.test(state.blockOrder) || /think/.test(state.blockOrder);
  const ok = state.blocks > 3 && state.toolRows > 2 && okShape
    && !/Paused after \d+ tool turns/.test(state.notice)
    && disk && disk.exists && disk.bytes > 400
    && cwdGuess && disk.file.includes(cwdGuess);
  console.log(ok ? '\nPASS: live window shows an ordered, alive transcript with the deliverable on disk' : '\nFAIL: see report');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('probe error:', e.message); process.exit(2); });
