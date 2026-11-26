'use strict';
const { dialog } = require('electron'); dialog.showErrorBox = () => {};
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const ARTIFACTS = '/Users/saimon/.gemini/antigravity/brain/cb4ff1d8-186c-4ca3-9b84-bfe96acbf3bc';

function registerStubHandlers() {
  const noop = async () => null;
  const defaults = {
    'autobot:getSettings': () => ({ theme: 'dark', locale: 'en', model: 'auto' }),
    'autobot:setSettings': (_e, p) => ({ theme: 'dark', locale: 'en', ...(p || {}) }),
    'autobot:getProviders': () => [],
    'autobot:listConvs': () => [{ id: 'c_notif', title: 'make a super beautifull adult ent', updatedAt: Date.now() }],
    'autobot:getConv': () => ({
      id: 'c_notif',
      title: 'make a super beautifull adult ent',
      messages: [
        { id: 'u1', role: 'user', content: 'what is this project' },
        { id: 'a1', role: 'assistant', content: 'It is LUMÉ LIVE — ready on http://localhost:4174.', model: 'gemini-4-argon', durationMs: 8000 },
      ],
    }),
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
  Object.entries(defaults).forEach(([ch, fn]) => {
    try { ipcMain.removeHandler(ch); ipcMain.handle(ch, fn); } catch (_) {}
  });
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|sendSync)\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of new Set(channels)) {
    if (!defaults[ch]) {
      try { ipcMain.handle(ch, noop); } catch (_) {}
    }
  }
}

