'use strict';
/**
 * Unit tests for `electron/runtimes.js` — bundled agent CLIs, resolution order,
 * and the self-update pipeline.
 *
 * The interesting half of this module is network + filesystem + process work, so
 * these tests run a real loopback registry, serve real tarballs produced with
 * `tar`, and execute the staged binaries for real. The only production
 * behaviour that is switched off is the HTTPS/host-allowlist gate (`allowInsecure`
 * + `allowHosts`), because a unit test cannot present a CA-valid cert for
 * `registry.npmjs.org`.
 *
 * Covered:
 *   - platform naming (npm suffix + Rust triple)
 *   - resolve() order: installed → bundled → PATH → missing
 *   - status() update detection against the live pointer
 *   - install(): download → integrity → extract → stage → smoke-test → promote
 *   - integrity mismatch is fatal (no promotion)
 *   - a binary that fails --version is never promoted
 *   - rollback() repoints `current` to the previous version
 *   - auto-update preference persists
 *   - size cap + small-body rejection
 *   - HTTPS/host guard rejects a non-allowlisted host by default
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const rt = require('../electron/runtimes.js');

const { createRuntimes, platformSuffix, vendorTriple, parseVersion, sanitizeVersion, assertHttps, ALLOWED_HOSTS } = rt;

let pass = 0;
const pending = [];

/** Async assertion group. */
function aok(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      pass++;
      console.log('ok   - ' + name);
    } catch (e) {
      console.error('FAIL - ' + name + '\n       ' + (e && e.stack || e));
      process.exitCode = 1;
    }
  });
}

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('ok   - ' + name);
  } catch (e) {
    console.error('FAIL - ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-runtimes-test-'));
const SUFFIX = platformSuffix(process.platform, process.arch);
const TRIPLE = vendorTriple(process.platform, process.arch);

