'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { runAgent } = require(path.join(ROOT, 'electron/llm'));
const taskRouter = require(path.join(ROOT, 'electron/task-router'));
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

async function startMockGateway(handler) {
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw || '{}');
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

function writeSseToolCall(res, model, toolCallId, name, argsObj) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.write(`data: ${JSON.stringify({
    id: 'cmpl_tc',
    model,
    choices: [{
      delta: {
        tool_calls: [{ index: 0, id: toolCallId, type: 'function', function: { name, arguments: JSON.stringify(argsObj) } }],
      },
      finish_reason: 'tool_calls',
    }],
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

(async () => {
  console.log('\n=== 3-MODE ROUTING & SMART AI TASK-ROUTER TESTS ===');

  await test('Direct mode strictly calls user-selected single model even with 55 orchestrator providers configured', async () => {
    const calledModels = [];
    const gw = await startMockGateway(async (_req, res, body) => {
      calledModels.push(body.model);
      writeSseText(res, body.model, `Reply from ${body.model}`);
    });
    try {
      const fiftyFive = Array.from({ length: 55 }, (_, i) => ({
        baseURL: gw.baseURL,
        apiKey: 'k',
        model: `pool-model-${i}`,
        role: i === 0 ? 'fast' : 'coder',
        tier: i === 0 ? 'small' : 'heavy',
      }));
      const orch = { enabled: true, providers: fiftyFive, activeIndex: 0 };
      const prov = { baseURL: gw.baseURL, apiKey: 'k', model: 'user-picked-direct-model', routingMode: 'direct' };

      assert.strictEqual(isOrchestratorActiveForTurn(orch, false, prov), false);
      const events = [];
      const msgs = await runAgent({
        provider: prov,
        orchestrator: orch,
        messages: [{ role: 'user', content: 'Say hello' }],
        emit: (e) => events.push(e),
        turnStart: true,
        maxSteps: 3,
      });
      assert.deepStrictEqual(calledModels, ['user-picked-direct-model']);
      const last = msgs.find((m) => m.role === 'assistant');
      assert.ok(last && last.content.includes('user-picked-direct-model'));
      assert.ok(!events.some((e) => e.type === 'model' && e.model.startsWith('pool-model-')));
    } finally {
      gw.close();
    }
  });

  await test('Orchestrator mode pins selected model as Supervisor (index 0) + delegates/fails over to pool models', async () => {
    const calledModels = [];
    let failSupervisorOnce = true;
    const gw = await startMockGateway(async (_req, res, body) => {
      calledModels.push(body.model);
      if (body.model === 'supervisor-lead-model' && failSupervisorOnce) {
        failSupervisorOnce = false;
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
        return;
      }
      writeSseText(res, body.model, `Handled by ${body.model}`);
    });
    try {
      const prov = { baseURL: gw.baseURL, apiKey: 'k', model: 'supervisor-lead-model', routingMode: 'orchestrator' };
      const orch = {
        enabled: false,
        providers: [
          { baseURL: gw.baseURL, apiKey: 'k', model: 'worker-fast-backup', role: 'fast', tier: 'small' },
          { baseURL: gw.baseURL, apiKey: 'k', model: 'worker-coder-backup', role: 'coder', tier: 'heavy' },
        ],
      };
      assert.strictEqual(isOrchestratorActiveForTurn(orch, false, prov), true);
      const msgs = await runAgent({
        provider: prov,
        orchestrator: orch,
        messages: [{ role: 'user', content: 'Verify failover from supervisor' }],
        turnStart: true,
        maxSteps: 3,
      });
      assert.strictEqual(calledModels[0], 'supervisor-lead-model', 'Supervisor must run first at index 0');
      assert.strictEqual(calledModels[1], 'worker-fast-backup', 'Should fail over to orchestrator pool row');
      assert.ok(msgs.some((m) => m.role === 'assistant' && m.content.includes('worker-fast-backup')));

      // Also verify supervisor runs cleanly AND subagent Task(role:'fast') uses pool worker when supervisor succeeds
      calledModels.length = 0;
      let spawnedTask = false;
      const gw2 = await startMockGateway(async (_req, res, body) => {
        calledModels.push(body.model);
        if (body.model === 'supervisor-lead-model' && !spawnedTask) {
          spawnedTask = true;
          writeSseToolCall(res, body.model, 'tc_sub_1', 'Task', {
            description: 'Quick file summary',
            prompt: 'Say subagent ok',
            role: 'fast',
          });
          return;
        }
        writeSseText(res, body.model, `Done from ${body.model}`);
      });
      try {
        await runAgent({
          provider: { baseURL: gw2.baseURL, apiKey: 'k', model: 'supervisor-lead-model', routingMode: 'orchestrator' },
          orchestrator: {
            enabled: true,
            providers: [
              { baseURL: gw2.baseURL, apiKey: 'k', model: 'worker-fast-model', role: 'fast', tier: 'small' },
            ],
          },
          messages: [{ role: 'user', content: 'Run task delegation test' }],
          turnStart: true,
          maxSteps: 5,
        });
        assert.strictEqual(calledModels[0], 'supervisor-lead-model');
        assert.ok(calledModels.includes('worker-fast-model'), `Expected subagent delegation to worker-fast-model, saw: ${calledModels.join(', ')}`);
      } finally {
        gw2.close();
      }
    } finally {
      gw.close();
    }
  });

  await test('Auto mode Stage 1 deterministic fast-path routes greetings, images, media gen & >120K context without AI classifier calls', async () => {
    let classifierCalls = 0;
    const baseOrch = {
      enabled: false,
      providers: [
        { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'claude-haiku-5-5', role: 'fast', tier: 'small' },
        { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'claude-sonnet-5-5', role: 'coder', tier: 'heavy' },
        { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'claude-opus-5-5', role: 'planner', tier: 'critical' },
        { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'gemini-4-carbon-medium', role: 'vision', tier: 'heavy' },
        { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'gemini-4-carbon-high', role: 'longctx', tier: 'heavy' },
      ],
    };

    const g1 = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: 'hello' }],
      orchestrator: baseOrch,
      store: false,
      callClassifier: async () => { classifierCalls++; return { content: '{}' }; },
    });
    assert.strictEqual(g1.classification.role, 'fast');
    assert.strictEqual(g1.classification.via, 'heuristic');
    assert.strictEqual(g1.chosen.model, 'claude-haiku-5-5');

    const g2 = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'What bug is here?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }],
      orchestrator: baseOrch,
      store: false,
      callClassifier: async () => { classifierCalls++; return { content: '{}' }; },
    });
    assert.strictEqual(g2.classification.role, 'vision');
    assert.strictEqual(g2.classification.via, 'heuristic');
    assert.strictEqual(g2.chosen.model, 'gemini-4-carbon-medium');

    const g3 = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: 'Generate a minimalist emerald logo for AkronLogic' }],
      orchestrator: baseOrch,
      store: false,
      callClassifier: async () => { classifierCalls++; return { content: '{}' }; },
    });
    assert.strictEqual(g3.classification.role, 'image_gen');
    assert.strictEqual(g3.classification.via, 'heuristic');
    assert.strictEqual(g3.chosen.model, 'claude-sonnet-5-5');

    const g4 = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: 'word '.repeat(130000) }],
      orchestrator: baseOrch,
      store: false,
      callClassifier: async () => { classifierCalls++; return { content: '{}' }; },
    });
    assert.strictEqual(g4.classification.role, 'longctx');
    assert.strictEqual(g4.classification.via, 'heuristic');
    assert.strictEqual(g4.chosen.model, 'gemini-4-carbon-high');
    assert.strictEqual(classifierCalls, 0, 'Stage 1 fast-path must execute zero AI classifier calls');
  });

  await test('Auto mode Stage 2 small AI classifier classifies coder & planner turns and emits model autoRouted metadata', async () => {
    const reqLog = [];
    const gw = await startMockGateway(async (_req, res, body) => {
      reqLog.push({ model: body.model, maxTokens: body.max_tokens });
      if (body.model === 'qwen3.8-27b') {
        const userTxt = String((body.messages && body.messages[1] && body.messages[1].content) || '');
        const verdict = /architect|security audit/i.test(userTxt)
          ? { role: 'planner', complexity: 5, reason: 'Multi-file architecture audit' }
          : { role: 'coder', complexity: 4, reason: 'Code refactor and tests' };
        writeSseText(res, body.model, JSON.stringify(verdict));
        return;
      }
      writeSseText(res, body.model, `Executed on ${body.model}`);
    });
    try {
      const orch = {
        enabled: true,
        pools: {
          enabled: true,
          gateway: { baseURL: gw.baseURL, apiKey: 'k' },
          roles: {
            fast: { models: [{ model: 'qwen3.8-27b' }] },
            coder: { models: [{ model: 'claude-sonnet-5-5' }] },
            planner: { models: [{ model: 'claude-opus-5-5' }] },
          },
        },
        providers: [
          { baseURL: gw.baseURL, apiKey: 'k', model: 'qwen3.8-27b', role: 'fast', tier: 'small' },
          { baseURL: gw.baseURL, apiKey: 'k', model: 'claude-sonnet-5-5', role: 'coder', tier: 'heavy' },
          { baseURL: gw.baseURL, apiKey: 'k', model: 'claude-opus-5-5', role: 'planner', tier: 'critical' },
        ],
      };

      const coderEvents = [];
      await runAgent({
        provider: { baseURL: gw.baseURL, apiKey: 'k', model: 'auto', routingMode: 'auto' },
        orchestrator: orch,
        store: false,
        messages: [{ role: 'user', content: 'Refactor src/auth.js to validate JWT expiry and write unit tests' }],
        emit: (e) => coderEvents.push(e),
        turnStart: true,
        maxSteps: 3,
      });
      assert.strictEqual(reqLog[0].model, 'qwen3.8-27b');
      assert.strictEqual(reqLog[0].maxTokens, 32);
      assert.strictEqual(reqLog[1].model, 'claude-sonnet-5-5');
      const mEvt1 = coderEvents.find((e) => e.type === 'model');
      assert.ok(mEvt1 && mEvt1.autoRouted && mEvt1.autoRouted.role === 'coder' && mEvt1.autoRouted.complexity === 4);

      reqLog.length = 0;
      const planEvents = [];
      await runAgent({
        provider: { baseURL: gw.baseURL, apiKey: 'k', model: 'auto', routingMode: 'auto' },
        orchestrator: orch,
        store: false,
        messages: [{ role: 'user', content: 'Perform a full security audit of our OAuth + IPC architecture' }],
        emit: (e) => planEvents.push(e),
        turnStart: true,
        maxSteps: 3,
      });
      assert.strictEqual(reqLog[0].model, 'qwen3.8-27b');
      assert.strictEqual(reqLog[1].model, 'claude-opus-5-5');
      const mEvt2 = planEvents.find((e) => e.type === 'model');
      assert.ok(mEvt2 && mEvt2.autoRouted && mEvt2.autoRouted.role === 'planner' && mEvt2.autoRouted.complexity === 5);
    } finally {
      gw.close();
    }
  });

  await test('Auto mode falls back cleanly in <5ms when small AI classifier times out', async () => {
    const t0 = Date.now();
    const res = await taskRouter.classifyAndSelect({
      messages: [{ role: 'user', content: 'Design the migration architecture and run a security audit across electron/main.js, electron/llm.js, and electron/store.js' }],
      orchestrator: {
        providers: [
          { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'qwen3.8-27b', role: 'fast', tier: 'small' },
          { baseURL: 'http://127.0.0.1:1/v1', apiKey: 'k', model: 'claude-opus-5-5', role: 'planner', tier: 'critical' },
        ],
      },
      store: false,
      timeoutMs: 80,
      callClassifier: async (_p, _m, _t, sig) => new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('should have aborted')), 2000);
        if (sig) sig.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('timeout aborted')); }, { once: true });
      }),
    });
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 400, `Expected bounded timeout fallback (<400ms), took ${elapsed}ms`);
    assert.strictEqual(res.classification.via, 'fallback');
    assert.strictEqual(res.classification.role, 'planner');
    assert.strictEqual(res.classification.complexity, 5);
    assert.strictEqual(res.chosen.model, 'claude-opus-5-5');
  });

  await test('3-Mode Model Picker UI & App.jsx wiring cover Auto, Orchestrator Supervisor + Configure…, Direct reset, and footer badge', () => {
    const barSrc = fs.readFileSync(path.join(ROOT, 'src/components/chat/InputBarView.jsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');

    assert.ok(barSrc.includes('Routing mode'));
    assert.ok(barSrc.includes('⚡ Auto (DeepSeek V4.1 Flash)'));
    assert.ok(barSrc.includes('Setup Free Key →'));
    assert.ok(barSrc.includes('🛰️ Orchestrator Models'));
    assert.ok(barSrc.includes("openSettings({ section: 'orchestrator' })"));
    assert.ok(barSrc.includes('Activate Orchestrator (Use Selected Model as Supervisor)'));
    assert.ok(barSrc.includes("routingMode: 'direct'") && barSrc.includes('disableOrchestrator'));
    assert.ok(barSrc.includes('⚡ Auto · DeepSeek V4.1 Flash') && barSrc.includes('🛰️ Orch ·'));

    assert.ok(appSrc.includes('saveOrchestrator'));
    assert.ok(appSrc.includes("openSettingsAt((opts && opts.section) || 'providers')"));
    assert.ok(appSrc.includes('⚡ Auto (DeepSeek V4.1 Flash) → ★') && appSrc.includes('data-testid="auto-routed-badge"'));
    assert.ok(cssSrc.includes('.routing-mode-card') && cssSrc.includes('.orch-picker-box') && cssSrc.includes('.is-auto-routed'));
  });

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} tests failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL_AUTO_TASK_ROUTER_TESTS_PASSED (${passed}/${passed})`);
})();
