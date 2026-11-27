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

// Pools apply when the session provider talks to the pool gateway.
function poolsActive(orch, provider) {
  const p = poolsConfig(orch);
  if (!p) return false;
  const gw = normBase(p.gateway && p.gateway.baseURL);
  if (!gw) return false;
  if (provider && provider.oauthProvider) return false;
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
      reasoningLevel: provider && provider.reasoningLevel,
      role: pickedRole,
      tier: ROLE_TIER[pickedRole] || 'heavy',
      frontier: true,
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
        { model: 'glm-5.3', max: 1 },
        { model: 'nemotron-3-ultra-550b-a55b', max: 2 },
      ] },
      // The user's order first; tool-capable Groq / NVIDIA rows sit ahead of
      // devstral-2512 so parallel coders failover to native-tool models first
      // without burning a 429 retry.
      coder: { label: ROLE_LABEL.coder, maxConcurrent: 4, spread: false, models: [
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
        { model: 'qwen3.8-27b', max: 4 },
        { model: 'gpt-oss-120b', max: 4 },
        { model: 'glm-4.7-flash', max: 2 },
        { model: 'kilo-auto', max: 2 },
      ] },
      longctx: { label: ROLE_LABEL.longctx, maxConcurrent: 1, models: [
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
        backend: /gemini|imagen|veo/i.test(ent.model) ? 'gemini' : (/comfy/i.test(ent.model) ? 'comfyui' : 'openai-compat'),
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
      backend: /gemini|imagen|veo/i.test(settingModel) ? 'gemini' : 'openai-compat',
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
      if (k === 'image' && /(imagen|dall-e|gpt-image|flash-image|grok-2-image|flux|sdxl)/i.test(m)) {
        push({ source: 'orchestrator', role: roleName, backend: /imagen|gemini/i.test(m) ? 'gemini' : 'openai-compat', model: m, baseURL: row.baseURL || '', apiKey: row.apiKey || '', oauthProvider: row.oauthProvider || '', offline: false });
      } else if (k === 'video' && /(veo|sora|runway|luma|kling|wan|hunyuan|cogvideo)/i.test(m)) {
        push({ source: 'orchestrator', role: roleName, backend: /veo/i.test(m) ? 'gemini' : 'openai-compat', model: m, baseURL: row.baseURL || '', apiKey: row.apiKey || '', oauthProvider: row.oauthProvider || '', offline: false });
      } else if (k === 'audio' && /(tts|eleven|speech|audio)/i.test(m)) {
        push({ source: 'orchestrator', role: roleName, backend: 'openai-compat', model: m, baseURL: row.baseURL || '', apiKey: row.apiKey || '', offline: false });
      }
    }
  }

  const geminiEnvKey = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const geminiKeyHit = findKeyInProviderKeys(pKeys, [/generativelanguage\.googleapis\.com/i, /ai\.google/i]);
  const geminiKey = geminiEnvKey || (geminiKeyHit && geminiKeyHit.apiKey) || '';
  const geminiOauth = oauthAccts.find((a) => a && !a.needsSignIn && !a.expired && /^(gemini|antigravity|google)$/i.test(String(a.provider || '')));

  const openaiEnvKey = env.OPENAI_API_KEY || '';
  const openaiKeyHit = findKeyInProviderKeys(pKeys, [/api\.openai\.com/i]);
  const openaiKey = openaiEnvKey || (openaiKeyHit && openaiKeyHit.apiKey) || '';
  const chatgptOauth = oauthAccts.find((a) => a && !a.needsSignIn && !a.expired && /^(chatgpt|openai)$/i.test(String(a.provider || '')));

  const xaiKey = env.XAI_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.x\.ai/i]) || {}).apiKey || '';
  const togetherKey = env.TOGETHER_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.together\.xyz/i]) || {}).apiKey || '';
  const openrouterKey = env.OPENROUTER_API_KEY || (findKeyInProviderKeys(pKeys, [/openrouter\.ai/i]) || {}).apiKey || '';
  const fireworksKey = env.FIREWORKS_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.fireworks\.ai/i]) || {}).apiKey || '';
  const replicateKey = env.REPLICATE_API_TOKEN || env.REPLICATE_API_KEY || (findKeyInProviderKeys(pKeys, [/api\.replicate\.com/i]) || {}).apiKey || '';
  const falKey = env.FAL_KEY || env.FAL_API_KEY || (findKeyInProviderKeys(pKeys, [/fal\.run|fal\.ai/i]) || {}).apiKey || '';
  const runwayKey = env.RUNWAYML_API_SECRET || env.RUNWAY_API_KEY || (findKeyInProviderKeys(pKeys, [/runwayml\.com/i]) || {}).apiKey || '';
  const lumaKey = env.LUMA_API_KEY || (findKeyInProviderKeys(pKeys, [/lumalabs\.ai/i]) || {}).apiKey || '';
  const klingKey = env.KLING_API_KEY || (findKeyInProviderKeys(pKeys, [/klingai\.com/i]) || {}).apiKey || '';
  const elevenKey = env.ELEVENLABS_API_KEY || (findKeyInProviderKeys(pKeys, [/elevenlabs\.io/i]) || {}).apiKey || '';

  if (k === 'image') {
    // 2. Google Gemini / Antigravity
    if (geminiKey || geminiOauth) {
      push({ source: geminiKey ? 'api_key' : 'oauth', role: roleName, backend: 'gemini', model: 'imagen-3.0-generate-002', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, oauthProvider: geminiOauth ? geminiOauth.id : '', offline: false });
      push({ source: geminiKey ? 'api_key' : 'oauth', role: roleName, backend: 'gemini-flash-image', model: 'gemini-2.5-flash-image', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, oauthProvider: geminiOauth ? geminiOauth.id : '', responseModalities: ['TEXT', 'IMAGE'], offline: false });
    }
    // 3. OpenAI
    if (openaiKey || chatgptOauth) {
      push({ source: openaiKey ? 'api_key' : 'oauth', role: roleName, backend: 'openai-images', model: 'gpt-image-1', baseURL: 'https://api.openai.com/v1', apiKey: openaiKey, oauthProvider: chatgptOauth ? chatgptOauth.id : '', offline: false });
      push({ source: openaiKey ? 'api_key' : 'oauth', role: roleName, backend: 'openai-images', model: 'dall-e-3', baseURL: 'https://api.openai.com/v1', apiKey: openaiKey, oauthProvider: chatgptOauth ? chatgptOauth.id : '', offline: false });
    }
    // 4. xAI / Together / OpenRouter / Fireworks / Replicate / fal.ai
    if (xaiKey) push({ source: 'api_key', role: roleName, backend: 'xai-images', model: 'grok-2-image', baseURL: 'https://api.x.ai/v1', apiKey: xaiKey, offline: false });
    if (togetherKey) push({ source: 'api_key', role: roleName, backend: 'together-images', model: 'black-forest-labs/FLUX.1.1-pro', baseURL: 'https://api.together.xyz/v1', apiKey: togetherKey, offline: false });
    if (openrouterKey) push({ source: 'api_key', role: roleName, backend: 'openrouter-images', model: 'black-forest-labs/FLUX.1-schnell', baseURL: 'https://openrouter.ai/api/v1', apiKey: openrouterKey, offline: false });
    if (fireworksKey) push({ source: 'api_key', role: roleName, backend: 'fireworks-images', model: 'black-forest-labs/FLUX.1-schnell', baseURL: 'https://api.fireworks.ai/inference/v1', apiKey: fireworksKey, offline: false });
    if (replicateKey) push({ source: 'api_key', role: roleName, backend: 'replicate', model: 'black-forest-labs/flux-1.1-pro', baseURL: 'https://api.replicate.com/v1', apiKey: replicateKey, offline: false });
    if (falKey) push({ source: 'api_key', role: roleName, backend: 'fal', model: 'fal-ai/flux/schnell', baseURL: 'https://fal.run', apiKey: falKey, offline: false });
    // 5. Local runtimes (ComfyUI / Automatic1111 / DrawThings)
    if (localEndpoints && localEndpoints.comfyui) push({ source: 'local', role: roleName, backend: 'comfyui', model: 'comfyui-flux-sdxl', baseURL: typeof localEndpoints.comfyui === 'string' ? localEndpoints.comfyui : 'http://127.0.0.1:8188', apiKey: '', offline: true });
    if (localEndpoints && localEndpoints.a1111) push({ source: 'local', role: roleName, backend: 'a1111', model: 'automatic1111-sd', baseURL: typeof localEndpoints.a1111 === 'string' ? localEndpoints.a1111 : 'http://127.0.0.1:7860', apiKey: '', offline: true });
    if (localEndpoints && localEndpoints.drawthings) push({ source: 'local', role: roleName, backend: 'drawthings', model: 'drawthings-local', baseURL: typeof localEndpoints.drawthings === 'string' ? localEndpoints.drawthings : 'http://127.0.0.1:7888', apiKey: '', offline: true });
    // 6. Guaranteed Offline Fallback
    push({ source: 'offline_fallback', role: roleName, backend: 'offline-image-studio', model: 'akron-svg-canvas-studio', baseURL: '', apiKey: '', offline: true });
  } else if (k === 'video') {
    // 2. Google Veo
    if (geminiKey || geminiOauth) {
      push({ source: geminiKey ? 'api_key' : 'oauth', role: roleName, backend: 'google-veo', model: 'veo-2.0-generate-001', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, oauthProvider: geminiOauth ? geminiOauth.id : '', offline: false });
    }
    // 3. OpenAI Sora
    if (openaiKey || chatgptOauth) {
      push({ source: openaiKey ? 'api_key' : 'oauth', role: roleName, backend: 'openai-sora', model: 'sora', baseURL: 'https://api.openai.com/v1/videos/generations', apiKey: openaiKey, oauthProvider: chatgptOauth ? chatgptOauth.id : '', offline: false });
    }
    // 4. Replicate / fal.ai / Runway / Luma / Kling
    if (falKey) push({ source: 'api_key', role: roleName, backend: 'fal-video', model: 'fal-ai/wan/v2.1', baseURL: 'https://fal.run', apiKey: falKey, offline: false });
    if (replicateKey) push({ source: 'api_key', role: roleName, backend: 'replicate-video', model: 'wan-video/wan-2.1', baseURL: 'https://api.replicate.com/v1', apiKey: replicateKey, offline: false });
    if (runwayKey) push({ source: 'api_key', role: roleName, backend: 'runway', model: 'gen4_turbo', baseURL: 'https://api.dev.runwayml.com/v1', apiKey: runwayKey, offline: false });
    if (lumaKey) push({ source: 'api_key', role: roleName, backend: 'luma', model: 'ray-2', baseURL: 'https://api.lumalabs.ai/dream-machine/v1', apiKey: lumaKey, offline: false });
    if (klingKey) push({ source: 'api_key', role: roleName, backend: 'kling', model: 'kling-v1.6', baseURL: 'https://api.klingai.com/v1', apiKey: klingKey, offline: false });
    // 5. Local ComfyUI video
    if (localEndpoints && localEndpoints.comfyui) push({ source: 'local', role: roleName, backend: 'comfyui-video', model: 'wan2.1-comfyui', baseURL: typeof localEndpoints.comfyui === 'string' ? localEndpoints.comfyui : 'http://127.0.0.1:8188', apiKey: '', offline: true });
    // 6. Guaranteed Offline Fallback
    push({ source: 'offline_fallback', role: roleName, backend: 'offline-video-studio', model: 'akron-motion-canvas-30fps', baseURL: '', apiKey: '', offline: true });
  } else {
    if (openaiKey || chatgptOauth) push({ source: openaiKey ? 'api_key' : 'oauth', role: roleName, backend: 'openai-tts', model: 'gpt-4o-mini-tts', baseURL: 'https://api.openai.com/v1/audio/speech', apiKey: openaiKey, oauthProvider: chatgptOauth ? chatgptOauth.id : '', offline: false });
    if (elevenKey) push({ source: 'api_key', role: roleName, backend: 'elevenlabs', model: 'eleven_multilingual_v2', baseURL: 'https://api.elevenlabs.io/v1', apiKey: elevenKey, offline: false });
    if (geminiKey || geminiOauth) push({ source: geminiKey ? 'api_key' : 'oauth', role: roleName, backend: 'gemini-audio', model: 'gemini-2.5-flash', baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: geminiKey, oauthProvider: geminiOauth ? geminiOauth.id : '', offline: false });
    push({ source: 'offline_fallback', role: roleName, backend: 'offline-audio-studio', model: 'akron-offline-speech', baseURL: '', apiKey: '', offline: true });
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

function summary(orch, provider) {
  if (!poolsActive(orch, provider)) return '';
  return ROLES.map((r) => {
    const rows = resolve(orch, r, provider).filter((x) => x.role === r);
    return rows.length ? `${r}: ${rows.map((x) => x.model).join(' → ')}` : null;
  }).filter(Boolean).join(' | ');
}

module.exports = {
  ROLES, ROLE_LABEL, ROLE_TIER, normalizeRole, tierToRole, isModelAlias, aliasRole, aliasTier,
  poolsConfig, poolsActive, resolve, roleLimit, orchestratorFor, chainFor, hasImages,
  freellmPreset, summary, modelEntry, normBase, rotate,
  resolveMediaChain, resolveMediaProvider, isTextOnlyModelId,
};
