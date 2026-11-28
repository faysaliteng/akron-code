#!/usr/bin/env node
'use strict';
/**
 * Populate `vendor/runtimes/` — the copy of the agent CLIs that ships inside the
 * DMG via electron-builder's `extraResources`.
 *
 * Two modes:
 *
 *   node scripts/vendor-runtimes.js                 # from this machine's installs (fast, offline)
 *   node scripts/vendor-runtimes.js --download      # from upstream (authoritative, slow)
 *   node scripts/vendor-runtimes.js --check         # report what is vendored
 *   node scripts/vendor-runtimes.js --id grok       # limit to one runtime
 *   node scripts/vendor-runtimes.js --force         # re-vendor even if present
 *
 * Both modes produce the same on-disk layout that `electron/runtimes.js`
 * resolves at boot:
 *
 *   vendor/runtimes/<id>/bin/<bin>      executable
 *   vendor/runtimes/<id>/VERSION        version reported by `--version`
 *   vendor/runtimes/<id>/META.json      provenance (source, sha256, size, time)
 *
 * A shipped runtime is a *starting point*: the app checks upstream on launch and
 * swaps in newer versions under userData, so vendoring an older local copy is
 * correct behaviour, not drift.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { createRuntimes, DESCRIPTORS, parseVersion, platformSuffix, vendorTriple } = require('../electron/runtimes');

const ROOT = path.join(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'runtimes');

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : '';
};

const MODE = flag('download') ? 'download' : flag('check') ? 'check' : 'local';
const ONLY = opt('id');
const FORCE = flag('force');
// `--stale` (download mode): keep an already-vendored copy only if upstream has
// nothing newer. Without it a vendored tree is trusted forever, so a release
// can ship a CLI old enough for the vendor to reject new models.
const STALE = flag('stale');
// `--dry-run` reports the decision (vendor / keep) and downloads nothing.
const DRY = flag('dry-run');

function die(msg) {
  console.error('vendor-runtimes: ' + msg);
  process.exit(1);
}

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeout || 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || ''), code: err ? (err.code || 1) : 0 });
    });
  });
}

function which(bin) {
  for (const d of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return '';
}

function realpath(p) {
  try { return fs.realpathSync(p); } catch (_) { return p; }
}

function existsDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_) { return false; }
}

function existsFile(p) {
  try { return fs.statSync(p).isFile(); } catch (_) { return false; }
}

/**
 * Where this machine already has each CLI. The package roots are what
 * descriptor.stage() expects (`bin/claude*`, `vendor/<triple>`, or a bare binary).
 */
function localRoot(id) {
  const npmG = path.join(path.dirname(path.dirname(which('node') || '/usr/local/bin/node')), 'lib', 'node_modules');
  if (id === 'claude-code') {
    const cands = [
      path.join(npmG, '@anthropic-ai', 'claude-code'),
      '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code',
      '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
    ];
    // A PATH-resolved `claude` is `<pkg>/bin/claude` (or a symlink into it).
    const w = which('claude');
    if (w) cands.push(path.join(path.dirname(path.dirname(realpath(w)))));
    for (const c of cands) if (existsFile(path.join(c, 'bin', 'claude')) || existsFile(path.join(c, 'bin', 'claude.exe'))) return c;
    return '';
  }
  if (id === 'codex') {
    const triple = vendorTriple(process.platform, process.arch);
    const suffix = platformSuffix(process.platform, process.arch);
    const base = [
      path.join(npmG, '@openai', 'codex', 'node_modules', '@openai', 'codex-' + suffix),
      '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-' + suffix,
      '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-' + suffix,
    ];
    // `codex` on PATH is often a Homebrew shim → follow it back to the package.
    const w = which('codex');
    if (w) {
      const rp = realpath(w);
      base.push(path.join(path.dirname(path.dirname(rp)), 'node_modules', '@openai', 'codex-' + suffix));
      base.push(path.dirname(path.dirname(rp)));
    }
    for (const c of base) if (existsDir(path.join(c, 'vendor', triple))) return c;
    return '';
  }
  if (id === 'grok') {
    const plat = process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64')
      : (process.platform === 'linux' ? (process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64') : 'windows-x86_64.exe');
    const cands = [
      path.join(os.homedir(), '.grok', 'downloads', 'grok-' + plat),
      realpath(path.join(os.homedir(), '.grok', 'bin', 'grok')),
      which('grok'),
    ];
    for (const c of cands) if (c && existsFile(c)) return c;
    return '';
  }
  if (id === 'gemini-cli') {
    const cands = [
      path.join(npmG, '@google', 'gemini-cli'),
      '/opt/homebrew/lib/node_modules/@google/gemini-cli',
      '/usr/local/lib/node_modules/@google/gemini-cli',
    ];
    const w = which('gemini');
    if (w) {
      const rp = realpath(w);
      cands.push(path.dirname(path.dirname(rp)));
    }
    for (const c of cands) if (existsFile(path.join(c, 'bundle', 'gemini.js'))) return c;
    return '';
  }
  return '';
}

async function sha256(file) {
  const h = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', resolve);
    s.on('error', reject);
  });
  return h.digest('hex');
}

