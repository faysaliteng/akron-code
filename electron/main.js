'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, globalShortcut, nativeImage, protocol, session, screen, clipboard } = require('electron');
const secretstore = require('./secretstore');
if (process.platform !== 'darwin' || !secretstore.hasLegacySafeStorage()) {
  try {
    app.commandLine.appendSwitch('use-mock-keychain');
    app.commandLine.appendSwitch('password-store', 'basic');
  } catch (_) {}
}
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFile, spawnSync } = require('child_process');
const net = require('net');
const { runAgent, createPauseController, normalizeProvider, humanizeLLMError } = require('./llm');
const store = require('./store');
const { MCPClient } = require('./mcp');
const { ShellManager } = require('./shell');
const computer = require('./computer');
const chrome = require('./chrome');
const browser = require('./browser');
const git = require('./git');
const pluginsDir = require('./plugins');
const scheduler = require('./scheduler');
const providerStatus = require('./providerstatus');
const providerOauth = require('./provider-oauth');
const { normalizeReconnectCode, isRetryableLine } = require('./reconnect-code');
const providertransport = require('./providertransport');
const modelCatalog = require('./model-catalog');
const workspace = require('./workspace');
const paths = require('./paths');
const mindmap = require('./mindmap');
const artifactcanvas = require('./artifactcanvas');
const artifactstore = require('./artifactstore');
const artifacttypes = require('./artifacttypes');
const extensionhost = require('./extensionhost');
const unfurlMod = require('./unfurl');
const compliance = require('./compliance');
const mcpoauth = require('./mcpoauth');
const computeruse = require('./computeruse');
const windowstate = require('./windowstate');
const freellm = require('./freellm');
const { createRuntimes } = require('./runtimes');
const orchPool = require('./orch-pool');
const sessionlog = require('./sessionlog');
const { hydrateOrchestrator, poolDeadNotice, isOrchestratorActiveForTurn, createPoolNoticeDeduper } = require('./orch-hydrate');
const poolNoticeDeduper = createPoolNoticeDeduper();
const rea = require('./rea');
const gdrive = require('./gdrive');
const ideIpc = require('./ide/ipc');
const brandGuard = require('./brand-guard');
const {
  APP_USER_MODEL_ID,
  resolveAppIconPath,
  resolveNotificationIconPath,
  createNotificationService,
} = require('./notifications');
try { rea.enrichProcessPath(); } catch (_) {}

// ---------------------------------------------------------------------------
// Rebrand migration: user data used to live under "Helio Bot".
// ---------------------------------------------------------------------------
// Chromium state (Local Storage, the persisted extension partition, the cache)
// is keyed by the userData folder name, and `productName` is now "Akron Bot", so
// the old tree is moved into place once, before anything reads userData. The OS
// keychain entry is named after the app as well, so secrets encrypted under the
// old name need a one-time re-entry (see VERIFICATION.md §24); nothing here
// touches `~/.autobot`, which is where every piece of app state actually lives.
(function migrateUserData() {
  try {
    const base = app.getPath('appData');
    const codeDir = path.join(base, 'Akron Code');
    const akronDir = path.join(base, 'Akron Bot');
    const helioDir = path.join(base, 'Helio Bot');
    if (!fs.existsSync(akronDir) && fs.existsSync(helioDir)) {
      fs.renameSync(helioDir, akronDir);
    }
    const codeHasStorage = fs.existsSync(path.join(codeDir, 'Local Storage'));
    if (!codeHasStorage && fs.existsSync(akronDir)) {
      fs.cpSync(akronDir, codeDir, {
        recursive: true,
        force: false,
        filter: (src) => !/^Singleton/.test(path.basename(src)),
      });
    }
  } catch (_) { /* non-fatal: the app starts with a fresh profile */ }
})();

const windows = new Set(); // all open BrowserWindows (multi-window parity)
// The primary chat window (first created). Desktop's launcher focuses it when a
// second instance is started or a deep link arrives.
let primaryWindow = null;
// artifact key -> Set<BrowserWindow>: artifact windows currently showing that
// canvas document, so an edit made in the chat preview refreshes them too.
const artifactWindows = new Map();
// BrowserWindow.id -> extension id, for the hosting windows created by
// `createExtensionWindow` (Desktop's extension-page surfaces).
const extensionWindows = new Map();

// `chrome-extension://` navigation is owned by Chromium and cannot be
// intercepted (ERR_BLOCKED_BY_CLIENT), so hosted extension pages fall back to
// this scheme. It must be privileged before `app.whenReady()`.
protocol.registerSchemesAsPrivileged([{
  scheme: 'helio-extension',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);
const runs = new Map(); // runId -> AbortController

// ---------------------------------------------------------------------------
// Single instance + deep links (Desktop's launcher.js parity)
// ---------------------------------------------------------------------------
// Two copies of the app would fight over the same ~/.autobot store (settings,
// conversation index, provider accounts), so a second launch focuses the
// running window instead. A `helio://` link that arrives while we are still
// booting is parked and delivered once the window can receive it.
if (process.platform === 'win32') {
  try { app.setAppUserModelId(APP_USER_MODEL_ID); } catch (_) {}
}

if (process.env.AKRON_COLD_BOOT_CHECK === '1') {
  try { app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cb-'))); } catch (_) {}
}

const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance && process.env.AKRON_COLD_BOOT_CHECK !== '1') app.quit();

const PROTOCOL = 'helio';
let pendingDeepLink = '';

function isDeepLink(v) {
  return typeof v === 'string' && v.toLowerCase().slice(0, PROTOCOL.length + 3) === PROTOCOL + '://';
}

function findMainWindow() {
  if (primaryWindow && !primaryWindow.isDestroyed()) return primaryWindow;
  for (const w of windows) if (!w.isDestroyed()) return w;
  return null;
}

function focusMainWindow() {
  const win = findMainWindow();
  if (!win) { if (app.isReady()) createWindow(); return null; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return win;
}

function windowIconProps() {
  if (process.platform !== 'win32' && process.platform !== 'linux') return {};
  const icon = resolveAppIconPath({ isPackaged: app.isPackaged });
  return icon ? { icon } : {};
}

const notificationService = createNotificationService({
  isPackaged: () => app.isPackaged,
  getWindows: () => Array.from(windows),
  getMainWindow: findMainWindow,
  focusMainWindow,
});

function routeDeepLink(url) {
  if (!isDeepLink(url)) return;
  const win = findMainWindow();
  if (!win || win.webContents.isLoading()) { pendingDeepLink = url; return; }
  win.webContents.send('autobot:event', { type: 'deeplink', url });
  focusMainWindow();
}

function flushDeepLink(win) {
  if (!pendingDeepLink || !win || win.isDestroyed()) return;
  const url = pendingDeepLink;
  pendingDeepLink = '';
  try { win.webContents.send('autobot:event', { type: 'deeplink', url }); } catch (_) {}
}

function registerProtocol() {
  try {
    if (process.defaultApp && process.argv.length >= 2) {
      // Dev run: the OS has to be told which script to boot under Electron.
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(PROTOCOL);
    }
  } catch (_) { /* unsupported platform / no permission: links still work via argv */ }
}

// macOS delivers links through `open-url`, sometimes before `ready`.
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (!app.isReady()) { pendingDeepLink = url; return; }
  routeDeepLink(url);
});

app.on('second-instance', (_e, argv) => {
  const link = (argv || []).find(isDeepLink);
  if (link) routeDeepLink(link);
  else focusMainWindow();
});


// Connector id -> in-flight OAuth promise, so double-clicks join one flow.
const authFlights = new Map();
// OAuth-gated connectors get their bearer from the encrypted secret store, so
// the MCP transport never has to know how the token was obtained.
const mcp = new MCPClient({
  authProvider: async (url) => {
    try {
      const secretstore = require('./secretstore');
      return await mcpoauth.ensureAccessToken({ endpointUrl: url, store: secretstore });
    } catch (_) { return null; }
  },
});

// Turn MCP transport failures into one human-readable line: no raw JSON-RPC
// envelopes, HTML error pages, or escaped newlines ever reach the UI.
function describeConnectError(err) {
  const raw = String((err && err.message) || err || '').trim();
  if (!raw) return 'could not connect';
  const status = (raw.match(/\b(4\d\d|5\d\d)\b/) || [])[1];
  // Pull the nested reason out of a JSON-RPC error body when one is present.
  let reason = '';
  const m = raw.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/g);
  if (m && m.length) {
    reason = m[m.length - 1].replace(/^"message"\s*:\s*"/, '').replace(/"$/, '');
    try { reason = JSON.parse('"' + reason + '"'); } catch (_) {}
  }
  if (status === '401' || /authentication required|unauthori[sz]ed/i.test(raw)) {
    return 'this server requires sign-in before its tools work';
  }
  if (status === '403') return 'access denied by the server';
  if (status === '404') return 'server endpoint not found';
  if (/timed out/i.test(raw)) return 'connection timed out';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return 'host could not be resolved';
  if (/ECONNREFUSED|ECONNRESET/i.test(raw)) return 'connection refused';
  if (reason) return reason.replace(/\s+/g, ' ').slice(0, 160);
  // Last resort: strip anything markup-ish and clamp the length.
  const flat = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return (status ? 'HTTP ' + status + ': ' : '') + flat.slice(0, 160);
}

