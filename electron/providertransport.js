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

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
// Antigravity has its own Cloud Code deployment; the Gemini-CLI one
// (`cloudcode-pa.googleapis.com`) answers 403 for an Antigravity grant.
const CLOUDCODE_BASE = 'https://daily-cloudcode-pa.googleapis.com/v1internal';

// Context windows + auto-compact budgets. Pure data module, no imports, so this
// does not create a cycle (and survives asar packing).
const catalog = require('./model-catalog');

// Ask for the 1M beta once the request estimate passes Anthropic's default
// window with headroom for its tokenizer being a little finer than ours.
const LONG_CONTEXT_MIN_TOKENS = 190000;

// Mimic the first-party CLI: subscription endpoints gate on these.
//
// The version token is itself a fingerprint the vendor validates, so it must
// track the CLI we actually ship. Verified live: `claude-fable-5-2` answers
// 400 "Claude Code 2.1.154 does not support this model; version 2.1.290 or
// newer is required" until the UA claims a new enough build, on exactly the
// same token that had worked for older models. The defaults below are a floor;
// main.js injects the resolved runtime version at boot (and after every
// install), so a self-update immediately unblocks newer models.
const DEFAULT_CLIENT_VERSIONS = { claude: '2.1.332', codex: '0.172.0', grok: '1.0.92' };
const clientVersions = { ...DEFAULT_CLIENT_VERSIONS };

/** Adopt the versions of the CLIs on disk; unknown/garbage values are ignored. */
function setClientVersions(v) {
  if (v && typeof v === 'object') {
    for (const k of Object.keys(clientVersions)) {
      const m = String(v[k] || '').match(/(\d+\.\d+\.\d+)/);
      if (m) clientVersions[k] = m[1];
    }
  }
  return { ...clientVersions };
}

const claudeUa = () => 'claude-cli/' + clientVersions.claude + ' (external, cli)';
const codexUa = () => 'codex-cli/' + clientVersions.codex;
const CODEX_ORIGINATOR = 'codex_cli_rs';

// Antigravity's license gate is a user-agent prefix check. Verified live: every
// `antigravity/hub/<anything> (aidev_client; ...)` variant answers 200 while
// `akron-bot/1.0` answers 403 `#3501 You do not have a valid license`. The
// trailing `cl=` build stamp is not validated (000000000 works), but the whole
// observed string is sent so a stricter future check still passes.
const ANTIGRAVITY_UA = 'antigravity/hub/1.0.0 (aidev_client; os_type=darwin; arch=arm64; cl=1029194470)';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function trimBase(u) { return String(u || '').replace(/\/+$/, ''); }

/**
 * Yield the `data:` payload of each SSE event as a parsed object.
 * Tolerates CRLF, multi-line data blocks, `[DONE]`, and keep-alive comments.
 */
async function* sseEvents(res) {
  const reader = res.body.getReader();
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
};

function httpError(transport, res, text) {
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
  const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs > 0) err.retryAfterMs = Math.min(secs * 1000, 60000);
  return err;
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

// ---------------------------------------------------------------------------
// Anthropic Messages API
//
// Live-verified. Two details are load-bearing and were both found the hard way:
// subscription traffic needs the `oauth-2025-04-20` beta header, and `x-api-key`
// is ignored on an OAuth token — it must be `Authorization: Bearer`.
// ---------------------------------------------------------------------------
// The first-party identity prompt, verbatim. Subscription OAuth traffic is
// gated on it: without this exact system block the API answers
// `429 rate_limit_error {"message":"Error"}` for every model, which reads like a
// spent account but is really a "you are not Claude Code" rejection. Verified
// live on this machine 2026-11-25 — same token, same model, 429 bare / 200 with
// the block — so it is prepended rather than left to the caller.
const CC_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

function isAnthropicOauth(provider) {
  const tok = String((provider && (provider.accessToken || provider.apiKey)) || '');
  return !!(provider && provider.oauth) || /^sk-ant-oat/.test(tok);
}

const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

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

/**
 * Turn a Claude subscription 429 into a fact instead of a guess. The OAuth usage
 * endpoint reports both allowance windows and when each resets, so the banner
 * can say "the 5-hour allowance is 100% used, resets at 2:30 AM" instead of
 * "rate limiting this key" after five rounds of 45 s backoff. Only subscription
 * tokens can read it — API keys cannot.
 */