app.whenReady().then(async () => {
  try {
    registerStubHandlers();

    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      backgroundColor: '#0e0f0e',
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });

    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await win.webContents.executeJavaScript(`(() => {
      localStorage.removeItem('autobot:notifications:v1');
      localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('c_notif'))});
    })()`);
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 800))`);

    // 1. Verify titlebar bell placement on darwin & win32 (respecting 144px overlay padding)
    const placement = await win.webContents.executeJavaScript(`(() => {
      const appEl = document.querySelector('.app');
      const prevPlat = appEl.getAttribute('data-platform');
      appEl.setAttribute('data-platform', 'darwin');
      const bell = document.querySelector('.titlebar .notif-bell-btn');
      const darwinRect = bell ? bell.getBoundingClientRect().toJSON() : null;
      appEl.setAttribute('data-platform', 'win32');
      const winRect = bell ? bell.getBoundingClientRect().toJSON() : null;
      appEl.setAttribute('data-platform', prevPlat);
      return {
        hasBell: !!bell,
        innerWidth: window.innerWidth,
        darwinRect,
        winRect,
        winRightMargin: winRect ? (window.innerWidth - winRect.right) : 0,
      };
    })()`);

    assert.strictEqual(placement.hasBell, true, 'Notification bell missing in .titlebar');
    assert(placement.winRightMargin >= 140, `Expected >=140px Windows titleBarOverlay margin right of bell, got ${placement.winRightMargin}`);

    // 2. Push the reported orchestrator notice via real IPC event -> toast pops at top right, zero inline .noticebar
    const longNotice = 'Left 5 orchestrator models out of this turn — ChatGPT · Free · GPT-Reserve, ChatGPT · Free · GPT-6-Luna, ChatGPT · Free · GPT-5.6-Terra, Codex Auto Review, GPT-5.6-Luna. The saved row is untouched; remove it in Settings if that gateway no longer serves it.';
    win.webContents.send('autobot:event', { runId: 'r1', type: 'notice', text: longNotice });
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 300))`);

    const toastSnap = await win.webContents.executeJavaScript(`(() => {
      const toast = document.querySelector('.notif-toast-pop');
      const badge = document.querySelector('.notif-badge');
      const noticebar = document.querySelector('.noticebar');
      return {
        hasNoticebar: !!noticebar,
        hasToast: !!toast,
        toastRect: toast ? toast.getBoundingClientRect().toJSON() : null,
        badgeText: badge ? badge.textContent.trim() : '',
      };
    })()`);

    assert.strictEqual(toastSnap.hasNoticebar, false, 'Agent view must NOT render inline .noticebar above composer');
    assert.strictEqual(toastSnap.hasToast, true, 'Expected top-right .notif-toast-pop to appear');
    assert(toastSnap.toastRect.top >= 40, `Toast overlapped titlebar (top=${toastSnap.toastRect.top})`);
    assert(toastSnap.toastRect.width <= 360, `Toast too wide (${toastSnap.toastRect.width}px)`);
    assert(toastSnap.toastRect.right <= 1440, 'Toast clipped off right edge');
    assert.strictEqual(toastSnap.badgeText, '1', `Expected badge '1', got '${toastSnap.badgeText}'`);

    const toastShot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ARTIFACTS, 'notification-toast-top-right.png'), toastShot.toPNG());

    // Verify IDE mode also renders zero inline .noticebar
    await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('.ws-mode-btn')];
      const ideBtn = btns.find((b) => /IDE/.test(b.textContent || ''));
      if (ideBtn) ideBtn.click();
    })()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 350))`);
    const ideNoticebar = await win.webContents.executeJavaScript(`!!document.querySelector('.noticebar')`);
    assert.strictEqual(ideNoticebar, false, 'IDE view must NOT render inline .noticebar');
    await win.webContents.executeJavaScript(`(() => {
      const btns = [...document.querySelectorAll('.ws-mode-btn')];
      const agBtn = btns.find((b) => /Agent/.test(b.textContent || ''));
      if (agBtn) agBtn.click();
    })()`);

    // 3. Wait 4.2s -> compact toast auto-disappears, while unread count stays '1'
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 4200))`);
    const afterAutoHide = await win.webContents.executeJavaScript(`(() => ({
      hasToast: !!document.querySelector('.notif-toast-pop'),
      badgeText: document.querySelector('.notif-badge')?.textContent?.trim() || '',
    }))()`);
    assert.strictEqual(afterAutoHide.hasToast, false, 'Top-right toast must auto-disappear after ~3.8s');
    assert.strictEqual(afterAutoHide.badgeText, '1', 'Unread badge must persist after toast hides');

    // 4. Send 2 additional varied notifications -> open Notification Center drawer -> screenshot
    win.webContents.send('autobot:event', { runId: 'r2', type: 'artifact', name: 'index.html', language: 'html', content: '<h1>hi</h1>' });
    win.webContents.send('autobot:event', { runId: 'r3', type: 'notice', text: 'Compacted 4 earlier turns mid-run to keep inside context window.' });
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 250))`);
    await win.webContents.executeJavaScript(`document.querySelector('.notif-bell-btn').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 250))`);

    const drawerSnap = await win.webContents.executeJavaScript(`(() => {
      const drawer = document.querySelector('.notif-drawer');
      const items = [...document.querySelectorAll('.notif-item')];
      return {
        hasDrawer: !!drawer,
        itemCount: items.length,
        hasToastWhileOpen: !!document.querySelector('.notif-toast-pop'),
        badgeText: document.querySelector('.notif-badge')?.textContent?.trim() || '',
      };
    })()`);

    assert.strictEqual(drawerSnap.hasDrawer, true, 'Notification drawer failed to open');
    assert.strictEqual(drawerSnap.itemCount, 3, `Expected 3 log entries, got ${drawerSnap.itemCount}`);
    assert.strictEqual(drawerSnap.hasToastWhileOpen, false, 'Toast must hide when drawer is open');
    assert.strictEqual(drawerSnap.badgeText, '3');

    const drawerShot = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ARTIFACTS, 'notification-drawer-open.png'), drawerShot.toPNG());

    // 5. Expand first item -> marks it read (unread -> 2), test Alerts tab, Mark all read (unread -> 0)
    await win.webContents.executeJavaScript(`document.querySelector('.notif-item').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 120))`);
    const afterExpand = await win.webContents.executeJavaScript(`(() => ({
      firstExpanded: document.querySelector('.notif-item')?.classList.contains('expanded'),
      firstRead: document.querySelector('.notif-item')?.classList.contains('read'),
      badgeText: document.querySelector('.notif-badge')?.textContent?.trim() || '',
    }))()`);
    assert.strictEqual(afterExpand.firstExpanded, true, 'Clicking item should expand full body');
    assert.strictEqual(afterExpand.firstRead, true, 'Clicking item should mark it read');
    assert.strictEqual(afterExpand.badgeText, '2', 'Badge should decrement to 2');

    // Filter Alerts tab
    await win.webContents.executeJavaScript(`(() => {
      const t = [...document.querySelectorAll('.notif-filter-tab')].find((b) => /Alerts/.test(b.textContent || ''));
      if (t) t.click();
    })()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 100))`);
    const alertsCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.notif-item').length`);
    assert.strictEqual(alertsCount, 2, `Expected 2 Alert items (Compacted + Orchestrator), got ${alertsCount}`);

    // Mark all read
    await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.notif-head-btn')].find((b) => /Mark all read/.test(b.textContent || ''));
      if (btn) btn.click();
    })()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 120))`);
    const badgeAfterAllRead = await win.webContents.executeJavaScript(`document.querySelector('.notif-badge')`);
    assert.strictEqual(badgeAfterAllRead, null, 'Badge must disappear after Mark all read');

    // 6. Reload -> verify log & read status persist in localStorage -> Clear log
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 700))`);
    assert.strictEqual(await win.webContents.executeJavaScript(`document.querySelector('.notif-badge')`), null, 'Read state must persist across reload');
    await win.webContents.executeJavaScript(`document.querySelector('.notif-bell-btn').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 150))`);
    assert.strictEqual(await win.webContents.executeJavaScript(`document.querySelectorAll('.notif-item').length`), 3, 'Log history must persist across reload');

    await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.notif-head-btn')].find((b) => /Clear/.test(b.textContent || ''));
      if (btn) btn.click();
    })()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 120))`);
    assert.strictEqual(await win.webContents.executeJavaScript(`!!document.querySelector('.notif-empty')`), true, 'Clear must empty log');

    console.log('NOTIFICATION_CENTER_E2E_ALL_PASS');
    win.destroy();
    app.exit(0);
  } catch (err) {
    console.error('NOTIFICATION_CENTER_E2E_FAIL:', err);
    app.exit(1);
  }
});
