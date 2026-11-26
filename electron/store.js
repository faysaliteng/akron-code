'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.autobot');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ORCHESTRATOR_FILE = path.join(DATA_DIR, 'orchestrator.json');
const FEATURES_FILE = path.join(DATA_DIR, 'features.json');
const SKILLS_DIR = path.join(DATA_DIR, 'skills');
const SKILLS_STATE_FILE = path.join(DATA_DIR, 'skills-state.json');
const NOTEBOOKS_DIR = path.join(DATA_DIR, 'notebooks');
// Bundled skills (including Claude Desktop bundled skills and built-in REA skill).
const BUNDLED_SKILLS_DIR = (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'skills')))
  ? path.join(process.resourcesPath, 'skills')
  : path.join(__dirname, '..', 'resources', 'skills');
// External skill source discovered on-disk (Claude Code built-in skills).
//
// Note: the ~/.config/opencode/skill tree (236 offensive-security skills) was
// deliberately removed from the in-app catalogue on 2026-11-25. Those skills
// now live outside the app as plain Markdown under ~/Example Skills/ and are
// no longer injected into prompts, because their volume drowned out the
// project's own coding/build guidance. See `scripts/export-skills.py`.
const CLAUDE_SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

// `~/.autobot` holds API keys (settings.provider.apiKey, pool rows' apiKey,
// account tokens) and is meant to be user-private. The directory shipped 0755
// and every JSON was written 0644 — i.e. readable by any local account — so the
// 0600 on settings.json/secrets.json only ever held because it was chmod'd by
// hand. Tighten the directory once at load and write every JSON 0600.
try { if (fs.existsSync(DATA_DIR)) fs.chmodSync(DATA_DIR, 0o700); } catch (_) {}
// Legacy files written by older builds stay 0644 until something rewrites
// them; normalise the whole JSON set once per launch.
try {
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/\.json$/.test(f)) continue;
    try { fs.chmodSync(path.join(DATA_DIR, f), 0o600); } catch (_) {}
  }
} catch (_) {}

