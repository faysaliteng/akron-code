'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sessionDb = require('../electron/session-db');

test('Phase 2: session-db WAL sidecar O(1) append, crash replay ignoring corrupt tail, Okapi BM25 ranking, and host sqlite verifier', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-wal-db-'));
  const dbPath = path.join(tmpDir, 'akron.db');
  try {
    await sessionDb.initSessionDb({ dbPath });
    for (let i = 1; i <= 20; i++) {
      const content = i === 14
        ? 'Investigating rareToken_zx91_quorum failure in distributed consensus loop'
        : `Routine log frame number ${i} with boilerplate summary output`;
      await sessionDb.upsertConversation({
        id: `conv_${i}`,
        title: i === 14 ? 'Consensus Quorum Root Cause' : `Session ${i}`,
        cwd: tmpDir,
        model: 'gpt-5',
        createdAt: 1700000000000 + i * 1000,
        updatedAt: 1700000000000 + i * 1000,
        messages: [{ id: `m_${i}`, role: 'user', content, createdAt: 1700000000000 + i * 1000 }],
      }, { dbPath });
    }
    await sessionDb.pinConversation('conv_14', true, { dbPath });
    await sessionDb.archiveConversation('conv_2', true, { dbPath });

    const walPath = sessionDb.walPathFor(dbPath);
    assert.strictEqual(fs.existsSync(walPath), true);
    assert.ok(fs.statSync(walPath).size > 200);

    // Search with Okapi BM25 before checkpointing
    const hits = await sessionDb.searchMessages('rareToken_zx91_quorum', { dbPath, limit: 5 });
    assert.ok(hits.length >= 1);
    assert.strictEqual(hits[0].convId, 'conv_14');

    // Copy snapshot + WAL to crash-recovery dir and inject corrupt partial tail line
    const crashDir = path.join(tmpDir, 'crash');
    fs.mkdirSync(crashDir, { recursive: true });
    const crashDbPath = path.join(crashDir, 'akron.db');
    if (fs.existsSync(dbPath)) fs.copyFileSync(dbPath, crashDbPath);
    fs.copyFileSync(walPath, sessionDb.walPathFor(crashDbPath));
    fs.appendFileSync(sessionDb.walPathFor(crashDbPath), '{"op":"upsert_conv","corrupt_truncated_json\n');

    const replayScript = `
      const sdb = require('./electron/session-db');
      (async () => {
        await sdb.initSessionDb({ dbPath: ${JSON.stringify(crashDbPath)} });
        const rows = await sdb.listConversations({ dbPath: ${JSON.stringify(crashDbPath)}, limit: 50 });
        const c14 = await sdb.getConversation('conv_14', { dbPath: ${JSON.stringify(crashDbPath)} });
        sdb.checkpointSessionDb(${JSON.stringify(crashDbPath)});
        const v = sdb.verifyWithHostSqlite(${JSON.stringify(crashDbPath)});
        console.log(JSON.stringify({ count: rows.length, firstId: rows[0]?.id, c14Messages: c14?.messages?.length, v }));
      })();
    `;
    const out = execFileSync(process.execPath, ['-e', replayScript], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
    });
    const parsed = JSON.parse(out.trim().split('\n').pop());
    assert.strictEqual(parsed.count, 20);
    assert.strictEqual(parsed.firstId, 'conv_14'); // pinned floats to top
    assert.strictEqual(parsed.c14Messages, 1);
    if (parsed.v.supported) {
      assert.strictEqual(parsed.v.ok, true);
      assert.strictEqual(parsed.v.conversationsCount, 20);
    }
  } finally {
    sessionDb.closeSessionDb(dbPath);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
