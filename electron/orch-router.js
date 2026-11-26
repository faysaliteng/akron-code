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

const ROLES = ['planner', 'coder', 'vision', 'fast', 'longctx'];

const ROLE_LABEL = {
  planner: 'Planner / Reasoner',
  coder: 'Implementer / Coder',
  vision: 'Vision / Screen & UI',
  fast: 'Fast chat / Classifier / Router',
  longctx: 'Long context',
};

const ROLE_TIER = { planner: 'critical', coder: 'heavy', vision: 'heavy', fast: 'small', longctx: 'heavy' };

function normalizeRole(x) {
  const v = String(x == null ? '' : x).toLowerCase().trim().replace(/[\s_]+/g, '-');
  if (!v) return null;
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
const FALLBACK = { planner: ['coder'], coder: ['planner'], vision: ['coder'], fast: ['coder'], longctx: ['planner', 'coder'] };
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
};
