// Before/after render of the orchestrator checklist rows with the real CSS.
//   npx electron test/live/ui-orch-rows.cjs <before.css> <after.css> <outDir>
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const [beforeCss, afterCss, outDir] = process.argv.slice(-3);
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'akron-rows-')));
const row = (name, win, on, tier) => on
  ? `<div class="orch-row on"><label class="orch-check" title="${name}"><input type="checkbox" checked><span class="orch-name">${name}</span><span class="orch-win">${win}</span></label><select class="orch-tier"><option>${tier}</option></select><label class="orch-radio"><input type="radio" name="a" ${tier === 'heavy' ? 'checked' : ''}> start</label></div>`
  : `<div class="orch-row"><label class="orch-check" title="${name}"><input type="checkbox"><span class="orch-name">${name}</span><span class="orch-win">${win}</span></label></div>`;
const body = `<div class="modal" style="width:440px;margin:20px auto"><h3>Orchestrator</h3><div class="orch-pool">
<div class="orch-pool-head"><span class="orch-count">4 of 99 selected</span><input class="orch-search" placeholder="Filter models…"><button>Reload</button></div>
<div class="orch-grp"><div class="orch-grp-head">Claude · max</div>
${row('Claude Opus 5.5', '1M', true, 'heavy')}${row('Claude Haiku 5.5', '1M', true, 'small')}${row('Claude Fable 5.2', '1M', true, 'critical')}
${row('Claude Fable 5.1', '1M', false)}${row('Claude Opus 5', '1M', false)}${row('Claude Sonnet 4.5', '200K', false)}
</div></div></div>`;
async function render(css, file) {
  const html = `<!doctype html><html class="dark"><head><meta charset="utf-8"><style>${fs.readFileSync(css, 'utf8')}</style><style>body{background:#262624;font-family:-apple-system,sans-serif}</style></head><body>${body}</body></html>`;
  const tmp = path.join(os.tmpdir(), 'rows-' + Date.now() + '.html');
  fs.writeFileSync(tmp, html);
  const win = new BrowserWindow({ width: 520, height: 420, show: false });
  await win.loadFile(tmp);
  await new Promise((r) => setTimeout(r, 400));
  const m = await win.webContents.executeJavaScript(`[...document.querySelectorAll('.orch-row.on')].map(r => { const rr=r.getBoundingClientRect(), n=r.querySelector('.orch-name').getBoundingClientRect(), s=r.querySelector('.orch-tier').getBoundingClientRect(), d=r.querySelector('.orch-radio').getBoundingClientRect(); return {nameW:Math.round(n.width), selectW:Math.round(s.width), radioInside: d.right <= rr.right + 0.5}; })`);
  fs.writeFileSync(path.join(outDir, file), (await win.webContents.capturePage()).toPNG());
  console.log(file, JSON.stringify(m));
  win.destroy();
}
app.whenReady().then(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  await render(beforeCss, 'orch-rows-before.png');
  await render(afterCss, 'orch-rows-after.png');
  app.quit();
});
