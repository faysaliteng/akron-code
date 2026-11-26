'use strict';
const fs = require('fs');

function loadNodePty() {
  try {
    return require('node-pty');
  } catch (_) {
    try {
      const resolved = require.resolve('node-pty').replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
      if (fs.existsSync(resolved)) return require(resolved);
    } catch (__) {}
    return null;
  }
}

const nodePty = loadNodePty();
const sessions = new Map();
const parentPort = process.parentPort || null;
let shuttingDown = false;
let shutdownTimer = null;

function safeSend(msg) {
  try {
    if (parentPort) {
      parentPort.postMessage(msg);
      return;
    }
    if (process.connected && typeof process.send === 'function') {
      process.send(msg);
    }
  } catch (_) {}
}

function finishShutdown() {
  if (shutdownTimer) {
    clearTimeout(shutdownTimer);
    shutdownTimer = null;
  }
  safeSend({ type: 'shutdown-ack' });
  setImmediate(() => process.exit(0));
}

function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const [, proc] of sessions) {
    try { proc.kill(); } catch (_) {}
  }
  if (sessions.size === 0) {
    finishShutdown();
    return;
  }
  shutdownTimer = setTimeout(() => {
    sessions.clear();
    finishShutdown();
  }, 140);
}

function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  const { type, id } = msg;

  if (type === 'init') {
    safeSend({ type: 'ready', ok: !!nodePty });
    return;
  }

  if (type === 'create') {
    if (shuttingDown || !nodePty) {
      safeSend({ type: 'created', id, ok: false, error: !nodePty ? 'node-pty unavailable' : 'shutting down' });
      return;
    }
    try {
      const ptyProc = nodePty.spawn(msg.shellBin, Array.isArray(msg.shellArgs) ? msg.shellArgs : [], {
        name: 'xterm-256color',
        cols: msg.cols || 100,
        rows: msg.rows || 28,
        cwd: msg.cwd,
        env: msg.env || process.env,
        useConpty: !!msg.useConpty,
      });
      sessions.set(id, ptyProc);
      ptyProc.onData((data) => {
        if (!shuttingDown) safeSend({ type: 'data', id, data });
      });
      ptyProc.onExit((e) => {
        sessions.delete(id);
        if (!shuttingDown) {
          safeSend({ type: 'exit', id, exitCode: e && typeof e.exitCode === 'number' ? e.exitCode : 0 });
        } else if (sessions.size === 0) {
          finishShutdown();
        }
      });
      safeSend({ type: 'created', id, ok: true, shell: msg.shellBin });
    } catch (err) {
      safeSend({ type: 'created', id, ok: false, error: err && err.message ? err.message : String(err) });
    }
    return;
  }

  if (type === 'write') {
    const p = sessions.get(id);
    if (p) {
      try { p.write(String(msg.data == null ? '' : msg.data)); } catch (_) {}
    }
    return;
  }

  if (type === 'resize') {
    const p = sessions.get(id);
    if (p) {
      try {
        p.resize(Math.max(20, Number(msg.cols) || 100), Math.max(5, Number(msg.rows) || 28));
      } catch (_) {}
    }
    return;
  }

  if (type === 'kill') {
    const p = sessions.get(id);
    if (p) {
      sessions.delete(id);
      try { p.kill(); } catch (_) {}
    }
    return;
  }

  if (type === 'shutdown') {
    beginShutdown();
  }
}

if (parentPort) {
  parentPort.on('message', (evt) => handleMessage(evt && evt.data !== undefined ? evt.data : evt));
} else {
  process.on('message', handleMessage);
}

process.on('disconnect', beginShutdown);
process.on('SIGTERM', beginShutdown);
process.on('SIGINT', beginShutdown);