// ── MCP auto-connect (Claude Code parity) ────────────────────────────────
// Claude Code starts every server declared in `.mcp.json`, `~/.claude.json`
// and its own config the moment a session begins. We do the same, once per
// server name per cwd, and remember the id so tools land in `extraTools`.
const autoMcp = new Map(); // `${cwd}::${name}` -> serverId
const autoMcpTried = new Set(); // `${cwd}::${name}` that already failed once

async function autoConnectMcp(cwd) {
  try {
    const feat = store.getFeatures ? store.getFeatures() : {};
    if (!feat.reaDisabled) {
      await rea.ensureConnected(mcp, { userDataDir: app.getPath('userData') }).catch(() => {});
    }
  } catch (_) {}
  let cfg;
  try { cfg = require('./claudeconfig').loadMcpServers(cwd); } catch (_) { return; }
  const entries = Object.entries((cfg && cfg.servers) || {});
  for (const [name, def] of entries) {
    const key = `${cwd || ''}::${name}`;
    if (autoMcp.has(key) || autoMcpTried.has(key)) continue;
    if (!def || typeof def !== 'object') continue;
    // Skip servers the user disabled in the config (`"disabled": true`).
    if (def.disabled) continue;
    const transport = String(def.type || def.transport || (def.url ? 'http' : 'stdio')).toLowerCase();
    const connectCfg = {
      name,
      transport,
      ...(def.url ? { url: def.url, headers: def.headers || {} } : {}),
      ...(def.command ? { command: def.command, args: def.args || [], env: { ...process.env, ...(def.env || {}) } } : {}),
    };
    if (!connectCfg.url && !connectCfg.command) continue;
    try {
      const info = await mcp.connect(connectCfg);
      const entry = mcp.servers.get(info.serverId);
      if (entry) entry.fullTools = info.tools || [];
      autoMcp.set(key, info.serverId);
    } catch (_) {
      // A broken server must never block the run; try once per process.
      autoMcpTried.add(key);
    }
  }
}

function mcpStatus() {
  return [...mcp.servers.entries()].map(([id, e]) => ({ serverId: id, name: e.name, type: e.type, url: e.url || null, tools: (e.fullTools || []).map((t) => t.name) }));
}
const shells = new ShellManager();

let tray = null;      // macOS menu-bar icon (Example parity: system tray)
let quickWin = null;  // Quick Entry window (menu-bar / global-hotkey prompt)

// Resolve the BrowserWindow that owns a given IPC event (for per-window replies
// and dialog parenting). Falls back to the first live window.
function winFor(event) {
  if (event && event.sender) {
    const w = BrowserWindow.fromWebContents(event.sender);
    if (w && !w.isDestroyed()) return w;
  }
  for (const w of windows) if (w && !w.isDestroyed()) return w;
  return null;
}

// Human-readable one-line summary of a tool call for the permission prompt.
function summarizeTool(name, args) {
  args = args || {};
  switch (name) {
    case 'Bash':
    case 'mcp__terminal__run_in_terminal':
      return String(args.command || '').slice(0, 200);
    case 'Write':
    case 'mcp__workspace__write_file':
      return 'Write ' + args.path;
    case 'Edit':
    case 'mcp__workspace__edit_file':
      return 'Edit ' + args.path;
    case 'MultiEdit':
      return 'Multi-edit ' + args.path;
    default:
      return name + ' ' + JSON.stringify(args).slice(0, 200);
  }
}

// Pending interactive questions / plan approvals (id -> resolver).
let pendingQuestions = new Map();
const { createQuestionGate } = require('./question-gate');
const questionGate = createQuestionGate(pendingQuestions);

// Pending write/bash permission prompts (B8 Claude Code mode, FIFO gate with AbortSignal cleanup).
const { createPermissionGate } = require('./perm-gate');
const permGate = createPermissionGate();

// Pending Computer Use consent prompts (Desktop `computer:request_*`). Only one
// can be outstanding at a time, so a boolean-once resolver is enough.
let pendingComputerUse = null;

function winTitleBarOverlay(theme) {
  const isLight = theme === 'light';
  return {
    color: isLight ? '#f8f8fa' : '#18181c',
    symbolColor: isLight ? '#1f1f24' : '#e4e4ea',
    height: 39,
  };
}

const sandbox = require('./sandbox');
const search = require('./search');
const sessionDb = require('./session-db');
const environments = require('./environments');
const depManager = require('./dep-manager');
const updater = require('./updater');
const registerOauthModelIpc = require('./ipc/ipc-oauth-models');
const createRuntimesController = require('./ipc/ipc-runtimes');
const registerWindowsExtensionsIpc = require('./ipc/ipc-windows-extensions');
const registerFeaturesIpc = require('./ipc/ipc-features');

const cwdFor = (cwd) => cwd || store.getSettings().lastCwd || workspace.ROOT;
const pendingComputerUseRef = { val: null };
const extHost = extensionhost.createExtensionHost();
let winExtCtrl = null;
let oauthCtrl = null;
let runtimesCtrl = null;
const broadcast = (evt) => { for (const w of windows) if (!w.isDestroyed()) w.webContents.send('autobot:event', evt); };
const broadcastArtifactSaved = (...args) => winExtCtrl && winExtCtrl.broadcastArtifactSaved(...args);
const createQuickWindow = (...args) => winExtCtrl && winExtCtrl.createQuickWindow(...args);
const hideQuickWin = () => winExtCtrl && winExtCtrl.hideQuickWin();

const nativeClip = require('./native-clipboard').createNativeClipboard({
  clipboardImpl: clipboard,
  spawnSyncImpl: spawnSync,
});

function writeNativeClipboard(text, html = '') {
  return nativeClip.writeNativeClipboard(text, html);
}

function readNativeClipboard() {
  return nativeClip.readNativeClipboard();
}

