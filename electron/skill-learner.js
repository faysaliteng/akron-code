'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');

const CATEGORIES = ['architecture', 'build-test', 'style', 'pitfalls', 'workflow', 'general'];
const DEFAULT_USER_SKILLS_DIR = path.join(os.homedir(), '.autobot', 'skills');

function normalizeCategory(cat) {
  const c = String(cat || 'general').trim().toLowerCase();
  return CATEGORIES.includes(c) ? c : 'general';
}

function slugify(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || ('skill-' + Date.now().toString(36));
}

function normText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[`*_#\[\](),;:!?]/g, ' ')
    .replace(/\.+(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenJaccard(a, b) {
  const ta = new Set(normText(a).split(' ').filter((x) => x.length >= 3));
  const tb = new Set(normText(b).split(' ').filter((x) => x.length >= 3));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function readJsonSafe(file, fallback) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return fallback;
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

/**
 * Add a categorized, deduplicated memory entry (user ~/.autobot/memory.json + optional project .akron/MEMORY.md).
 */
function addStructuredMemory({
  content,
  category = 'general',
  scope = 'user',
  cwd = null,
  memoryFile = null,
} = {}) {
  const clean = String(content || '').trim();
  if (!clean) return { ok: false, error: 'Memory content is required.' };
  const cat = normalizeCategory(category);
  const mdBullet = clean.startsWith('[') ? clean : `[${cat}] ${clean}`;

  const memPath = memoryFile || path.join(store.DATA_DIR || path.join(os.homedir(), '.autobot'), 'memory.json');
  const data = memoryFile ? readJsonSafe(memPath, { entries: [] }) : store.getMemory();
  const entries = Array.isArray(data.entries) ? data.entries : [];

  const targetNorm = normText(clean);
  for (let i = 0; i < entries.length; i++) {
    const rawExisting = typeof entries[i] === 'string' ? entries[i] : (entries[i] && entries[i].content) || '';
    const strippedExisting = rawExisting.replace(/^\[[a-z-]+\]\s*/i, '');
    const existingNorm = normText(strippedExisting);
    if (existingNorm === targetNorm || tokenJaccard(strippedExisting, clean) >= 0.70) {
      entries[i] = {
        content: clean,
        category: cat,
        scope,
        ts: Date.now(),
        hits: ((entries[i] && entries[i].hits) || 1) + 1,
      };
      writeJsonAtomic(memPath, { entries });
      return { ok: true, deduplicated: true, category: cat, content: clean, total: entries.length };
    }
  }

  entries.push({ content: clean, category: cat, scope, ts: Date.now(), hits: 1 });
  const trimmed = entries.length > 500 ? entries.slice(-500) : entries;
  writeJsonAtomic(memPath, { entries: trimmed });

  let projectMemoryPath = null;
  if (scope === 'project' && cwd) {
    try {
      const dir = path.join(path.resolve(cwd), '.akron');
      fs.mkdirSync(dir, { recursive: true });
      projectMemoryPath = path.join(dir, 'MEMORY.md');
      const existingMd = fs.existsSync(projectMemoryPath) ? fs.readFileSync(projectMemoryPath, 'utf8') : '# Project Memory\n\n';
      if (!normText(existingMd).includes(targetNorm)) {
        fs.writeFileSync(projectMemoryPath, existingMd.replace(/\s*$/, '\n') + `- ${mdBullet}\n`, 'utf8');
      }
    } catch (_) {}
  }

  return {
    ok: true,
    deduplicated: false,
    category: cat,
    content: clean,
    total: trimmed.length,
    projectMemoryPath,
  };
}

/**
 * Extract a solved debugging / build / workflow procedure into a reusable SKILL.md on disk.
 */
function extractSkillToDisk({
  name,
  description = '',
  triggers = [],
  steps = [],
  pitfalls = [],
  verification = '',
  content = '',
  scope = 'user',
  cwd = null,
  userSkillsDir = DEFAULT_USER_SKILLS_DIR,
} = {}) {
  const rawName = String(name || '').trim();
  if (!rawName) return { ok: false, error: 'Skill name is required.' };
  const slug = slugify(rawName);
  const desc = String(description || `Reusable skill for ${rawName}`).replace(/\s+/g, ' ').replace(/"/g, "'").trim();

  const triggerList = Array.isArray(triggers) ? triggers : String(triggers || '').split(',').map((s) => s.trim()).filter(Boolean);
  const stepList = Array.isArray(steps) ? steps.filter(Boolean) : (steps ? [String(steps)] : []);
  const pitfallList = Array.isArray(pitfalls) ? pitfalls.filter(Boolean) : (pitfalls ? [String(pitfalls)] : []);

  let bodyMd = String(content || '').trim();
  if (!bodyMd) {
    const parts = [`# ${rawName}`, '', desc, ''];
    if (triggerList.length) {
      parts.push('## When to Use', ...triggerList.map((t) => `- ${t}`), '');
    }
    if (stepList.length) {
      parts.push('## Workflow', ...stepList.map((s, idx) => `${idx + 1}. ${s}`), '');
    }
    if (pitfallList.length) {
      parts.push('## Pitfalls & Gotchas', ...pitfallList.map((p) => `- ${p}`), '');
    }
    if (verification) {
      parts.push('## Verification', String(verification).trim(), '');
    }
    bodyMd = parts.join('\n').trim() + '\n';
  }

  const frontmatter = [
    '---',
    `name: ${slug}`,
    `description: "${desc}"`,
    ...(triggerList.length ? [`triggers: [${triggerList.map((t) => JSON.stringify(t)).join(', ')}]`] : []),
    '---',
    '',
  ].join('\n');

  const fullDoc = bodyMd.startsWith('---') ? bodyMd : (frontmatter + bodyMd);
  const baseDir = scope === 'project' && cwd
    ? path.join(path.resolve(cwd), '.claude', 'skills', slug)
    : path.join(userSkillsDir, slug);
  fs.mkdirSync(baseDir, { recursive: true });
  const filePath = path.join(baseDir, 'SKILL.md');
  fs.writeFileSync(filePath, fullDoc, 'utf8');

  // Also ensure custom skill cache picks it up when scope is user
  try {
    if (scope !== 'project' && userSkillsDir === DEFAULT_USER_SKILLS_DIR && typeof store.setSkillEnabled === 'function') {
      store.setSkillEnabled(slug, true);
    }
  } catch (_) {}

  return { ok: true, slug, name: slug, scope, file: filePath, bytes: Buffer.byteLength(fullDoc, 'utf8') };
}

module.exports = {
  CATEGORIES,
  DEFAULT_USER_SKILLS_DIR,
  slugify,
  addStructuredMemory,
  extractSkillToDisk,
};
