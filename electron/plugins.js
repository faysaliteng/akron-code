'use strict';
// Akron Bot — Plugins & Connectors directory (desktop-app parity).
//
// Two layers:
//   1. connector-catalog.js — curated offline directory (connectors + plugins).
//   2. mcpregistry.js       — live feed from registry.modelcontextprotocol.io so
//                             the long tail of community MCP servers is browsable.
//
// The UI and the model tools only ever see one merged surface: categories,
// search, install/uninstall state persisted to ~/.autobot/plugins.json, and
// model-facing tools (plugins__list_plugins / search_plugins /
// search_connectors / suggest_plugin_install / mcp-registry__*).
//
// Installing a connector does NOT ship third-party code: it records intent and,
// when the entry carries an MCP endpoint (or a stdio command), main.js registers
// it with the MCP client so its tools become available. Entries without an
// endpoint (OAuth-only hosted connectors) are marked "requires sign-in".

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const curated = require('./connector-catalog');
const registry = require('./mcpregistry');

const DATA_DIR = path.join(os.homedir(), '.autobot');
function pluginsFile() {
  return process.env.AUTOBOT_PLUGINS_FILE || path.join(DATA_DIR, 'plugins.json');
}
const LIST_DEFAULT_LIMIT = 5000;

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}
function writeJSON(file, v) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(v, null, 2)); }

const CATALOG = curated.CATALOG;
const CURATED_BY_ID = curated.BY_ID;

function normName(n) { return String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, ''); }

// Merged view: curated wins on name collisions so the familiar rows stay.
function pool() {
  const out = CATALOG.slice();
  const names = new Set(out.map((e) => normName(e.name)));
  for (const e of registry.all()) {
    const k = normName(e.name);
    if (names.has(k)) continue;
    names.add(k);
    out.push(e);
  }
  return out;
}

function lookup(id) { return CURATED_BY_ID.get(id) || registry.get(id) || null; }

// ---- Install state ---------------------------------------------------------
function getState() {
  const s = readJSON(pluginsFile(), { installed: {}, config: {}, gitSources: {} });
  if (!s.installed) s.installed = {};
  if (!s.config) s.config = {};
  if (!s.gitSources) s.gitSources = {};
  return s;
}
function saveState(s) { writeJSON(pluginsFile(), s); }

function decorate(entry, state) {
  const inst = state.installed[entry.id];
  const cfg = (state.config && state.config[entry.id]) || {};
  const effectiveEndpoint = cfg.customEndpoint || entry.endpoint || null;
  const effectiveCommand = cfg.customCommand || entry.command || null;
  const builtInAdapter = entry.id === 'rea'
    ? 'rea'
    : (['gdrive', 'gdocs', 'gsheets', 'gslides'].includes(entry.id) ? 'gdrive' : null);
  return {
    ...entry,
    ...(effectiveEndpoint ? { endpoint: effectiveEndpoint } : {}),
    ...(effectiveCommand ? { command: effectiveCommand } : {}),
    builtInAdapter,
    hasApiKey: !!cfg.hasApiKey,
    hasCustomEndpoint: !!cfg.customEndpoint,
    hasCustomCommand: !!cfg.customCommand,
    configMode: cfg.mode || null,
    toolCount: cfg.toolCount || 0,
    lastTestAt: cfg.lastTestAt || null,
    lastTestOk: cfg.lastTestOk != null ? !!cfg.lastTestOk : null,
    origin: entry.origin || 'curated',
    installed: !!inst,
    installedAt: inst ? inst.at : null,
    requiresSignIn: !!inst && entry.auth !== 'none' && !cfg.connected,
    connected: !!cfg.connected,
  };
}

function listPlugins(opts) {
  const state = getState();
  let list = pool();
  if (opts && opts.type) list = list.filter((e) => e.type === opts.type);
  if (opts && opts.category) list = list.filter((e) => e.category === opts.category);
  if (opts && opts.installedOnly) list = list.filter((e) => state.installed[e.id]);
  const limit = (opts && opts.limit) || LIST_DEFAULT_LIMIT;
  return list.slice(0, limit).map((e) => decorate(e, state));
}

function categories() {
  const set = new Set(pool().map((e) => e.category));
  return [...set];
}