function attachContextMenu(wc) {
  if (!wc || wc.__akronCtxMenuAttached) return;
  wc.__akronCtxMenuAttached = true;

  if (app.isPackaged) {
    wc.on('before-input-event', (event, input) => {
      if (!input || input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      const isInspect = key === 'f12' || ((input.control || input.meta) && (input.shift || input.alt) && key === 'i');
      if (isInspect) event.preventDefault();
    });
  }

  wc.on('context-menu', async (_event, params) => {
    const template = [];
    let selText = String((params && params.selectionText) || '');
    if (!selText) {
      try {
        selText = await wc.executeJavaScript(
          '(function(){try{return window.__akronGetSelectedText ? window.__akronGetSelectedText() : (window.getSelection ? window.getSelection().toString() : "");}catch(_){return "";}})()',
          true
        ) || '';
      } catch (_) {}
    }
    const flags = (params && params.editFlags) || {};
    if (params && params.isEditable) {
      if (flags.canUndo) template.push({ role: 'undo' });
      if (flags.canRedo) template.push({ role: 'redo' });
      if (template.length) template.push({ type: 'separator' });
      template.push(
        { role: 'cut', enabled: !!flags.canCut || Boolean(selText) },
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          enabled: !!flags.canCopy || Boolean(selText),
          click: () => {
            if (selText) writeNativeClipboard(selText);
            else { try { wc.copy(); } catch (_) {} }
          },
        },
        { role: 'paste', enabled: !!flags.canPaste },
        { role: 'pasteAndMatchStyle', enabled: !!flags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: flags.canSelectAll !== false }
      );
    } else {
      template.push({
        label: 'Copy',
        accelerator: 'CmdOrCtrl+C',
        enabled: Boolean(selText) || !!flags.canCopy,
        click: async () => {
          let toCopy = selText;
          if (!toCopy) {
            try {
              toCopy = await wc.executeJavaScript(
                '(function(){try{return window.__akronGetSelectedText ? window.__akronGetSelectedText() : (window.getSelection ? window.getSelection().toString() : "");}catch(_){return "";}})()',
                true
              ) || '';
            } catch (_) {}
          }
          if (toCopy) {
            writeNativeClipboard(toCopy);
          } else {
            try { wc.copy(); } catch (_) {}
          }
        },
      });
      if (params && params.linkURL) {
        template.push({
          label: 'Copy Link Address',
          click: () => {
            writeNativeClipboard(String(params.linkURL));
          },
        });
      }
      template.push({
        label: 'Select All',
        accelerator: 'CmdOrCtrl+A',
        click: () => {
          try { wc.selectAll(); } catch (_) {}
        },
      });
    }
    if (!template.length) return;
    const targetWin = BrowserWindow.fromWebContents(wc) || BrowserWindow.getFocusedWindow();
    Menu.buildFromTemplate(template).popup(targetWin ? { window: targetWin } : undefined);
  });
}

ipcMain.handle('autobot:clipboardWrite', (_e, payload) => {
  try {
    const isObj = payload && typeof payload === 'object';
    const str = String(isObj ? (payload.text == null ? '' : payload.text) : (payload == null ? '' : payload));
    const html = isObj && payload.html ? String(payload.html) : '';
    const res = nativeClip.writeNativeClipboard(str, html, { detailed: true });
    return { ok: Boolean(res && res.ok), verified: Boolean(res && res.verified) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});

ipcMain.handle('autobot:clipboardRead', () => {
  return readNativeClipboard();
});

ipcMain.handle('autobot:clipboardReadImage', () => {
  return nativeClip.readClipboardImagePayload();
});

function createWindow() {
  // Restore the last size/position (Desktop mainWindow.js). Bounds that no
  // longer intersect a display are dropped rather than restoring off-screen.
  const geo = windowstate.restore(screen.getAllDisplays());
  const { __maximized, ...bounds } = geo;
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const initTheme = (store.getSettings() || {}).theme;
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 940,
    minHeight: 600,
    title: 'Akron Code',
    ...windowIconProps(),
    backgroundColor: initTheme === 'light' ? '#ffffff' : '#131316',
    ...(isMac
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 12 } }
      : isWin
        ? { titleBarStyle: 'hidden', autoHideMenuBar: true, titleBarOverlay: winTitleBarOverlay(initTheme) }
        : { autoHideMenuBar: true }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });
  if (!isMac) {
    try { win.setMenuBarVisibility(false); } catch (_) {}
  }

  if (!primaryWindow || primaryWindow.isDestroyed()) primaryWindow = win;
  windows.add(win);
  windowstate.track(win, { onRestore: true });
  // A deep link that arrived during boot is delivered once the page can hear it.
  attachContextMenu(win.webContents);
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(String(message || ''));
  });
  win.webContents.once('did-finish-load', async () => {
    flushDeepLink(win);
    try {
      let domRes = null;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (win.isDestroyed()) return;
        domRes = await win.webContents.executeJavaScript(brandGuard.verifyRendererDomScript());
        if (domRes && domRes.ok) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!domRes || !domRes.ok) {
        console.error('[brand-guard] Renderer brand verification failed:', JSON.stringify(domRes));
        if (app.isPackaged || process.env.AKRON_ENFORCE_BRAND_SEAL === '1') {
          if (process.env.AKRON_NO_DIALOG !== '1') {
            dialog.showErrorBox('Akron Code Integrity Error', 'Akron Code branding verification failed.');
          }
          app.exit(78);
          return;
        }
      }
      if (process.env.AKRON_COLD_BOOT_CHECK === '1') {
        setTimeout(async () => {
          try {
            const integrity = brandGuard.verifyBrandIntegrity();
            const ipcOk = await win.webContents.executeJavaScript('Boolean(window.autobot && typeof window.autobot.getVersion === "function")');
            const summary = {
              ok: Boolean(integrity.ok && domRes && domRes.ok && ipcOk && consoleErrors.length === 0),
              brandOk: integrity.ok,
              domOk: Boolean(domRes && domRes.ok),
              ipcOk,
              checkedFiles: integrity.checkedFiles,
              consoleErrorCount: consoleErrors.length,
              consoleErrors: consoleErrors.slice(0, 5),
            };
            process.stdout.write(`COLD_BOOT_OK ${JSON.stringify(summary)}\n`);
            app.exit(summary.ok ? 0 : 1);
          } catch (err) {
            process.stderr.write(`COLD_BOOT_FAIL ${err && err.message ? err.message : String(err)}\n`);
            app.exit(1);
          }
        }, 1200);
      }
    } catch (_) {}
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    win.loadURL(devUrl);
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('closed', () => {
    windows.delete(win);
    try { extHost.detachSink(win.webContents); } catch (_) {}
  });
  return win;
}



// Menu-bar tray icon (macOS): show window, quick entry, new window, quit.
function createTray() {
  if (tray) return tray;
  // `…Template.png` is a macOS template image: black + alpha, auto-inverted by
  // the system for light/dark menu bars. @2x is picked up automatically.
  let img = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  if (img.isEmpty()) {
    const legacy = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
    img = legacy.isEmpty() ? nativeImage.createEmpty() : legacy.resize({ width: 16, height: 16 });
  }
  tray = new Tray(img);
  if (!img.isEmpty()) tray.setImage(img);
  tray.setToolTip('Akron Code');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Akron Code', click: () => { const w = mainWindow() || createWindow(); w.show(); w.focus(); } },
    { label: 'Quick Entry', accelerator: 'CmdOrCtrl+Shift+Space', click: () => createQuickWindow() },
    { type: 'separator' },
    { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
    { type: 'separator' },
    { label: 'About Akron Code', click: () => createAboutWindow() },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => { const w = mainWindow() || createWindow(); w.show(); w.focus(); });
  return tray;
}

