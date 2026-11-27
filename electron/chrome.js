'use strict';
// Chrome control via Chrome DevTools Protocol (CDP) over WebSocket.
// Requires Chrome/Chromium running with --remote-debugging-port=9222.
// Mirrors Claude Desktop's Chrome/Computer-Use browser tooling as a local equivalent.

const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';

let host = DEFAULT_HOST;
let port = DEFAULT_PORT;

function configure(opts) {
  if (opts && opts.host) host = opts.host;
  if (opts && opts.port) port = Number(opts.port) || DEFAULT_PORT;
  return { host, port };
}

function discoverDevToolsActivePort() {
  const home = os.homedir();
  const candidates = process.platform === 'darwin'
    ? [
        path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/BraveSoftware/Brave-Browser/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Microsoft Edge/DevToolsActivePort'),
        path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
      ]
    : process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data/DevToolsActivePort'),
          path.join(process.env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/User Data/DevToolsActivePort'),
          path.join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/User Data/DevToolsActivePort'),
        ]
      : [
          path.join(home, '.config/google-chrome/DevToolsActivePort'),
          path.join(home, '.config/BraveSoftware/Brave-Browser/DevToolsActivePort'),
          path.join(home, '.config/chromium/DevToolsActivePort'),
        ];
  for (const fp of candidates) {
    try {
      if (!fp || !fs.existsSync(fp)) continue;
      const lines = fs.readFileSync(fp, 'utf8').trim().split(/\r?\n/);
      const p = Number(lines[0]);
      if (Number.isInteger(p) && p > 0) return { port: p, wsPath: lines[1] || '' };
    } catch (_) {}
  }
  return null;
}

function fetchTargetsFrom(targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: targetHost, port: targetPort, path: '/json', timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('Bad /json response')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('CDP /json timeout')));
    req.on('error', reject);
  });
}

// Fetch the list of debuggable targets (tabs/pages).
async function getTargets() {
  try {
    return await fetchTargetsFrom(host, port);
  } catch (primaryErr) {
    const discovered = discoverDevToolsActivePort();
    if (discovered && discovered.port !== port) {
      try {
        return await fetchTargetsFrom('127.0.0.1', discovered.port);
      } catch (_) {}
    }
    throw new Error(`Chrome CDP not reachable at ${host}:${port} (start Chrome with --remote-debugging-port=${port}): ${primaryErr.message}`);
  }
}

// Connect to a page's WebSocket and run CDP commands.
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      this.ws = ws;
      ws.on('open', () => resolve(this));
      ws.on('error', (e) => reject(new Error('CDP ws error: ' + e.message)));
      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: r, reject: j } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) j(new Error(msg.error.message || 'CDP error'));
          else r(msg.result);
        } else if (msg.method) {
          const cbs = this.listeners.get(msg.method) || [];
          for (const cb of cbs) cb(msg.params || {});
        }
      });
    });
  }

  send(method, params = {}) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, cb) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(cb);
  }

  close() {
    try { this.ws && this.ws.close(); } catch (_) {}
  }
}

// Resolve a target to a CDP connection.
async function connectToTarget(targetId) {
  const targets = await getTargets();
  const t = targetId
    ? targets.find((x) => x.id === targetId) || targets.find((x) => String(x.id).startsWith(targetId))
    : targets.find((x) => x.type === 'page');
  if (!t) throw new Error('No matching Chrome page target found');
  return { target: t, cdp: await new CDP(t.webSocketDebuggerUrl).connect() };
}

// Evaluate JS in the page, return result.value.
async function evaluate(cdp, expression, awaitPromise = true) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) throw new Error('Eval error: ' + (r.exceptionDetails.text || 'exception'));
  return r.result && r.result.value;
}

module.exports = { configure, getTargets, discoverDevToolsActivePort, connectToTarget, evaluate, CDP, DEFAULT_PORT, DEFAULT_HOST };
