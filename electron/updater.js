'use strict';
/**
 * Akron Code GitHub Releases Auto-Updater.
 * Checks GitHub Releases API (or custom feedUrl), compares semver, selects the matching
 * platform/arch installer, streams download with progress, and verifies SHA-256 against
 * SHA256SUMS.txt before staging or launching installation.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_REPO = 'faysaliteng/akron-code';
const DEFAULT_FEED_URL = `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`;

function parseSemver(v) {
  const clean = String(v || '').trim().replace(/^v/i, '').split('-')[0];
  const parts = clean.split('.').map((n) => parseInt(n, 10));
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

function selectAssetForPlatform(assets = [], platform = process.platform, arch = process.arch) {
  const list = Array.isArray(assets) ? assets : [];
  const names = list.map((a) => ({ raw: a, name: String((a && a.name) || '').toLowerCase() }));
  const findBy = (pred) => (names.find(pred) || {}).raw || null;

  let installer = null;
  if (platform === 'darwin') {
    installer = findBy((x) => x.name.endsWith('.dmg') && x.name.includes(arch))
      || findBy((x) => x.name.endsWith('.dmg'))
      || findBy((x) => x.name.endsWith('.zip') && x.name.includes(arch));
  } else if (platform === 'win32') {
    installer = findBy((x) => x.name.endsWith('.exe') && x.name.includes('setup') && x.name.includes(arch))
      || findBy((x) => x.name.endsWith('.exe') && x.name.includes(arch) && !x.name.includes('portable'))
      || findBy((x) => x.name.endsWith('.exe') && x.name.includes('setup'))
      || findBy((x) => x.name.endsWith('.exe'));
  } else {
    installer = findBy((x) => x.name.endsWith('.appimage') && (arch === 'arm64' ? x.name.includes('arm64') : !x.name.includes('arm64')))
      || findBy((x) => x.name.endsWith('.appimage'));
  }
  const sumsAsset = findBy((x) => x.name === 'sha256sums.txt' || x.name.includes('sha256'));
  return { installer, sumsAsset };
}

function parseSha256Sums(text) {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*([a-fA-F0-9]{64})\s+\*?(.+?)\s*$/.exec(line);
    if (m) {
      const hash = m[1].toLowerCase();
      const base = path.basename(m[2].trim());
      map.set(base, hash);
      map.set(m[2].trim(), hash);
    }
  }
  return map;
}

async function checkForUpdates({
  currentVersion = '1.0.0',
  platform = process.platform,
  arch = process.arch,
  feedUrl = DEFAULT_FEED_URL,
  headers = {},
} = {}) {
  try {
    const res = await fetch(feedUrl, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'Akron-Code-Updater/1.0',
        ...headers,
      },
    });
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        currentVersion,
        updateAvailable: false,
        error: res.status === 404 ? 'No published GitHub Releases yet.' : `GitHub Releases returned HTTP ${res.status}`,
      };
    }
    const rel = await res.json();
    const latestVersion = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    const updateAvailable = !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;
    const { installer, sumsAsset } = selectAssetForPlatform(rel.assets || [], platform, arch);
    return {
      ok: true,
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      updateAvailable,
      releaseNotes: String(rel.body || '').slice(0, 4000),
      htmlUrl: rel.html_url || '',
      publishedAt: rel.published_at || '',
      asset: installer ? {
        name: installer.name,
        size: installer.size || 0,
        downloadUrl: installer.browser_download_url || installer.url || '',
      } : null,
      sumsUrl: sumsAsset ? (sumsAsset.browser_download_url || sumsAsset.url || '') : '',
    };
  } catch (e) {
    return {
      ok: false,
      currentVersion,
      updateAvailable: false,
      error: e && e.message ? e.message : String(e),
    };
  }
}

async function downloadAndVerifyUpdate({
  asset,
  sumsUrl = '',
  expectedSha256 = '',
  destDir = path.join(os.homedir(), '.autobot', 'updates'),
  headers = {},
  onProgress,
} = {}) {
  if (!asset || !asset.downloadUrl || !asset.name) {
    return { ok: false, error: 'Missing release asset download URL' };
  }
  await fsp.mkdir(destDir, { recursive: true });
  const safeName = path.basename(asset.name);
  const finalPath = path.join(destDir, safeName);
  const partPath = finalPath + '.part';

  let wantSha = String(expectedSha256 || '').trim().toLowerCase();
  if (!wantSha && sumsUrl) {
    try {
      const sr = await fetch(sumsUrl, { headers: { 'User-Agent': 'Akron-Code-Updater/1.0', ...headers } });
      if (sr.ok) {
        const sumsMap = parseSha256Sums(await sr.text());
        wantSha = sumsMap.get(safeName) || '';
      }
    } catch (_) {}
  }

  try {
    const res = await fetch(asset.downloadUrl, {
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Akron-Code-Updater/1.0', ...headers },
    });
    if (!res.ok || !res.body) {
      return { ok: false, error: `Download failed (HTTP ${res.status})` };
    }
    const total = Number(res.headers.get('content-length')) || Number(asset.size) || 0;
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(partPath);
    let received = 0;

    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        received += buf.length;
        hash.update(buf);
        if (!out.write(buf)) {
          await new Promise((r) => out.once('drain', r));
        }
        if (typeof onProgress === 'function') {
          onProgress({ received, total, percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0 });
        }
      }
    } finally {
      await new Promise((r) => out.end(r));
    }

    const actualSha = hash.digest('hex').toLowerCase();
    if (wantSha && actualSha !== wantSha) {
      try { fs.unlinkSync(partPath); } catch (_) {}
      return {
        ok: false,
        error: `SHA-256 verification failed for ${safeName} (expected ${wantSha.slice(0, 12)}…, got ${actualSha.slice(0, 12)}…)`,
        expectedSha256: wantSha,
        actualSha256: actualSha,
      };
    }

    await fsp.rename(partPath, finalPath);
    return {
      ok: true,
      path: finalPath,
      name: safeName,
      bytes: received,
      sha256: actualSha,
      verified: !!wantSha,
    };
  } catch (e) {
    try { fs.unlinkSync(partPath); } catch (_) {}
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function applyUpdate(stagedPath) {
  if (!stagedPath || !fs.existsSync(stagedPath)) {
    return { ok: false, error: 'Update file not found on disk' };
  }
  try {
    if (process.platform === 'darwin') {
      spawn('open', [stagedPath], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'win32') {
      spawn(stagedPath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    } else {
      fs.chmodSync(stagedPath, 0o755);
      spawn(stagedPath, [], { detached: true, stdio: 'ignore' }).unref();
    }
    return { ok: true, launched: stagedPath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

module.exports = {
  DEFAULT_FEED_URL,
  parseSemver,
  compareSemver,
  selectAssetForPlatform,
  parseSha256Sums,
  checkForUpdates,
  downloadAndVerifyUpdate,
  applyUpdate,
};
