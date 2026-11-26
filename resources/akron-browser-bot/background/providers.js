// Provider adapters. Each adapter speaks the canonical message format used by
// the agent loop and translates to/from a vendor API.
//
// Canonical message shapes:
//   { role: "user",      content: string, image?: dataUrl, images?: dataUrl[] }
//   { role: "assistant", content: string, toolCalls?: [{ id, name, args }] }
//   { role: "tool",      toolCallId: string, name: string, content: string, isError?: boolean }

function userImages(m) {
  const list = [];
  if (m?.image) list.push(m.image);
  if (Array.isArray(m?.images)) {
    for (const img of m.images) if (img) list.push(img);
  }
  return list;
}

function joinUrl(base, path) {
  const b = String(base || "").replace(/\/+$/, "");
  return b + path;
}

export class ProviderError extends Error {
  constructor(status, detail, { retryAfterMs = 0, kind = "" } = {}) {
    super(`HTTP ${status}${detail ? `: ${readableDetail(detail)}` : ""}`);
    this.name = "ProviderError";
    this.status = Number(status) || 0;
    this.detail = detail;
    this.retryAfterMs = retryAfterMs;
    this.kind = kind;
  }
}

export function isProviderError(error) {
  return error instanceof ProviderError || error?.name === "ProviderError";
}

function parseRetryAfter(res) {
  try {
    const raw = res?.headers?.get?.("retry-after");
    if (!raw) return 0;
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  } catch {}
  return 0;
}

// Google sends no Retry-After header; the wait is only in the error text
// ("Please retry in 17h29m15.08s."). Groq words it "Please try again in 7.66s".
const RETRY_IN_TEXT = /(?:retry|try again) in ((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i;
const DURATION_UNIT_MS = { h: 3600000, m: 60000, s: 1000, ms: 1 };

function retryDelayFromText(detail) {
  const match = String(detail || "").match(RETRY_IN_TEXT);
  if (!match) return 0;
  let total = 0;
  for (const [, amount, unit] of match[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(amount) * DURATION_UNIT_MS[unit];
  }
  return Math.round(total);
}

function extractNestedMessage(input, depth = 0) {
  const s = String(input || "").trim();
  if (!s || depth > 4) return s;
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      const json = JSON.parse(s);
      const inner =
        json?.error?.message ??
        json?.error?.error?.message ??
        json?.detail ??
        json?.title ??
        json?.message ??
        (typeof json?.error === "string" ? json.error : "");
      if (inner != null && String(inner).trim()) {
        return extractNestedMessage(inner, depth + 1);
      }
    } catch {}
  }
  return s;
}

function readableDetail(detail) {
  const text = String(detail || "").trim();
  if (!text) return "";
  const value = extractNestedMessage(text, 0) || text;
  return String(value).replace(/\s+/g, " ").trim().slice(0, 260);
}

async function readErrorDetail(res) {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail =
        json?.error?.message ||
        json?.error?.error?.message ||
        json?.detail ||
        json?.title ||
        json?.message ||
        text;
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  return detail;
}

function errorKind(status, detail) {
  const lower = String(detail || "").toLowerCase();
  if (status === 429 || /rate.?limit|quota|too many requests|resource_exhausted/.test(lower)) {
    return "rate_limit";
  }
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 400 || status === 422) return "bad_request";
  if (status >= 500 || status === 529) return "server";
  return "";
}

export async function providerError(res) {
  const detail = await readErrorDetail(res);
  return new ProviderError(res.status, detail, {
    retryAfterMs: parseRetryAfter(res) || retryDelayFromText(detail),
    kind: errorKind(res.status, detail),
  });
}

async function readError(res) {
  return (await providerError(res)).message;
}

