'use strict';
/**
 * Smart Task-Complexity Router & Dedicated DeepSeek V4.1 Flash Dispatcher (`Auto` mode).
 *
 * Pipeline:
 *   Fast-path (<2ms): Vision attachments -> `vision` tier; >120K tokens -> 1M `longctx` tier;
 *                     explicit image/video/audio prompts -> media workflow tiers.
 *   Dispatcher (~150ms, bounded 600ms): DeepSeek V4.1 Flash (`deepseek-v4-flash` with automatic
 *                     `deepseek-chat` alias fallback) reads the live signed-in roster and
 *                     returns `{ role, complexity, model, reason }` JSON.
 *   Fallback (<1ms): Deterministic complexity scorer when DeepSeek key is absent, offline,
 *                    or times out — ensuring `Auto` mode never fails a turn.
 */

const orchRouter = require('./orch-router');
const gateMod = require('./provider-gate');
const defaultModelCatalog = require('./model-catalog');

const DEFAULT_AUTO_ROUTER_CONFIG = {
  source: 'openrouter_free',
  baseURL: 'https://api.deepseek.com/v1',
  model: 'deepseek-v4-flash',
};

const AUTO_SWITCH_SOURCES = {
  openrouter_free: {
    id: 'openrouter_free',
    label: 'OpenRouter Free API',
    baseURL: 'https://openrouter.ai/api/v1',
    model: 'deepseek/deepseek-v4.1-flash:free',
    fallbackModels: ['deepseek/deepseek-chat:free', 'deepseek/deepseek-v3:free'],
    secretKey: 'autobot.autoswitch.openrouter_key',
    costPerDecisionUsd: 0,
    extraHeaders: { 'HTTP-Referer': 'https://akronlogic.com', 'X-Title': 'Akron Code' },
  },
  deepseek_api: {
    id: 'deepseek_api',
    label: 'DeepSeek Platform API',
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    fallbackModels: ['deepseek-chat'],
    secretKey: 'autobot.autoswitch.deepseek_key',
    legacySecretKey: 'deepseek-router:apiKey',
    costPerDecisionUsd: 0.000025,
    extraHeaders: {},
  },
  freellmapi: {
    id: 'freellmapi',
    label: 'FreeLLMAPI Unified Key',
    baseURL: 'http://127.0.0.1:31415/v1',
    fallbackBaseURL: 'http://127.0.0.1:3001/v1',
    model: 'deepseek-v4-flash',
    fallbackModels: ['@cf/deepseek-ai/deepseek-v4.1-flash-1017', 'openrouter/deepseek/deepseek-chat:free', 'fast'],
    secretKey: 'autobot.autoswitch.freellm_key',
    costPerDecisionUsd: 0,
    extraHeaders: {},
  },
};

const _telemetry = {
  decisionsCount: 0,
  estimatedCostUsd: 0,
  lastLatencyMs: 0,
  lastSource: '',
  lastModelUsed: '',
};

function getDispatcherTelemetry() {
  return {
    decisionsCount: _telemetry.decisionsCount,
    estimatedCostUsd: Number(_telemetry.estimatedCostUsd.toFixed(6)),
    lastLatencyMs: _telemetry.lastLatencyMs,
    lastSource: _telemetry.lastSource,
    lastModelUsed: _telemetry.lastModelUsed,
  };
}

function recordDispatcherDecision({ source = 'openrouter_free', latencyMs = 0, modelUsed = '', usedNetwork = false } = {}) {
  _telemetry.decisionsCount += 1;
  if (usedNetwork) {
    const spec = AUTO_SWITCH_SOURCES[source] || AUTO_SWITCH_SOURCES.openrouter_free;
    _telemetry.estimatedCostUsd += Number(spec.costPerDecisionUsd || 0);
  }
  _telemetry.lastLatencyMs = Math.max(0, Number(latencyMs) || 0);
  _telemetry.lastSource = source;
  if (modelUsed) _telemetry.lastModelUsed = modelUsed;
  return getDispatcherTelemetry();
}

function resetDispatcherTelemetry() {
  _telemetry.decisionsCount = 0;
  _telemetry.estimatedCostUsd = 0;
  _telemetry.lastLatencyMs = 0;
  _telemetry.lastSource = '';
  _telemetry.lastModelUsed = '';
}

const DEEPSEEK_ROUTER_SYSTEM_PROMPT = [
  "You are Akron Code's model router. Given the user's request and the available models by tier, pick the single best tier and model ID.",
  'Reply with strict JSON only:',
  '{"role":"fast"|"coder"|"planner"|"vision"|"longctx","complexity":1..5,"model":"<exact_model_id_from_roster>","reason":"<max 6 words>"}',
  'Rules:',
  '- 1-2 (fast): greetings, simple questions, quick syntax/command lookups.',
  '- 3-4 (coder): writing/editing code, fixing bugs, building UI, running tools/tests.',
  '- 5 (planner): complex multi-file architecture, deep debugging, security audits, reverse engineering, system design.',
].join('\n');

const ROLE_DISPLAY = {
  fast: 'Fast',
  coder: 'Coder',
  planner: 'Planner',
  vision: 'Vision',
  longctx: 'Long Context',
  image_gen: 'Image Studio',
  video_gen: 'Video Studio',
  audio_speech: 'Audio Studio',
};

const TIER_PREFERENCES = {
  fast: [
    'claude-haiku-5-5',
    'gemini-4-hydrogen-low',
    'claude-sonnet-5-5-low',
    'gemini-4-neon-low',
    'gemini-2.5-flash',
    'grok-4-fast',
    'gpt-5.6-luna',
    'claude-haiku-4-5-20251001',
    'qwen3.8-27b',
    'deepseek-v4-flash',
    'glm-4.7-flash',
  ],
  coder: [
    'claude-sonnet-5-5',
    'claude-sonnet-5-5-medium',
    'claude-sonnet-5-5-high',
    'claude-sonnet-4-6',
    'gpt-5.6-terra',
    'gemini-4-carbon-medium',
    'gemini-4-neon-medium',
    'grok-code-fast-1',
    'claude-opus-5-5-low',
    'qwen3-coder-30b-a3b-instruct',
    'qwen3.8-flash',
    'deepseek-chat',
  ],
  planner: [
    'claude-opus-5-5',
    'claude-opus-5-5-high',
    'claude-opus-5-5-medium',
    'claude-opus-4-6',
    'gemini-4-carbon-high',
    'gemini-4-neon-high',
    'gpt-6-luna',
    'claude-fable-5-2',
    'grok-4.5',
    'gpt-5.6-luna',
  ],
  vision: [
    'claude-sonnet-5-5',
    'claude-sonnet-5-5-medium',
    'gemini-4-carbon-medium',
    'gemini-4-neon-high',
    'gpt-5.6-terra',
    'claude-opus-5-5',
    'qwen3.8-flash',
    'glm-4.6v-flash',
  ],
  longctx: [
    'gemini-4-carbon-high',
    'gemini-4-neon-high',
    'gemini-4-carbon-medium',
    'claude-opus-5-5',
    'claude-sonnet-5-5',
    'gpt-5.6-luna',
    'qwen3.8-flash',
  ],
};

const VENDOR_MODELS_BY_PROVIDER = {
  claude: [
    'claude-haiku-5-5',
    'claude-sonnet-5-5',
    'claude-opus-5-5',
    'claude-fable-5-2',
    'claude-opus-4-6',
    'claude-sonnet-4-6',
    'claude-haiku-4-5-20251001',
  ],
  chatgpt: [
    'gpt-5.6-luna',
    'gpt-5.6-terra',
    'gpt-6-luna',
    'gpt-reserve',
    'codex-auto-review',
  ],
  antigravity: [
    'gemini-4-hydrogen-low',
    'gemini-4-neon-low',
    'gemini-4-carbon-medium',
    'gemini-4-neon-medium',
    'gemini-4-carbon-high',
    'gemini-4-neon-high',
    'claude-sonnet-5-5-low',
    'claude-sonnet-5-5-medium',
    'claude-sonnet-5-5-high',
    'claude-opus-5-5-low',
    'claude-opus-5-5-medium',
    'claude-opus-5-5-high',
  ],
  grok: [
    'grok-4-fast',
    'grok-code-fast-1',
    'grok-4.5',
    'grok-4',
  ],
};

const CLASSIFIER_SYSTEM_PROMPT = [
  'Classify this coding/assistant request into one complexity tier. Reply with JSON only:',
  '{"role":"fast"|"coder"|"planner","complexity":1..5,"reason":"<5 words>"}',
  '- fast (1-2): simple question, explanation, command lookup, small text edit',
  '- coder (3-4): write/edit code, debug error, build UI/feature, run tests/tools',
  '- planner (5): complex multi-file architecture, security audit, reverse engineering, deep root-cause analysis',
].join('\n');

