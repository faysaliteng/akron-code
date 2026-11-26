'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { pathToFileURL, fileURLToPath } = require('url');

const SERVERS = {
  typescript: { bins: ['typescript-language-server'], args: ['--stdio'], langIds: ['typescript', 'typescriptreact', 'javascript', 'javascriptreact'] },
  python: { bins: ['pyright-langserver', 'pylsp'], args: ['--stdio'], langIds: ['python'] },
  go: { bins: ['gopls'], args: ['serve'], langIds: ['go'] },
  rust: { bins: ['rust-analyzer'], args: [], langIds: ['rust'] },
};

const LANG_TO_SERVER = {
  typescript: 'typescript',
  javascript: 'typescript',
  python: 'python',
  go: 'go',
  rust: 'rust',
};

function findBinary(bin, cwd) {
  const os = require('os');
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const searchDirs = [];
  if (cwd) searchDirs.push(path.join(cwd, 'node_modules', '.bin'));
  searchDirs.push(path.join(os.homedir(), '.autobot', 'lsp-servers', 'node_modules', '.bin'));
  if (process.env.PATH) searchDirs.push(...process.env.PATH.split(path.delimiter));
  if (process.platform !== 'win32') {
    searchDirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  }
  for (const d of searchDirs) {
    if (!d) continue;
    for (const candidate of [path.join(d, bin), ext ? path.join(d, bin + ext) : null].filter(Boolean)) {
      try { if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate; } catch (_) {}
    }
  }
  return null;
}

class LspClient {
  constructor(id, command, args, cwd, onDiagnostics) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.onDiagnostics = onDiagnostics;
    this.proc = null;
    this.nextReqId = 1;
    this.pending = new Map();
    this.buf = Buffer.alloc(0);
    this.initialized = false;
    this.initPromise = null;
  }

  start() {
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      try {
        this.proc = spawn(this.command, this.args, {
          cwd: this.cwd,
          windowsHide: true,
          shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(this.command),
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        return reject(e);
      }
      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      this.proc.on('error', (err) => {
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
      });
      this.proc.on('close', () => {
        for (const [, p] of this.pending) p.reject(new Error('LSP server closed'));
        this.pending.clear();
        this.initialized = false;
      });
      const rootUri = pathToFileURL(this.cwd).toString();
      this._sendRequest('initialize', {
        processId: process.pid,
        rootUri,
        capabilities: {
          textDocument: {
            synchronization: { didSave: true, willSave: false, change: 1 },
            publishDiagnostics: { relatedInformation: true },
            hover: { contentFormat: ['markdown', 'plaintext'] },
            definition: { linkSupport: true },
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          },
        },
      }).then((res) => {
        this.initialized = true;
        this._sendNotification('initialized', {});
        resolve(res);
      }).catch(reject);
    });
    return this.initPromise;
  }

  _onStdout(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const header = this.buf.subarray(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        this.buf = this.buf.subarray(sep + 4);
        continue;
      }
      const len = parseInt(m[1], 10);
      const bodyStart = sep + 4;
      if (this.buf.length < bodyStart + len) break;
      const bodyStr = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      this.buf = this.buf.subarray(bodyStart + len);
      let msg;
      try { msg = JSON.parse(bodyStr); } catch (_) { continue; }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    if (msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'LSP error'));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params && typeof this.onDiagnostics === 'function') {
      let filePath = msg.params.uri || '';
      try { if (filePath.startsWith('file://')) filePath = fileURLToPath(filePath); } catch (_) {}
      this.onDiagnostics({
        serverId: this.id,
        file: filePath,
        uri: msg.params.uri,
        diagnostics: Array.isArray(msg.params.diagnostics) ? msg.params.diagnostics : [],
      });
    }
  }

  _writeFrame(obj) {
    if (!this.proc || !this.proc.stdin || !this.proc.stdin.writable) return false;
    const json = JSON.stringify(obj);
    const frame = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    this.proc.stdin.write(frame, 'utf8');
    return true;
  }

  _sendRequest(method, params) {
    const id = this.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`LSP ${method} timeout`));
        }
      }, 8000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      if (!this._writeFrame({ jsonrpc: '2.0', id, method, params })) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error('LSP stdin not writable'));
      }
    });
  }

  _sendNotification(method, params) {
    this._writeFrame({ jsonrpc: '2.0', method, params });
  }

  async notify(method, params) {
    await this.start();
    this._sendNotification(method, params);
  }

  async request(method, params) {
    await this.start();
    return this._sendRequest(method, params);
  }

  stop() {
    try { this.proc && this.proc.kill(); } catch (_) {}
    this.proc = null;
    this.initialized = false;
  }
}

