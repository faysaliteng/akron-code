'use strict';
/**
 * Provider transports — speak each vendor's *native* wire format.
 *
 * Why not just use the OpenAI chat-completions shape for everything?
 * Because a subscription endpoint is not an API gateway. Anthropic's
 * `/v1/messages`, OpenAI's `responses` (what the ChatGPT subscription serves),
 * and Google's `cloudcode-pa` all differ in body shape, SSE event vocabulary,
 * and tool-call framing. Shoehorning them into `/chat/completions` produces
 * 404s at best and silently-mangled tool calls at worst.
 *
 * Contract
 * --------
 * Every adapter has the same signature as llm.chatCompletion and returns the
 * same internal message object:
 *
 *   chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride)
 *     -> { role:'assistant', content, tool_calls:[{id,type,function:{name,arguments}}],
 *          finish_reason, usage }
 *
 * `onDelta(text, isReasoning)` streams visible text; reasoning text is passed
 * with the second argument so the UI can fold it instead of printing it.
 * `tool_calls[].function.arguments` is always a JSON *string*, matching what
 * the agent loop already parses.
 *
 * Verification honesty
 * --------------------
 * `anthropic` is live-verified against a real Claude subscription token.
 * `codex` and `google` are implemented from their published wire formats and
 * covered by unit tests. Antigravity is field-verified live (models + streaming
 * + tool calls). ChatGPT is wire-matched to the Codex CLI binary but has no
 * ChatGPT-Plus credential on this machine, so it is not claimed as field-tested.
 */

const { randomUUID } = require('node:crypto');

const _initialFetch = typeof fetch === 'function' ? fetch : null;
let _keepAliveDispatcher = null;
function getKeepAliveDispatcher() {
  if (_keepAliveDispatcher !== null) return _keepAliveDispatcher || undefined;
  try {
    const { Agent } = require('undici');
    _keepAliveDispatcher = new Agent({
      keepAliveTimeout: 60000,
      keepAliveMaxTimeout: 300000,
      connections: 32,
      pipelining: 1,
      allowH2: true,
    });
    return _keepAliveDispatcher;
  } catch (_) {
    _keepAliveDispatcher = false;
    return undefined;
  }
}

function warmHttpEndpoint(baseURL) {
  try {
    const raw = String(baseURL || '').trim();
    if (!raw || !/^https?:\/\//i.test(raw)) return;
    if (globalThis.fetch !== _initialFetch) return;
    const u = new URL(raw);
    const dispatcher = getKeepAliveDispatcher();
    Promise.resolve(_initialFetch(u.origin, {
      method: 'HEAD',
      ...(dispatcher ? { dispatcher } : {}),
      signal: AbortSignal.timeout(1500),
    })).catch(() => {});
  } catch (_) {}
}

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';
const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_XAI_BASE = 'https://api.x.ai/v1';
const DEFAULT_ZAI_CODING_BASE = 'https://api.z.ai/api/coding/paas/v4';
const DEFAULT_ZAI_BASE = 'https://api.z.ai/api/paas/v4';
const OFFICIAL_USER_AGENT = 'akron-code/' + (() => { try { return require('../package.json').version; } catch (_) { return '1.7.0'; } })(); // follows the release

// Context windows + auto-compact budgets. Pure data module, no imports, so this
// does not create a cycle (and survives asar packing).
const catalog = require('./model-catalog');
const usageEstimator = require('./usage-estimator');

// Ask for the 1M beta once the request estimate passes Anthropic's default
// window with headroom for its tokenizer being a little finer than ours.
const LONG_CONTEXT_MIN_TOKENS = 190000;

/** No-op legacy shim retained for callers expecting setClientVersions(). */
function setClientVersions() {
  return {};
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function trimBase(u) { return String(u || '').replace(/\/+$/, ''); }

/**
 * Yield the `data:` payload of each SSE event as a parsed object.
 * Tolerates CRLF, multi-line data blocks, `[DONE]`, and keep-alive comments.
 */
/**
 * Servers do not always label SSE: the ChatGPT Codex subscription endpoint
 * streams `event:`/`data:` frames with NO content-type header at all. Deciding
 * the parse strategy from `content-type` alone silently threw the whole answer
 * away (the frames were read as one JSON blob, parsed to null, and reported as
 * an empty success). Peek the first chunk, classify by its content, and replay
 * it so whichever parser runs still sees every byte.
 *
 * @returns {{stream: ReadableStream|null, isSse: boolean, empty: boolean}}
 */
async function fetchWithTimeout(url, options, label, customTimeoutMs = 0) {
  const timeoutMs = Number(process.env.HELIO_CONNECT_TIMEOUT_MS) || (Number(customTimeoutMs) > 0 ? Number(customTimeoutMs) : 120000);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { ctrl.abort(); } catch (_) {}
  }, timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  const parent = options && options.signal;
  const onParentAbort = () => { try { ctrl.abort(); } catch (_) {} };
  if (parent) {
    if (parent.aborted) { clearTimeout(timer); return fetch(url, options); }
    parent.addEventListener('abort', onParentAbort, { once: true });
  }
  const fn = (options && options.fetchImpl) || fetch;
  const fetchOpts = { ...options, signal: ctrl.signal };
  if (!fetchOpts.dispatcher && fn === _initialFetch) {
    const dispatcher = getKeepAliveDispatcher();
    if (dispatcher) fetchOpts.dispatcher = dispatcher;
  }
  let keepParentLink = false;
  try {
    const res = await fn(url, fetchOpts);
    // Keep Stop wired to `ctrl` while `res.body` streams so Stop mid-reply
    // immediately cancels the underlying socket; `openStream` / response cleanup
    // invokes `res._cleanupAbort()` when the body settles.
    if (parent && res && res.body) {
      keepParentLink = true;
      res._cleanupAbort = () => {
        try { parent.removeEventListener('abort', onParentAbort); } catch (_) {}
      };
    }
    return res;
  } catch (e) {
    if (timedOut && !(parent && parent.aborted)) {
      const err = new Error(`LLM ${label || 'provider'} connection timed out after ${Math.round(timeoutMs / 1000)}s`);
      err.transient = true;
      err.isTimeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (parent && !keepParentLink) parent.removeEventListener('abort', onParentAbort);
  }
}

async function openStream(res, signal) {
  const detachResAbort = () => {
    if (res && typeof res._cleanupAbort === 'function') {
      try { res._cleanupAbort(); } catch (_) {}
      res._cleanupAbort = null;
    }
  };
  const body = res && res.body;
  if (!body || typeof body.getReader !== 'function') {
    detachResAbort();
    return { stream: null, isSse: false, empty: true };
  }
  const reader = body.getReader();
  const stallMs = Number(process.env.HELIO_STREAM_STALL_MS) || 150000;

  let streamAbortHandler = null;
  const detachAll = () => {
    detachResAbort();
    if (signal && streamAbortHandler) {
      try { signal.removeEventListener('abort', streamAbortHandler); } catch (_) {}
      streamAbortHandler = null;
    }
  };

  const readWithGuards = () => {
    if (signal && signal.aborted) {
      try { reader.cancel().catch(() => {}); } catch (_) {}
      return Promise.reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    }
    let stallTimer = null;
    const stallPromise = new Promise((_, reject) => {
      stallTimer = setTimeout(() => reject(Object.assign(new Error(`LLM stream stalled: no data for ${stallMs / 1000}s`), { transient: true })), stallMs);
      if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();
    });
    let onSigAbort = null;
    const abortPromise = signal ? new Promise((_, reject) => {
      onSigAbort = () => {
        try { reader.cancel().catch(() => {}); } catch (_) {}
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      };
      signal.addEventListener('abort', onSigAbort, { once: true });
    }) : null;
    const races = abortPromise ? [reader.read(), stallPromise, abortPromise] : [reader.read(), stallPromise];
    return Promise.race(races).finally(() => {
      clearTimeout(stallTimer);
      if (signal && onSigAbort) {
        try { signal.removeEventListener('abort', onSigAbort); } catch (_) {}
      }
    });
  };

  let first;
  try {
    first = await readWithGuards();
  } catch (e) {
    detachAll();
    if (signal && signal.aborted) throw e;
    if (e && e.transient) { try { reader.cancel().catch(() => {}); } catch (_) {} throw e; }
    return { stream: null, isSse: false, empty: true };
  }
  if (first.done) {
    detachAll();
    return { stream: null, isSse: false, empty: true };
  }
  const head = new TextDecoder().decode(first.value, { stream: true });
  const isSse = /^\s*(?:event|data)\s*:/.test(head);
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(first.value);
      if (signal) {
        streamAbortHandler = () => {
          try { reader.cancel().catch(() => {}); } catch (_) {}
          try { c.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })); } catch (_) {}
        };
        if (signal.aborted) streamAbortHandler();
        else signal.addEventListener('abort', streamAbortHandler, { once: true });
      }
    },
    async pull(c) {
      try {
        const resChunk = await readWithGuards();
        if (resChunk.done) {
          detachAll();
          c.close();
          return;
        }
        c.enqueue(resChunk.value);
      } catch (e) {
        detachAll();
        c.error(e);
      }
    },
    cancel(reason) {
      detachAll();
      try { reader.cancel(reason).catch(() => {}); } catch (_) {}
    },
  });
  return { stream, isSse, empty: false };
}

async function* sseEvents(source) {
  const body = source && typeof source.getReader === 'function' ? source : (source && source.body);
  if (!body || typeof body.getReader !== 'function') return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line || line.startsWith(':') || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { continue; }
      yield obj;
    }
  }
}

/** Read the whole body when the server ignored `stream: true`. */
async function readJsonBody(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch (_) { return null; }
}

const TRANSPORT_LABEL = {
  anthropic: 'Claude',
  codex: 'ChatGPT',
  grok: 'Grok',
  google: 'Google Antigravity',
  antigravity: 'Google Antigravity',
  zai: 'Z.ai (GLM Coding Plan)',
};

function parseRetryAfterMs(res) {
  try {
    const getH = (k) => (res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) : null);
    const ra = getH('retry-after') || getH('x-ratelimit-reset-after');
    if (ra != null && String(ra).trim() !== '') {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs > 0) return { raw: String(ra), ms: Math.max(1000, Math.min(secs * 1000, 300000)) };
      const ts = Date.parse(String(ra));
      if (Number.isFinite(ts) && ts > Date.now()) {
        return { raw: String(ra), ms: Math.max(1000, Math.min(ts - Date.now(), 300000)) };
      }
    }
    const resetEpoch = Number(getH('x-ratelimit-reset'));
    if (Number.isFinite(resetEpoch) && resetEpoch > 0) {
      const targetMs = resetEpoch > 1e12 ? resetEpoch : resetEpoch * 1000;
      if (targetMs > Date.now()) return { raw: String(resetEpoch), ms: Math.max(1000, Math.min(targetMs - Date.now(), 300000)) };
    }
  } catch (_) {}
  return { raw: null, ms: 0 };
}

