import React, { useState, useEffect, useMemo, useRef } from 'react';

function sevClass(sev) {
  const s = String(sev || 'medium').toLowerCase();
  if (s === 'critical' || s === 'high') return 'high';
  if (s === 'low' || s === 'info') return 'low';
  return 'med';
}

export function DuetReviewPanel({
  convId,
  cwd,
  target,
  provider,
  orchestrator,
  onSendComment,
  Icon,
}) {
  const poolProviders = useMemo(() => {
    const list = Array.isArray(orchestrator && orchestrator.providers) ? orchestrator.providers : [];
    return list.filter((p) => p && p.enabled !== false);
  }, [orchestrator]);

  const [withSpec, setWithSpec] = useState((target && target.withSpec) || '');
  const [adversarial, setAdversarial] = useState(Boolean(target && target.adversarial));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [result, setResult] = useState((target && target.mockDuetResult) || null);
  const [selected, setSelected] = useState({});
  const [dismissed, setDismissed] = useState({});
  const [questionsOpen, setQuestionsOpen] = useState(false);
  const autoRanRef = useRef('');

  useEffect(() => {
    if (target && target.mockDuetResult) {
      setResult(target.mockDuetResult);
      setDismissed({});
      setSelected({});
    }
    if (target && target.withSpec != null) setWithSpec(target.withSpec);
    if (target && target.adversarial != null) setAdversarial(Boolean(target.adversarial));
  }, [target]);

  const runReview = async (opts = {}) => {
    if (!window.autobot || !window.autobot.duetReview) {
      setErr('Duet Review IPC is unavailable in this environment.');
      return;
    }
    const chosenWith = opts.withSpec != null ? opts.withSpec : withSpec;
    const chosenAdv = opts.adversarial != null ? opts.adversarial : adversarial;
    setBusy(true);
    setErr('');
    try {
      const res = await window.autobot.duetReview({
        cwd,
        convId,
        target,
        provider,
        orchestrator,
        withSpec: chosenWith,
        adversarial: chosenAdv,
      });
      if (!res || res.ok === false) {
        setErr((res && res.error) || 'Cross-model review failed.');
      } else {
        setResult(res);
        setDismissed({});
        setSelected({});
      }
    } catch (e) {
      setErr((e && e.message) || 'Cross-model review failed.');
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!target || !target.duetAutoRun || target.mockDuetResult) return;
    const key = `${target.at || ''}:${target.withSpec || ''}:${target.adversarial ? 1 : 0}`;
    if (autoRanRef.current === key) return;
    autoRanRef.current = key;
    runReview({ withSpec: target.withSpec || '', adversarial: Boolean(target.adversarial) });
  }, [target]);

  const visibleFindings = useMemo(() => {
    const list = (result && Array.isArray(result.findings)) ? result.findings : [];
    return list.filter((f) => !dismissed[f.id]);
  }, [result, dismissed]);

  const openQuestions = (result && Array.isArray(result.openQuestions)) ? result.openQuestions : [];
  const selectedFindings = visibleFindings.filter((f) => selected[f.id]);

  const formatFixPrompt = (items) => {
    const lines = [
      `Please fix the following ${items.length} verified code review finding${items.length === 1 ? '' : 's'} (reviewed by ${result.reviewerLabel || 'second opinion'}, verified by ${result.primaryLabel || 'primary'}):`,
      '',
    ];
    for (const f of items) {
      lines.push(`- [${String(f.severity || 'medium').toUpperCase()} · ${f.confidence}%] ${f.file || 'workspace'}${f.line ? `:${f.line}` : ''} — ${f.title}`);
      if (f.detail) lines.push(`  Why: ${f.detail}`);
      if (f.fixPrompt || f.fix) lines.push(`  Fix: ${f.fixPrompt || f.fix}`);
    }
    return lines.join('\n');
  };

  const applyOne = (f) => {
    if (onSendComment) onSendComment(formatFixPrompt([f]));
  };

  const fixSelected = () => {
    const batch = selectedFindings.length ? selectedFindings : visibleFindings;
    if (batch.length && onSendComment) onSendComment(formatFixPrompt(batch));
  };

  return (
    <div className="duet-wrap" data-testid="duet-review-panel">
      <div className="duet-bar">
        <div className="duet-bar-left">
          <span className="duet-title">
            <Icon name="GitBranch" size={13} /> Duet Cross-Model Review
          </span>
          <select
            className="duet-select"
            value={withSpec}
            onChange={(e) => setWithSpec(e.target.value)}
            aria-label="Second opinion reviewer model"
          >
            <option value="">Auto (Cross-Family Pool)</option>
            {poolProviders.map((p, i) => {
              const val = p.id || p.model || p.label || String(i);
              const text = p.label || p.model || p.provider || val;
              return <option key={val + ':' + i} value={val}>{text}</option>;
            })}
          </select>
          <label className="duet-adv-toggle" title="Run an additional adversarial stress-test pass">
            <input
              type="checkbox"
              checked={adversarial}
              onChange={(e) => setAdversarial(e.target.checked)}
            />
            <span>Adversarial</span>
          </label>
        </div>

        <div className="duet-bar-right">
          {visibleFindings.length > 0 && (
            <button
              type="button"
              className="btn-mini"
              onClick={fixSelected}
              title="Send selected findings (or all if none checked) to the agent to fix"
            >
              Fix {selectedFindings.length ? `Selected (${selectedFindings.length})` : `All (${visibleFindings.length})`}
            </button>
          )}
          <button
            type="button"
            className="btn-mini primary"
            data-testid="duet-run-btn"
            disabled={busy}
            onClick={() => runReview()}
          >
            {busy ? <><Icon name="Spinner" size={12} className="spin" /> Reviewing…</> : 'Cross-Model Review'}
          </button>
        </div>
      </div>

      {err && <div className="duet-err">{err}</div>}

      {result && (
        <div className="duet-results">
          <div className="duet-attrib">
            <span>
              <strong>Primary:</strong> {result.primaryLabel} · <strong>Reviewer:</strong> {result.reviewerLabel}
            </span>
            <span className="duet-badges">
              <span className={'duet-pill ' + (result.differentFamily ? 'ok' : 'neutral')}>
                {result.differentFamily ? 'Cross-Family Verified' : (result.sameModelFallback ? 'Single-Model Fallback' : 'Pool Verified')}
              </span>
              {result.adversarial && <span className="duet-pill adv">Adversarial</span>}
              <span className="duet-pill neutral">{result.passesRun || 0} passes</span>
            </span>
          </div>

          {result.summary && <div className="duet-summary">{result.summary}</div>}

          {!result.empty && visibleFindings.length === 0 && (
            <div className="duet-empty-ok">
              No actionable issues &ge; 70% confidence{Object.keys(dismissed).length ? ' remaining' : ''}.
            </div>
          )}

          {visibleFindings.map((f) => (
            <div key={f.id} className="duet-card" data-testid="duet-finding-card">
              <div className="duet-card-head">
                <label className="duet-check">
                  <input
                    type="checkbox"
                    checked={!!selected[f.id]}
                    onChange={(e) => setSelected((s) => ({ ...s, [f.id]: e.target.checked }))}
                  />
                  <span className={'duet-sev ' + sevClass(f.severity)}>{String(f.severity || 'medium').toUpperCase()}</span>
                  <span className="duet-conf" title="Primary model verification confidence">{f.confidence}%</span>
                  <span className="duet-card-title">{f.title}</span>
                </label>
                {f.file && (
                  <span className="duet-loc">{f.file}{f.line ? `:${f.line}` : ''}</span>
                )}
              </div>
              {f.detail && <div className="duet-card-detail">{f.detail}</div>}
              {f.verificationNote && (
                <div className="duet-verify-note">Verification: {f.verificationNote}</div>
              )}
              {(f.fix || f.fixPrompt) && (
                <div className="duet-fix-box">Suggested fix: {f.fixPrompt || f.fix}</div>
              )}
              <div className="duet-card-actions">
                <button type="button" className="btn-mini primary" onClick={() => applyOne(f)}>Apply Fix</button>
                <button type="button" className="btn-mini" onClick={() => setDismissed((d) => ({ ...d, [f.id]: true }))}>Dismiss</button>
              </div>
            </div>
          ))}

          {openQuestions.length > 0 && (
            <div className="duet-open-q">
              <button
                type="button"
                className="duet-open-q-toggle"
                onClick={() => setQuestionsOpen((v) => !v)}
              >
                <Icon name={questionsOpen ? 'ArrowDown' : 'ArrowUp'} size={11} />
                <span>Open Questions &amp; Low-Confidence Notes ({openQuestions.length} items &lt; 70%)</span>
              </button>
              {questionsOpen && (
                <div className="duet-open-q-list">
                  {openQuestions.map((q) => (
                    <div key={q.id} className="duet-q-row">
                      <span className="duet-conf low">{q.confidence}%</span>
                      <div className="duet-q-body">
                        <div className="duet-q-title">
                          {q.title} {q.file ? <span className="duet-loc">{q.file}{q.line ? `:${q.line}` : ''}</span> : null}
                        </div>
                        {q.detail && <div className="duet-q-detail">{q.detail}</div>}
                        {q.verificationNote && <div className="duet-verify-note">{q.verificationNote}</div>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
