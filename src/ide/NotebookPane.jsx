import React, { useState, useEffect, useMemo, useCallback } from 'react';

function safeParseNotebook(raw) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    if (parsed && Array.isArray(parsed.cells)) {
      return {
        nbformat: parsed.nbformat || 4,
        nbformat_minor: parsed.nbformat_minor ?? 5,
        metadata: parsed.metadata && typeof parsed.metadata === 'object' ? parsed.metadata : {},
        cells: parsed.cells.map((c, idx) => ({
          id: c.id || `cell_${idx}`,
          cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
          execution_count: c.execution_count ?? null,
          metadata: c.metadata || {},
          source: Array.isArray(c.source) ? c.source.join('') : String(c.source || ''),
          outputs: Array.isArray(c.outputs) ? c.outputs : [],
        })),
      };
    }
  } catch (_) {}
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [{ id: 'cell_0', cell_type: 'code', execution_count: null, metadata: {}, source: '', outputs: [] }],
  };
}

function serializeNb(nb) {
  return JSON.stringify({
    nbformat: nb.nbformat || 4,
    nbformat_minor: nb.nbformat_minor ?? 5,
    metadata: nb.metadata || {},
    cells: (nb.cells || []).map((c) => {
      const lines = String(c.source || '').split(/(?<=\n)/);
      const base = {
        id: c.id,
        cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
        metadata: c.metadata || {},
        source: lines,
      };
      if (base.cell_type === 'code') {
        base.execution_count = c.execution_count ?? null;
        base.outputs = Array.isArray(c.outputs) ? c.outputs : [];
      }
      return base;
    }),
  }, null, 2);
}

