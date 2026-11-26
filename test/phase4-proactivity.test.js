'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const pro = require('../electron/proactivity');

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

(async () => {
  console.log('\nPhase 4 Proactive 2.0 Verification');

  await test('Attention Gate parses {"review":false} to skip expensive frontier wakes cleanly', async () => {
    const res = await pro.runAttentionGate({
      task: { name: 'Check PRs', prompt: 'Check open PRs', attentionGate: true },
      contextText: '0 new PRs, CI green',
      fastProvider: { model: 'gemini-2.5-flash' },
      chatFn: async () => ({ content: '{"review": false, "reason": "No new changes"}' }),
    });
    assert.strictEqual(res.review, false);
    assert.strictEqual(res.reason, 'No new changes');
  });

  await test('SHA-256 matterKey keeps dismissed matters suppressed until material condition changes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-pro-'));
    const storePath = path.join(tmp, 'matters.json');
    try {
      const r1 = pro.upsertMatter({
        source: 'watcher',
        title: 'Build failing on main',
        summary: 'test/e2e failed at line 42',
        conditionData: 'err:42',
        impact: 'high',
        evidence: 'strong',
        storePath,
      });
      assert.strictEqual(r1.suppressed, false);

      pro.actOnMatter(r1.matter.matterKey, 'dismiss', { storePath });

      // Same condition -> stays suppressed
      const r2 = pro.upsertMatter({
        source: 'watcher',
        title: 'Build failing on main',
        summary: 'test/e2e failed at line 42',
        conditionData: 'err:42',
        storePath,
      });
      assert.strictEqual(r2.suppressed, true);
      assert.strictEqual(r2.reason, 'dismissed_unchanged');

      // Material change -> reopens!
      const r3 = pro.upsertMatter({
        source: 'watcher',
        title: 'Build failing on main',
        summary: '2 new test failures at line 99',
        conditionData: 'err:99',
        storePath,
      });
      assert.strictEqual(r3.suppressed, false);
      assert.strictEqual(r3.reopened, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Quiet Hours holds non-urgent items overnight while passing high-impact imminent deadlines', () => {
    const qh = { enabled: true, start: '22:00', end: '08:00' };
    const night = new Date('2026-11-26T23:30:00');
    const day = new Date('2026-11-26T14:00:00');

    assert.strictEqual(pro.shouldHoldForQuietHours({ impact: 'medium', imminentDeadline: false }, qh, night).hold, true);
    assert.strictEqual(pro.shouldHoldForQuietHours({ impact: 'high', imminentDeadline: false }, qh, night).hold, true);
    assert.strictEqual(pro.shouldHoldForQuietHours({ impact: 'high', imminentDeadline: true }, qh, night).hold, false);
    assert.strictEqual(pro.shouldHoldForQuietHours({ impact: 'low', imminentDeadline: false }, qh, day).hold, false);
  });

  await test('Morning Dev Brief, Weekly Retro & Suggested Automations (<=3) work cleanly', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-brief-'));
    const storePath = path.join(tmp, 'matters.json');
    try {
      const brief = await pro.generateMorningBrief({ cwd: path.join(__dirname, '..'), tasks: [], storePath });
      assert.strictEqual(brief.ok, true);
      assert.ok(brief.markdown.includes('Morning Dev Brief'));

      const retro = await pro.generateWeeklyRetro({ cwd: path.join(__dirname, '..'), tasks: [], storePath });
      assert.strictEqual(retro.ok, true);
      assert.ok(retro.markdown.includes('Weekly Engineering Retro'));

      const convs = [
        { id: 'c1', messages: [{ role: 'user', content: 'Run tests and summarize failing checks in repo' }] },
        { id: 'c2', messages: [{ role: 'user', content: 'Run tests and summarize failing checks in repo' }] },
        { id: 'c3', messages: [{ role: 'user', content: 'Audit outdated npm dependencies for security' }] },
        { id: 'c4', messages: [{ role: 'user', content: 'Audit outdated npm dependencies for security' }] },
        { id: 'c5', messages: [{ role: 'user', content: 'Check open pull requests on github today' }] },
        { id: 'c6', messages: [{ role: 'user', content: 'Check open pull requests on github today' }] },
        { id: 'c7', messages: [{ role: 'user', content: 'Clean temporary build artifacts older than week' }] },
        { id: 'c8', messages: [{ role: 'user', content: 'Clean temporary build artifacts older than week' }] },
      ];
      const sugs = pro.suggestAutomationsFromHistory({ convs, maxSuggestions: 3 });
      assert.ok(sugs.length >= 2 && sugs.length <= 3, `expected <=3 suggestions, got ${sugs.length}`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
