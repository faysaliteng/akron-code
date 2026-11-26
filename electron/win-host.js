'use strict';
/**
 * Akron Code Cross-Platform Local Host (`electron/win-host.js`)
 * Runs the complete backend of `electron/main.js` inside pure Node.js (zero Electron binary)
 * so the native C++20 Windows Win32 + Edge WebView2 shell gets 100% feature parity with macOS.
 */
const Module = require('module');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { spawn, execFile } = require('child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(APP_ROOT, 'dist');
const PKG_JSON = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8'));

const rpcHandlers = new Map();
const sseClients = new Set();
const winList = [];
let appReadyResolved = false;

function broadcastRenderer(channel, ...args) {
  const frame = `data: ${JSON.stringify({ channel, args })}\n\n`;
  for (const res of sseClients) {
    try { res.write(frame); } catch (_) { sseClients.delete(res); }
  }
}

class FakeWebContents extends EventEmitter {
  constructor(win) {
    super();
    this._win = win;
    this.id = Math.floor(Math.random() * 1e6);
    this._loading = false;
  }
  send(channel, ...args) { broadcastRenderer(channel, ...args); }
  isLoading() { return this._loading; }
  setWindowOpenHandler() {}
  executeJavaScript() { return Promise.resolve(null); }
}

class FakeBrowserWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.id = winList.length + 1;
    this._destroyed = false;
    this._minimized = false;
    this._title = opts.title || 'Akron Code';
    this.webContents = new FakeWebContents(this);
    winList.push(this);
  }
  static getAllWindows() { return winList.filter((w) => !w._destroyed); }
  static getFocusedWindow() { return FakeBrowserWindow.getAllWindows()[0] || null; }
  static fromWebContents(wc) { return (wc && wc._win) || FakeBrowserWindow.getAllWindows()[0] || null; }
  isDestroyed() { return this._destroyed; }
  isMinimized() { return this._minimized; }
  isMaximized() { return false; }
  isVisible() { return true; }
  restore() { this._minimized = false; }
  show() {}
  focus() {}
  hide() {}
  close() { this._destroyed = true; this.emit('closed'); }
  destroy() { this._destroyed = true; this.emit('closed'); }
  loadFile() { return Promise.resolve(); }
  loadURL() { return Promise.resolve(); }
  setTitle(t) { this._title = t; }
  setMenuBarVisibility() {}
  isFullScreen() { return false; }
  setFullScreen() {}
  getBounds() { return { x: 80, y: 60, width: 1320, height: 840 }; }
  setBounds() {}
  on(ev, fn) { return super.on(ev, fn); }
}

