'use strict';
// Offscreen Electron UI & interactive verification at 1280x840 for:
//   1. Browser Maximize -> top >= 40px below titlebar -> click Minimize -> restores cleanly
//   2. Overview popover with Subagents count (6) -> inline preview -> Subagents visualization pane
//   3. Tabbed SessionPane + Code Review (For Turn chip, +N more lines, +10 fold expand, Search Aa/ab/.* auto-unfold, blue + inline comment card)

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, dialog } = require('electron');

if (dialog && typeof dialog.showErrorBox === 'function') {
  dialog.showErrorBox = (t, c) => { console.error('[ErrorBox]', t, c); };
}

process.on('uncaughtException', (e) => { console.error(e); app.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); app.exit(1); });

const outDir = path.resolve(process.argv[2] || '/tmp');
const distHtml = path.join(__dirname, '..', '..', 'dist', 'index.html');

function buildLargeDiffLines() {
  const lines = [];
  for (let i = 1; i <= 92; i++) {
    if (i === 2 || i === 3) {
      lines.push({
        type: 'del',
        oldLine: i,
        newLine: null,
        text: i === 2 ? 'const legacyRouter = true;' : 'function oldSelect() { return null; }',
      });
      lines.push({
        type: 'add',
        oldLine: null,
        newLine: i,
        text: i === 2 ? 'const rolePoolRouter = true;' : 'function selectRolePool(role, index) { return pools[role]; }',
      });
    } else if (i === 85 || i === 86) {
      lines.push({
        type: 'add',
        oldLine: null,
        newLine: i,
        text: i === 85 ? '  // Ensure deterministic failover ordering' : '  return orderedPools.filter(Boolean);',
      });
    } else if (i === 44) {
      lines.push({ type: 'ctx', oldLine: i, newLine: i, text: '  // HIDDEN_FOLD_NEEDLE inside collapsed region' });
    } else {
      lines.push({ type: 'ctx', oldLine: i, newLine: i, text: `  const poolSlot_${i} = resolveSlot(${i});` });
    }
  }
  return lines;
}

const largeDiffLines = buildLargeDiffLines();

const handlers = {
  'autobot:getSettings': () => ({ theme: 'dark', useMemory: true, locale: 'en', provider: { baseURL: 'http://127.0.0.1:3001/v1', model: 'qwen3.8-flash', supportsTools: true, temperature: 0.3, maxTokens: 16000 }, voiceEngine: 'auto', voiceLang: 'en-US' }),
  'autobot:setSettings': (_e, s) => s,
  'autobot:getMemory': () => ({ entries: [] }),
  'autobot:getSkills': () => [],
  'autobot:getOrchestrator': () => ({ enabled: true, providers: [], pools: { enabled: true, gateway: { baseURL: 'http://127.0.0.1:3001/v1' }, roles: {} } }),
  'autobot:setOrchestrator': (_e, o) => o,
  'autobot:poolStatus': () => ({ active: true, roles: {}, rows: [] }),
  'autobot:getFeatures': () => ({ computerUse: true, chrome: false, bridges: false, quickEntry: true, extensions: true }),
  'autobot:setFeatures': (_e, f) => f,
  'autobot:getWorkspace': () => '/Users/saimon/akron-bot-standalone',
  'autobot:getDefaultCwd': () => '/Users/saimon/akron-bot-standalone',
  'autobot:providerStatus': () => ({ providers: [], storeError: null }),
  'autobot:ollamaModels': () => ({ ok: false, base: 'http://localhost:11434/v1', models: [], detail: 'Stopped' }),
  'autobot:listAgents': () => [],
  'autobot:listCheckpoints': () => [{ id: 'turn-1', at: new Date().toISOString(), files: [{ path: '/Users/saimon/akron-bot-standalone/electron/orch-router.js', existed: true }] }],
  'autobot:turnDiffs': () => ([
    {
      path: '/Users/saimon/akron-bot-standalone/electron/orch-router.js',
      relPath: 'electron/orch-router.js',
      status: 'modified',
      added: 4,
      removed: 2,
      lines: largeDiffLines,
    },
  ]),
  'autobot:gitDiffFiles': () => ([
    {
      path: '/Users/saimon/akron-bot-standalone/electron/orch-router.js',
      relPath: 'electron/orch-router.js',
      status: 'modified',
      added: 4,
      removed: 2,
      lines: largeDiffLines,
    },
  ]),
  'autobot:sessionLog': () => ({ turns: [] }),
  'autobot:customToolList': () => [],
  'autobot:extBridgeStatus': () => ({ running: false, tabs: [] }),
  'autobot:reaStatus': () => ({ ok: true, available: true, connected: true, serverId: 'rea', toolCount: 263 }),
  'autobot:complianceGet': () => ({ profile: 'standard', state: {}, catalog: [] }),
  'autobot:listNotebooks': () => [],
  'autobot:listScheduledTasks': () => [],
  'autobot:listPlugins': () => ({ plugins: [] }),
  'autobot:devServerDetect': () => ({ ok: false }),
  'autobot:gitInfo': () => ({ isRepo: false }),
  'autobot:listDir': () => ({ entries: [] }),
  'autobot:readdir': () => [],
  'autobot:providerReconnectState': () => ({ active: false }),
  'autobot:probeProviders': () => [],
};

