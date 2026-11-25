#!/usr/bin/env node
'use strict';
// Live probe: Antigravity transport through the shipping adapter code.
// Reads the real token from the OS keychain, exercises googleModels() and
// googleChat() for text, thinking-filtering, and tool calls.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const T = require(path.join(__dirname, '..', 'electron', 'providertransport.js'));

const raw = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], { encoding: 'utf8' }).trim();
if (!raw.startsWith('go-keyring-base64:')) throw new Error('unexpected keychain payload');
const blob = JSON.parse(Buffer.from(raw.slice('go-keyring-base64:'.length), 'base64').toString('utf8'));
const accessToken = blob.token.access_token;

const provider = { id: 'antigravity', transport: 'google', accessToken, model: 'gemini-4-neon-high' };
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; };

(async () => {
  // 1. live model catalog + real context windows
  const models = await T._internal.googleModels(provider);
  ok(models.length > 20, `fetchAvailableModels -> ${models.length} models`);
  const neon = models.find((m) => m.id === 'gemini-4-neon-high');
  ok(!!neon, 'gemini-4-neon-high present');
  ok(neon && neon.contextWindow === 1048576, `gemini-4-neon-high contextWindow=${neon && neon.contextWindow}`);
  const sonnet = models.find((m) => m.id === 'claude-sonnet-5-5-medium');
  ok(sonnet && sonnet.contextWindow === 1000000, `claude-sonnet-5-5-medium contextWindow=${sonnet && sonnet.contextWindow} (group ${sonnet && sonnet.group})`);
  ok(models.every((m) => m.contextWindow > 0), 'every model reports a real contextWindow');
  ok(models.every((m) => m.id && m.label), 'every model has id + label');

  // 2. plain text turn
  let streamed = '';
  const msg = await T.chatCompletion(
    Object.assign({}, provider, { model: 'gemini-4-neon-high' }),
    [{ role: 'user', content: 'Reply with exactly: PING742' }],
    [],
    (d) => { streamed += d; },
    undefined,
    2048,
  );
  ok(/PING742/.test(msg.content), `text turn -> ${JSON.stringify(msg.content.slice(0, 40))}`);
  ok(streamed === msg.content, 'onDelta streamed exactly the final content');
  ok(msg.finish_reason === 'stop', `finish_reason=${msg.finish_reason}`);
  ok(!/PING742/.test(msg.content) === false && !msg.content.includes('<'), 'no markup in content');

  // 3. Vertex-Claude model through the same endpoint
  const claudeMsg = await T.chatCompletion(
    Object.assign({}, provider, { model: 'claude-sonnet-5-5-medium' }),
    [{ role: 'user', content: 'Reply with exactly: VERTEX33' }],
    [],
    () => {},
    undefined,
    2048,
  );
  ok(/VERTEX33/.test(claudeMsg.content), `vertex-claude turn -> ${JSON.stringify(claudeMsg.content.slice(0, 40))}`);

  // 4. tool call
  const toolMsg = await T.chatCompletion(
    Object.assign({}, provider, { model: 'gemini-4-neon-high' }),
    [{ role: 'user', content: 'What is the weather in Dhaka? Use the tool.' }],
    [{ type: 'function', function: { name: 'get_weather', description: 'Get weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
    () => {},
    undefined,
    4096,
  );
  const tc = (toolMsg.tool_calls || [])[0];
  ok(!!tc, 'tool call returned');
  ok(tc && tc.function.name === 'get_weather', `tool name=${tc && tc.function.name}`);
  ok(tc && JSON.parse(tc.function.arguments).city, `tool args=${tc && tc.function.arguments}`);
  ok(toolMsg.finish_reason === 'tool_calls', `tool finish_reason=${toolMsg.finish_reason}`);

  // 5. thinking parts never leak into content
  ok(!msg.content.includes('thought'), 'thinking parts filtered out');
  ok(msg.usage && msg.usage.input_tokens > 0, `usage=${JSON.stringify(msg.usage)}`);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error('ERROR', e && e.stack || e); process.exit(1); });