function runPsScript(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    execFile('powershell.exe', ['-NoLogo', '-NoProfile', '-STA', '-EncodedCommand', encoded], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

function getAppDataRoot() {
  if (process.env.APPDATA) return process.env.APPDATA;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(os.homedir(), '.config');
}

const appEmitter = new EventEmitter();
const fakeApp = Object.assign(appEmitter, {
  isReady: () => appReadyResolved,
  whenReady: () => new Promise((resolve) => {
    const fire = () => {
      appReadyResolved = true;
      resolve();
    };
    if (appReadyResolved) resolve();
    else setImmediate(fire);
  }),
  getName: () => PKG_JSON.productName || 'Akron Code',
  getVersion: () => PKG_JSON.version || '1.0.0',
  getAppPath: () => APP_ROOT,
  getPath(name) {
    const home = os.homedir();
    const appData = getAppDataRoot();
    const userData = process.env.AKRON_DATA_DIR || path.join(appData, 'Akron Code');
    if (name === 'home') return home;
    if (name === 'appData') return appData;
    if (name === 'userData') return userData;
    if (name === 'desktop') return path.join(home, 'Desktop');
    if (name === 'downloads') return path.join(home, 'Downloads');
    if (name === 'documents') return path.join(home, 'Documents');
    if (name === 'temp') return os.tmpdir();
    return userData;
  },
  requestSingleInstanceLock: () => true,
  setAsDefaultProtocolClient: () => true,
  setLoginItemSettings: () => {},
  quit: () => {
    try { appEmitter.emit('will-quit'); } catch (_) {}
    process.exit(0);
  },
  exit: (code = 0) => process.exit(code),
});

const fakeElectron = {
  app: fakeApp,
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    handle(channel, fn) { rpcHandlers.set(channel, fn); },
    removeHandler(channel) { rpcHandlers.delete(channel); },
    on() {},
    removeListener() {},
  },
  shell: {
    openExternal: async (url) => {
      const target = String(url || '').trim();
      if (!target) return;
      if (process.platform === 'win32') {
        spawn('cmd.exe', ['/c', 'start', '', target], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [target], { detached: true, stdio: 'ignore' }).unref();
      }
    },
    openPath: async (target) => {
      const p = String(target || '').trim();
      if (!p) return '';
      if (process.platform === 'win32') {
        spawn('explorer.exe', [p], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [p], { detached: true, stdio: 'ignore' }).unref();
      }
      return '';
    },
  },
  dialog: {
    showErrorBox: (title, content) => { console.error('[win-host dialog]', title, content); },
    showOpenDialog: async (_win, opts = {}) => {
      if (process.platform !== 'win32') return { canceled: true, filePaths: [] };
      const props = Array.isArray(opts.properties) ? opts.properties : [];
      if (props.includes('openDirectory')) {
        const ps = [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
          '$d.ShowNewFolderButton = $true',
          'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
        ].join('\n');
        const out = await runPsScript(ps);
        return out ? { canceled: false, filePaths: [out] } : { canceled: true, filePaths: [] };
      }
      const multi = props.includes('multiSelections') ? '$true' : '$false';
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.OpenFileDialog',
        `$d.Multiselect = ${multi}`,
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $d.FileNames | ForEach-Object { Write-Output $_ } }',
      ].join('\n');
      const out = await runPsScript(ps);
      const files = out ? out.split(/\r?\n/).filter(Boolean) : [];
      return files.length ? { canceled: false, filePaths: files } : { canceled: true, filePaths: [] };
    },
    showSaveDialog: async (_win, opts = {}) => {
      if (process.platform !== 'win32') return { canceled: true };
      const defName = String(opts.defaultPath || '').replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$d = New-Object System.Windows.Forms.SaveFileDialog',
        defName ? `$d.FileName = '${defName}'` : '',
        'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }',
      ].filter(Boolean).join('\n');
      const out = await runPsScript(ps);
      return out ? { canceled: false, filePath: out } : { canceled: true };
    },
  },
  Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => {} },
  Tray: class FakeTray { constructor() {} setToolTip() {} setContextMenu() {} on() {} destroy() {} },
  globalShortcut: { register: () => false, unregister: () => {}, unregisterAll: () => {}, isRegistered: () => false },
  nativeImage: (() => {
    const empty = () => ({ resize: () => empty(), isEmpty: () => true, toPNG: () => Buffer.alloc(0), toDataURL: () => '' });
    return { createFromPath: empty, createEmpty: empty, createFromDataURL: empty, createFromBuffer: empty };
  })(),
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  session: { defaultSession: { webRequest: { onHeadersReceived: () => {} } }, fromPartition: () => ({ webRequest: { onHeadersReceived: () => {} } }) },
  screen: (() => {
    const disp = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1 };
    return {
      getPrimaryDisplay: () => disp,
      getAllDisplays: () => [disp],
      getCursorScreenPoint: () => ({ x: 400, y: 300 }),
      getDisplayNearestPoint: () => disp,
    };
  })(),
  clipboard: { readText: () => '', writeText: () => {} },
};

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return origLoad.apply(this, arguments);
};

// Ensure AKRON_DATA_DIR userData directory exists before loading main
try { fs.mkdirSync(fakeApp.getPath('userData'), { recursive: true }); } catch (_) {}

