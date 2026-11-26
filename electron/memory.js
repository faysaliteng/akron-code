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

const FILENAMES = ['CLAUDE.md', 'CLAUDE.local.md'];

// Every memory file that applies to `cwd`, in load order.
function memoryFiles(cwd) {
  const files = [];
  const globalUser = path.join(cc.CONFIG_DIR, 'CLAUDE.md');
  const globalHelio = path.join(cc.AUTOBOT_DIR, 'CLAUDE.md');
  for (const f of [globalHelio, globalUser]) if (readFileSafe(f) != null) files.push({ file: f, scope: 'user' });
  if (cwd) {
    for (const dir of ancestorDirs(cwd)) {
      for (const name of FILENAMES) {
        const f = path.join(dir, name);
        if (readFileSafe(f) != null) files.push({ file: f, scope: 'project' });
      }
    }
  }
  return files;
}

// Full concatenated memory block for the system prompt, or '' when there is none.
function loadMemoryText(cwd, { header = true } = {}) {
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

module.exports = {
  MAX_IMPORT_DEPTH,
  MAX_TOTAL_BYTES,
  memoryFiles,
  loadMemoryText,
  listMemory,
  expandImports,
  ancestorDirs,
};
