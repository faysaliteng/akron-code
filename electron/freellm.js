'use strict';
// FreeLLMAPI — a local, OpenAI-compatible router that aggregates several
// free-tier providers behind one endpoint (`http://127.0.0.1:3001/v1`).
//
// The desktop app already ships a `FreeLLMAPI (local router)` preset pointing at
// this URL, so once the router is running every free key behaves like a single
// API: one model list, one chat-completions surface, automatic fallback when a
// provider is rate-limited or out of credit.
//
// Keys live in `~/.autobot/freellm.json` (mode 0600), never in the repo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Readable } = require('stream');

const CONFIG_DIR = path.join(os.homedir(), '.autobot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'freellm.json');
const DEFAULT_EXTERNAL_URLS = ['http://127.0.0.1:31415/v1'];

let _fallbackKeyProvider = null;
function setFallbackKeyProvider(fn) {
  _fallbackKeyProvider = typeof fn === 'function' ? fn : null;
}

function getFallbackKey() {
  try {
    if (_fallbackKeyProvider) {
      const k = _fallbackKeyProvider();
      if (k && typeof k === 'string') return k.trim();
    }
  } catch (_) {}
  return '';
}

function hasInternalProviders(cfg) {
  if (!cfg || !cfg.providers) return false;
  return PROVIDER_IDS.some((id) => isConfigured(id, cfg));
}

function normalizeBase(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function isSelfLoopUrl(url, cfg) {
  const b = normalizeBase(url);
  if (!b || !cfg || !cfg.port) return false;
  try {
    const u = new URL(b);
    const p = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    const h = String(u.hostname || '').toLowerCase();
    return p === Number(cfg.port) && (h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]');
  } catch (_) {
    return false;
  }
}

function externalCandidates(cfg, opts) {
  if (opts && opts.upstreamURL === false) return [];
  if (process.env.FREELM_DISABLE_EXTERNAL === '1') return [];
  const raw = [
    opts && opts.upstreamURL,
    cfg && cfg.upstreamURL,
    process.env.FREELLM_UPSTREAM_URL,
    ...DEFAULT_EXTERNAL_URLS,
  ];
  const seen = new Set();
  const out = [];
  for (const r of raw) {
    const b = normalizeBase(r);
    if (!b || seen.has(b) || isSelfLoopUrl(b, cfg)) continue;
    seen.add(b);
    out.push(b);
  }
  return out;
}

function extractCallerAuth(req, cfg) {
  const out = {};
  if (req && req.headers) {
    const auth = req.headers.authorization;
    const xk = req.headers['x-api-key'];
    if (auth && String(auth).trim()) out.authorization = String(auth).trim();
    if (xk && String(xk).trim()) out['x-api-key'] = String(xk).trim();
  }
  if (!out.authorization && !out['x-api-key']) {
    const fb = getFallbackKey();
    if (fb) out.authorization = 'Bearer ' + fb;
    else if (cfg && cfg.token) out.authorization = 'Bearer ' + cfg.token;
  }
  return out;
}

async function probeExternalModels(cfg, authHeaders, opts) {
  const cands = externalCandidates(cfg, opts);
  for (const base of cands) {
    try {
      const res = await fetchUpstream(base + '/models', {
        method: 'GET',
        headers: { accept: 'application/json', 'user-agent': 'AkronBot-FreeLLMAPI/1.0', ...(authHeaders || {}) },
      }, Math.min(1800, (opts && opts.timeoutMs) || 1800));
      const text = await res.text().catch(() => '');
      let json = null;
      try { json = JSON.parse(text); } catch (_) {}
      // Any JSON API response (200 models list, 401 invalid API key, 403/429) proves
      // a live OpenAI-compatible / FreeLLMAPI Unified Router is listening here.
      if (json && typeof json === 'object' && (res.status !== 404)) {
        return { base, status: res.status, json, text };
      }
    } catch (_) {}
  }
  return null;
}

async function probeExternalHealth(cfg, opts) {
  const cands = externalCandidates(cfg, opts);
  for (const base of cands) {
    const root = base.replace(/\/v1$/i, '');
    for (const url of [root + '/health', base + '/models']) {
      try {
        const res = await fetchUpstream(url, { method: 'GET', headers: { accept: 'application/json' } }, 900);
        if (res && res.status && res.status !== 404) return base;
      } catch (_) {}
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Provider registry. Every upstream speaks the OpenAI chat-completions shape,
// so one adapter covers all of them; only the base URL, auth and a couple of
// headers differ.
// ---------------------------------------------------------------------------
const PROVIDERS = {
  groq: {
    label: 'Groq',
    baseURL: 'https://api.groq.com/openai/v1',
    defaultModel: 'qwen/qwen3.8-27b',
  },
  gemini: {
    label: 'Google Gemini',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-3.5-flash-lite',
  },
  cloudflare: {
    label: 'Cloudflare Workers AI',
    baseURL: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    defaultModel: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    needsAccount: true,
    models: [
      '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
      '@cf/qwen/qwen3.8-27b',
      '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      '@cf/openai/gpt-oss-120b',
      '@cf/zai-org/glm-5.3',
    ],
  },
  nvidia: {
    label: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'nvidia/nemotron-3-ultra-550b-a55b',
  },
  cohere: {
    label: 'Cohere',
    baseURL: 'https://api.cohere.com/compatibility/v1',
    // The compatibility surface has no /models route; the native one lists them.
    modelsURL: 'https://api.cohere.com/v1/models',
    defaultModel: 'command-r-08-2024',
  },
  kilo: {
    label: 'Kilo',
    baseURL: 'https://kilo.ai/api/openrouter',
    defaultModel: 'kilo-auto/free',
    referer: true,
  },
  openrouter: {
    label: 'OpenRouter',
    baseURL: 'https://openrouter.ai/api/v1',
    defaultModel: 'liquid/lfm-3-1.7b:free',
    referer: true,
  },
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

// `fast`/`smart` steer the fallback order without pinning a provider.
const ALIASES = {
  auto: null,
  free: null,
  fast: ['groq', 'gemini', 'cloudflare', 'nvidia', 'cohere', 'kilo', 'openrouter'],
  smart: ['nvidia', 'gemini', 'openrouter', 'groq', 'cloudflare', 'cohere', 'kilo'],
};

// Fields we allow through to an upstream. Anything else is dropped so a client
// sending an Anthropic-shaped body cannot make every provider 400.
const FORWARD_FIELDS = [
  'messages', 'model', 'stream', 'max_tokens', 'max_completion_tokens',
  'temperature', 'top_p', 'top_k', 'stop', 'presence_penalty',
  'frequency_penalty', 'seed', 'response_format', 'tools', 'tool_choice',
  'parallel_tool_calls', 'user', 'n', 'logprobs', 'top_logprobs',
  'reasoning_effort', 'verbosity', 'modalities', 'audio', 'prediction',
  'stream_options', 'service_tier',
];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
function defaultConfig() {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const spec = PROVIDERS[id];
    providers[id] = {
      enabled: true,
      apiKey: '',
      accountId: '',
      baseURL: spec.baseURL,
      defaultModel: spec.defaultModel,
    };
  }
  return {
    host: '127.0.0.1',
    port: 3001,
    token: '',
    timeoutMs: 120000,
    order: PROVIDER_IDS.slice(),
    providers,
  };
}

function envKey(id) {
  return process.env['FREELM_' + id.toUpperCase() + '_KEY'] || '';
}

/**
 * Merge defaults, the on-disk config, and env overrides into one object.
 * Never throws: a corrupt config falls back to defaults so the app still boots.
 */
function normalizeConfig(raw) {
  const base = defaultConfig();
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {
    ...base,
    ...src,
    providers: { ...base.providers },
  };
  // 0 means "ephemeral" and must survive normalisation; anything else falls back.
  const srcPort = Number(src.port);
  out.port = Number.isFinite(srcPort) && (srcPort > 0 || src.port === 0)
    ? srcPort
    : base.port;
  out.host = String(src.host || base.host);
  out.token = String(src.token || '');
  out.timeoutMs = Number(src.timeoutMs) > 0 ? Number(src.timeoutMs) : base.timeoutMs;
  out.order = Array.isArray(src.order) && src.order.length
    ? src.order.filter((id) => PROVIDERS[id])
    : base.order.slice();
  for (const id of PROVIDER_IDS) {
    const spec = PROVIDERS[id];
    const given = (src.providers && src.providers[id]) || {};
    out.providers[id] = {
      enabled: given.enabled !== false,
      apiKey: String(given.apiKey || envKey(id) || ''),
      accountId: String(given.accountId || process.env.FREELM_CLOUDFLARE_ACCOUNT || ''),
      baseURL: String(given.baseURL || spec.baseURL),
      defaultModel: String(given.defaultModel || spec.defaultModel),
      ...(Array.isArray(given.models) ? { models: given.models.slice() } : {}),
    };
  }
  // Env overrides for the listener.
  if (process.env.FREELM_PORT) out.port = Number(process.env.FREELM_PORT) || out.port;
  if (process.env.FREELM_HOST) out.host = process.env.FREELM_HOST;
  if (process.env.FREELM_TOKEN) out.token = process.env.FREELM_TOKEN;
  return out;
}

function loadConfig(file) {
  const target = file || CONFIG_FILE;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (_) {
    raw = null;
  }
  const cfg = normalizeConfig(raw);
  cfg.configFile = target;
  cfg.exists = raw != null;
  cfg.configured = PROVIDER_IDS.some((id) => {
    const p = cfg.providers[id];
    return p.enabled && !!p.apiKey && (!PROVIDERS[id].needsAccount || !!p.accountId);
  });
  return cfg;
}

/** Persist a config (0600) — used to bootstrap or edit keys from the app. */
function saveConfig(cfg, file) {
  const target = file || CONFIG_FILE;
  const clean = normalizeConfig(cfg);
  delete clean.configFile;
  delete clean.exists;
  delete clean.configured;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(clean, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(target, 0o600); } catch (_) {}
  return target;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------
function providerBase(id, cfg) {
  const spec = PROVIDERS[id];
  const p = (cfg.providers && cfg.providers[id]) || {};
  let base = String(p.baseURL || spec.baseURL || '').replace(/\/+$/, '');
  base = base.replace('{accountId}', encodeURIComponent(p.accountId || ''));
  return base;
}

function isConfigured(id, cfg) {
  const spec = PROVIDERS[id];
  const p = (cfg.providers && cfg.providers[id]) || {};
  if (p.enabled === false) return false;
  if (spec.needsAccount && !p.accountId) return false;
  return !!p.apiKey;
}

/**
 * Turn a requested model string into a plan:
 *   { mode:'auto', model? }            → walk cfg.order
 *   { mode:'order', order, model? }    → alias order
 *   { mode:'explicit', provider, model }
 * A bare id that is not provider-qualified is tried on every provider in order.
 */
function resolveModel(input, cfg) {
  const raw = String(input || '').trim();
  const lower = raw.toLowerCase();
  if (!raw || lower === 'auto' || lower === 'freellm/auto' || lower === 'default') return { mode: 'auto' };
  if (lower in ALIASES) {
    const order = ALIASES[lower];
    return order ? { mode: 'order', order: order.slice() } : { mode: 'auto' };
  }
  if (lower === 'fast' || lower === 'smart') return { mode: 'order', order: ALIASES[lower].slice() };
  // A bare provider id means "that provider's default model".
  if (PROVIDERS[lower]) {
    const p = cfg.providers[lower];
    return {
      mode: 'explicit',
      provider: lower,
      model: (p && p.defaultModel) || PROVIDERS[lower].defaultModel,
    };
  }
  const sep = raw.indexOf('/');
  const colon = raw.indexOf(':');
  let cut = -1;
  if (sep > 0) cut = sep;
  if (colon > 0 && (cut < 0 || colon < cut)) cut = colon;
  if (cut > 0) {
    const head = raw.slice(0, cut).toLowerCase();
    if (PROVIDERS[head]) {
      const rest = raw.slice(cut + 1).trim();
      const model = rest && (head !== 'kilo' || !rest.startsWith('/'))
        ? rest
        : ((cfg.providers[head] && cfg.providers[head].defaultModel) || PROVIDERS[head].defaultModel);
      return { mode: 'explicit', provider: head, model };
    }
  }
  // Provider-qualified ids can be double-prefixed (`freellm/groq/...`).
  if (lower.startsWith('freellm/')) return resolveModel(raw.slice('freellm/'.length), cfg);
  return { mode: 'auto', model: raw };
}

function candidates(cfg, plan) {
  const out = [];
  if (plan.mode === 'explicit') {
    const p = cfg.providers[plan.provider];
    if (!isConfigured(plan.provider, cfg)) {
      const err = new Error(
        'provider "' + plan.provider + '" is not configured (missing key' +
        (PROVIDERS[plan.provider].needsAccount ? ' or account id' : '') + ')'
      );
      err.status = 400;
      err.expose = true;
      throw err;
    }
    out.push({ provider: plan.provider, model: plan.model || p.defaultModel, cfg: p });
    return out;
  }
  const order = plan.order || cfg.order || PROVIDER_IDS;
  for (const id of order) {
    if (!PROVIDERS[id] || !isConfigured(id, cfg)) continue;
    const p = cfg.providers[id];
    out.push({ provider: id, model: plan.model || p.defaultModel || PROVIDERS[id].defaultModel, cfg: p });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream request construction
// ---------------------------------------------------------------------------
function buildUpstream(candidate, body) {
  const id = candidate.provider;
  const spec = PROVIDERS[id];
  const p = candidate.cfg || {};
  const payload = { model: candidate.model };
  for (const k of FORWARD_FIELDS) {
    if (k === 'model') continue;
    if (body && body[k] !== undefined) payload[k] = body[k];
  }
  if (!payload.messages || !Array.isArray(payload.messages) || !payload.messages.length) {
    const err = new Error('messages[] is required');
    err.status = 400;
    err.expose = true;
    throw err;
  }
  if (payload.stream) payload.stream = true;
  // Some providers reject an explicit `max_tokens` of 0/null.
  for (const k of ['max_tokens', 'max_completion_tokens', 'n']) {
    if (payload[k] === 0 || payload[k] === null) delete payload[k];
  }
  const headers = {
    'content-type': 'application/json',
    accept: payload.stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'AkronBot-FreeLLMAPI/1.0',
  };
  if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
  if (spec.referer) {
    headers['http-referer'] = 'https://akronlogic.com';
    headers['x-title'] = 'Akron Bot';
  }
  const url = providerBase(id, { providers: { [id]: p } }) + '/chat/completions';
  return { url, headers, payload };
}

// ---------------------------------------------------------------------------
// Error text: never surface raw HTML from an upstream
// ---------------------------------------------------------------------------
function stripMarkup(input) {
  return String(input == null ? '' : input)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function describeError(status, text) {
  const raw = String(text == null ? '' : text);
  let message = '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      const first = parsed[0] || {};
      message = (first.error && (first.error.message || first.error.status)) || '';
    } else if (parsed && typeof parsed === 'object') {
      const e = parsed.error;
      if (typeof e === 'string') message = e;
      else if (e && typeof e === 'object') message = e.message || e.detail || '';
      if (!message) message = parsed.message || parsed.detail || '';
    }
  } catch (_) {
    message = raw;
  }
  const clean = stripMarkup(message).slice(0, 400);
  if (!clean) return 'upstream returned HTTP ' + status;
  return clean;
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------
async function fetchUpstream(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    try { ctrl.abort(); } catch (_) {}
  }, Math.max(1000, timeoutMs || 120000));
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true;
  return err;
}

// ---------------------------------------------------------------------------
// External FreeLLMAPI Unified Router transparent proxy (:31415 -> :3001)
// ---------------------------------------------------------------------------
async function proxyChatExternal(extBase, req, body, res, opts, cfg) {
  const timeout = (opts && opts.timeoutMs) || (cfg && cfg.timeoutMs) || 120000;
  const authHeaders = extractCallerAuth(req, cfg);
  const headers = {
    'content-type': 'application/json',
    accept: body && body.stream ? 'text/event-stream' : 'application/json',
    'user-agent': 'AkronBot-FreeLLMAPI/1.0',
    ...authHeaders,
  };
  const upstream = await fetchUpstream(extBase + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  }, timeout);

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    throw httpError(upstream.status, describeError(upstream.status, text));
  }

  if (body && body.stream) {
    if (!upstream.body) throw httpError(502, 'upstream returned an empty stream');
    res.writeHead(200, {
      'content-type': upstream.headers.get('content-type') || 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-freellm-upstream': extBase,
    });
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch (_) {} });
    res.on('close', () => { try { nodeStream.destroy(); } catch (_) {} });
    nodeStream.pipe(res);
    return;
  }

  const text = await upstream.text();
  let data;
  try { data = JSON.parse(text); } catch (_) {
    throw httpError(502, 'upstream returned non-JSON response');
  }
  sendJson(res, upstream.status || 200, data, { 'x-freellm-upstream': extBase });
}

// ---------------------------------------------------------------------------
// Non-streaming completion with fallback
// ---------------------------------------------------------------------------
async function chat(cfg, body, opts) {
  const plan = resolveModel(body && body.model, cfg);
  const list = hasInternalProviders(cfg) ? candidates(cfg, plan) : [];
  if (!list.length) {
    const ext = await probeExternalModels(cfg, extractCallerAuth(opts && opts.req, cfg), opts);
    if (ext) {
      const authHeaders = extractCallerAuth(opts && opts.req, cfg);
      const upstream = await fetchUpstream(ext.base + '/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': 'AkronBot-FreeLLMAPI/1.0',
          ...authHeaders,
        },
        body: JSON.stringify({ ...(body || {}), stream: false }),
      }, (opts && opts.timeoutMs) || cfg.timeoutMs);
      const text = await upstream.text();
      if (!upstream.ok) throw httpError(upstream.status, describeError(upstream.status, text));
      let data;
      try { data = JSON.parse(text); } catch (_) { throw httpError(502, 'upstream returned a non-JSON response'); }
      return { data, provider: 'freellm-external', model: (body && body.model) || 'auto', attempts: [] };
    }
    if (plan.mode === 'explicit' && PROVIDERS[plan.provider]) {
      // Throw explicit provider missing error when user explicitly asked e.g. groq/...
      candidates(cfg, plan);
    }
    throw httpError(400, 'no FreeLLM provider is configured — add keys to ~/.autobot/freellm.json or run FreeLLMAPI Unified Router');
  }
  const attempts = [];
  const timeout = (opts && opts.timeoutMs) || cfg.timeoutMs;
  for (const cand of list) {
    const { url, headers, payload } = buildUpstream(cand, body);
    const started = Date.now();
    try {
      const upstream = await fetchUpstream(url, { method: 'POST', headers, body: JSON.stringify(payload) }, timeout);
      const text = await upstream.text();
      if (!upstream.ok) {
        attempts.push({ provider: cand.provider, status: upstream.status, error: describeError(upstream.status, text), ms: Date.now() - started });
        if (plan.mode === 'explicit') throw httpError(upstream.status, describeError(upstream.status, text));
        continue;
      }
      let data;
      try { data = JSON.parse(text); } catch (_) {
        attempts.push({ provider: cand.provider, status: 502, error: 'upstream returned non-JSON', ms: Date.now() - started });
        if (plan.mode === 'explicit') throw httpError(502, 'upstream returned a non-JSON response');
        continue;
      }
      if (Array.isArray(data)) {
        const message = describeError(upstream.status, text);
        attempts.push({ provider: cand.provider, status: 502, error: message, ms: Date.now() - started });
        if (plan.mode === 'explicit') throw httpError(502, message);
        continue;
      }
      if (!data || !Array.isArray(data.choices)) {
        const message = describeError(upstream.status, JSON.stringify((data && data.error) || data));
        attempts.push({ provider: cand.provider, status: 502, error: message, ms: Date.now() - started });
        if (plan.mode === 'explicit') throw httpError(502, message);
        continue;
      }
      data._freellm = { provider: cand.provider, model: cand.model, ms: Date.now() - started, attempts: attempts.length };
      record(cand.provider, { ok: true, status: 200, ms: Date.now() - started, at: Date.now() });
      return { data, provider: cand.provider, model: cand.model, attempts };
    } catch (err) {
      if (err && err.expose) throw err;
      const message = err && err.name === 'AbortError' ? 'timed out after ' + Math.round(timeout / 1000) + 's' : stripMarkup(err && err.message) || 'network error';
      attempts.push({ provider: cand.provider, status: 0, error: message, ms: Date.now() - started });
      record(cand.provider, { ok: false, status: 0, error: message, ms: Date.now() - started, at: Date.now() });
      if (plan.mode === 'explicit') throw httpError(502, message);
    }
  }
  const summary = attempts.slice(0, 4).map((a) => a.provider + ': ' + a.error).join(' | ');
  throw httpError(502, summary || 'all providers failed');
}

