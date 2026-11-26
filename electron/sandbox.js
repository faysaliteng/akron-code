'use strict';
/**
 * Sandbox & network policy engine — Claude Desktop parity.
 *
 * Desktop 7.x ships an enterprise-managed filesystem/network/credential policy
 * (`sandbox.*`, `network.*` in managed-settings). We honour the same key names
 * so a managed profile written for Example applies here unchanged.
 *
 * Resolution order (highest first):
 *   1. /Library/Application Support/ClaudeDesktop/managed-settings.json  (MDM, macOS)
 *   2. /etc/claude-desktop/managed-settings.json                        (MDM, unix)
 *   3. ~/.autobot/managed-settings.json                                 (local admin)
 *   4. ~/.autobot/settings.json  `sandbox` / `network`                  (user)
 *
 * Enforcement points:
 *   - file tools (Read/Write/Edit/Glob/Grep/NotebookEdit)  → isReadAllowed / isWriteAllowed
 *   - Bash / background shell                              → wrapShell (sandbox-exec on macOS)
 *   - WebFetch                                             → isHostAllowed
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const { expandPath } = require('./paths');

const MANAGED_FILES = [
  '/Library/Application Support/ClaudeDesktop/managed-settings.json',
  '/etc/claude-desktop/managed-settings.json',
  path.join(os.homedir(), '.autobot', 'managed-settings.json'),
];

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

const DEFAULTS = {
  sandbox: {
    enabled: false,
    failIfUnavailable: false,
    filesystem: {
      allowRead: [],
      denyRead: [],
      denyWrite: [],
      allowManagedReadPathsOnly: false,
    },
    network: {
      allowedDomains: [],
      deniedDomains: [],
      allowManagedDomainsOnly: false,
    },
    credentials: {
      allowPlaintextInject: false,
      awsPairs: [],
      sigv4: false,
    },
  },
  network: {
    allowedDomains: [],
    deniedDomains: [],
    allowUnixSockets: [],
    allowAllUnixSockets: false,
    allowMachLookup: [],
    httpProxyPort: null,
    socksProxyPort: null,
    tlsTerminate: false,
  },
};

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function managed() {
  for (const f of MANAGED_FILES) {
    const j = readJSON(f);
    if (j && (j.sandbox || j.network)) return { source: f, sandbox: j.sandbox || {}, network: j.network || {}, raw: j };
  }
  return { source: null, sandbox: {}, network: {}, raw: null };
}

function mergeDeep(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeDeep(out[k], v);
    } else if (v !== undefined) {
      out[k] = Array.isArray(v) ? v.slice() : v;
    }
  }
  return out;
}

/** Effective policy: managed wins over user settings. */
function load() {
  const s = store.getSettings() || {};
  const user = { sandbox: s.sandbox || {}, network: s.network || {} };
  const man = managed();
  const sandbox = mergeDeep(mergeDeep({}, DEFAULTS.sandbox), user.sandbox);
  const net = mergeDeep(mergeDeep({}, DEFAULTS.network), user.network);
  // Managed values take precedence.
  const eff = {
    managedSource: man.source,
    sandbox: mergeDeep(sandbox, man.sandbox),
    network: mergeDeep(net, man.network),
    managedNetwork: man.network,
    managedSandbox: man.sandbox,
  };
  return eff;
}

