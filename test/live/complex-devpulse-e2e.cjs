'use strict';
// LIVE complex project E2E against FreeLLMAPI router:
//   Phase A: Antigravity Swarm (planner + parallel coder workers + board + review)
//   Phase B: Claude-Code single-agent repair pass (if initial npm test fails)
//   Phase C: Claude-Code parallel Task subagents + Creator Mode custom tool
// Builds `/Users/saimon/Akron Bot/sample-devpulse` from scratch and verifies
// `npm test` and CLI execution independently.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const llm = require('../../electron/llm');
const swarm = require('../../electron/swarm');
const router = require('../../electron/orch-router');
const gate = require('../../electron/provider-gate');
const customtools = require('../../electron/customtools');
const toolsMod = require('../../electron/tools');

const dir = path.resolve(process.argv[2] || '/Users/saimon/Akron Bot/sample-devpulse');
const phaseArg = process.argv[3] || 'all';

// Prepare clean project directory with git init only on full/swarm runs.
if (phaseArg === 'all' || phaseArg === 'swarm' || !fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'bot@akron.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Akron Bot'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n.akron-live-log.jsonl\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '# devpulse\n\nZero-dependency codebase analyzer.\n');
  execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'chore: initial scaffold'], { cwd: dir, stdio: 'ignore' });
}

const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.autobot', 'freellm.json'), 'utf8'));
const BASE = process.env.FREELLM_BASE || `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
const KEY = process.env.FREELLM_KEY || cfg.token;
if (!KEY) { console.error('No FreeLLMAPI token in ~/.autobot/freellm.json'); process.exit(1); }

const provider = { baseURL: BASE, apiKey: KEY, model: 'qwen3.8-flash', supportsTools: true, maxTokens: 16000, temperature: 0.25 };
const orch = { enabled: false, providers: [], activeIndex: 0, pools: router.freellmPreset(BASE) };
const logFile = path.join(dir, '.akron-live-log.jsonl');
const t0 = Date.now();
const stamp = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6) + 's';
const stats = { tools: {}, failovers: 0, notices: [], subagents: {}, errors: [] };

function summarize(a) {
  if (!a || typeof a !== 'object') return '';
  const p = a.file_path || a.path || a.pattern || a.command || a.description || a.text || a.goal || a.name || '';
  return String(p).replace(/\s+/g, ' ').slice(0, 110);
}
function log(evt) {
  try { fs.appendFileSync(logFile, JSON.stringify({ t: Date.now() - t0, ...evt, messages: undefined }) + '\n'); } catch (_) {}
  const who = evt.subagent ? `[${String(evt.subagent).slice(0, 18)}]` : '[main]';
  switch (evt.type) {
    case 'tool': stats.tools[evt.name] = (stats.tools[evt.name] || 0) + 1; console.log(stamp(), who, 'tool', evt.name, summarize(evt.args)); break;
    case 'toolResult': if (evt.isError) console.log(stamp(), who, '  ✗', evt.name, String(evt.result).replace(/\s+/g, ' ').slice(0, 160)); break;
    case 'orchestrator': stats.failovers++; console.log(stamp(), who, '⇣ failover', evt.from, '→', evt.to, '|', String(evt.reason || '').slice(0, 110)); break;
    case 'notice': stats.notices.push(evt.text); console.log(stamp(), who, 'notice:', String(evt.text).slice(0, 200)); break;
    case 'subagent': stats.subagents[evt.name || evt.id] = evt.status; console.log(stamp(), '[team]', evt.name || evt.id, evt.status, evt.model || '', evt.jobRole || evt.tier || ''); break;
    case 'swarm': console.log(stamp(), '[swarm]', evt.phase, JSON.stringify(evt.tasks || evt.roster || evt.results || evt.stalled || evt.addressed || '').slice(0, 320)); break;
    case 'error': stats.errors.push(evt.message); console.log(stamp(), who, 'ERROR', evt.message); break;
    default: break;
  }
}

const GOAL = `Build "devpulse", a zero-dependency Node.js (>=18) codebase analyzer & dashboard server in the current directory (${dir}).

Required files and exact exports:
1. package.json:
   { "name": "devpulse", "version": "1.0.0", "type": "commonjs", "scripts": { "test": "node --test test/*.test.js", "start": "node src/cli.js --dir ." } }
