import React, { useState, useEffect } from 'react';
import { Icon } from '../Icon.jsx';
import { DEFAULT_TYPOGRAPHY } from '../../typography.js';

export const ACCENT_PRESETS = [
  { id: 'emerald', label: 'Emerald', hex: '#10b981' },
  { id: 'cyan', label: 'Cyan', hex: '#06b6d4' },
  { id: 'blue', label: 'Blue', hex: '#3b82f6' },
  { id: 'violet', label: 'Violet', hex: '#8b5cf6' },
  { id: 'amber', label: 'Amber', hex: '#f59e0b' },
  { id: 'rose', label: 'Rose', hex: '#f43f5e' },
];

export const UI_DESIGN_PREFS_KEY = 'akron.uiDesignPrefs';

export const DEFAULT_APPEARANCE_SETTINGS = {
  theme: 'dark',
  surfaceFinish: 'emerald-carbon',
  accentColor: '#10b981',
  bgPattern: 'carbon-weave',
  uiDensity: 'comfortable',
  chatWidth: 'standard',
  messageStyle: 'editorial',
  borderRadius: 'balanced',
  chatFontSize: 14,
  codeFontSize: 12.5,
  lineHeight: 1.58,
  uiFontFamily: 'inter',
  sidebarWidth: 256,
  actionButtonScale: 'compact',
  messageTimestamps: 'both',
  showTimestamps: true,
  timestampFormat: 'date-time',
  actionBarStyle: 'compact',
  accentGlow: 'subtle',
  glassBlur: 'standard',
  showModelBadge: true,
  showAvatars: true,
  showFloatingToolbar: false,
};

