'use strict';
// Standalone yieldable :8766 Akron Browser Bot bridge daemon.
// Hydrates ~/.autobot OAuth accounts, API keys, Orchestrator pools, and FreeLLMAPI
// so Akron Browser Bot works immediately even while Akron Code Desktop is closed or restarting,
// and cleanly yields port 8766 when Akron Code Desktop sends POST /v1/ext/yield.

const store = require('../electron/store');
const providerOauth = require('../electron/provider-oauth');
const orchRouter = require('../electron/orch-router');
const modelCatalog = require('../electron/model-catalog');
const freellm = require('../electron/freellm');
const extbridge = require('../electron/extbridge');

let secretstore = null;
try { secretstore = require('../electron/secretstore'); } catch (_) {}

function freellmFallbackApiKey() {
  try {
    const s = store.getSettings() || {};
    const p = s.provider || {};
    if (p.apiKey && /(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(String(p.baseURL || ''))) {
      return String(p.apiKey).trim();
    }
    const keys = s.providerKeys || {};
    for (const u of ['http://127.0.0.1:31415/v1', 'http://localhost:31415/v1', 'http://localhost:3001/v1', 'http://127.0.0.1:3001/v1']) {
      if (keys[u] && String(keys[u]).trim()) return String(keys[u]).trim();
    }
  } catch (_) {}
  return '';
}

async function hydrateProviderRow(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  let p = { ...raw };
  if (!p.apiKey && /:(3001|31415)\b/.test(String(p.baseURL || ''))) {
    const fb = freellmFallbackApiKey();
    if (fb) p.apiKey = fb;
    else {
      try {
        const c = freellm.loadConfig ? freellm.loadConfig() : null;
        if (c && c.token) p.apiKey = c.token;
      } catch (_) {}
    }
  }
  if (!p.oauthProvider) {
    if (!String(p.apiKey || '').trim() && p.baseURL && orchRouter.resolvePaidProviderApiKey) {
      const paidKey = orchRouter.resolvePaidProviderApiKey(p, {
        settings: store.getSettings ? store.getSettings() : null,
        secretstore,
      });
      if (paidKey) p.apiKey = paidKey;
    }
    return p;
  }
  try {
    const r = await providerOauth.resolve(String(p.oauthProvider));
    if (r && r.accessToken) {
      p.apiKey = r.accessToken;
      p.accessToken = r.accessToken;
      if (r.transport) p.transport = r.transport;
      if (r.baseURL) p.baseURL = r.baseURL;
      if (r.projectId) p.projectId = r.projectId;
    }
  } catch (_) {}
  return p;
}

async function getHydratedProvider() {
  const s = store.getSettings() || {};
  return hydrateProviderRow(s.provider || {});
}

async function getHydratedOrch() {
  const orch = store.getOrchestrator() || {};
  const rows = Array.isArray(orch.providers) ? await Promise.all(orch.providers.map(hydrateProviderRow)) : [];
  return { ...orch, providers: rows };
}

async function getExtraProviders() {
  const extras = [];
  try {
    const accts = providerOauth.listAccounts ? providerOauth.listAccounts() : [];
    const liveSnap = modelCatalog.snapshot ? modelCatalog.snapshot() : {};
    for (const a of accts) {
      if (!a || a.needsSignIn || a.expired) continue;
      try {
        const hydrated = await hydrateProviderRow({ oauthProvider: a.id, id: a.provider, name: a.label });
        const pv = providerOauth.provider ? providerOauth.provider(a.provider) : null;
        const liveList = Array.isArray(liveSnap[a.provider]) ? liveSnap[a.provider].map((m) => m.id) : [];
        const staticList = pv && Array.isArray(pv.models) ? pv.models.map((m) => m.id) : [];
        const catalogModels = [...new Set([...liveList, ...staticList].filter(Boolean))];
        if (!hydrated.model && catalogModels.length) hydrated.model = catalogModels[0];
        hydrated.catalogModels = catalogModels;
        extras.push(hydrated);
      } catch (_) {}
    }
  } catch (_) {}

  try {
    const cfg = freellm.loadConfig ? freellm.loadConfig() : null;
    const fbKey = freellmFallbackApiKey();
    const extHealth = typeof freellm.probeExternalHealth === 'function'
      ? await freellm.probeExternalHealth(cfg || {}, {}).catch(() => null)
      : null;
    const routerBase = extHealth || 'http://127.0.0.1:3001/v1';
    const routerKey = fbKey || (cfg && cfg.token) || '';
    if (routerKey && ((cfg && cfg.token) || extHealth)) {
      const aliasKeys = freellm.ALIASES ? Object.keys(freellm.ALIASES) : [];
      const cleanLive = [];
      extras.push({
        id: 'freellmapi',
        name: 'FreeLLMAPI Pool',
        baseURL: routerBase,
        apiKey: routerKey,
        model: aliasKeys[0] || 'auto',
        catalogModels: [...new Set([...aliasKeys, ...cleanLive].filter(Boolean))],
        supportsTools: true,
      });
    }
  } catch (_) {}
  return extras;
}

async function main() {
  const port = Number(process.env.AKRON_BRIDGE_PORT) || 8766;
  const res = await extbridge.start({
    port,
    yieldable: true,
    onYield: () => {
      console.log('[bridge-daemon] yielded :' + port + ' cleanly');
      process.exit(0);
    },
    getProvider: getHydratedProvider,
    getOrchestrator: getHydratedOrch,
    getExtraProviders,
  });
  console.log('[bridge-daemon] started:', JSON.stringify(res));
  if (!res || !res.ok) process.exit(1);
}

main().catch((err) => {
  console.error('[bridge-daemon] fatal:', err && err.message ? err.message : err);
  process.exit(1);
});
