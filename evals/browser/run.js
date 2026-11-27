'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const v2 = require('../../electron/browser-bot-v2');
const skills = require('../../electron/browser-skills');

async function runBrowserEval() {
  const startedAt = Date.now();
  const results = [];
  const tokenStats = [];

  const record = async (id, category, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ id, category, passed: true, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ id, category, passed: false, error: e.message, ms: Date.now() - t0 });
    }
  };

  // Start ephemeral local multi-page HTTP test harness server
  const htmlFixtures = {
    '/login': '<div class="wrap"><div class="outer"><form><label>Email</label><input id="u" type="email" name="email"/><input id="p" type="password" name="pw"/><input id="otp" name="otp"/><button type="submit">Sign In</button></form></div></div>' + '<!-- filler -->'.repeat(200),
    '/dashboard': '<nav><a href="/orders">Orders</a><a href="/settings">Settings</a><button>New Report</button></nav><main><section><div class="card">' + '<div class="noise"><span>metric</span></div>'.repeat(80) + '</div></section></main>',
    '/canvas': '<html><body><canvas id="board" width="600" height="400"></canvas></body></html>',
    '/checkout': '<html><body><h1>Checkout</h1><p>Credit card number required. Place your order below.</p><button>Place your order</button></body></html>',
  };

  const srv = http.createServer((req, res) => {
    const body = htmlFixtures[req.url] || '<html><body>OK</body></html>';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;

  try {
    // --- A. 4 Compact AX Snapshot (@e12) + Token Compression tasks ---
    for (let i = 1; i <= 4; i++) {
      await record(`brow-ax-${i}`, 'ax-snapshot', async () => {
        const res = await fetch(`${baseUrl}/dashboard`);
        const rawHtml = await res.text();
        const snap = v2.buildCompactAxSnapshot([
          { role: 'link', name: 'Orders', tag: 'a', href: '/orders' },
          { role: 'link', name: 'Settings', tag: 'a', href: '/settings' },
          { role: 'button', name: 'New Report', tag: 'button' },
        ], { title: `Page ${i}`, url: `${baseUrl}/dashboard` });
        assert.ok(snap.snapshotText.includes('@e1 [link] "Orders"'));
        const compressionRatio = Math.round((rawHtml.length / Math.max(1, snap.snapshotText.length)) * 10) / 10;
        tokenStats.push(compressionRatio);
        assert.ok(compressionRatio > 10, `Expected >10x char reduction over raw HTML, got ${compressionRatio}x`);
      });
    }

    // --- B. 4 Self-Healing Zero-Token Replayable Skill tasks ---
    const driftStrategies = [
      { fp: { role: 'button', name: 'Save', testId: 'save-btn' }, cand: { ref: '@e2', role: 'button', name: 'Save Changes', testId: 'save-btn', selector: '[data-testid="save-btn"]' } },
      { fp: { role: 'button', name: 'Submit', ariaLabel: 'Submit order' }, cand: { ref: '@e4', role: 'button', name: 'Complete Order', ariaLabel: 'Submit order', selector: 'button.new-cls' } },
      { fp: { role: 'textbox', name: 'Email', placeholder: 'Enter email' }, cand: { ref: '@e1', role: 'textbox', name: 'Email', placeholder: 'Enter email', selector: 'input.v2-email' } },
      { fp: { role: 'button', name: 'Continue to Checkout' }, cand: { ref: '@e7', role: 'button', name: 'Continue Checkout Flow', selector: '.checkout-v3' } },
    ];

    for (let i = 0; i < driftStrategies.length; i++) {
      await record(`brow-heal-${i + 1}`, 'self-healing-replay', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-sk-'));
        try {
          const st = driftStrategies[i];
          const action = st.fp.role === 'textbox' ? 'type' : 'click';
          skills.saveSkill({
            name: `eval-skill-${i + 1}`,
            steps: [{ action, selector: '#stale-legacy-id', fingerprint: st.fp, text: 'user@test.local' }],
          }, dir);
          const loaded = skills.loadSkill(`eval-skill-${i + 1}`, dir);
          const out = await skills.replaySkill(loaded, {
            click: async (sel) => (sel === '#stale-legacy-id' ? { ok: true, found: false } : { ok: true, found: true }),
            type: async (sel) => (sel === '#stale-legacy-id' ? { ok: true, found: false } : { ok: true, found: true }),
            snapshot: async () => ({ refs: [st.cand] }),
          }, { dir });
          assert.strictEqual(out.ok, true);
          assert.strictEqual(out.healedCount, 1);
          assert.strictEqual(out.llmTokensUsed, 0);
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    }

    // --- C. 4 Vault Zero-Exposure + RFC 6238 TOTP tasks ---
    const mem = new Map();
    const store = { set: (k, v) => mem.set(k, v), get: (k) => mem.get(k) || null };
    v2.setVaultCredential({
      origin: `${baseUrl}/login`,
      username: 'qa@akron.local',
      password: 'TopSecret#EvalValue',
      totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      store,
    });

    for (let i = 1; i <= 4; i++) {
      await record(`brow-vault-${i}`, 'vault-totp', async () => {
        const res = await v2.vaultAutofill({
          pageUrl: `${baseUrl}/login`,
          expectedOrigin: baseUrl,
          store,
          nowMs: 59000 + i * 30000,
          injectFn: async (items) => ({ applied: items.map((x) => x.field) }),
        });
        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.totpApplied, true);
        assert.strictEqual(JSON.stringify(res).includes('TopSecret#EvalValue'), false);
      });
    }

    // --- D. 4 Human Handoff & Set-of-Marks tasks ---
    await record('brow-som-1', 'som-fallback', () => {
      const sparse = v2.buildCompactAxSnapshot([{ role: 'canvas', tag: 'canvas', name: 'Board' }], { url: `${baseUrl}/canvas` });
      assert.strictEqual(sparse.sparseAx, true);
      assert.ok(v2.buildSomOverlayScript('show').includes('__akron_som_layer__'));
    });

    await record('brow-gate-captcha-2', 'human-gate', async () => {
      const g = v2.detectHumanGate({ text: 'Please solve reCAPTCHA to continue' });
      assert.strictEqual(g.gated, true);
      assert.strictEqual(g.gateType, 'captcha');
    });

    await record('brow-gate-2fa-3', 'human-gate', async () => {
      const g = v2.detectHumanGate({ text: 'Two-factor verification code required' });
      assert.strictEqual(g.gated, true);
      assert.strictEqual(g.gateType, '2fa');
    });

    await record('brow-gate-checkout-4', 'human-gate', async () => {
      const resp = await fetch(`${baseUrl}/checkout`);
      const text = await resp.text();
      const g = v2.detectHumanGate({ url: `${baseUrl}/checkout`, text });
      assert.strictEqual(g.gated, true);
      assert.strictEqual(g.gateType, 'checkout');
      const wait = v2.requestHumanHandoff({ pauseId: 'eval_handoff_1', gateType: 'checkout', url: `${baseUrl}/checkout` });
      v2.resumeHumanGate('eval_handoff_1', 'continue');
      const done = await wait;
      assert.strictEqual(done.resumed, true);
    });
  } finally {
    srv.close();
  }

  const passed = results.filter((r) => r.passed).length;
  const avgCompression = tokenStats.length ? Math.round((tokenStats.reduce((a, b) => a + b, 0) / tokenStats.length) * 10) / 10 : 0;
  return {
    suite: 'browser',
    total: results.length,
    passed,
    failed: results.length - passed,
    passRatePct: Math.round((passed / results.length) * 1000) / 10,
    avgAxCompressionRatioX: avgCompression,
    durationMs: Date.now() - startedAt,
    results,
  };
}

if (require.main === module) {
  runBrowserEval().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (r.failed > 0) process.exit(1);
  });
}

module.exports = { runBrowserEval };
