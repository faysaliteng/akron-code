'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function sha256File(absPath) {
  const buf = fs.readFileSync(absPath);
  return {
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    size: buf.length,
  };
}

function computeSealDigest(seal) {
  const canonical = JSON.stringify({
    identity: seal.identity,
    assets: seal.assets,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function verifyBrandIntegrity(opts = {}) {
  const appRoot = path.resolve(opts.appRoot || path.join(__dirname, '..'));
  const sealPath = path.join(appRoot, 'electron', 'brand-seal.json');
  const problems = [];
  let checkedFiles = 0;

  if (!fs.existsSync(sealPath)) {
    return { ok: false, problems: ['Missing electron/brand-seal.json'], sealDigest: null, checkedFiles: 0 };
  }

  let seal = null;
  try {
    seal = JSON.parse(fs.readFileSync(sealPath, 'utf8'));
  } catch (e) {
    return { ok: false, problems: ['Corrupt electron/brand-seal.json: ' + e.message], sealDigest: null, checkedFiles: 0 };
  }

  const expectedDigest = computeSealDigest(seal);
  if (seal.sealDigest !== expectedDigest) {
    problems.push(`brand-seal digest mismatch (expected ${expectedDigest}, got ${seal.sealDigest})`);
  }

  // Check package.json brand identity
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8'));
    if (pkg.productName !== seal.identity.productName) {
      problems.push(`package.json productName tampered: ${pkg.productName}`);
    }
    if (pkg.author !== seal.identity.author) {
      problems.push(`package.json author tampered: ${pkg.author}`);
    }
  } catch (e) {
    problems.push('Cannot verify package.json: ' + e.message);
  }

  // Check sealed assets
  const resBase = opts.resourcesPath || process.resourcesPath || '';
  for (const [rel, meta] of Object.entries(seal.assets || {})) {
    const asarPath = path.join(appRoot, rel);
    const candidates = [];

    if (meta.runtime === 'asar' || meta.runtime === 'both') {
      if (meta.runtime === 'asar' && !fs.existsSync(asarPath) && resBase) {
        const unpackedByRel = path.join(resBase, rel);
        const unpackedByBase = path.join(resBase, path.basename(rel));
        if (fs.existsSync(unpackedByRel)) candidates.push(unpackedByRel);
        else if (fs.existsSync(unpackedByBase)) candidates.push(unpackedByBase);
        else candidates.push(asarPath);
      } else {
        candidates.push(asarPath);
      }
    } else if (meta.runtime === 'repo-only') {
      // Packaged apps hold .icns/.ico natively outside ASAR, so only check when present in appRoot
      if (fs.existsSync(asarPath)) candidates.push(asarPath);
    }

    if (meta.runtime === 'both' && resBase && rel.startsWith('resources/')) {
      const extPath = path.join(resBase, rel.replace(/^resources\//, ''));
      if (fs.existsSync(extPath)) candidates.push(extPath);
    }

    if (candidates.length === 0 && meta.runtime !== 'repo-only') {
      problems.push(`Missing sealed asset: ${rel}`);
      continue;
    }

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        problems.push(`Missing sealed asset at ${candidate}`);
        continue;
      }
      const actual = sha256File(candidate);
      checkedFiles++;
      if (actual.sha256 !== meta.sha256 || actual.size !== meta.size) {
        problems.push(`Tampered brand asset: ${rel} (${candidate})`);
      }
    }
  }

  // Check Browser Bot extension name integrity (read-only)
  const extCandidates = [path.join(appRoot, 'resources', 'akron-browser-bot')];
  if (resBase) extCandidates.push(path.join(resBase, 'akron-browser-bot'));
  for (const extDir of extCandidates) {
    const locFile = path.join(extDir, '_locales', 'en', 'messages.json');
    if (fs.existsSync(locFile)) {
      try {
        const msgs = JSON.parse(fs.readFileSync(locFile, 'utf8'));
        const extName = (msgs && msgs.appName && msgs.appName.message) || (msgs && msgs.extName && msgs.extName.message);
        if (!extName || !/Akron\s+(Browser\s+)?Bot/i.test(extName)) {
          problems.push(`Browser Bot name tampered in ${locFile}: ${extName}`);
        }
      } catch (e) {
        problems.push(`Cannot parse ${locFile}: ${e.message}`);
      }
    }
  }

  // Check license & trademark docs inside ASAR / repo
  for (const docName of ['LICENSE.md', 'TRADEMARKS.md']) {
    const docPath = path.join(appRoot, docName);
    if (!fs.existsSync(docPath)) {
      problems.push(`Missing ${docName}`);
    } else {
      const raw = fs.readFileSync(docPath, 'utf8');
      if (!raw.includes('Akron Code') || !raw.includes('AkronLogic')) {
        problems.push(`${docName} missing required Akron Code / AkronLogic notices`);
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    sealDigest: expectedDigest,
    checkedFiles,
  };
}

function verifyRendererDomScript() {
  return `(() => {
    try {
      const title = document.title || '';
      const header = document.body ? document.body.innerText : '';
      const hasBrandText = /Akron Code/i.test(title) || /Akron Code/i.test(header);
      const hasAttr = /Akronlogic\\.com/i.test(header);
      const svgs = Array.from(document.querySelectorAll('svg'));
      const hasVisibleLogo = svgs.some((s) => {
        const st = window.getComputedStyle(s);
        const r = s.getBoundingClientRect();
        return st && st.display !== 'none' && st.visibility !== 'hidden' && r.width >= 10 && r.height >= 10;
      });
      return { ok: !!(hasBrandText && hasAttr && hasVisibleLogo), hasBrandText, hasAttr, hasVisibleLogo, title };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  })()`;
}

module.exports = {
  verifyBrandIntegrity,
  verifyRendererDomScript,
  computeSealDigest,
  sha256File,
};
