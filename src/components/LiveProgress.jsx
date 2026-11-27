import React, { useState, useEffect, useMemo } from 'react';

function fmtSecs(secs) {
  const s = Math.max(0, Math.round(Number(secs) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem ? `${m}m ${rem}s` : `${m}m`;
}

function fmtBytesLabel(bytes) {
  const b = Number(bytes) || 0;
  if (!b) return '';
  if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
  return b + ' B';
}

function fmtElapsedPrecise(ms) {
  const m = Math.max(0, Number(ms) || 0);
  if (m < 60000) return (m / 1000).toFixed(1) + 's';
  return fmtSecs(m / 1000);
}

const TOOL_VERBS = {
  Write: 'Writing',
  Edit: 'Editing',
  MultiEdit: 'Editing',
  StrReplace: 'Editing',
  Read: 'Reading',
  Bash: 'Running',
  Glob: 'Finding files',
  Grep: 'Searching',
  LS: 'Listing',
  WebFetch: 'Fetching',
  WebSearch: 'Searching web',
  Task: 'Delegating',
  Agent: 'Delegating',
  Swarm: 'Swarming',
};

function toolTargetHint(name, args, fallbackTarget) {
  if (fallbackTarget) return String(fallbackTarget);
  const a = args || {};
  const raw = a.file_path || a.path || a.filePath || a.filename || a.command || a.cmd || a.description || a.pattern || a.query || a.url || '';
  const s = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.includes('/') && !/\s/.test(s)) {
    const parts = s.replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.slice(-2).join('/') || s;
  }
  return s.length > 72 ? s.slice(0, 69) + '…' : s;
}

export function LiveToolActivityCard({ tools = [], streamingTool = null, paused = false, describeTool, Icon }) {
  const [expanded, setExpanded] = useState(true);
  const running = [...(tools || [])].reverse().find((t) => t && t.status === 'running') || null;
  const active = Boolean(running || (streamingTool && streamingTool.name));
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || paused) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [active, paused]);

  if (!active) return null;

  const toolName = (running && running.name) || (streamingTool && streamingTool.name) || 'Working';
  const sameToolStream = streamingTool && (!running || streamingTool.id === running.id || streamingTool.name === running.name)
    ? streamingTool
    : null;
  const d = describeTool && running ? describeTool(running.name, running.args) : null;
  const verb = (d && d.verb) || TOOL_VERBS[toolName] || toolName;
  const target = (d && d.target) || toolTargetHint(toolName, running && running.args, sameToolStream && sameToolStream.target);

  const rawArgsContent = running && running.args
    ? (running.args.content || running.args.new_string || running.args.command || '')
    : '';
  const bytes = (sameToolStream && sameToolStream.bytes)
    || (running && running.liveBytes)
    || (rawArgsContent ? String(rawArgsContent).length : 0);
  const lines = (sameToolStream && sameToolStream.lines)
    || (running && running.liveLines)
    || (rawArgsContent ? countLines(rawArgsContent) : 0);
  const preview = (sameToolStream && sameToolStream.preview)
    || (running && running.livePreview)
    || (rawArgsContent ? String(rawArgsContent).slice(-480) : '');
  const startedAt = (running && running.startedAt) || (sameToolStream && sameToolStream.startedAt) || now;
  const elapsed = Math.max(0, now - startedAt);
  const kbLabel = fmtBytesLabel(bytes);

  return (
    <div className="live-tool-card" data-tool-name={toolName}>
      <div className="live-tool-head">
        <span className="live-tool-pulse" aria-hidden="true" />
        <span className="live-dots-loader" aria-hidden="true"><i /><i /><i /><i /></span>
        <div className="live-tool-main">
          <span className="activity-text live-tool-verb">{paused ? `${verb} (paused)` : `${verb}…`}</span>
          {target && <span className="live-tool-target" title={target}>{target}</span>}
        </div>
        <div className="live-tool-meta">
          {kbLabel && <span>{kbLabel}</span>}
          {lines > 0 && <span>{lines} lines</span>}
          <span className="live-tool-time">{fmtElapsedPrecise(elapsed)}</span>
        </div>
        {preview && (
          <button
            type="button"
            className="live-tool-toggle"
            title={expanded ? 'Hide live output' : 'Show live output'}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? 'CaretUp' : 'CaretDown'} size={12} />
          </button>
        )}
      </div>
      {preview && expanded && (
        <div className="live-tool-preview">
          <pre>{preview}</pre>
        </div>
      )}
    </div>
  );
}