function logRateLimitDiagnostic(entry) {
  try {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = process.env.AKRON_RATE_LOG_DIR || path.join(os.homedir(), '.autobot', 'logs');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'rate-limits.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch (_) {}
}

function httpError(transport, res, text, meta = {}) {
  const body = String(text || '');
  // A 401 (or a 403 that names authentication) is a credential problem, not a
  // provider blip: retrying it five times burns ~37 s and blames the network.
  // Mark it so the agent loop stops at once and the composer asks for sign-in.
  const authBody = /authentication_error|invalid[_ ]?(?:token|grant|api[_ ]?key|credential)|oauth token|unauthori[sz]ed|not authenticated|token (?:has )?expired|sign ?in again/i.test(body);
  if (res.status === 401 || (res.status === 403 && authBody)) {
    const label = TRANSPORT_LABEL[transport] || 'This provider';
    const err = new Error(`${label} needs to be signed in again — open the model menu and choose Sign in.`);
    err.code = 'provider_needs_signin';
    err.human = true;
    err.status = res.status;
    err.transport = transport;
    err.body = body.slice(0, 400);
    return err;
  }
  const err = new Error('LLM ' + res.status + ': ' + body.slice(0, 400));
  err.status = res.status;
  err.transport = transport;
  // Which URL actually answered. A 404 is the one status where the banner is
  // otherwise undiagnosable: "model or endpoint does not exist" is true of a
  // wrong path, a gateway that never heard of the model, and a retired id, and
  // the body alone rarely says which. `Response.url` is the final URL after
  // redirects, so a proxy that rewrote the request is visible here too.
  if (res && typeof res.url === 'string' && res.url) err.endpoint = res.url;
  const parsedRa = parseRetryAfterMs(res);
  if (parsedRa.raw) err.retryAfter = parsedRa.raw;
  if (parsedRa.ms > 0) err.retryAfterMs = parsedRa.ms;
  if (res.status === 429) {
    err.rawBody = body.slice(0, 600);
    logRateLimitDiagnostic({
      status: 429,
      transport: String(transport || ''),
      model: String((meta && meta.model) || ''),
      oauthProvider: String((meta && meta.oauthProvider) || ''),
      endpoint: err.endpoint || '',
      retryAfter: parsedRa.raw || null,
      retryAfterMs: parsedRa.ms || 0,
      body: body.slice(0, 600),
    });
  }
  return err;
}

function sanitizeToolCallId(raw, fallbackSeq) {
  const clean = String(raw || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  if (clean && /[A-Za-z0-9]/.test(clean)) return clean;
  return 'toolu_akron_' + (fallbackSeq || 1);
}

function newToolAcc(id, name) {
  // `unwireToolName` reverses the `x_` prefix added for Anthropic's tool-name
  // restriction, so the rest of the app always sees the real tool name.
  return { id: id || '', type: 'function', function: { name: unwireToolName(name) || '', arguments: '' } };
}

function pushToolArg(acc, frag) {
  if (frag == null) return;
  acc.function.arguments += typeof frag === 'string' ? frag : JSON.stringify(frag);
}

function toolDeltaPayload(acc) {
  const args = String((acc && acc.function && acc.function.arguments) || '');
  const lines = args ? (args.match(/\\n|\n/g) || []).length + 1 : 0;
  return {
    id: (acc && acc.id) || '',
    name: (acc && acc.function && acc.function.name) || '',
    argsPreview: args.slice(0, 360),
    argsTail: args.slice(-600),
    bytes: Buffer.byteLength(args, 'utf8'),
    lines,
  };
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
//
// Live-verified. Two details are load-bearing and were both found the hard way:
// subscription traffic needs the `oauth-2025-04-20` beta header, and `x-api-key`
// is ignored on an OAuth token — it must be `Authorization: Bearer`.
// ---------------------------------------------------------------------------
function assertOfficialApiKey(provider, envVarNames, label) {
  const explicitKey = String((provider && provider.apiKey) || '').trim();
  const tok = String((provider && provider.accessToken) || '').trim();
  if ((provider && (provider.oauth || provider.oauthProvider)) && !explicitKey) {
    const err = new Error(`Subscription models for ${label} must run through the official CLI runner, not direct OAuth HTTPS transport.`);
    err.code = 'cli_transport_required';
    throw err;
  }
  if (/^sk-ant-oat/i.test(explicitKey || tok)) {
    const err = new Error('Anthropic subscription OAuth tokens cannot be sent via direct HTTPS transport; use Claude Code CLI mode or an official x-api-key.');
    err.code = 'cli_transport_required';
    throw err;
  }
  if (explicitKey) return explicitKey;
  for (const name of (envVarNames || [])) {
    const val = String(process.env[name] || '').trim();
    if (val) return val;
  }
  return '';
}

function formatResetIn(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const mins = Math.round((t - Date.now()) / 60000);
  const at = new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (mins <= 0) return at;
  if (mins < 90) return `${at}, in ${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return `${at}, in ${hrs} h`;
  return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function anthropicAuth(provider) {
  const apiKey = assertOfficialApiKey(provider, ['ANTHROPIC_API_KEY'], 'anthropic');
  return {
    oauth: false,
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
      'user-agent': OFFICIAL_USER_AGENT,
    },
  };
}

/**
 * Convert the internal OpenAI-ish transcript into Anthropic blocks.
 * System prompts are hoisted; tool results become user `tool_result` blocks;
 * assistant tool calls become `tool_use` blocks. Consecutive same-role turns are
 * merged because Anthropic rejects two adjacent user messages.
 */
function concatDedupBlocks(prevBlocks, nextBlocks) {
  const out = Array.isArray(prevBlocks) ? prevBlocks.slice() : [];
  for (const b of (Array.isArray(nextBlocks) ? nextBlocks : [])) {
    const prev = out[out.length - 1];
    if (b && b.type === 'text' && prev && prev.type === 'text' && String(prev.text || '') === String(b.text || '')) {
      continue;
    }
    out.push(b);
  }
  return out;
}

function toAnthropicBody(provider, messages, tools, maxTokens) {
  const systemParts = [];
  const rawMsgs = [];
  const rawToCleanId = new Map();
  let idSeq = 0;

  const pushMsg = (role, content) => {
    const last = rawMsgs[rawMsgs.length - 1];
    if (last && last.role === role) last.content = concatDedupBlocks(last.content, content);
    else rawMsgs.push({ role, content });
  };

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string' && m.content) systemParts.push({ type: 'text', text: m.content });
      continue;
    }
    if (role === 'tool') {
      const rawId = m.tool_call_id || m.toolCallId || '';
      const mappedId = rawId ? (rawToCleanId.get(rawId) || sanitizeToolCallId(rawId, ++idSeq)) : '';
      const block = {
        type: 'tool_result',
        tool_use_id: mappedId || sanitizeToolCallId('', ++idSeq),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content),
      };
      if (m.is_error || m.isError) block.is_error = true;
      pushMsg('user', [block]);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      const canReplayThinking = Array.isArray(m._anthropicThinkingBlocks) && m._anthropicThinkingBlocks.length > 0;
      if (canReplayThinking) {
        for (const tb of m._anthropicThinkingBlocks) {
          if (!tb || typeof tb !== 'object') continue;
          if (tb.type === 'thinking' && tb.thinking && tb.signature) {
            blocks.push({ type: 'thinking', thinking: tb.thinking, signature: tb.signature });
          } else if (tb.type === 'redacted_thinking' && tb.data) {
            blocks.push({ type: 'redacted_thinking', data: tb.data });
          }
        }
      }
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p && typeof p.text === 'string' && p.text) blocks.push({ type: 'text', text: p.text });
        }
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try {
          const parsed = typeof (tc.function && tc.function.arguments) === 'object'
            ? tc.function.arguments
            : JSON.parse((tc.function && tc.function.arguments) || '{}');
          input = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) { input = {}; }
        const rawId = tc.id || '';
        const cleanId = sanitizeToolCallId(rawId, ++idSeq);
        if (rawId) rawToCleanId.set(rawId, cleanId);
        blocks.push({ type: 'tool_use', id: cleanId, name: wireToolName((tc.function && tc.function.name) || tc.name || 'tool'), input });
      }
      if (blocks.length) pushMsg('assistant', blocks);
      continue;
    }
    // user
    if (typeof m.content === 'string') {
      if (m.content || !(m.tool_calls && m.tool_calls.length)) pushMsg('user', [{ type: 'text', text: m.content }]);
    } else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const p of m.content) {
        if (typeof p === 'string') blocks.push({ type: 'text', text: p });
        else if (p && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
        else if (p && p.type === 'image' && p.source) blocks.push(p);
        else if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          const dm = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
          if (dm) blocks.push({ type: 'image', source: { type: 'base64', media_type: dm[1], data: dm[2] } });
          else blocks.push({ type: 'image', source: { type: 'url', url: p.image_url.url } });
        }
      }
      if (blocks.length) pushMsg('user', blocks);
    }
  }

  // Anthropic invariant: every `tool_result` in a user message must match a
  // `tool_use.id` in the immediately preceding assistant message, and every
  // `tool_use` in an assistant message (followed by further turns) must have
  // a matching `tool_result` in the immediately next user message.
  const out = [];
  for (let i = 0; i < rawMsgs.length; i++) {
    const cur = { role: rawMsgs[i].role, content: rawMsgs[i].content.slice() };
    const prev = out[out.length - 1];
    const prevToolIds = new Set(
      prev && prev.role === 'assistant'
        ? prev.content.filter((b) => b && b.type === 'tool_use' && b.id).map((b) => b.id)
        : []
    );

    if (cur.role === 'user') {
      cur.content = cur.content.map((b) => {
        if (b && b.type === 'tool_result' && !prevToolIds.has(b.tool_use_id)) {
          const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content == null ? '' : b.content);
          return { type: 'text', text: '[Tool output]: ' + txt };
        }
        return b;
      });
      if (prevToolIds.size) {
        const answered = new Set(cur.content.filter((b) => b && b.type === 'tool_result').map((b) => b.tool_use_id));
        const missing = [...prevToolIds].filter((id) => !answered.has(id));
        if (missing.length) {
          cur.content = missing.map((id) => ({ type: 'tool_result', tool_use_id: id, content: '(no output)' })).concat(cur.content);
        }
      }
    } else if (prevToolIds.size) {
      out.push({
        role: 'user',
        content: [...prevToolIds].map((id) => ({ type: 'tool_result', tool_use_id: id, content: '(interrupted)' })),
      });
    }

    const last = out[out.length - 1];
    if (last && last.role === cur.role) last.content = concatDedupBlocks(last.content, cur.content);
    else if (cur.content.length) out.push(cur);
  }

  const wantMax = Number(maxTokens) > 0 ? Number(maxTokens) : 32000;
  const rLevel = String((provider && provider.reasoningLevel) || '').toLowerCase();
  const thinkingBudgets = { low: 2048, medium: 8192, high: 16384 };
  const supportsThinking = /claude-(?:opus|sonnet|haiku|fable)-[3-9]|claude-3-[57]-sonnet/i.test(String(provider && provider.model || ''));
  // Only enable Anthropic extended thinking when all prior assistant tool-use turns either don't exist
  // or carry signed thinking blocks; otherwise Anthropic rejects unsigned prior turns with 400.
  const hasUnsignedToolTurn = out.some((bm) => bm.role === 'assistant'
    && Array.isArray(bm.content)
    && bm.content.some((b) => b && b.type === 'tool_use')
    && !bm.content.some((b) => b && (b.type === 'thinking' || b.type === 'redacted_thinking')));
  const budgetTokens = (!provider._disableThinking && supportsThinking && thinkingBudgets[rLevel] && !hasUnsignedToolTurn)
    ? thinkingBudgets[rLevel]
    : 0;
  const body = {
    model: provider.model,
    max_tokens: budgetTokens ? Math.max(wantMax, budgetTokens + 4096) : wantMax,
    stream: true,
    messages: out,
  };
  if (budgetTokens) {
    body.thinking = { type: 'enabled', budget_tokens: budgetTokens };
  }
  if (systemParts.length) body.system = systemParts;
  if (tools && tools.length) {
    body.tools = tools.map((t) => {
      const fn = t.function || t;
      return {
        name: wireToolName(fn.name),
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    });
  }
  // 3-breakpoint ephemeral prompt caching for multi-turn agent loops when large
  // enough to meet Anthropic's minimum cacheable block threshold (>=1024 chars).
  try {
    if (body.tools && body.tools.length && JSON.stringify(body.tools).length >= 1024) {
      body.tools[body.tools.length - 1] = { ...body.tools[body.tools.length - 1], cache_control: { type: 'ephemeral' } };
    }
    if (body.system && body.system.length && JSON.stringify(body.system).length >= 1024) {
      body.system[body.system.length - 1] = { ...body.system[body.system.length - 1], cache_control: { type: 'ephemeral' } };
    }
    if (body.messages && body.messages.length && JSON.stringify(body.messages).length >= 1024) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const bm = body.messages[i];
        if (bm && bm.role === 'user' && Array.isArray(bm.content) && bm.content.length) {
          const lastIdx = bm.content.length - 1;
          bm.content[lastIdx] = { ...bm.content[lastIdx], cache_control: { type: 'ephemeral' } };
          break;
        }
      }
    }
  } catch (_) {}
  // Deliberately no `temperature`: the subscription path does not accept it the
  // way the public API does, and Claude Code itself never sends one.
  return body;
}

// ── Tool-name wire safety ───────────────────────────────────────────────────
// Anthropic's subscription (OAuth) endpoint rejects a tool whose name begins
// `mcp_` followed by a letter/digit, and returns a *billing* error
// ("Third-party apps now draw from your extra usage…") that says nothing about
// tools. Measured against the live endpoint:
//   mcp_probe / mcp_find_tools / mcp_a → 400      mcp__srv__tool → 200
//   MCP_probe / find_mcp_tools / mcp-1 → 200      mcp (bare)     → 200
// So `tools[].name` is sanitised on the way out and un-mapped on the way back,
// which keeps dispatch by name working and makes the class unrepeatable.
const UNSAFE_TOOL_NAME = /^mcp_[A-Za-z0-9]/;
function wireToolName(name) {
  const s = String(name || '');
  return UNSAFE_TOOL_NAME.test(s) ? 'x_' + s : s;
}
function unwireToolName(name) {
  const s = String(name || '');
  return s.startsWith('x_mcp_') ? s.slice(2) : s;
}

function anthropicFinish(stop) {
  if (stop === 'tool_use') return 'tool_calls';
  if (stop === 'max_tokens') return 'length';
  if (stop === 'refusal') return 'content_filter';
  return 'stop';
}

async function anthropicChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const base = trimBase(provider.baseURL || DEFAULT_ANTHROPIC_BASE);
  const { headers } = anthropicAuth(provider);
  const body = toAnthropicBody(provider, messages, tools, maxTokensOverride || provider.maxTokens);
  const payload = JSON.stringify(body);
  const model = String(provider.model || body.model || '');
  // Same key derivation llm.js uses to resolve the budget, so a demotion made
  // here is the number the next turn actually compacts against.
  const providerId = String(provider.oauthProvider || '').split(':')[0]
    || provider.id || provider.transport || 'anthropic';

  // 1M-token beta. Sent only when the request genuinely needs more than the
  // default 200k window and the id is one Anthropic serves at 1M. Sending it on
  // a small turn buys nothing and can trip a stricter entitlement check; not
  // sending it on a 300k-token turn guarantees a 400.
  const estTokens = catalog.tokensForChars(payload.length);
  const bigTurn = estTokens > LONG_CONTEXT_MIN_TOKENS;
  const longBeta = catalog.supportsLongContext(model) && bigTurn;
  const shortBeta = headers['anthropic-beta'] || '';
  if (longBeta) {
    headers['anthropic-beta'] = shortBeta ? (shortBeta + ',' + catalog.LONG_CONTEXT_BETA) : catalog.LONG_CONTEXT_BETA;
  }

  const connectTimeoutMs = (body.thinking || /(opus|fable|sonnet|pro)/i.test(model)) ? 180000 : 120000;
  const post = (hdrs) => fetchWithTimeout(base + '/v1/messages', {
    method: 'POST', headers: hdrs, body: payload, signal,
  }, 'anthropic', connectTimeoutMs);

  let res = await post(headers);
  const detachResAbort = (r) => {
    if (r && typeof r._cleanupAbort === 'function') {
      try { r._cleanupAbort(); } catch (_) {}
      r._cleanupAbort = null;
    }
  };
  if (!res.ok && body.thinking && res.status === 400) {
    const rejectedThink = await res.text().catch(() => '');
    detachResAbort(res);
    if (/thinking|signature|budget_tokens|redacted_thinking/i.test(rejectedThink)) {
      const noThinkBody = { ...body };
      delete noThinkBody.thinking;
      res = await fetchWithTimeout(base + '/v1/messages', {
        method: 'POST', headers, body: JSON.stringify(noThinkBody), signal,
      }, 'anthropic', connectTimeoutMs);
    } else {
      throw httpError('anthropic', res, rejectedThink);
    }
  }
  if (!res.ok && bigTurn && res.status === 400) {
    const rejected = await res.text().catch(() => '');
    detachResAbort(res);
    // The endpoint refused a turn sized for a window larger than the default.
    // Either the beta is not entitled, or the model does not really serve the
    // 1M its catalog advertises for this account. Retrying the identical request
    // is useless, so drop the beta, record the honest window for the session,
    // and send once more — the agent loop then compacts against a real ceiling.
    if (/context|beta|long|1m|entitle|not available|too long|prompt is too/i.test(rejected)) {
      catalog.demote(providerId, model, catalog.SHORT_CONTEXT_WINDOW);
      const retryHeaders = { ...headers, 'anthropic-beta': shortBeta };
      res = await post(retryHeaders);
    } else {
      throw httpError('anthropic', res, rejected);
    }
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    detachResAbort(res);
    // Opt-in forensic dump: when a subscription turn is rejected it is usually
    // the *shape* of the request, not the credential, so keep the exact payload
    // that was refused (never the headers — they carry the bearer token).
    if (process.env.AUTOBOT_REQDUMP) {
      try {
        const fs = require('fs');
        const path = require('path');
        const dir = process.env.AUTOBOT_REQDUMP;
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.writeFileSync(path.join(dir, 'req-' + stamp + '.json'), payload);
        fs.writeFileSync(path.join(dir, 'req-' + stamp + '.meta.json'), JSON.stringify({
          status: res.status,
          model,
          maxTokens: body.max_tokens,
          stream: body.stream,
          tools: body.tools ? body.tools.length : 0,
          system: (body.system || []).map((b) => ({
            chars: String(b.text || '').length,
            head: String(b.text || '').slice(0, 120),
          })),
          beta: headers['anthropic-beta'],
          ua: headers['user-agent'],
          xapp: headers['x-app'],
          // Which credential was actually sent, fingerprinted rather than
          // stored: comparing sha12/len against the account store is how a
          // "the token works everywhere except in the app" bug gets pinned
          // without ever writing a bearer token to disk.
          auth: (() => {
            const tok = String(provider.accessToken || provider.apiKey || '');
            return {
              source: provider.accessToken ? 'accessToken' : (provider.apiKey ? 'apiKey' : 'none'),
              len: tok.length,
              sha12: require('crypto').createHash('sha256').update(tok).digest('hex').slice(0, 12),
            };
          })(),
          provider: {
            oauthProvider: provider.oauthProvider || '',
            account: provider.account || '',
            transport: provider.transport || '',
            model: provider.model || '',
            oauth: !!provider.oauth,
            tokenLen: String(provider.accessToken || '').length,
            apiKeyLen: String(provider.apiKey || '').length,
          },
          bodyModel: body.model,
          bodyChars: payload.length,
          rejected: errText.slice(0, 800),
        }, null, 2));
      } catch (_) { /* dumping must never mask the real error */ }
    }
    const err = httpError('anthropic', res, errText);
    // A subscription window that is genuinely spent is not a blip: retrying five
    // times only delays the answer. Read the real allowance and stop the ladder.
    if (err.status === 429) {
      const hint = await claudeAllowanceHint(provider);
      if (hint) {
        err.hint = hint;
        if (/ 100% used/.test(hint)) err.retryHopeless = true;
      }
      // Anthropic answers a long-context request that the plan allowance does
      // not cover with `429 rate_limit_error: "Usage credits are required for
      // long context requests"`. No plan window will satisfy that, so the five
      // backoff rounds only burn ~40 s before printing the same sentence. Say it
      // once, in prose, and name the way out.
      if (/usage credits|credits? (?:are|is) required/i.test(err.body || errText)) {
        err.hint = 'Long context needs usage credits on this account — the plan allowance does not cover a request this large. Send a shorter conversation, or pick a model whose window fits it';
        err.retryHopeless = true;
      }
    }
    throw err;
  }

  const message = { role: 'assistant', content: '', tool_calls: [] };

  // Classify by the body, not only the header: some backends stream SSE with no
  // content-type. `openStream` peeks one chunk and replays it.
  const opened = await openStream(res, signal);
  if (opened.empty) { message.finish_reason = 'stop'; return message; }
  if (!opened.isSse) {
    // A proxy collapsed the stream back to one JSON body.
    const text = await new Response(opened.stream).text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    if (data && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') { message.content += block.text || ''; if (block.text) onDelta(block.text); }
        else if (block.type === 'tool_use') {
          const acc = newToolAcc(block.id, block.name);
          acc.function.arguments = JSON.stringify(block.input || {});
          message.tool_calls.push(acc);
          if (onToolDelta && acc.function.name) onToolDelta(toolDeltaPayload(acc));
        }
      }
    }
    message.finish_reason = anthropicFinish(data && data.stop_reason);
    if (data && data.model) message.model = String(data.model);
    if (data && data.usage) message.usage = usageEstimator.normalizeCallUsage(data.usage) || data.usage;
    if (!message.model) message.model = String(provider.model || '');
    return message;
  }

  const accs = new Map(); // block index -> tool acc
  const thinkBlocks = new Map(); // block index -> { type, thinking, signature, data }
  let rawUsage = null;
  for await (const ev of sseEvents(opened.stream)) {
    const type = ev.type;
    if (type === 'content_block_start') {
      const block = ev.content_block || {};
      if (block.type === 'tool_use') {
        const acc = newToolAcc(block.id, block.name);
        accs.set(ev.index, acc);
        message.tool_calls.push(acc);
        if (onToolDelta) onToolDelta(toolDeltaPayload(acc));
      } else if (block.type === 'thinking') {
        thinkBlocks.set(ev.index, { type: 'thinking', thinking: block.thinking || '', signature: block.signature || '' });
      } else if (block.type === 'redacted_thinking' && block.data) {
        thinkBlocks.set(ev.index, { type: 'redacted_thinking', data: block.data });
      }
    } else if (type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        message.content += d.text;
        onDelta(d.text);
      } else if (d.type === 'thinking_delta' && d.thinking) {
        const tb = thinkBlocks.get(ev.index);
        if (tb && tb.type === 'thinking') tb.thinking += d.thinking;
        onDelta(d.thinking, true);
      } else if (d.type === 'signature_delta' && d.signature) {
        const tb = thinkBlocks.get(ev.index);
        if (tb && tb.type === 'thinking') tb.signature += d.signature;
      } else if (d.type === 'input_json_delta') {
        const acc = accs.get(ev.index);
        if (acc) {
          pushToolArg(acc, d.partial_json);
          if (onToolDelta) onToolDelta(toolDeltaPayload(acc));
        }
      }
    } else if (type === 'message_delta') {
      const d = ev.delta || {};
      if (d.stop_reason) message.finish_reason = anthropicFinish(d.stop_reason);
      if (ev.usage) rawUsage = usageEstimator.mergeUsageObjects(rawUsage, ev.usage);
    } else if (type === 'message_start') {
      if (ev.message && ev.message.model) message.model = String(ev.message.model);
      if (ev.message && ev.message.usage) rawUsage = usageEstimator.mergeUsageObjects(rawUsage, ev.message.usage);
    } else if (type === 'error') {
      const e = ev.error || {};
      const err = new Error('LLM ' + (e.type || 'error') + ': ' + (e.message || 'provider error'));
      err.transient = e.type === 'overloaded_error' || e.type === 'api_error';
      throw err;
    }
  }
  if (rawUsage) {
    message.usage = usageEstimator.normalizeCallUsage(rawUsage) || rawUsage;
  }
  if (thinkBlocks.size) {
    message._anthropicThinkingBlocks = [...thinkBlocks.values()].filter((tb) => (tb.type === 'thinking' && tb.thinking && tb.signature) || (tb.type === 'redacted_thinking' && tb.data));
  }
  if (!message.finish_reason) message.finish_reason = message.tool_calls.length ? 'tool_calls' : 'stop';
  if (!message.model) message.model = String(provider.model || '');
  return message;
}

