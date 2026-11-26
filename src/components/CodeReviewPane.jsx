import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useVoiceDictation } from '../voice';

function fallbackDiffsFromTools(tools = []) {
  const byPath = new Map();
  for (const t of tools || []) {
    if (!t) continue;
    const nm = String(t.name || '');
    if (nm !== 'Write' && nm !== 'Edit' && nm !== 'MultiEdit' && nm !== 'StrReplace') continue;
    const a = t.args || {};
    const p = String(a.file_path || a.path || '');
    if (!p) continue;
    const cur = byPath.get(p) || { path: p, relPath: p.split('/').slice(-2).join('/'), status: nm === 'Write' ? 'added' : 'modified', added: 0, removed: 0, lines: [] };
    if (nm === 'Write') {
      const arr = String(a.content || '').split('\n');
      arr.forEach((txt, idx) => {
        cur.lines.push({ type: 'add', oldLine: null, newLine: idx + 1, text: txt });
        cur.added++;
      });
    } else {
      const edits = Array.isArray(a.edits) ? a.edits : [{ old_string: a.old_string ?? a.old_str ?? '', new_string: a.new_string ?? a.new_str ?? '' }];
      let ln = 1;
      for (const e of edits) {
        const dels = String(e.old_string ?? '').split('\n');
        const adds = String(e.new_string ?? '').split('\n');
        dels.forEach((txt) => { cur.lines.push({ type: 'del', oldLine: ln++, newLine: null, text: txt }); cur.removed++; });
        adds.forEach((txt, i) => { cur.lines.push({ type: 'add', oldLine: null, newLine: i + 1, text: txt }); cur.added++; });
      }
    }
    byPath.set(p, cur);
  }
  return [...byPath.values()];
}

function groupDiffChunks(lines = []) {
  // Collapse runs of unchanged ('ctx') lines longer than 7 into { kind:'fold', start, end, count }
  const out = [];
  const CONTEXT = 3;
  const n = lines.length;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (lines[i].type !== 'ctx') {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(n - 1, i + CONTEXT); k++) keep[k] = 1;
    }
  }
  let i = 0;
  while (i < n) {
    if (keep[i] || lines[i].type !== 'ctx') {
      out.push({ kind: 'line', idx: i, line: lines[i] });
      i++;
    } else {
      const start = i;
      while (i < n && !keep[i] && lines[i].type === 'ctx') i++;
      if (i - start <= 2) {
        for (let k = start; k < i; k++) out.push({ kind: 'line', idx: k, line: lines[k] });
      } else {
        out.push({ kind: 'fold', id: `fold-${start}-${i}`, start, end: i, count: i - start, lines: lines.slice(start, i) });
      }
    }
  }
  return out;
}

function extBadge(p) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(p || ''));
  return m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
}

function highlightLine(text, matcher) {
  if (!matcher) return text;
  try {
    const parts = [];
    let last = 0;
    const rx = new RegExp(matcher.source, matcher.flags.includes('g') ? matcher.flags : matcher.flags + 'g');
    let m;
    while ((m = rx.exec(text)) !== null) {
      if (m[0].length === 0) { rx.lastIndex++; continue; }
      if (m.index > last) parts.push(text.slice(last, m.index));
      parts.push(<mark key={m.index + ':' + last} className="rv-hit">{m[0]}</mark>);
      last = m.index + m[0].length;
    }
    if (!parts.length) return text;
    if (last < text.length) parts.push(text.slice(last));
    return parts;
  } catch {
    return text;
  }
}

