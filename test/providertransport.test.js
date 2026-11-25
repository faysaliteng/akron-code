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
    eq('oauth impersonates the CLI', oauth.headers['user-agent'], 'claude-cli/2.1.154 (external, cli)');
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
    await s.close();
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
      ['helio-bot', 'xai-grok-cli']);
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
      if (req.url.startsWith('/v1internal:loadCodeAssist')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ cloudaicompanionProject: 'proj-42' }));
        return;
      }
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
    eq('project resolved once via loadCodeAssist', [msg.finish_reason, provider.project], ['tool_calls', 'proj-42']);
    eq('usage mapped from usageMetadata', msg.usage.total_tokens, 7);
    const calls = s.seen.requests;
    ok('loadCodeAssist called before generation', calls[0].url.indexOf('loadCodeAssist') !== -1);
    ok('generation uses alt=sse', calls[1].url.indexOf('alt=sse') !== -1);
    eq('project echoed in the generation body', calls[1].body.project, 'proj-42');
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
    ok('missing Cloud Code project fails with guidance', !!(err && /Antigravity/.test(err.message)));
    await s.close();
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
