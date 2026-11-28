import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { GitPanel } from './GitPanel';
import { AgentChangesPanel } from './AgentChangesPanel';
import { MonacoPane, extractSymbolsFromText } from './MonacoPane';
import { NotebookPane } from './NotebookPane';
import { DebugPanel } from './DebugPanel';
import { registerLspBridgeProviders } from './monacoSetup';
import { TerminalPanel } from './TerminalPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { QuickOpenModal } from './QuickOpenModal';
import { IdeStatusBar } from './IdeStatusBar';
import { MindMapView } from './MindMapView';
import { shortcutLabels } from './shortcuts';
import './ide.css';

function relPathOf(cwd, filePath) {
  if (!cwd || !filePath) return String(filePath || '');
  const a = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const b = String(filePath).replace(/\\/g, '/');
  if (b.startsWith(a + '/')) return b.slice(a.length + 1);
  return b.split('/').pop() || b;
}

export function IdeWorkbench({
  cwd,
  setCwd,
  theme = 'dark',
  typography = null,
  provider,
  orchestrator,
  envState,
  contextPct = null,
  setError,
  setNotice,
  onAttachToChat,
  onSendToAgent,
  onOpenSettings,
  onOpenEnvironments,
  onOpenRuntimes,
  onSwitchToAgent,
  renderAgentDock,
  externalOpenFile = null, // { path, diff, at } when Agent Review opens a file in IDE
  Icon,
}) {
  const [leftTab, setLeftTab] = useState('explorer'); // 'explorer' | 'search' | 'git' | 'changes' | null
  const [leftW, setLeftW] = useState(244);
  const [bottomTab, setBottomTab] = useState('terminal'); // 'terminal' | 'problems' | 'output' | null
  const [bottomH, setBottomH] = useState(210);
  const [rightOpen, setRightOpen] = useState(true);
  const [rightW, setRightW] = useState(390);

  const [treeNodes, setTreeNodes] = useState([]);
  const [gitStatus, setGitStatus] = useState(null);
  const [tabs, setTabs] = useState([]); // { path, name, relPath, language, content, savedContent, dirty, pinned }
  const [activeTabPath, setActiveTabPath] = useState(null);
  const [splitTabPath, setSplitTabPath] = useState(null);
  const [diffState, setDiffState] = useState(null); // { path, original, title }
  const [pendingReveal, setPendingReveal] = useState(null);

  const [quickOpen, setQuickOpen] = useState(null); // { mode: 'files'|'symbols'|'commands', initialQuery, symbols }
  const [ghostEnabled, setGhostEnabled] = useState(false);
  const [showMindMap, setShowMindMap] = useState(false);

  const [monacoMarkers, setMonacoMarkers] = useState([]);
  const [lspMarkers, setLspMarkers] = useState([]);
  const [lspInfo, setLspInfo] = useState({});
  const [outputLogs, setOutputLogs] = useState([]);
  const [breakpoints, setBreakpoints] = useState([]); // [{ file, line }]
  const [watchExpressions, setWatchExpressions] = useState([]);
  const [debugState, setDebugState] = useState({
    active: false,
    paused: false,
    sessionId: null,
    adapter: null,
    filePath: '',
    pausedLine: null,
    callStack: [],
    locals: [],
    watches: [],
    logs: [],
  });

  const [cursorCtx, setCursorCtx] = useState(null);
  const [ctxFlags, setCtxFlags] = useState({ file: true, selection: true, problems: false });
  const [viewStates, setViewStates] = useState({});
  const [initialTermBuffer, setInitialTermBuffer] = useState('');
  const [layoutLoadedCwd, setLayoutLoadedCwd] = useState(null);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const termSerializedRef = useRef('');
  const layoutSaveTimerRef = useRef(null);
  const sc = shortcutLabels();

  const logOutput = useCallback((line) => {
    setOutputLogs((prev) => [...prev.slice(-120), `[${new Date().toLocaleTimeString()}] ${line}`]);
  }, []);

  const refreshTree = useCallback(async () => {
    if (!cwd || !window.autobot?.ideReadTree) return;
    const res = await window.autobot.ideReadTree({ cwd });
    if (res && res.ok) setTreeNodes(res.nodes || []);
  }, [cwd]);

  const refreshGit = useCallback(async () => {
    if (!cwd || !window.autobot?.ideGitStatus) return;
    const st = await window.autobot.ideGitStatus({ cwd });
    setGitStatus(st);
  }, [cwd]);

  const openFile = useCallback(async (filePath, line = null, col = null, opts = {}) => {
    if (!filePath || !window.autobot?.ideReadFile) return;
    const existing = tabsRef.current.find((t) => t.path === filePath);
    if (existing) {
      if (!opts.silent) setActiveTabPath(filePath);
      setDiffState(null);
      if (line) setPendingReveal({ path: filePath, line, col: col || 1, at: Date.now() });
      return;
    }
    const r = await window.autobot.ideReadFile({ path: filePath });
    if (!r || !r.ok) {
      if (!opts.silent) setError && setError('❌ ' + (r?.error || 'Could not open file'));
      return;
    }
    if (r.binary) {
      if (!opts.silent) setNotice && setNotice(`Binary file (${r.size} bytes) cannot be edited in text mode.`);
      return;
    }
    if (r.tooLarge) {
      if (!opts.silent) setNotice && setNotice(`File too large (${(Number(r.size || 0) / (1024 * 1024)).toFixed(1)} MB > 2 MB limit) — cannot load into editor.`);
      return;
    }
    const name = filePath.split(/[\\/]/).pop() || filePath;
    const tab = {
      path: r.path,
      name,
      relPath: relPathOf(cwd, r.path),
      language: r.language || 'plaintext',
      content: r.content || '',
      savedContent: r.content || '',
      dirty: false,
      pinned: !!opts.pinned,
    };
    setTabs((prev) => (prev.some((t) => t.path === r.path) ? prev : [...prev, tab]));
    if (!opts.silent) setActiveTabPath(r.path);
    setDiffState(null);
    if (line) setPendingReveal({ path: r.path, line, col: col || 1, at: Date.now() });
    window.autobot?.ideLspNotify?.({
      cwd,
      language: tab.language,
      method: 'textDocument/didOpen',
      params: { file: tab.path, textDocument: { languageId: tab.language, version: 1, text: tab.content } },
    }).catch(() => {});
  }, [cwd, setError, setNotice]);

  // Workspace bootstrap + layout restoration
  useEffect(() => {
    if (!cwd) return undefined;
    let cancelled = false;
    setLayoutLoadedCwd(null);
    setTabs([]);
    setActiveTabPath(null);
    setSplitTabPath(null);
    setDiffState(null);
    setLspMarkers([]);
    setMonacoMarkers([]);
    setCursorCtx(null);
    setInitialTermBuffer('');
    termSerializedRef.current = '';
    refreshTree();
    refreshGit();
    const disposeLspBridge = registerLspBridgeProviders(() => ({
      cwd,
      onOpenLocation: (fp, ln, col) => openFile(fp, ln, col),
    }));
    window.autobot?.ideLspStatus?.({ cwd }).then((st) => !cancelled && st && setLspInfo(st)).catch(() => {});
    window.autobot?.ideWatchWorkspace?.({ cwd }).catch(() => {});

    (async () => {
      try {
        if (!window.autobot?.ideLoadLayout) {
          if (!cancelled) setLayoutLoadedCwd(cwd);
          return;
        }
        const res = await window.autobot.ideLoadLayout({ cwd });
        const ly = res && res.layout;
        if (!cancelled && ly) {
          if (ly.leftTab !== undefined) setLeftTab(ly.leftTab);
          if (typeof ly.leftW === 'number') setLeftW(ly.leftW);
          if (ly.bottomTab !== undefined) setBottomTab(ly.bottomTab);
          if (typeof ly.bottomH === 'number') setBottomH(ly.bottomH);
          if (typeof ly.rightOpen === 'boolean') setRightOpen(ly.rightOpen);
          if (typeof ly.rightW === 'number') setRightW(ly.rightW);
          if (typeof ly.ghostEnabled === 'boolean') setGhostEnabled(ly.ghostEnabled);
          if (ly.viewStates) setViewStates(ly.viewStates);
          if (typeof ly.terminalSerialized === 'string') {
            setInitialTermBuffer(ly.terminalSerialized);
            termSerializedRef.current = ly.terminalSerialized;
          }
          if (Array.isArray(ly.openTabs) && ly.openTabs.length) {
            for (const ot of ly.openTabs) {
              if (cancelled) break;
              await openFile(ot.path, null, null, { silent: true, pinned: !!ot.pinned });
            }
            if (!cancelled && ly.activeTabPath) setActiveTabPath(ly.activeTabPath);
            if (!cancelled && ly.splitTabPath) setSplitTabPath(ly.splitTabPath);
          }
        }
      } catch (_) {}
      if (!cancelled) setLayoutLoadedCwd(cwd);
    })();

    return () => {
      cancelled = true;
      try { disposeLspBridge && disposeLspBridge(); } catch (_) {}
      window.autobot?.ideUnwatchWorkspace?.({ cwd }).catch(() => {});
    };
  }, [cwd, refreshTree, refreshGit]);

  const scheduleLayoutSave = useCallback(() => {
    if (!cwd || layoutLoadedCwd !== cwd || !window.autobot?.ideSaveLayout) return;
    if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    layoutSaveTimerRef.current = setTimeout(() => {
      layoutSaveTimerRef.current = null;
      const payload = {
        openTabs: tabsRef.current.map((t) => ({ path: t.path, pinned: !!t.pinned })),
        activeTabPath,
        splitTabPath,
        viewStates,
        leftTab,
        leftW,
        bottomTab,
        bottomH,
        rightOpen,
        rightW,
        ghostEnabled,
        terminalSerialized: termSerializedRef.current || '',
      };
      window.autobot.ideSaveLayout({ cwd, layout: payload }).catch(() => {});
    }, 450);
  }, [cwd, layoutLoadedCwd, activeTabPath, splitTabPath, viewStates, leftTab, leftW, bottomTab, bottomH, rightOpen, rightW, ghostEnabled]);

  useEffect(() => {
    scheduleLayoutSave();
    return () => {
      if (layoutSaveTimerRef.current) clearTimeout(layoutSaveTimerRef.current);
    };
  }, [tabs, activeTabPath, splitTabPath, viewStates, leftTab, leftW, bottomTab, bottomH, rightOpen, rightW, ghostEnabled, scheduleLayoutSave]);

  const openDiffForFile = useCallback(async (filePath, relPath) => {
    await openFile(filePath);
    if (!cwd || !window.autobot?.ideGitFileAtHead) return;
    const head = await window.autobot.ideGitFileAtHead({ cwd, path: filePath });
    setDiffState({
      path: filePath,
      original: (head && head.content) || '',
      title: `HEAD ↔ ${relPath || relPathOf(cwd, filePath)}`,
    });
  }, [cwd, openFile]);

  useEffect(() => {
    if (!externalOpenFile || !externalOpenFile.path) return;
    if (externalOpenFile.diff) openDiffForFile(externalOpenFile.path);
    else openFile(externalOpenFile.path, externalOpenFile.line || null, 1);
  }, [externalOpenFile, openFile, openDiffForFile]);

  const reloadOpenFile = useCallback(async (filePath) => {
    const r = await window.autobot?.ideReadFile?.({ path: filePath });
    if (r && r.ok && !r.binary) {
      setTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, content: r.content, savedContent: r.content, dirty: false } : t)));
    } else if (r && !r.ok) {
      setTabs((prev) => prev.filter((t) => t.path !== filePath));
    }
  }, []);

  useEffect(() => {
    if (!window.autobot?.onIdeDebugEvent) return undefined;
    return window.autobot.onIdeDebugEvent((evt) => {
      if (!evt) return;
      setDebugState((prev) => {
        const logs = evt.type === 'output' && evt.text
          ? [...(prev.logs || []).slice(-180), String(evt.text)]
          : (prev.logs || []);
        if (evt.type === 'paused') {
          return {
            ...prev,
            active: true,
            paused: true,
            sessionId: evt.sessionId || prev.sessionId,
            adapter: evt.language || evt.adapter || prev.adapter,
            filePath: evt.file || evt.filePath || prev.filePath,
            pausedLine: evt.line || null,
            callStack: evt.frames || evt.callStack || [],
            locals: evt.locals || [],
            watches: evt.watches || [],
            logs,
          };
        }
        if (evt.type === 'continued' || evt.type === 'resumed') {
          return { ...prev, paused: false, pausedLine: null, logs };
        }
        if (evt.type === 'stopped' || evt.type === 'terminated') {
          return { ...prev, active: false, paused: false, sessionId: null, pausedLine: null, logs };
        }
        return { ...prev, logs };
      });
      const pausedFile = evt.file || evt.filePath;
      if (evt.type === 'paused' && pausedFile && evt.line) {
        openFile(pausedFile, evt.line, 1);
      }
    });
  }, [openFile]);

  const toggleBreakpoint = useCallback((file, line) => {
    if (!file || !line) return;
    setBreakpoints((prev) => {
      const exists = prev.some((bp) => bp.file === file && bp.line === line);
      const next = exists ? prev.filter((bp) => !(bp.file === file && bp.line === line)) : [...prev, { file, line }];
      if (debugState.active && debugState.sessionId && window.autobot?.ideDebugCommand) {
        window.autobot.ideDebugCommand({
          sessionId: debugState.sessionId,
          action: 'setBreakpoints',
          breakpoints: next,
        }).catch(() => {});
      }
      return next;
    });
  }, [debugState.active, debugState.sessionId]);

  const startDebugSession = useCallback(async (filePath, argsStr = '') => {
    if (!filePath || !window.autobot?.ideDebugStart) return;
    setBottomTab('debug');
    const args = String(argsStr || '').trim() ? String(argsStr).trim().split(/\s+/) : [];
    const res = await window.autobot.ideDebugStart({
      cwd,
      filePath,
      args,
      breakpoints,
      watchExpressions,
    });
    if (!res || !res.ok) {
      setError && setError('❌ ' + (res?.error || 'Could not start debugger'));
      return;
    }
    setDebugState({
      active: true,
      paused: false,
      sessionId: res.sessionId,
      adapter: res.adapter,
      filePath,
      pausedLine: null,
      callStack: [],
      locals: [],
      watches: [],
      logs: [`Started ${res.adapter} debugger for ${relPathOf(cwd, filePath)}`],
    });
  }, [cwd, breakpoints, watchExpressions, setError]);

  const runDebugCommand = useCallback(async (action) => {
    if (!debugState.sessionId || !window.autobot?.ideDebugCommand) return;
    await window.autobot.ideDebugCommand({
      sessionId: debugState.sessionId,
      action,
      breakpoints,
      watchExpressions,
    });
    if (action === 'stop') {
      setDebugState((prev) => ({ ...prev, active: false, paused: false, sessionId: null, pausedLine: null }));
    }
  }, [debugState.sessionId, breakpoints, watchExpressions]);

  // Auto-reload clean tabs when disk changes (e.g. Agent/Swarm wrote files)
  useEffect(() => {
    if (!window.autobot?.onIdeFsChanged) return undefined;
    return window.autobot.onIdeFsChanged(async (evt) => {
      if (!evt || evt.cwd !== cwd) return;
      refreshTree();
      refreshGit();
      const changed = (evt.events || []).map((e) => e.path);
      for (const tab of tabsRef.current) {
        if (!tab.dirty && changed.includes(tab.path)) {
          const r = await window.autobot.ideReadFile({ path: tab.path });
          if (r && r.ok && !r.binary) {
            setTabs((prev) => prev.map((t) => (t.path === tab.path && !t.dirty
              ? { ...t, content: r.content, savedContent: r.content }
              : t)));
            logOutput(`Reloaded from disk: ${tab.relPath}`);
          }
        }
      }
    });
  }, [cwd, refreshTree, refreshGit, logOutput]);

  useEffect(() => {
    if (!window.autobot?.onIdeLspDiagnostics) return undefined;
    return window.autobot.onIdeLspDiagnostics((evt) => {
      if (!evt || !evt.file) return;
      const mapped = (evt.diagnostics || []).map((d) => ({
        file: evt.file,
        relPath: relPathOf(cwd, evt.file),
        line: ((d.range && d.range.start && d.range.start.line) || 0) + 1,
        col: ((d.range && d.range.start && d.range.start.character) || 0) + 1,
        message: d.message || 'LSP diagnostic',
        severity: d.severity === 1 ? 'error' : 'warning',
      }));
      setLspMarkers((prev) => [...prev.filter((p) => p.file !== evt.file), ...mapped]);
    });
  }, [cwd]);

  const lspChangeTimersRef = useRef(new Map());
  const lspVersionRef = useRef(new Map());

  const saveTab = useCallback(async (filePath) => {
    const tab = tabsRef.current.find((t) => t.path === filePath);
    if (!tab || !window.autobot?.ideWriteFile) return;
    const r = await window.autobot.ideWriteFile({ path: tab.path, content: tab.content });
    if (r && r.ok) {
      setTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, savedContent: t.content, dirty: false } : t)));
      refreshGit();
      logOutput(`Saved ${tab.relPath}`);
      window.autobot?.ideLspNotify?.({
        cwd,
        language: tab.language,
        method: 'textDocument/didSave',
        params: { file: tab.path, text: tab.content },
      }).catch(() => {});
    } else {
      setError && setError('❌ Save failed: ' + (r?.error || 'unknown'));
    }
  }, [cwd, refreshGit, logOutput, setError]);

  const closeTab = useCallback((filePath) => {
    const closing = tabsRef.current.find((t) => t.path === filePath);
    if (closing) {
      window.autobot?.ideLspNotify?.({
        cwd,
        language: closing.language,
        method: 'textDocument/didClose',
        params: { file: closing.path },
      }).catch(() => {});
    }
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== filePath);
      if (activeTabPath === filePath) {
        setActiveTabPath(next.length ? next[next.length - 1].path : null);
        setDiffState(null);
      }
      if (splitTabPath === filePath) setSplitTabPath(null);
      return next;
    });
  }, [cwd, activeTabPath, splitTabPath]);

  const changeTabContent = useCallback((filePath, content) => {
    let tabLang = 'plaintext';
    setTabs((prev) => prev.map((t) => {
      if (t.path !== filePath) return t;
      tabLang = t.language || 'plaintext';
      return { ...t, content, dirty: content !== t.savedContent };
    }));
    if (window.autobot?.ideLspNotify && cwd) {
      const prevTimer = lspChangeTimersRef.current.get(filePath);
      if (prevTimer) clearTimeout(prevTimer);
      lspChangeTimersRef.current.set(filePath, setTimeout(() => {
        lspChangeTimersRef.current.delete(filePath);
        const ver = (lspVersionRef.current.get(filePath) || 1) + 1;
        lspVersionRef.current.set(filePath, ver);
        window.autobot.ideLspNotify({
          cwd,
          language: tabLang,
          method: 'textDocument/didChange',
          params: { file: filePath, textDocument: { version: ver }, contentChanges: [{ text: content }] },
        }).catch(() => {});
      }, 250));
    }
  }, [cwd]);

  const handleViewStateChange = useCallback((filePath, vs) => {
    setViewStates((prev) => ({ ...prev, [filePath]: vs }));
  }, []);

  const pickFolder = async () => {
    if (!window.autobot?.pickFolder) return;
    const dir = await window.autobot.pickFolder();
    if (dir && setCwd) setCwd(dir);
  };

  const startDrag = (axis, initialVal, setter, minVal, maxVal, invert = false) => (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    const onMove = (ev) => {
      const cur = axis === 'x' ? ev.clientX : ev.clientY;
      const delta = invert ? (start - cur) : (cur - start);
      setter(Math.max(minVal, Math.min(maxVal, initialVal + delta)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // IDE shortcuts (Ctrl/Cmd + P, Shift+O, Shift+F, J, B)
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const curTab = tabsRef.current.find((t) => t.path === activeTabPath) || null;
      const curSyms = curTab ? extractSymbolsFromText(curTab.content) : [];
      if ((e.key === 'p' || e.key === 'P') && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen({ mode: 'files', initialQuery: '', symbols: curSyms });
      } else if ((e.key === 'o' || e.key === 'O') && e.shiftKey) {
        e.preventDefault();
        setQuickOpen({ mode: 'symbols', initialQuery: '@', symbols: curSyms });
      } else if ((e.key === 'f' || e.key === 'F') && e.shiftKey) {
        e.preventDefault();
        setLeftTab('search');
      } else if ((e.key === 'j' || e.key === 'J') && !e.shiftKey) {
        e.preventDefault();
        setBottomTab((b) => (b ? null : 'terminal'));
      } else if ((e.key === 'b' || e.key === 'B') && !e.shiftKey) {
        e.preventDefault();
        setRightOpen((r) => !r);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeTabPath]);

  const allProblems = [...monacoMarkers, ...lspMarkers];
  const activeTab = tabs.find((t) => t.path === activeTabPath) || null;
  const gitBadgeCount = gitStatus && gitStatus.isRepo
    ? (gitStatus.staged?.length || 0) + (gitStatus.unstaged?.length || 0) + (gitStatus.untracked?.length || 0)
    : 0;
  const changesBadgeCount = gitBadgeCount + tabs.filter((t) => t.dirty).length;

  const toggleActiveTabEol = () => {
    if (!activeTab) return;
    const isCrlf = /\r\n/.test(activeTab.content || '');
    const next = isCrlf
      ? String(activeTab.content || '').replace(/\r\n/g, '\n')
      : String(activeTab.content || '').replace(/\r?\n/g, '\r\n');
    changeTabContent(activeTab.path, next);
    setNotice && setNotice(`Converted ${activeTab.name} line endings to ${isCrlf ? 'LF' : 'CRLF'}.`);
  };

  const buildEditorContext = () => {
    const parts = [];
    if (ctxFlags.file && activeTab) {
      parts.push(`Active file: ${activeTab.relPath} (${activeTab.language})`);
      if (cursorCtx && cursorCtx.file === activeTab.path) {
        parts.push(`Cursor: L${cursorCtx.line}:C${cursorCtx.column}`);
      }
    }
    if (ctxFlags.selection && cursorCtx && cursorCtx.selection) {
      parts.push(`Selected lines L${cursorCtx.startLine}-L${cursorCtx.endLine}:\n\`\`\`${cursorCtx.language || ''}\n${cursorCtx.selection}\n\`\`\``);
    }
    if (ctxFlags.problems && allProblems.length) {
      const lines = allProblems.slice(0, 12).map((p) => `- [${p.severity}] ${p.relPath || p.file}:${p.line}:${p.col} ${p.message}`);
      parts.push(`Diagnostics (${allProblems.length}):\n${lines.join('\n')}`);
    }
    return parts.length ? `<editor_context>\n${parts.join('\n')}\n</editor_context>` : '';
  };

  const fixProblemWithAgent = (prob) => {
    const prompt = `Fix this diagnostic in \`${prob.relPath || prob.file}\` at line ${prob.line}:${prob.col}:\n[${prob.severity}] ${prob.message}`;
    setRightOpen(true);
    onSendToAgent && onSendToAgent(prompt);
  };

  const fixAllProblemsWithAgent = (list) => {
    const summary = list.slice(0, 15).map((p) => `- ${p.relPath || p.file}:${p.line} [${p.severity}] ${p.message}`).join('\n');
    setRightOpen(true);
    onSendToAgent && onSendToAgent(`Fix these ${list.length} workspace diagnostics:\n${summary}`);
  };

  const ideCommands = [
    { id: 'toggle-term', title: 'Toggle Terminal Panel', shortcut: sc.toggleTerminal, run: () => setBottomTab((b) => (b ? null : 'terminal')) },
    { id: 'toggle-agent', title: 'Toggle Akron Agent Dock', shortcut: sc.toggleAgent, run: () => setRightOpen((r) => !r) },
    { id: 'search', title: 'Project Search & Replace', shortcut: sc.globalSearch, run: () => setLeftTab('search') },
    { id: 'changes', title: 'Review Agent Changes', shortcut: '', run: () => setLeftTab('changes') },
    { id: 'git', title: 'Source Control (Git)', shortcut: '', run: () => setLeftTab('git') },
    { id: 'mindmap', title: 'Toggle Interactive Mind Map', shortcut: '', run: () => setShowMindMap((v) => !v) },
    { id: 'ghost', title: 'Toggle AI Ghost Autocomplete', shortcut: '', run: () => setGhostEnabled((v) => !v) },
    ...(activeTab ? [{ id: 'save', title: `Save ${activeTab.name}`, shortcut: sc.save, run: () => saveTab(activeTab.path) }] : []),
    ...(onOpenEnvironments ? [{ id: 'envs', title: 'Open Execution Environments (Local / SSH / Remote)', shortcut: '', run: onOpenEnvironments }] : []),
    ...(onOpenRuntimes ? [{ id: 'runtimes', title: 'Open Runtimes & Updates', shortcut: '', run: onOpenRuntimes }] : []),
    ...(onOpenSettings ? [{ id: 'settings', title: 'Open Settings', shortcut: sc.settings, run: onOpenSettings }] : []),
    ...(onSwitchToAgent ? [{ id: 'agent-mode', title: 'Switch to Full Agent Workspace', shortcut: '', run: onSwitchToAgent }] : []),
  ];

  return (
    <div className="ide-workbench">
      <div className="ide-workbench-body">
        {/* Zone 1: Left Activity Bar + Sidebar */}
        <div className="ide-activity-bar">
          <button
            type="button"
            className={'ide-act-btn' + (leftTab === 'explorer' && !showMindMap ? ' on' : '')}
            title="Explorer"
            onClick={() => { setShowMindMap(false); setLeftTab((t) => (t === 'explorer' ? null : 'explorer')); }}
          >
            <Icon name="Files" size={18} />
          </button>
          <button
            type="button"
            className={'ide-act-btn' + (leftTab === 'search' && !showMindMap ? ' on' : '')}
            title={`Search & Replace (${sc.globalSearch})`}
            onClick={() => { setShowMindMap(false); setLeftTab((t) => (t === 'search' ? null : 'search')); }}
          >
            <Icon name="Search" size={18} />
          </button>
          <button
            type="button"
            className={'ide-act-btn' + (leftTab === 'git' && !showMindMap ? ' on' : '')}
            title="Source Control (Git)"
            onClick={() => { setShowMindMap(false); setLeftTab((t) => (t === 'git' ? null : 'git')); }}
          >
            <Icon name="GitBranch" size={18} />
            {gitBadgeCount > 0 && <span className="ide-act-badge">{gitBadgeCount}</span>}
          </button>
          <button
            type="button"
            className={'ide-act-btn' + (leftTab === 'changes' && !showMindMap ? ' on' : '')}
            title="Agent Changes (Accept / Reject)"
            onClick={() => { setShowMindMap(false); setLeftTab((t) => (t === 'changes' ? null : 'changes')); }}
          >
            <Icon name="Sparkles" size={17} />
            {changesBadgeCount > 0 && <span className="ide-act-badge">{changesBadgeCount}</span>}
          </button>
          <button
            type="button"
            className={'ide-act-btn' + (showMindMap ? ' on' : '')}
            title="Interactive Project Mind Map"
            data-testid="ide-mindmap-btn"
            onClick={() => setShowMindMap((v) => !v)}
          >
            <Icon name="Grid" size={17} />
          </button>
          <button
            type="button"
            className={'ide-act-btn' + (bottomTab === 'debug' ? ' on' : '')}
            title="Run & Debug"
            data-testid="ide-debug-btn"
            onClick={() => setBottomTab((b) => (b === 'debug' ? null : 'debug'))}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 7V5a4 4 0 0 1 8 0v2" />
              <rect x="6" y="7" width="12" height="13" rx="6" />
              <path d="M6 12H2M22 12h-4M6 17l-3 2M18 17l3 2M6 8 3 6M18 8l3-2M12 10v8" />
            </svg>
          </button>

          <div className="ide-act-spacer" />

          <button
            type="button"
            className={'ide-act-btn' + (bottomTab ? ' on' : '')}
            title={`Toggle Terminal / Problems (${sc.toggleTerminal})`}
            onClick={() => setBottomTab((b) => (b ? null : 'terminal'))}
          >
            <Icon name="CommandLine" size={17} />
          </button>
          <button
            type="button"
            className={'ide-act-btn' + (rightOpen ? ' on' : '')}
            title={`Toggle Akron Code Agent (${sc.toggleAgent})`}
            onClick={() => setRightOpen((r) => !r)}
          >
            <Icon name="Agent" size={17} />
          </button>
          {onOpenSettings && (
            <button
              type="button"
              className="ide-act-btn"
              title={`Settings (${sc.settings})`}
              aria-label="Settings"
              onClick={onOpenSettings}
            >
              <Icon name="Settings" size={17} />
            </button>
          )}
        </div>

        {leftTab && (
          <>
            <aside className="ide-left-sidebar" style={{ width: leftW }}>
              {leftTab === 'explorer' && (
                <FileTree
                  cwd={cwd}
                  nodes={treeNodes}
                  gitStatus={gitStatus}
                  activeFile={activeTabPath}
                  onOpenFile={(p) => openFile(p)}
                  onRefresh={() => { refreshTree(); refreshGit(); }}
                  onPickFolder={pickFolder}
                  onAddToChat={(node) => {
                    setRightOpen(true);
                    onAttachToChat && onAttachToChat({ name: node.name, path: node.path, relPath: node.relPath });
                  }}
                  onEntryRenamed={(oldPath, newPath) => {
                    const nextName = newPath.split(/[\\/]/).pop() || newPath;
                    const nextRel = relPathOf(cwd, newPath);
                    setTabs((prev) => prev.map((t) => (t.path === oldPath ? { ...t, path: newPath, name: nextName, relPath: nextRel } : t)));
                    setActiveTabPath((cur) => (cur === oldPath ? newPath : cur));
                    setSplitTabPath((cur) => (cur === oldPath ? newPath : cur));
                  }}
                  onEntryDeleted={(deletedPath) => {
                    setTabs((prev) => prev.filter((t) => t.path !== deletedPath && !t.path.startsWith(deletedPath + '/') && !t.path.startsWith(deletedPath + '\\')));
                    setActiveTabPath((cur) => (cur === deletedPath ? null : cur));
                    setSplitTabPath((cur) => (cur === deletedPath ? null : cur));
                  }}
                  onNotify={(msg) => setNotice && setNotice(msg)}
                  Icon={Icon}
                />
              )}
              {leftTab === 'search' && (
                <SearchPanel
                  cwd={cwd}
                  onOpenMatch={(f, l, c) => openFile(f, l, c)}
                  onNotify={(m) => setNotice && setNotice(m)}
                  onFilesMutated={() => { refreshTree(); refreshGit(); }}
                  Icon={Icon}
                />
              )}
              {leftTab === 'git' && (
                <GitPanel
                  cwd={cwd}
                  gitStatus={gitStatus}
                  onRefreshGit={refreshGit}
                  onOpenDiff={(p, rel) => openDiffForFile(p, rel)}
                  onNotify={(m) => setNotice && setNotice(m)}
                  onSwitchWorkspace={setCwd}
                  provider={provider}
                  orchestrator={orchestrator}
                  Icon={Icon}
                />
              )}
              {leftTab === 'changes' && (
                <AgentChangesPanel
                  cwd={cwd}
                  gitStatus={gitStatus}
                  tabs={tabs}
                  onOpenDiff={(p, rel) => openDiffForFile(p, rel)}
                  onSaveTab={saveTab}
                  onReloadFile={reloadOpenFile}
                  onRefreshGit={() => { refreshTree(); refreshGit(); }}
                  onNotify={(m) => setNotice && setNotice(m)}
                  Icon={Icon}
                />
              )}
            </aside>
            <div className="ide-resizer-v" onMouseDown={startDrag('x', leftW, setLeftW, 170, 460)} />
          </>
        )}

        {/* Zone 2 & 3: Center Editor + Bottom Terminal/Problems Drawer */}
        <div className="ide-center-col">
          <div className="ide-editor-area">
            {showMindMap ? (
              <MindMapView
                cwd={cwd}
                theme={theme}
                onOpenFile={(fp, ln) => {
                  setShowMindMap(false);
                  openFile(fp, ln || null);
                }}
                onClose={() => setShowMindMap(false)}
              />
            ) : (
            <MonacoPane
              cwd={cwd}
              theme={theme}
              typography={typography}
              tabs={tabs}
              activeTabPath={activeTabPath}
              onSelectTab={(p) => { setActiveTabPath(p); setDiffState(null); }}
              onCloseTab={closeTab}
              onPinTab={(p) => setTabs((prev) => prev.map((t) => (t.path === p ? { ...t, pinned: !t.pinned } : t)))}
              onChangeTabContent={changeTabContent}
              onSaveTab={saveTab}
              diffMode={Boolean(diffState && activeTab && diffState.path === activeTab.path)}
              diffOriginal={diffState?.original || ''}
              diffTitle={diffState?.title || ''}
              onCloseDiff={() => setDiffState(null)}
              onAcceptAllDiff={() => activeTab && saveTab(activeTab.path).then(() => setDiffState(null))}
              onRejectAllDiff={async () => {
                if (!activeTab || !gitStatus?.root) return;
                await window.autobot.ideGitDiscard({ cwd, files: [activeTab.relPath] });
                await reloadOpenFile(activeTab.path);
                refreshGit();
                setDiffState(null);
              }}
              splitTabPath={splitTabPath}
              onSetSplitTab={setSplitTabPath}
              ghostEnabled={ghostEnabled}
              onToggleGhost={() => setGhostEnabled((v) => !v)}
              onCursorContext={setCursorCtx}
              onMarkersChange={setMonacoMarkers}
              onFixWithAgent={fixProblemWithAgent}
              onOpenQuickOpen={() => setQuickOpen({ mode: 'files', initialQuery: '', symbols: activeTab ? extractSymbolsFromText(activeTab.content) : [] })}
              onOpenCommandCenter={() => setQuickOpen({ mode: 'files', initialQuery: '>', symbols: activeTab ? extractSymbolsFromText(activeTab.content) : [] })}
              onOpenSymbols={(syms) => setQuickOpen({ mode: 'symbols', initialQuery: '@', symbols: syms || (activeTab ? extractSymbolsFromText(activeTab.content) : []) })}
              pendingReveal={pendingReveal}
              viewStates={viewStates}
              onViewStateChange={handleViewStateChange}
              breakpoints={breakpoints}
              onToggleBreakpoint={toggleBreakpoint}
              pausedDebugLine={
                debugState.active && debugState.paused && debugState.filePath === activeTabPath
                  ? debugState.pausedLine
                  : null
              }
              renderCustomTabBody={(tab) => (
                tab && tab.path && tab.path.toLowerCase().endsWith('.ipynb') && !diffState
                  ? (
                    <NotebookPane
                      tab={tab}
                      cwd={cwd}
                      onChangeContent={changeTabContent}
                      onSaveTab={saveTab}
                      onNotify={(m) => setNotice && setNotice(m)}
                      Icon={Icon}
                    />
                  )
                  : null
              )}
              provider={provider}
              orchestrator={orchestrator}
              Icon={Icon}
            />
            )}
          </div>

          <div className="ide-resizer-h" style={{ display: bottomTab ? undefined : 'none' }} onMouseDown={startDrag('y', bottomH, setBottomH, 110, 460, true)} />
          <div className="ide-bottom-drawer" style={{ height: bottomH, display: bottomTab ? 'flex' : 'none' }}>
            <div className="ide-drawer-head">
              <div className="ide-drawer-tabs">
                <button type="button" className={bottomTab === 'terminal' ? 'on' : ''} onClick={() => setBottomTab('terminal')}>
                  Terminal
                </button>
                <button type="button" className={bottomTab === 'problems' ? 'on' : ''} onClick={() => setBottomTab('problems')}>
                  Problems {allProblems.length > 0 && <span className="ide-prob-pill">{allProblems.length}</span>}
                </button>
                <button type="button" className={bottomTab === 'output' ? 'on' : ''} onClick={() => setBottomTab('output')}>
                  Output
                </button>
                <button type="button" className={bottomTab === 'debug' ? 'on' : ''} onClick={() => setBottomTab('debug')}>
                  Debug {debugState.active && <span className="ide-prob-pill">{debugState.paused ? 'Paused' : 'Run'}</span>}
                </button>
              </div>
              <button type="button" className="ide-icon-btn" title={`Close Panel (${sc.toggleTerminal})`} onClick={() => setBottomTab(null)}>
                <Icon name="X" size={12} />
              </button>
            </div>
            <div className="ide-drawer-body">
              <div style={{ display: bottomTab === 'terminal' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, height: '100%' }}>
                <TerminalPanel
                  cwd={cwd}
                  theme={theme}
                  typography={typography}
                  initialBuffer={initialTermBuffer}
                  onSerializeChange={(s) => {
                    termSerializedRef.current = s || '';
                  }}
                  onSendToAgent={(snippet) => {
                    setRightOpen(true);
                    onSendToAgent && onSendToAgent(`Explain or fix this terminal output:\n\`\`\`\n${snippet}\n\`\`\``);
                  }}
                  Icon={Icon}
                />
              </div>
              {bottomTab === 'problems' && (
                <ProblemsPanel
                  problems={allProblems}
                  onSelectProblem={(p) => openFile(p.file, p.line, p.col)}
                  onFixProblem={fixProblemWithAgent}
                  onFixAll={fixAllProblemsWithAgent}
                  Icon={Icon}
                />
              )}
              {bottomTab === 'output' && (
                <div className="ide-output-panel">
                  <div className="ide-output-lsp">
                    LSP Bridges: {Object.entries(lspInfo).map(([k, v]) => `${k}: ${v.available ? (v.running ? 'running' : 'ready') : 'built-in Monaco'}`).join(' · ')}
                  </div>
                  <pre>{outputLogs.join('\n') || 'Workspace watcher and Monaco workers ready.'}</pre>
                </div>
              )}
              {bottomTab === 'debug' && (
                <DebugPanel
                  cwd={cwd}
                  activeTab={activeTab}
                  breakpoints={breakpoints}
                  debugState={debugState}
                  watchExpressions={watchExpressions}
                  onStartDebug={startDebugSession}
                  onCommand={runDebugCommand}
                  onJumpToLocation={(fp, ln) => openFile(fp, ln, 1)}
                  onToggleBreakpoint={toggleBreakpoint}
                  onAddWatch={(expr) => setWatchExpressions((prev) => (prev.includes(expr) ? prev : [...prev, expr]))}
                  onRemoveWatch={(expr) => setWatchExpressions((prev) => prev.filter((x) => x !== expr))}
                />
              )}
            </div>
          </div>
        </div>

        {/* Zone 4: Right Akron Code Agent & Swarm Dock */}
        {rightOpen && (
          <>
            <div className="ide-resizer-v" onMouseDown={startDrag('x', rightW, setRightW, 300, 620, true)} />
            <aside className="ide-agent-dock" style={{ width: rightW }}>
              <div className="ide-dock-head">
                <div className="ide-dock-title">
                  <Icon name="Agent" size={14} /> <span>Akron Code Agent</span>
                </div>
                <div className="ide-ctx-pills" title="Toggle editor context shared with Agent">
                  <button
                    type="button"
                    className={'ide-ctx-pill' + (ctxFlags.file && activeTab ? ' on' : '')}
                    onClick={() => setCtxFlags((f) => ({ ...f, file: !f.file }))}
                    disabled={!activeTab}
                  >
                    {activeTab ? `@${activeTab.name}` : '@file'}
                  </button>
                  <button
                    type="button"
                    className={'ide-ctx-pill' + (ctxFlags.selection && cursorCtx?.selection ? ' on' : '')}
                    onClick={() => setCtxFlags((f) => ({ ...f, selection: !f.selection }))}
                  >
                    {cursorCtx?.selection ? `L${cursorCtx.startLine}-${cursorCtx.endLine}` : 'Cursor'}
                  </button>
                  <button
                    type="button"
                    className={'ide-ctx-pill' + (ctxFlags.problems && allProblems.length ? ' on' : '')}
                    onClick={() => setCtxFlags((f) => ({ ...f, problems: !f.problems }))}
                  >
                    {allProblems.length} {allProblems.length === 1 ? 'problem' : 'problems'}
                  </button>
                </div>
                <button type="button" className="ide-icon-btn" title={`Collapse Agent Dock (${sc.toggleAgent})`} onClick={() => setRightOpen(false)}>
                  <Icon name="X" size={12} />
                </button>
              </div>
              <div className="ide-dock-body">
                {renderAgentDock && renderAgentDock({
                  editorContextXml: buildEditorContext(),
                  onOpenFileDiff: (fp) => openDiffForFile(fp),
                })}
              </div>
            </aside>
          </>
        )}
      </div>

      <IdeStatusBar
        cwd={cwd}
        envState={envState}
        onOpenEnvironments={onOpenEnvironments}
        gitStatus={gitStatus}
        onRefreshGit={refreshGit}
        onNotify={(m) => setNotice && setNotice(m)}
        problems={allProblems}
        onOpenProblems={() => setBottomTab((b) => (b === 'problems' ? null : 'problems'))}
        activeTab={activeTab}
        cursorCtx={cursorCtx}
        onToggleEol={toggleActiveTabEol}
        ghostEnabled={ghostEnabled}
        onToggleGhost={() => setGhostEnabled((v) => !v)}
        modelLabel={(provider && provider.routingMode === 'auto') ? 'Auto' : ((provider && provider.model) || 'auto')}
        contextPct={contextPct}
        onOpenProviders={onOpenSettings}
        Icon={Icon}
      />

      {quickOpen && (
        <QuickOpenModal
          mode={quickOpen.mode}
          initialQuery={quickOpen.initialQuery || ''}
          treeNodes={treeNodes}
          symbols={quickOpen.symbols}
          commands={ideCommands}
          onSelectFile={(p) => openFile(p)}
          onSelectSymbol={(s) => activeTabPath && setPendingReveal({ path: activeTabPath, line: s.line, col: s.col || 1, at: Date.now() })}
          onClose={() => setQuickOpen(null)}
        />
      )}
    </div>
  );
}
