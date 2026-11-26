'use strict';
// Provider wire transports: Anthropic /v1/messages, OpenAI Codex `responses`,
// Google Cloud Code `streamGenerateContent`.
//
// No real vendor is contacted. Each adapter is pointed at a local HTTP server
// that replays a recorded-shape SSE stream, so a change to the wire format
// (header name, body field, event vocabulary, tool-call framing) fails here
// instead of surfacing as an empty reply in the app.
const assert = require('assert');
const http = require('http');
const t = require('../electron/providertransport');
const I = t._internal;

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

/** Numeric dotted-version comparison, so the Grok gate assertion reads plainly. */
const semverAtLeast = (a, b) => {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
};

/** Start a throwaway server that streams `chunks` and records the request. */
function server(handler) {
  return new Promise((resolve) => {
    const seen = { requests: [] };
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) {}
        seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
        handler(req, res, parsed);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const base = 'http://127.0.0.1:' + srv.address().port;
      resolve({
        base,
        seen,
        // A keep-alive socket left idle would stall `close`; the suite must not
        // hang because a test forgot to drain a body.
        close: () => new Promise((r) => { try { srv.closeAllConnections(); } catch (_) {} srv.close(r); }),
      });
    });
  });
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const e of events) res.write('data: ' + JSON.stringify(e) + '\n\n');
  res.end();
}

const noop = () => {};

