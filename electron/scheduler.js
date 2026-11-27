'use strict';
// Akron Bot — Scheduled tasks (Claude Desktop ScheduledTasksManager parity).
//
// Features:
// - Stores state in ~/.autobot/scheduled-tasks.json { tasks: [...] }
// - Stores each task's full prompt & frontmatter in ~/.autobot/scheduled-tasks/{taskId}/SKILL.md
//   (left on disk on delete for prompt recovery, matching Claude Desktop)
// - Mirrors durable cron tasks to .claude/scheduled_tasks.json
// - Supports cadences: once (fireAt/at) | every (min) | hourly | daily | weekdays | weekly | cron | manual
// - Missed-run catch-up on startup/wake (7-day expiry on one-time tasks) + retry backoff (1m -> 5m -> 15m)
// - Per-task run history (up to 25 runs), Stage-1 Attention Gate, cwd, model, permissionMode, & worktree flags.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const cronexpr = require('./cronexpr');

const AUTONOMOUS_SENTINEL = '<<autonomous-loop-dynamic>>';
const DEFAULT_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const ONCE_LATE_PAUSE_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000];
const MAX_RUN_HISTORY = 25;

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}
function writeJSON(file, v) { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(v, null, 2)); }

function createScheduler(opts = {}) {
  const DATA_DIR = opts.dataDir || path.join(os.homedir(), '.autobot');
  const TASKS_FILE = path.join(DATA_DIR, 'scheduled-tasks.json');
  const TASK_FILES_DIR = path.join(DATA_DIR, 'scheduled-tasks');
  const DURABLE_FILE = opts.durableFile || path.join(process.cwd(), '.claude', 'scheduled_tasks.json');

  let _timer = null;
  let _runner = null;
  let _busy = false;
  let _onEvent = null;
  let _resolveFastProvider = null;

  function load() {
    const s = readJSON(TASKS_FILE, { tasks: [] });
    if (!Array.isArray(s.tasks)) s.tasks = [];
    return s;
  }
  function save(s) { writeJSON(TASKS_FILE, s); }

function slugifyTaskId(raw, fallbackName = '') {
  const src = String(raw || fallbackName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (src && /[a-z0-9]/.test(src)) return src;
  return 'task-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
}

function nextUniqueId(requestedId, name, existingTasks) {
  const taken = new Set((existingTasks || []).map((t) => t && t.id).filter(Boolean));
  const base = slugifyTaskId(requestedId, name);
  if (!taken.has(base)) return base;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${crypto.randomBytes(2).toString('hex')}`;
}

function taskSkillFilePath(taskId) {
  const cleanId = slugifyTaskId(taskId);
  return path.join(TASK_FILES_DIR, cleanId, 'SKILL.md');
}

function yamlStr(v) {
  return JSON.stringify(String(v == null ? '' : v));
}

function writeTaskSkillFile(task) {
  if (!task || !task.id) return '';
  const fp = task.filePath || taskSkillFilePath(task.id);
  try {
    ensureDir(path.dirname(fp));
    const fm = [
      '---',
      `name: ${yamlStr(task.name || task.id)}`,
      `description: ${yamlStr(task.description || String(task.prompt || '').slice(0, 120))}`,
      `cadence: ${yamlStr(task.cadence || 'once')}`,
      ...(task.cron ? [`cronExpression: ${yamlStr(task.cron)}`] : []),
      ...(task.model ? [`model: ${yamlStr(task.model)}`] : []),
      ...(task.cwd ? [`cwd: ${yamlStr(task.cwd)}`] : []),
      ...(task.permissionMode ? [`permissionMode: ${yamlStr(task.permissionMode)}`] : []),
      `useWorktree: ${Boolean(task.useWorktree)}`,
      '---',
      '',
      String(task.prompt || ''),
      '',
    ].join('\n');
    fs.writeFileSync(fp, fm, 'utf8');
    return fp;
  } catch (_) {
    return fp;
  }
}

// Compute the next fire time (epoch ms) for a task, or null if manual/finished.
function computeNext(task, from) {
  const now = from || Date.now();
  const cadence = task.cadence || 'once';
  if (cadence === 'manual') return null;
  if (cadence === 'cron') {
    const nxt = cronexpr.next(task.cron, now);
    return nxt == null ? null : nxt;
  }
  if (cadence === 'once') {
    const targetAt = task.fireAt != null ? task.fireAt : task.at;
    if (targetAt) {
      const t = typeof targetAt === 'number' ? targetAt : Date.parse(targetAt);
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
  if (cadence === 'daily' || cadence === 'weekly' || cadence === 'weekdays') {
    const hm = String(task.time || '09:00').split(':');
    const hh = Math.max(0, Math.min(23, parseInt(hm[0], 10) || 0));
    const mm = Math.max(0, Math.min(59, parseInt(hm[1], 10) || 0));
    const d = new Date(now);
    d.setHours(hh, mm, 0, 0);
    if (cadence === 'weekly') {
      const dow = Math.max(0, Math.min(6, Number(task.dayOfWeek) || 0));
      const delta = (dow - d.getDay() + 7) % 7;
      d.setDate(d.getDate() + delta);
      if (d.getTime() <= now) d.setDate(d.getDate() + 7);
    } else if (cadence === 'weekdays') {
      if (d.getTime() <= now) d.setDate(d.getDate() + 1);
      while (d.getDay() === 0 || d.getDay() === 6) {
        d.setDate(d.getDate() + 1);
      }
    } else if (d.getTime() <= now) {
      d.setDate(d.getDate() + 1);
    }
    return d.getTime();
  }
  return null;
}

function describe(task) {
  const c = task.cadence || 'once';
  if (c === 'manual') return 'manual only (routine)';
  if (c === 'cron') return 'cron ' + task.cron + ' (' + cronexpr.describe(task.cron) + ')';
  if (c === 'once') {
    const t = task.fireAt != null ? task.fireAt : task.at;
    return 'once at ' + (t ? new Date(t).toLocaleString() : 'soon');
  }
  if (c === 'every') return 'every ' + (task.everyMinutes || 60) + ' min';
  if (c === 'hourly') return 'hourly' + (task.minute != null ? ' at :' + String(task.minute).padStart(2, '0') : '');
  if (c === 'weekdays') return 'weekdays (Mon–Fri) at ' + (task.time || '09:00');
  if (c === 'weekly') {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayLabel = days[Math.max(0, Math.min(6, Number(task.dayOfWeek) || 0))] || 'Sun';
    return 'weekly on ' + dayLabel + ' at ' + (task.time || '09:00');
  }
  return 'daily at ' + (task.time || '09:00');
}

function waitingReasonFor(task) {
  if (!task || task.enabled === false) {
    if (task && task.waitingReason === 'too_late') return 'One-time schedule missed by more than 7 days — paused.';
    return '';
  }
  if (task.retryAt && Number(task.retryAt) > Date.now()) {
    return `Last run failed; retrying automatically at ${new Date(task.retryAt).toLocaleTimeString()}`;
  }
  return '';
}

function list() {
  const s = load();
  return s.tasks.map((t) => ({
    ...t,
    schedule: describe(t),
    nextRunAt: t.enabled === false ? null : (t.nextRunAt || null),
    waiting: waitingReasonFor(t),
    runs: Array.isArray(t.runs) ? t.runs : [],
  }));
}

function listRuns(taskId = '', { limit = 20 } = {}) {
  const s = load();
  const max = Math.max(1, Math.min(50, Number(limit) || 20));
  if (taskId) {
    const t = s.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false, error: `Unknown task: ${taskId}` };
    const runs = (Array.isArray(t.runs) ? t.runs : []).slice(0, max);
    return { ok: true, taskId: t.id, totalRuns: (t.runs || []).length, runs };
  }
  const all = [];
  for (const t of s.tasks) {
    for (const r of (Array.isArray(t.runs) ? t.runs : [])) {
      all.push({ ...r, taskName: t.name });
    }
  }
  all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  return { ok: true, totalRuns: all.length, runs: all.slice(0, max) };
}

function create(input) {
  input = input || {};
  if (!input.prompt) return { ok: false, error: 'prompt required' };
  const cronExpr = String(input.cronExpression || input.cron || '').trim();
  if ((input.cadence === 'cron') || cronExpr) {
    const v = cronexpr.validate(cronExpr);
    if (!v.ok) return { ok: false, error: 'invalid cron: ' + v.error };
  }
  const fireAtRaw = input.fireAt != null ? input.fireAt : input.at;
  let parsedFireAt = null;
  if (fireAtRaw != null && String(fireAtRaw).trim() !== '') {
    const ts = typeof fireAtRaw === 'number' ? fireAtRaw : Date.parse(fireAtRaw);
    if (isNaN(ts)) return { ok: false, error: `Invalid fireAt timestamp: "${fireAtRaw}"` };
    parsedFireAt = ts;
  }

  const s = load();
  const displayName = String(input.title || input.name || String(input.prompt).slice(0, 48)).trim();
  const id = nextUniqueId(input.taskId || input.id || '', displayName, s.tasks);
  const cadence = cronExpr
    ? 'cron'
    : (parsedFireAt != null ? 'once' : (input.cadence || 'once'));

  const task = {
    id,
    name: displayName,
    description: String(input.description || '').trim(),
    prompt: String(input.prompt),
    cadence,
    cron: cronExpr || null,
    cronExpression: cronExpr || null,
    durable: Boolean(input.durable),
    sentinel: input.sentinel || null,
    expiresAt: cronExpr ? Date.now() + DEFAULT_EXPIRY_MS : null,
    at: parsedFireAt,
    fireAt: parsedFireAt,
    everyMinutes: input.everyMinutes ? Number(input.everyMinutes) : null,
    minute: input.minute != null ? Number(input.minute) : null,
    time: input.time || null,
    dayOfWeek: input.dayOfWeek != null ? Number(input.dayOfWeek) : null,
    cwd: input.cwd ? String(input.cwd).trim() : '',
    useWorktree: Boolean(input.useWorktree),
    sourceBranch: input.sourceBranch ? String(input.sourceBranch).trim() : '',
    model: input.model ? String(input.model).trim() : '',
    permissionMode: ['auto', 'default', 'plan'].includes(input.permissionMode) ? input.permissionMode : 'auto',
    attentionGate: Boolean(input.attentionGate),
    notifyOnCompletion: input.notifyOnCompletion !== false,
    enabled: input.enabled !== false,
    waitingReason: '',
    retryCount: 0,
    retryAt: null,
    createdAt: Date.now(),
    firedAt: null,
    runCount: 0,
    lastResult: null,
    lastRunAt: null,
    runs: [],
    filePath: '',
  };
  task.filePath = writeTaskSkillFile(task);
  task.nextRunAt = task.enabled ? computeNext(task) : null;
  s.tasks.push(task);
  save(s);
  if (task.durable) mirrorDurable(s);
  return { ok: true, task: { ...task, schedule: describe(task), waiting: waitingReasonFor(task) } };
}

function mirrorDurable(state) {
  try {
    const durable = (state.tasks || []).filter((t) => t.durable && t.enabled !== false);
    ensureDir(path.dirname(DURABLE_FILE));
    writeJSON(DURABLE_FILE, { tasks: durable });
    const byCwd = new Map();
    for (const t of durable) {
      if (!t.cwd || !fs.existsSync(t.cwd)) continue;
      if (!byCwd.has(t.cwd)) byCwd.set(t.cwd, []);
      byCwd.get(t.cwd).push(t);
    }
    for (const [taskCwd, cwdTasks] of byCwd.entries()) {
      const target = path.join(taskCwd, '.claude', 'scheduled_tasks.json');
      if (path.resolve(target) !== path.resolve(DURABLE_FILE)) {
        writeJSON(target, { tasks: cwdTasks });
      }
    }
  } catch (_) {}
}

function update(id, patch) {
  const s = load();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: `Unknown task: ${id}` };
  patch = patch || {};
  if ('title' in patch && !('name' in patch)) patch.name = patch.title;
  if ('cronExpression' in patch && !('cron' in patch)) patch.cron = patch.cronExpression;
  if ('fireAt' in patch && !('at' in patch)) patch.at = patch.fireAt;

  const allowed = [
    'name', 'description', 'prompt', 'cadence', 'cron', 'cronExpression',
    'durable', 'sentinel', 'at', 'fireAt', 'everyMinutes', 'minute', 'time',
    'dayOfWeek', 'cwd', 'useWorktree', 'sourceBranch', 'model',
    'permissionMode', 'attentionGate', 'notifyOnCompletion', 'enabled',
  ];
  for (const k of allowed) if (k in patch) t[k] = patch[k];
  if (t.cron) {
    const v = cronexpr.validate(t.cron);
    if (!v.ok) return { ok: false, error: 'invalid cron: ' + v.error };
    t.cronExpression = t.cron;
    t.cadence = 'cron';
  }
  if (t.at != null) {
    const ts = typeof t.at === 'number' ? t.at : Date.parse(t.at);
    if (!isNaN(ts)) {
      t.at = ts;
      t.fireAt = ts;
      t.firedAt = null; // re-arm one-time run
    }
  }
  if (patch.enabled === true) {
    t.waitingReason = '';
    t.retryAt = null;
  }
  t.filePath = writeTaskSkillFile(t);
  t.nextRunAt = t.enabled === false ? null : computeNext(t);
  save(s);
  if (t.durable) mirrorDurable(s);
  return { ok: true, task: { ...t, schedule: describe(t), waiting: waitingReasonFor(t) } };
}

function createCron(input = {}) {
  const expr = String(input.cronExpression || input.cron || input.expression || '').trim();
  const v = cronexpr.validate(expr);
  if (!v.ok) return { ok: false, error: 'invalid cron: ' + v.error };
  const recurring = input.recurring !== false;
  return create({
    prompt: input.prompt,
    name: input.title || input.name || input.description,
    description: input.description,
    cadence: 'cron',
    cron: expr,
    cwd: input.cwd,
    model: input.model,
    permissionMode: input.permissionMode,
    durable: Boolean(input.durable),
    enabled: recurring,
  });
}

function createWakeup(input = {}) {
  let delay = Number(input.delaySeconds || input.delay_seconds || input.delay || 300);
  if (!Number.isFinite(delay)) delay = 300;
  delay = Math.max(60, Math.min(3600, delay));
  const prompt = String(input.prompt || input.reason || 'Continue the task.');
  const r = create({
    prompt,
    name: input.reason || 'wakeup',
    cadence: 'once',
    at: Date.now() + delay * 1000,
    sentinel: input.sentinel || null,
  });
  if (r.ok) r.delaySeconds = delay;
  return r;
}

function remove(id) {
  const s = load();
  const i = s.tasks.findIndex((x) => x.id === id);
  if (i === -1) return { ok: false, error: `Unknown task: ${id}` };
  const removed = s.tasks[i];
  // Match Claude Desktop: preserve {taskId}/SKILL.md on disk for prompt recovery.
  const skillPath = removed.filePath || taskSkillFilePath(removed.id);
  s.tasks.splice(i, 1);
  save(s);
  mirrorDurable(s);
  return { ok: true, id, skillPath };
}

async function fire(task, trigger = 'scheduled') {
  const startedAt = Date.now();
  const result = { at: startedAt, startedAt, completedAt: startedAt, durationMs: 0, ok: true, trigger, output: null, error: null };
  try {
    const proactivity = require('./proactivity');
    if (task && task.attentionGate) {
      let fastProvider = task.fastProvider || null;
      if (!fastProvider && typeof _resolveFastProvider === 'function') {
        try { fastProvider = await Promise.resolve(_resolveFastProvider(task)); } catch (_) {}
      }
      const gate = await proactivity.runAttentionGate({
        task,
        fastProvider,
      });
      if (gate && gate.review === false) {
        result.completedAt = Date.now();
        result.durationMs = result.completedAt - startedAt;
        result.skippedByAttentionGate = true;
        result.output = `Skipped by Attention Gate: ${gate.reason || 'no review needed'}`;
        return result;
      }
    }
    if (!_runner) throw new Error('no runner wired');
    const out = await _runner({ task, trigger });
    result.completedAt = Date.now();
    result.durationMs = result.completedAt - startedAt;
    result.output = typeof out === 'string' ? out.slice(0, 4000) : JSON.stringify(out).slice(0, 4000);
    try {
      proactivity.upsertMatter({
        source: 'scheduler',
        title: task.name || task.prompt || 'Scheduled check',
        fingerprint: task.id || '',
        summary: String(result.output || '').slice(0, 500),
        preparedWork: task.prompt || '',
        impact: task.impact || 'medium',
        evidence: 'strong',
        conditionData: result.output,
      });
    } catch (_) {}
  } catch (e) {
    result.completedAt = Date.now();
    result.durationMs = result.completedAt - startedAt;
    result.ok = false;
    result.error = e.message;
  }
  return result;
}

function recordRunOnTask(t, res) {
  t.firedAt = res.at;
  t.runCount = (t.runCount || 0) + 1;
  t.lastRunAt = res.at;
  t.lastResult = res;
  if (!Array.isArray(t.runs)) t.runs = [];
  t.runs.unshift({
    runId: 'run_' + res.at.toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    taskId: t.id,
    status: res.ok ? (res.skippedByAttentionGate ? 'skipped' : 'succeeded') : 'failed',
    trigger: res.trigger || 'scheduled',
    startedAt: res.startedAt || res.at,
    completedAt: res.completedAt || res.at,
    durationMs: res.durationMs || 0,
    model: t.model || '',
    cwd: t.cwd || '',
    output: res.output ? String(res.output).slice(0, 1200) : '',
    error: res.error || null,
  });
  t.runs = t.runs.slice(0, MAX_RUN_HISTORY);
}

async function runNow(id) {
  const s = load();
  const t = s.tasks.find((x) => x.id === id);
  if (!t) return { ok: false, error: `Unknown task: ${id}` };
  const res = await fire(t, 'manual');
  const s2 = load();
  const t2 = s2.tasks.find((x) => x.id === id);
  if (t2) {
    recordRunOnTask(t2, res);
    t2.retryCount = 0;
    t2.retryAt = null;
    if ((t2.cadence || 'once') === 'once') { t2.enabled = false; t2.nextRunAt = null; }
    else if (t2.enabled !== false) t2.nextRunAt = computeNext(t2, res.at);
    save(s2);
  }
  if (_onEvent) { try { _onEvent({ type: 'ran', taskId: id, trigger: 'manual', result: res }); } catch (_) {} }
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
      if ((t.cadence || 'once') === 'manual') continue;

      if (t.nextRunAt == null && !t.retryAt) {
        t.nextRunAt = computeNext(t, now);
        if (t.nextRunAt != null) changed = true;
        continue;
      }

      // Pause one-time tasks that were missed by more than 7 days (Claude Desktop rule)
      if ((t.cadence || 'once') === 'once' && t.nextRunAt != null && now - t.nextRunAt > ONCE_LATE_PAUSE_MS) {
        t.enabled = false;
        t.waitingReason = 'too_late';
        t.nextRunAt = null;
        changed = true;
        continue;
      }

      const retryDue = t.retryAt != null && t.retryAt <= now;
      const slotDue = t.nextRunAt != null && t.nextRunAt <= now;
      if (!retryDue && !slotDue) continue;

      const trigger = retryDue
        ? 'retry'
        : ((t.nextRunAt != null && now - t.nextRunAt > 120 * 1000) ? 'missed' : 'scheduled');
      const due = { ...t };
      const res = await fire(due, trigger);
      recordRunOnTask(t, res);

      if (!res.ok && (t.retryCount || 0) < RETRY_BACKOFF_MS.length) {
        const delay = RETRY_BACKOFF_MS[t.retryCount || 0];
        t.retryCount = (t.retryCount || 0) + 1;
        t.retryAt = Date.now() + delay;
      } else {
        t.retryCount = 0;
        t.retryAt = null;
        if ((t.cadence || 'once') === 'once') { t.enabled = false; t.nextRunAt = null; }
        else t.nextRunAt = computeNext(t, res.at);
      }

      changed = true;
      if (_onEvent) { try { _onEvent({ type: 'ran', taskId: t.id, trigger, result: res }); } catch (_) {} }
      save(s);
    }
    if (changed) save(s);
  } finally {
    _busy = false;
  }
}

function start(runner, onEvent, startOpts = {}) {
  _runner = runner;
  _onEvent = onEvent || null;
  _resolveFastProvider = (startOpts && typeof startOpts.resolveFastProvider === 'function')
    ? startOpts.resolveFastProvider
    : null;
  if (_timer) return;
  const s = load();
  let changed = false;
  let hasOverdue = false;
  const now = Date.now();
  for (const t of s.tasks) {
    if (t.enabled === false || t.cadence === 'manual') continue;
    if (t.nextRunAt == null) { t.nextRunAt = computeNext(t, now); changed = true; }
    if (t.nextRunAt != null && t.nextRunAt <= now) hasOverdue = true;
  }
  if (changed) save(s);
  if (hasOverdue) {
    const catchupTimer = setTimeout(() => { tick().catch(() => {}); }, 2500);
    if (catchupTimer.unref) catchupTimer.unref();
  }
  _timer = setInterval(() => { tick().catch(() => {}); }, 30000);
  if (_timer.unref) _timer.unref();
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

  return {
    list, listRuns, create, update, remove, runNow, tick, start, stop, computeNext, describe, formatList,
    createCron, createWakeup, mirrorDurable, taskSkillFilePath, AUTONOMOUS_SENTINEL, DURABLE_FILE,
  };
}

const defaultScheduler = createScheduler();

module.exports = {
  ...defaultScheduler,
  createScheduler,
};

function formatList(tasks) {
  if (!tasks || !tasks.length) return 'SCHEDULED TASKS:\n(none)';
  return 'SCHEDULED TASKS:\n' + tasks.map((t) => {
    const next = t.nextRunAt ? new Date(t.nextRunAt).toLocaleString() : '—';
    const meta = [t.cwd ? `cwd: ${t.cwd}` : '', t.model ? `model: ${t.model}` : '', t.filePath ? `skill: ${t.filePath}` : ''].filter(Boolean).join(' · ');
    return `- ${t.id} "${t.name}" [${t.schedule}] ${t.enabled === false ? '(disabled)' : 'next: ' + next}${meta ? '\n    ' + meta : ''}\n    prompt: ${String(t.prompt).slice(0, 160)}`;
  }).join('\n');
}
