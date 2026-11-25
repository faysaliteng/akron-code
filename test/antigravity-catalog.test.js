'use strict';
// Antigravity picker hygiene. The live `fetchAvailableModels` catalog mixes
// marketing display names ("Gemini 4 Neon (High)") with bare slugs
// ("gemini-3.8-flash-tiered") and enumerates the editor's internal inline
// completion models (`tab_*_preview`, 16K window). Rendering that raw gives a
// picker with two naming styles and "chat" rows that are really autocomplete
// models — the design complaint on this provider.
//
// Locked in here:
//   1. A slug-only model is prettified, never shown raw.
//   2. An explicit displayName is kept verbatim.
//   3. Internal tab-completion models are filtered out.
//   4. Every rendered label is unique.
//   5. Colliding display names disambiguate with a prettified id tail.
const path = require('path');
const assert = require('assert');

const pt = require(path.join(__dirname, '..', 'electron', 'providertransport.js'));
const { googleModelList } = pt._internal;

const CATALOG = {
  models: {
    'gemini-3-flash': { displayName: 'Gemini 3 Flash', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576 },
    'gemini-3.8-flash-tiered': { apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576 },
    'gemini-4-hydrogen-sonar': { apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576 },
    'gemini-4-hydrogen-xhigh': { apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576 },
    'tab_flash_lite_preview': { apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 16384 },
    'tab_jump_flash_lite_preview': { apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 16384 },
    // Vendor duplicate display names (real: four all say "Gemini 3.5 Flash Lite")
    'gemini-2.5-flash': { displayName: 'Gemini 3.5 Flash Lite', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576 },
    'gemini-2.5-flash-lite': { displayName: 'Gemini 3.5 Flash Lite', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576 },
    'claude-opus-5-5-high': { displayName: 'Claude Opus 5.5 (High)', apiProvider: 'API_PROVIDER_ANTHROPIC', maxTokens: 1000000 },
    'gpt-oss-120b-medium': { displayName: 'GPT-OSS 120B (Medium)', apiProvider: 'API_PROVIDER_OPENAI_VERTEX', maxTokens: 131072 },
  },
};

let pass = 0;
function t(label, fn) {
  try { fn(); pass++; console.log('  ok   ' + label); }
  catch (e) { process.exitCode = 1; console.log('  FAIL ' + label + '\n       ' + (e && e.message)); }
}

console.log('Antigravity catalog hygiene');
const list = googleModelList(CATALOG);
const byId = Object.fromEntries(list.map((m) => [m.id, m]));

t('internal tab-completion models are not offered as chat models', () => {
  assert.ok(!byId.tab_flash_lite_preview, 'tab_flash_lite_preview leaked');
  assert.ok(!byId.tab_jump_flash_lite_preview, 'tab_jump_flash_lite_preview leaked');
  assert.strictEqual(list.length, 8);
});

t('a slug-only model is prettified, never shown raw', () => {
  assert.strictEqual(byId['gemini-3.8-flash-tiered'].label, 'Gemini 3.8 Flash Tiered');
  assert.strictEqual(byId['gemini-4-hydrogen-sonar'].label, 'Gemini 4 Hydrogen Sonar');
});

t('vendor abbreviations keep their casing', () => {
  assert.strictEqual(byId['gemini-4-hydrogen-xhigh'].label, 'Gemini 4 Hydrogen XHigh');
});

t('an explicit displayName is kept verbatim', () => {
  assert.strictEqual(byId['gemini-3-flash'].label, 'Gemini 3 Flash');
  assert.strictEqual(byId['claude-opus-5-5-high'].label, 'Claude Opus 5.5 (High)');
});

t('colliding display names fall back to the accurate, prettified id', () => {
  assert.strictEqual(byId['gemini-2.5-flash'].label, 'Gemini 2.5 Flash');
  assert.strictEqual(byId['gemini-2.5-flash-lite'].label, 'Gemini 2.5 Flash Lite');
});

t('every rendered label is unique', () => {
  const labels = list.map((m) => m.label);
  assert.strictEqual(new Set(labels).size, labels.length, 'duplicate label: ' + labels.join(' | '));
});

t('no rendered label looks like a raw lowercase slug', () => {
  const bad = list.filter((m) => /^[a-z0-9]+[._-][a-z0-9._-]*$/.test(m.label));
  assert.deepStrictEqual(bad.map((m) => m.label), []);
});

t('grouping and windows survive the rewrite', () => {
  assert.strictEqual(byId['gemini-3-flash'].group, 'Gemini');
  assert.strictEqual(byId['claude-opus-5-5-high'].group, 'Claude');
  assert.strictEqual(byId['gpt-oss-120b-medium'].group, 'API_PROVIDER_OPENAI_VERTEX');
  assert.strictEqual(byId['gemini-3-flash'].contextWindow, 1048576);
});

console.log('\n' + pass + ' passed, ' + (process.exitCode ? 1 : 0) + ' failed');
