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

module.exports = { expandPath, resolvePath, ensureDir, homeDir: () => os.homedir() };
