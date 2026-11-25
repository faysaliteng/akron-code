'use strict';
// Bot bridges + cloud cowork orchestration — local equivalents.
// Exposes a tiny HTTP webhook server so external bots (hearthbot, slackbot,
// teamsbot, webagent) can push tasks into AUTOBOT, and a cowork "orchestrator"
// registry that fans a goal out to multiple named workers (all running in this
// process via the provided runAgent). Mirrors mcp__cowork__* / mcp__ccd_* /
// bot-bridge server-side features locally.

const http = require('http');
const crypto = require('crypto');

// ---- bot bridge webhook server ----
let bridgeServer = null;
let bridgePort = 0;
const bridgeHandlers = []; // { route, handler }

function startBridge(port = 0) {
  if (bridgeServer) return { port: bridgePort, alreadyRunning: true };
  bridgeServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed = null;
      try { parsed = body ? JSON.parse(body) : {}; } catch (_) { parsed = { raw: body }; }
      // match a handler by route (method + pathname)
      for (const h of bridgeHandlers) {
        if (h.method === req.method && h.route === url.pathname) {
          try {
            const out = await h.handler({ body: parsed, query: Object.fromEntries(url.searchParams), headers: req.headers });
            res.writeHead(200, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, ...(out || {}) }));
          } catch (e) {
            res.writeHead(500, { 'content-type': 'application/json' });
            return res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        }
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no bridge route matched' }));
    });
  });
  return new Promise((resolve) => {
    bridgeServer.listen(port, '127.0.0.1', () => {
      bridgePort = bridgeServer.address().port;
      resolve({ port: bridgePort, url: `http://127.0.0.1:${bridgePort}` });
    });
  });
}

function registerBridge(route, method, handler) {
  bridgeHandlers.push({ route, method: (method || 'POST').toUpperCase(), handler });
}

function stopBridge() {
  if (bridgeServer) { try { bridgeServer.close(); } catch (_) {} bridgeServer = null; bridgePort = 0; bridgeHandlers.length = 0; }
}

// ---- cowork orchestrator registry ----
// name -> { name, status, goal, lastRun, runAgent, provider, model, baseURL, systemPrompt }
const workers = new Map();

// A worker may be pinned to its own model endpoint (baseURL + model + apiKey +
// supportsTools). Anything omitted falls back to the orchestrating provider, so
// a single goal can fan out to different backends (e.g. NVIDIA NIM + a local
// Ollama Gemma model) in one call.
function workerProvider(opts = {}) {
  const hasOverride = !!(opts.baseURL || opts.model || opts.apiKey);
  if (!hasOverride) return null;
  return {
    baseURL: opts.baseURL || (opts.provider && opts.provider.baseURL) || 'http://localhost:11434/v1',
    apiKey: opts.apiKey != null ? opts.apiKey : ((opts.provider && opts.provider.apiKey) || ''),
    model: opts.model || (opts.provider && opts.provider.model) || 'llama3.1',
    temperature: opts.temperature != null ? Number(opts.temperature) : (opts.provider ? opts.provider.temperature : 0.7),
    maxTokens: opts.maxTokens != null ? Number(opts.maxTokens) : (opts.provider ? opts.provider.maxTokens : 4096),
    supportsTools: opts.supportsTools !== false,
  };
}

function registerWorker(name, opts = {}) {
  const pinned = workerProvider(opts);
  const prev = workers.get(name) || {};
  workers.set(name, {
    name,
    status: 'idle',
    goal: opts.goal || prev.goal || '',
    runAgent: opts.runAgent || prev.runAgent || null,
    provider: pinned || opts.provider || prev.provider || null,
    model: (pinned && pinned.model) || (opts.provider && opts.provider.model) || (prev.model || null),
    baseURL: (pinned && pinned.baseURL) || (opts.provider && opts.provider.baseURL) || (prev.baseURL || null),
    systemPrompt: opts.systemPrompt || prev.systemPrompt || '',
    lastRun: 0,
  });
  return workers.get(name);
}

function listWorkers() {
  return [...workers.values()].map((w) => ({
    name: w.name, status: w.status, goal: w.goal, lastRun: w.lastRun,
    model: w.model || null, baseURL: w.baseURL || null,
  }));
}

