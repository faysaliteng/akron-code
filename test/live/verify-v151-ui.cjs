'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const REPO = path.resolve(__dirname, '../..');
const PKG_VER = require(path.join(REPO, 'package.json')).version || '1.5.1';
const OUT_DIR = '/tmp/akron-v151-ui';
fs.mkdirSync(OUT_DIR, { recursive: true });

async function run() {
  const wsDir = path.join(os.tmpdir(), 'akron-v151-ws');
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'server.js'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(wsDir, 'CLAUDE.md'), '# Sample Project Memory\nKeep handlers modular.\n');

  const { createRemoteServer } = require(path.join(REPO, 'electron/remote-server'));
  let liveRemoteSrv = null;
  let featState = {
    computerUse: true,
    chrome: true,
    bridges: false,
    quickEntry: true,
    computerUseTeach: false,
    buddy: false,
    remoteControl: false,
    remoteServerEnabled: false,
    extensions: true,
    developerMode: true,
    trustedFolders: true,
  };
  let envState = {
    active: { kind: 'local', id: null, label: 'This Computer', cwd: wsDir },
    sshProfiles: [{ id: 'ssh-linux', name: 'seventrip', host: '192.0.2.10', port: 22, username: 'ubuntu', remoteCwd: '/srv/app' }],
    sshConfigHosts: [],
    remoteProfiles: [],
    hostServer: { enabled: false, port: 0, running: false, url: '' },
  };

  const ideIpc = require(path.join(REPO, 'electron/ide/ipc'));
  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };
  ideIpc.register({
    ipcMain,
    normalizeProvider: (p) => p,
    hydrateProvider: (p) => p,
    hydrateOrchestrator: (o) => o,
    store: { get: () => null, set: () => {} },
    broadcast: () => {},
  });
  safe('autobot:getVersion', () => ({ version: PKG_VER, app: PKG_VER, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  const mockSettings = { theme: 'dark', locale: 'en', surfaceFinish: 'emerald-carbon', accentColor: '#10b981', bgPattern: 'carbon-weave', chatWidth: 'antigravity', showTimestamps: true, timestampFormat: 'date-time' };
  safe('autobot:getSettings', () => mockSettings);
  safe('autobot:setSettings', (_e, patch) => Object.assign(mockSettings, patch || {}));
  safe('autobot:getFeatures', () => ({ ...featState }));
  safe('autobot:setFeatures', (_e, patch) => { featState = { ...featState, ...(patch || {}) }; return featState; });
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getProjectMemory', () => ({ files: [{ file: 'CLAUDE.md', scope: 'project', bytes: 48 }], text: '# Sample Project Memory\nKeep handlers modular.\n' }));
  safe('autobot:getSkills', () => [{ name: 'akron-web-bot', enabled: true }, { name: 'reverse-engineer-anything', enabled: true }]);
  safe('autobot:getOrchestrator', () => ({ enabled: true, providers: [] }));
  safe('autobot:poolsPreset', () => ({ enabled: false, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [] } }));
  safe('autobot:freellmStatus', () => ({ running: false, providers: [] }));
  safe('autobot:freellmProviders', () => []);
  safe('autobot:freellmCatalog', () => ({ chatModels: [], mediaModels: [], embeddingModels: [], webBotProviders: [] }));
  safe('autobot:freellmDetect', () => ({ ok: true, status: { running: false } }));
  safe('autobot:autoRouterGet', () => ({ ok: true, source: 'openrouter_free' }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => [{ serverId: 'paradev-docs', name: 'paradev-docs', tools: ['search_docs'] }]);
  safe('autobot:mcpConfig', () => ({ servers: ['paradev-docs'], status: [{ serverId: 'paradev-docs', name: 'paradev-docs', tools: ['search_docs'] }] }));
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 263 }));
  safe('autobot:extBridgeStatus', () => ({ running: true, port: 8766, extensionConnected: true, openTabCount: 3 }));
  safe('autobot:serverInfo', () => ({ port: 8766, extensionConnected: true }));
  safe('autobot:worktreeList', () => []);
  safe('autobot:gitInfo', () => ({ branch: 'main', clean: true }));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => wsDir);
  safe('autobot:getWorkspace', () => wsDir);
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: {} }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false }));
  safe('autobot:oauthStatus', () => ({ providers: [], total: 0 }));
  safe('autobot:checkpointsList', () => []);
  safe('autobot:checkpointsDiff', () => ({ ok: true, files: [] }));
  safe('autobot:ollamaModels', () => ({ ok: true, models: [] }));
  safe('autobot:getMindmap', () => ({ ok: true, cwd: wsDir, markdown: '# Demo\n' }));
  safe('autobot:envGetState', () => envState);
  safe('autobot:envToggleHostServer', async (_e, enabled) => {
    if (enabled) {
      if (liveRemoteSrv) await liveRemoteSrv.stop();
      const srv = createRemoteServer({ port: 0, host: '127.0.0.1', workspaceRoot: wsDir });
      const info = await srv.start();
      liveRemoteSrv = { stop: () => srv.stop(), ...info };
      envState = { ...envState, hostServer: { enabled: true, running: true, port: info.port, url: info.url } };
      featState = { ...featState, remoteControl: true, remoteServerEnabled: true };
      return { ok: true, running: true, port: info.port, url: info.url, token: info.token, state: envState };
    }
    if (liveRemoteSrv) { await liveRemoteSrv.stop(); liveRemoteSrv = null; }
    envState = { ...envState, hostServer: { enabled: false, running: false, port: 0, url: '' } };
    featState = { ...featState, remoteControl: false, remoteServerEnabled: false };
    return { ok: true, running: false, state: envState };
  });
  safe('autobot:envGetHostToken', () => (liveRemoteSrv ? liveRemoteSrv.token : ''));
  safe('autobot:remoteRelayStatus', () => ({ connected: false, killSwitchActive: false }));
  safe('autobot:envList', () => ({ activeId: 'local', environments: [] }));
  safe('autobot:dbMigrate', () => ({ ok: true }));
  safe('autobot:dbUpsertConv', () => ({ ok: true }));
  safe('autobot:allSessionsHealth', () => []);
  safe('autobot:notify', () => ({ ok: true }));
  safe('autobot:depsStatus', () => ({ ok: true, healthyCount: 7, totalBundled: 7, bundled: [], lspServers: [] }));
  safe('autobot:runtimes', () => ({ autoUpdate: true, items: [] }));
  safe('autobot:updateCheck', () => ({ ok: true, currentVersion: PKG_VER, latestVersion: PKG_VER, updateAvailable: false }));
  safe('autobot:notificationsGet', () => ({ enabled: true }));
  safe('autobot:listPlugins', () => []);
  safe('autobot:pluginCategories', () => []);
  safe('autobot:pluginStats', () => ({ total: 0, installed: 0, enabled: 0 }));
  safe('autobot:registryStatus', () => ({ synced: true, count: 0 }));
  safe('autobot:listAgentDefs', () => []);
  safe('autobot:listOutputStyles', () => ({ defaultStyleId: '', styles: [] }));
  safe('autobot:searchFiles', () => ({ ok: true, files: ['server.js'] }));
  safe('autobot:searchAll', () => ({ ok: true, matches: [] }));
  safe('autobot:diagnosticsSummary', () => ({ appVersion: PKG_VER }));
  safe('autobot:paradevStatus', () => ({ ok: true, configured: false, appInstalled: true, desktopSessionPresent: true, docsMcpUrl: 'https://docs.paradev.com/mcp' }));
  safe('autobot:devServerDetect', () => ({ ok: true, hasScript: false, running: false }));
  safe('autobot:turnDiffs', () => []);
  safe('autobot:gitDiffFiles', () => []);

  const win = new BrowserWindow({
    width: 1320,
    height: 840,
    show: false,
    backgroundColor: '#0b110f',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const pageErrors = [];
  win.webContents.on('page-error', (e) => pageErrors.push(String(e)));

  const now = Date.now();
  const heavyMsgs = Array.from({ length: 42 }, (_, i) => ({
    id: `m-${i}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    model: 'claude-opus-5-5',
    ts: now - (45 - i) * 1000,
    content: (i % 2 === 0
      ? 'Build the full backend, performer directory, live room WebSocket chat, and admin moderation queue. '
      : 'Updated server routes, room views, and moderation actions across 12 modules. ').repeat(12),
  }));
  const seedConvs = [{
    id: 'conv_poisoned_2tok',
    title: 'make a super beautifull adult entertenmaint live',
    cwd: wsDir,
    ts: now - 60000,
    updatedAt: now - 60000,
    messages: heavyMsgs,
  }];
  const poisonedByConv = {
    conv_poisoned_2tok: {
      prompt_tokens: 18,
      completion_tokens: 3330,
      total_tokens: 3348,
      calls: 8,
      context_tokens: 2,
      model: 'claude-opus-5-5',
      convId: 'conv_poisoned_2tok',
      at: now - 1000,
    },
  };

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['conv_poisoned_2tok']))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_poisoned_2tok'))});
    localStorage.setItem('autobot:usageByConv', ${JSON.stringify(JSON.stringify(poisonedByConv))});
    localStorage.setItem('autobot:provider', ${JSON.stringify(JSON.stringify({ model: 'claude-opus-5-5', routingMode: 'auto', supportsTools: true }))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  for (let i = 0; i < 30; i++) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.conv-overview-btn') && document.querySelector('.ctx-pct'))`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const preDiag = await win.webContents.executeJavaScript(`({
    ringPct: document.querySelector('.ctx-pct')?.textContent?.trim() || '',
    hasOverviewBtn: Boolean(document.querySelector('.conv-overview-btn')),
    title: document.title,
    textHead: (document.body.innerText || '').slice(0, 180),
  })`);
  console.log('PRE_DIAG:', JSON.stringify(preDiag), 'pageErrors:', pageErrors);

  // Open Environment panel via Overview popover -> Environment button
  await win.webContents.executeJavaScript(`(() => {
    const ov = document.querySelector('.conv-overview-btn');
    if (ov) ov.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.executeJavaScript(`(() => {
    const envBtn = document.querySelector('button[title="Environment"]')
      || [...document.querySelectorAll('.conv-pop-item')].find((el) => (el.textContent || '').trim() === 'Environment');
    if (envBtn) envBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));

  // Click Remote Control toggle ON inside EnvPanel
  await win.webContents.executeJavaScript(`(() => {
    const t = document.querySelector('[data-testid="env-remote-toggle"]');
    if (t) t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 450));

  // Click What is loaded button inside EnvPanel
  await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('[data-testid="env-loaded-btn"]');
    if (b) b.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  const state = await win.webContents.executeJavaScript(`({
    hasEnvPanel: Boolean(document.querySelector('[data-testid="env-panel"]')),
    ctxTitle: document.querySelector('[data-testid="env-ctx-title"]')?.textContent?.trim() || '',
    ctxSub: document.querySelector('[data-testid="env-ctx-sub"]')?.textContent?.trim() || '',
    ringPct: document.querySelector('.ctx-pct')?.textContent?.trim() || '',
    remoteDetails: document.querySelector('[data-testid="env-remote-details"]')?.textContent?.trim() || '',
    loadedCard: document.querySelector('[data-testid="env-loaded-card"]')?.textContent?.trim() || '',
    connSummary: document.querySelector('[data-testid="env-conn-summary"]')?.textContent?.trim() || '',
  })`);
  console.log('V151_ENV_UI_STATE:', JSON.stringify(state));

  assert.strictEqual(state.hasEnvPanel, true, 'EnvPanel must be visible');
  assert.ok(!/^0%/.test(state.ctxTitle), `Context title must not say 0% on poisoned 2-token heavy chat: ${state.ctxTitle}`);
  assert.ok(!/^2 \/ /.test(state.ctxSub), `Context subtitle must not say 2 / ... on heavy chat: ${state.ctxSub}`);
  assert.strictEqual(state.ctxTitle.replace(/\s*used$/i, ''), state.ringPct, 'EnvPanel title and ring % must match');
  assert.ok(state.remoteDetails.includes('http://127.0.0.1:'), `Remote Control ON must show real HTTP URL: ${state.remoteDetails}`);
  assert.ok(state.loadedCard.includes('42 msgs') && state.loadedCard.includes('263 REA'), `What is loaded must show real breakdown: ${state.loadedCard}`);
  assert.ok(!state.connSummary.includes('0 total') && state.connSummary.includes('active'), `Connectors must list active connectors: ${state.connSummary}`);

  // Verify live HTTP /v1/env/ping against the running server started by clicking the toggle!
  assert.ok(liveRemoteSrv && liveRemoteSrv.url && liveRemoteSrv.token, 'Live Remote Server should be listening');
  const ping = await fetch(`${liveRemoteSrv.url}/v1/env/ping`, {
    headers: { Authorization: `Bearer ${liveRemoteSrv.token}` },
  });
  assert.strictEqual(ping.status, 200);
  console.log('V151_LIVE_REMOTE_PING_STATUS:', ping.status);

  // Capture crisp screenshot for visual verification + docs
  const shotPng = (await win.webContents.capturePage()).toPNG();
  fs.writeFileSync(path.join(OUT_DIR, 'env-panel-live-v151.png'), shotPng);
  fs.writeFileSync(path.join(REPO, 'docs/screenshots/environment-pane-live-v151.png'), shotPng);

  assert.strictEqual(pageErrors.length, 0, 'Page errors: ' + pageErrors.join('; '));
  console.log('UI_V151_E2E_OK');
  if (liveRemoteSrv) try { await liveRemoteSrv.stop(); } catch (_) {}
  try { win.destroy(); } catch (_) {}
  fs.rmSync(wsDir, { recursive: true, force: true });
  process.exit(0);
}

app.whenReady().then(run).catch((e) => { console.error(e); process.exit(1); });
