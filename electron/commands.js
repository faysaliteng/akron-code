'use strict';
// Custom slash commands — Claude's `.claude/commands/**/*.md`.
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

function resolve(name, cwd) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return discover(cwd, { fresh: true }).find((c) => c.name.toLowerCase() === want) || null;
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
// commands with the native ones.
const BUILTIN = [
  { name: 'help', description: 'Show help' },
  { name: 'clear', description: 'Clear this conversation' },
  { name: 'compact', description: 'Compact the conversation' },
  { name: 'model', description: 'Switch model' },
  { name: 'memory', description: 'Show project memory (CLAUDE.md)' },
  { name: 'review', description: 'Review the current changes' },
  { name: 'status', description: 'Show session status' },
  { name: 'rewind', description: 'Restore files to an earlier checkpoint' },
  { name: 'agents', description: 'List sub-agent definitions' },
  { name: 'commands', description: 'List custom slash commands' },
  { name: 'output-style', description: 'Switch output style' },
  { name: 'mcp', description: 'List MCP servers and tools' },
  { name: 'init', description: 'Create a CLAUDE.md for this project' },
  { name: 'permissions', description: 'Show permission rules' },
];

function listForUi(cwd) {
  const custom = discover(cwd, { fresh: true }).map((c) => ({
    name: c.name, description: c.description, argumentHint: c.argumentHint,
    source: c.source, file: c.file, custom: true, allowedTools: c.allowedTools, model: c.model,
  }));
  const builtin = BUILTIN.map((b) => ({ ...b, source: 'builtin', custom: false }));
  return [...builtin, ...custom];
}

module.exports = {
  BUILTIN,
  discover,
  resolve,
  expand,
  splitArgs,
  listForUi,
  commandDirs,
};