const ARCH_SIGNAL_RE = /\b(architect(?:ure)?|security\s+audit|reverse[\s-]engineer(?:ing)?|root[\s-]cause|threat\s+model|multi[\s-]file|redesign|migration|race\s+condition|deadlock|memory\s+leak|decompile|vulnerability|binary|asar|system\s+design)\b/i;
const CODER_SIGNAL_RE = /\b(write|implement|refactor|debug|fix|edit|patch|test|unit\s+test|build|component|function|class|api|endpoint|bug|error|typescript|javascript|react|python|rust|go|sql|css|html|bash)\b/i;
const FILE_PATH_RE = /(?:[\w.-]+\/)+[\w.-]+|\b[\w-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|rs|go|java|cpp|c|json|md|yml|yaml|css|html|sh)\b/gi;
const STACK_TRACE_RE = /\bat\s+\S+\s*\(|Traceback\s*\(|TypeError:|ReferenceError:|SyntaxError:|ENOENT|ECONNREFUSED|Error:/i;
const VIDEO_GEN_RE = /\b(generate|create|make|render|produce|animate)\s+(?:(?:a|an|the|some)\s+)?(?:[a-z0-9-]+\s+){0,4}(video|clip|animation|reel|mp4)\b/i;
const IMAGE_GEN_RE = /\b(generate|create|draw|design|paint|illustrate|render)\s+(?:(?:a|an|the|some)\s+)?(?:[a-z0-9-]+\s+){0,4}(image|logo|icon|illustration|artwork|banner|wallpaper|poster|avatar|picture|photo)\b/i;
const AUDIO_GEN_RE = /\b(generate|synthesize|create|narrate|read\s+aloud)\s+(?:(?:a|an|the|some)\s+)?(?:[a-z0-9-]+\s+){0,4}(voiceover|speech|tts|audio\s+clip|narration)\b/i;
const TRIVIAL_GREETING_RE = /^(hi|hello|hey|yo|thanks|thank you|thx|ok|okay|who are you|what model|status|ping|test)\b/i;

function extractLatestUserPrompt(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (!m || m.role !== 'user' || m._syntheticImageRead) continue;
    const c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c
        .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
        .map((p) => String(p.text || ''))
        .join('\n')
        .trim();
    }
  }
  return '';
}

function estimateConversationTokens(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  let chars = 0;
  for (const m of arr) {
    if (!m) continue;
    const c = m.content;
    if (typeof c === 'string') {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p) continue;
        if (typeof p.text === 'string') chars += p.text.length;
        else if (p.type === 'image_url' || p.type === 'image' || p.type === 'input_image') chars += 1200;
      }
    } else if (c != null) {
      chars += JSON.stringify(c).length;
    }
  }
  return Math.ceil(chars / 4);
}

function readLocalFreeLlmToken(baseURL, store) {
  if (store === false) return '';
  if (!/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(String(baseURL || ''))) return '';
  try {
    const cfg = require('./freellm').loadConfig();
    if (cfg && cfg.token && (/:31415\b/.test(String(baseURL || '')) || cfg.configured !== false)) {
      return String(cfg.token).trim();
    }
  } catch (_) {}
  return '';
}

function isCandidateUsable(cand, { healthyOauthIds = null, store = null } = {}) {
  if (!cand || typeof cand !== 'object' || cand.enabled === false) return false;
  const modelId = String(cand.model || '').trim();
  if (!modelId || modelId.toLowerCase() === 'auto') return false;

  if (cand.oauthProvider || cand.oauth || cand.accessToken) {
    if (String(cand.accessToken || '').trim()) return true;
    if (healthyOauthIds instanceof Set) {
      return Boolean(cand.oauthProvider && healthyOauthIds.has(String(cand.oauthProvider)));
    }
    return Boolean(cand.oauthProvider);
  }

  const base = String(cand.baseURL || '').trim();
  let key = String(cand.apiKey || '').trim();
  if (!base) return cand._syntheticConnected === true;

  if (/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) {
    if (!key) {
      const tok = readLocalFreeLlmToken(base, store);
      if (tok) {
        cand.apiKey = tok;
        key = tok;
      }
    }
    return Boolean(key);
  }

  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base)) {
    return true;
  }
  return Boolean(key);
}

function candidateSourcePriority(cand) {
  if (!cand || typeof cand !== 'object') return 3;
  if (cand.oauthProvider || cand.oauth || cand.accessToken) return 0;
  const base = String(cand.baseURL || '').trim();
  const key = String(cand.apiKey || '').trim();
  if (/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) return 2;
  if (/:11434\b/i.test(base) || cand._source === 'ollama') return 3;
  if (key || cand._syntheticConnected === true) return 1;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base)) return 3;
  return 1;
}