// ---------------------------------------------------------------------------
// Streaming completion with fallback (fallback only before the first byte)
// ---------------------------------------------------------------------------
async function streamChat(cfg, body, res, opts) {
  const plan = resolveModel(body && body.model, cfg);
  const list = hasInternalProviders(cfg) ? candidates(cfg, plan) : [];
  if (!list.length) {
    const ext = await probeExternalModels(cfg, extractCallerAuth(opts && opts.req, cfg), opts);
    if (ext) {
      await proxyChatExternal(ext.base, opts && opts.req, { ...(body || {}), stream: true }, res, opts, cfg);
      return { provider: 'freellm-external', model: (body && body.model) || 'auto', attempts: [] };
    }
    if (plan.mode === 'explicit' && PROVIDERS[plan.provider]) {
      candidates(cfg, plan);
    }
    throw httpError(400, 'no FreeLLM provider is configured — add keys to ~/.autobot/freellm.json or run FreeLLMAPI Unified Router');
  }
  const attempts = [];
  const timeout = (opts && opts.timeoutMs) || cfg.timeoutMs;
  for (const cand of list) {
    const { url, headers, payload } = buildUpstream(cand, body);
    const started = Date.now();
    let upstream;
    try {
      upstream = await fetchUpstream(url, { method: 'POST', headers, body: JSON.stringify(payload) }, Math.min(timeout, 60000));
    } catch (err) {
      const message = err && err.name === 'AbortError' ? 'timed out opening the stream' : stripMarkup(err && err.message) || 'network error';
      attempts.push({ provider: cand.provider, status: 0, error: message, ms: Date.now() - started });
      record(cand.provider, { ok: false, status: 0, error: message, ms: Date.now() - started, at: Date.now() });
      if (plan.mode === 'explicit') throw httpError(502, message);
      continue;
    }
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      attempts.push({ provider: cand.provider, status: upstream.status, error: describeError(upstream.status, text), ms: Date.now() - started });
      record(cand.provider, { ok: false, status: upstream.status, error: describeError(upstream.status, text), ms: Date.now() - started, at: Date.now() });
      if (plan.mode === 'explicit') throw httpError(upstream.status, describeError(upstream.status, text));
      continue;
    }
    if (!upstream.body) {
      attempts.push({ provider: cand.provider, status: 502, error: 'upstream returned an empty stream', ms: Date.now() - started });
      continue;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'x-freellm-provider': cand.provider,
      'x-freellm-model': cand.model,
      'x-freellm-attempts': String(attempts.length),
    });
    record(cand.provider, { ok: true, status: 200, ms: Date.now() - started, at: Date.now() });
    const nodeStream = Readable.fromWeb(upstream.body);
    nodeStream.on('error', () => { try { res.end(); } catch (_) {} });
    res.on('close', () => {
      // Destroying the Node stream cancels the underlying web stream; calling
      // `upstream.body.cancel()` here would throw (the stream is locked by the
      // adapter) and crash the process.
      try { nodeStream.destroy(); } catch (_) {}
    });
    nodeStream.pipe(res);
    return { provider: cand.provider, model: cand.model, attempts };
  }
  const summary = attempts.slice(0, 4).map((a) => a.provider + ': ' + a.error).join(' | ');
  throw httpError(502, summary || 'all providers failed');
}