async function finalize(dir, runtime, sourceMeta) {
  const bin = runtime.bin;
  const probe = await run(bin, ['--version'], 30000);
  const version = parseVersion(probe.out || probe.err);
  if (!probe.ok || !version) {
    throw new Error('the vendored ' + runtime.id + ' binary does not run: ' + (probe.err || probe.out || 'no output').slice(0, 200));
  }
  await fsp.writeFile(path.join(dir, 'VERSION'), version + '\n');
  const meta = {
    id: runtime.id,
    version,
    stagedAt: new Date().toISOString(),
    host: process.platform + '-' + process.arch,
    ...sourceMeta,
  };
  const binFile = path.join(dir, 'bin', path.basename(bin));
  meta.sha256 = await sha256(binFile);
  meta.size = (await fsp.stat(binFile)).size;
  await fsp.writeFile(path.join(dir, 'META.json'), JSON.stringify(meta, null, 2) + '\n');
  return { version, sha256: meta.sha256, size: meta.size };
}

async function vendorLocal(desc) {
  const src = localRoot(desc.id);
  if (!src) throw new Error('no local install found (try --download)');
  const dest = path.join(VENDOR, desc.id);
  const stage = dest + '.staging';
  await fsp.rm(stage, { recursive: true, force: true });
  await fsp.mkdir(stage, { recursive: true });
  try {
    await desc.stage(src, stage, { platform: process.platform, arch: process.arch });
    const bin = desc.binPath(stage, process.platform);
    if (!fs.existsSync(bin)) throw new Error('stage() produced no ' + bin);
    const out = await finalize(stage, { id: desc.id, bin }, { source: 'local:' + src, mode: 'local' });
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(stage, dest);
    return out;
  } catch (e) {
    await fsp.rm(stage, { recursive: true, force: true });
    throw e;
  }
}

async function vendorDownload(desc) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'akron-vendor-'));
  try {
    const rt = createRuntimes({
      userDir: tmp,
      bundledDir: '',
      onEvent: (ev) => {
        if (ev.phase === 'download' || ev.phase === 'extract') process.stderr.write('  ' + desc.id + ': ' + ev.message + '\n');
      },
    });
    await rt.install(desc.id);
    const resolved = await rt.resolve(desc.id);
    if (!resolved.bin) throw new Error('install produced no binary');
    const dest = path.join(VENDOR, desc.id);
    const stage = dest + '.staging';
    await fsp.rm(stage, { recursive: true, force: true });
    // Copy the installed version directory verbatim (bin/, VERSION, META.json).
    await fsp.cp(resolved.dir, stage, { recursive: true, dereference: true, force: true });
    const out = await finalize(stage, { id: desc.id, bin: desc.binPath(stage, process.platform) }, {
      source: 'upstream',
      mode: 'download',
      upstreamVersion: resolved.version,
    });
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(stage, dest);
    return out;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

/** Ask upstream (npm / x.ai) for the newest version without downloading it. */
async function upstreamLatest(desc) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'akron-latest-'));
  try {
    const rt = createRuntimes({
      userDir: tmp,
      bundledDir: '',
      onEvent: () => {},
    });
    const st = await rt.status(desc.id, { force: true });
    return { version: st.latest || '', error: st.error || '' };
  } catch (e) {
    return { version: '', error: String(e && e.message || e) };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/** `1.2.10` > `1.2.9`; prerelease sorts below the release. */
function cmpVersion(a, b) {
  const pa = parseVersion(a) || String(a || '');
  const pb = parseVersion(b) || String(b || '');
  if (pa === pb) return 0;
  const [ma, mb] = [pa, pb].map((v) => v.split('-'));
  const na = ma[0].split('.').map(Number);
  const nb = mb[0].split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) > (nb[i] || 0) ? 1 : -1;
  }
  if (ma[1] && !mb[1]) return -1;
  if (!ma[1] && mb[1]) return 1;
  return String(ma[1] || '').localeCompare(String(mb[1] || ''));
}

