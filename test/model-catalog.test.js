'use strict';
/**
 * Unit tests for `electron/model-catalog.js` — the per-model window resolver and
 * the auto-compact character budget.
 *
 * The module is pure (no I/O, no providers), so these tests are deterministic
 * and assert numbers that come from the module's own documented constants.
 */
const assert = require('assert');
const cat = require('../electron/model-catalog.js');

let pass = 0;
function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('ok   - ' + name);
  } catch (e) {
    console.error('FAIL - ' + name + '\n       ' + e.message);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Documented rules
// ---------------------------------------------------------------------------
ok('Antigravity Gemini 4 codenames resolve to 1 048 576', () => {
  for (const m of ['gemini-4-neon-high', 'gemini-4-carbon-low', 'gemini-4-argon-xhigh', 'gemini-4-hydrogen-medium']) {
    assert.strictEqual(cat.contextWindowFor(m), 1048576, m);
  }
});

ok('Vertex-hosted Claude 5.5 through Antigravity is 1M', () => {
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-5-5-medium'), 1000000);
  assert.strictEqual(cat.contextWindowFor('claude-opus-5-5-high'), 1000000);
});

ok('first-party Claude Sonnet 4.x is 1M (beta), Opus/Haiku are 200k', () => {
  // Sonnet 4.x resolves to the 1M window because `anthropicChat` sends
  // `context-1m-2025-08-07` when the request needs it and demotes the window on
  // a refusal. Opus 4.x and Haiku are documented at 200k only.
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-4-5-20250929'), 1000000);
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-4-20250514'), 1000000);
  assert.strictEqual(cat.contextWindowFor('claude-opus-4-5-20251101'), 200000);
  assert.strictEqual(cat.contextWindowFor('claude-haiku-4-5-20251001'), 200000);
});

ok('only Sonnet 4.x advertises the 1M beta', () => {
  assert.strictEqual(cat.supportsLongContext('claude-sonnet-4-5-20250929'), true);
  assert.strictEqual(cat.supportsLongContext('claude-sonnet-4'), true);
  assert.strictEqual(cat.supportsLongContext('claude-opus-4-1'), false);
  assert.strictEqual(cat.supportsLongContext('claude-sonnet-5-5'), false, 'Vertex 1M is native, no beta');
  assert.strictEqual(cat.supportsLongContext('gpt-5.1'), false);
  assert.strictEqual(cat.LONG_CONTEXT_BETA, 'context-1m-2025-08-07');
});

ok('cold catalog matches the live /v1/models windows (measured 2026-11-26)', () => {
  // Before the account's catalog lands, the id rules must not under-budget a
  // 1M model by 5×: the whole 5.x line is 1M, as are opus/sonnet 4-6..4-8.
  for (const m of [
    'claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5',
    'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5',
    'claude-opus-5', 'claude-sonnet-5',
    'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-opus-4-6',
  ]) {
    assert.strictEqual(cat.contextWindowFor(m), 1000000, m);
  }
  // The 4-5 pair really is 200k — do not inflate it.
  assert.strictEqual(cat.contextWindowFor('claude-opus-4-5-20251101'), 200000);
  assert.strictEqual(cat.contextWindowFor('claude-haiku-4-5-20251001'), 200000);
  // A live catalog still wins over the rule in both directions.
  cat.register('claude', [{ id: 'claude-fable-5-2', contextWindow: 200000 }]);
  assert.strictEqual(cat.contextWindowFor('claude-fable-5-2', 'claude'), 200000);
  cat.clear('claude');
  assert.strictEqual(cat.contextWindowFor('claude-fable-5-2', 'claude'), 1000000);
});

ok('GPT-5 family is 400k, GPT-4.1 is 1 047 576', () => {
  assert.strictEqual(cat.contextWindowFor('gpt-5.1-codex-max'), 400000);
  assert.strictEqual(cat.contextWindowFor('gpt-5'), 400000);
  assert.strictEqual(cat.contextWindowFor('gpt-4.1'), 1047576);
});

ok('Grok 4 is 256k, Grok 3 is 128k, the fast variants are 2M', () => {
  assert.strictEqual(cat.contextWindowFor('grok-4'), 256000);
  assert.strictEqual(cat.contextWindowFor('grok-3'), 131072);
  assert.strictEqual(cat.contextWindowFor('grok-4-fast'), 2000000);
  assert.strictEqual(cat.contextWindowFor('grok-4.1-fast-reasoning'), 2000000);
  assert.strictEqual(cat.contextWindowFor('grok-code-fast-1'), 2000000);
});

ok('an unknown model floors at 128k', () => {
  assert.strictEqual(cat.contextWindowFor('totally-unknown-model'), 128000);
});

// ---------------------------------------------------------------------------
// Live catalog precedence
// ---------------------------------------------------------------------------
ok('a registered live catalog beats the documented rule', () => {
  cat.clear();
  const n = cat.register('antigravity', [
    { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', contextWindow: 777777 },
    { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)', contextWindow: 555555 },
  ]);
  assert.strictEqual(n, 2);
  assert.strictEqual(cat.contextWindowFor('gemini-4-neon-high', 'antigravity'), 777777);
  // Without the provider id the rule applies.
  assert.strictEqual(cat.contextWindowFor('gemini-4-neon-high'), 1048576);
  // Label-based pick resolves too.
  assert.strictEqual(cat.contextWindowFor('Claude Sonnet 5.5 (Medium)', 'antigravity'), 555555);
});

ok('explicit contextWindow outranks the live catalog (registry entry wins)', () => {
  assert.strictEqual(cat.contextWindowFor('gemini-4-neon-high', 'antigravity', 123456), 123456);
});

ok('register() ignores entries with no positive window and reports 0', () => {
  cat.clear('emptyish');
  assert.strictEqual(cat.register('emptyish', [{ id: 'x', contextWindow: 0 }, { id: 'y' }]), 0);
  assert.strictEqual(cat.register('emptyish', []), 0);
  // Nothing was installed, so the rule still answers.
  assert.strictEqual(cat.contextWindowFor('gemini-4-neon-high', 'emptyish'), 1048576);
});

ok('clear(provider) removes only that catalog', () => {
  cat.clear();
  cat.register('antigravity', [{ id: 'm1', contextWindow: 111111 }]);
  cat.register('claude', [{ id: 'm2', contextWindow: 222222 }]);
  cat.clear('antigravity');
  assert.strictEqual(cat.contextWindowFor('m1', 'antigravity'), 128000);
  assert.strictEqual(cat.contextWindowFor('m2', 'claude'), 222222);
  cat.clear();
});

// ---------------------------------------------------------------------------
// Budget math
// ---------------------------------------------------------------------------
ok('budgetFor caps the output reserve so a 1M window does not reserve 100k', () => {
  const b = cat.budgetFor(1048576);
  assert.strictEqual(b.window, 1048576);
  assert.strictEqual(b.reserveOut, 32000);
  assert.strictEqual(b.promptReserve, 8000);
  assert.strictEqual(b.usableTokens, 1048576 - 32000 - 8000);
  assert.strictEqual(b.maxChars, Math.round(b.usableTokens * cat.CHARS_PER_TOKEN));
  assert.strictEqual(b.compactAt, Math.round(b.maxChars * 0.9));
});

ok('budgetFor on a small window keeps at least MIN_USABLE_TOKENS', () => {
  const b = cat.budgetFor(1000);
  assert.strictEqual(b.usableTokens, 8000);
  assert.strictEqual(b.maxChars, Math.round(8000 * cat.CHARS_PER_TOKEN));
});

ok('a 200k window yields ~190k usable tokens and ~640k chars', () => {
  const b = cat.budgetForModel('claude-opus-4-5-20251101');
  assert.strictEqual(b.window, 200000);
  // 10% of 200k = 20 000 output reserve
  assert.strictEqual(b.reserveOut, 20000);
  assert.strictEqual(b.usableTokens, 200000 - 20000 - 8000);
  assert.ok(b.maxChars > 550000 && b.maxChars < 600000, 'maxChars ' + b.maxChars);
});

ok('a 1M window gives a much bigger budget than the old fixed 220k chars', () => {
  const b = cat.budgetForModel('gemini-4-neon-high', 'antigravity');
  assert.ok(b.maxChars > 220000 * 10, 'maxChars ' + b.maxChars);
});

// ---------------------------------------------------------------------------
// Session pins (demote after a refused beta, or an operator override)
// ---------------------------------------------------------------------------
ok('demote() shrinks the window for that provider+model only', () => {
  cat.clear();
  cat.clearWindows();
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-4-5', 'claude'), 1000000);
  assert.strictEqual(cat.demote('claude', 'claude-sonnet-4-5', 200000), 200000);
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-4-5', 'claude'), 200000);
  // A different provider id is unaffected.
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-4-5', 'other'), 1000000);
});

ok('demote() never raises a window, and a pin beats the live catalog', () => {
  cat.clear();
  cat.clearWindows();
  cat.register('antigravity', [{ id: 'claude-sonnet-5-5-medium', contextWindow: 1000000 }]);
  assert.strictEqual(cat.demote('antigravity', 'claude-sonnet-5-5-medium', 5000000), 1000000);
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-5-5-medium', 'antigravity'), 1000000);
  assert.strictEqual(cat.demote('antigravity', 'claude-sonnet-5-5-medium', 200000), 200000);
  // The catalog still says 1M, but the session pin is what the budget uses.
  assert.strictEqual(cat.contextWindowFor('claude-sonnet-5-5-medium', 'antigravity'), 200000);
  assert.strictEqual(cat.budgetForModel('claude-sonnet-5-5-medium', 'antigravity').window, 200000);
  cat.clear();
});

ok('setWindow() pins in either direction; clearWindows() drops it', () => {
  cat.clearWindows();
  assert.strictEqual(cat.setWindow('claude', 'claude-opus-4-1', 1048576), 1048576);
  assert.strictEqual(cat.contextWindowFor('claude-opus-4-1', 'claude'), 1048576);
  assert.strictEqual(cat.setWindow('claude', 'claude-opus-4-1', 0), 0, 'invalid window is rejected');
  assert.strictEqual(cat.clearWindows('claude'), 1);
  assert.strictEqual(cat.contextWindowFor('claude-opus-4-1', 'claude'), 200000);
  cat.setWindow('a', 'm', 900000);
  cat.setWindow('b', 'm', 800000);
  assert.strictEqual(cat.clearWindows(), 0, 'clearWindows() clears all and returns nothing');
  assert.strictEqual(cat.contextWindowFor('m', 'a'), 128000);
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
ok('fmtWindow labels 1M / 200K / 128K', () => {
  assert.strictEqual(cat.fmtWindow(1048576), '1M');
  assert.strictEqual(cat.fmtWindow(1000000), '1M');
  assert.strictEqual(cat.fmtWindow(200000), '200K');
  assert.strictEqual(cat.fmtWindow(128000), '128K');
  assert.strictEqual(cat.fmtWindow(131072), '131K');
  assert.strictEqual(cat.fmtWindow(0), '');
  assert.strictEqual(cat.fmtWindow(undefined), '');
});

ok('tokensForChars matches the budget ratio', () => {
  assert.strictEqual(cat.tokensForChars(3400), 1000);
  assert.strictEqual(cat.tokensForChars(0), 0);
  assert.strictEqual(cat.tokensForChars(-5), 0);
});

ok('snapshot() exposes registered catalogs only', () => {
  cat.clear();
  cat.register('antigravity', [{ id: 'a', contextWindow: 5 }, { id: 'b', contextWindow: 0 }]);
  const snap = cat.snapshot();
  assert.deepStrictEqual(Object.keys(snap), ['antigravity']);
  assert.strictEqual(snap.antigravity.length, 1, 'zero-window entry must not be stored');
  cat.clear();
});

console.log('\n' + pass + ' assertions groups passed' + (process.exitCode ? ' (with failures)' : ''));