// ---------------------------------------------------------------------------
// Health + model discovery
// ---------------------------------------------------------------------------
const healthState = new Map(); // provider -> { ok, status, ms, error, at }
const discoveryCache = new Map(); // provider -> { at, models }

function record(provider, info) {
  healthState.set(provider, info);
}

async function discover(provider, cfg, timeoutMs) {
  const spec = PROVIDERS[provider];
  const p = cfg.providers[provider] || {};
  const cached = discoveryCache.get(provider);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.models;
  if (spec.models && !p.apiKey) return spec.models.slice();
  const base = p.modelsURL || providerBase(provider, cfg);
  if (!base) return (spec.models || []).slice();
  const headers = { accept: 'application/json', 'user-agent': 'AkronBot-FreeLLMAPI/1.0' };
  if (p.apiKey) headers.authorization = 'Bearer ' + p.apiKey;
  const url = String(base).replace(/\/+$/, '') + '/models';
  try {
    const up = await fetchUpstream(url, { method: 'GET', headers }, timeoutMs || 5000);
    if (!up.ok) return (spec.models || []).slice();
    const text = await up.text();
    const data = JSON.parse(text);
    let ids = [];
    if (Array.isArray(data.data)) ids = data.data.map((m) => m && (m.id || m.name)).filter(Boolean);
    else if (Array.isArray(data.models)) ids = data.models.map((m) => m && (m.name || m.id)).filter(Boolean);
    ids = [...new Set(ids.map(String))];
    if (ids.length) {
      discoveryCache.set(provider, { at: Date.now(), models: ids });
      return ids;
    }
  } catch (_) {}
  return (spec.models || []).slice();
}

