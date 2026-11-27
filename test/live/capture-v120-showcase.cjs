'use strict';
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
dialog.showErrorBox = () => {};
app.on('window-all-closed', (e) => e.preventDefault());

const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '../..');
const OUT_DIR = path.join(REPO, 'docs', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

async function buildTempWorkspace() {
  const root = '/tmp/akron-workspace';
  fs.rmSync(root, { recursive: true, force: true });
  const wsDir = path.join(root, 'akron-code');
  fs.mkdirSync(path.join(wsDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'reports'), { recursive: true });
  fs.mkdirSync(path.join(wsDir, 'test'), { recursive: true });

  fs.writeFileSync(
    path.join(wsDir, 'src', 'app.js'),
    [
      '// Akron Code v1.4.0 — Core Orchestrator Entrypoint',
      'export async function dispatchTurn({ prompt, role = "coder", budgetTokens = 20000 }) {',
      '  const startedAt = Date.now();',
      '  return { ok: true, role, budgetTokens, startedAt, promptLen: String(prompt || "").length };',
      '}',
      '',
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(wsDir, 'src', 'theme.css'),
    ':root {\n  --accent: #10b981;\n  --accent-soft: rgba(16, 185, 129, 0.14);\n}\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(wsDir, 'README.md'),
    '# Akron Code Sample Workspace\n\nAutonomous multi-agent IDE workbench.\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(wsDir, 'MINDMAP.md'),
    [
      '# Akron Code v1.4 Architecture',
      '## Harness & Context Engine 2.0',
      '- `electron/context-pipeline.js` · Progressive output masking',
      '- `electron/spill.js` · 0o600 disk spill & pruning',
      '- `electron/loop-guard.js` · 3/5/8 doom-loop circuit breaker',
      '## Multi-Vendor Router & OAuth Auto-Heal',
      '- `electron/orch-router.js` · 8-role capability routing',
      '- `electron/provider-oauth.js` · Single-flight OAuth refresh',
      '## Universal Media & Office Studio',
      '- `electron/media-gen.js` · GenerateImage / EditImage / GenerateVideo',
      '- `electron/doc-studio.js` · Offline PDF / DOCX / XLSX / PPTX / ZIP',
      '## IDE Workbench & Browser Bot',
      '- `src/ide/IdeWorkbench.jsx` · Monaco · xterm.js · Markmap',
      '- `resources/akron-browser-bot` · Live MV3 Extension (:8766)',
      '',
    ].join('\n'),
    'utf8'
  );

  // Copy real brand PNG & generate real XLSX + PDF via offline doc-studio
  fs.copyFileSync(path.join(REPO, 'build', 'icon.png'), path.join(wsDir, 'assets', 'akron-emblem.png'));
  const docStudio = require(path.join(REPO, 'electron/doc-studio'));
  await docStudio.generateDocument(
    {
      format: 'xlsx',
      output_path: path.join(wsDir, 'reports', 'model-matrix.xlsx'),
      sheets: [
        {
          name: 'Role Pools',
          rows: [
            ['Role', 'Primary Provider', 'Fallback Chain', 'Latency', 'Status'],
            ['planner', 'Anthropic Claude Opus 4.6', 'OpenAI GPT-5.4 → Gemini 2.5 Pro', '420ms', 'Ready'],
            ['coder', 'Anthropic Claude Sonnet 4.6', 'GPT-5.3 Codex → DeepSeek R1', '280ms', 'Ready'],
            ['image_gen', 'Gemini Imagen 4', 'OpenAI GPT Image 1 → Offline SVG', '1.9s', 'Ready'],
            ['video_gen', 'Veo 3 Fast', 'Sora 2 → FFmpeg Motion', '4.4s', 'Ready'],
          ],
        },
        {
          name: 'Release Benchmarks',
          rows: [
            ['Suite', 'Cases', 'Passed', 'Coverage'],
            ['harness-context', 18, 18, '100%'],
            ['coding-apply-patch', 22, 22, '100%'],
            ['media-doc-studio', 16, 16, '100%'],
            ['security-sandbox', 14, 14, '100%'],
          ],
        },
      ],
    },
    { cwd: wsDir }
  );
  await docStudio.generateDocument(
    {
      format: 'pdf',
      output_path: path.join(wsDir, 'reports', 'q4-roadmap.pdf'),
      title: 'Akron Code v1.4.0 — Architecture & Security Sign-Off',
      content: [
        '# Executive Summary',
        'Akron Code unifies multi-vendor frontier coding models, offline Office/PDF document generation, and Chromium live browser inspection in one Electron workspace.',
        '',
        '## Verified Gates',
        '- Context Engine 2.0 adaptive working memory & 0o600 spills',
        '- 182 Built-In Agent Tools + 263 Built-In REA MCP Tools (445 total)',
        '- 6/6 Electron Fuses + SHA-256 Brand Seal integrity verified',
      ].join('\n'),
    },
    { cwd: wsDir }
  );

  execFileSync('git', ['init', '-b', 'main'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.email', 'release@akronlogic.com'], { cwd: wsDir });
  execFileSync('git', ['config', 'user.name', 'Akron Release'], { cwd: wsDir });
  execFileSync('git', ['add', '.'], { cwd: wsDir });
  execFileSync('git', ['commit', '-m', 'init showcase workspace'], { cwd: wsDir });
  // One modified file and one untracked file for realistic Explorer / Git badges
  fs.appendFileSync(path.join(wsDir, 'src', 'app.js'), '// ready\n', 'utf8');
  fs.writeFileSync(path.join(wsDir, 'test', 'smoke.test.js'), 'console.log("ok");\n', 'utf8');

  // Seed temp plugins file with curated installed items (isolated from user's ~/.autobot)
  const pluginsFile = path.join(root, 'plugins.json');
  fs.writeFileSync(
    pluginsFile,
    JSON.stringify({ installed: { rea: true, github: true, gdocs: true, figma: true }, config: {} }, null, 2),
    'utf8'
  );
  process.env.AUTOBOT_PLUGINS_FILE = pluginsFile;

  return { root, wsDir };
}

function startShowcasePreviewServer() {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>AkronLogic Studio Preview</title>
<style>
  * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body {
    margin: 0; min-height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center;
    background: radial-gradient(circle at 20% 20%, rgba(16,185,129,.22), transparent 55%), #0c110e;
    color: #ecfdf5; padding: 32px;
  }
  .card {
    width: 100%; max-width: 440px; border-radius: 16px; padding: 28px;
    background: rgba(18, 25, 21, 0.94); border: 1px solid rgba(16, 185, 129, 0.35);
    box-shadow: 0 24px 54px rgba(0, 0, 0, 0.5);
  }
  .pill { display: inline-block; font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #34d399;
    background: rgba(16,185,129,.14); border: 1px solid rgba(16,185,129,.35); padding: 4px 10px; border-radius: 999px; }
  h1 { margin: 14px 0 8px; font-size: 22px; }
  p { margin: 0 0 20px; font-size: 13.5px; color: #9ca3af; line-height: 1.55; }
  .cta-emerald {
    display: inline-flex; align-items: center; gap: 8px; background: #10b981; color: #052e16;
    border: 0; border-radius: 9px; padding: 10px 18px; font-size: 13.5px; font-weight: 700; cursor: pointer;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.35);
  }
  .metrics { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-top: 20px; }
  .m { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 10px; padding: 10px; text-align: center; }
  .m b { display: block; font-size: 15px; color: #6ee7b7; }
  .m span { font-size: 11px; color: #9ca3af; }
</style>
</head>
<body>
  <div class="card">
    <span class="pill">AKRON INSPECT TARGET · LIVE DOM</span>
    <h1>Emerald Checkout Card</h1>
    <p>Inspect mode captures computed box geometry, CSS tokens, DOM selector paths, and visual PNG snapshots in one click.</p>
    <button class="cta-emerald" type="button">Deploy Production Release</button>
    <div class="metrics">
      <div class="m"><b>445</b><span>Tools</span></div>
      <div class="m"><b>6 / 6</b><span>Fuses</span></div>
      <div class="m"><b>70/70</b><span>Evals</span></div>
    </div>
  </div>
</body>
</html>`;
  const srv = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/`,
    close: () => srv.close(),
  })));
}

function registerIpcMocks(wsDir, webviewMockUrl) {
  const ideIpc = require(path.join(REPO, 'electron/ide/ipc'));
  const git = require(path.join(REPO, 'electron/git'));
  const plugins = require(path.join(REPO, 'electron/plugins'));
  const mindmap = require(path.join(REPO, 'electron/mindmap'));
  const docStudio = require(path.join(REPO, 'electron/doc-studio'));

  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };

  ideIpc.register({
    ipcMain,
    normalizeProvider: (p) => p,
    hydrateProvider: (p) => p,
    hydrateOrchestrator: (o) => o,
    store: { get: () => null, set: () => {} },
    broadcast: () => {},
  });

  safe('autobot:getVersion', () => ({
    version: '1.4.0', app: '1.4.0',
    electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node,
    platform: process.platform, arch: process.arch,
  }));

  const mockSettings = {
    theme: 'dark', locale: 'en', surfaceFinish: 'emerald-carbon',
    accentColor: '#10b981', bgPattern: 'carbon-weave', uiDensity: 'comfortable',
    chatWidth: 'standard', messageStyle: 'editorial', borderRadius: 'balanced',
    showTimestamps: true, timestampFormat: 'date-time', actionBarStyle: 'compact',
    showModelBadge: true, showAvatars: true, showFloatingToolbar: false,
    provider: { model: 'claude-sonnet-4-6', baseURL: 'https://api.anthropic.com/v1' },
  };
  safe('autobot:getSettings', () => mockSettings);
  safe('autobot:setSettings', (_e, patch) => Object.assign(mockSettings, patch || {}));
  safe('autobot:getFeatures', () => ({ computerUse: true, chrome: true, chromePort: 9222, preventSleep: true }));
  safe('autobot:getMemory', () => ({
    entries: [
      { id: 'm1', category: 'architecture', text: 'SQLite WAL + FTS5 session store verified under ~/.autobot/akron.db', ts: Date.now() - 3600000 },
      { id: 'm2', category: 'workflow', text: 'Run npm run build && npm run brand:check before desktop packaging', ts: Date.now() - 1800000 },
    ],
  }));
  safe('autobot:getSkills', () => [
    { name: 'release-gate', description: 'Verify typecheck, brand seal, 136 test suites & 3-OS installers', source: 'custom', enabled: true, body: '# Release Gate\nVerify typecheck, unit tests, evals, and Brand Seal.' },
    { name: 'reverse-engineer-anything', description: 'REA 263-tool native/Electron/APK binary inspection', source: 'builtin', enabled: true, body: '# REA Playbook\nInspect shipped artifacts cleanly.' },
  ]);
  safe('autobot:getOrchestrator', () => ({
    enabled: true,
    providers: [
      { id: 'p1', label: 'Anthropic OAuth', baseURL: 'https://api.anthropic.com/v1', model: 'claude-opus-4-6', enabled: true, oauthProvider: 'claude' },
      { id: 'p2', label: 'OpenAI Codex', baseURL: 'https://chatgpt.com/backend-api/codex', model: 'gpt-5.4', enabled: true, oauthProvider: 'openai' },
      { id: 'p3', label: 'Google Antigravity', baseURL: 'https://daily-cloudcode-pa.sandbox.googleapis.com', model: 'gemini-3.5-pro', enabled: true, oauthProvider: 'gemini' },
    ],
  }));
  safe('autobot:poolsPreset', () => ({
    enabled: true,
    roles: {
      planner: { model: 'claude-opus-4-6', pool: 'anthropic' },
      coder: { model: 'claude-sonnet-4-6', pool: 'anthropic' },
      vision: { model: 'gemini-3.5-pro', pool: 'antigravity' },
      image_gen: { model: 'imagen-4', pool: 'google' },
      video_gen: { model: 'veo-3', pool: 'google' },
    },
  }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({
    ok: true,
    status: {
      providers: [
        {
          id: 'claude', label: 'Claude Max', transport: 'anthropic', canBrowserSignIn: false, canManualCode: true,
          models: [{ id: 'claude-opus-4-6', name: 'Claude Opus 4.6' }, { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' }],
          accounts: [
            { id: 'claude:team', account: 'team@akronlogic.com', label: 'team@akronlogic.com', planName: 'Max 20x', source: 'claude-code' },
          ],
          limits: { fiveHourPct: 24, fiveHourLabel: '24% used · resets 3h 40m', weeklyPct: 18, weeklyLabel: '18% used · resets Thu' },
        },
        {
          id: 'openai', label: 'ChatGPT Plus / Codex', transport: 'codex', canBrowserSignIn: true, canManualCode: true,
          models: [{ id: 'gpt-5.4', name: 'GPT-5.4' }, { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' }],
          accounts: [
            { id: 'openai:eng', account: 'eng@akronlogic.com', label: 'eng@akronlogic.com', planName: 'Plus', source: 'codex-cli' },
          ],
          limits: { fiveHourPct: 36, fiveHourLabel: '36% used · resets 4h 12m', weeklyPct: 29, weeklyLabel: '29% used · resets Sun' },
        },
        {
          id: 'gemini', label: 'Google Antigravity', transport: 'antigravity', canBrowserSignIn: true, canManualCode: true,
          models: [{ id: 'gemini-3.5-pro', name: 'Gemini 3.5 Pro' }, { id: 'imagen-4', name: 'Imagen 4' }],
          accounts: [
            { id: 'gemini:studio', account: 'studio@akronlogic.com', label: 'studio@akronlogic.com', planName: 'Pro', source: 'antigravity-app' },
          ],
          limits: { fiveHourPct: 12, fiveHourLabel: '12% used · resets 4h 50m', weeklyPct: 9, weeklyLabel: '9% used · resets Mon' },
        },
      ],
    },
  }));
  safe('autobot:freellmStatus', () => ({ running: true, url: 'http://127.0.0.1:31415/v1', providers: [] }));
  safe('autobot:freellmProviders', () => []);
  safe('autobot:freellmCatalog', (_e, opts) => {
    const cat = require(path.join(REPO, 'electron/freellmapi-catalog'));
    return {
      ...cat.getCatalogSummary(),
      chatModels: cat.listChatModels({ limit: (opts && opts.limit) || 120 }),
      mediaModels: cat.listMediaModels({}),
      embeddingModels: cat.listEmbeddingModels({}),
      webBotProviders: cat.getWebBotQuickProviders(),
    };
  });
  safe('autobot:freellmDetect', () => ({
    ok: true,
    platform: process.platform,
    desktopInstalled: true,
    recommendedEndpoint: 'http://127.0.0.1:31415/v1',
    unifiedKey: 'flm_akron_demo_unified_key',
    status: { running: true, url: 'http://127.0.0.1:31415/v1' },
  }));
  safe('autobot:autoRouterGet', () => ({
    ok: true,
    source: 'openrouter_free',
    defaultForNewSessions: true,
    hasKey: true,
    keyHint: '••••free',
    model: 'deepseek/deepseek-v4.1-flash:free',
    baseURL: 'https://openrouter.ai/api/v1',
    sources: {
      openrouter_free: { hasKey: true, keyHint: '••••free', model: 'deepseek/deepseek-v4.1-flash:free', baseURL: 'https://openrouter.ai/api/v1' },
      deepseek_api: { hasKey: true, keyHint: '••••ds41', model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com/v1' },
      freellmapi: { hasKey: true, customKeySet: true, keyHint: '••••flm1', model: 'deepseek-v4-flash', baseURL: 'http://127.0.0.1:31415/v1' },
    },
    telemetry: { decisionsCount: 42, estimatedCostUsd: 0, lastLatencyMs: 112, lastSource: 'openrouter_free', lastModelUsed: 'deepseek/deepseek-v4.1-flash:free' },
  }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => [
    { id: 'st1', name: 'Nightly Regression Sweep', cron: '0 2 * * *', enabled: true, lastResult: '82/82 PASS', runCount: 14 },
  ]);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => [
    { id: 'rea', name: 'rea (Built-in Reverse Engineering)', status: 'connected', tools: 263, transport: 'stdio' },
    { id: 'github', name: 'github', status: 'connected', tools: 18, transport: 'http' },
  ]);
  safe('autobot:mcpConfig', () => ({ servers: [{ id: 'github', transport: 'http', url: 'https://api.githubcopilot.com/mcp' }], status: [] }));
  safe('autobot:reaStatus', () => ({ available: true, connected: true, toolCount: 263 }));
  safe('autobot:extBridgeStatus', () => ({ running: true, port: 8766, extensionConnected: true, extensionVersion: '1.6.7', connectedClients: 1, tabs: [] }));
  safe('autobot:serverInfo', () => ({ port: 8766, url: 'http://127.0.0.1:8766', wsUrl: 'ws://127.0.0.1:8766', platform: process.platform, arch: process.arch, pid: process.pid, extensionConnected: true, connectedClients: 1 }));
  safe('autobot:worktreeList', (_e, cwd) => git.listWorktrees(cwd || wsDir));
  safe('autobot:gitInfo', (_e, cwd) => git.gitInfo(cwd || wsDir));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => wsDir);
  safe('autobot:getWorkspace', () => wsDir);
  safe('autobot:setWorkspace', () => ({ ok: true }));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));
  safe('autobot:listSlashActions', () => []);
  safe('autobot:gdriveStatus', () => ({ connected: false, detectedLocalFolders: [] }));
  safe('autobot:oauthStatus', () => ({ providers: [{ id: 'claude', connected: true }, { id: 'openai', connected: true }, { id: 'gemini', connected: true }], total: 3 }));
  safe('autobot:checkpointsList', () => []);
  safe('autobot:checkpointsDiff', () => ({ ok: true, files: [] }));
  safe('autobot:ollamaModels', () => ({ ok: true, models: [{ name: 'qwen2.5-coder:32b' }, { name: 'gemma4:27b' }] }));
  safe('autobot:getMindmap', (_e, cwd, mode) => {
    const dir = cwd ? path.resolve(String(cwd)) : wsDir;
    const mmPath = path.join(dir, mindmap.FILENAME);
    return {
      ok: true,
      cwd: dir,
      path: mmPath,
      exists: fs.existsSync(mmPath),
      markdown: mindmap.buildWorkspaceMarkdown(dir, mode || 'auto'),
    };
  });
  safe('autobot:envGetState', () => ({ activeId: 'local', label: 'This Computer (Local)', status: 'connected' }));
  safe('autobot:dbMigrate', () => ({ ok: true, migrated: 0 }));
  safe('autobot:dbUpsertConv', () => ({ ok: true }));
  safe('autobot:allSessionsHealth', () => []);
  safe('autobot:notify', () => ({ ok: true }));
  safe('autobot:answerQuestion', () => ({ ok: true }));
  safe('autobot:turnDiffs', () => ({ ok: true, files: [] }));
  safe('autobot:gitDiffFiles', () => ({ ok: true, files: [] }));
  safe('autobot:devServerDetect', () => ({ servers: [] }));
  safe('autobot:browserSyncTabs', () => ({ ok: true }));
  safe('autobot:browserRegister', () => ({ ok: true }));
  safe('autobot:browserUnregister', () => ({ ok: true }));
  safe('autobot:getSandbox', () => ({ profile: 'workspace-write', allowNet: true }));
  safe('autobot:searchFiles', (_e, p) => ({ ok: true, files: ['src/app.js', 'src/theme.css', 'MINDMAP.md', 'README.md', 'reports/model-matrix.xlsx', 'reports/q4-roadmap.pdf'].filter((f) => !p || !p.query || f.includes(p.query)) }));
  safe('autobot:searchAll', () => ({ ok: true, matches: [] }));
  safe('autobot:envList', () => ({
    activeId: 'local',
    environments: [
      { id: 'local', kind: 'local', label: 'This Computer (Local)', status: 'connected', cwd: '~/workspace/akron-code' },
      { id: 'ssh-prod', kind: 'ssh', label: 'build-linux-x64.akronlogic.internal', host: 'build-linux-x64.akronlogic.internal', user: 'ci', port: 22, status: 'ready' },
      { id: 'ws-win', kind: 'remote', label: 'win11-arm64-runner (:8770)', url: 'ws://10.0.1.42:8770', status: 'ready' },
    ],
  }));
  safe('autobot:depsStatus', () => ({
    ok: true,
    coreHealthy: 7,
    coreTotal: 7,
    deps: [
      { id: 'monaco', name: 'Monaco Editor + Diff Engine', version: '0.52.2', ok: true, bundled: true },
      { id: 'xterm', name: 'xterm.js + node-pty PTY', version: '5.5.0', ok: true, bundled: true },
      { id: 'ripgrep', name: '@vscode/ripgrep', version: '1.15.9', ok: true, bundled: true },
      { id: 'watcher', name: '@parcel/watcher', version: '2.5.1', ok: true, bundled: true },
      { id: 'markmap', name: 'Markmap Offline Bundle', version: '0.18.0', ok: true, bundled: true },
      { id: 'docstudio', name: 'PDF / DOCX / XLSX / PPTX / ZIP', version: 'v1.2 Bundled', ok: true, bundled: true },
      { id: 'ffmpeg', name: '@ffmpeg-installer/ffmpeg', version: '4.1.0', ok: true, bundled: true },
    ],
    lsps: [
      { id: 'typescript', name: 'TypeScript Language Server', installed: true },
      { id: 'pyright', name: 'Pyright Python LSP', installed: true },
    ],
  }));
  safe('autobot:runtimes', () => ({
    autoUpdate: true,
    items: [
      { id: 'claude', name: 'Claude Code CLI', version: '2.1.19', latest: '2.1.19', status: 'up-to-date' },
      { id: 'codex', name: 'OpenAI Codex CLI', version: '0.32.0', latest: '0.32.0', status: 'up-to-date' },
      { id: 'gemini', name: 'Gemini CLI', version: '0.18.4', latest: '0.18.4', status: 'up-to-date' },
    ],
  }));
  safe('autobot:updateCheck', () => ({ ok: true, currentVersion: '1.4.0', latestVersion: '1.4.0', upToDate: true, channel: 'stable' }));
  safe('autobot:notificationsGet', () => ({
    enabled: true, notifyWhenFocused: false, categories: { agent: true, permissions: true, questions: true, errors: true },
  }));
  safe('autobot:listPlugins', (_e, opts) => plugins.listPlugins(opts || {}));
  safe('autobot:pluginCategories', () => plugins.categories());
  safe('autobot:pluginStats', () => ({ total: 961, installed: 4, enabled: 4 }));
  safe('autobot:registryStatus', () => ({ synced: true, count: 444 }));
  safe('autobot:listAgentDefs', () => [
    { name: 'security-auditor', role: 'Security Auditor', description: 'Audits diffs, IPC boundaries, secrets hygiene & ASAR exposure.', model: 'planner', tools: ['Read', 'Glob', 'Grep', 'CodebaseSearch'], source: 'user', path: '~/.autobot/agents/security-auditor.md' },
    { name: 'ui-ux-designer', role: 'UI/UX Designer', description: 'Designs dark/light Emerald Carbon interfaces and visual hierarchy.', model: 'coder', tools: ['Read', 'Edit', 'Browser', 'GenerateImage'], source: 'user', path: '~/.autobot/agents/ui-ux-designer.md' },
    { name: 'media-director', role: 'Media & Docs Producer', description: 'Produces brand visuals, reels, XLSX models, PPTX decks & PDFs.', model: 'image_gen', tools: ['GenerateImage', 'GenerateVideo', 'GenerateDocument'], source: 'project', path: '.claude/agents/media-director.md' },
  ]);
  safe('autobot:listOutputStyles', () => ({
    defaultStyleId: 'emerald-executive',
    styles: [
      { id: 'emerald-executive', name: 'Emerald Executive', description: 'Concise engineering summary with verified metrics, clickable file links & clean diff tables.', source: 'preset', body: 'Lead with verified outcomes and crisp tables.' },
      { id: 'principal-architect', name: 'Principal Architect', description: 'Tradeoff matrices, security boundaries, and failure-mode analysis.', source: 'custom', path: '~/.autobot/output-styles/principal-architect.md', body: 'Document invariants and cross-vendor contracts.' },
    ],
  }));
  safe('autobot:studioInspect', async (_e, payload) => {
    const raw = String((payload && payload.path) || '').trim();
    const absPath = path.isAbsolute(raw) ? raw : path.resolve(wsDir, raw);
    if (!fs.existsSync(absPath)) return { ok: false, error: `Not found: ${absPath}` };
    const stat = fs.statSync(absPath);
    const ext = path.extname(absPath).toLowerCase().slice(1);
    if (ext === 'png') {
      return {
        ok: true, kind: 'image', path: raw, name: path.basename(absPath), size: stat.size, ext,
        width: 1024, height: 1024,
        dataUrl: `data:image/png;base64,${fs.readFileSync(absPath).toString('base64')}`,
      };
    }
    const doc = await docStudio.readDocument(absPath, { cwd: wsDir });
    return { ok: true, kind: 'document', path: raw, name: path.basename(absPath), size: stat.size, ext, ...doc };
  });
  safe('autobot:browserRulesCheck', () => ({ allowed: true, mode: 'ask-on-mutate' }));
  safe('autobot:browserGetURL', () => webviewMockUrl);
  safe('autobot:browserGetTitle', () => 'AkronLogic Studio Preview');
  safe('autobot:browserScreenshot', () => ({
    ok: true,
    path: path.join(wsDir, 'assets', 'akron-emblem.png'),
    dataUrl: `data:image/png;base64,${fs.readFileSync(path.join(wsDir, 'assets', 'akron-emblem.png')).toString('base64')}`,
    width: 1280,
    height: 800,
  }));
  safe('autobot:browserCaptureElement', () => ({
    ok: true,
    dataUrl: `data:image/png;base64,${fs.readFileSync(path.join(wsDir, 'assets', 'akron-emblem.png')).toString('base64')}`,
    width: 480,
    height: 320,
  }));
  safe('autobot:diagnosticsSummary', () => ({ appVersion: '1.4.0', crashFreeRate: '99.94%', dbSizeKb: 412, toolCount: 445 }));
}

async function run() {
  const { root, wsDir } = await buildTempWorkspace();
  const previewSrv = await startShowcasePreviewServer();
  registerIpcMocks(wsDir, previewSrv.url);

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    show: false,
    backgroundColor: '#0c110e',
    webPreferences: {
      preload: path.join(REPO, 'electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
    },
  });

  const now = Date.now();
  const seedConvs = [
    {
      id: 'conv_v120_agent',
      title: 'Long-Horizon Engine & Release Gate',
      project: 'akron-code',
      ts: now - 180000,
      swarmInfo: { phase: 'reviewing', supervisor: 'claude-opus-5-5', board: [{ id: 1 }, { id: 2 }] },
      subAgents: [
        { id: 'sup1', name: 'Supervisor · @supervisor', role: 'supervisor', jobRole: 'planner', model: 'claude-opus-5-5', status: 'running' },
        { id: 'w1', name: 'Build backend server & APIs', role: 'worker', jobRole: 'coder', model: 'claude-sonnet-5-5', status: 'done' },
        { id: 'w2', name: 'Build admin panel & smoke tests', role: 'worker', jobRole: 'coder', model: 'gpt-5.4', status: 'done' },
      ],
      messages: [
        {
          id: 'u_a1', role: 'user', ts: now - 165000,
          content: 'Audit `src/app.js` and `electron/context-pipeline.js`, run the verification suite, and summarize shipped capabilities.',
        },
        {
          id: 'a_a1', role: 'assistant', model: 'claude-opus-5-5', durationMs: 12400, ts: now - 150000,
          autoRouted: { via: 'deepseek-v4-flash', source: 'openrouter_free', role: 'planner', complexity: 5, tier: 5, reason: 'Architecture & security release audit' },
          tools: [
            { id: 't1', name: 'Read', args: { path: 'src/app.js' }, status: 'done', result: 'Read 5 lines from src/app.js' },
            { id: 't2', name: 'ShadowCheck', args: { path: 'src/app.js' }, status: 'done', result: '0 syntax or LSP diagnostics' },
            { id: 't3', name: 'Bash', args: { command: 'npm run typecheck && npm run brand:check' }, status: 'done', result: 'TYPECHECK_OK · BRAND_SEAL_OK (12/12)' },
          ],
          content: [
            '### Release Gate Summary (`v1.4.0`)',
            '',
            '- **Long-Horizon Complex Project Engine:** Smart `Auto` routing floor, adaptive 28-step working memory + structured compaction digests, autonomous `TodoWrite` continuation gate, and Swarm failed-worker backup retries.',
            '- **3-OS Computer Use 2.0 & Built-In Browser Screenshot:** 24 `mcp__computer__*` tools across macOS/Win11/Linux plus 1-click Camera Screenshot & Region Crop in `.browser-toolbar`.',
            '- **Security & Brand Seal:** `6 / 6` Electron Fuses verified (`136/136` tests, `70/70` evals) and zero `.map` files in `dist/`.',
          ].join('\n'),
        },
      ],
    },
    {
      id: 'conv_v120_studio',
      title: 'Universal Media & Document Studio',
      project: 'akron-code',
      ts: now - 120000,
      messages: [
        {
          id: 'u_s1', role: 'user', ts: now - 110000,
          content: 'Generate the brand emblem PNG, export the role-pool benchmark spreadsheet to `reports/model-matrix.xlsx`, and build `reports/q4-roadmap.pdf`.',
        },
        {
          id: 'a_s1', role: 'assistant', model: 'imagen-4 → claude-sonnet-4-6', modelsUsed: ['imagen-4', 'claude-sonnet-4-6'], durationMs: 8200, ts: now - 98000,
          tools: [
            { id: 'st_img', name: 'GenerateImage', args: { output_path: 'assets/akron-emblem.png', prompt: 'Emerald sunburst Akron Code desktop icon' }, status: 'done', result: JSON.stringify({ ok: true, path: 'assets/akron-emblem.png' }) },
            { id: 'st_xlsx', name: 'GenerateDocument', args: { output_path: 'reports/model-matrix.xlsx', format: 'xlsx' }, status: 'done', result: JSON.stringify({ ok: true, path: 'reports/model-matrix.xlsx', sheets: ['Role Pools', 'Release Benchmarks'] }) },
            { id: 'st_pdf', name: 'GenerateDocument', args: { output_path: 'reports/q4-roadmap.pdf', format: 'pdf' }, status: 'done', result: JSON.stringify({ ok: true, path: 'reports/q4-roadmap.pdf', pages: 1 }) },
          ],
          content: 'Generated all three deliverables in the workspace with inline interactive previews below:',
        },
      ],
    },
    {
      id: 'conv_v120_browser',
      title: 'Inspect Checkout Card in Live Browser',
      project: 'akron-code',
      ts: now - 60000,
      messages: [
        {
          id: 'u_b1', role: 'user', ts: now - 50000,
          content: 'Inspect the primary emerald CTA button in `AkronLogic Studio Preview` and verify layout contrast and computed styles.',
        },
        {
          id: 'a_b1', role: 'assistant', model: 'gemini-3.5-pro', durationMs: 4100, ts: now - 42000,
          tools: [
            { id: 'bt1', name: 'Browser', args: { action: 'inspect', selector: 'button.cta-emerald' }, status: 'done', result: 'Captured element box (206×37px) · contrast ratio 8.4:1 (AAA)' },
          ],
          content: [
            'Inspected element `button.cta-emerald` (`"Deploy Production Release"`):',
            '- **Dimensions:** `206 × 37 px` inside `.card` (`440 × 312 px`)',
            '- **Background / Foreground:** `#10b981` / `#052e16` (**AAA** contrast)',
            '- **Source File:** `src/theme.css` (`--accent: #10b981`)',
          ].join('\n'),
        },
      ],
    },
  ];

  const baseSettings = {
    theme: 'dark',
    surfaceFinish: 'emerald-carbon',
    accentColor: '#10b981',
    bgPattern: 'carbon-weave',
    uiDensity: 'comfortable',
    chatWidth: 'standard',
    messageStyle: 'editorial',
    borderRadius: 'balanced',
    showTimestamps: true,
    timestampFormat: 'date-time',
    actionBarStyle: 'compact',
    showModelBadge: true,
    showAvatars: true,
    showFloatingToolbar: false,
    locale: 'en',
  };

  await win.loadFile(path.join(REPO, 'dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:openTabs', ${JSON.stringify(JSON.stringify(['conv_v120_agent', 'conv_v120_studio', 'conv_v120_browser']))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('conv_v120_agent'))});
    localStorage.setItem('autobot:settings', ${JSON.stringify(JSON.stringify(baseSettings))});
    localStorage.setItem('autobot:provider', ${JSON.stringify(JSON.stringify({ model: 'claude-opus-5-5', routingMode: 'auto', baseURL: 'http://127.0.0.1:31415/v1' }))});
    localStorage.setItem('autobot:lastUsage', ${JSON.stringify(JSON.stringify({ model: 'claude-opus-5-5', prompt_tokens: 1800, completion_tokens: 420 }))});
    localStorage.setItem('autobot:projects', ${JSON.stringify(JSON.stringify([{ name: 'akron-code', path: wsDir }]))});
    location.reload();
  `);
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  await new Promise((r) => setTimeout(r, 1100));

  const dismissOverlays = async () => {
    await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('.notif-toast-x, .errorbar-x').forEach((b) => { try { b.click(); } catch (_) {} });
      document.querySelectorAll('.notif-toast, .notif-toast-stack, .errorbar').forEach((el) => { el.style.display = 'none'; });
    })()`);
    await new Promise((r) => setTimeout(r, 250));
  };

  const snap = async (fileName) => {
    await dismissOverlays();
    const img = await win.webContents.capturePage();
    const out = path.join(OUT_DIR, fileName);
    fs.writeFileSync(out, img.toPNG());
    console.log('CAPTURED', fileName, img.getSize());
  };

  const setTheme = async (theme) => {
    await win.webContents.executeJavaScript(`(() => {
      const s = JSON.parse(localStorage.getItem('autobot:settings') || '{}');
      s.theme = ${JSON.stringify(theme)};
      localStorage.setItem('autobot:settings', JSON.stringify(s));
      const app = document.querySelector('.app');
      if (app) app.setAttribute('data-theme', ${JSON.stringify(theme)});
      document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)});
      if (window.__akronTestHarness && window.__akronTestHarness.closeSettings) window.__akronTestHarness.closeSettings();
    })()`);
    await new Promise((r) => setTimeout(r, 300));
  };

  const setActiveConv = async (id) => {
    await win.webContents.executeJavaScript(`(() => {
      const el = [...document.querySelectorAll('.ws-tab')].find((t) => (t.textContent || '').includes(${JSON.stringify(id === 'conv_v120_studio' ? 'Universal Media' : id === 'conv_v120_browser' ? 'Inspect Checkout' : 'Long-Horizon Engine')}));
      if (el) el.click();
    })()`);
    await new Promise((r) => setTimeout(r, 450));
  };

  // 1 & 2: Agent Dark & Light + 3-Mode Model Picker Popup + Sidebar Context Menu Icons
  await setTheme('dark');
  await setActiveConv('conv_v120_agent');
  await snap('agent-dark.png');
  await win.webContents.executeJavaScript(`(() => {
    const trig = document.querySelector('.conv-menu-trigger');
    if (trig) trig.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await snap('sidebar-context-menu-dark.png');
  await win.webContents.executeJavaScript(`(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  await win.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('[data-testid="model-picker-pill"]');
    if (pill) pill.click();
  })()`);
  await new Promise((r) => setTimeout(r, 350));
  await win.webContents.executeJavaScript(`(() => {
    const toggle = document.querySelector('.orch-picker-toggle');
    if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await snap('model-picker-3modes.png');
  await win.webContents.executeJavaScript(`(() => {
    const pill = document.querySelector('[data-testid="model-picker-pill"]');
    if (pill) pill.click();
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  await setTheme('light');
  await snap('agent-light.png');
  await setTheme('dark');

  // 2B: Editable Message Queue Tray Dark
  await win.webContents.executeJavaScript(`
    window.__akronTestHarness && window.__akronTestHarness.setQueue && window.__akronTestHarness.setQueue([
      { id: 'q1', convId: 'conv_v120_agent', text: 'Run npm run build && ./verify-release.sh and verify 6/6 Electron Fuses' },
      { id: 'q2', convId: 'conv_v120_agent', text: 'Capture built-in Browser screenshot and inspect responsive layout' }
    ]);
  `);
  await new Promise((r) => setTimeout(r, 300));
  await snap('message-queue-dark.png');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setQueue && window.__akronTestHarness.setQueue([]);`);

  // 3 & 4: Emerald Dark & Light Sidebar + Mission Control
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPanel('mission');`);
  await new Promise((r) => setTimeout(r, 450));
  await snap('emerald-dark-sidebar-mission.png');
  await setTheme('light');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPanel('mission');`);
  await new Promise((r) => setTimeout(r, 450));
  await snap('emerald-light-sidebar-mission.png');
  await setTheme('dark');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPanel('chats');`);
  await new Promise((r) => setTimeout(r, 350));

  // 5: Inline PermissionDock Dark
  await win.webContents.executeJavaScript(`
    window.__akronTestHarness && window.__akronTestHarness.setPermissionQueue([
      { id: 'perm_demo_1', tool: 'Edit', summary: 'Update electron/orch-router.js (auto capability routing for image_gen / video_gen)' },
      { id: 'perm_demo_2', tool: 'Bash', summary: 'npm run brand:check && node test/appearance-timestamps.test.js' }
    ]);
  `);
  await new Promise((r) => setTimeout(r, 350));
  await snap('permission-dock-dark.png');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPermissionQueue([]);`);

  // 6: Non-blocking QuestionDock Dark
  win.webContents.send('autobot:event', {
    type: 'question',
    id: 'q_v120_1',
    questions: [
      {
        id: 'arch',
        header: 'Architecture',
        question: 'Which persistence engine should Akron Code use for local FTS5 session search?',
        options: [
          { label: 'SQLite WAL + FTS5 (Recommended)', description: 'Zero-config embedded WASM SQLite under ~/.autobot/akron.db' },
          { label: 'PostgreSQL + pgvector', description: 'Shared remote database cluster over SSL' },
          { label: 'JSONL Flat Files', description: 'Append-only local transcripts without index' },
        ],
      },
    ],
  });
  await new Promise((r) => setTimeout(r, 350));
  await snap('question-dock-dark.png');
  await win.webContents.executeJavaScript(`
    const skipBtn = [...document.querySelectorAll('button')].find((b) => /Skip|Dismiss/i.test(b.textContent || ''));
    if (skipBtn) skipBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 250));

  // 7: Universal Media & Document Studio cards
  await setActiveConv('conv_v120_studio');
  await new Promise((r) => setTimeout(r, 850));
  await win.webContents.executeJavaScript(`(() => {
    const sc = document.querySelector('.chat');
    if (sc) sc.scrollTop = sc.scrollHeight;
  })()`);
  await new Promise((r) => setTimeout(r, 250));
  await snap('media-doc-studio-dark.png');

  // 8: Customizations Hub (Marketplace + Installed)
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPanel('customizations');`);
  await new Promise((r) => setTimeout(r, 600));
  await snap('customizations-marketplace-dark.png');
  await win.webContents.executeJavaScript(`
    const inst = [...document.querySelectorAll('.cust-seg button, .cust-tabs button, button')].find((b) => b.textContent.trim() === 'Installed');
    if (inst) inst.click();
  `);
  await new Promise((r) => setTimeout(r, 450));
  await snap('customizations-installed-dark.png');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.setPanel('chats');`);
  await setActiveConv('conv_v120_agent');

  // 9: Duet Adversarial Review (Dark & Light)
  await win.webContents.executeJavaScript(`
    window.__akronTestHarness && window.__akronTestHarness.openDuetReview({
      reviewer: 'Claude Opus 5.5 × GPT-5.4 Adversarial Review',
      score: 96,
      summary: 'No security or data-loss issues found across 4 changed files. Cross-OS OAuth single-flight lock verified.',
      findings: [
        { severity: 'info', file: 'src/App.jsx', line: 3290, title: 'Compact 11px action bar + responsive wrapped model badge verified', detail: 'Both user inputs and assistant outputs render formatted timestamps cleanly even with narrow panes.' },
        { severity: 'low', file: 'electron/doc-studio.js', line: 1004, title: 'Zip-Slip path guard confirmed', detail: 'assertSafeArchiveEntryPath blocks archive traversal.' }
      ]
    });
  `);
  await new Promise((r) => setTimeout(r, 450));
  await snap('duet-review-dark.png');
  await setTheme('light');
  await new Promise((r) => setTimeout(r, 350));
  await snap('duet-review-light.png');
  await setTheme('dark');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.closePane();`);
  await new Promise((r) => setTimeout(r, 300));

  // 10: Browser Inspect Showcase + v1.4.0 Built-in Browser 1-Click Screenshot & Narrow Model Badge
  await setActiveConv('conv_v120_browser');
  await win.webContents.executeJavaScript(`
    const brBtn = [...document.querySelectorAll('button')].find((b) => /Browser|Preview/i.test(b.getAttribute('title') || b.textContent || '') && !/Settings/i.test(b.getAttribute('title') || ''));
    if (brBtn) brBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 600));
  await win.webContents.executeJavaScript(`(() => {
    const wv = document.querySelector('webview');
    if (wv && typeof wv.loadURL === 'function') wv.loadURL(${JSON.stringify(previewSrv.url)});
    const urlInp = document.querySelector('.browser-url input, input.browser-url');
    if (urlInp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(urlInp, ${JSON.stringify(previewSrv.url)});
      urlInp.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await new Promise((r) => setTimeout(r, 950));
  await snap('browser-inspect.png');
  await win.webContents.executeJavaScript(`(() => {
    const sb = document.querySelector('[data-testid="browser-screenshot-btn"]');
    if (sb) sb.click();
  })()`);
  await new Promise((r) => setTimeout(r, 450));
  await snap('browser-screenshot-narrow-chat.png');
  await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.closePane();`);
  await new Promise((r) => setTimeout(r, 250));
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('.composer-att button, .att-remove, .attachment-chip button').forEach((b) => b.click());
  })()`);

  // 11 & 12: IDE Workbench + Swarm Agent Dock + Offline Interactive Mind Map (Dark & Light)
  await setActiveConv('conv_v120_agent');
  await win.webContents.executeJavaScript(`
    const ideBtn = [...document.querySelectorAll('.ws-mode-btn')].find((b) => /IDE/i.test(b.textContent || ''));
    if (ideBtn) ideBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 850));
  await win.webContents.executeJavaScript(`(() => {
    const sc = document.querySelector('.ide-dock-body .chat');
    if (sc) sc.scrollTop = sc.scrollHeight;
  })()`);
  await new Promise((r) => setTimeout(r, 300));
  await snap('ide-agent-dock-swarm.png');
  await win.webContents.executeJavaScript(`
    const mmBtn = document.querySelector('[data-testid="ide-mindmap-btn"]');
    if (mmBtn) mmBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 1100));
  await snap('ide-mindmap-dark.png');
  await setTheme('light');
  await new Promise((r) => setTimeout(r, 500));
  await snap('ide-mindmap-light.png');
  await setTheme('dark');
  await win.webContents.executeJavaScript(`
    const agBtn = [...document.querySelectorAll('.ws-mode-btn')].find((b) => /Agent/i.test(b.textContent || ''));
    if (agBtn) agBtn.click();
  `);
  await new Promise((r) => setTimeout(r, 400));

  // 13..22: Settings Showcase (Auto-Switch Brain, UI & Design Studio, FreeLLMAPI Hub & Web Bot, Models & Limit Rings Dark/Light, Notifications, Environments, Runtimes, Project, Browser, Migration, Feedback)
  const settingsShots = [
    ['system', 'autoswitch-brain-dark.png', 'dark', 'autoswitch'],
    ['system', 'ui-design-studio-dark.png', 'dark', 'studio'],
    ['system', 'settings-application-updater-dark.png', 'dark', 'studio'],
    ['runtimes', 'freellmapi-hub-dark.png', 'dark', 'freellm'],
    ['runtimes', 'freellmapi-webbot-setup.png', 'dark', 'webbot'],
    ['providers', 'settings-models-limit-rings-dark.png', 'dark', 'rings'],
    ['providers', 'settings-models-limit-rings-light.png', 'light', 'rings'],
    ['notifications', 'notifications-settings.png', 'dark', 'top'],
    ['environments', 'environments.png', 'dark', 'top'],
    ['runtimes', 'runtimes-updates.png', 'dark', 'top'],
    ['project', 'settings-project-token-budget-dark.png', 'dark', 'top'],
    ['browser', 'settings-browser-rules-dark.png', 'dark', 'top'],
    ['migrate', 'settings-migration-wizard-dark.png', 'dark', 'top'],
    ['feedback', 'settings-feedback-diagnostics-dark.png', 'dark', 'top'],
  ];
  for (const [sec, fname, th, scrollTarget] of settingsShots) {
    await setTheme(th);
    await win.webContents.executeJavaScript(`window.__akronTestHarness && window.__akronTestHarness.openSettings(${JSON.stringify(sec)});`);
    await new Promise((r) => setTimeout(r, 450));
    await win.webContents.executeJavaScript(`(() => {
      const body = document.querySelector('.settings-body');
      if (!body) return;
      if (${JSON.stringify(scrollTarget)} === 'rings') {
        const rings = body.querySelector('[data-testid="models-limits-section"]');
        if (rings) rings.scrollIntoView({ block: 'center' });
      } else if (${JSON.stringify(scrollTarget)} === 'studio') {
        const st = body.querySelector('[data-testid="appearance-studio-section"]');
        if (st) st.scrollIntoView({ block: 'start' });
      } else if (${JSON.stringify(scrollTarget)} === 'freellm' || ${JSON.stringify(scrollTarget)} === 'webbot') {
        const fh = body.querySelector('[data-testid="freellmapi-catalog-hub"]');
        if (fh) fh.scrollIntoView({ block: 'start' });
        if (${JSON.stringify(scrollTarget)} === 'webbot') {
          const btn = body.querySelector('[data-testid="freellm-webbot-setup-btn"]');
          if (btn && !body.querySelector('[data-testid="freellm-webbot-drawer"]')) btn.click();
        }
      } else {
        body.scrollTop = 0;
      }
    })()`);
    await new Promise((r) => setTimeout(r, 250));
    await snap(fname);
  }

  console.log('SHOWCASE_V120_DONE');
  previewSrv.close();
  fs.rmSync(root, { recursive: true, force: true });
  win.destroy();
  app.exit(0);
}

app.whenReady().then(run).catch((err) => {
  console.error('SHOWCASE_V120_FAILED:', err);
  app.exit(1);
});
