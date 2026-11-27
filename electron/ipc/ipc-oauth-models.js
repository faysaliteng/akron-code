'use strict';
const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn, execFile } = require('child_process');
const { dialog, shell } = require('electron');
const orchRouter = require('../orch-router');

module.exports = function registerOauthModelIpc(ctx) {
  const { ipcMain, store, secretstore, freellm, providerOauth, providertransport, modelCatalog, orchPool, normalizeReconnectCode, isRetryableLine, winFor, broadcast, poolNoticeDeduper, bundledRuntimeDir, getRuntimes } = ctx;

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
    if (!r || !r.accessToken) {
      if (providerOauth.autoHealAll) await providerOauth.autoHealAll().catch(() => {});
      r = await providerOauth.resolve(targetId, { force: true });
    }
  } catch (e) {
    try {
      if (providerOauth.autoHealAll) await providerOauth.autoHealAll({ importMissing: true }).catch(() => {});
      r = await providerOauth.resolve(targetId, { force: true });
    } catch (e2) {
      // A dead refresh token is a sign-in problem, not an LLM failure. Surface one
      // human line instead of an OAuth error code the composer can't act on.
      const prov = providerOauth.provider(targetId.split(':')[0]);
      const label = (prov && prov.label) || 'This provider';
      const err = new Error(`${label} needs to be signed in again — open the model menu and choose Sign in.`);
      err.code = 'provider_needs_signin';
      err.human = true;
      err.cause = e2 || e;
      throw err;
    }
  }
  const out = Object.assign({}, provider, {
    // Native transport wins over any OpenAI-compatible baseURL the renderer had.
    transport: r.transport,
    accessToken: r.accessToken,
    account: r.account,
    // `chatgpt-account-id` is mandatory on the Codex responses endpoint; without
    // it the request is rejected even with a perfectly valid bearer token.
    accountId: r.accountId || provider.accountId || '',
    codexUrl: r.codexUrl || provider.codexUrl || '',
    cloudcodeUrl: r.cloudcodeUrl || provider.cloudcodeUrl || '',
    oauth: true,
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
  // Providers with no bespoke wire adapter are plain OpenAI-compatible bearers
  // (xAI/Grok today). Hand the token over as the key so the ordinary
  // `{baseURL}/chat/completions` path uses it, and clear `transport` so
  // nothing tries to find an adapter that doesn't exist.
  if (!providertransport.needsTransport({ transport: r.transport })) {
    out.transport = '';
    out.apiKey = r.accessToken;
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
  } catch (e) {
    // A provider whose token is dead still has a documented catalog: fall
    // through to the registry list instead of returning an empty picker.
    warning = oneLine(e);
  }
  if (live.length) {
    modelCatalog.register(provId, live);
    // A live inventory answered, so this account is verified by evidence — not
    // by a hardcoded provider id list in the renderer. For ChatGPT also ask the
    // account endpoint for the real plan: its token often omits the claim, so a
    // label from sign-up time would otherwise masquerade as an entitlement.
    const acct = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1) : '';
    try { providerOauth.markVerified(provId, acct); } catch (_) {}
    Promise.resolve(providerOauth.refreshEntitlement(provId, acct)).catch(() => {});
  }

  const entries = live.length
    ? live
    : (prov.models || []).map((m) => ({ id: m.id, label: m.label, contextWindow: 0, thinking: !!m.thinking }));
  const models = entries.map((m) => {
    const win = modelCatalog.contextWindowFor(m.id, provId, m.contextWindow);
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
  if (live.length) {
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

ipcMain.handle('autobot:providerSignOut', (event, id, account) => {
  try {
    const raw = String(id || '');
    const [provId, ...rest] = raw.split(':');
    const acct = account || rest.join(':');
    if (!acct) return { ok: false, error: 'which account?' };
    const removed = providerOauth.removeAccount(provId, acct);
    poolNoticeDeduper.reset();
    return { ok: true, removed };
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

function claudeCliFallback() {
  const base = bundledRuntimeDir();
  if (!base) return '';
  const p = path.join(base, 'claude-code', 'bin', 'claude');
  try { return fs.existsSync(p) ? p : ''; } catch (_) { return ''; }
}

/** Prefer a resolved runtime (self-updated install) over the repo copy. */
async function claudeCliPath() {
  try {
    const hit = await getRuntimes().resolve('claude-code');
    if (hit && hit.bin) return hit.bin;
  } catch (_) {}
  return claudeCliFallback();
}

/**
 * Start `claude auth login` and hand its authorize URL to the renderer.
 *
 * The CLI is the credential owner, so we do not scrape its output for a token:
 * we only want the URL to open in the embedded browser and a place to paste the
 * code the page shows. On exit we re-read the keychain, which is now the CLI's
 * fresh credential.
 */
async function startClaudeLogin(event) {
  try {
    // A second concurrent login would race the same keychain item. A dead one
    // must not block the next attempt, so only a live flow short-circuits.
    if (flowIsLive(claudeLoginFlow)) {
      return { ok: true, flowId: claudeLoginFlow.flowId, url: claudeLoginFlow.url, already: true };
    }
    claudeLoginFlow = null;
    const bin = await claudeCliPath();
    if (!bin) return { ok: false, error: 'the bundled Claude Code CLI is missing — reinstall the app' };
    const flowId = 'claude-login:' + Date.now();
    const env = Object.assign({}, process.env, { BROWSER: 'true' });
    const child = spawn(bin, ['auth', 'login'], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const flow = { flowId, child, url: '', buffered: '', lines: [], alive: true, relay: null, relayPort: 0 };
    claudeLoginFlow = flow;
    // Start mirroring the CLI's callback port on ::1 at once, so it is listening
    // before the user can possibly get back from the consent page.
    // Start the IPv6 mirror immediately: the port only exists once the CLI has
    // bound it, and the user may already be on the consent page.
    const relayReady = mirrorLoopbackOnIpv6(flow).catch(() => 0);
    const sender = event.sender;
    const send = (channel, id, payload) => {
      try { if (sender && !sender.isDestroyed()) sender.send(channel, id, payload); } catch (_) {}
      broadcast({ type: 'provider-reconnect', flowId: id, ...payload });
    };

    // The CLI reports a failed exchange ("Invalid code", "expired", a 400 body)
    // on its own stdout and then exits non-zero. Reporting every non-zero exit
    // as "cancelled" hides the reason and leaves the user re-running the same
    // broken attempt, so keep the last few meaningful lines to quote back.
    const ansi = (s) => String(s)
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')   // OSC 8 hyperlinks
      .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');                      // CSI colours
    const scrape = (chunk, fromStderr) => {
      const text = ansi(chunk);
      flow.buffered += text;
      if (!flow.url) {
        const m = flow.buffered.match(/https:\/\/[^\s"'<>]+oauth\/authorize[^\s"'<>]*/);
        if (m) flow.url = m[0];
      }
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/\s+/g, ' ').trim();
        if (!line) continue;
        if (/oauth\/authorize|didn't open|Opening browser|Paste code here/i.test(line)) continue;
        flow.lines.push(line.slice(0, 200));
        if (flow.lines.length > 6) flow.lines.shift();
        console.log('[claude-login' + (fromStderr ? ':err' : '') + ']', line.slice(0, 300));
        // Stream it, don't wait for the exit: a rejected paste that leaves the
        // CLI waiting ("Copy all of it, including the # in the middle") produces
        // no result event at all, so an unstreamed message is indistinguishable
        // from a dead sign-in — the user retries the same wrong paste forever.
        try {
          send('autobot:providerReconnectLine', flowId, {
            line: line.slice(0, 220),
            retryable: isRetryableLine(line),
          });
        } catch (_) {}
      }
    };
    child.stdout.on('data', (c) => scrape(c, false));
    child.stderr.on('data', (c) => scrape(c, true));

    const settle = async (result) => {
      if (!flow.alive) return; // exit + error can both fire; settle once
      flow.alive = false;
      if (claudeLoginFlow === flow) claudeLoginFlow = null;
      if (flow.relay) { try { flow.relay.close(); } catch (_) {} flow.relay = null; }
      if (result && result.ok) {
        // The CLI owns the credential now; adopt it and refresh the catalog.
        try {
          const rec = await providerOauth.adoptClaudeFromCli();
          poolNoticeDeduper.reset();
          try { if (rec && rec.id) await fetchProviderModels(rec.id); } catch (_) {}
          try { await warmModelCatalogs(); } catch (_) {}
          send('autobot:providerReconnectResult', flowId, { ok: true, account: rec });
        } catch (e) {
          send('autobot:providerReconnectResult', flowId, { ok: false, error: oneLine(e) });
        }
      } else {
        send('autobot:providerReconnectResult', flowId, { ok: false, error: (result && result.error) || 'sign-in did not complete' });
      }
    };
    child.on('exit', (code, signal) => {
      // Reading the store must never be able to take main down. This exact read
      // used to throw (`readClaudeCodeCredentials` was not a top-level export)
      // and surfaced as a "JavaScript error occurred in the main process" dialog
      // immediately after the CLI had successfully written the credential —
      // destroying a sign-in that had actually worked.
      let wrote = null;
      try {
        const read = typeof providerOauth.readClaudeCodeCredentials === 'function'
          ? providerOauth.readClaudeCodeCredentials
          : (providerOauth._internal && providerOauth._internal.readClaudeCodeCredentials);
        wrote = typeof read === 'function' ? !!read() : null;
      } catch (_) { wrote = null; }
      console.log('[claude-login] exit', code, signal || '', '| wrote=' + String(wrote), '| last=' + String((flow.lines || []).slice(-1)[0] || ''));
      if (code !== 0) {
        const said = String((flow.lines || []).slice(-1)[0] || '');
        const err = signal || /cancel/i.test(said)
          ? 'Claude Code sign-in was cancelled'
          : (said || 'Claude Code sign-in did not complete');
        return settle({ ok: false, error: err });
      }
      if (wrote === false) return settle({ ok: false, error: 'Claude Code finished but wrote no credential' });
      // `wrote === null` — we could not read the store at all. Let the live probe
      // inside adoptClaudeFromCli decide instead of inventing a verdict.
      settle({ ok: true });
    });
    child.on('error', (e) => settle({ ok: false, error: e.message }));

    // Give the CLI a moment to print the URL (it writes it before waiting).
    const deadline = Date.now() + 6000;
    while (!flow.url && Date.now() < deadline && flowIsLive(flow)) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!flow.url) {
      try { child.kill('SIGTERM'); } catch (_) {}
      if (claudeLoginFlow === flow) claudeLoginFlow = null;
      flow.alive = false;
      if (flow.relay) { try { flow.relay.close(); } catch (_) {} flow.relay = null; }
      return { ok: false, error: 'Claude Code did not print a sign-in URL — try again from a terminal with `claude auth login`' };
    }
    // The CLI listens on 127.0.0.1 only, and Brave resolves `localhost` to
    // `::1` first. The relay was started as soon as the child existed, but a
    // returned URL is a promise that the click will land somewhere: wait for
    // the listener (bounded, and never fatal — the paste box still works).
    const boundPort = await Promise.race([
      relayReady,
      new Promise((r) => setTimeout(() => r(0), 4000)),
    ]);
    console.log('[claude-login] ready port=' + (flow.relayPort || 0) + ' ipv6Relay=' + (boundPort ? 'yes' : 'no'));
    return { ok: true, flowId, url: flow.url };
  } catch (e) {
    return { ok: false, error: oneLine(e) };
  }
}

/**
 * Single-flight start.
 *
 * The first click spends up to 6 s waiting for the CLI to print its URL. A
 * second click inside that window used to short-circuit on `flowIsLive()` and
 * hand back the *empty* url of the in-flight flow, so the panel rendered a
 * paste box with no way to reach the sign-in page. Both clicks now await the
 * same promise and therefore see the same real URL — and only one
 * `claude auth login` is ever spawned.
 */
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
  const f = claudeLoginFlow;
  if (!f || f.flowId !== String(flowId || '')) {
    return { ok: false, error: 'that sign-in is no longer waiting — start it again' };
  }
  if (!flowIsLive(f)) {
    f.alive = false;
    if (claudeLoginFlow === f) claudeLoginFlow = null;
    return { ok: false, error: 'that sign-in window closed before the code arrived — start it again' };
  }
  const v0 = String(code || '').trim();
  const norm = normalizeReconnectCode(v0);
  if (!norm.ok) return { ok: false, error: norm.error };
  const v = norm.value;
  try {
    if (!f.child.stdin || f.child.stdin.destroyed || f.child.stdin.writable === false) {
      f.alive = false;
      if (claudeLoginFlow === f) claudeLoginFlow = null;
      return { ok: false, error: 'that sign-in window closed before the code arrived — start it again' };
    }
    f.child.stdin.write(v + '\n');
  } catch (e) {
    f.alive = false;
    if (claudeLoginFlow === f) claudeLoginFlow = null;
    return { ok: false, error: oneLine(e) };
  }
  return { ok: true };
});

ipcMain.handle('autobot:providerReconnectClaudeCancel', () => {
  const f = claudeLoginFlow;
  if (!f) return { ok: true, cancelled: false };
  f.alive = false;
  claudeLoginFlow = null;
  try { f.child.kill('SIGTERM'); } catch (_) {}
  if (f.relay) { try { f.relay.close(); } catch (_) {} f.relay = null; }
  return { ok: true, cancelled: true };
});

// What the renderer can render without guessing: is a login still waiting, and
// for how long. `waiting: false` means any code the user pastes will be refused.
ipcMain.handle('autobot:providerReconnectState', () => {
  const f = claudeLoginFlow;
  const live = flowIsLive(f);
  return {
    ok: true,
    waiting: live,
    flowId: live ? f.flowId : '',
    url: live ? f.url : '',
    pid: live && f.child && f.child.pid ? f.child.pid : 0,
  };
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