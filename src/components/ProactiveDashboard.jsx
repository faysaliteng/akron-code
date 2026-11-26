import React, { useState, useEffect, useCallback } from 'react';

export function ProactiveDashboard({
  cwd,
  convs = [],
  onScheduledCreated,
  onSendToChat,
  Icon,
}) {
  const [state, setState] = useState({ matters: [], quietHours: { enabled: false, start: '22:00', end: '08:00' } });
  const [suggestions, setSuggestions] = useState([]);
  const [briefOut, setBriefOut] = useState(null);
  const [busy, setBusy] = useState('');

  const refresh = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.proactiveState) {
        const st = await window.autobot.proactiveState();
        if (st && Array.isArray(st.matters)) setState(st);
      }
      if (window.autobot && window.autobot.proactiveSuggest) {
        const sug = await window.autobot.proactiveSuggest({ convs });
        if (Array.isArray(sug)) setSuggestions(sug);
      }
    } catch (_) {}
  }, [convs]);

  useEffect(() => { refresh(); }, [refresh]);

  const runBrief = async (kind) => {
    if (!window.autobot || !window.autobot.proactiveBrief) return;
    setBusy(kind);
    try {
      const res = await window.autobot.proactiveBrief({ kind, cwd });
      if (res && res.ok) setBriefOut(res);
      await refresh();
    } finally {
      setBusy('');
    }
  };

  const act = async (matterKey, action) => {
    if (!window.autobot || !window.autobot.proactiveAction) return;
    await window.autobot.proactiveAction({ matterKey, action });
    await refresh();
  };

  const scheduleSuggestion = async (s) => {
    if (!window.autobot || !window.autobot.createScheduledTask) return;
    const r = await window.autobot.createScheduledTask({
      name: s.name,
      prompt: s.prompt,
      cadence: s.cadence || 'daily',
      time: s.time || '09:00',
    });
    if (r && r.ok !== false && onScheduledCreated) onScheduledCreated();
    await refresh();
  };

  const activeMatters = (state.matters || []).filter((m) => m.status === 'open');

  return (
    <div className="proactive-dash" data-testid="proactive-dashboard">
      <div className="proactive-head">
        <div>
          <h3 style={{ margin: 0, fontSize: 13.5 }}>Proactive Briefs &amp; Tracked Matters</h3>
          <div className="muted" style={{ fontSize: 11.5 }}>
            Attention Gate + SHA-256 Matter Tracking · Quiet Hours {state.quietHours?.enabled ? `${state.quietHours.start}–${state.quietHours.end}` : 'Off'}
          </div>
        </div>
        <div className="proactive-actions">
          <button type="button" className="btn-mini primary" disabled={!!busy} onClick={() => runBrief('morning')}>
            <Icon name="Clock" size={12} /> {busy === 'morning' ? 'Generating…' : 'Morning Dev Brief'}
          </button>
          <button type="button" className="btn-mini" disabled={!!busy} onClick={() => runBrief('retro')}>
            <Icon name="Book" size={12} /> {busy === 'retro' ? 'Generating…' : 'Weekly Engineering Retro'}
          </button>
        </div>
      </div>

      {briefOut && (
        <div className="proactive-brief-box">
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5 }}>{briefOut.markdown}</pre>
          {briefOut.preparedWork && (
            <div className="proactive-prep">
              <span><strong>Prepared work:</strong> {briefOut.preparedWork}</span>
              {onSendToChat && (
                <button type="button" className="btn-mini" onClick={() => onSendToChat(briefOut.preparedWork)}>
                  Run in Chat
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {suggestions.length > 0 && (
        <div className="proactive-sug-wrap">
          <div className="proactive-subhead">Suggested Automations (from repeated workflows)</div>
          <div className="proactive-sug-grid">
            {suggestions.slice(0, 3).map((s) => (
              <div key={s.id} className="proactive-sug-card">
                <div className="proactive-sug-title">{s.name}</div>
                <div className="proactive-sug-meta">{s.occurrences}× repeated · Daily @ {s.time || '09:00'}</div>
                <button type="button" className="btn-mini primary" onClick={() => scheduleSuggestion(s)}>+ Schedule</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {activeMatters.length > 0 && (
        <div className="proactive-matters">
          <div className="proactive-subhead">Open Tracked Matters ({activeMatters.length})</div>
          {activeMatters.map((m) => (
            <div key={m.matterKey} className="proactive-matter-card">
              <div className="proactive-matter-top">
                <strong>{m.title}</strong>
                <div className="duet-badges">
                  <span className={'duet-pill ' + (m.impact === 'high' ? 'adv' : 'neutral')}>{m.impact} impact</span>
                  <span className="duet-pill neutral">{m.evidence} evidence</span>
                </div>
              </div>
              {m.summary && <div className="proactive-matter-sum">{m.summary}</div>}
              {m.preparedWork && <div className="proactive-prep"><strong>Prepared:</strong> {m.preparedWork}</div>}
              <div className="duet-card-actions">
                <button type="button" className="btn-mini" onClick={() => act(m.matterKey, 'handled')}>Handled</button>
                <button type="button" className="btn-mini" onClick={() => act(m.matterKey, 'snooze')}>Snooze 4h</button>
                <button type="button" className="btn-mini" onClick={() => act(m.matterKey, 'dismiss')}>Dismiss</button>
                <button type="button" className={'btn-mini' + (m.feedback === 'useful' ? ' primary' : '')} onClick={() => act(m.matterKey, 'useful')}>Useful</button>
                <button type="button" className={'btn-mini' + (m.feedback === 'not_useful' ? ' primary' : '')} onClick={() => act(m.matterKey, 'not_useful')}>Not Useful</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
