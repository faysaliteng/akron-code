export const UI_FONT_PRESETS = [
  {
    id: 'system',
    label: 'System Default (Inter / SF Pro)',
    stack: "'AnthropicInterface', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'inter',
    label: 'Inter',
    stack: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'geist',
    label: 'Geist Sans',
    stack: "'Geist', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'ibm-plex-sans',
    label: 'IBM Plex Sans',
    stack: "'IBM Plex Sans', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
  },
  {
    id: 'segoe-ui',
    label: 'Segoe UI',
    stack: "'Segoe UI Variable Text', 'Segoe UI', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
  },
  {
    id: 'custom',
    label: 'Custom font…',
    stack: '',
  },
];

export const MONO_FONT_PRESETS = [
  {
    id: 'system',
    label: 'System Mono (SF Mono / Cascadia)',
    stack: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  },
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  },
  {
    id: 'fira-code',
    label: 'Fira Code',
    stack: "'Fira Code', 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
  },
  {
    id: 'cascadia-code',
    label: 'Cascadia Code',
    stack: "'Cascadia Code', Consolas, 'SF Mono', Menlo, monospace",
  },
  {
    id: 'menlo-monaco',
    label: 'Menlo / Monaco',
    stack: "Menlo, Monaco, 'SF Mono', Consolas, 'Courier New', monospace",
  },
  {
    id: 'custom',
    label: 'Custom monospace…',
    stack: '',
  },
];

export const DEFAULT_TYPOGRAPHY = {
  uiPreset: 'system',
  uiCustomFont: '',
  uiSize: 14.75,
  monoPreset: 'system',
  monoCustomFont: '',
  monoSize: 13,
  ligatures: true,
};

export function clampFontSize(val, min, max, fallback) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const rounded = Math.round(n * 2) / 2;
  return Math.max(min, Math.min(max, rounded));
}

function sanitizeCustomFont(raw) {
  const clean = String(raw || '').replace(/[\r\n;{}<>]/g, '').trim();
  return clean.slice(0, 120);
}

function quoteIfNeeded(fontName) {
  const s = sanitizeCustomFont(fontName);
  if (!s) return '';
  if (s.includes(',') || /^['"]/.test(s)) return s;
  return /\s/.test(s) ? `'${s.replace(/'/g, '')}'` : s;
}

export function normalizeTypography(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const validUi = new Set(UI_FONT_PRESETS.map((p) => p.id));
  const validMono = new Set(MONO_FONT_PRESETS.map((p) => p.id));
  return {
    uiPreset: validUi.has(src.uiPreset) ? src.uiPreset : DEFAULT_TYPOGRAPHY.uiPreset,
    uiCustomFont: sanitizeCustomFont(src.uiCustomFont),
    uiSize: clampFontSize(src.uiSize, 12, 20, DEFAULT_TYPOGRAPHY.uiSize),
    monoPreset: validMono.has(src.monoPreset) ? src.monoPreset : DEFAULT_TYPOGRAPHY.monoPreset,
    monoCustomFont: sanitizeCustomFont(src.monoCustomFont),
    monoSize: clampFontSize(src.monoSize, 11, 20, DEFAULT_TYPOGRAPHY.monoSize),
    ligatures: src.ligatures !== false,
  };
}

export function resolveUiFontStack(rawCfg) {
  const cfg = normalizeTypography(rawCfg);
  const fallback = UI_FONT_PRESETS[0].stack;
  if (cfg.uiPreset === 'custom') {
    const q = quoteIfNeeded(cfg.uiCustomFont);
    return q ? `${q}, ${fallback}` : fallback;
  }
  const preset = UI_FONT_PRESETS.find((p) => p.id === cfg.uiPreset);
  return (preset && preset.stack) || fallback;
}

export function resolveMonoFontStack(rawCfg) {
  const cfg = normalizeTypography(rawCfg);
  const fallback = MONO_FONT_PRESETS[0].stack;
  if (cfg.monoPreset === 'custom') {
    const q = quoteIfNeeded(cfg.monoCustomFont);
    return q ? `${q}, ${fallback}` : fallback;
  }
  const preset = MONO_FONT_PRESETS.find((p) => p.id === cfg.monoPreset);
  return (preset && preset.stack) || fallback;
}

export function applyTypographyToDocument(rawCfg, doc = typeof document !== 'undefined' ? document : null) {
  const cfg = normalizeTypography(rawCfg);
  const sans = resolveUiFontStack(cfg);
  const mono = resolveMonoFontStack(cfg);
  const lig = cfg.ligatures ? 'normal' : 'none';
  const feat = cfg.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0';
  const smSize = Math.max(11.5, Math.round((cfg.uiSize - 1.25) * 2) / 2);

  if (doc && doc.documentElement && doc.documentElement.style) {
    const st = doc.documentElement.style;
    st.setProperty('--sans', sans);
    st.setProperty('--micro', sans);
    st.setProperty('--serif', sans);
    st.setProperty('--mono', mono);
    st.setProperty('--fs-body', `${cfg.uiSize}px`);
    st.setProperty('--fs-sm', `${smSize}px`);
    st.setProperty('--fs-code', `${cfg.monoSize}px`);
    st.setProperty('--font-ligatures', lig);
    st.setProperty('--font-feature-settings', feat);
  }
  return { ...cfg, sans, mono, ligatures: cfg.ligatures };
}

export function applyBootTypography(storage = typeof window !== 'undefined' ? window.localStorage : null, doc = typeof document !== 'undefined' ? document : null) {
  try {
    if (storage) {
      const raw = storage.getItem('autobot:settings');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.typography) {
          return applyTypographyToDocument(parsed.typography, doc);
        }
      }
    }
  } catch (_) {}
  return applyTypographyToDocument(DEFAULT_TYPOGRAPHY, doc);
}
