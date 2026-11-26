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
// Precedence (matches Claude Code): deny > ask > allow > defaultMode.
// Everything here is pure so the parity gate can exercise it.

const fs = require('fs');
const os = require('os');
const path = require('path');
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

// Split a shell command into the simple commands it would run, so a rule
// like `Bash(git diff:*)` can't be used to smuggle `git diff && rm -rf ~`.
// Separators (outside quotes): && || ; | |& & and newlines. Command and
// process substitutions — $(…), `…`, <(…), >(…) — are executed too, so their
// bodies are split recursively and added as extra segments (they are also
// expanded inside double quotes, like the shell does). Redirections such as
// 2>&1 or &> are not separators.
function splitCommand(command) {
  const src = String(command || '');
  const segs = [];
  const subs = [];
  let cur = '';
  let i = 0;
  let q = null; // "'" | '"'
  const push = () => {
    let t = cur.trim();
    // strip subshell / group wrappers: `( a; b )`, `{ a; }` — only unbalanced
    // ones, so `cat <(ls)` / `echo $(x)` stay intact.
    const cnt = (str, ch) => str.split(ch).length - 1;
    for (;;) {
      let n = t;
      if (/^[({]/.test(n) && cnt(n, n[0]) > cnt(n, n[0] === '(' ? ')' : '}')) n = n.slice(1).trim();
      const last = n.slice(-1);
      if ((last === ')' || last === '}') && cnt(n, last) > cnt(n, last === ')' ? '(' : '{')) n = n.slice(0, -1).trim();
      if (n === t) break;
      t = n;
    }
    if (t) segs.push(t);
    cur = '';
  };
  const readParen = (from) => { // returns index of the matching ')'
    let depth = 1;
    let j = from;
    let qq = null;
    while (j < src.length) {
      const c = src[j];
      if (qq) {
        if (c === '\\' && qq === '"') { j += 2; continue; }
        if (c === qq) qq = null;
      } else if (c === '\\') { j += 2; continue; }
      else if (c === "'" || c === '"') qq = c;
      else if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) return j; }
      j++;
    }
    return src.length;
  };
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (q === "'") { cur += c; if (c === "'") q = null; i++; continue; }
    if (c === '\\') { cur += c + (n || ''); i += 2; continue; }
    // substitutions (also live inside double quotes)
    if ((c === '$' || ((c === '<' || c === '>') && !q)) && n === '(' && src[i + 2] !== '(') {
      const end = readParen(i + 2);
      subs.push(src.slice(i + 2, end));
      cur += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (c === '`') {
      let end = i + 1;
      while (end < src.length && src[end] !== '`') { if (src[end] === '\\') end++; end++; }
      subs.push(src.slice(i + 1, end));
      cur += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (q === '"') { cur += c; if (c === '"') q = null; i++; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; i++; continue; }
    if (c === '\n' || c === ';') { push(); i++; continue; }
    if (c === '&' && n === '&') { push(); i += 2; continue; }
    if (c === '|' && n === '|') { push(); i += 2; continue; }
    if (c === '|') { push(); i += (n === '&' ? 2 : 1); continue; }
    if (c === '&') {
      const prev = cur.slice(-1);
      if (prev === '>' || prev === '<' || n === '>') { cur += c; i++; continue; } // 2>&1, &>, >&
      push(); i++; continue;
    }
    cur += c;
    i++;
  }
  push();
  for (const s of subs) for (const x of splitCommand(s)) segs.push(x);
  return segs;
}

// Match a `Bash(...)` specifier against ONE simple command.
//   "git diff:*"  → command === "git diff" or starts with "git diff "
//   "npm:*"       → any npm subcommand
//   "git push *"  → wildcard form
function matchBashSegment(spec, command) {
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

// Allow-semantics: a compound command matches only when EVERY simple command
// in it matches the spec.
function matchBash(spec, command) {
  const segs = splitCommand(command);
  if (!segs.length) return false;
  return segs.every((seg) => matchBashSegment(spec, seg));
}

// Deny/ask-semantics: ANY simple command (or the whole string) matching wins.
function matchBashAny(spec, command) {
  if (matchBashSegment(spec, command)) return true;
  return splitCommand(command).some((seg) => matchBashSegment(spec, seg));
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

function ruleMatches(rule, toolName, args, cwd, { any = false } = {}) {
  const { tool, specifier } = parseRule(rule);
  // MCP wildcard forms: mcp__server__tool, `mcp__server`, `mcp__server__*`, or `mcp__*`.
  if (toolName.startsWith('mcp__')) {
    if (tool === toolName) return true;
    if (tool.startsWith('mcp__') && (tool === 'mcp' || toolName.startsWith(tool + '__') || tool === 'mcp__*')) return true;
    if (tool.startsWith('mcp__') && tool.endsWith('*') && toolName.startsWith(tool.slice(0, -1))) return true;
  }
  if (tool !== toolName && !(tool === '*' && !specifier)) {
    // A rule can name a tool family such as `Edit`; never match a different tool.
    if (tool !== toolName) return false;
  }
  if (specifier == null) return true;
  const value = primaryArg(toolName, args || {});
  if (toolName === 'Bash') return any ? matchBashAny(specifier, value) : matchBash(specifier, value);
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
    customRules: Array.isArray(p.customRules) ? p.customRules : [],
    defaultMode: MODES.includes(p.defaultMode) ? p.defaultMode : null,
    additionalDirectories: asArray(p.additionalDirectories),
    sources,
    raw: p,
  };
}

// Tools acceptEdits auto-approves (file edits) and tools that never mutate.
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__workspace__write_file', 'mcp__workspace__edit_file']);
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'BashOutput', 'TaskOutput', 'ListMcpResources', 'ReadMcpResource']);

