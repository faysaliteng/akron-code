import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';
import { LOCALES } from '../../i18n.js';
import { normBase, LOCAL_BASE } from '../../providerstatus-ui.mjs';
import { shortcutLabels } from '../../ide/shortcuts.js';
import { useVoiceDictation } from '../../voice';
import { PRESETS, PRESET_KEYS, useDismiss, SOUND_PRESETS, playUiSound, sendDesktopNotification, HARNESS_PROFILES } from '../../utils/appHelpers.jsx';
import { ProjectSettingsPanel } from './ProjectSettingsPanel.jsx';
import { MigrationWizard } from './MigrationWizard.jsx';
import { ApplicationSettingsSection, AppearanceStudioSection, BrowserSettingsSection, ModelsAndLimitsSection, GiveFeedbackSection, MediaStudioApiKeysSection, AutoSwitchBrainSection, FreeLLMAPISection } from './ExtendedSettingsPanels.jsx';
import { syncProviderForOrchestratorToggle } from '../../utils/settingsPersistence.js';
import { OrchPaidProvidersPanel } from './OrchPaidProvidersPanel.jsx';
import { ParadevIntegrationCard } from './ParadevIntegrationCard.jsx';
import { MemoryView, ProjectsView, McpView, NotebooksView } from '../../features/WorkspacePanels.jsx';
import { SkillsViewBody, PluginsViewBody } from '../chat/WorkspaceViews.jsx';
import {
  AccountSection, ComplianceSection, RuntimesSection, DependenciesAndUpdaterSection,
  OrchModelChecklist, RolePoolsEditor, EnvironmentsSection, PermissionRulesSection,
  QuietHoursSection, MobilePushSection, OutboundRelaySection, TypographySettingsSection,
} from './SettingsSections.jsx';

