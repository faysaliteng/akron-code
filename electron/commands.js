'use strict';
// Custom slash commands — Example's `.claude/commands/**/*.md`.
//
// A command file is plain markdown. Its path relative to the commands dir is
// the command name, so `.claude/commands/db/migrate.md` → `/db:migrate`.
// Supports the same substitutions Claude Code does:
//
//   $ARGUMENTS        everything after the command name
//   $1 .. $9          positional arguments (whitespace-split)
//   !`cmd`            run a bash command and inline its stdout
//   @path/to/file     inline the file's contents
//
// Frontmatter may set `description`, `argument-hint`, `allowed-tools`,
// `model`, `disable-model-invocation`. Commands also compose: a command body
// may reference another `/name` and it will be expanded one level deep.

const path = require('path');
const fs = require('fs');
const cc = require('./claudeconfig');

function commandDirs(cwd) {
  const dirs = [{ dir: path.join(cc.CONFIG_DIR, 'commands'), source: 'user' }];
  if (cwd) dirs.push({ dir: path.join(cwd, '.claude', 'commands'), source: 'project' });
  dirs.push({ dir: path.join(cc.AUTOBOT_DIR, 'commands'), source: 'autobot' });
  return dirs;
}

// `db/migrate.md` → `db:migrate`; `review.md` → `review`.
function nameFromRel(baseDir, file) {
  let rel = path.relative(baseDir, file).replace(/\\/g, '/');
  rel = rel.replace(/\.md$/i, '');
  return rel.split('/').filter(Boolean).join(':');
}

function parseCommand(file, baseDir, source) {
  const text = cc.readText(file);
  if (text == null) return null;
  const { data, body } = cc.parseFrontmatter(text);
  const name = nameFromRel(baseDir, file);
  if (!name) return null;
  const tools = Array.isArray(data['allowed-tools'])
    ? data['allowed-tools']
    : (typeof data['allowed-tools'] === 'string' && data['allowed-tools'].trim()
      ? data['allowed-tools'].split(',').map((s) => s.trim()).filter(Boolean) : null);
  return {
    name,
    description: data.description || '',
    argumentHint: data['argument-hint'] || '',
    allowedTools: tools,
    model: data.model || null,
    disableModelInvocation: data['disable-model-invocation'] === true || data['disable-model-invocation'] === 'true',
    body,
    file,
    source,
  };
}

let _cache = { cwd: null, at: 0, list: [] };
const CACHE_MS = 2000;

function discover(cwd, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _cache.cwd === (cwd || '') && now - _cache.at < CACHE_MS) return _cache.list;
  const byName = new Map();
  for (const { dir, source } of commandDirs(cwd)) {
    for (const file of cc.listMarkdown(dir, { recursive: true, maxDepth: 6 })) {
      const cmd = parseCommand(file, dir, source);
      if (!cmd) continue;
      byName.set(cmd.name.toLowerCase(), cmd); // later scope wins
    }
  }
  const list = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  _cache = { cwd: cwd || '', at: now, list };
  return list;
}

