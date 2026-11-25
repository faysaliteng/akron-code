'use strict';
// Truncated tool calls and the silent output-budget escalation.
//
// Two failures used to make "coding with any AI" look broken:
//   1. A reply cut at the output limit produced a tool call whose JSON arguments
//      stopped mid-string. Dispatch parsed it with `parseArgs` → `{}`, so `Write`
//      ran with no path and emitted an empty "error" card while the file never
//      appeared.
//   2. The recovery streamed a thought line ("… retrying with N tokens"), which
//      is not a thing the Claude app, Claude Code, or Antigravity ever say.
//
// Locked in here:
//   • a cut tool call never runs and never renders a card;
//   • the model is told (in the tool message) to redo the work in smaller pieces;
//   • the escalation asks for a bigger budget and is visually silent;
//   • the larger budget is reused for the rest of the turn;
//   • parseTextToolCalls / parseArgs never turn unparseable JSON into `{}`.
const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const http = require('http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cut-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const llm = require(path.join(__dirname, '..', 'electron', 'llm.js'));
const catalog = require(path.join(__dirname, '..', 'electron', 'model-catalog.js'));

let pass = 0;
async function t(label, fn) {
  try { await fn(); pass++; console.log('  ok   ' + label); }
  catch (e) { console.log('  FAIL ' + label + ' :: ' + (e && e.stack || e)); process.exitCode = 1; }
}

// A gateway that reproduces the real failure: it streams a `Write` call whose
// argument JSON is sliced (finish_reason "length") until the client proves it
// received the "redo in smaller pieces" tool message, then it answers normally.
function startServer() {
  const bodies = [];
  let cuts = 0;
  const sse = (res, chunks) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
    res.end();
  };
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      bodies.push(body);
      const msgs = Array.isArray(body.messages) ? body.messages : [];
      const sawCutNote = msgs.some((m) => m.role === 'tool' && /cut off before its arguments/.test(String(m.content || '')));
      if (sawCutNote) {
        sse(res, [
          { choices: [{ delta: { content: 'Finished in two pieces.' } }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } },
        ]);
        return;
      }
      cuts++;
      // The slice point is inside the file body: the JSON never closes.
      sse(res, [
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_cut', type: 'function', function: { name: 'Write', arguments: '{"file_path":"/tmp/toolcap.html","content":"<!doctype html><html><body><h1>hello' } }] } }] },
        { choices: [{ delta: {}, finish_reason: 'length' }], usage: { prompt_tokens: 20, completion_tokens: 40, total_tokens: 60 } },
      ]);
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    resolve({
      url: `http://127.0.0.1:${srv.address().port}/v1/`,
      bodies,
      cuts: () => cuts,
      close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(r); }),
    });
  }));
}

function providerFor(url, model) {
  return { baseURL: url, apiKey: 'test', model, oauthProvider: 'testprov:acct', maxTokens: 4096, supportsTools: true };
}

