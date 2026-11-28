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
const ARTIFACTS = (process.env.AKRON_ARTIFACTS_DIR || os.tmpdir());

const { runAgent, createPauseController, normalizeProvider, humanizeLLMError } = require(path.join(REPO, 'electron/llm'));
const ideIpc = require(path.join(REPO, 'electron/ide/ipc'));

async function startMockLlmServer() {
  let reqIdx = 0;
  let holdChunkResolve = null;
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
    reqIdx++;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    // Inline Edit (Cmd+K) detection by system prompt
    const sysText = JSON.stringify(body.messages && body.messages[0] ? body.messages[0] : '');
    if (sysText.includes('inline code editor engine')) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'export function greet(name) {\n  return `Hello, ${name} · Akron Code!`;\n}' }, finish_reason: 'stop' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    // Round 1 of agent run: stream a long Write tool call slowly so LiveToolActivityCard + Pause can be inspected live!
    const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
    const isRound2 = body.messages && body.messages.some((m) => m.role === 'tool');
    if (!isRound2) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Planning index.html structure and styles...' } }] })}\n\n`);
      const part1 = JSON.stringify({ file_path: 'index.html', content: '<!doctype html>\n<html>\n<head><title>Akron Code Live</title></head>\n<body>\n  <h1>Streaming Live Preview</h1>\n' }).slice(0, -2);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_live_write_1', type: 'function', function: { name: 'Write', arguments: part1 } }] } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 200));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, arguments: '  <p>Real-time tool stream chunk verified.</p>\\n' }] } }] })}\n\n`);

      // Wait until harness signals release after screenshots + pause check!
      await new Promise((resolve) => {
        holdChunkResolve = resolve;
        setTimeout(resolve, 6000);
      });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, arguments: '</body>\\n</html>"}' }] }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Created `index.html` cleanly!' }, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: srv.address().port,
    releaseToolStream: () => { if (holdChunkResolve) { holdChunkResolve(); holdChunkResolve = null; } },
    close: () => srv.close(),
  };
}

