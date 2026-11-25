'use strict';
// Helio Bot — Plugins & Connectors directory (desktop-app parity).
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
const curated = require('./connector-catalog');
const registry = require('./mcpregistry');

const DATA_DIR = path.join(os.homedir(), '.autobot');
const PLUGINS_FILE = path.join(DATA_DIR, 'plugins.json');
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
  const s = readJSON(PLUGINS_FILE, { installed: {}, config: {} });
  if (!s.installed) s.installed = {};
  if (!s.config) s.config = {};
  return s;
}
function saveState(s) { writeJSON(PLUGINS_FILE, s); }

function decorate(entry, state) {
  const inst = state.installed[entry.id];
  return {
    ...entry,
    origin: entry.origin || 'curated',
    installed: !!inst,
    installedAt: inst ? inst.at : null,
    requiresSignIn: !!inst && entry.auth !== 'none' && !(state.config[entry.id] && state.config[entry.id].connected),
    connected: !!(state.config[entry.id] && state.config[entry.id].connected),
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
    if (entry.name.toLowerCase().includes(t)) s += 8;
    if (hay.includes(t)) s += 3;
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
