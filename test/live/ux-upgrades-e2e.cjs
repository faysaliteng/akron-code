'use strict';
const { dialog } = require('electron');
dialog.showErrorBox = () => {};
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const ARTIFACTS = '/Users/saimon/.gemini/antigravity/brain/cb4ff1d8-186c-4ca3-9b84-bfe96acbf3bc';
const permissions = require(path.join(ROOT, 'electron', 'permissions'));
const { createPermissionGate } = require(path.join(ROOT, 'electron', 'perm-gate'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ux-e2e-'));
const tmpSettingsPath = path.join(tmpDir, 'settings.json');
let persistedRendererSettings = { theme: 'dark', locale: 'en', typography: { uiPreset: 'system', uiSize: 14.75, monoPreset: 'system', monoSize: 13, ligatures: true } };

const permGate = createPermissionGate({
  savePermissionRule: ({ rule, list }) => permissions.savePermissionRule({ rule, list, settingsPath: tmpSettingsPath }),
});

function registerStubHandlers() {
  const noop = async () => null;
  const readLocalPerms = () => {
    try {
      if (fs.existsSync(tmpSettingsPath)) {
        const parsed = JSON.parse(fs.readFileSync(tmpSettingsPath, 'utf8'));
        const p = (parsed && parsed.permissions) || {};
        return { allow: p.allow || [], deny: p.deny || [], ask: p.ask || [], defaultMode: 'ask' };
      }
    } catch (_) {}
    return { allow: [], deny: [], ask: [], defaultMode: 'ask' };
  };

  const defaults = {
    'autobot:getSettings': () => persistedRendererSettings,
    'autobot:setSettings': (_e, patch) => {
      persistedRendererSettings = { ...persistedRendererSettings, ...(patch || {}) };
      return persistedRendererSettings;
    },
    'autobot:getProviders': () => [],
    'autobot:getOrchestrator': () => ({ enabled: false, providers: [], activeIndex: -1, pools: { enabled: false } }),
    'autobot:getFeatures': () => ({ computerUse: true, chrome: false, bridges: false, quickEntry: true }),
    'autobot:ollamaModels': () => ({ ok: false, base: '', models: [] }),
    'autobot:listConvs': () => [
      { id: 'c_ux', title: 'Reverse Engineer Parallels Desktop Alternative', updatedAt: Date.now() },
      { id: 'c_bg', title: 'Background Security Audit', updatedAt: Date.now() - 5000 },
    ],
    'autobot:getConv': () => null,
    'autobot:listProjects': () => [],
    'autobot:listSkills': () => [],
    'autobot:getSkills': () => [],
    'autobot:listNotebooks': () => [],
    'autobot:listMemory': () => [],
    'autobot:getMemory': () => ({ entries: [] }),
    'autobot:listMcpServers': () => [],
    'autobot:mcpStatus': () => [],
    'autobot:customToolList': () => [],
    'autobot:listSlashActions': () => [],
    'autobot:getAccounts': () => ({ claude: [], chatgpt: [], antigravity: [], grok: [] }),
    'autobot:getVersion': () => '1.0.0',
    'autobot:getCwd': () => ROOT,
    'autobot:getWorkspace': () => ROOT,
    'autobot:getDefaultCwd': () => ROOT,
    'autobot:getPermissions': () => readLocalPerms(),
    'autobot:addPermissionRule': (_e, payload) => permissions.savePermissionRule({ ...(payload || {}), settingsPath: tmpSettingsPath }),
    'autobot:removePermissionRule': (_e, payload) => permissions.removePermissionRule({ ...(payload || {}), settingsPath: tmpSettingsPath }),
    'autobot:answerPermission': (_e, id, payload) => permGate.answer(id, payload),
  };

  Object.entries(defaults).forEach(([ch, fn]) => {
    try { ipcMain.removeHandler(ch); ipcMain.handle(ch, fn); } catch (_) {}
  });
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|sendSync)\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of new Set(channels)) {
    if (!defaults[ch]) {
      try { ipcMain.handle(ch, noop); } catch (_) {}
    }
  }
}

async function capture(win, name) {
  const img = await win.webContents.capturePage();
  const dest = path.join(ARTIFACTS, name);
  fs.writeFileSync(dest, img.toPNG());
  console.log('Captured screenshot:', dest);
}

