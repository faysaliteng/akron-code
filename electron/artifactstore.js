'use strict';
// Helio Bot — persisted edits for interactive Design / Slides canvas artifacts.
//
// A canvas artifact is generated once by the model and then edited by hand
// (rename artboards, reorder slides, drop comment pins, retype a slide body).
// Those edits must survive closing the artifact window, switching panels,
// switching models and restarting the app. They are stored here, keyed by a
// stable hash of the generated content, and resolved before every build so the
// artifact window, the in-chat preview and print-to-PDF all show the same
// edited deck.
//
// Pure Node, no Electron. `setDataDir()` / AUTOBOT_ARTIFACT_DIR keep tests off
// the real home directory.

const fs = require('fs');
const path = require('path');

let dataDirOverride = process.env.AUTOBOT_ARTIFACT_DIR || null;

function dataDir() {
  return dataDirOverride || path.join(require('os').homedir(), '.autobot');
}

function setDataDir(dir) {
  dataDirOverride = dir ? String(dir) : null;
  return dataDir();
}

function file() {
  return path.join(dataDir(), 'artifact-edits.json');
}

const MAX_ENTRIES = 400;
const MAX_BYTES = 4 * 1024 * 1024;

// FNV-1a over `language \0 content`. Stable across processes and platforms, so
// an edit slot survives an app restart without any server-side bookkeeping.
function keyFor(language, content) {
  const s = String(language || '') + '\u0000' + String(content == null ? '' : content);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'canvas-' + h.toString(16).padStart(8, '0') + '-' + s.length.toString(16);
}

function blank() {
  return { version: 1, entries: {} };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return blank();
    const entries = raw.entries && typeof raw.entries === 'object' ? raw.entries : {};
    return { version: 1, entries };
  } catch (_) {
    return blank();
  }
}

function save(db) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(db));
    return true;
  } catch (_) {
    return false;
  }
}

// Newest-first trim: keep the most recently touched slots only.
function prune(db) {
  const rows = Object.entries(db.entries);
  if (rows.length <= MAX_ENTRIES) return db;
  rows.sort((a, b) => Number(b[1] && b[1].at || 0) - Number(a[1] && a[1].at || 0));
  db.entries = Object.fromEntries(rows.slice(0, MAX_ENTRIES));
  return db;
}

function get(key) {
  if (!key) return null;
  const db = load();
  const row = db.entries[key];
  if (!row || typeof row !== 'object' || !row.edits || typeof row.edits !== 'object') return null;
  return row.edits;
}

// Merge a patch into an existing slot. Arrays are replaced wholesale (an edited
// board list is the complete new list), objects are shallow-merged.
function patch(key, edits) {
  if (!key || !edits || typeof edits !== 'object') return null;
  const db = load();
  const prev = (db.entries[key] && db.entries[key].edits) || {};
  const next = Object.assign({}, prev);
  for (const [k, v] of Object.entries(edits)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else if (v && typeof v === 'object' && !Array.isArray(v) && prev[k] && typeof prev[k] === 'object' && !Array.isArray(prev[k])) {
      next[k] = Object.assign({}, prev[k], v);
    } else next[k] = v;
  }
  db.entries[key] = { at: Date.now(), edits: next };
  prune(db);
  let encoded = JSON.stringify(db);
  if (encoded.length > MAX_BYTES) {
    // Drop the oldest half and retry once.
    const rows = Object.entries(db.entries).sort((a, b) => Number(b[1].at || 0) - Number(a[1].at || 0));
    db.entries = Object.fromEntries(rows.slice(0, Math.max(1, Math.floor(rows.length / 2))));
    encoded = JSON.stringify(db);
  }
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(file(), encoded);
  } catch (_) { /* read-only home — edits stay in memory for this build only */ }
  return next;
}

function remove(key) {
  if (!key) return false;
  const db = load();
  if (!db.entries[key]) return false;
  delete db.entries[key];
  return save(db);
}

function reset() {
  return save(blank());
}

function size() {
  const db = load();
  return Object.keys(db.entries).length;
}

module.exports = { keyFor, get, patch, remove, reset, size, load, file, dataDir, setDataDir, MAX_ENTRIES };