/** Build a `.tgz` whose `package/` root contains `files`. */
function makeTgz(name, files) {
  const src = path.join(TMP, 'src-' + name);
  fs.mkdirSync(path.join(src, 'package'), { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(src, 'package', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
    fs.chmodSync(p, 0o755);
  }
  const out = path.join(TMP, name + '.tgz');
  execFileSync('tar', ['-czf', out, '-C', src, 'package']);
  return out;
}

function sri(file) {
  return 'sha512-' + crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
}

function sh(body) {
  return '#!/bin/sh\n' + body + '\n';
}

// A fake claude package: `bin/claude.exe` prints a version (mirrors the real
// package, which ships the native binary under that name on every platform).
const CLAUDE_V2 = '2.9.9';
const claudeTgz = makeTgz('claude', {
  'bin/claude.exe': sh('echo "' + CLAUDE_V2 + ' (Claude Code)"'),
  'sdk-tools.d.ts': 'export {};\n',
});
const CLAUDE_INTEGRITY = sri(claudeTgz);

// A fake codex package: payload under the Rust triple, exactly like upstream.
const CODEX_V2 = '0.9.9';
const codexTgz = makeTgz('codex', {
  ['vendor/' + TRIPLE + '/bin/codex']: sh('echo "codex-cli ' + CODEX_V2 + '"'),
  ['vendor/' + TRIPLE + '/codex-path/rg']: sh('echo rg'),
});

// A fake grok release: a bare binary (no tarball, no checksum upstream).
const GROK_V2 = '9.9.9';
const grokTgzless = sh('echo "grok ' + GROK_V2 + ' (abc1234)"');

// A fake gemini-cli package: `bundle/gemini.js` entrypoint, matching upstream.
const GEMINI_V2 = '0.44.1';
const geminiTgz = makeTgz('gemini', {
  'bundle/gemini.js': sh('echo "' + GEMINI_V2 + '"'),
  'package.json': JSON.stringify({ name: '@google/gemini-cli', version: GEMINI_V2 }),
});
const GEMINI_INTEGRITY = sri(geminiTgz);

/** A registry that speaks just enough npm + x.ai to drive one install. */
function startRegistry() {
  const routes = new Map();
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.push(url);
    const handler = routes.get(url);
    if (!handler) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    handler(req, res);
  });
  routes.set('/@anthropic-ai/claude-code-' + SUFFIX + '/latest', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: CLAUDE_V2, dist: { tarball: base() + '/t/claude.tgz', integrity: CLAUDE_INTEGRITY } }));
  });
  routes.set('/t/claude.tgz', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(claudeTgz).size });
    res.end(fs.readFileSync(claudeTgz));
  });
  routes.set('/@openai/codex/latest', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      version: '0.8.0',
      optionalDependencies: { ['@openai/codex-' + SUFFIX]: 'npm:@openai/codex@' + CODEX_V2 + '-' + SUFFIX },
    }));
  });
  routes.set('/@openai/codex/' + CODEX_V2 + '-' + SUFFIX, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: CODEX_V2 + '-' + SUFFIX, dist: { tarball: base() + '/t/codex.tgz' } }));
  });
  routes.set('/t/codex.tgz', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(codexTgz).size });
    res.end(fs.readFileSync(codexTgz));
  });
  routes.set('/cli/stable', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(GROK_V2 + '\n');
  });
  const grokName = '/cli/grok-' + GROK_V2 + '-' + (process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64')
    : (process.platform === 'linux' ? (process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64') : 'windows-x86_64.exe'));
  routes.set(grokName, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(grokTgzless) });
    res.end(grokTgzless);
  });
  routes.set('/@google/gemini-cli/latest', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: GEMINI_V2, dist: { tarball: base() + '/t/gemini.tgz', integrity: GEMINI_INTEGRITY } }));
  });
  routes.set('/t/gemini.tgz', (req, res) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(geminiTgz).size });
    res.end(fs.readFileSync(geminiTgz));
  });
  let base = () => '';
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      base = () => 'http://127.0.0.1:' + port;
      resolve({
        server, routes, hits,
        base,
        opts(extra) {
          return {
            userDir: path.join(TMP, 'user-' + Math.random().toString(36).slice(2, 8)),
            bundledDir: '',
            platform: process.platform,
            arch: process.arch,
            npm: base() + '',
            grokPointers: [base() + '/cli/stable'],
            allowHosts: new Set(['127.0.0.1']),
            allowInsecure: true,
            minArtifact: 0,
            ...(extra || {}),
          };
        },
        close() {
          server.closeAllConnections();
          return new Promise((r) => server.close(r));
        },
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

ok('platform suffix matches npm package naming', () => {
  assert.strictEqual(platformSuffix('darwin', 'arm64'), 'darwin-arm64');
  assert.strictEqual(platformSuffix('darwin', 'x64'), 'darwin-x64');
  assert.strictEqual(platformSuffix('linux', 'arm64'), 'linux-arm64');
  assert.strictEqual(platformSuffix('win32', 'x64'), 'win32-x64');
  assert.throws(() => platformSuffix('aix', 'ppc64'), /unsupported platform/);
});

ok('codex payload triple matches Rust target naming', () => {
  assert.strictEqual(vendorTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.strictEqual(vendorTriple('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.strictEqual(vendorTriple('linux', 'x64'), 'x86_64-unknown-linux-gnu');
  assert.strictEqual(vendorTriple('win32', 'arm64'), 'aarch64-pc-windows-msvc');
});

ok('the four shipped runtimes are declared', () => {
  assert.deepStrictEqual(rt.DESCRIPTORS.map((d) => d.id), ['claude-code', 'codex', 'grok', 'gemini-cli']);
  for (const d of rt.DESCRIPTORS) {
    assert.ok(d.label && d.vendor && d.bin, d.id + ' needs label/vendor/bin');
    assert.deepStrictEqual(d.versionArgs, ['--version'], d.id);
  }
});

ok('parseVersion handles every vendor banner', () => {
  assert.strictEqual(parseVersion('2.1.154 (Claude Code)'), '2.1.154');
  assert.strictEqual(parseVersion('codex-cli 0.135.0'), '0.135.0');
  assert.strictEqual(parseVersion('grok 0.2.2 (c9b7d1e)'), '0.2.2');
  assert.strictEqual(parseVersion('1.0.92-alpha.3\n'), '1.0.92-alpha.3');
  assert.strictEqual(parseVersion('no version here'), '');
  assert.strictEqual(parseVersion(null), '');
});

ok('sanitizeVersion refuses anything path-like', () => {
  assert.strictEqual(sanitizeVersion(' 2.1.154 '), '2.1.154');
  assert.strictEqual(sanitizeVersion('../../etc/passwd'), '');
  assert.strictEqual(sanitizeVersion('1.0.0; rm -rf /'), '');
  assert.strictEqual(sanitizeVersion(''), '');
});

ok('assertHttps rejects http and unknown hosts by default', () => {
  assert.strictEqual(assertHttps('https://registry.npmjs.org/x').hostname, 'registry.npmjs.org');
  assert.throws(() => assertHttps('http://registry.npmjs.org/x'), /non-HTTPS/);
  assert.throws(() => assertHttps('https://evil.example/x'), /not allowlisted/);
  // Opt-in escape hatch used by the test suite only.
  assert.ok(assertHttps('http://127.0.0.1:1/x', { hosts: new Set(['127.0.0.1']), insecure: true }));
  assert.ok(ALLOWED_HOSTS.has('x.ai'));
});

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

ok('resolve() reports missing when nothing is installed', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts({ bundledDir: '' }));
    const r = await mgr.resolve('claude-code');
    // This machine may genuinely have claude on PATH, so assert the weaker but
    // meaningful property: nothing is resolved from our empty userData dir.
    assert.notStrictEqual(r.source, 'installed');
    assert.notStrictEqual(r.source, 'bundled');
  } finally { await reg.close(); }
});

ok('resolve() prefers the bundled copy when userData has none', async () => {
  const reg = await startRegistry();
  try {
    const bundled = path.join(TMP, 'bundled');
    const dir = path.join(bundled, 'grok', 'bin');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'grok'), sh('echo "grok 1.2.3"'), { mode: 0o755 });
    fs.writeFileSync(path.join(bundled, 'grok', 'VERSION'), '1.2.3\n');
    const mgr = createRuntimes(reg.opts({ bundledDir: bundled }));
    const r = await mgr.resolve('grok');
    assert.strictEqual(r.source, 'bundled');
    assert.strictEqual(r.version, '1.2.3');
    assert.strictEqual(r.bin, path.join(dir, 'grok'));
  } finally { await reg.close(); }
});