function hexToRgb(hex) {
  const clean = String(hex || '').trim().replace(/^#/, '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return [16, 185, 129];
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

function shadeHex(hex, factor) {
  const [r, g, b] = hexToRgb(hex);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  const mix = (c) => (factor >= 0 ? c + (255 - c) * factor : c * (1 + factor));
  return '#' + [clamp(mix(r)), clamp(mix(g)), clamp(mix(b))].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export function computeAppearanceVars(settings = {}, systemPrefersLight = false) {
  const theme = settings.theme === 'auto'
    ? (systemPrefersLight ? 'light' : 'dark')
    : (settings.theme === 'light' ? 'light' : 'dark');
  const surface = settings.surfaceFinish || 'emerald-carbon';
  const bgPattern = settings.bgPattern || 'carbon-weave';
  const density = settings.uiDensity || 'comfortable';
  const chatWidth = settings.chatWidth || 'standard';
  const msgStyle = settings.messageStyle || 'editorial';
  const borderRadius = settings.borderRadius || 'balanced';
  const accent = /^#[0-9a-fA-F]{3,6}$/.test(String(settings.accentColor || '')) ? settings.accentColor : '#10b981';
  const [r, g, b] = hexToRgb(accent);
  const chatWidthMap = {
    narrow: '740px',
    focused: '760px',
    standard: '880px',
    wide: '1080px',
    ultra: '1140px',
    full: '100%',
  };
  const radiusMap = {
    sharp: { md: '4px', lg: '5px', card: '6px', composer: '8px' },
    balanced: { md: '7px', lg: '9px', card: '12px', composer: '14px' },
    rounded: { md: '12px', lg: '14px', card: '16px', composer: '18px' },
  };
  const rad = radiusMap[borderRadius] || radiusMap.balanced;
  const chatFs = Math.max(12, Math.min(18, Number(settings.chatFontSize) || 14));
  const codeFs = Math.max(11, Math.min(16, Number(settings.codeFontSize) || 12.5));
  const lineH = Number(settings.lineHeight) || 1.58;
  const sidebarW = Math.max(220, Math.min(320, Number(settings.sidebarWidth) || 256));
  const fontMap = {
    inter: "'AnthropicInterface', 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif",
    jakarta: "'Plus Jakarta Sans', 'AnthropicInterface', 'Inter', -apple-system, system-ui, sans-serif",
    mono: "'JetBrains Mono', 'SF Mono', 'Cascadia Code', ui-monospace, monospace",
  };
  const btnScaleMap = {
    'ultra-compact': { gap: '2px', pad: '1.5px 5px', fs: '10.5px' },
    compact: { gap: '3px', pad: '2px 6px', fs: '11px' },
    standard: { gap: '5px', pad: '3px 8px', fs: '11.5px' },
  };
  const btnScale = btnScaleMap[settings.actionButtonScale || 'compact'] || btnScaleMap.compact;
  const accentGlow = settings.accentGlow || 'subtle';
  const glassBlur = settings.glassBlur || 'standard';
  const blurMap = { off: '0px', standard: '10px', deep: '20px' };

  return {
    theme,
    surface,
    bgPattern,
    density,
    chatWidth,
    msgStyle,
    borderRadius,
    accent,
    accentGlow,
    glassBlur,
    style: {
      '--accent': accent,
      '--accent-strong': shadeHex(accent, -0.22),
      '--accent-soft': `rgba(${r}, ${g}, ${b}, ${accentGlow === 'vibrant' ? '0.24' : (accentGlow === 'none' ? '0.08' : '0.16')})`,
      '--accent-text': theme === 'light' ? shadeHex(accent, -0.35) : shadeHex(accent, 0.58),
      '--chat-max-w': chatWidthMap[chatWidth] || '880px',
      '--radius-md': rad.md,
      '--radius-lg': rad.lg,
      '--radius-card': rad.card,
      '--radius-composer': rad.composer,
      '--fs-body': `${chatFs}px`,
      '--fs-code': `${codeFs}px`,
      '--ui-line-height': String(lineH),
      '--sans': fontMap[settings.uiFontFamily || 'inter'] || fontMap.inter,
      '--sidebar-w': `${sidebarW}px`,
      '--ui-action-btn-gap': btnScale.gap,
      '--ui-action-btn-pad': btnScale.pad,
      '--ui-action-btn-fs': btnScale.fs,
      '--ui-glass-blur': blurMap[glassBlur] || '10px',
    },
  };
}

export function AppearanceStudioSection({ settings, setSettings, setNotice }) {
  const patch = (next) => {
    const updated = { ...settings, ...next };
    setSettings(updated);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(UI_DESIGN_PREFS_KEY, JSON.stringify({
          theme: updated.theme,
          surfaceFinish: updated.surfaceFinish,
          accentColor: updated.accentColor,
          bgPattern: updated.bgPattern,
          uiDensity: updated.uiDensity,
          chatWidth: updated.chatWidth,
          messageStyle: updated.messageStyle,
          borderRadius: updated.borderRadius,
          chatFontSize: updated.chatFontSize,
          codeFontSize: updated.codeFontSize,
          lineHeight: updated.lineHeight,
          uiFontFamily: updated.uiFontFamily,
          sidebarWidth: updated.sidebarWidth,
          actionButtonScale: updated.actionButtonScale,
          messageTimestamps: updated.messageTimestamps,
          showTimestamps: updated.showTimestamps,
          timestampFormat: updated.timestampFormat,
          actionBarStyle: updated.actionBarStyle,
          accentGlow: updated.accentGlow,
          glassBlur: updated.glassBlur,
        }));
      }
    } catch (_) {}
  };
  const resetDefaults = () => {
    patch({
      ...DEFAULT_APPEARANCE_SETTINGS,
      typography: { ...DEFAULT_TYPOGRAPHY },
    });
    if (setNotice) setNotice('Reset Appearance & UI Design Studio to factory defaults.');
  };
  const activeAccent = settings.accentColor || '#10b981';

  return (
    <div data-testid="appearance-studio-section">
      <div className="settings-card">
        <h3><Icon name="Palette" size={14} /> 🎛️ UI &amp; Design Studio · Typography, Surface &amp; Accent</h3>
        <div className="row">
          <label>
            Theme Mode
            <select value={settings.theme || 'dark'} onChange={(e) => patch({ theme: e.target.value })}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="auto">Auto (System)</option>
            </select>
          </label>
          <label>
            Surface Finish
            <select value={settings.surfaceFinish || 'emerald-carbon'} onChange={(e) => patch({ surfaceFinish: e.target.value })}>
              <option value="emerald-carbon">Glossy Emerald Carbon (Default)</option>
              <option value="matte-obsidian">Matte Obsidian (Pure Flat Dark)</option>
              <option value="midnight-glass">Midnight Glass (Translucent Blur)</option>
              <option value="minimal-slate">Minimal Slate (High-Contrast Clean)</option>
            </select>
          </label>
        </div>

        <div className="row">
          <label>
            Chat Font Size ({settings.chatFontSize || 14}px)
            <input type="range" min="12" max="18" step="0.5" value={settings.chatFontSize || 14} onChange={(e) => patch({ chatFontSize: Number(e.target.value) })} />
          </label>
          <label>
            Code Block Font Size ({settings.codeFontSize || 12.5}px)
            <input type="range" min="11" max="16" step="0.5" value={settings.codeFontSize || 12.5} onChange={(e) => patch({ codeFontSize: Number(e.target.value) })} />
          </label>
        </div>

        <div className="row">
          <label>
            Line Height
            <select value={String(settings.lineHeight || 1.58)} onChange={(e) => patch({ lineHeight: Number(e.target.value) })}>
              <option value="1.4">Compact (1.4)</option>
              <option value="1.58">Balanced (1.58 · Default)</option>
              <option value="1.75">Relaxed (1.75)</option>
            </select>
          </label>
          <label>
            UI Font Family
            <select value={settings.uiFontFamily || 'inter'} onChange={(e) => patch({ uiFontFamily: e.target.value })}>
              <option value="inter">Inter / System Sans</option>
              <option value="jakarta">Plus Jakarta Sans</option>
              <option value="mono">JetBrains Mono</option>
            </select>
          </label>
        </div>

        <div className="row">
          <label>
            Background Pattern (Carbon Stripes)
            <select value={settings.bgPattern || 'carbon-weave'} onChange={(e) => patch({ bgPattern: e.target.value })}>
              <option value="carbon-weave">Diagonal Carbon Stripe Pattern (Default)</option>
              <option value="ambient-glow">Soft Radial Top Glow</option>
              <option value="solid">Off (Pure Solid Background)</option>
            </select>
          </label>
          <div className="accent-swatch-field">
            <span className="accent-field-label">Accent Color</span>
            <div className="accent-swatch-row">
              {ACCENT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={'accent-swatch-pill' + (activeAccent.toLowerCase() === p.hex.toLowerCase() ? ' on' : '')}
                  title={p.label}
                  onClick={() => patch({ accentColor: p.hex })}
                >
                  <span className="accent-swatch-dot" style={{ background: p.hex }} />
                  <span>{p.label}</span>
                </button>
              ))}
              <label className="accent-custom-picker" title="Pick custom accent color">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(activeAccent) ? activeAccent : '#10b981'}
                  onChange={(e) => patch({ accentColor: e.target.value })}
                />
                <span>{activeAccent}</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <div className="settings-card">
        <h3><Icon name="Grid" size={14} /> Layout, Message Geometry &amp; Surface Effects</h3>
        <div className="row">
          <label>
            Message Density
            <select value={settings.uiDensity || 'comfortable'} onChange={(e) => patch({ uiDensity: e.target.value })}>
              <option value="compact">Compact</option>
              <option value="comfortable">Comfortable (Default)</option>
              <option value="spacious">Spacious</option>
            </select>
          </label>
          <label>
            Chat Reading Width
            <select value={settings.chatWidth || 'standard'} onChange={(e) => patch({ chatWidth: e.target.value })}>
              <option value="focused">Focused (760px)</option>
              <option value="narrow">Narrow (740px)</option>
              <option value="standard">Standard (880px–920px)</option>
              <option value="wide">Wide (1080px–1140px)</option>
              <option value="full">Full Width (100%)</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Bubble Corner Radius
            <select value={settings.borderRadius || 'balanced'} onChange={(e) => patch({ borderRadius: e.target.value })}>
              <option value="sharp">Sharp (6px)</option>
              <option value="balanced">Modern (12px · Default)</option>
              <option value="rounded">Pill (18px)</option>
            </select>
          </label>
          <label>
            Sidebar Width ({settings.sidebarWidth || 256}px)
            <input type="range" min="220" max="320" step="4" value={settings.sidebarWidth || 256} onChange={(e) => patch({ sidebarWidth: Number(e.target.value) })} />
          </label>
        </div>
        <div className="row">
          <label>
            Message Layout Style
            <select value={settings.messageStyle || 'editorial'} onChange={(e) => patch({ messageStyle: e.target.value })}>
              <option value="editorial">Clean Open Rows (Default)</option>
              <option value="bubbles">Framed Chat Cards</option>
            </select>
          </label>
          <label>
            Accent Glow &amp; Glass Blur
            <div style={{ display: 'flex', gap: 6 }}>
              <select value={settings.accentGlow || 'subtle'} onChange={(e) => patch({ accentGlow: e.target.value })} style={{ flex: 1 }}>
                <option value="none">Glow: None</option>
                <option value="subtle">Glow: Subtle</option>
                <option value="vibrant">Glow: Vibrant</option>
              </select>
              <select value={settings.glassBlur || 'standard'} onChange={(e) => patch({ glassBlur: e.target.value })} style={{ flex: 1 }}>
                <option value="off">Blur: Off</option>
                <option value="standard">Blur: Standard</option>
                <option value="deep">Blur: Deep</option>
              </select>
            </div>
          </label>
        </div>
      </div>

      <div className="settings-card">
        <h3><Icon name="Clock" size={14} /> Action Buttons, Per-Message Timestamps &amp; Reset</h3>
        <div className="row">
          <label>
            Message Timestamps
            <select
              value={settings.messageTimestamps || (settings.showTimestamps === false ? 'hidden' : 'both')}
              onChange={(e) => patch({ messageTimestamps: e.target.value, showTimestamps: e.target.value !== 'hidden' })}
            >
              <option value="both">Input &amp; Output (Default)</option>
              <option value="output">Output Only</option>
              <option value="hover">Show on Hover Only</option>
              <option value="hidden">Hidden</option>
            </select>
          </label>
          <label>
            Timestamp Format
            <select value={settings.timestampFormat || 'date-time'} onChange={(e) => patch({ timestampFormat: e.target.value })}>
              <option value="date-time">Date + Time (Today · 02:39)</option>
              <option value="12h">12-hour (Nov 27 · 2:39 AM)</option>
              <option value="24h">24-hour (27 Nov · 15:15)</option>
              <option value="relative">Relative + Time (5m ago · 02:34)</option>
              <option value="iso">ISO (2026-11-27 02:39:12)</option>
            </select>
          </label>
        </div>
        <div className="row">
          <label>
            Action Button Scale &amp; Spacing
            <select value={settings.actionButtonScale || 'compact'} onChange={(e) => patch({ actionButtonScale: e.target.value })}>
              <option value="ultra-compact">Ultra-Compact (10.5px · 2px gap)</option>
              <option value="compact">Compact (11px · 3px gap · Default)</option>
              <option value="standard">Standard (11.5px · 5px gap)</option>
            </select>
          </label>
          <label>
            Action Button Style
            <select value={settings.actionBarStyle || 'compact'} onChange={(e) => patch({ actionBarStyle: e.target.value })}>
              <option value="compact">Icon + Label (Default)</option>
              <option value="icons-only">Icon Only (Ultra-Compact)</option>
              <option value="hover">Hover Only</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={settings.showModelBadge !== false} onChange={(e) => patch({ showModelBadge: e.target.checked })} />
          Show Model Attribution Badge &amp; Worked Time
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.showAvatars !== false} onChange={(e) => patch({ showAvatars: e.target.checked })} />
          Show Message Avatars
        </label>
        <label className="check">
          <input type="checkbox" checked={!!settings.showFloatingToolbar} onChange={(e) => patch({ showFloatingToolbar: e.target.checked })} />
          Show Legacy Top-Right Floating Message Toolbar
        </label>
        <div style={{ marginTop: 10 }}>
          <button type="button" className="btn-mini" data-testid="reset-appearance-btn" onClick={resetDefaults}>
            <Icon name="Refresh" size={12} /> Reset Appearance to Default
          </button>
        </div>
      </div>
    </div>
  );
}

