import React, { useState, useMemo } from 'react';
import { shortcutLabels } from './shortcuts';

function badgeForRel(relPath, statusMap) {
  if (!relPath || !statusMap) return null;
  return statusMap.get(relPath) || null;
}

function TreeNode({
  node,
  depth,
  activeFile,
  statusMap,
  expanded,
  onToggleDir,
  onOpenFile,
  onContextMenu,
}) {
  const isOpen = !!expanded[node.path];
  const isActive = !node.isDir && activeFile === node.path;
  const gitStatus = !node.isDir ? badgeForRel(node.relPath, statusMap) : null;

  return (
    <div>
      <div
        className={'ide-tree-row' + (isActive ? ' active' : '') + (gitStatus ? ` git-${gitStatus.toLowerCase()}` : '')}
        style={{ paddingLeft: `${8 + depth * 13}px` }}
        draggable={!node.isDir}
        onDragStart={(e) => {
          if (node.isDir) return;
          e.dataTransfer.setData('text/akron-file', JSON.stringify({ path: node.path, relPath: node.relPath, name: node.name }));
          e.dataTransfer.setData('text/plain', `@${node.relPath}`);
        }}
        onClick={() => (node.isDir ? onToggleDir(node.path) : onOpenFile(node.path))}
        onContextMenu={(e) => onContextMenu(e, node)}
        title={node.relPath}
      >
        <span className="ide-tree-caret">{node.isDir ? (isOpen ? '▾' : '▸') : ''}</span>
        <span className="ide-tree-ico">{node.isDir ? (isOpen ? '📂' : '📁') : '📄'}</span>
        <span className="ide-tree-name">{node.name}</span>
        {gitStatus && <span className={'ide-git-badge ' + gitStatus.toLowerCase()}>{gitStatus}</span>}
      </div>
      {node.isDir && isOpen && Array.isArray(node.children) && node.children.map((ch) => (
        <TreeNode
          key={ch.path}
          node={ch}
          depth={depth + 1}
          activeFile={activeFile}
          statusMap={statusMap}
          expanded={expanded}
          onToggleDir={onToggleDir}
          onOpenFile={onOpenFile}
          onContextMenu={onContextMenu}
        />
      ))}
    </div>
  );
}