function readJSON(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function writeJSON(file, data) {
  ensureDir(path.dirname(file));
  // Atomic rename prevents a crash mid-write from leaving an empty/corrupt JSON.
  const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

// ---- Memory (.auto-memory) ----
function getMemory() {
  return readJSON(MEMORY_FILE, { entries: [] });
}

function addMemory(content) {
  const m = getMemory();
  m.entries.push({ content, ts: Date.now() });
  if (m.entries.length > 500) m.entries = m.entries.slice(-500);
  writeJSON(MEMORY_FILE, m);
  return m;
}

function clearMemory() {
  writeJSON(MEMORY_FILE, { entries: [] });
  return { entries: [] };
}

function deleteMemory(index) {
  const m = getMemory();
  const i = Number(index);
  if (Number.isNaN(i) || i < 0 || i >= m.entries.length) return { ok: false, error: 'index out of range' };
  m.entries.splice(i, 1);
  writeJSON(MEMORY_FILE, m);
  return { ok: true, entries: m.entries };
}

function memoryAsText() {
  const m = getMemory();
  if (!m.entries.length) return '(no saved memory)';
  return m.entries.map((e, i) => `[${i}] ${new Date(e.ts).toISOString()} — ${e.content}`).join('\n');
}

// ---- Settings ----
function getSettings() {
  return readJSON(SETTINGS_FILE, { theme: 'dark' });
}

function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  writeJSON(SETTINGS_FILE, s);
  return s;
}

// ---- Skills ----
// The 7 Claude Desktop bundled skills (manifest from Claude.app v6.28899.6).
const BUNDLED_SKILLS = [
  { name: 'docx', description: 'Use this skill whenever the user wants to create, read, edit, or manipulate Word documents (.docx) or Word templates (.dotx). Triggers include: any mention of Microsoft Word Documents, such as "Word doc", ".docx", ".dotx", "microsoft doc". Also use when extracting or reorganizing content from .docx/.dotx files, inserting/replacing images, find-and-replace, tracked changes/comments, or converting content into a polished Word document. Do NOT use for PDFs, spreadsheets, Google Docs, or unrelated coding.' },
  { name: 'pdf', description: 'Use this skill whenever the user wants to do anything with PDF files: reading or extracting text/tables, combining/merging, splitting, rotating pages, adding watermarks, creating PDFs, filling forms, encrypting/decrypting, extracting images, and OCR on scanned PDFs.' },
  { name: 'pdf-reading', description: 'Use when you need to read, inspect, or extract content from PDF files — especially when content is NOT in context and must be read from disk. Covers content inventory, text extraction, page rasterization, embedded image/attachment/table/form-field extraction, and choosing the right reading strategy.' },
  { name: 'pptx', description: 'Use any time a .pptx or .potx file is involved — creating slide decks/presentations, reading/parsing/extracting text, editing/updating, combining/splitting, templates, speaker notes, or comments.' },
  { name: 'xlsx', description: 'Use any time a spreadsheet file is the primary input or output — open/read/edit/fix .xlsx/.xlsm/.xltx/.csv/.tsv, add columns, compute formulas, formatting, charting, cleaning messy data, or converting between tabular formats.' },
  { name: 'frontend-design', description: 'Guidance for distinctive, intentional visual design when building new UI or reshaping an existing one. Helps with aesthetic direction, typography, and choices that don\'t read as templated defaults.' },
  { name: 'draft-design-system', description: 'Draft a design system from a brand\'s own material (logos, fonts, colours, guidelines, codebase) as a folder of plain files — brand book, tokens, font files, components. Use when someone asks for a design system, brand kit, brand guidelines or style guide.' },
  { name: 'reverse-engineer-anything', description: 'Reverse engineer native, managed, Electron/JavaScript, packaged, firmware, and browser targets with built-in REA (263 MCP tools & CLI), audit release exposure, decompile code, and build AgentEnv bundles.' },
];

// ---- YAML frontmatter parser (name + description + domain/metadata) ----
function parseSkillFrontmatter(text) {
  const m = /^---\s*\n([\s\S]*?)\n(?:---|\.\.\.)\s*(?:\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1].split('\n');
  const out = {};
  let key = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val === '>' || val === '|') {
        const parts = [];
        while (i + 1 < lines.length && /^\s+/.test(lines[i + 1])) {
          i++;
          parts.push(lines[i].trim());
        }
        val = parts.join(val === '>' ? ' ' : '\n');
      }
      out[key] = val;
    }
  }
  return out;
}

// ---- Skill discovery (bundled + Claude Code + custom) ----
let _skillsCache = null;

