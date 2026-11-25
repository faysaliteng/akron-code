'use strict';
// Entitlement resilience: a subscription agent account can answer plain chat
// while its agent/tool allowance is spent (verified live against Grok: a chat
// turn returns 200, the same turn with tools attached returns 402). The turn
// must degrade to the fenced text tool protocol instead of dying with a red
// banner — the same reason the Claude app keeps working when a route is capped.
//
// Locked in here:
//   1. isCreditExhausted() classifies 402 / "out of credit" prose and never
//      mistakes a rate limit or a context overflow for it.
//   2. A 402 on the tool-enabled request falls back to a tool-less request that
//      carries TEXT_TOOL_PROTOCOL, and the turn completes with a notice.
//   3. A 402 on every account is not retried with backoff (no 37 s stall).
const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-credit-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const llm = require(path.join(__dirname, '..', 'electron', 'llm.js'));
const catalog = require(path.join(__dirname, '..', 'electron', 'model-catalog.js'));

let pass = 0;
async function t(label, fn) {
  try { await fn(); pass++; console.log('  ok   ' + label); }
  catch (e) { process.exitCode = 1; console.log('  FAIL ' + label + '\n       ' + (e && e.message)); }
}

const CREDIT = 'This account is out of credit for that provider — the Grok Build allowance is 100% used this week; it resets 2026-12-01; prepaid balance is $0 and on-demand top-up is off';