function parseDataUrl(dataUrl) {
  const m = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,(.*)$/.exec(
    dataUrl || ""
  );
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

/* ------------------------------------------------------------------ */
/* Anthropic                                                           */
/* ------------------------------------------------------------------ */

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = userImages(m);
      if (imgs.length) {
        const content = [];
        if (m.content) content.push({ type: "text", text: m.content });
        for (const raw of imgs) {
          const img = parseDataUrl(raw);
          if (img)
            content.push({
              type: "image",
              source: { type: "base64", media_type: img.mimeType, data: img.data },
            });
        }
        out.push({ role: "user", content });
      } else {
        out.push({ role: "user", content: m.content || "" });
      }
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls || []) {
        content.push({
          type: "tool_use",
          id: tc.id,
          name: tc.name,
          input: tc.args || {},
        });
      }
      if (!content.length) content.push({ type: "text", text: "" });
      out.push({ role: "assistant", content });
    } else if (m.role === "tool") {
      const block = {
        type: "tool_result",
        tool_use_id: m.toolCallId,
        content: m.content || "",
        ...(m.isError ? { is_error: true } : {}),
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === "tool_result")
      ) {
        last.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
    }
  }
  return out;
}

async function anthropicChat({ config, messages, tools, system, model, signal, settings }) {
  const body = {
    model,
    max_tokens: Number(config.maxTokens) || 4096,
    temperature:
      typeof settings?.temperature === "number" ? settings.temperature : 0.7,
    system,
    messages: toAnthropicMessages(messages),
    tools: (tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
  };

  const res = await fetch(joinUrl(config.baseUrl || "https://api.anthropic.com", "/v1/messages"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": config.apiKey || "",
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await providerError(res);
  const data = await res.json();

  let text = "";
  const toolCalls = [];
  for (const block of data.content || []) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use")
      toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
  }
  return { text, toolCalls, stopReason: data.stop_reason };
}

/* ------------------------------------------------------------------ */
/* OpenAI + OpenAI-compatible                                          */
/* ------------------------------------------------------------------ */

// DeepSeek and Kimi need their reasoning sent back with a tool call. Groq
// answers HTTP 400 when a step made by another provider (after a failover)
// still carries it. A host that refused it once is remembered, so the same
// request is not sent twice on every later step.
const hostsRefusingReasoning = new Set();

function isReasoningRejection(error) {
  const text = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return (
    [400, 422].includes(Number(error?.status)) &&
    text.includes("reasoning_content") &&
    /unsupported|not supported|unknown|unexpected|unrecognized|not allowed|not permitted|extra/.test(text) &&
    !/missing|required/.test(text)
  );
}

function hasReasoning(messages) {
  return messages.some((m) => m.role === "assistant" && m.reasoning);
}

function toOpenAIMessages(messages, system, { keepReasoning = true } = {}) {
  const out = [{ role: "system", content: system }];
  for (const m of messages) {
    if (m.role === "user") {
      const imgs = userImages(m);
      if (imgs.length) {
        out.push({
          role: "user",
          content: [
            { type: "text", text: m.content || "" },
            ...imgs.map((url) => ({ type: "image_url", image_url: { url } })),
          ],
        });
      } else {
        out.push({ role: "user", content: m.content || "" });
      }
    } else if (m.role === "assistant") {
      const msg = { role: "assistant", content: m.content || "" };
      if (keepReasoning && m.reasoning) msg.reasoning_content = m.reasoning;
      if (m.toolCalls && m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: m.content || "",
      });
    }
  }
  return out;
}

async function openaiChat({
  config,
  messages,
  tools,
  system,
  model,
  signal,
  settings,
  imagesStripped = false,
  reasoningStripped = false,
}) {
  const base = config.baseUrl || "https://api.openai.com/v1";
  const keepReasoning = !reasoningStripped && !hostsRefusingReasoning.has(base);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey || ""}`,
  };
  if (/openrouter\.ai/i.test(base)) {
    headers["HTTP-Referer"] = "https://autobot.local";
    headers["X-Title"] = "Akron Browser Bot by akronlogic.com";
  }

  // Reasoning models (OpenAI o1/o3/o4, DeepSeek reasoner, …) reject or ignore
  // sampling temperature, so omit it for them.
  const isReasoning =
    /^(o1|o3|o4)([-.]|$)/i.test(String(model)) ||
    /reasoner|reasoning/i.test(String(model));

  const body = {
    model,
    messages: toOpenAIMessages(messages, system, { keepReasoning }),
  };
  if (!isReasoning) {
    body.temperature =
      typeof settings?.temperature === "number" ? settings.temperature : 0.7;
  }
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(joinUrl(base, "/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const error = await providerError(res);
    if (keepReasoning && hasReasoning(messages) && isReasoningRejection(error)) {
      const retried = await openaiChat({
        config,
        messages,
        tools,
        system,
        model,
        signal,
        settings,
        imagesStripped,
        reasoningStripped: true,
      });
      hostsRefusingReasoning.add(base);
      return retried;
    }
    if (!imagesStripped && hasImages(messages) && isVisionRejection(error)) {
      const retried = await openaiChat({
        config,
        messages: withoutImages(messages),
        tools,
        system,
        model,
        signal,
        settings,
        imagesStripped: true,
      });
      retried.text = `This model cannot view images, so the picture was left out. ${retried.text || ""}`.trim();
      return retried;
    }
    throw error;
  }
  const data = await res.json();
  const message = data?.choices?.[0]?.message || {};

  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    text = message.content
      .map((p) => (typeof p === "string" ? p : p?.text || ""))
      .join("");
  }

  const toolCalls = (message.tool_calls || []).map((tc) => parseToolCall(tc));

  return {
    text,
    toolCalls,
    reasoning: typeof message.reasoning_content === "string" ? message.reasoning_content : "",
    stopReason: data?.choices?.[0]?.finish_reason,
  };
}

function parseToolArguments(raw) {
  if (raw && typeof raw === "object") return raw;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function parseToolCall(tc) {
  return {
    id: tc?.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    name: tc?.function?.name || tc?.name || "unknown",
    args: parseToolArguments(tc?.function?.arguments ?? tc?.arguments),
  };
}

function hasImages(messages) {
  return (messages || []).some((message) => userImages(message).length > 0);
}

function withoutImages(messages) {
  return (messages || []).map((message) => {
    if (!message || message.role !== "user") return message;
    if (!message.image && !message.images) return message;
    const copy = { ...message };
    delete copy.image;
    delete copy.images;
    return copy;
  });
}

function isVisionRejection(error) {
  const text = `${error?.message || ""} ${error?.detail || ""}`.toLowerCase();
  return Number(error?.status) === 400 && /image|vision|multimodal|image_url/.test(text);
}

/* ------------------------------------------------------------------ */
/* Google Gemini                                                       */
/* ------------------------------------------------------------------ */

// Gemini 3 and later return a signature with a tool call and answer HTTP 400
// ("Function call is missing a thought_signature") unless it comes back with
// that call. A call made by another provider (after a failover) has none, so
// the first call of such a step carries the stand-in Google documents for
// exactly this case. Older models and Gemma do not check signatures.
const GEMINI_SIGNATURE_STANDIN = "skip_thought_signature_validator";
const GEMINI_WITHOUT_SIGNATURES = /^(models\/)?(gemini-[12][.-]|gemma)/i;

function geminiToolCallParts(toolCalls, model) {
  const standIn = GEMINI_WITHOUT_SIGNATURES.test(String(model || "")) ? "" : GEMINI_SIGNATURE_STANDIN;
  return (toolCalls || []).map((tc, index) => {
    const part = { functionCall: { name: tc.name, args: tc.args || {} } };
    const signature = tc.thoughtSignature || (index === 0 ? standIn : "");
    return signature ? { ...part, thoughtSignature: signature } : part;
  });
}

// Splits one reply's parts into what the user sees, the model's private
// thinking, and its tool calls (each keeping its signature).
function readGeminiParts(parts) {
  let text = "";
  let reasoning = "";
  const toolCalls = [];
  for (const part of parts || []) {
    if (part.text && part.thought) reasoning += part.text;
    else if (part.text) text += part.text;
    if (part.functionCall) {
      const call = {
        id: `call_${Math.random().toString(36).slice(2, 10)}`,
        name: part.functionCall.name,
        args: part.functionCall.args || {},
      };
      toolCalls.push(part.thoughtSignature ? { ...call, thoughtSignature: part.thoughtSignature } : call);
    }
  }
  return { text, reasoning, toolCalls };
}

function toGeminiContents(messages, model) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      for (const raw of userImages(m)) {
        const img = parseDataUrl(raw);
        if (img)
          parts.push({
            inlineData: { mimeType: img.mimeType, data: img.data },
          });
      }
      if (!parts.length) parts.push({ text: "" });
      out.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const parts = [];
      if (m.content) parts.push({ text: m.content });
      parts.push(...geminiToolCallParts(m.toolCalls, model));
      if (!parts.length) parts.push({ text: "" });
      out.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const part = {
        functionResponse: {
          name: m.name,
          response: { result: m.content || "" },
        },
      };
      const last = out[out.length - 1];
      if (
        last &&
        last.role === "user" &&
        Array.isArray(last.parts) &&
        last.parts.every((p) => p.functionResponse)
      ) {
        last.parts.push(part);
      } else {
        out.push({ role: "user", parts: [part] });
      }
    }
  }
  return out;
}

async function geminiChat({ config, messages, tools, system, model, signal, settings }) {
  const base = config.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const url = joinUrl(
    base,
    `/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(
      config.apiKey || ""
    )}`
  );

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages, model),
    generationConfig: {
      temperature:
        typeof settings?.temperature === "number" ? settings.temperature : 0.7,
      maxOutputTokens: Number(config.maxTokens) || 4096,
    },
  };
  if (tools && tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await providerError(res);
  const data = await res.json();
  const cand = data?.candidates?.[0];
  return { ...readGeminiParts(cand?.content?.parts), stopReason: cand?.finishReason };
}

/* ------------------------------------------------------------------ */
/* Streaming                                                           */
/* ------------------------------------------------------------------ */

// `onActivity` is called for every event that arrives, whatever is in it: the
// caller uses it to tell an answer that is still coming from one that stopped.
async function readSSE(res, onData, onActivity) {
  if (!res.body || typeof res.body.getReader !== "function") {
    const text = await res.text();
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (d && d !== "[DONE]") onData(d);
    }
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const d = line.slice(5).trim();
      if (!d) continue;
      if (d === "[DONE]") return;
      onActivity?.();
      onData(d);
    }
  }
}

async function anthropicChatStream({
  config,
  messages,
  tools,
  system,
  model,
  signal,
  settings,
  onDelta,
  onActivity,
}) {
  const body = {
    model,
    max_tokens: Number(config.maxTokens) || 4096,
    temperature:
      typeof settings?.temperature === "number" ? settings.temperature : 0.7,
    system,
    messages: toAnthropicMessages(messages),
    stream: true,
    tools: (tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
  };

  const res = await fetch(
    joinUrl(config.baseUrl || "https://api.anthropic.com", "/v1/messages"),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": config.apiKey || "",
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    }
  );

  if (!res.ok) throw await providerError(res);

  let text = "";
  let stopReason = null;
  const toolBlocks = new Map();

  await readSSE(res, (data) => {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    if (ev.type === "content_block_start") {
      const b = ev.content_block;
      if (b?.type === "tool_use") {
        toolBlocks.set(ev.index, { id: b.id, name: b.name, json: "" });
      }
    } else if (ev.type === "content_block_delta") {
      const d = ev.delta;
      if (d?.type === "text_delta" && d.text) {
        text += d.text;
        onDelta?.(d.text);
      } else if (d?.type === "input_json_delta") {
        const tb = toolBlocks.get(ev.index);
        if (tb) tb.json += d.partial_json || "";
      }
    } else if (ev.type === "message_delta" && ev.delta?.stop_reason) {
      stopReason = ev.delta.stop_reason;
    }
  }, onActivity);

  const toolCalls = [];
  for (const tb of toolBlocks.values()) {
    let args = {};
    try {
      args = tb.json ? JSON.parse(tb.json) : {};
    } catch {
      args = {};
    }
    toolCalls.push({ id: tb.id, name: tb.name, args });
  }

  return { text, toolCalls, stopReason };
}

async function openaiChatStream({
  config,
  messages,
  tools,
  system,
  model,
  signal,
  settings,
  onDelta,
  onThinking,
  onActivity,
  imagesStripped = false,
  reasoningStripped = false,
}) {
  const base = config.baseUrl || "https://api.openai.com/v1";
  const keepReasoning = !reasoningStripped && !hostsRefusingReasoning.has(base);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${config.apiKey || ""}`,
  };
  if (/openrouter\.ai/i.test(base)) {
    headers["HTTP-Referer"] = "https://autobot.local";
    headers["X-Title"] = "Akron Browser Bot by akronlogic.com";
  }

  const isReasoning =
    /^(o1|o3|o4)([-.]|$)/i.test(String(model)) ||
    /reasoner|reasoning/i.test(String(model));

  const body = {
    model,
    messages: toOpenAIMessages(messages, system, { keepReasoning }),
    stream: true,
  };
  if (!isReasoning) {
    body.temperature =
      typeof settings?.temperature === "number" ? settings.temperature : 0.7;
  }
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    body.tool_choice = "auto";
  }

  const res = await fetch(joinUrl(base, "/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const error = await providerError(res);
    if (keepReasoning && hasReasoning(messages) && isReasoningRejection(error)) {
      const retried = await openaiChatStream({
        config,
        messages,
        tools,
        system,
        model,
        signal,
        settings,
        onDelta,
        onThinking,
        onActivity,
        imagesStripped,
        reasoningStripped: true,
      });
      hostsRefusingReasoning.add(base);
      return retried;
    }
    if (!imagesStripped && hasImages(messages) && isVisionRejection(error)) {
      const retried = await openaiChatStream({
        config,
        messages: withoutImages(messages),
        tools,
        system,
        model,
        signal,
        settings,
        onDelta,
        onThinking,
        onActivity,
        imagesStripped: true,
      });
      retried.text = `This model cannot view images, so the picture was left out. ${retried.text || ""}`.trim();
      return retried;
    }
    throw error;
  }

  let text = "";
  let reasoning = "";
  let stopReason = null;
  const calls = new Map();

  await readSSE(res, (data) => {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const choice = ev.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || {};

    if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      onThinking?.(delta.reasoning_content);
    }
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      onDelta?.(delta.content);
    } else if (Array.isArray(delta.content)) {
      for (const part of delta.content) {
        if (part?.text) {
          text += part.text;
          onDelta?.(part.text);
        }
      }
    }

    for (const tc of delta.tool_calls || []) {
      const idx = tc.index ?? 0;
      const cur = calls.get(idx) || { id: "", name: "", args: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") cur.args += tc.function.arguments;
      else if (tc.function?.arguments && typeof tc.function.arguments === "object") {
        cur.args += JSON.stringify(tc.function.arguments);
      }
      calls.set(idx, cur);
    }

    if (choice.finish_reason) stopReason = choice.finish_reason;
  }, onActivity);

  const toolCalls = [...calls.values()]
    .filter((c) => c.name)
    .map((c) => {
      let args = {};
      try {
        args = c.args ? JSON.parse(c.args) : {};
      } catch {
        args = {};
      }
      return {
        id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: c.name,
        args,
      };
    });

  return { text, toolCalls, reasoning, stopReason };
}

