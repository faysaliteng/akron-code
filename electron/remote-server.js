'use strict';
/**
 * Authenticated HTTP + WebSocket Remote Server for Akron Code.
 * Exposes workspace filesystem, search, git, agent tools, and interactive PTY
 * over Bearer-token-authenticated endpoints for Settings -> Environments -> Remote.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer } = require('ws');
const fsWatcher = require('./ide/fs-watcher');
const search = require('./ide/search');
const git = require('./git');
const ptyMod = require('./ide/pty');
const tools = require('./tools');

const MAX_BODY = 16 * 1024 * 1024;

function timingSafeBearer(authHeader, expectedToken) {
  if (!expectedToken) return false;
  const raw = String(authHeader || '').trim();
  if (!raw.toLowerCase().startsWith('bearer ')) return false;
  const supplied = raw.slice(7).trim();
  const a = Buffer.from(supplied, 'utf8');
  const b = Buffer.from(String(expectedToken), 'utf8');
  if (a.length !== b.length || a.length === 0) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        reject(new Error('Request body too large'));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function listCandidateWorkspaces(rootDir) {
  const base = path.resolve(rootDir || os.homedir());
  const out = [{ name: path.basename(base) || base, path: base }];
  try {
    const entries = fs.readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
        out.push({ name: e.name, path: path.join(base, e.name) });
        if (out.length >= 25) break;
      }
    }
  } catch (_) {}
  return out;
}

function createRemoteServer({ port = 0, host = '127.0.0.1', token, workspaceRoot } = {}) {
  const activeToken = String(token || '').trim() || crypto.randomBytes(24).toString('hex');
  const rootDir = path.resolve(workspaceRoot || os.homedir());

  const server = http.createServer(async (req, res) => {
    if (!timingSafeBearer(req.headers.authorization, activeToken)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const p = u.pathname;

    try {
      if (req.method === 'GET' && p === '/v1/env/ping') {
        return sendJson(res, 200, {
          ok: true,
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          cwd: rootDir,
          version: '1.0.0',
        });
      }

      if (req.method === 'GET' && p === '/v1/env/workspaces') {
        return sendJson(res, 200, { ok: true, workspaces: listCandidateWorkspaces(rootDir) });
      }

      if (req.method === 'POST' && p === '/v1/env/fs') {
        const b = await readJsonBody(req);
        const op = b.op;
        if (op === 'readTree') return sendJson(res, 200, fsWatcher.readTree(b.cwd || rootDir, b));
        if (op === 'readFile') return sendJson(res, 200, fsWatcher.readFile(b.path, b));
        if (op === 'writeFile') return sendJson(res, 200, fsWatcher.writeFile(b.path, b.content));
        if (op === 'createEntry') return sendJson(res, 200, fsWatcher.createEntry(b.path, b.kind));
        if (op === 'renameEntry') return sendJson(res, 200, fsWatcher.renameEntry(b.oldPath, b.newPath));
        if (op === 'duplicateEntry') return sendJson(res, 200, fsWatcher.duplicateEntry(b.path));
        if (op === 'deleteEntry') return sendJson(res, 200, fsWatcher.deleteEntry(b.path));
        return sendJson(res, 400, { ok: false, error: 'Unsupported fs op: ' + op });
      }

      if (req.method === 'POST' && p === '/v1/env/search') {
        const b = await readJsonBody(req);
        const op = b.op || 'search';
        if (op === 'replace') return sendJson(res, 200, await search.replaceInWorkspace(b));
        return sendJson(res, 200, await search.searchWorkspace(b));
      }

      if (req.method === 'POST' && p === '/v1/env/git') {
        const b = await readJsonBody(req);
        const op = b.op;
        const cwd = b.cwd || rootDir;
        if (op === 'status') return sendJson(res, 200, await git.gitStatusDetailed(cwd));
        if (op === 'stage') return sendJson(res, 200, await git.stageFiles(cwd, b.files));
        if (op === 'unstage') return sendJson(res, 200, await git.unstageFiles(cwd, b.files));
        if (op === 'stagePatch') return sendJson(res, 200, await git.stagePatch(cwd, b.patch, !!b.reverse));
        if (op === 'discard') return sendJson(res, 200, await git.discardFiles(cwd, b.files));
        if (op === 'commit') return sendJson(res, 200, await git.commitChanges(cwd, b.message));
        if (op === 'branches') return sendJson(res, 200, await git.listBranches(cwd));
        if (op === 'checkout') return sendJson(res, 200, await git.checkoutBranch(cwd, b.branch, !!b.createNew));
        if (op === 'fileAtHead') return sendJson(res, 200, await git.fileAtHead(cwd, b.path));
        return sendJson(res, 400, { ok: false, error: 'Unsupported git op: ' + op });
      }

      if (req.method === 'POST' && p === '/v1/env/tool') {
        const b = await readJsonBody(req);
        const out = await tools.runTool(String(b.name || ''), { ...(b.args || {}) }, {
          forceLocal: true,
          cwd: (b.args && b.args.cwd) || rootDir,
        });
        const result = out && typeof out === 'object' && 'content' in out ? out.content : String(out || '');
        return sendJson(res, 200, { ok: true, result });
      }

      return sendJson(res, 404, { ok: false, error: 'Not found' });
    } catch (err) {
      return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname !== '/v1/env/pty' || !timingSafeBearer(req.headers.authorization, activeToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const cwd = u.searchParams.get('cwd') || rootDir;
      const cols = Number(u.searchParams.get('cols')) || 100;
      const rows = Number(u.searchParams.get('rows')) || 28;
      const session = ptyMod.createPty(
        { cwd, cols, rows, localOnly: true },
        {
          onData: (_id, data) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'data', data }));
          },
          onExit: (_id, exitCode) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: 'exit', exitCode }));
              ws.close();
            }
          },
        }
      );
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'ready', id: session.id, shell: session.shell, cwd: session.cwd }));
      }
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(String(raw || '{}'));
          if (msg.type === 'write') ptyMod.writePty(session.id, msg.data);
          else if (msg.type === 'resize') ptyMod.resizePty(session.id, msg.cols, msg.rows);
          else if (msg.type === 'kill') ptyMod.killPty(session.id);
        } catch (_) {}
      });
      ws.on('close', () => {
        try { ptyMod.killPty(session.id); } catch (_) {}
      });
    });
  });

  return {
    token: activeToken,
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const addr = server.address();
          resolve({ ok: true, host, port: addr.port, url: `http://${host}:${addr.port}`, token: activeToken });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        for (const c of wss.clients) { try { c.terminate(); } catch (_) {} }
        try { wss.close(); } catch (_) {}
        server.close(() => resolve({ ok: true }));
      });
    },
  };
}

module.exports = { createRemoteServer, timingSafeBearer };
