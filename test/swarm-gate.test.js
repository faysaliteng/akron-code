'use strict';
// Swarm is a user-opted escalation, not a model decision. These tests prove the
// gate is enforced where it matters: the tool surface actually sent to the
// provider. Multi-agent (Task/Agent) must stay available either way.
const assert = require('assert');
const llm = require('../electron/llm.js');
const { toolDefinitions, runTool } = require('../electron/tools.js');

let pass = 0;
const ok = async (label, fn) => {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') await r;
    console.log('  ok   ' + label);
    pass++;
  } catch (e) {
    console.log('  FAIL ' + label + ' — ' + e.message);
    process.exitCode = 1;
  }
};
const section = (t) => console.log('\n# ' + t);

// Capture the JSON body of every outbound chat completion, then answer with a
// plain final message so runAgent completes in exactly one step.
function captureRun(opts) {
  const bodies = [];
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      async text() { return ''; },
      async json() { return { choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }] }; },
    };
  };
  return llm.runAgent({
    messages: [{ role: 'user', content: 'hi' }],
    emit: () => {},
    ...opts,
  }).then(() => {
    global.fetch = realFetch;
    return bodies;
  }, (e) => {
    global.fetch = realFetch;
    throw e;
  });
}

const PROVIDER = {
  id: 'p',
  name: 'stub',
  baseURL: 'https://stub.example/v1',
  apiKey: 'k',
  model: 'stub-1',
  supportsTools: true,
  reasoningLevel: 'auto',
  maxTokens: 1024,
};

const toolNames = (body) => (body.tools || []).map((t) => t.function.name);

(async () => {
  section('swarm tool gating');

  const off = await captureRun({ provider: { ...PROVIDER }, swarm: false });
  await ok('swarm off => Swarm not advertised', () => {
    assert.strictEqual(off.length, 1);
    assert.ok(!toolNames(off[0]).includes('Swarm'), 'Swarm leaked into the tool list');
  });
  await ok('swarm off => Task/Agent still advertised', () => {
    const names = toolNames(off[0]);
    assert.ok(names.includes('Task'), 'Task missing');
    assert.ok(names.includes('Agent'), 'Agent missing');
  });
  await ok('swarm off => other built-ins untouched', () => {
    const names = toolNames(off[0]);
    for (const t of ['Read', 'Write', 'Edit', 'Bash']) assert.ok(names.includes(t), t + ' missing');
    assert.strictEqual(names.length, toolDefinitions.length - 1);
  });

  const on = await captureRun({ provider: { ...PROVIDER }, swarm: true });
  await ok('swarm on => Swarm advertised', () => {
    assert.strictEqual(on.length, 1);
    assert.ok(toolNames(on[0]).includes('Swarm'), 'Swarm missing');
    assert.strictEqual(toolNames(on[0]).length, toolDefinitions.length);
  });

  const undef = await captureRun({ provider: { ...PROVIDER } });
  await ok('swarm undefined => off by default', () => {
    assert.ok(!toolNames(undef[0]).includes('Swarm'));
  });

  // A toolAllow set must not be able to re-enable Swarm while the user has it
  // off: the opt-in gate is checked before the allowlist.
  const scoped = await captureRun({ provider: { ...PROVIDER }, swarm: false, toolAllow: new Set(['*']) });
  await ok('toolAllow * does not override the swarm gate', () => {
    assert.ok(!toolNames(scoped[0]).includes('Swarm'));
  });

  // Sub-agents inherit whatever the parent opted into: a child never turns the
  // gate on for itself.
  const child = await captureRun({ provider: { ...PROVIDER }, isSubagent: true });
  await ok('sub-agent default => Swarm not advertised', () => {
    assert.ok(!toolNames(child[0]).includes('Swarm'));
  });

  section('handler is still wired');
  await ok('Swarm handler reachable though never advertised', async () => {
    const names = toolDefinitions.map((t) => t.name);
    assert.ok(names.includes('Swarm'));
    // The executor is dispatched by name inside runTool (not via executors),
    // so call it with no agent runner: the guard message proves wiring.
    const out = await runTool('Swarm', { goal: 'x' }, {});
    assert.match(String(out), /Swarm unavailable/i);
  });

  console.log('\n' + (process.exitCode ? 'FAILED ' : 'PASSED ') + pass + '\n');
})();
