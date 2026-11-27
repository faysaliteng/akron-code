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

  await test('akron CLI doctor --json and -p --json run cleanly', () => {
    const cli = path.join(ROOT, 'bin', 'akron.js');
    const doc = spawnSync(process.execPath, [cli, 'doctor', '--json'], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(doc.status, 0, doc.stderr || doc.stdout);
    const parsedDoc = JSON.parse(doc.stdout);
    assert.strictEqual(parsedDoc.ok, true);
    assert.ok(parsedDoc.checks.some((c) => c.name === 'brand-seal' && c.ok));

    const headless = spawnSync(process.execPath, [cli, '-p', 'inspect workspace', '--json', '--cwd', ROOT], { cwd: ROOT, encoding: 'utf8' });
    assert.strictEqual(headless.status, 0, headless.stderr || headless.stdout);
    const parsedHeadless = JSON.parse(headless.stdout);
    assert.strictEqual(parsedHeadless.ok, true);
    assert.strictEqual(parsedHeadless.mode, 'headless');
    assert.ok(parsedHeadless.toolCount > 100);
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
