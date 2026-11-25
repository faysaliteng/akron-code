'use strict';
// Session project folders — the "auto create a project folder for every build"
// behaviour Claude Desktop has. Each conversation gets its own working directory
// under ~/Helio Bot/<slug>, created lazily on first run and shown in the composer.
//
// Persistence: ~/.autobot/workspaces.json  ->  { [convId]: { dir, title, at } }

const os = require('os');
const path = require('path');
const fs = require('fs');
const store = require('./store');
const { expandPath } = require('./paths');
const mindmap = require('./mindmap');

const ROOT = path.join(os.homedir(), 'Helio Bot');
const FILE = path.join(store.DATA_DIR, 'workspaces.json');

function read(file) {
  try { return JSON.parse(fs.readFileSync(file || FILE, 'utf8')) || {}; } catch (_) { return {}; }
}
function write(map, file) {
  const target = file || FILE;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(map, null, 2), 'utf8');
}

function slugify(title, fallback) {
  const s = String(title || '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || (fallback || 'project');
}

// A folder name that carries no information about the project. Conversations
// used to mint `project` from an empty title on the very first run, then mint a
// SECOND folder once the real title existed — the file landed in the abandoned
// one and the site "was never made". Untitled conversations now get a
// `untitled-<id6>` stub, so that shape is generic too.
const GENERIC = /^(project|untitled|scratch|user|default)(-[a-z0-9]{1,10})?$/i;
function isGenericDirName(p) {
  return !p || GENERIC.test(path.basename(String(p)));
}

/** Move `from` → `to` (same filesystem rename), preserving everything inside. */
function migrateDir(from, to) {
  try {
    if (!from || !to || from === to) return false;
    if (!fs.existsSync(from)) return false;
    if (fs.existsSync(to)) return false;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    try {
      fs.renameSync(from, to);
    } catch (_) {
      // Cross-device fallback: copy then remove.
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    }
    return true;
  } catch (_) { return false; }
}

// Find a free directory name under `root` for the given slug.
function freshDir(slug, root) {
  const base = path.join(root || ROOT, slug);
  if (!fs.existsSync(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(root || ROOT, `${slug}-${i}`);
    if (!fs.existsSync(cand)) return cand;
  }
  return path.join(root || ROOT, `${slug}-${Date.now()}`);
}

/** Ensure a conversation has a project folder; returns { dir, created }. */
function ensure(convId, title, opts) {
  const options = opts || {};
  const map = read(options.file);
  const id = convId || '__default';
  const wantTitle = String(title || '').trim();
  const existing = map[id];
  if (existing && existing.dir && fs.existsSync(existing.dir)) {
    // Heal the old split: a folder minted from an empty title (slug `project`,
    // `untitled`) gets renamed once the real conversation title is known, so the
    // site the agent wrote is always in the folder the conversation points at.
    const staleTitle = !String(existing.title || '').trim();
    if (wantTitle && staleTitle && isGenericDirName(existing.dir)) {
      const target = freshDir(slugify(wantTitle, 'untitled-' + String(id).replace(/[^a-z0-9]/gi, '').slice(0, 6)), options.root);
      if (migrateDir(existing.dir, target)) {
        map[id] = { dir: target, title: wantTitle, at: Date.now(), auto: true, migratedFrom: existing.dir };
        write(map, options.file);
        try { mindmap.ensureStub(target, wantTitle); } catch (_) {}
        return { dir: target, created: false, title: wantTitle, migrated: true };
      }
    }
    // Keep the stored title fresh so a later switch sees the real project name.
    if (wantTitle && wantTitle !== existing.title) {
      map[id] = { ...existing, title: wantTitle };
      write(map, options.file);
    }
    return { dir: existing.dir, created: false, title: wantTitle || existing.title };
  }
  // Never mint an uninformative `project` folder: an untitled conversation gets
  // a stable unique stub name, then is renamed when the title arrives.
  const stub = 'untitled-' + String(id).replace(/[^a-z0-9]/gi, '').slice(0, 6);
  const dir = freshDir(slugify(wantTitle, stub), options.root);
  fs.mkdirSync(dir, { recursive: true });
  map[id] = { dir, title: wantTitle, at: Date.now(), auto: true };
  write(map, options.file);
  // Every project auto-creates a mindmap so any model that takes over the
  // conversation on a switch knows the goal, progress and files.
  try { mindmap.ensureStub(dir, wantTitle); } catch (_) {}
  return { dir, created: true, title: wantTitle };
}

// Folders that only ever contain the generated mindmap stub carry no project.
function projectFiles(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => !['MINDMAP.md', '.DS_Store', 'node_modules', '.git'].includes(f));
  } catch (_) { return []; }
}

