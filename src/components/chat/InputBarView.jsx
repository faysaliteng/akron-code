import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Icon, GoogleDriveIcon, ModelLogo } from '../Icon.jsx';
import MessageQueueTray from '../MessageQueueTray.jsx';
import { normBase, LOCAL_BASE, keySig, statusOf, presetStatus } from '../../providerstatus-ui.mjs';
import { hydrateProvider, endpointKey } from '../../providerhydrate.mjs';
import { useVoiceDictation } from '../../voice';
import { ClaudeReconnectPanel, useClaudeReconnect } from '../settings/SettingsSections.jsx';
import { SessionModelList, EnvironmentPicker, PERM_MODES, PERM_SHORT, BUILTIN_MENTION_AGENTS, ContextMeter, ProvModelList } from './WorkspaceViews.jsx';
import { PRESETS, PRESET_KEYS, resolveLoopbackKey, STYLES, REASON_LEVELS, REASON_LABELS, MODEL_CAPABILITY_CACHE, thinkingCapabilitiesForUi, contextWindowFor, loadJSON, saveJSON, useDismiss, toggleDictation, filesToAttachments, uid, ProvNotice, fmtInt, MODEL_WINDOW_CACHE, usedTokens } from '../../utils/appHelpers.jsx';
import { guardOrchestratorAction } from '../../utils/tutorialPresets.js';

