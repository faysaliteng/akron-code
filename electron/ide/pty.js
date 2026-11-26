'use strict';
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const sessions = new Map(); // id -> { backend, write, resize, kill, cwd, title }
let seq = 1;

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

const PY_PTY_HELPER = `
import os, sys, pty, fcntl, struct, termios, select, signal, json

shell = sys.argv[1]
cols = int(sys.argv[2])
rows = int(sys.argv[3])

pid, master_fd = pty.fork()
if pid == 0:
    os.execv(shell, [shell, "-i"])

def set_size(r, c):
    try:
        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))
    except Exception:
        pass

set_size(rows, cols)

ctrl_fd = 3
stdin_fd = 0
buf = b""

while True:
    watch = [master_fd, stdin_fd]
    try:
        rlist, _, _ = select.select(watch, [], [], 0.05)
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

  const nodePty = opts.forceFallback ? null : loadNodePty();
  if (nodePty) {
    try {
      const shellArgs = process.platform === 'win32' ? ['-NoLogo'] : ['-i'];
      const ptyProc = nodePty.spawn(shellBin, shellArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd,
        env,
        useConpty: process.platform === 'win32',
      });
      ptyProc.onData((data) => onData(id, data));
      ptyProc.onExit((e) => {
        sessions.delete(id);
        onExit(id, e ? e.exitCode : 0);
      });
      const rec = {
        id,
        backend: 'node-pty',
        cwd,
        shell: path.basename(shellBin),
        write: (d) => { try { ptyProc.write(d); } catch (_) {} },
        resize: (c, r) => {
          try {
            ptyProc.resize(Math.max(20, Number(c) || cols), Math.max(5, Number(r) || rows));
          } catch (_) {}
        },
        kill: () => {
          sessions.delete(id);
          try { ptyProc.kill(); } catch (_) {}
        },
      };
      sessions.set(id, rec);
      return { ok: true, id, backend: 'node-pty', cwd, shell: rec.shell };
    } catch (_) {
      // Fall through to python pty / pipe fallback cleanly
    }
  }

  // Fallback path (cross-platform, zero native ABI risk)
  const usePy = process.platform !== 'win32' && (fs.existsSync('/usr/bin/python3') || fs.existsSync('/usr/local/bin/python3') || fs.existsSync('/opt/homebrew/bin/python3'));
  const child = usePy
    ? spawn('python3', ['-u', '-c', PY_PTY_HELPER, shellBin, String(cols), String(rows)], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
    : spawn(shellBin, process.platform === 'win32' ? ['-NoLogo'] : ['-i'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

  child.stdout.on('data', (chunk) => onData(id, chunk.toString('utf8')));
  child.stderr.on('data', (chunk) => onData(id, chunk.toString('utf8')));
  child.on('close', (code) => {
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
    write: (d) => { try { if (child.stdin.writable) child.stdin.write(d); } catch (_) {} },
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
      try { child.kill('SIGKILL'); } catch (_) {}
    },
  };
  sessions.set(id, rec);
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

module.exports = { createPty, writePty, resizePty, killPty, listPtys, killAll };
