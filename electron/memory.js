'use strict';
// Project memory — Example's CLAUDE.md hierarchy.
//
// Claude Code loads, in order, and concatenates:
//   ~/.claude/CLAUDE.md                  (global user memory)
//   <ancestor dirs>/CLAUDE.md            (root → cwd, project memory)
//   <cwd>/CLAUDE.md
//   <cwd>/CLAUDE.local.md                (private, gitignored)
//
// plus any `@path/to/file` imports (transitively, depth ≤ 5). Akron Bot reads
// the same files so an existing project's instructions apply unchanged, and it
// also accepts ~/.autobot/CLAUDE.md as a Helio-only global layer.

const fs = require('fs');
const path = require('path');
const os = require('os');
const cc = require('./claudeconfig');

const MAX_IMPORT_DEPTH = 5;
const MAX_TOTAL_BYTES = 120 * 1024; // keep memory from eating the context window

const DEFAULT_AGENTS_MD = `# Akron Code Agent Instructions (AGENTS.md)

These standing instructions apply across your Akron Code sessions unless overridden in a project workspace \`AGENTS.md\`.

## 1. Execution & Engineering Standards
- Read relevant files and search symbols before proposing or making edits.
- Keep edits clean, minimal, and consistent with the surrounding codebase architecture.
- After code changes, run relevant tests, typechecks, or linters and report only directly observed results and exact file paths.
- Never fabricate test passes, file paths, command outputs, or unverified behavior.

## 2. Built-In Akron Code Capabilities
- **Parallel Orchestration:** Use \`Swarm\` or \`Task\`/\`Agent\` when work splits cleanly across independent modules, files, or research angles.
- **Live Browser Control (\`:8766\` Bridge):** Use \`ext_browser\` (\`list_tabs\`, \`open_tab\`, \`close_tab\`, \`navigate\`, \`read_page\`, \`click\`, \`type\`, \`execute_javascript\`, \`screenshot\`) to automate the user's connected Chrome, Brave, or Edge tabs.
- **Desktop Computer Use (\`mcp__computer__*\`):** Use \`screenshot\`, \`zoom\`, \`app_screenshot\`, \`ax_find\`, and \`batch\` (1x logical coordinates with smooth cursor control across macOS, Windows 11, and Linux). Pause if the user stops execution with \`Esc\` or the HUD Stop button.
- **Diagnostics & Reverse Engineering:** Use \`ShadowCheck\`, \`REPL\`, and \`rea\` when verifying scripts, binaries, or packaged Electron bundles.

## 3. Workspace & Security Hygiene
- Keep changes scoped to the active project workspace; never leak API keys, OAuth tokens, or credentials into code, commits, or logs.
`;

function readFileSafe(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

// Resolve `@relative/or/absolute` import lines. A line that is exactly an import
// (optionally indented) is replaced by the imported file's contents, recursively.
function expandImports(text, baseDir, depth = 0, seen = new Set(), budget = { bytes: 0 }) {
  if (len(text) >= MAX_TOTAL_BYTES || budget.bytes >= MAX_TOTAL_BYTES) return text;
  if (depth > MAX_IMPORT_DEPTH) return text;
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const m = /^\s*@([^\s]+)\s*$/.exec(line);
    if (!m) { out.push(line); continue; }
    const spec = m[1].replace(/^~(?=$|\/)/, os.homedir());
    const target = path.isAbsolute(spec) ? spec : path.resolve(baseDir, spec);
    if (seen.has(target)) { out.push(`<!-- @${spec} (already imported) -->`); continue; }
    const content = readFileSafe(target);
    if (content == null) { out.push(`<!-- @${spec} (not found) -->`); continue; }
    seen.add(target);
    const grown = expandImports(content, path.dirname(target), depth + 1, seen, budget);
    budget.bytes += grown.length;
    out.push(grown.trimEnd());
  }
  return out.join('\n');
}

function len(s) { return Buffer.byteLength(String(s || ''), 'utf8'); }

// Ancestor directories from filesystem root down to cwd (inclusive).
function ancestorDirs(cwd) {
  const abs = path.resolve(cwd || process.cwd());
  const parts = abs.split(path.sep).filter(Boolean);
  const dirs = [];
  let acc = path.sep;
  for (const p of parts) {
    acc = path.join(acc, p);
    dirs.push(acc);
  }
  return dirs;
}

const GLOBAL_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const FILENAMES = ['AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md', 'CLAUDE.local.md'];

function globalDir() {
  return process.env.HOME ? path.join(process.env.HOME, '.autobot') : cc.AUTOBOT_DIR;
}

function claudeDir() {
  return process.env.HOME ? path.join(process.env.HOME, '.claude') : cc.CONFIG_DIR;
}

function globalAgentsPath() {
  return path.join(globalDir(), 'AGENTS.md');
}

