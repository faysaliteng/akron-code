'use strict';
// Akron Bot — shared task board + team model (Claude Code parity).
//
// Claude Code's multi-agent runtime is built on two pieces of shared state:
//
//   * a TEAM  — a named group with a lead ("team-lead") and named teammates.
//     Teammates address each other by NAME; a teammate can be resumed by
//     agentId only after it has finished.
//   * a TASK BOARD — a flat, ordered list of tasks with dependency edges
//     (blocks / blockedBy), an optional owner, and free-form metadata.
//     Teammates poll the board for work: pending + unowned + nothing blocking.
//
// Both live under ~/.autobot (deliberately NOT ~/.claude, so Akron Bot never
// mutates a real Claude Code installation's state). The on-disk shape mirrors
// Example's so a board can be inspected or migrated with plain jq.
//
//   ~/.autobot/teams/<team>/config.json     { name, description, members[], createdAt }
//   ~/.autobot/teams/<team>/inbox/<to>.json [{ from, summary, message, ts }]
//   ~/.autobot/tasks/<team>/<id>.json       { id, subject, description, ... }
//
// Nothing here needs a live model — it is pure filesystem state, which is what
// makes a board survive a model switch, an app restart, or an agent crash.

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(os.homedir(), '.autobot');
const TEAMS_DIR = path.join(ROOT, 'teams');
const TASKS_DIR = path.join(ROOT, 'tasks');
const LEAD = 'team-lead';

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJSON(file, fb) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fb;
}
function writeJSON(file, v) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function safeName(n) {
  const s = String(n == null ? '' : n).trim();
  if (!s) return '';
  // team / task directories are path segments: no traversal, no separators.
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '').slice(0, 80);
}

function now() { return Date.now(); }

// ---------------------------------------------------------------- teams ----

function teamDir(team) { return path.join(TEAMS_DIR, safeName(team)); }
function taskDir(team) { return path.join(TASKS_DIR, safeName(team || 'default')); }

function getTeam(team) {
  const t = readJSON(path.join(teamDir(team), 'config.json'), null);
  return t;
}

function ensureTeam(team) {
  const name = safeName(team || 'default');
  const existing = getTeam(name);
  if (existing) return existing;
  const cfg = {
    name,
    description: '',
    members: [{ name: LEAD, role: 'lead', status: 'active', joinedAt: now() }],
    createdAt: now(),
  };
  writeJSON(path.join(teamDir(name), 'config.json'), cfg);
  ensureDir(path.join(teamDir(name), 'inbox'));
  ensureDir(taskDir(name));
  return cfg;
}

function createTeam(input = {}) {
  const name = safeName(input.team_name || input.name);
  if (!name) return { ok: false, error: 'team_name required' };
  const existing = getTeam(name);
  if (existing) return { ok: false, error: `Team "${name}" already exists.` };
  const cfg = {
    name,
    description: String(input.description || ''),
    members: [{ name: LEAD, role: 'lead', status: 'active', joinedAt: now() }],
    createdAt: now(),
  };
  writeJSON(path.join(teamDir(name), 'config.json'), cfg);
  ensureDir(path.join(teamDir(name), 'inbox'));
  ensureDir(taskDir(name));
  return { ok: true, team: cfg };
}

function deleteTeam(input = {}) {
  const name = safeName(input.team_name || input.name);
  if (!name) return { ok: false, error: 'team_name required' };
  const cfg = getTeam(name);
  if (!cfg) return { ok: false, error: `No team "${name}".` };
  const active = (cfg.members || []).filter((m) => m.role !== 'lead' && m.status === 'active');
  if (active.length && input.force !== true) {
    return { ok: false, error: `Team "${name}" still has active teammates: ${active.map((m) => m.name).join(', ')}. Stop them first (or pass force:true).` };
  }
  const tdir = taskDir(name);
  // Archive rather than unlink: a finished board is still evidence.
  const arch = path.join(ROOT, 'teams-archive');
  ensureDir(arch);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    if (fs.existsSync(teamDir(name))) fs.renameSync(teamDir(name), path.join(arch, `${name}-${stamp}`));
    if (fs.existsSync(tdir)) fs.renameSync(tdir, path.join(arch, `${name}-tasks-${stamp}`));
  } catch (e) { return { ok: false, error: 'archive failed: ' + e.message }; }
  return { ok: true, archived: true };
}

function addMember(team, member) {
  const cfg = ensureTeam(team);
  const name = String(member.name || '').trim();
  if (!name) return cfg;
  const i = cfg.members.findIndex((m) => m.name === name);
  const rec = { name, role: member.role || 'teammate', status: member.status || 'active', model: member.model || null, joinedAt: now(), agentId: member.agentId || null };
  if (i >= 0) cfg.members[i] = { ...cfg.members[i], ...rec };
  else cfg.members.push(rec);
  writeJSON(path.join(teamDir(team), 'config.json'), cfg);
  return cfg;
}

