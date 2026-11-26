import React, { useState, useEffect, useCallback } from 'react';

export function GitPanel({
  cwd,
  gitStatus,
  onRefreshGit,
  onOpenDiff,
  onNotify,
  onSwitchWorkspace,
  provider,
  orchestrator,
  Icon,
}) {
  const [commitMsg, setCommitMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [branches, setBranches] = useState([]);
  const [worktrees, setWorktrees] = useState([]);
  const [newBranch, setNewBranch] = useState('');
  const [showBranchAdd, setShowBranchAdd] = useState(false);

  const loadMeta = useCallback(async () => {
    if (!cwd) return;
    try {
      const [br, wt] = await Promise.all([
        window.autobot.ideGitBranches({ cwd }),
        window.autobot.worktreeList(cwd),
      ]);
      if (br && br.branches) setBranches(br.branches);
      if (wt && wt.worktrees) setWorktrees(wt.worktrees);
    } catch (_) {}
  }, [cwd]);

  useEffect(() => { loadMeta(); }, [loadMeta, gitStatus?.branch]);

  if (!gitStatus || !gitStatus.isRepo) {
    return (
      <div className="ide-panel">
        <div className="ide-panel-head"><span className="ide-panel-title">Source Control</span></div>
        <div className="ide-empty-note">Current folder is not a Git repository.</div>
      </div>
    );
  }

  const stage = async (files) => {
    setBusy('stage');
    try {
      await window.autobot.ideGitStage({ cwd, files });
      onRefreshGit && onRefreshGit();
    } finally { setBusy(''); }
  };

  const unstage = async (files) => {
    setBusy('unstage');
    try {
      await window.autobot.ideGitUnstage({ cwd, files });
      onRefreshGit && onRefreshGit();
    } finally { setBusy(''); }
  };

  const discard = async (files) => {
    setBusy('discard');
    try {
      await window.autobot.ideGitDiscard({ cwd, files });
      onRefreshGit && onRefreshGit();
    } finally { setBusy(''); }
  };

  const genCommitMsg = async () => {
    setBusy('ai');
    try {
      const r = await window.autobot.ideGenerateCommitMsg({ cwd, provider, orchestrator });
      if (r && r.ok && r.message) setCommitMsg(r.message);
      else onNotify && onNotify('❌ ' + (r?.error || 'Could not generate commit message'));
    } finally { setBusy(''); }
  };

  const commit = async () => {
    if (!commitMsg.trim()) return;
    setBusy('commit');
    try {
      const r = await window.autobot.ideGitCommit({ cwd, message: commitMsg.trim() });
      if (r && r.ok) {
        setCommitMsg('');
        onNotify && onNotify('✅ Committed changes.');
        onRefreshGit && onRefreshGit();
      } else {
        onNotify && onNotify('❌ ' + (r?.error || 'Commit failed'));
      }
    } finally { setBusy(''); }
  };

  const switchBranch = async (branch, createNew = false) => {
    setBusy('branch');
    try {
      const r = await window.autobot.ideGitCheckout({ cwd, branch, createNew });
      if (r && r.ok) {
        setShowBranchAdd(false);
        setNewBranch('');
        onRefreshGit && onRefreshGit();
        loadMeta();
      } else {
        onNotify && onNotify('❌ ' + (r?.error || 'Checkout failed'));
      }
    } finally { setBusy(''); }
  };

  const staged = gitStatus.staged || [];
  const unstaged = [...(gitStatus.unstaged || []), ...(gitStatus.untracked || [])];

  return (
    <div className="ide-panel">
      <div className="ide-panel-head">
        <span className="ide-panel-title">Source Control</span>
        <div className="ide-panel-actions">
          <button type="button" className="ide-icon-btn" title="New Branch" onClick={() => setShowBranchAdd((v) => !v)}>
            <Icon name="GitBranch" size={13} />
          </button>
          <button type="button" className="ide-icon-btn" title="Refresh Git" onClick={() => { onRefreshGit && onRefreshGit(); loadMeta(); }}>
            <Icon name="Refresh" size={13} />
          </button>
        </div>
      </div>

      <div className="ide-git-bar">
        <select
          className="ide-git-select"
          value={gitStatus.branch || ''}
          onChange={(e) => switchBranch(e.target.value)}
          title="Switch Git branch"
        >
          {branches.map((b) => <option key={b.name} value={b.name}>{b.name}</option>)}
          {!branches.length && <option value={gitStatus.branch}>{gitStatus.branch}</option>}
        </select>
        {worktrees.length > 1 && (
          <select
            className="ide-git-select"
            value={cwd}
            onChange={(e) => onSwitchWorkspace && onSwitchWorkspace(e.target.value)}
            title="Switch Worktree"
          >
            {worktrees.map((w) => <option key={w.path} value={w.path}>{w.branch || w.path.split('/').pop()}</option>)}
          </select>
        )}
      </div>

      {showBranchAdd && (
        <div className="ide-inline-prompt">
          <input
            autoFocus
            value={newBranch}
            placeholder="new-branch-name"
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newBranch.trim()) switchBranch(newBranch.trim(), true);
              if (e.key === 'Escape') setShowBranchAdd(false);
            }}
          />
          <button type="button" onClick={() => newBranch.trim() && switchBranch(newBranch.trim(), true)}>Create</button>
        </div>
      )}

      <div className="ide-git-commit-box">
        <textarea
          rows={2}
          value={commitMsg}
          onChange={(e) => setCommitMsg(e.target.value)}
          placeholder="Commit message…"
        />
        <div className="ide-git-commit-actions">
          <button type="button" className="ide-mini-action" onClick={genCommitMsg} disabled={!!busy} title="Generate commit message with AI">
            {busy === 'ai' ? '…' : '✦ AI Msg'}
          </button>
          <button
            type="button"
            className="ide-primary-btn"
            disabled={!!busy || !commitMsg.trim() || staged.length === 0}
            onClick={commit}
          >
            Commit ({staged.length})
          </button>
        </div>
      </div>

      <div className="ide-tree-scroll">
        <div className="ide-git-section-head">
          <span>Staged Changes ({staged.length})</span>
          {staged.length > 0 && (
            <button type="button" className="ide-mini-action" onClick={() => unstage(staged.map((f) => f.relPath))}>− All</button>
          )}
        </div>
        {staged.map((f) => (
          <div key={'st:' + f.relPath} className="ide-git-row" onClick={() => onOpenDiff && onOpenDiff(f.path, f.relPath)}>
            <span className="ide-git-file" title={f.relPath}>{f.relPath}</span>
            <span className={'ide-git-badge ' + (f.status || 'm').toLowerCase()}>{f.status || 'M'}</span>
            <button type="button" className="ide-row-act" title="Unstage" onClick={(e) => { e.stopPropagation(); unstage([f.relPath]); }}>−</button>
          </div>
        ))}

        <div className="ide-git-section-head">
          <span>Changes ({unstaged.length})</span>
          {unstaged.length > 0 && (
            <button type="button" className="ide-mini-action" onClick={() => stage(unstaged.map((f) => f.relPath))}>+ All</button>
          )}
        </div>
        {unstaged.map((f) => (
          <div key={'un:' + f.relPath} className="ide-git-row" onClick={() => onOpenDiff && onOpenDiff(f.path, f.relPath)}>
            <span className="ide-git-file" title={f.relPath}>{f.relPath}</span>
            <span className={'ide-git-badge ' + (f.status || 'm').toLowerCase()}>{f.status || 'M'}</span>
            <button type="button" className="ide-row-act" title="Discard" onClick={(e) => { e.stopPropagation(); discard([f.relPath]); }}>↺</button>
            <button type="button" className="ide-row-act" title="Stage" onClick={(e) => { e.stopPropagation(); stage([f.relPath]); }}>+</button>
          </div>
        ))}
      </div>
    </div>
  );
}
