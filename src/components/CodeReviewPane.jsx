import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useVoiceDictation } from '../voice';
import {
  fallbackDiffsFromTools,
  mergeDiffFiles,
  groupDiffChunks,
  computeFoldSlice,
  findFoldForLine,
  buildSearchMatcher,
  extInfo,
} from '../review-helpers.mjs';

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
  const [scope, setScope] = useState(target && (target.scope === 'all' ? 'all' : (target.checkpointId || target.turnLabel || (target.tools && target.tools.length))) ? (target.scope || 'turn') : 'all');
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState({});
  const [expandedFolds, setExpandedFolds] = useState({});

  // Sub-header menus
  const [menuOpen, setMenuOpen] = useState(false);
  const [filesJumpOpen, setFilesJumpOpen] = useState(false);

  // Search bar state (Aa, ab, .*, 1 of N, ↑/↓, ×)
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [matchIdx, setMatchIdx] = useState(0);

  // Inline diff line comments
  const [draftAt, setDraftAt] = useState(null); // { key, file, fullPath, lineNum, code }
  const [draftText, setDraftText] = useState('');
  const [comments, setComments] = useState([]); // { id, key, file, lineNum, code, text }

  const matchRefs = useRef(new Map());
  const fileRefs = useRef(new Map());
  const draftInputRef = useRef(null);
  const searchInputRef = useRef(null);
  const menuWrapRef = useRef(null);
  const jumpWrapRef = useRef(null);

  useEffect(() => {
    if (target && target.scope) setScope(target.scope);
    else if (target && (target.checkpointId || target.turnLabel || (target.tools && target.tools.length))) setScope('turn');
  }, [target]);

  useEffect(() => {
    if (!menuOpen && !filesJumpOpen) return undefined;
    const onDocClick = (e) => {
      if (menuOpen && menuWrapRef.current && !menuWrapRef.current.contains(e.target)) setMenuOpen(false);
      if (filesJumpOpen && jumpWrapRef.current && !jumpWrapRef.current.contains(e.target)) setFilesJumpOpen(false);
    };
    window.addEventListener('mousedown', onDocClick);
    return () => window.removeEventListener('mousedown', onDocClick);
  }, [menuOpen, filesJumpOpen]);

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
        let cpDiffs = [];
        if (convId && window.autobot && window.autobot.turnDiffs) {
          cpDiffs = await window.autobot.turnDiffs(convId, cpArg, cwd).catch(() => []);
        }
        const toolDiffs = fallbackDiffsFromTools(scope === 'turn' && target?.tools?.length ? target.tools : allTools);
        let merged = mergeDiffFiles(cpDiffs, toolDiffs);

        if ((scope === 'all' || merged.length === 0) && window.autobot && window.autobot.gitDiffFiles && cwd) {
          const gitDiffs = await window.autobot.gitDiffFiles(cwd).catch(() => []);
          merged = scope === 'all' ? mergeDiffFiles(merged, gitDiffs) : (gitDiffs.length ? gitDiffs : merged);
        }
        if (alive) setFiles(Array.isArray(merged) ? merged : []);
      } finally {
        if (alive) setLoading(false);
      }
    };
    load();
    return () => { alive = false; };
  }, [convId, cwd, scope, target, allTools]);

  const chunksByFile = useMemo(
    () => files.map((f) => groupDiffChunks(f.lines || [])),
    [files]
  );

  const matcher = useMemo(
    () => (searchOpen ? buildSearchMatcher(query, { matchCase, wholeWord, useRegex }) : null),
    [searchOpen, query, matchCase, wholeWord, useRegex]
  );

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

  const ensureMatchVisible = (mk) => {
    if (!mk) return;
    const [fiStr, liStr] = String(mk).split(':');
    const fi = Number(fiStr);
    const li = Number(liStr);
    const file = files[fi];
    if (!file) return;
    if (collapsed[file.path]) {
      setCollapsed((c) => ({ ...c, [file.path]: false }));
    }
    const foldId = findFoldForLine(chunksByFile[fi] || [], li);
    if (foldId) {
      const fk = `${file.path}:${foldId}`;
      setExpandedFolds((prev) => (prev[fk] === true ? prev : { ...prev, [fk]: true }));
    }
    setTimeout(() => {
      const el = matchRefs.current.get(mk);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 30);
  };

  useEffect(() => {
    setMatchIdx(0);
    if (matchKeys.length > 0) {
      ensureMatchVisible(matchKeys[0]);
    }
  }, [query, matchCase, wholeWord, useRegex, files.length]);

  const jumpMatch = (delta) => {
    if (!matchKeys.length) return;
    const next = (matchIdx + delta + matchKeys.length) % matchKeys.length;
    setMatchIdx(next);
    ensureMatchVisible(matchKeys[next]);
  };

  const totalAdded = files.reduce((s, f) => s + (f.added || 0), 0);
  const totalRemoved = files.reduce((s, f) => s + (f.removed || 0), 0);

  const openDraft = (key, file, line) => {
    setDraftAt({
      key,
      file: file.relPath || file.path,
      fullPath: file.path,
      lineNum: line.newLine || line.oldLine || 1,
      code: line.text || '',
    });
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

  const expandFoldStep = (foldKey, dir, step = 10) => {
    setExpandedFolds((prev) => {
      const cur = prev[foldKey];
      if (cur === true) return prev;
      const top = Number(cur && cur.top) || 0;
      const bottom = Number(cur && cur.bottom) || 0;
      return {
        ...prev,
        [foldKey]: dir === 'top' ? { top: top + step, bottom } : { top, bottom: bottom + step },
      };
    });
  };

  const expandAllFolds = () => {
    const next = {};
    files.forEach((f, fi) => {
      (chunksByFile[fi] || []).forEach((ch) => {
        if (ch.kind === 'fold') next[`${f.path}:${ch.id}`] = true;
      });
    });
    setExpandedFolds(next);
    setMenuOpen(false);
  };

  const renderDiffLine = (ln, rowIdx, file, fi) => {
    const rowKey = `${file.path}:${rowIdx}`;
    const mk = `${fi}:${rowIdx}`;
    const lineComments = comments.filter((c) => c.key === rowKey);
    const isMatch = matchKeys[matchIdx] === mk;
    const lineNum = ln.newLine != null ? ln.newLine : (ln.oldLine != null ? ln.oldLine : '');
    return (
      <React.Fragment key={rowKey}>
        <div
          ref={(el) => { if (el) matchRefs.current.set(mk, el); else matchRefs.current.delete(mk); }}
          className={'rv-line ' + ln.type + (isMatch ? ' match-active' : '')}
        >
          <span className="rv-gutter">
            <span className="rv-ln">{lineNum}</span>
            <button
              type="button"
              className="rv-add-c"
              title="Add inline comment"
              aria-label={`Add comment on line ${lineNum || rowIdx + 1}`}
              onClick={() => openDraft(rowKey, file, ln)}
            >
              +
            </button>
          </span>
          <span className="rv-sign">{ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '}</span>
          <code className="rv-code">{highlightLine(ln.text, matcher)}</code>
        </div>
        {lineComments.map((c) => (
          <div key={c.id} className="rv-comment-card">
            <div className="rv-comment-meta">
              <span>Line {c.lineNum}</span>
              <button type="button" className="icon-btn" onClick={() => setComments((cs) => cs.filter((x) => x.id !== c.id))} title="Delete comment">
                <Icon name="Trash" size={12} />
              </button>
            </div>
            <div className="rv-comment-text">{c.text}</div>
          </div>
        ))}
        {draftAt && draftAt.key === rowKey && (
          <div className="rv-draft">
            <textarea
              ref={draftInputRef}
              rows={2}
              placeholder="Leave a comment"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitComment(); }
                if (e.key === 'Escape') { e.preventDefault(); setDraftAt(null); }
              }}
            />
            <div className="rv-draft-foot">
              <button type="button" className="rv-draft-cancel" onClick={() => setDraftAt(null)}>Cancel</button>
              <div className="rv-draft-right">
                <button
                  type="button"
                  className={'icon-btn rv-mic' + (commentVoice.state !== 'idle' ? ' active' : '')}
                  title={commentVoice.state === 'recording' ? 'Stop & transcribe voice comment' : 'Voice type comment (Whisper)'}
                  onClick={commentVoice.toggle}
                >
                  <Icon name={commentVoice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={14} className={commentVoice.state === 'transcribing' ? 'spin' : ''} />
                </button>
                <button type="button" className="rv-draft-submit" disabled={!draftText.trim()} onClick={commitComment}>
                  Add Comment
                </button>
              </div>
            </div>
          </div>
        )}
      </React.Fragment>
    );
  };

  return (
    <div className="rv-pane">
      <div className="rv-subhead">
        <div className="rv-scope-bar">
          {scope === 'turn' ? (
            <>
              <span className="rv-scope-label">For Turn</span>
              <span className="rv-turn-chip" title={target?.turnLabel || 'Latest turn'}>
                <span className="rv-turn-chip-txt">{target?.turnLabel || 'latest turn'}</span>
                <button type="button" className="rv-turn-chip-x" onClick={() => setScope('all')} title="Clear turn filter (show All Changes)">
                  <Icon name="X" size={11} />
                </button>
              </span>
            </>
          ) : (
            <>
              <span className="rv-scope-pill">All Changes</span>
              {target && (
                <button type="button" className="rv-scope-switch" onClick={() => setScope('turn')}>
                  For Turn
                </button>
              )}
            </>
          )}
          {(totalAdded > 0 || totalRemoved > 0) && (
            <span className="rv-totals">
              <span className="delta-add">+{totalAdded}</span>
              <span className="delta-del">−{totalRemoved}</span>
            </span>
          )}
        </div>

        <div className="rv-head-right">
          <div className="rv-pop-wrap" ref={menuWrapRef}>
            <button
              type="button"
              className={'icon-btn' + (menuOpen ? ' active' : '')}
              onClick={() => { setFilesJumpOpen(false); setMenuOpen((v) => !v); }}
              title="Review options"
            >
              <Icon name="DotsVertical" size={14} />
            </button>
            {menuOpen && (
              <div className="rv-popover">
                <button type="button" className="rv-pop-item" onClick={expandAllFolds}>
                  <span>Expand all folds</span>
                </button>
                <button type="button" className="rv-pop-item" onClick={() => { setCollapsed({}); setMenuOpen(false); }}>
                  <span>Expand all files</span>
                </button>
                <button
                  type="button"
                  className="rv-pop-item"
                  onClick={() => {
                    const next = {};
                    files.forEach((f) => { next[f.path] = true; });
                    setCollapsed(next);
                    setMenuOpen(false);
                  }}
                >
                  <span>Collapse all files</span>
                </button>
                {target?.checkpointId && (
                  <button type="button" className="rv-pop-item" onClick={() => { setMenuOpen(false); handleRewind(); }}>
                    <Icon name="ArrowCounterClockwise" size={13} />
                    <span>Rewind this turn</span>
                  </button>
                )}
              </div>
            )}
          </div>

          <button
            type="button"
            className={'icon-btn rv-search-toggle' + (searchOpen ? ' active' : '')}
            onClick={() => {
              setSearchOpen((v) => !v);
              setTimeout(() => searchInputRef.current && searchInputRef.current.focus(), 20);
            }}
            title="Search diffs"
          >
            <Icon name="Search" size={14} />
          </button>

          <div className="rv-pop-wrap" ref={jumpWrapRef}>
            <button
              type="button"
              className={'icon-btn' + (filesJumpOpen ? ' active' : '')}
              onClick={() => { setMenuOpen(false); setFilesJumpOpen((v) => !v); }}
              title="Changed files list"
            >
              <Icon name="ListBullet" size={14} />
            </button>
            {filesJumpOpen && (
              <div className="rv-popover rv-files-pop">
                <div className="rv-pop-head">Changed Files ({files.length})</div>
                {files.length === 0 ? (
                  <div className="rv-pop-empty">No changed files</div>
                ) : files.map((f, idx) => {
                  const base = (f.relPath || f.path || '').split('/').pop();
                  const info = extInfo(base);
                  return (
                    <button
                      key={f.path + ':jump:' + idx}
                      type="button"
                      className="rv-pop-item"
                      onClick={() => {
                        setCollapsed((c) => ({ ...c, [f.path]: false }));
                        setFilesJumpOpen(false);
                        setTimeout(() => {
                          const el = fileRefs.current.get(f.path);
                          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
                        }, 20);
                      }}
                    >
                      <span className={'rv-ext ' + info.cls}>{info.label}</span>
                      <span className="rv-pop-file">{f.relPath || base}</span>
                      <span className="rv-pop-deltas">
                        <span className="delta-add">+{f.added || 0}</span>
                        <span className="delta-del">−{f.removed || 0}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {searchOpen && (
        <div className="rv-searchbar">
          <div className="rv-search-box">
            <input
              ref={searchInputRef}
              className="rv-search-in"
              placeholder="Search diffs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') jumpMatch(e.shiftKey ? -1 : 1);
                if (e.key === 'Escape') setSearchOpen(false);
              }}
              autoFocus
            />
            <button type="button" className={'rv-opt' + (matchCase ? ' on' : '')} title="Match case" onClick={() => setMatchCase((v) => !v)}>Aa</button>
            <button type="button" className={'rv-opt' + (wholeWord ? ' on' : '')} title="Match whole word" onClick={() => setWholeWord((v) => !v)}>ab</button>
            <button type="button" className={'rv-opt' + (useRegex ? ' on' : '')} title="Use regular expression" onClick={() => setUseRegex((v) => !v)}>.*</button>
          </div>
          <span className="rv-match-count">
            {matchKeys.length ? `${matchIdx + 1} of ${matchKeys.length}` : '0 results'}
          </span>
          <button type="button" className="icon-btn rv-nav-btn" onClick={() => jumpMatch(-1)} title="Previous match">
            <Icon name="ArrowUp" size={12} />
          </button>
          <button type="button" className="icon-btn rv-nav-btn" onClick={() => jumpMatch(1)} title="Next match">
            <Icon name="ArrowDown" size={12} />
          </button>
          <button type="button" className="icon-btn rv-nav-btn" onClick={() => { setSearchOpen(false); setQuery(''); }} title="Close search">
            <Icon name="X" size={12} />
          </button>
        </div>
      )}

      <div className="rv-body">
        {loading ? (
          <div className="env-empty"><Icon name="Spinner" size={14} className="spin" /> Loading diffs…</div>
        ) : files.length === 0 ? (
          <div className="env-empty">No file diffs recorded yet for this selection. Changes from tools or Git working tree appear here automatically.</div>
        ) : files.map((file, fi) => {
          const isCollapsed = !!collapsed[file.path];
          const chunks = chunksByFile[fi] || [];
          const fullNorm = String(file.path || '').replace(/\\/g, '/');
          const relNorm = String(file.relPath || fullNorm).replace(/\\/g, '/');
          const base = relNorm.split('/').pop() || fullNorm.split('/').pop();
          const dirPart = fullNorm.includes('/') ? fullNorm.split('/').slice(0, -1).join('/') : relNorm.split('/').slice(0, -1).join('/');
          const info = extInfo(base);

          return (
            <div
              key={file.path + ':' + fi}
              ref={(el) => { if (el) fileRefs.current.set(file.path, el); else fileRefs.current.delete(file.path); }}
              className="rv-file"
            >
              <button
                type="button"
                className="rv-file-head"
                onClick={() => setCollapsed((c) => ({ ...c, [file.path]: !c[file.path] }))}
              >
                <span className={'rv-ext ' + info.cls}>{info.label}</span>
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
                      const slice = computeFoldSlice(ch, expandedFolds[foldKey]);
                      return (
                        <React.Fragment key={ch.id}>
                          {slice.topLines.map(({ ln, rowIdx }) => renderDiffLine(ln, rowIdx, file, fi))}
                          {!slice.expanded && slice.remaining > 0 && (
                            <div className="rv-fold-bar">
                              <button
                                type="button"
                                className="rv-fold-all"
                                onClick={() => setExpandedFolds((e) => ({ ...e, [foldKey]: true }))}
                                title={`Expand all ${slice.remaining} hidden lines`}
                              >
                                +{slice.remaining} more lines
                              </button>
                              <div className="rv-fold-steps">
                                <button
                                  type="button"
                                  className="rv-fold-step"
                                  onClick={() => expandFoldStep(foldKey, 'top', 10)}
                                  title="Reveal next 10 lines downward"
                                >
                                  +10
                                </button>
                                <button
                                  type="button"
                                  className="rv-fold-step"
                                  onClick={() => expandFoldStep(foldKey, 'bottom', 10)}
                                  title="Reveal previous 10 lines upward"
                                >
                                  +10
                                </button>
                              </div>
                            </div>
                          )}
                          {slice.bottomLines.map(({ ln, rowIdx }) => renderDiffLine(ln, rowIdx, file, fi))}
                        </React.Fragment>
                      );
                    }
                    return renderDiffLine(ch.line, ch.idx, file, fi);
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
            <Icon name="ArrowBendUpRight" size={12} /> Send Review Comments to Agent
          </button>
        </div>
      )}
    </div>
  );
}
