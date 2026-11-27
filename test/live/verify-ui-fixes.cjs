'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('os');

const REPO = path.resolve(__dirname, '../..');
const OUT_DIR = '/tmp/akron-v140-ui';
fs.mkdirSync(OUT_DIR, { recursive: true });

const TINY_PNG_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVQYV2NkYGD4z4AHMP7//x8AF6gH/et7p9wAAAAASUVORK5CYII=';

function registerStubs(wsDir) {
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
  safe('autobot:getVersion', () => ({ version: '1.4.0', app: '1.4.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  const mockSettings = { theme: 'dark', locale: 'en', surfaceFinish: 'emerald-carbon', accentColor: '#10b981', bgPattern: 'carbon-weave', chatWidth: 'antigravity', showTimestamps: true, timestampFormat: 'date-time' };
  safe('autobot:getSettings', () => mockSettings);
  safe('autobot:setSettings', (_e, patch) => Object.assign(mockSettings, patch || {}));
  safe('autobot:getFeatures', () => ({ computerUse: true }));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => []);
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
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [], status: [] }));
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 263 }));
  safe('autobot:extBridgeStatus', () => ({ running: true, port: 8766, extensionConnected: true }));
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
  safe('autobot:envGetState', () => ({ activeId: 'local', label: 'This Computer', status: 'connected' }));
  safe('autobot:envList', () => ({ activeId: 'local', environments: [] }));
  safe('autobot:dbMigrate', () => ({ ok: true }));
  safe('autobot:dbUpsertConv', () => ({ ok: true }));
  safe('autobot:allSessionsHealth', () => []);
  safe('autobot:notify', () => ({ ok: true }));
  safe('autobot:depsStatus', () => ({ ok: true, coreHealthy: 7, coreTotal: 7, deps: [], lsps: [] }));
  safe('autobot:runtimes', () => ({ autoUpdate: true, items: [] }));
  safe('autobot:updateCheck', () => ({ ok: true, currentVersion: '1.4.0', latestVersion: '1.4.0', upToDate: true }));
  safe('autobot:notificationsGet', () => ({ enabled: true }));
  safe('autobot:listPlugins', () => []);
  safe('autobot:pluginCategories', () => []);
  safe('autobot:pluginStats', () => ({ total: 0, installed: 0, enabled: 0 }));
  safe('autobot:registryStatus', () => ({ synced: true, count: 0 }));
  safe('autobot:listAgentDefs', () => []);
  safe('autobot:listOutputStyles', () => ({ defaultStyleId: '', styles: [] }));
  safe('autobot:searchFiles', () => ({ ok: true, files: ['server.js', 'index.html', 'README.md'] }));
  safe('autobot:searchAll', () => ({ ok: true, matches: [] }));
  safe('autobot:diagnosticsSummary', () => ({ appVersion: '1.4.0' }));
  safe('autobot:browserRegister', () => ({ ok: true }));
  safe('autobot:browserUnregister', () => ({ ok: true }));
  safe('autobot:browserSyncTabs', () => ({ ok: true }));
  safe('autobot:browserScreenshot', () => ({ ok: true, path: path.join(OUT_DIR, 'mock-page.png'), dataUrl: TINY_PNG_URL, width: 800, height: 520 }));
  safe('autobot:browserCaptureElement', () => ({ ok: true, dataUrl: TINY_PNG_URL, width: 220, height: 140 }));
  safe('autobot:devServerDetect', () => ({ ok: true, hasScript: false, running: false }));
}