// Global hotkeys: Quick Entry (CmdOrCtrl+Shift+Space) gated by features.quickEntry.
function registerQuickShortcuts(enable) {
  if (process.platform === 'darwin') {
    // (Tray + menu accelerators cover Quick Entry on macOS; a global shortcut is
    //  additionally registered here so the feature works app-wide, not just when
    //  a window is focused.)
  }
  try {
    if (enable) {
      if (!globalShortcut.isRegistered('CmdOrCtrl+Shift+Space')) {
        globalShortcut.register('CmdOrCtrl+Shift+Space', () => createQuickWindow());
      }
    } else {
      if (globalShortcut.isRegistered('CmdOrCtrl+Shift+Space')) {
        globalShortcut.unregister('CmdOrCtrl+Shift+Space');
      }
    }
  } catch (_) { /* globalShortcut unavailable (e.g. sandboxed) — non-fatal */ }
}

// Artifact app window: opens an artifact (code/HTML/SVG/markdown) in its own
// standalone window, mirroring Example's "open in app" artifact surface.
//
// Canvas artifacts (design / slides) resolve their persisted hand edits first:
// the key is a hash of the generated content, so the same artifact always finds
// the same edit slot no matter which surface built it.

function applyFeatures(features) {
  features = features || store.getFeatures();
  computer.setEnabled(!!features.computerUse);
  chrome.configure({ host: features.chromeHost || '127.0.0.1', port: features.chromePort || 9222 });
  registerQuickShortcuts(!!features.quickEntry);
}

oauthCtrl = registerOauthModelIpc({ ipcMain, store, secretstore, freellm, providerOauth, providertransport, modelCatalog, orchPool, normalizeReconnectCode, isRetryableLine, winFor, broadcast, poolNoticeDeduper, bundledRuntimeDir: () => (runtimesCtrl ? runtimesCtrl.bundledRuntimeDir() : ''), getRuntimes: () => (runtimesCtrl ? runtimesCtrl.getRuntimes() : null) });
const { freellmFallbackApiKey, hydrateLocalFreeLlmProvider, hydrateProvider, validateOrchestrator, oneLine, fetchProviderModels, warmModelCatalogs, replayClaudeRotation } = oauthCtrl;

runtimesCtrl = createRuntimesController({ app, ipcMain, store, workspace, shells, freellm, createRuntimes, providertransport, runAgent, hydrateProvider, hydrateOrchestrator, validateOrchestrator, freellmFallbackApiKey, oneLine, broadcast });
const { runtimePathPrefix, startRuntimes, runScheduledPrompt, startFreeLLM } = runtimesCtrl;

winExtCtrl = registerWindowsExtensionsIpc({ windows, artifactWindows, extensionWindows, windowIconProps, winFor, findMainWindow, focusMainWindow, createWindow, createTray, store, extensionhost, artifactcanvas, artifactstore, artifacttypes, extHost, unfurlMod, compliance, computeruse, brandGuard, broadcast, pendingComputerUseRef, mcp, gdrive, computer, oneLine, describeConnectError });
const { createAboutWindow, buildMenu, mainWindow } = winExtCtrl;

