export const TUTORIAL_SEEN_KEY = 'autobot:tutorialSeenV1';

export const ORCH_SETUP_NOTICE = 'Select at least 1 model in Settings → Orchestrator first (connect OAuth or add an API key & click Auto-Detect).';

export function hasConfiguredOrchestratorModels(orchestrator) {
  if (!orchestrator || typeof orchestrator !== 'object') return false;
  const rows = Array.isArray(orchestrator.providers) ? orchestrator.providers : [];
  if (rows.some((r) => r && r.enabled !== false && String(r.model || '').trim() && (r.oauthProvider || String(r.baseURL || '').trim()))) {
    return true;
  }
  const p = orchestrator.pools;
  if (!p || typeof p !== 'object' || p.enabled === false) return false;
  const roles = p.roles && typeof p.roles === 'object' ? p.roles : null;
  const anyRole = roles && Object.values(roles).some((def) => def && Array.isArray(def.models) && def.models.length);
  return Boolean(anyRole && p.gateway && String(p.gateway.baseURL || '').trim());
}

export function guardOrchestratorAction(orchestrator, openSettings, opts = {}) {
  if (hasConfiguredOrchestratorModels(orchestrator)) return true;
  if (typeof openSettings === 'function') {
    openSettings({ section: 'orchestrator', notice: ORCH_SETUP_NOTICE, ...(opts && opts.preset ? { preset: opts.preset } : {}) });
  }
  return false;
}

export const BEGINNER_PRESETS = [
  {
    id: 'auto',
    shortName: 'Smart Auto',
    title: 'Just Make It Work (Smart Auto)',
    badge: 'Recommended for Everyone',
    icon: 'Lightning',
    bestFor: '95% of everyday questions, quick edits, debugging, and daily work.',
    plainSummary: 'Picks a fast model for easy questions, a coder specialist for file edits, and a frontier model for hard bugs automatically.',
    costSpeed: 'Fast & Balanced',
    teamStyle: 'Single dynamic model per turn (Swarm OFF)',
    flow: ['Your Prompt', 'Smart Router', 'Fast / Coder / Deep Model', 'Direct Answer'],
  },
  {
    id: 'orchestrator',
    shortName: 'Lead + Builder',
    title: 'Lead Planner + Fast Builder (Orchestrator)',
    badge: 'Best Quality + Speed',
    icon: 'Orbit',
    bestFor: 'Multi-file features, refactors, and avoiding rate-limit stops.',
    plainSummary: 'Your best Supervisor model plans and verifies while fast worker models read/edit in parallel — and auto-fails over if any key hits a limit.',
    costSpeed: 'High Quality + Failover',
    teamStyle: '1 Supervisor + Role Pool Workers (Swarm ON by default)',
    flow: ['Your Prompt', 'Supervisor Plans', 'Coder / Explorer Pool', 'Auto-Failover Safety'],
  },
  {
    id: 'swarm',
    shortName: 'Full AI Team',
    title: 'Full AI Team (Orchestrator + Swarm)',
    badge: 'Big Builds & Audits',
    icon: 'Users',
    bestFor: 'Building full apps from scratch or auditing an entire codebase at once.',
    plainSummary: 'A Lead Supervisor splits big jobs across 3–5 specialist agents in isolated Git worktrees talking on a live team board.',
    costSpeed: 'Maximum Power (Uses More Quota)',
    teamStyle: 'Multi-Agent Team Board + Worktrees (Swarm ON)',
    flow: ['Your Goal', 'Lead Splits Tasks', '3–5 Parallel Worktree Agents', 'Merged & Verified'],
  },
  {
    id: 'direct',
    shortName: 'Single Model',
    title: 'Single Pinned Model (Manual)',
    badge: 'Exact Model Only',
    icon: 'Sparkles',
    bestFor: 'When you want ONLY one exact model with zero automatic switching.',
    plainSummary: 'Every turn uses the exact model selected in the bottom model pill until you change it.',
    costSpeed: 'Predictable & Manual',
    teamStyle: '1 Fixed Model (Orchestrator & Swarm OFF)',
    flow: ['Your Prompt', 'Your Pinned Model', 'Single Stream Reply'],
  },
];

