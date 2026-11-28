'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const { hydrateOrchestrator } = require('../electron/orch-hydrate.js');

async function importEs(relPath) {
  return import(pathToFileURL(path.join(ROOT, relPath)).href);
}

test('Per-conversation sessionModelState keeps multiple tabs completely isolated', async () => {
  const stateMod = await importEs('src/utils/sessionModelState.js');
  const {
    DRAFT_CONV_KEY,
    resolveConvSessionConfig,
    updateConvSessionConfig,
    buildEffectiveOrchestratorForSession,
    formatFooterModelSummary,
  } = stateMod;

  const globalDefaults = {
    provider: { model: 'claude-fable-5-2', routingMode: 'direct', oauthProvider: 'claude:main', reasoningLevel: 'auto' },
    orchestrator: {
      enabled: false,
      activeIndex: 0,
      executorModel: '',
      providers: [
        { model: 'claude-fable-5-2', oauthProvider: 'claude:main' },
        { model: 'gpt-5-4', oauthProvider: 'chatgpt:work' },
      ],
    },
    swarmEnabled: false,
  };

  let map = {};
  // Tab A: Single claude-fable-5-2 Direct, Swarm OFF, cwd A
  map = updateConvSessionConfig(map, 'convA', {
    provider: { ...globalDefaults.provider, model: 'claude-fable-5-2', routingMode: 'direct' },
    orchEnabled: false,
    swarmEnabled: false,
    cwd: '/tmp/proj-a',
  }, globalDefaults);

  // Tab B: Orchestrator on GPT-5.4 + Swarm ON + executorModel
  map = updateConvSessionConfig(map, 'convB', {
    provider: { model: 'gpt-5-4', routingMode: 'orchestrator', oauthProvider: 'chatgpt:work', reasoningLevel: 'high' },
    orchEnabled: true,
    orchActiveIndex: 1,
    executorModel: 'claude-fable-5-2',
    swarmEnabled: true,
    cwd: '/tmp/proj-b',
  }, globalDefaults);

  // Tab C: Draft set to Smart Auto without affecting A or B
  map = updateConvSessionConfig(map, null, {
    provider: { model: 'auto', routingMode: 'auto' },
    orchEnabled: false,
    swarmEnabled: false,
    cwd: '/tmp/proj-draft',
  }, globalDefaults);

  const cfgA = resolveConvSessionConfig({ convId: 'convA', sessionConfigs: map, defaults: globalDefaults });
  const cfgB = resolveConvSessionConfig({ convId: 'convB', sessionConfigs: map, defaults: globalDefaults });
  const cfgDraft = resolveConvSessionConfig({ convId: null, sessionConfigs: map, defaults: globalDefaults });

  assert.equal(cfgA.provider.model, 'claude-fable-5-2');
  assert.equal(cfgA.orchEnabled, false);
  assert.equal(cfgA.swarmEnabled, false);
  assert.equal(cfgA.cwd, '/tmp/proj-a');

  assert.equal(cfgB.provider.model, 'gpt-5-4');
  assert.equal(cfgB.provider.reasoningLevel, 'high');
  assert.equal(cfgB.orchEnabled, true);
  assert.equal(cfgB.orchActiveIndex, 1);
  assert.equal(cfgB.executorModel, 'claude-fable-5-2');
  assert.equal(cfgB.swarmEnabled, true);
  assert.equal(cfgB.cwd, '/tmp/proj-b');

  assert.equal(cfgDraft.provider.routingMode, 'auto');
  assert.equal(map[DRAFT_CONV_KEY].cwd, '/tmp/proj-draft');

  const orchA = buildEffectiveOrchestratorForSession(globalDefaults.orchestrator, cfgA);
  const orchB = buildEffectiveOrchestratorForSession(globalDefaults.orchestrator, cfgB);
  assert.equal(orchA.enabled, false);
  assert.equal(orchB.enabled, true);
  assert.equal(orchB.activeIndex, 1);
  assert.equal(orchB.executorModel, 'claude-fable-5-2');
  assert.equal(orchB.providers.length, 2);

  assert.equal(formatFooterModelSummary(cfgA.provider, orchA), 'Pinned model: claude-fable-5-2');
  assert.equal(formatFooterModelSummary(cfgB.provider, orchB), 'Orchestrator · gpt-5-4');
  assert.equal(formatFooterModelSummary(cfgDraft.provider, globalDefaults.orchestrator), 'Routing: Smart Auto');
});

test('normalizeMcpToolEntry supports string and object MCP tools without blank chips', async () => {
  const { normalizeMcpToolEntry } = await importEs('src/utils/sessionModelState.js');

  assert.deepEqual(normalizeMcpToolEntry('inspect_macho'), { name: 'inspect_macho', description: '' });
  assert.deepEqual(normalizeMcpToolEntry({ name: 'open_binary', description: 'Opens binary' }), {
    name: 'open_binary',
    description: 'Opens binary',
  });
  assert.deepEqual(normalizeMcpToolEntry({ id: 'fallback_id' }), { name: 'fallback_id', description: '' });
  assert.deepEqual(normalizeMcpToolEntry(null), { name: '', description: '' });
});

test('orch-hydrate marks stale unkeyed empty-baseURL and localhost Ollama cloud rows dead', async () => {
  const orch = {
    enabled: true,
    activeIndex: 0,
    providers: [
      { model: 'claude-fable-5-2', baseURL: '', apiKey: '', oauthProvider: '' },
      { model: 'gpt-5-4', baseURL: 'http://127.0.0.1:11434/v1', apiKey: '', oauthProvider: '' },
      { model: 'claude-fable-5-2', oauthProvider: 'claude:main', oauth: true },
    ],
  };

  const res = await hydrateOrchestrator(orch, async (row) => row);
  assert.equal(res.dead.length, 2, 'both broken claude-fable-5-2/Ollama cloud rows must be rejected');
  assert.equal(res.orch.providers.length, 1);
  assert.equal(res.orch.providers[0].oauthProvider, 'claude:main');
});

test('applyBeginnerPreset preserves oauthProvider, transport, and baseURL across mode switches', async () => {
  const { applyBeginnerPreset } = await importEs('src/utils/tutorialPresets.js');
  const startState = {
    provider: { model: 'auto', routingMode: 'auto', reasoningLevel: 'auto' },
    orchestrator: {
      enabled: false,
      activeIndex: 0,
      providers: [
        { model: 'claude-fable-5-2', oauthProvider: 'claude:main', transport: 'anthropic', oauth: true, baseURL: '' },
      ],
    },
    reasoningLevel: 'auto',
    permissions: 'auto',
  };

  const orchPreset = applyBeginnerPreset('orchestrator', startState);
  assert.equal(orchPreset.provider.routingMode, 'orchestrator');
  assert.equal(orchPreset.provider.model, 'claude-fable-5-2');
  assert.equal(orchPreset.provider.oauthProvider, 'claude:main');
  assert.equal(orchPreset.provider.transport, 'anthropic');
  assert.equal(orchPreset.swarmEnabled, true);
});

test('review-helpers mergeDiffFiles and fallbackDiffsFromTools guard non-array inputs', async () => {
  const { mergeDiffFiles, fallbackDiffsFromTools } = await importEs('src/review-helpers.mjs');

  assert.deepEqual(mergeDiffFiles(null, { bad: true }), []);
  assert.deepEqual(mergeDiffFiles('not-an-array', [{ path: 'a.js', status: 'M' }]).length, 1);
  assert.deepEqual(fallbackDiffsFromTools(null), []);
  assert.deepEqual(fallbackDiffsFromTools({}), []);
});
