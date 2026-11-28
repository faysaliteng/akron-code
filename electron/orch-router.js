'use strict';
// ---- Role pools: job-based model routing ------------------------------------
//
// The orchestrator used to know three tiers (small/heavy/critical) and pick
// the FIRST row of a tier, with no failover once a worker was pinned. A swarm
// on a free gateway therefore ran every worker on one model and died on that
// model's first 429.
//
// Role pools assign one ordered model list per JOB:
//
//   planner  — swarm supervisor, plans, architecture, review   (critical)
//   coder    — implementers; N of these run in parallel        (heavy)
//   vision   — turns whose input carries images / screenshots
//   fast     — chat, classification, routing, compaction       (small)
//   longctx  — prompts larger than the active model's window
//
// Each pool fails over DOWNWARD (provider-gate supplies shared cooldowns and
// per-model concurrency caps, so parallel workers spread out instead of all
// queuing on the top row).
//
// Pools belong to one gateway (e.g. the local FreeLLMAPI router). They apply
// only when the session provider IS that gateway, so a Claude/ChatGPT/Gemini
// subscription session keeps using the classic orchestrator list unchanged.
//
// orchestrator.json:
//   pools: { enabled, gateway: { baseURL, apiKey }, roles: { <role>: {
//            label, maxConcurrent, spread, models: [{ model, max }] } } }

const ROLES = ['planner', 'coder', 'vision', 'fast', 'longctx', 'image_gen', 'video_gen', 'audio_speech'];

const ROLE_LABEL = {
  planner: 'Planner / Reasoner',
  coder: 'Implementer / Coder',
  vision: 'Vision / Screen & UI',
  fast: 'Fast chat / Classifier / Router',
  longctx: 'Long context',
  image_gen: 'Image Generation & Editing',
  video_gen: 'Video Generation & Motion',
  audio_speech: 'Speech & Audio Synthesis',
};

const ROLE_TIER = {
  planner: 'critical',
  coder: 'heavy',
  vision: 'heavy',
  fast: 'small',
  longctx: 'heavy',
  image_gen: 'heavy',
  video_gen: 'heavy',
  audio_speech: 'small',
};

function normalizeRole(x) {
  const v = String(x == null ? '' : x).toLowerCase().trim().replace(/[\s_]+/g, '-');
  if (!v) return null;
  if (/^(image-gen|imagegen|imagen|dalle|flux|create-image|draw|img-gen)$/.test(v)) return 'image_gen';
  if (/^(video-gen|videogen|veo|sora|video|animate|vid-gen)$/.test(v)) return 'video_gen';
  if (/^(audio-speech|audiospeech|tts|speech|audio|voice)$/.test(v)) return 'audio_speech';
  if (/^(planner|planning|plan|reasoner|reasoning|architect|architecture|supervisor|lead|critical|review|reviewer|opus)$/.test(v)) return 'planner';
  if (/^(coder|code|coding|implementer|implement|implementation|worker|heavy|builder|engineer|sonnet|general-purpose)$/.test(v)) return 'coder';
  if (/^(vision|visual|screen|ui|image|images|screenshot|multimodal)$/.test(v)) return 'vision';
  if (/^(fast|chat|classifier|classify|router|routing|small|cheap|quick|haiku|explore|search)$/.test(v)) return 'fast';
  if (/^(longctx|long|long-context|longcontext|big-context|large-context|1m)$/.test(v)) return 'longctx';
  return null;
}

function tierToRole(tier) {
  const t = String(tier || '').toLowerCase();
  if (/^(small|cheap|fast|light|mini|nano|tiny)$/.test(t)) return 'fast';
  if (/^(critical|urgent|hardest|top|supervisor)$/.test(t)) return 'planner';
  if (/^(heavy|large|big|frontier|strong|pro|max)$/.test(t)) return 'coder';
  return normalizeRole(t);
}

// Claude Code agent definitions say `model: haiku|sonnet|opus|inherit`. Those
// are aliases, never wire ids: sending "haiku" to a router is a 404.
const MODEL_ALIASES = { haiku: 'fast', sonnet: 'coder', opus: 'planner', fable: 'planner', inherit: null, default: null };
function isModelAlias(m) {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, String(m || '').toLowerCase().trim());
}
function aliasRole(m) {
  const k = String(m || '').toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, k) ? MODEL_ALIASES[k] : undefined;
}
function aliasTier(m) {
  const r = aliasRole(m);
  return r ? ROLE_TIER[r] : null;
}

function normBase(u) {
  return String(u || '').trim().replace(/\/+$/, '').replace(/^(https?:\/\/)localhost\b/i, '$1127.0.0.1').toLowerCase();
}

function poolsConfig(orch) {
  const p = orch && orch.pools;
  if (!p || typeof p !== 'object' || p.enabled === false) return null;
  const roles = p.roles && typeof p.roles === 'object' ? p.roles : null;
  if (!roles) return null;
  const any = ROLES.some((r) => roles[r] && Array.isArray(roles[r].models) && roles[r].models.length);
  return any ? p : null;
}

function isGatewayCredentialReady(baseURL, apiKey, row) {
  if (row && (row.transport === 'cli' || row.cliMode === true || row.oauthProvider)) return true;
  const base = String(baseURL || '').trim();
  const key = String(apiKey || '').trim();
  if (!base) return false;
  if (/(localhost|127\.0\.0\.1):(3001|31415)\b/i.test(base)) return Boolean(key);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base)) return true;
  return Boolean(key);
}

// Pools apply when the session provider talks to the pool gateway.
function poolsActive(orch, provider) {
  const p = poolsConfig(orch);
  if (!p) return false;
  const gw = normBase(p.gateway && p.gateway.baseURL);
  if (!gw) return false;
  if (provider && provider.oauthProvider) return false;
  const effKey = String((p.gateway && p.gateway.apiKey) || (provider && provider.apiKey) || '').trim();
  if (!isGatewayCredentialReady(p.gateway && p.gateway.baseURL, effKey)) return false;
  const base = normBase(provider && provider.baseURL);
  // A gateway mounted at …/v1 and a provider at the bare host are the same server.
  return !!base && (base === gw || base.replace(/\/v1$/, '') === gw.replace(/\/v1$/, ''));
}

function modelEntry(m) {
  if (!m) return null;
  if (typeof m === 'string') {
    const mm = /^\s*([^\s@]+)\s*(?:@\s*(\d+))?\s*$/.exec(m);
    return mm ? { model: mm[1], max: mm[2] ? Number(mm[2]) : 0 } : null;
  }
  if (typeof m === 'object' && m.model) return { ...m, model: String(m.model).trim(), max: Number(m.max || m.maxConcurrent) || 0 };
  return null;
}

// Ordered provider rows for one role. Falls back to a neighbouring pool when a
// role has no models (vision → coder, longctx → planner, …).
const FALLBACK = {
  planner: ['coder'],
  coder: ['planner'],
  vision: ['coder'],
  fast: ['coder'],
  longctx: ['planner', 'coder'],
  image_gen: ['vision'],
  video_gen: ['vision'],
  audio_speech: ['fast'],
};
function resolve(orch, role, provider) {
  const p = poolsConfig(orch);
  if (!p) return [];
  const want = normalizeRole(role) || 'coder';
  const chain = [want].concat(FALLBACK[want] || []);
  let picked = null;
  let pickedRole = want;
  for (const r of chain) {
    const def = p.roles[r];
    if (def && Array.isArray(def.models) && def.models.length) { picked = def; pickedRole = r; break; }
  }
  if (!picked) return [];
  const gw = p.gateway || {};
  const baseURL = String(gw.baseURL || (provider && provider.baseURL) || '').trim();
  const apiKey = String(gw.apiKey || (provider && provider.apiKey) || '');
  const rows = [];
  const seen = new Set();
  for (const raw of picked.models) {
    const m = modelEntry(raw);
    if (!m || !m.model || seen.has(m.model)) continue;
    seen.add(m.model);
    rows.push({
      id: 'pool:' + pickedRole + ':' + m.model,
      name: (ROLE_LABEL[pickedRole] || pickedRole) + ' · ' + m.model,
      baseURL: m.baseURL || baseURL,
      apiKey: m.apiKey || apiKey,
      model: m.model,
      maxConcurrent: m.max > 0 ? m.max : undefined,
      contextWindow: Number(m.contextWindow) || 0,
      supportsTools: m.tools !== false,
      temperature: provider && provider.temperature,
      maxTokens: provider && provider.maxTokens,
      reasoningLevel: pickedRole === 'planner' ? 'high' : (provider && provider.reasoningLevel),
      role: pickedRole,
      tier: ROLE_TIER[pickedRole] || 'heavy',
      frontier: !/\b([1-9]|[12][0-9]|3[0-5])b\b/i.test(m.model),
    });
  }
  return rows;
}

