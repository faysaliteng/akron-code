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

// Compact at 80% of the usable budget. The headroom absorbs a tokenizer that
// counts a little differently from our estimate (images, tool JSON, CJK).
const COMPACT_RATIO = 0.8;

// Documented context windows, most specific first. A model id that matches
// nothing falls back to 128k, which is the common floor for current models.
// Anthropic's long-context beta (`context-1m-2025-08-07`). Anthropic documents
// it for the Sonnet 4 family only — Opus 4/4.1 and Haiku stay at 200k. We
// resolve those ids optimistically to 1M and let `anthropicChat` demote the
// window for the session if the account is not entitled, so a paying account
// never compacts at 20% of its real window.
const LONG_CONTEXT_BETA = 'context-1m-2025-08-07';
const LONG_CONTEXT_MODELS = [/(?:^|\/|\b)claude-(?:sonnet-4|opus-4[.\-]5)(?:[.\-\[]|$)/i];
const LONG_CONTEXT_WINDOW = 1000000;
const SHORT_CONTEXT_WINDOW = 200000;

/** True when this model id is served at 1M only with the beta header. */
function supportsLongContext(model) {
  const id = norm(model);
  return LONG_CONTEXT_MODELS.some((re) => re.test(id));
}

const RULES = [
  // Antigravity's Gemini 4 codenames
  [/\bgemini-4-(carbon|neon|argon|hydrogen)\b/i, 1048576],
  // Vertex-hosted Claude through Antigravity: the live catalog reports 1M, and
  // this rule keeps the budget right before the catalog has warmed.
  [/^claude-(opus|sonnet)-5-5/, 1000000],
  [/\bgemini-3(\.\d+)?\b/i, 1048576],
  [/\bgemini-2\.5\b/i, 1048576],
  [/\bgemini/i, 1048576],
  // Anthropic first-party & OpenRouter prefixed IDs + short CLI aliases ([1m]).
  // Flagship 5.x, Opus 4.5+, and Sonnet 4.x resolve to 1M; older 4.0-4.4 Opus & Haiku 4.x stay 200K.
  [/(?:^|\/|\b)claude-(?:fable|opus|sonnet|haiku)-5(?:[.\-\[]|$)/i, 1000000],
  [/(?:^|\/|\b)claude-opus-4[.\-](?:[5-9]|[1-9][0-9])(?:[.\-\[]|$)/i, 1000000],
  [/(?:^|\/|\b)claude-sonnet-4(?:[.\-\[]|$)/i, LONG_CONTEXT_WINDOW],
  [/^(?:opus|sonnet|fable)(?:\[1m\])?$|\[1m\]$/i, 1000000],
  [/\bclaude-(opus|sonnet|haiku)-4/i, SHORT_CONTEXT_WINDOW],
  [/\bclaude|opus|sonnet|haiku/i, SHORT_CONTEXT_WINDOW],
  // OpenAI
  [/\bgpt-5[.-](?:[4-9]|1[0-9])\b|\bgpt-6\b/i, 1000000],
  [/\bgpt-5\.[12](?:-codex)?(?:-max)?\b/i, 400000],
  [/\bgpt-5\b|\bgpt-5-codex\b/i, 400000],
  [/\bcodex\b/i, 400000],
  [/\bgpt-4\.1\b/i, 1047576],
  [/\bgpt-4o\b/i, 128000],
  [/\bgpt-4\b/i, 128000],
  [/\bo[1-4](?:-mini|-pro)?\b/i, 200000],
  // xAI — fast variants are 2M, Grok 4.5+ is 1M, base Grok 4 / build is 256k.
  [/\bgrok-(?:[0-9.]+-)?(?:(?:code|build)-)?fast\b/i, 2000000],
  [/\bgrok-(?:4\.(?:[5-9]|[1-9][0-9])|[5-9](?:\.\d+)?)\b/i, 1000000],
  [/\bgrok-build\b/i, 256000],
  [/\bgrok-4/i, 256000],
  [/\bgrok-3/i, 131072],
  [/\bgrok/i, 131072],
  // Open-weight / Moonshot Kimi K3 / Z.ai GLM-5* (1M) & standard open-weight rules
  [/\bkimi-k3(?:\.1-pro(?:-highspeed)?|-[a-z0-9.-]+)?\b/i, 1048576],
  [/\bglm-5(?:[.\-][a-z0-9.\-]+)?\b/i, 1000000],
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
// Full live inventory (including zero-window entries from vendors that omit max input tokens)
const inventory = new Map();

// Session-scoped corrections: `provider::model` -> window. A provider that
// advertises a window it will not actually serve (a beta the account is not
// entitled to) is recorded here after the first refusal, so the session stops
// compacting against a promise the endpoint does not keep.
const overrides = new Map();

function norm(model) {
  return String(model || '').trim();
}

/**
 * Install a provider's live model catalog (e.g. Antigravity's
 * `:fetchAvailableModels`). Entries without a positive window are ignored in
 * `live` (returned count & snapshot) so a provider can never shrink the budget
 * to zero, while `inventory` tracks the full capability/model roster.
 * @param {string} providerId
 * @param {Array<{id:string, label?:string, contextWindow?:number}>} models
 */
function register(providerId, models) {
  const id = String(providerId || '');
  if (!id || !Array.isArray(models)) return 0;
  const m = new Map();
  const inv = new Map();
  for (const entry of models) {
    const mid = norm(entry && entry.id);
    if (!mid) continue;
    const win = Number(entry && entry.contextWindow);
    inv.set(mid, Object.assign({}, entry, { id: mid, contextWindow: Number.isFinite(win) && win > 0 ? win : 0 }));
    if (Number.isFinite(win) && win > 0) {
      m.set(mid, Object.assign({}, entry, { id: mid, contextWindow: win }));
    }
  }
  if (inv.size) inventory.set(id, inv);
  if (!m.size) return 0;
  live.set(id, m);
  return m.size;
}

function clear(providerId) {
  if (providerId) {
    live.delete(String(providerId));
    inventory.delete(String(providerId));
  } else {
    live.clear();
    inventory.clear();
  }
}

function hasLiveCatalog(providerId) {
  const pid = String(providerId || '');
  return !!(pid && ((inventory.has(pid) && inventory.get(pid).size > 0) || (live.has(pid) && live.get(pid).size > 0)));
}

function getLiveEntry(model, providerId) {
  const id = norm(model);
  const pid = String(providerId || '');
  if (!id) return null;
  if (pid) {
    const table = inventory.get(pid) || live.get(pid);
    if (!table) return null;
    if (table.has(id)) return table.get(id);
    for (const entry of table.values()) {
      if (entry.label && String(entry.label).toLowerCase() === id.toLowerCase()) return entry;
    }
    return null;
  }
  for (const table of inventory.values()) {
    if (table.has(id)) return table.get(id);
  }
  for (const table of live.values()) {
    if (table.has(id)) return table.get(id);
  }
  return null;
}

function isModelAvailable(providerId, model) {
  const pid = String(providerId || '');
  const id = norm(model);
  if (!pid || !id || /^(auto|fast|smart|fusion|default|free|akron-.*)$/i.test(id)) return true;
  if (!hasLiveCatalog(pid)) return true;
  return !!getLiveEntry(id, pid);
}

function resolveReplacementModel(providerId, missingModel) {
  const pid = String(providerId || '');
  const id = norm(missingModel);
  if (!pid || !hasLiveCatalog(pid)) return null;
  const table = inventory.get(pid) || live.get(pid);
  const list = table ? Array.from(table.values()) : [];
  if (!list.length) return null;
  const exact = getLiveEntry(id, pid);
  if (exact) return exact;

  const base = id.toLowerCase().replace(/-(?:minimal|low|medium|high|xhigh)$/i, '');
  const tierRank = (m) => {
    const s = String(m || '').toLowerCase();
    if (/-xhigh$/.test(s)) return 4;
    if (/-high$/.test(s)) return 3;
    if (/-medium$/.test(s)) return 2;
    if (/-low$/.test(s)) return 1;
    return 0;
  };
  // 1. Exact base family (e.g. gemini-4-carbon-medium removed -> gemini-4-carbon-high / gemini-4-carbon)
  const sameBase = list.filter((e) => e.id.toLowerCase().replace(/-(?:minimal|low|medium|high|xhigh)$/i, '') === base);
  if (sameBase.length) {
    sameBase.sort((a, b) => tierRank(b.id) - tierRank(a.id));
    return sameBase[0];
  }
  // 2. Same model line prefix (e.g. claude-sonnet-4-5 -> newest claude-sonnet-*, gemini-4-* -> newest gemini-4-*)
  const famMatch = base.match(/^(claude-(?:opus|sonnet|haiku|fable)|gemini-[0-9.]+|gpt-[0-9.]+|grok-[0-9.]+|kimi-k[0-9.]+|glm-[0-9.]+|deepseek)/i);
  if (famMatch) {
    const fam = famMatch[1].toLowerCase();
    const sameFam = list.filter((e) => e.id.toLowerCase().startsWith(fam));
    if (sameFam.length) {
      sameFam.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true, sensitivity: 'base' }));
      return sameFam[0];
    }
  }
  // 3. Same vendor family or recommended model
  const wantGroup = /claude/i.test(base) ? 'Claude' : (/gemini/i.test(base) ? 'Gemini' : '');
  const sameGroup = wantGroup ? list.filter((e) => String(e.group || '').toLowerCase() === wantGroup.toLowerCase()) : [];
  const pool = sameGroup.length ? sameGroup : list;
  return pool.find((e) => e.recommended) || pool[0];
}

function thinkingCapabilitiesFor(model, providerId) {
  const id = norm(model);
  if (!id || /^(auto|fast|smart|fusion|default|free|akron-.*)$/i.test(id)) {
    return { supported: true, levels: ['auto', 'low', 'medium', 'high'], variants: null, discrete: false };
  }
  const liveEntry = getLiveEntry(id, providerId);
  if (liveEntry) {
    const variants = liveEntry.thinkingVariants && Object.keys(liveEntry.thinkingVariants).length
      ? { ...liveEntry.thinkingVariants }
      : null;
    const discrete = !!variants;
    let levels = Array.isArray(liveEntry.thinkingLevels) ? liveEntry.thinkingLevels.slice() : [];
    const supported = liveEntry.thinking !== undefined ? !!liveEntry.thinking : (levels.length > 0 || discrete);
    if (supported && !levels.length) {
      if (variants) {
        const order = ['minimal', 'low', 'medium', 'high', 'xhigh'].filter((k) => variants[k]);
        levels = ['auto', ...order];
      } else {
        levels = ['auto', 'low', 'medium', 'high'];
      }
    }
    return { supported, levels: supported ? levels : [], variants, discrete };
  }
  // Heuristic fallback before live catalog warms or for API-key endpoints
  const nonThinking = /\b(gpt-4o(?:-mini)?|gpt-4-turbo|gpt-3\.5|claude-3-(?:haiku|sonnet|opus)|claude-2|llama-?3\.[0-3]?|mistral-7b)\b/i;
  if (nonThinking.test(id)) return { supported: false, levels: [], variants: null, discrete: false };
  const hasXHigh = /\b(gpt-5\.[1-9]|codex|claude-opus-5|gemini-4-neon|gemini-4-hydrogen)\b|-xhigh$/i.test(id);
  const discreteSuffix = /-(minimal|low|medium|high|xhigh)$/i.exec(id);
  if (discreteSuffix) {
    return {
      supported: true,
      levels: hasXHigh ? ['auto', 'low', 'medium', 'high', 'xhigh'] : ['auto', 'low', 'medium', 'high'],
      variants: null,
      discrete: true,
    };
  }
  const thinkingCapable = /^(?:gemini-(?:2\.5|[3-9])|claude-(?:opus|sonnet|fable)-(?:3-7|[4-9])|claude-haiku-(?:4-5|[5-9])|o[1-9]|gpt-[5-9]|codex|grok-[3-9]|deepseek-(?:r1|reasoner)|qwq|kimi-k[23]|glm-5)/i.test(id);
  return {
    supported: thinkingCapable,
    levels: thinkingCapable ? (hasXHigh ? ['auto', 'low', 'medium', 'high', 'xhigh'] : ['auto', 'low', 'medium', 'high']) : [],
    variants: null,
    discrete: false,
  };
}

/** Rule-only floor lookup so stale caches/registries cannot under-cap 1M+ flagship models. */
function ruleContextWindowFor(model) {
  const id = norm(model);
  if (!id) return 128000;
  for (const [re, win] of RULES) if (re.test(id)) return win;
  return 128000;
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
  const pid = String(providerId || '');
  // A demoted/session-pinned window wins over both the live catalog and RULES:
  // it exists precisely because one of those made a claim that did not hold.
  const pinned = id ? overrides.get(pid + '::' + id) : null;
  if (Number.isFinite(pinned) && pinned > 0) return pinned;
  if (providerId && live.has(String(providerId)) && id) {
    const table = live.get(String(providerId));
    const hit = table.get(id);
    if (hit) return hit.contextWindow;
    // A label-based pick ("Gemini 4 Neon (High)") still resolves.
    for (const entry of table.values()) {
      if (entry.label && String(entry.label).toLowerCase() === id.toLowerCase()) return entry.contextWindow;
    }
  }
  return ruleContextWindowFor(id);
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
 * Pin the window used for one model in this session (either direction).
 * @returns {number} the pinned window, or 0 when the input was unusable
 */
function setWindow(providerId, model, window) {
  const id = norm(model);
  const win = Number(window);
  if (!id || !Number.isFinite(win) || win <= 0) return 0;
  overrides.set(String(providerId || '') + '::' + id, win);
  return win;
}

/**
 * Shrink a window after the endpoint refused it. Never raises it: a demotion is
 * a correction, not a preference.
 * @returns {number} the window now in force
 */
function demote(providerId, model, window) {
  const id = norm(model);
  const win = Number(window);
  if (!id || !Number.isFinite(win) || win <= 0) return contextWindowFor(model, providerId);
  const cur = contextWindowFor(id, providerId);
  if (win >= cur) return cur;
  overrides.set(String(providerId || '') + '::' + id, win);
  return win;
}

/** Drop session pins (all, or just one provider's). */
function clearWindows(providerId) {
  if (providerId === undefined) { overrides.clear(); return 0; }
  const prefix = String(providerId || '') + '::';
  let n = 0;
  for (const k of [...overrides.keys()]) {
    if (k.startsWith(prefix)) { overrides.delete(k); n++; }
  }
  return n;
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
  COMPACT_RATIO,
  RULES,
  LONG_CONTEXT_BETA,
  LONG_CONTEXT_WINDOW,
  SHORT_CONTEXT_WINDOW,
  supportsLongContext,
  register,
  clear,
  hasLiveCatalog,
  getLiveEntry,
  isModelAvailable,
  resolveReplacementModel,
  thinkingCapabilitiesFor,
  snapshot,
  ruleContextWindowFor,
  contextWindowFor,
  budgetFor,
  budgetForModel,
  setWindow,
  demote,
  clearWindows,
  fmtWindow,
  tokensForChars,
};
