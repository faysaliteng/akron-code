'use strict';
// Permission rules engine — Example's settings.json `permissions` block.
//
//   permissions: {
//     allow: ["Bash(git diff:*)", "Read", "Edit(src/**)"],
//     deny:  ["Bash(rm:*)", "Read(./.env)"],
//     ask:   ["Bash(git push:*)"],
//     defaultMode: "auto" | "manual" | "acceptEdits" | "plan" | "bypass",
//     additionalDirectories: ["/abs/path"]
//   }
//
// A rule is `Tool` (matches every use of the tool) or `Tool(specifier)`. The
// specifier is matched against the tool's primary argument:
//   Bash(cmd:*)      → command starts with `cmd`
//   Bash(cmd *)      → same, with blocklist-style wildcards
//   Edit(src/**)     → file path glob (gitignore-style)
//   Read(./.env)     → exact path (relative to cwd)
//
// Precedence (matches Example Code): deny > ask > allow > defaultMode.
// Everything here is pure so the parity gate can exercise it.

const cc = require('./claudeconfig');

const MODES = ['auto', 'manual', 'acceptEdits', 'plan', 'bypass', 'planMode'];

// The argument a specifier is matched against, per tool.
const PRIMARY_ARG = {
  Bash: ['command', 'cmd'],
  BashOutput: ['bash_id', 'shell_id'],
  KillShell: ['shell_id', 'bash_id'],
  Read: ['file_path', 'path'],
  Write: ['file_path', 'path'],
  Edit: ['file_path', 'path'],
  MultiEdit: ['file_path', 'path'],
  NotebookEdit: ['notebook_path', 'file_path'],
  NotebookRead: ['notebook_path', 'file_path'],
  Glob: ['pattern'],
  Grep: ['pattern'],
  WebFetch: ['url'],
  WebSearch: ['query'],
  Task: ['description', 'prompt'],
  Agent: ['description', 'prompt'],
  Skill: ['skill', 'name'],
};

function primaryArg(toolName, args) {
  const keys = PRIMARY_ARG[toolName] || [];
  for (const k of keys) {
    if (args && args[k] != null) return String(args[k]);
  }
  return '';
}

