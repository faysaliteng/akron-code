'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const git = require('./git');
const sessionHealth = require('./session-health');

const DEFAULT_MATTERS_FILE = path.join(os.homedir(), '.autobot', 'proactive-matters.json');

function sha256(str) {
  return crypto.createHash('sha256').update(String(str || ''), 'utf8').digest('hex');
}

function computeMatterKey({ source = 'scheduler', title = '', fingerprint = '' } = {}) {
  return sha256(`${source}\n${String(title).trim().toLowerCase()}\n${fingerprint}`).slice(0, 24);
}

function computeConditionHash(data) {
  const txt = typeof data === 'string' ? data : JSON.stringify(data || '');
  return sha256(txt).slice(0, 24);
}

function defaultState() {
  return {
    matters: [],
    quietHours: { enabled: false, start: '22:00', end: '08:00' },
    updatedAt: 0,
  };
}

function loadState(storePath = DEFAULT_MATTERS_FILE) {
  const fp = storePath || DEFAULT_MATTERS_FILE;
  try {
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          matters: Array.isArray(parsed.matters) ? parsed.matters : [],
          quietHours: parsed.quietHours && typeof parsed.quietHours === 'object'
            ? { enabled: Boolean(parsed.quietHours.enabled), start: String(parsed.quietHours.start || '22:00'), end: String(parsed.quietHours.end || '08:00') }
            : { enabled: false, start: '22:00', end: '08:00' },
          updatedAt: Number(parsed.updatedAt) || 0,
        };
      }
    }
  } catch (_) {}
  return defaultState();
}

