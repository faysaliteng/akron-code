'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

module.exports = function registerFeaturesIpc(ctx) {
  const {
    app, ipcMain, shell, dialog, BrowserWindow, session,
    store, workspace, mcp, mcpStatus, autoConnectMcp, shells, git, pluginsDir, scheduler, sandbox,
    secretstore, search, sessionDb, environments, depManager, updater, browser,
    gdrive, runAgent, providertransport, providerOauth, permGate, questionGate, pendingQuestions, windows,
    winFor, cwdFor, winTitleBarOverlay, applyFeatures, runtimePathPrefix,
    hydrateProvider, freellmFallbackApiKey, broadcast, mainWindow, oneLine,
    humanizeLLMError, rea, mcpoauth, freellm, poolNoticeDeduper, sessionlog, paths, describeConnectError,
  } = ctx;
  const authFlights = new Map();

  async function resolveCallableProvider(rawProvider, promptHint = '') {
    let p = (rawProvider && typeof rawProvider === 'object') ? { ...rawProvider } : { ...(store.getSettings().provider || {}) };
    const isAutoMode = p.routingMode === 'auto'
      || String(p.model || '').trim().toLowerCase() === 'auto'
      || (!p.oauthProvider && !String(p.baseURL || '').trim());
    if (isAutoMode) {
      let oauthAccounts = [];
      try {
        if (providerOauth && typeof providerOauth.listAccounts === 'function') {
          oauthAccounts = await providerOauth.listAccounts();
        }
      } catch (_) {}
      const orchestrator = store.getOrchestrator ? store.getOrchestrator() : null;
      const sel = await require('../task-router').classifyAndSelect({
        messages: [{ role: 'user', content: promptHint || 'Summarize conversation context concisely' }],
        provider: p,
        orchestrator,
        oauthAccounts,
        providerOauth,
        store,
        timeoutMs: 1200,
      });
      if (sel && sel.chosen) {
        p = { ...p, ...sel.chosen, routingMode: 'direct' };
      }
    }
    return hydrateProvider(p);
  }

ipcMain.handle('autobot:chatOnce', async (event, payload) => {
  try {
    const { chatOnce } = require('../llm');
    let p;
    try {
      const hint = Array.isArray(payload && payload.messages) && payload.messages.length
        ? String((payload.messages[payload.messages.length - 1] || {}).content || '')
        : '';
      p = await resolveCallableProvider(payload && payload.provider, hint);
    } catch (e) {
      return { ok: false, error: e.message, needsSignIn: e.code === 'provider_needs_signin' };
    }
    const res = await chatOnce({
      provider: p,
      messages: (payload && payload.messages) || [],
      maxTokens: payload && payload.maxTokens,
    });
    return { ok: true, content: res.content, usage: res.usage, model: res.model };
  } catch (e) {
    return { ok: false, error: humanizeLLMError(e) };
  }
});

// Real `/compact`: summarize the transcript with the active model, then the
// renderer swaps the conversation for the returned digest. Same retry/failover
// path as a normal turn, so a transient 429/502 doesn't break compaction.
ipcMain.handle('autobot:compact', async (event, payload) => {
  try {
    const { chatOnce } = require('../llm');
    const msgs = (payload && payload.messages) || [];
    let p;
    try { p = await resolveCallableProvider(payload && payload.provider, 'Summarize conversation transcript concisely'); } catch (e) {
      return { ok: false, error: e.message, needsSignIn: e.code === 'provider_needs_signin' };
    }
    const text = (c) => {
      if (c == null) return '';
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text || '') : String(x))).join('\n');
      try { return JSON.stringify(c); } catch { return String(c); }
    };
    // Keep the tail intact — recent turns matter most; cap the head.
    const lines = [];
    for (const m of msgs) {
      if (!m || !m.role || m.role === 'system') continue;
      const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : m.role;
      let body = text(m.content).trim();
      if (!body && Array.isArray(m.tools) && m.tools.length) {
        body = m.tools.map((t) => `${t.name || 'tool'}(${JSON.stringify(t.args || {}).slice(0, 160)})`).join('; ');
      }
      if (!body) continue;
      lines.push(`${who}: ${body}`);
    }
    let transcript = lines.join('\n\n');
    const CAP = 120000;
    if (transcript.length > CAP) {
      transcript = '[earlier turns trimmed]\n…' + transcript.slice(-CAP);
    }
    const summaryPrompt = [
      {
        role: 'system',
        content: 'You are compacting a conversation so it can continue with the same context in far fewer tokens. Produce a dense, factual summary. Preserve: the user\'s goals and constraints, decisions made, files/paths/commands touched, code changes, open questions, errors and their fixes, and any pending tasks. Do not add commentary or invent details. Use terse markdown with short sections.',
      },
      { role: 'user', content: 'Summarize this conversation transcript.\n\n' + transcript },
    ];
    const res = await chatOnce({ provider: p, messages: summaryPrompt, maxTokens: Math.min(4000, Number(p.maxTokens) || 4000) });
    return { ok: true, summary: res.content, usage: res.usage, model: res.model, before: msgs.length };
  } catch (e) {
    return { ok: false, error: humanizeLLMError(e) };
  }
});

// Version / environment + merged hook config (parity surfaces for /version,
// /status, /debug, /doctor and /hooks).
ipcMain.handle('autobot:getVersion', () => ({
  app: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
}));
ipcMain.handle('autobot:getHooks', async (e, cwd) => {
  try {
    const hooks = require('../hooks');
    return hooks.loadHookConfig(cwd || workspace.ROOT);
  } catch (err) {
    return {};
  }
});

// memory / skills / settings
ipcMain.handle('autobot:getMemory', () => store.getMemory());
ipcMain.handle('autobot:addMemory', (e, content) => store.addMemory(content));
ipcMain.handle('autobot:clearMemory', () => store.clearMemory());
ipcMain.handle('autobot:getSkills', () => store.getSkills());
ipcMain.handle('autobot:loadSkill', (e, name) => store.loadSkill(name));
ipcMain.handle('autobot:setSkillEnabled', (e, name, enabled) => store.setSkillEnabled(name, enabled));
ipcMain.handle('autobot:setAllSkillsEnabled', (e, enabled) => store.setAllSkillsEnabled(enabled));

// Custom skills: upload a .md file (or authored content) and delete one.
ipcMain.handle('autobot:addSkill', (e, name, content) => store.addCustomSkill(name, content));
ipcMain.handle('autobot:deleteSkill', (e, name) => store.deleteCustomSkill(name));
ipcMain.handle('autobot:pickSkillFile', async (event) => {
  const r = await dialog.showOpenDialog(winFor(event), {
    properties: ['openFile'],
    filters: [{ name: 'Markdown skill', extensions: ['md', 'markdown', 'txt'] }],
  });
  if (r.canceled || !r.filePaths.length) return null;
  const fp = r.filePaths[0];
  let content = '';
  try { content = fs.readFileSync(fp, 'utf8'); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true, name: path.basename(fp).replace(/\.(md|markdown|txt)$/i, ''), content, path: fp };
});

// Plugins & connectors directory.
ipcMain.handle('autobot:listPlugins', (e, opts) => pluginsDir.listPlugins(opts));
ipcMain.handle('autobot:pluginCategories', () => pluginsDir.categories());
ipcMain.handle('autobot:searchPlugins', (e, query, opts) => pluginsDir.search(query, opts));
ipcMain.handle('autobot:suggestPlugins', (e, goal, opts) => pluginsDir.suggest(goal, opts));
ipcMain.handle('autobot:installPlugin', async (e, id) => {
  const r = pluginsDir.install(id);
  if (!r.ok) return r;
  const entry = r.entry || {};
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('connect timed out after ' + (ms / 1000) + 's')), ms)),
  ]);
  try {
    if (id === 'rea') {
      const res = await withTimeout(rea.ensureConnected(mcp, { userDataDir: app.getPath('userData') }), 20000);
      pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), mode: 'built-in', toolCount: res.toolCount || 0 });
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: 'rea', tools: res.tools || [] };
    }
    if (id === 'gdrive' || id === 'gdocs' || id === 'gsheets' || id === 'gslides') {
      const st = gdrive.status(mcp);
      if (st.connected) {
        pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), mode: st.mode });
        const upd = pluginsDir.markConnected(id);
        return { ok: true, entry: upd || r.entry, gdriveStatus: st };
      }
      return { ok: true, entry: r.entry, needsSetup: 'gdrive', detectedLocalFolders: st.detectedLocalFolders || [] };
    }
    const storedKey = secretstore.get(`plugin:apikey:${id}`) || undefined;
    if (entry.endpoint && entry.endpoint.url) {
      const info = await withTimeout(mcp.connect({
        url: entry.endpoint.url,
        transport: entry.endpoint.type === 'sse' ? 'sse' : 'http',
        name: entry.name,
        apiKey: storedKey,
      }), 12000);
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length });
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: info.serverId, tools: info.tools || [] };
    }
    if (entry.command && entry.command.command) {
      const extraEnv = storedKey ? { API_KEY: storedKey, BEARER_TOKEN: storedKey, ...(entry.command.env || {}) } : (entry.command.env || {});
      const info = await withTimeout(mcp.connect({ command: entry.command.command, args: entry.command.args || [], env: extraEnv, name: entry.name }), 15000);
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length });
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, serverId: info.serverId, tools: info.tools || [] };
    }
    if (storedKey) {
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd || r.entry, mode: 'apikey' };
    }
  } catch (err) {
    // Install intent is preserved; surface the transport error without failing.
    const auth = entry.endpoint && entry.endpoint.url
      ? mcpoauth.isAuthChallenge(err.status || (/MCP HTTP (\d+)/.exec(String(err.message || '')) || [])[1], { 'www-authenticate': err.wwwAuthenticate })
      : { required: false };
    const out = { ok: true, entry: r.entry, connectError: describeConnectError(err) };
    if (auth.required) {
      out.needsAuth = true;
      out.resourceMetadataUrl = err.resourceMetadata || null;
      out.connectError = 'this connector requires sign-in before its tools work';
    }
    return out;
  }
  return r;
});
ipcMain.handle('autobot:uninstallPlugin', (e, id) => {
  try { secretstore.del(`plugin:apikey:${id}`); } catch (_) {}
  return pluginsDir.uninstall(id);
});
ipcMain.handle('autobot:configurePlugin', async (e, id, cfg = {}) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  if (!entry.installed) pluginsDir.install(id);

  const patch = {};
  let apiKey = null;
  if (Object.prototype.hasOwnProperty.call(cfg, 'apiKey')) {
    const cleanKey = String(cfg.apiKey || '').trim();
    if (cleanKey) {
      secretstore.set(`plugin:apikey:${id}`, cleanKey);
      patch.hasApiKey = true;
      apiKey = cleanKey;
    } else {
      secretstore.del(`plugin:apikey:${id}`);
      patch.hasApiKey = false;
    }
  } else {
    apiKey = secretstore.get(`plugin:apikey:${id}`) || null;
  }

  const endpointUrl = String(cfg.endpointUrl || '').trim();
  const cmdStr = String(cfg.command || '').trim();
  if (endpointUrl) {
    patch.customEndpoint = { type: cfg.transport === 'sse' ? 'sse' : 'http', url: endpointUrl };
  }
  if (cmdStr) {
    const parts = Array.isArray(cfg.args) ? cfg.args : String(cfg.args || '').trim().split(/\s+/).filter(Boolean);
    patch.customCommand = { command: cmdStr, args: parts };
  }

  let updated = pluginsDir.setConfig(id, patch);
  const effectiveEndpoint = (updated && updated.endpoint) || entry.endpoint;
  const effectiveCommand = (updated && updated.command) || entry.command;

  if (effectiveEndpoint && effectiveEndpoint.url) {
    try {
      const headers = {};
      if (apiKey) {
        const hdrName = String(cfg.headerName || 'authorization').trim();
        headers[hdrName.toLowerCase()] = hdrName.toLowerCase() === 'authorization' ? `Bearer ${apiKey}` : apiKey;
      }
      const info = await mcp.connect({
        url: effectiveEndpoint.url,
        transport: effectiveEndpoint.type === 'sse' ? 'sse' : 'http',
        name: entry.name,
        headers,
        apiKey: apiKey || undefined,
      });
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      updated = pluginsDir.setConfig(id, {
        connected: true,
        connectedAt: Date.now(),
        mode: apiKey ? 'apikey+mcp' : 'mcp',
        toolCount: (info.tools || []).length,
        lastTestAt: Date.now(),
        lastTestOk: true,
      });
      return { ok: true, entry: updated, serverId: info.serverId, tools: info.tools || [] };
    } catch (err) {
      return { ok: false, entry: updated, error: describeConnectError(err) };
    }
  }
  if (effectiveCommand && effectiveCommand.command) {
    try {
      const keySlug = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const env = apiKey ? { API_KEY: apiKey, [`${keySlug}_API_KEY`]: apiKey, BEARER_TOKEN: apiKey } : {};
      const info = await mcp.connect({
        command: effectiveCommand.command,
        args: effectiveCommand.args || [],
        env,
        name: entry.name,
      });
      const srv = mcp.servers.get(info.serverId);
      if (srv) srv.fullTools = info.tools || [];
      updated = pluginsDir.setConfig(id, {
        connected: true,
        connectedAt: Date.now(),
        mode: 'stdio-mcp',
        toolCount: (info.tools || []).length,
        lastTestAt: Date.now(),
        lastTestOk: true,
      });
      return { ok: true, entry: updated, serverId: info.serverId, tools: info.tools || [] };
    } catch (err) {
      return { ok: false, entry: updated, error: describeConnectError(err) };
    }
  }
  if (patch.hasApiKey) {
    updated = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), mode: 'apikey', lastTestAt: Date.now(), lastTestOk: true });
    return { ok: true, entry: updated, detail: 'API key stored securely and marked connected.' };
  }
  return { ok: true, entry: updated };
});
ipcMain.handle('autobot:testPlugin', async (e, id) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  try {
    if (id === 'rea') {
      const res = await rea.ensureConnected(mcp, { userDataDir: app.getPath('userData') });
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: res.toolCount || 0, lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, toolCount: res.toolCount || 0, detail: `REA connected (${res.toolCount || 0} MCP tools)` };
    }
    if (['gdrive', 'gdocs', 'gsheets', 'gslides'].includes(id)) {
      const st = gdrive.status(mcp);
      if (!st.connected) return { ok: false, needsSetup: 'gdrive', error: 'Google Drive is not set up yet.' };
      const res = await gdrive.searchFiles('', { limit: 1 }, mcp);
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, detail: `Drive ${st.mode} OK (${(res.files || []).length} sample result)` };
    }
    if (entry.type === 'plugin') {
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), lastTestAt: Date.now(), lastTestOk: true });
      const cap = (entry.provides || []).join(', ') || 'built-in';
      return { ok: true, entry: upd, detail: `Plugin active (${cap})` };
    }
    const storedKey = secretstore.get(`plugin:apikey:${id}`) || null;
    if (entry.endpoint && entry.endpoint.url) {
      try {
        const info = await mcp.connect({
          url: entry.endpoint.url,
          transport: entry.endpoint.type === 'sse' ? 'sse' : 'http',
          name: entry.name,
          apiKey: storedKey || undefined,
        });
        const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length, lastTestAt: Date.now(), lastTestOk: true });
        return { ok: true, entry: upd, toolCount: (info.tools || []).length, detail: `Connected (${(info.tools || []).length} MCP tools)` };
      } catch (err) {
        const msg = describeConnectError(err);
        pluginsDir.setConfig(id, { lastTestAt: Date.now(), lastTestOk: false });
        return { ok: false, error: msg };
      }
    }
    if (entry.command && entry.command.command) {
      const keySlug = String(id).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      const env = storedKey ? { API_KEY: storedKey, [`${keySlug}_API_KEY`]: storedKey, BEARER_TOKEN: storedKey } : {};
      const info = await mcp.connect({ command: entry.command.command, args: entry.command.args || [], env, name: entry.name });
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), toolCount: (info.tools || []).length, lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, toolCount: (info.tools || []).length, detail: `Connected (${(info.tools || []).length} MCP tools)` };
    }
    if (storedKey || entry.auth === 'none') {
      const upd = pluginsDir.setConfig(id, { connected: true, connectedAt: Date.now(), lastTestAt: Date.now(), lastTestOk: true });
      return { ok: true, entry: upd, detail: entry.auth === 'none' ? 'Ready (no credentials needed)' : 'API key verified in local secret store' };
    }
    return { ok: false, error: 'Requires sign-in or API key configuration first.' };
  } catch (err) {
    pluginsDir.setConfig(id, { lastTestAt: Date.now(), lastTestOk: false });
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:pluginStats', () => pluginsDir.stats());
ipcMain.handle('autobot:refreshRegistry', (e, opts) => pluginsDir.refreshRegistry(opts));
ipcMain.handle('autobot:registryStatus', () => pluginsDir.registryStatus());

// ---------------------------------------------------------------------------
// Connector OAuth sign-in (Desktop `oauth:*` / `custom-3p` parity)
// ---------------------------------------------------------------------------
ipcMain.handle('autobot:pluginAuthStatus', (e, id) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const url = entry.endpoint && entry.endpoint.url;
  if (!url) return { ok: true, endpoint: false, authorized: false, auth: entry.auth };
  const rec = mcpoauth.readRecord(url, secretstore);
  return {
    ok: true,
    endpoint: url,
    auth: entry.auth,
    authorized: !!rec,
    connected: !!(pluginsDir.getState().config[id] || {}).connected,
    expiresAt: rec ? rec.expires_at || null : null,
    scope: rec ? rec.scope || null : null,
  };
});

