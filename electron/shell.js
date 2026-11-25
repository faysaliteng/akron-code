'use strict';
const { spawn } = require('child_process');

// Background shell manager — mirrors Example's terminal MCP (mcp__terminal__*)
// and powers the Bash tool's background mode + KillShell.
// Each shell is a long-lived zsh process with a PTY-like I/O buffer.

class ShellManager {
  constructor() {
    this.shells = new Map(); // id -> { proc, buffer, listeners, cwd }
    this.nextId = 1;
    this.maxBuffer = 200000; // chars
  }

  // Spawn a persistent shell in a given cwd.
  start({ cwd, shell = '/bin/zsh' } = {}) {
    const id = 'sh' + this.nextId++;
    const proc = spawn(shell, ['-i'], {
      cwd: cwd || process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', PS1: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry = { proc, buffer: '', listeners: [], cwd: cwd || process.cwd() };
    this.shells.set(id, entry);

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
      entry.proc.stdin.write(command + `; echo "\n${marker}\n"\n`);
      const poll = setInterval(() => {
        if (entry.buffer.includes(marker)) {
          clearInterval(poll);
          clearTimeout(timer);
          entry.listeners = entry.listeners.filter((l) => l !== onData);
          const out = entry.buffer.replace(marker, '').trim();
          entry.buffer = out; // strip marker from raw buffer so read() is clean
          resolve(out || '(no output)');
        } else if (entry.exited) {
          clearInterval(poll);
          cleanup();
          resolve(entry.buffer + '\n[shell exited]');
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
    return entry ? entry.buffer : '';
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
    try { entry.proc.kill('SIGKILL'); } catch (_) {}
    this.shells.delete(id);
    return true;
  }

  killAll() {
    for (const id of [...this.shells.keys()]) this.kill(id);
  }
}

module.exports = { ShellManager };
