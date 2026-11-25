'use strict';
// Helio Bot — Scheduled tasks (Claude Desktop parity).
//
// Claude Desktop exposes scheduled-tasks__create/list/update tools backed by a
// local queue. Helio Bot implements the same surface with a real timer:
// a task = a prompt that is run through the agent on a cadence, with results
// persisted. Cadences: once | every (minutes) | hourly | daily | weekly.
//
// State: ~/.autobot/scheduled-tasks.json  { tasks: [...] }
// A single 30s ticker evaluates due tasks; concurrency is serialized so a slow
// agent run cannot pile up.

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.autobot');
const TASKS_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}
function writeJSON(file, v) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(v, null, 2)); }

let _timer = null;
let _runner = null;
let _busy = false;
let _onEvent = null;

function load() {
  const s = readJSON(TASKS_FILE, { tasks: [] });
  if (!Array.isArray(s.tasks)) s.tasks = [];
  return s;
}
function save(s) { writeJSON(TASKS_FILE, s); }

function nextId() {
  return 'task_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Compute the next fire time (epoch ms) for a task, or null if finished.
function computeNext(task, from) {
  const now = from || Date.now();
  const cadence = task.cadence || 'once';
  if (cadence === 'once') {
    if (task.at) {
      const t = typeof task.at === 'number' ? task.at : Date.parse(task.at);
      if (!isNaN(t)) return task.firedAt ? null : t;
    }
    return task.firedAt ? null : now + 60 * 1000;
  }
  if (cadence === 'every') {
    const m = Math.max(1, Number(task.everyMinutes) || 60);
    return now + m * 60 * 1000;
  }
  if (cadence === 'hourly') {
    const minute = Number(task.minute);
    if (!isNaN(minute) && minute >= 0 && minute <= 59) {
      const d = new Date(now);
      d.setMinutes(minute, 0, 0);
      if (d.getTime() <= now) d.setHours(d.getHours() + 1);
      return d.getTime();
    }
    return now + 60 * 60 * 1000;
  }
  if (cadence === 'daily' || cadence === 'weekly') {
    const hm = String(task.time || '09:00').split(':');
    const hh = Math.max(0, Math.min(23, parseInt(hm[0], 10) || 0));
    const mm = Math.max(0, Math.min(59, parseInt(hm[1], 10) || 0));
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (cadence === 'weekly') {
      const dow = Math.max(0, Math.min(6, Number(task.dayOfWeek) || 0)); // 0=Sun
      const delta = (dow - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + delta);
      if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    } else if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }
  return null;
}

function describe(task) {
  const c = task.cadence || 'once';
  if (c === 'once') return 'once at ' + (task.at ? new Date(task.at).toLocaleString() : 'soon');
  if (c === 'every') return 'every ' + (task.everyMinutes || 60) + ' min';
  if (c === 'hourly') return 'hourly' + (task.minute != null ? ' at :' + String(task.minute).padStart(2, '0') : '');
  if (c === 'weekly') return 'weekly on day ' + (task.dayOfWeek || 0) + ' at ' + (task.time || '09:00');
  return 'daily at ' + (task.time || '09:00');
}

function list() {
  const s = load();
  return s.tasks.map((t) => ({
    ...t,
    schedule: describe(t),
    nextRunAt: t.enabled === false ? null : t.nextRunAt || null,
  }));
}

function create(input) {
  input = input || {};
  if (!input.prompt) return { ok: false, error: 'prompt required' };
  const task = {
    id: nextId(),
    name: input.name || String(input.prompt).slice(0, 48),
    prompt: String(input.prompt),
    cadence: input.cadence || 'once',
    at: input.at || null,
    everyMinutes: input.everyMinutes || null,
    minute: input.minute != null ? Number(input.minute) : null,
    time: input.time || null,
    dayOfWeek: input.dayOfWeek != null ? Number(input.dayOfWeek) : null,
    enabled: input.enabled !== false,
    createdAt: Date.now(),
    firedAt: null,
    runCount: 0,
    lastResult: null,
    lastRunAt: null,
  };
  task.nextRunAt = task.enabled ? computeNext(task) : null;
  const s = load();
  s.tasks.push(task);
  save(s);
  return { ok: true, task: { ...task, schedule: describe(task) } };
}

function update(id, patch) {
  const s = load();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: `Unknown task: ${id}` };
  const allowed = ['name', 'prompt', 'cadence', 'at', 'everyMinutes', 'minute', 'time', 'dayOfWeek', 'enabled'];
  for (const k of allowed) if (patch && k in patch) t[k] = patch[k];
  t.nextRunAt = t.enabled === false ? null : computeNext(t);
  save(s);
  return { ok: true, task: { ...t, schedule: describe(t) } };
}

