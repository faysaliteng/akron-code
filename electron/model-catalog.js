'use strict';
/**
 * Per-model context windows and the auto-compact budget derived from them.
 *
 * Why this module exists
 * ----------------------
 * `sanitizeHistory()` used to trim every conversation at a single hardcoded
 * 220 000 characters — about 55k tokens — regardless of the model. On a
 * 1M-token Gemini model that amputated working context at ~5% of the window;
 * on a small model it could still overflow. The Claude app instead compacts
 * when the *model's own* window is nearly full.
 *
 * Resolution order for a window (highest priority first):
 *   1. a live catalog registered by a provider that actually advertises it
 *      (`:fetchAvailableModels` on Antigravity returns `maxTokens` per model —
 *      verified live, 1 048 576 for Gemini and 1 000 000 for Vertex-Claude);
 *   2. an explicit `contextWindow` on the provider registry's model entry;
 *   3. the documented defaults in `RULES` below.
 *
 * Everything is pure data + pure functions: no I/O, no provider imports (a
 * require cycle through provider-oauth would break under electron-builder's
 * asar packing), so this is trivially unit-testable.
 */

// Chars per token. Prose is ~4.0, code/JSON ~3.2, so 3.4 is a deliberately
// conservative middle that never claims more room than the tokenizer will give.
const CHARS_PER_TOKEN = 3.4;

// Reserved out of the window before history is allowed to use it:
//   * the reply itself (capped so a 1M window does not reserve 100k),
//   * the system prompt plus every tool schema, which are sent on every turn
//     and are not part of `messages`.
const MAX_OUTPUT_RESERVE = 32000;
const PROMPT_RESERVE = 8000;
const MIN_USABLE_TOKENS = 8000;

// Compact at 90% of the usable budget. The headroom absorbs a tokenizer that
// counts a little differently from our estimate (images, tool JSON, CJK).
const COMPACT_RATIO = 0.9;

// Documented context windows, most specific first. A model id that matches
// nothing falls back to 128k, which is the common floor for current models.
const RULES = [
  // Antigravity's Gemini 4 codenames
  [/\bgemini-4-(carbon|neon|argon|hydrogen)\b/i, 1048576],
  // Vertex-hosted Claude through Antigravity
  [/^claude-(opus|sonnet)-5-5/, 1000000],
  [/\bgemini-3(\.\d+)?\b/i, 1048576],
  [/\bgemini-2\.5\b/i, 1048576],
  [/\bgemini/i, 1048576],
  // Anthropic first-party
  [/\bclaude-(opus|sonnet|haiku)-4/i, 200000],
  [/\bclaude|opus|sonnet|haiku/i, 200000],
  // OpenAI
  [/\bgpt-5\.[12](?:-codex)?(?:-max)?\b/i, 400000],
  [/\bgpt-5\b|\bgpt-5-codex\b/i, 400000],
  [/\bcodex\b/i, 400000],
  [/\bgpt-4\.1\b/i, 1047576],
  [/\bgpt-4o\b/i, 128000],
  [/\bgpt-4\b/i, 128000],
  [/\bo[1-4](?:-mini|-pro)?\b/i, 200000],
  // xAI
  [/\bgrok-4/i, 256000],
  [/\bgrok-3/i, 131072],
  [/\bgrok/i, 131072],
  // Open-weight / free-tier families FreeLLMAPI routes to
  [/\bkimi|moonshot/i, 256000],
  [/\bdeepseek/i, 128000],
  [/\bglm|zhipu|chatglm/i, 200000],
  [/\bqwen/i, 131072],
  [/\bllama-?3|llama-?4/i, 131072],
  [/\bmistral|mixtral|magistral/i, 131072],
  [/\bphi-?4/i, 131072],
  [/\bgemma/i, 131072],
];

// Live catalogs: providerId -> Map(modelId -> { contextWindow, label, ... }).
const live = new Map();

function norm(model) {
  return String(model || '').trim();
}

