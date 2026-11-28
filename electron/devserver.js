'use strict';
// Dev-server discovery for the built-in browser pane.
//
// Example's browser pane shows a "Dev server found … npm run dev  Vite :5173
// [Run]" card. That card is the difference between "the preview is empty" and
// "your server isn't up yet" — so the detection here is deliberately literal:
// read this project's package.json for a dev script, and TCP-probe the handful
// of ports the listed frameworks actually bind. Nothing is guessed: if no port
// answers and no script exists, `found` is false and the UI shows nothing.
const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn, execFileSync } = require('child_process');

const CANDIDATES = [
  { port: 5173, framework: 'Vite' },
  { port: 5174, framework: 'Vite' },
  { port: 4321, framework: 'Astro' },
  { port: 3000, framework: 'Next.js' },
  { port: 3001, framework: 'Next.js' },
  { port: 4173, framework: 'Vite preview' },
  { port: 4200, framework: 'Angular' },
  { port: 8080, framework: 'dev server' },
  { port: 8000, framework: 'dev server' },
  { port: 8888, framework: 'Jupyter' },
];

const SCRIPT_ORDER = ['dev', 'start', 'serve', 'preview', 'watch'];

function probePort(port, host = '127.0.0.1', timeoutMs = 450) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) {}
      resolve(v);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch (_) { finish(false); }
  });
}

