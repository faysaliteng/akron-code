// Live end-to-end probe against a REAL model: type the request in the composer,
// press Send, then check the three things the user actually complained about:
//   1. the page is generated and EXISTS on disk in the conversation's folder,
//   2. the browser pane opens that very file,
//   3. the run looks alive while it works (spinner, elapsed time, tool rows).
//
// Usage:  node test/live/real-model.cjs [kimi|deepseek] ["prompt"]
// Assumes the dev app is running with --remote-debugging-port=9333.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const WHICH = (process.argv[2] || 'deepseek').toLowerCase();
const PROMPT = process.argv[3] || 'build me a live football score website';
const MODELS = {
  deepseek: { name: 'TokenRouter · DeepSeek V4.1 Flash', baseURL: 'https://api.tokenrouter.com/v1', model: 'deepseek/deepseek-v4.1-flash-1017' },
  kimi: { name: 'TokenRouter · Kimi K3.1 Pro', baseURL: 'https://api.tokenrouter.com/v1', model: 'moonshotai/kimi-k3.1-pro' },
};
const KEY = process.env.TOKENROUTER_API_KEY || process.env.FREELLM_API_KEY || '';
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
  const wv = [...document.querySelectorAll('webview')].map((w) => ({ url: w.getAttribute('src') || w.src || '', title: '' }));
  return {
    activity: txt('.activity'),
    toolRows: [...document.querySelectorAll('.toolcard')].map((t) => t.innerText.replace(/\\s+/g, ' ').trim()).slice(-6),
    workedFor: txt('.worked-for'),
    // .cwdbar holds the path AND a "Change" button label on its own line, so
    // take just the path (it may contain spaces) and stop at the newline.
    cwd: (txt('.cwdbar').match(/\\/Users\\/[^\\n]+/) || [''])[0].trim(),
    blocks: (() => {
      const last = [...document.querySelectorAll('.msg.assistant')].pop();
      return last ? [...last.querySelectorAll('.md, .toolcard, .thinkblock')].map((e) => (
        e.classList.contains('toolcard') ? 'tool:' : e.classList.contains('thinkblock') ? 'think:' : 'text:'
      ) + e.innerText.replace(/\\s+/g, ' ').trim().slice(0, 50)) : [];
    })(),
    wv,
    paneOpen: !!document.querySelector('.browser-pane, webview'),
    streaming: !!document.querySelector('.md.streaming, .cursor, .stream-caret'),
    texts: [...document.querySelectorAll('.msg.assistant .body, .message.assistant .body')].map((e) => e.innerText.slice(0, 200)).slice(-2),
    lastNotice: txt('.notice'),
    errorBanner: txt('.error-banner, .run-error'),
  };
})()`;

(async () => {
  const list = JSON.parse(await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json/list', (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); }).on('error', reject);
  }));
  const page = list.find((t) => t.type === 'page' && /Akron Bot|index\.html/.test(t.title + t.url));
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.type + ':' + t.title)));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  const cfg = MODELS[WHICH] || MODELS.deepseek;
  // `--probe-only` validates the in-page PROBE (selectors, cwd parsing) against
  // whatever the window currently shows — free, no model call, no localStorage
  // reset. Use it after editing the probe instead of paying for a real run.
  if (process.argv.includes('--probe-only')) {
    const snap = await evaluate(ws, PROBE);
    console.log(JSON.stringify({ probe: snap }, null, 2));
    ws.close();
    const cwdOk = typeof snap.cwd === 'string' && snap.cwd.startsWith('/Users/');
    console.log(cwdOk ? '\nPASS: probe selectors resolve on the live window' : '\nFAIL: probe could not read the cwd bar');
    process.exit(cwdOk ? 0 : 1);
  }
  await evaluate(ws, `(() => {
    localStorage.setItem('autobot:provider', JSON.stringify({
      name: ${JSON.stringify(cfg.name)},
      baseURL: ${JSON.stringify(cfg.baseURL)},
      model: ${JSON.stringify(cfg.model)},
      apiKey: ${JSON.stringify(KEY)},
      supportsTools: true, maxTokens: 32000, reasoningLevel: 'auto'
    }));
    localStorage.setItem('autobot:activeId', 'null');
    localStorage.setItem('autobot:convs', '[]');
    Object.keys(localStorage).filter((k) => k.startsWith('autobot:workspace:')).forEach((k) => localStorage.removeItem(k));
    return 'ok';
  })()`);
  await rpc(ws, 'Page.reload', {});
  await sleep(2500);

  const sent = await evaluate(ws, `(() => {
    const ta = document.querySelector('.composer textarea') || document.querySelector('textarea');
    if (!ta) return 'no-composer';
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(PROMPT)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = [...document.querySelectorAll('button')].find((b) => /send/i.test(b.getAttribute('aria-label') || b.title || b.innerText || ''));
    if (!btn) return 'no-send';
    btn.click();
    return 'sent';
  })()`);
  console.log('composer:', sent);

  const samples = [];
  let last = null;
  let idle = 0;
  // Real reasoning models with no step cap routinely work 8–10 minutes on a
  // website (measured 9m34s, 77 tool rows). Failing on wall clock would be
  // reporting the absence of a step limit as a bug, so the deadline is a
  // safety net and progress is judged by whether the run is still moving.
  const deadline = Date.now() + Number(process.env.HELIO_RUN_DEADLINE_MS || 1800000);
  let frozen = 0;
  let prevSig = '';
  let frozenAt = 0;
  while (Date.now() < deadline) {
    await sleep(2500);
    try { last = await evaluate(ws, PROBE); } catch (_) { continue; }
    if (last && last.activity) samples.push(last.activity);
    // A run whose transcript and tool rows stop changing for 5 minutes while it
    // still claims to be streaming is hung, not slow (a sub-agent gets 10 minutes).
    const sig = `${(last && last.blocks || []).length}|${(last && last.toolRows || []).length}|${String((last && last.activity) || '').replace(/[0-9]/g, '')}`;
    frozen = sig === prevSig ? frozen + 1 : 0;
    prevSig = sig;
    if (frozen >= 240) { frozenAt = Date.now(); break; }
    // Idle only counts once the run really stopped: Example clears the activity
    // line between tool calls, so one empty sample proves nothing.
    const finished = last && (last.workedFor || (last.blocks || []).length && !last.streaming && !last.activity);
    idle = finished ? idle + 1 : 0;
    const done = last && (last.workedFor || (idle >= 3 && (last.wv || []).some((w) => /\.html?$/i.test(w.url))));
    if (done) break;
  }

  const urls = ((last && last.wv) || []).map((w) => w.url).filter(Boolean);
  const fileUrl = urls.find((u) => /^file:\/\//.test(u) && /\.html?$/i.test(u));
  const cwdGuess = (String((last && last.cwd) || '').match(/\/Users\/[^\n]+/) || [])[0];
  const onDisk = cwdGuess && path.join(cwdGuess, 'index.html');
  let disk = null;
  if (fileUrl) {
    const abs = decodeURIComponent(fileUrl.replace(/^file:\/\//, ''));
    disk = { source: 'file:// preview', file: abs, exists: fs.existsSync(abs), bytes: fs.existsSync(abs) ? fs.statSync(abs).size : 0 };
    if (disk.exists) disk.dir = fs.readdirSync(path.dirname(abs));
  } else if (onDisk && fs.existsSync(onDisk)) {
    // The agent started its own dev server and pointed the pane at it — the
    // deliverable still has to exist in the conversation folder.
    disk = { source: 'served by the agent', file: onDisk, exists: true, bytes: fs.statSync(onDisk).size, dir: fs.readdirSync(cwdGuess) };
  }

  // How long did the assistant say it worked, and was the bar the real folder?
  const blocks = (last && last.blocks) || [];
  const shape = blocks.map((b) => b.split(':')[0]).join('>');
  const report = {
    model: cfg.model,
    prompt: PROMPT,
    liveSamples: samples.length,
    activitySeen: [...new Set(samples)].slice(0, 8),
    toolRows: (last && last.toolRows) || [],
    blocks,
    blockOrder: shape,
    workedFor: (last && last.workedFor) || '',
    cwdBar: (last && last.cwd) || '',
    paneOpen: !!(last && last.paneOpen),
    webview: urls,
    disk,
    texts: (last && last.texts) || [],
    lastNotice: (last && last.lastNotice) || '',
    errorBanner: (last && last.errorBanner) || '',
    hung: !!frozenAt,
    screenshot: path.join(__dirname, '..', '..', 'screenshots', 'real-model-' + WHICH + '.png'),
  };

  const shot = await rpc(ws, 'Page.captureScreenshot', { format: 'png' });
  if (shot && shot.data) fs.writeFileSync(report.screenshot, Buffer.from(shot.data, 'base64'));
  ws.close();
  console.log(JSON.stringify(report, null, 2));

  // Diagnose the gate instead of a bare "see report": a silent harness bug
  // (wrong selector, path with a trailing button label) looked like a product
  // failure and cost a full 6-minute model run to notice.
  const cwdDir = String(report.cwdBar || '').replace(/\/+$/, '');
  const gates = {
    paneOpen: report.paneOpen,
    'deliverable on disk': !!(disk && disk.exists && disk.bytes > 400),
    'cwd bar shows a folder': !!cwdDir,
    'deliverable is inside that folder': !!(cwdDir && disk && String(disk.file).startsWith(cwdDir + '/')),
    'live activity sampled': report.liveSamples > 0,
  };
  const ok = Object.values(gates).every(Boolean);
  // Example parity: the run must not have stopped on a step budget, and the
  // transcript must be ordered segments rather than one glued paragraph.
  if (/Paused after \d+ tool turns/.test(report.lastNotice)) {
    console.log('\nFAIL: the run hit the runaway safety valve and stopped early');
    process.exit(1);
  }
  if (report.hung) {
    console.log('\nFAIL: the run froze — transcript and tool rows stopped changing for 10 minutes');
    process.exit(1);
  }
  if (!blocks.some((b) => b.startsWith('tool:'))) {
    console.log('\nFAIL: transcript has no tool row — the reply was not segmented');
    process.exit(1);
  }
  if (!/^text:|[>]text[>]/.test(report.blockOrder) && !blocks.some((b) => b.startsWith('text:'))) {
    console.log('\nFAIL: transcript has no prose at all');
    process.exit(1);
  }
  console.log('\ngates: ' + JSON.stringify(gates));
  console.log(ok ? '\nPASS: real model run produced a live page in the conversation folder' : '\nFAIL: see report');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('harness error:', e.message); process.exit(2); });
