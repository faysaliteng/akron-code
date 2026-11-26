const { dialog, app, BrowserWindow } = require('electron');
dialog.showErrorBox = () => {};
const assert = require('assert');
const http = require('http');
const path = require('path');

const OUT_SHOT = '/Users/saimon/.gemini/antigravity/brain/cb4ff1d8-186c-4ca3-9b84-bfe96acbf3bc/model-before-worked-for-verified.png';

app.whenReady().then(async () => {
  const tmpData = path.join(require('os').tmpdir(), 'akron-e2e-model-' + Date.now());
  app.setPath('userData', tmpData);

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../../electron/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  await win.loadFile(path.join(__dirname, '../../dist/index.html'));
  await win.webContents.executeJavaScript(`(() => {
    const convs = [{
      id: 'c1',
      title: 'Model Attribution Check',
      ts: Date.now(),
      messages: [
        { id: 'u1', role: 'user', content: 'hi', ts: Date.now() - 15000 },
        { id: 'a1', role: 'assistant', content: 'All systems operational.', model: 'claude-sonnet-4-5', modelsUsed: ['claude-sonnet-4-5'], durationMs: 13000, ts: Date.now() },
      ],
    }];
    localStorage.setItem('autobot:convs', JSON.stringify(convs));
    localStorage.setItem('autobot:activeId', JSON.stringify('c1'));
  })()`, true);
  await win.reload();
  await new Promise((r) => setTimeout(r, 1500));

  const dom = await win.webContents.executeJavaScript(`(() => {
    const meta = document.querySelector('.response-actions-meta');
    const badge = document.querySelector('.response-model-name');
    const worked = document.querySelector('.response-worked-time');
    return {
      metaText: meta ? meta.innerText.trim() : '',
      badgeText: badge ? badge.innerText.trim() : '',
      workedText: worked ? worked.innerText.trim() : '',
      badgeIndexBeforeWorked: meta && badge && worked ? (meta.innerText.indexOf(badge.innerText.trim()) < meta.innerText.indexOf('Worked for')) : false,
    };
  })()`, true);

  assert.strictEqual(dom.badgeText, 'claude-sonnet-4-5', JSON.stringify(dom));
  assert.ok(dom.workedText.includes('Worked for 13s'), JSON.stringify(dom));
  assert.strictEqual(dom.badgeIndexBeforeWorked, true, JSON.stringify(dom));

  const img = await win.webContents.capturePage();
  require('fs').writeFileSync(OUT_SHOT, img.toPNG());
  console.log('E2E_MODEL_BEFORE_WORKED_FOR_OK', JSON.stringify(dom));

  require('fs').rmSync(tmpData, { recursive: true, force: true });
  app.exit(0);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
