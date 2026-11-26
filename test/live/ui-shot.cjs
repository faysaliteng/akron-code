// Isolated UI screenshot harness: renders dist/index.html with a stubbed
// window.autobot bridge (no ~/.autobot, no network, no keychain) and captures
// the Settings → Orchestrator / Role pools section and the model picker.
//   npx electron test/live/ui-shot.cjs <outDir>
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const out = path.resolve(process.argv[process.argv.length - 1].endsWith('.cjs') ? os.tmpdir() : process.argv[process.argv.length - 1]);
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ui-')));
const preload = path.join(os.tmpdir(), 'akron-ui-preload-' + process.pid + '.js');
const router = require('../../electron/orch-router');
const models = ['Claude Opus 5.5', 'Claude Fable 5.2', 'Claude Haiku 5.5', 'Claude Sonnet 5', 'Claude Opus 4.8', 'Claude Opus 4.5'].map((n, i) => ({ id: n.toLowerCase().replace(/ /g, '-').replace('.', '-'), label: n, name: n, contextWindow: i < 5 ? 1000000 : 200000 }));
const orch = {
  enabled: true, activeIndex: 0, pools: router.freellmPreset(),
  providers: models.slice(0, 3).map((m, i) => ({ id: 'oauth|claude:max|' + m.id, name: 'Claude · max · ' + m.label, baseURL: '', apiKey: '', model: m.id, tier: ['heavy', 'small', 'critical'][i], oauth: true, oauthProvider: 'claude:max', transport: 'anthropic', contextWindow: m.contextWindow })),
};
fs.writeFileSync(preload, `
const ORCH = ${JSON.stringify(orch)};
const MODELS = ${JSON.stringify(models)};
const handlers = {
  getOrchestrator: async () => ORCH,
  setOrchestrator: async (p) => Object.assign(ORCH, p),
  poolsPreset: async () => ORCH.pools,
  providerStatus: async () => ({ ok: true, status: { providers: [{ id: 'claude', label: 'Claude', name: 'Claude', accounts: [{ account: 'max', label: 'max', hasToken: true, plan: 'max' }] }] } }),
  providerModels: async () => ({ ok: true, models: MODELS }),
  getSettings: async () => ({ theme: 'dark', provider: { baseURL: 'http://localhost:3001/v1', model: 'qwen3.8-flash', apiKey: '' } }),
  probeProviders: async () => ({}),
};
const noop = () => () => {};
window.autobot = new Proxy(handlers, { get: (t, k) => (k in t ? t[k] : (/^on[A-Z]/.test(String(k)) ? noop : async () => [])) });
`);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 760, show: false, backgroundColor: '#1f1e1d', webPreferences: { preload, contextIsolation: false, nodeIntegration: false, sandbox: false } });
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 3) errors.push(msg); });
  await win.loadFile(path.join(__dirname, '..', '..', 'dist', 'index.html'));
  const ev = (js) => win.webContents.executeJavaScript(js, true);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name) => { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(out, name), img.toPNG()); console.log('wrote', path.join(out, name)); };
  await sleep(1500);
  await shot('ui-main.png');
  // Open Settings through the sidebar gear (fallback: any button titled Settings).
  const opened = await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => /settings/i.test(x.title || x.getAttribute('aria-label') || x.textContent || '')); if (b) { b.click(); return b.outerHTML.slice(0, 120); } return null; })()`);
  console.log('settings button:', opened);
  await sleep(1200);
  const info = await ev(`(() => {
    const pool = document.querySelector('.orch-pool');
    if (pool) pool.scrollIntoView({ block: 'start' });
    const rows = [...document.querySelectorAll('.orch-row.on')].map(r => {
      const rr = r.getBoundingClientRect();
      const name = r.querySelector('.orch-name'); const sel = r.querySelector('.orch-tier'); const radio = r.querySelector('.orch-radio');
      const nb = name && name.getBoundingClientRect(); const sb = sel && sel.getBoundingClientRect(); const rb = radio && radio.getBoundingClientRect();
      return { row: Math.round(rr.width), nameW: nb && Math.round(nb.width), selW: sb && Math.round(sb.width), radioRightInside: rb ? rb.right <= rr.right + 0.5 : null, text: name && name.textContent };
    });
    return { hasPool: !!pool, rows, pools: !!document.querySelector('.pools-ed') };
  })()`);
  console.log('checked rows:', JSON.stringify(info));
  await sleep(500);
  await shot('ui-orchestrator.png');
  await ev(`(() => { const p = document.querySelector('.pools-ed'); if (p) p.scrollIntoView({ block: 'start' }); })()`);
  await sleep(500);
  await shot('ui-role-pools.png');
  console.log('console errors:', JSON.stringify(errors.slice(0, 8)));
  app.quit();
});