function classifyHeuristic({ messages = [], attachments = [], estimatedTokens } = {}) {
  const hasAttImg = Array.isArray(attachments)
    && attachments.some((a) => a && (a.isImage || /^image\//i.test(String(a.mimeType || ''))));
  if (hasAttImg || orchRouter.hasImages(messages)) {
    return {
      tier: 'vision',
      role: 'vision',
      complexity: 3,
      reason: 'Visual attachment detected',
      via: 'heuristic',
    };
  }

  const text = extractLatestUserPrompt(messages).trim();
  if (text) {
    if (VIDEO_GEN_RE.test(text)) {
      return {
        tier: 'heavy',
        role: 'video_gen',
        complexity: 3,
        reason: 'Media generation request',
        via: 'heuristic',
      };
    }
    if (IMAGE_GEN_RE.test(text)) {
      return {
        tier: 'heavy',
        role: 'image_gen',
        complexity: 3,
        reason: 'Media generation request',
        via: 'heuristic',
      };
    }
    if (AUDIO_GEN_RE.test(text)) {
      return {
        tier: 'small',
        role: 'audio_speech',
        complexity: 2,
        reason: 'Media generation request',
        via: 'heuristic',
      };
    }
  }

  const tokens = estimatedTokens != null ? Number(estimatedTokens) : estimateConversationTokens(messages);
  if (tokens > 120000) {
    return {
      tier: 'heavy',
      role: 'longctx',
      complexity: 4,
      reason: 'Large context window required',
      via: 'heuristic',
    };
  }

  if (text && text.length > 0 && text.length < 80) {
    const hasFence = text.includes('```');
    const hasFile = new RegExp(FILE_PATH_RE.source, 'i').test(text);
    const hasTrace = STACK_TRACE_RE.test(text);
    const hasCodingVerb = CODER_SIGNAL_RE.test(text) || ARCH_SIGNAL_RE.test(text);
    if (!hasFence && !hasFile && !hasTrace && !hasCodingVerb && TRIVIAL_GREETING_RE.test(text)) {
      return {
        tier: 'small',
        role: 'fast',
        complexity: 1,
        reason: 'Quick conversational turn',
        via: 'heuristic',
      };
    }
  }

  return null;
}

function scorePromptComplexity(text, messages = []) {
  const s = String(text || extractLatestUserPrompt(messages) || '').trim();
  const fileMatches = s.match(FILE_PATH_RE) || [];
  const fileCount = new Set(fileMatches.map((x) => x.toLowerCase())).size;
  const hasCodeBlock = /```/.test(s);
  const hasTrace = STACK_TRACE_RE.test(s);
  const archHits = (s.match(new RegExp(ARCH_SIGNAL_RE.source, 'gi')) || []).length;
  const coderHits = (s.match(new RegExp(CODER_SIGNAL_RE.source, 'gi')) || []).length;
  const multiStepMatches = s.match(/(?:^|\n)\s*(?:\d+\.|[-*])\s+\S+/g) || [];
  const multiStep = multiStepMatches.length >= 3 || /\b(step\s+by\s+step|end[- ]to[- ]end|full[- ]stack|across\s+all|compare\s+and)\b/i.test(s);

  if (archHits >= 1 || (fileCount >= 3 && multiStep) || (s.length > 900 && coderHits >= 3 && multiStep)) {
    return {
      tier: 'critical',
      role: 'planner',
      complexity: 5,
      reason: 'Complex architecture or audit',
      via: 'fallback',
    };
  }

  if (hasCodeBlock || hasTrace || fileCount >= 1 || coderHits >= 1) {
    const comp = (hasTrace && fileCount >= 1) || coderHits >= 3 || (hasCodeBlock && s.length > 350) ? 4 : 3;
    return {
      tier: 'heavy',
      role: 'coder',
      complexity: comp,
      reason: hasTrace ? 'Debugging stack trace & code' : 'Code implementation or edit',
      via: 'fallback',
    };
  }

  const comp = s.length > 180 ? 2 : 1;
  return {
    tier: 'small',
    role: 'fast',
    complexity: comp,
    reason: 'Simple question or explanation',
    via: 'fallback',
  };
}

function resolveClassifierProvider({
  provider = null,
  orchestrator = null,
  oauthAccounts = null,
  ollamaModels = null,
  store = null,
} = {}) {
  // 1. Signed-in Paid Subscription fast model FIRST
  let accounts = Array.isArray(oauthAccounts) ? oauthAccounts : null;
  if (!accounts && store !== false) {
    try {
      const po = require('./provider-oauth');
      if (po && typeof po.listAccounts === 'function') accounts = po.listAccounts() || [];
    } catch (_) {
      accounts = [];
    }
  }
  const healthyAccts = (accounts || []).filter((a) => a && !a.needsSignIn && !a.expired && a.id && a.provider);
  const healthyOauthIds = accounts !== null ? new Set(healthyAccts.map((a) => String(a.id))) : null;
  const fastOauthSpec = [
    { prov: 'claude', transport: 'anthropic', model: 'claude-haiku-5-5' },
    { prov: 'antigravity', transport: 'google', model: 'gemini-4-hydrogen-low' },
    { prov: 'grok', transport: 'grok', model: 'grok-4-fast' },
    { prov: 'chatgpt', transport: 'codex', model: 'gpt-5.6-luna' },
  ];
  for (const spec of fastOauthSpec) {
    const acct = healthyAccts.find((a) => String(a.provider).toLowerCase() === spec.prov);
    if (acct) {
      return {
        id: 'classifier:oauth:' + acct.id,
        oauthProvider: acct.id,
        transport: spec.transport,
        oauth: true,
        model: spec.model,
        account: acct.account || '',
        supportsTools: false,
      };
    }
  }

  // 2. Credential-valid configured `fast` role pool / orchestrator row
  if (orchestrator) {
    if (Array.isArray(orchestrator.providers)) {
      const fastOrch = orchestrator.providers.find((p) => (
        p && p.enabled !== false && p.model
        && (p.role === 'fast' || p.tier === 'small' || /haiku|flash|(?:^|[-_/.])mini(?=$|[-_/.])|fast|27b|nano/i.test(p.model))
        && isCandidateUsable({ ...p }, { healthyOauthIds, store })
      ));
      if (fastOrch) return fastOrch;
    }
    const gw = orchestrator.pools && orchestrator.pools.gateway;
    const gwUrl = (gw && gw.baseURL) || (provider && provider.baseURL) || '';
    const gwKey = (gw && gw.apiKey) || (provider && provider.apiKey) || '';
    const fastRows = orchRouter.resolve(orchestrator, 'fast', provider);
    for (const row of fastRows) {
      if (!row || !row.model) continue;
      const cand = { ...row, baseURL: row.baseURL || gwUrl, apiKey: row.apiKey || gwKey };
      if (isCandidateUsable(cand, { healthyOauthIds, store })) return cand;
    }
  }

  // 3. Local running Ollama small model
  const ollamaList = Array.isArray(ollamaModels) ? ollamaModels : [];
  const isProvOllama = provider && /:11434\b/.test(String(provider.baseURL || ''));
  if (ollamaList.length) {
    const names = ollamaList.map((m) => (typeof m === 'string' ? m : (m && (m.name || m.model || m.id)))).filter(Boolean);
    const preferred = names.find((n) => /gemma4|qwen.*(7b|14b|27b)|llama3\.2|phi|mini/i.test(n)) || names[0];
    if (preferred) {
      return {
        id: 'classifier:ollama:' + preferred,
        baseURL: (isProvOllama && provider.baseURL) || 'http://127.0.0.1:11434/v1',
        apiKey: '',
        model: preferred,
        supportsTools: false,
      };
    }
  }
  if (isProvOllama && provider.model && String(provider.model).toLowerCase() !== 'auto') {
    return {
      ...provider,
      model: provider.model,
      supportsTools: false,
    };
  }

  // Last resort: if active provider is usable and not sentinel 'auto', use it
  if (provider && isCandidateUsable({ ...provider }, { healthyOauthIds, store })) {
    return { ...provider, supportsTools: false };
  }

  return null;
}

function parseClassifierJson(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : cleaned;
  let obj = null;
  try {
    obj = JSON.parse(jsonText);
  } catch (_) {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const role = String(obj.role || '').toLowerCase().trim();
  if (!['fast', 'coder', 'planner'].includes(role)) return null;
  const rawComp = Number(obj.complexity);
  const complexity = Number.isFinite(rawComp)
    ? Math.max(1, Math.min(5, Math.round(rawComp)))
    : (role === 'planner' ? 5 : (role === 'coder' ? 3 : 1));
  const reason = String(obj.reason || '').replace(/\s+/g, ' ').trim().slice(0, 80) || ROLE_DISPLAY[role];
  return {
    role,
    tier: orchRouter.ROLE_TIER[role] || 'heavy',
    complexity,
    reason,
  };
}

async function classifyWithSmallAI({
  text = '',
  classifierProvider = null,
  callClassifier = null,
  hydrateProvider = null,
  timeoutMs = 450,
  signal = null,
} = {}) {
  if (!classifierProvider || typeof callClassifier !== 'function') return null;
  if (signal && signal.aborted) throw new Error('aborted');

  let hydrated = classifierProvider;
  if (typeof hydrateProvider === 'function') {
    try {
      hydrated = await hydrateProvider(classifierProvider);
    } catch (_) {
      return null;
    }
  }
  if (!hydrated || !hydrated.model) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, Math.max(50, Number(timeoutMs) || 450));
  if (timer && typeof timer.unref === 'function') timer.unref();
  const onParentAbort = () => { try { ctrl.abort(); } catch (_) {} };
  if (signal && typeof signal.addEventListener === 'function') {
    signal.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    const promptSnippet = String(text || '').slice(0, 2400);
    const clsMessages = [
      { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: promptSnippet },
    ];
    const res = await callClassifier({ ...hydrated, temperature: 0, maxTokens: 32 }, clsMessages, 32, ctrl.signal);
    if (signal && signal.aborted) throw new Error('aborted');
    const content = typeof res === 'string' ? res : (res && res.content ? res.content : '');
    const parsed = parseClassifierJson(content);
    if (!parsed) return null;
    return {
      ...parsed,
      via: 'ai',
      classifierModel: hydrated.model,
    };
  } catch (err) {
    if (signal && signal.aborted) throw err;
    return null;
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onParentAbort); } catch (_) {}
    }
  }
}

function candidateSig(p) {
  return [
    String((p && p.model) || '').trim().toLowerCase(),
    String((p && p.oauthProvider) || '').trim().toLowerCase(),
    orchRouter.normBase((p && p.baseURL) || ''),
  ].join('|');
}

function isCooling(gate, p) {
  if (!gate || typeof gate.isCooling !== 'function') return false;
  try {
    const key = (gateMod.keyFor && gateMod.keyFor(p)) || candidateSig(p);
    return !!gate.isCooling(key);
  } catch (_) {
    return false;
  }
}

function isLoopbackUrl(u) {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(String(u || '').trim());
}

function normRouterBase(u) {
  return String(u || DEFAULT_AUTO_ROUTER_CONFIG.baseURL).trim().replace(/\/+$/, '') || DEFAULT_AUTO_ROUTER_CONFIG.baseURL;
}

function resolveAutoRouterConfig({
  autoRouterConfig = null,
  autoSwitchConfig = null,
  settings = null,
  secretstore = null,
  orchestrator = null,
  provider = null,
  env = process.env,
} = {}) {
  const cfg = autoSwitchConfig || autoRouterConfig || {};
  const setSwitch = (settings && settings.autoSwitch) || {};
  const setRouter = (settings && settings.autoRouter) || {};

  // Infer source: explicit cfg.source -> settings.autoSwitch.source -> fallback 'deepseek_api' when explicit deepseek baseURL/model given -> default 'openrouter_free'
  let source = String(cfg.source || setSwitch.source || '').trim().toLowerCase();
  if (!source) {
    if (cfg.baseURL && /deepseek\.com/i.test(String(cfg.baseURL))) source = 'deepseek_api';
    else if (cfg.apiKey && (cfg.baseURL || cfg.model === 'deepseek-v4-flash')) source = 'deepseek_api';
    else source = 'openrouter_free';
  }
  if (!AUTO_SWITCH_SOURCES[source]) source = 'openrouter_free';
  const spec = AUTO_SWITCH_SOURCES[source];

  const baseURL = normRouterBase(cfg.baseURL || (source === 'deepseek_api' ? setRouter.baseURL : '') || spec.baseURL);
  let model = String(cfg.model || (source === 'deepseek_api' ? setRouter.model : '') || spec.model).trim() || spec.model;
  // Security/Cost invariant: OpenRouter Free source NEVER invokes a paid OpenRouter model
  if (source === 'openrouter_free' && !/:free$/i.test(model) && cfg.allowCustomEndpoint !== true) {
    model = spec.model;
  }

  let apiKey = String(cfg.apiKey || '').trim();
  let keySource = apiKey ? 'explicit' : '';

  const readSecret = (k) => {
    if (!k || !secretstore || typeof secretstore.get !== 'function') return '';
    try { return String(secretstore.get(k) || '').trim(); } catch (_) { return ''; }
  };

  if (!apiKey) {
    const s = readSecret(spec.secretKey) || (spec.legacySecretKey ? readSecret(spec.legacySecretKey) : '');
    if (s) {
      apiKey = s;
      keySource = 'secretstore';
    }
  }

  if (!apiKey && env) {
    const envVal = source === 'openrouter_free'
      ? (env.OPENROUTER_API_KEY || '')
      : (source === 'deepseek_api' ? (env.DEEPSEEK_API_KEY || '') : (env.FREELM_TOKEN || ''));
    if (String(envVal).trim()) {
      apiKey = String(envVal).trim();
      keySource = 'env';
    }
  }

  let effectiveBase = baseURL;
  let effectiveModel = model;
  if (!apiKey && source === 'freellmapi') {
    try {
      const freellmCfg = require('./freellm').loadConfig();
      if (freellmCfg && freellmCfg.token) {
        apiKey = String(freellmCfg.token).trim();
        keySource = 'freellm-config';
      }
      if (freellmCfg && !freellmCfg.configured) {
        // Use built-in FreeLLMAPI port if configured or allow loopback without token when no token set
        effectiveBase = `http://127.0.0.1:${freellmCfg.port || 3001}/v1`;
      }
    } catch (_) {}
  }

  if (!apiKey && source === 'deepseek_api') {
    const gw = orchestrator && orchestrator.pools && orchestrator.pools.gateway;
    const poolProviders = orchestrator && Array.isArray(orchestrator.providers) ? orchestrator.providers : [];
    const dsRow = poolProviders.find((p) => p && p.enabled !== false && /deepseek/i.test(String(p.model || p.baseURL || '')) && (p.apiKey || isLoopbackUrl(p.baseURL)));
    if (dsRow) {
      apiKey = String(dsRow.apiKey || '').trim();
      effectiveBase = normRouterBase(dsRow.baseURL || effectiveBase);
      effectiveModel = String(dsRow.model || effectiveModel).trim();
      keySource = 'provider-pool';
    } else if (provider && /deepseek/i.test(String(provider.baseURL || '')) && (provider.apiKey || isLoopbackUrl(provider.baseURL))) {
      apiKey = String(provider.apiKey || '').trim();
      effectiveBase = normRouterBase(provider.baseURL || effectiveBase);
      keySource = 'provider';
    } else if (gw && /deepseek/i.test(String(gw.baseURL || '')) && (gw.apiKey || isLoopbackUrl(gw.baseURL))) {
      apiKey = String(gw.apiKey || '').trim();
      effectiveBase = normRouterBase(gw.baseURL || effectiveBase);
      keySource = 'gateway';
    }
  }

  return {
    source,
    label: spec.label,
    apiKey,
    baseURL: effectiveBase,
    fallbackBaseURL: spec.fallbackBaseURL || '',
    model: effectiveModel,
    fallbackModels: spec.fallbackModels ? spec.fallbackModels.slice() : [],
    extraHeaders: { ...(spec.extraHeaders || {}) },
    keySource,
    hasKey: Boolean(apiKey || isLoopbackUrl(effectiveBase)),
  };
}