ipcMain.handle('autobot:run', async (event, payload) => {
  let { runId, messages, provider, cwd, useMemory, maxSteps, orchestrator, permissions, title, convId, swarm } = payload || {};
  // The pool this turn will actually run against: the renderer's when it sent
  // one, otherwise the persisted one. Both need the same token resolution.
  const orchSource = orchestrator || store.getOrchestrator();
  const routingMode = (provider && provider.routingMode)
    || (provider && String(provider.model || '').trim().toLowerCase() === 'auto' ? 'auto' : '');
  const orchActive = isOrchestratorActiveForTurn(orchSource, swarm, provider);
  let poolDead = [];
  let delegationOrchestrator = null;
  // Resolve subscription accounts into a live bearer token before the turn.
  try {
    if (routingMode === 'auto') {
      try {
        provider = await hydrateProvider(provider);
      } catch (_) {
        provider = { ...(provider || {}), oauthProvider: '', oauth: false, accessToken: '', transport: '' };
      }
    } else {
      provider = await hydrateProvider(provider);
    }
    if (orchActive && orchSource) {
      const hy = await hydrateOrchestrator(orchSource, hydrateProvider);
      orchestrator = hy.orch;
      delegationOrchestrator = hy.orch;
      poolDead = hy.dead;
    } else {
      orchestrator = orchSource;
      poolNoticeDeduper.reset();
      if (orchSource) {
        try {
          const hyDel = await hydrateOrchestrator(orchSource, hydrateProvider);
          delegationOrchestrator = hyDel && hyDel.orch ? hyDel.orch : orchSource;
        } catch (_) {
          delegationOrchestrator = orchSource;
        }
      }
    }
  } catch (e) {
    // The run never started, so nothing else will ever clear the renderer's
    // streaming state. Emit the failure as a normal run event *and* return it,
    // so a dead token surfaces as a real message instead of an endless spinner.
    const needsSignIn = e.code === 'provider_needs_signin';
    const owner = winFor(event);
    if (owner && !owner.isDestroyed()) {
      owner.webContents.send('autobot:event', {
        runId,
        type: 'error',
        message: e.message,
        needsSignIn,
        fatal: true,
        retryable: false,
      });
    }
    return { ok: false, error: e.message, needsSignIn };
  }
  const ac = new AbortController();
  const pauseCtrl = createPauseController();
  const owner = winFor(event); // route streaming events back to the originating window
  const turnId = 't' + Date.now();
  const runStartedMs = Date.now();
  // Event-sourced run log (DeepSeek-harness style): every structural event of
  // the turn is appended to ~/.autobot/sessions/<conv>/<turn>.jsonl so a run
  // can be inspected and replayed after the fact.
  const slog = sessionlog.open(convId || 'scratch', turnId, { title });
  const send = (evt) => {
    if (owner && !owner.isDestroyed()) owner.webContents.send('autobot:event', { runId, ...evt });
    slog.append(evt);
  };
  runs.set(runId, { ac, pauseCtrl, send });
  const emit = (evt) => send(evt);

  const deadNotice = poolDead.length ? poolDeadNotice(poolDead) : '';
  if (poolNoticeDeduper.shouldEmitDead(deadNotice)) {
    emit({ type: 'notice', text: deadNotice });
  }

  // Kick off pool validation now so its network wait overlaps MCP discovery.
  const baseOrchInput = orchestrator || orchSource;
  const orchInput = routingMode === 'orchestrator'
    ? { ...(baseOrchInput || {}), enabled: true }
    : (routingMode === 'direct' && !swarm ? { ...(baseOrchInput || {}), enabled: false } : baseOrchInput);
  const orchReady = (orchActive && routingMode !== 'direct')
    ? validateOrchestrator(orchInput, emit).catch(() => orchInput)
    : Promise.resolve(orchInput);

  // gather MCP tools across connected servers + built-in Google Drive tools
  const extraTools = [];
  const serverIds = [...mcp.servers.keys()];
  for (const sid of serverIds) {
    const entry = mcp.servers.get(sid);
    // entry.tools holds only names; we need descriptions/schemas — store full defs in connect
    for (const t of entry.fullTools || []) {
      extraTools.push({ name: `mcp__${sid}__${t.name}`, description: `[MCP ${entry.name}] ${t.description || ''}`, inputSchema: t.inputSchema });
    }
  }
  try {
    if (gdrive.status(mcp).connected && !mcp.servers.has('gdrive')) {
      for (const t of gdrive.toolSpecs()) {
        extraTools.push({ name: `mcp__gdrive__${t.name}`, description: t.description, inputSchema: t.inputSchema });
      }
    }
  } catch (_) {}

  const callMcpTool = async (name, args) => {
    const m = /^mcp__(\w+?)__(.+)$/.exec(name);
    if (!m) return 'Unknown MCP tool: ' + name;
    if (m[1] === 'gdrive' && !mcp.servers.has('gdrive')) {
      return await gdrive.callTool(m[2], args || {}, mcp);
    }
    const rawOut = await mcp.callTool(m[1], m[2], args);
    if (m[1] !== 'rea' && typeof rawOut === 'string' && rawOut.trim()) {
      return require('./untrusted').wrapUntrusted(rawOut, { source: `mcp:${m[1]}` });
    }
    return rawOut;
  };

  // Ask the user a structured question (pauses agent, resumes on answer).
  const askUser = async (q) => questionGate.ask({
    raw: q,
    runId,
    convId,
    signal: ac.signal,
    emit: send,
  });

  // Exit plan mode: present a plan for approval.
  const exitPlanMode = async (p) => questionGate.askPlan({
    raw: p,
    runId,
    convId,
    signal: ac.signal,
    emit: send,
  });

  const mcpListResources = async (server) => {
    if (server) return mcp.listResources(server);
    const all = {};
    for (const sid of [...mcp.servers.keys()]) all[sid] = await mcp.listResources(sid);
    return JSON.stringify(all, null, 2);
  };
  const mcpReadResource = async (server, uri) => {
    if (server) return mcp.readResource(server, uri);
    for (const sid of [...mcp.servers.keys()]) {
      try { return await mcp.readResource(sid, uri); } catch (_) {}
    }
    return `Resource not found: ${uri}`;
  };

  // The run must write where the conversation lives. If the renderer did not
  // send a folder (new conversation, mid-switch, stale state), resolve it from
  // the conversation itself instead of falling back to a shared scratch dir —
  // that mismatch is what made a generated site "disappear".
  const runCwd = cwd || (convId ? workspace.ensure(convId, title).dir : workspace.scratch());

  // B8 Claude Code mode: prompt for approval before mutating tools (Bash/Write/Edit).
  // Permission modes: 'auto' (allow all), 'ask' (prompt for every mutating tool),
  // 'acceptEdits' (auto-allow file edits, prompt for shell/terminal), 'plan' (deny all
  // mutations — the model must propose a plan via ExitPlanMode instead),
  // 'bypass' (allow everything with no prompts at all — equivalent to auto, kept
  // distinct so the UI can surface the elevated-trust state).
  const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__workspace__write_file', 'mcp__workspace__edit_file']);
  const promptPermission = (toolName, toolArgs) => permGate.prompt({
    runId,
    convId,
    toolName,
    args: toolArgs,
    summary: summarizeTool(toolName, toolArgs),
    cwd: runCwd,
    signal: ac.signal,
    emit: (evt) => {
      send(evt);
      if (evt && evt.type === 'permission' && evt.id) {
        try {
          const push = require('./push-channels');
          const sid = push.registerShortPermission(evt.id);
          push.sendPushAlert({
            kind: 'permission',
            title: 'Akron Code · Permission Needed',
            body: `${evt.tool || toolName}: ${evt.summary || summarizeTool(toolName, toolArgs)}`,
            shortId: sid,
          }).catch(() => {});
        } catch (_) {}
      }
    },
  });
  const approveTool = async (toolName, toolArgs) => {
    // Computer Use consent (Desktop `computer:request_access` /
    // `request_full_control`). Nothing touches the user's machine until a tier
    // has been granted, and a grant of `access` does not silently authorise
    // global shortcuts or launching apps. The model calls these as
    // `mcp__computer__screenshot`, so normalise to the executor name first —
    // matching only `/^computer_/` silently skipped every real call.
    const cuName = String(toolName || '').replace(/^mcp__computer__/, 'computer_');
    if (/^computer_/.test(cuName)) {
      const curMode = permissions || 'auto';
      if (curMode === 'auto' || curMode === 'bypass') {
        computer.setEnabled(true);
      } else {
        const st = computeruse.status();
        const sensitive = cuName === 'computer_open_app'
          || (cuName === 'computer_key' && /cmd|command|ctrl|control|alt|option/i.test(String((toolArgs || {}).keys || '')))
          || (cuName === 'computer_click' && (toolArgs || {}).button === 'right');
        const want = sensitive ? 'full_control' : 'access';
        if (!computeruse.satisfies(st.grant, want)) {
          const granted = await new Promise((resolve) => {
            const id = 'cu' + Date.now();
            let onAbort = null;
            pendingComputerUseRef.val = {
              id,
              resolve: (ok) => {
                if (onAbort && ac && ac.signal) {
                  try { ac.signal.removeEventListener('abort', onAbort); } catch (_) {}
                }
                resolve(ok);
              },
              tier: want,
            };
            if (ac && ac.signal) {
              if (ac.signal.aborted) {
                pendingComputerUseRef.val = null;
                return resolve(false);
              }
              onAbort = () => {
                if (pendingComputerUseRef.val && pendingComputerUseRef.val.id === id) {
                  pendingComputerUseRef.val = null;
                  resolve(false);
                }
              };
              ac.signal.addEventListener('abort', onAbort, { once: true });
            }
            send({ type: 'computerUseConsent', id, tier: want, tool: cuName, sensitive });
          });
          if (!granted) {
            send({ type: 'notice', text: 'Computer Use blocked — you did not grant screen access.' });
            return false;
          }
          computer.setEnabled(true);
        }
      }
    }
    const mode = permissions || 'auto';
    // settings.json `permissions.allow/deny/ask` rules run BEFORE the mode, the
    // way Claude Code evaluates them: deny always wins (even in bypass), ask
    // forces a prompt, allow skips it.
    try {
      const perms = require('./permissions').loadPermissions(runCwd);
      const lastUser = Array.isArray(messages) ? [...messages].reverse().find((m) => m && m.role === 'user') : null;
      const userPrompt = lastUser ? (typeof lastUser.content === 'string' ? lastUser.content : JSON.stringify(lastUser.content || '')) : '';
      const verdict = require('./permissions').decide(perms, toolName, toolArgs || {}, { cwd: runCwd, mode, userPrompt });
      if (verdict.decision === 'deny') {
        try { require('./audit-ledger').appendAuditEntry({ actor: 'policy', convId, action: toolName, decision: 'deny', detail: { reason: verdict.reason, rule: verdict.rule, handoff: !!verdict.handoff } }); } catch (_) {}
        send({ type: 'notice', text: `Blocked: ${toolName} — ${verdict.reason}` });
        return false;
      }
      if (verdict.decision === 'allow' && verdict.rule) return true;
      if (verdict.decision === 'ask' && verdict.rule) return await promptPermission(toolName, toolArgs);
    } catch (_) {}
    if (permGate.checkConversationAllow(convId, toolName, toolArgs || {}, runCwd)) return true;
    if (mode === 'auto' || mode === 'bypass') return true;
    if (mode === 'plan') return false;
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true;
    return await promptPermission(toolName, toolArgs);
  };

  // Bring up any `.mcp.json` / `~/.claude.json` servers declared for this
  // project before the turn starts, and expose their tools to the model.
  try {
    const before = new Set(extraTools.map((t) => t.name));
    await autoConnectMcp(runCwd);
    for (const sid of [...mcp.servers.keys()]) {
      const entry = mcp.servers.get(sid);
      for (const t of entry.fullTools || []) {
        const nm = `mcp__${sid}__${t.name}`;
        if (before.has(nm)) continue;
        extraTools.push({ name: nm, description: `[MCP ${entry.name}] ${t.description || ''}`, inputSchema: t.inputSchema });
      }
    }
  } catch (_) {}

  try {
    send({ type: 'cwd', dir: runCwd });
    const resolvedOrch = await orchReady;
    const finalMessages = await runAgent({
      provider,
      orchestrator: resolvedOrch,
      delegationOrchestrator: delegationOrchestrator || resolvedOrch || orchSource,
      messages,
      cwd: runCwd,
      useMemory,
      maxSteps,
      emit,
      extraTools,
      callMcpTool,
      signal: ac.signal,
      pauseController: pauseCtrl,
      shell: shells,
      askUser,
      exitPlanMode,
      mcpListResources,
      mcpReadResource,
      approveTool,
      // The 5-mode permission pill drives plan-mode enforcement inside the run
      // loop (read-only + plan file only), not just the approval prompts.
      permissionMode: permissions || 'auto',
      planFile: 'PLAN.md',
      // Checkpoints need the conversation id + a stable turn key so a rewind can
      // restore exactly the files this turn touched.
      convId,
      turnId,
      // This is the top-level user turn: it owns the token-budget pool.
      turnStart: true,
      // Built-in MCP client so `rea` shares the persistent REA server session.
      mcpClient: mcp,
      // Swarm is user-opted. Unless the renderer explicitly enabled it, the
      // `Swarm` tool is not offered to the model at all (multi-agent Task/Agent
      // still is). The roster it may use is frontier-only.
      swarm: swarm === true,
      hydrateProvider,
      oauthAccounts: (() => { try { return providerOauth.listAccounts(); } catch (_) { return []; } })(),
      autoRouterConfig: (() => {
        try {
          return require('./task-router').resolveAutoRouterConfig({
            settings: store.getSettings(),
            secretstore,
            orchestrator: delegationOrchestrator || resolvedOrch || orchSource,
            provider,
          });
        } catch (_) {
          return null;
        }
      })(),
    });
    send({ type: 'complete', messages: finalMessages });
    // Persist the project mindmap so a later model switch continues seamlessly.
    try { mindmap.updateFromRun(runCwd, { title, messages: finalMessages }); } catch (_) {}
    return { ok: true };
  } catch (e) {
    // User-initiated stop surfaces as a variety of abort messages depending on the
    // transport ("aborted", "This operation was aborted", AbortError, …).
    const aborted = ac.signal.aborted || e.name === 'AbortError' || /abort/i.test(String(e.message || ''));
    if (aborted) {
      send({ type: 'cancelled' });
      // Keep a partial mindmap (goal + "stopped mid-stream") so the next model
      // still has the project goal even though this turn was interrupted.
      try { mindmap.updateFromRun(runCwd, { title, messages, lastExchange: '(previous turn was stopped mid-stream by the user)' }); } catch (_) {}
      return { ok: false, cancelled: true };
    }
    // Never surface a raw gateway page ("LLM 502: <html>…") in the chat.
    const message = humanizeLLMError(e);
    send({ type: 'error', message });
    return { ok: false, error: message };
  } finally {
    const elapsedMs = Date.now() - runStartedMs;
    if (elapsedMs >= 30000) {
      try {
        require('./push-channels').sendPushAlert({
          kind: 'longRun',
          title: 'Akron Code · Long Run Complete',
          body: `${title || convId || 'Session'} finished in ${Math.round(elapsedMs / 1000)}s.`,
        }).catch(() => {});
      } catch (_) {}
    }
    permGate.clearRun(runId, 'run_ended');
    questionGate.clearRun(runId, send);
    runs.delete(runId);
    slog.close();
  }
});