function score(entry, terms) {
  const hay = (entry.name + ' ' + entry.id + ' ' + entry.description + ' ' + entry.category + ' ' + (entry.tools || []).join(' ') + ' ' + (entry.provides || []).join(' ')).toLowerCase();
  let s = 0;
  for (const t of terms) {
    if (!t) continue;
    // Every term must appear somewhere: multi-word queries narrow the list
    // instead of widening it (searching "linear issues" must return Linear).
    if (!hay.includes(t)) return 0;
    if (entry.name.toLowerCase().includes(t)) s += 8;
    s += 3;
    if (hay.split(/\W+/).includes(t)) s += 2;
  }
  return s;
}

function search(query, opts) {
  const q = String(query || '').trim().toLowerCase();
  const state = getState();
  let base = pool();
  if (opts && opts.type) base = base.filter((e) => e.type === opts.type);
  if (opts && opts.category) base = base.filter((e) => e.category === opts.category);
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = base.map((e) => ({ e, s: terms.length ? score(e, terms) : 1 }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => decorate(x.e, state));
  const limit = (opts && opts.limit) || 12;
  return scored.slice(0, limit);
}

function suggest(goal, opts) {
  // Rank by keyword overlap between the goal and the entry description.
  const q = String(goal || '').toLowerCase();
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  const state = getState();
  const base = pool().filter((e) => !state.installed[e.id]);
  const scored = base.map((e) => {
    const hay = (e.name + ' ' + e.description + ' ' + e.category + ' ' + (e.tools || []).join(' ') + ' ' + (e.provides || []).join(' ')).toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 1;
    return { e, s };
  }).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  return scored.slice(0, (opts && opts.limit) || 5).map((x) => decorate(x.e, state));
}

function install(id, config) {
  const entry = lookup(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const state = getState();
  state.installed[id] = { at: Date.now() };
  if (config) state.config[id] = { ...(state.config[id] || {}), ...config };
  saveState(state);
  return { ok: true, entry: decorate(entry, state) };
}

function uninstall(id) {
  const state = getState();
  if (!state.installed[id]) return { ok: false, error: `Not installed: ${id}` };
  delete state.installed[id];
  delete state.config[id];
  saveState(state);
  return { ok: true, id };
}

function markConnected(id) {
  const state = getState();
  state.config[id] = { ...(state.config[id] || {}), connected: true, connectedAt: Date.now() };
  saveState(state);
  const entry = lookup(id);
  return entry ? decorate(entry, state) : null;
}

function setConfig(id, patch) {
  const state = getState();
  state.config[id] = { ...(state.config[id] || {}), ...(patch || {}) };
  saveState(state);
  const entry = lookup(id);
  return entry ? decorate(entry, state) : null;
}

// Format a catalog slice for the model.
function formatList(list, title) {
  if (!list || !list.length) return (title || 'RESULTS') + ':\n(none)';
  const lines = list.map((e) => {
    const st = e.installed ? (e.requiresSignIn ? ' · installed, needs sign-in' : ' · installed') : '';
    return `- ${e.name} [${e.type}/${e.category}] (${e.id})${st}\n    ${e.description}`;
  });
  return (title || 'RESULTS') + ':\n' + lines.join('\n');
}

function formatSuggest(list, goal) {
  if (!list || !list.length) return `No matching connectors found for: ${goal}`;
  const lines = list.map((e, i) => `${i + 1}. ${e.name} (${e.id}) — ${e.description}${e.installed ? ' [installed]' : ''}`);
  return `Suggested for "${goal}":\n` + lines.join('\n') + '\n\nInstall with: plugins install ' + list[0].id;
}

// ---- External Git Plugins & Skills tracking + fast-forward auto-update ----
function gitPluginsDir() {
  return process.env.AUTOBOT_GIT_PLUGINS_DIR || path.join(DATA_DIR, 'plugins-git');
}

function defaultSkillsDir() {
  return process.env.AUTOBOT_SKILLS_DIR || path.join(DATA_DIR, 'skills');
}

function execGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: cwd || undefined,
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim() || (err ? err.message : ''),
      });
    });
  });
}

function sanitizeGitPluginId(raw) {
  const clean = String(raw || '').trim().replace(/\.git$/i, '').split(/[\\/]/).filter(Boolean).pop() || 'git-plugin';
  return clean.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'git-plugin';
}

function isAllowedGitSource(url) {
  const s = String(url || '').trim();
  return /^(https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/|\/|[A-Za-z]:[\\/])/i.test(s);
}

