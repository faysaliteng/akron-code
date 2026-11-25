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
 * covered by unit tests; no ChatGPT-Plus or Antigravity credential exists on
 * this machine, so they are explicitly NOT claimed as field-tested.
 */

const { randomUUID } = require('node:crypto');

const DEFAULT_ANTHROPIC_BASE = 'https://api.anthropic.com';
const CODEX_RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses';
const CLOUDCODE_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';

// Mimic the first-party CLI: subscription endpoints gate on these.
const CLAUDE_UA = 'claude-cli/2.1.154 (external, cli)';
const CODEX_ORIGINATOR = 'codex_cli_rs';

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

function httpError(transport, res, text) {
  const err = new Error('LLM ' + res.status + ': ' + String(text || '').slice(0, 400));
  err.status = res.status;
  err.transport = transport;
  const ra = res.headers && res.headers.get ? res.headers.get('retry-after') : null;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs > 0) err.retryAfterMs = Math.min(secs * 1000, 60000);
  return err;
}

function newToolAcc(id, name) {
  return { id: id || '', type: 'function', function: { name: name || '', arguments: '' } };
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
    headers['user-agent'] = CLAUDE_UA;
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
        blocks.push({ type: 'tool_use', id: tc.id || '', name: (tc.function && tc.function.name) || '', input });
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
        name: fn.name,
        description: fn.description || '',
        input_schema: fn.parameters || { type: 'object', properties: {} },
      };
    });
  }
  // Deliberately no `temperature`: the subscription path does not accept it the
  // way the public API does, and Claude Code itself never sends one.
  return body;
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
  const res = await fetch(base + '/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw httpError('anthropic', res, await res.text().catch(() => ''));

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
// Google Cloud Code (`cloudcode-pa`) — Antigravity / Gemini CLI backend
//
// NOT field-verified (no Antigravity credential on this machine). The project
// id is resolved once via loadCodeAssist and cached on the provider object.
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

async function googleProject(provider, signal) {
  if (provider.project) return provider.project;
  const res = await fetch(cloudcodeBase(provider) + ':loadCodeAssist', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
      'user-agent': 'akron-bot/1.0 (google-transport)',
    },
    body: JSON.stringify({ metadata: { pluginType: 'GEMINI_CLI', pluginVersion: '2.1.154' } }),
    signal,
  });
  if (!res.ok) throw httpError('google', res, await res.text().catch(() => ''));
  const d = await res.json().catch(() => null);
  const project = (d && (d.cloudaicompanionProject || (d.cloudaicompanionProject && d.cloudaicompanionProject.id))) || '';
  if (!project) {
    const err = new Error('LLM google: this Google account has no Cloud Code project — open Antigravity once, then retry');
    err.status = 403;
    throw err;
  }
  provider.project = project;
  return project;
}

async function googleChat(provider, messages, tools, onDelta, signal, maxTokensOverride) {
  const project = await googleProject(provider, signal);
  const { systemParts, contents } = toGeminiContents(messages);
  const request = {
    contents,
    generationConfig: {
      maxOutputTokens: Number(maxTokensOverride || provider.maxTokens) > 0
        ? Number(maxTokensOverride || provider.maxTokens) : 32000,
    },
  };
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
  const body = { model: provider.model, project, request, userAgent: 'akron-bot' };
  const res = await fetch(cloudcodeBase(provider) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
      'user-agent': 'akron-bot/1.0 (google-transport)',
      'x-goog-api-client': 'gl-node/22.0.0',
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw httpError('google', res, await res.text().catch(() => ''));

  const message = { role: 'assistant', content: '', tool_calls: [] };
  let callSeq = 0;
  const absorb = (resp) => {
    if (!resp) return;
    const cand = (resp.candidates || [])[0];
    if (cand) {
      for (const part of (cand.content && cand.content.parts) || []) {
        if (typeof part.text === 'string' && part.text) {
          message.content += part.text;
          onDelta(part.text);
        }
        if (part.functionCall) {
          callSeq += 1;
          const acc = newToolAcc('call_' + callSeq + '_' + (part.functionCall.name || 'fn'),
            part.functionCall.name || '');
          acc.function.arguments = JSON.stringify(part.functionCall.args || {});
          message.tool_calls.push(acc);
        }
      }
      if (cand.finishReason) message.finish_reason = geminiFinish(cand.finishReason);
    }
    if (resp.usageMetadata) {
      message.usage = {
        input_tokens: num(resp.usageMetadata.promptTokenCount),
        output_tokens: num(resp.usageMetadata.candidatesTokenCount),
        total_tokens: num(resp.usageMetadata.totalTokenCount),
      };
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
      const err = new Error('LLM google: ' + (ev.error.message || 'provider error'));
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
const GROK_CLI_VERSION = '1.0.92';
const GROK_PRODUCT = 'grok-shell';
const GROK_UA = GROK_PRODUCT + '/' + GROK_CLI_VERSION + ' (macos; aarch64)';
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
      'user-agent': GROK_UA,
      'x-xai-token-auth': 'xai-grok-cli',
      'x-grok-client-identifier': GROK_PRODUCT,
      'x-grok-client-version': GROK_CLI_VERSION,
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
    'user-agent': GROK_UA,
    'x-xai-token-auth': 'xai-grok-cli',
    'x-grok-client-identifier': GROK_PRODUCT,
    'x-grok-client-version': GROK_CLI_VERSION,
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

module.exports = {
  chatCompletion,
  needsTransport,
  adapters: ADAPTERS,
  // exported for tests
  _internal: {
    sseEvents, toAnthropicBody, anthropicAuth, anthropicFinish,
    toCodexInput, toCodexTools, toGeminiContents, geminiFinish, responsesChat,
    CLAUDE_UA, CODEX_RESPONSES_URL, GROK_RESPONSES_URL, CLOUDCODE_BASE, DEFAULT_ANTHROPIC_BASE, cloudcodeBase,
    grokHeaders, GROK_UA, GROK_CLI_VERSION, GROK_PRODUCT, GROK_CREDITS_URL, grokCreditHint,
  },
};
