'use strict';
// FreeLLMAPI router tests — fake upstream, no network, no real keys.
const http = require('http');
const assert = require('assert');

let pass = 0;
let fail = 0;
function ok(name) { pass++; console.log('  ok  ' + name); }
function bad(name, err) { fail++; console.log('  FAIL ' + name + ' — ' + (err && err.message ? err.message : err)); }
async function t(name, fn) { try { await fn(); ok(name); } catch (e) { bad(name, e); } }

const freellm = require('../electron/freellm');

// ---------------------------------------------------------------------------
// Fake upstream: behaviour is driven by the model name.
//   ok/...            → 200 chat completion echoing the model
//   slow/...          → waits 300 ms then answers
//   e429/...          → 429 HTML error page
//   e500/...          → 500 JSON error
//   e400/...          → 400 JSON error
//   stream/...        → 200 SSE with two deltas
//   null/...          → 200 but not a completion object
// ---------------------------------------------------------------------------
const hits = [];

function listen(handler) {
  const srv = http.createServer(handler);
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    const port = srv.address().port;
    resolve({
      srv,
      url: 'http://127.0.0.1:' + port,
      close: () => new Promise((done) => { try { srv.closeAllConnections(); } catch (_) {} srv.close(() => done()); }),
    });
  }));
}

function completion(model) {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    created: 1,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: 'PONG ' + model }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

async function upstreamServer() {
  return listen((req, res) => {
    if (req.method === 'GET' && /\/models$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'ok/model-a' }, { id: 'ok/model-b' }] }));
      return;
    }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      let body = {};
      try { body = JSON.parse(raw); } catch (_) {}
      const model = String(body.model || '');
      hits.push({ url: req.url, auth: req.headers.authorization || '', body, at: Date.now() });
      const kind = model.split('/')[0];
      if (kind === 'slow') {
        await new Promise((r) => setTimeout(r, 300));
      }
      if (kind === 'e429') {
        res.writeHead(429, { 'content-type': 'text/html' });
        res.end('<html><head><style>body{color:red}</style></head><body><h1>Rate limited</h1><p>Too many requests</p></body></html>');
        return;
      }
      if (kind === 'e500') {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'upstream exploded' } }));
        return;
      }
      if (kind === 'e400') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'bad parameter' } }));
        return;
      }
      if (kind === 'null') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ hello: 'not a completion' }));
        return;
      }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'PONG' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ' STREAM' } }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(completion(model)));
    });
  });
}

function cfgFor(url, extra) {
  const providers = {};
  for (const id of freellm.PROVIDER_IDS) {
    providers[id] = { enabled: false, apiKey: '', accountId: '', baseURL: url, defaultModel: 'ok/default-' + id };
  }
  providers.groq.enabled = true;
  providers.groq.apiKey = 'GROQKEY';
  providers.gemini.enabled = true;
  providers.gemini.apiKey = 'GEMINIKEY';
  if (extra) {
    for (const [id, patch] of Object.entries(extra)) {
      providers[id] = { ...providers[id], ...patch };
    }
  }
  return {
    host: '127.0.0.1',
    port: 0,
    timeoutMs: 5000,
    order: ['groq', 'gemini', 'cloudflare', 'nvidia', 'cohere', 'kilo', 'openrouter'],
    providers,
  };
}

function post(port, path, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload || {});
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...(headers || {}) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