function findSkillDirs(rootDir, maxDepth = 3, depth = 0, out = []) {
  if (!rootDir || !fs.existsSync(rootDir) || depth > maxDepth) return out;
  try {
    if (fs.existsSync(path.join(rootDir, 'SKILL.md'))) {
      out.push(rootDir);
      return out;
    }
    for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      findSkillDirs(path.join(rootDir, ent.name), maxDepth, depth + 1, out);
    }
  } catch (_) {}
  return out;
}

function syncGitPluginSkills(id, repoDir, targetSkillsDir) {
  const destBase = targetSkillsDir || defaultSkillsDir();
  ensureDir(destBase);
  const prefix = `git-${sanitizeGitPluginId(id)}-`;
  try {
    for (const ent of fs.readdirSync(destBase, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.startsWith(prefix)) {
        fs.rmSync(path.join(destBase, ent.name), { recursive: true, force: true });
      }
    }
  } catch (_) {}
  const dirs = findSkillDirs(repoDir);
  const synced = [];
  for (const dir of dirs) {
    const sub = path.relative(repoDir, dir);
    const skillName = sanitizeGitPluginId(sub && sub !== '.' ? sub : id);
    const target = path.join(destBase, `${prefix}${skillName}`);
    fs.cpSync(dir, target, { recursive: true });
    synced.push(target);
  }
  try { require('./store').invalidateSkillsCache(); } catch (_) {}
  return synced;
}

function readGitPluginManifest(repoDir, fallbackId) {
  for (const rel of ['plugin.json', '.claude-plugin/plugin.json', 'package.json']) {
    const p = path.join(repoDir, rel);
    try {
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return {
          name: String(j.name || fallbackId),
          description: String(j.description || ''),
        };
      }
    } catch (_) {}
  }
  return { name: fallbackId, description: '' };
}

async function inspectGitHead(repoDir) {
  const sha = await execGit(['rev-parse', 'HEAD'], repoDir);
  const br = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir);
  return {
    commitSha: sha.ok ? sha.stdout : '',
    branch: br.ok && br.stdout !== 'HEAD' ? br.stdout : 'main',
  };
}

async function installGitPlugin({ url, id, branch, skillsDir, gitDir, config } = {}) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl || !isAllowedGitSource(cleanUrl)) {
    return { ok: false, error: 'Invalid Git repository URL or path' };
  }
  const pluginId = sanitizeGitPluginId(id || cleanUrl);
  const root = gitDir || gitPluginsDir();
  ensureDir(root);
  const destDir = path.join(root, pluginId);

  if (fs.existsSync(path.join(destDir, '.git'))) {
    await execGit(['fetch', '--all', '--prune'], destDir);
    const ff = await execGit(['merge', '--ff-only', 'FETCH_HEAD'], destDir);
    if (!ff.ok) return { ok: false, id: pluginId, error: ff.stderr || 'git merge --ff-only failed' };
  } else {
    if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
    const cloneArgs = ['clone', '--depth', '1'];
    if (branch) cloneArgs.push('--branch', String(branch).trim());
    cloneArgs.push(cleanUrl, destDir);
    const cloned = await execGit(cloneArgs);
    if (!cloned.ok) return { ok: false, id: pluginId, error: cloned.stderr || 'git clone failed' };
  }

  const head = await inspectGitHead(destDir);
  const manifest = readGitPluginManifest(destDir, pluginId);
  const syncedSkills = syncGitPluginSkills(pluginId, destDir, skillsDir);
  const state = getState();
  const prev = (state.gitSources && state.gitSources[pluginId]) || {};
  const now = Date.now();
  state.installed[pluginId] = state.installed[pluginId] || { at: now, source: 'git' };
  if (config && typeof config === 'object') {
    state.config[pluginId] = { ...(state.config[pluginId] || {}), ...config };
  }
  state.gitSources[pluginId] = {
    ...prev,
    id: pluginId,
    name: manifest.name,
    description: manifest.description,
    url: cleanUrl,
    branch: branch || head.branch,
    commitSha: head.commitSha,
    dir: destDir,
    syncedSkillsCount: syncedSkills.length,
    autoUpdate: prev.autoUpdate !== false,
    installedAt: prev.installedAt || now,
    updatedAt: now,
    lastCheckedAt: now,
    updateAvailable: false,
  };
  saveState(state);
  return { ok: true, id: pluginId, entry: state.gitSources[pluginId], syncedSkills };
}