2. src/scanner.js:
   Export scanDirectory(rootDir, opts): recursively scans .js/.cjs/.mjs/.jsx files skipping node_modules, .git, dist, release.
   Returns { rootDir, files: [{ file, relPath, lines, codeLines, commentLines, blankLines, complexity, imports, exports }], totals: { files, lines, codeLines, avgComplexity } }.
   Extract local relative CommonJS require('./...') and ESM import ... from './...' paths plus exported symbols; estimate cyclomatic complexity (1 + branch keywords).
3. src/graph.js:
   Export buildGraph(scanResult): resolves local relative imports between scanned files (handling extension omitted .js or /index.js), computes:
   - nodes: [{ id: relPath, inDegree, outDegree, complexity, fanScore }]
   - edges: [{ from, to }]
   - cycles: string[][] (list of strongly connected components / DFS cycles of length >= 2 or self-loops)
   - hotspots: top nodes sorted by complexity * (1 + inDegree + outDegree)
4. src/reporter.js:
   Export formatReport(graph, scanResult, format): supports "json", "md"/"markdown", and "html".
   - "json": pretty JSON string with summary, cycles, hotspots, nodes, edges
   - "md": Markdown report with summary stats, cycle warnings, and hotspot table
   - "html": valid standalone HTML document containing an inline <svg> bar chart of top hotspots and cycle table
5. src/server.js:
   Export createServer(rootDir) returning a node:http Server (do NOT auto-listen when required).
   Endpoints:
   - GET /api/health -> 200 { ok: true }
   - GET /api/summary -> 200 JSON summary (totals + hotspots + nodeCount + edgeCount)
   - GET /api/cycles -> 200 { count, cycles }
   - GET /report.html -> 200 HTML report from formatReport(..., 'html')
   - Unknown routes -> 404 { error: 'Not found' }
   Start listening on process.env.PORT || 4100 ONLY when require.main === module.
6. src/cli.js:
   Supports "node src/cli.js --dir <path> --format <json|md|html> [--out <file>]". Defaults: --dir . --format json.
   Export runCli(argv) and execute when require.main === module.
7. test/ — using node:test + node:assert/strict across:
   - test/scanner.test.js
   - test/graph.test.js (must verify real cycle detection on a temp fixture directory with A->B->A)
   - test/reporter.test.js (verifies json, md, and html containing <svg)
   - test/server.test.js (starts createServer on port 0, fetches /api/health, /api/summary, /api/cycles, /report.html, and closes server)
   - test/cli.test.js (runs src/cli.js against a temp dir and validates JSON & markdown output)
   At least 25 assertions total. Everything must pass cleanly via \`npm test\`.`;

async function phaseSwarm() {
  console.log(`\n=== PHASE A: Antigravity SWARM ===\ndir: ${dir}\n`);
  const runner = (subOpts) => llm.runAgent({
    provider,
    orchestrator: orch,
    cwd: dir,
    emit: log,
    approveTool: async () => true,
    ...subOpts,
  });
  const res = await swarm.swarm(GOAL, {
    runAgent: runner,
    provider,
    orchestrator: orch,
    cwd: dir,
    emit: log,
    concurrency: 4,
    maxTasks: 6,
  });
  console.log(`--- Swarm finished in ${Math.round(res.ms / 1000)}s; planSource=${res.planSource}; supervisor=${res.supervisor.model}; boardMsgs=${res.board.length}`);
  return res;
}

async function phaseRepair() {
  console.log(`\n=== PHASE B: Single-agent Coder Repair Pass ===\n`);
  const msgs = [{
    role: 'user',
    content: `You are working in ${dir} ("devpulse"). Inspect existing files with Glob/Read, run \`npm test\` with Bash, and fix any missing files, broken imports, or failing assertions until \`npm test\` passes 100% cleanly.\n\nSPEC:\n${GOAL}`,
  }];
  await llm.runAgent({
    provider,
    orchestrator: orch,
    messages: msgs,
    cwd: dir,
    emit: log,
    turnStart: true,
    approveTool: async () => true,
  });
}

