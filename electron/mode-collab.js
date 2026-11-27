'use strict';
/**
 * Unified Multi-Model Collaboration Engine (Direct vs Auto vs Orchestrator vs Swarm).
 *
 * Grounded in multi-agent harness patterns:
 *   - Direct       : Strict single-model execution unless an explicit Task({ model }) overrides.
 *                    With Swarm ON & Orchestrator OFF -> Homogeneous Swarm on the selected model.
 *                    With Swarm ON & Orchestrator ON  -> Selected model leads Swarm + delegates across pool.
 *   - Orchestrator : Selected model acts as Lead Supervisor / Planner (index 0) with failover pool,
 *                    paired with an Executor (coder), Fast Explorer (fast), and independent Verifier.
 *   - Auto         : Complexity/modality dispatcher picks optimal tier per turn + idle multi-model subagents.
 *   - Swarm        : Coordinator-Worker-Verifier board + outcome thread grouping + optional Git worktree
 *                    isolation for concurrent overlapping writers + quota-aware model switching.
 *
 * Pure CommonJS, zero Electron imports (fully unit-testable in plain Node).
 */

const router = require('./orch-router');

function sameModel(a, b) {
  return String((a && a.model) || '').trim().toLowerCase() === String((b && b.model) || '').trim().toLowerCase()
    && String((a && a.oauthProvider) || '').trim().toLowerCase() === String((b && b.oauthProvider) || '').trim().toLowerCase();
}

function isRowHealthy(row, gate) {
  if (!row || row.enabled === false) return false;
  if (!gate) return true;
  if (typeof gate.usable === 'function' && !gate.usable(row)) return false;
  return true;
}

function resolveCollaborationMode({ provider = null, orchestrator = null, swarm = false, autoRoutedMeta = null } = {}) {
  const rawMode = String((provider && provider.routingMode) || '').trim().toLowerCase();
  const isSentinelAuto = !provider?.baseURL && !provider?.oauthProvider
    && String((provider && provider.model) || '').trim().toLowerCase() === 'auto';
  const orchOn = Boolean(orchestrator && orchestrator.enabled === true);

  let mode = 'legacy';
  if (rawMode === 'direct') mode = 'direct';
  else if (rawMode === 'orchestrator') mode = 'orchestrator';
  else if (rawMode === 'auto' || isSentinelAuto) mode = 'auto';
  else if (orchOn) mode = 'orchestrator';

  const swarmOn = swarm === true;
  let allowPoolDelegation = true;
  let pinSwarmSupervisor = false;

  if (mode === 'direct') {
    allowPoolDelegation = swarmOn && orchOn;
    pinSwarmSupervisor = swarmOn && Boolean(provider && provider.model);
  } else if (mode === 'orchestrator') {
    allowPoolDelegation = true;
    pinSwarmSupervisor = Boolean(provider && provider.model && String(provider.model).trim().toLowerCase() !== 'auto');
  } else if (mode === 'auto') {
    allowPoolDelegation = true;
    pinSwarmSupervisor = false;
  } else {
    // Legacy unspecified mode (e.g. unit tests passing explicit orchestrator or single provider)
    allowPoolDelegation = true;
    pinSwarmSupervisor = false;
  }

  return {
    mode,
    swarm: swarmOn,
    orchEnabled: orchOn || mode === 'orchestrator',
    allowPoolDelegation,
    pinSwarmSupervisor,
    autoRoutedMeta: autoRoutedMeta || null,
  };
}

/**
 * Antigravity-style Planner <-> Executor <-> Explorer <-> Verifier pairing.
 */
