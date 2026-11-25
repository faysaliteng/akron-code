'use strict';
/**
 * Bundled agent runtimes + self-update.
 *
 * Akron Bot ships the three CLI agents it can drive (Claude Code, Codex, Grok)
 * inside the app bundle so a fresh DMG works with no `npm i -g` step, and keeps
 * them current from the same upstream the vendors publish to:
 *
 *   Claude Code  npm  @anthropic-ai/claude-code(-<platform>)   dist.integrity (sha512)
 *   Codex        npm  @openai/codex(-<platform>)               dist.integrity (sha512)
 *   Grok         x.ai https://x.ai/cli/<channel> → binary      no upstream checksum
 *
 * Resolution order, per runtime:
 *   1. `~/Library/Application Support/Akron Bot/runtimes/<id>/current`  (self-updated)
 *   2. `<resources>/runtimes/<id>`                                      (shipped in the DMG)
 *   3. `PATH`                                                           (system install)
 *
 * Downloads are HTTPS-only, host-allowlisted, size-capped, integrity-checked
 * where upstream publishes a hash, then the extracted binary is executed once
 * (`--version`) before it is promoted — a broken download can never displace a
 * working runtime.
 *
 * Pure Node (no electron import) so the whole thing is unit-testable.
 */

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Readable } = require('stream');

const NPM = 'https://registry.npmjs.org';
const GROK_POINTERS = [
  'https://x.ai/cli/stable',
  'https://storage.googleapis.com/grok-build-public-artifacts/cli/stable',
];
const ALLOWED_HOSTS = new Set(['registry.npmjs.org', 'x.ai', 'storage.googleapis.com']);
const MAX_ARTIFACT = 900 * 1024 * 1024;   // hard cap: a runtime tarball is ~100–400 MB
const MIN_ARTIFACT = 1024 * 1024;         // anything small is a redirect page / HTML error
const CHECK_TTL = 10 * 60 * 1000;         // in-memory metadata cache
const KEEP_VERSIONS = 2;                  // rollback depth on disk

// ---------------------------------------------------------------- platform

function platformSuffix(platform, arch) {
  const map = {
    'darwin-arm64': 'darwin-arm64',
    'darwin-x64': 'darwin-x64',
    'linux-x64': 'linux-x64',
    'linux-arm64': 'linux-arm64',
    'win32-x64': 'win32-x64',
    'win32-arm64': 'win32-arm64',
  };
  const key = platform + '-' + arch;
  const suffix = map[key];
  if (!suffix) {
    const e = new Error('unsupported platform: ' + key);
    e.code = 'runtime_platform';
    throw e;
  }
  return suffix;
}

function vendorTriple(platform, arch) {
  // Codex unpacks its payload under a Rust target triple.
  if (platform === 'darwin') return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  if (platform === 'linux') return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  return arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
}

// ---------------------------------------------------------------- descriptors

/**
 * `meta` returns { version, artifactVersion?, url, integrity?, kind }.
 * `stage` turns an extracted package root into `<dir>/bin/<bin>`.
 */
