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
const { WebSocketServer, WebSocket } = require('ws');
const fsWatcher = require('./ide/fs-watcher');
const search = require('./ide/search');
const git = require('./git');
const ptyMod = require('./ide/pty');
const tools = require('./tools');
const { execFileSync } = require('child_process');

const MAX_BODY = 16 * 1024 * 1024;

function defaultDataDir() {
  return path.join(os.homedir(), '.autobot');
}

function killSwitchPath(dataDir = defaultDataDir()) {
  return path.join(dataDir || defaultDataDir(), 'remote.OFF');
}

function isKillSwitchActive(dataDir = defaultDataDir()) {
  try { return fs.existsSync(killSwitchPath(dataDir)); } catch (_) { return false; }
}

const activeRelays = new Set();

function setKillSwitch(active, dataDir = defaultDataDir()) {
  const fp = killSwitchPath(dataDir);
  if (active) {
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    fs.writeFileSync(fp, `REMOTE_KILL_SWITCH_ACTIVE=${new Date().toISOString()}\n`, { encoding: 'utf8', mode: 0o600 });
    for (const r of activeRelays) {
      try { r.disconnect('kill_switch'); } catch (_) {}
    }
  } else {
    try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
  }
  return { active: isKillSwitchActive(dataDir), path: fp };
}

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

async function readRawBody(req) {
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
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const buf = await readRawBody(req);
  const raw = buf.toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw new Error('Invalid JSON body'); }
}

function verifyGitHubSignature(rawBuf, signatureHeader, secret) {
  if (!secret) return false;
  const sig = String(signatureHeader || '').trim();
  if (!sig.startsWith('sha256=')) return false;
  const expectedHex = crypto.createHmac('sha256', String(secret)).update(rawBuf).digest('hex');
  const expected = Buffer.from(`sha256=${expectedHex}`, 'utf8');
  const supplied = Buffer.from(sig, 'utf8');
  if (expected.length !== supplied.length) return false;
  return crypto.timingSafeEqual(expected, supplied);
}

async function runIsolatedWebhookReview({ payload, event, rootDir, githubToken, onWebhookReview, onGitHubComment }) {
  const pr = payload.pull_request || payload.issue || null;
  const sha = payload.pull_request?.head?.sha || payload.after || 'HEAD';
  const commentsUrl = payload.pull_request?.comments_url || payload.issue?.comments_url || '';
  const hasGit = fs.existsSync(path.join(rootDir, '.git'));
  let workDir = rootDir;
  let worktreeCreated = false;
  let tmpWt = '';
  let diffSummary = '';
  try {
    if (hasGit) {
      tmpWt = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-webhook-wt-'));
      fs.rmSync(tmpWt, { recursive: true, force: true });
      let ref = 'HEAD';
      try {
        execFileSync('git', ['-C', rootDir, 'rev-parse', '--verify', `${sha}^{commit}`], { stdio: 'ignore' });
        ref = sha;
      } catch (_) {}
      execFileSync('git', ['-C', rootDir, 'worktree', 'add', '--detach', tmpWt, ref], { stdio: 'ignore' });
      workDir = tmpWt;
      worktreeCreated = true;
      try {
        diffSummary = execFileSync('git', ['-C', workDir, 'show', '--stat', '--oneline', '-1'], { encoding: 'utf8' });
      } catch (_) {}
    }
    const review = typeof onWebhookReview === 'function'
      ? await onWebhookReview({ event, payload, pr, cwd: workDir, rootDir, diffSummary })
      : { ok: true, summary: `Akron Code verified ${event}${pr?.number ? ` #${pr.number}` : ''} in isolated worktree.` };
    const bodyText = String(review?.summary || review?.text || 'Akron Code review complete.');
    if (commentsUrl && typeof onGitHubComment === 'function') {
      await onGitHubComment({ commentsUrl, body: bodyText, event, pr });
    } else if (commentsUrl && githubToken && /^https:\/\//i.test(commentsUrl)) {
      await fetch(commentsUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'akron-code-webhook-bot',
        },
        body: JSON.stringify({ body: bodyText }),
      }).catch(() => {});
    }
    return {
      ok: true,
      event,
      worktreeIsolated: worktreeCreated,
      workDir,
      summary: bodyText,
      commentPosted: Boolean(commentsUrl && (typeof onGitHubComment === 'function' || githubToken)),
    };
  } finally {
    if (worktreeCreated && tmpWt) {
      try { execFileSync('git', ['-C', rootDir, 'worktree', 'remove', '--force', tmpWt], { stdio: 'ignore' }); } catch (_) {}
      try { fs.rmSync(tmpWt, { recursive: true, force: true }); } catch (_) {}
    }
  }
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