function resolvePlannerExecutorPair({ supervisor = null, roster = [], orchestrator = null, gate = null } = {}) {
  const planner = supervisor || null;
  const healthy = (Array.isArray(roster) ? roster : []).filter((r) => isRowHealthy(r, gate));
  const pool = healthy.length ? healthy : (Array.isArray(roster) ? roster : []);

  const findByModel = (wanted) => {
    const w = String(wanted || '').trim().toLowerCase();
    if (!w) return null;
    return pool.find((r) => String(r.model || '').trim().toLowerCase() === w)
      || (Array.isArray(roster) ? roster.find((r) => String(r.model || '').trim().toLowerCase() === w) : null);
  };

  const roleOf = (r) => router.normalizeRole((r && (r.jobRole || r.role)) || '') || router.tierToRole(r && r.tier) || 'coder';

  const explicitExec = findByModel(orchestrator && orchestrator.executorModel);
  const coders = pool.filter((r) => roleOf(r) === 'coder' || r.tier === 'heavy');
  const fasts = pool.filter((r) => roleOf(r) === 'fast' || r.tier === 'small');
  const planners = pool.filter((r) => roleOf(r) === 'planner' || r.tier === 'critical');

  const executor = explicitExec
    || coders.find((r) => !sameModel(r, planner))
    || coders[0]
    || fasts.find((r) => !sameModel(r, planner))
    || planner;

  const fastExplorer = fasts.find((r) => !sameModel(r, planner))
    || fasts[0]
    || coders.find((r) => !sameModel(r, planner))
    || executor
    || planner;

  const verifier = planners.find((r) => !sameModel(r, executor))
    || coders.find((r) => !sameModel(r, executor))
    || planner
    || executor;

  return {
    planner,
    executor,
    fastExplorer,
    verifier,
    hasDistinctExecutor: Boolean(planner && executor && !sameModel(planner, executor)),
    hasDistinctExplorer: Boolean(planner && fastExplorer && !sameModel(planner, fastExplorer)),
  };
}

/**
 * Concise single-paragraph collaboration instruction for <runtime_identity> (depth 0).
 */
function formatCollaborationRuntimeNote({ collab, pair, provider }) {
  if (!collab) return '';
  const activeModel = (provider && provider.model) || 'auto';
  if (collab.mode === 'direct' && !collab.allowPoolDelegation) {
    if (collab.swarm) {
      return `Collaboration policy (Direct + Swarm): Homogeneous swarm pinned on ${activeModel}; workers inherit ${activeModel} unless an explicit model id is requested.`;
    }
    return `Collaboration policy (Direct): Pinned strictly to ${activeModel}; unpinned Task/Agent subagents also run on ${activeModel}.`;
  }
  if (collab.mode === 'orchestrator' && pair) {
    const pName = (pair.planner && pair.planner.model) || activeModel;
    const eName = (pair.executor && pair.executor.model) || pName;
    const fName = (pair.fastExplorer && pair.fastExplorer.model) || eName;
    const vName = (pair.verifier && pair.verifier.model) || pName;
    const roles = [`Planner/Lead=${pName}`];
    if (eName !== pName) roles.push(`Executor=${eName}`);
    if (fName !== eName && fName !== pName) roles.push(`Explorer=${fName}`);
    if (vName !== eName && vName !== pName) roles.push(`Verifier=${vName}`);
    return `Collaboration policy (Orchestrator Planner-Executor): ${roles.join(', ')}. Plan and review on ${pName}; delegate parallel searches (subagent_type="Explore") and independent coding edits (Task with isolation="worktree" if paths may overlap) to worker models.`;
  }
  if (collab.mode === 'auto') {
    return `Collaboration policy (Auto Router): Turn selected dynamically by complexity/modality (${activeModel}); Task/Agent subagents spread automatically across healthy idle signed-in and pool models.`;
  }
  return '';
}

function normOwnPath(p) {
  return String(p || '').trim().replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase();
}

function ownsOverlap(listA, listB) {
  const a = (Array.isArray(listA) ? listA : []).map(normOwnPath).filter(Boolean);
  const b = (Array.isArray(listB) ? listB : []).map(normOwnPath).filter(Boolean);
  // Missing explicit owns on parallel mutating tasks implies potential workspace overlap
  if (!a.length || !b.length) return true;
  for (const pa of a) {
    for (const pb of b) {
      if (pa === pb || pa.startsWith(pb + '/') || pb.startsWith(pa + '/')) return true;
    }
  }
  return false;
}

