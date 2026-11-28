'use strict';
// Context-window resilience: an oversized prompt must never stall or kill the
// turn. Three behaviours are locked in here:
//   1. isContextOverflow() classifies the provider prose (and never mistakes a
//      rate limit for it), so the 429 backoff is not spent on a 400.
//   2. chunkText() splits one huge message on paragraph/line/word boundaries and
//      the run merges the part answers into one reply.
//   3. A provider that still rejects the prompt makes chatRound() compact the
//      history (or trim the biggest result) and retry — the turn completes.
const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ctx-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const llm = require(path.join(__dirname, '..', 'electron', 'llm.js'));
const catalog = require(path.join(__dirname, '..', 'electron', 'model-catalog.js'));

let pass = 0;
async function t(label, fn) {
  try { await fn(); pass++; console.log('  ok   ' + label); }
  catch (e) { console.log('  FAIL ' + label + ' :: ' + (e && e.stack || e)); process.exitCode = 1; }
}

// A gateway that rejects any prompt over `limit` chars with the prose providers
// actually send, and answers otherwise with a short streamed reply.
function startServer({ limit = Infinity, reply = 'ok' } = {}) {
  const seen = [];
  const bodies = [];
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      bodies.push(body);
      const chars = (body.messages || []).reduce((n, m) => n + String(m.content || '').length, 0);
      seen.push(chars);
      if (chars > limit) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `This model's maximum context length is 8192 tokens. Your prompt is too long: ${chars} chars` } }));
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
      seen,
      bodies,
      close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
    });
  }));
}

function providerFor(url, model) {
  return { baseURL: url, apiKey: 'test', model, oauthProvider: 'testprov:acct', maxTokens: 4096, supportsTools: false };
}

