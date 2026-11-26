const { dialog } = require('electron'); dialog.showErrorBox = () => {};
'use strict';

const { app, BrowserWindow, ipcMain } = require('electron');
app.on('window-all-closed', (e) => e.preventDefault());

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const SHOTS_DIR = path.join(REPO, 'docs', 'screenshots');

const { runAgent, normalizeProvider, humanizeLLMError } = require(path.join(REPO, 'electron/llm'));
const ideIpc = require(path.join(REPO, 'electron/ide/ipc'));
const browser = require(path.join(REPO, 'electron/browser'));
const depManager = require(path.join(REPO, 'electron/dep-manager'));
const environments = require(path.join(REPO, 'electron/environments'));
const brandGuard = require(path.join(REPO, 'electron/brand-guard'));

async function startMockServer() {
  const srv = http.createServer(async (req, res) => {
    if (req.url && req.url.startsWith('/preview')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Akron Preview Showcase</title>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0f172a; color: #f8fafc; display: grid; place-items: center; min-height: 100vh; }
    .hero-card { width: 460px; padding: 28px; border-radius: 16px; background: #1e293b; border: 1px solid #334155; box-shadow: 0 20px 50px rgba(0,0,0,.4); }
    .badge { display: inline-block; font-size: 12px; padding: 4px 10px; border-radius: 999px; background: rgba(16,185,129,.18); color: #34d399; font-weight: 600; }
    h1 { margin: 14px 0 8px; font-size: 26px; }
    p { margin: 0 0 18px; color: #94a3b8; line-height: 1.5; }
    .cta-btn { padding: 10px 18px; border-radius: 10px; border: 0; background: #10b981; color: #fff; font-weight: 600; font-size: 14px; cursor: pointer; }
  </style>
</head>
<body>
  <main class="hero-card" id="hero">
    <span class="badge">Akron Code Live</span>
    <h1>Inspectable App Preview</h1>
    <p>Hover any element in Inspect Mode to highlight its bounding box, inspect styles, and send DOM snapshots directly to the AI agent.</p>
    <button class="cta-btn" id="deployBtn" type="button">Deploy Application</button>
  </main>
</body>
</html>`);
      return;
    }

    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const isRound2 = body.messages && body.messages.some((m) => m.role === 'tool');
    if (!isRound2) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Reading src/app.js and summarizing architecture cleanly.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read_1', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ file_path: 'src/app.js' }) } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Reviewed `src/app.js` cleanly!\n\n- Exported `greet(name)` helper\n- Ready for production deployment across **macOS**, **Windows 11**, and **Linux**.' }, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { port: srv.address().port, close: () => srv.close() };
}

async function run() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-prod-gate-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.email', 'qa@akronlogic.com'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.name', 'Akron QA'], { cwd: wsDir });
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'src', 'app.js'), [
    'export function greet(name = "Akron Code") {',
    '  return `Hello, ${name}!`;',
    '}',
    '',
    'export function buildSummary(target) {',
    '  return { product: "Akron Code", target, status: "ready" };',
    '}',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# Akron Demo Workspace\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: wsDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: wsDir });
  // Create a live modification for Git / Agent Changes badges
  fs.writeFileSync(path.join(wsDir, 'src', 'app.js'), [
    'export function greet(name = "Akron Code") {',
    '  return `Welcome to ${name}!`;',
    '}',
    '',
    'export function buildSummary(target) {',
    '  return { product: "Akron Code", target, status: "verified" };',
    '}',
    '',
  ].join('\n'), 'utf8');

  const srv = await startMockServer();
  const baseURL = `http://127.0.0.1:${srv.port}/v1`;
  const previewURL = `http://127.0.0.1:${srv.port}/preview`;

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: '#131316',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  const pageErrors = [];
  win.webContents.on('pageerror', (err) => pageErrors.push(err.message));

  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };

  let curTheme = 'dark';
  safe('autobot:getVersion', () => ({ app: '1.0.0', electron: process.versions.electron }));
  safe('autobot:getSettings', () => ({ theme: curTheme, locale: 'en', provider: { baseURL, model: 'claude-sonnet-4-6', apiKey: 'mock-key' } }));
  safe('autobot:setSettings', (_e, p) => { if (p && p.theme) curTheme = p.theme; return p || {}; });
  safe('autobot:getFeatures', () => ({}));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => []);
  safe('autobot:getOrchestrator', () => ({ enabled: false, providers: [] }));
  safe('autobot:poolsPreset', () => ({ enabled: false, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [] } }));
  safe('autobot:freellmStatus', () => ({ running: false }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [], status: [] }));
  safe('autobot:extBridgeStatus', () => ({ running: false, port: 8766, extensionConnected: false, tabs: [] }));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:reaStatus', () => ({ available: true, toolCount: 263, connected: false }));
  safe('autobot:gitInfo', () => ({ isRepo: true, branch: 'main' }));
  safe('autobot:worktreeList', () => ({ isRepo: true, root: wsDir, worktrees: [{ path: wsDir, branch: 'main', main: true }] }));
  safe('autobot:devServerDetect', () => ({ detected: false }));
  safe('autobot:browserSyncTabs', () => ({ ok: true }));
  safe('autobot:resolveUrl', (_e, u) => u);
  safe('autobot:browserRegister', (_e, id) => browser.register(id));
  safe('autobot:browserUnregister', (_e, id) => browser.unregister(id));
  safe('autobot:browserGetURL', () => browser.getURL());
  safe('autobot:browserInspectSet', (_e, webContentsId, enabled) => browser.setInspectMode(webContentsId, enabled));
  safe('autobot:browserCaptureElement', (_e, webContentsId, rect) => browser.captureElementRect(webContentsId, rect));
  safe('autobot:browserToggleDevTools', (_e, webContentsId) => browser.toggleDevTools(webContentsId));
  safe('autobot:runtimes', () => ({ runtimes: [] }));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => wsDir);
  safe('autobot:getWorkspace', () => wsDir);
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false, detectedLocalFolders: [] }));
  safe('autobot:pluginStats', () => ({ total: 0, installed: 0, enabled: 0 }));
  safe('autobot:listPlugins', () => []);
  safe('autobot:ollamaModels', () => ({ ok: true, models: [] }));
  safe('autobot:listWorkspaceFiles', () => ['src/app.js', 'README.md']);
  safe('autobot:envGetState', () => environments.getState());
  safe('autobot:depsStatus', () => depManager.getDependenciesStatus());
  safe('autobot:updateCheck', () => ({ ok: true, available: false, currentVersion: '1.0.0', latestVersion: '1.0.0', channel: 'GitHub Releases (faysaliteng/akron-code)' }));
  safe('autobot:brandStatus', () => brandGuard.verifyBrandIntegrity());

  safe('autobot:run', async (_e, payload) => {
    const { runId, messages, provider, cwd } = payload;
    const send = (evt) => {
      if (!win.isDestroyed()) win.webContents.send('autobot:event', { runId, ...evt });
    };
    try {
      const finalMsgs = await runAgent({
        provider: normalizeProvider({ ...provider, baseURL, model: 'claude-sonnet-4-6', apiKey: 'mock-key' }),
        messages,
        cwd: cwd || wsDir,
        emit: send,
      });
      send({ type: 'complete', messages: finalMsgs });
      return { ok: true };
    } catch (err) {
      const m = humanizeLLMError(err);
      send({ type: 'error', message: m });
      return { ok: false, error: m };
    }
  });

  ideIpc.register({
    ipcMain,
    normalizeProvider,
    hydrateProvider: async (p) => ({ ...p, baseURL, apiKey: 'mock-key', model: 'claude-sonnet-4-6' }),
    hydrateOrchestrator: async (o) => ({ orch: o, dead: [] }),
    store: { getSettings: () => ({ provider: { baseURL, model: 'claude-sonnet-4-6', apiKey: 'mock-key' } }), getOrchestrator: () => ({ enabled: false, providers: [] }) },
    broadcast: () => {},
  });

  const snap = async (filename) => {
    await new Promise((r) => setTimeout(r, 350));
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(SHOTS_DIR, filename), img.toPNG());
    console.log('CAPTURED:', filename);
  };

  const waitForSel = async (sel, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const ok = await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:settings', JSON.stringify({ theme: 'dark', useMemory: true, locale: 'en' }));
    localStorage.setItem('autobot:provider', JSON.stringify({ baseURL: ${JSON.stringify(baseURL)}, model: 'claude-sonnet-4-6', apiKey: 'mock-key', supportsTools: true }));
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));

  // 1. Agent Workspace (Dark) with real completed tool-calling turn
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('textarea');
    ta.value = 'Inspect src/app.js and summarize readiness';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('button.send:not(.stop)').click();
  })()`);
  await waitForSel('.worked-chip', 10000).catch(() => {});
  await new Promise((r) => setTimeout(r, 900));
  await snap('agent-dark.png');

  // 2. IDE Workbench (Dark): open src/app.js in Monaco + Terminal + Agent Dock + 24px Status Bar
  await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('.ws-mode-btn'));
    const ideBtn = btns.find((b) => /IDE/i.test(b.textContent || ''));
    if (ideBtn) ideBtn.click();
  })()`);
  await waitForSel('.ide-status-bar', 6000);
  await new Promise((r) => setTimeout(r, 1000));
  await win.webContents.executeJavaScript(`(() => {
    const srcFolder = Array.from(document.querySelectorAll('.ide-tree-row')).find((r) => r.querySelector('.ide-tree-name')?.textContent?.trim() === 'src');
    if (srcFolder) srcFolder.click();
  })()`);
  await waitForSel('.ide-tree-row[title="src/app.js"]', 3000);
  await win.webContents.executeJavaScript(`(() => {
    const appFile = document.querySelector('.ide-tree-row[title="src/app.js"]') || Array.from(document.querySelectorAll('.ide-tree-row')).find((r) => r.querySelector('.ide-tree-name')?.textContent?.trim() === 'app.js');
    if (appFile) appFile.click();
  })()`);
  await waitForSel('.monaco-editor', 6000);
  await new Promise((r) => setTimeout(r, 1200));
  await snap('ide-dark.png');

  // 3. Switch back to Agent + Light Theme + capture Agent Light & IDE Light
  await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('.ws-mode-btn'));
    const agBtn = btns.find((b) => /Agent/i.test(b.textContent || ''));
    if (agBtn) agBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:settings', JSON.stringify({ theme: 'light', useMemory: true, locale: 'en' }));
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));
  await snap('agent-light.png');

  await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('.ws-mode-btn'));
    const ideBtn = btns.find((b) => /IDE/i.test(b.textContent || ''));
    if (ideBtn) ideBtn.click();
  })()`);
  await waitForSel('.ide-status-bar', 6000);
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(`(() => {
    const appFile = document.querySelector('.ide-tree-row[title="src/app.js"]');
    if (!appFile) {
      const srcFolder = Array.from(document.querySelectorAll('.ide-tree-row')).find((r) => r.querySelector('.ide-tree-name')?.textContent?.trim() === 'src');
      if (srcFolder) srcFolder.click();
    }
  })()`);
  await waitForSel('.ide-tree-row[title="src/app.js"]', 3000);
  await win.webContents.executeJavaScript(`(() => {
    const appFile = document.querySelector('.ide-tree-row[title="src/app.js"]') || Array.from(document.querySelectorAll('.ide-tree-row')).find((r) => r.querySelector('.ide-tree-name')?.textContent?.trim() === 'app.js');
    if (appFile) appFile.click();
  })()`);
  await waitForSel('.monaco-editor', 6000);
  await new Promise((r) => setTimeout(r, 1100));
  await snap('ide-light.png');

  // Restore Dark mode for Browser Inspect, Environments, and Runtimes screenshots
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:settings', JSON.stringify({ theme: 'dark', useMemory: true, locale: 'en' }));
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));
  await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('.ws-mode-btn'));
    const agBtn = btns.find((b) => /Agent/i.test(b.textContent || ''));
    if (agBtn) agBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  // 4. Built-in Browser + Inspect Element + Exit Inspect Mode verification
  await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => /Browser/i.test(b.textContent || ''));
    if (btn) btn.click();
  })()`);
  await waitForSel('.browser-inspect-btn', 6000);
  await new Promise((r) => setTimeout(r, 400));
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.querySelector('.omnibox input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, ${JSON.stringify(previewURL)});
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 1200));

  await win.webContents.executeJavaScript(`document.querySelector('.browser-inspect-btn').click()`);
  assert.ok(await waitForSel('.browser-inspect-banner', 4000), 'Inspect Mode banner must show');
  await new Promise((r) => setTimeout(r, 400));

  const guest = browser.getGuest();
  assert.ok(guest, 'Browser guest WebContents must be registered');
  const injectedCheck = await guest.executeJavaScript('typeof window.__AKRON_INSPECT_CLEANUP__ === "function"');
  assert.strictEqual(injectedCheck, true, 'Inspect overlay must be injected into guest');

  // Trigger real hover + click inside guest on #deployBtn to populate Inspect Card
  await guest.executeJavaScript(`(() => {
    const btn = document.getElementById('deployBtn');
    const r = btn.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    btn.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: cx, clientY: cy }));
    return true;
  })()`);
  await waitForSel('.browser-inspect-card', 4000);
  await snap('browser-inspect.png');

  // Exit Inspect Mode and verify complete DOM cleanup in guest
  await win.webContents.executeJavaScript(`document.querySelector('.browser-exit-inspect-btn').click()`);
  await new Promise((r) => setTimeout(r, 350));
  const bannerGone = await win.webContents.executeJavaScript(`!document.querySelector('.browser-inspect-banner')`);
  assert.strictEqual(bannerGone, true, 'Inspect banner must disappear after Exit Inspect Mode');
  const guestClean = await guest.executeJavaScript(`({
    root: document.getElementById('__akron_inspect_root__'),
    cleanupFn: typeof window.__AKRON_INSPECT_CLEANUP__
  })`);
  assert.strictEqual(guestClean.root, null, 'Injected inspect overlay DOM must be completely removed on exit');
  assert.strictEqual(guestClean.cleanupFn, 'undefined', 'Cleanup handler must be deleted on exit');
  console.log('✓ Built-in Browser Inspect Mode + Exit Inspect DOM cleanup verified');

  // 5. Close Browser pane & capture Execution Environments Settings
  await win.webContents.executeJavaScript(`(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('title') === 'Settings' || /Settings/i.test(b.getAttribute('aria-label') || ''));
    if (btn) btn.click();
  })()`);
  await waitForSel('.settings-modal', 5000);
  await win.webContents.executeJavaScript(`(() => {
    const nav = Array.from(document.querySelectorAll('.settings-nav-btn')).find((b) => /Environments/i.test(b.textContent || ''));
    if (nav) nav.click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  await snap('environments.png');

  // 6. Capture Runtimes & Updates Settings
  await win.webContents.executeJavaScript(`(() => {
    const nav = Array.from(document.querySelectorAll('.settings-nav-btn')).find((b) => /Runtimes/i.test(b.textContent || ''));
    if (nav) nav.click();
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  await snap('runtimes-updates.png');

  assert.strictEqual(pageErrors.length, 0, 'Renderer pageErrors encountered: ' + JSON.stringify(pageErrors));
  console.log('\nPRODUCTION_GATE_E2E_ALL_PASS');

  try { await ideIpc.cleanup(); } catch (_) {}
  try { win.destroy(); } catch (_) {}
  try { srv.close(); } catch (_) {}
  fs.rmSync(wsDir, { recursive: true, force: true });
  app.exit(0);
}

app.whenReady().then(run).catch((err) => {
  console.error('PRODUCTION_GATE_E2E_FAIL:', err);
  app.exit(1);
});