ipcMain.handle('autobot:pause', async (event, runId) => {
  const entry = runs.get(runId);
  if (!entry || !entry.pauseCtrl) return { ok: false, error: 'run not active' };
  entry.pauseCtrl.pause();
  if (entry.send) entry.send({ type: 'paused', paused: true });
  return { ok: true, paused: true };
});

ipcMain.handle('autobot:resume', async (event, runId, steeringNote) => {
  const entry = runs.get(runId);
  if (!entry || !entry.pauseCtrl) return { ok: false, error: 'run not active' };
  const note = String(steeringNote || '').trim();
  entry.pauseCtrl.resume(note);
  if (entry.send) entry.send({ type: 'paused', paused: false, steeringNote: note });
  return { ok: true, paused: false };
});

ipcMain.handle('autobot:cancel', async (event, runId) => {
  permGate.clearRun(runId, 'cancelled');
  questionGate.clearRun(runId, broadcast);
  const entry = runs.get(runId);
  if (entry) {
    const ac = entry.ac || entry;
    if (ac && typeof ac.abort === 'function') ac.abort();
  }
  return { ok: true };
});

// Model-picker status: one cheap authenticated GET /models per provider endpoint.
ipcMain.handle('autobot:probeProviders', async (event, list) => {
  try {
    return await providerStatus.probeMany(list);
  } catch (e) {
    return { _error: e.message };
  }
});

// Local Ollama discovery: a local server only runs the models that were actually
// pulled, so the picker has to ask which ones exist instead of guessing.
ipcMain.handle('autobot:ollamaModels', async (event, baseURL, apiKey) => {
  try {
    return await providerStatus.ollamaModels(baseURL, { apiKey });
  } catch (e) {
    return { ok: false, base: '', via: '', models: [], detail: e.message };
  }
});

// Start/stop a local Ollama server on demand (the app ships no runtime of its own).
ipcMain.handle('autobot:ollamaServe', async (event, action) => {
  const { spawn } = require('child_process');
  try {
    if (action === 'stop') {
      const { execSync } = require('child_process');
      try { execSync('pkill -f "ollama serve"', { stdio: 'ignore' }); } catch (_) {}
      return { ok: true, running: false };
    }
    const probe = await providerStatus.ollamaModels('http://127.0.0.1:11434/v1', { timeout: 1200 });
    if (probe.ok) return { ok: true, running: true, alreadyRunning: true, ...probe };
    // A GUI-launched app often has a PATH without Homebrew or the Ollama bundle,
    // so look for the CLI in the usual places before giving up.
    const fs = require('fs');
    const os = require('os');
    const candidates = [
      process.env.OLLAMA_BIN,
      '/usr/local/bin/ollama',
      '/opt/homebrew/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
      path.join(os.homedir(), 'Applications/Ollama.app/Contents/Resources/ollama'),
      '/usr/bin/ollama',
    ].filter(Boolean);
    let bin = 'ollama';
    for (const c of candidates) {
      try { if (fs.existsSync(c)) { bin = c; break; } } catch (_) {}
    }
    const child = spawn(bin, ['serve'], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    // Give it a moment to bind the port before reporting.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const p = await providerStatus.ollamaModels('http://127.0.0.1:11434/v1', { timeout: 1200 });
      if (p.ok) return { ok: true, running: true, ...p };
    }
    return { ok: false, running: false, detail: 'Could not reach Ollama on :11434 — is the ollama CLI installed?' };
  } catch (e) {
    return { ok: false, running: false, detail: e.message };
  }
});