async function listModels(cfg, opts) {
  const entries = [];
  const add = (id, provider, extra) => {
    entries.push({ id, object: 'model', created: 0, owned_by: provider, provider, free: true, ...(extra || {}) });
  };
  add('auto', 'freellm', { description: 'Automatic provider fallback' });
  add('fast', 'freellm', { description: 'Latency-first fallback order' });
  add('smart', 'freellm', { description: 'Capability-first fallback order' });
  const ids = Object.keys(cfg.providers).filter((id) => isConfigured(id, cfg));
  const discovered = await Promise.all(ids.map((id) => discover(id, cfg, (opts && opts.timeoutMs) || 5000).catch(() => [])));
  ids.forEach((id, i) => {
    const p = cfg.providers[id];
    const defaults = [p.defaultModel, ...(PROVIDERS[id].models || []), ...discovered[i]]
      .filter(Boolean)
      .map(String);
    for (const model of [...new Set(defaults)]) add(id + '/' + model, id);
  });
  return entries;
}

function health(cfg) {
  const providers = {};
  for (const id of PROVIDER_IDS) {
    const p = cfg.providers[id] || {};
    const last = healthState.get(id) || null;
    providers[id] = {
      label: PROVIDERS[id].label,
      enabled: p.enabled !== false,
      configured: isConfigured(id, cfg),
      baseURL: providerBase(id, cfg),
      defaultModel: p.defaultModel || PROVIDERS[id].defaultModel,
      last,
    };
  }
  return {
    ok: true,
    service: 'FreeLLMAPI',
    version: 1,
    endpoint: 'http://' + cfg.host + ':' + cfg.port + '/v1',
    order: cfg.order.filter((id) => isConfigured(id, cfg)),
    providers,
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
function sendJson(res, status, obj, headers) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...(headers || {}),
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || 8 * 1024 * 1024)) {
        reject(httpError(413, 'request body too large'));
        try { req.destroy(); } catch (_) {}
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req, cfg) {
  if (!cfg.token) return true;
  const h = String(req.headers.authorization || '');
  const bearer = h.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : '';
  const key = String(req.headers['x-api-key'] || '').trim();
  return bearer === cfg.token || key === cfg.token;
}

