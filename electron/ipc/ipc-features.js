'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

module.exports = function registerFeaturesIpc(ctx) {
  const {
    app, ipcMain, shell, dialog, BrowserWindow, session,
    store, workspace, mcp, mcpStatus, shells, git, pluginsDir, scheduler, sandbox,
    secretstore, search, sessionDb, environments, depManager, updater, browser,
    gdrive, runAgent, providertransport, permGate, pendingQuestions, windows,
    winFor, cwdFor, winTitleBarOverlay, applyFeatures, runtimePathPrefix,
    hydrateProvider, freellmFallbackApiKey, broadcast, mainWindow, oneLine,
    humanizeLLMError, rea, mcpoauth, freellm, poolNoticeDeduper, sessionlog, paths, describeConnectError,
  } = ctx;
  const authFlights = new Map();

ipcMain.handle('autobot:chatOnce', async (event, payload) => {
  try {
    const { chatOnce } = require('../llm');
    let p = (payload && payload.provider) || store.getSettings().provider || {};
    try { p = await hydrateProvider(p); } catch (e) {
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
    let p = (payload && payload.provider) || store.getSettings().provider || {};
    try { p = await hydrateProvider(p); } catch (e) {
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
  const next = store.setSettings(patch);
  // Launch-at-login is an OS setting, not just a stored flag (Desktop parity:
  // its General pane toggles the login item directly).
  if (patch && Object.prototype.hasOwnProperty.call(patch, 'launchAtLogin')) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, openAsHidden: false });
    } catch (err) { console.error('login item update failed:', err.message); }
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
  try { return require('../agentdefs').discover(cwdFor(cwd)).map((d) => ({ name: d.name, description: d.description, model: d.model || null, tools: d.tools || null, source: d.source })); } catch (_) { return []; }
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
    return {
      ...(activeOutboundRelay ? activeOutboundRelay.status() : { connected: false, relayUrl: '' }),
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
      return { ok: true, ...(activeOutboundRelay ? activeOutboundRelay.status() : { connected: false, relayUrl: '' }) };
    }
    if (activeOutboundRelay) activeOutboundRelay.disconnect('reconfigure');
    activeOutboundRelay = rs.createOutboundRelay({
      relayUrl: relayUrl || '',
      token: token || '',
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
    const dir = require('../extbridge').extensionDir();
    if (!fs.existsSync(dir)) return { ok: false, error: 'Extension folder not found' };
    shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) { return { ok: false, error: e.message }; }
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
    if (!base || !key) return { ok: false, fallback: 'local-whisper' };
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
  return store.setOrchestrator(patch);
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
ipcMain.handle('autobot:setFeatures', (e, patch) => {
  const features = store.setFeatures(patch);
  applyFeatures(features);
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
  return r.filePaths.map((fp) => {
    const name = path.basename(fp);
    let stat = null;
    try { stat = fs.statSync(fp); } catch (_) {}
    const size = stat ? stat.size : 0;
    let content = null;
    let isText = false;
    let isImage = false;
    let dataUrl = null;
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
    } else if (TEXT_EXT.test(name) && size <= MAX_INLINE_BYTES) {
      try {
        const buf = fs.readFileSync(fp);
        if (!buf.includes(0)) { content = buf.toString('utf8'); isText = true; }
      } catch (_) {}
    }
    return { name, path: fp, size, isText, isImage, dataUrl, content };
  });
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
    if (!file) return { ok: false, error: 'filename required' };
    const target = paths.resolvePath(file, cwd || workspace.scratch());
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
ipcMain.handle('autobot:mcpConfig', (e, cwd) => {
  try {
    const c = require('../claudeconfig').loadMcpServers(cwdFor(cwd));
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
ipcMain.handle('autobot:updateApply', (e, stagedPath) => updater.applyUpdate(stagedPath));
ipcMain.handle('autobot:tokenBudget', (e, payload = {}) => {
  try { return require('../token-budget').analyzeCustomizationBudget(payload); } catch (err) { return { error: err.message, items: [] }; }
});
ipcMain.handle('autobot:setPreventSleep', (e, enabled) => require('../app-system').setPreventSleep(enabled));
ipcMain.handle('autobot:browserRulesCheck', (e, payload = {}) => require('../browser-rules').evaluateBrowserUrlRule(payload.url, payload));
ipcMain.handle('autobot:generateDiagnostics', (e, payload = {}) => require('../diagnostics').generateDiagnosticBundle({
  appVersion: app.getVersion(),
  ...(payload || {}),
}));

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
ipcMain.handle('autobot:browserScreenshot', (e, fullPage) => browser.screenshot(fullPage));
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

};