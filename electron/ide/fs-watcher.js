'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULT_IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', 'build', '.next', '.turbo', '__pycache__', '.venv']);
const DEFAULT_IGNORE_FILES = new Set(['.DS_Store', 'Thumbs.db']);

const EXT_LANG = {
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
  '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescript',
  '.json': 'json', '.jsonc': 'json',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.svg': 'xml', '.xml': 'xml',
  '.md': 'markdown', '.mdx': 'markdown',
  '.py': 'python', '.pyw': 'python',
  '.go': 'go', '.rs': 'rust', '.rb': 'ruby', '.php': 'php',
  '.java': 'java', '.kt': 'kotlin', '.swift': 'swift',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cc': 'cpp',
  '.cs': 'csharp', '.sh': 'shell', '.zsh': 'shell', '.bash': 'shell',
  '.ps1': 'powershell', '.sql': 'sql', '.yaml': 'yaml', '.yml': 'yaml',
  '.toml': 'ini', '.ini': 'ini', '.env': 'ini', '.dockerfile': 'dockerfile',
};

function detectLanguage(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (base === 'dockerfile') return 'dockerfile';
  if (base === 'makefile') return 'makefile';
  const ext = path.extname(base);
  return EXT_LANG[ext] || 'plaintext';
}

function parseGitignore(cwd) {
  const rules = [];
  try {
    const gi = path.join(cwd, '.gitignore');
    if (!fs.existsSync(gi)) return rules;
    const raw = fs.readFileSync(gi, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#') || s.startsWith('!')) continue;
      const clean = s.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!clean) continue;
      // Convert simple glob into regex anchored on name or relPath
      const esc = clean.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      try {
        rules.push({
          raw: clean,
          hasSlash: clean.includes('/'),
          re: new RegExp(`^${esc}$`, 'i'),
        });
      } catch (_) {}
    }
  } catch (_) {}
  return rules;
}

function isIgnored(name, relPath, rules) {
  if (DEFAULT_IGNORE_FILES.has(name) || DEFAULT_IGNORE_DIRS.has(name)) return true;
  const relSlash = relPath.replace(/\\/g, '/');
  for (const r of rules) {
    if (r.hasSlash) {
      if (r.re.test(relSlash)) return true;
    } else if (r.re.test(name)) {
      return true;
    }
  }
  return false;
}

function readTree(cwd, opts = {}) {
  const root = path.resolve(cwd || process.cwd());
  if (!fs.existsSync(root)) return { ok: false, error: 'Workspace path does not exist', nodes: [] };
  const maxDepth = Number(opts.maxDepth) > 0 ? Number(opts.maxDepth) : 7;
  const maxEntries = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : 3500;
  const includeIgnored = !!opts.includeIgnored;
  const rules = includeIgnored ? [] : parseGitignore(root);

  let count = 0;
  let truncated = false;

  const walk = (dir, depth) => {
    if (depth > maxDepth || count >= maxEntries) { truncated = count >= maxEntries; return []; }
    let dirents;
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
    const items = [];
    for (const d of dirents) {
      if (count >= maxEntries) { truncated = true; break; }
      const full = path.join(dir, d.name);
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (!includeIgnored && isIgnored(d.name, rel, rules)) continue;
      count++;
      const isDir = d.isDirectory();
      const node = {
        name: d.name,
        path: full,
        relPath: rel,
        isDir,
        language: isDir ? null : detectLanguage(full),
      };
      if (isDir && depth < maxDepth) {
        node.children = walk(full, depth + 1);
      } else if (isDir) {
        node.children = [];
      }
      items.push(node);
    }
    items.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return items;
  };

  return {
    ok: true,
    root,
    nodes: walk(root, 0),
    count,
    truncated,
  };
}

