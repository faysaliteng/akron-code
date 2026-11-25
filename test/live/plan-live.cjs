// Live proof that plan mode is a real phase machine inside the agent loop
// (electron/llm.js), not just a permission-prompt switch.
//
// A local OpenAI-compatible stub plays the model. The run starts in plan mode.
// We assert on the tool results, the filesystem, and the events:
//
//   * a Write to source is REFUSED and the refusal directs the model at PLAN.md
//   * a Write to PLAN.md is allowed and the file lands on disk
//   * a prose-only finish is nudged back onto ExitPlanMode (turn does not end)
//   * ExitPlanMode approval flips plan mode off (planMode event, mode='auto')
//   * the <plan-mode> system block is removed after approval
//   * the same Write to source now succeeds on disk
//
// Run: node test/live/plan-live.cjs
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgent } = require('../../electron/llm');

const PORT = 8911;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

let turn = 0;
const seen = [];

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) {}
      const msgs = body.messages || [];
      seen.push(msgs.map((m) => ({ role: m.role, content: String(m.content || '') })));
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      sse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });

      const send = (obj, finish) => {
        sse(res, { choices: [{ index: 0, delta: obj }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish || 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const toolCall = (name, args) => send({
        tool_calls: [{ index: 0, id: 'call_' + name.toLowerCase() + '_' + turn, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      }, 'tool_calls');

      if (turn === 1) return toolCall('Write', { path: 'src/app.js', content: 'console.log("v1")' });
      if (turn === 2) return toolCall('Write', { path: 'PLAN.md', content: '# Plan\n1. write app.js\n2. verify' });
      // Turn 3: prose only — the loop must NOT accept this as the end of the
      // turn; it nudges the model back onto ExitPlanMode.
      if (turn === 3) return send({ content: 'Shall I proceed with the plan?' });
      if (turn === 4) return toolCall('ExitPlanMode', { plan: '# Plan\n1. write app.js\n2. verify' });
      if (turn === 5) return toolCall('Write', { path: 'src/app.js', content: 'console.log("v2")' });
      return send({ content: 'Implemented and verified.' });
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

let passed = 0;
let failed = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

(async () => {
  const server = await startStub();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-planlive-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  const events = [];
  const modes = [];
  let approveCalls = 0;

  const messages = await runAgent({
    messages: [
      { role: 'system', content: 'You are Helio Bot.' },
      { role: 'user', content: 'Add a hello-world to src/app.js.' },
    ],
    provider: {
      baseURL: `http://127.0.0.1:${PORT}`,
      apiKey: 'stub',
      model: 'stub-model',
      temperature: 0,
      maxTokens: 4096,
      supportsTools: true,
    },
    cwd: root,
    emit: (ev) => {
      events.push(ev);
      if (ev.type === 'permissionMode') modes.push(ev.mode);
    },
    maxSteps: 12,
    permissionMode: 'plan',
    planFile: 'PLAN.md',
    exitPlanMode: async () => { approveCalls++; return 'User approved. You may now implement the plan.'; },
  }).catch((e) => {
    console.error('runAgent threw:', e && e.message);
    return null;
  });

  console.log('\n# plan-mode gate');
  const blockedWrite = events.find((e) => e.type === 'toolResult' && e.name === 'Write' && e.isError === true);
  ok('source Write was refused in plan mode', Boolean(blockedWrite), JSON.stringify(events.filter((e) => e.type === 'toolResult').map((e) => e.name)));
  ok('refusal names PLAN.md', /PLAN\.md/.test(String(blockedWrite && blockedWrite.result)), String(blockedWrite && blockedWrite.result).slice(0, 200));
  ok('refusal directs to ExitPlanMode', /ExitPlanMode/.test(String(blockedWrite && blockedWrite.result)));
  ok('refusal is NOT a raw hook denial', !/Blocked by hook/.test(String(blockedWrite && blockedWrite.result)));

  console.log('\n# the plan file is writable');
  ok('PLAN.md was written', fs.existsSync(path.join(root, 'PLAN.md')));
  ok('PLAN.md has the plan', fs.existsSync(path.join(root, 'PLAN.md')) && /# Plan/.test(fs.readFileSync(path.join(root, 'PLAN.md'), 'utf8')));

  console.log('\n# prose finish is nudged onto ExitPlanMode');
  ok('prose finish did not end the turn (turn 4 was requested)', turn >= 5, 'turn=' + turn);
  ok('the model was told the turn must end with ExitPlanMode',
    seen.some((ms) => ms.some((m) => m.role === 'user' && /\[plan-mode\]/.test(m.content))));

  console.log('\n# ExitPlanMode approval');
  ok('ExitPlanMode called through the wrapper', approveCalls === 1, 'calls=' + approveCalls);
  ok('planMode went active then inactive',
    events.some((e) => e.type === 'planMode' && e.active === true)
      && events.some((e) => e.type === 'planMode' && e.active === false));
  ok('permission mode flipped to auto', modes.includes('auto'), JSON.stringify(modes));
  ok('approval notice emitted', events.some((e) => e.type === 'notice' && /Plan approved/i.test(e.text || '')));

  console.log('\n# plan block on the system prompt');
  const firstSystem = seen[0] && seen[0][0] && seen[0][0].role === 'system' ? seen[0][0].content : '';
  ok('<plan-mode> block present at start', /<plan-mode>/.test(firstSystem));
  const lastSystem = seen[seen.length - 1] && seen[seen.length - 1][0] && seen[seen.length - 1][0].role === 'system' ? seen[seen.length - 1][0].content : '';
  ok('<plan-mode> block removed after approval', !/<plan-mode>/.test(lastSystem), lastSystem.slice(-120));

  console.log('\n# implementation after approval');
  const appJs = path.join(root, 'src', 'app.js');
  ok('src/app.js written after approval', fs.existsSync(appJs));
  ok('the pre-approval write never landed (v1 absent)',
    !fs.existsSync(appJs) || !/v1/.test(fs.readFileSync(appJs, 'utf8')),
    fs.existsSync(appJs) ? fs.readFileSync(appJs, 'utf8') : '(missing)');
  ok('src/app.js has the new content', fs.existsSync(appJs) && /v2/.test(fs.readFileSync(appJs, 'utf8')));
  const flat = (messages || []).map((m) => String(m.content || '')).join('\n');
  ok('the run produced a final answer', /Implemented and verified\./.test(flat));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed) console.log('\nFailures:\n' + fails.map((f) => ' - ' + f).join('\n'));

  server.close();
  await sleep(50);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(1);
});
