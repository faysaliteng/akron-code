'use strict';
// Sub-agent definitions — Claude's `.claude/agents/*.md` model.
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
      'You are a general-purpose agent running inside Helio Bot. Given the task in the prompt, use the tools available to you to complete it and then report back concisely.',
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
    description: 'Answers questions about Claude Code, the Claude Agent SDK, and the Claude API.',
    model: 'haiku',
    tools: ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'],
    body: [
      'You answer questions about (1) Claude Code — features, hooks, slash commands, MCP servers, settings, IDE integrations, keyboard shortcuts; (2) the Claude Agent SDK — building custom agents; (3) the Claude API — tool use, streaming, SDK usage.',
      'Answer from what you know plus the local documentation you can read. Be concise and concrete; include a code snippet when it helps.',
    ].join('\n'),
  },
  'statusline-setup': {
    name: 'statusline-setup',
    description: 'Configures the status line command.',
    model: 'haiku',
    tools: ['Read', 'Write', 'Edit', 'Bash'],
    body: [
      'You configure the status line for Helio Bot. Write a shell command that prints one line of status text (model, cwd, git branch, tokens), and save it as statusLine.command in ~/.claude/settings.json (or ~/.autobot/settings.json).',
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
};

function normalizeName(n) {
  return String(n || '').trim();
}

function defDirs(cwd) {
  const dirs = [
    { dir: path.join(cc.CONFIG_DIR, 'agents'), source: 'user' },
  ];
  if (cwd) dirs.push({ dir: path.join(cwd, '.claude', 'agents'), source: 'project' });
  dirs.push({ dir: path.join(cc.AUTOBOT_DIR, 'agents'), source: 'autobot' });
  return dirs;
}

function fromFile(file, source) {
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
    description: data.description || `${name} (custom agent)`,
    model: data.model || null,
    tools,
    body: body.trim(),
    file,
    source,
    custom: true,
  };
}

let _cache = { cwd: null, at: 0, list: [] };
const CACHE_MS = 2000;

// All definitions (built-ins overridden by user files), project scope winning.
function discover(cwd, { fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _cache.cwd === (cwd || '') && now - _cache.at < CACHE_MS) return _cache.list;

  const byName = new Map();
  for (const [k, v] of Object.entries(BUILTIN)) byName.set(k.toLowerCase(), { ...v, source: 'builtin' });

  // Later dirs (project, then autobot) win over earlier ones.
  for (const { dir, source } of defDirs(cwd)) {
    for (const file of cc.listMarkdown(dir, { recursive: false })) {
      const def = fromFile(file, source);
      if (!def) continue;
      byName.set(def.name.toLowerCase(), def);
    }
  }

  const list = [...byName.values()];
  _cache = { cwd: cwd || '', at: now, list };
  return list;
}

function resolve(name, cwd) {
  const want = normalizeName(name);
  if (!want) return BUILTIN['general-purpose'];
  const list = discover(cwd, { fresh: true });
  const exact = list.find((d) => d.name.toLowerCase() === want.toLowerCase());
  if (exact) return exact;
  // Claude also accepts undefined alias spellings for the built-ins.
  const aliases = { general: 'general-purpose', 'general purpose': 'general-purpose', explorer: 'explore', planner: 'plan', 'code-reviewer': null };
  const alt = aliases[want.toLowerCase()];
  if (alt) return list.find((d) => d.name.toLowerCase() === alt) || null;
  return null;
}

// A definition's tool list, expanded to the tool names the runtime actually
// dispatches (our Edit/Write/Read names already match Claude's).
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
};