function readFile(filePath, opts = {}) {
  try {
    const abs = path.resolve(String(filePath || ''));
    const st = fs.statSync(abs);
    if (!st.isFile()) return { ok: false, error: 'Not a file' };
    const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 2 * 1024 * 1024;
    if (st.size > maxBytes) {
      return { ok: true, path: abs, content: '', mtimeMs: st.mtimeMs, size: st.size, binary: false, tooLarge: true, language: detectLanguage(abs) };
    }
    const buf = fs.readFileSync(abs);
    const probe = buf.subarray(0, Math.min(buf.length, 4096));
    if (probe.includes(0)) {
      return { ok: true, path: abs, content: '', mtimeMs: st.mtimeMs, size: st.size, binary: true, language: detectLanguage(abs) };
    }
    return {
      ok: true,
      path: abs,
      content: buf.toString('utf8'),
      mtimeMs: st.mtimeMs,
      size: st.size,
      binary: false,
      language: detectLanguage(abs),
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function writeFile(filePath, content) {
  try {
    const abs = path.resolve(String(filePath || ''));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, String(content == null ? '' : content), 'utf8');
    const st = fs.statSync(abs);
    return { ok: true, path: abs, mtimeMs: st.mtimeMs, size: st.size };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function createEntry(targetPath, kind = 'file') {
  try {
    const abs = path.resolve(String(targetPath || ''));
    if (fs.existsSync(abs)) return { ok: false, error: 'Target already exists' };
    if (kind === 'dir' || kind === 'folder') {
      fs.mkdirSync(abs, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, '', 'utf8');
    }
    return { ok: true, path: abs, kind };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function renameEntry(oldPath, newPath) {
  try {
    const src = path.resolve(String(oldPath || ''));
    const dst = path.resolve(String(newPath || ''));
    if (!fs.existsSync(src)) return { ok: false, error: 'Source path not found' };
    if (fs.existsSync(dst)) return { ok: false, error: 'Destination already exists' };
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return { ok: true, oldPath: src, newPath: dst };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function duplicateEntry(srcPath) {
  try {
    const src = path.resolve(String(srcPath || ''));
    if (!fs.existsSync(src)) return { ok: false, error: 'Source not found' };
    const dir = path.dirname(src);
    const ext = path.extname(src);
    const base = path.basename(src, ext);
    let idx = 1;
    let dst = path.join(dir, `${base} copy${ext}`);
    while (fs.existsSync(dst)) {
      idx++;
      dst = path.join(dir, `${base} copy ${idx}${ext}`);
    }
    fs.cpSync(src, dst, { recursive: true });
    return { ok: true, path: dst };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function deleteEntry(targetPath) {
  try {
    const abs = path.resolve(String(targetPath || ''));
    if (!fs.existsSync(abs)) return { ok: false, error: 'Path not found' };
    fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function revealInOS(targetPath) {
  try {
    const abs = path.resolve(String(targetPath || ''));
    const { shell } = require('electron');
    if (shell && typeof shell.showItemInFolder === 'function') {
      shell.showItemInFolder(abs);
      return { ok: true };
    }
    return { ok: false, error: 'Electron shell unavailable' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

function loadParcelWatcher() {
  try {
    return require('@parcel/watcher');
  } catch (_) {
    try {
      const resolved = require.resolve('@parcel/watcher').replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
      if (fs.existsSync(resolved)) return require(resolved);
    } catch (__) {}
    return null;
  }
}

const parcelWatcher = loadParcelWatcher();

function watcherBackend() {
  return parcelWatcher ? 'parcel' : 'fs.watch';
}

const watchers = new Map(); // cwd -> { watcher, sub, timer, pending, backend }

function unwatchWorkspace(cwd) {
  if (!cwd) return;
  const key = path.resolve(cwd);
  const rec = watchers.get(key);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  try { if (rec.watcher) rec.watcher.close(); } catch (_) {}
  try { if (rec.sub && typeof rec.sub.unsubscribe === 'function') rec.sub.unsubscribe().catch(() => {}); } catch (_) {}
  watchers.delete(key);
}

function unwatchAll() {
  for (const k of [...watchers.keys()]) unwatchWorkspace(k);
}

function watchWorkspace(cwd, onChange) {
  if (!cwd) return { ok: false, error: 'cwd required' };
  const root = path.resolve(cwd);
  if (!fs.existsSync(root)) return { ok: false, error: 'Workspace missing' };
  if (watchers.has(root)) return { ok: true, cwd: root, alreadyWatching: true, backend: watchers.get(root).backend };

  const pending = new Map(); // relPath -> eventType
  const flush = () => {
    rec.timer = null;
    const events = [...pending.entries()].map(([relPath, eventType]) => ({
      cwd: root,
      relPath,
      path: relPath ? path.join(root, relPath) : root,
      eventType,
    }));
    pending.clear();
    if (events.length && typeof onChange === 'function') {
      try { onChange(events); } catch (_) {}
    }
  };
  const scheduleEvent = (rel, eventType) => {
    if (rel && /(?:^|\/)(?:\.git|node_modules|dist|release|build|\.next|__pycache__)(?:\/|$)/.test(rel)) return;
    pending.set(rel, eventType || 'change');
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = setTimeout(flush, 120);
    if (rec.timer && typeof rec.timer.unref === 'function') rec.timer.unref();
  };
  const rec = { watcher: null, sub: null, timer: null, pending, backend: 'fs.watch' };

  if (parcelWatcher && typeof parcelWatcher.subscribe === 'function') {
    rec.backend = 'parcel';
    watchers.set(root, rec);
    parcelWatcher.subscribe(root, (err, events) => {
      if (err || !Array.isArray(events)) return;
      for (const ev of events) {
        const rel = ev && ev.path ? path.relative(root, ev.path).replace(/\\/g, '/') : '';
        scheduleEvent(rel, ev && ev.type ? ev.type : 'change');
      }
    }, {
      ignore: ['.git', 'node_modules', 'dist', 'release', 'build', '.next', '__pycache__'],
    }).then((sub) => {
      if (watchers.get(root) === rec) rec.sub = sub;
      else sub.unsubscribe().catch(() => {});
    }).catch(() => {});
    return { ok: true, cwd: root, backend: 'parcel' };
  }

  try {
    rec.watcher = fs.watch(root, { recursive: process.platform !== 'linux' }, (eventType, filename) => {
      const rel = filename ? String(filename).replace(/\\/g, '/') : '';
      scheduleEvent(rel, eventType || 'change');
    });
    watchers.set(root, rec);
    return { ok: true, cwd: root, backend: 'fs.watch' };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  readTree,
  readFile,
  writeFile,
  createEntry,
  renameEntry,
  duplicateEntry,
  deleteEntry,
  revealInOS,
  watchWorkspace,
  unwatchWorkspace,
  unwatchAll,
  detectLanguage,
  watcherBackend,
};
