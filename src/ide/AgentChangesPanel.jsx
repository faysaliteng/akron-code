import React, { useMemo, useState } from 'react';

export function AgentChangesPanel({
  cwd,
  gitStatus,
  tabs = [],
  onOpenDiff,
  onSaveTab,
  onReloadFile,
  onRefreshGit,
  onNotify,
  Icon,
}) {
  const [busy, setBusy] = useState(false);

  const items = useMemo(() => {
    const map = new Map();
    const sep = cwd && cwd.includes('\\') ? '\\' : '/';
    const base = String(cwd || '').replace(/[\\/]+$/, '');
    const toAbs = (rel) => {
      if (!rel) return base;
      if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return rel;
      return base ? `${base}${sep}${rel.replace(/[\\/]+/g, sep)}` : rel;
    };

    if (gitStatus && gitStatus.isRepo) {
      for (const f of gitStatus.staged || []) {
        map.set(f.relPath, { relPath: f.relPath, path: f.path || toAbs(f.relPath), status: f.status || 'M', staged: true, untracked: false, dirty: false });
      }
      for (const f of gitStatus.unstaged || []) {
        const prev = map.get(f.relPath);
        map.set(f.relPath, { relPath: f.relPath, path: f.path || toAbs(f.relPath), status: f.status || 'M', staged: !!(prev && prev.staged), untracked: false, dirty: false });
      }
      for (const f of gitStatus.untracked || []) {
        if (!map.has(f.relPath)) {
          map.set(f.relPath, { relPath: f.relPath, path: f.path || toAbs(f.relPath), status: 'U', staged: false, untracked: true, dirty: false });
        }
      }
    }

    for (const t of tabs) {
      if (!t.dirty) continue;
      const key = t.relPath || t.path;
      const prev = map.get(key);
      map.set(key, {
        relPath: t.relPath || t.name,
        path: t.path,
        status: prev ? prev.status : 'M',
        staged: !!(prev && prev.staged),
        untracked: !!(prev && prev.untracked),
        dirty: true,
      });
    }

    return [...map.values()];
  }, [cwd, gitStatus, tabs]);

  const keepFile = async (it) => {
    setBusy(true);
    try {
      if (it.dirty && onSaveTab) await onSaveTab(it.path);
      if (gitStatus?.isRepo && window.autobot?.ideGitStage) {
        await window.autobot.ideGitStage({ cwd, files: [it.relPath] });
      }
      onRefreshGit && onRefreshGit();
    } finally {
      setBusy(false);
    }
  };

  const undoFile = async (it) => {
    setBusy(true);
    try {
      if (it.untracked && window.autobot?.ideDeleteEntry) {
        await window.autobot.ideDeleteEntry({ path: it.path });
      } else if (gitStatus?.isRepo && window.autobot?.ideGitDiscard) {
        if (it.staged && window.autobot?.ideGitUnstage) {
          await window.autobot.ideGitUnstage({ cwd, files: [it.relPath] });
        }
        await window.autobot.ideGitDiscard({ cwd, files: [it.relPath] });
      }
      if (onReloadFile) await onReloadFile(it.path);
      onRefreshGit && onRefreshGit();
      onNotify && onNotify(`Reverted ${it.relPath}`);
    } finally {
      setBusy(false);
    }
  };

  const keepAll = async () => {
    if (!items.length) return;
    setBusy(true);
    try {
      for (const t of tabs) {
        if (t.dirty && onSaveTab) await onSaveTab(t.path);
      }
      if (gitStatus?.isRepo && window.autobot?.ideGitStage) {
        await window.autobot.ideGitStage({ cwd, files: items.map((i) => i.relPath) });
      }
      onRefreshGit && onRefreshGit();
      onNotify && onNotify(`✅ Kept & staged ${items.length} file(s).`);
    } finally {
      setBusy(false);
    }
  };

  const undoAll = async () => {
    if (!items.length) return;
    setBusy(true);
    try {
      const tracked = items.filter((i) => !i.untracked).map((i) => i.relPath);
      const untracked = items.filter((i) => i.untracked);
      if (gitStatus?.isRepo && tracked.length) {
        await window.autobot?.ideGitUnstage?.({ cwd, files: tracked });
        await window.autobot?.ideGitDiscard?.({ cwd, files: tracked });
      }
      for (const u of untracked) {
        await window.autobot?.ideDeleteEntry?.({ path: u.path });
      }
      for (const it of items) {
        if (onReloadFile) await onReloadFile(it.path);
      }
      onRefreshGit && onRefreshGit();
      onNotify && onNotify(`Undid ${items.length} file change(s).`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ide-panel ide-changes-panel">
      <div className="ide-panel-head">
        <span className="ide-panel-title">Agent Changes ({items.length})</span>
        <div className="ide-panel-actions">
          <button type="button" className="ide-icon-btn" title="Refresh Changes" onClick={onRefreshGit} disabled={busy}>
            <Icon name="Refresh" size={13} />
          </button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="ide-changes-bulk">
          <button type="button" className="ide-primary-btn" onClick={keepAll} disabled={busy}>
            Keep All
          </button>
          <button type="button" className="ide-mini-action" onClick={undoAll} disabled={busy}>
            Undo All
          </button>
        </div>
      )}

      <div className="ide-tree-scroll">
        {items.length === 0 ? (
          <div className="ide-empty-note">No pending workspace or agent file changes.</div>
        ) : items.map((it) => (
          <div key={it.relPath} className="ide-change-row" onClick={() => onOpenDiff && onOpenDiff(it.path, it.relPath)}>
            <span className={'ide-git-badge ' + (it.status || 'm').toLowerCase()}>{it.status}</span>
            <span className="ide-change-name" title={it.relPath}>{it.relPath}{it.dirty ? ' ●' : ''}</span>
            <div className="ide-change-btns" onClick={(e) => e.stopPropagation()}>
              <button type="button" className="ide-mini-action" title="Accept / Keep file" onClick={() => keepFile(it)} disabled={busy}>Keep</button>
              <button type="button" className="ide-mini-action" title="Undo / Discard file" onClick={() => undoFile(it)} disabled={busy}>Undo</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
