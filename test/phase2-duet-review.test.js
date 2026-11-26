'use strict';
const assert = require('assert');
const duet = require('../electron/duet-review');

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
  console.log('\nPhase 2 Duet Cross-Model Review Verification');

  await test('detectModelFamily + pickSecondOpinionProvider chooses cross-family pool model automatically', () => {
    assert.strictEqual(duet.detectModelFamily({ model: 'claude-opus-4-6' }), 'claude');
    assert.strictEqual(duet.detectModelFamily({ model: 'gpt-5-codex' }), 'openai');
    assert.strictEqual(duet.detectModelFamily({ model: 'gemini-2.5-pro' }), 'gemini');

    const primary = { id: 'p-claude', model: 'claude-opus-4-6', label: 'Claude Opus' };
    const orchestrator = {
      providers: [
        primary,
        { id: 'p-gpt', model: 'gpt-5-codex', label: 'GPT Codex', enabled: true },
        { id: 'p-gem', model: 'gemini-2.5-pro', label: 'Gemini Pro', enabled: true },
      ],
    };

    const autoPick = duet.pickSecondOpinionProvider({ primary, orchestrator });
    assert.strictEqual(autoPick.differentFamily, true);
    assert.strictEqual(autoPick.provider.id, 'p-gpt');

    const explicitPick = duet.pickSecondOpinionProvider({ primary, orchestrator, withSpec: 'gemini' });
    assert.strictEqual(explicitPick.differentFamily, true);
    assert.strictEqual(explicitPick.provider.id, 'p-gem');
  });

  await test('3-pass Duet review runs Pass 1 + Adversarial Pass 2 + Primary Verification and splits >=70 vs <70 Open Questions', async () => {
    const primary = { id: 'claude', model: 'claude-sonnet-4-5', label: 'Claude Sonnet' };
    const second = { id: 'openai', model: 'gpt-5-codex', label: 'GPT-5 Codex' };
    const diffFiles = [
      {
        path: '/repo/auth.js',
        relPath: 'auth.js',
        status: 'modified',
        added: 3,
        removed: 1,
        lines: [
          { type: 'del', oldLine: 10, newLine: null, text: 'if (timingSafeEq(tok, expected))' },
          { type: 'add', oldLine: null, newLine: 10, text: 'if (tok == expected)' },
          { type: 'add', oldLine: null, newLine: 11, text: 'const cacheKey = req.query.user;' },
        ],
      },
    ];

    const calls = [];
    const mockChat = async ({ provider, messages }) => {
      const prompt = messages[0].content;
      calls.push({ model: provider.model, prompt });
      if (calls.length === 1) {
        return {
          content: JSON.stringify({
            summary: 'Found timing leak and style nit.',
            findings: [
              { id: 'f1', severity: 'critical', category: 'security', file: 'auth.js', line: 10, title: 'Loose == timing-unsafe token compare', detail: 'Replaced constant-time compare with ==.', fix: 'Restore crypto.timingSafeEqual', evidence: 'if (tok == expected)', confidence: 92 },
              { id: 'f2', severity: 'low', category: 'gap', file: 'auth.js', line: 11, title: 'Maybe rename cacheKey', detail: 'Naming preference', fix: 'Rename to userCacheKey', evidence: 'cacheKey', confidence: 45 },
            ],
          }),
        };
      }
      if (calls.length === 2) {
        assert.ok(prompt.includes('adversarial'), 'Pass 2 must be adversarial prompt');
        return {
          content: JSON.stringify({
            findings: [
              { id: 'adv1', severity: 'high', category: 'adversarial', file: 'auth.js', line: 11, title: 'Unvalidated req.query.user cache key injection', detail: 'Array/object query parameter coerces unexpectedly.', fix: 'Validate typeof req.query.user === "string"', evidence: 'req.query.user', confidence: 84 },
            ],
          }),
        };
      }
      assert.strictEqual(provider.model, primary.model, 'Pass 3 must run on primary model');
      return {
        content: JSON.stringify({
          summary: '2 high-confidence vulnerabilities confirmed, 1 low-confidence naming nit.',
          verified: [
            { id: 'f1', verified: true, confidence: 96, verificationNote: 'Confirmed timingSafeEq was removed.', fixPrompt: 'Use timingSafeEq in auth.js:10.' },
            { id: 'f2', verified: false, confidence: 40, verificationNote: 'Purely stylistic nitpick.' },
            { id: 'adv1', verified: true, confidence: 88, verificationNote: 'Verified unvalidated req.query.user usage.' },
          ],
        }),
      };
    };

    const res = await duet.runDuetReview({
      cwd: '/repo',
      primaryProvider: primary,
      secondProvider: second,
      adversarial: true,
      diffFiles,
      chatFn: mockChat,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.differentFamily, true);
    assert.strictEqual(res.passesRun, 3);
    assert.strictEqual(res.findings.length, 2);
    assert.strictEqual(res.openQuestions.length, 1);
    assert.strictEqual(res.openQuestions[0].id, 'f2');
    assert.strictEqual(res.findings[0].confidence >= 70, true);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
