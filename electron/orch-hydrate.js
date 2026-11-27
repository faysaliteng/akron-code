'use strict';
/**
 * Orchestrator pool hydration.
 *
 * `~/.autobot/orchestrator.json` stores only `oauthProvider` + `model` for a
 * subscription row — never a bearer token (secrets live in the encrypted store,
 * keyed by account name). A turn must therefore *resolve* a live token for
 * every pool row before handing the pool to `runAgent`.
 *
 * Skipping that is silent and expensive: `normalizeProvider` defaults
 * `accessToken` to `''`, `anthropicAuth` then falls back to `provider.apiKey`
 * (also empty for a subscription row), and the wire carries
 * `Authorization: Bearer ` — which Anthropic answers with 401
 * `authentication_error: Invalid bearer token`. The app reported that as
 * "Claude needs to be signed in again" for an account whose stored token
 * answered HTTP 200 everywhere else.
 *
 * Two rules, both mirrored from validateOrchestrator():
 *   1. resolve, never trust the row on disk;
 *   2. one dead row costs its row, not the turn — drop it, keep the rest, and
 *      leave the saved entry untouched so the user can fix it in Settings.
 *
 * The hydrate step is injected rather than imported so this file stays free of
 * Electron/IPC imports and can be unit-tested in plain node.
 */

/**
 * @param {object|null} orch  pool `{ enabled, providers: [...], activeIndex }`
 * @param {(p: object) => Promise<object>} hydrate  resolves one row (main.js: hydrateProvider)
 * @returns {Promise<{orch: object|null, dead: Array<{entry: object, error: Error}>}>}
 */
async function hydrateOrchestrator(orch, hydrate) {
  if (!orch || !Array.isArray(orch.providers) || !orch.providers.length) {
    return { orch: orch || null, dead: [] };
  }
  if (typeof hydrate !== 'function') {
    throw new TypeError('hydrateOrchestrator needs a hydrate function');
  }
  const providers = [];
  const kept = [];
  const dead = [];
  for (const entry of orch.providers) {
    try {
      providers.push(await hydrate(entry));
      kept.push(entry);
    } catch (error) {
      dead.push({ entry, error });
    }
  }
  if (!dead.length) return { orch: Object.assign({}, orch, { providers }), dead };
  // Re-anchor the active row by identity: dropping an entry above it must not
  // silently switch the pool to a different model.
  const prevActive = Math.max(0, Number(orch.activeIndex) || 0);
  const activeRow = orch.providers[prevActive];
  const moved = activeRow ? kept.indexOf(activeRow) : 0;
  return {
    orch: Object.assign({}, orch, { providers, activeIndex: moved < 0 ? 0 : moved }),
    dead,
  };
}

/**
 * One human line naming what was left out of the turn. Wording stays in the
 * same register as the pool-pruning notice: what happened, what it means, and
 * that nothing was deleted.
 */
function poolDeadNotice(dead) {
  const list = Array.isArray(dead) ? dead : [];
  const n = list.length;
  if (!n) return '';
  const names = list
    .map((d) => (d && d.entry && (d.entry.name || d.entry.model)) || 'a model')
    .join(', ');
  return 'Left ' + n + ' orchestrator ' + (n === 1 ? 'model' : 'models') +
    ' out of this turn — ' + names + ' needs to be signed in again. ' +
    'The saved row is untouched; sign in again in Settings.';
}

/**
 * Orchestrator pool hydration/pruning only applies when orchestrator failover
 * is enabled OR when Swarm is active with role pools enabled, respecting
 * explicit `provider.routingMode` ('direct' | 'orchestrator' | 'auto').
 */
function isOrchestratorActiveForTurn(orch, swarm, provider) {
  const mode = provider && provider.routingMode;
  if (mode === 'direct') return Boolean(swarm === true && orch && orch.pools && orch.pools.enabled);
  if (mode === 'orchestrator' || mode === 'auto') return Boolean(orch && typeof orch === 'object');
  if (!orch || typeof orch !== 'object') return false;
  if (orch.enabled) return true;
  if (swarm === true && orch.pools && orch.pools.enabled) return true;
  return false;
}

/**
 * Suppress identical consecutive pool-drop/prune notices across turns until the
 * pool recovers or is modified in Settings / OAuth.
 */
function createPoolNoticeDeduper() {
  let lastDead = '';
  let lastPruned = '';
  return {
    shouldEmitDead(text) {
      const next = String(text || '');
      if (!next) { lastDead = ''; return false; }
      if (next === lastDead) return false;
      lastDead = next;
      return true;
    },
    shouldEmitPruned(text) {
      const next = String(text || '');
      if (!next) { lastPruned = ''; return false; }
      if (next === lastPruned) return false;
      lastPruned = next;
      return true;
    },
    reset() {
      lastDead = '';
      lastPruned = '';
    },
  };
}

module.exports = { hydrateOrchestrator, poolDeadNotice, isOrchestratorActiveForTurn, createPoolNoticeDeduper };
