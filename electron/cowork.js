'use strict';
// Bot bridges + cloud cowork orchestration — local equivalents.
// Exposes a tiny HTTP webhook server so external bots (hearthbot, slackbot,
// teamsbot, webagent) can push tasks into AUTOBOT, and a cowork "orchestrator"
// registry that fans a goal out to multiple named workers (all running in this
// process via the provided runAgent). Mirrors mcp__cowork__* / mcp__ccd_* /
// bot-bridge server-side features locally.

const http = require('http');
const crypto = require('crypto');
const swarm = require('./swarm');

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
  const hasOverride = !!(opts.baseURL || opts.model || opts.apiKey || opts.oauthProvider || opts.transport);
  if (!hasOverride) return null;
  return {
    baseURL: opts.baseURL || (opts.provider && opts.provider.baseURL) || (opts.transport ? '' : 'http://localhost:11434/v1'),
    apiKey: opts.apiKey != null ? opts.apiKey : ((opts.provider && opts.provider.apiKey) || ''),
    model: opts.model || (opts.provider && opts.provider.model) || 'llama3.1',
    temperature: opts.temperature != null ? Number(opts.temperature) : (opts.provider ? opts.provider.temperature : 0.7),
    maxTokens: opts.maxTokens != null ? Number(opts.maxTokens) : (opts.provider ? opts.provider.maxTokens : 4096),
    supportsTools: opts.supportsTools !== false,
    oauthProvider: opts.oauthProvider || '',
    transport: opts.transport || '',
    oauth: !!opts.oauth || !!opts.oauthProvider,
    accessToken: opts.accessToken || '',
    contextWindow: Number(opts.contextWindow) || 0,
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
    tier: opts.tier || (opts.provider && opts.provider.tier) || prev.tier || null,
    systemPrompt: opts.systemPrompt || prev.systemPrompt || '',
    lastRun: 0,
  });
  return workers.get(name);
}

function unregisterWorker(name) {
  return workers.delete(String(name || ''));
}

function clearWorkers() {
  workers.clear();
}

function listWorkers() {
  return [...workers.values()].map((w) => ({
    name: w.name, status: w.status, goal: w.goal, lastRun: w.lastRun,
    model: w.model || null, baseURL: w.baseURL || null, tier: w.tier || null,
  }));
}

// Run one worker to completion, returning a result record (never throws).
// `prompt` overrides the shared goal so several workers can do DIFFERENT work
// in the same fan-out instead of all answering the same question.
async function runWorker(name, goal, opts) {
  const w = workers.get(name);
  if (!w) return { name, status: 'missing', result: 'no such worker' };
  if (!w.runAgent) return { name, status: 'unconfigured', result: 'worker has no agent runner' };
  const prompt = opts && opts.prompt ? String(opts.prompt) : goal;

  // Precedence: explicit per-call override > worker pin > call-wide fallback.
  // A partial override (e.g. only `model`) is layered on top of that base so the
  // caller does not have to restate baseURL/apiKey.
  const base = w.provider || opts.provider || null;
  const raw = (opts.overrides && opts.overrides[name]) || null;
  const provider = raw
    ? {
        baseURL: raw.baseURL !== undefined ? raw.baseURL : (base ? base.baseURL : undefined),
        apiKey: raw.apiKey != null ? raw.apiKey : (base ? base.apiKey : undefined),
        model: raw.model || (base && base.model) || undefined,
        temperature: raw.temperature != null ? raw.temperature : (base ? base.temperature : undefined),
        maxTokens: raw.maxTokens != null ? raw.maxTokens : (base ? base.maxTokens : undefined),
        supportsTools: raw.supportsTools !== false,
        oauthProvider: raw.oauthProvider !== undefined ? raw.oauthProvider : (base && base.oauthProvider) || '',
        transport: raw.transport !== undefined ? raw.transport : (base && base.transport) || '',
        oauth: raw.oauth !== undefined ? raw.oauth : Boolean(base && base.oauth),
        accessToken: raw.accessToken !== undefined ? raw.accessToken : (base && base.accessToken) || '',
        contextWindow: raw.contextWindow || (base && base.contextWindow) || 0,
      }
    : base;

  w.status = 'running';
  w.goal = goal || prompt;
  w.lastRun = Date.now();
  const started = Date.now();
  try {
    if (opts && opts.signal && opts.signal.aborted) throw new Error('aborted');
    const sys = raw && raw.systemPrompt ? raw.systemPrompt : w.systemPrompt;
    // When a per-call prompt is supplied it is the worker's whole job; keep the
    // shared goal as context so the worker knows what the team is building.
    const userContent = opts && opts.prompt && goal && goal !== prompt
      ? `TEAM GOAL (context):\n${goal}\n\nYOUR TASK:\n${prompt}`
      : prompt;
    const msgs = sys
      ? [{ role: 'system', content: sys }, { role: 'user', content: userContent }]
      : [{ role: 'user', content: userContent }];
    const out = await w.runAgent({
      provider,
      messages: msgs,
      maxSteps: opts.maxSteps || 0,
      emit: opts.emit,
      signal: opts && opts.signal,
      cwd: opts && opts.cwd,
    });
    const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
    w.status = 'idle';
    return {
      name,
      title: (opts && opts.title) || name,
      status: 'done',
      provider: provider ? { baseURL: provider.baseURL, model: provider.model } : null,
      tier: (raw && raw.tier) || w.tier || null,
      ms: Date.now() - started,
      result: last ? last.content : '(done)',
    };
  } catch (e) {
    w.status = 'error';
    return {
      name,
      title: (opts && opts.title) || name,
      status: 'error',
      provider: provider ? { baseURL: provider.baseURL, model: provider.model } : null,
      tier: (raw && raw.tier) || w.tier || null,
      ms: Date.now() - started,
      result: e.message,
    };
  }
}

