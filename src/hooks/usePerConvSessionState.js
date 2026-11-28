import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  DRAFT_CONV_KEY,
  resolveConvSessionConfig,
  updateConvSessionConfig,
  buildEffectiveOrchestratorForSession,
} from '../utils/sessionModelState.js';
import { ORCH_SETUP_NOTICE, hasConfiguredOrchestratorModels } from '../utils/tutorialPresets.js';
import { extractPersistedSettings, mergeBootSettings, reconcileBootProvider, syncProviderForOrchestratorToggle, mergeBootUiState } from '../utils/settingsPersistence.js';
import { DEFAULT_APPEARANCE_SETTINGS, UI_DESIGN_PREFS_KEY } from '../components/settings/ExtendedSettingsPanels.jsx';
import { DEFAULT_PROVIDER, PRESETS, loadJSON, saveJSON } from '../utils/appHelpers.jsx';
import { hydrateProvider } from '../providerhydrate.mjs';
import { normBase } from '../providerstatus-ui.mjs';
import { normalizeTypography } from '../typography.js';

export function usePerConvSessionState({
  activeId,
  activeIdRef,
  convs,
  convsRef,
  provider,
  setProvider,
  providerRef,
  orchestrator,
  orchRef,
  saveOrchestrator,
  swarmEnabled,
  swarmRef,
  cwd,
  setCwd,
  cwdRef,
  settingsAdopted,
  setNotice,
  setSettingsInitialSection,
  setShowSettings,
}) {
  const [sessionConfigs, setSessionConfigs] = useState(() => loadJSON('autobot:sessionConfigs', {}));
  const sessionConfigsRef = useRef(sessionConfigs);
  sessionConfigsRef.current = sessionConfigs;
  const [cwdByConv, setCwdByConv] = useState({});
  const cwdByConvRef = useRef(cwdByConv);
  cwdByConvRef.current = cwdByConv;

  useEffect(() => {
    if (!settingsAdopted) return;
    saveJSON('autobot:sessionConfigs', sessionConfigs);
  }, [sessionConfigs, settingsAdopted]);

  const getSessionBundle = useCallback((cid) => {
    const defaults = {
      provider: providerRef.current,
      orchestrator: orchRef.current,
      swarmEnabled: swarmRef.current,
    };
    const cfg = resolveConvSessionConfig({
      convId: cid || null,
      sessionConfigs: sessionConfigsRef.current,
      convs: convsRef.current,
      defaults,
    });
    return {
      cfg,
      provider: cfg.provider || providerRef.current,
      orchestrator: buildEffectiveOrchestratorForSession(orchRef.current, cfg),
      swarmEnabled: typeof cfg.swarmEnabled === 'boolean' ? cfg.swarmEnabled : swarmRef.current,
    };
  }, [providerRef, orchRef, swarmRef, convsRef]);

  const activeSessionBundle = useMemo(() => {
    const defaults = { provider, orchestrator, swarmEnabled };
    const cfg = resolveConvSessionConfig({
      convId: activeId || null,
      sessionConfigs,
      convs,
      defaults,
    });
    return {
      cfg,
      provider: cfg.provider || provider,
      orchestrator: buildEffectiveOrchestratorForSession(orchestrator, cfg),
      swarmEnabled: typeof cfg.swarmEnabled === 'boolean' ? cfg.swarmEnabled : swarmEnabled,
    };
  }, [activeId, sessionConfigs, convs, provider, orchestrator, swarmEnabled]);

  const activeProvider = activeSessionBundle.provider;
  const activeOrchestrator = activeSessionBundle.orchestrator;
  const activeSwarmEnabled = activeSessionBundle.swarmEnabled;
  const activeCwd = (activeId && cwdByConv[activeId]) || activeSessionBundle.cfg.cwd || cwd;
  const reasoningLevel = activeProvider.reasoningLevel || 'auto';

  const setSessionProvider = useCallback((nextOrFn, targetConvId = activeIdRef.current) => {
    const cid = targetConvId || null;
    const defaults = { provider: providerRef.current, orchestrator: orchRef.current, swarmEnabled: swarmRef.current };
    setSessionConfigs((prev) => {
      const updated = updateConvSessionConfig(prev, cid, (cur) => {
        const nextProv = typeof nextOrFn === 'function' ? nextOrFn(cur.provider) : nextOrFn;
        return { ...cur, provider: nextProv };
      }, defaults);
      sessionConfigsRef.current = updated;
      return updated;
    });
  }, [activeIdRef, providerRef, orchRef, swarmRef]);

  const setReasoningLevel = useCallback((lv) => {
    setSessionProvider((p) => ({ ...p, reasoningLevel: lv }));
  }, [setSessionProvider]);

  const setSessionSwarmEnabled = useCallback((nextOrFn, targetConvId = activeIdRef.current) => {
    const cid = targetConvId || null;
    const defaults = { provider: providerRef.current, orchestrator: orchRef.current, swarmEnabled: swarmRef.current };
    setSessionConfigs((prev) => {
      const updated = updateConvSessionConfig(prev, cid, (cur) => {
        const nextVal = typeof nextOrFn === 'function' ? nextOrFn(cur.swarmEnabled) : nextOrFn;
        return { ...cur, swarmEnabled: Boolean(nextVal) };
      }, defaults);
      sessionConfigsRef.current = updated;
      return updated;
    });
  }, [activeIdRef, providerRef, orchRef, swarmRef]);

  const setSessionCwd = useCallback((nextOrFn, targetConvId = activeIdRef.current) => {
    const cid = targetConvId || null;
    const prevDir = (cid && cwdByConvRef.current[cid]) || cwdRef.current || '';
    const dir = typeof nextOrFn === 'function' ? nextOrFn(prevDir) : nextOrFn;
    if (typeof dir !== 'string') return;
    if (cid) {
      setCwdByConv((m) => (m[cid] === dir ? m : { ...m, [cid]: dir }));
      saveJSON('autobot:workspace:' + cid, dir);
      if (dir) { try { window.autobot.setWorkspace?.(cid, dir); } catch (_) {} }
    } else {
      const defaults = { provider: providerRef.current, orchestrator: orchRef.current, swarmEnabled: swarmRef.current };
      setSessionConfigs((prev) => {
        const updated = updateConvSessionConfig(prev, null, { cwd: dir }, defaults);
        sessionConfigsRef.current = updated;
        return updated;
      });
    }
    if (!cid || cid === activeIdRef.current) setCwd(dir);
  }, [activeIdRef, cwdRef, providerRef, orchRef, swarmRef, setCwd]);

  const saveSessionOrchestrator = useCallback((nextOrFn, opts = {}, targetConvId = activeIdRef.current) => {
    const cid = targetConvId || null;
    const defaults = { provider: providerRef.current, orchestrator: orchRef.current, swarmEnabled: swarmRef.current };
    const curCfg = resolveConvSessionConfig({ convId: cid, sessionConfigs: sessionConfigsRef.current, convs: convsRef.current, defaults });
    const prev = buildEffectiveOrchestratorForSession(orchRef.current, curCfg);
    const next = typeof nextOrFn === 'function' ? nextOrFn(prev) : nextOrFn;
    if (!next || typeof next !== 'object') return;
    if (!prev?.enabled && next.enabled && !(opts && opts.allowUnconfigured) && !hasConfiguredOrchestratorModels(next)) {
      setNotice(ORCH_SETUP_NOTICE);
      setSettingsInitialSection('orchestrator');
      setShowSettings(true);
      return;
    }
    setSessionConfigs((prevMap) => {
      const updated = updateConvSessionConfig(prevMap, cid, (cur) => {
        const curEff = buildEffectiveOrchestratorForSession(orchRef.current, cur);
        const patch = {
          ...cur,
          orchEnabled: Boolean(next.enabled),
          orchActiveIndex: typeof next.activeIndex === 'number' ? next.activeIndex : cur.orchActiveIndex,
          executorModel: typeof next.executorModel === 'string' ? next.executorModel : cur.executorModel,
        };
        if (!curEff?.enabled && next.enabled && !(opts && opts.keepSwarmState)) patch.swarmEnabled = true;
        if (!(opts && opts.skipProviderSync) && Boolean(next.enabled) !== Boolean(curEff && curEff.enabled)) {
          patch.provider = syncProviderForOrchestratorToggle(cur.provider, next, curEff);
        }
        return patch;
      }, defaults);
      sessionConfigsRef.current = updated;
      return updated;
    });
  }, [activeIdRef, providerRef, orchRef, swarmRef, convsRef, setNotice, setSettingsInitialSection, setShowSettings]);

  const setProviderFromSettings = useCallback((nextOrFn) => {
    setProvider(nextOrFn);
    setSessionProvider(nextOrFn, activeIdRef.current);
  }, [setProvider, setSessionProvider, activeIdRef]);

  const saveOrchestratorFromSettings = useCallback((nextOrFn, opts = {}) => {
    const prevGlobal = orchRef.current;
    const nextGlobal = typeof nextOrFn === 'function' ? nextOrFn(prevGlobal) : nextOrFn;
    saveOrchestrator(nextGlobal, opts);
    if (!nextGlobal || typeof nextGlobal !== 'object') return;
    const activeCid = activeIdRef.current;
    if (!activeCid && !sessionConfigsRef.current[DRAFT_CONV_KEY]) return;
    saveSessionOrchestrator((curOrch) => ({
      ...nextGlobal,
      enabled: Boolean(nextGlobal.enabled) !== Boolean(prevGlobal && prevGlobal.enabled) ? Boolean(nextGlobal.enabled) : curOrch.enabled,
      activeIndex: typeof nextGlobal.activeIndex === 'number' ? nextGlobal.activeIndex : curOrch.activeIndex,
      executorModel: typeof nextGlobal.executorModel === 'string' ? nextGlobal.executorModel : curOrch.executorModel,
    }), opts, activeCid);
  }, [orchRef, activeIdRef, saveOrchestrator, saveSessionOrchestrator]);

  const promoteDraftSessionConfig = useCallback((convId, cfg) => {
    const defaults = { provider: providerRef.current, orchestrator: orchRef.current, swarmEnabled: swarmRef.current };
    setSessionConfigs((prev) => {
      const withConv = updateConvSessionConfig(prev, convId, cfg, defaults);
      const { [DRAFT_CONV_KEY]: _dropDraft, ...rest } = withConv;
      sessionConfigsRef.current = rest;
      return rest;
    });
  }, [providerRef, orchRef, swarmRef]);

  const resetDraftSessionConfig = useCallback((autoRoutingForNew) => {
    setSessionConfigs((prev) => {
      const defaults = { provider: providerRef.current, orchestrator: orchRef.current, swarmEnabled: swarmRef.current };
      const { [DRAFT_CONV_KEY]: _old, ...rest } = prev || {};
      const nextMap = autoRoutingForNew
        ? updateConvSessionConfig(rest, null, { provider: { ...providerRef.current, routingMode: 'auto' }, orchEnabled: false }, defaults)
        : rest;
      sessionConfigsRef.current = nextMap;
      return nextMap;
    });
  }, [providerRef, orchRef, swarmRef]);

  return {
    cwdByConv,
    cwdByConvRef,
    getSessionBundle,
    activeProvider,
    activeOrchestrator,
    activeSwarmEnabled,
    activeCwd,
    reasoningLevel,
    setSessionProvider,
    setReasoningLevel,
    setSessionSwarmEnabled,
    setSessionCwd,
    saveSessionOrchestrator,
    setProviderFromSettings,
    saveOrchestratorFromSettings,
    promoteDraftSessionConfig,
    resetDraftSessionConfig,
  };
}