function addDirSkills(list, seen, dir, source) {
  if (!fs.existsSync(dir)) return;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (_) { return; }
  for (const e of entries) {
    const skillFile = path.join(dir, e, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let fm = null;
    try { fm = parseSkillFrontmatter(fs.readFileSync(skillFile, 'utf8')); } catch (_) {}
    const name = (fm && fm.name) || e;
    if (seen.has(name)) continue;
    seen.add(name);
    list.push({
      name,
      description: (fm && fm.description) || '',
      source,
      file: skillFile,
    });
  }
}

function discoverSkills() {
  if (_skillsCache) return _skillsCache;
  const list = [];
  const seen = new Set();

  // 1. Bundled Akron Bot / Desktop skills (always present).
  for (const s of BUNDLED_SKILLS) {
    seen.add(s.name);
    list.push({
      ...s,
      source: 'bundled',
      bundled: true,
      file: path.join(BUNDLED_SKILLS_DIR, s.name, 'SKILL.md'),
    });
  }

  // 2. Claude Code skills (~/.claude/skills/*/SKILL.md).
  addDirSkills(list, seen, CLAUDE_SKILLS_DIR, 'claude');
  // Claude Code "synced" skills (~/.claude/skills/synced/<uuid>/*/SKILL.md).
  const synced = path.join(CLAUDE_SKILLS_DIR, 'synced');
  if (fs.existsSync(synced)) {
    let subs = [];
    try { subs = fs.readdirSync(synced); } catch (_) {}
    for (const sub of subs) addDirSkills(list, seen, path.join(synced, sub), 'claude');
  }

  // 3. Custom user skills (~/.autobot/skills/<slug>.md and ~/.autobot/skills/<slug>/SKILL.md).
  ensureDir(SKILLS_DIR);
  addDirSkills(list, seen, SKILLS_DIR, 'custom');
  try {
    for (const f of fs.readdirSync(SKILLS_DIR)) {
      if (!f.endsWith('.md')) continue;
      const name = f.replace(/\.md$/, '');
      if (seen.has(name)) continue;
      seen.add(name);
      const file = path.join(SKILLS_DIR, f);
      let fm = null;
      try { fm = parseSkillFrontmatter(fs.readFileSync(file, 'utf8')); } catch (_) {}
      list.push({
        name: (fm && fm.name) || name,
        description: (fm && fm.description) || (name + ' (custom skill)'),
        source: 'custom',
        custom: true,
        file,
      });
    }
  } catch (_) {}

  _skillsCache = list;
  return list;
}

// ---- Custom skill authoring (user-uploaded .md) ----
function slugifySkill(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || ('skill-' + Date.now().toString(36));
}

// Extract a description if the uploaded file has no frontmatter: first
// non-heading, non-empty line.
function fallbackDescription(text) {
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#') || l.startsWith('---') || l.startsWith('```')) continue;
    return l.slice(0, 240);
  }
  return '';
}

