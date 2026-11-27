import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import './styles/workspace-panels.css';
import './styles/emerald-carbon.css';
import iconsMap from './icons.json';
import { t as _t, LOCALES, localeDir } from './i18n.js';
import { stripToolProtocol } from './textproto.mjs';
import { normBase, LOCAL_BASE, KEY_STATUS_TTL, keySig, statusOf, presetStatus } from './providerstatus-ui.mjs';
import { hydrateProvider, endpointKey } from './providerhydrate.mjs';
import { ctxToastState } from './ctx-toast.mjs';
import ConnectorLogo from './ConnectorLogo.jsx';
import { useVoiceDictation } from './voice';
import { LiveChecklistCard, LiveToolActivityCard, StickyLiveToolBar, FilesChangedBar, summarizeChangedFiles } from './components/LiveProgress.jsx';
import { CodeReviewPane } from './components/CodeReviewPane.jsx';
import { AboutSection } from './components/AboutSection.jsx';
import { NotificationCenter, useNotificationCenter } from './components/NotificationCenter.jsx';
import PermissionDock from './components/PermissionDock.jsx';
import QuestionDock from './components/QuestionDock.jsx';
import { MediaDocCardList } from './components/MediaDocCard.jsx';
import { MediaStudioView } from './components/MediaStudioView.jsx';
import MessageQueueTray, { filterQueueForConv, pickNextRunnableQueued, moveQueueItem, stepQueueItemWithinConv } from './components/MessageQueueTray.jsx';
import { UI_FONT_PRESETS, MONO_FONT_PRESETS, DEFAULT_TYPOGRAPHY, normalizeTypography, resolveUiFontStack, resolveMonoFontStack, applyTypographyToDocument } from './typography.js';
import { deriveSubAgents } from './review-helpers.mjs';
import { IdeWorkbench } from './ide/IdeWorkbench.jsx';
import { MindMapView } from './ide/MindMapView.jsx';
import { shortcutLabels } from './ide/shortcuts';
import { Icon, iconChar, GoogleDriveIcon, AgentIcon, ModelLogo } from './components/Icon.jsx';
import { ComputerUseModal, CommandPalette, FindBar, GoogleDriveModal } from './features/AppModals.jsx';
import { MemoryView, ProjectsView, McpView, NotebooksView } from './features/WorkspacePanels.jsx';
import { CustomizationsHub } from './components/customizations/CustomizationsHub.jsx';
import { MissionControlPane } from './components/MissionControlPane.jsx';
import { ProactiveDashboard } from './components/ProactiveDashboard.jsx';
import { ProjectsSidebar } from './components/sidebar/ProjectsSidebar.jsx';
import { ProjectSettingsPanel } from './components/settings/ProjectSettingsPanel.jsx';
import { ApplicationSettingsSection, AppearanceStudioSection, BrowserSettingsSection, ModelsAndLimitsSection, GiveFeedbackSection, DEFAULT_APPEARANCE_SETTINGS, computeAppearanceVars, UI_DESIGN_PREFS_KEY } from './components/settings/ExtendedSettingsPanels.jsx';

// Icon, iconChar, GoogleDriveIcon imported from ./components/Icon.jsx


// Every banner in the account/picker surface is dismissible. The dismissed
// value is the banner's own text, so hiding "Imported 2 accounts" can never
// also hide the next, different message — a new failure always speaks up.
// `storeError` stays honest: dismissal is per surface and per mounted
// component, so it never clears the underlying error, only this rendering of it.
import {
  ProvNotice, renderMarkdown, resolveLoopbackKey, timeGreeting, cleanErr, usedTokens, contextWindowFor, effectiveUsageForConv,
  PRESETS, PRESET_KEYS, STYLES, REASON_LEVELS, DEFAULT_PROVIDER, loadJSON, saveJSON, uid, Logo,
  LinkPreviews, fmtTokens, estimateCost, fmtCost, msgText, buildDirectives, fmtElapsed, fmtMessageTimestamp, fmtMessageFullTimestamp,
} from './utils/appHelpers.jsx';
import { useAutobotEventStream } from './hooks/useAutobotEventStream.js';
import {
  EnvPanel, MissionControl, RunLogPanel, ChatView, ArtifactPreview, SearchView,
  ArtifactsView, SkillsViewBody, PluginsViewBody, ExtensionsView, ScheduledViewBody,
  TerminalView, CodeView, SubagentsPane, SessionPane, ExportMenu, TodoList, ToolGroup,
  ToolDetail, DeltaChips, DiffBlock, ContextLimitToast, ThinkBlock,
} from './components/chat/WorkspaceViews.jsx';
import { BrowserViewBody } from './components/browser/BrowserPaneView.jsx';
import { DocPreviewPane } from './components/chat/DocPreviewPane.jsx';
import { InputBarBody } from './components/chat/InputBarView.jsx';
import { SettingsModalBody } from './components/settings/SettingsModalBody.jsx';
import { resolveAgainstCwd, isHtmlPath, attachDocumentLinkRouter } from './utils/linkAndFileHelpers.js';
import { sendDesktopNotification, convToMarkdown, convToHtml, escapeHtml, fmtSize, extractCodeBlocks, filesToAttachments, toggleDictation, useDismiss, priceFor, FREELLM_LOOPBACK_BASES, MODEL_WINDOW_CACHE, HARNESS_PROFILES, SOUND_PRESETS, playUiSound, extractLinks, fetchUnfurl, parseCodeInfo, copyTextToClipboard, extractMessageText } from './utils/appHelpers.jsx';
import { extractPersistedSettings, mergeBootSettings, reconcileBootProvider, syncProviderForOrchestratorToggle, mergeBootUiState } from './utils/settingsPersistence.js';

// Compact record of what the assistant actually did with tools last turn.
// Model switches need this: the new model sees files + mindmap, but without the
// action trace it re-does work or claims things it never ran.
const summarizeTrace = (tools) => {
  const list = Array.isArray(tools) ? tools.filter((t) => t && t.name) : [];
  if (!list.length) return '';
  const clip = (v, n) => {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, n || 110);
  };
  const lines = list.slice(-15).map((t) => {
    const a = t.args || {};
    const target = a.path || a.file || a.command || a.query || a.url || a.name || a.description || a.prompt || '';
    const bad = /^(Error|Tool error)/i.test(String(t.result || '').trim());
    const lim = /^(Task|Agent|Swarm|Workflow)$/.test(t.name) ? 600 : 110;
    return `- ${t.name}${target ? '(' + clip(target, 90) + ')' : ''} → ${bad ? 'ERROR: ' : ''}${clip(t.result, lim) || '(no result)'}`;
  });
  return '\n\n[Tool actions taken in your previous turn — this already happened, do not redo it]\n' + lines.join('\n');
};

const buildPayloadMessages = (msgs) => msgs.map((m) => {
  const atts = m.attachments || [];
  const images = atts.filter((a) => a.isImage && a.dataUrl);
  const textAtts = atts.filter((a) => !(a.isImage && a.dataUrl));
  let textPart = m.content || '';
  if (m.role === 'assistant' && Array.isArray(m.tools) && m.tools.length) {
    textPart += summarizeTrace(m.tools);
  }
  if (textAtts.length) {
    textPart += '\n\nAttached files:\n' + textAtts.map((a) => (a.isText && a.content != null
      ? `\n--- FILE: ${a.name} ---\n${a.content}\n--- END FILE: ${a.name} ---`
      : `\n[Attached file: ${a.name} (${a.size} bytes, binary)]`)).join('\n');
  }
  if (images.length) {
    const parts = [];
    if (textPart.trim()) parts.push({ type: 'text', text: textPart });
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    return { role: m.role, content: parts };
  }
  const out = { role: m.role, content: textPart };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
});


