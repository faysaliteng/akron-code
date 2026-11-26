'use strict';
// Desktop <-> Browser Extension bridge (Akron Browser Bot) on 127.0.0.1:8766.
//
// Two surfaces share the same local listener:
//   1. HTTP OpenAI-compatible proxy (`http://127.0.0.1:8766/v1/*`) so Akron
//      Browser Bot automatically shares ALL configured Akron Bot Desktop models
//      and pools with ZERO separate API keys required.
//   2. WebSocket bridge (`ws://127.0.0.1:8766`) so Akron Bot Desktop agents
//      can control the user's live Chrome/Brave/Edge tabs via `ext_browser`.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const orchRouter = require('./orch-router');

const DEFAULT_PORT = 8766;
const ALIAS_ROLES = ['planner', 'coder', 'vision', 'fast', 'longctx'];

let state = {
  server: null,
  wss: null,
  port: DEFAULT_PORT,
  running: false,
  getProvider: null,
  getOrchestrator: null,
  clients: new Set(),
  activeSocket: null,
  extensionVersion: null,
  lastTabs: [],
  pending: new Map(), // request_id -> { resolve, reject, timer }
};

function extensionDir() {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, 'akron-browser-bot') : null,
    path.join(__dirname, '..', 'resources', 'akron-browser-bot'),
  ].filter(Boolean);
  for (const d of candidates) {
    if (fs.existsSync(d)) return d;
  }
  return candidates[candidates.length - 1];
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 25 * 1024 * 1024) {
        reject(new Error('Request body too large'));
        try { req.destroy(); } catch (_) {}
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('Invalid JSON: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

async function gatherModels() {
  const base = state.getProvider ? await Promise.resolve(state.getProvider()).catch(() => null) : null;
  const orch = state.getOrchestrator ? await Promise.resolve(state.getOrchestrator()).catch(() => null) : null;
  const ids = new Set(['akron-default']);
  for (const r of ALIAS_ROLES) ids.add('akron-' + r);
  if (base && base.model) ids.add(String(base.model));
  if (orch && Array.isArray(orch.providers)) {
    for (const p of orch.providers) if (p && p.model && p.enabled !== false) ids.add(String(p.model));
  }
  const poolsCfg = orch && orchRouter.poolsConfig(orch);
  if (poolsCfg && poolsCfg.roles) {
    for (const r of ALIAS_ROLES) {
      const rows = (poolsCfg.roles[r] && poolsCfg.roles[r].models) || [];
      for (const row of rows) {
        const m = typeof row === 'string' ? row.split('@')[0].trim() : row && row.model;
        if (m) ids.add(String(m));
      }
    }
  }
  const now = Math.floor(Date.now() / 1000);
  return [...ids].map((id) => ({
    id,
    object: 'model',
    created: now,
    owned_by: id.startsWith('akron-') ? 'akron-desktop' : 'akron-pool',
  }));
}

async function resolveCandidateList(requestedModel) {
  const llm = require('./llm');
  const rawBase = state.getProvider ? await Promise.resolve(state.getProvider()).catch(() => null) : null;
  const orch = state.getOrchestrator ? await Promise.resolve(state.getOrchestrator()).catch(() => null) : null;
  const base = rawBase ? llm.normalizeProvider(rawBase) : null;
  const poolsActive = orch && orchRouter.poolsActive(orch, base);
  const reqModel = String(requestedModel || '').trim();

  let list = [];
  if (reqModel.startsWith('akron-') && ALIAS_ROLES.includes(reqModel.slice(6))) {
    const role = reqModel.slice(6);
    if (orch && orchRouter.poolsConfig(orch)) {
      const scoped = orchRouter.orchestratorFor(orch, role, base);
      if (scoped && Array.isArray(scoped.providers)) list = scoped.providers.map((p) => llm.normalizeProvider(p));
    }
    if (!list.length && base) list = [base];
    return list;
  }

  if (!reqModel || reqModel === 'akron-default') {
    if (base && base.model) list.push(base);
    if (orch && Array.isArray(orch.providers)) {
      for (const p of orch.providers) {
        if (p && p.enabled !== false && p.model) list.push(llm.normalizeProvider(p));
      }
    }
    if (poolsActive) {
      const scoped = orchRouter.orchestratorFor(orch, 'coder', base);
      if (scoped && Array.isArray(scoped.providers)) {
        for (const p of scoped.providers) list.push(llm.normalizeProvider(p));
      }
    }
  } else {
    // Explicit model ID requested
    let matched = null;
    if (base && base.model === reqModel) matched = base;
    if (!matched && orch && Array.isArray(orch.providers)) {
      const found = orch.providers.find((p) => p && p.model === reqModel);
      if (found) matched = llm.normalizeProvider(found);
    }
    if (!matched && orch && orchRouter.poolsConfig(orch)) {
      for (const r of ALIAS_ROLES) {
        const scoped = orchRouter.orchestratorFor(orch, r, base, { preferModel: reqModel });
        if (scoped && Array.isArray(scoped.providers)) {
          const hit = scoped.providers.find((p) => p && p.model === reqModel);
          if (hit) { matched = llm.normalizeProvider(hit); break; }
        }
      }
    }
    if (!matched && base) matched = llm.normalizeProvider({ ...base, model: reqModel });
    if (matched) list.push(matched);
    if (orch && Array.isArray(orch.providers)) {
      for (const p of orch.providers) {
        if (p && p.enabled !== false && p.model && p.model !== reqModel) list.push(llm.normalizeProvider(p));
      }
    }
    if (base && base.model && base.model !== reqModel) list.push(base);
  }

  // Deduplicate by (baseURL|oauthProvider|model) preserving order
  const seen = new Set();
  const dedup = [];
  for (const row of list) {
    if (!row || !row.model) continue;
    const key = `${row.oauthProvider || row.baseURL || ''}|${row.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedup.push(row);
  }
  return dedup;
}

async function handleChatCompletions(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: { message: e.message } }); }

  const list = await resolveCandidateList(body.model);
  if (!list.length) {
    return sendJson(res, 503, { error: { message: 'No model provider is configured in Akron Bot Desktop.' } });
  }

  const llm = require('./llm');
  const ac = new AbortController();
  req.on('close', () => { if (!res.writableEnded) ac.abort(); });

  const wantStream = body.stream === true;
  const id = 'chatcmpl-akron-' + Date.now().toString(36);
  const created = Math.floor(Date.now() / 1000);
  const streamModel = String(body.model || (list[0] && list[0].model) || 'akron-default');
  let sseStarted = false;

  const ensureSse = () => {
    if (sseStarted || res.writableEnded) return;
    sseStarted = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    });
  };

  try {
    let idx = 0;
    const out = await llm.chatWithFailover({
      list,
      getIndex: () => idx,
      setIndex: (i) => { idx = i; },
      messages: Array.isArray(body.messages) ? body.messages : [],
      tools: Array.isArray(body.tools) && body.tools.length ? body.tools : undefined,
      maxTokens: body.max_tokens || body.maxTokens,
      signal: ac.signal,
      onDelta: (delta) => {
        if (!wantStream || !delta || res.writableEnded) return;
        ensureSse();
        const chunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: streamModel,
          choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
      emit: () => {},
    });

    const servedModel = (out && out.servedBy) || streamModel;
    const tcs = (out && Array.isArray(out.tool_calls) && out.tool_calls.length) ? out.tool_calls : null;
    const finish = (out && out.finish_reason) || (tcs ? 'tool_calls' : 'stop');

    if (wantStream) {
      ensureSse();
      if (tcs) {
        const tcChunk = {
          id,
          object: 'chat.completion.chunk',
          created,
          model: servedModel,
          choices: [{ index: 0, delta: { tool_calls: tcs.map((tc, i) => ({ ...tc, index: tc.index != null ? tc.index : i })) }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(tcChunk)}\n\n`);
      }
      const endChunk = {
        id,
        object: 'chat.completion.chunk',
        created,
        model: servedModel,
        choices: [{ index: 0, delta: {}, finish_reason: finish }],
        ...(out && out.usage ? { usage: out.usage } : {}),
      };
      res.write(`data: ${JSON.stringify(endChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const msg = {
      role: 'assistant',
      content: (out && out.content) || '',
      ...(tcs ? { tool_calls: tcs } : {}),
    };
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model: servedModel,
      choices: [{ index: 0, message: msg, finish_reason: finish }],
      ...(out && out.usage ? { usage: out.usage } : {}),
    });
  } catch (e) {
    if (ac.signal.aborted) return;
    if (sseStarted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sendJson(res, Number(e && e.status) || 502, { error: { message: String((e && e.message) || e) } });
  }
}

function sendExtensionRequest(payload, timeoutMs = 20000) {
  const sock = state.activeSocket;
  if (!sock || sock.readyState !== 1) {
    return Promise.reject(new Error('Akron Browser Bot extension is not connected on ws://127.0.0.1:' + state.port + '. Load resources/akron-browser-bot in Chrome (chrome://extensions → Developer mode → Load unpacked).'));
  }
  const reqId = 'ext_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(reqId);
      reject(new Error('Timed out waiting for Akron Browser Bot extension response'));
    }, timeoutMs);
    if (timer.unref) timer.unref();
    state.pending.set(reqId, { resolve, reject, timer });
    try {
      sock.send(JSON.stringify({ ...payload, request_id: reqId }));
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(reqId);
      reject(e);
    }
  });
}

function attachSocket(ws) {
  state.clients.add(ws);
  state.activeSocket = ws;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw || '')); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ping') {
      try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) {}
      return;
    }
    if (msg.type === 'ext_hello') {
      state.extensionVersion = msg.version || state.extensionVersion || '1.6.7';
      return;
    }
    if (msg.request_id && state.pending.has(msg.request_id)) {
      const p = state.pending.get(msg.request_id);
      state.pending.delete(msg.request_id);
      clearTimeout(p.timer);
      if (msg.type === 'error' || msg.ok === false) {
        p.reject(new Error(msg.error || msg.message || 'Extension error'));
      } else {
        p.resolve(msg);
      }
    }
  });
  ws.on('close', () => {
    state.clients.delete(ws);
    if (state.activeSocket === ws) {
      state.activeSocket = [...state.clients].pop() || null;
      if (!state.activeSocket) state.lastTabs = [];
    }
  });
  ws.on('error', () => {});
}

async function listTabs() {
  if (!state.activeSocket || state.activeSocket.readyState !== 1) return [];
  const res = await sendExtensionRequest({ type: 'ext_status' }, 6000);
  if (Array.isArray(res.tabs)) state.lastTabs = res.tabs;
  if (res.version) state.extensionVersion = res.version;
  return state.lastTabs;
}

async function callTool(tool, args = {}, tabId) {
  if (tool === 'list_tabs') {
    const tabs = await listTabs();
    return { text: tabs.map((t) => `[${t.id}]${t.active ? ' *' : ''} ${t.title} — ${t.url}`).join('\n') || '(no open tabs)', tabs };
  }
  const payload = { type: 'ext_tool', tool, args };
  if (Number.isInteger(tabId)) payload.tabId = tabId;
  const res = await sendExtensionRequest(payload, 35000);
  return res.result;
}

async function status() {
  let tabs = state.lastTabs;
  const connected = !!(state.activeSocket && state.activeSocket.readyState === 1);
  if (connected) {
    try { tabs = await listTabs(); } catch (_) {}
  }
  return {
    running: state.running,
    port: state.port,
    bridgeUrl: `ws://127.0.0.1:${state.port}`,
    proxyUrl: `http://127.0.0.1:${state.port}/v1`,
    extensionConnected: connected,
    connectedClients: state.clients.size,
    extensionVersion: state.extensionVersion,
    extensionDir: extensionDir(),
    tabs: Array.isArray(tabs) ? tabs : [],
  };
}

function start(opts = {}) {
  if (state.server && state.running) {
    if (opts.getProvider) state.getProvider = opts.getProvider;
    if (opts.getOrchestrator) state.getOrchestrator = opts.getOrchestrator;
    return Promise.resolve({ ok: true, port: state.port });
  }
  state.getProvider = opts.getProvider || state.getProvider;
  state.getOrchestrator = opts.getOrchestrator || state.getOrchestrator;
  const listenPort = opts.port !== undefined ? Number(opts.port) : (Number(process.env.AKRON_BRIDGE_PORT) || DEFAULT_PORT);

  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        return res.end();
      }
      const pathname = (req.url || '/').split('?')[0];
      if (req.method === 'GET' && (pathname === '/v1/health' || pathname === '/health')) {
        return sendJson(res, 200, {
          ok: true,
          port: state.port,
          extensionConnected: !!(state.activeSocket && state.activeSocket.readyState === 1),
          connectedClients: state.clients.size,
        });
      }
      if (req.method === 'GET' && pathname === '/v1/models') {
        const data = await gatherModels();
        return sendJson(res, 200, { object: 'list', data });
      }
      if (req.method === 'POST' && pathname === '/v1/chat/completions') {
        return handleChatCompletions(req, res);
      }
      return sendJson(res, 404, { error: { message: 'Not found: ' + pathname } });
    });

    const wss = new WebSocketServer({ noServer: true });
    wss.on('connection', attachSocket);
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    server.on('error', (err) => {
      console.error('extbridge listener error:', err.message);
      state.running = false;
      resolve({ ok: false, error: err.message });
    });

    server.listen(listenPort, '127.0.0.1', () => {
      const addr = server.address();
      state.server = server;
      state.wss = wss;
      state.port = (addr && addr.port) || listenPort;
      state.running = true;
      resolve({ ok: true, port: state.port });
    });
  });
}

function stop() {
  for (const [, p] of state.pending) {
    clearTimeout(p.timer);
    p.reject(new Error('Extension bridge stopped'));
  }
  state.pending.clear();
  for (const ws of state.clients) {
    try { ws.close(); } catch (_) {}
  }
  state.clients.clear();
  state.activeSocket = null;
  state.running = false;
  return new Promise((resolve) => {
    try { state.wss && state.wss.close(); } catch (_) {}
    if (!state.server) return resolve();
    const srv = state.server;
    state.server = null;
    state.wss = null;
    srv.close(() => resolve());
  });
}

module.exports = { start, stop, status, listTabs, callTool, extensionDir };
