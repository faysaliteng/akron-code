'use strict';
// Role pools + provider gate + swarm, end to end against a fake
// OpenAI-compatible gateway (no network). Exercises the real llm.js loop,
// tools.js executors, swarm.js and orch-router.js.
//
//   node test/pools-e2e.test.js

process.env.HELIO_BACKOFF_MS = '50';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const gate = require('../electron/provider-gate');
const router = require('../electron/orch-router');
const llm = require('../electron/llm');
const swarm = require('../electron/swarm');

let passed = 0, failed = 0;
const failures = [];
async function test(name, fn) {
  // Let requests a previous test abandoned (aborted client, delayed server)
  // drain so per-model inflight counts start clean.
  await new Promise((r) => setTimeout(r, 120));
  gate.reset();
  try { await fn(); passed++; console.log('  ✓ ' + name); }
  catch (e) { failed++; failures.push({ name, e }); console.log('  ✗ ' + name + '\n      ' + (e && e.stack || e).toString().split('\n').slice(0, 4).join('\n      ')); }
}

// ---------- fake gateway ----------
const calls = [];
const inflight = new Map();
const maxInflight = new Map();
let behavior = {}; // model -> fn(body) => {status, json} | {sse:[chunks]} | {text} | {tool:{name,args}} | {delay}
function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
function textChunks(model, text) {
  return [
    { model, choices: [{ delta: { role: 'assistant', content: text } }] },
    { model, choices: [{ delta: {}, finish_reason: 'stop' }] },
    { model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
  ];
}
function toolChunks(model, name, args, id) {
  const a = JSON.stringify(args);
  return [
    { model, choices: [{ delta: { tool_calls: [{ index: 0, id: id || 'call_' + Math.random().toString(36).slice(2, 8), type: 'function', function: { name, arguments: '' } }] } }] },
    { model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(0, 10) } }] } }] },
    { model, choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: a.slice(10) } }] } }] },
    { model, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const j = JSON.parse(body || '{}');
    const model = j.model;
    calls.push({ model, msgs: j.messages, tools: (j.tools || []).map((t) => t.function && t.function.name) });
    inflight.set(model, (inflight.get(model) || 0) + 1);
    maxInflight.set(model, Math.max(maxInflight.get(model) || 0, inflight.get(model)));
    const done = () => inflight.set(model, inflight.get(model) - 1);
    try {
      const fn = behavior[model] || behavior['*'];
      if (!fn) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `Model '${model}' is not in the catalog.` } })); return done(); }
      const r = await fn(j);
      if (r.delay) await new Promise((ok) => setTimeout(ok, r.delay));
      if (r.status) { res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json || { error: { message: 'err' } })); return done(); }
      if (r.sse) { sse(res, r.sse); return done(); }
      if (r.tool) { sse(res, toolChunks(model, r.tool.name, r.tool.args)); return done(); }
      sse(res, textChunks(model, r.text || 'ok'));
      done();
    } catch (e) { res.writeHead(500); res.end(String(e)); done(); }
  });
});

const lastUser = (b) => { const u = [...(b.messages || [])].reverse().find((m) => m.role === 'user'); return u ? String(typeof u.content === 'string' ? u.content : JSON.stringify(u.content)) : ''; };
const lastRole = (b) => { const m = (b.messages || [])[b.messages.length - 1]; return m && m.role; };

