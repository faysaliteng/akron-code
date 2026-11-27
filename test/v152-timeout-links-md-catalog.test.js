'use strict';
const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const modelCatalog = require('../electron/model-catalog');
const providertransport = require('../electron/providertransport');

describe('v1.5.2 — Timeouts, Model Discovery/Replacement, Thinking Capabilities & Link/File Helpers', () => {
  const servers = [];
  const cleanups = [];

  afterEach(async () => {
    while (servers.length) {
      const s = servers.pop();
      await new Promise((r) => s.close(() => r()));
    }
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { fn(); } catch (_) {}
    }
    modelCatalog.clear('antigravity');
    modelCatalog.clear('claude');
  });

  it('distinguishes connection timeout from 429 rate limit, emits notice/status (never thinking), and caps n=1 timeout retries', async () => {
    const prevTimeout = process.env.HELIO_CONNECT_TIMEOUT_MS;
    const prevBackoff = process.env.HELIO_BACKOFF_MS;
    process.env.HELIO_CONNECT_TIMEOUT_MS = '90';
    process.env.HELIO_BACKOFF_MS = '25';
    cleanups.push(() => {
      if (prevTimeout === undefined) delete process.env.HELIO_CONNECT_TIMEOUT_MS;
      else process.env.HELIO_CONNECT_TIMEOUT_MS = prevTimeout;
      if (prevBackoff === undefined) delete process.env.HELIO_BACKOFF_MS;
      else process.env.HELIO_BACKOFF_MS = prevBackoff;
    });

    let hits = 0;
    const srv = http.createServer((_req, res) => {
      hits++;
      setTimeout(() => {
        try { if (!res.writableEnded) { res.writeHead(200); res.end('{}'); } } catch (_) {}
      }, 450);
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;

    const llm = require('../electron/llm');
    const events = [];
    await assert.rejects(
      () => llm.runAgent({
        provider: { baseURL, apiKey: 'test', model: 'gemini-4-carbon', supportsTools: false },
        messages: [{ role: 'user', content: 'hi' }],
        emit: (e) => events.push(e),
      }),
      /timed out/i
    );

    assert.equal(hits, 2, `n=1 pure timeout should retry at most once (2 total attempts), got ${hits}`);
    const thinkLines = events.filter((e) => e.type === 'thinking').map((e) => e.text).join('\n');
    const retryText = events.filter((e) => e.type === 'notice' || e.type === 'status').map((e) => e.text).join('\n');
    assert.ok(!/waiting .* before retrying/i.test(thinkLines), `Thinking must not contain retry waits: ${thinkLines}`);
    assert.ok(!/rate limited/i.test(retryText), `Connection timeout must NOT be labeled rate limited: ${retryText}`);
    assert.ok(/provider connection timed out/i.test(retryText), `Expected timeout retry status/notice: ${retryText}`);
  });

  it('groups Antigravity discrete thinking variants, detects thinking capabilities, and auto-replaces retired models', async () => {
    const mockJson = {
      models: {
        'gemini-4-carbon-low': { displayName: 'Gemini 4 Carbon (Low)', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576, supportsThinking: true },
        'gemini-4-carbon-medium': { displayName: 'Gemini 4 Carbon (Medium)', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576, supportsThinking: true },
        'gemini-4-carbon-high': { displayName: 'Gemini 4 Carbon (High)', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576, supportsThinking: true, recommended: true },
        'gemini-4-neon-xhigh': { displayName: 'Gemini 4 Neon (XHigh)', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576, supportsThinking: true },
        'claude-opus-5-5': { displayName: 'Claude Opus 5.5', apiProvider: 'API_PROVIDER_ANTHROPIC_VERTEX', maxTokens: 1000000, supportsThinking: true },
        'gpt-4o-mini': { apiProvider: 'API_PROVIDER_OPENAI', maxTokens: 128000, supportsThinking: false },
        'tab_completion_preview': { apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 16384 },
      },
    };
    const parsed = providertransport._internal.googleModelList(mockJson);
    const carbonMed = parsed.find((m) => m.id === 'gemini-4-carbon-medium');
    assert.ok(carbonMed, 'gemini-4-carbon-medium included');
    assert.ok(carbonMed.thinkingVariants && carbonMed.thinkingVariants.high === 'gemini-4-carbon-high');
    assert.deepEqual(carbonMed.thinkingLevels, ['auto', 'low', 'medium', 'high']);

    modelCatalog.register('antigravity', parsed);
    assert.equal(modelCatalog.isModelAvailable('antigravity', 'gemini-4-carbon-medium'), true);
    assert.equal(modelCatalog.isModelAvailable('antigravity', 'gemini-4-carbon-ultra'), false);

    // If gemini-4-carbon-medium is removed upstream later:
    const withoutMed = parsed.filter((m) => m.id !== 'gemini-4-carbon-medium');
    modelCatalog.register('antigravity', withoutMed);
    const repl = modelCatalog.resolveReplacementModel('antigravity', 'gemini-4-carbon-medium');
    assert.equal(repl && repl.id, 'gemini-4-carbon-high', 'retired discrete tier upgrades to closest live sibling');

    // Thinking capabilities per model
    const gptMiniCaps = modelCatalog.thinkingCapabilitiesFor('gpt-4o-mini', 'antigravity');
    assert.equal(gptMiniCaps.supported, false);
    assert.deepEqual(gptMiniCaps.levels, []);
    const opusCaps = modelCatalog.thinkingCapabilitiesFor('claude-opus-5-5', 'claude');
    assert.equal(opusCaps.supported, true);
    assert.ok(opusCaps.levels.includes('xhigh'));
  });

  it('auto-recovers mid-turn when a subscription model returns 404 model_not_found by refreshing live catalog', async () => {
    const srv = http.createServer((req, res) => {
      if (req.url && req.url.endsWith(':fetchAvailableModels')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          models: {
            'gemini-4-carbon-high': { displayName: 'Gemini 4 Carbon (High)', apiProvider: 'API_PROVIDER_GOOGLE', maxTokens: 1048576, supportsThinking: true, recommended: true },
          },
        }));
        return;
      }
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        if (body.model === 'gemini-4-carbon-retired') {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `Model '${body.model}' not found` } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ response: { candidates: [{ content: { parts: [{ text: 'Recovered on live sibling.' }] }, finishReason: 'STOP' }], modelVersion: 'gemini-4-carbon-high' } }) + '\n\n');
        res.end();
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    servers.push(srv);
    const cloudcodeUrl = `http://127.0.0.1:${srv.address().port}/v1internal`;

    const llm = require('../electron/llm');
    const events = [];
    const out = await llm.runAgent({
      provider: {
        oauthProvider: 'antigravity:test',
        transport: 'google',
        accessToken: 'tok-test',
        cloudcodeUrl,
        model: 'gemini-4-carbon-retired',
        supportsTools: false,
      },
      messages: [{ role: 'user', content: 'hello' }],
      emit: (e) => events.push(e),
    });
    const last = [...out].reverse().find((m) => m.role === 'assistant');
    assert.ok(last && /Recovered on live sibling/.test(last.content), JSON.stringify(last));
    assert.ok(events.some((e) => e.type === 'orchestrator' && e.to === 'gemini-4-carbon-high'), 'emitted orchestrator fallback event');
  });

  it('parses clickable workspace file tokens, linkifies bare domains safely, and fixes browser-bot-v2 + computer JXA paths', async () => {
    const helpers = await import('../src/utils/linkAndFileHelpers.js');
    assert.deepEqual(helpers.parseFileToken('lovable-events-free-credits-report.md'), { path: 'lovable-events-free-credits-report.md', line: null });
    assert.deepEqual(helpers.parseFileToken('src/App.jsx:42'), { path: 'src/App.jsx', line: 42 });
    assert.equal(helpers.parseFileToken('https://community.lovable.app/events'), null);
    assert.equal(helpers.parseFileToken('--verbose'), null);

    const mdIn = 'RSVP at community.lovable.app/events (or luma.com/lovable), see `src/App.jsx` and `lovable-events-free-credits-report.md`.';
    const mdOut = helpers.linkifyBareDomains(mdIn);
    assert.ok(mdOut.includes('[community.lovable.app/events](https://community.lovable.app/events)'), mdOut);
    assert.ok(mdOut.includes('[luma.com/lovable](https://luma.com/lovable)'), mdOut);
    assert.ok(mdOut.includes('`src/App.jsx`'), 'file extensions inside backticks untouched');

    // Verify browser-executors resolves ../browser-bot-v2 without MODULE_NOT_FOUND
    const execSrc = fs.readFileSync(path.join(__dirname, '../electron/tools/browser-executors.js'), 'utf8');
    assert.ok(!execSrc.includes("require('./browser-bot-v2')"), 'must use ../browser-bot-v2');
    assert.ok(fs.existsSync(path.join(__dirname, '../electron/browser-bot-v2.js')));

    // Verify computer.js JXA guards against e.isNil and {} non-iterable
    const compSrc = fs.readFileSync(path.join(__dirname, '../electron/computer.js'), 'utf8');
    assert.ok(compSrc.includes("typeof e.isNil !== 'function' || !e.isNil()"), 'isNil function guard present');
    assert.ok(compSrc.includes('ObjC.castRefToObject(cf)') || compSrc.includes('Array.isArray(raw) ? raw : []'), 'CGWindowList CFArray conversion guard present');
  });
});