function listGitPlugins() {
  const state = getState();
  return Object.values(state.gitSources || {});
}

async function updateGitPlugin(id, { checkOnly = false, skillsDir } = {}) {
  const state = getState();
  const src = state.gitSources && state.gitSources[id];
  if (!src) return { ok: false, id, error: `Git plugin not found: ${id}` };
  if (src.autoUpdate === false) return { ok: true, id, skipped: true, updated: false, commitSha: src.commitSha };
  if (!src.dir || !fs.existsSync(path.join(src.dir, '.git'))) {
    return { ok: false, id, error: 'Missing local Git clone directory' };
  }

  const branch = src.branch || 'main';
  const fetchArgs = ['fetch', 'origin', ...(branch ? [branch] : [])];
  let fetched = await execGit(fetchArgs, src.dir);
  if (!fetched.ok) fetched = await execGit(['fetch'], src.dir);
  if (!fetched.ok) return { ok: false, id, error: fetched.stderr || 'git fetch failed' };

  const localRes = await execGit(['rev-parse', 'HEAD'], src.dir);
  const remoteRes = await execGit(['rev-parse', 'FETCH_HEAD'], src.dir);
  const localSha = localRes.ok ? localRes.stdout : src.commitSha;
  const remoteSha = remoteRes.ok ? remoteRes.stdout : localSha;
  const behind = !!(localSha && remoteSha && localSha !== remoteSha);
  const now = Date.now();

  if (checkOnly || !behind) {
    state.gitSources[id] = {
      ...src,
      commitSha: localSha || src.commitSha,
      remoteSha,
      updateAvailable: behind,
      lastCheckedAt: now,
    };
    saveState(state);
    return { ok: true, id, updated: false, updateAvailable: behind, commitSha: localSha, remoteSha };
  }

  const ff = await execGit(['merge', '--ff-only', 'FETCH_HEAD'], src.dir);
  if (!ff.ok) return { ok: false, id, error: ff.stderr || 'git merge --ff-only failed (local modifications?)' };

  const head = await inspectGitHead(src.dir);
  const syncedSkills = syncGitPluginSkills(id, src.dir, skillsDir);
  state.gitSources[id] = {
    ...src,
    commitSha: head.commitSha,
    remoteSha: head.commitSha,
    branch: head.branch,
    syncedSkillsCount: syncedSkills.length,
    updateAvailable: false,
    updatedAt: now,
    lastCheckedAt: now,
  };
  saveState(state);
  return {
    ok: true,
    id,
    updated: true,
    updateAvailable: false,
    previousSha: localSha,
    commitSha: head.commitSha,
    syncedSkills,
  };
}

async function updateAllGitPlugins({ checkOnly = false, skillsDir } = {}) {
  const list = listGitPlugins();
  const results = [];
  let updatedCount = 0;
  let updatesAvailable = 0;
  for (const item of list) {
    const res = await updateGitPlugin(item.id, { checkOnly, skillsDir });
    results.push(res);
    if (res.updated) updatedCount++;
    if (res.updateAvailable) updatesAvailable++;
  }
  return {
    ok: true,
    checkedCount: list.length,
    updatedCount,
    updatesAvailable,
    results,
  };
}

module.exports = {
  CATALOG,
  listPlugins,
  categories,
  search,
  suggest,
  install,
  uninstall,
  markConnected,
  setConfig,
  getState,
  formatList,
  formatSuggest,
  get: lookup,
  // registry surface
  registryStatus: () => registry.status(),
  refreshRegistry: (opts) => registry.refresh(opts),
  registryAll: () => registry.all(),
  // external git plugin / skill tracking & updates
  gitPluginsDir,
  installGitPlugin,
  listGitPlugins,
  updateGitPlugin,
  updateAllGitPlugins,
  pool,
  stats: () => {
    const p = pool();
    const reg = registry.status();
    return {
      total: p.length,
      connectors: p.filter((e) => e.type === 'connector').length,
      plugins: p.filter((e) => e.type === 'plugin').length,
      categories: categories().length,
      withEndpoint: p.filter((e) => e.endpoint).length,
      curated: {
        connectors: CATALOG.filter((e) => e.type === 'connector').length,
        plugins: CATALOG.filter((e) => e.type === 'plugin').length,
        categories: new Set(CATALOG.map((e) => e.category)).size,
      },
      registry: reg,
    };
  },
};