(async () => {
  console.log('Context window resilience');

  await t('isContextOverflow matches provider prose, not rate limits', async () => {
    const yes = [
      "LLM 400: This model's maximum context length is 8192 tokens",
      'LLM 400: prompt is too long: 260000 tokens > 200000 maximum',
      'LLM 400: input token count exceeds the maximum',
      'LLM 400: reduce the length of the messages',
      'LLM 422: request is too large for this model',
      'LLM 400: context_length_exceeded',
      'LLM 400: {"error":{"code":400,"message":"request (35738 tokens) exceeds the available context size (16384 tokens), try increasing it","type":"exceed_context_size_error"}}',
      'LLM 400: exceed_context_size_error',
    ];
    for (const m of yes) assert.strictEqual(llm.isContextOverflow(new Error(m)), true, m);
    const no = [
      'LLM 429: rate limit exceeded',
      'LLM 400: max_tokens is too large',
      'LLM 500: internal error',
      'LLM 401: invalid api key',
    ];
    for (const m of no) assert.strictEqual(llm.isContextOverflow(new Error(m)), false, m);
  });

  await t('chunkText splits on boundaries and loses nothing', async () => {
    const doc = ('Alpha paragraph. '.repeat(40) + '\n\n') + ('Beta line.\n'.repeat(200)) + ('gamma '.repeat(4000));
    const parts = llm.chunkText(doc, 4000);
    assert.ok(parts.length > 3, 'expected several parts, got ' + parts.length);
    for (const p of parts) assert.ok(p.length <= 4000, 'part over the limit: ' + p.length);
    assert.strictEqual(parts.join('').replace(/\s+/g, ''), doc.replace(/\s+/g, ''));
    assert.deepStrictEqual(llm.chunkText('', 100), ['']);
  });

  await t('an oversized message is processed in parts (never amputated)', async () => {
    catalog.register('testprov', [{ id: 'tiny-window', label: 'Tiny', contextWindow: 32000 }]);
    const server = await startServer({ reply: 'ack' });
    try {
      const doc = 'PARA '.repeat(30000); // 150k chars > 2 x 60% of the 32k budget
      const events = [];
      const out = await llm.runAgent({
        provider: providerFor(server.url, 'tiny-window'),
        messages: [{ role: 'user', content: doc }],
        emit: (e) => events.push(e),
        turnStart: false,
      });
      const notice = events.find((e) => e.type === 'notice' && /parts/.test(e.text || ''));
      assert.ok(notice, 'expected a "handled in N parts" notice');
      assert.ok(server.seen.length >= 2, 'expected several provider calls, got ' + server.seen.length);
      const last = [...out].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /ack/.test(last.content), 'merged reply missing: ' + (last && last.content));
      assert.ok(out.some((m) => m.role === 'user' && m.content === doc), 'the original message must be preserved in the transcript');
      const done = events.filter((e) => e.type === 'done');
      assert.strictEqual(done.length, 1, 'exactly one done event for the turn');
      assert.ok(done[0].usage && done[0].usage.total_tokens > 0, 'usage is summed across parts');
    } finally { await server.close(); }
  });

  await t('a rejected prompt compacts the history and retries instead of dying', async () => {
    catalog.register('testprov', [{ id: 'medium-window', label: 'Medium', contextWindow: 32000 }]);
    // Budget for 32k ≈ 70.7k chars; the server refuses anything over 30k, so the
    // run has to drop earlier turns before it can proceed.
    const server = await startServer({ limit: 30000, reply: 'recovered' });
    try {
      const messages = [{ role: 'user', content: 'Build the thing.' }];
      for (let i = 0; i < 20; i++) {
        messages.push({ role: 'assistant', content: `Step ${i}: ` + 'x'.repeat(1000) });
        messages.push({ role: 'user', content: `tool output ${i}: ` + 'y'.repeat(1000) });
      }
      messages.push({ role: 'user', content: 'Now finish it.' });
      const events = [];
      const out = await llm.runAgent({
        provider: providerFor(server.url, 'medium-window'),
        messages,
        emit: (e) => events.push(e),
        turnStart: false,
      });
      // The first request exceeded the server limit; a later one fit.
      assert.ok(server.seen.some((n) => n > 30000), 'expected the oversized attempt first');
      assert.ok(server.seen.some((n) => n <= 30000), 'expected a compacted retry that fits');
      const notice = events.find((e) => e.type === 'notice' && /context window/.test(e.text || ''));
      assert.ok(notice, 'expected a compaction notice: ' + JSON.stringify(events.filter((e) => e.type === 'notice').map((e) => e.text)));
      const last = [...out].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /recovered/.test(last.content), 'reply missing after recovery');
      assert.ok(!events.some((e) => e.type === 'error'), 'the turn must not surface an error');
    } finally { await server.close(); }
  });

  await t('sanitizeHistory keeps the head and tail of one oversized message', async () => {
    const head = 'HEAD-OF-PASTE ';
    const tail = ' Reply with exactly TAILMAGIC.';
    const doc = head + 'lorem ipsum '.repeat(9000) + tail; // ~120k chars
    const compactCalls = [];
    const out = llm.sanitizeHistory([{ role: 'user', content: doc }], {
      maxChars: 20000,
      onCompact: (info) => compactCalls.push(info),
    });
    assert.strictEqual(out.length, 1, 'a single message must not be dropped or duplicated');
    const got = String(out[0].content);
    assert.ok(got.length <= 20000, 'still over the budget: ' + got.length);
    assert.ok(got.startsWith('HEAD-OF-PASTE'), 'the head was lost');
    assert.ok(got.trimEnd().endsWith('TAILMAGIC.'), 'the instruction tail was lost: …' + got.slice(-60));
    assert.ok(/omitted to fit/.test(got), 'expected a middle-omitted marker');
    assert.strictEqual(compactCalls.length, 1, 'onCompact should fire once');
    assert.strictEqual(compactCalls[0].dropped, 0, 'nothing was dropped — there were no earlier turns');
    assert.ok(compactCalls[0].truncated > 1000, 'truncated count should be reported, got ' + compactCalls[0].truncated);
  });

  await t('a single oversized message is trimmed (not amputated) and the turn completes', async () => {
    catalog.register('testprov', [{ id: 'medium-window', label: 'Medium', contextWindow: 32000 }]);
    // The 32k budget is 70 720 chars; chunking only starts above 2 x 60 % of it
    // (84 864), so 80 000 chars lands in the trim path that used to send the
    // whole paste and then re-send it on every retry.
    const server = await startServer({ reply: 'done' });
    try {
      const doc = 'AAA-BEGIN ' + 'filler '.repeat(11400) + 'reply with exactly ENDMAGIC';
      const events = [];
      const out = await llm.runAgent({
        provider: providerFor(server.url, 'medium-window'),
        messages: [{ role: 'user', content: doc }],
        emit: (e) => events.push(e),
        turnStart: false,
      });
      assert.ok(server.seen.length >= 1, 'expected a provider call');
      const first = server.bodies[0].messages.reduce((n, m) => n + String(m.content || '').length, 0);
      assert.ok(first < doc.length, 'the paste should have been trimmed before sending (' + first + ' vs ' + doc.length + ')');
      const sent = String(server.bodies[0].messages[server.bodies[0].messages.length - 1].content || '');
      assert.ok(/ENDMAGIC/.test(sent), 'the instruction at the end of the paste must still reach the model');
      assert.ok(/AAA-BEGIN/.test(sent), 'the beginning of the paste must still reach the model');
      const notice = events.find((e) => e.type === 'notice');
      assert.ok(notice, 'expected a notice');
      assert.ok(!/Compacted 0 earlier turns/.test(notice.text), 'notice must not claim 0 turns were compacted: ' + notice.text);
      assert.ok(/longer than|trimmed|Compacted/.test(notice.text), 'notice should be prose: ' + notice.text);
      const last = [...out].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /done/.test(last.content), 'reply missing');
      assert.ok(!events.some((e) => e.type === 'error'), 'the turn must not surface an error');
    } finally { await server.close(); }
  });

  await t('small-context 16K model auto-selects lean tool surface and stays under 16K', async () => {
    const server = await startServer({ reply: 'ok-16k' });
    try {
      const history = [];
      for (let i = 0; i < 6; i++) {
        history.push({ role: 'user', content: `Turn ${i}: ` + 'x'.repeat(1800) });
        history.push({ role: 'assistant', content: `Reply ${i}: ` + 'y'.repeat(1800) });
      }
      history.push({ role: 'user', content: 'hi what can you do' });
      const events = [];
      const out = await llm.runAgent({
        provider: {
          baseURL: server.url,
          apiKey: 'sk-test-local',
          model: 'bonsai-2.5',
          contextWindow: 16384,
          maxTokens: 4096,
          supportsTools: true,
        },
        messages: history,
        emit: (e) => events.push(e),
        turnStart: false,
      });
      assert.ok(server.bodies.length >= 1, 'expected at least 1 request');
      const reqTools = server.bodies[0].tools || [];
      assert.ok(reqTools.length > 0 && reqTools.length <= 20, `expected lean tool count <= 20, got ${reqTools.length}`);
      const payloadChars = JSON.stringify(server.bodies[0].messages).length + JSON.stringify(reqTools).length;
      assert.ok(payloadChars < 16384 * 3.5, `expected payload under 16K budget, got ${payloadChars} chars`);
      const last = [...out].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /ok-16k/.test(last.content), 'reply missing');
      assert.ok(!events.some((e) => e.type === 'error'), 'must not error');
    } finally { await server.close(); }
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + (process.exitCode ? 'at least 1' : '0') + ' failed');
})();