function readPackage(cwd) {
  if (!cwd) return null;
  try {
    const p = path.join(cwd, 'package.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function pickScript(pkg) {
  if (!pkg || !pkg.scripts) return null;
  for (const name of SCRIPT_ORDER) {
    if (typeof pkg.scripts[name] === 'string' && pkg.scripts[name].trim()) return name;
  }
  return null;
}

function frameworkFrom(pkg, port) {
  const hit = CANDIDATES.find((c) => c.port === port);
  const deps = Object.assign({}, (pkg && pkg.dependencies) || {}, (pkg && pkg.devDependencies) || {});
  const known = [
    ['next', 'Next.js'], ['vite', 'Vite'], ['astro', 'Astro'], ['@angular/core', 'Angular'],
    ['nuxt', 'Nuxt'], ['svelte', 'Svelte'], ['react-scripts', 'React'], ['gatsby', 'Gatsby'],
    ['vue', 'Vue'], ['webpack', 'Webpack'], ['parcel', 'Parcel'],
  ];
  for (const [dep, name] of known) if (deps[dep]) return name;
  // The port's usual framework is a guess; only use it when there is no
  // package.json to say otherwise (a plain Node server on :3000 is not Next.js).
  return hit && !pkg ? hit.framework : 'dev server';
}

// Who is listening, and where was it started? An open port only counts as
// "this project's dev server" when its process runs inside the project folder.
// Measured: FreeLLMAPI.app (cwd "/") on :3001 was shown as "npm run dev ·
// Next.js :3001", and Start refused to run the real server because a port was
// "already" up. Returns null when ownership cannot be read (Windows, no lsof):
// callers then keep the old port-only behaviour.
function listenersByOwner() {
  if (process.platform === 'win32') return null;
  let out = '';
  try {
    out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout) out = e.stdout; else return null;
  }
  const byPid = new Map(); // pid -> Set(ports)
  const cmdOf = new Map();
  let pid = 0;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') { pid = Number(line.slice(1)) || 0; continue; }
    if (line[0] === 'c' && pid) { cmdOf.set(pid, line.slice(1)); continue; }
    if (line[0] === 'n' && pid) {
      const m = /:(\d+)$/.exec(line);
      if (m) { if (!byPid.has(pid)) byPid.set(pid, new Set()); byPid.get(pid).add(Number(m[1])); }
    }
  }
  if (!byPid.size) return [];
  let cwdOut = '';
  try {
    cwdOut = execFileSync('lsof', ['-a', '-p', [...byPid.keys()].join(','), '-d', 'cwd', '-Fpn'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e && typeof e.stdout === 'string' && e.stdout) cwdOut = e.stdout; else return null;
  }
  const cwdOf = new Map();
  pid = 0;
  for (const line of cwdOut.split('\n')) {
    if (line[0] === 'p') pid = Number(line.slice(1)) || 0;
    else if (line[0] === 'n' && pid) cwdOf.set(pid, line.slice(1));
  }
  const rows = [];
  for (const [p, ports] of byPid) for (const port of ports) rows.push({ pid: p, port, cwd: cwdOf.get(p) || '', command: cmdOf.get(p) || '' });
  return rows;
}

// Agent CLIs (and Akron itself) also run inside the project folder and may hold
// a local control port; they are never the user's dev server.
const NOT_A_DEV_SERVER = /^(claude|codex|agy|antigravity|gemini|grok|kimi|copilot|zcode|rea|akron|electron|language_server)/i;

function httpServesPage(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = require('http').get({ host: '127.0.0.1', port, path: '/', timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode > 0 && res.statusCode < 400);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

function insideProject(procCwd, projectCwd) {
  if (!procCwd || !projectCwd) return false;
  const a = path.resolve(procCwd);
  const b = path.resolve(projectCwd);
  if (a === path.parse(a).root || a === os.homedir()) return false; // apps launched from Finder run in "/"
  return a === b || a.startsWith(b + path.sep);
}

async function detect(cwd) {
  const pkg = readPackage(cwd);
  const script = pickScript(pkg);
  const owners = cwd ? listenersByOwner() : null;
  let port = null;
  if (owners) {
    // 1. A server started from this project, on whatever port it chose.
    const mine = owners.filter((r) => insideProject(r.cwd, cwd) && !NOT_A_DEV_SERVER.test(r.command)).map((r) => r.port);
    const known = CANDIDATES.map((c) => c.port).filter((p) => mine.includes(p));
    if (known.length) {
      port = known[0];
    } else {
      // An unusual port must actually serve a page to count.
      for (const p of [...new Set(mine)].sort((x, y) => x - y)) {
        if (await httpServesPage(p)) { port = p; break; }
      }
    }
  } else {
    // Ownership unknown: probe the usual ports, as before.
    const results = await Promise.all(CANDIDATES.map((c) => probePort(c.port)));
    const idx = results.indexOf(true);
    port = idx >= 0 ? CANDIDATES[idx].port : null;
  }
  return {
    ok: true,
    cwd: cwd || null,
    hasScript: !!script,
    script: script ? 'npm run ' + script : null,
    running: port != null,
    port,
    url: port ? 'http://localhost:' + port + '/' : null,
    framework: frameworkFrom(pkg, port),
  };
}

// One dev server per folder per app run; a second click reuses the live one.
const started = new Map();

async function start(cwd, scriptName) {
  const pkg = readPackage(cwd);
  const script = scriptName || pickScript(pkg);
  if (!cwd || !script) return { ok: false, error: 'No dev script in package.json for this folder.' };
  const before = await detect(cwd);
  if (before.running) return { ok: true, already: true, url: before.url, port: before.port };
  const key = cwd + '::' + script;
  if (started.has(key)) return { ok: true, already: true, url: null, port: null };
  let child;
  try {
    child = spawn('npm', ['run', script], { cwd, detached: true, stdio: 'ignore', shell: false });
  } catch (e) {
    return { ok: false, error: 'Could not start npm: ' + (e && e.message ? e.message : String(e)) };
  }
  child.on('error', () => { started.delete(key); });
  child.unref();
  started.set(key, child.pid);
  // Wait for a port to answer so the caller can navigate straight to it.
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const scan = await detect(cwd);
    if (scan.running) return { ok: true, url: scan.url, port: scan.port, framework: scan.framework };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ok: true, url: null, port: null, pending: true };
}

module.exports = { detect, start, probePort, CANDIDATES };