export function StickyLiveToolBar({ live, thinking, startedAt, paused, onJumpToLive, Icon }) {
  const [now, setNow] = useState(() => Date.now());
  const active = Boolean(live);
  useEffect(() => {
    if (!active || paused) return;
    const t = setInterval(() => setNow(Date.now()), 300);
    return () => clearInterval(t);
  }, [active, paused]);
  if (!active) return null;

  const tools = live.tools || [];
  const running = [...tools].reverse().find((t) => t && t.status === 'running');
  const st = live.streamingTool;
  const name = (running && running.name) || (st && st.name) || '';
  const verb = paused ? 'Paused' : (name ? (TOOL_VERBS[name] || name) + '…' : (thinking ? 'Thinking…' : 'Working…'));
  const target = name ? toolTargetHint(name, running && running.args, st && st.target) : '';
  const bytes = (st && st.bytes) || (running && running.liveBytes) || 0;
  const kbLabel = fmtBytesLabel(bytes);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;

  return (
    <div className="sticky-live-bar" onClick={onJumpToLive} role="status" aria-live="polite">
      <div className="sticky-live-left">
        <span className="live-tool-pulse" aria-hidden="true" />
        <span className="live-dots-loader" aria-hidden="true"><i /><i /><i /><i /></span>
        <span className="activity-text live-tool-verb">{verb}</span>
        {target && <span className="live-tool-target">{target}</span>}
        {kbLabel && <span className="live-tool-meta">{kbLabel}</span>}
        {elapsed > 0 && <span className="live-tool-meta">{fmtElapsedPrecise(elapsed)}</span>}
      </div>
      <span className="sticky-live-jump">
        <Icon name="ArrowDown" size={11} /> Jump to live
      </span>
    </div>
  );
}

function countLines(s) {
  const t = String(s == null ? '' : s);
  if (!t) return 0;
  return t.split('\n').length;
}