const DESCRIPTORS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    vendor: 'Anthropic',
    bin: 'claude',
    versionArgs: ['--version'],
    async meta(ctx) {
      const suffix = platformSuffix(ctx.platform, ctx.arch);
      const pkg = '@anthropic-ai/claude-code-' + suffix;
      const j = await ctx.json(ctx.npm + '/' + pkg + '/latest');
      const version = String(j.version || '');
      if (!version) throw new Error('claude-code: registry returned no version');
      return { version, url: j.dist && j.dist.tarball, integrity: j.dist && j.dist.integrity, kind: 'tgz' };
    },
    async stage(pkgRoot, dest, ctx) {
      // Layout moved between releases: older platform packages put the native
      // binary at `bin/claude` (package.json maps `bin.claude → bin/claude.exe`
      // even on macOS, and the postinstall overwrote that placeholder), while
      // 2.1.33x ships it at the package root as `claude`. Accept both.
      const names = ctx.platform === 'win32' ? ['claude.exe', 'claude'] : ['claude', 'claude.exe'];
      let src = '';
      for (const dir of ['bin', '.']) {
        for (const n of names) {
          const p = path.join(pkgRoot, dir, n);
          if (fs.existsSync(p) && fs.statSync(p).isFile()) { src = p; break; }
        }
        if (src) break;
      }
      if (!src) throw new Error('claude-code: the package does not contain a claude binary');
      await fsp.mkdir(path.join(dest, 'bin'), { recursive: true });
      await copyExecutable(src, path.join(dest, 'bin', ctx.platform === 'win32' ? 'claude.exe' : 'claude'));
      // The SDK type surface is useful for editor integrations; keep it when shipped.
      for (const extra of ['sdk-tools.d.ts']) {
        const p = path.join(pkgRoot, extra);
        if (fs.existsSync(p)) await fsp.copyFile(p, path.join(dest, extra));
      }
    },
    binPath: (dir, platform) => path.join(dir, 'bin', platform === 'win32' ? 'claude.exe' : 'claude'),
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    bin: 'codex',
    versionArgs: ['--version'],
    async meta(ctx) {
      const suffix = platformSuffix(ctx.platform, ctx.arch);
      const base = await ctx.json(ctx.npm + '/@openai/codex/latest');
      const version = String(base.version || '');
      const alias = String((base.optionalDependencies || {})['@openai/codex-' + suffix] || '');
      // `npm:@openai/codex@0.172.0-darwin-arm64` — the artifact version carries the suffix.
      const artifactVersion = alias.slice(alias.lastIndexOf('@') + 1) || version;
      const j = await ctx.json(ctx.npm + '/@openai/codex/' + artifactVersion);
      return { version, artifactVersion, url: j.dist && j.dist.tarball, integrity: j.dist && j.dist.integrity, kind: 'tgz' };
    },
    async stage(pkgRoot, dest, ctx) {
      const triple = vendorTriple(ctx.platform, ctx.arch);
      const from = path.join(pkgRoot, 'vendor', triple);
      if (!fs.existsSync(from)) throw new Error('codex: this package does not contain vendor/' + triple);
      await fsp.mkdir(dest, { recursive: true });
      await copyTree(from, path.join(dest, 'vendor', triple));
      const bin = path.join(dest, 'bin', 'codex');
      await fsp.mkdir(path.dirname(bin), { recursive: true });
      // Relative symlink so the tree stays valid wherever it is installed.
      await removeIfExists(bin);
      await fsp.symlink(path.join('..', 'vendor', triple, 'bin', 'codex'), bin);
    },
    binPath: (dir) => path.join(dir, 'bin', 'codex'),
  },
  {
    id: 'grok',
    label: 'Grok CLI',
    vendor: 'xAI',
    bin: 'grok',
    versionArgs: ['--version'],
    async meta(ctx) {
      let pointer = '';
      let base = '';
      let lastErr = null;
      for (const url of (ctx.grokPointers || GROK_POINTERS)) {
        try {
          pointer = (await ctx.text(url)).trim().split(/\r?\n/)[0].trim();
          if (/^\d+\.\d+\.\d+(-[A-Za-z0-9._]+)?$/.test(pointer)) {
            const u = new URL(url);
            base = u.origin + u.pathname.replace(/[^/]*$/, '');
            break;
          }
          pointer = '';
        } catch (e) { lastErr = e; }
      }
      if (!pointer) throw lastErr || new Error('grok: could not read the release pointer');
      const suffix = ctx.platform === 'darwin'
        ? (ctx.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64')
        : (ctx.platform === 'linux'
          ? (ctx.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64')
          : 'windows-x86_64');
      const name = 'grok-' + pointer + '-' + suffix + (ctx.platform === 'win32' ? '.exe' : '');
      // Artifacts sit beside the pointer: …/cli/stable → …/cli/grok-<ver>-<platform>.
      // Deriving the base keeps the GCS mirror (and the test registry) working.
      return {
        version: pointer,
        url: String(base || 'https://x.ai/cli/').replace(/\/+$/, '') + '/' + name,
        // Upstream publishes no checksum (install.sh does not verify one either);
        // integrity is therefore recorded locally after download, not asserted.
        integrity: '',
        kind: 'bin',
      };
    },
    async stage(pkgRoot, dest, ctx) {
      await fsp.mkdir(path.join(dest, 'bin'), { recursive: true });
      const name = ctx.platform === 'win32' ? 'grok.exe' : 'grok';
      await copyExecutable(pkgRoot, path.join(dest, 'bin', name));
    },
    binPath: (dir, platform) => path.join(dir, 'bin', platform === 'win32' ? 'grok.exe' : 'grok'),
  },
];

// ---------------------------------------------------------------- helpers

async function removeIfExists(p) {
  try { await fsp.rm(p, { recursive: true, force: true }); } catch (_) { /* ignore */ }
}

async function copyExecutable(from, to) {
  await fsp.copyFile(from, to);
  await fsp.chmod(to, 0o755);
}

async function copyTree(from, to) {
  await fsp.mkdir(path.dirname(to), { recursive: true });
  await fsp.cp(from, to, { recursive: true, dereference: false, force: true });
  // node's cp preserves mode; be explicit for binaries.
  await chmodTree(to);
}

async function chmodTree(root) {
  let entries = [];
  try { entries = await fsp.readdir(root, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) await chmodTree(p);
    else if (e.isFile()) {
      try {
        const st = await fsp.stat(p);
        if (st.mode & 0o111) await fsp.chmod(p, 0o755);
      } catch (_) { /* ignore */ }
    }
  }
}

function run(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: (opts && opts.timeout) || 20000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (err.code || 1) : 0,
        signal: err && err.signal ? err.signal : '',
        msg: err && !stdout && !stderr ? String(err.message || '').slice(0, 200) : '',
        out: String(stdout || ''),
        err: String(stderr || ''),
      });
    });
  });
}