(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const port = server.address().port;
  const BASE = `http://localhost:${port}/v1`; // provider says localhost, gateway says 127.0.0.1
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-pools-'));
  const provider = { baseURL: BASE, apiKey: 'k', model: 'auto', supportsTools: true, maxTokens: 2000 };
  const pools = {
    enabled: true,
    gateway: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: '' },
    roles: {
      planner: { maxConcurrent: 1, models: [{ model: 'plan-a', max: 1 }, { model: 'plan-b', max: 2 }] },
      coder: { maxConcurrent: 3, models: [{ model: 'code-rl', max: 1 }, { model: 'code-a', max: 1 }, { model: 'code-b', max: 3 }] },
      vision: { maxConcurrent: 1, models: ['vis-a @1'] },
      fast: { maxConcurrent: 4, models: [{ model: 'fast-a', max: 4 }] },
      longctx: { maxConcurrent: 1, models: [{ model: 'long-a', max: 1 }] },
    },
  };
  const orch = { enabled: false, providers: [], activeIndex: 0, pools };

  console.log('Router:');
  await test('poolsActive matches localhost ↔ 127.0.0.1 and ignores subscription providers', () => {
    assert.ok(router.poolsActive(orch, provider));
    assert.ok(!router.poolsActive(orch, { ...provider, baseURL: 'https://api.groq.com/openai/v1' }));
    assert.ok(!router.poolsActive(orch, { oauthProvider: 'claude:x', model: 'claude-opus' }));
    assert.ok(!router.poolsActive({ ...orch, pools: { ...pools, enabled: false } }, provider));
  });
  await test('resolve keeps order, per-model max, gateway key fallback', () => {
    const rows = router.resolve(orch, 'coder', provider);
    assert.deepStrictEqual(rows.map((r) => r.model), ['code-rl', 'code-a', 'code-b']);
    assert.strictEqual(rows[0].maxConcurrent, 1);
    assert.strictEqual(rows[0].apiKey, 'k');
    assert.deepStrictEqual(router.resolve(orch, 'vision', provider).map((r) => [r.model, r.maxConcurrent]), [['vis-a', 1]]);
  });
  await test('aliases and tiers map to roles; aliases are never model ids', () => {
    assert.strictEqual(router.aliasRole('haiku'), 'fast');
    assert.strictEqual(router.aliasRole('opus'), 'planner');
    assert.strictEqual(router.aliasRole('inherit'), null);
    assert.strictEqual(router.tierToRole('small'), 'fast');
    assert.strictEqual(router.tierToRole('critical'), 'planner');
    assert.strictEqual(router.normalizeRole('Implementer'), 'coder');
  });
  await test('chainFor: selected pool model fails over down its own pool; auto → coder pool', () => {
    assert.deepStrictEqual(router.chainFor(orch, { ...provider, model: 'code-a' }).map((r) => r.model), ['code-a', 'code-b', 'code-rl']);
    assert.deepStrictEqual(router.chainFor(orch, provider).map((r) => r.model), ['code-rl', 'code-a', 'code-b']);
    assert.deepStrictEqual(router.chainFor(orch, { ...provider, model: 'other-x' }).map((r) => r.model), ['other-x', 'code-rl', 'code-a', 'code-b']);
  });
  await test('freellmPreset has the five jobs in the documented order', () => {
    const p = router.freellmPreset();
    assert.deepStrictEqual(Object.keys(p.roles), ['planner', 'coder', 'vision', 'fast', 'longctx']);
    assert.strictEqual(p.roles.planner.models[0].model, 'gpt-5.6-luna');
    assert.strictEqual(p.roles.coder.models[0].model, 'qwen3.8-flash');
    assert.strictEqual(p.roles.fast.models[0].model, 'qwen3.8-27b');
  });

  console.log('Gate:');
  await test('retryHintMs reads retryAtMs and "reset ~86s" / "~2m"', () => {
    assert.ok(Math.abs(gate.retryHintMs(`{"retryAtMs":${Date.now() + 30000}}`) - 30000) < 1500);
    assert.strictEqual(gate.retryHintMs('Soonest reset ~86s.'), 86000);
    assert.strictEqual(gate.retryHintMs('Soonest cooldown reset ~2m. Attempt'), 120000);
  });
  await test('order: usable first, cooling by soonest, dead last; capacity spreads', () => {
    const L = [{ baseURL: 'x', model: 'a', maxConcurrent: 1 }, { baseURL: 'x', model: 'b' }, { baseURL: 'x', model: 'c' }];
    gate.rateLimited(L[0], 60000);
    gate.markDead(L[1], 'gone');
    assert.deepStrictEqual(gate.order(L, 0), [2, 0, 1]);
    gate.reset();
    const rel = gate.tryAcquire(L[0]);
    assert.ok(rel && !gate.tryAcquire(L[0]));
    assert.deepStrictEqual(gate.order(L, 0), [1, 2, 0]);
    rel();
    assert.ok(gate.hasCapacity(L[0]));
  });

  console.log('Failover:');
  behavior = {
    'code-rl': () => ({ status: 429, json: { error: { message: 'All models rate-limited', retryAtMs: Date.now() + 60000 } } }),
    'gone': () => ({ status: 404, json: { error: { message: "Model 'gone' is not in the catalog." } } }),
    'code-a': () => ({ text: 'hello from code-a', delay: 120 }),
    'code-b': () => ({ text: 'hello from code-b', delay: 120 }),
  };
  await test('429 row cools for everyone, 404 row dies, request lands on a healthy row', async () => {
    calls.length = 0;
    const list = [{ baseURL: BASE + '/', model: 'code-rl', apiKey: 'k' }, { baseURL: BASE + '/', model: 'gone', apiKey: 'k' }, { baseURL: BASE + '/', model: 'code-a', apiKey: 'k' }].map(llm.normalizeProvider);
    let idx = 0;
    const out = await llm.chatWithFailover({ list, getIndex: () => idx, setIndex: (i) => { idx = i; }, messages: [{ role: 'user', content: 'hi' }] });
    assert.strictEqual(out.content, 'hello from code-a');
    assert.ok(gate.coolingFor(list[0]) > 50000, 'retryAtMs respected');
    assert.ok(gate.isDead(list[1]));
    calls.length = 0;
    const out2 = await llm.chatWithFailover({ list, getIndex: () => 0, getHome: () => 0, setIndex: () => {}, messages: [{ role: 'user', content: 'again' }] });
    assert.strictEqual(out2.content, 'hello from code-a');
    assert.deepStrictEqual(calls.map((c) => c.model), ['code-a'], 'cooling + dead rows are skipped without a request');
  });
  await test('parallel callers spread across rows by maxConcurrent', async () => {
    maxInflight.clear();
    const list = [{ baseURL: BASE + '/', model: 'code-a', apiKey: 'k', maxConcurrent: 1 }, { baseURL: BASE + '/', model: 'code-b', apiKey: 'k', maxConcurrent: 3 }].map(llm.normalizeProvider);
    const outs = await Promise.all([0, 1, 2, 3].map(() => llm.chatWithFailover({ list, getIndex: () => 0, getHome: () => 0, setIndex: () => {}, messages: [{ role: 'user', content: 'p' }] })));
    assert.strictEqual(maxInflight.get('code-a'), 1);
    assert.ok(outs.some((o) => /code-b/.test(o.content)));
  });

  await test('a row that "lacks tool-calling" is remembered and skipped for tool requests', async () => {
    calls.length = 0;
    behavior['notools'] = () => ({ status: 429, json: { error: { message: 'All models exhausted: 1 route checked (1 model lacks tool-calling).' } } });
    behavior['withtools'] = () => ({ text: 'tooled' });
    const list = ['notools', 'withtools'].map((model) => llm.normalizeProvider({ baseURL: BASE, model, apiKey: 'k' }));
    const tools = [{ type: 'function', function: { name: 'Read', parameters: { type: 'object', properties: {} } } }];
    for (let i = 0; i < 3; i++) await llm.chatWithFailover({ list, getIndex: () => 0, getHome: () => 0, setIndex: () => {}, tools, messages: [{ role: 'user', content: 'x' }] });
    assert.ok(gate.isDead(list[0]));
    assert.strictEqual(calls.filter((c) => c.model === 'notools').length, 1, 'asked once, then skipped');
  });

  console.log('Parsing:');
  await test('native-mode text fallback: <tool_call>, <function=…><parameter=…>, bare JSON; json fences ignored', () => {
    const p = llm.parseTextToolCalls;
    const a = p('<tool_call>{"name":"Write","arguments":{"path":"a.txt","content":"A"}}</tool_call>', { nativeFallback: true });
    assert.strictEqual(a[0].function.name, 'Write');
    const b = p('<tool_call>\n<function=Write>\n<parameter=path>\nb.txt\n</parameter>\n<parameter=content>\nline1\nline2\n</parameter>\n</function>\n</tool_call>', { nativeFallback: true });
    assert.deepStrictEqual(JSON.parse(b[0].function.arguments), { path: 'b.txt', content: 'line1\nline2' });
    const c = p('{"name":"Bash","arguments":{"command":"ls"}}', { nativeFallback: true });
    assert.strictEqual(c[0].function.name, 'Bash');
    const d = p('Example:\n```json\n{"name":"Write","arguments":{"path":"x"}}\n```', { nativeFallback: true });
    assert.strictEqual(d.length, 0);
    const e = p('<think>maybe <tool_call>{"name":"Bash","arguments":{}}</tool_call></think>done', { nativeFallback: true });
    assert.strictEqual(e.length, 0);
  });
  await test('stream assembly: index-less fragments, missing ids, full-name resend', async () => {
    behavior['frag'] = () => ({ sse: [
      { choices: [{ delta: { tool_calls: [{ function: { name: 'Write', arguments: '{"path":"f.txt",' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { name: 'Write', arguments: '"content":"F"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ] });
    const m = await llm.chatWithFailover({ list: [llm.normalizeProvider({ baseURL: BASE, model: 'frag', apiKey: 'k' })], getIndex: () => 0, setIndex: () => {}, messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(m.tool_calls.length, 1);
    assert.strictEqual(m.tool_calls[0].function.name, 'Write');
    assert.deepStrictEqual(JSON.parse(m.tool_calls[0].function.arguments), { path: 'f.txt', content: 'F' });
    assert.ok(m.tool_calls[0].id, 'id minted');
  });
  await test('mid-stream error event fails over instead of returning an empty success', async () => {
    behavior['errstream'] = () => ({ sse: [{ error: { message: 'upstream died', code: 503 } }] });
    behavior['okstream'] = () => ({ text: 'recovered' });
    const list = ['errstream', 'okstream'].map((model) => llm.normalizeProvider({ baseURL: BASE, model, apiKey: 'k' }));
    const m = await llm.chatWithFailover({ list, getIndex: () => 0, setIndex: () => {}, messages: [{ role: 'user', content: 'x' }] });
    assert.strictEqual(m.content, 'recovered');
  });

  console.log('Agent loop with pools:');
  await test('main turn on the gateway runs on the coder pool; Task with model "haiku" runs on the fast pool', async () => {
    calls.length = 0;
    behavior = {
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl', retryAtMs: Date.now() + 60000 } } }),
      'code-a': (b) => {
        if (lastRole(b) === 'tool') return { text: 'parent done' };
        return { tool: { name: 'Task', args: { description: 'scan files', prompt: 'list files', subagent_type: 'Explore' } } };
      },
      'fast-a': () => ({ text: 'explored: nothing here' }),
    };
    const events = [];
    const out = await llm.runAgent({ provider, orchestrator: orch, messages: [{ role: 'user', content: 'delegate a scan' }], cwd: tmp, emit: (e) => events.push(e) });
    const models = calls.map((c) => c.model);
    assert.ok(!models.includes('haiku'), 'alias never sent as a model id: ' + models.join(','));
    assert.ok(models.includes('fast-a'), 'Explore (haiku) → fast pool: ' + models.join(','));
    assert.ok(models.includes('code-a'));
    const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
    assert.strictEqual(last.content, 'parent done');
    assert.ok(!events.some((e) => e.type === 'done' && e.subagent), 'child done never forwarded');
    const sub = events.filter((e) => e.type === 'subagent');
    assert.ok(sub.some((e) => e.status === 'done' && e.jobRole === 'fast'));
  });
  await test('two Task calls in one message run concurrently', async () => {
    calls.length = 0;
    let concurrent = 0, peak = 0;
    behavior = {
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl', retryAtMs: Date.now() + 60000 } } }),
      'code-a': (b) => {
        if (/SUB-TASK/.test(lastUser(b))) return (async () => { concurrent++; peak = Math.max(peak, concurrent); await new Promise((r) => setTimeout(r, 250)); concurrent--; return { text: 'sub ok' }; })();
        if (lastRole(b) === 'tool') return { text: 'both done' };
        return { sse: [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: 't1', function: { name: 'Task', arguments: JSON.stringify({ description: 'one', prompt: 'SUB-TASK one' }) } }] } }] },
          { choices: [{ delta: { tool_calls: [{ index: 1, id: 't2', function: { name: 'Task', arguments: JSON.stringify({ description: 'two', prompt: 'SUB-TASK two' }) } }] } }] },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ] };
      },
      'code-b': (b) => behavior['code-a'](b),
    };
    const out = await llm.runAgent({ provider, orchestrator: orch, messages: [{ role: 'user', content: 'two things' }], cwd: tmp, emit: () => {} });
    assert.strictEqual([...out].reverse().find((m) => m.role === 'assistant' && m.content).content, 'both done');
    assert.strictEqual(peak, 2, 'peak concurrency ' + peak);
  });
  await test('sub-agent provider failure becomes a tool result, not a dead parent turn', async () => {
    behavior = {
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl', retryAtMs: Date.now() + 60000 } } }),
      'code-a': (b) => (lastRole(b) === 'tool' ? { text: 'parent survived: ' + String(b.messages[b.messages.length - 1].content).slice(0, 40) } : { tool: { name: 'Task', args: { description: 'doomed', prompt: 'x', model: 'nonexistent-model-zz' } } }),
    };
    const save = process.env.HELIO_BACKOFF_MS; process.env.HELIO_BACKOFF_MS = '1';
    const out = await llm.runAgent({ provider, orchestrator: orch, messages: [{ role: 'user', content: 'go' }], cwd: tmp, emit: () => {} });
    process.env.HELIO_BACKOFF_MS = save;
    const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
    assert.ok(/parent survived/.test(last.content), last.content);
  });
  await test('Stop (abort) halts the run before queued tool calls execute', async () => {
    const ac = new AbortController();
    const marker = path.join(tmp, 'should-not-exist.txt');
    behavior = {
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl', retryAtMs: Date.now() + 60000 } } }),
      'code-a': () => { setTimeout(() => ac.abort(), 5); return { delay: 60, tool: { name: 'Write', args: { file_path: marker, content: 'x' } } }; },
    };
    let threw = false;
    try { await llm.runAgent({ provider, orchestrator: orch, messages: [{ role: 'user', content: 'write' }], cwd: tmp, emit: () => {}, signal: ac.signal }); } catch (e) { threw = /abort/i.test(e.message); }
    assert.ok(threw, 'aborted');
    assert.ok(!fs.existsSync(marker), 'tool did not run after Stop');
  });

  console.log('Swarm with pools:');
  await test('supervisor on Planner, workers on Coder with failover, files written, board used, merge read-only', async () => {
    calls.length = 0;
    maxInflight.clear();
    const plan = { subtasks: [
      { id: 't1', title: 'api', tier: 'heavy', prompt: 'Write api.txt with the text API', owns: ['api.txt'] },
      { id: 't2', title: 'ui', tier: 'heavy', prompt: 'Write ui.txt with the text UI', owns: ['ui.txt'] },
      { id: 't3', title: 'docs', tier: 'small', prompt: 'Write docs.txt with the text DOCS', owns: ['docs.txt'] },
    ], synthesis: 'list files' };
    const worker = (b) => {
      const u = String(b.messages.find((m) => m.role === 'user').content);
      const file = /Write (\w+\.txt)/.exec(u)[1];
      const tools = b.messages.filter((m) => m.role === 'tool').length;
      if (tools === 0) return { tool: { name: 'swarm_post_message', args: { text: 'starting ' + file } } };
      if (tools === 1) return { tool: { name: 'Write', args: { file_path: path.join(tmp, file), content: file.toUpperCase() } } };
      if (tools === 2) return { tool: { name: 'swarm_post_message', args: { text: 'done ' + file } } };
      return { text: 'created ' + file, delay: 80 };
    };
    behavior = {
      'plan-a': (b) => {
        const u = lastUser(b);
        if (/decompose|Decompose/.test(u)) return { text: JSON.stringify(plan) };
        if (/SUBTASK RESULTS/.test(u)) {
          assert.ok(!(b.tools || []).some((t) => t.function && /^(Write|Edit)$/.test(t.function.name)), 'review cannot write');
          return { text: 'FINAL: api.txt ui.txt docs.txt' };
        }
        return { text: '?' };
      },
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl', retryAtMs: Date.now() + 60000 } } }),
      'code-a': worker,
      'code-b': worker,
      'fast-a': worker,
    };
    const runner = (subOpts) => llm.runAgent({ provider, orchestrator: orch, cwd: tmp, emit: () => {}, ...subOpts });
    const events = [];
    const res = await swarm.swarm('build three files', { runAgent: runner, provider, orchestrator: orch, cwd: tmp, emit: (e) => events.push(e), concurrency: 4 });
    assert.strictEqual(res.pools, true);
    assert.strictEqual(res.supervisor.model, 'plan-a');
    for (const f of ['api.txt', 'ui.txt', 'docs.txt']) assert.ok(fs.existsSync(path.join(tmp, f)), f + ' written');
    assert.ok(/FINAL/.test(res.answer));
    const byModel = {};
    for (const r of res.results) byModel[r.title] = r.model;
    assert.strictEqual(byModel.docs, 'fast-a', 'small tier → fast pool');
    assert.ok(['code-a', 'code-b'].includes(byModel.api), 'heavy → coder pool, past the 429 row: ' + byModel.api);
    assert.ok((maxInflight.get('code-a') || 0) <= 1, 'code-a max 1 respected');
    assert.ok(res.board.length >= 4, 'board used');
    assert.ok(!calls.some((c) => c.model === 'code-rl' && calls.filter((x) => x.model === 'code-rl').length > 1), 'rate-limited row hit at most once across all workers');
    const planCall = calls.find((c) => c.model === 'plan-a');
    assert.ok(!planCall.tools.includes('Write') && !planCall.tools.includes('Bash'), 'plan step is read-only');
  });
  await test('mention wake-up: a worker addressed by @name gets another round', async () => {
    let woke = false;
    behavior = {
      'plan-a': (b) => (/SUBTASK RESULTS/.test(lastUser(b)) ? { text: 'merged' } : { text: JSON.stringify({ subtasks: [{ id: 'a', title: 'alpha', prompt: 'ALPHA' }, { id: 'b', title: 'beta', prompt: 'BETA' }] }) }),
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl', retryAtMs: Date.now() + 60000 } } }),
      'code-a': (b) => {
        const u = String(b.messages.find((m) => m.role === 'user').content);
        const tools = b.messages.filter((m) => m.role === 'tool').length;
        if (/addressed you on the board/.test(u)) { woke = true; return tools ? { text: 'answered' } : { tool: { name: 'swarm_post_message', args: { text: 'reply to alpha' } } }; }
        if (/ALPHA/.test(u)) return tools ? { text: 'alpha done' } : { tool: { name: 'swarm_post_message', args: { text: '@beta which port do you use?' } } };
        return tools ? { text: 'beta done' } : { tool: { name: 'swarm_post_message', args: { text: 'beta started' } } };
      },
    };
    behavior['code-b'] = behavior['code-a'];
    const runner = (subOpts) => llm.runAgent({ provider, orchestrator: orch, cwd: tmp, emit: () => {}, ...subOpts });
    const res = await swarm.swarm('two workers', { runAgent: runner, provider, orchestrator: orch, cwd: tmp, emit: () => {} });
    assert.ok(woke, 'beta was woken by the @mention');
    assert.ok(res.results.find((r) => r.title === 'beta').round >= 2);
  });
  await test('swarm stops when the signal aborts', async () => {
    const ac = new AbortController();
    behavior = {
      'plan-a': () => ({ text: JSON.stringify({ subtasks: [{ title: 'slow1', prompt: 'S1' }, { title: 'slow2', prompt: 'S2' }] }) }),
      'code-rl': () => ({ status: 429, json: { error: { message: 'rl' } } }),
      'code-a': () => ({ delay: 400, text: 'late' }),
      'code-b': () => ({ delay: 400, text: 'late' }),
    };
    const runner = (subOpts) => llm.runAgent({ provider, orchestrator: orch, cwd: tmp, emit: () => {}, ...subOpts });
    setTimeout(() => ac.abort(), 150);
    let err = null;
    const t0 = Date.now();
    try { await swarm.swarm('stop me', { runAgent: runner, provider, orchestrator: orch, cwd: tmp, emit: () => {}, signal: ac.signal }); } catch (e) { err = e; }
    assert.ok(err && /abort/i.test(err.message), 'threw aborted');
    assert.ok(Date.now() - t0 < 2000, 'returned promptly');
  });

  server.close();
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed) { for (const f of failures) console.log(' - ' + f.name + ': ' + (f.e && f.e.message)); process.exit(1); }
  process.exit(0);
})();
