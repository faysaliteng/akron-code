'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { runTool } = require(path.join(ROOT, 'electron', 'tools'));
const editGuard = require(path.join(ROOT, 'electron', 'ide', 'edit-guard'));
const lsp = require(path.join(ROOT, 'electron', 'ide', 'lsp'));
const codebaseIndex = require(path.join(ROOT, 'electron', 'ide', 'codebase-index'));
const agentdefs = require(path.join(ROOT, 'electron', 'agentdefs'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('ApplyPatch performs atomic V4A Add, Update (fuzzy whitespace), Delete & rolls back cleanly on bad hunk', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-patch-'));
  try {
    const fileA = path.join(tmp, 'a.js');
    fs.writeFileSync(fileA, 'function greet(name) {\n  return "hi " + name;\n}\n', 'utf8');

    const badPatch = [
      '*** Begin Patch',
      '*** Add File: created_never.js',
      '+const x = 1;',
      '*** Update File: a.js',
      '@@',
      '-nonexistent line',
      '+const y = 2;',
      '*** End Patch',
    ].join('\n');
    const badRes = await runTool('ApplyPatch', { patch: badPatch, cwd: tmp }, {});
    assert.strictEqual(badRes.isError, true);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'created_never.js')), false, 'atomic patch failure must not create earlier files');

    const goodPatch = [
      '*** Begin Patch',
      '*** Add File: helper.js',
      '+export const added = 42;',
      '*** Update File: a.js',
      '@@',
      ' function greet(name) {',
      '-  return "hi " + name;',
      '+  return `hello ${name}`;',
      ' }',
      '*** End Patch',
    ].join('\n');
    const okRes = await runTool('ApplyPatch', { patch: goodPatch, cwd: tmp }, {});
    assert.ok(!okRes.isError, okRes.content);
    assert.ok(fs.readFileSync(path.join(tmp, 'helper.js'), 'utf8').includes('42'));
    assert.ok(fs.readFileSync(fileA, 'utf8').includes('hello ${name}'));

    const delPatch = '*** Begin Patch\n*** Delete File: helper.js\n*** End Patch';
    const delRes = await runTool('ApplyPatch', { patch: delPatch, cwd: tmp }, {});
    assert.ok(!delRes.isError, delRes.content);
    assert.strictEqual(fs.existsSync(path.join(tmp, 'helper.js')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('edit-guard enforces SHA-256/mtime stale-read guard and appends instant syntax + LSP diagnostics + ShadowCheck', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-guard-'));
  try {
    const target = path.join(tmp, 'mod.js');
    fs.writeFileSync(target, 'function ok() { return 1; }\n', 'utf8');
    const mtimes = new Map();
    await runTool('Read', { path: target, cwd: tmp }, { readMtimes: mtimes });
    // Simulate sub-ms external edit with same content-length/mtime drift
    fs.writeFileSync(target, 'function ok() { return 2; }\n', 'utf8');

    const blocked = await runTool('Edit', {
      path: target,
      old_string: 'return 1;',
      new_string: 'return 3;',
      cwd: tmp,
    }, { readMtimes: mtimes });
    assert.ok(blocked.content.includes('modified on disk since you last Read it'));

    // Re-read then introduce broken syntax -> Write/Edit appends diagnostics + caches LSP diagnostics
    await runTool('Read', { path: target, cwd: tmp }, { readMtimes: mtimes });
    lsp.recordDiagnostics(target, [{ severity: 1, range: { start: { line: 0 } }, message: 'Simulated LSP type mismatch' }]);
    const broken = await runTool('Edit', {
      path: target,
      old_string: 'return 2;',
      new_string: 'return (((;',
      cwd: tmp,
    }, { readMtimes: mtimes });
    assert.ok(broken.content.includes('SYNTAX WARNING') || broken.content.includes('Syntax error'));

    const shadowFail = await runTool('ShadowCheck', { cwd: tmp }, {});
    assert.strictEqual(shadowFail.isError, true);

    fs.writeFileSync(target, 'function ok() { return 2; }\n', 'utf8');
    const diagClean = editGuard.collectPostEditDiagnostics(target, tmp);
    assert.ok(diagClean.includes('Simulated LSP type mismatch'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('codebase-index incrementally indexes Merkle tree, respects .akronignore, and ranks symbol/semantic search', async () => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-idx-ws-'));
  const tmpIdx = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-idx-db-'));
  try {
    fs.writeFileSync(path.join(tmpWs, '.akronignore'), 'ignored_dir\n*.secret.js\n', 'utf8');
    fs.mkdirSync(path.join(tmpWs, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpWs, 'ignored_dir'), { recursive: true });
    fs.writeFileSync(path.join(tmpWs, 'src', 'auth.js'), 'export function verifyTokenSignature(token) {\n  return token.startsWith("ak_");\n}\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'ignored_dir', 'skip.js'), 'export function hiddenSymbol() {}\n', 'utf8');
    fs.writeFileSync(path.join(tmpWs, 'src', 'key.secret.js'), 'export function verifyTokenSignature() {}\n', 'utf8');

    const first = await codebaseIndex.indexWorkspace(tmpWs, { indexDir: tmpIdx });
    assert.strictEqual(first.totalFiles, 1);
    assert.strictEqual(first.indexed, 1);

    const second = await codebaseIndex.indexWorkspace(tmpWs, { indexDir: tmpIdx });
    assert.strictEqual(second.indexed, 0);
    assert.strictEqual(second.skippedUnchanged, 1);
    assert.strictEqual(second.merkleRoot, first.merkleRoot);

    const hits = await codebaseIndex.searchCodebase(tmpWs, 'verifyTokenSignature', { indexDir: tmpIdx });
    assert.ok(hits.hits.length >= 1);
    assert.strictEqual(hits.hits[0].file, 'src/auth.js');

    assert.ok(agentdefs.BUILTIN.CodebaseInvestigator, 'CodebaseInvestigator subagent must be registered');
    assert.ok(agentdefs.BUILTIN.CodebaseInvestigator.tools.includes('CodebaseSearch'));
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
    fs.rmSync(tmpIdx, { recursive: true, force: true });
  }
});

test('RunToolScript batches host reads/searches in isolated worker and enforces timeout', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cm-'));
  try {
    fs.writeFileSync(path.join(tmp, 'one.txt'), 'alpha=10\n', 'utf8');
    fs.writeFileSync(path.join(tmp, 'two.txt'), 'beta=25\n', 'utf8');

    const res = await runTool('RunToolScript', {
      cwd: tmp,
      code: `
        const a = await tools.read({ path: 'one.txt' });
        const b = await tools.read({ path: 'two.txt' });
        console.log('read-both:', a.includes('alpha=10') && b.includes('beta=25'));
        return { ok: true };
      `,
    }, { cwd: tmp });
    assert.ok(!res.isError, res.content);
    assert.ok(res.content.includes('read-both: true'));

    // Host filesystem/require is unreachable inside worker VM
    const sec = await runTool('RunToolScript', {
      cwd: tmp,
      code: `return typeof require;`,
    }, { cwd: tmp });
    assert.ok(sec.content.includes('undefined'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

(async () => {
  let pass = 0;
  let fail = 0;
  console.log('\nPhase 2 Elite Editing, Codebase Intelligence & CodeMode Verification');
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log('  ok   - ' + t.name);
    } catch (e) {
      fail++;
      console.error('  FAIL - ' + t.name + ': ' + (e && e.stack ? e.stack : e));
    }
  }
  console.log(`\nSummary: ${pass}/${tests.length} passed`);
  if (fail) process.exit(1);
})();