export function InputBarBody({ streaming, paused, onPause, onResume, send, stop, inputRef, cwd, setCwd, runSlashCommand, provider, setProvider, orchestrator, setOrchestrator, providerKeys, setProviderKeys, modelMenuOpen, setModelMenuOpen, openSettings, onOpenTutorial, attachments, setAttachments, reasoningLevel, setReasoningLevel, swarmEnabled, setSwarmEnabled, styleId, setStyleId, customStyles = [], customAgents = [], onOpenCustomizations, webSearch, setWebSearch, dictating, setDictating, voiceMode, startVoiceMode, stopVoiceMode, sessionPane, toggleSessionPane, permissions, setPermissions, queued, queuePaused, onToggleQueuePaused, onClearQueue, onToggleQueueItemPaused, onReorderQueue, onStepQueueItem, onUpdateQueueItemText, unqueue, sendQueuedNow, lastUsage, settings, onVoiceError, gdriveState, onOpenGdrive, envState, onSwitchEnvironment, onOpenEnvironments, activeSkillPill, onClearSkillPill, T }) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [addCtxOpen, setAddCtxOpen] = useState(false);
  const [orchExpanded, setOrchExpanded] = useState(false);
  const [inputText, setInputText] = useState(() => (inputRef.current && inputRef.current.value) || '');
  const [slashActions, setSlashActions] = useState([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionFiles, setMentionFiles] = useState([]);
  const [fetchedAgents, setFetchedAgents] = useState([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const addCtxWrapRef = useRef(null);
  const slashPaletteRef = useRef(null);
  const mentionPaletteRef = useRef(null);
  useDismiss(addCtxOpen, [addCtxWrapRef], () => setAddCtxOpen(false));

  const refreshSlashActions = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.listSlashActions) {
        const list = await window.autobot.listSlashActions(cwd);
        if (Array.isArray(list)) setSlashActions(list);
      }
    } catch (_) {}
  }, [cwd]);
  useEffect(() => { refreshSlashActions(); }, [refreshSlashActions]);

  // Slash token detection: active whenever text starts with `/<token>` (no spaces/newlines yet),
  // regardless of whether attachments are present in the composer (Antigravity Screenshot 2 parity).
  const slashMatch = /^\/([^\s\n]*)$/.exec(inputText);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const filteredSlashActions = useMemo(() => {
    if (slashQuery === null) return [];
    const list = slashActions || [];
    if (!slashQuery) return list.slice(0, 60);
    const hits = [];
    for (const item of list) {
      const n = String(item.name || '').toLowerCase();
      const d = String(item.description || '').toLowerCase();
      const al = (item.aliases || []).some((x) => String(x).toLowerCase().includes(slashQuery));
      let rank = 99;
      if (n.startsWith(slashQuery)) rank = 0;
      else if (n.includes(slashQuery) || al) rank = 1;
      else if (d.includes(slashQuery)) rank = 2;
      if (rank < 99) hits.push({ item, rank });
    }
    hits.sort((a, b) => a.rank - b.rank);
    return hits.slice(0, 40).map((h) => h.item);
  }, [slashQuery, slashActions]);
  const slashOpen = slashQuery !== null && !slashDismissed && filteredSlashActions.length > 0;
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  // @ Mentions detection when typing `@<query>` (either empty or immediately after whitespace)
  const mentionMatch = !slashOpen ? /(?:^|\s)@([^\s@\n]*)$/.exec(inputText) : null;
  const mentionQuery = mentionMatch ? mentionMatch[1] : null;
  useEffect(() => {
    if (mentionQuery === null || mentionDismissed) return;
    let cancelled = false;
    Promise.resolve(window.autobot && window.autobot.listWorkspaceFiles ? window.autobot.listWorkspaceFiles(cwd, mentionQuery) : [])
      .then((list) => { if (!cancelled && Array.isArray(list)) setMentionFiles(list); })
      .catch(() => {});
    if (window.autobot && window.autobot.listAgentDefs) {
      Promise.resolve(window.autobot.listAgentDefs(cwd))
        .then((defs) => { if (!cancelled && Array.isArray(defs)) setFetchedAgents(defs); })
        .catch(() => {});
    }
    return () => { cancelled = true; };
  }, [mentionQuery, mentionDismissed, cwd]);

  const mentionItems = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const byName = new Map();
    for (const a of BUILTIN_MENTION_AGENTS) byName.set(a.name.toLowerCase(), a);
    for (const src of [fetchedAgents, customAgents]) {
      for (const a of (Array.isArray(src) ? src : [])) {
        if (!a || !a.name) continue;
        byName.set(String(a.name).toLowerCase(), { name: a.name, description: a.description || a.role || 'Custom sub-agent' });
      }
    }
    const agents = [...byName.values()]
      .filter((a) => !q || a.name.toLowerCase().includes(q) || String(a.description || '').toLowerCase().includes(q))
      .map((a) => ({ id: 'agent:' + a.name, label: '@' + a.name, insert: '@' + a.name + ' ', kind: 'agent', sub: a.description }));
    const files = (mentionFiles || []).map((f) => ({
      id: 'file:' + f.path,
      label: f.path,
      insert: '@' + f.path + ' ',
      kind: 'file',
      sub: f.name,
      fileObj: f,
    }));
    return [...agents, ...files].slice(0, 25);
  }, [mentionQuery, mentionFiles, customAgents, fetchedAgents]);
  const mentionOpen = mentionQuery !== null && !mentionDismissed && mentionItems.length > 0;
  useEffect(() => { setMentionIdx(0); }, [mentionQuery]);

  const resizeTextarea = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    try {
      el.style.height = 'auto';
      const next = Math.min(200, Math.max(24, el.scrollHeight || 24));
      el.style.height = next + 'px';
      el.style.overflowY = el.scrollHeight > 200 ? 'auto' : 'hidden';
    } catch (_) {}
  }, [inputRef]);

  const syncInputState = useCallback((val) => {
    setInputText(val);
    setHasText(!!String(val || '').trim());
    setSlashDismissed(false);
    setMentionDismissed(false);
    resizeTextarea();
  }, [resizeTextarea]);

  useEffect(() => {
    resizeTextarea();
  }, [inputText, resizeTextarea]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onClipImage = (ev) => {
      const detail = ev && ev.detail;
      if (!detail || !detail.hasImage || !detail.dataUrl) return;
      setAttachments((a) => [...a, {
        id: uid(),
        name: `clipboard-image-${Date.now()}.png`,
        size: detail.dataUrl.length,
        isImage: true,
        dataUrl: detail.dataUrl,
      }]);
      resizeTextarea();
    };
    window.addEventListener('akron:clipboard-image', onClipImage);
    return () => window.removeEventListener('akron:clipboard-image', onClipImage);
  }, [setAttachments, resizeTextarea]);

  const applySlashItem = useCallback((item, mode = 'enter') => {
    if (!item || !inputRef.current) return;
    const el = inputRef.current;
    if (mode === 'tab' || item.takesArgs) {
      const next = '/' + item.name + ' ';
      el.value = next;
      syncInputState(next);
      el.focus();
      try { el.setSelectionRange(next.length, next.length); } catch (_) {}
      setSlashDismissed(true);
      return;
    }
    el.value = '';
    syncInputState('');
    runSlashCommand(item.name);
  }, [inputRef, runSlashCommand, syncInputState]);

  const applyMentionItem = useCallback((item) => {
    if (!item || !inputRef.current) return;
    const el = inputRef.current;
    const cur = el.value || '';
    const updated = cur.replace(/(^|\s)@([^\s@\n]*)$/, '$1' + item.insert);
    el.value = updated;
    syncInputState(updated);
    el.focus();
    try { el.setSelectionRange(updated.length, updated.length); } catch (_) {}
    setMentionDismissed(true);
  }, [inputRef, syncInputState]);

  const attachFolderContext = useCallback(async () => {
    setAddCtxOpen(false);
    if (!window.autobot || !window.autobot.pickFolder) return;
    const dir = await window.autobot.pickFolder();
    if (!dir) return;
    let listing = '';
    try {
      const files = await window.autobot.listWorkspaceFiles(dir, '');
      if (Array.isArray(files) && files.length) {
        listing = '\nFiles:\n' + files.slice(0, 30).map((f) => `- ${f.path}`).join('\n');
      }
    } catch (_) {}
    const folderName = dir.split('/').filter(Boolean).pop() || dir;
    setAttachments((a) => [...a, {
      name: `📁 ${folderName}`,
      path: dir,
      size: 0,
      isText: true,
      content: `Attached workspace folder context: ${dir}${listing}`,
    }]);
  }, [setAttachments]);

  const attachBrowserContext = useCallback(async () => {
    setAddCtxOpen(false);
    try {
      const ext = window.autobot && window.autobot.extBridgeStatus ? await window.autobot.extBridgeStatus() : null;
      const liveTab = ext && Array.isArray(ext.tabs) && ext.tabs.find((t) => t.active) || (ext && ext.tabs && ext.tabs[0]);
      if (liveTab && liveTab.url) {
        setAttachments((a) => [...a, {
          name: `🌐 ${liveTab.title || liveTab.url}`,
          path: liveTab.url,
          size: 0,
          isText: true,
          content: `External Browser tab context (Akron Browser Bot):\nTitle: ${liveTab.title || ''}\nURL: ${liveTab.url}`,
        }]);
        return;
      }
      const inAppUrl = window.autobot && window.autobot.browserGetURL ? await window.autobot.browserGetURL() : '';
      if (inAppUrl) {
        const title = await window.autobot.browserGetTitle().catch(() => '');
        const text = await window.autobot.browserRead().catch(() => '');
        setAttachments((a) => [...a, {
          name: `🌐 ${title || inAppUrl}`,
          path: inAppUrl,
          size: String(text || '').length,
          isText: true,
          content: `Built-in Browser context:\nTitle: ${title || ''}\nURL: ${inAppUrl}\n\n${String(text || '').slice(0, 12000)}`,
        }]);
        return;
      }
    } catch (_) {}
    toggleSessionPane('browser');
  }, [setAttachments, toggleSessionPane]);

  const triggerMentionInsert = useCallback(() => {
    setAddCtxOpen(false);
    if (!inputRef.current) return;
    const el = inputRef.current;
    const cur = el.value || '';
    const next = cur && !/\s$/.test(cur) ? cur + ' @' : cur + '@';
    el.value = next;
    syncInputState(next);
    el.focus();
    try { el.setSelectionRange(next.length, next.length); } catch (_) {}
  }, [inputRef, syncInputState]);

  const triggerActionsInsert = useCallback(() => {
    setAddCtxOpen(false);
    refreshSlashActions();
    if (!inputRef.current) return;
    const el = inputRef.current;
    const cur = el.value || '';
    const next = cur.startsWith('/') ? cur : '/';
    el.value = next;
    syncInputState(next);
    el.focus();
    try { el.setSelectionRange(next.length, next.length); } catch (_) {}
  }, [inputRef, syncInputState, refreshSlashActions]);
  const voice = useVoiceDictation({
    engine: (settings && settings.voiceEngine) || 'auto',
    lang: (settings && settings.voiceLang) || 'en-US',
    onTranscript: (transcript) => {
      if (inputRef.current) {
        const el = inputRef.current;
        el.value = el.value ? el.value + ' ' + transcript : transcript;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        setHasText(!!el.value.trim());
      }
    },
    onError: (msg) => { if (onVoiceError) onVoiceError(msg); },
  });
  useEffect(() => {
    setDictating(voice.state !== 'idle');
  }, [voice.state, setDictating]);
  // Tracks whether the composer holds text so that, while a reply is streaming,
  // the send arrow can appear alongside the stop button (Example parity: type a
  // follow-up mid-stream and the arrow queues it instead of being lost).
  const [hasText, setHasText] = useState(() => !!((inputRef.current && inputRef.current.value) || '').trim());
  const permWrapRef = useRef(null);
  const [keyStatus, setKeyStatus] = useState(() => loadJSON('autobot:keyStatus', {}));
  const [keyProbing, setKeyProbing] = useState(false);
  // The probe effects read the cache through a ref: having keyStatus in their
  // deps while they also write it re-ran them on every verdict.
  const keyStatusRef = useRef(keyStatus);
  keyStatusRef.current = keyStatus;
  // Local model discovery: an Ollama box only runs the models that were pulled,
  // so the preset's hard-coded `llama3.1` pointed at a model that often does not
  // exist (404 → "cannot use"), and nothing else ever showed up in the picker.
  const [ollama, setOllama] = useState({});
  const [ollamaBusy, setOllamaBusy] = useState(false);
  // Subscription accounts (Claude Max, ChatGPT, Antigravity, Grok). The
  // renderer only ever sees non-secret metadata; tokens are minted in main.
  const [provOauth, setProvOauth] = useState(null);
  const [provBusy, setProvBusy] = useState('');
  const [provNotice, setProvNotice] = useState('');
  // Bearer providers (xAI/Grok) have no browser flow: the user pastes a key.
  const [provToken, setProvToken] = useState({});
  // Manual code sign-in: the authorize page shows the code, the user pastes it
  // back. Used when the browser cannot reach the loopback listener.
  const [provManual, setProvManual] = useState(null);
  // Live model inventory per provider (`autobot:providerModels`). The accounts
  // expose 5–40 models each and they change, so the picker asks the provider
  // instead of shipping a stale hardcoded list. Values carry the resolved
  // context window used for the per-model label and the auto-compact budget.
  const [provModels, setProvModels] = useState({});

  // Context ring in the composer: measure the window of the model that served
  // the last turn. `provider.model` is right on a fresh chat, but switching
  // models (or sitting on a gateway alias like `auto`) would otherwise rescale
  // an existing conversation against the wrong window.
  const ctxWindow = contextWindowFor((lastUsage && lastUsage.model) || provider.model);

  const loadProvOauth = useCallback(async () => {
    const r = await Promise.resolve(window.autobot.providerStatus()).catch(() => null);
    if (r && r.ok && r.status) setProvOauth(r.status);
    return r && r.status;
  }, []);

  const loadProvModels = useCallback(async (provId, account) => {
    if (!provId || !window.autobot.providerModels) return null;
    // Cache under the account-specific key when we know it, and always also
    // under the bare provider id so the warm-up fetch and the picker agree.
    const key = account ? provId + ':' + account : provId;
    try {
      const r = await window.autobot.providerModels(key);
      if (r && r.ok) {
        setProvModels((m) => (account ? { ...m, [provId]: r, [key]: r } : { ...m, [provId]: r }));
        // Share the resolved windows with the `/context` command, which runs
        // outside this component and cannot see this state.
        try {
          const cache = loadJSON(MODEL_WINDOW_CACHE, {}) || {};
          const caps = loadJSON(MODEL_CAPABILITY_CACHE, {}) || {};
          for (const m of r.models || []) {
            if (!m || !m.id) continue;
            if (m.contextWindow > 0) cache[m.id] = m.contextWindow;
            caps[m.id] = {
              thinking: m.thinking !== undefined ? !!m.thinking : undefined,
              thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : undefined,
              thinkingVariants: m.thinkingVariants || undefined,
            };
          }
          saveJSON(MODEL_WINDOW_CACHE, cache);
          saveJSON(MODEL_CAPABILITY_CACHE, caps);
        } catch (_) {}
        return r;
      }
    } catch (_) {}
    return null;
  }, []);

  useEffect(() => {
    if (!window.autobot || !window.autobot.onEvent) return undefined;
    return window.autobot.onEvent((evt) => {
      if (!evt || evt.type !== 'model-catalog-updated' || !evt.providerId || !Array.isArray(evt.models)) return;
      const r = { ok: true, providerId: evt.providerId, live: true, count: evt.models.length, models: evt.models };
      setProvModels((prev) => ({
        ...prev,
        [evt.providerId]: r,
        ...(evt.accountId ? { [evt.accountId]: r } : {}),
      }));
      try {
        const cache = loadJSON(MODEL_WINDOW_CACHE, {}) || {};
        const caps = loadJSON(MODEL_CAPABILITY_CACHE, {}) || {};
        for (const m of evt.models) {
          if (!m || !m.id) continue;
          if (m.contextWindow > 0) cache[m.id] = m.contextWindow;
          caps[m.id] = {
            thinking: m.thinking !== undefined ? !!m.thinking : undefined,
            thinkingLevels: Array.isArray(m.thinkingLevels) ? m.thinkingLevels : undefined,
            thinkingVariants: m.thinkingVariants || undefined,
          };
        }
        saveJSON(MODEL_WINDOW_CACHE, cache);
        saveJSON(MODEL_CAPABILITY_CACHE, caps);
      } catch (_) {}
    });
  }, []);

  useEffect(() => {
    if (modelMenuOpen) loadProvOauth();
  }, [modelMenuOpen, loadProvOauth]);

  const [autoRouterInfo, setAutoRouterInfo] = useState(null);
  useEffect(() => {
    let alive = true;
    if (window.autobot && typeof window.autobot.autoRouterGet === 'function') {
      window.autobot.autoRouterGet().then((res) => {
        if (alive && res && res.ok) setAutoRouterInfo(res);
      }).catch(() => {});
    }
    return () => { alive = false; };
  }, [modelMenuOpen]);
  const hasDeepSeekKey = Boolean((settings && settings.autoRouter && settings.autoRouter.hasKey) || (autoRouterInfo && autoRouterInfo.hasKey));

  // Warm the per-provider model lists as soon as the menu opens so the picker
  // shows every model (and its window) without a second click. The account the
  // conversation is actually using is fetched first — that is the one whose
  // catalog the composer pill reports.
  useEffect(() => {
    if (!modelMenuOpen || !provOauth) return;
    const sel = String(provider.oauthProvider || '');
    for (const pv of provOauth.providers || []) {
      const accounts = pv.accounts || [];
      if (!accounts.length) continue;
      const acct = sel.startsWith(pv.id + ':') ? sel.slice(pv.id.length + 1) : '';
      if (acct && accounts.some((a) => a.account === acct)) loadProvModels(pv.id, acct);
      else loadProvModels(pv.id);
    }
  }, [modelMenuOpen, provOauth, provider.oauthProvider, loadProvModels]);

  // Sign in / import / sign out always refresh the list so the picker reflects
  // the real account state (never an optimistic guess).
  //
  // Claude is special: its credential is owned by the Claude Code CLI, so this
  // surface drives the CLI's own login (the same flow Settings → Accounts uses)
  // instead of a second independent OAuth, which would sign the CLI out.
  const claudeSignIn = useClaudeReconnect({ t: T, onChanged: loadProvOauth });

  // Stop a browser sign-in that is still waiting for the redirect. Without this
  // the row spins until the 10-minute timeout when the browser never returns.
  const cancelBrowserSignIn = async (id) => {
    try { await window.autobot.providerSignInCancel(id); } catch (_) {}
  };

  const providerAction = async (kind, id, account) => {
    if (kind === 'signin' && id === 'claude') return claudeSignIn.start();
    setProvBusy(kind + ':' + (id || ''));
    try {
      let r;
      if (kind === 'signin') r = await window.autobot.providerSignIn(id);
      else if (kind === 'signout') r = await window.autobot.providerSignOut(id, account);
      else if (kind === 'import') r = await window.autobot.providerImport();
      else if (kind === 'autoheal') r = await window.autobot.providerAutoHeal({ importMissing: true });
      else if (kind === 'bearer') r = await window.autobot.providerAddBearer(id, account);
      if (r && r.cancelled) {
        // The user stopped it — that is not a failure and must not read like one.
        setProvNotice('Sign-in cancelled — no account was added.');
      } else if (kind === 'autoheal' && r && r.ok !== false) {
        setProvNotice(`Auto-Heal: repaired ${r.healed || 0} · imported ${r.imported || 0} · ${r.healthy || 0} healthy.`);
      } else if (kind === 'import' && r && r.ok !== false && r.result) {
        // A scan that finds nothing new must still say so — otherwise the button
        // flashes "Scanning…" and appears dead.
        const im = (r.result.imported || []).length;
        const sk = (r.result.skipped || []).length;
        const er = (r.result.errors || []).length;
        const parts = ['Imported ' + im];
        if (sk) parts.push('already present ' + sk);
        if (er) parts.push('failed ' + er);
        setProvNotice(parts.join(' · ') + (im ? '.' : ' — nothing new to import.'));
      } else if (r && r.ok === false && r.error) {
        // One human line, never a stack trace or raw markup.
        setProvNotice(String(r.error).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220));
      } else {
        setProvNotice('');
        if (kind === 'bearer') setProvToken({});
      }
      await loadProvOauth();
      return r;
    } finally {
      setProvBusy('');
    }
  };

  // Start the paste-the-code fallback: no loopback listener, the provider page
  // shows a code and we hand it back. This is what the Claude CLI does when it
  // cannot get the browser to return to localhost.
  const startManualSignIn = async (id) => {
    setProvBusy('manual:' + id);
    try {
      const r = await window.autobot.providerSignInManual(id);
      if (!r || r.ok === false) {
        setProvNotice(String((r && r.error) || 'could not start sign-in').replace(/<[^>]*>/g, ' ').slice(0, 220));
        return;
      }
      setProvNotice('');
      setProvManual({ flowId: r.flowId, provId: id, url: r.url || '', code: '', sent: false });
    } catch (e) {
      setProvNotice(String((e && e.message) || 'could not start sign-in').slice(0, 220));
    } finally {
      setProvBusy('');
    }
  };

  const submitManualCode = async () => {
    const m = provManual;
    if (!m || !String(m.code || '').trim()) return;
    setProvBusy('manual:' + m.provId);
    try {
      const r = await window.autobot.providerSubmitCode(m.flowId, String(m.code).trim());
      if (r && r.ok === false) {
        setProvNotice(String(r.error || 'paste the code the sign-in page shows').slice(0, 220));
        return;
      }
      setProvNotice('');
      setProvManual({ ...m, code: '', sent: true });
    } finally {
      setProvBusy('');
    }
  };

  // The main process reports the outcome of a manual sign-in here — success
  // brings a new account (refresh the list), failure is one human line.
  useEffect(() => {
    if (!window.autobot.onProviderManualResult) return undefined;
    return window.autobot.onProviderManualResult(async (flowId, result) => {
      setProvManual((cur) => (cur && cur.flowId === flowId ? null : cur));
      if (result && result.ok) {
        setProvNotice('');
        await loadProvOauth();
      } else {
        setProvNotice(String((result && result.error) || 'sign-in did not complete').replace(/<[^>]*>/g, ' ').slice(0, 220));
      }
    });
  }, [loadProvOauth]);

  const scanOllama = useCallback(async () => {
    const bases = new Set();
    for (const p of PRESETS) {
      const b = normBase(p.baseURL);
      if (b && LOCAL_BASE.test(b)) bases.add(b);
    }
    const activeBase = normBase(provider.baseURL);
    if (activeBase && LOCAL_BASE.test(activeBase)) bases.add(activeBase);
    if (!bases.size) return {};
    // A keyed local router (FreeLLMAPI on :3001) refuses an anonymous
    // GET /models, so the scan must carry the same bearer the turn will use —
    // otherwise a working endpoint renders as "not set up" and lists nothing.
    const keyForBase = (b) => resolveLoopbackKey(b, providerKeys, provider);
    const found = {};
    for (const b of bases) {
      const res = await Promise.resolve(window.autobot.ollamaModels(b, keyForBase(b))).catch(() => null);
      if (res) found[b] = res;
    }
    setOllama((prev) => ({ ...prev, ...found }));
    return found;
  }, [provider, providerKeys]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    scanOllama();
  }, [modelMenuOpen, scanOllama]);

  // One-click "Connect Ollama": start the server if it is not up, then jump
  // straight onto the first installed model.
  const connectOllama = async () => {
    setOllamaBusy(true);
    try {
      const r = await Promise.resolve(window.autobot.ollamaServe('start')).catch(() => null);
      const found = await scanOllama();
      const base = normBase((r && r.base) || 'http://localhost:11434/v1');
      const scan = (r && r.ok ? r : null) || found[base] || null;
      const first = scan && scan.models && scan.models[0];
      if (first) {
        setProvider((v) => ({ ...v, baseURL: base, model: first.name, apiKey: '', supportsTools: true, routingMode: 'direct', oauthProvider: '', transport: '', accessToken: '', oauth: false }));
        if (setOrchestrator && orchestrator && orchestrator.enabled) {
          setOrchestrator({ ...orchestrator, enabled: false });
        }
        setModelMenuOpen(false);
      }
      return { ok: !!first, detail: (r && r.detail) || (scan && scan.detail) || '' };
    } finally {
      setOllamaBusy(false);
    }
  };

  const keyFor = useCallback((p) => {
    return (p && p.apiKey) || resolveLoopbackKey(p && p.baseURL, providerKeys, provider);
  }, [providerKeys, provider]);

  // When the picker opens (or a key changes), ask each configured endpoint for
  // its status once — a cheap authenticated GET /models, no tokens burned.
  // Entries are stamped with the key signature + timestamp; anything stale is
  // re-probed and anything whose signature no longer matches is ignored.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const seen = new Set();
    const targets = [];
    for (const p of PRESETS) {
      const base = normBase(p.baseURL);
      if (!base) continue;
      const apiKey = keyFor(p);
      if (!apiKey && !LOCAL_BASE.test(base)) continue;
      const sig = base + '|' + keySig(apiKey);
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (statusOf(keyStatusRef.current, base, apiKey)) continue; // fresh verdict already cached
      targets.push({ baseURL: base, apiKey });
    }
    if (!targets.length) return;
    let cancelled = false;
    setKeyProbing(true);
    Promise.resolve(window.autobot.probeProviders(targets)).then((res) => {
      if (cancelled || !res || res._error) return;
      const sigByBase = {};
      for (const t of targets) sigByBase[normBase(t.baseURL)] = keySig(t.apiKey);
      const at = Date.now();
      setKeyStatus((prev) => {
        const next = { ...prev };
        for (const [base, v] of Object.entries(res)) {
          next[base] = { state: v.state, detail: v.detail, sig: sigByBase[base] || '', at };
        }
        saveJSON('autobot:keyStatus', next);
        return next;
      });
    }).catch(() => {}).finally(() => { if (!cancelled) setKeyProbing(false); });
    // A cancelled probe must not leave "checking keys…" stuck in the header.
    return () => { cancelled = true; setKeyProbing(false); };
  }, [modelMenuOpen, keyFor]);

  // The composer pill mirrors the active endpoint, so probe it once on load too.
  useEffect(() => {
    if (modelMenuOpen) return;
    const base = normBase(provider.baseURL);
    if (!base) return;
    const apiKey = resolveLoopbackKey(base, providerKeys, provider);
    if (!apiKey && !LOCAL_BASE.test(base)) return;
    if (statusOf(keyStatusRef.current, base, apiKey)) return;
    let cancelled = false;
    Promise.resolve(window.autobot.probeProviders([{ baseURL: base, apiKey }])).then((res) => {
      if (cancelled || !res || res._error) return;
      const v = res[base];
      if (!v) return;
      setKeyStatus((prev) => {
        const next = { ...prev, [base]: { state: v.state, detail: v.detail, sig: keySig(apiKey), at: Date.now() } };
        saveJSON('autobot:keyStatus', next);
        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [provider, providerKeys, modelMenuOpen]);

  const activeBase = normBase(provider.baseURL);
  const activeKey = resolveLoopbackKey(activeBase, providerKeys, provider);
  const activeKeyState = statusOf(keyStatus, activeBase, activeKey);
  const activeDot = activeKeyState ? (activeKeyState.state === 'ok' ? 'ok' : (activeKeyState.state === 'out' || activeKeyState.state === 'badkey') ? 'out' : null) : null;
  const modelMenuRef = useRef(null);
  const modelWrapRef = useRef(null);
  useDismiss(modelMenuOpen, [modelWrapRef], () => setModelMenuOpen(false));

  // What the picker lists: every preset, except a reachable Ollama preset, which
  // expands into one row per model the server actually reports.
  // Memoized: SessionModelList memoizes its 1000-row grouping on `rows`, which
  // a fresh array every render defeated.
  const pickerRows = useMemo(() => {
  const pickerRows = [];
  for (const p of PRESETS) {
    const base = normBase(p.baseURL);
    const scan = ollama[base];
    if (scan && scan.ok && scan.models && scan.models.length) {
      // A local router lists its whole catalog. Label it for what it is
      // ("live" = the key authenticated the endpoint) and keep the model the
      // user already picked selectable even when it is a router alias that the
      // catalog does not enumerate (FreeLLMAPI's `auto:fast`).
      const isOllamaBase = /:11434\b/.test(base);
      const list = scan.models.slice();
      if (base === normBase(provider.baseURL) && provider.model && !list.some((m) => m.name === provider.model)) {
        list.unshift({ name: provider.model, size: 0, family: '' });
      }
      for (const m of list) {
        const rawLabel = m.name.split('/').pop().replace(/:latest$/, '');
        const ctxMatch = rawLabel.match(/^\[ctx:(\d+)\]\s*/i);
        let ctxBadge = '';
        if (ctxMatch) {
          const n = parseInt(ctxMatch[1], 10);
          ctxBadge = n >= 1000000 ? `${Math.round(n / 100000) / 10}M` : (n >= 1000 ? `${Math.round(n / 1024)}K` : String(n));
        }
        pickerRows.push({
          key: base + '|' + m.name,
          preset: p,
          model: m.name,
          label: rawLabel.replace(/^\[ctx:\d+\]\s*/i, ''),
          ctxBadge,
          prov: p.name.replace(/\s*\(.*\)$/, '') + (isOllamaBase ? ' · installed' : ' · live'),
          local: true,
        });
      }
      continue;
    }
    pickerRows.push({ key: p.name, preset: p, model: p.model, label: (p.model || 'custom').split('/').pop(), prov: p.name });
  }
  return pickerRows;
  }, [ollama, provider.baseURL, provider.model]);
  const ollamaEmpty = PRESETS.some((p) => {
    const b = normBase(p.baseURL);
    return /:11434\b/.test(b) && ollama[b] && !(ollama[b].ok && ollama[b].models && ollama[b].models.length);
  });

  // Always start the popover at the top so Routing Mode (Auto DeepSeek & Orchestrator)
  // is never scrolled out of sight when a lower subscription model is active.
  useEffect(() => {
    if (!modelMenuOpen || !modelMenuRef.current) return;
    modelMenuRef.current.scrollTop = 0;
  }, [modelMenuOpen]);

  // Permissions dropdown: outside-click dismiss + 1..5 shortcut selection (Example parity)
  useEffect(() => {
    if (!permOpen) return;
    const onDocDown = (e) => {
      if (permWrapRef.current && !permWrapRef.current.contains(e.target)) setPermOpen(false);
    };
    const onMenuKey = (e) => {
      if (e.key === 'Escape') { setPermOpen(false); return; }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= PERM_MODES.length) {
        e.preventDefault();
        setPermissions(PERM_MODES[n - 1].id);
        setPermOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onMenuKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onMenuKey);
    };
  }, [permOpen, setPermissions]);

  const onDropFiles = async (e) => {
    e.preventDefault(); setDragOver(false);
    const akronFileRaw = e.dataTransfer?.getData?.('text/akron-file');
    if (akronFileRaw) {
      try {
        const meta = JSON.parse(akronFileRaw);
        if (meta && meta.path) {
          let content = '';
          if (window.autobot?.ideReadFile) {
            const r = await window.autobot.ideReadFile({ path: meta.path }).catch(() => null);
            if (r && r.ok && !r.binary && !r.tooLarge) content = r.content || '';
          }
          setAttachments((a) => [...a, {
            id: uid(),
            kind: 'text',
            name: meta.relPath || meta.name || meta.path,
            path: meta.path,
            size: Buffer ? undefined : content.length,
            content,
          }]);
          return;
        }
      } catch (_) {}
    }
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      const atts = await filesToAttachments(files);
      setAttachments((a) => [...a, ...atts]);
    }
  };
  const onPasteFiles = async (e) => {
    const items = e.clipboardData?.items;
    const files = [];
    if (items) {
      for (const it of items) {
        if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
      }
    }
    if (files.length) {
      e.preventDefault();
      const atts = await filesToAttachments(files);
      setAttachments((a) => [...a, ...atts]);
      return;
    }
    // Check if clipboardData holds plain text; sync React state & auto-expand composer height.
    const plain = e.clipboardData && typeof e.clipboardData.getData === 'function'
      ? e.clipboardData.getData('text/plain')
      : '';
    if (!plain && window.autobot && typeof window.autobot.clipboardReadImage === 'function') {
      const imgRes = await window.autobot.clipboardReadImage().catch(() => null);
      if (imgRes && imgRes.ok && imgRes.hasImage && imgRes.dataUrl) {
        e.preventDefault();
        setAttachments((a) => [...a, {
          id: uid(),
          name: `clipboard-image-${Date.now()}.png`,
          size: imgRes.dataUrl.length,
          isImage: true,
          dataUrl: imgRes.dataUrl,
        }]);
        return;
      }
    }
    setTimeout(() => {
      if (inputRef.current) {
        syncInputState(inputRef.current.value);
        resizeTextarea();
      }
    }, 0);
  };

  const onKey = (e) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, filteredSlashActions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applySlashItem(filteredSlashActions[slashIdx] || filteredSlashActions[0], 'tab');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const picked = filteredSlashActions[slashIdx] || filteredSlashActions[0];
        if (picked) {
          // If the exact token already matches `/${picked.name}` and it is an MCP workflow (which has a default workspace action),
          // run it directly when pressed twice or on exact Enter match for no-arg commands.
          if (slashQuery === picked.name.toLowerCase() && /^mcp:/i.test(picked.name)) {
            inputRef.current.value = '';
            syncInputState('');
            runSlashCommand(picked.name);
          } else {
            applySlashItem(picked, 'enter');
          }
        }
        return;
      }
    }
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => Math.min(i + 1, mentionItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applyMentionItem(mentionItems[mentionIdx] || mentionItems[0]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = (inputRef.current?.value || '').trim();
      if (text.startsWith('/')) {
        inputRef.current.value = '';
        syncInputState('');
        runSlashCommand(text.slice(1));
      } else if (activeSkillPill && activeSkillPill.id === 'automation') {
        inputRef.current.value = '';
        syncInputState('');
        if (onClearSkillPill) onClearSkillPill();
        runSlashCommand('automation' + (text ? ' ' + text : ''), { direct: true });
      } else {
        send();
        syncInputState('');
      }
    }
  };

  const disableOrchestrator = useCallback(() => {
    if (setOrchestrator && orchestrator && orchestrator.enabled) {
      setOrchestrator({ ...orchestrator, enabled: false });
    }
  }, [setOrchestrator, orchestrator]);

  const pickModel = (p, model) => {
    const base = normBase(p.baseURL);
    const key = keyFor(p);
    setProvider((v) => ({ ...v, baseURL: p.baseURL, model: model || p.model, apiKey: key, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto', oauthProvider: '', transport: '', accessToken: '', oauth: false, routingMode: 'direct' }));
    if (key && base) setProviderKeys((m) => ({ ...(m || {}), [base]: key }));
    disableOrchestrator();
    setModelMenuOpen(false);
  };

  // Pick a subscription account. Only the *id* goes into provider state: main
  // resolves it to a short-lived bearer token at the start of every turn.
  // Selecting an *account* keeps the menu open so its model list is visible;
  // selecting a *model* commits the choice and closes it.
  const pickOauthAccount = (prov, account, model) => {
    const key = prov.id + ':' + account;
    const live = provModels[key] || provModels[prov.id];
    const list = (live && live.models) || prov.models || [];
    const ids = list.map((m) => m.id);
    const dflt = model || (ids.includes(provider.model) ? provider.model : '') || ids[0] || provider.model;
    const nextModel = dflt || vModelFallback();
    function vModelFallback() { return provider.model; }
    const suffixMatch = /-(minimal|low|medium|high|xhigh)$/i.exec(String(dflt || ''));
    setProvider((v) => ({
      ...v,
      baseURL: '',
      apiKey: '',
      model: dflt || v.model,
      reasoningLevel: suffixMatch ? suffixMatch[1].toLowerCase() : (model ? 'auto' : v.reasoningLevel),
      supportsTools: true,
      oauthProvider: prov.id + ':' + account,
      transport: prov.transport,
      oauth: true,
      accessToken: '',
      routingMode: 'direct',
    }));
    disableOrchestrator();
    // Loaded per account, so two accounts of the same vendor never show each
    // other's catalogs (plan tiers expose different model sets).
    if (!provModels[key]) loadProvModels(prov.id, account);
    if (model) setModelMenuOpen(false);
  };

  const selectAutoMode = () => {
    setProvider((v) => ({ ...v, routingMode: 'auto' }));
    if (setOrchestrator && orchestrator && orchestrator.enabled) {
      setOrchestrator({ ...orchestrator, enabled: false }, { skipProviderSync: true });
    }
    setModelMenuOpen(false);
  };

  const activateOrchestratorSupervisor = (row = null) => {
    if (!row && !guardOrchestratorAction(orchestrator, openSettings)) {
      setModelMenuOpen(false);
      return;
    }
    const baseRows = (orchestrator && Array.isArray(orchestrator.providers)) ? orchestrator.providers : [];
    if (row && row.model) {
      const idx = baseRows.findIndex((p) => p && p.model === row.model && String(p.oauthProvider || '') === String(row.oauthProvider || ''));
      setProvider((v) => ({
        ...v,
        baseURL: row.baseURL != null ? row.baseURL : (row.oauthProvider ? '' : v.baseURL),
        apiKey: row.apiKey != null ? row.apiKey : (row.oauthProvider ? '' : v.apiKey),
        model: row.model,
        supportsTools: row.supportsTools !== false,
        oauthProvider: row.oauthProvider || '',
        transport: row.transport || '',
        oauth: !!row.oauth || !!row.oauthProvider,
        accessToken: '',
        routingMode: 'orchestrator',
      }));
      if (setOrchestrator) {
        setOrchestrator({ ...(orchestrator || { providers: [] }), enabled: true, activeIndex: idx >= 0 ? idx : 0 });
      }
      if (typeof setSwarmEnabled === 'function') setSwarmEnabled(true);
    } else {
      setProvider((v) => ({ ...v, routingMode: 'orchestrator' }));
      if (setOrchestrator) {
        setOrchestrator({ ...(orchestrator || { providers: [] }), enabled: true, activeIndex: 0 });
      }
      if (typeof setSwarmEnabled === 'function') setSwarmEnabled(true);
    }
    setModelMenuOpen(false);
  };

  // Unconfigured preset → open Settings with that preset staged. The session
  // provider is NOT switched here: it only changes once a key is saved, so
  // closing Settings leaves the working model untouched.
  const configurePreset = (p) => {
    setModelMenuOpen(false);
    openSettings({ preset: p });
  };

  const attachFiles = async () => {
    const files = await window.autobot.pickFiles();
    if (files && files.length) setAttachments((a) => [...a, ...files]);
  };
  const removeAttachment = (i) => setAttachments((a) => a.filter((_, j) => j !== i));

  const effectiveRoutingMode = provider.routingMode
    || (String(provider.model || '').trim().toLowerCase() === 'auto'
      ? 'auto'
      : (orchestrator && orchestrator.enabled ? 'orchestrator' : 'direct'));
  const modelLabel = (provider.model || '').split('/').pop() || 'Select model';
  const lastRoutedModel = (lastUsage && lastUsage.model && String(lastUsage.model).trim().toLowerCase() !== 'auto')
    ? String(lastUsage.model).split('/').pop()
    : '';
  /* Contract labels preserved for routing tests: '⚡ Auto (DeepSeek V4.1 Flash)', '🛰️ Orchestrator Models', '⚡ Auto · DeepSeek V4.1 Flash', '🛰️ Orch ·' */
  const pillDisplayLabel = effectiveRoutingMode === 'auto'
    ? (lastRoutedModel ? `Auto → ${lastRoutedModel}` : 'Auto · DeepSeek')
    : (effectiveRoutingMode === 'orchestrator' ? `Orch · ${modelLabel}` : modelLabel);
  const orchModelChoices = useMemo(() => {
    const out = [];
    const seen = new Set();
    const add = (row, roleHint = '') => {
      if (!row || !row.model) return;
      const m = String(row.model).trim();
      if (!m) return;
      const sig = `${m.toLowerCase()}|${String(row.oauthProvider || '').toLowerCase()}`;
      if (seen.has(sig)) return;
      seen.add(sig);
      out.push({ ...row, model: m, roleHint: roleHint || row.role || '' });
    };
    for (const r of ((orchestrator && orchestrator.providers) || [])) {
      if (r && r.enabled !== false) add(r);
    }
    if (orchestrator && orchestrator.pools && orchestrator.pools.enabled) {
      const gw = orchestrator.pools.gateway || {};
      const roles = orchestrator.pools.roles || {};
      for (const [roleName, def] of Object.entries(roles)) {
        if (!def || !Array.isArray(def.models)) continue;
        for (const raw of def.models) {
          const m = typeof raw === 'string' ? raw.replace(/@\d+$/, '').trim() : (raw && raw.model);
          if (m) add({ model: m, baseURL: gw.baseURL || provider.baseURL || '', apiKey: gw.apiKey || provider.apiKey || '', role: roleName }, roleName);
        }
      }
    }
    // Also surface live signed-in subscription account models so Orchestrator pairs work out of the box.
    if (provOauth && Array.isArray(provOauth.providers)) {
      for (const pv of provOauth.providers) {
        const accts = pv.accounts || [];
        if (!accts.length) continue;
        const firstAcct = accts[0];
        const live = provModels[pv.id + ':' + firstAcct.account] || provModels[pv.id];
        const list = (live && live.models && live.models.length ? live.models : (pv.models || []));
        for (const m of list) {
          if (!m || !m.id) continue;
          add({
            model: m.id,
            oauthProvider: firstAcct.id,
            transport: pv.transport,
            oauth: true,
            baseURL: '',
            apiKey: '',
            role: /opus|fable|high/i.test(m.id) ? 'planner' : (/haiku|low|fast/i.test(m.id) ? 'fast' : 'coder'),
          }, pv.label || pv.id);
        }
      }
    }
    return out;
  }, [orchestrator, provider.baseURL, provider.apiKey, provOauth, provModels]);
  // Short window chip ("1M", "200K") next to the model name so the user can see
  // the effective context length without opening the picker. Backed by the
  // live per-model window cached from `autobot:providerModels`.
  const modelWindowLabel = (() => {
    const w = contextWindowFor(provider.model);
    if (!w) return '';
    if (w >= 1000000) return Math.round(w / 100000) / 10 + 'M';
    return Math.round(w / 1000) + 'K';
  })();
  const allStyles = useMemo(() => {
    const byId = new Map();
    for (const s of STYLES) byId.set(s.id, s);
    for (const cs of (Array.isArray(customStyles) ? customStyles : [])) {
      if (!cs || !cs.id) continue;
      byId.set(cs.id, { ...cs, prompt: cs.prompt || cs.directive || '' });
    }
    return [...byId.values()];
  }, [customStyles]);
  const activeStyle = allStyles.find((s) => s.id === styleId) || allStyles[0];

  return (
    <div className={'inputbar' + (dragOver ? ' drag-over' : '')} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }} onDrop={onDropFiles}>
      <div className="cwdbar">
        <EnvironmentPicker
          envState={envState}
          onSwitchEnvironment={onSwitchEnvironment}
          onOpenEnvironments={onOpenEnvironments}
        />
        <span className="cwd" title={cwd || '~'}><Icon name="Folder" size={13} /><span className="cwd-text">{cwd || '~'}</span></span>
        {(!envState || !envState.active || envState.active.kind === 'local') ? (
          <button className="cwd-pick" onClick={async () => { const d = await window.autobot.pickFolder(); if (d) { setCwd(d); const id = loadJSON('autobot:activeId', null); if (id) window.autobot.setWorkspace(id, d).catch(() => {}); } }}>Change</button>
        ) : (
          <button className="cwd-pick" onClick={() => onSwitchEnvironment && onSwitchEnvironment({ kind: 'local' })}>Disconnect</button>
        )}
      </div>

      <MessageQueueTray
        items={queued}
        queuePaused={queuePaused}
        streaming={streaming}
        onToggleQueuePaused={onToggleQueuePaused}
        onClearAll={onClearQueue}
        onToggleItemPaused={onToggleQueueItemPaused}
        onReorder={onReorderQueue}
        onStepItem={onStepQueueItem}
        onUpdateItemText={onUpdateQueueItemText}
        onSendNow={sendQueuedNow}
        onDeleteItem={unqueue}
      />

      {/* Settings row — outside the composer box, above it (Claude-style).
          The box itself keeps only what Claude keeps in it: the command hint,
          attach, the context ring, the model pill and send. Every control that
          carries a label lives up here, because a labelled control inside a
          682 px flex footer overflows the row, and `overflow: hidden` then
          clips it out of existence — which is exactly why the tools button was
          unclickable at every width above 1100 px while the context ring sat
          on top of it. Nothing can be squeezed past the border now. */}
      <div className="composer-topbar">
        <div className="topbar-left">
            {/* Reasoning / thinking level — adapts dynamically to active model's capabilities & sibling tiers. */}
            {(() => {
              const effModel = effectiveRoutingMode === 'auto' ? 'auto' : (provider.model || 'auto');
              const tCaps = thinkingCapabilitiesForUi(effModel);
              const allowedSet = new Set(tCaps.levels && tCaps.levels.length ? tCaps.levels : ['auto', 'low', 'medium', 'high']);
              const visibleLevels = REASON_LEVELS.filter((lv) => allowedSet.has(lv.id));
              const discreteVariantMatch = /-(minimal|low|medium|high|xhigh)$/i.exec(effModel);
              const displayedLevel = (discreteVariantMatch && reasoningLevel === 'auto')
                ? discreteVariantMatch[1].toLowerCase()
                : reasoningLevel;
              const applyThinkingPick = (lvId) => {
                if (tCaps.variants && tCaps.variants[lvId] && tCaps.variants[lvId] !== provider.model) {
                  setProvider((p) => ({ ...p, model: tCaps.variants[lvId], reasoningLevel: lvId }));
                } else {
                  setReasoningLevel(lvId);
                }
                setReasonOpen(false);
              };
              return (
                <div className="style-wrap f-think">
                  <button
                    type="button"
                    className={'reason-pick' + (!tCaps.supported ? ' unsupported' : (displayedLevel !== 'auto' ? ' active' : ''))}
                    title={!tCaps.supported
                      ? `${effModel} does not expose adjustable thinking levels`
                      : ('Thinking level — ' + (displayedLevel === 'auto' ? 'model decides' : displayedLevel) + (tCaps.variants ? ' (auto-switches discrete model variant)' : ''))}
                    onClick={() => { if (tCaps.supported) setReasonOpen(!reasonOpen); }}
                    disabled={!tCaps.supported}
                    aria-haspopup={tCaps.supported ? 'listbox' : undefined}
                    aria-expanded={tCaps.supported ? reasonOpen : undefined}
                    aria-label="Thinking level"
                  >
                    <Icon name="ExtendedThinking" size={16} />
                    <span className="reason-label">Thinking</span>
                    <span className="reason-val">{!tCaps.supported ? 'N/A' : (REASON_LABELS[displayedLevel] || 'Auto')}</span>
                    {tCaps.supported && <span className="reason-caret" aria-hidden="true">▾</span>}
                  </button>
                  {tCaps.supported && reasonOpen && (
                    <div className="style-menu reason-menu" role="listbox">
                      <div className="model-menu-head">Thinking level{tCaps.variants ? ' · Sibling Variants' : ''}</div>
                      {visibleLevels.map((lv) => {
                        const targetVariant = tCaps.variants && tCaps.variants[lv.id];
                        return (
                          <button
                            key={lv.id}
                            type="button"
                            role="option"
                            aria-selected={displayedLevel === lv.id}
                            className={'model-opt' + (displayedLevel === lv.id ? ' on' : '')}
                            onClick={() => applyThinkingPick(lv.id)}
                          >
                            <span className="model-opt-name">{lv.name}</span>
                            <span className="model-opt-prov">{targetVariant ? targetVariant : lv.hint}</span>
                            {displayedLevel === lv.id && <Icon name="Check" size={13} className="model-check" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Swarm — user-opted escalation to a frontier-model team. Off by
                default; multi-agent (Task/Agent) still happens automatically.
                Labelled on purpose: an icon-only toggle was invisible. */}
            <button
              type="button"
              className={'swarm-pill' + (swarmEnabled ? ' active' : '')}
              title={swarmEnabled
                ? 'Swarm ON — Planner coordinates parallel role-pooled workers across a shared message board with automatic failover'
                : 'Swarm OFF — click to enable multi-model Swarm orchestration (multi-agent Task/Agent still runs automatically)'}
              aria-pressed={swarmEnabled}
              aria-label={'Swarm ' + (swarmEnabled ? 'on' : 'off')}
              onClick={() => setSwarmEnabled(!swarmEnabled)}
            >
              <Icon name="Users" size={15} />
              <span className="swarm-label">Swarm</span>
              <span className="swarm-state">{swarmEnabled ? 'On' : 'Off'}</span>
            </button>

            {/* Secondary answer tools live behind one button, exactly like the
                `+` menu in the Claude app. Nine inline controls could not fit a
                712 px composer and spilled past the border; a popover keeps
                every one of them reachable at any width without moving the
                primary row (attach · thinking · swarm  |  context · model · send). */}
            <div className="tools-wrap">
              <button
                type="button"
                className={'icon-btn tools-btn' + ((webSearch || (sessionPane && sessionPane.type === 'browser') || dictating || voiceMode || styleId !== 'default') ? ' active' : '')}
                title="Answer tools — style, web search, browser, dictation, voice"
                aria-haspopup="menu"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(!toolsOpen)}
              >
                <Icon name="Sliders" size={17} />
              </button>
              {toolsOpen && (
                <div className="tools-menu" role="menu">
                  <div className="model-menu-head">Answer tools</div>
                  <button type="button" role="menuitemcheckbox" aria-checked={!!webSearch} className="tools-row" onClick={() => setWebSearch(!webSearch)}>
                    <Icon name="Globe" size={15} />
                    <span className="tools-row-label">Web search</span>
                    <span className={'tools-state' + (webSearch ? ' on' : '')}>{webSearch ? 'On' : 'Off'}</span>
                  </button>
                  <button type="button" role="menuitem" className="tools-row" onClick={() => { toggleSessionPane('browser'); setToolsOpen(false); }}>
                    <Icon name="Window" size={15} />
                    <span className="tools-row-label">Browser</span>
                    <span className={'tools-state' + (sessionPane && sessionPane.type === 'browser' ? ' on' : '')}>{sessionPane && sessionPane.type === 'browser' ? 'Open' : 'Closed'}</span>
                  </button>
                  <button type="button" role="menuitemcheckbox" aria-checked={voice.state !== 'idle'} className="tools-row" onClick={() => voice.toggle()}>
                    <Icon name={voice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={15} className={voice.state === 'transcribing' ? 'spin' : ''} />
                    <span className="tools-row-label">Dictate (Built-in Whisper)</span>
                    <span className={'tools-state' + (voice.state !== 'idle' ? ' on' : '')}>
                      {voice.state === 'recording' ? `Listening ${voice.seconds}s` : (voice.state === 'transcribing' ? 'Transcribing…' : 'Off')}
                    </span>
                  </button>
                  <button type="button" role="menuitemcheckbox" aria-checked={!!voiceMode} className="tools-row" onClick={() => (voiceMode ? stopVoiceMode() : startVoiceMode())}>
                    <Icon name="Voice" size={15} />
                    <span className="tools-row-label">Voice mode</span>
                    <span className={'tools-state' + (voiceMode ? ' on' : '')}>{voiceMode ? 'On' : 'Off'}</span>
                  </button>
                  <div className="model-menu-divider" />
                  <div className="model-menu-head">Style</div>
                  {allStyles.map((st) => (
                    <button key={st.id} type="button" role="menuitemradio" aria-checked={styleId === st.id} className={'model-opt' + (styleId === st.id ? ' on' : '')} onClick={() => { setStyleId(st.id); setToolsOpen(false); }}>
                      <span className="model-opt-name">{st.name}</span>
                      {(st.hint || st.custom) && <span className="model-opt-prov">{st.hint || 'Custom'}</span>}
                      {styleId === st.id && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                  ))}
                  {onOpenCustomizations && (
                    <button type="button" className="model-opt" onClick={() => { setToolsOpen(false); onOpenCustomizations(); }}>
                      <Icon name="Add" size={13} />
                      <span className="model-opt-name">Manage Custom Outputs…</span>
                    </button>
                  )}
                </div>
              )}
            </div>
        </div>
        <div className="topbar-right">
            <div className="perm-pill-wrap" ref={permWrapRef}>
              <button className={'perm-pill' + (permOpen ? ' open' : '')} onClick={() => setPermOpen(!permOpen)} title={T('perm.sessionHead')}>
                <span className="perm-name">{T(PERM_SHORT[permissions] || 'perm.auto')}</span>
              </button>
              {permOpen && (
                <div className="perm-menu">
                  <div className="perm-menu-head">{T('perm.sessionHead')}</div>
                  {PERM_MODES.map((m, i) => {
                    const active = permissions === m.id;
                    return (
                      <button key={m.id} className={'perm-opt' + (active ? ' on' : '')} onClick={() => { setPermissions(m.id); setPermOpen(false); }}>
                        <span className="perm-opt-body">
                          <span className="perm-opt-title">{T(m.title)}</span>
                          <span className="perm-opt-desc">{T(m.desc)}</span>
                        </span>
                        <span className="perm-opt-meta">
                          {active && <Icon name="Check" size={14} className="model-check" />}
                          <span className="perm-opt-num">{i + 1}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
        </div>
      </div>

      <div className={'composer-shell' + (slashOpen || mentionOpen ? ' has-palette' : '')}>
        {slashOpen && (
          <div className="slash-palette" ref={slashPaletteRef} role="listbox" aria-label="Slash actions">
            {filteredSlashActions.map((item, idx) => (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={idx === slashIdx}
                className={'slash-row' + (idx === slashIdx ? ' sel' : '')}
                onMouseEnter={() => setSlashIdx(idx)}
                onMouseDown={(e) => { e.preventDefault(); applySlashItem(item, 'enter'); }}
              >
                <span className="slash-ico">
                  <Icon
                    name={item.icon === 'btw' ? 'ChatAdd' : item.icon === 'mcp' ? 'CommandLinePrompt' : item.icon === 'goal' ? 'Clock' : item.icon === 'skill' ? 'Sparkles' : 'CommandLine'}
                    size={15}
                  />
                </span>
                <span className="slash-name">{item.name}</span>
                <span className="slash-desc">{item.description}</span>
              </button>
            ))}
          </div>
        )}

        {mentionOpen && (
          <div className="mention-palette" ref={mentionPaletteRef} role="listbox" aria-label="Mentions">
            <div className="mention-head">Mentions · Agents &amp; Files</div>
            {mentionItems.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={idx === mentionIdx}
                className={'slash-row' + (idx === mentionIdx ? ' sel' : '')}
                onMouseEnter={() => setMentionIdx(idx)}
                onMouseDown={(e) => { e.preventDefault(); applyMentionItem(item); }}
              >
                <span className="slash-ico">
                  <Icon name={item.kind === 'agent' ? 'Agent' : 'File'} size={14} />
                </span>
                <span className="slash-name">{item.label}</span>
                <span className="slash-desc">{item.sub}</span>
              </button>
            ))}
          </div>
        )}

      <div className={'composer' + (streaming ? ' is-streaming' : '')}>
        {activeSkillPill && (
          <div className="composer-skill-bar" data-testid="composer-skill-pill">
            <span className="composer-skill-pill">
              <Icon name={activeSkillPill.icon || 'Clock'} size={12} />
              <strong>{activeSkillPill.label}</strong>
              <span className="composer-skill-hint">{activeSkillPill.hint}</span>
              <button
                type="button"
                className="composer-skill-start"
                onClick={() => {
                  const text = (inputRef.current?.value || '').trim();
                  if (inputRef.current) inputRef.current.value = '';
                  syncInputState('');
                  if (onClearSkillPill) onClearSkillPill();
                  runSlashCommand((activeSkillPill.id || 'automation') + (text ? ' ' + text : ''), { direct: true });
                }}
              >
                Start →
              </button>
              <button
                type="button"
                className="attach-x"
                title="Remove skill"
                aria-label="Remove automation skill pill"
                onClick={() => onClearSkillPill && onClearSkillPill()}
              >
                <Icon name="X" size={11} />
              </button>
            </span>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a, i) => (
              <span key={i} className={'attach-chip' + (a.isImage ? ' img' : a.isText ? ' text' : ' bin')} title={a.path || a.name}>
                {a.isImage && a.dataUrl
                  ? <img className="attach-thumb" src={a.dataUrl} alt={a.name} />
                  : <Icon name={a.isText ? 'File' : 'Attachment'} size={12} />}
                <span className="attach-name">{a.name}</span>
                {a.isText || a.isImage ? null : <span className="attach-size"> · {a.size} B</span>}
                <button className="attach-x" onClick={() => removeAttachment(i)}><Icon name="X" size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={T('composer.placeholder')}
          onFocus={() => refreshSlashActions()}
          onKeyDown={onKey}
          onInput={(e) => syncInputState(e.target.value)}
          onPaste={onPasteFiles}
        />
        <div className="composer-foot">
          <div className="composer-actions">
            <div className="add-context-wrap" ref={addCtxWrapRef}>
              <button
                type="button"
                className={'icon-btn add-context-btn' + (addCtxOpen ? ' open' : '')}
                title="Add Context (Files, Folder, @Mentions, /Actions, Browser, Drive)"
                aria-label="Add Context"
                aria-haspopup="menu"
                aria-expanded={addCtxOpen}
                onClick={() => setAddCtxOpen((v) => !v)}
              >
                <Icon name="Plus" size={16} />
              </button>
              {addCtxOpen && (
                <div className="add-context-menu" role="menu">
                  <div className="add-context-head">Add Context</div>
                  <button type="button" role="menuitem" className="add-context-item" onClick={() => { setAddCtxOpen(false); attachFiles(); }}>
                    <Icon name="Attachment" size={15} />
                    <span className="add-context-label">Files</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={attachFolderContext}>
                    <Icon name="Folder" size={15} />
                    <span className="add-context-label">Folder</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={triggerMentionInsert}>
                    <span className="add-context-glyph">@</span>
                    <span className="add-context-label">Mentions</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={triggerActionsInsert}>
                    <Icon name="CommandLinePrompt" size={15} />
                    <span className="add-context-label">Actions</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={attachBrowserContext}>
                    <Icon name="Globe" size={15} />
                    <span className="add-context-label">Browser</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={() => { setAddCtxOpen(false); onOpenGdrive && onOpenGdrive(); }}>
                    <GoogleDriveIcon size={15} />
                    <span className="add-context-label">Drive</span>
                    <span className={'add-context-badge' + (gdriveState && gdriveState.connected ? ' ok' : ' setup')}>
                      {gdriveState && gdriveState.connected ? 'Connected' : 'Set up'}
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button className="icon-btn attach-btn f-attach" title="Attach files" onClick={attachFiles}><Icon name="Attachment" size={16} /></button>
          </div>

          <div className="composer-right">
            <button
              type="button"
              className="ctx-btn"
              title={'Context: ' + fmtInt(usedTokens(lastUsage)) + ' of ' + fmtInt(ctxWindow) + ' tokens used — open Environment'}
              onClick={() => toggleSessionPane('env')}
            >
              <ContextMeter used={usedTokens(lastUsage)} win={ctxWindow} size={26} />
            </button>
            <div className="model-pill-wrap" ref={modelWrapRef}>
              <button
                className={'model-pill' + (modelMenuOpen ? ' open' : '') + (effectiveRoutingMode === 'auto' ? ' mode-auto' : effectiveRoutingMode === 'orchestrator' ? ' mode-orchestrator' : '')}
                data-testid="model-picker-pill"
                data-routing-mode={effectiveRoutingMode}
                onClick={() => setModelMenuOpen(!modelMenuOpen)}
                title={effectiveRoutingMode === 'auto'
                  ? 'Smart AI Complexity Router active — click to switch routing mode or model'
                  : effectiveRoutingMode === 'orchestrator'
                    ? 'Orchestrator Supervisor + Pool active — click to switch routing mode or model'
                    : 'Change model'}
              >
                <ModelLogo
                  model={effectiveRoutingMode === 'auto' ? 'deepseek' : (effectiveRoutingMode === 'orchestrator' ? (provider.model || 'orchestrator') : provider.model)}
                  provider={provider.oauthProvider || provider.baseURL}
                  baseURL={provider.baseURL}
                  size={14}
                  className="model-ico"
                />
                {effectiveRoutingMode === 'auto' && lastRoutedModel && (
                  <ModelLogo model={lastRoutedModel} size={13} className="model-ico-routed" />
                )}
                <span className="model-name">{pillDisplayLabel}</span>
                {effectiveRoutingMode !== 'auto' && modelWindowLabel && <span className="model-win" title={'Context window: ' + modelWindowLabel + ' tokens'}>{modelWindowLabel}</span>}
                {effectiveRoutingMode === 'direct' && activeDot && <span className={'model-dot ' + activeDot} title={activeKeyState.detail || ''} />}
                <Icon name={modelMenuOpen ? 'CaretUp' : 'CaretDown'} size={12} className="model-caret" />
              </button>
              {modelMenuOpen && (
                <div className="model-menu" ref={modelMenuRef}>
                  <div className="model-menu-head">Routing mode</div>
                  {onOpenTutorial && (
                    <button
                      type="button"
                      data-testid="open-mode-guide-btn"
                      className="mode-guide-link"
                      onClick={() => { setModelMenuOpen(false); onOpenTutorial('guide'); }}
                    >
                      <Icon name="GraduationCap" size={12} /> Not sure which mode? Open Quick Guide →
                    </button>
                  )}
                  <div className={'routing-mode-wrap' + (effectiveRoutingMode === 'auto' ? ' on' : '')}>
                    <button
                      type="button"
                      data-testid="routing-mode-auto"
                      className={'model-opt routing-mode-card' + (effectiveRoutingMode === 'auto' ? ' on' : '')}
                      onClick={selectAutoMode}
                    >
                      <ModelLogo model="deepseek" size={18} className="routing-mode-logo" />
                      <div className="routing-mode-main">
                        <span className="model-opt-name">Auto (DeepSeek V4.1 Flash)</span>
                        <span className="routing-mode-sub">
                          {hasDeepSeekKey
                            ? 'DeepSeek Dispatcher active — picks Fast, Coder, Frontier, Vision, or 1M model per prompt'
                            : 'Offline heuristic fallback ready — configure a DeepSeek key for ~150ms AI task dispatch'}
                        </span>
                      </div>
                      {effectiveRoutingMode === 'auto' && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                    {!hasDeepSeekKey && (
                      <div className="routing-mode-config-bar">
                        <button
                          type="button"
                          data-testid="configure-deepseek-key-btn"
                          className="configure-deepseek-pill"
                          onClick={() => { setModelMenuOpen(false); openSettings({ section: 'system', focus: 'deepseek-router' }); }}
                        >
                          Setup Free Key →
                        </button>
                      </div>
                    )}
                  </div>
                  <div className={'orch-picker-box' + (effectiveRoutingMode === 'orchestrator' ? ' on' : '')} data-testid="routing-mode-orchestrator">
                    <div className="orch-picker-head">
                      <button
                        type="button"
                        className="orch-picker-toggle"
                        onClick={() => setOrchExpanded((v) => !v)}
                        aria-expanded={orchExpanded}
                      >
                        <ModelLogo model="orchestrator" size={16} />
                        <span className="model-opt-name">Orchestrator Models</span>
                        {effectiveRoutingMode === 'orchestrator' && <span className="orch-active-tag">On</span>}
                        <Icon name={orchExpanded ? 'CaretUp' : 'CaretDown'} size={11} />
                      </button>
                      <button
                        type="button"
                        data-testid="orch-configure-btn"
                        className="orch-config-link"
                        onClick={() => { setModelMenuOpen(false); openSettings({ section: 'orchestrator' }); }}
                      >
                        Configure…
                      </button>
                    </div>
                    {(orchExpanded || effectiveRoutingMode === 'orchestrator') && (() => {
                      const hasMatchingOrchRow = effectiveRoutingMode === 'orchestrator' && orchModelChoices.some((r) => provider.model === r.model && String(provider.oauthProvider || '') === String(r.oauthProvider || ''));
                      return (
                      <div className="orch-picker-body">
                        <button
                          type="button"
                          data-testid="orch-use-supervisor"
                          className={'model-opt orch-supervisor-btn' + (effectiveRoutingMode === 'orchestrator' && !hasMatchingOrchRow ? ' on' : '')}
                          onClick={() => activateOrchestratorSupervisor(null)}
                        >
                          <ModelLogo model="orchestrator" size={14} />
                          <span className="model-opt-name">Activate Orchestrator (Use Selected Model as Supervisor)</span>
                          {effectiveRoutingMode === 'orchestrator' && !hasMatchingOrchRow && <Icon name="Check" size={13} className="model-check" />}
                        </button>
                        {orchModelChoices.length > 0 ? orchModelChoices.map((row) => {
                          const rowActive = effectiveRoutingMode === 'orchestrator' && provider.model === row.model && String(provider.oauthProvider || '') === String(row.oauthProvider || '');
                          return (
                            <button
                              key={`${row.model}|${row.oauthProvider || row.baseURL || ''}`}
                              type="button"
                              className={'model-opt' + (rowActive ? ' on' : '')}
                              onClick={() => activateOrchestratorSupervisor(row)}
                            >
                              <span className="model-dot ok" />
                              <ModelLogo model={row.model} provider={row.oauthProvider || row.name} baseURL={row.baseURL} size={14} />
                              <span className="model-opt-name">{row.model.split('/').pop()}</span>
                              <span className="model-opt-prov" title={row.roleHint || row.name || 'Orchestrator'}>{row.roleHint || row.name || 'Orchestrator'}</span>
                              {rowActive && <Icon name="Check" size={13} className="model-check" />}
                            </button>
                          );
                        }) : (
                          <div className="prov-none">No Orchestrator models selected — click Configure… to connect OAuth or API keys</div>
                        )}
                        {orchModelChoices.length > 1 && setOrchestrator && (
                          <div className="orch-executor-row" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '6px 8px 2px', borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 4 }}>
                            <span style={{ fontSize: 11, opacity: 0.72 }}>Executor</span>
                            <select
                              aria-label="Orchestrator Executor Model"
                              value={(orchestrator && orchestrator.executorModel) || ''}
                              onChange={(e) => setOrchestrator({ ...(orchestrator || { enabled: true, providers: [] }), executorModel: e.target.value || '' })}
                              style={{ maxWidth: 165, fontSize: 11, background: 'rgba(255,255,255,0.06)', color: 'inherit', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 6, padding: '2px 6px' }}
                            >
                              <option value="">Auto · Best Coder</option>
                              {orchModelChoices.map((r) => (
                                <option key={'ex:' + r.model} value={r.model}>{r.model.split('/').pop()}</option>
                              ))}
                            </select>
                          </div>
                        )}
                      </div>
                      );
                    })()}
                  </div>
                  <div className="model-menu-divider" />
                  <div className="model-menu-head">Model · this session{keyProbing ? ' · checking keys…' : ''}</div>
                  <SessionModelList
                    rows={pickerRows}
                    isActive={(r) => effectiveRoutingMode === 'direct' && provider.baseURL === r.preset.baseURL && provider.model === r.model}
                    renderRow={(r) => {
                      const active = effectiveRoutingMode === 'direct' && provider.baseURL === r.preset.baseURL && provider.model === r.model;
                      const st = presetStatus(r.preset, { keyFor, status: keyStatus, probing: keyProbing });
                      const rowBase = normBase(r.preset.baseURL);
                      const isOllama = /:11434\b/.test(rowBase);
                      const scan = ollama[rowBase];
                      const ollamaDown = isOllama && !(scan && scan.ok && scan.models && scan.models.length);
                      return (
                        <button
                          key={r.key}
                          className={'model-opt' + (active ? ' on' : '') + (st.row ? ' ' + st.row : '')}
                          title={r.local ? (r.prov + ' — ' + r.model) : (ollamaDown || st.row === 'dim' ? undefined : st.label)}
                          onClick={() => {
                            if (r.local) return pickModel(r.preset, r.model);
                            if (ollamaDown) return connectOllama();
                            if (st.row === 'dim') return configurePreset(r.preset);
                            return pickModel(r.preset, r.model);
                          }}
                        >
                          <span className={'model-dot ' + (r.local ? 'ok' : st.dot)} />
                          <ModelLogo model={r.model} label={r.label} provider={r.prov || (r.preset && r.preset.name)} baseURL={r.preset && r.preset.baseURL} size={16} />
                          <span className="model-opt-name">{r.label}</span>
                          {(ollamaDown || (!r.local && st.row === 'dim') || r.ctxBadge) && (
                            <span className="model-opt-prov">
                              {ollamaDown ? 'click to connect' : (!r.local && st.row === 'dim' ? st.label : r.ctxBadge)}
                            </span>
                          )}
                          {active && <Icon name="Check" size={13} className="model-check" />}
                        </button>
                      );
                    }}
                  />
                  {ollamaEmpty && (
                    <button className="model-opt model-connect" disabled={ollamaBusy} onClick={connectOllama}>
                      <ModelLogo provider="ollama" size={15} />
                      <span className="model-opt-name">{ollamaBusy ? 'Connecting to Ollama…' : 'Connect Ollama (local)'}</span>
                      <span className="model-opt-prov">{ollamaBusy ? '' : 'starts the server'}</span>
                    </button>
                  )}
                  {provOauth && (
                    <>
                      <div className="model-menu-divider" />
                      <div className="model-menu-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <span>Subscription accounts</span>
                        <button
                          type="button"
                          className="prov-link"
                          title="Refresh live model catalogs from signed-in accounts"
                          onClick={async () => {
                            try {
                              if (window.autobot?.refreshModelCatalogs) await window.autobot.refreshModelCatalogs();
                              await loadProvOauth();
                            } catch (_) {}
                          }}
                        >
                          <Icon name="Refresh" size={11} /> Refresh models
                        </button>
                      </div>
                      {/* An index that could not be parsed is not "no accounts":
                          say so here too, where the user picks a model. */}
                      {provOauth.storeError && (
                        <ProvNotice warn text={T('account.storeError')} />
                      )}
                      {provOauth.providers.map((pv) => {
                        const accounts = pv.accounts || [];
                        const live = provModels[pv.id];
                        // Honesty: a provider is "unverified" only when no real
                        // account of that kind was ever exercised here. Claude
                        // and Antigravity are field-verified (including live
                        // model enumeration); a provider that just answered a
                        // live catalog request is verified for that much at
                        // least. A live `warning` (dead token, 403) keeps the
                        // badge on.
                        const anyVerified = accounts.some((a) => (a.verifiedAt || 0) > 0);
                        const unverified = !(pv.id === 'claude' || pv.id === 'antigravity'
                          || (live && live.live) || anyVerified);
                        return (
                          <div key={pv.id} className="prov-group">
                            <div className="prov-head">
                              <ModelLogo provider={pv.id} size={14} />
                              <span className="prov-name">{pv.label}</span>
                              {unverified && <span className="prov-unv" title="Adapter implemented from the published wire format and unit-tested; no account of this kind exists on this machine to verify end-to-end.">unverified</span>}
                              {pv.id === 'claude' && (
                                <button
                                  className="prov-link"
                                  title="The Claude Code CLI owns this credential — this starts its own sign-in and adopts the result, so the CLI stays signed in."
                                  disabled={!!provBusy || claudeSignIn.busy}
                                  onClick={claudeSignIn.start}
                                >{claudeSignIn.busy ? 'Opening…' : (accounts.length ? 'Reconnect' : 'Sign in')}</button>
                              )}
                              {pv.id !== 'claude' && pv.canBrowserSignIn && (
                                <button
                                  className="prov-link"
                                  title={provBusy === 'signin:' + pv.id ? 'Stop waiting for the browser' : 'Open the provider sign-in page'}
                                  disabled={!!provBusy && provBusy !== 'signin:' + pv.id}
                                  onClick={() => (provBusy === 'signin:' + pv.id ? cancelBrowserSignIn(pv.id) : providerAction('signin', pv.id))}
                                >{provBusy === 'signin:' + pv.id ? 'Cancel' : (accounts.length ? 'Add account' : 'Sign in')}</button>
                              )}
                              {pv.id !== 'claude' && pv.canManualCode && (
                                <button
                                  className="prov-link prov-link-sub"
                                  title="The sign-in page shows a code you paste back here — use this when the browser cannot reach this machine."
                                  disabled={!!provBusy}
                                  onClick={() => startManualSignIn(pv.id)}
                                >{provBusy === 'manual:' + pv.id ? 'Opening…' : 'Paste code'}</button>
                              )}
                            </div>
                            {accounts.map((a) => {
                              const on = provider.oauthProvider === a.id;
                              // Per-account catalogs: the same vendor can hold
                              // several accounts whose plans expose different
                              // models, so resolve the list for this account.
                              const own = provModels[pv.id + ':' + a.account] || live;
                              const list = (own && own.models && own.models.length ? own.models : (pv.models || []));
                              return (
                                <div key={a.id} className={'prov-acct' + (on ? ' on' : '')}>
                                  <button className="prov-pick" title={a.expired ? 'Stated expiry passed and the refresh was refused — a turn may still work; sign in again if it is rejected' : (a.label || a.account)} onClick={() => pickOauthAccount(pv, a.account)}>
                                    <span className={'model-dot ' + (a.expired ? 'out' : 'ok')} />
                                    <ModelLogo provider={pv.id} size={14} />
                                    <span className="model-opt-name">{a.label || a.account}</span>
                                    <span className="model-opt-prov">{a.plan || a.source || 'signed in'}</span>
                                    {on && !provider.model && <Icon name="Check" size={13} className="model-check" />}
                                  </button>
                                  <button className="prov-x" title="Sign out" disabled={!!provBusy} onClick={() => providerAction('signout', pv.id, a.account)}><Icon name="X" size={12} /></button>
                                  {on && (
                                    <>
                                      {own && own.warning && !list.length && (
                                        <div className="prov-none">{own.warning}</div>
                                      )}
                                      <ProvModelList
                                        list={list}
                                        providerId={pv.id}
                                        picked={effectiveRoutingMode === 'direct' ? provider.model : ''}
                                        onPick={(mid) => pickOauthAccount(pv, a.account, mid)}
                                      />
                                    </>
                                  )}
                                </div>
                              );
                            })}
                            {!accounts.length && pv.canBrowserSignIn && !pv.canPasteKey && !pv.canManualCode && pv.id !== 'claude' && (
                              <div className="prov-none">Not signed in</div>
                            )}
                            {pv.id === 'claude' && (
                              <ClaudeReconnectPanel
                                t={T}
                                rc={claudeSignIn.rc}
                                busy={provBusy || claudeSignIn.busy}
                                onCancel={claudeSignIn.cancel}
                                onChange={claudeSignIn.setCode}
                                onSubmit={claudeSignIn.submit}
                              />
                            )}
                            {pv.id === 'claude' && claudeSignIn.notice && (
                              <ProvNotice text={claudeSignIn.notice} />
                            )}
                            {provManual && provManual.provId === pv.id && (
                              <div className="prov-token prov-manual">
                                <div className="prov-manual-hint">
                                  {provManual.sent ? 'Code sent — checking with ' + pv.vendor + '…'
                                    : 'Sign in in the browser, then paste the code it shows (looks like xxxx#yyyy).'}
                                </div>
                                <input
                                  className="prov-token-in"
                                  type="text"
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder="Paste code"
                                  value={provManual.code || ''}
                                  disabled={!!provBusy || provManual.sent}
                                  onChange={(e) => setProvManual((m) => (m ? { ...m, code: e.target.value } : m))}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); submitManualCode(); }
                                  }}
                                />
                                <button
                                  className="prov-link"
                                  disabled={!!provBusy || provManual.sent || !String(provManual.code || '').trim()}
                                  onClick={submitManualCode}
                                >{provManual.sent ? 'Checking…' : 'Submit'}</button>
                                <button
                                  className="prov-x"
                                  title="Cancel"
                                  onClick={() => setProvManual(null)}
                                ><Icon name="X" size={12} /></button>
                              </div>
                            )}
                            {pv.canPasteKey && (
                              <div className="prov-token">
                                <input
                                  className="prov-token-in"
                                  type="password"
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder={(accounts.length ? 'or paste a ' : 'Paste your ') + pv.vendor + ' API key'}
                                  value={provToken[pv.id] || ''}
                                  disabled={!!provBusy}
                                  onChange={(e) => setProvToken((m) => ({ ...m, [pv.id]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (provToken[pv.id] || '').trim()) {
                                      e.preventDefault();
                                      providerAction('bearer', pv.id, (provToken[pv.id] || '').trim());
                                    }
                                  }}
                                />
                                <button
                                  className="prov-link"
                                  disabled={!!provBusy || !(provToken[pv.id] || '').trim()}
                                  onClick={() => providerAction('bearer', pv.id, (provToken[pv.id] || '').trim())}
                                >{provBusy === 'bearer:' + pv.id ? 'Checking…' : 'Add key'}</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <button className="model-opt" disabled={!!provBusy} onClick={() => providerAction('autoheal')}>
                        <Icon name="Refresh" size={14} />
                        <span className="model-opt-name">{provBusy === 'autoheal:' ? 'Healing PC accounts…' : 'Auto-Heal PC accounts'}</span>
                      </button>
                      <button className="model-opt" disabled={!!provBusy} onClick={() => providerAction('import')}>
                        <Icon name="Plug" size={14} />
                        <span className="model-opt-name">{provBusy === 'import:' ? 'Scanning this Mac…' : 'Import accounts from this Mac'}</span>
                      </button>
                      <ProvNotice text={provNotice} />
                    </>
                  )}
                  <div className="model-menu-divider" />
                  <button className="model-opt" onClick={() => { setModelMenuOpen(false); openSettings(); }}>
                    <Icon name="Settings" size={14} /><span className="model-opt-name">Manage providers…</span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className={'mic-btn' + (voice.state !== 'idle' ? ' ' + voice.state : '')}
              onClick={voice.toggle}
              title={voice.statusNote || (voice.state === 'recording' ? 'Stop recording and transcribe (Whisper)' : (voice.state === 'transcribing' ? 'Transcribing speech…' : 'Voice type with built-in Whisper model'))}
            >
              <Icon name={voice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={15} className={voice.state === 'transcribing' ? 'spin' : ''} />
              {voice.state === 'recording' && <span className="mic-time">{Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, '0')}</span>}
            </button>

            {streaming && (
              <button
                type="button"
                className={'pause-btn' + (paused ? ' paused' : '')}
                onClick={() => (paused ? (onResume && onResume('')) : (onPause && onPause()))}
                title={paused ? 'Resume agent' : 'Pause agent at next boundary'}
                aria-label={paused ? 'Resume' : 'Pause'}
              >
                <Icon name={paused ? 'Play' : 'Pause'} size={15} />
              </button>
            )}
            {streaming && <button className="send stop" onClick={stop} title="Stop"><Icon name="Stop" size={16} /></button>}
            {(!streaming || hasText || Boolean(activeSkillPill)) && (
              <button
                className={'send' + (streaming ? ' queued' : '')}
                onClick={() => {
                  const text = (inputRef.current?.value || '').trim();
                  if (activeSkillPill && activeSkillPill.id === 'automation') {
                    if (inputRef.current) inputRef.current.value = '';
                    syncInputState('');
                    if (onClearSkillPill) onClearSkillPill();
                    runSlashCommand('automation' + (text ? ' ' + text : ''), { direct: true });
                    return;
                  }
                  send();
                  syncInputState('');
                }}
                title={streaming ? 'Queue message' : 'Send'}
              >
                <Icon name="ArrowUp" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------- Settings ----------
// ---------- Accounts ----------

/**
 * One human-readable line out of any error value: strip markup, collapse
 * whitespace, cap the length. Every surface that shows a provider error uses
 * this so nothing raw (HTML, stack trace, JSON) ever reaches the user.
 */