/** `2.1.154 (Claude Code)` / `codex-cli 0.135.0` / `grok 0.2.2 (c9b7d)` → version token. */
function parseVersion(text) {
  const m = String(text || '').match(/\d+\.\d+\.\d+(?:-[A-Za-z0-9._]+)?/);
  return m ? m[0] : '';
}

function sanitizeVersion(v) {
  const s = String(v || '').trim();
  return /^[0-9A-Za-z._+-]{1,64}$/.test(s) ? s : '';
}

/**
 * @param {string} url
 * @param {{hosts?: Set<string>, insecure?: boolean}} [opts]
 *   `insecure` exists only for the test suite (a loopback registry); production
 *   callers never pass it, so HTTPS + host allowlisting stay the default.
 */
function assertHttps(url, opts) {
  const o = opts || {};
  const hosts = o.hosts || ALLOWED_HOSTS;
  let u;
  try { u = new URL(url); } catch (_) { throw new Error('runtime: malformed URL'); }
  if (u.protocol !== 'https:' && !o.insecure) throw new Error('runtime: refusing non-HTTPS download');
  if (!hosts.has(u.hostname)) throw new Error('runtime: host not allowlisted — ' + u.hostname);
  return u;
}

function which(bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch (_) { /* next */ }
  }
  return '';
}

// ---------------------------------------------------------------- manager

/**
 * @param {object} opts
 * @param {string} opts.userDir      writable root (app.getPath('userData'))
 * @param {string} opts.bundledDir   read-only bundled root (resources/runtimes)
 * @param {Function} [opts.fetchImpl]
 * @param {string} [opts.platform]
 * @param {string} [opts.arch]
 * @param {Function} [opts.onEvent]
 */
