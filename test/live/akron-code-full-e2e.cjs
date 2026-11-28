'use strict';
const { app, BrowserWindow, dialog } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const ARTIFACTS = (process.env.AKRON_ARTIFACTS_DIR || os.tmpdir());

const llm = require('../../electron/llm');
const { runTool } = require('../../electron/tools');
const git = require('../../electron/git');
const sandbox = require('../../electron/sandbox');
const freellm = require('../../electron/freellm');
const providerOauth = require('../../electron/provider-oauth');

async function captureDesktopUI() {
  const win = new BrowserWindow({
    width: 1320,
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

  // Seed sample conversation + green success toast BEFORE React mounts
  const seedConvs = [
    {
      id: 'conv_e2e_main',
      title: 'Akron Code Verification Thread',
      ts: Date.now() - 60000,
      messages: [
        { id: 'u1', role: 'user', content: 'Implement calc.js and verify tests.' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Created `calc.js` with `add` and `mul`, edited docs, and verified all unit assertions pass.',
          durationMs: 2400,
          tools: [
            { id: 't1', name: 'TodoWrite', args: { todos: [{ content: 'Write calc.js', status: 'completed' }, { content: 'Verify tests', status: 'completed' }] }, status: 'done', result: 'updated' },
            { id: 't2', name: 'Write', args: { path: 'calc.js', content: 'exports.add=(a,b)=>a+b;\n' }, status: 'done', result: 'Wrote calc.js' },
            { id: 't3', name: 'Bash', args: { command: 'node calc.js' }, status: 'done', result: 'OK' },
          ],
        },
        { id: 'u2', role: 'user', content: 'Explain the Fork and Share buttons.' },
        {
          id: 'a2',
          role: 'assistant',
          content: 'Every response includes **Copy**, **Fork** (branches a new chat from this point), **Retry**, and **Share** (Copy Markdown, HTML, MD, JSON).',
          durationMs: 1850,
        },
      ],
    },
  ];

  // Seed sample conversation BEFORE React reads it (using exact `autobot:*` IPC channels)
  const { ipcMain } = require('electron');
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
  safe('autobot:getDefaultCwd', () => '/tmp/akron-code-demo');
  safe('autobot:getWorkspace', () => '/tmp/akron-code-demo');
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false, detectedLocalFolders: [] }));
  safe('autobot:oauthStatus', () => ({ providers: [], total: 0 }));
  safe('autobot:checkpointsList', () => []);
  safe('autobot:checkpointsDiff', () => ({ ok: true, files: [] }));

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_e2e_main'))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 900));

  const uiCheck = await win.webContents.executeJavaScript(`(() => {
    const brand = document.querySelector('.titlebar .brand')?.textContent || '';
    const sub = document.querySelector('.titlebar .sub')?.textContent || '';
    const actions = document.querySelectorAll('[data-response-actions]').length;
    const buttons = [...document.querySelectorAll('[data-response-actions] .response-action-btn')].map(b => (b.querySelector(':scope > span:last-child')?.textContent || b.textContent).trim());
    const oldBrand = document.body.innerText.includes('Akron Bot') || document.body.innerText.includes('free-LLM desktop agent');
    return { brand, sub, actions, buttons: buttons.slice(0, 4), oldBrand };
  })()`);
  console.log('DESKTOP_UI_CHECK:', JSON.stringify(uiCheck));
  assert.strictEqual(uiCheck.brand, 'Akron Code');
  assert.strictEqual(uiCheck.sub, 'by Akronlogic.com');
  assert.ok(uiCheck.actions >= 2, 'Expected response actions on both assistant replies');
  assert.deepStrictEqual(uiCheck.buttons, ['Copy', 'Fork', 'Retry', 'Share']);
  assert.strictEqual(uiCheck.oldBrand, false, 'Old brand text should not appear on main UI');

  // Capture main screenshot
  const img1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'akron-code-rebrand-and-actions.png'), img1.toPNG());

  // Click Share on last assistant response to show menu and capture
  await win.webContents.executeJavaScript(`
    const bars = document.querySelectorAll('[data-response-actions]');
    const lastBar = bars[bars.length - 1];
    const shareBtn = lastBar && lastBar.querySelector('button[title="Share or export response"]');
    if (shareBtn) shareBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 250));
  const shareItems = await win.webContents.executeJavaScript(`
    [...document.querySelectorAll('.response-share-menu button')].map(b => (b.querySelector(':scope > span:last-child')?.textContent || b.textContent).trim())
  `);
  console.log('SHARE_MENU_ITEMS:', JSON.stringify(shareItems));
  assert.deepStrictEqual(shareItems, ['Copy Markdown', 'Share as HTML…', 'Export Markdown…', 'Export JSON…']);
  const imgShare = await win.webContents.capturePage();
  fs.writeFileSync(path.join(ARTIFACTS, 'akron-code-share-menu.png'), imgShare.toPNG());

  // Click Fork on first assistant response (index 1 -> slices messages from 4 down to 2)
  await win.webContents.executeJavaScript(`
    const firstBar = document.querySelectorAll('[data-response-actions]')[0];
    const forkBtn = firstBar && firstBar.querySelector('button[title="Fork conversation from this response"]');
    if (forkBtn) forkBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 300));
  const forkCheck = await win.webContents.executeJavaScript(`(() => {
    const convs = [...document.querySelectorAll('.conv .conv-title')].map(e => e.textContent);
    const msgs = document.querySelectorAll('.msg').length;
    const noticeTxt = document.querySelector('.noticebar-text')?.textContent || '';
    return { convs, msgs, noticeTxt };
  })()`);
  console.log('FORK_CHECK:', JSON.stringify(forkCheck));
  assert.ok(forkCheck.convs.some((t) => t.includes('(fork)')), 'Forked conversation not added to sidebar');
  assert.strictEqual(forkCheck.msgs, 2, 'Fork from 1st assistant response should preserve 2 messages (u1, a1)');

  win.destroy();
}