// Fan work out to workers in parallel (bounded concurrency). Two modes:
//  - Distribute `opts.tasks` (distinct prompt per worker) — each agent does
//    different work, optionally on a different model/tier.
//  - Otherwise send one shared `goal` to every worker (classic fan-out).
// `workerNames` may be strings or `{ name, baseURL?, model?, apiKey?, tier? }`
// objects which register/override a worker for this call only.
async function orchestrate(goal, workerNames, opts = {}) {
  const overrides = { ...(opts.overrides || {}) };
  let entries;

  if (Array.isArray(opts.tasks) && opts.tasks.length) {
    // Distinct work per agent. A task may name a worker; otherwise the tasks
    // are spread across the registered workers in order.
    const pool = [...workers.keys()];
    entries = opts.tasks.map((t, i) => {
      const name = t.worker || t.name || pool[i % Math.max(pool.length, 1)] || `worker-${i + 1}`;
      const prompt = t.prompt || t.task || t.instructions || t.goal || goal || '';
      return {
        name,
        title: t.title || (prompt ? prompt.slice(0, 60) : name),
        prompt,
        tier: t.tier || null,
        model: t.model || null,
      };
    });
  } else {
    entries = (workerNames && workerNames.length ? workerNames : [...workers.keys()])
      .map((e) => (typeof e === 'string' ? { name: e } : (e && e.name ? e : null)))
      .filter(Boolean);
  }

  for (const [i, e] of (workerNames || []).entries()) {
    if (typeof e !== 'string' && e && e.name && (e.baseURL || e.model || e.apiKey || e.tier)) {
      overrides[e.name] = {
        baseURL: e.baseURL || undefined,
        model: e.model || undefined,
        apiKey: e.apiKey != null ? e.apiKey : undefined,
        tier: e.tier || undefined,
        supportsTools: e.supportsTools,
        systemPrompt: e.systemPrompt,
        _idx: i,
      };
    }
  }

  // A task-level model/tier override wins for that task's worker. A bare tier is
  // resolved against role pools (when active) or the flat model roster.
  const router = require('./orch-router');
  const poolOrch = opts.poolOrchestrator || opts.orchestrator;
  const poolsOn = router.poolsActive(poolOrch, opts.provider);
  const roster = (!poolsOn && Array.isArray(opts.tasks) && opts.tasks.some((t) => t.tier && !t.model))
    ? swarm.buildRoster({ orchestrator: opts.orchestrator, provider: opts.provider })
    : [];
  const taskOrchs = new Map();
  if (Array.isArray(opts.tasks)) {
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (poolsOn) {
        const role = router.tierToRole(e.tier) || 'coder';
        const scoped = router.orchestratorFor(poolOrch, role, opts.provider, { index: i, preferModel: e.model });
        if (scoped && scoped.providers && scoped.providers.length) {
          taskOrchs.set(e.name, scoped);
          const head = scoped.providers[0];
          overrides[e.name] = {
            ...(overrides[e.name] || {}),
            baseURL: head.baseURL,
            apiKey: head.apiKey,
            model: e.model || head.model,
            oauthProvider: head.oauthProvider || '',
            transport: head.transport || '',
            oauth: !!head.oauth,
            accessToken: head.accessToken || '',
            contextWindow: head.contextWindow || 0,
            ...(e.tier ? { tier: swarm.normalizeTier(e.tier) } : {}),
          };
          continue;
        }
      }
      if (e.model || e.tier) {
        const picked = (!e.model && e.tier) ? swarm.pickProvider(roster, e.tier) : null;
        overrides[e.name] = {
          ...(overrides[e.name] || {}),
          ...(e.model ? { model: e.model } : {}),
          ...(picked ? {
            baseURL: picked.baseURL, apiKey: picked.apiKey, model: picked.model,
            oauthProvider: picked.oauthProvider || '', transport: picked.transport || '',
            oauth: !!picked.oauth, accessToken: picked.accessToken || '', contextWindow: picked.contextWindow || 0,
          } : {}),
          ...(e.tier ? { tier: swarm.normalizeTier(e.tier) } : {}),
        };
      }
    }
  }

  // Refresh existing workers' runAgent so they never run with a stale turn's
  // emit/cwd/signal, and auto-provision any worker not registered yet.
  for (const e of entries) {
    const cur = workers.get(e.name);
    if (cur && typeof opts.runAgent === 'function') {
      cur.runAgent = opts.runAgent;
    } else if (!cur && typeof opts.runAgent === 'function') {
      registerWorker(e.name, {
        runAgent: opts.runAgent,
        provider: opts.provider,
        tier: e.tier || undefined,
        model: e.model || undefined,
        baseURL: (overrides[e.name] || {}).baseURL || undefined,
        apiKey: (overrides[e.name] || {}).apiKey,
        supportsTools: true,
      });
    }
  }

  const limit = Math.max(1, Math.min(Number(opts.concurrency) || 4, 8));
  const results = new Array(entries.length);
  let cursor = 0;

  const next = async () => {
    while (cursor < entries.length) {
      const i = cursor++;
      const e = entries[i];
      const scopedOrch = taskOrchs.get(e.name);
      results[i] = await runWorker(e.name, goal, {
        ...opts,
        ...(scopedOrch ? { orchestrator: scopedOrch } : {}),
        overrides,
        prompt: e.prompt,
        title: e.title,
      });
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
  registerWorker, unregisterWorker, clearWorkers, listWorkers, orchestrate,
  ccdSubmit, ccdList, ccdDrain,
};