(async () => {
  console.log('Truncated tool calls');

  await t('a cut tool call never runs, never renders, and the turn still finishes', async () => {
    catalog.register('testprov', [{ id: 'cut-model', label: 'Cut', contextWindow: 200000 }]);
    const server = await startServer();
    try {
      const events = [];
      const out = await llm.runAgent({
        provider: providerFor(server.url, 'cut-model'),
        messages: [{ role: 'user', content: 'Write an HTML page to /tmp/toolcap.html' }],
        emit: (e) => events.push(e),
        turnStart: false,
      });

      // 1. Nothing was dispatched: no tool card (empty arguments looked broken).
      const cards = events.filter((e) => e.type === 'tool');
      assert.deepStrictEqual(cards, [], 'a cut call must not produce a tool card: ' + JSON.stringify(cards));

      // 2. The model was told how to recover.
      assert.ok(server.cuts() >= 1, 'the server never sent the cut call');
      const lastBody = server.bodies[server.bodies.length - 1];
      const toolMsg = (lastBody.messages || []).find((m) => m.role === 'tool');
      assert.ok(toolMsg, 'the retry must carry a tool message for the cut call');
      assert.ok(/cut off before its arguments/.test(toolMsg.content), 'tool message must explain the cut: ' + toolMsg.content);
      assert.ok(/smaller pieces/.test(toolMsg.content), 'tool message must say to redo it in pieces');
      assert.strictEqual(toolMsg.tool_call_id, 'call_cut', 'the tool result must match the assistant tool_call id');

      // 3. The budget was escalated, then reused for the rest of the turn.
      const asked = server.bodies.map((b) => b.max_tokens).filter((n) => Number.isFinite(n));
      assert.ok(asked.length >= 2, 'expected several attempts, saw ' + JSON.stringify(asked));
      assert.ok(asked.some((n) => n > 4096), 'expected an escalated max_tokens, saw ' + JSON.stringify(asked));
      const top = Math.max(...asked);
      assert.ok(top <= 65536, 'never ask for more than the hard output cap: ' + top);
      assert.strictEqual(asked[asked.length - 1], top, 'the retry after the cut must reuse the escalated budget, saw ' + JSON.stringify(asked));

      // 4. The recovery is silent — no "token limit / retrying with N" line.
      assert.ok(events.some((e) => e.type === 'retry'), 'a retry event drops the cut attempt from the UI');
      const noise = events
        .filter((e) => e.type === 'thinking' || e.type === 'notice' || e.type === 'limit')
        .map((e) => String(e.text || ''))
        .filter((s) => /token limit|output limit|limit reached|retrying with|max_tokens|budget/i.test(s));
      assert.deepStrictEqual(noise, [], 'no limit wording may reach the transcript: ' + JSON.stringify(noise));

      // 5. The turn completes with the model's real answer.
      const last = [...out].reverse().find((m) => m.role === 'assistant');
      assert.ok(last && /Finished in two pieces/.test(last.content), 'final answer missing: ' + (last && last.content));
      assert.ok(!events.some((e) => e.type === 'error'), 'the turn must not surface an error');
      assert.strictEqual(events.filter((e) => e.type === 'done').length, 1, 'exactly one done event');
    } finally { await server.close(); }
  });

  await t('parseArgs flags sliced JSON instead of fabricating arguments', async () => {
    const cut = llm.parseArgs('{"file_path":"/tmp/a","content":"<h1>hi');
    assert.ok(cut._parse_error, 'cut JSON must be flagged, got ' + JSON.stringify(cut));
    assert.ok(!cut.file_path, 'cut JSON must not invent a file_path');
    const junk = llm.parseArgs('not json at all');
    assert.ok(junk._parse_error, 'garbage must be flagged, got ' + JSON.stringify(junk));
    // …but a complete call keeps working, including the one-key envelope shapes.
    assert.deepStrictEqual(llm.parseArgs('{"file_path":"/tmp/a","content":"hi"}'), { file_path: '/tmp/a', content: 'hi' });
    assert.deepStrictEqual(llm.parseArgs('{"arguments":{"file_path":"/tmp/b"}}'), { file_path: '/tmp/b' });
    assert.deepStrictEqual(llm.parseArgs(''), {});
  });

  await t('parseTextToolCalls skips a fenced call with unparseable arguments', async () => {
    const brokenInner = '```tool\n{"name":"Write","arguments":"{\\"file_path\\":\\"/tmp/a\\" "}\n```';
    assert.deepStrictEqual(llm.parseTextToolCalls(brokenInner), [], 'a sliced argument string must not yield a call');
    const brokenOuter = '```tool\n{"name":"Write","arguments":{"file_path":"/tmp/a"';
    assert.deepStrictEqual(llm.parseTextToolCalls(brokenOuter), [], 'sliced outer JSON must not yield a call');
    const good = '```tool\n{"name":"Write","arguments":{"file_path":"/tmp/a","content":"hi"}}\n```';
    const calls = llm.parseTextToolCalls(good);
    assert.strictEqual(calls.length, 1, 'a complete fenced call must still parse');
    assert.strictEqual(calls[0].function.name, 'Write');
    assert.deepStrictEqual(JSON.parse(calls[0].function.arguments), { file_path: '/tmp/a', content: 'hi' });
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + (process.exitCode ? 'at least 1' : '0') + ' failed');
})();