// ---------------------------------------------------------------------------
// OpenAI Codex `responses` — the ChatGPT subscription backend
//
// NOT field-verified (no ChatGPT-Plus credential on this machine). Built from
// the documented `responses` event vocabulary; the wire shape is pinned by
// test/providertransport.test.js so a regression is a failing test, not a
// silent empty reply.
// ---------------------------------------------------------------------------
function toCodexInput(messages) {
  const instructions = [];
  const input = [];
  const emittedCallIds = new Set();
  const rawToCleanId = new Map();
  let callSeq = 0;

  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string' && m.content) instructions.push(m.content);
      continue;
    }
    if (role === 'tool') {
      const rawId = m.tool_call_id || m.toolCallId || '';
      const cleanId = rawId ? (rawToCleanId.get(rawId) || sanitizeToolCallId(rawId, ++callSeq)) : '';
      const output = typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content);
      if (cleanId && emittedCallIds.has(cleanId)) {
        input.push({
          type: 'function_call_output',
          call_id: cleanId,
          output,
        });
      } else {
        input.push({
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '[Tool output]: ' + output }],
        });
      }
      continue;
    }
    if (role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const txt = m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
        if (txt) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: txt }] });
      }
      for (const tc of m.tool_calls || []) {
        const rawId = tc.id || '';
        const cleanId = sanitizeToolCallId(rawId, ++callSeq);
        if (rawId) rawToCleanId.set(rawId, cleanId);
        emittedCallIds.add(cleanId);
        const argsStr = typeof (tc.function && tc.function.arguments) === 'string'
          ? tc.function.arguments
          : JSON.stringify((tc.function && tc.function.arguments) || {});
        input.push({
          type: 'function_call',
          name: (tc.function && tc.function.name) || tc.name || 'tool',
          arguments: argsStr || '{}',
          call_id: cleanId,
        });
      }
      continue;
    }
    if (typeof m.content === 'string') {
      if (m.content) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: m.content }] });
    } else if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) {
        if (typeof p === 'string' && p) parts.push({ type: 'input_text', text: p });
        else if (p && typeof p.text === 'string' && p.text) parts.push({ type: 'input_text', text: p.text });
        else if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          parts.push({ type: 'input_image', image_url: p.image_url.url });
        }
      }
      if (parts.length) input.push({ type: 'message', role: 'user', content: parts });
    }
  }
  return { instructions: instructions.join('\n\n'), input };
}

