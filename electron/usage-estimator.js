'use strict';
/**
 * Normalized token accounting & deterministic fallback estimation.
 * Ensures every provider response (Anthropic cache splits, Codex responses,
 * Gemini usageMetadata, or gateways omitting SSE `usage`) produces an accurate
 * non-zero `prompt_tokens` / `context_tokens` count for the Context Meter.
 */

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function estimateCharsTokens(chars) {
  const n = Number(chars) || 0;
  return n > 0 ? Math.max(1, Math.ceil(n / 3.8)) : 0;
}

function messageCharLength(m) {
  if (!m || typeof m !== 'object') return 0;
  let total = 0;
  if (typeof m.content === 'string') total += m.content.length;
  else if (Array.isArray(m.content)) {
    for (const part of m.content) {
      if (!part) continue;
      if (typeof part === 'string') total += part.length;
      else if (typeof part.text === 'string') total += part.text.length;
      else if (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image') total += 4000;
      else {
        try { total += JSON.stringify(part).length; } catch (_) {}
      }
    }
  } else if (m.content != null) {
    try { total += JSON.stringify(m.content).length; } catch (_) {}
  }
  if (Array.isArray(m.tool_calls)) {
    try { total += JSON.stringify(m.tool_calls).length; } catch (_) {}
  }
  if (typeof m.reasoning_content === 'string') total += m.reasoning_content.length;
  return total;
}

function estimatePromptTokens(wireMessages = [], tools = null) {
  let chars = 0;
  for (const m of wireMessages || []) chars += messageCharLength(m);
  let toolTokens = 0;
  if (Array.isArray(tools) && tools.length) {
    try {
      const serialized = JSON.stringify(tools);
      toolTokens = estimateCharsTokens(serialized.length);
    } catch (_) {
      toolTokens = tools.length * 140;
    }
  }
  const msgTokens = estimateCharsTokens(chars);
  const total = msgTokens + toolTokens;
  return total > 0 ? Math.max(1, total) : 0;
}

function estimateAssistantTokens(msg) {
  if (!msg || typeof msg !== 'object') return 0;
  let chars = typeof msg.content === 'string' ? msg.content.length : 0;
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
    try { chars += JSON.stringify(msg.tool_calls).length; } catch (_) {}
  }
  if (typeof msg.reasoning_content === 'string') chars += msg.reasoning_content.length;
  return estimateCharsTokens(chars);
}

/**
 * Merge two usage payloads (e.g., Anthropic `message_start` + `message_delta`)
 * without wiping `input_tokens` or cache fields.
 */
function mergeUsageObjects(prev, next) {
  if (!prev || typeof prev !== 'object') return next && typeof next === 'object' ? { ...next } : null;
  if (!next || typeof next !== 'object') return { ...prev };
  const merged = { ...prev };
  for (const [k, v] of Object.entries(next)) {
    if (v == null) continue;
    if (typeof v === 'number') {
      if (v > 0 || !(k in merged)) merged[k] = v;
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Normalize vendor usage into OpenAI-compatible fields while including
 * Anthropic cache-read / cache-creation tokens in `prompt_tokens` / `input_tokens`.
 * Falls back to deterministic estimation when a provider omits `usage`.
 */
function normalizeCallUsage(rawUsage, wireMessages = [], tools = null, assistantMsg = null) {
  const u = rawUsage && typeof rawUsage === 'object' ? { ...rawUsage } : {};

  // Anthropic includes input_tokens + cache_read_input_tokens + cache_creation_input_tokens
  // for total context size fed to the model.
  const baseIn = num(u.prompt_tokens) || num(u.input_tokens);
  const cacheRead = num(u.cache_read_input_tokens);
  const cacheCreate = num(u.cache_creation_input_tokens);
  const combinedAnthropicIn = num(u.input_tokens) + cacheRead + cacheCreate;

  let promptTokens = Math.max(baseIn, combinedAnthropicIn);
  let completionTokens = num(u.completion_tokens) || num(u.output_tokens);
  const reasoningTokens = num(u.reasoning_tokens);
  let estimated = false;

  if (promptTokens <= 0 && Array.isArray(wireMessages) && wireMessages.length) {
    promptTokens = estimatePromptTokens(wireMessages, tools);
    if (promptTokens > 0) estimated = true;
  }
  if (completionTokens <= 0 && assistantMsg) {
    completionTokens = estimateAssistantTokens(assistantMsg);
    if (completionTokens > 0) estimated = true;
  }
  const totalTokens = num(u.total_tokens) > 0 && !estimated
    ? Math.max(num(u.total_tokens), promptTokens + completionTokens)
    : (promptTokens + completionTokens + reasoningTokens);

  if (promptTokens <= 0 && completionTokens <= 0 && totalTokens <= 0) return null;

  return {
    ...u,
    prompt_tokens: promptTokens,
    input_tokens: promptTokens,
    completion_tokens: completionTokens,
    output_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(cacheRead > 0 ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreate > 0 ? { cache_creation_input_tokens: cacheCreate } : {}),
    ...(reasoningTokens > 0 ? { reasoning_tokens: reasoningTokens } : {}),
    ...(estimated ? { estimated: true } : {}),
  };
}

module.exports = {
  estimateCharsTokens,
  estimatePromptTokens,
  estimateAssistantTokens,
  mergeUsageObjects,
  normalizeCallUsage,
};
