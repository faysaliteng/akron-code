'use strict';
const { app, BrowserWindow, dialog } = require('electron');
dialog.showErrorBox = () => {};
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = (process.env.AKRON_ARTIFACTS_DIR || os.tmpdir());

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../../electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const convs = [];
  for (let i = 0; i < 25; i++) {
    convs.push({
      id: 'c_' + i,
      title: i === 0 ? 'Reply with exactly this token and nothing else: dev-build' : `Conversation item #${i} — refactoring backend routes & UI panels`,
      ts: Date.now() - i * 60000,
      messages: i === 0 ? [
        { id: 'u1', role: 'user', content: 'Run multiagent build and review' },
        {
          id: 'a1',
          role: 'assistant',
          content: 'Completed the multiagent pass and updated server.js.',
          tools: [
            { id: 't1', name: 'Task', status: 'done', args: { description: 'Multiagent test A', name: 'multiagent-test-a' }, result: 'done' },
            { id: 't2', name: 'Write', status: 'done', args: { path: 'server.js', content: 'console.log(1);\nconsole.log(2);\n' }, result: 'Wrote 30 bytes' },
          ],
          subAgents: [
            { key: 'multiagent-test-a', name: 'Multiagent test A', handle: 'multiagent-test-a', status: 'done', role: 'worker', jobRole: 'coder', model: 'qwen3.8-flash', progress: { tools: 1 } },
          ],
        },
      ] : [],
    });
  }

  await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(convs))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('c_0'))});
  `);
  await win.reload();
  await wait(800);

  // 1. Verify 3-zone left sidebar: Workspace + Dock visible even with 25 Recents, Recents scrolls in middle
  const sideStats = await win.webContents.executeJavaScript(`(() => {
    const H = window.innerHeight;
    const dockBtns = [...document.querySelectorAll('.sidenav-dock button')].map(b => ({
      txt: b.textContent.trim(),
      r: b.getBoundingClientRect().toJSON(),
    }));
    const customBtn = document.querySelector('.sidebar-custom-btn')?.getBoundingClientRect().toJSON();
    const convList = document.querySelector('.convlist');
    const clRect = convList?.getBoundingClientRect().toJSON();
    const wsLabel = document.querySelector('.sidebar-top .section-label')?.textContent.trim();
    return {
      H,
      wsLabel,
      dockCount: dockBtns.length,
      dockVisible: dockBtns.every(b => b.r.height > 0 && b.r.top >= 0 && b.r.bottom <= H),
      customVisible: Boolean(customBtn && customBtn.height > 0 && customBtn.bottom <= H),
      convScrollHeight: convList ? convList.scrollHeight : 0,
      convClientHeight: convList ? convList.clientHeight : 0,
      clRect,
    };
  })()`);
  assert.strictEqual(sideStats.wsLabel, 'Workspace');
  assert.strictEqual(sideStats.dockCount, 3);
  assert.ok(sideStats.dockVisible, 'Workspace dock (Code/Terminal/Browser) stays visible');
  assert.ok(sideStats.customVisible, 'Customizations button stays visible at bottom');
  assert.ok(sideStats.convScrollHeight > sideStats.convClientHeight, 'Recents list scrolls inside fixed middle zone');

  // 2. Verify Agent Workers compact card + deduplicated @handle + no horizontal overflow
  const mcCollapsedInit = await win.webContents.executeJavaScript(`(() => {
    const head = document.querySelector('.mc-panel.inline .mc-head');
    const bodyBefore = document.querySelector('.mc-panel.inline .mc-body');
    if (head) head.click();
    return { hasHead: !!head, wasCollapsed: !bodyBefore };
  })()`);
  assert.ok(mcCollapsedInit.hasHead && mcCollapsedInit.wasCollapsed, 'Finished inline Agent Workers defaults to collapsed');
  await wait(200);

  const mcOpenStats = await win.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.mc-panel.inline');
    const grid = panel?.querySelector('.mc-grid');
    const card = panel?.querySelector('.mc-card');
    const name = card?.querySelector('.mc-card-name')?.textContent.trim() || '';
    const cr = card?.getBoundingClientRect();
    const pr = panel?.getBoundingClientRect();
    return {
      singleWorkerClass: Boolean(grid && grid.classList.contains('single-worker')),
      name,
      hasDuplicateAt: /@multiagent-test-a/i.test(name),
      noOverflow: Boolean(card && card.scrollWidth <= card.clientWidth + 2),
      fitsInPanel: Boolean(cr && pr && cr.right <= pr.right + 1),
    };
  })()`);
  assert.ok(mcOpenStats.singleWorkerClass, 'Single worker spans full card row cleanly');
  assert.ok(!mcOpenStats.hasDuplicateAt, 'Redundant @multiagent-test-a handle omitted: ' + mcOpenStats.name);
  assert.ok(mcOpenStats.noOverflow && mcOpenStats.fitsInPanel, 'Worker card fits with zero overflow');

  await wait(150);
  const img1 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'agent-workers-compact.png'), img1.toPNG());
  fs.writeFileSync(path.join(OUT_DIR, 'sidebar-smart-layout.png'), img1.toPNG());

  // 3. Open Review pane, verify close button on sole Review tab AND pane hide button AND Escape
  await win.webContents.executeJavaScript(`
    document.querySelector('.fcb-btn.primary')?.click();
  `);
  await wait(250);
  const reviewBefore = await win.webContents.executeJavaScript(`(() => {
    const pane = document.querySelector('.session-pane');
    const tabX = document.querySelector('.sp-tab .sp-tab-x');
    const hideBtn = document.querySelector('.session-pane-hide');
    return { hasPane: !!pane, hasTabX: !!tabX, hasHideBtn: !!hideBtn };
  })()`);
  assert.ok(reviewBefore.hasPane && reviewBefore.hasTabX && reviewBefore.hasHideBtn, 'Review tab shows close (X) even as sole tab');

  await win.webContents.executeJavaScript(`document.querySelector('.sp-tab .sp-tab-x')?.click();`);
  await wait(150);
  const closedByTabX = await win.webContents.executeJavaScript(`!document.querySelector('.session-pane')`);
  assert.ok(closedByTabX, 'Clicking Review tab X closes the Review pane cleanly');

  // Re-open Review & verify .session-pane-hide closes it
  await win.webContents.executeJavaScript(`document.querySelector('.fcb-btn.primary')?.click();`);
  await wait(150);
  await win.webContents.executeJavaScript(`document.querySelector('.session-pane-hide')?.click();`);
  await wait(150);
  const closedByHide = await win.webContents.executeJavaScript(`!document.querySelector('.session-pane')`);
  assert.ok(closedByHide, 'Clicking top-right pane X closes the Review pane cleanly');

  // 4. Open Customizations -> Skills & Plugins inside SettingsModal, check MCP & Memory sections too
  await win.webContents.executeJavaScript(`document.querySelector('.sidebar-custom-btn')?.click();`);
  await wait(250);
  const settingsH2 = await win.webContents.executeJavaScript(`document.querySelector('.settings-head h2')?.textContent.trim()`);
  assert.strictEqual(settingsH2, 'Skills & Plugins');
  const img2 = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'settings-customizations-hub.png'), img2.toPNG());

  const hasNavBtns = await win.webContents.executeJavaScript(`(() => {
    const btns = [...document.querySelectorAll('.settings-nav-btn')];
    const mcpBtn = btns.find(b => /MCP Connectors/i.test(b.textContent));
    const memBtn = btns.find(b => /Memory & Notebooks/i.test(b.textContent));
    mcpBtn?.click();
    return Boolean(mcpBtn && memBtn);
  })()`);
  await wait(150);
  const hMcp = await win.webContents.executeJavaScript(`document.querySelector('.settings-head h2')?.textContent.trim()`);
  assert.ok(hasNavBtns && hMcp === 'MCP Connectors', 'SettingsModal includes Skills & Plugins, MCP Connectors, and Memory & Notebooks (got: ' + hMcp + ')');

  // Verify Escape key closes Review pane cleanly as well
  await win.webContents.executeJavaScript(`document.querySelector('.settings-head .icon-btn')?.click();`);
  await wait(150);
  await win.webContents.executeJavaScript(`document.querySelector('.fcb-btn.primary')?.click();`);
  await wait(200);
  await win.webContents.executeJavaScript(`document.querySelector('.rv-pane')?.focus();`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(150);
  const closedByEsc = await win.webContents.executeJavaScript(`!document.querySelector('.session-pane')`);
  assert.ok(closedByEsc, 'Pressing Escape inside Review closes the Review pane');

  console.log('UI_LAYOUT_FIXES_VERIFY_OK', JSON.stringify({ sideStats, mcOpenStats, reviewBefore }));
  app.quit();
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
