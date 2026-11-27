import React, { useState, useEffect, useCallback } from 'react';
import { Icon } from '../Icon.jsx';

export function ProjectSettingsPanel({ cwd, projects = [], setProjects, activeProject, setActiveProject, skills = [], mcpServers = [], setNotice }) {
  const [budget, setBudget] = useState(null);
  const [busy, setBusy] = useState(false);

  const loadBudget = useCallback(async () => {
    setBusy(true);
    try {
      if (window.autobot && window.autobot.tokenBudget) {
        const res = await window.autobot.tokenBudget({
          cwd,
          projectRules: (Array.isArray(projects) ? projects : []).map((p) => ({
            id: p.id,
            name: p.name,
            content: p.instructions || '',
            pinned: p.id === activeProject,
          })),
          skills,
          mcpTools: mcpServers.map((s) => ({ name: s.name || s.id, server: s.name || s.id, description: s.command || s.url || '' })),
        });
        setBudget(res);
      }
    } catch (_) {
    } finally {
      setBusy(false);
    }
  }, [cwd, projects, activeProject, skills, mcpServers]);

  useEffect(() => { loadBudget(); }, [loadBudget]);

  const currentProj = (projects || []).find((p) => p.id === activeProject) || null;
  const globalPct = budget && budget.capTokens ? Math.min(100, Math.round((budget.globalTokens / budget.capTokens) * 100)) : 0;
  const projPct = budget && budget.capTokens ? Math.min(100 - globalPct, Math.round((budget.projectTokens / budget.capTokens) * 100)) : 0;

  return (
    <div className="settings-card" data-testid="project-settings-panel">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <h3 style={{ margin: 0 }}><Icon name="Folder" size={14} /> Project Workspace &amp; 20,000-Token Customizations Budget</h3>
        <button type="button" className="btn-mini" disabled={busy} onClick={loadBudget}>
          <Icon name="Refresh" size={12} /> {busy ? 'Analyzing…' : 'Recalculate'}
        </button>
      </div>

      <p className="muted" style={{ marginTop: 6 }}>
        Active directory: <code>{cwd || '(not selected)'}</code>
        {currentProj ? <> · Active profile: <strong>{currentProj.name}</strong></> : null}
      </p>

      {budget && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginTop: 8 }}>
            <span>
              <strong>{budget.activeTokens.toLocaleString()}</strong> / {budget.capTokens.toLocaleString()} active tokens
              {budget.demotedCount > 0 && (
                <span className="token-badge-demoted" style={{ marginLeft: 8 }}>
                  {budget.demotedCount} auto-demoted to @path
                </span>
              )}
            </span>
            <span className="muted" style={{ margin: 0 }}>
              Global: {budget.globalTokens.toLocaleString()} · Project: {budget.projectTokens.toLocaleString()}
            </span>
          </div>

          <div className="token-budget-bar" title={`Global ${globalPct}% · Project ${projPct}%`}>
            <div className="token-budget-seg global" style={{ width: `${globalPct}%` }} />
            <div className="token-budget-seg project" style={{ width: `${projPct}%` }} />
          </div>

          <div className="ct-list" style={{ marginTop: 10 }}>
            {(budget.items || []).map((it) => (
              <div key={it.id} className="ct-row">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span className={'token-badge-scope ' + (it.scope === 'Global' ? 'global' : 'project')}>{it.scope}</span>
                  <span style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.name}</span>
                  {it.demoted && <span className="token-badge-demoted">demoted → {it.mentionRef}</span>}
                </div>
                <span className="muted" style={{ margin: 0, flexShrink: 0 }}>
                  {it.tokens.toLocaleString()} tok{it.demoted ? ' (16 active)' : ''}
                </span>
              </div>
            ))}
            {(!budget.items || budget.items.length === 0) && (
              <div className="muted" style={{ margin: 4 }}>No active customization rules, skills, or MCP schemas yet.</div>
            )}
          </div>
        </div>
      )}

      {currentProj && setProjects && (
        <div style={{ marginTop: 12 }}>
          <label>
            Project Instructions (<code>{currentProj.name}</code>)
            <textarea
              rows={3}
              value={currentProj.instructions || ''}
              onChange={(e) => {
                const val = e.target.value;
                setProjects((list) => (list || []).map((p) => (p.id === currentProj.id ? { ...p, instructions: val } : p)));
              }}
              style={{ width: '100%', marginTop: 5, fontFamily: 'var(--mono)', fontSize: 12, padding: 8, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }}
            />
          </label>
          {setNotice && (
            <button type="button" className="btn-mini primary" style={{ marginTop: 6 }} onClick={() => setNotice(`Saved instructions for ${currentProj.name}`)}>
              Save Project Profile
            </button>
          )}
        </div>
      )}
    </div>
  );
}
