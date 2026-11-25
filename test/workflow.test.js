'use strict';
// Workflow DSL engine tests — drives electron/workflow.js with a stub agent so
// the vm sandbox, caching, concurrency cap, and null semantics are all proven
// without spending a single model token.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect the workflow store to a temp dir BEFORE requiring the engine, so no
// test run can write into the real ~/.autobot/workflows.
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-wf-'));
process.env.HELIO_WF_TEST_HOME = tmpHome;

const wf = require('../electron/workflow');

const FIX = path.join(__dirname, 'fixtures', 'workflows');
const fixture = (n) => path.join(FIX, n);

let pass = 0;
let fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \u2713 ' + name); }
  else { fail++; failures.push(name); console.log('  \u2717 ' + name + (extra ? '  -> ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`); }

function section(t) { console.log('\n' + t); }

// A stub runner that recognises prompts by substring and records every call.
function makeRunner(behaviour = {}) {
  const calls = [];
  const runner = async (o) => {
    calls.push(o);
    const p = String(o.prompt || '');
    if (Object.prototype.hasOwnProperty.call(behaviour, p)) return behaviour[p];
    if (/boom/.test(p)) throw new Error('stub failure for: ' + p);
    if (/List flaky tests/.test(p)) {
      return { flaky: [{ test: 'a.test.js', reason: 'timing' }, { test: 'b.test.js', reason: 'network' }] };
    }
    if (/Propose a fix/.test(p)) {
      return { patch: 'fix for ' + p.slice(-20), confidence: 0.8 };
    }
    if (/Find correctness bugs/.test(p)) return { findings: [{ title: 'off-by-one', file: 'x.js' }, { title: 'null deref', file: 'y.js' }] };
    if (/Find performance/.test(p)) return { findings: [{ title: 'n+1 query', file: 'z.js' }] };
    if (/Find security/.test(p)) return { findings: [] };
    if (/Adversarially verify: off-by-one/.test(p)) return { isReal: true };
    if (/Adversarially verify: null deref/.test(p)) return { isReal: false };
    if (/Adversarially verify: n\+1 query/.test(p)) return { isReal: true };
    if (/Find bugs in module A/.test(p)) {
      const round = calls.filter((c) => /Find bugs in module A/.test(c.prompt)).length;
      return { bugs: round === 1 ? [{ id: 'A1', desc: 'a1 desc' }, { id: 'A2', desc: 'a2 desc' }] : [{ id: 'A1', desc: 'a1 desc' }] };
    }
    if (/Find bugs in module B/.test(p)) return { bugs: [{ id: 'B1', desc: 'b1 desc' }] };
    if (/Refute: a2/.test(p)) return { bugs: [{ id: 'dup', desc: 'still real' }] }; // non-empty => refuted
    if (/Refute:/.test(p)) return { bugs: [] };
    return 'RESULT<' + p + '>';
  };
  return { runner, calls };
}

(async () => {
  section('meta parsing');
  {
    const good = fs.readFileSync(fixture('find-flaky-tests.js'), 'utf8');
    const m = wf.parseMeta(good);
    ok('fixture meta parses', m.ok, m.error);
    eq('meta.name', m.meta.name, 'find-flaky-tests');
    ok('meta.description present', typeof m.meta.description === 'string' && m.meta.description.length > 0);
    eq('phases normalized to objects', m.meta.phases.map((p) => p.title), ['Scan', 'Fix']);
    eq('phase model carried', m.meta.phases[1].model, 'haiku');
    eq('phaseTitles exposed', m.meta.phaseTitles, ['Scan', 'Fix']);

    // String phases are legal too.
    const strPhases = `export const meta = { name: 'x', description: 'y', phases: ['A','B'] }\nreturn 1`;
    const m2 = wf.parseMeta(strPhases);
    ok('string phases accepted', m2.ok, m2.error);
    eq('string phase -> object', m2.meta.phases.map((p) => p.title), ['A', 'B']);

    // One-liner literal.
    const one = `export const meta = { name: 'one', description: 'd', phases: [{title:'Only'}] }\nreturn 2`;
    ok('single-line meta literal parses', wf.parseMeta(one).ok);

    // Missing description must fail (Example requires it).
    const noDesc = `export const meta = { name: 'n', phases: ['A'] }\nreturn 3`;
    ok('missing description rejected', wf.parseMeta(noDesc).ok === false, JSON.stringify(wf.parseMeta(noDesc)));

    // Computed values are not allowed.
    const computed = `const N = 'x'\nexport const meta = { name: N, description: 'd', phases: ['A'] }\nreturn 4`;
    ok('computed meta rejected', wf.parseMeta(computed).ok === false, JSON.stringify(wf.parseMeta(computed)));

    // No meta at all.
    ok('missing meta rejected', wf.parseMeta('console.log(1)').ok === false);
  }

  section('normalizeScript');
  {
    eq('export const meta peeled', wf.normalizeScript(`export const meta = {a:1}`), `const meta = {a:1}`);
    eq('export default removed', wf.normalizeScript('export default 5'), '5');
    eq('export function peeled', wf.normalizeScript('export function f(){}'), 'function f(){}');
    eq('export async function peeled', wf.normalizeScript('export async function f(){}'), 'async function f(){}');
  }

  section('run: script errors are reported, never thrown');
  {
    const r = await wf.runWorkflow({ script: 'this is not javascript!!!', runAgent: async () => 'x' });
    ok('syntax error -> status error', r.status === 'error', JSON.stringify(r).slice(0, 200));
    ok('error message surfaced', typeof r.error === 'string' && r.error.length > 0);

    const r2 = await wf.runWorkflow({ script: '', runAgent: async () => 'x' });
    ok('empty script -> status error', r2.status === 'error');

    const r3 = await wf.runWorkflow({ script: `export const meta={name:'a',description:'b',phases:['A']}`, runAgent: null });
    ok('missing runAgent -> status error', r3.status === 'error');
  }

  section('run: find-flaky-tests (sequential + pipeline + args)');
  {
    const { runner, calls } = makeRunner();
    const r = await wf.runWorkflow({
      scriptPath: fixture('find-flaky-tests.js'),
      args: 'test suite alpha',
      cwd: tmpHome,
      runAgent: runner,
      emit: () => {},
    });
    ok('completed', r.status === 'completed', r.error);
    eq('two flaky tests scanned', r.result.flaky, ['a.test.js', 'b.test.js']);
    eq('two fixes produced', r.result.fixes.length, 2);
    eq('fix merged with original test name', r.result.fixes[0].test, 'a.test.js');
    ok('summary mentions counts', /2 flaky test\(s\), 2 fix\(es\)/.test(r.result.summary), r.result.summary);
    eq('agent calls = 1 scan + 2 fixes', r.agentCalls, 3);
    eq('cacheHits 0 on first run', r.cacheHits, 0);
    ok('script persisted', fs.existsSync(r.scriptPath));
    ok('transcript persisted', fs.existsSync(path.join(r.transcriptDir, 'transcript.jsonl')));
    ok('cache persisted', fs.existsSync(path.join(r.transcriptDir, 'cache.json')));
    const scanCall = calls.find((c) => /List flaky tests/.test(c.prompt));
    ok('args interpolated into the prompt', /test suite alpha/.test(scanCall.prompt), scanCall.prompt);
    ok('schema forwarded to runner', scanCall.schema && scanCall.schema.type === 'object');
    const fixCall = calls.find((c) => /Propose a fix/.test(c.prompt));
    eq('label forwarded', fixCall.label, 'fix:a.test.js');
    eq('phase forwarded from the pipeline opts', fixCall.phase, 'Fix');
  }

  section('run: resume replays cached agent() calls');
  {
    const { runner, calls } = makeRunner();
    const first = await wf.runWorkflow({
      scriptPath: fixture('find-flaky-tests.js'),
      args: 'test suite alpha',
      cwd: tmpHome,
      runAgent: runner,
    });
    const callsAfterFirst = calls.length;
    const second = await wf.runWorkflow({
      scriptPath: fixture('find-flaky-tests.js'),
      args: 'test suite alpha',
      cwd: tmpHome,
      runAgent: runner,
      resumeFromRunId: first.runId,
    });
    eq('resume keeps the same runId', second.runId, first.runId);
    eq('resume hit the cache for all 3 agents', second.cacheHits, 3);
    eq('resume made zero new model calls', calls.length, callsAfterFirst);
    eq('resume still returns the same result', second.result.flaky, first.result.flaky);

    // Changing args changes the SCAN prompt (cache miss) but the two fix prompts
    // are keyed on the stub's test names, which never changed -> still 2 hits.
    // (Correct engine behaviour: the cache is keyed on prompt/model/schema, so
    // only the call whose prompt actually changed re-runs.)
    const third = await wf.runWorkflow({
      scriptPath: fixture('find-flaky-tests.js'),
      args: 'a DIFFERENT suite',
      cwd: tmpHome,
      runAgent: runner,
      resumeFromRunId: first.runId,
    });
    eq('unchanged fix prompts still hit the cache', third.cacheHits, 2);
    ok('the changed scan prompt re-ran', calls.slice(callsAfterFirst).some((c) => /a DIFFERENT suite/.test(c.prompt)), 'new=' + JSON.stringify(calls.slice(callsAfterFirst).map((c) => c.prompt.slice(0, 40))));

    // A cached null must still count as a hit. An agent that is SKIPPED returns
    // null (not a throw) — that null is cached and must be replayed on resume.
    // (A thrown agent is an error, is NOT cached, and is retried on resume —
    //  only completed calls are cached, exactly like Example.)
    const nullCacheRun = await wf.runWorkflow({
      script: `export const meta={name:'n',description:'d',phases:['A']}\nreturn await parallel([()=>agent('skipme')])`,
      runAgent: makeRunner({ skipme: null }).runner,
    });
    const resumedNull = await wf.runWorkflow({
      script: `export const meta={name:'n',description:'d',phases:['A']}\nreturn await parallel([()=>agent('skipme')])`,
      runAgent: makeRunner({ skipme: null }).runner,
      resumeFromRunId: nullCacheRun.runId,
    });
    eq('cached null counts as a cache hit', resumedNull.cacheHits, 1);
    eq('cached null result preserved', resumedNull.result, [null]);
  }

  section('run: review-changes (pipeline + nested parallel + return object)');
  {
    const { runner, calls } = makeRunner();
    const r = await wf.runWorkflow({ scriptPath: fixture('review-changes.js'), runAgent: runner });
    ok('completed', r.status === 'completed', r.error);
    eq('dimensions recorded', r.result.reviewed, ['bugs', 'perf', 'security']);
    eq('only adversarial-verified findings survive', r.result.confirmed.map((f) => f.title), ['off-by-one', 'n+1 query']);
    ok('verify ran for every finding', calls.filter((c) => /Adversarially verify/.test(c.prompt)).length === 3);
    ok('phase pinned on verify calls', calls.filter((c) => /Adversarially verify/.test(c.prompt)).every((c) => c.phase === 'Verify'));
  }

  section('run: loop-until-dry (while loop + dedup + nested fan-out)');
  {
    const { runner, calls } = makeRunner();
    const r = await wf.runWorkflow({ scriptPath: fixture('loop-until-dry.js'), runAgent: runner });
    ok('completed', r.status === 'completed', r.error);
    // Round 1: A1,A2,B1 fresh. Round 2: only A1 (dedup) -> verify. Round 3: A1 again -> dry 1. Round 4: dry 2.
    eq('unique bugs seen', r.result.rounds, 3);
    ok('A2 was refuted', !r.result.confirmed.some((b) => b.id === 'A2'), JSON.stringify(r.result.confirmed.map((b) => b.id)));
    ok('A1 confirmed', r.result.confirmed.some((b) => b.id === 'A1'));
    ok('loop terminated (no runaway)', calls.length < 40, 'calls=' + calls.length);
  }

  section('run: null semantics (throw -> null)');
  {
    const { runner } = makeRunner();
    const r = await wf.runWorkflow({ scriptPath: fixture('throws.js'), runAgent: runner });
    ok('completed despite throwing agent', r.status === 'completed', r.error);
    eq('parallel keeps a slot for the failure', r.result.results.length, 3);
    eq('throwing thunk became null', r.result.results[1], null);
    eq('healthy thunks survived', [r.result.results[0], r.result.results[2]], ['RESULT<ok-1>', 'RESULT<ok-2>']);
    eq('pipeline dropped the failing item to null', r.result.piped, ['RESULT<stage:a>', null, 'RESULT<stage:c>']);
    eq('filter(Boolean) count', r.result.n, 2);
  }

  section('sandbox: no filesystem / process / network escape');
  {
    const probes = [
      ['require', `export const meta={name:'a',description:'b',phases:['A']}\nreturn typeof require`],
      ['process', `export const meta={name:'a',description:'b',phases:['A']}\nreturn typeof process`],
      ['fetch', `export const meta={name:'a',description:'b',phases:['A']}\nreturn typeof fetch`],
      ['setTimeout', `export const meta={name:'a',description:'b',phases:['A']}\nreturn typeof setTimeout`],
    ];
    for (const [name, src] of probes) {
      const r = await wf.runWorkflow({ script: src, runAgent: async () => 'x' });
      ok(`typeof ${name} inside vm is not a function/object`, r.status === 'completed' && r.result === 'undefined', JSON.stringify(r).slice(0, 160));
    }
    // Global object pollution from one run must not leak into the next.
    await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nJSON.__leak = 1; return 1`,
      runAgent: async () => 'x',
    });
    ok('JSON is not polluted across runs', JSON.__leak === undefined);

    // Determinism guards: entropy/wall-clock break resume, so the runtime throws.
    for (const [name, expr] of [
      ['Math.random', `Math.random()`],
      ['Date.now', `Date.now()`],
      ['new Date()', `new Date().getTime()`],
    ]) {
      const r = await wf.runWorkflow({
        script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn ${expr}`,
        runAgent: async () => 'x',
      });
      ok(`${name} is blocked in a workflow`, r.status === 'error' && /not available in a workflow/.test(r.error || ''), JSON.stringify(r).slice(0, 160));
    }
    // A dated value is still allowed (pass timestamps via args).
    const dated = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn new Date(0).getTime()`,
      runAgent: async () => 'x',
    });
    ok('new Date(0) is allowed', dated.status === 'completed' && dated.result === 0, JSON.stringify(dated).slice(0, 120));
  }

  section('budget: hard token ceiling');
  {
    // No target -> Infinity remaining, agents run.
    const free = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn { total: budget.total, rem: budget.remaining() }`,
      runAgent: async () => 'x',
    });
    eq('budget.total is null with no target', free.result.total, null);
    eq('budget.remaining() is Infinity with no target', free.result.rem, null); // JSON can't carry Infinity

    // A spent-out target makes the next agent() throw (a HARD ceiling).
    let spentCalls = 0;
    const spent = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn await agent('should-not-run')`,
      runAgent: async () => { spentCalls++; return 'nope'; },
      budget: { total: 100, spent: () => 100, remaining: () => 0 },
    });
    ok('exhausted budget throws', spent.status === 'error' && /budget exhausted/i.test(spent.error || ''), JSON.stringify(spent).slice(0, 200));
    eq('no agent ran once budget was spent', spentCalls, 0);

    // Under-target agents still run.
    let underCalls = 0;
    const under = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn await agent('ok')`,
      runAgent: async () => { underCalls++; return 'ran'; },
      budget: { total: 100, spent: () => 10, remaining: () => 90 },
    });
    ok('under-budget agent runs', under.status === 'completed' && under.result === 'ran', JSON.stringify(under).slice(0, 120));
    eq('agent was called once', underCalls, 1);
  }

  section('budget pool: directive + live default wiring');
  {
    const bp = require('../electron/budget');
    bp.reset();
    eq('pool starts with no target', bp.remaining(), Infinity);
    eq('directive "+250k" parses', bp.parseDirective('go big +250k'), 250000);
    eq('phone number is not a budget', bp.parseDirective('call +8801234567'), null);
    bp.applyDirective('go big +250k');
    eq('applyDirective sets the target', bp.view().total, 250000);
    bp.addOutput(1000);
    eq('addOutput counts output tokens', bp.spent(), 1000);
    eq('remaining tracks spend', bp.remaining(), 249000);
    bp.reset();

    // A workflow with NO explicit budget reads the live shared pool. Prove the
    // default wiring: an exhausted pool must block agent() even though the test
    // never passed a `budget` option.
    let defaultCalls = 0;
    bp.setTotal(50);
    bp.addOutput(50);
    const def = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn await agent('x')`,
      runAgent: async () => { defaultCalls++; return 'x'; },
    });
    ok('exhausted default pool blocks agent()', def.status === 'error' && /budget exhausted/i.test(def.error || ''), JSON.stringify(def).slice(0, 180));
    eq('default-pool agent never ran', defaultCalls, 0);
    bp.reset();
    eq('reset clears the target', bp.view().total, null);
  }

  section('nested workflow()');
  {
    // Child workflow shares the parent's budget/agent pool and returns its result.
    const childSrc = `export const meta={name:'child',description:'child wf',phases:['C']}\nreturn await agent('child-agent')`;
    const childPath = path.join(tmpHome, 'child.js');
    fs.writeFileSync(childPath, childSrc);
    const parent = await wf.runWorkflow({
      script: `export const meta={name:'parent',description:'parent wf',phases:['P']}\nconst r = await workflow({ scriptPath: ${JSON.stringify(childPath)} })\nreturn { r }`,
      runAgent: async () => 'child-done',
    });
    ok('nested workflow completed', parent.status === 'completed', parent.error);
    // agent() returns the runner's return value; child returns that verbatim.
    eq('parent received the child result', parent.result.r, 'child-done');

    // More than one level of nesting is rejected.
    const child2Path = path.join(tmpHome, 'child2.js');
    fs.writeFileSync(child2Path, `export const meta={name:'c2',description:'c2',phases:['C']}\nconst r = await workflow({ scriptPath: ${JSON.stringify(childPath)} })\nreturn r`);
    const deep = await wf.runWorkflow({
      script: `export const meta={name:'p',description:'p',phases:['P']}\nreturn await workflow({ scriptPath: ${JSON.stringify(child2Path)} })`,
      runAgent: async () => 'x',
    });
    ok('two-level nesting rejected', deep.status === 'error' && /more than one level/.test(deep.error || ''), JSON.stringify(deep).slice(0, 200));
  }

  section('runtime contract');
  {
    // log() and console.log() both narrate without breaking the run.
    const events = [];
    const r = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A','B']}\nphase('B')\nlog('hello')\nconsole.log('world', {k:1})\nreturn 'done'`,
      runAgent: async () => 'x',
      emit: (e) => events.push(e),
    });
    eq('return string becomes summary', r.summary, 'done');
    ok('workflow events emitted', events.filter((e) => e.type === 'workflow').length >= 3, String(events.length));
    ok('phase event emitted for B', events.some((e) => e.status === 'phase' && e.phase === 'B'));
    ok('log event carries the message', events.some((e) => e.status === 'log' && e.message === 'hello'));
    ok('console.log stringified the object', events.some((e) => e.status === 'log' && /world/.test(e.message)));

    // parallel() must reject a non-array and a list of non-functions.
    for (const bad of ['parallel(5)', 'parallel([1,2])', 'pipeline(5, ()=>{})', 'pipeline([1], 5)']) {
      const rr = await wf.runWorkflow({
        script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn await ${bad}`,
        runAgent: async () => 'x',
      });
      ok(`${bad} -> error, not a hang`, rr.status === 'error', JSON.stringify(rr).slice(0, 160));
    }

    // agent() without a prompt is an error.
    const noPrompt = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn await agent({})`,
      runAgent: async () => 'x',
    });
    ok('agent() without prompt errors', noPrompt.status === 'error');

    // phases[] is exposed to the script.
    const ph = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nreturn phases.join(',')`,
      runAgent: async () => 'x',
    });
    eq('phases exposed to the script', ph.result, 'Explore,Design,Review,Implement,Verify');
  }

  section('concurrency cap');
  {
    let peak = 0;
    let live = 0;
    const slow = async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((res) => setTimeout(res, 25));
      live--;
      return 'v';
    };
    const items = Array.from({ length: 24 }, (_, i) => i);
    const r = await wf.runWorkflow({
      script: `export const meta={name:'a',description:'b',phases:['A']}\nconst items=${JSON.stringify(items)}\nreturn (await parallel(items.map(i=>()=>agent('job '+i)))).length`,
      runAgent: slow,
    });
    ok('24 agents all completed', r.status === 'completed' && r.result === 24, JSON.stringify(r).slice(0, 160));
    const cores = (os.cpus() || []).length || 4;
    const cap = Math.max(1, Math.min(16, cores - 2));
    ok(`peak concurrency (${peak}) <= cap (${cap})`, peak <= cap, 'peak=' + peak);
    ok('concurrency was actually used', peak > 1 || cap === 1, 'peak=' + peak);
    eq('every agent recorded in output', r.output.length, 24);
  }

  section('named workflows');
  {
    const src = `export const meta={name:'saved-one',description:'a saved workflow',phases:['Go']}\nreturn 'named-ok'`;
    const saved = wf.saveNamedWorkflow('saved-one', src);
    ok('saveNamedWorkflow writes a file', saved.ok && fs.existsSync(saved.path), JSON.stringify(saved));
    const list = wf.listNamedWorkflows();
    const entry = list.find((w) => w.name === 'saved-one');
    ok('listNamedWorkflows sees it', Boolean(entry), JSON.stringify(list.map((w) => w.name)));
    eq('listed description from meta', entry && entry.description, 'a saved workflow');
    const r = await wf.runWorkflow({ name: 'saved-one', runAgent: async () => 'x' });
    eq('run by name', r.result, 'named-ok');
    ok('unknown name errors', (await wf.runWorkflow({ name: 'nope-not-here', runAgent: async () => 'x' })).status === 'error');
    ok('saveNamedWorkflow rejects an empty name', wf.saveNamedWorkflow('', src).ok === false);
  }

  section('scriptPath precedence');
  {
    const { runner } = makeRunner();
    const r = await wf.runWorkflow({
      script: `export const meta={name:'inline',description:'d',phases:['A']}\nreturn 'inline-won'`,
      scriptPath: fixture('throws.js'),
      runAgent: runner,
    });
    ok('scriptPath beat inline script', r.status === 'completed' && r.result && r.result.results, JSON.stringify(r).slice(0, 200));
    ok('missing scriptPath errors', (await wf.runWorkflow({ scriptPath: '/nope/none.js', runAgent: runner })).status === 'error');
  }

  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
})().catch((e) => {
  console.error('WORKFLOW TEST CRASHED:', e && e.stack || e);
  process.exit(2);
});
