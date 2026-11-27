#!/usr/bin/env node
'use strict';
// Post-dist macOS packaging helper:
// Ensures both AkronCode-<ver>-arm64.zip AND AkronCode-<ver>-arm64.dmg ship
// a top-level "Akron Browser Bot" standalone extension folder alongside
// "Akron Code.app", without altering the .app bundle's code signatures.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const installer = require('../electron/browser-ext-installer');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const RELEASE_DIR = path.join(ROOT, 'release');
const VER = pkg.version || '1.5.0';

function sha512Base64(filePath) {
  const hash = crypto.createHash('sha512');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('base64');
}

function run(cmd, args = [], opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('[inject-mac-ext-folder] Non-darwin host — skipping.');
    return;
  }

  let arch = 'arm64';
  let macApp = path.join(RELEASE_DIR, 'mac-arm64', 'Akron Code.app');
  if (!fs.existsSync(macApp)) {
    macApp = path.join(RELEASE_DIR, 'mac', 'Akron Code.app');
    arch = 'x64';
  }
  if (!fs.existsSync(macApp)) {
    throw new Error(`Missing built macOS app in ${RELEASE_DIR}/mac-arm64 or ${RELEASE_DIR}/mac`);
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-mac-stage-'));
  const tmpKey = path.join(os.tmpdir(), `akron-stage-ext-key-${process.pid}.pem`);
  try {
    const stagedApp = path.join(stageDir, 'Akron Code.app');
    const stagedExt = path.join(stageDir, 'Akron Browser Bot');
    run('ditto', [macApp, stagedApp]);

    const synced = installer.syncStandaloneExtension({
      sourceDir: path.join(ROOT, 'resources', 'akron-browser-bot'),
      targetDir: stagedExt,
      keyPath: tmpKey,
      force: true,
    });
    if (!synced.ok) throw new Error(`syncStandaloneExtension failed: ${synced.error}`);

    // Verify codesign on staged app before repacking
    try {
      run('codesign', ['--verify', '--deep', '--strict', stagedApp]);
    } catch (err) {
      console.warn('[inject-mac-ext-folder] codesign note:', err.message);
    }

    // 1. Rebuild release ZIP with top-level "Akron Code.app" + "Akron Browser Bot/"
    const zipName = `AkronCode-${VER}-${arch}.zip`;
    const zipOut = path.join(RELEASE_DIR, zipName);
    if (fs.existsSync(zipOut)) fs.unlinkSync(zipOut);
    run('ditto', ['-c', '-k', '--sequesterRsrc', stageDir, zipOut]);
    console.log(`[inject-mac-ext-folder] Updated ${zipOut} with Akron Code.app + Akron Browser Bot/`);

    // 2. Rebuild release DMG with Applications symlink + top-level "Akron Browser Bot/"
    const dmgName = `AkronCode-${VER}-${arch}.dmg`;
    const dmgOut = path.join(RELEASE_DIR, dmgName);
    const dmgTmp = path.join(RELEASE_DIR, `AkronCode-${VER}-${arch}.tmp.dmg`);
    if (fs.existsSync(dmgTmp)) fs.unlinkSync(dmgTmp);
    fs.symlinkSync('/Applications', path.join(stageDir, 'Applications'));
    run('hdiutil', [
      'create',
      '-volname', `Akron Code ${VER}`,
      '-srcfolder', stageDir,
      '-ov',
      '-format', 'UDZO',
      dmgTmp,
    ]);
    if (fs.existsSync(dmgOut)) fs.unlinkSync(dmgOut);
    fs.renameSync(dmgTmp, dmgOut);
    console.log(`[inject-mac-ext-folder] Updated ${dmgOut} with Akron Code.app + Applications + Akron Browser Bot/`);

    // 3. Emit latest-mac.yml for zero-rate-limit updater fallback
    const zipStat = fs.statSync(zipOut);
    const dmgStat = fs.statSync(dmgOut);
    const latestMacYml = [
      `version: ${VER}`,
      'files:',
      `  - url: ${zipName}`,
      `    sha512: ${sha512Base64(zipOut)}`,
      `    size: ${zipStat.size}`,
      `  - url: ${dmgName}`,
      `    sha512: ${sha512Base64(dmgOut)}`,
      `    size: ${dmgStat.size}`,
      `path: ${zipName}`,
      `sha512: ${sha512Base64(zipOut)}`,
      `releaseDate: '${new Date().toISOString()}'`,
      '',
    ].join('\n');
    fs.writeFileSync(path.join(RELEASE_DIR, 'latest-mac.yml'), latestMacYml, 'utf8');
    console.log('[inject-mac-ext-folder] Wrote release/latest-mac.yml');

    // Verify ZIP entries list both top-level items cleanly
    const entries = execSync(`unzip -Z -1 "${zipOut}" | cut -d/ -f1 | sort -u`, { encoding: 'utf8' });
    console.log('[inject-mac-ext-folder] ZIP top-level entries:\n' + entries.trim());
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.rmSync(tmpKey, { force: true });
  }
}

main();
