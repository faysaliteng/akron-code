'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { getEventListeners } = require('node:events');
const transport = require('../electron/providertransport.js');
const llm = require('../electron/llm.js');

function startHangingSseServer(handler) {
  return new Promise((resolve) => {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      sockets.add(res.socket);
      res.socket?.on('close', () => sockets.delete(res.socket));
      handler(req, res);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => {
          for (const s of sockets) {
            try { s.destroy(); } catch (_) {}
          }
          server.close(() => r());
        }),
      });
    });
  });
}

test('Anthropic adapter aborts mid-stream immediately when Stop fires and cleans abort listeners', async () => {
  const srv = await startHangingSseServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":5}}}\n\n');
    res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
    res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n');
    // Keep socket open indefinitely to simulate stalled / long generation.
  });

  const ac = new AbortController();
  const deltas = [];
  let abortAt = 0;

  try {
    const p = {
      transport: 'anthropic',
      baseURL: srv.url,
      apiKey: 'sk-test',
      model: 'claude-fable-5-2',
      timeoutMs: 30000,
    };
    const promise = transport.chatCompletion(p, [{ role: 'user', content: 'hi' }], [], (d) => {
      deltas.push(d);
      if (!abortAt) {
        setTimeout(() => {
          abortAt = Date.now();
          ac.abort();
        }, 25);
      }
    }, ac.signal);

    await assert.rejects(promise, (err) => err && (err.name === 'AbortError' || /abort/i.test(String(err.message))));
    const elapsedMs = Date.now() - abortAt;
    assert.ok(deltas.join('').includes('Hello'), 'should receive initial streamed delta before abort');
    assert.ok(elapsedMs < 500, `expected <500ms abort latency, got ${elapsedMs}ms`);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'abort signal listener must not leak');
  } finally {
    await srv.close();
  }
});

test('OpenAI chatWithFailover aborts mid-stream immediately when Stop fires and cleans abort listeners', async () => {
  const srv = await startHangingSseServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.write('data: {"id":"c1","choices":[{"index":0,"delta":{"content":"Working"}}]}\n\n');
    // Leave open indefinitely.
  });

  const ac = new AbortController();
  let deltas = '';
  let abortAt = 0;

  try {
    const p = llm.normalizeProvider({
      baseURL: `${srv.url}/v1`,
      apiKey: 'sk-test',
      model: 'gpt-5-4',
    });
    const promise = llm.chatWithFailover({
      list: [p],
      getIndex: () => 0,
      setIndex: () => {},
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      signal: ac.signal,
      onDelta: (d) => {
        deltas += d;
        if (!abortAt) {
          setTimeout(() => {
            abortAt = Date.now();
            ac.abort();
          }, 25);
        }
      },
    });

    await assert.rejects(promise, (err) => err && (err.name === 'AbortError' || /abort|cancel/i.test(String(err.message))));
    const elapsedMs = Date.now() - abortAt;
    assert.ok(deltas.includes('Working'), 'should receive initial delta chunk before Stop');
    assert.ok(elapsedMs < 500, `expected <500ms abort latency, got ${elapsedMs}ms`);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'abort signal listener must not leak');
  } finally {
    await srv.close();
  }
});

test('OpenAI chatWithFailover negotiates HTTP 500 Unexpected reasoning effort error cleanly', async () => {
  const bodies = [];
  const srv = await startHangingSseServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const parsed = JSON.parse(raw || '{}');
      bodies.push(parsed);
      if (bodies.length === 1 && parsed.reasoning_effort) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unexpected reasoning effort level in template' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"c2","choices":[{"index":0,"delta":{"content":"OK-NEGOTIATED"},"finish_reason":"stop"}]}\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });

  try {
    const p = llm.normalizeProvider({
      baseURL: `${srv.url}/v1`,
      apiKey: 'sk-test',
      model: 'local-reasoning-model',
      reasoningLevel: 'high',
    });
    const out = await llm.chatWithFailover({
      list: [p],
      getIndex: () => 0,
      setIndex: () => {},
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });
    assert.equal(out.content, 'OK-NEGOTIATED');
    assert.equal(bodies.length, 2, 'should negotiate and succeed on retry');
    assert.ok('reasoning_effort' in bodies[0], 'first call sends reasoning_effort');
    assert.equal('reasoning_effort' in bodies[1], false, 'retry strips reasoning_effort after HTTP 500');
  } finally {
    await srv.close();
  }
});