// Run one worker to completion, returning a result record (never throws).
async function runWorker(name, goal, opts) {
  const w = workers.get(name);
  if (!w) return { name, status: 'missing', result: 'no such worker' };
  if (!w.runAgent) return { name, status: 'unconfigured', result: 'worker has no agent runner' };

  // Precedence: explicit per-call override > worker pin > call-wide fallback.
  // A partial override (e.g. only `model`) is layered on top of that base so the
  // caller does not have to restate baseURL/apiKey.
  const base = w.provider || opts.provider || null;
  const raw = (opts.overrides && opts.overrides[name]) || null;
  const provider = raw
    ? {
        baseURL: raw.baseURL || (base && base.baseURL) || undefined,
        apiKey: raw.apiKey != null ? raw.apiKey : (base ? base.apiKey : undefined),
        model: raw.model || (base && base.model) || undefined,
        temperature: raw.temperature != null ? raw.temperature : (base ? base.temperature : undefined),
        maxTokens: raw.maxTokens != null ? raw.maxTokens : (base ? base.maxTokens : undefined),
        supportsTools: raw.supportsTools !== false,
      }
    : base;

  w.status = 'running';
  w.goal = goal;
  w.lastRun = Date.now();
  const started = Date.now();
  try {
    const sys = raw && raw.systemPrompt ? raw.systemPrompt : w.systemPrompt;
    const msgs = sys
      ? [{ role: 'system', content: sys }, { role: 'user', content: goal }]
      : [{ role: 'user', content: goal }];
    const out = await w.runAgent({ provider, messages: msgs, maxSteps: opts.maxSteps || 0, emit: opts.emit });
    const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
    w.status = 'idle';
    return {
      name,
      status: 'done',
      provider: provider ? { baseURL: provider.baseURL, model: provider.model } : null,
      ms: Date.now() - started,
      result: last ? last.content : '(done)',
    };
  } catch (e) {
    w.status = 'error';
    return {
      name,
      status: 'error',
      provider: provider ? { baseURL: provider.baseURL, model: provider.model } : null,
      ms: Date.now() - started,
      result: e.message,
    };
  }
}

// Fan a goal out to workers in parallel (bounded concurrency). `workerNames` may
// be strings or `{ name, baseURL?, model?, apiKey?, supportsTools? }` objects
// which register/override a worker for this call only.
async function orchestrate(goal, workerNames, opts = {}) {
  const entries = (workerNames && workerNames.length ? workerNames : [...workers.keys()])
    .map((e) => (typeof e === 'string' ? { name: e } : (e && e.name ? e : null)))
    .filter(Boolean);

  const overrides = { ...(opts.overrides || {}) };
  for (const [i, e] of (workerNames || []).entries()) {
    if (typeof e !== 'string' && e && e.name && (e.baseURL || e.model || e.apiKey)) {
      overrides[e.name] = {
        baseURL: e.baseURL || undefined,
        model: e.model || undefined,
        apiKey: e.apiKey != null ? e.apiKey : undefined,
        supportsTools: e.supportsTools,
        systemPrompt: e.systemPrompt,
        _idx: i,
      };
    }
  }

  const limit = Math.max(1, Number(opts.concurrency) || 4);
  const results = new Array(entries.length);
  let cursor = 0;

  const next = async () => {
    while (cursor < entries.length) {
      const i = cursor++;
      results[i] = await runWorker(entries[i].name, goal, { ...opts, overrides });
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, entries.length || 1) }, next));
  return results.filter(Boolean);
}

// CCD (cloud cowork daemon) task submission — a local queue the bridge can fill.
const ccdQueue = [];
function ccdSubmit(task) {
  const id = crypto.randomBytes(6).toString('hex');
  const entry = { id, task: String(task || ''), status: 'queued', ts: Date.now() };
  ccdQueue.push(entry);
  if (ccdQueue.length > 200) ccdQueue.shift();
  return entry;
}
function ccdList() { return [...ccdQueue]; }
function ccdDrain() { const r = [...ccdQueue]; ccdQueue.length = 0; return r; }

module.exports = {
  startBridge, registerBridge, stopBridge, bridgePort: () => bridgePort,
  registerWorker, listWorkers, orchestrate,
  ccdSubmit, ccdList, ccdDrain,
};
