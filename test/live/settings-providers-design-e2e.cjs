'use strict';
const { dialog, app, BrowserWindow, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const assert = require('assert');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '../..');
const ART = '/Users/saimon/.gemini/antigravity/brain/cb4ff1d8-186c-4ca3-9b84-bfe96acbf3bc';

async function run() {
  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };
  safe('autobot:getVersion', () => ({ app: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  safe('autobot:getSettings', () => ({ theme: 'dark', locale: 'en', provider: { model: 'claude-opus-4-6', baseURL: '' } }));
  safe('autobot:setSettings', (_e, p) => p || {});
  safe('autobot:getFeatures', () => ({}));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => []);
  safe('autobot:getOrchestrator', () => ({ pools: { enabled: true }, providers: [] }));
  safe('autobot:poolsPreset', () => ({ enabled: false, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:freellmStatus', () => ({ running: true }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [], status: [] }));
  safe('autobot:extBridgeStatus', () => ({ running: true, port: 8766, extensionConnected: true, extensionVersion: '1.6.7', connectedClients: 1, tabs: [] }));
  safe('autobot:serverInfo', () => ({ port: 8766, url: 'http://127.0.0.1:8766', wsUrl: 'ws://127.0.0.1:8766', platform: process.platform, arch: process.arch, pid: process.pid, extensionConnected: true, connectedClients: 1 }));
  safe('autobot:worktreeList', () => ({ isRepo: true, root: REPO, worktrees: [] }));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 263 }));
  safe('autobot:gitInfo', () => ({ isRepo: false }));
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
  safe('autobot:ollamaModels', () => ({ ok: false, models: [] }));
  safe('autobot:providerStatus', () => ({
    ok: true,
    status: {
      providers: [
        {
          id: 'claude', label: 'Claude', vendor: 'Anthropic', transport: 'anthropic',
          canBrowserSignIn: true, canManualCode: false, canPasteKey: false,
          models: [{ id: 'claude-opus-4-6' }],
          accounts: [{ id: 'claude:max', account: 'max', label: 'Claude · max', source: 'claude-code' }],
        },
        {
          id: 'codex', label: 'ChatGPT', vendor: 'OpenAI', transport: 'codex',
          canBrowserSignIn: true, canManualCode: false, canPasteKey: false,
          models: [{ id: 'gpt-5.4' }],
          accounts: [{ id: 'codex:team', account: 'team', label: 'Chat Team', planName: 'Free', source: 'oauth' }],
        },
        {
          id: 'antigravity', label: 'Google Antigravity', vendor: 'Google', transport: 'google',
          canBrowserSignIn: true, canManualCode: false, canPasteKey: false,
          models: [{ id: 'gemini-3-pro' }],
          accounts: [{ id: 'antigravity:mb', account: 'mb', label: 'Maxim Bartoszk', source: 'oauth' }],
        },
        {
          id: 'grok', label: 'Grok', vendor: 'xAI', transport: 'grok',
          canBrowserSignIn: true, canManualCode: false, canPasteKey: true,
          models: [{ id: 'grok-4' }],
          accounts: [{ id: 'grok:p', account: 'p', label: 'Grok · primox2014-gmail-com', source: 'oauth' }],
        },
      ],
    },
  }));

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: '#131316',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:provider', JSON.stringify({ model: 'claude-opus-4-6', baseURL: '', oauthProvider: 'claude:max' }));
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));

  await win.webContents.executeJavaScript(`(() => {
    const sbtn = document.querySelector('button[title="Settings"], button.settings-icon');
    if (!sbtn) throw new Error('Settings button not found');
    sbtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 700));

  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    const acct = document.querySelector('.account-section');
    if (acct) acct.scrollIntoView({ block: 'start' });
  })()`);
  await new Promise((r) => setTimeout(r, 400));

  const metrics = await win.webContents.executeJavaScript(`(() => {
    const navBtns = [...document.querySelectorAll('.settings-nav-btn')];
    const maxNavHeight = Math.max(...navBtns.map(b => b.getBoundingClientRect().height));
    const seps = document.querySelectorAll('.settings-nav-sep').length;
    const cards = [...document.querySelectorAll('.acct-prov')];
    const gaps = [];
    for (let i = 1; i < cards.length; i++) {
      gaps.push(Math.round(cards[i].getBoundingClientRect().top - cards[i - 1].getBoundingClientRect().bottom));
    }
    const rowSeps = cards.map(c => {
      const head = c.querySelector('.acct-card-head');
      const acct = c.querySelector('.prov-acct');
      return head && acct ? Math.round(acct.getBoundingClientRect().top - head.getBoundingClientRect().bottom) : -1;
    });
    const keyInput = document.querySelector('.acct-key-row .prov-token-in');
    const keyInputHeight = keyInput ? Math.round(keyInput.getBoundingClientRect().height) : 0;
    return { navCount: navBtns.length, maxNavHeight, seps, cardCount: cards.length, gaps, rowSeps, keyInputHeight };
  })()`);

  assert.strictEqual(metrics.cardCount, 4, JSON.stringify(metrics));
  assert.ok(metrics.maxNavHeight <= 42, 'sidebar wrapped: ' + JSON.stringify(metrics));
  assert.ok(metrics.seps >= 3, 'missing sidebar group separators: ' + JSON.stringify(metrics));
  assert.ok(metrics.gaps.every((g) => g >= 12), 'tight card gaps: ' + JSON.stringify(metrics));
  assert.ok(metrics.rowSeps.every((g) => g >= 10), 'tight card head->row gaps: ' + JSON.stringify(metrics));
  assert.ok(metrics.keyInputHeight >= 34, 'tiny key input: ' + JSON.stringify(metrics));

  const darkImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ART, 'settings-accounts-redesigned-dark.png'), darkImg.toPNG());

  await win.webContents.executeJavaScript(`(() => {
    document.documentElement.setAttribute('data-theme', 'light');
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  const lightImg = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ART, 'settings-accounts-redesigned-light.png'), lightImg.toPNG());

  console.log('SETTINGS_DESIGN_E2E_OK', JSON.stringify(metrics));
  app.exit(0);
}

app.whenReady().then(() => run().catch((err) => {
  console.error(err);
  app.exit(1);
}));
