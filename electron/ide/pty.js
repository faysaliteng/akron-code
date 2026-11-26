'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { StringDecoder } = require('string_decoder');

const sessions = new Map(); // id -> { id, backend, write, resize, kill, cwd, shell }
let seq = 1;
let cachedPython3 = undefined;
let workerProc = null;
let workerDead = false;

function findPython3() {
  if (cachedPython3 !== undefined) return cachedPython3;
  const candidates = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'];
  for (const bin of candidates) {
    try {
      if (fs.existsSync(bin)) {
        cachedPython3 = bin;
        return cachedPython3;
      }
    } catch (_) {}
  }
  cachedPython3 = null;
  return null;
}

function resolveWorkerScript() {
  const local = path.join(__dirname, 'pty-worker.js');
  const unpacked = local.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
  if (unpacked !== local && fs.existsSync(unpacked)) return unpacked;
  return local;
}

const PY_PTY_HELPER = `
import os, sys, pty, fcntl, struct, termios, select, signal

shell = sys.argv[1]
cols = int(sys.argv[2])
rows = int(sys.argv[3])

pid, master_fd = pty.fork()
if pid == 0:
    try:
        fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:
        pass
    os.environ["TERM"] = "xterm-256color"
    os.execv(shell, [shell, "-i"])

def set_size(r, c):
    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except Exception:
        pass

set_size(rows, cols)

def on_term(_signum, _frame):
    try:
        os.kill(pid, signal.SIGHUP)
    except Exception:
        pass
    try:
        os.kill(pid, signal.SIGKILL)
    except Exception:
        pass
    try:
        os.close(master_fd)
    except Exception:
        pass
    sys.exit(0)

signal.signal(signal.SIGTERM, on_term)
signal.signal(signal.SIGHUP, on_term)

stdin_fd = 0

while True:
    watch = [master_fd, stdin_fd]
    try:
        rlist, _, _ = select.select(watch, [], [], 0.25)
    except Exception:
        break
    if master_fd in rlist:
        try:
            data = os.read(master_fd, 4096)
            if not data:
                break
            os.write(1, data)
        except OSError:
            break
    if stdin_fd in rlist:
        try:
            data = os.read(stdin_fd, 4096)
            if not data:
                break
            if b"\\x1b]777;resize;" in data:
                parts = data.split(b"\\x1b]777;resize;")
                if parts[0]:
                    os.write(master_fd, parts[0])
                for seg in parts[1:]:
                    end = seg.find(b"\\x07")
                    if end >= 0:
                        dim = seg[:end].decode("utf8", "ignore").split(",")
                        if len(dim) == 2:
                            try:
                                set_size(int(dim[1]), int(dim[0]))
                            except Exception:
                                pass
                        rest = seg[end+1:]
                        if rest:
                            os.write(master_fd, rest)
            else:
                os.write(master_fd, data)
        except OSError:
            break
    try:
        wpid, status = os.waitpid(pid, os.WNOHANG)
        if wpid == pid:
            break
    except ChildProcessError:
        break

try:
    os.close(master_fd)
except Exception:
    pass
`;

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC ? 'powershell.exe' : 'powershell.exe';
  return process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/zsh';
}