async function captureBrowserBotUI(theme) {
  const http = require('http');
  const os = require('os');
  const extRoot = path.join(REPO, 'resources/akron-browser-bot');
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
  };
  const srv = await new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
      const full = path.resolve(extRoot, rel);
      if (!full.startsWith(extRoot) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
        res.writeHead(404);
        return res.end('Not found');
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      fs.createReadStream(full).pipe(res);
    });
    s.listen(0, '127.0.0.1', () => resolve({ server: s, port: s.address().port }));
  });

  const preloadPath = path.join(os.tmpdir(), `akron-bb-preload-${theme}.cjs`);
  fs.writeFileSync(preloadPath, `
    window.chrome = {
      runtime: {
        connect: () => ({
          onMessage: { addListener: (fn) => { window.__onBgMsg = fn; } },
          onDisconnect: { addListener: () => {} },
          postMessage: (m) => {
            if (m && m.type === 'hello' && window.__onBgMsg) {
              setTimeout(() => {
                window.__onBgMsg({
                  type: 'state',
                  settings: { activeProviderId: 'akron-desktop', activeModel: 'claude-opus-5-5-medium', permissionMode: 'ask', theme: ${JSON.stringify(theme)}, orchestrator: { enabled: true } },
                  providers: [{ id: 'akron-desktop', name: 'Akron Code Desktop (All Models · Zero Key)', type: 'openai-compatible', models: ['akron-default', 'claude-opus-5-5-medium', 'claude-sonnet-5-5', 'gemini-4-neon-high', 'qwen3.8-flash', 'gemma4:latest'], defaultModel: 'claude-opus-5-5-medium' }],
                  orchestrator: { endpoints: 70 },
                  activeEndpoint: 'claude-opus-5-5-medium',
                  conversation: [
                    { role: 'user', content: 'Check today & monthly profit totals' },
                    { role: 'assistant', content: 'Today has 16 orders (\$27.00) and yesterday had 50 orders (\$156.36). This month totals 1,347 orders (\$3,588.24).' },
                    { role: 'user', content: 'Check previous month comparison' },
                  ],
                  plan: { steps: ['Inspect profit overview table', 'Compare this month vs previous month', 'Report clean delta'], status: 'done' },
                  group: { title: 'Akron', tabs: 1 },
                  history: [],
                });
                window.__onBgMsg({ type: 'error', error: 'HTTP 400: Tool choice mismatch on turn 1', retry: true });
              }, 60);
            }
          },
        }),
        onMessage: { addListener: () => {} },
        openOptionsPage: () => {},
        getURL: (p) => p,
      },
      storage: {
        local: {
          get: async () => ({ autobot_settings: { theme: ${JSON.stringify(theme)}, activeProviderId: 'akron-desktop', activeModel: 'claude-opus-5-5-medium' }, autobot_saved_prompts: [], autobot_skills: [] }),
          set: async () => {},
          remove: async () => {},
        },
        onChanged: { addListener: () => {} },
      },
      tabs: {
        query: async () => [{ id: 1, title: 'Dashboard', url: 'https://example.com', active: true }],
        onActivated: { addListener: () => {} },
      },
      windows: {
        getCurrent: async () => ({ id: 1 }),
        onFocusChanged: { addListener: () => {} },
      },
    };
  `);

  const win = new BrowserWindow({
    width: 440,
    height: 760,
    show: false,
    backgroundColor: theme === 'dark' ? '#141413' : '#faf9f6',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('BB_FAIL_LOAD:', code, desc, url));

  try {
    await win.loadURL(`http://127.0.0.1:${srv.port}/sidepanel/sidepanel.html`);
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme = ${JSON.stringify(theme)};`);
    await new Promise((r) => setTimeout(r, 900));
    const check = await win.webContents.executeJavaScript(`(() => {
      const title = document.title;
      const chip = document.querySelector('#model-chip-label')?.textContent || '';
      const bodyText = document.body.innerText;
      const hasSearch = !!document.querySelector('#model-search');
      const hasMore = !!document.querySelector('#more-btn');
      return { title, chip, hasSearch, hasMore, hasMaker: bodyText.includes('akronlogic.com') };
    })()`);
    console.log(`BROWSER_BOT_${theme.toUpperCase()}_CHECK:`, JSON.stringify(check));
    assert.strictEqual(check.title, 'Akron Browser Bot');
    assert.strictEqual(check.hasSearch, true);
    assert.strictEqual(check.hasMore, true);
    assert.strictEqual(check.hasMaker, true);

    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(ARTIFACTS, `browser-bot-redesign-${theme}.png`), img.toPNG());
  } finally {
    win.destroy();
    try { fs.unlinkSync(preloadPath); } catch (_) {}
    await new Promise((r) => srv.server.close(r));
  }
}

async function runAgentAndReliabilityE2E() {
  const tmpDir = fs.mkdtempSync('/tmp/akron-code-e2e-');
  try {
    execFileSync('git', ['init'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.email', 'test@akronlogic.com'], { cwd: tmpDir });
    execFileSync('git', ['config', 'user.name', 'Akron Test'], { cwd: tmpDir });

    // 1. Check non-censorship / clean system prompt & sandbox protections
    assert.ok(llm.SYSTEM_PROMPT.includes('Akron Code'), 'SYSTEM_PROMPT branded to Akron Code');
    assert.ok(!/refuse|cannot assist|inappropriate content|nsfw/i.test(llm.SYSTEM_PROMPT), 'SYSTEM_PROMPT should remain uncensored');
    const secBlock = sandbox.isReadAllowed(path.join(require('os').homedir(), '.autobot', 'secrets.json'), tmpDir);
    assert.strictEqual(secBlock.allowed, false, 'Sandbox must block reading secrets.json');

    // 2. Configure live coding + mid-session model switch
    const cfg = freellm.loadConfig();
    assert.ok(cfg && cfg.token, 'FreeLLMAPI config missing');
    const p1 = llm.normalizeProvider({ baseURL: 'http://127.0.0.1:3001/v1', apiKey: cfg.token, model: 'gpt-oss-120b', supportsTools: true });
    const p2 = llm.normalizeProvider({ baseURL: 'http://127.0.0.1:3001/v1', apiKey: cfg.token, model: 'qwen3.8-27b', supportsTools: true });
    const pFallback = llm.normalizeProvider({ baseURL: 'http://127.0.0.1:11434/v1', model: 'gemma4:latest', supportsTools: true });

    // 3. Coding session Turn 1: create calc.js + edit calc.js + run Bash test
    const toolsUsed = [];
    const m1 = await llm.runAgent({
      provider: p1,
      orchestrator: { enabled: true, providers: [p1, p2, pFallback] },
      cwd: tmpDir,
      messages: [
        { role: 'user', content: `In ${tmpDir}, use Write to create calc.js exporting add(a,b) and mul(a,b) in CommonJS, then use Edit to add sub(a,b), then run "node -e 'const c=require(\"./calc\"); console.log(c.add(4,5), c.mul(6,7), c.sub(10,3))'" via Bash.` },
      ],
      emit: (e) => {
        if (e && e.type === 'tool') toolsUsed.push(e.name);
        if (e && e.type === 'toolResult') console.log('E2E_TR:', e.name, 'err=', !!e.isError, String(e.result || '').slice(0, 120));
        else if (e && (e.type === 'tool' || e.type === 'notice' || e.type === 'error' || e.type === 'orchestrator')) {
          console.log('E2E_EVT:', e.type, e.name || e.reason || e.text || e.message || '');
        }
      },
      maxSteps: 12,
    });
    const calcPath = path.join(tmpDir, 'calc.js');
    assert.ok(fs.existsSync(calcPath), 'calc.js should exist on disk');
    assert.ok(toolsUsed.includes('Write') && toolsUsed.includes('Bash'), 'Expected Write & Bash tool execution');
    const out1 = execFileSync('node', ['-e', 'const c=require("./calc"); console.log(c.add(4,5), c.mul(6,7), c.sub(10,3))'], { cwd: tmpDir, encoding: 'utf8' }).trim();
    assert.strictEqual(out1, '9 42 7');
    console.log('E2E_CODING_TURN1_OK:', { toolsUsed, out1, model: p1.model });

    // 4. Model switch mid-session preserving full context (p1 -> p2)
    const m2 = await llm.runAgent({
      provider: p2,
      orchestrator: { enabled: true, providers: [p2, pFallback] },
      cwd: tmpDir,
      messages: [
        ...m1,
        { role: 'user', content: 'Look at the assistant and tool outputs from Turn 1 in this conversation (no tools needed) and name the three functions exported in calc.js plus the exact three numbers printed by the Bash check.' },
      ],
      emit: (e) => {
        if (e && (e.type === 'tool' || e.type === 'error' || e.type === 'orchestrator')) {
          console.log('E2E_M2_EVT:', e.type, e.name || e.reason || e.message || '');
        }
      },
      maxSteps: 4,
    });
    const lastReply = [...m2].reverse().find((x) => x.role === 'assistant');
    const txt2 = String((lastReply && lastReply.content) || '');
    assert.ok(/add/i.test(txt2) && /mul/i.test(txt2) && /42/.test(txt2), `Model switch context lost: ${txt2}`);
    console.log('E2E_MODEL_SWITCH_OK:', { from: p1.model, to: p2.model, reply: txt2.slice(0, 120) });

    // 5. Git diff check + tool error handling + cancellation recovery
    const gInfo = await git.gitInfo(tmpDir);
    assert.strictEqual(gInfo.isRepo, true, 'Temp project recognized as git repo');
    const badRead = await runTool('Read', { path: path.join(tmpDir, 'does_not_exist.txt') }, { cwd: tmpDir });
    const badStr = typeof badRead === 'string' ? badRead : JSON.stringify(badRead);
    assert.ok(/not found|no such|error/i.test(badStr), 'Read missing file returns graceful error');

    const ac = new AbortController();
    ac.abort();
    let abortedCaught = false;
    try {
      await llm.runAgent({
        provider: p2,
        cwd: tmpDir,
        messages: [{ role: 'user', content: 'Say hi' }],
        signal: ac.signal,
        emit: () => {},
      });
    } catch (e) {
      abortedCaught = /abort/i.test(String(e && e.message));
    }
    assert.ok(abortedCaught, 'Task cancellation aborts cleanly');

    // 6. Delete file CRUD verification
    fs.unlinkSync(calcPath);
    assert.strictEqual(fs.existsSync(calcPath), false, 'File deletion succeeded');
    console.log('E2E_RELIABILITY_AND_SECURITY_OK');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  try {
    await captureDesktopUI();
    await captureBrowserBotUI('dark');
    await captureBrowserBotUI('light');
    await runAgentAndReliabilityE2E();
    console.log('AKRON_CODE_FULL_E2E_OK');
    process.exit(0);
  } catch (e) {
    console.error('FULL_E2E_FAILED:', e);
    process.exit(1);
  }
});