// Load real Akron Code backend (registers all 140+ `autobot:*` IPC handlers + extbridge + FreeLLMAPI + REA)
require('./main.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function buildPreloadBridgeJs() {
  const preloadSrc = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const channels = [];
  const invokeMatches = preloadSrc.matchAll(/(\w+)\s*:\s*\(([^)]*)\)\s*=>\s*ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]\s*(?:,\s*([^)]+))?\)/g);
  for (const m of invokeMatches) {
    channels.push({ name: m[1], params: m[2].trim(), ch: m[3] });
  }
  const onHandlers = [
    ['onEvent', 'autobot:event'],
    ['onBrowserEnsure', 'autobot:browserEnsure'],
    ['onBrowserTabsCommand', 'autobot:browserTabsCommand'],
    ['onArtifactSaved', 'autobot:artifactSaved'],
    ['onQuickEntry', 'autobot:quickSubmit'],
  ];
  return `
(function(){
  if (window.__akronWinBridgeLoaded) return;
  window.__akronWinBridgeLoaded = true;
  const listeners = {};
  function addL(ch, fn) {
    if (!listeners[ch]) listeners[ch] = new Set();
    listeners[ch].add(fn);
    return () => listeners[ch] && listeners[ch].delete(fn);
  }
  const es = new EventSource('/events');
  es.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data || '{}');
      const set = listeners[msg.channel];
      if (!set) return;
      for (const fn of set) {
        try { fn(...(msg.args || [])); } catch (e) {}
      }
    } catch (_) {}
  };
  async function rpc(channel, ...args) {
    const res = await fetch('/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'RPC failed');
    return data.result;
  }
  const api = {
    ${channels.map((c) => `${c.name}: (${c.params}) => rpc(${JSON.stringify(c.ch)}${c.params ? ', ' + c.params.split(',').map((p) => p.trim().replace(/^!/, '').split('=')[0].trim()).join(', ') : ''})`).join(',\n    ')},
    runtimesUpdate: (id, force) => rpc('autobot:runtimesUpdate', id, !!force),
    computerUsePermissions: (ask) => rpc('autobot:computerUsePermissions', !!ask),
    onProviderManualResult: (cb) => addL('autobot:providerManualResult', cb),
    onProviderReconnectResult: (cb) => addL('autobot:providerReconnectResult', cb),
    onProviderReconnectLine: (cb) => addL('autobot:providerReconnectLine', cb),
    onComputerUse: (cb) => addL('autobot:event', (evt) => { if (evt && evt.type === 'computerUse') cb(evt.state); }),
    onExtensionWindowError: (cb) => addL('autobot:event', (evt) => { if (evt && evt.type === 'extension-window-error') cb(evt); }),
    ${onHandlers.map(([m, ch]) => `${m}: (cb) => addL(${JSON.stringify(ch)}, cb)`).join(',\n    ')}
  };
  window.autobot = api;
})();
`;
}

const PRELOAD_BRIDGE_JS = buildPreloadBridgeJs();

const server = http.createServer(async (req, res) => {
  const urlPath = (req.url || '/').split('?')[0];
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (urlPath === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    });
    res.write(': ok\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (urlPath === '/win-preload.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(PRELOAD_BRIDGE_JS);
    return;
  }

  if (urlPath === '/rpc' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        const handler = rpcHandlers.get(body.channel);
        if (!handler) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: `Unknown channel: ${body.channel}` }));
          return;
        }
        const fakeEvt = { sender: winList[0] && winList[0].webContents };
        const result = await Promise.resolve(handler(fakeEvt, ...(Array.isArray(body.args) ? body.args : [])));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, result: result === undefined ? null : result }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: (err && err.message) || String(err) }));
      }
    });
    return;
  }

  // Static dist/ assets with `<script src="/win-preload.js"></script>` injected before bundle executes
  let rel = decodeURIComponent(urlPath === '/' ? '/index.html' : urlPath).replace(/^\/+/, '');
  const safePath = path.normalize(path.join(DIST_DIR, rel));
  if (!safePath.startsWith(DIST_DIR) || !fs.existsSync(safePath) || fs.statSync(safePath).isDirectory()) {
    const indexHtml = path.join(DIST_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      const html = fs.readFileSync(indexHtml, 'utf8').replace('<head>', '<head><script src="/win-preload.js"></script>');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    res.writeHead(404); res.end('Not found');
    return;
  }
  const ext = path.extname(safePath).toLowerCase();
  if (ext === '.html') {
    let html = fs.readFileSync(safePath, 'utf8');
    if (!html.includes('/win-preload.js')) html = html.replace('<head>', '<head><script src="/win-preload.js"></script>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(safePath).pipe(res);
});

const listenPort = Number(process.env.AKRON_HOST_PORT || 0);
server.listen(listenPort, '127.0.0.1', () => {
  const addr = server.address();
  const port = addr && addr.port;
  setTimeout(() => {
    process.stdout.write(`AKRON_HOST_READY ${JSON.stringify({ port, bridgePort: 8766 })}\n`);
  }, 80);
});

process.on('SIGTERM', () => { fakeApp.quit(); });
process.on('SIGINT', () => { fakeApp.quit(); });
