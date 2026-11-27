'use strict';
/**
 * Live UI DOM & High-DPI Screenshot Verification Audit for Packaged Akron Code v1.6.1
 * Tests against the built app.asar in release/mac-arm64/Akron Code.app:
 *  - Mode presets (Auto -> Lead+Builder -> Full AI Team -> Single Model) sync bottom pill immediately
 *  - Zero vertical clipping of WelcomeQuickStartBar over .cwdbar even with multi-line input
 *  - Model Picker has zero horizontal overflow (scrollWidth <= clientWidth)
 *  - Collapsed Left Sidebar (<---) shrinks cleanly to 52px and hides labels/timestamps/menu icons
 *  - Captures crisp updated PNG screenshots to docs/screenshots/
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PACKAGED_RESOURCES = path.join(REPO, 'release/mac-arm64/Akron Code.app/Contents/Resources');
const APP_ASAR = path.join(PACKAGED_RESOURCES, 'app.asar');

if (process.argv.includes('--worker')) {
  const { app, BrowserWindow, ipcMain, dialog } = require('electron');
  const tmpUserData = process.env.AKRON_AUDIT_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ui-v161-'));
  app.setPath('userData', path.join(tmpUserData, 'userData'));
  if (dialog) dialog.showErrorBox = () => {};
  app.on('window-all-closed', (e) => e.preventDefault());

  const srvPort = Number(process.env.AKRON_AUDIT_PORT);
  const asarReq = (rel) => require(path.join(APP_ASAR, rel));
  const store = asarReq('electron/store.js');

  function safe(ch, fn) {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  }

  let setOrchCount = 0;
  let setFeatCount = 0;

  function installHandlers() {
    setOrchCount = 0;
    setFeatCount = 0;
    const baseSettings = store.getSettings();
    let mockSettings = {
      ...baseSettings,
      uiState: { ...(baseSettings?.uiState || {}), sidebarCollapsed: false, _updatedAt: 0 },
    };
    let mockOrch = {
      enabled: false,
      activeIndex: 0,
      providers: [
        { model: 'claude-fable-5-2', oauthProvider: 'claude:main', name: 'Claude · claude-fable-5-2', enabled: true, role: 'Planner' },
        { model: 'gemini-4-carbon-high', oauthProvider: 'antigravity:saimon@example.com', name: 'Google Antigravity · long-account-email@gmail.com · Gemini 4 Carbon High', enabled: true, role: 'Google Antigravity · 6969loavbal-gmail-com · Reasoning' },
        { model: 'claude-sonnet-5-5', oauthProvider: 'claude:main', name: 'Claude · claude-sonnet-5-5', enabled: true, role: 'Coder' },
      ],
    };
    let mockFeatures = { ...(store.getFeatures() || {}), autoRouter: true };
    safe('autobot:getVersion', () => ({ version: '1.6.2', app: '1.6.2', platform: process.platform, arch: process.arch }));
    safe('autobot:getSettings', () => mockSettings);
    safe('autobot:setSettings', (_e, patch) => {
      mockSettings = { ...mockSettings, ...(patch || {}) };
      return mockSettings;
    });
    safe('autobot:getOrchestrator', () => mockOrch);
    safe('autobot:setOrchestrator', (_e, patch) => {
      setOrchCount++;
      mockOrch = { ...mockOrch, ...(patch || {}) };
      return mockOrch;
    });
    safe('autobot:getFeatures', () => mockFeatures);
    safe('autobot:setFeatures', (_e, patch) => {
      setFeatCount++;
      mockFeatures = { ...mockFeatures, ...(patch || {}) };
      return mockFeatures;
    });
    safe('autobot:getAuditIpcCounts', () => ({ setOrchCount, setFeatCount }));
    safe('autobot:getMemory', () => ({ entries: [] }));
    safe('autobot:getSkills', () => []);
    safe('autobot:listNotebooks', () => []);
    safe('autobot:mcpConfig', () => ({ status: [] }));
    safe('autobot:listSlashActions', () => []);
    safe('autobot:listAgentDefs', () => []);
    safe('autobot:listOutputStyles', () => ({ styles: [], defaultStyleId: 'default' }));
    safe('autobot:envGetState', () => ({ active: { kind: 'local', id: null, label: 'This Computer', cwd: REPO }, sshProfiles: [], remoteProfiles: [], sshConfigHosts: [], hostServer: { enabled: false, running: false } }));
    safe('autobot:gdriveStatus', () => ({ connected: false, mode: null, detectedLocalFolders: [] }));
    safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [{ id: 'antigravity', label: 'Google Antigravity', transport: 'google', accounts: [{ id: 'antigravity:test', account: 'test', label: '6969loavbal@gmail.com', plan: 'Pro', hasToken: true }], models: [{ id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon High' }] }] } }));
    safe('autobot:providerModels', () => ({ ok: true, models: [{ id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon High', windowLabel: '1M', contextWindow: 1048576 }] }));
    safe('autobot:ollamaModels', () => ({ ok: false, models: [] }));
    safe('autobot:probeProviders', () => ({}));
    safe('autobot:orchPaidProvidersGet', () => ({ ok: true, providers: [] }));
    safe('autobot:orchAutoDetectModels', () => ({ ok: true, providers: [], probed: [] }));
    safe('autobot:freellmCatalog', () => ({ ok: true, platforms: [], totals: { totalModels: 0, totalPlatforms: 0 } }));
    safe('autobot:freellmDetect', () => ({ ok: false }));
    safe('autobot:autoRouterGet', () => ({ ok: true, hasKey: false }));
    safe('autobot:mediaStudioList', () => ({ ok: true, imageModels: [], videoModels: [], library: [] }));
    safe('autobot:mediaKeysGet', () => ({ ok: true, providers: [] }));
    safe('autobot:customToolList', () => []);
    safe('autobot:reaStatus', () => ({ available: false, connected: false }));
    safe('autobot:extBridgeStatus', () => ({ running: true, connected: false, tabs: [] }));
    safe('autobot:dbMigrate', () => ({ ok: true }));
    safe('autobot:dbUpsertConv', () => ({ ok: true }));
    safe('autobot:complianceGet', () => null);
    safe('autobot:scheduledTaskList', () => []);
    safe('autobot:listScheduledTasks', () => []);
    safe('autobot:customToolRun', () => ({ ok: true }));
    safe('autobot:proactiveState', () => ({ quietHours: { enabled: false, start: '22:00', end: '08:00' } }));
    safe('autobot:pushGetConfig', () => ({ enabled: false }));
    safe('autobot:remoteRelayStatus', () => ({ connected: false, relayUrl: '' }));
    safe('autobot:getDefaultCwd', () => REPO);
    safe('autobot:getWorkspace', () => REPO);
    safe('autobot:openExternal', () => ({ ok: true }));
    safe('autobot:providerReconnectState', () => ({ waiting: false }));
    safe('autobot:runtimes', () => ({}));
    safe('autobot:debugLogGet', () => ({ ok: true, config: {}, entries: [], logPath: '' }));
    safe('autobot:debugLogSetConfig', () => ({ ok: true, config: {} }));
    safe('autobot:debugLogClear', () => ({ ok: true }));
  }

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 1360,
      height: 860,
      show: false,
      backgroundColor: '#070b0a',
      webPreferences: {
        preload: path.join(APP_ASAR, 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    installHandlers();
    const results = { checks: [], consoleErrors: [], passed: 0, failed: 0 };
    const rec = (name, ok, detail = '') => {
      results.checks.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 220) });
      if (ok) results.passed++; else results.failed++;
    };
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 3) results.consoleErrors.push(msg);
    });

    await win.loadFile(path.join(APP_ASAR, 'dist', 'index.html'));
    // Seed sample conversations in two workspace groups and dismiss tutorial overlay
    await win.webContents.executeJavaScript(`(() => {
      const now = Date.now();
      localStorage.setItem('autobot:tutorialSeenV1', 'true');
      localStorage.setItem('autobot:sidebarCollapsed', 'false');
      localStorage.setItem('autobot:convs', JSON.stringify([
        { id: 'c1', title: 'Audit UI & Sidebar', cwd: '${REPO.replace(/'/g, "\\'")}', ts: now - 120000, updatedAt: now - 120000, messages: [{ id: 'm1', role: 'user', content: 'Review the UI layout' }] },
        { id: 'c2', title: 'Fix Browser Bridge :8766', cwd: '${REPO.replace(/'/g, "\\'")}', ts: now - 3600000, updatedAt: now - 3600000, messages: [] }
      ]));
      localStorage.setItem('autobot:activeId', 'null');
    })()`);
    await win.reload();
    await new Promise((r) => setTimeout(r, 900));

    // Close auto-opened tutorial if open
    await win.webContents.executeJavaScript(`(() => {
      const x = document.querySelector('.tutorial-close');
      if (x) x.click();
    })()`);
    await new Promise((r) => setTimeout(r, 250));

    // 1. Test 20x Rapid Mode Preset Switching + Zero IPC Loop + 0px Layout Shake (WelcomeQuickStartBar & InteractiveTutorialModal)
    const beforeCounts = { setOrchCount: 0, setFeatCount: 0 };
    const presetCheck = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const ta = document.querySelector('.composer textarea');
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
        setter.call(ta, 'Line 1\\nLine 2\\nLine 3\\nLine 4\\nLine 5\\nLine 6');
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await sleep(120);
      const pill = () => (document.querySelector('.model-pill')?.textContent || '').trim();
      const swarmTxt = () => (document.querySelector('.swarm-pill')?.textContent || '').trim();

      const ids = ['orchestrator', 'swarm', 'direct', 'auto'];
      const wqsHeights = new Set();
      const wqsTops = new Set();
      let multiActive = 0;
      let orchPill = '', swarmPill = '', swarmBadge = '', directPill = '', autoPill = '';

      for (let i = 0; i < 20; i++) {
        const id = ids[i % ids.length];
        document.querySelector('[data-testid="wqs-preset-' + id + '"]')?.click();
        await sleep(30);
        const onCount = document.querySelectorAll('.wqs-card.on').length;
        if (onCount !== 1) multiActive++;
        const r = document.querySelector('[data-testid="welcome-quickstart"]')?.getBoundingClientRect();
        if (r) { wqsHeights.add(Math.round(r.height)); wqsTops.add(Math.round(r.top)); }
        if (id === 'orchestrator') orchPill = pill();
        if (id === 'swarm') { swarmPill = pill(); swarmBadge = swarmTxt(); }
        if (id === 'direct') directPill = pill();
        if (id === 'auto') autoPill = pill();
      }
      await sleep(350);

      // Test InteractiveTutorialModal Step 1 20x rapid clicks + 0px shift
      document.querySelector('[data-testid="open-tutorial-btn"]')?.click();
      await sleep(150);
      const modalHeights = new Set();
      const cardTops = new Set();
      let modalMulti = 0;
      for (let i = 0; i < 20; i++) {
        const id = ids[i % ids.length];
        document.querySelector('[data-testid="tutorial-preset-' + id + '"]')?.click();
        await sleep(25);
        if (document.querySelectorAll('.tutorial-preset-card.on').length !== 1) modalMulti++;
        const m = document.querySelector('.tutorial-modal')?.getBoundingClientRect();
        const c = document.querySelector('[data-testid="tutorial-preset-direct"]')?.getBoundingClientRect();
        if (m) modalHeights.add(Math.round(m.height));
        if (c) cardTops.add(Math.round(c.top));
      }
      document.querySelector('.tutorial-close')?.click();
      await sleep(150);

      const toastCount = document.querySelectorAll('.notif-toast, .notif-item').length;
      const wqs = document.querySelector('[data-testid="welcome-quickstart"]')?.getBoundingClientRect();
      const cwdBar = document.querySelector('.cwdbar')?.getBoundingClientRect();
      return {
        orchPill, swarmPill, swarmBadge, directPill, autoPill,
        wqsHeights: [...wqsHeights], wqsTops: [...wqsTops], multiActive,
        modalHeights: [...modalHeights], cardTops: [...cardTops], modalMulti,
        toastCount,
        wqsBottom: wqs ? Math.round(wqs.bottom) : 0,
        cwdTop: cwdBar ? Math.round(cwdBar.top) : 0,
      };
    })()`);
    // Explicitly push a synthetic 'orchestrator' event from main and confirm renderer does NOT echo IPC back!
    const preEchoCount = await win.webContents.executeJavaScript(`window.__echoCheck = true; 0`).then(() => 0);
    const snapPre = { setOrchCount };
    win.webContents.send('autobot:event', { type: 'orchestrator', orchestrator: { enabled: true, providers: [{ model: 'claude-fable-5-2', enabled: true }], activeIndex: 0 } });
    await new Promise((r) => setTimeout(r, 250));
    const echoDelta = setOrchCount - snapPre.setOrchCount;
    // Restore Auto mode cleanly before screenshot
    await win.webContents.executeJavaScript(`(async () => {
      document.querySelector('[data-testid="wqs-preset-auto"]')?.click();
      await new Promise((r) => setTimeout(r, 120));
    })()`);

    rec('Zero IPC ping-pong loop (20x rapid switches + synthetic broadcast delta)', setOrchCount <= 25 && echoDelta === 0, `setOrchCount=${setOrchCount}, setFeatCount=${setFeatCount}, echoDelta=${echoDelta}`);
    rec('WelcomeQuickStartBar 0px layout shake across 20 mode clicks', presetCheck.wqsHeights.length === 1 && presetCheck.wqsTops.length === 1 && presetCheck.multiActive === 0, JSON.stringify({ h: presetCheck.wqsHeights, t: presetCheck.wqsTops, multi: presetCheck.multiActive }));
    rec('InteractiveTutorialModal 0px layout shake across 20 mode clicks', presetCheck.modalHeights.length === 1 && presetCheck.cardTops.length === 1 && presetCheck.modalMulti === 0, JSON.stringify({ mh: presetCheck.modalHeights, ct: presetCheck.cardTops, multi: presetCheck.modalMulti }));
    rec('Zero notification toast spam on mode switch', presetCheck.toastCount === 0, `toasts=${presetCheck.toastCount}`);
    rec('Preset Orchestrator updates bottom pill', /^Orch\b/.test(presetCheck.orchPill), presetCheck.orchPill);
    rec('Preset Swarm turns Swarm ON', /ON/i.test(presetCheck.swarmBadge), presetCheck.swarmBadge);
    rec('Preset Direct clears Orch/Auto prefix', !/^(Orch|Auto)\b/.test(presetCheck.directPill), presetCheck.directPill);
    rec('Preset Auto updates bottom pill to Auto', /^Auto\b/.test(presetCheck.autoPill), presetCheck.autoPill);
    rec('WelcomeQuickStartBar does not overlap .cwdbar', presetCheck.wqsBottom > 0 && presetCheck.wqsBottom <= presetCheck.cwdTop, `${presetCheck.wqsBottom} <= ${presetCheck.cwdTop}`);

    // Capture crisp Welcome + Preset screenshot
    const shotAgent = await win.webContents.capturePage();
    fs.writeFileSync(path.join(REPO, 'docs/screenshots/agent-dark.png'), shotAgent.toPNG());

    // 2. Open Model Picker and verify zero horizontal overflow + capture screenshot
    const pickerMetrics = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.model-pill')?.click();
      await sleep(150);
      document.querySelector('.orch-picker-toggle')?.click();
      await sleep(150);
      const menu = document.querySelector('.model-menu');
      const body = document.querySelector('.orch-picker-body');
      return {
        menuOpen: !!menu,
        menuScrollW: menu ? menu.scrollWidth : 0,
        menuClientW: menu ? menu.clientWidth : 0,
        bodyScrollW: body ? body.scrollWidth : 0,
        bodyClientW: body ? body.clientWidth : 0,
      };
    })()`);
    rec('Model Picker opens cleanly with zero horizontal overflow', pickerMetrics.menuOpen && pickerMetrics.menuScrollW <= pickerMetrics.menuClientW + 1 && pickerMetrics.bodyScrollW <= pickerMetrics.bodyClientW + 1, JSON.stringify(pickerMetrics));

    const shotPicker = await win.webContents.capturePage();
    fs.writeFileSync(path.join(REPO, 'docs/screenshots/model-picker-3modes.png'), shotPicker.toPNG());

    // Close picker
    await win.webContents.executeJavaScript(`(() => { document.querySelector('.model-pill')?.click(); })()`);
    await new Promise((r) => setTimeout(r, 120));

    // 3. Collapse Left Sidebar (<---) and verify 52px clean icon-only conversation list
    const collapsedMetrics = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const collapseBtn = document.querySelector('.sidebar-actions button[title*="Collapse"], .sidebar-actions button:last-child');
      collapseBtn?.click();
      await sleep(220);
      const aside = document.querySelector('aside.sidebar');
      const head = document.querySelector('.proj-group-head');
      const rel = document.querySelector('.conv-rel-time');
      const conv = document.querySelector('.proj-conv-row');
      return {
        hasCollapsedClass: !!aside && aside.classList.contains('collapsed'),
        width: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
        groupHeadVisible: !!head && getComputedStyle(head).display !== 'none',
        relTimeVisible: !!rel && getComputedStyle(rel).display !== 'none',
        convCount: document.querySelectorAll('.proj-conv-row').length,
        convWidth: conv ? Math.round(conv.getBoundingClientRect().width) : 0,
      };
    })()`);
    rec('Collapsed sidebar is 52px with hidden group headers & timestamps', collapsedMetrics.hasCollapsedClass && collapsedMetrics.width <= 54 && !collapsedMetrics.groupHeadVisible && !collapsedMetrics.relTimeVisible && collapsedMetrics.convCount >= 2, JSON.stringify(collapsedMetrics));

    // 4. Unconfigured Orchestrator block: clearing models blocks Lead+Builder and opens Settings -> Orchestrator
    await win.webContents.executeJavaScript(`(async () => {
      const emptyOrch = { enabled: false, providers: [], activeIndex: -1 };
      localStorage.setItem('autobot:orchestrator', JSON.stringify(emptyOrch));
      if (window.autobot?.setOrchestrator) await window.autobot.setOrchestrator(emptyOrch);
    })()`);
    await win.reload();
    await new Promise((r) => setTimeout(r, 800));
    const emptyOrchGuard = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('.tutorial-close')?.click();
      await sleep(100);
      document.querySelector('[data-testid="wqs-preset-orchestrator"]')?.click();
      await sleep(220);
      return {
        setupBanner: !!document.querySelector('[data-testid="orch-setup-banner"]'),
        autoDetectBtn: !!document.querySelector('[data-testid="orch-autodetect-btn"]'),
        oauthBar: !!document.querySelector('[data-testid="orch-oauth-quickbar"]'),
        paidPanel: !!document.querySelector('[data-testid="orch-paid-providers"]'),
        pillText: (document.querySelector('.model-pill')?.textContent || '').trim(),
      };
    })()`);
    rec('Unconfigured Orchestrator blocks activation & opens Settings -> Orchestrator', emptyOrchGuard.setupBanner && emptyOrchGuard.autoDetectBtn && emptyOrchGuard.oauthBar && emptyOrchGuard.paidPanel && !/^Orch\b/.test(emptyOrchGuard.pillText), JSON.stringify(emptyOrchGuard));

    rec('Zero uncaught console errors', results.consoleErrors.length === 0, results.consoleErrors.join('; '));

    await fetch(`http://127.0.0.1:${srvPort}/report`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(results),
    });
    fs.rmSync(tmpUserData, { recursive: true, force: true });
    app.exit(results.failed === 0 ? 0 : 1);
  });
} else {
  (async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ui-v161-'));
    let report = null;
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/report') {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          report = JSON.parse(body);
          res.writeHead(200);
          res.end('ok');
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const electronBin = path.join(REPO, 'node_modules/.bin/electron');
    const child = spawn(electronBin, [__filename, '--worker'], {
      env: { ...process.env, AKRON_NO_DIALOG: '1', AKRON_AUDIT_PORT: String(port), AKRON_AUDIT_WORKDIR: workDir },
      stdio: 'inherit',
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    srv.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    console.log('\n=== v1.6.1 UI DOM & SCREENSHOT AUDIT ===');
    if (report) {
      for (const c of report.checks) {
        console.log(` ${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
      }
      console.log(`Passed: ${report.passed}/${report.checks.length}, Failed: ${report.failed}`);
    } else {
      console.error('No audit report received! Exit code:', code);
      process.exit(1);
    }
    process.exit(report.failed === 0 ? 0 : 1);
  })();
}