function roleLimit(orch, role) {
  const p = poolsConfig(orch);
  const def = p && p.roles[normalizeRole(role) || 'coder'];
  const n = Number(def && def.maxConcurrent);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function rotate(list, k) {
  if (!list.length) return list;
  const i = ((k % list.length) + list.length) % list.length;
  return list.slice(i).concat(list.slice(0, i));
}

// An orchestrator object scoped to one role, suitable for runAgent(): the
// pool rows ARE the failover list. `index` spreads parallel workers when the
// role is marked `spread` (worker i starts i rows down and wraps), so N coders
// begin on different models and still fail over through the whole pool.
function orchestratorFor(orch, role, provider, opts = {}) {
  let rows = resolve(orch, role, provider);
  if (!rows.length) return null;
  const p = poolsConfig(orch);
  const r = normalizeRole(role) || 'coder';
  const def = p && p.roles[r];
  if (def && def.spread && Number.isFinite(Number(opts.index))) rows = rotate(rows, Number(opts.index));
  if (opts.preferModel) {
    const i = rows.findIndex((x) => x.model === opts.preferModel);
    if (i > 0) rows = [rows[i]].concat(rows.slice(0, i), rows.slice(i + 1));
  }
  return { enabled: true, providers: rows, activeIndex: 0, pools: orch.pools, role: r };
}

// The main turn: if the selected model is in a pool, fail over down THAT pool
// from it; otherwise put the selected model first and the coder pool behind it.
function chainFor(orch, provider, role) {
  const sel = provider && provider.model;
  if (role) {
    const rows = resolve(orch, role, provider);
    if (rows.length) return rows;
  }
  for (const r of ROLES) {
    const rows = resolve(orch, r, provider);
    const i = rows.findIndex((x) => x.model === sel);
    if (i >= 0 && rows[i].role === r) return rows.slice(i).concat(rows.slice(0, i));
  }
  const coder = resolve(orch, 'coder', provider);
  if (!sel || /^(auto|free|fast|smart)(:.*)?$/i.test(String(sel))) return coder.length ? coder : [];
  const head = { ...provider, id: 'pool:selected:' + sel, role: 'coder', tier: 'heavy' };
  return [head].concat(coder.filter((x) => x.model !== sel));
}

function hasImages(messages) {
  const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  if (!last) return false;
  const c = last.content;
  if (Array.isArray(c)) return c.some((part) => part && (part.type === 'image_url' || part.type === 'image' || part.type === 'input_image'));
  return Array.isArray(last.images) && last.images.length > 0;
}

// The FreeLLMAPI layout: one pool per job, each failing over downward.
// ElectronHub models (gpt-5.6-luna, qwen3.8-flash, qwen3-coder, devstral,
// minimax, deepseek) share one weekly credit pool, so they carry max 1; Groq
// has the most parallel headroom and carries the bulk of parallel work.
function freellmPreset(baseURL) {
  return {
    enabled: true,
    gateway: { baseURL: baseURL || 'http://127.0.0.1:3001/v1', apiKey: '' },
    roles: {
      planner: { label: ROLE_LABEL.planner, maxConcurrent: 1, models: [
        { model: 'gpt-5.6-luna', max: 1 },
        { model: 'kimi-k3.1-pro', max: 1 },
        { model: 'glm-5.4', max: 1 },
        { model: 'glm-5.3', max: 1 },
        { model: 'nemotron-3-ultra-550b-a55b', max: 2 },
      ] },
      // The user's order first; tool-capable Groq / NVIDIA rows sit ahead of
      // devstral-2512 so parallel coders failover to native-tool models first
      // without burning a 429 retry.
      coder: { label: ROLE_LABEL.coder, maxConcurrent: 4, spread: false, models: [
        { model: 'kimi-k3', max: 1 },
        { model: 'glm-5.3', max: 1 },
        { model: 'qwen3.8-flash', max: 1 },
        { model: 'qwen3-coder-30b-a3b-instruct', max: 1 },
        { model: 'qwen3.8-27b', max: 3 },
        { model: 'nemotron-3-ultra-550b-a55b', max: 2 },
        { model: 'gpt-oss-120b', max: 3 },
        { model: 'mistral-devstral-2512', max: 1 },
        { model: 'kilo-auto', max: 2 },
      ] },
      vision: { label: ROLE_LABEL.vision, maxConcurrent: 2, models: [
        { model: 'qwen3.8-flash', max: 1 },
        { model: 'qwen3.8-27b', max: 3 },
        { model: 'glm-4.6v-flash', max: 1 },
        { model: 'gemini-3.8-flash', max: 1 },
      ] },
      fast: { label: ROLE_LABEL.fast, maxConcurrent: 6, spread: true, models: [
        { model: 'glm-5.3-flash', max: 2 },
        { model: 'qwen3.8-27b', max: 4 },
        { model: 'gpt-oss-120b', max: 4 },
        { model: 'glm-4.7-flash', max: 2 },
        { model: 'kilo-auto', max: 2 },
      ] },
      longctx: { label: ROLE_LABEL.longctx, maxConcurrent: 1, models: [
        { model: 'kimi-k3.1-pro', max: 1 },
        { model: 'kimi-k3', max: 1 },
        { model: 'glm-5.4', max: 1 },
        { model: 'gpt-5.6-luna', max: 1 },
        { model: 'qwen3.8-flash', max: 1 },
        { model: 'minimax-m3', max: 1 },
        { model: 'deepseek-v4-flash', max: 1 },
      ] },
    },
  };
}

function isTextOnlyModelId(model) {
  const m = String(model || '').toLowerCase();
  if (!m) return false;
  return /^(claude-|deepseek|qwen.*coder|codestral|devstral|o1|o3|o4|gpt-5|gpt-4\.|llama)/.test(m)
    && !/(imagen|dall-e|gpt-image|flash-image|grok-2-image|flux|veo|sora|tts|speech)/i.test(m);
}

function findKeyInProviderKeys(providerKeys, urlMatchers = []) {
  if (!providerKeys || typeof providerKeys !== 'object') return null;
  for (const [rawUrl, rawKey] of Object.entries(providerKeys)) {
    const key = String(rawKey || '').trim();
    if (!key) continue;
    const base = String(rawUrl || '').trim();
    for (const matcher of urlMatchers) {
      if (matcher.test(base)) return { baseURL: base, apiKey: key };
    }
  }
  return null;
}

function probeLocalHttp(url, timeoutMs = 300) {
  return new Promise((resolveProbe) => {
    try {
      const httpMod = require('http');
      const u = new URL(url);
      const req = httpMod.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname || '/',
        method: 'GET',
        timeout: timeoutMs,
      }, (res) => {
        res.resume();
        resolveProbe(res.statusCode < 500);
      });
      req.on('error', () => resolveProbe(false));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} resolveProbe(false); });
      req.end();
    } catch (_) {
      resolveProbe(false);
    }
  });
}