function handleCors(req, res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'authorization, content-type, x-api-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-max-age', '600');
}

function createRouter(config, opts) {
  const cfg = normalizeConfig(config || {});
  const server = http.createServer(async (req, res) => {
    handleCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'));
    const route = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (route === '/' || route === '/v1')) {
        sendJson(res, 200, {
          service: 'FreeLLMAPI',
          endpoint: 'http://' + cfg.host + ':' + cfg.port + '/v1',
          docs: 'POST /v1/chat/completions, GET /v1/models, GET /health',
          providers: Object.keys(cfg.providers).filter((id) => isConfigured(id, cfg)),
        });
        return;
      }
      if (req.method === 'GET' && (route === '/health' || route === '/v1/health' || route === '/status')) {
        const h = health(cfg);
        if (!hasInternalProviders(cfg) || (opts && opts.upstreamURL) || cfg.upstreamURL) {
          h.upstream = await probeExternalHealth(cfg, opts);
        }
        sendJson(res, 200, h);
        return;
      }
      if (req.method === 'GET' && (route === '/v1/providers' || route === '/providers')) {
        sendJson(res, 200, health(cfg));
        return;
      }
      if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
        if (!hasInternalProviders(cfg) || (opts && opts.upstreamURL) || cfg.upstreamURL) {
          const ext = await probeExternalModels(cfg, extractCallerAuth(req, cfg), opts);
          if (ext) {
            const payload = ext.json || { object: 'list', data: [] };
            sendJson(res, ext.status, payload, { 'x-freellm-upstream': ext.base });
            return;
          }
          if (!hasInternalProviders(cfg)) {
            sendJson(res, 503, { error: { message: 'no FreeLLM provider configured — add keys to ~/.autobot/freellm.json or run FreeLLMAPI Unified Router', type: 'freellm_error', code: 503 } });
            return;
          }
        }
        const data = await listModels(cfg, opts);
        sendJson(res, 200, { object: 'list', data });
        return;
      }
      if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/chat/completions')) {
        if (!authorized(req, cfg)) throw httpError(401, 'invalid router token');
        const raw = await readBody(req);
        let body;
        try { body = JSON.parse(raw); } catch (_) { throw httpError(400, 'invalid JSON body'); }
        if (!body || typeof body !== 'object') throw httpError(400, 'invalid JSON body');
        if (!hasInternalProviders(cfg) || (opts && opts.upstreamURL) || cfg.upstreamURL) {
          const ext = await probeExternalModels(cfg, extractCallerAuth(req, cfg), opts);
          if (ext) {
            await proxyChatExternal(ext.base, req, body, res, opts, cfg);
            return;
          }
        }
        if (body.stream) {
          try {
            await streamChat(cfg, body, res, { ...(opts || {}), req });
          } catch (err) {
            if (res.headersSent) { try { res.end(); } catch (_) {} return; }
            throw err;
          }
          return;
        }
        const result = await chat(cfg, body, { ...(opts || {}), req });
        sendJson(res, 200, result.data, {
          'x-freellm-provider': result.provider,
          'x-freellm-model': result.model,
          'x-freellm-attempts': String(result.attempts.length),
        });
        return;
      }
      throw httpError(404, 'not found — try /v1/models or POST /v1/chat/completions');
    } catch (err) {
      const status = (err && err.status) || 500;
      const message = err && err.expose ? err.message : stripMarkup((err && err.message) || 'internal error').slice(0, 400);
      if (!res.headersSent) sendJson(res, status, { error: { message, type: 'freellm_error', code: status } });
      else { try { res.end(); } catch (_) {} }
    }
  });
  server.on('clientError', (err, socket) => {
    try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (_) {}
  });
  return { server, config: cfg };
}

