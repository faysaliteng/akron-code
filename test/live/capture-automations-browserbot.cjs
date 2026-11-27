'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(REPO, 'docs', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

function registerMocks() {
  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };
  const wsDir = path.join(os.tmpdir(), 'akron-shot-ws');
  fs.mkdirSync(wsDir, { recursive: true });
  const mockSettings = {
    theme: 'dark',
    locale: 'en',
    surfaceFinish: 'emerald-carbon',
    accentColor: '#10b981',
    bgPattern: 'carbon-weave',
    uiDensity: 'comfortable',
    chatWidth: 'wide',
    messageStyle: 'editorial',
    borderRadius: 'balanced',
    showTimestamps: true,
    timestampFormat: 'date-time',
    actionBarStyle: 'compact',
    showModelBadge: true,
    provider: { model: 'claude-sonnet-5-5', baseURL: 'https://api.anthropic.com/v1', routingMode: 'auto' },
  };
  const emptyList = [];
  safe('autobot:getVersion', () => ({ app: '1.2.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  safe('autobot:getSettings', () => mockSettings);
  safe('autobot:setSettings', (_e, patch) => Object.assign(mockSettings, patch || {}));
  safe('autobot:getFeatures', () => ({ computerUse: true, chrome: true }));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => []);
  safe('autobot:getOrchestrator', () => ({ enabled: false, providers: [] }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:listScheduledTasks', () => emptyList);
  safe('autobot:listScheduledTaskRuns', () => ({ ok: true, runs: [] }));
  safe('autobot:proactiveState', () => ({ matters: [{ matterKey: 'm1', title: 'Review pending migrations', status: 'open', impact: 'high' }], quietHours: { enabled: false, start: '22:00', end: '08:00' } }));
  safe('autobot:proactiveSuggest', () => [{ id: 's1', name: 'Morning CI Triage', prompt: 'Summarize failing tests', occurrences: 3, time: '07:18' }]);
  safe('autobot:providerStatus', () => ({
    ok: true,
    providers: [
      { id: 'claude', label: 'Claude Max', models: [{ id: 'claude-opus-5-5' }, { id: 'claude-sonnet-5-5' }], accounts: [{ account: 'team', label: 'Claude · max' }] },
      { id: 'openai', label: 'ChatGPT / Codex', models: [{ id: 'gpt-5.4' }], accounts: [{ account: 'plus', label: 'Codex · plus' }] },
      { id: 'gemini', label: 'Google Antigravity', models: [{ id: 'gemini-4-argon' }], accounts: [{ account: 'pro', label: 'Antigravity · pro' }] },
    ],
  }));
  safe('autobot:ollamaModels', () => ({ ok: true, models: [{ name: 'gemma4' }, { name: 'qwen2.5-coder:32b' }] }));
  safe('autobot:mcpStatus', () => [{ serverId: 'rea', name: 'REA (Reverse Engineer Anything)', tools: ['binary_overview', 'decompile_all'] }]);
  safe('autobot:mcpConfig', () => ({ servers: {} }));
  safe('autobot:envGetState', () => ({
    active: { kind: 'local', id: null, label: 'This Computer', cwd: wsDir },
    sshProfiles: [{ id: 'prod', name: 'build-linux-x64', host: 'build.akronlogic.internal' }],
    remoteProfiles: [],
    sshConfigHosts: [],
    hostServer: { enabled: false, port: 9477 },
  }));
  safe('autobot:extBridgeStatus', () => ({
    running: true,
    port: 8766,
    extensionConnected: false,
    extensionVersion: '1.6.7',
    extensionDir: process.platform === 'darwin' ? '~/Applications/Akron Browser Bot' : '%LOCALAPPDATA%\\AkronLogic\\Akron Browser Bot',
    extensionId: 'dhihhgdamadggcjnjphidopodnlkakdm',
    defaultBrowser: { id: 'brave', name: 'Brave Browser', isChromium: true },
    preferredChromiumBrowser: { id: 'brave', name: 'Brave Browser', schemeUrl: 'brave://extensions', isChromium: true },
    installedBrowsers: [
      { id: 'brave', name: 'Brave Browser', schemeUrl: 'brave://extensions' },
      { id: 'chrome', name: 'Google Chrome', schemeUrl: 'chrome://extensions' },
    ],
    tabs: [],
  }));
  safe('autobot:getDefaultCwd', () => wsDir);
  safe('autobot:getWorkspace', () => wsDir);
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:gdriveStatus', () => ({ connected: false, detectedLocalFolders: [] }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:listAgentDefs', () => []);
  safe('autobot:listOutputStyles', () => ({ defaultStyleId: 'default', styles: [] }));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:freellmStatus', () => ({ running: true, url: 'http://127.0.0.1:3001/v1', providers: [] }));
  safe('autobot:freellmProviders', () => []);
  safe('autobot:autoRouterGet', () => ({ ok: true, source: 'deepseek_api', defaultForNewSessions: true, hasKey: true }));
  safe('autobot:dbMigrate', () => ({ ok: true }));
  safe('autobot:allSessionsHealth', () => []);
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 263 }));
  safe('autobot:serverInfo', () => ({ port: 8766, url: 'http://127.0.0.1:8766' }));
  safe('autobot:worktreeList', () => ({ isRepo: false, worktrees: [] }));
  safe('autobot:gitInfo', () => ({ isRepo: false }));
  safe('autobot:depsStatus', () => ({ ok: true, coreHealthy: 7, coreTotal: 7, deps: [], lsps: [] }));
  safe('autobot:runtimes', () => ({ autoUpdate: true, items: [] }));
  safe('autobot:updateCheck', () => ({ ok: true, currentVersion: '1.2.0', upToDate: true }));
  safe('autobot:notificationsGet', () => ({ enabled: true, categories: {} }));
  safe('autobot:listPlugins', () => []);
  safe('autobot:pluginCategories', () => []);
  safe('autobot:pluginStats', () => ({ total: 961, installed: 4, enabled: 4 }));
  safe('autobot:registryStatus', () => ({ synced: true, count: 444 }));
  safe('autobot:getSandbox', () => ({ profile: 'workspace-write', allowNet: true }));
}

