'use strict';
// LIVE end-to-end: Akron Bot harness + role pools + swarm against the real
// local FreeLLMAPI router (http://127.0.0.1:3001/v1). Not part of the unit
// suite — it spends free-tier quota.
//
//   node test/live/freellm-swarm-live.cjs <projectDir> [phase]
//     phase: swarm | agent | both (default both)
//
// Phase 1 (swarm): Planner decomposes a multi-module Node project, Coder
//   workers build it in parallel across the coder pool, the board coordinates,
//   the supervisor reviews.
// Phase 2 (agent): a single Claude-Code-style agent run on the coder pool
//   runs the test suite and fixes every failure until `npm test` is green.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const llm = require('../../electron/llm');
const swarm = require('../../electron/swarm');
const router = require('../../electron/orch-router');
const gate = require('../../electron/provider-gate');

const dir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'akron-live-' + Date.now()));
const phase = process.argv[3] || 'both';
fs.mkdirSync(dir, { recursive: true });
const settings = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.autobot', 'settings.json'), 'utf8'));
const BASE = process.env.FREELLM_BASE || 'http://127.0.0.1:3001/v1';
// The session provider may be a subscription account; the router token lives
// in ~/.autobot/freellm.json either way.
const KEY = process.env.FREELLM_KEY
  || (/:3001\b/.test(String(settings.provider && settings.provider.baseURL)) && settings.provider.apiKey)
  || (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.autobot', 'freellm.json'), 'utf8')).token; } catch (_) { return ''; } })();
const provider = { baseURL: BASE, apiKey: KEY, model: process.env.MAIN_MODEL || 'qwen3.8-flash', supportsTools: true, maxTokens: 16000, temperature: 0.3 };
const orch = { enabled: false, providers: [], activeIndex: 0, pools: router.freellmPreset(BASE) };
const logFile = path.join(dir, '.akron-live-log.jsonl');
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const stats = { tools: {}, failovers: 0, notices: [], served: {}, subagents: {}, errors: [] };
function log(evt) {
  try { fs.appendFileSync(logFile, JSON.stringify({ t: Date.now() - t0, ...evt, messages: undefined }) + '\n'); } catch (_) {}
  const who = evt.subagent ? `[${String(evt.subagent).slice(0, 18)}]` : '[main]';
  switch (evt.type) {
    case 'tool': stats.tools[evt.name] = (stats.tools[evt.name] || 0) + 1; console.log(stamp(), who, 'tool', evt.name, summarize(evt.args)); break;
    case 'toolResult': if (evt.isError) console.log(stamp(), who, '  ✗', evt.name, String(evt.result).replace(/\s+/g, ' ').slice(0, 160)); break;
    case 'orchestrator': stats.failovers++; console.log(stamp(), who, '⇣ failover', evt.from, '→', evt.to, '|', String(evt.reason || '').slice(0, 110)); break;
    case 'notice': stats.notices.push(evt.text); console.log(stamp(), who, 'notice:', String(evt.text).slice(0, 200)); break;
    case 'subagent': stats.subagents[evt.name || evt.id] = evt.status; console.log(stamp(), '[team]', evt.name || evt.id, evt.status, evt.model || '', evt.jobRole || evt.tier || '', evt.ms ? `${Math.round(evt.ms / 1000)}s` : '', evt.error ? String(evt.error).slice(0, 120) : ''); break;
    case 'swarm': console.log(stamp(), '[swarm]', evt.phase, JSON.stringify(evt.tasks || evt.roster || evt.results || evt.stalled || evt.addressed || '').slice(0, 400)); break;
    case 'thinking': if (/waiting \d+s/.test(evt.text || '')) console.log(stamp(), who, String(evt.text).trim()); break;
    case 'error': stats.errors.push(evt.message); console.log(stamp(), who, 'ERROR', evt.message); break;
    default: break;
  }
}
function summarize(a) {
  if (!a || typeof a !== 'object') return '';
  const p = a.file_path || a.path || a.pattern || a.command || a.description || a.text || a.goal || '';
  return String(p).replace(/\s+/g, ' ').slice(0, 110);
}

const GOAL = `Build "tasklite", a small but real multi-module task-tracker in plain Node.js (>=18, NO npm dependencies) in the current folder.

Required layout and behaviour:
1. package.json — name "tasklite", "type": "commonjs", scripts: {"test": "node --test test/", "start": "node src/server.js"}.
2. src/store.js — JSON-file persistence. export createStore(filePath): {list(filter), get(id), create(data), update(id, patch), remove(id)}. Writes are atomic (write tmp file then fs.renameSync). Ids are incrementing integers. Persist to the file passed in.
3. src/model.js — export validateTask(data, {partial}) returning {ok, errors[]}; a task has title (non-empty string, max 200), status ("todo"|"doing"|"done", default "todo"), priority (1-5 integer, default 3), tags (array of strings, default []), createdAt/updatedAt ISO strings set by the store.
4. src/server.js — node:http REST API exporting createServer(store) (and starting on PORT 3456 only when run directly): GET /tasks (query filters status, tag, minPriority), GET /tasks/:id, POST /tasks, PATCH /tasks/:id, DELETE /tasks/:id, GET /stats -> {total, byStatus:{todo,doing,done}}. JSON in/out; 400 with {errors} on validation failure, 404 when missing.
5. src/cli.js — "node src/cli.js <add|list|done|rm|stats> ..." operating directly on a store file given by env TASKLITE_DB (default ./tasks.json); prints human-readable output.
6. test/ — node:test suites: test/store.test.js, test/model.test.js, test/server.test.js (start the server on an ephemeral port with createServer(store).listen(0)), test/cli.test.js (spawn the CLI with a temp TASKLITE_DB). At least 20 meaningful assertions overall.
7. README.md documenting API and CLI.
Everything must work together: \`npm test\` must pass.`;

async function phaseSwarm() {
  console.log(`\n=== PHASE 1: SWARM on role pools ===\nproject: ${dir}\npools: ${router.summary(orch, provider)}\n`);
  const runner = (subOpts) => llm.runAgent({ provider, orchestrator: orch, cwd: dir, emit: log, ...subOpts });
  const res = await swarm.swarm(GOAL, { runAgent: runner, provider, orchestrator: orch, cwd: dir, emit: log, concurrency: 4, maxTasks: 6 });
  console.log(`\n--- swarm done in ${Math.round(res.ms / 1000)}s; supervisor ${res.supervisor.model}; plan ${res.planSource}`);
  for (const r of res.results) console.log(`  ${r.status.padEnd(7)} ${String(r.title).slice(0, 40).padEnd(40)} ${String(r.role || r.tier).padEnd(8)} ${r.model} round ${r.round} ${Math.round(r.ms / 1000)}s`);
  console.log(`  board: ${res.board.length} messages; members: ${res.members.map((m) => m.name + ':' + m.state).join(', ')}`);
  console.log('\nSUPERVISOR ANSWER (head):\n' + String(res.answer).slice(0, 1500));
  return res;
}

async function phaseAgent() {
  console.log(`\n=== PHASE 2: single agent (coder pool) — run tests, fix until green ===\n`);
  const msgs = [{ role: 'user', content: `You are working in ${dir} on the "tasklite" project described below. Inspect what exists (Glob/Read), run \`npm test\` with Bash, and fix every failure or missing piece (create missing files) until \`npm test\` passes completely. Use Edit for small changes. When it passes, reply with the final test summary line.\n\nSPEC:\n${GOAL}` }];
  const out = await llm.runAgent({ provider, orchestrator: orch, messages: msgs, cwd: dir, emit: log, turnStart: true });
  const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
  console.log('\nAGENT FINAL:\n' + String(last && last.content).slice(0, 1200));
  return out;
}

async function phaseFeature() {
  console.log(`\n=== PHASE 3: main agent + parallel Task sub-agents — feature work on the existing project ===\n`);
  const msgs = [{ role: 'user', content: `Project: ${dir} ("tasklite", already working). Do these two things, delegating them to TWO sub-agents in parallel with the Task tool (send both Task calls in ONE message), then verify yourself:
A) Portability: \`npm test\` currently runs "node --test test/", which fails on Node 20-24 (a directory argument is not accepted there). Change the script to "node --test test/*.test.js" so it works on Node 18-26.
B) Feature: full-text search. Add store.search(q) (case-insensitive match on title and tags), GET /tasks?q=<text> in src/server.js (combinable with the other filters), and a CLI command "node src/cli.js search <text>". Add tests for all three in the existing test files.
After both sub-agents report, run \`npm test\` with Bash, fix anything still failing, and finish with the final test summary line.` }];
  const out = await llm.runAgent({ provider, orchestrator: orch, messages: msgs, cwd: dir, emit: log, turnStart: true });
  const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
  console.log('\nAGENT FINAL:\n' + String(last && last.content).slice(0, 1200));
}

function verify() {
  let ok = false, summary = '';
  try {
    summary = execSync('npm test 2>&1', { cwd: dir, timeout: 180000, encoding: 'utf8' });
    ok = true;
  } catch (e) { summary = String(e.stdout || '') + String(e.stderr || ''); }
  const lines = summary.split('\n').filter((l) => /^# (tests|pass|fail|suites)/.test(l.trim()));
  const files = execSync('find . -type f -not -path "./node_modules/*" -not -name ".akron-live-log.jsonl" | sort', { cwd: dir, encoding: 'utf8' }).trim();
  console.log(`\n=== VERIFY (independent npm test) ===\n${files}\n${lines.join('\n') || summary.slice(-1500)}\nPASS=${ok}`);
  return { ok, lines };
}

(async () => {
  try {
    if (phase === 'swarm' || phase === 'both') await phaseSwarm();
    if (phase === 'feature') await phaseFeature();
    let v = verify();
    if (!v.ok && (phase === 'agent' || phase === 'both')) {
      await phaseAgent();
      v = verify();
    }
    console.log('\n=== STATS ===');
    console.log('tools:', JSON.stringify(stats.tools));
    console.log('failovers:', stats.failovers, '| errors:', stats.errors.length, '| notices:', stats.notices.length);
    console.log('gate:', JSON.stringify(Object.fromEntries(Object.entries(gate.snapshot()).filter(([, x]) => x.coolingMs || x.dead || x.strikes)), null, 0).slice(0, 1500));
    console.log(`total ${Math.round((Date.now() - t0) / 1000)}s  RESULT=${v.ok ? 'PASS' : 'FAIL'}`);
    process.exit(v.ok ? 0 : 2);
  } catch (e) {
    console.error('LIVE RUN CRASHED:', e && e.stack || e);
    process.exit(3);
  }
})();