export function useSettingsBootSync({
  activeId,
  activeProvider,
  activeOrchestrator,
  saveSessionOrchestrator,
  provider,
  setProvider,
  providerKeys,
  setProviderKeys,
  settings,
  setSettings,
  setOrchestrator,
  orchRef,
  setFeatures,
  featRef,
  permissions,
  setPermissions,
  swarmEnabled,
  setSwarmEnabled,
  webSearch,
  setWebSearch,
  styleId,
  setStyleId,
  sidebarCollapsed,
  setSidebarCollapsed,
  workbenchMode,
  setWorkbenchMode,
  projects,
  setProjects,
  activeProject,
  setActiveProject,
  account,
  settingsAdopted,
  setSettingsAdopted,
  applyTypographyToDocument,
}) {
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
  useEffect(() => {
    if (!settingsAdopted) return;
    if (hydrateAckRef.current === 1) { hydrateAckRef.current = 2; return; }
    try { window.autobot.setSettings?.({ provider: { ...provider, _updatedAt: Date.now() }, providerKeys }); } catch (_) {}
  }, [provider, providerKeys, settingsAdopted]);
  useEffect(() => {
    if (!settingsAdopted) return;
    if (activeProvider && (activeProvider.routingMode === 'direct' || activeProvider.routingMode === 'auto')) return;
    if (!activeOrchestrator || !activeOrchestrator.enabled || !Array.isArray(activeOrchestrator.providers) || !activeOrchestrator.providers.length) return;
    const selModel = String((activeProvider && activeProvider.model) || '').trim().toLowerCase();
    const selOauth = String((activeProvider && activeProvider.oauthProvider) || '').trim().toLowerCase();
    const selBase = normBase((activeProvider && activeProvider.baseURL) || '').toLowerCase();
    if (!selModel) return;
    const idx = activeOrchestrator.providers.findIndex((p) => {
      if (!p) return false;
      if (String(p.model || '').trim().toLowerCase() !== selModel) return false;
      if (selOauth) return String(p.oauthProvider || '').trim().toLowerCase() === selOauth;
      if (selBase) return normBase(p.baseURL || '').toLowerCase() === selBase;
      return true;
    });
    if (idx >= 0 && idx !== activeOrchestrator.activeIndex) {
      saveSessionOrchestrator({ ...activeOrchestrator, activeIndex: idx });
    }
  }, [activeId, activeProvider.model, activeProvider.oauthProvider, activeProvider.baseURL, settingsAdopted]); // eslint-disable-line react-hooks/exhaustive-deps
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
}
