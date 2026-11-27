'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const installer = require('../electron/browser-ext-installer');

test('resolveStandaloneExtensionDir maps clean OS-specific user paths outside .app', () => {
  const macDir = installer.resolveStandaloneExtensionDir({
    platform: 'darwin',
    homeDir: '/tmp/akron-home',
    ensureWritable: false,
  });
  assert.strictEqual(macDir, path.join('/tmp/akron-home', 'Applications', 'Akron Browser Bot'));

  const winDir = installer.resolveStandaloneExtensionDir({
    platform: 'win32',
    homeDir: '/tmp/akron-win-home',
    env: { LOCALAPPDATA: path.join('/tmp', 'win-local-appdata') },
    ensureWritable: false,
  });
  assert.strictEqual(winDir, path.join('/tmp', 'win-local-appdata', 'AkronLogic', 'Akron Browser Bot'));

  const linDir = installer.resolveStandaloneExtensionDir({
    platform: 'linux',
    homeDir: '/tmp/akron-linux-home',
    ensureWritable: false,
  });
  assert.strictEqual(linDir, path.join('/tmp/akron-linux-home', 'Akron Browser Bot'));
});

test('syncStandaloneExtension + buildCrx3Package produces verifiable CRX3 and deterministic extensionId', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ext-test-'));
  try {
    const extTarget = path.join(tmp, 'Akron Browser Bot');
    const keyPath = path.join(tmp, 'ext-key.pem');
    const r1 = installer.syncStandaloneExtension({
      targetDir: extTarget,
      keyPath,
      force: true,
    });
    assert.strictEqual(r1.ok, true);
    assert.match(r1.extensionId, /^[a-p]{32}$/, 'extensionId must be 32 chars [a-p]');
    assert.ok(fs.existsSync(r1.crxPath), 'CRX3 package must exist on disk');
    assert.ok(fs.existsSync(path.join(extTarget, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(extTarget, 'HOW_TO_INSTALL.txt')));

    const patchedManifest = JSON.parse(fs.readFileSync(path.join(extTarget, 'manifest.json'), 'utf8'));
    assert.ok(patchedManifest.key && patchedManifest.key.length > 50, 'standalone manifest must include public key');

    const verified = installer.verifyCrx3Package(r1.crxPath);
    assert.strictEqual(verified.ok, true);
    assert.strictEqual(verified.version, 3);
    assert.strictEqual(verified.extensionId, r1.extensionId);
    assert.ok(verified.entryCount >= 5);

    // Deterministic extensionId on re-sync with same key
    const r2 = installer.syncStandaloneExtension({
      targetDir: extTarget,
      keyPath,
    });
    assert.strictEqual(r2.extensionId, r1.extensionId);

    // Bundled source manifest must NOT be mutated
    const bundled = JSON.parse(fs.readFileSync(path.join(installer.getBundledSourceExtensionDir(), 'manifest.json'), 'utf8'));
    assert.strictEqual(bundled.key, undefined, 'bundled source manifest.json must remain unmutated');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('installExternalExtension writes External Extensions manifests without failing when browsers absent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ext-inst-'));
  try {
    const fakeHome = path.join(tmp, 'home');
    const chromeBase = path.join(fakeHome, 'Library', 'Application Support', 'Google', 'Chrome');
    fs.mkdirSync(chromeBase, { recursive: true });
    const res = installer.installExternalExtension({
      platform: 'darwin',
      homeDir: fakeHome,
      keyPath: path.join(tmp, 'key.pem'),
      allTargets: true,
    });
    assert.strictEqual(res.ok, true);
    assert.ok(res.registeredTargets.length >= 1);
    const chromeEntry = res.registeredTargets.find((t) => t.id === 'chrome');
    assert.ok(chromeEntry && fs.existsSync(chromeEntry.path));
    const json = JSON.parse(fs.readFileSync(chromeEntry.path, 'utf8'));
    assert.strictEqual(json.external_crx, res.crxPath);
    assert.strictEqual(json.external_version, res.version);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncStandaloneExtension preserves newer auto-updated version (never downgrades)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ext-nodowngrade-'));
  try {
    const extTarget = path.join(tmp, 'Akron Browser Bot');
    const keyPath = path.join(tmp, 'ext-key.pem');
    const r1 = installer.syncStandaloneExtension({ targetDir: extTarget, keyPath, force: true });
    assert.strictEqual(r1.ok, true);
    const mfPath = path.join(extTarget, 'manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    mf.version = '9.9.9';
    fs.writeFileSync(mfPath, JSON.stringify(mf, null, 2));

    const r2 = installer.syncStandaloneExtension({ targetDir: extTarget, keyPath });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.preservedNewer, true);
    assert.strictEqual(r2.version, '9.9.9');
    assert.strictEqual(r2.extensionId, r1.extensionId);
    const afterMf = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
    assert.strictEqual(afterMf.version, '9.9.9', 'newer auto-updated version must NOT be downgraded');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('brand integrity stays intact after extension packaging', () => {
  const r = require('../electron/brand-guard').verifyBrandIntegrity();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.checkedFiles, 12);
});
