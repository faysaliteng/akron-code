'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog, Menu, Tray, globalShortcut, nativeImage } = require('electron');
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
const workspace = require('./workspace');
const paths = require('./paths');
const mindmap = require('./mindmap');

const windows = new Set(); // all open BrowserWindows (multi-window parity)
const runs = new Map(); // runId -> AbortController
const mcp = new MCPClient();

// ── MCP auto-connect (Claude Code parity) ────────────────────────────────
// Claude Code starts every server declared in `.mcp.json`, `~/.claude.json`
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

let tray = null;      // macOS menu-bar icon (Claude parity: system tray)
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

// Pending write/bash permission prompts (B8 Claude Code mode) (id -> resolver).
let pendingPermissions = new Map();
let nextPermissionId = 1;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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

  windows.add(win);

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

  win.on('closed', () => { windows.delete(win); });
  return win;
}

// ---------- Secondary windows (Claude Desktop parity) ----------

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
    <div class="row">A free-LLM desktop agent.<br>Claude Desktop–compatible.<br>Electron ${process.versions.electron}</div>
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
// standalone window, mirroring Claude's "open in app" artifact surface.
function createArtifactWindow({ name, language, content }) {
  const win = new BrowserWindow({
    width: 960, height: 700, minWidth: 520, minHeight: 360,
    title: name || 'Artifact', backgroundColor: '#1e1f1c',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  const safe = String(content || '');
  const lang = String(language || '').toLowerCase();
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let body;
  if (lang === 'html' || lang === 'htm' || lang === 'svg') {
    body = safe; // render directly (trusted: generated by the model, sandboxed window)
  } else {
    body = `<pre style="margin:0;padding:20px;font:13px/1.5 ui-monospace,Menlo,monospace;color:#e8e6df;white-space:pre-wrap;word-break:break-word">${esc(safe)}</pre>`;
  }
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(name || 'Artifact')}</title>
  <style>html,body{margin:0;min-height:100%;background:#1e1f1c;color:#e8e6df;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}</style>
  </head><body>${body}</body></html>`;
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  return { ok: true, windowId: win.id };
}

// Print-to-PDF (Claude's "Design / print frame to PDF" surface): render HTML or
// plain text to a PDF via the user's save dialog.
async function printToPdf(event, { defaultName, html, content }) {
  try {
    const w = winFor(event);
    const r = await dialog.showSaveDialog(w, {
      title: 'Export PDF',
      defaultPath: defaultName || 'export.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (r.canceled || !r.filePath) return { ok: true, path: null };
    const source = html || `<html><body><pre style="font:12px/1.5 monospace;white-space:pre-wrap">${String(content || '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre></body></html>`;
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

ipcMain.handle('autobot:run', async (event, payload) => {
  const { runId, messages, provider, cwd, useMemory, maxSteps, orchestrator, permissions, title, convId, swarm } = payload || {};
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

  // B8 Claude Code mode: prompt for approval before mutating tools (Bash/Write/Edit).
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
    const mode = permissions || 'auto';
    // settings.json `permissions.allow/deny/ask` rules run BEFORE the mode, the
    // way Claude Code evaluates them: deny always wins (even in bypass), ask
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
    const p = normalizeProvider(provider);
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
ipcMain.handle('autobot:installPlugin', (e, id) => pluginsDir.install(id));
ipcMain.handle('autobot:uninstallPlugin', (e, id) => pluginsDir.uninstall(id));

// Scheduled tasks.
ipcMain.handle('autobot:listScheduledTasks', () => scheduler.list());
ipcMain.handle('autobot:createScheduledTask', (e, input) => scheduler.create(input));
ipcMain.handle('autobot:updateScheduledTask', (e, id, patch) => scheduler.update(id, patch));
ipcMain.handle('autobot:deleteScheduledTask', (e, id) => scheduler.remove(id));
ipcMain.handle('autobot:runScheduledTask', (e, id) => scheduler.runNow(id));

ipcMain.handle('autobot:getSettings', () => store.getSettings());
ipcMain.handle('autobot:setSettings', (e, patch) => store.setSettings(patch));

// ── Claude-parity config surface (commands / agents / memory / permissions / rewind) ──
// The renderer's slash menu and settings panes read the SAME `.claude/` files
// Claude Code reads, so anything defined there shows up here too.
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
  // created lazily — "every build auto-creates a project folder" (Claude parity).
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

// Repo-aware "Claude Code" mode (B8): git introspection + unified diff.
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
// so the omnibox behaves like Claude's browser instead of landing on a directory.
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

// ---- Secondary-window / chrome IPC (Claude Desktop parity surfaces) ----
ipcMain.handle('autobot:openAbout', () => { createAboutWindow(); return { ok: true }; });
ipcMain.handle('autobot:openQuickEntry', () => { createQuickWindow(); return { ok: true }; });
ipcMain.handle('autobot:openArtifactWindow', (e, payload) => createArtifactWindow(payload || {}));
ipcMain.handle('autobot:printToPdf', (e, payload) => printToPdf(e, payload || {}));

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
  const provider = scheduledProvider();
  if (!provider || !provider.model) throw new Error('No LLM provider configured — open Settings and select a model first.');
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
  applyFeatures(store.getFeatures());
  buildMenu();
  createTray();
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
});

app.on('window-all-closed', () => {
  mcp.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});