// First deny rule matching the call (for any tool, read-only ones included),
// or null. Bash: deny if ANY simple command of a compound matches.
function denyMatch(perms, toolName, args, { cwd = null } = {}) {
  const P = perms || {};
  for (const rule of asArray(P.deny)) {
    if (ruleMatches(rule, toolName, args, cwd, { any: true })) return { decision: 'deny', reason: `Denied by rule ${rule}`, rule };
  }
  return null;
}

// Every simple command of a Bash call must be covered by SOME allow rule
// (different segments may match different rules).
function bashAllowRule(allow, args) {
  const segs = splitCommand(primaryArg('Bash', args || {}));
  if (!segs.length) return null;
  let first = null;
  for (const seg of segs) {
    const hit = allow.find((rule) => {
      const { tool, specifier } = parseRule(rule);
      if (tool !== 'Bash') return false;
      return specifier == null || matchBashSegment(specifier, seg);
    });
    if (!hit) return null;
    if (!first) first = hit;
  }
  return first;
}

// Decide one tool call.
//   → { decision: 'allow'|'deny'|'ask', reason, rule }
// `mode` is the current permission pill (auto/manual/acceptEdits/plan/bypass).
// A rule-less 'ask' (rule: null) means "no rule applies — let the caller apply
// the mode", which is how main.js's approveTool treats it.
function decide(perms, toolName, args, { cwd = null, mode = 'auto', userPrompt = '' } = {}) {
  const P = perms || { allow: [], deny: [], ask: [] };
  const allow = asArray(P.allow);
  // 1. deny wins outright (any segment of a compound Bash command).
  const d = denyMatch(P, toolName, args, { cwd });
  if (d) return d;
  // 1b. OpenAI Dots-style 4-tier custom rules (`handoff`, `ask`, `explicit`, `auto`).
  const customRules = Array.isArray(P.customRules) ? P.customRules : (Array.isArray(P.raw && P.raw.customRules) ? P.raw.customRules : []);
  for (const cr of customRules) {
    if (!cr || cr.enabled === false || !cr.pattern) continue;
    if (!ruleMatches(cr.pattern, toolName, args, cwd, { any: true })) continue;
    const cm = String(cr.mode || 'ask');
    const label = cr.label || cr.pattern;
    if (cm === 'handoff') {
      return { decision: 'deny', handoff: true, reason: `Hand off to user required by rule "${label}"`, rule: cr.pattern, customMode: cm };
    }
    if (cm === 'ask') {
      return { decision: 'ask', reason: `Rule "${label}" asks before taking action`, rule: cr.pattern, customMode: cm };
    }
    if (cm === 'explicit') {
      const promptLower = String(userPrompt || '').toLowerCase();
      const kws = Array.isArray(cr.keywords) && cr.keywords.length ? cr.keywords : [String(toolName || '').toLowerCase()];
      const explicitOk = promptLower && kws.some((k) => k && promptLower.includes(String(k).toLowerCase()));
      if (explicitOk) return { decision: 'allow', reason: `Explicitly requested by user (${label})`, rule: cr.pattern, customMode: cm };
      return { decision: 'ask', reason: `Rule "${label}" requires explicit request from you`, rule: cr.pattern, customMode: cm };
    }
    if (cm === 'auto') {
      return { decision: 'allow', reason: `Auto-allowed by custom rule "${label}"`, rule: cr.pattern, customMode: cm };
    }
  }
  // 2. ask (any segment).
  for (const rule of asArray(P.ask)) {
    if (ruleMatches(rule, toolName, args, cwd, { any: true })) return { decision: 'ask', reason: `Rule ${rule} requires confirmation`, rule };
  }
  // 3. allow — only an explicit rule; for Bash every segment must be covered.
  if (toolName === 'Bash') {
    const r = bashAllowRule(allow, args);
    if (r) return { decision: 'allow', reason: `Allowed by rule ${r}`, rule: r };
  } else {
    for (const rule of allow) {
      if (ruleMatches(rule, toolName, args, cwd)) return { decision: 'allow', reason: `Allowed by rule ${rule}`, rule };
    }
  }
  // 4. fall back to the session permission mode.
  const m = String(mode || 'auto');
  if (m === 'bypass' || m === 'bypassPermissions') return { decision: 'allow', reason: 'bypass mode', rule: null };
  if (m === 'auto') return { decision: 'allow', reason: 'auto mode', rule: null };
  if (m === 'acceptEdits') {
    // acceptEdits auto-approves file edits only — Bash and other mutating
    // tools still need a prompt.
    if (EDIT_TOOLS.has(toolName) || READ_ONLY_TOOLS.has(toolName)) return { decision: 'allow', reason: 'acceptEdits mode', rule: null };
    return { decision: 'ask', reason: 'acceptEdits mode only auto-approves file edits', rule: null };
  }
  if (m === 'plan' || m === 'planMode') {
    // Plan mode is read-only; the run loop already enforces this, but a rule-less
    // mutating tool should still be denied here for a second line of defence.
    return { decision: 'ask', reason: 'plan mode', rule: null };
  }
  // manual / default
  return { decision: 'ask', reason: 'manual approval', rule: null };
}

