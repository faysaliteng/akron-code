'use strict';
// Claude-compatible configuration surface.
//
// Helio Bot reads the SAME files Claude Code reads, so a project that already
// has .claude/agents, .claude/commands, CLAUDE.md, .mcp.json or settings.json
// behaves identically here instead of needing to be migrated.
//
//   ~/.claude/                     global config dir (honours CLAUDE_CONFIG_DIR)
//   ~/.claude/settings.json        global settings
//   ~/.claude/agents/*.md          global sub-agent definitions
//   ~/.claude/commands/**/*.md     global custom slash commands
//   ~/.claude/skills/<name>/SKILL.md
//   ~/.claude/output-styles/*.md
//   ~/.claude/CLAUDE.md            global memory
//   <cwd>/.claude/settings.json    project settings
//   <cwd>/.claude/settings.local.json
//   <cwd>/.claude/agents/*.md
//   <cwd>/.claude/commands/**/*.md
//   <cwd>/.claude/skills/<name>/SKILL.md
//   <cwd>/.claude/output-styles/*.md
//   <cwd>/CLAUDE.md, <cwd>/CLAUDE.local.md, parent dirs' CLAUDE.md
//   <cwd>/.mcp.json, ~/.claude.json (mcpServers)
//
// Everything here is a pure fs read — no Electron required, so the parity gate
// can load and exercise it.

const fs = require('fs');
const os = require('os');
const path = require('path');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const AUTOBOT_DIR = path.join(os.homedir(), '.autobot');

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { return null; }
}

// ── frontmatter ────────────────────────────────────────────────────────────
// YAML-lite: enough for every frontmatter block Claude writes. Supports
// scalars, quoted scalars, inline arrays [a, b], block lists (- a), and block
// scalars (| / >). Anything unrecognised is kept as a raw string.
function parseFrontmatter(text) {
  const src = String(text == null ? '' : text);
  if (!/^---\s*\r?\n/.test(src)) return { data: {}, body: src, hasFrontmatter: false };
  const end = src.indexOf('\n---', 3);
  if (end < 0) return { data: {}, body: src, hasFrontmatter: false };
  const head = src.slice(src.indexOf('\n') + 1, end);
  const bodyStart = src.indexOf('\n', end + 1);
  const body = bodyStart < 0 ? '' : src.slice(bodyStart + 1);

  const data = {};
  const lines = head.split(/\r?\n/);
  let lastKey = null;
  let blockIndent = -1;
  let blockMode = null;
  let blockBuf = [];

  const flushBlock = () => {
    if (lastKey && blockMode) {
      data[lastKey] = blockMode === '>' ? blockBuf.join(' ') : blockBuf.join('\n');
    }
    blockMode = null;
    blockIndent = -1;
    blockBuf = [];
  };

  for (const raw of lines) {
    if (blockMode) {
      const indent = raw.match(/^\s*/)[0].length;
      if (raw.trim() === '' || indent > blockIndent) {
        blockBuf.push(raw.slice(blockIndent + 1));
        continue;
      }
      flushBlock();
    }
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    const m = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(raw);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    lastKey = key;
    if (val === '|' || val === '>' || val === '|-' || val === '>-') {
      blockMode = val[0];
      blockIndent = 0;
      blockBuf = [];
      continue;
    }
    if (val === '') {
      // Either a block list on following lines or an empty string.
      data[key] = [];
      continue;
    }
    if (/^\[.*\]$/.test(val)) {
      data[key] = val.slice(1, -1).split(',').map((s) => stripQuotes(s.trim())).filter((s) => s !== '');
      continue;
    }
    if (val === 'true' || val === 'false') { data[key] = val === 'true'; continue; }
    if (/^-?[0-9]+$/.test(val)) { data[key] = Number(val); continue; }
    data[key] = stripQuotes(val);
  }
  flushBlock();

  // Block lists (`- item`) parsed in a second pass, since they follow `key:`.
  if (/\n\s*-\s+/.test(head)) {
    let current = null;
    for (const raw of head.split(/\r?\n/)) {
      const km = /^([A-Za-z0-9_.-]+)\s*:\s*$/.exec(raw);
      if (km) { current = km[1]; continue; }
      const im = /^\s*-\s+(.*)$/.exec(raw);
      if (im && current) {
        if (!Array.isArray(data[current])) data[current] = [];
        data[current].push(stripQuotes(im[1].trim()));
      }
    }
  }

  return { data, body, hasFrontmatter: true };
}

function stripQuotes(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

// ── settings ───────────────────────────────────────────────────────────────
function safeJSON(file) {
  const txt = readText(file);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_) { return null; }
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Arrays are unioned (Claude merges hook/permission arrays across scopes),
// objects are merged, scalars are replaced by the later (more local) scope.
function deepMerge(base, over) {
  if (!isPlainObject(base)) return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (Array.isArray(v) && Array.isArray(out[k])) out[k] = [...out[k], ...v];
    else if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

function settingsFiles(cwd) {
  const files = [
    path.join(CONFIG_DIR, 'settings.json'),
    path.join(AUTOBOT_DIR, 'settings.json'),
  ];
  if (cwd) {
    files.push(path.join(cwd, '.claude', 'settings.json'));
    files.push(path.join(cwd, '.claude', 'settings.local.json'));
  }
  return files;
}

// Merged view of every settings scope, global → project → project-local.
function loadSettings(cwd) {
  let merged = {};
  const sources = [];
  for (const file of settingsFiles(cwd)) {
    const data = safeJSON(file);
    if (!data) continue;
    merged = deepMerge(merged, data);
    sources.push(file);
  }
  return { settings: merged, sources };
}

// ── markdown discovery ─────────────────────────────────────────────────────
function listMarkdown(dir, { recursive = true, maxDepth = 4 } = {}) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > maxDepth) return;
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
        if (recursive) walk(p, depth + 1);
      } else if (/\.md$/i.test(e.name)) {
        out.push(p);
      }
    }
  };
  walk(dir, 0);
  return out.sort();
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch (_) {
    return [];
  }
}

// ── mcp config ─────────────────────────────────────────────────────────────
// Claude reads .mcp.json (project, `mcpServers`) and ~/.claude.json (user).
function loadMcpServers(cwd) {
  const merged = {};
  const sources = [];
  const globalFile = path.join(os.homedir(), '.claude.json');
  const global = safeJSON(globalFile);
  if (global && isPlainObject(global.mcpServers)) {
    Object.assign(merged, global.mcpServers);
    sources.push(globalFile);
  }
  if (cwd) {
    const proj = safeJSON(path.join(cwd, '.mcp.json'));
    if (proj && isPlainObject(proj.mcpServers)) {
      Object.assign(merged, proj.mcpServers);
      sources.push(path.join(cwd, '.mcp.json'));
    }
  }
  const extra = safeJSON(path.join(AUTOBOT_DIR, 'mcp.json'));
  if (extra && isPlainObject(extra.mcpServers)) {
    Object.assign(merged, extra.mcpServers);
    sources.push(path.join(AUTOBOT_DIR, 'mcp.json'));
  }
  return { servers: merged, sources };
}

module.exports = {
  CONFIG_DIR,
  AUTOBOT_DIR,
  ensureDir,
  readText,
  safeJSON,
  parseFrontmatter,
  loadSettings,
  settingsFiles,
  deepMerge,
  listMarkdown,
  listDirs,
  loadMcpServers,
};
