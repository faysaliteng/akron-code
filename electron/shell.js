'use strict';
const { spawn } = require('child_process');
const path = require('path');

// Background shell manager — mirrors Example's terminal MCP (mcp__terminal__*)
// and powers the Bash tool's background mode + KillShell.
// Each shell is a long-lived zsh process with a PTY-like I/O buffer.

function stripAnsi(s) {
  return String(s == null ? '' : s)
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07\x1B]*(?:\x07|\x1B\\))/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

class ShellManager {
  constructor() {
    this.shells = new Map(); // id -> { proc, buffer, listeners, cwd }
    this.nextId = 1;
    this.maxBuffer = 200000; // chars
  }

  // Spawn a persistent shell in a given cwd.
  start({ cwd, shell = process.platform === 'win32' ? 'powershell.exe' : require('./paths').defaultPosixShell(), pathPrefix = '' } = {}) {
    const id = 'sh' + this.nextId++;
    // `-s`: read commands from stdin even when the parent has a controlling
    // TTY (terminal launch, test runner) — plain `zsh -i` reads /dev/tty there
    // and every command times out. `detached` drops the TTY and gives the
    // shell its own process group so kill() can take its children too.
    const args = process.platform === 'win32' ? ['-NoLogo', '-NoProfile', '-Command', '-'] : ['-i', '-s'];
    const proc = spawn(shell, args, {
      cwd: cwd || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', PS1: '', PS2: '', PROMPT: '', PROMPT2: '', RPROMPT: '', PROMPT_EOL_MARK: '', ZDOTDIR: '/dev/null' },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const entry = { proc, buffer: '', listeners: [], cwd: cwd || process.cwd() };
    this.shells.set(id, entry);

    // Re-assert the runtime dirs *after* the rc files. An interactive zsh runs
    // .zshrc, and third-party installers there (`export PATH="$HOME/.grok/bin:$PATH"`)
    // otherwise put an older global agent ahead of the bundled/self-updated one.
    if (pathPrefix) {
      if (process.platform === 'win32') {
        const joined = String(pathPrefix).split(path.delimiter).filter(Boolean).join(';');
        try { proc.stdin.write(`$env:PATH = "${joined.replace(/"/g, '`"')};" + $env:PATH\n`); } catch (_) {}
      } else {
        const quoted = String(pathPrefix)
          .split(path.delimiter)
          .filter(Boolean)
          .map((d) => '"' + d.replace(/(["\\$`])/g, '\\$1') + '"')
          .join(path.delimiter);
        try { proc.stdin.write('export PATH=' + quoted + ':"$PATH"\n'); } catch (_) { /* ignore */ }
      }
    }

    const feed = (d) => {
      entry.buffer += d.toString();
      if (entry.buffer.length > this.maxBuffer) entry.buffer = entry.buffer.slice(-this.maxBuffer);
      for (const l of entry.listeners) l(d.toString());
    };
    proc.stdout.on('data', feed);
    proc.stderr.on('data', feed);
    proc.on('exit', () => { entry.exited = true; });
    return { id, cwd: entry.cwd };
  }

  // Run a command and wait for completion marker (for the Bash tool).
  run(id, command, { timeoutMs = 60000 } = {}) {
    const entry = this.shells.get(id);
    if (!entry || entry.exited) throw new Error('shell not running');
    const marker = `__AUTOBOT_DONE_${Math.random().toString(36).slice(2)}__`;
    entry.buffer = '';
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve(entry.buffer + '\n[timed out after ' + timeoutMs + 'ms]');
      }, timeoutMs);
      const onData = () => {};
      entry.listeners.push(onData);
      const cleanup = () => {
        clearTimeout(timer);
        entry.listeners = entry.listeners.filter((l) => l !== onData);
      };
      // echo marker so we know when the command finished
      const tail = process.platform === 'win32'
        ? `\nWrite-Output ""\nWrite-Output "${marker}"\n`
        : `; printf '\\n%s\\n' '${marker}'\n`;
      entry.proc.stdin.write(command + tail);
      const poll = setInterval(() => {
        if (entry.buffer.includes(marker)) {
          clearInterval(poll);
          clearTimeout(timer);
          entry.listeners = entry.listeners.filter((l) => l !== onData);
          const cleanOut = (raw) => stripAnsi(raw)
            .replace(/^(?:dquote>\s*)+/gm, '')
            .replace(/(?:\r?\n|^)\s*[%]\s*$/g, '')
            .trim();
          const out = cleanOut(entry.buffer.replace(marker, ''));
          entry.buffer = out; // strip marker from raw buffer so read() is clean
          resolve(out || '(no output)');
        } else if (entry.exited) {
          clearInterval(poll);
          cleanup();
          resolve(stripAnsi(entry.buffer) + '\n[shell exited]');
        }
      }, 80);
    });
  }

  // Raw write (for interactive terminal input).
  write(id, data) {
    const entry = this.shells.get(id);
    if (!entry || entry.exited) throw new Error('shell not running');
    entry.proc.stdin.write(data);
    return true;
  }

  // Non-blocking command start (returns immediately, output collected via read).
  startCommand(id, command) {
    const entry = this.shells.get(id);
    if (!entry || entry.exited) throw new Error('shell not running');
    entry.buffer = '';
    entry.proc.stdin.write(command + '\n');
    return true;
  }

  read(id) {
    const entry = this.shells.get(id);
    return entry ? stripAnsi(entry.buffer).replace(/^(?:dquote>\s*)+/gm, '').replace(/(?:\r?\n|^)\s*[%]\s*$/g, '') : '';
  }

  async list() {
    return [...this.shells.entries()].map(([id, e]) => ({
      id,
      cwd: e.cwd,
      running: !e.exited,
      output: e.buffer.slice(-2000),
    }));
  }

  kill(id) {
    const entry = this.shells.get(id);
    if (!entry) return false;
    try {
      if (process.platform !== 'win32' && entry.proc && entry.proc.pid) {
        try { process.kill(-entry.proc.pid, 'SIGTERM'); } catch (_) {}
        const pid = entry.proc.pid;
        const tk = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch (_) {} }, 800);
        if (tk && typeof tk.unref === 'function') tk.unref();
      } else {
        entry.proc.kill('SIGKILL');
      }
    } catch (_) {}
    this.shells.delete(id);
    return true;
  }

  killAll() {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }
}

module.exports = { ShellManager, stripAnsi };