export function FileTree({
  cwd,
  nodes = [],
  gitStatus = null,
  activeFile = null,
  onOpenFile,
  onRefresh,
  onPickFolder,
  onAddToChat,
  onNotify,
  Icon,
}) {
  const [expanded, setExpanded] = useState({});
  const [ctxMenu, setCtxMenu] = useState(null); // { x, y, node }
  const [modalPrompt, setModalPrompt] = useState(null); // { kind: 'newFile'|'newFolder'|'rename', targetPath, parentDir, value }

  const statusMap = useMemo(() => {
    const m = new Map();
    if (!gitStatus) return m;
    for (const f of gitStatus.untracked || []) m.set(f.relPath, 'U');
    for (const f of gitStatus.staged || []) m.set(f.relPath, f.status || 'M');
    for (const f of gitStatus.unstaged || []) m.set(f.relPath, f.status || 'M');
    return m;
  }, [gitStatus]);

  const toggleDir = (p) => setExpanded((prev) => ({ ...prev, [p]: !prev[p] }));

  const handleContext = (e, node) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, node });
  };

  const parentOf = (node) => {
    if (!node) return cwd;
    if (node.isDir) return node.path;
    const idx = Math.max(node.path.lastIndexOf('/'), node.path.lastIndexOf('\\'));
    return idx > 0 ? node.path.slice(0, idx) : cwd;
  };

  const submitPrompt = async () => {
    if (!modalPrompt || !modalPrompt.value.trim()) { setModalPrompt(null); return; }
    const val = modalPrompt.value.trim();
    if (modalPrompt.kind === 'newFile' || modalPrompt.kind === 'newFolder') {
      const sep = modalPrompt.parentDir.includes('\\') ? '\\' : '/';
      const target = `${modalPrompt.parentDir}${sep}${val}`;
      const r = await window.autobot.ideCreateEntry({ path: target, kind: modalPrompt.kind === 'newFolder' ? 'dir' : 'file' });
      if (r && r.ok) {
        if (modalPrompt.kind === 'newFile' && onOpenFile) onOpenFile(r.path);
        onRefresh && onRefresh();
      } else onNotify && onNotify('❌ ' + (r?.error || 'Create failed'));
    } else if (modalPrompt.kind === 'rename') {
      const idx = Math.max(modalPrompt.targetPath.lastIndexOf('/'), modalPrompt.targetPath.lastIndexOf('\\'));
      const dir = idx > 0 ? modalPrompt.targetPath.slice(0, idx) : cwd;
      const sep = modalPrompt.targetPath.includes('\\') ? '\\' : '/';
      const next = `${dir}${sep}${val}`;
      const r = await window.autobot.ideRenameEntry({ oldPath: modalPrompt.targetPath, newPath: next });
      if (r && r.ok) onRefresh && onRefresh();
      else onNotify && onNotify('❌ ' + (r?.error || 'Rename failed'));
    }
    setModalPrompt(null);
  };

  const wsName = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Workspace';

  return (
    <div className="ide-panel" onClick={() => ctxMenu && setCtxMenu(null)}>
      <div className="ide-panel-head">
        <span className="ide-panel-title" title={cwd}>{wsName}</span>
        <div className="ide-panel-actions">
          <button
            type="button"
            className="ide-icon-btn"
            title="New File"
            onClick={() => setModalPrompt({ kind: 'newFile', parentDir: cwd, value: '' })}
          >
            <Icon name="FileAdd" size={13} />
          </button>
          <button
            type="button"
            className="ide-icon-btn"
            title="New Folder"
            onClick={() => setModalPrompt({ kind: 'newFolder', parentDir: cwd, value: '' })}
          >
            <Icon name="FolderPlus" size={13} />
          </button>
          <button type="button" className="ide-icon-btn" title="Refresh Explorer" onClick={onRefresh}>
            <Icon name="Refresh" size={13} />
          </button>
          <button type="button" className="ide-icon-btn" title="Collapse All" onClick={() => setExpanded({})}>
            <Icon name="Collapse" size={13} />
          </button>
          <button type="button" className="ide-icon-btn" title="Open Folder…" onClick={onPickFolder}>
            <Icon name="FolderOpen" size={13} />
          </button>
        </div>
      </div>

      {modalPrompt && (
        <div className="ide-inline-prompt">
          <input
            autoFocus
            value={modalPrompt.value}
            placeholder={modalPrompt.kind === 'rename' ? 'New name…' : (modalPrompt.kind === 'newFolder' ? 'folder-name' : 'file.js')}
            onChange={(e) => setModalPrompt((p) => ({ ...p, value: e.target.value }))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitPrompt();
              if (e.key === 'Escape') setModalPrompt(null);
            }}
          />
          <button type="button" onClick={submitPrompt}>OK</button>
          <button type="button" onClick={() => setModalPrompt(null)}>×</button>
        </div>
      )}

      <div
        className="ide-tree-scroll"
        onContextMenu={(e) => handleContext(e, { isDir: true, path: cwd, name: wsName, relPath: '' })}
      >
        {nodes.length === 0 ? (
          <div className="ide-empty-note">Empty folder or no workspace open.</div>
        ) : nodes.map((n) => (
          <TreeNode
            key={n.path}
            node={n}
            depth={0}
            activeFile={activeFile}
            statusMap={statusMap}
            expanded={expanded}
            onToggleDir={toggleDir}
            onOpenFile={onOpenFile}
            onContextMenu={handleContext}
          />
        ))}
      </div>

      {ctxMenu && (
        <div
          className="ide-ctx-menu"
          style={{ left: Math.min(ctxMenu.x, window.innerWidth - 190), top: Math.min(ctxMenu.y, window.innerHeight - 250) }}
          onClick={(e) => e.stopPropagation()}
        >
          <button type="button" onClick={() => { const pd = parentOf(ctxMenu.node); setCtxMenu(null); setModalPrompt({ kind: 'newFile', parentDir: pd, value: '' }); }}>New File…</button>
          <button type="button" onClick={() => { const pd = parentOf(ctxMenu.node); setCtxMenu(null); setModalPrompt({ kind: 'newFolder', parentDir: pd, value: '' }); }}>New Folder…</button>
          {ctxMenu.node.relPath && (
            <>
              <div className="ide-ctx-sep" />
              <button type="button" onClick={() => { const n = ctxMenu.node; setCtxMenu(null); setModalPrompt({ kind: 'rename', targetPath: n.path, value: n.name }); }}>Rename…</button>
              <button type="button" onClick={async () => { const p = ctxMenu.node.path; setCtxMenu(null); await window.autobot.ideDuplicateEntry({ path: p }); onRefresh && onRefresh(); }}>Duplicate</button>
              <button type="button" className="danger" onClick={async () => { const p = ctxMenu.node.path; setCtxMenu(null); await window.autobot.ideDeleteEntry({ path: p }); onRefresh && onRefresh(); }}>Delete</button>
              <div className="ide-ctx-sep" />
              <button type="button" onClick={() => { navigator.clipboard?.writeText(ctxMenu.node.path).catch(() => {}); setCtxMenu(null); }}>Copy Path</button>
              <button type="button" onClick={() => { window.autobot.ideRevealInOS({ path: ctxMenu.node.path }); setCtxMenu(null); }}>{shortcutLabels().revealLabel}</button>
              {!ctxMenu.node.isDir && (
                <button type="button" onClick={() => { onAddToChat && onAddToChat(ctxMenu.node); setCtxMenu(null); }}>Add @file to Agent</button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
