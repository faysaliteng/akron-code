'use strict';
const path = require('path');
const fs = require('fs');

module.exports = function createRuntimesController(ctx) {
  const { app, ipcMain, store, workspace, shells, freellm, createRuntimes, providertransport, runAgent, hydrateProvider, hydrateOrchestrator, validateOrchestrator, freellmFallbackApiKey, oneLine, broadcast } = ctx;

// ---------------------------------------------------------------------------
// Bundled agent runtimes (Claude Code / Codex / Grok CLI) + self-update.
// ---------------------------------------------------------------------------
// Resolution is userData (self-updated) → Resources (shipped in the DMG) → PATH.
// Whatever wins is prepended to process.env.PATH so the Bash tool, git, and
// MCP servers all see the same binaries the Settings panel reports.
let runtimesHandle = null;

function bundledRuntimeDir() {
  const candidates = [];
  try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'runtimes')); } catch (_) {}
  // Dev runs: everything lives in the repo, not inside an .app bundle.
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'runtimes'));
  for (const dir of candidates) {
    try { if (fs.existsSync(dir)) return dir; } catch (_) {}
  }
  return '';
}

function getRuntimes() {
  if (!runtimesHandle) {
    runtimesHandle = createRuntimes({
      userDir: app.getPath('userData'),
      bundledDir: bundledRuntimeDir(),
      onEvent: (ev) => broadcast({ type: 'runtime', ...ev }),
    });
  }
  return runtimesHandle;
}

function syncBundledBinsToDir({ binDir, links = [] } = {}) {
  try {
    if (!binDir) return { binDir: '', linked: [] };
    fs.mkdirSync(binDir, { recursive: true });
    const linked = [];
    for (const item of links) {
      const name = item && item.name;
      const target = item && item.target;
      if (!name || !target || !fs.existsSync(target)) continue;
      const ext = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(name)
        ? (/\.(exe|cmd|bat)$/i.test(target) ? path.extname(target) : '.exe')
        : '';
      const destName = ext ? `${name}${ext}` : name;
      const dest = path.join(binDir, destName);
      if (path.resolve(target) === path.resolve(dest)) {
        linked.push({ name: destName, dest, target });
        continue;
      }
      try { fs.chmodSync(target, 0o755); } catch (_) {}
      try {
        try {
          if (fs.lstatSync(dest)) fs.unlinkSync(dest);
        } catch (_) {}
        fs.symlinkSync(target, dest);
        linked.push({ name: destName, dest, target });
      } catch (_) {
        try {
          fs.copyFileSync(target, dest);
          fs.chmodSync(dest, 0o755);
          linked.push({ name: destName, dest, target });
        } catch (_) {}
      }
    }
    return { binDir, linked };
  } catch (_) {
    return { binDir: '', linked: [] };
  }
}

function prependPathDir(dir) {
  if (!dir) return;
  const cur = String(process.env.PATH || '');
  const parts = cur.split(path.delimiter).filter(Boolean);
  if (parts[0] === dir) return;
  process.env.PATH = [dir, ...parts.filter((d) => d !== dir)].join(path.delimiter);
}

function ensureBundledMediaBins(extraLinks = []) {
  try {
    const os = require('os');
    const mediaGen = require('../media-gen');
    const depManager = require('../dep-manager');
    const binDir = path.join(os.homedir(), '.autobot', 'bin');
    const links = [
      { name: 'ffmpeg', target: mediaGen.resolveFfmpeg && mediaGen.resolveFfmpeg() },
      { name: 'ffprobe', target: mediaGen.resolveFfprobe && mediaGen.resolveFfprobe() },
      { name: 'rg', target: depManager.resolveRipgrepBinary && depManager.resolveRipgrepBinary() },
      ...(Array.isArray(extraLinks) ? extraLinks : []),
    ];
    syncBundledBinsToDir({ binDir, links });
    prependPathDir(binDir);
    return binDir;
  } catch (_) {
    return '';
  }
}

/** Prepended PATH entries for a child process env. */
async function runtimePathPrefix() {
  try {
    const rt = getRuntimes();
    const rtLinks = [];
    for (const d of (rt.DESCRIPTORS || [])) {
      try {
        const resolved = await rt.resolve(d.id);
        if (resolved && resolved.bin && fs.existsSync(resolved.bin)) {
          rtLinks.push({ name: d.bin, target: resolved.bin });
        }
      } catch (_) {}
    }
    const mediaBin = ensureBundledMediaBins(rtLinks);
    const dirs = String(await rt.envPath()).split(path.delimiter).filter(Boolean);
    if (mediaBin && !dirs.includes(mediaBin)) dirs.unshift(mediaBin);
    return dirs.join(path.delimiter);
  } catch (_) { return ''; }
}