async function run() {
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-e2e-ws-'));
  execFileSync('git', ['init', '-b', 'main'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.email', 'e2e@akronlogic.com'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.name', 'Akron E2E'], { cwd: wsDir });
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'src', 'app.js'), 'export function greet(name) {\n  return "Hi " + name;\n}\n', 'utf8');
  fs.writeFileSync(path.join(wsDir, 'README.md'), '# Sample Akron Project\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: wsDir });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: wsDir });
  // Leave an unstaged modification + untracked file so Explorer/Git badges light up!
  fs.writeFileSync(path.join(wsDir, 'src', 'app.js'), 'export function greet(name) {\n  return "Hello " + name;\n}\n', 'utf8');
  fs.writeFileSync(path.join(wsDir, 'notes.txt'), 'Draft notes\n', 'utf8');

  const mockLlm = await startMockLlmServer();
  const baseURL = `http://127.0.0.1:${mockLlm.port}/v1`;

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#131316',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    if (level >= 2 && !/ResizeObserver|favicon/i.test(msg)) console.log('RENDERER_LOG:', level, msg);
    if (level >= 3 && !/ResizeObserver|favicon/i.test(msg)) consoleErrors.push(msg);
  });
  win.webContents.on('pageerror', (err) => {
    console.log('PAGE_ERROR:', err.message);
    consoleErrors.push(err.message);
  });

  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };

  let curTheme = 'dark';
  const runs = new Map();

  safe('autobot:getVersion', () => ({ app: '1.0.0', electron: process.versions.electron }));
  safe('autobot:getSettings', () => ({ theme: curTheme, locale: 'en', provider: { baseURL, model: 'mock-coder', apiKey: 'test-key' } }));
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
  safe('autobot:reaStatus', () => ({ available: false, toolCount: 0 }));
  safe('autobot:gitInfo', () => ({ isRepo: true, branch: 'main' }));
  safe('autobot:worktreeList', () => ({ isRepo: true, root: wsDir, worktrees: [{ path: wsDir, branch: 'main', main: true }] }));
  safe('autobot:devServerDetect', () => ({ detected: false }));
  safe('autobot:browserSyncTabs', () => ({ ok: true }));
  safe('autobot:resolveUrl', (_e, u) => u);
  safe('autobot:browserUnregister', () => ({ ok: true }));
  safe('autobot:browserGetURL', () => '');
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
  safe('autobot:listWorkspaceFiles', () => []);

  safe('autobot:run', async (event, payload) => {
    const { runId, messages, provider, cwd } = payload;
    const ac = new AbortController();
    const pauseCtrl = createPauseController();
    const send = (evt) => {
      if (!win.isDestroyed()) win.webContents.send('autobot:event', { runId, ...evt });
    };
    runs.set(runId, { ac, pauseCtrl, send });
    try {
      const finalMsgs = await runAgent({
        provider: normalizeProvider({ ...provider, baseURL, model: 'mock-coder', apiKey: 'k' }),
        messages,
        cwd: cwd || wsDir,
        signal: ac.signal,
        pauseController: pauseCtrl,
        emit: send,
      });
      send({ type: 'complete', messages: finalMsgs });
      return { ok: true };
    } catch (e) {
      if (ac.signal.aborted) { send({ type: 'cancelled' }); return { ok: false, cancelled: true }; }
      const m = humanizeLLMError(e);
      send({ type: 'error', message: m });
      return { ok: false, error: m };
    } finally {
      runs.delete(runId);
    }
  });
  safe('autobot:pause', (_e, runId) => {
    const r = runs.get(runId);
    if (!r) return { ok: false };
    r.pauseCtrl.pause();
    r.send({ type: 'paused', paused: true });
    return { ok: true };
  });
  safe('autobot:resume', (_e, runId, note) => {
    const r = runs.get(runId);
    if (!r) return { ok: false };
    r.pauseCtrl.resume(note);
    r.send({ type: 'paused', paused: false });
    return { ok: true };
  });
  safe('autobot:cancel', (_e, runId) => {
    const r = runs.get(runId);
    if (r) r.ac.abort();
    return { ok: true };
  });

  // Register real IDE IPC handlers!
  ideIpc.register({
    ipcMain,
    normalizeProvider,
    hydrateProvider: async (p) => ({ ...p, baseURL, apiKey: 'k', model: 'mock-coder' }),
    hydrateOrchestrator: async (o) => ({ orch: o, dead: [] }),
    store: { getSettings: () => ({ provider: { baseURL, model: 'mock-coder', apiKey: 'k' } }), getOrchestrator: () => ({ enabled: false, providers: [] }) },
    broadcast: () => {},
  });

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:settings', JSON.stringify({ theme: 'dark', useMemory: true, locale: 'en' }));
    localStorage.setItem('autobot:provider', JSON.stringify({ baseURL: ${JSON.stringify(baseURL)}, model: 'mock-coder', apiKey: 'k', supportsTools: true }));
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));

  // === PHASE 1 VISUAL VERIFICATION: Start a live streaming run ===
  await win.webContents.executeJavaScript(`(() => {
    const ta = document.querySelector('textarea');
    ta.value = 'Build index.html live';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    const sendBtn = document.querySelector('button.send:not(.stop)');
    sendBtn.click();
  })()`);

  // Wait until .live-tool-card appears!
  const waitForSel = async (sel, timeoutMs = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const ok = await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(sel)}))`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  };

  assert.ok(await waitForSel('.live-tool-card'), 'LiveToolActivityCard must render while tool is streaming');
  await new Promise((r) => setTimeout(r, 350));

  // Verify Pause + Stop buttons exist & shimmer computed color is valid
  const p1Check = await win.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.live-tool-card');
    const verb = document.querySelector('.live-tool-verb');
    const pauseBtn = document.querySelector('button.pause-btn');
    const stopBtn = document.querySelector('button.send.stop');
    const rootBg = getComputedStyle(document.documentElement).getPropertyValue('--text-100').trim();
    return {
      cardText: card ? card.innerText : '',
      verbBg: verb ? getComputedStyle(verb).backgroundImage : '',
      hasPause: Boolean(pauseBtn),
      hasStop: Boolean(stopBtn),
      text100: rootBg,
    };
  })()`);
  console.log('PHASE1_DARK_CHECK:', JSON.stringify(p1Check));
  assert.ok(p1Check.text100, '--text-100 must resolve cleanly');
  assert.ok(p1Check.hasPause && p1Check.hasStop, 'Both Pause and Stop buttons must render while streaming');
  assert.ok(/Writing/i.test(p1Check.cardText) && /index\.html/.test(p1Check.cardText), 'Live card should show Writing index.html');

  // Capture Phase 1 Dark screenshot (active tool card + preview + Pause/Stop buttons)
  const imgP1Dark = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'phase1-live-toolcard-dark.png'), imgP1Dark.toPNG());

  // Test Pause -> verify .paused-banner -> Switch to Light mode for light screenshot!
  await win.webContents.executeJavaScript(`document.querySelector('button.pause-btn').click()`);
  assert.ok(await waitForSel('.paused-banner'), 'Paused banner must appear on Pause click');
  await win.webContents.executeJavaScript(`document.querySelector('.app').setAttribute('data-theme', 'light')`);
  await new Promise((r) => setTimeout(r, 250));
  const imgP1Light = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'phase1-live-toolcard-light.png'), imgP1Light.toPNG());

  // Click Resume + release mock stream so turn completes!
  await win.webContents.executeJavaScript(`document.querySelector('.paused-resume-btn').click()`);
  mockLlm.releaseToolStream();
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(fs.existsSync(path.join(wsDir, 'index.html')), 'Mocked Write should have written index.html after Resume');

  // Restore dark theme cleanly before Phase 2 IDE check
  await win.webContents.executeJavaScript(`document.querySelector('.app').setAttribute('data-theme', 'dark')`);

  // === PHASE 2 VISUAL VERIFICATION: Switch to IDE Mode ===
  await win.webContents.executeJavaScript(`(() => {
    const btn = [...document.querySelectorAll('.ws-mode-btn')].find(b => /IDE/i.test(b.textContent || ''));
    if (!btn) throw new Error('IDE mode switch button not found');
    btn.click();
  })()`);
  assert.ok(await waitForSel('.ide-workbench'), 'IdeWorkbench must mount');
  await new Promise((r) => setTimeout(r, 900));

  // Open src/app.js from Explorer tree
  await win.webContents.executeJavaScript(`(() => {
    const srcFolder = [...document.querySelectorAll('.ide-tree-row')].find(r => /src$/i.test(r.textContent.trim()));
    if (srcFolder) srcFolder.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.executeJavaScript(`(() => {
    const appRow = [...document.querySelectorAll('.ide-tree-row')].find(r => /app\.js/i.test(r.textContent));
    if (appRow) appRow.click();
    const readmeRow = [...document.querySelectorAll('.ide-tree-row')].find(r => /README\.md/i.test(r.textContent));
    if (readmeRow) readmeRow.click();
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await win.webContents.executeJavaScript(`(() => {
    const appTab = [...document.querySelectorAll('.ide-tab')].find(t => /app\.js/.test(t.textContent));
    if (appTab) appTab.click();
  })()`);
  await new Promise((r) => setTimeout(r, 900));

  // Trigger Cmd+K Inline Edit widget & generate diff!
  await win.webContents.executeJavaScript(`(() => {
    const kBtn = [...document.querySelectorAll('.ide-editor-tools button')].find(b => /⌘K/.test(b.textContent || ''));
    if (!kBtn) throw new Error('Cmd+K toolbar button not found');
    kBtn.click();
  })()`);
  assert.ok(await waitForSel('.ide-inline-edit'), 'Cmd+K Inline Edit widget should open');
  await win.webContents.executeJavaScript(`(() => {
    const inp = document.querySelector('.ide-inline-edit input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(inp, 'Update greet message to Akron Code');
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  })()`);
  assert.ok(await waitForSel('.ide-inline-diff-box'), 'Cmd+K inline diff preview must stream and appear');

  // Verify xterm terminal renders canvas/DOM
  assert.ok(await waitForSel('.xterm'), 'xterm.js terminal must initialize cleanly');

  // Run a live command inside the xterm.js PTY so real ANSI terminal output is visible
  await win.webContents.executeJavaScript(`(() => {
    window.autobot.idePtyList().then(list => {
      if (list && list[0]) {
        window.autobot.idePtyWrite({ id: list[0].id, data: 'printf "\\\\x1b[32m✓ Akron Code IDE Terminal Ready\\\\x1b[0m\\\\r\\\\n"\\r' });
      }
    });
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const ideCheck = await win.webContents.executeJavaScript(`(() => {
    return {
      tabs: [...document.querySelectorAll('.ide-tab-name')].map(e => e.textContent),
      hasMonaco: Boolean(document.querySelector('.monaco-editor')),
      hasInlineDiff: Boolean(document.querySelector('.ide-inline-diff-box')),
      hasXterm: Boolean(document.querySelector('.xterm')),
      ctxPills: [...document.querySelectorAll('.ide-ctx-pill')].map(e => e.textContent),
    };
  })()`);
  console.log('PHASE2_IDE_CHECK:', JSON.stringify(ideCheck));
  assert.ok(ideCheck.tabs.length >= 2 && ideCheck.hasMonaco && ideCheck.hasInlineDiff && ideCheck.hasXterm, 'All IDE zones must be mounted');

  const imgP2Dark = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'phase2-ide-workbench-dark.png'), imgP2Dark.toPNG());

  // Switch theme to Light via Settings Appearance selector (so Monaco + xterm + React switch cleanly)
  await win.webContents.executeJavaScript(`(() => {
    const btn = document.querySelector('button[title="Settings"], button[aria-label="Settings"]');
    if (!btn) throw new Error('Settings button not found in IDE activity bar');
    btn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.executeJavaScript(`(() => {
    const appTab = [...document.querySelectorAll('.settings-nav-btn')].find(b => /Appearance/i.test(b.textContent || ''));
    if (appTab) appTab.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.executeJavaScript(`(() => {
    const sel = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'light'));
    if (!sel) throw new Error('Theme select not found');
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(sel, 'light');
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    const backBtn = document.querySelector('.settings-back-btn');
    if (backBtn) backBtn.click();
  })()`);
  await new Promise((r) => setTimeout(r, 600));
  const lightThemeVal = await win.webContents.executeJavaScript(`document.querySelector('.app')?.getAttribute('data-theme')`);
  assert.strictEqual(lightThemeVal, 'light', 'App theme should switch to light');
  const imgP2Light = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'phase2-ide-workbench-light.png'), imgP2Light.toPNG());

  assert.strictEqual(consoleErrors.length, 0, 'Unexpected console/page errors: ' + consoleErrors.join(' | '));
  console.log('E2E_IDE_AND_PHASE1_OK');

  ideIpc.cleanup();
  mockLlm.close();
  fs.rmSync(wsDir, { recursive: true, force: true });
  win.destroy();
  app.exit(0);
}

app.whenReady().then(run).catch((e) => {
  console.error(e);
  process.exit(1);
});