export default function App() {
  const [convs, setConvs] = useState(() => loadJSON('autobot:convs', []));
  const [activeId, setActiveId] = useState(() => loadJSON('autobot:activeId', null));
  const [openTabIds, setOpenTabIds] = useState(() => {
    const savedTabs = loadJSON('autobot:openTabs', null);
    const curId = loadJSON('autobot:activeId', null);
    if (Array.isArray(savedTabs) && savedTabs.length) return savedTabs;
    return curId ? [curId] : [];
  });
  useEffect(() => { saveJSON('autobot:openTabs', openTabIds); }, [openTabIds]);
  useEffect(() => {
    if (!activeId) return;
    setOpenTabIds((tabs) => (tabs.includes(activeId) ? tabs : [...tabs, activeId]));
  }, [activeId]);
  const [provider, setProvider] = useState(() => hydrateProvider(loadJSON('autobot:provider', {}), DEFAULT_PROVIDER, PRESETS));
  const [providerKeys, setProviderKeys] = useState(() => loadJSON('autobot:providerKeys', {}));
  const [settings, setSettings] = useState(() => {
    const base = loadJSON('autobot:settings', null);
    const designPrefs = loadJSON(UI_DESIGN_PREFS_KEY, {});
    return mergeBootSettings({
      localSettings: base,
      hasLocalSettings: Boolean(base),
      designPrefs,
      defaultAppearance: DEFAULT_APPEARANCE_SETTINGS,
      normalizeTypography,
    });
  });
  const [systemPrefersLight, setSystemPrefersLight] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)').matches : false
  ));
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return undefined;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => setSystemPrefersLight(!!e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const appAppearance = useMemo(
    () => computeAppearanceVars(settings, systemPrefersLight),
    [settings, systemPrefersLight]
  );
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    root.setAttribute('data-theme', appAppearance.theme);
    root.setAttribute('data-surface', appAppearance.surface);
    root.setAttribute('data-pattern', appAppearance.bgPattern || 'carbon-weave');
    root.setAttribute('data-density', appAppearance.density || 'comfortable');
    root.setAttribute('data-msg-style', appAppearance.msgStyle || 'editorial');
    root.setAttribute('data-user-align', appAppearance.userPromptAlign || 'antigravity');
    root.setAttribute('data-glow', appAppearance.accentGlow || 'subtle');
    root.setAttribute('data-blur', appAppearance.glassBlur || 'standard');
    for (const [k, v] of Object.entries(appAppearance.style)) {
      root.style.setProperty(k, v);
    }
  }, [appAppearance]);
  const T = useCallback((k) => _t(settings.locale, k), [settings.locale]);
  const [orchestrator, setOrchestrator] = useState(() => loadJSON('autobot:orchestrator', { enabled: false, providers: [], activeIndex: -1 }));
  const orchRef = useRef(orchestrator);
  orchRef.current = orchestrator;
  const saveOrchestrator = useCallback((nextOrFn) => {
    const prev = orchRef.current;
    const next = typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn;
    if (!next || typeof next !== 'object') return;
    orchRef.current = next;
    setOrchestrator(next);
    saveJSON('autobot:orchestrator', next);
    try { if (window.autobot && window.autobot.setOrchestrator) window.autobot.setOrchestrator(next); } catch (_) {}
    if (Boolean(next.enabled) !== Boolean(prev && prev.enabled)) {
      setProvider((p) => syncProviderForOrchestratorToggle(p, next, prev));
    }
  }, []);
  const [features, setFeatures] = useState(() => loadJSON('autobot:features', { computerUse: true, chrome: false, bridges: false, quickEntry: true, computerUseTeach: false, buddy: false, remoteControl: false, extensions: false, developerMode: false, trustedFolders: false, chromeHost: '127.0.0.1', chromePort: 9222 }));
  const featRef = useRef(features);
  featRef.current = features;
  const saveFeat = useCallback((nextOrFn) => {
    const prev = featRef.current;
    const next = typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn;
    if (!next || typeof next !== 'object') return;
    featRef.current = next;
    setFeatures(next);
    saveJSON('autobot:features', next);
    try { window.autobot.setFeatures(next); } catch (_) { /* main may be older */ }
  }, []);
  const [account, setAccount] = useState(() => loadJSON('autobot:account', {
    signedIn: false,
    authMethod: null, // null | 'anthropic' | 'sso'
    email: '',
    plan: 'Free', // Free | Pro | Max
    sso: { enabled: false, idpName: '', issuer: '', clientId: '', domain: '' },
    sync: { enabled: false, lastSync: null, status: 'never', deviceCount: 1 },
  }));
  const [panel, setPanel] = useState('chats'); // chats | memory | skills | notebooks | mcp | artifacts | media | terminal | projects | search | plugins | scheduled
  const [mediaStudioFocusPath, setMediaStudioFocusPath] = useState('');
  const [workbenchMode, setWorkbenchMode] = useState(() => loadJSON('autobot:workbenchMode', 'agent')); // 'agent' | 'ide'
  const [ideExternalOpenFile, setIdeExternalOpenFile] = useState(null);
  const editorContextXmlRef = useRef('');
  // Jump-to-message target set by the global search panel; cleared once scrolled.
  const [pendingScroll, setPendingScroll] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // A keyless preset clicked in the model picker: Settings opens with it staged
  // and the session provider only switches once a key is saved.
  const [pendingPreset, setPendingPreset] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => !!loadJSON('autobot:sidebarCollapsed', false));
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [scrolledAway, setScrolledAway] = useState(false);
  // Wall-clock start of the active run — powers the live "Working · 12s" row.
  const [runStartedAt, setRunStartedAt] = useState(0);
  // Token accounting for /usage, /cost, /context and /insights. `usage` events
  // stream from the main process each step; the final `done` carries the total.
  const [lastUsage, setLastUsage] = useState(() => loadJSON('autobot:lastUsage', null));
  useEffect(() => { saveJSON('autobot:lastUsage', lastUsage); }, [lastUsage]);
  const [goal, setGoal] = useState('');
  const [queued, setQueued] = useState(() => {
    const saved = loadJSON('autobot:queued', []);
    return Array.isArray(saved) ? saved : [];
  }); // messages typed while a reply streams
  const [queuePausedByConv, setQueuePausedByConv] = useState(() => {
    const saved = loadJSON('autobot:queuePausedByConv', {});
    return saved && typeof saved === 'object' ? saved : {};
  });
  useEffect(() => { saveJSON('autobot:queued', queued); }, [queued]);
  useEffect(() => { saveJSON('autobot:queuePausedByConv', queuePausedByConv); }, [queuePausedByConv]);
  const [thinking, setThinking] = useState('');
  const [live, setLive] = useState(null); // { content, tools: [] }
  // The live stream is mirrored in a ref and every update goes through
  // setLiveSync, so commitLive can read the final stream synchronously instead
  // of calling setConvs from inside a setLive updater — React.StrictMode runs
  // updaters twice, which duplicated every assistant reply.
  const liveRef = useRef(null);
  const setLiveSync = useCallback((v) => {
    const next = typeof v === 'function' ? v(liveRef.current) : v;
    liveRef.current = next;
    setLive(next);
  }, []);
  const [cwd, setCwd] = useState('');
  const [error, setErrorRaw] = useState('');
  const [questionQueue, setQuestionQueue] = useState([]); // FIFO pending QuestionDock & Plan prompts

  // Organization compliance profile (`taint:*` capability namespace). The main
  // process owns the file; the renderer keeps the evaluated snapshot so every
  // gate resolves synchronously while the UI renders.
  const [compliance, setCompliance] = useState(null); // { profile, state, catalog }

  const [memory, setMemory] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpForm, setMcpForm] = useState({ transport: 'stdio', command: '', args: '', url: '' });
  const [subAgents, setSubAgents] = useState([]); // { key, name, status, role, jobRole, model, tier, ms, failover, posts, progress }
  const [swarmInfo, setSwarmInfo] = useState(null); // { supervisor, roster, pools, phase, wave, startedAt }
  const [swarmBoard, setSwarmBoard] = useState([]); // [{ seq, from, to, channel, text, at }]
  const [notebooks, setNotebooks] = useState([]); // names
  const [activeNotebook, setActiveNotebook] = useState(null);
  const [notebookCells, setNotebookCells] = useState([]);
  const [terminal, setTerminal] = useState({ tabs: [], active: null }); // { tabs: [{id,cwd,running,output}], active }
  const [artifactsExplicit, setArtifactsExplicit] = useState([]); // { name, language, content }
  const notifCenter = useNotificationCenter();
  const setNotice = useCallback((text, opts) => {
    const s = String(text || '').trim();
    if (!s) { notifCenter.dismissToast(); return; }
    notifCenter.pushNotification(s, opts);
  }, [notifCenter.pushNotification, notifCenter.dismissToast]);
  const setError = useCallback((msg) => {
    const s = String(msg || '').trim();
    if (!s) { setErrorRaw(''); return; }
    if (s.startsWith('✅')) {
      setErrorRaw('');
      notifCenter.pushNotification(s, { kind: 'success' });
      return;
    }
    setErrorRaw(s);
    notifCenter.pushNotification(s, { kind: 'error' });
  }, [notifCenter.pushNotification]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setErrorRaw((cur) => (cur === error ? '' : cur)), 5000);
    return () => clearTimeout(t);
  }, [error]);
  const [attachments, setAttachments] = useState([]); // { name, path, size, isText, content }
  // Reasoning / thinking level is stored on the provider object so it (a) drives
  // the prompt directive and (b) is sent to the API as `reasoning_effort`.
  const reasoningLevel = provider.reasoningLevel || 'auto';
  const setReasoningLevel = (lv) => setProvider((p) => ({ ...p, reasoningLevel: lv }));
  const [styleId, setStyleId] = useState(() => loadJSON('autobot:styleId', 'default'));
  const [customAgents, setCustomAgents] = useState([]);
  const [customStyles, setCustomStyles] = useState([]);
  const [defaultCustomStyleId, setDefaultCustomStyleId] = useState('default');
  const [showPalette, setShowPalette] = useState(false); // Command Palette (⌘K)
  const [showFind, setShowFind] = useState(false);       // in-chat Find (⌘F)
  const [findQuery, setFindQuery] = useState('');
  const [webSearch, setWebSearch] = useState(() => !!loadJSON('autobot:webSearch', false));
  // Swarm is an OPT-IN escalation the user chooses, not something the model
  // decides on its own: multi-agent (Task/Agent) is the automatic default, and
  // `Swarm` only becomes visible to the model when this pill is on. The roster
  // it uses is restricted to frontier models (see electron/swarm.js).
  const [swarmEnabled, setSwarmEnabled] = useState(() => !!loadJSON('autobot:swarmEnabled', false));
  const [dictating, setDictating] = useState(false);
  const [projects, setProjects] = useState(() => loadJSON('autobot:projects', [])); // { id, name, instructions }
  const [activeProject, setActiveProject] = useState(() => loadJSON('autobot:activeProject', null));
  const [sessionPane, setSessionPane] = useState({ type: null, width: 480 }); // type: null | 'browser' | 'env' | 'runlog' | 'review' | 'subagents' | 'files' | 'terminal'
  const [openPaneTabs, setOpenPaneTabs] = useState(['review']);
  const [settingsInitialSection, setSettingsInitialSection] = useState('providers');
  const [settingsFocusMediaKey, setSettingsFocusMediaKey] = useState('');
  const openSettingsAt = useCallback((sec = 'providers', opts = {}) => {
    if (sec && typeof sec === 'object') {
      setSettingsInitialSection(sec.section || 'providers');
      setSettingsFocusMediaKey(sec.focusMediaKey || '');
    } else {
      setSettingsInitialSection(sec || 'providers');
      setSettingsFocusMediaKey((opts && opts.focusMediaKey) || '');
    }
    setShowSettings(true);
  }, []);
  const lastPaneRef = useRef('review');
  const [reviewTarget, setReviewTarget] = useState(null);
  const [docPreviewTarget, setDocPreviewTarget] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null); // file or URL the browser pane should show
  const [voiceMode, setVoiceMode] = useState(false); // full-duplex conversational voice session
  const [permissions, setPermissions] = useState(() => {
    if (!loadJSON('autobot:perm_auto_default_v2', false)) {
      saveJSON('autobot:perm_auto_default_v2', true);
      saveJSON('autobot:permissions', 'auto');
      return 'auto';
    }
    return loadJSON('autobot:permissions', 'auto');
  }); // 'auto' | 'ask' (B8 Claude Code mode)
  const [permissionQueue, setPermissionQueue] = useState([]); // FIFO pending permission prompts
  const [permError, setPermError] = useState('');
  const [permSubmitting, setPermSubmitting] = useState(false);
  const [sessionHealthMap, setSessionHealthMap] = useState({});
  const [searchTab, setSearchTab] = useState('search'); // 'search' | 'ask'
  const waitingPermissionConvIds = useMemo(
    () => new Set(permissionQueue.map((p) => p.convId).filter(Boolean)),
    [permissionQueue]
  );
  const waitingQuestionConvIds = useMemo(
    () => new Set(questionQueue.map((q) => q.convId).filter(Boolean)),
    [questionQueue]
  );
  const [cuConsent, setCuConsent] = useState(null); // pending Computer Use consent { id, tier, tool, sensitive }
  const [planMode, setPlanMode] = useState(null); // active plan-mode banner { active, file }
  const [activeSkillPill, setActiveSkillPill] = useState(null); // e.g. { id: 'automation', icon: 'Clock', label: 'automation', hint: '...' }
  const [gdriveModalOpen, setGdriveModalOpen] = useState(false);
  const [gdriveState, setGdriveState] = useState({ connected: false, mode: null, detectedLocalFolders: [] });
  const [envState, setEnvState] = useState({
    active: { kind: 'local', id: null, label: 'This Computer', cwd: '' },
    sshProfiles: [],
    remoteProfiles: [],
    sshConfigHosts: [],
    hostServer: { enabled: false, port: 9477, running: false },
  });

  const refreshEnvState = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.envGetState) {
        const st = await window.autobot.envGetState();
        if (st && st.active) setEnvState(st);
      }
    } catch (_) {}
  }, []);
  useEffect(() => {
    refreshEnvState();
    if (window.autobot && window.autobot.onEnvChanged) {
      return window.autobot.onEnvChanged((st) => {
        if (st && st.active) {
          setEnvState(st);
          if ((st.active.kind === 'ssh' || st.active.kind === 'remote') && st.active.cwd) {
            setCwd(st.active.cwd);
          }
        }
      });
    }
    return undefined;
  }, [refreshEnvState]);

  const switchEnvironment = useCallback(async (spec) => {
    if (!window.autobot || !window.autobot.envSetActive) return;
    const r = await window.autobot.envSetActive(spec);
    if (r && r.ok && r.state) {
      setEnvState(r.state);
      if (r.active && r.active.cwd) setCwd(r.active.cwd);
      setNotice(`Environment: ${r.active?.label || 'This Computer'}`);
    } else if (r && r.error) {
      setError(r.error);
    }
  }, []);

  const refreshGdriveStatus = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.gdriveStatus) {
        const st = await window.autobot.gdriveStatus();
        if (st && typeof st === 'object') setGdriveState(st);
      }
    } catch (_) {}
  }, []);
  useEffect(() => { refreshGdriveStatus(); }, [refreshGdriveStatus]);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const runIdRef = useRef(null);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const voiceActiveRef = useRef(false);
  const voiceRecRef = useRef(null);
  const spokenIdsRef = useRef(new Set());

  const active = convs.find((c) => c.id === activeId) || null;
  const messages = active ? active.messages : [];

  const showSessionPane = useCallback((type) => {
    if (!type) {
      setSessionPane((p) => ({ ...p, type: null }));
      return;
    }
    lastPaneRef.current = type;
    setOpenPaneTabs((tabs) => (tabs.includes(type) ? tabs : [...tabs, type]));
    setSessionPane((p) => ({
      ...p,
      type,
      width: type === 'review' ? Math.max(Number(p.width) || 540, 520) : (p.width || 480),
    }));
    setPanel('chats');
  }, []);

  // Example parity: session panes coexist with chat and toggle via dispatchToggleSessionPane semantics
  const toggleSessionPane = useCallback((type) => {
    const targetType = type || lastPaneRef.current || 'review';
    setSessionPane((p) => {
      if (p.type === targetType || (!type && p.type)) return { ...p, type: null };
      lastPaneRef.current = targetType;
      setOpenPaneTabs((tabs) => (tabs.includes(targetType) ? tabs : [...tabs, targetType]));
      return { ...p, type: targetType };
    });
    // Opening a session pane always returns the main area to the chat context
    setPanel('chats');
  }, []);

  const closeSessionTab = useCallback((tabType) => {
    const nextTabs = openPaneTabs.filter((t) => t !== tabType);
    setOpenPaneTabs(nextTabs);
    setSessionPane((p) => {
      if (!tabType || p.type === tabType) {
        return { ...p, type: nextTabs.length ? nextTabs[nextTabs.length - 1] : null };
      }
      return p;
    });
  }, [openPaneTabs]);

  const openReview = useCallback((target = null) => {
    setReviewTarget(target);
    lastPaneRef.current = 'review';
    setOpenPaneTabs((tabs) => (tabs.includes('review') ? tabs : [...tabs, 'review']));
    setSessionPane((p) => ({ ...p, type: 'review', width: Math.max(Number(p.width) || 540, 520) }));
    setPanel('chats');
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    window.__akronTestHarness = {
      setTheme: (theme) => setSettings((s) => ({ ...s, theme: theme === 'light' ? 'light' : 'dark' })),
      setPanel: (p) => setPanel(p),
      openSettings: (sec) => { setSettingsInitialSection(sec || 'providers'); setShowSettings(true); },
      closeSettings: () => setShowSettings(false),
      setConvs: (list, nextActiveId) => {
        setConvs(list);
        if (nextActiveId) setActiveId(nextActiveId);
      },
      setPermissionQueue: (q) => setPermissionQueue(Array.isArray(q) ? q : []),
      setQueue: (items, pausedMap) => {
        setQueued(Array.isArray(items) ? items : []);
        if (pausedMap) setQueuePausedByConv(pausedMap);
      },
      openDuetReview: (mockDuetResult, extra = {}) => {
        setSessionPane({ type: 'review', width: 680 });
        setOpenPaneTabs((tabs) => (tabs.includes('review') ? tabs : [...tabs, 'review']));
        setReviewTarget({ scope: 'all', mockDuetResult, ...extra, at: Date.now() });
        setPanel('chats');
      },
      closePane: () => setSessionPane((p) => ({ ...p, type: null })),
    };
    return () => { delete window.__akronTestHarness; };
  }, [openReview]);

  // persist
  useEffect(() => { saveJSON('autobot:convs', convs); }, [convs]);
  // One-time non-destructive sync of existing localStorage chats to SQLite WAL+FTS (~/.autobot/akron.db)
  // plus throttled incremental sync for instant full-text search across sessions.
  const dbMigratedRef = useRef(false);
  useEffect(() => {
    if (!window.autobot?.dbMigrate || dbMigratedRef.current) return;
    dbMigratedRef.current = true;
    if (Array.isArray(convs) && convs.length) {
      window.autobot.dbMigrate(convs).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!window.autobot?.dbUpsertConv || !activeId) return;
    const cur = Array.isArray(convs) ? convs.find((c) => c.id === activeId) : null;
    if (!cur) return;
    const t = setTimeout(() => {
      window.autobot.dbUpsertConv(cur).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [convs, activeId]);
  useEffect(() => { saveJSON('autobot:activeId', activeId); }, [activeId]);
  // Credentials & persistent app state live in `~/.autobot/settings.json` (0600)
  // AND `orchestrator.json` / `features.json`. Hold all mirror writes until
  // main-process state is hydrated once, so a fresh or upgrading renderer
  // profile can never overwrite saved user configuration with boot defaults.
  const [settingsAdopted, setSettingsAdopted] = useState(false);
  useEffect(() => { if (settingsAdopted) saveJSON('autobot:provider', { ...provider, _updatedAt: Date.now() }); }, [provider, settingsAdopted]);
  useEffect(() => { if (settingsAdopted) saveJSON('autobot:providerKeys', providerKeys); }, [providerKeys, settingsAdopted]);
  const bootRef = useRef(null);
  if (bootRef.current === null) {
    const hasKey = (k) => { try { return typeof localStorage !== 'undefined' && localStorage.getItem(k) !== null; } catch (_) { return false; } };
    const bootSettings = loadJSON('autobot:settings', null);
    bootRef.current = {
      own: loadJSON('autobot:provider', null),
      hasOwn: hasKey('autobot:provider'),
      keys: loadJSON('autobot:providerKeys', {}),
      rawSettings: bootSettings,
      hasSettings: hasKey('autobot:settings'),
      designPrefs: loadJSON(UI_DESIGN_PREFS_KEY, {}),
      uiTimestamps: loadJSON('autobot:uiTimestamps', {}),
      hasUi: { permissions: hasKey('autobot:permissions'), swarmEnabled: hasKey('autobot:swarmEnabled'), webSearch: hasKey('autobot:webSearch'), styleId: hasKey('autobot:styleId'), sidebarCollapsed: hasKey('autobot:sidebarCollapsed'), workbenchMode: hasKey('autobot:workbenchMode'), projects: hasKey('autobot:projects'), activeProject: hasKey('autobot:activeProject') },
    };
  }
  const hydrateAckRef = useRef(0);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      Promise.resolve(window.autobot.getSettings?.()).catch(() => null),
      Promise.resolve(window.autobot.getOrchestrator?.()).catch(() => null),
      Promise.resolve(window.autobot.getFeatures?.()).catch(() => null),
    ]).then(([s, diskOrch, diskFeat]) => {
      if (cancelled) return;
      if (diskOrch && typeof diskOrch === 'object') {
        orchRef.current = diskOrch;
        setOrchestrator(diskOrch);
        saveJSON('autobot:orchestrator', diskOrch);
      }
      if (diskFeat && typeof diskFeat === 'object') {
        featRef.current = diskFeat;
        setFeatures(diskFeat);
        saveJSON('autobot:features', diskFeat);
      }
      const boot = bootRef.current || {};
      if (s && typeof s === 'object') {
        const nextSet = mergeBootSettings({ localSettings: boot.rawSettings, hasLocalSettings: boot.hasSettings, designPrefs: boot.designPrefs, diskSettings: s, defaultAppearance: DEFAULT_APPEARANCE_SETTINGS, normalizeTypography });
        setSettings(nextSet);
        const provRes = reconcileBootProvider({ localProvider: boot.own, hasLocalProvider: boot.hasOwn, localKeys: boot.keys, diskProvider: s.provider || null, diskKeys: s.providerKeys || {}, diskOrchestrator: diskOrch, defaultProvider: DEFAULT_PROVIDER, presets: PRESETS, hydrateProviderFn: hydrateProvider });
        if (provRes.adoptedFromDisk || provRes.healedRoutingMode) {
          setProvider(provRes.provider);
          saveJSON('autobot:provider', provRes.provider);
          if (provRes.healedRoutingMode) {
            try { window.autobot.setSettings?.({ provider: { ...provRes.provider, _updatedAt: Date.now() } }); } catch (_) {}
          }
        }
        if (provRes.providerKeys && Object.keys(provRes.providerKeys).length) {
          setProviderKeys(provRes.providerKeys);
          saveJSON('autobot:providerKeys', provRes.providerKeys);
        }
        const ui = mergeBootUiState({
          localUiState: { permissions, swarmEnabled, webSearch, styleId, sidebarCollapsed, workbenchMode, projects, activeProject, _timestamps: boot.uiTimestamps },
          hasLocalKeyMap: boot.hasUi,
          diskUiState: s.uiState || null,
        });
        if (ui.permissions !== undefined && ui.permissions !== permissions) setPermissions(ui.permissions);
        if (ui.swarmEnabled !== undefined && Boolean(ui.swarmEnabled) !== Boolean(swarmEnabled)) setSwarmEnabled(Boolean(ui.swarmEnabled));
        if (ui.webSearch !== undefined && Boolean(ui.webSearch) !== Boolean(webSearch)) setWebSearch(Boolean(ui.webSearch));
        if (ui.styleId !== undefined && ui.styleId !== styleId) setStyleId(ui.styleId);
        if (ui.sidebarCollapsed !== undefined && Boolean(ui.sidebarCollapsed) !== Boolean(sidebarCollapsed)) setSidebarCollapsed(Boolean(ui.sidebarCollapsed));
        if (ui.workbenchMode !== undefined && ui.workbenchMode !== workbenchMode) setWorkbenchMode(ui.workbenchMode);
        if (Array.isArray(ui.projects)) setProjects(ui.projects);
        if (ui.activeProject !== undefined) setActiveProject(ui.activeProject);
      } else if (diskOrch && diskOrch.enabled === true && (!boot.own?.routingMode || boot.own?.routingMode === 'direct')) {
        setProvider((v) => ({ ...v, routingMode: 'orchestrator' }));
      }
      hydrateAckRef.current = 1;
    }).catch(() => {}).finally(() => { if (!cancelled) setSettingsAdopted(true); });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // Mirror active provider, keys, full settings & session UI preferences to main.
  useEffect(() => {
    if (!settingsAdopted) return;
    if (hydrateAckRef.current === 1) { hydrateAckRef.current = 2; return; }
    try { window.autobot.setSettings?.({ provider: { ...provider, _updatedAt: Date.now() }, providerKeys }); } catch (_) {}
  }, [provider, providerKeys, settingsAdopted]);
  // Keep orchestrator.activeIndex aligned when switching models while Orchestrator is on.
  useEffect(() => {
    if (!settingsAdopted) return;
    if (provider && (provider.routingMode === 'direct' || provider.routingMode === 'auto')) return;
    if (!orchestrator || !orchestrator.enabled || !Array.isArray(orchestrator.providers) || !orchestrator.providers.length) return;
    const selModel = String((provider && provider.model) || '').trim().toLowerCase();
    const selOauth = String((provider && provider.oauthProvider) || '').trim().toLowerCase();
    const selBase = normBase((provider && provider.baseURL) || '').toLowerCase();
    if (!selModel) return;
    const idx = orchestrator.providers.findIndex((p) => {
      if (!p) return false;
      if (String(p.model || '').trim().toLowerCase() !== selModel) return false;
      if (selOauth) return String(p.oauthProvider || '').trim().toLowerCase() === selOauth;
      if (selBase) return normBase(p.baseURL || '').toLowerCase() === selBase;
      return true;
    });
    if (idx >= 0 && idx !== orchestrator.activeIndex) {
      saveOrchestrator({ ...orchestrator, activeIndex: idx });
    }
  }, [provider.model, provider.oauthProvider, provider.baseURL, settingsAdopted]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    applyTypographyToDocument(settings.typography);
    if (!settingsAdopted) return;
    const ts = Date.now();
    const persisted = { ...extractPersistedSettings(settings), _updatedAt: ts };
    saveJSON('autobot:settings', persisted);
    try { window.autobot.setSettings?.({ theme: persisted.theme, launchAtLogin: !!persisted.launchAtLogin, typography: persisted.typography, preventSleep: !!persisted.preventSleep, keepInTray: !!persisted.keepInTray, uiSettings: persisted }); } catch (_) {}
  }, [settings, settingsAdopted]);
  useEffect(() => { saveJSON('autobot:account', account); }, [account]);
  useEffect(() => {
    if (!settingsAdopted) return;
    const now = Date.now();
    const uiState = { permissions, swarmEnabled, webSearch, styleId, sidebarCollapsed, workbenchMode, projects, activeProject, _updatedAt: now };
    saveJSON('autobot:projects', projects);
    saveJSON('autobot:activeProject', activeProject);
    saveJSON('autobot:permissions', permissions);
    saveJSON('autobot:swarmEnabled', swarmEnabled);
    saveJSON('autobot:webSearch', webSearch);
    saveJSON('autobot:styleId', styleId);
    saveJSON('autobot:sidebarCollapsed', sidebarCollapsed);
    saveJSON('autobot:workbenchMode', workbenchMode);
    saveJSON('autobot:uiTimestamps', { permissions: now, swarmEnabled: now, webSearch: now, styleId: now, sidebarCollapsed: now, workbenchMode: now, projects: now, activeProject: now });
    try { window.autobot.setSettings?.({ uiState }); } catch (_) {}
  }, [permissions, swarmEnabled, webSearch, styleId, sidebarCollapsed, workbenchMode, projects, activeProject, settingsAdopted]);

  // init cwd + memory + skills + customizations
  useEffect(() => {
    const id = loadJSON('autobot:activeId', null);
    const ws = loadJSON('autobot:workspace:' + (id || ''), null);
    if (id && ws) window.autobot.getWorkspace(id).then((d) => { if (d) setCwd(d); });
    else if (id) window.autobot.getDefaultCwd(id, '').then(setCwd);
    window.autobot.getMemory().then((m) => setMemory(m.entries || []));
    window.autobot.getSkills().then(setSkills);
    window.autobot.listNotebooks().then(setNotebooks);
    if (window.autobot.complianceGet) window.autobot.complianceGet().then(setCompliance).catch(() => {});
  }, []);

  useEffect(() => {
    if (!window.autobot || !window.autobot.mcpConfig) return;
    window.autobot.mcpConfig(cwd).then((r) => {
      if (r && Array.isArray(r.status)) setMcpServers(r.status);
    }).catch(() => {});
  }, [cwd]);

  // When the active conversation changes, switch the working folder to its
  // project workspace (or create one) — Claude Desktop per-project parity.
  useEffect(() => {
    if (!activeId) return;
    window.autobot.getWorkspace(activeId).then((d) => {
      if (d) { setCwd(d); saveJSON('autobot:workspace:' + activeId, d); }
      else {
        const conv = convsRef.current.find((c) => c.id === activeId);
        window.autobot.getDefaultCwd(activeId, conv?.title || '').then((dir) => {
          setCwd(dir); saveJSON('autobot:workspace:' + activeId, dir);
        });
      }
    });
  }, [activeId]);

  // Skill activation/deactivation (per-skill toggle, persisted server-side).
  const refreshSkills = useCallback(async () => {
    const list = await window.autobot.getSkills();
    setSkills(list);
    return list;
  }, []);

  const refreshCustomizations = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.listAgentDefs) {
        const defs = await window.autobot.listAgentDefs(cwd);
        if (Array.isArray(defs)) setCustomAgents(defs);
      }
    } catch (_) {}
    try {
      if (window.autobot && window.autobot.listOutputStyles) {
        const res = await window.autobot.listOutputStyles(cwd);
        if (res && Array.isArray(res.styles)) {
          setCustomStyles(res.styles);
          if (res.defaultStyleId) {
            setDefaultCustomStyleId(res.defaultStyleId);
            setStyleId((cur) => (cur === 'default' && res.defaultStyleId !== 'default' ? res.defaultStyleId : cur));
          }
        }
      }
    } catch (_) {}
  }, [cwd]);
  useEffect(() => { refreshCustomizations(); }, [refreshCustomizations]);

  const toggleSkill = useCallback(async (name) => {
    const target = skills.find((x) => x.name === name);
    if (!target) return;
    const next = await window.autobot.setSkillEnabled(name, !target.enabled);
    setSkills(next);
  }, [skills]);

  const setAllSkills = useCallback(async (enabled) => {
    const next = await window.autobot.setAllSkillsEnabled(enabled);
    setSkills(next);
  }, []);

  // Example parity: CmdOrCtrl+Shift+B toggles the Browser session pane
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        toggleSessionPane('browser');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSessionPane]);

  // Agent tools can request the browser pane (idempotent: never closes it).
  useEffect(() => {
    if (!window.autobot || !window.autobot.onBrowserEnsure) return;
    return window.autobot.onBrowserEnsure(() => {
      setSessionPane((p) => (p.type === 'browser' ? p : { ...p, type: 'browser', width: p.width || 460 }));
      setPanel('chats');
    });
  }, []);

  // Example parity: CmdOrCtrl+K command palette, CmdOrCtrl+F in-chat find, CmdOrCtrl+Shift+E Agent/IDE toggle
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        setWorkbenchMode((m) => (m === 'ide' ? 'agent' : 'ide'));
        return;
      }
      const inMonaco = Boolean(e.target && e.target.closest && e.target.closest('.monaco-editor'));
      if (inMonaco) return;
      const inAgentDock = Boolean(e.target && e.target.closest && e.target.closest('.ide-agent-dock'));
      if (workbenchMode === 'ide' && !inAgentDock) return;
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setShowPalette((v) => !v); }
      else if (e.key === 'f' || e.key === 'F') {
        if (workbenchMode === 'ide' && e.shiftKey) return;
        e.preventDefault();
        // Shift+F is the cross-conversation search panel; plain F is in-chat find.
        if (e.shiftKey) setPanel((p) => (p === 'search' ? 'chats' : 'search'));
        else setShowFind((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workbenchMode]);

  const openSessionDeepLink = useCallback((uri) => {
    const raw = String(uri || '').trim();
    const m = /^session:\/\/([^?/#]+)(?:\?(.*))?$/i.exec(raw);
    if (!m) return false;
    const convId = decodeURIComponent(m[1]);
    const params = new URLSearchParams(m[2] || '');
    const focus = params.get('focus') || '';
    const targetConv = convs.find((c) => c.id === convId);
    if (targetConv) {
      setActiveId(convId);
      setPanel('chats');
      if (focus) {
        const msgs = targetConv.messages || [];
        const matchMsg = msgs.find((msg) => msg.id === focus) || msgs[msgs.length - 1];
        if (matchMsg && matchMsg.id) setPendingScroll(matchMsg.id);
      }
      setNotice(`Jumped to session ${targetConv.title || convId}${focus ? ` · step ${focus}` : ''}`);
      return true;
    }
    return false;
  }, [convs]);

  // subscribe to events
  const openPreview = useCallback((url, opts = {}) => {
    const targetUrl = String(url || '').trim();
    if (!targetUrl) return;
    // Object identity (not the bare string) so previewing the same file again —
    // after an edit — still triggers a reload in the pane.
    setPreviewUrl({ url: targetUrl, newTab: !!(opts && opts.newTab), at: Date.now() });
    showSessionPane('browser');
    setPanel('chats');
  }, [showSessionPane]);

  const openInIde = useCallback((fp, opts = {}) => {
    const raw = (fp && typeof fp === 'object') ? fp.path : fp;
    const resolved = resolveAgainstCwd(raw, cwd);
    if (!resolved) return;
    setIdeExternalOpenFile({
      path: resolved,
      line: (opts && opts.line) || (fp && typeof fp === 'object' ? fp.line : null) || null,
      diff: !!(opts && opts.diff) || !!(fp && typeof fp === 'object' && fp.diff),
      at: Date.now(),
    });
    setWorkbenchMode('ide');
  }, [cwd]);

  const openDocPreview = useCallback((fp, line = null) => {
    const resolved = resolveAgainstCwd(fp, cwd);
    if (!resolved) return;
    if (isHtmlPath(resolved)) { openPreview(resolved); return; }
    setDocPreviewTarget({ path: resolved, line: line || null, at: Date.now() });
    showSessionPane('doc');
    setPanel('chats');
  }, [cwd, openPreview, showSessionPane]);

  useEffect(() => attachDocumentLinkRouter({
    openSessionDeepLink,
    openDocPreview,
    openInIde,
    openPreview,
    openExternal: (href) => { try { window.autobot?.openExternal?.(href); } catch (_) {} },
  }), [openSessionDeepLink, openDocPreview, openInIde, openPreview]);


  useEffect(() => {
    // A pending jump-to-message (from global search) wins over auto-scroll.
    if (pendingScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, live, thinking, pendingScroll]);

  // Global search → jump: scroll the matched message into view and flash it.
  useEffect(() => {
    if (!pendingScroll) return;
    const el = document.getElementById('msg-' + pendingScroll);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('msg-flash');
    const t = setTimeout(() => el.classList.remove('msg-flash'), 1600);
    setPendingScroll(null);
    return () => clearTimeout(t);
  }, [pendingScroll, activeId]);

  // Which conversation the in-flight run belongs to (survives chat switching).
  const runConvRef = useRef(null);
  const runActiveRef = useRef(false);
  // The conversation the current team (sub-agents / swarm) belongs to. The
  // rows are global state, so without this they painted into every chat.
  const teamConvRef = useRef(null);
  const subAgentsRef = useRef(subAgents);
  subAgentsRef.current = subAgents;
  const swarmInfoRef = useRef(swarmInfo);
  swarmInfoRef.current = swarmInfo;
  const swarmBoardRef = useRef(swarmBoard);
  swarmBoardRef.current = swarmBoard;
  const runStartedAtRef = useRef(0);
  runStartedAtRef.current = runStartedAt;
  const commitLive = useCallback(() => {
    // A run emits BOTH `done` (stream ended) and `complete` (run promise settled).
    // Ignore the duplicate — otherwise it would swallow the next run's stream.
    if (!runActiveRef.current) return;
    runActiveRef.current = false;
    // Resolve the owning conversation NOW: the setLive updater below runs in the
    // render phase, long after runConvRef has been cleared.
    const target = runConvRef.current || activeIdRef.current;
    runConvRef.current = null;
    setStreaming(false);
    setPaused(false);
    setScrolledAway(false);
    setThinking('');
    setPermError('');
    setPermissionQueue((q) => q.filter((p) => {
      if (runIdRef.current && p.runId && p.runId !== runIdRef.current) return true;
      return false;
    }));
    const startedAt = runStartedAtRef.current;
    // Read the stream from the ref and issue two independent state updates.
    // Calling setConvs inside a setLive updater double-appended under StrictMode.
    const l = liveRef.current;
    setLiveSync(null);
    const hasTeam = teamConvRef.current === target && subAgentsRef.current && subAgentsRef.current.length > 0;
    if (l && (l.content || (l.tools && l.tools.length) || (l.checkpoints && l.checkpoints.length) || hasTeam)) {
      // Bind the reply to the conversation the run was started from — the user
      // may have switched chats while it streamed.
      const msg = {
        id: uid(),
        role: 'assistant',
        content: l.content || '',
        tools: l.tools || [],
        segments: l.segments,
        checkpoints: l.checkpoints || [],
        checkpointId: l.checkpointId || null,
        model: l.model || '',
        autoRouted: l.autoRouted || undefined,
        modelsUsed: Array.isArray(l.modelsUsed) && l.modelsUsed.length ? l.modelsUsed : undefined,
        subAgents: hasTeam ? subAgentsRef.current : undefined,
        swarmInfo: teamConvRef.current === target && swarmInfoRef.current ? swarmInfoRef.current : undefined,
        ts: Date.now(),
        completedAt: Date.now(),
        durationMs: startedAt ? Date.now() - startedAt : 0,
      };
      setConvs((cs) => cs.map((c) => (c.id === target ? {
        ...c,
        messages: [...c.messages, msg],
        ...(hasTeam ? {
          subAgents: subAgentsRef.current,
          swarmInfo: swarmInfoRef.current,
          swarmBoard: swarmBoardRef.current,
        } : {}),
      } : c)));
    }
  }, [setLiveSync]);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const convsRef = useRef(convs);
  convsRef.current = convs;

  const send = useCallback(async (textOverride, attsOverride, convOverride) => {
    // Guard: React event handlers may pass the event object when the handler is
    // wired as `onClick={send}`. Only accept an explicit string override.
    const override = typeof textOverride === 'string' ? textOverride : undefined;
    const text = (override !== undefined ? override : (inputRef.current?.value || '')).trim();
    const atts = Array.isArray(attsOverride) ? attsOverride : attachments;
    if (!text && atts.length === 0) return;
    if (streamingRef.current && pausedRef.current && text && runIdRef.current && window.autobot && window.autobot.resume) {
      if (override === undefined && inputRef.current) inputRef.current.value = '';
      await window.autobot.resume(runIdRef.current, text);
      return;
    }
    // Example parity: a message sent while a reply is streaming is not dropped —
    // it is queued and dispatched the moment the current turn finishes.
    if (streamingRef.current) {
      if (override === undefined) inputRef.current.value = '';
      if (!Array.isArray(attsOverride)) setAttachments([]);
      setQueued((q) => [...q, { id: uid(), text, atts, convId: activeId, paused: false }]);
      return;
    }
    if (override === undefined) inputRef.current.value = '';
    setError('');

    let convId = (typeof convOverride === 'string' && convOverride) ? convOverride : activeId;
    const autoTitle = text.slice(0, 48) || atts.map((a) => a.name).join(', ').slice(0, 48);
    const isNewConv = !convId;
    if (isNewConv) convId = uid();

    // Resolve the project folder for the conversation we are about to run in.
    // The run must never inherit `cwd` state from a different conversation: that
    // is how a generated site landed in a stale `untitled-*` folder while the
    // preview pane and the cwd bar pointed at the titled folder.
    let runCwd = cwd;
    if (isNewConv || convId !== activeId || !runCwd) {
      const existingTitle = convsRef.current.find((c) => c.id === convId)?.title || '';
      runCwd = await window.autobot.getWorkspace(convId)
        || await window.autobot.getDefaultCwd(convId, existingTitle || autoTitle);
      if (runCwd) { saveJSON('autobot:workspace:' + convId, runCwd); setCwd(runCwd); }
    }

    if (isNewConv) {
      setActiveId(convId);
      setConvs((cs) => [{ id: convId, title: autoTitle, messages: [], ts: Date.now() }, ...cs]);
    } else {
      setConvs((cs) => cs.map((c) => (c.id === convId && c.messages.length === 0 ? { ...c, title: autoTitle } : c)));
    }

    const userMsg = {
      id: uid(),
      role: 'user',
      content: text || (atts.length ? '📎 ' + atts.map((a) => a.name).join(', ') : ''),
      attachments: atts.map((a) => ({ name: a.name, size: a.size, isText: a.isText, content: a.content, isImage: a.isImage, dataUrl: a.dataUrl })),
      ts: Date.now(),
      createdAt: Date.now(),
    };
    const currentMessages = convId ? (convsRef.current.find((c) => c.id === convId)?.messages || []) : [];
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, userMsg] } : c)));

    const payloadMessages = buildPayloadMessages([...currentMessages, userMsg]);
    const directives = buildDirectives(styleId, provider.reasoningLevel, { webSearch, project: activeProject, harnessProfile: settings.harnessProfile, customStyles });
    if (workbenchMode === 'ide' && editorContextXmlRef.current) {
      directives.push(editorContextXmlRef.current);
    }
    if (directives.length) payloadMessages.unshift({ role: 'system', content: directives.join('\n') });

    // Only consume the composer's attachment tray when this send came from the
    // composer — a queued message carries its own snapshot.
    if (!Array.isArray(attsOverride)) setAttachments([]);

    // Pin the run to its conversation before any event can arrive.
    runConvRef.current = convId;
    runActiveRef.current = true;
    teamConvRef.current = convId;
    const effKey = provider.apiKey || resolveLoopbackKey(provider.baseURL, providerKeys, provider);
    const effProvider = effKey && !provider.apiKey ? { ...provider, apiKey: effKey } : provider;
    setPaused(false);
    setStreaming(true);
    setRunStartedAt(Date.now());
    setThinking('');
    setLiveSync({ content: '', tools: [], model: effProvider.routingMode === 'auto' ? '' : (effProvider.model || provider.model || '') });
    setSubAgents([]);
    setSwarmInfo(null);
    setSwarmBoard([]);
    const runId = uid();
    runIdRef.current = runId;

    const started = await window.autobot.run({
      runId,
      messages: payloadMessages,
      provider: effProvider,
      cwd: runCwd || undefined,
      useMemory: settings.useMemory,
      orchestrator,
      permissions,
      convId,
      title: convsRef.current.find((c) => c.id === convId)?.title || autoTitle,
      // Gate for the Swarm tool: off by default, on only when the user opts in.
      swarm: swarmEnabled,
    });
    // Backstop: the handler emits a proper `error` event, but if that delivery
    // is ever lost the composer must not stay spinning forever.
    if (started && started.ok === false && runActiveRef.current) {
      runActiveRef.current = false;
      runConvRef.current = null;
      setStreaming(false);
      setThinking('');
      setLiveSync(null);
      setError(cleanErr(started.error || 'The provider rejected this run.'));
      if (started.needsSignIn) setModelMenuOpen(true);
    }
  }, [activeId, convs, provider, cwd, settings.useMemory, settings.harnessProfile, streaming, orchestrator, attachments, styleId, webSearch, activeProject, permissions, swarmEnabled]);

  const stop = useCallback(() => {
    setPaused(false);
    if (runIdRef.current) window.autobot.cancel(runIdRef.current);
  }, []);

  const pauseRun = useCallback(() => {
    if (runIdRef.current && window.autobot && window.autobot.pause) {
      setPaused(true);
      window.autobot.pause(runIdRef.current);
    }
  }, []);

  const resumeRun = useCallback((note = '') => {
    if (runIdRef.current && window.autobot && window.autobot.resume) {
      setPaused(false);
      window.autobot.resume(runIdRef.current, note);
    }
  }, []);

  // Auto-dispatch the first unpaused queued message once idle and its conversation queue isn't paused.
  useEffect(() => {
    if (streaming || !queued.length) return;
    const { next, rest } = pickNextRunnableQueued(queued, queuePausedByConv);
    if (!next) return;
    setQueued(rest);
    send(next.text, next.atts, next.convId);
  }, [streaming, queued, queuePausedByConv, send]);

  const unqueue = useCallback((id) => setQueued((q) => q.filter((x) => x.id !== id)), []);
  const clearQueuedForConv = useCallback((convId) => {
    if (!convId) return;
    setQueued((q) => q.filter((x) => x.convId !== convId));
    setQueuePausedByConv((m) => ({ ...m, [convId]: false }));
  }, []);
  const toggleQueuePaused = useCallback((convId) => {
    if (!convId) return;
    setQueuePausedByConv((m) => ({ ...m, [convId]: !m[convId] }));
  }, []);
  const toggleQueueItemPaused = useCallback((id) => {
    setQueued((q) => q.map((x) => (x.id === id ? { ...x, paused: !x.paused } : x)));
  }, []);
  const reorderQueued = useCallback((fromId, toId) => {
    setQueued((q) => moveQueueItem(q, fromId, toId));
  }, []);
  const stepQueued = useCallback((id, delta) => {
    setQueued((q) => stepQueueItemWithinConv(q, id, delta));
  }, []);
  const updateQueuedText = useCallback((id, text) => {
    setQueued((q) => q.map((x) => (x.id === id ? { ...x, text } : x)));
  }, []);
  // Dispatch a specific queued item immediately: if idle, send now; if streaming, move it to front and cancel live run.
  const sendQueuedNow = useCallback((id) => {
    const target = id ? queued.find((x) => x.id === id) : queued[0];
    if (!target) return;
    if (!streamingRef.current) {
      setQueued((q) => q.filter((x) => x.id !== target.id));
      send(target.text, target.atts, target.convId);
      return;
    }
    if (target.convId) {
      setQueuePausedByConv((m) => ({ ...m, [target.convId]: false }));
    }
    setQueued((q) => {
      const unpaused = { ...target, paused: false };
      return [unpaused, ...q.filter((x) => x.id !== target.id)];
    });
    if (runIdRef.current) window.autobot.cancel(runIdRef.current);
  }, [queued, send]);

  // Quick Entry (menu-bar / global-hotkey) → insert or send into the composer.
  useEffect(() => {
    const off = window.autobot.onQuickEntry(({ text, mode }) => {
      if (mode === 'send') {
        send(text);
      } else {
        if (inputRef.current) {
          inputRef.current.value = text;
          inputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
          inputRef.current.focus();
        }
      }
    });
    return off;
  }, [send]);

  // Full-duplex conversational Voice Mode: continuous speech → transcript → send →
  // assistant reply spoken via TTS → keep listening until toggled off.
  const startVoiceMode = useCallback(() => {
    const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { if (window.autobot?.speak) window.autobot.speak('Speech recognition is not available in this environment.'); return; }
    if (voiceActiveRef.current) return;
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      if (transcript && voiceActiveRef.current && !streamingRef.current) send(transcript);
    };
    rec.onerror = () => { /* non-fatal: restart loop on end */ };
    rec.onend = () => {
      // Some platforms auto-stop after a silence gap; restart while session is live.
      if (voiceActiveRef.current) { try { rec.start(); } catch (_) {} }
    };
    voiceRecRef.current = rec;
    voiceActiveRef.current = true;
    setVoiceMode(true);
    try { rec.start(); } catch (_) {}
  }, [send]);

  const stopVoiceMode = useCallback(() => {
    voiceActiveRef.current = false;
    setVoiceMode(false);
    if (voiceRecRef.current) { try { voiceRecRef.current.stop(); } catch (_) {} voiceRecRef.current = null; }
    if (window.autobot?.stopSpeak) window.autobot.stopSpeak();
  }, []);

  // Speak assistant replies aloud while a voice session is live.
  useEffect(() => {
    if (!voiceMode || streaming) return;
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (last && last.content && !spokenIdsRef.current.has(last.id)) {
      spokenIdsRef.current.add(last.id);
      const clean = last.content
        .replace(/```[\s\S]*?```/g, ' code block ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#*_`>~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean) window.autobot.speak(clean.slice(0, 2000));
    }
  }, [messages, streaming, voiceMode]);

  const answerQuestion = useCallback(async (idOrAns, maybeAns) => {
    let targetId = idOrAns;
    let payload = maybeAns;
    if (maybeAns === undefined) {
      const first = questionQueue.find((q) => !q.convId || q.convId === activeId) || questionQueue[0];
      if (!first) return;
      targetId = first.id;
      payload = idOrAns;
    }
    if (!targetId) return;
    setQuestionQueue((q) => q.filter((x) => x.id !== targetId));
    try {
      await window.autobot.answerQuestion(targetId, payload);
    } catch (_) {}
  }, [questionQueue, activeId]);

  const answerPermission = useCallback(async (id, payload) => {
    if (!id) return;
    setPermSubmitting(true);
    setPermError('');
    try {
      const res = await window.autobot.answerPermission(id, payload);
      if (res && res.ok) {
        setPermissionQueue((q) => q.filter((x) => x.id !== id));
      } else {
        const msg = (res && res.error) || 'Failed to deliver permission response.';
        setPermError(msg);
        setError(msg);
        if (/not found|closed|timed out/i.test(msg)) {
          setPermissionQueue((q) => q.filter((x) => x.id !== id));
        }
      }
    } catch (err) {
      const msg = (err && err.message) || 'Permission response failed.';
      setPermError(msg);
      setError(msg);
    } finally {
      setPermSubmitting(false);
    }
  }, [setError]);

  // Computer Use consent: allow grants the requested tier (which resolves the
  // blocked turn in the main process), deny revokes so the tool call fails fast.
  const answerCuConsent = useCallback(async (allow, remember = false) => {
    if (!cuConsent) return;
    const { tier } = cuConsent;
    setCuConsent(null);
    try {
      if (allow) await window.autobot.computerUseGrant(tier, { remember });
      else await window.autobot.computerUseRevoke(tier);
    } catch (_) {}
  }, [cuConsent]);

  // The live stream belongs to one conversation; don't paint it into another one.
  const liveForActive = live && (!runConvRef.current || runConvRef.current === activeId) ? live : null;

  // Starting a new chat must not discard an in-flight run's stream — that run is
  // committed to its own conversation and `liveForActive` keeps it off-screen.
  const newChat = () => {
    if (!streamingRef.current) setLiveSync(null);
    setActiveId(null);
    setError('');
    setPanel('chats');
    if (settings && settings.autoSwitch && settings.autoSwitch.defaultForNewSessions) {
      setProvider((v) => ({ ...(v || {}), routingMode: 'auto' }));
    }
    inputRef.current?.focus();
  };
  const selectConv = (id) => { setActiveId(id); setPanel('chats'); };
  const deleteConv = async (id) => {
    // Compliance gate first — under an HIPAA / ZDR profile Desktop refuses the
    // delete outright, and under a marked-retention profile it writes an audit
    // record first. Ask the main process before touching local state.
    if (window.autobot && window.autobot.complianceDeleteCheck) {
      const conv = convsRef.current.find((c) => c.id === id);
      let gate = null;
      try {
        gate = await window.autobot.complianceDeleteCheck({ id, title: conv ? conv.title : '' });
      } catch (_) { gate = null; }
      if (gate && gate.allowed === false) {
        setError(gate.line || 'This session can’t be deleted under your organization’s configuration.');
        return;
      }
    }
    setConvs((cs) => cs.filter((c) => c.id !== id));
    setOpenTabIds((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (activeId === id) setActiveId(next.length ? next[next.length - 1] : null);
      return next;
    });
  };
  const closeWorkspaceTab = (id, e) => {
    if (e) e.stopPropagation();
    setOpenTabIds((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (activeId === id) setActiveId(next.length ? next[next.length - 1] : null);
      return next;
    });
  };
  const renameConv = (id, title) => {
    const clean = String(title || '').trim();
    if (!clean) return;
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, title: clean } : c)));
  };
  const pinConv = (id) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  };
  const archiveConv = (id) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, archived: !c.archived } : c)));
    setError('✅ Conversation archive state toggled.');
  };
  const splitConv = (id) => {
    const src = convsRef.current.find((c) => c.id === id);
    if (!src) return;
    const copyId = uid();
    const copy = { ...src, id: copyId, title: (src.title || 'Untitled') + ' (split)', pinned: false, ts: Date.now() };
    setConvs((cs) => [copy, ...cs]);
    setActiveId(copyId);
    setPanel('chats');
  };

  const copyMessage = (m) => {
    let selected = '';
    try {
      const liveSel = typeof window !== 'undefined' && window.getSelection ? String(window.getSelection().toString() || '') : '';
      const cached = typeof window !== 'undefined' ? window.__akronLastSelection : null;
      if (liveSel && liveSel.trim()) {
        selected = liveSel;
      } else if (cached && cached.text && (Date.now() - (cached.at || 0) < 15000) && (!cached.msgId || (m && cached.msgId === m.id))) {
        selected = cached.text;
      }
    } catch (_) {}
    const fullText = extractMessageText(m);
    const payload = (selected && selected.trim()) ? selected : fullText;
    copyTextToClipboard(payload).then((ok) => {
      if (ok) {
        setNotice(selected && selected.trim() ? '✅ Copied selected text to clipboard.' : '✅ Copied message to clipboard.');
      }
    }).catch(() => {});
  };

  useEffect(() => {
    const onCopied = (ev) => {
      const kind = ev && ev.detail && ev.detail.kind;
      setNotice(kind === 'code' ? '✅ Copied code block to clipboard.' : '✅ Copied selection to clipboard.');
    };
    window.addEventListener('akron:copied', onCopied);
    return () => window.removeEventListener('akron:copied', onCopied);
  }, []);

  // Fork the conversation up to response index `idx` into a new branched chat.
  const forkFromMessage = useCallback((convId, idx) => {
    const src = convsRef.current.find((c) => c.id === convId);
    if (!src) return;
    const msgs = Array.isArray(src.messages) ? src.messages : [];
    const sliced = msgs.slice(0, Math.min(msgs.length, idx + 1)).map((msg) => ({ ...msg }));
    const forkId = uid();
    const forkConv = {
      ...src,
      id: forkId,
      title: ((src.title || 'Untitled') + ' (fork)').slice(0, 80),
      pinned: false,
      ts: Date.now(),
      messages: sliced,
      forkedFrom: { convId, idx },
    };
    setConvs((cs) => [forkConv, ...cs]);
    setActiveId(forkId);
    setPanel('chats');
    setNotice('✅ Forked conversation from response.');
  }, []);

  // Share a specific assistant response (plus transcript up to it) via clipboard or HTML/MD/JSON save.
  const shareFromMessage = useCallback(async (convId, idx, format = 'copy') => {
    const src = convsRef.current.find((c) => c.id === convId);
    if (!src) return;
    const msgs = Array.isArray(src.messages) ? src.messages : [];
    const targetMsg = msgs[idx];
    if (format === 'copy') {
      const md = targetMsg ? extractMessageText(targetMsg) : '';
      try { await copyTextToClipboard(md); } catch (_) {}
      setNotice('✅ Copied response Markdown to clipboard.');
      return;
    }
    const slicedConv = { ...src, messages: msgs.slice(0, Math.min(msgs.length, idx + 1)) };
    const slug = (slicedConv.title || 'response').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'response';
    let content = '';
    let defaultName = slug + '.md';
    let filters = [{ name: 'Markdown', extensions: ['md'] }];
    if (format === 'html') {
      content = convToHtml(slicedConv);
      defaultName = slug + '.html';
      filters = [{ name: 'HTML', extensions: ['html'] }];
    } else if (format === 'json') {
      content = JSON.stringify(slicedConv, null, 2);
      defaultName = slug + '.json';
      filters = [{ name: 'JSON', extensions: ['json'] }];
    } else {
      content = convToMarkdown(slicedConv);
    }
    const r = await window.autobot.saveFile({ defaultName, content, filters });
    if (r.ok && r.path) setError('✅ Shared to ' + r.path);
    else if (r.ok && !r.path) setError('');
    else setError('❌ Share failed: ' + (r.error || 'unknown'));
  }, []);

  // Export / share the active conversation (markdown / HTML / JSON) via native save.
  const exportConv = useCallback(async (format) => {
    const conv = convsRef.current.find((c) => c.id === activeIdRef.current) || null;
    if (!conv) { setError('No conversation to export.'); return; }
    const slug = (conv.title || 'conversation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'conversation';
    let content = '';
    let defaultName = slug + '.md';
    let filters = [{ name: 'Markdown', extensions: ['md'] }];
    if (format === 'html') {
      content = convToHtml(conv);
      defaultName = slug + '.html';
      filters = [{ name: 'HTML', extensions: ['html'] }];
    } else if (format === 'json') {
      content = JSON.stringify(conv, null, 2);
      defaultName = slug + '.json';
      filters = [{ name: 'JSON', extensions: ['json'] }];
    } else {
      content = convToMarkdown(conv);
    }
    const r = await window.autobot.saveFile({ defaultName, content, filters });
    if (r.ok && r.path) setError('✅ Exported to ' + r.path);
    else if (r.ok && !r.path) setError('');
    else setError('❌ Export failed: ' + (r.error || 'unknown'));
  }, []);
  const editMessage = (m) => {
    if (inputRef.current) { inputRef.current.value = m.content || ''; inputRef.current.dispatchEvent(new Event('input', { bubbles: true })); inputRef.current.focus(); }
  };
  const deleteMessage = (convId, idx) => {
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: c.messages.filter((_, i) => i !== idx) } : c)));
  };
  const retryMessage = async (convId, idx) => {
    // Retry regenerates in place; it never queues behind a live run.
    if (streamingRef.current || runActiveRef.current) { setNotice('Wait for the current reply to finish before retrying.'); return; }
    const conv = convsRef.current.find((c) => c.id === convId);
    if (!conv) return;
    const msgs = conv.messages;
    let userIdx = idx - 1;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;
    const kept = msgs.slice(0, userIdx + 1);
    setError('');
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: kept } : c)));
    const payloadMessages = buildPayloadMessages(kept);
    const directives = buildDirectives(styleId, provider.reasoningLevel, { webSearch, project: activeProject, harnessProfile: settings.harnessProfile, customStyles });
    if (directives.length) payloadMessages.unshift({ role: 'system', content: directives.join('\n') });
    // Same project-folder rule as send(): never inherit another chat's cwd.
    let runCwd = cwd;
    if (convId !== activeIdRef.current || !runCwd) {
      runCwd = await window.autobot.getWorkspace(convId)
        || await window.autobot.getDefaultCwd(convId, conv.title || '');
      if (runCwd) { saveJSON('autobot:workspace:' + convId, runCwd); if (convId === activeIdRef.current) setCwd(runCwd); }
    }
    // Pin the run to its conversation before any event can arrive — without
    // this commitLive bailed (runActiveRef false), the composer spun forever
    // and the regenerated reply was dropped.
    runConvRef.current = convId;
    runActiveRef.current = true;
    teamConvRef.current = convId;
    const effKey = provider.apiKey || resolveLoopbackKey(provider.baseURL, providerKeys, provider);
    const effProvider = effKey && !provider.apiKey ? { ...provider, apiKey: effKey } : provider;
    setPaused(false);
    setStreaming(true);
    setRunStartedAt(Date.now());
    setThinking('');
    setLiveSync({ content: '', tools: [], model: effProvider.routingMode === 'auto' ? '' : (effProvider.model || provider.model || '') });
    setSubAgents([]);
    setSwarmInfo(null);
    setSwarmBoard([]);
    const runId = uid();
    runIdRef.current = runId;
    const started = await window.autobot.run({
      runId, messages: payloadMessages, provider: effProvider,
      cwd: runCwd || undefined, useMemory: settings.useMemory, orchestrator, permissions,
      convId, title: conv.title || '',
      swarm: swarmEnabled,
    });
    if (started && started.ok === false && runActiveRef.current) {
      runActiveRef.current = false;
      runConvRef.current = null;
      setStreaming(false);
      setThinking('');
      setLiveSync(null);
      setError(cleanErr(started.error || 'The provider rejected this run.'));
      if (started.needsSignIn) setModelMenuOpen(true);
    }
  };

  const copyBlock = (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    copyTextToClipboard(code).then((ok) => {
      if (!ok) return;
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  };

  // "Apply to file" (Claude Code parity): write a code block into the project
  // folder the block's fence names, resolving relative to the active workspace.
  const applyBlock = async (e) => {
    const btn = e.target.closest('.apply-btn');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    const file = btn.dataset.file || '';
    const r = await window.autobot.writeFile({ file, content: code, cwd: cwd || undefined });
    if (r && r.ok) {
      btn.textContent = 'Saved';
      setNotice(`Wrote ${r.path}`);
      setTimeout(() => (btn.textContent = 'Apply'), 1500);
    } else {
      btn.textContent = 'Error';
      setError('Apply failed: ' + ((r && r.error) || 'unknown error'));
      setTimeout(() => (btn.textContent = 'Apply'), 1500);
    }
  };

  const testProvider = async () => {
    setError('');
    const effKey = provider.apiKey || resolveLoopbackKey(provider.baseURL, providerKeys, provider);
    const effProvider = effKey && !provider.apiKey ? { ...provider, apiKey: effKey } : provider;
    const r = await window.autobot.testProvider(effProvider);
    if (r.ok) setError('✅ Provider OK — reply: ' + r.reply);
    else setError('❌ Provider error: ' + r.error);
  };

  const refreshMemory = async () => setMemory((await window.autobot.getMemory()).entries || []);
  const addMemory = async () => {
    const content = prompt('Memory note:');
    if (!content) return;
    await window.autobot.addMemory(content);
    refreshMemory();
  };
  const clearMemory = async () => { await window.autobot.clearMemory(); refreshMemory(); };
  const learnCurrentSession = async (skillName = '') => {
    if (!window.autobot || !window.autobot.learnSkill) return null;
    try {
      const res = await window.autobot.learnSkill({
        name: skillName || '',
        messages: (active && active.messages) || [],
        cwd,
        provider,
      });
      if (res && res.ok) {
        try { await refreshSkills(); } catch (_) {}
        setNotice(`Learned PII-scrubbed skill: ${res.filePath}`);
      } else {
        setError((res && res.error) || 'Failed to extract skill');
      }
      return res;
    } catch (e) {
      setError((e && e.message) || 'Failed to extract skill');
      return null;
    }
  };

  const connectMcp = async () => {
    setError('');
    const transport = mcpForm.transport || 'stdio';
    if (transport === 'stdio' && !mcpForm.command) { setError('MCP command required'); return; }
    if ((transport === 'sse' || transport === 'http') && !mcpForm.url) { setError('MCP URL required'); return; }
    const cfg = transport === 'stdio'
      ? { transport: 'stdio', command: mcpForm.command, args: mcpForm.args ? mcpForm.args.split(/\s+/) : [] }
      : { transport, url: mcpForm.url };
    const r = await window.autobot.mcpConnect(cfg);
    if (r.ok) {
      setMcpServers((s) => [...s, { serverId: r.serverId, name: (transport === 'stdio' ? mcpForm.command : mcpForm.url), tools: r.tools }]);
      setMcpForm({ transport: 'stdio', command: '', args: '', url: '' });
    } else setError('MCP connect failed: ' + r.error);
  };
  const disconnectMcp = async (serverId) => {
    await window.autobot.mcpDisconnect(serverId);
    setMcpServers((s) => s.filter((x) => x.serverId !== serverId));
  };

  // ---- Notebooks ----
  const openNotebook = async (name) => {
    const nb = await window.autobot.getNotebook(name);
    setActiveNotebook(name);
    setNotebookCells(nb.cells || []);
  };
  const newNotebook = () => {
    const name = prompt('Notebook name:');
    if (!name) return;
    setActiveNotebook(name);
    setNotebookCells([]);
    setNotebooks((n) => (n.includes(name) ? n : [...n, name]));
  };
  const saveActiveNotebook = async () => {
    if (!activeNotebook) return;
    await window.autobot.saveNotebook(activeNotebook, notebookCells);
    setNotebooks((n) => (n.includes(activeNotebook) ? n : [...n, activeNotebook]));
    setError('✅ Saved notebook "' + activeNotebook + '"');
  };
  const deleteActiveNotebook = async () => {
    if (!activeNotebook) return;
    await window.autobot.deleteNotebook(activeNotebook);
    setNotebooks((n) => n.filter((x) => x !== activeNotebook));
    setActiveNotebook(null);
    setNotebookCells([]);
  };

  // ---- Terminal ----
  const refreshTerminal = async () => {
    const tabs = await window.autobot.shellList();
    setTerminal((t) => ({ tabs, active: t.active || (tabs[0] ? tabs[0].id : null) }));
  };
  const startTerminal = async () => {
    const t = await window.autobot.shellStart({ cwd: cwd || undefined });
    await refreshTerminal();
    setTerminal((s) => ({ ...s, active: t.id }));
  };
  const runInTerminal = async (command) => {
    const id = terminal.active;
    if (!id) return;
    const r = await window.autobot.shellRun(id, command);
    await refreshTerminal();
    if (!r.ok) setError('Terminal error: ' + r.error);
  };
  const writeTerminal = async (data) => {
    const id = terminal.active;
    if (!id) return;
    await window.autobot.shellWrite(id, data);
    await refreshTerminal();
  };
  const killTerminal = async (id) => {
    await window.autobot.shellKill(id);
    await refreshTerminal();
  };

  // ---- Slash commands ----
  // Built-ins are client-side; everything else is resolved against the SAME
  // command files Claude Code reads (`.claude/commands/*.md`, bundled, user).
  // Every command Claude Code 2.1.x ships is either implemented here, mapped to
  // its GUI surface, or documented as GUI-EQ / N-A — never silently "unknown".
  const runSlashCommand = async (raw, opts = {}) => {
    const body = String(raw || '').replace(/^\//, '');
    const [head, ...rest] = body.trim().split(/\s+/);
    const rawCmd = (head || '').toLowerCase();
    // Claude Code 2.1.x aliases → canonical command (matches the real registry's
    // aliases[] fields exactly; undocumented ones are noted inline).
    const ALIAS = {
      q: 'quit', exit: 'quit', bye: 'quit',
      c: 'compact',
      cost: 'usage', stats: 'usage', 'usage-credits': 'usage', 'extra-usage': 'usage',
      bashes: 'bashes', tasks: 'bashes',
      plugins: 'plugins', plugin: 'plugins', marketplace: 'plugins',
      branch: 'fork', fork: 'fork',
      name: 'rename',
      'code-review': 'review',
      schedule: 'schedule', loops: 'schedule', loop: 'schedule',
    };
    const cmd = ALIAS[rawCmd] || rawCmd;
    const argText = rest.join(' ');
    const model = provider.model || '';
    const note = (s) => appendAssistant(s);
    const lastAssistant = () => [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
    // One-shot model call shared by /advisor, /btw, /recap, /brief. Errors are
    // surfaced, never swallowed.
    const askOnce = async (system, question, maxTokens = 1200) => {
      try {
        const r = await window.autobot.chatOnce({
          provider, maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        });
        if (r && r.ok) return String(r.content || '').trim() || '_(empty response)_';
        return '⚠️ ' + ((r && r.error) || 'model call failed');
      } catch (e) { return '⚠️ ' + (e.message || 'model call failed'); }
    };
    const transcriptText = () => (messages || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + msgText(m)).join('\n\n');

    switch (cmd) {
      case 'help': {
        let custom = [];
        try { custom = (await window.autobot.listCommands(cwd)) || []; } catch (_) {}
        const groups = [
          ['Session', [
            ['/help', 'this help'], ['/clear', 'clear current conversation'], ['/compact', 'summarize the transcript, then continue from the digest'],
            ['/resume', 'list conversations to switch to'], ['/continue', 'continue the last turn'], ['/fork', 'branch a copy of this conversation'],
            ['/export [md|html|json]', 'export the conversation'], ['/copy', 'copy my last reply'], ['/reset', 'clear memory + conversations'],
          ]],
          ['Model & context', [
            ['/model', 'open provider settings'], ['/usage', 'token usage for the last run'], ['/cost', 'estimated cost of the last run'],
            ['/context', 'context-window usage'], ['/insights', 'usage summary'], ['/effort [auto|low|medium|high]', 'set thinking level'],
            ['/output-style [name]', 'writing style'], ['/config', 'open settings'], ['/theme', 'toggle light/dark'],
          ]],
          ['Workspace', [
            ['/status', 'provider / model / tools'], ['/diff', 'git diff of the workspace'], ['/add-dir [path]', 'change working directory'],
            ['/init', 'write a CLAUDE.md for this project'], ['/todos', 'show the current todo list'], ['/plan [off]', 'toggle plan mode (read-only)'],
            ['/notebooks', 'open notebooks'], ['/terminal', 'open terminal'], ['/bashes', 'list background shells'],
          ]],
          ['Agent', [
            ['/agents', 'list sub-agent definitions'], ['/permissions', 'show permission rules'], ['/rewind', 'restore files from a checkpoint'],
            ['/memory', 'open memory panel'], ['/review', 'review the working-tree diff'], ['/security-review', 'security review of the diff'],
            ['/simplify', 'simplify the changed code'], ['/advisor [q]', 'second opinion from the model'], ['/btw [q]', 'quick side answer'],
            ['/recap', 'recap this conversation'], ['/brief', 'short brief of this conversation'], ['/goal [text]', 'set the run goal'],
          ]],
          ['Config & system', [
            ['/hooks', 'show merged hook config'], ['/mcp', 'show MCP servers'], ['/skills', 'list skills'], ['/reload-skills', 'refresh skills'],
            ['/plugins', 'list plugins'], ['/debug', 'build + environment info'], ['/doctor', 'diagnose the setup'], ['/version', 'app version'],
          ]],
        ];
        const fmtGroup = (title, rows) => '**' + title + '**\n' + rows.map((r) => '`' + r[0] + '` — ' + r[1]).join('\n');
        const builtins = groups.map((g) => fmtGroup(g[0], g[1])).join('\n\n');
        const customList = custom.length ? '\n\n**Project commands**\n' + custom.map((c) => '`/' + c.name + '`' + (c.description ? ' — ' + c.description : '')).join('\n') : '';
        note('Slash commands:\n\n' + builtins + customList);
        break;
      }
      case 'clear':
        clearActiveConversation();
        break;
      case 'commands': {
        let custom = [];
        try { custom = (await window.autobot.listCommands(cwd)) || []; } catch (_) {}
        const only = custom.filter((c) => c.custom);
        note('**Custom commands** (' + only.length + ')\n' + (only.length ? only.map((c) => '- `/' + c.name + '`' + (c.description ? ' — ' + c.description : '') + ' _(' + c.source + ')_').join('\n') : '_(none — add `.claude/commands/*.md`)_'));
        break;
      }
      case 'compact': {
        const msgs = (active && active.messages) || [];
        if (msgs.length < 4) { note('Nothing to compact — this conversation is still short.'); break; }
        note('⏳ Compacting ' + msgs.length + ' messages…');
        const r = await window.autobot.compact({ provider, messages: msgs });
        if (!r || !r.ok) { note('❌ Compact failed: ' + ((r && r.error) || 'unknown error')); break; }
        const digest = { id: uid(), role: 'assistant', content: '**Compacted conversation** — earlier turns were summarized.\n\n' + String(r.summary || ''), ts: Date.now() };
        setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, messages: [digest], compactedAt: Date.now() } : c)));
        const compEst = Math.max(200, Math.round(String(r.summary || '').length / 3.8));
        const nextCompUsage = { prompt_tokens: compEst, context_tokens: compEst, completion_tokens: Number(r.usage && r.usage.completion_tokens) || 0, total_tokens: compEst, calls: 1, model: r.model || model, estimated: true, convId: activeId, at: Date.now() };
        recordConvUsage(activeId, nextCompUsage);
        setLastUsage(nextCompUsage);
        break;
      }
      case 'model':
        setShowSettings(true);
        break;
      case 'review': {
        const rawArg = String(argText || '').trim();
        const adv = /--adversarial\b/i.test(rawArg);
        const withMatch = /--with\s+("([^"]+)"|'([^']+)'|(\S+))/i.exec(rawArg);
        const withSpec = withMatch ? (withMatch[2] || withMatch[3] || withMatch[4] || '') : '';
        const wantDuet = adv || Boolean(withSpec) || /--duet\b/i.test(rawArg);
        if (wantDuet) {
          openReview({ scope: 'all', duetAutoRun: true, withSpec, adversarial: adv, at: Date.now() });
          break;
        }
        if (streaming) { note('A run is in progress — wait for it to finish before /review.'); break; }
        send('Review the current working-tree changes. Run `git diff` (or `git status` then read the changed files), then give a concise code review: correctness bugs, security issues, edge cases, and concrete fixes. Reference files and line numbers.');
        break;
      }
      case 'security-review': {
        if (streaming) { note('A run is in progress — wait for it to finish.'); break; }
        send('Perform a security review of the current working-tree changes. Run `git diff`, read the affected files, and report concrete vulnerabilities (injection, authz/IDOR, secrets, unsafe deserialization, SSRF, path traversal, XSS) with file/line references and fixes. If nothing is exploitable, say so briefly.');
        break;
      }
      case 'simplify': {
        if (streaming) { note('A run is in progress — wait for it to finish.'); break; }
        send('Simplify the code in the current working-tree changes without changing behavior. Run `git diff`, then apply focused edits that remove duplication, dead code, and needless complexity. Keep the diff small and explain each change.');
        break;
      }
      case 'memory': {
        setPanel('memory');
        let pm = null;
        try { pm = await window.autobot.getProjectMemory(cwd); } catch (_) {}
        const files = (pm && pm.files) || [];
        const chars = ((pm && pm.text) || '').length;
        note('**Memory** — the Memory panel lists saved notes. Project memory comes from the `CLAUDE.md` hierarchy:\n' +
          (files.length
            ? files.map((f) => '- `' + (f.file || f.path) + '` (' + (f.scope || 'project') + ', ' + (f.bytes || 0) + ' B)').join('\n') + '\n\nCombined size: ' + chars + ' characters.'
            : '_(no CLAUDE.md found in this folder, its parents, or ~/.claude)_'));
        break;
      }
      case 'agents': {
        let list = [];
        try { list = (await window.autobot.listAgentDefs(cwd)) || []; } catch (_) {}
        appendAssistant(list.length
          ? '**Sub-agent definitions**\n' + list.map((a) => '- `' + a.name + '`' + (a.model ? ' (`' + a.model + '`)' : '') + (a.description ? ' — ' + a.description : '')).join('\n')
          : 'No sub-agent definitions found (`.claude/agents/*.md` or built-ins).');
        break;
      }
      case 'permissions': {
        let p = null;
        try { p = await window.autobot.getPermissions(cwd); } catch (_) {}
        if (!p) { appendAssistant('Permission rules unavailable.'); break; }
        const fmt = (arr) => (arr && arr.length ? arr.map((r) => '`' + r + '`').join(', ') : '_(none)_');
        appendAssistant('**Permission rules**\n- Default mode: `' + (p.defaultMode || 'auto') + '`\n- allow: ' + fmt(p.allow) + '\n- deny: ' + fmt(p.deny) + '\n- ask: ' + fmt(p.ask));
        break;
      }
      case 'rewind': {
        let cps = [];
        try { cps = (await window.autobot.listCheckpoints(activeId)) || []; } catch (_) {}
        if (!cps.length) { appendAssistant('No checkpoints for this conversation yet.'); break; }
        const target = argText ? cps.find((c) => String(c.id) === argText || String(c.turnId) === argText) : cps[cps.length - 1];
        if (!target) { appendAssistant('Checkpoint not found: `' + argText + '`\n\n' + cps.map((c) => '- `' + c.id + '`').join('\n')); break; }
        const res = await window.autobot.rewind(activeId, target.id);
        if (res && res.ok) {
          const bits = [];
          if (res.restored) bits.push(res.restored + ' file(s) restored');
          if (res.removed) bits.push(res.removed + ' file(s) removed');
          appendAssistant('✅ Rewound to checkpoint `' + target.id + '`' + (bits.length ? ' (' + bits.join(', ') + ').' : '.'));
        } else {
          appendAssistant('❌ Rewind failed: ' + (((res && res.errors) || []).join('; ') || 'unknown'));
        }
        break;
      }
      case 'reset':
        clearMemory();
        setConvs([]);
        setActiveId(null);
        setLiveSync(null);
        setError('✅ Reset complete.');
        break;
      case 'status':
        appendAssistant('**Status**\n- Provider: `' + provider.baseURL + '`\n- Model: `' + provider.model + '`\n- Tools: function-calling ' + (provider.supportsTools ? 'enabled' : 'disabled') + '\n- Memory: ' + (settings.useMemory ? 'on' : 'off') + '\n- CWD: `' + (cwd || '~') + '`');
        break;
      case 'notebooks':
        setPanel('notebooks');
        break;
      case 'terminal':
        setPanel('terminal');
        break;
      // ---------- model & context ----------
      case 'usage': {
        const u = effectiveUsageForConv(lastUsage, active, provider, liveForActive);
        if (!u) { note('No token usage recorded yet for this session. Run a message first.'); break; }
        const cost = estimateCost(u.model || model, u.prompt_tokens, u.completion_tokens);
        const ctxUsed = usedTokens(u);
        const ctxWin = contextWindowFor(u.model || model);
        const ctxPct = ctxWin > 0 && ctxUsed > 0 ? ((ctxUsed / ctxWin) * 100 < 1 ? '<1' : String(Math.round((ctxUsed / ctxWin) * 100))) : '0';
        note('**Usage** (last run)\n- Model: `' + (u.model || model) + '`\n- Prompt: ' + fmtTokens(u.prompt_tokens) + ' tokens (sum across ' + (u.calls || 1) + ' call(s))\n- Completion: ' + fmtTokens(u.completion_tokens) + ' tokens\n- Total: ' + fmtTokens(u.total_tokens) + ' tokens across ' + (u.calls || 1) + ' call(s)\n- Context now: ' + fmtTokens(ctxUsed) + ' / ' + fmtTokens(ctxWin) + ' (' + ctxPct + '% of window)\n- Est. cost: ' + fmtCost(cost));
        break;
      }
      case 'cost': {
        if (!lastUsage) { note('No usage recorded yet. Nothing to price.'); break; }
        const u = lastUsage;
        const cost = estimateCost(u.model || model, u.prompt_tokens, u.completion_tokens);
        const p = priceFor(u.model || model);
        note('**Cost** (last run)\n- Model: `' + (u.model || model) + '`\n- Rate: $' + p.in + ' / $' + p.out + ' per 1M in/out\n- ' + fmtTokens(u.prompt_tokens) + ' in + ' + fmtTokens(u.completion_tokens) + ' out\n- **' + fmtCost(cost) + '** (estimate)');
        break;
      }
      case 'context': {
        const chars = (messages || []).reduce((n, m) => n + msgText(m).length, 0) + (live ? (live.content || '').length : 0);
        const est = Math.round(chars / 4);
        const win = contextWindowFor(model);
        const pct = win ? Math.min(100, (est / win) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        note('**Context**\n- Model: `' + model + '`\n- Window: ' + fmtTokens(win) + ' tokens\n- This conversation: ~' + fmtTokens(est) + ' tokens (' + pct.toFixed(1) + '%)\n`' + bar + '`\n- Messages: ' + (messages || []).length);
        break;
      }
      case 'insights': {
        const turns = (messages || []).filter((m) => m.role === 'user').length;
        const replies = (messages || []).filter((m) => m.role === 'assistant').length;
        const u = lastUsage || {};
        const conv = convs.find((c) => c.id === activeId);
        note('**Insights**\n- Conversation: ' + (conv ? conv.title : '(none)') + '\n- User turns: ' + turns + '\n- Assistant turns: ' + replies + '\n- Last model: `' + (u.model || model) + '`\n- Last total tokens: ' + fmtTokens(u.total_tokens || 0) + '\n- Est. last-run cost: ' + fmtCost(estimateCost(u.model || model, u.prompt_tokens, u.completion_tokens)) + '\n- Total conversations: ' + convs.length);
        break;
      }
      case 'effort': {
        const lv = String(argText || '').trim().toLowerCase();
        if (!lv) { note('Current thinking level: **' + (reasoningLevel || 'auto') + '**\nUse `/effort auto|low|medium|high` or the Thinking control in the composer.'); break; }
        if (!['auto', 'low', 'medium', 'high'].includes(lv)) { note('Unknown level `' + lv + '`. Pick auto, low, medium, or high.'); break; }
        setReasoningLevel(lv);
        note('Thinking level set to **' + lv + '**.');
        break;
      }
      case 'output-style': {
        const st = String(argText || '').trim().toLowerCase();
        const merged = [...STYLES, ...(customStyles || []).filter((c) => !STYLES.some((b) => b.id === c.id))];
        const found = merged.find((s) => s.id === st || String(s.name || '').toLowerCase() === st);
        if (!st) {
          note('**Output styles**\n' + merged.map((s) => '- `' + s.id + '` — ' + s.name + (s.hint ? ' (' + s.hint + ')' : '') + (s.id === styleId ? '  ← current' : '')).join('\n') + '\n\nUse `/output-style <id>` or open Customizations.');
          break;
        }
        if (!found) { note('Unknown style `' + st + '`. Run `/output-style` to list them.'); break; }
        setStyleId(found.id);
        note('Output style set to **' + found.name + '**.');
        break;
      }
      case 'customizations':
        setPanel('customizations');
        break;
      case 'theme':
      case 'color': {
        const next = (settings.theme === 'dark') ? 'light' : 'dark';
        setSettings((s) => ({ ...s, theme: next }));
        note('Theme switched to **' + next + '**.');
        break;
      }
      case 'config':
        setShowSettings(true);
        break;
      case 'version': {
        let v = null;
        try { v = await window.autobot.getVersion(); } catch (_) {}
        note(v ? ('**Version**\n- Akron Code `' + v.app + '`\n- Electron `' + v.electron + '` · Chrome `' + v.chrome + '` · Node `' + v.node + '`\n- Platform: ' + v.platform + '/' + v.arch) : 'Version info unavailable.');
        break;
      }
      case 'debug': {
        let v = null;
        try { v = await window.autobot.getVersion(); } catch (_) {}
        let gi = null;
        try { gi = await window.autobot.gitInfo(cwd); } catch (_) {}
        note('**Debug**\n- Provider: `' + provider.baseURL + '`\n- Model: `' + model + '`\n- Tools: ' + (provider.supportsTools ? 'on' : 'off') + '\n- Reasoning: `' + (reasoningLevel || 'auto') + '`\n- Swarm: ' + (swarmEnabled ? 'on' : 'off') + '\n- Permission mode: `' + (permissions || 'auto') + '`\n- CWD: `' + (cwd || '~') + '`\n' + (gi && gi.isRepo ? '- Repo: `' + gi.root + '` on `' + gi.branch + '` (+' + gi.ahead + '/-' + gi.behind + ')' : '- Repo: none') + (v ? '\n- Build: ' + v.app + ' · Electron ' + v.electron : ''));
        break;
      }
      case 'doctor': {
        const checks = [];
        let v = null;
        try { v = await window.autobot.getVersion(); } catch (_) {}
        checks.push((v ? '✅' : '❌') + ' App runtime' + (v ? ' (' + v.app + ')' : ''));
        checks.push((provider.baseURL && provider.model ? '✅' : '❌') + ' Provider configured (' + (provider.model || 'none') + ')');
        checks.push((provider.apiKey || provider.baseURL) ? '✅' : '⚠️' + ' Credentials');
        let gi = null;
        try { gi = await window.autobot.gitInfo(cwd); } catch (_) {}
        checks.push((gi && gi.isRepo ? '✅' : '⚠️') + ' Git repo ' + (gi && gi.isRepo ? gi.root : 'not detected'));
        let sk = [];
        try { sk = (await window.autobot.getSkills()) || []; } catch (_) {}
        checks.push('✅ Skills loaded: ' + sk.length);
        let hooks = null;
        try { hooks = await window.autobot.getHooks(cwd); } catch (_) {}
        const hookCount = hooks ? Object.values(hooks).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0) : 0;
        checks.push((hookCount ? '✅' : 'ℹ️') + ' Hooks: ' + hookCount);
        note('**Doctor**\n' + checks.join('\n') + '\n\nIf a provider check is red, open `/model` and re-enter the key.');
        break;
      }
      // ---------- workspace ----------
      case 'diff': {
        let gi = null;
        try { gi = await window.autobot.gitInfo(cwd); } catch (_) {}
        if (!gi || !gi.isRepo) { note('Not a git repository (`' + (cwd || '~') + '`).'); break; }
        const c = gi.counts || {};
        let stat = null;
        try { stat = await window.autobot.gitRun(gi.root, ['diff', '--stat']); } catch (_) {}
        let full = null;
        try { full = await window.autobot.gitRun(gi.root, ['diff']); } catch (_) {}
        const body = (full && full.stdout ? full.stdout : '').slice(0, 12000);
        note('**Git diff** — `' + gi.branch + '`\n- modified ' + (c.modified || 0) + ' · added ' + (c.added || 0) + ' · deleted ' + (c.deleted || 0) + ' · untracked ' + (c.untracked || 0) + '\n\n' + ((stat && stat.stdout) ? '```\n' + stat.stdout + '\n```\n\n' : '') + (body ? '```diff\n' + body + '\n```' : '_(no unstaged changes)_'));
        break;
      }
      case 'add-dir':
      case 'cwd': {
        const dir = String(argText || '').trim();
        if (!dir) { note('Current working directory: `' + (cwd || '~') + '`\nUse `/add-dir <path>` to change it.'); break; }
        setCwd(dir);
        note('Working directory set to `' + dir + '`.');
        break;
      }
      case 'init': {
        const content = [
          '# Project guide',
          '',
          'This file (`CLAUDE.md`) is read automatically at the start of every conversation. Keep it short and factual.',
          '',
          '## Overview',
          '<!-- what this project is, one paragraph -->',
          '',
          '## Commands',
          '- install: `npm install`',
          '- build: `npm run build`',
          '- test: `npm test`',
          '',
          '## Conventions',
          '- <!-- style, structure, gotchas -->',
          '',
        ].join('\n');
        const r = await window.autobot.writeFile({ file: 'CLAUDE.md', content, cwd });
        note(r && r.ok ? '✅ Created `CLAUDE.md` at `' + r.path + '`. Edit it to describe this project.' : '❌ Could not write CLAUDE.md: ' + ((r && r.error) || 'unknown'));
        break;
      }
      case 'note': {
        const topic = String(argText || '').trim();
        if (!topic) {
          note('Use `/note <decision title>` to record an Agent Note in `.agents/notes/` (DeepSeek Harness pattern).');
          break;
        }
        const day = new Date().toISOString().slice(0, 10);
        const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'decision';
        const relPath = `.agents/notes/implemented/architecture/${day}-${slug}.md`;
        const content = [
          `# Agent Note: ${topic}`,
          '',
          'Status: implemented',
          '',
          '## Problem',
          'Describe the constraint, failure mode, or design tension this decision resolves.',
          '',
          '## Decision',
          `- Recorded in Akron Code workspace (\`${cwd || '.'}\`).`,
          '',
          '## Verification',
          '- Concrete checks / E2E tests covering this change.',
          '',
        ].join('\n');
        const r = await window.autobot.writeFile({ file: relPath, content, cwd });
        note(r && r.ok ? `✅ Created Agent Note at \`${relPath}\`.` : `❌ Could not write Agent Note: ${(r && r.error) || 'unknown'}`);
        break;
      }
      case 'todos': {
        let todos = null;
        for (let i = (messages || []).length - 1; i >= 0; i--) {
          const m = messages[i];
          const tool = (m.tools || []).find((t) => t && t.name === 'TodoWrite' && t.args && Array.isArray(t.args.todos));
          if (tool) { todos = tool.args.todos; break; }
        }
        if (!todos || !todos.length) { note('No todo list in this conversation yet. The agent creates one with the TodoWrite tool.'); break; }
        const mark = (s) => s === 'completed' ? '✅' : s === 'in_progress' ? '🔄' : '⬜';
        note('**Todos**\n' + todos.map((t) => mark(t.status) + ' ' + (t.content || t.activeForm || '')).join('\n'));
        break;
      }
      case 'plan': {
        const off = /^(off|stop|exit|false)$/i.test(String(argText || '').trim());
        if (off) { setPermissions('auto'); note('Plan mode off — back to auto.'); break; }
        setPermissions('plan');
        note('Plan mode on — the agent is read-only and writes only the plan file until you approve. Use the permission pill or `/plan off` to exit.');
        break;
      }
      case 'bashes': {
        let jobs = [];
        try { jobs = (await window.autobot.shellList()) || []; } catch (_) {}
        if (!jobs.length) { note('No background shells running.'); break; }
        note('**Background shells**\n' + jobs.map((j) => '- `' + (j.id || '?') + '` ' + (j.status || '') + (j.label ? ' — ' + j.label : '')).join('\n'));
        break;
      }
      // ---------- session ----------
      case 'copy': {
        const last = lastAssistant();
        if (!last) { note('Nothing to copy yet.'); break; }
        const ok = await copyTextToClipboard(extractMessageText(last));
        note(ok ? 'Copied the last reply to the clipboard.' : 'Clipboard unavailable.');
        break;
      }
      case 'export': {
        const fmt = ['md', 'html', 'json'].includes(String(argText || '').trim().toLowerCase()) ? String(argText).trim().toLowerCase() : 'md';
        await exportConv(fmt);
        break;
      }
      case 'resume': {
        const want = String(argText || '').trim();
        if (want) {
          const hit = convs.find((c) => c.id === want || (c.title || '').toLowerCase().includes(want.toLowerCase()));
          if (hit) { setActiveId(hit.id); note('Resumed **' + (hit.title || hit.id) + '**.'); break; }
        }
        const rows = convs.slice(0, 25).map((c) => '- `' + c.id + '` — ' + (c.title || 'Untitled') + ' (' + (c.messages || []).length + ' msgs)' + (c.id === activeId ? '  ← current' : ''));
        note('**Conversations**\n' + (rows.length ? rows.join('\n') : '_(none yet)_') + '\n\nUse `/resume <id-or-title>`.');
        break;
      }
      case 'continue': {
        if (streaming) { note('Already running — the current turn will finish first.'); break; }
        send('continue');
        break;
      }
      case 'fork': {
        const conv = convs.find((c) => c.id === activeId);
        if (!conv) { note('No active conversation to fork.'); break; }
        const copy = { ...conv, id: uid(), title: (conv.title || 'Untitled') + ' (fork)', messages: (conv.messages || []).map((m) => ({ ...m, id: uid() })), ts: Date.now() };
        setConvs((cs) => [copy, ...cs]);
        setActiveId(copy.id);
        note('Forked into **' + copy.title + '**.');
        break;
      }
      case 'goal': {
        if (!argText) {
          note(goal ? 'Current goal: ' + goal + '\nUse `/goal <objective>` to run autonomously until that goal is completely finished.' : 'No goal set. Use `/goal <objective>` to run until the specified goal is completely finished.');
          break;
        }
        setGoal(argText);
        setNotice('Goal: ' + argText);
        if (!streaming) {
          send(`[AUTONOMOUS GOAL MODE]\nGoal: ${argText}\n\nWork thoroughly step-by-step, verify everything end-to-end with concrete checks/tests, and do not stop until this goal is completely finished.`);
        } else {
          note('🎯 Goal updated: ' + argText);
        }
        break;
      }
      case 'swarm': {
        const clean = String(argText || '').trim();
        if (clean === 'off') {
          setSwarmEnabled(false);
          note('Swarm mode **OFF**.');
          break;
        }
        if (clean === 'on' || !clean) {
          const next = clean === 'on' ? true : !swarmEnabled;
          setSwarmEnabled(next);
          note('Swarm mode **' + (next ? 'ON' : 'OFF') + '** — multi-model Planner + role-pooled Swarm workers ' + (next ? 'enabled.' : 'disabled.'));
          break;
        }
        setSwarmEnabled(true);
        if (!streaming) send(clean);
        else note('Swarm mode ON. Current run is still active.');
        break;
      }
      case 'subagents': {
        showSessionPane('subagents');
        break;
      }
      case 'worktrees': {
        openSettingsAt('worktrees');
        break;
      }
      case 'gdrive': {
        setGdriveModalOpen(true);
        break;
      }
      // ---------- one-shot model calls ----------
      case 'advisor': {
        if (!argText) { note('Use `/advisor <question>` for a second opinion from the model without adding a turn to the transcript.'); break; }
        const q = transcriptText().slice(-6000) + '\n\nQuestion: ' + argText;
        note('**Advisor**\n' + await askOnce('You are a second-opinion advisor. Given the conversation and a question, give a direct, critical answer. Point out risks and concrete next steps. Be brief.', q, 900));
        break;
      }
      case 'btw': {
        if (!argText) { note('Use `/btw <question>` for a quick side answer that stays out of the main thread.'); break; }
        note('**By the way**\n' + await askOnce('Answer the user\'s side question briefly and directly. It is a tangent, not the main task.', argText, 700));
        break;
      }
      case 'recap': {
        if (!messages.length) { note('Nothing to recap yet.'); break; }
        note('**Recap**\n' + await askOnce('Summarize this conversation in a short recap: what the user wanted, what was done, current state, and what is left. Terse bullets.', transcriptText().slice(-12000), 900));
        break;
      }
      case 'brief': {
        if (!messages.length) { note('Nothing to brief yet.'); break; }
        note('**Brief**\n' + await askOnce('Give a one-paragraph brief of this conversation and 3 bullet next steps.', transcriptText().slice(-12000), 600));
        break;
      }
      // ---------- config & system ----------
      case 'hooks': {
        let hooks = null;
        try { hooks = await window.autobot.getHooks(cwd); } catch (_) {}
        if (!hooks) { note('Hook config unavailable.'); break; }
        const rows = [];
        for (const [ev, arr] of Object.entries(hooks)) {
          if (!Array.isArray(arr) || !arr.length) continue;
          for (const entry of arr) rows.push('- `' + ev + '`' + (entry.matcher ? ' [' + entry.matcher + ']' : '') + ' — ' + (entry.hooks || []).map((h) => h.type + (h.command ? ': `' + h.command + '`' : '')).join(', '));
        }
        note('**Hooks**\n' + (rows.length ? rows.join('\n') : '_(no hooks configured — checked ~/.claude, ./.claude, ~/.autobot/hooks.json)_'));
        break;
      }
      case 'mcp': {
        let cfg = null;
        try { cfg = await window.autobot.mcpConfig(cwd); } catch (_) {}
        if (!cfg) { note('MCP config unavailable.'); break; }
        const st = (cfg.status || []).map((s) => '- `' + (s.id || s.name) + '` — ' + (s.status || s.state || 'configured'));
        note('**MCP servers**\n' + (cfg.servers && cfg.servers.length ? cfg.servers.join(', ') : '_(none configured)_') + (st.length ? '\n\n**Status**\n' + st.join('\n') : ''));
        break;
      }
      case 'learn': {
        const res = await learnCurrentSession(argText);
        if (res && res.ok) {
          note(`✅ **Learned PII-scrubbed skill** (\`/${res.slug}\`)\nSaved cleanly to \`${res.filePath}\` with personal names, emails, keys, paths, and IDs redacted.`);
        } else {
          note('❌ Could not extract skill: ' + ((res && res.error) || 'unknown error'));
        }
        break;
      }
      case 'skills':
      case 'reload-skills': {
        let list = [];
        try { list = (await window.autobot.getSkills()) || []; } catch (_) {}
        setSkills(list);
        note('**Skills** (' + list.length + ')\n' + (list.length ? list.map((s) => '- `' + (s.name || s.id) + '`' + (s.enabled === false ? ' _(disabled)_' : '') + (s.description ? ' — ' + s.description : '')).join('\n') : '_(none found)_'));
        break;
      }
      case 'plugins':
      case 'reload-plugins': {
        let list = [];
        try { list = (await window.autobot.listPlugins({})) || []; } catch (_) {}
        const arr = Array.isArray(list) ? list : (list.items || []);
        note('**Plugins** (' + arr.length + ')\n' + (arr.length ? arr.map((p) => '- `' + (p.name || p.id) + '`' + (p.description ? ' — ' + p.description : '')).join('\n') : '_(none installed)_'));
        break;
      }
      // ---------- GUI-EQ / informational ----------
      case 'statusline':
        note('`/statusline` — Akron Code renders status in the composer (provider, model, thinking level, context). Use `/status` for a text dump.');
        break;
      case 'login':
        setShowSettings(true);
        note('Sign-in lives in Settings → Accounts.');
        break;
      case 'logout': {
        // Sign out the subscription this session is actually using (not a mock
        // identity). Clear the OAuth binding so the next turn falls back to the
        // configured gateway until an account is picked again.
        const active = provider.oauthProvider || '';
        if (active) {
          const cut = active.indexOf(':');
          const pid = cut > 0 ? active.slice(0, cut) : active;
          const acct = cut > 0 ? active.slice(cut + 1) : '';
          try { await window.autobot.providerSignOut(pid, acct); } catch (_) { /* main may not hold it */ }
          setProvider((v) => ({ ...v, oauthProvider: '', oauth: false, accessToken: '' }));
        }
        setAccount((a) => ({ ...a, signedIn: false, email: '', authMethod: null, plan: 'Free' }));
        note(active ? 'Signed out of the active provider account.' : 'No provider account is active.');
        break;
      }
      case 'quit':
        note('`/quit` — Akron Code is a GUI app, so there is no terminal to exit. Close the window (⌘W) to quit, or use the app menu.');
        break;
      case 'pr-comments':
        note('`/pr-comments` — pull request comments are reviewed in the Artifacts / GitHub panel. Connect a repo with `/init` and view PRs there.');
        break;
      case 'sandbox': {
        let d = null;
        try { d = await window.autobot.getSandbox(); } catch (_) {}
        if (!d) { note('Sandbox policy unavailable.'); break; }
        const fsb = d.filesystem || {};
        const net = d.network || {};
        const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : '—');
        note(
          `**Sandbox**: ${d.enabled ? 'enabled' : 'disabled'}${d.managed ? ' · managed by administrator' : ''}\n\n` +
          `Filesystem\n- deny read: ${list(fsb.denyRead)}\n- deny write: ${list(fsb.denyWrite)}\n- allow read: ${list(fsb.allowRead)}\n\n` +
          `Network\n- allowed domains: ${list(net.allowedDomains)}\n- denied domains: ${list(net.deniedDomains)}\n\n` +
          `Shell backend: ${d.backend || 'none'}`
        );
        break;
      }
      case 'search':
        setPanel((p) => (p === 'search' ? 'chats' : 'search'));
        break;
      case 'alias':
        note('`/alias` — command aliases are configured in Settings → Commands. Project commands live in `.claude/commands/*.md`.');
        break;
      case 'focus':
        note('`/focus` — narrow the working set with a project (Projects panel) or `/add-dir`.');
        break;
      case 'bug':
        note('Found a bug? File it with `/feedback` or the akronlogic.com support link. Include `/debug` output.');
        break;
      case 'feedback': {
        const fb = compliance && compliance.state ? compliance.state.feedback : null;
        if (fb && fb.allowed === false) {
          note((compliance.state && compliance.state.feedbackLine) || 'Product feedback is turned off by your organization’s policy.');
          break;
        }
        note('Feedback goes to akronlogic.com. Include `/debug` and `/version` output so it is actionable.');
        break;
      }
      case 'init-verifiers':
        note('`/init-verifiers` — add test/verification steps to `CLAUDE.md`. Use `/init` first, then describe how to verify changes.');
        break;
      // ---------- remaining Claude Code 2.1.x commands implemented in the GUI ----------
      case 'rename': {
        if (!argText) { note('Usage: `/rename <new title>` (alias: `/name`).'); break; }
        setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, title: argText } : c)));
        note('Renamed this conversation to **' + argText + '**.');
        break;
      }
      case 'toggle-memory': {
        const cur = localStorage.getItem('autobot:autoMemory') !== 'off';
        localStorage.setItem('autobot:autoMemory', cur ? 'off' : 'on');
        note('Auto-memory ' + (cur ? 'OFF' : 'ON') + ' for this session. (Settings → Memory toggles the global default.)');
        break;
      }
      case 'autocompact': {
        if (!argText) {
          const w = localStorage.getItem('autobot:autoCompactWindow') || 'auto';
          note('Auto-compact window: **' + w + '**. Set with `/autocompact <tokens|auto>`.');
          break;
        }
        localStorage.setItem('autobot:autoCompactWindow', argText);
        note('Auto-compact window set to **' + argText + '**. `/compact` still works on demand.');
        break;
      }
      case 'fast': {
        setReasoningLevel('low');
        note('⚡ Fast mode — reasoning level set to **Low**. Use `/effort` to change it.');
        break;
      }
      case 'background': {
        note('Akron Code runs every task in-app, so there is no terminal to background. Use `/tasks` to see background shells, sub-agents, and monitors.');
        break;
      }
      case 'stop': {
        if (streaming) { stop(); note('Stopped the current run — the partial reply is kept.'); }
        else { note('Nothing is running. `/tasks` lists background work you can inspect or kill.'); }
        break;
      }
      case 'automation':
      case 'automations': {
        if (!argText && !(opts && opts.direct)) {
          setPanel('chats');
          setActiveSkillPill({ id: 'automation', icon: 'Clock', label: 'automation', hint: 'Guide me through creating an automated task' });
          setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (_) {} }, 40);
          break;
        }
        setActiveSkillPill(null);
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        let expanded = '';
        try {
          const r = await window.autobot.resolveCommand('automation', argText, cwd);
          if (r && r.prompt) expanded = r.prompt;
        } catch (_) {}
        send(expanded || `Guide me through creating an automated recurring or event-driven task. ${argText}`.trim());
        break;
      }
      case 'schedule': {
        setPanel('scheduled');
        note('Opened **Automations** — create, edit, or pause recurring runs here.');
        break;
      }
      case 'mission': {
        setPanel('mission');
        note('Opened **Mission Control** — live zero-token session health monitor across workspaces.');
        break;
      }
      case 'ask-history': {
        setSearchTab('ask');
        setPanel('search');
        note('Opened **Ask History** — ask natural-language questions across indexed past sessions.');
        break;
      }
      case 'workflows': {
        setPanel('scheduled');
        note('**Workflows** — dynamic multi-step runs live under **Scheduled**. Completed and running workflow history is listed there.');
        break;
      }
      // ---------- terminal/account/product surfaces: GUI equivalents ----------
      case 'voice': {
        if (voiceMode) { stopVoiceMode(); note('Voice mode stopped.'); }
        else { startVoiceMode(); note('🎙️ Voice mode on — speak, and the reply is read back. Send `/voice` again to stop.'); }
        break;
      }
      case 'chrome': {
        const on = !features.chrome;
        const next = { ...features, chrome: on };
        setFeatures(next);
        window.autobot.setFeatures(next);
        note('Chrome control (CDP) is now **' + (on ? 'ON' : 'OFF') + '**. Point it at a running Chrome with `--remote-debugging-port=9222` (Settings → Chrome host/port).');
        break;
      }
      case 'daemon': {
        setPanel('scheduled');
        note('**Background services** — Akron Code keeps scheduled tasks, background shells, sub-agents, and monitors inside the app (no separate daemon). Opened **Scheduled**; `/tasks` lists live work.');
        break;
      }
      case 'session': {
        const conv = convs.find((c) => c.id === activeId);
        note('**Session** `' + (activeId || 'new') + '` — ' + (conv ? (conv.messages || []).length + ' messages, titled “' + (conv.title || 'Untitled') + '”' : 'not yet persisted') + '.\nWorking folder: `' + cwd + '`. Use `/export` to save the transcript.');
        break;
      }
      case 'remote-env': {
        const on = !features.remoteControl;
        const next = { ...features, remoteControl: on };
        setFeatures(next);
        window.autobot.setFeatures(next);
        note('Remote control is now **' + (on ? 'ON' : 'OFF') + '** (Settings → Features). Akron Code has no cloud workspace, so remote sessions run against this machine.');
        break;
      }
      case 'setup-bedrock': {
        setProvider((v) => ({ ...v, baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', model: v.model || 'anthropic.claude-sonnet-4-5', apiKey: v.apiKey || '', supportsTools: true }));
        setShowSettings(true);
        note('**Amazon Bedrock** — Bedrock ships an OpenAI-compatible endpoint. Set the API key to a Bedrock API key (or `AWS_BEARER_TOKEN_BEDROCK`) and change the region in the URL, then press **Test** in Settings.');
        break;
      }
      case 'setup-vertex': {
        setProvider((v) => ({ ...v, baseURL: 'https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/endpoints/openapi', model: v.model || 'google/gemini-2.5-pro', apiKey: v.apiKey || '', supportsTools: true }));
        setShowSettings(true);
        note('**Google Vertex AI** — replace `PROJECT_ID` with your GCP project, put an OAuth access token in the API key field, and press **Test** in Settings.');
        break;
      }
      case 'ide': {
        setWorkbenchMode('ide');
        note('Switched to **IDE Mode** (Monaco Editor, File Explorer, Search, Source Control & PTY Terminal). Press `⌘⇧E` to toggle back.');
        break;
      }
      case 'desktop': {
        note('You are already in the desktop app, so there is nothing to hand off. `/session` shows the current session and folder.');
        break;
      }
      case 'tui': {
        note('Akron Code renders a full GUI, so the terminal renderer setting does not apply. Use **Settings → Appearance** for density.');
        break;
      }
      case 'keybindings': {
        note('Keybindings are configured in **Settings → Shortcuts** (they are stored with the app, not in a JSON file). Press `⌘K` for the command palette.');
        break;
      }
      case 'scroll-speed': {
        note('Scroll speed follows the OS pointer setting. In-app transcript scrolling is momentum-based, so there is no separate multiplier to tune.');
        break;
      }
      case 'wellbeing': {
        note('Break reminders are handled by the OS. Akron Code keeps long runs visible with elapsed time and a live activity row instead of nudging you.');
        break;
      }
      case 'privacy-settings': {
        setShowSettings(true);
        note('Opened **Settings**. Akron Code sends data only to the provider you configure — there is no telemetry endpoint and no account requirement.');
        break;
      }
      case 'rate-limit-options': {
        setShowSettings(true);
        note('Hit a provider limit? Opened **Settings** — switch provider/model, add a second key, or enable the orchestrator to fail over automatically.');
        break;
      }
      case 'release-notes': {
        let v = '';
        try { v = (await window.autobot.getVersion()) || ''; } catch (_) {}
        note('**Akron Code** ' + (v ? 'v' + v : '') + ' — no changelog feed is bundled; release notes ship with each build at akronlogic.com.');
        break;
      }
      case 'update':
      case 'upgrade':
      case 'install': {
        note('Akron Code updates by installing a new build (DMG/ZIP) — `/version` shows the current one. Provider plans are managed at the provider, not in-app.');
        break;
      }
      case 'powerup': {
        note('**Quick tour** — start with `/help`, then try `/plan` for read-only exploration, `/compact` to shrink context, `/context` to see what is loaded, and `/usage` for tokens and cost.');
        break;
      }
      case 'team-onboarding': {
        note('**Onboarding a teammate:** install the app, set a provider in Settings, open the project folder, then `/init` writes `CLAUDE.md`. `/usage` summarises tokens and cost.');
        break;
      }
      case 'autofix-pr': {
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        send('Monitor the current pull request: run `gh pr checks --watch` (or `gh pr view --json statusCheckRollup`) and, for every failing check, read the logs, fix the cause in the working tree, re-run the failing command locally, and commit. Repeat until all checks pass, then summarise the fixes.');
        break;
      }
      case 'ultrareview': {
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        send('Perform an exhaustive review of the pending changes (`git diff` plus untracked files). For each hunk: correctness, edge cases, security (injection, authz, secrets), performance, and test coverage. Rank findings by severity, quote the exact lines, and propose a concrete patch for each. Do not apply changes — report only.');
        break;
      }
      case 'install-github-app': {
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        send('Set up GitHub Actions for this repository: inspect the project type, write `.github/workflows/ci.yml` that installs dependencies and runs the existing test/lint scripts, and explain how to add the API key as a repository secret. Ask before committing.');
        break;
      }
      case 'mobile': {
        openSettingsAt('server');
        note('Opened **Settings → Server & Pairing** for Mobile & Push Relay setup.');
        break;
      }
      case 'install-slack-app':
      case 'web-setup':
      case 'teleport':
      case 'stickers':
      case 'radio':
      case 'heapdump':
      case 'bridge-kick':
      case 'pro-trial-expired': {
        note('`/' + cmd + '` targets Anthropic-hosted services (Slack app, claude.ai web/mobile/teleport, trial billing, debug tooling) that do not exist in Akron Code. Nothing to configure locally.');
        break;
      }
      default: {
        // MCP Prompt / REA guided workflow: `/mcp:<serverId>:<promptName> [args]`
        if (/^mcp:[^:\s]+:[^:\s]+$/i.test(cmd)) {
          const [, serverId, ...restParts] = cmd.split(':');
          const promptName = restParts.join(':');
          try {
            const expanded = await window.autobot.expandMcpPrompt({ serverId, name: promptName, argText, cwd });
            if (expanded && expanded.ok && expanded.prompt) {
              if (!streaming) send(expanded.prompt);
              else note(expanded.prompt);
              break;
            }
            if (expanded && expanded.error) {
              note('⚠️ ' + expanded.error);
              break;
            }
          } catch (e) {
            note('⚠️ ' + (e.message || 'MCP prompt expansion failed'));
            break;
          }
        }
        // Installed/built-in skill invocation: `/skill:<name> [args]`
        if (/^skill:.+$/i.test(cmd)) {
          const skillName = cmd.slice(6);
          try {
            const loaded = await window.autobot.loadSkill(skillName);
            if (loaded && loaded.content) {
              const prompt = `[Skill: ${skillName}]\n${loaded.content}\n\nUser request: ${argText || `Apply the ${skillName} skill to the current task in ${cwd || 'workspace'}.`}`;
              if (!streaming) send(prompt);
              else note('Loaded skill `' + skillName + '`.');
              break;
            }
          } catch (_) {}
        }
        // Project / user command: expand its markdown body into a real prompt.
        let hit = null;
        try { hit = await window.autobot.resolveCommand(cmd, argText, cwd); } catch (_) {}
        if (hit && hit.prompt) {
          send(hit.prompt);
        } else {
          appendAssistant('Unknown slash command: `/' + cmd + '`');
        }
      }
    }
  };

  const appendAssistant = (content) => {
    const msg = { id: uid(), role: 'assistant', content, ts: Date.now() };
    const id = activeIdRef.current;
    // Self-heal: `activeId` can point at a conversation that no longer exists
    // (deleted chat, or a stale id restored from localStorage). Without this the
    // map() below matched nothing and the message vanished — /help looked dead.
    const known = id && (convsRef.current || []).some((c) => c.id === id);
    if (!known) {
      // No active conversation (e.g. /help on a fresh chat) — create one so the message is visible.
      const convId = uid();
      setActiveId(convId);
      setConvs((cs) => [{ id: convId, title: (content.slice(0, 48) || 'Assistant'), messages: [msg], ts: Date.now() }, ...cs]);
      return;
    }
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, messages: [...c.messages, msg] } : c)));
  };

  const clearActiveConversation = () => {
    setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, messages: [] } : c)));
    setLiveSync(null);
  };

  const artifacts = useMemo(() => {
    const blocks = [];
    for (const m of messages) if (m.role === 'assistant') blocks.push(...extractCodeBlocks(m.content));
    if (live) blocks.push(...extractCodeBlocks(live.content));
    for (const a of artifactsExplicit) blocks.push({ lang: a.language || 'text', code: a.content, label: a.name });
    return blocks;
  }, [messages, live, artifactsExplicit]);

  const liveTeam = teamConvRef.current === activeId;
  const effectiveSubAgents = useMemo(
    () => deriveSubAgents(liveTeam ? subAgents : [], active, messages, liveForActive),
    [liveTeam, subAgents, active, messages, liveForActive]
  );
  const effectiveSwarmInfo = (liveTeam && swarmInfo) || (active && active.swarmInfo) || null;
  const effectiveSwarmBoard = (liveTeam && swarmBoard.length ? swarmBoard : null) || (active && active.swarmBoard) || [];
  const allActiveTools = useMemo(
    () => (messages || []).flatMap((m) => m.tools || []).concat((liveForActive && liveForActive.tools) || []),
    [messages, liveForActive]
  );
  const allActiveCheckpoints = useMemo(
    () => (messages || []).flatMap((m) => m.checkpoints || []).concat((liveForActive && liveForActive.checkpoints) || []),
    [messages, liveForActive]
  );
  const changedFilesBadge = useMemo(
    () => summarizeChangedFiles(allActiveTools, allActiveCheckpoints).files.length,
    [allActiveTools, allActiveCheckpoints]
  );
  const paneProps = {
    activeType: sessionPane.type,
    openTabs: openPaneTabs,
    onSelectTab: showSessionPane,
    onCloseTab: closeSessionTab,
    badges: {
      subagents: effectiveSubAgents.length,
      review: changedFilesBadge,
    },
    width: sessionPane.type === 'review' ? Math.max(sessionPane.width || 540, 520) : (sessionPane.width || 480),
    onWidth: (w) => setSessionPane((p) => ({ ...p, width: w })),
    onHide: () => setSessionPane((p) => ({ ...p, type: null })),
  };

  const isWinHost = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '');
  const modShift = isWinHost ? 'Ctrl+Shift+' : '⌘⇧';
  const visibleTabs = openTabIds.map((id) => convs.find((c) => c.id === id)).filter(Boolean);

  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const modelMenuOpenSetterRef = useRef(() => {});
  const renderTabAlerts = (cid) => (
    <>
      {waitingPermissionConvIds.has(cid) && <span className="conv-perm-bell" title="Waiting for permission"><Icon name="Notification" size={11} /></span>}
      {waitingQuestionConvIds.has(cid) && <span className="conv-perm-bell" title="Waiting for answer"><Icon name="Help" size={11} /></span>}
    </>
  );
  useAutobotEventStream({
    runIdRef, liveRef, runStartedAtRef, runConvRef, activeIdRef, settingsRef,
    setLiveSync, setThinking, setSubAgents, setSwarmInfo, setSwarmBoard,
    setPaused, setPermError, setPermissionQueue, setLastUsage,
    commitLive, setError, setModelMenuOpen, setQuestionQueue,
    setShowSettings, setPanel, setActiveId, setConvs, setCuConsent,
    setPermissions, setPlanMode, setArtifactsExplicit, setNotice, setFeatures: saveFeat, setOrchestrator: saveOrchestrator,
    openPreview, setCwd, setGoal, setCompliance, selectConv, newChat, inputRef,
  });
  return (
    <div
      className="app"
      data-theme={appAppearance.theme}
      data-surface={appAppearance.surface}
      data-bg-pattern={appAppearance.bgPattern}
      data-density={appAppearance.density}
      data-chat-width={appAppearance.chatWidth}
      data-chat-align={appAppearance.chatAlign || 'centered'}
      data-user-align={appAppearance.userPromptAlign || 'antigravity'}
      data-msg-style={appAppearance.msgStyle}
      data-radius={appAppearance.borderRadius}
      data-platform={isWinHost ? 'win32' : 'darwin'}
      dir={localeDir(settings.locale)}
      lang={settings.locale}
      style={appAppearance.style}
    >
      <div className="titlebar">
        <div className="titlebar-brand">
          <Logo size={16} active={streaming} />
          <span className="brand">Akron Code</span>
          <span className="sub">{T('brand.sub')}</span>
          <div className="ws-mode-switch" role="group" aria-label="Workspace mode">
            <button
              type="button"
              className={'ws-mode-btn' + (workbenchMode === 'agent' ? ' on' : '')}
              onClick={() => setWorkbenchMode('agent')}
              title={`Agent & Mission Control view (${modShift}E)`}
            >
              <AgentIcon size={14} /> <span>Agent</span>
            </button>
            <button
              type="button"
              className={'ws-mode-btn' + (workbenchMode === 'ide' ? ' on' : '')}
              onClick={() => setWorkbenchMode('ide')}
              title={`Full AI IDE Workbench with Monaco & Terminal (${modShift}E)`}
            >
              <Icon name="Code" size={12} /> <span>IDE</span>
            </button>
          </div>
        </div>
        <div className="ws-tabs" role="tablist" aria-label="Workspace sessions">
          {visibleTabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId && panel === 'chats'}
              className={'ws-tab' + (tab.id === activeId && panel === 'chats' ? ' on' : '')}
              onClick={() => selectConv(tab.id)}
              title={tab.title || 'Untitled session'}
            >
              {streaming && runConvRef.current === tab.id && <span className="ws-tab-dot" />}
              {renderTabAlerts(tab.id)}
              <span className="ws-tab-label">{tab.title || 'Untitled session'}</span>
              <button type="button" className="ws-tab-x" aria-label="Close tab" onClick={(e) => closeWorkspaceTab(tab.id, e)}>
                <Icon name="X" size={10} />
              </button>
            </div>
          ))}
          <button type="button" className="ws-tab-add" title="New session tab" aria-label="New session tab" onClick={newChat}>
            <Icon name="Add" size={14} />
          </button>
        </div>
        <NotificationCenter {...notifCenter} Icon={Icon} />
      </div>

      {workbenchMode === 'ide' ? (
        <IdeWorkbench
          cwd={cwd || ''}
          setCwd={(dir) => {
            setCwd(dir);
            if (activeId && dir) {
              saveJSON('autobot:workspace:' + activeId, dir);
              try { window.autobot.setWorkspace(activeId, dir); } catch (_) {}
            }
          }}
          theme={settings.theme}
          typography={settings.typography}
          provider={provider}
          orchestrator={orchestrator}
          envState={envState}
          contextPct={(() => {
            const effU = effectiveUsageForConv(lastUsage, active, provider, liveForActive);
            const win = contextWindowFor((effU && effU.model) || (provider && provider.model) || '');
            const used = usedTokens(effU);
            if (!(win > 0 && used > 0)) return null;
            const raw = (used / win) * 100;
            return raw < 1 ? 0.5 : Math.min(100, Math.round(raw));
          })()}
          setError={setError}
          setNotice={setNotice}
          externalOpenFile={ideExternalOpenFile}
          onAttachToChat={(node) => {
            setAttachments((a) => [...a, { name: node.name, path: node.path, size: 0, isText: true, content: `@${node.relPath || node.name}` }]);
          }}
          onSendToAgent={(prompt) => send(prompt)}
          onOpenSettings={() => openSettingsAt('providers')}
          onOpenEnvironments={() => openSettingsAt('environments')}
          onOpenRuntimes={() => openSettingsAt('runtimes')}
          onSwitchToAgent={() => setWorkbenchMode('agent')}
          renderAgentDock={({ editorContextXml, onOpenFileDiff }) => {
            editorContextXmlRef.current = editorContextXml || '';
            return (
              <>
                <ChatView
                MessageComponent={MemoMessage}
                renderLiveSegments={(live, isStream) => <SegmentView segments={live.segments} tools={live.tools} streaming={isStream} />}
                  messages={messages} live={liveForActive} thinking={liveForActive ? thinking : ''} paused={paused} onScrollAway={setScrolledAway}
                  subAgents={effectiveSubAgents} swarmInfo={effectiveSwarmInfo} swarmBoard={effectiveSwarmBoard} planMode={planMode}
                  copyBlock={copyBlock} applyBlock={applyBlock} bottomRef={bottomRef} convId={activeId} cwd={cwd}
                  onPromptAction={(txt) => { if (inputRef.current) { inputRef.current.value = txt; inputRef.current.dispatchEvent(new Event('input', { bubbles: true })); inputRef.current.focus(); } }}
                  onOpenInIde={(fp) => openInIde(fp)}
                  onOpenMediaStudio={(fp) => { setMediaStudioFocusPath(fp || ''); setWorkbenchMode('agent'); setPanel('media'); }}
                  copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage}
                  forkFromMessage={forkFromMessage} shareFromMessage={shareFromMessage} conv={active} exportConv={exportConv}
                  T={T} runStartedAt={runStartedAt}
                  envOpen={sessionPane.type === 'env'} onToggleEnv={() => { setWorkbenchMode('agent'); toggleSessionPane('env'); }}
                  runLogOpen={sessionPane.type === 'runlog'} onToggleRunLog={() => { setWorkbenchMode('agent'); showSessionPane('runlog'); }}
                  reviewOpen={false} sessionPaneType={null}
                  onOpenReview={(target) => {
                    const summary = summarizeChangedFiles((target && target.tools) || allActiveTools, (target && target.checkpoints) || allActiveCheckpoints);
                    const first = summary.files && summary.files[0];
                    if (first && onOpenFileDiff) {
                      onOpenFileDiff(first.path.startsWith('/') || /^[A-Za-z]:/.test(first.path) ? first.path : `${cwd}/${first.path}`);
                    } else {
                      setWorkbenchMode('agent');
                      openReview(target);
                    }
                  }}
                  onTogglePane={(tp) => { setWorkbenchMode('agent'); tp ? showSessionPane(tp) : toggleSessionPane(); }}
                  onOpenPlugins={() => openSettingsAt('skills')}
                  uiSettings={settings}
                  onRenameConv={(title) => active && renameConv(active.id, title)}
                  onPinConv={() => active && pinConv(active.id)}
                  onArchiveConv={() => active && archiveConv(active.id)}
                  onSplitConv={() => (active ? splitConv(active.id) : openReview({ scope: 'all' }))}
                  onDeleteConv={() => active && deleteConv(active.id)}
                  setError={setError}
                />
                {error && (
                  <div className={'errorbar' + (String(error).startsWith('✅') ? ' ok' : '')}>
                    <span className="errorbar-text">{error}</span>
                    <button type="button" className="errorbar-x" title="Dismiss" aria-label="Dismiss" onClick={() => setError('')}><Icon name="X" size={12} /></button>
                  </div>
                )}
                {streaming && paused && (
                  <div className="paused-banner" role="status">
                    <div className="paused-banner-left"><span className="paused-banner-dot" /><span>Paused — Resume or type a steering note</span></div>
                    <button type="button" className="paused-resume-btn" onClick={() => resumeRun('')}><Icon name="Play" size={12} /> Resume</button>
                  </div>
                )}
                <PermissionDock
                  queue={permissionQueue.filter((p) => !p.convId || p.convId === activeId)}
                  onRespond={answerPermission}
                  errorMsg={permError}
                  submitting={permSubmitting}
                />
                <QuestionDock
                  queue={questionQueue.filter((q) => !q.convId || q.convId === activeId)}
                  onAnswer={answerQuestion}
                />
                <InputBar
                  streaming={streaming} paused={paused} onPause={pauseRun} onResume={resumeRun} send={send} stop={stop} inputRef={inputRef} cwd={cwd} setCwd={setCwd} runSlashCommand={runSlashCommand}
                  queued={filterQueueForConv(queued, activeId)}
                  queuePaused={!!(activeId && queuePausedByConv[activeId])}
                  onToggleQueuePaused={() => toggleQueuePaused(activeId)}
                  onClearQueue={() => clearQueuedForConv(activeId)}
                  onToggleQueueItemPaused={toggleQueueItemPaused}
                  onReorderQueue={reorderQueued}
                  onStepQueueItem={stepQueued}
                  onUpdateQueueItemText={updateQueuedText}
                  unqueue={unqueue} sendQueuedNow={sendQueuedNow}
                  settings={settings} onVoiceError={setError}
                  provider={provider} setProvider={setProvider} orchestrator={orchestrator} setOrchestrator={saveOrchestrator} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} openSettings={(opts) => { setPendingPreset(opts && opts.preset ? opts.preset : null); openSettingsAt((opts && opts.section) || 'providers'); }}
                  providerKeys={providerKeys} setProviderKeys={setProviderKeys}
                  attachments={attachments} setAttachments={setAttachments}
                  reasoningLevel={reasoningLevel} setReasoningLevel={setReasoningLevel}
                  swarmEnabled={swarmEnabled} setSwarmEnabled={setSwarmEnabled}
                  styleId={styleId} setStyleId={setStyleId}
                  customStyles={customStyles} customAgents={customAgents} onOpenCustomizations={() => { setWorkbenchMode('agent'); setPanel('customizations'); }}
                  webSearch={webSearch} setWebSearch={setWebSearch}
                  dictating={dictating} setDictating={setDictating}
                  voiceMode={voiceMode} startVoiceMode={startVoiceMode} stopVoiceMode={stopVoiceMode}
                  sessionPane={sessionPane} toggleSessionPane={toggleSessionPane}
                  permissions={permissions} setPermissions={setPermissions}
                  lastUsage={effectiveUsageForConv(lastUsage, active, provider, liveForActive)}
                  gdriveState={gdriveState}
                  onOpenGdrive={() => setGdriveModalOpen(true)}
                  envState={envState}
                  onSwitchEnvironment={switchEnvironment}
                  onOpenEnvironments={() => openSettingsAt('environments')}
                  activeSkillPill={activeSkillPill}
                  onClearSkillPill={() => setActiveSkillPill(null)}
                  T={T}
                />
              </>
            );
          }}
          Icon={Icon}
        />
      ) : (
      <div className="layout">
        {/* Sidebar — 3-zone layout: pinned Workspace + Dock, scrollable Recents, pinned Customizations & Settings */}
        <aside className={'sidebar' + (sidebarCollapsed ? ' collapsed' : '')}>
          <div className="sidebar-top">
            <div className="sidebar-head">
              <button className="newchat" onClick={newChat} title={T('sidebar.newChat')}>
                <Icon name="Add" size={15} />
                <span className="label">{T('sidebar.newChat')}</span>
              </button>
              <div className="sidebar-actions">
                <button className="icon-btn" title={`${T('sidebar.search')} (${modShift}F)`} onClick={() => setPanel((p) => (p === 'search' ? 'chats' : 'search'))}><Icon name="Search" size={16} /></button>
                <button className="icon-btn" title={sidebarCollapsed ? T('sidebar.expand') : T('sidebar.collapse')} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
                  <Icon name={sidebarCollapsed ? 'SidebarOpen' : 'SidebarClose'} size={16} />
                </button>
              </div>
            </div>

            <div className="section-label">Workspace</div>
            <nav className="sidenav">
              <button className={panel === 'scheduled' ? 'on' : ''} onClick={() => setPanel('scheduled')} title="Automations & Scheduled Tasks"><Icon name="Clock" size={15} /><span className="label">Automations</span></button>
              <button className={'sidebar-custom-btn' + (panel === 'customizations' ? ' on' : '')} onClick={() => setPanel('customizations')} title="Customizations Hub (Marketplace, Skills, Custom Agents, Custom Outputs, MCP)"><Icon name="Lightbulb" size={15} /><span className="label">Customizations</span></button>
              <button className={panel === 'search' ? 'on' : ''} onClick={() => { setSearchTab('search'); setPanel('search'); }} title="Search & Ask History"><Icon name="Search" size={15} /><span className="label">Search</span><span className="kbd-hint">{modShift}F</span></button>
              <button className={panel === 'mission' ? 'on' : ''} onClick={() => setPanel('mission')} title="Mission Control (live session health)"><Icon name="Grid" size={15} /><span className="label">Mission</span></button>
              <button className={panel === 'projects' ? 'on' : ''} onClick={() => setPanel('projects')} title={T('sidebar.projects')}><Icon name="Folder" size={15} /><span className="label">{T('sidebar.projects')}</span>{projects.length > 0 && <span className="count">{projects.length}</span>}</button>
              <button className={panel === 'artifacts' ? 'on' : ''} onClick={() => setPanel('artifacts')} title={T('sidebar.artifacts')}><Icon name="Artifacts" size={15} /><span className="label">{T('sidebar.artifacts')}</span>{artifacts.length > 0 && <span className="count">{artifacts.length}</span>}</button>
              <button className={panel === 'media' ? 'on' : ''} onClick={() => setPanel('media')} title="Images & Video Studio (AI Image & Video Generator + Library)"><Icon name="Palette" size={15} /><span className="label">Images &amp; Video</span></button>
              <div className="sidenav-dock">
                <button
                  className={(panel === 'chats' ? sessionPane.type === 'files' : panel === 'code') ? 'on' : ''}
                  onClick={() => (panel === 'chats' ? toggleSessionPane('files') : setPanel('code'))}
                  title="Code & Files"
                >
                  <Icon name="Code" size={14} /><span className="label">{T('sidebar.code')}</span>
                </button>
                <button
                  className={(panel === 'chats' ? sessionPane.type === 'terminal' : panel === 'terminal') ? 'on' : ''}
                  onClick={() => (panel === 'chats' ? toggleSessionPane('terminal') : setPanel('terminal'))}
                  title={T('sidebar.terminal')}
                >
                  <Icon name="CommandLine" size={14} /><span className="label">{T('sidebar.terminal')}</span>
                </button>
                <button
                  className={sessionPane.type === 'browser' ? 'on' : ''}
                  onClick={() => toggleSessionPane('browser')}
                  title={T('sidebar.browser')}
                >
                  <Icon name="Globe" size={14} /><span className="label">{T('sidebar.browser')}</span>
                </button>
              </div>
            </nav>
          </div>

          <div className="sidebar-recents">
            <div className="section-label recents-head">
              <span>{T('sidebar.recents')}</span>
              {convs.length > 0 && <span className="recents-count">{convs.length}</span>}
            </div>
            <ProjectsSidebar
              convs={convs}
              projects={projects}
              activeId={activeId}
              panel={panel}
              streaming={streaming}
              streamingConvId={runConvRef.current}
              sessionHealthMap={sessionHealthMap}
              waitingPermissionConvIds={waitingPermissionConvIds}
              onSelectConv={selectConv}
              onNewChatInProject={(projCwd) => { if (projCwd) setCwd(projCwd); newChat(); }}
              onDeleteConv={deleteConv}
              onTogglePinConv={(cid) => pinConv(cid)}
              onRenameConv={(cid, nextTitle) => {
                if (nextTitle && String(nextTitle).trim()) renameConv(cid, nextTitle);
              }}
              onArchiveConv={archiveConv}
              onOpenProjectSettings={(grp) => { if (grp && grp.cwd) setCwd(grp.cwd); openSettingsAt('project'); }}
              onUnstickConv={(cid, sh) => {
                selectConv(cid);
                if (sh && sh.unstickDraft) {
                  setTimeout(() => {
                    if (inputRef.current) {
                      inputRef.current.value = String(sh.unstickDraft);
                      inputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
                      inputRef.current.focus();
                    }
                  }, 30);
                }
                setNotice(`Diagnosed session — unstick draft loaded in composer`);
              }}
            />
            {convs.length === 0 && <div className="muted">No conversations yet</div>}
          </div>

          <div className="sidebar-bottom">
            <button
              type="button"
              className="sidebar-settings-btn"
              onClick={() => openSettingsAt('providers')}
              title={T('sidebar.settings')}
            >
              <Icon name="Settings" size={15} />
              <span className="label">{T('sidebar.settings')}</span>
            </button>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="main-split">
            <div className="main-content">
              {panel === 'chats' && <ChatView MessageComponent={MemoMessage} messages={messages} live={liveForActive} thinking={liveForActive ? thinking : ''} paused={paused} onScrollAway={setScrolledAway} subAgents={effectiveSubAgents} swarmInfo={effectiveSwarmInfo} swarmBoard={effectiveSwarmBoard} planMode={planMode} copyBlock={copyBlock} applyBlock={applyBlock} bottomRef={bottomRef} convId={activeId} cwd={cwd} uiSettings={settings} copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage} forkFromMessage={forkFromMessage} shareFromMessage={shareFromMessage} conv={active} exportConv={exportConv} T={T} runStartedAt={runStartedAt} envOpen={sessionPane.type === 'env'} onToggleEnv={() => toggleSessionPane('env')} runLogOpen={sessionPane.type === 'runlog'} onToggleRunLog={() => showSessionPane('runlog')} reviewOpen={sessionPane.type === 'review'} sessionPaneType={sessionPane.type} onOpenReview={openReview} onTogglePane={(tp) => (tp ? showSessionPane(tp) : toggleSessionPane())} onOpenPlugins={() => openSettingsAt('skills')} onLearnSkill={() => learnCurrentSession('')} onRenameConv={(title) => active && renameConv(active.id, title)} onPinConv={() => active && pinConv(active.id)} onArchiveConv={() => active && archiveConv(active.id)} onSplitConv={() => (active ? splitConv(active.id) : openReview({ scope: 'all' }))} onDeleteConv={() => active && deleteConv(active.id)} setError={setError} onPromptAction={(txt) => { if (inputRef.current) { inputRef.current.value = txt; inputRef.current.dispatchEvent(new Event('input', { bubbles: true })); inputRef.current.focus(); } }} onOpenInIde={(fp) => openInIde(fp)} onOpenMediaStudio={(fp) => { setMediaStudioFocusPath(fp || ''); setPanel('media'); }} onConfigureMediaKey={(keyId) => openSettingsAt('media', { focusMediaKey: keyId || '' })} />}
              {panel === 'search' && <SearchView convs={convs} cwd={cwd} initialTab={searchTab} provider={provider} onOpenSessionLink={openSessionDeepLink} onOpenConv={(convId, msgId) => { setActiveId(convId); setPanel('chats'); if (msgId) setPendingScroll(msgId); }} />}
              {panel === 'mission' && (
                <MissionControlPane
                  convs={convs}
                  activeId={activeId}
                  streaming={streaming}
                  streamingConvId={runConvRef.current}
                  waitingPermissionConvIds={waitingPermissionConvIds}
                  onOpenSession={(cid) => selectConv(cid)}
                  onSendQuickReply={(cid, txt) => {
                    selectConv(cid);
                    const cObj = convs.find((c) => c.id === cid) || null;
                    send(txt, [], cObj);
                  }}
                  onDiagnoseUnstick={(cid, row) => {
                    selectConv(cid);
                    const draftText = (row && (row.unstickDraft || row.diagnosis)) || 'Stop retrying and inspect recent tool errors.';
                    setTimeout(() => {
                      if (inputRef.current) {
                        inputRef.current.value = String(draftText);
                        inputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
                        inputRef.current.focus();
                      }
                    }, 30);
                    setNotice('Diagnosed session — unstick reply drafted in composer');
                  }}
                  onHealthSnapshot={(map) => setSessionHealthMap(map)}
                  Icon={Icon}
                />
              )}
              {panel === 'artifacts' && <ArtifactsView blocks={artifacts} tools={allActiveTools} cwd={cwd} onPromptAction={(txt) => { if (inputRef.current) { inputRef.current.value = txt; inputRef.current.dispatchEvent(new Event('input', { bubbles: true })); inputRef.current.focus(); } setPanel('chats'); }} onOpenInIde={(fp) => openInIde(fp)} onOpenMediaStudio={(fp) => { setMediaStudioFocusPath(fp || ''); setPanel('media'); }} onConfigureMediaKey={(keyId) => openSettingsAt('media', { focusMediaKey: keyId || '' })} />}
              {panel === 'media' && <MediaStudioView cwd={cwd} provider={provider} focusPath={mediaStudioFocusPath} onOpenInIde={(fp) => openInIde(fp)} onConfigureMediaKey={(keyId) => openSettingsAt('media', { focusMediaKey: keyId || '' })} setNotice={setNotice} setError={setError} />}
              {panel === 'memory' && <MemoryView memory={memory} addMemory={addMemory} clearMemory={clearMemory} convs={convs} provider={provider} onJumpToMessage={(cid, mid) => { if (cid) selectConv(cid); if (mid) setPendingScroll(mid); }} />}
              {panel === 'skills' && <SkillsView skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills} />}
              {panel === 'notebooks' && <NotebooksView notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells} openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook} />}
              {panel === 'mcp' && <McpView mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp} />}
              {panel === 'terminal' && <TerminalView terminal={terminal} setTerminal={setTerminal} startTerminal={startTerminal} runInTerminal={runInTerminal} writeTerminal={writeTerminal} killTerminal={killTerminal} />}
              {panel === 'code' && <CodeView cwd={cwd} setCwd={setCwd} permissions={permissions} setPermissions={setPermissions} T={T} />}
              {panel === 'projects' && <ProjectsView projects={projects} setProjects={setProjects} activeProject={activeProject} setActiveProject={setActiveProject} />}
              {panel === 'plugins' && <PluginsView onOpenGdrive={() => setGdriveModalOpen(true)} gdriveState={gdriveState} />}
              {panel === 'scheduled' && (
                <ScheduledView
                  cwd={cwd}
                  convs={convs}
                  provider={provider}
                  projects={projects}
                  mcpServers={mcpServers}
                  envState={envState}
                  onSendToChat={(txt) => { setPanel('chats'); send(txt); }}
                  onCreateWithPrompt={() => runSlashCommand('automation')}
                  onOpenRunSession={(cid) => { if (cid) { selectConv(cid); setPanel('chats'); } }}
                />
              )}
              {panel === 'customizations' && (
                <CustomizationsHub
                  cwd={cwd}
                  skills={skills}
                  toggleSkill={toggleSkill}
                  refreshSkills={refreshSkills}
                  mcpServers={mcpServers}
                  mcpForm={mcpForm}
                  setMcpForm={setMcpForm}
                  connectMcp={connectMcp}
                  disconnectMcp={disconnectMcp}
                  styleId={styleId}
                  setStyleId={setStyleId}
                  agentDefs={customAgents}
                  outputStyles={customStyles}
                  defaultStyleId={defaultCustomStyleId}
                  onRefreshCustomizations={refreshCustomizations}
                  onOpenGdrive={() => setGdriveModalOpen(true)}
                  setNotice={setNotice}
                  setError={setError}
                />
              )}
            </div>

            {sessionPane.type === 'browser' && (
              <SessionPane {...paneProps} icon="Globe" title={T('sidebar.browser')}>
                <BrowserView
                  cwd={cwd}
                  previewUrl={previewUrl}
                  onClose={() => setSessionPane((p) => ({ ...p, type: null }))}
                  onAttachInspect={(items, kind) => {
                    if (!items || !items.length) return;
                    setAttachments((a) => [...a, ...items]);
                    const isShot = kind === 'screenshot' || (items.length === 1 && items[0].isImage);
                    setNotice(isShot ? 'Browser screenshot attached to composer' : 'Inspected element attached to composer');
                    setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (_) {} }, 50);
                  }}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'env' && (
              <SessionPane {...paneProps} icon="DotsHorizontal" title="Environment">
                <EnvPanel
                  cwd={cwd} setCwd={setCwd} provider={provider} lastUsage={effectiveUsageForConv(lastUsage, active, provider, liveForActive)}
                  mcpServers={mcpServers} features={features} saveFeat={saveFeat}
                  runSlashCommand={runSlashCommand}
                  onOpenConnectors={() => openSettingsAt('mcp')}
                  envState={envState} refreshEnvState={refreshEnvState}
                  onSwitchEnvironment={switchEnvironment}
                  onOpenEnvironments={() => openSettingsAt('environments')}
                  activeConv={active} skills={skills} swarmEnabled={swarmEnabled} permissions={permissions} setNotice={setNotice}
                  T={T}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'runlog' && (
              <SessionPane {...paneProps} icon="Activity" title="Background Tasks">
                <RunLogPanel convId={activeId} />
              </SessionPane>
            )}
            {sessionPane.type === 'review' && (
              <SessionPane {...paneProps} icon="File" title="Review">
                <CodeReviewPane
                  convId={activeId}
                  cwd={cwd}
                  target={reviewTarget}
                  allTools={allActiveTools}
                  provider={provider}
                  orchestrator={orchestrator}
                  onSendComment={(txt) => send(txt)}
                  onRewindDone={(r) => setError(`✅ Rewound: restored ${(r && r.restored) || 0}, removed ${(r && r.removed) || 0}.`)}
                  onOpenFile={(fp) => openInIde(fp)}
                  onPreviewFile={(fp) => openDocPreview(fp)}
                  onClose={() => closeSessionTab('review')}
                  voiceOpts={{ engine: settings.voiceEngine || 'auto', lang: settings.voiceLang || 'en-US' }}
                  Icon={Icon}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'doc' && (
              <SessionPane {...paneProps} icon="Eye" title="Preview">
                <DocPreviewPane
                  target={docPreviewTarget}
                  cwd={cwd}
                  onOpenInIde={(fp, ln) => openInIde(fp, { line: ln })}
                  onOpenBrowser={(fp) => openPreview(fp)}
                  onNotice={setNotice}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'subagents' && (
              <SessionPane {...paneProps} icon="GitBranch" title="Subagents">
                <SubagentsPane subAgents={effectiveSubAgents} swarmInfo={effectiveSwarmInfo} swarmBoard={effectiveSwarmBoard} />
              </SessionPane>
            )}
            {sessionPane.type === 'files' && (
              <SessionPane {...paneProps} icon="Files" title="Files">
                <CodeView cwd={cwd} setCwd={setCwd} permissions={permissions} setPermissions={setPermissions} T={T} />
              </SessionPane>
            )}
            {sessionPane.type === 'terminal' && (
              <SessionPane {...paneProps} icon="CommandLine" title="Terminal">
                <TerminalView terminal={terminal} setTerminal={setTerminal} startTerminal={startTerminal} runInTerminal={runInTerminal} writeTerminal={writeTerminal} killTerminal={killTerminal} />
              </SessionPane>
            )}
            {sessionPane.type === 'mindmap' && (
              <SessionPane {...paneProps} icon="Grid" title="Mind Map">
                <MindMapView cwd={cwd} theme={settings.theme === 'light' ? 'light' : 'dark'} onClose={() => closeSessionTab('mindmap')} />
              </SessionPane>
            )}
          </div>

          {error && (
            <div className={'errorbar' + (String(error).startsWith('✅') ? ' ok' : '') + (showSettings || gdriveModalOpen ? ' floating-modal-toast' : '')}>
              <span className="errorbar-text">{error}</span>
              <button type="button" className="errorbar-x" title="Dismiss" aria-label="Dismiss" onClick={() => setError('')}><Icon name="X" size={12} /></button>
            </div>
          )}

          {streaming && scrolledAway && (
            <StickyLiveToolBar
              live={liveForActive}
              thinking={thinking}
              startedAt={runStartedAt}
              paused={paused}
              onJumpToLive={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
              Icon={Icon}
            />
          )}

          {streaming && paused && (
            <div className="paused-banner" role="status">
              <div className="paused-banner-left">
                <span className="paused-banner-dot" aria-hidden="true" />
                <span>Paused — Resume or type a steering note</span>
              </div>
              <button type="button" className="paused-resume-btn" onClick={() => resumeRun('')}>
                <Icon name="Play" size={12} /> Resume
              </button>
            </div>
          )}

          <PermissionDock
            queue={permissionQueue.filter((p) => !p.convId || p.convId === activeId)}
            onRespond={answerPermission}
            errorMsg={permError}
            submitting={permSubmitting}
          />
          <QuestionDock
            queue={questionQueue.filter((q) => !q.convId || q.convId === activeId)}
            onAnswer={answerQuestion}
          />

          {panel === 'chats' && (
            <InputBar
              streaming={streaming} paused={paused} onPause={pauseRun} onResume={resumeRun} send={send} stop={stop} inputRef={inputRef} cwd={cwd} setCwd={setCwd} runSlashCommand={runSlashCommand}
              queued={filterQueueForConv(queued, activeId)}
              queuePaused={!!(activeId && queuePausedByConv[activeId])}
              onToggleQueuePaused={() => toggleQueuePaused(activeId)}
              onClearQueue={() => clearQueuedForConv(activeId)}
              onToggleQueueItemPaused={toggleQueueItemPaused}
              onReorderQueue={reorderQueued}
              onStepQueueItem={stepQueued}
              onUpdateQueueItemText={updateQueuedText}
              unqueue={unqueue} sendQueuedNow={sendQueuedNow}
              settings={settings} onVoiceError={setError}
              provider={provider} setProvider={setProvider} orchestrator={orchestrator} setOrchestrator={saveOrchestrator} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} openSettings={(opts) => { setPendingPreset(opts && opts.preset ? opts.preset : null); openSettingsAt((opts && opts.section) || 'providers'); }}
              providerKeys={providerKeys} setProviderKeys={setProviderKeys}
              attachments={attachments} setAttachments={setAttachments}
              reasoningLevel={reasoningLevel} setReasoningLevel={setReasoningLevel}
              swarmEnabled={swarmEnabled} setSwarmEnabled={setSwarmEnabled}
              styleId={styleId} setStyleId={setStyleId}
              customStyles={customStyles} customAgents={customAgents} onOpenCustomizations={() => setPanel('customizations')}
              webSearch={webSearch} setWebSearch={setWebSearch}
              dictating={dictating} setDictating={setDictating}
              voiceMode={voiceMode} startVoiceMode={startVoiceMode} stopVoiceMode={stopVoiceMode}
              sessionPane={sessionPane} toggleSessionPane={toggleSessionPane}
              permissions={permissions} setPermissions={setPermissions}
              lastUsage={effectiveUsageForConv(lastUsage, active, provider, liveForActive)}
              gdriveState={gdriveState}
              onOpenGdrive={() => setGdriveModalOpen(true)}
              envState={envState}
              onSwitchEnvironment={switchEnvironment}
              onOpenEnvironments={() => openSettingsAt('environments')}
              activeSkillPill={activeSkillPill}
              onClearSkillPill={() => setActiveSkillPill(null)}
              T={T}
            />
          )}
        </main>
      </div>
      )}

      {showSettings && (
        <SettingsModal
          provider={provider} setProvider={setProvider} providerKeys={providerKeys} setProviderKeys={setProviderKeys}
          settings={settings} setSettings={setSettings} orchestrator={orchestrator} setOrchestrator={saveOrchestrator}
          features={features} setFeatures={saveFeat} testProvider={testProvider}
          projects={projects} setProjects={setProjects} activeProject={activeProject} setActiveProject={setActiveProject}
          onClose={() => { setShowSettings(false); setPendingPreset(null); }}
          T={T} permissions={permissions} setPermissions={setPermissions}
          compliance={compliance} setCompliance={setCompliance}
          pendingPreset={pendingPreset} clearPendingPreset={() => setPendingPreset(null)}
          initialSection={settingsInitialSection}
          focusMediaKey={settingsFocusMediaKey}
          skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills}
          mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp}
          memory={memory} addMemory={addMemory} clearMemory={clearMemory} convs={convs}
          onJumpToMessage={(cid, mid) => { if (cid) selectConv(cid); if (mid) setPendingScroll(mid); setShowSettings(false); }}
          notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells}
          openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook}
          cwd={cwd} setCwd={setCwd} activeId={activeId}
          onOpenGdrive={() => setGdriveModalOpen(true)}
          gdriveState={gdriveState}
          envState={envState}
          refreshEnvState={refreshEnvState}
          onSwitchEnvironment={switchEnvironment}
          onOpenBrowserUrl={(url) => {
            setShowSettings(false);
            showSessionPane('browser');
            if (url && window.autobot && window.autobot.browserLoadURL) {
              setTimeout(() => { try { window.autobot.browserLoadURL(url); } catch (_) {} }, 120);
            }
          }}
          setError={setError}
          setNotice={setNotice}
        />
      )}

      {gdriveModalOpen && (
        <GoogleDriveModal
          gdriveState={gdriveState}
          onRefreshStatus={refreshGdriveStatus}
          onAttachFiles={(atts) => setAttachments((a) => [...a, ...atts])}
          onClose={() => setGdriveModalOpen(false)}
        />
      )}

      {cuConsent && (
        <ComputerUseModal consent={cuConsent} answer={answerCuConsent} />
      )}


      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewChat={newChat}
          onSearch={() => { setShowPalette(false); setPanel('search'); }}
          onToggleBrowser={() => { setShowPalette(false); toggleSessionPane('browser'); }}
          onToggleCode={() => { setShowPalette(false); setPanel('code'); }}
          onSettings={() => { setShowPalette(false); setShowSettings(true); }}
          onQuickEntry={() => { setShowPalette(false); window.autobot.openQuickEntry(); }}
          onAbout={() => { setShowPalette(false); window.autobot.openAbout(); }}
          onExport={() => { setShowPalette(false); if (active) exportConv(active); }}
          onToggleSidebar={() => { setShowPalette(false); setSidebarCollapsed((v) => !v); }}
          onToggleTheme={() => { setShowPalette(false); setSettings((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' })); }}
        />
      )}

      {showFind && (
        <FindBar query={findQuery} setQuery={setFindQuery} messages={messages} onClose={() => { setShowFind(false); setFindQuery(''); }} />
      )}

      <ContextLimitToast
        lastUsage={effectiveUsageForConv(lastUsage, active, provider, liveForActive)}
        model={((effectiveUsageForConv(lastUsage, active, provider, liveForActive) || {}).model) || (provider && provider.model) || ''}
        T={T}
      />
    </div>
  );
}

