'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const brandGuard = require('../electron/brand-guard');

// 1. Real repository brand seal must verify cleanly
const realRes = brandGuard.verifyBrandIntegrity({ appRoot: ROOT });
assert(realRes.ok, 'Real brand seal failed: ' + JSON.stringify(realRes.problems));
assert(realRes.checkedFiles >= 12, 'Expected at least 12 sealed files checked, got ' + realRes.checkedFiles);
console.log(`✓ Real brand seal verified (${realRes.checkedFiles} assets)`);

// 2. License, Trademarks, and Fuse hardening files present
const lic = fs.readFileSync(path.join(ROOT, 'LICENSE.md'), 'utf8');
const tm = fs.readFileSync(path.join(ROOT, 'TRADEMARKS.md'), 'utf8');
assert(lic.includes('Skills') && lic.includes('MCP') && lic.includes('white-label'), 'LICENSE.md incomplete');
assert(tm.includes('Akron Code') && tm.includes('Akron Browser Bot'), 'TRADEMARKS.md incomplete');
assert(fs.existsSync(path.join(ROOT, 'scripts', 'harden-fuses.js')), 'harden-fuses.js missing');
console.log('✓ LICENSE.md, TRADEMARKS.md, and harden-fuses.js verified');

// 3. Browser Bot sealed script check
const extSealPath = path.join(ROOT, 'resources', 'akron-browser-bot', 'shared', 'brand-seal.js');
if (fs.existsSync(extSealPath)) {
  const rawExt = fs.readFileSync(extSealPath, 'utf8');
  assert(rawExt.includes('Akron') || rawExt.length > 50, 'Browser Bot brand-seal.js invalid');
  console.log('✓ Browser Bot brand-seal.js intact');
}

// 4. Tamper detection tests in isolated temp copy (never modifying repo assets)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-brand-tamper-'));
try {
  fs.mkdirSync(path.join(tmp, 'build'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'electron'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'resources', 'akron-browser-bot', 'icons'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'resources', 'akron-browser-bot', '_locales', 'en'), { recursive: true });

  for (const rel of [
    'package.json',
    'LICENSE.md',
    'TRADEMARKS.md',
    'electron/brand-seal.json',
    'electron/trayTemplate.png',
    'electron/trayTemplate@2x.png',
    'build/icon.svg',
    'build/logo-mark.svg',
    'build/icon.png',
    'build/icon.icns',
    'build/icon.ico',
    'resources/akron-browser-bot/icons/icon16.png',
    'resources/akron-browser-bot/icons/icon32.png',
    'resources/akron-browser-bot/icons/icon48.png',
    'resources/akron-browser-bot/icons/icon128.png',
    'resources/akron-browser-bot/icons/logo.svg',
    'resources/akron-browser-bot/_locales/en/messages.json',
  ]) {
    const src = path.join(ROOT, rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(tmp, rel));
  }

  assert(brandGuard.verifyBrandIntegrity({ appRoot: tmp }).ok, 'Temp copy should pass before tamper');

  // Tamper icon byte
  const logoPath = path.join(tmp, 'build', 'logo-mark.svg');
  const origSvg = fs.readFileSync(logoPath, 'utf8');
  fs.writeFileSync(logoPath, origSvg + ' ', 'utf8');
  const t1 = brandGuard.verifyBrandIntegrity({ appRoot: tmp });
  assert(!t1.ok && t1.problems.some((p) => p.includes('logo-mark.svg')), 'Should detect tampered logo-mark.svg');
  fs.writeFileSync(logoPath, origSvg, 'utf8');

  // Tamper productName
  const pkgPath = path.join(tmp, 'package.json');
  const pkgObj = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkgObj.productName = 'Cloned Code';
  fs.writeFileSync(pkgPath, JSON.stringify(pkgObj, null, 2), 'utf8');
  const t2 = brandGuard.verifyBrandIntegrity({ appRoot: tmp });
  assert(!t2.ok && t2.problems.some((p) => p.includes('productName')), 'Should detect tampered productName');
  console.log('✓ Tamper detection catches logo/brand modifications');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 5. No source maps in dist/ and no ELECTRON_RUN_AS_NODE left in pty.js or tools.js
const distDir = path.join(ROOT, 'dist');
if (fs.existsSync(distDir)) {
  const walkMaps = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walkMaps(p);
      else assert(!ent.name.endsWith('.map'), 'Unexpected source map in dist/: ' + p);
    }
  };
  walkMaps(distDir);
  console.log('✓ Zero .map files in dist/');
}

const ptySrc = fs.readFileSync(path.join(ROOT, 'electron', 'ide', 'pty.js'), 'utf8');
const toolsSrc = fs.readFileSync(path.join(ROOT, 'electron', 'tools.js'), 'utf8');
assert(!ptySrc.includes('ELECTRON_RUN_AS_NODE'), 'pty.js must not rely on ELECTRON_RUN_AS_NODE');
assert(!toolsSrc.includes('ELECTRON_RUN_AS_NODE'), 'tools.js must not rely on ELECTRON_RUN_AS_NODE');
console.log('✓ RunAsNode=false fuse compatibility verified');

console.log('\nBRAND_INTEGRITY_ALL_PASS');
