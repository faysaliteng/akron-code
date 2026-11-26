import React, { useState, useEffect, useCallback, useRef } from 'react';
import { FileTree } from './FileTree';
import { SearchPanel } from './SearchPanel';
import { GitPanel } from './GitPanel';
import { MonacoPane } from './MonacoPane';
import { TerminalPanel } from './TerminalPanel';
import { ProblemsPanel } from './ProblemsPanel';
import { QuickOpenModal } from './QuickOpenModal';
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
  provider,
  orchestrator,
  setError,
  setNotice,
  onAttachToChat,
  onSendToAgent,
  onOpenSettings,
  renderAgentDock,
  externalOpenFile = null, // { path, diff, at } when Agent Review opens a file in IDE
  Icon,
}) {
  const [leftTab, setLeftTab] = useState('explorer'); // 'explorer' | 'search' | 'git' | null
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

  const [quickOpen, setQuickOpen] = useState(null); // { mode: 'files'|'symbols', symbols: [] }
  const [ghostEnabled, setGhostEnabled] = useState(false);

  const [monacoMarkers, setMonacoMarkers] = useState([]);
  const [lspMarkers, setLspMarkers] = useState([]);
  const [lspInfo, setLspInfo] = useState({});
  const [outputLogs, setOutputLogs] = useState([]);

  const [cursorCtx, setCursorCtx] = useState(null);
  const [ctxFlags, setCtxFlags] = useState({ file: true, selection: true, problems: false });

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

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

  useEffect(() => {
    if (!cwd) return;
    refreshTree();
    refreshGit();
    window.autobot?.ideLspStatus?.({ cwd }).then((st) => st && setLspInfo(st)).catch(() => {});
    window.autobot?.ideWatchWorkspace?.({ cwd }).catch(() => {});
    return () => {
      window.autobot?.ideUnwatchWorkspace?.({ cwd }).catch(() => {});
    };
  }, [cwd, refreshTree, refreshGit]);

  const openFile = useCallback(async (filePath, line = null, col = null) => {
    if (!filePath || !window.autobot?.ideReadFile) return;
    const existing = tabsRef.current.find((t) => t.path === filePath);
    if (existing) {
      setActiveTabPath(filePath);
      setDiffState(null);
      if (line) setPendingReveal({ path: filePath, line, col: col || 1, at: Date.now() });
      return;
    }
    const r = await window.autobot.ideReadFile({ path: filePath });
    if (!r || !r.ok) {
      setError && setError('❌ ' + (r?.error || 'Could not open file'));
      return;
    }
    if (r.binary) {
      setNotice && setNotice(`Binary file (${r.size} bytes) cannot be edited in text mode.`);
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
      pinned: false,
    };
    setTabs((prev) => [...prev, tab]);
    setActiveTabPath(r.path);
    setDiffState(null);
    if (line) setPendingReveal({ path: r.path, line, col: col || 1, at: Date.now() });
    // Notify LSP best-effort
    window.autobot?.ideLspNotify?.({
      cwd,
      language: tab.language,
      method: 'textDocument/didOpen',
      params: { file: tab.path, textDocument: { languageId: tab.language, version: 1, text: tab.content } },
    }).catch(() => {});
  }, [cwd, setError, setNotice]);

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

  // External open request (e.g. clicking a changed file in Agent Review)
  useEffect(() => {
    if (!externalOpenFile || !externalOpenFile.path) return;
    if (externalOpenFile.diff) openDiffForFile(externalOpenFile.path);
    else openFile(externalOpenFile.path, externalOpenFile.line || null, 1);
  }, [externalOpenFile, openFile, openDiffForFile]);

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

  const saveTab = useCallback(async (filePath) => {
    const tab = tabsRef.current.find((t) => t.path === filePath);
    if (!tab || !window.autobot?.ideWriteFile) return;
    const r = await window.autobot.ideWriteFile({ path: tab.path, content: tab.content });
    if (r && r.ok) {
      setTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, savedContent: t.content, dirty: false } : t)));
      refreshGit();
      logOutput(`Saved ${tab.relPath}`);
    } else {
      setError && setError('❌ Save failed: ' + (r?.error || 'unknown'));
    }
  }, [refreshGit, logOutput, setError]);

  const closeTab = useCallback((filePath) => {
    setTabs((prev) => {
      const next = prev.filter((t) => t.path !== filePath);
      if (activeTabPath === filePath) {
        setActiveTabPath(next.length ? next[next.length - 1].path : null);
        setDiffState(null);
      }
      if (splitTabPath === filePath) setSplitTabPath(null);
      return next;
    });
  }, [activeTabPath, splitTabPath]);

  const changeTabContent = useCallback((filePath, content) => {
    setTabs((prev) => prev.map((t) => (t.path === filePath ? { ...t, content, dirty: content !== t.savedContent } : t)));
  }, []);

  const pickFolder = async () => {
    if (!window.autobot?.pickFolder) return;
    const dir = await window.autobot.pickFolder();
    if (dir && setCwd) setCwd(dir);
  };

  // Drag-resize helper
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

  // IDE shortcuts (⌘P, ⇧⌘F, ⌘J, ⌘B)
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if ((e.key === 'p' || e.key === 'P') && !e.shiftKey) {
        e.preventDefault();
        setQuickOpen({ mode: 'files', symbols: [] });
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
  }, []);

  const allProblems = [...monacoMarkers, ...lspMarkers];
  const activeTab = tabs.find((t) => t.path === activeTabPath) || null;
  const gitBadgeCount = gitStatus && gitStatus.isRepo
    ? (gitStatus.staged?.length || 0) + (gitStatus.unstaged?.length || 0) + (gitStatus.untracked?.length || 0)
    : 0;

  // Build dynamic Editor Context block for Agent composer
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

  return (
    <div className="ide-workbench">
      {/* Zone 1: Left Activity Bar + Sidebar */}
      <div className="ide-activity-bar">
        <button
          type="button"
          className={'ide-act-btn' + (leftTab === 'explorer' ? ' on' : '')}
          title="Explorer"
          onClick={() => setLeftTab((t) => (t === 'explorer' ? null : 'explorer'))}
        >
          <Icon name="Files" size={18} />
        </button>
        <button
          type="button"
          className={'ide-act-btn' + (leftTab === 'search' ? ' on' : '')}
          title="Search & Replace (⇧⌘F)"
          onClick={() => setLeftTab((t) => (t === 'search' ? null : 'search'))}
        >
          <Icon name="Search" size={18} />
        </button>
        <button
          type="button"
          className={'ide-act-btn' + (leftTab === 'git' ? ' on' : '')}
          title="Source Control (Git)"
          onClick={() => setLeftTab((t) => (t === 'git' ? null : 'git'))}
        >
          <Icon name="GitBranch" size={18} />
          {gitBadgeCount > 0 && <span className="ide-act-badge">{gitBadgeCount}</span>}
        </button>

        <div className="ide-act-spacer" />

        <button
          type="button"
          className={'ide-act-btn' + (bottomTab ? ' on' : '')}
          title="Toggle Terminal / Problems (⌘J)"
          onClick={() => setBottomTab((b) => (b ? null : 'terminal'))}
        >
          <Icon name="CommandLine" size={17} />
        </button>
        <button
          type="button"
          className={'ide-act-btn' + (rightOpen ? ' on' : '')}
          title="Toggle Akron Code Agent (⌘B)"
          onClick={() => setRightOpen((r) => !r)}
        >
          <Icon name="Agent" size={17} />
        </button>
        {onOpenSettings && (
          <button
            type="button"
            className="ide-act-btn"
            title="Settings"
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
          </aside>
          <div className="ide-resizer-v" onMouseDown={startDrag('x', leftW, setLeftW, 170, 460)} />
        </>
      )}

      {/* Zone 2 & 3: Center Editor + Bottom Terminal/Problems Drawer */}
      <div className="ide-center-col">
        <div className="ide-editor-area">
          <MonacoPane
            cwd={cwd}
            theme={theme}
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
              const fresh = await window.autobot.ideReadFile({ path: activeTab.path });
              if (fresh && fresh.ok) {
                setTabs((prev) => prev.map((t) => (t.path === activeTab.path ? { ...t, content: fresh.content, savedContent: fresh.content, dirty: false } : t)));
              }
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
            onOpenQuickOpen={() => setQuickOpen({ mode: 'files', symbols: [] })}
            onOpenSymbols={(syms) => setQuickOpen({ mode: 'symbols', symbols: syms || [] })}
            pendingReveal={pendingReveal}
            provider={provider}
            orchestrator={orchestrator}
            Icon={Icon}
          />
        </div>

        {bottomTab && (
          <>
            <div className="ide-resizer-h" onMouseDown={startDrag('y', bottomH, setBottomH, 110, 460, true)} />
            <div className="ide-bottom-drawer" style={{ height: bottomH }}>
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
                </div>
                <button type="button" className="ide-icon-btn" title="Close Panel (⌘J)" onClick={() => setBottomTab(null)}>
                  <Icon name="X" size={12} />
                </button>
              </div>
              <div className="ide-drawer-body">
                {bottomTab === 'terminal' && (
                  <TerminalPanel
                    cwd={cwd}
                    theme={theme}
                    onSendToAgent={(snippet) => {
                      setRightOpen(true);
                      onSendToAgent && onSendToAgent(`Explain or fix this terminal output:\n\`\`\`\n${snippet}\n\`\`\``);
                    }}
                    Icon={Icon}
                  />
                )}
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
              </div>
            </div>
          </>
        )}
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
              <button type="button" className="ide-icon-btn" title="Collapse Agent Dock (⌘B)" onClick={() => setRightOpen(false)}>
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

      {quickOpen && (
        <QuickOpenModal
          mode={quickOpen.mode}
          treeNodes={treeNodes}
          symbols={quickOpen.symbols}
          onSelectFile={(p) => openFile(p)}
          onSelectSymbol={(s) => activeTabPath && setPendingReveal({ path: activeTabPath, line: s.line, col: s.col || 1, at: Date.now() })}
          onClose={() => setQuickOpen(null)}
        />
      )}
    </div>
  );
}