const DISPATCH_SOURCE_META = {
  openrouter_free: {
    id: 'openrouter_free',
    title: 'Option A — OpenRouter Free API',
    badge: '$0.00 forever · Recommended',
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    placeholder: 'sk-or-v1-... (OpenRouter API Key)',
    pinnedModel: 'deepseek/deepseek-v4.1-flash:free (fallback :free only)',
    linkUrl: 'https://openrouter.ai/keys',
    linkLabel: 'Get Free OpenRouter Key ↗',
  },
  deepseek_api: {
    id: 'deepseek_api',
    title: 'Option B — DeepSeek Platform API',
    badge: '$1 ≈ 40,000+ decisions',
    endpoint: 'https://api.deepseek.com/v1/chat/completions',
    placeholder: 'sk-... (DeepSeek Platform API Key)',
    pinnedModel: 'deepseek-v4-flash (fallback deepseek-chat)',
    linkUrl: 'https://platform.deepseek.com/top_up',
    linkLabel: 'Top Up on platform.deepseek.com ↗',
  },
  freellmapi: {
    id: 'freellmapi',
    title: 'Option C — FreeLLMAPI Unified Key',
    badge: 'Local :31415 / :3001 Router',
    endpoint: 'http://127.0.0.1:31415/v1/chat/completions',
    placeholder: 'flm_... (Optional Unified Key · loopback works out of the box)',
    pinnedModel: 'deepseek-v4-flash / @cf/deepseek-ai/deepseek-v4.1-flash-1017',
    linkUrl: '',
    linkLabel: '',
  },
};