function addCustomSkill(name, content) {
  content = String(content == null ? '' : content);
  if (!content.trim()) return { ok: false, error: 'Skill content is empty.' };
  ensureDir(SKILLS_DIR);
  const fm = parseSkillFrontmatter(content);
  const displayName = (fm && fm.name) || String(name || '').replace(/\.md$/i, '').trim() || slugifySkill(name);
  const slug = slugifySkill(displayName);
  // If the file already has a name in frontmatter we keep the original text.
  // Otherwise prepend a minimal frontmatter so the skill is discoverable with a
  // proper name + description.
  let body = content;
  if (!fm) {
    const desc = fallbackDescription(content).replace(/\n/g, ' ').replace(/"/g, "'");
    body = `---\nname: ${displayName}\ndescription: "${desc}"\n---\n\n` + content;
  }
  const file = path.join(SKILLS_DIR, slug + '.md');
  fs.writeFileSync(file, body, 'utf8');
  _skillsCache = null;
  return { ok: true, name: (fm && fm.name) || displayName, slug, file };
}

function deleteCustomSkill(name) {
  const skills = discoverSkills();
  const entry = skills.find((s) => s.name === name && s.source === 'custom');
  if (!entry) return { ok: false, error: `No custom skill named "${name}".` };
  try {
    fs.unlinkSync(entry.file);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // Remove any leftover empty directory (for <slug>/SKILL.md skills).
  try {
    const dir = path.dirname(entry.file);
    if (dir !== SKILLS_DIR && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
  } catch (_) {}
  _skillsCache = null;
  const state = getSkillState();
  if (state.disabled && state.disabled.includes(name)) {
    writeJSON(SKILLS_STATE_FILE, { disabled: state.disabled.filter((n) => n !== name) });
  }
  return { ok: true, name };
}

function getSkillState() {
  return readJSON(SKILLS_STATE_FILE, { disabled: [] });
}

function getSkills() {
  const state = getSkillState();
  const disabled = new Set(state.disabled || []);
  return discoverSkills().map((s) => ({ ...s, enabled: !disabled.has(s.name) }));
}

function setSkillEnabled(name, enabled) {
  const state = getSkillState();
  const disabled = new Set(state.disabled || []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  writeJSON(SKILLS_STATE_FILE, { disabled: [...disabled] });
  return getSkills();
}

function setAllSkillsEnabled(enabled) {
  if (enabled) writeJSON(SKILLS_STATE_FILE, { disabled: [] });
  else writeJSON(SKILLS_STATE_FILE, { disabled: discoverSkills().map((s) => s.name) });
  return getSkills();
}

function loadSkill(name) {
  const skills = discoverSkills();
  const entry = skills.find((s) => s.name === name);
  if (entry && entry.file && fs.existsSync(entry.file)) {
    return fs.readFileSync(entry.file, 'utf8');
  }
  // Fallbacks for backward compatibility.
  if (BUNDLED_SKILLS.some((s) => s.name === name)) {
    const file = path.join(BUNDLED_SKILLS_DIR, name, 'SKILL.md');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  }
  const file = path.join(SKILLS_DIR, name + '.md');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8');
  return null;
}

// ---- Notebooks ----
function listNotebooks() {
  ensureDir(NOTEBOOKS_DIR);
  try {
    return fs.readdirSync(NOTEBOOKS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch (_) {
    return [];
  }
}

function getNotebook(name) {
  const file = path.join(NOTEBOOKS_DIR, name + '.json');
  return readJSON(file, { name, cells: [] });
}

function writeNotebook(name, cells) {
  ensureDir(NOTEBOOKS_DIR);
  writeJSON(path.join(NOTEBOOKS_DIR, name + '.json'), { name, cells, ts: Date.now() });
  return { name, cells };
}

function deleteNotebook(name) {
  try { fs.unlinkSync(path.join(NOTEBOOKS_DIR, name + '.json')); } catch (_) {}
  return true;
}

// ---- Orchestrator (multi-provider failover) ----
// Profile shape: { enabled: bool, providers: [ { id, name, baseURL, apiKey, model } ] }
function getOrchestrator() {
  return readJSON(ORCHESTRATOR_FILE, {
    enabled: false,
    providers: [],
    activeIndex: -1,
  });
}

function setOrchestrator(patch) {
  const o = { ...getOrchestrator(), ...patch };
  writeJSON(ORCHESTRATOR_FILE, o);
  return o;
}

// ---- Feature toggles (computer use / chrome / bridges / developer / buddy) ----
function getFeatures() {
  return readJSON(FEATURES_FILE, {
    computerUse: true,         // Computer Use (screen + mouse + keyboard) — ON by default, Claude Desktop parity
    chrome: false,
    bridges: false,
    chromeHost: '127.0.0.1',
    chromePort: 9222,
    // Claude Desktop parity extras (local equivalents of the REA-mapped surfaces):
    extensions: false,        // Extensions / "Settings › Developer" worker host
    developerMode: false,     // developer-only toggles (local-exec consent, debug overlays)
    buddy: false,             // Buddy / Hardware Buddy device control
    remoteControl: false,     // Remote Control trust-folders + pairing
    computerUseTeach: false,  // Computer Use teach / watch-record
    quickEntry: true,         // menu-bar Quick Entry window + global hotkey
    trustedFolders: false,    // trusted-folder pre-approval for shell exec / Remote-Control file access
  });
}

function setFeatures(patch) {
  const f = { ...getFeatures(), ...patch };
  writeJSON(FEATURES_FILE, f);
  return f;
}

module.exports = {
  DATA_DIR,
  getMemory,
  addMemory,
  clearMemory,
  deleteMemory,
  memoryAsText,
  getSettings,
  setSettings,
  getSkills,
  loadSkill,
  addCustomSkill,
  deleteCustomSkill,
  setSkillEnabled,
  setAllSkillsEnabled,
  listNotebooks,
  getNotebook,
  writeNotebook,
  deleteNotebook,
  getOrchestrator,
  setOrchestrator,
  getFeatures,
  setFeatures,
};