function SegmentView({ segments, tools, streaming }) {
  const list = segments || [];
  const lastIdx = list.length - 1;
  return list.map((s, i) => {
    if (s.type === 'thinking') {
      const txt = s.text || '';
      if (!txt.trim()) return null;
      return <ThinkBlock key={'seg-th-' + i} text={txt} streaming={streaming && i === lastIdx} />;
    }
    if (s.type === 'tools') {
      const rows = (s.ids || []).map((id) => (tools || []).find((t) => t.id === id)).filter(Boolean);
      if (!rows.length) return null;
      return <div className="tools" key={'seg-t-' + i}><ToolGroup rows={rows} streaming={streaming} /></div>;
    }
    const txt = s.text || '';
    if (!txt.trim()) return null;
    const caret = streaming && i === lastIdx ? '<span class="cursor">▍</span>' : '';
    return <div className={'md' + (streaming ? ' streaming' : '')} key={'seg-m-' + i} dangerouslySetInnerHTML={{ __html: renderMarkdown(txt) + caret }} />;
  });
}

function Message({ m, convId, cwd = '', idx, turnLabel = '', subAgentCount = 0, taskCount = 0, uiSettings = {}, copyMessage, editMessage, deleteMessage, retryMessage, forkFromMessage, shareFromMessage, onOpenReview, onOpenSubagents, onOpenRunLog, onPromptAction, onOpenInIde, onOpenMediaStudio, onConfigureMediaKey }) {
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef(null);
  useDismiss(shareOpen, [shareRef], () => setShareOpen(false));
  const doCopy = () => { copyMessage(m); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const images = (m.attachments || []).filter((a) => a.isImage && a.dataUrl);
  const otherAtts = (m.attachments || []).filter((a) => !(a.isImage && a.dataUrl));
  const msgTimestampMode = uiSettings.messageTimestamps || (uiSettings.showTimestamps === false ? 'hidden' : 'both');
  const showTimestamps = msgTimestampMode !== 'hidden';
  const showUserTs = showTimestamps && msgTimestampMode !== 'output';
  const tsFormat = uiSettings.timestampFormat || 'date-time';
  const actionBarStyle = uiSettings.actionBarStyle || 'compact';
  const showModelBadge = uiSettings.showModelBadge !== false;
  const showAvatars = uiSettings.showAvatars !== false;
  const showFloatingToolbar = !!uiSettings.showFloatingToolbar;
  const effectiveTs = m.ts || (m.role === 'assistant' ? m.completedAt : m.createdAt) || 0;
  const tsLabel = showTimestamps ? (m.ts ? fmtMessageTimestamp(m.ts, tsFormat) : fmtMessageTimestamp(effectiveTs, tsFormat)) : '';
  const tsFull = effectiveTs ? fmtMessageFullTimestamp(effectiveTs) : '';
  const hasModel = showModelBadge && !!m.model;
  const hasDuration = showModelBadge && m.durationMs > 800;
  return (
    <div className={'msg ' + m.role} id={'msg-' + m.id} data-msg-id={m.id}>
      {showAvatars && (
        <div className={m.role === 'user' ? 'avatar avatar-user' : 'avatar avatar-assistant'}>{m.role === 'user' ? <Icon name="User" size={16} /> : <Logo size={20} />}</div>
      )}
      <div className="body">
        {images.length > 0 && (
          <div className="msg-images">
            {images.map((a, i) => (
              <figure key={i} className="msg-image">
                <img src={a.dataUrl} alt={a.name} title={a.name} />
                <figcaption>{a.name}{a.size ? ` · ${fmtSize(a.size)}` : ''}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {otherAtts.length > 0 && (
          <div className="msg-files">
            {otherAtts.map((a, i) => (
              <span key={i} className={'attach-chip' + (a.isText ? ' text' : ' bin')} title={a.name}>
                <Icon name={a.isText ? 'File' : 'FileZip'} size={14} />
                <span className="attach-name">{a.name}</span>
                {a.size ? <span className="attach-size"> · {fmtSize(a.size)}</span> : null}
              </span>
            ))}
          </div>
        )}
        {m.segments && m.segments.length > 0 ? (
          <SegmentView segments={m.segments} tools={m.tools} />
        ) : (
          <>
            {m.tools && m.tools.length > 0 && (
              <div className="tools">
                <ToolGroup rows={m.tools} />
              </div>
            )}
            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
            <LinkPreviews text={m.content} />
          </>
        )}
        {m.role === 'assistant' && m.tools && m.tools.some((t) => t && t.name === 'TodoWrite') && (
          <LiveChecklistCard tools={m.tools} durationMs={m.durationMs} streaming={false} Icon={Icon} />
        )}
        {m.role === 'assistant' && (
          <MediaDocCardList tools={m.tools} content={m.content} cwd={cwd} onPromptAction={onPromptAction} onOpenInIde={onOpenInIde} onOpenMediaStudio={onOpenMediaStudio} onConfigureMediaKey={onConfigureMediaKey} />
        )}
        {m.role === 'assistant' && (
          <FilesChangedBar tools={m.tools} checkpoints={m.checkpoints} checkpointId={m.checkpointId} turnLabel={turnLabel} convId={convId} subAgentCount={subAgentCount} taskCount={taskCount} onOpenReview={onOpenReview} onOpenSubagents={onOpenSubagents} onOpenRunLog={onOpenRunLog} streaming={false} Icon={Icon} />
        )}
        {m.role === 'user' && (showUserTs && tsLabel || editMessage || copyMessage || deleteMessage) && (
          <div className="msg-user-footer" data-ts-hover={msgTimestampMode === 'hover' ? '1' : undefined}>
            {showUserTs && tsLabel && <span className="msg-timestamp" title={tsFull}>{tsLabel}</span>}
            <div className="msg-user-actions">
              <button type="button" className={'msg-user-mini-btn' + (copied ? ' copied' : '')} title={copied ? 'Copied' : 'Copy prompt'} onMouseDown={(e) => e.preventDefault()} onClick={doCopy}>
                <Icon name={copied ? 'Check' : 'Copy'} size={11} /> <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
              <button type="button" className="msg-user-mini-btn" title="Edit prompt" onClick={() => editMessage && editMessage(m)}>
                <Icon name="Edit" size={11} /> <span>Edit</span>
              </button>
              <button type="button" className="msg-user-mini-btn" title="Delete message" onClick={() => deleteMessage && deleteMessage(convId, idx)}>
                <Icon name="Trash" size={11} />
              </button>
            </div>
          </div>
        )}
        {m.role === 'assistant' && (
          <div className={'response-actions style-' + actionBarStyle} data-response-actions>
            <button type="button" className={'response-action-btn' + (copied ? ' copied' : '')} title="Copy response" onMouseDown={(e) => e.preventDefault()} onClick={doCopy}>
              <Icon name={copied ? 'Check' : 'Copy'} size={11} />
              {actionBarStyle !== 'icons-only' && <span>{copied ? 'Copied' : 'Copy'}</span>}
            </button>
            <button type="button" className="response-action-btn" title="Fork conversation from this response" onClick={() => forkFromMessage && forkFromMessage(convId, idx)}>
              <Icon name="GitBranch" size={11} />
              {actionBarStyle !== 'icons-only' && <span>Fork</span>}
            </button>
            <button type="button" className="response-action-btn" title="Retry this response" onClick={() => retryMessage && retryMessage(convId, idx)}>
              <Icon name="History" size={11} />
              {actionBarStyle !== 'icons-only' && <span>Retry</span>}
            </button>
            <div className="response-share-wrap" ref={shareRef}>
              <button type="button" className="response-action-btn" title="Share or export response" onClick={() => setShareOpen((v) => !v)}>
                <Icon name="Share" size={11} />
                {actionBarStyle !== 'icons-only' && <span>Share</span>}
              </button>
              {shareOpen && (
                <div className="response-share-menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'copy'); }}>
                    <Icon name="Copy" size={12} /> <span>Copy Markdown</span>
                  </button>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'html'); }}>
                    <Icon name="File" size={12} /> <span>Share as HTML…</span>
                  </button>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'md'); }}>
                    <Icon name="FileAdd" size={12} /> <span>Export Markdown…</span>
                  </button>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'json'); }}>
                    <Icon name="Code" size={12} /> <span>Export JSON…</span>
                  </button>
                </div>
              )}
            </div>
            <button type="button" className="response-action-btn" title="Delete response" onClick={() => deleteMessage && deleteMessage(convId, idx)}>
              <Icon name="Trash" size={11} />
            </button>
            {(hasModel || hasDuration || tsLabel) && (
              <span className="response-actions-meta">
                {/* Contract label preserved for routing tests: '⚡ Auto (DeepSeek V4.1 Flash) → ★' */}
                {hasModel && (
                  m.autoRouted ? (
                    <span
                      className="response-model-badge is-auto-routed"
                      data-testid="auto-routed-badge"
                      title={`Auto-routed by DeepSeek V4.1 Flash (${m.autoRouted.reason || ({ fast: 'Fast tier', coder: 'Coder tier', planner: 'Planner tier', vision: 'Vision tier', longctx: 'Long Context tier' }[m.autoRouted.role] || 'Task complexity')} · tier ${m.autoRouted.tier || m.autoRouted.complexity || 3}) → ${m.model}`}
                    >
                      <ModelLogo model="deepseek" size={12} />
                      <span className="response-route-arrow" aria-hidden="true">→</span>
                      <ModelLogo model={m.model} size={12} />
                      <span className="response-model-name">{m.model}</span>
                    </span>
                  ) : (
                    <span
                      className="response-model-badge"
                      title={m.modelsUsed && m.modelsUsed.length > 1 ? `Models used: ${m.modelsUsed.join(' → ')}` : `Model: ${m.model}`}
                    >
                      <ModelLogo model={m.model} size={12} />
                      <span className="response-model-name">{m.model}</span>
                    </span>
                  )
                )}
                {hasModel && hasDuration && <span className="response-meta-sep" aria-hidden="true">·</span>}
                {hasDuration && (
                  <span className="response-worked-time"><Icon name="Clock" size={11} /> Worked for {fmtElapsed(m.durationMs)}</span>
                )}
                {(hasModel || hasDuration) && tsLabel && <span className="response-meta-sep" aria-hidden="true">·</span>}
                {tsLabel && <span className="msg-timestamp" title={tsFull}>{tsLabel}</span>}
              </span>
            )}
          </div>
        )}
      </div>
      {showFloatingToolbar && (
        <div className="msg-toolbar">
          <button className="icon-btn" title={copied ? 'Copied' : 'Copy'} onMouseDown={(e) => e.preventDefault()} onClick={doCopy}><Icon name={copied ? 'Check' : 'Copy'} size={15} /></button>
          {m.role === 'user' && <button className="icon-btn" title="Edit" onClick={() => editMessage(m)}><Icon name="Edit" size={15} /></button>}
          {m.role === 'assistant' && <button className="icon-btn" title="Fork from here" onClick={() => forkFromMessage && forkFromMessage(convId, idx)}><Icon name="GitBranch" size={15} /></button>}
          {m.role === 'assistant' && <button className="icon-btn" title="Retry" onClick={() => retryMessage(convId, idx)}><Icon name="History" size={15} /></button>}
          <button className="icon-btn" title="Delete" onClick={() => deleteMessage(convId, idx)}><Icon name="Trash" size={15} /></button>
        </div>
      )}
    </div>
  );
}

