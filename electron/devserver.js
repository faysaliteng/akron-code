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
const { spawn } = require('child_process');

const CANDIDATES = [
  { port: 5173, framework: 'Vite' },
  { port: 5174, framework: 'Vite' },
  { port: 4321, framework: 'Astro' },
  { port: 3000, framework: 'Next.js' },
  { port: 3001, framework: 'Next.js' },
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
  return hit ? hit.framework : 'dev server';
}

async function detect(cwd) {
  const pkg = readPackage(cwd);
  const script = pickScript(pkg);
  const results = await Promise.all(CANDIDATES.map((c) => probePort(c.port)));
  const idx = results.indexOf(true);
  const port = idx >= 0 ? CANDIDATES[idx].port : null;
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