/**
 * Tell the transport layer which CLI builds are actually on disk.
 *
 * Vendors fingerprint the CLI version inside `user-agent` /
 * `x-grok-client-version`, and they reject models with a message like
 * "Claude Code 2.1.154 does not support this model; version 2.1.290 or newer
 * is required". Hardcoding the string means the app ages out of new models even
 * though it ships a current CLI, so the resolved runtime version is the source
 * of truth and is refreshed after every install.
 */
async function syncClientVersions() {
  try {
    const rows = await getRuntimes().list();
    const v = {};
    for (const r of rows || []) {
      if (r && r.id && r.version) v[r.id] = r.version;
    }
    const applied = providertransport.setClientVersions(v);
    return applied;
  } catch (e) {
    console.error('client version sync skipped:', oneLine(e));
    return null;
  }
}

async function startRuntimes() {
  try {
    const rt = getRuntimes();
    const prefix = await runtimePathPrefix();
    await syncClientVersions();
    if (prefix) {
      const cur = String(process.env.PATH || '');
      const have = new Set(cur.split(path.delimiter));
      const add = prefix.split(path.delimiter).filter((d) => d && !have.has(d));
      if (add.length) process.env.PATH = add.join(path.delimiter) + path.delimiter + cur;
    }
    const state = await rt.loadState();
    // Ship-version check on boot. Deferred and non-blocking: a 400 MB download
    // must never delay first paint, and offline is a normal condition.
    if (state.autoUpdate !== false) {
      const t = setTimeout(() => {
        rt.updateAll()
          .then((res) => {
            const done = (res.results || []).filter((r) => r.ok);
            if (done.length) {
              broadcast({ type: 'runtimes-updated', results: done });
              // New binaries mean a new PATH; refresh the inherited env.
              runtimePathPrefix().then((p) => {
                if (!p) return;
                const cur = String(process.env.PATH || '');
                const have = new Set(cur.split(path.delimiter));
                const add = p.split(path.delimiter).filter((d) => d && !have.has(d));
                if (add.length) process.env.PATH = add.join(path.delimiter) + path.delimiter + cur;
              }).catch(() => {});
              syncClientVersions();
            }
          })
          .catch((e) => console.error('runtime auto-update skipped:', oneLine(e)));
      }, 20000);
      if (t && typeof t.unref === 'function') t.unref();
    }
  } catch (e) {
    console.error('runtimes init failed:', oneLine(e));
  }
}

ipcMain.handle('autobot:runtimes', async () => {
  try { return { ok: true, runtimes: await getRuntimes().list(), bundledDir: bundledRuntimeDir() }; }
  catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:runtimesCheck', async () => {
  try { return await getRuntimes().checkAll(); }
  catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:runtimesUpdate', async (event, id, force) => {
  try {
    const rt = getRuntimes();
    const res = id ? await rt.install(String(id), undefined, { force: !!force }) : await rt.updateAll();
    const out = { ok: true, ...res, runtimes: await rt.list() };
    // A freshly installed runtime changes PATH for later children.
    const p = await runtimePathPrefix();
    if (p) {
      const cur = String(process.env.PATH || '');
      const have = new Set(cur.split(path.delimiter));
      const add = p.split(path.delimiter).filter((d) => d && !have.has(d));
      if (add.length) process.env.PATH = add.join(path.delimiter) + path.delimiter + cur;
    }
    await syncClientVersions();
    return out;
  } catch (e) {
    return { ok: false, error: oneLine(e), runtimes: await getRuntimes().list().catch(() => []) };
  }
});

