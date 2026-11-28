'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const ARTIFACTS = (process.env.AKRON_ARTIFACTS_DIR || os.tmpdir());

async function run() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    show: false,
    backgroundColor: '#131316',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };
  const git = require('../../electron/git');
  safe('autobot:getVersion', () => ({ app: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  safe('autobot:getSettings', () => ({ theme: 'dark', locale: 'en', provider: { model: 'claude-sonnet-5-5', baseURL: 'http://127.0.0.1:3001/v1' } }));
  safe('autobot:setSettings', (_e, p) => p || {});
  safe('autobot:getFeatures', () => ({}));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => []);
  safe('autobot:getOrchestrator', () => ({ enabled: true, providers: [] }));
  safe('autobot:poolsPreset', () => ({ enabled: false, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [] } }));
  safe('autobot:freellmStatus', () => ({ running: true }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [], status: [] }));
  safe('autobot:extBridgeStatus', () => ({ running: true, port: 8766, extensionConnected: true, extensionVersion: '1.6.7', connectedClients: 1, tabs: [] }));
  safe('autobot:serverInfo', () => ({ port: 8766, url: 'http://127.0.0.1:8766', wsUrl: 'ws://127.0.0.1:8766', platform: process.platform, arch: process.arch, pid: process.pid, extensionConnected: true, connectedClients: 1 }));
  safe('autobot:worktreeList', (_e, cwd) => git.listWorktrees(cwd || REPO));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 263 }));
  safe('autobot:gitInfo', (_e, cwd) => git.gitInfo(cwd || REPO));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => REPO);
  safe('autobot:getWorkspace', () => REPO);
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false, detectedLocalFolders: [] }));
  safe('autobot:oauthStatus', () => ({ providers: [], total: 0 }));
  safe('autobot:checkpointsList', () => []);
  safe('autobot:checkpointsDiff', () => ({ ok: true, files: [] }));
  safe('autobot:pluginStats', () => ({ total: 18, installed: 4, enabled: 4 }));
  safe('autobot:pluginCategories', () => []);
  safe('autobot:listPlugins', () => []);
  safe('autobot:ollamaModels', () => ({ ok: true, models: [] }));
  safe('autobot:tokenBudget', () => ({ ok: true, capTokens: 20000, activeTokens: 1200, demotedCount: 0, demotedItems: [] }));

  const seedConvs = [
    {
      id: 'conv_oc_1',
      title: 'OpenCode Architecture & UI',
      ts: Date.now() - 120000,
      messages: [
        { id: 'u1', role: 'user', content: 'Review typography, spacing, and DeepSeek Harness prompt cache stability.' },
        {
          id: 'a1',
          role: 'assistant',
          content: '### Summary\n\n- Crisp sans-serif UI typography (`AnthropicInterface` / `Inter` / `Segoe UI`) across headings and markdown.\n- Obsidian `#131316` canvas with clean `1.66` line height.\n- Top multi-session workspace tab bar enabled alongside full-surface OpenCode Settings (`← Back to app`).',
          durationMs: 1450,
          tools: [
            { id: 't1', name: 'Read', args: { path: 'src/styles.css' }, status: 'done', result: 'Read styles.css' },
            { id: 't2', name: 'Edit', args: { path: 'src/App.jsx' }, status: 'done', result: 'Updated Settings & Tabs' },
          ],
        },
      ],
    },
    {
      id: 'conv_oc_2',
      title: 'Native Win32 C++20 Build',
      ts: Date.now() - 60000,
      messages: [
        { id: 'u2', role: 'user', content: 'Compile AkronCode.exe and AkronCode-Setup.exe for Windows 11 ARM64.' },
        { id: 'a2', role: 'assistant', content: 'Compiled `AkronCode.exe` with Edge WebView2 and Win32 dark titlebar + Job Object supervision.', durationMs: 920 },
      ],
    },
  ];

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['conv_oc_1', 'conv_oc_2']))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_oc_1'))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));

  const mainStats = await win.webContents.executeJavaScript(`(() => {
    const tabs = [...document.querySelectorAll('.ws-tab .ws-tab-label')].map(e => e.textContent);
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const h3 = document.querySelector('.md h3');
    const h3Font = h3 ? getComputedStyle(h3).fontFamily : '';
    const mdLh = document.querySelector('.md') ? getComputedStyle(document.querySelector('.md')).lineHeight : '';
    return { tabs, bodyBg, h3Font, mdLh };
  })()`);
  console.log('MAIN_UI_STATS:', JSON.stringify(mainStats));
  assert.strictEqual(mainStats.tabs.length, 2, 'Expected 2 workspace tabs in top bar');
  assert.ok(!mainStats.h3Font.includes('AnthropicSerif'), 'Headings must use crisp sans-serif, not Serif');

  const chatShot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'akron-code-opencode-chat.png'), chatShot.toPNG());

  // Open full-surface Settings and navigate to Notifications
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.sidebar-foot button, button')].find(b => (b.textContent || '').trim().startsWith('Settings'));
    if (btn) btn.click();
    else if (window.__akronTestHarness && window.__akronTestHarness.openSettings) window.__akronTestHarness.openSettings('notifications');
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`(() => {
    const navBtn = [...document.querySelectorAll('.settings-nav-btn')].find(b => /Notifications/i.test(b.textContent || ''));
    if (!navBtn) throw new Error('Notifications section missing in Settings');
    navBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));

  const notifCheck = await win.webContents.executeJavaScript(`(() => {
    const full = !!document.querySelector('.modal-overlay.settings-fullscreen');
    const backBtn = document.querySelector('.settings-back-btn')?.textContent?.trim() || '';
    const switches = document.querySelectorAll('.oc-switch').length;
    const selects = document.querySelectorAll('.oc-select').length;
    const verFoot = document.querySelector('.settings-side-foot')?.textContent || '';
    return { full, backBtn, switches, selects, verFoot };
  })()`);
  console.log('SETTINGS_NOTIF_CHECK:', JSON.stringify(notifCheck));
  assert.strictEqual(notifCheck.full, true, 'Expected OpenCode full-surface Settings overlay');
  assert.ok(notifCheck.backBtn.includes('Back to app'), 'Expected Back to app button');
  assert.ok(notifCheck.switches >= 4, 'Expected at least 4 Desktop notification pill switches');
  assert.strictEqual(notifCheck.selects, 4, 'Expected 4 Sound effect preset dropdowns');
  assert.ok(notifCheck.verFoot.includes('Akron Code v1.2'), 'Expected Akron Code v1.2 footer');

  const settingsShot = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'akron-code-opencode-settings.png'), settingsShot.toPNG());

  // Check Worktrees, Shortcuts, and Server & Pairing panels
  for (const label of ['Worktrees', 'Shortcuts', 'Server & Pairing']) {
    const ok = await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.settings-nav-btn')].find(b => b.textContent.includes(${JSON.stringify(label)}));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    assert.strictEqual(ok, true, `Expected ${label} nav button`);
    await new Promise((r) => setTimeout(r, 150));
  }

  console.log('OPENCODE_DESIGN_E2E_OK');
  win.destroy();
  app.exit(0);
}

app.whenReady().then(run).catch((err) => {
  console.error('OPENCODE_DESIGN_E2E_FAILED:', err);
  app.exit(1);
});
