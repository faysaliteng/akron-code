import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.jsx';
import { renderMarkdown } from '../utils/appHelpers.jsx';

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

export default function QuestionDock({ queue = [], onAnswer }) {
  const item = queue && queue.length ? queue[0] : null;
  const isPlan = item && item.type === 'plan';
  const questions = useMemo(() => {
    if (!item || isPlan) return [];
    if (Array.isArray(item.questions) && item.questions.length) return item.questions;
    return [{
      id: 'q0',
      header: '',
      question: item.text || item.question || 'Continue?',
      options: item.options || [],
      multiSelect: Boolean(item.multiSelect),
    }];
  }, [item, isPlan]);

  const [stepIdx, setStepIdx] = useState(0);
  const [answers, setAnswers] = useState({});
  const [customByStep, setCustomByStep] = useState({});
  const [selectedOpt, setSelectedOpt] = useState(0);
  const [planNote, setPlanNote] = useState('');
  const dockRef = useRef(null);

  useEffect(() => {
    setStepIdx(0);
    setAnswers({});
    setCustomByStep({});
    setSelectedOpt(0);
    setPlanNote('');
  }, [item && item.id]);

  const curQ = questions[stepIdx] || questions[0] || null;
  const curId = curQ ? curQ.id : 'q0';
  const curOpts = (curQ && curQ.options) || [];
  const isMulti = Boolean(curQ && (curQ.isMultiSelect || curQ.multiSelect));
  const customVal = customByStep[curId] || '';

  const submitAll = (nextMap) => {
    if (!item || !onAnswer) return;
    if (questions.length <= 1) {
      const val = nextMap[curId];
      const text = Array.isArray(val) ? val.join(', ') : String(val || '');
      onAnswer(item.id, { answers: nextMap, answer: text });
    } else {
      onAnswer(item.id, { answers: nextMap });
    }
  };

  const commitStepAnswer = (val) => {
    const next = { ...answers, [curId]: val };
    setAnswers(next);
    if (stepIdx + 1 < questions.length) {
      setStepIdx(stepIdx + 1);
      setSelectedOpt(0);
    } else {
      submitAll(next);
    }
  };

  const toggleMultiOption = (label) => {
    const prev = Array.isArray(answers[curId]) ? answers[curId] : [];
    const nextArr = prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label];
    setAnswers({ ...answers, [curId]: nextArr });
  };

  useEffect(() => {
    if (!item) return undefined;
    const onKeyDown = (e) => {
      if (isExternalEditable(document.activeElement, dockRef.current)) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (isPlan) onAnswer(item.id, { approved: false, note: planNote.trim() });
        else onAnswer(item.id, { skipped: true });
        return;
      }
      if (isPlan) {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault();
          onAnswer(item.id, { approved: true, note: planNote.trim() });
        }
        return;
      }
      const inCustom = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('question-dock-input');
      if (inCustom) return;
      if (!isMulti && /^[1-9]$/.test(e.key)) {
        const idx = Number(e.key) - 1;
        if (curOpts[idx]) {
          e.preventDefault();
          commitStepAnswer(curOpts[idx].cleanLabel || curOpts[idx].label);
        }
      } else if (e.key === 'ArrowDown' && curOpts.length) {
        e.preventDefault();
        setSelectedOpt((s) => (s + 1) % curOpts.length);
      } else if (e.key === 'ArrowUp' && curOpts.length) {
        e.preventDefault();
        setSelectedOpt((s) => (s - 1 + curOpts.length) % curOpts.length);
      } else if (e.key === 'Enter' && !isMulti && curOpts[selectedOpt]) {
        e.preventDefault();
        commitStepAnswer(curOpts[selectedOpt].cleanLabel || curOpts[selectedOpt].label);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [item && item.id, isPlan, isMulti, stepIdx, curOpts, selectedOpt, answers, planNote]);

  if (!item) return null;

  return (
    <div className="question-dock" ref={dockRef} role="region" aria-label={isPlan ? 'Plan approval' : 'Agent question'}>
      <div className="question-dock-head">
        <div className="question-dock-title">
          <Icon name={isPlan ? 'CheckCircle' : 'Help'} size={15} />
          <span>{isPlan ? 'Plan Approval' : ((curQ && curQ.header) || 'Akron Code asks')}</span>
          {!isPlan && questions.length > 1 && (
            <span className="question-dock-badge">{stepIdx + 1} of {questions.length}</span>
          )}
          {queue.length > 1 && (
            <span className="question-dock-badge">+{queue.length - 1} queued</span>
          )}
        </div>
        <button
          type="button"
          className="media-doc-btn"
          title="Skip / Dismiss (Esc)"
          onClick={() => (isPlan ? onAnswer(item.id, { approved: false, note: '' }) : onAnswer(item.id, { skipped: true }))}
        >
          {isPlan ? 'Reject' : 'Skip (Esc)'}
        </button>
      </div>

      {isPlan ? (
        <>
          <div className="question-dock-plan-md md" dangerouslySetInnerHTML={{ __html: renderMarkdown(item.text || '') }} />
          <div className="question-dock-custom">
            <input
              className="question-dock-input"
              placeholder="Optional steering note or requested changes…"
              value={planNote}
              onChange={(e) => setPlanNote(e.target.value)}
            />
          </div>
          <div className="question-dock-foot">
            <span className="question-dock-hints">⌘⏎ Approve & Execute · Esc Reject</span>
            <div className="question-dock-actions">
              <button
                type="button"
                className="media-doc-btn"
                onClick={() => onAnswer(item.id, { approved: false, note: planNote.trim() })}
              >
                Request Changes
              </button>
              <button
                type="button"
                className="primary"
                onClick={() => onAnswer(item.id, { approved: true, note: planNote.trim() })}
              >
                Approve & Execute
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {questions.length > 1 && (
            <div className="question-dock-steps">
              {questions.map((q, idx) => {
                const answered = answers[q.id] != null && String(answers[q.id]).length > 0;
                return (
                  <button
                    key={q.id}
                    type="button"
                    className={'question-step-pill' + (idx === stepIdx ? ' active' : '') + (answered ? ' answered' : '')}
                    onClick={() => { setStepIdx(idx); setSelectedOpt(0); }}
                  >
                    {idx + 1}. {q.header || `Q${idx + 1}`}{answered ? ' ✓' : ''}
                  </button>
                );
              })}
            </div>
          )}

          {curQ && <div className="question-dock-prompt">{curQ.question}</div>}

          {curOpts.length > 0 && (
            <div className="question-dock-options">
              {curOpts.map((o, idx) => {
                const label = o.cleanLabel || o.label || String(o);
                const checked = isMulti
                  ? (Array.isArray(answers[curId]) && answers[curId].includes(label))
                  : (answers[curId] === label || idx === selectedOpt);
                return (
                  <button
                    key={idx}
                    type="button"
                    className={'question-opt' + (checked ? ' selected' : '')}
                    onClick={() => (isMulti ? toggleMultiOption(label) : commitStepAnswer(label))}
                  >
                    <span className="question-opt-num">{isMulti ? (checked ? '✓' : ' ') : idx + 1}</span>
                    <div className="question-opt-body">
                      <div className="question-opt-label">
                        <span>{label}</span>
                        {o.recommended && <span className="question-rec-pill">Recommended</span>}
                      </div>
                      {o.description && <div className="question-opt-desc">{o.description}</div>}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          <div className="question-dock-custom">
            {questions.length > 1 && stepIdx > 0 && (
              <button
                type="button"
                className="media-doc-btn"
                onClick={() => { setStepIdx((s) => Math.max(0, s - 1)); setSelectedOpt(0); }}
              >
                Back
              </button>
            )}
            <input
              className="question-dock-input"
              placeholder="Other / Type custom answer…"
              value={customVal}
              onChange={(e) => setCustomByStep({ ...customByStep, [curId]: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && customVal.trim()) {
                  e.preventDefault();
                  commitStepAnswer(customVal.trim());
                }
              }}
            />
            {isMulti ? (
              <button
                type="button"
                className="primary"
                onClick={() => {
                  const arr = Array.isArray(answers[curId]) ? [...answers[curId]] : [];
                  if (customVal.trim()) arr.push(customVal.trim());
                  commitStepAnswer(arr);
                }}
              >
                {stepIdx + 1 < questions.length ? 'Next' : 'Submit selected'}
              </button>
            ) : (
              <button
                type="button"
                className="primary"
                disabled={!customVal.trim()}
                onClick={() => customVal.trim() && commitStepAnswer(customVal.trim())}
              >
                {stepIdx + 1 < questions.length ? 'Next' : 'Send'}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