export function AutoSwitchBrainSection({ settings, setSettings, provider, setProvider, setNotice, onOpenBrowserUrl }) {
  const savedSwitch = (settings && settings.autoSwitch) || {};
  const savedCfg = (settings && settings.autoRouter) || {};
  const [source, setSource] = useState(savedSwitch.source || 'openrouter_free');
  const [defaultForNewSessions, setDefaultForNewSessions] = useState(Boolean(savedSwitch.defaultForNewSessions));
  const [apiKeyInput, setApiKeyInput] = useState('');
  const [model, setModel] = useState(savedCfg.model || 'deepseek-v4-flash');
  const [baseURL, setBaseURL] = useState(savedCfg.baseURL || 'https://api.deepseek.com/v1');
  const [snapshot, setSnapshot] = useState(null);
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState(null);

  const applySnapshot = (res) => {
    if (!res || !res.ok) return;
    setSnapshot(res);
    if (res.source) setSource(res.source);
    if (res.defaultForNewSessions !== undefined) setDefaultForNewSessions(Boolean(res.defaultForNewSessions));
    const dsMeta = (res.sources && res.sources.deepseek_api) || {};
    if (dsMeta.model) setModel(dsMeta.model);
    if (dsMeta.baseURL) setBaseURL(dsMeta.baseURL);
    if (setSettings) {
      setSettings((prev) => ({
        ...(prev || {}),
        autoSwitch: {
          source: res.source || 'openrouter_free',
          defaultForNewSessions: Boolean(res.defaultForNewSessions),
        },
        autoRouter: {
          hasKey: Boolean(res.hasKey),
          keyHint: res.keyHint || '',
          model: dsMeta.model || res.model || 'deepseek-v4-flash',
          baseURL: dsMeta.baseURL || res.baseURL || 'https://api.deepseek.com/v1',
        },
      }));
    }
  };

  useEffect(() => {
    let alive = true;
    if (window.autobot && typeof window.autobot.autoRouterGet === 'function') {
      window.autobot.autoRouterGet().then((res) => {
        if (alive && res && res.ok) applySnapshot(res);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const activeSourceInfo = (snapshot && snapshot.sources && snapshot.sources[source]) || {};
  const hasKey = Boolean(
    source === 'openrouter_free'
      ? (activeSourceInfo.hasKey || (snapshot && snapshot.source === 'openrouter_free' && snapshot.hasKey))
      : source === 'deepseek_api'
        ? (activeSourceInfo.hasKey || savedCfg.hasKey)
        : true
  );
  const keyHint = activeSourceInfo.keyHint || (source === 'deepseek_api' ? savedCfg.keyHint : '') || '';
  const srcMeta = DISPATCH_SOURCE_META[source] || DISPATCH_SOURCE_META.openrouter_free;
  const telemetry = (testResult && testResult.telemetry) || (snapshot && snapshot.telemetry) || { decisionsCount: 0, estimatedCostUsd: 0, lastLatencyMs: 0 };

  const handleSave = async (override = {}) => {
    setBusy(true);
    setTestResult(null);
    const nextSource = override.source || source;
    const nextDefault = override.defaultForNewSessions !== undefined ? override.defaultForNewSessions : defaultForNewSessions;
    const nextModel = String(override.model != null ? override.model : model).trim() || 'deepseek-v4-flash';
    const nextBase = String(override.baseURL != null ? override.baseURL : baseURL).trim() || 'https://api.deepseek.com/v1';
    try {
      if (window.autobot && typeof window.autobot.autoRouterSave === 'function') {
        const res = await window.autobot.autoRouterSave({
          source: nextSource,
          defaultForNewSessions: nextDefault,
          apiKey: apiKeyInput.trim() || undefined,
          model: nextModel,
          baseURL: nextBase,
        });
        if (res && res.ok) {
          applySnapshot(res);
          setApiKeyInput('');
          if (setNotice && override.silent !== true) {
            setNotice(`Auto-Switch Brain saved (${DISPATCH_SOURCE_META[nextSource]?.title || nextSource})`);
          }
          return;
        }
        if (res && res.error) setTestResult({ ok: false, error: res.error });
      }
    } finally {
      setBusy(false);
    }
  };

  const handleClear = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      if (window.autobot && typeof window.autobot.autoRouterClear === 'function') {
        const res = await window.autobot.autoRouterClear({ source });
        applySnapshot(res);
      }
      setApiKeyInput('');
      if (setNotice) setNotice(`Cleared ${srcMeta.title} key (offline 0ms heuristic router remains active)`);
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setBusy(true);
    setTestResult(null);
    try {
      if (window.autobot && typeof window.autobot.autoRouterTest === 'function') {
        const res = await window.autobot.autoRouterTest({
          source,
          apiKey: apiKeyInput.trim() || undefined,
          model,
          baseURL,
        });
        setTestResult(res);
        if (res && res.ok && setNotice) {
          setNotice(`DeepSeek V4.1 Flash Ready · via ${srcMeta.title.replace(/^Option [A-C] — /, '')} · ${res.latencyMs}ms`);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const autoEnabled = Boolean(provider && provider.routingMode === 'auto');
  const toggleComposerAuto = (checked) => {
    if (!setProvider) return;
    setProvider((v) => ({ ...(v || {}), routingMode: checked ? 'auto' : 'direct' }));
    if (setNotice) setNotice(checked ? 'Auto-Switch Mode active in composer' : 'Switched back to Direct model mode');
  };

  const openUrl = (url) => {
    if (!url) return;
    if (window.autobot && window.autobot.openExternal) window.autobot.openExternal(url);
  };

  return (
    <div className="settings-card deepseek-brain-card" id="deepseek-auto-switch-brain" data-testid="deepseek-auto-brain-card">
      <div className="deepseek-card-head">
        <h3>🧠 Auto-Switch Brain (DeepSeek V4.1 Flash Dispatcher)</h3>
        <span className={'deepseek-status-pill ' + (hasKey ? 'ready' : 'muted')} data-testid="deepseek-status-badge">
          {hasKey ? `● DeepSeek V4.1 Flash Ready · ${source === 'openrouter_free' ? 'OpenRouter Free' : (source === 'freellmapi' ? 'FreeLLMAPI' : 'DeepSeek API')}${telemetry.lastLatencyMs ? ` · ${telemetry.lastLatencyMs}ms` : ''}` : 'Not Configured'}
        </span>
      </div>

      <div className="deepseek-telemetry-strip" data-testid="deepseek-telemetry-pill">
        <span>Decisions made: <strong>{telemetry.decisionsCount || 0}</strong></span>
        <span>·</span>
        <span>Est. dispatcher cost: <strong>${Number(telemetry.estimatedCostUsd || 0).toFixed(4)}</strong></span>
        <span>·</span>
        <span>Endpoint: <code>{srcMeta.endpoint}</code></span>
      </div>

      <div className="deepseek-source-tabs" role="radiogroup" aria-label="Dispatcher Backend Source">
        {Object.values(DISPATCH_SOURCE_META).map((opt) => (
          <button
            key={opt.id}
            type="button"
            data-testid={`autoswitch-source-${opt.id}`}
            className={'deepseek-source-tab' + (source === opt.id ? ' on' : '')}
            onClick={() => {
              setSource(opt.id);
              setApiKeyInput('');
              setTestResult(null);
              handleSave({ source: opt.id, silent: true });
            }}
          >
            <span className="deepseek-source-title">{opt.title}</span>
            <span className="deepseek-source-badge">{opt.badge}</span>
          </button>
        ))}
      </div>

      <div className="deepseek-how-box">
        <p style={{ margin: '0 0 6px' }}>
          <strong>How the DeepSeek V4.1 Flash Auto-Switch Brain Works:</strong> DeepSeek V4.1 Flash <strong>never</strong> writes your code or answers your prompt. Instead, before each turn, it reads a tiny metadata summary (~150 tokens in, ~25 tokens out in <code>&lt;120 ms</code>) to score your request&apos;s complexity (<code>Tier 1–5</code>) and modality (<code>fast</code>, <code>coder</code>, <code>planner</code>, <code>vision</code>, <code>longctx</code>, <code>image_gen</code>, <code>video_gen</code>), then hands the turn to the exact best model from your connected subscriptions (Claude Max, ChatGPT Plus/Pro, Gemini/Antigravity, Grok, Ollama, or FreeLLMAPI):
        </p>
        <ul className="deepseek-tier-list">
          <li><strong>OpenRouter Free API:</strong> <strong>$0.00 forever</strong> — uses OpenRouter&apos;s free DeepSeek V4.1 Flash endpoint strictly for routing decisions.</li>
          <li><strong>DeepSeek Platform API:</strong> <strong>$1 balance = ~40,000+ auto-switching decisions</strong> — protects your expensive Claude Max &amp; ChatGPT 5-hour message quotas from being wasted on simple turns.</li>
          <li><strong>Tier 1–2 (Greetings, quick questions, commits, docs):</strong> Routes to <strong>Fast / Cheap Pool</strong> (<code>Gemini Flash</code>, <code>GPT-5.4 Mini</code>, <code>Haiku</code>, <code>FreeLLMAPI</code>, or <code>Ollama</code>).</li>
          <li><strong>Tier 3–4 (Multi-file coding, debugging, refactoring, tests):</strong> Routes to <strong>Coder Pool</strong> (<code>Claude Sonnet</code>, <code>GPT-5.6 Terra / Codex</code>, <code>DeepSeek Coder</code>, <code>Qwen3 Coder</code>).</li>
          <li><strong>Tier 5 (Architecture, hard bugs, security audits, swarm planning):</strong> Routes to <strong>Frontier / Planner Pool</strong> (<code>Claude Opus 5.5 / 4.6</code>, <code>GPT-6 Luna / Pro</code>, <code>Gemini Ultra / Carbon</code>).</li>
          <li><strong>Vision / Long-Context / Media:</strong> Automatically switches when screenshots are attached, context exceeds 200K tokens, or image/video generation is requested.</li>
        </ul>
      </div>

      <label>
        <span>
          {srcMeta.title} Key {keyHint ? <span className="muted">(Saved: <code>{keyHint}</code>)</span> : null}
          <span className="muted" style={{ marginLeft: 8 }}>Pinned model: <code>{srcMeta.pinnedModel}</code></span>
        </span>
        <div className="deepseek-key-row">
          <input
            type="password"
            data-testid="deepseek-apikey-input"
            autoComplete="off"
            spellCheck={false}
            placeholder={hasKey && keyHint ? `Saved (${keyHint}) — enter new key to replace` : srcMeta.placeholder}
            value={apiKeyInput}
            onChange={(e) => setApiKeyInput(e.target.value)}
          />
          <button
            type="button"
            className="btn-mini primary"
            data-testid="deepseek-save-key-btn"
            disabled={busy || (!apiKeyInput.trim() && source !== 'freellmapi')}
            onClick={() => handleSave()}
          >
            Save Key
          </button>
          <button
            type="button"
            className="btn-mini"
            data-testid="deepseek-test-btn"
            disabled={busy}
            onClick={handleTest}
          >
            {busy ? 'Testing…' : 'Test Dispatcher'}
          </button>
          <button
            type="button"
            className="btn-mini"
            data-testid="deepseek-clear-key-btn"
            disabled={busy || !hasKey}
            onClick={handleClear}
          >
            Clear
          </button>
        </div>
      </label>

      <div className="deepseek-quick-links">
        {srcMeta.linkUrl && (
          <button type="button" className="btn-mini" onClick={() => openUrl(srcMeta.linkUrl)}>
            {srcMeta.linkLabel}
          </button>
        )}
        {source === 'openrouter_free' && onOpenBrowserUrl && (
          <button
            type="button"
            className="btn-mini"
            data-testid="autoswitch-webbot-openrouter-btn"
            onClick={() => onOpenBrowserUrl('https://openrouter.ai/keys')}
          >
            🤖 Auto-Create with Akron Web Bot
          </button>
        )}
      </div>

      {testResult && (
        <div className={'deepseek-test-banner ' + (testResult.ok ? 'ok' : 'err')} data-testid="deepseek-test-result">
          {testResult.ok
            ? `● DeepSeek V4.1 Flash Ready · via ${srcMeta.title.replace(/^Option [A-C] — /, '')} · ${testResult.latencyMs}ms (${testResult.modelUsed || srcMeta.pinnedModel}${testResult.aliasFallback ? ' · fallback' : ''})`
            : `❌ ${testResult.error || 'Dispatcher test failed'}`}
        </div>
      )}

      {source === 'deepseek_api' && (
        <div className="row" style={{ marginTop: 8 }}>
          <label>
            Dispatcher Model Selector
            <select
              data-testid="deepseek-model-select"
              value={model}
              onChange={(e) => {
                const nextM = e.target.value;
                setModel(nextM);
                handleSave({ model: nextM });
              }}
            >
              <option value="deepseek-v4-flash">DeepSeek V4.1 Flash — Recommended, Ultra-Fast &amp; Cheapest</option>
              <option value="deepseek-chat">DeepSeek V3 / V4 Standard API ID (deepseek-chat · Auto-fallback)</option>
              <option value="deepseek-reasoner">DeepSeek R1 / Reasoner (deepseek-reasoner)</option>
            </select>
          </label>
          <label>
            Dispatcher Endpoint URL
            <input
              type="text"
              data-testid="deepseek-baseurl-input"
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              onBlur={() => handleSave({ baseURL })}
              placeholder="https://api.deepseek.com/v1"
            />
          </label>
        </div>
      )}

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 8 }}>
        <label className="check" style={{ margin: 0 }}>
          <input
            type="checkbox"
            data-testid="deepseek-enable-auto-toggle"
            checked={autoEnabled}
            onChange={(e) => toggleComposerAuto(e.target.checked)}
          />
          Enable Auto-Switch Mode in Composer
        </label>
        <label className="check" style={{ margin: 0 }}>
          <input
            type="checkbox"
            data-testid="deepseek-default-new-sessions-toggle"
            checked={defaultForNewSessions}
            onChange={(e) => {
              const checked = e.target.checked;
              setDefaultForNewSessions(checked);
              handleSave({ defaultForNewSessions: checked, silent: true });
            }}
          />
          Enable Auto-Switch Mode by default for new sessions
        </label>
      </div>
    </div>
  );
}

export function FreeLLMAPISection({ settings, setSettings, orchestrator, saveOrch, setNotice, onOpenBrowserUrl }) {
  const [catData, setCatData] = useState(null);
  const [detectInfo, setDetectInfo] = useState(null);
  const [tab, setTab] = useState('chat'); // 'chat' | 'media' | 'embeddings'
  const [search, setSearch] = useState('');
  const [webBotOpen, setWebBotOpen] = useState(false);
  const [quickKeyPlat, setQuickKeyPlat] = useState('openrouter');
  const [quickKeyVal, setQuickKeyVal] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      if (window.autobot && typeof window.autobot.freellmCatalog === 'function') {
        const c = await window.autobot.freellmCatalog({ limit: 300 });
        if (c && c.ok) setCatData(c);
      }
      if (window.autobot && typeof window.autobot.freellmDetect === 'function') {
        const d = await window.autobot.freellmDetect();
        if (d && d.ok) setDetectInfo(d);
      }
    } catch (_) {}
  };

  useEffect(() => { refresh(); }, []);

  const totals = (catData && catData.totals) || { totalModels: 1575, totalPlatforms: 97, chatModels: 1345, chatPlatforms: 74, mediaModels: 150, mediaModalities: 7, embeddingModels: 80, embeddingPlatforms: 16 };
  const q = search.trim().toLowerCase();
  const platformsList = (catData && catData.platforms) || [];
  const filteredPlatforms = platformsList.filter((p) => {
    if (tab === 'chat' && (!p.counts || p.counts.chat <= 0)) return false;
    if (tab === 'media' && (!p.counts || p.counts.media <= 0)) return false;
    if (tab === 'embeddings' && (!p.counts || p.counts.embedding <= 0)) return false;
    if (!q) return true;
    return p.id.toLowerCase().includes(q) || String(p.name || '').toLowerCase().includes(q) || String(p.freeTier || '').toLowerCase().includes(q);
  });

  const copyUnifiedKey = async () => {
    const endpoint = (detectInfo && detectInfo.recommendedEndpoint) || 'http://127.0.0.1:31415/v1';
    const token = (detectInfo && detectInfo.unifiedKey) || '';
    const snippet = `Endpoint: ${endpoint}${token ? `\nUnified Key: ${token}` : ''}`;
    try { await navigator.clipboard.writeText(snippet); } catch (_) {}
    if (setNotice) setNotice(`Copied Unified Endpoint (${endpoint}) & Key`);
  };

  const handleImport = async () => {
    if (!window.autobot || !window.autobot.freellmImportKeys) return;
    setBusy(true);
    try {
      const r = await window.autobot.freellmImportKeys();
      if (r && r.ok) {
        if (setNotice) setNotice(`Imported keys for ${r.importedCount} platform(s)`);
        await refresh();
      } else if (r && !r.canceled && r.error && setNotice) {
        setNotice(`Import error: ${r.error}`);
      }
    } finally { setBusy(false); }
  };

  const handleExport = async () => {
    if (!window.autobot || !window.autobot.freellmExportKeys) return;
    setBusy(true);
    try {
      const r = await window.autobot.freellmExportKeys();
      if (r && r.ok && setNotice) setNotice(r.savedPath ? `Exported keys to ${r.savedPath}` : 'Exported freellmapi-keys.json');
    } finally { setBusy(false); }
  };

  const wireIntoPools = async () => {
    if (!window.autobot || !window.autobot.poolsPreset || !saveOrch) return;
    setBusy(true);
    try {
      const preset = await window.autobot.poolsPreset();
      if (preset && preset.roles) {
        saveOrch({
          ...(orchestrator || { enabled: true, providers: [] }),
          enabled: true,
          pools: { ...(preset || {}), enabled: true },
        });
        if (setNotice) setNotice('Wired FreeLLMAPI Unified Router into 8 Orchestrator Role Pools');
      }
    } finally { setBusy(false); }
  };

  const saveQuickWebBotKey = async () => {
    if (!quickKeyVal.trim() || !window.autobot || !window.autobot.freellmSaveSingleKey) return;
    setBusy(true);
    try {
      const r = await window.autobot.freellmSaveSingleKey({ platform: quickKeyPlat, apiKey: quickKeyVal.trim() });
      if (r && r.ok) {
        if (quickKeyPlat === 'openrouter' && window.autobot.autoRouterSave) {
          await window.autobot.autoRouterSave({ source: 'openrouter_free', apiKey: quickKeyVal.trim() });
        }
        setQuickKeyVal('');
        if (setNotice) setNotice(`Saved ${quickKeyPlat} key & updated FreeLLMAPI Unified Router`);
        await refresh();
      }
    } finally { setBusy(false); }
  };

  const webBotProviders = (catData && catData.webBotProviders) || [
    { id: 'openrouter', name: 'OpenRouter', signupUrl: 'https://openrouter.ai/keys' },
    { id: 'google', name: 'Google AI Studio', signupUrl: 'https://aistudio.google.com/apikey' },
    { id: 'groq', name: 'Groq', signupUrl: 'https://console.groq.com/keys' },
    { id: 'mistral', name: 'Mistral AI', signupUrl: 'https://console.mistral.ai/api-keys' },
    { id: 'cohere', name: 'Cohere', signupUrl: 'https://dashboard.cohere.com/api-keys' },
    { id: 'cloudflare', name: 'Cloudflare Workers AI', signupUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
    { id: 'nvidia', name: 'NVIDIA NIM', signupUrl: 'https://build.nvidia.com/settings/api-keys' },
    { id: 'huggingface', name: 'HuggingFace Router', signupUrl: 'https://huggingface.co/settings/tokens' },
    { id: 'puter', name: 'Puter AI', signupUrl: 'https://puter.com/' },
    { id: 'electronhub', name: 'ElectronHub', signupUrl: 'https://www.electronhub.ai/' },
  ];

  return (
    <div className="settings-card freellm-hub-card" data-testid="freellmapi-catalog-hub">
      <div className="deepseek-card-head">
        <h3>🔓 FreeLLMAPI · Full Unlocked Cross-Platform Catalog</h3>
        <span className="deepseek-status-pill ready">{totals.totalModels.toLocaleString()} Models · {totals.totalPlatforms} Platforms</span>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        Embedded across macOS, Windows &amp; Linux: <strong>{totals.chatModels.toLocaleString()}</strong> chat models ({totals.chatPlatforms} platforms), <strong>{totals.mediaModels}</strong> multimodal media/search/decision models (7 modalities), and <strong>{totals.embeddingModels}</strong> embeddings ({totals.embeddingPlatforms} platforms). Built-in router runs on <code>http://127.0.0.1:3001/v1</code> and compatibility port <code>:31415/v1</code>.
      </p>

      <div className="freellm-detect-bar">
        <span>OS: <strong>{(detectInfo && detectInfo.platform) || 'desktop'}</strong></span>
        <span>·</span>
        <span>Desktop App: <strong>{detectInfo && detectInfo.desktopInstalled ? 'Detected' : 'Using Built-In Engine'}</strong></span>
        <span>·</span>
        <span>Router: <code>{(detectInfo && detectInfo.status && detectInfo.status.url) || 'http://127.0.0.1:3001/v1'}</code></span>
      </div>

      <div className="freellm-btn-row">
        <button type="button" className="btn-mini primary" disabled={busy} onClick={handleImport} data-testid="freellm-import-btn">
          Import freellmapi-keys.json
        </button>
        <button type="button" className="btn-mini" disabled={busy} onClick={handleExport} data-testid="freellm-export-btn">
          Export freellmapi-keys.json
        </button>
        <button type="button" className="btn-mini" onClick={copyUnifiedKey} data-testid="freellm-copy-unified-btn">
          Copy Unified Key (http://127.0.0.1:31415/v1)
        </button>
        <button
          type="button"
          className="btn-mini"
          onClick={() => window.autobot && window.autobot.freellmLaunchDesktop && window.autobot.freellmLaunchDesktop()}
        >
          Launch / Install FreeLLMAPI App
        </button>
        <button type="button" className="btn-mini" disabled={busy} onClick={wireIntoPools}>
          Wire into Role Pools &amp; Auto-Switch
        </button>
        <button
          type="button"
          className="btn-mini primary"
          data-testid="freellm-webbot-setup-btn"
          onClick={() => setWebBotOpen((v) => !v)}
        >
          🤖 Auto-Setup Free Keys with Akron Web Bot
        </button>
      </div>

      {webBotOpen && (
        <div className="freellm-webbot-drawer" data-testid="freellm-webbot-drawer">
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 6 }}>
            Akron Browser Bot · Guided No-Card API Key Setup
          </div>
          <div className="freellm-webbot-grid">
            {webBotProviders.map((wp) => (
              <button
                key={wp.id}
                type="button"
                className={'freellm-webbot-chip' + (quickKeyPlat === wp.id ? ' on' : '')}
                onClick={() => {
                  setQuickKeyPlat(wp.id);
                  if (wp.signupUrl && onOpenBrowserUrl) onOpenBrowserUrl(wp.signupUrl);
                }}
              >
                <span>{wp.name || wp.id}</span>
                <span className="muted">Open in Akron Browser Bot →</span>
              </button>
            ))}
          </div>
          <div className="deepseek-key-row" style={{ marginTop: 8 }}>
            <select value={quickKeyPlat} onChange={(e) => setQuickKeyPlat(e.target.value)} style={{ maxWidth: 180 }}>
              {webBotProviders.map((wp) => <option key={wp.id} value={wp.id}>{wp.name || wp.id}</option>)}
            </select>
            <input
              type="password"
              value={quickKeyVal}
              onChange={(e) => setQuickKeyVal(e.target.value)}
              placeholder={`Paste ${quickKeyPlat} API key captured from Browser Bot…`}
            />
            <button type="button" className="btn-mini primary" disabled={busy || !quickKeyVal.trim()} onClick={saveQuickWebBotKey}>
              Save &amp; Wire Key
            </button>
          </div>
        </div>
      )}

      <div className="freellm-cat-controls">
        <div className="freellm-cat-tabs">
          <button type="button" className={tab === 'chat' ? 'on' : ''} onClick={() => setTab('chat')}>Chat ({totals.chatModels})</button>
          <button type="button" className={tab === 'media' ? 'on' : ''} onClick={() => setTab('media')}>Media &amp; Search ({totals.mediaModels})</button>
          <button type="button" className={tab === 'embeddings' ? 'on' : ''} onClick={() => setTab('embeddings')}>Embeddings ({totals.embeddingModels})</button>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter 97 platforms (openrouter, huggingface, cloudflare, groq…)"
        />
      </div>

      <div className="freellm-platform-grid">
        {filteredPlatforms.slice(0, 36).map((p) => {
          const cnt = tab === 'chat' ? (p.counts && p.counts.chat) : (tab === 'media' ? (p.counts && p.counts.media) : (p.counts && p.counts.embedding));
          return (
            <div key={p.id} className="freellm-plat-item">
              <div className="freellm-plat-head">
                <strong>{p.name || p.id}</strong>
                <span className="freellm-plat-cnt">{cnt}</span>
              </div>
              <div className="freellm-plat-sub">{p.freeTier || p.baseUrl}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ApplicationSettingsSection({ settings, setSettings, features, saveFeat, setNotice }) {
  const [sleepBusy, setSleepBusy] = useState(false);

  const togglePreventSleep = async (checked) => {
    setSettings({ ...settings, preventSleep: checked });
    setSleepBusy(true);
    try {
      if (window.autobot && window.autobot.setPreventSleep) {
        await window.autobot.setPreventSleep(checked);
      }
      if (setNotice) setNotice(checked ? 'System sleep prevention active while Akron runs' : 'System sleep prevention disabled');
    } finally {
      setSleepBusy(false);
    }
  };

  return (
    <div className="settings-card" data-testid="application-settings-section">
      <h3><Icon name="Palette" size={14} /> Surface Finish, Power &amp; Update Channel</h3>
      <div className="row">
        <label>
          Surface Finish
          <select
            value={settings.surfaceFinish || 'emerald-carbon'}
            onChange={(e) => setSettings({ ...settings, surfaceFinish: e.target.value })}
          >
            <option value="emerald-carbon">Glossy Emerald Carbon (Default)</option>
            <option value="matte-obsidian">Matte Obsidian</option>
            <option value="midnight-glass">Midnight Glass</option>
            <option value="minimal-slate">Minimal Slate</option>
          </select>
        </label>
        <label>
          Update Release Channel
          <select
            value={settings.updateChannel || 'stable'}
            onChange={(e) => setSettings({ ...settings, updateChannel: e.target.value })}
          >
            <option value="stable">Stable Releases (Recommended)</option>
            <option value="prerelease">Pre-release / Insiders</option>
          </select>
        </label>
      </div>
      <label className="check">
        <input
          type="checkbox"
          disabled={sleepBusy}
          checked={!!settings.preventSleep}
          onChange={(e) => togglePreventSleep(e.target.checked)}
        />
        Prevent Mac/PC sleep while autonomous agents are running
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={!!settings.keepInTray}
          onChange={(e) => setSettings({ ...settings, keepInTray: e.target.checked })}
        />
        Keep Akron Code running in system tray / menu bar when window closes
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={settings.autoUpdateScheduler !== false}
          onChange={(e) => setSettings({ ...settings, autoUpdateScheduler: e.target.checked })}
        />
        Automatically check GitHub Releases every 4 hours
      </label>
      {features && saveFeat && (
        <label className="check">
          <input
            type="checkbox"
            checked={!!features.remoteServerEnabled}
            onChange={(e) => saveFeat({ ...features, remoteServerEnabled: e.target.checked })}
          />
          Enable Remote Server API &amp; mobile companion pairing on loopback/LAN
        </label>
      )}
    </div>
  );
}

export function BrowserSettingsSection({ settings, setSettings, setNotice }) {
  const [testUrl, setTestUrl] = useState('https://github.com/akronlogic/akron-code');
  const [testVerdict, setTestVerdict] = useState(null);

  const runRuleTest = async () => {
    const allowList = settings.browserAllowUrls || '';
    const denyList = settings.browserDenyUrls || '';
    if (window.autobot && window.autobot.browserRulesCheck) {
      const r = await window.autobot.browserRulesCheck({ url: testUrl, allowList, denyList });
      setTestVerdict(r);
      return;
    }
    setTestVerdict({ allowed: !denyList.includes(testUrl), reason: 'Checked locally' });
  };

  return (
    <div className="settings-card" data-testid="browser-settings-section">
      <h3><Icon name="LockShield" size={14} /> Built-In Browser · Links, Downloads &amp; Actuation Rules</h3>
      <div className="row">
        <label>
          Default Link Handling
          <select
            value={settings.browserLinkMode || 'internal'}
            onChange={(e) => setSettings({ ...settings, browserLinkMode: e.target.value })}
          >
            <option value="internal">Open in Built-in Browser Pane</option>
            <option value="external">Open in System Browser</option>
          </select>
        </label>
        <label>
          Downloads Folder
          <input
            value={settings.browserDownloadsDir || '~/Downloads'}
            onChange={(e) => setSettings({ ...settings, browserDownloadsDir: e.target.value })}
            placeholder="~/Downloads"
          />
        </label>
      </div>
      <div className="row">
        <label>
          Allow URL Patterns (one per line or comma)
          <textarea
            rows={3}
            placeholder="github.com&#10;*.localhost&#10;docs.python.org"
            value={settings.browserAllowUrls || ''}
            onChange={(e) => setSettings({ ...settings, browserAllowUrls: e.target.value })}
            style={{ width: '100%', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 12, padding: 6, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
          />
        </label>
        <label>
          Deny URL Patterns (overrides Allow)
          <textarea
            rows={3}
            placeholder="*.bank.example&#10;admin.prod.internal/*"
            value={settings.browserDenyUrls || ''}
            onChange={(e) => setSettings({ ...settings, browserDenyUrls: e.target.value })}
            style={{ width: '100%', marginTop: 4, fontFamily: 'var(--mono)', fontSize: 12, padding: 6, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
          />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <input
          value={testUrl}
          onChange={(e) => setTestUrl(e.target.value)}
          placeholder="https://example.com/path"
          style={{ flex: 1 }}
        />
        <button type="button" className="btn-mini" onClick={runRuleTest}>Test URL Rule</button>
        <button
          type="button"
          className="btn-mini"
          onClick={() => {
            setSettings({ ...settings, browserLastClearedAt: Date.now() });
            if (setNotice) setNotice('Browser session cache & SoM markers cleared');
          }}
        >
          Clear Browser Data
        </button>
      </div>
      {testVerdict && (
        <p className="muted" style={{ marginTop: 6, color: testVerdict.allowed ? '#34d399' : '#f87171' }}>
          {testVerdict.allowed ? 'ALLOWED' : 'BLOCKED'} — {testVerdict.reason || testVerdict.matchedBy}
        </p>
      )}
    </div>
  );
}

function SvgLimitRing({ label, sub, pct }) {
  const clamped = Math.max(0, Math.min(100, Number(pct) || 0));
  const r = 24;
  const circ = 2 * Math.PI * r;
  const dash = circ - (clamped / 100) * circ;
  return (
    <div className="limit-ring-card">
      <svg width="64" height="64" viewBox="0 0 64 64" aria-label={label}>
        <circle cx="32" cy="32" r={r} fill="none" stroke="rgba(255,255,255,0.1)" strokeWidth="5" />
        <circle
          cx="32"
          cy="32"
          r={r}
          fill="none"
          stroke={clamped > 85 ? '#fbbf24' : '#10b981'}
          strokeWidth="5"
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={dash}
          transform="rotate(-90 32 32)"
        />
        <text x="32" y="36" textAnchor="middle" fontSize="12" fontWeight="700" fill="currentColor">
          {clamped}%
        </text>
      </svg>
      <div className="limit-ring-label">{label}</div>
      <div className="limit-ring-sub">{sub}</div>
    </div>
  );
}

export function ModelsAndLimitsSection({ settings, setSettings, convs = [] }) {
  const msgCount = (Array.isArray(convs) ? convs : []).reduce((s, c) => s + ((c.messages && c.messages.length) || 0), 0);
  const fiveHourPct = Math.min(95, Math.round(msgCount * 1.4));
  const weeklyPct = Math.min(95, Math.round(msgCount * 0.65));
  const monthlyPct = Math.min(95, Math.round(msgCount * 0.25));

  return (
    <div className="settings-card" data-testid="models-limits-section">
      <h3><Icon name="Sparkles" size={14} /> Orchestrator vs. Executor Models &amp; Usage Limit Rings</h3>
      <div className="row">
        <label>
          Orchestrator Model (Planning &amp; Verification)
          <input
            value={settings.orchestratorModel || 'claude-opus-4-6'}
            onChange={(e) => setSettings({ ...settings, orchestratorModel: e.target.value })}
            placeholder="claude-opus-4-6"
          />
        </label>
        <label>
          Executor Model (Fast Tool Edits &amp; Sub-Agents)
          <input
            value={settings.executorModel || 'claude-sonnet-4-6'}
            onChange={(e) => setSettings({ ...settings, executorModel: e.target.value })}
            placeholder="claude-sonnet-4-6"
          />
        </label>
      </div>
      <div className="limit-rings-grid">
        <SvgLimitRing label="5-Hour Window" sub="Rolling rate budget" pct={fiveHourPct} />
        <SvgLimitRing label="Weekly Limit" sub="Subscription / pool" pct={weeklyPct} />
        <SvgLimitRing label="Monthly Budget" sub="Zero-waste routed" pct={monthlyPct} />
      </div>
    </div>
  );
}

export function GiveFeedbackSection({ settings, provider, setNotice }) {
  const [category, setCategory] = useState('bug');
  const [summary, setSummary] = useState('');
  const [bundleJson, setBundleJson] = useState('');
  const [busy, setBusy] = useState(false);

  const generateBundle = async () => {
    setBusy(true);
    try {
      let data = null;
      if (window.autobot && window.autobot.generateDiagnostics) {
        data = await window.autobot.generateDiagnostics({
          category,
          summary,
          theme: settings.theme,
          surface: settings.surfaceFinish || 'emerald-carbon',
          settings,
          providerSummary: { model: provider && provider.model, baseURL: provider && provider.baseURL },
        });
      } else {
        data = { category, summary, scrubbed: true, generatedAt: new Date().toISOString() };
      }
      setBundleJson(JSON.stringify(data, null, 2));
      if (setNotice) setNotice('Generated scrubbed diagnostic bundle (secrets & PII stripped)');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card" data-testid="give-feedback-section">
      <h3><Icon name="Bug" size={14} /> Give Feedback &amp; Scrubbed Diagnostic Bundle</h3>
      <p className="muted" style={{ marginTop: 0 }}>
        Generates a privacy-safe diagnostic snapshot with API keys, OAuth tokens, emails, and user home directories automatically redacted.
      </p>
      <div className="row">
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="bug">Bug Report</option>
            <option value="feature">Feature Request</option>
            <option value="perf">Performance / IDE</option>
            <option value="browser">Browser Bot Issue</option>
          </select>
        </label>
      </div>
      <label>
        What happened?
        <textarea
          rows={3}
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="Describe steps to reproduce or share product feedback…"
          style={{ width: '100%', marginTop: 4, fontSize: 12.5, padding: 8, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
        />
      </label>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn-mini primary" disabled={busy} onClick={generateBundle} data-testid="generate-diag-btn">
          <Icon name="ShieldSearch" size={12} /> {busy ? 'Generating…' : 'Generate Scrubbed Diagnostics'}
        </button>
        {bundleJson && (
          <button
            type="button"
            className="btn-mini"
            onClick={() => {
              try { navigator.clipboard.writeText(bundleJson); } catch (_) {}
              if (setNotice) setNotice('Diagnostic JSON copied to clipboard');
            }}
          >
            <Icon name="Copy" size={12} /> Copy JSON
          </button>
        )}
      </div>
      {bundleJson && (
        <pre className="tool-result" style={{ marginTop: 10, maxHeight: 240, overflow: 'auto' }} data-testid="diag-bundle-preview">
          {bundleJson}
        </pre>
      )}
    </div>
  );
}
