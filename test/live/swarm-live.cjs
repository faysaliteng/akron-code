// Live verification that the swarm really is multi-model and concurrent.
//
// Three local OpenAI-compatible stubs stand in for three models at three tiers:
//   :8905  cheap-mini   tier small     (mechanical work)
//   :8906  mid-pro      tier heavy     (implementation)
//   :8907  frontier-1   tier critical  (supervisor + review)
//
// One chat message is sent through the real renderer → IPC → llm.js path. The
// outer agent calls the Swarm tool; the supervisor (frontier-1) plans three
// subtasks at three different tiers; the workers run on three DIFFERENT models
// at the SAME time; the supervisor merges. Everything is asserted from the
// stubs' own request logs plus the UI, so nothing here is taken on trust.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const STUBS = [
  { port: 8905, model: 'cheap-mini', tier: 'small' },
  { port: 8906, model: 'mid-pro', tier: 'heavy' },
  { port: 8907, model: 'frontier-1', tier: 'critical' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const writeSse = (res, obj) => res.write('data: ' + JSON.stringify(obj) + '\n\n');

// Every provider request is logged with a start/end pair so overlap is
// measurable rather than inferred.
const log = [];
let inFlight = 0;
let maxInFlight = 0;

function sse(res, chunk) { writeSse(res, { choices: [{ index: 0, delta: chunk }] }); }

async function streamText(res, text, finish, slowMs) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  sse(res, { role: 'assistant', content: '' });
  const step = 12;
  for (let i = 0; i < text.length; i += step) {
    sse(res, { content: text.slice(i, i + step) });
    if (slowMs) await sleep(slowMs);
  }
  sse(res, {});
  writeSse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish || 'stop' }] });
  res.write('data: [DONE]\n\n');
  res.end();
}

const PLAN = {
  subtasks: [
    { id: 'w1', title: 'write heading', tier: 'small', prompt: 'Write the page heading copy.', owns: ['index.html'] },
    { id: 'w2', title: 'write engine', tier: 'heavy', prompt: 'Implement the score engine.', owns: ['engine.js'] },
    { id: 'w3', title: 'threat model', tier: 'critical', prompt: 'Review the design for security issues.', owns: ['SECURITY.md'] },
  ],
  synthesis: 'link the files together',
};

function classify(prompt) {
  if (/SUPERVISOR \(lead\) of a multi-agent team\./.test(prompt) && /Reply with ONLY a JSON object/.test(prompt)) return 'plan';
  if (/SUBTASK RESULTS:/.test(prompt)) return 'merge';
  if (/You are one worker on a multi-agent team/.test(prompt)) return 'worker';
  return 'outer';
}