function resolveMediaChain({
  kind = 'image',
  preferredModel = '',
  provider = null,
  orchestrator = null,
  store: storeArg = null,
  env = process.env,
  localEndpoints = null,
  oauthAccounts = null,
} = {}) {
  const k = ['image', 'video', 'audio'].includes(String(kind || '').toLowerCase())
    ? String(kind).toLowerCase()
    : 'image';
  const roleName = k === 'image' ? 'image_gen' : (k === 'video' ? 'video_gen' : 'audio_speech');

  let settings = {};
  let orch = orchestrator || null;
  try {
    const st = storeArg === false ? null : (storeArg || require('./store'));
    if (st && typeof st.getSettings === 'function') settings = st.getSettings() || {};
    if (!orch && storeArg !== false && st && typeof st.getOrchestrator === 'function') orch = st.getOrchestrator() || null;
  } catch (_) {}

  const pKeys = { ...((settings && settings.providerKeys) || {}) };
  if (provider && provider.baseURL && provider.apiKey && !pKeys[provider.baseURL]) {
    pKeys[provider.baseURL] = provider.apiKey;
  }

  let oauthAccts = [];
  if (Array.isArray(oauthAccounts)) {
    oauthAccts = oauthAccounts;
  } else if (storeArg !== false) {
    try {
      const po = require('./provider-oauth');
      if (po && typeof po.listAccounts === 'function') oauthAccts = po.listAccounts() || [];
    } catch (_) {}
  }

  const candidates = [];
  const seen = new Set();
  const push = (row) => {
    if (!row || !row.backend || !row.model) return;
    const sig = `${row.backend}|${row.model}|${row.baseURL || ''}|${row.oauthProvider || ''}`;
    if (seen.has(sig)) return;
    seen.add(sig);
    candidates.push(row);
  };

  // 1. Explicit pool role (image_gen / video_gen / audio_speech) or configured setting model
  const poolRole = orch && orch.pools && orch.pools.roles && orch.pools.roles[roleName];
  if (poolRole && Array.isArray(poolRole.models)) {
    const gw = (orch.pools && orch.pools.gateway) || {};
    for (const raw of poolRole.models) {
      const ent = modelEntry(raw);
      if (!ent || !ent.model) continue;
      push({
        source: 'role_pool',
        role: roleName,
        backend: /veo/i.test(ent.model) ? 'google-veo' : (/flash-image|pro-image/i.test(ent.model) ? 'gemini-flash-image' : (/gemini|imagen/i.test(ent.model) ? 'gemini' : (/comfy/i.test(ent.model) ? 'comfyui' : 'openai-compat'))),
        model: ent.model,
        baseURL: ent.baseURL || gw.baseURL || (provider && provider.baseURL) || '',
        apiKey: ent.apiKey || gw.apiKey || (provider && provider.apiKey) || '',
        offline: false,
      });
    }
  }
  const settingModel = k === 'image' ? settings.imageModel : (k === 'video' ? settings.videoModel : settings.audioModel);
  if (settingModel && typeof settingModel === 'string' && settingModel.trim()) {
    push({
      source: 'settings',
      role: roleName,
      backend: /veo/i.test(settingModel) ? 'google-veo' : (/flash-image|pro-image/i.test(settingModel) ? 'gemini-flash-image' : (/gemini|imagen/i.test(settingModel) ? 'gemini' : 'openai-compat')),
      model: settingModel.trim(),
      baseURL: (provider && provider.baseURL) || '',
      apiKey: (provider && provider.apiKey) || '',
      offline: false,
    });
  }

  // Orchestrator list explicit media rows
  if (orch && Array.isArray(orch.providers)) {
    for (const row of orch.providers) {
      if (!row || !row.model) continue;
      const m = String(row.model);
      if (k === 'image' && /(imagen|dall-e|gpt-image|flash-image|pro-image|grok-2-image|flux|sdxl)/i.test(m)) {
        const bkend = /(?:flash|pro)-image/i.test(m) ? 'gemini-flash-image' : (/imagen|gemini/i.test(m) ? 'gemini' : 'openai-compat');
        push({ source: 'orchestrator', role: roleName, backend: bkend, model: m, baseURL: row.baseURL || (/imagen|gemini/i.test(m) ? 'https://generativelanguage.googleapis.com/v1beta' : ''), apiKey: row.apiKey || '', oauthProvider: row.oauthProvider || '', offline: false });
      } else if (k === 'video' && /(veo|sora|runway|luma|kling|wan|hunyuan|cogvideo)/i.test(m)) {
        push({ source: 'orchestrator', role: roleName, backend: /veo/i.test(m) ? 'google-veo' : 'openai-compat', model: m, baseURL: row.baseURL || (/veo/i.test(m) ? 'https://generativelanguage.googleapis.com/v1beta' : ''), apiKey: row.apiKey || '', oauthProvider: row.oauthProvider || '', offline: false });
      } else if (k === 'audio' && /(tts|eleven|speech|audio)/i.test(m)) {
        push({ source: 'orchestrator', role: roleName, backend: 'openai-compat', model: m, baseURL: row.baseURL || '', apiKey: row.apiKey || '', offline: false });
      }
    }
  }

  let freeLlmProviders = {};
  if (storeArg !== false) {
    try {
      const fl = require('./freellm');
      const cfg = fl && typeof fl.loadConfig === 'function' ? fl.loadConfig() : null;
      if (cfg && cfg.providers && typeof cfg.providers === 'object') {
        freeLlmProviders = { ...cfg.providers };
      }
    } catch (_) {}
  }

  const pickFreeKey = (id) => {
    const e = freeLlmProviders[id];
    if (!e) return '';
    if (typeof e === 'string') return e.trim();
    return String(e.apiKey || e.key || e.token || '').trim();
  };

  const pickSecret = (names = []) => {
    if (storeArg === false) return '';
    try {
      const ss = require('./secretstore');
      if (ss && typeof ss.get === 'function') {
        for (const n of names) {
          const val = ss.get(n);
          if (val && typeof val === 'string' && val.trim()) return val.trim();
        }
      }
    } catch (_) {}
    return '';
  };

  const geminiEnvKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const geminiKeyHit = findKeyInProviderKeys(pKeys, [/generativelanguage\.googleapis\.com/i, /ai\.google/i]);
  const geminiKey = pickSecret(['GEMINI_API_KEY', 'GOOGLE_API_KEY']) || geminiEnvKey || (geminiKeyHit && geminiKeyHit.apiKey) || pickFreeKey('gemini') || pickFreeKey('google') || '';
  const geminiOauth = oauthAccts.find((a) => a && !a.needsSignIn && !a.expired && /^(gemini|antigravity|google)$/i.test(String(a.provider || '')));

  const openaiEnvKey = env.OPENAI_API_KEY || '';
  const openaiKeyHit = findKeyInProviderKeys(pKeys, [/api\.openai\.com/i]);
  const openaiKey = pickSecret(['OPENAI_API_KEY']) || openaiEnvKey || (openaiKeyHit && openaiKeyHit.apiKey) || pickFreeKey('openai') || '';
  const chatgptOauth = oauthAccts.find((a) => a && !a.needsSignIn && !a.expired && /^(chatgpt|openai)$/i.test(String(a.provider || '')));

  const xaiKey = pickSecret(['XAI_API_KEY']) || env.XAI_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.x\.ai/i, /grok\.com/i]) || {}).apiKey || pickFreeKey('xai') || pickFreeKey('grok') || '';
  const togetherKey = pickSecret(['TOGETHER_API_KEY']) || env.TOGETHER_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.together\.xyz/i]) || {}).apiKey || pickFreeKey('together') || '';
  const openrouterKey = pickSecret(['OPENROUTER_API_KEY']) || env.OPENROUTER_API_KEY || (findKeyInProviderKeys(pKeys, [/openrouter\.ai/i]) || {}).apiKey || pickFreeKey('openrouter') || '';
  const fireworksKey = pickSecret(['FIREWORKS_API_KEY']) || env.FIREWORKS_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.fireworks\.ai/i]) || {}).apiKey || pickFreeKey('fireworks') || '';
  const replicateKey = pickSecret(['REPLICATE_API_TOKEN', 'REPLICATE_API_KEY']) || env.REPLICATE_API_TOKEN || env.REPLICATE_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.replicate\.com/i]) || {}).apiKey || '';
  const falKey = pickSecret(['FAL_KEY', 'FAL_API_KEY']) || env.FAL_KEY || env.FAL_API_KEY || (findKeyInProviderKeys(pKeys, [/fal\.run|fal\.ai/i]) || {}).apiKey || '';
  const electronHubKey = pickSecret(['ELECTRONHUB_API_KEY']) || env.ELECTRONHUB_API_KEY || pickFreeKey('electronhub');
  const nvidiaKey = pickSecret(['NVIDIA_API_KEY']) || env.NVIDIA_API_KEY || (findKeyInProviderKeys(pKeys, [/nvidia\.com/i]) || {}).apiKey || pickFreeKey('nvidia') || '';
  const cloudflareEntry = freeLlmProviders.cloudflare;
  const cloudflareKey = pickSecret(['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_API_KEY']) || env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_API_KEY || pickFreeKey('cloudflare') || '';
  const cloudflareAcc = pickSecret(['CLOUDFLARE_ACCOUNT_ID']) || env.CLOUDFLARE_ACCOUNT_ID || (cloudflareEntry && typeof cloudflareEntry === 'object' && (cloudflareEntry.accountId || cloudflareEntry.account_id)) || '';
  const runwayKey = pickSecret(['RUNWAYML_API_SECRET', 'RUNWAY_API_KEY']) || env.RUNWAYML_API_SECRET || env.RUNWAY_API_KEY || (findKeyInProviderKeys(pKeys, [/runwayml\.com/i]) || {}).apiKey || '';
  const lumaKey = pickSecret(['LUMA_API_KEY']) || env.LUMA_API_KEY || (findKeyInProviderKeys(pKeys, [/lumalabs\.ai/i]) || {}).apiKey || '';
  const klingKey = pickSecret(['KLING_API_KEY']) || env.KLING_API_KEY || (findKeyInProviderKeys(pKeys, [/klingai\.com/i]) || {}).apiKey || '';
  const elevenKey = pickSecret(['ELEVENLABS_API_KEY']) || env.ELEVENLABS_API_KEY || (findKeyInProviderKeys(pKeys, [/elevenlabs\.io/i]) || {}).apiKey || '';

  if (k === 'image') {
    // 2. Google Gemini Image / Imagen (requires real API key; chat OAuth logins cannot mint Imagen assets)
    if (geminiKey) {
      push({ source: 'api_key', role: roleName, backend: 'gemini-flash-image', model: 'gemini-2.5-flash-image', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, offline: false });
      push({ source: 'api_key', role: roleName, backend: 'gemini-flash-image', model: 'gemini-3-pro-image', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, offline: false });
      push({ source: 'api_key', role: roleName, backend: 'gemini', model: 'imagen-3.0-generate-002', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, offline: false });
    }
    // 3. OpenAI Image (requires OPENAI_API_KEY; ChatGPT Codex OAuth cannot mint Images API assets)
    if (openaiKey) {
      push({ source: 'api_key', role: roleName, backend: 'openai-images', model: 'gpt-image-1', baseURL: 'https://api.openai.com/v1', apiKey: openaiKey, offline: false });
      push({ source: 'api_key', role: roleName, backend: 'openai-images', model: 'dall-e-3', baseURL: 'https://api.openai.com/v1', apiKey: openaiKey, offline: false });
    }
    // 3b. NVIDIA NIM Flux & FreeLLMAPI configured image backends (ElectronHub / Cloudflare Flux)
    if (nvidiaKey) {
      push({ source: 'api_key', role: roleName, backend: 'nvidia-flux', model: 'black-forest-labs/flux.1-schnell', baseURL: 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell', apiKey: nvidiaKey, offline: false });
    }
    if (electronHubKey) {
      push({ source: 'freellmapi', role: roleName, backend: 'openai-compat', model: 'flux-1.1-pro', baseURL: 'https://api.electronhub.ai/v1', apiKey: electronHubKey, offline: false });
    }
    if (cloudflareKey && cloudflareAcc) {
      push({ source: 'freellmapi', role: roleName, backend: 'cloudflare-flux', model: '@cf/black-forest-labs/flux-1-schnell', baseURL: `https://api.cloudflare.com/client/v4/accounts/${cloudflareAcc}`, apiKey: cloudflareKey, offline: false });
    }
    // 4. xAI Grok / Together / OpenRouter / Fireworks / Replicate / fal.ai (API key required)
    if (xaiKey) {
      push({ source: 'api_key', role: roleName, backend: 'xai-images', model: 'grok-2-image', baseURL: 'https://api.x.ai/v1', apiKey: xaiKey, offline: false });
    }
    if (togetherKey) push({ source: 'api_key', role: roleName, backend: 'together-images', model: 'black-forest-labs/FLUX.1.1-pro', baseURL: 'https://api.together.xyz/v1', apiKey: togetherKey, offline: false });
    if (openrouterKey) push({ source: 'api_key', role: roleName, backend: 'openrouter-images', model: 'black-forest-labs/FLUX.1-schnell', baseURL: 'https://openrouter.ai/api/v1', apiKey: openrouterKey, offline: false });
    if (fireworksKey) push({ source: 'api_key', role: roleName, backend: 'fireworks-images', model: 'black-forest-labs/FLUX.1-schnell', baseURL: 'https://api.fireworks.ai/inference/v1', apiKey: fireworksKey, offline: false });
    if (replicateKey) push({ source: 'api_key', role: roleName, backend: 'replicate', model: 'black-forest-labs/flux-1.1-pro', baseURL: 'https://api.replicate.com/v1', apiKey: replicateKey, offline: false });
    if (falKey) push({ source: 'api_key', role: roleName, backend: 'fal', model: 'fal-ai/flux/schnell', baseURL: 'https://fal.run', apiKey: falKey, offline: false });
    // 5. Local runtimes (ComfyUI / Automatic1111 / DrawThings)
    if (localEndpoints && localEndpoints.comfyui) push({ source: 'local', role: roleName, backend: 'comfyui', model: 'comfyui-flux-sdxl', baseURL: typeof localEndpoints.comfyui === 'string' ? localEndpoints.comfyui : 'http://127.0.0.1:8188', apiKey: '', offline: true });
    if (localEndpoints && localEndpoints.a1111) push({ source: 'local', role: roleName, backend: 'a1111', model: 'automatic1111-sd', baseURL: typeof localEndpoints.a1111 === 'string' ? localEndpoints.a1111 : 'http://127.0.0.1:7860', apiKey: '', offline: true });
    if (localEndpoints && localEndpoints.drawthings) push({ source: 'local', role: roleName, backend: 'drawthings', model: 'drawthings-local', baseURL: typeof localEndpoints.drawthings === 'string' ? localEndpoints.drawthings : 'http://127.0.0.1:7888', apiKey: '', offline: true });
    // 5b. Zero-key real AI Flux generation (unless disabled for pure offline tests)
    if (storeArg !== false && env.AKRON_DISABLE_REMOTE_MEDIA !== '1') {
      push({ source: 'free_ai', role: roleName, backend: 'pollinations-flux', model: 'flux-1-schnell', remoteModel: 'flux', baseURL: 'https://image.pollinations.ai', apiKey: '', offline: false });
      push({ source: 'free_ai', role: roleName, backend: 'pollinations-flux', model: 'flux-realism', remoteModel: 'flux-realism', baseURL: 'https://image.pollinations.ai', apiKey: '', offline: false });
      push({ source: 'free_ai', role: roleName, backend: 'pollinations-flux', model: 'flux-anime', remoteModel: 'flux-anime', baseURL: 'https://image.pollinations.ai', apiKey: '', offline: false });
      push({ source: 'free_ai', role: roleName, backend: 'pollinations-flux', model: 'flux-3d', remoteModel: 'flux-3d', baseURL: 'https://image.pollinations.ai', apiKey: '', offline: false });
    }
    // 6. Guaranteed Offline Fallback
    push({ source: 'offline_fallback', role: roleName, backend: 'offline-image-studio', model: 'akron-svg-canvas-studio', baseURL: '', apiKey: '', offline: true });
  } else if (k === 'video') {
    // Only advertise & route Veo / Sora / Grok Video when real API keys exist (OAuth chat logins for Antigravity/Codex cannot mint Veo/Sora video).
    if (geminiKey) {
      push({ source: 'api_key', role: roleName, backend: 'google-veo', model: 'veo-2.0-generate-001', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, offline: false });
    }
    if (openaiKey) {
      push({ source: 'api_key', role: roleName, backend: 'openai-sora', model: 'sora', baseURL: 'https://api.openai.com/v1/videos/generations', apiKey: openaiKey, offline: false });
    }
    if (xaiKey) {
      push({ source: 'api_key', role: roleName, backend: 'xai-video', model: 'grok-2-video', baseURL: 'https://api.x.ai/v1', apiKey: xaiKey, offline: false });
    }
    if (falKey) push({ source: 'api_key', role: roleName, backend: 'fal-video', model: 'fal-ai/wan/v2.1', baseURL: 'https://fal.run', apiKey: falKey, offline: false });
    if (replicateKey) push({ source: 'api_key', role: roleName, backend: 'replicate-video', model: 'wan-video/wan-2.1', baseURL: 'https://api.replicate.com/v1', apiKey: replicateKey, offline: false });
    if (runwayKey) push({ source: 'api_key', role: roleName, backend: 'runway', model: 'gen4_turbo', baseURL: 'https://api.dev.runwayml.com/v1', apiKey: runwayKey, offline: false });
    if (lumaKey) push({ source: 'api_key', role: roleName, backend: 'luma', model: 'ray-2', baseURL: 'https://api.lumalabs.ai/dream-machine/v1', apiKey: lumaKey, offline: false });
    if (klingKey) push({ source: 'api_key', role: roleName, backend: 'kling', model: 'kling-v1.6', baseURL: 'https://api.klingai.com/v1', apiKey: klingKey, offline: false });
    // Local ComfyUI video
    if (localEndpoints && localEndpoints.comfyui) push({ source: 'local', role: roleName, backend: 'comfyui-video', model: 'wan2.1-comfyui', baseURL: typeof localEndpoints.comfyui === 'string' ? localEndpoints.comfyui : 'http://127.0.0.1:8188', apiKey: '', offline: true });
    // Zero-key 720p AI Keyframe Cinema synthesis (AI-generated Flux scene + smooth 720p 30fps FFmpeg camera motion)
    if (storeArg !== false && env.AKRON_DISABLE_REMOTE_MEDIA !== '1') {
      push({ source: 'free_ai', role: roleName, backend: 'ai-keyframe-video', model: 'flux-cinema-720p', baseURL: 'https://image.pollinations.ai', apiKey: '', offline: false });
    }
    // Guaranteed Offline Fallback
    push({ source: 'offline_fallback', role: roleName, backend: 'offline-video-studio', model: 'akron-motion-canvas-30fps', baseURL: '', apiKey: '', offline: true });
  } else {
    if (openaiKey || chatgptOauth) push({ source: openaiKey ? 'api_key' : 'oauth', role: roleName, backend: 'openai-tts', model: 'gpt-4o-mini-tts', baseURL: 'https://api.openai.com/v1/audio/speech', apiKey: openaiKey, oauthProvider: chatgptOauth ? chatgptOauth.id : '', offline: false });
    if (elevenKey) push({ source: 'api_key', role: roleName, backend: 'elevenlabs', model: 'eleven_multilingual_v2', baseURL: 'https://api.elevenlabs.io/v1', apiKey: elevenKey, offline: false });
    if (geminiKey || geminiOauth) push({ source: geminiKey ? 'api_key' : 'oauth', role: roleName, backend: 'gemini-audio', model: 'gemini-2.5-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, oauthProvider: geminiOauth ? geminiOauth.id : '', offline: false });
    push({ source: 'offline_fallback', role: roleName, backend: 'offline-audio-studio', model: 'akron-offline-speech', baseURL: '', apiKey: '', offline: true });
  }

  const pref = String(preferredModel || '').trim();
  if (pref && pref.toLowerCase() !== 'auto') {
    const pl = pref.toLowerCase();
    let idx = candidates.findIndex((c) => c.model && (c.model.toLowerCase() === pl || c.model.toLowerCase().includes(pl)));
    if (idx < 0 && pl === 'wan-video/wan-2.1') {
      idx = candidates.findIndex((c) => c.model && /wan/i.test(c.model));
    } else if (idx < 0 && pl === 'flux-1.1-pro') {
      idx = candidates.findIndex((c) => c.model && /flux[-.]?1\.1[-.]?pro/i.test(c.model));
    } else if (idx < 0 && /flux\.1-schnell|nvidia-flux/.test(pl)) {
      idx = candidates.findIndex((c) => c.backend === 'nvidia-flux' || /flux\.1-schnell/i.test(c.model));
    }
    if (idx > 0) {
      const [match] = candidates.splice(idx, 1);
      candidates.unshift(match);
    }
  }

  const chosen = candidates[0];
  const activeChatModel = (provider && provider.model) || '';
  return {
    ok: true,
    kind: k,
    role: roleName,
    chosen,
    candidates,
    activeChatModel,
    autoRouted: isTextOnlyModelId(activeChatModel) || (chosen && chosen.model !== activeChatModel),
    fallbackUsed: !!(chosen && chosen.source === 'offline_fallback'),
    backend: chosen ? chosen.backend : '',
    model: chosen ? chosen.model : '',
    baseURL: chosen ? chosen.baseURL : '',
    apiKey: chosen ? chosen.apiKey : '',
    oauthProvider: chosen ? chosen.oauthProvider : '',
    offline: chosen ? !!chosen.offline : true,
  };
}

async function resolveMediaProvider(opts = {}) {
  let local = opts.localEndpoints || null;
  if (!local && opts.probeLocal === true) {
    const [comfy, a1111, draw] = await Promise.all([
      probeLocalHttp('http://127.0.0.1:8188/system_stats', 250),
      probeLocalHttp('http://127.0.0.1:7860/sdapi/v1/sd-models', 250),
      probeLocalHttp('http://127.0.0.1:7888/', 250),
    ]);
    local = {
      comfyui: comfy ? 'http://127.0.0.1:8188' : false,
      a1111: a1111 ? 'http://127.0.0.1:7860' : false,
      drawthings: draw ? 'http://127.0.0.1:7888' : false,
    };
  }
  return resolveMediaChain({ ...opts, localEndpoints: local });
}

const MEDIA_PROVIDER_KEYS = [
  {
    id: 'GEMINI_API_KEY',
    label: 'Google Gemini · Imagen 3 & Veo 2',
    envVar: 'GEMINI_API_KEY',
    placeholder: 'AIzaSy…',
    portalUrl: 'https://aistudio.google.com/apikey',
    unlocksImage: ['Google Imagen 3', 'Gemini 2.5 Flash Image'],
    unlocksVideo: ['Google Veo 2'],
  },
  {
    id: 'OPENAI_API_KEY',
    label: 'OpenAI · GPT-Image-1, DALL·E 3 & Sora',
    envVar: 'OPENAI_API_KEY',
    placeholder: 'sk-proj-…',
    portalUrl: 'https://platform.openai.com/api-keys',
    unlocksImage: ['OpenAI GPT-Image-1', 'OpenAI DALL·E 3'],
    unlocksVideo: ['OpenAI Sora'],
  },
  {
    id: 'XAI_API_KEY',
    label: 'xAI Grok · Grok 2 Image & Video',
    envVar: 'XAI_API_KEY',
    placeholder: 'xai-…',
    portalUrl: 'https://console.x.ai',
    unlocksImage: ['Grok 2 Image'],
    unlocksVideo: ['Grok 2 Video'],
  },
  {
    id: 'FAL_KEY',
    label: 'fal.ai · Wan 2.1 Video & Flux Schnell',
    envVar: 'FAL_KEY',
    placeholder: 'fal_…',
    portalUrl: 'https://fal.ai/dashboard/keys',
    unlocksImage: ['Flux Schnell (fal.ai)'],
    unlocksVideo: ['Wan 2.1 Video'],
  },
  {
    id: 'REPLICATE_API_TOKEN',
    label: 'Replicate · Flux 1.1 Pro & Wan 2.1 Video',
    envVar: 'REPLICATE_API_TOKEN',
    placeholder: 'r8_…',
    portalUrl: 'https://replicate.com/account/api-tokens',
    unlocksImage: ['Flux 1.1 Pro'],
    unlocksVideo: ['Wan 2.1 Video'],
  },
  {
    id: 'TOGETHER_API_KEY',
    label: 'Together AI · Flux 1.1 Pro',
    envVar: 'TOGETHER_API_KEY',
    placeholder: 'tgp_v1_…',
    portalUrl: 'https://api.together.ai/settings/api-keys',
    unlocksImage: ['Flux 1.1 Pro'],
    unlocksVideo: [],
  },
  {
    id: 'KLING_API_KEY',
    label: 'Kling AI · Kling 1.6 Video',
    envVar: 'KLING_API_KEY',
    placeholder: 'kling-…',
    portalUrl: 'https://klingai.com',
    unlocksImage: [],
    unlocksVideo: ['Kling 1.6'],
  },
  {
    id: 'LUMA_API_KEY',
    label: 'Luma Dream Machine · Ray 2 Video',
    envVar: 'LUMA_API_KEY',
    placeholder: 'luma-…',
    portalUrl: 'https://lumalabs.ai/dream-machine/api/keys',
    unlocksImage: [],
    unlocksVideo: ['Luma Ray 2'],
  },
  {
    id: 'NVIDIA_API_KEY',
    label: 'NVIDIA NIM · Flux.1 Schnell',
    envVar: 'NVIDIA_API_KEY',
    placeholder: 'nvapi-…',
    portalUrl: 'https://build.nvidia.com/black-forest-labs/flux_1-schnell',
    unlocksImage: ['Flux.1 Schnell (NVIDIA NIM)'],
    unlocksVideo: [],
  },
  {
    id: 'CLOUDFLARE_API_TOKEN',
    label: 'Cloudflare Workers AI · Flux-1 Schnell',
    envVar: 'CLOUDFLARE_API_TOKEN',
    extraField: { id: 'CLOUDFLARE_ACCOUNT_ID', label: 'Cloudflare Account ID', placeholder: '32-char Account ID' },
    placeholder: 'cfut_…',
    portalUrl: 'https://dash.cloudflare.com',
    unlocksImage: ['Cloudflare Flux-1 Schnell'],
    unlocksVideo: [],
  },
];

function listMediaStudioCatalog(opts = {}) {
  const imgChain = resolveMediaChain({ ...opts, kind: 'image' });
  const vidChain = resolveMediaChain({ ...opts, kind: 'video' });
  const hasCand = (chain, pred) => (chain.candidates || []).some((c) => !c.offline && pred(c));

  const imageModels = [
    { id: 'auto', label: 'Auto (Best Available AI)', provider: 'Akron Router', badge: 'Auto', available: true },
    { id: 'grok-2-image', label: 'Grok 2 Image', provider: 'xAI Grok', badge: 'Grok', configKeyId: 'XAI_API_KEY', requiredKeyLabel: 'XAI_API_KEY', available: hasCand(imgChain, (c) => /grok|xai/i.test(c.model + c.backend)) },
    { id: 'imagen-3.0-generate-002', label: 'Google Imagen 3', provider: 'Google Gemini', badge: 'Imagen 3', configKeyId: 'GEMINI_API_KEY', requiredKeyLabel: 'GEMINI_API_KEY', available: hasCand(imgChain, (c) => c.model === 'imagen-3.0-generate-002') },
    { id: 'gemini-2.5-flash-image', label: 'Gemini 2.5 Flash Image', provider: 'Google Gemini API', badge: 'Gemini', configKeyId: 'GEMINI_API_KEY', requiredKeyLabel: 'GEMINI_API_KEY', available: hasCand(imgChain, (c) => c.model === 'gemini-2.5-flash-image') },
    { id: 'gemini-3-pro-image', label: 'Gemini 3 Pro Image', provider: 'Google Gemini API', badge: 'Gemini 3', configKeyId: 'GEMINI_API_KEY', requiredKeyLabel: 'GEMINI_API_KEY', available: hasCand(imgChain, (c) => c.model === 'gemini-3-pro-image') },
    { id: 'gpt-image-1', label: 'OpenAI GPT-Image-1', provider: 'OpenAI API', badge: 'GPT-Image', configKeyId: 'OPENAI_API_KEY', requiredKeyLabel: 'OPENAI_API_KEY', available: hasCand(imgChain, (c) => c.model === 'gpt-image-1') },
    { id: 'dall-e-3', label: 'OpenAI DALL·E 3', provider: 'OpenAI API', badge: 'DALL·E 3', configKeyId: 'OPENAI_API_KEY', requiredKeyLabel: 'OPENAI_API_KEY', available: hasCand(imgChain, (c) => c.model === 'dall-e-3') },
    { id: 'black-forest-labs/flux.1-schnell', label: 'Flux.1 Schnell (NVIDIA NIM)', provider: 'NVIDIA NIM', badge: 'NVIDIA Flux', configKeyId: 'NVIDIA_API_KEY', requiredKeyLabel: 'NVIDIA_API_KEY', available: hasCand(imgChain, (c) => c.backend === 'nvidia-flux') },
    { id: '@cf/black-forest-labs/flux-1-schnell', label: 'Cloudflare Flux-1 Schnell', provider: 'FreeLLMAPI / Cloudflare', badge: 'Workers AI', configKeyId: 'CLOUDFLARE_API_TOKEN', requiredKeyLabel: 'CLOUDFLARE_API_TOKEN', available: hasCand(imgChain, (c) => c.backend === 'cloudflare-flux') },
    { id: 'flux-1.1-pro', label: 'Flux 1.1 Pro', provider: 'ElectronHub / Together / Replicate', badge: 'Flux Pro', configKeyId: 'TOGETHER_API_KEY', requiredKeyLabel: 'TOGETHER_API_KEY / REPLICATE_API_TOKEN', available: hasCand(imgChain, (c) => /flux[-.]?1\.1[-.]?pro/i.test(c.model)) },
    { id: 'flux-1-schnell', label: 'Flux 1 Schnell (Free AI)', provider: 'Pollinations Flux', badge: 'Free AI', available: true },
    { id: 'flux-realism', label: 'Flux Realism (Free AI)', provider: 'Pollinations Flux', badge: 'Photoreal', available: true },
    { id: 'flux-anime', label: 'Flux Anime (Free AI)', provider: 'Pollinations Flux', badge: 'Anime', available: true },
    { id: 'flux-3d', label: 'Flux 3D Render (Free AI)', provider: 'Pollinations Flux', badge: '3D', available: true },
    { id: 'akron-svg-canvas-studio', label: 'Akron Vector Studio (Offline)', provider: 'Built-in Local', badge: 'Offline', available: true },
  ];

  const videoModels = [
    { id: 'auto', label: 'Auto (Best Available Video)', provider: 'Akron Router', badge: 'Auto', available: true },
    { id: 'flux-cinema-720p', label: 'Flux AI Cinema Video (720p HD Free AI)', provider: 'Flux Keyframe + 30fps Cinema', badge: 'Free AI 720p', available: true },
    { id: 'veo-2.0-generate-001', label: 'Google Veo 2 (Requires GEMINI_API_KEY)', provider: 'Google Gemini API', badge: 'Veo 2', configKeyId: 'GEMINI_API_KEY', requiredKeyLabel: 'GEMINI_API_KEY', available: hasCand(vidChain, (c) => /veo/i.test(c.model)) },
    { id: 'sora', label: 'OpenAI Sora (Requires OPENAI_API_KEY)', provider: 'OpenAI API', badge: 'Sora', configKeyId: 'OPENAI_API_KEY', requiredKeyLabel: 'OPENAI_API_KEY', available: hasCand(vidChain, (c) => /sora/i.test(c.model)) },
    { id: 'grok-2-video', label: 'Grok 2 Video (Requires XAI_API_KEY)', provider: 'xAI API', badge: 'Grok', configKeyId: 'XAI_API_KEY', requiredKeyLabel: 'XAI_API_KEY', available: hasCand(vidChain, (c) => /grok/i.test(c.model)) },
    { id: 'wan-video/wan-2.1', label: 'Wan 2.1 Video (Requires FAL_KEY / REPLICATE)', provider: 'fal.ai / Replicate', badge: 'Wan 2.1', configKeyId: 'FAL_KEY', requiredKeyLabel: 'FAL_KEY / REPLICATE_API_TOKEN', available: hasCand(vidChain, (c) => /wan/i.test(c.model)) },
    { id: 'kling-v1.6', label: 'Kling 1.6 (Requires KLING_API_KEY)', provider: 'Kling AI', badge: 'Kling', configKeyId: 'KLING_API_KEY', requiredKeyLabel: 'KLING_API_KEY', available: hasCand(vidChain, (c) => /kling/i.test(c.model)) },
    { id: 'ray-2', label: 'Luma Ray 2 (Requires LUMA_API_KEY)', provider: 'Luma Dream Machine', badge: 'Luma', configKeyId: 'LUMA_API_KEY', requiredKeyLabel: 'LUMA_API_KEY', available: hasCand(vidChain, (c) => /ray-2/i.test(c.model)) },
    { id: 'akron-motion-canvas-30fps', label: 'Akron 30fps Motion Studio (Offline)', provider: 'Built-in Local FFmpeg', badge: 'Offline 30fps', available: true },
  ];

  const withStatus = (rows) => rows.map((row) => ({
    ...row,
    statusLabel: row.available ? 'Available' : 'Needs API Key',
  }));

  return {
    imageModels: withStatus(imageModels),
    videoModels: withStatus(videoModels),
    activeImageModel: imgChain.model,
    activeVideoModel: vidChain.model,
  };
}

const ORCH_PAID_API_PRESETS = [
  {
    id: 'openrouter',
    name: 'OpenRouter (Paid & Frontier)',
    baseURL: 'https://openrouter.ai/api/v1',
    docsUrl: 'https://openrouter.ai/keys',
    editableBaseUrl: true,
    models: [
      { id: 'anthropic/claude-opus-4.6', label: 'Claude Opus 4.6 (OpenRouter)', tier: 'critical', contextWindow: 1000000 },
      { id: 'anthropic/claude-sonnet-4.6', label: 'Claude Sonnet 4.6 (OpenRouter)', tier: 'heavy', contextWindow: 1000000 },
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5 (OpenRouter)', tier: 'small', contextWindow: 200000 },
      { id: 'deepseek/deepseek-r1', label: 'DeepSeek R1 (OpenRouter)', tier: 'critical', contextWindow: 128000 },
      { id: 'deepseek/deepseek-chat-v3-0324', label: 'DeepSeek V3 (OpenRouter)', tier: 'heavy', contextWindow: 128000 },
      { id: 'qwen/qwen3-coder', label: 'Qwen3 Coder (OpenRouter)', tier: 'heavy', contextWindow: 128000 },
      { id: 'google/gemini-2.5-pro', label: 'Gemini 2.5 Pro (OpenRouter)', tier: 'critical', contextWindow: 1048576 },
      { id: 'google/gemini-2.5-flash', label: 'Gemini 2.5 Flash (OpenRouter)', tier: 'small', contextWindow: 1048576 },
      { id: 'openai/gpt-5', label: 'GPT-5 (OpenRouter)', tier: 'critical', contextWindow: 400000 },
    ],
  },
  {
    id: 'deepseek',
    name: 'DeepSeek Official API',
    baseURL: 'https://api.deepseek.com/v1',
    docsUrl: 'https://platform.deepseek.com/api_keys',
    editableBaseUrl: true,
    models: [
      { id: 'deepseek-reasoner', label: 'DeepSeek Reasoner (R1/V4)', tier: 'critical', contextWindow: 128000 },
      { id: 'deepseek-chat', label: 'DeepSeek Chat (V3/V4)', tier: 'heavy', contextWindow: 128000 },
    ],
  },
  {
    id: 'zai_coding',
    name: 'Z.ai (GLM Coding Plan)',
    baseURL: 'https://api.z.ai/api/coding/paas/v4',
    docsUrl: 'https://z.ai/subscribe',
    editableBaseUrl: true,
    models: [
      { id: 'glm-5.4', label: 'GLM-5.4 (Coding Plan)', tier: 'critical', contextWindow: 1000000 },
      { id: 'glm-5.3', label: 'GLM-5.3 (Coding Plan)', tier: 'heavy', contextWindow: 1000000 },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash (Coding Plan)', tier: 'small', contextWindow: 1000000 },
      { id: 'glm-5', label: 'GLM-5', tier: 'critical', contextWindow: 1000000 },
      { id: 'glm-4.7', label: 'GLM-4.7', tier: 'heavy', contextWindow: 200000 },
    ],
  },
  {
    id: 'glm',
    name: 'GLM / Z.ai (Zhipu API)',
    baseURL: 'https://api.z.ai/api/paas/v4',
    docsUrl: 'https://z.ai/manage-apikey/apikey-list',
    editableBaseUrl: true,
    models: [
      { id: 'glm-5.4', label: 'GLM-5.4', tier: 'critical', contextWindow: 1000000 },
      { id: 'glm-5.3', label: 'GLM-5.3', tier: 'heavy', contextWindow: 1000000 },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash', tier: 'small', contextWindow: 1000000 },
      { id: 'glm-5', label: 'GLM-5', tier: 'critical', contextWindow: 1000000 },
      { id: 'glm-4.7', label: 'GLM-4.7', tier: 'heavy', contextWindow: 200000 },
      { id: 'glm-4-plus', label: 'GLM-4 Plus', tier: 'heavy', contextWindow: 128000 },
      { id: 'glm-4.5', label: 'GLM-4.5', tier: 'heavy', contextWindow: 128000 },
      { id: 'glm-4-air', label: 'GLM-4 Air', tier: 'small', contextWindow: 128000 },
      { id: 'glm-4.7-flash', label: 'GLM-4.7 Flash', tier: 'small', contextWindow: 128000 },
      { id: 'glm-4.6v', label: 'GLM-4.6V Vision', tier: 'heavy', contextWindow: 128000 },
    ],
  },
  {
    id: 'kimi',
    name: 'Kimi / Moonshot AI',
    baseURL: 'https://api.moonshot.ai/v1',
    docsUrl: 'https://platform.moonshot.ai/console/api-keys',
    editableBaseUrl: true,
    models: [
      { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', tier: 'critical', contextWindow: 1048576 },
      { id: 'kimi-k3', label: 'Kimi K3', tier: 'heavy', contextWindow: 1048576 },
      { id: 'kimi-k2.5', label: 'Kimi K2.5', tier: 'critical', contextWindow: 256000 },
      { id: 'kimi-k2-thinking', label: 'Kimi K2 Thinking', tier: 'critical', contextWindow: 256000 },
      { id: 'kimi-k2-0905-preview', label: 'Kimi K2 Preview', tier: 'heavy', contextWindow: 256000 },
      { id: 'moonshot-v1-128k', label: 'Moonshot v1 128K', tier: 'small', contextWindow: 128000 },
    ],
  },
  {
    id: 'ghostmetal',
    name: 'GhostMetal API',
    baseURL: 'https://api.ghostmetal.ai/v1',
    docsUrl: 'https://ghostmetal.ai',
    editableBaseUrl: true,
    models: [
      { id: 'ghostmetal-pro', label: 'GhostMetal Pro', tier: 'critical', contextWindow: 200000 },
      { id: 'ghostmetal-coder', label: 'GhostMetal Coder', tier: 'heavy', contextWindow: 200000 },
      { id: 'ghostmetal-fast', label: 'GhostMetal Fast', tier: 'small', contextWindow: 128000 },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    baseURL: 'https://api.openai.com/v1',
    docsUrl: 'https://platform.openai.com/api-keys',
    editableBaseUrl: true,
    models: [
      { id: 'o3', label: 'OpenAI o3', tier: 'critical', contextWindow: 200000 },
      { id: 'gpt-5', label: 'OpenAI GPT-5', tier: 'critical', contextWindow: 400000 },
      { id: 'gpt-4.1', label: 'OpenAI GPT-4.1', tier: 'heavy', contextWindow: 1000000 },
      { id: 'gpt-4.1-mini', label: 'OpenAI GPT-4.1 Mini', tier: 'small', contextWindow: 1000000 },
      { id: 'gpt-4o-mini', label: 'OpenAI GPT-4o Mini', tier: 'small', contextWindow: 128000 },
    ],
  },
  {
    id: 'anthropic_api',
    name: 'Anthropic API',
    baseURL: 'https://api.anthropic.com/v1',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    editableBaseUrl: true,
    models: [
      { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', tier: 'critical', contextWindow: 1000000 },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'heavy', contextWindow: 1000000 },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'small', contextWindow: 200000 },
    ],
  },
  {
    id: 'gemini_api',
    name: 'Google Gemini API',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    docsUrl: 'https://aistudio.google.com/apikey',
    editableBaseUrl: true,
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', tier: 'critical', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', tier: 'heavy', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', tier: 'small', contextWindow: 1048576 },
    ],
  },
  {
    id: 'xai_api',
    name: 'xAI Grok API',
    baseURL: 'https://api.x.ai/v1',
    docsUrl: 'https://console.x.ai',
    editableBaseUrl: true,
    models: [
      { id: 'grok-4', label: 'Grok 4', tier: 'critical', contextWindow: 256000 },
      { id: 'grok-4-fast-reasoning', label: 'Grok 4 Fast Reasoning', tier: 'critical', contextWindow: 2000000 },
      { id: 'grok-4-fast-non-reasoning', label: 'Grok 4 Fast', tier: 'heavy', contextWindow: 2000000 },
      { id: 'grok-3', label: 'Grok 3', tier: 'heavy', contextWindow: 131072 },
      { id: 'grok-code-fast-1', label: 'Grok Code Fast 1', tier: 'heavy', contextWindow: 131072 },
      { id: 'grok-2-vision-1212', label: 'Grok 2 Vision', tier: 'heavy', contextWindow: 32768 },
      { id: 'grok-3-mini', label: 'Grok 3 Mini', tier: 'small', contextWindow: 131072 },
    ],
  },
  {
    id: 'together',
    name: 'Together AI',
    baseURL: 'https://api.together.xyz/v1',
    docsUrl: 'https://api.together.xyz/settings/api-keys',
    editableBaseUrl: true,
    models: [
      { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8', label: 'Qwen3 Coder 480B', tier: 'critical', contextWindow: 262144 },
      { id: 'deepseek-ai/DeepSeek-R1', label: 'DeepSeek R1 (Together)', tier: 'critical', contextWindow: 128000 },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', label: 'Llama 3.3 70B Turbo', tier: 'heavy', contextWindow: 131072 },
    ],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    baseURL: 'https://api.mistral.ai/v1',
    docsUrl: 'https://console.mistral.ai/api-keys',
    editableBaseUrl: true,
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large', tier: 'critical', contextWindow: 128000 },
      { id: 'codestral-latest', label: 'Codestral', tier: 'heavy', contextWindow: 256000 },
      { id: 'mistral-small-latest', label: 'Mistral Small', tier: 'small', contextWindow: 128000 },
    ],
  },
  {
    id: 'nvidia',
    name: 'NVIDIA NIM',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    docsUrl: 'https://build.nvidia.com',
    editableBaseUrl: true,
    models: [
      { id: 'nvidia/llama-3.1-nemotron-ultra-253b-v1', label: 'Nemotron Ultra 253B', tier: 'critical', contextWindow: 128000 },
      { id: 'deepseek-ai/deepseek-r1', label: 'DeepSeek R1 (NVIDIA)', tier: 'critical', contextWindow: 128000 },
      { id: 'qwen/qwen2.5-coder-32b-instruct', label: 'Qwen 2.5 Coder 32B', tier: 'heavy', contextWindow: 32768 },
    ],
  },
  {
    id: 'groq',
    name: 'Groq Cloud',
    baseURL: 'https://api.groq.com/openai/v1',
    docsUrl: 'https://console.groq.com/keys',
    editableBaseUrl: true,
    models: [
      { id: 'llama-3.3-70b-versatile', label: 'Llama 3.3 70B Versatile', tier: 'heavy', contextWindow: 131072 },
      { id: 'qwen-qwq-32b', label: 'Qwen QwQ 32B', tier: 'heavy', contextWindow: 131072 },
      { id: 'llama-3.1-8b-instant', label: 'Llama 3.1 8B Instant', tier: 'small', contextWindow: 131072 },
    ],
  },
  {
    id: 'tokenrouter',
    name: 'TokenRouter',
    baseURL: 'https://api.tokenrouter.com/v1',
    docsUrl: 'https://tokenrouter.com',
    editableBaseUrl: true,
    models: [
      { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro', tier: 'critical', contextWindow: 256000 },
      { id: 'deepseek/deepseek-v4.1-flash-1017', label: 'DeepSeek V4.1 Flash', tier: 'small', contextWindow: 128000 },
    ],
  },
];

const ORCH_ENV_KEY_RULES = [
  { id: 'xai_api', hostRe: /api\.x\.ai/i, vars: ['XAI_API_KEY', 'GROK_API_KEY'] },
  { id: 'zai_coding', hostRe: /api\.z\.ai\/api\/coding/i, vars: ['ZAI_CODING_API_KEY', 'ZAI_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'] },
  { id: 'glm', hostRe: /(api\.z\.ai|open\.bigmodel\.cn)/i, vars: ['ZAI_API_KEY', 'ZAI_CODING_API_KEY', 'ZHIPUAI_API_KEY', 'GLM_API_KEY'] },
  { id: 'kimi', hostRe: /api\.moonshot\.(ai|cn)/i, vars: ['MOONSHOT_API_KEY', 'KIMI_API_KEY'] },
  { id: 'openai', hostRe: /api\.openai\.com/i, vars: ['OPENAI_API_KEY'] },
  { id: 'anthropic_api', hostRe: /api\.anthropic\.com/i, vars: ['ANTHROPIC_API_KEY'] },
  { id: 'gemini_api', hostRe: /generativelanguage\.googleapis\.com/i, vars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] },
  { id: 'deepseek', hostRe: /api\.deepseek\.com/i, vars: ['DEEPSEEK_API_KEY'] },
  { id: 'openrouter', hostRe: /openrouter\.ai/i, vars: ['OPENROUTER_API_KEY'] },
  { id: 'groq', hostRe: /api\.groq\.com/i, vars: ['GROQ_API_KEY'] },
  { id: 'mistral', hostRe: /api\.mistral\.ai/i, vars: ['MISTRAL_API_KEY'] },
  { id: 'nvidia', hostRe: /integrate\.api\.nvidia\.com/i, vars: ['NVIDIA_API_KEY'] },
  { id: 'together', hostRe: /api\.together\.xyz/i, vars: ['TOGETHER_API_KEY'] },
  { id: 'tokenrouter', hostRe: /api\.tokenrouter\.com/i, vars: ['TOKENROUTER_API_KEY'] },
  { id: 'ghostmetal', hostRe: /api\.ghostmetal\.ai/i, vars: ['GHOSTMETAL_API_KEY'] },
];

function hasConfiguredOrchestratorModels(orch) {
  if (!orch || typeof orch !== 'object') return false;
  const rows = Array.isArray(orch.providers) ? orch.providers : [];
  const hasRow = rows.some((r) => (
    r && r.enabled !== false && String(r.model || '').trim() && (r.oauthProvider || String(r.baseURL || '').trim())
  ));
  if (hasRow) return true;
  const p = poolsConfig(orch);
  return Boolean(p && p.gateway && String(p.gateway.baseURL || '').trim());
}

function resolvePaidProviderApiKey(providerOrRow, { settings = null, secretstore = null, env } = {}) {
  if (!providerOrRow || typeof providerOrRow !== 'object') return '';
  const direct = String(providerOrRow.apiKey || '').trim();
  if (direct) return direct;
  if (providerOrRow.oauthProvider) return '';
  const base = normBase(providerOrRow.baseURL || '');
  const isLoopback = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i.test(base);
  const provId = String(providerOrRow.orchProviderId || providerOrRow.id || '').trim();
  if (secretstore && typeof secretstore.get === 'function') {
    const idAliases = provId === 'zai_coding' ? ['zai_coding', 'glm', 'zai']
      : (provId === 'glm' ? ['glm', 'zai_coding', 'zai'] : (provId ? [provId] : []));
    for (const candidateId of idAliases) {
      try {
        const k = String(secretstore.get('autobot.orch_api_key.' + candidateId) || '').trim();
        if (k) return k;
      } catch (_) {}
    }
    if ((provId === 'zai_coding' || provId === 'glm' || /api\.z\.ai/i.test(base))) {
      for (const slot of ['provider-api:zai:api-key', 'provider-api:zai:coding-plan', 'ZAI_CODING_API_KEY', 'ZAI_API_KEY']) {
        try {
          const k = String(secretstore.get(slot) || '').trim();
          if (k) return k;
        } catch (_) {}
      }
    }
    if (base && !isLoopback) {
      try {
        const k = String(secretstore.get('autobot.orch_base_key.' + base) || '').trim();
        if (k) return k;
      } catch (_) {}
    }
  }
  if (base && !isLoopback && settings && typeof settings === 'object') {
    if (settings.providerKeys && typeof settings.providerKeys === 'object') {
      for (const [rawKey, val] of Object.entries(settings.providerKeys)) {
        if (normBase(rawKey) === base && val && String(val).trim()) {
          return String(val).trim();
        }
      }
    }
    for (const src of [settings.provider, settings.autoRouter]) {
      if (src && typeof src === 'object' && normBase(src.baseURL || '') === base && String(src.apiKey || '').trim()) {
        return String(src.apiKey).trim();
      }
    }
  }
  const effectiveEnv = env !== undefined ? env : ((settings || secretstore) && !process.env.NODE_TEST_CONTEXT ? process.env : null);
  if (effectiveEnv && typeof effectiveEnv === 'object' && providerOrRow.skipEnv !== true) {
    for (const rule of ORCH_ENV_KEY_RULES) {
      if ((provId && rule.id === provId) || (base && rule.hostRe.test(base))) {
        for (const v of rule.vars) {
          const val = String(effectiveEnv[v] || '').trim();
          if (val) return val;
        }
      }
    }
  }
  return '';
}

function filterConnectedCliRows(rows, opts = {}) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  let st = opts.providerStatus || null;
  if (!st) {
    try {
      const po = require('./provider-oauth');
      if (po && typeof po.status === 'function') st = po.status();
    } catch (_) {
      return rows;
    }
  }
  const providers = st && Array.isArray(st.providers) ? st.providers : [];
  if (!providers.length) return rows;

  const provMap = new Map();
  let anyConnectedAnywhere = false;
  for (const pv of providers) {
    if (!pv || !pv.id) continue;
    const accts = Array.isArray(pv.accounts) ? pv.accounts : [];
    const connected = Boolean(pv.signedIn || accts.some((a) => a && a.hasToken !== false && !a.needsSignIn && !a.expired));
    if (connected) anyConnectedAnywhere = true;
    const activeAcct = (accts.find((a) => a && a.account === pv.active && !a.needsSignIn && !a.expired)
      || accts.find((a) => a && !a.needsSignIn && !a.expired)
      || accts[0]
      || null);
    provMap.set(pv.id, { connected, activeAccount: activeAcct ? activeAcct.account : (pv.active || '') });
  }

  const out = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const hasExplicitSecret = Boolean(String(r.apiKey || r.accessToken || '').trim());
    const usesCliOrOauth = Boolean(r.oauthProvider || r.oauth || r.cliMode || r.transport === 'cli') && !hasExplicitSecret;
    if (!usesCliOrOauth) {
      out.push(r);
      continue;
    }
    const rawOauth = String(r.oauthProvider || r.cliKind || '').trim();
    const provKey = rawOauth.split(':')[0].toLowerCase();
    const info = provKey ? provMap.get(provKey) : null;
    if (info && !info.connected) continue;
    if (info && info.activeAccount && rawOauth.includes(':')) {
      const suffix = rawOauth.slice(rawOauth.indexOf(':') + 1);
      const pv = providers.find((p) => p && p.id === provKey);
      const hasSuffix = pv && Array.isArray(pv.accounts) && pv.accounts.some((a) => a && a.account === suffix && !a.needsSignIn && !a.expired);
      if (!hasSuffix && suffix !== info.activeAccount) {
        out.push({ ...r, oauthProvider: `${provKey}:${info.activeAccount}`, account: info.activeAccount });
        continue;
      }
    }
    out.push(r);
  }
  if (!opts.strict && out.length === 0 && !anyConnectedAnywhere) return rows;
  return out;
}

function selectFastConversationalModel(provider, opts = {}) {
  if (!provider || typeof provider !== 'object') return provider;
  const provKey = String(provider.oauthProvider || '').split(':')[0].toLowerCase()
    || String(provider.cliKind || '').toLowerCase()
    || String(provider.transport || '').toLowerCase();
  const rawModel = String(provider.model || '').trim();
  const modelStr = rawModel.toLowerCase();

  // Keep already-fast models intact (only disable heavy thinking)
  if (/(?:haiku|flash|neon-low|hydrogen|mini|nano|-fast\b)/i.test(modelStr)) {
    return { ...provider, _disableThinking: true, reasoningLevel: 'auto', _fastConversational: true };
  }

  let fastModel = '';
  if (provKey === 'claude' || provKey === 'anthropic' || /^claude-/.test(modelStr)) {
    fastModel = 'claude-haiku-4-5-20251001';
    try {
      const mc = require('./model-catalog');
      if (mc && typeof mc.isModelAvailable === 'function' && mc.hasLiveCatalog && mc.hasLiveCatalog('claude') && mc.isModelAvailable('claude', 'claude-haiku-5-5')) {
        fastModel = 'claude-haiku-5-5';
      }
    } catch (_) {}
  } else if (provKey === 'antigravity' || provKey === 'google' || provKey === 'agy' || /^gemini-/.test(modelStr)) {
    fastModel = 'gemini-4-neon-low';
  } else if (provKey === 'chatgpt' || provKey === 'codex' || /^(gpt-|o[1-4]|codex)/.test(modelStr)) {
    fastModel = 'gpt-5-4';
  } else if (provKey === 'grok' || /^grok-/.test(modelStr)) {
    fastModel = 'grok-4-fast';
  } else if (provKey === 'kimi' || /^kimi-/.test(modelStr)) {
    fastModel = 'kimi-k3';
  } else if (provKey === 'zai' || /^glm-/.test(modelStr) || /api\.z\.ai/i.test(String(provider.baseURL || ''))) {
    fastModel = 'glm-5.3-flash';
  } else if (provKey === 'copilot' || provKey === 'github-copilot' || /^copilot-/.test(modelStr)) {
    fastModel = 'copilot-auto';
  }

  if (!fastModel) return { ...provider, _disableThinking: true, reasoningLevel: 'auto', _fastConversational: true };
  return {
    ...provider,
    model: fastModel,
    reasoningLevel: 'auto',
    _disableThinking: true,
    _fastConversational: true,
    ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
  };
}

function summary(orch, provider) {
  if (!poolsActive(orch, provider)) return '';
  return ROLES.map((r) => {
    const rows = resolve(orch, r, provider).filter((x) => x.role === r);
    return rows.length ? `${r}: ${rows.map((x) => x.model).join(' → ')}` : null;
  }).filter(Boolean).join(' | ');
}

module.exports = {
  ROLES, ROLE_LABEL, ROLE_TIER, normalizeRole, tierToRole, isModelAlias, aliasRole, aliasTier,
  poolsConfig, poolsActive, hasConfiguredOrchestratorModels, isGatewayCredentialReady, resolve, roleLimit, orchestratorFor, chainFor, hasImages,
  freellmPreset, summary, modelEntry, normBase, rotate,
  resolveMediaChain, resolveMediaProvider, isTextOnlyModelId, listMediaStudioCatalog, MEDIA_PROVIDER_KEYS,
  ORCH_PAID_API_PRESETS, resolvePaidProviderApiKey,
  filterConnectedCliRows, selectFastConversationalModel,
};