function toolDelta(t) {
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

export function summarizeChangedFiles(tools = [], checkpoints = []) {
  const byPath = new Map();
  for (const t of tools || []) {
    if (!t) continue;
    const nm = String(t.name || '');
    if (nm !== 'Write' && nm !== 'Edit' && nm !== 'MultiEdit' && nm !== 'StrReplace') continue;
    const raw = (t.args && (t.args.file_path || t.args.path)) || '';
    if (!raw) continue;
    const key = String(raw);
    const short = key.replace(/\\/g, '/').split('/').slice(-2).join('/') || key;
    const d = toolDelta(t);
    const prev = byPath.get(key) || { path: key, short, added: 0, removed: 0, status: nm === 'Write' ? 'added' : 'modified' };
    prev.added += d.added;
    prev.removed += d.removed;
    if (t.status === 'running') prev.running = true;
    byPath.set(key, prev);
  }
  for (const cp of checkpoints || []) {
    const raw = cp && cp.path ? String(cp.path) : '';
    if (!raw) continue;
    const short = raw.replace(/\\/g, '/').split('/').slice(-2).join('/') || raw;
    const already = [...byPath.values()].some((f) => f.path === raw || raw.endsWith('/' + f.path) || raw.endsWith('\\' + f.path));
    if (!already) {
      byPath.set(raw, { path: raw, short, added: 0, removed: 0, status: cp.existed ? 'modified' : 'added' });
    }
  }
  const files = [...byPath.values()];
  const totalAdded = files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = files.reduce((s, f) => s + f.removed, 0);
  return { files, totalAdded, totalRemoved };
}

export function LiveChecklistCard({ tools = [], subAgents = [], swarmInfo = null, streamingTool = null, streaming = false, durationMs = 0, Icon }) {
  const [open, setOpen] = useState(() => Boolean(streaming));
  useEffect(() => {
    setOpen(Boolean(streaming));
  }, [streaming]);

  const plan = useMemo(() => {
    // 1. Explicit TodoWrite checklist always wins.
    for (let i = (tools || []).length - 1; i >= 0; i--) {
      const t = tools[i];
      if (t && t.name === 'TodoWrite' && t.args && Array.isArray(t.args.todos) && t.args.todos.length) {
        return { explicit: true, items: t.args.todos };
      }
    }
    // 2. While streaming, synthesize Antigravity-style live milestones from real activity.
    if (!streaming || ((tools || []).length === 0 && (subAgents || []).length === 0 && !swarmInfo)) {
      return null;
    }
    const items = [];
    const readCount = tools.filter((t) => /^(Read|Glob|Grep|LS|ListDir)$/i.test(String(t?.name || ''))).length;
    const editRows = tools.filter((t) => /^(Write|Edit|MultiEdit|StrReplace|Artifact)$/i.test(String(t?.name || '')));
    const verifyRows = tools.filter((t) => /^(Bash|mcp__.*|browser_.*|WebSearch|WebFetch|NotebookEdit|computer_.*)$/i.test(String(t?.name || '')));
    const stName = String((streamingTool && streamingTool.name) || '');
    const streamingEdit = /^(Write|Edit|MultiEdit|StrReplace|Artifact)$/i.test(stName);
    const streamingVerify = Boolean(stName) && !/^(Read|Glob|Grep|LS|ListDir|TodoWrite|Write|Edit|MultiEdit|StrReplace|Artifact)$/i.test(stName);
    const anyRunningEdit = editRows.some((t) => t.status === 'running') || streamingEdit;
    const anyRunningVerify = verifyRows.some((t) => t.status === 'running') || streamingVerify;

    items.push({
      content: readCount > 0 ? `Inspect workspace & context (${readCount} reads)` : 'Inspect workspace & context',
      status: tools.length > 0 || subAgents.length > 0 ? 'completed' : 'in_progress',
    });
    if (swarmInfo || subAgents.length > 0) {
      const doneCount = subAgents.filter((a) => a.status === 'done').length;
      const anyActive = subAgents.some((a) => a.status === 'running' || a.status === 'working' || a.status === 'queued' || a.status === 'waiting')
        || (swarmInfo && swarmInfo.phase !== 'done');
      items.push({
        content: swarmInfo
          ? `Run Swarm workers (${doneCount}/${subAgents.length || swarmInfo.taskCount || 0})`
          : `Run sub-agents (${doneCount}/${subAgents.length})`,
        status: anyActive ? 'in_progress' : 'completed',
      });
    }
    items.push({
      content: editRows.length ? `Write & update files (${editRows.length})` : 'Write & update project files',
      status: anyRunningEdit ? 'in_progress' : (editRows.length > 0 ? 'completed' : (verifyRows.length > 0 ? 'completed' : 'in_progress')),
    });
    items.push({
      content: verifyRows.length ? `Verify & run commands (${verifyRows.length})` : 'Run tests & verify build',
      status: anyRunningVerify ? 'in_progress' : (verifyRows.length > 0 ? 'completed' : 'pending'),
    });
    return { explicit: false, items };
  }, [tools, subAgents, swarmInfo, streamingTool, streaming]);

  if (!plan || !plan.items.length) return null;

  const done = plan.items.filter((t) => (t.status || t.state) === 'completed').length;
  const total = plan.items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
  const streamSuffix = streaming && streamingTool && streamingTool.name
    ? ` · ${streamingTool.name}${streamingTool.bytes ? ` (${streamingTool.bytes >= 1024 ? (streamingTool.bytes / 1024).toFixed(1) + ' KB' : streamingTool.bytes + ' B'})` : ''}`
    : '';
  const ratioLabel = (!streaming && done === 0 && plan.explicit) ? `${total} steps` : `${done}/${total} steps`;
  const headText = streaming
    ? `Progress · ${done}/${total} steps${streamSuffix}`
    : `Worked for ${secs ? fmtSecs(secs) + ' · ' : ''}${ratioLabel}`;

  return (
    <div className={'live-plan-card' + (streaming ? ' is-live' : '')}>
      <button type="button" className="live-plan-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span className="live-plan-ico">
          <Icon name={streaming ? 'Spinner' : 'Checklist'} size={14} className={streaming ? 'spin' : ''} />
        </span>
        <span className="live-plan-title">{headText}</span>
        <span className="live-plan-bar" aria-hidden="true">
          <span className="live-plan-fill" style={{ width: `${pct}%` }} />
        </span>
        <span className="live-plan-ratio">{done}/{total}</span>
        <Icon name={open ? 'CaretUp' : 'CaretDown'} size={12} className="live-plan-caret" />
      </button>
      {open && (
        <div className="live-plan-list">
          {plan.items.map((item, idx) => {
            const st = item.status || item.state || 'pending';
            const label = item.content || item.activeForm || item.title || item.text || String(item);
            return (
              <div key={idx} className={'live-plan-row ' + st}>
                <span className="live-plan-mark">
                  {st === 'completed' ? <Icon name="CheckCircle" size={14} /> :
                    st === 'in_progress' ? <span className="live-dots-loader" aria-hidden="true"><i /><i /><i /><i /></span> :
                      <Icon name="Circle" size={13} />}
                </span>
                <span className="live-plan-text">{label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function FilesChangedBar({
  tools = [],
  checkpoints = [],
  checkpointId = null,
  turnLabel = '',
  convId = null,
  subAgentCount = 0,
  taskCount = 0,
  onOpenReview,
  onOpenSubagents,
  onOpenRunLog,
  onRewindDone,
  streaming = false,
  Icon,
}) {
  const [rewinding, setRewinding] = useState(false);
  const [rewindMsg, setRewindMsg] = useState('');
  const summary = useMemo(() => summarizeChangedFiles(tools, checkpoints), [tools, checkpoints]);

  if (!summary.files.length && !subAgentCount && !taskCount) return null;

  const canRewind = Boolean(checkpointId && convId && window.autobot && window.autobot.rewind && !streaming);
  const handleRewind = async (e) => {
    e.stopPropagation();
    if (!canRewind || rewinding) return;
    setRewinding(true);
    setRewindMsg('');
    try {
      const r = await window.autobot.rewind(convId, checkpointId);
      const rest = (r && r.restored) || 0;
      const rem = (r && r.removed) || 0;
      setRewindMsg(`Restored ${rest}, removed ${rem}`);
      if (onRewindDone) onRewindDone(r);
    } catch (err) {
      setRewindMsg(String(err?.message || 'Rewind failed'));
    } finally {
      setRewinding(false);
    }
  };

  return (
    <div className="fcb-wrap">
      {summary.files.length > 0 && (
        <div className={'files-changed-bar' + (streaming ? ' is-live' : '')}>
          <div className="fcb-left">
            <span className="fcb-count">{summary.files.length} {summary.files.length === 1 ? 'file' : 'files'} changed</span>
            {(summary.totalAdded > 0 || summary.totalRemoved > 0) && (
              <span className="fcb-deltas">
                <span className="delta-add">+{summary.totalAdded}</span>
                <span className="delta-del">−{summary.totalRemoved}</span>
              </span>
            )}
            <Icon name="CaretRight" size={11} className="fcb-chev" />
            {(checkpoints && checkpoints.length > 0) && (
              <span className="fcb-cp-badge" title="File state checkpoint saved for safe rewind">
                <Icon name="History" size={11} /> Checkpoint
              </span>
            )}
            {rewindMsg && <span className="fcb-note">{rewindMsg}</span>}
          </div>
          <div className="fcb-actions">
            {canRewind && (
              <button type="button" className="fcb-btn" onClick={handleRewind} disabled={rewinding} title="Rewind files touched in this checkpoint">
                <Icon name="ArrowCounterClockwise" size={12} /> {rewinding ? 'Rewinding…' : 'Rewind'}
              </button>
            )}
            <button
              type="button"
              className="fcb-btn primary"
              onClick={() => onOpenReview && onOpenReview({ tools, checkpoints, checkpointId, turnLabel })}
              title="Open side-by-side Code Review with search & inline comments"
            >
              <Icon name="File" size={12} /> Review
            </button>
          </div>
        </div>
      )}
      {(subAgentCount > 0 || taskCount > 0) && (
        <div className="fcb-submeta">
          {subAgentCount > 0 && (
            <button type="button" className="fcb-meta-link" onClick={() => onOpenSubagents && onOpenSubagents()}>
              <Icon name="GitBranch" size={11} /> {subAgentCount} {subAgentCount === 1 ? 'subagent' : 'subagents'}
            </button>
          )}
          {taskCount > 0 && (
            <button type="button" className="fcb-meta-link" onClick={() => onOpenRunLog && onOpenRunLog()}>
              <span>{taskCount} {taskCount === 1 ? 'task' : 'tasks'}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
