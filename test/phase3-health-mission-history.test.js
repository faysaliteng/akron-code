'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const health = require('../electron/session-health');
const digest = require('../electron/session-digest');
const sessionIndex = require('../electron/session-index');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ok   - ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.error('  FAIL - ' + name + ': ' + (e && e.stack ? e.stack : e));
  }
}

function writeTurnJsonl(root, convId, turnId, events) {
  const dir = path.join(root, convId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${turnId}.jsonl`),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    'utf8'
  );
}

(async () => {
  console.log('\nPhase 3 Session Health, Trajectory Digest & SQLite Ask History Verification');

  await test('zero-token health detector catches retry loop (>=3), error spiral (>=50% rolling 10) & permission denial cluster (>=3)', () => {
    const healthy = health.scoreEventsHealth([
      { type: 'tool', id: '1', name: 'Read', args: { file_path: 'a.js' } },
      { type: 'toolResult', id: '1', isError: false, result: 'ok' },
    ], 'c_ok');
    assert.strictEqual(healthy.status, 'ok');
    assert.ok(healthy.quickReplies.every((q) => q.split(/\s+/).filter(Boolean).length <= 8));

    const retryEvents = [];
    for (let i = 0; i < 3; i++) {
      retryEvents.push({ type: 'tool', id: 'r' + i, name: 'Edit', args: { file_path: 'app.js', old_string: 'foo' } });
      retryEvents.push({ type: 'toolResult', id: 'r' + i, isError: true, result: 'old_string not found in app.js' });
    }
    const retryRes = health.scoreEventsHealth(retryEvents, 'c_retry');
    assert.strictEqual(retryRes.status, 'bad');
    assert.ok(retryRes.flags.some((f) => f.kind === 'retry_loop'));
    assert.ok(retryRes.unstickDraft.includes('Edit'));
    assert.ok(retryRes.quickReplies.every((q) => q.split(/\s+/).filter(Boolean).length <= 8));

    const spiralEvents = [];
    for (let i = 0; i < 10; i++) {
      spiralEvents.push({ type: 'tool', id: 's' + i, name: 'Bash', args: { command: 'cmd ' + i } });
      spiralEvents.push({ type: 'toolResult', id: 's' + i, isError: i < 5, result: i < 5 ? 'command failed' : 'ok' });
    }
    const spiralRes = health.scoreEventsHealth(spiralEvents, 'c_spiral');
    assert.strictEqual(spiralRes.status, 'bad');
    assert.ok(spiralRes.flags.some((f) => f.kind === 'error_spiral'));

    const denyEvents = [
      { type: 'notice', text: 'Blocked: Bash — Denied by rule' },
      { type: 'permissionCleared', reason: 'denied' },
      { type: 'toolResult', id: 'd3', isError: true, result: 'permission denied for billing' },
    ];
    const denyRes = health.scoreEventsHealth(denyEvents, 'c_deny');
    assert.strictEqual(denyRes.status, 'bad');
    assert.ok(denyRes.flags.some((f) => f.kind === 'permission_denial_cluster'));
  });

  await test('trajectory digest creates token-bounded [U stepId]/[K stepId] anchors and SQLite index supports Ask History deep links', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-p3-'));
    const sessionsRoot = path.join(tmp, 'sessions');
    const dbPath = path.join(tmp, 'session-index.db');

    try {
      writeTurnJsonl(sessionsRoot, 'conv_auth_fix', 't1000', [
        { type: 'turn', title: 'Fix OAuth PKCE callback', prompt: 'Fix the PKCE state mismatch in electron/oauth.js', t: 1000 },
        { type: 'tool', name: 'Read', args: { file_path: 'electron/oauth.js' }, t: 1010 },
        { type: 'text', text: 'Found PKCE verifier mismatch in handleCallback and patched state cookie normalization.', t: 1020 },
      ]);

      const d = digest.buildTrajectoryDigest({ convId: 'conv_auth_fix', sessionsRoot, maxTokens: 200 });
      assert.ok(d.digest.includes('[U t1000:s0]'));
      assert.ok(d.digest.includes('[K t1000:s1]'));

      const sync = await sessionIndex.syncSessionIndex({ dbPath, sessionsRoot });
      assert.strictEqual(sync.ok, true);
      assert.strictEqual(sync.indexedFiles, 1);

      const search = await sessionIndex.searchHistory({ query: 'PKCE verifier', dbPath, sessionsRoot });
      assert.ok(search.hits.length >= 1);
      assert.ok(search.hits[0].deepLink.startsWith('session://conv_auth_fix?focus=t1000:s'));

      const asked = await sessionIndex.askAcrossHistory({
        question: 'How was PKCE callback fixed?',
        dbPath,
        sessionsRoot,
        chatFn: async ({ messages }) => {
          assert.ok(messages[0].content.includes('session://conv_auth_fix?focus='));
          return { content: 'Patched verifier normalization in [OAuth callback fix](session://conv_auth_fix?focus=t1000:s2).' };
        },
      });
      assert.strictEqual(asked.ok, true);
      assert.ok(asked.answer.includes('session://conv_auth_fix?focus=t1000:s2'));
      assert.ok(asked.citations.length >= 1);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