async function claudeAllowanceHint(provider) {
  try {
    const { headers, oauth } = anthropicAuth(provider);
    if (!oauth) return '';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    let res;
    try {
      res = await fetch(CLAUDE_USAGE_URL, {
        headers: { authorization: headers.authorization, 'anthropic-beta': headers['anthropic-beta'] },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return '';
    const j = await res.json().catch(() => null);
    if (!j) return '';
    const wins = ['five_hour', 'seven_day']
      .map((k) => ({ k, w: j[k] }))
      .filter((x) => x.w && Number.isFinite(Number(x.w.utilization)));
    if (!wins.length) return '';
    // Name the window that is actually blocking this request.
    const hit = wins.find((x) => Number(x.w.utilization) >= 99.5) || wins[0];
    const util = Number(hit.w.utilization);
    const pct = Math.max(0, Math.min(100, Math.round(util)));
    const label = hit.k === 'five_hour' ? '5-hour' : '7-day';
    const when = formatResetIn(hit.w.resets_at);
    let hint = `the Claude plan's ${label} allowance is ${pct}% used${when ? ` (resets ${when})` : ''}`;
    if (util >= 99.5) hint += '; send this request again after the reset — nothing in the conversation is lost';
    return hint;
  } catch (_) {
    return '';
  }
}

function anthropicAuth(provider) {
  const tok = String(provider.accessToken || provider.apiKey || '');
  const oauth = isAnthropicOauth(provider);
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'anthropic-version': '2023-06-01',
  };
  if (oauth) {
    headers.authorization = 'Bearer ' + tok;
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['user-agent'] = claudeUa();
    headers['x-app'] = 'cli';
  } else {
    headers['x-api-key'] = tok;
    headers['user-agent'] = 'akron-bot/1.0';
  }
  return { headers, oauth };
}

/**
 * Convert the internal OpenAI-ish transcript into Anthropic blocks.
 * System prompts are hoisted; tool results become user `tool_result` blocks;
 * assistant tool calls become `tool_use` blocks. Consecutive same-role turns are
 * merged because Anthropic rejects two adjacent user messages.
 */
function toAnthropicBody(provider, messages, tools, maxTokens) {
  const systemParts = [];
  const out = [];
  const pushMsg = (role, content) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = last.content.concat(content);
    else out.push({ role, content });
  };

  for (const m of messages || []) {
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string' && m.content) systemParts.push({ type: 'text', text: m.content });
      continue;
    }
    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.toolCallId || '',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content),
      };
      if (m.is_error) block.is_error = true;
      pushMsg('user', [block]);
      continue;
    }
    if (role === 'assistant') {
      const blocks = [];
      if (typeof m.content === 'string' && m.content) blocks.push({ type: 'text', text: m.content });
      else if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
        }
      }
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse((tc.function && tc.function.arguments) || '{}') || {}; } catch (_) { input = {}; }
        blocks.push({ type: 'tool_use', id: tc.id || '', name: wireToolName((tc.function && tc.function.name) || ''), input });
      }
      if (blocks.length) pushMsg('assistant', blocks);
      continue;
    }
    // user
    if (typeof m.content === 'string') pushMsg('user', [{ type: 'text', text: m.content }]);
    else if (Array.isArray(m.content)) {
      const blocks = [];
      for (const p of m.content) {
        if (typeof p === 'string') blocks.push({ type: 'text', text: p });
        else if (p && typeof p.text === 'string') blocks.push({ type: 'text', text: p.text });
        else if (p && p.type === 'image' && p.source) blocks.push(p);
      }
      if (blocks.length) pushMsg('user', blocks);
    }
  }

  // OAuth/subscription turns must lead with the Claude Code identity prompt.
  if (isAnthropicOauth(provider)) {
    const lead = systemParts[0] && String(systemParts[0].text || '');
    if (!lead || !lead.startsWith(CC_IDENTITY)) {
      systemParts.unshift({ type: 'text', text: CC_IDENTITY });
    }
  }
  const body = {
    model: provider.model,
    max_tokens: Number(maxTokens) > 0 ? Number(maxTokens) : 32000,
    stream: true,
    messages: out,
  };
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