ok('resolve() prefers a self-updated install over the bundled copy', async () => {
  const reg = await startRegistry();
  try {
    const opts = reg.opts({ bundledDir: path.join(TMP, 'bundled2') });
    const bundledDir = path.join(opts.bundledDir, 'grok', 'bin');
    fs.mkdirSync(bundledDir, { recursive: true });
    fs.writeFileSync(path.join(bundledDir, 'grok'), sh('echo "grok 1.0.0"'), { mode: 0o755 });
    const mgr = createRuntimes(opts);
    const root = mgr._paths.root;
    const vdir = path.join(root, 'grok', '2.0.0');
    fs.mkdirSync(path.join(vdir, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(vdir, 'bin', 'grok'), sh('echo "grok 2.0.0"'), { mode: 0o755 });
    fs.writeFileSync(path.join(vdir, 'VERSION'), '2.0.0\n');
    fs.mkdirSync(path.join(root, 'grok'), { recursive: true });
    fs.symlinkSync('2.0.0', path.join(root, 'grok', 'current'));
    const r = await mgr.resolve('grok');
    assert.strictEqual(r.source, 'installed');
    assert.strictEqual(r.version, '2.0.0');
  } finally { await reg.close(); }
});

// ---------------------------------------------------------------------------
// End-to-end install
// ---------------------------------------------------------------------------

aok('install(claude-code) downloads, verifies sha512, and promotes', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    const events = [];
    const mgr2 = createRuntimes(reg.opts({ onEvent: (e) => events.push(e) }));
    const res = await mgr2.install('claude-code');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.version, CLAUDE_V2);
    assert.strictEqual(res.integrity, true, 'upstream sha512 must be verified');
    assert.ok(/^[0-9a-f]{64}$/.test(res.sha256));

    const r = await mgr2.resolve('claude-code');
    assert.strictEqual(r.source, 'installed');
    const out = execFileSync(r.bin, ['--version']).toString();
    assert.match(out, new RegExp(CLAUDE_V2));

    // VERSION + META.json provenance land next to the binary.
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'META.json'), 'utf8'));
    assert.strictEqual(meta.version, CLAUDE_V2);
    assert.strictEqual(meta.integrity, CLAUDE_INTEGRITY);
    assert.strictEqual(meta.size, fs.statSync(claudeTgz).size);

    // The install is atomic: `current` is a symlink, and the staging area is gone.
    assert.ok(fs.lstatSync(path.join(mgr2._paths.root, 'claude-code', 'current')).isSymbolicLink());
    assert.strictEqual(fs.existsSync(path.join(mgr2._paths.root, '.tmp', 'claude-code')), false);

    // Progress events fired in order and never leaked a file path.
    const phases = events.map((e) => e.phase);
    assert.ok(phases.includes('download'), 'download event');
    assert.ok(phases.includes('verify'), 'verify event');
    assert.ok(phases.includes('done'), 'done event');
    assert.strictEqual(events[events.length - 1].phase, 'done');
    for (const e of events) assert.ok(!/[\\/]Users[\\/]/.test(String(e.message)), 'event leaked a path: ' + e.message);
    void mgr;
  } finally { await reg.close(); }