function toCodexTools(tools) {
  return (tools || []).map((t) => {
    const fn = t.function || t;
    return {
      type: 'function',
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} },
      strict: false,
    };
  });
}

function codexReasoning(level) {
  if (level === 'low' || level === 'medium' || level === 'high' || level === 'xhigh') return { effort: level, summary: 'auto' };
  return { effort: 'medium', summary: 'auto' };
}

/**
 * Shared `responses` runner. Both the Codex subscription backend and the Grok
 * CLI proxy speak this event vocabulary, so the SSE absorb loop lives once and
 * only the URL/headers/body differ. Returns the internal message shape.
 */
async function responsesChat(o) {
  const label = o.label || 'codex';
  const onDelta = o.onDelta || (() => {});
  const onToolDelta = o.onToolDelta || null;
  const mId = String((o.body && o.body.model) || '');
  const connectTimeoutMs = ((o.body && o.body.reasoning) || /(gpt-[5-9]|o[1-9]|codex|grok-[3-9])/i.test(mId)) ? 180000 : 120000;
  const res = o.fetchImpl
    ? await o.fetchImpl(o.url, { method: 'POST', headers: o.headers, body: JSON.stringify(o.body), signal: o.signal })
    : await fetchWithTimeout(o.url, { method: 'POST', headers: o.headers, body: JSON.stringify(o.body), signal: o.signal }, label, connectTimeoutMs);
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    if (res._cleanupAbort) { try { res._cleanupAbort(); } catch (_) {} res._cleanupAbort = null; }
    throw httpError(label, res, errTxt);
  }

  const opened = await openStream(res, o.signal);

  const message = { role: 'assistant', content: '', tool_calls: [] };
  const byItem = new Map(); // output item id -> tool acc
  const byCall = new Map(); // call id -> tool acc (stream and final body can both report it)

  const addCall = (callId, name) => {
    const id = String(callId || '');
    if (id && byCall.has(id)) return byCall.get(id);
    const acc = newToolAcc(callId, name);
    if (id) byCall.set(id, acc);
    message.tool_calls.push(acc);
    return acc;
  };

  const absorb = (resp) => {
    if (!resp) return;
    if (resp.usage) {
      message.usage = {
        input_tokens: num(resp.usage.input_tokens),
        output_tokens: num(resp.usage.output_tokens),
        total_tokens: num(resp.usage.total_tokens) ||
          num(resp.usage.input_tokens) + num(resp.usage.output_tokens),
      };
    }
    for (const item of resp.output || []) {
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const c of item.content) {
          if (c && typeof c.text === 'string' && c.text && !message.content.includes(c.text)) {
            message.content += c.text;
          }
        }
      }
      if (item.type === 'function_call') {
        // The final body repeats what the stream already delivered — reuse the
        // accumulator instead of running the same tool twice.
        const acc = byCall.get(String(item.call_id || item.id || '')) || addCall(item.call_id || item.id, item.name);
        if (typeof item.arguments === 'string' && item.arguments) acc.function.arguments = item.arguments;
        if (item.name && !acc.function.name) acc.function.name = item.name;
        if (item.call_id) acc.id = item.call_id;
        if (onToolDelta && acc.function.name) onToolDelta(toolDeltaPayload(acc));
      }
    }
    if (resp.model) message.model = String(resp.model);
    if (resp.status === 'incomplete') message.finish_reason = 'length';
  };

  const finish = () => {
    if (!message.finish_reason) message.finish_reason = message.tool_calls.length ? 'tool_calls' : 'stop';
    if (!message.model && o && o.body && o.body.model) message.model = String(o.body.model);
    return message;
  };

  if (opened.empty) return finish();

  if (!opened.isSse) {
    const rawText = await new Response(opened.stream).text().catch(() => '');
    let data = null;
    try { data = rawText ? JSON.parse(rawText) : null; } catch (_) { data = null; }
    absorb(data);
    if (!message.content) {
      for (const item of (data && data.output) || []) {
        if (item.type === 'message') {
          for (const c of item.content || []) if (c.text) { message.content += c.text; onDelta(c.text); }
        }
      }
    }
    return finish();
  }

  for await (const ev of sseEvents(opened.stream)) {
    const type = ev.type || '';
    if (type === 'response.output_text.delta') {
      if (ev.delta) { message.content += ev.delta; onDelta(ev.delta); }
    } else if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
      if (ev.delta) onDelta(ev.delta, true);
    } else if (type === 'response.output_item.added') {
      const item = ev.item || {};
      if (item.type === 'function_call') {
        const acc = addCall(item.call_id || item.id, item.name);
        if (item.id) byItem.set(item.id, acc);
        if (onToolDelta) onToolDelta(toolDeltaPayload(acc));
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const acc = byItem.get(ev.item_id);
      if (acc) {
        pushToolArg(acc, ev.delta);
        if (onToolDelta) onToolDelta(toolDeltaPayload(acc));
      }
    } else if (type === 'response.function_call_arguments.done') {
      const acc = byItem.get(ev.item_id);
      if (acc && typeof ev.arguments === 'string' && ev.arguments) acc.function.arguments = ev.arguments;
    } else if (type === 'response.output_item.done') {
      const item = ev.item || {};
      const acc = byItem.get(item.id) || byCall.get(String(item.call_id || ''));
      if (acc) {
        if (item.name && !acc.function.name) acc.function.name = item.name;
        if (item.call_id) acc.id = item.call_id;
        // A complete `arguments` string on the item is authoritative.
        if (typeof item.arguments === 'string' && item.arguments) acc.function.arguments = item.arguments;
      }
    } else if (type === 'response.completed' || type === 'response.done' || type === 'response.incomplete') {
      absorb(ev.response);
    } else if (type === 'response.failed' || type === 'response.error') {
      const r = ev.response || ev;
      const e = (r && r.error) || {};
      const err = new Error('LLM ' + label + ': ' + (e.message || 'the response failed'));
      err.transient = true;
      throw err;
    }
  }
  return finish();
}

