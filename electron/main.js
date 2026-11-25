'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, globalShortcut, nativeImage, protocol, session, screen } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const { runAgent, normalizeProvider, humanizeLLMError } = require('./llm');
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
const providertransport = require('./providertransport');
const workspace = require('./workspace');
const paths = require('./paths');
const mindmap = require('./mindmap');
const artifactcanvas = require('./artifactcanvas');
const artifactstore = require('./artifactstore');
const extensionhost = require('./extensionhost');
const unfurlMod = require('./unfurl');
const compliance = require('./compliance');
const mcpoauth = require('./mcpoauth');
const computeruse = require('./computeruse');
const windowstate = require('./windowstate');

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
const gotSingleInstance = app.requestSingleInstanceLock();
if (!gotSingleInstance) app.quit();

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
  if (!win) { if (app.isReady()) createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

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

// ── MCP auto-connect (Example Code parity) ────────────────────────────────
// Example Code starts every server declared in `.mcp.json`, `~/.claude.json`
// and its own config the moment a session begins. We do the same, once per
// server name per cwd, and remember the id so tools land in `extraTools`.
const autoMcp = new Map(); // `${cwd}::${name}` -> serverId
const autoMcpTried = new Set(); // `${cwd}::${name}` that already failed once

async function autoConnectMcp(cwd) {
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

// Pending write/bash permission prompts (B8 Example Code mode) (id -> resolver).
let pendingPermissions = new Map();
let nextPermissionId = 1;

// Pending Computer Use consent prompts (Desktop `computer:request_*`). Only one
// can be outstanding at a time, so a boolean-once resolver is enough.
let pendingComputerUse = null;

function createWindow() {
  // Restore the last size/position (Desktop mainWindow.js). Bounds that no
  // longer intersect a display are dropped rather than restoring off-screen.
  const geo = windowstate.restore(screen.getAllDisplays());
  const { __maximized, ...bounds } = geo;
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    ...(bounds.x !== undefined ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: 940,
    minHeight: 600,
    title: 'Helio Bot',
    backgroundColor: '#30302e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  if (!primaryWindow || primaryWindow.isDestroyed()) primaryWindow = win;
  windows.add(win);
  windowstate.track(win, { onRestore: true });
  // A deep link that arrived during boot is delivered once the page can hear it.
  win.webContents.once('did-finish-load', () => flushDeepLink(win));

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

// ---------- Secondary windows (Example Desktop parity) ----------

// Helio Bot sunburst mark (same artwork as the renderer <Logo/>), for About /
// Quick Entry / Artifact chrome that render outside the React tree.
function logoMarkup(size) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" aria-label="Helio Bot">
<rect width="240" height="240" rx="54" fill="#F6F3EC"/>
<rect x="2" y="2" width="236" height="236" rx="52" stroke="#E8E2D5" stroke-width="2"/>
<g transform="translate(120,120)">
<path d="M 0 -76 C 4 -76, 7 -32, 4 -12 C 1 -6, -1 -6, -4 -12 C -7 -32, -4 -76, 0 -76 Z" fill="#D97757" transform="rotate(-4)"/>
<path d="M 0 78 C 4 78, 7 34, 4 13 C 1 7, -1 7, -4 13 C -7 34, -4 78, 0 78 Z" fill="#D97757" transform="rotate(2)"/>
<path d="M 0 -74 C 4 -74, 6 -30, 3 -11 C 1 -6, -1 -6, -3 -11 C -6 -30, -4 -74, 0 -74 Z" fill="#D97757" transform="rotate(42)"/>
<path d="M 0 75 C 4 75, 6 31, 3 12 C 1 6, -1 6, -3 12 C -6 31, -4 75, 0 75 Z" fill="#D97757" transform="rotate(46)"/>
<path d="M 0 -77 C 4 -77, 7 -33, 4 -12 C 1 -6, -1 -6, -4 -12 C -7 -33, -4 -77, 0 -77 Z" fill="#D97757" transform="rotate(88)"/>
<path d="M 0 74 C 4 74, 6 30, 3 11 C 1 6, -1 6, -3 11 C -6 30, -4 74, 0 74 Z" fill="#D97757" transform="rotate(93)"/>
<path d="M 0 -72 C 3.5 -72, 6 -28, 3 -11 C 1 -6, -1 -6, -3 -11 C -6 -28, -3.5 -72, 0 -72 Z" fill="#D97757" transform="rotate(134)"/>
<path d="M 0 76 C 4 76, 6.5 32, 3.5 12 C 1 6, -1 6, -3.5 12 C -6.5 32, -4 76, 0 76 Z" fill="#D97757" transform="rotate(137)"/>
<path d="M 0 -54 C 2.5 -54, 4 -22, 2 -9 C 0.5 -5, -0.5 -5, -2 -9 C -4 -22, -2.5 -54, 0 -54 Z" fill="#E3967B" transform="rotate(20)"/>
<path d="M 0 -52 C 2.5 -52, 4 -20, 2 -9 C 0.5 -5, -0.5 -5, -2 -9 C -4 -20, -2.5 -52, 0 -52 Z" fill="#E3967B" transform="rotate(112)"/>
<path d="M 0 55 C 2.5 55, 4 23, 2 9 C 0.5 5, -0.5 5, -2 9 C -4 23, -2.5 55, 0 55 Z" fill="#E3967B" transform="rotate(22)"/>
<path d="M 0 50 C 2.5 50, 4 20, 2 9 C 0.5 5, -0.5 5, -2 9 C -4 20, -2.5 50, 0 50 Z" fill="#E3967B" transform="rotate(110)"/>
<circle cx="0" cy="0" r="8" fill="#D97757"/>
</g>
</svg>`;
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
    title: 'About Helio Bot',
    backgroundColor: '#30302e',
    titleBarStyle: 'hiddenInset',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.aboutWindow = true;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#f5f4f0;background:#30302e;-webkit-user-select:none;user-select:none}
    .wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;padding:28px 24px;box-sizing:border-box;text-align:center}
    .logo{filter:drop-shadow(0 0 18px rgba(217,119,87,.4));margin-bottom:14px}
    h1{font-size:19px;margin:0 0 2px;font-weight:650}
    .sub{font-size:12px;color:#b8b5ae;margin:0 0 20px}
    .ver{font-size:11px;color:#8d8a84;background:#3a3936;border-radius:6px;padding:3px 9px;margin-bottom:18px}
    .row{font-size:12.5px;color:#d6d3cc;line-height:1.65}
    a{color:#d97f57;text-decoration:none}
    .foot{margin-top:auto;font-size:10.5px;color:#8d8a84}
  </style></head><body><div class="wrap">
    <div class="logo">${logoMarkup(72)}</div>
    <h1>Helio Bot</h1>
    <p class="sub">free-LLM desktop agent</p>
    <span class="ver">Version ${app.getVersion()}</span>
    <div class="row">A free-LLM desktop agent.<br>Example Desktop–compatible.<br>Electron ${process.versions.electron}</div>
    <div class="foot"><a href="https://akronlogic.com">akronlogic.com</a></div>
  </div></body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
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
  let img = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  if (img.isEmpty()) img = nativeImage.createEmpty();
  const sized = img.isEmpty() ? img : img.resize({ width: 16, height: 16 });
  tray = new Tray(sized);
  tray.setToolTip('Helio Bot');
  const menu = Menu.buildFromTemplate([
    { label: 'Show Helio Bot', click: () => { const w = mainWindow() || createWindow(); w.show(); w.focus(); } },
    { label: 'Quick Entry', accelerator: 'CmdOrCtrl+Shift+Space', click: () => createQuickWindow() },
    { type: 'separator' },
    { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
    { type: 'separator' },
    { label: 'About Helio Bot', click: () => createAboutWindow() },
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
function artifactDocument({ name, language, content, edits }) {
  const lang = String(language || '').toLowerCase();
  const canvas = artifactcanvas.isCanvas(lang);
  const key = canvas ? artifactstore.keyFor(lang, content) : '';
  const resolved = canvas ? (edits !== undefined ? edits : artifactstore.get(key)) : undefined;
  const doc = artifactcanvas.canvasHtml(lang, name, content, resolved, { key });
  if (doc) return doc;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const safe = String(content || '');
  const body = lang === 'html' || lang === 'htm' || lang === 'svg'
    ? safe // render directly (trusted: generated by the model, sandboxed window)
    : `<pre style="margin:0;padding:20px;font:13px/1.5 ui-monospace,Menlo,monospace;color:#e8e6df;white-space:pre-wrap;word-break:break-word">${esc(safe)}</pre>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name || 'Artifact')}</title>
  <style>html,body{margin:0;min-height:100%;background:#1e1f1c;color:#e8e6df;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}</style>
  </head><body>${body}</body></html>`;
}

function createArtifactWindow(payload) {
  const { name, language } = payload || {};
  const canvas = artifactcanvas.isCanvas(language);
  const key = canvas ? artifactstore.keyFor(String(language || '').toLowerCase(), (payload || {}).content) : '';
  const win = new BrowserWindow({
    width: canvas ? 1180 : 960, height: canvas ? 800 : 700, minWidth: 520, minHeight: 360,
    title: name || 'Artifact', backgroundColor: '#1e1f1c',
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
  const html = artifactDocument(payload || {});
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

// ---------- Hosted Chrome extensions (Example Desktop extension-host parity) ----------
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
async function hydrateProvider(provider) {
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

ipcMain.handle('autobot:run', async (event, payload) => {
  let { runId, messages, provider, cwd, useMemory, maxSteps, orchestrator, permissions, title, convId, swarm } = payload || {};
  // Resolve subscription accounts into a live bearer token before the turn.
  try {
    provider = await hydrateProvider(provider);
    if (orchestrator && Array.isArray(orchestrator.providers)) {
      orchestrator = Object.assign({}, orchestrator, {
        providers: await Promise.all(orchestrator.providers.map((p) => hydrateProvider(p))),
      });
    }
  } catch (e) {
    return { ok: false, error: e.message, needsSignIn: e.code === 'provider_needs_signin' };
  }
  const ac = new AbortController();
  runs.set(runId, ac);
  const owner = winFor(event); // route streaming events back to the originating window
  const send = (evt) => {
    if (owner && !owner.isDestroyed()) owner.webContents.send('autobot:event', { runId, ...evt });
  };
  const emit = (evt) => send(evt);

  // gather MCP tools across connected servers
  const extraTools = [];
  const serverIds = [...mcp.servers.keys()];
  for (const sid of serverIds) {
    const entry = mcp.servers.get(sid);
    // entry.tools holds only names; we need descriptions/schemas — store full defs in connect
    for (const t of entry.fullTools || []) {
      extraTools.push({ name: `mcp__${sid}__${t.name}`, description: `[MCP ${entry.name}] ${t.description || ''}`, inputSchema: t.inputSchema });
    }
  }

  const callMcpTool = async (name, args) => {
    const m = /^mcp__(\w+?)__(.+)$/.exec(name);
    if (!m) return 'Unknown MCP tool: ' + name;
    return await mcp.callTool(m[1], m[2], args);
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

  // B8 Example Code mode: prompt for approval before mutating tools (Bash/Write/Edit).
  // Permission modes: 'auto' (allow all), 'ask' (prompt for every mutating tool),
  // 'acceptEdits' (auto-allow file edits, prompt for shell/terminal), 'plan' (deny all
  // mutations — the model must propose a plan via ExitPlanMode instead),
  // 'bypass' (allow everything with no prompts at all — equivalent to auto, kept
  // distinct so the UI can surface the elevated-trust state).
  const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__workspace__write_file', 'mcp__workspace__edit_file']);
  const promptPermission = (toolName, toolArgs) => {
    const id = 'p' + nextPermissionId++;
    const summary = summarizeTool(toolName, toolArgs);
    const reply = new Promise((resolve) => {
      pendingPermissions.set(id, resolve);
      send({ type: 'permission', id, tool: toolName, args: toolArgs, summary });
      setTimeout(() => {
        if (pendingPermissions.has(id)) {
          pendingPermissions.delete(id);
          resolve(false);
        }
      }, 300000);
    });
    return reply;
  };
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
          pendingComputerUse = { id, resolve, tier: want };
          send({ type: 'computerUseConsent', id, tier: want, tool: cuName, sensitive });
          setTimeout(() => {
            if (pendingComputerUse && pendingComputerUse.id === id) { pendingComputerUse = null; resolve(false); }
          }, 300000);
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
    // way Example Code evaluates them: deny always wins (even in bypass), ask
    // forces a prompt, allow skips it.
    try {
      const perms = require('./permissions').loadPermissions(runCwd);
      const verdict = require('./permissions').decide(perms, toolName, toolArgs || {}, { cwd: runCwd, mode });
      if (verdict.decision === 'deny') {
        send({ type: 'notice', text: `Blocked: ${toolName} — ${verdict.reason}` });
        return false;
      }
      if (verdict.decision === 'allow') return true;
      // 'ask': fall through to a real prompt, but never auto-allow in a mode that
      // would otherwise skip prompting.
      if (verdict.rule) return await promptPermission(toolName, toolArgs);
    } catch (_) {}
    if (mode === 'auto' || mode === 'bypass') return true;
    if (mode === 'plan') return false;
    if (mode === 'acceptEdits' && EDIT_TOOLS.has(toolName)) return true;
    return await promptPermission(toolName, toolArgs);
  };

  // The run must write where the conversation lives. If the renderer did not
  // send a folder (new conversation, mid-switch, stale state), resolve it from
  // the conversation itself instead of falling back to a shared scratch dir —
  // that mismatch is what made a generated site "disappear".
  const runCwd = cwd || (convId ? workspace.ensure(convId, title).dir : workspace.scratch());

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
      orchestrator: orchestrator || store.getOrchestrator(),
      messages,
      cwd: runCwd,
      useMemory,
      maxSteps,
      emit,
      extraTools,
      callMcpTool,
      signal: ac.signal,
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
      turnId: 't' + Date.now(),
      // This is the top-level user turn: it owns the token-budget pool.
      turnStart: true,
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
    runs.delete(runId);
  }
});

ipcMain.handle('autobot:cancel', async (event, runId) => {
  const ac = runs.get(runId);
  if (ac) ac.abort();
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
ipcMain.handle('autobot:ollamaModels', async (event, baseURL) => {
  try {
    return await providerStatus.ollamaModels(baseURL);
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

ipcMain.handle('autobot:providerStatus', () => {
  try { return { ok: true, status: providerOauth.status() }; } catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:providerSignIn', async (event, id) => {
  try {
    const rec = await providerOauth.authorize(String(id || ''), { openExternal: (url) => shell.openExternal(url) });
    return { ok: true, account: rec };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:providerSignOut', (event, id, account) => {
  try {
    const raw = String(id || '');
    const [provId, ...rest] = raw.split(':');
    const acct = account || rest.join(':');
    if (!acct) return { ok: false, error: 'which account?' };
    return { ok: true, removed: providerOauth.removeAccount(provId, acct) };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:providerImport', async () => {
  try { return { ok: true, result: await providerOauth.importLocal() }; } catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:providerAddBearer', async (event, id, token, label) => {
  try {
    if (!token) return { ok: false, error: 'a token is required' };
    const rec = await providerOauth.addBearer(String(id || ''), String(token), { label: label || '' });
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
  // Connect immediately when the entry carries a usable MCP transport.
  const entry = r.entry || {};
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect timed out after ' + (ms / 1000) + 's')), ms)),
  ]);
  try {
    if (entry.endpoint && entry.endpoint.url) {
      const info = await withTimeout(mcp.connect({ url: entry.endpoint.url, transport: entry.endpoint.type === 'sse' ? 'sse' : 'http', name: entry.name }), 12000);
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: info.serverId, tools: info.tools || [] };
    }
    if (entry.command && entry.command.command) {
      const info = await withTimeout(mcp.connect({ command: entry.command.command, args: entry.command.args || [], name: entry.name }), 15000);
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: info.serverId, tools: info.tools || [] };
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
ipcMain.handle('autobot:uninstallPlugin', (e, id) => pluginsDir.uninstall(id));
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
              backgroundColor: '#F6F3EC',
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
// ── Transcript / workspace search ──
ipcMain.handle('autobot:searchAll', (e, payload) => search.searchAll(payload || {}));
ipcMain.handle('autobot:searchFiles', (e, payload) => search.searchFiles(payload || {}));
ipcMain.handle('autobot:setSettings', (e, patch) => {
  const next = store.setSettings(patch);
  // Launch-at-login is an OS setting, not just a stored flag (Desktop parity:
  // its General pane toggles the login item directly).
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin')) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, openAsHidden: false });
    } catch (err) { console.error('login item update failed:', err.message); }
  }
  return next;
});

// ── Example-parity config surface (commands / agents / memory / permissions / rewind) ──
// The renderer's slash menu and settings panes read the SAME `.claude/` files
// Example Code reads, so anything defined there shows up here too.
const cwdFor = (cwd) => cwd || store.getSettings().lastCwd || require('./workspace').ROOT;

ipcMain.handle('autobot:listCommands', (e, cwd) => {
  try { return require('./commands').listForUi(cwdFor(cwd)); } catch (_) { return []; }
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
    return { ok, restored: (r.restored || []).length, removed: (r.removed || []).length, errors: r.errors || [] };
  } catch (err) { return { ok: false, restored: 0, removed: 0, errors: [String(err && err.message || err)] }; }
});
ipcMain.handle('autobot:getOrchestrator', () => store.getOrchestrator());
ipcMain.handle('autobot:setOrchestrator', (e, patch) => store.setOrchestrator(patch));
ipcMain.handle('autobot:getFeatures', () => store.getFeatures());
ipcMain.handle('autobot:setFeatures', (e, patch) => {
  const features = store.setFeatures(patch);
  applyFeatures(features);
  return features;
});
ipcMain.handle('autobot:getDefaultCwd', (event, convId, title) => {
  // Every conversation gets its own project folder under ~/Helio Bot/<slug>,
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

// "Apply to file" (Example Code parity): write a code block straight into the
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

// macOS TTS (Example Desktop parity: "speak" uses the system voice). `say` ships
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

// B8 permission prompts (approve/deny a mutating tool call).
ipcMain.handle('autobot:answerPermission', async (e, id, allow) => {
  const resolve = pendingPermissions.get(id);
  if (resolve) {
    pendingPermissions.delete(id);
    resolve(!!allow);
    return { ok: true };
  }
  return { ok: false, error: 'permission not found (timed out?)' };
});

// Notebooks
ipcMain.handle('autobot:listNotebooks', () => store.listNotebooks());
ipcMain.handle('autobot:getNotebook', (e, name) => store.getNotebook(name));
ipcMain.handle('autobot:saveNotebook', (e, name, cells) => store.writeNotebook(name, cells));
ipcMain.handle('autobot:deleteNotebook', (e, name) => store.deleteNotebook(name));

// Background shells / terminal
ipcMain.handle('autobot:shellStart', (e, opts) => shells.start(opts || {}));
ipcMain.handle('autobot:shellRun', async (e, id, command, opts) => {
  try { return { ok: true, output: await shells.run(id, command, opts || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:shellWrite', (e, id, data) => shells.write(id, data));
ipcMain.handle('autobot:shellRead', (e, id) => shells.read(id));
ipcMain.handle('autobot:shellList', () => shells.list());
ipcMain.handle('autobot:shellKill', (e, id) => shells.kill(id));

// Repo-aware "Example Code" mode (B8): git introspection + unified diff.
ipcMain.handle('autobot:gitInfo', async (e, cwd) => git.gitInfo(cwd));
ipcMain.handle('autobot:gitRun', async (e, cwd, args) => {
  try {
    const { exec } = require('child_process');
    const out = await new Promise((resolve) => {
      exec('git ' + args.join(' '), { cwd: cwd || process.cwd(), timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    return out;
  } catch (err) { return { ok: false, stderr: err.message }; }
});
ipcMain.handle('autobot:diff', async (e, oldText, newText, label) => git.unifiedDiff(oldText, newText, label));

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

// ---- Secondary-window / chrome IPC (Example Desktop parity surfaces) ----
ipcMain.handle('autobot:openAbout', () => { createAboutWindow(); return { ok: true }; });
ipcMain.handle('autobot:openQuickEntry', () => { createQuickWindow(); return { ok: true }; });
ipcMain.handle('autobot:openArtifactWindow', (e, payload) => createArtifactWindow(payload || {}));
ipcMain.handle('autobot:printToPdf', (e, payload) => printToPdf(e, payload || {}));
ipcMain.handle('autobot:artifactDocument', async (e, payload) => artifactDocument(payload || {}));

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
        { label: 'About Helio Bot', click: () => createAboutWindow() },
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
  const finalMessages = await runAgent({
    provider,
    orchestrator: store.getOrchestrator(),
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

app.whenReady().then(() => {
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
  // Loopback WebSocket bridge for a real Chrome extension (Desktop parity).
  extHost.startBridge().then((r) => {
    if (!r || !r.ok) console.error('extension bridge unavailable:', (r && r.error) || 'unknown');
  }).catch((e) => console.error('extension bridge failed:', e.message));
  applyFeatures(store.getFeatures());
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
  createWindow();
  // Start the scheduled-task ticker (fires tasks due on their cadence and
  // notifies every window so the Scheduled panel can refresh).
  try {
    scheduler.start(runScheduledPrompt, (evt) => broadcast({ type: 'scheduled-task', ...evt }));
  } catch (e) {
    console.error('scheduler start failed:', e.message);
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  try { scheduler.stop(); } catch (_) {}
  try { extHost.stopBridge(); } catch (_) {}
});

app.on('window-all-closed', () => {
  mcp.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});
