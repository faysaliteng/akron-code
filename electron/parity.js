'use strict';
// Akron Bot — Claude Code parity tools.
//
// Every tool in Claude Code's surface that is NOT a plain file/shell primitive
// lives here, so `tools.js` stays readable and the parity surface is one file:
//
//   LS  Search  TaskOutput  EnterPlanMode  EnterWorktree  ExitWorktree  Mcp
//   TaskCreate  TaskGet  TaskUpdate  TaskList      (shared task board)
//   TeamCreate  TeamDelete  SendMessage            (named teams)
//   Workflow                                       (JS DSL runtime)
//   CronCreate  CronDelete  CronList  ScheduleWakeup
//   Monitor  RemoteTrigger  PushNotification
//   StructuredOutput  PowerShell  Brief  SendUserFile  ConnectGitHub
//
// `handle(name, args, ctx)` returns:
//   null            -> not mine, let tools.js dispatch normally
//   string|object   -> the tool result
//
// so wiring is a single line in `runTool`.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const tasks = require('./tasks');
const scheduler = require('./scheduler');
const workflow = require('./workflow');

const HOME = os.homedir();
const MAX = 120000;
const AGENTS_DIR = path.join(HOME, '.autobot', 'agents');
const STRUCTURED_DIR = path.join(HOME, '.autobot', 'structured');

function truncate(s) {
  s = String(s == null ? '' : s);
  return s.length > MAX ? s.slice(0, MAX) + '\n…[truncated]' : s;
}
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function expand(p) { return String(p || '').replace(/^~(?=$|\/)/, HOME); }
function resolvePath(p, cwd) {
  const e = expand(p);
  return path.isAbsolute(e) ? path.normalize(e) : path.resolve(expand(cwd) || process.cwd(), e);
}
function num(v, def, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

// Run a command and collect output (used by PowerShell, ConnectGitHub, Search…).
function run(cmd, argv, opts = {}) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (extra) => {
      if (done) return;
      done = true;
      resolve(out + (extra || ''));
    };
    let child;
    try {
      child = spawn(cmd, argv, {
        cwd: opts.cwd || process.cwd(),
        env: { ...process.env, ...(opts.env || {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve(`Error: ${e.message}`);
    }
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (out.length > MAX) { out = out.slice(-MAX); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish(`\n[timed out after ${opts.timeoutMs || 60000}ms]`);
    }, opts.timeoutMs || 60000);
    if (opts.stdin != null) {
      try { child.stdin.write(opts.stdin); child.stdin.end(); } catch (_) {}
    }
    child.on('error', (e) => { clearTimeout(timer); finish(`\nError: ${e.message}`); });
    child.on('close', (code) => { clearTimeout(timer); finish(code ? `\n[exit ${code}]` : ''); });
  });
}

// ────────────────────────────────────────────────────────────
// LS / Search — Example's directory listing and content search
// ────────────────────────────────────────────────────────────
function listDir(args, ctx) {
  const target = resolvePath(args.path || args.dir || '.', ctx.cwd);
  let st;
  try { st = fs.statSync(target); } catch { return `Directory not found: ${target}`; }
  if (!st.isDirectory()) return `Not a directory: ${target}`;
  const showAll = args.all === true || args.hidden === true;
  let entries;
  try { entries = fs.readdirSync(target, { withFileTypes: true }); } catch (e) { return 'Error: ' + e.message; }
  if (!showAll) entries = entries.filter((e) => !e.name.startsWith('.'));
  if (args.recursive) {
    const out = [];
    const walk = (dir, depth) => {
      if (depth > 6 || out.length > 4000) return;
      let kids;
      try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const k of kids) {
        if (!showAll && k.name.startsWith('.')) continue;
        if (['node_modules', '.git', 'dist', 'build', '__pycache__', '.next'].includes(k.name)) continue;
        const p = path.join(dir, k.name);
        out.push((k.isDirectory() ? p + '/' : p));
        if (k.isDirectory()) walk(p, depth + 1);
      }
    };
    walk(target, 0);
    return `LS ${target} (recursive, ${out.length} entries):\n` + out.join('\n');
  }
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const lines = entries.map((e) => {
    let size = '';
    try {
      if (!e.isDirectory()) size = `  ${fs.statSync(path.join(target, e.name)).size}B`;
    } catch (_) {}
    return (e.isDirectory() ? '📁 ' : '📄 ') + e.name + (e.isDirectory() ? '/' : size);
  });
  return `LS ${target} (${entries.length} entries):\n` + (lines.join('\n') || '(empty)');
}

// Simple regex/walk grep. Deliberately has no shell dependency so it cannot be
// broken by quoting, and it skips binaries + heavy dirs.
function searchTree(args, ctx) {
  const pattern = String(args.pattern || args.query || '');
  if (!pattern) return 'Error: pattern required.';
  const root = resolvePath(args.path || args.dir || '.', ctx.cwd);
  let re;
  try {
    re = new RegExp(pattern, args.caseSensitive === false || args['-i'] ? 'i' : '');
  } catch (e) {
    return `Error: bad regex (${e.message}). Pass a plain string in \`pattern\` for a literal search.`;
  }
  const glob = String(args.glob || args.include || '');
  const globRe = glob ? new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$') : null;
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.next', '.cache', 'coverage', 'release', 'target', 'vendor']);
  const MAX_MATCHES = num(args.maxResults, 200, 1, 2000);
  const MAX_FILE = 2 * 1024 * 1024;
  const hits = [];
  let files = 0;

  const walk = (dir) => {
    if (hits.length >= MAX_MATCHES) return;
    let kids;
    try { kids = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const k of kids) {
      if (hits.length >= MAX_MATCHES) return;
      if (k.name.startsWith('.') && k.name !== '.env') continue;
      if (SKIP.has(k.name)) continue;
      const p = path.join(dir, k.name);
      if (k.isDirectory()) { walk(p); continue; }
      if (globRe && !globRe.test(k.name)) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (st.size > MAX_FILE) continue;
      let text;
      try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (text.includes('\u0000')) continue; // binary
      files++;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length && hits.length < MAX_MATCHES; i++) {
        if (re.test(lines[i])) {
          hits.push(`${path.relative(root, p) || p}:${i + 1}: ${lines[i].slice(0, 300)}`);
        }
      }
    }
  };
  walk(root);
  if (!hits.length) return `No matches for /${pattern}/ under ${root} (${files} files searched).`;
  return `SEARCH /${pattern}/ in ${root} — ${hits.length} hit(s) across ${files} files:\n` + hits.join('\n');
}

