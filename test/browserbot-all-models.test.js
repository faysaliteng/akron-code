'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const transport = require('../electron/providertransport');
const extbridge = require('../electron/extbridge');

const I = transport._internal;
const EI = extbridge._internal;

let passed = 0;
function eq(label, actual, expected) {
  assert.deepStrictEqual(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  passed++;
}
function ok(label, cond, extra) {
  assert.ok(cond, `${label}${extra ? ': ' + extra : ''}`);
  passed++;
}

async function run() {
  console.log('\n[1] toGeminiContents multi-turn tool_use.id + thoughtSignature + multimodal');
  {
    const { contents } = I.toGeminiContents([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'check profit overview' },
      {
        role: 'assistant',
        content: 'Let me inspect the page.',
        tool_calls: [{ id: 'toolu_vrtx_01ABC', type: 'function', function: { name: 'read_text', arguments: '{"maxChars":1000}' }, thoughtSignature: 'sig_xyz' }],
      },
      // OpenAI-format tool response intentionally omits `name` (Browser Bot format!)
      { role: 'tool', tool_call_id: 'toolu_vrtx_01ABC', content: 'Today 16 orders $27.00' },
      { role: 'assistant', content: 'Most recent order is #30090.' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'check whole month and compare' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } },
        ],
      },
    ], 'claude-opus-5-5-medium');

    const fc = contents[1].parts[1].functionCall;
    eq('functionCall preserves exact id for Vertex-Claude', fc.id, 'toolu_vrtx_01ABC');
    eq('functionCall preserves thoughtSignature', contents[1].parts[1].thoughtSignature, 'sig_xyz');
    const fr = contents[2].parts[0].functionResponse;
    eq('functionResponse preserves id', fr.id, 'toolu_vrtx_01ABC');
    eq('functionResponse resolves name from tool_call_id when omitted', fr.name, 'read_text');
    eq('multimodal image_url converts to Gemini inlineData', contents[4].parts[1].inlineData, {
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    });
  }

  console.log('\n[2] toGeminiContents injects skip_thought_signature_validator for Gemini 3/4');
  {
    const { contents } = I.toGeminiContents([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [{ id: '', type: 'function', function: { name: 'read_page', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: '', content: 'ok' },
    ], 'gemini-4-neon-high');

    ok('fallback id synthesized when empty', !!contents[1].parts[0].functionCall.id);
    eq('gemini-4 receives skip_thought_signature_validator', contents[1].parts[0].thoughtSignature, 'skip_thought_signature_validator');
  }

  console.log('\n[3] toAnthropicBody sanitizes IDs and repairs orphan/interrupted tool pairs');
  {
    const body = I.toAnthropicBody({ model: 'claude-sonnet-5-5' }, [
      { role: 'tool', tool_call_id: 'orphan_1', content: 'stale output' },
      { role: 'assistant', content: 'calling', tool_calls: [{ id: 'bad:id/1', type: 'function', function: { name: 'read_text', arguments: '{}' } }] },
      { role: 'user', content: 'user interrupted with screenshot!' },
      { role: 'assistant', content: 'next step', tool_calls: [{ id: 'good_2', type: 'function', function: { name: 'click', arguments: '{"ref":"e1"}' } }] },
      { role: 'tool', tool_call_id: 'good_2', content: 'clicked' },
    ], null, 4096);

    eq('leading orphan tool_result converted to safe text block', body.messages[0].content[0].type, 'text');
    const badId = body.messages[1].content[1].id;
    ok('invalid chars sanitized in tool_use.id', /^[A-Za-z0-9_-]+$/.test(badId));
    eq('interrupted tool_use receives synthetic tool_result before user text', body.messages[2].content[0], {
      type: 'tool_result',
      tool_use_id: badId,
      content: '(no output)',
    });
    eq('subsequent valid pair preserved intact', body.messages[4].content[0].tool_use_id, 'good_2');
  }

  console.log('\n[4] toCodexInput handles multimodal images and orphan outputs');
  {
    const { input } = I.toCodexInput([
      { role: 'tool', tool_call_id: 'missing', content: 'orphan' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c_ok', type: 'function', function: { name: 'read_text', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c_ok', content: 'done' },
    ]);
    eq('orphan tool becomes input_text user message', input[0].content[0].type, 'input_text');
    eq('user image_url becomes input_image', input[1].content[1], { type: 'input_image', image_url: 'data:image/png;base64,AAAA' });
    eq('valid function_call_output matches call_id', input[3].call_id, 'c_ok');
  }

  console.log('\n[5] extbridge model-family routing isolates incompatible transports');
  {
    eq('Vertex-Claude suffix prefers google transport', EI.inferModelTransport('claude-opus-5-5-medium')[0], 'google');
    eq('First-party Claude prefers anthropic transport', EI.inferModelTransport('claude-sonnet-5-5')[0], 'anthropic');
    eq('Gemini routes to google', EI.inferModelTransport('gemini-4-neon-high')[0], 'google');
    eq('Grok routes to grok', EI.inferModelTransport('grok-4.5')[0], 'grok');
    eq('Tag suffix routes to ollama', EI.inferModelTransport('gemma4:latest')[0], 'ollama');
    eq('Open-weights route to freellm', EI.inferModelTransport('qwen3.8-flash')[0], 'freellm');

    const norm = EI.normalizeOpenAIMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read_text', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'page body' },
    ]);
    eq('normalizeOpenAIMessages fills missing tool.name from id', norm[1].name, 'read_text');
  }

  console.log('\n[5b] googleChat 2-turn Vertex-Claude wire roundtrip includes tool_use.id & name');
  {
    const http = require('http');
    const seenBodies = [];
    const srv = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => {
          seenBodies.push(JSON.parse(raw));
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          if (seenBodies.length === 1) {
            res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ functionCall: { id: 'toolu_vrtx_99', name: 'read_text', args: { maxChars: 500 } }, thoughtSignature: 'sig_v1' }] }, finishReason: 'STOP' }] })}\n\n`);
          } else {
            res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Compared successfully.' }] }, finishReason: 'STOP' }] })}\n\n`);
          }
          res.end();
        });
      });
      s.listen(0, '127.0.0.1', () => resolve({ server: s, base: 'http://127.0.0.1:' + s.address().port }));
    });
    try {
      const prov = { transport: 'google', model: 'claude-opus-5-5-medium', apiKey: 'AIzaTestKey', baseURL: srv.base + '/v1beta' };
      const r1 = await transport.chatCompletion(prov, [{ role: 'user', content: 'check' }], null, () => {});
      eq('Turn 1 preserves thoughtSignature on tool_call', r1.tool_calls[0].thoughtSignature, 'sig_v1');
      const r2 = await transport.chatCompletion(prov, [
        { role: 'user', content: 'check' },
        r1,
        { role: 'tool', tool_call_id: r1.tool_calls[0].id, content: 'Today 16 | Month 1347' },
        { role: 'user', content: 'compare whole month' },
      ], null, () => {});
      eq('Turn 2 wire functionCall carries id', seenBodies[1].contents[1].parts[0].functionCall.id, 'toolu_vrtx_99');
      eq('Turn 2 wire functionCall carries thoughtSignature', seenBodies[1].contents[1].parts[0].thoughtSignature, 'sig_v1');
      eq('Turn 2 wire functionResponse carries id', seenBodies[1].contents[2].parts[0].functionResponse.id, 'toolu_vrtx_99');
      eq('Turn 2 wire functionResponse carries resolved name', seenBodies[1].contents[2].parts[0].functionResponse.name, 'read_text');
      eq('Turn 2 completes cleanly', r2.content, 'Compared successfully.');
    } finally {
      await new Promise((r) => srv.server.close(r));
    }
  }

  console.log('\n[6] Akron Code branding & response footer actions present in source and bundle');
  {
    const i18n = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n.js'), 'utf8');
    ok('brand.sub uses by Akronlogic.com', /'brand\.sub':\s*'by Akronlogic\.com'/.test(i18n));
    const appJsx = fs.readFileSync(path.join(__dirname, '..', 'src', 'App.jsx'), 'utf8');
    ok('titlebar shows Akron Code', appJsx.includes('<span className="brand">Akron Code</span>'));
    ok('response actions bar present (Copy/Fork/Retry/Share)',
      appJsx.includes('data-response-actions') &&
      appJsx.includes('forkFromMessage') &&
      appJsx.includes('shareFromMessage'));
  }

  console.log(`\nALL ASSERTIONS PASSED (${passed} checks)\n`);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
