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
function anthropicAuth(provider) {
  const tok = String(provider.accessToken || provider.apiKey || '');
  const oauth = !!provider.oauth || /^sk-ant-oat/.test(tok);
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
    headers['user-agent'] = 'helio-bot/1.0';
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
    'user-agent': 'helio-bot/1.0 (codex-transport)',
  };
  if (provider.accountId) headers['chatgpt-account-id'] = String(provider.accountId);
  if (provider.sessionId) headers.session_id = String(provider.sessionId);

  const res = await fetch(trimBase(provider.codexUrl || CODEX_RESPONSES_URL), {
    method: 'POST', headers, body: JSON.stringify(body), signal,
  });
  if (!res.ok) throw httpError('codex', res, await res.text().catch(() => ''));

  const message = { role: 'assistant', content: '', tool_calls: [] };
  const byItem = new Map(); // output item id -> tool acc
  const ct = res.headers.get('content-type') || '';

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
        const acc = newToolAcc(item.call_id || item.id, item.name);
        acc.function.arguments = item.arguments || '{}';
        message.tool_calls.push(acc);
      }
    }
    if (resp.status === 'incomplete') message.finish_reason = 'length';
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
    message.finish_reason = message.finish_reason || (message.tool_calls.length ? 'tool_calls' : 'stop');
    return message;
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
        const acc = newToolAcc(item.call_id || item.id, item.name);
        byItem.set(item.id, acc);
        message.tool_calls.push(acc);
      }
    } else if (type === 'response.function_call_arguments.delta') {
      const acc = byItem.get(ev.item_id);
      if (acc) pushToolArg(acc, ev.delta);
    } else if (type === 'response.output_item.done') {
      const item = ev.item || {};
      const acc = byItem.get(item.id);
      if (acc) {
        if (item.name && !acc.function.name) acc.function.name = item.name;
        if (item.call_id) acc.id = item.call_id;
        // A complete `arguments` string on the item is authoritative.
        if (typeof item.arguments === 'string' && item.arguments) acc.function.arguments = item.arguments;
      }
    } else if (type === 'response.completed') {
      absorb(ev.response);
    } else if (type === 'response.failed' || type === 'response.error') {
      const r = ev.response || ev;
      const e = (r && r.error) || {};
      const err = new Error('LLM codex: ' + (e.message || 'the response failed'));
      err.transient = true;
      throw err;
    }
  }
  message.finish_reason = message.finish_reason || (message.tool_calls.length ? 'tool_calls' : 'stop');
  return message;
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
      'user-agent': 'helio-bot/1.0 (google-transport)',
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
  const body = { model: provider.model, project, request, userAgent: 'helio-bot' };
  const res = await fetch(cloudcodeBase(provider) + ':streamGenerateContent?alt=sse', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: 'Bearer ' + (provider.accessToken || provider.apiKey || ''),
      'user-agent': 'helio-bot/1.0 (google-transport)',
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
// Dispatch
// ---------------------------------------------------------------------------
const ADAPTERS = {
  anthropic: anthropicChat,
  codex: codexChat,
  google: googleChat,
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
    toCodexInput, toCodexTools, toGeminiContents, geminiFinish,
    CLAUDE_UA, CODEX_RESPONSES_URL, CLOUDCODE_BASE, DEFAULT_ANTHROPIC_BASE, cloudcodeBase,
  },
};
