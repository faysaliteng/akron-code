import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';

export const STORAGE_KEY = 'autobot:notifications:v1';
export const MAX_NOTIFICATIONS = 200;
export const TOAST_DURATION_MS = 3800;

/**
 * Strip status emoji prefixes and categorize a notification into a visual kind
 * and semantic category badge.
 */
export function classifyNotification(rawText, opts = {}) {
  const raw = String(rawText || '').trim();
  const explicitKind = opts && opts.kind;
  const cleanText = raw.replace(/^(?:✅|❌)\s*/u, '').trim() || raw;

  let category = (opts && opts.category) || 'System';
  if (!opts || !opts.category) {
    if (/orchestrator model/i.test(raw)) category = 'Orchestrator';
    else if (/compacted|context window|paused after|safety valve/i.test(raw)) category = 'Context';
    else if (/^artifact created/i.test(raw)) category = 'Artifact';
    else if (/^environment:/i.test(raw)) category = 'Environment';
    else if (/^(?:goal:|team monitor)/i.test(raw)) category = 'Agent';
    else if (/update|lsp server|installer/i.test(raw)) category = 'Update';
    else if (/^❌|\berror\b|\bfailed\b|\bblocked\b|\bdenied\b|\brejected\b/i.test(raw)) category = 'Error';
  }

  let kind = explicitKind || 'info';
  if (!explicitKind) {
    if (/^❌|\berror\b|\bfailed\b|\bblocked\b|\bdenied\b|\brejected\b/i.test(raw)) {
      kind = 'error';
    } else if (/orchestrator model|compacted|context window|paused after|safety valve/i.test(raw)) {
      kind = 'warning';
    } else if (/^✅|copied|saved|installed|complete|ready|forked|rewound/i.test(raw)) {
      kind = 'success';
    } else {
      kind = 'info';
    }
  }

  return { kind, category, text: cleanText };
}

/**
 * Prepend a notification entry, coalescing consecutive identical messages so
 * repeated events increment a compact counter instead of flooding the log.
 */
export function appendNotificationEntry(prevList, rawText, opts = {}, now = Date.now()) {
  const s = String(rawText || '').trim();
  if (!s) return { list: Array.isArray(prevList) ? prevList : [], entry: null };

  const prev = Array.isArray(prevList) ? prevList : [];
  const { kind, category, text } = classifyNotification(s, opts);
  if (!text) return { list: prev, entry: null };

  const head = prev[0];
  if (head && head.text === text && head.kind === kind) {
    const updatedHead = {
      ...head,
      count: (Number(head.count) || 1) + 1,
      createdAt: now,
      read: false,
    };
    return {
      list: [updatedHead, ...prev.slice(1)],
      entry: updatedHead,
    };
  }

  const entry = {
    id: 'n_' + now + '_' + Math.random().toString(36).slice(2, 7),
    kind,
    category,
    text,
    createdAt: now,
    read: false,
    count: 1,
  };
  return {
    list: [entry, ...prev].slice(0, MAX_NOTIFICATIONS),
    entry,
  };
}

/**
 * Format timestamp into compact relative labels for toasts and log rows.
 */
export function formatRelativeTime(ts, now = Date.now()) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const diffSec = Math.max(0, Math.floor((now - n) / 1000));
  if (diffSec < 15) return 'just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  try {
    return new Date(n).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch (_) {
    return `${Math.floor(diffHr / 24)}d ago`;
  }
}

function loadStoredNotifications() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX_NOTIFICATIONS) : [];
  } catch (_) {
    return [];
  }
}

/**
 * Persistent notification state hook managing the top-right bell badge,
 * transient top-right toast, and filterable notification log drawer.
 */
