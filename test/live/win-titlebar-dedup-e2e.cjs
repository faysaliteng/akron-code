const { dialog } = require('electron'); dialog.showErrorBox = () => {};
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..', '..');

function verifyMainProcessConfig() {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  assert(mainSrc.includes('function winTitleBarOverlay(theme)'), 'winTitleBarOverlay helper missing in electron/main.js');
  assert(/titleBarStyle:\s*'hidden',\s*autoHideMenuBar:\s*true,\s*titleBarOverlay:\s*winTitleBarOverlay\(initTheme\)/.test(mainSrc), 'Windows frameless titleBarOverlay config missing in createWindow()');
  assert(/if \(!isMac\)[\s\S]*setMenuBarVisibility\(false\)/.test(mainSrc), 'Menu bar visibility hide missing for non-macOS');
  assert(/setTitleBarOverlay\(overlay\)/.test(mainSrc), 'Live setTitleBarOverlay update missing in autobot:setSettings');
}

function registerStubHandlers() {
  const noop = async () => null;
  const defaults = {
    'autobot:getSettings': () => ({ theme: 'dark', locale: 'en', model: 'auto' }),
    'autobot:setSettings': (_e, p) => ({ theme: 'dark', locale: 'en', ...(p || {}) }),
    'autobot:getProviders': () => [],
    'autobot:listConvs': () => [{ id: 'c1', title: 'hi', updatedAt: Date.now() }],
    'autobot:getConv': () => ({ id: 'c1', title: 'hi', messages: [{ id: 'm1', role: 'user', content: 'hi' }] }),
    'autobot:listProjects': () => [],
    'autobot:listSkills': () => [],
    'autobot:listNotebooks': () => [],
    'autobot:listMemory': () => [],
    'autobot:listMcpServers': () => [],
    'autobot:listSlashActions': () => [],
    'autobot:getAccounts': () => ({ claude: [], chatgpt: [], antigravity: [], grok: [] }),
    'autobot:getVersion': () => '1.0.0',
    'autobot:getCwd': () => ROOT,
  };
  const ipcMock = new Proxy(ipcMain, {
    get(target, prop) { return target[prop]; },
  });
  Object.entries(defaults).forEach(([ch, fn]) => {
    try { ipcMock.removeHandler(ch); ipcMock.handle(ch, fn); } catch (_) {}
  });
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|sendSync)\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of new Set(channels)) {
    if (!defaults[ch]) {
      try { ipcMock.handle(ch, noop); } catch (_) {}
    }
  }
}

app.whenReady().then(async () => {
  try {
    verifyMainProcessConfig();
    registerStubHandlers();

    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      show: false,
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 700))`);

    const metrics = await win.webContents.executeJavaScript(`(() => {
      const appEl = document.querySelector('.app');
      const prevPlat = appEl.getAttribute('data-platform');
      appEl.setAttribute('data-platform', 'win32');
      const titlebar = document.querySelector('.titlebar');
      const tbStyle = getComputedStyle(titlebar);
      const wsTabs = document.querySelector('.ws-tabs');
      const wsTabsStyle = getComputedStyle(wsTabs);
      const modeSwitch = document.querySelector('.ws-mode-switch');
      const modeStyle = getComputedStyle(modeSwitch);
      const wsTab = document.querySelector('.ws-tab');
      const wsTabStyle = wsTab ? getComputedStyle(wsTab) : null;
      const wsAdd = document.querySelector('.ws-tab-add');
      const wsAddStyle = wsAdd ? getComputedStyle(wsAdd) : null;
      const brands = [...document.querySelectorAll('.brand')].map((el) => ({
        text: el.textContent,
        inTitlebar: !!el.closest('.titlebar'),
        inSidebar: !!el.closest('.sidebar'),
      }));
      const result = {
        brands,
        subText: document.querySelector('.titlebar .sub')?.textContent || '',
        sidebarWordmarks: document.querySelectorAll('.sidebar .wordmark').length,
        sidebarBrands: document.querySelectorAll('.sidebar .brand').length,
        accountNames: document.querySelectorAll('.account-name').length,
        sidebarMarks: document.querySelectorAll('.sidebar-mark').length,
        sidebarSettingsBtns: document.querySelectorAll('.sidebar-settings-btn').length,
        winPaddingLeft: tbStyle.paddingLeft,
        winPaddingRight: tbStyle.paddingRight,
        wsTabsAppRegion: wsTabsStyle.webkitAppRegion || wsTabsStyle.appRegion || '',
        modeAppRegion: modeStyle.webkitAppRegion || modeStyle.appRegion || '',
        wsTabAppRegion: wsTabStyle ? (wsTabStyle.webkitAppRegion || wsTabStyle.appRegion || '') : null,
        wsAddAppRegion: wsAddStyle ? (wsAddStyle.webkitAppRegion || wsAddStyle.appRegion || '') : '',
      };
      appEl.setAttribute('data-platform', prevPlat);
      return result;
    })()`);

    assert.strictEqual(metrics.brands.length, 1, `Expected 1 .brand element, got ${metrics.brands.length}: ${JSON.stringify(metrics.brands)}`);
    assert.strictEqual(metrics.brands[0].text, 'Akron Code');
    assert.strictEqual(metrics.brands[0].inTitlebar, true);
    assert.strictEqual(metrics.brands[0].inSidebar, false);
    assert.strictEqual(metrics.subText, 'by Akronlogic.com');
    assert.strictEqual(metrics.sidebarWordmarks, 0);
    assert.strictEqual(metrics.sidebarBrands, 0);
    assert.strictEqual(metrics.accountNames, 0);
    assert.strictEqual(metrics.sidebarMarks, 0);
    assert.strictEqual(metrics.sidebarSettingsBtns, 1);
    assert.strictEqual(metrics.winPaddingLeft, '14px');
    assert.strictEqual(metrics.winPaddingRight, '144px');
    assert.notStrictEqual(metrics.wsTabsAppRegion, 'no-drag', '.ws-tabs must not block titlebar dragging');
    assert.strictEqual(metrics.modeAppRegion, 'no-drag');
    if (metrics.wsTabAppRegion !== null) assert.strictEqual(metrics.wsTabAppRegion, 'no-drag');
    assert.strictEqual(metrics.wsAddAppRegion, 'no-drag');

    console.log('WIN_TITLEBAR_DEDUP_E2E_OK', JSON.stringify(metrics));
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('WIN_TITLEBAR_DEDUP_E2E_FAIL:', err);
    app.exit(1);
  }
});
