// Live verification that a gateway error is absorbed, not printed at the user.
//
// A CDN pointed at a model provider answers 502/503/504 with an HTML page. Before
// the fix the run died and the transcript read:
//     LLM 502: <html><head><title>502 Bad Gateway</title></head><body>…nginx…
// Now the run backs off, says "provider error 502 — waiting Ns before retrying"
// in the thinking row, and finishes cleanly. Verified through the real IPC
// boundary (stub provider, so it costs no tokens).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = 8903;
const ANSWER = 'Back online — the gateway blip was retried and this answer is intact.';
const GATEWAY_HTML = '<html>\n<head><title>502 Bad Gateway</title></head>\n<body>\n<center><h1>502 Bad Gateway</h1></center>\n<hr><center>nginx</center>\n</body>\n</html>\n';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeSse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

async function streamText(res, text, finish) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  writeSse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
  for (let i = 0; i < text.length; i += 12) {
    writeSse(res, { choices: [{ index: 0, delta: { content: text.slice(i, i + 12) } }] });
    await sleep(70);
  }
  writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

let attempts = 0;
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
    attempts += 1;
    // First two calls: the "CDN" is down and hands back nginx's error page.
    if (attempts <= 2) {
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      res.end(GATEWAY_HTML);
      return;
    }
    return streamText(res, ANSWER, 'stop');
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
  for (let i = 0; i < 260; i++) {
    await sleep(250);
    workedFor = await evaluate(ws, `((document.querySelector('.worked-for') || {}).innerText || '').trim()`);
    if (workedFor) break;
  }

  const state = JSON.parse(await evaluate(ws, `(() => {
    const lastMsg = Array.from(document.querySelectorAll('.msg.assistant')).pop();
    const blocks = lastMsg ? Array.from(lastMsg.querySelectorAll('.md, .toolcard, .thinkblock')).map((e) => (
      e.classList.contains('toolcard') ? 'tool:' + e.innerText.replace(/\\s+/g, ' ').trim()
        : e.classList.contains('thinkblock') ? 'think:' + e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 90)
          : 'text:' + e.innerText.replace(/\\s+/g, ' ').trim()
    )) : [];
    const bar = document.querySelector('.errorbar');
    return JSON.stringify({
      blocks,
      body: lastMsg ? lastMsg.innerText.replace(/\\s+/g, ' ').trim() : '',
      errorBar: bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : '',
      whole: document.body.innerText.replace(/\\s+/g, ' ').trim(),
    });
  })()`));

  const shot = (await rpc(ws, 'Page.captureScreenshot', { format: 'png' })).data;
  const shotPath = path.join(__dirname, '..', '..', 'screenshots', 'gateway-502.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));

  const report = { attempts, composer: sent, workedFor, ...state, screenshot: shotPath };
  console.log(JSON.stringify(report, null, 2));
  ws.close();
  server.close();

  const retried = attempts >= 3;
  const saidWhy = state.blocks.some((b) => b.startsWith('think:') && /provider error 502/.test(b));
  const answered = state.body.includes(ANSWER);
  const noMarkup = !/<html|<head|<title|<body|nginx/i.test(state.whole);
  const noBanner = !state.errorBar;
  const pass = sent === 'sent' && retried && saidWhy && answered && noMarkup && noBanner && !!workedFor;
  console.log(pass
    ? '\nPASS: a 502 gateway page is retried, explained in the transcript, and never rendered raw'
    : '\nFAIL: see report');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