export function useNotificationCenter() {
  const [items, setItems] = useState(loadStoredNotifications);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [activeToast, setActiveToast] = useState(null);
  const [toastHovered, setToastHovered] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const drawerOpenRef = useRef(drawerOpen);
  drawerOpenRef.current = drawerOpen;

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, MAX_NOTIFICATIONS)));
    } catch (_) {}
  }, [items]);

  useEffect(() => {
    if (!activeToast || toastHovered) return;
    const t = setTimeout(() => {
      setActiveToast((cur) => (cur && cur.id === activeToast.id && cur.createdAt === activeToast.createdAt ? null : cur));
    }, TOAST_DURATION_MS);
    return () => clearTimeout(t);
  }, [activeToast, toastHovered]);

  const dismissToast = useCallback(() => {
    setActiveToast(null);
    setToastHovered(false);
  }, []);

  const pushNotification = useCallback((rawText, opts = {}) => {
    const res = appendNotificationEntry(itemsRef.current, rawText, opts, Date.now());
    if (!res.entry) return;
    itemsRef.current = res.list;
    setItems(res.list);
    if (!drawerOpenRef.current) {
      setActiveToast(res.entry);
    }
  }, []);

  const markRead = useCallback((id) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, read: true } : it)));
  }, []);

  const toggleRead = useCallback((id) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, read: !it.read } : it)));
  }, []);

  const markAllRead = useCallback(() => {
    setItems((prev) => prev.map((it) => (it.read ? it : { ...it, read: true })));
  }, []);

  const removeItem = useCallback((id) => {
    setItems((prev) => prev.filter((it) => it.id !== id));
    setExpandedId((cur) => (cur === id ? null : cur));
    setActiveToast((cur) => (cur && cur.id === id ? null : cur));
  }, []);

  const clearAll = useCallback(() => {
    setItems([]);
    setExpandedId(null);
    setActiveToast(null);
  }, []);

  const unreadCount = useMemo(() => items.filter((i) => !i.read).length, [items]);
  const highestUnreadKind = useMemo(() => {
    let hasWarn = false;
    for (const it of items) {
      if (it.read) continue;
      if (it.kind === 'error') return 'error';
      if (it.kind === 'warning') hasWarn = true;
    }
    return hasWarn ? 'warning' : 'info';
  }, [items]);

  return {
    items,
    unreadCount,
    highestUnreadKind,
    drawerOpen,
    setDrawerOpen,
    activeToast,
    toastHovered,
    setToastHovered,
    expandedId,
    setExpandedId,
    dismissToast,
    pushNotification,
    markRead,
    toggleRead,
    markAllRead,
    removeItem,
    clearAll,
  };
}

function severityIconName(kind) {
  if (kind === 'success') return 'CheckCircle';
  if (kind === 'warning') return 'WarningCircle';
  if (kind === 'error') return 'XCircle';
  return 'Info';
}