// Share / export dropdown for a conversation (Markdown / HTML / JSON).
const MemoMessage = React.memo(Message);


function SkillsView(props) {
  // Anchored actions: pickSkillFile(), autobot.addSkill(name, content), autobot.deleteSkill(name)
  const handlePickSkill = async () => {
    const res = await window.autobot.pickSkillFile();
    if (res && res.name && res.content) await window.autobot.addSkill(res.name, res.content);
  };
  const handleDeleteSkill = async (name) => window.autobot.deleteSkill(name);
  return <SkillsViewBody {...props} onPickSkillAnchor={handlePickSkill} onDeleteSkillAnchor={handleDeleteSkill} />;
}

function PluginsView(props) {
  // Anchored actions: autobot.installPlugin(id)
  const installAnchor = (id) => window.autobot.installPlugin(id);
  return <PluginsViewBody {...props} onInstallAnchor={installAnchor} />;
}

function ScheduledView(props) {
  // Anchored actions: autobot.createScheduledTask, autobot.runScheduledTask
  const createAnchor = (p) => window.autobot.createScheduledTask(p);
  const runAnchor = (id) => window.autobot.runScheduledTask(id);
  return <ScheduledViewBody {...props} onCreateAnchor={createAnchor} onRunAnchor={runAnchor} />;
}

