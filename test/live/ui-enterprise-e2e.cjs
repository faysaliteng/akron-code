'use strict';
// Offscreen Electron UI & layout verification at 1240x840 for:
//   1. Live Antigravity Checklist Progress + FilesChangedBar + Mic Button in Composer
//   2. Side-Pane Code Review (Search bar, Diff lines, Inline Comment + Mic, Overview menu)
//   3. Enterprise Left-Menu Settings Modal (Providers & Browser Extension tabs)

const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');

process.on('uncaughtException', (e) => { console.error(e); app.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); app.exit(1); });

const outDir = path.resolve(process.argv[2] || '/tmp');
const distHtml = path.join(__dirname, '..', '..', 'dist', 'index.html');

// Stub minimal IPCs required by App.jsx
const handlers = {
  'autobot:getSettings': () => ({ theme: 'dark', useMemory: true, locale: 'en', provider: { baseURL: 'http://127.0.0.1:3001/v1', model: 'qwen3.8-flash', supportsTools: true, temperature: 0.3, maxTokens: 16000 }, voiceEngine: 'auto', voiceLang: 'en-US' }),
  'autobot:setSettings': (_e, s) => s,
  'autobot:getMemory': () => ({ entries: [] }),
  'autobot:getSkills': () => [],
  'autobot:getOrchestrator': () => ({ enabled: true, providers: [], pools: { enabled: true, gateway: { baseURL: 'http://127.0.0.1:3001/v1' }, roles: { planner: { label: 'Planner', models: [{ model: 'gpt-5.6-luna' }] }, coder: { label: 'Coder', models: [{ model: 'qwen3.8-flash' }, { model: 'qwen3.8-27b' }] }, vision: { label: 'Vision', models: [{ model: 'qwen3.8-flash' }] }, fast: { label: 'Fast', models: [{ model: 'qwen3.8-27b' }] }, longctx: { label: 'Long context', models: [{ model: 'gpt-5.6-luna' }] } } } }),
  'autobot:setOrchestrator': (_e, o) => o,
  'autobot:poolStatus': () => ({ active: true, roles: {}, rows: [{ key: 'k1', model: 'gpt-5.6-luna', coolingMs: 0, inflight: 0 }, { key: 'k2', model: 'qwen3.8-flash', coolingMs: 0, inflight: 1 }] }),
  'autobot:getFeatures': () => ({ computerUse: true, chrome: false, bridges: false, quickEntry: true, extensions: true }),
  'autobot:setFeatures': (_e, f) => f,
  'autobot:getWorkspace': () => '/Users/saimon/Akron Bot/sample-devpulse',
  'autobot:getDefaultCwd': () => '/Users/saimon/Akron Bot/sample-devpulse',
  'autobot:providerCatalog': () => ({ providers: [], storeError: null }),
  'autobot:ollamaModels': () => ({ ok: false, base: 'http://localhost:11434/v1', models: [], detail: 'Stopped' }),
  'autobot:listAgents': () => [],
  'autobot:listCheckpoints': () => [{ id: 'turn-1', at: new Date().toISOString(), files: [{ path: '/Users/saimon/Akron Bot/sample-devpulse/src/scanner.js', existed: true }, { path: '/Users/saimon/Akron Bot/sample-devpulse/src/graph.js', existed: false }] }],
  'autobot:turnDiffs': () => [
    {
      path: '/Users/saimon/Akron Bot/sample-devpulse/src/scanner.js',
      relPath: 'src/scanner.js',
      status: 'modified',
      added: 3,
      removed: 1,
      lines: [
        { type: 'ctx', oldLine: 10, newLine: 10, text: 'function scanDirectory(rootDir, opts = {}) {' },
        { type: 'del', oldLine: 11, newLine: null, text: '  const skip = new Set(["node_modules"]);' },
        { type: 'add', oldLine: null, newLine: 11, text: '  const skip = new Set(["node_modules", ".git", "dist", "release"]);' },
        { type: 'add', oldLine: null, newLine: 12, text: '  const stats = { files: 0, lines: 0 };' },
        { type: 'add', oldLine: null, newLine: 13, text: '  // Traverse tree and collect exports/imports + complexity' },
        { type: 'ctx', oldLine: 12, newLine: 14, text: '  return walk(rootDir, skip);' },
      ],
    },
    {
      path: '/Users/saimon/Akron Bot/sample-devpulse/src/graph.js',
      relPath: 'src/graph.js',
      status: 'added',
      added: 4,
      removed: 0,
      lines: [
        { type: 'add', oldLine: null, newLine: 1, text: 'function buildGraph(scanResult) {' },
        { type: 'add', oldLine: null, newLine: 2, text: '  const cycles = detectCycles(scanResult.files);' },
        { type: 'add', oldLine: null, newLine: 3, text: '  return { nodes: [], edges: [], cycles };' },
        { type: 'add', oldLine: null, newLine: 4, text: '}' },
      ],
    },
  ],
  'autobot:sessionLog': () => ({ turns: [] }),
  'autobot:customToolList': () => [{ name: 'repo_health', runtime: 'node', description: 'Check repository build and tests' }],
  'autobot:extBridgeStatus': () => ({
    running: true, port: 8766, bridgeUrl: 'ws://127.0.0.1:8766', proxyUrl: 'http://127.0.0.1:8766/v1',
    extensionConnected: true, connectedClients: 1, extensionVersion: '1.6.7',
    extensionDir: '/Users/saimon/akron-bot-standalone/resources/akron-browser-bot',
    tabs: [{ id: 12, title: 'Akron Logic Dashboard', url: 'https://akronlogic.com', active: true }],
  }),
  'autobot:runtimesList': () => [],
  'autobot:complianceGet': () => ({ profile: 'standard', state: {}, catalog: [] }),
  'autobot:listNotebooks': () => [],
  'autobot:mcpStatus': () => [],
  'autobot:scheduledList': () => [],
  'autobot:pluginsList': () => [],
};