ipcMain.handle('autobot:testProvider', async (event, provider) => {
  try {
    // A subscription account is not an OpenAI-compatible gateway — test it
    // through the same wire adapter the agent loop will use.
    let p;
    try {
      p = normalizeProvider(await hydrateProvider(normalizeProvider(provider)));
    } catch (e) {
      return { ok: false, error: e.message, needsSignIn: e.code === 'provider_needs_signin' };
    }
    if (p.transport) {
      const msg = await providertransport.chatCompletion(p, [{ role: 'user', content: 'ping' }], [], () => {}, null, 16);
      const text = typeof msg.content === 'string'
        ? msg.content
        : (Array.isArray(msg.content) ? msg.content.map((x) => (x && x.text) || '').join('') : '');
      return { ok: true, reply: String(text || '').trim().slice(0, 200), model: p.model };
    }
    const url = p.baseURL + 'chat/completions';
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(p.apiKey ? { authorization: 'Bearer ' + p.apiKey } : {}) },
      body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 5, stream: false }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return { ok: true, reply: text.slice(0, 200) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// Anchored direct IPCs retained cleanly in main.js
ipcMain.handle('autobot:getMindmap', (e, cwd, mode) => {
  try {
    const dir = cwd ? path.resolve(String(cwd)) : '';
    const mmPath = dir ? path.join(dir, mindmap.FILENAME) : '';
    const exists = !!(mmPath && fs.existsSync(mmPath));
    return {
      ok: true,
      cwd: dir,
      path: mmPath,
      exists,
      markdown: mindmap.buildWorkspaceMarkdown(dir, mode || 'auto'),
    };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), markdown: '# Mind Map\n- Error reading workspace' };
  }
});
ipcMain.handle('autobot:notify', (_e, payload) => notificationService.notify(payload || {}));
ipcMain.handle('autobot:browserInspectSet', (e, webContentsId, enabled) => browser.setInspectMode(webContentsId, enabled));
ipcMain.handle('autobot:browserCaptureElement', (e, webContentsId, rect) => browser.captureElementRect(webContentsId, rect));
ipcMain.handle('autobot:browserToggleDevTools', (e, webContentsId) => browser.toggleDevTools(webContentsId));
ipcMain.handle('autobot:getLegalDocs', () => {
  const root = path.join(__dirname, '..');
  const readDoc = (name) => {
    try {
      const p = path.join(root, name);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    } catch (_) {
      return '';
    }
  };
  return {
    ok: true,
    license: readDoc('LICENSE.md'),
    trademarks: readDoc('TRADEMARKS.md'),
    copyright: 'Copyright (c) 2026 AkronLogic (https://akronlogic.com). All rights reserved.',
  };
});
ipcMain.handle('autobot:openLegalDoc', (_e, which) => {
  const file = which === 'trademarks' ? 'TRADEMARKS.md' : 'LICENSE.md';
  const p = path.join(__dirname, '..', file);
  if (!fs.existsSync(p)) return { ok: false, error: `${file} not found` };
  shell.openPath(p);
  return { ok: true, path: p };
});

registerFeaturesIpc({ app, ipcMain, shell, dialog, BrowserWindow, session, store, workspace, mcp, mcpStatus, shells, git, pluginsDir, scheduler, sandbox, secretstore, search, sessionDb, environments, depManager, updater, browser, gdrive, runAgent, providertransport, permGate, questionGate, pendingQuestions, windows, winFor, cwdFor, winTitleBarOverlay, applyFeatures, runtimePathPrefix, hydrateProvider, freellmFallbackApiKey, broadcast, mainWindow, oneLine, humanizeLLMError, rea, mcpoauth, freellm, poolNoticeDeduper, sessionlog, paths, describeConnectError });

