'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const SEAL_PATH = path.join(ROOT, 'electron', 'brand-seal.json');

const SEALED_ASSETS = [
  { rel: 'build/icon.svg', runtime: 'asar' },
  { rel: 'build/logo-mark.svg', runtime: 'asar' },
  { rel: 'build/icon.png', runtime: 'asar' },
  { rel: 'build/icon.icns', runtime: 'repo-only' },
  { rel: 'build/icon.ico', runtime: 'repo-only' },
  { rel: 'electron/trayTemplate.png', runtime: 'asar' },
  { rel: 'electron/trayTemplate@2x.png', runtime: 'asar' },
  { rel: 'resources/akron-browser-bot/icons/icon16.png', runtime: 'both' },
  { rel: 'resources/akron-browser-bot/icons/icon32.png', runtime: 'both' },
  { rel: 'resources/akron-browser-bot/icons/icon48.png', runtime: 'both' },
  { rel: 'resources/akron-browser-bot/icons/icon128.png', runtime: 'both' },
  { rel: 'resources/akron-browser-bot/icons/logo.svg', runtime: 'both' },
];

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}

function buildSealPayload(rootDir = ROOT) {
  const identity = {
    productName: 'Akron Code',
    author: 'AkronLogic',
    attribution: 'by Akronlogic.com',
    extensionName: 'Akron Browser Bot',
    license: 'SEE LICENSE IN LICENSE.md',
  };

  const assets = {};
  for (const item of SEALED_ASSETS) {
    const abs = path.join(rootDir, item.rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Missing sealed brand asset: ${item.rel}`);
    }
    const { sha256, size } = sha256File(abs);
    assets[item.rel] = { sha256, size, runtime: item.runtime };
  }

  const canonical = JSON.stringify({ identity, assets });
  const sealDigest = crypto.createHash('sha256').update(canonical).digest('hex');

  return {
    version: 1,
    identity,
    assets,
    sealDigest,
    generatedAt: new Date().toISOString(),
  };
}

if (require.main === module) {
  const payload = buildSealPayload(ROOT);
  fs.writeFileSync(SEAL_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`Sealed ${Object.keys(payload.assets).length} brand assets -> ${path.relative(ROOT, SEAL_PATH)}`);
  console.log(`sealDigest: ${payload.sealDigest}`);
}

module.exports = { buildSealPayload, sha256File, SEALED_ASSETS };
