'use strict';
// Akron Bot — Workflow DSL (Claude Code `Workflow` parity).
//
// Claude Code's Workflow tool takes a self-contained JavaScript script that
// MUST begin with
//
//     export const meta = { name, description, phases }   // pure literal
//
// and then a body written against four globals:
//
//     agent(promptOrOpts, maybeOpts?) -> result
//     parallel([ () => agent(...), () => agent(...) ]) -> [results]
//     pipeline(items, fn, fn, ...) -> [results]     // each stage is a function
//     phase(name)                                   // progress marker
//
// Because the script is a real program, a workflow can express arbitrary
// control flow — fan-out, barriers, loops, conditional branches — instead of
// being limited to a fixed schema. That is the whole point of the tool.
//
// We evaluate the script in a `vm` context with exactly those globals and no
// filesystem/process access, so a workflow cannot break out of the sandbox.
// Every invocation persists its script + a per-call result cache; resuming a
// run (`resumeFromRunId`) replays cached `agent()` results whose (prompt, opts)
// are unchanged, so a failed tail does not re-spend the whole budget.
//
//   ~/.autobot/workflows/<runId>/script.js
//   ~/.autobot/workflows/<runId>/cache.json
//   ~/.autobot/workflows/<runId>/transcript.jsonl

const fs = require('fs');
const path = require('path');
const os = require('os');
const vm = require('vm');
const crypto = require('crypto');
const budgetPool = require('./budget');

// Test isolation: HELIO_WF_TEST_HOME redirects the whole workflow store so tests
// never touch the real ~/.autobot/workflows.
const ROOT = path.join(process.env.HELIO_WF_TEST_HOME || os.homedir(), '.autobot', 'workflows');
const PHASES = ['Explore', 'Design', 'Review', 'Implement', 'Verify'];

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function writeJSON(file, v) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(v, null, 2)); }
function readJSON(file, fb) { try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {} return fb; }

function newRunId() {
  return 'wf_' + Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
}

function hashCall(c) {
  return crypto.createHash('sha1').update(JSON.stringify(c)).digest('hex').slice(0, 16);
}

// A workflow script uses ESM `export const meta`. vm only runs scripts, so peel
// the export keyword off — nothing else about the script changes.
function normalizeScript(src) {
  let s = String(src || '');
  s = s.replace(/\bexport\s+const\s+meta\s*=/, 'const meta =');
  s = s.replace(/\bexport\s+default\s+/g, '');
  s = s.replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/g, '');
  return s;
}

