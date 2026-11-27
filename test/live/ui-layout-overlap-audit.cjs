'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
if (dialog) dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const REPO = path.resolve(__dirname, '../..');
const PKG_VER = require(path.join(REPO, 'package.json')).version || '1.5.3';
const SHOT_DIR = process.env.AKRON_AUDIT_SHOT_DIR || '';

// 1x1 emerald PNG for valid local library thumbnails
const SAMPLE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAACdJREFUeNpiZGBg+M/AwMDIyMiABJgYGBj+MzIy/mdgYGBggAAgwAD2QwUJ9g4y0QAAAABJRU5ErkJggg==',
  'base64'
);

async function run() {
  const wsDir = path.join(os.tmpdir(), 'akron-ui-audit-ws');
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });

  const img1 = path.join(wsDir, 'test_banner_thumb.webp');
  const img2 = path.join(wsDir, 'test_banner.png');
  const img3 = path.join(wsDir, 'stage-haze.jpg');
  fs.writeFileSync(img1, SAMPLE_PNG);
  fs.writeFileSync(img2, SAMPLE_PNG);
  fs.writeFileSync(img3, SAMPLE_PNG);

  const mdContent = [
    '# Layout Verification Report',
    '',
    'Checking responsive grids, popovers, and theme contrast across **Akron Code**.',
    '',
    '- Docs mirror at community.lovable.app/events',
    '- Repo https://github.com/faysaliteng/akron-code',
  ].join('\n');
  const mdPath = path.join(wsDir, 'layout-verification-report.md');
  fs.writeFileSync(mdPath, mdContent, 'utf8');

  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };

  try {
    const ideIpc = require(path.join(REPO, 'electron/ide/ipc'));
    ideIpc.register({
      ipcMain,
      normalizeProvider: (p) => p,
      hydrateProvider: (p) => p,
      hydrateOrchestrator: (o) => o,
      store: { get: () => null, set: () => {} },
      broadcast: () => {},
    });
  } catch (_) {}

  const mockSettings = {
    theme: 'dark',
    locale: 'en',
    surfaceFinish: 'emerald-carbon',
    accentColor: '#10b981',
    bgPattern: 'carbon-weave',
    chatWidth: 'antigravity',
    showTimestamps: true,
    timestampFormat: 'date-time',
  };

  const mediaCatalogData = {
    ok: true,
    libraryDir: path.join(os.homedir(), '.autobot', 'media-library'),
    imageModels: [
      { id: 'auto', label: 'Auto (Best Available)', provider: 'Auto', available: true, note: 'Routes across active image keys or free Flux' },
      { id: 'flux-1-schnell', label: 'Flux 1 Schnell (Free AI)', provider: 'Free AI', available: true, note: 'Zero-key fast image generation' },
      { id: 'grok-2-image', label: 'xAI Grok 2 Image', provider: 'xAI', available: false, configKeyId: 'xai', note: 'Requires xAI API key' },
      { id: 'imagen-3.0-generate-002', label: 'Google Imagen 3', provider: 'Google', available: false, configKeyId: 'google', note: 'Requires Gemini API key' },
      { id: 'gpt-image-1', label: 'OpenAI GPT-Image-1', provider: 'OpenAI', available: false, configKeyId: 'openai', note: 'Requires OpenAI API key' },
    ],
    videoModels: [
      { id: 'auto', label: 'Auto (Best Available)', provider: 'Auto', available: true, note: 'Uses active video API or local Canvas Studio' },
      { id: 'akron-video-studio', label: 'Akron Canvas Video (Free)', provider: 'Local', available: true, note: 'Instant MP4/GIF rendering' },
      { id: 'veo-2.0-generate-001', label: 'Google Veo 2', provider: 'Google', available: false, configKeyId: 'google', note: 'Requires Gemini API key' },
      { id: 'sora-2', label: 'OpenAI Sora 2', provider: 'OpenAI', available: false, configKeyId: 'openai', note: 'Requires OpenAI API key' },
    ],
    library: [
      { id: 'm1', name: 'test_banner_thumb.webp', path: img1, kind: 'image', model: 'flux-1-schnell', width: 672, height: 384, sizeBytes: 4096, inCurrentProject: true, previewDataUrl: 'data:image/png;base64,' + SAMPLE_PNG.toString('base64') },
      { id: 'm2', name: 'test_banner.png', path: img2, kind: 'image', model: 'flux-1-schnell', width: 1344, height: 768, sizeBytes: 242688, inCurrentProject: true, previewDataUrl: 'data:image/png;base64,' + SAMPLE_PNG.toString('base64') },
      { id: 'm3', name: 'stage-haze.jpg', path: img3, kind: 'image', model: 'akron-svg-canvas-studio', width: 1344, height: 768, sizeBytes: 266240, inCurrentProject: false, previewDataUrl: 'data:image/png;base64,' + SAMPLE_PNG.toString('base64') },
    ],
  };

  safe('autobot:getVersion', () => ({ version: PKG_VER, app: PKG_VER, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  safe('autobot:getSettings', () => mockSettings);
  safe('autobot:setSettings', (_e, patch) => Object.assign(mockSettings, patch || {}));
  safe('autobot:getFeatures', () => ({ computerUse: true, chrome: true, bridges: false, extensions: true, developerMode: true, trustedFolders: true }));
  safe('autobot:setFeatures', (_e, patch) => patch || {});
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getProjectMemory', () => ({ files: [], text: '' }));
  safe('autobot:getCuratedMemory', () => ({ autoCurate: true, items: [] }));
  safe('autobot:getSkills', () => [
    { name: 'find-bugs', description: 'Scan repository diffs for logic, security, and UI layout regressions.', source: 'built-in', enabled: true, scope: 'global' },
    { name: 'akron-web-bot', description: 'Control Chrome/Brave/Edge tabs via bridge.', source: 'plugin', enabled: true, scope: 'global' },
  ]);
  safe('autobot:getOrchestrator', () => ({ enabled: true, providers: [] }));
  safe('autobot:orchPaidProvidersGet', () => []);
  safe('autobot:poolsPreset', () => ({ enabled: true, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [] } }));
  safe('autobot:providerModels', () => ({ models: [] }));
  safe('autobot:freellmStatus', () => ({ running: false, providers: [] }));
  safe('autobot:freellmProviders', () => []);
  safe('autobot:freellmCatalog', () => ({ chatModels: [], mediaModels: [], embeddingModels: [], webBotProviders: [] }));
  safe('autobot:freellmDetect', () => ({ ok: true, status: { running: false } }));
  safe('autobot:autoRouterGet', () => ({ ok: true, source: 'openrouter_free' }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => [
    {
      id: 'task_demo_1',
      name: 'Nightly Regression & Dependency Audit',
      prompt: 'Run npm test && check outdated security advisories',
      cron: '0 2 * * *',
      enabled: true,
      model: 'auto',
      cwd: wsDir,
      lastStatus: 'ok',
      lastRunAt: Date.now() - 3600000,
    },
  ]);
  safe('autobot:listScheduledTaskRuns', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [{ name: 'rea', command: 'rea-mcp', connected: true, tools: ['binary_overview', 'inspect_macho'] }], status: [] }));
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 256, binaryPath: '/usr/local/bin/rea-mcp' }));
  safe('autobot:extBridgeStatus', () => ({ running: true, port: 8766, extensionConnected: false, openTabCount: 0, extensionId: 'dhihhgdamadggcjnjphidopodnlkakdm', extensionDir: path.join(REPO, 'resources/akron-browser-bot') }));
  safe('autobot:serverInfo', () => ({ port: 8766, extensionConnected: false }));
  safe('autobot:worktreeList', () => []);
  safe('autobot:gitInfo', () => ({ branch: 'main', clean: true }));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => wsDir);
  safe('autobot:getWorkspace', () => wsDir);
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:listWorkspaceFiles', () => ({ ok: true, files: ['layout-verification-report.md', 'test_banner.png'] }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: {} }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false }));
  safe('autobot:oauthStatus', () => ({ providers: [], total: 0 }));
  safe('autobot:checkpointsList', () => []);
  safe('autobot:checkpointsDiff', () => ({ ok: true, files: [] }));
  safe('autobot:ollamaModels', () => ({ ok: true, models: [] }));
  safe('autobot:getMindmap', () => ({ ok: true, cwd: wsDir, markdown: '# Akron Code\n## Layout Audit\n' }));
  safe('autobot:envGetState', () => ({ active: { kind: 'local', id: null, label: 'This Computer', cwd: wsDir }, sshProfiles: [], sshConfigHosts: [], remoteProfiles: [], hostServer: { enabled: false, port: 0, running: false, url: '' } }));
  safe('autobot:envList', () => ({ activeId: 'local', environments: [] }));
  safe('autobot:dbMigrate', () => ({ ok: true }));
  safe('autobot:dbUpsertConv', () => ({ ok: true }));
  safe('autobot:allSessionsHealth', () => ([
    { id: 'conv_audit_1', title: 'Audit UI overlaps and Light theme contrast', cwd: wsDir, health: 'ok', pct: 31, streaming: false, updatedAt: Date.now() },
  ]));
  safe('autobot:proactiveState', () => ({ ok: true, suggestions: [{ id: 's1', title: 'Run Full Overlap Audit', detail: 'Check every pane & theme' }], matters: [] }));
  safe('autobot:notify', () => ({ ok: true }));
  safe('autobot:depsStatus', () => ({ ok: true, healthyCount: 7, totalBundled: 7, bundled: [], lspServers: [] }));
  safe('autobot:runtimes', () => ({ autoUpdate: true, items: [] }));
  safe('autobot:updateCheck', () => ({ ok: true, currentVersion: PKG_VER, latestVersion: PKG_VER, updateAvailable: false }));
  safe('autobot:notificationsGet', () => ({ enabled: true, sound: true }));
  safe('autobot:listPlugins', () => [
    { id: 'akron-web-bot', name: 'Akron Web Bot', description: 'Live Chrome/Edge/Brave automation bridge over localhost:8766', installed: true, enabled: true, category: 'Browser', source: 'built-in' },
    { id: 'github', name: 'GitHub', description: 'Issues, PRs, Actions, Releases & Workflows integration', installed: false, enabled: false, category: 'Developer Tools', source: 'marketplace' },
  ]);
  safe('autobot:pluginCategories', () => ['Browser', 'Developer Tools']);
  safe('autobot:pluginStats', () => ({ total: 2, installed: 1, enabled: 1 }));
  safe('autobot:registryStatus', () => ({ synced: true, count: 2 }));
  safe('autobot:listAgentDefs', () => [{ id: 'ui-reviewer', name: 'ui-reviewer', description: 'Checks CSS layout overlap and WCAG contrast.', scope: 'global', tools: ['Read', 'Grep'] }]);
  safe('autobot:listOutputStyles', () => ({ defaultStyleId: 'concise', styles: [{ id: 'concise', name: 'Concise', description: 'Tight engineering responses' }] }));
  safe('autobot:getHooks', () => ({ hooks: [] }));
  safe('autobot:searchFiles', () => ({ ok: true, files: ['layout-verification-report.md', 'test_banner.png'] }));
  safe('autobot:searchAll', () => ({ ok: true, matches: [] }));
  safe('autobot:diagnosticsSummary', () => ({ appVersion: PKG_VER }));
  safe('autobot:paradevStatus', () => ({ ok: true, configured: false, appInstalled: false }));
  safe('autobot:devServerDetect', () => ({ ok: true, hasScript: false, running: false }));
  safe('autobot:studioInspect', () => ({ ok: true }));
  safe('autobot:studioAction', () => ({ ok: true }));
  safe('autobot:proactiveSuggest', () => ({ ok: true, suggestions: [] }));
  safe('autobot:tokenBudget', () => ({ ok: true, dailyLimitUsd: 0, monthlyLimitUsd: 0, todayUsd: 0, monthUsd: 0 }));
  safe('autobot:migrationScan', () => ({ ok: true, detected: [] }));
  safe('autobot:gitRun', () => ({ ok: true, out: '' }));
  safe('autobot:mediaStudioCatalog', () => mediaCatalogData);
  safe('autobot:mediaKeysGet', () => ({ keys: {} }));
  safe('autobot:mediaKeysSave', () => ({ ok: true }));
  safe('autobot:pushGetConfig', () => ({ enabled: false }));
  safe('autobot:remoteRelayStatus', () => ({ running: false }));
  safe('autobot:getPermissions', () => ({ mode: 'auto', rules: { allow: [], ask: [], deny: [] } }));
  safe('autobot:getSandbox', () => ({ sandbox: { enabled: true } }));
  safe('autobot:listAuditLedger', () => ({ entries: [] }));
  safe('autobot:browserSyncTabs', () => ({ ok: true }));
  safe('autobot:browserRegister', () => ({ ok: true }));
  safe('autobot:browserUnregister', () => ({ ok: true }));
  safe('autobot:browserLoadURL', () => ({ ok: true }));
  safe('autobot:turnDiffs', () => [{
    path: mdPath,
    relPath: 'layout-verification-report.md',
    status: 'added',
    added: 6,
    removed: 0,
    lines: mdContent.split('\n').map((text, idx) => ({ type: 'add', oldLine: null, newLine: idx + 1, text })),
  }]);
  safe('autobot:gitDiffFiles', () => []);
  safe('autobot:unfurl', () => null);
  safe('autobot:unfurlMany', () => ({}));

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    backgroundColor: '#0b110f',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  const pageErrors = [];
  win.webContents.on('page-error', (e) => pageErrors.push(String(e)));

  const now = Date.now();
  const seedConvs = [{
    id: 'conv_audit_1',
    title: 'Audit UI overlaps and Light theme contrast',
    cwd: wsDir,
    ts: now - 30000,
    updatedAt: now - 1000,
    messages: [
      { id: 'u1', role: 'user', content: 'Check Images & Video Studio and Review pane layout', ts: now - 20000 },
      {
        id: 'a1',
        role: 'assistant',
        model: 'claude-opus-4-8',
        ts: now - 10000,
        usage: { input_tokens: 185000, output_tokens: 4200 },
        content: [
          'Verification report saved to `layout-verification-report.md`.',
          '',
          'Docs link: community.lovable.app/events',
        ].join('\n'),
        tools: [{ id: 'w1', name: 'Write', args: { file_path: mdPath, content: mdContent }, status: 'done', result: 'ok' }],
      },
    ],
  }];

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.clear();
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['conv_audit_1']))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_audit_1'))});
    localStorage.setItem('autobot:settings', ${JSON.stringify(JSON.stringify(mockSettings))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  for (let i = 0; i < 40; i++) {
    const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.sidenav') && document.querySelector('.composer'))`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  const allFindings = [];

  async function scanGeometry(label, shotName = '') {
    await new Promise((r) => setTimeout(r, 250));
    const report = await win.webContents.executeJavaScript(`(() => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const activeModal = document.querySelector('.modal-overlay.settings-fullscreen, .auto-modal-backdrop, .media-doc-lightbox, .modal-overlay');
      const scopeRoot = activeModal || document.body;
      const isVis = (el) => {
        if (!el || !el.isConnected) return false;
        if (activeModal && !activeModal.contains(el)) return false;
        const st = getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) return false;
        return true;
      };
      const clippedRect = (el) => {
        let r = el.getBoundingClientRect();
        let left = r.left, top = r.top, right = r.right, bottom = r.bottom;
        let cur = el.parentElement;
        while (cur && cur !== document.body) {
          const st = getComputedStyle(cur);
          if (st.overflowX !== 'visible' || st.overflowY !== 'visible') {
            const cr = cur.getBoundingClientRect();
            left = Math.max(left, cr.left);
            top = Math.max(top, cr.top);
            right = Math.min(right, cr.right);
            bottom = Math.min(bottom, cr.bottom);
          }
          cur = cur.parentElement;
        }
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      };
      const inPopup = (el) => Boolean(el.closest('.media-model-menu, .model-menu, .perm-menu, .add-context-menu, .conv-popover, .rv-popover, .rv-ctx-menu, .slash-palette, .mention-palette, .notif-drawer, .auto-split-menu, .auto-prompt-model-menu'));
      const desc = (el) => {
        const cls = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
        const txt = (el.getAttribute('placeholder') || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 36);
        return el.tagName.toLowerCase() + cls + (txt ? '("' + txt + '")' : '');
      };

      const overlaps = [];
      const selector = 'button, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea, label, .media-model-picker, .media-field-config-link, .media-doc-badge, .media-doc-title, .cust-scope-badge, .rv-turn-chip, .rv-scope-pill, .rv-file-name, .doc-preview-name, .composer-hint, .model-pill, .perm-pill, .reason-pick, .swarm-pill, .ctx-btn';
      const nodes = [...scopeRoot.querySelectorAll(selector)].filter(isVis).map((el) => ({
        el,
        r: clippedRect(el),
        pop: inPopup(el),
      })).filter((n) => n.r.width >= 3 && n.r.height >= 3);

      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i], b = nodes[j];
          if (a.pop !== b.pop) continue;
          if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
          const iw = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
          const ih = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
          if (iw > 3 && ih > 3) {
            overlaps.push(desc(a.el) + ' <> ' + desc(b.el) + ' [' + Math.round(iw) + 'x' + Math.round(ih) + ']');
          }
        }
      }

      // Clipped placeholder check
      const clippedPlaceholders = [];
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      for (const inp of scopeRoot.querySelectorAll('input[placeholder]')) {
        if (!isVis(inp)) continue;
        const ph = inp.getAttribute('placeholder') || '';
        if (!ph) continue;
        const st = getComputedStyle(inp);
        ctx.font = st.font || (st.fontSize + ' ' + st.fontFamily);
        const pw = ctx.measureText(ph).width;
        const avail = inp.clientWidth - parseFloat(st.paddingLeft || 0) - parseFloat(st.paddingRight || 0);
        if (inp.clientWidth > 60 && pw > avail + 4) {
          clippedPlaceholders.push(desc(inp) + ' need=' + Math.round(pw) + 'px avail=' + Math.round(avail) + 'px');
        }
      }

      // Unintended horizontal overflow on key containers
      const overflows = [];
      const boxSel = '.panel, .media-studio-composer, .media-studio-controls, .media-studio-head, .media-studio-library-bar, .cust-hub-inner, .cust-hero, .cust-shelf-grid, .cust-row, .scheduled-panel, .auto-hub, .settings-card, .rv-subhead, .rv-file-head, .doc-preview-head, .composer, .composer-topbar, .composer-foot';
      for (const box of scopeRoot.querySelectorAll(boxSel)) {
        if (!isVis(box)) continue;
        const st = getComputedStyle(box);
        if (st.overflowX === 'auto' || st.overflowX === 'scroll') continue;
        if (box.scrollWidth > box.clientWidth + 3) {
          overflows.push(desc(box) + ' scrollW=' + box.scrollWidth + ' clientW=' + box.clientWidth);
        }
        const br = box.getBoundingClientRect();
        if (br.right > vw + 2) {
          overflows.push(desc(box) + ' right=' + Math.round(br.right) + ' > vw=' + vw);
        }
      }

      // Contrast check in light and dark modes (WCAG L1/L2)
      const parseRgba = (c) => {
        const m = String(c || '').match(/rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)(?:\\s*,\\s*([\\d.]+))?\\s*\\)/i);
        if (!m) return null;
        return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
      };
      const blend = (fg, bg) => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
      });
      const lum = ({ r, g, b }) => {
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const isLight = document.querySelector('.app')?.getAttribute('data-theme') === 'light';
      const rootBg = isLight ? { r: 248, g: 250, b: 252 } : { r: 11, g: 17, b: 15 };
      const getEffectiveBg = (el) => {
        const chain = [];
        let cur = el;
        while (cur && cur.nodeType === 1) { chain.unshift(cur); cur = cur.parentElement; }
        let acc = { ...rootBg };
        for (const node of chain) {
          const bg = parseRgba(getComputedStyle(node).backgroundColor);
          if (bg && bg.a > 0.01) acc = blend(bg, acc);
        }
        return acc;
      };
      const lowContrast = [];
      for (const el of scopeRoot.querySelectorAll('h1, h2, h3, label, button, .media-model-trigger-label, .rv-file-name, .rv-turn-chip-txt, .rv-scope-pill, .rv-code, .doc-preview-name, .doc-preview-raw, .conv-pop-item, .cust-card-title, .auto-task-desc')) {
        if (!isVis(el)) continue;
        const ownText = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('');
        if (!ownText) continue;
        const fg = parseRgba(getComputedStyle(el).color);
        if (!fg || fg.a < 0.2) continue;
        const bg = getEffectiveBg(el);
        const fgRgb = blend(fg, bg);
        const l1 = lum(fgRgb), l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        if (ratio < 2.5) {
          lowContrast.push(desc(el) + ' ratio=' + ratio.toFixed(2));
        }
      }

      return {
        overlaps: [...new Set(overlaps)],
        clippedPlaceholders: [...new Set(clippedPlaceholders)],
        overflows: [...new Set(overflows)],
        lowContrast: [...new Set(lowContrast)],
      };
    })()`);

    if (SHOT_DIR && shotName) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const img = await win.webContents.capturePage();
      fs.writeFileSync(path.join(SHOT_DIR, `${shotName}.png`), img.toPNG());
    }

    const total = report.overlaps.length + report.clippedPlaceholders.length + report.overflows.length + report.lowContrast.length;
    console.log(`[AUDIT] ${label} -> overlaps=${report.overlaps.length} clippedPH=${report.clippedPlaceholders.length} overflows=${report.overflows.length} lowContrast=${report.lowContrast.length}`);
    if (total > 0) {
      allFindings.push({ label, ...report });
      console.log('   DETAILS:', JSON.stringify(report));
    }
    return report;
  }

  async function clickNav(text) {
    await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.sidenav button, .sidebar-bottom button, .media-studio-mode-tab')].find((b) => (b.textContent || '').includes(${JSON.stringify(text)}));
      if (btn) btn.click();
    })()`);
  }

  async function runSuiteForMode(prefix, opts = {}) {
    if (opts.width && opts.height) {
      win.setSize(opts.width, opts.height);
      await new Promise((r) => setTimeout(r, 200));
    }
    if (opts.theme) {
      await win.webContents.executeJavaScript(`(() => {
        const s = JSON.parse(localStorage.getItem('autobot:settings') || '{}');
        s.theme = ${JSON.stringify(opts.theme)};
        localStorage.setItem('autobot:settings', JSON.stringify(s));
        location.reload();
      })()`);
      await new Promise((r) => win.webContents.once('did-finish-load', r));
      for (let i = 0; i < 40; i++) {
        const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('.sidenav') && document.querySelector('.composer'))`);
        if (ready) break;
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    // 1. Chat + DocPreview + Review
    await win.webContents.executeJavaScript(`document.querySelector('.md-file-chip')?.click()`);
    await scanGeometry(`${prefix} / Chat + DocPreview`);
    await win.webContents.executeJavaScript(`document.querySelector('.fcb-btn.primary')?.click()`);
    await scanGeometry(`${prefix} / Chat + CodeReview`, prefix === '1280-dark' ? 'chat-review-dark' : (prefix === '1280-light' ? 'chat-review-light' : ''));

    // Overview menu popover
    await win.webContents.executeJavaScript(`document.querySelector('.conv-overview-btn')?.click()`);
    await scanGeometry(`${prefix} / Conversation Overview Popover`);
    await win.webContents.executeJavaScript(`document.querySelector('.conv-overview-btn')?.click()`);

    // Close right-hand side pane for full-width view audit (on 1280-dark and 1280-light; keep split pane open on 1040-dark to stress-test narrow container queries!)
    if (prefix !== '1040-dark') {
      await win.webContents.executeJavaScript(`document.querySelector('.session-pane-hide')?.click()`);
      await new Promise((r) => setTimeout(r, 150));
    }

    // 2. Images & Video Studio (Image, Video, Library)
    await clickNav('Images & Video');
    await new Promise((r) => setTimeout(r, 250));
    await scanGeometry(`${prefix} / Image Studio`, prefix === '1280-dark' ? 'image-studio-full-dark' : (prefix === '1280-light' ? 'image-studio-full-light' : ''));
    if (prefix === '1280-dark') {
      await win.webContents.executeJavaScript(`document.querySelector('[data-testid="image-model-trigger"]')?.click()`);
      await scanGeometry(`${prefix} / Image Studio Model Picker Open`);
      await win.webContents.executeJavaScript(`document.querySelector('[data-testid="image-model-trigger"]')?.click()`);
    }

    await clickNav('Video Studio');
    await scanGeometry(`${prefix} / Video Studio`, prefix === '1280-dark' ? 'video-studio-full-dark' : '');

    await clickNav('Media Library');
    await scanGeometry(`${prefix} / Media Library`);

    // 3. Automations
    await clickNav('Automations');
    await scanGeometry(`${prefix} / Automations`, prefix === '1280-dark' ? 'automations-dark' : '');
    if (prefix === '1280-dark') {
      await win.webContents.executeJavaScript(`document.querySelector('.auto-btn-new')?.click()`);
      await scanGeometry(`${prefix} / New Automation Modal`);
      await win.webContents.executeJavaScript(`document.querySelector('.auto-modal-head .icon-btn')?.click()`);
    }

    // 4. Customizations Hub
    await clickNav('Customizations');
    await scanGeometry(`${prefix} / Customizations Marketplace`, prefix === '1280-dark' ? 'customizations-dark' : '');
    await win.webContents.executeJavaScript(`(() => {
      const btn = [...document.querySelectorAll('.cust-seg-btn')].find((b) => (b.textContent || '').includes('Installed'));
      if (btn) btn.click();
    })()`);
    await scanGeometry(`${prefix} / Customizations Installed`);

    // 5. Mission, Projects, Artifacts, Search
    await clickNav('Mission');
    await scanGeometry(`${prefix} / Mission Control`);
    await clickNav('Projects');
    await scanGeometry(`${prefix} / Projects`);
    await clickNav('Artifacts');
    await scanGeometry(`${prefix} / Artifacts`);
    await clickNav('Search');
    await scanGeometry(`${prefix} / Search`);

    // 6. Notification Center + Settings sections (on dark 1280 + compact 1040)
    if (prefix === '1280-dark' || prefix === '1040-dark') {
      await win.webContents.executeJavaScript(`document.querySelector('.notif-bell-btn')?.click()`);
      await scanGeometry(`${prefix} / Notification Center`);
      await win.webContents.executeJavaScript(`document.querySelector('.notif-bell-btn')?.click()`);

      await win.webContents.executeJavaScript(`document.querySelector('.sidebar-settings-btn')?.click()`);
      await new Promise((r) => setTimeout(r, 200));
      const secCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.settings-nav-btn').length`);
      for (let i = 0; i < secCount; i++) {
        const secLabel = await win.webContents.executeJavaScript(`(() => {
          const btns = document.querySelectorAll('.settings-nav-btn');
          const b = btns[${i}];
          if (!b) return '';
          b.click();
          return (b.textContent || '').replace(/[^\\x20-\\x7E]/g, ' ').replace(/\\s+/g, ' ').trim();
        })()`);
        const isMediaSec = /Images & Video/i.test(secLabel);
        await scanGeometry(`${prefix} / Settings > ${secLabel}`, prefix === '1280-dark' && isMediaSec ? 'settings-media-dark' : '');
      }
      await win.webContents.executeJavaScript(`document.querySelector('.settings-back-btn')?.click()`);
    }
  }

  await runSuiteForMode('1280-dark', { width: 1280, height: 820 });
  await runSuiteForMode('1040-dark', { width: 1040, height: 760 });
  await runSuiteForMode('1280-light', { width: 1280, height: 820, theme: 'light' });

  // Also switch back to dark so clean state
  assert.strictEqual(pageErrors.length, 0, 'Page errors: ' + pageErrors.join('; '));
  if (allFindings.length > 0) {
    console.error('UI_LAYOUT_AUDIT_FAILED count=' + allFindings.length);
    for (const f of allFindings) console.error('FAIL:', JSON.stringify(f));
    process.exit(1);
  }
  console.log('UI_LAYOUT_AUDIT_OK');
  try { win.destroy(); } catch (_) {}
  fs.rmSync(wsDir, { recursive: true, force: true });
  process.exit(0);
}

app.whenReady().then(run).catch((e) => { console.error(e); process.exit(1); });
