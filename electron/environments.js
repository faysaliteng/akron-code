'use strict';
/**
 * Execution Environments Manager:
 *   1. This Computer (local)
 *   2. SSH Host (ssh2 + ~/.ssh/config discovery + encrypted secretstore passphrases/passwords)
 *   3. Remote Server (HTTP + WebSocket Bearer-token endpoints)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const secretstore = require('./secretstore');
const { detectLanguage } = require('./ide/fs-watcher');

const DIR = path.join(os.homedir(), '.autobot');
const CONFIG_FILE = path.join(DIR, 'environments.json');
const DEFAULT_HOST_PORT = 9477;

const SECRET_KEYS = ['password', 'passphrase', 'token', 'secret'];

function defaultConfig() {
  return {
    active: { kind: 'local', id: null, label: 'This Computer', cwd: '' },
    sshProfiles: [],
    remoteProfiles: [],
    hostServer: { enabled: false, port: DEFAULT_HOST_PORT },
  };
}

function readRawConfig() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const base = defaultConfig();
    if (!raw || typeof raw !== 'object') return base;
    return {
      active: raw.active && typeof raw.active === 'object' ? { ...base.active, ...raw.active } : base.active,
      sshProfiles: Array.isArray(raw.sshProfiles) ? raw.sshProfiles : [],
      remoteProfiles: Array.isArray(raw.remoteProfiles) ? raw.remoteProfiles : [],
      hostServer: raw.hostServer && typeof raw.hostServer === 'object' ? { ...base.hostServer, ...raw.hostServer } : base.hostServer,
    };
  } catch (_) {
    return defaultConfig();
  }
}

function stripSecrets(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = { ...obj };
  for (const k of SECRET_KEYS) delete copy[k];
  return copy;
}

function writeRawConfig(cfg) {
  fs.mkdirSync(DIR, { recursive: true });
  const sanitized = {
    active: cfg.active || defaultConfig().active,
    sshProfiles: (cfg.sshProfiles || []).map(stripSecrets),
    remoteProfiles: (cfg.remoteProfiles || []).map(stripSecrets),
    hostServer: cfg.hostServer || defaultConfig().hostServer,
  };
  const tmp = CONFIG_FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(sanitized, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch (_) {}
  return sanitized;
}

function sshSecretKey(id) { return 'env:ssh:' + id; }
function remoteSecretKey(id) { return 'env:remote:' + id; }
function hostTokenKey() { return 'env:hostServer:token'; }

function parseSshConfig(text) {
  const lines = String(text || '').split(/\r?\n/);
  const entries = [];
  let cur = null;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^["']|["']$/g, '');
    if (key === 'host') {
      const alias = val.split(/\s+/)[0];
      if (!alias || alias === '*' || alias.includes('*') || alias.includes('?')) {
        cur = null;
        continue;
      }
      cur = {
        id: 'sshcfg:' + alias,
        name: alias,
        host: alias,
        port: 22,
        username: '',
        identityFile: '',
        remoteCwd: '',
        source: 'ssh-config',
      };
      entries.push(cur);
    } else if (cur) {
      if (key === 'hostname') cur.host = val;
      else if (key === 'user') cur.username = val;
      else if (key === 'port' && Number.isFinite(Number(val))) cur.port = Number(val);
      else if (key === 'identityfile' && !cur.identityFile) cur.identityFile = val;
    }
  }
  return entries;
}

function discoverSshConfigHosts() {
  const fp = path.join(os.homedir(), '.ssh', 'config');
  try {
    if (!fs.existsSync(fp)) return [];
    return parseSshConfig(fs.readFileSync(fp, 'utf8'));
  } catch (_) {
    return [];
  }
}

let hostServerInstance = null;
let lastHostServerInfo = null;

function getState() {
  const cfg = readRawConfig();
  const sshProfiles = (cfg.sshProfiles || []).map((p) => ({
    ...stripSecrets(p),
    hasSecret: !!secretstore.get(sshSecretKey(p.id)),
  }));
  const remoteProfiles = (cfg.remoteProfiles || []).map((p) => ({
    ...stripSecrets(p),
    hasToken: !!secretstore.get(remoteSecretKey(p.id)),
  }));
  const sshConfigHosts = discoverSshConfigHosts();
  return {
    active: cfg.active,
    sshProfiles,
    remoteProfiles,
    sshConfigHosts,
    hostServer: {
      enabled: !!(cfg.hostServer && cfg.hostServer.enabled),
      port: (cfg.hostServer && cfg.hostServer.port) || DEFAULT_HOST_PORT,
      running: !!hostServerInstance,
      url: lastHostServerInfo ? lastHostServerInfo.url : '',
      hasToken: !!secretstore.get(hostTokenKey()),
    },
    secretStatus: secretstore.status(),
  };
}

function saveSshProfile(input) {
  const cfg = readRawConfig();
  const id = String((input && input.id) || '').trim() || ('ssh_' + crypto.randomBytes(4).toString('hex'));
  const entry = {
    id,
    name: String((input && input.name) || (input && input.host) || 'SSH Host').trim(),
    host: String((input && input.host) || '').trim(),
    port: Math.max(1, Math.min(65535, Number(input && input.port) || 22)),
    username: String((input && input.username) || os.userInfo().username || '').trim(),
    identityFile: String((input && input.identityFile) || '').trim(),
    remoteCwd: String((input && input.remoteCwd) || '').trim(),
    source: 'saved',
  };
  if (input && (input.secret || input.password || input.passphrase)) {
    secretstore.set(sshSecretKey(id), String(input.secret || input.password || input.passphrase));
  }
  const idx = cfg.sshProfiles.findIndex((p) => p.id === id);
  if (idx >= 0) cfg.sshProfiles[idx] = entry;
  else cfg.sshProfiles.push(entry);
  writeRawConfig(cfg);
  return { ok: true, profile: { ...entry, hasSecret: !!secretstore.get(sshSecretKey(id)) }, state: getState() };
}

function deleteSshProfile(id) {
  const cfg = readRawConfig();
  cfg.sshProfiles = cfg.sshProfiles.filter((p) => p.id !== id);
  secretstore.del(sshSecretKey(id));
  if (cfg.active && cfg.active.kind === 'ssh' && cfg.active.id === id) {
    cfg.active = defaultConfig().active;
  }
  writeRawConfig(cfg);
  return { ok: true, state: getState() };
}

function saveRemoteProfile(input) {
  const cfg = readRawConfig();
  const id = String((input && input.id) || '').trim() || ('rem_' + crypto.randomBytes(4).toString('hex'));
  const rawUrl = String((input && input.url) || '').trim().replace(/\/+$/, '');
  const entry = {
    id,
    name: String((input && input.name) || rawUrl || 'Remote Server').trim(),
    url: rawUrl,
    remoteCwd: String((input && input.remoteCwd) || '').trim(),
  };
  if (input && input.token) {
    secretstore.set(remoteSecretKey(id), String(input.token).trim());
  }
  const idx = cfg.remoteProfiles.findIndex((p) => p.id === id);
  if (idx >= 0) cfg.remoteProfiles[idx] = entry;
  else cfg.remoteProfiles.push(entry);
  writeRawConfig(cfg);
  return { ok: true, profile: { ...entry, hasToken: !!secretstore.get(remoteSecretKey(id)) }, state: getState() };
}

function deleteRemoteProfile(id) {
  const cfg = readRawConfig();
  cfg.remoteProfiles = cfg.remoteProfiles.filter((p) => p.id !== id);
  secretstore.del(remoteSecretKey(id));
  if (cfg.active && cfg.active.kind === 'remote' && cfg.active.id === id) {
    cfg.active = defaultConfig().active;
  }
  writeRawConfig(cfg);
  return { ok: true, state: getState() };
}

function resolveProfile(kind, id) {
  const cfg = readRawConfig();
  if (kind === 'ssh') {
    const saved = cfg.sshProfiles.find((p) => p.id === id);
    if (saved) return saved;
    const discovered = discoverSshConfigHosts().find((p) => p.id === id || p.name === id);
    return discovered || null;
  }
  if (kind === 'remote') {
    return cfg.remoteProfiles.find((p) => p.id === id) || null;
  }
  return null;
}

function formatActiveLabel(kind, profile) {
  if (kind === 'ssh' && profile) {
    const u = profile.username ? `${profile.username}@` : '';
    return `SSH: ${u}${profile.host}`;
  }
  if (kind === 'remote' && profile) {
    return `Remote: ${profile.name || profile.url}`;
  }
  return 'This Computer';
}

function setActive(spec) {
  const cfg = readRawConfig();
  const kind = spec && spec.kind ? spec.kind : 'local';
  if (kind === 'local') {
    cfg.active = defaultConfig().active;
    writeRawConfig(cfg);
    return { ok: true, active: cfg.active, state: getState() };
  }
  const prof = resolveProfile(kind, spec.id);
  if (!prof) return { ok: false, error: 'Environment profile not found' };
  cfg.active = {
    kind,
    id: prof.id,
    label: formatActiveLabel(kind, prof),
    cwd: String((spec && spec.cwd) || prof.remoteCwd || '').trim(),
  };
  writeRawConfig(cfg);
  return { ok: true, active: cfg.active, state: getState() };
}

function getActive() {
  return readRawConfig().active || defaultConfig().active;
}

function isRemoteActive() {
  const a = getActive();
  return a.kind === 'ssh' || a.kind === 'remote';
}

function expandLocalFile(p) {
  const s = String(p || '').trim();
  if (!s) return '';
  if (s.startsWith('~')) return path.join(os.homedir(), s.slice(1).replace(/^[/\\]+/, ''));
  return path.resolve(s);
}

function shQuote(s) {
  return "'" + String(s == null ? '' : s).replace(/'/g, "'\\''") + "'";
}

function loadPrivateKey(identityFile) {
  const tryPaths = [];
  if (identityFile) tryPaths.push(expandLocalFile(identityFile));
  else {
    for (const def of ['id_ed25519', 'id_rsa', 'id_ecdsa']) {
      tryPaths.push(path.join(os.homedir(), '.ssh', def));
    }
  }
  for (const fp of tryPaths) {
    try {
      if (fp && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        return fs.readFileSync(fp);
      }
    } catch (_) {}
  }
  return undefined;
}

function connectSshClient(profileOrId) {
  const { Client } = require('ssh2');
  const profile = typeof profileOrId === 'string' ? resolveProfile('ssh', profileOrId) : profileOrId;
  if (!profile || !profile.host) return Promise.reject(new Error('SSH host is required'));

  const secret = (profile.secret || profile.password || profile.passphrase)
    || (profile.id ? secretstore.get(sshSecretKey(profile.id)) : null)
    || '';

  const opts = {
    host: profile.host,
    port: Number(profile.port) || 22,
    username: profile.username || os.userInfo().username,
    readyTimeout: 12000,
    keepaliveInterval: 15000,
  };
  const keyBuf = loadPrivateKey(profile.identityFile);
  if (keyBuf) {
    opts.privateKey = keyBuf;
    if (secret) opts.passphrase = secret;
  } else if (secret) {
    opts.password = secret;
  }
  if (process.env.SSH_AUTH_SOCK) opts.agent = process.env.SSH_AUTH_SOCK;

  return new Promise((resolve, reject) => {
    const conn = new Client();
    let settled = false;
    conn.once('ready', () => {
      if (settled) return;
      settled = true;
      resolve(conn);
    });
    conn.once('error', (err) => {
      if (settled) return;
      settled = true;
      try { conn.end(); } catch (_) {}
      reject(err);
    });
    if (secret) {
      conn.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish((prompts || []).map(() => secret));
      });
    }
    conn.connect(opts);
  });
}

async function execSsh(profileOrId, command, { timeoutMs = 60000 } = {}) {
  const conn = await connectSshClient(profileOrId);
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { conn.end(); } catch (_) {}
      resolve({ ok: false, code: -1, stdout, stderr: stderr + '\n[SSH timed out]', timedOut: true });
    }, timeoutMs);

    conn.exec(command, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        try { conn.end(); } catch (_) {}
        return reject(err);
      }
      stream.on('data', (d) => { if (stdout.length < 4 * 1024 * 1024) stdout += d.toString('utf8'); });
      stream.stderr.on('data', (d) => { if (stderr.length < 1024 * 1024) stderr += d.toString('utf8'); });
      stream.on('close', (code) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        try { conn.end(); } catch (_) {}
        resolve({ ok: code === 0, code: code == null ? 0 : code, stdout, stderr });
      });
    });
  });
}

async function testSsh(profileOrId) {
  const started = Date.now();
  try {
    const res = await execSsh(profileOrId, 'uname -a && pwd', { timeoutMs: 12000 });
    const lines = res.stdout.trim().split(/\r?\n/);
    return {
      ok: res.ok,
      latencyMs: Date.now() - started,
      uname: lines[0] || '',
      remoteCwd: lines[1] || '~',
      error: res.ok ? '' : (res.stderr || `SSH exited ${res.code}`).trim(),
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err && err.message ? err.message : String(err) };
  }
}

async function openSshShell(profileOrId, { cwd, cols = 100, rows = 28 } = {}) {
  const conn = await connectSshClient(profileOrId);
  return new Promise((resolve, reject) => {
    conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
      if (err) {
        try { conn.end(); } catch (_) {}
        return reject(err);
      }
      if (cwd) {
        try { stream.write(`cd ${shQuote(cwd)}\n`); } catch (_) {}
      }
      resolve({ conn, stream });
    });
  });
}

// Remote Server HTTP Client
async function remoteFetch(profileOrId, method, endpoint, body) {
  const profile = typeof profileOrId === 'string' ? resolveProfile('remote', profileOrId) : profileOrId;
  if (!profile || !profile.url) throw new Error('Remote server URL is required');
  const token = (profile.token && String(profile.token).trim())
    || (profile.id ? secretstore.get(remoteSecretKey(profile.id)) : '')
    || '';
  if (!token) throw new Error('Remote server token is missing');

  const url = String(profile.url).replace(/\/+$/, '') + endpoint;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    if (!res.ok) {
      throw new Error((json && json.error) || `HTTP ${res.status}: ${text.slice(0, 180)}`);
    }
    return json || { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

async function testRemote(profileOrId) {
  const started = Date.now();
  try {
    const ping = await remoteFetch(profileOrId, 'GET', '/v1/env/ping');
    let workspaces = [];
    try {
      const wsRes = await remoteFetch(profileOrId, 'GET', '/v1/env/workspaces');
      if (wsRes && Array.isArray(wsRes.workspaces)) workspaces = wsRes.workspaces;
    } catch (_) {}
    return {
      ok: !!ping.ok,
      latencyMs: Date.now() - started,
      hostname: ping.hostname || '',
      platform: ping.platform || '',
      cwd: ping.cwd || '',
      workspaces,
    };
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: err && err.message ? err.message : String(err) };
  }
}

function getRemoteWsUrl(profileOrId, opts = {}) {
  const profile = typeof profileOrId === 'string' ? resolveProfile('remote', profileOrId) : profileOrId;
  if (!profile || !profile.url) throw new Error('Remote server URL required');
  const token = (profile.token && String(profile.token).trim())
    || (profile.id ? secretstore.get(remoteSecretKey(profile.id)) : '')
    || '';
  const u = new URL(profile.url);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = '/v1/env/pty';
  if (opts.cwd) u.searchParams.set('cwd', opts.cwd);
  if (opts.cols) u.searchParams.set('cols', String(opts.cols));
  if (opts.rows) u.searchParams.set('rows', String(opts.rows));
  return { wsUrl: u.toString(), token };
}

// ---------- Unified SSH Remote FS / Search / Git / Tool Helpers ----------
function runSshPy(profile, pyCode, args = [], timeoutMs = 45000) {
  const b64 = Buffer.from(pyCode, 'utf8').toString('base64');
  const argStr = args.map(shQuote).join(' ');
  const cmd = `python3 -c "import base64,sys; exec(base64.b64decode('${b64}').decode('utf-8'))" ${argStr}`;
  return execSsh(profile, cmd, { timeoutMs }).then((r) => {
    if (!r.ok && !r.stdout.trim()) return { ok: false, error: (r.stderr || `SSH exit ${r.code}`).trim() };
    try {
      return JSON.parse(r.stdout.trim());
    } catch (e) {
      return { ok: false, error: r.stderr.trim() || r.stdout.trim() || e.message };
    }
  });
}

async function sshFsOp(profile, op, payload = {}) {
  const py = `
import os, sys, json, base64, shutil
op = sys.argv[1]
arg = json.loads(base64.b64decode(sys.argv[2]).decode('utf-8'))
IGNORE = {'.git','node_modules','dist','release','build','.next','.turbo','__pycache__','.venv'}

if op == 'readTree':
    root = os.path.expanduser(arg.get('cwd') or '~')
    root = os.path.abspath(root)
    if not os.path.isdir(root):
        print(json.dumps({'ok': False, 'error': 'Workspace path does not exist', 'nodes': []}))
        sys.exit(0)
    maxDepth = int(arg.get('maxDepth') or 6)
    maxEntries = int(arg.get('maxEntries') or 3000)
    cnt = [0]
    def walk(d, depth):
        if depth > maxDepth or cnt[0] >= maxEntries:
            return []
        try:
            names = sorted(os.listdir(d))
        except Exception:
            return []
        dirs, files = [], []
        for n in names:
            if cnt[0] >= maxEntries: break
            if n in IGNORE or n in ('.DS_Store','Thumbs.db'): continue
            full = os.path.join(d, n)
            rel = os.path.relpath(full, root).replace(os.sep, '/')
            cnt[0] += 1
            isDir = os.path.isdir(full)
            node = {'name': n, 'path': full, 'relPath': rel, 'isDir': isDir, 'children': walk(full, depth+1) if (isDir and depth < maxDepth) else ([] if isDir else None)}
            (dirs if isDir else files).append(node)
        return dirs + files
    print(json.dumps({'ok': True, 'root': root, 'nodes': walk(root, 0), 'count': cnt[0]}))

elif op == 'readFile':
    p = os.path.abspath(os.path.expanduser(arg.get('path') or ''))
    if not os.path.isfile(p):
        print(json.dumps({'ok': False, 'error': 'File not found: ' + p}))
        sys.exit(0)
    st = os.stat(p)
    if st.st_size > int(arg.get('maxBytes') or 2*1024*1024):
        print(json.dumps({'ok': True, 'path': p, 'content': '', 'size': st.st_size, 'tooLarge': True, 'binary': False}))
        sys.exit(0)
    data = open(p, 'rb').read()
    is_bin = b'\\x00' in data[:4096]
    print(json.dumps({'ok': True, 'path': p, 'content': '' if is_bin else data.decode('utf-8', 'replace'), 'mtimeMs': st.st_mtime * 1000, 'size': st.st_size, 'binary': is_bin}))

elif op == 'writeFile':
    p = os.path.abspath(os.path.expanduser(arg.get('path') or ''))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w', encoding='utf-8').write(arg.get('content') or '')
    st = os.stat(p)
    print(json.dumps({'ok': True, 'path': p, 'mtimeMs': st.st_mtime * 1000, 'size': st.st_size}))

elif op == 'createEntry':
    p = os.path.abspath(os.path.expanduser(arg.get('path') or ''))
    if os.path.exists(p):
        print(json.dumps({'ok': False, 'error': 'Target already exists'}))
    elif arg.get('kind') in ('dir', 'folder'):
        os.makedirs(p, exist_ok=True)
        print(json.dumps({'ok': True, 'path': p}))
    else:
        os.makedirs(os.path.dirname(p), exist_ok=True)
        open(p, 'w', encoding='utf-8').write('')
        print(json.dumps({'ok': True, 'path': p}))

elif op == 'renameEntry':
    o = os.path.abspath(os.path.expanduser(arg.get('oldPath') or ''))
    n = os.path.abspath(os.path.expanduser(arg.get('newPath') or ''))
    os.makedirs(os.path.dirname(n), exist_ok=True)
    os.rename(o, n)
    print(json.dumps({'ok': True, 'oldPath': o, 'newPath': n}))

elif op == 'duplicateEntry':
    p = os.path.abspath(os.path.expanduser(arg.get('path') or ''))
    base, ext = os.path.splitext(p)
    dest = base + ' copy' + ext
    shutil.copytree(p, dest) if os.path.isdir(p) else shutil.copy2(p, dest)
    print(json.dumps({'ok': True, 'path': dest}))

elif op == 'deleteEntry':
    p = os.path.abspath(os.path.expanduser(arg.get('path') or ''))
    shutil.rmtree(p) if os.path.isdir(p) else os.remove(p)
    print(json.dumps({'ok': True, 'path': p}))
`;
  const payloadB64 = Buffer.from(JSON.stringify(payload || {}), 'utf8').toString('base64');
  const res = await runSshPy(profile, py, [op, payloadB64]);
  if (op === 'readTree' && res && res.ok && Array.isArray(res.nodes)) {
    const tag = (nodes) => {
      for (const n of nodes) {
        if (!n.isDir) n.language = detectLanguage(n.path);
        else if (n.children) tag(n.children);
      }
    };
    tag(res.nodes);
  }
  if (op === 'readFile' && res && res.ok) res.language = detectLanguage(res.path);
  return res;
}

async function sshGitOp(profile, op, payload = {}) {
  const cwd = payload.cwd || '~';
  if (op === 'status') {
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git rev-parse --show-toplevel && git rev-parse --abbrev-ref HEAD && git status --porcelain=v1`);
    if (!r.ok) return { ok: true, isRepo: false, staged: [], unstaged: [], untracked: [] };
    const lines = r.stdout.split(/\r?\n/);
    const root = lines[0] || cwd;
    const branch = lines[1] || 'main';
    const staged = [];
    const unstaged = [];
    const untracked = [];
    for (const ln of lines.slice(2)) {
      if (!ln || ln.length < 4) continue;
      const x = ln[0];
      const y = ln[1];
      const rel = ln.slice(3).trim();
      const abs = path.posix.join(root, rel);
      if (x === '?' && y === '?') untracked.push({ relPath: rel, path: abs, status: 'U' });
      else {
        if (x && x !== ' ') staged.push({ relPath: rel, path: abs, status: x });
        if (y && y !== ' ') unstaged.push({ relPath: rel, path: abs, status: y });
      }
    }
    return { ok: true, isRepo: true, root, branch, staged, unstaged, untracked };
  }
  if (op === 'fileAtHead') {
    const rel = payload.path && payload.cwd ? path.posix.relative(payload.cwd, payload.path) : (payload.path || '');
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git show ${shQuote('HEAD:' + rel)}`);
    return r.ok ? { ok: true, content: r.stdout } : { ok: true, content: '' };
  }
  if (op === 'stage') {
    const files = (payload.files || []).map(shQuote).join(' ');
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git add -- ${files}`);
    return { ok: r.ok, status: await sshGitOp(profile, 'status', { cwd }), error: r.stderr };
  }
  if (op === 'unstage') {
    const files = (payload.files || []).map(shQuote).join(' ');
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git reset HEAD -- ${files}`);
    return { ok: r.ok, status: await sshGitOp(profile, 'status', { cwd }), error: r.stderr };
  }
  if (op === 'discard') {
    const files = (payload.files || []).map(shQuote).join(' ');
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git checkout -- ${files}`);
    return { ok: r.ok, status: await sshGitOp(profile, 'status', { cwd }), error: r.stderr };
  }
  if (op === 'commit') {
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git commit -m ${shQuote(payload.message || '')}`);
    return { ok: r.ok, status: await sshGitOp(profile, 'status', { cwd }), error: r.stderr };
  }
  if (op === 'branches') {
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git branch --format=%(HEAD)'|'%(refname:short)`);
    if (!r.ok) return { ok: false, branches: [] };
    const branches = [];
    let current = '';
    for (const ln of r.stdout.split(/\r?\n/)) {
      const [h, name] = ln.split('|');
      if (!name) continue;
      if (h === '*') current = name;
      branches.push({ name, current: h === '*' });
    }
    return { ok: true, current, branches };
  }
  if (op === 'checkout') {
    const flag = payload.createNew ? '-b ' : '';
    const r = await execSsh(profile, `cd ${shQuote(cwd)} && git checkout ${flag}${shQuote(payload.branch || '')}`);
    return { ok: r.ok, error: r.stderr, ...(await sshGitOp(profile, 'branches', { cwd })) };
  }
  return { ok: false, error: 'Unsupported SSH git op: ' + op };
}

// Route IDE FS / Search / Git to active Remote or SSH environment
async function dispatchIde(group, op, payload = {}) {
  const act = getActive();
  if (act.kind === 'remote') {
    const prof = resolveProfile('remote', act.id);
    if (!prof) return { ok: false, error: 'Remote profile missing' };
    const effective = { ...payload, cwd: payload.cwd || act.cwd || prof.remoteCwd };
    return remoteFetch(prof, 'POST', `/v1/env/${group}`, { op, ...effective });
  }
  if (act.kind === 'ssh') {
    const prof = resolveProfile('ssh', act.id);
    if (!prof) return { ok: false, error: 'SSH profile missing' };
    const effective = { ...payload, cwd: payload.cwd || act.cwd || prof.remoteCwd || '~' };
    if (group === 'fs') return sshFsOp(prof, op, effective);
    if (group === 'git') return sshGitOp(prof, op, effective);
    if (group === 'search') {
      const py = `
import os, sys, json, re, base64
arg = json.loads(base64.b64decode(sys.argv[1]).decode('utf-8'))
root = os.path.abspath(os.path.expanduser(arg.get('cwd') or '~'))
q = arg.get('query') or ''
flags = 0 if arg.get('caseSensitive') else re.I
rx = re.compile(q if arg.get('isRegex') else re.escape(q), flags)
matches = []
IGNORE = {'.git','node_modules','dist','release','build'}
for dp, dn, fn in os.walk(root):
    dn[:] = [d for d in dn if d not in IGNORE]
    for f in fn:
        fp = os.path.join(dp, f)
        try:
            raw = open(fp, 'rb').read(1024*1024)
            if b'\\x00' in raw[:4096]: continue
            lines = raw.decode('utf-8', 'replace').split('\\n')
            for idx, ln in enumerate(lines, 1):
                m = rx.search(ln)
                if m:
                    matches.append({'file': fp, 'relPath': os.path.relpath(fp, root).replace(os.sep, '/'), 'line': idx, 'column': m.start()+1, 'text': ln[:300]})
                    if len(matches) >= 400: break
        except Exception: pass
    if len(matches) >= 400: break
print(json.dumps({'ok': True, 'engine': 'ssh-py', 'matches': matches, 'truncated': len(matches) >= 400}))
`;
      return runSshPy(prof, py, [Buffer.from(JSON.stringify(effective), 'utf8').toString('base64')]);
    }
  }
  return { ok: false, error: 'Not in remote environment' };
}

async function runActiveTool(name, args = {}) {
  const act = getActive();
  if (act.kind === 'remote') {
    const prof = resolveProfile('remote', act.id);
    if (!prof) return 'Error: Remote server profile not found.';
    const res = await remoteFetch(prof, 'POST', '/v1/env/tool', {
      name,
      args: { ...args, cwd: args.cwd || act.cwd || prof.remoteCwd },
    });
    return res.result;
  }
  if (act.kind === 'ssh') {
    const prof = resolveProfile('ssh', act.id);
    if (!prof) return 'Error: SSH profile not found.';
    const cwd = args.cwd || act.cwd || prof.remoteCwd || '~';
    if (name === 'bash') {
      const r = await execSsh(prof, `cd ${shQuote(cwd)} && ${args.command}`, { timeoutMs: args.timeout || 120000 });
      const out = (r.stdout + (r.stderr ? '\n' + r.stderr : '')).trim();
      return out || (r.ok ? '(no output)' : `[exit code ${r.code}]`);
    }
    if (name === 'read_file') {
      const p = args.path || args.file_path || '';
      const target = path.posix.isAbsolute(p) || p.startsWith('~') ? p : path.posix.join(cwd, p);
      const r = await sshFsOp(prof, 'readFile', { path: target });
      if (!r.ok) return 'Error: ' + r.error;
      const lines = String(r.content || '').split('\n');
      return lines.map((l, i) => `${i + 1}\t${l}`).join('\n');
    }
    if (name === 'write_file') {
      const p = args.path || args.file_path || '';
      const target = path.posix.isAbsolute(p) || p.startsWith('~') ? p : path.posix.join(cwd, p);
      const r = await sshFsOp(prof, 'writeFile', { path: target, content: args.content || '' });
      return r.ok ? `Wrote ${r.size} bytes to ${r.path} (SSH)` : 'Error: ' + r.error;
    }
    if (name === 'edit_file') {
      const p = args.path || args.file_path || '';
      const target = path.posix.isAbsolute(p) || p.startsWith('~') ? p : path.posix.join(cwd, p);
      const cur = await sshFsOp(prof, 'readFile', { path: target });
      if (!cur.ok) return 'Error: ' + cur.error;
      const raw = String(cur.content || '');
      if (!raw.includes(String(args.old_string || ''))) return 'Error: old_string not found in remote file';
      const next = args.replace_all
        ? raw.split(String(args.old_string)).join(String(args.new_string || ''))
        : raw.replace(String(args.old_string), String(args.new_string || ''));
      const w = await sshFsOp(prof, 'writeFile', { path: target, content: next });
      return w.ok ? `Edited ${w.path} (SSH)` : 'Error: ' + w.error;
    }
    if (name === 'grep') {
      const r = await dispatchIde('search', 'search', { cwd, query: args.pattern });
      if (!r.ok) return 'Error: ' + r.error;
      return (r.matches || []).map((m) => `${m.relPath}:${m.line}:${m.text}`).join('\n') || '(no matches)';
    }
    if (name === 'glob') {
      const r = await execSsh(prof, `cd ${shQuote(cwd)} && find . -maxdepth 5 -not -path '*/.*' -not -path '*/node_modules/*'`);
      return r.stdout.trim() || '(no matches)';
    }
  }
  return 'Error: Unsupported remote tool ' + name;
}

async function toggleHostServer(enabled, opts = {}) {
  const cfg = readRawConfig();
  const port = Number(opts.port || (cfg.hostServer && cfg.hostServer.port) || DEFAULT_HOST_PORT);
  if (!enabled) {
    if (hostServerInstance) {
      await hostServerInstance.stop();
      hostServerInstance = null;
      lastHostServerInfo = null;
    }
    cfg.hostServer = { enabled: false, port };
    writeRawConfig(cfg);
    return { ok: true, running: false, state: getState() };
  }
  let token = secretstore.get(hostTokenKey());
  if (!token || opts.rotateToken) {
    token = crypto.randomBytes(24).toString('hex');
    secretstore.set(hostTokenKey(), token);
  }
  if (hostServerInstance) {
    await hostServerInstance.stop();
    hostServerInstance = null;
  }
  const { createRemoteServer } = require('./remote-server');
  hostServerInstance = createRemoteServer({
    port,
    host: opts.host || '127.0.0.1',
    token,
    workspaceRoot: opts.workspaceRoot || os.homedir(),
  });
  lastHostServerInfo = await hostServerInstance.start();
  cfg.hostServer = { enabled: true, port: lastHostServerInfo.port };
  writeRawConfig(cfg);
  return { ok: true, running: true, url: lastHostServerInfo.url, token: lastHostServerInfo.token, state: getState() };
}

function getHostServerToken() {
  return secretstore.get(hostTokenKey()) || '';
}

module.exports = {
  getState,
  getActive,
  setActive,
  isRemoteActive,
  resolveProfile,
  parseSshConfig,
  discoverSshConfigHosts,
  saveSshProfile,
  deleteSshProfile,
  saveRemoteProfile,
  deleteRemoteProfile,
  testSsh,
  execSsh,
  openSshShell,
  testRemote,
  remoteFetch,
  getRemoteWsUrl,
  dispatchIde,
  runActiveTool,
  toggleHostServer,
  getHostServerToken,
};
