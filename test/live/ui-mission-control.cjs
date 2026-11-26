// Offscreen Electron verification of Mission Control, Pool Health + Orch Rows,
// and Run Log & Checkpoints using the real src/styles.css at 1180x820.
//   npx electron test/live/ui-mission-control.cjs <outDir>
const { app, BrowserWindow, dialog } = require('electron');
if (dialog && typeof dialog.showErrorBox === 'function') {
  dialog.showErrorBox = (t, c) => { console.error('[ErrorBox]', t, c); };
}
const fs = require('fs');
const path = require('path');
const os = require('os');

const outDir = path.resolve(process.argv[process.argv.length - 1]);
const cssPath = path.join(__dirname, '..', '..', 'src', 'styles.css');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'akron-mc-ui-')));

function wrapHtml(css, body) {
  return `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${css}</style>
<style>body{background:var(--bg-000);color:var(--text-000);margin:0;padding:18px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;}</style>
</head><body>${body}</body></html>`;
}

async function snap(win, css, body, outFile, assertJs) {
  const tmp = path.join(os.tmpdir(), 'mc-' + path.basename(outFile, '.png') + '-' + Date.now() + '.html');
  fs.writeFileSync(tmp, wrapHtml(css, body));
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 350));
  const metrics = await win.webContents.executeJavaScript(`(() => {
    const overflow = document.documentElement.scrollWidth > window.innerWidth;
    const extra = (${assertJs || '() => ({})'})();
    return { overflow, scrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, ...extra };
  })()`);
  const img = await win.webContents.capturePage();
  fs.writeFileSync(outFile, img.toPNG());
  try { fs.unlinkSync(tmp); } catch (_) {}
  return metrics;
}

const missionHtml = `
<div style="max-width:780px;margin:0 auto;">
  <div class="mc-panel active">
    <button type="button" class="mc-head">
      <span class="mc-head-ico"><span class="icon">✦</span></span>
      <span class="mc-title">Swarm Mission Control</span>
      <div class="mc-badges">
        <span class="mc-pill working">2 active</span>
        <span class="mc-pill waiting">1 waiting</span>
        <span class="mc-pill done">1 done</span>
        <span class="mc-pill">4 board</span>
      </div>
    </button>
    <div class="mc-body">
      <div class="mc-phases">
        <div class="mc-phase done"><span class="mc-phase-dot"></span><span class="mc-phase-label">Plan</span></div>
        <div class="mc-phase done"><span class="mc-phase-dot"></span><span class="mc-phase-label">Dispatch</span></div>
        <div class="mc-phase active"><span class="mc-phase-dot"></span><span class="mc-phase-label">Coordinate</span><span class="mc-phase-wave">w1</span></div>
        <div class="mc-phase"><span class="mc-phase-dot"></span><span class="mc-phase-label">Review</span></div>
        <div class="mc-phase"><span class="mc-phase-dot"></span><span class="mc-phase-label">Done</span></div>
      </div>
      <div class="mc-grid">
        <div class="mc-card supervisor running">
          <div class="mc-card-top"><span class="mc-dot running"></span><span class="mc-card-name">Supervisor · @supervisor</span><span class="mc-role planner">planner</span></div>
          <div class="mc-card-meta"><span class="mc-model">gpt-5.6-luna</span><span class="mc-stat">coordinating</span></div>
        </div>
        <div class="mc-card working">
          <div class="mc-card-top"><span class="mc-dot working"></span><span class="mc-card-name">Scanner &amp; AST · @scanner</span><span class="mc-role coder">coder</span></div>
          <div class="mc-card-meta"><span class="mc-model">nemotron-3-ultra</span><span class="mc-failover">⇣ failover</span><span class="mc-stat">6t · 2p · 18s</span></div>
          <div class="mc-action"><span>⚙</span><span>Edit src/scanner.js</span></div>
          <div class="mc-trace">
            <div class="mc-trace-item"><span class="mc-trace-name">Read</span><span class="mc-trace-arg">package.json</span></div>
            <div class="mc-trace-item"><span class="mc-trace-name">Write</span><span class="mc-trace-arg">src/scanner.js</span></div>
            <div class="mc-trace-item"><span class="mc-trace-name">Bash</span><span class="mc-trace-arg">node --test test/scanner.test.js</span></div>
          </div>
        </div>
        <div class="mc-card waiting">
          <div class="mc-card-top"><span class="mc-dot waiting"></span><span class="mc-card-name">HTTP Server · @server</span><span class="mc-role coder">coder</span></div>
          <div class="mc-card-meta"><span class="mc-model">qwen3.8-27b</span><span class="mc-stat">3t · 1p · 14s</span></div>
          <div class="mc-action"><span>⚙</span><span>swarm_wait waiting on @scanner</span></div>
        </div>
        <div class="mc-card done">
          <div class="mc-card-top"><span class="mc-dot done"></span><span class="mc-card-name">Package &amp; Docs · @docs</span><span class="mc-role fast">fast</span></div>
          <div class="mc-card-meta"><span class="mc-model">kilo-auto</span><span class="mc-stat">2t · 1p · 9s</span></div>
        </div>
        <div class="mc-card working">
          <div class="mc-card-top"><span class="mc-dot working"></span><span class="mc-card-name">Graph &amp; Cycles · @graph</span><span class="mc-role coder">coder</span></div>
          <div class="mc-card-meta"><span class="mc-model">qwen3.8-flash</span><span class="mc-stat">4t · 12s</span></div>
          <div class="mc-action"><span>⚙</span><span>Write src/graph.js</span></div>
        </div>
      </div>
      <div class="mc-board">
        <div class="mc-board-head"><span>Shared Message Board (4)</span><button type="button" class="btn-mini">Hide</button></div>
        <div class="mc-board-feed">
          <div class="mc-post"><div class="mc-post-meta"><span>#1</span><span class="mc-post-from">@docs</span><span class="mc-post-chan">t1</span></div><div class="mc-post-text">Created package.json with node --test test/*.test.js and README skeleton.</div></div>
          <div class="mc-post"><div class="mc-post-meta"><span>#2</span><span class="mc-post-from">@scanner</span><span class="mc-post-to">→ @server</span><span class="mc-post-chan">t2</span></div><div class="mc-post-text"><span class="mc-mention">@server</span> scanDir(root) returns { files, edges, todos }. Ready for POST /scan.</div></div>
          <div class="mc-post"><div class="mc-post-meta"><span>#3</span><span class="mc-post-from">@server</span><span class="mc-post-chan">t3</span></div><div class="mc-post-text">Thanks <span class="mc-mention">@scanner</span> — wiring /scan and /report.html now.</div></div>
        </div>
      </div>
    </div>
  </div>
  <div class="activity"><span class="activity-spin"><span class="icon">✳</span></span><span class="activity-text">Orchestrating swarm…</span><span class="activity-target">4 workers across coder + fast</span><span class="activity-time">0:18</span></div>
  <div class="composer is-streaming"><textarea rows="1" placeholder="Ask Akron Bot anything…"></textarea><div class="composer-foot"><div class="composer-actions"><span class="composer-hint">Streaming live…</span></div></div></div>
</div>`;