ipcMain.handle('autobot:pluginSignOut', async (e, id) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const url = entry.endpoint && entry.endpoint.url;
  if (url) mcpoauth.signOut(url, secretstore);
  for (const [sid, srv] of mcp.servers) {
    if (srv && srv.url === url) { try { mcp.disconnect(sid); } catch (_) {} }
  }
  const upd = pluginsDir.setConfig(id, { connected: false, connectedAt: null });
  return { ok: true, entry: upd };
});

ipcMain.handle('autobot:pluginAuthStart', async (e, id, opts) => {
  const entry = pluginsDir.get(id);
  if (!entry) return { ok: false, error: `Unknown plugin/connector id: ${id}` };
  const url = entry.endpoint && entry.endpoint.url;
  if (!url) return { ok: false, error: 'this connector has no hosted MCP endpoint to sign in to' };

  // One window can be mid-flow per connector; a second click joins the first.
  if (authFlights.has(id)) return authFlights.get(id);

  const flight = (async () => {
    const parent = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
    try {
      const res = await mcpoauth.authorize({
        endpointUrl: url,
        store: secretstore,
        openExternal: async (authUrl) => {
          // Prefer an in-app window so the flow is visible and the callback
          // returns to the same session; fall back to the system browser.
          if (parent && !parent.isDestroyed()) {
            const w = new BrowserWindow({
              parent, modal: false, width: 520, height: 720,
              title: 'Sign in to ' + entry.name,
              backgroundColor: '#F5FAF8',
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            });
            w.setMenuBarVisibility(false);
            w.loadURL(authUrl);
            const closeOnReturn = (ev, target) => {
              try {
                const u = new URL(target);
                if (u.hostname === mcpoauth.REDIRECT_HOST || u.pathname === mcpoauth.CALLBACK_PATH) {
                  setTimeout(() => { try { w.close(); } catch (_) {} }, 900);
                }
              } catch (_) {}
            };
            w.webContents.on('will-navigate', closeOnReturn);
            w.webContents.on('did-navigate', closeOnReturn);
            w.webContents.setWindowOpenHandler(({ url: pop }) => {
              try {
                const p = new URL(pop);
                if (p.protocol === 'https:' || p.protocol === 'http:') {
                  w.loadURL(pop);
                  return { action: 'deny' };
                }
              } catch (_) {}
              return { action: 'deny' };
            });
            return;
          }
          await shell.openExternal(authUrl);
        },
        fetchImpl: globalThis.fetch,
        scope: opts && opts.scope,
        resourceMetadataUrl: opts && opts.resourceMetadataUrl,
        clientId: opts && opts.clientId,
        clientSecret: opts && opts.clientSecret,
        tokenEndpointAuthMethod: opts && opts.tokenEndpointAuthMethod,
      });

      // Reconnect now that we hold a bearer token.
      let tools = [];
      let serverId = null;
      try {
        const info = await mcp.connect({ url, transport: entry.endpoint.type === 'sse' ? 'sse' : 'http', name: entry.name });
        const srv = mcp.servers.get(info.serverId);
        if (srv) srv.fullTools = info.tools || [];
        tools = info.tools || [];
        serverId = info.serverId;
      } catch (err) {
        const upd = pluginsDir.markConnected(id);
        return { ok: true, entry: upd, connected: false, tools: [], connectError: describeConnectError(err) };
      }
      const upd = pluginsDir.markConnected(id);
      return { ok: true, entry: upd, connected: true, tools, serverId };
    } catch (err) {
      return { ok: false, error: mcpoauth.describeAuthError(err), code: err && err.oauthError || null };
    } finally {
      authFlights.delete(id);
    }
  })();

  authFlights.set(id, flight);
  return flight;
});

// Scheduled tasks.
ipcMain.handle('autobot:listScheduledTasks', () => scheduler.list());
ipcMain.handle('autobot:createScheduledTask', (e, input) => scheduler.create(input));
ipcMain.handle('autobot:updateScheduledTask', (e, id, patch) => scheduler.update(id, patch));
ipcMain.handle('autobot:deleteScheduledTask', (e, id) => scheduler.remove(id));
ipcMain.handle('autobot:runScheduledTask', (e, id) => scheduler.runNow(id));
ipcMain.handle('autobot:listScheduledTaskRuns', (e, id, opts) => scheduler.listRuns(id, opts || {}));

ipcMain.handle('autobot:getSettings', () => store.getSettings());
// ── Sandbox / network policy (Desktop `sandbox.*` + `network.*` parity) ──
ipcMain.handle('autobot:getSandbox', () => sandbox.describe());
ipcMain.handle('autobot:setSandbox', (e, patch) => {
  const cur = store.getSettings() || {};
  store.setSettings({ sandbox: { ...(cur.sandbox || {}), ...((patch && patch.sandbox) || {}) }, network: { ...(cur.network || {}), ...((patch && patch.network) || {}) } });
  return sandbox.describe();
});
ipcMain.handle('autobot:sandboxCheck', (e, { kind, value } = {}) => {
  if (kind === 'read') return sandbox.isReadAllowed(value);
  if (kind === 'write') return sandbox.isWriteAllowed(value);
  if (kind === 'host') return sandbox.isHostAllowed(value);
  return { allowed: true };
});
// ── Secret store (OS keychain) ──
ipcMain.handle('autobot:secretSet', (e, { name, value } = {}) => secretstore.set(String(name), String(value)));
ipcMain.handle('autobot:secretGet', (e, name) => secretstore.get(String(name)));
ipcMain.handle('autobot:secretDelete', (e, name) => secretstore.del(String(name)));
ipcMain.handle('autobot:secretList', () => secretstore.list());
ipcMain.handle('autobot:secretStatus', () => secretstore.status());
// ── Transcript / workspace search & SQLite session store ──
ipcMain.handle('autobot:searchAll', (e, payload) => search.searchAll(payload || {}));
ipcMain.handle('autobot:searchFiles', (e, payload) => search.searchFiles(payload || {}));

ipcMain.handle('autobot:dbMigrate', (e, convs) => sessionDb.migrateFromLocalStorage(convs || []));
ipcMain.handle('autobot:dbListConvs', (e, opts) => sessionDb.listConversations(opts || {}));
ipcMain.handle('autobot:dbGetConv', (e, id) => sessionDb.getConversation(id));
ipcMain.handle('autobot:dbUpsertConv', (e, conv) => sessionDb.upsertConversation(conv));
ipcMain.handle('autobot:dbDeleteConv', (e, id) => sessionDb.deleteConversation(id));
ipcMain.handle('autobot:dbSearch', (e, query, opts) => sessionDb.searchConversationsDb(query, opts || {}));
ipcMain.handle('autobot:setSettings', (e, patch) => {
  const cur = store.getSettings() || {};
  const normalized = (patch && typeof patch === 'object') ? { ...patch } : {};
  if (normalized.uiSettings && typeof normalized.uiSettings === 'object') {
    normalized.uiSettings = { ...(cur.uiSettings || {}), ...normalized.uiSettings };
  }
  if (normalized.uiState && typeof normalized.uiState === 'object') {
    normalized.uiState = { ...(cur.uiState || {}), ...normalized.uiState };
  }
  const next = store.setSettings(normalized);
  // Launch-at-login is an OS setting, not just a stored flag (Desktop parity:
  // its General pane toggles the login item directly).
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin') && process.env.AKRON_COLD_BOOT_CHECK !== '1') {
    try {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, openAsHidden: false });
    } catch (err) { console.error('login item update failed:', err.message); }
  }
  const hasSleep = patch && (Object.prototype.hasOwnProperty.call(patch, 'preventSleep') || (patch.uiSettings && Object.prototype.hasOwnProperty.call(patch.uiSettings, 'preventSleep')));
  if (hasSleep && process.env.AKRON_COLD_BOOT_CHECK !== '1') {
    try { require('../app-system').setPreventSleep(Boolean((normalized.uiSettings && normalized.uiSettings.preventSleep !== undefined) ? normalized.uiSettings.preventSleep : next.preventSleep)); } catch (_) {}
  }
  const hasTray = patch && (Object.prototype.hasOwnProperty.call(patch, 'keepInTray') || (patch.uiSettings && Object.prototype.hasOwnProperty.call(patch.uiSettings, 'keepInTray')));
  if (hasTray) {
    try { require('../app-system').setKeepInTray(Boolean((normalized.uiSettings && normalized.uiSettings.keepInTray !== undefined) ? normalized.uiSettings.keepInTray : next.keepInTray)); } catch (_) {}
  }
  if (process.platform === 'win32' && patch && Object.prototype.hasOwnProperty.call(patch, 'theme')) {
    const overlay = winTitleBarOverlay(next.theme);
    for (const w of windows) {
      if (w && !w.isDestroyed() && typeof w.setTitleBarOverlay === 'function') {
        try { w.setTitleBarOverlay(overlay); } catch (_) {}
      }
    }
  }
  return next;
});

// ── Example-parity config surface (commands / agents / memory / permissions / rewind) ──
// The renderer's slash menu and settings panes read the SAME `.claude/` files
// Claude Code reads, so anything defined there shows up here too.

