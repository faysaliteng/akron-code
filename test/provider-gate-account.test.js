'use strict';
const test = require('node:test');
const assert = require('node:assert');
const gate = require('../electron/provider-gate');

const carbon = { oauthProvider: 'antigravity:me', model: 'gemini-4-carbon' };
const carbonHigh = { oauthProvider: 'antigravity:me', model: 'gemini-4-carbon-high' };
const otherAcct = { oauthProvider: 'antigravity:second', model: 'gemini-4-carbon' };
const claude = { oauthProvider: 'claude:me', model: 'claude-x' };
const claude2 = { oauthProvider: 'claude:me', model: 'claude-y' };

test.beforeEach(() => gate.reset());

test('429 on one Antigravity model cools sibling models on the same account', () => {
  gate.rateLimited(carbon, 30000);
  assert.ok(gate.coolingFor(carbonHigh) > 25000);
  assert.strictEqual(gate.usable(carbonHigh), false);
});

test('a second Antigravity account keeps its own allowance', () => {
  gate.rateLimited(carbon, 30000);
  assert.strictEqual(gate.usable(otherAcct), true);
});

test('per-model providers are unaffected', () => {
  gate.rateLimited(claude, 30000);
  assert.strictEqual(gate.usable(claude2), true);
});

test('backoff grows across siblings when no Retry-After is given', () => {
  gate.rateLimited(carbon);
  const first = gate.coolingFor(carbonHigh);
  gate.rateLimited(carbonHigh);
  assert.ok(gate.coolingFor(carbon) > first + 5000, 'second strike should roughly double');
});

test('success clears the account cooldown', () => {
  gate.rateLimited(carbon, 30000);
  gate.ok(carbonHigh);
  gate.ok(carbon);
  assert.strictEqual(gate.usable(carbonHigh), true);
});

test('order() puts a non-Google fallback ahead of a cooling Gemini account', () => {
  gate.rateLimited(carbon, 30000);
  const list = [carbon, carbonHigh, claude];
  assert.deepStrictEqual(gate.order(list, 0)[0], 2);
});

test('explicit gateKey opts out of account sharing', () => {
  const pinned = { ...carbonHigh, gateKey: 'pinned' };
  gate.rateLimited(carbon, 30000);
  assert.strictEqual(gate.usable(pinned), true);
});
