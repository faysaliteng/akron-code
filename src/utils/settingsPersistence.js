/**
 * Pure, framework-agnostic settings/provider/orchestrator/UI-state persistence
 * reconciliation helpers. Imported by both the Vite renderer (`src/App.jsx`,
 * `SettingsModalBody.jsx`) and Node unit tests (`test/settings-persistence.test.js`).
 */

export const PERSISTED_SETTINGS_KEYS = [
  // Appearance Studio & Theme
  'theme',
  'surfaceFinish',
  'accentColor',
  'bgPattern',
  'uiDensity',
  'chatWidth',
  'chatCustomWidth',
  'outputWidthMode',
  'outputCustomWidth',
  'chatSidePadding',
  'outputSidePadding',
  'chatAlignment',
  'userPromptAlign',
  'messageGap',
  'codeBlockMaxHeight',
  'messageStyle',
  'borderRadius',
  'chatFontSize',
  'codeFontSize',
  'lineHeight',
  'uiFontFamily',
  'sidebarWidth',
  'actionButtonScale',
  'messageTimestamps',
  'showTimestamps',
  'timestampFormat',
  'actionBarStyle',
  'accentGlow',
  'glassBlur',
  'showModelBadge',
  'showAvatars',
  'showFloatingToolbar',
  // Behavior, Harness, System, Browser & Notifications
  'useMemory',
  'locale',
  'launchAtLogin',
  'harnessProfile',
  'typography',
  'notifications',
  'sounds',
  'preventSleep',
  'keepInTray',
  'autoUpdateScheduler',
  'updateChannel',
  'browserLinkMode',
  'browserDownloadsDir',
  'browserAllowUrls',
  'browserDenyUrls',
  'orchestratorModel',
  'executorModel',
  'voiceEngine',
  'voiceLang',
  'autoSwitch',
  'autoRouter',
];

export const PERSISTED_UI_STATE_KEYS = [
  'permissions',
  'swarmEnabled',
  'webSearch',
  'styleId',
  'sidebarCollapsed',
  'workbenchMode',
  'projects',
  'activeProject',
];

export function extractPersistedSettings(settings = {}) {
  const out = {};
  if (!settings || typeof settings !== 'object') return out;
  for (const k of PERSISTED_SETTINGS_KEYS) {
    if (settings[k] !== undefined) out[k] = settings[k];
  }
  if (settings._updatedAt !== undefined) out._updatedAt = settings._updatedAt;
  return out;
}

function normUrl(u) {
  return String(u || '').trim().replace(/\/+$/, '').toLowerCase();
}

export function isProviderConfigured(p, defaultProvider = {}) {
  if (!p || typeof p !== 'object') return false;
  if (String(p.oauthProvider || '').trim()) return true;
  if (String(p.apiKey || '').trim() && String(p.apiKey) !== String(defaultProvider.apiKey || '')) return true;
  if (p.routingMode === 'orchestrator' || p.routingMode === 'auto') return true;
  const curBase = normUrl(p.baseURL);
  const defBase = normUrl(defaultProvider.baseURL);
  if (curBase && curBase !== defBase) return true;
  const curModel = String(p.model || '').trim().toLowerCase();
  const defModel = String(defaultProvider.model || '').trim().toLowerCase();
  if (curModel && curModel !== defModel) return true;
  return false;
}

export function isUntouchedDefaultProvider(p, hasLocalProvider, defaultProvider = {}) {
  if (!hasLocalProvider) return true;
  if (!p || typeof p !== 'object') return true;
  if (Number(p._updatedAt || 0) > 0) return false;
  return !isProviderConfigured(p, defaultProvider);
}

export function mergeBootSettings({
  localSettings = null,
  hasLocalSettings = false,
  designPrefs = null,
  diskSettings = null,
  defaultAppearance = {},
  normalizeTypography = (t) => t,
} = {}) {
  const diskTop = extractPersistedSettings(diskSettings || {});
  const diskUi = extractPersistedSettings((diskSettings && diskSettings.uiSettings) || {});
  const disk = { ...diskTop, ...diskUi };
  const diskTs = Number(
    (diskSettings && diskSettings.uiSettings && diskSettings.uiSettings._updatedAt)
    || (diskSettings && diskSettings._updatedAt)
    || 0
  );
  const localObj = (localSettings && typeof localSettings === 'object') ? localSettings : {};
  const localTs = Number(localObj._updatedAt || 0);
  const designObj = (designPrefs && typeof designPrefs === 'object') ? designPrefs : {};
  const hasDisk = Object.keys(disk).length > 0;
  const localWins = hasLocalSettings && (!hasDisk || localTs >= diskTs);

  const baseDefaults = {
    ...defaultAppearance,
    useMemory: true,
    locale: 'en',
    harnessProfile: 'full',
  };

  let merged;
  if (localWins) {
    merged = { ...baseDefaults, ...disk, ...designObj, ...localObj };
  } else {
    merged = { ...baseDefaults, ...designObj, ...localObj, ...disk };
  }

  const notifDefaults = { agent: true, permissions: true, questions: true, errors: false };
  const soundDefaults = {
    agent: 'staplebops-01',
    permissions: 'staplebops-02',
    questions: 'staplebops-05',
    errors: 'none',
  };
  merged.notifications = localWins
    ? { ...notifDefaults, ...(disk.notifications || {}), ...(localObj.notifications || {}) }
    : { ...notifDefaults, ...(localObj.notifications || {}), ...(disk.notifications || {}) };
  merged.sounds = localWins
    ? { ...soundDefaults, ...(disk.sounds || {}), ...(localObj.sounds || {}) }
    : { ...soundDefaults, ...(localObj.sounds || {}), ...(disk.sounds || {}) };
  merged.typography = normalizeTypography(merged.typography);
  merged.harnessProfile = merged.harnessProfile || 'full';
  delete merged._updatedAt;
  return merged;
}