function startPipeOrPythonSession(id, opts, { cwd, cols, rows, shellBin, env, onData, onExit, pendingWrites, pendingResize }) {
  const pyBin = (!opts.forcePipe && process.platform !== 'win32') ? findPython3() : null;
  const usePy = !!pyBin;
  const child = usePy
    ? spawn(pyBin, ['-u', '-c', PY_PTY_HELPER, shellBin, String(cols), String(rows)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(shellBin, process.platform === 'win32' ? ['-NoLogo'] : ['-i'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  const outDec = new StringDecoder('utf8');
  const errDec = new StringDecoder('utf8');
  child.stdout.on('data', (chunk) => {
    const s = outDec.write(chunk);
    if (s) onData(id, s);
  });
  child.stderr.on('data', (chunk) => {
    const s = errDec.write(chunk);
    if (s) onData(id, s);
  });

  let closed = false;
  child.on('close', (code) => {
    if (closed) return;
    closed = true;
    const remOut = outDec.end();
    if (remOut) onData(id, remOut);
    const remErr = errDec.end();
    if (remErr) onData(id, remErr);
    sessions.delete(id);
    onExit(id, code == null ? 0 : code);
  });
  child.on('error', (err) => {
    onData(id, `\r\n[Terminal error: ${err.message}]\r\n`);
  });

  const rec = {
    id,
    backend: usePy ? 'python-pty' : 'pipe',
    cwd,
    shell: path.basename(shellBin),
    write: (d) => {
      try { if (child.stdin.writable) child.stdin.write(d); } catch (_) {}
    },
    resize: (c, r) => {
      if (usePy && child.stdin.writable) {
        try {
          const colsSafe = Math.max(20, Number(c) || cols);
          const rowsSafe = Math.max(5, Number(r) || rows);
          child.stdin.write(`\x1b]777;resize;${colsSafe},${rowsSafe}\x07`);
        } catch (_) {}
      }
    },
    kill: () => {
      sessions.delete(id);
      try { child.kill('SIGTERM'); } catch (_) {}
      const force = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) {}
      }, 60);
      if (force && typeof force.unref === 'function') force.unref();
    },
  };
  sessions.set(id, rec);

  if (pendingResize) rec.resize(pendingResize[0], pendingResize[1]);
  if (Array.isArray(pendingWrites) && pendingWrites.length) {
    for (const chunk of pendingWrites) rec.write(chunk);
  }
  return rec;
}

const workerCallbacks = new Map(); // id -> { opts, cwd, cols, rows, shellBin, env, onData, onExit, ready, pendingWrites, pendingResize }

function ensureWorker() {
  if (workerProc && !workerProc.killed && workerProc.connected && !workerDead) return workerProc;
  workerDead = false;
  const scriptPath = resolveWorkerScript();
  const child = spawn(process.execPath, [scriptPath], {
    cwd: os.homedir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  workerProc = child;

  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    const cb = workerCallbacks.get(msg.id);
    if (!cb) return;

    if (msg.type === 'created') {
      if (msg.ok) {
        cb.ready = true;
        if (cb.pendingResize) {
          try { child.send({ type: 'resize', id: msg.id, cols: cb.pendingResize[0], rows: cb.pendingResize[1] }); } catch (_) {}
          cb.pendingResize = null;
        }
        if (cb.pendingWrites.length) {
          for (const data of cb.pendingWrites) {
            try { child.send({ type: 'write', id: msg.id, data }); } catch (_) {}
          }
          cb.pendingWrites.length = 0;
        }
      } else {
        workerCallbacks.delete(msg.id);
        if (sessions.has(msg.id)) {
          startPipeOrPythonSession(msg.id, cb.opts, cb);
        }
      }
      return;
    }

    if (msg.type === 'data') {
      cb.onData(msg.id, msg.data);
      return;
    }

    if (msg.type === 'exit') {
      workerCallbacks.delete(msg.id);
      sessions.delete(msg.id);
      cb.onExit(msg.id, msg.exitCode == null ? 0 : msg.exitCode);
    }
  });

  child.on('exit', () => {
    if (workerProc === child) workerProc = null;
    workerDead = true;
    for (const [id, cb] of [...workerCallbacks.entries()]) {
      workerCallbacks.delete(id);
      if (sessions.has(id) && !cb.ready) {
        startPipeOrPythonSession(id, cb.opts, cb);
      } else if (sessions.has(id)) {
        sessions.delete(id);
        cb.onExit(id, 0);
      }
    }
  });

  child.on('error', () => {
    if (workerProc === child) workerProc = null;
    workerDead = true;
  });

  try { child.send({ type: 'init' }); } catch (_) {}
  return child;
}

function createPty(opts = {}, handlers = {}) {
  const id = `pty-${seq++}`;
  const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir();
  const cols = Math.max(20, Math.min(400, Number(opts.cols) || 100));
  const rows = Math.max(5, Math.min(200, Number(opts.rows) || 28));
  const shellBin = defaultShell();
  const env = {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  };
  const onData = typeof handlers.onData === 'function' ? handlers.onData : () => {};
  const onExit = typeof handlers.onExit === 'function' ? handlers.onExit : () => {};

  // POSIX with python3: use native kernel pty.fork() directly so pty.node is never loaded in Electron.
  const pyBin = (!opts.forceFallback && !opts.forcePipe && !opts.forceWorker && process.platform !== 'win32') ? findPython3() : null;
  if (pyBin) {
    const rec = startPipeOrPythonSession(id, opts, { cwd, cols, rows, shellBin, env, onData, onExit });
    return { ok: true, id, backend: rec.backend, cwd, shell: rec.shell };
  }

  // Windows ConPTY or POSIX without python3: isolate node-pty in a dedicated child worker process
  // so pty.node's ThreadSafeFunction never runs inside Electron's CrBrowserMain.
  if (!opts.forceFallback && !opts.forcePipe) {
    try {
      const child = ensureWorker();
      const shellArgs = process.platform === 'win32' ? ['-NoLogo'] : ['-i'];
      const cb = {
        opts,
        cwd,
        cols,
        rows,
        shellBin,
        env,
        onData,
        onExit,
        ready: false,
        pendingWrites: [],
        pendingResize: null,
      };
      workerCallbacks.set(id, cb);

      const rec = {
        id,
        backend: 'node-pty-worker',
        cwd,
        shell: path.basename(shellBin),
        write: (d) => {
          const text = String(d == null ? '' : d);
          if (!cb.ready) {
            cb.pendingWrites.push(text);
            return;
          }
          try { if (child.connected) child.send({ type: 'write', id, data: text }); } catch (_) {}
        },
        resize: (c, r) => {
          const colsSafe = Math.max(20, Number(c) || cols);
          const rowsSafe = Math.max(5, Number(r) || rows);
          if (!cb.ready) {
            cb.pendingResize = [colsSafe, rowsSafe];
            return;
          }
          try { if (child.connected) child.send({ type: 'resize', id, cols: colsSafe, rows: rowsSafe }); } catch (_) {}
        },
        kill: () => {
          sessions.delete(id);
          workerCallbacks.delete(id);
          try { if (child.connected) child.send({ type: 'kill', id }); } catch (_) {}
        },
      };
      sessions.set(id, rec);

      child.send({
        type: 'create',
        id,
        shellBin,
        shellArgs,
        cols,
        rows,
        cwd,
        env,
        useConpty: process.platform === 'win32',
      });
      return { ok: true, id, backend: rec.backend, cwd, shell: rec.shell };
    } catch (_) {
      workerCallbacks.delete(id);
      sessions.delete(id);
    }
  }

  const rec = startPipeOrPythonSession(id, { ...opts, forcePipe: true }, { cwd, cols, rows, shellBin, env, onData, onExit });
  return { ok: true, id, backend: rec.backend, cwd, shell: rec.shell };
}

function writePty(id, data) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'PTY session not found' };
  s.write(String(data == null ? '' : data));
  return { ok: true };
}

