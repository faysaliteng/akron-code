'use strict';

/**
 * Multi-launch real Electron E2E test verifying that Orchestrator Mode and all
 * Settings persist across app close/reopen and across a fresh Electron userData
 * profile (backed by ~/.autobot/*.json).
 *
 * Uses an isolated temp HOME and temp userData directory so user state is never touched.
 * Runs hidden windows (`show: false`) and suppresses any error dialogs.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');

if (process.argv.includes('--worker')) {
  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  if (dialog) dialog.showErrorBox = () => {};
  app.on('window-all-closed', (e) => e.preventDefault());

  const stage = Number(process.env.AKRON_PERSIST_STAGE || '1');
  const distHtml = path.join(REPO, 'dist', 'index.html');
  const preloadJs = path.join(REPO, 'electron', 'preload.js');
  const store = require(path.join(REPO, 'electron', 'store'));
  const appSys = require(path.join(REPO, 'electron', 'app-system'));

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function safe(ch, fn) {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  }

  function installHandlers(win) {
    safe('autobot:getVersion', () => ({ version: '1.5.6', app: '1.5.6', platform: process.platform, arch: process.arch }));
    safe('autobot:getSettings', () => store.getSettings());
    safe('autobot:setSettings', (_e, patch) => {
      const cur = store.getSettings() || {};
      const norm = (patch && typeof patch === 'object') ? { ...patch } : {};
      if (norm.uiSettings) norm.uiSettings = { ...(cur.uiSettings || {}), ...norm.uiSettings };
      if (norm.uiState) norm.uiState = { ...(cur.uiState || {}), ...norm.uiState };
      const next = store.setSettings(norm);
      if ('keepInTray' in norm || (norm.uiSettings && 'keepInTray' in norm.uiSettings)) {
        appSys.setKeepInTray(Boolean((norm.uiSettings && norm.uiSettings.keepInTray !== undefined) ? norm.uiSettings.keepInTray : next.keepInTray));
      }
      return next;
    });
    safe('autobot:getOrchestrator', () => store.getOrchestrator());
    safe('autobot:setOrchestrator', (_e, patch) => store.setOrchestrator(patch));
    safe('autobot:getFeatures', () => store.getFeatures());
    safe('autobot:setFeatures', (_e, patch) => store.setFeatures(patch));
    safe('autobot:getMemory', () => ({ entries: [] }));
    safe('autobot:getSkills', () => []);
    safe('autobot:listNotebooks', () => []);
    safe('autobot:mcpConfig', () => ({ status: [] }));
    safe('autobot:listSlashActions', () => []);
    safe('autobot:listAgentDefs', () => []);
    safe('autobot:listOutputStyles', () => ({ styles: [], defaultStyleId: 'default' }));
    safe('autobot:envGetState', () => ({ active: { kind: 'local', id: null, label: 'This Computer', cwd: os.tmpdir() }, sshProfiles: [], remoteProfiles: [], sshConfigHosts: [], hostServer: { enabled: false, running: false } }));
    safe('autobot:gdriveStatus', () => ({ connected: false, mode: null, detectedLocalFolders: [] }));
    safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [{ id: 'antigravity', label: 'Google / Antigravity', transport: 'google', accounts: [{ id: 'antigravity:test', account: 'test', label: 'test@example.com', plan: 'Free', hasToken: true }], models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }] }] } }));
    safe('autobot:providerModels', () => ({ ok: true, models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', windowLabel: '1M', contextWindow: 1048576 }] }));
    safe('autobot:ollamaModels', () => ({ ok: false, models: [] }));
    safe('autobot:probeProviders', () => ({}));
    safe('autobot:orchPaidProvidersGet', () => ({ ok: true, providers: [] }));
    safe('autobot:freellmCatalog', () => ({ ok: true, platforms: [], totals: { totalModels: 0, totalPlatforms: 0, chatModels: 0, chatPlatforms: 0, mediaModels: 0, mediaModalities: 0, embeddingModels: 0, embeddingPlatforms: 0 } }));
    safe('autobot:freellmDetect', () => ({ ok: false }));
    safe('autobot:autoRouterGet', () => ({ ok: true, source: 'openrouter_free', defaultForNewSessions: false, sources: {}, telemetry: { decisionsCount: 0 } }));
    safe('autobot:mediaStudioList', () => ({ ok: true, imageModels: [], videoModels: [], library: [] }));
    safe('autobot:mediaKeysGet', () => ({ ok: true, providers: [] }));
    safe('autobot:customToolList', () => []);
    safe('autobot:reaStatus', () => ({ available: false, connected: false }));
    safe('autobot:extBridgeStatus', () => ({ running: true, extensionConnected: false, tabs: [] }));
    safe('autobot:dbMigrate', () => ({ ok: true }));
    safe('autobot:dbUpsertConv', () => ({ ok: true }));
    safe('autobot:complianceGet', () => null);
    safe('autobot:scheduledTaskList', () => []);
    safe('autobot:listScheduledTasks', () => []);
    safe('autobot:customToolRun', () => ({ ok: true }));
    safe('autobot:proactiveState', () => ({ quietHours: { enabled: false, start: '22:00', end: '08:00' } }));
    safe('autobot:pushGetConfig', () => ({ enabled: false }));
    safe('autobot:remoteRelayStatus', () => ({ connected: false, relayUrl: '' }));
    safe('autobot:getDefaultCwd', () => os.tmpdir());
    safe('autobot:getWorkspace', () => os.tmpdir());
    safe('autobot:openExternal', () => ({ ok: true }));
    safe('autobot:providerReconnectState', () => ({ waiting: false }));
    safe('autobot:runtimes', () => ({}));
  }

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      show: false,
      webPreferences: {
        preload: preloadJs,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    installHandlers(win);
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) console.error('[renderer-console]', level, msg);
    });
    const runJs = (code) => win.webContents.executeJavaScript(`(async () => { try { const fn = (${code}); return typeof fn === 'function' ? await fn() : fn; } catch (e) { return { __err: String(e && (e.stack || e.message) || e) }; } })()`);
    await win.loadFile(distHtml);
    await win.webContents.executeJavaScript('new Promise((r) => setTimeout(r, 900))');

    if (stage === 1) {
      const r1 = await runJs(`async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
        window.__akronTestHarness.openSettings('orchestrator');
        await sleep(350);
        const cb = document.querySelector('[data-testid="orch-enable-checkbox"]');
        if (!cb) throw new Error('missing orch-enable-checkbox; sections=' + Array.from(document.querySelectorAll('.settings-nav button')).map(b=>b.textContent).join(','));
        if (!cb.checked) cb.click();
        const selects1 = Array.from(document.querySelectorAll('.settings-body select'));
        const hp = selects1.find((el) => Array.from(el.options).some((o) => o.value === 'architect'));
        if (!hp) throw new Error('missing harnessProfile select');
        setter.call(hp, 'architect');
        hp.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(250);

        window.__akronTestHarness.openSettings('system');
        await sleep(300);
        const selects2 = Array.from(document.querySelectorAll('.settings-body select'));
        const themeSel = selects2.find((el) => Array.from(el.options).some((o) => o.value === 'light') && Array.from(el.options).some((o) => o.value === 'dark'));
        if (!themeSel) throw new Error('missing theme select');
        setter.call(themeSel, 'light');
        themeSel.dispatchEvent(new Event('change', { bubbles: true }));
        const trayLbl = Array.from(document.querySelectorAll('.settings-body label.check')).find((l) => /system tray/i.test(l.textContent || ''));
        if (!trayLbl) throw new Error('missing keepInTray checkbox');
        const trayCb = trayLbl.querySelector('input[type="checkbox"]');
        if (!trayCb.checked) trayCb.click();
        const wideBtn = Array.from(document.querySelectorAll('.settings-body button')).find((b) => /Wide/i.test(b.textContent || '') && /1080/.test(b.textContent || ''));
        if (!wideBtn) throw new Error('missing Wide button');
        wideBtn.click();
        await sleep(250);

        window.__akronTestHarness.openSettings('browser');
        await sleep(250);
        const selects3 = Array.from(document.querySelectorAll('.settings-body select'));
        const linkSel = selects3.find((el) => Array.from(el.options).some((o) => o.value === 'external') && Array.from(el.options).some((o) => o.value === 'internal'));
        if (!linkSel) throw new Error('missing browserLinkMode select');
        setter.call(linkSel, 'external');
        linkSel.dispatchEvent(new Event('change', { bubbles: true }));
        window.__akronTestHarness.closeSettings();
        await sleep(250);

        const swarmBtn = document.querySelector('button.swarm-pill');
        if (swarmBtn && swarmBtn.getAttribute('aria-pressed') !== 'true') swarmBtn.click();
        await sleep(400);
        const pill = document.querySelector('[data-testid="model-picker-pill"]');
        return {
          routingMode: pill ? pill.getAttribute('data-routing-mode') : null,
          pillText: pill ? pill.textContent : '',
          theme: document.querySelector('.app')?.getAttribute('data-theme'),
          chatWidth: document.querySelector('.app')?.getAttribute('data-chat-width'),
        };
      }`);
      if (r1 && r1.__err) throw new Error('Stage 1 JS error: ' + r1.__err);
      assert.strictEqual(r1.routingMode, 'orchestrator', JSON.stringify(r1));
      assert.strictEqual(r1.theme, 'light');
      assert.strictEqual(r1.chatWidth, 'wide');
      console.log('STAGE_1_OK', JSON.stringify(r1));
    } else if (stage === 2 || stage === 3) {
      // Re-open (Stage 2: same userData; Stage 3: brand-new empty userData!) and verify EVERYTHING persisted!
      const restored = await runJs(`async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const pill = document.querySelector('[data-testid="model-picker-pill"]');
        const swarmBtn = document.querySelector('button.swarm-pill');
        window.__akronTestHarness.openSettings('orchestrator');
        await sleep(300);
        const orchCb = document.querySelector('[data-testid="orch-enable-checkbox"]');
        const selects = Array.from(document.querySelectorAll('.settings-body select'));
        const hp = selects.find((el) => Array.from(el.options).some((o) => o.value === 'architect'));
        window.__akronTestHarness.openSettings('system');
        await sleep(250);
        const labels = Array.from(document.querySelectorAll('.settings-body label.check'));
        const trayLbl = labels.find((l) => /system tray/i.test(l.textContent || ''));
        const trayCb = trayLbl ? trayLbl.querySelector('input[type="checkbox"]') : null;
        window.__akronTestHarness.openSettings('browser');
        await sleep(250);
        const bSelects = Array.from(document.querySelectorAll('.settings-body select'));
        const linkSel = bSelects.find((el) => Array.from(el.options).some((o) => o.value === 'external'));
        return {
          routingMode: pill ? pill.getAttribute('data-routing-mode') : null,
          orchChecked: orchCb ? orchCb.checked : null,
          harnessProfile: hp ? hp.value : null,
          theme: document.querySelector('.app')?.getAttribute('data-theme'),
          chatWidth: document.querySelector('.app')?.getAttribute('data-chat-width'),
          keepInTray: trayCb ? trayCb.checked : null,
          browserLinkMode: linkSel ? linkSel.value : null,
          swarmPressed: swarmBtn ? swarmBtn.getAttribute('aria-pressed') : null,
        };
      }`);
      if (restored && restored.__err) throw new Error(`Stage ${stage} JS error: ` + restored.__err);
      assert.strictEqual(restored.orchChecked, true, 'orchChecked must stay true on stage ' + stage + ': ' + JSON.stringify(restored));
      assert.strictEqual(restored.routingMode, 'orchestrator', 'routingMode must stay orchestrator on stage ' + stage);
      assert.strictEqual(restored.harnessProfile, 'architect');
      assert.strictEqual(restored.theme, 'light');
      assert.strictEqual(restored.chatWidth, 'wide');
      assert.strictEqual(restored.keepInTray, true);
      assert.strictEqual(restored.browserLinkMode, 'external');
      assert.strictEqual(restored.swarmPressed, 'true');
      console.log(`STAGE_${stage}_OK`, JSON.stringify(restored));
    } else if (stage === 4) {
      // Explicitly disable Orchestrator and check disk + composer reset cleanly
      await win.webContents.executeJavaScript(`(() => {
        window.__akronTestHarness.openSettings('orchestrator');
      })()`);
      await sleep(300);
      await win.webContents.executeJavaScript(`(() => {
        const cb = document.querySelector('[data-testid="orch-enable-checkbox"]');
        if (cb && cb.checked) cb.click();
        window.__akronTestHarness.closeSettings();
      })()`);
      await sleep(350);
      const disabledState = await win.webContents.executeJavaScript(`(() => {
        const pill = document.querySelector('[data-testid="model-picker-pill"]');
        return { routingMode: pill ? pill.getAttribute('data-routing-mode') : null };
      })()`);
      assert.strictEqual(disabledState.routingMode, 'direct');
      console.log('STAGE_4_OK', JSON.stringify(disabledState));
    } else if (stage === 5) {
      const verifyOff = await win.webContents.executeJavaScript(`(() => {
        const pill = document.querySelector('[data-testid="model-picker-pill"]');
        window.__akronTestHarness.openSettings('orchestrator');
        return new Promise((resolve) => setTimeout(() => {
          const cb = document.querySelector('[data-testid="orch-enable-checkbox"]');
          resolve({ routingMode: pill ? pill.getAttribute('data-routing-mode') : null, orchChecked: cb ? cb.checked : null });
        }, 300));
      })()`);
      assert.strictEqual(verifyOff.orchChecked, false);
      assert.strictEqual(verifyOff.routingMode, 'direct');
      console.log('STAGE_5_OK', JSON.stringify(verifyOff));
    }

    app.exit(0);
  }).catch((err) => {
    console.error(err);
    app.exit(1);
  });
} else {
  const electronBin = require('electron');
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-persist-e2e-'));
  const tmpHome = path.join(tmpBase, 'home');
  const tmpUserData1 = path.join(tmpBase, 'userdata-1');
  const tmpUserData2 = path.join(tmpBase, 'userdata-wiped');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(tmpUserData1, { recursive: true });
  fs.mkdirSync(tmpUserData2, { recursive: true });

  const runStage = (stage, userDataDir) => {
    const res = spawnSync(electronBin, ['--user-data-dir=' + userDataDir, __filename, '--worker'], {
      cwd: REPO,
      env: { ...process.env, HOME: tmpHome, AKRON_PERSIST_STAGE: String(stage), AKRON_NO_DIALOG: '1' },
      encoding: 'utf8',
    });
    if (res.stdout) process.stdout.write(res.stdout);
    if (res.stderr && res.status !== 0) process.stderr.write(res.stderr);
    assert.strictEqual(res.status, 0, `Stage ${stage} exited with ${res.status}: ${res.stderr}`);
  };

  try {
    runStage(1, tmpUserData1); // Configure Orchestrator ON + Settings
    runStage(2, tmpUserData1); // Close & Reopen (same profile)
    runStage(3, tmpUserData2); // Close & Reopen with wiped localStorage (fresh userData, same HOME/.autobot)
    runStage(4, tmpUserData1); // Disable Orchestrator explicitly
    runStage(5, tmpUserData1); // Reopen & confirm stays disabled
    console.log('SETTINGS_PERSISTENCE_E2E_OK');
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}
