'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, globalShortcut, nativeImage, protocol, session, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
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
let nextQuestionId = 1;

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
  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 3) consoleErrors.push(String(message || ''));
  });
  if (app.isPackaged) {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key || '').toLowerCase();
      const isInspect = key === 'f12' || ((input.control || input.meta) && (input.shift || input.alt) && key === 'i');
      if (isInspect) event.preventDefault();
    });
  }
  win.webContents.once('did-finish-load', async () => {
    flushDeepLink(win);
    try {
      const domRes = await win.webContents.executeJavaScript(brandGuard.verifyRendererDomScript());
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

// ---------- Secondary windows (Claude Desktop parity) ----------

// Akron Bot brand mark — emerald symbiote sunburst. This is the animated
// version for About / splash, which live in their own `data:` documents so the
// class names and keyframes cannot collide with anything else. The renderer's
// <Logo/> (src/App.jsx) draws the same geometry.
const MARK_RAYS = [
  [191, 76, 18, 96, 9, 0], [192, 88, 16, 84, 8, 32], [190, 72, 20, 102, 10, 64],
  [192, 92, 16, 80, 8, 95], [191, 74, 18, 98, 9, 128], [192, 86, 16, 86, 8, 158],
  [190, 75, 20, 98, 10, 188], [192, 90, 16, 82, 8, 218], [191, 70, 18, 104, 9, 248],
  [192, 88, 16, 84, 8, 278], [190, 76, 20, 96, 10, 306], [192, 92, 16, 80, 8, 334],
];
const MARK_ORBS = [[200, 84, 13], [304, 245, 12], [102, 252, 11], [278, 112, 10], [118, 118, 12], [200, 316, 13]];
const MARK_GLOW = [[0, 96, 58], [64, 94, 62], [128, 96, 58], [188, 94, 62], [248, 92, 64], [306, 96, 58]];

function logoMarkup(size, opts) {
  const animate = !(opts && opts.static);
  const rects = MARK_RAYS.map(([x, y, w, h, rx, d]) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" transform="rotate(${d} 200 200)"/>`).join('');
  const orbs = MARK_ORBS.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}"/>`).join('');
  const glow = MARK_GLOW.map(([d, y, h]) =>
    `<rect x="197" y="${y}" width="6" height="${h}" rx="3" transform="rotate(${d} 200 200)"/>`).join('');
  const css = animate ? `<style>
.akm-spin{transform-origin:200px 200px;animation:akmSpin 12s ease-in-out infinite}
.akm-breathe{transform-origin:200px 200px;animation:akmBreathe 3s ease-in-out infinite alternate}
@keyframes akmSpin{0%{transform:rotate(0deg) scale(.97)}50%{transform:rotate(180deg) scale(1.04)}100%{transform:rotate(360deg) scale(.97)}}
@keyframes akmBreathe{0%{transform:scale(.94)}100%{transform:scale(1.06)}}
@media (prefers-reduced-motion:reduce){.akm-spin,.akm-breathe{animation:none}}
</style>` : '';
  return `<svg width="${size}" height="${size}" viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Akron Code">${css}<defs><filter id="akGoo" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur"/><feColorMatrix in="blur" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 22 -9" result="goo"/><feComposite in="SourceGraphic" in2="goo" operator="atop"/></filter></defs>
<g class="akm-spin"><g filter="url(#akGoo)"><g fill="#10B981"><circle cx="200" cy="200" r="34"/>${rects}${orbs}</g></g>
<g opacity="0.55" fill="#A7F3D0" class="akm-breathe"><circle cx="200" cy="200" r="14"/>${glow}</g></g></svg>`;
}

// Find the primary (chat) window to focus / route commands into.
function mainWindow() {
  for (const w of windows) if (w && !w.isDestroyed()) return w;
  return null;
}

// Custom About window (replaces the stock { role: 'about' } panel).
function createAboutWindow() {
  const existing = BrowserWindow.getAllWindows().find((w) => w.aboutWindow);
  if (existing) { existing.show(); existing.focus(); return existing; }
  const win = new BrowserWindow({
    width: 340,
    height: 420,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'About Akron Code',
    ...windowIconProps(),
    backgroundColor: '#30302e',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' } : { autoHideMenuBar: true }),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  if (process.platform !== 'darwin') {
    try { win.setMenuBarVisibility(false); } catch (_) {}
  }
  win.aboutWindow = true;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f4f0;background:#30302e;-webkit-user-select:none;user-select:none}
    .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:28px 24px;box-sizing:border-box;text-align:center}
    .logo{filter:drop-shadow(0 0 18px rgba(16,185,129,.4));margin-bottom:14px}
    h1{font-size:19px;margin:0 0 2px;font-weight:650}
    .sub{font-size:12px;color:#b8b5ae;margin:0 0 20px}
    .ver{font-size:11px;color:#8d8a84;background:#3a3936;border-radius:6px;padding:3px 9px;margin-bottom:18px}
    .row{font-size:12.5px;color:#d6d3cc;line-height:1.65}
    a{color:#10b981;text-decoration:none}
    .foot{margin-top:auto;font-size:10.5px;color:#8d8a84}
  </style></head><body><div class="wrap">
    <div class="logo">${logoMarkup(72)}</div>
    <h1>Akron Code</h1>
    <p class="sub">by Akronlogic.com</p>
    <span class="ver">Version ${app.getVersion()}</span>
    <div class="row">Autonomous coding IDE.<br>Multi-agent &amp; MCP–compatible.<br>Electron ${process.versions.electron}</div>
    <div class="foot">
      <a href="https://akronlogic.com" target="_blank">akronlogic.com</a> ·
      <a href="https://akron-legal.local/license" target="_blank">License</a> ·
      <a href="https://akron-legal.local/trademarks" target="_blank">Trademarks</a>
    </div>
  </div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://akron-legal.local/license') {
      const lp = path.join(__dirname, '..', 'LICENSE.md');
      if (fs.existsSync(lp)) shell.openPath(lp);
      return { action: 'deny' };
    }
    if (url === 'https://akron-legal.local/trademarks') {
      const tp = path.join(__dirname, '..', 'TRADEMARKS.md');
      if (fs.existsSync(tp)) shell.openPath(tp);
      return { action: 'deny' };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

// Quick Entry window (menu-bar + global-hotkey): a floating prompt that routes
// straight into the main chat composer (or submits immediately with ⇧↩).
function createQuickWindow() {
  if (quickWin && !quickWin.isDestroyed()) { quickWin.show(); quickWin.focus(); return quickWin; }
  const { screen } = require('electron');
  const cursor = screen.getCursorScreenPoint();
  const disp = screen.getDisplayNearestPoint(cursor);
  const wa = disp.workArea;
  const W = 520, H = 150;
  const x = Math.round(wa.x + (wa.width - W) / 2);
  const y = Math.round(wa.y + wa.height * 0.18);
  quickWin = new BrowserWindow({
    width: W, height: H, x, y,
    frame: false, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, show: false,
    backgroundColor: '#30302e',
    ...windowIconProps(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  quickWin.loadFile(path.join(__dirname, 'quick.html'));
  quickWin.once('ready-to-show', () => { quickWin.show(); quickWin.focus(); });
  quickWin.on('blur', () => { if (quickWin && !quickWin.isDestroyed() && !quickWin._pinned) quickWin.hide(); });
  quickWin.on('closed', () => { quickWin = null; });
  return quickWin;
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
function htmlTitle(html) {
  const raw = (String(html || '').match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  return raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
}

function artifactDocument({ name, language, content, edits }) {
  const lang = String(language || '').toLowerCase();
  const canvas = artifactcanvas.isCanvas(lang);
  const key = canvas ? artifactstore.keyFor(lang, content) : '';
  const resolved = canvas ? (edits !== undefined ? edits : artifactstore.get(key)) : undefined;
  const doc = artifactcanvas.canvasHtml(lang, name, content, resolved, { key });
  // Frame type manifests carry an emoji favicon (🎨 Design / 📽️ Slides) — put it
  // in the document head so the artifact window's tab strip matches Desktop.
  const favicon = artifacttypes.faviconDataUri(lang);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  // The canvas builders derive a title from the parsed content; resolve that and
  // the caller's name through one rule so a window's tab and its document never
  // disagree ("Design — Design" when the caller only knows the frame type).
  const title = artifacttypes.documentTitle(lang, name, doc ? htmlTitle(doc) : '');
  const withFavicon = (html) => (favicon ? String(html).replace('<meta charset="utf-8">', '<meta charset="utf-8"><link rel="icon" href="' + favicon + '">') : html);
  const withTitle = (html) => String(html).replace(/<title>[\s\S]*?<\/title>/, '<title>' + esc(title) + '</title>');
  if (doc) return withTitle(withFavicon(doc));
  const safe = String(content || '');
  const body = lang === 'html' || lang === 'htm' || lang === 'svg'
    ? safe // render directly (trusted: generated by the model, sandboxed window)
    : `<pre style="margin:0;padding:20px;font:13px/1.5 ui-monospace,Menlo,monospace;color:#e8e6df;white-space:pre-wrap;word-break:break-word">${esc(safe)}</pre>`;
  const head = '<meta charset="utf-8">' + (favicon ? '<link rel="icon" href="' + favicon + '">' : '');
  return `<!doctype html><html><head>${head}<title>${esc(title)}</title>
  <style>html,body{margin:0;min-height:100%;background:#1e1f1c;color:#e8e6df;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}</style>
  </head><body>${body}</body></html>`;
}

// The context a type manifest resolves its capabilities against: local flag
// overrides from settings, the connected MCP servers (so `capabilities.mcp`
// reports whether "Save to Drive" can work right now), and the local profile.
function artifactTypeContext(extra) {
  const settings = store.getSettings() || {};
  const installed = [];
  try {
    for (const [id, entry] of mcp.servers) {
      installed.push({ id, name: (entry && entry.name) || '', tools: (entry && entry.tools) || [] });
    }
  } catch (_) { /* MCP not started yet */ }
  return {
    flags: settings.flags && typeof settings.flags === 'object' ? settings.flags : {},
    installed,
    profile: extra && extra.profile && typeof extra.profile === 'object' ? extra.profile : null,
  };
}

function createArtifactWindow(payload) {
  const { name, language } = payload || {};
  const canvas = artifactcanvas.isCanvas(language);
  const key = canvas ? artifactstore.keyFor(String(language || '').toLowerCase(), (payload || {}).content) : '';
  // Build first: the document already resolved the one title rule, and the tab
  // strip must show exactly what the document shows.
  const html = artifactDocument(payload || {});
  const win = new BrowserWindow({
    width: canvas ? 1180 : 960, height: canvas ? 800 : 700, minWidth: 520, minHeight: 360,
    title: htmlTitle(html) || artifacttypes.windowTitle(language, name), backgroundColor: '#1e1f1c',
    ...windowIconProps(),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      // The bridge is only meaningful for canvas documents; plain code/SVG
      // artifacts get no preload so their content keeps zero privileges.
      preload: key ? path.join(__dirname, 'artifact-preload.js') : undefined,
      additionalArguments: key ? [`--helio-artifact-key=${key}`] : [],
    },
  });
  if (key) {
    if (!artifactWindows.has(key)) artifactWindows.set(key, new Set());
    artifactWindows.get(key).add(win);
    win.on('closed', () => {
      const set = artifactWindows.get(key);
      if (set) { set.delete(win); if (!set.size) artifactWindows.delete(key); }
    });
  }
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return { ok: true, windowId: win.id, key };
}

// Every surface showing a canvas artifact (in-chat preview, artifacts list,
// other artifact windows) refetches when its slot changes. `skipId` is the
// webContents that made the change — it is already up to date.
function broadcastArtifactSaved(key, skipId) {
  for (const w of windows) {
    if (!w.isDestroyed() && w.webContents.id !== skipId) w.webContents.send('autobot:artifactSaved', { key });
  }
  const viewers = artifactWindows.get(key);
  if (viewers) {
    for (const w of viewers) {
      if (!w.isDestroyed() && w.webContents.id !== skipId) w.webContents.send('autobot:artifactSaved', { key });
    }
  }
}

// ---------- Hosted Chrome extensions (Claude Desktop extension-host parity) ----------
//
// Three moving parts, mirroring Desktop:
//   1. `ExtensionHost` (electron/extensionhost.js) answers the 11
//      `extension-host:*` channels for any guest page.
//   2. `helio-extension://` serves shipped files when Electron refuses to load
//      the extension natively (see the preload shim for that case).
//   3. `session.loadExtension` gives a genuine `chrome-extension://` origin and
//      the real Chromium API surface whenever the manifest is loadable.
const EXT_PARTITION = 'persist:helio-extensions';
const extHost = extensionhost.createExtensionHost();
let extSession = null;
const nativeExtensionIds = new Map(); // folder id -> Chromium extension id

function extensionsSession() {
  if (!extSession) extSession = session.fromPartition(EXT_PARTITION);
  return extSession;
}

async function loadNativeExtension(extensionId) {
  if (nativeExtensionIds.has(extensionId)) return { ok: true, chromiumId: nativeExtensionIds.get(extensionId) };
  const dir = extHost.extensionDir(extensionId);
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: 'Extension is not installed' };
  try {
    const loaded = await extensionsSession().loadExtension(dir, { allowFileAccess: true });
    nativeExtensionIds.set(extensionId, loaded.id);
    return { ok: true, chromiumId: loaded.id };
  } catch (e) {
    return { ok: false, error: extensionhost.sanitizeError(e) };
  }
}

function defaultExtensionPage(manifest) {
  const m = manifest || {};
  if (m.action && m.action.default_popup) return String(m.action.default_popup);
  if (m.browser_action && m.browser_action.default_popup) return String(m.browser_action.default_popup);
  if (m.options_page) return String(m.options_page);
  if (m.options_ui && m.options_ui.page) return String(m.options_ui.page);
  return 'index.html';
}

function listExtensions() {
  extHost.scan();
  const rows = [];
  for (const [id, entry] of extHost.extensions) {
    const m = entry.manifest || {};
    rows.push({
      id,
      name: String(m.name || id),
      version: String(m.version || '0.0.0'),
      description: String(m.description || ''),
      manifestVersion: Number(m.manifest_version) || 2,
      hasBackground: !!m.background,
      permissions: Array.isArray(m.permissions) ? m.permissions.slice() : [],
      defaultPage: defaultExtensionPage(m),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

async function createExtensionWindow(payload = {}) {
  const id = extensionhost.normalizeExtensionId(payload.extensionId);
  if (!id) return { ok: false, message: 'Invalid extension id' };
  extHost.scan();
  const info = extHost.installed(id);
  if (!info.ok) return { ok: false, message: info.message || info.error || 'Extension is not installed' };
  const page = extensionhost.safeExtensionPath(payload.path || defaultExtensionPage(info.manifest));
  if (!page) return { ok: false, message: 'Invalid page path' };

  const loaded = await loadNativeExtension(id);
  const webPreferences = {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    partition: EXT_PARTITION,
    // Always attach the shim: native pages keep Chromium's bindings and get the
    // missing ones (chrome.storage.sync, notifications, …) filled in; hosted
    // pages get the whole surface built for them.
    preload: path.join(__dirname, 'extension-preload.js'),
    additionalArguments: [`--helio-extension-id=${id}`],
  };
  let url;
  if (loaded.ok) {
    url = `chrome-extension://${loaded.chromiumId}/${page}`;
    webPreferences.additionalArguments.push('--helio-native=1');
  } else {
    url = `helio-extension://${id}/${page}`;
  }

  const width = Number(payload.width);
  const height = Number(payload.height);
  const win = new BrowserWindow({
    width: width > 200 ? width : 460,
    height: height > 200 ? height : 620,
    title: info.name || 'Extension',
    backgroundColor: '#1e1f1c',
    ...windowIconProps(),
    webPreferences,
  });
  extensionWindows.set(win.id, id);
  win.on('closed', () => {
    extensionWindows.delete(win.id);
    try { extHost.detachSink(win.webContents); } catch (_) {}
  });
  win.webContents.setWindowOpenHandler(({ url: target }) => { shell.openExternal(target); return { action: 'deny' }; });
  // A blocked scheme or missing file must not leave Chromium's error page in
  // the app: report it once, one line, and let the UI decide.
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    if (code === -3) return; // ERR_ABORTED (superseded navigation)
    broadcast({ type: 'extension-window-error', extensionId: id, error: `${desc || 'load failed'} (${code})` });
  });
  try {
    await win.loadURL(url);
  } catch (e) {
    try { win.destroy(); } catch (_) {}
    return { ok: false, message: extensionhost.sanitizeError(e) };
  }
  return { ok: true, windowId: win.id, url, page, native: loaded.ok === true };
}

// Print-to-PDF (Example's "Design / print frame to PDF" surface): render HTML or
// plain text to a PDF via the user's save dialog.
async function printToPdf(event, { defaultName, html, content, language }) {
  try {
    const w = winFor(event);
    const r = await dialog.showSaveDialog(w, {
      title: 'Export PDF',
      defaultPath: defaultName || 'export.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: true, path: null };
    const canvasDoc = artifactcanvas.canvasHtml(language, defaultName, content);
    const source = html || canvasDoc || `<html><body><pre style="font:12px/1.5 monospace;white-space:pre-wrap">${String(content || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre></body></html>`;
    const pw = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    await pw.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(source));
    const data = await pw.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    fs.writeFileSync(r.filePath, data);
    pw.destroy();
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------- IPC ----------
// Apply feature toggles (computer use / chrome / bridges / developer) to the runtime.
function applyFeatures(features) {
  features = features || store.getFeatures();
  computer.setEnabled(!!features.computerUse);
  chrome.configure({ host: features.chromeHost || '127.0.0.1', port: features.chromePort || 9222 });
  // Quick Entry global hotkey is gated by the feature toggle.
  registerQuickShortcuts(!!features.quickEntry);
}

/**
 * Turn a renderer-side provider into one the wire adapters can actually call.
 *
 * The renderer only ever holds `oauthProvider: 'claude:<account>'` — never a
 * token. Resolving it here keeps the bearer token in the main process, mints a
 * fresh one lazily before each turn, and means a long-running session survives
 * token expiry without the user re-signing-in.
 */
function freellmFallbackApiKey() {
  try {
    const s = store.getSettings() || {};
    const p = s.provider || {};
    if (p.apiKey && /localhost:(3001|31415)\b|127\.0\.0\.1:(3001|31415)\b/i.test(String(p.baseURL || ''))) {
      return String(p.apiKey).trim();
    }
    const keys = s.providerKeys || {};
    for (const u of ['http://127.0.0.1:31415/v1', 'http://localhost:31415/v1', 'http://localhost:3001/v1', 'http://127.0.0.1:3001/v1']) {
      if (keys[u] && String(keys[u]).trim()) return String(keys[u]).trim();
    }
  } catch (_) {}
  return '';
}

function hydrateLocalFreeLlmProvider(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  if (provider.oauthProvider || provider.transport) return provider;
  const base = String(provider.baseURL || '');
  if (!/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) return provider;
  if (provider.apiKey && String(provider.apiKey).trim()) return provider;
  const fallback = freellmFallbackApiKey();
  if (fallback) return { ...provider, apiKey: fallback };
  try {
    const c = freellm.loadConfig ? freellm.loadConfig() : null;
    if (c && c.token) return { ...provider, apiKey: c.token };
  } catch (_) {}
  return provider;
}

async function hydrateProvider(provider) {
  provider = hydrateLocalFreeLlmProvider(provider);
  if (!provider || typeof provider !== 'object' || !provider.oauthProvider) return provider;
  let r;
  try {
    r = await providerOauth.resolve(String(provider.oauthProvider));
  } catch (e) {
    // A dead refresh token is a sign-in problem, not an LLM failure. Surface one
    // human line instead of an OAuth error code the composer can't act on.
    const prov = providerOauth.provider(String(provider.oauthProvider).split(':')[0]);
    const label = (prov && prov.label) || 'This provider';
    const err = new Error(`${label} needs to be signed in again — open the model menu and choose Sign in.`);
    err.code = 'provider_needs_signin';
    err.human = true;
    err.cause = e;
    throw err;
  }
  const out = Object.assign({}, provider, {
    // Native transport wins over any OpenAI-compatible baseURL the renderer had.
    transport: r.transport,
    accessToken: r.accessToken,
    account: r.account,
    // `chatgpt-account-id` is mandatory on the Codex responses endpoint; without
    // it the request is rejected even with a perfectly valid bearer token.
    accountId: r.accountId || provider.accountId || '',
    codexUrl: r.codexUrl || provider.codexUrl || '',
    cloudcodeUrl: r.cloudcodeUrl || provider.cloudcodeUrl || '',
    oauth: true,
    model: provider.model || (r.models && r.models[0] && r.models[0].id) || '',
  });
  // Providers with no bespoke wire adapter are plain OpenAI-compatible bearers
  // (xAI/Grok today). Hand the token over as the key so the ordinary
  // `{baseURL}/chat/completions` path uses it, and clear `transport` so
  // nothing tries to find an adapter that doesn't exist.
  if (!providertransport.needsTransport({ transport: r.transport })) {
    out.transport = '';
    out.apiKey = r.accessToken;
    out.baseURL = r.baseURL || provider.baseURL || '';
    out.supportsTools = true;
  }
  return out;
}

// ---- Orchestrator pool validation -----------------------------------------
// A saved pool row asserts "<this gateway> serves <this model>". Nothing used to
// check that, so a stale row pointed at Ollama (localhost:11434) asking for
// `claude-fable-5-2` produced
//
//   The provider says that model or endpoint does not exist —
//   model 'claude-fable-5-2' not found
//
// which reads like a dead Claude subscription and was a local model server
// answering honestly. Ask each anonymous row's gateway for its catalogue before
// the turn and leave out only the rows that gateway itself disowned. A gateway
// we cannot ask (down, 401, empty catalogue) leaves its row alone: the app
// never invents a failure it did not observe. Subscription rows have no
// anonymous endpoint and are never probed.
async function validateOrchestrator(orch, emit) {
  if (!orch || !Array.isArray(orch.providers) || !orch.providers.length) {
    poolNoticeDeduper.shouldEmitPruned('');
    return orch;
  }
  let res;
  try {
    res = await orchPool.pruneUnserved(orch.providers, { timeoutMs: 2500 });
  } catch (_) {
    return orch; // validation must never cost a turn
  }
  if (!res || !res.dropped.length) {
    poolNoticeDeduper.shouldEmitPruned('');
    return orch;
  }
  // Re-anchor the active row by identity so pruning an entry above it does not
  // silently switch the pool to a different model.
  const prevActive = Math.max(0, Number(orch.activeIndex) || 0);
  const activeRow = orch.providers[prevActive];
  const moved = activeRow ? res.providers.indexOf(activeRow) : 0;
  const detail = res.dropped
    .map((d) => (d.entry && d.entry.model ? d.entry.model : 'a model') + ' (' + d.why + ')')
    .join('; ');
  const noticeText = 'Left ' + res.dropped.length + ' orchestrator ' +
    (res.dropped.length === 1 ? 'model' : 'models') + ' out of this turn — ' + detail +
    '. The saved row is untouched; remove it in Settings if that gateway no longer serves it.';
  if (poolNoticeDeduper.shouldEmitPruned(noticeText)) {
    try { emit({ type: 'notice', text: noticeText }); } catch (_) {}
  }
  return Object.assign({}, orch, { providers: res.providers, activeIndex: moved < 0 ? 0 : moved });
}

ipcMain.handle('autobot:run', async (event, payload) => {
  let { runId, messages, provider, cwd, useMemory, maxSteps, orchestrator, permissions, title, convId, swarm } = payload || {};
  // The pool this turn will actually run against: the renderer's when it sent
  // one, otherwise the persisted one. Both need the same token resolution.
  const orchSource = orchestrator || store.getOrchestrator();
  const orchActive = isOrchestratorActiveForTurn(orchSource, swarm);
  let poolDead = [];
  // Resolve subscription accounts into a live bearer token before the turn.
  try {
    provider = await hydrateProvider(provider);
    if (orchActive) {
      const hy = await hydrateOrchestrator(orchSource, hydrateProvider);
      orchestrator = hy.orch;
      poolDead = hy.dead;
    } else {
      orchestrator = orchSource;
      poolNoticeDeduper.reset();
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
  const orchInput = orchestrator || orchSource;
  const orchReady = orchActive
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
  const askUser = async (q) => {
    const id = 'q' + nextQuestionId++;
    const question = q.question || q.prompt || 'Continue?';
    const options = q.options || [];
    const reply = new Promise((resolve) => {
      pendingQuestions.set(id, resolve);
      send({ type: 'question', id, question, options });
      // auto-resolve after 5 min if renderer doesn't respond
      setTimeout(() => {
        if (pendingQuestions.has(id)) {
          pendingQuestions.delete(id);
          resolve('(no answer)');
        }
      }, 300000);
    });
    return await reply;
  };

  // Exit plan mode: present a plan for approval.
  const exitPlanMode = async (p) => {
    const id = 'q' + nextQuestionId++;
    const plan = p.plan || p.content || '';
    const reply = new Promise((resolve) => {
      pendingQuestions.set(id, resolve);
      send({ type: 'plan', id, plan });
      setTimeout(() => {
        if (pendingQuestions.has(id)) {
          pendingQuestions.delete(id);
          resolve('(plan not approved)');
        }
      }, 300000);
    });
    return await reply;
  };

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
    emit: send,
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
      const st = computeruse.status();
      const sensitive = cuName === 'computer_open_app'
        || (cuName === 'computer_key' && /cmd|command|ctrl|control|alt|option/i.test(String((toolArgs || {}).keys || '')))
        || (cuName === 'computer_click' && (toolArgs || {}).button === 'right');
      const want = sensitive ? 'full_control' : 'access';
      if (!computeruse.satisfies(st.grant, want)) {
        const granted = await new Promise((resolve) => {
          const id = 'cu' + Date.now();
          let onAbort = null;
          pendingComputerUse = {
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
              pendingComputerUse = null;
              return resolve(false);
            }
            onAbort = () => {
              if (pendingComputerUse && pendingComputerUse.id === id) {
                pendingComputerUse = null;
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
    const finalMessages = await runAgent({
      provider,
      orchestrator: await orchReady,
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
    permGate.clearRun(runId, 'run_ended');
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

// ---------------------------------------------------------------------------
// Subscription provider accounts (Claude Max, ChatGPT Plus/Pro, Antigravity,
// Grok). The renderer never sees a token: it asks for status, picks an
// account id, and the main process does the token minting at run time.
// ---------------------------------------------------------------------------
function oneLine(e) {
  const s = String((e && (e.message || e.error_description || e.error)) || e || 'unknown error')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || 'unknown error').slice(0, 240);
}

ipcMain.handle('autobot:providerStatus', async () => {
  try {
    const st = providerOauth.status();
    // A dead refresh token does not mean a dead access token. Before reporting
    // an account as expired (which pushes the user back through sign-in), probe
    // it once — a success stamps `verifiedAt` and clears the badge.
    const stale = [];
    for (const p of (st.providers || [])) {
      for (const a of (p.accounts || [])) {
        if (a && a.expired) stale.push(String(a.id || (a.provider + ':' + a.account)));
      }
    }
    if (stale.length) {
      await Promise.all(stale.slice(0, 4).map((id) => {
        const cut = id.indexOf(':');
        return providerOauth.verifyAccount(id.slice(0, cut), id.slice(cut + 1)).catch(() => false);
      }));
      return { ok: true, status: providerOauth.status() };
    }
    return { ok: true, status: st };
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});

// The live model inventory of one subscription (Claude Max / ChatGPT /
// Antigravity / Grok). The renderer's picker used to hardcode a few ids; the
// real accounts expose 5–40 and they change, so ask the account itself.
// Returns the resolved context window per model, which is what the picker
// labels and what the auto-compact budget is derived from.
async function fetchProviderModels(id) {
  const raw = String(id || '');
  const provId = raw.split(':')[0];
  if (!provId) return { ok: false, error: 'which provider?' };
  const prov = providerOauth.provider(provId);
  if (!prov) return { ok: false, error: 'unknown provider' };

  let live = [];
  let warning = '';
  try {
    const r = await providerOauth.resolve(raw);
    live = await providertransport.listModels({
      transport: r.transport,
      accessToken: r.accessToken,
      apiKey: r.accessToken,
      accountId: r.accountId,
      codexUrl: r.codexUrl,
      cloudcodeUrl: r.cloudcodeUrl,
      baseURL: r.baseURL,
      model: '',
    });
  } catch (e) {
    // A provider whose token is dead still has a documented catalog: fall
    // through to the registry list instead of returning an empty picker.
    warning = oneLine(e);
  }
  if (live.length) {
    modelCatalog.register(provId, live);
    // A live inventory answered, so this account is verified by evidence — not
    // by a hardcoded provider id list in the renderer. For ChatGPT also ask the
    // account endpoint for the real plan: its token often omits the claim, so a
    // label from sign-up time would otherwise masquerade as an entitlement.
    const acct = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : '';
    try { providerOauth.markVerified(provId, acct); } catch (_) {}
    Promise.resolve(providerOauth.refreshEntitlement(provId, acct)).catch(() => {});
  }

  const entries = live.length
    ? live
    : (prov.models || []).map((m) => ({ id: m.id, label: m.label, contextWindow: 0, thinking: !!m.thinking }));
  const models = entries.map((m) => {
    const win = modelCatalog.contextWindowFor(m.id, provId, m.contextWindow);
    return {
      id: m.id,
      label: m.label || m.id,
      contextWindow: win,
      windowLabel: modelCatalog.fmtWindow(win),
      thinking: !!m.thinking,
      group: m.group || '',
    };
  });
  return {
    ok: true,
    providerId: provId,
    live: live.length > 0,
    count: models.length,
    models,
    warning: warning || undefined,
  };
}

/**
 * Ask every signed-in provider for its model catalog once, shortly after boot.
 *
 * The context window that drives auto-compaction is resolved from this catalog
 * (a live 16K model must not be trimmed at a documented 128K default). It used
 * to be fetched only when the user opened the model picker, so a turn sent
 * before that resolved to the offline fallback and an oversized prompt was sent
 * over the model's real window. Best-effort and serial: a dead token must not
 * delay boot.
 */
async function warmModelCatalogs() {
  let providers = [];
  try { providers = (providerOauth.status() || {}).providers || []; } catch (_) { return; }
  for (const p of providers) {
    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    for (const acct of accounts) {
      const id = acct && acct.id ? String(acct.id) : `${p.id}:${acct && acct.account}`;
      try { await fetchProviderModels(id); } catch (_) {}
    }
  }
}

ipcMain.handle('autobot:providerModels', async (event, id) => {
  try {
    return await fetchProviderModels(id);
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

// One browser sign-in per provider at a time. Two surfaces (Settings and the
// composer picker) can start the same flow, and a second attempt would fight
// the first for the provider's registered loopback port — which for OpenAI is
// exactly one port (1455). Concurrent callers share the attempt instead.
const providerSignInFlows = new Map(); // provId -> { promise, ctrl }

ipcMain.handle('autobot:providerSignIn', async (event, id) => {
  const provId = String(id || '');
  // Claude's credential belongs to the Claude Code CLI. Any OAuth started here
  // would mint a second refresh token and sign the CLI out, so this path is
  // closed and the renderer is pointed at the CLI-owned reconnect flow.
  if (provId === 'claude') {
    return {
      ok: false,
      noIndependentOauth: true,
      error: 'Claude is signed in through the Claude Code app. Use Reconnect Claude Code — this app adopts that sign-in rather than starting its own.',
    };
  }
  if (providerSignInFlows.has(provId)) return providerSignInFlows.get(provId).promise;
  const ctrl = new AbortController();
  // Keep the authorize URL: if the browser never opened (or the user closed the
  // tab) the renderer can offer the link again instead of leaving a spinner up.
  const entry = { promise: null, ctrl, url: '', startedAt: Date.now() };
  const attempt = (async () => {
    try {
      const rec = await providerOauth.authorize(provId, {
        openExternal: (url) => { entry.url = url; try { shell.openExternal(url); } catch (_) {} },
        signal: ctrl.signal,
      });
      // Register the new account's live catalog immediately: the very next turn
      // must compact against the real context window of whatever model it picks.
      poolNoticeDeduper.reset();
      try {
        if (rec && rec.id) await fetchProviderModels(rec.id);
      } catch (_) {}
      return { ok: true, account: rec };
    } catch (e) {
      if ((e && e.code) === 'signin_cancelled') return { ok: false, cancelled: true, error: 'Sign-in cancelled.' };
      return { ok: false, error: oneLine(e) };
    }
  })();
  entry.promise = attempt;
  providerSignInFlows.set(provId, entry);
  try { return await attempt; } finally { providerSignInFlows.delete(provId); }
});

// Is a browser sign-in still waiting, and on which URL? Pure status — no secret
// crosses the bridge (the URL carries only the public PKCE challenge + state).
ipcMain.handle('autobot:providerSignInState', (event, id) => {
  const provId = String(id || '');
  const flow = providerSignInFlows.get(provId);
  if (!flow) return { ok: true, waiting: false };
  return { ok: true, waiting: true, url: flow.url || '', startedAt: flow.startedAt };
});

// Abandon a browser sign-in that is waiting for a redirect: the user picked the
// wrong provider, or the browser tab is gone. Frees the loopback port at once
// instead of leaving the row busy until the 10-minute timeout.
ipcMain.handle('autobot:providerSignInCancel', async (event, id) => {
  const provId = String(id || '');
  const flow = providerSignInFlows.get(provId);
  if (!flow) return { ok: true, waiting: false };
  try { flow.ctrl.abort(); } catch (_) {}
  return { ok: true, waiting: false, cancelled: true };
});

// Manual sign-in: no loopback listener, the provider shows a code on its own
// page and the user pastes it back. This is the only path that works when the
// browser cannot reach 127.0.0.1/::1 (containers, remote sessions, a browser on
// another machine) — and it is what the Claude CLI falls back to.
const pendingManualSignIn = new Map();
let manualFlowSeq = 0;

ipcMain.handle('autobot:providerSignInManual', async (event, id) => {
  const provId = String(id || '');
  // Same ownership rule as `autobot:providerSignIn`: no independent Claude OAuth.
  if (provId === 'claude') {
    return {
      ok: false,
      noIndependentOauth: true,
      error: 'Claude is signed in through the Claude Code app. Use Reconnect Claude Code instead.',
    };
  }
  const flowId = provId + ':' + (++manualFlowSeq) + ':' + Date.now();
  let resolveCode = null;
  let timer = null;
  const codePromise = new Promise((res) => { resolveCode = res; });
  let url = '';
  const opened = new Promise((res) => {
    const task = providerOauth.authorize(provId, {
      openExternal: (u) => { url = u; res(u); try { shell.openExternal(u); } catch (_) {} },
      manual: true,
      waitForCode: () => codePromise,
    });
    task.then(async (rec) => {
      if (timer) clearTimeout(timer);
      pendingManualSignIn.delete(flowId);
      poolNoticeDeduper.reset();
      try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
      try { event.sender.send('autobot:providerManualResult', flowId, { ok: true, account: rec }); } catch (_) {}
    }).catch((e) => {
      if (timer) clearTimeout(timer);
      pendingManualSignIn.delete(flowId);
      try { event.sender.send('autobot:providerManualResult', flowId, { ok: false, error: oneLine(e) }); } catch (_) {}
    });
  });
  // Do not wait forever on a code nobody pastes.
  timer = setTimeout(() => {
    const f = pendingManualSignIn.get(flowId);
    if (f) { f.resolveCode(''); pendingManualSignIn.delete(flowId); }
  }, 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  // Wait just long enough for the authorize URL to be built (openExternal fires
  // synchronously, before the code wait starts).
  const built = await Promise.race([opened, new Promise((res) => setTimeout(() => res(''), 4000))]);
  pendingManualSignIn.set(flowId, { resolveCode, provId });
  return { ok: true, flowId, url: url || built };
});

ipcMain.handle('autobot:providerSubmitCode', (event, flowId, code) => {
  const f = pendingManualSignIn.get(String(flowId || ''));
  if (!f) return { ok: false, error: 'that sign-in is no longer waiting — start it again' };
  const v = String(code || '').trim();
  if (!v) return { ok: false, error: 'paste the code the sign-in page shows' };
  f.resolveCode(v);
  return { ok: true };
});

ipcMain.handle('autobot:providerSignOut', (event, id, account) => {
  try {
    const raw = String(id || '');
    const [provId, ...rest] = raw.split(':');
    const acct = account || rest.join(':');
    if (!acct) return { ok: false, error: 'which account?' };
    const removed = providerOauth.removeAccount(provId, acct);
    poolNoticeDeduper.reset();
    return { ok: true, removed };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:providerImport', async () => {
  try {
    const result = await providerOauth.importLocal();
    poolNoticeDeduper.reset();
    // Adoption brings a new account (and therefore a new catalog) into play.
    try { await warmModelCatalogs(); } catch (_) {}
    return { ok: true, result };
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:providerAddBearer', async (event, id, token, label) => {
  try {
    if (!token) return { ok: false, error: 'a token is required' };
    const rec = await providerOauth.addBearer(String(id || ''), String(token), { label: label || '' });
    poolNoticeDeduper.reset();
    return { ok: true, account: rec };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:providerSetActive', (event, id, account) => {
  try {
    const raw = String(id || '');
    const [provId, ...rest] = raw.split(':');
    const acct = account || rest.join(':');
    return { ok: true, active: providerOauth.setActive(provId, acct) };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

// ---------------------------------------------------------------------------
// Reconnecting Claude without ever running a second OAuth flow
// ---------------------------------------------------------------------------
// The refresh token is single-use. If this app mints its own grant, the next
// rotation on either side permanently invalidates the other, which is exactly
// how the CLI got signed out. So "reconnect" means: drive the owner's own login
// (`claude auth login`), let the CLI write its credential to the keychain, then
// adopt that credential. Nothing here invents an OAuth client.

/** Finish a Claude rotation whose keychain write-back was interrupted at exit. */
function replayClaudeRotation() {
  try {
    const done = providerOauth.replayRotationJournal();
    if (done) console.log('claude rotation journal replayed:', oneLine(done));
    return done;
  } catch (e) {
    console.error('claude rotation replay skipped:', oneLine(e));
    return null;
  }
}

let claudeLoginFlow = null; // { flowId, child, url, buffered, alive }

/**
 * A flow object outlives its process if the exit notification never reaches us
 * (a child that is reaped by a signal, a spawn that raced, a window that was
 * torn down). Handing that stale flow back to the renderer gives the user a URL
 * that no longer feeds a live login and a paste box that swallows the code, so
 * liveness is decided from the handle, never from the singleton being non-null.
 */
function flowIsLive(f) {
  if (!f || !f.alive) return false;
  const c = f.child;
  if (!c) return false;
  if (c.exitCode !== null && c.exitCode !== undefined) return false;
  if (c.signalCode) return false;
  return true;
}

/**
 * The Claude Code CLI binds its OAuth callback on `127.0.0.1:<random>` only. A
 * browser handed `http://localhost:<port>/callback` resolves localhost to ::1
 * first and shows ERR_CONNECTION_REFUSED, so the redirect never reaches the CLI
 * and the user is forced to copy a URL out of the address bar every time. Mirror
 * the CLI's port on ::1 so the redirect lands on whichever stack the browser
 * picked; the CLI still receives it, unchanged, over IPv4.
 */
function listenPortsOf(pid) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-p', String(pid), '-a', '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { timeout: 4000 }, (err, stdout) => {
        const ports = new Set();
        for (const line of String(stdout || '').split('\n')) {
          const m = line.match(/^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/);
          if (m) ports.add(Number(m[1]));
        }
        resolve([...ports]);
      });
  });
}

async function mirrorLoopbackOnIpv6(flow) {
  const pid = flow.child && flow.child.pid;
  if (!pid) return 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && flowIsLive(flow)) {
    const ports = await listenPortsOf(pid);
    if (ports.length) {
      const port = ports[0];
      const srv = net.createServer((c6) => {
        const c4 = net.connect({ host: '127.0.0.1', port });
        const drop = () => { try { c6.destroy(); } catch (_) {} try { c4.destroy(); } catch (_) {} };
        c6.on('error', drop);
        c4.on('error', drop);
        c6.pipe(c4);
        c4.pipe(c6);
      });
      const bound = await new Promise((res) => {
        srv.once('error', () => res(false));
        srv.listen({ host: '::1', port, ipv6Only: true }, () => res(true));
      });
      if (!bound) {
        console.log('[claude-login] ipv6 relay could not bind port', port);
        return 0; // IPv4-only browser, or the port is taken — not fatal
      }
      flow.relayPort = port;
      flow.relay = srv;
      console.log('[claude-login] ipv6 relay [::1]:' + port + ' -> 127.0.0.1:' + port);
      return port;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 0;
}

function claudeCliFallback() {
  const base = bundledRuntimeDir();
  if (!base) return '';
  const p = path.join(base, 'claude-code', 'bin', 'claude');
  try { return fs.existsSync(p) ? p : ''; } catch (_) { return ''; }
}

/** Prefer a resolved runtime (self-updated install) over the repo copy. */
async function claudeCliPath() {
  try {
    const hit = await getRuntimes().resolve('claude-code');
    if (hit && hit.bin) return hit.bin;
  } catch (_) {}
  return claudeCliFallback();
}

/**
 * Start `claude auth login` and hand its authorize URL to the renderer.
 *
 * The CLI is the credential owner, so we do not scrape its output for a token:
 * we only want the URL to open in the embedded browser and a place to paste the
 * code the page shows. On exit we re-read the keychain, which is now the CLI's
 * fresh credential.
 */
async function startClaudeLogin(event) {
  try {
    // A second concurrent login would race the same keychain item. A dead one
    // must not block the next attempt, so only a live flow short-circuits.
    if (flowIsLive(claudeLoginFlow)) {
      return { ok: true, flowId: claudeLoginFlow.flowId, url: claudeLoginFlow.url, already: true };
    }
    claudeLoginFlow = null;
    const bin = await claudeCliPath();
    if (!bin) return { ok: false, error: 'the bundled Claude Code CLI is missing — reinstall the app' };
    const flowId = 'claude-login:' + Date.now();
    const env = Object.assign({}, process.env, { BROWSER: 'true' });
    const child = spawn(bin, ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const flow = { flowId, child, url: '', buffered: '', lines: [], alive: true, relay: null, relayPort: 0 };
    claudeLoginFlow = flow;
    // Start mirroring the CLI's callback port on ::1 at once, so it is listening
    // before the user can possibly get back from the consent page.
    // Start the IPv6 mirror immediately: the port only exists once the CLI has
    // bound it, and the user may already be on the consent page.
    const relayReady = mirrorLoopbackOnIpv6(flow).catch(() => 0);
    const sender = event.sender;
    const send = (channel, id, payload) => {
      try { if (sender && !sender.isDestroyed()) sender.send(channel, id, payload); } catch (_) {}
      broadcast({ type: 'provider-reconnect', flowId: id, ...payload });
    };

    // The CLI reports a failed exchange ("Invalid code", "expired", a 400 body)
    // on its own stdout and then exits non-zero. Reporting every non-zero exit
    // as "cancelled" hides the reason and leaves the user re-running the same
    // broken attempt, so keep the last few meaningful lines to quote back.
    const ansi = (s) => String(s)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')   // OSC 8 hyperlinks
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');                      // CSI colours
    const scrape = (chunk, fromStderr) => {
      const text = ansi(chunk);
      flow.buffered += text;
      if (!flow.url) {
        const m = flow.buffered.match(/https:\/\/[^\s"'<>]+oauth\/authorize[^\s"'<>]*/);
        if (m) flow.url = m[0];
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line) continue;
        if (/oauth\/authorize|didn't open|Opening browser|Paste code here/i.test(line)) continue;
        flow.lines.push(line.slice(0, 200));
        if (flow.lines.length > 6) flow.lines.shift();
        console.log('[claude-login' + (fromStderr ? ':err' : '') + ']', line.slice(0, 300));
        // Stream it, don't wait for the exit: a rejected paste that leaves the
        // CLI waiting ("Copy all of it, including the # in the middle") produces
        // no result event at all, so an unstreamed message is indistinguishable
        // from a dead sign-in — the user retries the same wrong paste forever.
        try {
          send('autobot:providerReconnectLine', flowId, {
            line: line.slice(0, 220),
            retryable: isRetryableLine(line),
          });
        } catch (_) {}
      }
    };
    child.stdout.on('data', (c) => scrape(c, false));
    child.stderr.on('data', (c) => scrape(c, true));

    const settle = async (result) => {
      if (!flow.alive) return; // exit + error can both fire; settle once
      flow.alive = false;
      if (claudeLoginFlow === flow) claudeLoginFlow = null;
      if (flow.relay) { try { flow.relay.close(); } catch (_) {} flow.relay = null; }
      if (result && result.ok) {
        // The CLI owns the credential now; adopt it and refresh the catalog.
        try {
          const rec = await providerOauth.adoptClaudeFromCli();
          poolNoticeDeduper.reset();
          try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
          try { await warmModelCatalogs(); } catch (_) {}
          send('autobot:providerReconnectResult', flowId, { ok: true, account: rec });
        } catch (e) {
          send('autobot:providerReconnectResult', flowId, { ok: false, error: oneLine(e) });
        }
      } else {
        send('autobot:providerReconnectResult', flowId, { ok: false, error: (result && result.error) || 'sign-in did not complete' });
      }
    };
    child.on('exit', (code, signal) => {
      // Reading the store must never be able to take main down. This exact read
      // used to throw (`readClaudeCodeCredentials` was not a top-level export)
      // and surfaced as a "JavaScript error occurred in the main process" dialog
      // immediately after the CLI had successfully written the credential —
      // destroying a sign-in that had actually worked.
      let wrote = null;
      try {
        const read = typeof providerOauth.readClaudeCodeCredentials === 'function'
          ? providerOauth.readClaudeCodeCredentials
          : (providerOauth._internal && providerOauth._internal.readClaudeCodeCredentials);
        wrote = typeof read === 'function' ? !!read() : null;
      } catch (_) { wrote = null; }
      console.log('[claude-login] exit', code, signal || '', '| wrote=' + String(wrote), '| last=' + String((flow.lines || []).slice(-1)[0] || ''));
      if (code !== 0) {
        const said = String((flow.lines || []).slice(-1)[0] || '');
        const err = signal || /cancel/i.test(said)
          ? 'Claude Code sign-in was cancelled'
          : (said || 'Claude Code sign-in did not complete');
        return settle({ ok: false, error: err });
      }
      if (wrote === false) return settle({ ok: false, error: 'Claude Code finished but wrote no credential' });
      // `wrote === null` — we could not read the store at all. Let the live probe
      // inside adoptClaudeFromCli decide instead of inventing a verdict.
      settle({ ok: true });
    });
    child.on('error', (e) => settle({ ok: false, error: e.message }));

    // Give the CLI a moment to print the URL (it writes it before waiting).
    const deadline = Date.now() + 6000;
    while (!flow.url && Date.now() < deadline && flowIsLive(flow)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!flow.url) {
      try { child.kill('SIGTERM'); } catch (_) {}
      if (claudeLoginFlow === flow) claudeLoginFlow = null;
      flow.alive = false;
      if (flow.relay) { try { flow.relay.close(); } catch (_) {} flow.relay = null; }
      return { ok: false, error: 'Claude Code did not print a sign-in URL — try again from a terminal with `claude auth login`' };
    }
    // The CLI listens on 127.0.0.1 only, and Brave resolves `localhost` to
    // `::1` first. The relay was started as soon as the child existed, but a
    // returned URL is a promise that the click will land somewhere: wait for
    // the listener (bounded, and never fatal — the paste box still works).
    const boundPort = await Promise.race([
      relayReady,
      new Promise((r) => setTimeout(() => r(0), 4000)),
    ]);
    console.log('[claude-login] ready port=' + (flow.relayPort || 0) + ' ipv6Relay=' + (boundPort ? 'yes' : 'no'));
    return { ok: true, flowId, url: flow.url };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
}

/**
 * Single-flight start.
 *
 * The first click spends up to 6 s waiting for the CLI to print its URL. A
 * second click inside that window used to short-circuit on `flowIsLive()` and
 * hand back the *empty* url of the in-flight flow, so the panel rendered a
 * paste box with no way to reach the sign-in page. Both clicks now await the
 * same promise and therefore see the same real URL — and only one
 * `claude auth login` is ever spawned.
 */
let claudeLoginStart = null;
ipcMain.handle('autobot:providerReconnectClaude', async (event) => {
  if (claudeLoginStart) return claudeLoginStart;
  const p = startClaudeLogin(event)
    .then((r) => { claudeLoginStart = null; return r; },
          (e) => { claudeLoginStart = null; throw e; });
  claudeLoginStart = p;
  return p;
});

ipcMain.handle('autobot:providerReconnectClaudeCode', (event, flowId, code) => {
  const f = claudeLoginFlow;
  if (!f || f.flowId !== String(flowId || '')) {
    return { ok: false, error: 'that sign-in is no longer waiting — start it again' };
  }
  if (!flowIsLive(f)) {
    f.alive = false;
    if (claudeLoginFlow === f) claudeLoginFlow = null;
    return { ok: false, error: 'that sign-in window closed before the code arrived — start it again' };
  }
  const v0 = String(code || '').trim();
  const norm = normalizeReconnectCode(v0);
  if (!norm.ok) return { ok: false, error: norm.error };
  const v = norm.value;
  try {
    if (!f.child.stdin || f.child.stdin.destroyed || f.child.stdin.writable === false) {
      f.alive = false;
      if (claudeLoginFlow === f) claudeLoginFlow = null;
      return { ok: false, error: 'that sign-in window closed before the code arrived — start it again' };
    }
    f.child.stdin.write(v + '\n');
  } catch (e) {
    f.alive = false;
    if (claudeLoginFlow === f) claudeLoginFlow = null;
    return { ok: false, error: oneLine(e) };
  }
  return { ok: true };
});

ipcMain.handle('autobot:providerReconnectClaudeCancel', () => {
  const f = claudeLoginFlow;
  if (!f) return { ok: true, cancelled: false };
  f.alive = false;
  claudeLoginFlow = null;
  try { f.child.kill('SIGTERM'); } catch (_) {}
  if (f.relay) { try { f.relay.close(); } catch (_) {} f.relay = null; }
  return { ok: true, cancelled: true };
});

// What the renderer can render without guessing: is a login still waiting, and
// for how long. `waiting: false` means any code the user pastes will be refused.
ipcMain.handle('autobot:providerReconnectState', () => {
  const f = claudeLoginFlow;
  const live = flowIsLive(f);
  return {
    ok: true,
    waiting: live,
    flowId: live ? f.flowId : '',
    url: live ? f.url : '',
    pid: live && f.child && f.child.pid ? f.child.pid : 0,
  };
});

// Re-import after an external `claude auth login` (the user may have run it in
// a terminal instead of through the button).
ipcMain.handle('autobot:providerAdoptClaude', async () => {
  try {
    const rec = await providerOauth.adoptClaudeFromCli();
    poolNoticeDeduper.reset();
    try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
    try { await warmModelCatalogs(); } catch (_) {}
    return { ok: true, account: rec };
  } catch (e) {
    return { ok: false, error: oneLine(e), needsSignIn: e.code === 'provider_needs_signin' };
  }
});

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
  candidates.push(path.join(__dirname, '..', 'vendor', 'runtimes'));
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

/** Prepended PATH entries for a child process env. */
async function runtimePathPrefix() {
  try {
    const dirs = String(await getRuntimes().envPath()).split(path.delimiter).filter(Boolean);
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

// One-shot completion — used by GUI slash commands (/compact, /btw, /recap,
// /advisor) that need a model answer without opening a transcript turn.
ipcMain.handle('autobot:chatOnce', async (event, payload) => {
  try {
    const { chatOnce } = require('./llm');
    let p = (payload && payload.provider) || store.getSettings().provider || {};
    try { p = await hydrateProvider(p); } catch (e) {
      return { ok: false, error: e.message, needsSignIn: e.code === 'provider_needs_signin' };
    }
    const res = await chatOnce({
      provider: p,
      messages: (payload && payload.messages) || [],
      maxTokens: payload && payload.maxTokens,
    });
    return { ok: true, content: res.content, usage: res.usage, model: res.model };
  } catch (e) {
    return { ok: false, error: humanizeLLMError(e) };
  }
});

// Real `/compact`: summarize the transcript with the active model, then the
// renderer swaps the conversation for the returned digest. Same retry/failover
// path as a normal turn, so a transient 429/502 doesn't break compaction.
ipcMain.handle('autobot:compact', async (event, payload) => {
  try {
    const { chatOnce } = require('./llm');
    const msgs = (payload && payload.messages) || [];
    let p = (payload && payload.provider) || store.getSettings().provider || {};
    try { p = await hydrateProvider(p); } catch (e) {
      return { ok: false, error: e.message, needsSignIn: e.code === 'provider_needs_signin' };
    }
    const text = (c) => {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text || '') : String(x))).join('\n');
      try { return JSON.stringify(c); } catch { return String(c); }
    };
    // Keep the tail intact — recent turns matter most; cap the head.
    const lines = [];
    for (const m of msgs) {
      if (!m || !m.role || m.role === 'system') continue;
      const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
      let body = text(m.content).trim();
      if (!body && Array.isArray(m.tools) && m.tools.length) {
        body = m.tools.map((t) => `${t.name || 'tool'}(${JSON.stringify(t.args || {}).slice(0, 160)})`).join('; ');
      }
      if (!body) continue;
      lines.push(`${who}: ${body}`);
    }
    let transcript = lines.join('\n\n');
    const CAP = 120000;
    if (transcript.length > CAP) {
      transcript = '[earlier turns trimmed]\n…' + transcript.slice(-CAP);
    }
    const summaryPrompt = [
      {
        role: 'system',
        content: 'You are compacting a conversation so it can continue with the same context in far fewer tokens. Produce a dense, factual summary. Preserve: the user\'s goals and constraints, decisions made, files/paths/commands touched, code changes, open questions, errors and their fixes, and any pending tasks. Do not add commentary or invent details. Use terse markdown with short sections.',
      },
      { role: 'user', content: 'Summarize this conversation transcript.\n\n' + transcript },
    ];
    const res = await chatOnce({ provider: p, messages: summaryPrompt, maxTokens: Math.min(4000, Number(p.maxTokens) || 4000) });
    return { ok: true, summary: res.content, usage: res.usage, model: res.model, before: msgs.length };
  } catch (e) {
    return { ok: false, error: humanizeLLMError(e) };
  }
});

// Version / environment + merged hook config (parity surfaces for /version,
// /status, /debug, /doctor and /hooks).
ipcMain.handle('autobot:getVersion', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}));
ipcMain.handle('autobot:getHooks', async (e, cwd) => {
  try {
    const hooks = require('./hooks');
    return hooks.loadHookConfig(cwd || workspace.ROOT);
  } catch (err) {
    return {};
  }
});

// memory / skills / settings
ipcMain.handle('autobot:getMemory', () => store.getMemory());
ipcMain.handle('autobot:addMemory', (e, content) => store.addMemory(content));
ipcMain.handle('autobot:clearMemory', () => store.clearMemory());
ipcMain.handle('autobot:getSkills', () => store.getSkills());
ipcMain.handle('autobot:loadSkill', (e, name) => store.loadSkill(name));
ipcMain.handle('autobot:setSkillEnabled', (e, name, enabled) => store.setSkillEnabled(name, enabled));
ipcMain.handle('autobot:setAllSkillsEnabled', (e, enabled) => store.setAllSkillsEnabled(enabled));

// Custom skills: upload a .md file (or authored content) and delete one.
ipcMain.handle('autobot:addSkill', (e, name, content) => store.addCustomSkill(name, content));
ipcMain.handle('autobot:deleteSkill', (e, name) => store.deleteCustomSkill(name));
ipcMain.handle('autobot:pickSkillFile', async (event) => {
  const r = await dialog.showOpenDialog(winFor(event), {
    properties: ['openFile'],
    filters: [{ name: 'Markdown skill', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const fp = r.filePaths[0];
  let content = '';
  try { content = fs.readFileSync(fp, 'utf8'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, name: path.basename(fp).replace(/\.(md|markdown|txt)$/i, ''), content, path: fp };
});

// Plugins & connectors directory.
ipcMain.handle('autobot:listPlugins', (e, opts) => pluginsDir.listPlugins(opts));
ipcMain.handle('autobot:pluginCategories', () => pluginsDir.categories());
ipcMain.handle('autobot:searchPlugins', (e, query, opts) => pluginsDir.search(query, opts));
ipcMain.handle('autobot:suggestPlugins', (e, goal, opts) => pluginsDir.suggest(goal, opts));
ipcMain.handle('autobot:installPlugin', async (e, id) => {
  const r = pluginsDir.install(id);
  if (!r.ok) return r;
  const entry = r.entry || {};
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect timed out after ' + (ms / 1000) + 's')), ms)),
  ]);
  try {
    if (id === 'rea') {
      const res = await withTimeout(rea.ensureConnected(mcp, { userDataDir: app.getPath('userData') }), 20000);
      pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), mode: 'built-in', toolCount: res.toolCount || 0 });
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: 'rea', tools: res.tools || [] };
    }
    if (id === 'gdrive' || id === 'gdocs' || id === 'gsheets' || id === 'gslides') {
      const st = gdrive.status(mcp);
      if (st.connected) {
        pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), mode: st.mode });
        const upd = pluginsDir.markConnected(id);
        return { ok: true, entry: upd || r.entry, gdriveStatus: st };
      }
      return { ok: true, entry: r.entry, needsSetup: 'gdrive', detectedLocalFolders: st.detectedLocalFolders || [] };
    }
    const storedKey = secretstore.get(`plugin:apikey:${id}`) || undefined;
    if (entry.endpoint && entry.endpoint.url) {
      const info = await withTimeout(mcp.connect({
        url: entry.endpoint.url,
        transport: entry.endpoint.type === 'sse' ? 'sse' : 'http',
        name: entry.name,
        apiKey: storedKey,
      }), 12000);
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length });
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: info.serverId, tools: info.tools || [] };
    }
    if (entry.command && entry.command.command) {
      const extraEnv = storedKey ? { API_KEY: storedKey, BEARER_TOKEN: storedKey, ...(entry.command.env || {}) } : (entry.command.env || {});
      const info = await withTimeout(mcp.connect({ command: entry.command.command, args: entry.command.args || [], env: extraEnv, name: entry.name }), 15000);
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length });
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: info.serverId, tools: info.tools || [] };
    }
    if (storedKey) {
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, mode: 'apikey' };
    }
  } catch (err) {
    // Install intent is preserved; surface the transport error without failing.
    const auth = entry.endpoint && entry.endpoint.url
      ? mcpoauth.isAuthChallenge(err.status || (/MCP HTTP (\d+)/.exec(String(err.message || '')) || [])[1], { 'www-authenticate': err.wwwAuthenticate })
      : { required: false };
    const out = { ok: true, entry: r.entry, connectError: describeConnectError(err) };
    if (auth.required) {
      out.needsAuth = true;
      out.resourceMetadataUrl = err.resourceMetadata || null;
      out.connectError = 'this connector requires sign-in before its tools work';
    }
    return out;
  }
  return r;
});
ipcMain.handle('autobot:uninstallPlugin', (e, id) => {
  try { secretstore.del(`plugin:apikey:${id}`); } catch (_) {}
  return pluginsDir.uninstall(id);
});
ipcMain.handle('autobot:configurePlugin', async (e, id, cfg = {}) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  if (!entry.installed) pluginsDir.install(id);

  const patch = {};
  let apiKey = null;
  if (Object.prototype.hasOwnProperty.call(cfg, 'apiKey')) {
    const cleanKey = String(cfg.apiKey || '').trim();
    if (cleanKey) {
      secretstore.set(`plugin:apikey:${id}`, cleanKey);
      patch.hasApiKey = true;
      apiKey = cleanKey;
    } else {
      secretstore.del(`plugin:apikey:${id}`);
      patch.hasApiKey = false;
    }
  } else {
    apiKey = secretstore.get(`plugin:apikey:${id}`) || null;
  }

  const endpointUrl = String(cfg.endpointUrl || '').trim();
  const cmdStr = String(cfg.command || '').trim();
  if (endpointUrl) {
    patch.customEndpoint = { type: cfg.transport === 'sse' ? 'sse' : 'http', url: endpointUrl };
  }
  if (cmdStr) {
    const parts = Array.isArray(cfg.args) ? cfg.args : String(cfg.args || '').trim().split(/\s+/).filter(Boolean);
    patch.customCommand = { command: cmdStr, args: parts };
  }

  let updated = pluginsDir.setConfig(id, patch);
  const effectiveEndpoint = (updated && updated.endpoint) || entry.endpoint;
  const effectiveCommand = (updated && updated.command) || entry.command;

  if (effectiveEndpoint && effectiveEndpoint.url) {
    try {
      const headers = {};
      if (apiKey) {
        const hdrName = String(cfg.headerName || 'authorization').trim();
        headers[hdrName.toLowerCase()] = hdrName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey;
      }
      const info = await mcp.connect({
        url: effectiveEndpoint.url,
        transport: effectiveEndpoint.type === 'sse' ? 'sse' : 'http',
        name: entry.name,
        headers,
        apiKey: apiKey || undefined,
      });
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      updated = pluginsDir.setConfig(id, {
        connected: true,
        connectedAt: Date.now(),
        mode: apiKey ? 'apikey+mcp' : 'mcp',
        toolCount: (info.tools || []).length,
        lastTestAt: Date.now(),
        lastTestOk: true,
      });
      return { ok: true, entry: updated, serverId: info.serverId, tools: info.tools || [] };
    } catch (err) {
      return { ok: false, entry: updated, error: describeConnectError(err) };
    }
  }
  if (effectiveCommand && effectiveCommand.command) {
    try {
      const keySlug = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const env = apiKey ? { API_KEY: apiKey, [`${keySlug}_API_KEY`]: apiKey, BEARER_TOKEN: apiKey } : {};
      const info = await mcp.connect({
        command: effectiveCommand.command,
        args: effectiveCommand.args || [],
        env,
        name: entry.name,
      });
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      updated = pluginsDir.setConfig(id, {
        connected: true,
        connectedAt: Date.now(),
        mode: 'stdio-mcp',
        toolCount: (info.tools || []).length,
        lastTestAt: Date.now(),
        lastTestOk: true,
      });
      return { ok: true, entry: updated, serverId: info.serverId, tools: info.tools || [] };
    } catch (err) {
      return { ok: false, entry: updated, error: describeConnectError(err) };
    }
  }
  if (patch.hasApiKey) {
    updated = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), mode: 'apikey', lastTestAt: Date.now(), lastTestOk: true });
    return { ok: true, entry: updated, detail: 'API key stored securely and marked connected.' };
  }
  return { ok: true, entry: updated };
});
ipcMain.handle('autobot:testPlugin', async (e, id) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  try {
    if (id === 'rea') {
      const res = await rea.ensureConnected(mcp, { userDataDir: app.getPath('userData') });
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: res.toolCount || 0, lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, toolCount: res.toolCount || 0, detail: `REA connected (${res.toolCount || 0} MCP tools)` };
    }
    if (['gdrive', 'gdocs', 'gsheets', 'gslides'].includes(id)) {
      const st = gdrive.status(mcp);
      if (!st.connected) return { ok: false, needsSetup: 'gdrive', error: 'Google Drive is not set up yet.' };
      const res = await gdrive.searchFiles('', { limit: 1 }, mcp);
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, detail: `Drive ${st.mode} OK (${(res.files || []).length} sample result)` };
    }
    if (entry.type === 'plugin') {
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), lastTestAt: Date.now(), lastTestOk: true });
      const cap = (entry.provides || []).join(', ') || 'built-in';
      return { ok: true, entry: upd, detail: `Plugin active (${cap})` };
    }
    const storedKey = secretstore.get(`plugin:apikey:${id}`) || null;
    if (entry.endpoint && entry.endpoint.url) {
      try {
        const info = await mcp.connect({
          url: entry.endpoint.url,
          transport: entry.endpoint.type === 'sse' ? 'sse' : 'http',
          name: entry.name,
          apiKey: storedKey || undefined,
        });
        const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length, lastTestAt: Date.now(), lastTestOk: true });
        return { ok: true, entry: upd, toolCount: (info.tools || []).length, detail: `Connected (${(info.tools || []).length} MCP tools)` };
      } catch (err) {
        const msg = describeConnectError(err);
        pluginsDir.setConfig(id, { lastTestAt: Date.now(), lastTestOk: false });
        return { ok: false, error: msg };
      }
    }
    if (entry.command && entry.command.command) {
      const keySlug = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const env = storedKey ? { API_KEY: storedKey, [`${keySlug}_API_KEY`]: storedKey, BEARER_TOKEN: storedKey } : {};
      const info = await mcp.connect({ command: entry.command.command, args: entry.command.args || [], env, name: entry.name });
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length, lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, toolCount: (info.tools || []).length, detail: `Connected (${(info.tools || []).length} MCP tools)` };
    }
    if (storedKey || entry.auth === 'none') {
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, detail: entry.auth === 'none' ? 'Ready (no credentials needed)' : 'API key verified in local secret store' };
    }
    return { ok: false, error: 'Requires sign-in or API key configuration first.' };
  } catch (err) {
    pluginsDir.setConfig(id, { lastTestAt: Date.now(), lastTestOk: false });
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:pluginStats', () => pluginsDir.stats());
ipcMain.handle('autobot:refreshRegistry', (e, opts) => pluginsDir.refreshRegistry(opts));
ipcMain.handle('autobot:registryStatus', () => pluginsDir.registryStatus());

// ---------------------------------------------------------------------------
// Connector OAuth sign-in (Desktop `oauth:*` / `custom-3p` parity)
// ---------------------------------------------------------------------------
ipcMain.handle('autobot:pluginAuthStatus', (e, id) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const url = entry.endpoint && entry.endpoint.url;
  if (!url) return { ok: true, endpoint: false, authorized: false, auth: entry.auth };
  const rec = mcpoauth.readRecord(url, secretstore);
  return {
    ok: true,
    endpoint: url,
    auth: entry.auth,
    authorized: !!rec,
    connected: !!(pluginsDir.getState().config[id] || {}).connected,
    expiresAt: rec ? rec.expires_at || null : null,
    scope: rec ? rec.scope || null : null,
  };
});

ipcMain.handle('autobot:pluginSignOut', async (e, id) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const url = entry.endpoint && entry.endpoint.url;
  if (url) mcpoauth.signOut(url, secretstore);
  for (const [sid, srv] of mcp.servers) {
    if (srv && srv.url === url) { try { mcp.disconnect(sid); } catch (_) {} }
  }
  const upd = pluginsDir.setConfig(id, { connected: false, connectedAt: null });
  return { ok: true, entry: upd };
});

ipcMain.handle('autobot:pluginAuthStart', async (e, id, opts) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const url = entry.endpoint && entry.endpoint.url;
  if (!url) return { ok: false, error: 'this connector has no hosted MCP endpoint to sign in to' };

  // One window can be mid-flow per connector; a second click joins the first.
  if (authFlights.has(id)) return authFlights.get(id);

  const flight = (async () => {
    const parent = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
    try {
      const res = await mcpoauth.authorize({
        endpointUrl: url,
        store: secretstore,
        openExternal: async (authUrl) => {
          // Prefer an in-app window so the flow is visible and the callback
          // returns to the same session; fall back to the system browser.
          if (parent && !parent.isDestroyed()) {
            const w = new BrowserWindow({
              parent, modal: false, width: 520, height: 720,
              title: 'Sign in to ' + entry.name,
              backgroundColor: '#F5FAF8',
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            });
            w.setMenuBarVisibility(false);
            w.loadURL(authUrl);
            const closeOnReturn = (ev, target) => {
              try {
                const u = new URL(target);
                if (u.hostname === mcpoauth.REDIRECT_HOST || u.pathname === mcpoauth.CALLBACK_PATH) {
                  setTimeout(() => { try { w.close(); } catch (_) {} }, 900);
                }
              } catch (_) {}
            };
            w.webContents.on('will-navigate', closeOnReturn);
            w.webContents.on('did-navigate', closeOnReturn);
            w.webContents.setWindowOpenHandler(({ url: pop }) => {
              try {
                const p = new URL(pop);
                if (p.protocol === 'https:' || p.protocol === 'http:') {
                  w.loadURL(pop);
                  return { action: 'deny' };
                }
              } catch (_) {}
              return { action: 'deny' };
            });
            return;
          }
          await shell.openExternal(authUrl);
        },
        fetchImpl: globalThis.fetch,
        scope: opts && opts.scope,
        resourceMetadataUrl: opts && opts.resourceMetadataUrl,
        clientId: opts && opts.clientId,
        clientSecret: opts && opts.clientSecret,
        tokenEndpointAuthMethod: opts && opts.tokenEndpointAuthMethod,
      });

      // Reconnect now that we hold a bearer token.
      let tools = [];
      let serverId = null;
      try {
        const info = await mcp.connect({ url, transport: entry.endpoint.type === 'sse' ? 'sse' : 'http', name: entry.name });
        const srv = mcp.servers.get(info.serverId);
        if (srv) srv.fullTools = info.tools || [];
        tools = info.tools || [];
        serverId = info.serverId;
      } catch (err) {
        const upd = pluginsDir.markConnected(id);
        return { ok: true, entry: upd, connected: false, tools: [], connectError: describeConnectError(err) };
      }
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd, connected: true, tools, serverId };
    } catch (err) {
      return { ok: false, error: mcpoauth.describeAuthError(err), code: err && err.oauthError || null };
    } finally {
      authFlights.delete(id);
    }
  })();

  authFlights.set(id, flight);
  return flight;
});

// Scheduled tasks.
ipcMain.handle('autobot:listScheduledTasks', () => scheduler.list());
ipcMain.handle('autobot:createScheduledTask', (e, input) => scheduler.create(input));
ipcMain.handle('autobot:updateScheduledTask', (e, id, patch) => scheduler.update(id, patch));
ipcMain.handle('autobot:deleteScheduledTask', (e, id) => scheduler.remove(id));
ipcMain.handle('autobot:runScheduledTask', (e, id) => scheduler.runNow(id));

ipcMain.handle('autobot:getSettings', () => store.getSettings());
// ── Sandbox / network policy (Desktop `sandbox.*` + `network.*` parity) ──
const sandbox = require('./sandbox');
const secretstore = require('./secretstore');
const search = require('./search');
const sessionDb = require('./session-db');
ipcMain.handle('autobot:getSandbox', () => sandbox.describe());
ipcMain.handle('autobot:setSandbox', (e, patch) => {
  const cur = store.getSettings() || {};
  store.setSettings({ sandbox: { ...(cur.sandbox || {}), ...((patch && patch.sandbox) || {}) }, network: { ...(cur.network || {}), ...((patch && patch.network) || {}) } });
  return sandbox.describe();
});
ipcMain.handle('autobot:sandboxCheck', (e, { kind, value } = {}) => {
  if (kind === 'read') return sandbox.isReadAllowed(value);
  if (kind === 'write') return sandbox.isWriteAllowed(value);
  if (kind === 'host') return sandbox.isHostAllowed(value);
  return { allowed: true };
});
// ── Secret store (OS keychain) ──
ipcMain.handle('autobot:secretSet', (e, { name, value } = {}) => secretstore.set(String(name), String(value)));
ipcMain.handle('autobot:secretGet', (e, name) => secretstore.get(String(name)));
ipcMain.handle('autobot:secretDelete', (e, name) => secretstore.del(String(name)));
ipcMain.handle('autobot:secretList', () => secretstore.list());
ipcMain.handle('autobot:secretStatus', () => secretstore.status());
// ── Transcript / workspace search & SQLite session store ──
ipcMain.handle('autobot:searchAll', (e, payload) => search.searchAll(payload || {}));
ipcMain.handle('autobot:searchFiles', (e, payload) => search.searchFiles(payload || {}));
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
ipcMain.handle('autobot:dbMigrate', (e, convs) => sessionDb.migrateFromLocalStorage(convs || []));
ipcMain.handle('autobot:dbListConvs', (e, opts) => sessionDb.listConversations(opts || {}));
ipcMain.handle('autobot:dbGetConv', (e, id) => sessionDb.getConversation(id));
ipcMain.handle('autobot:dbUpsertConv', (e, conv) => sessionDb.upsertConversation(conv));
ipcMain.handle('autobot:dbDeleteConv', (e, id) => sessionDb.deleteConversation(id));
ipcMain.handle('autobot:dbSearch', (e, query, opts) => sessionDb.searchConversationsDb(query, opts || {}));
ipcMain.handle('autobot:setSettings', (e, patch) => {
  const next = store.setSettings(patch);
  // Launch-at-login is an OS setting, not just a stored flag (Desktop parity:
  // its General pane toggles the login item directly).
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin')) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, openAsHidden: false });
    } catch (err) { console.error('login item update failed:', err.message); }
  }
  if (process.platform === 'win32' && patch && Object.prototype.hasOwnProperty.call(patch, 'theme')) {
    const overlay = winTitleBarOverlay(next.theme);
    for (const w of windows) {
      if (w && !w.isDestroyed() && typeof w.setTitleBarOverlay === 'function') {
        try { w.setTitleBarOverlay(overlay); } catch (_) {}
      }
    }
  }
  return next;
});

// ── Example-parity config surface (commands / agents / memory / permissions / rewind) ──
// The renderer's slash menu and settings panes read the SAME `.claude/` files
// Claude Code reads, so anything defined there shows up here too.
const cwdFor = (cwd) => cwd || store.getSettings().lastCwd || require('./workspace').ROOT;

ipcMain.handle('autobot:listCommands', (e, cwd) => {
  try { return require('./commands').listForUi(cwdFor(cwd)); } catch (_) { return []; }
});
ipcMain.handle('autobot:listSlashActions', async (e, cwd) => {
  try {
    const cmds = require('./commands');
    const dir = cwdFor(cwd);
    const seenMcp = new Set();
    const mcpPrompts = [];
    // Include live MCP prompts from all connected servers first
    for (const sid of [...mcp.servers.keys()]) {
      try {
        const items = await mcp.listPrompts(sid);
        for (const p of items) {
          const k = `${p.serverId}:${p.name}`;
          if (!seenMcp.has(k)) { seenMcp.add(k); mcpPrompts.push(p); }
        }
      } catch (_) {}
    }
    // Always surface built-in REA guided workflows immediately when REA is installed
    try {
      const reaSt = rea.status(mcp, { userDataDir: app.getPath('userData') });
      if (reaSt.available) {
        for (const p of (rea.REA_BUILTIN_PROMPTS || [])) {
          const k = `${p.serverId}:${p.name}`;
          if (!seenMcp.has(k)) { seenMcp.add(k); mcpPrompts.push(p); }
        }
      }
    } catch (_) {}
    let skills = [];
    try { skills = store.getSkills() || []; } catch (_) {}
    return cmds.listSlashActions({ cwd: dir, mcpPrompts, skills });
  } catch (_) {
    return [];
  }
});
ipcMain.handle('autobot:expandMcpPrompt', async (e, payload = {}) => {
  try {
    const serverId = String(payload.serverId || '').trim();
    const name = String(payload.name || '').trim();
    const argText = String(payload.argText || '').trim();
    const dir = cwdFor(payload.cwd);
    if (serverId === 'rea') {
      const text = await rea.expandReaPrompt(mcp, name, argText, dir);
      return { ok: true, prompt: text };
    }
    const srv = mcp.servers.get(serverId);
    if (!srv) return { ok: false, error: `MCP server "${serverId}" is not connected.` };
    const prompts = await mcp.listPrompts(serverId);
    const meta = prompts.find((p) => p.name === name);
    const parsedArgs = {};
    if (argText) {
      const kv = [...argText.matchAll(/(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g)];
      if (kv.length) {
        for (const m of kv) parsedArgs[m[1]] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
      } else if (meta && meta.arguments && meta.arguments.length) {
        parsedArgs[meta.arguments[0].name] = argText;
      }
    }
    const res = await mcp.getPrompt(serverId, name, parsedArgs);
    return { ok: true, prompt: res.text || argText || `Run ${serverId}:${name}` };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:listWorkspaceFiles', async (e, cwd, query = '') => {
  try {
    const dir = path.resolve(cwdFor(cwd));
    const q = String(query || '').trim().toLowerCase();
    const results = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'release', 'build', '.next', '.cache', '__pycache__']);
    const stack = [{ d: dir, depth: 0 }];
    while (stack.length && results.length < 250) {
      const { d, depth } = stack.pop();
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of ents) {
        if (skip.has(ent.name)) continue;
        const full = path.join(d, ent.name);
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        if (ent.isDirectory()) {
          if (depth < 4) stack.push({ d: full, depth: depth + 1 });
          continue;
        }
        if (!ent.isFile()) continue;
        if (q && !rel.toLowerCase().includes(q) && !ent.name.toLowerCase().includes(q)) continue;
        results.push({ name: ent.name, path: rel, fullPath: full });
        if (results.length >= 250) break;
      }
    }
    results.sort((a, b) => {
      if (!q) return a.path.localeCompare(b.path);
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.path.localeCompare(b.path);
    });
    return results.slice(0, 40);
  } catch (_) {
    return [];
  }
});
ipcMain.handle('autobot:gdriveStatus', () => {
  try { return gdrive.status(mcp); } catch (err) { return { ok: false, connected: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:gdrivePickFolder', async (event) => {
  const cs = path.join(os.homedir(), 'Library', 'CloudStorage');
  const defaultPath = fs.existsSync(cs) ? cs : os.homedir();
  const r = await dialog.showOpenDialog(winFor(event), {
    defaultPath,
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('autobot:gdriveConnect', async (e, payload = {}) => {
  try {
    const mode = String(payload.mode || 'local');
    let res;
    if (mode === 'local') {
      res = gdrive.connectLocalFolder(payload.folderPath);
    } else if (mode === 'token') {
      res = await gdrive.connectToken({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        apiBaseUrl: payload.apiBaseUrl,
        uploadBaseUrl: payload.uploadBaseUrl,
        verify: payload.verify !== false,
      });
    } else if (mode === 'oauth') {
      const parent = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
      res = await gdrive.connectOAuth({
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        apiBaseUrl: payload.apiBaseUrl,
        uploadBaseUrl: payload.uploadBaseUrl,
        openExternal: async (authUrl) => {
          if (parent && !parent.isDestroyed()) {
            const w = new BrowserWindow({
              parent, modal: false, width: 520, height: 720,
              title: 'Sign in with Google Drive',
              backgroundColor: '#F5FAF8',
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            });
            w.setMenuBarVisibility(false);
            w.loadURL(authUrl);
            const closeOnReturn = (ev, target) => {
              try {
                const u = new URL(target);
                if (u.hostname === mcpoauth.REDIRECT_HOST || u.pathname === mcpoauth.CALLBACK_PATH) {
                  setTimeout(() => { try { w.close(); } catch (_) {} }, 900);
                }
              } catch (_) {}
            };
            w.webContents.on('will-navigate', closeOnReturn);
            w.webContents.on('did-navigate', closeOnReturn);
            return;
          }
          await shell.openExternal(authUrl);
        },
      });
    } else if (mode === 'mcp') {
      res = await gdrive.connectMcp(payload, mcp);
    } else {
      return { ok: false, error: `Unknown Google Drive connection mode: ${mode}` };
    }
    pluginsDir.install('gdrive');
    pluginsDir.setConfig('gdrive', { connected: true, connectedAt: Date.now(), mode });
    const st = gdrive.status(mcp);
    broadcast({ type: 'gdrive', status: st });
    return { ...res, status: st };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:gdriveDisconnect', () => {
  try {
    const r = gdrive.disconnect(mcp);
    if (pluginsDir.get('gdrive') && pluginsDir.get('gdrive').installed) {
      pluginsDir.setConfig('gdrive', { connected: false, connectedAt: null, mode: null });
    }
    broadcast({ type: 'gdrive', status: r.status });
    return r;
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:gdriveSearch', async (e, query = '', opts = {}) => {
  try { return await gdrive.searchFiles(query, opts, mcp); } catch (err) { return { ok: false, error: oneLine(err), files: [] }; }
});
ipcMain.handle('autobot:gdriveRead', async (e, idOrPath) => {
  try { return await gdrive.readFile(idOrPath, mcp); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:resolveCommand', async (e, name, args, cwd) => {
  try {
    const cmds = require('./commands');
    const dir = cwdFor(cwd);
    const hit = cmds.resolve(name, dir);
    if (!hit) return null;
    return { name: hit.name, source: hit.source, prompt: await cmds.expand(hit, args || '', { cwd: dir }) };
  } catch (_) { return null; }
});
ipcMain.handle('autobot:listAgents', (e, cwd) => {
  try { return require('./agentdefs').discover(cwdFor(cwd)).map((d) => ({ name: d.name, description: d.description, model: d.model || null, tools: d.tools || null, source: d.source })); } catch (_) { return []; }
});
ipcMain.handle('autobot:getProjectMemory', (e, cwd) => {
  try {
    const mem = require('./memory');
    return { files: mem.listMemory(cwdFor(cwd)), text: mem.loadMemoryText(cwdFor(cwd)) };
  } catch (_) { return { files: [], text: '' }; }
});
ipcMain.handle('autobot:getPermissions', (e, cwd) => {
  try { return require('./permissions').loadPermissions(cwdFor(cwd)); } catch (_) { return { allow: [], deny: [], ask: [], defaultMode: 'auto' }; }
});
ipcMain.handle('autobot:addPermissionRule', (e, payload) => {
  try { return require('./permissions').savePermissionRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:removePermissionRule', (e, payload) => {
  try { return require('./permissions').removePermissionRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:installStarterRules', () => {
  try { return require('./permissions').installSafeStarterPack(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:saveCustomRule', (e, payload) => {
  try { return require('./permissions').saveCustomRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:deleteCustomRule', (e, payload) => {
  try { return require('./permissions').deleteCustomRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:verifyAuditLedger', () => {
  try { return require('./audit-ledger').verifyAuditLedger(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:listAuditLedger', (e, limit) => {
  try { return require('./audit-ledger').listAuditEntries({ limit: Number(limit) || 30 }); } catch (_) { return []; }
});
ipcMain.handle('autobot:notify', (_e, payload) => notificationService.notify(payload || {}));
ipcMain.handle('autobot:checkPermission', (e, toolName, toolArgs, cwd, mode) => {
  try { return require('./permissions').decide(require('./permissions').loadPermissions(cwdFor(cwd)), toolName, toolArgs || {}, { cwd: cwdFor(cwd), mode: mode || store.getSettings().permissionMode || 'auto' }); } catch (_) { return { decision: 'ask' }; }
});
ipcMain.handle('autobot:listCheckpoints', (e, convId) => {
  try { return require('./checkpoints').listCheckpoints(convId); } catch (_) { return []; }
});
ipcMain.handle('autobot:rewind', (e, convId, checkpointId) => {
  try {
    const r = require('./checkpoints').restore(convId, checkpointId);
    const ok = (r.errors || []).length === 0;
    return { ok, restored: (r.restored || []).length, removed: (r.removed || []).length, restoredFiles: r.restored || [], removedFiles: r.removed || [], errors: r.errors || [] };
  } catch (err) { return { ok: false, restored: 0, removed: 0, restoredFiles: [], removedFiles: [], errors: [String(err && err.message || err)] }; }
});
ipcMain.handle('autobot:turnDiffs', (e, convId, checkpointId, cwd) => {
  try { return require('./checkpoints').computeTurnDiffs(convId, checkpointId, cwd); } catch (_) { return []; }
});
ipcMain.handle('autobot:gitDiffFiles', (e, cwd) => {
  try { return require('./git').gitDiffFiles(cwd || workspace.ROOT); } catch (_) { return []; }
});
ipcMain.handle('autobot:duetReview', async (e, payload = {}) => {
  try {
    const duet = require('./duet-review');
    const rawPrimary = payload.provider || store.getSettings().provider || {};
    let primaryProvider;
    try {
      primaryProvider = await hydrateProvider(rawPrimary);
    } catch (err) {
      return { ok: false, error: err.message, needsSignIn: err.code === 'provider_needs_signin' };
    }
    const orch = payload.orchestrator || store.getOrchestrator();
    const pick = duet.pickSecondOpinionProvider({
      primary: primaryProvider,
      orchestrator: orch,
      withSpec: payload.withSpec || '',
    });
    let secondProvider = pick.provider || primaryProvider;
    if (secondProvider !== primaryProvider) {
      try {
        secondProvider = await hydrateProvider(secondProvider);
      } catch (_) {
        secondProvider = primaryProvider;
      }
    }
    return await duet.runDuetReview({
      cwd: payload.cwd || workspace.ROOT,
      convId: payload.convId || null,
      target: payload.target || null,
      primaryProvider,
      secondProvider,
      adversarial: Boolean(payload.adversarial),
      diffFiles: Array.isArray(payload.diffFiles) ? payload.diffFiles : null,
    });
  } catch (err) {
    return { ok: false, error: humanizeLLMError(err) };
  }
});
ipcMain.handle('autobot:extBridgeStatus', () => {
  try { return require('./extbridge').status(); } catch (e) { return { running: false, error: e.message, tabs: [] }; }
});
ipcMain.handle('autobot:extBridgeOpenFolder', () => {
  try {
    const dir = require('./extbridge').extensionDir();
    if (!fs.existsSync(dir)) return { ok: false, error: 'Extension folder not found' };
    shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('autobot:reaStatus', () => {
  try { return rea.status(mcp, { userDataDir: app.getPath('userData') }); } catch (e) { return { ok: false, available: false, connected: false, error: e.message }; }
});
ipcMain.handle('autobot:reaConnect', async () => {
  try {
    const res = await rea.ensureConnected(mcp, { userDataDir: app.getPath('userData'), force: true });
    return { ok: true, ...res, status: rea.status(mcp, { userDataDir: app.getPath('userData') }) };
  } catch (e) {
    return { ok: false, error: oneLine(e), status: rea.status(mcp, { userDataDir: app.getPath('userData') }) };
  }
});
ipcMain.handle('autobot:reaDoctor', async () => {
  try { return await rea.doctor(mcp, { userDataDir: app.getPath('userData') }); } catch (e) { return { ok: false, error: oneLine(e) }; }
});
ipcMain.handle('autobot:reaInstall', async () => {
  try { return await rea.installOrUpdate({ userDataDir: app.getPath('userData'), mcpClient: mcp }); } catch (e) { return { ok: false, error: oneLine(e) }; }
});
ipcMain.handle('autobot:transcribeAudio', async (e, payload = {}) => {
  try {
    const wavB64 = String(payload.wavBase64 || '');
    if (!wavB64) return { ok: false, fallback: 'local-whisper' };
    let base = '';
    let key = '';
    let model = 'whisper-large-v3-turbo';
    try {
      const cfg = freellm.loadConfig ? freellm.loadConfig() : null;
      if (cfg && cfg.token && cfg.providers && ((cfg.providers.groq && cfg.providers.groq.apiKey) || (cfg.providers.openai && cfg.providers.openai.apiKey))) {
        base = `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
        key = cfg.token;
      }
    } catch (_) {}
    if (!base || !key) {
      const s = store.getSettings() || {};
      const p = s.provider || {};
      if (p.baseURL && p.apiKey && /openai\.com|groq\.com|127\.0\.0\.1:3001/i.test(String(p.baseURL))) {
        base = String(p.baseURL).replace(/\/+$/, '');
        key = String(p.apiKey);
        if (/openai\.com/i.test(base)) model = 'whisper-1';
      }
    }
    if (!base || !key) return { ok: false, fallback: 'local-whisper' };
    const buf = Buffer.from(wavB64, 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    fd.append('model', model);
    if (payload.lang) fd.append('language', String(payload.lang).slice(0, 2));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: ctrl.signal,
      });
      if (!r.ok) return { ok: false, status: r.status, fallback: 'local-whisper' };
      const j = await r.json().catch(() => null);
      const txt = j && typeof j.text === 'string' ? j.text.trim() : '';
      return txt ? { ok: true, text: txt, engine: 'gateway' } : { ok: false, fallback: 'local-whisper' };
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return { ok: false, fallback: 'local-whisper' };
  }
});
ipcMain.handle('autobot:getOrchestrator', () => store.getOrchestrator());
ipcMain.handle('autobot:setOrchestrator', (e, patch) => {
  poolNoticeDeduper.reset();
  return store.setOrchestrator(patch);
});
// Live model health for the Role pools editor: per-row cooldown / dead / inflight
// from the shared provider gate, plus the configured pools.
ipcMain.handle('autobot:poolStatus', () => {
  try {
    const router = require('./orch-router');
    const gate = require('./provider-gate');
    const orch = store.getOrchestrator() || {};
    const cfg = router.poolsConfig(orch);
    const snap = gate.snapshot();
    const roles = {};
    const rows = [];
    if (cfg) {
      for (const r of router.ROLES) {
        const list = router.resolve(orch, r, {}).filter((x) => x.role === r);
        roles[r] = list.map((x) => ({ model: x.model, max: x.maxConcurrent || 0 }));
        for (const x of list) {
          const key = gate.keyOf(x);
          if (rows.some((y) => y.key === key)) continue;
          const st = snap[key] || {};
          rows.push({ key, model: x.model, coolingMs: st.coolingMs || 0, dead: !!st.dead, deadWhy: st.deadWhy || '', inflight: st.inflight || 0, queued: st.queued || 0, strikes: st.strikes || 0 });
        }
      }
    }
    return { active: !!cfg, summary: cfg ? router.summary(orch, { baseURL: cfg.gateway && cfg.gateway.baseURL }) : '', roles, rows };
  } catch (e) {
    return { active: false, error: e.message, roles: {}, rows: [] };
  }
});
ipcMain.handle('autobot:sessionLog', (e, convId, opts) => sessionlog.read(convId || 'scratch', opts || {}));

// Creator Mode: hot-swappable user/agent custom tools (~/.autobot/custom-tools/*.json)
ipcMain.handle('autobot:customToolList', () => {
  try { return require('./customtools').listTools(); } catch (_) { return []; }
});
ipcMain.handle('autobot:customToolSave', (e, spec) => {
  const ct = require('./customtools');
  const toolsMod = require('./tools');
  return ct.saveTool(spec, {
    toolDefinitions: toolsMod.toolDefinitions,
    executorsByTool: toolsMod.executorsByTool,
    executors: toolsMod.executors,
  });
});
ipcMain.handle('autobot:customToolDelete', (e, name) => {
  const ct = require('./customtools');
  const toolsMod = require('./tools');
  return ct.deleteTool(name, {
    toolDefinitions: toolsMod.toolDefinitions,
    executorsByTool: toolsMod.executorsByTool,
    executors: toolsMod.executors,
  });
});

// Role pools: the FreeLLMAPI layout (planner / coder / vision / fast / longctx),
// pointed at the configured local router.
ipcMain.handle('autobot:poolsPreset', () => {
  let base = 'http://127.0.0.1:3001/v1';
  try {
    const c = freellm.loadConfig ? freellm.loadConfig() : null;
    if (c && c.port) base = 'http://' + (c.host || '127.0.0.1') + ':' + c.port + '/v1';
  } catch (_) {}
  return require('./orch-router').freellmPreset(base);
});
ipcMain.handle('autobot:getFeatures', () => store.getFeatures());
ipcMain.handle('autobot:setFeatures', (e, patch) => {
  const features = store.setFeatures(patch);
  applyFeatures(features);
  return features;
});
ipcMain.handle('autobot:getDefaultCwd', (event, convId, title) => {
  // Every conversation gets its own project folder under ~/Akron Bot/<slug>,
  // created lazily — "every build auto-creates a project folder" (Example parity).
  const ws = workspace.ensure(convId, title);
  return ws.dir;
});
ipcMain.handle('autobot:getWorkspace', (event, convId) => {
  const ws = workspace.get(convId);
  return ws ? ws.dir : null;
});
ipcMain.handle('autobot:setWorkspace', (event, convId, dir) => {
  const ws = workspace.setDir(convId, dir);
  return ws.dir;
});
ipcMain.handle('autobot:pickFolder', async (event) => {
  const r = await dialog.showOpenDialog(winFor(event), { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// File attachments: pick one or many files, read text content for inline
// inclusion (binary files carry name/size only, surfaced to the model as metadata).
const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html|css|scss|less|xml|yaml|yml|toml|ini|sh|bash|zsh|fish|sql|log|csv|tsv|svg|vue|svelte|graphql|gql|prisma|env|conf|gitignore|dockerfile)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?)$/i;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff' };
const MAX_INLINE_BYTES = 200 * 1024; // 200 KB inline text cap
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB image cap (data-URL inline for vision)
ipcMain.handle('autobot:pickFiles', async (event) => {
  const r = await dialog.showOpenDialog(winFor(event), { properties: ['openFile', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return [];
  return r.filePaths.map((fp) => {
    const name = path.basename(fp);
    let stat = null;
    try { stat = fs.statSync(fp); } catch (_) {}
    const size = stat ? stat.size : 0;
    let content = null;
    let isText = false;
    let isImage = false;
    let dataUrl = null;
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXT.test(name)) {
      isImage = true;
      if (size <= MAX_IMAGE_BYTES) {
        try {
          const buf = fs.readFileSync(fp);
          const mime = IMAGE_MIME[ext] || 'image/png';
          dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        } catch (_) {}
      }
    } else if (TEXT_EXT.test(name) && size <= MAX_INLINE_BYTES) {
      try {
        const buf = fs.readFileSync(fp);
        if (!buf.includes(0)) { content = buf.toString('utf8'); isText = true; }
      } catch (_) {}
    }
    return { name, path: fp, size, isText, isImage, dataUrl, content };
  });
});

// Generic save-to-file (conversation export/share writes land here; all content
// formatting happens in the renderer). Returns the chosen path or null on cancel.
ipcMain.handle('autobot:saveFile', async (event, { defaultName, content, filters }) => {
  try {
    const r = await dialog.showSaveDialog(winFor(event), {
      title: 'Export',
      defaultPath: defaultName || 'export.txt',
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { ok: true, path: null };
    fs.writeFileSync(r.filePath, String(content ?? ''), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// "Apply to file" (Claude Code parity): write a code block straight into the
// conversation's project folder (or an absolute/`~`/relative path) with no dialog.
ipcMain.handle('autobot:writeFile', async (event, { file, content, cwd }) => {
  try {
    if (!file) return { ok: false, error: 'filename required' };
    const target = paths.resolvePath(file, cwd || workspace.scratch());
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// macOS TTS (Claude Desktop parity: "speak" uses the system voice). `say` ships
// with macOS; non-darwin is a no-op.
let sayProc = null;
ipcMain.handle('autobot:speak', (e, text) => {
  if (process.platform !== 'darwin' || !text) return { ok: false };
  try {
    if (sayProc) { try { sayProc.kill(); } catch (_) {} }
    sayProc = spawn('say', [String(text)], { stdio: 'ignore' });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:stopSpeak', () => {
  if (sayProc) { try { sayProc.kill(); } catch (_) {} sayProc = null; }
  return { ok: true };
});

// Open a URL in the user's default browser (upgrade links, OAuth/SSO portals).
ipcMain.handle('autobot:openExternal', (e, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    shell.openExternal(url);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// MCP
ipcMain.handle('autobot:mcpConnect', async (e, cfg) => {
  try {
    const info = await mcp.connect(cfg);
    // stash full defs for agent tool exposure
    const entry = mcp.servers.get(info.serverId);
    entry.fullTools = info.tools || [];
    return { ok: true, serverId: info.serverId, tools: info.tools };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('autobot:mcpListTools', (e, serverId) => mcp.listTools(serverId));
ipcMain.handle('autobot:mcpCallTool', async (e, serverId, name, args) => {
  try { return { ok: true, result: await mcp.callTool(serverId, name, args) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:mcpDisconnect', (e, serverId) => { mcp.disconnect(serverId); return { ok: true }; });
ipcMain.handle('autobot:mcpStatus', () => mcpStatus());
ipcMain.handle('autobot:mcpConfig', (e, cwd) => {
  try {
    const c = require('./claudeconfig').loadMcpServers(cwdFor(cwd));
    return { servers: Object.keys(c.servers || {}), sources: c.sources || [], status: mcpStatus() };
  } catch (_) { return { servers: [], sources: [], status: [] }; }
});

// MCP resources
ipcMain.handle('autobot:mcpListResources', async (e, serverId) => {
  try { return { ok: true, resources: await mcp.listResources(serverId) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:mcpReadResource', async (e, serverId, uri) => {
  try { return { ok: true, content: await mcp.readResource(serverId, uri) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Interactive question / plan-mode answers
ipcMain.handle('autobot:answerQuestion', async (e, id, answer) => {
  const resolve = pendingQuestions.get(id);
  if (resolve) {
    pendingQuestions.delete(id);
    resolve(answer);
    return { ok: true };
  }
  return { ok: false, error: 'question not found (timed out?)' };
});

// B8 permission prompts (approve/deny/scope/feedback for a mutating tool call).
ipcMain.handle('autobot:answerPermission', async (e, id, payload) => {
  return permGate.answer(id, payload);
});

// Notebooks
ipcMain.handle('autobot:listNotebooks', () => store.listNotebooks());
ipcMain.handle('autobot:getNotebook', (e, name) => store.getNotebook(name));
ipcMain.handle('autobot:saveNotebook', (e, name, cells) => store.writeNotebook(name, cells));
ipcMain.handle('autobot:deleteNotebook', (e, name) => store.deleteNotebook(name));

// Background shells / terminal
ipcMain.handle('autobot:shellStart', async (e, opts) => {
  // Interactive shells re-run rc files, so hand them the runtime dirs to
  // re-prepend once that has happened.
  let pathPrefix = '';
  try { pathPrefix = await runtimePathPrefix(); } catch (_) { /* ignore */ }
  return shells.start({ ...(opts || {}), pathPrefix });
});
ipcMain.handle('autobot:shellRun', async (e, id, command, opts) => {
  try { return { ok: true, output: await shells.run(id, command, opts || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:shellWrite', (e, id, data) => shells.write(id, data));
ipcMain.handle('autobot:shellRead', (e, id) => shells.read(id));
ipcMain.handle('autobot:shellList', () => shells.list());
ipcMain.handle('autobot:shellKill', (e, id) => shells.kill(id));

// Repo-aware "Claude Code" mode (B8): git introspection, worktrees + unified diff.
ipcMain.handle('autobot:gitInfo', async (e, cwd) => git.gitInfo(cwd));
ipcMain.handle('autobot:worktreeList', async (e, cwd) => git.listWorktrees(cwd));
ipcMain.handle('autobot:worktreeAdd', async (e, cwd, branch, targetDir) => git.addWorktree(cwd, branch, targetDir));
ipcMain.handle('autobot:worktreeRemove', async (e, cwd, targetDir) => git.removeWorktree(cwd, targetDir));
ipcMain.handle('autobot:serverInfo', async () => {
  const st = require('./extbridge').status();
  return {
    port: st.port || 8766,
    url: `http://127.0.0.1:${st.port || 8766}`,
    wsUrl: `ws://127.0.0.1:${st.port || 8766}`,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    extensionConnected: !!st.extensionConnected,
    connectedClients: st.connectedClients || 0,
  };
});
ipcMain.handle('autobot:gitRun', async (e, cwd, args) => {
  try {
    const { exec } = require('child_process');
    const out = await new Promise((resolve) => {
      exec('git ' + args.join(' '), { cwd: cwd || process.cwd(), timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    return out;
  } catch (err) { return { ok: false, stderr: err.message }; }
});
ipcMain.handle('autobot:diff', async (e, oldText, newText, label) => git.unifiedDiff(oldText, newText, label));

// ---- Execution Environments (This Computer · SSH Host · Remote Server) ----
const environments = require('./environments');
function broadcastEnvChanged(state) {
  const s = state || environments.getState();
  for (const w of windows) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('autobot:envChanged', s); } catch (_) {}
    }
  }
}
ipcMain.handle('autobot:envGetState', () => environments.getState());
ipcMain.handle('autobot:envSetActive', (e, spec) => {
  const res = environments.setActive(spec || { kind: 'local' });
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envSaveSsh', (e, profile) => {
  const res = environments.saveSshProfile(profile || {});
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envDeleteSsh', (e, id) => {
  const res = environments.deleteSshProfile(id);
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envTestSsh', (e, profileOrId) => environments.testSsh(profileOrId));
ipcMain.handle('autobot:envSaveRemote', (e, profile) => {
  const res = environments.saveRemoteProfile(profile || {});
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envDeleteRemote', (e, id) => {
  const res = environments.deleteRemoteProfile(id);
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envTestRemote', (e, profileOrId) => environments.testRemote(profileOrId));
ipcMain.handle('autobot:envToggleHostServer', async (e, enabled, opts) => {
  const res = await environments.toggleHostServer(!!enabled, opts || {});
  broadcastEnvChanged(res && res.state);
  return res;
});
ipcMain.handle('autobot:envGetHostToken', () => environments.getHostServerToken());

// ---- Phase 3: Built-in Dependencies, LSP Auto-Install & GitHub Releases Auto-Updater ----
const depManager = require('./dep-manager');
const updater = require('./updater');
ipcMain.handle('autobot:depsStatus', () => depManager.getDependenciesStatus());
ipcMain.handle('autobot:depsInstallLsp', (e, id) => depManager.installLspServer(id, {
  onProgress: (evt) => {
    try { e.sender.send('autobot:event', { type: 'dep-lsp', ...evt }); } catch (_) {}
  },
}));
ipcMain.handle('autobot:updateCheck', (e, opts) => updater.checkForUpdates({
  currentVersion: app.getVersion(),
  ...(opts || {}),
}));
ipcMain.handle('autobot:updateDownload', (e, opts) => updater.downloadAndVerifyUpdate({
  ...(opts || {}),
  onProgress: (prog) => {
    try { e.sender.send('autobot:event', { type: 'app-update-progress', ...prog }); } catch (_) {}
  },
}));
ipcMain.handle('autobot:updateApply', (e, stagedPath) => updater.applyUpdate(stagedPath));

// Built-in Browser (renderer <webview> registers its guest WebContents; the
// agent tools in tools.js control it through the same controller).
// If an agent tool needs the browser and the pane is closed, ask every renderer
// to mount it. The renderer opens the pane; its <webview> registers the guest
// WebContents; ensureGuest() then resolves.
browser.setEnsurePane(() => {
  for (const w of windows) {
    if (w && !w.isDestroyed()) w.webContents.send('autobot:browserEnsure');
  }
});
// Tab state lives in the renderer; forward agent tab commands there.
browser.setTabCommand((cmd) => {
  for (const w of windows) {
    if (w && !w.isDestroyed()) w.webContents.send('autobot:browserTabsCommand', cmd);
  }
});

ipcMain.handle('autobot:browserRegister', (e, webContentsId) => browser.register(webContentsId));
ipcMain.handle('autobot:browserUnregister', (e, webContentsId) => browser.unregister(webContentsId));
ipcMain.handle('autobot:browserLoadURL', (e, url, cwd) => browser.loadURL(url, cwd));
// Resolve a typed/pasted path or folder to a real page URL (folder → index.html)
// so the omnibox behaves like Example's browser instead of landing on a directory.
ipcMain.handle('autobot:resolveUrl', (e, url, cwd) => browser.normalizeUrl(url, cwd));
ipcMain.handle('autobot:browserGoBack', () => browser.goBack());
ipcMain.handle('autobot:browserGoForward', () => browser.goForward());
ipcMain.handle('autobot:browserReload', () => browser.reload());
ipcMain.handle('autobot:browserStop', () => browser.stop());
ipcMain.handle('autobot:browserGetURL', () => browser.getURL());
ipcMain.handle('autobot:browserGetTitle', () => browser.getTitle());
ipcMain.handle('autobot:browserRead', () => browser.read());
ipcMain.handle('autobot:browserEval', (e, code, userGesture) => browser.executeJS(code, userGesture));
ipcMain.handle('autobot:browserClick', (e, selector, index) => browser.click(selector, index));
ipcMain.handle('autobot:browserType', (e, selector, text) => browser.type(selector, text));
ipcMain.handle('autobot:browserPress', (e, key) => browser.press(key));
ipcMain.handle('autobot:browserHover', (e, selector, index) => browser.hover(selector, index));
ipcMain.handle('autobot:browserSelect', (e, selector, value) => browser.select(selector, value));
ipcMain.handle('autobot:browserScroll', (e, direction, amount, selector) => browser.scroll(direction, amount, selector));
ipcMain.handle('autobot:browserWaitFor', (e, selector, timeoutMs) => browser.waitFor(selector, timeoutMs));
ipcMain.handle('autobot:browserScreenshot', (e, fullPage) => browser.screenshot(fullPage));
ipcMain.handle('autobot:browserSyncTabs', (e, state) => browser.syncTabs(state));
ipcMain.handle('autobot:browserListTabs', () => browser.listTabs());
ipcMain.handle('autobot:browserInspectSet', (e, webContentsId, enabled) => browser.setInspectMode(webContentsId, enabled));
ipcMain.handle('autobot:browserCaptureElement', (e, webContentsId, rect) => browser.captureElementRect(webContentsId, rect));
ipcMain.handle('autobot:browserToggleDevTools', (e, webContentsId) => browser.toggleDevTools(webContentsId));

// ---- Built-in browser ··· menu (Claude-app parity) ----
// Each item here maps to something that actually happens. "Open in Brave" checks
// that Brave is installed first — if it is not, the renderer is told so and shows
// "Open in default browser" instead of failing silently.
ipcMain.handle('autobot:browserOpenExternal', async (e, url, profile) => {
  if (!url) return { ok: false, error: 'No URL' };
  const brave = path.join('/Applications', 'Brave Browser.app');
  if (profile === 'brave') {
    if (!fs.existsSync(brave)) return { ok: false, error: 'Brave Browser is not installed', fallback: 'default' };
    const { spawn } = require('child_process');
    try { spawn('/usr/bin/open', ['-b', 'com.brave.Browser', url], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, app: 'Brave Browser' }; }
    catch (err) { return { ok: false, error: String(err && err.message || err), fallback: 'default' }; }
  }
  try { await shell.openExternal(url); return { ok: true, app: 'default browser' }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('autobot:browserSaveScreenshot', async (e, suggestedName) => {
  const shot = await browser.screenshot(false);
  if (!shot || !shot.ok) return shot || { ok: false, error: 'Could not capture the page' };
  const win = BrowserWindow.getFocusedWindow() || windows[0];
  const res = await dialog.showSaveDialog(win, {
    title: 'Save screenshot',
    defaultPath: path.join(app.getPath('desktop'), (suggestedName || 'screenshot') + '.png'),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try { fs.copyFileSync(shot.path, res.filePath); return { ok: true, path: res.filePath }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('autobot:browserOpenFile', async () => {
  const win = BrowserWindow.getFocusedWindow() || windows[0];
  const res = await dialog.showOpenDialog(win, {
    title: 'Open HTML file',
    properties: ['openFile'],
    filters: [{ name: 'Web page', extensions: ['html', 'htm', 'xhtml', 'svg'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  return { ok: true, url: 'file://' + file, path: file };
});

// Netscape cookies.txt → Chromium cookie store for the browser partition.
ipcMain.handle('autobot:browserImportCookies', async (e, partition) => {
  const win = BrowserWindow.getFocusedWindow() || windows[0];
  const res = await dialog.showOpenDialog(win, {
    title: 'Import cookies (Netscape cookies.txt)',
    properties: ['openFile'],
    filters: [{ name: 'Cookies file', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  let text;
  try { text = fs.readFileSync(res.filePaths[0], 'utf8'); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  const ses = session.fromPartition(partition || 'persist:autobot');
  let added = 0, failed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, flag, cpath, secure, expires, name, value] = f;
    const url = (secure === 'TRUE' ? 'https://' : 'http://') + String(domain).replace(/^\./, '') + (cpath || '/');
    try {
      await ses.cookies.set({
        url, name, value,
        domain: domain.startsWith('.') ? domain : undefined,
        path: cpath || '/',
        secure: secure === 'TRUE',
        httpOnly: String(flag).toUpperCase().includes('HTTPONLY'),
        expirationDate: Number(expires) > 0 ? Number(expires) : undefined,
      });
      added += 1;
    } catch (_) { failed += 1; }
  }
  return { ok: true, added, failed, file: res.filePaths[0] };
});

ipcMain.handle('autobot:browserClearData', async (e, partition) => {
  const ses = session.fromPartition(partition || 'persist:autobot');
  try {
    await ses.clearStorageData();
    await ses.clearCache().catch(() => {});
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// Dev-server detection for the browser pane ("Dev server found … [Run]").
const devserver = require('./devserver');
ipcMain.handle('autobot:devServerDetect', (e, cwd) => devserver.detect(cwd));
ipcMain.handle('autobot:devServerStart', (e, cwd) => devserver.start(cwd));

// ---- Secondary-window / chrome IPC (Claude Desktop parity surfaces) ----
ipcMain.handle('autobot:openAbout', () => { createAboutWindow(); return { ok: true }; });
ipcMain.handle('autobot:brandStatus', () => brandGuard.verifyBrandIntegrity());
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
ipcMain.handle('autobot:openQuickEntry', () => { createQuickWindow(); return { ok: true }; });
ipcMain.handle('autobot:openArtifactWindow', (e, payload) => createArtifactWindow(payload || {}));
ipcMain.handle('autobot:printToPdf', (e, payload) => printToPdf(e, payload || {}));
ipcMain.handle('autobot:artifactDocument', async (e, payload) => artifactDocument(payload || {}));
// Frame artifact type manifests (design 📽️ / slides 🎨): identity, tint and the
// resolved capability report for the current install. The renderer uses the
// small `uiMeta` shape; anything that needs the full tree asks for `manifest`.
ipcMain.handle('autobot:artifactType', (e, { language, name, profile } = {}) => {
  const ctx = artifactTypeContext({ profile });
  const ui = artifacttypes.uiMeta(language, ctx);
  if (!ui) return null;
  return { ...ui, title: artifacttypes.windowTitle(language, name), manifest: artifacttypes.manifest(language, ctx) };
});
ipcMain.handle('autobot:artifactTypes', () => artifacttypes.list());

// ---- Canvas artifact edits (Design artboards / Slides decks) ----
// The artifact window talks to main through electron/artifact-preload.js, which
// carries the artifact's own key. Every other surface (in-chat preview, print,
// reopened window) resolves the same slot from artifactstore.keyFor(), so an
// edit made once shows up everywhere and survives restarts.
ipcMain.handle('autobot:artifactSave', (e, { key, edits } = {}) => {
  if (typeof key !== 'string' || !key.startsWith('canvas-')) return { ok: false, error: 'invalid artifact key' };
  const saved = artifactstore.patch(key, edits && typeof edits === 'object' ? edits : {});
  if (!saved) return { ok: false, error: 'could not persist edits' };
  // Refresh the in-chat preview / artifacts list without a reload.
  broadcastArtifactSaved(key, e.sender.id);
  return { ok: true, key };
});
ipcMain.handle('autobot:artifactGet', (e, { key } = {}) => {
  if (typeof key !== 'string' || !key.startsWith('canvas-')) return { ok: false, error: 'invalid artifact key' };
  return { ok: true, edits: artifactstore.get(key) };
});
ipcMain.handle('autobot:artifactReset', (e, { key } = {}) => {
  if (typeof key !== 'string' || !key.startsWith('canvas-')) return { ok: false, error: 'invalid artifact key' };
  artifactstore.remove(key);
  broadcastArtifactSaved(key, e.sender.id);
  return { ok: true, key };
});

// Print the *sender* (the artifact window itself, already showing the edited
// document) straight to PDF — no rebuild, so hand edits and live iframes match
// exactly what the user sees.
ipcMain.handle('autobot:artifactPrint', async (e, { key } = {}) => {
  try {
    const wc = e.sender;
    const owner = BrowserWindow.fromWebContents(wc) || winFor(e);
    const r = await dialog.showSaveDialog(owner, {
      title: 'Export PDF',
      defaultPath: (owner && owner.getTitle ? owner.getTitle() : 'artifact') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: true, path: null };
    const data = await wc.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    fs.writeFileSync(r.filePath, data);
    if (key) artifactstore.patch(key, { printedAt: Date.now() });
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : 'print failed' };
  }
});

// "Save to Drive" from the Slides deck. Desktop reaches Google Drive through a
// connected MCP server; when none is connected the deck gets one human line
// instead of a raw JSON-RPC body.
async function slidesUpload(payload) {
  const { name, html } = payload || {};
  const body = String(html == null ? '' : html);
  if (!body) return { ok: false, error: 'nothing to upload' };
  if (gdrive.status(mcp).connected && !mcp.servers.has('gdrive')) {
    try {
      const r = await gdrive.saveFile({ name: String(name || 'slides') + '.html', content: body, mimeType: 'text/html' }, mcp);
      return { ok: true, server: 'Google Drive', ...r };
    } catch (err) {
      return { ok: false, error: oneLine(err) || 'the Drive upload failed' };
    }
  }
  const wantServer = /drive|gdrive|google/i;
  let found = null;
  for (const [sid, entry] of mcp.servers) {
    if (!wantServer.test(String(entry.name || '')) && !wantServer.test(sid)) continue;
    const tool = (entry.fullTools || []).find((t) => /upload|create[_-]?file|files?[_-]create|create[_-]?doc/i.test(String(t.name || '')));
    if (tool) { found = { sid, entry, tool }; break; }
  }
  if (!found) {
    return { ok: false, needsConnector: true, error: 'Google Drive is not connected — connect it in Plugins, then save to Drive again.' };
  }
  // Fill the tool's inputs from its own schema so we never guess a wire format.
  const schema = (found.tool.inputSchema && found.tool.inputSchema.properties) || {};
  const args = {};
  for (const prop of Object.keys(schema)) {
    if (/^(name|title|file_?name)$/i.test(prop)) args[prop] = String(name || 'slides') + '.html';
    else if (/^(content|body|text|data|html|file_?content)$/i.test(prop)) args[prop] = body;
    else if (/^(mime_?type|content_?type|type)$/i.test(prop)) args[prop] = 'text/html';
  }
  try {
    const result = await mcp.callTool(found.sid, found.tool.name, args);
    return { ok: true, server: found.entry.name, tool: found.tool.name, result };
  } catch (err) {
    return { ok: false, error: describeConnectError(err) || 'the Drive upload failed' };
  }
}
ipcMain.handle('autobot:slidesUpload', (e, payload) => slidesUpload(payload || {}));

// ---- Link unfurl (Desktop `og` / `twitter` / `xlink` parity) ----
// The renderer never fetches a link itself: the model or the user can put an
// arbitrary URL in a message, so the fetch happens here behind the SSRF guard
// and only sanitized metadata goes back.
ipcMain.handle('autobot:unfurl', async (e, url) => unfurlMod.unfurl(url));
ipcMain.handle('autobot:unfurlMany', async (e, urls) => unfurlMod.unfurlMany(urls, { limit: 6 }));

// ---- Organization compliance (Desktop `taint:*` capability namespace) ----
// The profile lives on this machine (`~/.autobot/compliance.json`); every gate is
// derived with Desktop's own arithmetic so the UI can say exactly what is blocked.
ipcMain.handle('autobot:complianceGet', () => compliance.snapshot());
ipcMain.handle('autobot:complianceSet', (e, patch) => {
  compliance.setProfile(patch || {});
  const snap = compliance.snapshot();
  broadcast({ type: 'compliance', state: snap.state });
  return snap;
});
ipcMain.handle('autobot:complianceReset', () => {
  compliance.resetProfile();
  const snap = compliance.snapshot();
  broadcast({ type: 'compliance', state: snap.state });
  return snap;
});
// Gate a destructive action before the renderer drops the conversation. The
// renderer calls this first and only deletes when `allowed` comes back true, so
// an HIPAA / ZDR profile can never lose a session by a stray click.
ipcMain.handle('autobot:complianceDeleteCheck', (e, meta) => {
  const state = compliance.evaluate(compliance.getProfile());
  const decision = state.deletion || { allowed: true };
  if (!decision.allowed) return { allowed: false, reason: decision.reason, line: state.deletionLine || '' };
  const row = compliance.recordDeletion(meta || {});
  return { allowed: true, audit: !!state.audit, row };
});
ipcMain.handle('autobot:complianceAudit', (e, limit) => compliance.readAudit(limit));

// ---- Computer Use (Desktop `computer:*` consent + `cu:*` capture) ----
// The 3 consent channels and the 14 `cu:*` channels go through one dispatcher so
// the renderer and the floating panel share exactly one code path.
ipcMain.handle('autobot:cu', async (e, channel, payload) => computeruse.invoke(channel, payload || {}));
ipcMain.handle('autobot:computerUseStatus', () => Object.assign(
  { ok: true },
  computeruse.status(),
  { permissions: computeruse.probePermissions() },
));
ipcMain.handle('autobot:computerUseRequest', (e, tier) => computeruse.request(tier));
ipcMain.handle('autobot:computerUseGrant', (e, tier, opts) => {
  const res = computeruse.grant(tier, opts || {});
  computer.setEnabled(!!res.grant);
  if (pendingComputerUse && computeruse.satisfies(res.grant, pendingComputerUse.tier)) {
    const p = pendingComputerUse;
    pendingComputerUse = null;
    p.resolve(true);
  }
  broadcast({ type: 'computerUse', state: computeruse.status() });
  return res;
});
ipcMain.handle('autobot:computerUseRevoke', (e, tier) => {
  const res = computeruse.revoke(tier);
  computer.setEnabled(!!res.grant);
  if (pendingComputerUse) {
    const p = pendingComputerUse;
    pendingComputerUse = null;
    p.resolve(false);
  }
  broadcast({ type: 'computerUse', state: computeruse.status() });
  return res;
});
ipcMain.handle('autobot:computerUsePermissions', (e, ask) => (ask ? computeruse.requestOsPermissions() : computeruse.probePermissions()));
ipcMain.handle('autobot:openComputerPanel', (e, payload) => createComputerPanel(payload || {}));

// The floating Computer Use panel: the live screen preview the user watches
// while Helio drives the machine, plus the mask/stop controls. Not a chat
// window, so it is tracked separately from `windows`.
let computerPanelWin = null;
function createComputerPanel(payload = {}) {
  if (computerPanelWin && !computerPanelWin.isDestroyed()) {
    computerPanelWin.show();
    computerPanelWin.focus();
    return { ok: true, windowId: computerPanelWin.id, existing: true };
  }
  const saved = computeruse.panelState();
  const disp = screen.getPrimaryDisplay().workArea;
  const W = 420, H = 300;
  const x = Number.isFinite(Number(saved.x)) ? Number(saved.x) : Math.round(disp.x + disp.width - W - 24);
  const y = Number.isFinite(Number(saved.y)) ? Number(saved.y) : Math.round(disp.y + disp.height - H - 24);
  computerPanelWin = new BrowserWindow({
    width: W, height: H, x, y,
    minWidth: 320, minHeight: 220,
    frame: false, resizable: true, movable: true, hasShadow: true,
    alwaysOnTop: !!saved.pinned, skipTaskbar: true, show: false,
    backgroundColor: '#1b1b19',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  computerPanelWin.loadFile(path.join(__dirname, 'computer-panel.html'));
  computerPanelWin.once('ready-to-show', () => { computerPanelWin.show(); });
  computerPanelWin.on('moved', () => {
    if (!computerPanelWin || computerPanelWin.isDestroyed()) return;
    const b = computerPanelWin.getBounds();
    computeruse.sidePanelMove({ x: b.x, y: b.y });
  });
  computerPanelWin.on('closed', () => { computerPanelWin = null; computeruse.sidePanelVisibility(false); });
  computeruse.sidePanelVisibility(true);
  if (payload && payload.grant) computeruse.grant(payload.grant, { remember: false });
  return { ok: true, windowId: computerPanelWin.id };
}

// ---- Hosted Chrome extensions (Desktop `extension-host` parity) ----
// The 11 channel handlers, plus the app-facing helpers the Plugins/Extensions
// views use. `registerIpc` attaches a sink per calling webContents, so events
// reach any window holding an extension page.
extensionhost.registerIpc(ipcMain, extHost);
ipcMain.handle('autobot:extensionList', () => listExtensions());
ipcMain.handle('autobot:extensionScan', () => { nativeExtensionIds.clear(); return listExtensions(); });
ipcMain.handle('autobot:extensionOpen', (e, payload) => createExtensionWindow(payload || {}));
ipcMain.handle('autobot:extensionServePage', (e, input) => extHost.servePage(input));
ipcMain.handle('autobot:extensionClose', (e, windowId) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.id === Number(windowId) && extensionWindows.has(w.id)) { w.close(); return { ok: true }; }
  }
  return { ok: false, message: 'No such extension window' };
});
ipcMain.handle('autobot:extensionStatus', () => ({
  ok: true,
  count: extHost.extensions.size,
  native: nativeExtensionIds.size,
  windows: extensionWindows.size,
  bridge: extHost.bridge ? { ready: !!extHost.bridge.ready, port: extHost.bridge.port || 0, reason: extHost.bridge.reason || null } : null,
  sinks: extHost.sinkCount(),
}));

// Quick Entry submit: route the typed prompt into the primary chat window.
// mode 'insert' places it in the composer; mode 'send' fires it immediately.
ipcMain.handle('autobot:quickSubmit', async (e, { text, mode }) => {
  const target = mainWindow();
  if (!target) { createWindow(); }
  const t = mainWindow() || target;
  if (t && !t.isDestroyed()) {
    t.show(); t.focus();
    t.webContents.send('autobot:quickEntry', { text: String(text || ''), mode: mode === 'send' ? 'send' : 'insert' });
  }
  if (quickWin && !quickWin.isDestroyed()) quickWin.hide();
  return { ok: true };
});

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { label: 'About Akron Code', click: () => createAboutWindow() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'New Window',
          accelerator: 'CmdOrCtrl+N',
          click: () => createWindow(),
        },
        {
          label: 'Quick Entry',
          accelerator: 'CmdOrCtrl+Shift+Space',
          click: () => createQuickWindow(),
        },
        ...(isMac ? [] : [{ role: 'quit' }]),
      ],
    },
    { label: 'Edit', role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        ...(isMac
          ? [{ type: 'separator' }, { role: 'front' }]
          : [{ role: 'close' }]),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

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

async function runScheduledPrompt({ task }) {
  let provider = scheduledProvider();
  if (!provider || !provider.model) throw new Error('No LLM provider configured — open Settings and select a model first.');
  // A scheduled task persists only the account id, so the bearer token is
  // minted here at fire time (and refreshed if the subscription rotated).
  provider = await hydrateProvider(provider);
  let out = '';
  // The pool is shared with interactive turns, so a stale row would break a
  // scheduled task too — and a scheduled run has no window to complain into.
  // A scheduled run has no window to complain into, so a row it cannot mint a
  // token for is simply left out — but it must be *minted*, not taken from disk.
  let orch = store.getOrchestrator();
  try { orch = (await hydrateOrchestrator(orch, hydrateProvider)).orch; } catch (_) { /* keep the pool as stored */ }
  try { orch = await validateOrchestrator(orch, () => {}); } catch (_) { /* keep the pool as stored */ }
  const finalMessages = await runAgent({
    provider,
    orchestrator: orch,
    messages: [{ role: 'user', content: String(task.prompt) }],
    cwd: workspace.scratch(),
    useMemory: true,
    maxSteps: 0,
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

function broadcast(evt) {
  for (const w of windows) {
    if (!w.isDestroyed()) w.webContents.send('autobot:event', evt);
  }
}

// ---------------------------------------------------------------------------
// FreeLLMAPI (local OpenAI-compatible router over the free-tier providers)
// ---------------------------------------------------------------------------
let freellmHandle = null;
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

app.whenReady().then(() => {
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
    scheduler.start(runScheduledPrompt, (evt) => broadcast({ type: 'scheduled-task', ...evt }));
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
  try { if (freellmHandle) freellmHandle.stop(); } catch (_) {}
  freellmHandle = null;
});

app.on('window-all-closed', () => {
  mcp.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});