async function codexChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const apiKey = assertOfficialApiKey(provider, ['OPENAI_API_KEY'], 'openai');
  const { instructions, input } = toCodexInput(messages);
  const body = {
    model: provider.model,
    instructions: instructions || 'You are a helpful assistant.',
    input,
    tools: toCodexTools(tools),
    tool_choice: 'auto',
    parallel_tool_calls: true,
    reasoning: codexReasoning(provider.reasoningLevel),
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
  };
  const maxOut = Number(maxTokensOverride || provider.maxTokens) > 0
    ? Number(maxTokensOverride || provider.maxTokens)
    : 0;
  if (maxOut) body.max_output_tokens = maxOut;
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: 'Bearer ' + apiKey,
    'user-agent': OFFICIAL_USER_AGENT,
  };
  const base = trimBase(provider.baseURL || DEFAULT_OPENAI_BASE);
  const url = /\/responses$/.test(base) ? base : base + '/responses';

  return responsesChat({
    label: 'openai',
    url,
    headers,
    body,
    onDelta,
    onToolDelta,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Google Antigravity — `daily-cloudcode-pa.googleapis.com/v1internal`
//
// Field-verified live against a real Antigravity consumer grant:
//   * `:fetchAvailableModels` returns 38 models with per-model `maxTokens`
//     (context window) and `supportsThinking`.
//   * `:streamGenerateContent?alt=sse` answers text and `functionCall` parts
//     for Gemini and Vertex-Claude models alike.
// The transport is plain HTTPS — the desktop app's bundled 188 MB Go
// `language_server` is NOT required (it only proxies to this same endpoint).
// ---------------------------------------------------------------------------
function toGeminiContents(messages, model) {
  const systemParts = [];
  const contents = [];
  const callNamesById = new Map();
  const rawToCleanId = new Map();
  let callSeq = 0;
  const isGeminiThoughtModel = /^gemini-(?:2\.5|[3-9])/i.test(String(model || '')) || /thinking/i.test(String(model || ''));

  const pushPart = (role, part) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      const prev = last.parts[last.parts.length - 1];
      if (prev && typeof prev.text === 'string' && !prev.thought && part && typeof part.text === 'string' && !part.thought && Object.keys(prev).length === 1 && Object.keys(part).length === 1) {
        const sep = /\s$/.test(prev.text) || /^\s/.test(part.text) ? '' : '\n\n';
        prev.text = prev.text + sep + part.text;
        return;
      }
      last.parts.push(part);
    } else {
      contents.push({ role, parts: [part] });
    }
  };
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string' && m.content) systemParts.push({ text: m.content });
      continue;
    }
    if (role === 'tool') {
      const rawId = m.tool_call_id || m.toolCallId || '';
      const id = rawId ? (rawToCleanId.get(rawId) || sanitizeToolCallId(rawId, ++callSeq)) : '';
      const fnName = m.tool_name || m.name || (id && callNamesById.get(id)) || 'tool';
      pushPart('user', {
        functionResponse: {
          ...(id ? { id } : {}),
          name: fnName,
          response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content) },
        },
      });
      continue;
    }
    if (role === 'assistant') {
      if (typeof m.content === 'string' && m.content) pushPart('model', { text: m.content });
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (typeof p === 'string' && p) pushPart('model', { text: p });
          else if (p && typeof p.text === 'string' && p.text) pushPart('model', { text: p.text });
        }
      }
      for (const tc of m.tool_calls || []) {
        let args = {};
        try {
          const parsed = typeof (tc.function && tc.function.arguments) === 'object'
            ? tc.function.arguments
            : JSON.parse((tc.function && tc.function.arguments) || '{}');
          args = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch (_) { args = {}; }
        const rawId = tc.id || '';
        const id = sanitizeToolCallId(rawId, ++callSeq);
        if (rawId) rawToCleanId.set(rawId, id);
        const fnName = (tc.function && tc.function.name) || tc.name || 'tool';
        callNamesById.set(id, fnName);
        const fcPart = { functionCall: { id, name: fnName, args } };
        const sig = tc.thoughtSignature || tc.thought_signature || (isGeminiThoughtModel ? 'skip_thought_signature_validator' : '');
        if (sig) fcPart.thoughtSignature = sig;
        pushPart('model', fcPart);
      }
      continue;
    }
    if (typeof m.content === 'string') {
      if (m.content) pushPart('user', { text: m.content });
    } else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (typeof p === 'string' && p) pushPart('user', { text: p });
        else if (p && typeof p.text === 'string' && p.text) pushPart('user', { text: p.text });
        else if (p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string') {
          const dm = /^data:([^;]+);base64,(.+)$/.exec(p.image_url.url);
          if (dm) pushPart('user', { inlineData: { mimeType: dm[1], data: dm[2] } });
        }
      }
    }
  }
  return { systemParts, contents };
}

function geminiFinish(reason) {
  if (!reason) return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (/^(?:SAFETY|RECITATION|PROHIBITED_CONTENT|BLOCKLIST|SPII|IMAGE_SAFETY|MODEL_ARMOR)$/i.test(String(reason))) {
    return 'content_filter';
  }
  return 'stop';
}

// Antigravity's own Cloud Code deployment issues per-model context windows
// (`maxTokens`, verified live: 1 048 576 for Gemini, 1 000 000 for the Vertex
// Claude models) and thinking capability flags. This is the authoritative
// catalog — no hardcoded table needed, and it tracks new models automatically.
// Antigravity's catalog is half marketing copy ("Gemini 4 Neon (High)") and
// half bare slugs ("gemini-3.8-flash-tiered"), and it also enumerates the
// editor's *internal* tab-completion models (`tab_*_preview`, 16K window).
// A chat-model picker that shows those mixes two naming styles and offers
// completion models as if they were chat models. Prettify the slug-only rows
// and drop the internal ones.
function prettyModelId(id) {
  const s = String(id || '');
  if (!s) return s;
  // Tokens the vendor itself upper-cases; title-casing them reads as a typo.
  const ABBR = { xhigh: 'XHigh', oss: 'OSS', gpt: 'GPT', api: 'API', agy: 'AGY', pro: 'Pro', xl: 'XL' };
  // Reasoning levels are a parenthesised suffix in the vendor's own naming
  // ("Claude Opus 5.5 (High)"), so a slug's trailing level should read the same
  // way instead of landing as a bare word beside its neighbours.
  const LEVELS = new Set(['high', 'xhigh', 'medium', 'low', 'minimal', 'thinking', 'orchestrator']);
  const words = [];
  for (const tok of s.split(/[-_]+/).filter(Boolean)) {
    const low = tok.toLowerCase();
    let w;
    if (ABBR[low]) w = ABBR[low];
    // "120b" / "3b" — keep the number, upper-case the size suffix (120B, 3B).
    else if (/^[0-9]+(\.[0-9]+)*[a-z]+$/.test(tok)) w = tok.replace(/^([0-9.]+)([a-z]+)$/, (m, a, b) => a + b.toUpperCase());
    else if (/^[0-9]+(\.[0-9]+)*$/.test(tok)) w = tok;
    else w = tok.charAt(0).toUpperCase() + tok.slice(1);
    // "claude-sonnet-5-5-medium" is version 5.5, not version 5 word 5.
    const prev = words[words.length - 1];
    if (/^[0-9]$/.test(w) && prev && /^[0-9]$/.test(prev)) { words[words.length - 1] = prev + '.' + w; continue; }
    words.push(w);
  }
  const last = words[words.length - 1];
  if (words.length > 1 && last && LEVELS.has(last.toLowerCase())) {
    return words.slice(0, -1).join(' ') + ' (' + last + ')';
  }
  return words.join(' ');
}

// Ids that exist only to serve the editor's inline completion, not chat.
function isInternalAntigravityModel(id) {
  return /^tab_/i.test(String(id || '')) || /_preview$/i.test(String(id || ''));
}

function googleModelList(json) {
  const models = (json && json.models) || {};
  const out = [];
  const variantGroups = new Map(); // baseSlug -> { low?: id, medium?: id, high?: id, xhigh?: id, minimal?: id }
  for (const [id, m] of Object.entries(models)) {
    if (!m || typeof m !== 'object') continue;
    if (isInternalAntigravityModel(id)) continue;
    const vMatch = /^(.*)-(minimal|low|medium|high|xhigh)$/i.exec(id);
    if (vMatch) {
      const baseSlug = vMatch[1].toLowerCase();
      const tierKey = vMatch[2].toLowerCase();
      const map = variantGroups.get(baseSlug) || {};
      map[tierKey] = id;
      variantGroups.set(baseSlug, map);
    }
    const prov = String(m.apiProvider || '');
    const display = String(m.displayName || '').trim();
    // A displayName that is byte-identical to the id is not a friendly name —
    // fall back to the prettified slug so every row reads the same way.
    const label = display && display !== id ? display : prettyModelId(id);
    out.push({
      id,
      label,
      contextWindow: num(m.maxTokens),
      maxOutput: num(m.maxOutputTokens),
      thinking: !!m.supportsThinking,
      image: !!m.supportsImages,
      video: !!m.supportsVideo,
      recommended: !!m.recommended,
      tag: String(m.tagTitle || ''),
      tagDescription: String(m.tagDescription || ''),
      group: prov.indexOf('ANTHROPIC') !== -1 ? 'Claude' : (prov.indexOf('GOOGLE') !== -1 ? 'Gemini' : prov),
      apiProvider: prov,
    });
  }
  const LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  for (const item of out) {
    const vMatch = /^(.*)-(minimal|low|medium|high|xhigh)$/i.exec(item.id);
    const baseSlug = vMatch ? vMatch[1].toLowerCase() : item.id.toLowerCase();
    const sibs = variantGroups.get(baseSlug);
    if (sibs && Object.keys(sibs).length > 1) {
      item.thinkingVariants = { ...sibs };
      item.thinkingLevels = ['auto', ...LEVEL_ORDER.filter((lv) => sibs[lv])];
      item.thinking = true;
    } else if (item.thinking) {
      item.thinkingLevels = ['auto', 'low', 'medium', 'high'];
    } else {
      item.thinkingLevels = [];
    }
  }
  // Antigravity ships several models with an identical displayName (four are
  // all "Gemini 3.5 Flash Lite"), so a raw catalog would render
  // indistinguishable rows. For a colliding name, drop the vendor name and use
  // the prettified id as the label — it is the accurate name and reads the same
  // as its neighbours. The exact id stays in the row title for reference.
  const seen = new Map();
  for (const m of out) seen.set(m.label, (seen.get(m.label) || 0) + 1);
  for (const m of out) if (seen.get(m.label) > 1) m.label = prettyModelId(m.id);
  // Two ids can prettify to one label (separator-only differences); keep rows
  // unique by falling back to the raw id for the stragglers.
  const dup = new Map();
  for (const m of out) dup.set(m.label, (dup.get(m.label) || 0) + 1);
  for (const m of out) if (dup.get(m.label) > 1) m.label = m.label + ' · ' + m.id;
  const rank = (m) => (m.group === 'Gemini' ? 0 : 1);
  out.sort((a, b) => (rank(a) - rank(b)) || a.label.localeCompare(b.label, 'en'));
  return out;
}

