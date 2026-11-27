'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');
const { pathToFileURL } = require('url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('20x Atom-by-Atom Production Verification Suite (v1.6.0)', async (t) => {
  const computer = require('../electron/computer');
  const editGuard = require('../electron/ide/edit-guard');
  const webSearchMod = require('../electron/tools/web-search');
  const buildBrowserExecs = require('../electron/tools/browser-executors');
  const chromeMod = require('../electron/chrome');
  const debugLogger = require('../electron/debug-logger');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-20x-v160-'));
  const dbgRoot = path.join(tmpRoot, 'autobot-dbg');
  const prevBaseDir = debugLogger.getBaseDir();
  debugLogger.setBaseDir(dbgRoot);

  // Local loopback test servers for WebSearch domain/fetch checks & Developer Auto-Report collector
  const collectedReports = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/collect' && req.method === 'POST') {
        try { collectedReports.push(JSON.parse(body)); } catch (_) {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, received: collectedReports.length }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>Hello collector</body></html>');
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const srvPort = srv.address().port;

  try {
    // Run 20 iterations end-to-end across core atoms
    for (let iter = 1; iter <= 20; iter++) {
      // Atom 1: R1 — computer.js execFile defined + sanitizeScreenshotDir + zoom/appScreenshot contract
      const compSrc = fs.readFileSync(path.join(ROOT, 'electron/computer.js'), 'utf8');
      assert.ok(/\bconst\s*\{[^}]*\bexecFile\b[^}]*\}\s*=\s*require\(['"]child_process['"]\)/.test(compSrc), `iter ${iter}: computer.js must import execFile`);
      assert.ok(typeof computer.screenshot === 'function' && typeof computer.zoom === 'function' && typeof computer.appScreenshot === 'function');
      assert.ok(!compSrc.includes('/usr/sbin/screencapture -x -o -l ${target.windowId}'), `iter ${iter}: appScreenshot must use execFileP, not string shell exec`);

      // Atom 2: R2 — edit-guard .mjs & ENOTDIR resilience + ShadowCheck recursive scan
      const sandboxDir = path.join(tmpRoot, `iter-${iter}`);
      fs.mkdirSync(sandboxDir, { recursive: true });
      const validMjs = path.join(sandboxDir, 'good.mjs');
      const brokenMjs = path.join(sandboxDir, 'bad.mjs');
      const validJs = path.join(sandboxDir, 'good.js');
      const brokenJs = path.join(sandboxDir, 'bad.js');

      fs.writeFileSync(validMjs, `export const iter = ${iter};\nexport default function ok() { return iter; }\n`);
      fs.writeFileSync(brokenMjs, `export const broken = ;\n`);
      fs.writeFileSync(validJs, `module.exports = { iter: ${iter} };\n`);
      fs.writeFileSync(brokenJs, `function bad( { return 1; }\n`);

      // Simulate broken/asar ESBUILD_BINARY_PATH on odd iterations to prove ENOTDIR never emits false syntax error
      const prevEsbuild = process.env.ESBUILD_BINARY_PATH;
      if (iter % 2 === 1) process.env.ESBUILD_BINARY_PATH = '/nonexistent/app.asar/node_modules/@esbuild/fake/bin/esbuild';
      try {
        assert.strictEqual(editGuard.collectPostEditDiagnostics(validMjs, sandboxDir), '', `iter ${iter}: valid .mjs must pass cleanly even under app.asar env`);
        assert.ok(/\[Syntax error/i.test(editGuard.collectPostEditDiagnostics(brokenMjs, sandboxDir)), `iter ${iter}: broken .mjs must report Syntax error`);
        assert.strictEqual(editGuard.collectPostEditDiagnostics(validJs, sandboxDir), '', `iter ${iter}: valid .js must pass cleanly`);
        assert.ok(/\[Syntax error/i.test(editGuard.collectPostEditDiagnostics(brokenJs, sandboxDir)), `iter ${iter}: broken .js must report Syntax error`);
      } finally {
        if (prevEsbuild === undefined) delete process.env.ESBUILD_BINARY_PATH;
        else process.env.ESBUILD_BINARY_PATH = prevEsbuild;
      }

      fs.unlinkSync(brokenMjs);
      fs.unlinkSync(brokenJs);
      const shadowOk = await editGuard.runShadowCheck(sandboxDir);
      assert.strictEqual(shadowOk.ok, true, `iter ${iter}: ShadowCheck must pass on clean dir: ${shadowOk.summary}`);
      assert.ok(/Checked \d+ files?/.test(shadowOk.summary), `iter ${iter}: ShadowCheck must report checked file count: ${shadowOk.summary}`);

      // Atom 3: WebSearch query normalization, N18 domain filter order & WebFetch SSRF guard
      assert.strictEqual(webSearchMod.extractCoreSearchQuery('what is the capital of france?').toLowerCase(), 'capital of france');
      const ranked = webSearchMod.rankAndFilterHits([
        { title: 'France', url: 'https://en.wikipedia.org/wiki/France', snippet: 'Capital Paris of France' },
        { title: 'Gdansk weather', url: 'https://accuweather.com/pl', snippet: 'Polska pogoda' },
      ], 'capital of france', { minScore: 0.3 });
      assert.strictEqual(ranked.length, 1);
      assert.ok(ranked[0].url.includes('wikipedia.org'));

      const ssrfBlocked = await webSearchMod.webFetch({ url: `http://127.0.0.1:${srvPort}/collect` });
      assert.ok(/SSRF blocked|Error fetching/i.test(ssrfBlocked), `iter ${iter}: private IP must be blocked`);

      // Atom 4: ext_browser screenshot (`out.image`) & mcp__chrome__* fallback + chrome.js timeout/discovery
      assert.ok(typeof chromeMod.discoverDevToolsActivePort === 'function');
      const execs = buildBrowserExecs({ truncate: (s) => s });
      assert.ok(typeof execs.chrome_list_tabs === 'function' && typeof execs.chrome_screenshot === 'function');
      const toolsSrc = fs.readFileSync(path.join(ROOT, 'electron/tools.js'), 'utf8');
      assert.ok(toolsSrc.includes('out.image'), `iter ${iter}: ext_browser screenshot must accept out.image`);

      // Atom 5: ax_find bounded BFS + self-window DOM fallback + N25 .autobot/.gitignore
      assert.ok(!compSrc.includes('win.entireContents()'), `iter ${iter}: N19 unbounded entireContents must stay removed`);
      assert.ok(compSrc.includes('axFindInAkronWindows'), `iter ${iter}: axFindInAkronWindows helper must exist`);
      const dotAutobot = path.join(sandboxDir, '.autobot');
      fs.mkdirSync(dotAutobot, { recursive: true });
      debugLogger.ensureWorkspaceGitignore(sandboxDir);
      assert.ok(fs.existsSync(path.join(dotAutobot, '.gitignore')), `iter ${iter}: .autobot/.gitignore must be created`);

      // Atom 6: Debug Logger scrubbing + opt-in autoSend + sendReportNow collector delivery
      const fakeSecret = 'sk-' + 'test-secret-' + 'A1b2C3d4E5f6G7h8I9j0';
      const entry = debugLogger.record('warn', 'audit', `iter_${iter}`, `User ${os.homedir()}/secret token Bearer xyz123456789 email test@example.com key ${fakeSecret}`);
      assert.ok(entry && !JSON.stringify(entry).includes(fakeSecret), `iter ${iter}: secret must be scrubbed`);
      assert.ok(!JSON.stringify(entry).includes('test@example.com'), `iter ${iter}: email must be scrubbed`);

      if (iter === 1 || iter === 20) {
        debugLogger.setConfig({ autoSend: true, endpointUrl: `http://127.0.0.1:${srvPort}/collect` });
        const rep = await debugLogger.sendReportNow({ category: 'selftest', summary: `Atom 20x iter ${iter} with ${fakeSecret}` });
        assert.strictEqual(rep.ok, true);
        assert.strictEqual(rep.delivered, true);
        assert.ok(fs.existsSync(rep.savedPath));
        const latest = collectedReports[collectedReports.length - 1];
        assert.ok(latest && !JSON.stringify(latest).includes(fakeSecret), 'delivered report must be secret-scrubbed');
      }

      // Atom 7: Tutorial presets & live WebSearch probe (once on iter 1 & iter 20 to avoid flooding external APIs 20x)
      if (iter === 1 || iter === 20) {
        const presets = await import(pathToFileURL(path.join(ROOT, 'src/utils/tutorialPresets.js')).href);
        const s1 = presets.applyBeginnerPreset('auto', {});
        const s2 = presets.applyBeginnerPreset('orchestrator', s1);
        const s3 = presets.applyBeginnerPreset('swarm', s2);
        const s4 = presets.applyBeginnerPreset('direct', s3);
        assert.strictEqual(s1.swarmEnabled, false);
        assert.strictEqual(s2.orchestrator.enabled, true);
        assert.strictEqual(s3.swarmEnabled, true);
        assert.strictEqual(s4.provider.routingMode, 'direct');

        const wsLive = await webSearchMod.webSearch({ query: 'what is the capital of france' });
        assert.ok(wsLive !== '(no results)' && /paris|france/i.test(wsLive), `iter ${iter}: WebSearch returned: ${wsLive}`);
      }
    }

    // Verify N23 retention janitor cleans excess old runtime files cleanly
    const agentsDir = path.join(dbgRoot, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const oldTime = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    for (let i = 0; i < 160; i++) {
      const f = path.join(agentsDir, `agent-${i}.json`);
      fs.writeFileSync(f, '{}');
      fs.utimesSync(f, oldTime, oldTime);
    }
    const pruned = debugLogger.pruneRuntimeDirs({ maxFilesPerDir: 50, maxAgeMs: 7 * 24 * 60 * 60 * 1000 });
    assert.strictEqual(pruned.ok, true);
    assert.ok(pruned.removed >= 100, `expected >=100 pruned files, got ${pruned.removed}`);
  } finally {
    debugLogger.setBaseDir(prevBaseDir);
    await new Promise((r) => srv.close(r));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