function setMemberStatus(team, name, status) {
  const cfg = getTeam(team);
  if (!cfg) return null;
  const m = (cfg.members || []).find((x) => x.name === name);
  if (m) { m.status = status; writeJSON(path.join(teamDir(team), 'config.json'), cfg); }
  return cfg;
}

function listTeams() {
  if (!fs.existsSync(TEAMS_DIR)) return [];
  return fs.readdirSync(TEAMS_DIR).filter((d) => fs.existsSync(path.join(TEAMS_DIR, d, 'config.json')))
    .map((d) => getTeam(d)).filter(Boolean);
}

// ------------------------------------------------------------ task board ----

function nextTaskId(team) {
  const dir = taskDir(team);
  if (!fs.existsSync(dir)) return '1';
  const ids = fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f, 10));
  return String((ids.length ? Math.max(...ids) : 0) + 1);
}

function taskFile(team, id) { return path.join(taskDir(team), `${String(id).replace(/[^0-9A-Za-z_-]/g, '')}.json`); }

function createTask(input = {}) {
  const team = safeName(input.team_name || input.team || 'default');
  ensureTeam(team);
  const subject = String(input.subject || input.title || '').trim();
  if (!subject) return { ok: false, error: 'subject required' };
  const dir = taskDir(team);
  fs.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 16; attempt++) {
    const id = String(Number(nextTaskId(team)) + attempt);
    const file = taskFile(team, id);
    const task = {
      id,
      subject,
      description: String(input.description || ''),
      activeForm: String(input.activeForm || input.active_form || subject),
      status: 'pending',
      owner: input.owner || null,
      blocks: Array.isArray(input.blocks) ? input.blocks.map(String) : [],
      blockedBy: Array.isArray(input.blockedBy || input.blocked_by) ? input.blockedBy.map(String) : [],
      metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
      createdAt: now(),
      updatedAt: now(),
    };
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify(task, null, 2), 'utf8'); } finally { fs.closeSync(fd); }
      return { ok: true, task };
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      throw e;
    }
  }
  return { ok: false, error: 'concurrent createTask contention' };
}

function getTask(input = {}) {
  const team = safeName(input.team_name || input.team || 'default');
  const id = String(input.taskId || input.task_id || input.id || '');
  const t = readJSON(taskFile(team, id), null);
  if (!t) return { ok: false, error: `No task ${id} in team "${team}".` };
  return { ok: true, task: t };
}

function readAllTasks(team) {
  const dir = taskDir(team);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^\d+\.json$/.test(f))
    .map((f) => readJSON(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => Number(a.id) - Number(b.id));
}

function updateTask(input = {}) {
  const team = safeName(input.team_name || input.team || 'default');
  const id = String(input.taskId || input.task_id || input.id || '');
  const file = taskFile(team, id);
  const t = readJSON(file, null);
  if (!t) return { ok: false, error: `No task ${id} in team "${team}".` };
  if (input.subject != null) t.subject = String(input.subject);
  if (input.description != null) t.description = String(input.description);
  if (input.activeForm != null || input.active_form != null) t.activeForm = String(input.activeForm != null ? input.activeForm : input.active_form);
  if (input.status != null) {
    const s = String(input.status);
    if (s === 'deleted') {
      try { fs.unlinkSync(file); } catch (_) {}
      return { ok: true, deleted: true, taskId: id };
    }
    if (!['pending', 'in_progress', 'completed'].includes(s)) {
      return { ok: false, error: `status must be pending|in_progress|completed|deleted (got "${s}")` };
    }
    t.status = s;
  }
  if (input.expectOwner !== undefined) {
    const want = input.expectOwner === null ? null : String(input.expectOwner);
    if ((t.owner || null) !== want) {
      return { ok: false, error: `Task #${id} is already owned by ${t.owner || 'none'} (expected ${want || 'none'}).` };
    }
  }
  if (input.owner !== undefined) t.owner = input.owner === null ? null : String(input.owner);
  // metadata: a null value deletes that key (Example's contract).
  if (input.metadata && typeof input.metadata === 'object') {
    t.metadata = t.metadata || {};
    for (const [k, v] of Object.entries(input.metadata)) {
      if (v === null) delete t.metadata[k];
      else t.metadata[k] = v;
    }
  }
  // Dependency edges are bidirectional in Example: adding blockedBy here also
  // adds blocks to the other task, so the board can be read from either side.
  const addBlocks = (input.addBlocks || input.add_blocks || []).map(String);
  const addBlockedBy = (input.addBlockedBy || input.add_blocked_by || []).map(String);
  t.blocks = Array.isArray(t.blocks) ? t.blocks : [];
  t.blockedBy = Array.isArray(t.blockedBy) ? t.blockedBy : [];
  for (const b of addBlocks) {
    if (!t.blocks.includes(b)) t.blocks.push(b);
    const other = readJSON(taskFile(team, b), null);
    if (other) {
      other.blockedBy = Array.isArray(other.blockedBy) ? other.blockedBy : [];
      if (!other.blockedBy.includes(String(id))) other.blockedBy.push(String(id));
      other.updatedAt = now();
      writeJSON(taskFile(team, b), other);
    }
  }
  for (const b of addBlockedBy) {
    if (!t.blockedBy.includes(b)) t.blockedBy.push(b);
    const other = readJSON(taskFile(team, b), null);
    if (other) {
      other.blocks = Array.isArray(other.blocks) ? other.blocks : [];
      if (!other.blocks.includes(String(id))) other.blocks.push(String(id));
      other.updatedAt = now();
      writeJSON(taskFile(team, b), other);
    }
  }
  t.updatedAt = now();
  writeJSON(file, t);
  return { ok: true, task: t };
}