export function NotebookPane({ tab, cwd, onChangeContent, onSaveTab, onNotify, Icon }) {
  const initialNb = useMemo(() => safeParseNotebook(tab?.content), [tab?.path, tab?.savedContent]);
  const [nb, setNb] = useState(initialNb);
  const [kernel, setKernel] = useState(() => {
    const ks = initialNb?.metadata?.kernelspec?.name || initialNb?.metadata?.kernelspec?.language || '';
    return /js|node|javascript/i.test(ks) ? 'javascript' : 'python';
  });
  const [runningCellId, setRunningCellId] = useState(null);
  const [runningAll, setRunningAll] = useState(false);
  const [kernelAlive, setKernelAlive] = useState(false);

  useEffect(() => {
    setNb(safeParseNotebook(tab?.content));
  }, [tab?.path]);

  const refreshStatus = useCallback(async () => {
    if (!tab?.path || !window.autobot?.ideNotebookStatus) return;
    const st = await window.autobot.ideNotebookStatus({ notebookPath: tab.path });
    if (st) {
      const kst = kernel === 'javascript' ? st.javascript : st.python;
      setKernelAlive(Boolean(kst === 'idle' || kst?.alive));
    }
  }, [tab?.path, kernel]);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const commitNb = useCallback((updater) => {
    setNb((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      if (onChangeContent && tab?.path) {
        onChangeContent(tab.path, serializeNb(next));
      }
      return next;
    });
  }, [onChangeContent, tab?.path]);

  const runCell = async (cellId) => {
    const cell = nb.cells.find((c) => c.id === cellId);
    if (!cell || cell.cell_type !== 'code' || !window.autobot?.ideNotebookExec) return;
    setRunningCellId(cellId);
    try {
      const res = await window.autobot.ideNotebookExec({
        notebookPath: tab.path,
        cwd,
        kernel,
        code: cell.source,
      });
      const outputs = [];
      if (res?.stdout) {
        outputs.push({ output_type: 'stream', name: 'stdout', text: [res.stdout] });
      }
      if (res?.stderr) {
        outputs.push({ output_type: 'stream', name: 'stderr', text: [res.stderr] });
      }
      const textPlain = res?.result != null && res?.result !== '' ? res.result : res?.repr;
      if (textPlain != null && textPlain !== '') {
        outputs.push({
          output_type: 'execute_result',
          execution_count: res.executionCount || null,
          data: { 'text/plain': [String(textPlain)] },
          metadata: {},
        });
      }
      if (Array.isArray(res?.images)) {
        for (const imgB64 of res.images) {
          outputs.push({
            output_type: 'display_data',
            data: { 'image/png': imgB64 },
            metadata: {},
          });
        }
      }
      if (res && !res.ok && res.error) {
        outputs.push({
          output_type: 'error',
          ename: 'ExecutionError',
          evalue: String(res.error),
          traceback: [String(res.stderr || res.error)],
        });
      }
      commitNb((prev) => ({
        ...prev,
        cells: prev.cells.map((c) => (
          c.id === cellId
            ? { ...c, execution_count: res?.executionCount ?? c.execution_count, outputs }
            : c
        )),
      }));
      setKernelAlive(true);
    } finally {
      setRunningCellId(null);
      refreshStatus();
    }
  };

  const runAllCells = async () => {
    setRunningAll(true);
    try {
      for (const cell of nb.cells) {
        if (cell.cell_type === 'code') {
          await runCell(cell.id);
        }
      }
    } finally {
      setRunningAll(false);
    }
  };

  const addCell = (type) => {
    const id = `cell_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    commitNb((prev) => ({
      ...prev,
      cells: [...prev.cells, { id, cell_type: type, execution_count: null, metadata: {}, source: '', outputs: [] }],
    }));
  };

  const deleteCell = (cellId) => {
    commitNb((prev) => ({
      ...prev,
      cells: prev.cells.filter((c) => c.id !== cellId),
    }));
  };

  const updateCellSource = (cellId, value) => {
    commitNb((prev) => ({
      ...prev,
      cells: prev.cells.map((c) => (c.id === cellId ? { ...c, source: value } : c)),
    }));
  };

  const handleInterrupt = async () => {
    if (!window.autobot?.ideNotebookInterrupt) return;
    await window.autobot.ideNotebookInterrupt({ notebookPath: tab.path, kernel });
    setRunningCellId(null);
    setRunningAll(false);
    onNotify && onNotify('Kernel interrupted');
  };

  const handleRestart = async () => {
    if (!window.autobot?.ideNotebookRestart) return;
    await window.autobot.ideNotebookRestart({ notebookPath: tab.path, kernel });
    setKernelAlive(false);
    onNotify && onNotify('Kernel restarted');
  };

  return (
    <div className="ide-notebook-root" data-testid="ide-notebook-pane">
      <div className="ide-notebook-toolbar">
        <div className="ide-notebook-left">
          <span className="ide-notebook-title">{tab?.name || 'Notebook.ipynb'}</span>
          <select
            className="ide-notebook-kernel-select"
            value={kernel}
            onChange={(e) => setKernel(e.target.value)}
            aria-label="Notebook Kernel"
          >
            <option value="python">Python 3</option>
            <option value="javascript">JavaScript (Node VM)</option>
          </select>
          <span className={'ide-notebook-dot' + (kernelAlive ? ' live' : '')} title={kernelAlive ? 'Kernel active' : 'Kernel idle'} />
        </div>
        <div className="ide-notebook-actions">
          <button type="button" className="ide-primary-btn" onClick={runAllCells} disabled={runningAll}>
            {runningAll ? 'Running…' : 'Run All'}
          </button>
          <button type="button" className="ide-mini-action" onClick={handleInterrupt}>Interrupt</button>
          <button type="button" className="ide-mini-action" onClick={handleRestart}>Restart Kernel</button>
          <button type="button" className="ide-mini-action" onClick={() => addCell('code')}>+ Code</button>
          <button type="button" className="ide-mini-action" onClick={() => addCell('markdown')}>+ Markdown</button>
          {onSaveTab && tab?.path && (
            <button type="button" className="ide-mini-action accent" onClick={() => onSaveTab(tab.path)}>
              {Icon ? <Icon name="Save" size={12} /> : null} Save
            </button>
          )}
        </div>
      </div>

      <div className="ide-notebook-cells">
        {nb.cells.map((cell, idx) => {
          const isRunning = runningCellId === cell.id;
          return (
            <div key={cell.id || idx} className={'ide-nb-cell ' + cell.cell_type}>
              <div className="ide-nb-cell-head">
                <span className="ide-nb-cell-badge">
                  {cell.cell_type === 'code'
                    ? `[${isRunning ? '*' : (cell.execution_count ?? ' ')}]`
                    : 'MD'}
                </span>
                <div className="ide-nb-cell-tools">
                  {cell.cell_type === 'code' && (
                    <button
                      type="button"
                      className="ide-mini-action accent"
                      onClick={() => runCell(cell.id)}
                      disabled={isRunning}
                    >
                      {isRunning ? 'Running…' : 'Run Cell'}
                    </button>
                  )}
                  <button type="button" className="ide-mini-action" onClick={() => deleteCell(cell.id)} title="Delete cell">
                    ×
                  </button>
                </div>
              </div>
              <textarea
                className="ide-nb-cell-editor"
                rows={Math.max(2, Math.min(18, String(cell.source || '').split('\n').length))}
                value={cell.source}
                placeholder={cell.cell_type === 'markdown' ? '# Markdown note…' : '# Enter code…'}
                onChange={(e) => updateCellSource(cell.id, e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && cell.cell_type === 'code') {
                    e.preventDefault();
                    runCell(cell.id);
                  }
                }}
              />
              {cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > 0 && (
                <div className="ide-nb-cell-outputs">
                  {cell.outputs.map((out, oIdx) => {
                    if (out.output_type === 'display_data' && out.data && out.data['image/png']) {
                      const imgData = Array.isArray(out.data['image/png'])
                        ? out.data['image/png'].join('')
                        : String(out.data['image/png']);
                      return (
                        <img
                          key={oIdx}
                          className="ide-nb-output-img"
                          src={`data:image/png;base64,${imgData.trim()}`}
                          alt={`Cell ${idx + 1} chart`}
                        />
                      );
                    }
                    if (out.output_type === 'error') {
                      const msg = Array.isArray(out.traceback) ? out.traceback.join('\n') : (out.evalue || 'Error');
                      return <pre key={oIdx} className="ide-nb-output-err">{msg}</pre>;
                    }
                    const txt = out.text
                      ? (Array.isArray(out.text) ? out.text.join('') : String(out.text))
                      : (out.data && out.data['text/plain']
                        ? (Array.isArray(out.data['text/plain']) ? out.data['text/plain'].join('') : String(out.data['text/plain']))
                        : '');
                    if (!txt) return null;
                    return (
                      <pre key={oIdx} className={'ide-nb-output-pre' + (out.name === 'stderr' ? ' stderr' : '')}>
                        {txt}
                      </pre>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