// Match a `Bash(...)` specifier against a command.
//   "git diff:*"  → command === "git diff" or starts with "git diff "
//   "npm:*"       → any npm subcommand
//   "git push *"  → wildcard form
function matchBash(spec, command) {
  const cmd = String(command || '').trim();
  let s = String(spec || '').trim();
  if (!cmd) return false;
  // `prefix:*` (Example's canonical form)
  let m = /^(.*?):\*$/.exec(s);
  if (m) {
    const prefix = m[1].trim();
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  // `prefix *` wildcard form
  if (/\s\*$/.test(s)) {
    const prefix = s.replace(/\s\*$/, '').trim();
    return cmd === prefix || cmd.startsWith(prefix + ' ');
  }
  // `*suffix` or `pre*suf` glob
  if (s.includes('*')) {
    const re = new RegExp('^' + s.split('*').map(escapeRe).join('.*') + '$');
    return re.test(cmd);
  }
  return cmd === s;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// Glob match for file paths: supports **, *, ?, and a leading ./ .
function matchGlob(spec, value) {
  let s = String(spec || '').trim();
  const v = String(value || '').replace(/\\/g, '/');
  if (!s) return true;
  s = s.replace(/^\.\//, '');
  // If the rule is an exact path or has no glob chars, compare directly (also
  // true when the value ends with the rule, so relative rules match absolute paths).
  if (!/[*?]/.test(s)) {
    const sv = v.replace(/^\.\//, '');
    return sv === s || sv.endsWith('/' + s) || sv.endsWith(s);
  }
  let re = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') { re += '.*'; i += 2; if (s[i] === '/') { re += '/?'; i++; } continue; }
      re += '[^/]*'; i++; continue;
    }
    if (c === '?') { re += '[^/]'; i++; continue; }
    re += escapeRe(c);
    i++;
  }
  const rx = new RegExp('(^|/)' + re + '$');
  return rx.test(v);
}

// Parse `Tool(specifier)` → { tool, specifier|null }. Bare `Tool` → specifier null.
function parseRule(rule) {
  const s = String(rule || '').trim();
  const m = /^([A-Za-z0-9_]+)\s*(?:\((.*)\))?$/.exec(s);
  if (!m) return { tool: s, specifier: null };
  return { tool: m[1], specifier: m[2] == null ? null : m[2].trim() };
}

function ruleMatches(rule, toolName, args, cwd) {
  const { tool, specifier } = parseRule(rule);
  // MCP wildcard forms: mcp__server__tool, or `mcp__server` / `mcp__*`.
  if (toolName.startsWith('mcp__')) {
    if (tool === toolName) return true;
    if (tool.startsWith('mcp__') && (tool === 'mcp' || toolName.startsWith(tool + '__') || tool === 'mcp__*')) return true;
  }
  if (tool !== toolName && !(tool === '*' && !specifier)) {
    // A rule can name a tool family such as `Edit`; never match a different tool.
    if (tool !== toolName) return false;
  }
  if (specifier == null) return true;
  const value = primaryArg(toolName, args || {});
  if (toolName === 'Bash') return matchBash(specifier, value);
  // File-ish tools use glob matching; include cwd so absolute paths match `src/**`.
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'Read' || toolName === 'NotebookEdit' || toolName === 'NotebookRead') {
    const candidates = [value];
    try { if (cwd && !require('path').isAbsolute(value)) candidates.push(require('path').relative(cwd, require('path').resolve(cwd, value))); } catch (_) {}
    return candidates.some((v) => matchGlob(specifier, v));
  }
  // Everything else: glob on the primary arg (urls, queries, patterns).
  return matchGlob(specifier, value);
}

function asArray(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return [v.trim()];
  return [];
}

// Normalized permissions block for a cwd (merged across settings scopes).
function loadPermissions(cwd) {
  const { settings, sources } = cc.loadSettings(cwd);
  const p = (settings && settings.permissions) || {};
  return {
    allow: asArray(p.allow),
    deny: asArray(p.deny),
    ask: asArray(p.ask),
    defaultMode: MODES.includes(p.defaultMode) ? p.defaultMode : null,
    additionalDirectories: asArray(p.additionalDirectories),
    sources,
    raw: p,
  };
}

// Decide one tool call.
//   → { decision: 'allow'|'deny'|'ask', reason, rule }
// `mode` is the current permission pill (auto/manual/acceptEdits/plan/bypass).
function decide(perms, toolName, args, { cwd = null, mode = 'auto' } = {}) {
  const P = perms || { allow: [], deny: [], ask: [] };
  // 1. deny wins outright.
  for (const rule of P.deny) {
    if (ruleMatches(rule, toolName, args, cwd)) return { decision: 'deny', reason: `Denied by rule ${rule}`, rule };
  }
  // 2. ask.
  for (const rule of P.ask) {
    if (ruleMatches(rule, toolName, args, cwd)) return { decision: 'ask', reason: `Rule ${rule} requires confirmation`, rule };
  }
  // 3. allow.
  for (const rule of P.allow) {
    if (ruleMatches(rule, toolName, args, cwd)) return { decision: 'allow', reason: `Allowed by rule ${rule}`, rule };
  }
  // 4. fall back to the session permission mode.
  const m = String(mode || 'auto');
  if (m === 'bypass' || m === 'bypassPermissions') return { decision: 'allow', reason: 'bypass mode', rule: null };
  if (m === 'auto' || m === 'acceptEdits') return { decision: 'allow', reason: `${m} mode`, rule: null };
  if (m === 'plan' || m === 'planMode') {
    // Plan mode is read-only; the run loop already enforces this, but a rule-less
    // mutating tool should still be denied here for a second line of defence.
    return { decision: 'ask', reason: 'plan mode', rule: null };
  }
  // manual / default
  return { decision: 'ask', reason: 'manual approval', rule: null };
}

module.exports = {
  MODES,
  PRIMARY_ARG,
  loadPermissions,
  decide,
  ruleMatches,
  parseRule,
  matchBash,
  matchGlob,
  primaryArg,
};
