// Orchestrator pool: turns providers + selected models + every API key into an
// ordered list of endpoints, then tracks per-endpoint cooldowns after failures.
//
// Endpoint shape:
//   {
//     id, providerId, providerName, model, keyIndex, keyCount,
//     providerConfig, label
//   }

import { isLocalBaseUrl } from "../shared/presets.js";

export function providerKeys(provider) {
  const keys = [];
  const add = (value) => {
    const key = String(value || "").trim();
    if (key && !keys.includes(key)) keys.push(key);
  };
  add(provider?.apiKey);
  if (Array.isArray(provider?.apiKeys)) {
    for (const key of provider.apiKeys) add(key);
  }
  return keys;
}

export function providerKeyCount(provider) {
  const keys = providerKeys(provider);
  if (keys.length) return keys.length;
  return isLocalBaseUrl(provider?.baseUrl) && provider?.requiresKey !== true ? 1 : 0;
}

function endpointsFor(provider, model, { allKeys }) {
  const keys = providerKeys(provider);
  const localNoKey = isLocalBaseUrl(provider?.baseUrl) && provider?.requiresKey !== true;
  const usable = keys.length ? keys : localNoKey ? [""] : [];
  const selected = allKeys ? usable : usable.slice(0, 1);
  const name = provider.name || provider.type || provider.id;
  return selected.map((key, index) => {
    const providerConfig = { ...provider, apiKey: key };
    delete providerConfig.apiKeys;
    return {
      id: `${provider.id}::${model}::k${index}`,
      providerId: provider.id,
      providerName: name,
      model,
      keyIndex: index,
      keyCount: usable.length,
      providerConfig,
      label:
        usable.length > 1
          ? `${name} / ${model} (key ${index + 1}/${usable.length})`
          : `${name} / ${model}`,
    };
  });
}

export function buildEndpointPool(providers, settings = {}) {
  const list = Array.isArray(providers) ? providers : [];
  const orch = settings.orchestrator || {};
  const pool = [];

  if (orch.enabled) {
    const selected = Array.isArray(orch.endpoints) ? orch.endpoints : [];
    for (const entry of selected) {
      if (!entry || entry.enabled === false) continue;
      const provider = list.find((p) => p.id === entry.providerId);
      const model = String(entry.model || "").trim();
      if (!provider || !model) continue;
      pool.push(...endpointsFor(provider, model, { allKeys: true }));
    }
  }

  if (!orch.enabled) {
    const active = list.find((p) => p.id === settings.activeProviderId);
    const provider = active || list[0];
    if (provider) {
      // activeModel belongs to the active provider. If that provider was
      // deleted, do not send its model name to the fallback provider.
      const ownsActiveModel = !!active || !settings.activeProviderId;
      const model =
        (ownsActiveModel && settings.activeModel) ||
        provider.defaultModel ||
        (Array.isArray(provider.models) ? provider.models[0] : "");
      if (model) pool.push(...endpointsFor(provider, model, { allKeys: false }));
    }
  }

  const seen = new Set();
  return pool.filter((endpoint) => {
    if (seen.has(endpoint.id)) return false;
    seen.add(endpoint.id);
    return true;
  });
}

export function summarizePool(providers, settings = {}) {
  const pool = buildEndpointPool(providers, settings);
  return {
    enabled: !!settings.orchestrator?.enabled,
    endpoints: pool.length,
    providers: new Set(pool.map((e) => e.providerId)).size,
    keys: pool.reduce((sum, e) => sum + Math.max(1, e.keyCount || 1), 0),
    labels: pool.slice(0, 8).map((e) => e.label),
  };
}

/* ----------------------------- cooldowns ----------------------------- */

const cooldowns = new Map();

export function endpointCooldownMs(error, baseCooldownSeconds = 60) {
  const status = Number(error?.status) || 0;
  const retryAfter = Number(error?.retryAfterMs) || 0;
  if (retryAfter > 0) return Math.min(24 * 60 * 60 * 1000, retryAfter);
  const base = Math.max(5, Number(baseCooldownSeconds) || 60) * 1000;

  if (status === 429) return base;
  if (status === 401 || status === 403) return 5 * 60 * 1000;
  if (status === 404) return 10 * 60 * 1000;
  if (status >= 500 || status === 529) return 30 * 1000;
  if (status === 0) return 15 * 1000;
  return Math.max(30 * 1000, base);
}