function saveState(state, storePath = DEFAULT_MATTERS_FILE) {
  const fp = storePath || DEFAULT_MATTERS_FILE;
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  const next = { ...state, updatedAt: Date.now() };
  const tmp = `${fp}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, fp);
  return next;
}

function parseMinutes(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const min = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + min;
}

function isInQuietHours(quietHours, nowDate = new Date()) {
  if (!quietHours || !quietHours.enabled) return false;
  const d = nowDate instanceof Date ? nowDate : new Date(nowDate);
  const cur = d.getHours() * 60 + d.getMinutes();
  const start = parseMinutes(quietHours.start, 22 * 60);
  const end = parseMinutes(quietHours.end, 8 * 60);
  if (start === end) return true;
  if (start > end) {
    return cur >= start || cur < end;
  }
  return cur >= start && cur < end;
}

function shouldHoldForQuietHours(matter, quietHours, nowDate = new Date()) {
  if (!isInQuietHours(quietHours, nowDate)) return { hold: false, reason: 'outside_quiet_hours' };
  const isUrgentOverride = matter && matter.impact === 'high' && matter.imminentDeadline === true;
  if (isUrgentOverride) return { hold: false, reason: 'high_impact_imminent_deadline' };
  return { hold: true, reason: 'quiet_hours' };
}

function setQuietHours(patch = {}, storePath = DEFAULT_MATTERS_FILE) {
  const state = loadState(storePath);
  state.quietHours = {
    enabled: patch.enabled != null ? Boolean(patch.enabled) : state.quietHours.enabled,
    start: patch.start ? String(patch.start) : state.quietHours.start,
    end: patch.end ? String(patch.end) : state.quietHours.end,
  };
  return saveState(state, storePath);
}

async function runAttentionGate({ task, contextText = '', fastProvider = null, chatFn = null } = {}) {
  if (!task || !task.attentionGate) {
    return { review: true, reason: 'gate_not_enabled' };
  }
  const invoke = chatFn || (fastProvider ? require('./llm').chatOnce : null);
  if (!invoke || !fastProvider) {
    return { review: true, reason: 'no_fast_provider' };
  }

  const prompt = [
    'You are Stage 1 Attention Gate for a proactive assistant.',
    'Decide whether this scheduled automation has meaningful, actionable signal worth waking the frontier model for.',
    'Respond ONLY with strict JSON: {"review": true|false, "reason": "short reason"}',
    '',
    `TASK: ${task.name || task.prompt || 'Scheduled check'}`,
    `PROMPT: ${task.prompt || ''}`,
    contextText ? `CONTEXT SNAPSHOT:\n${String(contextText).slice(0, 4000)}` : '',
  ].filter(Boolean).join('\n');

  try {
    const res = await invoke({
      provider: fastProvider,
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 180,
    });
    const txt = String((res && res.content) || '').trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(txt);
    const jsonStr = fence ? fence[1].trim() : txt;
    const objStart = jsonStr.indexOf('{');
    const objEnd = jsonStr.lastIndexOf('}');
    const parsed = JSON.parse(objStart >= 0 && objEnd > objStart ? jsonStr.slice(objStart, objEnd + 1) : jsonStr);
    if (typeof parsed.review === 'boolean') {
      return { review: parsed.review, reason: String(parsed.reason || '') };
    }
  } catch (_) {}
  return { review: true, reason: 'gate_fallback_allow' };
}

function upsertMatter({
  source = 'scheduler',
  title,
  fingerprint = '',
  summary = '',
  preparedWork = '',
  impact = 'medium',
  evidence = 'medium',
  imminentDeadline = false,
  conditionData = '',
  storePath = DEFAULT_MATTERS_FILE,
  nowMs = Date.now(),
} = {}) {
  const cleanTitle = String(title || 'Proactive Finding').trim();
  const matterKey = computeMatterKey({ source, title: cleanTitle, fingerprint });
  const conditionHash = computeConditionHash(conditionData || summary || preparedWork);
  const state = loadState(storePath);
  const idx = state.matters.findIndex((m) => m.matterKey === matterKey);

  if (idx >= 0) {
    const existing = state.matters[idx];
    const unchanged = existing.conditionHash === conditionHash;
    if (existing.status === 'dismissed' && unchanged) {
      return { suppressed: true, reason: 'dismissed_unchanged', matter: existing };
    }
    if (existing.status === 'snoozed' && Number(existing.snoozeUntil) > nowMs && unchanged) {
      return { suppressed: true, reason: 'snoozed', matter: existing };
    }
    const updated = {
      ...existing,
      title: cleanTitle,
      summary: String(summary || existing.summary || '').trim(),
      preparedWork: String(preparedWork || existing.preparedWork || '').trim(),
      impact: ['high', 'medium', 'low'].includes(impact) ? impact : existing.impact,
      evidence: ['strong', 'medium', 'weak'].includes(evidence) ? evidence : existing.evidence,
      imminentDeadline: Boolean(imminentDeadline),
      conditionHash,
      status: 'open',
      snoozeUntil: null,
      updatedAt: nowMs,
    };
    state.matters[idx] = updated;
    saveState(state, storePath);
    const qh = shouldHoldForQuietHours(updated, state.quietHours, new Date(nowMs));
    return { suppressed: false, reopened: !unchanged, quietHeld: qh.hold, matter: updated };
  }

  const created = {
    matterKey,
    source,
    title: cleanTitle,
    summary: String(summary || '').trim(),
    preparedWork: String(preparedWork || '').trim(),
    impact: ['high', 'medium', 'low'].includes(impact) ? impact : 'medium',
    evidence: ['strong', 'medium', 'weak'].includes(evidence) ? evidence : 'medium',
    imminentDeadline: Boolean(imminentDeadline),
    conditionHash,
    status: 'open',
    snoozeUntil: null,
    feedback: null,
    createdAt: nowMs,
    updatedAt: nowMs,
  };
  state.matters.unshift(created);
  state.matters = state.matters.slice(0, 100);
  saveState(state, storePath);
  const qh = shouldHoldForQuietHours(created, state.quietHours, new Date(nowMs));
  return { suppressed: false, created: true, quietHeld: qh.hold, matter: created };
}

function actOnMatter(matterKey, action, { snoozeMs = 4 * 3600 * 1000, storePath = DEFAULT_MATTERS_FILE, nowMs = Date.now() } = {}) {
  const state = loadState(storePath);
  const idx = state.matters.findIndex((m) => m.matterKey === matterKey);
  if (idx < 0) return { ok: false, error: 'Unknown matterKey' };
  const m = { ...state.matters[idx], updatedAt: nowMs };
  if (action === 'dismiss') m.status = 'dismissed';
  else if (action === 'snooze') { m.status = 'snoozed'; m.snoozeUntil = nowMs + snoozeMs; }
  else if (action === 'handled') m.status = 'handled';
  else if (action === 'reopen') { m.status = 'open'; m.snoozeUntil = null; }
  else if (action === 'useful' || action === 'not_useful') m.feedback = action;
  state.matters[idx] = m;
  saveState(state, storePath);
  return { ok: true, matter: m };
}

function scanRecentSessions({ sessionsRoot = null, withinMs = 36 * 3600 * 1000, nowMs = Date.now() } = {}) {
  const root = sessionsRoot || path.join(os.homedir(), '.autobot', 'sessions');
  if (!fs.existsSync(root)) return [];
  const items = [];
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch (_) { return []; }
  for (const d of dirs) {
    const fullDir = path.join(root, d);
    try {
      if (!fs.statSync(fullDir).isDirectory()) continue;
      const files = fs.readdirSync(fullDir).filter((f) => f.endsWith('.jsonl')).sort();
      let latestMtime = 0;
      let title = d;
      let prompts = 0;
      for (const f of files) {
        const fp = path.join(fullDir, f);
        const st = fs.statSync(fp);
        if (st.mtimeMs > latestMtime) latestMtime = st.mtimeMs;
        if (nowMs - st.mtimeMs <= withinMs) {
          const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
          for (const ln of lines) {
            try {
              const ev = JSON.parse(ln);
              if (ev.title) title = ev.title;
              if (ev.type === 'turn') prompts++;
            } catch (_) {}
          }
        }
      }
      if (latestMtime && nowMs - latestMtime <= withinMs) {
        const h = sessionHealth.scoreSessionHealth(d, { sessionsRoot: root });
        items.push({ convId: d, title, prompts, updatedAt: latestMtime, health: h.status });
      }
    } catch (_) {}
  }
  return items.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function generateMorningBrief({
  cwd = process.cwd(),
  sessionsRoot = null,
  tasks = [],
  storePath = DEFAULT_MATTERS_FILE,
} = {}) {
  const gi = await git.gitInfo(cwd).catch(() => ({ isRepo: false }));
  const recent = scanRecentSessions({ sessionsRoot, withinMs: 36 * 3600 * 1000 });
  const failingTasks = (Array.isArray(tasks) ? tasks : []).filter((t) => t && t.lastResult && t.lastResult.ok === false);
  const dirtyCount = gi.isRepo
    ? ((gi.counts?.modified || 0) + (gi.counts?.added || 0) + (gi.counts?.deleted || 0) + (gi.counts?.untracked || 0))
    : 0;

  const lines = [
    `### Morning Dev Brief`,
    gi.isRepo
      ? `- **Git:** branch \`${gi.branch}\` · ${dirtyCount} uncommitted change(s) · recent commit \`${(gi.commits && gi.commits[0]?.hash) || 'none'}\``
      : `- **Workspace:** \`${cwd}\` (non-git folder)`,
    `- **Recent sessions (36h):** ${recent.length} session(s)${recent.length ? ' — ' + recent.slice(0, 3).map((r) => `${r.title} [${r.health}]`).join(', ') : ''}`,
    `- **Automations:** ${(tasks || []).length} total · ${failingTasks.length} failing`,
  ];
  const preparedWork = dirtyCount > 0
    ? 'Review working-tree changes (`git status` / Duet Review) and run `npm test` before committing.'
    : 'Pick top goal from backlog and run unit checks cleanly.';

  const res = upsertMatter({
    source: 'morning-brief',
    title: 'Morning Dev Brief',
    fingerprint: new Date().toISOString().slice(0, 10),
    summary: lines.join('\n'),
    preparedWork,
    impact: dirtyCount > 0 || failingTasks.length > 0 ? 'high' : 'medium',
    evidence: 'strong',
    conditionData: `${gi.branch || ''}:${dirtyCount}:${recent.length}:${failingTasks.length}`,
    storePath,
  });

  return { ok: true, markdown: lines.join('\n'), preparedWork, recent, git: gi, matter: res.matter };
}