// Claimable = pending, unowned, and not blocked by any unfinished task.
// Lowest id first, exactly like Example's teammates poll for work.
function listTasks(input = {}) {
  const team = safeName(input.team_name || input.team || 'default');
  const all = readAllTasks(team);
  const byId = new Map(all.map((t) => [String(t.id), t]));
  const enriched = all.map((t) => {
    const openBlockers = (t.blockedBy || []).filter((b) => {
      const o = byId.get(String(b));
      // Deleted blockers do not hold dependents blocked forever.
      return Boolean(o && o.status !== 'completed');
    });
    return { ...t, openBlockers, claimable: t.status === 'pending' && !t.owner && openBlockers.length === 0 };
  });
  const filter = input.status ? String(input.status) : null;
  const rows = filter ? enriched.filter((t) => t.status === filter) : enriched;
  return { ok: true, team, tasks: rows, claimable: enriched.filter((t) => t.claimable).map((t) => t.id) };
}

function formatTaskList(input = {}) {
  const { team, tasks, claimable } = listTasks(input);
  if (!tasks.length) return `TASK BOARD (${team}) — empty.`;
  const icon = (s) => (s === 'completed' ? '✓' : s === 'in_progress' ? '◐' : '○');
  const lines = tasks.map((t) => {
    const meta = [];
    if (t.owner) meta.push('@' + t.owner);
    if (t.openBlockers && t.openBlockers.length) meta.push('blocked by ' + t.openBlockers.join(','));
    if (t.metadata && Object.keys(t.metadata).length) meta.push(JSON.stringify(t.metadata));
    return `${icon(t.status)} #${t.id} ${t.subject}${meta.length ? ' — ' + meta.join(' · ') : ''}`;
  });
  const tail = claimable && claimable.length ? `\n\nClaimable now: ${claimable.map((i) => '#' + i).join(', ')}` : '';
  return `TASK BOARD (${team})\n${lines.join('\n')}${tail}`;
}

// ------------------------------------------------------------- messages ----

function inboxFile(team, to) { return path.join(teamDir(team), 'inbox', `${safeName(to)}.json`); }

function sendMessage(input = {}) {
  const team = safeName(input.team_name || input.team || 'default');
  const to = String(input.to || input.recipient || '').trim();
  if (!to) return { ok: false, error: 'to required (a teammate name, or "team-lead")' };
  const cfg = ensureTeam(team);
  const known = (cfg.members || []).map((m) => m.name);
  if (!known.includes(to)) {
    // Example errors on an unknown recipient rather than silently queuing.
    return { ok: false, error: `No teammate "${to}" in team "${team}". Members: ${known.join(', ')}` };
  }
  const msg = {
    from: String(input.from || input.sender || LEAD),
    summary: String(input.summary || '').slice(0, 200),
    message: String(input.message || input.text || ''),
    ts: now(),
    read: false,
  };
  const file = inboxFile(team, to);
  const box = readJSON(file, []);
  box.push(msg);
  writeJSON(file, box);
  return { ok: true, to, summary: msg.summary };
}

function drainInbox(input = {}) {
  const team = safeName(input.team_name || input.team || 'default');
  const who = String(input.name || input.to || input.from || LEAD);
  const file = inboxFile(team, who);
  const box = readJSON(file, []);
  if (!box.length) return { ok: true, messages: [] };
  writeJSON(file, []);
  return { ok: true, messages: box };
}

// In-process live teammate handles: key = `${team}:${name}`
const liveMembers = new Map();

function liveKey(team, name) {
  return `${safeName(team)}:${String(name || '').trim()}`;
}

function registerLiveMember(teamName, name, handle) {
  const key = liveKey(teamName, name);
  liveMembers.set(key, handle);
  return () => {
    if (liveMembers.get(key) === handle) liveMembers.delete(key);
  };
}

function signalLiveMember(teamName, name, payload) {
  const key = liveKey(teamName, name);
  const handle = liveMembers.get(key);
  if (!handle || typeof handle.onSignal !== 'function') return false;
  try {
    handle.onSignal(payload);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  ROOT, LEAD, TEAMS_DIR, TASKS_DIR,
  safeName, getTeam, ensureTeam, addMember, setMemberStatus, listTeams,
  createTeam, deleteTeam,
  createTask, getTask, updateTask, listTasks, formatTaskList, readAllTasks,
  sendMessage, drainInbox,
  registerLiveMember, signalLiveMember,
};