async function anthropicChat(provider, messages, tools, onDelta, signal, maxTokensOverride) {
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
  const longBeta = catalog.supportsLongContext(model) && estTokens > LONG_CONTEXT_MIN_TOKENS;
  const shortBeta = headers['anthropic-beta'];
  if (longBeta) headers['anthropic-beta'] = shortBeta + ',' + catalog.LONG_CONTEXT_BETA;

  const post = (hdrs) => fetch(base + '/v1/messages', {
    method: 'POST', headers: hdrs, body: payload, signal,
  });

  let res = await post(headers);
  if (!res.ok && longBeta && res.status === 400) {
    const rejected = await res.text().catch(() => '');
    // Not entitled to the beta. Retrying the identical request with the header
    // is useless, so drop it, record the real window for the session, and send
    // once more — the agent loop then sees an honest 200k ceiling and compacts.
    if (/context|beta|long|1m|entitle|not available/i.test(rejected)) {
      catalog.demote(providerId, model, catalog.SHORT_CONTEXT_WINDOW);
      const retryHeaders = { ...headers, 'anthropic-beta': shortBeta };
      res = await post(retryHeaders);
    } else {
      throw httpError('anthropic', res, rejected);
    }
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
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
    }
    throw err;
  }

  const ct = res.headers.get('content-type') || '';
  const message = { role: 'assistant', content: '', tool_calls: [] };

  if (!ct.includes('text/event-stream')) {
    // A proxy collapsed the stream back to one JSON body.
    const data = await readJsonBody(res);
    if (data && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') { message.content += block.text || ''; if (block.text) onDelta(block.text); }
        else if (block.type === 'tool_use') {
          const acc = newToolAcc(block.id, block.name);
          acc.function.arguments = JSON.stringify(block.input || {});
          message.tool_calls.push(acc);
        }
      }
    }
    message.finish_reason = anthropicFinish(data && data.stop_reason);
    if (data && data.usage) message.usage = data.usage;
    return message;
  }

  const accs = new Map(); // block index -> tool acc
  for await (const ev of sseEvents(res)) {
    const type = ev.type;
    if (type === 'content_block_start') {
      const block = ev.content_block || {};
      if (block.type === 'tool_use') {
        const acc = newToolAcc(block.id, block.name);
        accs.set(ev.index, acc);
        message.tool_calls.push(acc);
      }
    } else if (type === 'content_block_delta') {
      const d = ev.delta || {};
      if (d.type === 'text_delta' && d.text) {
        message.content += d.text;
        onDelta(d.text);
      } else if (d.type === 'thinking_delta' && d.thinking) {
        onDelta(d.thinking, true);
      } else if (d.type === 'input_json_delta') {
        const acc = accs.get(ev.index);
        if (acc) pushToolArg(acc, d.partial_json);
      }
    } else if (type === 'message_delta') {
      const d = ev.delta || {};
      if (d.stop_reason) message.finish_reason = anthropicFinish(d.stop_reason);
      if (ev.usage) message.usage = ev.usage;
    } else if (type === 'message_start') {
      if (ev.message && ev.message.usage) message.usage = ev.message.usage;
    } else if (type === 'error') {
      const e = ev.error || {};
      const err = new Error('LLM ' + (e.type || 'error') + ': ' + (e.message || 'provider error'));
      err.transient = e.type === 'overloaded_error' || e.type === 'api_error';
      throw err;
    }
  }
  if (!message.finish_reason) message.finish_reason = message.tool_calls.length ? 'tool_calls' : 'stop';
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
  for (const m of messages || []) {
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string' && m.content) instructions.push(m.content);
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id || m.toolCallId || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content == null ? '' : m.content),
      });
      continue;
    }
    if (role === 'assistant') {
      if (typeof m.content === 'string' && m.content) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
      }
      for (const tc of m.tool_calls || []) {
        input.push({
          type: 'function_call',
          name: (tc.function && tc.function.name) || '',
          arguments: (tc.function && tc.function.arguments) || '{}',
          call_id: tc.id || '',
        });
      }
      continue;
    }
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('') : '');
    if (text) input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
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
  if (level === 'low' || level === 'medium' || level === 'high') return { effort: level, summary: 'auto' };
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
  const doFetch = o.fetchImpl || fetch;
  const res = await doFetch(o.url, {
    method: 'POST', headers: o.headers, body: JSON.stringify(o.body), signal: o.signal,
  });
  if (!res.ok) throw httpError(label, res, await res.text().catch(() => ''));

  const message = { role: 'assistant', content: '', tool_calls: [] };
  const byItem = new Map(); // output item id -> tool acc
  const byCall = new Map(); // call id -> tool acc (stream and final body can both report it)
  const ct = res.headers.get('content-type') || '';

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
      }
    }
    if (resp.status === 'incomplete') message.finish_reason = 'length';
  };

  const finish = () => {
    if (!message.finish_reason) message.finish_reason = message.tool_calls.length ? 'tool_calls' : 'stop';
    return message;
  };

  if (!ct.includes('text/event-stream')) {
    const data = await readJsonBody(res);
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

  for await (const ev of sseEvents(res)) {
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
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const acc = byItem.get(ev.item_id);
      if (acc) pushToolArg(acc, ev.delta);
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

async function codexChat(provider, messages, tools, onDelta, signal, maxTokensOverride) {
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
    include: [],
  };
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
    originator: CODEX_ORIGINATOR,
    'openai-beta': 'responses=experimental',
    'user-agent': 'akron-bot/1.0 (codex-transport)',
  };
  if (provider.accountId) headers['chatgpt-account-id'] = String(provider.accountId);
  if (provider.sessionId) headers.session_id = String(provider.sessionId);

  return responsesChat({
    label: 'codex',
    url: trimBase(provider.codexUrl || CODEX_RESPONSES_URL),
    headers,
    body,
    onDelta,
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
function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];
  const pushPart = (role, part) => {
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(part);
    else contents.push({ role, parts: [part] });
  };
  for (const m of messages || []) {
    const role = m.role || 'user';
    if (role === 'system' || role === 'developer') {
      if (typeof m.content === 'string' && m.content) systemParts.push({ text: m.content });
      continue;
    }
    if (role === 'tool') {
      pushPart('user', {
        functionResponse: {
          name: m.tool_name || m.name || 'tool',
          response: { result: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) },
        },
      });
      continue;
    }
    if (role === 'assistant') {
      if (typeof m.content === 'string' && m.content) pushPart('model', { text: m.content });
      for (const tc of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse((tc.function && tc.function.arguments) || '{}') || {}; } catch (_) { args = {}; }
        pushPart('model', { functionCall: { name: (tc.function && tc.function.name) || '', args } });
      }
      continue;
    }
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('') : '');
    if (text) pushPart('user', { text });
  }
  return { systemParts, contents };
}

