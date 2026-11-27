import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';

export function AgentsMdSection({ cwd, setNotice }) {
  const [scope, setScope] = useState('global');
  const [state, setState] = useState(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const applyLoaded = useCallback((res, activeScope) => {
    if (!res || !res.ok) return;
    setState(res);
    const nextText = activeScope === 'project'
      ? (res.projectExists ? res.projectContent : res.defaultContent || '')
      : (res.globalContent || res.defaultContent || '');
    setDraft(nextText);
    setDirty(false);
  }, []);

  const load = useCallback(async (targetScope = scope) => {
    if (!window.autobot || !window.autobot.agentsMdGet) return;
    setBusy(true);
    try {
      const res = await window.autobot.agentsMdGet(cwd || '');
      applyLoaded(res, targetScope);
    } catch (_) {
    } finally {
      setBusy(false);
    }
  }, [cwd, scope, applyLoaded]);

  useEffect(() => {
    load(scope);
  }, [cwd]); // eslint-disable-line react-hooks/exhaustive-deps

  const switchScope = (nextScope) => {
    if (nextScope === scope) return;
    setScope(nextScope);
    setStatusMsg('');
    if (state) applyLoaded(state, nextScope);
    else load(nextScope);
  };

  const handleSave = async () => {
    if (!window.autobot || !window.autobot.agentsMdSave) return;
    setBusy(true);
    setStatusMsg('');
    try {
      const res = await window.autobot.agentsMdSave({ scope, cwd: cwd || '', content: draft });
      if (res && res.ok) {
        applyLoaded(res, scope);
        const msg = `Saved ${scope === 'project' ? 'workspace' : 'global'} AGENTS.md`;
        setStatusMsg(msg);
        if (setNotice) setNotice(msg);
      } else {
        setStatusMsg((res && res.error) || 'Failed to save AGENTS.md');
      }
    } finally {
      setBusy(false);
    }
  };

  const handleReset = async () => {
    if (!window.autobot || !window.autobot.agentsMdReset) return;
    setBusy(true);
    setStatusMsg('');
    try {
      const res = await window.autobot.agentsMdReset({ scope, cwd: cwd || '' });
      if (res && res.ok) {
        applyLoaded(res, scope);
        const msg = `Reset ${scope === 'project' ? 'workspace' : 'global'} AGENTS.md to default`;
        setStatusMsg(msg);
        if (setNotice) setNotice(msg);
      } else {
        setStatusMsg((res && res.error) || 'Failed to reset AGENTS.md');
      }
    } finally {
      setBusy(false);
    }
  };

  const activePath = scope === 'project'
    ? (state && state.projectPath ? state.projectPath : (cwd ? `${cwd}/AGENTS.md` : 'No workspace open'))
    : (state && state.globalPath ? state.globalPath : '~/.autobot/AGENTS.md');
  const linesCount = draft ? draft.split(/\r?\n/).length : 0;
  const approxTokens = Math.ceil((draft || '').length / 4);

  return (
    <div className="settings-card" data-testid="agents-md-section">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}><Icon name="File" size={14} /> Standing Agent Instructions (<code>AGENTS.md</code>)</h3>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            className={'btn-mini' + (scope === 'global' ? ' primary' : '')}
            data-testid="agents-md-scope-global"
            onClick={() => switchScope('global')}
          >
            Global (All Sessions)
          </button>
          <button
            type="button"
            className={'btn-mini' + (scope === 'project' ? ' primary' : '')}
            data-testid="agents-md-scope-project"
            disabled={!cwd}
            title={cwd ? `Edit ${cwd}/AGENTS.md` : 'Open a workspace folder first'}
            onClick={() => switchScope('project')}
          >
            Workspace
          </button>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 6 }}>
        Automatically injected into agent system context every session alongside <code>CLAUDE.md</code>. Edit your default standing rules below or restore the built-in template at any time.
      </p>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 6, fontSize: 11.5 }}>
        <code style={{ opacity: 0.85, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{activePath}</code>
        <span className="muted" style={{ margin: 0, flexShrink: 0 }}>
          {linesCount} lines · ~{approxTokens.toLocaleString()} tokens{dirty ? ' · unsaved' : ''}
        </span>
      </div>

      <textarea
        data-testid="agents-md-textarea"
        rows={16}
        value={draft}
        onChange={(e) => { setDraft(e.target.value); setDirty(true); setStatusMsg(''); }}
        spellCheck={false}
        style={{
          width: '100%',
          fontFamily: 'var(--mono)',
          fontSize: 12,
          lineHeight: 1.5,
          padding: 10,
          background: 'var(--bg-000)',
          color: 'var(--text-000)',
          border: '1px solid var(--border-strong)',
          borderRadius: 8,
          resize: 'vertical',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-testid="agents-md-save-btn"
            className="btn-mini primary"
            disabled={busy || (scope === 'project' && !cwd)}
            onClick={handleSave}
          >
            <Icon name="Check" size={12} /> {busy ? 'Saving…' : 'Save AGENTS.md'}
          </button>
          <button
            type="button"
            data-testid="agents-md-reset-btn"
            className="btn-mini"
            disabled={busy || (scope === 'project' && !cwd)}
            onClick={handleReset}
          >
            <Icon name="Refresh" size={12} /> Reset to Default
          </button>
          <button
            type="button"
            className="btn-mini"
            disabled={busy}
            onClick={() => load(scope)}
          >
            Reload from Disk
          </button>
        </div>
        {statusMsg && <span className="muted" style={{ margin: 0, color: '#10b981' }}>{statusMsg}</span>}
      </div>
    </div>
  );
}