const DANGEROUS_BASH_VERBS = new Set([
  'rm', 'rmdir', 'del', 'erase', 'sudo', 'su', 'doas', 'dd', 'mkfs', 'fdisk', 'parted',
  'diskutil', 'shutdown', 'reboot', 'halt', 'poweroff', 'kill', 'pkill', 'killall',
  'chmod', 'chown', 'chgrp', 'mv', 'curl', 'wget', 'nc', 'netcat', 'ncat',
  'eval', 'exec', 'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'powershell', 'pwsh', 'cmd',
  'format', 'reg', 'sc', 'schtasks', 'crontab', 'launchctl', 'systemctl',
]);

const SUBCOMMAND_CLI_TOOLS = new Set([
  'git', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'cargo', 'pip', 'pip3', 'uv',
  'docker', 'podman', 'kubectl', 'helm', 'gh', 'brew', 'apt', 'apt-get', 'go',
]);

function defaultUserSettingsPath() {
  const dir = cc.AUTOBOT_DIR || path.join(os.homedir(), '.autobot');
  return path.join(dir, 'settings.json');
}

function tokenizeSimpleCmd(seg) {
  const out = [];
  const re = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(seg || '')))) {
    out.push(m[1] ?? m[2] ?? m[3]);
    if (out.length >= 6) break;
  }
  return out;
}