export const STARTER_MISSIONS = [
  {
    id: 'quick-auto',
    presetId: 'auto',
    title: 'Ask & Explore Quickly',
    badge: 'Smart Auto',
    duration: '~15 sec',
    icon: 'Lightning',
    desc: 'Test Smart Auto on your open folder: get a plain-English map of what this project does and where key files live.',
    prompt: 'Give me a beginner-friendly overview of this workspace folder: what it does, the 3 most important files, and how to run tests.',
  },
  {
    id: 'build-orchestrator',
    presetId: 'orchestrator',
    title: 'Plan & Build with Preview',
    badge: 'Orchestrator',
    duration: '~1 min',
    icon: 'Orbit',
    desc: 'Let your Lead Supervisor design a clean interactive Pomodoro + Task dashboard page and preview it right inside Akron Code.',
    prompt: '/plan Design and build a single-file interactive Focus Timer & Task Board (pomodoro.html) with dark/light toggle and keyboard shortcuts, then show a plan before writing files.',
  },
  {
    id: 'audit-swarm',
    presetId: 'swarm',
    title: 'Parallel Multi-Agent Audit',
    badge: 'Swarm Team',
    duration: '~2 min',
    icon: 'Users',
    desc: 'Watch 3 specialist agents inspect your project in parallel on the Mission Control board without editing any files.',
    prompt: 'Run a read-only parallel review of this workspace with 3 workers: (1) architecture & bugs, (2) security & edge cases, (3) test coverage gaps. Report findings concisely without modifying files.',
  },
];

function firstEnabledOrchRow(orchestrator, preferModel = '') {
  const rows = (orchestrator && Array.isArray(orchestrator.providers)) ? orchestrator.providers : [];
  const want = String(preferModel || '').trim().toLowerCase();
  if (want) {
    const exact = rows.find((r) => r && r.enabled !== false && String(r.model || '').trim().toLowerCase() === want && (r.oauthProvider || r.transport || String(r.baseURL || '').trim()));
    if (exact) return exact;
  }
  const enabled = rows.find((r) => r && r.enabled !== false && r.model && (r.oauthProvider || r.transport || String(r.baseURL || '').trim()));
  if (enabled) return enabled;
  const anyValid = rows.find((r) => r && r.model && (r.oauthProvider || r.transport || String(r.baseURL || '').trim()));
  if (anyValid) return anyValid;
  const fallback = rows.find((r) => r && r.enabled !== false && r.model) || rows.find((r) => r && r.model);
  if (fallback) return fallback;
  const roles = orchestrator && orchestrator.pools && orchestrator.pools.roles;
  if (roles && typeof roles === 'object') {
    for (const def of Object.values(roles)) {
      const m = def && Array.isArray(def.models) && def.models[0];
      if (typeof m === 'string' && m.trim()) return { model: m.replace(/@\d+$/, '').trim() };
      if (m && m.model) return m;
    }
  }
  return null;
}

function hydratePresetProvider(prevProv, prevOrch, modelId) {
  const cur = prevProv && typeof prevProv === 'object' ? prevProv : {};
  const hasConn = Boolean(cur.oauthProvider || cur.transport || String(cur.baseURL || '').trim());
  const row = firstEnabledOrchRow(prevOrch, modelId);
  if (hasConn && (!row || String(cur.model || '').trim() === String(row.model || '').trim())) {
    return cur;
  }
  if (!row || !row.model) return cur;
  const isOauth = Boolean(row.oauth || row.oauthProvider);
  return {
    ...cur,
    model: modelId || row.model,
    baseURL: row.baseURL || (isOauth ? '' : (cur.baseURL || '')),
    apiKey: row.apiKey || (isOauth ? '' : (cur.apiKey || '')),
    oauthProvider: row.oauthProvider || '',
    transport: row.transport || '',
    oauth: isOauth,
    ...(row.orchProviderId ? { orchProviderId: row.orchProviderId } : {}),
    ...(Number(row.contextWindow) > 0 && !isOauth ? { contextWindow: Number(row.contextWindow) } : { contextWindow: 0 }),
  };
}

