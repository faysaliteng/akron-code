'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 1. Windows path / backslash / spaces / CRLF handling
const fsWatcher = require('../electron/ide/fs-watcher');
assert.strictEqual(fsWatcher.detectLanguage('C:\\Users\\dev\\My Project\\src\\app.tsx'), 'typescript');
assert.strictEqual(fsWatcher.detectLanguage('C:\\Program Files\\Akron\\config.yml'), 'yaml');
assert.strictEqual(fsWatcher.detectLanguage('C:\\work\\Dockerfile'), 'dockerfile');

const layoutStore = require('../electron/ide/layout-store');
assert.strictEqual(
  layoutStore.normalizeCwdKey('C:\\Users\\Dev\\My App\\'),
  layoutStore.normalizeCwdKey('c:\\users\\dev\\my app')
);
console.log('✓ Windows paths, spaces, drive letters, and case-insensitive workspace keys');

// 2. Zero .map files in dist/
const distDir = path.join(ROOT, 'dist');
assert(fs.existsSync(distDir), 'dist/ must exist');
const checkNoMaps = (dir) => {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) checkNoMaps(p);
    else assert(!ent.name.endsWith('.map'), 'Unexpected .map file: ' + p);
  }
};
checkNoMaps(distDir);
console.log('✓ Zero source maps in dist/');

// 3. Scan src/, electron/, scripts/, package.json for hardcoded user paths or leaked secrets
const SCAN_DIRS = ['src', 'electron', 'scripts'];
const SECRET_RES = [
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bghp_[A-Za-z0-9]{30,}/,
  /-----BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY-----/,
];
const badFindings = [];

const scanFile = (fp) => {
  if (!/\.(js|jsx|mjs|cjs|json|css|html|sh)$/i.test(fp)) return;
  const rel = path.relative(ROOT, fp);
  const txt = fs.readFileSync(fp, 'utf8');
  if (txt.includes('/Users/saimon')) {
    badFindings.push(`Hardcoded /Users/saimon in ${rel}`);
  }
  for (const re of SECRET_RES) {
    if (re.test(txt)) badFindings.push(`Potential secret pattern ${re} in ${rel}`);
  }
};

for (const d of SCAN_DIRS) {
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else scanFile(p);
    }
  };
  walk(path.join(ROOT, d));
}
scanFile(path.join(ROOT, 'package.json'));
assert.strictEqual(badFindings.length, 0, 'Audit violations:\n' + badFindings.join('\n'));
console.log('✓ Zero hardcoded /Users/saimon or leaked API keys in src/, electron/, scripts/, package.json');

// 4. Required Phase 5 hardening & docs present
for (const reqRel of [
  'LICENSE.md',
  'TRADEMARKS.md',
  'electron/brand-seal.json',
  'electron/brand-guard.js',
  'scripts/seal-brand.js',
  'scripts/harden-fuses.js',
  'package.json',
]) {
  assert(fs.existsSync(path.join(ROOT, reqRel)), `Missing required file: ${reqRel}`);
}
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.strictEqual(pkg.build.npmRebuild, false, 'npmRebuild must be false for cross-platform prebuild safety');
assert.strictEqual(pkg.build.afterPack, 'scripts/harden-fuses.js', 'afterPack must run harden-fuses.js');
console.log('✓ Hardening scripts, legal docs, and electron-builder config validated');

console.log('\nCROSS_PLATFORM_AUDIT_ALL_PASS');
