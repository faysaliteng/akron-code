import React, { useEffect, useRef, useState } from 'react';

const EDIT_LIKE_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'mcp__workspace__write_file',
  'mcp__workspace__edit_file',
]);

const READ_LIKE_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'NotebookRead',
  'LS',
]);

export function formatMcpToolLabel(toolName) {
  const s = String(toolName || '');
  const m = /^mcp__([^_]+)__(.+)$/.exec(s);
  if (m) return `${m[1]}/${m[2]}`;
  return s;
}

export function describePermissionRequest(req) {
  const tool = String((req && req.tool) || '');
  const args = (req && req.args) || {};
  const summary = String((req && req.summary) || '');

  if (tool === 'Bash') {
    const cmd = args.command || args.cmd || summary || 'bash command';
    return {
      kind: 'command',
      title: 'Allow running this command?',
      preview: String(cmd),
      toolLabel: 'Bash',
    };
  }

  if (tool.startsWith('mcp__') && !EDIT_LIKE_TOOLS.has(tool)) {
    const label = formatMcpToolLabel(tool);
    const argPreview = Object.keys(args).length
      ? ` ${JSON.stringify(args).slice(0, 140)}`
      : '';
    return {
      kind: 'mcp',
      title: 'Allow using this MCP tool?',
      preview: `${label}${argPreview}`,
      toolLabel: label,
    };
  }

  if (EDIT_LIKE_TOOLS.has(tool)) {
    const file = args.file_path || args.path || args.notebook_path || summary || 'file';
    return {
      kind: 'file',
      title: 'Allow editing this file?',
      preview: String(file),
      toolLabel: tool,
    };
  }

  if (READ_LIKE_TOOLS.has(tool)) {
    const target = args.file_path || args.path || args.pattern || args.notebook_path || summary || 'path';
    return {
      kind: 'read',
      title: 'Allow read access to this path?',
      preview: String(target),
      toolLabel: tool,
    };
  }

  return {
    kind: 'tool',
    title: `Allow using ${tool || 'this tool'}?`,
    preview: summary || (Object.keys(args).length ? JSON.stringify(args).slice(0, 180) : tool),
    toolLabel: tool || 'Tool',
  };
}

function isExternalEditable(el, dockEl) {
  if (!el || el === document.body || el === document.documentElement) return false;
  if (dockEl && dockEl.contains(el)) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true;
  if (el.isContentEditable) return true;
  if (el.closest && (el.closest('.monaco-editor') || el.closest('.xterm') || el.closest('.modal-backdrop'))) {
    return true;
  }
  return false;
}