export function applyBeginnerPreset(presetId, state = {}) {
  const id = ['auto', 'orchestrator', 'swarm', 'direct'].includes(presetId) ? presetId : 'auto';
  const prevProv = state.provider && typeof state.provider === 'object' ? state.provider : {};
  const prevOrch = state.orchestrator && typeof state.orchestrator === 'object'
    ? state.orchestrator
    : { enabled: false, providers: [], activeIndex: -1 };
  const firstRow = firstEnabledOrchRow(prevOrch);
  const rememberedDirectModel = (prevProv.model && prevProv.model !== 'auto')
    ? prevProv.model
    : (prevProv.lastDirectModel || (firstRow && firstRow.model) || 'gemini-2.5-flash');
  const resolvedProv = hydratePresetProvider(prevProv, prevOrch, rememberedDirectModel);

  if (id === 'auto') {
    return {
      presetId: 'auto',
      provider: {
        ...resolvedProv,
        lastDirectModel: rememberedDirectModel,
        routingMode: 'auto',
        reasoningLevel: 'auto',
        activePresetId: 'auto',
      },
      orchestrator: { ...prevOrch, enabled: false },
      swarmEnabled: false,
      reasoningLevel: 'auto',
      permissions: 'auto',
      notice: 'Applied Smart Auto preset — picks Fast, Coder, or Frontier models automatically (Swarm OFF).',
    };
  }

  if (id === 'orchestrator') {
    return {
      presetId: 'orchestrator',
      provider: {
        ...resolvedProv,
        model: rememberedDirectModel,
        lastDirectModel: rememberedDirectModel,
        routingMode: 'orchestrator',
        reasoningLevel: 'auto',
        activePresetId: 'orchestrator',
      },
      orchestrator: {
        ...prevOrch,
        enabled: true,
        executorModel: prevOrch.executorModel || '',
      },
      swarmEnabled: true,
      reasoningLevel: 'auto',
      permissions: 'auto',
      notice: 'Applied Lead + Builder (Orchestrator + Swarm ON) — Supervisor plans with automatic backup failover.',
    };
  }

  if (id === 'swarm') {
    return {
      presetId: 'swarm',
      provider: {
        ...resolvedProv,
        model: rememberedDirectModel,
        lastDirectModel: rememberedDirectModel,
        routingMode: 'orchestrator',
        reasoningLevel: 'auto',
        activePresetId: 'swarm',
      },
      orchestrator: {
        ...prevOrch,
        enabled: true,
        executorModel: prevOrch.executorModel || '',
      },
      swarmEnabled: true,
      reasoningLevel: 'auto',
      permissions: 'auto',
      notice: 'Applied Full AI Team (Orchestrator + Swarm ON) — turn Swarm OFF later for quick everyday questions.',
    };
  }

  return {
    presetId: 'direct',
    provider: {
      ...resolvedProv,
      model: rememberedDirectModel,
      lastDirectModel: rememberedDirectModel,
      routingMode: 'direct',
      activePresetId: 'direct',
    },
    orchestrator: { ...prevOrch, enabled: false },
    swarmEnabled: false,
    reasoningLevel: state.reasoningLevel || resolvedProv.reasoningLevel || 'auto',
    permissions: state.permissions || 'auto',
    notice: `Applied Single Pinned Model (${rememberedDirectModel}) — Orchestrator & Swarm OFF.`,
  };
}

export function detectActivePreset({ provider, orchestrator, swarmEnabled } = {}) {
  const p = provider || {};
  let id = 'direct';
  if (p.activePresetId === 'orchestrator' && swarmEnabled && (p.routingMode === 'orchestrator' || (orchestrator && orchestrator.enabled))) {
    id = 'orchestrator';
  } else if (swarmEnabled) {
    id = 'swarm';
  } else if (p.routingMode === 'auto' || (!p.routingMode && String(p.model || '').trim().toLowerCase() === 'auto')) {
    id = 'auto';
  } else if (p.routingMode === 'direct') {
    id = 'direct';
  } else if ((orchestrator && orchestrator.enabled) || p.routingMode === 'orchestrator') {
    id = 'orchestrator';
  }
  const orchOn = id === 'swarm' || id === 'orchestrator' || Boolean(orchestrator && orchestrator.enabled);
  const meta = BEGINNER_PRESETS.find((x) => x.id === id) || BEGINNER_PRESETS[0];
  const tip = id === 'swarm'
    ? 'Swarm is ON — great for big multi-file jobs; switch to Smart Auto for fast everyday chat.'
    : meta.plainSummary;
  return { ...meta, id, swarmEnabled: Boolean(swarmEnabled), orchEnabled: orchOn, tip };
}

export function shouldAutoOpenTutorial({ tutorialSeen, isTestEnv, webdriver, search } = {}) {
  if (tutorialSeen) return false;
  if (isTestEnv || webdriver) return false;
  if (typeof search === 'string' && /(?:[?&])notour(?:=|&|$)/i.test(search)) return false;
  return true;
}
