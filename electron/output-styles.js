'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const cc = require('./claudeconfig');

function resolveStyleRoots() {
  return {
    claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    autobotDir: process.env.AUTOBOT_HOME || path.join(os.homedir(), '.autobot'),
  };
}

const BUILTIN_OUTPUT_STYLES = [
  { id: 'default', name: 'Default', hint: 'Balanced workspace assistant', description: 'Standard clear responses balanced between conciseness and detail.', prompt: '', directive: '', scope: 'builtin', custom: false },
  { id: 'concise', name: 'Concise', hint: 'Keep it short', description: 'Short answers, bullet points, zero preamble.', prompt: 'Be concise and direct. Prefer short answers, bullet points, and skip preamble.', directive: 'Be concise and direct. Prefer short answers, bullet points, and skip preamble.', scope: 'builtin', custom: false },
  { id: 'explanatory', name: 'Explanatory', hint: 'Explain everything', description: 'Thorough explanations with definitions, context, and step-by-step reasoning.', prompt: 'Explain concepts thoroughly. Define terms, give context, and walk through reasoning step by step.', directive: 'Explain concepts thoroughly. Define terms, give context, and walk through reasoning step by step.', scope: 'builtin', custom: false },
  { id: 'formal', name: 'Formal', hint: 'Professional tone', description: 'Formal executive tone without slang or contractions.', prompt: 'Use a formal, professional tone. Avoid slang and contractions. Structure answers clearly.', directive: 'Use a formal, professional tone. Avoid slang and contractions. Structure answers clearly.', scope: 'builtin', custom: false },
  { id: 'casual', name: 'Casual', hint: 'Friendly tone', description: 'Friendly, approachable conversational tone.', prompt: 'Use a friendly, casual, conversational tone.', directive: 'Use a friendly, casual, conversational tone.', scope: 'builtin', custom: false },
  { id: 'code', name: 'Code-first', hint: 'Prioritize code', description: 'Lead with working runnable snippets and diffs over prose.', prompt: 'Prioritize working code and concrete examples over prose. Include full, runnable snippets.', directive: 'Prioritize working code and concrete examples over prose. Include full, runnable snippets.', scope: 'builtin', custom: false },
];

const BUILTIN_IDS = new Set(BUILTIN_OUTPUT_STYLES.map((s) => s.id));

