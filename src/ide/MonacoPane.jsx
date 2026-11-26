import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ensureMonaco,
  setMonacoTheme,
  registerGhostTextProvider,
  registerFixWithAkronAction,
  monaco,
} from './monacoSetup';
import { InlineEditWidget } from './InlineEditWidget';

export function extractSymbolsFromModel(model) {
  if (!model) return [];
  const text = model.getValue();
  const lines = text.split('\n');
  const syms = [];
  const patterns = [
    { re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: 'function' },
    { re: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, kind: 'fn' },
    { re: /^\s*def\s+([A-Za-z_][\w]*)\s*\(/, kind: 'def' },
    { re: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)/, kind: 'func' },
  ];
  for (let i = 0; i < lines.length; i++) {
    for (const p of patterns) {
      const m = p.re.exec(lines[i]);
      if (m) {
        syms.push({ name: m[1], kind: p.kind, line: i + 1, col: 1 });
        break;
      }
    }
  }
  return syms;
}

export function MonacoPane({
  cwd,
  theme,
  tabs = [],
  activeTabPath,
  onSelectTab,
  onCloseTab,
  onPinTab,
  onChangeTabContent,
  onSaveTab,
  diffMode = false, // boolean: show diff editor against diffOriginal
  diffOriginal = '',
  diffTitle = '',
  onCloseDiff,
  onAcceptAllDiff,
  onRejectAllDiff,
  splitTabPath = null,
  onSetSplitTab,
  ghostEnabled = false,
  onToggleGhost,
  onCursorContext,
  onMarkersChange,
  onFixWithAgent,
  onOpenQuickOpen,
  onOpenSymbols,
  pendingReveal = null, // { path, line, col }
  provider,
  orchestrator,
  Icon,
}) {
  const editorContainerRef = useRef(null);
  const splitContainerRef = useRef(null);
  const diffContainerRef = useRef(null);
  const editorRef = useRef(null);
  const splitEditorRef = useRef(null);
  const diffEditorRef = useRef(null);

  const [minimap, setMinimap] = useState(false);
  const [inlineEdit, setInlineEdit] = useState(null);
  const [activeSymbol, setActiveSymbol] = useState('');
  const [lineChanges, setLineChanges] = useState([]);

  const activeTab = tabs.find((t) => t.path === activeTabPath) || null;
  const splitTab = splitTabPath ? tabs.find((t) => t.path === splitTabPath) : null;
  const hasActiveTab = Boolean(activeTab);

  const openCmdK = useCallback((ed, initialInstruction = '') => {
    const curTab = latestRef.current.activeTab;
    if (!ed || !curTab) return;
    const model = ed.getModel();
    if (!model) return;
    const sel = ed.getSelection();
    const pos = ed.getPosition() || { lineNumber: 1, column: 1 };
    const selectionText = sel ? model.getValueInRange(sel) : '';
    const range = sel || new monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column);
    const prefix = model.getValueInRange(new monaco.Range(1, 1, range.startLineNumber, range.startColumn));
    const lastLn = model.getLineCount();
    const suffix = model.getValueInRange(new monaco.Range(range.endLineNumber, range.endColumn, lastLn, model.getLineMaxColumn(lastLn)));
    setInlineEdit({
      filePath: curTab.path,
      language: curTab.language || model.getLanguageId(),
      lineNumber: range.startLineNumber,
      selectionText,
      prefix,
      suffix,
      range,
      initialInstruction,
    });
  }, []);

  const latestRef = useRef({});
  latestRef.current = {
    activeTab,
    activeTabPath,
    onSaveTab,
    onChangeTabContent,
    onCursorContext,
    onMarkersChange,
    onOpenQuickOpen,
    onOpenSymbols,
    openCmdK,
  };

  useEffect(() => {
    setMonacoTheme(theme);
  }, [theme]);

  // Ghost text registration when enabled
  useEffect(() => {
    if (!ghostEnabled) return undefined;
    return registerGhostTextProvider(async (model, position) => {
      if (!window.autobot || !window.autobot.ideInlineComplete) return '';
      const prefix = model.getValueInRange(new monaco.Range(Math.max(1, position.lineNumber - 25), 1, position.lineNumber, position.column));
      const lineCount = model.getLineCount();
      const suffix = model.getValueInRange(new monaco.Range(position.lineNumber, position.column, Math.min(lineCount, position.lineNumber + 10), model.getLineMaxColumn(Math.min(lineCount, position.lineNumber + 10))));
      const res = await window.autobot.ideInlineComplete({
        provider,
        orchestrator,
        filePath: activeTabPath || '',
        language: model.getLanguageId(),
        prefix,
        suffix,
      });
      return (res && res.insertText) || '';
    });
  }, [ghostEnabled, provider, orchestrator, activeTabPath]);

  // Register "Fix with Akron Code" code action
  useEffect(() => {
    return registerFixWithAkronAction(({ model, primary }) => {
      if (onFixWithAgent) {
        onFixWithAgent({
          file: activeTabPath || model.uri.fsPath || '',
          line: primary.startLineNumber,
          col: primary.startColumn,
          message: primary.message,
          severity: primary.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning',
        });
      }
    });
  }, [onFixWithAgent, activeTabPath]);

  // Primary Single Editor Lifecycle
  useEffect(() => {
    if (diffMode || !hasActiveTab) {
      if (editorRef.current) { try { editorRef.current.dispose(); } catch (_) {} editorRef.current = null; }
      return undefined;
    }
    const container = editorContainerRef.current;
    if (!container) return undefined;
    ensureMonaco();
    const initTab = latestRef.current.activeTab;
    const ed = monaco.editor.create(container, {
      value: initTab ? initTab.content : '',
      language: (initTab && initTab.language) || 'plaintext',
      theme: theme === 'light' ? 'akron-light' : 'akron-dark',
      automaticLayout: true,
      minimap: { enabled: minimap },
      fontSize: 13.5,
      lineHeight: 21,
      fontFamily: "'SF Mono', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace",
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      renderWhitespace: 'selection',
      inlineSuggest: { enabled: true },
    });
    editorRef.current = ed;

    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const r = latestRef.current;
      r.onSaveTab && r.activeTabPath && r.onSaveTab(r.activeTabPath);
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => latestRef.current.openCmdK(ed));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => latestRef.current.onOpenQuickOpen && latestRef.current.onOpenQuickOpen());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => latestRef.current.onOpenSymbols && latestRef.current.onOpenSymbols(extractSymbolsFromModel(ed.getModel())));

    const dContent = ed.onDidChangeModelContent(() => {
      const r = latestRef.current;
      if (r.activeTabPath && r.onChangeTabContent) {
        r.onChangeTabContent(r.activeTabPath, ed.getValue());
      }
    });
    const dCursor = ed.onDidChangeCursorSelection(() => {
      const r = latestRef.current;
      const model = ed.getModel();
      const sel = ed.getSelection();
      const pos = ed.getPosition();
      if (model && pos) {
        const syms = extractSymbolsFromModel(model);
        let curSym = '';
        for (const s of syms) if (s.line <= pos.lineNumber) curSym = s.name;
        setActiveSymbol(curSym);
      }
      if (r.onCursorContext && model && pos) {
        const selectionText = sel && !sel.isEmpty() ? model.getValueInRange(sel) : '';
        r.onCursorContext({
          file: r.activeTabPath,
          line: pos.lineNumber,
          column: pos.column,
          startLine: sel ? sel.startLineNumber : pos.lineNumber,
          endLine: sel ? sel.endLineNumber : pos.lineNumber,
          selection: selectionText.slice(0, 4000),
          language: model.getLanguageId(),
        });
      }
    });

    const dMarkers = monaco.editor.onDidChangeMarkers(() => {
      const r = latestRef.current;
      if (!r.onMarkersChange) return;
      const all = monaco.editor.getModelMarkers({});
      const mapped = all.map((m) => ({
        file: r.activeTabPath || (m.resource && m.resource.path) || '',
        relPath: r.activeTab ? r.activeTab.relPath : '',
        line: m.startLineNumber,
        col: m.startColumn,
        message: m.message,
        severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning',
      }));
      r.onMarkersChange(mapped);
    });

    return () => {
      try { dContent.dispose(); } catch (_) {}
      try { dCursor.dispose(); } catch (_) {}
      try { dMarkers.dispose(); } catch (_) {}
      try { ed.dispose(); } catch (_) {}
      editorRef.current = null;
    };
  }, [diffMode, hasActiveTab]);

  // Sync active tab content/language into primary editor
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !activeTab) return;
    const model = ed.getModel();
    if (model) {
      if (model.getLanguageId() !== (activeTab.language || 'plaintext')) {
        monaco.editor.setModelLanguage(model, activeTab.language || 'plaintext');
      }
      if (ed.getValue() !== activeTab.content) {
        ed.setValue(activeTab.content || '');
      }
    }
  }, [activeTab?.path, activeTab?.content, activeTab?.language]);

  useEffect(() => {
    const ed = editorRef.current;
    if (ed) ed.updateOptions({ minimap: { enabled: minimap } });
  }, [minimap]);

  // Jump to line/column when Search/Problems/QuickOpen requests
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !pendingReveal || !pendingReveal.line) return;
    if (pendingReveal.path && pendingReveal.path !== activeTabPath) return;
    ed.revealLineInCenter(pendingReveal.line);
    ed.setPosition({ lineNumber: pendingReveal.line, column: pendingReveal.col || 1 });
    ed.focus();
  }, [pendingReveal, activeTabPath]);

  // Secondary Split Editor
  useEffect(() => {
    const container = splitContainerRef.current;
    if (!splitTab || diffMode || !container) {
      if (splitEditorRef.current) { try { splitEditorRef.current.dispose(); } catch (_) {} splitEditorRef.current = null; }
      return undefined;
    }
    ensureMonaco();
    const ed = monaco.editor.create(container, {
      value: splitTab.content || '',
      language: splitTab.language || 'plaintext',
      theme: theme === 'light' ? 'akron-light' : 'akron-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 13.5,
      lineHeight: 21,
      scrollBeyondLastLine: false,
      readOnly: false,
    });
    splitEditorRef.current = ed;
    const d = ed.onDidChangeModelContent(() => {
      onChangeTabContent && onChangeTabContent(splitTab.path, ed.getValue());
    });
    return () => {
      try { d.dispose(); } catch (_) {}
      try { ed.dispose(); } catch (_) {}
      splitEditorRef.current = null;
    };
  }, [splitTab?.path, diffMode]);

  // Diff Editor (Git HEAD or Agent Change Review with per-hunk accept/reject!)
  useEffect(() => {
    const container = diffContainerRef.current;
    if (!diffMode || !container || !activeTab) {
      if (diffEditorRef.current) { try { diffEditorRef.current.dispose(); } catch (_) {} diffEditorRef.current = null; }
      return undefined;
    }
    ensureMonaco();
    const origModel = monaco.editor.createModel(diffOriginal || '', activeTab.language || 'plaintext');
    const modModel = monaco.editor.createModel(activeTab.content || '', activeTab.language || 'plaintext');
    const ded = monaco.editor.createDiffEditor(container, {
      theme: theme === 'light' ? 'akron-light' : 'akron-dark',
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: false,
      fontSize: 13.5,
      lineHeight: 21,
    });
    ded.setModel({ original: origModel, modified: modModel });
    diffEditorRef.current = ded;
    const dDiff = ded.onDidUpdateDiff(() => {
      try { setLineChanges(ded.getLineChanges() || []); } catch (_) {}
    });
    const dMod = modModel.onDidChangeContent(() => {
      onChangeTabContent && onChangeTabContent(activeTab.path, modModel.getValue());
    });
    return () => {
      try { dDiff.dispose(); } catch (_) {}
      try { dMod.dispose(); } catch (_) {}
      try { ded.dispose(); } catch (_) {}
      try { origModel.dispose(); } catch (_) {}
      try { modModel.dispose(); } catch (_) {}
      diffEditorRef.current = null;
      setLineChanges([]);
    };
  }, [diffMode, activeTab?.path, diffOriginal]);

  const applyHunk = async (hunkIdx, action) => {
    const ded = diffEditorRef.current;
    if (!ded) return;
    const orig = ded.getOriginalEditor().getModel();
    const mod = ded.getModifiedEditor().getModel();
    const changes = ded.getLineChanges() || [];
    const h = changes[hunkIdx];
    if (!orig || !mod || !h) return;
    if (action === 'reject') {
      const origRange = h.originalEndLineNumber >= h.originalStartLineNumber && h.originalStartLineNumber > 0
        ? new monaco.Range(h.originalStartLineNumber, 1, h.originalEndLineNumber, orig.getLineMaxColumn(h.originalEndLineNumber))
        : null;
      const origText = origRange ? orig.getValueInRange(origRange) : '';
      const modStart = Math.max(1, h.modifiedStartLineNumber);
      const modEnd = Math.max(modStart, h.modifiedEndLineNumber || modStart);
      const targetRange = h.modifiedEndLineNumber >= h.modifiedStartLineNumber && h.modifiedStartLineNumber > 0
        ? new monaco.Range(modStart, 1, modEnd, mod.getLineMaxColumn(modEnd))
        : new monaco.Range(modStart, 1, modStart, 1);
      mod.pushEditOperations([], [{ range: targetRange, text: origText }], () => null);
    } else if (action === 'accept' && window.autobot?.ideGitStage && cwd && activeTab?.relPath) {
      await onSaveTab(activeTab.path);
    }
  };

  const acceptInlineEdit = (newText, range) => {
    const ed = editorRef.current;
    if (!ed) { setInlineEdit(null); return; }
    const model = ed.getModel();
    if (model && range) {
      ed.pushUndoStop();
      model.pushEditOperations([], [{ range, text: newText }], () => null);
      ed.pushUndoStop();
    }
    setInlineEdit(null);
    ed.focus();
  };

  const breadcrumbs = activeTab
    ? (activeTab.relPath || activeTab.name || '').replace(/\\/g, '/').split('/').filter(Boolean)
    : [];

  return (
    <div className="ide-editor-root">
      <div className="ide-tabs-bar">
        <div className="ide-tabs-scroll">
          {tabs.map((t) => (
            <div
              key={t.path}
              className={'ide-tab' + (t.path === activeTabPath ? ' on' : '') + (t.pinned ? ' pinned' : '')}
              onClick={() => onSelectTab && onSelectTab(t.path)}
              onDoubleClick={() => onPinTab && onPinTab(t.path)}
              title={t.path}
            >
              {t.pinned && <span className="ide-tab-pin">📌</span>}
              <span className="ide-tab-name">{t.name}</span>
              {t.dirty && <span className="ide-tab-dirty" title="Unsaved changes">●</span>}
              <button type="button" className="ide-tab-x" onClick={(e) => { e.stopPropagation(); onCloseTab && onCloseTab(t.path); }}>×</button>
            </div>
          ))}
        </div>
        <div className="ide-editor-tools">
          <button type="button" className="ide-mini-action" title="Quick Open (⌘P)" onClick={() => onOpenQuickOpen && onOpenQuickOpen()}>
            ⌘P
          </button>
          <button
            type="button"
            className={'ide-mini-action' + (ghostEnabled ? ' accent' : '')}
            title="Toggle AI Tab Ghost Text Autocomplete"
            onClick={onToggleGhost}
          >
            Ghost {ghostEnabled ? 'On' : 'Off'}
          </button>
          <button
            type="button"
            className={'ide-icon-btn' + (minimap ? ' active' : '')}
            title="Toggle Minimap"
            onClick={() => setMinimap((v) => !v)}
          >
            <Icon name="Grid" size={13} />
          </button>
          <button
            type="button"
            className={'ide-icon-btn' + (splitTabPath ? ' active' : '')}
            title="Split Editor Right"
            onClick={() => onSetSplitTab && onSetSplitTab(splitTabPath ? null : activeTabPath)}
            disabled={!activeTab}
          >
            <Icon name="ArrowSplitRight" size={13} />
          </button>
          {activeTab && !diffMode && (
            <button
              type="button"
              className="ide-mini-action"
              title="Open Inline Edit (⌘K)"
              onClick={() => openCmdK(editorRef.current)}
            >
              ⌘K
            </button>
          )}
          {activeTab && activeTab.dirty && (
            <button type="button" className="ide-primary-btn" onClick={() => onSaveTab && onSaveTab(activeTab.path)}>
              Save ⌘S
            </button>
          )}
        </div>
      </div>

      {activeTab && (
        <div className="ide-breadcrumbs">
          {breadcrumbs.map((seg, i) => (
            <span key={i} className="ide-crumb">
              {i > 0 && <span className="ide-crumb-sep">›</span>}
              <span>{seg}</span>
            </span>
          ))}
          {activeSymbol && (
            <button
              type="button"
              className="ide-crumb-sym"
              onClick={() => onOpenSymbols && onOpenSymbols(extractSymbolsFromModel(editorRef.current?.getModel()))}
            >
              › {activeSymbol}
            </button>
          )}
          {diffMode && (
            <div className="ide-diff-controls">
              <span className="ide-diff-label">{diffTitle || 'Diff'} ({lineChanges.length} hunks)</span>
              {lineChanges.length > 0 && (
                <button type="button" className="ide-mini-action" onClick={() => applyHunk(0, 'reject')} title="Reject first hunk">
                  Reject Hunk #1
                </button>
              )}
              {onRejectAllDiff && (
                <button type="button" className="ide-mini-action" onClick={onRejectAllDiff}>Reject File</button>
              )}
              {onAcceptAllDiff && (
                <button type="button" className="ide-primary-btn" onClick={onAcceptAllDiff}>Accept &amp; Save</button>
              )}
              <button type="button" className="ide-mini-action" onClick={onCloseDiff}>Exit Diff</button>
            </div>
          )}
        </div>
      )}

      <div className="ide-monaco-stage">
        {inlineEdit && (
          <InlineEditWidget
            state={inlineEdit}
            provider={provider}
            orchestrator={orchestrator}
            onAccept={acceptInlineEdit}
            onCancel={() => setInlineEdit(null)}
            Icon={Icon}
          />
        )}
        {!activeTab ? (
          <div className="ide-editor-welcome">
            <div className="ide-welcome-card">
              <h3>Akron Code IDE</h3>
              <p>Select a file from the Explorer or press <kbd>⌘P</kbd> to Quick Open.</p>
              <div className="ide-welcome-shortcuts">
                <span><kbd>⌘K</kbd> Inline AI Edit</span>
                <span><kbd>⇧⌘F</kbd> Project Search</span>
                <span><kbd>⇧⌘O</kbd> Go to Symbol</span>
                <span><kbd>⌘J</kbd> Toggle Terminal</span>
              </div>
            </div>
          </div>
        ) : diffMode ? (
          <div ref={diffContainerRef} className="ide-monaco-host" />
        ) : (
          <div className={'ide-monaco-split' + (splitTab ? ' dual' : '')}>
            <div ref={editorContainerRef} className="ide-monaco-host" />
            {splitTab && <div ref={splitContainerRef} className="ide-monaco-host ide-split-second" />}
          </div>
        )}
      </div>
    </div>
  );
}
