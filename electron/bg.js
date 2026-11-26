'use strict';
// Background job registry.
//
// Claude Code can start work that outlives the tool call:
//   Bash  { run_in_background: true }      -> id you poll with TaskOutput / stop with KillShell
//   Agent { run_in_background: true }      -> id you poll with TaskOutput / stop with TaskStop
//   Monitor                                -> id you stop with TaskStop
// One registry keyed by a single id space keeps all three addressable, so
// TaskOutput({task_id}) works for whichever kind the model started.
//
// Everything here is transport-free: it only needs child_process + spawn so it
// loads under plain Node (tests import it directly).

const { spawn } = require('child_process');

const MAX_BUFFER = 2 * 1024 * 1024; // chars kept per job
const jobs = new Map();
let seq = 0;

function newId(kind) {
  seq += 1;
  return `${kind === 'shell' ? 'shell' : kind === 'monitor' ? 'mon' : 'agent'}_${Date.now().toString(36)}${seq}`;
}

function create(kind, meta) {
  const job = {
    id: newId(kind),
    kind,                     // 'shell' | 'agent' | 'monitor'
    status: 'running',        // running | completed | failed | stopped
    startedAt: Date.now(),
    endedAt: null,
    output: '',
    result: null,
    error: null,
    meta: meta || {},
    stop: null,
    done: null,               // Promise<void>, always resolves (never rejects)
  };
  jobs.set(job.id, job);
  return job;
}

function append(job, text) {
  if (!text) return;
  job.output += String(text);
  if (job.output.length > MAX_BUFFER) job.output = job.output.slice(-MAX_BUFFER);
}

function finish(job, status, error) {
  if (job.status !== 'running') return;
  job.status = status;
  job.endedAt = Date.now();
  if (error) job.error = String(error && error.message ? error.message : error);
}

function view(job, { full = false } = {}) {
  const elapsed = Math.round(((job.endedAt || Date.now()) - job.startedAt) / 1000);
  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    elapsedSeconds: elapsed,
    label: job.meta.label || job.meta.description || job.meta.command || '',
    output: full ? job.output : job.output.slice(-20000),
    result: job.result,
    error: job.error,
  };
}

// ── Shell jobs ─────────────────────────────────────────────────────────────
function startShell({ command, cwd, shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh', env, dangerouslyDisableSandbox } = {}) {
  if (!command) throw new Error('command required');
  const job = create('shell', { command, cwd });
  let file = shell;
  let args = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(command)]
    : ['-l', '-c', String(command)];
  try {
    const sandbox = require('./sandbox');
    const wrapped = sandbox.wrapShell(command, { dangerouslyDisableSandbox });
    file = wrapped.file; args = wrapped.args;
    if (wrapped.note) append(job, `[${wrapped.note}]\n`);
  } catch (e) {
    append(job, `[sandbox] ${e.message}\n`);
  }
  const child = spawn(file, args, {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  job.stop = () => {
    if (process.platform === 'win32' && child && child.pid) {
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); return; } catch (_) {}
    }
    // Kill the whole tree (detached group), not just zsh.
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) { try { child.kill('SIGTERM'); } catch (__) {} }
    setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {} }, 3000).unref();
  };
  child.stdout.on('data', (d) => append(job, d.toString()));
  child.stderr.on('data', (d) => append(job, d.toString()));
  child.on('error', (e) => { append(job, `\n[spawn error] ${e.message}`); finish(job, 'failed', e); });
  job.done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      if (job.status === 'stopped') { resolve(); return; }
      if (code === 0) finish(job, 'completed');
      else finish(job, 'failed', signal ? `killed by ${signal}` : `exit ${code}`);
      resolve();
    });
    child.on('error', () => resolve());
  });
  job.pid = child.pid;
  return job;
}

// ── Agent jobs ─────────────────────────────────────────────────────────────
// `run` is any async function returning the agent's final text. It receives
// an AbortSignal that fires when the job is stopped (TaskStop), plus a helper
// object: run(signal, { signal, isStopped }). Callers may also pass their own
// `controller` (AbortController) and/or an `onStop` callback.
function startAgent({ label, description, model, run, controller, onStop } = {}) {
  const job = create('agent', { label: label || description, description, model });
  let stopped = false;
  const ac = controller || (typeof AbortController === 'function' ? new AbortController() : null);
  const signal = ac ? ac.signal : undefined;
  job.signal = signal;
  job.stop = () => {
    if (stopped) return;
    stopped = true;
    finish(job, 'stopped');
    try { if (ac && !ac.signal.aborted) ac.abort(new Error('stopped by TaskStop')); } catch (_) {}
    try { if (typeof onStop === 'function') onStop(job); } catch (_) {}
  };
  job.done = (async () => {
    try {
      const out = await Promise.resolve().then(() => (typeof run === 'function' ? run(signal, { signal, isStopped: () => stopped }) : ''));
      if (stopped) return;
      job.result = out == null ? '' : String(out);
      append(job, job.result);
      finish(job, 'completed');
    } catch (e) {
      if (stopped) return;
      finish(job, 'failed', e);
    }
  })();
  return job;
}

// ── Monitor jobs ───────────────────────────────────────────────────────────
// Each stdout line is an event; `onLine` receives them live.
function startMonitor({ command, description, timeoutMs = 300000, persistent = false, cwd, onLine, onExit } = {}) {
  const job = create('monitor', { command, description });
  const shFile = process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh';
  const shArgs = process.platform === 'win32'
    ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', String(command)]
    : ['-l', '-c', String(command)];
  const child = spawn(shFile, shArgs, {
    cwd: cwd || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let timer = null;
  job.stop = () => {
    try { child.kill('SIGTERM'); } catch (_) {}
    if (timer) clearTimeout(timer);
    finish(job, 'stopped');
  };
  let buf = '';
  const feed = (d) => {
    append(job, d.toString());
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try { if (onLine) onLine(line, job); } catch (_) {}
    }
  };
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  if (!persistent && timeoutMs > 0) {
    timer = setTimeout(() => { job.stop && job.stop(); try { if (onExit) onExit(job); } catch (_) {} }, Math.min(Number(timeoutMs) || 300000, 3600000));
  }
  job.done = new Promise((resolve) => {
    child.on('close', () => {
      if (timer) clearTimeout(timer);
      if (job.status === 'running') finish(job, 'completed');
      try { if (onExit) onExit(job); } catch (_) {}
      resolve();
    });
    child.on('error', (e) => { finish(job, 'failed', e); resolve(); });
  });
  return job;
}

// ── Lookup / control ───────────────────────────────────────────────────────
function getJob(id) { return jobs.get(String(id || '')) || null; }

async function waitFor(id, { block = true, timeout = 30000 } = {}) {
  const job = getJob(id);
  if (!job) return null;
  if (!block) return job;
  const ms = Math.min(Math.max(Number(timeout) || 30000, 0), 600000);
  if (job.status !== 'running') return job;
  await Promise.race([
    job.done || Promise.resolve(),
    new Promise((r) => setTimeout(r, ms)),
  ]);
  return job;
}

function stopJob(id) {
  const job = getJob(id);
  if (!job) return false;
  if (job.stop) { try { job.stop(); } catch (_) {} }
  if (job.status === 'running') finish(job, 'stopped');
  return true;
}

function listJobs() { return Array.from(jobs.values()).map((j) => view(j, { full: false })); }
function reset() { for (const j of jobs.values()) { try { j.stop && j.stop(); } catch (_) {} } jobs.clear(); }

module.exports = { startShell, startAgent, startMonitor, getJob, waitFor, stopJob, listJobs, view, reset };
