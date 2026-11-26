'use strict';
const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const llm = require('../electron/llm');

(async () => {
  // 1. Mock OpenAI-compatible router where request uses alias 'auto'
  //    and SSE chunks reveal actual model 'qwen/qwen3.8-27b'.
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      if (req.url === '/v1/chat/completions') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'x-freellm-model': 'qwen/qwen3.8-27b',
        });
        res.write('data: {"id":"1","model":"qwen/qwen3.8-27b","choices":[{"index":0,"delta":{"content":"HELLO_"},"finish_reason":null}]}\n\n');
        res.write('data: {"id":"1","model":"qwen/qwen3.8-27b","choices":[{"index":0,"delta":{"content":"WORLD"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-model-attr-'));

  try {
    const events = [];
    const outMsgs = await llm.runAgent({
      provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'auto', supportsTools: false },
      messages: [{ role: 'user', content: 'hi' }],
      cwd: tmpDir,
      useMemory: false,
      emit: (e) => events.push(e),
      maxSteps: 3,
    });
    assert.ok(outMsgs.some((m) => m.role === 'assistant' && m.content.includes('HELLO_WORLD')));
    const modelEvt = events.find((e) => e.type === 'model');
    assert.ok(modelEvt, 'expected a model event to be emitted');
    assert.strictEqual(modelEvt.model, 'qwen/qwen3.8-27b');
    const usageEvt = events.find((e) => e.type === 'usage');
    assert.ok(usageEvt && usageEvt.usage, 'expected usage event');
    assert.strictEqual(usageEvt.model, 'qwen/qwen3.8-27b');
    assert.strictEqual(usageEvt.usage.model, 'qwen/qwen3.8-27b');

    // 2. Mock Orchestrator failover: primary returns 429, fallback 'deepseek/deepseek-chat' succeeds
    let calls = 0;
    const srvFailover = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        calls++;
        const body = JSON.parse(raw || '{}');
        if (body.model === 'model-primary') {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limited' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'c2',
          model: 'deepseek/deepseek-chat',
          choices: [{ index: 0, message: { role: 'assistant', content: 'FALLBACK_OK' }, finish_reason: 'stop' }],
        }));
      });
    });
    await new Promise((r) => srvFailover.listen(0, '127.0.0.1', r));
    const foPort = srvFailover.address().port;
    try {
      const evts2 = [];
      await llm.runAgent({
        provider: { baseURL: `http://127.0.0.1:${foPort}/v1`, apiKey: 'test', model: 'model-primary', supportsTools: false },
        orchestrator: {
          enabled: true,
          providers: [
            { baseURL: `http://127.0.0.1:${foPort}/v1`, apiKey: 'test', model: 'model-primary', enabled: true },
            { baseURL: `http://127.0.0.1:${foPort}/v1`, apiKey: 'test', model: 'deepseek/deepseek-chat', enabled: true },
          ],
        },
        messages: [{ role: 'user', content: 'hi' }],
        cwd: tmpDir,
        useMemory: false,
        emit: (e) => evts2.push(e),
        maxSteps: 3,
      });
      const m2 = evts2.filter((e) => e.type === 'model').pop();
      assert.ok(m2, 'expected model event on orchestrator failover');
      assert.strictEqual(m2.model, 'deepseek/deepseek-chat');
    } finally {
      await new Promise((r) => srvFailover.close(r));
    }

    console.log('MODEL_ATTRIBUTION_ALL_PASS');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await new Promise((r) => srv.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
