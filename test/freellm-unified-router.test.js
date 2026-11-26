'use strict';
const assert = require('assert');
const http = require('http');
const freellm = require('../electron/freellm');
const extbridge = require('../electron/extbridge');

function req(port, method, urlPath, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: urlPath,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    r.on('error', reject);
    if (body != null) r.write(typeof body === 'string' ? body : JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const UNIFIED_KEY = 'fllm_test_unified_key_12345';
  let seenAuth = '';

  // 1. Mock standalone FreeLLMAPI Unified Router (like Windows :31415 app)
  const extServer = http.createServer((incoming, res) => {
    let raw = '';
    incoming.on('data', (c) => { raw += c; });
    incoming.on('end', () => {
      const auth = String(incoming.headers.authorization || '');
      seenAuth = auth;
      if (auth !== `Bearer ${UNIFIED_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'authentication_error' } }));
        return;
      }
      if (incoming.method === 'GET' && incoming.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [
            { id: 'auto', object: 'model' },
            { id: 'fusion', object: 'model' },
            { id: 'claude-sonnet-4-5', object: 'model' },
          ],
        }));
        return;
      }
      if (incoming.method === 'POST' && incoming.url === '/v1/chat/completions') {
        const body = JSON.parse(raw || '{}');
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
          res.write('data: {"id":"1","choices":[{"index":0,"delta":{"content":"UNIFIED_"},"finish_reason":null}]}\n\n');
          res.write('data: {"id":"1","choices":[{"index":0,"delta":{"content":"STREAM_OK"},"finish_reason":"stop"}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-unified',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content: 'UNIFIED_OK' }, finish_reason: 'stop' }],
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });

  await new Promise((r) => extServer.listen(0, '127.0.0.1', r));
  const extPort = extServer.address().port;
  const extUrl = `http://127.0.0.1:${extPort}/v1`;

  // Empty internal freellm.js config (zero ~/.autobot/freellm.json providers)
  const emptyCfg = freellm.normalizeConfig({ providers: {} });
  const { server: bridgeServer } = freellm.createRouter(emptyCfg, { upstreamURL: extUrl, timeoutMs: 4000 });
  await new Promise((r) => bridgeServer.listen(0, '127.0.0.1', r));
  const bridgePort = bridgeServer.address().port;

  try {
    // 1. Anonymous GET /v1/models propagates 401 (no fake green dot!)
    const unauth = await req(bridgePort, 'GET', '/v1/models');
    assert.strictEqual(unauth.status, 401, `expected 401, got ${unauth.status}: ${unauth.body}`);

    // 2. Authenticated GET /v1/models forwards Unified Key & returns external catalog
    const authed = await req(bridgePort, 'GET', '/v1/models', { authorization: `Bearer ${UNIFIED_KEY}` });
    assert.strictEqual(authed.status, 200, authed.body);
    const list = JSON.parse(authed.body);
    assert.deepStrictEqual(list.data.map((m) => m.id), ['auto', 'fusion', 'claude-sonnet-4-5']);

    // 3. Non-streaming POST /v1/chat/completions proxies transparently
    const chatRes = await req(bridgePort, 'POST', '/v1/chat/completions', {
      'content-type': 'application/json',
      authorization: `Bearer ${UNIFIED_KEY}`,
    }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: false });
    assert.strictEqual(chatRes.status, 200, chatRes.body);
    assert.strictEqual(JSON.parse(chatRes.body).choices[0].message.content, 'UNIFIED_OK');

    // 4. Streaming POST /v1/chat/completions proxies SSE chunks transparently
    const streamRes = await req(bridgePort, 'POST', '/v1/chat/completions', {
      'content-type': 'application/json',
      authorization: `Bearer ${UNIFIED_KEY}`,
    }, { model: 'auto', messages: [{ role: 'user', content: 'hi' }], stream: true });
    assert.strictEqual(streamRes.status, 200, streamRes.body);
    assert.ok(streamRes.body.includes('UNIFIED_') && streamRes.body.includes('STREAM_OK'), streamRes.body);

    // 5. Fallback key provider supplies Unified Key when caller omits Authorization
    freellm.setFallbackKeyProvider(() => UNIFIED_KEY);
    const fbRes = await req(bridgePort, 'GET', '/v1/models');
    assert.strictEqual(fbRes.status, 200, fbRes.body);
    assert.strictEqual(seenAuth, `Bearer ${UNIFIED_KEY}`);

    // 6. Unconfigured router with NO reachable external router returns 503 on /v1/models
    const { server: soloServer } = freellm.createRouter(emptyCfg, { upstreamURL: false, timeoutMs: 1000 });
    await new Promise((r) => soloServer.listen(0, '127.0.0.1', r));
    try {
      const deadModels = await req(soloServer.address().port, 'GET', '/v1/models');
      assert.strictEqual(deadModels.status, 503, deadModels.body);
    } finally {
      await new Promise((r) => soloServer.close(r));
    }

    // 7. extbridge loopback /v1/ext/tabs + Origin rejection guard
    const st = await extbridge.start({ port: 0 });
    assert.strictEqual(st.ok, true);
    try {
      const okTabs = await req(st.port, 'GET', '/v1/ext/tabs');
      assert.strictEqual(okTabs.status, 200, okTabs.body);
      assert.strictEqual(JSON.parse(okTabs.body).ok, true);

      const badOrigin = await req(st.port, 'POST', '/v1/ext/tool', {
        origin: 'https://evil.example.com',
        'content-type': 'application/json',
      }, { action: 'list_tabs' });
      assert.strictEqual(badOrigin.status, 403, badOrigin.body);
    } finally {
      await extbridge.stop();
    }

    console.log('FREELM_UNIFIED_ROUTER_ALL_PASS');
  } finally {
    freellm.setFallbackKeyProvider(null);
    await new Promise((r) => bridgeServer.close(r));
    await new Promise((r) => extServer.close(r));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