async function googleModels(provider, signal) {
  const apiKey = assertOfficialApiKey(provider, ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], 'google');
  const base = trimBase(provider.baseURL || DEFAULT_GEMINI_BASE);
  const res = await fetch(base + '/models', {
    method: 'GET',
    headers: {
      accept: 'application/json',
      'x-goog-api-key': apiKey,
      'user-agent': OFFICIAL_USER_AGENT,
    },
    signal,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw httpError('google', res, text);
  let json = null;
  try { json = JSON.parse(text); } catch (_) { return []; }
  const rawModels = Array.isArray(json && json.models) ? json.models : [];
  if (rawModels.length) {
    return rawModels.map((m) => {
      const id = String(m.name || m.id || '').replace(/^models\//, '');
      const cap = num(m.inputTokenLimit || m.contextWindow || m.maxTokens);
      const thinks = /^gemini-(?:2\.5|[3-9])/i.test(id) || /thinking/i.test(id);
      return {
        id,
        label: String(m.displayName || id),
        contextWindow: cap,
        thinking: thinks,
        thinkingLevels: thinks ? ['auto', 'low', 'medium', 'high'] : [],
        group: 'Gemini',
      };
    }).filter((m) => m.id);
  }
  return googleModelList(json || {});
}

// ── Gemini function declarations ───────────────────────────────────────────
// `tools[].functionDeclarations[].parameters` on the Cloud Code endpoint is an
// OpenAPI 3.0 *subset*, not JSON Schema. Anything outside that subset makes the
// whole request fail with 400 INVALID_ARGUMENT *after* it parses — reported as
// `value.enum[0]: ...` / `value.required[13]: ...` with no tool name attached,
// which is exactly the error that used to kill every Antigravity turn. The
// lowering below is deliberately lossy for the model but lossless for dispatch:
// tool arguments are validated on our side, so dropping a schema keyword never
// makes a call uncallable.
const GEMINI_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
const GEMINI_BOUNDS = ['minimum', 'maximum', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];
// Gemini matches declaration names against this before it validates anything
// else in the schema.
const GEMINI_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function geminiEnumValue(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (_) { return ''; }
  }
  // Gemini only models string enums: `type: 'boolean'` with `enum: [true]`
  // (and numeric enums) are rejected outright.
  return String(v);
}

function toGeminiSchema(schema, depth) {
  const d = depth || 0;
  if (d > 8) return {};
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return {};

  // Unions: Gemini has no anyOf/oneOf. Keep the branch that carries the shape
  // and remember a null branch as `nullable` instead of a second type.
  let nullable = schema.nullable === true;
  for (const key of ['anyOf', 'oneOf', 'allOf']) {
    const branches = Array.isArray(schema[key]) ? schema[key] : null;
    if (!branches || !branches.length) continue;
    const isNull = (b) => b && (b.type === 'null' || (Array.isArray(b.type) && b.type.includes('null')));
    if (branches.some(isNull)) nullable = true;
    const typed = branches.filter((b) => b && typeof b === 'object' && b.type !== 'null');
    if (typed.length > 1 && typed.every((b) => Array.isArray(b.enum))) {
      const vals = [];
      for (const b of typed) for (const v of b.enum) { const s = geminiEnumValue(v); if (!vals.includes(s)) vals.push(s); }
      const merged = { type: 'string' };
      if (vals.length) merged.enum = vals;
      if (nullable) merged.nullable = true;
      return merged;
    }
    const out = toGeminiSchema(typed[0] || branches[0], d + 1);
    if (nullable) out.nullable = true;
    return out;
  }

  // A JSON-Schema `type` may be an array (`['string','object']`, `['string','null']`).
  let type = Array.isArray(schema.type)
    ? schema.type.find((t) => t && t !== 'null')
    : schema.type;
  if (Array.isArray(schema.type) && schema.type.includes('null')) nullable = true;
  if (!type && schema.properties) type = 'object';
  if (!type && schema.items) type = 'array';
  if (!type && Array.isArray(schema.enum) && schema.enum.length) type = 'string';
  const enumVals = Array.isArray(schema.enum) && schema.enum.length
    ? [...new Set(schema.enum.map(geminiEnumValue))]
    : null;
  if (enumVals) type = 'string';
  if (!GEMINI_TYPES.has(type)) type = undefined;

  const out = {};
  if (type) out.type = type;
  if (nullable) out.nullable = true;
  if (enumVals && enumVals.length) out.enum = enumVals;
  if (typeof schema.description === 'string' && schema.description.trim()) {
    out.description = schema.description.trim().slice(0, 900);
  }

  if (out.type === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (props) {
      const lowered = {};
      for (const [k, v] of Object.entries(props)) lowered[k] = toGeminiSchema(v, d + 1);
      if (Object.keys(lowered).length) {
        out.properties = lowered;
        // `required` must name a property that actually survived the lowering —
        // Gemini 400s the whole request on one stale entry.
        const req = Array.isArray(schema.required)
          ? schema.required.filter((k) => typeof k === 'string' && lowered[k])
          : [];
        if (req.length) out.required = req;
      }
    }
  } else if (out.type === 'array') {
    out.items = toGeminiSchema(schema.items || {}, d + 1);
  }
  for (const k of GEMINI_BOUNDS) {
    if (typeof schema[k] === 'number' && Number.isFinite(schema[k])) out[k] = schema[k];
  }
  return out;
}

// One advertised tool → one Gemini declaration, or null when the name cannot be
// represented (a 400 for the whole request is worse than losing one tool).
function toGeminiDeclarations(tools) {
  const out = [];
  const seen = new Set();
  for (const t of tools || []) {
    const fn = (t && (t.function || t)) || null;
    const name = String((fn && fn.name) || '');
    if (!GEMINI_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      description: String((fn.description) || '').replace(/\s+/g, ' ').trim().slice(0, 900),
      parameters: toGeminiSchema(fn.parameters || { type: 'object', properties: {} }),
    });
  }
  return out;
}

async function googleChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const apiKey = assertOfficialApiKey(provider, ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], 'google');
  const { systemParts, contents } = toGeminiContents(messages, provider && provider.model);
  const want = Number(maxTokensOverride || provider.maxTokens) > 0
    ? Number(maxTokensOverride || provider.maxTokens) : 32000;
  const generationConfig = { maxOutputTokens: want };
  const rLevel = String((provider && provider.reasoningLevel) || '').toLowerCase();
  const modelStr = String((provider && provider.model) || '');
  const geminiThinkingBudgets = { low: 2048, medium: 8192, high: 24576 };
  const isGeminiThinkingCapable = /^gemini-(?:2\.5|[3-9])/i.test(modelStr) && !/-(?:low|medium|high|xhigh)$/i.test(modelStr);
  if (!provider._disableThinking && isGeminiThinkingCapable && geminiThinkingBudgets[rLevel]) {
    generationConfig.thinkingConfig = { includeThoughts: true, thinkingBudget: geminiThinkingBudgets[rLevel] };
  }
  const request = { contents, generationConfig };
  if (systemParts.length) request.systemInstruction = { parts: systemParts };
  if (tools && tools.length) {
    const declarations = toGeminiDeclarations(tools);
    if (declarations.length) request.tools = [{ functionDeclarations: declarations }];
  }
  const base = trimBase(provider.baseURL || DEFAULT_GEMINI_BASE).replace(/\/openai$/, '');
  const modelPath = encodeURIComponent(modelStr.replace(/^models\//, ''));
  const endpointUrl = `${base}/models/${modelPath}:streamGenerateContent?alt=sse`;
  const isSlowThinkingModel = !!(generationConfig.thinkingConfig || /(carbon|neon|opus|fable|sonnet|pro|gemini-(?:2\.5|[3-9]))/i.test(modelStr));
  const connectTimeoutMs = isSlowThinkingModel ? 180000 : 120000;
  const postGoogle = (payloadObj) => fetchWithTimeout(endpointUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'x-goog-api-key': apiKey,
      'user-agent': OFFICIAL_USER_AGENT,
    },
    body: JSON.stringify(payloadObj),
    signal,
  }, 'google', connectTimeoutMs);

  let res = await postGoogle(request);
  const detachGoogleAbort = (r) => {
    if (r && typeof r._cleanupAbort === 'function') {
      try { r._cleanupAbort(); } catch (_) {}
      r._cleanupAbort = null;
    }
  };
  if (!res.ok && generationConfig.thinkingConfig && res.status === 400) {
    const errBody = await res.text().catch(() => '');
    detachGoogleAbort(res);
    if (/thinking|thinkingConfig|thinking_budget/i.test(errBody)) {
      const strippedReq = { ...request, generationConfig: { maxOutputTokens: want } };
      res = await postGoogle(strippedReq);
    } else {
      throw httpError('google', res, errBody);
    }
  }
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    detachGoogleAbort(res);
    throw httpError('google', res, errBody);
  }

  const message = { role: 'assistant', content: '', tool_calls: [] };
  let callSeq = 0;
  const absorb = (resp) => {
    if (!resp) return;
    if (resp.modelVersion) message.model = String(resp.modelVersion);
    if (resp.promptFeedback && resp.promptFeedback.blockReason) {
      message.finish_reason = 'content_filter';
    }
    const cand = (resp.candidates || [])[0];
    if (cand) {
      for (const part of (cand.content && cand.content.parts) || []) {
        // Thinking parts carry `thought: true`. Route them through onDelta(text, true)
        // so the UI ThinkBlock streams live without splicing into visible prose.
        if (part.thought) {
          if (typeof part.text === 'string' && part.text) onDelta(part.text, true);
          continue;
        }
        if (typeof part.text === 'string' && part.text) {
          message.content += part.text;
          onDelta(part.text);
        }
        const fc = part.functionCall;
        if (fc) {
          callSeq += 1;
          const name = fc.name || '';
          const acc = newToolAcc(fc.id || ('call_' + callSeq + '_' + name), name);
          acc.function.arguments = JSON.stringify(fc.args || {});
          if (part.thoughtSignature) acc.thoughtSignature = part.thoughtSignature;
          message.tool_calls.push(acc);
          if (onToolDelta) onToolDelta(toolDeltaPayload(acc));
        }
      }
      if (cand.finishReason) message.finish_reason = geminiFinish(cand.finishReason);
    }
    if (resp.usageMetadata) {
      const u = resp.usageMetadata;
      message.usage = {
        input_tokens: num(u.promptTokenCount),
        output_tokens: num(u.candidatesTokenCount),
        total_tokens: num(u.totalTokenCount),
      };
      // Thinking tokens are billed and consumed from the context budget but are
      // not part of `candidatesTokenCount`; keep the visible count honest.
      if (num(u.thoughtsTokenCount) > 0) message.usage.reasoning_tokens = num(u.thoughtsTokenCount);
    }
  };

  // Gemini reports `STOP` even when the turn ends in a functionCall, so a
  // pending tool call always wins: the agent loop decides what to do next from
  // `tool_calls.length`, and a `stop` here would end the run early.
  const settle = () => {
    if (message.tool_calls.length && (!message.finish_reason || message.finish_reason === 'stop')) {
      message.finish_reason = 'tool_calls';
    } else if (!message.tool_calls.length && /^(?:This request was blocked by (?:Gemini's|Google's) (?:filters|safety)|I cannot fulfill this request due to safety)/i.test(String(message.content || '').trim())) {
      message.finish_reason = 'content_filter';
    } else if (!message.finish_reason) {
      message.finish_reason = 'stop';
    }
    if (!message.model) message.model = String(provider.model || '');
    return message;
  };
  const opened = await openStream(res, signal);
  if (opened.empty) return settle();
  if (!opened.isSse) {
    const text = await new Response(opened.stream).text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
    absorb(data);
    return settle();
  }
  for await (const ev of sseEvents(opened.stream)) {
    if (ev.error) {      const err = new Error('LLM antigravity: ' + (ev.error.message || 'provider error'));
      err.transient = true;
      throw err;
    }
    absorb(ev.response || ev);
  }
  return settle();
}

