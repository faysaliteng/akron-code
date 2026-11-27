'use strict';
const assert = require('assert');
const pt = require('../electron/providertransport');

let pass = 0;
async function check(name, fn) {
  await fn();
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('\ntransport-thinking-codex tests');

  await check('toAnthropicBody attaches thinking budget and replays signed thinking blocks', async () => {
    const msgs = [
      { role: 'user', content: 'Inspect foo.js' },
      {
        role: 'assistant',
        content: 'Reading foo.js',
        _anthropicThinkingBlocks: [{ type: 'thinking', thinking: 'Let me inspect foo.js', signature: 'sig_abc123' }],
        tool_calls: [{ id: 'tc_1', type: 'function', function: { name: 'Read', arguments: '{"path":"foo.js"}' } }],
      },
      { role: 'tool', tool_call_id: 'tc_1', content: 'console.log(1);' },
    ];
    const body = pt._internal.toAnthropicBody({ model: 'claude-sonnet-4-6', reasoningLevel: 'medium' }, msgs, [], 4096);
    assert.deepStrictEqual(body.thinking, { type: 'enabled', budget_tokens: 8192 });
    assert.ok(body.max_tokens >= 8192 + 4096);
    assert.strictEqual(body.messages[1].content[0].type, 'thinking');
    assert.strictEqual(body.messages[1].content[0].signature, 'sig_abc123');
  });

  await check('toAnthropicBody disables thinking safely when prior assistant tool_use lacks signed thinking block', async () => {
    const msgs = [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'tc_legacy', type: 'function', function: { name: 'Read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'tc_legacy', content: 'done' },
    ];
    const body = pt._internal.toAnthropicBody({ model: 'claude-opus-4-6', reasoningLevel: 'high' }, msgs, [], 8192);
    assert.strictEqual(body.thinking, undefined);
  });

  await check('codexChat sends max_output_tokens override and include:[reasoning.encrypted_content]', async () => {
    // Capture request via stubbed global fetch
    const origFetch = global.fetch;
    let capturedBody = null;
    global.fetch = async (_url, init) => {
      capturedBody = JSON.parse(init.body);
      return new Response('data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"ok"}]}]}}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
    try {
      await pt.chatCompletion(
        { transport: 'codex', model: 'gpt-5.4', accessToken: 'tok', maxTokens: 4000, reasoningLevel: 'high' },
        [{ role: 'user', content: 'ping' }],
        [],
        () => {},
        null,
        12345
      );
      assert.strictEqual(capturedBody.max_output_tokens, 12345);
      assert.deepStrictEqual(capturedBody.include, ['reasoning.encrypted_content']);
    } finally {
      global.fetch = origFetch;
    }
  });

  console.log(`\n${pass} passed, 0 failed`);
})();