for (const [ch, fn] of Object.entries(handlers)) ipcMain.handle(ch, fn);

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    show: false,
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  const pageErrors = [];
  win.webContents.on('page-error', (e) => pageErrors.push(String(e)));
  win.webContents.on('console-message', (_e, lvl, msg) => {
    if (lvl >= 2) console.error('[Renderer]', msg);
  });

  await win.loadFile(distHtml);

  const seedSubs = [
    { key: 'sa-1', name: 'planner-arch', status: 'done', jobRole: 'planner', model: 'gpt-5.6-luna', ms: 4200, progress: { tools: 4, last: 'Designed architecture' } },
    { key: 'sa-2', name: 'coder-1', status: 'done', jobRole: 'coder', model: 'qwen3.8-flash', ms: 6100, progress: { tools: 8, last: 'Updated orch-router.js' } },
    { key: 'sa-3', name: 'coder-2', status: 'done', jobRole: 'coder', model: 'qwen3.8-27b', ms: 5800, progress: { tools: 5, last: 'Updated checkpoints.js' } },
    { key: 'sa-4', name: 'vision-check', status: 'done', jobRole: 'vision', model: 'qwen3.8-flash', ms: 2100, progress: { tools: 2, last: 'Verified screenshots' } },
    { key: 'sa-5', name: 'test-runner', status: 'done', jobRole: 'coder', model: 'qwen3.8-27b', ms: 4900, progress: { tools: 3, last: 'All 42 suites passed' } },
    { key: 'sa-6', name: 'code-reviewer', status: 'done', jobRole: 'fast', model: 'gpt-oss-120b', ms: 1800, progress: { tools: 2, last: 'Approved patch' } },
  ];

  const seedConvs = [{
    id: 'conv-parity',
    title: 'Advanced Coding App Swarm Setup',
    ts: Date.now(),
    subAgents: seedSubs,
    swarmInfo: { phase: 'done', supervisor: { model: 'gpt-5.6-luna' }, ms: 14500 },
    swarmBoard: [{ seq: 1, from: 'planner-arch', to: 'coder-1', channel: 'tasks', text: 'Implement @coder-1 role router' }],
    messages: [
      { id: 'm1', role: 'user', content: 'continue', ts: Date.now() - 50000 },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Updated `electron/orch-router.js` with role pools and multi-hunk failover routing.',
        durationMs: 12400,
        checkpointId: 'turn-1',
        subAgents: seedSubs,
        checkpoints: [{ id: 'turn-1', path: '/Users/saimon/akron-bot-standalone/electron/orch-router.js', existed: true }],
        tools: [
          { id: 'tl-1', name: 'TodoWrite', status: 'done', args: { todos: [{ content: 'Upgrade UI & Code Review', status: 'completed' }, { content: 'Verify E2E suite', status: 'completed' }] } },
          { id: 'tl-2', name: 'Edit', status: 'done', args: { file_path: '/Users/saimon/akron-bot-standalone/electron/orch-router.js', old_string: 'old1\nold2', new_string: 'new1\nnew2\nnew3\nnew4' } },
        ],
        ts: Date.now() - 10000,
      },
    ],
  }];

  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv-parity'))});
    localStorage.setItem('autobot:workspace:conv-parity', ${JSON.stringify(JSON.stringify('/Users/saimon/akron-bot-standalone'))});
  `);
  await win.reload();
  await sleep(600);

  // 1. Test Browser Maximize & Restore click
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = [...document.querySelectorAll('nav.sidenav button')].find((b) => /Browser/i.test(b.textContent));
      if (!btn) throw new Error('Sidebar Browser button missing');
      btn.click();
    })();
  `);
  await sleep(300);

  await win.webContents.executeJavaScript(`
    (() => {
      const expBtn = document.querySelector('.browser-tabs-actions button[title*="Expand"]');
      if (!expBtn) throw new Error('Browser Expand button missing');
      expBtn.click();
    })();
  `);
  await sleep(250);

  const expMetrics = await win.webContents.executeJavaScript(`
    (() => {
      const p = document.querySelector('.browser-panel.expanded');
      if (!p) throw new Error('Browser did not enter .expanded');
      const r = p.getBoundingClientRect();
      const restore = document.querySelector('.browser-restore-btn');
      if (!restore) throw new Error('.browser-restore-btn missing in expanded mode');
      const rb = restore.getBoundingClientRect();
      const tabsStyle = getComputedStyle(document.querySelector('.browser-tabs'));
      return {
        panelTop: r.top,
        restoreTop: rb.top,
        restoreText: restore.textContent.trim(),
        tabsNoDrag: tabsStyle.webkitAppRegion || tabsStyle['-webkit-app-region'] || '',
      };
    })();
  `);
  if (expMetrics.panelTop < 40) throw new Error(`Expected maximized browser top >= 40, got ${expMetrics.panelTop}`);
  const imgBrowser = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'browser-maximized-fixed.png'), imgBrowser.toPNG());

  // Click Minimize button and assert expanded class disappears!
  await win.webContents.executeJavaScript(`document.querySelector('.browser-restore-btn').click();`);
  await sleep(200);
  const stillExpanded = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.browser-panel.expanded'))`);
  if (stillExpanded) throw new Error('Clicking Minimize did not exit browser expanded state');

  // Close browser pane
  await win.webContents.executeJavaScript(`document.querySelector('.session-pane-hide').click();`);
  await sleep(150);

  // 2. Open Overview popover -> verify Subagents 6 + Background Tasks -> capture screenshot -> open Subagents panel
  await win.webContents.executeJavaScript(`document.querySelector('.conv-overview-btn').click();`);
  await sleep(200);
  const ovInfo = await win.webContents.executeJavaScript(`
    (() => {
      const pop = document.querySelector('.overview-pop');
      if (!pop) throw new Error('Overview popover missing');
      return { text: pop.innerText };
    })();
  `);
    if (!/Subagents[\s\S]*6/.test(ovInfo.text)) throw new Error('Overview missing Subagents count 6: ' + ovInfo.text);
  const imgOv = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'overview-subagents-menu.png'), imgOv.toPNG());

  // Click Subagents row to expand inline preview, then Open Subagents Panel
  await win.webContents.executeJavaScript(`
    (() => {
      const items = [...document.querySelectorAll('.overview-pop .conv-pop-item')];
      const subRow = items.find((el) => /Subagents/.test(el.textContent));
      if (!subRow) throw new Error('Overview Subagents row missing');
      subRow.click();
    })();
  `);
  await sleep(150);
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.ov-sub-open-all');
      if (!btn) throw new Error('.ov-sub-open-all missing after expanding Subagents row');
      btn.click();
    })();
  `);
  await sleep(250);
  const subPaneCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.subagents-pane .mc-card:not(.supervisor)').length`);
  if (subPaneCount !== 6) throw new Error(`Expected 6 subagent cards in SubagentsPane, got ${subPaneCount}`);
  const imgSa = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'subagents-pane-visualization.png'), imgSa.toPNG());

  // 3. Open Code Review via FilesChangedBar Review button -> check For Turn chip, +10 fold step
  await win.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.files-changed-bar .fcb-btn.primary');
      if (!btn) throw new Error('FilesChangedBar Review button missing');
      btn.click();
    })();
  `);
  await sleep(300);

  const foldBefore = await win.webContents.executeJavaScript(`
    (() => {
      const chip = document.querySelector('.rv-turn-chip-txt')?.textContent?.trim();
      const foldAll = document.querySelector('.rv-fold-all')?.textContent?.trim();
      const stepBtns = document.querySelectorAll('.rv-fold-step').length;
      if (!chip) throw new Error('For Turn chip missing');
      if (!foldAll) throw new Error('+N more lines fold button missing');
      if (stepBtns < 2) throw new Error('Expected +10 fold step buttons');
      return { chip, foldAll };
    })();
  `);
  await win.webContents.executeJavaScript(`document.querySelector('.rv-fold-step').click();`);
  await sleep(150);
  const foldAfter = await win.webContents.executeJavaScript(`document.querySelector('.rv-fold-all')?.textContent?.trim()`);
  const nBefore = parseInt(foldBefore.foldAll, 10);
  const nAfter = parseInt(foldAfter, 10);
  if (!(nAfter === nBefore - 10)) throw new Error(`Expected fold count ${nBefore - 10}, got ${nAfter}`);
  const imgRev = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'code-review-antigravity-diff.png'), imgRev.toPNG());

  // 4. Open Search -> query HIDDEN_FOLD_NEEDLE -> verify auto-unfold & hit -> open inline comment box
  await win.webContents.executeJavaScript(`document.querySelector('.rv-search-toggle').click();`);
  await sleep(120);
  await win.webContents.executeJavaScript(`
    (() => {
      const inp = document.querySelector('.rv-search-in');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'HIDDEN_FOLD_NEEDLE');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    })();
  `);
  await sleep(250);
  const searchCheck = await win.webContents.executeJavaScript(`
    (() => ({
      countText: document.querySelector('.rv-match-count')?.textContent?.trim(),
      hitText: document.querySelector('.rv-hit')?.textContent?.trim(),
      foldsRemaining: document.querySelectorAll('.rv-fold-bar').length,
      opts: [...document.querySelectorAll('.rv-opt')].map((b) => b.textContent.trim()),
    }))();
  `);
  if (searchCheck.hitText !== 'HIDDEN_FOLD_NEEDLE') throw new Error('Search did not auto-unfold fold match: ' + JSON.stringify(searchCheck));

  // Click '+' add comment on a diff line and verify Leave a comment box + Cancel + Mic + Add Comment
  await win.webContents.executeJavaScript(`document.querySelector('.rv-line.add .rv-add-c').click();`);
  await sleep(150);
  const draftCheck = await win.webContents.executeJavaScript(`
    (() => ({
      placeholder: document.querySelector('.rv-draft textarea')?.placeholder,
      cancel: document.querySelector('.rv-draft-cancel')?.textContent?.trim(),
      submit: document.querySelector('.rv-draft-submit')?.textContent?.trim(),
      mic: Boolean(document.querySelector('.rv-draft .rv-mic')),
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
    }))();
  `);
  if (draftCheck.submit !== 'Add Comment' || !draftCheck.mic || draftCheck.overflowX) {
    throw new Error('Inline comment check failed: ' + JSON.stringify(draftCheck));
  }
  const imgSearchComment = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outDir, 'code-review-search-inline-comment.png'), imgSearchComment.toPNG());

  if (pageErrors.length) throw new Error('Page errors: ' + pageErrors.join('; '));
  console.log('UI_ANTIGRAVITY_PARITY_OK', JSON.stringify({
    expMetrics,
    foldBefore,
    foldAfter,
    searchCheck,
    draftCheck,
  }));
  app.quit();
});