const row = (name, win, on, tier) => on
  ? `<div class="orch-row on"><label class="orch-check"><input type="checkbox" checked><span class="orch-name">${name}</span><span class="orch-win">${win}</span></label><select class="orch-tier"><option>${tier}</option></select><label class="orch-radio"><input type="radio" name="a" ${tier === 'heavy' ? 'checked' : ''}> start</label></div>`
  : `<div class="orch-row"><label class="orch-check"><input type="checkbox"><span class="orch-name">${name}</span><span class="orch-win">${win}</span></label></div>`;

const poolHealthHtml = `
<div class="modal" style="width:580px;margin:0 auto;">
  <h3>Orchestrator</h3>
  <div class="orch-pool">
    <div class="orch-pool-head"><span class="orch-count">3 of 62 selected</span><input class="orch-search" placeholder="Filter models…"><button type="button" class="btn-mini">Reload</button></div>
    <div class="orch-grp">
      <div class="orch-grp-head">Claude · max</div>
      ${row('Claude Opus 5.5', '1M', true, 'heavy')}
      ${row('Claude Haiku 5.5', '1M', true, 'small')}
      ${row('Claude Fable 5.2', '1M', true, 'critical')}
      ${row('Claude Sonnet 5', '1M', false)}
    </div>
  </div>
  <h3>Role pools</h3>
  <div class="pools-ed">
    <div class="pools-top">
      <label class="pools-toggle"><input type="checkbox" checked><span>Enable role pools</span></label>
      <button type="button" class="btn-mini">Load FreeLLMAPI preset</button>
    </div>
    <div class="pools-gw">
      <label class="pools-field pools-grow"><span>Gateway base URL</span><input value="http://127.0.0.1:3001/v1"></label>
      <label class="pools-field pools-key"><span>Key (optional)</span><input type="password" value="secret"></label>
    </div>
    <div class="pools-roles">
      <div class="pools-role">
        <div class="pools-role-head"><span class="pools-role-name">Planner / Reasoner</span><span class="pools-role-id">planner</span><label class="pools-field pools-max"><span>max parallel</span><input type="number" value="1"></label></div>
        <textarea class="pools-models" rows="3">gpt-5.6-luna @1
glm-5.3 @1
nemotron-3-ultra-550b-a55b @2</textarea>
        <div class="pools-health">
          <span class="pools-chip ok"><span class="pools-chip-dot"></span><span>gpt-5.6-luna</span><span class="pools-chip-meta">1 active</span></span>
          <span class="pools-chip cooling"><span class="pools-chip-dot"></span><span>glm-5.3</span><span class="pools-chip-meta">42s</span></span>
          <span class="pools-chip ok"><span class="pools-chip-dot"></span><span>nemotron-3-ultra-550b-a55b</span><span class="pools-chip-meta">ready</span></span>
        </div>
      </div>
      <div class="pools-role">
        <div class="pools-role-head"><span class="pools-role-name">Implementer / Coder</span><span class="pools-role-id">coder</span><label class="pools-field pools-max"><span>max parallel</span><input type="number" value="4"></label></div>
        <textarea class="pools-models" rows="3">qwen3.8-flash @1
mistral-devstral-2512 @1
qwen3.8-27b @3</textarea>
        <div class="pools-health">
          <span class="pools-chip ok"><span class="pools-chip-dot"></span><span>qwen3.8-flash</span><span class="pools-chip-meta">ready</span></span>
          <span class="pools-chip dead"><span class="pools-chip-dot"></span><span>mistral-devstral-2512</span><span class="pools-chip-meta">dead</span></span>
          <span class="pools-chip ok"><span class="pools-chip-dot"></span><span>qwen3.8-27b</span><span class="pools-chip-meta">2 active</span></span>
        </div>
      </div>
    </div>
  </div>
</div>`;

