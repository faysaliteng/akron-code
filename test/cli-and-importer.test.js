'use strict';
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const importer = require('../electron/importer');
const ROOT = path.resolve(__dirname, '..');

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
  console.log('\n=== CLI & 1-CLICK READ-ONLY IMPORTER TESTS ===');

  await test('importer discovers Cursor, Claude Code & VS Code configs and preserves source files byte-for-byte', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-imp-'));
    try {
      const home = path.join(tmp, 'home');
      const cwd = path.join(tmp, 'proj');
      const target = path.join(tmp, 'autobot-out');
      fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
      fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
      fs.mkdirSync(path.join(cwd, '.cursor', 'rules'), { recursive: true });
      fs.mkdirSync(path.join(cwd, '.claude', 'agents'), { recursive: true });
      const vsPath = path.join(tmp, 'vscode-settings.json');

      const cursorMcp = path.join(home, '.cursor', 'mcp.json');
      const cursorRules = path.join(cwd, '.cursorrules');
      const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
      const claudeJson = path.join(home, '.claude.json');
      fs.writeFileSync(cursorMcp, JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'docs-mcp'] } } }));
      fs.writeFileSync(cursorRules, 'Use TypeScript strict mode.');
      fs.writeFileSync(path.join(cwd, '.cursor', 'rules', 'security.mdc'), 'Validate all inputs.');
      fs.writeFileSync(claudeMd, 'Global user engineering rule.');
      fs.writeFileSync(claudeJson, JSON.stringify({ mcpServers: { git: { command: 'uvx', args: ['mcp-server-git'] } } }));
      fs.writeFileSync(path.join(cwd, '.claude', 'agents', 'sec.md'), '---\nname: sec\n---\nAudit everything.');
      fs.writeFileSync(vsPath, JSON.stringify({ 'editor.fontSize': 15, 'workbench.colorTheme': 'Emerald' }));

      const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
      const before = {
        cursorMcp: sha(cursorMcp),
        cursorRules: sha(cursorRules),
        claudeMd: sha(claudeMd),
        claudeJson: sha(claudeJson),
        vsPath: sha(vsPath),
      };

      const scan = importer.scanExternalConfigs({ homeDir: home, cwd, vsCodeSettingsPath: vsPath });
      assert.strictEqual(scan.ok, true);
      assert.strictEqual(scan.readOnlySource, true);
      assert.ok(scan.count >= 6, `expected >= 6 discovered items, got ${scan.count}`);

      const res = importer.importExternalConfigs({ items: scan.items, targetDir: target });
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.readOnlySourcePreserved, true);
      assert.strictEqual(res.importedCount, scan.count);

      // Verify source hashes did not change
      assert.strictEqual(sha(cursorMcp), before.cursorMcp);
      assert.strictEqual(sha(cursorRules), before.cursorRules);
      assert.strictEqual(sha(claudeMd), before.claudeMd);
      assert.strictEqual(sha(claudeJson), before.claudeJson);
      assert.strictEqual(sha(vsPath), before.vsPath);

      // Verify target outputs exist
      const importedMcp = JSON.parse(fs.readFileSync(path.join(target, 'imported-mcp.json'), 'utf8'));
      assert.ok(importedMcp.docs && importedMcp.git);
      assert.ok(fs.existsSync(path.join(target, 'imported-rules', '.cursorrules')));
      assert.ok(fs.existsSync(path.join(target, 'agents', 'sec.md')));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('akron CLI doctor --json and -p --json run cleanly', async () => {
    const http = require('http');
    const cli = path.join(ROOT, 'bin', 'akron.js');
    const doc = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(doc.status, 0, doc.stderr || doc.stdout);
    const parsedDoc = JSON.parse(doc.stdout);
    assert.strictEqual(parsedDoc.ok, true);
    assert.ok(parsedDoc.checks.some((c) => c.name === 'brand-seal' && c.ok));

    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cli-doc-'));
    const srv = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          const b = JSON.parse(raw || '{}');
          if (b.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            res.write(`data: ${JSON.stringify({ id: '1', object: 'chat.completion.chunk', model: 'mock-fast', choices: [{ index: 0, delta: { role: 'assistant', content: 'Workspace inspected.' }, finish_reason: 'stop' }] })}\n\n`);
            res.end('data: [DONE]\n\n');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id: '1', model: 'mock-fast', choices: [{ index: 0, message: { role: 'assistant', content: 'Workspace inspected.' }, finish_reason: 'stop' }] }));
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const autobotDir = path.join(tmpHome, '.autobot');
      fs.mkdirSync(autobotDir, { recursive: true });
      fs.writeFileSync(path.join(autobotDir, 'settings.json'), JSON.stringify({
        provider: {
          name: 'LocalTest',
          type: 'openai',
          baseURL: `http://127.0.0.1:${srv.address().port}/v1`,
          apiKey: 'sk-test-local',
          model: 'mock-fast',
          supportsTools: true,
        },
      }));
      const headless = await new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile(process.execPath, [cli, '-p', 'inspect workspace', '--json', '--yolo', '--cwd', ROOT], {
          cwd: ROOT,
          encoding: 'utf8',
          env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, AKRON_NO_INTERACTIVE: '1' },
        }, (err, stdout, stderr) => (err ? reject(new Error(stderr || stdout || err.message)) : resolve(stdout)));
      });
      const parsedHeadless = JSON.parse(headless);
      assert.strictEqual(parsedHeadless.ok, true);
      assert.strictEqual(parsedHeadless.mode, 'agent');
      assert.ok(parsedHeadless.toolCount > 100);
    } finally {
      srv.close();
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  await test('akron CLI review --json produces valid bundle output', () => {
    const cli = path.join(ROOT, 'bin', 'akron.js');
    const rev = spawnSync(process.execPath, [cli, 'review', '--json', '--cwd', ROOT], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(rev.status, 0, rev.stderr || rev.stdout);
    const parsed = JSON.parse(rev.stdout);
    assert.strictEqual(parsed.ok, true);
  });

  console.log(`\nSummary: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
})();