export default function PermissionDock({
  queue = [],
  onRespond,
  errorMsg = '',
  submitting = false,
}) {
  const req = queue && queue.length ? queue[0] : null;
  const [selected, setSelected] = useState(1); // 1 | 2 | 3 | 4
  const [feedback, setFeedback] = useState('');
  const dockRef = useRef(null);
  const feedbackInputRef = useRef(null);

  useEffect(() => {
    setSelected(1);
    setFeedback('');
  }, [req && req.id]);

  useEffect(() => {
    if (!req) return undefined;
    const onKeyDown = (e) => {
      const dockEl = dockRef.current;
      const active = document.activeElement;
      if (isExternalEditable(active, dockEl)) return;

      const inFeedback = feedbackInputRef.current && active === feedbackInputRef.current;

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (!submitting && onRespond) {
          onRespond(req.id, { allow: false, scope: 'once', feedback: '' });
        }
        return;
      }

      if (inFeedback) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopPropagation();
          if (!submitting && onRespond) {
            onRespond(req.id, { allow: false, scope: 'once', feedback: feedback.trim() });
          }
        } else if (e.key === 'ArrowUp' && (!feedback || feedbackInputRef.current.selectionStart === 0)) {
          e.preventDefault();
          feedbackInputRef.current.blur();
          setSelected(3);
        }
        return;
      }

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelected((s) => {
          const next = s >= 4 ? 1 : s + 1;
          if (next === 4) setTimeout(() => feedbackInputRef.current && feedbackInputRef.current.focus(), 0);
          return next;
        });
        return;
      }

      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelected((s) => {
          const next = s <= 1 ? 4 : s - 1;
          if (next === 4) setTimeout(() => feedbackInputRef.current && feedbackInputRef.current.focus(), 0);
          return next;
        });
        return;
      }

      if (e.key === '1' || e.key === '2' || e.key === '3') {
        e.preventDefault();
        const choice = Number(e.key);
        setSelected(choice);
        if (!submitting && onRespond) {
          const scope = choice === 1 ? 'once' : choice === 2 ? 'conversation' : 'always';
          onRespond(req.id, { allow: true, scope, feedback: '' });
        }
        return;
      }

      if (e.key === '4') {
        e.preventDefault();
        setSelected(4);
        setTimeout(() => feedbackInputRef.current && feedbackInputRef.current.focus(), 0);
        return;
      }

      if (e.key === 'Enter') {
        e.preventDefault();
        if (submitting || !onRespond) return;
        if (selected === 1) onRespond(req.id, { allow: true, scope: 'once', feedback: '' });
        else if (selected === 2) onRespond(req.id, { allow: true, scope: 'conversation', feedback: '' });
        else if (selected === 3) onRespond(req.id, { allow: true, scope: 'always', feedback: '' });
        else if (selected === 4) onRespond(req.id, { allow: false, scope: 'once', feedback: feedback.trim() });
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [req, selected, feedback, submitting, onRespond]);

  if (!req) return null;

  const info = describePermissionRequest(req);
  const suggestedRule = req.suggestedRule || null;
  const totalCount = queue.length;

  const choose = (optNum, allow, scope, fb = '') => {
    setSelected(optNum);
    if (submitting || !onRespond) return;
    onRespond(req.id, { allow, scope, feedback: fb });
  };

  return (
    <div
      ref={dockRef}
      className="perm-dock"
      data-testid="permission-dock"
      data-perm-id={req.id}
      tabIndex={-1}
      role="region"
      aria-label="Tool permission prompt"
    >
      <div className="perm-dock-head">
        <div className="perm-dock-title-wrap">
          <span className="perm-dock-icon" aria-hidden="true">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="none">
              <path d="M5.2 6.5V4.8a2.8 2.8 0 0 1 5.6 0v1.7" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" />
              <rect x="3.2" y="6.5" width="9.6" height="7" rx="1.8" stroke="currentColor" strokeWidth="1.35" />
              <circle cx="8" cy="10" r="1" fill="currentColor" />
            </svg>
          </span>
          <span className="perm-dock-title">{info.title}</span>
        </div>
        <div className="perm-dock-meta">
          {totalCount > 1 && (
            <span className="perm-dock-queue-pill" title={`${totalCount} pending permission requests`}>
              1 of {totalCount}
            </span>
          )}
          <span className="perm-dock-kbd-hint">1–4 · ↑↓ · Esc</span>
        </div>
      </div>

      <div className="perm-dock-preview" title={info.preview}>
        <code>{info.preview}</code>
      </div>

      {errorMsg && (
        <div className="perm-dock-error" role="alert">
          {errorMsg}
        </div>
      )}

      <div className="perm-dock-options" role="listbox" aria-label="Permission choices">
        <button
          type="button"
          className={`perm-dock-opt ${selected === 1 ? 'selected' : ''}`}
          disabled={submitting}
          onMouseEnter={() => setSelected(1)}
          onClick={() => choose(1, true, 'once')}
        >
          <span className="perm-dock-num">1</span>
          <span className="perm-dock-opt-label">Yes, allow this time</span>
        </button>

        <button
          type="button"
          className={`perm-dock-opt ${selected === 2 ? 'selected' : ''}`}
          disabled={submitting}
          onMouseEnter={() => setSelected(2)}
          onClick={() => choose(2, true, 'conversation')}
        >
          <span className="perm-dock-num">2</span>
          <span className="perm-dock-opt-label">Yes, and always allow in this conversation</span>
          {suggestedRule ? (
            <code className="perm-dock-rule-chip">{suggestedRule}</code>
          ) : (
            <span className="perm-dock-rule-warn">this run only</span>
          )}
        </button>

        <button
          type="button"
          className={`perm-dock-opt ${selected === 3 ? 'selected' : ''}`}
          disabled={submitting}
          onMouseEnter={() => setSelected(3)}
          onClick={() => choose(3, true, 'always')}
        >
          <span className="perm-dock-num">3</span>
          <span className="perm-dock-opt-label">Yes, and always allow</span>
          {suggestedRule ? (
            <code className="perm-dock-rule-chip">Save {suggestedRule}</code>
          ) : (
            <span className="perm-dock-rule-warn">won&apos;t wildcard unsafe command</span>
          )}
        </button>

        <div
          className={`perm-dock-opt perm-dock-opt-deny ${selected === 4 ? 'selected' : ''}`}
          onMouseEnter={() => setSelected(4)}
          onClick={() => {
            setSelected(4);
            feedbackInputRef.current && feedbackInputRef.current.focus();
          }}
        >
          <span className="perm-dock-num">4</span>
          <span className="perm-dock-deny-prefix">No</span>
          <input
            ref={feedbackInputRef}
            type="text"
            className="perm-dock-feedback-input"
            value={feedback}
            disabled={submitting}
            onFocus={() => setSelected(4)}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="(tell the agent what to do instead)"
            aria-label="Decline permission with optional guidance"
          />
          <div className="perm-dock-deny-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="perm-dock-skip-btn"
              disabled={submitting}
              onClick={() => choose(4, false, 'once', '')}
              title="Decline without note (Esc)"
            >
              Skip
            </button>
            <button
              type="button"
              className="perm-dock-submit-btn"
              disabled={submitting}
              onClick={() => choose(4, false, 'once', feedback.trim())}
              title="Submit response (Enter)"
            >
              Submit ↵
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
