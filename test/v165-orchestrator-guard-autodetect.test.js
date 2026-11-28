'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const orchRouter = require('../electron/orch-router');

test('Swarm turns ON by default whenever Orchestrator preset or toggle activates', async () => {
  const presets = await import(pathToFileURL(path.join(ROOT, 'src/utils/tutorialPresets.js')).href);
  const seedOrch = {
    enabled: false,
    providers: [{ model: 'kimi-k2.5', baseURL: 'https://api.moonshot.ai/v1', enabled: true }],
  };
  const orchRes = presets.applyBeginnerPreset('orchestrator', {
    provider: { model: 'gemini-2.5-flash', routingMode: 'auto' },
    orchestrator: seedOrch,
  });
  assert.strictEqual(orchRes.orchestrator.enabled, true);
  assert.strictEqual(orchRes.provider.routingMode, 'orchestrator');
  assert.strictEqual(orchRes.swarmEnabled, true);
  assert.strictEqual(presets.detectActivePreset(orchRes).id, 'orchestrator');

  const inputBarSrc = fs.readFileSync(path.join(ROOT, 'src/components/chat/InputBarView.jsx'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  assert.ok(inputBarSrc.includes('setSwarmEnabled(true)'), 'activateOrchestratorSupervisor must turn Swarm ON');
  assert.ok(appSrc.includes('!prev?.enabled && next.enabled && !(opts && opts.keepSwarmState)) setSwarmEnabled(true)'), 'saveOrchestrator must turn Swarm ON when enabling');
});

test('hasConfiguredOrchestratorModels & guard block empty Orchestrator setups', async () => {
  const presets = await import(pathToFileURL(path.join(ROOT, 'src/utils/tutorialPresets.js')).href);

  // Empty orchestrator (0 models) is rejected on both backend and frontend
  for (const bad of [
    null,
    undefined,
    { enabled: true, providers: [] },
    { enabled: true, providers: [{ model: 'kimi-k2.5', enabled: false, baseURL: 'https://api.moonshot.ai/v1' }] },
    { enabled: true, providers: [{ model: '', baseURL: 'https://api.x.ai/v1', enabled: true }] },
    { enabled: true, providers: [{ model: 'kimi-k2.5', enabled: true, baseURL: '', oauthProvider: '' }] },
    { enabled: true, providers: [], pools: { enabled: true, roles: { planner: { models: ['kimi-k2.5'] } }, gateway: { baseURL: '' } } },
  ]) {
    assert.strictEqual(orchRouter.hasConfiguredOrchestratorModels(bad), false);
    assert.strictEqual(presets.hasConfiguredOrchestratorModels(bad), false);
  }

  // OAuth, Paid API, and Gateway Role Pool setups pass
  for (const good of [
    { enabled: false, providers: [{ model: 'claude-opus-4-6', oauthProvider: 'claude:main', enabled: true }] },
    { enabled: true, providers: [{ model: 'glm-5', baseURL: 'https://api.z.ai/api/paas/v4', enabled: true }] },
    { enabled: true, providers: [], pools: { enabled: true, roles: { coder: { models: ['grok-3'] } }, gateway: { baseURL: 'http://127.0.0.1:4000/v1' } } },
  ]) {
    assert.strictEqual(orchRouter.hasConfiguredOrchestratorModels(good), true);
    assert.strictEqual(presets.hasConfiguredOrchestratorModels(good), true);
  }

  // guardOrchestratorAction emits notice + opens Settings -> orchestrator when empty
  let opened = null;
  const blocked = presets.guardOrchestratorAction({ enabled: false, providers: [] }, (arg) => { opened = arg; });
  assert.strictEqual(blocked, false);
  assert.deepStrictEqual(opened, { section: 'orchestrator', notice: presets.ORCH_SETUP_NOTICE });

  let openedWhenReady = null;
  const allowed = presets.guardOrchestratorAction(
    { enabled: false, providers: [{ model: 'grok-4', baseURL: 'https://api.x.ai/v1', enabled: true }] },
    (arg) => { openedWhenReady = arg; },
  );
  assert.strictEqual(allowed, true);
  assert.strictEqual(openedWhenReady, null);

  // main.js, App.jsx, InputBarView.jsx enforce the guard before running
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  assert.ok(mainSrc.includes('hasConfiguredOrchestratorModels(orchSource)'), 'autobot:run must block unconfigured Orchestrator');
  assert.ok(appSrc.includes('hasConfiguredOrchestratorModels('), 'send() & handleApplyPreset must block unconfigured Orchestrator');
});

test('Auto-detection supports Kimi, Z.ai/GLM, Grok/xAI, ChatGPT, Claude, Antigravity, settings & env vars', () => {
  const ids = orchRouter.ORCH_PAID_API_PRESETS.map((p) => p.id);
  assert.ok(ids.includes('kimi'), 'Kimi preset missing');
  assert.ok(ids.includes('glm'), 'Z.ai/GLM preset missing');
  assert.ok(ids.includes('xai_api'), 'xAI Grok preset missing');

  // Env var detection for Grok, Z.ai, Kimi, OpenAI, Anthropic, Gemini
  assert.strictEqual(
    orchRouter.resolvePaidProviderApiKey(
      { orchProviderId: 'xai_api', baseURL: 'https://api.x.ai/v1' },
      { env: { XAI_API_KEY: 'xai-test-123' } },
    ),
    'xai-test-123',
  );
  assert.strictEqual(
    orchRouter.resolvePaidProviderApiKey(
      { orchProviderId: 'glm', baseURL: 'https://api.z.ai/api/paas/v4' },
      { env: { ZAI_API_KEY: 'zai-test-456' } },
    ),
    'zai-test-456',
  );
  assert.strictEqual(
    orchRouter.resolvePaidProviderApiKey(
      { orchProviderId: 'kimi', baseURL: 'https://api.moonshot.ai/v1' },
      { env: { MOONSHOT_API_KEY: 'kimi-test-789' } },
    ),
    'kimi-test-789',
  );
  // Active settings.provider & settings.autoRouter auto-detection
  assert.strictEqual(
    orchRouter.resolvePaidProviderApiKey(
      { baseURL: 'https://custom.llm.internal/v1' },
      { settings: { provider: { baseURL: 'https://custom.llm.internal/v1', apiKey: 'sk-custom-active' } }, env: {} },
    ),
    'sk-custom-active',
  );
  assert.strictEqual(
    orchRouter.resolvePaidProviderApiKey(
      { baseURL: 'https://router.example.com/v1' },
      { settings: { autoRouter: { baseURL: 'https://router.example.com/v1', apiKey: 'sk-router-active' } }, env: {} },
    ),
    'sk-router-active',
  );

  // SettingsModalBody always renders checklist; OrchPaidProvidersPanel exposes OAuth + Auto-Detect
  const modalBodySrc = fs.readFileSync(path.join(ROOT, 'src/components/settings/SettingsModalBody.jsx'), 'utf8');
  const paidPanelSrc = fs.readFileSync(path.join(ROOT, 'src/components/settings/OrchPaidProvidersPanel.jsx'), 'utf8');
  const ipcFeaturesSrc = fs.readFileSync(path.join(ROOT, 'electron/ipc/ipc-features.js'), 'utf8');
  assert.ok(!modalBodySrc.includes('{orchestrator.enabled && (\n                    <>\n                      <p className="muted"'), 'OrchModelChecklist should render even when orchestrator.enabled is false');
  assert.ok(modalBodySrc.includes('orch-setup-banner'));
  assert.ok(paidPanelSrc.includes('orch-oauth-quickbar'));
  assert.ok(paidPanelSrc.includes('orch-autodetect-btn'));
  assert.ok(ipcFeaturesSrc.includes("ipcMain.handle('autobot:orchAutoDetectModels'"));
});
