'use strict';
// Unit tests for the supervisor/swarm layer and the cowork fan-out.
// These run with NO network and NO model: runAgent is a fake that records the
// prompt it was given, so we can prove that (a) subtasks are DISTINCT prompts,
// (b) they run CONCURRENTLY, and (c) each one is routed to the model tier that
// matches its complexity.

const path = require('path');
const swarm = require(path.join(__dirname, '..', 'electron', 'swarm.js'));
const cowork = require(path.join(__dirname, '..', 'electron', 'cowork.js'));

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function section(t) { console.log('\n# ' + t); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- tiers
section('tier normalisation');
eq('small synonyms', ['small', 'cheap', 'fast', 'Mechanical', 'boilerplate'].map((v) => swarm.normalizeTier(v)), ['small', 'small', 'small', 'small', 'small']);
eq('heavy synonyms', ['heavy', 'frontier', 'frontier model', 'pro'].map((v) => swarm.normalizeTier(v)), ['heavy', 'heavy', 'heavy', 'heavy']);
eq('critical synonyms', ['critical', 'urgent', 'architecture review'].map((v) => swarm.normalizeTier(v)), ['critical', 'critical', 'critical']);
eq('empty falls back', swarm.normalizeTier(''), 'heavy');
eq('unknown falls back to given', swarm.normalizeTier('weird', 'small'), 'small');

// ---------------------------------------------------------------- roster
section('roster + routing');
const orch = {
  enabled: true,
  activeIndex: 1,
  providers: [
    // Swarm rosters are frontier-only, so the fixture pool opts in explicitly
    // while still exercising the tier routing rules (cheap → heavy → strongest).
    { id: 'a', name: 'cheap', baseURL: 'https://small.example/v1', apiKey: 'k1', model: 'tiny-1', tier: 'small', frontier: true },
    { id: 'b', name: 'mid', baseURL: 'https://mid.example/v1', apiKey: 'k2', model: 'mid-1', tier: 'heavy', frontier: true },
    { id: 'c', name: 'front', baseURL: 'https://front.example/v1', apiKey: 'k3', model: 'front-1', tier: 'critical', frontier: true },
  ],
};
const active = { baseURL: 'https://mid.example/v1', apiKey: 'k2', model: 'mid-1' };
const roster = swarm.buildRoster({ orchestrator: orch, provider: active });
eq('roster dedups the active provider', roster.length, 3);
eq('roster tiers', roster.map((r) => r.model + ':' + r.tier), ['tiny-1:small', 'mid-1:heavy', 'front-1:critical']);
eq('small routes to cheap', swarm.pickProvider(roster, 'small').model, 'tiny-1');
eq('heavy routes to mid', swarm.pickProvider(roster, 'heavy').model, 'mid-1');
eq('critical routes to frontier', swarm.pickProvider(roster, 'critical').model, 'front-1');
eq('unknown roster is null-safe', swarm.pickProvider([], 'heavy'), null);

const sparse = [ // no exact tier for 'small' => must fall to the cheapest available
  { model: 'mid-1', tier: 'heavy' },
  { model: 'front-1', tier: 'critical' },
];
eq('missing small tier falls to cheapest', swarm.pickProvider(sparse, 'small').model, 'mid-1');
eq('missing critical tier falls to strongest', swarm.pickProvider(sparse, 'critical').model, 'front-1');
eq('single provider gets every tier', swarm.buildRoster({ provider: active }).map((r) => r.model), ['mid-1']);

// Swarm must never spend money on cheap/local models: `frontierOnly` prunes them,
// while the automatic Task/Agent path (buildRoster without the flag) keeps them.
const mixedOrch = {
  enabled: true,
  activeIndex: 0,
  providers: [
    { id: 'cheap', baseURL: 'https://cheap.example/v1', apiKey: 'k', model: 'tiny-1', tier: 'small' },
    { id: 'kimi', baseURL: 'https://k.example/v1', apiKey: 'k', model: 'moonshotai/kimi-k3.1-pro', tier: 'critical' },
    { id: 'ds', baseURL: 'https://d.example/v1', apiKey: 'k', model: 'deepseek/deepseek-v4.1-flash-1017', tier: 'heavy' },
    { id: 'glm', baseURL: 'https://g.example/v1', apiKey: 'k', model: 'glm-4.6', tier: 'heavy' },
    { id: 'local', baseURL: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3:8b', tier: 'small' },
  ],
};
const fullRoster = swarm.buildRoster({ orchestrator: mixedOrch, provider: mixedOrch.providers[1] });
eq('unfiltered roster keeps every model', fullRoster.length, 5);
const frontierRoster = swarm.buildRoster({ orchestrator: mixedOrch, provider: mixedOrch.providers[1], frontierOnly: true });
eq('frontier roster drops cheap + local', frontierRoster.map((r) => r.model).sort().join(','), [
  'deepseek/deepseek-v4.1-flash-1017', 'glm-4.6', 'moonshotai/kimi-k3.1-pro',
].sort().join(','));
eq('frontier roster marks every entry frontier', frontierRoster.every((r) => r.frontier), true);
eq('frontier keeps a single unknown provider usable', swarm.buildRoster({
  orchestrator: { enabled: true, providers: [{ id: 'x', baseURL: 'https://x.example/v1', apiKey: 'k', model: 'mystery-9b', tier: 'heavy' }] },
  frontierOnly: true,
}).map((r) => r.model), ['mystery-9b']);

// ---------------------------------------------------------------- parsing
section('plan parsing');
const fenced = 'Sure! Here is the plan:\n```json\n{"subtasks":[{"id":"t1","title":"A","tier":"small","prompt":"do a"}],"synthesis":"merge"}\n```';
eq('extractJSON reads fenced json', swarm.extractJSON(fenced).subtasks[0].title, 'A');
eq('extractJSON survives braces in strings', swarm.extractJSON('x {"subtasks":[{"prompt":"use {curly} braces"}]}').subtasks[0].prompt, 'use {curly} braces');
eq('extractJSON returns null on prose', swarm.extractJSON('no json here'), null);

const plan = swarm.normalizePlan({ subtasks: [
  { title: 'one', prompt: 'p1', tier: 'cheap' },
  'two',
  { title: 'three', prompt: 'p3', complexity: 'critical' },
], synthesis: 'merge them' });
eq('normalizePlan tiers', plan.subtasks.map((t) => t.tier), ['small', 'heavy', 'critical']);
eq('normalizePlan ids', plan.subtasks.map((t) => t.id), ['t1', 't2', 't3']);
eq('normalizePlan keeps synthesis', plan.synthesis, 'merge them');
eq('normalizePlan caps at maxTasks', swarm.normalizePlan({ subtasks: Array.from({ length: 20 }, (_, i) => 'x' + i) }, { maxTasks: 3 }).subtasks.length, 3);
eq('normalizePlan rejects junk', swarm.normalizePlan({ nope: 1 }), null);

// ---------------------------------------------------------------- swarm
section('supervisor → workers → merge');
(async () => {
  // Fake agent runner. The supervisor's plan call and merge call return prose;
  // worker calls echo back what they were told, after a delay so overlap is
  // observable.
  let inFlight = 0;
  let maxInFlight = 0;
  const seen = [];
  const runAgent = async (opts) => {
    const prompt = String((opts.messages && opts.messages[0] && opts.messages[0].content) || '');
    const model = (opts.provider && opts.provider.model) || 'unknown';
    if (/SUPERVISOR \(lead\) of a multi-agent team\./.test(prompt) && /Reply with ONLY a JSON object/.test(prompt)) {
      return [{ role: 'assistant', content: JSON.stringify({
        subtasks: [
          { id: 'w1', title: 'write index', tier: 'small', prompt: 'create index.html', owns: ['index.html'] },
          { id: 'w2', title: 'write engine', tier: 'heavy', prompt: 'create engine.js', owns: ['engine.js'] },
          { id: 'w3', title: 'threat model', tier: 'critical', prompt: 'review security', owns: ['SECURITY.md'] },
        ],
        synthesis: 'link the files together',
      }) }];
    }
    if (/SUBTASK RESULTS:/.test(prompt)) {
      return [{ role: 'assistant', content: 'MERGED: ' + (prompt.match(/### /g) || []).length + ' results folded in' }];
    }
    seen.push({ model, prompt });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(40);
    inFlight--;
    return [{ role: 'assistant', content: 'done on ' + model + ' :: ' + prompt.slice(0, 40) }];
  };

  const events = [];
  const out = await swarm.swarm('build a game', {
    runAgent,
    emit: (e) => events.push(e),
    orchestrator: orch,
    provider: active,
    useMemory: false,
  });

  eq('supervisor is the frontier model', out.supervisor.model, 'front-1');
  eq('three workers ran', seen.length, 3);
  eq('worker prompts are DISTINCT', new Set(seen.map((s) => s.prompt)).size, 3);
  ok('workers run CONCURRENTLY', maxInFlight > 1, 'maxInFlight=' + maxInFlight);
  eq('small tier → cheap model', seen.find((s) => /index\.html/.test(s.prompt)).model, 'tiny-1');
  eq('heavy tier → mid model', seen.find((s) => /engine\.js/.test(s.prompt)).model, 'mid-1');
  eq('critical tier → frontier model', seen.find((s) => /review security/.test(s.prompt)).model, 'front-1');
  ok('result tiers preserved', out.results.map((r) => r.tier).join(',') === 'small,heavy,critical', out.results.map((r) => r.tier).join(','));
  ok('merge answer came from the supervisor', /^MERGED: 3 results/.test(out.answer), out.answer);

  // Events: per-agent rows must carry model + tier so the UI can show them.
  const w = events.filter((e) => e.type === 'subagent' && e.role === 'worker' && e.status === 'running');
  eq('worker rows emitted with model+tier', w.map((e) => e.tier).sort().join(','), 'critical,heavy,small');
  ok('worker rows carry a model id', w.every((e) => !!e.model), JSON.stringify(w.map((e) => e.model)));

  // ------------------------------------------------------------ fallback
  section('degraded paths');
  let fbCalls = 0;
  const planless = await swarm.swarm('just do it', {
    runAgent: async () => { fbCalls++; return [{ role: 'assistant', content: 'I would rather chat than plan.' }]; },
    provider: active,
    critique: false,
  });
  ok('unparsable plan falls back to one task', planless.planSource === 'fallback', planless.planSource);
  eq('fallback runs the goal once', planless.results.length, 1);
  eq('fallback still answers', /rather chat than plan/.test(planless.answer), true);

  let threw = null;
  try { await swarm.swarm('x', { runAgent: 'nope' }); } catch (e) { threw = e.message; }
  ok('swarm without a runner throws a clear error', /runAgent/.test(threw || ''), threw);

  // ------------------------------------------------------------ cowork
  section('cowork fan-out');
  const cw = [];
  const cwRun = async (o) => {
    cw.push({ model: o.provider && o.provider.model, prompt: String(o.messages[o.messages.length - 1].content) });
    await sleep(20);
    return [{ role: 'assistant', content: 'ok ' + (o.provider && o.provider.model) }];
  };

  const res = await cowork.orchestrate('build a landing page', [], {
    runAgent: cwRun,
    provider: active,
    orchestrator: orch,
    tasks: [
      { title: 'copy', prompt: 'write the marketing copy', tier: 'small' },
      { title: 'code', prompt: 'build the page shell', tier: 'heavy' },
      { title: 'audit', prompt: 'audit the page for XSS', tier: 'critical' },
    ],
    concurrency: 3,
  });
  eq('cowork ran every distinct task', res.length, 3);
  eq('cowork prompts are distinct', new Set(cw.map((c) => c.prompt)).size, 3);
  eq('cowork routed tiers to models', cw.map((c) => c.model).sort().join(','), 'front-1,mid-1,tiny-1');
  ok('cowork keeps the team goal as context', cw.every((c) => /TEAM GOAL/.test(c.prompt)), 'missing TEAM GOAL');

  const legacy = await cowork.orchestrate('shared goal', ['solo'], {
    runAgent: cwRun,
    provider: active,
  });
  eq('legacy same-goal mode still works', legacy.length, 1);
  ok('legacy mode sends the goal itself', /shared goal/.test(cw[cw.length - 1].prompt));

  console.log('\n' + (failed ? 'FAILED ' + failed + ' / ' + (passed + failed) : 'PASSED ' + passed));
  if (failed) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
})().catch((e) => { console.error('harness crash:', e); process.exit(1); });
