'use strict';
/**
 * Physical In-App Human Combination Audit for Packaged Akron Code v1.6.0 (app.asar).
 * Boots a real Chromium/Electron BrowserWindow from the packaged app.asar bundle,
 * clicks real UI workflows as a human would, invokes packaged main-process tools,
 * and verifies zero runtime/packaging errors.
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
  app.setPath('userData', path.join(os.homedir(), 'userData'));
  if (dialog) dialog.showErrorBox = () => {};
  app.on('window-all-closed', (e) => e.preventDefault());

  const workDir = process.env.AKRON_AUDIT_WORKDIR;
  const srvPort = Number(process.env.AKRON_AUDIT_PORT);
  const asarReq = (rel) => require(path.join(APP_ASAR, rel));

  const computer = asarReq('electron/computer.js');
  const editGuard = asarReq('electron/ide/edit-guard.js');
  const webSearch = asarReq('electron/tools/web-search.js');
  const dbg = asarReq('electron/debug-logger.js');
  const repl = asarReq('electron/repl.js');
  const buildExecs = asarReq('electron/tools/browser-executors.js');
  const store = asarReq('electron/store.js');
  const appSys = asarReq('electron/app-system.js');
  const diag = asarReq('electron/diagnostics.js');

  function safe(ch, fn) {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  }

  function installHandlers() {
    safe('autobot:getVersion', () => ({ version: '1.6.0', app: '1.6.0', platform: process.platform, arch: process.arch }));
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
    safe('autobot:envGetState', () => ({ active: { kind: 'local', id: null, label: 'This Computer', cwd: workDir }, sshProfiles: [], remoteProfiles: [], sshConfigHosts: [], hostServer: { enabled: false, running: false } }));
    safe('autobot:gdriveStatus', () => ({ connected: false, mode: null, detectedLocalFolders: [] }));
    safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [{ id: 'antigravity', label: 'Google / Antigravity', transport: 'google', accounts: [{ id: 'antigravity:test', account: 'test', label: 'test@example.com', plan: 'Free', hasToken: true }], models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' }] }] } }));
    safe('autobot:providerModels', () => ({ ok: true, models: [{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', windowLabel: '1M', contextWindow: 1048576 }] }));
    safe('autobot:ollamaModels', () => ({ ok: false, models: [] }));
    safe('autobot:probeProviders', () => ({}));
    safe('autobot:orchPaidProvidersGet', () => ({ ok: true, providers: [] }));
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
    safe('autobot:getDefaultCwd', () => workDir);
    safe('autobot:getWorkspace', () => workDir);
    safe('autobot:openExternal', () => ({ ok: true }));
    safe('autobot:providerReconnectState', () => ({ waiting: false }));
    safe('autobot:runtimes', () => ({}));
    safe('autobot:generateDiagnostics', (_e, p = {}) => diag.generateDiagnosticBundle({ appVersion: '1.6.0', ...p }));
    safe('autobot:debugLogGet', (_e, limit = 100) => ({ ok: true, config: dbg.getConfig(), entries: dbg.tail(limit), logPath: dbg.logFilePath() }));
    safe('autobot:debugLogSetConfig', (_e, patch = {}) => ({ ok: true, config: dbg.setConfig(patch || {}) }));
    safe('autobot:debugLogClear', () => dbg.clear());
    safe('autobot:debugLogSendReport', async (_e, payload = {}) => dbg.sendReportNow(payload || {}));
  }

  app.whenReady().then(async () => {
    const win = new BrowserWindow({
      width: 1280,
      height: 820,
      show: false,
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
    let uiRes = {};
    try {
    uiRes = await win.webContents.executeJavaScript(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const waitSel = async (sel, ms = 6000) => {
        const end = Date.now() + ms;
        while (Date.now() < end) {
          const el = document.querySelector(sel);
          if (el) return el;
          await sleep(50);
        }
        throw new Error('Missing selector: ' + sel + ' | MAIN=' + (document.querySelector('.main-content')?.innerHTML || document.body.innerHTML).slice(0, 700));
      };
      const out = {};
      const pill = await waitSel('[data-testid="model-picker-pill"]');

      // 1. Switch presets on welcome QuickStart bar
      (await waitSel('[data-testid="wqs-preset-orchestrator"]')).click();
      await sleep(120);
      out.orchRouting = pill.getAttribute('data-routing-mode');

      (await waitSel('[data-testid="wqs-preset-swarm"]')).click();
      await sleep(120);
      out.swarmOn = document.querySelector('.swarm-pill')?.getAttribute('aria-pressed');

      (await waitSel('[data-testid="wqs-preset-auto"]')).click();
      await sleep(120);
      out.autoRouting = pill.getAttribute('data-routing-mode');
      out.swarmOff = document.querySelector('.swarm-pill')?.getAttribute('aria-pressed');

      // 2. Open Tutorial & search How-To Guide
      (await waitSel('[data-testid="sidebar-tutorial-btn"]')).click();
      await waitSel('.tutorial-modal');
      const tabs = Array.from(document.querySelectorAll('.tutorial-tab'));
      const guideTab = tabs.find((b) => /How-To Guide/i.test(b.textContent || ''));
      if (guideTab) guideTab.click();
      await sleep(100);
      const searchIn = await waitSel('.tg-search input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(searchIn, 'swarm');
      searchIn.dispatchEvent(new Event('input', { bubbles: true }));
      await sleep(80);
      out.guideHits = document.querySelectorAll('.tg-card').length;
      (await waitSel('[data-testid="tutorial-done-btn"]')).click();
      await sleep(80);

      // 3. Create Session 1 (via slash /status), then click + for parallel Session 2 (/status)
      const composer = await waitSel('.composer textarea');
      const setArea = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setArea.call(composer, '/status');
      composer.dispatchEvent(new Event('input', { bubbles: true }));
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(200);
      const tabsAfter1 = document.querySelectorAll('.ws-tab').length;
      (await waitSel('.ws-tab-add')).click();
      await sleep(150);
      const composer2 = await waitSel('.composer textarea');
      setArea.call(composer2, '/session');
      composer2.dispatchEvent(new Event('input', { bubbles: true }));
      composer2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await sleep(200);
      const tabsAfter2 = document.querySelectorAll('.ws-tab').length;
      out.tabsDelta = tabsAfter2 - tabsAfter1;
      out.tabsTotal = tabsAfter2;

      // 4. Open Settings -> Give Feedback & Live Debug Log
      (await waitSel('.sidebar-settings-btn')).click();
      await sleep(250);
      const navBtns = Array.from(document.querySelectorAll('.settings-nav button'));
      const fbBtn = navBtns.find((b) => /Give Feedback/i.test(b.textContent || ''));
      if (fbBtn) fbBtn.click();
      await waitSel('[data-testid="debug-log-section"]');
      (await waitSel('[data-testid="generate-diag-btn"]')).click();
      const preview = await waitSel('[data-testid="diag-bundle-preview"]');
      out.diagLen = (preview.textContent || '').length;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return out;
    })()`);
    } catch (uiErr) {
      rec('UI Suite Exception', false, uiErr && uiErr.message ? uiErr.message : String(uiErr));
    }

    rec('UI Presets (Auto/Orchestrator/Swarm)', uiRes.orchRouting === 'orchestrator' && uiRes.swarmOn === 'true' && uiRes.autoRouting === 'auto' && uiRes.swarmOff === 'false', JSON.stringify(uiRes));
    rec('UI Interactive Tutorial & Guide Filter', uiRes.guideHits >= 1, `guideHits=${uiRes.guideHits}`);
    rec('UI Parallel New Tab (+)', uiRes.tabsDelta >= 1, `delta=${uiRes.tabsDelta}`);
    rec('UI Settings -> Give Feedback & Debug Log', uiRes.diagLen > 80, `diagLen=${uiRes.diagLen}`);

    // Packaged app.asar live main-process checks
    try {
      const s = await computer.screenshot({ dir: workDir });
      rec('Packaged app.asar :: computer.screenshot', Boolean(s && s.size > 100 && s.width > 0), `${s.width}x${s.height} ${s.size}B`);
    } catch (e) { rec('Packaged app.asar :: computer.screenshot', false, e.message); }

    try {
      const z = await computer.zoom({ x1: 10, y1: 10, x2: 260, y2: 200, dir: workDir });
      rec('Packaged app.asar :: computer.zoom', Boolean(z && z.size > 100), `${z.size}B`);
    } catch (e) { rec('Packaged app.asar :: computer.zoom', false, e.message); }

    try {
      const a = await computer.appScreenshot({ app: 'Akron', dir: workDir });
      rec('Packaged app.asar :: computer.appScreenshot', Boolean(a && a.size > 100), `${a.size}B`);
    } catch (e) { rec('Packaged app.asar :: computer.appScreenshot', false, e.message); }

    try {
      const ax = await computer.axFind({ app: 'Akron Code', maxResults: 15 });
      rec('Packaged app.asar :: computer.axFind (self ARIA fallback)', Array.isArray(ax) && ax.length > 0, `items=${ax.length}`);
    } catch (e) { rec('Packaged app.asar :: computer.axFind (self ARIA fallback)', false, e.message); }

    // Real packaged app.asar esbuild ENOTDIR fix + .mjs syntax check!
    const goodMjs = path.join(workDir, 'live-good.mjs');
    const badMjs = path.join(workDir, 'live-bad.mjs');
    fs.writeFileSync(goodMjs, 'export const live = 42;\nexport function hi() { return "ok"; }\n');
    fs.writeFileSync(badMjs, 'export const bad = ;\n');
    const dGood = editGuard.collectPostEditDiagnostics(goodMjs, workDir);
    const dBad = editGuard.collectPostEditDiagnostics(badMjs, workDir);
    fs.unlinkSync(badMjs);
    const shadow = await editGuard.runShadowCheck(workDir);
    rec('Packaged app.asar :: .mjs EditGuard & ShadowCheck', dGood === '' && /\[Syntax error/i.test(dBad) && !/ENOTDIR/.test(dGood) && shadow.ok === true, `dGood="${dGood}" shadow="${shadow.summary}"`);

    try {
      const ws = await webSearch.webSearch({ query: 'what is sqlite wal mode' });
      rec('Packaged app.asar :: WebSearch live', ws !== '(no results)' && ws.length > 80, `len=${ws.length}`);
    } catch (e) { rec('Packaged app.asar :: WebSearch live', false, e.message); }

    try {
      const execs = buildExecs({ truncate: (s) => s });
      const tabsOut = await execs.chrome_list_tabs();
      rec('Packaged app.asar :: mcp__chrome__list_tabs fallback', typeof tabsOut === 'string' && !/ECONNREFUSED/.test(tabsOut), tabsOut.slice(0, 120));
    } catch (e) { rec('Packaged app.asar :: mcp__chrome__list_tabs fallback', false, e.message); }

    try {
      const rr = await repl.evalJS({ code: 'typeof process.versions.node + ":" + typeof process.type', cwd: workDir });
      rec('Packaged app.asar :: isolated child REPL', rr.ok && rr.output.includes('string:undefined'), rr.output);
    } catch (e) { rec('Packaged app.asar :: isolated child REPL', false, e.message); }

    dbg.setConfig({ autoSend: true, endpointUrl: `http://127.0.0.1:${srvPort}/collect` });
    dbg.record('info', 'selftest', 'human-combo', 'Completed packaged app physical combination suite');
    const sent = await dbg.sendReportNow({ category: 'selftest', summary: 'Physical in-app combination suite' });
    rec('Packaged app.asar :: DebugLog & AutoSend', Boolean(sent.ok && sent.delivered), JSON.stringify(sent));
    rec('Zero renderer console errors', results.consoleErrors.length === 0, results.consoleErrors.join(' | '));

    console.log('HUMAN_COMBO_RESULT ' + JSON.stringify(results, null, 2));
    app.exit(results.failed > 0 ? 1 : 0);
  });
} else {
  async function runParent() {
    if (!fs.existsSync(APP_ASAR)) {
      console.error('Missing packaged app.asar:', APP_ASAR);
      process.exit(1);
    }
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-human-combo-'));
    const workDir = path.join(tmpHome, 'workspace');
    fs.mkdirSync(workDir, { recursive: true });

    const reports = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/collect' && req.method === 'POST') {
          try { reports.push(JSON.parse(body)); } catch (_) {}
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const srvPort = srv.address().port;

    const electronBin = path.join(REPO, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
    const code = await new Promise((resolve) => {
      const child = spawn(electronBin, [__filename, '--worker'], {
        cwd: REPO,
        stdio: 'inherit',
        env: {
          ...process.env,
          HOME: tmpHome,
          AKRON_NO_DIALOG: '1',
          AKRON_AUDIT_WORKDIR: workDir,
          AKRON_AUDIT_PORT: String(srvPort),
        },
      });
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve(1); }, 60000);
      child.on('exit', (c) => { clearTimeout(timer); resolve(c == null ? 1 : c); });
      child.on('error', () => { clearTimeout(timer); resolve(1); });
    });
    await new Promise((r) => srv.close(r));
    fs.rmSync(tmpHome, { recursive: true, force: true });

    console.log(`Collector HTTP received ${reports.length} scrubbed report(s).`);
    if (code !== 0 || reports.length < 1) process.exit(code || 1);
  }
  runParent().catch((e) => { console.error(e); process.exit(1); });
}
