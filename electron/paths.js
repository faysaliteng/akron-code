'use strict';
// Path helpers shared by the tool executors. Centralizes `~` / env-var expansion
// so every file tool (Read/Write/Edit/Glob/Grep/Cd/Bash cwd) treats `~/Desktop`
// the same way the shell does — the root cause of "the app can't access local
// folders".

const os = require('os');
const path = require('path');

/**
 * Expand a user-facing path string:
 *   ~            -> home
 *   ~/foo        -> home/foo
 *   ~user/foo    -> /Users/user/foo
 *   $HOME, ${VAR}-> env value
 * Returns the original string if it's not a path (e.g. glob pattern).
 */
function expandPath(p) {
  if (p == null) return p;
  let s = String(p).trim();
  if (!s) return s;
  // `~` alone or leading `~/`
  if (s === '~') return os.homedir();
  if (s.startsWith('~/')) return path.join(os.homedir(), s.slice(2));
  if (s.startsWith('~\\') && path.sep === '\\') return path.join(os.homedir(), s.slice(2));
  // `~username/...`
  const tildeUser = /^~([^/\\]+)([\\/].*)?$/.exec(s);
  if (tildeUser) return path.join('/Users', tildeUser[1], tildeUser[2] ? tildeUser[2].slice(1) : '');
  // env vars, both $VAR and ${VAR}
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, a, b) => {
    const v = process.env[a || b];
    return v != null ? v : '';
  });
  return s;
}

/** Resolve a (possibly relative / tilde) path against a cwd. */
function resolvePath(p, cwd) {
  if (!p) throw new Error('path required');
  const expanded = expandPath(p);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(expandPath(cwd) || process.cwd(), expanded);
}

/** Ensure a directory exists (mkdir -p), returning its resolved path. */
function ensureDir(p, cwd) {
  const resolved = resolvePath(p, cwd);
  require('fs').mkdirSync(resolved, { recursive: true });
  return resolved;
}

let cachedPosixShell = null;
function defaultPosixShell() {
  if (cachedPosixShell) return cachedPosixShell;
  const fs = require('fs');
  for (const cand of ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh']) {
    try { if (fs.existsSync(cand)) { cachedPosixShell = cand; return cand; } } catch (_) {}
  }
  cachedPosixShell = '/bin/sh';
  return cachedPosixShell;
}

let cachedNodeBinary = null;
/**
 * Locate a real Node.js CLI executable (never the packaged Electron binary,
 * where RunAsNode is disabled by hardened fuses).
 */
function resolveNodeBinary({ force = false } = {}) {
  const fs = require('fs');
  if (!force && cachedNodeBinary && fs.existsSync(cachedNodeBinary)) return cachedNodeBinary;
  const isExecutableFile = (p) => {
    try {
      if (!p || /\.app\/Contents\/MacOS\//i.test(String(p))) return false;
      const st = fs.statSync(p);
      return st.isFile();
    } catch (_) {
      return false;
    }
  };
  const candidates = [];
  if (process.env.AKRON_NODE_BINARY) candidates.push(process.env.AKRON_NODE_BINARY);
  if (!process.versions.electron && process.execPath) candidates.push(process.execPath);
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, 'runtimes', 'node', 'bin', exeName),
      path.join(process.resourcesPath, 'runtimes', 'node', exeName),
    );
  }
  const home = os.homedir();
  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(path.join(localApp, 'Volta', 'bin', 'node.exe'), 'C:\\Program Files\\nodejs\\node.exe');
  } else {
    candidates.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      path.join(home, '.volta', 'bin', 'node'),
      '/usr/bin/node',
    );
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        const vers = fs.readdirSync(nvmDir).sort().reverse();
        for (const v of vers) candidates.push(path.join(nvmDir, v, 'bin', 'node'));
      }
    } catch (_) {}
  }
  for (const dir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(dir, exeName));
  }
  for (const cand of candidates) {
    const clean = path.normalize(String(cand || ''));
    if (isExecutableFile(clean)) {
      cachedNodeBinary = clean;
      return clean;
    }
  }
  return null;
}

module.exports = { expandPath, resolvePath, ensureDir, defaultPosixShell, resolveNodeBinary, homeDir: () => os.homedir() };