// ---------------------------------------------------------------------------
// xAI Grok — official API (`/responses` on `https://api.x.ai/v1`)
// ---------------------------------------------------------------------------
function grokChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const apiKey = assertOfficialApiKey(provider, ['XAI_API_KEY'], 'grok');
  const { instructions, input } = toCodexInput(messages);
  const toolDefs = toCodexTools(tools);
  const body = {
    model: provider.model,
    instructions: instructions || 'You are a helpful assistant.',
    input,
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    text: { verbosity: 'low' },
  };
  if (toolDefs.length) {
    body.tools = toolDefs;
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
  }
  if (provider.reasoningLevel && provider.reasoningLevel !== 'auto') {
    body.reasoning = { effort: provider.reasoningLevel, summary: 'auto' };
  }
  const maxOut = Number(maxTokensOverride || provider.maxTokens) > 0
    ? Number(maxTokensOverride || provider.maxTokens) : 0;
  if (maxOut) body.max_output_tokens = maxOut;

  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: 'Bearer ' + apiKey,
    'user-agent': OFFICIAL_USER_AGENT,
  };

  const root = trimBase(provider.baseURL || DEFAULT_XAI_BASE);
  const url = /\/responses$/.test(root) ? root : root + '/responses';

  return responsesChat({
    label: 'grok',
    url,
    headers,
    body,
    onDelta,
    onToolDelta,
    signal,
  });
}

// ---------------------------------------------------------------------------
// Z.ai (GLM Coding Plan & PaaS v4) — official API / Coding Plan key transport
// ---------------------------------------------------------------------------
const ZAI_DEFAULT_MODELS = [
  { id: 'glm-5.4', label: 'GLM-5.4 (Coding Plan)', contextWindow: 1000000, thinking: true, thinkingLevels: ['auto', 'low', 'medium', 'high'] },
  { id: 'glm-5.3', label: 'GLM-5.3 (Coding Plan)', contextWindow: 1000000, thinking: true, thinkingLevels: ['auto', 'low', 'medium', 'high'] },
  { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash (Coding Plan)', contextWindow: 1000000, thinking: true, thinkingLevels: ['auto', 'low', 'medium', 'high'] },
  { id: 'glm-5', label: 'GLM-5', contextWindow: 1000000, thinking: true, thinkingLevels: ['auto', 'low', 'medium', 'high'] },
  { id: 'glm-4.7', label: 'GLM-4.7', contextWindow: 200000, thinking: true, thinkingLevels: ['auto', 'low', 'medium', 'high'] },
];

function resolveZaiBase(provider) {
  const raw = trimBase(provider && provider.baseURL);
  if (raw) return raw.replace(/\/chat\/completions$/i, '');
  if (provider && provider.useStandardEndpoint) return DEFAULT_ZAI_BASE;
  return DEFAULT_ZAI_CODING_BASE;
}

function toZaiMessages(messages) {
  const out = [];
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'developer' ? 'system' : (m.role || 'user');
    if (role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: m.tool_call_id || m.toolCallId || 'tool_0',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content),
      });
      continue;
    }
    if (role === 'assistant') {
      const msg = {
        role: 'assistant',
        content: typeof m.content === 'string' ? m.content : (Array.isArray(m.content) ? m.content.map((p) => (p && p.text) || '').join('') : ''),
      };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        msg.tool_calls = m.tool_calls.map((tc, idx) => ({
          id: sanitizeToolCallId(tc.id, idx + 1),
          type: 'function',
          function: {
            name: (tc.function && tc.function.name) || tc.name || 'tool',
            arguments: typeof (tc.function && tc.function.arguments) === 'string'
              ? tc.function.arguments
              : JSON.stringify((tc.function && tc.function.arguments) || {}),
          },
        }));
      }
      out.push(msg);
      continue;
    }
    if (Array.isArray(m.content)) {
      const parts = [];
      for (const p of m.content) {
        if (typeof p === 'string' && p) parts.push({ type: 'text', text: p });
        else if (p && typeof p.text === 'string' && p.text) parts.push({ type: 'text', text: p.text });
        else if (p && p.type === 'image_url' && p.image_url) parts.push(p);
      }
      if (parts.length) out.push({ role, content: parts });
    } else if (m.content != null) {
      out.push({ role, content: String(m.content) });
    }
  }
  return out;
}

async function zaiChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const apiKey = assertOfficialApiKey(provider, ['ZAI_CODING_API_KEY', 'ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'], 'zai');
  const base = resolveZaiBase(provider);
  const url = `${base}/chat/completions`;
  const modelId = String((provider && provider.model) || 'glm-5.4');
  const maxOut = Number(maxTokensOverride || (provider && provider.maxTokens)) > 0
    ? Number(maxTokensOverride || (provider && provider.maxTokens))
    : 16384;
  const rLevel = String((provider && provider.reasoningLevel) || '').toLowerCase();
  const buildBody = (allowThinking) => {
    const b = {
      model: modelId,
      messages: toZaiMessages(messages),
      stream: true,
      max_tokens: maxOut,
    };
    if (Array.isArray(tools) && tools.length) {
      b.tools = tools.map((t) => {
        const fn = t.function || t;
        return {
          type: 'function',
          function: {
            name: fn.name,
            description: fn.description || '',
            parameters: fn.parameters || { type: 'object', properties: {} },
          },
        };
      });
      b.tool_choice = 'auto';
    }
    if (allowThinking && /^glm-5/i.test(modelId) && ['low', 'medium', 'high'].includes(rLevel)) {
      b.thinking = { type: 'enabled' };
    }
    return b;
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: 'Bearer ' + apiKey,
    'user-agent': OFFICIAL_USER_AGENT,
  };
  const postZai = (payloadObj) => fetchWithTimeout(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payloadObj),
    signal,
  }, 'zai', 180000);

  const firstBody = buildBody(true);
  let res = await postZai(firstBody);
  if (!res.ok && firstBody.thinking && res.status === 400) {
    const errTxt = await res.text().catch(() => '');
    if (res._cleanupAbort) { try { res._cleanupAbort(); } catch (_) {} res._cleanupAbort = null; }
    if (/thinking/i.test(errTxt)) {
      res = await postZai(buildBody(false));
    } else {
      throw httpError('zai', res, errTxt);
    }
  }
  if (!res.ok) {
    const errTxt = await res.text().catch(() => '');
    if (res._cleanupAbort) { try { res._cleanupAbort(); } catch (_) {} res._cleanupAbort = null; }
    throw httpError('zai', res, errTxt);
  }

  const opened = await openStream(res, signal);
  const message = { role: 'assistant', content: '', tool_calls: [], model: modelId };
  const byIndex = new Map();
  const settle = () => {
    if (!message.finish_reason) message.finish_reason = message.tool_calls.length ? 'tool_calls' : 'stop';
    return message;
  };
  if (opened.empty) return settle();
  if (!opened.isSse) {
    const text = await new Response(opened.stream).text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) {}
    const ch = data && data.choices && data.choices[0];
    const msg = ch && ch.message;
    if (msg) {
      if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) onDelta(msg.reasoning_content, true);
      if (typeof msg.content === 'string' && msg.content) { message.content = msg.content; onDelta(msg.content, false); }
      if (Array.isArray(msg.tool_calls)) message.tool_calls = msg.tool_calls;
    }
    if (ch && ch.finish_reason) message.finish_reason = ch.finish_reason;
    if (data && data.model) message.model = String(data.model);
    if (data && data.usage) message.usage = usageEstimator.normalizeCallUsage(data.usage) || data.usage;
    return settle();
  }
  for await (const ev of sseEvents(opened.stream)) {
    if (ev.error) {
      const err = new Error('LLM zai: ' + (ev.error.message || 'provider error'));
      err.transient = true;
      throw err;
    }
    if (ev.model) message.model = String(ev.model);
    if (ev.usage) message.usage = usageEstimator.normalizeCallUsage(ev.usage) || ev.usage;
    const ch = ev.choices && ev.choices[0];
    if (!ch) continue;
    const d = ch.delta || {};
    if (typeof d.reasoning_content === 'string' && d.reasoning_content) {
      onDelta(d.reasoning_content, true);
    }
    if (typeof d.content === 'string' && d.content) {
      message.content += d.content;
      onDelta(d.content, false);
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const idx = Number.isFinite(Number(tc.index)) ? Number(tc.index) : 0;
        let acc = byIndex.get(idx);
        if (!acc) {
          acc = {
            id: sanitizeToolCallId(tc.id, idx + 1),
            type: 'function',
            function: { name: (tc.function && tc.function.name) || '', arguments: '' },
          };
          byIndex.set(idx, acc);
          message.tool_calls.push(acc);
        }
        if (tc.id) acc.id = sanitizeToolCallId(tc.id, idx + 1);
        if (tc.function && tc.function.name) acc.function.name = tc.function.name;
        if (tc.function && tc.function.arguments) pushToolArg(acc, tc.function.arguments);
        if (onToolDelta && acc.function.name) onToolDelta(toolDeltaPayload(acc));
      }
    }
    if (ch.finish_reason) message.finish_reason = ch.finish_reason;
  }
  return settle();
}