function slugifyId(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function configPath() {
  return path.join(resolveStyleRoots().autobotDir, 'output-styles.json');
}

function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeConfig(next) {
  cc.ensureDir(resolveStyleRoots().autobotDir);
  fs.writeFileSync(configPath(), JSON.stringify(next || {}, null, 2) + '\n', { mode: 0o600 });
}

function styleDirs(cwd) {
  const { claudeDir, autobotDir } = resolveStyleRoots();
  const dirs = [
    { dir: path.join(claudeDir, 'output-styles'), scope: 'global', storage: 'claude' },
    { dir: path.join(autobotDir, 'output-styles'), scope: 'global', storage: 'autobot' },
  ];
  if (cwd) {
    dirs.push({ dir: path.join(cwd, '.claude', 'output-styles'), scope: 'workspace', storage: 'workspace' });
  }
  return dirs;
}

function parseStyleFile(file, meta) {
  const raw = cc.readText(file);
  if (raw == null) return null;
  const { data, body } = cc.parseFrontmatter(raw);
  const base = path.basename(file).replace(/\.md$/i, '');
  const id = slugifyId(data.id || base);
  if (!id) return null;
  const name = String(data.name || base).trim() || id;
  const hint = String(data.hint || data.description || '').trim();
  const directive = String(body || '').trim();
  return {
    id,
    name,
    hint,
    description: String(data.description || hint || `Custom output style (${name})`).trim(),
    prompt: directive,
    directive,
    scope: meta.scope,
    storage: meta.storage,
    file,
    custom: true,
  };
}

function listOutputStyles(cwd = '') {
  const cfg = readConfig();
  const byId = new Map();
  for (const b of BUILTIN_OUTPUT_STYLES) {
    byId.set(b.id, { ...b });
  }
  for (const dirSpec of styleDirs(cwd)) {
    for (const file of cc.listMarkdown(dirSpec.dir, { recursive: false })) {
      const parsed = parseStyleFile(file, dirSpec);
      if (!parsed) continue;
      if (BUILTIN_IDS.has(parsed.id)) {
        // Keep built-in metadata unless user explicitly authored an override
        const prev = byId.get(parsed.id) || {};
        byId.set(parsed.id, { ...prev, ...parsed, custom: true });
      } else {
        byId.set(parsed.id, parsed);
      }
    }
  }
  const styles = [...byId.values()];
  const defaultStyleId = cfg.defaultStyleId && byId.has(cfg.defaultStyleId) ? cfg.defaultStyleId : 'default';
  return { ok: true, defaultStyleId, styles };
}

function yamlScalar(v) {
  const s = String(v == null ? '' : v).replace(/\r?\n/g, ' ').trim();
  if (!s) return '""';
  if (/[:#"'{}\[\],&*?|>!%@`]/.test(s)) return JSON.stringify(s);
  return s;
}

function saveOutputStyle(input = {}, cwd = '') {
  const rawName = String(input.name || input.id || '').trim();
  if (!rawName) return { ok: false, error: 'Output style name is required' };
  let id = slugifyId(input.id || rawName);
  if (!id) return { ok: false, error: 'Invalid output style identifier' };
  if (BUILTIN_IDS.has(id) && !input.allowBuiltinOverride) {
    id = `${id}-custom`;
  }
  const reqScope = String(input.scope || input.storage || 'global').toLowerCase();
  const useWorkspace = (reqScope === 'workspace' || reqScope === 'project') && !!cwd;
  const { claudeDir, autobotDir } = resolveStyleRoots();
  const targetDir = useWorkspace
    ? path.join(cwd, '.claude', 'output-styles')
    : (reqScope === 'claude' ? path.join(claudeDir, 'output-styles') : path.join(autobotDir, 'output-styles'));
  cc.ensureDir(targetDir);
  const file = path.join(targetDir, `${id}.md`);

  const hint = String(input.hint || '').trim();
  const description = String(input.description || hint || `Custom formatting template for ${rawName}`).trim();
  const directive = String(input.directive || input.prompt || input.template || '').trim();
  if (!directive) return { ok: false, error: 'Output style template / instructions are required' };

  const md = [
    '---',
    `id: ${yamlScalar(id)}`,
    `name: ${yamlScalar(rawName)}`,
    `hint: ${yamlScalar(hint || description)}`,
    `description: ${yamlScalar(description)}`,
    '---',
    '',
    directive,
    '',
  ].join('\n');

  fs.writeFileSync(file, md, { encoding: 'utf8', mode: 0o600 });

  if (typeof input.setDefault === 'boolean') {
    const cfg = readConfig();
    cfg.defaultStyleId = input.setDefault ? id : (cfg.defaultStyleId === id ? 'default' : (cfg.defaultStyleId || 'default'));
    writeConfig(cfg);
  }

  const state = listOutputStyles(cwd);
  const saved = state.styles.find((s) => s.id === id) || null;
  return { ok: true, style: saved, file, defaultStyleId: state.defaultStyleId, styles: state.styles };
}

function deleteOutputStyle(input = {}, cwd = '') {
  const targetId = slugifyId(input.id || input.name || '');
  if (!input.file && (!targetId || BUILTIN_IDS.has(targetId))) {
    return { ok: false, error: 'Built-in output styles cannot be deleted' };
  }
  const allowedDirs = styleDirs(cwd).map((d) => path.resolve(d.dir));
  let deleted = false;
  if (input.file) {
    const abs = path.resolve(String(input.file));
    if (!allowedDirs.some((d) => abs.startsWith(d + path.sep))) {
      return { ok: false, error: 'Refused to delete output style outside output-styles directories' };
    }
    if (fs.existsSync(abs)) {
      fs.unlinkSync(abs);
      deleted = true;
    }
  } else {
    for (const d of styleDirs(cwd)) {
      const candidate = path.join(d.dir, `${targetId}.md`);
      if (fs.existsSync(candidate)) {
        fs.unlinkSync(candidate);
        deleted = true;
      }
    }
  }
  const cfg = readConfig();
  if (cfg.defaultStyleId === targetId) {
    cfg.defaultStyleId = 'default';
    writeConfig(cfg);
  }
  const state = listOutputStyles(cwd);
  return { ok: true, deleted, defaultStyleId: state.defaultStyleId, styles: state.styles };
}

module.exports = {
  BUILTIN_OUTPUT_STYLES,
  listOutputStyles,
  saveOutputStyle,
  deleteOutputStyle,
};
