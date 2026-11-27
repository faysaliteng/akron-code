import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Icon, ModelLogo } from './Icon.jsx';
import { ProactiveDashboard } from './ProactiveDashboard.jsx';
import { useDismiss } from '../utils/appHelpers.jsx';

export const CADENCES = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { id: 'weekly', label: 'Weekly' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'every', label: 'Every N minutes' },
  { id: 'once', label: 'One-time (Date & Time)' },
  { id: 'cron', label: 'Custom Cron (5-field)' },
  { id: 'manual', label: 'Manual Only (Routine)' },
];

export const STARTER_TEMPLATES = [
  {
    id: 'morning-briefing',
    icon: 'Sun',
    name: 'Morning Briefing',
    scheduleLabel: 'Weekdays at 7:18 AM',
    description: 'Summarize yesterday’s commits, open PRs, failing checks, and top 3 focus priorities.',
    prompt: 'Review git commits from the last 24 hours, active branch status, open issues/TODOs, and test health in this project. Deliver a concise Morning Briefing with today’s top 3 actionable priorities.',
    triggers: [{ type: 'schedule', cadence: 'weekdays', time: '07:18' }],
    permissionMode: 'plan',
    attentionGate: true,
    useWorktree: false,
  },
  {
    id: 'git-pr-digest',
    icon: 'GitBranch',
    name: 'Git & PR Review Digest',
    scheduleLabel: 'Weekdays at 7:52 AM',
    description: 'Inspect recent commits and uncommitted diffs for bugs, edge cases, and missing tests.',
    prompt: 'Inspect git diff and the latest commits on this repository. Report correctness risks, security hazards, missing error handling, and missing tests with exact file and line numbers.',
    triggers: [{ type: 'schedule', cadence: 'weekdays', time: '07:52' }],
    permissionMode: 'plan',
    attentionGate: true,
    useWorktree: false,
  },
  {
    id: 'nightly-build-sweep',
    icon: 'Check',
    name: 'Nightly Test & Build Sweep',
    scheduleLabel: 'Daily at 2:14 AM',
    description: 'Run the test suite and production build in an isolated git worktree and report regressions.',
    prompt: 'Run the project test suite and production build command cleanly. If any test or build step fails, inspect the failing module, diagnose the root cause, and list exact fixes.',
    triggers: [{ type: 'schedule', cadence: 'daily', time: '02:14' }],
    permissionMode: 'auto',
    attentionGate: false,
    useWorktree: true,
  },
  {
    id: 'runtime-health',
    icon: 'Activity',
    name: 'System & Runtime Health Check',
    scheduleLabel: 'Daily at 7:47 AM',
    description: 'Verify MCP connectors, bundled CLI runtimes, provider connectivity, and workspace hygiene.',
    prompt: 'Check the workspace build health, verify configured scripts/configs have no syntax or dependency errors, and report any degraded services or broken links.',
    triggers: [{ type: 'schedule', cadence: 'daily', time: '07:47' }],
    permissionMode: 'plan',
    attentionGate: true,
    useWorktree: false,
  },
  {
    id: 'issue-triage',
    icon: 'Bug',
    name: 'Issue & Bug Triage',
    scheduleLabel: 'Weekdays at 7:23 AM',
    description: 'Scan TODO/FIXME hotspots, recent error logs, and high-churn files to rank impactful fixes.',
    prompt: 'Scan the repository for FIXME, TODO, error handlers swallowing exceptions, and recent high-churn files. Rank the top 5 highest-impact bugs or cleanups with clear recommendations.',
    triggers: [{ type: 'schedule', cadence: 'weekdays', time: '07:23' }],
    permissionMode: 'plan',
    attentionGate: true,
    useWorktree: false,
  },
  {
    id: 'weekly-security-audit',
    icon: 'LockShield',
    name: 'Weekly Dependency & Security Audit',
    scheduleLabel: 'Mondays at 9:37 AM',
    description: 'Audit outdated packages, known advisories, hardcoded secrets, and lockfile consistency.',
    prompt: 'Audit package dependencies, lockfiles, and source files for outdated critical packages, security vulnerabilities, or accidental secret/path leaks. Summarize safe upgrade steps without modifying lockfiles yet.',
    triggers: [{ type: 'schedule', cadence: 'weekly', dayOfWeek: 1, time: '09:37' }],
    permissionMode: 'plan',
    attentionGate: false,
    useWorktree: false,
  },
];

function detectLocalTimezoneClient() {
  let timeZone = 'UTC';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (_) {}
  let offsetLabel = 'GMT+0';
  try {
    const offMin = -new Date().getTimezoneOffset();
    const sign = offMin >= 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const hh = Math.floor(abs / 60);
    const mm = abs % 60;
    offsetLabel = mm ? `GMT${sign}${hh}:${String(mm).padStart(2, '0')}` : `GMT${sign}${hh}`;
  } catch (_) {}
  return { timeZone, offsetLabel, display: `${timeZone} · ${offsetLabel}`, label: `${timeZone} · ${offsetLabel}` };
}