async function zaiModels(provider, signal) {
  const apiKey = assertOfficialApiKey(provider, ['ZAI_CODING_API_KEY', 'ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'], 'zai');
  const base = resolveZaiBase(provider);
  let live = [];
  try {
    const res = await fetch(base + '/models', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + apiKey,
        'user-agent': OFFICIAL_USER_AGENT,
      },
      signal,
    });
    const text = await res.text().catch(() => '');
    if (res.ok) {
      const json = JSON.parse(text);
      const arr = json.data || json.models || (Array.isArray(json) ? json : []);
      live = arr.map((m) => {
        const id = String(m.id || m.model || '');
        const cap = num(m.context_window || m.contextLength || m.contextWindow || (/^glm-5/i.test(id) ? 1000000 : 200000));
        return {
          id,
          label: String(m.display_name || m.name || id),
          contextWindow: cap,
          thinking: /^glm-5/i.test(id),
          thinkingLevels: /^glm-5/i.test(id) ? ['auto', 'low', 'medium', 'high'] : [],
        };
      }).filter((m) => m.id);
    } else if (res.status === 401 || res.status === 403) {
      throw httpError('zai', res, text);
    }
  } catch (e) {
    if (e && e.code === 'provider_needs_signin') throw e;
  }
  const seen = new Set(live.map((m) => m.id));
  for (const def of ZAI_DEFAULT_MODELS) {
    if (!seen.has(def.id)) live.push({ ...def });
  }
  return live;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const ADAPTERS = {
  anthropic: anthropicChat,
  codex: codexChat,
  google: googleChat,
  grok: grokChat,
  zai: zaiChat,
};

/** True when this provider uses a non-`/chat/completions` official REST adapter. */
function needsTransport(provider) {
  return !!(provider && ADAPTERS[provider.transport]);
}

async function cliChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const cliRunner = require('./cli-runner');
  const isHealthPing = Number(maxTokensOverride) > 0
    && Number(maxTokensOverride) <= 32
    && Array.isArray(messages)
    && messages.length === 1
    && String((messages[0] && messages[0].content) || '').trim().toLowerCase() === 'ping';

  if (isHealthPing) {
    const resolved = await cliRunner.resolveCliBinary(provider);
    if (!resolved || !resolved.bin) {
      const kind = cliRunner.providerKind(provider) || 'CLI';
      throw new Error(`${kind} CLI binary is not installed — check Settings → Runtimes & Updates.`);
    }
    const kind = cliRunner.providerKind(provider);
    if (kind) {
      try {
        const providerOauth = require('./provider-oauth');
        const auth = await providerOauth.probeCliAuthStatus(kind).catch(() => null);
        if (auth && auth.ok && auth.loggedIn === false) {
          const err = new Error(`${auth.label || kind} is not signed in — click Sign in / Reconnect first.`);
          err.code = 'provider_needs_signin';
          err.human = true;
          throw err;
        }
      } catch (e) {
        if (e && e.code === 'provider_needs_signin') throw e;
      }
    }
    return cliRunner.runCliTurn({
      provider,
      messages: [{ role: 'user', content: 'Reply with OK only.' }],
      onDelta: onDelta || (() => {}),
      onToolDelta,
      signal,
      singleTurn: true,
      timeoutMs: 25000,
    });
  }

  return cliRunner.runCliTurn({
    provider,
    messages,
    onDelta: onDelta || (() => {}),
    onToolDelta,
    signal,
    singleTurn: !tools || tools.length === 0,
  });
}

function chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  const cliRunner = require('./cli-runner');
  const explicitAdapter = provider && provider.transport && ADAPTERS[provider.transport];
  if ((provider && (provider.transport === 'cli' || provider.cliMode === true)) || (!explicitAdapter && cliRunner.isCliProvider(provider))) {
    return cliChat(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta);
  }
  const fn = explicitAdapter;
  if (!fn) throw new Error('no transport for ' + (provider && provider.transport));
  return fn(provider, messages, tools, onDelta || (() => {}), signal, maxTokensOverride, onToolDelta);
}

/**
 * Fetch a provider's model catalog using official API keys or CLI probes.
 */
async function listModels(provider, signal) {
  const effSignal = signal || AbortSignal.timeout(15000);
  const transport = String((provider && provider.transport) || '');
  const cliRunner = require('./cli-runner');

  if (transport === 'cli' || cliRunner.isCliProvider(provider)) {
    const kind = cliRunner.providerKind(provider);
    const resolved = await cliRunner.resolveCliBinary(provider).catch(() => ({ bin: '' }));
    const live = (kind && resolved && resolved.bin && typeof cliRunner.probeCliModels === 'function')
      ? await cliRunner.probeCliModels(kind, resolved.bin).catch(() => [])
      : [];
    let fallback = [];
    try {
      const def = kind ? require('./provider-oauth').provider(kind) : null;
      if (def && Array.isArray(def.models)) fallback = def.models;
    } catch (_) {}
    const seen = new Set(live.map((m) => String((m && m.id) || '').toLowerCase()));
    const merged = [...live];
    for (const fm of fallback) {
      if (fm && fm.id && !seen.has(String(fm.id).toLowerCase())) {
        merged.push({ ...fm });
      }
    }
    return merged;
  }

  if (transport === 'google') {
    return googleModels(provider, effSignal);
  }

  if (transport === 'anthropic') {
    const base = trimBase(provider.baseURL || DEFAULT_ANTHROPIC_BASE);
    const { headers } = anthropicAuth(provider);
    const res = await fetch(base + '/v1/models?limit=100', {
      headers: Object.assign({}, headers, { accept: 'application/json' }),
      signal: effSignal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError('anthropic', res, text);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return []; }
    const winOf = (m) => num(m.max_input_tokens || m.context_window || m.max_context_window || m.contextWindow);
    return (json.data || []).map((m) => {
      const id = String(m.id || '');
      const cap = m.capabilities && m.capabilities.thinking;
      const supportsThink = typeof m.thinking === 'boolean'
        ? m.thinking
        : (typeof cap === 'boolean'
          ? cap
          : !/^claude-(?:3-(?:haiku|sonnet|opus)|2)/i.test(id));
      const levels = supportsThink
        ? (/^claude-(?:opus|fable)-5/i.test(id) ? ['auto', 'low', 'medium', 'high', 'xhigh'] : ['auto', 'low', 'medium', 'high'])
        : [];
      return {
        id,
        label: String(m.display_name || id || ''),
        contextWindow: winOf(m),
        thinking: supportsThink,
        thinkingLevels: levels,
      };
    }).filter((m) => m.id);
  }

  if (transport === 'codex') {
    const apiKey = assertOfficialApiKey(provider, ['OPENAI_API_KEY'], 'openai');
    const base = trimBase(provider.baseURL || DEFAULT_OPENAI_BASE).replace(/\/responses$/, '');
    const res = await fetch(base + '/models', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + apiKey,
        'user-agent': OFFICIAL_USER_AGENT,
      },
      signal: effSignal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError('openai', res, text);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return []; }
    const list = json.data || json.models || (Array.isArray(json) ? json : []);
    return list.map((m) => {
      const id = String(m.id || m.model || m.slug || '');
      const thinks = /\b(gpt-5|o[1-4]|codex)\b/i.test(id);
      const levels = thinks ? ['auto', 'low', 'medium', 'high', 'xhigh'] : [];
      return {
        id,
        label: String(m.display_name || m.displayName || id),
        contextWindow: num(m.context_window || m.contextWindow || m.max_tokens),
        thinking: thinks,
        thinkingLevels: levels,
      };
    }).filter((m) => m.id);
  }

  if (transport === 'grok') {
    const apiKey = assertOfficialApiKey(provider, ['XAI_API_KEY'], 'grok');
    const base = trimBase(provider.baseURL || DEFAULT_XAI_BASE).replace(/\/responses$/, '');
    const res = await fetch(base + '/models', {
      headers: {
        accept: 'application/json',
        authorization: 'Bearer ' + apiKey,
        'user-agent': OFFICIAL_USER_AGENT,
      },
      signal: effSignal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError('grok', res, text);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return []; }
    const list = json.data || json.models || (Array.isArray(json) ? json : []);
    return list.map((m) => {
      const id = String(m.id || m.model || '');
      const thinks = /grok-[3-9]/.test(id);
      return {
        id,
        label: String(m.display_name || m.displayName || m.name || id),
        contextWindow: num(m.context_window || m.contextLength || m.max_context_window || m.max_tokens),
        thinking: thinks,
        thinkingLevels: thinks ? ['auto', 'low', 'medium', 'high'] : [],
      };
    }).filter((m) => m.id);
  }

  if (transport === 'zai') {
    return zaiModels(provider, effSignal);
  }

  return [];
}

module.exports = {
  chatCompletion,
  needsTransport,
  listModels,
  setClientVersions,
  warmHttpEndpoint,
  adapters: ADAPTERS,
  // exported for tests
  _internal: {
    httpError, sseEvents, toAnthropicBody, anthropicAuth, anthropicFinish, sanitizeToolCallId,
    toCodexInput, toCodexTools, toGeminiContents, geminiFinish, responsesChat, zaiChat, zaiModels, resolveZaiBase, toZaiMessages,
    googleModels, googleModelList, OFFICIAL_USER_AGENT,
    toGeminiSchema, toGeminiDeclarations,
    setClientVersions, formatResetIn, assertOfficialApiKey, cliChat,
    DEFAULT_ANTHROPIC_BASE, DEFAULT_OPENAI_BASE, DEFAULT_GEMINI_BASE, DEFAULT_XAI_BASE, DEFAULT_ZAI_CODING_BASE, DEFAULT_ZAI_BASE,
  },
};