function createRemoteServer({
  port = 0,
  host = '127.0.0.1',
  token,
  workspaceRoot,
  dataDir = defaultDataDir(),
  webhookSecret = process.env.AKRON_GITHUB_WEBHOOK_SECRET || '',
  githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
  onWebhookReview = null,
  onGitHubComment = null,
} = {}) {
  const activeToken = String(token || '').trim() || crypto.randomBytes(24).toString('hex');
  const activeWebhookSecret = String(webhookSecret || '').trim();
  const rootDir = path.resolve(workspaceRoot || os.homedir());

  const server = http.createServer(async (req, res) => {
    if (isKillSwitchActive(dataDir)) {
      return sendJson(res, 503, { ok: false, error: 'Remote kill switch active (remote.OFF)' });
    }
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    const p = u.pathname;

    if (req.method === 'POST' && p === '/webhooks/github') {
      try {
        if (!activeWebhookSecret) {
          return sendJson(res, 403, { ok: false, error: 'GitHub webhook secret not configured' });
        }
        const rawBuf = await readRawBody(req);
        if (!verifyGitHubSignature(rawBuf, req.headers['x-hub-signature-256'], activeWebhookSecret)) {
          return sendJson(res, 401, { ok: false, error: 'Invalid GitHub webhook signature' });
        }
        const payload = JSON.parse(rawBuf.toString('utf8') || '{}');
        const event = String(req.headers['x-github-event'] || 'ping');
        const action = String(payload.action || '');
        const commentBody = String(payload.comment?.body || '');
        const prTrigger = event === 'pull_request' && ['opened', 'synchronize', 'reopened'].includes(action);
        const commentTrigger = event === 'issue_comment' && action === 'created' && /(@akron\b|\/review\b)/i.test(commentBody);
        if (!prTrigger && !commentTrigger) {
          return sendJson(res, 200, { ok: true, ignored: true, event, action });
        }
        const result = await runIsolatedWebhookReview({
          payload,
          event,
          rootDir,
          githubToken,
          onWebhookReview,
          onGitHubComment,
        });
        return sendJson(res, 200, result);
      } catch (err) {
        return sendJson(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
      }
    }

    if (!timingSafeBearer(req.headers.authorization, activeToken)) {
      return sendJson(res, 401, { ok: false, error: 'Unauthorized' });
    }

    try {
      if (req.method === 'GET' && p === '/v1/env/ping') {
        return sendJson(res, 200, {
          ok: true,
          hostname: os.hostname(),
          platform: process.platform,
          arch: process.arch,
          cwd: rootDir,
          version: (() => { try { return require('../package.json').version || '1.3.0'; } catch (_) { return '1.3.0'; } })(),
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
    if (isKillSwitchActive(dataDir)) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }
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

function createOutboundRelay({ relayUrl, token = '', onCommand = null, dataDir = defaultDataDir(), wsFactory = null } = {}) {
  let ws = null;
  let connected = false;
  let stopped = false;

  const disconnect = (reason = 'manual') => {
    stopped = true;
    connected = false;
    activeRelays.delete(api);
    if (ws) {
      try { ws.close(1000, reason); } catch (_) {}
      try { ws.terminate && ws.terminate(); } catch (_) {}
      ws = null;
    }
    return { ok: true, connected: false, reason };
  };

  const connect = () => {
    if (isKillSwitchActive(dataDir)) {
      return { ok: false, connected: false, error: 'Kill switch active (remote.OFF)' };
    }
    if (!relayUrl) return { ok: false, connected: false, error: 'Relay URL is required.' };
    stopped = false;
    const makeWs = wsFactory || ((url, opts) => new WebSocket(url, opts));
    ws = makeWs(relayUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    activeRelays.add(api);

    const onOpen = () => {
      if (isKillSwitchActive(dataDir) || stopped) return disconnect('kill_switch');
      connected = true;
      try { ws.send(JSON.stringify({ type: 'hello', role: 'host', ts: Date.now() })); } catch (_) {}
    };

    const onMessage = async (raw) => {
      if (isKillSwitchActive(dataDir)) return disconnect('kill_switch');
      let msg;
      try { msg = JSON.parse(String(raw || '{}')); } catch (_) { return; }
      if (!msg || typeof msg !== 'object') return;
      if (typeof onCommand === 'function') {
        try {
          const result = await onCommand(msg);
          if (msg.id && ws) ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
        } catch (err) {
          if (msg.id && ws) ws.send(JSON.stringify({ id: msg.id, ok: false, error: err.message }));
        }
      }
    };

    const onClose = () => {
      connected = false;
      activeRelays.delete(api);
    };

    if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('close', onClose);
      ws.on('error', () => { connected = false; });
    }
    return { ok: true, connecting: true };
  };

  const status = () => ({
    connected,
    relayUrl: relayUrl || '',
    killSwitchActive: isKillSwitchActive(dataDir),
    killSwitchPath: killSwitchPath(dataDir),
  });

  const api = { connect, disconnect, status };
  return api;
}

module.exports = {
  createRemoteServer,
  createOutboundRelay,
  timingSafeBearer,
  verifyGitHubSignature,
  runIsolatedWebhookReview,
  killSwitchPath,
  isKillSwitchActive,
  setKillSwitch,
};