export function SettingsModalBody({
  provider, setProvider, providerKeys, setProviderKeys, settings, setSettings, orchestrator, setOrchestrator,
  features, setFeatures, testProvider, onClose, T, permissions, setPermissions, compliance, setCompliance,
  pendingPreset, clearPendingPreset, initialSection = 'providers', focusMediaKey = '', SETTINGS_SECTIONS = [], AboutSectionComponent = null, renderAboutSection = null,
  skills = [], toggleSkill, setAllSkills, refreshSkills,
  mcpServers = [], mcpForm, setMcpForm, connectMcp, disconnectMcp,
  memory = [], addMemory, clearMemory, convs = [], onJumpToMessage,
  notebooks = [], activeNotebook, notebookCells = [], setNotebookCells, openNotebook, newNotebook, saveActiveNotebook, deleteActiveNotebook,
  cwd, setCwd, activeId, projects = [], setProjects, activeProject = null, setActiveProject,
  onOpenGdrive, gdriveState,
  envState, refreshEnvState, onSwitchEnvironment, setError, setNotice, onOpenBrowserUrl,
}) {
  const [section, setSection] = useState(initialSection || 'providers');
  const [navFilter, setNavFilter] = useState('');
  const [orchPaidProviders, setOrchPaidProviders] = useState([]);
  const [appVer, setAppVer] = useState('1.5.9');
  useEffect(() => {
    if (window.autobot && typeof window.autobot.getVersion === 'function') {
      window.autobot.getVersion().then((v) => {
        if (v && (v.app || v.version)) setAppVer(String(v.app || v.version));
      }).catch(() => {});
    }
  }, []);
  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  // Editing an endpoint/model by hand means this is no longer a signed-in
  // subscription selection — drop the OAuth binding so the gateway path wins.
  const set = (k) => (e) => setProvider({ ...provider, [k]: e.target.value, ...(k === 'baseURL' || k === 'apiKey' ? { oauthProvider: '', transport: '', accessToken: '', oauth: false } : {}) });
  // Persist every key against its own endpoint so switching models never reuses
  // (or loses) another provider's credential.
  const keyForEntry = (baseURL) => (providerKeys || {})[normBase(baseURL)] || PRESET_KEYS[normBase(baseURL)] || '';
  const setKeyForEntry = (baseURL, value) => {
    const base = normBase(baseURL);
    if (!base) return;
    setProviderKeys((m) => ({ ...(m || {}), [base]: value }));
  };

  const saveOrch = (next) => { setOrchestrator(next); window.autobot.setOrchestrator(next); };
  const saveFeat = (next) => { setFeatures(next); window.autobot.setFeatures(next); };

  // Staged preset from the model picker (no key yet). Nothing is committed to
  // the session provider until "Save key & use" — Cancel leaves it untouched.
  const [stage, setStage] = useState(() => (pendingPreset ? { baseURL: pendingPreset.baseURL || '', model: pendingPreset.model || '', apiKey: keyForEntry(pendingPreset.baseURL) } : null));
  useEffect(() => {
    setStage(pendingPreset ? { baseURL: pendingPreset.baseURL || '', model: pendingPreset.model || '', apiKey: keyForEntry(pendingPreset.baseURL) } : null);
    if (pendingPreset) setSection('providers');
  }, [pendingPreset]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageNeedsKey = !!(stage && !LOCAL_BASE.test(normBase(stage.baseURL)));
  const stageReady = !!(stage && normBase(stage.baseURL) && stage.model && (!stageNeedsKey || String(stage.apiKey || '').trim()));
  const commitStage = () => {
    if (!stageReady) return;
    const p = pendingPreset || {};
    const key = String(stage.apiKey || '').trim();
    setKeyForEntry(stage.baseURL, key);
    setProvider((v) => ({ ...v, baseURL: stage.baseURL, model: stage.model, apiKey: key, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto', oauthProvider: '', transport: '', accessToken: '', oauth: false }));
    if (clearPendingPreset) clearPendingPreset();
  };

  // Local Ollama
  const [ollama, setOllama] = useState({ ok: false, base: '', models: [], detail: '' });
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const applyOllamaModel = (name) => {
    const base = ollama.base || 'http://localhost:11434/v1';
    setProvider((v) => ({ ...v, baseURL: base, model: name, apiKey: '', supportsTools: true, oauthProvider: '', transport: '', accessToken: '', oauth: false }));
    setKeyForEntry(base, '');
  };
  const connectOllama = async (start) => {
    setOllamaBusy(true);
    try {
      const r = start
        ? await Promise.resolve(window.autobot.ollamaServe('start')).catch(() => null)
        : await Promise.resolve(window.autobot.ollamaModels(ollama.base || 'http://localhost:11434/v1')).catch(() => null);
      if (r) setOllama({ ok: !!r.ok, base: r.base || '', models: r.models || [], detail: r.detail || '' });
      const first = r && r.ok && r.models && r.models[0];
      if (first) {
        const base = r.base || 'http://localhost:11434/v1';
        setProvider((v) => ({ ...v, baseURL: base, model: first.name, apiKey: '', supportsTools: true }));
        setKeyForEntry(base, '');
      }
      return r;
    } finally {
      setOllamaBusy(false);
    }
  };
  useEffect(() => {
    window.autobot.ollamaModels('http://localhost:11434/v1')
      .then((r) => r && setOllama({ ok: !!r.ok, base: r.base || '', models: r.models || [], detail: r.detail || '' }))
      .catch(() => {});
  }, []);

  // Custom runtime tools (Creator Mode)
  const [customTools, setCustomTools] = useState([]);
  const [ctDraft, setCtDraft] = useState({ name: '', description: '', runtime: 'node', script: 'const args = JSON.parse(process.env.TOOL_ARGS_JSON || "{}");\nconsole.log("ok", args);' });
  const [ctMsg, setCtMsg] = useState('');
  const refreshCustomTools = useCallback(async () => {
    if (!window.autobot || !window.autobot.customToolList) return;
    try {
      const list = await window.autobot.customToolList();
      setCustomTools(Array.isArray(list) ? list : []);
    } catch (_) {}
  }, []);
  useEffect(() => { refreshCustomTools(); }, [refreshCustomTools]);

  // Built-in REA (morluto/rea) status & diagnostics
  const [reaInfo, setReaInfo] = useState(null);
  const [reaDiagOut, setReaDiagOut] = useState('');
  const [reaBusy, setReaBusy] = useState(false);
  const refreshReaStatus = useCallback(async () => {
    if (!window.autobot || !window.autobot.reaStatus) return;
    try {
      const res = await window.autobot.reaStatus();
      if (res) setReaInfo(res);
    } catch (_) {}
  }, []);
  useEffect(() => {
    refreshReaStatus();
  }, [refreshReaStatus]);

  // Browser extension bridge status
  const [extStatus, setExtStatus] = useState(null);
  const [extBusy, setExtBusy] = useState('');
  const [extActionMsg, setExtActionMsg] = useState('');
  const refreshExtStatus = useCallback(async () => {
    if (!window.autobot || !window.autobot.extBridgeStatus) return;
    try {
      const res = await window.autobot.extBridgeStatus();
      if (res) setExtStatus(res);
    } catch (_) {}
  }, []);
  const handleInstallExtBrowser = useCallback(async (browserId = '') => {
    if (!window.autobot || !window.autobot.extBridgeInstallBrowser) return;
    setExtBusy('install');
    setExtActionMsg('');
    try {
      const res = await window.autobot.extBridgeInstallBrowser(browserId ? { browserId } : {});
      if (res && res.ok) {
        const targets = (res.registeredTargets || []).map((t) => t.name).join(', ');
        setExtActionMsg(
          targets
            ? `✅ Added Akron Browser Bot (${res.extensionId}) to: ${targets}. Folder synced at ${res.extensionDir}`
            : `✅ Synced standalone CRX3 & unpacked folder at ${res.extensionDir} (${res.extensionId}). Click "Launch Browser with Extension Pre-Loaded" or load unpacked in chrome://extensions.`
        );
        if (setNotice) setNotice('✅ Akron Browser Bot synced & ready');
      } else {
        setExtActionMsg('⚠️ ' + ((res && res.error) || 'Could not register extension'));
      }
      await refreshExtStatus();
    } finally {
      setExtBusy('');
    }
  }, [refreshExtStatus, setNotice]);
  const handleLaunchExtBrowser = useCallback(async (browserId = '') => {
    if (!window.autobot || !window.autobot.extBridgeLaunchBrowser) return;
    setExtBusy('launch');
    setExtActionMsg('');
    try {
      const res = await window.autobot.extBridgeLaunchBrowser(browserId ? { browserId } : {});
      if (res && res.ok && res.launched) {
        setExtActionMsg(`🚀 Launched ${res.browser?.name || 'browser'} with Akron Browser Bot pre-loaded.`);
      } else {
        setExtActionMsg((res && res.message) || 'Opened standalone extension folder.');
      }
      await refreshExtStatus();
    } finally {
      setExtBusy('');
    }
  }, [refreshExtStatus]);
  useEffect(() => {
    refreshExtStatus();
    if (section !== 'browser') return undefined;
    const id = setInterval(refreshExtStatus, 3000);
    return () => clearInterval(id);
  }, [section, refreshExtStatus]);

  // Voice tester inside Voice settings tab
  const [voiceTestOut, setVoiceTestOut] = useState('');
  const [voiceTestErr, setVoiceTestErr] = useState('');
  const testVoice = useVoiceDictation({
    engine: settings.voiceEngine || 'auto',
    lang: settings.voiceLang || 'en-US',
    onTranscript: (t) => setVoiceTestOut(t),
    onError: (e) => setVoiceTestErr(e),
  });

  // Worktrees & local Server info
  const [wtInfo, setWtInfo] = useState({ isRepo: false, root: null, worktrees: [] });
  const [wtBranch, setWtBranch] = useState('');
  const [wtBusy, setWtBusy] = useState(false);
  const [wtMsg, setWtMsg] = useState('');
  const refreshWorktrees = useCallback(async () => {
    if (!window.autobot || !window.autobot.worktreeList) return;
    try {
      const r = await window.autobot.worktreeList(cwd || undefined);
      if (r) setWtInfo(r);
    } catch (_) {}
  }, [cwd]);
  useEffect(() => {
    if (section === 'worktrees') refreshWorktrees();
  }, [section, refreshWorktrees]);

  const [serverMeta, setServerMeta] = useState(null);
  const refreshServerMeta = useCallback(async () => {
    if (!window.autobot || !window.autobot.serverInfo) return;
    try {
      const r = await window.autobot.serverInfo();
      if (r) setServerMeta(r);
    } catch (_) {}
  }, []);
  useEffect(() => {
    if (section === 'server') refreshServerMeta();
  }, [section, refreshServerMeta]);

  const notifCfg = { agent: true, permissions: true, questions: true, errors: false, notifyWhenFocused: false, sound: false, ...(settings.notifications || {}) };
  const soundCfg = { agent: 'staplebops-01', permissions: 'staplebops-02', questions: 'staplebops-05', errors: 'none', ...(settings.sounds || {}) };
  const toggleNotif = (k) => setSettings({ ...settings, notifications: { ...notifCfg, [k]: !notifCfg[k] } });
  const setSoundPreset = (k, val) => {
    setSettings({ ...settings, sounds: { ...soundCfg, [k]: val } });
    if (val && val !== 'none') playUiSound(val);
  };

  const q = navFilter.trim().toLowerCase();
  const visibleSections = q
    ? SETTINGS_SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || s.keys.includes(q) || s.sub.toLowerCase().includes(q))
    : SETTINGS_SECTIONS;
  const activeMeta = SETTINGS_SECTIONS.find((s) => s.id === section) || SETTINGS_SECTIONS[0];

  const badgeFor = (id) => {
    if (id === 'providers') return provider.model ? '' : 'Setup';
    if (id === 'notifications') return notifCfg.agent ? 'On' : 'Off';
    if (id === 'orchestrator') return (orchestrator.pools && orchestrator.pools.enabled) ? 'Pools' : (orchestrator.enabled ? 'On' : '');
    if (id === 'media') return 'Studio';
    if (id === 'environments') return envState && envState.active && envState.active.kind !== 'local' ? envState.active.kind.toUpperCase() : 'Local';
    if (id === 'worktrees') return wtInfo.worktrees && wtInfo.worktrees.length ? `${wtInfo.worktrees.length}` : '';
    if (id === 'skills') { const n = skills.filter((s) => s.enabled !== false).length; return n > 0 ? `${n}` : ''; }
    if (id === 'mcp') return mcpServers.length > 0 ? `${mcpServers.length}` : '';
    if (id === 'memory') return memory.length > 0 ? `${memory.length}` : '';
    if (id === 'harness') return customTools.length ? `${customTools.length}` : '';
    if (id === 'rea') return reaInfo && reaInfo.connected ? `${reaInfo.toolCount}` : (reaInfo && reaInfo.available ? 'Ready' : '');
    if (id === 'browser') return extStatus && extStatus.extensionConnected ? 'Live' : '8766';
    if (id === 'server') return '8766';
    if (id === 'voice') return settings.voiceEngine === 'local' ? 'Whisper' : 'Auto';
    if (id === 'security') return permissions;
    if (id === 'system') return settings.theme || 'dark';
    if (id === 'about') return `v${appVer}`;
    return '';
  };

  return (
    <div className="modal-overlay settings-fullscreen" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-sidebar" aria-label="Settings categories">
          <button type="button" className="settings-back-btn" onClick={onClose}>
            <Icon name="ArrowLeft" size={14} />
            <span>Back to app</span>
          </button>
          <div className="settings-filter">
            <Icon name="Search" size={13} />
            <input
              value={navFilter}
              onChange={(e) => setNavFilter(e.target.value)}
              placeholder="Search settings…"
            />
          </div>
          <nav className="settings-nav">
            {visibleSections.map((s, idx) => {
              const badge = badgeFor(s.id);
              const showSep = !q && idx > 0 && visibleSections[idx - 1].group !== s.group;
              return (
                <React.Fragment key={s.id}>
                  {showSep && <div className="settings-nav-sep" role="separator" />}
                  <button
                    type="button"
                    className={'settings-nav-btn' + (section === s.id ? ' on' : '')}
                    onClick={() => setSection(s.id)}
                  >
                    <Icon name={s.icon} size={15} />
                    <span>{s.label}</span>
                    {badge && <span className="settings-nav-pill">{badge}</span>}
                  </button>
                </React.Fragment>
              );
            })}
          </nav>
          <button
            type="button"
            className="settings-side-foot"
            onClick={() => setSection('about')}
            title="Open About & License"
          >
            <span>Akron Code v{appVer}</span>
            <span>{settings.theme === 'light' ? 'Light' : 'Dark'}</span>
          </button>
        </aside>

        <section className="settings-main">
          <header className="settings-head">
            <div className="settings-head-inner">
              <div>
                <h2>{activeMeta.label}</h2>
                <p className="settings-head-sub">{activeMeta.sub}</p>
              </div>
              <button type="button" className="icon-btn" onClick={onClose} title="Close settings">
                <Icon name="X" size={16} />
              </button>
            </div>
          </header>

          <div className="settings-body">
            <div className="settings-body-inner">
            {section === 'providers' && (
              <>
                {stage && (
                  <div className="stage-key">
                    <div className="stage-key-head">
                      <Icon name="Lock" size={13} /> Set up <b>{(pendingPreset && pendingPreset.name) || 'provider'}</b>
                      <span className="muted"> — your current model stays active until you save.</span>
                    </div>
                    <div className="row">
                      <label>Base URL<input value={stage.baseURL} onChange={(e) => setStage({ ...stage, baseURL: e.target.value })} placeholder="https://api.example.com/v1" /></label>
                      <label>Model<input value={stage.model} onChange={(e) => setStage({ ...stage, model: e.target.value })} placeholder="model-id" /></label>
                    </div>
                    <label>API key{stageNeedsKey ? '' : ' (optional for a local endpoint)'}
                      <input type="password" autoFocus value={stage.apiKey} onChange={(e) => setStage({ ...stage, apiKey: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') commitStage(); }} placeholder="sk-…" />
                    </label>
                    <div className="stage-key-actions">
                      <button type="button" className="btn-mini" onClick={() => { if (clearPendingPreset) clearPendingPreset(); }}>Cancel</button>
                      <button type="button" className="btn-mini primary" disabled={!stageReady} onClick={commitStage}>Save key &amp; use</button>
                    </div>
                  </div>
                )}

                <div className="settings-card">
                  <h3>{T('settings.provider')}</h3>
                  <div className="presets">
                    {PRESETS.map((p) => (
                      <button key={p.name} className={provider.baseURL === p.baseURL && provider.model === p.model ? 'on' : ''} onClick={() => { const k = p.apiKey || keyForEntry(p.baseURL); setProvider((v) => ({ ...v, baseURL: p.baseURL, model: p.model, apiKey: k, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto', oauthProvider: '', transport: '', accessToken: '', oauth: false })); if (k) setKeyForEntry(p.baseURL, k); }}>{p.name}</button>
                    ))}
                  </div>
                  <div className="ollama-box">
                    <div className="ollama-head">
                      <span><Icon name="Plug" size={13} /> Ollama (local)</span>
                      <span className="ollama-actions">
                        <button type="button" className="btn-mini" disabled={ollamaBusy} onClick={() => connectOllama(false)}>
                          <Icon name="Refresh" size={12} /> Scan
                        </button>
                        <button type="button" className="btn-mini primary" disabled={ollamaBusy} onClick={() => connectOllama(true)}>
                          {ollamaBusy ? 'Connecting…' : (ollama.ok ? 'Start / reconnect' : 'Connect')}
                        </button>
                      </span>
                    </div>
                    <div className="ollama-detail">
                      {ollama.ok
                        ? (ollama.detail || (ollama.models.length + ' models installed'))
                        : (ollama.detail && ollama.detail !== 'Unreachable' ? ollama.detail : 'Not running — press Connect to launch ollama serve')}
                    </div>
                    {ollama.ok && ollama.models.length > 0 && (
                      <div className="ollama-models">
                        {ollama.models.map((m) => (
                          <button type="button" key={m.name} className={'ollama-model' + (provider.model === m.name ? ' on' : '')} title={m.family ? m.family : m.name} onClick={() => applyOllamaModel(m.name)}>
                            {m.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <label>Base URL<input value={provider.baseURL} onChange={set('baseURL')} placeholder="http://localhost:11434/v1" /></label>
                  <label>API Key (optional)<input value={provider.apiKey} onChange={(e) => { const v = e.target.value; setProvider({ ...provider, apiKey: v }); setKeyForEntry(provider.baseURL, v); }} placeholder="sk-…" /></label>
                  <label>Model<input value={provider.model} onChange={set('model')} placeholder="llama3.1" /></label>
                  <div className="row">
                    <label>Temperature<input type="number" step="0.1" value={provider.temperature} onChange={set('temperature')} /></label>
                    <label>Max tokens<input type="number" value={provider.maxTokens} onChange={set('maxTokens')} /></label>
                  </div>
                  <label>Reasoning / thinking level
                    <select value={provider.reasoningLevel || 'auto'} onChange={(e) => setProvider({ ...provider, reasoningLevel: e.target.value })}>
                      <option value="auto">Auto (provider default)</option>
                      <option value="low">Low — fast, minimal thinking</option>
                      <option value="medium">Medium — balanced</option>
                      <option value="high">High — deep, thorough reasoning</option>
                    </select>
                  </label>
                  <p className="muted" style={{ marginTop: -6 }}>Sent to OpenAI-compatible APIs as <code>reasoning_effort</code>; providers that reject it auto-retry without it.</p>
                  <label className="check"><input type="checkbox" checked={provider.supportsTools} onChange={(e) => setProvider({ ...provider, supportsTools: e.target.checked })} /> Function calling / tools</label>
                </div>

                <ModelsAndLimitsSection settings={settings} setSettings={setSettings} convs={convs} />

                <FreeLLMAPISection settings={settings} setSettings={setSettings} orchestrator={orchestrator} saveOrch={saveOrch} setNotice={setNotice} onOpenBrowserUrl={onOpenBrowserUrl} />

                <div className="settings-card">
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                    <div>
                      <h3 style={{ margin: 0 }}><Icon name="Palette" size={14} /> Images &amp; Video Studio APIs</h3>
                      <p className="muted" style={{ margin: '4px 0 0' }}>Configure GEMINI_API_KEY, OPENAI_API_KEY, XAI_API_KEY, FAL_KEY, Replicate, Kling, Luma &amp; Cloudflare for premium image/video models.</p>
                    </div>
                    <button type="button" className="btn-mini primary" onClick={() => setSection('media')}>
                      Configure →
                    </button>
                  </div>
                </div>

                <div className="settings-card">
                  <AccountSection T={T} provider={provider} setProvider={setProvider} />
                </div>
              </>
            )}

            {section === 'media' && (
              <MediaStudioApiKeysSection focusKeyId={focusMediaKey} setNotice={setNotice} onOpenBrowserUrl={onOpenBrowserUrl} />
            )}

            {section === 'appearance' && (
              <>
                <AppearanceStudioSection settings={settings} setSettings={setSettings} setNotice={setNotice} />
                <div className="settings-card">
                  <TypographySettingsSection
                    typography={settings.typography}
                    onChange={(nextTypo) => setSettings({ ...settings, typography: nextTypo })}
                    setNotice={setNotice}
                  />
                </div>
              </>
            )}

            {section === 'notifications' && (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <h3 className="oc-sec-title" style={{ margin: 0 }}>Desktop notifications</h3>
                    <button
                      type="button"
                      className="btn-mini"
                      data-testid="test-desktop-notification-btn"
                      onClick={() => {
                        sendDesktopNotification(
                          'agent',
                          'Akron Code',
                          'Desktop notifications and the Akron Code logo are working across OS targets.',
                          settings,
                          { force: true, convId: activeId || null }
                        );
                        setNotice && setNotice('Sent test desktop notification');
                      }}
                    >
                      <Icon name="Notification" size={12} /> Test Notification
                    </button>
                  </div>
                  <div className="oc-group">
                    {[
                      { k: 'agent', title: 'Agent', sub: 'Show system notification when the agent is complete or needs attention' },
                      { k: 'permissions', title: 'Permissions', sub: 'Show system notification when a permission is required' },
                      { k: 'questions', title: 'Questions', sub: 'Show system notification when the agent asks a question' },
                      { k: 'errors', title: 'Errors', sub: 'Show system notification when an error occurs' },
                      { k: 'notifyWhenFocused', title: 'Notify when focused', sub: 'Also deliver OS notifications even when Akron Code is the active window' },
                      { k: 'sound', title: 'OS notification sound', sub: 'Play native OS alert chime alongside desktop banners' },
                    ].map((row) => (
                      <div key={row.k} className="oc-row">
                        <div className="oc-row-meta">
                          <div className="oc-row-title">{row.title}</div>
                          <div className="oc-row-sub">{row.sub}</div>
                        </div>
                        <div className="oc-row-ctrl">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!!notifCfg[row.k]}
                            className={'oc-switch' + (notifCfg[row.k] ? ' on' : '')}
                            onClick={() => toggleNotif(row.k)}
                          >
                            <span className="oc-switch-knob" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="oc-sec-title">Sound effects</h3>
                  <div className="oc-group">
                    {[
                      { k: 'agent', title: 'Agent', sub: 'Play sound when the agent is complete or needs attention' },
                      { k: 'permissions', title: 'Permissions', sub: 'Play sound when a permission is required' },
                      { k: 'questions', title: 'Questions', sub: 'Play sound when the agent asks a question' },
                      { k: 'errors', title: 'Errors', sub: 'Play sound when an error occurs' },
                    ].map((row) => (
                      <div key={row.k} className="oc-row">
                        <div className="oc-row-meta">
                          <div className="oc-row-title">{row.title}</div>
                          <div className="oc-row-sub">{row.sub}</div>
                        </div>
                        <div className="oc-row-ctrl">
                          <select className="oc-select" value={soundCfg[row.k] || 'none'} onChange={(e) => setSoundPreset(row.k, e.target.value)}>
                            {SOUND_PRESETS.map((sp) => <option key={sp.id} value={sp.id}>{sp.label}</option>)}
                          </select>
                          <button type="button" className="btn-mini" title="Preview sound" onClick={() => playUiSound(soundCfg[row.k] || 'staplebops-01')}>
                            <Icon name="Play" size={11} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <QuietHoursSection setNotice={setNotice} />
                <MobilePushSection setNotice={setNotice} />
              </>
            )}

            {section === 'orchestrator' && (
              <>
                <div>
                  <h3 className="oc-sec-title">DeepSeek Harness Runtime Profile</h3>
                  <div className="oc-group">
                    <div className="oc-row">
                      <div className="oc-row-meta">
                        <div className="oc-row-title">Active harness profile</div>
                        <div className="oc-row-sub">Controls system instruction focus, cache-prefix discipline, and agent aggressiveness.</div>
                      </div>
                      <div className="oc-row-ctrl">
                        <select className="oc-select" value={settings.harnessProfile || 'full'} onChange={(e) => setSettings({ ...settings, harnessProfile: e.target.value })}>
                          {HARNESS_PROFILES.map((hp) => <option key={hp.id} value={hp.id}>{hp.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-card">
                  <h3><Icon name="Settings" size={14} /> {T('settings.orchestrator')}</h3>
                  <label className="check"><input type="checkbox" data-testid="orch-enable-checkbox" checked={!!orchestrator.enabled} onChange={(e) => { const nextOrch = { ...orchestrator, enabled: e.target.checked }; saveOrch(nextOrch); setProvider((v) => syncProviderForOrchestratorToggle(v, nextOrch, orchestrator)); }} /> Enable — multi-model pool for failover AND swarm tier routing</label>
                  <OrchPaidProvidersPanel
                    orchestrator={orchestrator}
                    saveOrch={saveOrch}
                    onProvidersLoaded={setOrchPaidProviders}
                  />
                  {orchestrator.enabled && (
                    <>
                      <p className="muted" style={{ marginTop: -4 }}>
                        Tick the models this pool may use — the list is everything this machine has loaded
                        (signed-in subscription accounts, Paid API providers, and local/API gateways). <b>Tier</b> decides which
                        model a supervisor-assigned subtask runs on: <b>small</b> = cheap/mechanical work,
                        <b> heavy</b> = real implementation, <b>critical</b> = architecture/security/review
                        (also the supervisor's own model). <b>start</b> marks the first model failover tries.
                      </p>
                      <OrchModelChecklist
                        orchestrator={orchestrator}
                        provider={provider}
                        localModels={ollama.ok ? ollama.models : []}
                        localBase={ollama.base}
                        paidProviders={orchPaidProviders}
                        saveOrch={saveOrch}
                      />
                    </>
                  )}
                </div>

                <div className="settings-card">
                  <h3><Icon name="Users" size={14} /> Role pools</h3>
                  <RolePoolsEditor orchestrator={orchestrator} saveOrch={saveOrch} />
                </div>
              </>
            )}

            {section === 'harness' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Wrench" size={14} /> Creator Mode · Custom Runtime Tools</h3>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Hot-swappable tools authored by you or the agent (<code>CreateCustomTool</code>). Saved under <code>~/.autobot/custom-tools/</code> and runnable immediately on Node, Bash/PowerShell, or Python.
                  </p>
                  <div className="row">
                    <label>Tool identifier<input value={ctDraft.name} onChange={(e) => setCtDraft({ ...ctDraft, name: e.target.value })} placeholder="repo_health_check" /></label>
                    <label>Runtime
                      <select value={ctDraft.runtime} onChange={(e) => setCtDraft({ ...ctDraft, runtime: e.target.value })}>
                        <option value="node">Node.js</option>
                        <option value="bash">Shell (zsh / PowerShell)</option>
                        <option value="python3">Python 3</option>
                      </select>
                    </label>
                  </div>
                  <label>Description<input value={ctDraft.description} onChange={(e) => setCtDraft({ ...ctDraft, description: e.target.value })} placeholder="Check git & lint status in one command" /></label>
                  <label>Script (receives JSON args in <code>process.env.TOOL_ARGS_JSON</code> &amp; stdin)
                    <textarea rows={4} style={{ width: '100%', marginTop: 5, fontFamily: 'var(--mono)', fontSize: 12, padding: 8, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }} value={ctDraft.script} onChange={(e) => setCtDraft({ ...ctDraft, script: e.target.value })} />
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      className="btn-mini primary"
                      onClick={async () => {
                        setCtMsg('');
                        try {
                          await window.autobot.customToolSave(ctDraft);
                          setCtMsg(`Saved tool "${ctDraft.name}".`);
                          setCtDraft({ name: '', description: '', runtime: 'node', script: 'const args = JSON.parse(process.env.TOOL_ARGS_JSON || "{}");\nconsole.log("ok", args);' });
                          refreshCustomTools();
                        } catch (e) { setCtMsg('Error: ' + String(e?.message || e)); }
                      }}
                    >
                      Save custom tool
                    </button>
                    {ctMsg && <span className="muted" style={{ margin: 0 }}>{ctMsg}</span>}
                  </div>
                  {customTools.length > 0 && (
                    <div className="ct-list">
                      {customTools.map((ct) => (
                        <div key={ct.name} className="ct-row">
                          <div>
                            <b>{ct.name}</b> <span className="muted">({ct.runtime})</span>
                            <div className="muted" style={{ margin: 0 }}>{ct.description}</div>
                          </div>
                          <button type="button" className="btn-mini" onClick={async () => { await window.autobot.customToolDelete(ct.name); refreshCustomTools(); }}>Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="settings-card">
                  <h3><Icon name="Code" size={14} /> Developer &amp; Agent Capabilities</h3>
                  <label className="check"><input type="checkbox" checked={!!features.extensions} onChange={(e) => saveFeat({ ...features, extensions: e.target.checked })} /> Extensions (custom tools / MCP servers)</label>
                  <label className="check"><input type="checkbox" checked={!!features.developerMode} onChange={(e) => saveFeat({ ...features, developerMode: e.target.checked })} /> Developer mode (debug tools + local exec consent)</label>
                  <label className="check"><input type="checkbox" checked={!!features.buddy} onChange={(e) => saveFeat({ ...features, buddy: e.target.checked })} /> Buddy (pair-hunting co-pilot)</label>
                  <label className="check"><input type="checkbox" checked={!!features.remoteControl} onChange={(e) => saveFeat({ ...features, remoteControl: e.target.checked })} /> Remote Control (Drive / co-browsing session)</label>
                </div>
              </>
            )}

            {section === 'rea' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Orbit" size={14} /> Built-In REA Engine (<code>morluto/rea</code>)</h3>
                  <div className="ext-card-status">
                    <div>
                      <span className={'ext-dot' + (reaInfo && reaInfo.connected ? ' on' : '')} />
                      <b>
                        {reaInfo && reaInfo.connected
                          ? `Connected (${reaInfo.toolCount} MCP tools active${reaInfo.version ? ' · v' + reaInfo.version : ''})`
                          : (reaInfo && reaInfo.available ? `Ready (${reaInfo.mode}${reaInfo.version ? ' · v' + reaInfo.version : ''})` : 'Node 22+ or rea-agents not found')}
                      </b>
                      <p className="muted" style={{ margin: '4px 0 0' }}>
                        Built-in reverse engineering across native binaries (Hopper / Ghidra / IDA / Rizin), Electron/ASAR/JS, Android APKs, Apple bundles, firmware, PCAP/HAR captures, and AgentEnv via <code>rea</code>, <code>find_mcp_tools</code>, and bundled skill <code>reverse-engineer-anything</code>.
                      </p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn-mini primary"
                      disabled={reaBusy}
                      onClick={async () => {
                        if (!window.autobot || !window.autobot.reaConnect) return;
                        setReaBusy(true); setReaDiagOut('');
                        try {
                          const r = await window.autobot.reaConnect();
                          if (r && r.status) setReaInfo(r.status); else refreshReaStatus();
                          setReaDiagOut(r && r.ok ? `Connected ${r.toolCount} REA tools.` : `Connect error: ${(r && r.error) || 'unknown'}`);
                        } finally { setReaBusy(false); }
                      }}
                    >
                      <Icon name={reaBusy ? 'Spinner' : 'Refresh'} size={12} className={reaBusy ? 'spin' : ''} /> Connect / Reconnect MCP
                    </button>
                    <button
                      type="button"
                      className="btn-mini"
                      disabled={reaBusy}
                      onClick={async () => {
                        if (!window.autobot || !window.autobot.reaDoctor) return;
                        setReaBusy(true); setReaDiagOut('');
                        try {
                          const r = await window.autobot.reaDoctor();
                          if (r && r.status) setReaInfo(r.status);
                          setReaDiagOut((r && r.output) || (r && r.error) || 'Doctor finished.');
                        } finally { setReaBusy(false); }
                      }}
                    >
                      Run REA Doctor
                    </button>
                    <button
                      type="button"
                      className="btn-mini"
                      disabled={reaBusy}
                      onClick={async () => {
                        if (!window.autobot || !window.autobot.reaInstall) return;
                        setReaBusy(true); setReaDiagOut('Installing/updating rea-agents...');
                        try {
                          const r = await window.autobot.reaInstall();
                          if (r && r.status) setReaInfo(r.status);
                          setReaDiagOut((r && r.output) || (r && r.error) || 'Done.');
                        } finally { setReaBusy(false); }
                      }}
                    >
                      Install / Update REA
                    </button>
                  </div>
                  {reaInfo && (
                    <div className="ct-list" style={{ marginTop: 12 }}>
                      <div className="ct-row"><span>Node runtime</span><code>{reaInfo.nodeVersion ? `${reaInfo.nodeVersion} (${reaInfo.nodePath})` : 'Not detected'}</code></div>
                      <div className="ct-row"><span>REA package</span><code>{reaInfo.reaPath || 'Unavailable'}</code></div>
                      <div className="ct-row"><span>Bundled skill</span><code>{reaInfo.skillBundled ? 'reverse-engineer-anything (active)' : 'Missing'}</code></div>
                    </div>
                  )}
                  {reaDiagOut && (
                    <pre className="tool-result" style={{ marginTop: 12, maxHeight: 220, overflow: 'auto' }}>{reaDiagOut}</pre>
                  )}
                </div>
              </>
            )}

            {section === 'browser' && (
              <>
                <div className="settings-card" data-testid="browser-ext-card">
                  <h3><Icon name="Globe" size={14} /> Akron Browser Bot · Standalone &amp; Auto-Installer</h3>
                  <div className="ext-card-status">
                    <div>
                      <span className={'ext-dot' + (extStatus && extStatus.extensionConnected ? ' on' : '')} />
                      <b>{extStatus && extStatus.extensionConnected ? `Connected (v${extStatus.extensionVersion || '1.6.7'})` : 'Listening for extension on ws://127.0.0.1:8766'}</b>
                      <p className="muted" style={{ margin: '4px 0 0' }}>
                        All models configured in Akron Code Desktop are shared automatically at <code>http://127.0.0.1:8766/v1</code> — zero separate API keys required.
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      <button type="button" className="btn-mini" onClick={refreshExtStatus}><Icon name="Refresh" size={12} /> Refresh</button>
                      <button type="button" className="btn-mini" onClick={() => window.autobot.extBridgeOpenFolder && window.autobot.extBridgeOpenFolder()}>
                        <Icon name="Folder" size={12} /> Open Standalone Extension Folder
                      </button>
                    </div>
                  </div>

                  <div className="ct-list" style={{ marginTop: 10 }}>
                    <div className="ct-row">
                      <span>Standalone Folder</span>
                      <code>{(extStatus && extStatus.extensionDir) || '~/Applications/Akron Browser Bot'}</code>
                    </div>
                    {extStatus && extStatus.extensionId && (
                      <div className="ct-row">
                        <span>Signed Extension ID (CRX3)</span>
                        <code>{extStatus.extensionId}</code>
                      </div>
                    )}
                    <div className="ct-row">
                      <span>Detected Default Browser</span>
                      <code>
                        {(extStatus && extStatus.defaultBrowser && extStatus.defaultBrowser.name) || 'Detecting…'}
                        {extStatus && extStatus.preferredChromiumBrowser && extStatus.defaultBrowser && !extStatus.defaultBrowser.isChromium
                          ? ` (Chromium target: ${extStatus.preferredChromiumBrowser.name})`
                          : ''}
                      </code>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn-mini primary"
                      data-testid="ext-install-browser-btn"
                      disabled={!!extBusy}
                      onClick={() => handleInstallExtBrowser((extStatus && extStatus.preferredChromiumBrowser && extStatus.preferredChromiumBrowser.id) || '')}
                    >
                      🧩 {extBusy === 'install'
                        ? 'Installing CRX3…'
                        : `Add Akron Web Bot to ${(extStatus && extStatus.preferredChromiumBrowser && extStatus.preferredChromiumBrowser.name) || 'Browser'}`}
                    </button>
                    <button
                      type="button"
                      className="btn-mini"
                      data-testid="ext-launch-browser-btn"
                      disabled={!!extBusy}
                      onClick={() => handleLaunchExtBrowser((extStatus && extStatus.preferredChromiumBrowser && extStatus.preferredChromiumBrowser.id) || '')}
                    >
                      🚀 {extBusy === 'launch'
                        ? 'Launching…'
                        : `Launch ${(extStatus && extStatus.preferredChromiumBrowser && extStatus.preferredChromiumBrowser.name) || 'Browser'} with Extension Pre-Loaded`}
                    </button>
                  </div>
                  {extActionMsg && (
                    <div className="muted" style={{ marginTop: 8, fontSize: 12, color: extActionMsg.startsWith('⚠️') ? '#f59e0b' : '#34d399' }}>
                      {extActionMsg}
                    </div>
                  )}
                </div>

                <div className="settings-card">
                  <h3>Manual Load Fallback (Any Chromium Browser)</h3>
                  <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65 }}>
                    <li>Click <b>Open Standalone Extension Folder</b> above — it lives outside the app bundle at <code>{(extStatus && extStatus.extensionDir) || '~/Applications/Akron Browser Bot'}</code> with <code>akron-browser-bot.crx</code>.</li>
                    <li>Open <code>{(extStatus && extStatus.preferredChromiumBrowser && extStatus.preferredChromiumBrowser.schemeUrl) || 'chrome://extensions'}</code>, enable <b>Developer mode</b>, click <b>Load unpacked</b>, and select that folder.</li>
                    <li>Open the Akron Browser Bot side panel — it connects automatically with access to <code>akron-default</code>, <code>akron-planner</code>, <code>akron-coder</code>, <code>akron-vision</code>, <code>akron-fast</code>, and <code>akron-longctx</code>, and Desktop agents can drive tabs via <code>ext_browser</code>.</li>
                  </ol>
                  {extStatus && Array.isArray(extStatus.tabs) && extStatus.tabs.length > 0 && (
                    <div className="ct-list" style={{ marginTop: 12 }}>
                      {extStatus.tabs.slice(0, 6).map((t) => (
                        <div key={t.id} className="ct-row">
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.active ? '● ' : ''}{t.title || t.url}</span>
                          <span className="muted" style={{ margin: 0 }}>tab #{t.id}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <BrowserSettingsSection settings={settings} setSettings={setSettings} setNotice={setNotice} />
              </>
            )}

            {section === 'voice' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Microphone" size={14} /> Built-In Voice Model &amp; Dictation</h3>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Speak directly into the composer or Code Review comments using the built-in ONNX Whisper speech model (offline) or fast gateway Whisper transcription when available.
                  </p>
                  <div className="row">
                    <label>Voice recognition engine
                      <select value={settings.voiceEngine || 'auto'} onChange={(e) => setSettings({ ...settings, voiceEngine: e.target.value })}>
                        <option value="auto">Auto (Gateway Whisper → Built-in Offline Whisper)</option>
                        <option value="local">Built-in Whisper (Offline ONNX)</option>
                        <option value="gateway">Gateway Whisper only</option>
                      </select>
                    </label>
                    <label>Dictation language
                      <select value={settings.voiceLang || 'en-US'} onChange={(e) => setSettings({ ...settings, voiceLang: e.target.value })}>
                        <option value="en-US">English (US)</option>
                        <option value="en-GB">English (UK)</option>
                        <option value="pl-PL">Polish</option>
                        <option value="de-DE">German</option>
                        <option value="es-ES">Spanish</option>
                        <option value="fr-FR">French</option>
                        <option value="ja-JP">Japanese</option>
                        <option value="zh-CN">Chinese</option>
                      </select>
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <button type="button" className={'btn-mini ' + (testVoice.state !== 'idle' ? 'primary' : '')} onClick={testVoice.toggle}>
                      <Icon name={testVoice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={13} className={testVoice.state === 'transcribing' ? 'spin' : ''} />
                      {testVoice.state === 'recording' ? ` Stop recording (${testVoice.seconds}s)` : (testVoice.state === 'transcribing' ? ' Transcribing…' : ' Test Microphone')}
                    </button>
                    {testVoice.statusNote && <span className="muted" style={{ margin: 0 }}>{testVoice.statusNote}</span>}
                    {voiceTestErr && <span style={{ color: '#f87171', fontSize: 12 }}>{voiceTestErr}</span>}
                  </div>
                  {voiceTestOut && (
                    <div className="ct-row" style={{ marginTop: 10 }}>
                      <span>Heard: <b>{voiceTestOut}</b></span>
                    </div>
                  )}
                </div>
              </>
            )}

            {section === 'environments' && (
              <>
                <EnvironmentsSection
                  envState={envState}
                  refreshEnvState={refreshEnvState}
                  onSwitchEnvironment={onSwitchEnvironment}
                  setError={setError}
                  setNotice={setNotice}
                  cwd={cwd}
                />
                <ParadevIntegrationCard setNotice={setNotice} />
              </>
            )}

            {section === 'security' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="LockShield" size={14} /> Permissions &amp; Automation</h3>
                  <div className="row">
                    <label>{T('code.permissions')}
                      <select value={permissions} onChange={(e) => setPermissions(e.target.value)}>
                        <option value="auto">{T('code.permissions.auto')}</option>
                        <option value="ask">{T('code.permissions.ask')}</option>
                        <option value="acceptEdits">{T('code.permissions.acceptEdits')}</option>
                        <option value="plan">{T('code.permissions.plan')}</option>
                        <option value="bypass">{T('perm.bypass')}</option>
                      </select>
                    </label>
                  </div>
                  <p className="muted">{T('code.permissions.hint')}</p>
                  <label className="check"><input type="checkbox" checked={!!features.trustedFolders} onChange={(e) => saveFeat({ ...features, trustedFolders: e.target.checked })} /> Trusted folders (pre-approve shell exec in these dirs)</label>
                  <label className="check"><input type="checkbox" checked={!!features.computerUse} onChange={(e) => saveFeat({ ...features, computerUse: e.target.checked })} /> Computer Use (screen + mouse/keyboard via OS automation)</label>
                  <label className="check"><input type="checkbox" checked={!!features.computerUseTeach} onChange={(e) => saveFeat({ ...features, computerUseTeach: e.target.checked })} /> Computer Use — teach &amp; watch/record</label>
                  <label className="check"><input type="checkbox" checked={!!features.chrome} onChange={(e) => saveFeat({ ...features, chrome: e.target.checked })} /> Chrome control (CDP)</label>
                  {features.chrome && (
                    <div className="row">
                      <label>Chrome host<input value={features.chromeHost} onChange={(e) => saveFeat({ ...features, chromeHost: e.target.value })} /></label>
                      <label>Chrome port<input type="number" value={features.chromePort} onChange={(e) => saveFeat({ ...features, chromePort: Number(e.target.value) })} /></label>
                    </div>
                  )}
                  <label className="check"><input type="checkbox" checked={!!features.bridges} onChange={(e) => saveFeat({ ...features, bridges: e.target.checked })} /> Bot bridges (webhook server for hearthbot/slackbot/teamsbot/webagent)</label>
                </div>

                <div className="settings-card">
                  <PermissionRulesSection cwd={cwd} setNotice={setNotice} />
                </div>

                <div className="settings-card">
                  <ComplianceSection compliance={compliance} setCompliance={setCompliance} />
                </div>
              </>
            )}

            {section === 'skills' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Lightbulb" size={14} /> Skills</h3>
                  <SkillsViewBody skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills} />
                </div>
                <div className="settings-card">
                  <h3><Icon name="Plugin" size={14} /> Plugins &amp; Connectors</h3>
                  <PluginsViewBody onOpenGdrive={onOpenGdrive} gdriveState={gdriveState} />
                </div>
              </>
            )}

            {section === 'mcp' && (
              <>
                <div className="settings-card">
                  <McpView mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp} />
                </div>
                <ParadevIntegrationCard setNotice={setNotice} />
              </>
            )}

            {section === 'memory' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Memory" size={14} /> Long-Term Memory</h3>
                  <MemoryView memory={memory} addMemory={addMemory} clearMemory={clearMemory} convs={convs} provider={provider} onJumpToMessage={onJumpToMessage} />
                </div>
                <div className="settings-card">
                  <h3><Icon name="Book" size={14} /> Notebooks</h3>
                  <NotebooksView notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells} openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook} />
                </div>
              </>
            )}

            {section === 'worktrees' && (
              <>
                <div>
                  <h3 className="oc-sec-title">Create isolated git worktree</h3>
                  <div className="settings-card">
                    <p className="muted" style={{ marginTop: 0 }}>
                      Check out another branch in a parallel directory without disturbing your active workspace. Switch any session into a worktree in one click.
                    </p>
                    <div className="row">
                      <label>New or existing branch
                        <input value={wtBranch} onChange={(e) => setWtBranch(e.target.value)} placeholder="feat/native-win32-perf" />
                      </label>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button
                        type="button"
                        className="btn-mini primary"
                        disabled={wtBusy || !wtBranch.trim()}
                        onClick={async () => {
                          if (!window.autobot || !window.autobot.worktreeAdd) return;
                          setWtBusy(true); setWtMsg('');
                          try {
                            const r = await window.autobot.worktreeAdd(cwd || undefined, wtBranch.trim());
                            if (r && r.ok) {
                              setWtInfo(r);
                              setWtBranch('');
                              setWtMsg(`✅ Created worktree at ${r.path}`);
                            } else {
                              setWtMsg(`❌ ${(r && r.error) || 'Failed to create worktree'}`);
                            }
                          } finally { setWtBusy(false); }
                        }}
                      >
                        <Icon name="GitBranch" size={12} /> Create worktree
                      </button>
                      <button type="button" className="btn-mini" onClick={refreshWorktrees}><Icon name="Refresh" size={12} /> Refresh</button>
                      {wtMsg && <span className="muted" style={{ margin: 0 }}>{wtMsg}</span>}
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="oc-sec-title">Repository worktrees {wtInfo.root ? `(${wtInfo.worktrees.length})` : ''}</h3>
                  <div className="oc-group">
                    {!wtInfo.isRepo ? (
                      <div className="oc-row"><div className="oc-row-meta"><div className="oc-row-title">Open a git repository workspace to inspect worktrees</div><div className="oc-row-sub">Current workspace: {cwd || '~'}</div></div></div>
                    ) : wtInfo.worktrees.map((w) => (
                      <div key={w.path} className="oc-row">
                        <div className="oc-row-meta">
                          <div className="oc-row-title">{w.branch || '(detached)'} {w.main ? '· main' : ''}</div>
                          <div className="oc-row-sub">{w.path} {w.head ? `· ${w.head}` : ''}</div>
                        </div>
                        <div className="oc-row-ctrl">
                          <button type="button" className="btn-mini" onClick={() => { if (setCwd) { setCwd(w.path); setWtMsg(`✅ Workspace switched to ${w.path}`); } }}>
                            {cwd === w.path ? 'Active' : 'Use'}
                          </button>
                          {!w.main && (
                            <button
                              type="button"
                              className="btn-mini"
                              onClick={async () => {
                                if (!window.autobot || !window.autobot.worktreeRemove) return;
                                const r = await window.autobot.worktreeRemove(cwd || undefined, w.path);
                                if (r && r.ok) setWtInfo(r);
                                else setWtMsg(`❌ ${(r && r.error) || 'Failed to remove worktree'}`);
                              }}
                            >Remove</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {section === 'server' && (
              <div>
                <h3 className="oc-sec-title">Local Host &amp; Bridge Endpoints</h3>
                <div className="oc-group">
                  <div className="oc-row">
                    <div className="oc-row-meta">
                      <div className="oc-row-title">Local Gateway API (Zero-Key Extension Bridge)</div>
                      <div className="oc-row-sub"><code>{(serverMeta && serverMeta.url) || 'http://127.0.0.1:8766'}</code> · {serverMeta && serverMeta.extensionConnected ? 'Akron Browser Bot connected' : 'Ready for connections'}</div>
                    </div>
                    <div className="oc-row-ctrl">
                      <button type="button" className="btn-mini" onClick={() => { navigator.clipboard?.writeText((serverMeta && serverMeta.url) || 'http://127.0.0.1:8766'); setError('✅ Copied server URL'); }}>Copy URL</button>
                      <button type="button" className="btn-mini" onClick={refreshServerMeta}><Icon name="Refresh" size={12} /></button>
                    </div>
                  </div>
                  <div className="oc-row">
                    <div className="oc-row-meta">
                      <div className="oc-row-title">WebSocket Control Channel</div>
                      <div className="oc-row-sub"><code>{(serverMeta && serverMeta.wsUrl) || 'ws://127.0.0.1:8766'}</code> · {serverMeta ? `${serverMeta.connectedClients || 0} client(s)` : 'Listening'}</div>
                    </div>
                  </div>
                  <div className="oc-row">
                    <div className="oc-row-meta">
                      <div className="oc-row-title">Host Runtime</div>
                      <div className="oc-row-sub">{serverMeta ? `${serverMeta.platform} / ${serverMeta.arch} · PID ${serverMeta.pid}` : 'Akron Code Desktop Host'}</div>
                    </div>
                  </div>
                </div>
                <OutboundRelaySection setNotice={setNotice} />
              </div>
            )}

            {section === 'shortcuts' && (() => {
              const sc = shortcutLabels();
              return (
                <div>
                  <h3 className="oc-sec-title">Keyboard Shortcuts</h3>
                  <div className="oc-group">
                    {[
                      ['New conversation tab', sc.newTab],
                      ['Quick Open / Command Center', sc.quickOpen],
                      ['Inline AI Edit', sc.inlineEdit],
                      ['Project Search & Replace', sc.globalSearch],
                      ['Go to Symbol in Editor', sc.goToSymbol],
                      ['Toggle Terminal / Problems', sc.toggleTerminal],
                      ['Toggle Sidebar / Agent Dock', sc.toggleAgent],
                      ['Find in Chat / Terminal', sc.find],
                      ['Open Settings', sc.settings],
                      ['Slash actions & skills menu', '/'],
                      ['File & agent @mentions', '@'],
                      ['Quick Entry global launcher', sc.quickEntry],
                    ].map(([title, kbd]) => (
                      <div key={title} className="oc-row">
                        <div className="oc-row-meta"><div className="oc-row-title">{title}</div></div>
                        <div className="oc-row-ctrl"><span className="oc-kbd">{kbd}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {section === 'runtimes' && (
              <>
                <FreeLLMAPISection settings={settings} setSettings={setSettings} orchestrator={orchestrator} saveOrch={saveOrch} setNotice={setNotice} onOpenBrowserUrl={onOpenBrowserUrl} />
                <DependenciesAndUpdaterSection setNotice={setNotice} />
                <div className="settings-card">
                  <RuntimesSection />
                </div>
              </>
            )}

            {section === 'system' && (
              <>
                <AutoSwitchBrainSection settings={settings} setSettings={setSettings} provider={provider} setProvider={setProvider} orchestrator={orchestrator} setNotice={setNotice} onOpenBrowserUrl={onOpenBrowserUrl} />

                <AppearanceStudioSection settings={settings} setSettings={setSettings} setNotice={setNotice} />

                <div className="settings-card">
                  <h3>{T('settings.behavior')}</h3>
                  <div className="row">
                    <label>{T('settings.theme')}
                      <select value={settings.theme || 'dark'} onChange={(e) => setSettings({ ...settings, theme: e.target.value })}>
                        <option value="dark">{T('settings.theme.dark')}</option>
                        <option value="light">{T('settings.theme.light')}</option>
                        <option value="auto">Auto (System)</option>
                      </select>
                    </label>
                    <label>{T('settings.locale')}
                      <select value={settings.locale || 'en'} onChange={(e) => setSettings({ ...settings, locale: e.target.value })}>
                        {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="check"><input type="checkbox" checked={settings.useMemory} onChange={(e) => setSettings({ ...settings, useMemory: e.target.checked })} /> Inject long-term memory into prompts</label>
                  <label className="check"><input type="checkbox" checked={!!settings.launchAtLogin} onChange={(e) => setSettings({ ...settings, launchAtLogin: e.target.checked })} /> Launch Akron Code at login</label>
                  <label className="check"><input type="checkbox" checked={!!features.quickEntry} onChange={(e) => saveFeat({ ...features, quickEntry: e.target.checked })} /> Quick Entry (global hotkey CmdOrCtrl+Shift+Space)</label>
                </div>

                <div className="settings-card">
                  <TypographySettingsSection
                    typography={settings.typography}
                    onChange={(nextTypo) => setSettings({ ...settings, typography: nextTypo })}
                    setNotice={setNotice}
                  />
                </div>

                <ApplicationSettingsSection settings={settings} setSettings={setSettings} features={features} saveFeat={saveFeat} setNotice={setNotice} />

                <div className="settings-card">
                  <RuntimesSection />
                </div>
              </>
            )}

            {section === 'project' && (
              <ProjectSettingsPanel
                cwd={cwd}
                setCwd={setCwd}
                projects={projects}
                setProjects={setProjects}
                activeProject={activeProject}
                setActiveProject={setActiveProject}
                skills={skills}
                mcpServers={mcpServers}
                setNotice={setNotice}
              />
            )}

            {section === 'migrate' && (
              <MigrationWizard cwd={cwd} setNotice={setNotice} />
            )}

            {section === 'about' && (
              AboutSectionComponent ? <AboutSectionComponent theme={settings.theme || 'dark'} setNotice={setNotice} /> : (renderAboutSection ? renderAboutSection('about') : null)
            )}

            {section === 'feedback' && (
              <GiveFeedbackSection settings={settings} provider={provider} setNotice={setNotice} />
            )}
            </div>
          </div>

          <footer className="settings-foot">
            <div className="settings-foot-inner">
              <span className="muted" style={{ margin: 0 }}>{provider.model ? `Active model: ${provider.model}` : 'Configure a provider to begin'}</span>
              <div className="modal-actions">
                <button onClick={testProvider}>Test connection</button>
                <button className="primary" onClick={onClose}>{T('settings.done')}</button>
              </div>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

// QuestionModal extracted to src/features/AppModals.jsx
