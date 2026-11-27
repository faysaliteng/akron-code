import React, { useState } from 'react';

export function filterQueueForConv(queue, convId) {
  if (!Array.isArray(queue) || !convId) return [];
  return queue.filter((item) => item && item.convId === convId);
}

export function pickNextRunnableQueued(queue, pausedByConv = {}) {
  if (!Array.isArray(queue) || queue.length === 0) {
    return { next: null, rest: [] };
  }
  const map = pausedByConv && typeof pausedByConv === 'object' ? pausedByConv : {};
  const idx = queue.findIndex((item) => {
    if (!item || item.paused) return false;
    if (item.convId && map[item.convId]) return false;
    return true;
  });
  if (idx === -1) return { next: null, rest: queue };
  const picked = queue[idx];
  const rest = [];
  for (let i = 0; i < queue.length; i++) {
    if (i === idx) continue;
    const item = queue[i];
    // Collapse consecutive exact duplicate text-only messages queued for the same conversation.
    if (
      picked
      && item
      && (!picked.atts || picked.atts.length === 0)
      && (!item.atts || item.atts.length === 0)
      && String(item.convId || '') === String(picked.convId || '')
      && String(item.text || '') === String(picked.text || '')
      && !item.paused
    ) {
      continue;
    }
    rest.push(item);
  }
  return {
    next: picked,
    rest,
  };
}

export function moveQueueItem(queue, fromId, toId) {
  if (!Array.isArray(queue) || !fromId || !toId || fromId === toId) return queue;
  const fromIdx = queue.findIndex((x) => x.id === fromId);
  const toIdx = queue.findIndex((x) => x.id === toId);
  if (fromIdx === -1 || toIdx === -1) return queue;
  const next = queue.slice();
  const [moved] = next.splice(fromIdx, 1);
  next.splice(toIdx, 0, moved);
  return next;
}

export function stepQueueItemWithinConv(queue, id, delta) {
  if (!Array.isArray(queue) || !id || !delta) return queue;
  const target = queue.find((x) => x.id === id);
  if (!target) return queue;
  const sameConvIndices = [];
  queue.forEach((x, idx) => {
    if (x.convId === target.convId) sameConvIndices.push(idx);
  });
  const globalPos = queue.findIndex((x) => x.id === id);
  const posInConv = sameConvIndices.indexOf(globalPos);
  const swapInConv = posInConv + (delta > 0 ? 1 : -1);
  if (swapInConv < 0 || swapInConv >= sameConvIndices.length) return queue;
  const otherGlobalPos = sameConvIndices[swapInConv];
  const next = queue.slice();
  const tmp = next[globalPos];
  next[globalPos] = next[otherGlobalPos];
  next[otherGlobalPos] = tmp;
  return next;
}