async function generateWeeklyRetro({
  cwd = process.cwd(),
  sessionsRoot = null,
  tasks = [],
  storePath = DEFAULT_MATTERS_FILE,
} = {}) {
  const gi = await git.gitInfo(cwd).catch(() => ({ isRepo: false }));
  const week = scanRecentSessions({ sessionsRoot, withinMs: 7 * 24 * 3600 * 1000 });
  const unhealthy = week.filter((s) => s.health === 'bad' || s.health === 'warn');
  const ranCount = (Array.isArray(tasks) ? tasks : []).reduce((acc, t) => acc + (Number(t?.runCount) || 0), 0);

  const lines = [
    `### Weekly Engineering Retro`,
    `- **Active sessions (7d):** ${week.length} (${unhealthy.length} hit loop/spiral alerts)`,
    gi.isRepo ? `- **Recent commits on \`${gi.branch}\`:** ${(gi.commits || []).slice(0, 5).map((c) => c.message).join(' | ') || 'none'}` : `- **Workspace:** \`${cwd}\``,
    `- **Scheduled task executions:** ${ranCount}`,
  ];
  const preparedWork = unhealthy.length
    ? `Audit ${unhealthy.length} flagged session(s) to extract custom rules or /learn skills preventing repeat errors.`
    : 'All sessions stayed healthy this week — consider scheduling a weekly dependency & security audit.';

  const res = upsertMatter({
    source: 'weekly-retro',
    title: 'Weekly Engineering Retro',
    fingerprint: 'week',
    summary: lines.join('\n'),
    preparedWork,
    impact: unhealthy.length ? 'medium' : 'low',
    evidence: 'strong',
    conditionData: `${week.length}:${unhealthy.length}:${ranCount}`,
    storePath,
  });

  return { ok: true, markdown: lines.join('\n'), preparedWork, sessions: week, matter: res.matter };
}

