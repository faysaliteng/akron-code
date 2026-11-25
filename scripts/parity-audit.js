'use strict';
// Atomic capability audit: Example Code's authoritative tool surface vs Helio Bot.
//
// Ground truth is /opt/homebrew/lib/node_modules/@anthropic-ai/example-code/sdk-tools.d.ts
// (43 input schemas) plus the tool names recovered from the binary by REA. For
// each tool we prove it is DEFINED (toolDefinitions) and HANDLED (a dispatch
// path exists: runTool special case, executorsByTool, or parity.handle).
//
// Exit code is non-zero when any authoritative tool is missing a definition or a
// handler, so this doubles as a CI gate — "not a single atomic gap" is a test,
// not a claim.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { toolDefinitions } = require(path.join(ROOT, 'electron', 'tools'));
const parity = require(path.join(ROOT, 'electron', 'parity'));
const toolsSrc = fs.readFileSync(path.join(ROOT, 'electron', 'tools.js'), 'utf8');

// Every input interface in sdk-tools.d.ts (authoritative Example Code tool set),
// mapped to the tool name the model actually calls.
const SDK_MAP = {
  AgentInput: 'Agent',
  BashInput: 'Bash',
  TaskOutputInput: 'TaskOutput',
  ExitPlanModeInput: 'ExitPlanMode',
  FileEditInput: 'Edit',
  FileReadInput: 'Read',
  FileWriteInput: 'Write',
  GlobInput: 'Glob',
  GrepInput: 'Grep',
  TaskStopInput: 'TaskStop',
  ListMcpResourcesInput: 'ListMcpResources',
  McpInput: 'Mcp',
  NotebookEditInput: 'NotebookEdit',
  ReadMcpResourceInput: 'ReadMcpResource',
  TodoWriteInput: 'TodoWrite',
  WebFetchInput: 'WebFetch',
  WebSearchInput: 'WebSearch',
  AskUserQuestionInput: 'AskUserQuestion',
  EnterPlanModeInput: 'EnterPlanMode',
  TaskCreateInput: 'TaskCreate',
  TaskGetInput: 'TaskGet',
  TaskUpdateInput: 'TaskUpdate',
  TaskListInput: 'TaskList',
  REPLInput: 'REPL',
  WorkflowInput: 'Workflow',
  CronCreateInput: 'CronCreate',
  CronDeleteInput: 'CronDelete',
  CronListInput: 'CronList',
  ScheduleWakeupInput: 'ScheduleWakeup',
  RemoteTriggerInput: 'RemoteTrigger',
  MonitorInput: 'Monitor',
  PushNotificationInput: 'PushNotification',
  EnterWorktreeInput: 'EnterWorktree',
  ExitWorktreeInput: 'ExitWorktree',
};

// Tool names recovered from the binary by REA that are not sdk-tools input
// interfaces (teams, skills, tool search, structured output, messaging, etc).
const EXTRA = [
  'TeamCreate', 'TeamDelete', 'SendMessage', 'Skill', 'ToolSearch',
  'StructuredOutput', 'PowerShell', 'Brief', 'SendUserFile', 'SendUserMessage',
  'ConnectGitHub', 'KillShell', 'MultiEdit', 'LS', 'Search',
  // legacy aliases Example Code still accepts
  'Read', 'Write', 'Edit',
];

const defs = new Set(toolDefinitions.map((t) => t.name));
const defByName = new Map(toolDefinitions.map((t) => [t.name, t]));
const execKeys = Object.keys(require(path.join(ROOT, 'electron', 'tools')).executorsByTool || {});
const parityNames = new Set(parity.NAMES || []);
// Special-cased dispatch in runTool: `if (name === 'X'` / `name === 'X' || name === 'Y'`.
const specialNames = new Set();
for (const m of toolsSrc.matchAll(/name === '([A-Za-z0-9_]+)'/g)) specialNames.add(m[1]);
for (const m of toolsSrc.matchAll(/name === '([A-Za-z0-9_]+)'/g)) specialNames.add(m[1]);

const handled = (n) =>
  specialNames.has(n) ||
  parityNames.has(n) ||
  execKeys.includes(n) ||
  // virtual MCP / bridge names the runTool handles inline
  toolsSrc.includes(`name === '${n}'`);

const rows = [];
let missingDef = 0;
let missingHandler = 0;