app.whenReady().then(() => {
  try { secretstore.migrateLegacySafeStorage(); } catch (_) {}
  if (process.platform === 'darwin' && !app.isPackaged && app.dock && typeof app.dock.setIcon === 'function') {
    try {
      const dockIconPath = resolveNotificationIconPath({ isPackaged: false });
      if (dockIconPath) {
        const dockImg = nativeImage.createFromPath(dockIconPath);
        if (dockImg && !dockImg.isEmpty()) app.dock.setIcon(dockImg);
      }
    } catch (_) {}
  }
  app.on('browser-window-focus', (_e, win) => {
    notificationService.clearAttention(win);
  });
  try {
    const updateScheduler = updater.createUpdateScheduler({
      getOptions: () => {
        const s = store.getSettings() || {};
        return { currentVersion: app.getVersion(), channel: s.updateChannel || 'stable' };
      },
      onUpdateAvailable: (res) => {
        notificationService.notify({
          kind: 'agent',
          title: `Akron Code v${res.latestVersion} available`,
          body: 'Open Settings → Runtimes & Updates to install.',
        });
      },
    });
    if ((store.getSettings() || {}).autoUpdateScheduler !== false) {
      updateScheduler.start();
    }
  } catch (_) {}
  // Repair any project folder split left by the old auto-create logic (files in
  // `project/` while the conversation points at a titled-but-empty folder).
  try { workspace.reconcile(); } catch (e) { console.error('workspace reconcile failed:', e.message); }
  // Hosted extension pages that Electron cannot load natively are served from
  // this scheme by the ExtensionHost (traversal + web_accessible rules apply).
  try {
    protocol.handle('helio-extension', (req) => {
      const res = extHost.servePage(req.url);
      if (!res || !res.ok) {
        return new Response(String((res && (res.error || res.message)) || 'Not found'), {
          status: (res && res.status) || 404,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      return new Response(res.body, {
        status: 200,
        headers: { 'content-type': res.mime || 'application/octet-stream' },
      });
    });
  } catch (e) {
    console.error('helio-extension scheme unavailable:', e.message);
  }
  // Grant microphone permissions for built-in voice typing (ONNX Whisper).
  try {
    const isLocalOrigin = (url) => !url || /^file:|^http:\/\/(127\.0\.0\.1|localhost)\b/i.test(String(url));
    session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => {
      if ((perm === 'media' || perm === 'audioCapture' || perm === 'microphone') && isLocalOrigin(origin)) return true;
      return true;
    });
    session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => {
      if (perm === 'media' || perm === 'audioCapture' || perm === 'microphone') {
        return cb(isLocalOrigin(wc && wc.getURL ? wc.getURL() : ''));
      }
      cb(true);
    });
  } catch (_) {}

  // Loopback WebSocket bridge for a real Chrome extension (Desktop parity).
  extHost.startBridge().then((r) => {
    if (!r || !r.ok) console.error('extension bridge unavailable:', (r && r.error) || 'unknown');
  }).catch((e) => console.error('extension bridge failed:', e.message));

  // Akron Browser Bot Desktop Bridge (ws://127.0.0.1:8766 + zero-key /v1 proxy).
  try {
    const extbridge = require('./extbridge');
    const injectFreeLlmKey = (row) => {
      if (!row || typeof row !== 'object') return row;
      if (!row.apiKey && /:(3001|31415)\b/.test(String(row.baseURL || ''))) {
        const fb = freellmFallbackApiKey();
        if (fb) return { ...row, apiKey: fb };
        try {
          const c = freellm.loadConfig ? freellm.loadConfig() : null;
          if (c && c.token) return { ...row, apiKey: c.token };
        } catch (_) {}
      }
      return row;
    };
    const getHydratedProvider = async () => {
      const s = store.getSettings() || {};
      let p = s.provider || {};
      if (p.oauthProvider) {
        try { p = await hydrateProvider(p); } catch (_) {}
      }
      return injectFreeLlmKey(p);
    };
    const getHydratedOrch = async () => {
      const orch = store.getOrchestrator() || {};
      const rows = Array.isArray(orch.providers) ? await Promise.all(orch.providers.map(async (r) => {
        if (r && r.oauthProvider) { try { return await hydrateProvider(r); } catch (_) { return r; } }
        return injectFreeLlmKey(r);
      })) : [];
      return { ...orch, providers: rows };
    };
    const getExtraProviders = async () => {
      const extras = [];
      // 1. All signed-in OAuth accounts + their full static/live catalogs
      try {
        const accts = providerOauth.listAccounts ? providerOauth.listAccounts() : [];
        const liveSnap = modelCatalog.snapshot ? modelCatalog.snapshot() : {};
        for (const a of accts) {
          if (!a || a.needsSignIn || a.expired) continue;
          try {
            const hydrated = await hydrateProvider({ oauthProvider: a.id, id: a.provider, name: a.label });
            const pv = providerOauth.provider ? providerOauth.provider(a.provider) : null;
            const liveList = Array.isArray(liveSnap[a.provider]) ? liveSnap[a.provider].map((m) => m.id) : [];
            const staticList = pv && Array.isArray(pv.models) ? pv.models.map((m) => m.id) : [];
            const catalogModels = [...new Set([...liveList, ...staticList].filter(Boolean))];
            if (!hydrated.model && catalogModels.length) hydrated.model = catalogModels[0];
            hydrated.catalogModels = catalogModels;
            extras.push(hydrated);
          } catch (_) {}
        }
      } catch (_) {}
      // 2. Local FreeLLMAPI gateway (127.0.0.1:3001/v1 or external :31415 Unified Router)
      try {
        const cfg = freellm.loadConfig ? freellm.loadConfig() : null;
        const fbKey = freellmFallbackApiKey();
        const extHealth = typeof freellm.probeExternalHealth === 'function'
          ? await freellm.probeExternalHealth(cfg || {}, {}).catch(() => null)
          : null;
        const routerBase = extHealth || 'http://127.0.0.1:3001/v1';
        const routerKey = fbKey || (cfg && cfg.token) || '';
        if (routerKey && ((cfg && cfg.token) || extHealth)) {
          const aliasKeys = freellm.ALIASES ? Object.keys(freellm.ALIASES) : [];
          let liveModels = [];
          if (extHealth && typeof freellm.probeExternalModels === 'function') {
            const extRes = await freellm.probeExternalModels(cfg || {}, { authorization: 'Bearer ' + routerKey }, { timeoutMs: 2500 }).catch(() => null);
            if (extRes && extRes.json && Array.isArray(extRes.json.data)) liveModels = extRes.json.data;
          } else if (freellm.listModels && cfg) {
            liveModels = await Promise.resolve(freellm.listModels(cfg)).catch(() => []);
          }
          const cleanLive = liveModels
            .map((m) => (typeof m === 'string' ? m : m && m.id))
            .map((id) => String(id || '').trim())
            .filter((id) => id && !id.startsWith('[') && !/\s/.test(id) && /^(qwen|deepseek|nemotron|mistral|devstral|gpt-oss|kimi|glm|llama|auto|fusion|claude)/i.test(id))
            .slice(0, 40);
          const catalogModels = [...new Set([...aliasKeys, ...cleanLive].filter(Boolean))];
          extras.push({
            id: 'freellmapi',
            name: 'FreeLLMAPI Pool',
            baseURL: routerBase,
            apiKey: routerKey,
            model: catalogModels[0] || 'auto',
            catalogModels,
            supportsTools: true,
          });
        }
      } catch (_) {}
      return extras;
    };
    extbridge.start({ getProvider: getHydratedProvider, getOrchestrator: getHydratedOrch, getExtraProviders }).then((r) => {
      if (!r || !r.ok) console.error('akron-browser-bot bridge unavailable:', (r && r.error) || 'unknown');
    }).catch(() => {});
  } catch (_) {}
  applyFeatures(store.getFeatures());
  try {
    ideIpc.register({ ipcMain, normalizeProvider, hydrateProvider, hydrateOrchestrator, store, broadcast });
  } catch (e) {
    console.error('ideIpc register failed:', e.message);
  }
  // Re-assert the login item on boot so a moved/reinstalled app keeps working
  // (macOS stores the path, and it changes between dev and packaged builds).
  try {
    const s = store.getSettings();
    if (typeof s.launchAtLogin === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: s.launchAtLogin });
    }
  } catch (err) { console.error('login item restore failed:', err.message); }
  buildMenu();
  createTray();
  registerProtocol();
  // A `helio://` link passed as an argv on a cold start (Windows/Linux, or a
  // first macOS launch before open-url is registered) becomes the pending link.
  const bootLink = (process.argv || []).find(isDeepLink);
  if (bootLink) pendingDeepLink = bootLink;
  const brandRes = brandGuard.verifyBrandIntegrity();
  if (!brandRes.ok) {
    console.error('[brand-guard] Integrity verification failed:', brandRes.problems);
    if (app.isPackaged || process.env.AKRON_ENFORCE_BRAND_SEAL === '1') {
      if (process.env.AKRON_NO_DIALOG !== '1') {
        dialog.showErrorBox('Akron Code Integrity Error', 'Akron Code brand & asset verification failed:\n' + brandRes.problems.join('\n'));
      }
      app.exit(78);
      return;
    }
  }
  createWindow();
  // Start the scheduled-task ticker (fires tasks due on their cadence and
  // notifies every window so the Scheduled panel can refresh).
  try {
    scheduler.start(runScheduledPrompt, (evt) => broadcast({ type: 'scheduled-task', ...evt }), {
      resolveFastProvider: runtimesCtrl ? runtimesCtrl.resolveFastProviderForGate : undefined,
    });
  } catch (e) {
    console.error('scheduler start failed:', e.message);
  }
  // FreeLLMAPI: aggregate every configured free-tier key behind one
  // OpenAI-compatible endpoint. Non-fatal — a missing config or a busy port must
  // never stop the app from booting.
  startFreeLLM();
  // Bundled agent runtimes: PATH injection first (so the Bash tool works
  // immediately), then a deferred auto-update pass.
  startRuntimes();
  // A Claude rotation interrupted mid-flight leaves the CLI holding a refresh
  // token we already consumed. Finish the write-back before anything can spend
  // it again, so the user does not have to send a turn to repair their sign-in.
  replayClaudeRotation();
  // Warm the per-model context-window catalogs so a prompt sent in the first
  // seconds after launch is compacted against the model's real window instead
  // of a documented default (a live 16K model would otherwise be sent 128K of
  // history). Deferred past first paint and best-effort.
  {
    const t = setTimeout(() => { warmModelCatalogs().catch(() => {}); }, 3000);
    if (t && typeof t.unref === 'function') t.unref();
  }
  // Warm built-in REA (morluto/rea) MCP server non-blockingly so all 263
  // reverse-engineering tools are ready before the first turn.
  {
    const tRea = setTimeout(() => {
      try {
        if (!(store.getFeatures() || {}).reaDisabled) {
          rea.ensureConnected(mcp, { userDataDir: app.getPath('userData') }).catch(() => {});
        }
      } catch (_) {}
    }, 1200);
    if (tRea && typeof tRea.unref === 'function') tRea.unref();
  }
  app.on('web-contents-created', (_e, contents) => {
    try { attachContextMenu(contents); } catch (_) {}
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let ptyQuitDrained = false;
app.on('before-quit', (e) => {
  if (ptyQuitDrained) return;
  try {
    if (ideIpc.hasActivePtys && ideIpc.hasActivePtys()) {
      e.preventDefault();
      ptyQuitDrained = true;
      Promise.resolve(ideIpc.cleanup())
        .catch(() => {})
        .finally(() => { app.quit(); });
    }
  } catch (_) {
    ptyQuitDrained = true;
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { ideIpc.cleanup(); } catch (_) {}
  try { environments.toggleHostServer(false).catch(() => {}); } catch (_) {}
  try { scheduler.stop(); } catch (_) {}
  try { extHost.stopBridge(); } catch (_) {}
  try { require('./extbridge').stop(); } catch (_) {}
  try { runtimesCtrl.stopFreeLLM(); } catch (_) {}
});

app.on('window-all-closed', () => {
  mcp.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});
