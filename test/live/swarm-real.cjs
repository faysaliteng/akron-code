// Live swarm verification against REAL frontier models (TokenRouter).
//
// The stub harness (swarm-live.cjs) proves routing and concurrency
// deterministically. This one proves the same mechanism survives contact with a
// real supervisor model: a real model has to CHOOSE the Swarm tool, emit valid
// tool arguments, then the supervisor has to return a parseable JSON plan with
// per-subtask tiers, and the workers have to actually do the work on disk.
//
// Pool written to ~/.autobot/orchestrator.json (the real path the app reads):
//   deepseek/deepseek-v4.1-flash-1017   tier small    (cheap/mechanical)
//   moonshotai/kimi-k3.1-pro            tier critical (supervisor + review)
// The user's pool is restored byte-for-byte afterwards.
//
// Usage:  node test/live/swarm-real.cjs
// Assumes the dev app is running with --remote-debugging-port=9333.
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const KEY = process.env.TOKENROUTER_API_KEY || process.env.FREELLM_API_KEY || '';
const BASE = 'https://api.tokenrouter.com/v1';
const KIMI = { name: 'TokenRouter · Kimi K3.1 Pro', baseURL: BASE, model: 'moonshotai/kimi-k3.1-pro' };
const DEEPSEEK = { name: 'TokenRouter · DeepSeek V4.1 Flash', baseURL: BASE, model: 'deepseek/deepseek-v4.1-flash-1017' };

const GOAL = 'Use the Swarm tool to run a two-agent team on this job: create two tiny files in this project folder - alpha.txt containing exactly the word ALPHA and beta.txt containing exactly the word BETA. These are two independent parts, so give each part its own agent.';

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

const orchFile = path.join(os.homedir(), '.autobot', 'orchestrator.json');
let savedPool = null;   // restored on any exit path, including crashes