function createRuntimes(opts) {
  const o = opts || {};
  const root = path.join(o.userDir || path.join(os.homedir(), '.autobot'), 'runtimes');
  const bundledDir = o.bundledDir || '';
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  const fetchImpl = o.fetchImpl || ((...a) => fetch(...a));
  const onEvent = typeof o.onEvent === 'function' ? o.onEvent : () => {};
  const metaCache = new Map();
  const busy = new Map();
  let state = null;

  // Network policy. `hosts`/`insecure` are only overridden by the test suite; a
  // shipped app always uses HTTPS to the vendor's own registry.
  const net = { hosts: o.allowHosts || ALLOWED_HOSTS, insecure: !!o.allowInsecure };
  const npmBase = String(o.npm || NPM).replace(/\/+$/, '');
  const grokPointers = Array.isArray(o.grokPointers) ? o.grokPointers : GROK_POINTERS;
  const minArtifact = Number.isFinite(o.minArtifact) ? Number(o.minArtifact) : MIN_ARTIFACT;

  const ctx = { platform, arch };
  const ctxNet = { ...ctx, npm: npmBase, grokPointers, ...net };

  function emit(ev) {
    try { onEvent(ev); } catch (_) { /* never let a listener break an install */ }
  }

  async function json(url) {
    const u = assertHttps(url, net);
    const res = await fetchImpl(u.href, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('runtime: ' + u.hostname + ' answered ' + res.status);
    return res.json();
  }

  async function text(url) {
    const u = assertHttps(url, net);
    const res = await fetchImpl(u.href, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error('runtime: ' + u.hostname + ' answered ' + res.status);
    return res.text();
  }

  const ctxNetFinal = { ...ctxNet, json, text };

  function descriptor(id) {
    const d = DESCRIPTORS.find((x) => x.id === id);
    if (!d) throw new Error('runtime: unknown runtime ' + id);
    return d;
  }

  // -- state file (auto-update preference, last check) ----------------------

  async function loadState() {
    if (state) return state;
    state = { autoUpdate: true, lastCheck: 0, updated: {} };
    try {
      const raw = await fsp.readFile(path.join(root, 'state.json'), 'utf8');
      const j = JSON.parse(raw);
      state = {
        autoUpdate: j.autoUpdate !== false,
        lastCheck: Number(j.lastCheck) || 0,
        updated: j.updated && typeof j.updated === 'object' ? j.updated : {},
      };
    } catch (_) { /* first run */ }
    return state;
  }

  async function saveState(patch) {
    const s = { ...(await loadState()), ...(patch || {}) };
    state = s;
    try {
      await fsp.mkdir(root, { recursive: true });
      const tmp = path.join(root, '.state.' + process.pid + '.json');
      await fsp.writeFile(tmp, JSON.stringify(s, null, 2));
      await fsp.rename(tmp, path.join(root, 'state.json'));
    } catch (_) { /* best effort */ }
    return s;
  }

  // -- discovery -----------------------------------------------------------

  async function readVersionFile(dir) {
    try { return (await fsp.readFile(path.join(dir, 'VERSION'), 'utf8')).trim(); } catch (_) { return ''; }
  }

  async function currentLink(id) {
    const link = path.join(root, id, 'current');
    try {
      const target = await fsp.readlink(link);
      const dir = path.isAbsolute(target) ? target : path.join(root, id, target);
      const st = await fsp.stat(dir);
      return st.isDirectory() ? dir : '';
    } catch (_) { return ''; }
  }

  /** Resolved runtime: self-updated → bundled → PATH. Never throws. */
  async function resolve(id) {
    const d = descriptor(id);
    const installedDir = await currentLink(id);
    if (installedDir) {
      const bin = d.binPath(installedDir, platform);
      if (fs.existsSync(bin)) {
        return { id, bin, dir: installedDir, version: await readVersionFile(installedDir), source: 'installed' };
      }
    }
    if (bundledDir) {
      const dir = path.join(bundledDir, id);
      const bin = d.binPath(dir, platform);
      if (fs.existsSync(bin)) {
        return { id, bin, dir, version: await readVersionFile(dir), source: 'bundled' };
      }
    }
    const sys = which(d.bin);
    if (sys) return { id, bin: sys, dir: path.dirname(sys), version: '', source: 'system' };
    return { id, bin: '', dir: '', version: '', source: 'missing' };
  }

  async function systemVersion(runtime) {
    if (!runtime || runtime.source !== 'system' || !runtime.bin) return '';
    const d = descriptor(runtime.id);
    const res = await run(runtime.bin, d.versionArgs, { timeout: 8000 });
    return res.ok ? parseVersion(res.out || res.err) : '';
  }

  // -- upstream metadata ---------------------------------------------------

  async function meta(id, force) {
    const hit = metaCache.get(id);
    if (!force && hit && Date.now() - hit.at < CHECK_TTL) return hit.meta;
    const m = await descriptor(id).meta(ctxNetFinal);
    if (!m.url) throw new Error('runtime: ' + id + ' has no download for ' + platform + '-' + arch);
    assertHttps(m.url, net);
    metaCache.set(id, { at: Date.now(), meta: m });
    return m;
  }

  // -- download ------------------------------------------------------------

  async function sha256File(file) {
    const h = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      fs.createReadStream(file).on('data', (c) => h.update(c)).on('error', reject).on('end', resolve);
    });
    return h.digest('hex');
  }

  /**
   * Fetch `url` to `destFile`, hashing what arrives and verifying what landed.
   *
   * Every chunk is copied before it is hashed or queued for the disk. The
   * response body is a Chromium/undici stream that recycles its buffers: a
   * chunk handed straight to `write()` can be rewritten while it sits in the
   * write queue, which lands mutated bytes on disk with the correct length
   * (measured in-app: 14 MB of a 190 MB binary differed, first diff ~240 KB in,
   * shifted runs — while the hash of the bytes as received was correct). Own
   * copies make the queued data unconditional. The hash-vs-disk check below is
   * kept as a last line of defence and repairs from a single buffer if it ever
   * trips.
   */
  async function download(url, destFile, expect) {
    const u = assertHttps(url, net);
    emit({ id: expect.id, phase: 'download', pct: 0, message: 'Downloading ' + expect.version });
    const res = await fetchImpl(u.href, { signal: AbortSignal.timeout(15 * 60 * 1000) });
    if (!res.ok) throw new Error('runtime: download failed — HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ARTIFACT) throw new Error('runtime: artifact is implausibly large (' + len + ' bytes)');
    const body = res.body;
    if (!body) throw new Error('runtime: empty response body');
    await fsp.mkdir(path.dirname(destFile), { recursive: true });

    const hash = crypto.createHash('sha512');
    const hash256 = crypto.createHash('sha256');
    let written = 0;
    let lastPct = -1;

    const stream = typeof body.getReader === 'function' ? Readable.fromWeb(body) : body;
    const out = fs.createWriteStream(destFile, { mode: 0o644 });
    try {
      for await (const chunk of stream) {
        if (written + chunk.length > MAX_ARTIFACT) throw new Error('runtime: download exceeded the size cap');
        const buf = Buffer.from(chunk); // private copy - see note above
        hash.update(buf);
        hash256.update(buf);
        written += buf.length;
        if (len) {
          const pct = Math.min(99, Math.floor((written / len) * 100));
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            emit({ id: expect.id, phase: 'download', pct, message: written + '/' + len + ' bytes' });
          }
        }
        if (!out.write(buf)) await new Promise((done) => out.once('drain', done));
      }
      await new Promise((done, fail) => {
        out.once('error', fail);
        out.once('finish', done);
        out.end();
      });
    } catch (err) {
      out.destroy();
      try { await fsp.unlink(destFile); } catch (_) { /* ignore */ }
      throw err;
    }

    if (written < minArtifact) throw new Error('runtime: artifact is too small to be real (' + written + ' bytes)');
    const sri = 'sha512-' + hash.digest('base64');
    const wireSha = hash256.digest('hex');

    // What landed must be what arrived. A mismatch is repaired once from a
    // single in-memory buffer, which is byte-exact, then re-verified.
    let diskSha = await sha256File(destFile);
    if (diskSha !== wireSha) {
      emit({ id: expect.id, phase: 'download', pct: 99, message: 'Repairing download' });
      const retry = await fetchImpl(u.href, { signal: AbortSignal.timeout(15 * 60 * 1000) });
      if (!retry.ok) throw new Error('runtime: download repair failed — HTTP ' + retry.status);
      const buf = Buffer.from(await retry.arrayBuffer());
      if (buf.length !== written) throw new Error('runtime: download changed length on retry (' + buf.length + ' != ' + written + ')');
      await fsp.writeFile(destFile, buf, { mode: 0o644 });
      diskSha = await sha256File(destFile);
      if (diskSha !== wireSha) {
        throw new Error('runtime: download is corrupt on disk (sha256 ' + diskSha.slice(0, 16) + ' != ' + wireSha.slice(0, 16) + ')');
      }
    }
    return { sri, sha256: wireSha, size: written };
  }

  function integrityOf(integrity, sri) {
    // npm publishes `sha512-<base64>`; compare algorithm-for-algorithm.
    if (!integrity) return { verified: false, reason: 'upstream publishes no checksum' };
    const algo = String(integrity).split('-')[0];
    if (algo !== 'sha512') return { verified: false, reason: 'unsupported integrity algorithm ' + algo };
    if (integrity !== sri) throw new Error('runtime: integrity mismatch — download rejected');
    return { verified: true, reason: '' };
  }

  async function extractTgz(file, into) {
    await fsp.mkdir(into, { recursive: true });
    const res = await run('tar', ['-xzf', file, '-C', into], { timeout: 5 * 60 * 1000 });
    if (!res.ok) throw new Error('runtime: could not extract archive — ' + (res.err || res.code));
    let entries = await fsp.readdir(into, { withFileTypes: true });
    // npm tarballs wrap everything in `package/`; tolerate other single roots.
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 1 && entries.length === 1) return path.join(into, dirs[0].name);
    if (dirs.some((e) => e.name === 'package')) return path.join(into, 'package');
    return into;
  }

  // -- install -------------------------------------------------------------

  async function install(id, wanted, opts) {
    const d = descriptor(id);
    if (busy.get(id)) throw new Error('runtime: ' + d.label + ' is already updating');
    busy.set(id, true);
    const work = path.join(root, '.tmp', id + '-' + Date.now().toString(36));
    try {
      const m = await meta(id, true);
      const version = sanitizeVersion(wanted || m.version);
      if (!version) throw new Error('runtime: invalid version');
      const current = await resolve(id);
      // `force` is the UI's Reinstall: same version, but replace the files.
      if (!(opts && opts.force) && current.source === 'installed' && current.version === version) {
        emit({ id, phase: 'done', pct: 100, message: d.label + ' is already ' + version, version });
        return { ok: true, version, unchanged: true };
      }
      await fsp.mkdir(work, { recursive: true });
      const artifact = path.join(work, m.kind === 'tgz' ? 'artifact.tgz' : 'artifact.bin');
      const got = await download(m.url, artifact, { id, version });
      const integ = integrityOf(m.integrity, got.sri);
      if (integ.verified) emit({ id, phase: 'verify', pct: 100, message: 'sha512 verified' });
      else emit({ id, phase: 'verify', pct: 100, message: integ.reason });

      emit({ id, phase: 'extract', pct: 0, message: 'Unpacking ' + version });
      const stage = path.join(work, 'stage');
      await fsp.mkdir(stage, { recursive: true });
      let pkgRoot = artifact;
      if (m.kind === 'tgz') pkgRoot = await extractTgz(artifact, path.join(work, 'unpacked'));
      await d.stage(pkgRoot, stage, ctx);

      const bin = d.binPath(stage, platform);
      if (!fs.existsSync(bin)) throw new Error('runtime: the archive did not contain ' + bin);

      emit({ id, phase: 'verify-bin', pct: 0, message: 'Smoke-testing the new binary' });
      const probe = await run(bin, d.versionArgs, { timeout: 30000 });
      const reported = parseVersion(probe.out || probe.err);
      if (!probe.ok || !reported) {
        // A silent failure here means a broken artifact or an unusable platform
        // build; a short, quotable reason beats a silently stale runtime.
        const bits = [];
        if (probe.code != null) bits.push('exit=' + probe.code);
        if (probe.signal) bits.push('signal=' + probe.signal);
        const said = String(probe.err || probe.out || probe.msg || '').trim().split('\n')[0];
        bits.push(said ? said.slice(0, 120) : 'no version in output');
        try { bits.push('size=' + (await fsp.stat(bin)).size); } catch (_) { /* ignore */ }
        throw new Error('runtime: the new ' + d.label + ' binary does not run (' + bits.join(', ') + ')');
      }

      await fsp.writeFile(path.join(stage, 'VERSION'), reported + '\n');
      await fsp.writeFile(path.join(stage, 'META.json'), JSON.stringify({
        id,
        version: reported,
        artifactVersion: m.artifactVersion || m.version,
        source: m.url,
        integrity: m.integrity || '',
        sha256: got.sha256,
        size: got.size,
        installedAt: new Date().toISOString(),
      }, null, 2));

      // Promote: move into place, then atomically repoint `current`.
      const versionsDir = path.join(root, id);
      await fsp.mkdir(versionsDir, { recursive: true });
      const finalDir = path.join(versionsDir, reported);
      await removeIfExists(finalDir);
      await fsp.rename(stage, finalDir);
      const link = path.join(versionsDir, 'current');
      const tmpLink = path.join(versionsDir, '.current.' + process.pid);
      await removeIfExists(tmpLink);
      await fsp.symlink(reported, tmpLink);
      await fsp.rename(tmpLink, link);

      await prune(id, reported);
      await saveState({ updated: { ...(await loadState()).updated, [id]: { version: reported, at: Date.now() } } });
      emit({ id, phase: 'done', pct: 100, message: d.label + ' ' + reported + ' installed', version: reported });
      return { ok: true, version: reported, previous: current.version || '', integrity: integ.verified, sha256: got.sha256 };
    } catch (e) {
      emit({ id, phase: 'error', pct: 0, message: String(e && e.message || e) });
      throw e;
    } finally {
      busy.delete(id);
      await removeIfExists(work);
    }
  }

  async function prune(id, keep) {
    const dir = path.join(root, id);
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return; }
    const versions = [];
    for (const e of entries) {
      if (!e.isDirectory() || e.name === '.tmp') continue;
      if (!/^\d+\.\d+\.\d+/.test(e.name)) continue;
      try {
        const st = await fsp.stat(path.join(dir, e.name));
        versions.push({ name: e.name, at: st.mtimeMs });
      } catch (_) { /* ignore */ }
    }
    versions.sort((a, b) => b.at - a.at);
    const stale = versions.filter((v) => v.name !== keep).slice(KEEP_VERSIONS - 1);
    for (const v of stale) await removeIfExists(path.join(dir, v.name));
  }

  async function rollback(id) {
    const dir = path.join(root, id);
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch (_) { return { ok: false, error: 'nothing to roll back to' }; }
    const versions = [];
    for (const e of entries) {
      if (e.isDirectory() && /^\d+\.\d+\.\d+/.test(e.name)) {
        const st = await fsp.stat(path.join(dir, e.name));
        versions.push({ name: e.name, at: st.mtimeMs });
      }
    }
    versions.sort((a, b) => b.at - a.at);
    const cur = await currentLink(id);
    const curName = cur ? path.basename(cur) : '';
    const prev = versions.find((v) => v.name !== curName);
    if (!prev) return { ok: false, error: 'no previous version on disk' };
    const link = path.join(dir, 'current');
    const tmpLink = path.join(dir, '.current.' + process.pid);
    await removeIfExists(tmpLink);
    await fsp.symlink(prev.name, tmpLink);
    await fsp.rename(tmpLink, link);
    const after = await resolve(id);
    return { ok: true, version: after.version };
  }

  // -- status --------------------------------------------------------------

  async function status(id, opts) {
    const d = descriptor(id);
    const force = !!(opts && opts.force);
    const s = await loadState();
    const runtime = await resolve(id);
    let version = runtime.version;
    if (!version && runtime.source === 'system') version = await systemVersion(runtime);
    let latest = '';
    let error = '';
    try { latest = (await meta(id, force)).version; } catch (e) { error = String(e && e.message || e); }
    const updateAvailable = !!(latest && version && latest !== version);
    return {
      id,
      label: d.label,
      vendor: d.vendor,
      bin: d.bin,
      version,
      latest,
      source: runtime.source,
      updateAvailable,
      outdated: updateAvailable,
      autoUpdate: s.autoUpdate !== false,
      busy: !!busy.get(id),
      error,
      checkedAt: metaCache.get(id) ? metaCache.get(id).at : 0,
      lastInstalled: (s.updated || {})[id] || null,
    };
  }

  async function list(opts) {
    const out = [];
    for (const d of DESCRIPTORS) {
      try {
        out.push(await status(d.id, opts));
      } catch (e) {
        out.push({ id: d.id, label: d.label, vendor: d.vendor, bin: '', version: '', latest: '', source: 'missing', updateAvailable: false, busy: !!busy.get(d.id), error: String(e && e.message || e), autoUpdate: true });
      }
    }
    return out;
  }

  async function checkAll(opts) {
    await saveState({ lastCheck: Date.now() });
    const rows = await list(opts);
    const updates = rows.filter((r) => r.updateAvailable).map((r) => ({ id: r.id, version: r.latest, from: r.version }));
    return { ok: true, runtimes: rows, updates };
  }

  /**
   * Install every available update. Runs sequentially so a 400 MB download does
   * not compete with the other two. A failure on one runtime never stops the rest.
   */
  async function updateAll() {
    const rows = await list();
    const results = [];
    for (const r of rows) {
      if (!r.updateAvailable) continue;
      try {
        results.push({ id: r.id, ...(await install(r.id, r.latest)) });
      } catch (e) {
        results.push({ id: r.id, ok: false, error: String(e && e.message || e) });
      }
    }
    return { ok: true, results, runtimes: await list() };
  }

  /** PATH additions for child processes: self-updated dirs, then bundled dirs. */
  async function envPath() {
    const dirs = [];
    for (const d of DESCRIPTORS) {
      const r = await resolve(d.id);
      if (r.bin) dirs.push(path.dirname(r.bin));
    }
    return dirs.join(path.delimiter);
  }

  /** Exported so the Bash tool can append the same dirs after the login shell's PATH. */
  async function shellPathSuffix() {
    const dirs = [];
    for (const d of DESCRIPTORS) {
      const r = await resolve(d.id);
      if (r.bin) dirs.push(path.dirname(r.bin));
    }
    return dirs.join(':');
  }

  return {
    DESCRIPTORS,
    resolve,
    status,
    list,
    checkAll,
    updateAll,
    install,
    rollback,
    envPath,
    shellPathSuffix,
    loadState,
    saveState,
    setAutoUpdate: (on) => saveState({ autoUpdate: !!on }),
    _paths: { root, bundledDir },
  };
}

module.exports = {
  createRuntimes,
  DESCRIPTORS,
  platformSuffix,
  vendorTriple,
  parseVersion,
  sanitizeVersion,
  assertHttps,
  ALLOWED_HOSTS,
};