export function mergeProviderKeys(diskKeys = {}, localKeys = {}) {
  const out = {};
  for (const src of [diskKeys, localKeys]) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (v || !(k in out)) out[k] = v;
    }
  }
  return out;
}

export function reconcileBootProvider({
  localProvider = null,
  hasLocalProvider = false,
  localKeys = {},
  diskProvider = null,
  diskKeys = {},
  diskOrchestrator = null,
  defaultProvider = {},
  presets = [],
  hydrateProviderFn = (p) => p,
} = {}) {
  const mergedKeys = mergeProviderKeys(diskKeys, localKeys);
  const diskValid = diskProvider && typeof diskProvider === 'object'
    && (diskProvider.baseURL || diskProvider.model || diskProvider.oauthProvider || diskProvider.routingMode);
  const diskConfigured = isProviderConfigured(diskProvider, defaultProvider);
  const diskTs = Number((diskProvider && diskProvider._updatedAt) || 0);
  const localTs = Number((localProvider && localProvider._updatedAt) || 0);
  const untouchedDefault = isUntouchedDefaultProvider(localProvider, hasLocalProvider, defaultProvider);

  let chosen;
  let adoptedFromDisk = false;
  if (diskValid && ((!hasLocalProvider && (diskConfigured || diskTs > 0)) || (untouchedDefault && diskConfigured) || diskTs > localTs)) {
    chosen = hydrateProviderFn({ ...defaultProvider, ...diskProvider }, defaultProvider, presets);
    adoptedFromDisk = true;
  } else {
    chosen = hydrateProviderFn(
      hasLocalProvider && localProvider ? { ...defaultProvider, ...localProvider } : { ...defaultProvider },
      defaultProvider,
      presets
    );
    if (diskValid && localTs === 0 && diskTs === 0) {
      const sameEndpoint = normUrl(chosen.baseURL) === normUrl(diskProvider.baseURL)
        && String(chosen.oauthProvider || '') === String(diskProvider.oauthProvider || '');
      if (sameEndpoint && (diskProvider.model || diskProvider.routingMode)) {
        chosen = {
          ...chosen,
          ...(diskProvider.model ? { model: diskProvider.model } : {}),
          ...(diskProvider.routingMode ? { routingMode: diskProvider.routingMode } : {}),
        };
      }
    }
  }

  let healedRoutingMode = false;
  if (diskOrchestrator && diskOrchestrator.enabled === true && (!chosen.routingMode || chosen.routingMode === 'direct')) {
    chosen = { ...chosen, routingMode: 'orchestrator' };
    healedRoutingMode = true;
  }

  if (chosen && chosen.apiKey && chosen.baseURL && !mergedKeys[normUrl(chosen.baseURL)]) {
    mergedKeys[normUrl(chosen.baseURL)] = chosen.apiKey;
  }
  if (chosen && '_updatedAt' in chosen) {
    const clean = { ...chosen };
    delete clean._updatedAt;
    chosen = clean;
  }

  return { provider: chosen, providerKeys: mergedKeys, adoptedFromDisk, healedRoutingMode };
}

export function syncProviderForOrchestratorToggle(provider, nextOrch, prevOrch) {
  const cur = (provider && typeof provider === 'object') ? provider : {};
  const wasEnabled = Boolean(prevOrch && prevOrch.enabled);
  const nowEnabled = Boolean(nextOrch && nextOrch.enabled);
  if (nowEnabled === wasEnabled && !(nowEnabled && (!cur.routingMode || cur.routingMode === 'direct'))) {
    return cur;
  }
  if (nowEnabled) {
    const nextMode = cur.routingMode === 'auto' ? 'auto' : 'orchestrator';
    const patch = { routingMode: nextMode };
    if (!cur.model && nextOrch && Array.isArray(nextOrch.providers) && nextOrch.providers.length) {
      const idx = (nextOrch.activeIndex >= 0 && nextOrch.activeIndex < nextOrch.providers.length) ? nextOrch.activeIndex : 0;
      const head = nextOrch.providers[idx] || nextOrch.providers[0];
      if (head && head.model) {
        patch.model = head.model;
        if (head.oauthProvider) {
          patch.oauthProvider = head.oauthProvider;
          patch.transport = head.transport || '';
          patch.oauth = true;
          patch.baseURL = '';
          patch.apiKey = '';
        } else if (head.baseURL != null) {
          patch.baseURL = head.baseURL;
          patch.apiKey = head.apiKey || cur.apiKey || '';
          patch.oauthProvider = '';
          patch.oauth = false;
          patch.transport = '';
        }
      }
    }
    return { ...cur, ...patch };
  }
  if (cur.routingMode === 'orchestrator') {
    return { ...cur, routingMode: 'direct' };
  }
  return cur;
}

export function mergeBootUiState({
  localUiState = {},
  hasLocalKeyMap = {},
  diskUiState = null,
} = {}) {
  const out = { ...(localUiState || {}) };
  if (!diskUiState || typeof diskUiState !== 'object') return out;
  const diskTs = Number(diskUiState._updatedAt || 0);
  const tsMap = (localUiState && localUiState._timestamps) || {};
  for (const k of PERSISTED_UI_STATE_KEYS) {
    if (!(k in diskUiState) || diskUiState[k] === undefined) continue;
    const localExists = Boolean(hasLocalKeyMap && hasLocalKeyMap[k]);
    const localTs = Number(tsMap[k] || 0);
    if (!localExists || diskTs > localTs) {
      out[k] = diskUiState[k];
    }
  }
  return out;
}
