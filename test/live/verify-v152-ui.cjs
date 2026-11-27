'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const os = require('os');

const REPO = path.resolve(__dirname, '../..');
const PKG_VER = require(path.join(REPO, 'package.json')).version || '1.5.2';

async function run() {
  const wsDir = path.join(os.tmpdir(), 'akron-v152-ws');
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });
  const mdContent = [
    '# Lovable Events Free Credits Report',
    '',
    'Full summary of **109 upcoming events** (Nov 2026 -> Apr 2027).',
    '',
    '- RSVP at community.lovable.app/events',
    '- Bonus mirror at https://example.org/events',
  ].join('\n');
  const mdPath = path.join(wsDir, 'lovable-events-free-credits-report.md');
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  const webSrv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<html><head><title>Akron Browser Link OK</title></head><body><h1>Loaded ${req.url}</h1></body></html>`);
  });
  await new Promise((r) => webSrv.listen(0, '127.0.0.1', r));
  const localWebUrl = `http://127.0.0.1:${webSrv.address().port}/events`;

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
  safe('autobot:getFeatures', () => ({ computerUse: true, chrome: true, bridges: false, extensions: true, developerMode: true, trustedFolders: true }));
  safe('autobot:setFeatures', (_e, patch) => patch || {});
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getProjectMemory', () => ({ files: [], text: '' }));
  safe('autobot:getSkills', () => []);
  safe('autobot:getOrchestrator', () => ({ enabled: false, providers: [] }));
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
  safe('autobot:reaStatus', () => ({ available: false, connected: false, toolCount: 0 }));
  safe('autobot:extBridgeStatus', () => ({ running: false, port: 8766, extensionConnected: false, openTabCount: 0 }));
  safe('autobot:serverInfo', () => ({ port: 8766, extensionConnected: false }));
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
  safe('autobot:envGetState', () => ({ active: { kind: 'local', id: null, label: 'This Computer', cwd: wsDir }, sshProfiles: [], sshConfigHosts: [], remoteProfiles: [], hostServer: { enabled: false, port: 0, running: false, url: '' } }));
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
  safe('autobot:searchFiles', () => ({ ok: true, files: ['lovable-events-free-credits-report.md'] }));
  safe('autobot:searchAll', () => ({ ok: true, matches: [] }));
  safe('autobot:diagnosticsSummary', () => ({ appVersion: PKG_VER }));
  safe('autobot:paradevStatus', () => ({ ok: true, configured: false, appInstalled: false }));
  safe('autobot:devServerDetect', () => ({ ok: true, hasScript: false, running: false }));
  safe('autobot:browserSyncTabs', () => ({ ok: true }));
  safe('autobot:browserRegister', () => ({ ok: true }));
  safe('autobot:browserUnregister', () => ({ ok: true }));
  safe('autobot:browserLoadURL', () => ({ ok: true }));
  safe('autobot:turnDiffs', () => [{
    path: mdPath,
    relPath: 'lovable-events-free-credits-report.md',
    status: 'added',
    added: 6,
    removed: 0,
    lines: mdContent.split('\n').map((text, idx) => ({ type: 'add', oldLine: null, newLine: idx + 1, text })),
  }]);
  safe('autobot:gitDiffFiles', () => []);
  safe('autobot:unfurl', () => null);

  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    backgroundColor: '#0b110f',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  const pageErrors = [];
  win.webContents.on('page-error', (e) => pageErrors.push(String(e)));

  const now = Date.now();
  const seedConvs = [{
    id: 'conv_v152_e2e',
    title: 'deep research and find all events for lovable',
    cwd: wsDir,
    ts: now - 30000,
    updatedAt: now - 1000,
    messages: [
      { id: 'u1', role: 'user', content: 'find lovable hackathon credits', ts: now - 20000 },
      {
        id: 'a1',
        role: 'assistant',
        model: 'gemini-4-carbon-medium',
        ts: now - 10000,
        content: [
          'Research complete. Full report saved to `lovable-events-free-credits-report.md` .',
          '',
          `How to claim: RSVP at community.lovable.app/events (or test local link ${localWebUrl} ).`,
        ].join('\n'),
        tools: [{ id: 'w1', name: 'Write', args: { file_path: mdPath, content: mdContent }, status: 'done', result: 'ok' }],
      },
    ],
  }];
  const modelCaps = {
    'gemini-4-carbon-medium': {
      thinking: true,
      thinkingLevels: ['auto', 'low', 'medium', 'high'],
      thinkingVariants: { low: 'gemini-4-carbon-low', medium: 'gemini-4-carbon-medium', high: 'gemini-4-carbon-high' },
    },
    'gemini-4-carbon-high': {
      thinking: true,
      thinkingLevels: ['auto', 'low', 'medium', 'high'],
      thinkingVariants: { low: 'gemini-4-carbon-low', medium: 'gemini-4-carbon-medium', high: 'gemini-4-carbon-high' },
    },
    'gpt-4o-mini': {
      thinking: false,
      thinkingLevels: [],
    },
  };

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['conv_v152_e2e']))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_v152_e2e'))});
    localStorage.setItem('autobot:modelCaps', ${JSON.stringify(JSON.stringify(modelCaps))});
    localStorage.setItem('autobot:provider', ${JSON.stringify(JSON.stringify({ model: 'gemini-4-carbon-medium', oauthProvider: 'antigravity:test', transport: 'google', routingMode: 'direct', reasoningLevel: 'medium', supportsTools: true }))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  for (let i = 0; i < 35; i++) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.md-file-chip') && document.querySelector('.reason-pick'))`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  // 1. Verify inline `.md` chip click opens DocPreviewPane and renders Markdown!
  const chipInfo = await win.webContents.executeJavaScript(`(() => {
    const chip = document.querySelector('.md-file-chip[data-akron-file="lovable-events-free-credits-report.md"]');
    if (!chip) return { found: false };
    chip.click();
    return { found: true, text: chip.textContent };
  })()`);
  assert.strictEqual(chipInfo.found, true, 'lovable-events-free-credits-report.md chip must render clickable');
  await new Promise((r) => setTimeout(r, 500));

  const docState = await win.webContents.executeJavaScript(`({
    hasDocPane: Boolean(document.querySelector('[data-testid="doc-preview-pane"]')),
    docName: document.querySelector('.doc-preview-name')?.textContent?.trim() || '',
    renderedH1: document.querySelector('.doc-preview-md h1')?.textContent?.trim() || '',
    bareLinkHref: document.querySelector('.doc-preview-md a[href*="community.lovable.app/events"]')?.getAttribute('href') || '',
  })`);
  console.log('V152_DOC_PREVIEW:', JSON.stringify(docState));
  assert.strictEqual(docState.hasDocPane, true, 'Clicking .md chip must open DocPreviewPane');
  assert.strictEqual(docState.renderedH1, 'Lovable Events Free Credits Report');
  assert.strictEqual(docState.bareLinkHref, 'https://community.lovable.app/events');

  // 2. Click web link in chat -> must open built-in Browser pane and navigate webview/omnibox to localWebUrl!
  const linkRes = await win.webContents.executeJavaScript(`(() => {
    const a = document.querySelector('.chat a[href="${localWebUrl}"]');
    if (!a) return { found: false };
    a.click();
    return { found: true, href: a.getAttribute('href') };
  })()`);
  assert.strictEqual(linkRes.found, true, 'Web link must exist in chat markdown');
  await new Promise((r) => setTimeout(r, 700));

  const browserState = await win.webContents.executeJavaScript(`({
    hasBrowserPane: Boolean(document.querySelector('.browser-panel')),
    omnibox: document.querySelector('.omnibox input')?.value || '',
    webviewSrc: document.querySelector('.browser-panel webview')?.getAttribute('src') || '',
  })`);
  console.log('V152_BROWSER_ROUTING:', JSON.stringify(browserState));
  assert.strictEqual(browserState.hasBrowserPane, true, 'Clicking web link in chat must open built-in Browser pane');
  assert.ok(browserState.omnibox.includes('/events') || browserState.webviewSrc.includes('/events'), 'Built-in Browser must navigate to clicked URL');

  // 3. Open Review pane via FilesChangedBar .fcb-btn.primary, right-click MD file row for custom menu, click Preview Rendered File!
  const clickedReview = await win.webContents.executeJavaScript(`(() => {
    const rb = document.querySelector('.fcb-btn.primary')
      || [...document.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === 'Review');
    if (rb) { rb.click(); return true; }
    return false;
  })()`);
  assert.strictEqual(clickedReview, true, 'FilesChangedBar Review button must exist');
  await new Promise((r) => setTimeout(r, 500));

  const ctxState = await win.webContents.executeJavaScript(`(() => {
    const head = document.querySelector('.rv-file-head');
    if (!head) return { found: false };
    head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 900, clientY: 220 }));
    return {
      found: true,
      hasPreviewBtn: Boolean(head.querySelector('.rv-file-act')),
    };
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const menuText = await win.webContents.executeJavaScript(`document.querySelector('.rv-ctx-menu')?.innerText?.replace(/\\s+/g, ' ').trim() || ''`);
  console.log('V152_REVIEW_CTX:', JSON.stringify({ ...ctxState, menuText }));
  assert.strictEqual(ctxState.found && ctxState.hasPreviewBtn, true, 'CodeReviewPane must show Preview/Open buttons');
  assert.ok(menuText.includes('Preview Rendered File') && menuText.includes('Open in IDE Editor'), `Custom Review context menu missing items: ${menuText}`);

  // Click Preview Rendered File inside custom context menu
  await win.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.rv-ctx-menu .rv-pop-item')].find((b) => (b.textContent || '').includes('Preview Rendered File'));
    if (item) item.click();
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  const previewReopened = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[data-testid="doc-preview-pane"]'))`);
  assert.strictEqual(previewReopened, true, 'Context menu Preview Rendered File must open DocPreviewPane');

  // 4. Test Composer Thinking adaptive menu: switch gemini-4-carbon-medium -> High auto-switches model to gemini-4-carbon-high!
  await win.webContents.executeJavaScript(`document.querySelector('.reason-pick')?.click()`);
  await new Promise((r) => setTimeout(r, 200));
  await win.webContents.executeJavaScript(`(() => {
    const highOpt = [...document.querySelectorAll('.reason-menu .model-opt')].find((b) => (b.textContent || '').includes('High'));
    if (highOpt) highOpt.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  const switchedProvider = await win.webContents.executeJavaScript(`JSON.parse(localStorage.getItem('autobot:provider') || '{}')`);
  console.log('V152_THINKING_VARIANT_SWITCH:', JSON.stringify(switchedProvider));
  assert.strictEqual(switchedProvider.model, 'gemini-4-carbon-high', 'Selecting High on discrete Antigravity sibling must auto-switch model to gemini-4-carbon-high');

  // Also test non-thinking model shows Thinking N/A (disabled)
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:provider', ${JSON.stringify(JSON.stringify({ model: 'gpt-4o-mini', routingMode: 'direct', supportsTools: true }))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  for (let i = 0; i < 35; i++) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.reason-pick'))`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const nonThinkState = await win.webContents.executeJavaScript(`({
    disabled: Boolean(document.querySelector('.reason-pick')?.disabled),
    val: document.querySelector('.reason-pick .reason-val')?.textContent?.trim() || '',
  })`);
  console.log('V152_NON_THINKING_PILL:', JSON.stringify(nonThinkState));
  assert.strictEqual(nonThinkState.disabled, true);
  assert.strictEqual(nonThinkState.val, 'N/A');

  assert.strictEqual(pageErrors.length, 0, 'Page errors: ' + pageErrors.join('; '));
  console.log('UI_V152_E2E_OK');
  try { win.destroy(); } catch (_) {}
  await new Promise((r) => webSrv.close(() => r()));
  fs.rmSync(wsDir, { recursive: true, force: true });
  process.exit(0);
}

app.whenReady().then(run).catch((e) => { console.error(e); process.exit(1); });