const activeClients = new Map(); // `${cwd}|${serverKey}` -> LspClient

function lspStatus(cwd) {
  const out = {};
  for (const [k, def] of Object.entries(SERVERS)) {
    let binPath = null;
    for (const b of def.bins) {
      binPath = findBinary(b, cwd);
      if (binPath) break;
    }
    const client = activeClients.get(`${path.resolve(cwd || process.cwd())}|${k}`);
    out[k] = {
      available: !!binPath,
      binary: binPath,
      running: !!(client && client.initialized),
    };
  }
  return out;
}

async function lspEnsure(cwd, language, onDiagnostics, customCommand) {
  const serverKey = LANG_TO_SERVER[String(language || '').toLowerCase()] || String(language || '').toLowerCase();
  const def = SERVERS[serverKey];
  if (!def && !customCommand) {
    return { ok: true, available: false, language, reason: 'No LSP configured for this language (built-in Monaco intelligence active)' };
  }
  const root = path.resolve(cwd || process.cwd());
  const key = `${root}|${serverKey || 'custom'}`;
  if (activeClients.has(key)) {
    const existing = activeClients.get(key);
    try {
      await existing.start();
      return { ok: true, available: true, running: true, key };
    } catch (_) {
      activeClients.delete(key);
    }
  }
  let cmd = customCommand ? customCommand.command : null;
  let args = customCommand ? (customCommand.args || []) : (def ? def.args : []);
  if (!cmd && def) {
    for (const b of def.bins) {
      cmd = findBinary(b, root);
      if (cmd) break;
    }
  }
  if (!cmd) {
    return { ok: true, available: false, language, reason: `${(def && def.bins[0]) || language} not found on PATH` };
  }
  const client = new LspClient(key, cmd, args, root, onDiagnostics);
  activeClients.set(key, client);
  try {
    await client.start();
    return { ok: true, available: true, running: true, key };
  } catch (e) {
    activeClients.delete(key);
    return { ok: false, available: true, error: e.message || String(e) };
  }
}

async function lspNotify(cwd, language, method, params, onDiagnostics) {
  const ensured = await lspEnsure(cwd, language, onDiagnostics);
  if (!ensured.ok || !ensured.available || !ensured.key) return ensured;
  const client = activeClients.get(ensured.key);
  if (!client) return { ok: false, error: 'LSP client unavailable' };
  const uri = params && params.file ? pathToFileURL(path.resolve(params.file)).toString() : params.uri;
  const fixed = { ...params };
  delete fixed.file;
  if (fixed.textDocument) fixed.textDocument = { ...fixed.textDocument, uri };
  await client.notify(method, fixed);
  return { ok: true };
}

async function lspRequest(cwd, language, method, params, onDiagnostics) {
  const ensured = await lspEnsure(cwd, language, onDiagnostics);
  if (!ensured.ok || !ensured.available || !ensured.key) return ensured;
  const client = activeClients.get(ensured.key);
  if (!client) return { ok: false, error: 'LSP client unavailable' };
  const uri = params && params.file ? pathToFileURL(path.resolve(params.file)).toString() : params.uri;
  const fixed = { ...params };
  delete fixed.file;
  if (fixed.textDocument) fixed.textDocument = { ...fixed.textDocument, uri };
  const result = await client.request(method, fixed);
  return { ok: true, result };
}

function lspStopAll() {
  for (const [, c] of activeClients) c.stop();
  activeClients.clear();
}

module.exports = {
  LspClient,
  lspStatus,
  lspEnsure,
  lspNotify,
  lspRequest,
  lspStopAll,
};
