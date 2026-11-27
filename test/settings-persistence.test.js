'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function loadMod() {
  return await import(pathToFileURL(path.join(__dirname, '../src/utils/settingsPersistence.js')).href);
}

test('syncProviderForOrchestratorToggle synchronizes routingMode cleanly on toggle', async () => {
  const { syncProviderForOrchestratorToggle } = await loadMod();

  // Enabling Orchestrator while in direct mode flips routingMode to 'orchestrator'
  const p1 = syncProviderForOrchestratorToggle(
    { baseURL: '', oauthProvider: 'antigravity:u', model: 'gemini-2.5-flash', routingMode: 'direct' },
    { enabled: true, providers: [{ model: 'claude-opus-4-6' }], activeIndex: 0 },
    { enabled: false, providers: [{ model: 'claude-opus-4-6' }], activeIndex: 0 }
  );
  assert.strictEqual(p1.routingMode, 'orchestrator');
  assert.strictEqual(p1.model, 'gemini-2.5-flash');

  // Enabling Orchestrator preserves explicit Auto-Switch mode ('auto')
  const p2 = syncProviderForOrchestratorToggle(
    { model: 'auto', routingMode: 'auto' },
    { enabled: true, providers: [] },
    { enabled: false, providers: [] }
  );
  assert.strictEqual(p2.routingMode, 'auto');

  // Disabling Orchestrator resets 'orchestrator' back to 'direct'
  const p3 = syncProviderForOrchestratorToggle(
    { model: 'gemini-2.5-flash', routingMode: 'orchestrator' },
    { enabled: false, providers: [] },
    { enabled: true, providers: [] }
  );
  assert.strictEqual(p3.routingMode, 'direct');

  // Empty model adopts active orchestrator entry on enable
  const p4 = syncProviderForOrchestratorToggle(
    { model: '', routingMode: 'direct' },
    { enabled: true, activeIndex: 1, providers: [{ model: 'a' }, { model: 'b', baseURL: 'https://api.example/v1' }] },
    { enabled: false }
  );
  assert.strictEqual(p4.routingMode, 'orchestrator');
  assert.strictEqual(p4.model, 'b');
  assert.strictEqual(p4.baseURL, 'https://api.example/v1');
});

test('reconcileBootProvider preserves OAuth/Orchestrator/keyless configs and heals enabled orchestrator', async () => {
  const { reconcileBootProvider } = await loadMod();
  const DEFAULT_PROVIDER = { baseURL: 'http://localhost:3001/v1', apiKey: '', model: 'auto', routingMode: 'direct' };

  // Fresh profile (no localStorage) restores OAuth + Orchestrator config from settings.json without requiring apiKey
  const r1 = reconcileBootProvider({
    localProvider: DEFAULT_PROVIDER,
    hasLocalProvider: false,
    localKeys: {},
    diskProvider: { baseURL: '', apiKey: '', model: 'gemini-2.5-flash', oauthProvider: 'antigravity:u', transport: 'google', oauth: true, routingMode: 'orchestrator', _updatedAt: 200 },
    diskKeys: { 'https://api.openai.com/v1': 'sk-test-1' },
    diskOrchestrator: { enabled: true, providers: [{ model: 'gemini-2.5-flash' }] },
    defaultProvider: DEFAULT_PROVIDER,
    presets: [],
  });
  assert.strictEqual(r1.adoptedFromDisk, true);
  assert.strictEqual(r1.provider.oauthProvider, 'antigravity:u');
  assert.strictEqual(r1.provider.routingMode, 'orchestrator');
  assert.strictEqual(r1.providerKeys['https://api.openai.com/v1'], 'sk-test-1');

  // Inconsistent disk state (orchestrator.json enabled=true + settings.json routingMode='direct') heals to 'orchestrator'
  const r2 = reconcileBootProvider({
    localProvider: { baseURL: '', apiKey: '', model: 'gemini-2.5-flash', oauthProvider: 'antigravity:u', routingMode: 'direct' },
    hasLocalProvider: true,
    diskProvider: { baseURL: '', apiKey: '', model: 'gemini-2.5-flash', oauthProvider: 'antigravity:u', routingMode: 'direct' },
    diskOrchestrator: { enabled: true, providers: [] },
    defaultProvider: DEFAULT_PROVIDER,
    presets: [],
  });
  assert.strictEqual(r2.healedRoutingMode, true);
  assert.strictEqual(r2.provider.routingMode, 'orchestrator');
});

test('mergeBootSettings & mergeBootUiState restore all settings and UI state after restart or wiped profile', async () => {
  const { mergeBootSettings, mergeBootUiState, extractPersistedSettings } = await loadMod();

  const fullSaved = extractPersistedSettings({
    theme: 'light',
    surfaceFinish: 'matte-obsidian',
    accentColor: '#3b82f6',
    harnessProfile: 'swarm',
    chatWidth: 'wide',
    notifications: { agent: false, errors: true },
    sounds: { agent: 'none' },
    preventSleep: true,
    keepInTray: true,
    browserLinkMode: 'external',
    browserAllowUrls: 'github.com',
    orchestratorModel: 'gpt-5.6-luna',
    voiceLang: 'de-DE',
    _updatedAt: 5000,
  });

  // Wiped localStorage profile recovers everything from diskSettings.uiSettings
  const m1 = mergeBootSettings({
    localSettings: null,
    hasLocalSettings: false,
    designPrefs: {},
    diskSettings: { uiSettings: fullSaved },
    defaultAppearance: { theme: 'dark', surfaceFinish: 'emerald-carbon', chatWidth: 'standard' },
    normalizeTypography: (t) => t || { uiPreset: 'system', uiSize: 14 },
  });
  assert.strictEqual(m1.theme, 'light');
  assert.strictEqual(m1.surfaceFinish, 'matte-obsidian');
  assert.strictEqual(m1.harnessProfile, 'swarm');
  assert.strictEqual(m1.chatWidth, 'wide');
  assert.strictEqual(m1.notifications.agent, false);
  assert.strictEqual(m1.notifications.errors, true);
  assert.strictEqual(m1.preventSleep, true);
  assert.strictEqual(m1.keepInTray, true);
  assert.strictEqual(m1.browserLinkMode, 'external');
  assert.strictEqual(m1.orchestratorModel, 'gpt-5.6-luna');
  assert.strictEqual(m1.voiceLang, 'de-DE');

  // Stale designPrefs cannot override explicit theme change in newer localSettings
  const m2 = mergeBootSettings({
    localSettings: { theme: 'light', _updatedAt: 9000 },
    hasLocalSettings: true,
    designPrefs: { theme: 'dark' },
    diskSettings: { uiSettings: { theme: 'dark', _updatedAt: 1000 } },
    defaultAppearance: { theme: 'dark' },
  });
  assert.strictEqual(m2.theme, 'light');

  // UI state restoration on wiped profile
  const ui = mergeBootUiState({
    localUiState: { permissions: 'auto', swarmEnabled: false, webSearch: false, styleId: 'default' },
    hasLocalKeyMap: { permissions: false, swarmEnabled: false, webSearch: false, styleId: false },
    diskUiState: { permissions: 'ask', swarmEnabled: true, webSearch: true, styleId: 'concise', sidebarCollapsed: true, _updatedAt: 7000 },
  });
  assert.strictEqual(ui.permissions, 'ask');
  assert.strictEqual(ui.swarmEnabled, true);
  assert.strictEqual(ui.webSearch, true);
  assert.strictEqual(ui.styleId, 'concise');
  assert.strictEqual(ui.sidebarCollapsed, true);
});