// ────────────────────────────────────────────────────────────
// PowerShell — Windows shell (mirrors Example's PowerShell tool). On non-Windows
// hosts it falls back to the user's shell so tests can run anywhere.
// ────────────────────────────────────────────────────────────
async function powershell(args, ctx) {
  const command = String(args.command || '');
  if (!command) return { content: 'Error: command required.', isError: true };
  const timeoutMs = num(args.timeout, 60000, 1000, 600000);
  const isWin = process.platform === 'win32';
  if (isWin) {
    const ps = ['-NoProfile', '-NonInteractive', '-Command', command];
    const out = await run(args.shell || 'powershell.exe', ps, { cwd: ctx.cwd, timeoutMs });
    return out.trim() || '(no output)';
  }
  const sh = require('./paths').defaultPosixShell();
  const out = await run(sh, ['-lc', command], { cwd: ctx.cwd, timeoutMs });
  return (out.trim() || '(no output)') + (args.note !== false ? `\n\n(PowerShell unavailable on this host — ran via ${sh}.)` : '');
}

// ────────────────────────────────────────────────────────────
// Shared task board (TaskCreate / TaskGet / TaskUpdate / TaskList)
// ────────────────────────────────────────────────────────────
function teamOf(args, ctx) {
  return args.team_name || args.team || (ctx && ctx.teamName) || 'default';
}

function taskCreate(args, ctx) {
  const r = tasks.createTask({
    team_name: teamOf(args, ctx),
    subject: args.subject,
    description: args.description,
    activeForm: args.activeForm || args.active_form,
    metadata: args.metadata,
    owner: args.owner,
    blocks: args.blocks,
    blockedBy: args.blockedBy || args.blocked_by,
  });
  if (!r.ok) return { content: 'Error: ' + r.error, isError: true };
  return `Created task #${r.task.id}: ${r.task.subject}`;
}

