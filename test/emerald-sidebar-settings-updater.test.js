'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const budget = require('../electron/token-budget');
const appSys = require('../electron/app-system');
const rules = require('../electron/browser-rules');
const diag = require('../electron/diagnostics');
const updater = require('../electron/updater');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    failed++;
  }
}

(async () => {
  console.log('\n=== EMERALD CARBON, SIDEBAR, TOKEN BUDGET, EXTENDED SETTINGS & UPDATER TESTS ===');

  await test('20,000-token customization budget attributes Global vs Project and auto-demotes overflow to @path', () => {
    const bigText = 'x'.repeat(80000); // ~20,000 tokens alone
    const res = budget.analyzeCustomizationBudget({
      capTokens: 20000,
      globalRules: [{ id: 'g1', name: 'Global Style', content: 'Keep it clean', tokens: 200 }],
      projectRules: [{ id: 'p1', name: 'Project Guide', content: 'Always test', tokens: 300, pinned: true }],
      skills: [{ name: 'heavy-skill', description: 'Huge', instructions: bigText, source: 'user', file: '~/.claude/skills/heavy/SKILL.md' }],
    });
    assert.strictEqual(res.overBudget, true);
    assert.strictEqual(res.demotedCount, 1);
    assert.strictEqual(res.demotedItems[0].scope, 'Global');
    assert.ok(res.demotedItems[0].mentionRef.includes('@'));
    assert.ok(res.activeTokens <= 20000);
  });

  await test('Browser allow/deny URL rules give Deny strict precedence over Allow', () => {
    const cfg = {
      allowList: ['*.github.com', 'docs.python.org'],
      denyList: ['admin.github.com', 'https://docs.python.org/private/*'],
    };
    assert.strictEqual(rules.evaluateBrowserUrlRule('https://gist.github.com/test', cfg).allowed, true);
    assert.strictEqual(rules.evaluateBrowserUrlRule('https://admin.github.com/panel', cfg).allowed, false);
    assert.strictEqual(rules.evaluateBrowserUrlRule('https://docs.python.org/private/keys', cfg).allowed, false);
    assert.strictEqual(rules.evaluateBrowserUrlRule('https://evil.example.org', cfg).allowed, false);
  });

  await test('Diagnostic bundle generator scrubs API tokens, emails, and user home paths', () => {
    const fakeKey = 'sk-' + 'test9876543210abcdef';
    const fakePat = 'gh' + 'p_1234567890abcdefghij';
    const out = diag.generateDiagnosticBundle({
      category: 'bug',
      summary: `Auth failed using ${fakeKey} for dev@example.org under ${os.homedir()}/secret`,
      recentErrors: [`Bearer ${fakePat}`],
      settings: { apiKey: fakeKey, theme: 'dark' },
    });
    const serialized = JSON.stringify(out);
    assert.strictEqual(serialized.includes(fakeKey), false);
    assert.strictEqual(serialized.includes(fakePat), false);
    assert.strictEqual(serialized.includes('dev@example.org'), false);
    assert.strictEqual(serialized.includes(os.homedir()), false);
    assert.ok(out.bundleId.startsWith('diag-'));
  });

  await test('app-system preventSleep & keepInTray toggle cleanly', () => {
    const on = appSys.setPreventSleep(true);
    assert.strictEqual(on.enabled, true);
    const off = appSys.setPreventSleep(false);
    assert.strictEqual(off.enabled, false);
    const tray = appSys.setKeepInTray(true);
    assert.strictEqual(tray.keepInTray, true);
  });

  await test('updater supports prerelease channel, Linux AppImage atomic swap, and 4h scheduler', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-up-m3-'));
    let baseUrl = '';
    const srv = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify([
        {
          tag_name: 'v1.3.0-rc.1',
          prerelease: true,
          assets: [
            { name: 'AkronCode-1.3.0-rc.1-x86_64.AppImage', size: 100, browser_download_url: `${baseUrl}/a.AppImage` },
          ],
        },
        {
          tag_name: 'v1.2.0',
          prerelease: false,
          assets: [],
        },
      ]));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${srv.address().port}`;
    try {
      const pre = await updater.checkForUpdates({
        currentVersion: '1.1.0',
        platform: 'linux',
        arch: 'x64',
        channel: 'prerelease',
        feedUrl: `${baseUrl}/releases/latest`,
      });
      assert.strictEqual(pre.ok, true);
      assert.strictEqual(pre.latestVersion, '1.3.0-rc.1');
      assert.strictEqual(pre.updateAvailable, true);
      assert.strictEqual(pre.asset.name, 'AkronCode-1.3.0-rc.1-x86_64.AppImage');

      const staged = path.join(tmp, 'staged.AppImage');
      const liveImg = path.join(tmp, 'AkronCode.AppImage');
      fs.writeFileSync(staged, 'NEW_APPIMAGE_BYTES');
      fs.writeFileSync(liveImg, 'OLD_APPIMAGE_BYTES');
      const sw = updater.applyLinuxAppImageSwap(staged, liveImg);
      assert.strictEqual(sw.ok, true);
      assert.strictEqual(sw.swapped, true);
      assert.strictEqual(fs.readFileSync(liveImg, 'utf8'), 'NEW_APPIMAGE_BYTES');

      let notified = null;
      const sched = updater.createUpdateScheduler({
        checkFn: async () => pre,
        onUpdateAvailable: (r) => { notified = r.latestVersion; },
      });
      await sched.runOnce();
      assert.strictEqual(notified, '1.3.0-rc.1');
      sched.stop();
    } finally {
      srv.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Glossy Emerald Carbon CSS & UI components contain expected dark/light surface rules & testids', () => {
    const root = path.resolve(__dirname, '..');
    const css = fs.readFileSync(path.join(root, 'src', 'styles', 'emerald-carbon.css'), 'utf8');
    assert.ok(css.includes('[data-surface="emerald-carbon"]'));
    assert.ok(css.includes('[data-theme="light"]'));
    assert.ok(css.includes('repeating-linear-gradient(45deg'));
    assert.ok(css.includes('.pulse-4dot'));
    const projCss = fs.readFileSync(path.join(root, 'src', 'components', 'sidebar', 'ProjectsSidebar.jsx'), 'utf8');
    assert.ok(projCss.includes('proj-hover-card'));
    assert.ok(projCss.includes('pulse-4dot'));
  });

  console.log(`\nSummary: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
})();
