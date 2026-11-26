import React, { useState, useMemo } from 'react';

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
  const [open, setOpen] = useState(true);

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
    const cmdRows = tools.filter((t) => /^(Bash|mcp__terminal__.*)$/i.test(String(t?.name || '')));
    const anyRunningEdit = editRows.some((t) => t.status === 'running');
    const anyRunningCmd = cmdRows.some((t) => t.status === 'running');

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
      status: anyRunningEdit ? 'in_progress' : (editRows.length > 0 ? 'completed' : (cmdRows.length > 0 ? 'completed' : 'in_progress')),
    });
    items.push({
      content: cmdRows.length ? `Verify & run commands (${cmdRows.length})` : 'Run tests & verify build',
      status: anyRunningCmd ? 'in_progress' : (cmdRows.length > 0 ? 'completed' : 'pending'),
    });
    return { explicit: false, items };
  }, [tools, subAgents, swarmInfo, streaming]);

  if (!plan || !plan.items.length) return null;

  const done = plan.items.filter((t) => (t.status || t.state) === 'completed').length;
  const total = plan.items.length;
  const pct = total ? Math.round((done / total) * 100) : 0;
  const secs = durationMs ? Math.max(1, Math.round(durationMs / 1000)) : 0;
  const streamSuffix = streaming && streamingTool && streamingTool.name
    ? ` · ${streamingTool.name}${streamingTool.bytes ? ` (${streamingTool.bytes >= 1024 ? (streamingTool.bytes / 1024).toFixed(1) + ' KB' : streamingTool.bytes + ' B'})` : ''}`
    : '';
  const headText = streaming
    ? `Progress · ${done}/${total} steps${streamSuffix}`
    : `Worked for ${secs ? secs + 's · ' : ''}${done}/${total} steps`;

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
                  {st === 'completed' ? <Icon name="CheckCircleFilled" size={14} /> :
                    st === 'in_progress' ? <Icon name="Spinner" size={13} className="spin" /> :
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
  convId = null,
  onOpenReview,
  onRewindDone,
  streaming = false,
  Icon,
}) {
  const [rewinding, setRewinding] = useState(false);
  const [rewindMsg, setRewindMsg] = useState('');
  const summary = useMemo(() => summarizeChangedFiles(tools, checkpoints), [tools, checkpoints]);

  if (!summary.files.length) return null;

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

  const previewNames = summary.files.slice(0, 3).map((f) => f.short.split('/').pop()).join(', ');

  return (
    <div className={'files-changed-bar' + (streaming ? ' is-live' : '')}>
      <div className="fcb-left">
        <span className="fcb-ico"><Icon name="ChangesPlusMinus" size={14} /></span>
        <span className="fcb-count">{summary.files.length} {summary.files.length === 1 ? 'file' : 'files'} changed</span>
        {(summary.totalAdded > 0 || summary.totalRemoved > 0) && (
          <span className="fcb-deltas">
            <span className="delta-add">+{summary.totalAdded}</span>
            <span className="delta-del">−{summary.totalRemoved}</span>
          </span>
        )}
        <span className="fcb-names" title={summary.files.map((f) => f.path).join('\n')}>
          {previewNames}{summary.files.length > 3 ? ` +${summary.files.length - 3}` : ''}
        </span>
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
          onClick={() => onOpenReview && onOpenReview({ tools, checkpoints, checkpointId })}
          title="Open side-by-side Code Review with search & inline comments"
        >
          <Icon name="GitDiff" size={13} /> Review
        </button>
      </div>
    </div>
  );
}
