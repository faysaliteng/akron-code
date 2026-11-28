'use strict';
// Provider official API-key REST transports: Anthropic /v1/messages, OpenAI
// /v1/responses, Google Gemini /v1beta/models:streamGenerateContent, xAI Grok
// /v1/responses. Consumer subscription accounts must use electron/cli-runner.js.
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
    const body = I.toAnthropicBody({ model: 'claude-opus-4-1', apiKey: 'sk-ant-api03-x' }, [
      { role: 'system', content: 'be terse' },
      { role: 'user', content: 'hi' },
      { role: 'user', content: 'again' },
      { role: 'assistant', content: 'ok', tool_calls: [{ id: 'tu1', type: 'function', function: { name: 'Read', arguments: '{"path":"a"}' } }] },
      { role: 'tool', tool_call_id: 'tu1', content: 'file a' },
      { role: 'assistant', content: 'done' },
    ], [{ function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }], 8000);
    eq('system prompt is hoisted without spoofed identity prepend', body.system, [{ type: 'text', text: 'be terse' }]);
    eq('model + max_tokens + stream carried', [body.model, body.max_tokens, body.stream], ['claude-opus-4-1', 8000, true]);
    eq('consecutive user turns are merged (Anthropic rejects adjacent users)', body.messages[0].role, 'user');
    eq('merged content keeps both parts', body.messages[0].content.map((c) => c.text), ['hi', 'again']);
    eq('assistant tool call becomes tool_use', body.messages[1].content[1].type, 'tool_use');
    eq('assistant tool input is parsed to an object', body.messages[1].content[1].input, { path: 'a' });
    eq('tool result becomes a user tool_result block', body.messages[2].content[0].type, 'tool_result');
    eq('tool_result id matches the call', body.messages[2].content[0].tool_use_id, 'tu1');
    eq('openai tool schema maps to input_schema', body.tools[0].input_schema.properties.path.type, 'string');
    ok('no empty assistant message is emitted', body.messages.every((m) => m.content.length));
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Official API key enforcement + stop_reason');
  // -------------------------------------------------------------------------
  {
    let oauthErr = null;
    try {
      I.anthropicAuth({ accessToken: 'sk-ant-oat01-abc', oauth: true });
    } catch (e) { oauthErr = e; }
    eq('anthropicAuth refuses consumer OAuth tokens', oauthErr && oauthErr.code, 'cli_transport_required');

    const emptyApi = I.anthropicAuth({ apiKey: '' });
    eq('empty apiKey keeps oauth false and sends no Authorization bearer', [emptyApi.oauth, 'authorization' in emptyApi.headers], [false, false]);

    const api = I.anthropicAuth({ apiKey: 'sk-ant-api03-k', oauth: false });
    eq('api key uses x-api-key only', [api.headers['x-api-key'], 'authorization' in api.headers], ['sk-ant-api03-k', false]);
    eq('anthropic uses official akron-code UA', api.headers['user-agent'], I.OFFICIAL_USER_AGENT);
    eq('anthropic-version always present', api.headers['anthropic-version'], '2023-06-01');
    ok('no x-app spoof header sent', !('x-app' in api.headers));
    eq('stop_reason tool_use -> tool_calls', I.anthropicFinish('tool_use'), 'tool_calls');
    eq('stop_reason max_tokens -> length', I.anthropicFinish('max_tokens'), 'length');
    eq('stop_reason refusal -> content_filter', I.anthropicFinish('refusal'), 'content_filter');
    eq('stop_reason end_turn -> stop', I.anthropicFinish('end_turn'), 'stop');
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Anthropic streaming + 1M beta');
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
      { transport: 'anthropic', model: 'claude-opus-4-1', apiKey: 'sk-ant-api03-z', baseURL: s.base },
      [{ role: 'system', content: 'You are Akron Code.' }, { role: 'user', content: 'build it' }], null,
      (txt, reasoning) => deltas.push([txt, !!reasoning]), undefined, 4000,
    );
    eq('visible text assembled', msg.content, 'Hello');
    eq('reasoning streamed separately', deltas.filter((d) => d[1]).map((d) => d[0]), ['hmm']);
    eq('tool call id/name captured', [msg.tool_calls[0].id, msg.tool_calls[0].function.name], ['tu9', 'Write']);
    eq('partial_json fragments concatenate to valid JSON', JSON.parse(msg.tool_calls[0].function.arguments), { path: 'index.html' });
    eq('finish_reason mapped', msg.finish_reason, 'tool_calls');
    eq('usage from message_delta', msg.usage.output_tokens, 40);
    const req = s.seen.requests[0];
    eq('posts to /v1/messages', req.url, '/v1/messages');
    eq('x-api-key on the wire', req.headers['x-api-key'], 'sk-ant-api03-z');
    eq('system prompt preserved verbatim', req.body.system, [{ type: 'text', text: 'You are Akron Code.' }]);
    await s.close();
  }
  {
    const cat = require('../electron/model-catalog');
    cat.clearWindows();
    const big = 'x'.repeat(700000);
    const s = await server((req, res) => sse(res, [
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ]));
    await t.chatCompletion(
      { transport: 'anthropic', id: 'claude', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-api03-z', baseURL: s.base },
      [{ role: 'user', content: big }], null, noop, undefined, 1000,
    );
    eq('a turn that needs 1M asks for the beta', s.seen.requests[0].headers['anthropic-beta'], cat.LONG_CONTEXT_BETA);
    await s.close();

    let calls = 0;
    const s2 = await server((req, res) => {
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
      { transport: 'anthropic', id: 'claude', model: 'claude-sonnet-4-5', apiKey: 'sk-ant-api03-z', baseURL: s2.base },
      [{ role: 'user', content: 'y'.repeat(700000) }], null, noop, undefined, 1000,
    );
    eq('a refused beta is retried without it', calls, 2);
    eq('the retry returns a normal answer', msg.content, 'fell back');
    ok('the retry drops the beta header', !s2.seen.requests[1].headers['anthropic-beta']);
    cat.clearWindows();
    await s2.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — OpenAI Responses API (`codex` transport)');
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
    eq('tool result becomes function_call_output', input[3].call_id, 'c1');
    const tools = I.toCodexTools([{ function: { name: 'Bash', description: 'd', parameters: { type: 'object' } } }]);
    eq('responses tools are flat', [tools[0].type, tools[0].name, !!tools[0].function], ['function', 'Bash', false]);

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
      { transport: 'codex', model: 'gpt-5-codex', apiKey: 'sk-proj-test', baseURL: s.base + '/v1' },
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
    eq('posts to /v1/responses', req.url, '/v1/responses');
    eq('official bearer auth', req.headers.authorization, 'Bearer sk-proj-test');
    eq('official akron-code UA', req.headers['user-agent'], I.OFFICIAL_USER_AGENT);
    ok('no spoofed originator header sent', !('originator' in req.headers));
    ok('no spoofed chatgpt-account-id sent', !('chatgpt-account-id' in req.headers));
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — xAI Grok official API');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => sse(res, [
      { type: 'response.created', response: {} },
      { type: 'response.output_text.delta', delta: 'Hel' },
      { type: 'response.output_item.added', item: { type: 'function_call', id: 'fcX', name: 'Write', call_id: 'cX' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fcX', delta: '{"path":"a.txt"}' },
      { type: 'response.completed', response: { usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } } },
    ]));
    const msg = await t.chatCompletion(
      { transport: 'grok', model: 'grok-4.5', apiKey: 'xai-test-key', baseURL: s.base + '/v1' },
      [{ role: 'user', content: 'go' }], null, noop,
    );
    eq('grok stream text assembled', msg.content, 'Hel');
    eq('grok tool name captured', msg.tool_calls[0].function.name, 'Write');
    eq('grok call_id preferred', msg.tool_calls[0].id, 'cX');
    const req = s.seen.requests[0];
    eq('posts to /v1/responses', req.url, '/v1/responses');
    eq('official bearer auth on the wire', req.headers.authorization, 'Bearer xai-test-key');
    eq('official akron-code UA', req.headers['user-agent'], I.OFFICIAL_USER_AGENT);
    ok('no spoofed xai client identifier header', !('x-grok-client-identifier' in req.headers));
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — Google Gemini official API');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => {
      sse(res, [
        { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'lo' }] } }] },
        { candidates: [{ content: { parts: [{ functionCall: { name: 'Write', args: { path: 'x' } } }] }, finishReason: 'STOP' }] },
        { usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4, totalTokenCount: 7 } },
      ]);
    });
    const got = [];
    const msg = await t.chatCompletion(
      { transport: 'google', model: 'gemini-3-pro', apiKey: 'AIzaTestKey', baseURL: s.base + '/v1beta' },
      [{ role: 'system', content: 'be concise' }, { role: 'user', content: 'x' }],
      null,
      (d) => got.push(d),
    );
    eq('text accumulates across events', msg.content, 'Hello');
    eq('text streamed to caller', got.join(''), 'Hello');
    eq('function call captured', msg.tool_calls[0].function.name, 'Write');
    eq('finish reason maps from last candidate', msg.finish_reason, 'tool_calls');
    eq('usage mapped from usageMetadata', msg.usage.total_tokens, 7);
    const req = s.seen.requests[0];
    eq('hits official /v1beta/models/...:streamGenerateContent?alt=sse', req.url, '/v1beta/models/gemini-3-pro:streamGenerateContent?alt=sse');
    eq('sends x-goog-api-key header', req.headers['x-goog-api-key'], 'AIzaTestKey');
    eq('official akron-code UA', req.headers['user-agent'], I.OFFICIAL_USER_AGENT);
    eq('systemInstruction set directly', req.body.systemInstruction, { parts: [{ text: 'be concise' }] });
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — dispatch + listModels');
  // -------------------------------------------------------------------------
  eq('anthropic transport is recognised', t.needsTransport({ transport: 'anthropic' }), true);
  eq('codex transport is recognised', t.needsTransport({ transport: 'codex' }), true);
  eq('google transport is recognised', t.needsTransport({ transport: 'google' }), true);
  eq('grok transport is recognised', t.needsTransport({ transport: 'grok' }), true);
  eq('cli transport is NOT HTTP providertransport', t.needsTransport({ transport: 'cli' }), false);
  eq('openai-compatible providers keep default path', t.needsTransport({ baseURL: 'https://api.tokenrouter.com/v1/' }), false);

  {
    const s = await server((req, res) => {
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_input_tokens: 1000000, max_tokens: 64000 },
          ],
        }));
        return;
      }
      res.writeHead(404); res.end('{}');
    });
    const list = await t.listModels({ transport: 'anthropic', baseURL: s.base, apiKey: 'sk-ant-api03-k' });
    eq('anthropic listModels reads model', list[0].id, 'claude-sonnet-4-6');
    eq('anthropic listModels reads max_input_tokens', list[0].contextWindow, 1000000);
    eq('anthropic listModels sends x-api-key', s.seen.requests[0].headers['x-api-key'], 'sk-ant-api03-k');
    await s.close();
  }
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        models: [
          { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', inputTokenLimit: 1048576 },
        ],
      }));
    });
    const list = await t.listModels({ transport: 'google', baseURL: s.base + '/v1beta', apiKey: 'AIzaTest' });
    eq('google listModels strips models/ prefix', list[0].id, 'gemini-2.5-pro');
    eq('google listModels captures contextWindow', list[0].contextWindow, 1048576);
    eq('google listModels sends x-goog-api-key', s.seen.requests[0].headers['x-goog-api-key'], 'AIzaTest');
    await s.close();
  }
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'grok-4.5', context_length: 256000 }] }));
    });
    const list = await t.listModels({ transport: 'grok', baseURL: s.base + '/v1', apiKey: 'xai-k' });
    eq('grok listModels parses id', list[0].id, 'grok-4.5');
    eq('grok listModels sends official bearer', s.seen.requests[0].headers.authorization, 'Bearer xai-k');
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\ntransport — llm.js normalization');
  // -------------------------------------------------------------------------
  {
    const llm = require('../electron/llm');
    const cliP = llm.normalizeProvider({
      model: 'claude-sonnet-4-6',
      transport: 'cli',
      cliId: 'claude-code',
      cliBin: 'claude',
      cliKind: 'claude',
      cliMode: true,
    });
    eq('normalizeProvider keeps cli transport', cliP.transport, 'cli');
    eq('normalizeProvider keeps cliMode', cliP.cliMode, true);
    eq('normalizeProvider does not fallback CLI rows to localhost ollama', cliP.baseURL, '');
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + (process.exitCode ? 'FAILURES' : '0 failed') + ' ===');
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