/**
 * Install a provider's live model catalog (e.g. Antigravity's
 * `:fetchAvailableModels`). Entries without a positive window are ignored so a
 * provider can never shrink the budget to zero.
 * @param {string} providerId
 * @param {Array<{id:string, label?:string, contextWindow?:number}>} models
 */
function register(providerId, models) {
  const id = String(providerId || '');
  if (!id || !Array.isArray(models)) return 0;
  const m = new Map();
  for (const entry of models) {
    const mid = norm(entry && entry.id);
    const win = Number(entry && entry.contextWindow);
    if (!mid || !Number.isFinite(win) || win <= 0) continue;
    m.set(mid, Object.assign({}, entry, { id: mid, contextWindow: win }));
  }
  if (!m.size) return 0;
  live.set(id, m);
  return m.size;
}

function clear(providerId) {
  if (providerId) live.delete(String(providerId));
  else live.clear();
}

/**
 * The context window, in tokens, for a model.
 * @param {string} model  model id (or display label; matched loosely)
 * @param {string} [providerId] provider whose live catalog should win
 * @param {number} [explicit] a window the caller already knows (provider entry)
 */
function contextWindowFor(model, providerId, explicit) {
  const id = norm(model);
  if (Number.isFinite(Number(explicit)) && Number(explicit) > 0) return Number(explicit);
  if (providerId && live.has(String(providerId)) && id) {
    const table = live.get(String(providerId));
    const hit = table.get(id);
    if (hit) return hit.contextWindow;
    // A label-based pick ("Gemini 4 Neon (High)") still resolves.
    for (const entry of table.values()) {
      if (entry.label && String(entry.label).toLowerCase() === id.toLowerCase()) return entry.contextWindow;
    }
  }
  for (const [re, win] of RULES) if (re.test(id)) return win;
  return 128000;
}

/**
 * Turn a window into the character budget `sanitizeHistory` enforces.
 * @param {number} window tokens
 * @returns {{window:number, maxChars:number, compactAt:number, reserveOut:number, promptReserve:number, usableTokens:number}}
 */
function budgetFor(window) {
  const win = Number(window) > 0 ? Number(window) : 128000;
  const reserveOut = Math.min(MAX_OUTPUT_RESERVE, Math.max(1024, Math.round(win * 0.1)));
  const usable = Math.max(MIN_USABLE_TOKENS, win - reserveOut - PROMPT_RESERVE);
  const maxChars = Math.round(usable * CHARS_PER_TOKEN);
  return {
    window: win,
    reserveOut,
    promptReserve: PROMPT_RESERVE,
    usableTokens: usable,
    maxChars,
    compactAt: Math.round(maxChars * COMPACT_RATIO),
  };
}

/** Convenience: budget straight from a model id. */
function budgetForModel(model, providerId, explicit) {
  return budgetFor(contextWindowFor(model, providerId, explicit));
}

/**
 * Compact human label for a window: `1M`, `200K`, `128K`.
 * Shown next to every model in the picker so the choice is informed.
 */
function fmtWindow(window) {
  const n = Number(window);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1000000) {
    const m = n / 1000000;
    return (Number.isInteger(m) ? String(m) : m.toFixed(1).replace(/\.0$/, '')) + 'M';
  }
  if (n >= 1000) return Math.round(n / 1000) + 'K';
  return String(n);
}

/**
 * Estimated token count for a character count, using the same ratio the budget
 * uses — so the percentage the UI shows matches what triggers compaction.
 */
function tokensForChars(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n / CHARS_PER_TOKEN);
}

/** Everything the renderer needs to label the picker. */
function snapshot() {
  const out = {};
  for (const [pid, table] of live.entries()) {
    out[pid] = Array.from(table.values());
  }
  return out;
}

module.exports = {
  CHARS_PER_TOKEN,
  RULES,
  register,
  clear,
  snapshot,
  contextWindowFor,
  budgetFor,
  budgetForModel,
  fmtWindow,
  tokensForChars,
};
