import React, { useState, useEffect, useRef } from 'react';
import { shortcutLabels } from './shortcuts';

export function buildInlineDiffLines(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const n = a.length;
  const m = b.length;
  // Cap DP size for huge selections; exact LCS line diff for practical blocks
  if (n * m <= 250000) {
    const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ type: 'ctx', text: a[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: 'del', text: a[i++] });
      } else {
        out.push({ type: 'add', text: b[j++] });
      }
    }
    while (i < n) out.push({ type: 'del', text: a[i++] });
    while (j < m) out.push({ type: 'add', text: b[j++] });
    return out;
  }
  const out = [];
  for (const ln of a) out.push({ type: 'del', text: ln });
  for (const ln of b) out.push({ type: 'add', text: ln });
  return out;
}

export function InlineEditWidget({
  state, // { filePath, language, lineNumber, selectionText, prefix, suffix, range, initialInstruction }
  provider,
  orchestrator,
  onAccept,
  onCancel,
  Icon,
}) {
  const [instruction, setInstruction] = useState(state?.initialInstruction || '');
  const [streaming, setStreaming] = useState(false);
  const [proposed, setProposed] = useState('');
  const [hasProposal, setHasProposal] = useState(false);
  const [err, setErr] = useState('');
  const editIdRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current && inputRef.current.focus();
  }, []);

  useEffect(() => {
    if (!window.autobot || !window.autobot.onIdeInlineEditDelta) return undefined;
    return window.autobot.onIdeInlineEditDelta((evt) => {
      if (!evt || evt.editId !== editIdRef.current) return;
      setProposed(evt.full || '');
      setHasProposal(true);
    });
  }, []);

  const submit = async (e) => {
    if (e) e.preventDefault();
    const prompt = instruction.trim();
    if (!prompt || streaming) return;
    const editId = 'k_' + Date.now();
    editIdRef.current = editId;
    setStreaming(true);
    setErr('');
    setProposed('');
    setHasProposal(false);
    try {
      const r = await window.autobot.ideInlineEdit({
        editId,
        provider,
        orchestrator,
        filePath: state.filePath,
        language: state.language,
        selection: hasProposal ? proposed : (state.selectionText || ''),
        prefix: state.prefix || '',
        suffix: state.suffix || '',
        instruction: prompt,
      });
      if (r && r.ok) {
        setProposed(r.text != null ? r.text : '');
        setHasProposal(true);
        setInstruction('');
      } else if (!r?.aborted) {
        setErr(r?.error || 'Inline edit failed');
      }
    } finally {
      setStreaming(false);
    }
  };

  const cancel = () => {
    if (streaming && editIdRef.current && window.autobot?.ideInlineEditCancel) {
      window.autobot.ideInlineEditCancel(editIdRef.current);
    }
    onCancel && onCancel();
  };

  const diffLines = hasProposal ? buildInlineDiffLines(state.selectionText || '', proposed) : [];
  const sc = shortcutLabels();

  return (
    <div
      className="ide-inline-edit"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && hasProposal && !streaming) {
          e.preventDefault();
          onAccept && onAccept(proposed, state.range);
        }
      }}
    >
      <form className="ide-inline-edit-bar" onSubmit={submit}>
        <span className="ide-inline-kbd">{sc.inlineEdit}</span>
        <input
          ref={inputRef}
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={hasProposal ? `Follow-up instruction (or ${sc.submit} to accept)…` : 'Edit selection or generate code…'}
        />
        {provider?.model && <span className="ide-inline-model">{provider.model}</span>}
        <button type="submit" className="ide-primary-btn" disabled={streaming || !instruction.trim()}>
          {streaming ? 'Streaming…' : (hasProposal ? 'Refine' : 'Generate')}
        </button>
        <button type="button" className="ide-icon-btn" onClick={cancel} title="Cancel (Esc)">
          <Icon name="X" size={12} />
        </button>
      </form>

      {err && <div className="ide-inline-err">{err}</div>}

      {hasProposal && (
        <div className="ide-inline-diff-box">
          <div className="ide-inline-diff-lines">
            {diffLines.slice(0, 60).map((ln, idx) => (
              <div key={idx} className={'ide-idiff-ln ' + ln.type}>
                <span className="ide-idiff-sign">{ln.type === 'add' ? '+' : ln.type === 'del' ? '−' : ' '}</span>
                <span>{ln.text}</span>
              </div>
            ))}
          </div>
          <div className="ide-inline-diff-foot">
            <span className="ide-inline-hint">{state.selectionText ? 'Inline diff preview' : 'Insertion preview'}</span>
            <div className="ide-inline-diff-btns">
              <button type="button" className="ide-mini-action" onClick={cancel}>Reject (Esc)</button>
              <button
                type="button"
                className="ide-primary-btn"
                disabled={streaming}
                onClick={() => onAccept && onAccept(proposed, state.range)}
              >
                Accept ({sc.submit})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
