'use strict';

const permissions = require('./permissions');

function createPermissionGate({
  suggestSafeAllowRule = permissions.suggestSafeAllowRule,
  savePermissionRule = permissions.savePermissionRule,
  ruleMatches = permissions.ruleMatches,
} = {}) {
  let nextId = 1;
  // id -> { id, runId, convId, toolName, args, cwd, suggestedRule, emit, resolve, settled, cleanupAbort }
  const pending = new Map();
  // convId -> Set<string> of scoped rules allowed for this conversation
  const sessionAllowByConv = new Map();

  function getSessionRules(convId) {
    if (!convId) return [];
    const set = sessionAllowByConv.get(convId);
    return set ? Array.from(set) : [];
  }

  function addSessionRule(convId, rule) {
    if (!convId || !rule) return false;
    let set = sessionAllowByConv.get(convId);
    if (!set) {
      set = new Set();
      sessionAllowByConv.set(convId, set);
    }
    set.add(rule);
    return true;
  }

  function checkConversationAllow(convId, toolName, args, cwd) {
    if (!convId) return null;
    const set = sessionAllowByConv.get(convId);
    if (!set || set.size === 0) return null;
    for (const rule of set) {
      try {
        if (ruleMatches(rule, toolName, args || {}, cwd)) return rule;
      } catch (_) {}
    }
    return null;
  }

  function settleEntry(id, outcome, { emitCleared = true, reason = 'answered' } = {}) {
    const entry = pending.get(id);
    if (!entry || entry.settled) return false;
    entry.settled = true;
    pending.delete(id);
    if (typeof entry.cleanupAbort === 'function') {
      try { entry.cleanupAbort(); } catch (_) {}
    }
    if (emitCleared && typeof entry.emit === 'function') {
      try {
        entry.emit({
          type: 'permissionCleared',
          id: entry.id,
          runId: entry.runId || null,
          convId: entry.convId || null,
          reason,
        });
      } catch (_) {}
    }
    entry.resolve(outcome);
    return true;
  }

  function prompt({
    runId = null,
    convId = null,
    toolName,
    args = {},
    summary = '',
    cwd = null,
    signal = null,
    emit,
  }) {
    if (signal && signal.aborted) {
      return Promise.resolve({ allow: false, aborted: true, scope: 'once', rule: null, feedback: '' });
    }
    const id = 'p' + nextId++;
    const suggestedRule = suggestSafeAllowRule(toolName, args || {}, cwd);

    return new Promise((resolve) => {
      const entry = {
        id,
        runId,
        convId,
        toolName,
        args: args || {},
        cwd,
        suggestedRule,
        emit,
        resolve,
        settled: false,
        cleanupAbort: null,
      };

      if (signal && typeof signal.addEventListener === 'function') {
        const onAbort = () => {
          settleEntry(id, { allow: false, aborted: true, scope: 'once', rule: null, feedback: '' }, { emitCleared: true, reason: 'aborted' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanupAbort = () => signal.removeEventListener('abort', onAbort);
      }

      pending.set(id, entry);
      if (typeof emit === 'function') {
        emit({
          type: 'permission',
          id,
          runId: runId || null,
          convId: convId || null,
          tool: toolName,
          args: args || {},
          summary: summary || '',
          suggestedRule,
        });
      }
    });
  }

  function normalizePayload(payload) {
    if (typeof payload === 'boolean') {
      return { allow: payload, scope: 'once', feedback: '' };
    }
    if (payload && typeof payload === 'object') {
      const scope = (payload.scope === 'conversation' || payload.scope === 'always') ? payload.scope : 'once';
      return {
        allow: !!payload.allow,
        scope,
        feedback: typeof payload.feedback === 'string' ? payload.feedback.trim() : '',
      };
    }
    return { allow: false, scope: 'once', feedback: '' };
  }

  function answer(id, payload) {
    const entry = pending.get(id);
    if (!entry || entry.settled) {
      return { ok: false, error: 'Permission request not found or already closed.' };
    }
    const norm = normalizePayload(payload);
    let appliedRule = null;
    if (norm.allow) {
      const candidate = entry.suggestedRule;
      if (norm.scope === 'conversation' && candidate && entry.convId) {
        addSessionRule(entry.convId, candidate);
        appliedRule = candidate;
      } else if (norm.scope === 'always' && candidate) {
        if (entry.convId) addSessionRule(entry.convId, candidate);
        try {
          const saved = savePermissionRule({ rule: candidate, list: 'allow' });
          if (saved && saved.ok) appliedRule = candidate;
        } catch (_) {}
      }
    }

    const outcome = {
      allow: norm.allow,
      scope: norm.scope,
      rule: appliedRule,
      feedback: norm.feedback,
    };
    settleEntry(id, outcome, { emitCleared: true, reason: norm.allow ? 'approved' : 'denied' });
    return { ok: true, id, ...outcome };
  }

  function clearRun(runId, reason = 'run_ended') {
    const clearedIds = [];
    for (const [id, entry] of Array.from(pending.entries())) {
      if (runId && entry.runId !== runId) continue;
      clearedIds.push(id);
      settleEntry(
        id,
        { allow: false, cleared: true, scope: 'once', rule: null, feedback: '' },
        { emitCleared: true, reason }
      );
    }
    return clearedIds;
  }

  function clearConversation(convId) {
    if (!convId) return [];
    sessionAllowByConv.delete(convId);
    const clearedIds = [];
    for (const [id, entry] of Array.from(pending.entries())) {
      if (entry.convId !== convId) continue;
      clearedIds.push(id);
      settleEntry(
        id,
        { allow: false, cleared: true, scope: 'once', rule: null, feedback: '' },
        { emitCleared: true, reason: 'conversation_closed' }
      );
    }
    return clearedIds;
  }

  function pendingCount(runId = null) {
    if (!runId) return pending.size;
    let n = 0;
    for (const entry of pending.values()) {
      if (entry.runId === runId) n++;
    }
    return n;
  }

  return {
    prompt,
    answer,
    clearRun,
    clearConversation,
    checkConversationAllow,
    getSessionRules,
    addSessionRule,
    pendingCount,
    _pending: pending,
  };
}

module.exports = { createPermissionGate };
