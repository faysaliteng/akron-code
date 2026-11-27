import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  ensureMonaco,
  setMonacoTheme,
  registerGhostTextProvider,
  registerFixWithAkronAction,
  monaco,
} from './monacoSetup';
import { InlineEditWidget } from './InlineEditWidget';
import { shortcutLabels } from './shortcuts';
import { normalizeTypography, resolveMonoFontStack } from '../typography.js';

export function extractSymbolsFromText(text) {
  if (!text) return [];
  const lines = String(text).split('\n');
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

export function extractSymbolsFromModel(model) {
  if (!model) return [];
  return extractSymbolsFromText(model.getValue());
}

export function getOrCreateFileModel(tab) {
  if (!tab || !tab.path) return null;
  const uri = monaco.Uri.file(tab.path);
  let model = monaco.editor.getModel(uri);
  if (!model) {
    model = monaco.editor.createModel(tab.content || '', tab.language || 'plaintext', uri);
  }
  return model;
}

export function MonacoPane({
  cwd,
  theme,
  typography = null,
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
  onOpenCommandCenter,
  onOpenSymbols,
  pendingReveal = null, // { path, line, col }
  viewStates = {},
  onViewStateChange,
  breakpoints = [],
  onToggleBreakpoint,
  pausedDebugLine = null,
  renderCustomTabBody = null,
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
  const debugDecosRef = useRef([]);
  const nextEditTimerRef = useRef(null);
  const baselineContentRef = useRef({});

  const [minimap, setMinimap] = useState(false);
  const [inlineEdit, setInlineEdit] = useState(null);
  const [nextEdit, setNextEdit] = useState(null);
  const [activeSymbol, setActiveSymbol] = useState('');
  const [lineChanges, setLineChanges] = useState([]);
  const [activeHunkIdx, setActiveHunkIdx] = useState(0);
  const sc = shortcutLabels();

  const activeTab = tabs.find((t) => t.path === activeTabPath) || null;
  const splitTab = splitTabPath ? tabs.find((t) => t.path === splitTabPath) : null;
  const hasActiveTab = Boolean(activeTab);
  const customBody = !diffMode && activeTab && renderCustomTabBody ? renderCustomTabBody(activeTab) : null;
  const hasMonacoHost = Boolean(activeTab && !customBody);

  const applyNextEdit = useCallback(() => {
    const ed = editorRef.current;
    const pred = nextEdit;
    if (!ed || !pred || !pred.line) return;
    const model = ed.getModel();
    if (!model) return;
    const lineNum = Math.max(1, Math.min(model.getLineCount(), Number(pred.line)));
    const maxCol = model.getLineMaxColumn(lineNum);
    if (typeof pred.replacementLineText === 'string' && pred.replacementLineText.length > 0) {
      ed.executeEdits('akron-next-edit', [{
        range: new monaco.Range(lineNum, 1, lineNum, maxCol),
        text: pred.replacementLineText,
      }]);
    }
    ed.revealLineInCenter(lineNum);
    ed.setPosition({ lineNumber: lineNum, column: pred.column || 1 });
    ed.focus();
    setNextEdit(null);
  }, [nextEdit]);

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
    tabs,
    viewStates,
    activeTab,
    activeTabPath,
    onSaveTab,
    onChangeTabContent,
    onCursorContext,
    onMarkersChange,
    onOpenQuickOpen,
    onOpenSymbols,
    onViewStateChange,
    onToggleBreakpoint,
    applyNextEdit,
    openCmdK,
    provider,
    orchestrator,
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
    if (diffMode || !hasMonacoHost) {
      if (editorRef.current) { try { editorRef.current.dispose(); } catch (_) {} editorRef.current = null; }
      return undefined;
    }
    const container = editorContainerRef.current;
    if (!container) return undefined;
    ensureMonaco();
    const typo = normalizeTypography(typography);
    const monoFont = resolveMonoFontStack(typo);
    const codeFontSize = typo.monoSize || 13.5;
    const initTab = latestRef.current.activeTab;
    if (initTab && baselineContentRef.current[initTab.path] === undefined) {
      baselineContentRef.current[initTab.path] = initTab.savedContent ?? initTab.content ?? '';
    }
    const initModel = getOrCreateFileModel(initTab);
    const ed = monaco.editor.create(container, {
      model: initModel || undefined,
      theme: theme === 'light' ? 'akron-light' : 'akron-dark',
      automaticLayout: true,
      minimap: { enabled: minimap },
      glyphMargin: true,
      fontSize: codeFontSize,
      lineHeight: Math.round(codeFontSize * 1.55),
      fontFamily: monoFont,
      fontLigatures: !!typo.ligatures,
      scrollBeyondLastLine: false,
      smoothScrolling: true,
      tabSize: 2,
      renderWhitespace: 'selection',
      inlineSuggest: { enabled: true },
    });
    editorRef.current = ed;

    const bindEditorKeys = (targetEd) => {
      targetEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        const r = latestRef.current;
        const m = targetEd.getModel();
        const p = (m && m.uri && (m.uri.fsPath || m.uri.path)) || r.activeTabPath;
        if (p && m) baselineContentRef.current[p] = m.getValue();
        r.onSaveTab && p && r.onSaveTab(p);
      });
      targetEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => latestRef.current.openCmdK(targetEd));
      targetEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => latestRef.current.onOpenQuickOpen && latestRef.current.onOpenQuickOpen());
      targetEd.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => latestRef.current.onOpenSymbols && latestRef.current.onOpenSymbols(extractSymbolsFromModel(targetEd.getModel())));
      targetEd.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.BracketRight, () => latestRef.current.applyNextEdit && latestRef.current.applyNextEdit());
    };
    bindEditorKeys(ed);

    const dMouse = ed.onMouseDown((ev) => {
      const r = latestRef.current;
      if (ev.target && ev.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && ev.target.position?.lineNumber) {
        r.onToggleBreakpoint && r.activeTabPath && r.onToggleBreakpoint(r.activeTabPath, ev.target.position.lineNumber);
      }
    });

    const dContent = ed.onDidChangeModelContent(() => {
      const r = latestRef.current;
      const m = ed.getModel();
      const targetPath = (m && m.uri && (r.tabs || []).find((t) => monaco.Uri.file(t.path).toString() === m.uri.toString())?.path) || r.activeTabPath;
      const newVal = ed.getValue();
      if (targetPath && r.onChangeTabContent) {
        r.onChangeTabContent(targetPath, newVal);
      }
      if (nextEditTimerRef.current) clearTimeout(nextEditTimerRef.current);
      nextEditTimerRef.current = setTimeout(async () => {
        if (!targetPath || !window.autobot?.idePredictNextEdit) return;
        const oldVal = baselineContentRef.current[targetPath];
        if (!oldVal || oldVal === newVal) { setNextEdit(null); return; }
        const pos = ed.getPosition() || { lineNumber: 1 };
        try {
          const predRes = await window.autobot.idePredictNextEdit({
            filePath: targetPath,
            language: m ? m.getLanguageId() : 'plaintext',
            oldContent: oldVal,
            newContent: newVal,
            editLine: pos.lineNumber,
            provider: r.provider,
            orchestrator: r.orchestrator,
          });
          if (predRes && predRes.ok && predRes.prediction && predRes.prediction.line) {
            setNextEdit({ ...predRes.prediction, path: targetPath });
          } else {
            setNextEdit(null);
          }
        } catch (_) {}
      }, 450);
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
      if (r.onViewStateChange && r.activeTabPath && pos) {
        r.onViewStateChange(r.activeTabPath, {
          line: pos.lineNumber,
          column: pos.column,
          scrollTop: ed.getScrollTop(),
        });
      }
    });
    const dScroll = ed.onDidScrollChange(() => {
      const r = latestRef.current;
      const pos = ed.getPosition();
      if (r.onViewStateChange && r.activeTabPath) {
        r.onViewStateChange(r.activeTabPath, {
          line: pos ? pos.lineNumber : 1,
          column: pos ? pos.column : 1,
          scrollTop: ed.getScrollTop(),
        });
      }
    });

    const dMarkers = monaco.editor.onDidChangeMarkers(() => {
      const r = latestRef.current;
      if (!r.onMarkersChange) return;
      const all = monaco.editor.getModelMarkers({});
      const mapped = all.map((m) => {
        const resUri = m.resource ? m.resource.toString() : '';
        const matchedTab = (r.tabs || []).find((t) => monaco.Uri.file(t.path).toString() === resUri);
        const fsPath = matchedTab ? matchedTab.path : ((m.resource && (m.resource.fsPath || m.resource.path)) || r.activeTabPath || '');
        return {
          file: fsPath,
          relPath: matchedTab ? matchedTab.relPath : ((m.resource && (m.resource.fsPath || m.resource.path)) || '').split(/[\\/]/).pop() || '',
          line: m.startLineNumber,
          col: m.startColumn,
          message: m.message,
          severity: m.severity === monaco.MarkerSeverity.Error ? 'error' : 'warning',
        };
      });
      r.onMarkersChange(mapped);
    });

    return () => {
      if (nextEditTimerRef.current) clearTimeout(nextEditTimerRef.current);
      try { dMouse.dispose(); } catch (_) {}
      try { dContent.dispose(); } catch (_) {}
      try { dCursor.dispose(); } catch (_) {}
      try { dScroll.dispose(); } catch (_) {}
      try { dMarkers.dispose(); } catch (_) {}
      try { ed.dispose(); } catch (_) {}
      debugDecosRef.current = [];
      editorRef.current = null;
    };
  }, [diffMode, hasMonacoHost]);

  // Breakpoint & Debug paused line decorations
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || diffMode || customBody) return;
    const decos = [];
    if (activeTabPath && Array.isArray(breakpoints)) {
      for (const bp of breakpoints) {
        if (bp.file === activeTabPath && bp.line > 0) {
          decos.push({
            range: new monaco.Range(bp.line, 1, bp.line, 1),
            options: { isWholeLine: false, glyphMarginClassName: 'ide-bp-glyph', glyphMarginHoverMessage: { value: 'Breakpoint' } },
          });
        }
      }
    }
    if (pausedDebugLine && pausedDebugLine > 0) {
      decos.push({
        range: new monaco.Range(pausedDebugLine, 1, pausedDebugLine, 1),
        options: { isWholeLine: true, className: 'ide-debug-paused-line' },
      });
    }
    try {
      debugDecosRef.current = ed.deltaDecorations(debugDecosRef.current || [], decos);
    } catch (_) {}
  }, [breakpoints, pausedDebugLine, activeTabPath, diffMode, customBody]);

  // Switch attached per-file Monaco model & restore cursor/scroll ONLY on tab switch
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed || !activeTab) return;
    const model = getOrCreateFileModel(activeTab);
    if (!model) return;
    if (ed.getModel() !== model) {
      ed.setModel(model);
    }
    if (model.getLanguageId() !== (activeTab.language || 'plaintext')) {
      monaco.editor.setModelLanguage(model, activeTab.language || 'plaintext');
    }
    const vs = latestRef.current.viewStates && latestRef.current.viewStates[activeTab.path];
    if (vs) {
      try {
        if (vs.line) ed.setPosition({ lineNumber: vs.line, column: vs.column || 1 });
        if (typeof vs.scrollTop === 'number') ed.setScrollTop(vs.scrollTop);
      } catch (_) {}
    }
  }, [activeTab?.path]);

  // Sync external disk reloads without resetting cursor during normal typing
  useEffect(() => {
    if (!activeTab) return;
    const model = getOrCreateFileModel(activeTab);
    if (!model) return;
    if (model.getLanguageId() !== (activeTab.language || 'plaintext')) {
      monaco.editor.setModelLanguage(model, activeTab.language || 'plaintext');
    }
    if (model.getValue() !== activeTab.content) {
      const ed = editorRef.current;
      const prevSel = ed && ed.getModel() === model ? ed.getSelection() : null;
      model.setValue(activeTab.content || '');
      if (ed && prevSel) {
        try { ed.setSelection(prevSel); } catch (_) {}
      }
    }
  }, [activeTab?.content, activeTab?.language]);

  // Dispose per-file Monaco models when their tabs close
  const openTabsKey = tabs.map((t) => t.path).join('|');
  useEffect(() => {
    const openUris = new Set(tabs.map((t) => monaco.Uri.file(t.path).toString()));
    try {
      for (const m of monaco.editor.getModels()) {
        if (m && m.uri && m.uri.scheme === 'file' && !openUris.has(m.uri.toString())) {
          if (editorRef.current?.getModel() === m || splitEditorRef.current?.getModel() === m) continue;
          try { m.dispose(); } catch (_) {}
        }
      }
    } catch (_) {}
  }, [openTabsKey]);

  useEffect(() => {
    const ed = editorRef.current;
    if (ed) ed.updateOptions({ minimap: { enabled: minimap } });
  }, [minimap]);

  useEffect(() => {
    const typo = normalizeTypography(typography);
    const fontFamily = resolveMonoFontStack(typo);
    const fontSize = typo.monoSize || 13.5;
    const lineHeight = Math.round(fontSize * 1.55);
    const opts = { fontFamily, fontSize, lineHeight, fontLigatures: !!typo.ligatures };
    if (editorRef.current) editorRef.current.updateOptions(opts);
    if (splitEditorRef.current) splitEditorRef.current.updateOptions(opts);
    if (diffEditorRef.current) diffEditorRef.current.updateOptions(opts);
  }, [typography]);

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
    const typo = normalizeTypography(typography);
    const codeFontSize = typo.monoSize || 13.5;
    const sharedModel = getOrCreateFileModel(splitTab);
    const ed = monaco.editor.create(container, {
      model: sharedModel || undefined,
      theme: theme === 'light' ? 'akron-light' : 'akron-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: codeFontSize,
      lineHeight: Math.round(codeFontSize * 1.55),
      fontFamily: resolveMonoFontStack(typo),
      fontLigatures: !!typo.ligatures,
      scrollBeyondLastLine: false,
      readOnly: false,
    });
    splitEditorRef.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const r = latestRef.current;
      r.onSaveTab && splitTab && r.onSaveTab(splitTab.path);
    });
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () => latestRef.current.openCmdK(ed));
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => latestRef.current.onOpenQuickOpen && latestRef.current.onOpenQuickOpen());
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyO, () => latestRef.current.onOpenSymbols && latestRef.current.onOpenSymbols(extractSymbolsFromModel(ed.getModel())));
    const d = ed.onDidChangeModelContent(() => {
      const r = latestRef.current;
      if (r.activeTabPath !== splitTab.path && r.onChangeTabContent) {
        r.onChangeTabContent(splitTab.path, ed.getValue());
      }
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
    const typo = normalizeTypography(typography);
    const codeFontSize = typo.monoSize || 13.5;
    const origModel = monaco.editor.createModel(diffOriginal || '', activeTab.language || 'plaintext');
    const modModel = monaco.editor.createModel(activeTab.content || '', activeTab.language || 'plaintext');
    const ded = monaco.editor.createDiffEditor(container, {
      theme: theme === 'light' ? 'akron-light' : 'akron-dark',
      automaticLayout: true,
      renderSideBySide: true,
      readOnly: false,
      fontSize: codeFontSize,
      lineHeight: Math.round(codeFontSize * 1.55),
      fontFamily: resolveMonoFontStack(typo),
      fontLigatures: !!typo.ligatures,
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

  const navigateHunk = (dir) => {
    const ded = diffEditorRef.current;
    if (!ded || !lineChanges.length) return;
    const nextIdx = (activeHunkIdx + dir + lineChanges.length) % lineChanges.length;
    setActiveHunkIdx(nextIdx);
    const h = lineChanges[nextIdx];
    const line = Math.max(1, h.modifiedStartLineNumber || h.originalStartLineNumber || 1);
    try { ded.getModifiedEditor().revealLineInCenter(line); } catch (_) {}
  };

  const applyHunk = async (hunkIdx, action) => {
    const ded = diffEditorRef.current;
    if (!ded) return;
    const orig = ded.getOriginalEditor().getModel();
    const mod = ded.getModifiedEditor().getModel();
    const changes = ded.getLineChanges() || [];
    const safeIdx = Math.max(0, Math.min(changes.length - 1, hunkIdx));
    const h = changes[safeIdx];
    if (!orig || !mod || !h) return;
    if (action === 'reject') {
      const hasOrig = h.originalEndLineNumber >= h.originalStartLineNumber && h.originalStartLineNumber > 0 && h.originalEndLineNumber > 0;
      const hasMod = h.modifiedEndLineNumber >= h.modifiedStartLineNumber && h.modifiedStartLineNumber > 0 && h.modifiedEndLineNumber > 0;
      const modLines = mod.getLineCount();

      if (!hasOrig && hasMod) {
        // Pure insertion in modified -> delete full modified line block cleanly
        const delRange = h.modifiedEndLineNumber < modLines
          ? new monaco.Range(h.modifiedStartLineNumber, 1, h.modifiedEndLineNumber + 1, 1)
          : h.modifiedStartLineNumber > 1
            ? new monaco.Range(h.modifiedStartLineNumber - 1, mod.getLineMaxColumn(h.modifiedStartLineNumber - 1), h.modifiedEndLineNumber, mod.getLineMaxColumn(h.modifiedEndLineNumber))
            : new monaco.Range(1, 1, h.modifiedEndLineNumber, mod.getLineMaxColumn(h.modifiedEndLineNumber));
        mod.pushEditOperations([], [{ range: delRange, text: '' }], () => null);
      } else if (hasOrig && !hasMod) {
        // Pure deletion in modified -> insert original lines with proper newline
        const origLinesText = orig.getValueInRange(new monaco.Range(h.originalStartLineNumber, 1, h.originalEndLineNumber, orig.getLineMaxColumn(h.originalEndLineNumber)));
        const afterLine = Math.max(0, Math.min(modLines, h.modifiedStartLineNumber));
        if (afterLine === 0 || h.modifiedStartLineNumber <= 1) {
          mod.pushEditOperations([], [{ range: new monaco.Range(1, 1, 1, 1), text: origLinesText + '\n' }], () => null);
        } else {
          const prevCol = mod.getLineMaxColumn(afterLine);
          mod.pushEditOperations([], [{ range: new monaco.Range(afterLine, prevCol, afterLine, prevCol), text: '\n' + origLinesText }], () => null);
        }
      } else if (hasOrig && hasMod) {
        const origText = orig.getValueInRange(new monaco.Range(h.originalStartLineNumber, 1, h.originalEndLineNumber, orig.getLineMaxColumn(h.originalEndLineNumber)));
        const targetRange = new monaco.Range(h.modifiedStartLineNumber, 1, h.modifiedEndLineNumber, mod.getLineMaxColumn(h.modifiedEndLineNumber));
        mod.pushEditOperations([], [{ range: targetRange, text: origText }], () => null);
      }
    } else if (action === 'accept' && activeTab) {
      await onSaveTab(activeTab.path);
      if (cwd && activeTab.relPath) {
        if (window.autobot?.ideGitStagePatch) {
          const oStart = Math.max(1, h.originalStartLineNumber || 1);
          const oCount = h.originalEndLineNumber >= h.originalStartLineNumber && h.originalEndLineNumber > 0 ? (h.originalEndLineNumber - h.originalStartLineNumber + 1) : 0;
          const mStart = Math.max(1, h.modifiedStartLineNumber || 1);
          const mCount = h.modifiedEndLineNumber >= h.modifiedStartLineNumber && h.modifiedEndLineNumber > 0 ? (h.modifiedEndLineNumber - h.modifiedStartLineNumber + 1) : 0;
          const oLines = oCount ? Array.from({ length: oCount }, (_, i) => '-' + orig.getLineContent(oStart + i)) : [];
          const mLines = mCount ? Array.from({ length: mCount }, (_, i) => '+' + mod.getLineContent(mStart + i)) : [];
          const rel = String(activeTab.relPath).replace(/\\/g, '/');
          const patch = [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`, `@@ -${oCount ? oStart : Math.max(0, h.originalStartLineNumber)},${oCount} +${mCount ? mStart : Math.max(0, h.modifiedStartLineNumber)},${mCount} @@`, ...oLines, ...mLines, ''].join('\n');
          await window.autobot.ideGitStagePatch({ cwd, patch }).catch(async () => {
            if (window.autobot?.ideGitStage) await window.autobot.ideGitStage({ cwd, files: [activeTab.relPath] });
          });
        } else if (window.autobot?.ideGitStage) {
          await window.autobot.ideGitStage({ cwd, files: [activeTab.relPath] });
        }
      }
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
          <button
            type="button"
            className="ide-command-center"
            title={`Command Center (${sc.quickOpen} files, > commands, @ symbols)`}
            onClick={() => (onOpenCommandCenter ? onOpenCommandCenter() : (onOpenQuickOpen && onOpenQuickOpen()))}
          >
            <Icon name="Search" size={11} />
            <span>Search ({sc.quickOpen}), &gt; cmd, @ sym</span>
          </button>
          <button type="button" className="ide-mini-action" title={`Quick Open (${sc.quickOpen})`} onClick={() => onOpenQuickOpen && onOpenQuickOpen()}>
            {sc.quickOpen}
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
            <Icon name="ListBullet" size={13} />
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
              title={`Open Inline Edit (${sc.inlineEdit})`}
              onClick={() => openCmdK(editorRef.current)}
            >
              {sc.inlineEdit}
            </button>
          )}
          {activeTab && activeTab.dirty && (
            <button type="button" className="ide-primary-btn" onClick={() => onSaveTab && onSaveTab(activeTab.path)}>
              Save {sc.save}
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
              <span className="ide-diff-label">
                {diffTitle || 'Diff'} ({lineChanges.length ? `${Math.min(activeHunkIdx + 1, lineChanges.length)}/${lineChanges.length}` : '0 hunks'})
              </span>
              {lineChanges.length > 0 && (
                <>
                  <button type="button" className="ide-mini-action" onClick={() => navigateHunk(-1)} title="Previous Hunk">↑</button>
                  <button type="button" className="ide-mini-action" onClick={() => navigateHunk(1)} title="Next Hunk">↓</button>
                  <button type="button" className="ide-mini-action" onClick={() => applyHunk(activeHunkIdx, 'accept')} title="Accept & save active hunk">Accept Hunk</button>
                  <button type="button" className="ide-mini-action" onClick={() => applyHunk(activeHunkIdx, 'reject')} title="Reject active hunk">Reject Hunk</button>
                </>
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
              <p>Select a file from the Explorer or press <kbd>{sc.quickOpen}</kbd> to Quick Open.</p>
              <div className="ide-welcome-shortcuts">
                <span><kbd>{sc.inlineEdit}</kbd> Inline AI Edit</span>
                <span><kbd>{sc.globalSearch}</kbd> Project Search</span>
                <span><kbd>{sc.goToSymbol}</kbd> Go to Symbol</span>
                <span><kbd>{sc.toggleTerminal}</kbd> Toggle Terminal</span>
              </div>
            </div>
          </div>
        ) : diffMode ? (
          <div ref={diffContainerRef} className="ide-monaco-host" />
        ) : customBody ? (
          customBody
        ) : (
          <div className={'ide-monaco-split' + (splitTab ? ' dual' : '')}>
            <div ref={editorContainerRef} className="ide-monaco-host" />
            {splitTab && <div ref={splitContainerRef} className="ide-monaco-host ide-split-second" />}
          </div>
        )}
        {nextEdit && !diffMode && !customBody && nextEdit.path === activeTabPath && (
          <div className="ide-next-edit-pill" data-testid="ide-next-edit-pill">
            <span>Next Edit @ L{nextEdit.line}: <code>{nextEdit.reason || 'Update reference'}</code></span>
            <button type="button" className="ide-primary-btn" onClick={applyNextEdit}>Jump &amp; Apply (Alt+])</button>
            <button type="button" className="ide-mini-action" onClick={() => setNextEdit(null)}>×</button>
          </div>
        )}
      </div>
    </div>
  );
}
