'use strict';
// Desktop <-> Browser Extension bridge (Akron Browser Bot) on 127.0.0.1:8766.
//
// Two surfaces share the same local listener:
//   1. HTTP OpenAI-compatible proxy (`http://127.0.0.1:8766/v1/*`) so Akron
//      Browser Bot automatically shares ALL configured Akron Code Desktop models
//      and pools with ZERO separate API keys required.
//   2. WebSocket bridge (`ws://127.0.0.1:8766`) so Akron Code Desktop agents
//      can control the user's live Chrome/Brave/Edge tabs via `ext_browser`.

const http = require('http');
const path = require('path');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const orchRouter = require('./orch-router');
const freellm = require('./freellm');

const DEFAULT_PORT = 8766;
const ALIAS_ROLES = ['planner', 'coder', 'vision', 'fast', 'longctx'];
const OLLAMA_TTL_MS = 15000;

let state = {
  server: null,
  wss: null,
  port: DEFAULT_PORT,
  running: false,
  getProvider: null,
  getOrchestrator: null,
  getExtraProviders: null,
  ollamaCache: { at: 0, models: [] },
  clients: new Set(),
  activeSocket: null,
  extensionVersion: null,
  lastTabs: [],
  pending: new Map(), // request_id -> { resolve, reject, timer }
};

function extensionDir() {
  try {
    const installer = require('./browser-ext-installer');
    const res = installer.syncStandaloneExtension();
    if (res && res.extensionDir && fs.existsSync(res.extensionDir)) return res.extensionDir;
  } catch (_) {}
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

async function gatherOllamaModels() {
  if (Date.now() - state.ollamaCache.at < OLLAMA_TTL_MS) return state.ollamaCache.models;
  let models = [];
  try {
    const r = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1200) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      if (j && Array.isArray(j.models)) {
        models = j.models.map((m) => String((m && (m.model || m.name)) || '').trim()).filter(Boolean);
      }
    }
  } catch (_) {}
  state.ollamaCache = { at: Date.now(), models };
  return models;
}

function enrichRow(row) {
  if (!row || typeof row !== 'object') return row;
  if (!row.apiKey && /:(3001|31415)\b/.test(String(row.baseURL || ''))) {
    try {
      const cfg = freellm.loadConfig ? freellm.loadConfig() : null;
      if (cfg && cfg.token) return { ...row, apiKey: cfg.token };
    } catch (_) {}
  }
  return row;
}

async function gatherBackends() {
  const llm = require('./llm');
  const rawBase = state.getProvider ? await Promise.resolve(state.getProvider()).catch(() => null) : null;
  const orch = state.getOrchestrator ? await Promise.resolve(state.getOrchestrator()).catch(() => null) : null;
  const extras = state.getExtraProviders ? await Promise.resolve(state.getExtraProviders()).catch(() => []) : [];
  const ollamaModels = await gatherOllamaModels();

  const backends = [];
  const addBackend = (raw, extraCatalog = []) => {
    if (!raw || typeof raw !== 'object') return;
    const enriched = enrichRow(raw);
    const norm = llm.normalizeProvider(enriched);
    const catalogModels = [...new Set([
      norm.model,
      ...(Array.isArray(raw.catalogModels) ? raw.catalogModels : []),
      ...(Array.isArray(raw.models) ? raw.models : []),
      ...extraCatalog,
    ].map((x) => String(x || '').trim()).filter(Boolean))];
    norm.catalogModels = catalogModels;
    norm._isOllama = /11434/.test(String(norm.baseURL || ''));
    norm._isFreeLlm = /:(3001|31415)\b/.test(String(norm.baseURL || ''));
    backends.push(norm);
  };

  if (rawBase && (rawBase.model || rawBase.baseURL || rawBase.oauthProvider || rawBase.transport)) {
    addBackend(rawBase);
  }
  if (orch && Array.isArray(orch.providers)) {
    for (const p of orch.providers) {
      if (p && p.enabled !== false) addBackend(p);
    }
  }
  const poolsCfg = orch && orchRouter.poolsConfig(orch);
  if (poolsCfg && poolsCfg.roles) {
    for (const r of ALIAS_ROLES) {
      const scoped = orchRouter.orchestratorFor(orch, r, rawBase ? llm.normalizeProvider(enrichRow(rawBase)) : null);
      if (scoped && Array.isArray(scoped.providers)) {
        for (const p of scoped.providers) addBackend(p);
      }
    }
  }
  if (Array.isArray(extras)) {
    for (const ex of extras) addBackend(ex);
  }
  if (ollamaModels.length) {
    addBackend({
      id: 'ollama',
      name: 'Ollama (Local)',
      baseURL: 'http://127.0.0.1:11434/v1',
      model: ollamaModels[0],
      supportsTools: true,
    }, ollamaModels);
  }
  return { base: rawBase ? llm.normalizeProvider(enrichRow(rawBase)) : null, orch, backends };
}