aok('install() is a no-op at the current version, but {force} reinstalls', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    await mgr.install('claude-code');
    const before = JSON.parse(fs.readFileSync(path.join(mgr._paths.root, 'claude-code', CLAUDE_V2, 'META.json'), 'utf8'));

    const noop = await mgr.install('claude-code');
    assert.strictEqual(noop.unchanged, true, 'same version must not re-download');

    // The Reinstall button forces a fresh fetch of the same version.
    await new Promise((r) => setTimeout(r, 20));
    const forced = await mgr.install('claude-code', undefined, { force: true });
    assert.strictEqual(forced.ok, true);
    assert.strictEqual(forced.version, CLAUDE_V2);
    assert.notStrictEqual(forced.unchanged, true);
    const after = JSON.parse(fs.readFileSync(path.join(mgr._paths.root, 'claude-code', CLAUDE_V2, 'META.json'), 'utf8'));
    assert.ok(new Date(after.installedAt) > new Date(before.installedAt), 'reinstall must rewrite the install');
    assert.strictEqual((await mgr.resolve('claude-code')).source, 'installed');
    const out = execFileSync(path.join(mgr._paths.root, 'claude-code', 'current', 'bin', 'claude'), ['--version']).toString();
    assert.match(out, new RegExp(CLAUDE_V2));
  } finally { await reg.close(); }
});
});

aok('install(codex) reassembles the Rust-triple payload and links bin/codex', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    const res = await mgr.install('codex');
    assert.strictEqual(res.version, CODEX_V2);
    const r = await mgr.resolve('codex');
    assert.strictEqual(r.source, 'installed');
    assert.match(execFileSync(r.bin, ['--version']).toString(), new RegExp(CODEX_V2));
    // The helper binaries travel with the payload.
    assert.ok(fs.existsSync(path.join(r.dir, 'vendor', TRIPLE, 'codex-path', 'rg')));
  } finally { await reg.close(); }
});

aok('install(grok) accepts a bare binary with no upstream checksum', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    const res = await mgr.install('grok');
    assert.strictEqual(res.version, GROK_V2);
    assert.strictEqual(res.integrity, false, 'x.ai publishes no checksum — must say so');
    const r = await mgr.resolve('grok');
    assert.match(execFileSync(r.bin, ['--version']).toString(), new RegExp(GROK_V2));
    // A local sha256 is still recorded so a corrupt file is detectable later.
    const meta = JSON.parse(fs.readFileSync(path.join(r.dir, 'META.json'), 'utf8'));
    assert.ok(/^[0-9a-f]{64}$/.test(meta.sha256));
  } finally { await reg.close(); }
});

aok('an integrity mismatch is fatal and promotes nothing', async () => {
  const reg = await startRegistry();
  try {
    // Serve the real tarball with a bogus published hash.
    reg.routes.set('/@anthropic-ai/claude-code-' + SUFFIX + '/latest', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        version: CLAUDE_V2,
        dist: { tarball: reg.base() + '/t/claude.tgz', integrity: 'sha512-' + Buffer.alloc(64, 7).toString('base64') },
      }));
    });
    const mgr = createRuntimes(reg.opts());
    await assert.rejects(() => mgr.install('claude-code'), /integrity mismatch/);
    const r = await mgr.resolve('claude-code');
    assert.notStrictEqual(r.source, 'installed', 'a rejected download must not become current');
  } finally { await reg.close(); }
});

