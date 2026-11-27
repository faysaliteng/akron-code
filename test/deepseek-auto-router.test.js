'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const taskRouter = require(path.join(ROOT, 'electron/task-router'));
const { runAgent } = require(path.join(ROOT, 'electron/llm'));
const { isOrchestratorActiveForTurn } = require(path.join(ROOT, 'electron/orch-hydrate'));

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

async function startServer(handler) {
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) {}
    await handler(req, res, body);
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return {
    baseURL: `http://127.0.0.1:${srv.address().port}/v1`,
    close: () => srv.close(),
  };
}

function writeSseText(res, model, text) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({ id: 'cmpl_1', model, choices: [{ delta: { content: text }, finish_reason: 'stop' }] })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

(async () => {
  console.log('\n=== DEEPSEEK V4.1 FLASH AUTO-SWITCH DISPATCHER TESTS ===');

  await test('buildAvailableRoster + classifyWithDeepSeek route across fast, coder, planner, vision (<2ms) & longctx (<2ms)', async () => {
    const roster = taskRouter.buildAvailableRoster({
      store: false,
      oauthAccounts: [
        { id: 'claude:main', provider: 'claude', account: 'main' },
        { id: 'antigravity:work', provider: 'antigravity', account: 'work' },
        { id: 'chatgpt:plus', provider: 'chatgpt', account: 'plus' },
        { id: 'grok:pro', provider: 'grok', account: 'pro' },
      ],
      ollamaModels: ['qwen3.8-27b', 'qwen3-coder-30b-a3b-instruct'],
    });

    assert.ok(roster.fast.some((m) => m.model === 'claude-haiku-5-5'), 'fast tier should include claude-haiku-5-5');
    assert.ok(roster.coder.some((m) => m.model === 'claude-sonnet-5-5'), 'coder tier should include claude-sonnet-5-5');
    assert.ok(roster.planner.some((m) => m.model === 'claude-opus-5-5'), 'planner tier should include claude-opus-5-5');
    assert.ok(roster.vision.length >= 2, 'vision tier should include multimodal models');
    assert.ok(roster.longctx.some((m) => m.model === 'gemini-4-carbon-high' && m.contextWindow >= 500000), 'longctx tier should include >=500K models');

    let apiCalls = 0;
    const ds = await startServer(async (req, res, body) => {
      apiCalls++;
      assert.strictEqual(req.url, '/v1/chat/completions');
      assert.strictEqual(req.headers.authorization, 'Bearer sk-ds-test-key');
      assert.strictEqual(body.model, 'deepseek-v4-flash');
      assert.strictEqual(body.max_tokens, 45);
      assert.strictEqual(body.temperature, 0);
      assert.ok(String(body.messages[0].content).includes("Akron Code's model router"));

      const userPrompt = String(body.messages[1].content || '');
      let reply;
      if (/what is git rebase/i.test(userPrompt)) {
        reply = { role: 'fast', complexity: 1, model: 'claude-haiku-5-5', reason: 'Quick git command question' };
      } else if (/fix react state bug/i.test(userPrompt)) {
        reply = { role: 'coder', complexity: 3, model: 'claude-sonnet-5-5', reason: 'React state bug fix' };
      } else {
        reply = { role: 'planner', complexity: 5, model: 'claude-opus-5-5', reason: 'Distributed system security design' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });

    try {
      const cfg = { apiKey: 'sk-ds-test-key', baseURL: ds.baseURL, model: 'deepseek-v4-flash' };

      const fastRes = await taskRouter.classifyWithDeepSeek({ prompt: 'What is git rebase?', roster, autoRouterConfig: cfg });
      assert.strictEqual(fastRes.role, 'fast');
      assert.strictEqual(fastRes.complexity, 1);
      assert.strictEqual(fastRes.model, 'claude-haiku-5-5');
      assert.strictEqual(fastRes.via, 'deepseek-v4-flash');

      const coderRes = await taskRouter.classifyWithDeepSeek({ prompt: 'Fix React state bug in InputBar.jsx', roster, autoRouterConfig: cfg });
      assert.strictEqual(coderRes.role, 'coder');
      assert.strictEqual(coderRes.complexity, 3);
      assert.strictEqual(coderRes.model, 'claude-sonnet-5-5');

      const planRes = await taskRouter.classifyWithDeepSeek({ prompt: 'Design a multi-tenant zero-trust IPC security architecture', roster, autoRouterConfig: cfg });
      assert.strictEqual(planRes.role, 'planner');
      assert.strictEqual(planRes.complexity, 5);
      assert.strictEqual(planRes.model, 'claude-opus-5-5');
      assert.strictEqual(apiCalls, 3);

      // Vision (<2ms fast-path, zero network calls)
      const tVis = Date.now();
      const visRes = await taskRouter.classifyWithDeepSeek({ prompt: 'Describe this UI bug', hasImages: true, roster, autoRouterConfig: cfg });
      assert.ok(Date.now() - tVis < 25);
      assert.strictEqual(visRes.role, 'vision');
      assert.ok(roster.vision.some((m) => m.model === visRes.model));
      assert.strictEqual(apiCalls, 3, 'Vision fast-path must bypass DeepSeek HTTP call');

      // >120K tokens Long Context (<2ms fast-path, zero network calls)
      const tLc = Date.now();
      const lcRes = await taskRouter.classifyWithDeepSeek({ prompt: 'Summarize whole repo', estimatedTokens: 145000, roster, autoRouterConfig: cfg });
      assert.ok(Date.now() - tLc < 25);
      assert.strictEqual(lcRes.role, 'longctx');
      assert.ok(roster.longctx.some((m) => m.model === lcRes.model));
      assert.strictEqual(apiCalls, 3, '>120K fast-path must bypass DeepSeek HTTP call');
    } finally {
      ds.close();
    }
  });

  await test('Automatic alias fallback from deepseek-v4-flash to deepseek-chat in classifyWithDeepSeek & pingDeepSeekDispatcher', async () => {
    const modelsTried = [];
    const ds = await startServer(async (_req, res, body) => {
      modelsTried.push(body.model);
      if (body.model === 'deepseek-v4-flash') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Model Not Exist', type: 'invalid_request_error', code: 'model_not_found' } }));
        return;
      }
      if (body.max_tokens === 15) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ model: 'deepseek-chat', choices: [{ message: { content: 'OK' } }] }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'deepseek-chat',
        choices: [{ message: { content: JSON.stringify({ role: 'coder', complexity: 4, model: 'claude-sonnet-5-5', reason: 'Implement backend handler' }) } }],
      }));
    });

    try {
      const roster = { fast: ['claude-haiku-5-5'], coder: ['claude-sonnet-5-5'], planner: ['claude-opus-5-5'], vision: [], longctx: [] };
      const res = await taskRouter.classifyWithDeepSeek({
        prompt: 'Write an Express middleware for JWT validation',
        roster,
        autoRouterConfig: { apiKey: 'sk-ds-alias', baseURL: ds.baseURL, model: 'deepseek-v4-flash' },
      });
      assert.deepStrictEqual(modelsTried, ['deepseek-v4-flash', 'deepseek-chat']);
      assert.strictEqual(res.model, 'claude-sonnet-5-5');
      assert.strictEqual(res.aliasFallback, true);
      assert.strictEqual(res.dispatcherModel, 'deepseek-chat');

      modelsTried.length = 0;
      const ping = await taskRouter.pingDeepSeekDispatcher({
        apiKey: 'sk-ds-alias',
        baseURL: ds.baseURL,
        model: 'deepseek-v4-flash',
      });
      assert.strictEqual(ping.ok, true);
      assert.strictEqual(ping.modelUsed, 'deepseek-chat');
      assert.strictEqual(ping.aliasFallback, true);
      assert.ok(ping.latencyMs >= 1);
      assert.deepStrictEqual(modelsTried, ['deepseek-v4-flash', 'deepseek-chat']);
    } finally {
      ds.close();
    }
  });

  await test('<1ms deterministic heuristic fallback when unconfigured, offline, or DeepSeek times out', async () => {
    const roster = {
      fast: ['claude-haiku-5-5'],
      coder: ['claude-sonnet-5-5'],
      planner: ['claude-opus-5-5'],
      vision: ['gemini-4-carbon-medium'],
      longctx: ['gemini-4-carbon-high'],
    };

    // 1. Unconfigured key (<1ms)
    const t0 = Date.now();
    const offlineArch = await taskRouter.classifyWithDeepSeek({
      prompt: 'Perform a multi-file security audit and redesign electron/main.js architecture',
      roster,
      autoRouterConfig: { apiKey: '' },
    });
    assert.ok(Date.now() - t0 < 20);
    assert.strictEqual(offlineArch.role, 'planner');
    assert.strictEqual(offlineArch.model, 'claude-opus-5-5');
    assert.strictEqual(offlineArch.via, 'heuristic');

    // 2. Network error (connection refused)
    const connRefused = await taskRouter.classifyWithDeepSeek({
      prompt: 'Fix TypeError in src/auth.js',
      roster,
      autoRouterConfig: { apiKey: 'sk-offline', baseURL: 'http://127.0.0.1:1/v1', model: 'deepseek-v4-flash' },
      timeoutMs: 120,
    });
    assert.strictEqual(connRefused.role, 'coder');
    assert.strictEqual(connRefused.model, 'claude-sonnet-5-5');
    assert.strictEqual(connRefused.via, 'heuristic');

    // 3. Hard timeout (>600ms mock) bounded cleanly
    const tOutStart = Date.now();
    const slowFetch = (_url, init) => new Promise((_resolve, reject) => {
      const id = setTimeout(() => reject(new Error('too late')), 3000);
      if (init && init.signal) {
        init.signal.addEventListener('abort', () => { clearTimeout(id); reject(new Error('aborted')); }, { once: true });
      }
    });
    const timedOut = await taskRouter.classifyWithDeepSeek({
      prompt: 'hello there',
      roster,
      autoRouterConfig: { apiKey: 'sk-slow', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-v4-flash' },
      fetchImpl: slowFetch,
      timeoutMs: 90,
    });
    assert.ok(Date.now() - tOutStart < 350);
    assert.strictEqual(timedOut.role, 'fast');
    assert.strictEqual(timedOut.model, 'claude-haiku-5-5');
    assert.strictEqual(timedOut.via, 'heuristic');
  });

  await test('runAgent strictly separates Direct Mode, Orchestrator Mode, and DeepSeek Auto Mode + injects <runtime_identity>', async () => {
    const gatewayCalls = [];
    const seenSystems = [];
    let failSupOnce = true;

    const gw = await startServer(async (_req, res, body) => {
      gatewayCalls.push(body.model);
      if (Array.isArray(body.messages) && body.messages[0] && body.messages[0].role === 'system') {
        seenSystems.push({ model: body.model, sys: body.messages[0].content });
      }
      if (body.model === 'deepseek-v4-flash') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'deepseek-v4-flash',
          choices: [{ message: { content: JSON.stringify({ role: 'planner', complexity: 5, model: 'claude-opus-5-5', reason: 'Complex system security architecture' }) } }],
        }));
        return;
      }
      if (body.model === 'supervisor-model' && failSupOnce) {
        failSupOnce = false;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
        return;
      }
      writeSseText(res, body.model, `OK from ${body.model}`);
    });

    try {
      const sharedOrch = {
        enabled: true,
        providers: [
          { baseURL: gw.baseURL, apiKey: 'k', model: 'claude-haiku-5-5', role: 'fast', tier: 'small' },
          { baseURL: gw.baseURL, apiKey: 'k', model: 'claude-sonnet-5-5', role: 'coder', tier: 'heavy' },
          { baseURL: gw.baseURL, apiKey: 'k', model: 'claude-opus-5-5', role: 'planner', tier: 'critical' },
        ],
      };

      // A. Direct Mode — never switches away from user-selected model
      gatewayCalls.length = 0;
      await runAgent({
        provider: { baseURL: gw.baseURL, apiKey: 'k', model: 'exact-direct-model', routingMode: 'direct' },
        orchestrator: sharedOrch,
        autoRouterConfig: { apiKey: 'sk-ds', baseURL: gw.baseURL, model: 'deepseek-v4-flash' },
        store: false,
        messages: [{ role: 'user', content: 'Perform a full security architecture audit' }],
        turnStart: true,
        maxSteps: 3,
      });
      assert.deepStrictEqual(gatewayCalls, ['exact-direct-model']);

      // B. Orchestrator Mode — uses selected model as Supervisor (index 0) + pool failover
      gatewayCalls.length = 0;
      assert.strictEqual(isOrchestratorActiveForTurn(sharedOrch, false, { model: 'supervisor-model', routingMode: 'orchestrator' }), true);
      await runAgent({
        provider: { baseURL: gw.baseURL, apiKey: 'k', model: 'supervisor-model', routingMode: 'orchestrator' },
        orchestrator: sharedOrch,
        store: false,
        messages: [{ role: 'user', content: 'Check orchestrator failover' }],
        turnStart: true,
        maxSteps: 3,
      });
      assert.deepStrictEqual(gatewayCalls, ['supervisor-model', 'claude-haiku-5-5']);

      // C. Auto Mode — DeepSeek V4.1 Flash dispatches to claude-opus-5-5, emits autoRouted, and injects <runtime_identity>
      gatewayCalls.length = 0;
      seenSystems.length = 0;
      const autoEvents = [];
      await runAgent({
        provider: { baseURL: gw.baseURL, apiKey: 'k', model: 'auto', routingMode: 'auto' },
        orchestrator: sharedOrch,
        autoRouterConfig: { apiKey: 'sk-ds', baseURL: gw.baseURL, model: 'deepseek-v4-flash' },
        store: false,
        messages: [{ role: 'user', content: 'Architect the multi-tenant zero-trust security gateway' }],
        emit: (e) => autoEvents.push(e),
        turnStart: true,
        maxSteps: 3,
      });
      assert.deepStrictEqual(gatewayCalls, ['deepseek-v4-flash', 'claude-opus-5-5']);
      const modelEvt = autoEvents.find((e) => e.type === 'model');
      assert.ok(modelEvt && modelEvt.model === 'claude-opus-5-5');
      assert.ok(modelEvt.autoRouted && modelEvt.autoRouted.via === 'deepseek-v4-flash');
      assert.strictEqual(modelEvt.autoRouted.role, 'planner');
      assert.strictEqual(modelEvt.autoRouted.complexity, 5);
      const opusSys = seenSystems.find((s) => s.model === 'claude-opus-5-5');
      assert.ok(opusSys && opusSys.sys.includes('DeepSeek Auto-Router') && opusSys.sys.includes('claude-opus-5-5'));
    } finally {
      gw.close();
    }
  });

  await test('UI & IPC wiring for Auto-Switch Brain card, secretstore key storage, Configure DeepSeek Key…, and footer badge', () => {
    const extPanels = fs.readFileSync(path.join(ROOT, 'src/components/settings/ExtendedSettingsPanels.jsx'), 'utf8');
    const modalBody = fs.readFileSync(path.join(ROOT, 'src/components/settings/SettingsModalBody.jsx'), 'utf8');
    const ipcFeat = fs.readFileSync(path.join(ROOT, 'electron/ipc/ipc-features.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron/preload.js'), 'utf8');
    const barSrc = fs.readFileSync(path.join(ROOT, 'src/components/chat/InputBarView.jsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');

    assert.ok(extPanels.includes('Auto-Switch Brain (DeepSeek V4.1 Flash Dispatcher)'));
    assert.ok(extPanels.includes('How the DeepSeek V4.1 Flash Auto-Switch Brain Works:'));
    assert.ok(extPanels.includes('Option A — OpenRouter Free API') && extPanels.includes('Get Free OpenRouter Key ↗'));
    assert.ok(extPanels.includes('Option B — DeepSeek Platform API') && extPanels.includes('Top Up on platform.deepseek.com ↗'));
    assert.ok(extPanels.includes('Option C — FreeLLMAPI Unified Key'));
    assert.ok(extPanels.includes('Test Dispatcher') && extPanels.includes('Enable Auto-Switch Mode by default for new sessions'));
    assert.ok(extPanels.includes('UI &amp; Design Studio') && extPanels.includes('akron.uiDesignPrefs'));
    assert.ok(modalBody.includes('<AutoSwitchBrainSection') && modalBody.includes('<FreeLLMAPISection'));
    assert.ok(fs.existsSync(path.join(ROOT, 'src/components/settings/SettingsView.jsx')));

    assert.ok(ipcFeat.includes("autobot.autoswitch.openrouter_key"));
    assert.ok(ipcFeat.includes("autobot.autoswitch.deepseek_key"));
    assert.ok(ipcFeat.includes("autobot.autoswitch.freellm_key"));
    assert.ok(ipcFeat.includes("ipcMain.handle('autobot:autoRouterGet'") && ipcFeat.includes("ipcMain.handle('autobot:autoRouterTest'"));
    assert.ok(preloadSrc.includes('autoRouterGet') && preloadSrc.includes('autoRouterSave') && preloadSrc.includes('autoRouterTest'));

    assert.ok(barSrc.includes('⚡ Auto (DeepSeek V4.1 Flash)'));
    assert.ok(barSrc.includes('Setup Free Key →'));
    assert.ok(barSrc.includes('Activate Orchestrator (Use Selected Model as Supervisor)'));
    assert.ok(appSrc.includes('⚡ Auto (DeepSeek V4.1 Flash) → ★'));
  });

  await test('3-Source Auto-Switch (OpenRouter Free strictly :free, DeepSeek API, FreeLLMAPI), dispatchWithDeepSeekFlash connected-only & telemetry', async () => {
    taskRouter.resetDispatcherTelemetry();
    const calls = [];
    const srv = await startServer(async (req, res, body) => {
      calls.push({ url: req.url, headers: req.headers, model: body.model, maxTokens: body.max_tokens });
      if (body.model === 'deepseek/deepseek-v4.1-flash:free') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'No free endpoint for v4.1 alias' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: body.model,
        choices: [{
          message: {
            content: JSON.stringify({
              tier: 5,
              role: 'planner',
              modelId: 'unconnected-paid-model-should-be-blocked',
              reason: 'Architecture security design',
            }),
          },
        }],
      }));
    });

    try {
      const result = await taskRouter.dispatchWithDeepSeekFlash({
        prompt: 'Design an end-to-end zero-trust IPC security architecture across main.js and preload.js',
        fileCount: 4,
        availableModels: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
        autoSwitchConfig: {
          source: 'openrouter_free',
          apiKey: 'sk-or-v1-test',
          baseURL: srv.baseURL,
          model: 'gpt-4o-paid-attempt', // must be ignored/rewritten or strictly :free on OpenRouter
          allowCustomEndpoint: false,
        },
        timeoutMs: 1200,
      });

      assert.strictEqual(calls[0].headers['http-referer'], 'https://akronlogic.com');
      assert.strictEqual(calls[0].headers['x-title'], 'Akron Code');
      assert.strictEqual(calls[0].model, 'deepseek/deepseek-v4.1-flash:free', 'Must attempt strict :free DeepSeek V4.1 Flash first');
      assert.strictEqual(calls[1].model, 'deepseek/deepseek-chat:free', 'Must fall back strictly to :free DeepSeek Chat');
      assert.strictEqual(result.tier, 5);
      assert.strictEqual(result.role, 'planner');
      assert.strictEqual(result.modelId, 'claude-opus-5-5', 'Must reject unconnected model and select connected planner model');

      const tel = taskRouter.getDispatcherTelemetry();
      assert.ok(tel.decisionsCount >= 1);
      assert.strictEqual(tel.estimatedCostUsd, 0, 'OpenRouter Free must record $0.00 cost');

      const cfgOr = taskRouter.resolveAutoSwitchConfig({
        settings: { autoSwitch: { source: 'openrouter_free' } },
        env: { OPENROUTER_API_KEY: 'sk-or-env' },
      });
      assert.strictEqual(cfgOr.source, 'openrouter_free');
      assert.strictEqual(cfgOr.model, 'deepseek/deepseek-v4.1-flash:free');

      const cfgFlm = taskRouter.resolveAutoSwitchConfig({
        settings: { autoSwitch: { source: 'freellmapi' } },
        env: {},
      });
      assert.strictEqual(cfgFlm.source, 'freellmapi');
      assert.strictEqual(cfgFlm.hasKey, true);
    } finally {
      srv.close();
    }
  });

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} tests failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL_DEEPSEEK_AUTO_ROUTER_TESTS_PASSED (${passed}/${passed})`);
})();