async function run() {
  registerMocks();
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    backgroundColor: '#0c110e',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  await win.loadFile(path.join(REPO, 'dist', 'index.html'));
  await new Promise((r) => setTimeout(r, 1200));

  const snap = async (filename) => {
    const img = await win.webContents.capturePage();
    const out = path.join(OUT_DIR, filename);
    fs.writeFileSync(out, img.toPNG());
    console.log('SAVED:', filename, fs.statSync(out).size, 'bytes');
  };

  // 1. Automations Hub (Empty state + 6 Starter Templates + Proactive badge)
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPanel('scheduled');`);
  await new Promise((r) => setTimeout(r, 700));
  await snap('automations-hub-dark.png');

  // 2. Click first template card -> opens New Scheduled Task Modal, expand Advanced + open Model Picker
  await win.webContents.executeJavaScript(`
    const tpl = document.querySelector('.auto-tpl-card');
    if (tpl) tpl.click();
  `);
  await new Promise((r) => setTimeout(r, 450));
  await win.webContents.executeJavaScript(`
    const adv = document.querySelector('.auto-adv-toggle');
    if (adv) adv.click();
    const mbtn = document.querySelector('[data-testid="task-modal-model-btn"]');
    if (mbtn) mbtn.click();
  `);
  await new Promise((r) => setTimeout(r, 400));
  await snap('automations-modal-dark.png');

  // Close modal and open Settings -> Browser Extension
  await win.webContents.executeJavaScript(`
    const backdrop = document.querySelector('.auto-modal-backdrop');
    if (backdrop) backdrop.click();
    window.__akronTestHarness && window.__akronTestHarness.openSettings('browser');
  `);
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript(`
    const body = document.querySelector('.settings-body');
    if (body) body.scrollTop = 0;
  `);
  await new Promise((r) => setTimeout(r, 250));
  await snap('browser-ext-autosetup-dark.png');

  win.destroy();
  app.exit(0);
}

app.whenReady().then(run).catch((e) => {
  console.error('CAPTURE_FAIL:', e);
  app.exit(1);
});