async function geminiChatStream({
  config,
  messages,
  tools,
  system,
  model,
  signal,
  settings,
  onDelta,
  onThinking,
  onActivity,
}) {
  const base = config.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
  const url = joinUrl(
    base,
    `/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
      config.apiKey || ""
    )}`
  );

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: toGeminiContents(messages, model),
    generationConfig: {
      temperature:
        typeof settings?.temperature === "number" ? settings.temperature : 0.7,
      maxOutputTokens: Number(config.maxTokens) || 4096,
    },
  };
  if (tools && tools.length) {
    body.tools = [
      {
        functionDeclarations: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw await providerError(res);

  let text = "";
  let reasoning = "";
  let stopReason = null;
  const toolCalls = [];

  await readSSE(res, (data) => {
    let ev;
    try {
      ev = JSON.parse(data);
    } catch {
      return;
    }
    const cand = ev.candidates?.[0];
    if (!cand) return;
    const chunk = readGeminiParts(cand.content?.parts);
    if (chunk.text) {
      text += chunk.text;
      onDelta?.(chunk.text);
    }
    reasoning += chunk.reasoning;
    if (chunk.reasoning) onThinking?.(chunk.reasoning);
    toolCalls.push(...chunk.toolCalls);
    if (cand.finishReason) stopReason = cand.finishReason;
  }, onActivity);

  return { text, toolCalls, reasoning, stopReason };
}

/* ------------------------------------------------------------------ */
/* Factory + test helper                                               */
/* ------------------------------------------------------------------ */

export function createProvider(config) {
  const type = config.type || "openai-compatible";
  return {
    chat(opts) {
      if (type === "anthropic") return anthropicChat({ ...opts, config });
      if (type === "gemini") return geminiChat({ ...opts, config });
      return openaiChat({ ...opts, config });
    },
    chatStream(opts) {
      if (type === "anthropic") return anthropicChatStream({ ...opts, config });
      if (type === "gemini") return geminiChatStream({ ...opts, config });
      return openaiChatStream({ ...opts, config });
    },
  };
}

export async function listModels(config) {
  const type = config.type || "openai-compatible";
  const base = config.baseUrl || "";

  if (type === "anthropic") {
    const res = await fetch(
      joinUrl(base || "https://api.anthropic.com", "/v1/models?limit=100"),
      {
        method: "GET",
        headers: {
          "x-api-key": config.apiKey || "",
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
      }
    );
    if (!res.ok) throw await providerError(res);
    const data = await res.json();
    return (data?.data || []).map((m) => m.id).filter(Boolean);
  }

  if (type === "gemini") {
    const url = joinUrl(
      base || "https://generativelanguage.googleapis.com/v1beta",
      `/models?key=${encodeURIComponent(config.apiKey || "")}`
    );
    const res = await fetch(url, { method: "GET" });
    if (!res.ok) throw await providerError(res);
    const data = await res.json();
    return (data?.models || [])
      .filter(
        (m) =>
          !m.supportedGenerationMethods ||
          m.supportedGenerationMethods.includes("generateContent")
      )
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  }

  const headers = { authorization: `Bearer ${config.apiKey || ""}` };
  if (/openrouter\.ai/i.test(base)) {
    headers["HTTP-Referer"] = "https://autobot.local";
    headers["X-Title"] = "Akron Browser Bot by akronlogic.com";
  }
  const res = await fetch(joinUrl(base || "https://api.openai.com/v1", "/models"), {
    method: "GET",
    headers,
  });
  if (!res.ok) throw await providerError(res);
  const data = await res.json();
  const arr = Array.isArray(data) ? data : data?.data || [];
  return arr.map((m) => (typeof m === "string" ? m : m?.id)).filter(Boolean);
}

export async function testProvider(config, model) {
  const provider = createProvider(config);
  const res = await provider.chat({
    messages: [
      { role: "user", content: "Reply with exactly: OK" },
    ],
    tools: [],
    system: "You are a connection test. Reply with the single word OK.",
    model: model || config.defaultModel || (config.models || [])[0],
    settings: { temperature: 0 },
  });
  return (res.text || "").trim() || "(empty response)";
}