function toLocalDatetimeValue(ms) {
  const d = new Date(ms || (Date.now() + 3600 * 1000));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function makeDefaultTrigger(kind = 'schedule', timeZone = 'UTC') {
  const id = 'trg_' + Math.random().toString(36).slice(2, 7);
  if (kind === 'watch') {
    return { id, type: 'watch', watchGlob: '', watchGit: true, debounceSec: 4 };
  }
  if (kind === 'manual') {
    return { id, type: 'manual' };
  }
  return {
    id,
    type: 'schedule',
    cadence: 'weekdays',
    time: '07:18',
    everyMinutes: 60,
    minute: 18,
    dayOfWeek: 1,
    cron: '18 7 * * 1-5',
    fireAtLocal: toLocalDatetimeValue(Date.now() + 3600 * 1000),
    timeZone,
  };
}

function taskStatusCategory(t) {
  if (!t || t.enabled === false) return 'paused';
  if (t.lastResult && t.lastResult.ok === false) return 'failed';
  return 'active';
}

export function AutomationsView({
  cwd,
  convs = [],
  provider = null,
  projects = [],
  mcpServers = [],
  envState = null,
  onSendToChat,
  onCreateWithPrompt,
  onOpenRunSession,
}) {
  const tzInfo = useMemo(() => detectLocalTimezoneClient(), []);
  const [tasks, setTasks] = useState([]);
  const [tab, setTab] = useState('yours'); // 'yours' | 'templates' | 'proactive'
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'active' | 'paused' | 'failed'
  const [sortBy, setSortBy] = useState('next'); // 'next' | 'last' | 'name'
  const [splitMenuOpen, setSplitMenuOpen] = useState(false);
  const splitMenuRef = useRef(null);
  useDismiss(splitMenuOpen, [splitMenuRef], () => setSplitMenuOpen(false));

  // Unread Proactive badge count (open matters + actionable suggestions)
  const [proactiveBadge, setProactiveBadge] = useState(0);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [prompt, setPrompt] = useState('');
  const [taskModel, setTaskModel] = useState(''); // '' = Default session model, 'auto', 'orchestrator', 'account:..::model', or model id
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const modelPickerRef = useRef(null);
  useDismiss(modelPickerOpen, [modelPickerRef], () => setModelPickerOpen(false));

  const [triggers, setTriggers] = useState(() => [makeDefaultTrigger('schedule', tzInfo.timeZone)]);
  const [taskCwd, setTaskCwd] = useState(cwd || '');
  const [projectId, setProjectId] = useState('');
  const [environment, setEnvironment] = useState({ kind: 'local', label: 'This Computer' });
  const [advOpen, setAdvOpen] = useState(false);
  const [advTab, setAdvTab] = useState('general'); // 'general' | 'connectors' | 'behavior' | 'notifications'
  const [useWorktree, setUseWorktree] = useState(false);
  const [mirrorToWorkspace, setMirrorToWorkspace] = useState(true);
  const [maxSteps, setMaxSteps] = useState(25);
  const [mcpMode, setMcpMode] = useState('all'); // 'all' | 'none' | 'custom'
  const [selectedMcpIds, setSelectedMcpIds] = useState([]);
  const [permissionMode, setPermissionMode] = useState('auto');
  const [attentionGate, setAttentionGate] = useState(false);
  const [retryEnabled, setRetryEnabled] = useState(true);
  const [notifyMode, setNotifyMode] = useState('all');
  const [respectQuietHours, setRespectQuietHours] = useState(true);
  const [pushAlert, setPushAlert] = useState(false);

  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [runningId, setRunningId] = useState('');
  const [expandedRunsId, setExpandedRunsId] = useState(null);
  const [runsByTask, setRunsByTask] = useState({});

  // Live catalog data for Model Picker, Connectors, and Environments
  const [oauthProviders, setOauthProviders] = useState([]);
  const [ollamaModelsList, setOllamaModelsList] = useState([]);
  const [envList, setEnvList] = useState(envState);
  const [liveMcpList, setLiveMcpList] = useState(mcpServers || []);

  const refresh = useCallback(async () => {
    try {
      const list = await window.autobot.listScheduledTasks();
      setTasks(Array.isArray(list) ? list : []);
    } catch (_) {}
  }, []);

  const refreshProactiveCount = useCallback(async () => {
    try {
      let openCount = 0;
      if (window.autobot?.proactiveState) {
        const st = await window.autobot.proactiveState();
        if (st && Array.isArray(st.matters)) openCount += st.matters.filter((m) => m.status === 'open').length;
      }
      if (window.autobot?.proactiveSuggest) {
        const sug = await window.autobot.proactiveSuggest({ convs });
        if (Array.isArray(sug)) openCount += sug.length;
      }
      setProactiveBadge(openCount);
    } catch (_) {}
  }, [convs]);

  const loadPickerCatalogs = useCallback(async () => {
    try {
      if (window.autobot?.providerStatus) {
        const st = await window.autobot.providerStatus();
        if (st && Array.isArray(st.providers)) setOauthProviders(st.providers);
      }
    } catch (_) {}
    try {
      if (window.autobot?.ollamaModels) {
        const ol = await window.autobot.ollamaModels('http://127.0.0.1:11434/v1');
        if (ol && ol.ok && Array.isArray(ol.models)) setOllamaModelsList(ol.models);
      }
    } catch (_) {}
    try {
      if (window.autobot?.envGetState) {
        const es = await window.autobot.envGetState();
        if (es && es.active) setEnvList(es);
      }
    } catch (_) {}
    try {
      if (window.autobot?.mcpStatus) {
        const ms = await window.autobot.mcpStatus();
        if (Array.isArray(ms)) setLiveMcpList(ms);
      }
    } catch (_) {}
  }, []);

  useEffect(() => { refresh(); refreshProactiveCount(); }, [refresh, refreshProactiveCount]);
  useEffect(() => {
    if (!window.autobot?.onEvent) return undefined;
    return window.autobot.onEvent((evt) => {
      if (evt && (evt.type === 'scheduled-task' || evt.type === 'scheduled-session')) {
        refresh();
        refreshProactiveCount();
      }
    });
  }, [refresh, refreshProactiveCount]);

  useEffect(() => {
    if (modalOpen) loadPickerCatalogs();
  }, [modalOpen, loadPickerCatalogs]);

  const resetModalForm = useCallback(() => {
    setEditingId(null);
    setName('');
    setDescription('');
    setPrompt('');
    setTaskModel('');
    setModelSearch('');
    setModelPickerOpen(false);
    setTriggers([makeDefaultTrigger('schedule', tzInfo.timeZone)]);
    setTaskCwd(cwd || '');
    setProjectId('');
    setEnvironment({ kind: 'local', label: 'This Computer' });
    setAdvOpen(false);
    setAdvTab('general');
    setUseWorktree(false);
    setMirrorToWorkspace(true);
    setMaxSteps(25);
    setMcpMode('all');
    setSelectedMcpIds([]);
    setPermissionMode('auto');
    setAttentionGate(false);
    setRetryEnabled(true);
    setNotifyMode('all');
    setRespectQuietHours(true);
    setPushAlert(false);
    setErr('');
  }, [cwd, tzInfo.timeZone]);

  const openNewModal = () => {
    resetModalForm();
    setModalOpen(true);
  };

  const openFromTemplate = (tpl) => {
    resetModalForm();
    setName(tpl.name);
    setDescription(tpl.description || '');
    setPrompt(tpl.prompt);
    setTriggers((tpl.triggers || []).map((tr, i) => ({
      ...makeDefaultTrigger(tr.type || 'schedule', tzInfo.timeZone),
      ...tr,
      id: 'trg_' + (i + 1),
      timeZone: tr.timeZone || tzInfo.timeZone,
    })));
    setPermissionMode(tpl.permissionMode || 'auto');
    setAttentionGate(Boolean(tpl.attentionGate));
    setUseWorktree(Boolean(tpl.useWorktree));
    setModalOpen(true);
  };

  const openEditModal = (t) => {
    setEditingId(t.id);
    setName(t.name || '');
    setDescription(t.description || '');
    setPrompt(t.prompt || '');
    setTaskModel(t.model || '');
    setModelSearch('');
    setModelPickerOpen(false);
    const hydratedTrgs = Array.isArray(t.triggers) && t.triggers.length
      ? t.triggers.map((tr, i) => ({
        ...makeDefaultTrigger(tr.type || 'schedule', tr.timeZone || t.timeZone || tzInfo.timeZone),
        ...tr,
        id: tr.id || ('trg_' + (i + 1)),
        debounceSec: tr.debounceMs ? Math.max(1, Math.round(tr.debounceMs / 1000)) : 4,
        fireAtLocal: (tr.fireAt || tr.at) ? toLocalDatetimeValue(tr.fireAt || tr.at) : toLocalDatetimeValue(Date.now() + 3600 * 1000),
      }))
      : [{
        ...makeDefaultTrigger(t.cadence === 'manual' ? 'manual' : 'schedule', t.timeZone || tzInfo.timeZone),
        cadence: t.cadence || 'daily',
        time: t.time || '07:18',
        everyMinutes: t.everyMinutes || 60,
        minute: t.minute != null ? t.minute : 18,
        dayOfWeek: t.dayOfWeek != null ? t.dayOfWeek : 1,
        cron: t.cronExpression || t.cron || '18 7 * * 1-5',
        fireAtLocal: (t.fireAt || t.at) ? toLocalDatetimeValue(t.fireAt || t.at) : toLocalDatetimeValue(Date.now() + 3600 * 1000),
      }];
    setTriggers(hydratedTrgs);
    setTaskCwd(t.cwd || cwd || '');
    setProjectId(t.projectId || '');
    setEnvironment(t.environment && typeof t.environment === 'object' ? t.environment : { kind: 'local', label: 'This Computer' });
    setUseWorktree(Boolean(t.useWorktree));
    setMirrorToWorkspace(t.mirrorToWorkspace !== false);
    setMaxSteps(Number(t.maxSteps) || 25);
    if (t.allowedMcpServers === 'none') {
      setMcpMode('none');
      setSelectedMcpIds([]);
    } else if (Array.isArray(t.allowedMcpServers)) {
      setMcpMode('custom');
      setSelectedMcpIds(t.allowedMcpServers);
    } else {
      setMcpMode('all');
      setSelectedMcpIds([]);
    }
    setPermissionMode(t.permissionMode || 'auto');
    setAttentionGate(Boolean(t.attentionGate));
    setRetryEnabled(t.retryEnabled !== false);
    setNotifyMode(t.notifyMode || (t.notifyOnCompletion === false ? 'never' : 'all'));
    setRespectQuietHours(t.respectQuietHours !== false);
    setPushAlert(Boolean(t.pushAlert));
    setAdvOpen(false);
    setErr('');
    setModalOpen(true);
  };

  const handleCreateWithPrompt = () => {
    setSplitMenuOpen(false);
    if (typeof onCreateWithPrompt === 'function') onCreateWithPrompt();
    else if (typeof onSendToChat === 'function') onSendToChat('/automation');
  };

  const browseCwd = async () => {
    if (!window.autobot?.pickFolder) return;
    const picked = await window.autobot.pickFolder();
    if (picked) setTaskCwd(picked);
  };

  const updateTrigger = (idx, patch) => {
    setTriggers((prev) => prev.map((tr, i) => (i === idx ? { ...tr, ...patch } : tr)));
  };
  const addTrigger = (kind = 'schedule') => {
    setTriggers((prev) => [...prev, makeDefaultTrigger(kind, tzInfo.timeZone)]);
  };
  const removeTrigger = (idx) => {
    setTriggers((prev) => (prev.length > 1 ? prev.filter((_, i) => i !== idx) : prev));
  };

  const submitTask = async () => {
    setErr('');
    if (!name.trim()) { setErr('Task name is required.'); return; }
    if (!prompt.trim()) { setErr('Task instructions are required.'); return; }

    const serializedTriggers = [];
    for (const tr of triggers) {
      if (tr.type === 'manual') {
        serializedTriggers.push({ id: tr.id, type: 'manual' });
      } else if (tr.type === 'watch') {
        if (!taskCwd.trim()) { setErr('A repository / workspace folder is required for a Git / File Watch trigger.'); return; }
        serializedTriggers.push({
          id: tr.id,
          type: 'watch',
          watchGlob: String(tr.watchGlob || '').trim(),
          watchGit: tr.watchGit !== false,
          debounceMs: Math.max(1000, (Number(tr.debounceSec) || 4) * 1000),
        });
      } else {
        const c = tr.cadence || 'daily';
        const outTr = { id: tr.id, type: 'schedule', cadence: c, timeZone: tr.timeZone || tzInfo.timeZone };
        if (c === 'every') outTr.everyMinutes = Math.max(1, Number(tr.everyMinutes) || 60);
        else if (c === 'hourly') outTr.minute = Math.max(0, Math.min(59, Number(tr.minute) || 0));
        else if (c === 'daily' || c === 'weekdays') outTr.time = tr.time || '07:18';
        else if (c === 'weekly') { outTr.dayOfWeek = Number(tr.dayOfWeek) || 0; outTr.time = tr.time || '09:37'; }
        else if (c === 'cron') {
          if (!String(tr.cron || '').trim()) { setErr('Cron expression is required.'); return; }
          outTr.cron = String(tr.cron).trim();
          outTr.cronExpression = outTr.cron;
        } else if (c === 'once') {
          const ts = Date.parse(tr.fireAtLocal);
          if (isNaN(ts)) { setErr('Valid date & time is required for a one-time trigger.'); return; }
          outTr.fireAt = ts;
          outTr.at = ts;
        }
        serializedTriggers.push(outTr);
      }
    }

    const firstSched = serializedTriggers.find((x) => x.type === 'schedule');
    const input = {
      name: name.trim(),
      description: description.trim(),
      prompt: prompt.trim(),
      triggers: serializedTriggers,
      timeZone: tzInfo.timeZone,
      cadence: firstSched ? firstSched.cadence : 'manual',
      ...(firstSched && firstSched.time ? { time: firstSched.time } : {}),
      ...(firstSched && firstSched.dayOfWeek != null ? { dayOfWeek: firstSched.dayOfWeek } : {}),
      ...(firstSched && firstSched.everyMinutes ? { everyMinutes: firstSched.everyMinutes } : {}),
      ...(firstSched && firstSched.minute != null ? { minute: firstSched.minute } : {}),
      ...(firstSched && firstSched.cron ? { cron: firstSched.cron, cronExpression: firstSched.cron } : {}),
      ...(firstSched && firstSched.fireAt ? { fireAt: firstSched.fireAt, at: firstSched.fireAt } : {}),
      cwd: taskCwd.trim(),
      projectId,
      environment,
      allowedMcpServers: mcpMode === 'none' ? 'none' : (mcpMode === 'custom' ? selectedMcpIds : 'all'),
      model: taskModel,
      permissionMode,
      maxSteps: Math.max(1, Math.min(80, Number(maxSteps) || 25)),
      attentionGate,
      retryEnabled,
      useWorktree,
      mirrorToWorkspace,
      durable: serializedTriggers.some((x) => x.type === 'schedule' && x.cadence === 'cron'),
      notifyMode,
      notifyOnCompletion: notifyMode !== 'never',
      respectQuietHours,
      pushAlert,
    };

    setBusy(true);
    const r = editingId
      ? await window.autobot.updateScheduledTask(editingId, input)
      : await window.autobot.createScheduledTask(input);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not save automation.'); return; }
    setModalOpen(false);
    resetModalForm();
    setTab('yours');
    await refresh();
  };

  const toggle = async (t) => {
    await window.autobot.updateScheduledTask(t.id, { enabled: t.enabled === false });
    await refresh();
  };
  const remove = async (id) => {
    await window.autobot.deleteScheduledTask(id);
    await refresh();
  };
  const loadTaskRuns = async (taskId) => {
    if (!taskId || !window.autobot?.listScheduledTaskRuns) return;
    try {
      const r = await window.autobot.listScheduledTaskRuns(taskId, { limit: 25 });
      if (r && r.ok && Array.isArray(r.runs)) {
        setRunsByTask((prev) => ({ ...prev, [taskId]: r.runs }));
      }
    } catch (_) {}
  };
  const runNow = async (id) => {
    setRunningId(id);
    try {
      await window.autobot.runScheduledTask(id);
      setExpandedRunsId(id);
      await loadTaskRuns(id);
      await refresh();
    } finally {
      setRunningId('');
    }
  };

  const filteredTasks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = tasks.filter((t) => {
      if (statusFilter !== 'all' && taskStatusCategory(t) !== statusFilter) return false;
      if (!q) return true;
      const hay = `${t.name || ''} ${t.description || ''} ${t.prompt || ''} ${t.model || ''} ${t.cwd || ''}`.toLowerCase();
      return hay.includes(q);
    });
    return [...list].sort((a, b) => {
      if (sortBy === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
      if (sortBy === 'last') return (b.lastRunAt || 0) - (a.lastRunAt || 0);
      const na = a.nextRunAt || Number.MAX_SAFE_INTEGER;
      const nb = b.nextRunAt || Number.MAX_SAFE_INTEGER;
      return na - nb;
    });
  }, [tasks, searchQuery, statusFilter, sortBy]);

  // Model choices for embedded modal picker
  const modelChoices = useMemo(() => {
    const activeLabel = (provider && (provider.routingMode === 'auto' ? 'Auto · DeepSeek V4.1' : provider.model)) || 'Configured Default';
    const items = [
      { id: '', label: `Default · ${activeLabel}`, group: 'Recommended', logo: provider?.routingMode === 'auto' ? 'deepseek' : (provider?.model || 'spark'), sub: 'Follows active session' },
      { id: 'auto', label: 'Auto · DeepSeek V4.1 Flash', group: 'Recommended', logo: 'deepseek', sub: 'Complexity auto-switch' },
      { id: 'orchestrator', label: 'Orchestrator (Role Pool)', group: 'Recommended', logo: 'orchestrator', sub: 'Multi-model supervisor' },
    ];
    for (const pv of oauthProviders) {
      const accts = (pv && pv.accounts) || [];
      const liveModels = (pv && pv.models) || [];
      for (const a of accts) {
        if (!a || a.expired) continue;
        for (const m of liveModels.slice(0, 12)) {
          const mid = typeof m === 'string' ? m : (m && m.id);
          if (!mid) continue;
          items.push({
            id: `account:${pv.id}:${a.account}::${mid}`,
            label: mid,
            group: pv.label || pv.id,
            logo: mid,
            sub: a.label || a.account,
          });
        }
      }
    }
    for (const m of ollamaModelsList) {
      const mid = typeof m === 'string' ? m : (m && (m.id || m.name));
      if (!mid) continue;
      items.push({ id: mid, label: mid, group: 'Local Ollama', logo: 'ollama', sub: '127.0.0.1:11434' });
    }
    const q = modelSearch.trim().toLowerCase();
    return q ? items.filter((it) => it.label.toLowerCase().includes(q) || it.group.toLowerCase().includes(q)) : items;
  }, [provider, oauthProviders, ollamaModelsList, modelSearch]);

  const selectedModelMeta = useMemo(() => {
    const hit = modelChoices.find((c) => c.id === taskModel);
    if (hit) return hit;
    if (taskModel) return { id: taskModel, label: taskModel.split('::').pop(), logo: taskModel };
    return modelChoices[0];
  }, [modelChoices, taskModel]);

  const connectorOptions = useMemo(() => {
    const map = new Map();
    map.set('rea', { id: 'rea', name: 'REA (Reverse Engineer Anything)', connected: liveMcpList.some((s) => s.serverId === 'rea' || s.name === 'rea') });
    map.set('gdrive', { id: 'gdrive', name: 'Google Drive', connected: true });
    for (const s of liveMcpList) {
      if (!s || !s.serverId) continue;
      map.set(s.serverId, { id: s.serverId, name: s.name || s.serverId, connected: true, toolsCount: Array.isArray(s.tools) ? s.tools.length : 0 });
    }
    return [...map.values()];
  }, [liveMcpList]);

  const environmentChoices = useMemo(() => {
    const es = envList || envState || {};
    const list = [{ key: 'local', label: 'This Computer', env: { kind: 'local', label: 'This Computer' } }];
    for (const h of [...(es.sshProfiles || []), ...(es.sshConfigHosts || [])]) {
      list.push({ key: 'ssh:' + (h.id || h.host), label: `SSH · ${h.name || h.host}`, env: { kind: 'ssh', id: h.id || h.host, host: h.host, label: h.name || h.host } });
    }
    for (const r of (es.remoteProfiles || [])) {
      list.push({ key: 'remote:' + r.id, label: `Remote · ${r.name || r.url}`, env: { kind: 'remote', id: r.id, url: r.url, label: r.name || r.url } });
    }
    return list;
  }, [envList, envState]);

  const renderTemplatesGrid = () => (
    <div className="auto-tpl-grid" data-testid="automations-templates-grid">
      {STARTER_TEMPLATES.map((tpl) => (
        <button key={tpl.id} type="button" className="auto-tpl-card" onClick={() => openFromTemplate(tpl)}>
          <div className="auto-tpl-head">
            <span className="auto-tpl-icon"><Icon name={tpl.icon || 'Clock'} size={15} /></span>
            <div className="auto-tpl-title-wrap">
              <strong className="auto-tpl-title">{tpl.name}</strong>
              <span className="auto-tpl-cadence">{tpl.scheduleLabel}</span>
            </div>
            <span className="auto-tpl-plus"><Icon name="Plus" size={14} /></span>
          </div>
          <p className="auto-tpl-desc">{tpl.description}</p>
        </button>
      ))}
    </div>
  );

  return (
    <div className="panel auto-hub" data-testid="automations-hub">
      <div className="auto-hub-header">
        <div>
          <h2 className="auto-hub-title">Automations</h2>
          <p className="auto-hub-sub">
            Schedule recurring prompts, Git/file watchers, and proactive routines · {tzInfo.display}
          </p>
        </div>
        <div className="auto-hub-cta">
          <button
            type="button"
            className="auto-btn-prompt"
            data-testid="automations-create-with-prompt"
            onClick={handleCreateWithPrompt}
          >
            <Icon name="Sparkles" size={14} /> Create with Prompt
          </button>
          <div className="auto-split-wrap" ref={splitMenuRef}>
            <button
              type="button"
              className="auto-btn-new"
              data-testid="automations-new-task-btn"
              onClick={openNewModal}
            >
              <Icon name="Plus" size={14} /> New task
            </button>
            <button
              type="button"
              className="auto-btn-new-caret"
              aria-label="More new task options"
              onClick={() => setSplitMenuOpen((v) => !v)}
            >
              <Icon name="CaretDown" size={12} />
            </button>
            {splitMenuOpen && (
              <div className="auto-split-menu">
                <button type="button" onClick={() => { setSplitMenuOpen(false); openNewModal(); }}>
                  <Icon name="Sliders" size={13} /> Set up manually
                </button>
                <button type="button" onClick={handleCreateWithPrompt}>
                  <Icon name="Sparkles" size={13} /> Create with Prompt (/automation)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="auto-toolbar">
        <div className="auto-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'yours'} className={'auto-tab' + (tab === 'yours' ? ' on' : '')} onClick={() => setTab('yours')}>
            Yours <span className="auto-tab-count">{tasks.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'templates'} className={'auto-tab' + (tab === 'templates' ? ' on' : '')} onClick={() => setTab('templates')}>
            Templates <span className="auto-tab-count">{STARTER_TEMPLATES.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'proactive'} className={'auto-tab' + (tab === 'proactive' ? ' on' : '')} onClick={() => setTab('proactive')}>
            Proactive {proactiveBadge > 0 && <span className="auto-tab-badge">{proactiveBadge}</span>}
          </button>
        </div>

        {tab === 'yours' && (
          <div className="auto-filters">
            <div className="auto-search-box">
              <Icon name="Search" size={13} />
              <input
                type="search"
                placeholder="Search automations…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>
            <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option value="all">Status: All</option>
              <option value="active">Active</option>
              <option value="paused">Paused</option>
              <option value="failed">Failed</option>
            </select>
            <select aria-label="Sort automations" value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="next">Sort: Next run</option>
              <option value="last">Sort: Last run</option>
              <option value="name">Sort: Name</option>
            </select>
          </div>
        )}
      </div>

      {tab === 'yours' && tasks.length === 0 && !searchQuery.trim() && statusFilter === 'all' && (
        <div className="auto-empty-wrap" data-testid="automations-empty-state">
          <div className="auto-empty-hero">
            <div className="auto-empty-stopwatch"><Icon name="Clock" size={28} /></div>
            <h3>No automations yet</h3>
            <p className="muted">
              Run a prompt on a schedule, like a morning summary of yesterday’s changes. Runs show up here.
            </p>
            <div className="auto-empty-actions">
              <button type="button" className="btn-mini primary" onClick={openNewModal}>Set up manually</button>
              <button type="button" className="btn-mini" onClick={handleCreateWithPrompt}>
                <Icon name="Sparkles" size={12} /> Create with Prompt
              </button>
            </div>
          </div>
          <div className="auto-shelf-head">Starter templates</div>
          {renderTemplatesGrid()}
        </div>
      )}

      {tab === 'yours' && (tasks.length > 0 || searchQuery.trim() || statusFilter !== 'all') && (
        <div className="auto-task-list">
          {filteredTasks.length === 0 ? (
            <div className="muted" style={{ padding: '20px 4px' }}>No automations match the current search/filter.</div>
          ) : (
            filteredTasks.map((t) => {
              const runs = runsByTask[t.id] || (Array.isArray(t.runs) ? t.runs : []);
              const isRunsOpen = expandedRunsId === t.id;
              const statusCat = taskStatusCategory(t);
              const isRunning = runningId === t.id;
              const hasWatch = Array.isArray(t.triggers) && t.triggers.some((x) => x && x.type === 'watch');
              return (
                <div key={t.id} className={'auto-task-card' + (t.enabled === false ? ' off' : '')}>
                  <div className="auto-task-head">
                    <span className={'auto-status-dot ' + (isRunning ? 'running' : statusCat)} title={isRunning ? 'Running' : statusCat} />
                    <div className="auto-task-main">
                      <div className="auto-task-title-row">
                        <b>{t.name}</b>
                        <span className="sched-pill">{t.schedule}</span>
                        {t.timeZone && <span className="sched-pill">{t.timeZone}</span>}
                        {hasWatch && <span className="sched-pill ok">Watch</span>}
                        {t.model && (
                          <span className="sched-pill auto-model-chip">
                            <ModelLogo model={t.model} size={11} />
                            <span>{t.model.split('::').pop()}</span>
                          </span>
                        )}
                        {t.environment && t.environment.kind && t.environment.kind !== 'local' && (
                          <span className="sched-pill">{t.environment.label || t.environment.kind}</span>
                        )}
                        {t.useWorktree && <span className="sched-pill">Worktree</span>}
                        {t.attentionGate && <span className="sched-pill ok">Attention Gate</span>}
                      </div>
                      {t.description && <div className="auto-task-desc">{t.description}</div>}
                      <div className="auto-task-meta muted">
                        <span>{t.nextRunAt ? 'Next: ' + new Date(t.nextRunAt).toLocaleString() : (t.enabled === false ? 'Paused' : 'On trigger')}</span>
                        {t.lastRunAt && <span> · Last: {new Date(t.lastRunAt).toLocaleString()}</span>}
                        {t.runCount ? <span> · {t.runCount} run{t.runCount === 1 ? '' : 's'}</span> : null}
                        {t.cwd && <span> · {t.cwd}</span>}
                      </div>
                      {t.waiting && <div className="sched-waiting">{t.waiting}</div>}
                      {t.lastResult && (
                        <div className={'sched-last' + (t.lastResult.ok ? '' : ' err')}>
                          {t.lastResult.ok ? String(t.lastResult.output || '').slice(0, 220) : 'Error: ' + t.lastResult.error}
                        </div>
                      )}
                    </div>
                    <div className="auto-task-actions">
                      <button type="button" className="btn-mini primary" disabled={isRunning} onClick={() => runNow(t.id)}>
                        <Icon name="Play" size={11} /> {isRunning ? 'Running…' : 'Run now'}
                      </button>
                      <button className={'switch' + (t.enabled !== false ? ' on' : '')} role="switch" aria-checked={t.enabled !== false} onClick={() => toggle(t)} title="Enable or pause automation"><span className="knob" /></button>
                      <button type="button" className="btn-mini" onClick={() => openEditModal(t)}>Edit</button>
                      <button type="button" className="btn-mini" onClick={() => {
                        const nextOpen = isRunsOpen ? null : t.id;
                        setExpandedRunsId(nextOpen);
                        if (nextOpen) loadTaskRuns(t.id);
                      }}>Runs ({runs.length})</button>
                      <button type="button" className="icon-btn" title="Delete automation" onClick={() => remove(t.id)}><Icon name="Trash" size={13} /></button>
                    </div>
                  </div>

                  {isRunsOpen && (
                    <div className="sched-runs-drawer">
                      {runs.length === 0 ? (
                        <div className="muted" style={{ fontSize: 11.5 }}>No runs recorded yet. Click <b>Run now</b> to execute and log a session.</div>
                      ) : (
                        runs.slice(0, 25).map((r) => (
                          <div key={r.runId} className="sched-run-row">
                            <span className={'badge ' + (r.status === 'succeeded' ? 'ok' : (r.status === 'failed' ? 'warn' : ''))}>{r.status}</span>
                            <span className="sched-pill">{r.trigger}</span>
                            {r.model && <span className="sched-pill">{r.model}</span>}
                            <span className="muted">{new Date(r.startedAt).toLocaleString()} ({Math.round((r.durationMs || 0) / 100) / 10}s)</span>
                            <span className="sched-run-out">{r.error ? 'ERROR: ' + r.error : String(r.output || '').slice(0, 220)}</span>
                            {r.convId && onOpenRunSession ? (
                              <button type="button" className="btn-mini primary" data-testid="open-run-session-btn" onClick={() => onOpenRunSession(r.convId)}>
                                Open Run →
                              </button>
                            ) : (onSendToChat && r.output ? (
                              <button type="button" className="btn-mini" onClick={() => onSendToChat(`Follow up on automation "${t.name}":\n\n${r.output}`)}>
                                Open in Chat
                              </button>
                            ) : null)}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}

      {tab === 'templates' && (
        <div className="auto-templates-tab">
          {renderTemplatesGrid()}
        </div>
      )}

      {tab === 'proactive' && (
        <ProactiveDashboard cwd={cwd} convs={convs} onScheduledCreated={() => { refresh(); refreshProactiveCount(); setTab('yours'); }} onSendToChat={onSendToChat} Icon={Icon} />
      )}

      {modalOpen && (
        <div className="auto-modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="auto-modal" data-testid="scheduled-task-modal" onClick={(e) => e.stopPropagation()}>
            <div className="auto-modal-head">
              <div>
                <h3>{editingId ? 'Edit automation' : 'New scheduled task'}</h3>
                <span className="muted" style={{ fontSize: 11.5 }}>Persisted as SKILL.md · Multi-trigger · Full MCP &amp; Model routing</span>
              </div>
              <button type="button" className="icon-btn" onClick={() => setModalOpen(false)}><Icon name="X" size={16} /></button>
            </div>

            <div className="auto-modal-body">
              <div className="auto-form-grid-2">
                <label className="auto-field">
                  <span>Name <em className="auto-req">● Required</em></span>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning Briefing" />
                </label>
                <label className="auto-field">
                  <span>Description</span>
                  <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional one-line summary" />
                </label>
              </div>

              <div className="auto-field">
                <span>Instructions <em className="auto-req">● Required</em></span>
                <div className="auto-prompt-box">
                  <textarea
                    rows={4}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder="Write self-contained instructions for the agent to run cleanly each time…"
                  />
                  <div className="auto-prompt-model-wrap" ref={modelPickerRef}>
                    <button
                      type="button"
                      className="auto-prompt-model-btn"
                      data-testid="task-modal-model-btn"
                      onClick={() => setModelPickerOpen((v) => !v)}
                    >
                      <ModelLogo model={selectedModelMeta.logo} size={13} />
                      <span>{selectedModelMeta.label}</span>
                      <Icon name="CaretDown" size={11} />
                    </button>
                    {modelPickerOpen && (
                      <div className="auto-prompt-model-menu" data-testid="task-modal-model-menu">
                        <input
                          type="search"
                          className="auto-model-search"
                          placeholder="Filter models…"
                          value={modelSearch}
                          onChange={(e) => setModelSearch(e.target.value)}
                          autoFocus
                        />
                        <div className="auto-model-list">
                          {modelChoices.map((ch) => (
                            <button
                              key={ch.id || 'default'}
                              type="button"
                              className={'model-opt' + (taskModel === ch.id ? ' on' : '')}
                              onClick={() => { setTaskModel(ch.id); setModelPickerOpen(false); }}
                            >
                              <ModelLogo model={ch.logo} size={14} />
                              <span className="model-opt-name">{ch.label}</span>
                              <span className="model-opt-prov">{ch.sub || ch.group}</span>
                              {taskModel === ch.id && <Icon name="Check" size={12} className="model-check" />}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="auto-field">
                <div className="auto-triggers-head">
                  <span>Triggers</span>
                  <div className="auto-triggers-add">
                    <button type="button" className="btn-mini" onClick={() => addTrigger('schedule')}>+ Schedule</button>
                    <button type="button" className="btn-mini" onClick={() => addTrigger('watch')}>+ Git / File Watch</button>
                    <button type="button" className="btn-mini" onClick={() => addTrigger('manual')}>+ Manual</button>
                  </div>
                </div>
                <div className="auto-triggers-list">
                  {triggers.map((tr, idx) => (
                    <div key={tr.id || idx} className="auto-trigger-row">
                      <select
                        value={tr.type}
                        onChange={(e) => updateTrigger(idx, makeDefaultTrigger(e.target.value, tzInfo.timeZone))}
                      >
                        <option value="schedule">Schedule</option>
                        <option value="watch">Git / File Watch</option>
                        <option value="manual">Manual Only (Routine)</option>
                      </select>

                      {tr.type === 'schedule' && (
                        <>
                          <select value={tr.cadence || 'daily'} onChange={(e) => updateTrigger(idx, { cadence: e.target.value })}>
                            {CADENCES.filter((c) => c.id !== 'manual').map((c) => (
                              <option key={c.id} value={c.id}>{c.label}</option>
                            ))}
                          </select>
                          {(tr.cadence === 'daily' || tr.cadence === 'weekdays' || tr.cadence === 'weekly') && (
                            <input type="time" value={tr.time || '07:18'} onChange={(e) => updateTrigger(idx, { time: e.target.value })} />
                          )}
                          {tr.cadence === 'weekly' && (
                            <select value={tr.dayOfWeek != null ? tr.dayOfWeek : 1} onChange={(e) => updateTrigger(idx, { dayOfWeek: Number(e.target.value) })}>
                              {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d, i) => <option key={d} value={i}>{d}</option>)}
                            </select>
                          )}
                          {tr.cadence === 'hourly' && (
                            <input type="number" min={0} max={59} value={tr.minute != null ? tr.minute : 18} onChange={(e) => updateTrigger(idx, { minute: e.target.value })} title="At minute (:mm)" />
                          )}
                          {tr.cadence === 'every' && (
                            <input type="number" min={1} value={tr.everyMinutes || 60} onChange={(e) => updateTrigger(idx, { everyMinutes: e.target.value })} title="Every N minutes" />
                          )}
                          {tr.cadence === 'once' && (
                            <input type="datetime-local" value={tr.fireAtLocal || ''} onChange={(e) => updateTrigger(idx, { fireAtLocal: e.target.value })} />
                          )}
                          {tr.cadence === 'cron' && (
                            <input value={tr.cron || ''} onChange={(e) => updateTrigger(idx, { cron: e.target.value })} placeholder="18 7 * * 1-5" />
                          )}
                          <span className="auto-tz-pill" title="Detected local IANA timezone">{tr.timeZone || tzInfo.timeZone}</span>
                        </>
                      )}

                      {tr.type === 'watch' && (
                        <>
                          <input
                            style={{ flex: 1 }}
                            value={tr.watchGlob || ''}
                            onChange={(e) => updateTrigger(idx, { watchGlob: e.target.value })}
                            placeholder="Filter extensions/paths (optional, e.g. src/, .js)"
                          />
                          <label className="sched-check">
                            <input type="checkbox" checked={tr.watchGit !== false} onChange={(e) => updateTrigger(idx, { watchGit: e.target.checked })} />
                            <span>Git HEAD</span>
                          </label>
                        </>
                      )}

                      {tr.type === 'manual' && (
                        <span className="muted" style={{ fontSize: 12 }}>Runs only when triggered manually or by another workflow.</span>
                      )}

                      {triggers.length > 1 && (
                        <button type="button" className="icon-btn" title="Remove trigger" onClick={() => removeTrigger(idx)}><Icon name="X" size={13} /></button>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              <div className="auto-form-grid-2">
                <div className="auto-field">
                  <span>Repository / Project</span>
                  <div className="sched-cwd-wrap">
                    <select
                      value={taskCwd}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val === '__browse__') { browseCwd(); return; }
                        setTaskCwd(val);
                      }}
                    >
                      {cwd && <option value={cwd}>Current Workspace ({cwd.split(/[\\/]/).pop() || cwd})</option>}
                      {projects.map((p) => (p.cwd ? <option key={p.id || p.cwd} value={p.cwd}>{p.name || p.cwd}</option> : null))}
                      <option value="">None (Scratch workspace)</option>
                      <option value="__browse__">Browse folder…</option>
                    </select>
                    <button type="button" className="btn-mini" onClick={browseCwd}>Browse…</button>
                  </div>
                </div>
                <label className="auto-field">
                  <span>Execution Environment</span>
                  <select
                    value={environment.kind === 'local' ? 'local' : `${environment.kind}:${environment.id || environment.host || ''}`}
                    onChange={(e) => {
                      const hit = environmentChoices.find((c) => c.key === e.target.value);
                      setEnvironment(hit ? hit.env : { kind: 'local', label: 'This Computer' });
                    }}
                  >
                    {environmentChoices.map((ch) => (
                      <option key={ch.key} value={ch.key}>{ch.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="auto-adv-box">
                <button type="button" className="auto-adv-toggle" onClick={() => setAdvOpen((v) => !v)}>
                  <span>Advanced settings</span>
                  <Icon name={advOpen ? 'CaretUp' : 'CaretDown'} size={13} />
                </button>
                {advOpen && (
                  <div className="auto-adv-body">
                    <div className="auto-adv-tabs">
                      {['general', 'connectors', 'behavior', 'notifications'].map((tId) => (
                        <button key={tId} type="button" className={'auto-adv-tab' + (advTab === tId ? ' on' : '')} onClick={() => setAdvTab(tId)}>
                          {tId.charAt(0).toUpperCase() + tId.slice(1)}
                        </button>
                      ))}
                    </div>

                    {advTab === 'general' && (
                      <div className="auto-adv-pane">
                        <label className="sched-check"><input type="checkbox" checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)} /><span>Isolate runs in a Git Worktree</span></label>
                        <label className="sched-check"><input type="checkbox" checked={mirrorToWorkspace} onChange={(e) => setMirrorToWorkspace(e.target.checked)} /><span>Mirror durable schedules to <code>.claude/scheduled_tasks.json</code></span></label>
                        <label className="auto-field" style={{ maxWidth: 180 }}>
                          <span>Max agent steps</span>
                          <input type="number" min={1} max={80} value={maxSteps} onChange={(e) => setMaxSteps(e.target.value)} />
                        </label>
                      </div>
                    )}

                    {advTab === 'connectors' && (
                      <div className="auto-adv-pane">
                        <div className="auto-radio-row">
                          <label className="sched-check"><input type="radio" checked={mcpMode === 'all'} onChange={() => setMcpMode('all')} /><span>All connected MCP servers</span></label>
                          <label className="sched-check"><input type="radio" checked={mcpMode === 'none'} onChange={() => setMcpMode('none')} /><span>None (Built-in tools only)</span></label>
                          <label className="sched-check"><input type="radio" checked={mcpMode === 'custom'} onChange={() => setMcpMode('custom')} /><span>Select specific connectors</span></label>
                        </div>
                        {mcpMode === 'custom' && (
                          <div className="auto-mcp-checks">
                            {connectorOptions.map((c) => (
                              <label key={c.id} className="sched-check">
                                <input
                                  type="checkbox"
                                  checked={selectedMcpIds.includes(c.id)}
                                  onChange={(e) => {
                                    setSelectedMcpIds((prev) => (e.target.checked ? [...new Set([...prev, c.id])] : prev.filter((x) => x !== c.id)));
                                  }}
                                />
                                <span>{c.name}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    )}

                    {advTab === 'behavior' && (
                      <div className="auto-adv-pane">
                        <label className="auto-field" style={{ maxWidth: 260 }}>
                          <span>Permission mode</span>
                          <select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)}>
                            <option value="auto">Auto approve safe tools</option>
                            <option value="default">Ask before risky tools</option>
                            <option value="plan">Plan only (read-only)</option>
                          </select>
                        </label>
                        <label className="sched-check"><input type="checkbox" checked={attentionGate} onChange={(e) => setAttentionGate(e.target.checked)} /><span>Stage-1 Attention Gate (skip run if nothing needs review)</span></label>
                        <label className="sched-check"><input type="checkbox" checked={retryEnabled} onChange={(e) => setRetryEnabled(e.target.checked)} /><span>Retry on transient failure (1m → 5m → 15m backoff)</span></label>
                      </div>
                    )}

                    {advTab === 'notifications' && (
                      <div className="auto-adv-pane">
                        <label className="auto-field" style={{ maxWidth: 260 }}>
                          <span>Notify on completion</span>
                          <select value={notifyMode} onChange={(e) => setNotifyMode(e.target.value)}>
                            <option value="all">On completion &amp; failure</option>
                            <option value="failure">On failure only</option>
                            <option value="never">Never</option>
                          </select>
                        </label>
                        <label className="sched-check"><input type="checkbox" checked={respectQuietHours} onChange={(e) => setRespectQuietHours(e.target.checked)} /><span>Respect Quiet Hours (hold non-error alerts)</span></label>
                        <label className="sched-check"><input type="checkbox" checked={pushAlert} onChange={(e) => setPushAlert(e.target.checked)} /><span>Send mobile push relay alert</span></label>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {err && <p className="form-error">{err}</p>}
            </div>

            <div className="auto-modal-foot">
              <button type="button" className="btn-mini" onClick={() => setModalOpen(false)}>Cancel</button>
              <button type="button" className="primary" disabled={busy} onClick={submitTask}>
                {busy ? 'Saving…' : (editingId ? 'Save Changes' : 'Create Automation')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
