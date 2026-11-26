'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sessionlog = require('./sessionlog');

function clampQuickReply(str) {
  const words = String(str || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  return words.join(' ');
}

function tokenSet(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/["'`{}[\],:;()]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 2)
  );
}

function tokenJaccard(a, b) {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function normArgsStr(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args.trim().toLowerCase();
  try { return JSON.stringify(args).trim().toLowerCase(); } catch (_) { return String(args); }
}

function isNearIdenticalCall(a, b) {
  if (!a || !b) return false;
  if (String(a.tool || '') !== String(b.tool || '')) return false;
  const sa = normArgsStr(a.args);
  const sb = normArgsStr(b.args);
  if (sa === sb) return true;
  return tokenJaccard(sa, sb) >= 0.78;
}

function isPermissionDenialText(txt) {
  const s = String(txt || '');
  return /\b(permission\s+denied|not\s+approved|approval\s+denied|denied\s+by\s+rule|hand\s*off\s+to\s+user)\b/i.test(s) ||
    /^Blocked:\s/i.test(s.trim());
}

function safeConvDir(convId) {
  return String(convId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function loadSessionEvents(convId, sessionsRoot = null) {
  if (!convId) return [];
  const root = sessionsRoot || sessionlog.ROOT || path.join(os.homedir(), '.autobot', 'sessions');
  const rawDir = path.join(root, String(convId));
  const dir = fs.existsSync(rawDir) ? rawDir : path.join(root, safeConvDir(convId));
  if (!fs.existsSync(dir)) return [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
  } catch (_) {
    return [];
  }
  const all = [];
  for (const f of files.slice(-12)) {
    const turnId = f.replace(/\.jsonl$/, '');
    const full = path.join(dir, f);
    try {
      const lines = fs.readFileSync(full, 'utf8').split('\n').filter(Boolean);
      lines.forEach((line, idx) => {
        try {
          const ev = JSON.parse(line);
          if (ev && typeof ev === 'object') {
            all.push({ ...ev, turnId, stepId: ev.stepId || `${turnId}:s${idx}` });
          }
        } catch (_) {}
      });
    } catch (_) {}
  }
  return all;
}

function scoreEventsHealth(events = [], convId = '') {
  const callsById = new Map();
  const orderedCalls = [];
  const toolResults = [];
  const permissionDenials = [];

  events.forEach((ev, idx) => {
    if (!ev || typeof ev !== 'object') return;
    const stepId = ev.stepId || `s${idx}`;
    if (ev.type === 'tool') {
      const rec = {
        id: ev.id || stepId,
        stepId,
        tool: String(ev.name || ev.tool || 'unknown'),
        args: ev.args || ev.input || {},
        isError: Boolean(ev.isError),
        resultText: '',
      };
      callsById.set(rec.id, rec);
      orderedCalls.push(rec);
    } else if (ev.type === 'toolResult') {
      const errFlag = Boolean(ev.isError);
      const preview = String(ev.result || ev.output || ev.text || '');
      const linked = ev.id ? callsById.get(ev.id) : null;
      if (linked) {
        linked.isError = errFlag || linked.isError;
        linked.resultText = preview.slice(0, 220);
      }
      toolResults.push({
        stepId,
        tool: linked ? linked.tool : String(ev.name || ev.tool || 'tool'),
        isError: errFlag,
        text: preview.slice(0, 220),
      });
      if (errFlag && isPermissionDenialText(preview)) {
        permissionDenials.push({ stepId, tool: linked ? linked.tool : 'permission', quote: preview.slice(0, 140) });
      }
    } else if (ev.type === 'notice' && isPermissionDenialText(ev.text)) {
      permissionDenials.push({ stepId, tool: 'policy', quote: String(ev.text || '').slice(0, 140) });
    } else if (ev.type === 'permissionCleared' && (ev.reason === 'denied' || ev.reason === 'aborted')) {
      permissionDenials.push({ stepId, tool: 'permission', quote: `Permission ${ev.reason}` });
    }
  });

  const flags = [];
  const failingSteps = [];

  // 1. Retry loop: >= 3 consecutive errored calls to same tool with near-identical args
  let streak = [];
  let worstStreak = [];
  for (const call of orderedCalls) {
    if (call.isError) {
      if (!streak.length || isNearIdenticalCall(streak[streak.length - 1], call)) {
        streak.push(call);
      } else {
        if (streak.length > worstStreak.length) worstStreak = streak;
        streak = [call];
      }
    } else {
      if (streak.length > worstStreak.length) worstStreak = streak;
      streak = [];
    }
  }
  if (streak.length > worstStreak.length) worstStreak = streak;

  if (worstStreak.length >= 3) {
    flags.push({
      kind: 'retry_loop',
      severity: 'bad',
      tool: worstStreak[0].tool,
      count: worstStreak.length,
      detail: `${worstStreak[0].tool} failed ${worstStreak.length} consecutive times with near-identical arguments`,
    });
    for (const s of worstStreak.slice(-3)) {
      failingSteps.push({ stepId: s.stepId, tool: s.tool, reason: 'retry_loop', quote: s.resultText || normArgsStr(s.args).slice(0, 120) });
    }
  } else if (worstStreak.length === 2) {
    flags.push({
      kind: 'retry_loop_warn',
      severity: 'warn',
      tool: worstStreak[0].tool,
      count: 2,
      detail: `${worstStreak[0].tool} repeated with errors twice`,
    });
  }

  // 2. Error spiral: >= 50% errored tool results in any rolling 10-result window
  let maxErrorRatio = 0;
  let worstWindowErrors = 0;
  let worstWindowSize = 0;
  for (let end = 0; end < toolResults.length; end++) {
    const start = Math.max(0, end - 9);
    const win = toolResults.slice(start, end + 1);
    if (win.length < 4) continue;
    const errs = win.filter((r) => r.isError).length;
    const ratio = errs / win.length;
    if (ratio > maxErrorRatio || (ratio === maxErrorRatio && win.length > worstWindowSize)) {
      maxErrorRatio = ratio;
      worstWindowErrors = errs;
      worstWindowSize = win.length;
    }
  }
  if (worstWindowSize >= 4 && maxErrorRatio >= 0.5) {
    const pct = Math.round(maxErrorRatio * 100);
    flags.push({
      kind: 'error_spiral',
      severity: worstWindowErrors >= 4 || worstWindowSize >= 6 ? 'bad' : 'warn',
      errors: worstWindowErrors,
      window: worstWindowSize,
      pct,
      detail: `${worstWindowErrors}/${worstWindowSize} (${pct}%) recent tool results errored`,
    });
    for (const tr of toolResults.filter((r) => r.isError).slice(-3)) {
      failingSteps.push({ stepId: tr.stepId, tool: tr.tool, reason: 'error_spiral', quote: tr.text || 'Tool returned error' });
    }
  }

  // 3. Permission-denial cluster: >= 3 permission/approval denials
  if (permissionDenials.length >= 3) {
    flags.push({
      kind: 'permission_denial_cluster',
      severity: 'bad',
      count: permissionDenials.length,
      detail: `${permissionDenials.length} permission/policy denials recorded`,
    });
    for (const d of permissionDenials.slice(-3)) {
      failingSteps.push({ stepId: d.stepId, tool: d.tool, reason: 'permission_denial', quote: d.quote });
    }
  } else if (permissionDenials.length === 2) {
    flags.push({
      kind: 'permission_denial_warn',
      severity: 'warn',
      count: 2,
      detail: `2 permission denials recorded`,
    });
  }

  const hasBad = flags.some((f) => f.severity === 'bad');
  const hasWarn = flags.some((f) => f.severity === 'warn');
  const status = hasBad ? 'bad' : (hasWarn ? 'warn' : 'ok');
  const score = Math.max(
    0,
    Math.min(
      100,
      100 -
        (worstStreak.length >= 3 ? 45 : worstStreak.length === 2 ? 20 : 0) -
        (maxErrorRatio >= 0.5 && worstWindowSize >= 4 ? 35 : 0) -
        (permissionDenials.length >= 3 ? 35 : permissionDenials.length === 2 ? 15 : 0)
    )
  );

  const uniqueSteps = [];
  const seenStep = new Set();
  for (const fsItem of failingSteps) {
    if (!seenStep.has(fsItem.stepId)) {
      seenStep.add(fsItem.stepId);
      uniqueSteps.push(fsItem);
    }
  }

  let diagnosis = 'Session tools and approvals look healthy.';
  let unstickDraft = '';
  let quickReplies = [
    clampQuickReply('Continue with next step'),
    clampQuickReply('Run tests and summarize'),
    clampQuickReply('Show current workspace status'),
  ];

  if (status !== 'ok') {
    const quoted = uniqueSteps
      .slice(0, 3)
      .map((s) => `[${s.stepId}] ${s.tool}: "${String(s.quote || '').replace(/\s+/g, ' ').slice(0, 100)}"`)
      .join('; ');
    diagnosis = `${flags.map((f) => f.detail).join(' · ')}.${quoted ? ` Evidence: ${quoted}` : ''}`;

    if (flags.some((f) => f.kind === 'permission_denial_cluster' || f.kind === 'permission_denial_warn')) {
      unstickDraft = `Stop retrying blocked operations (${quoted}). Explain which permission rule triggered and propose a read-only or alternative approach.`;
      quickReplies = [
        clampQuickReply('Switch to read-only inspection first'),
        clampQuickReply('Explain why approval was blocked'),
        clampQuickReply('Propose safer alternative command'),
      ];
    } else if (flags.some((f) => f.kind === 'retry_loop' || f.kind === 'retry_loop_warn')) {
      unstickDraft = `Break the retry loop on ${worstStreak[0]?.tool || 'the failing tool'}. Inspect these failing steps first: ${quoted}. Re-read the target file/error and try a fundamentally different fix.`;
      quickReplies = [
        clampQuickReply('Stop retrying and inspect error output'),
        clampQuickReply('Re-read file before editing again'),
        clampQuickReply('Explain root cause first'),
      ];
    } else {
      unstickDraft = `Pause execution to diagnose the error spiral (${quoted}). Summarize the root cause of the recent failures before making another change.`;
      quickReplies = [
        clampQuickReply('Stop and summarize recent errors'),
        clampQuickReply('Reset strategy and verify assumptions'),
        clampQuickReply('Show minimal failing command'),
      ];
    }
  }

  return {
    convId,
    status,
    score,
    flags,
    failingSteps: uniqueSteps,
    diagnosis,
    unstickDraft,
    quickReplies,
    totalCalls: orderedCalls.length,
    totalResults: toolResults.length,
    denials: permissionDenials.length,
  };
}

function messagesToSyntheticEvents(messages = []) {
  const out = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || !Array.isArray(m.tools)) continue;
    for (let i = 0; i < m.tools.length; i++) {
      const t = m.tools[i];
      if (!t) continue;
      const sid = `${m.id || 'm'}:t${i}`;
      out.push({ type: 'tool', id: t.id || sid, stepId: sid, name: t.name, args: t.args || {} });
      if (t.done || t.result != null || t.isError) {
        out.push({
          type: 'toolResult',
          id: t.id || sid,
          stepId: sid,
          name: t.name,
          isError: Boolean(t.isError),
          result: typeof t.result === 'string' ? t.result : JSON.stringify(t.result || ''),
        });
      }
    }
  }
  return out;
}

function scoreSessionHealth(convId, { sessionsRoot = null, messages = null } = {}) {
  const diskEvents = loadSessionEvents(convId, sessionsRoot);
  const events = diskEvents.length ? diskEvents : messagesToSyntheticEvents(messages || []);
  return scoreEventsHealth(events, convId);
}

function inspectAllSessionsHealth(convsSummary = [], { sessionsRoot = null } = {}) {
  const results = {};
  for (const c of Array.isArray(convsSummary) ? convsSummary : []) {
    if (!c || !c.id) continue;
    const h = scoreSessionHealth(c.id, { sessionsRoot, messages: c.messages || null });
    results[c.id] = {
      ...h,
      title: c.title || 'Untitled',
      cwd: c.cwd || '',
      updatedAt: c.updatedAt || 0,
      streaming: Boolean(c.streaming),
      waitingApproval: Boolean(c.waitingApproval),
      contextPct: c.contextPct != null ? Number(c.contextPct) : null,
      stateLabel: c.waitingApproval
        ? 'waiting'
        : c.streaming
          ? 'active'
          : (h.status === 'bad' ? 'stuck' : 'idle'),
    };
  }
  return results;
}

module.exports = {
  clampQuickReply,
  tokenJaccard,
  scoreEventsHealth,
  scoreSessionHealth,
  inspectAllSessionsHealth,
  loadSessionEvents,
};
