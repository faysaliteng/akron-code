import React, { useState, useEffect, useRef } from 'react';

export function IdeStatusBar({
  cwd,
  envState,
  onOpenEnvironments,
  gitStatus,
  onRefreshGit,
  onNotify,
  problems = [],
  onOpenProblems,
  activeTab,
  cursorCtx,
  onToggleEol,
  ghostEnabled,
  onToggleGhost,
  modelLabel = '',
  contextPct = null,
  onOpenProviders,
  Icon,
}) {
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [branches, setBranches] = useState([]);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!branchMenuOpen) return undefined;
    const onDocClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setBranchMenuOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [branchMenuOpen]);

  const activeEnv = (envState && envState.active) || { kind: 'local', label: 'This Computer' };
  const envLabel = activeEnv.kind === 'ssh'
    ? `SSH: ${activeEnv.label || activeEnv.id || 'host'}`
    : activeEnv.kind === 'remote'
      ? `Remote: ${activeEnv.label || 'server'}`
      : 'Local';

  const errCount = problems.filter((p) => p.severity === 'error').length;
  const warnCount = problems.filter((p) => p.severity !== 'error').length;
  const eol = activeTab && /\r\n/.test(activeTab.content || '') ? 'CRLF' : 'LF';
  const line = (cursorCtx && activeTab && cursorCtx.file === activeTab.path && cursorCtx.line) || 1;
  const col = (cursorCtx && activeTab && cursorCtx.file === activeTab.path && cursorCtx.column) || 1;

  const toggleBranchMenu = async () => {
    if (branchMenuOpen) {
      setBranchMenuOpen(false);
      return;
    }
    setBranchMenuOpen(true);
    if (cwd && window.autobot?.ideGitBranches) {
      try {
        const res = await window.autobot.ideGitBranches({ cwd });
        if (res && res.ok) setBranches(res.branches || []);
      } catch (_) {}
    }
  };

  const checkoutBranch = async (b) => {
    setBranchMenuOpen(false);
    if (!cwd || !b || !window.autobot?.ideGitCheckout) return;
    const r = await window.autobot.ideGitCheckout({ cwd, branch: b });
    if (r && r.ok) {
      onRefreshGit && onRefreshGit();
      onNotify && onNotify(`✅ Switched branch to ${b}`);
    } else {
      onNotify && onNotify('❌ Checkout failed: ' + (r?.error || 'unknown'));
    }
  };

  return (
    <footer className="ide-status-bar" role="status" aria-label="IDE Status Bar">
      <div className="ide-sb-left">
        <button
          type="button"
          className={'ide-sb-item ide-sb-env' + (activeEnv.kind !== 'local' ? ' remote' : '')}
          title="Switch Execution Environment (This Computer / SSH Host / Remote Server)"
          onClick={onOpenEnvironments}
        >
          <span className="ide-sb-dot" />
          <span>{envLabel}</span>
        </button>

        {gitStatus && gitStatus.isRepo && (
          <div className="ide-sb-branch-wrap" ref={menuRef}>
            <button
              type="button"
              className="ide-sb-item"
              title="Switch Git branch or worktree"
              onClick={toggleBranchMenu}
            >
              <Icon name="GitBranch" size={11} />
              <span>{gitStatus.branch || 'HEAD'}</span>
            </button>
            {branchMenuOpen && (
              <div className="ide-sb-popover">
                <div className="ide-sb-pop-head">Branches</div>
                <div className="ide-sb-pop-list">
                  {branches.length === 0 ? (
                    <div className="ide-sb-pop-empty">No local branches</div>
                  ) : branches.map((b) => {
                    const name = typeof b === 'string' ? b : b.name;
                    const cur = (typeof b === 'object' && b.current) || name === gitStatus.branch;
                    return (
                      <button
                        key={name}
                        type="button"
                        className={'ide-sb-pop-row' + (cur ? ' on' : '')}
                        onClick={() => checkoutBranch(name)}
                      >
                        <span>{cur ? '✓ ' : ''}{name}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className={'ide-sb-item' + (errCount > 0 ? ' has-err' : '')}
          title="Toggle Problems Drawer"
          onClick={onOpenProblems}
        >
          <span>⊗ {errCount}</span>
          <span>⚠ {warnCount}</span>
        </button>
      </div>

      <div className="ide-sb-right">
        {activeTab && (
          <>
            <span className="ide-sb-item static" title="Cursor Position">
              Ln {line}, Col {col}
            </span>
            <span className="ide-sb-item static">UTF-8</span>
            <button
              type="button"
              className="ide-sb-item"
              title={`Line Ending: ${eol} (click to switch to ${eol === 'LF' ? 'CRLF' : 'LF'})`}
              onClick={onToggleEol}
            >
              {eol}
            </button>
            <span className="ide-sb-item static">{activeTab.language || 'plaintext'}</span>
          </>
        )}

        <button
          type="button"
          className={'ide-sb-item' + (ghostEnabled ? ' accent' : '')}
          title="Toggle AI Tab Ghost Autocomplete"
          onClick={onToggleGhost}
        >
          Ghost: {ghostEnabled ? 'On' : 'Off'}
        </button>

        {modelLabel && (
          <button
            type="button"
            className="ide-sb-item"
            title="Active AI Model & Context Usage"
            onClick={onOpenProviders}
          >
            <span>{modelLabel}{contextPct != null ? ` · ${contextPct}%` : ''}</span>
          </button>
        )}
      </div>
    </footer>
  );
}
