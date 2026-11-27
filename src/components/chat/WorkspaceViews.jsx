import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import { Icon } from '../Icon.jsx';
import ConnectorLogo from '../../ConnectorLogo.jsx';
import { ctxToastState } from '../../ctx-toast.mjs';
import { LiveChecklistCard, LiveToolActivityCard, FilesChangedBar, summarizeChangedFiles } from '../LiveProgress.jsx';
import { CodeReviewPane } from '../CodeReviewPane.jsx';
import { MissionControlPane } from '../MissionControlPane.jsx';
import { ProactiveDashboard } from '../ProactiveDashboard.jsx';
import { ProjectsView, McpView } from '../../features/WorkspacePanels.jsx';
import { IdeWorkbench } from '../../ide/IdeWorkbench.jsx';
import { MindMapView } from '../../ide/MindMapView.jsx';
import { shortcutLabels } from '../../ide/shortcuts';
import {
  renderMarkdown, extractCodeBlocks, cleanErr, contextWindowFor, usedTokens,
  useTicker, fmtElapsed, shortPath, describeTool, Logo, LinkPreviews, useDismiss,
  convToMarkdown, convToHtml, loadJSON, fmtInt, timeGreeting,
} from '../../utils/appHelpers.jsx';

export function RunActivity({ live, thinking, startedAt }) {
  const now = useTicker(Boolean(live), 500);
  const tools = (live && live.tools) || [];
  const segments = (live && live.segments) || [];
  const running = tools.find((t) => t.status === 'running');
  const stTool = live && live.streamingTool;
  // Plan/approval tools are bookkeeping — the banner says "Working 5 steps"
  // forever if we let TodoWrite win. Prefer real work, then the current phase.
  const work = tools.filter((t) => t.name !== 'TodoWrite' && t.name !== 'exitPlanMode');
  const last = running || work[work.length - 1] || null;
  const lastSeg = segments[segments.length - 1];
  let label = 'Thinking';
  let target = '';
  if (running) {
    const d = describeTool(running.name, running.args);
    const verb = (d && d.verb) ? d.verb : (running.name || 'Working');
    label = verb + '…';
    target = (d && d.target) || '';
  } else if (stTool && stTool.name) {
    const d = describeTool(stTool.name, stTool.target ? { path: stTool.target, file_path: stTool.target, query: stTool.target, tool: stTool.target, goal: stTool.target, command: stTool.target } : {});
    const kb = stTool.bytes >= 1024 ? (stTool.bytes / 1024).toFixed(1) + ' KB' : (stTool.bytes ? stTool.bytes + ' B' : '');
    const verb = (d && d.verb) ? d.verb : (stTool.name || 'Working');
    label = verb + '…';
    target = [stTool.target || (d && d.target), kb].filter(Boolean).join(' · ');
  } else if (lastSeg && lastSeg.type === 'text' && live && live.content) {
    label = 'Writing…';
  } else if (last) {
    const d = describeTool(last.name, last.args);
    label = 'Working…';
    target = d.target;
  } else if (thinking) {
    label = 'Thinking…';
    target = String(thinking).replace(/\s+/g, ' ').trim().slice(0, 80);
  } else {
    label = 'Thinking…';
  }
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  return (
    <div className="activity" role="status" aria-live="polite">
      <span className="activity-spin"><Logo size={15} active /></span>
      <span className="activity-text">{label}</span>
      {target ? <span className="activity-target">{target}</span> : null}
      {elapsed ? <span className="activity-time">{fmtElapsed(elapsed)}</span> : null}
    </div>
  );
}

export function ContextMeter({ used, win, size = 44 }) {
  const pct = win > 0 ? Math.max(0, Math.min(100, (used / win) * 100)) : 0;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const tone = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'cool';
  return (
    <span className={'ctx-meter ' + tone} title={fmtInt(used) + ' of ' + fmtInt(win) + ' tokens used'}>
      <svg width={size} height={size} viewBox={'0 0 ' + size + ' ' + size}>
        <circle className="ctx-track" cx={size / 2} cy={size / 2} r={r} strokeWidth="3" fill="none" />
        <circle
          className="ctx-arc" cx={size / 2} cy={size / 2} r={r} strokeWidth="3" fill="none"
          strokeDasharray={dash + ' ' + c} strokeDashoffset="0"
          transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'}
        />
      </svg>
      <span className="ctx-pct">{Math.round(pct)}%</span>
    </span>
  );
}

// ---------- context pressure toast ----------
// The ring in the composer/Environment pane is easy to miss while typing, and
// running out of context mid-turn is the one failure a user cannot retry away.
// This is a small fixed toast at the bottom of the window that appears once the
// last turn's *context* size crosses the warm threshold, for every provider
// (the window comes from the model in the usage record, not from a hardcoded
// table). It never prints provider token-limit wording: it reports pressure and
// offers the same action the Environment pane does.
export function ContextLimitToast({ lastUsage, model, T }) {
  const win = contextWindowFor(model);
  const used = usedTokens(lastUsage);
  // Dismissal is keyed to the tone, so hiding the 70 % warning does not
  // suppress the 90 % one — and a fresh conversation starts clean. The rule
  // lives in ./ctx-toast.mjs so it can be tested without a DOM.
  const [closedTone, setClosedTone] = useState(null);
  const [closedAt, setClosedAt] = useState(0);
  const seenAt = Number(lastUsage && lastUsage.at) || 0;
  const { tone, pct, visible } = ctxToastState({ used, win, closedTone, closedAt, seenAt });
  // Sit *above* the composer, never on top of it. The message box grows with
  // every line typed, so the offset is measured, not guessed: a fixed 18px
  // toast covered the bottom of the input on this very screen.
  const [lift, setLift] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const measure = () => {
      const box = document.querySelector('.composer');
      if (!box) { setLift(0); return; }
      const r = box.getBoundingClientRect();
      // Distance from the composer's top edge to the bottom of the window,
      // plus a 10px breather. 0 when the composer is not laid out yet.
      const next = Math.max(0, Math.round(window.innerHeight - r.top) + 10);
      setLift((cur) => (cur === next ? cur : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const box = document.querySelector('.composer');
    const ro = box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(box);
    return () => {
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
    };
  }, [visible]);
  if (!visible) return null;
  const label = String(model || '').split('/').pop();
  return (
    <div className={'ctx-toast ' + tone} role="status" aria-live="polite" style={lift ? { bottom: lift } : undefined}>
      <span className="ctx-toast-ico"><Icon name={tone === 'hot' ? 'Warning' : 'Info'} size={15} /></span>
      <div className="ctx-toast-main">
        <div className="ctx-toast-title">
          {tone === 'hot'
            ? (T('ctx.hot') || 'Almost out of room in this conversation')
            : (T('ctx.warm') || 'This conversation is getting long')}
        </div>
        <div className="ctx-toast-sub">
          {pct}% of the window used{label ? ' · ' + label : ''}
        </div>
      </div>
      <button
        type="button"
        className="ctx-toast-x"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => { setClosedTone(tone); setClosedAt(seenAt); }}
      ><Icon name="X" size={12} /></button>
    </div>
  );
}

export function EnvPanel({ cwd, setCwd, provider, lastUsage, mcpServers, features, saveFeat, runSlashCommand, onOpenConnectors, T }) {
  const model = (provider && provider.model) || '';
  // The meter measures the turn that just ran, so prefer the model recorded
  // in the usage event over whatever is selected now.
  const win = contextWindowFor((lastUsage && lastUsage.model) || model);
  const used = usedTokens(lastUsage);
  const pct = win > 0 ? Math.round((used / win) * 100) : 0;
  const connected = mcpServers || [];
  const toolCount = connected.reduce((n, s) => n + ((s.tools && s.tools.length) || 0), 0);
  // A server that answered but exposed no tools is the honest "needs
  // reconnecting" signal — we never show a fabricated pending count.
  const idle = connected.filter((s) => !s.tools || s.tools.length === 0);
  const folderName = String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean).pop() || '~';
  const chooseFolder = async () => {
    const d = await window.autobot.pickFolder();
    if (!d) return;
    setCwd(d);
    try {
      const id = loadJSON('autobot:activeId', null);
      if (id) window.autobot.setWorkspace(id, d).catch(() => {});
    } catch (_) { /* workspace sync is best-effort */ }
  };
  return (
    <div className="envpanel">
      <section className="env-sec">
        <div className="env-sec-title">This computer</div>
        <div className="env-card">
          <span className="env-ico"><Icon name="Laptop" size={16} /></span>
          <div className="env-card-main">
            <div className="env-card-title">This computer</div>
            <div className="env-card-sub" title={cwd || '~'}>{folderName}{cwd ? ' · ' + cwd : ''}</div>
          </div>
        </div>
        <button type="button" className="env-action" onClick={chooseFolder}>
          <Icon name="Folder" size={14} /> Choose folder…
        </button>
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Remote Control</div>
        <button
          type="button"
          className={'env-toggle' + (features && features.remoteControl ? ' on' : '')}
          onClick={() => saveFeat({ ...features, remoteControl: !(features && features.remoteControl) })}
          aria-pressed={!!(features && features.remoteControl)}
        >
          <span className="env-toggle-track"><span className="env-toggle-knob" /></span>
          <span className="env-toggle-label">
            {features && features.remoteControl ? 'On — this machine can be driven remotely' : 'Off — local control only'}
          </span>
        </button>
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Context</div>
        <div className="env-card">
          <ContextMeter used={used} win={win} size={46} />
          <div className="env-card-main">
            <div className="env-card-title">{pct}% used</div>
            <div className="env-card-sub">{fmtInt(used)} / {fmtInt(win)} tokens · {model ? model.split('/').pop() : 'no model'}</div>
          </div>
        </div>
        <div className="env-meter"><span className={'env-meter-fill' + (pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : '')} style={{ width: Math.max(1, Math.min(100, pct)) + '%' }} /></div>
        <div className="env-row">
          <button type="button" className="env-action" onClick={() => runSlashCommand('compact')}>
            <Icon name="Frame" size={14} /> Compact now
          </button>
          <button type="button" className="env-action" onClick={() => runSlashCommand('context')}>
            <Icon name="Activity" size={14} /> What is loaded
          </button>
        </div>
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Connectors</div>
        {connected.length === 0 && (
          <div className="env-empty">No connectors attached. Add an MCP server to give the agent more tools.</div>
        )}
        {connected.length > 0 && (
          <div className="env-card-sub env-summary">
            {connected.length} connected · {toolCount} tools{idle.length ? ' · ' + idle.length + ' need attention' : ''}
          </div>
        )}
        {connected.map((s) => (
          <div key={s.serverId} className={'env-conn' + (s.tools && s.tools.length ? '' : ' idle')}>
            <span className="env-conn-dot" />
            <span className="env-conn-name" title={s.url || s.name}>{s.name}</span>
            <span className="env-conn-meta">{(s.tools && s.tools.length) || 0}</span>
          </div>
        ))}
        <button type="button" className="env-action" onClick={onOpenConnectors}>
          <Icon name="Connectors" size={14} /> Manage connectors
        </button>
      </section>

      <section className="env-sec env-sec-last">
        <div className="env-sec-title">Session</div>
        <div className="env-card-sub env-summary">
          {provider ? (provider.label || provider.id || 'provider') : 'no provider'} · tools {provider && provider.supportsTools === false ? 'via text protocol' : 'native'}
        </div>
      </section>
    </div>
  );
}