// Answers plain chat, 402s any request that carries a native tools array.
function startServer({ reply = 'TEXTMODE-REPLY-OK' } = {}) {
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      bodies.push(body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (hasTools) {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: CREDIT } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: reply } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${srv.address().port}/v1/`,
      bodies,
      close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
    });
  }));
}

function providerFor(url, model, extra) {
  return {
    baseURL: url, apiKey: 'test', model, oauthProvider: 'testprov:acct',
    maxTokens: 4096, supportsTools: true, ...(extra || {}),
  };
}

const systemText = (body) => String(((body.messages || []).find((m) => m.role === 'system') || {}).content || '');

(async () => {
  console.log('Entitlement resilience');

  await t('isCreditExhausted matches 402 but not rate limits or context overflow', async () => {
    const yes = [
      new Error('LLM 402: ' + CREDIT),
      new Error('LLM 402: Payment Required'),
      new Error('insufficient_quota: exceeded your current quota'),
      new Error('your credit balance is too low'),
    ];
    const err402 = new Error('provider said no');
    err402.status = 402;
    yes.push(err402);
    for (const e of yes) assert.strictEqual(llm.isCreditExhausted(e), true, e.message);
    const no = [
      new Error('LLM 429: rate limit exceeded'),
      new Error('LLM 400: This model\'s maximum context length is 8192 tokens'),
      new Error('LLM 401: invalid api key'),
      new Error('LLM 500: internal error'),
    ];
    for (const e of no) assert.strictEqual(llm.isCreditExhausted(e), false, e.message);
  });

  await t('a 402 on the tool request degrades to text mode and the turn completes', async () => {
    catalog.register('testprov', [{ id: 'credit-model', label: 'Credit Model', contextWindow: 128000 }]);
    const server = await startServer();
    try {
      const events = [];
      const started = Date.now();
      const out = await llm.runAgent({
        provider: providerFor(server.url, 'credit-model'),
        messages: [{ role: 'user', content: 'Write a small file and confirm.' }],
        emit: (e) => events.push(e),
        turnStart: false,
      });
      const elapsed = Date.now() - started;
      assert.ok(server.bodies.length >= 2, 'expected a tool attempt then a fallback, got ' + server.bodies.length);
      assert.ok(Array.isArray(server.bodies[0].tools) && server.bodies[0].tools.length, 'the first request should carry native tools');
      const fallback = server.bodies.find((b) => !Array.isArray(b.tools) || !b.tools.length);
      assert.ok(fallback, 'expected a tool-less retry');
      assert.ok(/TOOL PROTOCOL/.test(systemText(fallback)), 'the text tool protocol must be injected:\n' + systemText(fallback).slice(0, 400));
      const notice = events.find((e) => e.type === 'notice' && /text mode/i.test(e.text || ''));
      assert.ok(notice, 'expected a prose notice about text mode: ' + JSON.stringify(events.filter((e) => e.type === 'notice').map((e) => e.text)));
      assert.ok(!/<[a-z]/i.test(notice.text), 'the notice must not leak markup: ' + notice.text);
      const last = [...out].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /TEXTMODE-REPLY-OK/.test(last.content), 'reply missing');
      assert.ok(!events.some((e) => e.type === 'error'), 'the turn must not surface an error');
      assert.ok(elapsed < 10000, 'credit exhaustion must not sit through the backoff ladder (' + elapsed + ' ms)');
    } finally { await server.close(); }
  });

  await t('the text tool protocol still edits a file after the degrade', async () => {
    catalog.register('testprov', [{ id: 'credit-model', label: 'Credit Model', contextWindow: 128000 }]);
    // First (tool-less) request answers with a fenced Write call; the second
    // (after the tool result) answers normally.
    const script = [
      '```tool\n{"name":"Write","arguments":{"path":"' + path.join(TMP, 'degraded.txt') + '","content":"DEGRADED-OK"}}\n```',
      'Wrote it.',
    ];
    const bodies = [];
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        let body = {};
        try { body = JSON.parse(raw); } catch (_) {}
        bodies.push(body);
        if (Array.isArray(body.tools) && body.tools.length) {
          res.writeHead(402, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: CREDIT } }));
          return;
        }
        // Only user/tool turns count: TEXT_TOOL_PROTOCOL in the system prompt
        // mentions "TOOL RESULT" itself.
        const hasResult = (body.messages || []).some((m) => m.role !== 'system' && /^\s*TOOL RESULT/.test(String(m.content || '')));
        const text = hasResult ? script[1] : script[0];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }) + '\n\n');
        res.end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/v1/`;
    try {
      const events = [];
      await llm.runAgent({
        provider: providerFor(url, 'credit-model'),
        messages: [{ role: 'user', content: 'Write degraded.txt' }],
        emit: (e) => events.push(e),
        turnStart: false,
        approveTool: async () => ({ approved: true }),
        cwd: TMP,
      }).catch((e) => { throw new Error('run failed: ' + e.message); });
      const target = path.join(TMP, 'degraded.txt');
      assert.ok(fs.existsSync(target), 'the text-protocol Write did not run');
      assert.strictEqual(fs.readFileSync(target, 'utf8').trim(), 'DEGRADED-OK');
      assert.ok(!events.some((e) => e.type === 'error'), 'no error banner');
    } finally { await new Promise((r) => { srv.closeAllConnections(); srv.close(r); }); }
  });

  await t('a 402 on the tool-less retry too ends the turn in prose, not a red banner', async () => {
    catalog.register('testprov', [{ id: 'credit-model', label: 'Credit Model', contextWindow: 128000 }]);
    // The account is fully spent: every request shape 402s.
    const srv = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        res.writeHead(402, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: CREDIT } }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/v1/`;
    try {
      const events = [];
      const started = Date.now();
      let threw = null;
      let out = null;
      try {
        out = await llm.runAgent({
          provider: providerFor(url, 'credit-model'),
          messages: [{ role: 'user', content: 'Create the file.' }],
          emit: (e) => events.push(e),
          turnStart: false,
        });
      } catch (e) { threw = e; }
      const elapsed = Date.now() - started;
      assert.strictEqual(threw, null, 'a spent allowance must not throw: ' + (threw && threw.message));
      assert.ok(!events.some((e) => e.type === 'error'), 'no error banner: ' + JSON.stringify(events.filter((e) => e.type === 'error')));
      const notices = events.filter((e) => e.type === 'notice').map((e) => String(e.text || ''));
      assert.ok(notices.some((x) => /Plain chat is unavailable/i.test(x)), 'expected the stop notice: ' + JSON.stringify(notices));
      for (const n of notices) assert.ok(!/<[a-z!]/i.test(n), 'notice must not leak markup: ' + n);
      const last = [...(out || [])].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /could not run this turn/i.test(String(last.content)), 'expected a prose assistant message: ' + JSON.stringify(last));
      assert.ok(/out of credit|allowance|402/i.test(String(last.content)), 'the message must carry the real reason: ' + String(last.content));
      assert.ok(!/token limit reached|retrying with/i.test(JSON.stringify(events) + JSON.stringify(out)), 'no raw token-limit wording');
      assert.ok(elapsed < 10000, 'a spent allowance must fail fast (' + elapsed + ' ms)');
      assert.ok(events.some((e) => e.type === 'done'), 'the turn must still close cleanly');
    } finally { await new Promise((r) => { srv.closeAllConnections(); srv.close(r); }); }
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + (process.exitCode ? 'at least 1' : '0') + ' failed');
})();
