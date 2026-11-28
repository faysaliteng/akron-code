'use strict';
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
dialog.showErrorBox = () => {};
process.on('uncaughtException', (e) => { console.error(e); app.exit(1); });
process.on('unhandledRejection', (e) => { console.error(e); app.exit(1); });
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_DIR = (process.env.AKRON_ARTIFACTS_DIR || os.tmpdir());
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ui-cpsd-'));
process.env.AUTOBOT_PLUGINS_FILE = path.join(tmpRoot, 'plugins.json');
process.env.AUTOBOT_GDRIVE_FILE = path.join(tmpRoot, 'gdrive.json');

const driveFixture = path.join(tmpRoot, 'My Drive');
fs.mkdirSync(driveFixture, { recursive: true });
fs.writeFileSync(path.join(driveFixture, 'ProductSpec.md'), '# Product Spec\nDrive context test passed.\n');
fs.writeFileSync(path.join(driveFixture, 'Architecture.txt'), 'Akron Bot Multi-Agent Architecture\n');

const commands = require('../../electron/commands');
const rea = require('../../electron/rea');
const gdrive = require('../../electron/gdrive');
const pluginsDir = require('../../electron/plugins');
const { MCPClient } = require('../../electron/mcp');

const mcp = new MCPClient();
const memSecrets = new Map();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function registerBackendHandlers() {
  const safe = (ch, fn) => {
    try { ipcMain.removeHandler(ch); } catch (_) {}
    ipcMain.handle(ch, fn);
  };
  safe('autobot:getVersion', () => ({ app: '1.0.0', electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, arch: process.arch }));
  safe('autobot:getSettings', () => ({ theme: 'dark', locale: 'en' }));
  safe('autobot:setSettings', (_e, p) => p || {});
  safe('autobot:getFeatures', () => ({}));
  safe('autobot:getMemory', () => ({ entries: [] }));
  safe('autobot:getSkills', () => [{ name: 'reverse-engineer-anything', description: 'Reverse engineer targets with REA', enabled: true }]);
  safe('autobot:getOrchestrator', () => ({ enabled: true, providers: [] }));
  safe('autobot:poolsPreset', () => ({ enabled: true, roles: {} }));
  safe('autobot:poolStatus', () => ({ roles: {} }));
  safe('autobot:providerStatus', () => ({ ok: true, status: { providers: [] } }));
  safe('autobot:freellmStatus', () => ({ running: true }));
  safe('autobot:listNotebooks', () => []);
  safe('autobot:listScheduledTasks', () => []);
  safe('autobot:customToolList', () => []);
  safe('autobot:mcpStatus', () => []);
  safe('autobot:mcpConfig', () => ({ servers: [], status: [] }));
  safe('autobot:extBridgeStatus', () => ({ running: true, tabs: [{ id: 1, active: true, title: 'Docs', url: 'https://example.com' }] }));
  safe('autobot:extensionList', () => []);
  safe('autobot:extensionStatus', () => ({}));
  safe('autobot:reaStatus', () => rea.status(mcp));
  safe('autobot:reaConnect', async () => {
    const r = await rea.ensureConnected(mcp);
    return { ok: true, ...r, status: rea.status(mcp) };
  });
  safe('autobot:gitInfo', () => ({ isRepo: false }));
  safe('autobot:probeProviders', () => ({}));
  safe('autobot:getDefaultCwd', () => path.join(__dirname, '../..'));
  safe('autobot:getWorkspace', () => path.join(__dirname, '../..'));
  safe('autobot:providerReconnectState', () => ({ active: false }));
  safe('autobot:complianceGet', () => ({ profile: {}, state: { feedback: { allowed: true }, deletion: { allowed: true } } }));

  safe('autobot:listSlashActions', () => commands.listSlashActions({
    cwd: path.join(__dirname, '../..'),
    mcpPrompts: rea.REA_BUILTIN_PROMPTS,
    skills: [{ name: 'reverse-engineer-anything', description: 'Reverse engineer targets with REA', enabled: true }],
  }));
  safe('autobot:listWorkspaceFiles', async (_e, cwd, query = '') => {
    const q = String(query || '').toLowerCase();
    const sample = ['src/App.jsx', 'electron/main.js', 'electron/gdrive.js', 'electron/plugins.js', 'electron/rea.js', 'package.json'];
    return sample
      .filter((p) => !q || p.toLowerCase().includes(q))
      .map((p) => ({ name: path.basename(p), path: p, fullPath: path.join(__dirname, '../..', p) }));
  });

  safe('autobot:gdriveStatus', () => gdrive.status(mcp));
  safe('autobot:gdrivePickFolder', () => driveFixture);
  safe('autobot:gdriveConnect', async (_e, payload = {}) => {
    const res = payload.mode === 'local'
      ? gdrive.connectLocalFolder(payload.folderPath || driveFixture)
      : { ok: false, error: 'unsupported in harness' };
    pluginsDir.install('gdrive');
    pluginsDir.setConfig('gdrive', { connected: true, connectedAt: Date.now(), mode: payload.mode || 'local' });
    return { ...res, status: gdrive.status(mcp) };
  });
  safe('autobot:gdriveDisconnect', () => gdrive.disconnect(mcp));
  safe('autobot:gdriveSearch', async (_e, q, opts) => gdrive.searchFiles(q, opts, mcp));
  safe('autobot:gdriveRead', async (_e, id) => gdrive.readFile(id, mcp));

  safe('autobot:listPlugins', (_e, opts) => pluginsDir.listPlugins(opts));
  safe('autobot:pluginCategories', () => pluginsDir.categories());
  safe('autobot:searchPlugins', (_e, q, opts) => pluginsDir.search(q, opts));
  safe('autobot:pluginStats', () => pluginsDir.stats());
  safe('autobot:installPlugin', async (_e, id) => {
    const r = pluginsDir.install(id);
    if (id === 'rea') {
      const res = await rea.ensureConnected(mcp);
      pluginsDir.setConfig(id, { connected: true, toolCount: res.toolCount });
      return { ok: true, entry: pluginsDir.markConnected(id), tools: res.tools };
    }
    return r;
  });
  safe('autobot:uninstallPlugin', (_e, id) => {
    memSecrets.delete(id);
    return pluginsDir.uninstall(id);
  });
  safe('autobot:configurePlugin', async (_e, id, cfg = {}) => {
    if (cfg.apiKey) memSecrets.set(id, cfg.apiKey);
    const upd = pluginsDir.setConfig(id, { connected: true, hasApiKey: !!cfg.apiKey, mode: 'apikey', lastTestOk: true });
    return { ok: true, entry: upd, detail: 'API key saved securely and verified.' };
  });
  safe('autobot:testPlugin', async (_e, id) => {
    const entry = pluginsDir.get(id);
    if (id === 'rea') {
      const res = await rea.ensureConnected(mcp);
      return { ok: true, detail: `REA connected (${res.toolCount} MCP tools)`, toolCount: res.toolCount };
    }
    if (entry && entry.type === 'plugin') {
      return { ok: true, detail: `Plugin active (${(entry.provides || []).join(', ')})` };
    }
    if (memSecrets.has(id)) {
      return { ok: true, detail: 'API key present in secret store' };
    }
    return { ok: false, error: 'Missing credentials' };
  });
}

