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
    const tmpMeta = `${metaFile}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpMeta, JSON.stringify(meta, null, 2));
    fs.renameSync(tmpMeta, metaFile);
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

function computeLineDiff(beforeText, afterText) {
  const a = beforeText === '' ? [] : String(beforeText).replace(/\r\n/g, '\n').split('\n');
  const b = afterText === '' ? [] : String(afterText).replace(/\r\n/g, '\n').split('\n');
  const m = a.length;
  const n = b.length;
  // LCS matrix for reasonably sized source files; prefix/suffix fallback for huge files.
  if (m * n > 400000) {
    let p = 0;
    while (p < m && p < n && a[p] === b[p]) p++;
    let s = 0;
    while (s < (m - p) && s < (n - p) && a[m - 1 - s] === b[n - 1 - s]) s++;
    const lines = [];
    for (let i = 0; i < p; i++) lines.push({ type: 'ctx', oldLine: i + 1, newLine: i + 1, text: a[i] });
    for (let i = p; i < m - s; i++) lines.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] });
    for (let j = p; j < n - s; j++) lines.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j] });
    for (let k = 0; k < s; k++) lines.push({ type: 'ctx', oldLine: m - s + k + 1, newLine: n - s + k + 1, text: a[m - s + k] });
    return { lines, added: Math.max(0, (n - s) - p), removed: Math.max(0, (m - s) - p) };
  }
  const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i][j] = dp[i + 1][j + 1] + 1;
      else dp[i][j] = dp[i + 1][j] >= dp[i][j + 1] ? dp[i + 1][j] : dp[i][j + 1];
    }
  }
  const lines = [];
  let i = 0; let j = 0;
  let added = 0; let removed = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      lines.push({ type: 'ctx', oldLine: i + 1, newLine: j + 1, text: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      lines.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i] });
      removed++; i++;
    } else {
      lines.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j] });
      added++; j++;
    }
  }
  while (i < m) { lines.push({ type: 'del', oldLine: i + 1, newLine: null, text: a[i++] }); removed++; }
  while (j < n) { lines.push({ type: 'add', oldLine: null, newLine: j + 1, text: b[j++] }); added++; }
  return { lines, added, removed };
}

// Compute per-file unified diffs from stored checkpoint pre-states to current disk contents.
function computeTurnDiffs(conv, checkpointId, cwd) {
  const all = listCheckpoints(conv);
  if (!all.length) return [];
  let list = all;
  if (checkpointId && checkpointId !== 'all' && checkpointId !== 'latest') {
    const exact = all.filter((c) => c.id === checkpointId || path.basename(c.dir) === checkpointId || String(c.turn) === String(checkpointId));
    if (exact.length) list = exact;
    else list = [all[all.length - 1]];
  } else if (checkpointId === 'latest') {
    list = [all[all.length - 1]];
  }
  const earliestByPath = new Map();
  for (const cp of list) {
    for (const f of cp.files || []) {
      if (!f || !f.path || earliestByPath.has(f.path)) continue;
      earliestByPath.set(f.path, { cp, f });
    }
  }
  const baseCwd = cwd ? path.resolve(cwd) : '';
  const diffs = [];
  for (const [absPath, { cp, f }] of earliestByPath) {
    let before = '';
    if (f.existed && f.backup) {
      try { before = fs.readFileSync(path.join(cp.dir, f.backup), 'utf8'); } catch (_) { before = ''; }
    }
    const existsNow = fs.existsSync(absPath);
    let after = '';
    if (existsNow) {
      try { after = fs.readFileSync(absPath, 'utf8'); } catch (_) { after = ''; }
    }
    const status = !f.existed ? (existsNow ? 'added' : 'deleted') : (existsNow ? 'modified' : 'deleted');
    const relPath = baseCwd && absPath.startsWith(baseCwd + path.sep) ? path.relative(baseCwd, absPath) : path.basename(absPath);
    const d = computeLineDiff(before, after);
    diffs.push({
      path: absPath,
      relPath,
      status,
      added: d.added,
      removed: d.removed,
      lines: d.lines,
    });
  }
  return diffs;
}

const { execFileSync } = require('child_process');

function listWorkspaceFilesQuick(cwd, limit = 1500) {
  const out = new Map();
  if (!cwd || !fs.existsSync(cwd)) return out;
  const skip = new Set(['node_modules', '.git', 'dist', 'build', 'release', '.next', '.cache', 'venv', '.venv', 'target']);
  const walk = (dir, depth) => {
    if (depth > 6 || out.size >= limit) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of ents) {
      if (out.size >= limit) break;
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walk(path.join(dir, e.name), depth + 1);
      } else if (e.isFile()) {
        const full = path.join(dir, e.name);
        try {
          const st = fs.statSync(full);
          if (st.size <= 2 * 1024 * 1024) out.set(full, `${st.size}:${Math.floor(st.mtimeMs)}`);
        } catch (_) {}
      }
    }
  };
  walk(path.resolve(cwd), 0);
  return out;
}

/** Capture lightweight pre-execution snapshot of workspace file stats + small pre-edit contents for Bash/ApplyPatch rewind. */
function captureWorkspaceState(cwd) {
  const dir = cwd ? path.resolve(cwd) : '';
  const stats = listWorkspaceFilesQuick(dir);
  let gitDirty = new Set();
  try {
    const por = execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: dir, encoding: 'utf8', timeout: 2500 });
    for (const ln of String(por || '').split(/\r?\n/)) {
      if (ln.length > 3) gitDirty.add(path.resolve(dir, ln.slice(3).trim()));
    }
  } catch (_) {}
  const preBytes = new Map();
  for (const fp of gitDirty) {
    try {
      const st = fs.statSync(fp);
      if (st.isFile() && st.size <= 512 * 1024) preBytes.set(fp, fs.readFileSync(fp));
    } catch (_) {}
  }
  return { cwd: dir, at: Date.now(), stats, preBytes };
}

/** Record any workspace files created or modified after a Bash/ApplyPatch turn so restore() reverts them cleanly. */
function snapshotWorkspaceChanges(conv, turn, cwd, beforeState) {
  if (!beforeState || !cwd) return [];
  const afterStats = listWorkspaceFilesQuick(cwd);
  const changed = [];
  for (const [fp, sig] of afterStats.entries()) {
    const prevSig = beforeState.stats.get(fp);
    if (!prevSig) {
      // Newly created file: record with existed: false so restore() unlinks it
      const dir = snapDir(conv, turn);
      fs.mkdirSync(dir, { recursive: true });
      const metaFile = path.join(dir, 'meta.json');
      let meta = { id: path.basename(dir), conv: conv || 'default', turn, at: new Date().toISOString(), files: [] };
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
      const abs = path.resolve(fp);
      if (!meta.files.some((f) => f.path === abs)) {
        const rec = { path: abs, backup: null, existed: false };
        meta.files.push(rec);
        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
        changed.push(rec);
      }
    } else if (prevSig !== sig) {
      const preBuf = beforeState.preBytes.get(fp);
      if (preBuf) {
        const dir = snapDir(conv, turn);
        fs.mkdirSync(dir, { recursive: true });
        const metaFile = path.join(dir, 'meta.json');
        let meta = { id: path.basename(dir), conv: conv || 'default', turn, at: new Date().toISOString(), files: [] };
        try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}
        const abs = path.resolve(fp);
        if (!meta.files.some((f) => f.path === abs)) {
          const backup = `${meta.files.length}-${safeName(abs)}`;
          fs.writeFileSync(path.join(dir, backup), preBuf);
          const rec = { path: abs, backup, existed: true };
          meta.files.push(rec);
          fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
          changed.push(rec);
        }
      }
    }
  }
  return changed;
}

module.exports = { ROOT, snapshotFile, listCheckpoints, restore, removeCheckpoint, computeTurnDiffs, computeLineDiff, snapDir, captureWorkspaceState, snapshotWorkspaceChanges };