function inferModelTransport(reqModel) {
  const id = String(reqModel || '').trim();
  if (!id) return [];
  if (/:/.test(id)) return ['ollama'];
  if (/^gemini-/i.test(id)) return ['google'];
  if (/^claude-.*-(low|medium|high|xhigh|minimal)$/i.test(id)) return ['google'];
  if (/^claude-/i.test(id)) return ['anthropic', 'google'];
  if (/^(gpt-5|gpt-6|gpt-reserve|codex|o[1-9]\b)/i.test(id)) return ['codex'];
  if (/^grok-/i.test(id)) return ['grok'];
  if (/^(qwen|deepseek|nemotron|mistral|devstral|gpt-oss|llama|glm|kimi|minimax)/i.test(id)) return ['freellm', 'ollama'];
  return ['freellm', 'ollama'];
}

function backendTransportKind(b) {
  if (!b) return '';
  if (b.transport) return String(b.transport);
  if (b._isOllama || /11434/.test(String(b.baseURL || ''))) return 'ollama';
  if (b._isFreeLlm || /:(3001|31415)\b/.test(String(b.baseURL || ''))) return 'freellm';
  return 'openai';
}

function withModel(backend, modelId) {
  const copy = { ...backend, model: modelId };
  return copy;
}

function normalizeOpenAIMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const toolNameById = new Map();
  let seq = 0;
  return list.map((raw) => {
    if (!raw || typeof raw !== 'object') return raw;
    const m = { ...raw };
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      m.tool_calls = m.tool_calls.map((tc) => {
        if (!tc || typeof tc !== 'object') return tc;
        const fn = tc.function || {};
        const name = String(fn.name || tc.name || 'tool');
        const id = String(tc.id || '').trim() || ('call_akron_' + (++seq));
        toolNameById.set(id, name);
        return {
          id,
          type: 'function',
          function: {
            name,
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
          },
          ...(tc.thoughtSignature ? { thoughtSignature: tc.thoughtSignature } : {}),
        };
      });
    }
    if (m.role === 'tool') {
      const id = String(m.tool_call_id || m.toolCallId || '').trim();
      if (id) m.tool_call_id = id;
      if (!m.name && !m.tool_name && id && toolNameById.has(id)) {
        m.name = toolNameById.get(id);
      }
    }
    return m;
  });
}