export function NotificationCenter({
  items,
  unreadCount,
  highestUnreadKind,
  drawerOpen,
  setDrawerOpen,
  activeToast,
  setToastHovered,
  expandedId,
  setExpandedId,
  dismissToast,
  markRead,
  toggleRead,
  markAllRead,
  removeItem,
  clearAll,
  Icon,
}) {
  const [filter, setFilter] = useState('all'); // 'all' | 'unread' | 'alerts'
  const [copiedId, setCopiedId] = useState(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const anchorRef = useRef(null);
  const drawerRef = useRef(null);

  useEffect(() => {
    if (!drawerOpen) return;
    setNowTick(Date.now());
    const interval = setInterval(() => setNowTick(Date.now()), 30000);
    const onMouseDown = (e) => {
      if (anchorRef.current && anchorRef.current.contains(e.target)) return;
      if (drawerRef.current && drawerRef.current.contains(e.target)) return;
      setDrawerOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      clearInterval(interval);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen, setDrawerOpen]);

  const alertCount = useMemo(
    () => items.filter((it) => it.kind === 'warning' || it.kind === 'error').length,
    [items],
  );

  const filteredItems = useMemo(() => {
    if (filter === 'unread') return items.filter((it) => !it.read);
    if (filter === 'alerts') return items.filter((it) => it.kind === 'warning' || it.kind === 'error');
    return items;
  }, [items, filter]);

  const copyItem = (it, e) => {
    e.stopPropagation();
    try {
      navigator.clipboard?.writeText(it.text);
      setCopiedId(it.id);
      setTimeout(() => setCopiedId((cur) => (cur === it.id ? null : cur)), 1400);
    } catch (_) {}
  };

  return (
    <>
      <div className="notif-center-anchor" ref={anchorRef}>
        <button
          type="button"
          className={'notif-bell-btn' + (drawerOpen ? ' on' : '') + (unreadCount > 0 ? ' has-unread' : '')}
          aria-label="Notifications"
          aria-expanded={drawerOpen}
          title={unreadCount ? `${unreadCount} unread notification${unreadCount === 1 ? '' : 's'}` : 'Notifications'}
          onClick={() => {
            setDrawerOpen((v) => !v);
            dismissToast();
          }}
        >
          <Icon name="Notification" size={14} />
          {unreadCount > 0 && (
            <span className={'notif-badge ' + highestUnreadKind}>
              {unreadCount > 99 ? '99+' : unreadCount}
            </span>
          )}
        </button>
      </div>

      {activeToast && !drawerOpen && (
        <div
          className={'notif-toast-pop kind-' + activeToast.kind}
          role="status"
          aria-live="polite"
          onMouseEnter={() => setToastHovered(true)}
          onMouseLeave={() => setToastHovered(false)}
        >
          <span className={'notif-kind-ico kind-' + activeToast.kind}>
            <Icon name={severityIconName(activeToast.kind)} size={14} />
          </span>
          <button
            type="button"
            className="notif-toast-main"
            title="View in Notification Center"
            onClick={() => {
              markRead(activeToast.id);
              setExpandedId(activeToast.id);
              dismissToast();
              setDrawerOpen(true);
            }}
          >
            <span className="notif-toast-cat-row">
              <span className="notif-toast-cat">{activeToast.category}</span>
              {activeToast.count > 1 && <span className="notif-count-pill">×{activeToast.count}</span>}
            </span>
            <span className="notif-toast-text">{activeToast.text}</span>
          </button>
          <button
            type="button"
            className="notif-toast-x"
            title="Dismiss notification"
            aria-label="Dismiss notification"
            onClick={dismissToast}
          >
            <Icon name="X" size={12} />
          </button>
        </div>
      )}

      {drawerOpen && (
        <div className="notif-drawer" ref={drawerRef} role="dialog" aria-label="Notification center">
          <div className="notif-drawer-head">
            <div className="notif-drawer-title-group">
              <span className="notif-drawer-title">Notifications</span>
              {unreadCount > 0 && <span className="notif-unread-pill">{unreadCount} unread</span>}
            </div>
            <div className="notif-drawer-actions">
              <button
                type="button"
                className="notif-head-btn"
                disabled={unreadCount === 0}
                title="Mark all as read"
                onClick={markAllRead}
              >
                <Icon name="CheckDouble" size={13} />
                <span>Mark all read</span>
              </button>
              <button
                type="button"
                className="notif-head-btn danger"
                disabled={items.length === 0}
                title="Clear notification log"
                onClick={clearAll}
              >
                <Icon name="Trash" size={13} />
                <span>Clear</span>
              </button>
            </div>
          </div>

          <div className="notif-filter-tabs" role="tablist" aria-label="Notification filters">
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'all'}
              className={'notif-filter-tab' + (filter === 'all' ? ' on' : '')}
              onClick={() => setFilter('all')}
            >
              All ({items.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'unread'}
              className={'notif-filter-tab' + (filter === 'unread' ? ' on' : '')}
              onClick={() => setFilter('unread')}
            >
              Unread ({unreadCount})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={filter === 'alerts'}
              className={'notif-filter-tab' + (filter === 'alerts' ? ' on' : '')}
              onClick={() => setFilter('alerts')}
            >
              Alerts ({alertCount})
            </button>
          </div>

          <div className="notif-list">
            {filteredItems.length === 0 ? (
              <div className="notif-empty">
                <Icon name="Notification" size={20} />
                <span>
                  {filter === 'unread'
                    ? 'No unread notifications'
                    : filter === 'alerts'
                      ? 'No warning or error alerts'
                      : 'No notifications yet'}
                </span>
              </div>
            ) : (
              filteredItems.map((it) => {
                const isExpanded = expandedId === it.id;
                return (
                  <div
                    key={it.id}
                    className={
                      'notif-item kind-' + it.kind + (it.read ? ' read' : ' unread') + (isExpanded ? ' expanded' : '')
                    }
                    onClick={() => {
                      markRead(it.id);
                      setExpandedId(isExpanded ? null : it.id);
                    }}
                  >
                    <div className="notif-item-top">
                      <div className="notif-item-meta">
                        {!it.read && <span className="notif-unread-dot" aria-label="Unread" />}
                        <span className={'notif-kind-ico kind-' + it.kind}>
                          <Icon name={severityIconName(it.kind)} size={13} />
                        </span>
                        <span className="notif-item-cat">{it.category}</span>
                        {it.count > 1 && <span className="notif-count-pill">×{it.count}</span>}
                        <span className="notif-item-time">{formatRelativeTime(it.createdAt, nowTick)}</span>
                      </div>
                      <div className="notif-item-actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="notif-item-btn"
                          title={it.read ? 'Mark as unread' : 'Mark as read'}
                          aria-label={it.read ? 'Mark as unread' : 'Mark as read'}
                          onClick={() => toggleRead(it.id)}
                        >
                          <Icon name="Check" size={12} />
                        </button>
                        <button
                          type="button"
                          className="notif-item-btn"
                          title={copiedId === it.id ? 'Copied' : 'Copy text'}
                          aria-label="Copy notification"
                          onClick={(e) => copyItem(it, e)}
                        >
                          <Icon name={copiedId === it.id ? 'Check' : 'Copy'} size={12} />
                        </button>
                        <button
                          type="button"
                          className="notif-item-btn"
                          title="Remove"
                          aria-label="Remove notification"
                          onClick={() => removeItem(it.id)}
                        >
                          <Icon name="X" size={12} />
                        </button>
                      </div>
                    </div>
                    <div className="notif-item-body">{it.text}</div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </>
  );
}