export function markFailure(endpoint, error, baseCooldownSeconds = 60) {
  const ms = endpointCooldownMs(error, baseCooldownSeconds);
  cooldowns.set(endpoint.id, {
    until: Date.now() + ms,
    ms,
    status: Number(error?.status) || 0,
    reason: String(error?.message || error || "request failed").slice(0, 240),
  });
  return ms;
}

export function markSuccess(endpoint) {
  if (!endpoint) return;
  cooldowns.delete(endpoint.id);
}

export function isCooling(endpoint, now = Date.now()) {
  const entry = cooldowns.get(endpoint.id);
  return !!entry && entry.until > now;
}

export function cooldownRemaining(endpoint, now = Date.now()) {
  const entry = cooldowns.get(endpoint.id);
  return entry && entry.until > now ? entry.until - now : 0;
}

export function orderEndpoints(pool, preferredId = null, now = Date.now()) {
  const available = pool.filter((endpoint) => !isCooling(endpoint, now));
  if (preferredId) {
    const index = available.findIndex((endpoint) => endpoint.id === preferredId);
    if (index > 0) available.unshift(...available.splice(index, 1));
  }
  return available;
}

/* ----------------------- failures worth waiting out ----------------------- */

// Rate limits, timeouts, an overloaded or failing server, and a dropped
// connection usually clear up on their own. A wrong key, a missing model or a
// rejected request do not.
const TRANSIENT_STATUSES = new Set([408, 409, 425, 429]);
const NETWORK_FAILURE = /failed to fetch|network|timed? ?out|connection|socket|econn|load failed/i;
const RETRY_BACKOFF_MS = [2000, 4000, 8000, 15000, 30000, 60000];
export const MAX_TRANSIENT_RETRIES = 10;
export const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;

export function isTransientFailure(error) {
  const status = Number(error?.status) || 0;
  if (status) return TRANSIENT_STATUSES.has(status) || status >= 500;
  return NETWORK_FAILURE.test(String(error?.message || error || ""));
}

/** How long until an endpoint that failed for a passing reason is usable again (0 if none). */
export function transientCooldownRemaining(pool, now = Date.now()) {
  const waits = (pool || [])
    .filter((endpoint) => {
      const entry = cooldowns.get(endpoint.id);
      return !!entry && isTransientFailure({ status: entry.status, message: entry.reason });
    })
    .map((endpoint) => cooldownRemaining(endpoint, now))
    .filter((ms) => ms > 0);
  return waits.length ? Math.min(...waits) : 0;
}

/**
 * How long to wait before asking again after a passing failure. `attempt` is
 * the number of failed tries so far. Returns null when waiting will not help:
 * too many tries, or the provider wants a pause longer than a task should sit out.
 */
export function transientRetryDelay({ attempt, retryAfterMs = 0, maxRetries = MAX_TRANSIENT_RETRIES }) {
  if (attempt > maxRetries) return null;
  const backoff = RETRY_BACKOFF_MS[Math.min(Math.max(1, attempt), RETRY_BACKOFF_MS.length) - 1];
  const wait = Math.max(backoff, Number(retryAfterMs) || 0);
  return wait > MAX_RETRY_WAIT_MS ? null : wait;
}

export function describeError(error) {
  const status = Number(error?.status) || 0;
  if (status === 429) return "rate limit / quota";
  if (status === 401 || status === 403) return "authentication failed";
  if (status === 404) return "model or endpoint not found";
  if (status === 400 || status === 422) {
    const detail = String(error?.message || "").replace(/^HTTP \d+:\s*/, "").slice(0, 240);
    return detail ? `request rejected: ${detail}` : "request rejected";
  }
  if (status === 529) return "provider overloaded";
  if (status >= 500) return `server error ${status}`;
  // The request was accepted and then nothing came back (agent.js stallWatch).
  if (error?.stalled) return "no answer in time";
  if (status === 0) return "network error";
  return String(error?.message || error || "request failed").slice(0, 160);
}

export function resetCooldowns() {
  cooldowns.clear();
}

export function cooldownSnapshot() {
  return [...cooldowns.entries()].map(([id, entry]) => ({
    id,
    ...entry,
    remainingMs: Math.max(0, entry.until - Date.now()),
  }));
}