const runLogHtml = `
<div style="width:440px;margin:0 auto;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg-100);overflow:hidden;">
  <div class="rl-panel">
    <div class="rl-tabs">
      <button type="button" class="rl-tab on">Replay (4)</button>
      <button type="button" class="rl-tab">Checkpoints (3)</button>
      <button type="button" class="btn-mini" style="margin-left:auto;">Refresh</button>
    </div>
    <div class="rl-controls">
      <select class="rl-select"><option>05:41:12 · 14 events</option></select>
      <button type="button" class="btn-mini">◀</button>
      <button type="button" class="btn-mini">▶</button>
      <button type="button" class="btn-mini">▶|</button>
    </div>
    <div class="rl-scrubber">
      <input type="range" min="1" max="14" value="6">
      <span class="rl-step-count">6 / 14</span>
    </div>
    <div class="rl-timeline">
      <div class="rl-ev"><div class="rl-ev-head"><span class="rl-ev-time">+0.0s</span><span class="rl-ev-type swarm">swarm</span><b>start</b></div><div class="rl-ev-body">Supervisor: gpt-5.6-luna (planner pool)</div></div>
      <div class="rl-ev"><div class="rl-ev-head"><span class="rl-ev-time">+4.2s</span><span class="rl-ev-type orchestrator">orchestrator</span><span class="mc-role coder">scanner</span></div><div class="rl-ev-body">qwen3.8-flash → nemotron-3-ultra-550b-a55b: rate limited</div></div>
      <div class="rl-ev"><div class="rl-ev-head"><span class="rl-ev-time">+6.8s</span><span class="rl-ev-type tool">tool</span><span class="mc-role coder">scanner</span><b>Write</b></div><div class="rl-ev-body">{"file_path":"src/scanner.js"}</div></div>
      <div class="rl-ev current"><div class="rl-ev-head"><span class="rl-ev-time">+11.5s</span><span class="rl-ev-type subagent">subagent</span><span class="mc-role fast">docs</span><b>done</b></div></div>
    </div>
    <div class="rl-cp-list">
      <div class="rl-cp-card">
        <div class="rl-cp-head"><b>Turn 3 · 05:41:12</b><button type="button" class="btn-mini">↺ Rewind here</button></div>
        <div class="rl-cp-files"><span>restore src/server.js</span><span>remove test/server.test.js</span></div>
      </div>
    </div>
  </div>
</div>`;

app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const css = fs.readFileSync(cssPath, 'utf8');
  const win = new BrowserWindow({ width: 1180, height: 820, show: false, backgroundColor: '#30302e' });
  const m1 = await snap(win, css, missionHtml, path.join(outDir, 'mission-control.png'));
  const m2 = await snap(win, css, poolHealthHtml, path.join(outDir, 'pool-health.png'), `() => {
    const rows = [...document.querySelectorAll('.orch-row.on')].map(r => {
      const rr = r.getBoundingClientRect(), s = r.querySelector('.orch-tier').getBoundingClientRect(), d = r.querySelector('.orch-radio').getBoundingClientRect();
      return { selectW: Math.round(s.width), radioInside: d.right <= rr.right + 0.5 };
    });
    return { rows };
  }`);
  const m3 = await snap(win, css, runLogHtml, path.join(outDir, 'run-log.png'));
  win.destroy();
  console.log('mission-control:', JSON.stringify(m1));
  console.log('pool-health:', JSON.stringify(m2));
  console.log('run-log:', JSON.stringify(m3));
  if (m1.overflow || m2.overflow || m3.overflow) process.exit(2);
  if ((m2.rows || []).some((r) => !r.radioInside || r.selectW >= 90)) process.exit(3);
  app.quit();
});