function startStub(stub) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) {}
      const msgs = body.messages || [];
      const prompt = msgs.map((m) => String(m.content || '')).join('\n');
      const kind = classify(prompt);
      const hasToolResult = msgs.some((m) => m.role === 'tool');
      const entry = { port: stub.port, model: stub.model, tier: stub.tier, kind, start: Date.now(), end: null, tools: (body.tools || []).length };
      log.push(entry);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const finish = () => { entry.end = Date.now(); inFlight -= 1; };

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }] }));
        return finish();
      }

      // 1. The outer agent decides to use the Swarm tool (only when the Swarm
      //    tool is actually offered and no tool result has come back yet).
      if (kind === 'outer' && !hasToolResult && entry.tools) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        writeSse(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_swarm', type: 'function', function: { name: 'Swarm', arguments: '' } }] } }] });
        writeSse(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ goal: 'build a two-part deliverable', maxTasks: 3 }) } }] } }] });
        res.write('data: [DONE]\n\n');
        return res.end(finish);
      }

      // 2. The supervisor plans.
      if (kind === 'plan') { await streamText(res, '```json\n' + JSON.stringify(PLAN) + '\n```', 'stop', 15); return finish(); }
      // 3. The supervisor merges.
      if (kind === 'merge') { await streamText(res, 'MERGED: all three agents reported in.', 'stop', 15); return finish(); }
      // 4. A worker — streamed slowly so genuine overlap is observable.
      if (kind === 'worker') { await streamText(res, `done on ${stub.model} :: ${(prompt.match(/YOUR SUBTASK[^\n]*/) || ['?'])[0]}`, 'stop', 45); return finish(); }
      // 5. Outer agent after the tool returned.
      await streamText(res, 'Swarm verified.', 'stop', 10);
      return finish();
    });
  });
  return new Promise((r) => server.listen(stub.port, '127.0.0.1', () => r(server)));
}

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
  const servers = [];
  for (const s of STUBS) servers.push(await startStub(s));

  const list = JSON.parse(await new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9333/json/list', (res) => { let s = ''; res.on('data', (d) => (s += d)); res.on('end', () => resolve(s)); }).on('error', reject);
  }));
  const page = list.find((t) => t.type === 'page' && /Helio Bot|index\.html/.test(t.title + t.url));
  if (!page) throw new Error('no page target: ' + JSON.stringify(list.map((t) => t.type + ':' + t.title)));
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });

  // One provider pool, three tiers. Active provider is the cheap one so the
  // OUTER turn and the 'small' worker share a model while the heavy and
  // critical work land elsewhere — exactly the routing rule under test.
  const providers = STUBS.map((s) => ({
    id: 'p' + s.port,
    name: s.model,
    baseURL: `http://127.0.0.1:${s.port}/v1`,
    apiKey: 'stub',
    model: s.model,
    supportsTools: true,
    reasoningLevel: 'auto',
    tier: s.tier,
  }));
  // The app reads the pool from the main process (~/.autobot/orchestrator.json),
  // not localStorage, so back the real config up and restore it afterwards.
  const orchFile = path.join(require('os').homedir(), '.autobot', 'orchestrator.json');
  const savedOrch = fs.existsSync(orchFile) ? fs.readFileSync(orchFile, 'utf8') : null;
  fs.mkdirSync(path.dirname(orchFile), { recursive: true });
  fs.writeFileSync(orchFile, JSON.stringify({ enabled: true, activeIndex: 0, providers }, null, 2));

  await evaluate(ws, `(() => {
    localStorage.setItem('autobot:provider', JSON.stringify(${JSON.stringify(providers[0])}));
    localStorage.setItem('autobot:activeId', 'null');
    localStorage.setItem('autobot:convs', '[]');
    Object.keys(localStorage).filter((k) => k.startsWith('autobot:workspace:')).forEach((k) => localStorage.removeItem(k));
  })()`);
  await rpc(ws, 'Page.reload', {});
  await sleep(2600);

  const sent = await evaluate(ws, `(() => {
    const ta = document.querySelector('.composer textarea') || document.querySelector('textarea');
    if (!ta) return 'no-composer';
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(ta, 'run the team: build a two-part deliverable');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const btn = document.querySelector('button.send:not(.stop)');
    if (!btn) return 'no-send-button';
    btn.click();
    return 'sent';
  })()`);
  console.log('composer:', sent);

  let workedFor = '';
  let workerTextLeaked = false;      // did a worker's tokens land in the parent reply?
  let maxRunningRows = 0;            // how many agents the UI showed as running at once
  let sawLiveCounters = false;       // did running rows show live progress counts?
  for (let i = 0; i < 400; i++) {
    await sleep(250);
    if (i % 2 === 0) {
      const probe = JSON.parse(await evaluate(ws, `(() => {
        const rows = Array.from(document.querySelectorAll('.subagent'));
        const running = rows.filter((e) => e.classList.contains('running'));
        const live = Array.from(document.querySelectorAll('.msg.assistant .body')).pop();
        return JSON.stringify({
          running: running.length,
          counters: running.some((e) => /\\d/.test((e.querySelector('.model') || {}).innerText || '')),
          body: live ? live.innerText : '',
        });
      })()`).catch(() => '{}'));
      maxRunningRows = Math.max(maxRunningRows, probe.running || 0);
      if (probe.counters) sawLiveCounters = true;
      // The workers stream `done on <model> :: …`; none of it may reach the parent.
      if (/done on (cheap-mini|mid-pro|frontier-1)|YOUR SUBTASK/.test(probe.body || '')) workerTextLeaked = true;
    }
    workedFor = await evaluate(ws, `((document.querySelector('.worked-for') || {}).innerText || '').trim()`);
    if (workedFor) break;
  }

  const state = JSON.parse(await evaluate(ws, `(() => {
    const lastMsg = Array.from(document.querySelectorAll('.msg.assistant')).pop();
    const rows = Array.from(document.querySelectorAll('.subagent')).map((e) => ({
      text: e.innerText.replace(/\\s+/g, ' ').trim(),
      tier: (e.querySelector('.tier') || {}).innerText || '',
      model: (e.querySelector('.model') || {}).innerText || '',
      sup: e.classList.contains('supervisor'),
      status: e.className.replace('subagent ', '').trim(),
    }));
    const bar = document.querySelector('.errorbar');
    return JSON.stringify({
      rows,
      body: lastMsg ? lastMsg.innerText.replace(/\\s+/g, ' ').trim() : '',
      errorBar: bar ? bar.innerText.replace(/\\s+/g, ' ').trim() : '',
    });
  })()`));

  const shot = (await rpc(ws, 'Page.captureScreenshot', { format: 'png' })).data;
  const shotPath = path.join(__dirname, '..', '..', 'screenshots', 'swarm-live.png');
  fs.mkdirSync(path.dirname(shotPath), { recursive: true });
  fs.writeFileSync(shotPath, Buffer.from(shot, 'base64'));

  const workers = log.filter((e) => e.kind === 'worker');
  const plan = log.filter((e) => e.kind === 'plan');
  const merge = log.filter((e) => e.kind === 'merge');
  // Real overlap: at least two worker requests whose start/end windows cross.
  let overlap = 0;
  for (let i = 0; i < workers.length; i++) {
    for (let j = i + 1; j < workers.length; j++) {
      const a = workers[i], b = workers[j];
      if (a.start < (b.end || Infinity) && b.start < (a.end || Infinity)) overlap++;
    }
  }

  const report = {
    composer: sent,
    workedFor,
    calls: log.map((e) => `${e.model}/${e.kind}/${e.end ? e.end - e.start + 'ms' : 'open'}`),
    maxInFlight,
    overlappingWorkerPairs: overlap,
    workerModels: workers.map((e) => e.model).sort(),
    planModel: plan.map((e) => e.model),
    mergeModel: merge.map((e) => e.model),
    maxRunningRows,
    sawLiveCounters,
    workerTextLeaked,
    rows: state.rows,
    body: state.body.slice(0, 400),
    errorBar: state.errorBar,
    screenshot: shotPath,
  };
  console.log(JSON.stringify(report, null, 2));

  ws.close();
  servers.forEach((s) => s.close());
  // Put the user's real provider pool back exactly as it was.
  if (savedOrch != null) fs.writeFileSync(orchFile, savedOrch);
  else { try { fs.unlinkSync(orchFile); } catch (_) {} }

  const checks = {
    'composer sent': sent === 'sent',
    'supervisor planned on the frontier model': plan.length === 1 && plan[0].model === 'frontier-1',
    'three workers ran': workers.length === 3,
    'workers spanned three models': new Set(workers.map((w) => w.model)).size === 3,
    'small tier → cheap model': workers.some((w) => w.model === 'cheap-mini'),
    'heavy tier → mid model': workers.some((w) => w.model === 'mid-pro'),
    'critical tier → frontier model': workers.some((w) => w.model === 'frontier-1'),
    'worker requests genuinely overlapped': overlap >= 1 && maxInFlight > 1,
    'supervisor merged': merge.length === 1 && merge[0].model === 'frontier-1',
    'merged answer reached the transcript': /MERGED|Swarm verified/.test(state.body),
    'no error bar': !state.errorBar,
    'parent reply stayed clean while workers streamed': workerTextLeaked === false,
    'UI showed more than one agent running at once': maxRunningRows > 1,
    'running rows showed live progress counters': sawLiveCounters === true,
    'UI showed the team with tiers': state.rows.filter((r) => r.tier).length >= 3,
    'UI showed per-agent models': state.rows.filter((r) => r.model).length >= 3,
  };
  const failed = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k);
  console.log('\n' + Object.entries(checks).map(([k, v]) => (v ? '  ok   ' : '  FAIL ') + k).join('\n'));
  console.log(failed.length ? '\nFAIL: ' + failed.join(', ') : '\nPASS: supervisor planned on the frontier model, three tiers ran CONCURRENTLY on three different models, and the result was merged');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