// Built-in skill commands. Claude Code 2.1.x ships these inside the binary as
// skills (class `skill`) rather than as `.claude/commands` files, so there is
// nothing on disk to discover. Each one expands to a prompt exactly like a file
// command does — which is all Claude Code does with them too. A real
// `.claude/commands/<name>.md` always wins (checked first).
const SKILL_PROMPTS = {
  'claude-api': {
    description: 'Reference for the Example API: models, messages, tools, streaming, and token limits.',
    body: [
      'Use the Example API reference in this conversation to answer the question that was asked.',
      '',
      'Ground the answer in these facts and say when something is version-dependent:',
      '- Endpoint: `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`, `anthropic-version: 2023-06-01`, `content-type: application/json`.',
      '- Body: `model`, `max_tokens` (required), `messages[]`, optional `system`, `tools`, `tool_choice`, `stream`, `thinking`.',
      '- Streaming: `stream: true` → SSE events `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`.',
      '- Tool use: model returns `stop_reason: "tool_use"` with `tool_use` blocks; reply with `tool_result` blocks in a `user` message.',
      '- Prompt caching: `cache_control: {type: "ephemeral"}` on the last stable blocks; cache reads are billed at a discount.',
      '- Errors: 400 `invalid_request_error`, 401 auth, 413 too large, 429 `rate_limit_error` (honour `retry-after`), 500/529 overloaded → retry with backoff.',
      '',
      'If the user asked to write code, produce runnable code and show how to run it. Arguments given: $ARGUMENTS',
    ].join('\n'),
  },
  'fewer-permission-prompts': {
    description: 'Scan transcripts for common read-only tool calls and add a prioritised allowlist to project .claude/settings.json.',
    body: [
      'Reduce permission prompts for this project.',
      '',
      '1. Read recent transcripts from `~/.claude/projects/**/*.jsonl` (fall back to `~/.autobot` history) and count the Bash commands and MCP tool calls that were read-only and repeated.',
      '2. Keep only calls that are provably side-effect free (listing, reading, version checks, `git status`/`diff`/`log`, test runners with no write flags). Never allowlist anything that deletes, pushes, installs, or sends data.',
      '3. Write the allowlist into `.claude/settings.json` under `permissions.allow`, using Claude Code permission syntax (`Bash(git status:*)`, `Read(//path/**)`, `mcp__server__tool`). Merge with what is already there; never drop existing rules.',
      '4. Show the diff you applied and explain each rule in one line.',
      '',
      'Project folder: the current working directory. Extra arguments: $ARGUMENTS',
    ].join('\n'),
  },
  'update-config': {
    description: 'Configure the harness through settings.json: permissions, env vars, and hooks.',
    body: [
      'Change Akron Code / Claude Code configuration using `settings.json` (project `.claude/settings.json`, or `settings.local.json` for machine-local overrides).',
      '',
      'Rules:',
      '- Automated behaviours ("from now on when X", "each time X", "before/after X") require **hooks** in settings.json — memory files cannot enforce them.',
      '- Permission changes go under `permissions.allow` / `permissions.deny` / `permissions.ask`. Deny always wins.',
      '- Environment variables go under `env`.',
      '- Read the current file first, merge, and preserve unknown keys. Never reformat unrelated sections.',
      '- Explain each edit and how to undo it.',
      '',
      'Requested change: $ARGUMENTS',
    ].join('\n'),
  },
  run: {
    description: "Launch and drive this project's app to see a change working.",
    body: [
      "Launch this project's app and drive it to verify the change works.",
      '',
      '1. Detect the project type (package.json scripts, Makefile, Cargo.toml, pyproject.toml) and pick the dev/start command.',
      '2. Start it in the background (`shell_run`), wait for the port to accept connections, and read the logs for errors.',
      '3. If it is a web app, open the URL in the browser pane and interact with the page to exercise the change. For a CLI, run the entry point with representative arguments.',
      '4. Report the command used, the URL/port, what you observed, and any error output. Leave the process running and tell the user how to stop it.',
      '',
      'Focus: $ARGUMENTS',
    ].join('\n'),
  },
  'run-skill-generator': {
    description: 'Author or improve the run-<unit> skill for this project.',
    body: [
      'Create or improve a project skill that teaches an agent how to run one unit of this codebase (a service, a package, an app).',
      '',
      '1. Inspect the repo layout and identify the units that are non-obvious to start, test, or drive.',
      '2. Write `.claude/skills/run-<unit>/SKILL.md` with frontmatter `name`, `description` (when to use it), and a body containing: exact install command, exact run command, port/URL, how to verify success, how to read logs, and common failure modes with fixes.',
      '3. Prefer verified commands — run each one before writing it down, and drop any that fail.',
      '4. List the files you created and the commands you verified.',
      '',
      'Unit to cover: $ARGUMENTS',
    ].join('\n'),
  },
  batch: {
    description: 'Research and plan a large change, then execute it in parallel across isolated worktree agents that each open a PR.',
    body: [
      'Plan and execute a large-scale change in parallel.',
      '',
      '1. **Research**: map every call site the change touches; write the plan to `PLAN.md` with numbered work items that do not conflict.',
      '2. **Partition**: group the items into 5-30 independent chunks, each confined to a disjoint set of files.',
      '3. **Execute**: for each chunk, create a git worktree on its own branch and dispatch a sub-agent with that chunk as its brief. Run them concurrently. Chunks are independent — if two would touch the same file, merge them into one chunk.',
      '4. **Integrate**: review each branch, run the test suite against a merged tree, fix conflicts, and open one pull request per branch (or squash into a single PR if the user prefers).',
      '5. Report the plan, the branch list, test results, and the PR links.',
      '',
      'Change to batch: $ARGUMENTS',
    ].join('\n'),
  },
  'keybindings-help': {
    description: 'Explain or change keyboard shortcuts.',
    body: [
      'Help with keyboard shortcuts in Akron Code.',
      '',
      'Known shortcuts: `⌘K` command palette, `⌘,` settings, `/` at the start of the composer opens the slash menu, `Esc` closes menus, `⌘Enter` sends, `Shift+Enter` newline, `⌘↩` while streaming queues the next message instead of dropping it.',
      'Shortcuts are configured in Settings → Shortcuts (stored with the app, not in a JSON file).',
      '',
      'The user asked: $ARGUMENTS',
    ].join('\n'),
  },
  'claude-in-chrome': {
    description: 'Automate a Chrome browser: click, fill forms, screenshot, read console, navigate tabs.',
    body: [
      'Drive the user\'s Chrome browser to accomplish the task.',
      '',
      'Chrome control must be enabled: Settings → Features → Chrome control (CDP), pointed at a Chrome started with `--remote-debugging-port=9222`.',
      'Available operations: list tabs, open a tab, navigate, read page text/DOM, click an element, type into a field, capture a screenshot, and read console logs.',
      'Work step by step: observe the page, act, then re-observe to confirm the effect. Never submit a form or complete a purchase without confirming with the user first.',
      '',
      'Task: $ARGUMENTS',
    ].join('\n'),
  },
  learn: {
    description: 'Extract solved debugging steps, conventions, or workflows into a reusable SKILL.md on disk.',
    body: [
      'Review the debugging problem, architecture pattern, or build/test workflow solved in this conversation and persist reusable knowledge for future sessions.',
      '',
      '1. Call `ExtractSkill` with a concise kebab-case `name`, clear `description`, `triggers`, numbered `steps`, `pitfalls`, and exact `verification` commands.',
      '2. Only record patterns, fixes, or commands you directly observed working in this session.',
      '3. Also store key project facts with `memory_add` (using `category` such as `build-test`, `architecture`, or `pitfalls`) if concise.',
      '4. Tell the user the file path created (`~/.autobot/skills/<slug>/SKILL.md` or `.claude/skills/<slug>/SKILL.md`).',
      '',
      'Focus: $ARGUMENTS',
    ].join('\n'),
  },
  automation: {
    description: 'Guide the user interactively through creating, scheduling, and testing an automated task.',
    body: [
      'Guide the user interactively through designing and creating a real scheduled or event-driven automation in Akron Code.',
      '',
      '1. Detect the active project folder (`cwd`) and the user\'s local IANA timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`).',
      '2. Use `AskUserQuestion` to collect only missing essentials (skip anything already specified in `$ARGUMENTS`): cadence (`daily`, `weekdays`, `weekly`, `hourly`, `every`, `cron`, or Git/file watch trigger), preferred time (suggesting jittered non-`:00` minutes like `07:18` or `08:47`), and goal/permissions.',
      '3. Call `scheduled-tasks__create_scheduled_task` to persist the automation as `~/.autobot/scheduled-tasks/<id>/SKILL.md`.',
      '4. Report the created task ID, schedule, and offer an instant test run using `scheduled-tasks__run_scheduled_task`.',
      '',
      'User request / starting goal: $ARGUMENTS',
    ].join('\n'),
  },
};