/** The user's original ask, as recorded in the project mindmap. */
function goalOf(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, 'MINDMAP.md'), 'utf8');
    const m = /##\s*Goal\s*\n+\s*([^\n]+)/i.exec(raw);
    return m ? m[1].trim() : '';
  } catch (_) { return ''; }
}

/**
 * One-off repair for workspaces.json entries created before the migration fix:
 * files written into a generic folder (`project`, `project-2`) are moved into the
 * titled conversation folder that is still empty. Startup-safe and deliberately
 * conservative: it only acts when there is EXACTLY ONE generic folder holding
 * project files and EXACTLY ONE empty titled folder, so it can never shuffle a
 * deliverable into an unrelated conversation (which is the bug it exists to fix).
 */
function reconcile(opts) {
  const options = opts || {};
  const root = options.root || ROOT;
  const map = read(options.file);
  let changed = false;
  const entries = Object.keys(map)
    .map((id) => ({ id, ...map[id] }))
    .filter((e) => e.dir && fs.existsSync(e.dir));
  const uniq = (list) => {
    const seen = new Set();
    return list.filter((e) => {
      const key = path.resolve(e.dir);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const generic = uniq(entries.filter((e) => isGenericDirName(e.dir) && projectFiles(e.dir).length > 0));
  const titledEmpty = uniq(entries.filter((e) => !isGenericDirName(e.dir) && projectFiles(e.dir).length === 0));
  // Also consider on-disk generic folders that lost their map entry (e.g. the old
  // `__default` pointer was overwritten by a later ensure()).
  let orphan = [];
  try {
    orphan = fs.readdirSync(root)
      .filter((name) => GENERIC.test(name))
      .map((name) => path.join(root, name))
      .filter((dir) => fs.statSync(dir).isDirectory()
        && !entries.some((e) => path.resolve(e.dir) === path.resolve(dir))
        && projectFiles(dir).length > 0)
      .map((dir) => ({ id: null, dir }));
  } catch (_) {}
  const sources = uniq([...generic, ...orphan]);
  if (sources.length !== 1) return false;
  const g = sources[0];

  // Pick the destination. One empty titled folder is the obvious answer; when
  // several are empty, match the source's own MINDMAP goal to the folder slug so
  // a deliverable is only ever moved into the conversation it belongs to.
  let target = titledEmpty.length === 1 ? titledEmpty[0] : null;
  if (!target && titledEmpty.length > 1) {
    const wantSlug = slugify(goalOf(g.dir) || g.title || '');
    if (wantSlug) {
      const hits = titledEmpty.filter((t) => {
        const b = path.basename(t.dir);
        return b === wantSlug || b.startsWith(wantSlug) || wantSlug.startsWith(b);
      });
      if (hits.length === 1) target = hits[0];
    }
  }
  if (!target) return false;
  try {
    for (const f of fs.readdirSync(g.dir)) {
      if (f === 'MINDMAP.md' || f === '.DS_Store') continue;
      const dest = path.join(target.dir, f);
      if (fs.existsSync(dest)) continue;
      fs.renameSync(path.join(g.dir, f), dest);
    }
    if (g.id) delete map[g.id];
    changed = true;
    try { console.log(`[workspace] moved files ${g.dir} → ${target.dir}`); } catch (_) {}
  } catch (_) { return false; }
  if (changed) write(map, options.file);
  return changed;
}

/** Return the workspace for a conversation, or null. */
function get(convId) {
  const id = convId || '__default';
  const e = read()[id];
  if (e && e.dir && fs.existsSync(e.dir)) return e;
  return null;
}

/** Point a conversation at an explicit directory (user-chosen). */
function setDir(convId, dir) {
  const map = read();
  const id = convId || '__default';
  const resolved = path.resolve(expandPath(dir));
  fs.mkdirSync(resolved, { recursive: true });
  map[id] = { dir: resolved, title: path.basename(resolved), at: Date.now() };
  write(map);
  try { mindmap.ensureStub(resolved, path.basename(resolved)); } catch (_) {}
  return map[id];
}

/** Scratch folder for scheduled / headless runs. */
function scratch() {
  const dir = path.join(ROOT, 'scratch');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = { ROOT, ensure, get, setDir, scratch, read, write, slugify, reconcile, isGenericDirName, migrateDir };