/**
 * Inspect parallel subtasks to identify which tasks need isolated Git worktrees.
 * Never overrides read-only (`small`/explorer) tasks unless explicitly flagged.
 */
function detectOverlappingTasks(tasks = []) {
  const arr = Array.isArray(tasks) ? tasks : [];
  const mutating = arr.filter((t) => t && t.tier !== 'small' && t.jobRole !== 'fast' && t.role !== 'fast');
  const needsWorktree = new Set();

  for (const t of arr) {
    if (t && (t.isolation === 'worktree' || t.worktree === true)) {
      needsWorktree.add(t.id);
    }
  }
  if (mutating.length >= 2) {
    for (let i = 0; i < mutating.length; i++) {
      for (let j = i + 1; j < mutating.length; j++) {
        if (ownsOverlap(mutating[i].owns, mutating[j].owns)) {
          needsWorktree.add(mutating[i].id);
          needsWorktree.add(mutating[j].id);
        }
      }
    }
  }
  return needsWorktree;
}

/**
 * Group normalized subtasks into outcome threads (Antigravity swarm_pane Overview).
 */
function normalizeThreads(raw, subtasks = []) {
  const validIds = new Set((subtasks || []).map((t) => String(t.id)));
  const out = [];
  if (raw && Array.isArray(raw.threads)) {
    raw.threads.slice(0, 8).forEach((th, idx) => {
      if (!th || typeof th !== 'object') return;
      const ids = (Array.isArray(th.taskIds) ? th.taskIds : (Array.isArray(th.tasks) ? th.tasks : []))
        .map((id) => String(id))
        .filter((id) => validIds.has(id));
      const title = String(th.title || th.name || `Thread ${idx + 1}`).trim().slice(0, 80);
      if (ids.length && title) out.push({ id: String(th.id || `th${idx + 1}`), title, taskIds: ids });
    });
  }
  if (out.length) return out;
  return (subtasks || []).map((t) => ({
    id: `th-${t.id}`,
    title: String(t.title || t.id).slice(0, 80),
    taskIds: [String(t.id)],
  }));
}

/**
 * Parse structured completion markers / file mentions from a worker's report
 * so the Supervisor merge phase sees concrete changed files, checks, and blocks.
 */
function parseWorkerEnvelope(text) {
  const raw = String(text || '');
  const blocked = /WORKER_BLOCKED\b|^BLOCKED:/im.test(raw);
  const files = new Set();
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = /^\s*(?:files|modified|created|changed)\s*:\s*(.+)$/i.exec(line);
    if (m) {
      for (const tok of m[1].split(/[,\s]+/)) {
        const clean = tok.replace(/^`|`$/g, '').trim();
        if (clean && /\.[a-z0-9]{1,8}$/i.test(clean)) files.add(clean);
      }
    }
  }
  const pathMatches = raw.match(/\b[\w.-]+\.(?:html?|css|js|jsx|mjs|cjs|tsx?|json|md|py|rs|go|sh)\b/gi) || [];
  for (const p of pathMatches.slice(0, 12)) files.add(p);

  const checks = [];
  for (const line of lines) {
    const cm = /^\s*(?:checks|verified|tests)\s*:\s*(.+)$/i.exec(line);
    if (cm) checks.push(cm[1].trim().slice(0, 180));
  }
  return {
    blocked,
    files: [...files].slice(0, 16),
    checks: checks.slice(0, 6),
  };
}

module.exports = {
  resolveCollaborationMode,
  resolvePlannerExecutorPair,
  formatCollaborationRuntimeNote,
  detectOverlappingTasks,
  normalizeThreads,
  parseWorkerEnvelope,
};