// Validate the required meta literal before spending any model tokens.
function parseMeta(src) {
  const norm = normalizeScript(src);
  // Find `const meta = {` then scan to the matching brace so single-line and
  // multi-line literals both work (Example's examples are multi-line, but a
  // one-liner is the same thing).
  const startM = /const\s+meta\s*=\s*\{/.exec(norm);
  if (!startM) return { ok: false, error: 'Workflow script must begin with `export const meta = { name, description, phases }` (pure literal, no computed values) followed by the script body using agent()/parallel()/pipeline()/phase().' };
  const open = norm.indexOf('{', startM.index);
  let depth = 0;
  let i = open;
  let inStr = null;
  for (; i < norm.length; i++) {
    const c = norm[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  if (depth !== 0) return { ok: false, error: 'meta literal is not closed — check the braces.' };
  const literal = norm.slice(open, i);
  let meta;
  try {
    // The literal may not reference anything, so a bare eval of it is safe here
    // and much more forgiving than a hand-rolled parser.
    // eslint-disable-next-line no-new-func
    meta = new Function('return (' + literal + ');')();
  } catch (e) {
    return { ok: false, error: 'meta must be a pure literal: ' + e.message };
  }
  if (!meta || typeof meta !== 'object') return { ok: false, error: 'meta must be an object' };
  if (!meta.name) return { ok: false, error: 'meta.name is required' };
  // Example's contract: `name` and `description` are required; `whenToUse` and
  // `phases` are optional. A phase entry is either a plain string or
  // { title, detail, model }. Normalize both shapes so the rest of the engine
  // never has to care which the author wrote.
  if (!meta.description) return { ok: false, error: 'meta.description is required' };
  const phases = Array.isArray(meta.phases) ? meta.phases : [];
  meta.phases = phases.map((p) => (typeof p === 'string' ? { title: p } : { ...(p || {}) }))
    .filter((p) => p && p.title)
    .map((p) => ({ title: String(p.title), detail: p.detail ? String(p.detail) : '', ...(p.model ? { model: String(p.model) } : {}) }));
  meta.phaseTitles = meta.phases.map((p) => p.title);
  return { ok: true, meta };
}

/**
 * Run a workflow.
 *
 * @param {object} opts
 * @param {string} [opts.script]     workflow source
 * @param {string} [opts.scriptPath] takes precedence over script/name
 * @param {string} [opts.name]       named workflow in ~/.autobot/workflows/named/
 * @param {string} [opts.args]       task string handed to the script as `args`
 * @param {string} [opts.resumeFromRunId]
 * @param {Function} opts.runAgent   ({prompt, model, tier, schema, cwd}) -> string
 * @param {Function} [opts.emit]     progress sink
 */
async function runWorkflow(opts = {}) {
  const emit = opts.emit || (() => {});
  const runAgent = opts.runAgent;
  if (typeof runAgent !== 'function') {
    return { status: 'error', error: 'Workflow requires an agent runner.' };
  }

  // ---- resolve the script -------------------------------------------------
  let script = opts.script || '';
  let source = 'inline';
  if (opts.scriptPath) {
    const sp = String(opts.scriptPath).replace(/^~(?=$|\/)/, os.homedir());
    if (!fs.existsSync(sp)) return { status: 'error', error: `scriptPath not found: ${sp}` };
    script = fs.readFileSync(sp, 'utf8');
    source = sp;
  } else if (!script && opts.name) {
    const np = path.join(ROOT, 'named', String(opts.name).replace(/[^A-Za-z0-9._-]/g, '') + '.js');
    if (!fs.existsSync(np)) return { status: 'error', error: `No saved workflow named "${opts.name}".` };
    script = fs.readFileSync(np, 'utf8');
    source = np;
  }
  if (!String(script).trim()) {
    return { status: 'error', error: 'No workflow script provided (pass `script`, `scriptPath`, or `name`).' };
  }

  const metaCheck = parseMeta(script);
  if (!metaCheck.ok) return { status: 'error', error: metaCheck.error };
  const meta = metaCheck.meta;

  // ---- run identity + persistence ----------------------------------------
  const resume = opts.resumeFromRunId ? String(opts.resumeFromRunId) : null;
  const runId = resume || newRunId();
  const dir = path.join(ROOT, runId);
  ensureDir(dir);
  fs.writeFileSync(path.join(dir, 'script.js'), script, 'utf8');
  const cacheFile = path.join(dir, 'cache.json');
  const cache = resume ? readJSON(cacheFile, {}) : {};
  const transcriptFile = path.join(dir, 'transcript.jsonl');
  const log = (rec) => {
    try { fs.appendFileSync(transcriptFile, JSON.stringify({ ts: Date.now(), ...rec }) + '\n'); } catch (_) {}
  };
  log({ type: 'start', meta, args: opts.args === undefined ? null : opts.args, resumed: Boolean(resume) });

  // ---- runtime globals ----------------------------------------------------
  // Example caps concurrent agent() calls at min(16, cores-2) per workflow and
  // caps total agents at 1000 as a runaway-loop backstop. Both exist so a
  // 100-item fan-out queues instead of forking 100 subprocesses at once.
  //
  // `shared` is inherited across a nested workflow() call so the child shares the
  // parent's concurrency cap, agent counter and token budget — exactly Example's
  // contract — instead of opening a second independent pool.
  const cores = (os.cpus() || []).length || 4;
  const MAX_CONCURRENT = Math.max(1, Math.min(16, cores - 2));
  const MAX_AGENTS = 1000;
  const shared = opts._shared || {
    maxConcurrent: MAX_CONCURRENT,
    inFlight: 0,
    waiters: [],
    agentCalls: 0,
    depth: 0,
    budget: opts.budget || budgetPool.view(),
  };
  shared.acquire = shared.acquire || (() => new Promise((resolve) => {
    if (shared.inFlight < shared.maxConcurrent) { shared.inFlight++; resolve(); }
    else shared.waiters.push(resolve);
  }));
  shared.release = shared.release || (() => {
    const next = shared.waiters.shift();
    if (next) next(); else shared.inFlight--;
  });
  const acquire = shared.acquire;
  const release = shared.release;

  let currentPhase = meta.phases[0] ? meta.phases[0].title : 'Workflow';
  let agentCalls = 0; // per-workflow count, for the run report
  let cacheHits = 0;
  const output = [];

  const agent = async (promptOrOpts, maybeOpts) => {
    let o;
    if (typeof promptOrOpts === 'string') o = { prompt: promptOrOpts, ...(maybeOpts || {}) };
    else o = { ...(promptOrOpts || {}) };
    const prompt = String(o.prompt || o.task || o.description || '');
    if (!prompt) throw new Error('agent() requires a prompt');
    // opts.phase pins the progress group explicitly (used inside parallel()/
    // pipeline() stages so concurrent work does not race on global phase()).
    const callPhase = o.phase ? String(o.phase) : currentPhase;
    const call = {
      prompt,
      model: o.model || null,
      tier: o.tier || o.complexity || null,
      schema: o.schema || null,
      cwd: o.cwd || opts.cwd || process.cwd(),
      phase: callPhase,
    };
    const key = hashCall({ prompt: call.prompt, model: call.model, tier: call.tier, schema: call.schema, cwd: call.cwd });
    if (cache[key] !== undefined) {
      cacheHits++;
      emit({ type: 'workflow', phase: callPhase, status: 'cached', index: agentCalls });
      log({ type: 'agent', phase: callPhase, cached: true, key });
      return cache[key];
    }
    // The token target is a HARD ceiling, not advice: once the shared pool is
    // spent, further agent() calls throw (Example's contract).
    if (shared.budget && shared.budget.total != null) {
      const used = Number(shared.budget.spent()) || 0;
      if (used >= Number(shared.budget.total)) {
        throw new Error(`Token budget exhausted (${used} / ${shared.budget.total} output tokens). The budget is a hard ceiling — return what you have or stop the run.`);
      }
    }
    if (shared.agentCalls >= MAX_AGENTS) {
      throw new Error(`Workflow agent limit reached (${MAX_AGENTS}). This is the runaway-loop backstop — split the workflow up.`);
    }
    shared.agentCalls++;
    agentCalls++;
    const index = agentCalls;
    emit({ type: 'workflow', phase: callPhase, status: 'agent', index, prompt: prompt.slice(0, 160), label: o.label || null, model: call.model, tier: call.tier });
    log({ type: 'agent', phase: callPhase, index, prompt: prompt.slice(0, 400), model: call.model, tier: call.tier });
    await acquire();
    let res;
    try {
      res = await runAgent({
        prompt,
        model: call.model,
        tier: call.tier,
        schema: call.schema,
        cwd: call.cwd,
        phase: callPhase,
        label: o.label || null,
        isolation: o.isolation || null,
        agentType: o.agentType || null,
      });
    } finally {
      release();
    }
    // A user may skip an agent mid-run; that surfaces as null so the script can
    // `.filter(Boolean)` it, exactly like Example.
    if (res === undefined) res = null;
    cache[key] = res;
    writeJSON(cacheFile, cache); // write-through: a crash keeps finished work
    output.push({ phase: callPhase, index, result: res });
    return res;
  };

  // parallel(): a BARRIER. A thunk that throws resolves to null (the call itself
  // never rejects), so scripts can .filter(Boolean) the results.
  const parallel = async (fns) => {
    if (!Array.isArray(fns)) throw new Error('parallel() requires an array of functions');
    for (const f of fns) if (typeof f !== 'function') throw new Error('each parallel() item must be a function, e.g. () => agent(...)');
    const settled = await Promise.allSettled(fns.map((f) => Promise.resolve().then(f)));
    return settled.map((s) => (s.status === 'fulfilled' ? s.value : null));
  };

  // pipeline(): NO barrier between stages. Items advance independently, so a
  // stage gets (prevResult, originalItem, index). A stage that throws drops
  // that item to null and skips its remaining stages.
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(items)) throw new Error('pipeline() requires an array of items');
    for (const s of stages) if (typeof s !== 'function') throw new Error('each pipeline() stage must be a function');
    const runItem = async (item, index) => {
      let v = item;
      for (const stage of stages) {
        try {
          v = await stage(v, item, index);
        } catch (_) {
          return null;
        }
      }
      return v;
    };
    return Promise.all(items.map((item, i) => runItem(item, i)));
  };

  const phase = (name) => {
    currentPhase = String(name || currentPhase);
    emit({ type: 'workflow', phase: currentPhase, status: 'phase' });
    log({ type: 'phase', phase: currentPhase });
    return currentPhase;
  };

  // log(): a narrator line above the progress tree.
  const logLine = (msg) => {
    const text = String(msg == null ? '' : msg);
    emit({ type: 'workflow', phase: currentPhase, status: 'log', message: text });
    log({ type: 'log', phase: currentPhase, message: text });
  };

  // ---- determinism guards -------------------------------------------------
  // Example's runtime throws on Math.random(), Date.now() and argless new Date():
  // a resumed run must replay cached results exactly, so a workflow may not read
  // wall-clock time or entropy. Shadow the two functions instead of handing the
  // script the host objects, so the shim also cannot mutate host intrinsics.
  const HostDate = Date;
  const workflowMath = Object.create(Math);
  Object.defineProperty(workflowMath, 'random', {
    value: () => { throw new Error('Math.random() is not available in a workflow — entropy breaks resume. Vary the agent prompt or label by index instead.'); },
    writable: true, configurable: true,
  });
  function WorkflowDate(...a) {
    if (!a.length) {
      throw new Error('new Date() with no arguments is not available in a workflow — wall-clock time breaks resume. Pass a timestamp in via args.');
    }
    return new HostDate(...a);
  }
  WorkflowDate.prototype = HostDate.prototype;
  WorkflowDate.parse = HostDate.parse;
  WorkflowDate.UTC = HostDate.UTC;
  Object.defineProperty(WorkflowDate, 'now', {
    value: () => { throw new Error('Date.now() is not available in a workflow — wall-clock time breaks resume. Pass a timestamp in via args.'); },
    writable: true, configurable: true,
  });

  // ---- nested workflow() --------------------------------------------------
  // Example allows ONE level of nesting; the child shares this run's concurrency
  // cap, agent counter and token budget, and returns whatever it returns.
  const childWorkflow = async (ref, childArgs) => {
    if (shared.depth >= 1) {
      throw new Error('workflow() cannot be nested more than one level deep.');
    }
    let o;
    if (typeof ref === 'string') o = { name: ref };
    else if (ref && typeof ref === 'object') o = { name: ref.name, scriptPath: ref.scriptPath || ref.script_path };
    else throw new Error('workflow() expects a saved workflow name or { scriptPath }.');
    if (!o.name && !o.scriptPath) throw new Error('workflow() expects a saved workflow name or { scriptPath }.');
    emit({ type: 'workflow', phase: currentPhase, status: 'workflow-start', name: o.name || o.scriptPath, runId });
    shared.depth++;
    try {
      const out = await runWorkflow({
        name: o.name,
        scriptPath: o.scriptPath,
        args: childArgs,
        cwd: opts.cwd,
        runAgent,
        emit: (e) => emit({ ...e, parentRunId: runId }),
        signal: opts.signal,
        budget: shared.budget,
        _shared: shared,
      });
      if (out.status !== 'completed') {
        throw new Error(`workflow(${o.name || o.scriptPath}) failed: ${out.error || out.status}`);
      }
      return out.result;
    } finally {
      shared.depth--;
    }
  };

  const sandbox = {
    meta,
    // `args` is passed VERBATIM — arrays/objects stay arrays/objects, exactly like
    // Example (a JSON-encoded string would reach the script as one string and
    // `args.map` would throw).
    args: opts.args === undefined ? undefined : opts.args,
    agent,
    parallel,
    pipeline,
    phase,
    log: logLine,
    workflow: childWorkflow,
    budget: shared.budget,
    phases: PHASES.slice(),
    console: { log: (...a) => logLine(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')) },
    Math: workflowMath,
    Date: WorkflowDate,
    // Every other built-in (JSON, Array, Object, Promise, …) comes from the vm
    // realm itself, so one run cannot mutate the host's intrinsics.
    setTimeout: undefined, setInterval: undefined,
    // Deliberately absent: require, process, fs, fetch — a workflow orchestrates
    // agents; it does not touch the machine directly.
  };

  const hadExportDefault = /(?:^|\n)\s*export\s+default\s+/.test(String(script || ''));
  let body = hadExportDefault
    ? String(script || '')
        .replace(/\bexport\s+const\s+meta\s*=/, 'const meta =')
        .replace(/\bexport\s+default\s+/g, 'const __wfDefault = ')
        .replace(/\bexport\s+(?=(?:async\s+)?(?:function|const|let|var|class)\b)/g, '')
    : normalizeScript(script);
  if (hadExportDefault) {
    body += '\n; if (typeof __wfDefault === "function") return await __wfDefault(args); if (typeof __wfDefault !== "undefined") return __wfDefault;';
  }
  // Top-level `return` is legal because the script runs inside an async closure.
  const wrapped = `(async () => {\n${body}\n})()`;

  let result;
  let error = null;
  const startedAt = Date.now();
  try {
    const ctx = vm.createContext(sandbox);
    const scriptObj = new vm.Script(wrapped, { filename: `${runId}/script.js` });
    result = await scriptObj.runInContext(ctx, { timeout: 30 * 60 * 1000 });
  } catch (e) {
    error = e && e.message ? e.message : String(e);
  }
  const durationMs = Date.now() - startedAt;

  if (!error && agentCalls === 0 && cacheHits === 0 && result === undefined) {
    error = 'Workflow script completed without calling agent() or returning a value. Invoke agent()/parallel()/pipeline() or return a result.';
  }

  log({ type: error ? 'error' : 'done', error, durationMs, agentCalls, cacheHits });
  emit({ type: 'workflow', phase: currentPhase, status: error ? 'error' : 'done', error, agentCalls, cacheHits });

  if (error) {
    return { status: 'error', error, runId, scriptPath: path.join(dir, 'script.js'), transcriptDir: dir, agentCalls, cacheHits };
  }

  // A workflow may return a string (the answer) or an object (a report).
  let summary;
  if (typeof result === 'string') summary = result;
  else if (result && typeof result === 'object') summary = JSON.stringify(result, null, 2);
  else summary = output.length ? String(output[output.length - 1].result) : '(workflow completed)';

  return {
    status: 'completed',
    runId,
    summary,
    scriptPath: path.join(dir, 'script.js'),
    transcriptDir: dir,
    agentCalls,
    cacheHits,
    durationMs,
    phases: meta.phases,
    result,
    output,
  };
}

// Save a script under a name so `Workflow({name})` can replay it later.
function saveNamedWorkflow(name, script) {
  const n = String(name || '').replace(/[^A-Za-z0-9._-]/g, '');
  if (!n) return { ok: false, error: 'name required' };
  const file = path.join(ROOT, 'named', n + '.js');
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, String(script || ''), 'utf8');
  return { ok: true, path: file };
}

function listNamedWorkflows() {
  const dir = path.join(ROOT, 'named');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    const m = parseMeta(src);
    return { name: f.replace(/\.js$/, ''), description: m.ok ? m.meta.description : '', phases: m.ok ? m.meta.phases : [] };
  });
}

module.exports = { runWorkflow, parseMeta, normalizeScript, saveNamedWorkflow, listNamedWorkflows, ROOT };