function collectCandidateModels({
  providerOauth = null,
  orchestrator = null,
  provider = null,
  oauthAccounts = null,
  ollamaModels = null,
  store = null,
} = {}) {
  const candidates = [];
  const seen = new Set();

  // Resolve healthy signed-in OAuth accounts first so expired/unauthenticated rows are filtered reliably.
  const poMod = providerOauth || (store !== false ? (() => { try { return require('./provider-oauth'); } catch (_) { return null; } })() : null);
  let accounts = Array.isArray(oauthAccounts) ? oauthAccounts : null;
  if (!accounts && poMod && typeof poMod.listAccounts === 'function') {
    try { accounts = poMod.listAccounts() || []; } catch (_) { accounts = []; }
  }
  const healthyAccts = (accounts || []).filter((a) => a && !a.needsSignIn && !a.expired && a.id && a.provider);
  const healthyOauthIds = accounts !== null ? new Set(healthyAccts.map((a) => String(a.id))) : null;

  const pushCandidate = (row, meta = {}) => {
    if (!row || !row.model) return;
    const cand = { ...row, model: String(row.model).trim(), ...meta };
    if (!isCandidateUsable(cand, { healthyOauthIds, store })) return;
    const sig = candidateSig(cand);
    if (seen.has(sig)) return;
    seen.add(sig);
    candidates.push(cand);
  };

  const orchRows = (orchestrator && Array.isArray(orchestrator.providers))
    ? orchestrator.providers.filter((row) => row && row.enabled !== false)
    : [];

  // 1a. Paid Subscription OAuth rows from orchestrator.providers first (preserving user role/tier/transport)
  for (const row of orchRows) {
    if (row.oauthProvider || row.oauth || row.accessToken) {
      pushCandidate(row, { _source: 'oauth' });
    }
  }

  // 1b. Healthy signed-in OAuth accounts (Claude, ChatGPT, Antigravity, Grok)
  const providerRegistry = poMod && poMod.PROVIDERS ? poMod.PROVIDERS : null;
  for (const acct of healthyAccts) {
    const provKey = String(acct.provider).toLowerCase();
    const spec = providerRegistry && providerRegistry[provKey];
    const transport = (spec && spec.transport) || (provKey === 'claude' ? 'anthropic' : provKey === 'chatgpt' ? 'codex' : provKey === 'antigravity' ? 'google' : provKey);
    const knownModels = new Set(VENDOR_MODELS_BY_PROVIDER[provKey] || []);
    if (spec && Array.isArray(spec.models)) {
      for (const m of spec.models) { if (m && m.id) knownModels.add(m.id); }
    }
    if (Array.isArray(acct.models)) {
      for (const m of acct.models) { if (typeof m === 'string') knownModels.add(m); else if (m && m.id) knownModels.add(m.id); }
    }
    for (const modelId of knownModels) {
      pushCandidate({
        oauthProvider: acct.id,
        transport,
        oauth: true,
        account: acct.account || '',
        model: modelId,
        supportsTools: true,
      }, { _source: 'oauth' });
    }
  }

  // 2. Credential-valid Frontier / Keyed API orchestrator rows (excluding local Ollama :11434)
  for (const row of orchRows) {
    if (row.oauthProvider || row.oauth || row.accessToken) continue;
    if (/:11434\b/i.test(String(row.baseURL || ''))) continue;
    pushCandidate(row, { _source: 'orch' });
  }

  // 3. Authenticated FreeLLMAPI / Orchestrator role pools (ONLY when gateway credentials are ready)
  if (orchestrator && orchRouter.poolsConfig(orchestrator)) {
    const gw = orchestrator.pools && orchestrator.pools.gateway;
    const gwUrl = (gw && gw.baseURL) || (provider && provider.baseURL) || '';
    let gwKey = String((gw && gw.apiKey) || (provider && provider.apiKey) || '').trim();
    if (!gwKey && gwUrl) gwKey = readLocalFreeLlmToken(gwUrl, store);
    if (orchRouter.isGatewayCredentialReady(gwUrl, gwKey)) {
      for (const r of ['fast', 'coder', 'planner', 'vision', 'longctx']) {
        const rows = orchRouter.resolve(orchestrator, r, { ...(provider || {}), baseURL: gwUrl, apiKey: gwKey });
        for (const row of rows) pushCandidate(row, { _source: 'pool' });
      }
    }
  }

  // 4. Active session provider (when concrete, not 'auto', and usable)
  if (provider && provider.model && String(provider.model).trim().toLowerCase() !== 'auto') {
    pushCandidate(provider, { _source: 'provider' });
  }

  // 5. Local Ollama models fallback (lowest priority)
  for (const row of orchRows) {
    if (!row.oauthProvider && /:11434\b/i.test(String(row.baseURL || ''))) {
      pushCandidate(row, { _source: 'ollama' });
    }
  }
  if (Array.isArray(ollamaModels)) {
    for (const m of ollamaModels) {
      const mid = typeof m === 'string' ? m : (m && (m.name || m.model || m.id));
      if (!mid) continue;
      pushCandidate({
        baseURL: (provider && /:11434\b/.test(String(provider.baseURL || '')) && provider.baseURL) || 'http://127.0.0.1:11434/v1',
        apiKey: '',
        model: mid,
        supportsTools: true,
      }, { _source: 'ollama' });
    }
  }

  return candidates;
}

