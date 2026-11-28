'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const modelCatalog = require('../electron/model-catalog');
const tokenBudget = require('../electron/token-budget');
const contextPipeline = require('../electron/context-pipeline');
const cliRunner = require('../electron/cli-runner');
const swarm = require('../electron/swarm');
const { runAgent } = require('../electron/llm');

test('v1.7.0 always-on 80% pre-turn & overflow auto-compact never stalls and resets usage ring to ~15-25%', async () => {
  let reqCount = 0;
  let lastSeenChars = 0;
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reqCount++;
      const parsed = JSON.parse(body || '{}');
      const totalChars = JSON.stringify(parsed.messages || []).length;
      lastSeenChars = totalChars;
      res.writeHead(200, { 'content-type': 'application/json' });
      // On request 1: simulate a tiny-model overflow error on second subtest via header/flag
      if (parsed.messages && parsed.messages.some((m) => String(m.content || '').includes('TRIGGER_OVERFLOW_ONCE')) && reqCount === 2) {
        res.end(JSON.stringify({ error: { code: 400, message: 'context_length_exceeded: prompt is too long for this model' } }));
        return;
      }
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok: ?' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: Math.round(totalChars / 3.8), completion_tokens: 8, total_tokens: Math.round(totalChars / 3.8) + 8 },
        model: parsed.model || 'grok-4',
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address();
  const baseURL = `http://127.0.0.1:${addr.port}/v1`;

  try {
    // 1. Pre-turn >= 80% context trigger on a 128K model (~105K tokens = ~400K chars)
    const bigTurns = [];
    for (let i = 0; i < 16; i++) {
      bigTurns.push({ role: 'user', content: `Turn ${i}: ` + 'A'.repeat(24000) });
      bigTurns.push({ role: 'assistant', content: `Reply ${i}: ` + 'B'.repeat(4000) });
    }
    bigTurns.push({ role: 'user', content: '?' });

    const events = [];
    const resMsgs = await runAgent({
      provider: { baseURL, apiKey: 'test-key', model: 'llama3.1', contextWindow: 128000, routingMode: 'direct', supportsTools: false },
      messages: bigTurns,
      maxSteps: 3,
      useMemory: false,
      autoCompactWindow: 'auto',
      emit: (e) => events.push(e),
    });

    const acEvt = events.find((e) => e && e.type === 'auto-compact');
    assert.ok(acEvt, 'expected auto-compact event before turn at >=80% context');
    assert.ok(acEvt.afterTokens < 128000 * 0.4, `expected compacted tokens <=40% of window, got ${acEvt.afterTokens}`);
    const lastUsageEvt = [...events].reverse().find((e) => e && e.type === 'usage');
    assert.ok(lastUsageEvt && lastUsageEvt.usage && lastUsageEvt.usage.context_tokens < 128000 * 0.45);
    assert.ok(lastSeenChars < 200000, `expected wire prompt shrunk below 200K chars, got ${lastSeenChars}`);
    assert.equal(resMsgs[resMsgs.length - 1].content, 'ok: ?');

    // 2. Context overflow error from endpoint triggers compact + automatic retry
    const overflowMsgs = [
      { role: 'user', content: 'Earlier frame ' + 'X'.repeat(40000) },
      { role: 'assistant', content: 'Ack ' + 'Y'.repeat(12000) },
      { role: 'user', content: 'Middle ' + 'Z'.repeat(40000) },
      { role: 'assistant', content: 'Ack2 ' + 'W'.repeat(12000) },
      { role: 'user', content: 'TRIGGER_OVERFLOW_ONCE final ask' },
    ];
    const events2 = [];
    const res2 = await runAgent({
      provider: { baseURL, apiKey: 'test-key', model: 'llama3.1', contextWindow: 128000, routingMode: 'direct', supportsTools: false },
      messages: overflowMsgs,
      maxSteps: 3,
      useMemory: false,
      autoCompactWindow: 'auto',
      emit: (e) => events2.push(e),
    });
    assert.ok(events2.some((e) => e && e.type === 'auto-compact' && e.trigger === 'overflow-retry'));
    assert.equal(res2[res2.length - 1].content, 'ok: ?');
  } finally {
    try { srv.closeAllConnections(); } catch (_) {}
    await new Promise((r) => srv.close(r));
  }
});