function taskGet(args, ctx) {
  const r = tasks.getTask({ team_name: teamOf(args, ctx), taskId: args.taskId || args.task_id || args.id });
  if (!r.ok) return { content: 'Error: ' + r.error, isError: true };
  const t = r.task;
  const lines = [
    `Task #${t.id} — ${t.subject}`,
    `Status: ${t.status}${t.owner ? '  Owner: ' + t.owner : ''}`,
    t.description ? `Description: ${t.description}` : null,
    t.blockedBy && t.blockedBy.length ? `Blocked by: ${t.blockedBy.join(', ')}` : null,
    t.blocks && t.blocks.length ? `Blocks: ${t.blocks.join(', ')}` : null,
    t.metadata && Object.keys(t.metadata).length ? `Metadata: ${JSON.stringify(t.metadata)}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

function taskUpdate(args, ctx) {
  const r = tasks.updateTask({ ...args, team_name: teamOf(args, ctx) });
  if (!r.ok) return { content: 'Error: ' + r.error, isError: true };
  if (r.deleted) return `Deleted task #${r.taskId}.`;
  return `Updated task #${r.task.id} (${r.task.status}${r.task.owner ? ', owner ' + r.task.owner : ''}).`;
}

function taskList(args, ctx) {
  const team = teamOf(args, ctx);
  const filter = args.status ? String(args.status) : '';
  if (filter) {
    const rows = tasks.readAllTasks(team).filter((t) => t.status === filter);
    if (!rows.length) return `Task board "${team}" has no ${filter} tasks.`;
    return `TASK BOARD (${team}) — ${filter}\n` + rows.map((t) =>
      `#${t.id} ${t.subject}${t.owner ? ' — @' + t.owner : ''}${t.description ? '\n    ' + String(t.description).slice(0, 300) : ''}`).join('\n');
  }
  return tasks.formatTaskList({ team_name: team });
}

// ────────────────────────────────────────────────────────────
// Named teams (TeamCreate / TeamDelete / SendMessage)
// ────────────────────────────────────────────────────────────
function teamCreate(args, ctx) {
  const name = args.team_name || args.name;
  if (!name) return { content: 'Error: team_name required.', isError: true };
  const members = (Array.isArray(args.members) ? args.members : []).map((m) => (typeof m === 'string' ? { name: m } : m)).filter((m) => m && m.name);
  let r = tasks.createTeam({ team_name: name, description: args.description });
  const existed = !r.ok && /already exists/i.test(r.error || '');
  if (!r.ok && !existed) return { content: 'Error: ' + r.error, isError: true };
  const added = [];
  for (const m of members) {
    try {
      tasks.addMember(name, { name: m.name, role: m.role || 'teammate', model: m.model });
      added.push(m.name);
    } catch (e) {
      added.push(`${m.name} (${e.message})`);
    }
  }
  const t = tasks.getTeam(name) || r.team;
  const roster = (t.members || []).map((m) => `${m.name} [${m.role}${m.tier ? '·' + m.tier : ''}]`).join(', ');
  return `Created team "${t.name}" — ${roster}\nTeams live in ~/.autobot/teams/${t.name}/; address members by name with SendMessage or spawn them with Task/Agent.${added.length ? '\nAdded: ' + added.join(', ') : ''}`;
}

function teamDelete(args, ctx) {
  const name = args.team_name || args.name;
  if (!name) return { content: 'Error: team_name required.', isError: true };
  const r = tasks.deleteTeam({ team_name: name, force: args.force === true });
  if (!r.ok) return { content: 'Error: ' + r.error, isError: true };
  return `Archived team "${name}" (config + task board moved to ~/.autobot/teams-archive/).`;
}

function sendMessage(args, ctx) {
  const to = String(args.to || args.name || args.recipient || '');
  const message = String(args.message || args.text || args.content || '');
  if (!to) return { content: 'Error: `to` required (a teammate name, or "team-lead").', isError: true };
  if (!message && args.type !== 'shutdown_request' && args.shutdown !== true) {
    return { content: 'Error: `message` required.', isError: true };
  }
  const team = teamOf(args, ctx);
  const from = args.from || (ctx && ctx.agentName) || 'team-lead';
  const shutdown = args.type === 'shutdown_request' || args.shutdown === true;
  const r = tasks.sendMessage({
    team_name: team,
    to,
    from,
    message: message || (shutdown ? 'Shutdown requested.' : ''),
    summary: args.summary,
  });
  if (!r.ok) return { content: 'Error: ' + r.error, isError: true };
  const liveDelivered = typeof tasks.signalLiveMember === 'function'
    ? tasks.signalLiveMember(team, to, { shutdown, wake: !shutdown, from, message })
    : false;
  return `Message queued for "${to}" in team "${team}"${args.summary ? ' — ' + args.summary : ''}${liveDelivered ? ' (delivered to active in-process teammate)' : ''}.`;
}

// ────────────────────────────────────────────────────────────
// StructuredOutput — the schema contract that makes sub-agents return JSON
// ────────────────────────────────────────────────────────────
function structuredOutput(args, ctx) {
  const data = args.data !== undefined ? args.data : (args.output !== undefined ? args.output : args);
  try {
    const sessionId = (ctx && ctx.sessionId) || `structured-${Date.now()}`;
    ensureDir(STRUCTURED_DIR);
    fs.writeFileSync(path.join(STRUCTURED_DIR, sessionId + '.json'), JSON.stringify(data, null, 2), 'utf8');
  } catch (_) { /* persisting is a convenience; the return value is the contract */ }
  if (typeof ctx.setStructuredOutput === 'function') {
    try { ctx.setStructuredOutput(data); } catch (_) {}
  }
  return JSON.stringify(data);
}

// ────────────────────────────────────────────────────────────
// Workflow — the JS DSL runtime (agent / parallel / pipeline / phase)
// ────────────────────────────────────────────────────────────
async function workflowAgent(a, ctx) {
  if (ctx.signal && ctx.signal.aborted) throw new Error('aborted');
  const router = require('./orch-router');
  const swarmMod = require('./swarm');
  const prompt = String(a.prompt || '');
  const content = a.schema
    ? `${prompt}\n\nReply with ONLY a JSON value matching this JSON Schema (no prose, no fence):\n${JSON.stringify(a.schema)}`
    : prompt;
  const sub = { messages: [{ role: 'user', content }], cwd: a.cwd || ctx.cwd, signal: ctx.signal };
  const poolOrch = ctx.poolOrchestrator;
  const role = router.normalizeRole(a.role) || (a.tier ? router.tierToRole(a.tier) : null) || (a.model && router.isModelAlias(a.model) ? router.aliasRole(a.model) : null);
  const model = a.model && !router.isModelAlias(a.model) ? String(a.model) : null;
  if (poolOrch && (role || model)) {
    const scoped = router.orchestratorFor(poolOrch, role || 'coder', ctx.provider, { preferModel: model || undefined });
    if (scoped) { sub.orchestrator = scoped; sub.provider = scoped.providers[0]; }
  } else if ((role || model) && Array.isArray(ctx.agentRoster) && ctx.agentRoster.length) {
    const tier = a.tier || (role ? router.ROLE_TIER[role] : 'heavy');
    const base = (model && ctx.agentRoster.find((r) => r.model === model)) || swarmMod.pickProvider(ctx.agentRoster, tier);
    if (base) {
      sub.provider = model && base.model !== model ? { ...base, model } : base;
      sub.orchestrator = { enabled: true, providers: [sub.provider].concat(ctx.agentRoster.filter((r) => r !== base)), activeIndex: 0, role: 'pinned' };
    }
  }
  const out = await ctx.runAgent(sub);
  const list = Array.isArray(out) ? out : [];
  const last = [...list].reverse().find((m) => m && m.role === 'assistant' && m.content);
  const text = typeof out === 'string' ? out : (last ? String(last.content) : '');
  if (!a.schema) return text;
  const parsed = swarmMod.extractJSON(text);
  if (parsed != null) return parsed;
  try { return JSON.parse(text.trim()); } catch (_) { return text; }
}

async function runWorkflowTool(args, ctx) {
  if (!ctx.runAgent) return { content: 'Workflow unavailable (no agent runner wired).', isError: true };
  try {
    const out = await workflow.runWorkflow({
      script: args.script,
      scriptPath: args.scriptPath || args.script_path,
      name: args.name,
      args: args.args,
      resumeFromRunId: args.resumeFromRunId || args.resume_from_run_id,
      // workflow.js calls agent({prompt, model, tier, role, schema, cwd}) and
      // expects the agent's final TEXT back; ctx.runAgent takes {messages,
      // provider} and returns the transcript. Adapt between the two — before
      // this every Workflow agent ran with an empty message list.
      runAgent: (a) => workflowAgent(a || {}, ctx),
      emit: ctx.emit || (() => {}),
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
    if (out.status !== 'completed') {
      return { content: `Workflow ${out.status}${out.error ? ' — ' + out.error : ''}\nscriptPath: ${out.scriptPath || '—'}`, isError: out.status === 'error' };
    }
    const head = [
      `WORKFLOW COMPLETE — ${out.runId} (${Math.round((out.durationMs || 0) / 1000)}s)`,
      `script: ${out.scriptPath || '—'}`,
      `agents: ${out.agentCalls} · cache hits: ${out.cacheHits}`,
      out.phases && out.phases.length ? `phases: ${out.phases.map((p) => (p && typeof p === 'object' ? (p.name || p.title || JSON.stringify(p)) : String(p))).join(' → ')}` : null,
      out.output != null ? `output: ${typeof out.output === 'string' ? out.output : JSON.stringify(out.output, null, 2)}` : null,
      `result:\n${typeof out.result === 'string' ? out.result : JSON.stringify(out.result, null, 2)}`,
    ].filter(Boolean);
    return head.join('\n');
  } catch (e) {
    return { content: 'Workflow error: ' + (e && e.message ? e.message : String(e)), isError: true };
  }
}

// ────────────────────────────────────────────────────────────
// TaskOutput — read a background agent's output file
// ────────────────────────────────────────────────────────────
async function taskOutput(args, ctx) {
  const want = String(args.task_id || args.taskId || args.id || args.name || args.agentId || '');
  if (!want) return { content: 'Error: task_id (or agent name) required.', isError: true };
  // 0. live background job (shell / agent / monitor) — supports block+timeout
  const bg = getBg();
  if (bg) {
    const job = bg.getJob(want);
    if (job) {
      const block = args.block === true;
      const timeout = num(args.timeout, 30000, 0, 600000);
      const waited = block ? await bg.waitFor(want, { block: true, timeout }) : job;
      const v = bg.view(waited || job, { full: false });
      const head = `JOB ${v.id} [${v.kind}] ${v.status} — ${v.elapsedSeconds}s${v.label ? ' — ' + v.label : ''}`;
      return `${head}\n\n${truncate(v.output || '(no output yet)')}`;
    }
  }
  // 1. an explicit path
  const direct = args.outputFile || args.output_file || args.path;
  const candidates = [];
  if (direct) candidates.push(resolvePath(direct, ctx.cwd));
  // 2. a task-board id
  candidates.push(path.join(tasks.TASKS_DIR, String(teamOf(args, ctx)), String(want) + '.json'));
  // 3. an agent output file
  try {
    if (fs.existsSync(AGENTS_DIR)) {
      for (const f of fs.readdirSync(AGENTS_DIR)) {
        if (f.includes(want)) candidates.push(path.join(AGENTS_DIR, f));
      }
    }
  } catch (_) {}
  // 4. registry lookup from the runner
  if (typeof ctx.getTaskOutput === 'function') {
    const live = ctx.getTaskOutput(want);
    if (live != null) return truncate(live);
  }
  for (const c of candidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return truncate(fs.readFileSync(c, 'utf8'));
    } catch (_) {}
  }
  return { content: `No output found for task "${want}". Looked in ${candidates.length} location(s) incl. ${AGENTS_DIR}.`, isError: true };
}

function getBg() {
  try { return require('./bg'); } catch (_) { return null; }
}

// ────────────────────────────────────────────────────────────
// Plan mode (EnterPlanMode) + worktrees
// ────────────────────────────────────────────────────────────
function enterPlanMode(args, ctx) {
  if (typeof ctx.setPermissionMode === 'function') {
    ctx.setPermissionMode('plan');
  }
  const note = args.reason ? ` Reason: ${args.reason}` : '';
  return `Entered plan mode.${note}

In plan mode you may only READ and write to the plan file. Do not modify source.
Work through the phases, then finish the turn with ExitPlanMode (or AskUserQuestion if you genuinely need a decision).`;
}

async function enterWorktree(args, ctx) {
  const name = String(args.name || args.path || '').trim();
  if (!name) return { content: 'Error: name (or path) required.', isError: true };
  if (typeof ctx.enterWorktree === 'function') {
    const r = await ctx.enterWorktree(name);
    return typeof r === 'string' ? r : `Entered worktree "${name}" at ${(r && r.path) || '?'}.`;
  }
  // Fallback: create a real git worktree beside the repo.
  const cwd = ctx.cwd || process.cwd();
  const target = path.isAbsolute(name) ? name : path.join(path.dirname(cwd), String(name).replace(/[^\w.-]+/g, '-'));
  const out = await run('git', ['worktree', 'add', target, '-b', String(name).replace(/[^\w.-]+/g, '-')], { cwd, timeoutMs: 60000 });
  if (/fatal|error/i.test(out)) return { content: `Could not create worktree:\n${out.trim()}`, isError: true };
  if (typeof ctx.setCwd === 'function') ctx.setCwd(target);
  return `Created worktree at ${target} and switched the working directory there.\n${out.trim()}`;
}

async function exitWorktree(args, ctx) {
  const action = String(args.action || 'keep');
  if (typeof ctx.exitWorktree === 'function') {
    const r = await ctx.exitWorktree(action, args.discard_changes === true);
    return typeof r === 'string' ? r : `Exited worktree (${action}).`;
  }
  const cwd = ctx.cwd || process.cwd();
  const parent = path.dirname(cwd);
  if (typeof ctx.setCwd === 'function') ctx.setCwd(parent);
  if (action === 'remove') {
    const out = await run('git', ['worktree', 'remove', cwd, ...(args.discard_changes ? ['--force'] : [])], { cwd: parent, timeoutMs: 60000 });
    return `Switched back to ${parent} and removed the worktree.\n${out.trim()}`;
  }
  return `Kept the worktree at ${cwd} and switched back to ${parent}.`;
}

// ────────────────────────────────────────────────────────────
// Mcp — call any connected MCP server's tool by name
// ────────────────────────────────────────────────────────────
async function mcpTool(args, ctx) {
  const tool = String(args.tool || args.name || '');
  const server = args.server || args.serverId || '';
  if (!tool) return { content: 'Error: tool required (the MCP tool name).', isError: true };
  if (typeof ctx.mcpCallTool === 'function') {
    const r = await ctx.mcpCallTool(server, tool, args.arguments || args.args || args.input || {});
    return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  }
  const full = server ? `mcp__${server}__${tool}` : tool;
  if (typeof ctx.callTool === 'function') {
    const r = await ctx.callTool(full, args.arguments || args.args || {});
    return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  }
  return { content: 'MCP dispatch unavailable (no MCP client wired into this run).', isError: true };
}

// ────────────────────────────────────────────────────────────
// Brief / SendUserFile / ConnectGitHub
// ────────────────────────────────────────────────────────────
function brief(args, ctx) {
  const text = String(args.summary || args.brief || args.message || args.text || '');
  if (!text) return { content: 'Error: summary required.', isError: true };
  if (typeof ctx.sendUserMessage === 'function') ctx.sendUserMessage(text);
  if (typeof ctx.emit === 'function') ctx.emit({ type: 'brief', text });
  return 'Brief delivered to the user.';
}

function sendUserFile(args, ctx) {
  const p = args.path || args.file || args.filePath || '';
  if (!p) return { content: 'Error: path required.', isError: true };
  const abs = resolvePath(p, ctx.cwd);
  let st;
  try { st = fs.statSync(abs); } catch { return { content: `File not found: ${abs}`, isError: true }; }
  if (st.isDirectory()) return { content: `${abs} is a directory — send a file, or zip it first.`, isError: true };
  const name = args.name || path.basename(abs);
  if (typeof ctx.emit === 'function') {
    ctx.emit({ type: 'file', path: abs, name, size: st.size, caption: args.caption || args.message || '' });
  }
  if (typeof ctx.sendUserMessage === 'function') {
    ctx.sendUserMessage(`${args.caption ? args.caption + '\n' : ''}📎 ${name} (${st.size} bytes) — ${abs}`);
  }
  return `Sent ${name} (${st.size} bytes) to the user: ${abs}`;
}

async function connectGitHub(args, ctx) {
  const what = String(args.action || args.command || args.query || 'status');
  if (what === 'status' || what === 'auth') {
    const out = await run('gh', ['auth', 'status'], { cwd: ctx.cwd, timeoutMs: 20000 });
    if (/not logged|command not found|Error:/i.test(out)) {
      return `GitHub CLI is not authenticated. Run \`gh auth login\` in a terminal, then retry.\n\n${out.trim()}`;
    }
    return out.trim() || 'gh is authenticated.';
  }
  if (what === 'repo' || what === 'repos' || what === 'list') {
    const out = await run('gh', ['repo', 'list', '--limit', String(num(args.limit, 30, 1, 200))], { cwd: ctx.cwd, timeoutMs: 30000 });
    return out.trim() || '(no repos)';
  }
  if (what === 'clone') {
    const repo = String(args.repo || args.target || '');
    if (!repo) return { content: 'Error: repo required for clone.', isError: true };
    const out = await run('gh', ['repo', 'clone', repo], { cwd: ctx.cwd, timeoutMs: 300000 });
    return out.trim() || `Cloned ${repo}.`;
  }
  if (what === 'pr' || what === 'create-pr') {
    const argv = ['pr', 'create', '--fill'];
    if (args.title) argv.push('--title', String(args.title));
    if (args.body) argv.push('--body', String(args.body));
    if (args.base) argv.push('--base', String(args.base));
    const out = await run('gh', argv, { cwd: ctx.cwd, timeoutMs: 120000 });
    return out.trim() || 'PR created.';
  }
  if (what === 'issue' || what === 'create-issue') {
    const argv = ['issue', 'create', '--title', String(args.title || 'Issue'), '--body', String(args.body || args.description || '')];
    const out = await run('gh', argv, { cwd: ctx.cwd, timeoutMs: 60000 });
    return out.trim() || 'Issue created.';
  }
  if (what === 'run' && args.command) {
    const out = await run('gh', String(args.command).split(/\s+/), { cwd: ctx.cwd, timeoutMs: num(args.timeout, 120000, 1000, 600000) });
    return out.trim() || '(no output)';
  }
  return `Unknown GitHub action "${what}". Supported: status, repo list, clone, pr, issue, run.`;
}

// ────────────────────────────────────────────────────────────
// Cron / wakeup / monitor / push — all ride on the extended scheduler
// ────────────────────────────────────────────────────────────
function cronCreate(args, ctx) {
  const cron = String(args.cron || args.schedule || '');
  if (!cron) return { content: 'Error: cron (5-field) required.', isError: true };
  const prompt = String(args.prompt || args.task || '');
  if (!prompt) return { content: 'Error: prompt required.', isError: true };
  try {
    const r = scheduler.createCron({
      cron,
      prompt,
      durable: args.durable === true,
      recurring: args.recurring !== false,
      name: args.name,
      cwd: ctx.cwd,
    });
    if (!r || r.ok === false) return { content: 'Error: ' + ((r && r.error) || 'could not create cron'), isError: true };
    const t = r.task;
    const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : '—';
    return `Created cron task ${t.id} "${t.name}" — next run ${next}${args.durable ? ' (durable: mirrored to .claude/scheduled_tasks.json)' : ''}.`;
  } catch (e) {
    return { content: 'Error: ' + e.message, isError: true };
  }
}

function cronList() {
  const all = scheduler.list() || [];
  const crones = all.filter((t) => t.cron);
  if (!crones.length) return 'CRON TASKS: (none)';
  return 'CRON TASKS:\n' + crones.map((t) => {
    const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : '—';
    return `- ${t.id} ${t.cron}${t.recurring === false ? ' (once)' : ''} ${t.enabled === false ? '(disabled)' : 'next: ' + next}\n    ${String(t.prompt).slice(0, 160)}`;
  }).join('\n');
}

function cronDelete(args) {
  const id = String(args.id || args.taskId || args.task_id || '');
  if (!id) return { content: 'Error: id required.', isError: true };
  const r = scheduler.remove(id, { purge: true });
  if (!r || r.ok === false) return { content: `No cron task "${id}"${r && r.error ? ' — ' + r.error : ''}.`, isError: true };
  return `Deleted cron task ${id}.`;
}

function scheduleWakeup(args, ctx) {
  const delay = num(args.delaySeconds || args.delay_seconds || args.delay, 300, 60, 3600);
  const prompt = String(args.prompt || args.task || '');
  if (!prompt) return { content: 'Error: prompt required.', isError: true };
  try {
    const r = scheduler.createWakeup({
      delaySeconds: delay,
      prompt,
      reason: args.reason,
      sentinel: args.sentinel,
      cwd: ctx.cwd,
    });
    if (!r || r.ok === false) return { content: 'Error: ' + ((r && r.error) || 'could not schedule wakeup'), isError: true };
    return `Wakeup scheduled in ${delay}s (task ${r.task.id})${args.reason ? ' — ' + args.reason : ''}.`;
  } catch (e) {
    return { content: 'Error: ' + e.message, isError: true };
  }
}

const TRIGGERS_FILE = path.join(HOME, '.autobot', 'triggers.json');
function loadTriggers() {
  try { return JSON.parse(fs.readFileSync(TRIGGERS_FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function saveTriggers(map) {
  ensureDir(path.dirname(TRIGGERS_FILE));
  fs.writeFileSync(TRIGGERS_FILE, JSON.stringify(map, null, 2));
}

async function fireTrigger(def) {
  const url = String(def.url || '');
  if (!url) return { content: 'Error: trigger has no url.', isError: true };
  const method = String(def.method || 'POST').toUpperCase();
  const body = def.body != null ? (typeof def.body === 'string' ? def.body : JSON.stringify(def.body)) : undefined;
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', ...(def.headers || {}) },
    body: method === 'GET' || method === 'HEAD' ? undefined : body,
  });
  const text = await res.text();
  return `Remote trigger ${method} ${url} -> ${res.status} ${res.statusText}\n${truncate(text)}`;
}

async function remoteTrigger(args, ctx) {
  const map = loadTriggers();
  // Inline one-off URL takes precedence (legacy + convenience).
  if (args.url) return fireTrigger(args);

  const action = String(args.action || 'run').toLowerCase();
  const id = args.trigger_id || args.id;

  if (action === 'list') {
    const ids = Object.keys(map);
    if (!ids.length) return '(no remote triggers defined)';
    return 'TRIGGERS:\n' + ids.map((k) => `- ${k}: ${map[k].method || 'POST'} ${map[k].url}${map[k].description ? ' — ' + map[k].description : ''}`).join('\n');
  }
  if (action === 'get') {
    if (!id || !map[id]) return { content: `No trigger "${id}".`, isError: true };
    return truncate(JSON.stringify(map[id], null, 2));
  }
  if (action === 'create' || action === 'update') {
    const def = args.body != null ? (typeof args.body === 'string' ? JSON.parse(args.body) : args.body) : {};
    const key = String(id || def.id || def.name || `trigger_${Date.now().toString(36)}`);
    map[key] = { ...(map[key] || {}), ...def, id: key };
    saveTriggers(map);
    return `Trigger "${key}" ${action === 'create' ? 'created' : 'updated'}: ${map[key].method || 'POST'} ${map[key].url || '(no url)'}.`;
  }
  // action === 'run'
  if (id && map[id]) return fireTrigger(map[id]);
  const def = args.body != null ? (typeof args.body === 'string' ? JSON.parse(args.body) : args.body) : {};
  if (def && def.url) return fireTrigger(def);
  return { content: `No trigger "${id || '(none)'}" to run. Use action:"list" to see triggers, or pass an inline url.`, isError: true };
}

// Monitor: run a long-lived command, surface each stdout/stderr line as an
// event. Routed through the shared background-job registry so the same job can
// be polled with TaskOutput and stopped with TaskStop/KillShell.
async function monitor(args, ctx) {
  const command = String(args.command || '');
  if (!command) return { content: 'Error: command required.', isError: true };
  const timeoutMs = num(args.timeout_ms || args.timeoutMs, 300000, 1000, 3600000);
  const description = args.description || command.slice(0, 60);
  const persistent = args.persistent === true;
  const emit = ctx.emit || (() => {});
  const lines = [];
  const bg = getBg();

  emit({ type: 'monitor', phase: 'start', description, command, persistent });

  // Fallback (no bg module): stream synchronously like before.
  if (!bg) {
    return await new Promise((resolve) => {
      let buf = '';
      let child;
      const done = (reason) => {
        try { child && child.kill('SIGKILL'); } catch (_) {}
        emit({ type: 'monitor', phase: 'done', description, reason, lines: lines.length });
        resolve(`Monitor "${description}" finished (${reason}) — ${lines.length} event line(s)${lines.length ? ':\n' + lines.slice(-200).join('\n') : ''}`);
      };
      try {
        const shFile = process.platform === 'win32' ? 'powershell.exe' : require('./paths').defaultPosixShell();
        const shArgs = process.platform === 'win32'
          ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(command)]
          : ['-lc', command];
        child = spawn(shFile, shArgs, { cwd: ctx.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      }
      catch (e) { return resolve({ content: 'Monitor failed: ' + e.message, isError: true }); }
      const timer = setTimeout(() => done(`timeout after ${Math.round(timeoutMs / 1000)}s`), timeoutMs);
      const onLine = (line) => { if (!line.trim()) return; lines.push(line); emit({ type: 'monitor', phase: 'line', description, line }); };
      child.stdout.on('data', (d) => { buf += d.toString(); let i; while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
      child.stderr.on('data', (d) => onLine('[stderr] ' + d.toString().trim()));
      child.on('error', (e) => { clearTimeout(timer); resolve({ content: 'Monitor failed: ' + e.message, isError: true }); });
      child.on('close', (code) => { clearTimeout(timer); if (buf.trim()) onLine(buf); done(`exit ${code}`); });
    });
  }

  const job = bg.startMonitor({
    command,
    description,
    timeoutMs,
    persistent,
    cwd: ctx.cwd,
    onLine: (line) => { lines.push(line); emit({ type: 'monitor', phase: 'line', description, line }); },
    onExit: (j) => emit({ type: 'monitor', phase: 'done', description, status: j && j.status, lines: lines.length }),
  });
  if (!job) return { content: 'Monitor failed to start.', isError: true };

  if (persistent) {
    return `Monitor "${description}" started (id ${job.id}) — streaming in the background. Stop with TaskStop {task_id:"${job.id}"} or KillShell {shell_id:"${job.id}"}; poll with TaskOutput {task_id:"${job.id}"}.`;
  }
  await bg.waitFor(job.id, { block: true, timeout: Math.min(timeoutMs + 2000, 600000) });
  const v = bg.view(job, { full: false });
  return `Monitor "${description}" finished (${v.status}) — ${lines.length} event line(s)${lines.length ? ':\n' + lines.slice(-200).join('\n') : ''}`;
}

function pushNotification(args, ctx) {
  const message = String(args.message != null ? args.message : (args.body || args.text || ''));
  const title = String(args.title || 'Akron Code');
  const status = args.status || 'proactive';
  if (!message && !args.title) return { content: 'Error: message required.', isError: true };
  if (typeof ctx.notify === 'function') {
    try { ctx.notify({ title, body: message }); } catch (_) {}
  }
  if (typeof ctx.emit === 'function') ctx.emit({ type: 'notification', title, body: message, status });
  if (typeof ctx.sendUserMessage === 'function' && !ctx.suppressUserMessage) ctx.sendUserMessage(`🔔 ${title}: ${message}`);
  return `Notification pushed (${status}): ${title} — ${message}`;
}

// ────────────────────────────────────────────────────────────
// Router — one entry point for every parity tool
// ────────────────────────────────────────────────────────────
const HANDLERS = {
  LS: listDir,
  Search: searchTree,
  Grep: null, // (Grep already exists in tools.js — do not shadow it)
  TaskCreate: taskCreate,
  TaskGet: taskGet,
  TaskUpdate: taskUpdate,
  TaskList: taskList,
  TeamCreate: teamCreate,
  TeamDelete: teamDelete,
  SendMessage: sendMessage,
  Workflow: runWorkflowTool,
  TaskOutput: taskOutput,
  StructuredOutput: structuredOutput,
  EnterPlanMode: enterPlanMode,
  EnterWorktree: enterWorktree,
  ExitWorktree: exitWorktree,
  Mcp: mcpTool,
  PowerShell: powershell,
  Brief: brief,
  SendUserFile: sendUserFile,
  ConnectGitHub: connectGitHub,
  CronCreate: cronCreate,
  CronList: cronList,
  CronDelete: cronDelete,
  ScheduleWakeup: scheduleWakeup,
  RemoteTrigger: remoteTrigger,
  Monitor: monitor,
  PushNotification: pushNotification,
};
delete HANDLERS.Grep;

async function handle(name, args, ctx) {
  const fn = HANDLERS[name];
  if (!fn) return null;
  try {
    const r = await fn(args || {}, ctx || {});
    if (r == null) return null;
    if (typeof r === 'string') return { content: r };
    if (r && typeof r === 'object' && (r.content !== undefined || r.isError)) return r;
    return { content: typeof r === 'string' ? r : JSON.stringify(r, null, 2) };
  } catch (e) {
    return { content: `${name} error: ${e && e.message ? e.message : String(e)}`, isError: true };
  }
}

module.exports = { handle, HANDLERS, NAMES: Object.keys(HANDLERS), listDir, searchTree, runWorkflowTool };
