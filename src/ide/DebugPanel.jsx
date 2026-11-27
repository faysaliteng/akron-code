import React, { useState } from 'react';

export function DebugPanel({
  cwd,
  activeTab,
  breakpoints = [],
  debugState,
  onStartDebug,
  onCommand,
  onJumpToLocation,
  onToggleBreakpoint,
  onAddWatch,
  onRemoveWatch,
  watchExpressions = [],
}) {
  const [watchInput, setWatchInput] = useState('');
  const [scriptArgs, setScriptArgs] = useState('');
  const active = Boolean(debugState?.active);
  const paused = Boolean(debugState?.paused);
  const targetFile = (debugState?.filePath || activeTab?.path || '');

  return (
    <div className="ide-debug-root" data-testid="ide-debug-panel">
      <div className="ide-debug-toolbar">
        {!active ? (
          <>
            <button
              type="button"
              className="ide-primary-btn"
              disabled={!activeTab?.path}
              onClick={() => onStartDebug && onStartDebug(activeTab.path, scriptArgs)}
            >
              Start Debug
            </button>
            <input
              type="text"
              className="ide-debug-args-in"
              value={scriptArgs}
              onChange={(e) => setScriptArgs(e.target.value)}
              placeholder="Optional args (e.g. --port 3000)"
            />
            <span className="ide-debug-target">
              {activeTab?.name ? `Target: ${activeTab.name}` : 'Open a .js or .py file to debug'}
            </span>
          </>
        ) : (
          <>
            <button type="button" className="ide-primary-btn" disabled={!paused} onClick={() => onCommand('continue')}>Continue</button>
            <button type="button" className="ide-mini-action" disabled={!paused} onClick={() => onCommand('stepOver')}>Step Over</button>
            <button type="button" className="ide-mini-action" disabled={!paused} onClick={() => onCommand('stepInto')}>Step Into</button>
            <button type="button" className="ide-mini-action" disabled={!paused} onClick={() => onCommand('stepOut')}>Step Out</button>
            <button type="button" className="ide-mini-action" onClick={() => onCommand('stop')}>Stop</button>
            <span className="ide-debug-target">
              {debugState.adapter === 'python' ? 'pdb' : 'node-cdp'} · {paused ? `Paused @ L${debugState.pausedLine || '?'}` : 'Running'}
              {targetFile ? ` (${targetFile.split(/[\\/]/).pop()})` : ''}
            </span>
          </>
        )}
      </div>

      <div className="ide-debug-grid">
        <div className="ide-debug-col">
          <div className="ide-debug-col-title">Call Stack</div>
          <div className="ide-debug-list">
            {(debugState?.callStack || []).length === 0 ? (
              <div className="ide-debug-empty">{paused ? 'No frames reported' : 'Not paused'}</div>
            ) : (
              (debugState.callStack || []).map((f, i) => (
                <button
                  key={f.callFrameId || i}
                  type="button"
                  className="ide-debug-row"
                  onClick={() => onJumpToLocation && f.file && onJumpToLocation(f.file, f.line)}
                >
                  <span className="ide-debug-sym">{f.functionName || '(anonymous)'}</span>
                  <span className="ide-debug-loc">{(f.file || '').split(/[\\/]/).pop()}:{f.line}</span>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="ide-debug-col">
          <div className="ide-debug-col-title">Variables</div>
          <div className="ide-debug-list">
            {(debugState?.locals || []).length === 0 ? (
              <div className="ide-debug-empty">No locals captured</div>
            ) : (
              (debugState.locals || []).map((v, i) => (
                <div key={v.name + i} className="ide-debug-kv">
                  <span className="ide-debug-k">{v.name}</span>
                  <span className="ide-debug-v">{String(v.value)}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="ide-debug-col">
          <div className="ide-debug-col-title">Watch &amp; Breakpoints ({breakpoints.length})</div>
          <form
            className="ide-debug-watch-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!watchInput.trim()) return;
              onAddWatch && onAddWatch(watchInput.trim());
              setWatchInput('');
            }}
          >
            <input
              type="text"
              value={watchInput}
              onChange={(e) => setWatchInput(e.target.value)}
              placeholder="+ Watch expression"
            />
          </form>
          <div className="ide-debug-list">
            {watchExpressions.map((expr) => {
              const found = (debugState?.watches || []).find((w) => w.expression === expr);
              return (
                <div key={expr} className="ide-debug-kv">
                  <span className="ide-debug-k">{expr}</span>
                  <span className="ide-debug-v">{found ? String(found.value) : '—'}</span>
                  <button type="button" className="ide-debug-x" onClick={() => onRemoveWatch && onRemoveWatch(expr)}>×</button>
                </div>
              );
            })}
            {breakpoints.map((bp) => (
              <div key={`${bp.file}:${bp.line}`} className="ide-debug-kv">
                <button
                  type="button"
                  className="ide-debug-k btn"
                  onClick={() => onJumpToLocation && onJumpToLocation(bp.file, bp.line)}
                >
                  ● {bp.file.split(/[\\/]/).pop()}:{bp.line}
                </button>
                <button type="button" className="ide-debug-x" onClick={() => onToggleBreakpoint && onToggleBreakpoint(bp.file, bp.line)}>×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="ide-debug-col">
          <div className="ide-debug-col-title">Debug Console</div>
          <pre className="ide-debug-console">
            {(debugState?.logs || []).join('\n') || (cwd ? `Ready in ${cwd}` : 'Ready')}
          </pre>
        </div>
      </div>
    </div>
  );
}