test('v1.7.0 tokenBudget.estimateSessionContext & appHelpers.effectiveUsageForConv post-compact ring drop', async () => {
  const est = tokenBudget.estimateSessionContext({
    messages: [{ role: 'user', content: 'X'.repeat(350000) }],
    modelWindow: 100000,
    autoCompactRatio: contextPipeline.AUTO_COMPACT_TRIGGER_RATIO,
  });
  assert.equal(est.thresholdTokens, 80000);
  assert.equal(est.shouldCompact, true);

  // Mock localStorage & bundle appHelpers.jsx via esbuild CJS for Node testing
  const esbuild = require('esbuild');
  const tmpMjsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ah-test-'));
  const tmpCjs = path.join(tmpMjsDir, 'appHelpers.cjs');
  esbuild.buildSync({
    entryPoints: [path.resolve(__dirname, '../src/utils/appHelpers.jsx')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: tmpCjs,
  });
  const memLS = new Map();
  global.localStorage = {
    getItem: (k) => (memLS.has(k) ? memLS.get(k) : null),
    setItem: (k, v) => memLS.set(k, String(v)),
    removeItem: (k) => memLS.delete(k),
  };
  try {
    const appHelpers = require(tmpCjs);
    assert.equal(appHelpers.contextWindowFor('claude-opus-4-5-20251101'), 1000000);
    assert.equal(appHelpers.contextWindowFor('Opus 4.5'), 1000000);
    assert.equal(appHelpers.contextWindowFor('claude-opus-4-6'), 1000000);
    assert.equal(appHelpers.contextWindowFor('claude-sonnet-4-5-20250929'), 1000000);
    assert.equal(appHelpers.contextWindowFor('grok-4.5'), 1000000);
    assert.equal(appHelpers.contextWindowFor('grok-4.7-build-fast'), 2000000);
    assert.equal(appHelpers.contextWindowFor('gpt-5.4'), 1000000);
    assert.equal(appHelpers.contextWindowFor('gemini-2.5-pro'), 1048576);
    assert.equal(appHelpers.contextWindowFor('gemini-3.1-pro'), 1048576);
    assert.equal(appHelpers.contextWindowFor('kimi-k3.1-pro'), 1048576);
    assert.equal(appHelpers.contextWindowFor('glm-5.4'), 1000000);
    assert.equal(appHelpers.contextWindowFor('glm-5'), 1000000);

    // Stale 200K entry in MODEL_WINDOW_CACHE or provider.contextWindow cannot downgrade 1M flagship models
    memLS.set(appHelpers.MODEL_WINDOW_CACHE, JSON.stringify({
      'claude-opus-4-5-20251101': 200000,
      'claude-opus-4-6': 200000,
      'glm-5': 200000,
    }));
    assert.equal(appHelpers.contextWindowFor('claude-opus-4-5-20251101'), 1000000);
    assert.equal(appHelpers.resolveEffectiveContextWindow({ model: 'claude-opus-4-5-20251101', contextWindow: 200000 }, { model: 'claude-opus-4-5-20251101' }), 1000000);
    assert.equal(appHelpers.resolveEffectiveContextWindow({ model: 'claude-opus-4-6', contextWindow: 200000 }, null), 1000000);

    const bigMsgs = [
      { id: '1', role: 'user', content: 'Goal ' + 'A'.repeat(180000), ts: 1000 },
      { id: '2', role: 'assistant', content: 'Done ' + 'B'.repeat(180000), ts: 2000 },
      { id: '3', role: 'user', content: 'Next ' + 'C'.repeat(200000), ts: 3000 },
      { id: '4', role: 'assistant', content: 'Ready.', ts: 4000 },
    ];
    const dig = appHelpers.buildLocalCompactDigest(bigMsgs, 2);
    assert.equal(dig.droppedCount, 2);
    assert.equal(dig.messages.length, 3);

    const autoFlowRes = await appHelpers.runCompactNowFlow({
      conv: { id: 'c850k', messages: bigMsgs },
      provider: { model: 'claude-opus-4-5-20251101', oauthProvider: 'claude:cli' },
      lastUsage: { context_tokens: 850000, prompt_tokens: 850000, model: 'claude-opus-4-5-20251101', convId: 'c850k' },
      keepTail: 2,
      trigger: 'pre-send-80pct',
    });
    assert.ok(autoFlowRes && autoFlowRes.beforeTokens >= 850000);
    assert.equal(autoFlowRes.contextWindow, 1000000);
    assert.ok(autoFlowRes.afterTokens < 250000, `expected <250K after compact, got ${autoFlowRes.afterTokens}`);
    assert.equal(autoFlowRes.nextUsage.compacted, true);

    const compactedUsage = {
      context_tokens: 180000,
      prompt_tokens: 180000,
      compacted: true,
      lastAutoCompact: { beforeTokens: 960000, afterTokens: 180000, contextWindow: 1000000, trigger: 'pre-turn-80pct', at: 5000 },
      convId: 'c1',
      model: 'grok-4.5',
      at: 5000,
    };
    const eff = appHelpers.effectiveUsageForConv(compactedUsage, { id: 'c1', messages: bigMsgs }, { model: 'grok-4.5' }, null);
    assert.equal(eff.context_tokens, 180000);
    assert.equal(appHelpers.formatContextPct(eff.context_tokens, 1000000), '18%');
  } finally {
    delete global.localStorage;
    fs.rmSync(tmpMjsDir, { recursive: true, force: true });
  }
});

test('v1.7.0 cliRunner.probeCliModels parses live grok models & swarm preserves CLI fields + merges worktrees cleanly', async () => {
  const parsed = cliRunner.parseCliModelsOutput('grok', [
    'You are logged in with grok.com.',
    '',
    'Default model: grok-4.7',
    '',
    'Available models:',
    '  * grok-4.7 (default)',
    '  - grok-4.7-build-fast',
    '  - grok-4.6',
    '  - grok-4.5',
  ].join('\n'));
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].id, 'grok-4.7');
  assert.equal(parsed[0].contextWindow, 1000000);
  assert.equal(parsed[0].recommended, true);
  assert.equal(parsed[1].contextWindow, 2000000);
  assert.equal(parsed[3].id, 'grok-4.5');
  assert.equal(parsed[3].contextWindow, 1000000);

  // Verify Swarm roster preserves CLI transport fields
  const roster = swarm.buildRoster({
    provider: {
      model: 'kimi-k3.1-pro',
      transport: 'cli',
      cliMode: true,
      cliId: 'kimi-code',
      cliBin: '/tmp/mock-kimi',
      cliKind: 'kimi',
      oauthProvider: 'kimi:kimi-cli',
    },
  });
  assert.equal(roster.length, 1);
  assert.equal(roster[0].cliMode, true);
  assert.equal(roster[0].cliId, 'kimi-code');

  // Verify multi-worker git worktree Swarm run completes with zero error status (and Round 1 error -> Round 2 retry heals)
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-swarm-wt-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'ci@akronlogic.com'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.name', 'Akron CI'], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# init\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir });

    let t1Calls = 0;
    const summary = await swarm.swarm('Build two independent modules', {
      cwd: repoDir,
      provider: { baseURL: 'https://api.example.com/v1', apiKey: 'test-k', model: 'claude-opus-5-5' },
      tasks: [
        { id: 't1', title: 'Alpha module', tier: 'heavy', isolation: 'worktree', owns: ['alpha.txt'], prompt: 'create alpha.txt' },
        { id: 't2', title: 'Beta module', tier: 'heavy', isolation: 'worktree', owns: ['beta.txt'], prompt: 'create beta.txt' },
      ],
      runAgent: async ({ messages, cwd: agentCwd }) => {
        const txt = String((messages[0] && messages[0].content) || '');
        if (/alpha\.txt/i.test(txt)) {
          t1Calls++;
          if (t1Calls === 1) throw new Error('transient model blip on round 1');
          fs.writeFileSync(path.join(agentCwd, 'alpha.txt'), 'alpha ok\n');
          return [{ role: 'assistant', content: 'Created alpha.txt' }];
        }
        if (/beta\.txt/i.test(txt)) {
          fs.writeFileSync(path.join(agentCwd, 'beta.txt'), 'beta ok\n');
          return [{ role: 'assistant', content: 'Created beta.txt' }];
        }
        return [{ role: 'assistant', content: 'Supervisor review complete: both modules verified.' }];
      },
    });

    assert.equal(summary.results.every((r) => r.status === 'done'), true);
    assert.equal(fs.readFileSync(path.join(repoDir, 'alpha.txt'), 'utf8'), 'alpha ok\n');
    assert.equal(fs.readFileSync(path.join(repoDir, 'beta.txt'), 'utf8'), 'beta ok\n');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