function resizePty(id, cols, rows) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'PTY session not found' };
  s.resize(cols, rows);
  return { ok: true };
}

function killPty(id) {
  const s = sessions.get(id);
  if (!s) return { ok: false, error: 'PTY session not found' };
  s.kill();
  return { ok: true };
}

function listPtys() {
  return [...sessions.values()].map(({ id, backend, cwd, shell }) => ({ id, backend, cwd, shell }));
}

function killAll() {
  for (const id of [...sessions.keys()]) killPty(id);
}

function hasActiveSessions() {
  return sessions.size > 0 || !!workerProc;
}

function shutdown() {
  killAll();
  const child = workerProc;
  if (!child) return Promise.resolve();
  workerProc = null;
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const t = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish();
    }, 180);
    if (t && typeof t.unref === 'function') t.unref();

    child.once('exit', () => {
      clearTimeout(t);
      finish();
    });
    child.on('message', (m) => {
      if (m && m.type === 'shutdown-ack') {
        clearTimeout(t);
        finish();
      }
    });
    try {
      if (child.connected) child.send({ type: 'shutdown' });
      else child.kill('SIGTERM');
    } catch (_) {
      clearTimeout(t);
      finish();
    }
  });
}

module.exports = { createPty, writePty, resizePty, killPty, listPtys, killAll, hasActiveSessions, shutdown };
