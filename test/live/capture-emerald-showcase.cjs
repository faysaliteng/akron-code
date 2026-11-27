'use strict';
const { dialog } = require('electron');
dialog.showErrorBox = () => {};
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = path.join(ROOT, 'docs', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

let activeSettings = {
  theme: 'dark',
  surfaceFinish: 'emerald-carbon',
  locale: 'en',
  preventSleep: true,
  keepInTray: false,
  updateChannel: 'stable',
  autoUpdateScheduler: true,
  browserLinkMode: 'internal',
  browserAllowUrls: '*.github.com\ndocs.python.org',
  browserDenyUrls: 'admin.internal/*',
  orchestratorModel: 'claude-opus-4-6',
  executorModel: 'claude-sonnet-4-6',
  typography: { uiPreset: 'system', uiSize: 14.75, monoPreset: 'system', monoSize: 13, ligatures: true },
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-showcase-'));

function registerHandlers() {
  const tokenBudgetMod = require(path.join(ROOT, 'electron', 'token-budget'));
  const browserRulesMod = require(path.join(ROOT, 'electron', 'browser-rules'));
  const diagnosticsMod = require(path.join(ROOT, 'electron', 'diagnostics'));

  const mockConvs = [
    {
      id: 'c_em1',
      title: 'Optimize Browser Bot AX Snapshots',
      cwd: path.join(ROOT, 'electron'),
      updatedAt: Date.now() - 45000,
      pinned: true,
      model: 'claude-opus-4-6',
      messages: [
        { role: 'user', content: 'Reduce DOM snapshot size with @e12 refs and add TOTP vault autofill.' },
        { role: 'assistant', content: 'Implemented compact AX tree snapshots, SoM fallback, and RFC 6238 Vault TOTP.' },
      ],
    },
    {
      id: 'c_em2',
      title: 'Audit Token Budget & Carbon UI',
      cwd: ROOT,
      updatedAt: Date.now() - 1800000,
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'Verify 20k budget cap & demotion logic.' }],
    },
  ];

  const handlers = {
    'autobot:getSettings': () => activeSettings,
    'autobot:setSettings': (_e, patch) => {
      activeSettings = { ...activeSettings, ...(patch || {}) };
      return activeSettings;
    },
    'autobot:getProviders': () => [],
    'autobot:getOrchestrator': () => ({ enabled: true, providers: [], activeIndex: -1, pools: { enabled: false } }),
    'autobot:getFeatures': () => ({ computerUse: true, remoteServerEnabled: true, quickEntry: true }),
    'autobot:ollamaModels': () => ({ ok: false, base: '', models: [] }),
    'autobot:listConvs': () => mockConvs,
    'autobot:dbListConvs': () => mockConvs,
    'autobot:getConv': () => null,
    'autobot:listProjects': () => [{ id: 'p_akron', name: 'Akron Code', cwd: ROOT, pinned: true, instructions: 'Run typecheck and brand:check before commit.' }],
    'autobot:listSkills': () => [],
    'autobot:getSkills': () => [],
    'autobot:listNotebooks': () => [],
    'autobot:listMemory': () => [],
    'autobot:getMemory': () => ({ entries: [] }),
    'autobot:listMcpServers': () => [{ id: 'rea', name: 'rea', command: 'rea-mcp' }],
    'autobot:mcpStatus': () => [],
    'autobot:customToolList': () => [],
    'autobot:listSlashActions': () => [],
    'autobot:getAccounts': () => ({ claude: [], chatgpt: [], antigravity: [], grok: [] }),
    'autobot:getVersion': () => ({ version: '1.1.0' }),
    'autobot:getCwd': () => ROOT,
    'autobot:getWorkspace': () => ROOT,
    'autobot:getDefaultCwd': () => ROOT,
    'autobot:getPermissions': () => ({ allow: [], deny: [], ask: [], defaultMode: 'auto' }),
    'autobot:tokenBudget': () => tokenBudgetMod.analyzeCustomizationBudget({
      cwd: ROOT,
      capTokens: 20000,
      globalRules: [{ id: 'g1', name: '~/.claude/CLAUDE.md', content: 'Always verify outputs cleanly.', tokens: 1850 }],
      projectRules: [{ id: 'p1', name: 'CLAUDE.md', content: 'Follow Milestone test gates.', tokens: 1200, pinned: true }],
      skills: [
        { name: 'browser-automation', instructions: 'x'.repeat(2400), source: 'user', file: '~/.claude/skills/browser/SKILL.md', tokens: 6400 },
        { name: 'large-legacy-pack', instructions: 'y'.repeat(52000), source: 'user', file: '~/.claude/skills/legacy/SKILL.md', tokens: 13200 },
      ],
      mcpTools: [{ name: 'rea_analyze', server: 'rea', description: 'Binary & bundle analyzer', tokens: 890 }],
    }),
    'autobot:setPreventSleep': (_e, enabled) => ({ ok: true, enabled: !!enabled }),
    'autobot:browserRulesCheck': (_e, p) => browserRulesMod.evaluateBrowserUrlRule(p && p.url, p),
    'autobot:generateDiagnostics': (_e, p) => diagnosticsMod.generateDiagnosticBundle(p || {}),
    'autobot:migrationScan': () => ({
      ok: true,
      readOnlySource: true,
      count: 3,
      items: [
        { id: 'cursor:mcp', source: 'cursor', kind: 'mcp', label: 'Cursor MCP Servers (2)', path: '~/.cursor/mcp.json' },
        { id: 'claude:global-md', source: 'claude', kind: 'rules', label: 'Global ~/.claude/CLAUDE.md', path: '~/.claude/CLAUDE.md' },
        { id: 'vscode:settings', source: 'vscode', kind: 'preferences', label: 'VS Code Editor Preferences', path: 'User/settings.json' },
      ],
    }),
  };

  Object.entries(handlers).forEach(([ch, fn]) => {
    try { ipcMain.removeHandler(ch); ipcMain.handle(ch, fn); } catch (_) {}
  });
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const channels = [...preloadSrc.matchAll(/ipcRenderer\.(?:invoke|sendSync)\(['"]([^'"]+)['"]/g)].map((m) => m[1]);
  for (const ch of new Set(channels)) {
    if (!handlers[ch]) {
      try { ipcMain.handle(ch, async () => null); } catch (_) {}
    }
  }
}

async function capture(win, name) {
  await new Promise((r) => setTimeout(r, 250));
  const img = await win.webContents.capturePage();
  const dest = path.join(OUT_DIR, name);
  fs.writeFileSync(dest, img.toPNG());
  console.log('CAPTURED:', dest);
}

async function clickSettingsSection(win, labelText) {
  await win.webContents.executeJavaScript(`(() => {
    const btns = Array.from(document.querySelectorAll('.settings-nav-btn'));
    const b = btns.find((el) => el.textContent && el.textContent.includes(${JSON.stringify(labelText)}));
    if (b) b.click();
    return !!b;
  })()`);
}

app.whenReady().then(async () => {
  try {
    registerHandlers();
    const win = new BrowserWindow({
      width: 1440,
      height: 900,
      show: false,
      backgroundColor: '#0c1210',
      webPreferences: {
        preload: path.join(ROOT, 'electron', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webviewTag: true,
        paintWhenInitiallyHidden: true,
      },
    });
    win.webContents.on('console-message', (_e, level, msg, line, sourceId) => {
      if (level >= 2) console.error(`[renderer-console:${level}] ${msg} (${sourceId}:${line})`);
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      console.error(`[did-fail-load] ${code} ${desc} ${url}`);
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[render-process-gone]', details);
    });

    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await new Promise((r) => setTimeout(r, 900));

    // Inject rich localStorage state & reload cleanly
    await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem('autobot:settings', JSON.stringify(${JSON.stringify(activeSettings)}));
      localStorage.setItem('autobot:projects', JSON.stringify([{ id: 'p_akron', name: 'Akron Code', cwd: ${JSON.stringify(ROOT)}, pinned: true, instructions: 'Always verify typecheck and brand integrity.' }]));
      localStorage.setItem('autobot:convs', JSON.stringify([
        { id: 'c_em1', title: 'Optimize Browser Bot AX Snapshots', cwd: ${JSON.stringify(ROOT)}, ts: Date.now() - 45000, updatedAt: Date.now() - 45000, pinned: true, messages: [{ id: 'u1', role: 'user', content: 'Reduce DOM tokens with @e12 refs.', ts: Date.now() - 44000 }, { id: 'a1', role: 'assistant', content: 'Shipped compact AX & TOTP vault.', ts: Date.now() - 40000 }] },
        { id: 'c_em2', title: 'Audit 20k Token Budget', cwd: ${JSON.stringify(ROOT)}, ts: Date.now() - 1800000, updatedAt: Date.now() - 1800000, messages: [{ id: 'u2', role: 'user', content: 'Check Global vs Project tokens.', ts: Date.now() - 1790000 }] }
      ]));
      localStorage.setItem('autobot:activeId', JSON.stringify('c_em1'));
      localStorage.setItem('autobot:openTabs', JSON.stringify(['c_em1', 'c_em2']));
    })()`);
    await win.loadFile(path.join(ROOT, 'dist', 'index.html'));
    await new Promise((r) => setTimeout(r, 1000));

    const domCheck = await win.webContents.executeJavaScript(`(() => ({
      rootLen: (document.getElementById('root')?.innerHTML || '').length,
      hasApp: !!document.querySelector('.app'),
      hasSidebar: !!document.querySelector('.sidebar'),
      appTheme: document.querySelector('.app')?.getAttribute('data-theme'),
      appSurface: document.querySelector('.app')?.getAttribute('data-surface'),
      bodyTextSample: (document.body?.innerText || '').slice(0, 200),
    }))()`);
    console.log('DOM_CHECK:', JSON.stringify(domCheck));
    if (!domCheck.hasSidebar || domCheck.rootLen < 100) {
      throw new Error('Renderer failed to mount sidebar: ' + JSON.stringify(domCheck));
    }

    // 1. Dark Glossy Emerald Carbon Sidebar + Mission Control ($ Saved badge)
    await win.webContents.executeJavaScript(`(() => {
      const btns = Array.from(document.querySelectorAll('.sidenav button'));
      const m = btns.find((b) => b.textContent && b.textContent.includes('Mission'));
      if (m) m.click();
    })()`);
    await capture(win, 'emerald-dark-sidebar-mission.png');

    // 2. Open Settings Modal & capture all extended settings tabs in Dark
    await win.webContents.executeJavaScript(`(() => {
      const btn = document.querySelector('.sidebar-settings-btn');
      if (btn) btn.click();
    })()`);
    await new Promise((r) => setTimeout(r, 350));

    await clickSettingsSection(win, 'Models & Providers');
    await capture(win, 'settings-models-limit-rings-dark.png');

    await clickSettingsSection(win, 'Project & Budget');
    await new Promise((r) => setTimeout(r, 300));
    await capture(win, 'settings-project-token-budget-dark.png');

    await clickSettingsSection(win, 'Appearance & System');
    await capture(win, 'settings-application-updater-dark.png');

    await clickSettingsSection(win, 'Browser Extension');
    await capture(win, 'settings-browser-rules-dark.png');

    await clickSettingsSection(win, 'Import & Migrate');
    await new Promise((r) => setTimeout(r, 250));
    await capture(win, 'settings-migration-wizard-dark.png');

    await clickSettingsSection(win, 'Give Feedback');
    await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('[data-testid="generate-diag-btn"]');
      if (b) b.click();
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    await capture(win, 'settings-feedback-diagnostics-dark.png');

    // 3. Switch to crisp Light Carbon Pearl theme & capture key Light screenshots
    await win.webContents.executeJavaScript(`(() => {
      const appEl = document.querySelector('.app');
      if (appEl) {
        appEl.setAttribute('data-theme', 'light');
        appEl.setAttribute('data-surface', 'emerald-carbon');
      }
      document.documentElement.setAttribute('data-theme', 'light');
    })()`);
    await clickSettingsSection(win, 'Models & Providers');
    await capture(win, 'settings-models-limit-rings-light.png');

    await win.webContents.executeJavaScript(`(() => {
      const closeBtn = document.querySelector('.settings-foot .primary');
      if (closeBtn) closeBtn.click();
    })()`);
    await capture(win, 'emerald-light-sidebar-mission.png');

    console.log('SHOWCASE_CAPTURE_COMPLETE');
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});