for (const [ch, fn] of Object.entries(handlers)) {
  ipcMain.handle(ch, fn);
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240,
    height: 840,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'electron', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Seed one conversation with TodoWrite + Write + Edit + Checkpoint before load
  win.webContents.on("console-message", (_e, lvl, msg) => console.log("CONSOLE:", lvl, msg));
  await win.loadFile(distHtml);
  const seedConvs = [{
    id: 'conv-ui-1',
    title: 'DevPulse Analyzer Swarm Build',
    ts: Date.now(),
    messages: [
      { id: 'm1', role: 'user', content: 'Build devpulse analyzer with cycle detection and review UI.', ts: Date.now() - 20000 },
      {
        id: 'm2',
        role: 'assistant',
        content: 'Built **devpulse** modules (`src/scanner.js`, `src/graph.js`) and saved checkpoints for turn review.',
        checkpointId: 'turn-1',
        checkpoints: [
          { id: 'turn-1', path: '/Users/saimon/Akron Bot/sample-devpulse/src/scanner.js', existed: true },
          { id: 'turn-1', path: '/Users/saimon/Akron Bot/sample-devpulse/src/graph.js', existed: false },
        ],
        tools: [
          { id: 't1', name: 'TodoWrite', status: 'done', args: { todos: [
            { content: 'Scaffold package.json & src/scanner.js', status: 'completed' },
            { content: 'Implement cycle detection in src/graph.js', status: 'completed' },
            { content: 'Generate HTML+SVG reporter & CLI', status: 'in_progress' },
            { content: 'Run full node:test suite', status: 'pending' },
          ] } },
          { id: 't2', name: 'Edit', status: 'done', args: { file_path: 'src/scanner.js', old_string: 'const skip = new Set(["node_modules"]);', new_string: 'const skip = new Set(["node_modules", ".git", "dist", "release"]);\nconst stats = { files: 0, lines: 0 };\n// Traverse' } },
          { id: 't3', name: 'Write', status: 'done', args: { file_path: 'src/graph.js', content: 'function buildGraph(s) {\n  return { nodes: [], edges: [], cycles: [] };\n}\n' } },
        ],
        durationMs: 14200,
        ts: Date.now(),
      },
    ],
  }];
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify(seedConvs))});
    localStorage.setItem('autobot:activeId', JSON.stringify('conv-ui-1'));
  `);
  await win.reload();
  await new Promise((r) => setTimeout(r, 900));

  const checkOverflow = () => win.webContents.executeJavaScript(`({
    overflow: document.documentElement.scrollWidth > window.innerWidth,
    scrollW: document.documentElement.scrollWidth,
    innerW: window.innerWidth
  })`);

  // 1. Live checklist progress + FilesChangedBar + Composer Mic button
  const img1 = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(outDir, 'live-checklist-progress.png'), img1.toPNG());
  console.log("ROOT_LEN:", await win.webContents.executeJavaScript("document.getElementById('root')?.innerHTML?.length || 0"));
  console.log('live-checklist-progress:', JSON.stringify(await checkOverflow()));

  // 2. Open Review side pane + search + inline comment draft + Overview menu
  await win.webContents.executeJavaScript(`
    document.querySelector('.fcb-btn.primary')?.click();
  `);
  await new Promise((r) => setTimeout(r, 450));
  await win.webContents.executeJavaScript(`
    document.querySelector('.rv-head-right .icon-btn')?.click();
  `);
  await new Promise((r) => setTimeout(r, 200));
  await win.webContents.executeJavaScript(`
    const inp = document.querySelector('.rv-search-in');
    if (inp) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, 'cycles');
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }
    document.querySelector('.rv-add-c')?.click();
  `);
  await new Promise((r) => setTimeout(r, 300));
  const img2 = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(outDir, 'code-review-pane.png'), img2.toPNG());
  console.log('code-review-pane:', JSON.stringify(await checkOverflow()));

  // 3. Enterprise Left-Menu Settings modal (switch to Browser Extension tab)
  await win.webContents.executeJavaScript(`
    document.querySelector('.settings-icon')?.click();
  `);
  await new Promise((r) => setTimeout(r, 350));
  await win.webContents.executeJavaScript(`
    const btns = Array.from(document.querySelectorAll('.settings-nav-btn'));
    const br = btns.find((b) => b.textContent.includes('Browser Extension'));
    if (br) br.click();
  `);
  await new Promise((r) => setTimeout(r, 350));
  const img3 = await win.webContents.capturePage();
  require('fs').writeFileSync(path.join(outDir, 'settings-enterprise-leftmenu.png'), img3.toPNG());
  const ov3 = await checkOverflow();
  console.log('settings-enterprise-leftmenu:', JSON.stringify(ov3));

  app.quit();
});