app.whenReady().then(async () => {
  registerBackendHandlers();
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../../electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('[renderer]', message);
  });
  await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  await win.webContents.executeJavaScript(`
    localStorage.setItem('autobot:convs', ${JSON.stringify(JSON.stringify([{ id: 'c1', title: 'Test Chat', ts: Date.now(), messages: [{ id: 'm1', role: 'user', content: 'Ready' }, { id: 'm2', role: 'assistant', content: 'Ready.' }] }]))});
    localStorage.setItem('autobot:activeId', ${JSON.stringify(JSON.stringify('c1'))});
  `);
  await win.reload();
  await wait(800);

  // 1. Check composer placeholder + click + Add Context
  const check1 = await win.webContents.executeJavaScript(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      if (!ta) return { ok: false, err: 'missing textarea', body: (document.body.innerText || '').slice(0, 300) };
      const ph = ta.getAttribute('placeholder');
      const plusBtn = document.querySelector('.add-context-btn');
      if (!plusBtn) return { ok: false, err: 'missing add-context-btn' };
      plusBtn.click();
      await new Promise(r => setTimeout(r, 150));
      const menu = document.querySelector('.add-context-menu');
      if (!menu) return { ok: false, err: 'add-context-menu did not open' };
      const items = [...menu.querySelectorAll('.add-context-item')].map(el => el.textContent.replace(/\\s+/g, ' ').trim());
      const rect = menu.getBoundingClientRect();
      return { ok: true, ph, items, rect: { width: rect.width, height: rect.height, top: rect.top } };
    })()
  `);
  assert(check1.ok, JSON.stringify(check1));
  assert.strictEqual(check1.ph, 'Ask anything, @ to mention, / for actions');
  assert(check1.rect.height > 150 && check1.rect.top >= 0, 'Add Context menu clipped or collapsed: ' + JSON.stringify(check1.rect));
  assert(check1.items.some((s) => /Drive.*Set up/i.test(s)), 'Expected Drive -> Set up in menu: ' + JSON.stringify(check1.items));
  const imgCtx = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'add-context-menu.png'), imgCtx.toPNG());
  console.log('✓ 1. Add Context popover verified & screenshot saved:', check1.items);

  // 2. Dismiss menu, stage an image chip inside composer (via paste DataTransfer or file input), type `/` -> check floating `/` Actions palette
  const check2 = await win.webContents.executeJavaScript(`
    (async () => {
      // Close Add Context menu first by clicking Actions
      const items = [...document.querySelectorAll('.add-context-item')];
      const actBtn = items.find(b => /Actions/i.test(b.textContent));
      actBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const pal = document.querySelector('.slash-palette');
      if (!pal) return { ok: false, err: 'slash-palette did not appear' };
      const rows = [...pal.querySelectorAll('.slash-row .slash-name')].map(el => el.textContent.trim());
      const rect = pal.getBoundingClientRect();
      const taRect = document.querySelector('.composer').getBoundingClientRect();
      return { ok: true, rows: rows.slice(0, 12), aboveComposer: rect.bottom <= taRect.top + 4, width: rect.width, height: rect.height };
    })()
  `);
  assert(check2.ok, JSON.stringify(check2));
  assert(check2.aboveComposer, 'Slash palette not positioned above composer');
  assert.strictEqual(check2.rows[0], 'btw');
  assert(check2.rows.includes('mcp:rea:investigate_feature'));
  assert(check2.rows.includes('mcp:rea:compare_application_versions'));
  assert(check2.rows.includes('mcp:rea:verify_reconstruction'));
  assert(check2.rows.includes('mcp:rea:trace_crash'));
  assert(check2.rows.includes('mcp:rea:audit_residual_unknowns'));
  assert(check2.rows.includes('mcp:rea:prepare_bounded_process_capture'));
  assert(check2.rows.includes('goal'));
  const imgSlash = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'slash-actions-popup.png'), imgSlash.toPNG());
  console.log('✓ 2. Floating `/` Actions palette verified & screenshot saved:', check2.rows.slice(0, 8));

  // 3. Test @ Mentions popup
  const check3 = await win.webContents.executeJavaScript(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, '@');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      const pal = document.querySelector('.mention-palette');
      if (!pal) return { ok: false, err: 'mention-palette missing' };
      const rows = [...pal.querySelectorAll('.slash-name')].map(el => el.textContent.trim());
      return { ok: true, rows };
    })()
  `);
  assert(check3.ok, JSON.stringify(check3));
  assert(check3.rows.includes('@verifier') && check3.rows.some((r) => r.includes('src/App.jsx')), 'Mentions missing expected items: ' + JSON.stringify(check3.rows));
  console.log('✓ 3. `@` Mentions autocomplete verified:', check3.rows.slice(0, 6));

  // 4. Open Drive setup via Add Context -> Drive, connect fixture folder, search & attach file into composer
  const check4 = await win.webContents.executeJavaScript(`
    (async () => {
      const ta = document.querySelector('.composer textarea');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.add-context-btn').click();
      await new Promise(r => setTimeout(r, 120));
      const driveBtn = [...document.querySelectorAll('.add-context-item')].find(b => /Drive/i.test(b.textContent));
      driveBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const modal = document.querySelector('.gdrive-modal');
      if (!modal) return { ok: false, err: 'gdrive-modal did not open' };
      // Select Drive Desktop Folder tab & connect fixture path
      const localTab = [...modal.querySelectorAll('.seg button')].find(b => /Desktop Folder/i.test(b.textContent));
      localTab.click();
      await new Promise(r => setTimeout(r, 100));
      const inp = modal.querySelector('.gdrive-input');
      const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setVal.call(inp, ${JSON.stringify(driveFixture)});
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const connBtn = [...modal.querySelectorAll('button')].find(b => /Connect Folder/i.test(b.textContent));
      connBtn.click();
      await new Promise(r => setTimeout(r, 350));
      const files = [...modal.querySelectorAll('.gdrive-file-row b')].map(b => b.textContent.trim());
      return { ok: true, files };
    })()
  `);
  assert(check4.ok, JSON.stringify(check4));
  assert(check4.files.includes('ProductSpec.md'), 'Drive browse list missing ProductSpec.md: ' + JSON.stringify(check4.files));
  const imgDrive = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'google-drive-setup.png'), imgDrive.toPNG());
  console.log('✓ 4. Google Drive setup & live file browser verified & screenshot saved:', check4.files);

  // Attach file from Google Drive & verify chip inside composer + `/` still opens with attachment present
  const check4b = await win.webContents.executeJavaScript(`
    (async () => {
      const attachBtn = document.querySelector('.gdrive-file-row button');
      attachBtn.click();
      await new Promise(r => setTimeout(r, 250));
      const chips = [...document.querySelectorAll('.composer .attach-chip .attach-name')].map(el => el.textContent.trim());
      const ta = document.querySelector('.composer textarea');
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      nativeSetter.call(ta, '/');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 150));
      const slashWithChip = !!document.querySelector('.slash-palette');
      nativeSetter.call(ta, '');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return { chips, slashWithChip };
    })()
  `);
  assert(check4b.chips.some((c) => /(Architecture\.txt|ProductSpec\.md)/.test(c)), 'Drive file was not attached to composer: ' + JSON.stringify(check4b.chips));
  assert(check4b.slashWithChip, 'Slash palette did not open when attachment chip was present');
  console.log('✓ 4b. Attached Drive file chip & `/` palette with attachment verified:', check4b);

  // 5. Test Connectors & Plugins UI in Settings -> Skills & Plugins (Coda API key connector + Deep Research plugin)
  const check5 = await win.webContents.executeJavaScript(`
    (async () => {
      document.querySelector('.sidebar-custom-btn').click();
      await new Promise(r => setTimeout(r, 250));
      const searchIn = document.querySelector('.plugins-panel .skills-search');
      const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setVal.call(searchIn, 'coda');
      searchIn.dispatchEvent(new Event('input', { bubbles: true }));
      searchIn.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      const card = document.querySelector('.plugins-panel .plugin-card');
      if (!card) return { ok: false, err: 'missing Coda card' };
      const instBtn = [...card.querySelectorAll('button')].find(b => b.textContent.trim() === 'Install');
      instBtn.click();
      await new Promise(r => setTimeout(r, 250));
      const keyInp = document.querySelector('.plugin-cfg-drawer input[type="password"]');
      if (!keyInp) return { ok: false, err: 'API key configure drawer did not auto-open for apikey connector' };
      setVal.call(keyInp, 'coda-test-key-123');
      keyInp.dispatchEvent(new Event('input', { bubbles: true }));
      keyInp.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 50));
      const saveBtn = [...document.querySelectorAll('.plugin-cfg-drawer button')].find(b => /Save/i.test(b.textContent));
      saveBtn.click();
      await new Promise(r => setTimeout(r, 250));
      const testBtn = [...document.querySelectorAll('.plugins-panel .plugin-card button')].find(b => b.textContent.trim() === 'Test');
      testBtn.click();
      await new Promise(r => setTimeout(r, 200));
      const verdictCoda = document.querySelector('.plugin-test-res')?.textContent?.trim() || '';

      // Also install & test built-in plugin (Deep Research)
      setVal.call(searchIn, 'deep research');
      searchIn.dispatchEvent(new Event('input', { bubbles: true }));
      searchIn.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 250));
      const drCard = document.querySelector('.plugins-panel .plugin-card');
      const drInst = drCard && [...drCard.querySelectorAll('button')].find(b => b.textContent.trim() === 'Install');
      if (drInst) drInst.click();
      await new Promise(r => setTimeout(r, 200));
      const drTest = [...document.querySelectorAll('.plugins-panel .plugin-card button')].find(b => b.textContent.trim() === 'Test');
      if (drTest) drTest.click();
      await new Promise(r => setTimeout(r, 200));
      const verdictPlugin = document.querySelector('.plugin-test-res')?.textContent?.trim() || '';
      document.querySelector('.plugins-panel')?.scrollIntoView({ block: 'start' });
      await new Promise(r => setTimeout(r, 120));

      return { ok: true, verdictCoda, verdictPlugin };
    })()
  `);
  assert(check5.ok, JSON.stringify(check5));
  assert(check5.verdictCoda.includes('✓'), 'Connector Test did not succeed: ' + check5.verdictCoda);
  assert(check5.verdictPlugin.includes('✓ Plugin active'), 'Plugin Test did not succeed: ' + check5.verdictPlugin);
  const imgPlug = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'connectors-plugins-verified.png'), imgPlug.toPNG());
  console.log('✓ 5. Connector & Plugin Install -> Configure -> Test verified & screenshot saved:', check5);

  mcp.disconnectAll();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
  console.log('\nUI_SLASH_CONTEXT_DRIVE_E2E_OK');
  app.quit();
});