function get(port, path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('freellm');

  // ---- pure functions -----------------------------------------------------
  await t('normalizeConfig fills defaults and env-style keys', () => {
    const cfg = freellm.normalizeConfig({ providers: { groq: { apiKey: 'k' } } });
    assert.strictEqual(cfg.port, 3001);
    assert.strictEqual(cfg.host, '127.0.0.1');
    assert.strictEqual(cfg.providers.groq.apiKey, 'k');
    assert.strictEqual(cfg.providers.groq.baseURL, freellm.PROVIDERS.groq.baseURL);
    assert.deepStrictEqual(cfg.providers.groq.enabled, true);
    assert.strictEqual(cfg.port, 3001);
  });

  await t('normalizeConfig tolerates garbage', () => {
    for (const bad of [null, undefined, 42, 'x', [], { providers: null }]) {
      const cfg = freellm.normalizeConfig(bad);
      assert.strictEqual(cfg.port, 3001);
      assert.ok(cfg.providers.groq);
    }
  });

  await t('resolveModel: auto/empty/default', () => {
    const cfg = freellm.normalizeConfig({});
    for (const input of ['', null, undefined, 'auto', 'AUTO', 'default', 'freellm/auto']) {
      assert.strictEqual(freellm.resolveModel(input, cfg).mode, 'auto', String(input));
    }
  });

  await t('resolveModel: fast/smart aliases use their order', () => {
    const cfg = freellm.normalizeConfig({});
    const fast = freellm.resolveModel('fast', cfg);
    assert.strictEqual(fast.mode, 'order');
    assert.strictEqual(fast.order[0], 'groq');
    const smart = freellm.resolveModel('smart', cfg);
    assert.strictEqual(smart.mode, 'order');
    assert.strictEqual(smart.order[0], 'nvidia');
  });

  await t('resolveModel: provider-qualified ids', () => {
    const cfg = freellm.normalizeConfig({});
    const r = freellm.resolveModel('groq/qwen/qwen3.8-27b', cfg);
    assert.strictEqual(r.mode, 'explicit');
    assert.strictEqual(r.provider, 'groq');
    assert.strictEqual(r.model, 'qwen/qwen3.8-27b');
    // colon form
    const c = freellm.resolveModel('gemini:gemini-3.5-flash-lite', cfg);
    assert.strictEqual(c.provider, 'gemini');
    assert.strictEqual(c.model, 'gemini-3.5-flash-lite');
    // provider alone → its default
    const d = freellm.resolveModel('cohere', cfg);
    assert.strictEqual(d.mode, 'explicit');
    assert.strictEqual(d.model, freellm.PROVIDERS.cohere.defaultModel);
    // double prefix
    const p = freellm.resolveModel('freellm/groq/qwen/qwen3.8-27b', cfg);
    assert.strictEqual(p.provider, 'groq');
  });

  await t('resolveModel: unqualified non-alias stays auto with model hint', () => {
    const cfg = freellm.normalizeConfig({});
    const r = freellm.resolveModel('some-random-model', cfg);
    assert.strictEqual(r.mode, 'auto');
    assert.strictEqual(r.model, 'some-random-model');
  });

  await t('stripMarkup removes html/css and decodes entities', () => {
    const s = freellm.stripMarkup('<div class="x"><style>a{}</style>Rate&nbsp;limited &amp; <b>slow</b></div>');
    assert.ok(!/[<>]/.test(s), s);
    assert.ok(/Rate limited & slow/.test(s), s);
  });

  await t('describeError parses JSON, arrays, and picks a message', () => {
    assert.strictEqual(freellm.describeError(500, JSON.stringify({ error: { message: 'boom' } })), 'boom');
    assert.strictEqual(freellm.describeError(500, JSON.stringify([{ error: { message: 'arr' } }])), 'arr');
    assert.strictEqual(freellm.describeError(500, JSON.stringify({ message: 'top' })), 'top');
    assert.ok(/HTTP 503/.test(freellm.describeError(503, '')));
    const html = freellm.describeError(429, '<html><body><h1>Too many</h1></body></html>');
    assert.ok(!/[<>]/.test(html), html);
    assert.ok(/Too many/.test(html), html);
  });

  // ---- fake upstream behaviour --------------------------------------------
  const up = await upstreamServer();
  try {
    await t('buildUpstream forwards only whitelisted fields + drops the router key', () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      const cand = { provider: 'groq', model: 'ok/m', cfg: cfg.providers.groq };
      const built = freellm.buildUpstream(cand, {
        messages: [{ role: 'user', content: 'hi' }],
        model: 'ignored',
        temperature: 0.1,
        top_p: 0.9,
        nonsense_field: 'nope',
        max_tokens: 0,
        stream: true,
      });
      assert.strictEqual(built.payload.model, 'ok/m');
      assert.strictEqual(built.payload.temperature, 0.1);
      assert.strictEqual(built.payload.top_p, 0.9);
      assert.ok(!('nonsense_field' in built.payload));
      assert.ok(!('max_tokens' in built.payload), 'max_tokens 0 should be dropped');
      assert.strictEqual(built.payload.stream, true);
      assert.ok(/^Bearer /.test(built.headers.authorization));
      assert.ok(/\/chat\/completions$/.test(built.url));
    });

    await t('buildUpstream rejects a missing messages[]', () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      const cand = { provider: 'groq', model: 'ok/m', cfg: cfg.providers.groq };
      assert.throws(() => freellm.buildUpstream(cand, {}), /messages/);
    });

    await t('buildUpstream substitutes the Cloudflare account id', () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url, {
        cloudflare: {
          enabled: true,
          apiKey: 'cf',
          accountId: 'acct123',
          baseURL: freellm.PROVIDERS.cloudflare.baseURL,
        },
      }));
      const cand = { provider: 'cloudflare', model: '@cf/m', cfg: cfg.providers.cloudflare };
      const built = freellm.buildUpstream(cand, { messages: [{ role: 'user', content: 'hi' }] });
      assert.ok(/accounts\/acct123\/ai\/v1\/chat\/completions$/.test(built.url), built.url);
    });

    await t('candidates: unconfigured explicit provider fails fast with 400', () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      assert.throws(() => freellm.candidates(cfg, { mode: 'explicit', provider: 'nvidia', model: 'x' }), (e) => e.status === 400);
    });

    await t('candidates: skips disabled providers in auto order', () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      const list = freellm.candidates(cfg, { mode: 'auto' });
      assert.deepStrictEqual(list.map((c) => c.provider), ['groq', 'gemini']);
    });

    // ---- chat() ----------------------------------------------------------
    await t('chat() returns a completion from the first provider', async () => {
      hits.length = 0;
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      const res = await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'ok/chosen' });
      assert.strictEqual(res.provider, 'groq');
      assert.strictEqual(res.data.choices[0].message.content, 'PONG ok/chosen');
      assert.strictEqual(hits.length, 1);
      assert.strictEqual(hits[0].auth, 'Bearer GROQKEY');
    });

    await t('chat() falls back to the second provider on 429 with sanitised text', async () => {
      hits.length = 0;
      const cfg = freellm.normalizeConfig(cfgFor(up.url, {
        groq: { defaultModel: 'e429/a' },
        gemini: { defaultModel: 'ok/b' },
      }));
      const res = await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'auto' });
      assert.strictEqual(hits.length, 2);
      assert.strictEqual(res.provider, 'gemini');
      assert.strictEqual(res.attempts.length, 1);
      const first = res.attempts[0];
      assert.strictEqual(first.status, 429);
      assert.ok(!/[<>]/.test(first.error), first.error);
      assert.ok(/Rate limited/.test(first.error), first.error);
      // The successful body must not leak the failed provider's error page.
      assert.ok(!/Too many requests/.test(JSON.stringify(res.data)));
    });

    await t('chat() falls back on 500 and on a non-completion 200', async () => {
      for (const bad of ['e500/a', 'null/a']) {
        hits.length = 0;
        const cfg = freellm.normalizeConfig(cfgFor(up.url, {
          groq: { defaultModel: bad },
          gemini: { defaultModel: 'ok/b' },
        }));
        const res = await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'auto' });
        assert.strictEqual(res.provider, 'gemini', bad);
      }
    });

    await t('chat() honours provider order (`smart` puts nvidia first)', async () => {
      hits.length = 0;
      const cfg = freellm.normalizeConfig(cfgFor(up.url, {
        nvidia: { enabled: true, apiKey: 'NV' },
      }));
      const res = await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'smart' });
      assert.strictEqual(res.provider, 'nvidia');
      assert.strictEqual(hits.length, 1);
    });

    await t('chat() explicit provider does NOT fall back', async () => {
      hits.length = 0;
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      let err = null;
      try {
        await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'groq/e400/m' });
      } catch (e) { err = e; }
      assert.ok(err, 'expected a throw');
      assert.strictEqual(err.status, 400);
      assert.strictEqual(hits.length, 1);
      assert.ok(/bad parameter/.test(err.message), err.message);
    });

    await t('chat() reports every failure when all providers die', async () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url, {
        groq: { defaultModel: 'e500/a' },
        gemini: { defaultModel: 'e500/b' },
      }));
      let err = null;
      try { await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'auto' }); } catch (e) { err = e; }
      assert.ok(err);
      assert.strictEqual(err.status, 502);
      assert.ok(/groq/.test(err.message) && /gemini/.test(err.message), err.message);
      assert.ok(!/[<>]/.test(err.message));
    });

    await t('chat() with no configured provider is a 400 with guidance', async () => {
      const cfg = freellm.normalizeConfig({ providers: {} });
      let err = null;
      try { await freellm.chat(cfg, { messages: [{ role: 'user', content: 'hi' }], model: 'auto' }); } catch (e) { err = e; }
      assert.ok(err);
      assert.strictEqual(err.status, 400);
      assert.ok(/freellm\.json/.test(err.message), err.message);
    });

    // ---- listModels ------------------------------------------------------
    await t('listModels merges aliases, defaults and discovered ids', async () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      freellm._discoveryCache.clear();
      const models = await freellm.listModels(cfg, { timeoutMs: 3000 });
      const ids = models.map((m) => m.id);
      for (const must of ['auto', 'fast', 'smart', 'groq/ok/default-groq', 'groq/ok/model-a', 'gemini/ok/model-b']) {
        assert.ok(ids.includes(must), 'missing ' + must + ' in ' + ids.join(','));
      }
      // Disabled providers must not appear.
      assert.ok(!ids.some((id) => id.startsWith('nvidia/')), ids.join(','));
      // No duplicates.
      assert.strictEqual(new Set(ids).size, ids.length);
    });

    await t('listModels falls back to curated ids when discovery fails', async () => {
      const dead = await listen((req, res) => { res.writeHead(500); res.end('no'); });
      try {
        const cfg = freellm.normalizeConfig(cfgFor(dead.url));
        freellm._discoveryCache.clear();
        const models = await freellm.listModels(cfg, { timeoutMs: 1500 });
        const ids = models.map((m) => m.id);
        assert.ok(ids.includes('cloudflare/' + freellm.PROVIDERS.cloudflare.models[0]) === false, 'cloudflare is disabled');
        assert.ok(ids.some((id) => id.startsWith('groq/')), ids.join(','));
      } finally { await dead.close(); }
    });

    // ---- health ----------------------------------------------------------
    await t('health() reports configured/disabled providers without keys', async () => {
      const cfg = freellm.normalizeConfig(cfgFor(up.url));
      const h = freellm.health(cfg);
      assert.strictEqual(h.ok, true);
      assert.strictEqual(h.service, 'FreeLLMAPI');
      assert.deepStrictEqual(h.order, ['groq', 'gemini']);
      assert.strictEqual(h.providers.groq.configured, true);
      assert.strictEqual(h.providers.nvidia.configured, false);
      const blob = JSON.stringify(h);
      assert.ok(!/GROQKEY|GEMINIKEY/.test(blob), 'health leaked a key');
    });

    // ---- HTTP surface ----------------------------------------------------
    const cfg = freellm.normalizeConfig(cfgFor(up.url));
    const handle = await new Promise((resolve, reject) => {
      const { server } = freellm.createRouter(cfg, { timeoutMs: 5000 });
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        close: () => new Promise((d) => { try { server.closeAllConnections(); } catch (_) {} server.close(() => d()); }),
      }));
    });

    try {
      await t('GET /v1/models returns an OpenAI list', async () => {
        const r = await get(handle.port, '/v1/models');
        assert.strictEqual(r.status, 200);
        const data = JSON.parse(r.body);
        assert.strictEqual(data.object, 'list');
        assert.ok(Array.isArray(data.data) && data.data.length >= 3);
      });

      await t('GET /health returns the provider table', async () => {
        const r = await get(handle.port, '/health');
        assert.strictEqual(r.status, 200);
        const data = JSON.parse(r.body);
        assert.strictEqual(data.service, 'FreeLLMAPI');
        assert.ok(data.providers.groq);
        assert.ok(!/GROQKEY/.test(r.body));
      });

      await t('POST /v1/chat/completions returns a completion + provider headers', async () => {
        hits.length = 0;
        const r = await post(handle.port, '/v1/chat/completions', {
          model: 'auto',
          messages: [{ role: 'user', content: 'hi' }],
        });
        assert.strictEqual(r.status, 200, r.body);
        const data = JSON.parse(r.body);
        assert.ok(Array.isArray(data.choices));
        assert.strictEqual(r.headers['x-freellm-provider'], 'groq');
      });

      await t('POST /v1/chat/completions streams SSE through', async () => {
        const r = await post(handle.port, '/v1/chat/completions', {
          model: 'groq/stream/m',
          stream: true,
          messages: [{ role: 'user', content: 'hi' }],
        });
        assert.strictEqual(r.status, 200);
        assert.ok(/text\/event-stream/.test(r.headers['content-type']), r.headers['content-type']);
        assert.ok(/data: /.test(r.body));
        assert.ok(/PONG/.test(r.body) && /STREAM/.test(r.body), r.body);
        assert.strictEqual(r.headers['x-freellm-provider'], 'groq');
      });

      await t('POST stream falls back before the first byte', async () => {
        const cfg2 = freellm.normalizeConfig(cfgFor(up.url, {
          groq: { defaultModel: 'e429/a' },
          gemini: { defaultModel: 'ok/b' },
        }));
        const h2 = await new Promise((resolve) => {
          const { server } = freellm.createRouter(cfg2, { timeoutMs: 5000 });
          server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            close: () => new Promise((d) => { try { server.closeAllConnections(); } catch (_) {} server.close(() => d()); }),
          }));
        });
        try {
          const r = await post(h2.port, '/v1/chat/completions', {
            model: 'auto',
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
          });
          assert.strictEqual(r.status, 200);
          assert.strictEqual(r.headers['x-freellm-provider'], 'gemini');
          assert.ok(/PONG/.test(r.body), r.body);
        } finally { await h2.close(); }
      });

      await t('POST explicit-provider 429 returns a 429 without markup', async () => {
        const r = await post(handle.port, '/v1/chat/completions', {
          model: 'groq/e429/m', messages: [{ role: 'user', content: 'hi' }],
        });
        assert.strictEqual(r.status, 429);
        const msg = JSON.parse(r.body).error.message;
        assert.ok(!/[<>]/.test(msg), msg);
        assert.ok(/Rate limited/.test(msg), msg);
      });

      await t('POST bad JSON is a clean 400', async () => {
        const r = await new Promise((resolve, reject) => {
          const req = http.request({
            host: '127.0.0.1', port: handle.port, path: '/v1/chat/completions', method: 'POST',
            headers: { 'content-type': 'application/json' },
          }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
          req.on('error', reject);
          req.end('{not json');
        });
        assert.strictEqual(r.status, 400);
        assert.ok(/invalid JSON/.test(r.body), r.body);
      });

      await t('404 has a helpful message', async () => {
        const r = await get(handle.port, '/nope');
        assert.strictEqual(r.status, 404);
        assert.ok(/not found/.test(r.body));
      });

      await t('error responses never contain markup', async () => {
        const r = await post(handle.port, '/v1/chat/completions', {
          model: 'groq/e429/m', messages: [{ role: 'user', content: 'hi' }],
        });
        assert.strictEqual(r.status, 429);
        assert.ok(!/[<>]/.test(JSON.parse(r.body).error.message), r.body);
      });
    } finally {
      await handle.close();
    }

    // ---- token gate ------------------------------------------------------
    const authCfg = freellm.normalizeConfig({ ...cfgFor(up.url), token: 'sekrit' });
    const authHandle = await new Promise((resolve) => {
      const { server } = freellm.createRouter(authCfg, { timeoutMs: 5000 });
      server.listen(0, '127.0.0.1', () => resolve({
        port: server.address().port,
        close: () => new Promise((d) => { try { server.closeAllConnections(); } catch (_) {} server.close(() => d()); }),
      }));
    });
    try {
      await t('token config rejects unauthenticated chat but allows /health', async () => {
        const unauth = await post(authHandle.port, '/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
        assert.strictEqual(unauth.status, 401);
        const okRes = await post(authHandle.port, '/v1/chat/completions', { model: 'auto', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer sekrit' });
        assert.strictEqual(okRes.status, 200, okRes.body);
        const health = await get(authHandle.port, '/health');
        assert.strictEqual(health.status, 200);
      });
    } finally { await authHandle.close(); }

    // ---- real start() on an ephemeral port -------------------------------
    await t('start() listens on an ephemeral port and stops cleanly', async () => {
      const h = await freellm.start({ config: { ...cfgFor(up.url), port: 0 } });
      try {
        const r = await get(h.port, '/health');
        assert.strictEqual(r.status, 200);
        assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/v1$/.test(h.url), h.url);
      } finally { await h.stop(); }
    });

    await t('start() reports EADDRINUSE clearly', async () => {
      const h = await freellm.start({ config: { ...cfgFor(up.url), port: 0 } });
      let err = null;
      try {
        await freellm.start({ config: { ...cfgFor(up.url), port: h.port } });
      } catch (e) { err = e; }
      finally { await h.stop(); }
      assert.ok(err, 'expected a rejection');
      assert.ok(/already in use/.test(err.message), err.message);
    });

    // ---- config persistence ---------------------------------------------
    await t('saveConfig writes 0600 and round-trips through loadConfig', async () => {
      const os = require('os');
      const path = require('path');
      const fs = require('fs');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'freellm-'));
      const file = path.join(dir, 'freellm.json');
      try {
        freellm.saveConfig({ ...cfgFor(up.url), token: 't0k' }, file);
        const mode = fs.statSync(file).mode & 0o777;
        assert.strictEqual(mode, 0o600, 'mode ' + mode.toString(8));
        const back = freellm.loadConfig(file);
        assert.strictEqual(back.exists, true);
        assert.strictEqual(back.token, 't0k');
        assert.strictEqual(back.providers.groq.apiKey, 'GROQKEY');
      } finally {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      }
    });

    await t('loadConfig of a missing file still yields a usable default', () => {
      const cfg = freellm.loadConfig('/nonexistent/freellm.json');
      assert.strictEqual(cfg.exists, false);
      assert.strictEqual(cfg.configured, false);
      assert.strictEqual(cfg.port, 3001);
    });
  } finally {
    await up.close();
  }

  console.log('');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