function remove(id) {
  const s = load();
  const i = s.tasks.findIndex((x) => x.id === id);
  if (i === -1) return { ok: false, error: `Unknown task: ${id}` };
  s.tasks.splice(i, 1);
  save(s);
  return { ok: true, id };
}

async function fire(task) {
  const result = { at: Date.now(), ok: true, output: null, error: null };
  try {
    if (!_runner) throw new Error('no runner wired');
    const out = await _runner({ task });
    result.output = typeof out === 'string' ? out.slice(0, 4000) : JSON.stringify(out).slice(0, 4000);
  } catch (e) {
    result.ok = false;
    result.error = e.message;
  }
  return result;
}

async function runNow(id) {
  const s = load();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: `Unknown task: ${id}` };
  const res = await fire(t);
  // reload (fire may have taken a while)
  const s2 = load();
  const t2 = s2.tasks.find((x) => x.id === id);
  if (t2) {
    t2.firedAt = res.at;
    t2.runCount = (t2.runCount || 0) + 1;
    t2.lastRunAt = res.at;
    t2.lastResult = res;
    if ((t2.cadence || 'once') === 'once') { t2.enabled = false; t2.nextRunAt = null; }
    else if (t2.enabled !== false) t2.nextRunAt = computeNext(t2, res.at);
    save(s2);
  }
  if (_onEvent) { try { _onEvent({ type: 'ran', taskId: id, result: res }); } catch (_) {} }
  return { ok: true, result: res };
}

async function tick() {
  if (_busy) return;
  _busy = true;
  try {
    const s = load();
    const now = Date.now();
    let changed = false;
    for (const t of s.tasks) {
      if (t.enabled === false) continue;
      if (t.nextRunAt == null) { t.nextRunAt = computeNext(t); changed = true; continue; }
      if (t.nextRunAt <= now) {
        // Snapshot the prompt; run outside the array mutation window.
        const due = { ...t };
        try {
          const res = await fire(due);
          t.firedAt = res.at;
          t.runCount = (t.runCount || 0) + 1;
          t.lastRunAt = res.at;
          t.lastResult = res;
          if ((t.cadence || 'once') === 'once') { t.enabled = false; t.nextRunAt = null; }
          else t.nextRunAt = computeNext(t, res.at);
          changed = true;
          if (_onEvent) { try { _onEvent({ type: 'ran', taskId: t.id, result: res }); } catch (_) {} }
        } catch (e) {
          t.lastResult = { at: now, ok: false, error: e.message };
          t.nextRunAt = computeNext(t);
          changed = true;
        }
        save(s);
      }
    }
    if (changed) save(s);
  } finally {
    _busy = false;
  }
}

function start(runner, onEvent) {
  _runner = runner;
  _onEvent = onEvent || null;
  if (_timer) return;
  // Prime any tasks created before the app started.
  const s = load();
  let changed = false;
  for (const t of s.tasks) {
    if (t.enabled !== false && t.nextRunAt == null) { t.nextRunAt = computeNext(t); changed = true; }
  }
  if (changed) save(s);
  _timer = setInterval(() => { tick().catch(() => {}); }, 30000);
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { list, create, update, remove, runNow, tick, start, stop, computeNext, describe, formatList };

function formatList(tasks) {
  if (!tasks || !tasks.length) return 'SCHEDULED TASKS:\n(none)';
  return 'SCHEDULED TASKS:\n' + tasks.map((t) => {
    const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : '—';
    return `- ${t.id} "${t.name}" [${t.schedule}] ${t.enabled === false ? '(disabled)' : 'next: ' + next}\n    prompt: ${String(t.prompt).slice(0, 160)}`;
  }).join('\n');
}