async function gatherModels() {
  const { backends } = await gatherBackends();
  const ids = new Set(['akron-default']);
  for (const r of ALIAS_ROLES) ids.add('akron-' + r);
  for (const b of backends) {
    if (b.model) ids.add(String(b.model));
    for (const m of b.catalogModels || []) {
      if (m) ids.add(String(m));
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
  const { base, orch, backends } = await gatherBackends();
  const reqModel = String(requestedModel || '').trim();

  const dedupList = (items) => {
    const seen = new Set();
    const out = [];
    for (const row of items) {
      if (!row || !row.model) continue;
      const key = `${row.transport || ''}|${row.oauthProvider || row.baseURL || ''}|${row.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(llm.normalizeProvider(row));
    }
    return out;
  };

  if (reqModel.startsWith('akron-') && ALIAS_ROLES.includes(reqModel.slice(6))) {
    const role = reqModel.slice(6);
    const list = [];
    if (orch && orchRouter.poolsConfig(orch)) {
      const scoped = orchRouter.orchestratorFor(orch, role, base);
      if (scoped && Array.isArray(scoped.providers)) {
        for (const p of scoped.providers) list.push(enrichRow(p));
      }
    }
    if (base && base.model) list.push(base);
    for (const b of backends) list.push(b);
    return dedupList(list);
  }

  if (!reqModel || reqModel === 'akron-default') {
    const list = [];
    if (base && base.model) list.push(base);
    const poolsActive = orch && orchRouter.poolsActive(orch, base);
    if (poolsActive) {
      const scoped = orchRouter.orchestratorFor(orch, 'coder', base);
      if (scoped && Array.isArray(scoped.providers)) {
        for (const p of scoped.providers) list.push(enrichRow(p));
      }
    }
    for (const b of backends) list.push(b);
    return dedupList(list);
  }

  // Explicit model ID requested: route strictly to owning/compatible backends first.
  const exact = [];
  const catalogHits = [];
  const inferredKinds = inferModelTransport(reqModel);
  const affinityHits = [];

  for (const b of backends) {
    if (b.model === reqModel) {
      exact.push(b);
      continue;
    }
    if (Array.isArray(b.catalogModels) && b.catalogModels.includes(reqModel)) {
      catalogHits.push(withModel(b, reqModel));
      continue;
    }
    const kind = backendTransportKind(b);
    if (inferredKinds.includes(kind)) {
      affinityHits.push(withModel(b, reqModel));
    }
  }

  // Only allow mutating a generic plain OpenAI-compatible gateway when neither exact/catalog/affinity matched.
  const genericFallback = [];
  if (!exact.length && !catalogHits.length && !affinityHits.length) {
    for (const b of backends) {
      if (backendTransportKind(b) === 'openai') genericFallback.push(withModel(b, reqModel));
    }
  }

  const ordered = [...exact, ...catalogHits, ...affinityHits, ...genericFallback];
  // Never append unrelated transports/models for an explicit non-alias request;
  // that caused wrong-provider 400s instead of testing the requested model cleanly.
  return dedupList(ordered);
}

async function handleChatCompletions(req, res) {
  let body;
  try { body = await readJsonBody(req); }
  catch (e) { return sendJson(res, 400, { error: { message: e.message } }); }

  const list = await resolveCandidateList(body.model);
  if (!list.length) {
    return sendJson(res, 404, { error: { message: `Model "${body.model || 'default'}" is not configured in Akron Code Desktop.` } });
  }

  const llm = require('./llm');
  const normalizedMessages = normalizeOpenAIMessages(body.messages);
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
      messages: normalizedMessages,
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
    const friendlyMsg = llm.humanizeLLMError ? llm.humanizeLLMError(e) : String((e && e.message) || e);
    if (sseStarted && !res.writableEnded) {
      res.write(`data: ${JSON.stringify({ error: { message: friendlyMsg } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    sendJson(res, Number(e && e.status) || 502, { error: { message: friendlyMsg } });
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
  let extMeta = {};
  let browserMeta = {};
  try {
    const installer = require('./browser-ext-installer');
    extMeta = installer.syncStandaloneExtension() || {};
    browserMeta = installer.detectBrowsers() || {};
  } catch (_) {}
  return {
    running: state.running || Boolean(state.shared),
    shared: Boolean(state.shared),
    port: state.port,
    bridgeUrl: `ws://127.0.0.1:${state.port}`,
    proxyUrl: `http://127.0.0.1:${state.port}/v1`,
    extensionConnected: connected,
    connectedClients: state.clients.size,
    extensionVersion: state.extensionVersion || extMeta.version || null,
    extensionDir: extMeta.extensionDir || extensionDir(),
    extensionId: extMeta.extensionId || '',
    crxPath: extMeta.crxPath || '',
    defaultBrowser: browserMeta.defaultBrowser || null,
    preferredChromiumBrowser: browserMeta.preferredChromiumBrowser || null,
    installedBrowsers: browserMeta.installedBrowsers || [],
    tabs: Array.isArray(tabs) ? tabs : [],
  };
}

function start(opts = {}) {
  if (state.server && state.running) {
    if (opts.getProvider) state.getProvider = opts.getProvider;
    if (opts.getOrchestrator) state.getOrchestrator = opts.getOrchestrator;
    if (opts.getExtraProviders) state.getExtraProviders = opts.getExtraProviders;
    return Promise.resolve({ ok: true, port: state.port });
  }
  state.getProvider = opts.getProvider || state.getProvider;
  state.getOrchestrator = opts.getOrchestrator || state.getOrchestrator;
  state.getExtraProviders = opts.getExtraProviders || state.getExtraProviders;
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
          mode: 'desktop-primary',
          port: state.port,
          extensionConnected: !!(state.activeSocket && state.activeSocket.readyState === 1),
          connectedClients: state.clients.size,
        });
      }
      if (pathname === '/v1/ext/tabs' || pathname === '/ext/tabs' || pathname === '/v1/ext/tool' || pathname === '/ext/tool') {
        const ra = String((req.socket && req.socket.remoteAddress) || '');
        const isLoop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
        const origin = String((req.headers && req.headers.origin) || '');
        const badOrigin = origin && !/^chrome-extension:\/\//i.test(origin);
        if (!isLoop || badOrigin) {
          return sendJson(res, 403, { ok: false, error: 'Loopback local control only' });
        }
        if (req.method === 'GET' && (pathname === '/v1/ext/tabs' || pathname === '/ext/tabs')) {
          try {
            const st = await status();
            return sendJson(res, 200, { ok: true, ...st });
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: e.message });
          }
        }
        if (req.method === 'POST' && (pathname === '/v1/ext/tool' || pathname === '/ext/tool')) {
          try {
            const body = await readJsonBody(req);
            const action = String((body && (body.action || body.tool)) || '').trim();
            if (!action) return sendJson(res, 400, { ok: false, error: 'Missing action/tool' });
            const rawArgs = (body && body.args && typeof body.args === 'object') ? body.args : {};
            const { action: _a, tool: _t, args: _ar, tabId: rawTabId, ...rest } = body || {};
            const mergedArgs = { ...rawArgs, ...rest };
            const tabId = Number.isInteger(rawTabId) ? rawTabId : undefined;
            const result = await callTool(action, mergedArgs, tabId);
            return sendJson(res, 200, { ok: true, result });
          } catch (e) {
            return sendJson(res, 502, { ok: false, error: e.message });
          }
        }
      }
      if (pathname === '/v1/vault/autofill' && req.method === 'POST') {
        const ra = String((req.socket && req.socket.remoteAddress) || '');
        const isLoop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
        const origin = String((req.headers && req.headers.origin) || '');
        const badOrigin = origin && !/^chrome-extension:\/\//i.test(origin) && !/^https?:\/\/(127\.0\.0\.1|localhost)/i.test(origin);
        if (!isLoop || badOrigin) {
          return sendJson(res, 403, { ok: false, error: 'Loopback local control only' });
        }
        try {
          const body = await readJsonBody(req);
          const v2 = require('./browser-bot-v2');
          const result = await v2.vaultAutofill({
            pageUrl: body.pageUrl,
            expectedOrigin: body.expectedOrigin || body.origin,
            selectors: body.selectors || {},
            injectFn: async (assignments) => {
              if (!body.tabId && !state.activeSocket) {
                return { applied: assignments.map((a) => a.field) };
              }
              const applied = [];
              for (const item of assignments) {
                try {
                  await callTool('execute_javascript', {
                    expression: `(function(){var el=document.querySelector(${JSON.stringify(item.selector)});if(!el)return false;el.focus();el.value=${JSON.stringify(item.value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,
                  }, Number.isInteger(body.tabId) ? body.tabId : undefined);
                  applied.push(item.field);
                } catch (_) {}
              }
              return { applied };
            },
          });
          return sendJson(res, result.blocked ? 403 : (result.ok ? 200 : 404), result);
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      }
      if (pathname === '/v1/browser/skills' && req.method === 'GET') {
        const ra = String((req.socket && req.socket.remoteAddress) || '');
        const isLoop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
        if (!isLoop) return sendJson(res, 403, { ok: false, error: 'Loopback only' });
        const skills = require('./browser-skills').listSkills();
        return sendJson(res, 200, { ok: true, skills });
      }
      if (pathname === '/v1/models') {
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

    server.on('error', async (err) => {
      if (err && err.code === 'EADDRINUSE') {
        try {
          const r = await fetch(`http://127.0.0.1:${listenPort}/v1/health`, { signal: AbortSignal.timeout(1200) });
          if (r && r.ok) {
            const h = await r.json().catch(() => ({}));
            if (h && h.mode === 'mcp-standalone') {
              try {
                await fetch(`http://127.0.0.1:${listenPort}/v1/ext/yield`, {
                  method: 'POST',
                  signal: AbortSignal.timeout(1500),
                });
                await new Promise((rWait) => setTimeout(rWait, 180));
                if (!server.__yieldRetried) {
                  server.__yieldRetried = true;
                  server.removeAllListeners('listening');
                  server.listen(listenPort, '127.0.0.1', () => {
                    const addr = server.address();
                    state.server = server;
                    state.wss = wss;
                    state.port = (addr && addr.port) || listenPort;
                    state.running = true;
                    state.shared = false;
                    resolve({ ok: true, running: true, shared: false, reclaimedFromStandalone: true, port: state.port });
                  });
                  return;
                }
              } catch (_) {}
            }
            state.shared = true;
            state.running = true;
            state.port = listenPort;
            return resolve({ ok: true, running: true, shared: true, port: listenPort });
          }
        } catch (_) {}
      }
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

module.exports = {
  start,
  stop,
  status,
  listTabs,
  callTool,
  extensionDir,
  _internal: { gatherBackends, resolveCandidateList, normalizeOpenAIMessages, inferModelTransport },
};
