'use strict';

const assert = require('assert');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const sessionDb = require(path.join(ROOT, 'electron', 'session-db'));
const skillLearner = require(path.join(ROOT, 'electron', 'skill-learner'));
const osSandbox = require(path.join(ROOT, 'electron', 'os-sandbox'));
const commands = require(path.join(ROOT, 'electron', 'commands'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('session-db migrates localStorage chats, persists atomically, reloads from disk, and ranks full-text search', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-db-'));
  const dbPath = path.join(tmpDir, 'akron.db');
  try {
    await sessionDb.initSessionDb({ dbPath });
    const convs = [
      {
        id: 'conv-alpha',
        title: 'Kubernetes Canary Rollout',
        cwd: '/tmp/ws1',
        updatedAt: 1000,
        messages: [
          { role: 'user', content: 'How do we configure weighted traffic splitting with Istio VirtualService?' },
          { role: 'assistant', content: 'Define http route weights in VirtualService for v1 and canary v2.' },
        ],
      },
      {
        id: 'conv-beta',
        title: 'Electron ASAR Packaging',
        cwd: '/tmp/ws2',
        updatedAt: 2000,
        messages: [
          { role: 'user', content: 'Why did sql-wasm.wasm fail inside app.asar?' },
          { role: 'assistant', content: 'Add sql.js wasm to asarUnpack and rewrite locateFile to app.asar.unpacked.' },
        ],
      },
    ];

    const mig = await sessionDb.migrateFromLocalStorage(convs, { dbPath });
    assert.strictEqual(mig.ok, true);
    assert.strictEqual(mig.migrated, 2);

    // Close DB completely and reopen from disk to verify atomic persistence
    sessionDb.closeSessionDb(dbPath);

    const listed = await sessionDb.listConversations({ dbPath });
    assert.strictEqual(listed.length, 2);
    assert.strictEqual(listed[0].id, 'conv-beta');

    const loaded = await sessionDb.getConversation('conv-alpha', { dbPath });
    assert.strictEqual(loaded.title, 'Kubernetes Canary Rollout');

    const hits = await sessionDb.searchConversationsDb('VirtualService canary', { dbPath });
    assert.ok(hits.length >= 1, 'Expected FTS hit for VirtualService canary');
    assert.strictEqual(hits[0].convId, 'conv-alpha');

    await sessionDb.deleteConversation('conv-alpha', { dbPath });
    const afterDel = await sessionDb.listConversations({ dbPath });
    assert.strictEqual(afterDel.length, 1);
  } finally {
    sessionDb.closeSessionDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('skill-learner deduplicates categorized memory and ExtractSkill + /learn persist reusable SKILL.md', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-learn-'));
  const memFile = path.join(tmp, 'memory.json');
  const skillsDir = path.join(tmp, 'user-skills');
  const projDir = path.join(tmp, 'project');
  fs.mkdirSync(projDir, { recursive: true });
  try {
    const m1 = skillLearner.addStructuredMemory({
      content: 'Always unpack sql-wasm.wasm in electron-builder asarUnpack config.',
      category: 'build-test',
      scope: 'project',
      cwd: projDir,
      memoryFile: memFile,
    });
    assert.strictEqual(m1.ok, true);
    assert.strictEqual(m1.deduplicated, false);
    assert.ok(fs.existsSync(m1.projectMemoryPath), 'project .akron/MEMORY.md created');

    const m2 = skillLearner.addStructuredMemory({
      content: 'Always unpack sql-wasm.wasm inside electron-builder asarUnpack config',
      category: 'build-test',
      memoryFile: memFile,
    });
    assert.strictEqual(m2.ok, true);
    assert.strictEqual(m2.deduplicated, true);
    assert.strictEqual(m2.total, 1, 'near-duplicate memory entry must be deduplicated');

    const sk = skillLearner.extractSkillToDisk({
      name: 'sqlite-asar-unpack',
      description: 'Package pure-WASM sql.js reliably in Electron ASAR builds',
      triggers: ['sql-wasm.wasm', 'asarUnpack'],
      steps: ['Add sql.js/dist/*.wasm to asarUnpack', 'Rewrite app.asar -> app.asar.unpacked in locateFile'],
      pitfalls: ['Never require better-sqlite3 native ABI without rebuild'],
      verification: 'node test/phase3-db-memory-sandbox.test.js',
      scope: 'user',
      userSkillsDir: skillsDir,
    });
    assert.strictEqual(sk.ok, true);
    assert.ok(fs.existsSync(sk.file));
    const txt = fs.readFileSync(sk.file, 'utf8');
    assert.ok(txt.includes('name: sqlite-asar-unpack') && txt.includes('## Pitfalls & Gotchas'));

    const learnCmd = commands.resolve('learn', projDir);
    assert.ok(learnCmd && learnCmd.body.includes('ExtractSkill'), '/learn must expand to ExtractSkill workflow');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('os-sandbox catches wrapped/chained bypasses and enforces workspace boundaries', () => {
  const chained = osSandbox.checkCanonicalCommand('echo ok && sh -c "cat ~/.ssh/id_ed25519"', {
    profile: 'workspace-write',
    protectCredentials: true,
  });
  assert.strictEqual(chained.ok, false, 'Wrapped sh -c credential read must be caught');

  const rootRm = osSandbox.checkCanonicalCommand('env FOO=1 rm -rf /', { profile: 'workspace-write' });
  assert.strictEqual(rootRm.ok, false, 'Wrapped rm -rf / must be caught');

  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sb-ws-'));
  const outsideFile = path.join(os.tmpdir(), 'akron-sb-outside-' + Date.now() + '.txt');
  try {
    const caps = osSandbox.detectCapabilities();
    if (process.platform === 'darwin' && caps.available) {
      const insideFile = path.join(tmpWs, 'allowed.txt');
      const okWrap = osSandbox.wrapWithProfile(`echo ok > ${JSON.stringify(insideFile)}`, {
        cwd: tmpWs,
        profile: 'workspace-write',
      });
      execFileSync(okWrap.file, okWrap.args, { cwd: tmpWs, stdio: 'pipe' });
      assert.ok(fs.existsSync(insideFile), 'Write inside workspace must succeed under seatbelt');

      // Writing outside workspace (specifically to a non-tmp dir like os.homedir()/.Trash or TMPDIR sibling if outside /tmp)
      const homeTarget = path.join(os.homedir(), '.akron-sandbox-deny-probe-' + Date.now());
      const badWrap = osSandbox.wrapWithProfile(`touch ${JSON.stringify(homeTarget)}`, {
        cwd: tmpWs,
        profile: 'workspace-write',
      });
      let blocked = false;
      try {
        execFileSync(badWrap.file, badWrap.args, { cwd: tmpWs, stdio: 'pipe' });
      } catch (_) {
        blocked = true;
      }
      if (fs.existsSync(homeTarget)) {
        try { fs.unlinkSync(homeTarget); } catch (_) {}
      }
      assert.strictEqual(blocked, true, 'Seatbelt must block writes outside workspace + ~/.autobot');
    } else {
      const wrapped = osSandbox.wrapWithProfile('echo ok', { cwd: tmpWs, profile: 'read-only' });
      assert.ok(wrapped.file && Array.isArray(wrapped.args));
    }
  } finally {
    fs.rmSync(tmpWs, { recursive: true, force: true });
    if (fs.existsSync(outsideFile)) try { fs.unlinkSync(outsideFile); } catch (_) {}
  }
});

(async () => {
  let pass = 0;
  let fail = 0;
  console.log('\nPhase 3 SQLite WAL/FTS, Auto-Memory & /learn, OS Sandbox Verification');
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