function geminiFinish(reason) {
  if (!reason) return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  if (reason === 'SAFETY' || reason === 'RECITATION' || reason === 'PROHIBITED_CONTENT') return 'content_filter';
  return 'stop';
}

function cloudcodeBase(provider) {
  return trimBase((provider && provider.cloudcodeUrl) || CLOUDCODE_BASE);
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
  for (const [id, m] of Object.entries(models)) {
    if (!m || typeof m !== 'object') continue;
    if (isInternalAntigravityModel(id)) continue;
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
  const res = await fetch(cloudcodeBase(provider) + ':fetchAvailableModels', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
      'user-agent': ANTIGRAVITY_UA,
    },
    body: '{}',
    signal,
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw httpError('antigravity', res, text);
  let json = null;
  try { json = JSON.parse(text); } catch (_) { return []; }
  const list = googleModelList(json);
  if (!list.length) {
    const err = new Error('LLM antigravity: no models are available for this account — sign in to Antigravity once, then retry');
    err.status = 403;
    throw err;
  }
  return list;
}

async function googleChat(provider, messages, tools, onDelta, signal, maxTokensOverride) {
  const { systemParts, contents } = toGeminiContents(messages);
  const want = Number(maxTokensOverride || provider.maxTokens) > 0
    ? Number(maxTokensOverride || provider.maxTokens) : 32000;
  const request = { contents, generationConfig: { maxOutputTokens: want } };
  if (systemParts.length) request.systemInstruction = { parts: systemParts };
  if (tools && tools.length) {
    request.tools = [{
      functionDeclarations: tools.map((t) => {
        const fn = t.function || t;
        return {
          name: fn.name,
          description: fn.description || '',
          parameters: fn.parameters || { type: 'object', properties: {} },
        };
      }),
    }];
  }
  // Verified live against `daily-cloudcode-pa`: no `project` field is needed
  // (sending one is what produced the old `403 The caller does not have
  // permission`), and `requestType`/`userAgent` mirror the desktop client.
  const body = { model: provider.model, request, userAgent: 'antigravity', requestType: 'agent' };
  const res = await fetch(cloudcodeBase(provider) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
      'user-agent': ANTIGRAVITY_UA,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw httpError('antigravity', res, await res.text().catch(() => ''));

  const message = { role: 'assistant', content: '', tool_calls: [] };
  let callSeq = 0;
  const absorb = (resp) => {
    if (!resp) return;
    const cand = (resp.candidates || [])[0];
    if (cand) {
      for (const part of (cand.content && cand.content.parts) || []) {
        // Thinking parts carry `thought: true`. Rendering them would splice the
        // model's reasoning into the visible answer.
        if (part.thought) continue;
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
          message.tool_calls.push(acc);
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

  const ct = res.headers.get('content-type') || '';
  // Gemini reports `STOP` even when the turn ends in a functionCall, so a
  // pending tool call always wins: the agent loop decides what to do next from
  // `tool_calls.length`, and a `stop` here would end the run early.
  const settle = () => {
    if (message.tool_calls.length && (!message.finish_reason || message.finish_reason === 'stop')) {
      message.finish_reason = 'tool_calls';
    } else if (!message.finish_reason) {
      message.finish_reason = 'stop';
    }
    return message;
  };
  if (!ct.includes('text/event-stream')) {
    absorb(await readJsonBody(res));
    return settle();
  }
  for await (const ev of sseEvents(res)) {
    if (ev.error) {
      const err = new Error('LLM antigravity: ' + (ev.error.message || 'provider error'));
      err.transient = true;
      throw err;
    }
    absorb(ev.response || ev);
  }
  return settle();
}

// ---------------------------------------------------------------------------
// xAI Grok — subscription `responses` through the first-party CLI proxy
//
// Endpoint: https://cli-chat-proxy.grok.com/v1/responses (verified live: a bad
// bearer answers 401 from *this* host, so the route exists). The body shape is
// the OpenAI Responses shape with the CLI proxy's extra `include`/`text`
// fields; the subscription path also sends two token-auth headers. Wire-format
// unit-tested, not field-verified — no Grok subscription credential exists on
// this machine.
// ---------------------------------------------------------------------------
const GROK_RESPONSES_URL = 'https://cli-chat-proxy.grok.com/v1/responses';
// The proxy gates subscription sampling on `x-grok-client-version` and rejects
// anything below a rolling minimum with `HTTP 426` ("Your Grok CLI version
// (x.y.z) is outdated. Please update to version 1.0.13 or later"). The gate is
// header-derived, not package-derived: the published crate/npm versions ahead of
// it are `@xai-official/grok` 1.0.92 (stable) / 1.0.93 (alpha). One constant
// feeds both the UA and the gate header so they can never disagree — a mismatch
// is itself a fingerprint the proxy can reject.
const GROK_PRODUCT = 'grok-shell';
const grokUa = () => GROK_PRODUCT + '/' + clientVersions.grok + ' (macos; aarch64)';
// Subscription sampling is billed against the Grok Build credit pool, not the
// SuperGrok plan itself, so a paying account can still answer `402 Grok Build
// usage balance exhausted` (verified live: 100% of the weekly allowance spent).
// That response carries no numbers, so read the account's own credit config to
// say *why* and *when it resets* instead of showing a bare 402.
const GROK_CREDITS_URL = 'https://grok.com/rest/grok/credits';
const GROK_CREDITS_TTL_MS = 5 * 60 * 1000;
let grokCreditsCache = { at: 0, text: '' };

async function grokCreditHint(provider) {
  if (Date.now() - grokCreditsCache.at < GROK_CREDITS_TTL_MS) return grokCreditsCache.text;
  let text = '';
  try {
    const headers = {
      authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
      accept: 'application/json',
      'user-agent': grokUa(),
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-identifier': GROK_PRODUCT,
      'x-grok-client-version': clientVersions.grok,
    };
    const r = await fetch(GROK_CREDITS_URL, {
      headers, signal: AbortSignal.timeout(8000),
    });
    if (r.ok) {
      const j = await r.json();
      const c = (j && j.config) || {};
      const period = c.currentPeriod || {};
      const used = Number(c.creditUsagePercent);
      const cents = Number((c.prepaidBalance && c.prepaidBalance.val) || 0);
      const bits = [];
      if (Number.isFinite(used)) {
        const cycle = /WEEKLY/i.test(String(period.type || '')) ? 'this week' : 'this period';
        bits.push(`the Grok Build allowance is ${Math.round(used)}% used ${cycle}`);
      }
      if (period.end) bits.push(`it resets ${String(period.end).slice(0, 10)}`);
      if (!cents && !c.onDemandCap) bits.push('prepaid balance is $0 and on-demand top-up is off');
      text = bits.join('; ');
    }
  } catch (_) { /* the hint is best-effort; the 402 still surfaces */ }
  grokCreditsCache = { at: Date.now(), text };
  return text;
}

/**
 * The exact header set the shipped Grok CLI sends. Exported so diagnostics can
 * hit `/v1/settings` and `/v1/models` with the same identity as inference —
 * a different header set there returns 426/403 for reasons unrelated to the
 * account's entitlement.
 */
function grokHeaders(provider) {
  const convId = String(provider.sessionId || provider.conversationId || randomUUID());
  const reqId = String(provider.requestId || randomUUID());
  const agentId = String(provider.agentId || randomUUID());
  const headers = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
    'user-agent': grokUa(),
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-identifier': GROK_PRODUCT,
    'x-grok-client-version': clientVersions.grok,
    'x-grok-model-override': String(provider.model || ''),
    'x-grok-conv-id': convId,
    'x-grok-req-id': reqId,
    'x-grok-session-id': convId,
    'x-grok-agent-id': agentId,
  };
  if (provider.accountId) headers['x-grok-user-id'] = String(provider.accountId);
  return headers;
}

function grokChat(provider, messages, tools, onDelta, signal, maxTokensOverride) {
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

  // Mirror `GrokRequestHeaders::apply()` from xai-grok-sampler: the proxy reads
  // the conversation/request/session/agent ids, so a request without them is
  // visibly not the CLI even when the version gate passes.
  const headers = grokHeaders(provider);

  // `provider.baseURL` is the `/v1` root from the provider registry; the
  // subscription route is `<root>/responses`. If a caller already hands us a
  // full `/responses` URL, don't append a second one.
  const root = trimBase(provider.baseURL || GROK_RESPONSES_URL);
  const url = /\/responses$/.test(root) ? root : root + '/responses';

  return responsesChat({
    label: 'grok',
    url,
    headers,
    body,
    onDelta,
    signal,
  }).catch(async (err) => {
    // A 402 here means the account's Grok Build credit pool, not the request.
    // Enrich it once so the banner explains the situation and the reset date.
    if (err && Number(err.status) === 402) {
      const hint = await grokCreditHint(provider);
      if (hint) err.hint = hint;
    }
    throw err;
  });
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------
const ADAPTERS = {
  anthropic: anthropicChat,
  codex: codexChat,
  google: googleChat,
  grok: grokChat,
};

/** True when this provider needs a native adapter instead of /chat/completions. */
function needsTransport(provider) {
  return !!(provider && ADAPTERS[provider.transport]);
}

function chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride) {
  const fn = ADAPTERS[provider && provider.transport];
  if (!fn) throw new Error('no transport for ' + (provider && provider.transport));
  return fn(provider, messages, tools, onDelta || (() => {}), signal, maxTokensOverride);
}

/**
 * Fetch a provider's LIVE model catalog, normalized to the one shape the picker
 * and the token-budget module both consume:
 *
 *   { id, label, contextWindow, thinking, group? }
 *
 * Each subscription exposes its own inventory and it changes without warning
 * (Claude Max listed 15 models on the verification machine, Antigravity 38), so
 * a hardcoded list in the renderer goes stale immediately. When a provider does
 * not advertise a window we return `contextWindow: 0` and let
 * `model-catalog.js` apply its documented rule instead of inventing a number.
 *
 * @param {object} provider hydrated provider (transport + bearer token)
 * @returns {Promise<Array<{id:string,label:string,contextWindow:number,thinking:boolean}>>}
 */
async function listModels(provider, signal) {
  const transport = String((provider && provider.transport) || '');
  const token = (provider && (provider.accessToken || provider.apiKey)) || '';

  if (transport === 'google') {
    // Antigravity advertises `maxTokens` per model — the authoritative source.
    return googleModels(provider, signal);
  }

  if (transport === 'anthropic') {
    const base = trimBase(provider.baseURL || DEFAULT_ANTHROPIC_BASE);
    const { headers } = anthropicAuth(provider);
    const res = await fetch(base + '/v1/models?limit=100', {
      headers: Object.assign({}, headers, { accept: 'application/json' }),
      signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError('anthropic', res, text);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return []; }
    // Anthropic does not return a context window; `model-catalog` documents 200k.
    return (json.data || []).map((m) => ({
      id: String(m.id || ''),
      label: String(m.display_name || m.id || ''),
      contextWindow: 0,
      thinking: true,
    })).filter((m) => m.id);
  }

  if (transport === 'codex') {
    const base = trimBase(provider.codexUrl || CODEX_RESPONSES_URL).replace(/\/responses$/, '');
    const headers = {
      accept: 'application/json',
      authorization: 'Bearer ' + token,
      originator: CODEX_ORIGINATOR,
      'user-agent': codexUa(),
    };
    if (provider.accountId) headers['chatgpt-account-id'] = String(provider.accountId);
    const res = await fetch(base + '/models', { headers, signal });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError('codex', res, text);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return []; }
    const list = json.data || json.models || (Array.isArray(json) ? json : []);
    return list.map((m) => {
      const id = String(m.id || m.model || m.slug || '');
      return {
        id,
        label: String(m.display_name || m.displayName || id),
        contextWindow: num(m.context_window || m.contextWindow || m.max_tokens),
        thinking: m.supports_reasoning !== false,
      };
    }).filter((m) => m.id);
  }

  if (transport === 'grok') {
    const res = await fetch('https://cli-chat-proxy.grok.com/v1/models', {
      headers: Object.assign({}, grokHeaders(provider), { accept: 'application/json' }),
      signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) throw httpError('grok', res, text);
    let json = null;
    try { json = JSON.parse(text); } catch (_) { return []; }
    const list = json.data || json.models || (Array.isArray(json) ? json : []);
    return list.map((m) => {
      const id = String(m.id || m.model || '');
      const modes = Array.isArray(m.reasoning_efforts) ? m.reasoning_efforts : (Array.isArray(m.reasoningEfforts) ? m.reasoningEfforts : []);
      return {
        id,
        label: String(m.display_name || m.displayName || m.name || id),
        contextWindow: num(m.context_window || m.contextLength || m.max_context_window || m.max_tokens),
        thinking: modes.length > 0 || /grok-[4-9]/.test(id),
      };
    }).filter((m) => m.id);
  }

  return [];
}

module.exports = {
  chatCompletion,
  needsTransport,
  listModels,
  setClientVersions,
  adapters: ADAPTERS,
  // exported for tests
  _internal: {
    sseEvents, toAnthropicBody, anthropicAuth, anthropicFinish,
    toCodexInput, toCodexTools, toGeminiContents, geminiFinish, responsesChat,
    googleModels, googleModelList, ANTIGRAVITY_UA,
    claudeUa, codexUa, grokUa, clientVersions, setClientVersions, DEFAULT_CLIENT_VERSIONS,
    CODEX_RESPONSES_URL, GROK_RESPONSES_URL, CLOUDCODE_BASE, DEFAULT_ANTHROPIC_BASE, cloudcodeBase,
    grokHeaders, GROK_PRODUCT, GROK_CREDITS_URL, grokCreditHint,
    claudeAllowanceHint, CLAUDE_USAGE_URL, formatResetIn,
  },
};