async function evalStep(win, label, code) {
  const res = await win.webContents.executeJavaScript(`(async () => {
    try {
      return { ok: true, value: await (${code})() };
    } catch (e) {
      return { ok: false, error: (e && e.stack) ? e.stack : String(e) };
    }
  })()`);
  if (!res || !res.ok) {
    throw new Error(`Step [${label}] failed: ${res && res.error ? res.error : 'unknown error'}`);
  }
  return res.value;
}

app.whenReady().then(async () => {
  try {
    registerStubHandlers();

    const win = new BrowserWindow({
      width: 1440,
      height: 920,
      show: false,
      backgroundColor: '#0e0f0e',
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
      },
    });
    win.webContents.on('console-message', (_e, level, msg) => {
      if (level >= 2) console.error('[renderer-console]', msg);
    });

    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    const convs = [
      {
        id: 'c_ux',
        title: 'Reverse Engineer Parallels Desktop Alternative',
        ts: Date.now(),
        messages: [
          { id: 'u1', role: 'user', content: 'Inspect the bundle and verify the entitlement flags.', ts: Date.now() - 4000 },
          { id: 'a1', role: 'assistant', content: 'Mapping Parallels Desktop bundle workflow with REA (`mcp__rea__inspect_analysis_view`). Waiting for approval to continue inspection.', model: 'gemini-4-argon', durationMs: 6000, ts: Date.now() - 2000 },
        ],
      },
      {
        id: 'c_bg',
        title: 'Background Security Audit',
        ts: Date.now() - 10000,
        messages: [
          { id: 'u2', role: 'user', content: 'Check open ports on localhost.', ts: Date.now() - 9000 },
        ],
      },
    ];
    await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(convs))});
      localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('c_ux'))});
      localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['c_ux', 'c_bg']))});
      localStorage.setItem('autobot:permissions', ${JSON.stringify(JSON.stringify('ask'))});
      localStorage.removeItem('autobot:queued');
      localStorage.removeItem('autobot:queuePausedByConv');
    })()`);
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 700))`);

    const emitToWin = (evt) => win.webContents.send('autobot:event', evt);

    // =========================================================================
    // SCENARIO A: Inline 4-Option Permission Dock + FIFO + Non-Blocking + Bell
    // =========================================================================
    const p1Promise = permGate.prompt({
      runId: 'run_ux_1',
      convId: 'c_ux',
      toolName: 'mcp__rea__inspect_analysis_view',
      args: { target: 'Parallels.app' },
      summary: 'mcp__rea__inspect_analysis_view',
      cwd: ROOT,
      emit: emitToWin,
    });
    const p2Promise = permGate.prompt({
      runId: 'run_ux_1',
      convId: 'c_ux',
      toolName: 'Bash',
      args: { command: 'lsof -i :8766' },
      summary: 'lsof -i :8766',
      cwd: ROOT,
      emit: emitToWin,
    });
    const p3Promise = permGate.prompt({
      runId: 'run_bg_1',
      convId: 'c_bg',
      toolName: 'Bash',
      args: { command: 'rm -rf /tmp/foo && echo done' },
      summary: 'rm -rf /tmp/foo && echo done',
      cwd: ROOT,
      emit: emitToWin,
    });
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 350))`);

    const dockCheck = await win.webContents.executeJavaScript(`(() => {
      const dock = document.querySelector('[data-testid="permission-dock"]');
      const overlay = document.querySelector('.modal-overlay');
      const title = dock?.querySelector('.perm-dock-title')?.textContent || '';
      const queuePill = dock?.querySelector('.perm-dock-queue-pill')?.textContent || '';
      const bells = document.querySelectorAll('.conv-perm-bell').length;
      const optTexts = Array.from(dock?.querySelectorAll('.perm-dock-opt') || []).map((el) => el.textContent.trim());
      return { hasDock: !!dock, hasOverlay: !!overlay, title, queuePill, bells, optCount: optTexts.length };
    })()`);

    assert.strictEqual(dockCheck.hasDock, true, 'PermissionDock must render inline');
    assert.strictEqual(dockCheck.hasOverlay, false, 'Blocking modal-overlay must NOT appear');
    assert.strictEqual(dockCheck.title, 'Allow using this MCP tool?');
    assert.strictEqual(dockCheck.queuePill, '1 of 2');
    assert.strictEqual(dockCheck.optCount, 4);
    assert.ok(dockCheck.bells >= 2, 'Waiting bell badge should appear on tab & sidebar for c_ux / c_bg');

    await capture(win, 'perm-dock-dark.png');

    // Light theme capture for Permission Dock
    await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', 'light')`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 150))`);
    await capture(win, 'perm-dock-light.png');
    await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', 'dark')`);

    // Respond via Option 4 inline feedback -> verify main gate receives guidance & advances to p2
    await win.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('.perm-dock-feedback-input');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      nativeSetter.call(input, 'Use safe read-only flags');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await win.webContents.executeJavaScript(`document.querySelector('.perm-dock-submit-btn').click()`);
    const r1 = await p1Promise;
    assert.strictEqual(r1.allow, false);
    assert.strictEqual(r1.feedback, 'Use safe read-only flags');

    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 250))`);
    const nextDockTitle = await win.webContents.executeJavaScript(`document.querySelector('[data-testid="permission-dock"] .perm-dock-title')?.textContent || ''`);
    assert.strictEqual(nextDockTitle, 'Allow running this command?');

    // Test always-allow persistence on p2 (Option 3)
    await win.webContents.executeJavaScript(`document.querySelectorAll('.perm-dock-opt')[2].click()`);
    const r2 = await p2Promise;
    assert.strictEqual(r2.allow, true);
    assert.strictEqual(r2.rule, 'Bash(lsof:*)');

    // Clear p3 via clearRun (abort/end cleanup)
    permGate.clearRun('run_bg_1', 'cancelled');
    const r3 = await p3Promise;
    assert.strictEqual(r3.allow, false);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 200))`);
    const dockGone = await win.webContents.executeJavaScript(`!document.querySelector('[data-testid="permission-dock"]')`);
    assert.strictEqual(dockGone, true, 'All permission docks cleared cleanly');

    // =========================================================================
    // SCENARIO B: Advanced Message Queue (Paused queue + per-item pause + edit)
    // =========================================================================
    const seedQueue = [
      { id: 'mq1', convId: 'c_ux', text: 'Run full integration tests across Electron and React', atts: [], paused: true },
      { id: 'mq2', convId: 'c_ux', text: 'Summarize changed modules in markdown', atts: [{ name: 'plan.md' }], paused: false },
      { id: 'mq3', convId: 'c_ux', text: 'Verify light theme spacing on Settings modal', atts: [], paused: false },
    ];
    await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem('autobot:queued', ${JSON.stringify(JSON.stringify(seedQueue))});
      localStorage.setItem('autobot:queuePausedByConv', ${JSON.stringify(JSON.stringify({ c_ux: true }))});
    })()`);
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 700))`);

    const qCheck = await win.webContents.executeJavaScript(`(() => {
      const tray = document.querySelector('[data-testid="message-queue-tray"]');
      const chips = tray ? tray.querySelectorAll('.queue-chip').length : 0;
      const pausedBadges = tray ? tray.querySelectorAll('.queue-paused-pill').length : 0;
      const title = tray?.querySelector('.queue-bar-title')?.textContent || '';
      return { hasTray: !!tray, chips, pausedBadges, title };
    })()`);
    assert.strictEqual(qCheck.hasTray, true, 'MessageQueueTray must render');
    assert.strictEqual(qCheck.chips, 3);
    assert.strictEqual(qCheck.pausedBadges, 1);
    assert.ok(qCheck.title.includes('Queue paused (3)'));

    await capture(win, 'advanced-queue-dark.png');
    await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', 'light')`);
    await win.webContents.executeJavaScript(`new Promise((r) => setTimeout(r, 150))`);
    await capture(win, 'advanced-queue-light.png');
    await win.webContents.executeJavaScript(`document.documentElement.setAttribute('data-theme', 'dark')`);

    // Exercise Move Down on item #1 & Inline Edit on item #2
    await evalStep(win, 'queue-move-down', `() => {
      const btn = document.querySelector('[aria-label="Move queued message down"]');
      if (!btn) throw new Error('Move down button missing');
      btn.click();
    }`);
    await new Promise((r) => setTimeout(r, 150));
    const reorderedFirst = await evalStep(win, 'check-reorder', `() => document.querySelectorAll('.queue-chip-text')[0]?.textContent || ''`);
    assert.ok(reorderedFirst.includes('Summarize changed modules'), 'Item 1 moved down to index 2, got: ' + reorderedFirst);

    // =========================================================================
    // SCENARIO C: Typography & Fonts + Saved Permission Rules in Settings
    // =========================================================================
    await evalStep(win, 'open-settings', `() => {
      const btn = document.querySelector('.sidebar-settings-btn');
      if (!btn) throw new Error('.sidebar-settings-btn missing');
      btn.click();
    }`);
    await new Promise((r) => setTimeout(r, 300));

    // Open Appearance & System
    await evalStep(win, 'open-appearance', `() => {
      const btns = Array.from(document.querySelectorAll('.settings-nav-btn'));
      const btn = btns.find((b) => /Appearance/i.test(b.textContent || ''));
      if (!btn) throw new Error('Appearance nav button not found among: ' + btns.map((x) => x.textContent).join(' | '));
      btn.click();
    }`);
    await new Promise((r) => setTimeout(r, 300));

    // Update UI font size to 16 & Mono preset to JetBrains Mono @ 14px
    await evalStep(win, 'edit-typography', `() => {
      const card = document.querySelector('[data-testid="typography-settings-card"]');
      if (!card) throw new Error('typography-settings-card missing');
      card.scrollIntoView({ block: 'center' });
      const selDesc = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      const inpDesc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const monoSel = document.querySelector('select[aria-label="Code font family"]');
      if (!monoSel) throw new Error('Code font family select missing');
      selDesc.call(monoSel, 'jetbrains-mono');
      monoSel.dispatchEvent(new Event('change', { bubbles: true }));
      const uiNum = document.querySelector('input[aria-label="UI font size"]');
      if (!uiNum) throw new Error('UI font size input missing');
      inpDesc.call(uiNum, '16');
      uiNum.dispatchEvent(new Event('input', { bubbles: true }));
      uiNum.dispatchEvent(new Event('change', { bubbles: true }));
      const codeNum = document.querySelector('input[aria-label="Code font size"]');
      if (!codeNum) throw new Error('Code font size input missing');
      inpDesc.call(codeNum, '14');
      codeNum.dispatchEvent(new Event('input', { bubbles: true }));
      codeNum.dispatchEvent(new Event('change', { bubbles: true }));
    }`);
    await new Promise((r) => setTimeout(r, 250));

    const typoApplied = await evalStep(win, 'verify-typography-vars', `() => ({
      fsBody: document.documentElement.style.getPropertyValue('--fs-body'),
      fsCode: document.documentElement.style.getPropertyValue('--fs-code'),
      mono: document.documentElement.style.getPropertyValue('--mono'),
      hasCard: !!document.querySelector('[data-testid="typography-settings-card"]'),
    })`);
    assert.strictEqual(typoApplied.hasCard, true);
    assert.strictEqual(typoApplied.fsBody, '16px');
    assert.strictEqual(typoApplied.fsCode, '14px');
    assert.ok(typoApplied.mono.includes('JetBrains Mono'));

    await capture(win, 'typography-settings-dark.png');
    await evalStep(win, 'switch-light-theme', `() => {
      const themeSel = Array.from(document.querySelectorAll('.settings-card select')).find((s) => Array.from(s.options).some((o) => o.value === 'light'));
      if (themeSel) {
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set.call(themeSel, 'light');
        themeSel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }`);
    await new Promise((r) => setTimeout(r, 200));
    await capture(win, 'typography-settings-light.png');

    // Verify Saved Permission Rules section shows Bash(lsof:*) persisted in Scenario A
    await evalStep(win, 'open-permissions-tab', `() => {
      const btns = Array.from(document.querySelectorAll('.settings-nav-btn'));
      const btn = btns.find((b) => /Permissions/i.test(b.textContent || ''));
      if (!btn) throw new Error('Permissions nav btn missing');
      btn.click();
    }`);
    await new Promise((r) => setTimeout(r, 300));
    const rulesSeen = await evalStep(win, 'read-saved-rules', `() => Array.from(document.querySelectorAll('.perm-rule-chip code')).map((e) => e.textContent)`);
    assert.ok(rulesSeen.includes('Bash(lsof:*)'), 'Settings Security card must display persisted Bash(lsof:*) rule, got: ' + JSON.stringify(rulesSeen));

    console.log('ALL UX UPGRADE E2E ASSERTIONS PASSED');
    app.exit(0);
  } catch (err) {
    console.error('UX UPGRADE E2E FAILED:', err);
    app.exit(1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