// ---------- Mission Control (Swarm + Multi-agent dashboard) ----------
const MC_PHASES = [
  { id: 'planning', label: 'Plan' },
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'wakeup', label: 'Coordinate' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

export function renderBoardText(text) {
  const s = String(text || '');
  const parts = s.split(/(@[a-z0-9][a-z0-9_-]*)/gi);
  return parts.map((p, i) => (
    /^@[a-z0-9]/i.test(p) ? <span key={i} className="mc-mention">{p}</span> : p
  ));
}

export function MissionControl({ subAgents, swarmInfo, swarmBoard, inline = false, onOpenSubagents }) {
  const anyActive = Boolean(
    (swarmInfo && swarmInfo.phase !== 'done')
    || (subAgents || []).some((a) => a.status === 'running' || a.status === 'working' || a.status === 'queued' || a.status === 'waiting')
  );
  const [collapsed, setCollapsed] = useState(() => Boolean(inline && !anyActive));
  const [expandedKey, setExpandedKey] = useState(null);
  const [showBoard, setShowBoard] = useState(true);
  const boardEndRef = useRef(null);
  const wasActiveRef = useRef(anyActive);
  useEffect(() => {
    if (inline && wasActiveRef.current && !anyActive) setCollapsed(true);
    wasActiveRef.current = anyActive;
  }, [inline, anyActive]);
  const normSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const now = useTicker(anyActive, 1000);

  useEffect(() => {
    if (showBoard && boardEndRef.current) {
      boardEndRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [swarmBoard && swarmBoard.length, showBoard]);

  const counts = { working: 0, waiting: 0, done: 0, err: 0 };
  for (const a of subAgents || []) {
    if (a.status === 'running' || a.status === 'working') counts.working++;
    else if (a.status === 'waiting') counts.waiting++;
    else if (a.status === 'done') counts.done++;
    else if (a.status === 'error') counts.err++;
  }
  const curPhase = (swarmInfo && swarmInfo.phase) || 'planning';
  const curIdx = MC_PHASES.findIndex((p) => p.id === curPhase);
  const postsCount = (swarmBoard && swarmBoard.length) || 0;

  return (
    <div className={'mc-panel' + (anyActive ? ' active' : '') + (inline ? ' inline' : '')}>
      <button type="button" className="mc-head" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
        <span className="mc-head-ico"><Icon name="Orbit" size={15} /></span>
        <span className="mc-title">{swarmInfo ? 'Swarm Mission Control' : 'Agent Workers'}</span>
        <div className="mc-badges">
          {counts.working > 0 && <span className="mc-pill working">{counts.working} active</span>}
          {counts.waiting > 0 && <span className="mc-pill waiting">{counts.waiting} waiting</span>}
          {counts.done > 0 && <span className="mc-pill done">{counts.done} done</span>}
          {counts.err > 0 && <span className="mc-pill err">{counts.err} err</span>}
          {postsCount > 0 && <span className="mc-pill">{postsCount} board</span>}
        </div>
        {inline && onOpenSubagents && (
          <span
            className="mc-open-pane"
            role="button"
            tabIndex={0}
            title="Open Subagents pane"
            onClick={(e) => { e.stopPropagation(); onOpenSubagents(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenSubagents(); } }}
          >
            Details →
          </span>
        )}
        <Icon name={collapsed ? 'CaretRight' : 'CaretDown'} size={13} className="mc-caret" />
      </button>

      {!collapsed && (
        <div className="mc-body">
          {swarmInfo && (
            <div className="mc-phases">
              {MC_PHASES.map((ph, idx) => {
                const isDone = curPhase === 'done' ? true : idx < curIdx;
                const isActive = curPhase !== 'done' && idx === curIdx;
                return (
                  <div key={ph.id} className={'mc-phase' + (isDone ? ' done' : '') + (isActive ? ' active' : '')}>
                    <span className="mc-phase-dot" />
                    <span className="mc-phase-label">{ph.label}</span>
                    {ph.id === 'wakeup' && swarmInfo.wave > 0 && (
                      <span className="mc-phase-wave">w{swarmInfo.wave}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className={'mc-grid' + (!swarmInfo && (subAgents || []).length <= 1 ? ' single-worker' : '')}>
            {swarmInfo && swarmInfo.supervisor && (
              <div className={'mc-card supervisor ' + (swarmInfo.supervisorState || (curPhase === 'done' ? 'done' : 'running'))}>
                <div className="mc-card-top">
                  <span className={'mc-dot ' + (swarmInfo.supervisorState || (curPhase === 'done' ? 'done' : 'running'))} />
                  <span className="mc-card-name">Supervisor · @supervisor</span>
                  <span className="mc-role planner">planner</span>
                </div>
                <div className="mc-card-meta">
                  {swarmInfo.supervisor.model && <span className="mc-model" title={swarmInfo.supervisor.model}>{swarmInfo.supervisor.model}</span>}
                  <span className="mc-stat">{swarmInfo.supervisorState || curPhase}</span>
                </div>
              </div>
            )}

            {(subAgents || []).map((a) => {
              const p = a.progress || {};
              const expanded = expandedKey === a.key;
              const roleClass = a.jobRole || a.tier || 'coder';
              const elapsedMs = a.ms != null ? a.ms : (a.startedAt ? Math.max(0, now - a.startedAt) : 0);
              const showHandle = a.handle && normSlug(a.handle) !== normSlug(a.name);
              return (
                <button
                  type="button"
                  key={a.key}
                  className={'mc-card ' + a.status + (a.role === 'supervisor' ? ' supervisor' : '')}
                  onClick={() => setExpandedKey(expanded ? null : a.key)}
                >
                  <div className="mc-card-top">
                    <span className={'mc-dot ' + a.status} />
                    <span className="mc-card-name" title={a.name}>
                      {a.name}{showHandle ? ` · @${a.handle}` : ''}
                    </span>
                    <span className={'mc-role ' + roleClass}>{a.jobRole || a.tier || 'worker'}</span>
                  </div>
                  <div className="mc-card-meta">
                    {a.model && <span className="mc-model" title={a.model}>{a.model}</span>}
                    {a.failover && (
                      <span className="mc-failover" title={`Failover ${a.failover.from} → ${a.failover.to}: ${a.failover.reason || ''}`}>
                        ⇣ failover{a.failover.count > 1 ? ' ×' + a.failover.count : ''}
                      </span>
                    )}
                    <span className="mc-stat">
                      {p.tools ? p.tools + 't' : ''}{p.tools && a.posts ? ' · ' : ''}{a.posts ? a.posts + 'p' : ''}
                      {(p.tools || a.posts) && elapsedMs ? ' · ' : ''}
                      {elapsedMs ? Math.round(elapsedMs / 1000) + 's' : ''}
                    </span>
                  </div>
                  {p.currentTool && (a.status === 'running' || a.status === 'working' || a.status === 'waiting') && (
                    <div className="mc-action">
                      <Icon name="Wrench" size={11} />
                      <span>{p.currentTool.name}{p.currentTool.arg ? ' ' + p.currentTool.arg : ''}</span>
                    </div>
                  )}
                  {expanded && (
                    <div className="mc-trace" onClick={(e) => e.stopPropagation()}>
                      {(p.log || []).slice(-12).map((item, idx) => (
                        <div key={idx} className={'mc-trace-item' + (item.isError ? ' err' : '')}>
                          <span className="mc-trace-name">{item.name}</span>
                          <span className="mc-trace-arg">{item.arg}</span>
                        </div>
                      ))}
                      {p.last && <div className="mc-trace-snip">{String(p.last).slice(-280)}</div>}
                      {!(p.log && p.log.length) && !p.last && <div className="muted" style={{ fontSize: 11 }}>Waiting for activity…</div>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {postsCount > 0 && (
            <div className="mc-board">
              <div className="mc-board-head">
                <span><Icon name="Chat" size={12} /> Shared Message Board ({postsCount})</span>
                <button type="button" className="btn-mini" onClick={() => setShowBoard((v) => !v)}>
                  {showBoard ? 'Hide' : 'Show'}
                </button>
              </div>
              {showBoard && (
                <div className="mc-board-feed">
                  {swarmBoard.map((m) => (
                    <div key={m.seq} className="mc-post">
                      <div className="mc-post-meta">
                        <span>#{m.seq}</span>
                        <span className="mc-post-from">@{m.from}</span>
                        {m.to && <span className="mc-post-to">→ @{m.to}</span>}
                        {m.channel && <span className="mc-post-chan">{m.channel}</span>}
                      </div>
                      <div className="mc-post-text">{renderBoardText(m.text)}</div>
                    </div>
                  ))}
                  <div ref={boardEndRef} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Run Log & Checkpoints (Replay Blueprint + Rewind) ----------
export function RunLogPanel({ convId }) {
  const [tab, setTab] = useState('replay'); // 'replay' | 'checkpoints'
  const [turns, setTurns] = useState([]);
  const [turnIdx, setTurnIdx] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);
  const [rewindMsg, setRewindMsg] = useState('');
  useEffect(() => {
    if (!rewindMsg) return undefined;
    const t = setTimeout(() => setRewindMsg((cur) => (cur === rewindMsg ? '' : cur)), 5000);
    return () => clearTimeout(t);
  }, [rewindMsg]);

  const loadLog = useCallback(async () => {
    if (!convId || !window.autobot || !window.autobot.sessionLog) return;
    try {
      const r = await window.autobot.sessionLog(convId, { limit: 30 });
      const list = (r && Array.isArray(r.turns)) ? r.turns.slice().reverse() : [];
      setTurns(list);
      setTurnIdx(0);
      setStep(list[0] && list[0].events ? list[0].events.length : 0);
      setPlaying(false);
    } catch (_) { setTurns([]); }
  }, [convId]);

  const loadCps = useCallback(async () => {
    if (!convId || !window.autobot || !window.autobot.listCheckpoints) return;
    try {
      const list = await window.autobot.listCheckpoints(convId);
      setCheckpoints(Array.isArray(list) ? list.slice().reverse() : []);
    } catch (_) { setCheckpoints([]); }
  }, [convId]);

  useEffect(() => { loadLog(); loadCps(); }, [loadLog, loadCps]);

  const activeTurn = turns[turnIdx] || null;
  const events = (activeTurn && activeTurn.events) || [];
  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => {
      setStep((s) => {
        if (s >= events.length) { setPlaying(false); return s; }
        return s + 1;
      });
    }, 450);
    return () => clearInterval(t);
  }, [playing, events.length]);

  const visible = events.slice(0, Math.max(1, step));
  const doRewind = async (id) => {
    if (!window.autobot || !window.autobot.rewind) return;
    setRewindMsg('');
    try {
      const r = await window.autobot.rewind(convId, id);
      const rest = Array.isArray(r && r.restored) ? r.restored.length : (Number(r && r.restored) || 0);
      const rem = Array.isArray(r && r.removed) ? r.removed.length : (Number(r && r.removed) || 0);
      setRewindMsg(`Rewound: restored ${rest} file${rest === 1 ? '' : 's'}, removed ${rem}.`);
    } catch (e) { setRewindMsg('Rewind failed: ' + String((e && e.message) || e)); }
  };

  return (
    <div className="rl-panel">
      <div className="rl-tabs">
        <button type="button" className={'rl-tab' + (tab === 'replay' ? ' on' : '')} onClick={() => setTab('replay')}>Replay ({turns.length})</button>
        <button type="button" className={'rl-tab' + (tab === 'checkpoints' ? ' on' : '')} onClick={() => { setTab('checkpoints'); loadCps(); }}>Checkpoints ({checkpoints.length})</button>
        <button type="button" className="btn-mini" style={{ marginLeft: 'auto' }} onClick={() => { loadLog(); loadCps(); }}>
          <Icon name="Reload" size={12} /> Refresh
        </button>
      </div>

      {tab === 'replay' && (
        <>
          {turns.length === 0 ? (
            <div className="env-empty">No recorded runs yet for this conversation. Send a prompt to record an event-sourced trace.</div>
          ) : (
            <>
              <div className="rl-controls">
                <select
                  className="rl-select"
                  value={turnIdx}
                  onChange={(e) => {
                    const idx = Number(e.target.value) || 0;
                    setTurnIdx(idx);
                    setPlaying(false);
                    setStep((turns[idx] && turns[idx].events && turns[idx].events.length) || 0);
                  }}
                >
                  {turns.map((t, i) => (
                    <option key={t.turnId || i} value={i}>
                      {t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : 'Turn'} · {t.events.length} events
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-mini" onClick={() => { setPlaying(false); setStep((s) => Math.max(1, s - 1)); }}><Icon name="CaretLeft" size={12} /></button>
                <button type="button" className="btn-mini" onClick={() => { if (step >= events.length) setStep(1); setPlaying((p) => !p); }}>
                  <Icon name={playing ? 'Pause' : 'Play'} size={12} />
                </button>
                <button type="button" className="btn-mini" onClick={() => { setPlaying(false); setStep((s) => Math.min(events.length, s + 1)); }}><Icon name="CaretRight" size={12} /></button>
              </div>
              <div className="rl-scrubber">
                <input type="range" min={1} max={Math.max(1, events.length)} value={Math.min(Math.max(1, step), Math.max(1, events.length))} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} />
                <span className="rl-step-count">{Math.min(step, events.length)} / {events.length}</span>
              </div>
              <div className="rl-timeline">
                {visible.map((ev, i) => (
                  <div key={i} className={'rl-ev' + (i === visible.length - 1 ? ' current' : '')}>
                    <div className="rl-ev-head">
                      <span className="rl-ev-time">+{((Number(ev.t) || 0) / 1000).toFixed(1)}s</span>
                      <span className={'rl-ev-type ' + (ev.type || '')}>{ev.type}</span>
                      {ev.subagent && <span className="mc-role coder">{ev.subagent}</span>}
                      {ev.name && <b>{ev.name}</b>}
                      {ev.phase && <b>{ev.phase}</b>}
                    </div>
                    {(ev.text || ev.reason || ev.message || ev.result || ev.args || ev.from) && (
                      <div className="rl-ev-body">
                        {ev.from ? `${ev.from} → ${ev.to}: ${ev.reason || ''}`
                          : ev.text || ev.message || ev.result || JSON.stringify(ev.args)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'checkpoints' && (
        <div className="rl-cp-list">
          {rewindMsg && (
            <div className="noticebar" style={{ borderRadius: 8, padding: '7px 10px' }}>
              <span className="noticebar-text">{rewindMsg}</span>
              <button type="button" className="noticebar-x" title="Dismiss" aria-label="Dismiss" onClick={() => setRewindMsg('')}><Icon name="X" size={12} /></button>
            </div>
          )}
          {checkpoints.length === 0 ? (
            <div className="env-empty">No file checkpoints recorded yet for this conversation.</div>
          ) : checkpoints.map((cp) => (
            <div key={cp.id} className="rl-cp-card">
              <div className="rl-cp-head">
                <b>{cp.at ? new Date(cp.at).toLocaleString() : cp.id}</b>
                <button type="button" className="btn-mini" onClick={() => doRewind(cp.id)}>
                  <Icon name="ArrowCounterClockwise" size={12} /> Rewind here
                </button>
              </div>
              <div className="rl-cp-files">
                {(cp.files || []).slice(0, 6).map((f, j) => (
                  <span key={j}>{f.existed ? 'restore ' : 'remove '}{String(f.path || '').split('/').slice(-2).join('/')}</span>
                ))}
                {(cp.files || []).length > 6 && <span>+{cp.files.length - 6} more</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SegmentView({ segments, tools, streaming }) {
  const list = segments || [];
  const lastIdx = list.length - 1;
  return list.map((s, i) => {
    if (s.type === 'thinking') {
      const txt = s.text || '';
      if (!txt.trim()) return null;
      return <ThinkBlock key={'seg-th-' + i} text={txt} streaming={streaming && i === lastIdx} />;
    }
    if (s.type === 'tools') {
      const rows = (s.ids || []).map((id) => (tools || []).find((t) => t.id === id)).filter(Boolean);
      if (!rows.length) return null;
      return <div className="tools" key={'seg-t-' + i}><ToolGroup rows={rows} streaming={streaming} /></div>;
    }
    const txt = s.text || '';
    if (!txt.trim()) return null;
    const caret = streaming && i === lastIdx ? '<span class="cursor">▍</span>' : '';
    return <div className={'md' + (streaming ? ' streaming' : '')} key={'seg-m-' + i} dangerouslySetInnerHTML={{ __html: renderMarkdown(txt) + caret }} />;
  });
}

// ---------- Chat view ----------
function ChatViewInner({ MessageComponent, renderLiveSegments, messages, live, thinking, paused, onScrollAway, subAgents, swarmInfo, swarmBoard, planMode, copyBlock, applyBlock, bottomRef, convId, cwd, copyMessage, editMessage, deleteMessage, retryMessage, forkFromMessage, shareFromMessage, conv, exportConv, T, runStartedAt, onToggleEnv, envOpen, onToggleRunLog, runLogOpen, reviewOpen, sessionPaneType, onOpenReview, onTogglePane, onOpenPlugins, onLearnSkill, onRenameConv, onPinConv, onArchiveConv, onSplitConv, onDeleteConv, setError }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [subExpanded, setSubExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const moreRef = useRef(null);
  const overviewRef = useRef(null);
  useDismiss(moreOpen, [moreRef], () => setMoreOpen(false));
  useDismiss(overviewOpen, [overviewRef], () => { setOverviewOpen(false); setSubExpanded(false); });

  const allTools = useMemo(
    () => (messages || []).flatMap((m) => m.tools || []).concat((live && live.tools) || []),
    [messages, live]
  );
  const allCheckpoints = useMemo(
    () => (messages || []).flatMap((m) => m.checkpoints || []).concat((live && live.checkpoints) || []),
    [messages, live]
  );
  const changedSummary = useMemo(() => summarizeChangedFiles(allTools, allCheckpoints), [allTools, allCheckpoints]);
  const wsLeaf = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Akron Code';
  const subCount = (subAgents && subAgents.length) || 0;
  const bgTasksCount = allCheckpoints.length + allTools.filter((t) => t && (t.name === 'Bash' || t.name === 'Task' || t.name === 'Agent' || t.name === 'Swarm' || t.background)).length;

  const turnPrompts = useMemo(() => {
    const out = [];
    let lastUser = '';
    for (const m of messages || []) {
      if (m && m.role === 'user') {
        const line = String(m.content || '').split('\n').find((s) => s.trim()) || '';
        lastUser = line.trim().slice(0, 28);
      }
      out.push(lastUser);
    }
    return out;
  }, [messages]);
  const liveTurnLabel = useMemo(() => {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') {
        const line = String(messages[i].content || '').split('\n').find((s) => s.trim()) || '';
        return line.trim().slice(0, 28);
      }
    }
    return '';
  }, [messages]);

  return (
    <div
      className="chat"
      onClick={(e) => { copyBlock(e); applyBlock(e); }}
      onScroll={(e) => {
        if (!onScrollAway) return;
        const el = e.currentTarget;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        onScrollAway(dist > 140);
      }}
    >
      {planMode && planMode.active && (
        <div className="planmode-banner" title={'The agent is read-only until you approve the plan. Plan file: ' + (planMode.file || 'PLAN.md')}>
          <Icon name="Clipboard" size={13} /> Plan mode · read-only · writes go to {planMode.file || 'PLAN.md'}
        </div>
      )}
      <div className="conv-toolbar">
        {renaming && conv ? (
          <input
            className="conv-rename-in"
            value={renameVal}
            autoFocus
            onChange={(e) => setRenameVal(e.target.value)}
            onBlur={() => { if (onRenameConv && renameVal.trim()) onRenameConv(renameVal.trim()); setRenaming(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { if (onRenameConv && renameVal.trim()) onRenameConv(renameVal.trim()); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <div className="conv-toolbar-title">
            {conv && conv.pinned && <Icon name="Pin" size={13} style={{ marginRight: 5, color: 'var(--accent-text)' }} />}
            <span className="conv-ws-leaf">{wsLeaf}</span>
            <span className="conv-crumb-slash">/</span>
            <span className="conv-title-text">{(conv && conv.title) || 'New Conversation'}</span>
          </div>
        )}
        <div className="conv-toolbar-right">
          {subCount > 0 && (
            <button
              type="button"
              className={'conv-subagents-pill' + (sessionPaneType === 'subagents' ? ' active' : '')}
              title={`${subCount} subagents — open Subagents visualization`}
              onClick={() => onTogglePane && onTogglePane('subagents')}
            >
              <Icon name="GitBranch" size={12} />
              <span>{subCount}</span>
            </button>
          )}

          <div className="conv-pop-wrap" ref={moreRef}>
            <button
              type="button"
              className={'icon-btn conv-env-btn' + (moreOpen ? ' active' : '')}
              title="Conversation actions — Rename, Pin, Archive, Split, Copy, Plugins"
              onClick={(e) => { e.stopPropagation(); setOverviewOpen(false); setMoreOpen((v) => !v); }}
            >
              <Icon name="DotsVertical" size={15} />
            </button>
            {moreOpen && (
              <div className="conv-popover" onClick={(e) => e.stopPropagation()}>
                {conv && (
                  <>
                    <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); setRenameVal(conv.title || ''); setRenaming(true); }}>
                      <Icon name="Edit" size={14} /> <span>Rename</span>
                    </button>
                    <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onPinConv && onPinConv(); }}>
                      <Icon name="Pin" size={14} /> <span>{conv.pinned ? 'Unpin' : 'Pin'}</span>
                    </button>
                    <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onArchiveConv && onArchiveConv(); }}>
                      <Icon name="Bookmark" size={14} /> <span>{conv.archived ? 'Unarchive' : 'Archive'}</span>
                    </button>
                    <div className="conv-pop-sep" />
                  </>
                )}
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onSplitConv && onSplitConv(); }}>
                  <Icon name="ArrowSplitRight" size={14} /> <span>Split</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <button
                  type="button"
                  className="conv-pop-item"
                  onClick={() => {
                    setMoreOpen(false);
                    const payload = conv ? convToMarkdown(conv) : (cwd || '');
                    navigator.clipboard?.writeText(payload).catch(() => {});
                    setError && setError('✅ Copied to clipboard.');
                  }}
                >
                  <Icon name="Copy" size={14} /> <span>Copy</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onOpenPlugins && onOpenPlugins(); }}>
                  <Icon name="Plugin" size={14} /> <span>Plugins</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onLearnSkill && onLearnSkill(); }}>
                  <Icon name="Lightbulb" size={14} /> <span>Learn Skill (/learn)</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onToggleEnv && onToggleEnv(); }}>
                  <Icon name="Settings" size={14} /> <span>Environment</span>
                </button>
                {conv && (
                  <>
                    <div className="conv-pop-sep" />
                    <button type="button" className="conv-pop-item danger" onClick={() => { setMoreOpen(false); onDeleteConv && onDeleteConv(); }}>
                      <Icon name="Trash" size={14} /> <span>Delete</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="conv-pop-wrap" ref={overviewRef}>
            <button
              type="button"
              className={'icon-btn conv-env-btn conv-overview-btn' + (overviewOpen ? ' active' : '')}
              title="Overview — Review, Files, Terminal, Plugins, Subagents, Background Tasks"
              onClick={(e) => { e.stopPropagation(); setMoreOpen(false); setOverviewOpen((v) => !v); }}
            >
              <Icon name="BookText" size={15} />
              {(subCount > 0 || changedSummary.files.length > 0) && (
                <span className="conv-overview-badge">{subCount > 0 ? subCount : changedSummary.files.length}</span>
              )}
            </button>
            {overviewOpen && (
              <div className="conv-popover overview-pop" onClick={(e) => e.stopPropagation()}>
                <div className="conv-pop-head-row">
                  <span>Overview</span>
                  <button type="button" className="icon-btn" onClick={() => { setOverviewOpen(false); onToggleEnv && onToggleEnv(); }} title="Environment">
                    <Icon name="DotsVertical" size={13} />
                  </button>
                </div>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onOpenReview && onOpenReview({ tools: allTools, checkpoints: allCheckpoints, checkpointId: (live && live.checkpointId) || 'latest', turnLabel: liveTurnLabel, scope: 'all' }); }}>
                  <Icon name="File" size={14} /> <span>Review</span>
                  {changedSummary.files.length > 0 && <span className="conv-pop-count">{changedSummary.files.length}</span>}
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('files'); }}>
                  <Icon name="Files" size={14} /> <span>Files</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('terminal'); }}>
                  <Icon name="CommandLine" size={14} /> <span>Terminal</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('mindmap'); }}>
                  <Icon name="Grid" size={14} /> <span>Mind Map</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onOpenPlugins && onOpenPlugins(); }}>
                  <Icon name="Plugin" size={14} /> <span>Plugins</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <div className="conv-pop-sep" />
                <button
                  type="button"
                  className="conv-pop-item"
                  onClick={() => {
                    if (subCount > 0 && !subExpanded) {
                      setSubExpanded(true);
                    } else {
                      setOverviewOpen(false);
                      onTogglePane && onTogglePane('subagents');
                    }
                  }}
                >
                  <span>Subagents</span>
                  <span className="conv-pop-right">
                    <span className="conv-pop-num">{subCount}</span>
                    <Icon name={subExpanded ? 'CaretDown' : 'CaretRight'} size={12} className="conv-pop-chev-inline" />
                  </span>
                </button>
                {subExpanded && (
                  <div className="ov-sub-list">
                    {(subAgents || []).slice(0, 6).map((a) => (
                      <button
                        key={a.key}
                        type="button"
                        className="ov-sub-row"
                        onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('subagents'); }}
                      >
                        <span className={'mc-dot ' + (a.status || 'done')} />
                        <span className="ov-sub-name">{a.name}</span>
                        {a.model && <span className="ov-sub-model">{a.model}</span>}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="ov-sub-open-all"
                      onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('subagents'); }}
                    >
                      Open Subagents Panel ({subCount}) →
                    </button>
                  </div>
                )}
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onToggleRunLog && onToggleRunLog(); }}>
                  <span>Background Tasks</span>
                  <span className="conv-pop-right">
                    <span className="conv-pop-num">{bgTasksCount}</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={'icon-btn conv-env-btn' + (sessionPaneType ? ' active' : '')}
            title={sessionPaneType ? 'Toggle side pane' : 'Open side pane (Review / Subagents / Files)'}
            onClick={() => onTogglePane && onTogglePane()}
          >
            <Icon name="SidebarRight" size={15} />
          </button>
        </div>
      </div>
      {messages.length === 0 && !live && (
        <div className="welcome">
          <Logo size={56} />
          <h1>{timeGreeting()}</h1>
          <p className="muted">{T('welcome.prompt')}</p>
        </div>
      )}
      {MessageComponent && messages.map((m, i) => <MessageComponent key={m.id} m={m} convId={convId} idx={i} turnLabel={turnPrompts[i]} subAgentCount={subCount} taskCount={bgTasksCount} copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage} forkFromMessage={forkFromMessage} shareFromMessage={shareFromMessage} onOpenReview={onOpenReview} onOpenSubagents={() => onTogglePane && onTogglePane('subagents')} onOpenRunLog={onToggleRunLog} />)}
      {Boolean((subAgents && subAgents.length > 0) || swarmInfo) && (
        <MissionControl subAgents={subAgents} swarmInfo={swarmInfo} swarmBoard={swarmBoard} inline onOpenSubagents={() => onTogglePane && onTogglePane('subagents')} />
      )}
      {live && <div className="msg assistant">
        <div className="avatar avatar-assistant"><Logo size={20} /></div>
        <div className="body">
          <RunActivity live={live} thinking={thinking} startedAt={runStartedAt} />
          <LiveChecklistCard tools={live.tools} subAgents={subAgents} swarmInfo={swarmInfo} streamingTool={live.streamingTool} streaming Icon={Icon} />
          {live.segments && live.segments.length > 0 ? (
            <SegmentView segments={live.segments} tools={live.tools} streaming />
          ) : (
            <>
              {live.tools.length > 0 && (
                <div className="tools">
                  <ToolGroup rows={live.tools} streaming />
                </div>
              )}
              {live.content ? <div className="md streaming" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.content) + '<span class="cursor">▍</span>' }} /> : null}
            </>
          )}
          <LiveToolActivityCard tools={live.tools} streamingTool={live.streamingTool} paused={paused} describeTool={describeTool} Icon={Icon} />
          <FilesChangedBar tools={live.tools} checkpoints={live.checkpoints} checkpointId={live.checkpointId} turnLabel={liveTurnLabel} convId={convId} subAgentCount={subCount} taskCount={bgTasksCount} onOpenReview={onOpenReview} onOpenSubagents={() => onTogglePane && onTogglePane('subagents')} onOpenRunLog={onToggleRunLog} streaming Icon={Icon} />
          {live.content === '' && live.tools.length === 0 && !thinking && <span className="cursor">▍</span>}
        </div>
      </div>}
      <div ref={bottomRef} />
    </div>
  );
}

// A run is a sequence of steps: assistant text → tool rows → assistant text …
// Rendering that order (instead of "all tools, then one giant paragraph") is
// what makes a long agent run readable, and keeps separate steps from being
// glued into a single sentence.
// Example's transcript carries the model's reasoning as a collapsible block you
// can peek at, streaming live and folding to one line when done.
export function ThinkBlock({ text, streaming }) {
  const [open, setOpen] = useState(false);
  const body = (text || '').slice(0, 24000);
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 88);
  return (
    <div className={'thinkblock' + (streaming ? ' streaming' : '')}>
      <button className="think-head" onClick={() => setOpen(!open)} title={open ? 'Hide reasoning' : 'Show reasoning'}>
        <Icon name={streaming ? 'Spinner' : 'Sparkles'} size={13} className={streaming ? 'spin think-ico' : 'think-ico'} />
        <span className="think-verb">{streaming ? 'Thinking' : 'Thought'}</span>
        {!open && preview && <span className="think-preview">{preview}</span>}
        <Icon name={open ? 'CaretUp' : 'CaretRight'} size={12} className="think-caret" />
      </button>
      {open && <pre className="think-body">{body}</pre>}
    </div>
  );
}

export function ExportMenu({ conv, exportConv, T }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="export-wrap">
      <button className="icon-btn" title={T('export.share')} onClick={() => setOpen(!open)}>
        <Icon name="Share" size={16} />
      </button>
      {open && (
        <div className="export-menu" onClick={(e) => e.stopPropagation()}>
          <div className="export-menu-head">{T('export.title')}</div>
          <button onClick={() => { setOpen(false); exportConv('html'); }}><Icon name="File" size={14} /> {T('export.html')} <span className="export-hint">{T('export.html.hint')}</span></button>
          <button onClick={() => { setOpen(false); exportConv('md'); }}><Icon name="FileAdd" size={14} /> {T('export.md')}</button>
          <button onClick={() => { setOpen(false); exportConv('json'); }}><Icon name="Code" size={14} /> {T('export.json')}</button>
        </div>
      )}
    </div>
  );
}

// Example renders the agent's todo list as a live checklist; a raw
// "Planning — 5 steps" row made it look like a step *limit*. Show the items.
export function TodoList({ todos }) {
  return (
    <div className="todolist">
      {todos.map((t, i) => {
        const s = (t && (t.status || t.state)) || 'pending';
        const label = (t && (t.content || t.text || t.title || t.activeForm)) || String(t || '');
        return (
          <div className={'todo ' + s} key={i}>
            <span className="todo-mark">{s === 'completed' ? '✓' : s === 'in_progress' ? '▸' : '○'}</span>
            <span className="todo-text">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Change accounting ──────────────────────────────────────────────────────
// Example summarises a run inline — "Ran 6 commands, read and edited
// opencode.json, 1 blocked +2 −2" — instead of dumping a column of tool JSON.
// The counters are derived from the args the model actually sent, so they can
// never drift from what hit disk.
export const BLOCKED_RE = /denied at permission|prompt blocked|blocked by hook|not available to this sub-agent|blocked by pretooluse|needs approval|permission denied|user rejected/i;

export function countLines(s) {
  const t = String(s == null ? '' : s);
  if (!t) return 0;
  return t.split('\n').length;
}

// Per-row line delta. Write replaces the whole file, so every line it emits is
// new. Edit/MultiEdit carry the exact span they replaced — that is what the
// counter measures.
export function toolDelta(t) {
  const a = (t && t.args) || {};
  const name = String((t && t.name) || '');
  if (name === 'Write' && a.content != null) return { added: countLines(a.content), removed: 0 };
  if (name === 'Edit' || name === 'MultiEdit' || name === 'StrReplace') {
    if (Array.isArray(a.edits)) {
      let added = 0;
      let removed = 0;
      for (const e of a.edits) {
        removed += countLines(e && (e.old_string ?? e.old_str));
        added += countLines(e && (e.new_string ?? e.new_str));
      }
      return { added, removed };
    }
    return { removed: countLines(a.old_string ?? a.old_str), added: countLines(a.new_string ?? a.new_str) };
  }
  return { added: 0, removed: 0 };
}

export function isBlockedRow(t) {
  if (!t || t.status !== 'error') return false;
  return BLOCKED_RE.test(String(t.result || ''));
}

// Bucket a tool call into the vocabulary the summary line speaks.
export function groupKind(name) {
  switch (String(name || '')) {
    case 'Bash': return 'command';
    case 'Read': case 'ReadFile': case 'LS': case 'ListDir': case 'ListFiles': return 'file';
    case 'Write': return 'write';
    case 'Edit': case 'MultiEdit': case 'StrReplace': return 'edit';
    case 'Glob': case 'Grep': case 'Search': return 'search';
    case 'WebFetch': case 'WebSearch': case 'browser_open': case 'browser_navigate': return 'page';
    case 'TodoWrite': case 'exitPlanMode': return 'plan';
    case 'Task': return 'agent';
    default: return 'other';
  }
}

export function describeGroup(rows) {
  const counts = new Map();
  const files = [];
  let added = 0;
  let removed = 0;
  let blocked = 0;
  for (const t of rows) {
    const kind = groupKind(t.name);
    counts.set(kind, (counts.get(kind) || 0) + 1);
    const d = toolDelta(t);
    added += d.added;
    removed += d.removed;
    if (isBlockedRow(t)) blocked += 1;
    if (kind === 'file' || kind === 'write' || kind === 'edit') {
      const p = (t.args && (t.args.path || t.args.file_path)) || '';
      const name = String(p).replace(/\\/g, '/').split('/').filter(Boolean).pop();
      if (name && !files.includes(name)) files.push(name);
    }
  }
  const parts = [];
  const n = (k) => counts.get(k) || 0;
  if (n('command')) parts.push('Ran ' + n('command') + (n('command') === 1 ? ' command' : ' commands'));
  if (n('file')) parts.push('read ' + n('file') + (n('file') === 1 ? ' file' : ' files'));
  if (n('write')) parts.push('wrote ' + n('write') + (n('write') === 1 ? ' file' : ' files'));
  if (n('edit')) parts.push('edited ' + n('edit') + (n('edit') === 1 ? ' file' : ' files'));
  if (n('search')) parts.push('searched ' + n('search') + '×');
  if (n('page')) parts.push('fetched ' + n('page') + (n('page') === 1 ? ' page' : ' pages'));
  if (n('agent')) parts.push('ran ' + n('agent') + (n('agent') === 1 ? ' agent' : ' agents'));
  if (n('plan')) parts.push('updated the plan');
  if (n('other')) parts.push(n('other') + (n('other') === 1 ? ' other tool' : ' other tools'));
  let text = parts.join(', ');
  // Name at most two touched files: the point is orientation, not an inventory.
  if (files.length) {
    const shown = files.slice(0, 2).join(', ');
    text += (text ? ' · ' : '') + shown + (files.length > 2 ? ' +' + (files.length - 2) : '');
  }
  if (!text) text = rows.length + (rows.length === 1 ? ' tool call' : ' tool calls');
  return { text, added, removed, blocked };
}

export function DeltaChips({ added, removed }) {
  if (!added && !removed) return null;
  return (
    <span className="delta-chips" title={added + ' line(s) added, ' + removed + ' line(s) removed'}>
      <span className="delta-add">+{added}</span>
      <span className="delta-del">−{removed}</span>
    </span>
  );
}

const clipText = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '\n… ' + (t.length - n) + ' more characters' : t;
};

// An Edit rendered as the change it makes (− old / + new) rather than the JSON
// blob that encodes it. This is the difference between "the agent is working"
// and "I can see what it did".
export function DiffBlock({ oldText, newText, file }) {
  const MAX = 260;
  const del = oldText ? String(oldText).split('\n') : [];
  const add = newText ? String(newText).split('\n') : [];
  return (
    <div className="td-diff">
      {file ? <div className="td-file">{shortPath(file)}</div> : null}
      {del.slice(0, MAX).map((l, i) => (
        <div key={'d' + i} className="td-line del"><span className="td-sign">−</span><span className="td-code">{l || ' '}</span></div>
      ))}
      {add.slice(0, MAX).map((l, i) => (
        <div key={'a' + i} className="td-line add"><span className="td-sign">+</span><span className="td-code">{l || ' '}</span></div>
      ))}
      {(del.length > MAX || add.length > MAX) ? <div className="td-more">truncated for display — full text is in the file</div> : null}
    </div>
  );
}

export function ToolDetail({ t }) {
  const a = t.args || {};
  const name = String(t.name || '');
  const out = t.result != null ? String(t.result) : '';
  const body = [];
  if (name === 'Edit' || name === 'MultiEdit' || name === 'StrReplace') {
    const edits = Array.isArray(a.edits)
      ? a.edits
      : [{ old_string: a.old_string ?? a.old_str, new_string: a.new_string ?? a.new_str }];
    edits.forEach((e, i) => {
      body.push(
        <DiffBlock
          key={'e' + i}
          file={a.path || a.file_path}
          oldText={(e && (e.old_string ?? e.old_str)) ?? ''}
          newText={(e && (e.new_string ?? e.new_str)) ?? ''}
        />
      );
    });
  } else if (name === 'Write') {
    body.push(<DiffBlock key="w" file={a.path || a.file_path} oldText="" newText={a.content ?? ''} />);
  } else if (name === 'Bash') {
    body.push(
      <div key="c" className="td-cmd"><span className="td-prompt">$</span><span className="td-cmd-text">{clipText(a.command || a.cmd || '', 1200)}</span></div>
    );
  } else {
    const kv = Object.entries(a).filter(([, v]) => v != null && v !== '' && typeof v !== 'object');
    if (kv.length) {
      body.push(
        <dl key="kv" className="td-kv">
          {kv.slice(0, 12).map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{clipText(v, 400)}</dd>
            </React.Fragment>
          ))}
        </dl>
      );
    }
  }
  return (
    <div className="tool-detail">
      {body}
      {out ? <pre className="tool-result">{clipText(out, 6000)}</pre> : null}
    </div>
  );
}

function ToolCardInner({ t }) {
  const todos = t.name === 'TodoWrite' && t.args && Array.isArray(t.args.todos) ? t.args.todos : null;
  const [open, setOpen] = useState(Boolean(todos && todos.length));
  const d = describeTool(t.name, t.args);
  const delta = toolDelta(t);
  const blocked = isBlockedRow(t);
  const status = t.status === 'error' ? 'error' : t.status === 'running' ? 'running' : 'done';
  let title = '';
  try { title = JSON.stringify(t.args || {}).slice(0, 400); } catch { title = ''; }
  return (
    <div className={'toolcard ' + status + (blocked ? ' blocked' : '')}>
      <div className="toolcard-head" onClick={() => setOpen(!open)}>
        <span className="tool-ico"><Icon name={d.icon} size={14} /></span>
        <span className="tool-name">{d.verb}</span>
        {d.target ? <span className="tool-args" title={title}>{d.target}</span> : <span className="tool-args" />}
        <DeltaChips added={delta.added} removed={delta.removed} />
        <span className="tool-state">
          {status === 'running' && <Icon name="Spinner" size={13} className="spin" />}
          {status === 'error' && <Icon name="Warning" size={13} />}
          {status === 'done' && <Icon name="Check" size={13} />}
        </span>
        <span className="caret"><Icon name={open ? 'CaretUp' : 'CaretRight'} size={11} /></span>
      </div>
      {open && todos && todos.length > 0 && <TodoList todos={todos} />}
      {open && !(todos && todos.length) && <ToolDetail t={t} />}
    </div>
  );
}

// A run's tool calls collapse into one row you can open. Keeping every row
// expanded turned a 20-step run into a wall of cards and buried the answer.
function ToolGroupInner({ rows, streaming }) {
  const live = rows.some((t) => t.status === 'running');
  const [open, setOpen] = useState(false);
  const info = describeGroup(rows);
  const onlyOne = rows.length === 1;
  // A single call is its own row — no summary header needed.
  if (onlyOne) return <ToolCard t={rows[0]} />;
  return (
    <div className={'toolgroup' + (live ? ' running' : '') + (open ? ' open' : '')}>
      <button type="button" className="toolgroup-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="toolgroup-ico">
          {live ? <Icon name="Spinner" size={13} className="spin" /> : <Icon name="Wrench" size={13} />}
        </span>
        <span className="toolgroup-text">{info.text}</span>
        <DeltaChips added={info.added} removed={info.removed} />
        {info.blocked > 0 ? <span className="toolgroup-blocked">{info.blocked} blocked</span> : null}
        <span className="toolgroup-count">{rows.length}</span>
        <span className="caret"><Icon name={open ? 'CaretUp' : 'CaretRight'} size={11} /></span>
      </button>
      {open && (
        <div className="toolgroup-rows">
          {rows.map((t) => <ToolCard key={t.id} t={t} />)}
        </div>
      )}
    </div>
  );
}

// ---------- Artifacts ----------
// Live interactive preview for artifact blocks (HTML/SVG/Mermaid/React/markdown),
// mirroring Claude Desktop's sandboxed artifact runtime. HTML/SVG/Mermaid render
// fully offline; React/JSX use a sandboxed iframe with CDN React + Babel (best-effort).
export function ArtifactPreview({ block }) {
  const lang = (block.lang || 'text').toLowerCase().trim();
  const code = block.code || '';
  const [mermaidSvg, setMermaidSvg] = useState('');
  const [mermaidErr, setMermaidErr] = useState('');

  useEffect(() => {
    if (lang !== 'mermaid') return;
    let cancelled = false;
    setMermaidSvg('');
    setMermaidErr('');
    const id = 'mmd' + Math.random().toString(36).slice(2, 9);
    const isLightTheme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
    import('mermaid')
      .then((mod) => {
        const mermaid = mod.default || mod;
        if (cancelled) return;
        mermaid.initialize({ startOnLoad: false, theme: isLightTheme ? 'default' : 'dark', securityLevel: 'strict' });
        return mermaid.render(id, code);
      })
      .then((res) => {
        if (!cancelled && res && res.svg) setMermaidSvg(res.svg);
      })
      .catch((e) => {
        if (!cancelled) setMermaidErr(String((e && e.message) ? e.message : e));
      });
    return () => { cancelled = true; };
  }, [lang, code]);

  // Design canvas / slide deck: both are built by the main process (one source of
  // truth with the artifact window and print-to-PDF) and rendered in a sandbox.
  const isCanvas = ['design', 'canvas', 'artboard', 'slides', 'deck', 'presentation'].includes(lang);
  const [canvasDoc, setCanvasDoc] = useState('');
  const [canvasKey, setCanvasKey] = useState('');
  const [canvasTick, setCanvasTick] = useState(0);
  useEffect(() => {
    if (!isCanvas) return undefined;
    let live = true;
    setCanvasDoc('');
    const api = window.autobot;
    const p = api && api.artifactDocument
      ? api.artifactDocument({ name: block.label || '', language: lang, content: code })
      : Promise.resolve('');
    Promise.resolve(p)
      .then((h) => {
        if (!live || typeof h !== 'string') return;
        setCanvasDoc(h);
        // The document carries its own store key; the preview posts edits back
        // with that key so main writes the right slot.
        const m = /"key":"(canvas-[A-Za-z0-9-]+)"/.exec(h);
        setCanvasKey(m ? m[1] : '');
      })
      .catch(() => { /* leave the placeholder */ });
    return () => { live = false; };
  }, [isCanvas, lang, code, block.label, canvasTick]);

  // Edits made inside the preview (design artboards / slide deck) are posted to
  // the app window; persist them so the artifact window and every other surface
  // see one document.
  useEffect(() => {
    if (!isCanvas) return undefined;
    const onMsg = (ev) => {
      const d = ev && ev.data;
      if (!d || d.type !== 'helio:artifact-change' || !d.patch) return;
      const api = window.autobot;
      if (!api || !api.artifactSave) return;
      const key = d.key || canvasKey;
      if (!key) return;
      try { api.artifactSave(key, d.patch).catch(() => {}); } catch (_) {}
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [isCanvas, canvasKey]);

  // A change made elsewhere (artifact window, another conversation) reloads this
  // preview from the store instead of drifting out of sync.
  useEffect(() => {
    if (!isCanvas) return undefined;
    const api = window.autobot;
    if (!api || !api.onArtifactSaved) return undefined;
    const off = api.onArtifactSaved((info) => {
      if (!canvasKey || !info || info.key !== canvasKey) return;
      setCanvasTick((n) => n + 1);
    });
    return typeof off === 'function' ? off : undefined;
  }, [isCanvas, canvasKey]);

  if (isCanvas) {
    if (!canvasDoc) return <div className="artifact-fallback muted">Building {lang === 'slides' || lang === 'deck' || lang === 'presentation' ? 'deck' : 'canvas'}…</div>;
    return <iframe className="artifact-frame" title={lang + ' canvas'} sandbox="allow-scripts allow-modals allow-popups" srcDoc={canvasDoc} />;
  }
  if (lang === 'html' || lang === 'htm' || lang === 'xml') {
    return <iframe className="artifact-frame" title="artifact preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={code} />;
  }
  if (lang === 'svg') {
    const clean = DOMPurify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true } });
    return <iframe className="artifact-frame" title="artifact preview" sandbox="" srcDoc={`<!doctype html><html><body style="margin:0;background:#fff">${clean}</body></html>`} />;
  }
  if (lang === 'mermaid') {
    if (mermaidErr) {
      return <div className="artifact-fallback"><p className="muted">Diagram render failed: {mermaidErr}</p><pre>{code}</pre></div>;
    }
    if (!mermaidSvg) return <div className="artifact-fallback muted">Rendering diagram…</div>;
    return <div className="artifact-frame artifact-mermaid" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(mermaidSvg, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />;
  }
  if (lang === 'markmap' || lang === 'mindmap') {
    const isLightTheme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
    return <MindMapView markdown={code} theme={isLightTheme ? 'light' : 'dark'} compact />;
  }
  if (lang === 'react' || lang === 'jsx' || lang === 'js') {
    return <iframe className="artifact-frame" title="artifact preview" sandbox="allow-scripts" srcDoc={reactIframeHtml(code)} />;
  }
  if (lang === 'markdown' || lang === 'md') {
    return <div className="artifact-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(code) }} />;
  }
  if (lang === 'text' || lang === 'txt') {
    return <pre className="artifact-plain">{code}</pre>;
  }
  return <div className="artifact-fallback"><p className="muted">No live preview for “{block.lang || 'text'}”. Switch to Code to view the source.</p></div>;
}

// Build a sandboxed HTML shell that loads React + Babel from a CDN and renders a
// JSX/React artifact. The user code is base64-embedded to avoid escaping issues.
export function reactIframeHtml(code) {
  let b64 = '';
  try { b64 = btoa(unescape(encodeURIComponent(code))); } catch { b64 = btoa(code); }
  return `<!doctype html><html><head><meta charset="utf-8">
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:16px;background:#fff;color:#111}</style>
</head><body><div id="root"></div>
<script>
export function __err(e){var d=document.createElement('pre');d.style.cssText='color:#c00;white-space:pre-wrap;padding:16px;font-size:12px';d.textContent='Render error: '+(e&&e.message?e.message:e);document.body.appendChild(d);}
export function __go(){
  try{
    var __code = decodeURIComponent(escape(atob('${b64}')));
    var out = Babel.transform(__code, {presets:['env','react']}).code;
    var module = {exports:{}}; var exports = module.exports;
    var require = function(){ return window.React; };
    (function(){ eval(out); }).call(window);
    var App = (module.exports && module.exports.default) ? module.exports.default : module.exports;
    if (!App && window.App) App = window.App;
    if (!App){ document.getElementById('root').textContent = 'No default export found. Export a component as default.'; return; }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  }catch(e){ __err(e); }
}
if (window.React && window.ReactDOM && window.Babel) { __go(); }
else { document.getElementById('root').textContent = 'Could not load React/Babel from CDN. Preview requires network access.'; }
<\/script></body></html>`;
}

// ── Global search (Cmd/Ctrl+Shift+F) — Desktop transcript-search parity ──────
// Searches the conversation history in-memory (instant, no IPC) plus the
// project folder / notebooks / memory through the main process (ripgrep).
export function searchConversations(convs, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const c of convs || []) {
    const title = (c.title || '').toLowerCase();
    if (title.includes(q)) out.push({ kind: 'conv', convId: c.id, msgId: null, title: c.title || 'Untitled', text: c.title || '', ts: c.ts || 0 });
    for (const m of c.messages || []) {
      const text = String(m.content || '');
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const from = Math.max(0, idx - 70);
        out.push({ kind: 'conv', convId: c.id, msgId: m.id, role: m.role, title: c.title || 'Untitled', text: (from > 0 ? '…' : '') + text.slice(from, idx + 120).replace(/\s+/g, ' '), ts: m.ts || c.ts || 0 });
      }
    }
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

export function SearchView({ convs, cwd, initialTab = 'search', provider = null, onOpenSessionLink, onOpenConv }) {
  const [tab, setTab] = useState(initialTab);
  const [q, setQ] = useState('');
  const [convHits, setConvHits] = useState([]);
  const [diskHits, setDiskHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const [askQuestion, setAskQuestion] = useState('');
  const [askBusy, setAskBusy] = useState(false);
  const [askResult, setAskResult] = useState(null);
  const inputRef = useRef(null);
  useEffect(() => { setTab(initialTab || 'search'); }, [initialTab]);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, [tab]);
  useEffect(() => {
    setConvHits(searchConversations(convs, q));
    if (!q.trim()) { setDiskHits([]); return; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await window.autobot.searchAll({ query: q.trim(), cwd: cwd || '', limit: 60 });
        if (alive) setDiskHits((res && res.hits) || []);
      } catch (_) { if (alive) setDiskHits([]); }
      if (alive) setBusy(false);
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, convs, cwd]);

  const runAskHistory = async () => {
    if (!askQuestion.trim() || !window.autobot || !window.autobot.askHistory) return;
    setAskBusy(true);
    try {
      const res = await window.autobot.askHistory({ question: askQuestion.trim(), provider });
      setAskResult(res);
    } catch (e) {
      setAskResult({ ok: false, error: (e && e.message) || 'Ask History failed' });
    } finally {
      setAskBusy(false);
    }
  };

  const total = convHits.length + diskHits.length;
  return (
    <div className="searchview">
      <div className="ask-tabs">
        <button type="button" className={'mc-filter-pill' + (tab === 'search' ? ' on' : '')} onClick={() => setTab('search')}>Instant Search</button>
        <button type="button" className={'mc-filter-pill' + (tab === 'ask' ? ' on' : '')} onClick={() => setTab('ask')}>Ask History (SQLite FTS5)</button>
      </div>
      {tab === 'ask' ? (
        <div>
          <div className="search-bar">
            <Icon name="Search" size={16} />
            <input
              ref={inputRef}
              className="search-input"
              placeholder="Ask across past coding sessions (e.g. How did we fix OAuth callback?)"
              value={askQuestion}
              onChange={(e) => setAskQuestion(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') runAskHistory(); }}
            />
            <button type="button" className="btn-mini primary" disabled={askBusy || !askQuestion.trim()} onClick={runAskHistory}>
              {askBusy ? 'Asking…' : 'Ask History'}
            </button>
          </div>
          {!askResult && <div className="search-empty">Searches indexed local JSONL session trajectories and cites clickable session:// step deep links.</div>}
          {askResult && !askResult.ok && <div className="duet-err">{askResult.error || 'Ask History failed.'}</div>}
          {askResult && askResult.ok && (
            <div className="ask-answer-box">
              <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(askResult.answer || '') }} />
              {Array.isArray(askResult.citations) && askResult.citations.length > 0 && (
                <div className="ask-cite-list">
                  <div className="muted" style={{ fontSize: 11, fontWeight: 600 }}>Cited Session Steps</div>
                  {askResult.citations.map((c, idx) => (
                    <button
                      key={idx}
                      type="button"
                      className="ask-cite-btn"
                      onClick={() => (onOpenSessionLink ? onOpenSessionLink(c.deepLink) : onOpenConv(c.convId))}
                    >
                      <span className="search-hit-title">{c.label} · <code>{c.deepLink}</code></span>
                      <span className="search-hit-sub">{c.snippet}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="search-bar">
            <Icon name="Search" size={16} />
            <input ref={inputRef} className="search-input" placeholder="Search conversations, files, notebooks, memory…" value={q} onChange={(e) => setQ(e.target.value)} />
            {busy && <span className="search-busy">searching…</span>}
            <span className="search-count">{q.trim() ? total + ' result' + (total === 1 ? '' : 's') : ''}</span>
          </div>
          {!q.trim() && <div className="search-empty">Type to search. Conversations are searched in memory; files, notebooks and memory on disk.</div>}
          {q.trim() > '' && convHits.length > 0 && (
            <section className="search-group">
              <h4>Conversations</h4>
              {convHits.map((h, i) => (
                <button key={'c' + i} className="search-hit" onClick={() => onOpenConv(h.convId, h.msgId)}>
                  <span className="search-hit-title">{h.title}</span>
                  <span className="search-hit-sub">{h.role ? (h.role === 'user' ? 'you' : 'assistant') + ' · ' : ''}{h.text}</span>
                </button>
              ))}
            </section>
          )}
          {q.trim() > '' && diskHits.length > 0 && (
            <section className="search-group">
              <h4>Project files, notebooks &amp; memory</h4>
              {diskHits.map((h, i) => (
                <div key={'d' + i} className="search-hit search-hit-static">
                  <span className="search-hit-title">{h.kind === 'file' ? (h.rel || h.file) + ':' + h.line : h.kind === 'notebook' ? 'Notebook · ' + h.title : 'Memory'}</span>
                  <span className="search-hit-sub">{h.text}</span>
                </div>
              ))}
            </section>
          )}
          {q.trim() && !busy && total === 0 && <div className="search-empty">No matches for “{q.trim()}”.</div>}
        </>
      )}
    </div>
  );
}

export function ArtifactsView({ blocks }) {
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState('preview'); // 'preview' | 'code'
  const block = blocks[idx];
  // Frame type manifests (🎨 Design / 📽️ Slides) come from main so the tab strip,
  // header and Open button use the same title/tint/icon as the artifact window.
  const langs = blocks.map((b) => String(b.lang || '').toLowerCase().trim());
  const typeMeta = useArtifactTypes(langs);
  const meta = block ? typeMeta[String(block.lang || '').toLowerCase().trim()] || null : null;
  // Tab labels read like Desktop: the explicit artifact name, else the frame
  // type ("Design"/"Slides"), else the fence language. A number is only added
  // when more than one artifact of that type exists, so the common case is a
  // clean "🎨 Design" instead of "🎨design #1".
  const tabLabels = useMemo(() => {
    const counts = {};
    for (const l of langs) counts[l] = (counts[l] || 0) + 1;
    const seen = {};
    return blocks.map((b) => {
      const l = String(b.lang || '').toLowerCase().trim();
      const mt = typeMeta[l];
      const base = b.label || (mt && mt.title) || b.lang || 'artifact';
      if ((counts[l] || 0) < 2) return base;
      seen[l] = (seen[l] || 0) + 1;
      return base + ' ' + seen[l];
    });
  }, [blocks, langs.join('|'), typeMeta]);
  let highlighted = '';
  if (block) {
    try {
      highlighted = block.lang && hljs.getLanguage(block.lang) ? hljs.highlight(block.code, { language: block.lang }).value : hljs.highlightAuto(block.code).value;
    } catch {}
  }
  const canPreview = block && ['html', 'htm', 'xml', 'svg', 'mermaid', 'react', 'jsx', 'js', 'markdown', 'md', 'text', 'txt', 'design', 'canvas', 'artboard', 'slides', 'deck', 'presentation'].includes((block.lang || 'text').toLowerCase().trim());
  return (
    <div className="panel artifacts">
      <h2>Artifacts</h2>
      {blocks.length === 0 && <p className="muted">No code artifacts yet. Ask Akron Code to write code and it will appear here.</p>}
      {blocks.length > 0 && (
        <>
          <div className="artifact-tabs">
            {blocks.map((b, i) => {
              const mt = typeMeta[String(b.lang || '').toLowerCase().trim()];
              return (
                <button key={i} className={i === idx ? 'on' : ''} onClick={() => { setIdx(i); setMode('preview'); }}
                  style={mt ? { '--artifact-tint': mt.tintColor } : undefined}
                  title={mt ? `${mt.title} · contract ${mt.contract}` : undefined}>
                  {mt && <span className="artifact-tab-emoji" aria-hidden="true">{mt.favicon}</span>}
                  {tabLabels[i]}
                </button>
              );
            })}
          </div>
          {block && (
            <div className="artifact-body">
              <div className="artifact-toolbar">
                {meta ? (
                  <div className="codeblock-head artifact-type-head" style={{ '--artifact-tint': meta.tintColor }}>
                    <span className="artifact-type-badge">
                      <Icon name={meta.icon || 'Artifacts'} size={14} />
                      {meta.title}
                    </span>
                    <span className="artifact-type-contract">contract {meta.contract}</span>
                    {meta.mcp && meta.mcp.length > 0 && (
                      <span className={meta.mcp.some((s) => s.available) ? 'artifact-cap on' : 'artifact-cap'} title={meta.mcp.some((s) => s.available) ? 'Save to Drive is available' : 'Connect Google Drive to save decks there'}>
                        {meta.mcp.some((s) => s.available) ? 'Drive ready' : 'Drive not connected'}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="codeblock-head"><span>{block.lang}</span></div>
                )}
                <div className="artifact-toggle">
                  <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')} disabled={!canPreview}>Preview</button>
                  <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>Code</button>
                  <button className="copy-btn" data-code={encodeURIComponent(block.code)} onClick={(e) => { const btn = e.currentTarget; const c = decodeURIComponent(btn.dataset.code || ''); navigator.clipboard?.writeText(c).then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }); }}>Copy</button>
                  <button onClick={() => window.autobot.openArtifactWindow({ name: block.label || '', language: block.lang, content: block.code })}>Open</button>
                  <button onClick={() => window.autobot.printToPdf({ defaultName: (block.label || 'artifact').replace(/[^\w.-]+/g, '_') + '.pdf', language: (block.lang || '').toLowerCase(), html: ['html', 'htm', 'svg'].includes((block.lang || '').toLowerCase()) ? block.code : undefined, content: block.code })}>PDF</button>
                </div>
              </div>
              {mode === 'code' || !canPreview ? (
                <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
              ) : (
                <ArtifactPreview block={block} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Fetch frame type metadata once per distinct artifact language. Main resolves
// the manifest against the current install (flag overrides, connected MCP
// servers, local profile), so the badge never claims a capability that is off.
export function useArtifactTypes(langs) {
  const [map, setMap] = useState({});
  const seen = useRef({});
  const key = langs.filter(Boolean).join('|');
  useEffect(() => {
    const api = window.autobot;
    if (!api || !api.artifactType) return undefined;
    const want = key.split('|').filter(Boolean).filter((l) => !seen.current[l]);
    if (!want.length) return undefined;
    want.forEach((l) => { seen.current[l] = 'pending'; });
    let live = true;
    Promise.all(want.map((l) => Promise.resolve(api.artifactType({ language: l })).then((m) => [l, m]).catch(() => [l, null])))
      .then((pairs) => {
        if (!live) return;
        setMap((prev) => {
          const next = { ...prev };
          for (const [l, m] of pairs) { next[l] = m; seen.current[l] = m ? 'done' : 'none'; }
          return next;
        });
      });
    return () => { live = false; };
  }, [key]);
  return map;
}

// MemoryView extracted to src/features/WorkspacePanels.jsx

// ---------- Skills ----------
export const SKILL_SOURCE_LABELS = { bundled: 'Bundled', claude: 'Claude Code', custom: 'Custom' };
export const SKILL_SOURCE_ORDER = ['bundled', 'claude', 'custom'];

export function SkillsViewBody({ skills, toggleSkill, setAllSkills, refreshSkills }) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all'); // 'all' | source | 'enabled' | 'disabled'
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Re-read from disk when the panel opens so skills added by the model
  // (create_skill) or by another window show up immediately.
  useEffect(() => { if (refreshSkills) refreshSkills(); }, [refreshSkills]);

  const enabledCount = skills.filter((s) => s.enabled !== false).length;

  // Upload a .md file from disk → parsed + saved as a custom skill.
  const uploadSkill = async () => {
    setErr('');
    const picked = await window.autobot.pickSkillFile();
    if (!picked) return;
    if (picked.ok === false) { setErr(picked.error || 'Could not read file.'); return; }
    setBusy(true);
    const r = await window.autobot.addSkill(picked.name, picked.content);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not save skill.'); return; }
    if (refreshSkills) await refreshSkills();
  };

  // Author a skill inline (name + Markdown body).
  const saveSkill = async () => {
    setErr('');
    if (!newName.trim() || !newContent.trim()) { setErr('Name and content are required.'); return; }
    setBusy(true);
    const r = await window.autobot.addSkill(newName.trim(), newContent);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not save skill.'); return; }
    setAdding(false); setNewName(''); setNewContent('');
    if (refreshSkills) await refreshSkills();
  };

  const removeSkill = async (name) => {
    setErr('');
    const r = await window.autobot.deleteSkill(name);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not delete skill.'); return; }
    if (refreshSkills) await refreshSkills();
  };

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return skills.filter((s) => {
      if (group === 'enabled' && s.enabled === false) return false;
      if (group === 'disabled' && s.enabled !== false) return false;
      if (group !== 'all' && group !== 'enabled' && group !== 'disabled' && s.source !== group) return false;
      if (query) {
        const hay = (s.name + ' ' + s.description + ' ' + (s.source || '')).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [skills, q, group]);

  const groups = useMemo(() => {
    const bySource = {};
    for (const s of filtered) (bySource[s.source || 'custom'] = bySource[s.source || 'custom'] || []).push(s);
    return SKILL_SOURCE_ORDER.map((src) => ({ src, label: SKILL_SOURCE_LABELS[src] || src, items: bySource[src] || [] }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  return (
    <div className="panel skills-panel">
      <div className="panel-head">
        <h2>Skills</h2>
        <span className="muted">{enabledCount}/{skills.length} enabled</span>
      </div>

      <div className="skills-toolbar">
        <input
          className="skills-search"
          placeholder="Search skills by name or description…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="skills-filter" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="all">All sources</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
          {SKILL_SOURCE_ORDER.map((src) => (
            <option key={src} value={src}>{SKILL_SOURCE_LABELS[src] || src}</option>
          ))}
        </select>
        <button onClick={() => setAllSkills(true)}>Enable all</button>
        <button onClick={() => setAllSkills(false)}>Disable all</button>
        <button className="primary" disabled={busy} onClick={uploadSkill}><Icon name="Upload" size={13} /> Add skill (.md)</button>
        <button disabled={busy} onClick={() => { setAdding((v) => !v); setErr(''); }}>{adding ? 'Cancel' : 'New skill'}</button>
      </div>

      {err && <p className="form-error">{err}</p>}

      {adding && (
        <div className="skill-author">
          <input placeholder="Skill name (e.g. release-notes)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <textarea
            rows={6}
            placeholder={'Markdown body. Optional frontmatter:\n---\nname: my-skill\ndescription: What it does\n---\n\n# Instructions…'}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <div className="row-actions">
            <button className="primary" disabled={busy} onClick={saveSkill}>Save skill</button>
            <span className="muted">Saved to ~/.autobot/skills/ and discoverable via the list_skills tool.</span>
          </div>
        </div>
      )}

      <p className="muted skills-hint">Enabled skills are auto-discoverable by the model via the "list_skills" tool. Toggle any skill on or off; changes persist and apply immediately. Upload any <code>.md</code> file to add your own skill.</p>

      {filtered.length === 0 && <p className="muted">No skills match.</p>}

      {groups.map((g) => (
        <div key={g.src} className="skills-group">
          <div className="skills-group-head">{g.label} <span className="muted">{g.items.length}</span></div>
          {g.items.map((s) => {
            const on = s.enabled !== false;
            return (
              <div key={s.name} className={'skillitem' + (on ? '' : ' off')}>
                <button
                  className={'switch' + (on ? ' on' : '')}
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleSkill(s.name)}
                  title={on ? 'Click to deactivate' : 'Click to activate'}
                >
                  <span className="knob" />
                </button>
                <div className="skillitem-body">
                  <div className="skillitem-title">
                    <b>{s.name}</b>
                    <span className="skill-src">{SKILL_SOURCE_LABELS[s.source] || s.source}</span>
                  </div>
                  <span className="skillitem-desc">{s.description}</span>
                </div>
                {s.source === 'custom' && (
                  <button className="icon-btn" title="Delete skill" onClick={() => removeSkill(s.name)}><Icon name="Trash" size={13} /></button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------- Plugins & Connectors (Claude Desktop parity: directory + install + configure + test) ----------
export function PluginsViewBody({ onOpenGdrive, gdriveState } = {}) {
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [cat, setCat] = useState('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stats, setStats] = useState(null);
  const [shown, setShown] = useState(120);
  const [tab, setTab] = useState('directory');
  const [authBusy, setAuthBusy] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [cfgDraft, setCfgDraft] = useState({ apiKey: '', endpointUrl: '', command: '' });
  const [testMap, setTestMap] = useState({}); // id -> { ok, detail, error }

  const refreshStats = useCallback(async () => {
    try {
      const s = await window.autobot.pluginStats();
      if (s) setStats(s);
      const c = await window.autobot.pluginCategories();
      if (Array.isArray(c)) setCats(c);
    } catch (_) {}
  }, []);

  const refresh = useCallback(async () => {
    const opts = {};
    if (type !== 'all') opts.type = type;
    if (cat !== 'all') opts.category = cat;
    if (installedOnly) opts.installedOnly = true;
    const query = q.trim();
    const list = query
      ? await window.autobot.searchPlugins(query, { ...opts, limit: 600 })
      : await window.autobot.listPlugins(opts);
    setItems(Array.isArray(list) ? list : []);
  }, [q, type, cat, installedOnly]);

  useEffect(() => { refreshStats(); }, [refreshStats]);
  useEffect(() => { refresh(); }, [refresh]);
  // Any filter change starts the list over at the first page.
  useEffect(() => { setShown(120); }, [q, type, cat, installedOnly]);

  // Registry sync runs in the background; pick it up shortly after first paint.
  useEffect(() => {
    if (!stats || stats.registry) return;
    const t = setTimeout(refreshStats, 4000);
    return () => clearTimeout(t);
  }, [stats, refreshStats]);

  const setInstalled = async (id, on) => {
    setErr('');
    setBusy(true);
    try {
      const r = on ? await window.autobot.installPlugin(id) : await window.autobot.uninstallPlugin(id);
      if (r && r.ok === false) setErr(r.error);
      else if (r && r.needsSetup === 'gdrive' && onOpenGdrive) {
        onOpenGdrive();
      } else if (r && r.needsAuth) {
        // OAuth-gated connector: installation succeeded, the server wants a token.
        setErr('Installed. Click “Sign in” (or “Configure”) on the card to authorize with the provider.');
      } else if (r && r.connectError) setErr('Installed, but could not connect: ' + r.connectError);
      else if (on && r && r.entry && r.entry.auth === 'apikey' && !r.entry.connected) {
        setEditingId(id);
        setCfgDraft({ apiKey: '', endpointUrl: (r.entry.endpoint && r.entry.endpoint.url) || '', command: '' });
      }
    } finally {
      setBusy(false);
      await refresh();
      refreshStats();
    }
  };

  const openConfigure = (it) => {
    if (it.builtInAdapter === 'gdrive' && onOpenGdrive) {
      onOpenGdrive();
      return;
    }
    setEditingId((prev) => (prev === it.id ? null : it.id));
    setCfgDraft({
      apiKey: '',
      endpointUrl: (it.endpoint && it.endpoint.url) || '',
      command: (it.command && it.command.command) || '',
    });
  };

  const saveConfigure = async (it) => {
    setErr('');
    setAuthBusy(it.id);
    try {
      const r = await window.autobot.configurePlugin(it.id, cfgDraft);
      if (!r || r.ok === false) {
        const msg = (r && r.error) || 'Failed to save configuration';
        setErr(msg);
        setTestMap((m) => ({ ...m, [it.id]: { ok: false, error: msg } }));
      } else {
        setEditingId(null);
        setTestMap((m) => ({ ...m, [it.id]: { ok: true, detail: r.detail || `Connected (${(r.tools || []).length || 'OK'})` } }));
      }
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  const testConnector = async (it) => {
    setErr('');
    setAuthBusy(it.id);
    try {
      const r = await window.autobot.testPlugin(it.id);
      if (r && r.needsSetup === 'gdrive' && onOpenGdrive) {
        onOpenGdrive();
      }
      setTestMap((m) => ({
        ...m,
        [it.id]: r && r.ok
          ? { ok: true, detail: r.detail || 'OK' }
          : { ok: false, error: (r && r.error) || 'Test failed' },
      }));
    } catch (e) {
      setTestMap((m) => ({ ...m, [it.id]: { ok: false, error: e && e.message ? e.message : String(e) } }));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  // Browser sign-in for an OAuth-gated connector (MCP OAuth 2.1 + PKCE).
  const signIn = async (id) => {
    setErr('');
    setAuthBusy(id);
    try {
      const r = await window.autobot.pluginAuthStart(id);
      if (!r || r.ok === false) setErr((r && r.error) || 'sign-in failed');
      else if (r.connected === false) setErr('Signed in, but the connector still refused: ' + (r.connectError || 'unknown error'));
      else if (r.error) setErr(r.error);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  const signOut = async (id) => {
    setErr('');
    setAuthBusy(id);
    try {
      const r = await window.autobot.pluginSignOut(id);
      if (r && r.ok === false) setErr(r.error);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  const refreshRegistry = async () => {
    setErr('');
    setBusy(true);
    try {
      await window.autobot.refreshRegistry();
      await refreshStats();
      await refresh();
    } finally { setBusy(false); }
  };

  const installedCount = items.filter((i) => i.installed).length;
  const visible = items.slice(0, shown);
  const reg = stats && stats.registry;
  const regCount = reg ? reg.count || 0 : 0;

  return (
    <div className="panel plugins-panel">
      <div className="panel-head">
        <h2>Plugins &amp; Connectors</h2>
        <span className="muted">{installedCount} installed · {items.length} available</span>
      </div>
      <div className="seg">
        <button className={tab === 'directory' ? 'on' : ''} onClick={() => setTab('directory')}>Directory</button>
        <button className={tab === 'extensions' ? 'on' : ''} onClick={() => setTab('extensions')}>Chrome extensions</button>
      </div>

      {tab === 'extensions' && <ExtensionsView />}

      {tab === 'directory' && (<>
      <p className="muted">Connect external services so the model can read your docs, issues, messages, and data. Installing a connector registers it with the MCP layer; connectors marked “needs sign-in” require credentials before their tools work.</p>

      <div className="skills-toolbar">
        <input className="skills-search" placeholder="Search plugins & connectors…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="skills-filter" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All types</option>
          <option value="connector">Connectors</option>
          <option value="plugin">Plugins</option>
        </select>
        <select className="skills-filter" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} /> Installed only</label>
      </div>

      {stats && (
        <div className="plugin-registry-row">
          <span className="muted">
            {(stats.curated && stats.curated.connectors) || stats.connectors} built-in connectors ·{' '}
            {(stats.curated && stats.curated.plugins) || stats.plugins} plugins · {stats.categories} categories
          </span>
          <span className="muted">
            {regCount > 0
              ? `+${regCount} live MCP servers${reg && reg.refreshing ? ' (syncing…)' : ''}`
              : reg && reg.refreshing ? 'Syncing MCP registry…' : 'MCP registry not synced yet'}
          </span>
          <button disabled={busy || (reg && reg.refreshing)} onClick={refreshRegistry}>Refresh registry</button>
        </div>
      )}

      {err && <p className="form-error">{err}</p>}
      {items.length === 0 && <p className="muted">No plugins or connectors match.</p>}

      <div className="plugin-grid">
        {visible.map((it) => {
          const isDrive = it.builtInAdapter === 'gdrive';
          const isConnected = isDrive ? !!(gdriveState && gdriveState.connected) : !it.requiresSignIn;
          const tr = testMap[it.id];
          return (
          <div key={it.id} className={'plugin-card' + (it.installed ? ' installed' : '')}>
            <div className="plugin-card-head">
              <div className="plugin-card-id">
                <ConnectorLogo id={it.id} name={it.name} url={it.endpoint && it.endpoint.url} type={it.type} />
                <div className="plugin-card-meta">
                  <b>{it.name}</b>
                  <span className="skill-src">{it.category}</span>
                </div>
              </div>
              <button
                className={it.installed ? '' : 'primary'}
                disabled={busy}
                onClick={() => setInstalled(it.id, !it.installed)}
              >
                {it.installed ? 'Remove' : 'Install'}
              </button>
            </div>
            <p className="plugin-card-desc">{it.description}</p>
            <div className="plugin-card-foot">
              <span className="muted">{it.auth === 'none' ? 'No sign-in needed' : it.auth === 'oauth' ? 'OAuth sign-in' : 'API key'}</span>
              <span className="badge">{it.type}</span>
              {it.origin === 'registry' && <span className="badge">registry</span>}
              {it.installed && !isConnected && <span className="badge warn">needs sign-in</span>}
              {it.installed && isConnected && <span className="badge ok">{it.toolCount > 0 ? `${it.toolCount} tools` : (isDrive && gdriveState ? `connected (${gdriveState.mode || 'drive'})` : 'connected')}</span>}
              {it.installed && isDrive && (
                <button className="plugin-auth primary" onClick={() => onOpenGdrive && onOpenGdrive()}>
                  {isConnected ? 'Configure Drive' : 'Set up'}
                </button>
              )}
              {it.installed && !isDrive && it.endpoint && it.auth === 'oauth' && (
                it.requiresSignIn
                  ? <button className="plugin-auth primary" disabled={authBusy === it.id} onClick={() => signIn(it.id)}>
                      {authBusy === it.id ? 'Signing in…' : 'Sign in'}
                    </button>
                  : <button className="plugin-auth" disabled={authBusy === it.id} onClick={() => signOut(it.id)}>
                      Sign out
                    </button>
              )}
              {it.installed && !isDrive && (it.auth === 'apikey' || (it.auth === 'oauth' && !it.endpoint)) && (
                <button className={'plugin-auth' + (it.requiresSignIn ? ' primary' : '')} disabled={authBusy === it.id} onClick={() => openConfigure(it)}>
                  {editingId === it.id ? 'Close' : (it.requiresSignIn ? 'Configure' : 'Edit key')}
                </button>
              )}
              {it.installed && (
                <button className="plugin-auth" disabled={authBusy === it.id} onClick={() => testConnector(it)}>
                  {authBusy === it.id ? 'Testing…' : 'Test'}
                </button>
              )}
            </div>
            {tr && (
              <div className={'plugin-test-res ' + (tr.ok ? 'ok' : 'err')}>
                {tr.ok ? `✓ ${tr.detail}` : `✕ ${tr.error}`}
              </div>
            )}
            {it.installed && editingId === it.id && (
              <div className="plugin-cfg-drawer">
                <input
                  type="password"
                  placeholder={it.auth === 'oauth' ? 'Bearer / personal access token…' : 'Paste API key / token…'}
                  value={cfgDraft.apiKey}
                  onChange={(e) => setCfgDraft((d) => ({ ...d, apiKey: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="Optional MCP server URL (https://.../mcp)"
                  value={cfgDraft.endpointUrl}
                  onChange={(e) => setCfgDraft((d) => ({ ...d, endpointUrl: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="Optional stdio MCP command (e.g. npx -y @org/mcp)"
                  value={cfgDraft.command}
                  onChange={(e) => setCfgDraft((d) => ({ ...d, command: e.target.value }))}
                />
                <div className="plugin-cfg-actions">
                  <button className="btn-mini primary" disabled={authBusy === it.id} onClick={() => saveConfigure(it)}>
                    {authBusy === it.id ? 'Connecting…' : 'Save & Connect'}
                  </button>
                  <button className="btn-mini" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
          );
        })}
      </div>

      {items.length > visible.length && (
        <div className="plugin-more">
          <button onClick={() => setShown((n) => n + 240)}>
            Show more ({items.length - visible.length} left)
          </button>
        </div>
      )}
      </>)}
    </div>
  );
}

// ---------- Chrome extensions (Desktop `extension-host` parity) ----------
export function ExtensionsView() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [opened, setOpened] = useState({});

  const refresh = useCallback(async () => {
    try {
      const list = await window.autobot.extensionList();
      setRows(Array.isArray(list) ? list : []);
      const st = await window.autobot.extensionStatus();
      if (st) setStatus(st);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => window.autobot.onExtensionWindowError((msg) => {
    setErr(String(msg || 'The extension window could not load.'));
    refresh();
  }), [refresh]);

  const rescan = async () => {
    setBusy(true); setErr('');
    try { await window.autobot.extensionScan(); await refresh(); }
    catch (e) { setErr(e && e.message ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const open = async (row) => {
    setBusy(true); setErr('');
    try {
      const r = await window.autobot.extensionOpen({ extensionId: row.id, page: row.defaultPage });
      if (!r || r.ok === false) setErr((r && (r.message || r.error)) || 'Could not open the extension.');
      else setOpened((o) => ({ ...o, [row.id]: r.windowId }));
      await refresh();
    } catch (e) { setErr(e && e.message ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const close = async (row) => {
    const id = opened[row.id];
    if (!id) return;
    await window.autobot.extensionClose(id);
    setOpened((o) => { const n = { ...o }; delete n[row.id]; return n; });
    await refresh();
  };

  return (
    <div className="extensions-view">
      <p className="muted">
        Unpacked Chrome MV3/MV2 extensions are hosted with a real <code>chrome-extension://</code> origin and a
        <code> chrome.*</code> surface backed by Akron Code. Drop a folder in <code>~/.autobot/extensions/&lt;id&gt;</code> and rescan.
      </p>
      <div className="plugin-registry-row">
        <span className="muted">
          {rows.length} installed{status ? ` · ${status.native} native · ${status.windows} open · ${status.sinks} attached` : ''}
          {status && status.bridge ? ` · bridge ${status.bridge.ready ? 'ready' : 'off'}${status.bridge.port ? ' on :' + status.bridge.port : ''}` : ''}
        </span>
        <button disabled={busy} onClick={rescan}>{busy ? 'Working…' : 'Rescan folder'}</button>
      </div>

      {err && <p className="form-error">{err}</p>}
      {rows.length === 0 && (
        <p className="muted">No extensions installed. Add one under <code>~/.autobot/extensions/&lt;id&gt;/manifest.json</code>.</p>
      )}

      <div className="plugin-grid">
        {rows.map((row) => (
          <div key={row.id} className="plugin-card">
            <div className="plugin-card-head">
              <div>
                <b>{row.name}</b>
                <span className="skill-src">{row.version} · MV{row.manifestVersion}{row.hasBackground ? ' · worker' : ''}</span>
              </div>
              <div className="ext-actions">
                {opened[row.id]
                  ? <button onClick={() => close(row)}>Close</button>
                  : <button className="primary" disabled={busy} onClick={() => open(row)}>Open</button>}
              </div>
            </div>
            {row.description && <p className="plugin-card-desc">{row.description}</p>}
            <div className="plugin-card-foot">
              <span className="muted mono-id">{row.id}</span>
            </div>
            {row.permissions.length > 0 && (
              <div className="ext-perms">
                {row.permissions.slice(0, 8).map((p) => <span key={p} className="badge">{p}</span>)}
                {row.permissions.length > 8 && <span className="badge">+{row.permissions.length - 8}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Scheduled tasks (Claude Desktop parity) ----------
export const CADENCES = [
  { id: 'once', label: 'Once' },
  { id: 'every', label: 'Every N minutes' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
];

export function ScheduledViewBody({ cwd, convs = [], onSendToChat }) {
  const [tasks, setTasks] = useState([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cadence, setCadence] = useState('daily');
  const [time, setTime] = useState('09:00');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await window.autobot.listScheduledTasks();
    setTasks(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => window.autobot.onEvent((evt) => {
    if (evt && evt.type === 'scheduled-task') refresh();
  }), [refresh]);

  const create = async () => {
    setErr('');
    if (!prompt.trim()) { setErr('Prompt is required.'); return; }
    setBusy(true);
    const input = { name: name.trim() || undefined, prompt: prompt.trim(), cadence };
    if (cadence === 'every') input.everyMinutes = Number(everyMinutes) || 60;
    if (cadence === 'daily' || cadence === 'weekly') input.time = time;
    if (cadence === 'weekly') input.dayOfWeek = Number(dayOfWeek);
    const r = await window.autobot.createScheduledTask(input);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not create task.'); return; }
    setName(''); setPrompt('');
    await refresh();
  };

  const toggle = async (t) => {
    await window.autobot.updateScheduledTask(t.id, { enabled: t.enabled === false });
    await refresh();
  };
  const remove = async (id) => { await window.autobot.deleteScheduledTask(id); await refresh(); };
  const runNow = async (id) => { setBusy(true); await window.autobot.runScheduledTask(id); setBusy(false); await refresh(); };

  return (
    <div className="panel scheduled-panel">
      <ProactiveDashboard cwd={cwd} convs={convs} onScheduledCreated={refresh} onSendToChat={onSendToChat} Icon={Icon} />
      <div className="panel-head">
        <h2>Scheduled tasks</h2>
        <span className="muted">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
      </div>
      <p className="muted">Scheduled tasks run a prompt through the agent automatically — a daily brief, a periodic check, or a one-off reminder. Results are saved with each task.</p>

      <div className="sched-form">
        <input placeholder="Task name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea rows={3} placeholder="Prompt to run, e.g. “Summarize overnight changes in ~/projects and list anything broken.”" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="sched-row">
          <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
            {CADENCES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {cadence === 'every' && (
            <label className="inline-num">Every <input type="number" min={1} value={everyMinutes} onChange={(e) => setEveryMinutes(e.target.value)} /> min</label>
          )}
          {(cadence === 'daily' || cadence === 'weekly') && (
            <label className="inline-num">at <input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          )}
          {cadence === 'weekly' && (
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          )}
          <button className="primary" disabled={busy} onClick={create}>Schedule</button>
        </div>
      </div>

      {err && <p className="form-error">{err}</p>}
      {tasks.length === 0 && <p className="muted">No scheduled tasks yet.</p>}

      {tasks.map((t) => (
        <div key={t.id} className={'sched-item' + (t.enabled === false ? ' off' : '')}>
          <div className="sched-item-head">
            <button className={'switch' + (t.enabled !== false ? ' on' : '')} role="switch" aria-checked={t.enabled !== false} onClick={() => toggle(t)} title="Enable/disable"><span className="knob" /></button>
            <div className="sched-item-body">
              <b>{t.name}</b>
              <span className="muted">{t.schedule}{t.nextRunAt ? ' · next ' + new Date(t.nextRunAt).toLocaleString() : ''}{t.runCount ? ' · ran ' + t.runCount + '×' : ''}</span>
              <span className="skillitem-desc">{t.prompt}</span>
              {t.lastResult && (
                <span className={'muted sched-last' + (t.lastResult.ok ? '' : ' err')}>
                  Last run {new Date(t.lastRunAt || t.lastResult.at).toLocaleString()}: {t.lastResult.ok ? String(t.lastResult.output || '').slice(0, 240) : 'ERROR ' + t.lastResult.error}
                </span>
              )}
            </div>
            <div className="sched-actions">
              <button className="icon-btn" title="Run now" disabled={busy} onClick={() => runNow(t.id)}><Icon name="CheckCircle" size={14} /></button>
              <button className="icon-btn" title="Delete" onClick={() => remove(t.id)}><Icon name="Trash" size={13} /></button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ProjectsView, McpView, NotebooksView extracted to src/features/WorkspacePanels.jsx

// ---------- Terminal ----------
export function TerminalView({ terminal, setTerminal, startTerminal, runInTerminal, writeTerminal, killTerminal }) {
  const [cmd, setCmd] = useState('');
  const active = terminal.tabs.find((t) => t.id === terminal.active);
  const submit = (e) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    runInTerminal(cmd);
    setCmd('');
  };
  return (
    <div className="panel terminal-panel">
      <div className="panel-head"><h2>Terminal</h2>
        <div><button onClick={startTerminal}>+ New tab</button> <button onClick={() => writeTerminal('\x03')} title="Send Ctrl-C">Ctrl-C</button></div>
      </div>
      {terminal.tabs.length === 0 && <p className="muted">No terminal tabs. Start one to run shell commands.</p>}
      {terminal.tabs.length > 0 && (
        <div className="term-tabs">
          {terminal.tabs.map((t) => (
            <button key={t.id} className={'term-tab ' + (t.id === terminal.active ? 'on' : '')} onClick={() => setTerminal((s) => ({ ...s, active: t.id }))}>
              {t.id} <span className="term-cwd">{t.cwd.split('/').pop()}</span>
              <span className="term-close" onClick={(e) => { e.stopPropagation(); killTerminal(t.id); }}>×</span>
            </button>
          ))}
        </div>
      )}
      {active && (
        <>
          <pre className="term-output">{active.output || '(no output)'}</pre>
          <form className="term-input" onSubmit={submit}>
            <span className="term-prompt">$</span>
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="command…" autoFocus />
          </form>
        </>
      )}
    </div>
  );
}

// ---------- Claude Code (repo-aware) ----------
export function CodeView({ cwd, setCwd, permissions, setPermissions, T }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [diffOld, setDiffOld] = useState('');
  const [diffNew, setDiffNew] = useState('');
  const [diffRes, setDiffRes] = useState(null);

  const refresh = useCallback(async (dir) => {
    setLoading(true);
    try {
      const g = await window.autobot.gitInfo(dir || cwd || undefined);
      setInfo(g);
    } catch (e) {
      setInfo({ isRepo: false, error: String(e) });
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { refresh(); }, [refresh]);

  const pickFolder = async () => {
    const dir = await window.autobot.pickFolder();
    if (dir) {
      setCwd(dir); refresh(dir);
      const id = loadJSON('autobot:activeId', null);
      if (id) window.autobot.setWorkspace(id, dir).catch(() => {});
    }
  };

  const runDiff = async () => {
    const d = await window.autobot.diff(diffOld, diffNew, 'edit');
    setDiffRes(d);
  };

  const counts = (info && info.counts) || {};

  return (
    <div className="panel code-panel">
      <div className="panel-head">
        <h2>{T('code.title')}</h2>
        <div className="code-head-actions">
          <button onClick={pickFolder}><Icon name="Folder" size={14} /> {T('code.openFolder')}</button>
          <button onClick={() => refresh()} disabled={loading}><Icon name="ArrowClockwise" size={14} /> {T('code.refresh')}</button>
        </div>
      </div>

      <div className="code-cwd muted">{cwd || '(no folder open)'}</div>

      <div className="code-perms">
        <span className="code-k">{T('code.permissions')}</span>
        <div className="seg seg-4">
          <button className={permissions === 'auto' ? 'on' : ''} onClick={() => setPermissions('auto')} title={T('code.permissions.autoHint')}>{T('code.permissions.auto')}</button>
          <button className={permissions === 'ask' ? 'on' : ''} onClick={() => setPermissions('ask')} title={T('code.permissions.askHint')}>{T('code.permissions.ask')}</button>
          <button className={permissions === 'acceptEdits' ? 'on' : ''} onClick={() => setPermissions('acceptEdits')} title={T('code.permissions.acceptEditsHint')}>{T('code.permissions.acceptEdits')}</button>
          <button className={permissions === 'plan' ? 'on' : ''} onClick={() => setPermissions('plan')} title={T('code.permissions.planHint')}>{T('code.permissions.plan')}</button>
          <button className={permissions === 'bypass' ? 'on' : ''} onClick={() => setPermissions('bypass')} title={T('perm.bypassDesc')}>{T('perm.bypass')}</button>
        </div>
      </div>
      <p className="muted code-perms-hint">{T('code.permissions.hint')}</p>

      {loading && <p className="muted">{T('code.loading')}</p>}

      {info && !info.isRepo && (
        <div className="code-norepo">
          <p><b>{T('code.noRepo')}</b></p>
          <p className="muted">{T('code.noRepo.hint')}</p>
        </div>
      )}

      {info && info.isRepo && (
        <div className="code-dash">
          <div className="code-row">
            <span className="code-k">{T('code.branch')}</span>
            <span className="code-v">
              <b>{info.branch}</b>
              {info.ahead > 0 && <span className="code-tag ahead">↑{info.ahead} {T('code.ahead')}</span>}
              {info.behind > 0 && <span className="code-tag behind">↓{info.behind} {T('code.behind')}</span>}
            </span>
          </div>
          {info.remote && (
            <div className="code-row"><span className="code-k">{T('code.remote')}</span><span className="code-v">{info.remote}</span></div>
          )}
          <div className="code-row">
            <span className="code-k">{T('code.changes')}</span>
            <span className="code-v">
              {counts.modified > 0 && <span className="code-chip m">{counts.modified} {T('code.modified')}</span>}
              {counts.added > 0 && <span className="code-chip a">{counts.added} {T('code.added')}</span>}
              {counts.deleted > 0 && <span className="code-chip d">{counts.deleted} {T('code.deleted')}</span>}
              {counts.untracked > 0 && <span className="code-chip u">{counts.untracked} {T('code.untracked')}</span>}
              {!counts.modified && !counts.added && !counts.deleted && !counts.untracked && <span className="muted">{T('code.clean')}</span>}
            </span>
          </div>

          {info.statusLines && info.statusLines.length > 0 && (
            <div className="code-status">
              <div className="code-k">{T('code.changes')}</div>
              <pre>{info.statusLines.join('\n')}</pre>
            </div>
          )}

          {info.commits && info.commits.length > 0 && (
            <div className="code-commits">
              <div className="code-k">{T('code.commits')}</div>
              <ul>
                {info.commits.map((c) => (
                  <li key={c.hash}><code>{c.hash.slice(0, 7)}</code> {c.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="code-diff">
        <div className="code-k">{T('code.diff')}</div>
        <div className="code-diff-grid">
          <textarea value={diffOld} onChange={(e) => setDiffOld(e.target.value)} placeholder="old text…" />
          <textarea value={diffNew} onChange={(e) => setDiffNew(e.target.value)} placeholder="new text…" />
        </div>
        <button onClick={runDiff}>{T('code.diff.run')}</button>
        {diffRes && (
          <div className="code-diff-out">
            {diffRes.hunks.map((h, i) => <div key={i} className={'diff-' + h.type}>{h.text}</div>)}
            <div className="muted">−{diffRes.removed} +{diffRes.added}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Built-in Browser ----------
export const PANE_TAB_META = [
  { id: 'review', label: 'Review', icon: 'File' },
  { id: 'subagents', label: 'Subagents', icon: 'GitBranch' },
  { id: 'files', label: 'Files', icon: 'Files' },
  { id: 'terminal', label: 'Terminal', icon: 'CommandLine' },
  { id: 'browser', label: 'Browser', icon: 'Globe' },
  { id: 'runlog', label: 'Background Tasks', icon: 'Activity' },
  { id: 'env', label: 'Environment', icon: 'DotsHorizontal' },
];

export function SubagentsPane({ subAgents = [], swarmInfo = null, swarmBoard = [] }) {
  const counts = { active: 0, done: 0, error: 0 };
  for (const a of subAgents) {
    if (a.status === 'running' || a.status === 'working' || a.status === 'waiting' || a.status === 'queued') counts.active++;
    else if (a.status === 'error') counts.error++;
    else counts.done++;
  }
  return (
    <div className="subagents-pane">
      <div className="sa-summary">
        <div className="sa-summary-title">
          <Icon name="GitBranch" size={15} />
          <span>Subagents</span>
          <span className="sa-count-pill">{subAgents.length}</span>
        </div>
        <div className="sa-summary-stats">
          {counts.active > 0 && <span className="mc-pill working">{counts.active} active</span>}
          {counts.done > 0 && <span className="mc-pill done">{counts.done} completed</span>}
          {counts.error > 0 && <span className="mc-pill err">{counts.error} error</span>}
        </div>
      </div>
      {subAgents.length === 0 && !swarmInfo ? (
        <div className="sa-empty">
          <Icon name="AgentsSimple" size={28} />
          <div className="sa-empty-title">No subagents yet in this turn</div>
          <div className="sa-empty-sub">When the agent delegates subtasks (`Task` / `Agent`) or starts a Swarm wave, every worker, model, failover, and board message appears here.</div>
        </div>
      ) : (
        <MissionControl subAgents={subAgents} swarmInfo={swarmInfo} swarmBoard={swarmBoard} />
      )}
    </div>
  );
}

// ---------- Session pane (Antigravity tabbed right pane) ----------
export function SessionPane({ icon, title, activeType, openTabs = [], onSelectTab, onCloseTab, badges = {}, width, onWidth, onHide, children }) {
  const dragRef = useRef(null);
  const startX = useRef(0);
  const startW = useRef(0);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef(null);
  useDismiss(addOpen, [addRef], () => setAddOpen(false));

  const onDragStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (ev) => {
      const dx = startX.current - ev.clientX; // drag left widens, right narrows
      onWidth(Math.max(320, Math.min(900, startW.current + dx)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('pane-resizing');
    };
    document.body.classList.add('pane-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const tabIds = openTabs && openTabs.length ? openTabs : (activeType ? [activeType] : []);

  return (
    <div className="session-pane" style={{ width }}>
      <div ref={dragRef} className="session-pane-divider" onMouseDown={onDragStart} title="Drag to resize" />
      <div className="session-pane-head">
        <div className="sp-tab-strip">
          {tabIds.length > 0 ? tabIds.map((tid) => {
            const meta = PANE_TAB_META.find((m) => m.id === tid) || { id: tid, label: title, icon };
            const badge = badges[tid];
            return (
              <div
                key={tid}
                className={'sp-tab' + (tid === activeType ? ' on' : '')}
                onClick={() => onSelectTab && onSelectTab(tid)}
                title={meta.label}
              >
                <Icon name={meta.icon} size={13} />
                <span className="sp-tab-label">{meta.label}</span>
                {badge > 0 && <span className="sp-tab-badge">{badge}</span>}
                <button
                  type="button"
                  className="sp-tab-x"
                  onClick={(e) => { e.stopPropagation(); if (onCloseTab) onCloseTab(tid); else if (onHide) onHide(); }}
                  title={'Close ' + meta.label}
                  aria-label={'Close ' + meta.label}
                >
                  <Icon name="X" size={11} />
                </button>
              </div>
            );
          }) : (
            <div className="sp-tab on">
              <Icon name={icon} size={14} />
              <span className="sp-tab-label">{title}</span>
              <button
                type="button"
                className="sp-tab-x"
                onClick={(e) => { e.stopPropagation(); if (onHide) onHide(); }}
                title={'Close ' + title}
                aria-label={'Close ' + title}
              >
                <Icon name="X" size={11} />
              </button>
            </div>
          )}
          <div className="sp-add-wrap" ref={addRef}>
            <button
              type="button"
              className={'icon-btn sp-add-btn' + (addOpen ? ' active' : '')}
              onClick={() => setAddOpen((v) => !v)}
              title="Open view tab (Review, Subagents, Files, Terminal, Browser)"
            >
              <Icon name="Add" size={14} />
            </button>
            {addOpen && (
              <div className="sp-add-menu">
                {PANE_TAB_META.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={'sp-add-item' + (m.id === activeType ? ' on' : '')}
                    onClick={() => { setAddOpen(false); onSelectTab && onSelectTab(m.id); }}
                  >
                    <Icon name={m.icon} size={13} />
                    <span>{m.label}</span>
                    {badges[m.id] > 0 && <span className="conv-pop-count">{badges[m.id]}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button type="button" className="icon-btn session-pane-hide" onClick={(e) => { e.stopPropagation(); onHide && onHide(); }} title={'Close ' + title} aria-label={'Close ' + title}><Icon name="X" size={15} /></button>
      </div>
      <div className="session-pane-body">{children}</div>
    </div>
  );
}

// ---------- Subscription model list (Claude Max / ChatGPT / Antigravity / Grok) ----------
// A signed-in account can expose dozens of models — Antigravity returns 38 — which
// used to render as one flat, unscrollable column that buried the current pick.
// Group them by family, add a filter once the list gets long, cap the height with
// its own scroll, and scroll the active model into view on open.
export function ProvModelList({ list, picked, onPick }) {
  const [q, setQ] = useState('');
  const boxRef = useRef(null);
  const selRef = useRef(null);

  // Grouping rule: the provider (this menu's account) is the ONLY shelf — the
  // same convention opencode uses. Sub-shelves by model family would re-slice a
  // single provider into Gemini/Claude/… headers, so instead every model in the
  // account renders in one natural-sorted list and the model's serving family
  // shows up as an inline tag only when the account mixes families.
  const famLabel = (g) => {
    const s = String(g || '').trim();
    if (!s) return '';
    const api = s.match(/^API_PROVIDER_([A-Za-z0-9_]+)$/);
    if (api) {
      const known = { openai: 'OpenAI', vertex: 'Vertex', anthropic: 'Anthropic', google: 'Google', azure: 'Azure' };
      return api[1].toLowerCase().split('_').filter(Boolean)
        .map((p) => known[p] || p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const { rows, total, mixed } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all = [];
    const fams = new Set();
    for (const raw of list || []) {
      const m = typeof raw === 'string' ? { id: raw, label: raw } : (raw || {});
      const id = String(m.id || '');
      if (!id) continue;
      const label = String(m.label || id);
      const fam = famLabel(m.group);
      if (fam) fams.add(fam);
      if (query && !(id.toLowerCase().includes(query) || label.toLowerCase().includes(query))) continue;
      all.push({ ...m, id, label, fam });
    }
    all.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
    return { rows: all, total: (list || []).length, mixed: fams.size > 1 };
  }, [list, q]);

  // Bring the selected model into view once the catalog has populated.
  useEffect(() => {
    const el = selRef.current, box = boxRef.current;
    if (!el || !box) return;
    const eb = el.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (eb.top < bb.top || eb.bottom > bb.bottom) {
      box.scrollTop += (eb.top - bb.top) - (box.clientHeight - el.offsetHeight) / 2;
    }
  }, [picked, total]);
  return (
    <div className="prov-models">
      {total > 12 && (
        <div className="prov-search">
          <Icon name="Search" size={12} />
          <input
            className="prov-search-in"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Filter ${total} models…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && <button className="prov-search-x" onClick={() => setQ('')} title="Clear"><Icon name="X" size={11} /></button>}
        </div>
      )}
      <div className="prov-model-scroll" ref={boxRef}>
        {!total && <div className="prov-none">Loading models…</div>}
        {total > 0 && !rows.length && <div className="prov-none">No models match “{q}”.</div>}
        {rows.map((m) => {
          const on = picked === m.id;
          return (
            <button
              key={m.id}
              ref={on ? selRef : null}
              className={'model-opt prov-model' + (on ? ' on' : '')}
              title={m.id + (m.windowLabel ? ' · ' + m.windowLabel + ' context' : '')}
              onClick={() => onPick(m.id)}
            >
              <span className="model-opt-name">{m.label}</span>
              {m.tag && <span className="prov-model-tag">{m.tag}</span>}
              {mixed && m.fam && <span className="prov-model-fam">{m.fam}</span>}
              {on && <Icon name="Check" size={13} className="model-check" />}
              <span className="model-opt-prov">{m.windowLabel || ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Session model list (presets + locally-installed catalogs) ----------
// The FreeLLMAPI router alone contributes ~1050 installed models, and the menu
// used to render every one of them as a flat row in a 340 px box. Same shell as
// the subscription list: group by provider, filter when long, one capped scroll,
// and put the group holding the current pick first so it is visible on open.
const SESSION_SHELF_CAP = 30;

export function SessionModelList({ rows, isActive, renderRow }) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState({});
  const boxRef = useRef(null);
  const selRef = useRef(null);

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const buckets = new Map();
    for (const r of rows || []) {
      if (query) {
        const hay = (String(r.label || '') + ' ' + String(r.model || '') + ' ' + String(r.prov || '') + ' ' + String((r.preset && r.preset.name) || '')).toLowerCase();
        if (!hay.includes(query)) continue;
      }
      const fam = String(r.prov || 'Other').replace(/\s*·\s*installed$/, '');
      if (!buckets.has(fam)) buckets.set(fam, { fam, installed: false, items: [] });
      const g = buckets.get(fam);
      if (/·\s*installed$/.test(String(r.prov || ''))) g.installed = true;
      g.items.push(r);
    }
    const list = Array.from(buckets.values());
    // Active group first, otherwise keep preset order (local → paid).
    const ai = list.findIndex((g) => g.items.some((r) => isActive(r)));
    if (ai > 0) list.unshift(list.splice(ai, 1)[0]);
    return list;
  }, [rows, q]);

  const total = (rows || []).length;
  const searching = !!q.trim();

  // A router catalog can be 1000+ models. Mounting all of them inside one
  // scroll box makes the shelf 35 000 px tall and the menu unusable, so each
  // shelf mounts a bounded slice — the current pick is pinned to the top of
  // its slice when it would otherwise fall outside it — and "Show all" opens
  // the rest on demand. A filter query lifts the cap.
  const shelf = (g) => {
    const cap = searching ? 400 : (expanded[g.fam] ? Infinity : SESSION_SHELF_CAP);
    if (!isFinite(cap) || g.items.length <= cap) return { shown: g.items, hidden: 0 };
    const ai = g.items.findIndex((r) => isActive(r));
    if (ai >= cap) {
      return { shown: [g.items[ai], ...g.items.slice(0, cap - 1)], hidden: g.items.length - cap, pinned: true };
    }
    return { shown: g.items.slice(0, cap), hidden: g.items.length - cap };
  };

  useEffect(() => {
    const el = selRef.current, box = boxRef.current;
    if (!el || !box) return;
    const eb = el.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (eb.top < bb.top || eb.bottom > bb.bottom) {
      box.scrollTop += (eb.top - bb.top) - (box.clientHeight - el.offsetHeight) / 2;
    }
  }, [q, total, expanded]);

  return (
    <>
      {total > 12 && (
        <div className="prov-search">
          <Icon name="Search" size={12} />
          <input
            className="prov-search-in"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Filter ${total} models…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && <button className="prov-search-x" onClick={() => setQ('')} title="Clear"><Icon name="X" size={11} /></button>}
        </div>
      )}
      <div className="prov-model-scroll" ref={boxRef}>
        {total > 0 && !groups.length && <div className="prov-none">No models match “{q}”.</div>}
        {groups.map((g) => {
          const { shown, hidden, pinned } = shelf(g);
          return (
            <div key={g.fam} className="prov-fam">
              <div className="prov-fam-head">
                <span className="prov-fam-name">{g.fam}</span>
                {g.installed && <span className="prov-model-tag">installed</span>}
                <span className="prov-fam-count">{g.items.length}</span>
              </div>
              {shown.map((r) => {
                const active = isActive(r);
                const node = renderRow(r);
                if (!active) return node;
                return React.cloneElement(node, { ref: selRef });
              })}
              {hidden > 0 && (
                <button className="prov-more" onClick={() => setExpanded((e) => ({ ...e, [g.fam]: true }))}>
                  Show all {g.items.length}{pinned ? ' · current pick pinned above' : ''}
                </button>
              )}
              {!hidden && expanded[g.fam] && g.items.length > SESSION_SHELF_CAP && !searching && (
                <button className="prov-more" onClick={() => setExpanded((e) => ({ ...e, [g.fam]: false }))}>
                  Show fewer
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- Input bar (composer) — Example parity: model-selector pill bottom-left, attach + style + think + send right ----------
export const PERM_MODES = [
  { id: 'auto',        title: 'perm.auto',        desc: 'perm.autoDesc',        icon: 'LockOpen' },
  { id: 'ask',         title: 'perm.manual',      desc: 'perm.manualDesc',      icon: 'LockShield' },
  { id: 'acceptEdits', title: 'perm.acceptEdits', desc: 'perm.acceptEditsDesc', icon: 'Lock' },
  { id: 'plan',        title: 'perm.plan',        desc: 'perm.planDesc',        icon: 'Sliders' },
  { id: 'bypass',      title: 'perm.bypass',      desc: 'perm.bypassDesc',      icon: 'Keyboard' },
];
export const PERM_SHORT = { auto: 'perm.auto', ask: 'perm.manual', acceptEdits: 'perm.acceptEdits', plan: 'perm.plan', bypass: 'perm.bypass' };

export const BUILTIN_MENTION_AGENTS = [
  { name: 'verifier', kind: 'agent', description: 'Run independent tests & adversarial build verification' },
  { name: 'code-reviewer', kind: 'agent', description: 'Review pending changes for bugs, security & conventions' },
  { name: 'Explore', kind: 'agent', description: 'Fast codebase search & architecture trace subagent' },
  { name: 'Plan', kind: 'agent', description: 'Read-only planning & design subagent' },
];

export function EnvironmentPicker({ envState, onSwitchEnvironment, onOpenEnvironments }) {
  const [open, setOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [sshQuery, setSshQuery] = useState('');
  const wrapRef = useRef(null);
  useDismiss(open, [wrapRef], () => { setOpen(false); setSshOpen(false); setRemoteOpen(false); });

  const active = (envState && envState.active) || { kind: 'local', id: null, label: 'This Computer' };
  const isRemote = active.kind === 'ssh' || active.kind === 'remote';
  const sshAll = [
    ...((envState && envState.sshConfigHosts) || []),
    ...((envState && envState.sshProfiles) || []),
  ];
  const sshFiltered = sshQuery.trim()
    ? sshAll.filter((h) => (`${h.name} ${h.host} ${h.username}`).toLowerCase().includes(sshQuery.trim().toLowerCase()))
    : sshAll;
  const remotes = (envState && envState.remoteProfiles) || [];

  return (
    <div className="env-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={'env-picker-btn' + (isRemote ? ' remote' : '')}
        onClick={() => { setOpen((v) => !v); setSshOpen(false); setRemoteOpen(false); }}
        title="Switch execution environment (This Computer · SSH Host · Remote Server)"
      >
        <span className={'env-status-dot' + (isRemote ? ' on' : '')} />
        <Icon name={active.kind === 'remote' ? 'Globe' : (active.kind === 'ssh' ? 'CommandLine' : 'Window')} size={12} />
        <span>{active.label || 'This Computer'}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div className="env-menu" role="menu">
          <button
            type="button"
            className={'env-menu-row' + (active.kind === 'local' ? ' on' : '')}
            onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'local' }); setOpen(false); }}
          >
            <Icon name="Window" size={14} />
            <div className="env-menu-row-meta">
              <span className="env-menu-row-title">This Computer</span>
              <span className="env-menu-row-sub">Runs on this machine</span>
            </div>
            {active.kind === 'local' && <Icon name="Check" size={13} />}
          </button>

          <button
            type="button"
            className={'env-menu-row' + (active.kind === 'remote' || remoteOpen ? ' on' : '')}
            onClick={() => { setRemoteOpen((v) => !v); setSshOpen(false); }}
          >
            <Icon name="Globe" size={14} />
            <div className="env-menu-row-meta">
              <span className="env-menu-row-title">Remote</span>
              <span className="env-menu-row-sub">{remotes.length ? `${remotes.length} configured server(s)` : 'Runs in a cloud environment'}</span>
            </div>
            <span style={{ opacity: 0.65 }}>›</span>
          </button>

          <button
            type="button"
            className={'env-menu-row' + (active.kind === 'ssh' || sshOpen ? ' on' : '')}
            onClick={() => { setSshOpen((v) => !v); setRemoteOpen(false); }}
          >
            <Icon name="CommandLine" size={14} />
            <div className="env-menu-row-meta">
              <span className="env-menu-row-title">SSH Host</span>
              <span className="env-menu-row-sub">{sshAll.length ? `${sshAll.length} host(s) available` : 'Connect via SSH'}</span>
            </div>
            <span style={{ opacity: 0.65 }}>›</span>
          </button>

          {sshOpen && (
            <div className="env-flyout">
              <div className="env-flyout-search">
                <Icon name="Search" size={12} />
                <input
                  value={sshQuery}
                  onChange={(e) => setSshQuery(e.target.value)}
                  placeholder="Search Hosts..."
                  autoFocus
                />
              </div>
              {sshFiltered.some((h) => h.source === 'ssh-config') && (
                <div className="env-flyout-sect">SSH Config</div>
              )}
              {sshFiltered.filter((h) => h.source === 'ssh-config').map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={'env-menu-row' + (active.kind === 'ssh' && active.id === h.id ? ' on' : '')}
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'ssh', id: h.id, cwd: h.remoteCwd || '' }); setOpen(false); }}
                >
                  <Icon name="CommandLine" size={13} />
                  <div className="env-menu-row-meta">
                    <span className="env-menu-row-title">{h.name}</span>
                    <span className="env-menu-row-sub">{h.username ? `${h.username}@` : ''}{h.host}</span>
                  </div>
                  {active.kind === 'ssh' && active.id === h.id && <Icon name="Check" size={12} />}
                </button>
              ))}
              {sshFiltered.some((h) => h.source !== 'ssh-config') && (
                <div className="env-flyout-sect">Saved Hosts</div>
              )}
              {sshFiltered.filter((h) => h.source !== 'ssh-config').map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={'env-menu-row' + (active.kind === 'ssh' && active.id === h.id ? ' on' : '')}
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'ssh', id: h.id, cwd: h.remoteCwd || '' }); setOpen(false); }}
                >
                  <Icon name="CommandLine" size={13} />
                  <div className="env-menu-row-meta">
                    <span className="env-menu-row-title">{h.name}</span>
                    <span className="env-menu-row-sub">{h.username ? `${h.username}@` : ''}{h.host}</span>
                  </div>
                  {active.kind === 'ssh' && active.id === h.id && <Icon name="Check" size={12} />}
                </button>
              ))}
              <div className="env-sep" />
              <button
                type="button"
                className="env-menu-row"
                onClick={() => { setOpen(false); onOpenEnvironments && onOpenEnvironments(); }}
              >
                <Icon name="Add" size={13} />
                <span className="env-menu-row-title">Connect to SSH Host...</span>
              </button>
            </div>
          )}

          {remoteOpen && (
            <div className="env-flyout">
              <div className="env-flyout-sect">Remote Servers</div>
              {remotes.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={'env-menu-row' + (active.kind === 'remote' && active.id === r.id ? ' on' : '')}
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'remote', id: r.id, cwd: r.remoteCwd || '' }); setOpen(false); }}
                >
                  <Icon name="Globe" size={13} />
                  <div className="env-menu-row-meta">
                    <span className="env-menu-row-title">{r.name}</span>
                    <span className="env-menu-row-sub">{r.url}</span>
                  </div>
                  {active.kind === 'remote' && active.id === r.id && <Icon name="Check" size={12} />}
                </button>
              ))}
              <div className="env-sep" />
              <button
                type="button"
                className="env-menu-row"
                onClick={() => { setOpen(false); onOpenEnvironments && onOpenEnvironments(); }}
              >
                <Icon name="Add" size={13} />
                <span className="env-menu-row-title">Connect to Remote Server...</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const ToolCard = React.memo(ToolCardInner);
export const ToolGroup = React.memo(ToolGroupInner);
export const ChatView = React.memo(ChatViewInner);