function normPromptWords(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[`'".,:;!?()/\\-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

function wordJaccard(a, b) {
  const sa = new Set(normPromptWords(a));
  const sb = new Set(normPromptWords(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function suggestAutomationsFromHistory({
  convs = [],
  sessionsRoot = null,
  existingTasks = [],
  maxSuggestions = 3,
} = {}) {
  const prompts = [];
  for (const c of Array.isArray(convs) ? convs : []) {
    for (const m of (c && c.messages) || []) {
      if (!m || m.role !== 'user') continue;
      const txt = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      const clean = txt.trim();
      if (clean.length >= 12 && !clean.startsWith('/')) prompts.push(clean);
    }
  }
  const recent = scanRecentSessions({ sessionsRoot, withinMs: 14 * 24 * 3600 * 1000 });
  if (!prompts.length && recent.length) {
    for (const r of recent) if (r.title && r.title !== r.convId) prompts.push(r.title);
  }

  const existingPrompts = (Array.isArray(existingTasks) ? existingTasks : []).map((t) => String(t.prompt || ''));
  const clusters = [];
  for (const p of prompts) {
    if (existingPrompts.some((ep) => wordJaccard(ep, p) >= 0.65)) continue;
    const hit = clusters.find((cl) => wordJaccard(cl.representative, p) >= 0.5);
    if (hit) {
      hit.count++;
      if (hit.samples.length < 3 && !hit.samples.includes(p)) hit.samples.push(p);
    } else {
      clusters.push({ representative: p, count: 1, samples: [p] });
    }
  }

  return clusters
    .filter((c) => c.count >= 2)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxSuggestions)
    .map((c, idx) => ({
      id: `sug_${idx + 1}_${sha256(c.representative).slice(0, 8)}`,
      name: c.representative.slice(0, 48),
      prompt: c.representative,
      cadence: 'daily',
      time: '09:00',
      occurrences: c.count,
      samples: c.samples,
    }));
}

module.exports = {
  computeMatterKey,
  computeConditionHash,
  loadState,
  saveState,
  isInQuietHours,
  shouldHoldForQuietHours,
  setQuietHours,
  runAttentionGate,
  upsertMatter,
  actOnMatter,
  generateMorningBrief,
  generateWeeklyRetro,
  suggestAutomationsFromHistory,
};
