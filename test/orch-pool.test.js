'use strict';
// The orchestrator pool used to trust its rows. A stale one — pointing at Ollama
// on 11434 with `claude-fable-5-2` as the model id — produced exactly
//
//   model 'claude-fable-5-2' not found
//
// at turn time, which reads like a dead Claude subscription. The gateway was
// asked a question it could not answer, and the app never checked. Now every
// anonymous row is checked against its own gateway once, and dropped only when
// that gateway answers with a catalogue that does not contain it.

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   - ' + name); }
  else { fail++; process.exitCode = 1; console.log('  FAIL - ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')); }
};
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b });

const { pruneUnserved, servedModels, parseIds, candidateURLs } = require('../electron/orch-pool');

// A fetch stand-in that answers per URL from a table and records the calls.
function fakeFetch(table) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const entry = table[url];
    if (!entry) return { ok: false, status: 404, text: async () => 'not found' };
    if (entry.throws) throw new Error(entry.throws);
    return { ok: entry.status ? entry.status < 400 : true, status: entry.status || 200, text: async () => entry.body };
  };
  impl.calls = calls;
  return impl;
}

(async () => {
  console.log('\norchestrator pool validation');

  // ---- The live failure, replayed -----------------------------------------
  {
    const fetchImpl = fakeFetch({
      'http://localhost:11434/v1/models': { body: JSON.stringify({ object: 'list', data: [{ id: 'gemma4:latest' }] }) },
    });
    const r = await pruneUnserved([
      { id: 'pmwwlyh4x', name: 'Provider 1', baseURL: 'http://localhost:11434/v1', apiKey: '', model: 'claude-fable-5-2' },
    ], { fetchImpl });
    eq('a model its own gateway does not serve is dropped', r.dropped.length, 1);
    eq('and nothing is kept', r.providers.length, 0);
    ok('the reason names the URL and the count', /localhost:11434\/v1\/models serves 1 model and claude-fable-5-2 is not one of them/.test(r.dropped[0].why), r.dropped[0].why);
    eq('the dropped row carries its original index', r.dropped[0].index, 0);
  }

  // ---- A row the gateway really serves survives ---------------------------
  {
    const fetchImpl = fakeFetch({
      'http://localhost:11434/v1/models': { body: JSON.stringify({ data: [{ id: 'gemma4:latest' }, { id: 'llama4:8b' }] }) },
    });
    const rows = [{ baseURL: 'http://localhost:11434/v1/', model: 'LLama4:8B' }];
    const r = await pruneUnserved(rows, { fetchImpl });
    eq('a served model is kept (trailing slash + case are not a mismatch)', r.providers.length, 1);
    eq('and is reported as checked', r.checked, 1);
    eq('the dropped row is only reported once', r.dropped.length, 0);
  }

  // ---- We never invent a failure ----------------------------------------
  {
    const fetchImpl = fakeFetch({
      'http://localhost:11434/v1/models': { status: 401, body: '{"error":"unauthorized"}' },
    });
    const r = await pruneUnserved([{ baseURL: 'http://localhost:11434/v1', model: 'anything' }], { fetchImpl });
    eq('a 401 keeps the row', r.providers.length, 1);
    eq('and marks it unverified instead of broken', r.unverified.length, 1);
    ok('the unverified reason quotes the status', /HTTP 401/.test(r.unverified[0].why), r.unverified[0].why);
  }
  {
    const fetchImpl = async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:11434'); };
    const r = await pruneUnserved([{ baseURL: 'http://127.0.0.1:11434/v1', model: 'x' }], { fetchImpl });
    eq('an unreachable gateway keeps its row', r.providers.length, 1);
    ok('the reason is the transport error', /ECONNREFUSED/.test(r.unverified[0].why), r.unverified[0].why);
  }
  {
    const fetchImpl = fakeFetch({ 'http://localhost:3001/v1/models': { body: '{"object":"list","data":[]}' } });
    const r = await pruneUnserved([{ baseURL: 'http://localhost:3001/v1', model: 'auto' }], { fetchImpl });
    eq('an empty catalogue (a router with no keys) drops nothing', r.providers.length, 1);
    eq('and is not counted as checked', r.checked, 0);
  }
  {
    const fetchImpl = fakeFetch({ 'http://localhost:3001/v1/models': { body: '<html>login</html>' } });
    const r = await pruneUnserved([{ baseURL: 'http://localhost:3001/v1', model: 'auto' }], { fetchImpl });
    eq('an unparseable body drops nothing', r.providers.length, 1);
  }

  // ---- Rows with no anonymous endpoint are out of scope ------------------
  {
    const fetchImpl = fakeFetch({});
    const r = await pruneUnserved([
      { id: 'oauth|claude|me|claude-fable-5-2', oauthProvider: 'claude:me', model: 'claude-fable-5-2', baseURL: '' },
      { id: 'gw|http://localhost:11434/v1|gemma4:latest', baseURL: 'http://localhost:11434/v1', model: 'gemma4:latest' },
      { baseURL: '', model: 'x' },
      null,
    ], { fetchImpl });
    eq('subscription rows are never probed', fetchImpl.calls.length, 1);
    eq('only the anonymous row with an endpoint was asked', fetchImpl.calls[0], 'http://localhost:11434/v1/models');
    eq('every row is kept when the gateway cannot be asked', r.providers.length, 4);
  }

  // ---- URL candidates ----------------------------------------------------
  eq('a versioned base is asked directly', candidateURLs('https://api.groq.com/openai/v1'), ['https://api.groq.com/openai/v1/models']);
  eq('a bare host tries /v1 as well', candidateURLs('http://localhost:11434'), ['http://localhost:11434/models', 'http://localhost:11434/v1/models']);
  eq('trailing slashes are stripped', candidateURLs('http://localhost:11434/v1///'), ['http://localhost:11434/v1/models']);
  eq('an empty base asks nothing', candidateURLs(''), []);

  // A bare host that only mounts the OpenAI surface under /v1 is still checked.
  {
    const fetchImpl = fakeFetch({
      'http://box:8080/models': { status: 404, body: 'nope' },
      'http://box:8080/v1/models': { body: JSON.stringify({ data: [{ id: 'qwen3' }] }) },
    });
    const r = await pruneUnserved([{ baseURL: 'http://box:8080', model: 'qwen3' }], { fetchImpl });
    eq('the second candidate settles it', r.providers.length, 1);
    eq('both candidates were tried', fetchImpl.calls.length, 2);
  }

  // ---- Parsing shapes ----------------------------------------------------
  eq('{"data":[{"id"}]}', [...parseIds('{"data":[{"id":"a"}]}')], ['a']);
  eq('{"models":[{"name"}]} (Ollama /api/tags)', [...parseIds('{"models":[{"name":"gemma4:latest"}]}')], ['gemma4:latest']);
  eq('a bare array', [...parseIds('["a","b"]')], ['a', 'b']);
  eq('an empty list is no evidence', parseIds('{"data":[]}'), null);
  eq('unparseable is no evidence', parseIds('<html>'), null);

  // ---- A real timeout does not hang the run -----------------------------
  {
    const slow = (url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
    const t0 = Date.now();
    const r = await servedModels({ baseURL: 'http://localhost:11434/v1', model: 'x' }, { fetchImpl: slow, timeoutMs: 60 });
    const ms = Date.now() - t0;
    eq('a silent gateway yields no verdict', r.ok, false);
    ok('and is cut off at the deadline', ms < 1500, ms);
    const pr = await pruneUnserved([{ baseURL: 'http://localhost:11434/v1', model: 'x' }], { fetchImpl: slow, timeoutMs: 60 });
    eq('the row survives a silent gateway', pr.providers.length, 1);
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
})();