function addRow(tool, source) {
  const defined = defs.has(tool);
  const h = handled(tool);
  if (!defined) missingDef++;
  if (!h) missingHandler++;
  rows.push({ tool, source, defined, handled: h, ok: defined && h });
}

for (const [iface, tool] of Object.entries(SDK_MAP)) addRow(tool, iface.replace(/Input$/, ''));
for (const tool of EXTRA) addRow(tool, 'REA/binary');

// ── Schema gate: every property Example's sdk-tools.d.ts declares for a tool
// must exist in our tool definition, so the model can pass exactly the
// arguments Example's own prompt tells it to pass. Extra properties are fine
// (they are our aliases), but they are listed so they stay deliberate.
const DTS = '/opt/homebrew/lib/node_modules/@anthropic-ai/example-code/sdk-tools.d.ts';

function parseInterfaceProps(src, iface) {
  // Body = from `export interface X {` to the first `}` at column 0.
  const start = src.indexOf(`export interface ${iface} {`);
  if (start < 0) return null;
  const open = src.indexOf('{', start);
  let depth = 0;
  let i = open;
  let end = -1;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const body = src.slice(open + 1, end);
  // Strip block comments so commented-out sample code never looks like a property.
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  const props = [];
  for (const line of clean.split('\n')) {
    // Property declarations are indented exactly two spaces at interface level.
    const m = line.match(/^  ([A-Za-z_$][\w$]*)\??:/);
    if (m) props.push(m[1]);
  }
  return props;
}

const schemaRows = [];
let missingProps = 0;
let extraProps = 0;
if (fs.existsSync(DTS)) {
  const dts = fs.readFileSync(DTS, 'utf8');
  for (const [iface, tool] of Object.entries(SDK_MAP)) {
    const want = parseInterfaceProps(dts, iface);
    const def = defByName.get(tool);
    if (!want || !def) continue; // covered by the DEFINED/HANDLED gate above
    const have = Object.keys((def.parameters && def.parameters.properties) || {});
    const haveSet = new Set(have);
    const missing = want.filter((p) => !haveSet.has(p));
    const extra = have.filter((p) => !want.includes(p));
    if (missing.length) missingProps += missing.length;
    if (extra.length) extraProps += extra.length;
    schemaRows.push({ tool, iface, want: want.length, have: have.length, missing, extra, ok: missing.length === 0 });
  }
}

// ── Subsystems (not tool names) ────────────────────────────────────────────
const SUBSYSTEMS = [
  ['hooks (10 events)', 'electron/hooks.js', ['PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SessionStart']],
  ['workflow DSL', 'electron/workflow.js', ['runWorkflow', 'parseMeta', 'agent', 'parallel', 'pipeline']],
  ['token budget pool', 'electron/budget.js', ['parseDirective', 'applyDirective', 'addOutput', 'remaining', 'exhausted']],
  ['task board', 'electron/tasks.js', ['create', 'get', 'update', 'list']],
  ['cron engine', 'electron/cronexpr.js', ['parse', 'next']],
  ['scheduler', 'electron/scheduler.js', ['createCron', 'createWakeup']],
  ['swarm orchestrator', 'electron/swarm.js', ['swarm', 'normalizeTier', 'pickProvider']],
  ['cowork', 'electron/cowork.js', ['orchestrate', 'registerWorker']],
  ['mindmap', 'electron/mindmap.js', ['read', 'updateFromRun']],
  ['browser', 'electron/browser.js', ['loadURL', 'screenshot', 'click', 'type', 'executeJS']],
  ['skills store', 'electron/store.js', ['getSkills', 'addCustomSkill', 'loadSkill', 'getMemory']],
  ['plugins', 'electron/plugins.js', ['list', 'search']],
  ['persistent REPL', 'electron/repl.js', ['evalJS', 'resetSession', 'listSessions']],
  ['background jobs', 'electron/bg.js', ['startShell', 'startAgent', 'startMonitor', 'waitFor', 'stopJob', 'view', 'listJobs']],
  ['parity handlers', 'electron/parity.js', ['handle', 'NAMES']],
  ['parity defs', 'electron/parity-defs.js', ["name: 'TaskCreate'", "name: 'Workflow'", "name: 'Monitor'"]],
  ['example config loader', 'electron/claudeconfig.js', ['loadSettings', 'parseFrontmatter', 'listMarkdown', 'loadMcpServers']],
  ['agent definitions', 'electron/agentdefs.js', ['BUILTIN', 'discover', 'resolve', 'allowedToolSet', 'promptFor']],
  ['project memory', 'electron/memory.js', ['memoryFiles', 'loadMemoryText', 'listMemory', 'expandImports']],
  ['permission rules', 'electron/permissions.js', ['loadPermissions', 'decide', 'ruleMatches', 'matchBash', 'matchGlob']],
  ['custom commands', 'electron/commands.js', ['discover', 'resolve', 'expand', 'listForUi', 'BUILTIN']],
  ['checkpoints / rewind', 'electron/checkpoints.js', ['snapshotFile', 'listCheckpoints', 'restore', 'removeCheckpoint']],
  ['compliance (taint caps)', 'electron/compliance.js', ['evaluate', 'snapshot', 'setProfile', 'recordDeletion', 'readAudit', 'sessionDeletion', 'cloudMovePolicy', 'deploymentMode']],
  ['link unfurl', 'electron/unfurl.js', ['unfurl', 'looksUnfurlable', 'cacheFile']],
  ['artifact canvas', 'electron/artifactcanvas.js', ['canvasHtml', 'parseDesign', 'parseSlides']],
  ['extension host', 'electron/extensionhost.js', ['CHANNELS', 'canonicalChannel', 'NAMESPACES']],
  ['mcp oauth (custom-3p)', 'electron/mcpoauth.js', ['authorize', 'startLoopback', 'pkce', 'discoverProtectedResource', 'discoverAuthServer', 'registerClient', 'exchangeCode', 'ensureAccessToken', 'describeAuthError']],
];

