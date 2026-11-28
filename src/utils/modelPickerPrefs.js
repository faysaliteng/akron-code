export const MODEL_PICKER_PREFS_KEY = 'autobot:modelPickerPrefs';

export const DEFAULT_MODEL_PICKER_PREFS = Object.freeze({
  layout: 'cards', // 'compact' | 'cards' | 'grid'
  hideUnconfiguredProviders: true,
  pinnedModels: [],
  hiddenProviders: [],
  hiddenModels: [],
});

export function normalizeModelPickerPrefs(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const layout = ['compact', 'cards', 'grid'].includes(src.layout) ? src.layout : 'cards';
  const hideUnconfiguredProviders = src.hideUnconfiguredProviders !== undefined ? Boolean(src.hideUnconfiguredProviders) : true;
  const uniq = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || '').trim()).filter(Boolean)));
  return {
    layout,
    hideUnconfiguredProviders,
    pinnedModels: uniq(src.pinnedModels),
    hiddenProviders: uniq(src.hiddenProviders),
    hiddenModels: uniq(src.hiddenModels),
  };
}

export function loadModelPickerPrefs(settings = null) {
  let storedLocal = null;
  try {
    if (typeof localStorage !== 'undefined') {
      const s = localStorage.getItem(MODEL_PICKER_PREFS_KEY);
      if (s) storedLocal = JSON.parse(s);
    }
  } catch (_) {}
  const fromSettings = settings && settings.modelPicker && typeof settings.modelPicker === 'object'
    ? settings.modelPicker
    : null;
  if (fromSettings && !storedLocal) return normalizeModelPickerPrefs(fromSettings);
  if (storedLocal && fromSettings) {
    return normalizeModelPickerPrefs({ ...fromSettings, ...storedLocal });
  }
  return normalizeModelPickerPrefs(storedLocal || fromSettings || DEFAULT_MODEL_PICKER_PREFS);
}

export function saveModelPickerPrefs(prefs) {
  const clean = normalizeModelPickerPrefs(prefs);
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(MODEL_PICKER_PREFS_KEY, JSON.stringify(clean));
    }
  } catch (_) {}
  try {
    if (typeof window !== 'undefined' && window.autobot && typeof window.autobot.setSettings === 'function') {
      window.autobot.setSettings({ modelPicker: clean }).catch(() => {});
    }
  } catch (_) {}
  return clean;
}

export function resetModelPickerPrefs() {
  return saveModelPickerPrefs({ ...DEFAULT_MODEL_PICKER_PREFS });
}

export function toggleListMember(list, value) {
  const key = String(value || '').trim();
  if (!key) return Array.isArray(list) ? list : [];
  const arr = Array.isArray(list) ? list : [];
  return arr.includes(key) ? arr.filter((x) => x !== key) : [...arr, key];
}

export function togglePinnedModel(prefs, modelKey) {
  const clean = normalizeModelPickerPrefs(prefs);
  return { ...clean, pinnedModels: toggleListMember(clean.pinnedModels, modelKey) };
}

export function toggleHiddenProvider(prefs, providerKey) {
  const clean = normalizeModelPickerPrefs(prefs);
  return { ...clean, hiddenProviders: toggleListMember(clean.hiddenProviders, providerKey) };
}

export function toggleHiddenModel(prefs, modelKey) {
  const clean = normalizeModelPickerPrefs(prefs);
  return { ...clean, hiddenModels: toggleListMember(clean.hiddenModels, modelKey) };
}

export function modelVisibilityKey(providerKey, modelId) {
  return `${String(providerKey || '').toLowerCase()}:${String(modelId || '').toLowerCase()}`;
}

export function isModelHidden(prefs, providerKey, modelId) {
  const hidden = (prefs && Array.isArray(prefs.hiddenModels)) ? prefs.hiddenModels : [];
  const k = modelVisibilityKey(providerKey, modelId);
  return hidden.includes(k) || hidden.includes(String(modelId || ''));
}

export function isModelPinned(prefs, providerKey, modelId) {
  const pinned = (prefs && Array.isArray(prefs.pinnedModels)) ? prefs.pinnedModels : [];
  const k = modelVisibilityKey(providerKey, modelId);
  return pinned.includes(k) || pinned.includes(String(modelId || ''));
}

export function fmtContextWindowBadge(win) {
  const w = Number(win) || 0;
  if (w <= 0) return '';
  if (w >= 1000000) return `${Math.round(w / 100000) / 10}M`;
  if (w % 1024 === 0 && w >= 1024) return `${Math.round(w / 1024)}K`;
  return `${Math.round(w / 1000)}K`;
}