async function phaseParallelAndCreator() {
  console.log(`\n=== PHASE C: Parallel Task Subagents + Creator Mode ===\n`);
  const origCtRoot = customtools.getRoot();
  const tmpCt = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-e2e-ct-'));
  customtools.setRoot(tmpCt);
  try {
    const msgs = [{
      role: 'user',
      content: `Working directory: ${dir} ("devpulse"). Execute ALL three steps:
1. Launch TWO Task sub-agents in parallel (in ONE assistant turn):
   - Sub-agent 1 (name: "edge-tester"): Add a test in test/scanner.test.js verifying that node_modules and .git directories are ignored during scanDirectory.
   - Sub-agent 2 (name: "doc-auditor"): Update README.md in ${dir} with exact CLI flags (--dir, --format, --out) and HTTP API endpoints (/api/health, /api/summary, /api/cycles, /report.html).
2. Create a Creator Mode custom tool via CreateCustomTool named "devpulse_check_json" (runtime: "node") that parses JSON from TOOL_ARGS_JSON { file } or runs inside cwd to count .js files under src/ and prints COUNT=<n>. Call devpulse_check_json, then call DeleteCustomTool to remove it cleanly.
3. Run \`npm test\` via Bash and confirm all tests pass.`,
    }];
    const out = await llm.runAgent({
      provider,
      orchestrator: orch,
      messages: msgs,
      cwd: dir,
      emit: log,
      turnStart: true,
      approveTool: async () => true,
      maxSteps: 24,
    });
    const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
    console.log('PHASE C REPLY:', String(last && last.content || '').slice(0, 800));
  } finally {
    customtools.setRoot(origCtRoot);
    customtools.registerAll(toolsMod.toolDefinitions, toolsMod.executorsByTool, toolsMod.executors);
    try { fs.rmSync(tmpCt, { recursive: true, force: true }); } catch (_) {}
  }
}

function verifyIndependent() {
  let testOk = false;
  let testOut = '';
  try {
    testOut = execSync('npm test 2>&1', { cwd: dir, timeout: 120000, encoding: 'utf8' });
    testOk = true;
  } catch (e) {
    testOut = String(e.stdout || '') + String(e.stderr || '');
  }
  let cliOk = false;
  let cliOut = '';
  try {
    cliOut = execSync('node src/cli.js --dir . --format json 2>&1', { cwd: dir, timeout: 30000, encoding: 'utf8' });
    const parsed = JSON.parse(cliOut);
    cliOk = Boolean(parsed && (parsed.summary || parsed.totals || parsed.nodes));
  } catch (e) {
    cliOut = String(e.stdout || '') + String(e.stderr || '') + ' ' + e.message;
  }
  const files = execSync('find . -type f -not -path "./.git/*" -not -path "./node_modules/*" -not -name ".akron-live-log.jsonl" | sort', { cwd: dir, encoding: 'utf8' }).trim();
  const summaryLines = testOut.split('\n').filter((l) => /^# (tests|pass|fail|suites|ok|not ok)/.test(l.trim()) || /^[✔✖ℹ]/.test(l.trim()));
  console.log(`\n=== INDEPENDENT VERIFY ===\nFILES:\n${files}\n\nTEST SUMMARY:\n${summaryLines.join('\n') || testOut.slice(-1500)}\nCLI_JSON_OK=${cliOk}  TEST_OK=${testOk}`);
  return { testOk, cliOk };
}

(async () => {
  try {
    if (phaseArg === 'all' || phaseArg === 'swarm') await phaseSwarm();
    let v = verifyIndependent();
    if (!v.testOk || !v.cliOk) {
      await phaseRepair();
      v = verifyIndependent();
    }
    if (v.testOk && (phaseArg === 'all' || phaseArg === 'parallel' || phaseArg === 'repair')) {
      await phaseParallelAndCreator();
      v = verifyIndependent();
      if (!v.testOk) {
        await phaseRepair();
        v = verifyIndependent();
      }
    }
    console.log('\n=== STATS ===');
    console.log('tools:', JSON.stringify(stats.tools));
    console.log('subagents:', JSON.stringify(stats.subagents));
    console.log('failovers:', stats.failovers, 'errors:', stats.errors.length);
    console.log(`total ${Math.round((Date.now() - t0) / 1000)}s  RESULT=${v.testOk && v.cliOk ? 'PASS' : 'FAIL'}`);
    process.exit(v.testOk && v.cliOk ? 0 : 2);
  } catch (e) {
    console.error('LIVE E2E CRASHED:', e && e.stack || e);
    process.exit(3);
  }
})();