// ---- glob matching -------------------------------------------------------
function globToRegex(g) {
  const s = String(g).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*') {
      if (s[i + 1] === '*') { re += '.*'; i++; if (s[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if ('\\^$+{}()|[]'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
const _cache = new Map();
function matches(pattern, target) {
  const p = String(pattern).replace(/\/+$/, '');
  const t = String(target).replace(/\\/g, '/').replace(/\/+$/, '');
  const exp = expandPath(p).replace(/\\/g, '/');
  // Direct directory prefix — denyRead `~/secret` covers `~/secret/x`.
  if (!/[*?]/.test(exp)) {
    if (t === exp || t.startsWith(exp + '/')) return true;
  }
  let rx = _cache.get(p);
  if (!rx) { rx = globToRegex(exp); _cache.set(p, rx); }
  return rx.test(t) || rx.test(t + '/');
}

function anyMatch(list, target) {
  return (list || []).some((pat) => matches(pat, target));
}

const PROTECTED_CREDENTIAL_FILES = [
  path.resolve(path.join(os.homedir(), '.autobot', 'secrets.json')),
  path.resolve(path.join(os.homedir(), '.autobot', 'oauth.json')),
];

function isProtectedCredentialPath(p) {
  try {
    const resolved = path.resolve(expandPath(p));
    return PROTECTED_CREDENTIAL_FILES.includes(resolved);
  } catch (_) {
    return false;
  }
}

// ---- filesystem ----------------------------------------------------------
function isReadAllowed(p) {
  if (!p) return true;
  if (isProtectedCredentialPath(p)) {
    return { allowed: false, reason: `access to Akron credential store is blocked: ${path.basename(String(p))}` };
  }
  const pol = load().sandbox;
  if (!pol.enabled) return true;
  const fsPol = pol.filesystem || {};
  const target = path.resolve(expandPath(p));
  if (anyMatch(fsPol.denyRead, target)) return { allowed: false, reason: `read denied by policy: ${p}` };
  if (fsPol.allowManagedReadPathsOnly) {
    const manAllow = (load().managedSandbox.filesystem || {}).allowRead || [];
    if (!anyMatch(manAllow, target)) return { allowed: false, reason: `read outside managed allow-list: ${p}` };
  } else if ((fsPol.allowRead || []).length) {
    if (!anyMatch(fsPol.allowRead, target)) return { allowed: false, reason: `read outside allow-list: ${p}` };
  }
  return true;
}

function isWriteAllowed(p) {
  if (!p) return true;
  if (isProtectedCredentialPath(p)) {
    return { allowed: false, reason: `modification of Akron credential store is blocked: ${path.basename(String(p))}` };
  }
  const pol = load().sandbox;
  if (!pol.enabled) return true;
  const fsPol = pol.filesystem || {};
  const target = path.resolve(expandPath(p));
  if (anyMatch(fsPol.denyWrite, target)) return { allowed: false, reason: `write denied by policy: ${p}` };
  if ((fsPol.allowWrite || []).length && !anyMatch(fsPol.allowWrite, target)) {
    return { allowed: false, reason: `write outside allow-list: ${p}` };
  }
  return true;
}

// ---- network -------------------------------------------------------------
function hostMatches(pattern, host) {
  const p = String(pattern).toLowerCase().replace(/^\*\.?/, '.');
  const h = String(host).toLowerCase();
  if (p.startsWith('.')) return h === p.slice(1) || h.endsWith(p);
  return h === p;
}

function isHostAllowed(urlOrHost) {
  let host = urlOrHost;
  try { host = new URL(urlOrHost).hostname; } catch (_) {}
  if (!host) return true;
  const pol = load();
  const denied = (pol.network.deniedDomains || []).concat(pol.sandbox.network.deniedDomains || []);
  if (denied.some((d) => hostMatches(d, host))) return { allowed: false, reason: `domain denied: ${host}` };
  if (pol.sandbox.enabled && pol.sandbox.network.allowManagedDomainsOnly) {
    const manAllow = pol.managedNetwork.allowedDomains || [];
    if (!manAllow.some((d) => hostMatches(d, host))) return { allowed: false, reason: `domain outside managed allow-list: ${host}` };
  }
  const allow = (pol.network.allowedDomains || []).concat(pol.sandbox.network.allowedDomains || []);
  if (allow.length && !allow.some((d) => hostMatches(d, host))) {
    return { allowed: false, reason: `domain outside allow-list: ${host}` };
  }
  return true;
}

// ---- shell wrapping ------------------------------------------------------
function profileFor(pol) {
  const fsPol = pol.filesystem || {};
  const lines = ['(version 1)', '(allow default)'];
  for (const d of fsPol.denyRead || []) {
    const p = expandPath(d);
    lines.push(`(deny file-read* (subpath ${JSON.stringify(p)}))`);
  }
  for (const d of fsPol.denyWrite || []) {
    const p = expandPath(d);
    lines.push(`(deny file-write* (subpath ${JSON.stringify(p)}))`);
  }
  // Unix sockets
  if (!(pol.network || {}).allowAllUnixSockets) {
    const socks = (pol.network || {}).allowUnixSockets || [];
    if (!socks.length && pol.sandbox && pol.sandbox.enabled) {
      // Only lock sockets down when the sandbox is on and no sockets whitelisted.
      lines.push('(deny network* (local unix-socket))');
    }
  }
  return lines.join('\n');
}

/**
 * Wrap a shell command for execution. Returns { file, args, sandboxed, note }.
 * Only macOS has sandbox-exec; elsewhere we honour `failIfUnavailable`.
 */
function wrapShell(command, opts = {}) {
  const pol = load().sandbox;
  const posixSh = require('./paths').defaultPosixShell();
  const shellCmd = process.platform === 'win32'
    ? { file: 'powershell.exe', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(command)] }
    : { file: posixSh, args: ['-l', '-c', String(command)] };
  if (!pol.enabled || opts.dangerouslyDisableSandbox) {
    return { ...shellCmd, sandboxed: false };
  }
  if (process.platform !== 'darwin' || !fs.existsSync(SANDBOX_EXEC)) {
    if (pol.failIfUnavailable) {
      const err = new Error('sandbox required but unavailable on this platform');
      err.code = 'SANDBOX_UNAVAILABLE';
      throw err;
    }
    return { ...shellCmd, sandboxed: false, note: 'sandbox unavailable — ran unsandboxed' };
  }
  const profile = profileFor(pol);
  return {
    file: SANDBOX_EXEC,
    args: ['-p', profile, posixSh, '-l', '-c', String(command)],
    sandboxed: true,
  };
}

/** Human-readable summary for the settings pane. */
function describe() {
  const pol = load();
  return {
    enabled: !!pol.sandbox.enabled,
    failIfUnavailable: !!pol.sandbox.failIfUnavailable,
    managedSource: pol.managedSource,
    filesystem: pol.sandbox.filesystem,
    network: {
      allowedDomains: (pol.network.allowedDomains || []).concat(pol.sandbox.network.allowedDomains || []),
      deniedDomains: (pol.network.deniedDomains || []).concat(pol.sandbox.network.deniedDomains || []),
      allowManagedDomainsOnly: !!pol.sandbox.network.allowManagedDomainsOnly,
    },
    credentials: pol.sandbox.credentials,
    sandboxAvailable: process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC),
    backend: process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC) ? 'sandbox-exec' : 'none',
    managed: !!pol.managedSource,
  };
}

module.exports = {
  DEFAULTS,
  load,
  matches,
  isReadAllowed,
  isWriteAllowed,
  isHostAllowed,
  wrapShell,
  describe,
  managed,
};
