'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const v2 = require('../electron/browser-bot-v2');
const skills = require('../electron/browser-skills');
const duet = require('../electron/duet-review');

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
  console.log('\n=== BROWSER BOT 2.0 & DUET ENRICHMENT TESTS ===');

  await test('compact AX snapshot assigns @e1.. refs and flags sparse tree for SoM', async () => {
    const dense = v2.buildCompactAxSnapshot([
      { role: 'textbox', name: 'Email', tag: 'input', type: 'email', selector: '#email' },
      { role: 'button', name: 'Sign In', tag: 'button', selector: 'button[type=submit]' },
      { role: 'link', name: 'Forgot password', tag: 'a', href: '/reset' },
    ], { title: 'Login', url: 'https://example.com/login' });
    assert.strictEqual(dense.count, 3);
    assert.strictEqual(dense.sparseAx, false);
    assert.ok(dense.snapshotText.includes('@e1 [textbox] "Email"'));
    assert.ok(dense.snapshotText.includes('@e2 [button] "Sign In"'));
    assert.strictEqual(v2.normalizeRefId('@e2'), 'e2');

    const sparse = v2.buildCompactAxSnapshot([
      { role: 'canvas', name: 'Drawing Board', tag: 'canvas' },
    ], { title: 'Canvas App', url: 'https://canvas.local' });
    assert.strictEqual(sparse.sparseAx, true);
    assert.ok(v2.buildSomOverlayScript('show').includes('__akron_som_layer__'));
  });

  await test('RFC 6238 TOTP generator matches standard 6-digit SHA-1 test vector', () => {
    // RFC 6238 Appendix B test secret ASCII "12345678901234567890" -> Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const base32 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    const r = v2.computeTotp(base32, { nowMs: 59000, digits: 8, period: 30, algorithm: 'sha1' });
    assert.strictEqual(r.code, '94287082');
    const r6 = v2.computeTotp(`otpauth://totp/Akron:user?secret=${base32}&digits=6&period=30`, { nowMs: 59000 });
    assert.strictEqual(r6.code.length, 6);
    assert.strictEqual(r6.code, '287082');
  });

  await test('Vault autofill enforces origin binding and never leaks plaintext secret to return payload', async () => {
    const mem = new Map();
    const mockStore = {
      set: (k, v) => mem.set(k, v),
      get: (k) => mem.get(k) || null,
    };
    const fakeSecret = 's3cr3t-p@ss-xyz';
    v2.setVaultCredential({
      origin: 'https://portal.example.org/login',
      username: 'alice@example.org',
      password: fakeSecret,
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      store: mockStore,
    });

    const blocked = await v2.vaultAutofill({
      pageUrl: 'https://evil.example.net/phish',
      expectedOrigin: 'https://portal.example.org',
      store: mockStore,
    });
    assert.strictEqual(blocked.ok, false);
    assert.strictEqual(blocked.blocked, true);

    let injected = [];
    const okRes = await v2.vaultAutofill({
      pageUrl: 'https://portal.example.org/signin',
      expectedOrigin: 'https://portal.example.org',
      store: mockStore,
      nowMs: 59000,
      injectFn: async (items) => {
        injected = items;
        return { applied: items.map((x) => x.field) };
      },
    });
    assert.strictEqual(okRes.ok, true);
    assert.strictEqual(okRes.masked, true);
    assert.strictEqual(okRes.totpApplied, true);
    assert.strictEqual(JSON.stringify(okRes).includes(fakeSecret), false);
    assert.strictEqual(JSON.stringify(okRes).includes('287082'), false);
    assert.strictEqual(injected.find((x) => x.field === 'totp').value, '287082');
  });

  await test('Human handoff detects CAPTCHA / 2FA / Checkout gates and pauses until resumed', async () => {
    assert.strictEqual(v2.detectHumanGate({ text: 'Please verify you are human via reCAPTCHA' }).gateType, 'captcha');
    assert.strictEqual(v2.detectHumanGate({ url: 'https://shop.test/checkout', text: 'Place your order' }).gateType, 'checkout');
    assert.strictEqual(v2.detectHumanGate({ title: 'Welcome Home', text: 'Dashboard metrics' }).gated, false);

    const p = v2.requestHumanHandoff({ pauseId: 'gate_test_1', gateType: '2fa', reason: 'Approve 2FA' });
    assert.strictEqual(v2.listPendingHandoffs().some((h) => h.id === 'gate_test_1'), true);
    const res = v2.resumeHumanGate('gate_test_1', 'continue');
    assert.strictEqual(res.ok, true);
    const awaited = await p;
    assert.strictEqual(awaited.resumed, true);
  });

  await test('Self-healing deterministic skill replay heals selector drift with 0 LLM tokens and persists updated selector', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-skills-'));
    try {
      skills.saveSkill({
        name: 'Checkout Login',
        startUrl: 'https://app.local/login',
        steps: [
          {
            action: 'click',
            selector: '#old-submit-btn',
            fingerprint: { role: 'button', name: 'Continue Checkout', testId: 'checkout-btn' },
          },
        ],
      }, tmpDir);

      const loaded = skills.loadSkill('checkout-login', tmpDir);
      assert.strictEqual(loaded.steps.length, 1);

      const clicked = [];
      const res = await skills.replaySkill(loaded, {
        navigate: async () => ({ ok: true }),
        click: async (target) => {
          clicked.push(target);
          if (target === '#old-submit-btn') return { ok: true, found: false };
          return { ok: true, found: true };
        },
        snapshot: async () => ({
          refs: [
            { ref: '@e5', role: 'button', name: 'Continue Checkout', testId: 'checkout-btn', selector: '[data-testid="checkout-btn"]' },
          ],
        }),
      }, { dir: tmpDir });

      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.healedCount, 1);
      assert.strictEqual(res.llmTokensUsed, 0);
      assert.deepStrictEqual(clicked, ['#old-submit-btn', '[data-testid="checkout-btn"]']);

      const reloaded = skills.loadSkill('checkout-login', tmpDir);
      assert.strictEqual(reloaded.steps[0].selector, '[data-testid="checkout-btn"]');
      assert.strictEqual(reloaded.healedCount, 1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('DuetReview buildDuetBundle loads CLAUDE.md guidelines & symbol caller context', () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-duet-ctx-'));
    try {
      fs.writeFileSync(path.join(tmpRepo, 'CLAUDE.md'), 'Always validate input parameters carefully.\n');
      fs.writeFileSync(path.join(tmpRepo, 'auth.js'), 'function verifyToken(tok) { return !!tok; }\nmodule.exports = { verifyToken };\n');
      fs.writeFileSync(path.join(tmpRepo, 'server.js'), 'const { verifyToken } = require("./auth");\nverifyToken("abc");\n');
      const bundle = duet.buildDuetBundle({
        cwd: tmpRepo,
        diffFiles: [{
          relPath: 'auth.js',
          added: 1,
          removed: 0,
          status: 'modified',
          lines: [{ type: 'add', newLine: 1, text: 'function verifyToken(tok) { return !!tok; }' }],
        }],
      });
      assert.strictEqual(bundle.guidelinesIncluded, true);
      assert.ok(bundle.guidelinesText.includes('Always validate input parameters carefully'));
      assert.ok(bundle.callersCount >= 2);
      assert.ok(bundle.callerText.includes('server.js'));
      assert.strictEqual(bundle.fileContextsCount, 1);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  });

  console.log(`\nSummary: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
})();