export default function MessageQueueTray({
  items = [],
  queuePaused = false,
  streaming = false,
  onToggleQueuePaused,
  onClearAll,
  onToggleItemPaused,
  onReorder,
  onStepItem,
  onUpdateItemText,
  onSendNow,
  onDeleteItem,
}) {
  const [dragId, setDragId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState('');

  if (!items || items.length === 0) return null;

  const startEdit = (item) => {
    setEditingId(item.id);
    setEditDraft(item.text || '');
  };

  const commitEdit = (item) => {
    const trimmed = String(editDraft || '').trim();
    if (trimmed && onUpdateItemText) {
      onUpdateItemText(item.id, trimmed);
    }
    setEditingId(null);
    setEditDraft('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft('');
  };

  return (
    <div className={`queue-bar ${queuePaused ? 'is-paused' : ''}`} data-testid="message-queue-tray">
      <div className="queue-bar-head">
        <div className="queue-bar-head-left">
          <span className={`queue-status-dot ${queuePaused ? 'paused' : 'active'}`} />
          <span className="queue-bar-title">
            {queuePaused ? `Queue paused (${items.length})` : `Queued (${items.length})`}
          </span>
          <span className="queue-bar-sub">
            {queuePaused
              ? 'Paused — click Resume Queue to auto-dispatch'
              : streaming
                ? 'Next unpaused item auto-sends when turn completes'
                : 'Ready to dispatch next unpaused item'}
          </span>
        </div>
        <div className="queue-bar-head-actions">
          <button
            type="button"
            className={`queue-head-btn ${queuePaused ? 'is-resume' : ''}`}
            onClick={onToggleQueuePaused}
            title={queuePaused ? 'Resume auto-sending queued messages' : 'Pause entire queue'}
          >
            {queuePaused ? '▶ Resume Queue' : '⏸ Pause Queue'}
          </button>
          <button
            type="button"
            className="queue-head-btn queue-head-clear"
            onClick={onClearAll}
            title="Clear all queued messages for this conversation"
          >
            Clear All
          </button>
        </div>
      </div>

      <div className="queue-list">
        {items.map((item, idx) => {
          const isEditing = editingId === item.id;
          const isDragOver = dragOverId === item.id && dragId !== item.id;
          const isFirst = idx === 0;
          const isLast = idx === items.length - 1;
          return (
            <div
              key={item.id}
              className={`queue-chip ${item.paused ? 'is-item-paused' : ''} ${isDragOver ? 'is-drag-over' : ''}`}
              draggable={!isEditing}
              onDragStart={(e) => {
                setDragId(item.id);
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', item.id);
                }
              }}
              onDragOver={(e) => {
                if (!dragId || dragId === item.id) return;
                e.preventDefault();
                if (dragOverId !== item.id) setDragOverId(item.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const src = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
                if (src && src !== item.id && onReorder) onReorder(src, item.id);
                setDragId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDragId(null);
                setDragOverId(null);
              }}
            >
              <span className="queue-drag-handle" title="Drag to reorder" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="queue-index-badge">{idx + 1}</span>
              {item.paused && (
                <span className="queue-paused-pill" title="This queued message is paused">
                  Paused
                </span>
              )}

              {isEditing ? (
                <div className="queue-edit-wrap">
                  <textarea
                    className="queue-edit-input"
                    rows={2}
                    value={editDraft}
                    autoFocus
                    onChange={(e) => setEditDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        commitEdit(item);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                  />
                  <div className="queue-edit-actions">
                    <button type="button" className="queue-mini-btn primary" onClick={() => commitEdit(item)}>
                      Save
                    </button>
                    <button type="button" className="queue-mini-btn" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <span className="queue-chip-text" onDoubleClick={() => startEdit(item)} title={item.text}>
                  {item.text || '(attachments only)'}
                  {item.atts && item.atts.length > 0 && (
                    <span className="queue-atts-pill">+{item.atts.length} file{item.atts.length > 1 ? 's' : ''}</span>
                  )}
                </span>
              )}

              {!isEditing && (
                <div className="queue-chip-actions">
                  <button
                    type="button"
                    className="queue-icon-btn"
                    disabled={isFirst}
                    onClick={() => onStepItem && onStepItem(item.id, -1)}
                    title="Move up"
                    aria-label="Move queued message up"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="queue-icon-btn"
                    disabled={isLast}
                    onClick={() => onStepItem && onStepItem(item.id, 1)}
                    title="Move down"
                    aria-label="Move queued message down"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className={`queue-chip-btn ${item.paused ? 'is-resume' : ''}`}
                    onClick={() => onToggleItemPaused && onToggleItemPaused(item.id)}
                    title={item.paused ? 'Resume this item' : 'Pause this item'}
                  >
                    {item.paused ? 'Resume' : 'Pause'}
                  </button>
                  <button
                    type="button"
                    className="queue-chip-btn"
                    onClick={() => startEdit(item)}
                    title="Edit queued message"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="queue-chip-btn accent"
                    onClick={() => onSendNow && onSendNow(item.id)}
                    title={streaming ? 'Interrupt current run and send this message now' : 'Send this message immediately'}
                  >
                    Send now
                  </button>
                  <button
                    type="button"
                    className="queue-icon-btn danger"
                    onClick={() => onDeleteItem && onDeleteItem(item.id)}
                    title="Delete from queue"
                    aria-label="Delete queued message"
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