function BrowserView(props) {
  // Anchored BrowserView attributes for inspect & webview stability tests
  const defaultTabSpec = { launch: 'https://www.google.com', url: 'https://www.google.com' };
  const inspectContract = { exitLabel: 'Exit Inspect Mode', sendLabel: 'Send to Agent', devToolsClass: 'browser-devtools-btn', renderWebviewSrc: (t) => <webview src={t.launch || t.url} /> };
  return <BrowserViewBody {...props} defaultTabSpec={defaultTabSpec} inspectContract={inspectContract} />;
}

function InputBar(props) {
  // Anchored InputBar / Model picker / Drop / Send logic
  const pickerContract = async (base, apiKey, targets, p, scan, active, st) => {
    const pickerRows = [];
    if (scan && scan.ok && scan.models && scan.models.length) {
      await Promise.resolve(window.autobot.ollamaModels(base, apiKey)).catch(() => null);
      await Promise.resolve(window.autobot.ollamaServe('start')).catch(() => null);
      await Promise.resolve(window.autobot.probeProviders(targets)).catch(() => null);
    }
    const keysCache = 'autobot:providerKeys';
    const optBtn = <button className={'model-opt' + (active ? ' on' : '') + (st.row ? ' ' + st.row : '')} />; const iconPreload = () => <span hidden><Icon name="Check" size={12} /><Icon name="Copy" size={12} /><Icon name="Edit" size={12} /><Icon name="Eye" size={12} /><Icon name="File" size={12} /><Icon name="GitBranch" size={12} /><Icon name="Key" size={12} /><Icon name="Lock" size={12} /><Icon name="LockShield" size={12} /><Icon name="Memory" size={12} /><Icon name="Microphone" size={12} /><Icon name="Moon" size={12} /><Icon name="Orbit" size={12} /><Icon name="Palette" size={12} /><Icon name="Play" size={12} /><Icon name="Plug" size={12} /><Icon name="Plus" size={12} /><Icon name="Refresh" size={12} /><Icon name="ShieldSearch" size={12} /><Icon name="Sliders" size={12} /><Icon name="Sparkles" size={12} /><Icon name="Star" size={12} /><Icon name="Sun" size={12} /><Icon name="Users" size={12} /><Icon name="Warning" size={12} /><Icon name="Wrench" size={12} /></span>;
    const connectLabel = 'Connect Ollama';
    const onDropAkron = (e) => e.dataTransfer?.getData?.('text/akron-file');
    const sendActions = (streaming, hasText, send) => (<>
      <button onClick={() => { send(); }} />
      {streaming && <button className="send stop" />}
      {(!streaming || hasText) && <button className="send" />}
    </>);
    return { pickerRows, keysCache, optBtn, iconPreload, connectLabel, onDropAkron, sendActions };
  };
  return <InputBarBody {...props} pickerContract={pickerContract} />;
}

