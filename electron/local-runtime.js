'use strict';
/**
 * Cross-Platform FreeLLMAPI Desktop Detector, Compatibility Bootstrapper & Key Portability.
 * Works cleanly on macOS, Windows, and Linux without OS-specific crashes or hardcoded user paths.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const freellm = require('./freellm');
const catalogMod = require('./freellmapi-catalog');

function firstExisting(pathsList) {
  for (const p of pathsList) {
    if (!p) continue;
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return '';
}

function detectFreeLLMAPIRuntime({
  platform = process.platform,
  homedir = os.homedir(),
  env = process.env,
} = {}) {
  const downloadsDir = path.join(homedir, 'Downloads');
  let appCandidates = [];
  let dbCandidates = [];
  let installerCandidates = [];
  let installCommandHint = '';

  if (platform === 'darwin') {
    appCandidates = [
      '/Applications/FreeLLMAPI.app',
      path.join(homedir, 'Applications', 'FreeLLMAPI.app'),
    ];
    dbCandidates = [
      path.join(homedir, 'Library', 'Application Support', 'FreeLLMAPI', 'freeapi.db'),
    ];
    installerCandidates = [
      path.join(downloadsDir, 'FreeLLMAPI.dmg'),
      path.join(downloadsDir, 'FreeLLMAPI-mac.dmg'),
      path.join(downloadsDir, 'FreeLLMAPI-arm64.dmg'),
    ];
    installCommandHint = 'Open FreeLLMAPI.app or use Akron Code’s built-in 1,575-model router (:3001 / :31415)';
  } else if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(homedir, 'AppData', 'Local');
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    appCandidates = [
      path.join(localAppData, 'Programs', 'FreeLLMAPI', 'FreeLLMAPI.exe'),
      path.join(programFiles, 'FreeLLMAPI', 'FreeLLMAPI.exe'),
    ];
    dbCandidates = [
      path.join(appData, 'FreeLLMAPI', 'freeapi.db'),
    ];
    installerCandidates = [
      path.join(downloadsDir, 'FreeLLMAPI Installer.exe'),
      path.join(downloadsDir, 'FreeLLMAPI-Setup.exe'),
      path.join(localAppData, 'Temp', 'FreeLLMAPI Installer.exe'),
    ];
    installCommandHint = 'Run FreeLLMAPI Installer.exe or use Akron Code’s built-in 1,575-model router (:3001 / :31415)';
  } else {
    const xdgData = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
    appCandidates = [
      path.join(homedir, '.local', 'bin', 'freellmapi'),
      '/opt/FreeLLMAPI/freellmapi',
      '/usr/local/bin/freellmapi',
    ];
    dbCandidates = [
      path.join(xdgData, 'FreeLLMAPI', 'freeapi.db'),
    ];
    installerCandidates = [
      path.join(downloadsDir, 'FreeLLMAPI.AppImage'),
      path.join(downloadsDir, 'freellmapi.deb'),
    ];
    installCommandHint = 'Run ~/.local/bin/freellmapi or use Akron Code’s built-in 1,575-model router (:3001 / :31415)';
  }

  const appPath = firstExisting(appCandidates);
  const dbPath = firstExisting(dbCandidates);
  const installerPath = firstExisting(installerCandidates);

  return {
    platform,
    desktopInstalled: Boolean(appPath),
    appPath,
    dbDetected: Boolean(dbPath),
    dbPath,
    installerAvailable: Boolean(installerPath),
    installerPath,
    builtinRouterPorts: [3001, 31415],
    recommendedEndpoint: 'http://127.0.0.1:31415/v1',
    builtinEndpoint: 'http://127.0.0.1:3001/v1',
    installCommandHint,
    downloadPageUrl: 'https://github.com/faysaliteng/FreeLLMAPI/releases/latest',
  };
}

function ensureUnifiedToken(cfg) {
  if (cfg && cfg.token && String(cfg.token).trim()) return String(cfg.token).trim();
  return 'flm_akron_' + crypto.randomBytes(16).toString('hex');
}

function importFreeLLMKeys(input, opts = {}) {
  const configPath = opts.configPath || freellm.CONFIG_FILE;
  let parsed = input;
  if (typeof input === 'string') {
    const raw = input.trim();
    if (!raw) throw new Error('Empty key configuration input');
    // If string points to an existing JSON file, read it
    if (!raw.startsWith('{') && !raw.startsWith('[') && fs.existsSync(raw)) {
      parsed = JSON.parse(fs.readFileSync(raw, 'utf8'));
    } else {
      parsed = JSON.parse(raw);
    }
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid JSON key payload');

  const cur = freellm.normalizeConfig(freellm.loadConfig(configPath));
  const nextProviders = { ...cur.providers };
  const catalog = catalogMod.loadCatalog();
  const imported = [];

  const setProviderKey = (pid, apiKey, extra = {}) => {
    const id = String(pid || '').trim().toLowerCase();
    const key = String(apiKey || '').trim();
    if (!id || !key) return;
    const platMeta = (catalog.platforms && catalog.platforms[id]) || {};
    const prev = nextProviders[id] || {};
    nextProviders[id] = {
      enabled: extra.enabled !== false,
      apiKey: key,
      accountId: String(extra.accountId || prev.accountId || ''),
      baseURL: String(extra.baseURL || prev.baseURL || platMeta.baseUrl || ''),
      defaultModel: String(extra.defaultModel || prev.defaultModel || ''),
    };
    imported.push(id);
  };

  // Format 1: { providers: { groq: { apiKey, ... }, ... }, token? }
  if (parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
    for (const [id, val] of Object.entries(parsed.providers)) {
      if (typeof val === 'string') setProviderKey(id, val);
      else if (val && typeof val === 'object') setProviderKey(id, val.apiKey || val.key || val.token, val);
    }
  }

  // Format 2: { keys: [ { platform, key | apiKey | api_key, label?, enabled? } ] } or Array
  const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.keys) ? parsed.keys : []);
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    setProviderKey(row.platform || row.provider || row.id, row.apiKey || row.api_key || row.key || row.token, row);
  }

  // Format 3: Flat map { groq: "gsk_...", openrouter: "sk-or-...", FREELM_MISTRAL_KEY: "..." }
  for (const [k, v] of Object.entries(parsed)) {
    if (k === 'providers' || k === 'keys' || k === 'token' || k === 'unifiedKey' || k === 'port' || k === 'host' || k === 'order') continue;
    if (typeof v !== 'string' || !v.trim()) continue;
    const m = /^FREELM_([A-Z0-9_]+)_KEY$/i.exec(k);
    if (m) {
      setProviderKey(m[1], v);
    } else if (/^([a-z0-9_-]+)$/i.test(k) && (catalog.platforms[k.toLowerCase()] || freellm.PROVIDERS[k.toLowerCase()])) {
      setProviderKey(k, v);
    }
  }

  const unifiedToken = String(parsed.token || parsed.unifiedKey || cur.token || ensureUnifiedToken(cur)).trim();
  const nextCfg = freellm.normalizeConfig({
    ...cur,
    token: unifiedToken,
    providers: nextProviders,
  });
  const savedFile = freellm.saveConfig(nextCfg, configPath);
  return {
    ok: true,
    importedCount: [...new Set(imported)].length,
    importedPlatforms: [...new Set(imported)],
    unifiedKey: nextCfg.token,
    configFile: savedFile,
    endpoint: 'http://127.0.0.1:31415/v1',
    builtinEndpoint: `http://127.0.0.1:${nextCfg.port || 3001}/v1`,
  };
}

function exportFreeLLMKeys(opts = {}) {
  const configPath = opts.configPath || freellm.CONFIG_FILE;
  const cur = freellm.normalizeConfig(freellm.loadConfig(configPath));
  const token = cur.token || ensureUnifiedToken(cur);
  const providersOut = {};
  for (const [id, p] of Object.entries(cur.providers || {})) {
    if (p && p.apiKey) {
      providersOut[id] = {
        enabled: p.enabled !== false,
        apiKey: p.apiKey,
        ...(p.accountId ? { accountId: p.accountId } : {}),
        ...(p.baseURL ? { baseURL: p.baseURL } : {}),
        ...(p.defaultModel ? { defaultModel: p.defaultModel } : {}),
      };
    }
  }
  return {
    ok: true,
    payload: {
      format: 'freellmapi-keys-v1',
      endpoint: 'http://127.0.0.1:31415/v1',
      token,
      providers: providersOut,
      exportedAt: new Date().toISOString(),
    },
  };
}

function launchOrInstallFreeLLMAPI({ shellOpenExternal, shellOpenPath } = {}) {
  const info = detectFreeLLMAPIRuntime();
  try {
    if (info.desktopInstalled && info.appPath) {
      if (process.platform === 'darwin') {
        const child = spawn('open', ['-a', info.appPath], { detached: true, stdio: 'ignore' });
        child.unref();
        return { ok: true, action: 'launched', path: info.appPath };
      }
      if (typeof shellOpenPath === 'function') {
        shellOpenPath(info.appPath);
        return { ok: true, action: 'launched', path: info.appPath };
      }
      const child = spawn(info.appPath, [], { detached: true, stdio: 'ignore' });
      child.unref();
      return { ok: true, action: 'launched', path: info.appPath };
    }
    if (info.installerAvailable && info.installerPath) {
      if (typeof shellOpenPath === 'function') {
        shellOpenPath(info.installerPath);
        return { ok: true, action: 'installer_opened', path: info.installerPath };
      }
    }
    if (typeof shellOpenExternal === 'function') {
      shellOpenExternal(info.downloadPageUrl);
      return { ok: true, action: 'download_page_opened', url: info.downloadPageUrl };
    }
    return { ok: false, error: 'FreeLLMAPI app or installer not found locally.', info };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), info };
  }
}

module.exports = {
  detectFreeLLMAPIRuntime,
  ensureUnifiedToken,
  importFreeLLMKeys,
  exportFreeLLMKeys,
  launchOrInstallFreeLLMAPI,
};
