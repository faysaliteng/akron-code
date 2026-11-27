import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Icon } from '../Icon.jsx';

export function formatRelativeAge(ts, now = Date.now()) {
  const n = Number(ts) || 0;
  if (!n) return '';
  const diffSec = Math.max(0, Math.floor((now - n) / 1000));
  if (diffSec < 60) return 'just now';
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

function projectNameFromCwd(cwd) {
  if (!cwd) return 'General Workspace';
  const clean = String(cwd).replace(/[\\/]+$/, '');
  const seg = clean.split(/[\\/]/).pop();
  return seg || clean;
}

export function ProjectsSidebar({
  convs = [],
  projects = [],
  activeId,
  panel,
  streaming,
  streamingConvId,
  streamingConvIds,
  sessionHealthMap = {},
  waitingPermissionConvIds = new Set(),
  pinnedProjectCwds = [],
  onTogglePinProject,
  onSelectConv,
  onNewChatInProject,
  onDeleteConv,
  onTogglePinConv,
  onRenameConv,
  onArchiveConv,
  onOpenProjectSettings,
  onUnstickConv,
}) {
  const [menuConvId, setMenuConvId] = useState(null);
  const [renamingConvId, setRenamingConvId] = useState(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [hoverInfo, setHoverInfo] = useState(null);
  const [collapsedGroups, setCollapsedGroups] = useState({});
  const treeRef = useRef(null);

  useEffect(() => {
    if (!menuConvId) return undefined;
    const onDocDown = (e) => {
      if (e.target && e.target.closest && e.target.closest('.conv-menu-pop, .conv-menu-trigger')) return;
      setMenuConvId(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setMenuConvId(null);
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuConvId]);

  const commitRename = (cid) => {
    const trimmed = String(renameDraft || '').trim();
    if (trimmed && onRenameConv) onRenameConv(cid, trimmed);
    setRenamingConvId(null);
    setRenameDraft('');
  };

  const pinnedSet = useMemo(() => new Set(Array.isArray(pinnedProjectCwds) ? pinnedProjectCwds : []), [pinnedProjectCwds]);

  const groups = useMemo(() => {
    const byKey = new Map();
    const ensureGroup = (key, label, cwd, projectObj = null) => {
      if (!byKey.has(key)) {
        byKey.set(key, {
          key,
          label,
          cwd: cwd || '',
          pinned: pinnedSet.has(key) || !!(projectObj && projectObj.pinned),
          project: projectObj,
          convs: [],
        });
      }
      return byKey.get(key);
    };

    for (const p of (Array.isArray(projects) ? projects : [])) {
      if (!p) continue;
      const key = p.cwd || p.id || p.name;
      ensureGroup(key, p.name || projectNameFromCwd(p.cwd), p.cwd || '', p);
    }

    const sortedConvs = [...convs].sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return (b.updatedAt || b.ts || 0) - (a.updatedAt || a.ts || 0);
    });

    for (const c of sortedConvs) {
      const key = c.cwd || c.projectId || '__general__';
      const label = c.projectName || (c.cwd ? projectNameFromCwd(c.cwd) : 'Conversations');
      ensureGroup(key, label, c.cwd || '', null).convs.push(c);
    }

    return [...byKey.values()].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return b.convs.length - a.convs.length;
    });
  }, [convs, projects, pinnedSet]);

  return (
    <div ref={treeRef} className="proj-tree" data-testid="projects-sidebar">
      {groups.map((grp) => {
        const isCollapsed = !!collapsedGroups[grp.key];
        return (
          <div key={grp.key} className="proj-group">
            <div
              className="proj-group-head"
              onClick={() => setCollapsedGroups((m) => ({ ...m, [grp.key]: !m[grp.key] }))}
            >
              <Icon name={grp.pinned ? 'FolderFilled' : 'Folder'} size={13} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{grp.label}</span>
              <div className="proj-group-actions" onClick={(e) => e.stopPropagation()}>
                {onTogglePinProject && (
                  <button
                    type="button"
                    className="proj-mini-btn"
                    title={grp.pinned ? 'Unpin project' : 'Pin project'}
                    onClick={() => onTogglePinProject(grp.key)}
                  >
                    <Icon name={grp.pinned ? 'PinFilled' : 'Pin'} size={11} />
                  </button>
                )}
                {onOpenProjectSettings && (
                  <button
                    type="button"
                    className="proj-mini-btn"
                    title="Project Settings & 20k Token Budget"
                    onClick={() => onOpenProjectSettings(grp)}
                  >
                    <Icon name="Settings" size={11} />
                  </button>
                )}
                {onNewChatInProject && (
                  <button
                    type="button"
                    className="proj-mini-btn"
                    title={`New conversation in ${grp.label}`}
                    data-testid="proj-new-chat-btn"
                    onClick={() => onNewChatInProject(grp.cwd, grp.project)}
                  >
                    <Icon name="Add" size={12} />
                  </button>
                )}
              </div>
            </div>

            {!isCollapsed && grp.convs.map((c) => {
              const isWorking = !!(
                (streamingConvIds && typeof streamingConvIds.has === 'function' && streamingConvIds.has(c.id))
                || (streaming && (streamingConvId === c.id || (!streamingConvId && c.id === activeId)))
              );
              const sh = sessionHealthMap[c.id];
              const hStatus = sh && (sh.status === 'bad' || sh.status === 'warn' || sh.status === 'ok') ? sh.status : 'ok';
              const lastMsg = Array.isArray(c.messages) && c.messages.length ? c.messages[c.messages.length - 1] : null;
              const relTime = formatRelativeAge(c.updatedAt || c.ts);
              return (
                <div
                  key={c.id}
                  className={'conv proj-conv-row ' + (c.id === activeId && panel === 'chats' ? 'on ' : '') + (menuConvId === c.id ? 'menu-open' : '')}
                  onClick={() => { if (renamingConvId !== c.id) onSelectConv(c.id); }}
                  onMouseEnter={(e) => {
                    if (menuConvId || renamingConvId) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHoverInfo({
                      top: Math.max(48, Math.min(window.innerHeight - 160, rect.top)),
                      title: c.title || 'Untitled',
                      cwd: c.cwd || grp.label,
                      model: c.model || '',
                      msgCount: Array.isArray(c.messages) ? c.messages.length : 0,
                      snippet: lastMsg && typeof lastMsg.content === 'string' ? lastMsg.content.slice(0, 120) : 'Empty conversation',
                      working: isWorking,
                    });
                  }}
                  onMouseLeave={() => setHoverInfo(null)}
                >
                  {isWorking ? (
                    <span className="pulse-4dot" title="Agent working">
                      <span /><span /><span /><span />
                    </span>
                  ) : (
                    <>
                      {c.pinned && <span className="conv-pin" title="Pinned"><Icon name="Pin" size={11} /></span>}
                      <span className={'health-dot ' + hStatus} title={sh ? `Health: ${hStatus} (${sh.score})` : 'Healthy'} />
                    </>
                  )}
                  {renamingConvId === c.id ? (
                    <input
                      type="text"
                      className="conv-rename-input"
                      data-testid="conv-rename-input"
                      value={renameDraft}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === 'Enter') { e.preventDefault(); commitRename(c.id); }
                        else if (e.key === 'Escape') { e.preventDefault(); setRenamingConvId(null); setRenameDraft(''); }
                      }}
                      onBlur={() => commitRename(c.id)}
                    />
                  ) : (
                    <div className="conv-title">{c.title || 'Untitled'}</div>
                  )}
                  {(hStatus === 'bad' || hStatus === 'warn') && onUnstickConv && (
                    <button
                      type="button"
                      className="btn-mini"
                      style={{ padding: '1px 5px', fontSize: 10 }}
                      onClick={(e) => { e.stopPropagation(); onUnstickConv(c.id, sh); }}
                    >Unstick</button>
                  )}
                  {waitingPermissionConvIds.has(c.id) && (
                    <span className="conv-perm-bell" title="Waiting for approval">
                      <Icon name="Notification" size={11} />
                    </span>
                  )}
                  {relTime && <span className="conv-rel-time">{relTime}</span>}
                  <button
                    type="button"
                    className="proj-mini-btn conv-menu-trigger"
                    title="Conversation options"
                    aria-label="Conversation options"
                    aria-expanded={menuConvId === c.id}
                    onClick={(e) => {
                      e.stopPropagation();
                      setHoverInfo(null);
                      setMenuConvId((cur) => (cur === c.id ? null : c.id));
                    }}
                  >
                    <Icon name="DotsVertical" size={12} />
                  </button>
                  {menuConvId === c.id && (
                    <div className="conv-menu-pop" role="menu" onClick={(e) => e.stopPropagation()}>
                      {onTogglePinConv && (
                        <button type="button" role="menuitem" onClick={() => { setMenuConvId(null); onTogglePinConv(c.id); }}>
                          <Icon name={c.pinned ? 'PinSlash' : 'Pin'} size={13} />
                          <span>{c.pinned ? 'Unpin conversation' : 'Pin conversation'}</span>
                        </button>
                      )}
                      {onRenameConv && (
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuConvId(null);
                            setHoverInfo(null);
                            setRenameDraft(c.title || '');
                            setRenamingConvId(c.id);
                          }}
                        >
                          <Icon name="Edit" size={13} />
                          <span>Rename…</span>
                        </button>
                      )}
                      {onArchiveConv && (
                        <button type="button" role="menuitem" onClick={() => { setMenuConvId(null); onArchiveConv(c.id); }}>
                          <Icon name="Archive" size={13} />
                          <span>{c.archived ? 'Unarchive conversation' : 'Archive conversation'}</span>
                        </button>
                      )}
                      <div className="conv-menu-sep" />
                      <button type="button" role="menuitem" className="danger" onClick={() => { setMenuConvId(null); onDeleteConv(c.id); }}>
                        <Icon name="Trash" size={13} />
                        <span>Delete conversation</span>
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}

      {hoverInfo && !menuConvId && !renamingConvId && (
        <div className="proj-hover-card" style={{ top: hoverInfo.top }} data-testid="proj-hover-card">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <strong style={{ fontSize: 12.5, color: 'var(--text-000)' }}>{hoverInfo.title}</strong>
            {hoverInfo.working && <span className="token-badge-scope global">Active</span>}
          </div>
          <div className="muted" style={{ fontSize: 11, margin: '0 0 6px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {hoverInfo.cwd} · {hoverInfo.msgCount} msg{hoverInfo.msgCount === 1 ? '' : 's'}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-200)', lineHeight: 1.4 }}>{hoverInfo.snippet}</div>
        </div>
      )}
    </div>
  );
}