aok('a binary that fails --version is never promoted', async () => {
  const reg = await startRegistry();
  try {
    const broken = makeTgz('claude-broken', { 'bin/claude.exe': sh('exit 3') });
    // Publish the *correct* hash for the broken tarball so integrity passes and
    // the failure we observe is the smoke test, not the checksum.
    reg.routes.set('/@anthropic-ai/claude-code-' + SUFFIX + '/latest', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: CLAUDE_V2, dist: { tarball: reg.base() + '/t/claude.tgz', integrity: sri(broken) } }));
    });
    reg.routes.set('/t/claude.tgz', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(broken).size });
      res.end(fs.readFileSync(broken));
    });
    const mgr = createRuntimes(reg.opts());
    await assert.rejects(() => mgr.install('claude-code'), /does not run/);
    assert.notStrictEqual((await mgr.resolve('claude-code')).source, 'installed');
  } finally { await reg.close(); }
});

aok('an absurdly large declared artifact is refused before download', async () => {
  const reg = await startRegistry();
  try {
    reg.routes.set('/@anthropic-ai/claude-code-' + SUFFIX + '/latest', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: CLAUDE_V2, dist: { tarball: reg.base() + '/t/claude.tgz' } }));
    });
    reg.routes.set('/t/claude.tgz', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(2 * 1024 * 1024 * 1024) });
      res.end('x');
    });
    const mgr = createRuntimes(reg.opts());
    await assert.rejects(() => mgr.install('claude-code'), /implausibly large/);
  } finally { await reg.close(); }
});

aok('a redirect page instead of a binary is rejected', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts({ minArtifact: 1024 }));
    reg.routes.set('/cli/stable', (req, res) => { res.writeHead(200); res.end(GROK_V2); });
    await assert.rejects(() => mgr.install('grok'), /too small to be real/);
  } finally { await reg.close(); }
});

// ---------------------------------------------------------------------------
// Status / update detection / auto-update
// ---------------------------------------------------------------------------

aok('status() detects an update and updateAll() installs it', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    const before = await mgr.status('claude-code');
    assert.strictEqual(before.latest, CLAUDE_V2);
    assert.strictEqual(before.source === 'installed', false);

    await mgr.install('claude-code');
    const after = await mgr.status('claude-code');
    assert.strictEqual(after.version, CLAUDE_V2);
    assert.strictEqual(after.updateAvailable, false, 'just-installed must not look stale');

    // Publish a newer version and check again.
    const NEW = '3.0.0';
    const newer = makeTgz('claude-3', { 'bin/claude.exe': sh('echo "' + NEW + ' (Claude Code)"') });
    reg.routes.set('/@anthropic-ai/claude-code-' + SUFFIX + '/latest', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: NEW, dist: { tarball: reg.base() + '/t/claude3.tgz' } }));
    });
    reg.routes.set('/t/claude3.tgz', (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(newer).size });
      res.end(fs.readFileSync(newer));
    });

    const checked = await mgr.checkAll({ force: true });
    const row = checked.runtimes.find((r) => r.id === 'claude-code');
    assert.strictEqual(row.version, CLAUDE_V2);
    assert.strictEqual(row.latest, NEW);
    assert.strictEqual(row.updateAvailable, true);

    const res = await mgr.updateAll();
    const installed = res.results.find((r) => r.id === 'claude-code');
    assert.strictEqual(installed.ok, true);
    assert.strictEqual(installed.version, NEW);
    assert.strictEqual((await mgr.resolve('claude-code')).version, NEW);
  } finally { await reg.close(); }
});

aok('installing an unchanged version is a no-op', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    await mgr.install('grok');
    const again = await mgr.install('grok');
    assert.strictEqual(again.unchanged, true);
  } finally { await reg.close(); }
});