function buildAvailableRoster({
  providerOauth = null,
  modelCatalog = null,
  orchestrator = null,
  provider = null,
  oauthAccounts = null,
  ollamaModels = null,
  gate = null,
  store = null,
} = {}) {
  const catalog = modelCatalog || defaultModelCatalog;
  const allRaw = collectCandidateModels({ providerOauth, orchestrator, provider, oauthAccounts, ollamaModels, store });
  const warm = allRaw.filter((c) => !isCooling(gate, c));
  const pool = warm.length ? warm : allRaw;

  const tiers = { fast: [], coder: [], planner: [], vision: [], longctx: [] };
  const tierSets = {
    fast: new Set(TIER_PREFERENCES.fast.map((x) => x.toLowerCase())),
    coder: new Set(TIER_PREFERENCES.coder.map((x) => x.toLowerCase())),
    planner: new Set(TIER_PREFERENCES.planner.map((x) => x.toLowerCase())),
    vision: new Set(TIER_PREFERENCES.vision.map((x) => x.toLowerCase())),
    longctx: new Set(TIER_PREFERENCES.longctx.map((x) => x.toLowerCase())),
  };

  const sortTier = (list, roleName) => {
    const prefs = TIER_PREFERENCES[roleName] || [];
    const seenIds = new Set();
    const out = [];
    const sorted = list.slice().sort((a, b) => {
      const sp = candidateSourcePriority(a) - candidateSourcePriority(b);
      if (sp !== 0) return sp;
      const al = a.model.toLowerCase();
      const bl = b.model.toLowerCase();
      const ar = orchRouter.normalizeRole(a.role) === roleName ? 0 : 1;
      const br = orchRouter.normalizeRole(b.role) === roleName ? 0 : 1;
      if (ar !== br) return ar - br;
      const ap = prefs.findIndex((p) => al === p.toLowerCase() || al.endsWith('/' + p.toLowerCase()));
      const bp = prefs.findIndex((p) => bl === p.toLowerCase() || bl.endsWith('/' + p.toLowerCase()));
      return (ap >= 0 ? ap : 999) - (bp >= 0 ? bp : 999);
    });
    for (const item of sorted) {
      const k = item.model.toLowerCase();
      if (seenIds.has(k)) continue;
      seenIds.add(k);
      out.push(item);
    }
    return out;
  };

  for (const cand of pool) {
    const ml = String(cand.model || '').toLowerCase();
    const pid = String(cand.oauthProvider || '').split(':')[0] || cand.transport || '';
    const ctxWin = catalog && typeof catalog.contextWindowFor === 'function'
      ? catalog.contextWindowFor(cand.model, pid, cand.contextWindow)
      : (Number(cand.contextWindow) || 128000);
    const entry = { ...cand, contextWindow: ctxWin };
    const normRole = orchRouter.normalizeRole(cand.role);

    const isFast = normRole === 'fast' || tierSets.fast.has(ml) || /haiku|hydrogen|grok-4-fast|flash|(?:^|[-_/.])mini(?=$|[-_/.])|nano|lite|gemma|27b/i.test(ml);
    const isCoder = normRole === 'coder' || tierSets.coder.has(ml) || /sonnet|terra|carbon-medium|code-fast|coder|codex|deepseek-chat/i.test(ml);
    const isPlanner = normRole === 'planner' || tierSets.planner.has(ml) || /opus|carbon-high|neon-high|gpt-6|fable|grok-4\.5|reasoner|\br1\b/i.test(ml);
    const isVision = normRole === 'vision' || tierSets.vision.has(ml) || /vision|\bvl\b|\b4o\b|\b4\.1\b|gpt-5\.6|claude-(?:opus|sonnet|haiku)|gemini-/i.test(ml);
    const isLongCtx = normRole === 'longctx' || tierSets.longctx.has(ml) || ctxWin >= 500000;

    if (isFast) tiers.fast.push(entry);
    if (isCoder) tiers.coder.push(entry);
    if (isPlanner) tiers.planner.push(entry);
    if (isVision) tiers.vision.push(entry);
    if (isLongCtx) tiers.longctx.push(entry);
  }

  return {
    fast: sortTier(tiers.fast, 'fast'),
    coder: sortTier(tiers.coder, 'coder'),
    planner: sortTier(tiers.planner, 'planner'),
    vision: sortTier(tiers.vision, 'vision'),
    longctx: sortTier(tiers.longctx, 'longctx'),
    all: pool,
  };
}

function normalizeRosterIds(roster) {
  const out = { fast: [], coder: [], planner: [], vision: [], longctx: [] };
  const allIds = [];
  const r = roster || {};
  for (const tier of Object.keys(out)) {
    const arr = Array.isArray(r[tier]) ? r[tier] : [];
    for (const item of arr) {
      const id = typeof item === 'string' ? item.trim() : String((item && (item.model || item.id)) || '').trim();
      if (!id) continue;
      if (!out[tier].includes(id)) out[tier].push(id);
      if (!allIds.includes(id)) allIds.push(id);
    }
  }
  if (Array.isArray(r.all)) {
    for (const item of r.all) {
      const id = typeof item === 'string' ? item.trim() : String((item && (item.model || item.id)) || '').trim();
      if (id && !allIds.includes(id)) allIds.push(id);
    }
  }
  return { byTier: out, allIds };
}

function pickTopRosterModel(normRoster, role, fallbackId) {
  const list = normRoster && normRoster.byTier && normRoster.byTier[role];
  if (Array.isArray(list) && list.length) return list[0];
  if (role === 'vision' && normRoster.byTier.coder.length) return normRoster.byTier.coder[0];
  if (role === 'longctx' && normRoster.byTier.planner.length) return normRoster.byTier.planner[0];
  if (normRoster && normRoster.allIds && normRoster.allIds.length) return normRoster.allIds[0];
  return fallbackId;
}

function matchRosterModelId(candidateId, normRoster, role) {
  const raw = String(candidateId || '').trim();
  if (raw && normRoster && normRoster.allIds.length) {
    const exact = normRoster.allIds.find((id) => id.toLowerCase() === raw.toLowerCase() || id.toLowerCase().endsWith('/' + raw.toLowerCase()));
    if (exact) return exact;
  }
  return pickTopRosterModel(normRoster, role, raw || '');
}

function isModelNotFoundResponse(status, text) {
  if (status === 404) return true;
  if (status === 400 && /model[_ ]?not[_ ]?(?:found|exist)|does not exist|unknown model|invalid model/i.test(String(text || ''))) return true;
  return /model[_ ]?not[_ ]?(?:found|exist)|does not exist/i.test(String(text || ''));
}

