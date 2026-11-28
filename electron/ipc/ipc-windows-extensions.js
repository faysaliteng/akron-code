'use strict';
const path = require('path');
const fs = require('fs');
const { BrowserWindow, Menu, shell, screen, app, ipcMain, session, dialog } = require('electron');

module.exports = function registerWindowsExtensionsIpc(ctx) {
  const {
    windows, artifactWindows, extensionWindows, windowIconProps, winFor,
    findMainWindow, focusMainWindow, createWindow, createTray,
    store, artifactcanvas, artifactstore, artifacttypes, extHost, extensionhost, unfurlMod,
    compliance, computeruse, brandGuard, broadcast, pendingComputerUseRef,
    mcp, gdrive, computer, oneLine, describeConnectError,
  } = ctx;
  let quickWin = null;

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
      const lp = path.join(__dirname, '..', '..', 'LICENSE.md');
      if (fs.existsSync(lp)) shell.openPath(lp);
      return { action: 'deny' };
    }
    if (url === 'https://akron-legal.local/trademarks') {
      const tp = path.join(__dirname, '..', '..', 'TRADEMARKS.md');
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
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  quickWin.loadFile(path.join(__dirname, 'quick.html'));
  quickWin.once('ready-to-show', () => { quickWin.show(); quickWin.focus(); });
  quickWin.on('blur', () => { if (quickWin && !quickWin.isDestroyed() && !quickWin._pinned) quickWin.hide(); });
  quickWin.on('closed', () => { quickWin = null; });
  return quickWin;
}

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


ipcMain.handle('autobot:openAbout', () => { createAboutWindow(); return { ok: true }; });
ipcMain.handle('autobot:brandStatus', () => brandGuard.verifyBrandIntegrity());
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
ipcMain.handle('autobot:slidesExportPptx', async (e, payload) => {
  try {
    const { title, aspect, slides } = payload || {};
    const slug = String(title || 'presentation').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'presentation';
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) || undefined, {
      title: 'Export PowerPoint Deck (.pptx)',
      defaultPath: `${slug}.pptx`,
      filters: [{ name: 'PowerPoint Presentation', extensions: ['pptx'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    const docStudio = require('../doc-studio');
    const out = await docStudio.generateDocument({
      format: 'pptx',
      output_path: res.filePath,
      title: title || 'Presentation',
      aspect: aspect || '16:9',
      slides: Array.isArray(slides) ? slides : [],
    });
    return { ok: true, path: out.path };
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});

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
  // A grant is app-wide: release every waiting run it satisfies.
  for (const [id, p] of [...pendingComputerUseRef.waiters]) {
    if (computeruse.satisfies(res.grant, p.tier)) { pendingComputerUseRef.waiters.delete(id); p.resolve(true); }
  }
  broadcast({ type: 'computerUse', state: computeruse.status() });
  return res;
});
ipcMain.handle('autobot:computerUseRevoke', (e, tier) => {
  const res = computeruse.revoke(tier);
  computer.setEnabled(!!res.grant);
  for (const [id, p] of [...pendingComputerUseRef.waiters]) { pendingComputerUseRef.waiters.delete(id); p.resolve(false); }
  broadcast({ type: 'computerUse', state: computeruse.status() });
  return res;
});
ipcMain.handle('autobot:computerUsePermissions', (e, ask) => (ask ? computeruse.requestOsPermissions() : computeruse.probePermissions()));
ipcMain.handle('autobot:computerUseDoctor', async () => (typeof computer.doctor === 'function' ? computer.doctor() : { ok: false }));
ipcMain.handle('autobot:computerUsePreviewHud', async () => (typeof computer.previewHud === 'function' ? computer.previewHud() : { ok: false }));
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
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  computerPanelWin.loadFile(path.join(__dirname, '..', 'computer-panel.html'));
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
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'pasteAndMatchStyle' },
        { role: 'delete' },
        { role: 'selectAll' },
      ],
    },
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

  return { logoMarkup, mainWindow, createAboutWindow, createQuickWindow, hideQuickWin: () => { if (quickWin && !quickWin.isDestroyed()) quickWin.hide(); }, artifactDocument, artifactTypeContext, createArtifactWindow, broadcastArtifactSaved, listExtensions, createExtensionWindow, printToPdf, slidesUpload, createComputerPanel, buildMenu };
};