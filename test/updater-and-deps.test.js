'use strict';
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const updater = require('../electron/updater');
const depManager = require('../electron/dep-manager');

async function testDependencyHealth() {
  const st = depManager.getDependenciesStatus();
  assert(st.ok && Array.isArray(st.bundled) && st.bundled.length >= 6);
  const monaco = st.bundled.find((b) => b.id === 'monaco');
  const xterm = st.bundled.find((b) => b.id === 'xterm');
  const rg = st.bundled.find((b) => b.id === 'ripgrep');
  const ssh = st.bundled.find((b) => b.id === 'ssh2');
  assert(monaco && monaco.ok, 'monaco-editor must be resolvable');
  assert(xterm && xterm.ok, 'xterm + search/web-links/serialize addons must be resolvable');
  assert(rg && rg.ok, '@vscode/ripgrep binary must resolve');
  assert(ssh && ssh.ok, 'ssh2 must be resolvable');
  assert(Array.isArray(st.lspServers) && st.lspServers.length >= 3);
  console.log(`✓ 3.1 Built-in deps (${st.healthyCount}/${st.totalBundled} healthy) + LSP probe`);
}

async function testSemverAndAssetSelection() {
  assert.strictEqual(updater.compareSemver('1.1.0', '1.0.0'), 1);
  assert.strictEqual(updater.compareSemver('v1.0.0', '1.0.0'), 0);
  assert.strictEqual(updater.compareSemver('1.0.0', '1.0.1'), -1);

  const assets = [
    { name: 'AkronCode-1.1.0-arm64.dmg', size: 100, browser_download_url: 'https://example/mac.dmg' },
    { name: 'AkronCode-1.1.0-win-setup-x64.exe', size: 120, browser_download_url: 'https://example/win-x64.exe' },
    { name: 'AkronCode-1.1.0-win-setup-arm64.exe', size: 120, browser_download_url: 'https://example/win-arm64.exe' },
    { name: 'AkronCode-1.1.0-win-portable-x64.exe', size: 120, browser_download_url: 'https://example/win-portable.exe' },
    { name: 'SHA256SUMS.txt', size: 20, browser_download_url: 'https://example/SHA256SUMS.txt' },
  ];
  const macPick = updater.selectAssetForPlatform(assets, 'darwin', 'arm64');
  assert.strictEqual(macPick.installer.name, 'AkronCode-1.1.0-arm64.dmg');
  assert.strictEqual(macPick.sumsAsset.name, 'SHA256SUMS.txt');

  const winX64 = updater.selectAssetForPlatform(assets, 'win32', 'x64');
  assert.strictEqual(winX64.installer.name, 'AkronCode-1.1.0-win-setup-x64.exe');

  const winArm = updater.selectAssetForPlatform(assets, 'win32', 'arm64');
  assert.strictEqual(winArm.installer.name, 'AkronCode-1.1.0-win-setup-arm64.exe');
  console.log('✓ 3.2 Semver comparison & platform/arch asset matching');
}

async function testUpdaterDownloadAndChecksumVerification() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-upd-'));
  const goodPayload = Buffer.from('AKRON_MOCK_DMG_BINARY_PAYLOAD_V1.2.0');
  const goodHash = crypto.createHash('sha256').update(goodPayload).digest('hex');
  const badPayload = Buffer.from('TAMPERED_MALICIOUS_PAYLOAD');

  let serveTampered = false;
  let baseUrl = '';
  const srv = http.createServer((req, res) => {
    if (req.url === '/release') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        tag_name: 'v1.2.0',
        body: '## Highlights\n- Built-in Inspect Element Mode',
        html_url: 'https://github.com/faysaliteng/akron-code/releases/tag/v1.2.0',
        published_at: '2026-11-26T20:00:00Z',
        assets: [
          { name: 'AkronCode-1.2.0-arm64.dmg', size: goodPayload.length, browser_download_url: `${baseUrl}/asset.dmg` },
          { name: 'SHA256SUMS.txt', size: 90, browser_download_url: `${baseUrl}/SHA256SUMS.txt` },
        ],
      }));
      return;
    }
    if (req.url === '/SHA256SUMS.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${goodHash}  AkronCode-1.2.0-arm64.dmg\n`);
      return;
    }
    if (req.url === '/asset.dmg') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(serveTampered ? badPayload : goodPayload);
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    const chk = await updater.checkForUpdates({
      currentVersion: '1.0.0',
      platform: 'darwin',
      arch: 'arm64',
      feedUrl: `${baseUrl}/release`,
    });
    assert(chk.ok && chk.updateAvailable && chk.latestVersion === '1.2.0');
    assert.strictEqual(chk.asset.name, 'AkronCode-1.2.0-arm64.dmg');

    // 1. Valid checksum passes & writes final verified file
    const dlOk = await updater.downloadAndVerifyUpdate({
      asset: chk.asset,
      sumsUrl: chk.sumsUrl,
      destDir: tmpDir,
    });
    assert(dlOk.ok && dlOk.verified && dlOk.sha256 === goodHash);
    assert(fs.existsSync(dlOk.path));

    // 2. Tampered bytes fail closed & remove .part file
    serveTampered = true;
    const dlDirBad = path.join(tmpDir, 'bad');
    const dlBad = await updater.downloadAndVerifyUpdate({
      asset: chk.asset,
      sumsUrl: chk.sumsUrl,
      destDir: dlDirBad,
    });
    assert(!dlBad.ok && /SHA-256 verification failed/.test(dlBad.error));
    assert(!fs.existsSync(path.join(dlDirBad, 'AkronCode-1.2.0-arm64.dmg.part')));
    console.log('✓ 3.3 Auto-updater check + streaming SHA-256 pass & fail-closed tamper guard');
  } finally {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

(async () => {
  await testDependencyHealth();
  await testSemverAndAssetSelection();
  await testUpdaterDownloadAndChecksumVerification();
  console.log('UPDATER_AND_DEPS_ALL_PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