export function CodeReviewPane({ convId, cwd, target, allTools = [], onSendComment, onRewindDone, voiceOpts = {}, Icon }) {
  const [scope, setScope] = useState(target && target.checkpointId ? 'turn' : 'all'); // 'turn' | 'all'
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [expandedFolds, setExpandedFolds] = useState({});

  // Search bar state
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);

  // Inline diff line comments
  const [draftAt, setDraftAt] = useState(null); // { key, file, lineNum, textSnapshot }
  const [draftText, setDraftText] = useState('');
  const [comments, setComments] = useState([]); // { id, file, lineNum, code, text }

  const matchRefs = useRef(new Map());
  const draftInputRef = useRef(null);

  const commentVoice = useVoiceDictation({
    engine: voiceOpts.engine || 'auto',
    lang: voiceOpts.lang || 'en-US',
    onTranscript: (t) => setDraftText((prev) => (prev ? prev + ' ' + t : t)),
  });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      setLoading(true);
      try {
        const cpArg = scope === 'turn' ? (target?.checkpointId || 'latest') : 'all';
        let list = [];
        if (convId && window.autobot && window.autobot.turnDiffs) {
          list = await window.autobot.turnDiffs(convId, cpArg, cwd).catch(() => []);
        }
        if (!Array.isArray(list) || list.length === 0) {
          list = fallbackDiffsFromTools(scope === 'turn' && target?.tools?.length ? target.tools : allTools);
        }
        if (alive) setFiles(Array.isArray(list) ? list : []);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, [convId, cwd, scope, target, allTools]);

  const matcher = useMemo(() => {
    const q = query.trim();
    if (!searchOpen || !q) return null;
    try {
      const esc = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(esc, matchCase ? 'g' : 'gi');
    } catch {
      return null;
    }
  }, [searchOpen, query, matchCase, useRegex]);

  const matchKeys = useMemo(() => {
    if (!matcher) return [];
    const out = [];
    files.forEach((f, fi) => {
      (f.lines || []).forEach((ln, li) => {
        matcher.lastIndex = 0;
        if (matcher.test(ln.text || '')) out.push(`${fi}:${li}`);
      });
    });
    return out;
  }, [files, matcher]);

  useEffect(() => {
    setMatchIdx(0);
  }, [query, matchCase, useRegex, files.length]);

  const jumpMatch = (delta) => {
    if (!matchKeys.length) return;
    const next = (matchIdx + delta + matchKeys.length) % matchKeys.length;
    setMatchIdx(next);
    const el = matchRefs.current.get(matchKeys[next]);
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const totalAdded = files.reduce((s, f) => s + (f.added || 0), 0);
  const totalRemoved = files.reduce((s, f) => s + (f.removed || 0), 0);

  const openDraft = (key, file, line) => {
    setDraftAt({ key, file: file.relPath || file.path, fullPath: file.path, lineNum: line.newLine || line.oldLine || 1, code: line.text || '' });
    setDraftText('');
    setTimeout(() => draftInputRef.current && draftInputRef.current.focus(), 20);
  };

  const commitComment = () => {
    const txt = draftText.trim();
    if (!txt || !draftAt) return;
    setComments((prev) => [...prev, { id: Date.now() + '_' + Math.random().toString(36).slice(2, 6), ...draftAt, text: txt }]);
    setDraftAt(null);
    setDraftText('');
  };

  const sendAllComments = () => {
    if (!comments.length || !onSendComment) return;
    const lines = comments.map((c, idx) => (
      `${idx + 1}. \`${c.file}:${c.lineNum}\` (\`${String(c.code || '').trim().slice(0, 80)}\`):\n   ${c.text}`
    )).join('\n');
    onSendComment(`Please address these inline code review comments:\n\n${lines}`);
    setComments([]);
  };

  const handleRewind = async () => {
    if (!convId || !window.autobot || !window.autobot.rewind) return;
    const cpId = scope === 'turn' ? (target?.checkpointId || 'latest') : null;
    if (!cpId) return;
    const r = await window.autobot.rewind(convId, cpId);
    if (onRewindDone) onRewindDone(r);
  };

  return (
    <div className="rv-pane">
      <div className="rv-head">
        <div className="rv-tabs">
          <button type="button" className={'rv-tab' + (scope === 'turn' ? ' on' : '')} onClick={() => setScope('turn')}>For Turn</button>
          <button type="button" className={'rv-tab' + (scope === 'all' ? ' on' : '')} onClick={() => setScope('all')}>All Changes</button>
        </div>
        <div className="rv-head-right">
          {(totalAdded > 0 || totalRemoved > 0) && (
            <span className="rv-totals">
              <span className="delta-add">+{totalAdded}</span>
              <span className="delta-del">−{totalRemoved}</span>
            </span>
          )}
          {target?.checkpointId && (
            <button type="button" className="btn-mini" onClick={handleRewind} title="Rewind this turn's checkpoint">
              <Icon name="ArrowCounterClockwise" size={12} /> Rewind
            </button>
          )}
          <button
            type="button"
            className={'icon-btn' + (searchOpen ? ' active' : '')}
            onClick={() => setSearchOpen((v) => !v)}
            title="Search inside diffs"
          >
            <Icon name="Search" size={14} />
          </button>
        </div>
      </div>

      {searchOpen && (
        <div className="rv-searchbar">
          <Icon name="Search" size={13} />
          <input
            className="rv-search-in"
            placeholder="Find in diffs…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') jumpMatch(e.shiftKey ? -1 : 1);
              if (e.key === 'Escape') setSearchOpen(false);
            }}
            autoFocus
          />
          <button type="button" className={'rv-opt' + (matchCase ? ' on' : '')} title="Match case" onClick={() => setMatchCase((v) => !v)}>Aa</button>
          <button type="button" className={'rv-opt' + (useRegex ? ' on' : '')} title="Use regex" onClick={() => setUseRegex((v) => !v)}>.*</button>
          <span className="rv-match-count">
            {matchKeys.length ? `${matchIdx + 1} of ${matchKeys.length}` : '0 results'}
          </span>
          <button type="button" className="icon-btn" onClick={() => jumpMatch(-1)} title="Previous match"><Icon name="ArrowUp" size={12} /></button>
          <button type="button" className="icon-btn" onClick={() => jumpMatch(1)} title="Next match"><Icon name="ArrowDown" size={12} /></button>
          <button type="button" className="icon-btn" onClick={() => { setSearchOpen(false); setQuery(''); }} title="Close search"><Icon name="X" size={12} /></button>
        </div>
      )}

      <div className="rv-body">
        {loading ? (
          <div className="env-empty"><Icon name="Spinner" size={14} className="spin" /> Loading diffs…</div>
        ) : files.length === 0 ? (
          <div className="env-empty">No file diffs recorded yet for this selection. Changes from Write / Edit tools appear here automatically.</div>
        ) : files.map((file, fi) => {
          const isCollapsed = !!collapsed[file.path];
          const chunks = groupDiffChunks(file.lines || []);
          const base = (file.relPath || file.path || '').split('/').pop();
          const dirPart = (file.relPath || file.path || '').split('/').slice(0, -1).join('/');
          return (
            <div key={file.path + ':' + fi} className="rv-file">
              <button
                type="button"
                className="rv-file-head"
                onClick={() => setCollapsed((c) => ({ ...c, [file.path]: !c[file.path] }))}
              >
                <span className="rv-ext">{extBadge(base)}</span>
                <span className="rv-file-name">{base}</span>
                {dirPart && <span className="rv-file-dir">{dirPart}</span>}
                <span className="rv-file-right">
                  <span className="delta-add">+{file.added}</span>
                  <span className="delta-del">−{file.removed}</span>
                  <Icon name={isCollapsed ? 'CaretRight' : 'CaretDown'} size={12} />
                </span>
              </button>

              {!isCollapsed && (
                <div className="rv-lines">
                  {chunks.map((ch) => {
                    if (ch.kind === 'fold') {
                      const foldKey = `${file.path}:${ch.id}`;
                      if (!expandedFolds[foldKey]) {
                        return (
                          <button
                            key={ch.id}
                            type="button"
                            className="rv-fold"
                            onClick={() => setExpandedFolds((e) => ({ ...e, [foldKey]: true }))}
                          >
                            +{ch.count} more lines
                          </button>
                        );
                      }
                      return ch.lines.map((ln, offset) => {
                        const rowIdx = ch.start + offset;
                        const rowKey = `${file.path}:${rowIdx}`;
                        const mk = `${fi}:${rowIdx}`;
                        const lineComments = comments.filter((c) => c.key === rowKey);
                        const isMatch = matchKeys[matchIdx] === mk;
                        return (
                          <React.Fragment key={rowKey}>
                            <div
                              ref={(el) => { if (el) matchRefs.current.set(mk, el); else matchRefs.current.delete(mk); }}
                              className={'rv-line ' + ln.type + (isMatch ? ' match-active' : '')}
                            >
                              <span className="rv-ln">{ln.oldLine || ''}</span>
                              <span className="rv-ln">{ln.newLine || ''}</span>
                              <button type="button" className="rv-add-c" title="Add inline comment" onClick={() => openDraft(rowKey, file, ln)}>+</button>
                              <span className="rv-sign">{ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '}</span>
                              <code className="rv-code">{highlightLine(ln.text, matcher)}</code>
                            </div>
                            {lineComments.map((c) => (
                              <div key={c.id} className="rv-comment-card">
                                <div className="rv-comment-meta">
                                  <span>Line {c.lineNum}</span>
                                  <button type="button" className="icon-btn" onClick={() => setComments((cs) => cs.filter((x) => x.id !== c.id))}><Icon name="Trash" size={12} /></button>
                                </div>
                                <div className="rv-comment-text">{c.text}</div>
                              </div>
                            ))}
                            {draftAt && draftAt.key === rowKey && (
                              <div className="rv-draft">
                                <textarea
                                  ref={draftInputRef}
                                  rows={2}
                                  placeholder="Leave a comment…"
                                  value={draftText}
                                  onChange={(e) => setDraftText(e.target.value)}
                                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitComment(); } }}
                                />
                                <div className="rv-draft-foot">
                                  <button type="button" className="btn-mini" onClick={() => setDraftAt(null)}>Cancel</button>
                                  <button
                                    type="button"
                                    className={'icon-btn rv-mic' + (commentVoice.state !== 'idle' ? ' active' : '')}
                                    title={commentVoice.state === 'recording' ? 'Stop & transcribe voice comment' : 'Voice type comment'}
                                    onClick={commentVoice.toggle}
                                  >
                                    <Icon name={commentVoice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={13} className={commentVoice.state === 'transcribing' ? 'spin' : ''} />
                                  </button>
                                  <button type="button" className="btn-mini primary" disabled={!draftText.trim()} onClick={commitComment}>Add Comment</button>
                                </div>
                              </div>
                            )}
                          </React.Fragment>
                        );
                      });
                    }
                    const ln = ch.line;
                    const rowKey = `${file.path}:${ch.idx}`;
                    const mk = `${fi}:${ch.idx}`;
                    const lineComments = comments.filter((c) => c.key === rowKey);
                    const isMatch = matchKeys[matchIdx] === mk;
                    return (
                      <React.Fragment key={rowKey}>
                        <div
                          ref={(el) => { if (el) matchRefs.current.set(mk, el); else matchRefs.current.delete(mk); }}
                          className={'rv-line ' + ln.type + (isMatch ? ' match-active' : '')}
                        >
                          <span className="rv-ln">{ln.oldLine || ''}</span>
                          <span className="rv-ln">{ln.newLine || ''}</span>
                          <button type="button" className="rv-add-c" title="Add inline comment" onClick={() => openDraft(rowKey, file, ln)}>+</button>
                          <span className="rv-sign">{ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '}</span>
                          <code className="rv-code">{highlightLine(ln.text, matcher)}</code>
                        </div>
                        {lineComments.map((c) => (
                          <div key={c.id} className="rv-comment-card">
                            <div className="rv-comment-meta">
                              <span>Line {c.lineNum}</span>
                              <button type="button" className="icon-btn" onClick={() => setComments((cs) => cs.filter((x) => x.id !== c.id))}><Icon name="Trash" size={12} /></button>
                            </div>
                            <div className="rv-comment-text">{c.text}</div>
                          </div>
                        ))}
                        {draftAt && draftAt.key === rowKey && (
                          <div className="rv-draft">
                            <textarea
                              ref={draftInputRef}
                              rows={2}
                              placeholder="Leave a comment…"
                              value={draftText}
                              onChange={(e) => setDraftText(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitComment(); } }}
                            />
                            <div className="rv-draft-foot">
                              <button type="button" className="btn-mini" onClick={() => setDraftAt(null)}>Cancel</button>
                              <button
                                type="button"
                                className={'icon-btn rv-mic' + (commentVoice.state !== 'idle' ? ' active' : '')}
                                title={commentVoice.state === 'recording' ? 'Stop & transcribe voice comment' : 'Voice type comment'}
                                onClick={commentVoice.toggle}
                              >
                                <Icon name={commentVoice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={13} className={commentVoice.state === 'transcribing' ? 'spin' : ''} />
                              </button>
                              <button type="button" className="btn-mini primary" disabled={!draftText.trim()} onClick={commitComment}>Add Comment</button>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {comments.length > 0 && (
        <div className="rv-foot">
          <span className="rv-foot-count">{comments.length} {comments.length === 1 ? 'comment' : 'comments'} ready</span>
          <button type="button" className="btn-mini primary" onClick={sendAllComments}>
            <Icon name="PaperPlane" size={12} /> Send Review Comments to Agent
          </button>
        </div>
      )}
    </div>
  );
}
