'use strict';
/**
 * Akron Code GitHub Releases & GitHub Workflow Auto-Updater.
 *
 * Resilient multi-strategy updater across macOS, Windows, and Linux:
 *   1. Primary: GitHub Releases JSON API (`/repos/faysaliteng/akron-code/releases/latest`).
 *   2. Zero-Rate-Limit Fallback: When GitHub API returns 403/429 or fails, resolves
 *      the latest tag via `https://github.com/faysaliteng/akron-code/releases/latest`
 *      redirect + `latest-mac.yml` / `latest.yml` / `latest-linux.yml` + `SHA256SUMS.txt`.
 *   3. Verifies SHA-256 checksums before staging or launching installers:
 *      - macOS: extracts `.zip` and swaps writable `/Applications/Akron Code.app` atomically
 *        (relaunching cleanly after app quit) or mounts `.dmg` via `open`.
 *      - Windows: launches NSIS setup `.exe` and schedules app quit to release file locks.
 *      - Linux: performs atomic `.bak`/`.new` `.AppImage` replacement or extracts `.tar.gz`.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_REPO = 'faysaliteng/akron-code';
const DEFAULT_FEED_URL = `https://api.github.com/repos/${DEFAULT_REPO}/releases/latest`;
const DEFAULT_WEB_BASE = `https://github.com/${DEFAULT_REPO}`;

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

function repoWebBaseFromFeed(feedUrl = DEFAULT_FEED_URL) {
  const m = /^https?:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)/i.exec(String(feedUrl || ''));
  return m ? `https://github.com/${m[1]}` : DEFAULT_WEB_BASE;
}

function ymlFilenameForPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'latest-mac.yml';
  if (platform === 'win32') return 'latest.yml';
  return 'latest-linux.yml';
}

function parseLatestYml(text) {
  const src = String(text || '');
  const verMatch = /^version:\s*['"]?([^\s'"]+)/m.exec(src);
  const pathMatch = /^path:\s*['"]?([^\r\n'"]+)/m.exec(src);
  const shaMatch = /^sha512:\s*['"]?([^\r\n'"]+)/m.exec(src);
  const dateMatch = /^releaseDate:\s*['"]?([^\r\n'"]+)/m.exec(src);
  const urls = [];
  for (const m of src.matchAll(/-\s*url:\s*['"]?([^\r\n'"]+)/g)) {
    urls.push(m[1].trim());
  }
  return {
    version: verMatch ? verMatch[1].replace(/^v/i, '') : '',
    path: pathMatch ? pathMatch[1].trim() : '',
    sha512: shaMatch ? shaMatch[1].trim() : '',
    releaseDate: dateMatch ? dateMatch[1].trim() : '',
    urls,
  };
}

function archMatchesAssetName(nameLower, platform, arch) {
  if (platform === 'linux') {
    if (arch === 'arm64') return nameLower.includes('arm64') || nameLower.includes('aarch64');
    return nameLower.includes('x86_64') || nameLower.includes('x64') || nameLower.includes('amd64');
  }
  if (arch === 'x64') {
    return nameLower.includes('x64') || (!nameLower.includes('arm64') && nameLower.includes('x86_64'));
  }
  return nameLower.includes(String(arch || '').toLowerCase());
}

function selectAssetForPlatform(assets = [], platform = process.platform, arch = process.arch, opts = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const names = list.map((a) => ({ raw: a, name: String((a && a.name) || '').toLowerCase() }));
  const findBy = (pred) => (names.find(pred) || {}).raw || null;

  let installer = null;
  if (platform === 'darwin') {
    const preferZip = opts.preferZip !== undefined ? !!opts.preferZip : false;
    if (preferZip) {
      installer = findBy((x) => x.name.endsWith('.zip') && archMatchesAssetName(x.name, platform, arch))
        || findBy((x) => x.name.endsWith('.zip'))
        || findBy((x) => x.name.endsWith('.dmg') && archMatchesAssetName(x.name, platform, arch))
        || findBy((x) => x.name.endsWith('.dmg'));
    } else {
      installer = findBy((x) => x.name.endsWith('.dmg') && archMatchesAssetName(x.name, platform, arch))
        || findBy((x) => x.name.endsWith('.dmg'))
        || findBy((x) => x.name.endsWith('.zip') && archMatchesAssetName(x.name, platform, arch))
        || findBy((x) => x.name.endsWith('.zip'));
    }
  } else if (platform === 'win32') {
    installer = findBy((x) => x.name.endsWith('.exe') && x.name.includes('setup') && archMatchesAssetName(x.name, platform, arch))
      || findBy((x) => x.name.endsWith('.exe') && archMatchesAssetName(x.name, platform, arch) && !x.name.includes('portable'))
      || findBy((x) => x.name.endsWith('.exe') && x.name.includes('setup'))
      || findBy((x) => x.name.endsWith('.exe'));
  } else {
    const hasAppImage = Boolean(opts.appImagePath || process.env.APPIMAGE);
    installer = (hasAppImage
      ? (findBy((x) => x.name.endsWith('.appimage') && archMatchesAssetName(x.name, platform, arch))
        || findBy((x) => x.name.endsWith('.appimage')))
      : null)
      || findBy((x) => x.name.endsWith('.appimage') && archMatchesAssetName(x.name, platform, arch))
      || findBy((x) => x.name.endsWith('.tar.gz') && archMatchesAssetName(x.name, platform, arch))
      || findBy((x) => x.name.endsWith('.appimage'))
      || findBy((x) => x.name.endsWith('.tar.gz'));
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

function buildFallbackReleaseAssets(version, webBase) {
  const v = String(version || '').replace(/^v/i, '');
  if (!v) return [];
  const dlBase = `${webBase}/releases/download/v${v}`;
  const fileNames = [
    `AkronCode-${v}-arm64.dmg`,
    `AkronCode-${v}-arm64.zip`,
    `AkronCode-${v}-x64.dmg`,
    `AkronCode-${v}-x64.zip`,
    `AkronCode-${v}-win-setup-x64.exe`,
    `AkronCode-${v}-win-setup-arm64.exe`,
    `AkronCode-${v}-win-portable-x64.exe`,
    `AkronCode-${v}-linux-x86_64.AppImage`,
    `AkronCode-${v}-linux-x64.tar.gz`,
    `AkronCode-${v}-linux-x86_64.tar.gz`,
    `AkronCode-${v}-linux-arm64.AppImage`,
    `AkronCode-${v}-linux-arm64.tar.gz`,
    'SHA256SUMS.txt',
  ];
  return fileNames.map((name) => ({
    name,
    size: 0,
    browser_download_url: `${dlBase}/${name}`,
  }));
}

async function checkViaWebFallback({
  currentVersion,
  platform,
  arch,
  channel,
  feedUrl,
  preferZip,
  headers = {},
  fetchImpl = global.fetch,
}) {
  const webBase = repoWebBaseFromFeed(feedUrl);
  const uaHdrs = { 'User-Agent': 'Akron-Code-Updater/1.5', ...headers };

  // 1. Resolve latest tag via HTML redirect (exempt from 60 req/hr REST API limit)
  let latestTag = '';
  try {
    const r = await fetchImpl(`${webBase}/releases/latest`, {
      method: 'HEAD',
      redirect: 'follow',
      headers: uaHdrs,
      signal: AbortSignal.timeout(10000),
    });
    const m = /\/releases\/tag\/(v?[\d.]+(?:-[\w.]+)?)/i.exec(String(r.url || ''));
    if (m) latestTag = m[1];
  } catch (_) {}

  // 2. Fetch latest-*.yml from `/releases/latest/download/`
  let ymlMeta = null;
  const ymlName = ymlFilenameForPlatform(platform);
  try {
    const yr = await fetchImpl(`${webBase}/releases/latest/download/${ymlName}`, {
      redirect: 'follow',
      headers: uaHdrs,
      signal: AbortSignal.timeout(10000),
    });
    if (yr.ok) ymlMeta = parseLatestYml(await yr.text());
  } catch (_) {}

  const latestVersion = String((ymlMeta && ymlMeta.version) || latestTag || '').replace(/^v/i, '');
  if (!latestVersion) return null;

  const syntheticAssets = buildFallbackReleaseAssets(latestVersion, webBase);
  if (ymlMeta) {
    const candidates = [ymlMeta.path, ...(ymlMeta.urls || [])].filter(Boolean);
    for (const cName of candidates) {
      const base = path.basename(cName);
      if (!syntheticAssets.some((a) => a.name === base)) {
        syntheticAssets.unshift({
          name: base,
          size: 0,
          browser_download_url: `${webBase}/releases/download/v${latestVersion}/${base}`,
        });
      }
    }
  }

  const wantZip = typeof preferZip === 'boolean'
    ? preferZip
    : (platform === 'darwin' && canWriteMacAppTarget('/Applications/Akron Code.app'));
  let { installer, sumsAsset } = selectAssetForPlatform(
    syntheticAssets,
    platform,
    arch,
    { preferZip: wantZip }
  );
  // Prefer existing asset by checking HEAD on the candidate URL
  if (installer) {
    try {
      const head = await fetchImpl(installer.browser_download_url, { method: 'HEAD', redirect: 'follow', headers: uaHdrs, signal: AbortSignal.timeout(8000) });
      if (!head.ok && platform === 'darwin') {
        const altExt = installer.name.endsWith('.zip') ? '.dmg' : '.zip';
        const alt = syntheticAssets.find((a) => a.name.endsWith(altExt) && archMatchesAssetName(a.name.toLowerCase(), platform, arch))
          || syntheticAssets.find((a) => a.name.endsWith(altExt));
        if (alt) installer = alt;
      }
    } catch (_) {}
  }

  const updateAvailable = compareSemver(latestVersion, currentVersion) > 0;
  return {
    ok: true,
    via: 'github-web-fallback',
    currentVersion,
    latestVersion,
    channel: String(channel || 'stable').toLowerCase() === 'prerelease' ? 'prerelease' : 'stable',
    prerelease: false,
    updateAvailable,
    releaseNotes: ymlMeta && ymlMeta.releaseDate ? `Published ${ymlMeta.releaseDate}` : '',
    htmlUrl: `${webBase}/releases/tag/v${latestVersion}`,
    publishedAt: (ymlMeta && ymlMeta.releaseDate) || '',
    asset: installer ? {
      name: installer.name,
      size: installer.size || 0,
      downloadUrl: installer.browser_download_url,
    } : null,
    sumsUrl: sumsAsset ? sumsAsset.browser_download_url : `${webBase}/releases/download/v${latestVersion}/SHA256SUMS.txt`,
  };
}

async function checkForUpdates({
  currentVersion = '1.0.0',
  platform = process.platform,
  arch = process.arch,
  channel = 'stable',
  feedUrl = DEFAULT_FEED_URL,
  preferZip,
  headers = {},
  fetchImpl = global.fetch,
} = {}) {
  try {
    const usePrerelease = String(channel || 'stable').toLowerCase() === 'prerelease';
    const targetUrl = usePrerelease
      ? feedUrl.replace(/\/releases\/latest\b/i, '/releases')
      : feedUrl;
    let res = null;
    try {
      res = await fetchImpl(targetUrl, {
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Akron-Code-Updater/1.5',
          ...headers,
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch (_) {
      res = null;
    }

    if (!res || !res.ok) {
      const fb = await checkViaWebFallback({ currentVersion, platform, arch, channel, feedUrl, preferZip, headers, fetchImpl });
      if (fb) return fb;
      const status = res ? res.status : 0;
      return {
        ok: false,
        status,
        currentVersion,
        channel: usePrerelease ? 'prerelease' : 'stable',
        updateAvailable: false,
        error: status === 404
          ? 'No published GitHub Releases yet.'
          : (status ? `GitHub Releases returned HTTP ${status}` : 'Unable to reach GitHub Releases'),
      };
    }

    const payload = await res.json();
    let rel = payload;
    if (Array.isArray(payload)) {
      const candidates = usePrerelease ? payload : payload.filter((r) => !r.prerelease);
      rel = candidates.find((r) => !r.draft) || candidates[0] || {};
    }
    const latestVersion = String(rel.tag_name || rel.name || '').replace(/^v/i, '');
    const updateAvailable = !!latestVersion && compareSemver(latestVersion, currentVersion) > 0;
    const wantZip = typeof preferZip === 'boolean'
      ? preferZip
      : (platform === 'darwin' && canWriteMacAppTarget('/Applications/Akron Code.app'));
    const { installer, sumsAsset } = selectAssetForPlatform(rel.assets || [], platform, arch, {
      preferZip: wantZip,
    });
    return {
      ok: true,
      via: 'github-api',
      currentVersion,
      latestVersion: latestVersion || currentVersion,
      channel: usePrerelease ? 'prerelease' : 'stable',
      prerelease: !!rel.prerelease,
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
  fetchImpl = global.fetch,
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
      const sr = await fetchImpl(sumsUrl, { headers: { 'User-Agent': 'Akron-Code-Updater/1.5', ...headers }, signal: AbortSignal.timeout(12000) });
      if (sr.ok) {
        const sumsMap = parseSha256Sums(await sr.text());
        wantSha = sumsMap.get(safeName) || '';
      }
    } catch (_) {}
  }

  try {
    const res = await fetchImpl(asset.downloadUrl, {
      redirect: 'follow',
      headers: { Accept: 'application/octet-stream', 'User-Agent': 'Akron-Code-Updater/1.5', ...headers },
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

function applyLinuxAppImageSwap(stagedPath, currentAppImagePath = process.env.APPIMAGE) {
  if (!stagedPath || !fs.existsSync(stagedPath)) {
    return { ok: false, error: 'Staged AppImage not found' };
  }
  fs.chmodSync(stagedPath, 0o755);
  if (currentAppImagePath && fs.existsSync(path.dirname(currentAppImagePath))) {
    const backup = currentAppImagePath + '.bak';
    try {
      if (fs.existsSync(currentAppImagePath)) {
        try { fs.unlinkSync(backup); } catch (_) {}
        fs.copyFileSync(currentAppImagePath, backup);
      }
      fs.copyFileSync(stagedPath, currentAppImagePath + '.new');
      fs.chmodSync(currentAppImagePath + '.new', 0o755);
      fs.renameSync(currentAppImagePath + '.new', currentAppImagePath);
      return { ok: true, swapped: true, target: currentAppImagePath, launched: currentAppImagePath };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }
  return { ok: true, swapped: false, launched: stagedPath };
}

function canWriteMacAppTarget(appPath) {
  try {
    if (!appPath || !appPath.endsWith('.app')) return false;
    fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
    if (fs.existsSync(appPath)) fs.accessSync(appPath, fs.constants.W_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function applyUpdate(stagedPath, opts = {}) {
  if (!stagedPath || !fs.existsSync(stagedPath)) {
    return { ok: false, error: 'Update file not found on disk' };
  }
  const platform = opts.platform || process.platform;
  const quitApp = typeof opts.quitApp === 'function' ? opts.quitApp : null;
  try {
    if (platform === 'darwin') {
      const targetApp = opts.appBundlePath && opts.appBundlePath.endsWith('.app')
        ? opts.appBundlePath
        : '/Applications/Akron Code.app';
      if (/\.zip$/i.test(stagedPath)) {
        if (canWriteMacAppTarget(targetApp)) {
          const tmpExtract = path.join(os.tmpdir(), `akron-upd-${Date.now()}`);
          const sh = [
            'set -e',
            'sleep 1',
            `rm -rf "${tmpExtract}" && mkdir -p "${tmpExtract}"`,
            `ditto -x -k "${stagedPath}" "${tmpExtract}"`,
            `APP_SRC=$(find "${tmpExtract}" -maxdepth 2 -name "Akron Code.app" -type d | head -n 1)`,
            'if [ -n "$APP_SRC" ]; then',
            `  rm -rf "${targetApp}.bak" || true`,
            `  if [ -d "${targetApp}" ]; then mv "${targetApp}" "${targetApp}.bak"; fi`,
            `  ditto "$APP_SRC" "${targetApp}"`,
            `  open -n "${targetApp}"`,
            `  rm -rf "${targetApp}.bak" || true`,
            'fi',
            `rm -rf "${tmpExtract}" || true`,
          ].join('\n');
          spawn('/bin/zsh', ['-c', sh], { detached: true, stdio: 'ignore' }).unref();
          if (quitApp) quitApp();
          return { ok: true, launched: targetApp, strategy: 'mac-zip-swap' };
        }
        // Reveal .zip in Finder rather than auto-unzipping beside updates/ (keeps single Spotlight app)
        spawn('open', ['-R', stagedPath], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, launched: stagedPath, strategy: 'mac-reveal' };
      }
      spawn('open', [stagedPath], { detached: true, stdio: 'ignore' }).unref();
      return { ok: true, launched: stagedPath, strategy: 'mac-open' };
    } else if (platform === 'win32') {
      spawn(stagedPath, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      if (quitApp) quitApp();
      return { ok: true, launched: stagedPath, strategy: 'win-nsis' };
    } else {
      if (/\.tar\.gz$/i.test(stagedPath)) {
        const unpackDir = path.join(path.dirname(stagedPath), 'unpacked');
        fs.mkdirSync(unpackDir, { recursive: true });
        spawn('tar', ['-xzf', stagedPath, '-C', unpackDir], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true, launched: unpackDir, strategy: 'linux-targz' };
      }
      const swapped = applyLinuxAppImageSwap(stagedPath, opts.appImagePath);
      if (swapped.swapped) {
        spawn(swapped.target, [], { detached: true, stdio: 'ignore' }).unref();
        if (quitApp) quitApp();
        return swapped;
      }
      fs.chmodSync(stagedPath, 0o755);
      spawn(stagedPath, [], { detached: true, stdio: 'ignore' }).unref();
      if (quitApp) quitApp();
    }
    return { ok: true, launched: stagedPath };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function createUpdateScheduler({
  intervalMs = 4 * 60 * 60 * 1000,
  checkFn = checkForUpdates,
  getOptions = () => ({}),
  onUpdateAvailable = () => {},
} = {}) {
  let timer = null;
  let lastResult = null;

  async function runOnce() {
    try {
      const res = await checkFn(getOptions());
      lastResult = res;
      if (res && res.ok && res.updateAvailable) {
        onUpdateAvailable(res);
      }
      return res;
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { runOnce(); }, Math.max(60000, Number(intervalMs) || 4 * 60 * 60 * 1000));
    if (timer.unref) timer.unref();
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    start,
    stop,
    runOnce,
    isRunning: () => !!timer,
    getLastResult: () => lastResult,
  };
}

module.exports = {
  DEFAULT_FEED_URL,
  DEFAULT_WEB_BASE,
  parseSemver,
  compareSemver,
  parseLatestYml,
  selectAssetForPlatform,
  parseSha256Sums,
  checkViaWebFallback,
  checkForUpdates,
  downloadAndVerifyUpdate,
  applyUpdate,
  applyLinuxAppImageSwap,
  createUpdateScheduler,
};