function skillCommand(name) {
  const key = String(name || '').trim().toLowerCase();
  const hit = SKILL_PROMPTS[key];
  if (!hit) return null;
  return { name: key, description: hit.description, body: hit.body, source: 'skill', isSkill: true, argumentHint: '' };
}

function resolve(name, cwd) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  // Project/user command files win over the built-in skill registry, exactly
  // like Claude Code (a skill can be overridden by a same-named command file).
  return discover(cwd, { fresh: true }).find((c) => c.name.toLowerCase() === want)
    || skillCommand(want);
}

// Split an argument string respecting simple quoting.
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(s || '')))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}

function safeFile(p, cwd) {
  try {
    const abs = path.isAbsolute(p) ? p : path.resolve(cwd || process.cwd(), p);
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > 512 * 1024) return `<!-- @${p} too large -->`;
    return fs.readFileSync(abs, 'utf8');
  } catch (_) {
    return null;
  }
}

// Expand a command body into the prompt sent to the model.
// `runBash` is an async (cmd) => stdout function; if omitted, `!`...`` is left as-is.
async function expand(cmd, argString, { cwd = process.cwd(), runBash = null } = {}) {
  if (!cmd) return '';
  const args = splitArgs(argString);
  let body = String(cmd.body || '');

  // `!`command`` → stdout (do this before $ substitution so a file path in the
  // command isn't rewritten).
  if (/!`[^`]+`/.test(body)) {
    const parts = [];
    let last = 0;
    const rx = /!`([^`]+)`/g;
    let m;
    while ((m = rx.exec(body))) {
      parts.push(body.slice(last, m.index));
      let out = '';
      if (typeof runBash === 'function') {
        try { out = String(await runBash(m[1]) || '').trimEnd(); } catch (e) { out = `[bash error: ${e.message}]`; }
      } else {
        out = '[' + m[1] + ']';
      }
      parts.push(out);
      last = m.index + m[0].length;
    }
    parts.push(body.slice(last));
    body = parts.join('');
  }

  // `@path` → file contents.
  body = body.replace(/(^|\s)@([^\s@]+)/g, (full, pre, p) => {
    const content = safeFile(p, cwd);
    return content == null ? full : `${pre}${content}`;
  });

  // $ARGUMENTS and $1..$9.
  body = body.replace(/\$ARGUMENTS\b/g, String(argString || ''));
  body = body.replace(/\$([1-9])\b/g, (_, n) => args[Number(n) - 1] != null ? args[Number(n) - 1] : '');

  return body;
}

// All built-in commands the GUI exposes, so the picker can merge filesystem
// commands with the native ones. Mirrors Claude Code 2.1.x's registry: every
// real, GUI-implementable command is listed here; terminal-only ones are not.
const BUILTIN = [
  // session
  { name: 'help', description: 'Show help' },
  { name: 'clear', description: 'Clear this conversation' },
  { name: 'compact', description: 'Summarize the transcript, then continue from the digest' },
  { name: 'resume', description: 'List conversations to switch to' },
  { name: 'continue', description: 'Continue the last turn' },
  { name: 'fork', description: 'Branch a copy of this conversation' },
  { name: 'export', description: 'Export the conversation (md/html/json)' },
  { name: 'copy', description: 'Copy my last reply' },
  { name: 'reset', description: 'Clear memory and conversations' },
  // model & context
  { name: 'model', description: 'Switch model' },
  { name: 'usage', description: 'Token usage for the last run' },
  { name: 'cost', description: 'Estimated cost of the last run' },
  { name: 'context', description: 'Context-window usage' },
  { name: 'insights', description: 'Usage summary' },
  { name: 'effort', description: 'Set thinking level (auto/low/medium/high)' },
  { name: 'output-style', description: 'Switch output style' },
  { name: 'config', description: 'Open settings' },
  { name: 'theme', description: 'Toggle light/dark theme' },
  // workspace
  { name: 'search', description: 'Search conversations, files, notebooks and memory' },
  { name: 'status', description: 'Show session status' },
  { name: 'diff', description: 'Git diff of the workspace' },
  { name: 'add-dir', description: 'Change working directory' },
  { name: 'init', description: 'Create a CLAUDE.md for this project' },
  { name: 'todos', description: 'Show the current todo list' },
  { name: 'plan', description: 'Toggle plan mode (read-only)' },
  { name: 'notebooks', description: 'Open notebooks' },
  { name: 'terminal', description: 'Open terminal' },
  { name: 'bashes', description: 'List background shells' },
  // agent
  { name: 'agents', description: 'List sub-agent definitions' },
  { name: 'permissions', description: 'Show permission rules' },
  { name: 'rewind', description: 'Restore files to an earlier checkpoint' },
  { name: 'memory', description: 'Show project memory (CLAUDE.md)' },
  { name: 'review', description: 'Review the working-tree diff' },
  { name: 'security-review', description: 'Security review of the diff' },
  { name: 'simplify', description: 'Simplify the changed code' },
  { name: 'advisor', description: 'Second opinion from the model' },
  { name: 'btw', description: 'Ask a quick question without interrupting the main conversation.' },
  { name: 'recap', description: 'Recap this conversation' },
  { name: 'brief', description: 'Short brief of this conversation' },
  { name: 'goal', description: 'Run until the specified goal is completely finished.' },
  { name: 'swarm', description: 'Toggle or launch multi-agent Swarm orchestration' },
  { name: 'subagents', description: 'Open Subagents inspector pane' },
  { name: 'mission', description: 'Open Mission Control live session health board', guiEquivalent: true },
  { name: 'ask-history', description: 'Ask natural-language questions across past coding sessions', guiEquivalent: true },
  { name: 'customizations', description: 'Open Customizations Hub (Marketplace, Skills, Agents, Outputs, MCP)', guiEquivalent: true },
  { name: 'gdrive', description: 'Open Google Drive setup and file picker', guiEquivalent: true },
  // config & system
  { name: 'hooks', description: 'Show merged hook config' },
  { name: 'mcp', description: 'List MCP servers and tools' },
  { name: 'skills', description: 'List skills' },
  { name: 'reload-skills', description: 'Refresh skills' },
  { name: 'plugins', description: 'List plugins' },
  { name: 'debug', description: 'Build and environment info' },
  { name: 'doctor', description: 'Diagnose the setup' },
  { name: 'version', description: 'App version' },
  { name: 'login', description: 'Sign in' },
  { name: 'logout', description: 'Sign out' },
  { name: 'commands', description: 'List custom slash commands' },
  // Claude Code 2.1.x additions / aliases (real registry names)
  { name: 'rename', description: 'Rename the current conversation', aliases: ['name'] },
  { name: 'branch', description: 'Branch the conversation at this point', aliases: ['fork'] },
  { name: 'tasks', description: 'List background tasks', aliases: ['bashes'] },
  { name: 'plugin', description: 'Manage plugins', aliases: ['plugins', 'marketplace'] },
  { name: 'background', description: 'In-app tasks run in the background automatically' },
  { name: 'stop', description: 'Stop the current run or background session' },
  { name: 'schedule', description: 'Create or manage scheduled runs', aliases: ['loops', 'loop'] },
  { name: 'automation', description: 'Guide me through creating an automated recurring or event-driven task', aliases: ['automations'], guiEquivalent: true },
  { name: 'workflows', description: 'Browse workflow history' },
  { name: 'toggle-memory', description: 'Toggle auto-memory for this session' },
  { name: 'autocompact', description: 'Configure the auto-compact window' },
  { name: 'fast', description: 'Fast mode (lower reasoning effort)' },
  { name: 'code-review', description: 'Review a pull request or the diff' },
  { name: 'usage-credits', description: 'Session usage and credits', aliases: ['extra-usage'] },
  { name: 'statusline', description: 'Status line is shown in the composer' },
  { name: 'sandbox', description: 'Sandboxing / permission mode' },
  { name: 'alias', description: 'Command aliases' },
  { name: 'focus', description: 'Narrow the working set' },
  { name: 'bug', description: 'Report a bug' },
  { name: 'feedback', description: 'Send feedback' },
  { name: 'init-verifiers', description: 'Add verification steps to CLAUDE.md' },
  { name: 'pr-comments', description: 'View pull request comments (via Artifacts)' },
  { name: 'exit', description: 'Quit Akron Code', aliases: ['q', 'bye', 'quit'] },
  // GUI equivalents of the remaining real 2.1.x commands (each has a handler
  // in `runSlashCommand`; `guiEquivalent` lets the picker label them).
  { name: 'voice', description: 'Toggle voice mode', guiEquivalent: true },
  { name: 'chrome', description: 'Toggle Chrome (CDP) control', guiEquivalent: true },
  { name: 'daemon', description: 'Background services: scheduled tasks, shells, monitors', guiEquivalent: true },
  { name: 'session', description: 'Show the current session id and working folder', guiEquivalent: true },
  { name: 'remote-env', description: 'Toggle remote control', guiEquivalent: true },
  { name: 'setup-bedrock', description: 'Configure an Amazon Bedrock endpoint', guiEquivalent: true },
  { name: 'setup-vertex', description: 'Configure a Google Vertex AI endpoint', guiEquivalent: true },
  { name: 'ide', description: 'Akron Code is the IDE surface', guiEquivalent: true },
  { name: 'desktop', description: 'Already running in the desktop app', guiEquivalent: true },
  { name: 'tui', description: 'Terminal renderer (not applicable to the GUI)', guiEquivalent: true },
  { name: 'keybindings', description: 'Keyboard shortcuts (Settings → Shortcuts)', guiEquivalent: true },
  { name: 'note', description: 'Record an Agent Note in .agents/notes/ (DeepSeek Harness)', guiEquivalent: true },
  { name: 'worktrees', description: 'Manage isolated git worktrees (Settings → Worktrees)', guiEquivalent: true },
  { name: 'scroll-speed', description: 'Scroll speed follows the OS setting', guiEquivalent: true },
  { name: 'wellbeing', description: 'Break reminders are handled by the OS', guiEquivalent: true },
  { name: 'privacy-settings', description: 'Show data-handling settings', guiEquivalent: true },
  { name: 'rate-limit-options', description: 'Options when a provider rate limit is hit', guiEquivalent: true },
  { name: 'release-notes', description: 'Version and release-info', guiEquivalent: true },
  { name: 'update', description: 'Install a newer build', aliases: ['upgrade', 'install'], guiEquivalent: true },
  { name: 'powerup', description: 'Quick tour of features', guiEquivalent: true },
  { name: 'tutorial', description: 'Interactive hands-on tutorial, 1-click mode presets, and how-to guide', aliases: ['guide', 'onboarding', 'how-to', 'tour'], guiEquivalent: true },
  { name: 'team-onboarding', description: 'Onboarding guide for a teammate', guiEquivalent: true },
  { name: 'autofix-pr', description: 'Monitor and autofix issues on the current PR', guiEquivalent: true },
  { name: 'ultrareview', description: 'Exhaustive review of the pending changes', guiEquivalent: true },
  { name: 'install-github-app', description: 'Set up GitHub Actions CI for this repo', guiEquivalent: true },
  { name: 'mobile', description: 'Open Mobile & Push Relay pairing (Settings → Server & Pairing)', guiEquivalent: true },
  { name: 'bridge-kick', description: 'Inject bridge failure states (dev tooling)', guiEquivalent: true },
  { name: 'learn', description: 'Extract a reusable SKILL.md from a solved workflow or bug fix', argumentHint: '[skill-name or topic]', guiEquivalent: true },
];

function listForUi(cwd) {
  const custom = discover(cwd, { fresh: true }).map((c) => ({
    name: c.name, description: c.description, argumentHint: c.argumentHint,
    source: c.source, file: c.file, custom: true, allowedTools: c.allowedTools, model: c.model,
  }));
  const builtin = BUILTIN.map((b) => ({ ...b, source: 'builtin', custom: false }));
  const seen = new Set([...builtin, ...custom].map((c) => c.name.toLowerCase()));
  const skills = Object.keys(SKILL_PROMPTS)
    .filter((n) => !seen.has(n))
    .map((n) => ({ name: n, description: SKILL_PROMPTS[n].description, source: 'skill', custom: false, isSkill: true }));
  return [...builtin, ...skills, ...custom];
}

const PINNED_ACTION_ORDER = [
  'btw',
  'mcp:rea:investigate_feature',
  'mcp:rea:compare_application_versions',
  'mcp:rea:verify_reconstruction',
  'mcp:rea:trace_crash',
  'mcp:rea:audit_residual_unknowns',
  'mcp:rea:prepare_bounded_process_capture',
  'goal',
  'plan',
  'swarm',
  'review',
  'compact',
  'clear',
  'init',
  'doctor',
  'subagents',
  'agents',
  'memory',
  'context',
  'cost',
  'usage',
  'model',
  'diff',
  'rewind',
  'tasks',
  'automation',
  'schedule',
  'mcp',
  'skills',
  'plugins',
  'gdrive',
  'tutorial',
  'help',
];

const TAKES_ARGS_SET = new Set([
  'btw', 'goal', 'advisor', 'add-dir', 'cwd', 'resume', 'rename', 'effort',
  'output-style', 'export', 'autocompact', 'search', 'swarm',
]);

function listSlashActions({ cwd, mcpPrompts = [], skills = [] } = {}) {
  const byName = new Map();
  const upsert = (item) => {
    if (!item || !item.name) return;
    const key = String(item.name).toLowerCase();
    if (!byName.has(key)) byName.set(key, item);
  };

  // Built-in commands + built-in skill prompts
  for (const b of BUILTIN) {
    upsert({
      name: b.name,
      description: b.description || '',
      kind: 'builtin',
      icon: b.name === 'btw' ? 'btw' : b.name === 'goal' ? 'goal' : 'command',
      takesArgs: TAKES_ARGS_SET.has(b.name),
      aliases: b.aliases || [],
      source: 'builtin',
    });
  }

  // MCP prompts (REA workflows + any other connected MCP servers)
  for (const p of mcpPrompts || []) {
    if (!p || !p.serverId || !p.name) continue;
    const fullName = `mcp:${p.serverId}:${p.name}`;
    upsert({
      name: fullName,
      serverId: p.serverId,
      promptName: p.name,
      description: p.description || p.title || `MCP prompt from ${p.serverName || p.serverId}`,
      kind: 'mcp',
      icon: 'mcp',
      takesArgs: true,
      arguments: Array.isArray(p.arguments) ? p.arguments : [],
      source: 'mcp',
    });
  }

  // Custom .claude/commands & built-in skill commands
  for (const c of discover(cwd, { fresh: true })) {
    upsert({
      name: c.name,
      description: c.description || 'Custom command',
      kind: 'custom',
      icon: 'command',
      takesArgs: /\$ARGUMENTS|\$1/.test(String(c.body || '')),
      argumentHint: c.argumentHint || '',
      source: c.source || 'project',
    });
  }
  for (const [k, v] of Object.entries(SKILL_PROMPTS)) {
    upsert({
      name: k,
      description: v.description || '',
      kind: 'skill',
      icon: 'skill',
      takesArgs: true,
      source: 'skill',
    });
  }
  // Enabled agent skills (e.g. reverse-engineer-anything, run-workflow, etc.)
  for (const s of skills || []) {
    if (!s || s.enabled === false) continue;
    const rawName = String(s.name || s.id || '').trim();
    if (!rawName) continue;
    upsert({
      name: `skill:${rawName}`,
      skillName: rawName,
      description: s.description || `Run with skill ${rawName}`,
      kind: 'skill',
      icon: 'skill',
      takesArgs: true,
      source: 'skill',
    });
  }

  const rankOf = (name) => {
    const idx = PINNED_ACTION_ORDER.indexOf(String(name).toLowerCase());
    return idx >= 0 ? idx : 1000;
  };

  return [...byName.values()].sort((a, b) => {
    const ra = rankOf(a.name);
    const rb = rankOf(b.name);
    if (ra !== rb) return ra - rb;
    // Secondary MCP prompts right before unpinned built-ins
    if (ra === 1000 && rb === 1000) {
      if (a.kind === 'mcp' && b.kind !== 'mcp') return -1;
      if (a.kind !== 'mcp' && b.kind === 'mcp') return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

module.exports = {
  BUILTIN,
  SKILL_PROMPTS,
  discover,
  resolve,
  expand,
  splitArgs,
  listForUi,
  listSlashActions,
  commandDirs,
};
