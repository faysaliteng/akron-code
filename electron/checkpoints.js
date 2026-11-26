'use strict';
// Checkpoints / rewind — Example's file-state snapshots.
//
// Before any mutating tool (Write/Edit/MultiEdit/NotebookEdit) changes a file,
// the ORIGINAL is copied into ~/.autobot/checkpoints/<conv>/<turn>/<n>-<rel>.
// That lets the user rewind the working tree to how it looked at any earlier
// point, which is what Example's "rewind" affordance does.
//
// A checkpoint stores:
//   <snap>/meta.json     { id, conv, turn, at, cwd, files:[{path, backup, existed}] }
//   <snap>/<n>-<name>    the file's previous bytes (only when it existed)

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.autobot', 'checkpoints');

function safeName(p) {
  return String(p).replace(/^[/\\]+/, '').replace(/[/\\:]+/g, '__');
}

function snapDir(conv, turn) {
  const c = safeName(conv || 'default');
  return path.join(ROOT, c, String(turn || 'turn-' + Date.now()));
}

// Snapshot one file before it is mutated. Returns a record or null on failure.
function snapshotFile(conv, turn, filePath) {
  try {
    if (!filePath) return null;
    const dir = snapDir(conv, turn);
    fs.mkdirSync(dir, { recursive: true });
    const metaFile = path.join(dir, 'meta.json');
    let meta = { id: path.basename(dir), conv: conv || 'default', turn, at: new Date().toISOString(), files: [] };
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
    const abs = path.resolve(filePath);
    // Skip if this exact path was already snapshotted in this checkpoint (the
    // FIRST pre-change state is the one to restore).
    if (meta.files.some((f) => f.path === abs)) return meta.files.find((f) => f.path === abs);
    let existed = false;
    let backup = null;
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        existed = true;
        backup = `${meta.files.length}-${safeName(abs)}`;
        fs.copyFileSync(abs, path.join(dir, backup));
      }
    } catch (_) { existed = false; }
    const rec = { path: abs, backup, existed };
    meta.files.push(rec);
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
    return rec;
  } catch (_) {
    return null;
  }
}

function listCheckpoints(conv) {
  const root = path.join(ROOT, safeName(conv || 'default'));
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root, e.name, 'meta.json'), 'utf8'));
      out.push({ id: meta.id || e.name, dir: path.join(root, e.name), at: meta.at, turn: meta.turn, files: meta.files || [] });
    } catch (_) {}
  }
  out.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return out;
}

// Restore one checkpoint (or, if `before` is given, everything up to it).
// Returns { restored:[], removed:[], errors:[] }.
function restore(conv, id) {
  const all = listCheckpoints(conv);
  const targetIdx = all.findIndex((c) => c.id === id || path.basename(c.dir) === id);
  if (targetIdx < 0) return { restored: [], removed: [], errors: [`checkpoint ${id} not found`] };
  const restoredSet = new Set();
  const removedSet = new Set();
  const errors = [];
  // Apply every checkpoint from newest back down to targetIdx so rewinding
  // also undoes edits and created files from all later turns.
  for (let i = all.length - 1; i >= targetIdx; i--) {
    const cp = all[i];
    for (const f of cp.files || []) {
      try {
        if (f.existed && f.backup) {
          fs.mkdirSync(path.dirname(f.path), { recursive: true });
          fs.copyFileSync(path.join(cp.dir, f.backup), f.path);
          restoredSet.add(f.path);
          removedSet.delete(f.path);
        } else if (!f.existed) {
          try { fs.unlinkSync(f.path); removedSet.add(f.path); restoredSet.delete(f.path); } catch (_) {}
        }
      } catch (e) {
        errors.push(`${f.path}: ${e.message}`);
      }
    }
  }
  return { restored: [...restoredSet], removed: [...removedSet], errors };
}

function removeCheckpoint(conv, id) {
  const all = listCheckpoints(conv);
  const target = all.find((c) => c.id === id || path.basename(c.dir) === id);
  if (!target) return false;
  try { fs.rmSync(target.dir, { recursive: true, force: true }); return true; } catch (_) { return false; }
}

module.exports = { ROOT, snapshotFile, listCheckpoints, restore, removeCheckpoint, snapDir };