async function callDeepSeekCompletions({
  apiKey,
  source = 'deepseek_api',
  baseURL = DEFAULT_AUTO_ROUTER_CONFIG.baseURL,
  fallbackBaseURL = '',
  model = DEFAULT_AUTO_ROUTER_CONFIG.model,
  fallbackModels = null,
  extraHeaders = null,
  messages,
  maxTokens = 45,
  fetchImpl = global.fetch,
  timeoutMs = 3500,
  signal = null,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch unavailable');
  const normBase = normRouterBase(baseURL);
  const altBase = fallbackBaseURL ? normRouterBase(fallbackBaseURL) : '';
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, Math.max(50, Number(timeoutMs) || 3500));
  if (timer && typeof timer.unref === 'function') timer.unref();
  const onParentAbort = () => { try { ctrl.abort(); } catch (_) {} };
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) { clearTimeout(timer); throw new Error('aborted'); }
    signal.addEventListener('abort', onParentAbort, { once: true });
  }

  const doPost = async (targetBase, mdl) => {
    const url = `${targetBase}/chat/completions`;
    const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      signal: ctrl.signal,
      body: JSON.stringify({
        model: mdl,
        messages,
        max_tokens: maxTokens,
        temperature: 0,
        stream: false,
      }),
    });
    const text = await res.text();
    return { res, text };
  };

  try {
    const requestedModel = String(model || DEFAULT_AUTO_ROUTER_CONFIG.model).trim();
    const spec = AUTO_SWITCH_SOURCES[source] || AUTO_SWITCH_SOURCES.deepseek_api;
    const fallbacks = Array.isArray(fallbackModels) && fallbackModels.length ? fallbackModels : spec.fallbackModels;
    const candidates = [requestedModel, ...fallbacks.filter((m) => m && m !== requestedModel)];

    let activeBase = normBase;
    let usedModel = requestedModel;
    let aliasFallback = false;
    let attempt = null;

    for (let i = 0; i < candidates.length; i++) {
      const mdl = candidates[i];
      usedModel = mdl;
      aliasFallback = i > 0;
      try {
        attempt = await doPost(activeBase, mdl);
      } catch (netErr) {
        if (i === 0 && altBase && altBase !== activeBase) {
          activeBase = altBase;
          attempt = await doPost(activeBase, mdl);
        } else {
          throw netErr;
        }
      }
      if (attempt.res.ok) break;
      const shouldRetryNext = isModelNotFoundResponse(attempt.res.status, attempt.text)
        || (source === 'openrouter_free' && (attempt.res.status === 404 || attempt.res.status === 429 || attempt.res.status === 502 || attempt.res.status === 503));
      if (!shouldRetryNext || i === candidates.length - 1) break;
    }

    if (!attempt || !attempt.res.ok) {
      let msg = `Dispatcher HTTP ${attempt ? attempt.res.status : 0}`;
      try {
        const j = JSON.parse((attempt && attempt.text) || '{}');
        if (j && j.error && j.error.message) msg = j.error.message;
      } catch (_) {}
      throw new Error(msg);
    }

    const data = JSON.parse(attempt.text || '{}');
    const content = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return {
      ok: true,
      content: String(content),
      modelUsed: data.model || usedModel,
      requestedModel,
      aliasFallback,
      baseUsed: activeBase,
    };
  } finally {
    clearTimeout(timer);
    if (signal && typeof signal.removeEventListener === 'function') {
      try { signal.removeEventListener('abort', onParentAbort); } catch (_) {}
    }
  }
}