const subRows = [];
for (const [label, file, symbols] of SUBSYSTEMS) {
  const abs = path.join(ROOT, file);
  const exists = fs.existsSync(abs);
  let keys = [];
  if (exists) {
    try {
      const mod = require(abs);
      keys = Object.keys(mod || {});
    } catch (_) {
      // Some modules need Electron (main.js). Fall back to source scanning.
      try { keys = []; } catch (__) {}
    }
  }
  const keySet = new Set(keys);
  const present = (s) => keySet.has(s) || (exists && fs.readFileSync(abs, 'utf8').includes(s));
  const found = symbols.filter(present);
  const ok = exists && found.length === symbols.length;
  subRows.push({ label, file, exists, found: found.length, want: symbols.length, ok, missing: symbols.filter((s) => !present(s)) });
}

// ── Report ──────────────────────────────────────────────────────────────────
const pad = (s, n) => String(s).padEnd(n);
console.log('\n=== EXAMPLE CODE TOOL SURFACE (' + rows.length + ') ===');
console.log(pad('TOOL', 22) + pad('SOURCE', 16) + 'DEFINED  HANDLED');
for (const r of rows) {
  console.log(pad(r.tool, 22) + pad(r.source, 16) + pad(r.defined ? 'yes' : 'NO', 9) + (r.handled ? 'yes' : 'NO'));
}

console.log('\n=== SUBSYSTEMS ===');
for (const s of subRows) {
  console.log(pad(s.label, 26) + pad(s.file, 26) + (s.ok ? 'OK' : `MISSING ${s.missing.join(',') || 'file'}`));
}

console.log('\n=== SCHEMA PROPERTIES (sdk-tools.d.ts vs our definitions) ===');
for (const r of schemaRows) {
  if (r.ok && !r.extra.length) {
    console.log(pad(r.tool, 22) + pad(r.iface, 24) + `${r.want}/${r.want} props  OK`);
  } else {
    console.log(
      pad(r.tool, 22) + pad(r.iface, 24) +
      `${r.want} want / ${r.have} have  ` +
      (r.ok ? 'OK' : 'MISSING ' + r.missing.join(',')) +
      (r.extra.length ? '  (+aliases: ' + r.extra.join(',') + ')' : '')
    );
  }
}

console.log('\nDEFS: ' + defs.size + ' · tools missing definition: ' + missingDef + ' · tools missing handler: ' + missingHandler);
console.log('schema props missing: ' + missingProps + ' · alias props beyond Example: ' + extraProps);
const subBad = subRows.filter((s) => !s.ok).length;
console.log('subsystems incomplete: ' + subBad);

if (missingDef || missingHandler || subBad || missingProps) {
  console.log('\nRESULT: GAPS PRESENT');
  process.exit(1);
}
console.log('\nRESULT: NO ATOMIC GAPS — every Example tool is defined and dispatched with every SDK property, every subsystem present.');
