'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const router = require(path.join(ROOT, 'electron/orch-router'));
const { hydrateOrchestrator, poolDeadNotice } = require(path.join(ROOT, 'electron/orch-hydrate'));
const taskRouter = require(path.join(ROOT, 'electron/task-router'));
const { runAgent } = require(path.join(ROOT, 'electron/llm'));

async function startMockServer(handler) {
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    await handler(req, res, body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    baseURL: `http://127.0.0.1:${srv.address().port}/v1`,
    close: () => srv.close(),
  };
}

function writeSse(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'cmpl_test', model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

describe('Orchestrator Paid API Providers, Delegation Scope & Pool Isolation', () => {
  it('declares delegationOrchestrator in autobot:run function scope (outside try block)', () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
    const startIdx = mainSrc.indexOf("ipcMain.handle('autobot:run'");
    assert(startIdx >= 0, 'autobot:run handler must exist in electron/main.js');
    const slice = mainSrc.slice(startIdx, startIdx + 2200);
    const letIdx = slice.indexOf('let delegationOrchestrator = null;');
    const tryIdx = slice.indexOf('try {', slice.indexOf('let poolDead'));
    assert(letIdx > 0, 'let delegationOrchestrator = null must exist in autobot:run');
    assert(tryIdx > letIdx, 'let delegationOrchestrator = null must be declared BEFORE the try block');
    assert(!/try\s*\{[\s\S]*?let delegationOrchestrator\s*=/.test(slice.slice(0, slice.indexOf('} catch (e)'))),
      'delegationOrchestrator must NOT be re-declared with let inside the try block');
  });

  it('includes all canonical Paid & Custom API presets and resolves encrypted keys without leaking to loopback', () => {
    const ids = router.ORCH_PAID_API_PRESETS.map((p) => p.id);
    for (const reqId of ['openrouter', 'deepseek', 'glm', 'ghostmetal', 'openai', 'anthropic_api', 'gemini_api', 'xai_api', 'together', 'mistral', 'nvidia', 'groq', 'tokenrouter']) {
      assert(ids.includes(reqId), `missing Paid API preset: ${reqId}`);
    }

    const fakeSecretStore = {
      map: new Map([
        ['autobot.orch_api_key.openrouter', 'sk-or-test-123'],
        ['autobot.orch_base_key.https://api.z.ai/api/paas/v4', 'glm-test-456'],
      ]),
      get(k) { return this.map.get(k) || ''; },
    };

    assert.equal(
      router.resolvePaidProviderApiKey(
        { orchProviderId: 'openrouter', baseURL: 'https://openrouter.ai/api/v1', apiKey: '' },
        { secretstore: fakeSecretStore }
      ),
      'sk-or-test-123'
    );
    assert.equal(
      router.resolvePaidProviderApiKey(
        { baseURL: 'https://api.z.ai/api/paas/v4/', apiKey: '' },
        { secretstore: fakeSecretStore }
      ),
      'glm-test-456'
    );
    assert.equal(
      router.resolvePaidProviderApiKey(
        { orchProviderId: 'ghostmetal', baseURL: 'https://api.ghostmetal.ai/v1', apiKey: '' },
        {
          settings: { providerKeys: { 'https://api.ghostmetal.ai/v1': 'gm-secret-789' } },
          secretstore: fakeSecretStore,
        }
      ),
      'gm-secret-789'
    );
    assert.equal(
      router.resolvePaidProviderApiKey(
        { baseURL: 'http://127.0.0.1:3001/v1', apiKey: '' },
        { settings: { providerKeys: { 'http://127.0.0.1:3001/v1': 'free-tok' } }, secretstore: fakeSecretStore }
      ),
      '',
      'resolvePaidProviderApiKey must not return loopback gateway tokens'
    );
  });

  it('drops remote unkeyed Paid API rows during hydrateOrchestrator with actionable notice', async () => {
    const orch = {
      enabled: true,
      activeIndex: 0,
      providers: [
        { id: 'gw|https://api.ghostmetal.ai/v1|ghostmetal-pro', name: 'GhostMetal Pro', baseURL: 'https://api.ghostmetal.ai/v1', apiKey: '', model: 'ghostmetal-pro', tier: 'critical' },
        { id: 'gw|https://openrouter.ai/api/v1|anthropic/claude-sonnet-4.6', name: 'OpenRouter Sonnet', baseURL: 'https://openrouter.ai/api/v1', apiKey: '', orchProviderId: 'openrouter', model: 'anthropic/claude-sonnet-4.6', tier: 'heavy' },
        { id: 'gw|http://127.0.0.1:11434/v1|gemma4', name: 'Ollama gemma4', baseURL: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'gemma4', tier: 'small' },
      ],
    };
    const hy = await hydrateOrchestrator(orch, async (row) => {
      if (row.orchProviderId === 'openrouter') return { ...row, apiKey: 'sk-or-live' };
      return row;
    });
    assert.equal(hy.dead.length, 1);
    assert.equal(hy.dead[0].entry.model, 'ghostmetal-pro');
    assert.equal(hy.orch.providers.length, 2);
    assert.equal(hy.orch.providers[0].model, 'anthropic/claude-sonnet-4.6');
    assert.equal(hy.orch.providers[0].apiKey, 'sk-or-live');
    assert.equal(hy.orch.providers[1].model, 'gemma4');
    const notice = poolDeadNotice(hy.dead);
    assert(notice.includes('needs an API key in Settings'), `Expected API key notice, got: ${notice}`);
  });

  it('prevents enabled Role Pools (:3001) from hijacking Paid API / OAuth Orchestrator sessions', async () => {
    const paidCalls = [];
    const poolCalls = [];
    const paidGw = await startMockServer(async (_req, res, body) => {
      paidCalls.push(body.model);
      writeSse(res, body.model, `Paid reply from ${body.model}`);
    });
    const fakePoolGw = await startMockServer(async (_req, res, body) => {
      poolCalls.push(body.model);
      writeSse(res, body.model, `Pool reply from ${body.model}`);
    });
    try {
      const orch = {
        enabled: true,
        activeIndex: 0,
        providers: [
          { baseURL: paidGw.baseURL, apiKey: 'paid-key', model: 'glm-5', tier: 'critical' },
          { baseURL: paidGw.baseURL, apiKey: 'paid-key', model: 'deepseek-chat', tier: 'heavy' },
        ],
        pools: {
          enabled: true,
          gateway: { baseURL: fakePoolGw.baseURL, apiKey: 'pool-key' },
          roles: {
            planner: { label: 'Planner', models: [{ model: 'free-pool-planner' }] },
            coder: { label: 'Coder', models: [{ model: 'free-pool-coder' }] },
            fast: { label: 'Fast', models: [{ model: 'free-pool-fast' }] },
          },
        },
      };
      const supervisor = {
        baseURL: paidGw.baseURL,
        apiKey: 'paid-key',
        model: 'glm-5',
        routingMode: 'orchestrator',
      };
      assert.equal(router.poolsActive(orch, supervisor), false);

      const msgs = await runAgent({
        provider: supervisor,
        orchestrator: orch,
        messages: [{ role: 'user', content: 'Say hello once.' }],
        turnStart: true,
        maxSteps: 3,
      });
      assert.deepStrictEqual(paidCalls, ['glm-5']);
      assert.deepStrictEqual(poolCalls, [], 'Role pool gateway MUST NOT be called when session uses Paid/OAuth provider');
      const reply = msgs.find((m) => m.role === 'assistant');
      assert(reply && reply.content.includes('glm-5'));
    } finally {
      paidGw.close();
      fakePoolGw.close();
    }
  });

  it('sorts OAuth before Paid API keys before FreeLLMAPI before Ollama and excludes unkeyed API models in task-router', () => {
    const roster = taskRouter.buildAvailableRoster({
      store: false,
      oauthAccounts: [
        { id: 'claude:main', provider: 'claude', account: 'main', needsSignIn: false, expired: false },
      ],
      orchestrator: {
        enabled: true,
        providers: [
          { baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-valid', model: 'deepseek/deepseek-chat-v3-0324', tier: 'heavy' },
          { baseURL: 'https://api.ghostmetal.ai/v1', apiKey: '', model: 'ghostmetal-unkeyed', tier: 'heavy' },
          { baseURL: 'http://127.0.0.1:3001/v1', apiKey: 'fl-key', model: 'qwen3.8-27b', tier: 'heavy' },
          { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'gemma4', tier: 'small' },
        ],
      },
    });
    assert(!roster.all.some((c) => c.model === 'ghostmetal-unkeyed'), 'unkeyed Paid API model must never enter roster');
    const keyedIdx = roster.coder.findIndex((c) => c.model === 'deepseek/deepseek-chat-v3-0324');
    const freeIdx = roster.coder.findIndex((c) => c.model === 'qwen3.8-27b');
    const oauthIdx = roster.coder.findIndex((c) => c.oauthProvider === 'claude:main');
    assert(oauthIdx >= 0 && keyedIdx >= 0 && freeIdx >= 0);
    assert(oauthIdx < keyedIdx && keyedIdx < freeIdx, `Expected OAuth (${oauthIdx}) < Paid API (${keyedIdx}) < FreeLLMAPI (${freeIdx})`);
  });
});