ipcMain.handle('autobot:runtimesRollback', async (event, id) => {
  try { return { ok: true, ...(await getRuntimes().rollback(String(id))), runtimes: await getRuntimes().list() }; }
  catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:runtimesAutoUpdate', async (event, on) => {
  try {
    await getRuntimes().setAutoUpdate(!!on);
    return { ok: true, autoUpdate: !!on };
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:freellmStatus', async () => {
  try { return { ok: true, ...(await freellmStatus()) }; } catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:freellmProviders', async () => {
  try {
    const cfg = freellm.loadConfig(freellm.CONFIG_FILE);
    if (typeof freellm.hasInternalProviders === 'function' && !freellm.hasInternalProviders(cfg) && typeof freellm.probeExternalModels === 'function') {
      const fb = freellmFallbackApiKey();
      const headers = fb ? { authorization: 'Bearer ' + fb } : {};
      const ext = await freellm.probeExternalModels(cfg, headers, { timeoutMs: 3000 });
      if (ext && ext.json && Array.isArray(ext.json.data)) {
        return { ok: true, models: ext.json.data, upstream: ext.base };
      }
    }
    const data = await freellm.listModels(cfg, { timeoutMs: 6000 });
    return { ok: true, models: data };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmSave', (event, patch) => {
  try {
    const cfg = freellm.loadConfig(freellm.CONFIG_FILE);
    const cur = freellm.normalizeConfig(cfg);
    const next = freellm.normalizeConfig({ ...cur, ...(patch || {}), providers: { ...cur.providers, ...((patch && patch.providers) || {}) } });
    const file = freellm.saveConfig(next, freellm.CONFIG_FILE);
    // Restart the listener so new keys/ports take effect immediately.
    const restart = () => startFreeLLM();
    if (freellmHandle) freellmHandle.stop().then(restart, restart);
    else restart();
    return { ok: true, configFile: file };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmCatalog', (event, opts = {}) => {
  try {
    const cat = require('../freellmapi-catalog');
    return {
      ...cat.getCatalogSummary(),
      chatModels: cat.listChatModels({ platform: opts.platform || '', search: opts.search || '', limit: opts.limit || 200 }),
      mediaModels: cat.listMediaModels({ modality: opts.modality || '', platform: opts.platform || '', search: opts.search || '' }),
      embeddingModels: cat.listEmbeddingModels({ platform: opts.platform || '', search: opts.search || '' }),
      webBotProviders: cat.getWebBotQuickProviders(),
    };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmDetect', async () => {
  try {
    const localRt = require('../local-runtime');
    const info = localRt.detectFreeLLMAPIRuntime();
    const st = await freellmStatus();
    const cfg = freellm.loadConfig(freellm.CONFIG_FILE);
    const unifiedKey = cfg.token || localRt.ensureUnifiedToken(cfg);
    if (!cfg.token) {
      try { freellm.saveConfig({ ...cfg, token: unifiedKey }, freellm.CONFIG_FILE); } catch (_) {}
    }
    return { ok: true, ...info, status: st, unifiedKey };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmImportKeys', async (event, input) => {
  try {
    const localRt = require('../local-runtime');
    let payload = input;
    if (!payload && process.versions && process.versions.electron) {
      const { dialog } = require('electron');
      const res = await dialog.showOpenDialog({
        title: 'Import freellmapi-keys.json',
        properties: ['openFile'],
        filters: [{ name: 'JSON Keys', extensions: ['json'] }],
      });
      if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
      payload = res.filePaths[0];
    }
    const r = localRt.importFreeLLMKeys(payload);
    if (freellmHandle) freellmHandle.stop().then(startFreeLLM, startFreeLLM);
    else startFreeLLM();
    return r;
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmExportKeys', async () => {
  try {
    const localRt = require('../local-runtime');
    const exp = localRt.exportFreeLLMKeys();
    if (process.versions && process.versions.electron) {
      const { dialog } = require('electron');
      const res = await dialog.showSaveDialog({
        title: 'Export freellmapi-keys.json',
        defaultPath: 'freellmapi-keys.json',
        filters: [{ name: 'JSON Keys', extensions: ['json'] }],
      });
      if (!res.canceled && res.filePath) {
        fs.writeFileSync(res.filePath, JSON.stringify(exp.payload, null, 2) + '\n', { mode: 0o600 });
        return { ...exp, savedPath: res.filePath };
      }
    }
    return exp;
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmLaunchDesktop', () => {
  try {
    const localRt = require('../local-runtime');
    const { shell } = (process.versions && process.versions.electron) ? require('electron') : { shell: null };
    return localRt.launchOrInstallFreeLLMAPI({
      shellOpenExternal: shell ? (u) => shell.openExternal(u) : null,
      shellOpenPath: shell ? (p) => shell.openPath(p) : null,
    });
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:freellmSaveSingleKey', (event, payload = {}) => {
  try {
    const localRt = require('../local-runtime');
    const platform = String(payload.platform || '').trim().toLowerCase();
    const apiKey = String(payload.apiKey || '').trim();
    if (!platform || !apiKey) return { ok: false, error: 'Platform and API key are required.' };
    const r = localRt.importFreeLLMKeys({
      providers: {
        [platform]: {
          enabled: true,
          apiKey,
          ...(payload.accountId ? { accountId: String(payload.accountId).trim() } : {}),
        },
      },
    });
    if (freellmHandle) freellmHandle.stop().then(startFreeLLM, startFreeLLM);
    else startFreeLLM();
    return r;
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

// One-shot completion — used by GUI slash commands (/compact, /btw, /recap,

// ---- Scheduled-task runner -------------------------------------------------
// Scheduled tasks run headlessly through the same agent loop as an interactive
// chat turn. Provider comes from the settings the renderer syncs (or the first
// orchestrator provider as a fallback).
function scheduledProvider() {
  const s = store.getSettings();
  if (s.provider && s.provider.model) return s.provider;
  const orch = store.getOrchestrator();
  if (orch && Array.isArray(orch.providers) && orch.providers.length) {
    return orch.providers.find((p) => p.enabled !== false) || orch.providers[0];
  }
  return null;
}

async function resolveFastProviderForGate(task) {
  try {
    let p = scheduledProvider();
    if (!p || !p.model) return null;
    if (task && task.model && String(task.model).trim() && String(task.model).trim().toLowerCase() !== 'auto') {
      p = { ...p, model: String(task.model).trim() };
    }
    return await hydrateProvider(p);
  } catch (_) {
    return null;
  }
}

async function runScheduledPrompt({ task }) {
  const os = require('os');
  const fs = require('fs');
  let provider = scheduledProvider();
  if (!provider || !provider.model) throw new Error('No LLM provider configured — open Settings and select a model first.');
  if (task && task.model && String(task.model).trim() && String(task.model).trim().toLowerCase() !== 'auto') {
    provider = { ...provider, model: String(task.model).trim() };
  }
  // A scheduled task persists only the account id, so the bearer token is
  // minted here at fire time (and refreshed if the subscription rotated).
  provider = await hydrateProvider(provider);
  let out = '';
  let orch = store.getOrchestrator();
  try { orch = (await hydrateOrchestrator(orch, hydrateProvider)).orch; } catch (_) { /* keep the pool as stored */ }
  try { orch = await validateOrchestrator(orch, () => {}); } catch (_) { /* keep the pool as stored */ }
  let taskCwd = (task && task.cwd && fs.existsSync(task.cwd)) ? task.cwd : workspace.scratch();
  if (task && task.useWorktree && task.cwd && fs.existsSync(task.cwd)) {
    try {
      const wtDir = path.join(os.homedir(), '.autobot', 'worktrees', task.id || ('sched-' + Date.now()));
      if (fs.existsSync(wtDir)) {
        taskCwd = wtDir;
      } else {
        const git = require('../git');
        const wtRes = await git.addWorktree(task.cwd, 'sched/' + (task.id || Date.now()), wtDir);
        if (wtRes && wtRes.ok && wtRes.path && fs.existsSync(wtRes.path)) {
          taskCwd = wtRes.path;
        }
      }
    } catch (_) {}
  }
  const permMode = (task && task.permissionMode === 'plan') ? 'plan' : 'auto';
  const finalMessages = await runAgent({
    provider,
    orchestrator: orch,
    messages: [{ role: 'user', content: String(task.prompt) }],
    cwd: taskCwd,
    useMemory: true,
    maxSteps: 0,
    permissionMode: permMode,
    emit: (evt) => {
      if (evt && evt.type === 'delta' && evt.text) out += evt.text;
    },
    shell: shells,
    // A scheduled prompt is its own top-level turn.
    turnStart: true,
  });
  const last = finalMessages && finalMessages[finalMessages.length - 1];
  if (!out && last && typeof last.content === 'string') out = last.content;
  return out || '(no output)';
}


// ---------------------------------------------------------------------------
// FreeLLMAPI (local OpenAI-compatible router over the free-tier providers)
// ---------------------------------------------------------------------------
let freellmHandle = null;
let freellmCompatHandle = null;
let freellmError = null;

function startFreeLLM() {
  if (typeof freellm.setFallbackKeyProvider === 'function') {
    freellm.setFallbackKeyProvider(() => freellmFallbackApiKey());
  }
  freellm.start({ configPath: freellm.CONFIG_FILE }).then((handle) => {
    freellmHandle = handle;
    freellmError = null;
    const live = freellm.PROVIDER_IDS.filter((id) => freellm.isConfigured(id, handle.config));
    console.log('FreeLLMAPI on ' + handle.url + ' (' + (live.join(', ') || 'external router bridge / no internal keys') + ')');
    // Bind optional :31415 compatibility listener when external FreeLLMAPI desktop is not already running there
    if (Number(handle.port) !== 31415 && !freellmCompatHandle && process.env.FREELM_DISABLE_COMPAT_PORT !== '1') {
      freellm.start({ configPath: freellm.CONFIG_FILE, port: 31415 }).then((ch) => {
        freellmCompatHandle = ch;
        console.log('FreeLLMAPI compatibility endpoint listening on ' + ch.url);
      }).catch(() => {
        // Port 31415 already bound by external FreeLLMAPI.app — expected, leave untouched.
      });
    }
  }).catch((err) => {
    freellmHandle = null;
    freellmError = (err && err.message) || 'failed to start';
    console.error('FreeLLMAPI unavailable:', freellmError);
  });
}

async function freellmStatus() {
  let cfg = null;
  try { cfg = freellm.loadConfig(freellm.CONFIG_FILE); } catch (_) {}
  let upstream = null;
  try {
    if (typeof freellm.probeExternalHealth === 'function') {
      upstream = await freellm.probeExternalHealth(cfg || {}, {});
    }
  } catch (_) {}
  return {
    running: !!freellmHandle || !!upstream,
    url: upstream || (freellmHandle ? freellmHandle.url : 'http://127.0.0.1:' + ((cfg && cfg.port) || 3001) + '/v1'),
    upstream: upstream || null,
    configFile: freellm.CONFIG_FILE,
    error: upstream ? null : freellmError,
    providers: cfg ? freellm.PROVIDER_IDS.map((id) => ({
      id,
      label: freellm.PROVIDERS[id].label,
      configured: freellm.isConfigured(id, cfg),
      enabled: cfg.providers[id].enabled !== false,
      defaultModel: cfg.providers[id].defaultModel,
    })) : [],
  };
}

  ensureBundledMediaBins();

  return {
    bundledRuntimeDir, getRuntimes, runtimePathPrefix, syncClientVersions, startRuntimes,
    scheduledProvider, runScheduledPrompt, resolveFastProviderForGate, startFreeLLM, freellmStatus,
    stopFreeLLM: () => {
      try { if (freellmHandle) freellmHandle.stop(); } catch (_) {}
      try { if (freellmCompatHandle) freellmCompatHandle.stop(); } catch (_) {}
      freellmHandle = null;
      freellmCompatHandle = null;
    },
  };
};

module.exports.syncBundledBinsToDir = function syncBundledBinsToDirStandalone({ binDir, links = [] } = {}) {
  if (!binDir) return { binDir: '', linked: [] };
  fs.mkdirSync(binDir, { recursive: true });
  const linked = [];
  for (const item of links) {
    const name = item && item.name;
    const target = item && item.target;
    if (!name || !target || !fs.existsSync(target)) continue;
    const ext = process.platform === 'win32' && !/\.(exe|cmd|bat)$/i.test(name)
      ? (/\.(exe|cmd|bat)$/i.test(target) ? path.extname(target) : '.exe')
      : '';
    const destName = ext ? `${name}${ext}` : name;
    const dest = path.join(binDir, destName);
    if (path.resolve(target) === path.resolve(dest)) {
      linked.push({ name: destName, dest, target });
      continue;
    }
    try { fs.chmodSync(target, 0o755); } catch (_) {}
    try {
      try { if (fs.lstatSync(dest)) fs.unlinkSync(dest); } catch (_) {}
      fs.symlinkSync(target, dest);
      linked.push({ name: destName, dest, target });
    } catch (_) {
      try {
        fs.copyFileSync(target, dest);
        fs.chmodSync(dest, 0o755);
        linked.push({ name: destName, dest, target });
      } catch (_) {}
    }
  }
  return { binDir, linked };
};