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
function startShell({ command, cwd, shell = '/bin/zsh', env, dangerouslyDisableSandbox } = {}) {
  if (!command) throw new Error('command required');
  const job = create('shell', { command, cwd });
  let file = shell; let args = ['-l', '-c', String(command)];
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
  });
  job.stop = () => { try { child.kill('SIGTERM'); } catch (_) {} };
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
// `run` is any async function returning the agent's final text.
function startAgent({ label, description, model, run } = {}) {
  const job = create('agent', { label: label || description, description, model });
  let stopped = false;
  job.stop = () => { stopped = true; finish(job, 'stopped'); };
  job.done = (async () => {
    try {
      const out = await Promise.resolve().then(() => (typeof run === 'function' ? run({ isStopped: () => stopped }) : ''));
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
  const child = spawn('/bin/zsh', ['-l', '-c', String(command)], {
    cwd: cwd || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
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
