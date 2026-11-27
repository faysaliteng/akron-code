'use strict';
// Sub-agent definitions — Example's `.claude/agents/*.md` model.
//
// A definition is a markdown file with frontmatter:
//
//   ---
//   name: code-reviewer
//   description: Reviews diffs for bugs. Use after finishing a feature.
//   tools: Read, Grep, Glob, Bash(git diff:*)
//   model: sonnet
//   ---
//   You are a senior reviewer. ...
//
// Built-in types (general-purpose, Explore, Plan, Bash, claude-code-guide,
// statusline-setup, output-style-setup) always exist, and a user definition
// with the same name overrides the built-in — exactly like Claude Code.

const fs = require('fs');
const os = require('os');
const path = require('path');
const cc = require('./claudeconfig');

const READ_ONLY_TOOLS = [
  'Read', 'Glob', 'Grep', 'LS', 'Search', 'ListDir', 'ListFiles', 'WebFetch', 'WebSearch',
  'TodoWrite', 'TaskList', 'TaskGet', 'NotebookRead', 'Skill', 'list_skills', 'load_skill',
  'ListMcpResources', 'ReadMcpResource',
];

const BUILTIN = {
  'general-purpose': {
    name: 'general-purpose',
    description: 'General-purpose agent for researching complex questions, searching for code, and executing multi-step tasks. Full tool access.',
    model: null,
    tools: null, // all tools
    body: [
      'You are a general-purpose agent running inside Akron Code. Given the task in the prompt, use the tools available to you to complete it and then report back concisely.',
      '',
      'Work autonomously: gather what you need with Read/Grep/Glob, make the changes with Write/Edit, verify with Bash, and finish with a short report of what you did, what you found, and anything the caller must know.',
      'Do not ask the caller questions — if something is ambiguous, choose the most reasonable interpretation, state the assumption, and continue.',
    ].join('\n'),
  },
  explore: {
    name: 'Explore',
    description: 'Read-only search agent. Locates files, symbols, and patterns fast and reports exact locations. Cannot modify anything.',
    model: 'haiku',
    tools: READ_ONLY_TOOLS,
    body: [
      'You are an exploration agent. Your job is to answer "where is X / how does X work" by searching the codebase, and to return precise locations.',
      '',
      '=== READ-ONLY MODE — NO FILE MODIFICATIONS ===',
      'You cannot create, modify, or delete files, and you must not run commands that change state.',
      '',
      'Be fast: start with Glob/Grep, read only the regions that matter, and stop as soon as the question is answerable.',
      'Report file paths with line numbers and short quoted excerpts. Do not paste whole files.',
    ].join('\n'),
  },
  plan: {
    name: 'Plan',
    description: 'Software architect and planning specialist. Explores the codebase read-only and returns a step-by-step implementation plan.',
    model: 'opus',
    tools: READ_ONLY_TOOLS,
    body: [
      'You are a software architect and planning specialist. Your role is to explore the codebase and design implementation plans.',
      '',
      '=== CRITICAL: READ-ONLY MODE — NO FILE MODIFICATIONS ===',
      'You are STRICTLY PROHIBITED from creating, modifying, moving, or deleting files, and from running any command that changes system state.',
      '',
      '## Your process',
      '1. Understand the requirements and the perspective you were given.',
      '2. Explore thoroughly: read the files named in the prompt, then find the existing patterns and conventions that the change must follow.',
      '3. Consider at least two approaches, with trade-offs.',
      '4. Produce a detailed, ordered plan: exact files to touch, what changes in each, how to verify, and the risks.',
      '',
      'Return the plan as your final message. Be specific enough that another engineer could execute it without re-deriving the design.',
    ].join('\n'),
  },
  bash: {
    name: 'Bash',
    description: 'Command execution specialist for running shell commands, builds, and tests.',
    model: 'haiku',
    tools: ['Bash', 'Read', 'Grep', 'Glob'],
    body: [
      'You are a command execution specialist. Run the commands you were asked to run, read their output carefully, and report the exact results.',
      'Prefer non-destructive commands. Never delete data or rewrite git history unless the prompt explicitly says to.',
      'If a command fails, diagnose it from the output and try the standard fix once before reporting the failure.',
    ].join('\n'),
  },
  'claude-code-guide': {
    name: 'claude-code-guide',
    description: 'Answers questions about Claude Code, the Example Agent SDK, and the Example API.',
    model: 'haiku',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    body: [
      'You answer questions about (1) Claude Code — features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) the Example Agent SDK — building custom agents; (3) the Example API — tool use, streaming, SDK usage.',
      'Answer from what you know plus the local documentation you can read. Be concise and concrete; include a code snippet when it helps.',
    ].join('\n'),
  },
  'statusline-setup': {
    name: 'statusline-setup',
    description: 'Configures the status line command.',
    model: 'haiku',
    tools: ['Read', 'Write', 'Edit', 'Bash'],
    body: [
      'You configure the status line for Akron Code. Write a shell command that prints one line of status text (model, cwd, git branch, tokens), and save it as statusLine.command in ~/.claude/settings.json (or ~/.autobot/settings.json).',
      'Keep it fast (<100 ms) and side-effect free.',
    ].join('\n'),
  },
  'output-style-setup': {
    name: 'output-style-setup',
    description: 'Creates a custom output style.',
    model: 'haiku',
    tools: ['Read', 'Write', 'Edit'],
    body: [
      'You create output styles: markdown files in ~/.claude/output-styles/ with frontmatter (name, description) and a body that tells the assistant how to format its responses.',
      'The body is appended to the system prompt when the style is selected.',
    ].join('\n'),
  },
  verifier: {
    name: 'verifier',
    description: 'Independent verification specialist. Runs syntax checks, builds, tests, and git diff inspections to verify changes work end-to-end before completion.',
    model: null,
    role: 'coder',
    tools: ['Bash', 'Read', 'Glob', 'Grep', 'LS', 'Search', 'TodoWrite'],
    body: [
      'You are an independent verification specialist running inside Akron Code.',
      '',
      '=== VERIFICATION MODE — VERIFY RIGOROUSLY WITHOUT MUTATING PRODUCT SOURCE ===',
      '1. Inspect the workspace (git status / git diff / target files) using Read, Glob, Grep, and Bash.',
      '2. Run the project\'s syntax checks, unit tests, typechecks, and build scripts via Bash.',
      '3. Verify imports, exports, edge cases, and error handling directly — never assume a feature works just because code exists.',
      '4. Report concrete file:line diagnostics and end with either VERIFICATION: PASS (listing exact commands run) or VERIFICATION: FAIL (listing every blocking issue).',
    ].join('\n'),
  },
  'code-reviewer': {
    name: 'code-reviewer',
    description: 'Senior code review specialist. Audits diffs and modules for bugs, race conditions, security issues, and regressions.',
    model: 'opus',
    role: 'planner',
    tools: ['Read', 'Glob', 'Grep', 'LS', 'Search', 'Bash'],
    body: [
      'You are a senior code review specialist. Audit diffs, modules, and tests for correctness bugs, race conditions, missing edge-case guards, security flaws, and regressions.',
      '',
      '=== READ-ONLY REVIEW MODE ===',
      'Do not modify source files. Inspect changes with Read/Grep/Glob and `git diff` via Bash.',
      'Prioritize findings (Critical / High / Medium / Low) with exact file:line citations and concrete fix recommendations.',
    ].join('\n'),
  },
  CodebaseInvestigator: {
    name: 'CodebaseInvestigator',
    description: 'Read-only semantic and symbol codebase explorer for navigating large repositories rapidly via CodebaseSearch, Grep, Glob, and Read.',
    model: 'haiku',
    role: 'planner',
    tools: ['CodebaseSearch', 'Read', 'Glob', 'Grep', 'LS', 'Search'],
    body: [
      'You are a read-only CodebaseInvestigator specialist. Map architecture, symbol definitions, call paths, and module dependencies quickly using CodebaseSearch, Grep, Glob, and Read.',
      'Never modify files. Always cite exact file paths and line numbers for every finding.',
    ].join('\n'),
  },
};