ipcMain.handle('autobot:listCommands', (e, cwd) => {
  try { return require('../commands').listForUi(cwdFor(cwd)); } catch (_) { return []; }
});
ipcMain.handle('autobot:listSlashActions', async (e, cwd) => {
  try {
    const cmds = require('../commands');
    const dir = cwdFor(cwd);
    const seenMcp = new Set();
    const mcpPrompts = [];
    // Include live MCP prompts from all connected servers first
    for (const sid of [...mcp.servers.keys()]) {
      try {
        const items = await mcp.listPrompts(sid);
        for (const p of items) {
          const k = `${p.serverId}:${p.name}`;
          if (!seenMcp.has(k)) { seenMcp.add(k); mcpPrompts.push(p); }
        }
      } catch (_) {}
    }
    // Always surface built-in REA guided workflows immediately when REA is installed
    try {
      const reaSt = rea.status(mcp, { userDataDir: app.getPath('userData') });
      if (reaSt.available) {
        for (const p of (rea.REA_BUILTIN_PROMPTS || [])) {
          const k = `${p.serverId}:${p.name}`;
          if (!seenMcp.has(k)) { seenMcp.add(k); mcpPrompts.push(p); }
        }
      }
    } catch (_) {}
    let skills = [];
    try { skills = store.getSkills() || []; } catch (_) {}
    return cmds.listSlashActions({ cwd: dir, mcpPrompts, skills });
  } catch (_) {
    return [];
  }
});
ipcMain.handle('autobot:expandMcpPrompt', async (e, payload = {}) => {
  try {
    const serverId = String(payload.serverId || '').trim();
    const name = String(payload.name || '').trim();
    const argText = String(payload.argText || '').trim();
    const dir = cwdFor(payload.cwd);
    if (serverId === 'rea') {
      const text = await rea.expandReaPrompt(mcp, name, argText, dir);
      return { ok: true, prompt: text };
    }
    const srv = mcp.servers.get(serverId);
    if (!srv) return { ok: false, error: `MCP server "${serverId}" is not connected.` };
    const prompts = await mcp.listPrompts(serverId);
    const meta = prompts.find((p) => p.name === name);
    const parsedArgs = {};
    if (argText) {
      const kv = [...argText.matchAll(/(\w+)=(?:"([^"]*)"|'([^']*)'|(\S+))/g)];
      if (kv.length) {
        for (const m of kv) parsedArgs[m[1]] = m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]);
      } else if (meta && meta.arguments && meta.arguments.length) {
        parsedArgs[meta.arguments[0].name] = argText;
      }
    }
    const res = await mcp.getPrompt(serverId, name, parsedArgs);
    return { ok: true, prompt: res.text || argText || `Run ${serverId}:${name}` };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:listWorkspaceFiles', async (e, cwd, query = '') => {
  try {
    const dir = path.resolve(cwdFor(cwd));
    const q = String(query || '').trim().toLowerCase();
    const results = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'release', 'build', '.next', '.cache', '__pycache__']);
    const stack = [{ d: dir, depth: 0 }];
    while (stack.length && results.length < 250) {
      const { d, depth } = stack.pop();
      let ents;
      try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const ent of ents) {
        if (skip.has(ent.name)) continue;
        const full = path.join(d, ent.name);
        const rel = path.relative(dir, full).replace(/\\/g, '/');
        if (ent.isDirectory()) {
          if (depth < 4) stack.push({ d: full, depth: depth + 1 });
          continue;
        }
        if (!ent.isFile()) continue;
        if (q && !rel.toLowerCase().includes(q) && !ent.name.toLowerCase().includes(q)) continue;
        results.push({ name: ent.name, path: rel, fullPath: full });
        if (results.length >= 250) break;
      }
    }
    results.sort((a, b) => {
      if (!q) return a.path.localeCompare(b.path);
      const ap = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ap - bp || a.path.localeCompare(b.path);
    });
    return results.slice(0, 40);
  } catch (_) {
    return [];
  }
});
ipcMain.handle('autobot:gdriveStatus', () => {
  try { return gdrive.status(mcp); } catch (err) { return { ok: false, connected: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:gdrivePickFolder', async (event) => {
  const cs = path.join(os.homedir(), 'Library', 'CloudStorage');
  const defaultPath = fs.existsSync(cs) ? cs : os.homedir();
  const r = await dialog.showOpenDialog(winFor(event), {
    defaultPath,
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('autobot:gdriveConnect', async (e, payload = {}) => {
  try {
    const mode = String(payload.mode || 'local');
    let res;
    if (mode === 'local') {
      res = gdrive.connectLocalFolder(payload.folderPath);
    } else if (mode === 'token') {
      res = await gdrive.connectToken({
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        apiBaseUrl: payload.apiBaseUrl,
        uploadBaseUrl: payload.uploadBaseUrl,
        verify: payload.verify !== false,
      });
    } else if (mode === 'oauth') {
      const parent = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
      res = await gdrive.connectOAuth({
        clientId: payload.clientId,
        clientSecret: payload.clientSecret,
        apiBaseUrl: payload.apiBaseUrl,
        uploadBaseUrl: payload.uploadBaseUrl,
        openExternal: async (authUrl) => {
          if (parent && !parent.isDestroyed()) {
            const w = new BrowserWindow({
              parent, modal: false, width: 520, height: 720,
              title: 'Sign in with Google Drive',
              backgroundColor: '#F5FAF8',
              webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
            });
            w.setMenuBarVisibility(false);
            w.loadURL(authUrl);
            const closeOnReturn = (ev, target) => {
              try {
                const u = new URL(target);
                if (u.hostname === mcpoauth.REDIRECT_HOST || u.pathname === mcpoauth.CALLBACK_PATH) {
                  setTimeout(() => { try { w.close(); } catch (_) {} }, 900);
                }
              } catch (_) {}
            };
            w.webContents.on('will-navigate', closeOnReturn);
            w.webContents.on('did-navigate', closeOnReturn);
            return;
          }
          await shell.openExternal(authUrl);
        },
      });
    } else if (mode === 'mcp') {
      res = await gdrive.connectMcp(payload, mcp);
    } else {
      return { ok: false, error: `Unknown Google Drive connection mode: ${mode}` };
    }
    pluginsDir.install('gdrive');
    pluginsDir.setConfig('gdrive', { connected: true, connectedAt: Date.now(), mode });
    const st = gdrive.status(mcp);
    broadcast({ type: 'gdrive', status: st });
    return { ...res, status: st };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:gdriveDisconnect', () => {
  try {
    const r = gdrive.disconnect(mcp);
    if (pluginsDir.get('gdrive') && pluginsDir.get('gdrive').installed) {
      pluginsDir.setConfig('gdrive', { connected: false, connectedAt: null, mode: null });
    }
    broadcast({ type: 'gdrive', status: r.status });
    return r;
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:gdriveSearch', async (e, query = '', opts = {}) => {
  try { return await gdrive.searchFiles(query, opts, mcp); } catch (err) { return { ok: false, error: oneLine(err), files: [] }; }
});
ipcMain.handle('autobot:gdriveRead', async (e, idOrPath) => {
  try { return await gdrive.readFile(idOrPath, mcp); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:resolveCommand', async (e, name, args, cwd) => {
  try {
    const cmds = require('../commands');
    const dir = cwdFor(cwd);
    const hit = cmds.resolve(name, dir);
    if (!hit) return null;
    return { name: hit.name, source: hit.source, prompt: await cmds.expand(hit, args || '', { cwd: dir }) };
  } catch (_) { return null; }
});
ipcMain.handle('autobot:listAgents', (e, cwd) => {
  try {
    return require('../agentdefs').discover(cwdFor(cwd), { fresh: true }).map((d) => ({
      name: d.name,
      role: d.role || '',
      description: d.description,
      model: d.model || null,
      tools: d.tools || null,
      body: d.body || '',
      file: d.file || null,
      source: d.source,
      scope: d.scope || (d.source === 'project' ? 'workspace' : (d.source === 'builtin' ? 'builtin' : 'global')),
      custom: !!d.custom,
    }));
  } catch (_) { return []; }
});
ipcMain.handle('autobot:listAgentDefs', (e, cwd) => {
  try {
    return require('../agentdefs').discover(cwdFor(cwd), { fresh: true });
  } catch (_) { return []; }
});
ipcMain.handle('autobot:saveAgentDef', (e, payload = {}) => {
  try { return require('../agentdefs').saveAgentDef(payload || {}, cwdFor(payload && payload.cwd)); }
  catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:deleteAgentDef', (e, payload = {}) => {
  try { return require('../agentdefs').deleteAgentDef(payload || {}, cwdFor(payload && payload.cwd)); }
  catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:listOutputStyles', (e, cwd) => {
  try { return require('../output-styles').listOutputStyles(cwdFor(cwd)); }
  catch (err) { return { ok: false, error: oneLine(err), defaultStyleId: 'default', styles: [] }; }
});
ipcMain.handle('autobot:saveOutputStyle', (e, payload = {}) => {
  try { return require('../output-styles').saveOutputStyle(payload || {}, cwdFor(payload && payload.cwd)); }
  catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:deleteOutputStyle', (e, payload = {}) => {
  try { return require('../output-styles').deleteOutputStyle(payload || {}, cwdFor(payload && payload.cwd)); }
  catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:getProjectMemory', (e, cwd) => {
  try {
    const mem = require('../memory');
    return { files: mem.listMemory(cwdFor(cwd)), text: mem.loadMemoryText(cwdFor(cwd)) };
  } catch (_) { return { files: [], text: '' }; }
});
ipcMain.handle('autobot:getPermissions', (e, cwd) => {
  try { return require('../permissions').loadPermissions(cwdFor(cwd)); } catch (_) { return { allow: [], deny: [], ask: [], defaultMode: 'auto' }; }
});
ipcMain.handle('autobot:addPermissionRule', (e, payload) => {
  try { return require('../permissions').savePermissionRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:removePermissionRule', (e, payload) => {
  try { return require('../permissions').removePermissionRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:installStarterRules', () => {
  try { return require('../permissions').installSafeStarterPack(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:saveCustomRule', (e, payload) => {
  try { return require('../permissions').saveCustomRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:deleteCustomRule', (e, payload) => {
  try { return require('../permissions').deleteCustomRule(payload || {}); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:verifyAuditLedger', () => {
  try { return require('../audit-ledger').verifyAuditLedger(); } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:listAuditLedger', (e, limit) => {
  try { return require('../audit-ledger').listAuditEntries({ limit: Number(limit) || 30 }); } catch (_) { return []; }
});

ipcMain.handle('autobot:checkPermission', (e, toolName, toolArgs, cwd, mode) => {
  try { return require('../permissions').decide(require('../permissions').loadPermissions(cwdFor(cwd)), toolName, toolArgs || {}, { cwd: cwdFor(cwd), mode: mode || store.getSettings().permissionMode || 'auto' }); } catch (_) { return { decision: 'ask' }; }
});
ipcMain.handle('autobot:listCheckpoints', (e, convId) => {
  try { return require('../checkpoints').listCheckpoints(convId); } catch (_) { return []; }
});
ipcMain.handle('autobot:rewind', (e, convId, checkpointId) => {
  try {
    const r = require('../checkpoints').restore(convId, checkpointId);
    const ok = (r.errors || []).length === 0;
    return { ok, restored: (r.restored || []).length, removed: (r.removed || []).length, restoredFiles: r.restored || [], removedFiles: r.removed || [], errors: r.errors || [] };
  } catch (err) { return { ok: false, restored: 0, removed: 0, restoredFiles: [], removedFiles: [], errors: [String(err && err.message || err)] }; }
});
ipcMain.handle('autobot:turnDiffs', (e, convId, checkpointId, cwd) => {
  try { return require('../checkpoints').computeTurnDiffs(convId, checkpointId, cwd); } catch (_) { return []; }
});
ipcMain.handle('autobot:gitDiffFiles', (e, cwd) => {
  try { return require('../git').gitDiffFiles(cwd || workspace.ROOT); } catch (_) { return []; }
});
ipcMain.handle('autobot:duetReview', async (e, payload = {}) => {
  try {
    const duet = require('../duet-review');
    const rawPrimary = payload.provider || store.getSettings().provider || {};
    let primaryProvider;
    try {
      primaryProvider = await hydrateProvider(rawPrimary);
    } catch (err) {
      return { ok: false, error: err.message, needsSignIn: err.code === 'provider_needs_signin' };
    }
    const orch = payload.orchestrator || store.getOrchestrator();
    const pick = duet.pickSecondOpinionProvider({
      primary: primaryProvider,
      orchestrator: orch,
      withSpec: payload.withSpec || '',
    });
    let secondProvider = pick.provider || primaryProvider;
    if (secondProvider !== primaryProvider) {
      try {
        secondProvider = await hydrateProvider(secondProvider);
      } catch (_) {
        secondProvider = primaryProvider;
      }
    }
    return await duet.runDuetReview({
      cwd: payload.cwd || workspace.ROOT,
      convId: payload.convId || null,
      target: payload.target || null,
      primaryProvider,
      secondProvider,
      adversarial: Boolean(payload.adversarial),
      diffFiles: Array.isArray(payload.diffFiles) ? payload.diffFiles : null,
    });
  } catch (err) {
    return { ok: false, error: humanizeLLMError(err) };
  }
});
ipcMain.handle('autobot:sessionHealth', (e, payload = {}) => {
  try {
    return require('../session-health').scoreSessionHealth(payload.convId, { messages: payload.messages || null });
  } catch (_) {
    return { status: 'ok', score: 100, flags: [], failingSteps: [], quickReplies: [] };
  }
});
ipcMain.handle('autobot:allSessionsHealth', (e, convsSummary = []) => {
  try {
    return require('../session-health').inspectAllSessionsHealth(convsSummary);
  } catch (_) {
    return {};
  }
});
ipcMain.handle('autobot:searchSessionIndex', async (e, payload = {}) => {
  try {
    return await require('../session-index').searchHistory({ query: payload.query || '', limit: payload.limit || 20 });
  } catch (err) {
    return { ok: false, hits: [], error: oneLine(err) };
  }
});
ipcMain.handle('autobot:askHistory', async (e, payload = {}) => {
  try {
    let p = (payload && payload.provider) || store.getSettings().provider || null;
    if (p) {
      try { p = await hydrateProvider(p); } catch (_) { p = null; }
    }
    const { chatOnce } = require('../llm');
    return await require('../session-index').askAcrossHistory({
      question: payload.question || '',
      provider: p,
      chatFn: p ? chatOnce : null,
      limit: payload.limit || 12,
    });
  } catch (err) {
    return { ok: false, error: humanizeLLMError(err) };
  }
});
ipcMain.handle('autobot:rebuildSessionIndex', async () => {
  try {
    return await require('../session-index').syncSessionIndex({ forceRebuild: true });
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:proactiveState', () => {
  try { return require('../proactivity').loadState(); } catch (_) { return { matters: [], quietHours: { enabled: false, start: '22:00', end: '08:00' } }; }
});
ipcMain.handle('autobot:proactiveAction', (e, payload = {}) => {
  try { return require('../proactivity').actOnMatter(payload.matterKey, payload.action, { snoozeMs: payload.snoozeMs }); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:proactiveBrief', async (e, payload = {}) => {
  try {
    const pro = require('../proactivity');
    const tasks = scheduler.list();
    if (payload.kind === 'retro') return await pro.generateWeeklyRetro({ cwd: payload.cwd || workspace.ROOT, tasks });
    return await pro.generateMorningBrief({ cwd: payload.cwd || workspace.ROOT, tasks });
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:proactiveSuggest', (e, payload = {}) => {
  try { return require('../proactivity').suggestAutomationsFromHistory({ convs: payload.convs || [], existingTasks: scheduler.list(), maxSuggestions: 3 }); } catch (_) { return []; }
});
ipcMain.handle('autobot:setQuietHours', (e, patch = {}) => {
  try { return { ok: true, state: require('../proactivity').setQuietHours(patch) }; } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:getCuratedMemory', () => {
  try { return require('../memory-curator').loadState(); } catch (_) { return { enabled: false, autoCurate: false, entries: [] }; }
});
ipcMain.handle('autobot:setMemoryAutoCurate', (e, enabled) => {
  try { return { ok: true, state: require('../memory-curator').setAutoCurate(Boolean(enabled)) }; } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:curateMemory', async (e, payload = {}) => {
  try {
    let p = payload.provider || store.getSettings().provider || null;
    if (p) { try { p = await hydrateProvider(p); } catch (_) { p = null; } }
    const { chatOnce } = require('../llm');
    return await require('../memory-curator').curateFromConversations({
      convs: payload.convs || [],
      provider: p,
      chatFn: p ? chatOnce : null,
    });
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:updateCuratedMemory', (e, payload = {}) => {
  try { return require('../memory-curator').updateCuratedEntry(payload.id, payload.patch || {}); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:deleteCuratedMemory', (e, id) => {
  try { return require('../memory-curator').deleteCuratedEntry(id); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:learnSkill', async (e, payload = {}) => {
  try {
    let p = payload.provider || store.getSettings().provider || null;
    if (p) { try { p = await hydrateProvider(p); } catch (_) { p = null; } }
    const { chatOnce } = require('../llm');
    return await require('../skill-extractor').extractLearnedSkill({
      name: payload.name || '',
      messages: payload.messages || [],
      cwd: payload.cwd || workspace.ROOT,
      extraNames: payload.extraNames || [],
      provider: p,
      chatFn: p ? chatOnce : null,
    });
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});

let activeOutboundRelay = null;
ipcMain.handle('autobot:pushGetConfig', () => {
  try { return require('../push-channels').loadConfig(); } catch (_) { return { enabled: false }; }
});
ipcMain.handle('autobot:pushSaveConfig', (e, patch = {}) => {
  try { return { ok: true, config: require('../push-channels').saveConfig(patch) }; } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:pushStartPairing', () => {
  try { return require('../push-channels').startPairing(); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:pushVerifyPairing', (e, { code, deviceMeta } = {}) => {
  try { return require('../push-channels').completePairing(code, deviceMeta || {}); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:pushTest', async () => {
  try {
    return await require('../push-channels').sendPushAlert({
      kind: 'info',
      title: 'Akron Code · Test Push Alert',
      body: 'Mobile push alert routing is active.',
      force: true,
    });
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:pushCommand', (e, text) => {
  try { return require('../push-channels').handleInboundPushCommand(text, permGate); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:remoteRelayStatus', () => {
  try {
    const rs = require('../remote-server');
    const savedRelay = (store.getSettings && store.getSettings().remoteRelay) || {};
    const liveStatus = activeOutboundRelay ? activeOutboundRelay.status() : { connected: false, relayUrl: savedRelay.relayUrl || '' };
    return {
      ...liveStatus,
      relayUrl: liveStatus.relayUrl || savedRelay.relayUrl || '',
      savedEnabled: !!savedRelay.enabled,
      killSwitchActive: rs.isKillSwitchActive(),
      killSwitchPath: rs.killSwitchPath(),
    };
  } catch (err) {
    return { connected: false, killSwitchActive: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:remoteRelayConfigure', (e, { action, relayUrl, token } = {}) => {
  try {
    const rs = require('../remote-server');
    if (action === 'disconnect') {
      if (activeOutboundRelay) activeOutboundRelay.disconnect('user');
      const prevRelay = (store.getSettings && store.getSettings().remoteRelay) || {};
      if (store.setSettings) store.setSettings({ remoteRelay: { ...prevRelay, enabled: false } });
      return { ok: true, ...(activeOutboundRelay ? activeOutboundRelay.status() : { connected: false, relayUrl: prevRelay.relayUrl || '' }) };
    }
    const resolvedUrl = String(relayUrl || (store.getSettings && store.getSettings().remoteRelay && store.getSettings().remoteRelay.relayUrl) || '').trim();
    const resolvedToken = String(token || (secretstore && secretstore.get && secretstore.get('REMOTE_RELAY_TOKEN')) || '');
    if (store.setSettings) store.setSettings({ remoteRelay: { enabled: true, relayUrl: resolvedUrl } });
    if (token && secretstore && secretstore.set) secretstore.set('REMOTE_RELAY_TOKEN', String(token));
    if (activeOutboundRelay) activeOutboundRelay.disconnect('reconfigure');
    activeOutboundRelay = rs.createOutboundRelay({
      relayUrl: resolvedUrl,
      token: resolvedToken,
      onCommand: async (msg) => {
        if (msg && msg.action === 'ping') return { pong: true, ts: Date.now() };
        if (msg && (msg.action === 'approve' || msg.action === 'deny')) {
          return require('../push-channels').handleInboundPushCommand(`${msg.action} ${msg.shortId || ''} ${msg.feedback || ''}`.trim(), permGate);
        }
        return { ok: true };
      },
    });
    const res = activeOutboundRelay.connect();
    return { ...res, ...activeOutboundRelay.status() };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});
ipcMain.handle('autobot:remoteKillSwitch', (e, active) => {
  try { return { ok: true, ...require('../remote-server').setKillSwitch(Boolean(active)) }; } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:extBridgeStatus', () => {
  try { return require('../extbridge').status(); } catch (e) { return { running: false, error: e.message, tabs: [] }; }
});
ipcMain.handle('autobot:extBridgeOpenFolder', () => {
  try {
    const installer = require('../browser-ext-installer');
    const synced = installer.syncStandaloneExtension();
    const dir = (synced && synced.extensionDir) || require('../extbridge').extensionDir();
    if (!fs.existsSync(dir)) return { ok: false, error: 'Extension folder not found' };
    shell.openPath(dir);
    return { ok: true, dir, ...(synced || {}) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('autobot:extBridgeInstallBrowser', (_e, opts) => {
  try {
    const installer = require('../browser-ext-installer');
    return installer.installExternalExtension(opts || {});
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});
ipcMain.handle('autobot:extBridgeLaunchBrowser', (_e, opts) => {
  try {
    const installer = require('../browser-ext-installer');
    const res = installer.launchBrowserWithExtension(opts || {});
    if (res && res.ok && !res.launched && res.extensionDir) {
      try { shell.openPath(res.extensionDir); } catch (_) {}
    }
    return res;
  } catch (e) { return { ok: false, error: oneLine(e) }; }
});
ipcMain.handle('autobot:reaStatus', () => {
  try { return rea.status(mcp, { userDataDir: app.getPath('userData') }); } catch (e) { return { ok: false, available: false, connected: false, error: e.message }; }
});
ipcMain.handle('autobot:reaConnect', async () => {
  try {
    const res = await rea.ensureConnected(mcp, { userDataDir: app.getPath('userData'), force: true });
    return { ok: true, ...res, status: rea.status(mcp, { userDataDir: app.getPath('userData') }) };
  } catch (e) {
    return { ok: false, error: oneLine(e), status: rea.status(mcp, { userDataDir: app.getPath('userData') }) };
  }
});
ipcMain.handle('autobot:reaDoctor', async () => {
  try { return await rea.doctor(mcp, { userDataDir: app.getPath('userData') }); } catch (e) { return { ok: false, error: oneLine(e) }; }
});
ipcMain.handle('autobot:reaInstall', async () => {
  try { return await rea.installOrUpdate({ userDataDir: app.getPath('userData'), mcpClient: mcp }); } catch (e) { return { ok: false, error: oneLine(e) }; }
});
ipcMain.handle('autobot:transcribeAudio', async (e, payload = {}) => {
  try {
    const wavB64 = String(payload.wavBase64 || '');
    if (!wavB64) return { ok: false, fallback: 'local-whisper' };
    let base = '';
    let key = '';
    let model = 'whisper-large-v3-turbo';
    try {
      const cfg = freellm.loadConfig ? freellm.loadConfig() : null;
      if (cfg && cfg.token && cfg.providers && ((cfg.providers.groq && cfg.providers.groq.apiKey) || (cfg.providers.openai && cfg.providers.openai.apiKey))) {
        base = `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
        key = cfg.token;
      }
    } catch (_) {}
    if (!base || !key) {
      const s = store.getSettings() || {};
      const p = s.provider || {};
      if (p.baseURL && p.apiKey && /openai\.com|groq\.com|127\.0\.0\.1:3001/i.test(String(p.baseURL))) {
        base = String(p.baseURL).replace(/\/+$/, '');
        key = String(p.apiKey);
        if (/openai\.com/i.test(base)) model = 'whisper-1';
      }
    }
    if (!base || !key) {
      try {
        const paradev = require('../paradev-client');
        if (paradev.resolveCredentials().configured) {
          const pv = await paradev.transcribeAudio({ audioBase64: wavB64, mimeType: 'audio/wav' });
          if (pv && pv.ok && pv.text) return pv;
        }
      } catch (_) {}
      return { ok: false, fallback: 'local-whisper' };
    }
    const buf = Buffer.from(wavB64, 'base64');
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'speech.wav');
    fd.append('model', model);
    if (payload.lang) fd.append('language', String(payload.lang).slice(0, 2));
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    try {
      const r = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: fd,
        signal: ctrl.signal,
      });
      if (!r.ok) return { ok: false, status: r.status, fallback: 'local-whisper' };
      const j = await r.json().catch(() => null);
      const txt = j && typeof j.text === 'string' ? j.text.trim() : '';
      return txt ? { ok: true, text: txt, engine: 'gateway' } : { ok: false, fallback: 'local-whisper' };
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return { ok: false, fallback: 'local-whisper' };
  }
});
ipcMain.handle('autobot:getOrchestrator', () => store.getOrchestrator());
ipcMain.handle('autobot:setOrchestrator', (e, patch) => {
  poolNoticeDeduper.reset();
  const next = store.setOrchestrator(patch);
  if (typeof broadcast === 'function') {
    try { broadcast({ type: 'orchestrator', orchestrator: next }); } catch (_) {}
  }
  return next;
});
// Live model health for the Role pools editor: per-row cooldown / dead / inflight
// from the shared provider gate, plus the configured pools.
ipcMain.handle('autobot:poolStatus', () => {
  try {
    const router = require('../orch-router');
    const gate = require('../provider-gate');
    const orch = store.getOrchestrator() || {};
    const cfg = router.poolsConfig(orch);
    const snap = gate.snapshot();
    const roles = {};
    const rows = [];
    if (cfg) {
      for (const r of router.ROLES) {
        const list = router.resolve(orch, r, {}).filter((x) => x.role === r);
        roles[r] = list.map((x) => ({ model: x.model, max: x.maxConcurrent || 0 }));
        for (const x of list) {
          const key = gate.keyOf(x);
          if (rows.some((y) => y.key === key)) continue;
          const st = snap[key] || {};
          rows.push({ key, model: x.model, coolingMs: st.coolingMs || 0, dead: !!st.dead, deadWhy: st.deadWhy || '', inflight: st.inflight || 0, queued: st.queued || 0, strikes: st.strikes || 0 });
        }
      }
    }
    return { active: !!cfg, summary: cfg ? router.summary(orch, { baseURL: cfg.gateway && cfg.gateway.baseURL }) : '', roles, rows };
  } catch (e) {
    return { active: false, error: e.message, roles: {}, rows: [] };
  }
});
ipcMain.handle('autobot:sessionLog', (e, convId, opts) => sessionlog.read(convId || 'scratch', opts || {}));

// Creator Mode: hot-swappable user/agent custom tools (~/.autobot/custom-tools/*.json)
ipcMain.handle('autobot:customToolList', () => {
  try { return require('../customtools').listTools(); } catch (_) { return []; }
});
ipcMain.handle('autobot:customToolSave', (e, spec) => {
  const ct = require('../customtools');
  const toolsMod = require('../tools');
  return ct.saveTool(spec, {
    toolDefinitions: toolsMod.toolDefinitions,
    executorsByTool: toolsMod.executorsByTool,
    executors: toolsMod.executors,
  });
});
ipcMain.handle('autobot:customToolDelete', (e, name) => {
  const ct = require('../customtools');
  const toolsMod = require('../tools');
  return ct.deleteTool(name, {
    toolDefinitions: toolsMod.toolDefinitions,
    executorsByTool: toolsMod.executorsByTool,
    executors: toolsMod.executors,
  });
});

// Role pools: the FreeLLMAPI layout (planner / coder / vision / fast / longctx),
// pointed at the configured local router.
ipcMain.handle('autobot:poolsPreset', () => {
  let base = 'http://127.0.0.1:3001/v1';
  try {
    const c = freellm.loadConfig ? freellm.loadConfig() : null;
    if (c && c.port) base = 'http://' + (c.host || '127.0.0.1') + ':' + c.port + '/v1';
  } catch (_) {}
  return require('../orch-router').freellmPreset(base);
});
ipcMain.handle('autobot:getFeatures', () => store.getFeatures());
ipcMain.handle('autobot:setFeatures', async (e, patch) => {
  const prev = store.getFeatures ? store.getFeatures() : {};
  const nextPatch = { ...(patch && typeof patch === 'object' ? patch : {}) };
  let remoteChanged = false;
  let wantRemote = Boolean(prev.remoteControl || prev.remoteServerEnabled);
  if ('remoteControl' in nextPatch || 'remoteServerEnabled' in nextPatch) {
    if ('remoteServerEnabled' in nextPatch && nextPatch.remoteServerEnabled !== prev.remoteServerEnabled) {
      wantRemote = !!nextPatch.remoteServerEnabled;
    } else if ('remoteControl' in nextPatch) {
      wantRemote = !!nextPatch.remoteControl;
    }
    nextPatch.remoteControl = wantRemote;
    nextPatch.remoteServerEnabled = wantRemote;
    const hostRunning = Boolean(environments && environments.getState && environments.getState().hostServer && environments.getState().hostServer.running);
    remoteChanged = (wantRemote !== Boolean(prev.remoteControl)) || (wantRemote !== hostRunning);
  }
  const features = store.setFeatures(nextPatch);
  if (typeof applyFeatures === 'function') applyFeatures(features);
  if (remoteChanged && environments && typeof environments.toggleHostServer === 'function') {
    try {
      const wsRoot = (store.getSettings && store.getSettings().cwd) || undefined;
      const res = await environments.toggleHostServer(wantRemote, { workspaceRoot: wsRoot });
      broadcastEnvChanged(res && res.state);
    } catch (_) {}
  }
  if (typeof broadcast === 'function') {
    try { broadcast({ type: 'features', features }); } catch (_) {}
  }
  return features;
});
ipcMain.handle('autobot:getDefaultCwd', (event, convId, title) => {
  // Every conversation gets its own project folder under ~/Akron Bot/<slug>,
  // created lazily — "every build auto-creates a project folder" (Example parity).
  const ws = workspace.ensure(convId, title);
  return ws.dir;
});
ipcMain.handle('autobot:getWorkspace', (event, convId) => {
  const ws = workspace.get(convId);
  return ws ? ws.dir : null;
});
ipcMain.handle('autobot:setWorkspace', (event, convId, dir) => {
  const ws = workspace.setDir(convId, dir);
  return ws.dir;
});
ipcMain.handle('autobot:pickFolder', async (event) => {
  const r = await dialog.showOpenDialog(winFor(event), { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// File attachments: pick one or many files, read text content for inline
// inclusion (binary files carry name/size only, surfaced to the model as metadata).
const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html|css|scss|less|xml|yaml|yml|toml|ini|sh|bash|zsh|fish|sql|log|csv|tsv|svg|vue|svelte|graphql|gql|prisma|env|conf|gitignore|dockerfile)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?)$/i;
const IMAGE_MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff' };
const MAX_INLINE_BYTES = 200 * 1024; // 200 KB inline text cap
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB image cap (data-URL inline for vision)
ipcMain.handle('autobot:pickFiles', async (event) => {
  const r = await dialog.showOpenDialog(winFor(event), { properties: ['openFile', 'multiSelections'] });
  if (r.canceled || !r.filePaths.length) return [];
  const docStudio = require('../doc-studio');
  return Promise.all(r.filePaths.map(async (fp) => {
    const name = path.basename(fp);
    let stat = null;
    try { stat = fs.statSync(fp); } catch (_) {}
    const size = stat ? stat.size : 0;
    let content = null;
    let isText = false;
    let isImage = false;
    let dataUrl = null;
    let extractedFormat = '';
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (IMAGE_EXT.test(name)) {
      isImage = true;
      if (size <= MAX_IMAGE_BYTES) {
        try {
          const buf = fs.readFileSync(fp);
          const mime = IMAGE_MIME[ext] || 'image/png';
          dataUrl = 'data:' + mime + ';base64,' + buf.toString('base64');
        } catch (_) {}
      }
    } else if (docStudio.isExtractableAttachment(name) && size <= 25 * 1024 * 1024) {
      try {
        const extRes = await docStudio.extractAttachmentFile({ path: fp, name });
        if (extRes && extRes.content) {
          content = extRes.content;
          isText = true;
          extractedFormat = extRes.format || ext;
        }
      } catch (_) {}
    } else if (TEXT_EXT.test(name) && size <= MAX_INLINE_BYTES) {
      try {
        const buf = fs.readFileSync(fp);
        if (!buf.includes(0)) { content = buf.toString('utf8'); isText = true; }
      } catch (_) {}
    }
    return { name, path: fp, size, isText, isImage, dataUrl, content, extractedFormat };
  }));
});

ipcMain.handle('autobot:extractAttachment', async (_event, payload) => {
  try {
    const docStudio = require('../doc-studio');
    const p = payload || {};
    const buf = Array.isArray(p.buffer) ? Buffer.from(p.buffer) : (Buffer.isBuffer(p.buffer) ? p.buffer : null);
    const res = await docStudio.extractAttachmentFile({ path: p.path || '', name: p.name || '', buffer: buf });
    return res || { ok: false };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('autobot:studioInspect', async (_event, payload) => {
  try {
    const p = payload || {};
    const targetRaw = String(p.path || '').trim();
    if (!targetRaw) return { ok: false, error: 'path required' };
    let absPath = path.isAbsolute(targetRaw) ? path.normalize(targetRaw) : path.resolve(p.cwd || workspace.scratch(), targetRaw);
    if (!fs.existsSync(absPath)) {
      if (p.cachePath && fs.existsSync(p.cachePath)) {
        absPath = p.cachePath;
      } else {
        try {
          const cacheDir = path.join(os.homedir(), '.autobot', 'media-cache');
          const leaf = path.basename(targetRaw);
          if (leaf && fs.existsSync(cacheDir)) {
            const match = fs.readdirSync(cacheDir).filter((f) => f.endsWith('-' + leaf)).sort().pop();
            if (match) absPath = path.join(cacheDir, match);
          }
        } catch (_) {}
      }
    }
    if (!fs.existsSync(absPath)) return { ok: false, error: `File not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    const ext = path.extname(absPath).toLowerCase().slice(1);
    const mediaGen = require('../media-gen');
    const docStudio = require('../doc-studio');
    if (/\.(png|jpe?g|webp|gif|svg|ico|bmp)$/i.test(absPath)) {
      const dataUrl = stat.size <= 8 * 1024 * 1024
        ? `data:${ext === 'svg' ? 'image/svg+xml' : (ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/' + ext)};base64,${fs.readFileSync(absPath).toString('base64')}`
        : '';
      return { ok: true, kind: 'image', path: absPath, name: path.basename(absPath), size: stat.size, ext, dataUrl, fileUrl: 'file://' + encodeURI(absPath) };
    }
    if (/\.(mp4|webm|mov)$/i.test(absPath)) {
      const meta = await mediaGen.probeVideo(absPath).catch(() => ({}));
      return { ok: true, kind: 'video', path: absPath, name: path.basename(absPath), size: stat.size, ext, fileUrl: 'file://' + encodeURI(absPath), ...meta };
    }
    if (/\.(mp3|wav|ogg|m4a|flac)$/i.test(absPath)) {
      return { ok: true, kind: 'audio', path: absPath, name: path.basename(absPath), size: stat.size, ext, fileUrl: 'file://' + encodeURI(absPath) };
    }
    if (docStudio.isDocumentPath(absPath) || /\.(csv|tsv)$/i.test(absPath)) {
      const doc = await docStudio.readDocument(absPath, { cwd: p.cwd || path.dirname(absPath) });
      return { ok: true, kind: 'document', path: absPath, name: path.basename(absPath), size: stat.size, ext, fileUrl: 'file://' + encodeURI(absPath), ...doc };
    }
    return { ok: true, kind: 'file', path: absPath, name: path.basename(absPath), size: stat.size, ext };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('autobot:studioAction', async (event, payload) => {
  try {
    const p = payload || {};
    const action = String(p.action || '');
    let srcPath = String(p.path || '').trim();
    if (srcPath && !fs.existsSync(srcPath) && p.cachePath && fs.existsSync(p.cachePath)) {
      srcPath = p.cachePath;
    }
    const cwd = p.cwd || (srcPath ? path.dirname(srcPath) : workspace.scratch());
    const mediaGen = require('../media-gen');
    const docStudio = require('../doc-studio');
    if (action === 'reveal') {
      if (srcPath && fs.existsSync(srcPath)) shell.showItemInFolder(srcPath);
      else if (cwd && fs.existsSync(cwd)) shell.openPath(cwd);
      return { ok: true };
    }
    if (action === 'reveal_library') {
      const libDir = mediaGen.resolveLibraryDir ? mediaGen.resolveLibraryDir() : path.join(os.homedir(), '.autobot', 'media-library');
      fs.mkdirSync(libDir, { recursive: true });
      shell.openPath(libDir);
      return { ok: true, path: libDir };
    }
    if (action === 'copy_image') {
      const { clipboard, nativeImage } = require('electron');
      let img = srcPath && fs.existsSync(srcPath) ? nativeImage.createFromPath(srcPath) : null;
      if ((!img || img.isEmpty()) && srcPath && fs.existsSync(srcPath)) {
        try {
          const decoded = await mediaGen.decodeImageBuffer(srcPath);
          if (decoded && decoded.width > 0 && decoded.height > 0 && decoded.data) {
            const { PNG } = require('pngjs');
            const png = new PNG({ width: decoded.width, height: decoded.height });
            decoded.data.copy(png.data);
            img = nativeImage.createFromBuffer(PNG.sync.write(png));
          }
        } catch (_) {}
      }
      if (!img || img.isEmpty()) {
        if (p.dataUrl && typeof p.dataUrl === 'string' && p.dataUrl.startsWith('data:image/')) {
          img = nativeImage.createFromDataURL(p.dataUrl);
        }
      }
      if (!img || img.isEmpty()) return { ok: false, error: 'Could not decode image for clipboard' };
      clipboard.writeImage(img);
      return { ok: true, copied: true };
    }
    if (action === 'saveAs') {
      const ext = path.extname(srcPath).slice(1) || '*';
      const r = await dialog.showSaveDialog(winFor(event), {
        title: 'Save As…',
        defaultPath: path.basename(srcPath),
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All Files', extensions: ['*'] }],
      });
      if (r.canceled || !r.filePath) return { ok: true, canceled: true };
      fs.copyFileSync(srcPath, r.filePath);
      return { ok: true, path: r.filePath };
    }
    if (action === 'resize') {
      return await mediaGen.editImage({ input_path: srcPath, operation: 'resize', width: Number(p.width) || 800, height: p.height ? Number(p.height) : undefined, cwd }, { store, provider: store.getSettings().provider || {}, orchestrator: store.getOrchestrator(), cwd });
    }
    if (action === 'remove_background' || action === 'upscale' || action === 'ai_edit') {
      return await mediaGen.editImage({ input_path: srcPath, operation: action, instruction: p.instruction || '', model: p.model || '', cwd }, { store, provider: store.getSettings().provider || {}, orchestrator: store.getOrchestrator(), cwd });
    }
    if (action === 'to_gif' || action === 'extract_frames' || action === 'extract_audio') {
      return await mediaGen.editVideo({ input_path: srcPath, operation: action, cwd });
    }
    if (action === 'extract_archive') {
      const destDir = p.destDir || path.join(path.dirname(srcPath), path.basename(srcPath, path.extname(srcPath)));
      return docStudio.extractArchive(srcPath, destDir);
    }
    if (action === 'export_pdf') {
      const doc = await docStudio.readDocument(srcPath, { cwd });
      const outPdf = srcPath.replace(/\.[^.]+$/, '') + '.pdf';
      return await docStudio.generateDocument({ format: 'pdf', output_path: outPdf, title: path.basename(srcPath), markdown: doc.markdown || doc.text || '', cwd });
    }
    return { ok: false, error: `Unknown studioAction: ${action}` };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

function buildMediaKeysSnapshot() {
  const router = require('../orch-router');
  const settings = store.getSettings ? (store.getSettings() || {}) : {};
  const pKeys = (settings && settings.providerKeys) || {};
  let flProvs = {};
  try {
    const fl = require('../freellm').loadConfig();
    if (fl && fl.providers) flProvs = fl.providers;
  } catch (_) {}

  const findInUrlKeys = (matchers) => {
    for (const [u, v] of Object.entries(pKeys)) {
      if (v && String(v).trim() && matchers.some((rx) => rx.test(String(u)))) return String(v).trim();
    }
    return '';
  };

  const hint = (v) => (v ? '••••' + String(v).slice(-4) : '');
  const specs = router.MEDIA_PROVIDER_KEYS || [];
  const providers = specs.map((spec) => {
    let val = '';
    let source = '';
    const sVal = secretstore.get(spec.id);
    if (sVal && String(sVal).trim()) {
      val = String(sVal).trim();
      source = 'secretstore';
    } else if (process.env[spec.id] && String(process.env[spec.id]).trim()) {
      val = String(process.env[spec.id]).trim();
      source = 'env';
    } else if (spec.id === 'GEMINI_API_KEY') {
      const alt = secretstore.get('GOOGLE_API_KEY') || process.env.GOOGLE_API_KEY || findInUrlKeys([/generativelanguage\.googleapis\.com/i, /ai\.google/i]) || ((flProvs.google && (flProvs.google.apiKey || flProvs.google.key)) || '');
      if (alt) { val = String(alt).trim(); source = 'configured'; }
    } else if (spec.id === 'OPENAI_API_KEY') {
      const alt = findInUrlKeys([/api\.openai\.com/i]);
      if (alt) { val = alt; source = 'providerKeys'; }
    } else if (spec.id === 'XAI_API_KEY') {
      const alt = findInUrlKeys([/api\.x\.ai/i, /grok\.com/i]) || (flProvs.xai && flProvs.xai.apiKey) || (flProvs.grok && flProvs.grok.apiKey) || '';
      if (alt) { val = String(alt).trim(); source = 'configured'; }
    } else if (spec.id === 'FAL_KEY') {
      const alt = secretstore.get('FAL_API_KEY') || process.env.FAL_API_KEY || findInUrlKeys([/fal\.run|fal\.ai/i]);
      if (alt) { val = String(alt).trim(); source = 'configured'; }
    } else if (spec.id === 'REPLICATE_API_TOKEN') {
      const alt = secretstore.get('REPLICATE_API_KEY') || process.env.REPLICATE_API_KEY || findInUrlKeys([/api\.replicate\.com/i]);
      if (alt) { val = String(alt).trim(); source = 'configured'; }
    } else if (spec.id === 'TOGETHER_API_KEY') {
      const alt = findInUrlKeys([/api\.together\.xyz/i]) || (flProvs.together && flProvs.together.apiKey) || '';
      if (alt) { val = String(alt).trim(); source = 'configured'; }
    } else if (spec.id === 'CLOUDFLARE_API_TOKEN') {
      const alt = secretstore.get('CLOUDFLARE_API_KEY') || process.env.CLOUDFLARE_API_KEY || (flProvs.cloudflare && flProvs.cloudflare.apiKey) || '';
      if (alt) { val = String(alt).trim(); source = 'configured'; }
    }

    let extraValue = '';
    if (spec.extraField && spec.extraField.id) {
      extraValue = String(
        secretstore.get(spec.extraField.id)
        || process.env[spec.extraField.id]
        || (spec.id === 'CLOUDFLARE_API_TOKEN' && flProvs.cloudflare && (flProvs.cloudflare.accountId || flProvs.cloudflare.account_id))
        || ''
      ).trim();
    }

    return {
      ...spec,
      hasKey: Boolean(val) && (!spec.extraField || Boolean(extraValue)),
      rawKeySet: Boolean(val),
      keyHint: hint(val),
      source,
      extraValue,
    };
  });

  return { ok: true, providers };
}

ipcMain.handle('autobot:mediaKeysGet', () => {
  try {
    return buildMediaKeysSnapshot();
  } catch (e) {
    return { ok: false, providers: [], error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('autobot:mediaKeysSave', (_event, payload = {}) => {
  try {
    const router = require('../orch-router');
    const keys = (payload && payload.keys && typeof payload.keys === 'object') ? payload.keys : {};
    const clearKeys = Array.isArray(payload && payload.clearKeys) ? payload.clearKeys : [];
    for (const [k, v] of Object.entries(keys)) {
      const id = String(k || '').trim();
      if (!id) continue;
      if (typeof v === 'string') {
        const clean = v.trim();
        if (clean && !clean.startsWith('••••')) {
          secretstore.set(id, clean);
        }
      }
    }
    for (const rawId of clearKeys) {
      const id = String(rawId || '').trim();
      if (!id) continue;
      secretstore.del(id);
      if (id === 'GEMINI_API_KEY') secretstore.del('GOOGLE_API_KEY');
      if (id === 'FAL_KEY') secretstore.del('FAL_API_KEY');
      if (id === 'REPLICATE_API_TOKEN') secretstore.del('REPLICATE_API_KEY');
      if (id === 'CLOUDFLARE_API_TOKEN') secretstore.del('CLOUDFLARE_API_KEY');
    }
    const snap = buildMediaKeysSnapshot();
    const catalog = router.listMediaStudioCatalog({
      store,
      provider: (store.getSettings && store.getSettings().provider) || {},
      orchestrator: store.getOrchestrator(),
    });
    return { ...snap, catalog };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('autobot:mediaStudioCatalog', async (_event, payload) => {
  try {
    const p = payload || {};
    const mediaGen = require('../media-gen');
    const router = require('../orch-router');
    const catalog = router.listMediaStudioCatalog({
      store,
      provider: p.provider || store.getSettings().provider || {},
      orchestrator: store.getOrchestrator(),
    });
    const library = mediaGen.listMediaLibrary({ cwd: p.cwd || '', kind: p.kind || 'all', limit: 150 });
    return {
      ok: true,
      ...catalog,
      library,
      libraryDir: mediaGen.resolveLibraryDir(),
    };
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('autobot:mediaStudioGenerate', async (_event, payload) => {
  try {
    const p = payload || {};
    const mediaGen = require('../media-gen');
    const router = require('../orch-router');
    const cwd = p.cwd || workspace.scratch();
    const ctx = { store, provider: p.provider || store.getSettings().provider || {}, orchestrator: store.getOrchestrator(), cwd };
    if (p.model && String(p.model).toLowerCase() !== 'auto') {
      const cat = router.listMediaStudioCatalog({ store, provider: ctx.provider, orchestrator: ctx.orchestrator });
      const list = p.kind === 'video' ? cat.videoModels : cat.imageModels;
      const entry = (list || []).find((m) => m.id === p.model);
      if (entry && entry.available === false) {
        return {
          ok: false,
          needsApiKey: true,
          configKeyId: entry.configKeyId || '',
          error: `${entry.label} requires ${entry.requiredKeyLabel || 'an API key'} — click Configure to add your API key in Settings.`,
        };
      }
    }
    if (p.kind === 'video') {
      return await mediaGen.generateVideo({
        prompt: p.prompt || 'Akron Motion Studio',
        model: p.model || '',
        aspect_ratio: p.aspect_ratio || '16:9',
        duration_sec: Number(p.duration_sec) || 3,
        format: p.format || 'mp4',
        image_path: p.image_path || '',
        cwd,
      }, ctx);
    }
    if (p.kind === 'edit_image' && p.input_path) {
      return await mediaGen.editImage({
        input_path: p.input_path,
        operation: p.operation || 'ai_edit',
        instruction: p.prompt || p.instruction || '',
        model: p.model || '',
        style: p.style || '',
        cwd,
      }, ctx);
    }
    return await mediaGen.generateImage({
      prompt: p.prompt || '',
      model: p.model || '',
      style: p.style || '',
      aspect_ratio: p.aspect_ratio || '16:9',
      format: p.format || 'png',
      count: Number(p.count) || 1,
      cwd,
    }, ctx);
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

ipcMain.handle('autobot:mediaStudioDelete', async (_event, payload) => {
  try {
    const p = payload || {};
    const mediaGen = require('../media-gen');
    return mediaGen.deleteMediaLibraryItem({ id: p.id || '', path: p.path || '' });
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e) };
  }
});

// Generic save-to-file (conversation export/share writes land here; all content
// formatting happens in the renderer). Returns the chosen path or null on cancel.
ipcMain.handle('autobot:saveFile', async (event, { defaultName, content, filters }) => {
  try {
    const r = await dialog.showSaveDialog(winFor(event), {
      title: 'Export',
      defaultPath: defaultName || 'export.txt',
      filters: filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePath) return { ok: true, path: null };
    fs.writeFileSync(r.filePath, String(content ?? ''), 'utf8');
    return { ok: true, path: r.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// "Apply to file" (Claude Code parity): write a code block straight into the
// conversation's project folder (or an absolute/`~`/relative path) with no dialog.
ipcMain.handle('autobot:writeFile', async (event, { file, content, cwd }) => {
  try {
    const winSec = require('../window-security');
    if (!winSec.isTrustedRendererEvent(event)) return { ok: false, error: 'Untrusted renderer origin' };
    if (!file) return { ok: false, error: 'filename required' };
    const target = paths.resolvePath(file, cwd || workspace.scratch());
    if (winSec.isBlockedCredentialTarget(target, sandbox)) return { ok: false, error: 'modification of Akron credential store is blocked' };
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, String(content ?? ''), 'utf8');
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// macOS TTS (Claude Desktop parity: "speak" uses the system voice). `say` ships
// with macOS; non-darwin is a no-op.
let sayProc = null;
ipcMain.handle('autobot:speak', (e, text) => {
  if (process.platform !== 'darwin' || !text) return { ok: false };
  try {
    if (sayProc) { try { sayProc.kill(); } catch (_) {} }
    sayProc = spawn('say', [String(text)], { stdio: 'ignore' });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:stopSpeak', () => {
  if (sayProc) { try { sayProc.kill(); } catch (_) {} sayProc = null; }
  return { ok: true };
});

// Open a URL in the user's default browser (upgrade links, OAuth/SSO portals).
ipcMain.handle('autobot:openExternal', (e, url) => {
  try {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return { ok: false, error: 'invalid url' };
    shell.openExternal(url);
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// MCP
ipcMain.handle('autobot:mcpConnect', async (e, cfg) => {
  try {
    const info = await mcp.connect(cfg);
    // stash full defs for agent tool exposure
    const entry = mcp.servers.get(info.serverId);
    entry.fullTools = info.tools || [];
    return { ok: true, serverId: info.serverId, tools: info.tools };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
ipcMain.handle('autobot:mcpListTools', (e, serverId) => mcp.listTools(serverId));
ipcMain.handle('autobot:mcpCallTool', async (e, serverId, name, args) => {
  try { return { ok: true, result: await mcp.callTool(serverId, name, args) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:mcpDisconnect', (e, serverId) => { mcp.disconnect(serverId); return { ok: true }; });
ipcMain.handle('autobot:mcpStatus', () => mcpStatus());
ipcMain.handle('autobot:mcpConfig', async (e, cwd) => {
  try {
    const dir = cwdFor(cwd);
    if (typeof autoConnectMcp === 'function') {
      await autoConnectMcp(dir).catch(() => {});
    }
    const c = require('../claudeconfig').loadMcpServers(dir);
    return { servers: Object.keys(c.servers || {}), sources: c.sources || [], status: mcpStatus() };
  } catch (_) { return { servers: [], sources: [], status: [] }; }
});

// MCP resources
ipcMain.handle('autobot:mcpListResources', async (e, serverId) => {
  try { return { ok: true, resources: await mcp.listResources(serverId) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:mcpReadResource', async (e, serverId, uri) => {
  try { return { ok: true, content: await mcp.readResource(serverId, uri) }; }
  catch (err) { return { ok: false, error: err.message }; }
});

// Interactive question / plan-mode answers
ipcMain.handle('autobot:answerQuestion', async (e, id, answer) => {
  if (questionGate && typeof questionGate.answer === 'function') {
    const r = questionGate.answer(id, answer);
    if (r && r.ok) return r;
  }
  const resolve = pendingQuestions.get(id);
  if (resolve) {
    pendingQuestions.delete(id);
    resolve(answer);
    return { ok: true };
  }
  return { ok: false, error: 'question not found (timed out?)' };
});

// B8 permission prompts (approve/deny/scope/feedback for a mutating tool call).
ipcMain.handle('autobot:answerPermission', async (e, id, payload) => {
  return permGate.answer(id, payload);
});

// Notebooks
ipcMain.handle('autobot:listNotebooks', () => store.listNotebooks());
ipcMain.handle('autobot:getNotebook', (e, name) => store.getNotebook(name));
ipcMain.handle('autobot:saveNotebook', (e, name, cells) => store.writeNotebook(name, cells));
ipcMain.handle('autobot:deleteNotebook', (e, name) => store.deleteNotebook(name));

// Background shells / terminal
ipcMain.handle('autobot:shellStart', async (e, opts) => {
  // Interactive shells re-run rc files, so hand them the runtime dirs to
  // re-prepend once that has happened.
  let pathPrefix = '';
  try { pathPrefix = await runtimePathPrefix(); } catch (_) { /* ignore */ }
  return shells.start({ ...(opts || {}), pathPrefix });
});
ipcMain.handle('autobot:shellRun', async (e, id, command, opts) => {
  try { return { ok: true, output: await shells.run(id, command, opts || {}) }; }
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('autobot:shellWrite', (e, id, data) => shells.write(id, data));
ipcMain.handle('autobot:shellRead', (e, id) => shells.read(id));
ipcMain.handle('autobot:shellList', () => shells.list());
ipcMain.handle('autobot:shellKill', (e, id) => shells.kill(id));

// Repo-aware "Claude Code" mode (B8): git introspection, worktrees + unified diff.
ipcMain.handle('autobot:gitInfo', async (e, cwd) => git.gitInfo(cwd));
ipcMain.handle('autobot:worktreeList', async (e, cwd) => git.listWorktrees(cwd));
ipcMain.handle('autobot:worktreeAdd', async (e, cwd, branch, targetDir) => git.addWorktree(cwd, branch, targetDir));
ipcMain.handle('autobot:worktreeRemove', async (e, cwd, targetDir) => git.removeWorktree(cwd, targetDir));
ipcMain.handle('autobot:serverInfo', async () => {
  const st = require('../extbridge').status();
  return {
    port: st.port || 8766,
    url: `http://127.0.0.1:${st.port || 8766}`,
    wsUrl: `ws://127.0.0.1:${st.port || 8766}`,
    platform: process.platform,
    arch: process.arch,
    pid: process.pid,
    extensionConnected: !!st.extensionConnected,
    connectedClients: st.connectedClients || 0,
  };
});
ipcMain.handle('autobot:gitRun', async (e, cwd, args) => {
  try {
    const { exec } = require('child_process');
    const out = await new Promise((resolve) => {
      exec('git ' + args.join(' '), { cwd: cwd || process.cwd(), timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || '') });
      });
    });
    return out;
  } catch (err) { return { ok: false, stderr: err.message }; }
});
ipcMain.handle('autobot:diff', async (e, oldText, newText, label) => git.unifiedDiff(oldText, newText, label));

// ---- Execution Environments (This Computer · SSH Host · Remote Server) ----
function broadcastEnvChanged(state) {
  const s = state || environments.getState();
  for (const w of windows) {
    if (w && !w.isDestroyed()) {
      try { w.webContents.send('autobot:envChanged', s); } catch (_) {}
    }
  }
}
ipcMain.handle('autobot:envGetState', () => environments.getState());
ipcMain.handle('autobot:envSetActive', (e, spec) => {
  const res = environments.setActive(spec || { kind: 'local' });
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envSaveSsh', (e, profile) => {
  const res = environments.saveSshProfile(profile || {});
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envDeleteSsh', (e, id) => {
  const res = environments.deleteSshProfile(id);
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envTestSsh', (e, profileOrId) => environments.testSsh(profileOrId));
ipcMain.handle('autobot:envSaveRemote', (e, profile) => {
  const res = environments.saveRemoteProfile(profile || {});
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envDeleteRemote', (e, id) => {
  const res = environments.deleteRemoteProfile(id);
  if (res && res.ok) broadcastEnvChanged(res.state);
  return res;
});
ipcMain.handle('autobot:envTestRemote', (e, profileOrId) => environments.testRemote(profileOrId));
ipcMain.handle('autobot:envToggleHostServer', async (e, enabled, opts) => {
  const res = await environments.toggleHostServer(!!enabled, opts || {});
  try {
    const features = store.setFeatures({
      remoteControl: !!(res && res.running),
      remoteServerEnabled: !!(res && res.running),
    });
    if (typeof applyFeatures === 'function') applyFeatures(features);
    if (typeof broadcast === 'function') broadcast({ type: 'features', features });
  } catch (_) {}
  broadcastEnvChanged(res && res.state);
  return res;
});
ipcMain.handle('autobot:envGetHostToken', () => environments.getHostServerToken());

// ---- Phase 3: Built-in Dependencies, LSP Auto-Install & GitHub Releases Auto-Updater ----
ipcMain.handle('autobot:depsStatus', () => depManager.getDependenciesStatus());
ipcMain.handle('autobot:depsInstallLsp', (e, id) => depManager.installLspServer(id, {
  onProgress: (evt) => {
    try { e.sender.send('autobot:event', { type: 'dep-lsp', ...evt }); } catch (_) {}
  },
}));
ipcMain.handle('autobot:updateCheck', (e, opts) => updater.checkForUpdates({
  currentVersion: app.getVersion(),
  ...(opts || {}),
}));
ipcMain.handle('autobot:updateDownload', (e, opts) => updater.downloadAndVerifyUpdate({
  ...(opts || {}),
  onProgress: (prog) => {
    try { e.sender.send('autobot:event', { type: 'app-update-progress', ...prog }); } catch (_) {}
  },
}));
ipcMain.handle('autobot:updateApply', (e, stagedPath) => updater.applyUpdate(stagedPath, {
  appBundlePath: process.platform === 'darwin' ? path.resolve(process.execPath, '..', '..', '..') : undefined,
  quitApp: () => { try { setTimeout(() => app.quit(), 450); } catch (_) {} },
}));

// ---- Paradev (Superset) Raw API Subscription Bridge ----
ipcMain.handle('autobot:paradevStatus', async (e, opts = {}) => {
  try { return await require('../paradev-client').getStatus(opts || {}); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:paradevSaveConfig', async (e, payload = {}) => {
  try {
    const pv = require('../paradev-client');
    const saved = pv.saveConfig(payload || {});
    if (saved && saved.configured) pv.ensureParadevMcpConnected(mcp, { force: true }).catch(() => {});
    return saved;
  } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:paradevTranscribe', async (e, payload = {}) => {
  try { return await require('../paradev-client').transcribeAudio(payload || {}); } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:paradevWorkspaces', async (e, payload = {}) => {
  try {
    const pv = require('../paradev-client');
    const act = String((payload && payload.action) || 'list').toLowerCase();
    if (act === 'create') return await pv.createWorkspace(payload);
    if (act === 'delete') return await pv.deleteWorkspace(payload.workspaceId);
    if (act === 'get') return await pv.getWorkspace(payload.workspaceId);
    return await pv.listWorkspaces(payload || {});
  } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:paradevTasks', async (e, payload = {}) => {
  try {
    const pv = require('../paradev-client');
    const act = String((payload && payload.action) || 'list').toLowerCase();
    if (act === 'create') return await pv.createTask(payload);
    if (act === 'update') return await pv.updateTask(payload);
    if (act === 'delete') return await pv.deleteTask(payload);
    if (act === 'statuses') return await pv.listTaskStatuses(payload || {});
    return await pv.listTasks(payload || {});
  } catch (err) { return { ok: false, error: oneLine(err) }; }
});
ipcMain.handle('autobot:paradevAddMcp', async () => {
  try {
    const pv = require('../paradev-client');
    const presets = pv.getMcpServerPresets();
    const added = [];
    for (const srv of presets) {
      try {
        const info = await mcp.connect(srv);
        const entry = mcp.servers.get(info.serverId);
        if (entry) entry.fullTools = info.tools || [];
        added.push(srv.name);
      } catch (_) {}
    }
    return { ok: true, added, status: mcpStatus() };
  } catch (err) { return { ok: false, error: oneLine(err) }; }
});

// Background auto-update check scheduler (runs once shortly after startup, then every 4h)
if (!process.env.AKRON_COLD_BOOT_CHECK && process.env.NODE_ENV !== 'test') {
  const _updSched = updater.createUpdateScheduler({
    intervalMs: 4 * 60 * 60 * 1000,
    getOptions: () => ({ currentVersion: app.getVersion() }),
    onUpdateAvailable: (info) => {
      for (const w of windows) {
        try { if (w && !w.isDestroyed()) w.webContents.send('autobot:event', { type: 'app-update-available', ...info }); } catch (_) {}
      }
    },
  });
  const _tUpd = setTimeout(() => { _updSched.runOnce().catch(() => {}); _updSched.start(); }, 18000);
  if (_tUpd && typeof _tUpd.unref === 'function') _tUpd.unref();
}
ipcMain.handle('autobot:tokenBudget', (e, payload = {}) => {
  try { return require('../token-budget').analyzeCustomizationBudget(payload); } catch (err) { return { error: err.message, items: [] }; }
});
ipcMain.handle('autobot:setPreventSleep', (e, enabled) => require('../app-system').setPreventSleep(enabled));
ipcMain.handle('autobot:browserRulesCheck', (e, payload = {}) => require('../browser-rules').evaluateBrowserUrlRule(payload.url, payload));
ipcMain.handle('autobot:generateDiagnostics', (e, payload = {}) => require('../diagnostics').generateDiagnosticBundle({
  appVersion: app.getVersion(),
  ...(payload || {}),
}));
{
  const dbg = require('../debug-logger');
  dbg.setAppVersion(app.getVersion());
  dbg.record('info', 'app', 'startup', { version: app.getVersion(), platform: process.platform, arch: process.arch });
  const _tPrune = setTimeout(() => { try { dbg.pruneRuntimeDirs(); } catch (_) {} }, 12000);
  if (_tPrune && typeof _tPrune.unref === 'function') _tPrune.unref();
  ipcMain.handle('autobot:debugLogGet', (_e, limit = 120) => ({
    ok: true,
    config: dbg.getConfig(),
    entries: dbg.tail(limit),
    logPath: dbg.logFilePath(),
  }));
  ipcMain.handle('autobot:debugLogSetConfig', (_e, patch = {}) => ({
    ok: true,
    config: dbg.setConfig(patch || {}),
  }));
  ipcMain.handle('autobot:debugLogClear', () => dbg.clear());
  ipcMain.handle('autobot:debugLogSendReport', async (_e, payload = {}) => dbg.sendReportNow(payload || {}));
}

// Built-in Browser (renderer <webview> registers its guest WebContents; the
// agent tools in tools.js control it through the same controller).
// If an agent tool needs the browser and the pane is closed, ask every renderer
// to mount it. The renderer opens the pane; its <webview> registers the guest
// WebContents; ensureGuest() then resolves.
browser.setEnsurePane(() => {
  for (const w of windows) {
    if (w && !w.isDestroyed()) w.webContents.send('autobot:browserEnsure');
  }
});
// Tab state lives in the renderer; forward agent tab commands there.
browser.setTabCommand((cmd) => {
  for (const w of windows) {
    if (w && !w.isDestroyed()) w.webContents.send('autobot:browserTabsCommand', cmd);
  }
});

ipcMain.handle('autobot:browserRegister', (e, webContentsId) => browser.register(webContentsId));
ipcMain.handle('autobot:browserUnregister', (e, webContentsId) => browser.unregister(webContentsId));
ipcMain.handle('autobot:browserLoadURL', (e, url, cwd) => browser.loadURL(url, cwd));
// Resolve a typed/pasted path or folder to a real page URL (folder → index.html)
// so the omnibox behaves like Example's browser instead of landing on a directory.
ipcMain.handle('autobot:resolveUrl', (e, url, cwd) => browser.normalizeUrl(url, cwd));
ipcMain.handle('autobot:browserGoBack', () => browser.goBack());
ipcMain.handle('autobot:browserGoForward', () => browser.goForward());
ipcMain.handle('autobot:browserReload', () => browser.reload());
ipcMain.handle('autobot:browserStop', () => browser.stop());
ipcMain.handle('autobot:browserGetURL', () => browser.getURL());
ipcMain.handle('autobot:browserGetTitle', () => browser.getTitle());
ipcMain.handle('autobot:browserRead', () => browser.read());
ipcMain.handle('autobot:browserEval', (e, code, userGesture) => browser.executeJS(code, userGesture));
ipcMain.handle('autobot:browserClick', (e, selector, index) => browser.click(selector, index));
ipcMain.handle('autobot:browserType', (e, selector, text) => browser.type(selector, text));
ipcMain.handle('autobot:browserPress', (e, key) => browser.press(key));
ipcMain.handle('autobot:browserHover', (e, selector, index) => browser.hover(selector, index));
ipcMain.handle('autobot:browserSelect', (e, selector, value) => browser.select(selector, value));
ipcMain.handle('autobot:browserScroll', (e, direction, amount, selector) => browser.scroll(direction, amount, selector));
ipcMain.handle('autobot:browserWaitFor', (e, selector, timeoutMs) => browser.waitFor(selector, timeoutMs));
ipcMain.handle('autobot:browserScreenshot', (e, fullPage, webContentsId) => browser.screenshot(fullPage, webContentsId));
ipcMain.handle('autobot:browserSyncTabs', (e, state) => browser.syncTabs(state));
ipcMain.handle('autobot:browserListTabs', () => browser.listTabs());


// ---- Built-in browser ··· menu (Claude-app parity) ----
// Each item here maps to something that actually happens. "Open in Brave" checks
// that Brave is installed first — if it is not, the renderer is told so and shows
// "Open in default browser" instead of failing silently.
ipcMain.handle('autobot:browserOpenExternal', async (e, url, profile) => {
  if (!url) return { ok: false, error: 'No URL' };
  const brave = path.join('/Applications', 'Brave Browser.app');
  if (profile === 'brave') {
    if (!fs.existsSync(brave)) return { ok: false, error: 'Brave Browser is not installed', fallback: 'default' };
    const { spawn } = require('child_process');
    try { spawn('/usr/bin/open', ['-b', 'com.brave.Browser', url], { detached: true, stdio: 'ignore' }).unref(); return { ok: true, app: 'Brave Browser' }; }
    catch (err) { return { ok: false, error: String(err && err.message || err), fallback: 'default' }; }
  }
  try { await shell.openExternal(url); return { ok: true, app: 'default browser' }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('autobot:browserSaveScreenshot', async (e, suggestedName) => {
  const shot = await browser.screenshot(false);
  if (!shot || !shot.ok) return shot || { ok: false, error: 'Could not capture the page' };
  const win = BrowserWindow.getFocusedWindow() || windows[0];
  const res = await dialog.showSaveDialog(win, {
    title: 'Save screenshot',
    defaultPath: path.join(app.getPath('desktop'), (suggestedName || 'screenshot') + '.png'),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try { fs.copyFileSync(shot.path, res.filePath); return { ok: true, path: res.filePath }; }
  catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

ipcMain.handle('autobot:browserOpenFile', async () => {
  const win = BrowserWindow.getFocusedWindow() || windows[0];
  const res = await dialog.showOpenDialog(win, {
    title: 'Open HTML file',
    properties: ['openFile'],
    filters: [{ name: 'Web page', extensions: ['html', 'htm', 'xhtml', 'svg'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  const file = res.filePaths[0];
  return { ok: true, url: 'file://' + file, path: file };
});

// Netscape cookies.txt → Chromium cookie store for the browser partition.
ipcMain.handle('autobot:browserImportCookies', async (e, partition) => {
  const win = BrowserWindow.getFocusedWindow() || windows[0];
  const res = await dialog.showOpenDialog(win, {
    title: 'Import cookies (Netscape cookies.txt)',
    properties: ['openFile'],
    filters: [{ name: 'Cookies file', extensions: ['txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, canceled: true };
  let text;
  try { text = fs.readFileSync(res.filePaths[0], 'utf8'); } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
  const ses = session.fromPartition(partition || 'persist:autobot');
  let added = 0, failed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('\t');
    if (f.length < 7) continue;
    const [domain, flag, cpath, secure, expires, name, value] = f;
    const url = (secure === 'TRUE' ? 'https://' : 'http://') + String(domain).replace(/^\./, '') + (cpath || '/');
    try {
      await ses.cookies.set({
        url, name, value,
        domain: domain.startsWith('.') ? domain : undefined,
        path: cpath || '/',
        secure: secure === 'TRUE',
        httpOnly: String(flag).toUpperCase().includes('HTTPONLY'),
        expirationDate: Number(expires) > 0 ? Number(expires) : undefined,
      });
      added += 1;
    } catch (_) { failed += 1; }
  }
  return { ok: true, added, failed, file: res.filePaths[0] };
});

ipcMain.handle('autobot:browserClearData', async (e, partition) => {
  const ses = session.fromPartition(partition || 'persist:autobot');
  try {
    await ses.clearStorageData();
    await ses.clearCache().catch(() => {});
    return { ok: true };
  } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});

// Dev-server detection for the browser pane ("Dev server found … [Run]").
const devserver = require('../devserver');
ipcMain.handle('autobot:devServerDetect', (e, cwd) => devserver.detect(cwd));
ipcMain.handle('autobot:devServerStart', (e, cwd) => devserver.start(cwd));

ipcMain.handle('autobot:migrationScan', (e, payload = {}) => {
  try { return require('../importer').scanExternalConfigs({ cwd: cwdFor(payload.cwd) }); }
  catch (err) { return { ok: false, error: err.message, items: [] }; }
});
ipcMain.handle('autobot:migrationApply', (e, payload = {}) => {
  try { return require('../importer').importExternalConfigs(payload || {}); }
  catch (err) { return { ok: false, error: err.message }; }
});

// Dedicated DeepSeek V4.1 Flash Auto-Switch Dispatcher Brain config (3 Sources + Telemetry)
function buildAutoRouterSnapshot(tr, settings) {
  const s = settings || {};
  const sw = s.autoSwitch || {};
  const ar = s.autoRouter || {};
  const source = tr.AUTO_SWITCH_SOURCES[sw.source] ? sw.source : 'openrouter_free';
  const orKey = secretstore.get('autobot.autoswitch.openrouter_key') || '';
  const dsKey = secretstore.get('autobot.autoswitch.deepseek_key') || secretstore.get('deepseek-router:apiKey') || '';
  const flKey = secretstore.get('autobot.autoswitch.freellm_key') || '';
  const hint = (k) => (k ? '••••' + String(k).slice(-4) : '');
  const activeKey = source === 'openrouter_free' ? orKey : (source === 'deepseek_api' ? dsKey : flKey);
  const spec = tr.AUTO_SWITCH_SOURCES[source];
  const hasKey = Boolean(activeKey || (source === 'freellmapi'));
  return {
    ok: true,
    source,
    defaultForNewSessions: Boolean(sw.defaultForNewSessions),
    hasKey,
    keyHint: hint(activeKey),
    model: (source === 'deepseek_api' ? (ar.model || spec.model) : spec.model),
    baseURL: (source === 'deepseek_api' ? (ar.baseURL || spec.baseURL) : spec.baseURL),
    sources: {
      openrouter_free: { hasKey: Boolean(orKey), keyHint: hint(orKey), model: tr.AUTO_SWITCH_SOURCES.openrouter_free.model, baseURL: tr.AUTO_SWITCH_SOURCES.openrouter_free.baseURL },
      deepseek_api: { hasKey: Boolean(dsKey), keyHint: hint(dsKey), model: ar.model || tr.AUTO_SWITCH_SOURCES.deepseek_api.model, baseURL: ar.baseURL || tr.AUTO_SWITCH_SOURCES.deepseek_api.baseURL },
      freellmapi: { hasKey: true, customKeySet: Boolean(flKey), keyHint: hint(flKey), model: tr.AUTO_SWITCH_SOURCES.freellmapi.model, baseURL: tr.AUTO_SWITCH_SOURCES.freellmapi.baseURL },
    },
    telemetry: tr.getDispatcherTelemetry(),
  };
}

ipcMain.handle('autobot:autoRouterGet', () => {
  try {
    const tr = require('../task-router');
    const settings = store.getSettings ? store.getSettings() : {};
    return buildAutoRouterSnapshot(tr, settings);
  } catch (err) {
    return { ok: false, source: 'openrouter_free', hasKey: false, keyHint: '', model: 'deepseek/deepseek-v4.1-flash:free', baseURL: 'https://openrouter.ai/api/v1', error: err.message };
  }
});

ipcMain.handle('autobot:autoRouterSave', (e, payload = {}) => {
  try {
    const tr = require('../task-router');
    const settings = store.getSettings ? store.getSettings() : {};
    const prevSw = (settings && settings.autoSwitch) || {};
    const prevAr = (settings && settings.autoRouter) || {};
    const source = tr.AUTO_SWITCH_SOURCES[payload.source] ? payload.source : (prevSw.source || 'openrouter_free');
    const spec = tr.AUTO_SWITCH_SOURCES[source];

    if (typeof payload.apiKey === 'string') {
      const k = payload.apiKey.trim();
      if (k && !k.startsWith('••••')) {
        secretstore.set(spec.secretKey, k);
        if (source === 'deepseek_api') secretstore.set('deepseek-router:apiKey', k);
      }
    }

    const defaultForNewSessions = payload.defaultForNewSessions !== undefined
      ? Boolean(payload.defaultForNewSessions)
      : Boolean(prevSw.defaultForNewSessions);

    const dsModel = source === 'deepseek_api'
      ? (String(payload.model || prevAr.model || 'deepseek-v4-flash').trim() || 'deepseek-v4-flash')
      : (prevAr.model || 'deepseek-v4-flash');
    const dsBase = source === 'deepseek_api'
      ? (String(payload.baseURL || prevAr.baseURL || 'https://api.deepseek.com/v1').trim().replace(/\/+$/, '') || 'https://api.deepseek.com/v1')
      : (prevAr.baseURL || 'https://api.deepseek.com/v1');

    const dsKeyNow = secretstore.get('autobot.autoswitch.deepseek_key') || secretstore.get('deepseek-router:apiKey') || '';
    const autoSwitch = { source, defaultForNewSessions };
    const nextSettings = store.setSettings({
      autoSwitch,
      autoRouter: {
        hasKey: Boolean(dsKeyNow),
        keyHint: dsKeyNow ? '••••' + String(dsKeyNow).slice(-4) : '',
        model: dsModel,
        baseURL: dsBase,
      },
    });
    return buildAutoRouterSnapshot(tr, nextSettings);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('autobot:autoRouterClear', (e, payload = {}) => {
  try {
    const tr = require('../task-router');
    const settings = store.getSettings ? store.getSettings() : {};
    const prevSw = (settings && settings.autoSwitch) || {};
    const prevAr = (settings && settings.autoRouter) || {};
    const source = tr.AUTO_SWITCH_SOURCES[payload.source] ? payload.source : (prevSw.source || 'openrouter_free');
    const spec = tr.AUTO_SWITCH_SOURCES[source];

    secretstore.del(spec.secretKey);
    if (source === 'deepseek_api' || !payload.source) {
      secretstore.del('deepseek-router:apiKey');
    }
    const dsKeyNow = secretstore.get('autobot.autoswitch.deepseek_key') || secretstore.get('deepseek-router:apiKey') || '';
    const nextSettings = store.setSettings({
      autoSwitch: { source, defaultForNewSessions: Boolean(prevSw.defaultForNewSessions) },
      autoRouter: {
        hasKey: Boolean(dsKeyNow),
        keyHint: dsKeyNow ? '••••' + String(dsKeyNow).slice(-4) : '',
        model: prevAr.model || 'deepseek-v4-flash',
        baseURL: prevAr.baseURL || 'https://api.deepseek.com/v1',
      },
    });
    return buildAutoRouterSnapshot(tr, nextSettings);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('autobot:autoRouterTest', async (e, payload = {}) => {
  try {
    const tr = require('../task-router');
    const settings = store.getSettings ? store.getSettings() : {};
    const prevSw = (settings && settings.autoSwitch) || {};
    const prevAr = (settings && settings.autoRouter) || {};
    const source = tr.AUTO_SWITCH_SOURCES[payload.source] ? payload.source : (prevSw.source || 'openrouter_free');
    const spec = tr.AUTO_SWITCH_SOURCES[source];

    const passedKey = (typeof payload.apiKey === 'string' && !payload.apiKey.startsWith('••••')) ? payload.apiKey.trim() : '';
    const storedKey = secretstore.get(spec.secretKey) || (spec.legacySecretKey ? secretstore.get(spec.legacySecretKey) : '') || '';
    const apiKey = passedKey || storedKey || '';
    const model = source === 'deepseek_api'
      ? (String(payload.model || prevAr.model || spec.model).trim() || spec.model)
      : spec.model;
    const baseURL = source === 'deepseek_api'
      ? (String(payload.baseURL || prevAr.baseURL || spec.baseURL).trim() || spec.baseURL)
      : spec.baseURL;
    return await tr.pingDeepSeekDispatcher({ apiKey, source, baseURL, model });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---- Orchestrator Paid & Custom API-Key Providers Manager ----
function buildOrchPaidProvidersSnapshot() {
  const orchRouter = require('../orch-router');
  const settings = store.getSettings ? (store.getSettings() || {}) : {};
  const savedList = Array.isArray(settings.orchPaidProviders) ? settings.orchPaidProviders : [];
  const savedById = new Map();
  for (const item of savedList) {
    if (item && item.id) savedById.set(String(item.id), item);
  }
  const merged = [];
  const seen = new Set();
  for (const preset of orchRouter.ORCH_PAID_API_PRESETS) {
    seen.add(preset.id);
    const saved = savedById.get(preset.id);
    const baseURL = String((saved && saved.baseURL) || preset.baseURL || '').trim();
    const models = (saved && Array.isArray(saved.models) && saved.models.length)
      ? saved.models
      : preset.models;
    const key = orchRouter.resolvePaidProviderApiKey({ orchProviderId: preset.id, baseURL }, { settings, secretstore });
    merged.push({
      id: preset.id,
      name: (saved && saved.name) || preset.name,
      baseURL,
      docsUrl: preset.docsUrl || '',
      editableBaseUrl: true,
      custom: false,
      models: models.map((m) => ({
        id: String(m.id || m.model || m).trim(),
        label: String(m.label || m.id || m.model || m).trim(),
        tier: m.tier || 'heavy',
        contextWindow: Number(m.contextWindow) || 0,
      })).filter((m) => m.id),
      hasKey: Boolean(key),
      keyHint: key ? '••••' + String(key).slice(-4) : '',
    });
  }
  for (const saved of savedList) {
    if (!saved || !saved.id || seen.has(saved.id)) continue;
    const baseURL = String(saved.baseURL || '').trim();
    const key = orchRouter.resolvePaidProviderApiKey({ orchProviderId: saved.id, baseURL }, { settings, secretstore });
    merged.push({
      id: String(saved.id),
      name: String(saved.name || saved.id),
      baseURL,
      docsUrl: saved.docsUrl || '',
      editableBaseUrl: true,
      custom: true,
      models: (Array.isArray(saved.models) ? saved.models : []).map((m) => ({
        id: String(m.id || m.model || m).trim(),
        label: String(m.label || m.id || m.model || m).trim(),
        tier: m.tier || 'heavy',
        contextWindow: Number(m.contextWindow) || 0,
      })).filter((m) => m.id),
      hasKey: Boolean(key),
      keyHint: key ? '••••' + String(key).slice(-4) : '',
    });
  }
  return { ok: true, providers: merged };
}

function makeOrchRowId(baseURL, model) {
  const nb = require('../orch-router').normBase(baseURL);
  return 'gw|' + nb + '|' + String(model || '').trim();
}

ipcMain.handle('autobot:orchPaidProvidersGet', () => {
  try {
    return buildOrchPaidProvidersSnapshot();
  } catch (err) {
    return { ok: false, providers: [], error: oneLine(err) };
  }
});

ipcMain.handle('autobot:orchPaidProviderSave', (e, payload = {}) => {
  try {
    const orchRouter = require('../orch-router');
    const idRaw = String(payload.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '');
    const id = idRaw || ('custom-' + Date.now().toString(36));
    const preset = orchRouter.ORCH_PAID_API_PRESETS.find((p) => p.id === id);
    const settings = store.getSettings ? (store.getSettings() || {}) : {};
    const savedList = Array.isArray(settings.orchPaidProviders) ? settings.orchPaidProviders.slice() : [];
    const existingIdx = savedList.findIndex((p) => p && p.id === id);
    const existing = existingIdx >= 0 ? savedList[existingIdx] : null;

    const name = String(payload.name || (existing && existing.name) || (preset && preset.name) || id).trim();
    const baseURL = String(payload.baseURL || (existing && existing.baseURL) || (preset && preset.baseURL) || '').trim().replace(/\/+$/, '');
    if (!baseURL || !/^https?:\/\//i.test(baseURL)) {
      return { ok: false, error: 'Valid Base URL starting with http:// or https:// is required' };
    }
    const nb = orchRouter.normBase(baseURL);

    let models = Array.isArray(payload.models)
      ? payload.models
      : ((existing && Array.isArray(existing.models) && existing.models.length) ? existing.models : (preset ? preset.models : []));
    models = models.map((m) => ({
      id: String(m.id || m.model || m).trim(),
      label: String(m.label || m.id || m.model || m).trim(),
      tier: ['small', 'heavy', 'critical'].includes(m.tier) ? m.tier : 'heavy',
      contextWindow: Number(m.contextWindow) || 0,
    })).filter((m) => m.id);

    const nextKeysMap = { ...(settings.providerKeys || {}) };
    if (payload.clearKey) {
      try { secretstore.del('autobot.orch_api_key.' + id); } catch (_) {}
      try { secretstore.del('autobot.orch_base_key.' + nb); } catch (_) {}
      for (const k of Object.keys(nextKeysMap)) {
        if (orchRouter.normBase(k) === nb) delete nextKeysMap[k];
      }
      if (existing && existing.baseURL) {
        const oldNb = orchRouter.normBase(existing.baseURL);
        if (oldNb && oldNb !== nb) {
          try { secretstore.del('autobot.orch_base_key.' + oldNb); } catch (_) {}
        }
      }
    } else if (typeof payload.apiKey === 'string') {
      const k = payload.apiKey.trim();
      if (k && !k.startsWith('••••')) {
        secretstore.set('autobot.orch_api_key.' + id, k);
        secretstore.set('autobot.orch_base_key.' + nb, k);
        nextKeysMap[nb] = k;
      }
    }

    const record = {
      id,
      name,
      baseURL,
      custom: !preset,
      models,
    };
    if (existingIdx >= 0) savedList[existingIdx] = record;
    else savedList.push(record);
    store.setSettings({ orchPaidProviders: savedList, providerKeys: nextKeysMap });

    let orchestrator = store.getOrchestrator ? (store.getOrchestrator() || { enabled: false, providers: [], activeIndex: -1 }) : null;
    if (orchestrator && payload.clearKey) {
      const filtered = (orchestrator.providers || []).filter((r) => !(r && !r.oauthProvider && (r.orchProviderId === id || orchRouter.normBase(r.baseURL) === nb)));
      let ai = Number(orchestrator.activeIndex);
      if (!filtered.length) ai = -1;
      else if (!Number.isFinite(ai) || ai < 0 || ai >= filtered.length) ai = 0;
      orchestrator = store.setOrchestrator({ ...orchestrator, providers: filtered, activeIndex: ai });
      poolNoticeDeduper.reset();
    } else if (orchestrator && Array.isArray(payload.autoAddModels) && payload.autoAddModels.length) {
      const cur = Array.isArray(orchestrator.providers) ? orchestrator.providers.slice() : [];
      for (const m of payload.autoAddModels) {
        const mid = String(m.id || m.model || m).trim();
        if (!mid) continue;
        const rowId = makeOrchRowId(baseURL, mid);
        if (cur.some((r) => r && (r.id === rowId || (!r.oauthProvider && orchRouter.normBase(r.baseURL) === nb && r.model === mid)))) {
          continue;
        }
        cur.push({
          id: rowId,
          name: name + ' · ' + (m.label || mid),
          baseURL,
          apiKey: '',
          orchProviderId: id,
          model: mid,
          tier: ['small', 'heavy', 'critical'].includes(m.tier) ? m.tier : 'heavy',
          oauth: false,
          oauthProvider: '',
          transport: '',
          contextWindow: Number(m.contextWindow) || 0,
        });
      }
      const ai = Number(orchestrator.activeIndex) >= 0 && Number(orchestrator.activeIndex) < cur.length ? orchestrator.activeIndex : (cur.length ? 0 : -1);
      orchestrator = store.setOrchestrator({ ...orchestrator, enabled: true, providers: cur, activeIndex: ai });
      poolNoticeDeduper.reset();
    }

    const snap = buildOrchPaidProvidersSnapshot();
    return { ...snap, orchestrator, savedId: id };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});

ipcMain.handle('autobot:orchPaidProviderDelete', (e, payload = {}) => {
  try {
    const orchRouter = require('../orch-router');
    const id = String(payload.id || '').trim();
    if (!id) return { ok: false, error: 'Provider id is required' };
    const settings = store.getSettings ? (store.getSettings() || {}) : {};
    const savedList = Array.isArray(settings.orchPaidProviders) ? settings.orchPaidProviders : [];
    const target = savedList.find((p) => p && p.id === id);
    const nb = target && target.baseURL ? orchRouter.normBase(target.baseURL) : '';
    try { secretstore.del('autobot.orch_api_key.' + id); } catch (_) {}
    if (nb) try { secretstore.del('autobot.orch_base_key.' + nb); } catch (_) {}
    const nextList = savedList.filter((p) => p && p.id !== id);
    const nextKeysMap = { ...(settings.providerKeys || {}) };
    if (nb) {
      for (const k of Object.keys(nextKeysMap)) {
        if (orchRouter.normBase(k) === nb) delete nextKeysMap[k];
      }
    }
    store.setSettings({ orchPaidProviders: nextList, providerKeys: nextKeysMap });

    let orchestrator = store.getOrchestrator ? (store.getOrchestrator() || { enabled: false, providers: [], activeIndex: -1 }) : null;
    if (orchestrator) {
      const filtered = (orchestrator.providers || []).filter((r) => !(r && !r.oauthProvider && (r.orchProviderId === id || (nb && orchRouter.normBase(r.baseURL) === nb))));
      let ai = Number(orchestrator.activeIndex);
      if (!filtered.length) ai = -1;
      else if (!Number.isFinite(ai) || ai < 0 || ai >= filtered.length) ai = 0;
      orchestrator = store.setOrchestrator({ ...orchestrator, providers: filtered, activeIndex: ai });
      poolNoticeDeduper.reset();
    }
    return { ...buildOrchPaidProvidersSnapshot(), orchestrator };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});

ipcMain.handle('autobot:orchPaidProviderFetchModels', async (e, payload = {}) => {
  try {
    const orchRouter = require('../orch-router');
    const id = String(payload.id || '').trim();
    const settings = store.getSettings ? (store.getSettings() || {}) : {};
    const savedList = Array.isArray(settings.orchPaidProviders) ? settings.orchPaidProviders : [];
    const existing = savedList.find((p) => p && p.id === id);
    const preset = orchRouter.ORCH_PAID_API_PRESETS.find((p) => p.id === id);
    const baseURL = String(payload.baseURL || (existing && existing.baseURL) || (preset && preset.baseURL) || '').trim().replace(/\/+$/, '');
    if (!baseURL || !/^https?:\/\//i.test(baseURL)) {
      return { ok: false, error: 'Valid Base URL is required before fetching models' };
    }
    const draftKey = (typeof payload.apiKey === 'string' && !payload.apiKey.startsWith('••••')) ? payload.apiKey.trim() : '';
    const apiKey = draftKey || orchRouter.resolvePaidProviderApiKey({ orchProviderId: id, baseURL }, { settings, secretstore });
    if (!apiKey && !/^https?:\/\/(localhost|127\.0\.0\.1)\b/i.test(baseURL)) {
      return { ok: false, error: 'Enter or save an API key first to fetch models' };
    }
    const headers = { Accept: 'application/json' };
    if (apiKey) {
      if (/anthropic\.com/i.test(baseURL)) {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers.Authorization = 'Bearer ' + apiKey;
      }
    }
    if (/openrouter\.ai/i.test(baseURL)) {
      headers['HTTP-Referer'] = 'https://akronlogic.com';
      headers['X-Title'] = 'Akron Code';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let data = null;
    try {
      const resp = await fetch(baseURL + '/models', { headers, signal: ctrl.signal });
      const text = await resp.text();
      if (!resp.ok) {
        return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 160)}` };
      }
      data = JSON.parse(text);
    } finally {
      clearTimeout(timer);
    }
    const rawArr = Array.isArray(data && data.data) ? data.data : (Array.isArray(data && data.models) ? data.models : []);
    const inferTier = (mid) => {
      const s = String(mid || '').toLowerCase();
      if (/(haiku|flash|mini|nano|8b|7b|air|instant|lite)/.test(s)) return 'small';
      if (/(opus|reasoner|r1\b|o[134]\b|pro|ultra|480b|glm-5|gpt-5|grok-4|large)/.test(s)) return 'critical';
      return 'heavy';
    };
    const seenM = new Set();
    const models = [];
    for (const item of rawArr) {
      const mid = String((item && (item.id || item.name || item.model)) || item || '').trim();
      if (!mid || seenM.has(mid)) continue;
      if (/(embed|embedding|whisper|tts|moderation|rerank)/i.test(mid)) continue;
      seenM.add(mid);
      models.push({
        id: mid,
        label: String((item && (item.display_name || item.name)) || mid).trim(),
        tier: inferTier(mid),
        contextWindow: Number(item && (item.context_length || item.contextWindow || item.max_context_length)) || 0,
      });
      if (models.length >= 200) break;
    }
    if (models.length && id) {
      const nextList = savedList.slice();
      const rec = {
        id,
        name: String(payload.name || (existing && existing.name) || (preset && preset.name) || id),
        baseURL,
        custom: !preset,
        models,
      };
      const idx = nextList.findIndex((p) => p && p.id === id);
      if (idx >= 0) nextList[idx] = rec;
      else nextList.push(rec);
      store.setSettings({ orchPaidProviders: nextList });
    }
    return { ...buildOrchPaidProvidersSnapshot(), models, fetchedCount: models.length };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
});

};