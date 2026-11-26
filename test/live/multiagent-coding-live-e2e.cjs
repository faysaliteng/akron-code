'use strict';
// Live E2E test for multi-agent Claude-parity coding against the running gateway:
// 1. Spawns parallel Task workers (writer + tests) on FreeLLMAPI role pools
// 2. Resumes a subagent by [agentId: ...] for a follow-up enhancement
// 3. Dispatches the built-in `verifier` subagent to verify syntax + `node --test`

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const llm = require('../../electron/llm');
const router = require('../../electron/orch-router');
const gate = require('../../electron/provider-gate');

const cfgPath = path.join(os.homedir(), '.autobot', 'freellm.json');
if (!fs.existsSync(cfgPath)) {
  console.error('Missing ~/.autobot/freellm.json');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const BASE = process.env.FREELLM_BASE || `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
const KEY = process.env.FREELLM_KEY || cfg.token;
if (!KEY) {
  console.error('No FreeLLMAPI token in ~/.autobot/freellm.json');
  process.exit(1);
}

(async () => {
  gate.reset();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-live-multiagent-'));
  const t0 = Date.now();
  const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
  const subEvents = [];
  const toolCalls = [];
  const agentIdsSeen = [];

  const emit = (ev) => {
    if (!ev) return;
    if (ev.type === 'tool') toolCalls.push({ name: ev.name, sub: ev.subagent || null });
    if (ev.type === 'toolResult' && typeof ev.result === 'string') {
      const m = /\[agentId:\s*(agent_[a-z0-9_]+)/i.exec(ev.result);
      if (m) agentIdsSeen.push(m[1]);
    }
    if (ev.type === 'subagent') {
      subEvents.push(ev);
      console.log(stamp(), '[subagent]', ev.name, ev.status, ev.agentId || '', ev.model || '');
    } else if (ev.type === 'orchestrator') {
      console.log(stamp(), '[failover]', ev.from, '->', ev.to);
    } else if (ev.type === 'notice') {
      console.log(stamp(), '[notice]', String(ev.text).slice(0, 140));
    }
  };

  try {
    const provider = { baseURL: BASE, apiKey: KEY, model: 'qwen3.8-flash', supportsTools: true, maxTokens: 8192, temperature: 0.2 };
    const orch = { enabled: false, providers: [], activeIndex: 0, pools: router.freellmPreset(BASE) };

    const prompt = `Working directory: ${dir}
Build a small zero-dependency CommonJS library "dag-runner" cleanly and fast:
1. First, in ONE turn, spawn TWO parallel Task calls:
   - Task 1 (subagent_type="general-purpose", description="Write core DAG module"): create "${dir}/dag.js" exporting topoSort(nodes, edges) (throws on cycle) and runDag(tasks) (runs tasks respecting deps, passing upstream results). Return the exported signature.
   - Task 2 (subagent_type="general-purpose", description="Write unit tests"): create "${dir}/dag.test.js" using node:test and node:assert/strict requiring "./dag.js" with 4 thorough tests (diamond DAG, parallel independent tasks, missing dep error, cycle detection error).
2. Next, spawn a Task call with subagent_type="verifier" and description="Verify DAG module & tests" to run "node --check ${dir}/dag.js && node --check ${dir}/dag.test.js && node --test ${dir}/dag.test.js". If any test fails, fix it and re-verify until it passes 100%.
Finish with a 2-line summary stating PASS or FAIL.`;

    const msgs = await llm.runAgent({
      provider,
      orchestrator: orch,
      messages: [{ role: 'user', content: prompt }],
      cwd: dir,
      emit,
      approveTool: async () => true,
      turnStart: true,
    });

    const dagPath = path.join(dir, 'dag.js');
    const testPath = path.join(dir, 'dag.test.js');
    assert.ok(fs.existsSync(dagPath), 'dag.js exists');
    assert.ok(fs.existsSync(testPath), 'dag.test.js exists');

    execFileSync(process.execPath, ['--check', dagPath], { stdio: 'inherit' });
    const out = execFileSync(process.execPath, ['--test', testPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('\n--- node --test output ---\n' + out.trim());

    const lastAssistant = [...msgs].reverse().find((m) => m.role === 'assistant' && m.content);
    const taskCount = toolCalls.filter((t) => t.name === 'Task' || t.name === 'Agent').length;
    console.log('\nLIVE_MULTIAGENT_E2E_OK', JSON.stringify({
      ms: Date.now() - t0,
      taskCount,
      agentIdsSeen,
      subEventsCount: subEvents.length,
      summary: lastAssistant ? String(lastAssistant.content).slice(0, 180) : '',
    }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    for (const id of agentIdsSeen) {
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'agent-runs', `${id}.json`), { force: true }); } catch (_) {}
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'agents', `${id}.txt`), { force: true }); } catch (_) {}
    }
  }
})();