aok('rollback() repoints current to the previous version', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    await mgr.install('grok');
    const NEW = '10.0.0';
    reg.routes.set('/cli/stable', (req, res) => { res.writeHead(200); res.end(NEW + '\n'); });
    const name = '/cli/grok-' + NEW + '-' + (process.platform === 'darwin'
      ? (process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64')
      : (process.platform === 'linux' ? (process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64') : 'windows-x86_64.exe'));
    const body = sh('echo "grok ' + NEW + '"');
    reg.routes.set(name, (req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': Buffer.byteLength(body) });
      res.end(body);
    });
    await mgr.install('grok');
    assert.strictEqual((await mgr.resolve('grok')).version, NEW);

    const back = await mgr.rollback('grok');
    assert.strictEqual(back.ok, true);
    assert.strictEqual(back.version, GROK_V2);
    assert.strictEqual((await mgr.resolve('grok')).version, GROK_V2);
  } finally { await reg.close(); }
});

aok('auto-update preference persists to state.json', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    assert.strictEqual((await mgr.loadState()).autoUpdate, true, 'defaults to on');
    await mgr.setAutoUpdate(false);
    const reopened = createRuntimes(reg.opts({ userDir: mgr._paths.root.replace(/\/runtimes$/, '') }));
    assert.strictEqual((await reopened.loadState()).autoUpdate, false);
    assert.ok(fs.existsSync(path.join(mgr._paths.root, 'state.json')));
    const row = await mgr.status('grok');
    assert.strictEqual(row.autoUpdate, false);
  } finally { await reg.close(); }
});

aok('an unreachable registry degrades to an error string, never a throw', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts({ npm: 'http://127.0.0.1:1', grokPointers: ['http://127.0.0.1:1/cli/stable'] }));
    const row = await mgr.status('claude-code');
    assert.ok(row.error, 'status must carry the failure');
    assert.strictEqual(row.latest, '');
    const list = await mgr.list();
    assert.strictEqual(list.length, 4);
    for (const r of list) assert.ok(r.id && r.label, 'list rows stay well-formed');
  } finally { await reg.close(); }
});

aok('install(gemini-cli) stages bundle/gemini.js and links bin/gemini', async () => {
  const reg = await startRegistry();
  try {
    const mgr = createRuntimes(reg.opts());
    const res = await mgr.install('gemini-cli');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.version, GEMINI_V2);
    assert.strictEqual(res.integrity, true);
    const r = await mgr.resolve('gemini-cli');
    assert.strictEqual(r.source, 'installed');
    assert.match(execFileSync(r.bin, ['--version']).toString(), new RegExp(GEMINI_V2));
  } finally { await reg.close(); }
});

aok('hydrateBundled() seeds userData cleanly without touching bundle and supports Rollback after update', async () => {
  const reg = await startRegistry();
  try {
    const bundled = path.join(TMP, 'bundled-hydrate');
    const claudeBundleBin = path.join(bundled, 'claude-code', 'bin', 'claude');
    fs.mkdirSync(path.dirname(claudeBundleBin), { recursive: true });
    fs.writeFileSync(claudeBundleBin, sh('echo "2.0.0 (Claude Code)"'), { mode: 0o644 });
    fs.writeFileSync(path.join(bundled, 'claude-code', 'VERSION'), '2.0.0\n');
    const bundledMtimeBefore = fs.statSync(claudeBundleBin).mode;

    const mgr = createRuntimes(reg.opts({ bundledDir: bundled }));
    const hyd = await mgr.hydrateBundled();
    assert.strictEqual(hyd.hydrated.some((x) => x.id === 'claude-code' && x.version === '2.0.0'), true);
    // Bundle source permissions untouched (no chmod inside Resources)
    assert.strictEqual(fs.statSync(claudeBundleBin).mode, bundledMtimeBefore);

    // Resolved copy is now in writable userData (`installed`), runnable cleanly
    const beforeUpd = await mgr.resolve('claude-code');
    assert.strictEqual(beforeUpd.source, 'installed');
    assert.strictEqual(beforeUpd.version, '2.0.0');

    // Update from upstream -> keeps 2.0.0 for Rollback
    await mgr.install('claude-code');
    const stUp = await mgr.status('claude-code');
    assert.strictEqual(stUp.version, CLAUDE_V2);
    assert.strictEqual(stUp.hasRollback, true);

    const rolled = await mgr.rollback('claude-code');
    assert.strictEqual(rolled.ok, true);
    assert.strictEqual(rolled.version, '2.0.0');
  } finally { await reg.close(); }
});

aok('a non-allowlisted host is refused by the manager itself', async () => {
  const mgr = createRuntimes({
    userDir: path.join(TMP, 'guard'),
    npm: 'https://registry.npmjs.org.evil.example',
  });
  const row = await mgr.status('claude-code');
  assert.match(row.error, /not allowlisted/);
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

(async () => {
  for (const t of pending) await t();
  console.log('\n' + pass + ' assertions groups passed' + (process.exitCode ? ' (with failures)' : ''));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
})();