function normalizeName(n) {
  return String(n || '').trim();
}

function slugifyAgentName(n) {
  return String(n || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function resolveAgentRoots() {
  return {
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    autobotDir: process.env.AUTOBOT_HOME || path.join(os.homedir(), '.autobot'),
  };
}

function defDirs(cwd) {
  const { claudeDir, autobotDir } = resolveAgentRoots();
  const dirs = [
    { dir: path.join(claudeDir, 'agents'), source: 'user', scope: 'global' },
    { dir: path.join(autobotDir, 'agents'), source: 'autobot', scope: 'global' },
  ];
  if (cwd) dirs.push({ dir: path.join(cwd, '.claude', 'agents'), source: 'project', scope: 'workspace' });
  return dirs;
}

function fromFile(file, source, scope = 'global') {
  const text = cc.readText(file);
  if (text == null) return null;
  const { data, body } = cc.parseFrontmatter(text);
  const base = path.basename(file).replace(/\.md$/i, '');
  const name = normalizeName(data.name || base);
  if (!name) return null;
  const tools = Array.isArray(data.tools)
    ? data.tools
    : (typeof data.tools === 'string' && data.tools.trim() ? data.tools.split(',').map((s) => s.trim()).filter(Boolean) : null);
  return {
    name,
    role: data.role ? String(data.role).trim() : '',
    description: data.description || `${name} (custom agent)`,
    model: data.model || null,
    tools,
    body: body.trim(),
    file,
    source,
    scope: scope || (source === 'project' ? 'workspace' : 'global'),
    custom: true,
  };
}

let _cache = { cwd: null, at: 0, list: [] };
const CACHE_MS = 2000;

// All definitions (built-ins overridden by user files), workspace scope winning.
function discover(cwd, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _cache.cwd === (cwd || '') && now - _cache.at < CACHE_MS) return _cache.list;

  const byName = new Map();
  for (const [k, v] of Object.entries(BUILTIN)) byName.set(k.toLowerCase(), { ...v, source: 'builtin', scope: 'builtin', custom: false });

  // Later dirs (autobot global, then workspace .claude/agents) win over earlier ones.
  for (const { dir, source, scope } of defDirs(cwd)) {
    for (const file of cc.listMarkdown(dir, { recursive: false })) {
      const def = fromFile(file, source, scope);
      if (!def) continue;
      byName.set(def.name.toLowerCase(), def);
    }
  }

  const list = [...byName.values()];
  _cache = { cwd: cwd || '', at: now, list };
  return list;
}

function yamlScalar(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
  if (!s) return '""';
  if (/[:#"'{}\[\],&*?|>!%@`]/.test(s)) return JSON.stringify(s);
  return s;
}

function saveAgentDef(input = {}, cwd = '') {
  const rawName = normalizeName(input.name || input.handle || '');
  const slug = slugifyAgentName(rawName);
  if (!slug) return { ok: false, error: 'Agent name is required' };
  const name = rawName || slug;

  const reqScope = String(input.scope || input.storage || 'autobot').toLowerCase();
  const { claudeDir, autobotDir } = resolveAgentRoots();
  let targetDir = path.join(autobotDir, 'agents');
  if ((reqScope === 'workspace' || reqScope === 'project') && cwd) {
    targetDir = path.join(cwd, '.claude', 'agents');
  } else if (reqScope === 'user' || reqScope === 'claude') {
    targetDir = path.join(claudeDir, 'agents');
  }
  cc.ensureDir(targetDir);
  const file = path.join(targetDir, `${slug}.md`);

  const toolsArr = Array.isArray(input.tools)
    ? input.tools.map((t) => String(t || '').trim()).filter(Boolean)
    : (typeof input.tools === 'string' && input.tools.trim() ? input.tools.split(',').map((s) => s.trim()).filter(Boolean) : null);

  const lines = [
    '---',
    `name: ${yamlScalar(name)}`,
  ];
  if (input.role && String(input.role).trim()) lines.push(`role: ${yamlScalar(input.role)}`);
  lines.push(`description: ${yamlScalar(input.description || input.role || `${name} sub-agent`)}`);
  if (input.model && String(input.model).trim() && String(input.model).trim().toLowerCase() !== 'inherit') {
    lines.push(`model: ${yamlScalar(input.model)}`);
  }
  if (toolsArr && toolsArr.length && !toolsArr.includes('*')) {
    lines.push(`tools: ${yamlScalar(toolsArr.join(', '))}`);
  }
  lines.push('---', '');
  const body = String(input.body || input.systemPrompt || input.prompt || `You are ${name}. Complete the delegated task carefully and report back concisely.`).trim();
  fs.writeFileSync(file, `${lines.join('\n')}${body}\n`, { encoding: 'utf8', mode: 0o600 });
  _cache = { cwd: null, at: 0, list: [] };
  const list = discover(cwd, { fresh: true });
  const saved = list.find((d) => d.name.toLowerCase() === name.toLowerCase()) || fromFile(file, (reqScope === 'workspace' || reqScope === 'project') && cwd ? 'project' : 'autobot');
  return { ok: true, agent: saved, file, agents: list };
}

function deleteAgentDef(input = {}, cwd = '') {
  const want = normalizeName(typeof input === 'string' ? input : (input.name || ''));
  const targetFile = input && typeof input === 'object' ? input.file : '';
  const dirs = defDirs(cwd);
  const allowedRoots = dirs.map((d) => path.resolve(d.dir));
  let deleted = false;
  if (targetFile) {
    const abs = path.resolve(String(targetFile));
    if (!allowedRoots.some((root) => abs.startsWith(root + path.sep))) {
      return { ok: false, error: 'Refused to delete agent definition outside agents directories' };
    }
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      deleted = true;
    }
  } else if (want) {
    const slug = slugifyAgentName(want);
    for (const d of dirs) {
      if (input.scope && input.scope !== d.scope && input.scope !== d.source) continue;
      const direct = path.join(d.dir, `${slug}.md`);
      if (fs.existsSync(direct)) {
        fs.unlinkSync(direct);
        deleted = true;
      } else {
        for (const f of cc.listMarkdown(d.dir, { recursive: false })) {
          const parsed = fromFile(f, d.source, d.scope);
          if (parsed && parsed.name.toLowerCase() === want.toLowerCase()) {
            fs.unlinkSync(f);
            deleted = true;
          }
        }
      }
    }
  }
  if (!deleted) {
    const builtinHit = want && BUILTIN[want.toLowerCase()];
    return {
      ok: false,
      error: builtinHit ? 'Built-in agents cannot be deleted' : 'Custom agent definition not found',
    };
  }
  _cache = { cwd: null, at: 0, list: [] };
  return { ok: true, deleted: true, agents: discover(cwd, { fresh: true }) };
}

function resolve(name, cwd) {
  const want = normalizeName(name);
  if (!want) return BUILTIN['general-purpose'];
  const list = discover(cwd, { fresh: true });
  const exact = list.find((d) => d.name.toLowerCase() === want.toLowerCase());
  if (exact) return exact;
  // Example also accepts undefined alias spellings for the built-ins.
  const aliases = {
    general: 'general-purpose',
    'general purpose': 'general-purpose',
    explorer: 'explore',
    planner: 'plan',
    'code-reviewer': 'code-reviewer',
    reviewer: 'code-reviewer',
    review: 'code-reviewer',
    verifier: 'verifier',
    verify: 'verifier',
    verification: 'verifier',
    verification_agent: 'verifier',
  };
  const alt = aliases[want.toLowerCase()];
  if (alt) return list.find((d) => d.name.toLowerCase() === alt) || null;
  return null;
}

// A definition's tool list, expanded to the tool names the runtime actually
// dispatches (our Edit/Write/Read names already match Example's).
function allowedToolSet(def) {
  if (!def || !Array.isArray(def.tools) || !def.tools.length) return null;
  return new Set(def.tools.map((t) => String(t).split('(')[0].trim()).filter(Boolean));
}

function toolAllowed(def, toolName) {
  const set = allowedToolSet(def);
  if (!set) return true;
  if (set.has(toolName)) return true;
  // MCP tools are granted via `mcp__server__tool` or a wildcard.
  if (toolName.startsWith('mcp__') && (set.has('mcp') || set.has('*') || set.has('mcp__*'))) return true;
  if (set.has('*')) return true;
  return false;
}

function promptFor(def) {
  if (!def) return null;
  const head = `You are the "${def.name}" sub-agent. ${def.description || ''}`.trim();
  return `${head}\n\n${def.body || ''}`.trim();
}

function asToolDescription() {
  return discover(null, { fresh: true })
    .filter((d) => d.source === 'builtin' || d.custom)
    .map((d) => `- ${d.name}: ${d.description}`)
    .join('\n');
}

module.exports = {
  BUILTIN,
  READ_ONLY_TOOLS,
  discover,
  resolve,
  allowedToolSet,
  toolAllowed,
  promptFor,
  asToolDescription,
  saveAgentDef,
  deleteAgentDef,
};