(async () => {
  // -------------------------------------------------------------------------
  console.log('\ntransport — SSE reader');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(': keep-alive\n\n');
      res.write('data: {"a":1}\r\n\r\n');
      res.write('data:not-json\n\n');
      res.write('data: [DONE]\n\n');
      res.write('data: {"a":2}\n\n');
      res.end();
    });
    const res = await fetch(s.base + '/x');
    const got = [];
    for await (const ev of I.sseEvents(res)) got.push(ev);
    eq('parses JSON events, drops comments/[DONE]/garbage, tolerates CRLF', got, [{ a: 1 }, { a: 2 }]);
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic request shape');
  // -------------------------------------------------------------------------
  {
    const body = I.toAnthropicBody({ model: 'claude-opus-4-1' }, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'tu1', content: 'file a' },
      { role: 'assistant', content: 'done' },
    ], [{ function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], 8000);
    eq('system prompt is hoisted', body.system, [{ type: 'text', text: 'be terse' }]);
    eq('model + max_tokens + stream carried', [body.model, body.max_tokens, body.stream], ['claude-opus-4-1', 8000, true]);
    eq('consecutive user turns are merged (Anthropic rejects adjacent users)', body.messages[0].role, 'user');
    eq('merged content keeps both parts', body.messages[0].content.map((c) => c.text), ['hi', 'again']);
    eq('assistant tool call becomes tool_use', body.messages[1].content[1].type, 'tool_use');
    eq('assistant tool input is parsed to an object', body.messages[1].content[1].input, { path: 'a' });
    eq('tool result becomes a user tool_result block', body.messages[2].content[0].type, 'tool_result');
    eq('tool_result id matches the call', body.messages[2].content[0].tool_use_id, 'tu1');
    eq('openai tool schema maps to input_schema', body.tools[0].input_schema.properties.path.type, 'string');
    ok('no temperature is ever sent (subscription path rejects it)', !('temperature' in body));
    ok('no empty assistant message is emitted', body.messages.every((m) => m.content.length));
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic auth + stop_reason');
  // -------------------------------------------------------------------------
  {
    const oauth = I.anthropicAuth({ accessToken: 'sk-ant-oat01-abc', oauth: true });
    eq('oauth sends Bearer, never x-api-key', [!!oauth.headers.authorization, 'x-api-key' in oauth.headers], [true, false]);
    eq('oauth sends the oauth beta header', oauth.headers['anthropic-beta'], 'oauth-2025-04-20');
    eq('oauth impersonates the CLI', oauth.headers['user-agent'], 'claude-cli/' + I.clientVersions.claude + ' (external, cli)');
    // The version token inside the fingerprint is what vendors gate on, so it
    // must track the CLI we ship rather than a frozen literal.
    {
      const before = { ...I.clientVersions };
      I.setClientVersions({ claude: '2.1.332 (Claude Code)' });
      eq('adopting a runtime version updates the claude UA',
        I.anthropicAuth({ accessToken: 'sk-ant-oat01-abc', oauth: true }).headers['user-agent'],
        'claude-cli/2.1.332 (external, cli)');
      I.setClientVersions({ claude: 'garbage' });
      eq('an unparseable version is ignored', I.clientVersions.claude, '2.1.332');
      I.setClientVersions(before);
      eq('versions restore', I.clientVersions.claude, before.claude);
    }
    ok('a default claude version clears the 2.1.290 model gate', semverAtLeast(I.DEFAULT_CLIENT_VERSIONS.claude, '2.1.290'));
    ok('a default codex version is present', /^\d+\.\d+\.\d+$/.test(I.DEFAULT_CLIENT_VERSIONS.codex));
    ok('a default grok version clears the 1.0.13 gate', semverAtLeast(I.DEFAULT_CLIENT_VERSIONS.grok, '1.0.13'));
    eq('oauth sets x-app: cli', oauth.headers['x-app'], 'cli');
    ok('anthropic-version always present', oauth.headers['anthropic-version'] === '2023-06-01');
    // An sk-ant-oat token is detected as OAuth even if the flag is missing.
    const inferred = I.anthropicAuth({ apiKey: 'sk-ant-oat01-xyz' });
    eq('oat-prefixed key is treated as oauth', inferred.oauth, true);
    const api = I.anthropicAuth({ apiKey: 'sk-ant-api03-k', oauth: false });
    eq('api key uses x-api-key', [api.headers['x-api-key'], 'authorization' in api.headers], ['sk-ant-api03-k', false]);
    eq('stop_reason tool_use -> tool_calls', I.anthropicFinish('tool_use'), 'tool_calls');
    eq('stop_reason max_tokens -> length', I.anthropicFinish('max_tokens'), 'length');
    eq('stop_reason refusal -> content_filter', I.anthropicFinish('refusal'), 'content_filter');
    eq('stop_reason end_turn -> stop', I.anthropicFinish('end_turn'), 'stop');
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic streaming');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => sse(res, [
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu9', name: 'Write' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"index.html"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 40 } },
      { type: 'message_stop' },
    ]));
    const deltas = [];
    const msg = await t.chatCompletion(
      { transport: 'anthropic', model: 'claude-opus-4-1', accessToken: 'sk-ant-oat01-z', oauth: true, baseURL: s.base },
      [{ role: 'user', content: 'build it' }], null,
      (txt, reasoning) => deltas.push([txt, !!reasoning]), undefined, 4000,
    );
    eq('visible text assembled', msg.content, 'Hello');
    eq('reasoning is streamed separately to the caller', deltas.filter((d) => d[1]).map((d) => d[0]), ['hmm']);
    eq('tool call id/name captured', [msg.tool_calls[0].id, msg.tool_calls[0].function.name], ['tu9', 'Write']);
    eq('partial_json fragments concatenate to valid JSON', JSON.parse(msg.tool_calls[0].function.arguments), { path: 'index.html' });
    eq('arguments stay a JSON string (agent loop contract)', typeof msg.tool_calls[0].function.arguments, 'string');
    eq('finish_reason mapped', msg.finish_reason, 'tool_calls');
    eq('usage from message_delta', msg.usage.output_tokens, 40);
    const req = s.seen.requests[0];
    eq('posts to /v1/messages', req.url, '/v1/messages');
    eq('bearer auth on the wire', req.headers.authorization, 'Bearer sk-ant-oat01-z');
    eq('beta header on the wire', req.headers['anthropic-beta'], 'oauth-2025-04-20');
    // Verified live 2026-11-25: the subscription endpoint answers
    // 429 rate_limit_error for *every* model until the request leads with the
    // Claude Code identity prompt. Same token, same model: 429 bare, 200 with it.
    eq('oauth turns lead with the Claude Code identity block',
      req.body.system && req.body.system[0], { type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." });
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic identity prompt ordering');
  // -------------------------------------------------------------------------
  {
    const body = I.toAnthropicBody(
      { transport: 'anthropic', model: 'm', accessToken: 'sk-ant-oat01-z', oauth: true },
      [{ role: 'system', content: 'You are Akron Bot.' }, { role: 'user', content: 'hi' }], null, 100,
    );
    eq('identity block leads, caller system follows', body.system.map((p) => p.text), [
      "You are Claude Code, Anthropic's official CLI for Claude.",
      'You are Akron Bot.',
    ]);
    const again = I.toAnthropicBody(
      { transport: 'anthropic', model: 'm', accessToken: 'sk-ant-oat01-z', oauth: true },
      [{ role: 'system', content: "You are Claude Code, Anthropic's official CLI for Claude.\nYou are Akron Bot." }, { role: 'user', content: 'hi' }], null, 100,
    );
    eq('an identity block the caller already sends is not duplicated', again.system.length, 1);
    const api = I.toAnthropicBody(
      { transport: 'anthropic', model: 'm', apiKey: 'sk-ant-api03-k' },
      [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], null, 100,
    );
    eq('plain api-key turns are left untouched', api.system.map((p) => p.text), ['sys']);
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic non-stream fallback + errors');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'plain body' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { cmd: 'ls' } }],
        usage: { input_tokens: 1, output_tokens: 2 },
      }));
    });
    const got = [];
    const msg = await t.chatCompletion(
      { transport: 'anthropic', model: 'm', apiKey: 'sk-ant-api03-k', baseURL: s.base },
      [{ role: 'user', content: 'x' }], null, (d) => got.push(d), undefined, 100,
    );
    eq('collapsed JSON body still yields text', msg.content, 'plain body');
    eq('collapsed JSON body still yields a tool call', msg.tool_calls[0].function.name, 'Bash');
    eq('text replayed as a delta so the UI is not blank', got, ['plain body']);
    eq('usage preserved', msg.usage.output_tokens, 2);
    await s.close();
  }
  {
    const s = await server((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'bad token' } }));
    });
    let err = null;
    try {
      await t.chatCompletion({ transport: 'anthropic', model: 'm', apiKey: 'k', baseURL: s.base }, [{ role: 'user', content: 'x' }], null, noop);
    } catch (e) { err = e; }
    ok('http failure throws', !!err);
    eq('status surfaced for failover classification', err && err.status, 401);
    ok('message is a single line, not raw markup', err && !/[<>]/.test(err.message.split('\n')[0]));
    await s.close();
  }
  {
    const s = await server((req, res) => sse(res, [
      { type: 'message_start', message: {} },
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ]));
    let err = null;
    try {
      await t.chatCompletion({ transport: 'anthropic', model: 'm', apiKey: 'k', baseURL: s.base }, [{ role: 'user', content: 'x' }], null, noop);
    } catch (e) { err = e; }
    ok('mid-stream error event throws', !!err);
    eq('overloaded is marked transient (so it is retried, not fatal)', err && err.transient, true);
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic 1M long-context beta');
  // -------------------------------------------------------------------------
  {
    const cat = require('../electron/model-catalog');
    cat.clearWindows();
    const big = 'x'.repeat(700000); // ≈ 205k tokens at 3.4 chars/token
    const s = await server((req, res) => sse(res, [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
    await t.chatCompletion(
      { transport: 'anthropic', id: 'claude', model: 'claude-sonnet-4-5', accessToken: 'sk-ant-oat01-z', oauth: true, baseURL: s.base },
      [{ role: 'user', content: big }], null, noop, undefined, 1000,
    );
    eq('a turn that needs 1M asks for the beta', s.seen.requests[0].headers['anthropic-beta'],
      'oauth-2025-04-20,' + cat.LONG_CONTEXT_BETA);
    await s.close();

    const s2 = await server((req, res) => sse(res, [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
    await t.chatCompletion(
      { transport: 'anthropic', id: 'claude', model: 'claude-sonnet-4-5', accessToken: 'sk-ant-oat01-z', oauth: true, baseURL: s2.base },
      [{ role: 'user', content: 'hi' }], null, noop, undefined, 1000,
    );
    eq('a small turn does not pay for the long-context beta', s2.seen.requests[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    await s2.close();

    const s3 = await server((req, res) => sse(res, [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
    await t.chatCompletion(
      { transport: 'anthropic', id: 'claude', model: 'claude-opus-4-1', accessToken: 'sk-ant-oat01-z', oauth: true, baseURL: s3.base },
      [{ role: 'user', content: big }], null, noop, undefined, 1000,
    );
    eq('an id without 1M entitlement never asks for it', s3.seen.requests[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    await s3.close();
  }
  {
    // Not entitled: 400 on the beta, 200 on the plain request. The transport must
    // retry silently and pin the real window so the next turn compacts honestly.
    const cat = require('../electron/model-catalog');
    cat.clearWindows();
    let calls = 0;
    const s = await server((req, res) => {
      calls++;
      if (/context-1m/.test(String(req.headers['anthropic-beta'] || ''))) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'The long context beta is not available for this account.' } }));
        return;
      }
      sse(res, [
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'fell back' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      ]);
    });
    const msg = await t.chatCompletion(
      { transport: 'anthropic', id: 'claude', model: 'claude-sonnet-4-5', accessToken: 'sk-ant-oat01-z', oauth: true, baseURL: s.base },
      [{ role: 'user', content: 'y'.repeat(700000) }], null, noop, undefined, 1000,
    );
    eq('a refused beta is retried without it', calls, 2);
    eq('the retry returns a normal answer', msg.content, 'fell back');
    eq('the window is demoted for the session', cat.contextWindowFor('claude-sonnet-4-5', 'claude'), 200000);
    eq('the retry does not carry the beta', s.seen.requests[1].headers['anthropic-beta'], 'oauth-2025-04-20');
    cat.clearWindows();
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Codex request shape');
  // -------------------------------------------------------------------------
  {
    const { instructions, input } = I.toCodexInput([
      { role: 'system', content: 'sys one' },
      { role: 'developer', content: 'sys two' },
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'working', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'out' },
    ]);
    eq('system/developer are hoisted into instructions', instructions, 'sys one\n\nsys two');
    eq('user turn becomes input_text', input[0].content[0].type, 'input_text');
    eq('assistant prose becomes an output_text message', input[1].content[0].type, 'output_text');
    eq('assistant tool call becomes function_call', input[2].type, 'function_call');
    eq('assistant tool call keeps its id as call_id', input[2].call_id, 'c1');
    eq('assistant arguments stay a JSON string on the wire', input[2].arguments, '{"cmd":"ls"}');
    eq('tool result becomes function_call_output', input[3].type, 'function_call_output');
    eq('function_call_output joins on call_id', input[3].call_id, 'c1');
    const tools = I.toCodexTools([{ function: { name: 'Bash', description: 'd', parameters: { type: 'object' } } }]);
    eq('codex tools are flat, not nested under `function`', [tools[0].type, tools[0].name, !!tools[0].function], ['function', 'Bash', false]);
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Codex streaming');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => sse(res, [
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', delta: 'making ' },
      { type: 'response.reasoning_summary_text.delta', delta: 'plan' },
      { type: 'response.output_text.delta', delta: 'page' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc1', name: 'Write', call_id: 'call_1' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '{"path":' },
      { type: 'response.function_call_arguments.delta', item_id: 'fc1', delta: '"i.html"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } },
    ]));
    const deltas = [];
    const msg = await t.chatCompletion(
      { transport: 'codex', model: 'gpt-5-codex', accessToken: 'tok', accountId: 'acct', codexUrl: s.base },
      [{ role: 'system', content: 's' }, { role: 'user', content: 'x' }], null,
      (txt, reasoning) => deltas.push([txt, !!reasoning]),
    );
    eq('text deltas assembled', msg.content, 'making page');
    eq('reasoning summary routed as reasoning', deltas.filter((d) => d[1]).map((d) => d[0]), ['plan']);
    eq('tool call captured from output_item.added', msg.tool_calls[0].function.name, 'Write');
    eq('arguments accumulated from deltas', JSON.parse(msg.tool_calls[0].function.arguments), { path: 'i.html' });
    eq('call_id preferred over item id', msg.tool_calls[0].id, 'call_1');
    eq('usage from response.completed', msg.usage.total_tokens, 12);
    const req = s.seen.requests[0];
    eq('bearer auth', req.headers.authorization, 'Bearer tok');
    eq('chatgpt-account-id header sent when known', req.headers['chatgpt-account-id'], 'acct');
    eq('originator header identifies the CLI', req.headers.originator, 'codex_cli_rs');
    eq('body carries instructions, not a system message', typeof req.body.instructions, 'string');
    eq('body is streamed and stateless', [req.body.stream, req.body.store], [true, false]);
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Grok (subscription responses via the CLI proxy)');
  // -------------------------------------------------------------------------
  {
    // Non-stream shape first: exercises the same absorb path as a JSON reply.
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'done' }] }],
        usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
        status: 'completed',
      }));
    });
    const msg = await t.chatCompletion(
      { transport: 'grok', model: 'grok-4.5', accessToken: 'ok-tok', baseURL: s.base + '/v1' },
      [{ role: 'user', content: 'hi' }], null, noop,
    );
    eq('non-stream text assembled', msg.content, 'done');
    eq('non-stream finish is stop', msg.finish_reason, 'stop');
    eq('usage mapped', msg.usage.total_tokens, 5);
    const req = s.seen.requests[0];
    eq('posts to <base>/v1/responses, not /chat/completions', req.url, '/v1/responses');
    eq('bearer auth on the wire', req.headers.authorization, 'Bearer ok-tok');
    eq('grok client headers present',
      [req.headers['x-grok-client-identifier'], req.headers['x-xai-token-auth']],
      ['grok-shell', 'xai-grok-cli']);
    // The proxy 426s any `x-grok-client-version` under a rolling minimum
    // (observed: "update to version 1.0.13 or later"). Guard the gate and keep
    // the UA's version token identical to it so both cannot drift apart.
    const gated = req.headers['x-grok-client-version'];
    const uaVersion = String(req.headers['user-agent']).split('/')[1].split(' ')[0];
    eq('grok gate version clears the 1.0.13 minimum', semverAtLeast(gated, '1.0.13'), true);
    eq('grok UA version matches the gate version', uaVersion, gated);
    eq('grok UA names the CLI product', String(req.headers['user-agent']).startsWith('grok-shell/'), true);
    eq('grok sends the CLI conversation/request/agent ids',
      [!!req.headers['x-grok-conv-id'], !!req.headers['x-grok-req-id'], !!req.headers['x-grok-agent-id']],
      [true, true, true]);
    eq('body is streamed and stateless', [req.body.stream, req.body.store], [true, false]);
    eq('body carries instructions, not a system message', typeof req.body.instructions, 'string');
    eq('body asks for encrypted reasoning', req.body.include, ['reasoning.encrypted_content']);
    await s.close();
  }
  {
    // Streaming + tool call, mirroring the Codex vocabulary the proxy uses.
    const s = await server((req, res) => sse(res, [
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fcX', name: 'Write', call_id: 'cX' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fcX', delta: '{"path":"a.txt"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]));
    const msg = await t.chatCompletion(
      { transport: 'grok', model: 'grok-4.5', accessToken: 'ok-tok', baseURL: s.base + '/v1' },
      [{ role: 'user', content: 'go' }], null, noop,
    );
    eq('grok stream text assembled', msg.content, 'Hel');
    eq('grok tool name captured', msg.tool_calls[0].function.name, 'Write');
    eq('grok arguments stay a JSON string', typeof msg.tool_calls[0].function.arguments, 'string');
    eq('grok call_id preferred', msg.tool_calls[0].id, 'cX');
    eq('grok finish is tool_calls', msg.finish_reason, 'tool_calls');
    await s.close();
  }
  {
    // A full /responses URL is passed through, not doubled.
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ output: [] }));
    });
    await t.chatCompletion(
      { transport: 'grok', model: 'grok-4.5', accessToken: 't', baseURL: s.base + '/v1/responses' },
      [{ role: 'user', content: 'x' }], null, noop,
    );
    eq('a full responses URL is not doubled', s.seen.requests[0].url, '/v1/responses');
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Google Cloud Code');
  // -------------------------------------------------------------------------
  {
    const { systemParts, contents } = I.toGeminiContents([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_name: 'Read', content: 'data' },
    ]);
    eq('system prompt separated into systemInstruction parts', systemParts[0].text, 'sys');
    eq('user content is `user` role', contents[0].role, 'user');
    eq('assistant content is `model` role', contents[1].role, 'model');
    eq('tool call becomes functionCall with parsed args', contents[1].parts[1].functionCall.args, { path: 'a' });
    eq('tool result becomes functionResponse on a user turn', contents[2].parts[0].functionResponse.name, 'Read');
    eq('MAX_TOKENS -> length', I.geminiFinish('MAX_TOKENS'), 'length');
    eq('SAFETY -> content_filter', I.geminiFinish('SAFETY'), 'content_filter');
    eq('STOP -> stop', I.geminiFinish('STOP'), 'stop');
    eq('no reason -> stop', I.geminiFinish(''), 'stop');
  }
  {
    const s = await server((req, res) => {
      sse(res, [
        { response: { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] } },
        { response: { candidates: [{ content: { parts: [{ text: 'lo' }] } }] } },
        { response: { candidates: [{ content: { parts: [{ functionCall: { name: 'Write', args: { path: 'x' } } }] }, finishReason: 'STOP' }] } },
        { response: { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } } },
      ]);
    });
    // Cloud Code paths are gRPC-transcoded (`:method`), so the base needs a path
    // segment — exactly like the real /v1internal base.
    const provider = { transport: 'google', model: 'gemini-3-pro', accessToken: 'gtok', cloudcodeUrl: s.base + '/v1internal' };
    const got = [];
    const msg = await t.chatCompletion(provider, [{ role: 'user', content: 'x' }], null, (d) => got.push(d));
    eq('text accumulates across events', msg.content, 'Hello');
    eq('text streamed to caller', got.join(''), 'Hello');
    eq('function call captured', msg.tool_calls[0].function.name, 'Write');
    eq('function args are a JSON string', typeof msg.tool_calls[0].function.arguments, 'string');
    eq('finish reason maps from the last candidate', msg.finish_reason, 'tool_calls');
    eq('usage mapped from usageMetadata', msg.usage.total_tokens, 7);
    const calls = s.seen.requests;
    // Field-verified: `onboardUser` returns `cloudcodeaicompanionProject: {}`,
    // so there is no project to resolve and no loadCodeAssist round-trip.
    eq('exactly one request — no project bootstrap', calls.length, 1);
    ok('generation uses alt=sse', calls[0].url.indexOf('alt=sse') !== -1);
    ok('body carries the agent request shape', calls[0].body && calls[0].body.requestType === 'agent', calls[0].body && calls[0].body.requestType);
    ok('body never sends a project field', !('project' in (calls[0].body || {})));
    eq('anticlockwise: body model echoes the provider model', calls[0].body.model, 'gemini-3-pro');
    await s.close();
  }
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({}));
    });
    let err = null;
    try {
      await t.chatCompletion({ transport: 'google', model: 'm', accessToken: 't', cloudcodeUrl: s.base + '/v1internal' }, [{ role: 'user', content: 'x' }], null, noop);
    } catch (e) { err = e; }
    ok('an SSE stream with no events never hangs', !err || typeof err.message === 'string');
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Grok credit hint (402 explanation)');
  // -------------------------------------------------------------------------
  {
    // The proxy's 402 body is just "Grok Build usage balance exhausted". The
    // account's own credits config is the only place that says *why* and when it
    // resets, so the transport reads it once and attaches prose to the error.
    const realFetch = global.fetch;
    let hits = 0;
    global.fetch = async (url, opts) => {
      hits++;
      eq('credit hint hits the grok.com credits path', String(url), I.GROK_CREDITS_URL);
      eq('credit hint sends the signed-in bearer', opts.headers.authorization, 'Bearer tok-9');
      eq('credit hint identifies as the CLI', opts.headers['x-grok-client-identifier'], 'grok-shell');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          config: {
            creditUsagePercent: 100,
            currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: '2026-12-01T14:48:12.700Z' },
            prepaidBalance: { val: '0' },
            onDemandCap: null,
          },
        }),
      };
    };
    try {
      const hint = await I.grokCreditHint({ accessToken: 'tok-9' });
      ok('hint states the allowance is spent', /100% used this week/.test(hint), hint);
      ok('hint names the reset date', /resets 2026-12-01/.test(hint), hint);
      ok('hint explains the zero balance', /prepaid balance is \$0/.test(hint), hint);
      eq('hint fetched once', hits, 1);
      await I.grokCreditHint({ accessToken: 'tok-9' });
      eq('hint is cached, not refetched per turn', hits, 1);
    } finally {
      global.fetch = realFetch;
    }
  }
  {
    const llm = require('../electron/llm');
    const err = Object.assign(new Error('LLM 402: {"error":"Grok Build usage balance exhausted"}'), { status: 402 });
    const plain = llm.humanizeLLMError(err);
    ok('402 without a hint still says something human', /out of credit/i.test(plain), plain);
    ok('402 envelope JSON never reaches the banner', !plain.includes('{"error"'), plain);
    err.hint = 'the Grok Build allowance is 100% used this week; it resets 2026-12-01';
    const withHint = llm.humanizeLLMError(err);
    ok('transport hint replaces the vendor envelope', /resets 2026-12-01/.test(withHint), withHint);
    ok('hinted copy keeps the "out of credit" lead-in', /out of credit/i.test(withHint), withHint);
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — dispatch');
  // -------------------------------------------------------------------------
  eq('anthropic transport is recognised', t.needsTransport({ transport: 'anthropic' }), true);
  eq('codex transport is recognised', t.needsTransport({ transport: 'codex' }), true);
  eq('google transport is recognised', t.needsTransport({ transport: 'google' }), true);
  eq('openai-compatible providers keep the default path', t.needsTransport({ baseURL: 'https://api.tokenrouter.com/v1/' }), false);
  eq('null provider is not a transport', t.needsTransport(null), false);
  {
    let threw = null;
    try { t.chatCompletion({ transport: 'nope' }, [], null, noop); } catch (e) { threw = e; }
    ok('unknown transport is a loud error, not a silent empty reply', !!(threw && /no transport/.test(threw.message)));
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — listModels (live provider catalogs)');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'claude-fable-5-2', display_name: 'Claude Fable 5.2', max_input_tokens: 1000000, max_tokens: 128000 },
            { id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5', max_input_tokens: 1000000, max_tokens: 128000 },
            { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', max_input_tokens: 200000, max_tokens: 64000 },
            { id: 'claude-unwindowed', display_name: 'No window advertised' },
          ],
          has_more: false,
        }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const list = await t.listModels({ transport: 'anthropic', baseURL: s.base, accessToken: 'sk-ant-oat01-abc' });
    eq('anthropic listModels returns every advertised model', list.map((m) => m.id),
      ['claude-fable-5-2', 'claude-haiku-5-5', 'claude-opus-4-5-20251101', 'claude-unwindowed']);
    eq('anthropic listModels keeps display labels', list[0].label, 'Claude Fable 5.2');
    // Live 2026-11-26: `/v1/models` publishes `max_input_tokens`, and it is the
    // input window — 1M on the 5.x line, 200k on the 4-5 pair. `max_tokens`
    // (128k) is the output cap and must never be mistaken for a window.
    eq('anthropic listModels reads max_input_tokens as the window', list[0].contextWindow, 1000000);
    eq('anthropic listModels keeps a 200k model at 200k', list[2].contextWindow, 200000);
    ok('anthropic listModels never uses the output cap as a window', list[0].contextWindow !== 128000);
    eq('anthropic listModels leaves an absent window at 0 for model-catalog', list[3].contextWindow, 0);
    const areq = s.seen.requests[0];
    eq('anthropic listModels asks /v1/models', areq.url, '/v1/models?limit=100');
    ok('anthropic listModels sends the oauth bearer', String(areq.headers.authorization || '').includes('sk-ant-oat01-abc'));
    eq('anthropic listModels asks for JSON, not an SSE stream', areq.headers.accept, 'application/json');
    await s.close();
  }

  {
    // A pasted API key is not an OAuth token: same endpoint, different auth.
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'claude-sonnet-4-6' }] }));
    });
    await t.listModels({ transport: 'anthropic', baseURL: s.base, apiKey: 'sk-ant-api03-key' });
    const areq = s.seen.requests[0];
    eq('an API key goes in x-api-key, not a bearer', areq.headers['x-api-key'], 'sk-ant-api03-key');
    ok('an API key does not set the oauth beta', !areq.headers['anthropic-beta']);
    await s.close();
  }

  {
    const s = await server((req, res) => {
      // `/codex/models` requires `?client_version=`; match on the path so the
      // required query string does not turn the fixture into a 404.
      if (String(req.url).split('?')[0].endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'gpt-reserve', display_name: 'GPT-Reserve', context_window: 272000 },
            { id: 'gpt-6-luna', context_window: 272000 },
          ],
        }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const list = await t.listModels({
      transport: 'codex',
      codexUrl: s.base + '/backend-api/codex/responses',
      accessToken: 'tok-2',
      accountId: 'acct-9',
    });
    eq('codex listModels parses ids', list.map((m) => m.id), ['gpt-reserve', 'gpt-6-luna']);
    eq('codex listModels carries the advertised window', list[0].contextWindow, 272000);
    const req1 = s.seen.requests[0];
    eq('codex listModels derives /models from the responses URL',
      String(req1.url).split('?')[0], '/backend-api/codex/models');
    ok('codex listModels sends the required client_version',
      /[?&]client_version=/.test(String(req1.url)), req1.url);
    eq('codex listModels sends chatgpt-account-id', req1.headers['chatgpt-account-id'], 'acct-9');
    ok('codex listModels identifies as the Codex originator', String(req1.headers.originator || '').startsWith('codex'));
    await s.close();
  }

  {
    const s = await server((req, res) => {
      const base = '/v1internal';
      if (req.url.startsWith(base + ':fetchAvailableModels')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          models: {
            'gemini-4-neon-high': { displayName: 'Gemini 4 Neon (High)', maxTokens: 1048576, maxOutputTokens: 262144, supportsThinking: true, apiProvider: 'GOOGLE_GEMINI' },
            'claude-sonnet-5-5-medium': { displayName: 'Claude Sonnet 5.5 (Medium)', maxTokens: 1000000, maxOutputTokens: 128000, supportsThinking: true, apiProvider: 'ANTHROPIC_VERTEX' },
            'gemini-2.5-flash': { displayName: 'Gemini 2.5 Flash', maxTokens: 1048576, maxOutputTokens: 65535, apiProvider: 'GOOGLE_GEMINI' },
          },
        }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const list = await t.listModels({ transport: 'google', cloudcodeUrl: s.base + '/v1internal', accessToken: 'tok-3' });
    eq('antigravity listModels returns all three models', list.length, 3);
    eq('antigravity puts Gemini before Claude', list[0].group, 'Gemini');
    const neon = list.find((m) => m.id === 'gemini-4-neon-high');
    eq('antigravity normalizes maxTokens to contextWindow', neon.contextWindow, 1048576);
    eq('antigravity keeps maxOutput', neon.maxOutput, 262144);
    eq('antigravity marks thinking support', neon.thinking, true);
    const claude = list.find((m) => m.id === 'claude-sonnet-5-5-medium');
    eq('antigravity groups Vertex Claude separately', claude.group, 'Claude');
    const req1 = s.seen.requests[0];
    ok('antigravity sends the licensed user-agent', String(req1.headers['user-agent'] || '').startsWith('antigravity/hub/'));
    await s.close();
  }

  {
    let threw = null;
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"models":{}}');
    });
    try {
      await t.listModels({ transport: 'google', cloudcodeUrl: s.base + '/v1internal', accessToken: 'tok-4' });
    } catch (e) { threw = e; }
    ok('an empty Antigravity catalog is a loud 403, not an empty picker', !!(threw && threw.status === 403), threw && threw.message);
    await s.close();
  }

  {
    const list = await t.listModels({ transport: 'nope' });
    eq('an unknown transport yields no models instead of throwing', list, []);
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — llm.js integration');
  // -------------------------------------------------------------------------
  {
    const llm = require('../electron/llm');
    const p = llm.normalizeProvider({
      baseURL: 'https://api.anthropic.com', model: 'claude-opus-4-1',
      transport: 'anthropic', oauth: true, accessToken: 'sk-ant-oat01-q', account: 'me', accountId: 'acct', project: 'proj',
    });
    eq('normalizeProvider passes transport through', p.transport, 'anthropic');
    eq('normalizeProvider passes oauth flag', p.oauth, true);
    eq('normalizeProvider passes the access token', p.accessToken, 'sk-ant-oat01-q');
    eq('normalizeProvider passes the account id', p.account, 'me');
    eq('normalizeProvider keeps the project for google', p.project, 'proj');
    const plain = llm.normalizeProvider({ baseURL: 'https://api.tokenrouter.com/v1', apiKey: 'k' });
    eq('plain provider still resolves to an empty transport', plain.transport, '');
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + (process.exitCode ? 'FAILURES' : '0 failed') + ' ===');
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