async function run() {
  const wsDir = path.join(os.tmpdir(), 'akron-v140-ws');
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'server.js'), 'console.log("ok");\n');
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# Sample Workspace\n');

  registerStubs(wsDir);

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
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
  const seedConvs = [
    {
      id: 'conv_ui_test',
      title: 'make a super beautifull live site',
      cwd: wsDir,
      ts: now - 60000,
      updatedAt: now - 60000,
      swarmInfo: { phase: 'reviewing', supervisor: 'gemini-4-carbon-high', board: [{ id: 1 }, { id: 2 }] },
      subAgents: [
        { id: 'sup1', name: 'Supervisor · @supervisor', role: 'supervisor', jobRole: 'planner', model: 'gemini-4-carbon-high', status: 'running' },
        { id: 'w1', name: 'Count lines in server.js', role: 'worker', jobRole: 'coder', model: 'claude-sonnet-4-6', status: 'done' },
        { id: 'w2', name: 'Verify API endpoints', role: 'worker', jobRole: 'coder', model: 'gpt-5.6-terra', status: 'done' },
      ],
      messages: [
        { id: 'u1', role: 'user', ts: now - 55000, content: 'test again' },
        {
          id: 'a1',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          autoRouted: { role: 'coder', tier: 4, reason: 'Code implementation' },
          durationMs: 54000,
          ts: now - 45000,
          content: 'Verified **IDE Agent Dock** wrapping, **Sidebar Menu** icons, **Built-in Browser Screenshot**, and **Narrow-Pane Model Badge**.',
        },
      ],
    },
  ];

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['conv_ui_test']))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_ui_test'))});
    localStorage.setItem('autobot:projects', ${JSON.stringify(JSON.stringify([{ name: 'akron-v140-ws', cwd: wsDir }]))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));

  // 1. Left sidebar conversation context menu + assert icons & zero hover card overlap
  await win.webContents.executeJavaScript(`(() => {
    const trig = document.querySelector('.conv-menu-trigger');
    if (trig) trig.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const menuCheck = await win.webContents.executeJavaScript(`(() => {
    const pop = document.querySelector('.conv-menu-pop');
    const btns = pop ? [...pop.querySelectorAll('button')] : [];
    const iconsCount = btns.filter((b) => !!b.querySelector('.icon')).length;
    const hoverCard = document.querySelector('[data-testid="proj-hover-card"]');
    return {
      menuOpen: !!pop,
      btnTexts: btns.map((b) => b.textContent.trim()),
      iconsCount,
      hoverVisible: !!hoverCard,
    };
  })()`);
  console.log('SIDEBAR_MENU_CHECK:', JSON.stringify(menuCheck));
  assert.strictEqual(menuCheck.menuOpen, true);
  assert.strictEqual(menuCheck.iconsCount, menuCheck.btnTexts.length, 'Every conv menu item must have an icon');
  assert.strictEqual(menuCheck.hoverVisible, false, 'Hover card must stay hidden while menu is open');
  fs.writeFileSync(path.join(OUT_DIR, 'sidebar-menu-icons.png'), (await win.webContents.capturePage()).toPNG());

  // 2. Test inline rename (click Rename... -> edit value visible)
  await win.webContents.executeJavaScript(`(() => {
    const ren = [...document.querySelectorAll('.conv-menu-pop button')].find((b) => b.textContent.includes('Rename'));
    if (ren) ren.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const renameVisible = await win.webContents.executeJavaScript(`!!document.querySelector('[data-testid="conv-rename-input"]')`);
  assert.strictEqual(renameVisible, true, 'Inline rename input must appear without window.prompt');
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.querySelector('[data-testid="conv-rename-input"]');
    if (inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);

  // 3. Open Built-in Browser pane -> verify Screenshot button -> click it -> check attachment & narrow-pane model badge!
  await win.webContents.executeJavaScript(`(() => {
    const bBtn = document.querySelector('button[title="Browser"]')
      || [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Browser');
    if (bBtn) bBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript(`(() => {
    const sb = document.querySelector('[data-testid="browser-screenshot-btn"]');
    if (sb) sb.click();
  })()`);
  await new Promise((r) => setTimeout(r, 400));
  const browserAndBadgeCheck = await win.webContents.executeJavaScript(`(() => {
    const shotBtn = document.querySelector('[data-testid="browser-screenshot-btn"]');
    const toast = document.querySelector('[data-testid="browser-shot-toast"]');
    const chips = [...document.querySelectorAll('.attachment-chip, .composer-att, .att-item')].map((el) => el.textContent.trim());
    const chat = document.querySelector('.chat');
    const meta = document.querySelector('.response-actions-meta');
    const modelName = document.querySelector('.response-model-name');
    const tsEl = document.querySelector('.response-actions-meta .msg-timestamp');
    const chatRect = chat ? chat.getBoundingClientRect() : null;
    const metaRect = meta ? meta.getBoundingClientRect() : null;
    const nameRect = modelName ? modelName.getBoundingClientRect() : null;
    const tsRect = tsEl ? tsEl.getBoundingClientRect() : null;
    return {
      hasShotBtn: !!shotBtn,
      hasShotToast: !!toast,
      chipsCount: chips.length,
      modelText: modelName ? modelName.textContent.trim() : '',
      modelNameWidth: nameRect ? Math.round(nameRect.width) : 0,
      metaWithinChat: !!(chatRect && metaRect && metaRect.right <= chatRect.right + 2),
      timestampNotClipped: !!(chatRect && tsRect && tsRect.right <= chatRect.right + 2),
    };
  })()`);
  console.log('BROWSER_AND_NARROW_BADGE_CHECK:', JSON.stringify(browserAndBadgeCheck));
  assert.strictEqual(browserAndBadgeCheck.hasShotBtn, true, 'Browser toolbar must expose Screenshot button');
  assert.strictEqual(browserAndBadgeCheck.hasShotToast, true, 'Screenshot capture must show confirmation toast');
  assert.ok(browserAndBadgeCheck.modelNameWidth >= 50, 'Model name inside narrow chat column must not collapse to 0px');
  assert.strictEqual(browserAndBadgeCheck.metaWithinChat, true, 'Response metadata badge must stay within narrow chat column');
  assert.strictEqual(browserAndBadgeCheck.timestampNotClipped, true, 'Timestamp must not be clipped on right edge');
  fs.writeFileSync(path.join(OUT_DIR, 'browser-screenshot-and-narrow-badge.png'), (await win.webContents.capturePage()).toPNG());

  // 4. Switch to IDE mode, inject Swarm Mission Control into live state and check IDE dock geometry
  await win.webContents.executeJavaScript(`(() => {
    const ideBtn = [...document.querySelectorAll('.ws-mode-btn')].find((b) => b.textContent.includes('IDE'));
    if (ideBtn) ideBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  win.webContents.send('autobot:event', { type: 'swarm', phase: 'reviewing', supervisor: 'gemini-4-carbon-high', workers: [] });
  win.webContents.send('autobot:event', { type: 'subagent', id: 'sup1', name: 'Supervisor · @supervisor', role: 'supervisor', jobRole: 'planner', model: 'gemini-4-carbon-high', status: 'working' });
  win.webContents.send('autobot:event', { type: 'subagent', id: 'w1', name: 'Count lines in server.js', role: 'worker', jobRole: 'coder', model: 'claude-sonnet-4-6', status: 'done' });
  await new Promise((r) => setTimeout(r, 500));

  const ideCheck = await win.webContents.executeJavaScript(`(() => {
    const dock = document.querySelector('.ide-agent-dock');
    const body = document.querySelector('.ide-dock-body');
    const mc = document.querySelector('.ide-dock-body .mc-panel');
    const chat = document.querySelector('.ide-dock-body .chat');
    const openPane = document.querySelector('.ide-dock-body .mc-open-pane');
    const dockRect = dock ? dock.getBoundingClientRect() : null;
    const mcRect = mc ? mc.getBoundingClientRect() : null;
    const openRect = openPane ? openPane.getBoundingClientRect() : null;
    const chatPadL = chat ? getComputedStyle(chat).paddingLeft : '';
    return {
      dockWidth: dockRect ? Math.round(dockRect.width) : 0,
      mcWidth: mcRect ? Math.round(mcRect.width) : 0,
      chatPadL,
      mcFitsInsideDock: !!(dockRect && mcRect && mcRect.right <= dockRect.right + 2),
      detailsBtnVisibleInsideDock: !!(dockRect && openRect && openRect.right <= dockRect.right + 2),
      dockHorizontalOverflow: body ? body.scrollWidth > body.clientWidth + 2 : false,
    };
  })()`);
  console.log('IDE_DOCK_CHECK:', JSON.stringify(ideCheck));
  assert.strictEqual(ideCheck.chatPadL, '12px', 'IDE dock chat horizontal padding must be 12px');
  assert.strictEqual(ideCheck.mcFitsInsideDock, true, 'Mission Control card must not clip outside IDE dock');
  assert.strictEqual(ideCheck.detailsBtnVisibleInsideDock, true, 'Details -> button must fit inside IDE dock');
  assert.strictEqual(ideCheck.dockHorizontalOverflow, false, 'IDE dock body must not overflow horizontally');
  fs.writeFileSync(path.join(OUT_DIR, 'ide-dock-fixed.png'), (await win.webContents.capturePage()).toPNG());

  assert.strictEqual(pageErrors.length, 0, 'Page errors: ' + pageErrors.join('; '));
  console.log('UI_FIXES_E2E_OK screenshots in', OUT_DIR);
  try { win.destroy(); } catch (_) {}
  fs.rmSync(wsDir, { recursive: true, force: true });
  process.exit(0);
}

app.whenReady().then(run).catch((e) => { console.error(e); process.exit(1); });
