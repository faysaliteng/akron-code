'use strict';
const { dialog } = require('electron'); dialog.showErrorBox = () => {};
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const EXT_DIR = path.join(ROOT, 'resources', 'akron-browser-bot');
const ARTIFACTS = (process.env.AKRON_ARTIFACTS_DIR || os.tmpdir());

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const CHROME_MOCK_SCRIPT = `<script>
(() => {
  const store = {
    autobot_settings: { theme: 'dark', activeProviderId: 'akron-desktop', activeModel: 'claude-sonnet-5-5', orchestrator: { enabled: false }, permissionMode: 'ask' },
    autobot_providers: [{ id: 'akron-desktop', name: 'Akron Code Desktop (All Models · Zero Key)', models: ['akron-default', 'claude-sonnet-5-5', 'gemini-4-neon-high'], defaultModel: 'claude-sonnet-5-5' }],
    autobot_saved_prompts: [],
    autobot_skills: [],
  };
  const portListeners = [];
  window.__mockPort = {
    name: 'autobot',
    onMessage: { addListener: (fn) => portListeners.push(fn) },
    onDisconnect: { addListener: () => {} },
    postMessage: (msg) => {
      window.__sentMessages = window.__sentMessages || [];
      window.__sentMessages.push(msg);
      if (msg && msg.type === 'hello') {
        setTimeout(() => emitToPanel({ type: 'session', session: { id: 'sess_1' }, group: null }), 10);
      } else if (msg && msg.type === 'get_state') {
        setTimeout(() => emitToPanel({
          type: 'state',
          session: { id: 'sess_1' },
          conversation: [],
          settings: store.autobot_settings,
          providers: store.autobot_providers,
          orchestrator: { enabled: false, endpoints: 3 },
          group: { title: 'Akron', tabs: 1 },
          running: false,
        }), 10);
      }
    },
  };
  window.__emitToPanel = (msg) => {
    for (const fn of portListeners) { try { fn(msg); } catch (e) { console.error(e); } }
  };
  function emitToPanel(m) { window.__emitToPanel(m); }
  const evStub = () => ({ addListener: () => {} });
  window.chrome = {
    runtime: {
      connect: () => window.__mockPort,
      getURL: (p) => '/' + String(p || '').replace(/^\\/+/, ''),
      onMessage: evStub(),
      openOptionsPage: () => {},
    },
    storage: {
      local: {
        get: async (keys) => {
          if (!keys) return { ...store };
          if (typeof keys === 'string') return { [keys]: store[keys] };
          if (Array.isArray(keys)) { const o = {}; for (const k of keys) o[k] = store[k]; return o; }
          return { ...keys, ...store };
        },
        set: async (obj) => { Object.assign(store, obj || {}); },
        remove: async (k) => { delete store[k]; },
      },
      onChanged: evStub(),
    },
    tabs: {
      query: async () => [{ id: 101, windowId: 1, title: 'claude code github repo - Google Search', url: 'https://www.google.com/search?q=claude+code+github+repo' }],
      get: async (id) => ({ id, windowId: 1, title: 'claude code github repo - Google Search', url: 'https://www.google.com/search?q=claude+code+github+repo' }),
      captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      onActivated: evStub(),
      onUpdated: evStub(),
    },
    windows: {
      getCurrent: async () => ({ id: 1 }),
      onFocusChanged: evStub(),
    },
    scripting: {
      executeScript: async () => [{ result: { selection: 'anthropics/claude-code: Agentic coding tool', title: 'Google Search', url: 'https://www.google.com/search?q=claude+code+github+repo' } }],
    },
  };
})();
</script>`;

function startExtServer() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const cleanPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const abs = path.join(EXT_DIR, cleanPath.replace(/^\/+/, ''));
      if (!abs.startsWith(EXT_DIR) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      const ext = path.extname(abs).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      if (cleanPath.endsWith('/sidepanel/sidepanel.html')) {
        const html = fs.readFileSync(abs, 'utf8').replace('<script type="module" src="sidepanel.js"></script>', CHROME_MOCK_SCRIPT + '\n    <script type="module" src="sidepanel.js"></script>');
        res.end(html);
        return;
      }
      fs.createReadStream(abs).pipe(res);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ server: srv, port: srv.address().port }));
  });
}

