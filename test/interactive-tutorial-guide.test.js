'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('Beginner 1-Click Presets (Auto, Orchestrator, Swarm, Direct) configure mode flags cleanly', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/utils/tutorialPresets.js')).href);
  assert.strictEqual(mod.BEGINNER_PRESETS.length, 4);
  assert.strictEqual(mod.STARTER_MISSIONS.length, 3);

  const seedOrch = {
    enabled: false,
    providers: [{ model: 'claude-opus-5-5', oauthProvider: 'antigravity:test', enabled: true }],
    pools: { enabled: true, roles: { coder: { models: ['qwen3-coder'] } } },
  };
  const seedProv = { model: 'gemini-2.5-flash', routingMode: 'direct' };

  const autoRes = mod.applyBeginnerPreset('auto', { provider: seedProv, orchestrator: seedOrch });
  assert.strictEqual(autoRes.provider.routingMode, 'auto');
  assert.strictEqual(autoRes.orchestrator.enabled, false);
  assert.strictEqual(autoRes.orchestrator.providers.length, 1);
  assert.strictEqual(autoRes.swarmEnabled, false);
  assert.strictEqual(autoRes.reasoningLevel, 'auto');
  assert.strictEqual(autoRes.permissions, 'auto');

  const orchRes = mod.applyBeginnerPreset('orchestrator', { provider: autoRes.provider, orchestrator: autoRes.orchestrator });
  assert.strictEqual(orchRes.provider.routingMode, 'orchestrator');
  assert.strictEqual(orchRes.provider.model, 'gemini-2.5-flash');
  assert.strictEqual(orchRes.orchestrator.enabled, true);
  assert.strictEqual(orchRes.swarmEnabled, false);

  const swarmRes = mod.applyBeginnerPreset('swarm', { provider: orchRes.provider, orchestrator: orchRes.orchestrator });
  assert.strictEqual(swarmRes.provider.routingMode, 'orchestrator');
  assert.strictEqual(swarmRes.orchestrator.enabled, true);
  assert.strictEqual(swarmRes.swarmEnabled, true);
  assert.strictEqual(mod.detectActivePreset(swarmRes).id, 'swarm');
  assert.ok(mod.detectActivePreset(swarmRes).tip.includes('Swarm is ON'));

  const directRes = mod.applyBeginnerPreset('direct', { provider: swarmRes.provider, orchestrator: swarmRes.orchestrator });
  assert.strictEqual(directRes.provider.routingMode, 'direct');
  assert.strictEqual(directRes.orchestrator.enabled, false);
  assert.strictEqual(directRes.swarmEnabled, false);
  assert.strictEqual(mod.detectActivePreset(directRes).id, 'direct');
});

test('First-run tutorial auto-open gate opens for new human users and stays closed in automated/seen runs', async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, 'src/utils/tutorialPresets.js')).href);
  assert.strictEqual(mod.shouldAutoOpenTutorial({ tutorialSeen: false, isTestEnv: false, webdriver: false, search: '' }), true);
  assert.strictEqual(mod.shouldAutoOpenTutorial({ tutorialSeen: true, isTestEnv: false, webdriver: false, search: '' }), false);
  assert.strictEqual(mod.shouldAutoOpenTutorial({ tutorialSeen: false, isTestEnv: true, webdriver: false, search: '' }), false);
  assert.strictEqual(mod.shouldAutoOpenTutorial({ tutorialSeen: false, isTestEnv: false, webdriver: true, search: '' }), false);
  assert.strictEqual(mod.shouldAutoOpenTutorial({ tutorialSeen: false, isTestEnv: false, webdriver: false, search: '?notour=1' }), false);
});

test('Tutorial icons resolve in src/icons.json and all entry points, commands, and file size caps hold', () => {
  const icons = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/icons.json'), 'utf8'));
  const modalSrc = fs.readFileSync(path.join(ROOT, 'src/components/InteractiveTutorialModal.jsx'), 'utf8');
  for (const m of modalSrc.matchAll(/<Icon\s+name="([^"]+)"/g)) {
    assert.ok(icons[m[1]], `Missing icon ${m[1]} in src/icons.json`);
  }
  const cmds = require('../electron/commands');
  const tut = cmds.BUILTIN.find((b) => b.name === 'tutorial');
  assert.ok(tut && tut.aliases.includes('guide') && tut.aliases.includes('onboarding'));

  const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const barSrc = fs.readFileSync(path.join(ROOT, 'src/components/chat/InputBarView.jsx'), 'utf8');
  const wsSrc = fs.readFileSync(path.join(ROOT, 'src/components/chat/WorkspaceViews.jsx'), 'utf8');
  const modSrc = fs.readFileSync(path.join(ROOT, 'src/features/AppModals.jsx'), 'utf8');

  assert.ok(appSrc.includes('InteractiveTutorialModal') && appSrc.includes('WelcomeQuickStartBar'));
  assert.ok(appSrc.includes('sidebar-tutorial-btn'));
  assert.ok(barSrc.includes('open-mode-guide-btn'));
  assert.ok(wsSrc.includes('welcomeExtra'));
  assert.ok(modSrc.includes("key: 'tutorial'"));

  assert.ok(appSrc.split('\n').length < 3500, `App.jsx exceeded 3500 lines: ${appSrc.split('\n').length}`);
  assert.ok(mainSrc.split('\n').length < 1600, `main.js exceeded 1600 lines: ${mainSrc.split('\n').length}`);
});
