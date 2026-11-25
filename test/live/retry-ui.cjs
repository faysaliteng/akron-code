// Live verification of the token-limit retry in the REAL UI.
// A turn that is cut off mid-sentence (finish_reason "length") must be replaced
// in the transcript by the regenerated answer — never stacked below the
// truncated attempt. Stub provider, so it costs no tokens.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8901;
const PARTIAL = 'Draft: this sentence was cut off by the token li';
const FULL = 'Final answer: the page is ready to open in the browser pane.';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeSse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

async function streamText(res, text, finish) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeSse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  const step = 10;
  for (let i = 0; i < text.length; i += step) {
    writeSse(res, { choices: [{ index: 0, delta: { content: text.slice(i, i + step) } }] });
    await sleep(90);
  }
  writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

let streams = 0;
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', async () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) {}
    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Okay.' } }] }));
      return;
    }
    streams += 1;
    // First attempt: cut off. Second: the model is asked again with a bigger
    // budget and finishes the sentence.
    if (streams === 1) return streamText(res, PARTIAL, 'length');
    return streamText(res, FULL, 'stop');
  });
});

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

(async () => {
  await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
  const list = JSON.parse(await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json/list', (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); }).on('error', reject);
  }));
  const page = list.find((t) => t.type === 'page' && /Akron Bot|index\.html/.test(t.title + t.url));
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.type + ':' + t.title)));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  await evaluate(ws, `(() => {
    localStorage.setItem('autobot:provider', JSON.stringify({
      baseURL: 'http://127.0.0.1:${PORT}/v1', apiKey: 'stub', model: 'stub-model', name: 'Stub',
      supportsTools: true, reasoningLevel: 'auto'
    }));
    localStorage.setItem('autobot:activeId', 'null');
    localStorage.setItem('autobot:convs', '[]');
    Object.keys(localStorage).filter((k) => k.startsWith('autobot:workspace:')).forEach((k) => localStorage.removeItem(k));
  })()`);
  await rpc(ws, 'Page.reload', {});
  await sleep(2500);

  const sent = await evaluate(ws, `(() => {
    const ta = document.querySelector('.composer textarea') || document.querySelector('textarea');
    if (!ta) return 'no-composer';
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'say something short');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('button.send:not(.stop)');
    if (!btn) return 'no-send-button';
    btn.click();
    return 'sent';
  })()`);
  console.log('composer:', sent);

  let workedFor = '';
  for (let i = 0; i < 200; i++) {
    await sleep(250);
    workedFor = await evaluate(ws, `((document.querySelector('.worked-for') || {}).innerText || '').trim()`);
    if (workedFor) break;
  }

  const final = JSON.parse(await evaluate(ws, `(() => {
    const lastMsg = Array.from(document.querySelectorAll('.msg.assistant')).pop();
    const blocks = lastMsg ? Array.from(lastMsg.querySelectorAll('.md, .toolcard, .thinkblock')).map((e) => (
      e.classList.contains('toolcard') ? 'tool:' + e.innerText.replace(/\\s+/g, ' ').trim()
        : e.classList.contains('thinkblock') ? 'think:' + e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 60)
          : 'text:' + e.innerText.replace(/\\s+/g, ' ').trim()
    )) : [];
    return JSON.stringify({ blocks, body: lastMsg ? lastMsg.innerText.replace(/\\s+/g, ' ').trim() : '' });
  })()`));

  const shot = (await rpc(ws, 'Page.captureScreenshot', { format: 'png' })).data;
  const shotPath = path.join(__dirname, '..', '..', 'screenshots', 'retry-ui.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));

  const report = { streams, composer: sent, workedFor, final, screenshot: shotPath };
  console.log(JSON.stringify(report, null, 2));
  ws.close();
  server.close();

  const textBlocks = final.blocks.filter((b) => b.startsWith('text:'));
  const pass = sent === 'sent'
    && streams >= 2
    && workedFor
    && textBlocks.length === 1
    && final.body.includes(FULL)
    && !final.body.includes(PARTIAL.slice(0, 30));
  console.log(pass ? '\nPASS: a cut-off turn is replaced, not stacked (one clean answer)' : '\nFAIL: see report');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