app.whenReady().then(async () => {
  const { server, port } = await startExtServer();
  try {
    const win = new BrowserWindow({
      width: 420,
      height: 860,
      show: false,
      backgroundColor: '#0e0f0e',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    const pageErrors = [];
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 3) pageErrors.push(msg);
    });

    await win.loadURL(`http://127.0.0.1:${port}/sidepanel/sidepanel.html`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 600))`);

    // 1. Welcome state checks & screenshot
    const welcome = await win.webContents.executeJavaScript(`(() => ({
      theme: document.documentElement.dataset.theme,
      hostPill: document.querySelector('#active-tab-host')?.textContent?.trim() || '',
      chipLabel: document.querySelector('#model-chip-label')?.textContent?.trim() || '',
      hasSnapBtn: !!document.querySelector('#snap-tab-btn'),
      hasSelBtn: !!document.querySelector('#grab-selection-btn'),
      chipsCount: document.querySelectorAll('.chips .chip').length,
      floatingPlanDisplay: getComputedStyle(document.querySelector('#plan')).display,
    }))()`);

    assert.strictEqual(welcome.theme, 'dark');
    assert.strictEqual(welcome.hostPill, 'www.google.com', `Unexpected host pill: ${welcome.hostPill}`);
    assert(welcome.chipLabel.includes('claude-sonnet-5-5'), `Unexpected model chip: ${welcome.chipLabel}`);
    assert.strictEqual(welcome.hasSnapBtn, true);
    assert.strictEqual(welcome.hasSelBtn, true);
    assert.strictEqual(welcome.chipsCount, 4);
    assert.strictEqual(welcome.floatingPlanDisplay, 'none');

    fs.writeFileSync(path.join(ARTIFACTS, 'browserbot-welcome-dark.png'), (await win.webContents.capturePage()).toPNG());

    // 2. Simulate running turn with 6-step plan + tool calls (suppressing update_plan bullet!)
    const steps6 = [
      'Find Claude Code GitHub repository URL',
      'Find Codex (OpenAI Codex CLI) GitHub repository URL',
      'Find Gemini Code (Gemini CLI) GitHub repository URL',
      'Find Cursor GitHub repository URL',
      'Find DeepSeek Harness GitHub repository URL',
      'Find OpenCode GitHub repository URL',
    ];
    await win.webContents.executeJavaScript(`(() => {
      const emit = window.__emitToPanel;
      emit({ type: 'status', running: true, step: 1, text: 'Searching Google for GitHub repositories' });
      emit({ type: 'user_echo', text: 'find out claude code github repo, codex github repo, gemini code github repo, cursor, deepseek harness, opencode' });
      emit({ type: 'step', id: 'tc_plan', name: 'update_plan', phase: 'running', args: { steps: ${JSON.stringify(steps6)}, status: 'in_progress' } });
      emit({ type: 'step', id: 'tc_plan', name: 'update_plan', phase: 'done', result: 'Plan published' });
      emit({ type: 'step', id: 'tc_read', name: 'read_page', phase: 'running', args: { maxChars: 10000 } });
      emit({ type: 'step', id: 'tc_read', name: 'read_page', phase: 'done', result: 'Google Search results loaded' });
      emit({ type: 'step', id: 'tc_type', name: 'type', phase: 'running', args: { ref: 'e4', text: 'openai codex github repo', submit: true } });
      emit({ type: 'step', id: 'tc_type', name: 'type', phase: 'done', result: 'Typed and submitted' });
      emit({ type: 'step', id: 'tc_nav', name: 'navigate', phase: 'running', args: { url: 'https://github.com/anthropics/claude-code' } });
    })()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 300))`);

    const mid = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#messages .live-plan-card');
      const topPlan = document.querySelector('#plan');
      const detailsSteps = [...document.querySelectorAll('#messages details.step')];
      const hasUpdatePlanBullet = detailsSteps.some((d) => d.dataset.tool === 'update_plan');
      return {
        inMessages: !!card && !!card.closest('#messages'),
        topPlanDisplay: getComputedStyle(topPlan).display,
        isLive: card?.classList.contains('is-live'),
        isOpen: !card?.querySelector('.live-plan-list')?.hidden,
        title: card?.querySelector('.live-plan-title')?.textContent?.trim() || '',
        ratio: card?.querySelector('.live-plan-ratio')?.textContent?.trim() || '',
        rowCount: card?.querySelectorAll('.live-plan-row').length || 0,
        doneRows: card?.querySelectorAll('.live-plan-row.completed').length || 0,
        activeRows: card?.querySelectorAll('.live-plan-row.in_progress').length || 0,
        hasUpdatePlanBullet,
        detailsCount: detailsSteps.length,
      };
    })()`);

    assert.strictEqual(mid.inMessages, true, 'Plan card MUST render inline inside #messages');
    assert.strictEqual(mid.topPlanDisplay, 'none', 'Floating #plan above messages must stay hidden');
    assert.strictEqual(mid.isLive, true);
    assert.strictEqual(mid.isOpen, true);
    assert.strictEqual(mid.ratio, '2/6', `Expected 2/6 progress, got ${mid.ratio}`);
    assert.strictEqual(mid.doneRows, 2);
    assert.strictEqual(mid.activeRows, 1);
    assert.strictEqual(mid.hasUpdatePlanBullet, false, 'Must NOT render redundant update_plan bullet');
    assert.strictEqual(mid.detailsCount, 3, 'Expected read_page, type, and navigate step cards');

    fs.writeFileSync(path.join(ARTIFACTS, 'browserbot-inline-plan-dark.png'), (await win.webContents.capturePage()).toPNG());

    // Light mode inline plan screenshot
    await win.webContents.executeJavaScript(`document.querySelector('#theme-btn').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 200))`);
    fs.writeFileSync(path.join(ARTIFACTS, 'browserbot-inline-plan-light.png'), (await win.webContents.capturePage()).toPNG());
    // Back to dark mode
    await win.webContents.executeJavaScript(`document.querySelector('#theme-btn').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 150))`);

    const sampleReply = 'Here are the repositories:\n- **Claude Code**: `anthropics/claude-code`\n- **OpenAI Codex CLI**: `openai/codex`\n- **Gemini CLI**: `google-gemini/gemini-cli`';
    // 3. Complete run -> auto-collapse + assistant message footer
    await win.webContents.executeJavaScript(`(() => {
      const emit = window.__emitToPanel;
      emit({ type: 'step', id: 'tc_nav', name: 'navigate', phase: 'done', result: 'Navigated cleanly' });
      emit({ type: 'plan', steps: ${JSON.stringify(steps6)}, status: 'done' });
      emit({ type: 'assistant_final', endpoint: { label: 'claude-sonnet-5-5' }, text: ${JSON.stringify(sampleReply)} });
      emit({ type: 'status', running: false });
    })()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 250))`);

    const doneState = await win.webContents.executeJavaScript(`(() => {
      const card = document.querySelector('#messages .live-plan-card');
      const footer = document.querySelector('.msg-footer');
      return {
        isDone: card?.classList.contains('is-done'),
        collapsed: card?.classList.contains('collapsed'),
        listHidden: card?.querySelector('.live-plan-list')?.hidden,
        title: card?.querySelector('.live-plan-title')?.textContent?.trim() || '',
        ratio: card?.querySelector('.live-plan-ratio')?.textContent?.trim() || '',
        modelBadge: footer?.querySelector('.msg-model-badge')?.textContent?.trim() || '',
        actionButtons: [...(footer?.querySelectorAll('.msg-action-btn') || [])].map((b) => b.textContent.trim()),
      };
    })()`);

    assert.strictEqual(doneState.isDone, true);
    assert.strictEqual(doneState.collapsed, true, 'Finished plan should auto-collapse to compact 1-line summary');
    assert.strictEqual(doneState.listHidden, true);
    assert.strictEqual(doneState.title, 'Completed · 6/6 steps');
    assert.strictEqual(doneState.ratio, '6/6');
    assert.strictEqual(doneState.modelBadge, 'claude-sonnet-5-5');
    assert.deepStrictEqual(doneState.actionButtons, ['Copy', 'Retry']);

    fs.writeFileSync(path.join(ARTIFACTS, 'browserbot-completed-collapsed.png'), (await win.webContents.capturePage()).toPNG());

    // Toggle expand by clicking header
    await win.webContents.executeJavaScript(`document.querySelector('.live-plan-head').click()`);
    assert.strictEqual(await win.webContents.executeJavaScript(`document.querySelector('.live-plan-list').hidden`), false, 'Clicking collapsed header must expand steps');

    // Test new 1-click composer context buttons (#snap-tab-btn & #grab-selection-btn)
    await win.webContents.executeJavaScript(`document.querySelector('#snap-tab-btn').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 150))`);
    await win.webContents.executeJavaScript(`document.querySelector('#grab-selection-btn').click()`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 150))`);
    const attachNames = await win.webContents.executeJavaScript(`[...document.querySelectorAll('#attachments .attachment-name')].map((el) => el.textContent.trim())`);
    assert.strictEqual(attachNames.length, 2, `Expected 2 attachments (png + selection.md), got ${JSON.stringify(attachNames)}`);
    assert(attachNames[0].endsWith('.png') && attachNames[1] === 'selection.md', `Unexpected attachments: ${JSON.stringify(attachNames)}`);
    assert.strictEqual(pageErrors.length, 0, `Unexpected console errors: ${JSON.stringify(pageErrors)}`);

    console.log('BROWSERBOT_REDESIGN_E2E_ALL_PASS');
    win.destroy();
    server.close();
    app.exit(0);
  } catch (err) {
    console.error('BROWSERBOT_REDESIGN_E2E_FAIL:', err);
    server.close();
    app.exit(1);
  }
});