(async () => {
  const list = JSON.parse(await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json/list', (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); }).on('error', reject);
  }));
  const page = list.find((t) => t.type === 'page' && /Akron Bot|index\.html/.test(t.title + t.url));
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.type + ':' + t.title)));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
  await rpc(ws, 'Runtime.enable', {});
  const exceptions = [];
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
    }
  });

  const savedOrch = fs.existsSync(orchFile) ? fs.readFileSync(orchFile, 'utf8') : null;
  savedPool = savedOrch;
  fs.mkdirSync(path.dirname(orchFile), { recursive: true });
  fs.writeFileSync(orchFile, JSON.stringify({
    enabled: true,
    activeIndex: 1, // supervisor/outer agent = the strongest tier
    providers: [
      { ...DEEPSEEK, apiKey: KEY, supportsTools: true, maxTokens: 8192, reasoningLevel: 'auto', tier: 'small' },
      { ...KIMI, apiKey: KEY, supportsTools: true, maxTokens: 8192, reasoningLevel: 'auto', tier: 'critical' },
    ],
  }, null, 2));

  // Fresh conversation, outer model = Kimi.
  await evaluate(ws, `(() => {
    localStorage.setItem('autobot:provider', ${JSON.stringify(JSON.stringify({ ...KIMI, apiKey: KEY, supportsTools: true, maxTokens: 32000, reasoningLevel: 'auto' }))});
    localStorage.setItem('autobot:activeId', 'null');
    localStorage.setItem('autobot:convs', '[]');
    localStorage.setItem('autobot:swarmEnabled', 'true');
    Object.keys(localStorage).filter((k) => k.startsWith('autobot:workspace:')).forEach((k) => localStorage.removeItem(k));
    return 'ok';
  })()`);
  await rpc(ws, 'Page.reload', { ignoreCache: true });
  await sleep(3000);

  const sent = await evaluate(ws, `(() => {
    const ta = document.querySelector('.composer textarea') || document.querySelector('textarea');
    if (!ta) return 'no-composer';
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, ${JSON.stringify(GOAL)});
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('button.send:not(.stop)');
    if (!btn) return 'no-send-button';
    btn.click();
    return 'sent';
  })()`);
  console.log('composer:', sent);

  // Real reasoning models are slow; allow 20 minutes and never treat wall-clock
  // duration as a failure signal.
  let workedFor = '';
  let maxRunningRows = 0;
  let workerTextLeaked = false;
  for (let i = 0; i < 1200; i++) {
    await sleep(1000);
    if (i % 3 === 0) {
      const probe = JSON.parse(await evaluate(ws, `(() => {
        const rows = Array.from(document.querySelectorAll('.subagent'));
        const running = rows.filter((e) => e.classList.contains('running'));
        const live = Array.from(document.querySelectorAll('.msg.assistant .body')).pop();
        return JSON.stringify({ running: running.length, body: live ? live.innerText : '', rows: rows.length });
      })()`).catch(() => '{}'));
      maxRunningRows = Math.max(maxRunningRows, probe.running || 0);
      if (/done on (moonshotai|deepseek)\/|YOUR SUBTASK/.test(probe.body || '')) workerTextLeaked = true;
      if (i % 30 === 0) console.log(`  t+${i}s rows=${probe.rows} running=${probe.running}`);
    }
    workedFor = await evaluate(ws, `((document.querySelector('.worked-for') || {}).innerText || '').trim()`);
    if (workedFor) break;
  }

  const state = JSON.parse(await evaluate(ws, `(() => {
    const lastMsg = Array.from(document.querySelectorAll('.msg.assistant')).pop();
    const rows = Array.from(document.querySelectorAll('.subagent')).map((e) => ({
      text: e.innerText.replace(/\\s+/g, ' ').trim(),
      tier: ((e.innerText.match(/\\b(SMALL|HEAVY|CRITICAL)\\b/) || [])[1] || ''),
      model: ((e.querySelector('.model') || {}).innerText || '').trim(),
      sup: e.classList.contains('supervisor') || /supervisor/.test(e.className),
      status: (e.querySelector('.status') || {}).innerText || '',
    }));
    return JSON.stringify({
      rows,
      body: lastMsg ? (lastMsg.querySelector('.body') || lastMsg).innerText : '',
      allText: (lastMsg ? lastMsg.innerText : '').slice(0, 3000),
      errorBar: ((document.querySelector('.error-banner, .run-error') || {}).innerText || '').trim(),
      cwd: (((document.querySelector('.cwdbar') || {}).innerText || '').match(/\\/Users\\/[^\\n]+/) || [''])[0].trim(),
    });
  })()`));

  const shot = (await rpc(ws, 'Page.captureScreenshot', { format: 'png' })).data;
  const shotPath = path.join(__dirname, '..', '..', 'screenshots', 'swarm-real.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));

  const cwd = state.cwd || '';
  const files = cwd ? (fs.existsSync(cwd) ? fs.readdirSync(cwd) : []) : [];
  const alphaPath = path.join(cwd || '/nonexistent', 'alpha.txt');
  const betaPath = path.join(cwd || '/nonexistent', 'beta.txt');
  const alphaOk = fs.existsSync(alphaPath);
  const betaOk = fs.existsSync(betaPath);

  // Leave the composer at its defaults so other UI suites are not affected.
  await evaluate(ws, `localStorage.setItem('autobot:swarmEnabled','false')`).catch(() => {});
  ws.close();
  if (savedOrch != null) fs.writeFileSync(orchFile, savedOrch);
  else { try { fs.unlinkSync(orchFile); } catch (_) {} }

  const report = {
    composer: sent,
    workedFor,
    cwd,
    files,
    alpha: alphaOk ? fs.readFileSync(alphaPath, 'utf8').trim().slice(0, 40) : null,
    beta: betaOk ? fs.readFileSync(betaPath, 'utf8').trim().slice(0, 40) : null,
    maxRunningRows,
    workerTextLeaked,
    rows: state.rows,
    body: (state.body || '').slice(0, 500),
    errorBar: state.errorBar,
    exceptions,
    screenshot: shotPath,
  };
  console.log(JSON.stringify(report, null, 2));

  const modelsSeen = new Set(state.rows.map((r) => r.model).filter(Boolean));
  const tiersSeen = new Set(state.rows.map((r) => r.tier).filter(Boolean));
  const checks = {
    'composer sent': sent === 'sent',
    'renderer did not crash': exceptions.length === 0,
    'the run finished': !!workedFor,
    'a real supervisor planned (team rows exist)': state.rows.length >= 2,
    'per-agent models are real model ids': [...modelsSeen].every((m) => /kimi|deepseek|moonshot/i.test(m)),
    'tiers were assigned': tiersSeen.size >= 1,
    'worker streams stayed out of the parent reply': workerTextLeaked === false,
    'no error bar': !state.errorBar,
    'alpha.txt on disk in the project folder': alphaOk,
    'beta.txt on disk in the project folder': betaOk,
    'the merged answer reached the transcript': (state.body || '').length > 40,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('\n' + Object.entries(checks).map(([k, v]) => (v ? '  ok   ' : '  FAIL ') + k).join('\n'));
  console.log(failed.length ? '\nFAIL: ' + failed.join(', ') : '\nPASS: a real supervisor model planned a team, the workers ran on real models, and the files landed on disk');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  // Never leave the user without their pool.
  try {
    if (savedPool != null) fs.writeFileSync(orchFile, savedPool);
    else if (fs.existsSync(orchFile)) fs.unlinkSync(orchFile);
  } catch (_) {}
  console.error('FAIL', e);
  process.exit(1);
});