function human(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + ' ' + u[i];
}

async function readVendored(desc) {
  const dir = path.join(VENDOR, desc.id);
  if (!existsDir(dir)) return null;
  let meta = {};
  try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'META.json'), 'utf8')); } catch (_) {}
  let version = '';
  try { version = (await fsp.readFile(path.join(dir, 'VERSION'), 'utf8')).trim(); } catch (_) {}
  const bin = desc.binPath(dir, process.platform);
  if (!existsFile(bin)) return null;
  const st = fs.statSync(bin);
  return { dir, version, meta, size: meta.size || st.size };
}

async function main() {
  const targets = DESCRIPTORS.filter((d) => !ONLY || d.id === ONLY);
  if (!targets.length) die('unknown --id ' + ONLY);

  await fsp.mkdir(VENDOR, { recursive: true });

  if (MODE === 'check') {
    let total = 0;
    for (const d of DESCRIPTORS) {
      const v = await readVendored(d);
      if (!v) { console.log('  ' + d.id.padEnd(12) + ' — not vendored'); continue; }
      total += v.size;
      console.log('  ' + d.id.padEnd(12) + ' ' + String(v.version || '?').padEnd(12) + human(v.size).padStart(8) +
        '  ' + (v.meta.source || '?') + (v.meta.stagedAt ? ' @ ' + v.meta.stagedAt.slice(0, 10) : ''));
    }
    console.log('\n  total vendored: ' + human(total) + '  (' + VENDOR + ')');
    return;
  }

  console.log('vendoring runtimes → ' + VENDOR + '  [mode: ' + MODE + ']');
  const failures = [];
  for (const d of targets) {
    const existing = await readVendored(d);
    if (existing && !FORCE) {
      if (MODE === 'download' && STALE) {
        const { version: latest, error } = await upstreamLatest(d);
        if (!latest) {
          // Offline or a failed metadata lookup must not break a build.
          console.log('  ' + d.id.padEnd(12) + ' ' + existing.version + ' — kept (' +
            (error ? 'upstream lookup failed: ' + error.slice(0, 80) : 'no upstream version') + ')');
          continue;
        }
        if (cmpVersion(latest, existing.version) <= 0) {
          console.log('  ' + d.id.padEnd(12) + ' ' + existing.version + ' — current (upstream ' + latest + ')');
          continue;
        }
        console.log('  ' + d.id.padEnd(12) + ' ' + existing.version + ' → ' + latest + '  (upstream is newer)' + (DRY ? ' [dry-run]' : ''));
        if (DRY) continue;
      } else {
        console.log('  ' + d.id.padEnd(12) + ' ' + existing.version + ' — already vendored (use --force to redo)');
        continue;
      }
    }
    process.stdout.write('  ' + d.id.padEnd(12) + ' … ');
    try {
      const out = MODE === 'download' ? await vendorDownload(d) : await vendorLocal(d);
      console.log(out.version + '  ' + human(out.size) + '  sha256 ' + out.sha256.slice(0, 16) + '…');
    } catch (e) {
      console.log('FAILED');
      console.error('      ' + (e && e.message || e));
      failures.push({ id: d.id, error: String(e && e.message || e) });
    }
  }
  if (DRY) { console.log('\ndry-run: nothing was downloaded.'); return; }
  if (failures.length) {
    console.error('\n' + failures.length + ' runtime(s) not vendored: ' + failures.map((f) => f.id).join(', '));
    process.exitCode = 1;
  } else {
    console.log('\ndone. Rebuild with `npm run dist` to ship these.');
  }
}

main().catch((e) => die(e && e.stack || String(e)));
