// Pure per-conversation model, routing mode, orchestrator active row, and Swarm state helpers.
// Enables multiple tabs/conversations to run concurrently on different models & workspaces.

export const DRAFT_CONV_KEY = '__draft__';

export function sessionConfigKey(convId) {
  return convId ? String(convId) : DRAFT_CONV_KEY;
}

export function normalizeSessionConfig(cfg, defaults = {}) {
  const defProv = (defaults && defaults.provider && typeof defaults.provider === 'object') ? defaults.provider : {};
  const defOrch = (defaults && defaults.orchestrator && typeof defaults.orchestrator === 'object') ? defaults.orchestrator : {};
  const raw = (cfg && typeof cfg === 'object') ? cfg : {};
  const prov = (raw.provider && typeof raw.provider === 'object') ? { ...defProv, ...raw.provider } : { ...defProv };
  const orchEnabled = raw.orchEnabled !== undefined
    ? Boolean(raw.orchEnabled)
    : (prov.routingMode === 'orchestrator' ? true : (prov.routingMode === 'direct' || prov.routingMode === 'auto' ? false : Boolean(defOrch.enabled)));
  const orchActiveIndex = Number.isFinite(Number(raw.orchActiveIndex))
    ? Number(raw.orchActiveIndex)
    : (Number.isFinite(Number(defOrch.activeIndex)) ? Number(defOrch.activeIndex) : 0);
  const executorModel = typeof raw.executorModel === 'string'
    ? raw.executorModel
    : (typeof defOrch.executorModel === 'string' ? defOrch.executorModel : '');
  const swarmEnabled = raw.swarmEnabled !== undefined
    ? Boolean(raw.swarmEnabled)
    : Boolean(defaults && defaults.swarmEnabled);
  const cwd = typeof raw.cwd === 'string' ? raw.cwd : '';
  return {
    provider: prov,
    orchEnabled,
    orchActiveIndex,
    executorModel,
    swarmEnabled,
    cwd,
  };
}

export function resolveConvSessionConfig({ convId = null, sessionConfigs = {}, convs = [], defaults = {} } = {}) {
  const key = sessionConfigKey(convId);
  const map = sessionConfigs && typeof sessionConfigs === 'object' ? sessionConfigs : {};
  if (map[key] && typeof map[key] === 'object') {
    return normalizeSessionConfig(map[key], defaults);
  }
  if (convId && Array.isArray(convs)) {
    const conv = convs.find((c) => c && c.id === convId);
    if (conv && conv.sessionConfig && typeof conv.sessionConfig === 'object') {
      return normalizeSessionConfig(conv.sessionConfig, defaults);
    }
  }
  return normalizeSessionConfig(null, defaults);
}

export function updateConvSessionConfig(sessionConfigs, convId, patchOrFn, defaults = {}) {
  const map = (sessionConfigs && typeof sessionConfigs === 'object') ? sessionConfigs : {};
  const key = sessionConfigKey(convId);
  const current = resolveConvSessionConfig({ convId, sessionConfigs: map, defaults });
  const rawPatch = typeof patchOrFn === 'function' ? patchOrFn(current) : patchOrFn;
  if (!rawPatch || typeof rawPatch !== 'object') return map;
  const nextCfg = normalizeSessionConfig({
    ...current,
    ...rawPatch,
    provider: rawPatch.provider ? { ...current.provider, ...rawPatch.provider } : current.provider,
  }, defaults);
  return { ...map, [key]: nextCfg };
}

export function buildEffectiveOrchestratorForSession(globalOrchestrator, sessionCfg) {
  const base = (globalOrchestrator && typeof globalOrchestrator === 'object')
    ? globalOrchestrator
    : { enabled: false, providers: [], activeIndex: -1 };
  const cfg = (sessionCfg && typeof sessionCfg === 'object') ? sessionCfg : {};
  return {
    ...base,
    enabled: cfg.orchEnabled !== undefined ? Boolean(cfg.orchEnabled) : Boolean(base.enabled),
    activeIndex: Number.isFinite(Number(cfg.orchActiveIndex))
      ? Number(cfg.orchActiveIndex)
      : (Number.isFinite(Number(base.activeIndex)) ? Number(base.activeIndex) : 0),
    executorModel: cfg.executorModel !== undefined ? String(cfg.executorModel || '') : (base.executorModel || ''),
  };
}

export function formatFooterModelSummary(provider = {}, orchestrator = {}) {
  const p = provider && typeof provider === 'object' ? provider : {};
  const mode = p.routingMode
    || (String(p.model || '').trim().toLowerCase() === 'auto'
      ? 'auto'
      : (orchestrator && orchestrator.enabled ? 'orchestrator' : 'direct'));
  const modelName = String(p.model || '').split('/').pop().trim();
  if (mode === 'auto') {
    return 'Routing: Smart Auto';
  }
  if (mode === 'orchestrator') {
    return modelName ? `Orchestrator · ${modelName}` : 'Orchestrator';
  }
  return modelName ? `Pinned model: ${modelName}` : 'Configure a provider to begin';
}

export function normalizeMcpToolEntry(t) {
  if (typeof t === 'string') return { name: t, description: '' };
  if (t && typeof t === 'object') {
    return {
      name: String(t.name || t.id || t.tool || ''),
      description: String(t.description || ''),
    };
  }
  return { name: '', description: '' };
}