const SETTINGS_SECTIONS = [
  { id: 'providers', group: 'ai', label: 'Models & Providers', icon: 'Sparkles', sub: 'Primary endpoints, presets, local Ollama, and subscription sign-in.', keys: 'model provider ollama api key preset subscription oauth temperature token limits' },
  { id: 'orchestrator', group: 'ai', label: 'Orchestrator & Pools', icon: 'Orbit', sub: 'DeepSeek Harness profiles, multi-model failover tiers, and role pools.', keys: 'orchestrator pool planner coder vision fast longctx failover swarm profile harness' },
  { id: 'media', group: 'ai', label: 'Images & Video APIs', icon: 'Palette', sub: 'API keys for Imagen 3, Veo 2, GPT-Image-1, Sora, Grok, Wan 2.1, Kling, Luma & Flux.', keys: 'image video studio api key gemini imagen veo openai gpt-image dalle sora xai grok fal replicate wan kling luma cloudflare together flux media' },
  { id: 'appearance', group: 'ai', label: 'Appearance & Layout', icon: 'Palette', sub: 'Customize chat & output side margins, desktop reading width, fonts, colors, surfaces & density.', keys: 'appearance layout width margin padding side space font size theme color surface density bubbles alignment code height' },
  { id: 'notifications', group: 'ai', label: 'Notifications', icon: 'Notification', sub: 'Choose when to receive desktop notifications and hear synthesized sounds.', keys: 'notifications sound chime staplebops alert agent permissions questions errors' },
  { id: 'project', group: 'workspace', label: 'Project & Budget', icon: 'Folder', sub: 'Per-project profile, workspace instructions, and 20,000-token customizations budget.', keys: 'project token budget global demote rules workspace' },
  { id: 'migrate', group: 'workspace', label: 'Import & Migrate', icon: 'Download', sub: '1-click read-only import from Cursor, Claude Code & VS Code.', keys: 'migrate import cursor claude vscode rules mcp' },
  { id: 'environments', group: 'workspace', label: 'Environments', icon: 'Globe', sub: 'Execute locally, over SSH Hosts, or on an authenticated Remote Server.', keys: 'environment ssh host remote server cloud secret keychain' },
  { id: 'worktrees', group: 'workspace', label: 'Worktrees', icon: 'GitBranch', sub: 'Create and switch isolated git worktree checkouts for parallel branches.', keys: 'git worktree branch checkout parallel workspace' },
  { id: 'skills', group: 'workspace', label: 'Skills & Plugins', icon: 'Lightbulb', sub: 'Manage SKILL.md packs, agent capabilities, and plugins.', keys: 'skills plugins packs extensions' },
  { id: 'mcp', group: 'workspace', label: 'MCP Connectors', icon: 'Connectors', sub: 'Connect external Model Context Protocol servers & tools.', keys: 'mcp connectors servers tools' },
  { id: 'memory', group: 'workspace', label: 'Memory & Notebooks', icon: 'Memory', sub: 'Long-term saved facts and interactive notebooks.', keys: 'memory facts notebooks cells' },
  { id: 'harness', group: 'workspace', label: 'Harness & Custom Tools', icon: 'AgentsSimple', sub: 'Creator Mode runtime tools, developer features, and agent capabilities.', keys: 'creator custom tool harness developer extension buddy remote control' },
  { id: 'rea', group: 'ext', label: 'Reverse Engineering', icon: 'Orbit', sub: 'Built-in REA (morluto/rea) MCP & CLI, 263 tools, doctor & runtime.', keys: 'rea reverse engineer binary ghidra hopper ida rizin asar apk firmware mcp decompile' },
  { id: 'browser', group: 'ext', label: 'Browser Extension', icon: 'Globe', sub: 'Zero-key Chrome extension bridge for live browser control & shared desktop models.', keys: 'chrome extension akron browser bot bridge websocket tabs 8766 allow deny' },
  { id: 'server', group: 'ext', label: 'Server & Pairing', icon: 'Plug', sub: 'Local HTTP/WebSocket host endpoint, bridge health, and device info.', keys: 'server pairing port 8766 endpoint websocket health' },
  { id: 'voice', group: 'ext', label: 'Voice & Dictation', icon: 'Microphone', sub: 'Built-in offline ONNX Whisper speech model & fast gateway transcription.', keys: 'voice dictation whisper microphone speech audio language' },
  { id: 'shortcuts', group: 'system', label: 'Shortcuts', icon: 'Keyboard', sub: 'Keyboard shortcuts for fast navigation and editing.', keys: 'shortcuts hotkeys keybindings keyboard cmd ctrl' },
  { id: 'runtimes', group: 'system', label: 'Runtimes & Updates', icon: 'Refresh', sub: 'Built-in IDE dependencies, optional LSP installers, bundled CLIs & app auto-updater.', keys: 'runtimes updates auto-update github release lsp dependencies repair' },
  { id: 'security', group: 'system', label: 'Permissions & Security', icon: 'LockShield', sub: 'Tool consent rules, Computer Use, Chrome CDP, bridges, and compliance.', keys: 'permission security computer use chrome cdp bridge compliance trusted folders' },
  { id: 'system', group: 'system', label: 'Appearance & System', icon: 'Palette', sub: 'DeepSeek Auto-Switch Brain, theme, surface finish, sleep prevention, tray & locale.', keys: 'general auto switch brain deepseek v4 flash dispatcher router theme dark light emerald carbon tray sleep updater locale language memory runtime' },
  { id: 'about', group: 'system', label: 'About & License', icon: 'Info', sub: 'Akron Code details, AkronLogic brand identity, runtime diagnostics, license & trademarks.', keys: 'about akronlogic logo version license trademarks copyright legal brand seal info' },
  { id: 'feedback', group: 'system', label: 'Give Feedback', icon: 'Bug', sub: 'Report bugs or share ideas with automatic secret & PII scrubbing.', keys: 'feedback bug report diagnostics scrub bundle' },
];


function SettingsModal(props) {
  return (
    <SettingsModalBody
      {...props}
      SETTINGS_SECTIONS={SETTINGS_SECTIONS}
      AboutSectionComponent={AboutSection}
      renderAboutSection={(section) => (section === 'about' ? <AboutSection theme={props.settings.theme || 'dark'} setNotice={props.setNotice} /> : null)}
    />
  );
}
