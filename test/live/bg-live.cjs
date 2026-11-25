// Live proof that Example Code's background-work surface actually works through
// the real tool dispatcher (electron/tools.js -> electron/bg.js):
//
//   Bash { run_in_background:true } -> shell_* id, polled with TaskOutput, killed with KillShell
//   Agent{ run_in_background:true } -> agent_* id, polled with TaskOutput (block), stopped with TaskStop
//   Monitor (non-persistent)        -> runs to completion, output captured
//   Monitor (persistent)            -> mon_* id, stoppable with TaskStop
//   REPL                            -> persistent JS session (state survives calls, reset clears it)
//
// No model, no network: the stub sub-agent runner returns immediately so the
// assertions are about the plumbing, which is exactly what parity means here.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runTool } = require('../../electron/tools');
const bg = require('../../electron/bg');

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-bg-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(label, cond, detail) {
  if (cond) { pass += 1; console.log(`  PASS  ${label}`); }
  else { fail += 1; console.log(`  FAIL  ${label}${detail ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''}`); }
}
function textOf(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.content === 'string') return r.content;
  return JSON.stringify(r);
}

(async () => {
  console.log('CWD', CWD);

  // ── 1. background shell ─────────────────────────────────────────────────
  console.log('\n[1] Bash run_in_background');
  const shellRes = textOf(await runTool('Bash', {
    command: 'echo one; sleep 0.3; echo two; sleep 0.3; echo three',
    description: 'bg echo demo',
    run_in_background: true,
  }, { cwd: CWD }));
  const shellId = (shellRes.match(/shell_[a-z0-9]+/) || [])[0];
  ok('returns a shell_* id', Boolean(shellId), shellRes);
  ok('returns immediately (not the command output)', !/^one/m.test(shellRes), shellRes);
  const job = shellId && bg.getJob(shellId);
  ok('job registered as kind=shell', job && job.kind === 'shell', job && job.kind);

  const polled = textOf(await runTool('TaskOutput', { task_id: shellId, block: true, timeout: 20000 }, { cwd: CWD }));
  ok('TaskOutput block:true waits for completion', /completed/.test(polled), polled);
  ok('captured all three lines', /one/.test(polled) && /two/.test(polled) && /three/.test(polled), polled);

  // ── 2. KillShell ─────────────────────────────────────────────────────────
  console.log('\n[2] KillShell on a background shell');
  const longRes = textOf(await runTool('Bash', {
    command: 'echo started; sleep 120',
    description: 'long sleeper',
    run_in_background: true,
  }, { cwd: CWD }));
  const longId = (longRes.match(/shell_[a-z0-9]+/) || [])[0];
  ok('second shell started', Boolean(longId), longRes);
  await sleep(300);
  const killRes = textOf(await runTool('KillShell', { shell_id: longId }, { cwd: CWD }));
  ok('KillShell reports success', /Killed/.test(killRes), killRes);
  await sleep(300);
  const killed = bg.getJob(longId);
  ok('job status is stopped', killed && killed.status === 'stopped', killed && killed.status);

  // ── 3. Agent run_in_background ──────────────────────────────────────────
  console.log('\n[3] Agent run_in_background -> TaskOutput(block) -> TaskStop');
  let ranPrompt = null;
  const ctx = {
    cwd: CWD,
    runSubagent: async (args) => {
      ranPrompt = args.prompt;
      await sleep(400);
      return 'SUBAGENT FINAL ANSWER';
    },
  };
  const agentRes = textOf(await runTool('Agent', {
    description: 'bg sub-agent',
    prompt: 'do the thing',
    run_in_background: true,
  }, ctx));
  const agentId = (agentRes.match(/agent_[a-z0-9]+/) || [])[0];
  ok('returns an agent_* id', Boolean(agentId), agentRes);

  const agentOut = textOf(await runTool('TaskOutput', { task_id: agentId, block: true, timeout: 20000 }, ctx));
  ok('TaskOutput resolves the agent result', /SUBAGENT FINAL ANSWER/.test(agentOut), agentOut);
  ok('sub-agent actually received the prompt', ranPrompt === 'do the thing', ranPrompt);

  // stop path on a still-running agent
  const stopCtx = { cwd: CWD, runSubagent: async () => { await sleep(60000); return 'never'; } };
  const agent2 = textOf(await runTool('Agent', { description: 'stoppable', prompt: 'wait', run_in_background: true }, stopCtx));
  const agent2Id = (agent2.match(/agent_[a-z0-9]+/) || [])[0];
  await sleep(200);
  const stopRes = textOf(await runTool('TaskStop', { task_id: agent2Id }, stopCtx));
  ok('TaskStop stops a background agent', /stopped|Stopped/i.test(stopRes), stopRes);
  await sleep(200);
  const stoppedJob = bg.getJob(agent2Id);
  ok('agent job status is stopped', stoppedJob && stoppedJob.status === 'stopped', stoppedJob && stoppedJob.status);

  // ── 4. Monitor ──────────────────────────────────────────────────────────
  console.log('\n[4] Monitor (non-persistent) + Monitor (persistent)');
  const monOut = textOf(await runTool('Monitor', {
    description: 'watch two lines',
    command: 'echo alpha; sleep 0.2; echo beta',
    timeout_ms: 10000,
    persistent: false,
  }, { cwd: CWD }));
  ok('non-persistent monitor captures output', /alpha/.test(monOut) && /beta/.test(monOut), monOut);

  const monStart = textOf(await runTool('Monitor', {
    description: 'persistent tail',
    command: 'while true; do echo tick; sleep 0.5; done',
    timeout_ms: 60000,
    persistent: true,
  }, { cwd: CWD }));
  const monId = (monStart.match(/mon_[a-z0-9]+/) || [])[0];
  ok('persistent monitor returns a mon_* id', Boolean(monId), monStart);
  await sleep(700);
  const monJob = monId && bg.getJob(monId);
  ok('persistent monitor streams lines', monJob && /tick/.test(monJob.output), monJob && monJob.output);
  const monStop = textOf(await runTool('TaskStop', { task_id: monId }, { cwd: CWD }));
  ok('persistent monitor can be stopped', /stopped|Stopped/i.test(monStop), monStop);

  // ── 5. REPL persistence ─────────────────────────────────────────────────
  console.log('\n[5] REPL persistent session');
  const r1 = textOf(await runTool('REPL', { code: 'var counter = 5; counter * 2', description: 'seed', language: 'javascript', cwd: CWD }, { cwd: CWD }));
  ok('REPL evaluates and echoes', /10/.test(r1), r1);
  const r2 = textOf(await runTool('REPL', { code: 'counter + 1', cwd: CWD }, { cwd: CWD }));
  ok('REPL state survives across calls', /6/.test(r2), r2);
  const r3 = textOf(await runTool('REPL', { code: 'counter', cwd: CWD, reset: true }, { cwd: CWD }));
  ok('reset clears the session', /not defined|Error/.test(r3), r3);
  const r4 = textOf(await runTool('REPL', { code: 'await Promise.resolve(41).then(n => n + 1)', cwd: CWD }, { cwd: CWD }));
  ok('top-level await works', /42/.test(r4), r4);

  // ── summary ─────────────────────────────────────────────────────────────
  console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILURES'}  ${pass} passed, ${fail} failed`);
  try { bg.reset(); } catch (_) {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