function ensureDefaultGlobalAgentsMd() {
  try {
    const dir = globalDir();
    const target = globalAgentsPath();
    const legacy = path.join(dir, 'CLAUDE.md');
    if (!fs.existsSync(target) && !fs.existsSync(legacy)) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, DEFAULT_AGENTS_MD, 'utf8');
    }
    return target;
  } catch (_) {
    return globalAgentsPath();
  }
}

// Every memory file that applies to `cwd`, in load order.
function memoryFiles(cwd) {
  const files = [];
  const seen = new Set();
  const pushIfReadable = (f, scope) => {
    const abs = path.resolve(f);
    if (seen.has(abs)) return;
    if (readFileSafe(abs) != null) {
      seen.add(abs);
      files.push({ file: abs, scope });
    }
  };
  for (const name of GLOBAL_FILENAMES) pushIfReadable(path.join(globalDir(), name), 'user');
  for (const name of GLOBAL_FILENAMES) pushIfReadable(path.join(claudeDir(), name), 'user');
  if (cwd) {
    for (const dir of ancestorDirs(cwd)) {
      for (const name of FILENAMES) {
        pushIfReadable(path.join(dir, name), 'project');
      }
    }
  }
  return files;
}

// Full concatenated memory block for the system prompt, or '' when there is none.
function loadMemoryText(cwd, { header = true } = {}) {
  if (!process.env.NODE_TEST_CONTEXT) ensureDefaultGlobalAgentsMd();
  const files = memoryFiles(cwd);
  if (!files.length) return '';
  const seen = new Set(files.map((f) => f.file));
  const blocks = [];
  let total = 0;
  for (const { file, scope } of files) {
    const raw = readFileSafe(file);
    if (raw == null) continue;
    const expanded = expandImports(raw, path.dirname(file), 0, seen, { bytes: 0 });
    const body = expanded.trim();
    if (!body) continue;
    total += len(body);
    if (total > MAX_TOTAL_BYTES) {
      const remain = MAX_TOTAL_BYTES - (total - len(body));
      if (remain > 0) blocks.push(`# Memory: ${file}\n${body.slice(0, remain)}…`);
      break;
    }
    blocks.push(`# Memory: ${file}\n${body}`);
  }
  if (!blocks.length) {
    try {
      const curatorBlock = require('./memory-curator').formatCuratedPromptBlock();
      if (curatorBlock) return (header ? 'The following is curated user memory:\n' : '') + curatorBlock;
    } catch (_) {}
    return '';
  }
  try {
    const curatorBlock = require('./memory-curator').formatCuratedPromptBlock();
    if (curatorBlock) blocks.push(curatorBlock);
  } catch (_) {}
  const head = header
    ? 'The following is project/user memory (CLAUDE.md). Treat it as standing instructions that apply for the whole session:\n'
    : '';
  return head + blocks.join('\n\n');
}

// Structured view for the UI (Settings → Memory).
function listMemory(cwd) {
  return memoryFiles(cwd).map(({ file, scope }) => {
    const raw = readFileSafe(file) || '';
    return {
      file,
      scope,
      bytes: len(raw),
      lines: raw ? raw.split(/\r?\n/).length : 0,
      preview: raw.split(/\r?\n/).slice(0, 6).join('\n'),
    };
  });
}

// Structured view for the UI (Settings → AGENTS.md editor).
function getAgentsMdState(cwd) {
  const gPath = ensureDefaultGlobalAgentsMd();
  const gRaw = readFileSafe(gPath);
  const pPath = cwd ? path.join(path.resolve(cwd), 'AGENTS.md') : '';
  const pRaw = pPath ? readFileSafe(pPath) : null;
  return {
    ok: true,
    globalPath: gPath,
    globalExists: gRaw != null,
    globalContent: gRaw != null ? gRaw : DEFAULT_AGENTS_MD,
    projectPath: pPath,
    projectExists: pRaw != null,
    projectContent: pRaw != null ? pRaw : '',
    defaultContent: DEFAULT_AGENTS_MD,
  };
}

function saveAgentsMd({ scope = 'global', cwd = '', content = '' } = {}) {
  const target = scope === 'project'
    ? (cwd ? path.join(path.resolve(cwd), 'AGENTS.md') : '')
    : globalAgentsPath();
  if (!target) return { ok: false, error: 'Open a workspace folder before saving project AGENTS.md.' };
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, String(content == null ? '' : content), 'utf8');
  return { ...getAgentsMdState(cwd), savedPath: target };
}

function resetAgentsMd({ scope = 'global', cwd = '' } = {}) {
  return saveAgentsMd({ scope, cwd, content: DEFAULT_AGENTS_MD });
}

module.exports = {
  MAX_IMPORT_DEPTH,
  MAX_TOTAL_BYTES,
  DEFAULT_AGENTS_MD,
  globalAgentsPath,
  ensureDefaultGlobalAgentsMd,
  getAgentsMdState,
  saveAgentsMd,
  resetAgentsMd,
  memoryFiles,
  loadMemoryText,
  listMemory,
  expandImports,
  ancestorDirs,
};
