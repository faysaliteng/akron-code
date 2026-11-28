'use strict';
/**
 * Headless Node provider & orchestrator hydration (shared by CLI, Daemon, and MCP fallback).
 * Zero Electron imports so it runs identically in Electron Main and `node bin/akron.js`.
 */
const store = require('./store');
const secretstore = require('./secretstore');
const providerOauth = require('./provider-oauth');
const providertransport = require('./providertransport');
const freellm = require('./freellm');
const orchRouter = require('./orch-router');
const { hydrateOrchestrator } = require('./orch-hydrate');
const taskRouter = require('./task-router');

function freellmFallbackApiKey(settings = null) {
  try {
    const s = settings || (store.getSettings ? store.getSettings() : {}) || {};
    const p = s.provider || {};
    if (p.apiKey && /localhost:(3001|31415)\b|127\.0\.0\.1:(3001|31415)\b/i.test(String(p.baseURL || ''))) {
      return String(p.apiKey).trim();
    }
    const keys = s.providerKeys || {};
    for (const u of ['http://127.0.0.1:31415/v1', 'http://localhost:31415/v1', 'http://localhost:3001/v1', 'http://127.0.0.1:3001/v1']) {
      if (keys[u] && String(keys[u]).trim()) return String(keys[u]).trim();
    }
  } catch (_) {}
  return '';
}

function hydrateLocalFreeLlmProvider(provider, settings = null) {
  if (!provider || typeof provider !== 'object') return provider;
  if (provider.oauthProvider || provider.transport) return provider;
  const base = String(provider.baseURL || '');
  if (!/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) return provider;
  if (provider.apiKey && String(provider.apiKey).trim()) return provider;
  const fallback = freellmFallbackApiKey(settings);
  if (fallback) return { ...provider, apiKey: fallback };
  try {
    const c = freellm.loadConfig ? freellm.loadConfig() : null;
    if (c && c.token && (/:31415\b/.test(base) || c.configured !== false)) {
      return { ...provider, apiKey: c.token };
    }
  } catch (_) {}
  return provider;
}

async function hydrateProviderNode(rawProvider, opts = {}) {
  const settings = opts.settings || (store.getSettings ? store.getSettings() : {}) || {};
  let provider = hydrateLocalFreeLlmProvider(rawProvider ? { ...rawProvider } : {}, settings);
  if (!provider || typeof provider !== 'object') return provider;

  if (!provider.oauthProvider) {
    if (!String(provider.apiKey || '').trim() && provider.baseURL) {
      const paidKey = orchRouter.resolvePaidProviderApiKey(provider, {
        settings,
        secretstore,
      });
      if (paidKey) return { ...provider, apiKey: paidKey };
    }
    return provider;
  }

  const targetId = String(provider.oauthProvider);
  let r = null;
  try {
    r = await providerOauth.resolve(targetId);
  } catch (_) {
    if (providerOauth.autoHealAll) await providerOauth.autoHealAll({ importMissing: true, silent: true }).catch(() => {});
    r = await providerOauth.resolve(targetId);
  }

  const out = Object.assign({}, provider, {
    transport: r.transport,
    cliId: r.cliId || provider.cliId || '',
    cliBin: r.cliBin || provider.cliBin || '',
    cliKind: r.cliKind || provider.cliKind || '',
    cliMode: Boolean(r.cliMode || r.transport === 'cli'),
    apiKey: r.apiKey || provider.apiKey || '',
    accessToken: '',
    account: r.account || '',
    oauth: false,
    model: provider.model || (r.models && r.models[0] && r.models[0].id) || '',
  });
  if (!out.cliMode && !providertransport.needsTransport({ transport: r.transport })) {
    out.transport = '';
    out.baseURL = r.baseURL || provider.baseURL || '';
    out.supportsTools = true;
  }
  return out;
}

