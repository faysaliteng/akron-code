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
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: '#1f1e1b',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  let testReplyMode = 'ok';
  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };
  safe('autobot:getVersion', () => ({ app: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  safe('autobot:getSettings', () => ({ theme: 'dark', locale: 'en', provider: { model: 'claude-sonnet-5-5', baseURL: 'http://127.0.0.1:3001/v1' } }));
  safe('autobot:setSettings', (_e, p) => p || {});
  safe('autobot:getFeatures', () => ({}));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => []);
  safe('autobot:getOrchestrator', () => ({ enabled: false, providers: [] }));
  safe('autobot:poolsPreset', () => ({ enabled: false, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [] } }));
  safe('autobot:freellmStatus', () => ({ running: true }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [], status: [] }));
  safe('autobot:extBridgeStatus', () => ({ running: false, port: 8766, extensionConnected: false, tabs: [] }));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:reaStatus', () => ({ available: true, toolCount: 263 }));
  safe('autobot:gitInfo', () => ({ isRepo: false }));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => '/tmp/akron-code-toast-e2e');
  safe('autobot:getWorkspace', () => '/tmp/akron-code-toast-e2e');
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false, detectedLocalFolders: [] }));
  safe('autobot:oauthStatus', () => ({ providers: [], total: 0 }));
  safe('autobot:checkpointsList', () => []);
  safe('autobot:checkpointsDiff', () => ({ ok: true, files: [] }));
  safe('autobot:pluginStats', () => ({ total: 0, installed: 0, enabled: 0 }));
  safe('autobot:listPlugins', () => []);
  safe('autobot:ollamaModels', () => ({ ok: true, models: [] }));
  safe('autobot:testProvider', () => (
    testReplyMode === 'ok'
      ? { ok: true, reply: 'Pong! What can I help you with? I can read, write' }
      : { ok: false, error: 'Simulated 502 upstream gateway error for 5s auto-dismiss check' }
  ));

  const seedConvs = [
    {
      id: 'conv_toast_e2e',
      title: 'Toast Verification Thread',
      ts: Date.now() - 10000,
      messages: [
        { id: 'u1', role: 'user', content: 'hi' },
        { id: 'a1', role: 'assistant', content: 'Hi! Ready to build in your workspace.', durationMs: 900 },
      ],
    },
  ];

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_toast_e2e'))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 800));

  // 1. Open Settings and click "Test connection" -> verify floating emerald toast above modal
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Settings/i.test(b.textContent || '') || /Settings/i.test(b.getAttribute('title') || '') || /Settings/i.test(b.getAttribute('aria-label') || ''));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Test connection/i.test(b.textContent || ''));
    if (!btn) throw new Error('Test connection button not found in Settings modal');
    btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));

  const modalToast = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.errorbar');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return {
      text: el.textContent,
      hasOk: el.classList.contains('ok'),
      hasFloating: el.classList.contains('floating-modal-toast'),
      zIndex: cs.zIndex,
      bg: cs.backgroundColor,
    };
  })()`);
  console.log('MODAL_TOAST:', JSON.stringify(modalToast));
  assert.ok(modalToast && modalToast.hasOk && modalToast.hasFloating, 'Expected .errorbar.ok.floating-modal-toast above Settings modal');
  assert.strictEqual(modalToast.zIndex, '500');

  // Close Settings so the emerald toast sits above composer cleanly, verify stacking & capture screenshot
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.modal button')].find(b => /^Done$/i.test((b.textContent || '').trim()));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));

  const composerToast = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.errorbar');
    const xBtn = document.querySelector('.errorbar-x');
    if (!el || !xBtn) return null;
    const xr = xBtn.getBoundingClientRect();
    const hit = document.elementFromPoint(xr.left + xr.width / 2, xr.top + xr.height / 2);
    const hitInsideBtn = !!(hit && xBtn.contains(hit));
    const elRect = el.getBoundingClientRect();
    const inpRect = document.querySelector('.inputbar')?.getBoundingClientRect();
    return {
      hasOk: el.classList.contains('ok'),
      zIndex: getComputedStyle(el).zIndex,
      hitInsideBtn,
      gapAboveInputbar: inpRect ? Math.round(inpRect.top - elRect.bottom) : null,
      text: el.textContent,
    };
  })()`);
  console.log('COMPOSER_TOAST:', JSON.stringify(composerToast));
  assert.ok(composerToast && composerToast.hasOk, 'Expected emerald .errorbar.ok above composer');
  assert.strictEqual(composerToast.hitInsideBtn, true, 'Close button X must be clickable (not covered by .inputbar::before)');
  assert.ok(composerToast.gapAboveInputbar >= 4, 'Toast must sit cleanly above .inputbar without overlap');

  const png = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'toast-5s-verified.png'), png.toPNG());

  // 2. Click the X button and assert immediate removal
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.errorbar-x').click(); })()`);
  await new Promise((r) => setTimeout(r, 150));
  const afterClose = await win.webContents.executeJavaScript(`document.querySelector('.errorbar') === null`);
  console.log('AFTER_CLOSE_CLICK:', afterClose);
  assert.strictEqual(afterClose, true, 'Clicking X must close .errorbar immediately');

  // 3. Trigger an ERROR notification (non-✅) and verify it auto-disappears after 5 seconds!
  testReplyMode = 'error';
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Settings/i.test(b.textContent || '') || /Settings/i.test(b.getAttribute('title') || '') || /Settings/i.test(b.getAttribute('aria-label') || ''));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => /Test connection/i.test(b.textContent || ''));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.modal button')].find(b => /^Done$/i.test((b.textContent || '').trim()));
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 150));

  const errPresent = await win.webContents.executeJavaScript(`(() => {
    const el = document.querySelector('.errorbar');
    return el ? { ok: el.classList.contains('ok'), hasX: !!document.querySelector('.errorbar-x'), text: el.textContent } : null;
  })()`);
  console.log('ERROR_TOAST_VISIBLE:', JSON.stringify(errPresent));
  assert.ok(errPresent && !errPresent.ok && errPresent.hasX, 'Expected error banner with close button');

  await new Promise((r) => setTimeout(r, 5200));
  const errAfter5s = await win.webContents.executeJavaScript(`document.querySelector('.errorbar') === null`);
  console.log('ERROR_TOAST_AFTER_5S:', errAfter5s);
  assert.strictEqual(errAfter5s, true, 'Error notification must auto-disappear after 5 seconds');

  // 4. Verify noticebar: close via X, re-trigger identical notice, then auto-disappear after 5 seconds
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('button[title="Fork conversation from this response"]');
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  const noticeVisible = await win.webContents.executeJavaScript(`!!document.querySelector('.noticebar') && !!document.querySelector('.noticebar-x')`);
  assert.strictEqual(noticeVisible, true, 'Expected .noticebar after Fork');
  await win.webContents.executeJavaScript(`(() => { document.querySelector('.noticebar-x').click(); })()`);
  await new Promise((r) => setTimeout(r, 150));
  const noticeAfterX = await win.webContents.executeJavaScript(`document.querySelector('.noticebar') === null`);
  assert.strictEqual(noticeAfterX, true, 'Clicking .noticebar-x must dismiss noticebar');

  // Re-trigger noticebar via Fork and verify 5s auto-dismiss
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('button[title="Fork conversation from this response"]');
    if (btn) btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(await win.webContents.executeJavaScript(`!!document.querySelector('.noticebar')`), true, 'Noticebar must reappear after dismissal if triggered again');
  await new Promise((r) => setTimeout(r, 5200));
  const noticeAfter5s = await win.webContents.executeJavaScript(`document.querySelector('.noticebar') === null`);
  console.log('NOTICE_AFTER_5S:', noticeAfter5s);
  assert.strictEqual(noticeAfter5s, true, 'Noticebar must auto-disappear after 5 seconds');

  console.log('TOAST_5S_E2E_OK');
  win.destroy();
  app.exit(0);
}

app.whenReady().then(run).catch((err) => {
  console.error('TOAST_5S_E2E_FAILED:', err);
  app.exit(1);
});