/**
 * Start the router. Resolves with a handle once listening.
 *   start({ configPath?, config?, port?, host? })
 */
function start(options) {
  const o = options || {};
  const cfg = o.config ? normalizeConfig(o.config) : loadConfig(o.configPath);
  // `port: 0` is meaningful (ephemeral) — only ignore nullish values.
  if (o.port !== undefined && o.port !== null && o.port !== '') cfg.port = Number(o.port);
  if (o.host) cfg.host = String(o.host);
  const { server } = createRouter(cfg, o);
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      if (err && err.code === 'EADDRINUSE') {
        reject(new Error('port ' + cfg.port + ' is already in use — another FreeLLMAPI instance may be running'));
      } else reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : cfg.port;
      const host = cfg.host;
      const handle = {
        server,
        config: cfg,
        port,
        host,
        url: 'http://' + host + ':' + port + '/v1',
        stop: () => new Promise((done) => {
          try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
          server.close(() => done());
        }),
      };
      resolve(handle);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(cfg.port, cfg.host);
  });
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  ALIASES,
  CONFIG_FILE,
  CONFIG_DIR,
  defaultConfig,
  normalizeConfig,
  loadConfig,
  saveConfig,
  resolveModel,
  candidates,
  buildUpstream,
  stripMarkup,
  describeError,
  chat,
  streamChat,
  listModels,
  health,
  createRouter,
  start,
  isConfigured,
  hasInternalProviders,
  setFallbackKeyProvider,
  probeExternalModels,
  probeExternalHealth,
  providerBase,
  _discoveryCache: discoveryCache,
  _healthState: healthState,
};
