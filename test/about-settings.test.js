'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 1. Offline 3D logo asset is bundled and valid WebP
const logoPath = path.join(ROOT, 'src', 'assets', 'akron-mark-3d.webp');
assert(fs.existsSync(logoPath), 'Missing src/assets/akron-mark-3d.webp');
const logoBuf = fs.readFileSync(logoPath);
assert(logoBuf.length > 10000, 'akron-mark-3d.webp unexpectedly small: ' + logoBuf.length);
assert.strictEqual(logoBuf.slice(0, 4).toString('ascii'), 'RIFF', 'Expected RIFF header');
assert.strictEqual(logoBuf.slice(8, 12).toString('ascii'), 'WEBP', 'Expected WEBP header');
console.log(`✓ Bundled Akron Logic 3D logo verified (${logoBuf.length} bytes)`);

// 2. AboutSection component contains lockup SVG, diagnostics & legal viewer
const aboutSrc = fs.readFileSync(path.join(ROOT, 'src', 'components', 'AboutSection.jsx'), 'utf8');
assert(aboutSrc.includes("import akronMark3d from '../assets/akron-mark-3d.webp'"), 'Missing offline 3D mark import');
assert(aboutSrc.includes('GLOBAL TECH &amp; INFRASTRUCTURE'), 'Missing lockup tagline');
assert(aboutSrc.includes('AKRON<tspan fill="#0284c7">LOGIC</tspan>'), 'Missing AKRONLOGIC wordmark');
assert(aboutSrc.includes('License (LICENSE.md)') && aboutSrc.includes('Trademarks (TRADEMARKS.md)'), 'Missing legal tabs');
assert(aboutSrc.includes('getVersion') && aboutSrc.includes('brandStatus') && aboutSrc.includes('getLegalDocs'), 'Missing runtime/legal IPC calls');
console.log('✓ AboutSection.jsx structure verified');

// 3. SettingsModal wires the About & License tab
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
assert(appSrc.includes("import { AboutSection } from './components/AboutSection.jsx'"), 'App.jsx missing AboutSection import');
assert(appSrc.includes("{ id: 'about', group: 'system'"), 'SETTINGS_SECTIONS missing about entry');
assert(appSrc.includes("section === 'about'") && appSrc.includes('<AboutSection'), 'SettingsModal does not render AboutSection');
console.log('✓ App.jsx Settings wiring verified');

// 4. Electron main & preload expose autobot:getLegalDocs and autobot:openLegalDoc
const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
assert(mainSrc.includes("ipcMain.handle('autobot:getLegalDocs'"), 'main.js missing autobot:getLegalDocs handler');
assert(mainSrc.includes("ipcMain.handle('autobot:openLegalDoc'"), 'main.js missing autobot:openLegalDoc handler');
assert(preloadSrc.includes('getLegalDocs:') && preloadSrc.includes('openLegalDoc:'), 'preload.js missing legal doc bridges');
console.log('✓ Electron main/preload legal doc IPCs verified');

console.log('\nABOUT_SETTINGS_ALL_PASS');