function parseDeepSeekRouterJson(raw, normRoster) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const cleaned = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  const jsonText = match ? match[0] : cleaned;
  let obj = null;
  try { obj = JSON.parse(jsonText); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const rawRole = String(obj.role || '').toLowerCase().trim();
  if (!['fast', 'coder', 'planner', 'vision', 'longctx', 'image_gen', 'video_gen'].includes(rawRole)) return null;
  const role = rawRole;
  const rawComp = Number(obj.tier != null ? obj.tier : obj.complexity);
  const complexity = Number.isFinite(rawComp)
    ? Math.max(1, Math.min(5, Math.round(rawComp)))
    : (role === 'planner' ? 5 : (role === 'longctx' ? 4 : (role === 'coder' || role === 'vision' || role === 'image_gen' || role === 'video_gen' ? 3 : 1)));
  const words = String(obj.reason || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const reason = words.slice(0, 8).join(' ').slice(0, 80) || ROLE_DISPLAY[role];
  const candidateModel = obj.modelId != null ? obj.modelId : obj.model;
  const lookupRole = role === 'image_gen' || role === 'video_gen' ? 'coder' : role;
  const model = matchRosterModelId(candidateModel, normRoster, lookupRole);
  return {
    role,
    tier: complexity,
    complexity,
    model,
    modelId: model,
    reason,
  };
}

async function classifyWithDeepSeek({
  prompt = '',
  messages = [],
  hasImages = false,
  estimatedTokens = 0,
  roster = null,
  autoRouterConfig = null,
  autoSwitchConfig = null,
  fetchImpl = global.fetch,
  timeoutMs = 3500,
  signal = null,
} = {}) {
  if (signal && signal.aborted) throw new Error('aborted');
  const normRoster = normalizeRosterIds(roster);

  // Fast-path (<2ms): vision attachments and >120K long-context turns never pay a network round-trip.
  if (hasImages) {
    const picked = pickTopRosterModel(normRoster, 'vision', 'gemini-4-carbon-medium');
    recordDispatcherDecision({ source: 'heuristic', latencyMs: 1, modelUsed: picked, usedNetwork: false });
    return {
      role: 'vision',
      tier: 3,
      complexity: 3,
      model: picked,
      modelId: picked,
      reason: 'Visual attachment detected',
      via: 'heuristic',
    };
  }
  if (Number(estimatedTokens) > 120000) {
    const picked = pickTopRosterModel(normRoster, 'longctx', 'gemini-4-carbon-high');
    recordDispatcherDecision({ source: 'heuristic', latencyMs: 1, modelUsed: picked, usedNetwork: false });
    return {
      role: 'longctx',
      tier: 4,
      complexity: 4,
      model: picked,
      modelId: picked,
      reason: 'Large 1M context window required',
      via: 'heuristic',
    };
  }

  const promptText = String(prompt || extractLatestUserPrompt(messages) || '').trim();
  const cfg = resolveAutoRouterConfig({ autoRouterConfig, autoSwitchConfig, env: {} });

  if (cfg.hasKey && typeof fetchImpl === 'function') {
    const t0 = Date.now();
    try {
      const rosterLines = [
        `fast: ${normRoster.byTier.fast.slice(0, 6).join(', ') || 'none'}`,
        `coder: ${normRoster.byTier.coder.slice(0, 6).join(', ') || 'none'}`,
        `planner: ${normRoster.byTier.planner.slice(0, 6).join(', ') || 'none'}`,
        `vision: ${normRoster.byTier.vision.slice(0, 5).join(', ') || 'none'}`,
        `longctx: ${normRoster.byTier.longctx.slice(0, 5).join(', ') || 'none'}`,
      ].join('\n');
      const userContent = `Available models by tier:\n${rosterLines}\n\nUser request:\n${promptText.slice(0, 2400)}`;
      const res = await callDeepSeekCompletions({
        apiKey: cfg.apiKey,
        source: cfg.source,
        baseURL: cfg.baseURL,
        fallbackBaseURL: cfg.fallbackBaseURL,
        model: cfg.model,
        fallbackModels: cfg.fallbackModels,
        extraHeaders: cfg.extraHeaders,
        messages: [
          { role: 'system', content: DEEPSEEK_ROUTER_SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        maxTokens: 45,
        fetchImpl,
        timeoutMs: Math.max(50, Number(timeoutMs) || 3500),
        signal,
      });
      const parsed = parseDeepSeekRouterJson(res.content, normRoster);
      if (parsed) {
        const latencyMs = Math.max(1, Date.now() - t0);
        recordDispatcherDecision({ source: cfg.source, latencyMs, modelUsed: res.modelUsed, usedNetwork: true });
        return {
          ...parsed,
          via: cfg.model === 'deepseek-reasoner' ? 'deepseek-reasoner' : 'deepseek-v4-flash',
          source: cfg.source,
          dispatcherModel: res.modelUsed,
          aliasFallback: !!res.aliasFallback,
          latencyMs,
        };
      }
    } catch (err) {
      if (signal && signal.aborted) throw err;
      // Offline, auth failure, or >1200ms timeout -> fall back cleanly below in 0ms
    }
  }

  // <1ms deterministic offline/timeout complexity scorer fallback
  const synthMsgs = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: promptText }];
  const heur = classifyHeuristic({ messages: synthMsgs, estimatedTokens });
  const det = heur || scorePromptComplexity(promptText, synthMsgs);
  const detRole = ['image_gen', 'video_gen'].includes(det.role) ? 'coder' : (det.role === 'audio_speech' ? 'fast' : det.role);
  const fallbackModel = pickTopRosterModel(normRoster, detRole, '');
  recordDispatcherDecision({ source: 'heuristic', latencyMs: 0, modelUsed: fallbackModel, usedNetwork: false });
  return {
    ...det,
    tier: det.complexity || 3,
    model: fallbackModel,
    modelId: fallbackModel,
    via: 'heuristic',
    fallback: true,
  };
}

function classifyPromptTier({ prompt = '', messages = [], hasImages = false, fileCount = 0, approxTokens = 0, attachments = [] } = {}) {
  const synthMsgs = Array.isArray(messages) && messages.length ? messages : [{ role: 'user', content: String(prompt || '') }];
  const tokens = approxTokens || estimateConversationTokens(synthMsgs);
  const h = classifyHeuristic({
    messages: hasImages ? [...synthMsgs, { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' } }] }] : synthMsgs,
    attachments,
    estimatedTokens: tokens,
  });
  if (h) return { ...h, tier: h.complexity || 3 };
  const s = scorePromptComplexity(prompt, synthMsgs);
  const bumpedComplexity = fileCount >= 3 && s.complexity < 5 ? 5 : s.complexity;
  const bumpedRole = bumpedComplexity === 5 ? 'planner' : s.role;
  return {
    ...s,
    role: bumpedRole,
    tier: bumpedComplexity,
    complexity: bumpedComplexity,
  };
}

function pickFromRolePool(role, availableModels = [], rolePools = null) {
  const list = Array.isArray(availableModels) ? availableModels : [];
  const normList = list.map((m) => (typeof m === 'string' ? { model: m, id: m } : m)).filter((m) => m && (m.model || m.id));
  const getId = (m) => String(m.model || m.id).trim();
  const normRole = orchRouter.normalizeRole(role) || 'coder';
  const lookupRole = (normRole === 'image_gen' || normRole === 'video_gen') ? 'coder' : (normRole === 'audio_speech' ? 'fast' : normRole);

  if (rolePools && rolePools[lookupRole]) {
    const poolIds = (Array.isArray(rolePools[lookupRole]) ? rolePools[lookupRole] : (rolePools[lookupRole].models || []))
      .map((x) => (typeof x === 'string' ? x : x && (x.model || x.id)))
      .filter(Boolean);
    for (const pid of poolIds) {
      const hit = normList.find((m) => getId(m).toLowerCase() === String(pid).toLowerCase());
      if (hit) return getId(hit);
    }
  }

  const prefs = TIER_PREFERENCES[lookupRole] || TIER_PREFERENCES.coder;
  for (const pref of prefs) {
    const hit = normList.find((m) => getId(m).toLowerCase() === pref.toLowerCase() || getId(m).toLowerCase().endsWith('/' + pref.toLowerCase()));
    if (hit) return getId(hit);
  }
  const roleTagged = normList.find((m) => orchRouter.normalizeRole(m.role) === lookupRole);
  if (roleTagged) return getId(roleTagged);
  return normList[0] ? getId(normList[0]) : '';
}

async function dispatchWithDeepSeekFlash({
  prompt = '',
  messages = [],
  hasImages = false,
  fileCount = 0,
  approxTokens = 0,
  availableModels = [],
  rolePools = null,
  autoSwitchConfig = null,
  autoRouterConfig = null,
  fetchImpl = global.fetch,
  timeoutMs = 3500,
  signal = null,
} = {}) {
  const connectedIds = (Array.isArray(availableModels) ? availableModels : [])
    .map((m) => (typeof m === 'string' ? m.trim() : String((m && (m.model || m.id)) || '').trim()))
    .filter(Boolean);
  const roster = buildAvailableRoster({
    store: false,
    orchestrator: {
      providers: connectedIds.map((id) => ({ model: id, _syntheticConnected: true })),
      ...(rolePools ? { pools: { enabled: true, roles: rolePools } } : {}),
    },
  });
  const tokens = approxTokens || estimateConversationTokens(messages.length ? messages : [{ role: 'user', content: prompt }]);
  const cls = await classifyWithDeepSeek({
    prompt,
    messages,
    hasImages,
    estimatedTokens: tokens > 200000 ? tokens : (tokens > 120000 ? tokens : 0),
    roster,
    autoRouterConfig,
    autoSwitchConfig,
    fetchImpl,
    timeoutMs: Math.max(50, Math.min(3500, Number(timeoutMs) || 3500)),
    signal,
  });

  // Strict connected-only enforcement
  let finalModel = cls.model;
  if (connectedIds.length && !connectedIds.some((id) => id.toLowerCase() === String(finalModel || '').toLowerCase())) {
    finalModel = pickFromRolePool(cls.role, connectedIds, rolePools) || connectedIds[0];
  }
  if (!finalModel && fileCount >= 3 && connectedIds.length) {
    finalModel = pickFromRolePool('planner', connectedIds, rolePools);
  }
  return {
    ...cls,
    tier: cls.tier || cls.complexity || 3,
    model: finalModel,
    modelId: finalModel,
  };
}

async function pingDeepSeekDispatcher({
  apiKey = '',
  source = 'deepseek_api',
  baseURL = '',
  model = '',
  fetchImpl = global.fetch,
  timeoutMs = 5000,
} = {}) {
  const spec = AUTO_SWITCH_SOURCES[source] || AUTO_SWITCH_SOURCES.deepseek_api;
  const key = String(apiKey || '').trim();
  const base = normRouterBase(baseURL || spec.baseURL);
  const mdl = String(model || spec.model).trim() || spec.model;
  if (!key && !isLoopbackUrl(base)) {
    return { ok: false, error: `Enter or save a key for ${spec.label} first.`, latencyMs: 0 };
  }
  const t0 = Date.now();
  try {
    const res = await callDeepSeekCompletions({
      apiKey: key,
      source,
      baseURL: base,
      fallbackBaseURL: spec.fallbackBaseURL || '',
      model: mdl,
      fallbackModels: spec.fallbackModels,
      extraHeaders: spec.extraHeaders,
      messages: [{ role: 'user', content: 'Reply with OK' }],
      maxTokens: 15,
      fetchImpl,
      timeoutMs,
    });
    const latencyMs = Math.max(1, Date.now() - t0);
    recordDispatcherDecision({ source, latencyMs, modelUsed: res.modelUsed, usedNetwork: false });
    return {
      ok: true,
      source,
      sourceLabel: spec.label,
      latencyMs,
      modelUsed: res.modelUsed,
      aliasFallback: res.aliasFallback,
      reply: res.content.trim().slice(0, 40),
      telemetry: getDispatcherTelemetry(),
    };
  } catch (err) {
    return {
      ok: false,
      source,
      sourceLabel: spec.label,
      latencyMs: Date.now() - t0,
      error: String((err && err.message) || err),
      telemetry: getDispatcherTelemetry(),
    };
  }
}

async function selectModelForTier({
  classification = null,
  provider = null,
  orchestrator = null,
  oauthAccounts = null,
  ollamaModels = null,
  hydrateProvider = null,
  gate = null,
  store = null,
  roster = null,
  busyModels = null,
} = {}) {
  const cls = classification || { role: 'coder', tier: 'heavy', complexity: 3, reason: 'Default coder route', via: 'fallback' };
  const rawRole = orchRouter.normalizeRole(cls.role) || 'coder';
  // Media generation requires a tool-capable chat LLM to call GenerateImage / GenerateVideo
  const lookupRole = (rawRole === 'image_gen' || rawRole === 'video_gen')
    ? 'coder'
    : (rawRole === 'audio_speech' ? 'fast' : rawRole);

  const ladder = {
    fast: ['fast', 'coder', 'planner'],
    coder: ['coder', 'planner', 'fast'],
    planner: ['planner', 'coder', 'fast'],
    vision: ['vision', 'coder', 'planner'],
    longctx: ['longctx', 'planner', 'coder'],
  }[lookupRole] || ['coder', 'planner', 'fast'];

  const baseCandidates = (roster && Array.isArray(roster.all) && roster.all.length)
    ? roster.all
    : collectCandidateModels({ orchestrator, provider, oauthAccounts, ollamaModels, store });

  const warm = baseCandidates.filter((c) => !isCooling(gate, c));
  const pool = warm.length ? warm : baseCandidates;

  const prefList = TIER_PREFERENCES[lookupRole] || TIER_PREFERENCES.coder;
  const preferredModel = String(cls.model || '').trim().toLowerCase();
  const busySet = busyModels instanceof Set
    ? new Set([...busyModels].map((x) => String(x || '').trim().toLowerCase()).filter(Boolean))
    : null;
  const rankOf = (c) => {
    const srcPrio = candidateSourcePriority(c);
    const ml = String(c.model || '').toLowerCase();
    const busyPenalty = (busySet && busySet.has(ml))
      || (gate && typeof gate.inflight === 'function' && gate.inflight(c) > 0)
      ? 50
      : 0;
    if (preferredModel && (ml === preferredModel || ml.endsWith('/' + preferredModel))) {
      return srcPrio * 10 + busyPenalty - 100;
    }
    const prefIdx = prefList.findIndex((p) => ml === p.toLowerCase() || ml.endsWith('/' + p.toLowerCase()));
    const roleIdx = c.role ? ladder.indexOf(orchRouter.normalizeRole(c.role) || '') : -1;

    let tierScore = 800;
    if (roleIdx === 0) tierScore = (prefIdx >= 0 ? prefIdx : 50);
    else if (prefIdx >= 0 && roleIdx < 0) tierScore = 100 + prefIdx;
    else if (prefIdx >= 0) tierScore = 200 + prefIdx + roleIdx * 30;
    else if (roleIdx > 0) tierScore = 300 + roleIdx * 30;
    else {
      let foundInLadder = false;
      for (let li = 0; li < ladder.length; li++) {
        const rPrefs = TIER_PREFERENCES[ladder[li]] || [];
        const idx = rPrefs.findIndex((p) => ml === p.toLowerCase());
        if (idx >= 0) {
          tierScore = 400 + li * 100 + idx;
          foundInLadder = true;
          break;
        }
      }
      if (!foundInLadder && c.tier) {
        const wantTier = orchRouter.ROLE_TIER[lookupRole] || 'heavy';
        if (c.tier === wantTier) tierScore = 700;
      }
    }
    return srcPrio * 1000 + tierScore + busyPenalty;
  };

  const ranked = pool.slice().sort((a, b) => rankOf(a) - rankOf(b));

  const inferTierAndRole = (cand) => {
    const ml = String((cand && cand.model) || '').toLowerCase();
    const curRole = orchRouter.normalizeRole(cand && cand.role);
    let r = curRole;
    if (!r) {
      if (TIER_PREFERENCES.fast.some((p) => ml === p.toLowerCase()) || /haiku|hydrogen|grok-4-fast|flash|(?:^|[-_/.])mini(?=$|[-_/.])|nano|lite|gemma|27b/i.test(ml)) r = 'fast';
      else if (TIER_PREFERENCES.planner.some((p) => ml === p.toLowerCase()) || /opus|carbon-high|neon-high|gpt-6|fable|grok-4\.5|reasoner|\br1\b/i.test(ml)) r = 'planner';
      else r = 'coder';
    }
    const t = cand && cand.tier ? cand.tier : (orchRouter.ROLE_TIER[r] || 'heavy');
    return { role: r, tier: t };
  };

  const hydratedList = [];
  for (const c of ranked) {
    const clean = { ...c };
    delete clean._source;
    const tag = inferTierAndRole(clean);
    clean.role = clean.role || tag.role;
    clean.tier = clean.tier || tag.tier;
    if (clean.oauthProvider && !clean.accessToken && typeof hydrateProvider === 'function') {
      try {
        const hy = await hydrateProvider(clean);
        hy.role = hy.role || clean.role;
        hy.tier = hy.tier || clean.tier;
        hydratedList.push(hy);
      } catch (_) {
        // Dead account/row does not derail Auto selection
      }
    } else {
      hydratedList.push(clean);
    }
  }

  if (!hydratedList.length && provider && isCandidateUsable({ ...provider }, { store })) {
    const fallback = { ...provider };
    if (!fallback.model || String(fallback.model).toLowerCase() === 'auto') fallback.model = cls.model || prefList[0] || 'llama3.1';
    const tag = inferTierAndRole(fallback);
    fallback.role = fallback.role || tag.role;
    fallback.tier = fallback.tier || tag.tier;
    hydratedList.push(fallback);
  }

  const chosen = hydratedList[0] || { ...(provider || {}), model: cls.model || (TIER_PREFERENCES[lookupRole] || [])[0] || 'llama3.1' };
  const failoverChain = [];
  const chainSeen = new Set([candidateSig(chosen)]);
  const pushChain = (item) => {
    if (!item || failoverChain.length >= 11) return false;
    const sig = candidateSig(item);
    if (chainSeen.has(sig)) return false;
    chainSeen.add(sig);
    failoverChain.push(item);
    return true;
  };
  // Primary failover peers for the active turn tier first (top 4)
  for (const item of hydratedList.slice(1, 5)) pushChain(item);
  // Guarantee multi-tier representation (at least 2 each from critical, heavy, small)
  // so downstream Swarm Manager / Workers always get dedicated tier models.
  for (const wantTier of ['critical', 'heavy', 'small']) {
    const roleKey = wantTier === 'critical' ? 'planner' : (wantTier === 'small' ? 'fast' : 'coder');
    const tierPrefs = (TIER_PREFERENCES[roleKey] || []).map((x) => x.toLowerCase());
    const tierCandidates = hydratedList
      .filter((item) => item.tier === wantTier)
      .sort((a, b) => {
        const ai = tierPrefs.indexOf(String(a.model || '').toLowerCase());
        const bi = tierPrefs.indexOf(String(b.model || '').toLowerCase());
        return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
      });
    let added = 0;
    for (const item of tierCandidates) {
      if (pushChain(item) && ++added >= 2) break;
    }
  }
  // Fill any remaining failover slots up to 11
  for (const item of hydratedList.slice(1)) pushChain(item);

  return {
    chosen,
    failoverChain,
    classification: { ...cls, model: chosen.model || cls.model || '' },
  };
}

async function classifyAndSelect({
  messages = [],
  attachments = [],
  provider = null,
  orchestrator = null,
  oauthAccounts = null,
  ollamaModels = null,
  providerOauth = null,
  modelCatalog = null,
  autoRouterConfig = null,
  fetchImpl = global.fetch,
  hydrateProvider = null,
  callClassifier = null,
  gate = null,
  store = null,
  timeoutMs = 3500,
  signal = null,
} = {}) {
  if (signal && signal.aborted) throw new Error('aborted');

  const estimatedTokens = estimateConversationTokens(messages);
  const text = extractLatestUserPrompt(messages);
  const hasAttImg = Array.isArray(attachments)
    && attachments.some((a) => a && (a.isImage || /^image\//i.test(String(a.mimeType || ''))));
  const hasImages = hasAttImg || orchRouter.hasImages(messages);

  const effAutoCfg = autoRouterConfig
    ? resolveAutoRouterConfig({ autoRouterConfig, env: {} })
    : (store !== false ? resolveAutoRouterConfig({ orchestrator, provider }) : null);

  const roster = buildAvailableRoster({
    providerOauth,
    modelCatalog,
    orchestrator,
    provider,
    oauthAccounts,
    ollamaModels,
    gate,
    store,
  });

  let classification = classifyHeuristic({ messages, attachments, estimatedTokens });

  if (effAutoCfg && effAutoCfg.hasKey) {
    // Preserve explicit media workflow routing (`image_gen` / `video_gen` / `audio_speech`),
    // otherwise delegate classification directly to DeepSeek V4.1 Flash (with <2ms vision/longctx fast-path).
    if (!classification || classification.role === 'fast' || classification.role === 'vision' || classification.role === 'longctx') {
      const dsClass = await classifyWithDeepSeek({
        prompt: text,
        messages,
        hasImages,
        estimatedTokens,
        roster,
        autoRouterConfig: effAutoCfg,
        fetchImpl,
        timeoutMs,
        signal,
      });
      if (dsClass) classification = dsClass;
    }
  } else if (!classification) {
    const classifierProvider = resolveClassifierProvider({
      provider,
      orchestrator,
      oauthAccounts,
      ollamaModels,
      store,
    });
    if (classifierProvider && typeof callClassifier === 'function') {
      classification = await classifyWithSmallAI({
        text,
        classifierProvider,
        callClassifier,
        hydrateProvider,
        timeoutMs: Math.min(450, Number(timeoutMs) || 450),
        signal,
      });
    }
    if (!classification) {
      classification = scorePromptComplexity(text, messages);
    }
  }

  return selectModelForTier({
    classification,
    provider,
    orchestrator,
    oauthAccounts,
    ollamaModels,
    hydrateProvider,
    gate,
    store,
    roster,
  });
}

module.exports = {
  DEFAULT_AUTO_ROUTER_CONFIG,
  AUTO_SWITCH_SOURCES,
  DEEPSEEK_ROUTER_SYSTEM_PROMPT,
  ROLE_DISPLAY,
  TIER_PREFERENCES,
  VENDOR_MODELS_BY_PROVIDER,
  CLASSIFIER_SYSTEM_PROMPT,
  extractLatestUserPrompt,
  estimateConversationTokens,
  isCandidateUsable,
  candidateSourcePriority,
  resolveAutoRouterConfig,
  resolveAutoSwitchConfig: resolveAutoRouterConfig,
  buildAvailableRoster,
  classifyHeuristic,
  scorePromptComplexity,
  classifyPromptTier,
  pickFromRolePool,
  resolveClassifierProvider,
  classifyWithSmallAI,
  classifyWithDeepSeek,
  dispatchWithDeepSeekFlash,
  pingDeepSeekDispatcher,
  getDispatcherTelemetry,
  recordDispatcherDecision,
  resetDispatcherTelemetry,
  selectModelForTier,
  classifyAndSelect,
};