async function discoverOllamaModels() {
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(800) });
    if (!r || !r.ok) return [];
    const j = await r.json().catch(() => null);
    return Array.isArray(j && j.models) ? j.models.map((m) => String((m && (m.model || m.name)) || '').trim()).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function buildProviderForModelSpec(spec, { oauthAccounts = [], settings = {}, orch = null } = {}) {
  const s = String(spec || '').trim();
  if (!s) return null;

  if (s.startsWith('account:')) {
    const idx = s.indexOf('::');
    const oauthProvider = idx >= 0 ? s.slice(8, idx) : s.slice(8);
    const model = idx >= 0 ? s.slice(idx + 2) : '';
    return { oauthProvider, model, oauth: true, supportsTools: true };
  }
  if (s.startsWith('ollama:')) {
    return { baseURL: 'http://127.0.0.1:11434/v1', model: s.slice(7), supportsTools: true };
  }
  if (s === 'auto' || s === 'orchestrator') return null;

  // Match signed-in OAuth account models cleanly
  const low = s.toLowerCase();
  for (const acct of oauthAccounts) {
    if (!acct || !acct.signedIn) continue;
    const hit = (acct.models || []).find((m) => String(m.id || '').toLowerCase() === low);
    if (hit) {
      return {
        oauthProvider: acct.id || `${acct.providerId}:${acct.accountName || 'default'}`,
        model: hit.id,
        oauth: true,
        supportsTools: true,
      };
    }
  }
  // Match orchestrator rows
  if (orch && Array.isArray(orch.providers)) {
    const row = orch.providers.find((p) => p && p.enabled !== false && String(p.model || '').toLowerCase() === low);
    if (row) return { ...row };
  }
  // Fall back to keeping baseURL from settings.provider with overridden model
  const baseProv = (settings && settings.provider) || {};
  return { ...baseProv, model: s };
}

async function resolveRuntimeForTurn({ modelOverride = '', modeOverride = '', settingsOverride = null, orchOverride = null } = {}) {
  const settings = settingsOverride || (store.getSettings ? store.getSettings() : {}) || {};
  const rawOrch = orchOverride || (store.getOrchestrator ? store.getOrchestrator() : null);

  let oauthAccounts = [];
  try {
    const all = await providerOauth.statusAll();
    if (Array.isArray(all)) oauthAccounts = all.filter((a) => a && a.signedIn);
  } catch (_) {}

  let baseRaw = settings.provider && typeof settings.provider === 'object' ? { ...settings.provider } : {};
  const ollamaModels = await discoverOllamaModels();

  // If no usable provider is saved yet, pick first healthy signed-in OAuth account or Ollama model
  const hasExplicitConfigured = Boolean(
    baseRaw.oauthProvider ||
    (baseRaw.apiKey && String(baseRaw.apiKey).trim()) ||
    (/11434/.test(String(baseRaw.baseURL || '')) && baseRaw.model)
  );
  if (!hasExplicitConfigured && !modelOverride) {
    if (oauthAccounts.length) {
      const a = oauthAccounts[0];
      const firstModel = (a.models && a.models[0] && a.models[0].id) || '';
      baseRaw = { oauthProvider: a.id, model: firstModel, oauth: true, supportsTools: true };
    } else if (ollamaModels.length) {
      baseRaw = { baseURL: 'http://127.0.0.1:11434/v1', model: ollamaModels[0], supportsTools: true };
    }
  }

  if (modelOverride && !['auto', 'orchestrator'].includes(String(modelOverride).trim().toLowerCase())) {
    const custom = buildProviderForModelSpec(modelOverride, { oauthAccounts, settings, orch: rawOrch });
    if (custom) baseRaw = custom;
  }

  let routingMode = String(modeOverride || baseRaw.routingMode || '').trim().toLowerCase();
  if (!routingMode && String(modelOverride || '').trim().toLowerCase() === 'auto') routingMode = 'auto';
  if (!routingMode && String(modelOverride || '').trim().toLowerCase() === 'orchestrator') routingMode = 'orchestrator';
  if (routingMode === 'direct' || routingMode === 'auto' || routingMode === 'orchestrator') {
    baseRaw.routingMode = routingMode;
  }

  let provider = await hydrateProviderNode(baseRaw, { settings });
  let orchestrator = rawOrch;
  try {
    const hy = await hydrateOrchestrator(rawOrch, (p) => hydrateProviderNode(p, { settings }));
    if (hy && hy.orch) orchestrator = hy.orch;
  } catch (_) {}

  const autoRouterConfig = taskRouter.resolveAutoRouterConfig({
    settings,
    secretstore,
    orchestrator,
    provider,
  });

  return {
    provider,
    orchestrator,
    settings,
    oauthAccounts,
    ollamaModels,
    autoRouterConfig,
    hydrateProvider: (p) => hydrateProviderNode(p, { settings }),
  };
}

module.exports = {
  hydrateProviderNode,
  hydrateLocalFreeLlmProvider,
  buildProviderForModelSpec,
  resolveRuntimeForTurn,
};
