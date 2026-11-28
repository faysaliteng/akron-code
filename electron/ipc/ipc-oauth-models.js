'use strict';
const os = require('os');
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { dialog, shell } = require('electron');
const orchRouter = require('../orch-router');
const cliRunner = require('../cli-runner');

const MODEL_WINDOWS_TTL_MS = 24 * 60 * 60 * 1000;
let _openRouterWarmedAt = 0;

function modelWindowsCachePath() {
  const base = process.env.AUTOBOT_HOME
    ? path.resolve(process.env.AUTOBOT_HOME)
    : path.join(os.homedir(), '.autobot');
  return path.join(base, 'model-windows-cache.json');
}

function readModelWindowsCache() {
  try {
    const p = modelWindowsCachePath();
    if (!fs.existsSync(p)) return { fetchedAt: 0, providers: {} };
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { fetchedAt: 0, providers: {} };
    return {
      fetchedAt: Number(parsed.fetchedAt) || 0,
      providers: parsed.providers && typeof parsed.providers === 'object' ? parsed.providers : {},
    };
  } catch (_) {
    return { fetchedAt: 0, providers: {} };
  }
}

function writeModelWindowsCache(data) {
  try {
    const p = modelWindowsCachePath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  } catch (_) {}
}

module.exports = function registerOauthModelIpc(ctx) {
  const { ipcMain, store, secretstore, freellm, providerOauth, providertransport, modelCatalog, orchPool, normalizeReconnectCode, isRetryableLine, winFor, broadcast, poolNoticeDeduper, bundledRuntimeDir, getRuntimes, runtimePathPrefix } = ctx;

function freellmFallbackApiKey() {
  try {
    const s = store.getSettings() || {};
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

function hydrateLocalFreeLlmProvider(provider) {
  if (!provider || typeof provider !== 'object') return provider;
  if (provider.oauthProvider || provider.transport) return provider;
  const base = String(provider.baseURL || '');
  if (!/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) return provider;
  if (provider.apiKey && String(provider.apiKey).trim()) return provider;
  const fallback = freellmFallbackApiKey();
  if (fallback) return { ...provider, apiKey: fallback };
  try {
    const c = freellm.loadConfig ? freellm.loadConfig() : null;
    if (c && c.token && (/:31415\b/.test(base) || c.configured !== false)) {
      return { ...provider, apiKey: c.token };
    }
  } catch (_) {}
  return provider;
}

async function hydrateProvider(provider) {
  provider = hydrateLocalFreeLlmProvider(provider);
  if (!provider || typeof provider !== 'object') return provider;
  const rawBase = String(provider.baseURL || '').trim();
  const isDefaultOllamaNoKey = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):11434(\/v1)?\/?$/i.test(rawBase)
    && !String(provider.apiKey || '').trim();
  const looksCloudModel = /^(claude-|gpt-|o[1-4](?:-|$)|codex|gemini-|grok-|kimi-|glm-)/i.test(String(provider.model || '').trim());
  if (!provider.oauthProvider && !provider.transport && provider.model && (!rawBase || (isDefaultOllamaNoKey && looksCloudModel))) {
    try {
      const st = providerOauth.status ? providerOauth.status() : null;
      const modelId = String(provider.model || '').trim();
      const lowerModel = modelId.toLowerCase();
      let preferredVendor = '';
      if (/^claude-/i.test(lowerModel)) preferredVendor = 'claude';
      else if (/^(gpt-|o[1-4](?:-|$)|codex)/i.test(lowerModel)) preferredVendor = 'chatgpt';
      else if (/^gemini-/i.test(lowerModel)) preferredVendor = 'antigravity';
      else if (/^grok-/i.test(lowerModel)) preferredVendor = 'grok';
      else if (/^kimi-/i.test(lowerModel)) preferredVendor = 'kimi';
      else if (/^glm-/i.test(lowerModel)) preferredVendor = 'zai';
      const providers = (st && Array.isArray(st.providers)) ? st.providers : [];
      const exactHit = (pv) => {
        if (modelCatalog.hasLiveCatalog && modelCatalog.hasLiveCatalog(pv.id)) {
          return modelCatalog.isModelAvailable(pv.id, modelId);
        }
        const def = providerOauth.provider ? providerOauth.provider(pv.id) : null;
        return Boolean(def && Array.isArray(def.models) && def.models.some((m) => m && String(m.id || '').toLowerCase() === lowerModel));
      };
      const signedWithAcct = providers.filter((pv) => pv && Array.isArray(pv.accounts) && pv.accounts.some((a) => a && a.hasToken !== false));
      const matchedPv = signedWithAcct.find((pv) => pv.id === preferredVendor && exactHit(pv))
        || signedWithAcct.find((pv) => exactHit(pv))
        || signedWithAcct.find((pv) => pv.id === preferredVendor);
      if (matchedPv) {
        const acct = matchedPv.accounts.find((a) => a && a.hasToken !== false) || matchedPv.accounts[0];
        if (acct && acct.account) {
          provider = { ...provider, oauthProvider: matchedPv.id + ':' + acct.account, oauth: true, baseURL: '' };
        }
      }
    } catch (_) {}
  }
  if (!provider.oauthProvider) {
    if (!String(provider.apiKey || '').trim() && provider.baseURL) {
      const paidKey = orchRouter.resolvePaidProviderApiKey(provider, {
        settings: store && store.getSettings ? store.getSettings() : null,
        secretstore: secretstore || null,
      });
      if (paidKey) return { ...provider, apiKey: paidKey };
    }
    return provider;
  }
  const targetId = String(provider.oauthProvider);
  let r;
  try {
    r = await providerOauth.resolve(targetId);
  } catch (e) {
    try {
      if (providerOauth.autoHealAll) await providerOauth.autoHealAll({ importMissing: true }).catch(() => {});
      r = await providerOauth.resolve(targetId);
    } catch (e2) {
      const prov = providerOauth.provider(targetId.split(':')[0]);
      const label = (prov && prov.label) || 'This provider';
      const err = new Error(`${label} CLI needs to be signed in — open Settings and sign in with the official CLI.`);
      err.code = 'provider_needs_signin';
      err.human = true;
      err.cause = e2 || e;
      throw err;
    }
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
  const provKey = String(targetId.split(':')[0] || '');
  if (out.model && !modelCatalog.isModelAvailable(provKey, out.model)) {
    const replacement = modelCatalog.resolveReplacementModel(provKey, out.model);
    if (replacement && replacement.id && replacement.id !== out.model) {
      out._replacedRetiredModel = { from: out.model, to: replacement.id, providerId: provKey };
      out.model = replacement.id;
    }
  }
  if (!out.cliMode && !providertransport.needsTransport({ transport: r.transport })) {
    out.transport = '';
    out.baseURL = r.baseURL || provider.baseURL || '';
    out.supportsTools = true;
  }
  return out;
}

// ---- Orchestrator pool validation -----------------------------------------
// A saved pool row asserts "<this gateway> serves <this model>". Nothing used to
// check that, so a stale row pointed at Ollama (localhost:11434) asking for
// `claude-fable-5-2` produced
//
//   The provider says that model or endpoint does not exist —
//   model 'claude-fable-5-2' not found
//
// which reads like a dead Claude subscription and was a local model server
// answering honestly. Ask each anonymous row's gateway for its catalogue before
// the turn and leave out only the rows that gateway itself disowned. A gateway
// we cannot ask (down, 401, empty catalogue) leaves its row alone: the app
// never invents a failure it did not observe. Subscription rows have no
// anonymous endpoint and are never probed.
async function validateOrchestrator(orch, emit) {
  if (!orch || !Array.isArray(orch.providers) || !orch.providers.length) {
    poolNoticeDeduper.shouldEmitPruned('');
    return orch;
  }
  const remapped = [];
  const nextRows = orch.providers.map((row) => {
    if (!row || !row.oauthProvider || !row.model) return row;
    const provKey = String(row.oauthProvider).split(':')[0];
    if (modelCatalog.hasLiveCatalog(provKey) && !modelCatalog.isModelAvailable(provKey, row.model)) {
      const repl = modelCatalog.resolveReplacementModel(provKey, row.model);
      if (repl && repl.id) {
        remapped.push(`${row.model} → ${repl.id}`);
        return { ...row, model: repl.id };
      }
    }
    return row;
  });
  if (remapped.length && typeof emit === 'function') {
    try { emit({ type: 'notice', text: `Updated retired pool model(s): ${remapped.join(', ')}.` }); } catch (_) {}
  }
  let res;
  try {
    res = await orchPool.pruneUnserved(nextRows, { timeoutMs: 2500 });
  } catch (_) {
    return Object.assign({}, orch, { providers: nextRows }); // validation must never cost a turn
  }
  if (!res || !res.dropped.length) {
    poolNoticeDeduper.shouldEmitPruned('');
    return Object.assign({}, orch, { providers: (res && res.providers) || nextRows });
  }
  // Re-anchor the active row by identity so pruning an entry above it does not
  // silently switch the pool to a different model.
  const prevActive = Math.max(0, Number(orch.activeIndex) || 0);
  const activeRow = orch.providers[prevActive];
  const moved = activeRow ? res.providers.indexOf(activeRow) : 0;
  const detail = res.dropped
    .map((d) => (d.entry && d.entry.model ? d.entry.model : 'a model') + ' (' + d.why + ')')
    .join('; ');
  const noticeText = 'Left ' + res.dropped.length + ' orchestrator ' +
    (res.dropped.length === 1 ? 'model' : 'models') + ' out of this turn — ' + detail +
    '. The saved row is untouched; remove it in Settings if that gateway no longer serves it.';
  if (poolNoticeDeduper.shouldEmitPruned(noticeText)) {
    try { emit({ type: 'notice', text: noticeText }); } catch (_) {}
  }
  return Object.assign({}, orch, { providers: res.providers, activeIndex: moved < 0 ? 0 : moved });
}

// ---------------------------------------------------------------------------
// Subscription provider accounts (Claude Max, ChatGPT Plus/Pro, Antigravity,
// Grok). The renderer never sees a token: it asks for status, picks an
// account id, and the main process does the token minting at run time.
// ---------------------------------------------------------------------------
function oneLine(e) {
  const s = String((e && (e.message || e.error_description || e.error)) || e || 'unknown error')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (s || 'unknown error').slice(0, 240);
}

ipcMain.handle('autobot:providerStatus', async () => {
  try {
    let st = providerOauth.status();
    const broken = [];
    for (const p of (st.providers || [])) {
      for (const a of (p.accounts || [])) {
        if (a && (!a.hasToken || a.needsSignIn || a.expired)) broken.push(a);
      }
    }
    if (broken.length && providerOauth.autoHealAll) {
      await providerOauth.autoHealAll().catch(() => {});
      st = providerOauth.status();
    }
    // A dead refresh token does not mean a dead access token. Before reporting
    // an account as expired (which pushes the user back through sign-in), probe
    // it once — a success stamps `verifiedAt` and clears the badge.
    const stale = [];
    for (const p of (st.providers || [])) {
      for (const a of (p.accounts || [])) {
        if (a && a.expired) stale.push(String(a.id || (a.provider + ':' + a.account)));
      }
    }
    if (stale.length) {
      await Promise.all(stale.slice(0, 4).map((id) => {
        const cut = id.indexOf(':');
        return providerOauth.verifyAccount(id.slice(0, cut), id.slice(cut + 1)).catch(() => false);
      }));
      return { ok: true, status: providerOauth.status() };
    }
    return { ok: true, status: st };
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});

// The live model inventory of one subscription (Claude Max / ChatGPT /
// Antigravity / Grok). The renderer's picker used to hardcode a few ids; the
// real accounts expose 5–40 and they change, so ask the account itself.
// Returns the resolved context window per model, which is what the picker
// labels and what the auto-compact budget is derived from.
async function fetchProviderModels(id) {
  const raw = String(id || '');
  const provId = raw.split(':')[0];
  if (!provId) return { ok: false, error: 'which provider?' };
  const prov = providerOauth.provider(provId);
  if (!prov) return { ok: false, error: 'unknown provider' };

  let live = [];
  let warning = '';
  try {
    const r = await providerOauth.resolve(raw);
    if (r.transport === 'cli' && typeof cliRunner.probeCliModels === 'function') {
      live = await cliRunner.probeCliModels(provId, r.cliBin).catch(() => []);
    } else {
      live = await providertransport.listModels({
        transport: r.transport,
        accessToken: r.accessToken,
        apiKey: r.accessToken,
        accountId: r.accountId,
        codexUrl: r.codexUrl,
        cloudcodeUrl: r.cloudcodeUrl,
        baseURL: r.baseURL,
        model: '',
      });
    }
  } catch (e) {
    // A provider whose token is dead still has a documented catalog: fall
    // through to the registry list instead of returning an empty picker.
    warning = oneLine(e);
  }
  const mergedLive = live.length ? [...live] : [];
  if (mergedLive.length && Array.isArray(prov.models)) {
    const seenIds = new Set(mergedLive.map((x) => String(x && x.id || '').toLowerCase()));
    for (const pm of prov.models) {
      if (pm && pm.id && !seenIds.has(String(pm.id).toLowerCase())) {
        mergedLive.push({ ...pm });
      }
    }
  }
  if (mergedLive.length) {
    modelCatalog.register(provId, mergedLive);
    // A live inventory answered, so this account is verified by evidence — not
    // by a hardcoded provider id list in the renderer. For ChatGPT also ask the
    // account endpoint for the real plan: its token often omits the claim, so a
    // label from sign-up time would otherwise masquerade as an entitlement.
    const acct = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : '';
    try { providerOauth.markVerified(provId, acct); } catch (_) {}
    Promise.resolve(providerOauth.refreshEntitlement(provId, acct)).catch(() => {});
  }

  const entries = mergedLive.length
    ? mergedLive
    : (prov.models || []).map((m) => ({ id: m.id, label: m.label, contextWindow: Number(m.contextWindow) || 0, thinking: m.thinking !== false }));
  const models = entries.map((m) => {
    const ruleFloor = modelCatalog.ruleContextWindowFor ? modelCatalog.ruleContextWindowFor(m.id) : 0;
    const rawWin = Number(m.contextWindow) || 0;
    const safeExplicit = (ruleFloor >= 1000000 && rawWin > 0 && rawWin < ruleFloor) ? ruleFloor : rawWin;
    const win = modelCatalog.contextWindowFor(m.id, provId, safeExplicit);
    const caps = modelCatalog.thinkingCapabilitiesFor(m.id, provId);
    const levels = Array.isArray(m.thinkingLevels) && m.thinkingLevels.length ? m.thinkingLevels : caps.levels;
    const variants = m.thinkingVariants || caps.variants || undefined;
    return {
      id: m.id,
      label: m.label || m.id,
      contextWindow: win,
      windowLabel: modelCatalog.fmtWindow(win),
      thinking: typeof m.thinking === 'boolean' ? m.thinking : caps.supported,
      thinkingLevels: levels,
      thinkingVariants: variants,
      group: m.group || '',
    };
  });
  if (models.length && process.env.AKRON_NO_DIALOG !== '1') {
    const cur = readModelWindowsCache();
    cur.providers[provId] = models.map((m) => ({ id: m.id, label: m.label, contextWindow: m.contextWindow }));
    if (!cur.fetchedAt) cur.fetchedAt = Date.now();
    writeModelWindowsCache(cur);
  }
  if (mergedLive.length) {
    try { broadcast({ type: 'model-catalog-updated', providerId: provId, accountId: raw, models }); } catch (_) {}
  }
  return {
    ok: true,
    providerId: provId,
    live: live.length > 0,
    count: models.length,
    models,
    warning: warning || undefined,
  };
}

/**
 * Hydrate cached context windows from disk and periodically refresh public
 * OpenRouter model metadata (non-blocking) so newly shipped models never fall
 * back to stale context sizes.
 */
async function warmOpenRouterContextMetadata(force = false) {
  const cur = readModelWindowsCache();
  if (cur.providers && typeof cur.providers === 'object') {
    for (const [pid, rows] of Object.entries(cur.providers)) {
      if (Array.isArray(rows) && rows.length) {
        const sanitized = rows.map((r) => {
          if (!r || !r.id) return r;
          const floor = modelCatalog.ruleContextWindowFor ? modelCatalog.ruleContextWindowFor(r.id) : 0;
          const w = Number(r.contextWindow) || 0;
          return (floor >= 1000000 && w > 0 && w < floor) ? { ...r, contextWindow: floor } : r;
        });
        modelCatalog.register(pid, sanitized);
      }
    }
  }
  if (!force && (process.env.AKRON_NO_DIALOG === '1' || process.env.AKRON_ISOLATE_RUNTIMES === '1')) {
    return 0;
  }
  const now = Date.now();
  if (!force && cur.fetchedAt && (now - cur.fetchedAt) < MODEL_WINDOWS_TTL_MS && _openRouterWarmedAt) {
    return 0;
  }
  _openRouterWarmedAt = now;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return 0;
    const json = await res.json();
    const rows = Array.isArray(json && json.data) ? json.data : [];
    const byOr = [];
    for (const m of rows) {
      const id = String((m && m.id) || '').trim();
      const win = Number(m && (m.context_length || (m.top_provider && m.top_provider.context_length))) || 0;
      if (!id || win <= 0) continue;
      byOr.push({ id, contextWindow: win });
      const shortSlug = id.includes('/') ? id.split('/').pop() : id;
      if (shortSlug && shortSlug !== id) byOr.push({ id: shortSlug, contextWindow: win });
    }
    if (byOr.length) {
      modelCatalog.register('openrouter', byOr);
      cur.fetchedAt = now;
      cur.providers.openrouter = byOr;
      writeModelWindowsCache(cur);
    }
    return byOr.length;
  } catch (_) {
    return 0;
  }
}

/**
 * Ask every signed-in provider for its model catalog once, shortly after boot.
 *
 * The context window that drives auto-compaction is resolved from this catalog
 * (a live 16K model must not be trimmed at a documented 128K default). It used
 * to be fetched only when the user opened the model picker, so a turn sent
 * before that resolved to the offline fallback and an oversized prompt was sent
 * over the model's real window. Best-effort and serial: a dead token must not
 * delay boot.
 */
async function warmModelCatalogs() {
  await warmOpenRouterContextMetadata(false).catch(() => {});
  let providers = [];
  try { providers = (providerOauth.status() || {}).providers || []; } catch (_) { return; }
  for (const p of providers) {
    const accounts = Array.isArray(p.accounts) ? p.accounts : [];
    for (const acct of accounts) {
      const id = acct && acct.id ? String(acct.id) : `${p.id}:${acct && acct.account}`;
      try { await fetchProviderModels(id); } catch (_) {}
    }
  }
}

ipcMain.handle('autobot:providerModels', async (event, id) => {
  try {
    return await fetchProviderModels(id);
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:refreshModelCatalogs', async () => {
  try {
    await warmModelCatalogs();
    return { ok: true, snapshot: modelCatalog.snapshot() };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

// One browser sign-in per provider at a time. Two surfaces (Settings and the
// composer picker) can start the same flow, and a second attempt would fight
// the first for the provider's registered loopback port — which for OpenAI is
// exactly one port (1455). Concurrent callers share the attempt instead.
const providerSignInFlows = new Map(); // provId -> { promise, ctrl }

ipcMain.handle('autobot:providerSignIn', async (event, id) => {
  const provId = String(id || '');
  // Claude's credential belongs to the Claude Code CLI. Any OAuth started here
  // would mint a second refresh token and sign the CLI out, so this path is
  // closed and the renderer is pointed at the CLI-owned reconnect flow.
  if (provId === 'claude') {
    return {
      ok: false,
      noIndependentOauth: true,
      error: 'Claude is signed in through the Claude Code app. Use Reconnect Claude Code — this app adopts that sign-in rather than starting its own.',
    };
  }
  if (providerSignInFlows.has(provId)) return providerSignInFlows.get(provId).promise;
  const ctrl = new AbortController();
  // Keep the authorize URL: if the browser never opened (or the user closed the
  // tab) the renderer can offer the link again instead of leaving a spinner up.
  const entry = { promise: null, ctrl, url: '', startedAt: Date.now() };
  const attempt = (async () => {
    try {
      const rec = await providerOauth.authorize(provId, {
        openExternal: (url) => { entry.url = url; try { shell.openExternal(url); } catch (_) {} },
        signal: ctrl.signal,
      });
      // Register the new account's live catalog immediately: the very next turn
      // must compact against the real context window of whatever model it picks.
      poolNoticeDeduper.reset();
      try {
        if (rec && rec.id) await fetchProviderModels(rec.id);
      } catch (_) {}
      return { ok: true, account: rec };
    } catch (e) {
      if ((e && e.code) === 'signin_cancelled') return { ok: false, cancelled: true, error: 'Sign-in cancelled.' };
      return { ok: false, error: oneLine(e) };
    }
  })();
  entry.promise = attempt;
  providerSignInFlows.set(provId, entry);
  try { return await attempt; } finally { providerSignInFlows.delete(provId); }
});

// Is a browser sign-in still waiting, and on which URL? Pure status — no secret
// crosses the bridge (the URL carries only the public PKCE challenge + state).
ipcMain.handle('autobot:providerSignInState', (event, id) => {
  const provId = String(id || '');
  const flow = providerSignInFlows.get(provId);
  if (!flow) return { ok: true, waiting: false };
  return { ok: true, waiting: true, url: flow.url || '', startedAt: flow.startedAt };
});

// Abandon a browser sign-in that is waiting for a redirect: the user picked the
// wrong provider, or the browser tab is gone. Frees the loopback port at once
// instead of leaving the row busy until the 10-minute timeout.
ipcMain.handle('autobot:providerSignInCancel', async (event, id) => {
  const provId = String(id || '');
  const flow = providerSignInFlows.get(provId);
  if (!flow) return { ok: true, waiting: false };
  try { flow.ctrl.abort(); } catch (_) {}
  return { ok: true, waiting: false, cancelled: true };
});

// Manual sign-in: no loopback listener, the provider shows a code on its own
// page and the user pastes it back. This is the only path that works when the
// browser cannot reach 127.0.0.1/::1 (containers, remote sessions, a browser on
// another machine) — and it is what the Claude CLI falls back to.
const pendingManualSignIn = new Map();
let manualFlowSeq = 0;

ipcMain.handle('autobot:providerSignInManual', async (event, id) => {
  const provId = String(id || '');
  // Same ownership rule as `autobot:providerSignIn`: no independent Claude OAuth.
  if (provId === 'claude') {
    return {
      ok: false,
      noIndependentOauth: true,
      error: 'Claude is signed in through the Claude Code app. Use Reconnect Claude Code instead.',
    };
  }
  const flowId = provId + ':' + (++manualFlowSeq) + ':' + Date.now();
  let resolveCode = null;
  let timer = null;
  const codePromise = new Promise((res) => { resolveCode = res; });
  let url = '';
  const opened = new Promise((res) => {
    const task = providerOauth.authorize(provId, {
      openExternal: (u) => { url = u; res(u); try { shell.openExternal(u); } catch (_) {} },
      manual: true,
      waitForCode: () => codePromise,
    });
    task.then(async (rec) => {
      if (timer) clearTimeout(timer);
      pendingManualSignIn.delete(flowId);
      poolNoticeDeduper.reset();
      try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
      try { event.sender.send('autobot:providerManualResult', flowId, { ok: true, account: rec }); } catch (_) {}
    }).catch((e) => {
      if (timer) clearTimeout(timer);
      pendingManualSignIn.delete(flowId);
      try { event.sender.send('autobot:providerManualResult', flowId, { ok: false, error: oneLine(e) }); } catch (_) {}
    });
  });
  // Do not wait forever on a code nobody pastes.
  timer = setTimeout(() => {
    const f = pendingManualSignIn.get(flowId);
    if (f) { f.resolveCode(''); pendingManualSignIn.delete(flowId); }
  }, 15 * 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
  // Wait just long enough for the authorize URL to be built (openExternal fires
  // synchronously, before the code wait starts).
  const built = await Promise.race([opened, new Promise((res) => setTimeout(() => res(''), 4000))]);
  pendingManualSignIn.set(flowId, { resolveCode, provId });
  return { ok: true, flowId, url: url || built };
});

ipcMain.handle('autobot:providerSubmitCode', (event, flowId, code) => {
  const f = pendingManualSignIn.get(String(flowId || ''));
  if (!f) return { ok: false, error: 'that sign-in is no longer waiting — start it again' };
  const v = String(code || '').trim();
  if (!v) return { ok: false, error: 'paste the code the sign-in page shows' };
  f.resolveCode(v);
  return { ok: true };
});

ipcMain.handle('autobot:providerSignOut', async (event, id, account) => {
  try {
    const raw = String(id || '');
    const [provId, ...rest] = raw.split(':');
    const acct = account || rest.join(':');
    if (!acct) return { ok: false, error: 'which account?' };
    const res = providerOauth.signOutAccount
      ? await providerOauth.signOutAccount(provId, acct)
      : { ok: true, removed: providerOauth.removeAccount(provId, acct) };
    poolNoticeDeduper.reset();
    try { broadcast({ type: 'models:updated', providerId: provId }); } catch (_) {}
    return { ok: true, removed: Boolean(res && res.removed) };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:providerImport', async () => {
  try {
    const result = await providerOauth.importLocal();
    poolNoticeDeduper.reset();
    // Adoption brings a new account (and therefore a new catalog) into play.
    try { await warmModelCatalogs(); } catch (_) {}
    return { ok: true, result };
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});

ipcMain.handle('autobot:providerAddBearer', async (event, id, token, label) => {
  try {
    if (!token) return { ok: false, error: 'a token is required' };
    const rec = await providerOauth.addBearer(String(id || ''), String(token), { label: label || '' });
    poolNoticeDeduper.reset();
    return { ok: true, account: rec };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

ipcMain.handle('autobot:providerSetActive', (event, id, account) => {
  try {
    const raw = String(id || '');
    const [provId, ...rest] = raw.split(':');
    const acct = account || rest.join(':');
    return { ok: true, active: providerOauth.setActive(provId, acct) };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
});

// ---------------------------------------------------------------------------
// Reconnecting Claude without ever running a second OAuth flow
// ---------------------------------------------------------------------------
// The refresh token is single-use. If this app mints its own grant, the next
// rotation on either side permanently invalidates the other, which is exactly
// how the CLI got signed out. So "reconnect" means: drive the owner's own login
// (`claude auth login`), let the CLI write its credential to the keychain, then
// adopt that credential. Nothing here invents an OAuth client.

/** Finish a Claude rotation whose keychain write-back was interrupted at exit. */
function replayClaudeRotation() {
  try {
    const done = providerOauth.replayRotationJournal();
    if (done) console.log('claude rotation journal replayed:', oneLine(done));
    return done;
  } catch (e) {
    console.error('claude rotation replay skipped:', oneLine(e));
    return null;
  }
}

let claudeLoginFlow = null; // { flowId, child, url, buffered, alive }

/**
 * A flow object outlives its process if the exit notification never reaches us
 * (a child that is reaped by a signal, a spawn that raced, a window that was
 * torn down). Handing that stale flow back to the renderer gives the user a URL
 * that no longer feeds a live login and a paste box that swallows the code, so
 * liveness is decided from the handle, never from the singleton being non-null.
 */
function flowIsLive(f) {
  if (!f || !f.alive) return false;
  const c = f.child;
  if (!c) return false;
  if (c.exitCode !== null && c.exitCode !== undefined) return false;
  if (c.signalCode) return false;
  return true;
}

/**
 * The Claude Code CLI binds its OAuth callback on `127.0.0.1:<random>` only. A
 * browser handed `http://localhost:<port>/callback` resolves localhost to ::1
 * first and shows ERR_CONNECTION_REFUSED, so the redirect never reaches the CLI
 * and the user is forced to copy a URL out of the address bar every time. Mirror
 * the CLI's port on ::1 so the redirect lands on whichever stack the browser
 * picked; the CLI still receives it, unchanged, over IPv4.
 */
function listenPortsOf(pid) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-p', String(pid), '-a', '-iTCP', '-sTCP:LISTEN', '-Fn'],
      { timeout: 4000 }, (err, stdout) => {
        const ports = new Set();
        for (const line of String(stdout || '').split('\n')) {
          const m = line.match(/^n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)$/);
          if (m) ports.add(Number(m[1]));
        }
        resolve([...ports]);
      });
  });
}

async function mirrorLoopbackOnIpv6(flow) {
  const pid = flow.child && flow.child.pid;
  if (!pid) return 0;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && flowIsLive(flow)) {
    const ports = await listenPortsOf(pid);
    if (ports.length) {
      const port = ports[0];
      const srv = net.createServer((c6) => {
        const c4 = net.connect({ host: '127.0.0.1', port });
        const drop = () => { try { c6.destroy(); } catch (_) {} try { c4.destroy(); } catch (_) {} };
        c6.on('error', drop);
        c4.on('error', drop);
        c6.pipe(c4);
        c4.pipe(c6);
      });
      const bound = await new Promise((res) => {
        srv.once('error', () => res(false));
        srv.listen({ host: '::1', port, ipv6Only: true }, () => res(true));
      });
      if (!bound) {
        console.log('[claude-login] ipv6 relay could not bind port', port);
        return 0; // IPv4-only browser, or the port is taken — not fatal
      }
      flow.relayPort = port;
      flow.relay = srv;
      console.log('[claude-login] ipv6 relay [::1]:' + port + ' -> 127.0.0.1:' + port);
      return port;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return 0;
}

async function cliPathForProvider(prov) {
  if (!prov) return '';
  try {
    const rt = typeof getRuntimes === 'function' ? getRuntimes() : null;
    const resolved = await cliRunner.resolveCliBinary({ cliKind: prov.id, cliId: prov.cliId, cliBin: prov.bin }, { runtimes: rt });
    if (resolved && resolved.bin && fs.existsSync(resolved.bin)) return resolved.bin;
    if (resolved && resolved.bin && (resolved.bin.includes('/') || resolved.bin.includes('\\'))) return resolved.bin;
  } catch (_) {}
  const base = typeof bundledRuntimeDir === 'function' ? bundledRuntimeDir() : '';
  if (base && prov.cliId && prov.bin) {
    const ext = process.platform === 'win32' ? '.cmd' : '';
    const cands = [
      path.join(base, prov.cliId, 'bin', prov.bin + (process.platform === 'win32' ? '.exe' : '')),
      path.join(base, prov.cliId, 'bin', prov.bin + ext),
      path.join(base, prov.cliId, 'bin', prov.bin),
    ];
    for (const c of cands) {
      try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
  }
  const bins = [prov.bin, ...(prov.fallbackBins || [])].filter(Boolean);
  for (const b of bins) {
    const hit = cliRunner.whichOnPath(b);
    if (hit) return hit;
  }
  return '';
}

function claudeCliPath() {
  return cliPathForProvider(providerOauth.provider('claude'));
}

// Unified native CLI login manager (claude, chatgpt/codex, antigravity/gemini, grok, kimi, zai/zcode)
const cliLoginFlows = new Map(); // provId -> flow
const cliLoginStarts = new Map(); // provId -> Promise

function extractDeviceUserCode(text) {
  const clean = String(text || '');
  const explicit = clean.match(/(?:code|enter\s+code|user\s+code|verification\s+code)\s*[:=]\s*([A-Z0-9]{4,6}-[A-Z0-9]{4,6})/i);
  if (explicit) return explicit[1].toUpperCase();
  const dash = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/);
  if (dash && !/^20[0-9]{2}-[0-9]{2}$/.test(dash[1])) return dash[1].toUpperCase();
  return '';
}

function cliLoginSpecForProvider(prov, bin, opts = {}) {
  const baseName = path.basename(String(bin || prov.bin || '')).toLowerCase();
  if (prov.id === 'claude') {
    return { args: ['auth', 'login'], useIpv6Relay: true, requiresCodePaste: true };
  }
  if (prov.id === 'chatgpt') {
    const args = opts.deviceAuth ? ['login', '--device-auth'] : ['login'];
    return { args, useIpv6Relay: false, supportsDeviceAuth: true };
  }
  if (prov.id === 'antigravity') {
    if (baseName.startsWith('agy')) return { args: ['auth', 'login'], useIpv6Relay: false };
    // Gemini CLI interactive/first-run auth prints an OAuth URL/code cleanly when NO_BROWSER=true
    return { args: [], useIpv6Relay: false, extraEnv: { NO_BROWSER: 'true', GEMINI_CLI_NO_RELAUNCH: 'true' }, killAfterUrlSuccess: false };
  }
  if (prov.id === 'grok') {
    const args = opts.deviceAuth ? ['login', '--device-auth'] : ['login'];
    return { args, useIpv6Relay: false, supportsDeviceAuth: true };
  }
  if (prov.id === 'kimi') {
    return { args: opts.region ? ['login', '--region', String(opts.region)] : ['login'], useIpv6Relay: false };
  }
  if (prov.id === 'zai') {
    return { args: ['login'], useIpv6Relay: false };
  }
  return { args: prov.authLoginArgs || ['login'], useIpv6Relay: false };
}

async function startCliLogin(event, providerId, opts = {}) {
  try {
    const prov = providerOauth.provider(providerId || 'claude');
    if (!prov) return { ok: false, error: `Unknown provider: ${providerId}` };

    if (prov.id === 'zai' && !opts.useCli) {
      const zcodeBin = await cliPathForProvider(prov);
      if (!zcodeBin) {
        return {
          ok: true,
          mode: 'api-key',
          provider: prov.id,
          label: prov.label,
          docsUrl: prov.docs || 'https://z.ai/manage-apikey/apikey-list',
          baseURL: prov.bearerBaseURL || 'https://api.z.ai/api/coding/paas/v4',
        };
      }
    }

    const existing = cliLoginFlows.get(prov.id);
    if (flowIsLive(existing)) {
      return {
        ok: true,
        flowId: existing.flowId,
        provider: prov.id,
        label: prov.label,
        url: existing.url,
        userCode: existing.userCode || '',
        lines: existing.lines.slice(),
        already: true,
      };
    }
    cliLoginFlows.delete(prov.id);

    const bin = await cliPathForProvider(prov);
    if (!bin) {
      return {
        ok: false,
        provider: prov.id,
        error: `The bundled ${prov.label} CLI (${prov.bin}) is missing — check Settings → Runtimes & Updates.`,
      };
    }

    const spec = cliLoginSpecForProvider(prov, bin, opts);
    const flowId = `${prov.id}-login:${Date.now()}`;
    const prefix = typeof runtimePathPrefix === 'function' ? await runtimePathPrefix().catch(() => '') : '';
    const mergedPath = prefix
      ? [prefix, ...String(process.env.PATH || '').split(path.delimiter).filter((d) => d && d !== prefix)].join(path.delimiter)
      : process.env.PATH;
    const env = Object.assign({}, process.env, {
      BROWSER: 'true',
      ...(mergedPath ? { PATH: mergedPath } : {}),
      ...(spec.extraEnv || {}),
    });
    const spawnImpl = opts.spawnImpl || spawn;
    const child = spawnImpl(bin, spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true });
    const flow = {
      flowId,
      provider: prov.id,
      label: prov.label,
      child,
      url: '',
      userCode: '',
      openedExternal: false,
      buffered: '',
      lines: [],
      alive: true,
      relay: null,
      relayPort: 0,
    };
    cliLoginFlows.set(prov.id, flow);
    if (prov.id === 'claude') claudeLoginFlow = flow;

    const relayReady = spec.useIpv6Relay
      ? mirrorLoopbackOnIpv6(flow).catch(() => 0)
      : Promise.resolve(0);

    const sender = event && event.sender;
    const emitEvent = (payload) => {
      const full = { flowId, provider: prov.id, label: prov.label, ...payload };
      try {
        if (sender && !sender.isDestroyed()) sender.send('oauth:cli-login-event', full);
      } catch (_) {}
      try { broadcast({ type: 'oauth:cli-login-event', ...full }); } catch (_) {}
    };
    const sendLegacy = (channel, id, payload) => {
      try { if (sender && !sender.isDestroyed()) sender.send(channel, id, payload); } catch (_) {}
      if (prov.id === 'claude') {
        try { broadcast({ type: 'provider-reconnect', flowId: id, ...payload }); } catch (_) {}
      }
    };

    const ansi = (s) => String(s)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

    const maybeOpenExternal = (u) => {
      if (!u || flow.openedExternal) return;
      flow.openedExternal = true;
      if (opts.autoOpen === false || process.env.AKRON_NO_DIALOG === '1') return;
      try { shell.openExternal(u); } catch (_) {}
    };

    const scrape = (chunk, fromStderr) => {
      const text = ansi(chunk);
      flow.buffered += text;
      let updatedAuthInfo = false;
      if (!flow.url) {
        const authUrl = prov.id === 'claude'
          ? flow.buffered.match(/https:\/\/[^\s"'<>]+oauth\/authorize[^\s"'<>]*/)
          : flow.buffered.match(/https:\/\/[^\s"'<>]+/);
        if (authUrl) {
          flow.url = authUrl[0].replace(/[.,;)]+$/, '');
          updatedAuthInfo = true;
          maybeOpenExternal(flow.url);
        }
      }
      if (!flow.userCode) {
        const uc = extractDeviceUserCode(flow.buffered);
        if (uc) {
          flow.userCode = uc;
          updatedAuthInfo = true;
        }
      }
      if (updatedAuthInfo) {
        emitEvent({ phase: 'url', url: flow.url, userCode: flow.userCode });
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line) continue;
        if (prov.id === 'claude' && /oauth\/authorize|didn't open|Opening browser|Paste code here/i.test(line)) continue;
        flow.lines.push(line.slice(0, 220));
        if (flow.lines.length > 8) flow.lines.shift();
        emitEvent({ phase: 'output', line: line.slice(0, 220), url: flow.url, userCode: flow.userCode, fromStderr: !!fromStderr });
        if (prov.id === 'claude') {
          try {
            sendLegacy('autobot:providerReconnectLine', flowId, {
              line: line.slice(0, 220),
              retryable: isRetryableLine(line),
            });
          } catch (_) {}
        }
      }
    };

    if (child.stdout) child.stdout.on('data', (c) => scrape(c, false));
    if (child.stderr) child.stderr.on('data', (c) => scrape(c, true));

    const settle = async (result) => {
      if (!flow.alive) return;
      flow.alive = false;
      if (cliLoginFlows.get(prov.id) === flow) cliLoginFlows.delete(prov.id);
      if (claudeLoginFlow === flow) claudeLoginFlow = null;
      if (flow.relay) { try { flow.relay.close(); } catch (_) {} flow.relay = null; }
      if (result && result.ok) {
        try {
          if (prov.id === 'claude' && providerOauth.adoptClaudeFromCli) {
            const rec = await providerOauth.adoptClaudeFromCli();
            poolNoticeDeduper.reset();
            try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
            try { await warmModelCatalogs(); } catch (_) {}
            emitEvent({ phase: 'done', ok: true, account: rec });
            sendLegacy('autobot:providerReconnectResult', flowId, { ok: true, account: rec });
          } else {
            await providerOauth.syncCliAccounts(prov.id).catch(() => {});
            const rec = (providerOauth.getAccount && providerOauth.getAccount(prov.id))
              || providerOauth.addAccount(prov.id, { account: 'cli', label: `${prov.label} CLI`, plan: 'CLI Subscription', source: 'cli' });
            poolNoticeDeduper.reset();
            try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
            try { await warmModelCatalogs(); } catch (_) {}
            try { broadcast({ type: 'models:updated', providerId: prov.id }); } catch (_) {}
            emitEvent({ phase: 'done', ok: true, account: rec });
          }
        } catch (e) {
          const msg = oneLine(e);
          emitEvent({ phase: 'error', ok: false, error: msg });
          sendLegacy('autobot:providerReconnectResult', flowId, { ok: false, error: msg });
        }
      } else {
        const msg = (result && result.error) || `${prov.label} sign-in did not complete`;
        emitEvent({ phase: result && result.cancelled ? 'cancelled' : 'error', ok: false, cancelled: !!(result && result.cancelled), error: msg });
        sendLegacy('autobot:providerReconnectResult', flowId, { ok: false, error: msg });
      }
    };

    child.on('exit', (code, signal) => {
      if (code !== 0) {
        const said = String((flow.lines || []).slice(-1)[0] || '');
        const cancelled = Boolean(signal || /cancel/i.test(said));
        const err = cancelled
          ? `${prov.label} sign-in was cancelled`
          : (said || `${prov.label} sign-in did not complete (exit ${code})`);
        return settle({ ok: false, cancelled, error: err });
      }
      settle({ ok: true });
    });
    child.on('error', (e) => settle({ ok: false, error: e.message }));

    // Give CLI up to 3.5s to emit URL / userCode, then return live flow immediately
    const waitMs = opts.waitMs != null ? Number(opts.waitMs) : (prov.id === 'claude' ? 6000 : 3500);
    const deadline = Date.now() + waitMs;
    while (!flow.url && !flow.userCode && Date.now() < deadline && flowIsLive(flow)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (prov.id === 'claude' && !flow.url && !flow.userCode && !flowIsLive(flow)) {
      return { ok: false, provider: prov.id, error: (flow.lines.slice(-1)[0]) || 'Claude Code did not print a sign-in URL — try `claude auth login` in terminal' };
    }
    await Promise.race([relayReady, new Promise((r) => setTimeout(() => r(0), 2500))]);
    emitEvent({ phase: 'waiting', url: flow.url, userCode: flow.userCode });
    return {
      ok: true,
      flowId,
      provider: prov.id,
      label: prov.label,
      url: flow.url,
      userCode: flow.userCode,
      requiresCodePaste: Boolean(spec.requiresCodePaste),
      supportsDeviceAuth: Boolean(spec.supportsDeviceAuth),
      waiting: flowIsLive(flow),
    };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
}

function cancelCliLogin(providerId) {
  const prov = providerOauth.provider(providerId || 'claude');
  const key = prov ? prov.id : String(providerId || 'claude');
  const f = cliLoginFlows.get(key) || (key === 'claude' ? claudeLoginFlow : null);
  if (!f) return { ok: true, cancelled: false };
  f.alive = false;
  cliLoginFlows.delete(key);
  if (claudeLoginFlow === f) claudeLoginFlow = null;
  try { f.child.kill('SIGTERM'); } catch (_) {}
  if (f.relay) { try { f.relay.close(); } catch (_) {} f.relay = null; }
  try { broadcast({ type: 'oauth:cli-login-event', flowId: f.flowId, provider: key, phase: 'cancelled', ok: false, cancelled: true }); } catch (_) {}
  return { ok: true, cancelled: true, flowId: f.flowId, provider: key };
}

function submitCliLoginCode(flowId, code) {
  const fid = String(flowId || '');
  let f = null;
  for (const flow of cliLoginFlows.values()) {
    if (flow && flow.flowId === fid) { f = flow; break; }
  }
  if (!f && claudeLoginFlow && claudeLoginFlow.flowId === fid) f = claudeLoginFlow;
  if (!f) return { ok: false, error: 'that sign-in is no longer waiting — start it again' };
  if (!flowIsLive(f)) {
    f.alive = false;
    cliLoginFlows.delete(f.provider);
    if (claudeLoginFlow === f) claudeLoginFlow = null;
    return { ok: false, error: 'that sign-in window closed before the code arrived — start it again' };
  }
  const v0 = String(code || '').trim();
  const norm = normalizeReconnectCode(v0);
  if (!norm.ok) return { ok: false, error: norm.error };
  try {
    if (!f.child.stdin || f.child.stdin.destroyed || f.child.stdin.writable === false) {
      f.alive = false;
      cliLoginFlows.delete(f.provider);
      if (claudeLoginFlow === f) claudeLoginFlow = null;
      return { ok: false, error: 'that sign-in window closed before the code arrived — start it again' };
    }
    f.child.stdin.write(norm.value + '\n');
    return { ok: true };
  } catch (e) {
    f.alive = false;
    cliLoginFlows.delete(f.provider);
    if (claudeLoginFlow === f) claudeLoginFlow = null;
    return { ok: false, error: oneLine(e) };
  }
}

function getCliLoginState(providerId) {
  const prov = providerOauth.provider(providerId || 'claude');
  const key = prov ? prov.id : String(providerId || 'claude');
  const f = cliLoginFlows.get(key) || (key === 'claude' ? claudeLoginFlow : null);
  const live = flowIsLive(f);
  return {
    ok: true,
    provider: key,
    waiting: live,
    flowId: live ? f.flowId : '',
    url: live ? f.url : '',
    userCode: live ? (f.userCode || '') : '',
    lines: live ? f.lines.slice() : [],
    pid: live && f.child && f.child.pid ? f.child.pid : 0,
  };
}

ipcMain.handle('oauth:startCliLogin', async (event, providerId, opts) => {
  const key = String(providerId || 'claude').trim().toLowerCase();
  if (cliLoginStarts.has(key)) return cliLoginStarts.get(key);
  const p = startCliLogin(event, key, opts || {})
    .finally(() => { cliLoginStarts.delete(key); });
  cliLoginStarts.set(key, p);
  return p;
});

ipcMain.handle('oauth:cancelCliLogin', (_event, providerId) => cancelCliLogin(providerId));
ipcMain.handle('oauth:cliLoginState', (_event, providerId) => getCliLoginState(providerId));
ipcMain.handle('oauth:submitCliLoginCode', (_event, flowId, code) => submitCliLoginCode(flowId, code));

async function startClaudeLogin(event) {
  return startCliLogin(event, 'claude', {});
}

let claudeLoginStart = null;
ipcMain.handle('autobot:providerReconnectClaude', async (event) => {
  if (claudeLoginStart) return claudeLoginStart;
  const p = startClaudeLogin(event)
    .then((r) => { claudeLoginStart = null; return r; },
          (e) => { claudeLoginStart = null; throw e; });
  claudeLoginStart = p;
  return p;
});

ipcMain.handle('autobot:providerReconnectClaudeCode', (event, flowId, code) => {
  return submitCliLoginCode(flowId, code);
});

ipcMain.handle('autobot:providerReconnectClaudeCancel', () => {
  return cancelCliLogin('claude');
});

ipcMain.handle('autobot:providerReconnectState', () => {
  return getCliLoginState('claude');
});

// Re-import after an external `claude auth login` (the user may have run it in
// a terminal instead of through the button).
ipcMain.handle('autobot:providerAdoptClaude', async () => {
  try {
    const rec = await providerOauth.adoptClaudeFromCli();
    poolNoticeDeduper.reset();
    try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
    try { await warmModelCatalogs(); } catch (_) {}
    return { ok: true, account: rec };
  } catch (e) {
    return { ok: false, error: oneLine(e), needsSignIn: e.code === 'provider_needs_signin' };
  }
});

  ipcMain.handle('autobot:providerAutoHeal', async (_e, opts) => {
    try {
      const res = providerOauth.autoHealAll
        ? await providerOauth.autoHealAll({ importMissing: !(opts && opts.importMissing === false) })
        : { ok: false, healed: [], imported: [] };
      if ((res.healed && res.healed.length) || (res.imported && res.imported.length)) {
        poolNoticeDeduper.reset();
        try { await warmModelCatalogs(); } catch (_) {}
      }
      return { ...res, status: providerOauth.status() };
    } catch (e) {
      return { ok: false, error: oneLine(e) };
    }
  });

  // Boot + 10-minute background OAuth auto-heal & keep-alive across macOS, Windows, and Linux.
  const runKeepAlivePass = async () => {
    try {
      if (providerOauth.autoHealAll) {
        await providerOauth.autoHealAll({ importMissing: true }).catch(() => {});
      }
      const accounts = providerOauth.listAccounts ? providerOauth.listAccounts() : [];
      for (const a of accounts) {
        if (!a || a.needsSignIn || !a.hasToken) continue;
        try {
          await providerOauth.ensureToken(a.provider, a.account);
        } catch (_) {}
      }
    } catch (_) {}
  };
  const startupHealTimer = setTimeout(runKeepAlivePass, 2000);
  if (startupHealTimer && typeof startupHealTimer.unref === 'function') startupHealTimer.unref();
  const keepAliveTimer = setInterval(runKeepAlivePass, 10 * 60 * 1000);
  if (keepAliveTimer && typeof keepAliveTimer.unref === 'function') keepAliveTimer.unref();
  const catalogRefreshTimer = setInterval(() => { warmModelCatalogs().catch(() => {}); }, 30 * 60 * 1000);
  if (catalogRefreshTimer && typeof catalogRefreshTimer.unref === 'function') catalogRefreshTimer.unref();

  return { freellmFallbackApiKey, hydrateLocalFreeLlmProvider, hydrateProvider, validateOrchestrator, oneLine, fetchProviderModels, warmModelCatalogs, replayClaudeRotation };
};