// Compute a safe, scoped allow rule string for `Yes, and always allow` / `Yes, and always allow in this conversation`.
// Returns null when the call should NOT be auto-wildcarded (compound chains, redirections, subshells, dangerous verbs, external/sensitive paths).
function suggestSafeAllowRule(toolName, args, cwd = null) {
  const name = String(toolName || '').trim();
  if (!name) return null;
  const a = args || {};

  if (name === 'Bash') {
    const raw = String(primaryArg('Bash', a) || '').trim();
    if (!raw) return null;
    if (/[\r\n`]|\$\(|>>?|<</.test(raw)) return null;
    const segs = splitCommand(raw);
    if (segs.length !== 1) return null;
    const tokens = tokenizeSimpleCmd(segs[0]);
    if (!tokens.length) return null;

    // Skip leading plain ENV=val assignments when checking executable
    let idx = 0;
    while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++;
    if (idx > 0 || idx >= tokens.length) return null;

    const firstToken = tokens[idx];
    const baseVerb = path.basename(firstToken).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
    if (!baseVerb || /[()[\]{}*?$\\/]/.test(firstToken) || DANGEROUS_BASH_VERBS.has(baseVerb)) {
      return null;
    }

    if (SUBCOMMAND_CLI_TOOLS.has(baseVerb) && tokens[idx + 1] && /^[A-Za-z][A-Za-z0-9_-]{0,30}$/.test(tokens[idx + 1])) {
      return `Bash(${firstToken} ${tokens[idx + 1]}:*)`;
    }
    return `Bash(${firstToken}:*)`;
  }

  if (name.startsWith('mcp__')) {
    return name;
  }

  if (EDIT_TOOLS.has(name) || READ_ONLY_TOOLS.has(name)) {
    const rawPath = String(primaryArg(name, a) || '').trim();
    if (!rawPath) return name;
    if (/[*?\r\n()]/.test(rawPath)) return null;
    const norm = rawPath.replace(/\\/g, '/');
    const base = path.posix.basename(norm).toLowerCase();
    if (base === '.env' || base.startsWith('.env.') || norm.includes('/.git/') || norm.endsWith('/.git')) {
      return null;
    }
    if (cwd) {
      try {
        const absCwd = path.resolve(cwd);
        const absTarget = path.resolve(absCwd, rawPath);
        const rel = path.relative(absCwd, absTarget).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
        return `${name}(${rel})`;
      } catch (_) {
        return null;
      }
    }
    if (!path.isAbsolute(rawPath) && !norm.startsWith('..')) {
      return `${name}(${norm.replace(/^\.\//, '')})`;
    }
    return null;
  }

  return null;
}

function readJsonSettings(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeJsonSettings(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function savePermissionRule({ rule, list = 'allow', settingsPath = null } = {}) {
  const clean = String(rule || '').trim();
  const targetList = (list === 'deny' || list === 'ask') ? list : 'allow';
  if (!clean) return { ok: false, error: 'empty rule' };
  const filePath = settingsPath || defaultUserSettingsPath();
  const data = readJsonSettings(filePath);
  const perms = (data.permissions && typeof data.permissions === 'object') ? { ...data.permissions } : {};
  const arr = asArray(perms[targetList]);
  if (!arr.includes(clean)) arr.push(clean);
  perms[targetList] = arr;
  data.permissions = perms;
  writeJsonSettings(filePath, data);
  return { ok: true, rule: clean, list: targetList, settingsPath: filePath, rules: arr };
}

function removePermissionRule({ rule, list = 'allow', settingsPath = null } = {}) {
  const clean = String(rule || '').trim();
  const targetList = (list === 'deny' || list === 'ask') ? list : 'allow';
  if (!clean) return { ok: false, error: 'empty rule' };
  const filePath = settingsPath || defaultUserSettingsPath();
  const data = readJsonSettings(filePath);
  const perms = (data.permissions && typeof data.permissions === 'object') ? { ...data.permissions } : {};
  const prev = asArray(perms[targetList]);
  const next = prev.filter((r) => r !== clean);
  perms[targetList] = next;
  data.permissions = perms;
  writeJsonSettings(filePath, data);
  return { ok: true, removed: prev.length !== next.length, rule: clean, list: targetList, settingsPath: filePath, rules: next };
}

const CUSTOM_MODES = [
  { id: 'auto', label: 'Take action without asking' },
  { id: 'explicit', label: 'Take action when you say so' },
  { id: 'ask', label: 'Ask before taking action' },
  { id: 'handoff', label: 'Hand off to you' },
];

const SAFE_STARTER_PACK = [
  { id: 'starter-external-post', label: 'External messages & webhook POSTs', pattern: 'POST', mode: 'ask', keywords: ['post', 'webhook', 'send message', 'notify'] },
  { id: 'starter-git-push', label: 'Git push & PR merges', pattern: 'Bash(git push:*)', mode: 'ask', keywords: ['git push', 'push to github'] },
  { id: 'starter-deploy', label: 'Production deploys & package publish', pattern: 'Bash(npm publish:*)', mode: 'ask', keywords: ['npm publish', 'deploy'] },
  { id: 'starter-destructive-rm', label: 'Destructive deletes & hard resets', pattern: 'Bash(rm -rf:*)', mode: 'ask', keywords: ['rm -rf', 'delete folder'] },
  { id: 'starter-billing-handoff', label: 'Purchases, billing & account mutations', pattern: 'mcp__billing__*', mode: 'handoff', keywords: [] },
];

function isSafeAllowRule(ruleStr) {
  const s = String(ruleStr || '').trim();
  if (!s) return false;
  if (s === '*' || s === 'Bash(*)' || s === 'Bash(*:*)') return false;
  if (/&&|\|\||;|\r|\n|`|\$\(/.test(s)) return false;
  const parsed = parseRule(s);
  if (parsed.tool === 'Bash' && parsed.specifier) {
    const first = parsed.specifier.split(/\s+/)[0].replace(/:.*$/, '').toLowerCase();
    if (DANGEROUS_BASH_VERBS.has(first)) return false;
  }
  return true;
}

function loadCustomRules(settingsPath = null) {
  const filePath = settingsPath || defaultUserSettingsPath();
  const data = readJsonSettings(filePath);
  const perms = (data.permissions && typeof data.permissions === 'object') ? data.permissions : {};
  return Array.isArray(perms.customRules) ? perms.customRules : [];
}

function saveCustomRule({ id = null, label = '', pattern, mode = 'ask', keywords = [], settingsPath = null } = {}) {
  const cleanPat = String(pattern || '').trim();
  if (!cleanPat) return { ok: false, error: 'Rule pattern is required.' };
  const validModes = new Set(CUSTOM_MODES.map((m) => m.id));
  const cleanMode = validModes.has(mode) ? mode : 'ask';
  const filePath = settingsPath || defaultUserSettingsPath();
  const data = readJsonSettings(filePath);
  const perms = (data.permissions && typeof data.permissions === 'object') ? { ...data.permissions } : {};
  const list = Array.isArray(perms.customRules) ? perms.customRules.slice() : [];
  const rid = id || ('cr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
  const entry = {
    id: rid,
    label: String(label || cleanPat).trim(),
    pattern: cleanPat,
    mode: cleanMode,
    keywords: Array.isArray(keywords) ? keywords : String(keywords || '').split(',').map((s) => s.trim()).filter(Boolean),
    enabled: true,
    updatedAt: Date.now(),
  };
  const idx = list.findIndex((r) => r.id === rid || r.pattern === cleanPat);
  if (idx >= 0) list[idx] = { ...list[idx], ...entry, id: list[idx].id };
  else list.push(entry);
  perms.customRules = list;
  data.permissions = perms;
  writeJsonSettings(filePath, data);
  return { ok: true, rule: entry, customRules: list };
}

function deleteCustomRule({ id, pattern = null, settingsPath = null } = {}) {
  const filePath = settingsPath || defaultUserSettingsPath();
  const data = readJsonSettings(filePath);
  const perms = (data.permissions && typeof data.permissions === 'object') ? { ...data.permissions } : {};
  const list = Array.isArray(perms.customRules) ? perms.customRules : [];
  const next = list.filter((r) => r.id !== id && (!pattern || r.pattern !== pattern));
  perms.customRules = next;
  data.permissions = perms;
  writeJsonSettings(filePath, data);
  return { ok: true, customRules: next };
}

function installSafeStarterPack({ settingsPath = null } = {}) {
  const filePath = settingsPath || defaultUserSettingsPath();
  let customRules = loadCustomRules(filePath);
  for (const r of SAFE_STARTER_PACK) {
    const res = saveCustomRule({ ...r, settingsPath: filePath });
    if (res.ok) customRules = res.customRules;
  }
  return { ok: true, installed: SAFE_STARTER_PACK.length, customRules };
}

module.exports = {
  MODES,
  CUSTOM_MODES,
  SAFE_STARTER_PACK,
  PRIMARY_ARG,
  DANGEROUS_BASH_VERBS,
  loadPermissions,
  loadCustomRules,
  saveCustomRule,
  deleteCustomRule,
  installSafeStarterPack,
  isSafeAllowRule,
  decide,
  denyMatch,
  splitCommand,
  matchBashSegment,
  matchBashAny,
  ruleMatches,
  parseRule,
  matchBash,
  matchGlob,
  primaryArg,
  suggestSafeAllowRule,
  savePermissionRule,
  removePermissionRule,
  defaultUserSettingsPath,
};
