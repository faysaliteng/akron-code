'use strict';
// Normalization & run-scoped gate for AskUserQuestion and ExitPlanMode.
// Accepts both structured `{ questions: [...] }` and legacy `{ question, options }` forms.

function normalizeOption(opt) {
  if (typeof opt === 'string') {
    const raw = opt.trim();
    const recommended = /\(recommended\)/i.test(raw);
    const cleanLabel = raw.replace(/\s*\(recommended\)\s*/ig, ' ').trim();
    return { label: raw, cleanLabel: cleanLabel || raw, description: '', recommended };
  }
  const o = opt && typeof opt === 'object' ? opt : { label: String(opt || '') };
  const raw = String(o.label || o.value || o.title || '').trim();
  const recommended = Boolean(o.recommended) || /\(recommended\)/i.test(raw);
  const cleanLabel = raw.replace(/\s*\(recommended\)\s*/ig, ' ').trim();
  return {
    label: raw || 'Option',
    cleanLabel: cleanLabel || raw || 'Option',
    description: String(o.description || o.desc || '').trim(),
    recommended,
  };
}

function normalizeAskPayload(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : { question: String(raw || 'Continue?') };
  const rawList = Array.isArray(src.questions) && src.questions.length
    ? src.questions
    : [{
      id: src.id || 'q0',
      header: src.header || '',
      question: src.question || src.prompt || src.text || 'Continue?',
      options: Array.isArray(src.options) ? src.options : [],
      multiSelect: Boolean(src.multiSelect || src.is_multi_select),
    }];

  const questions = rawList.map((q, idx) => {
    const item = q && typeof q === 'object' ? q : { question: String(q || 'Continue?') };
    const options = Array.isArray(item.options) ? item.options.map(normalizeOption) : [];
    const multiSelect = Boolean(item.multiSelect || item.is_multi_select);
    return {
      id: String(item.id || `q${idx}`),
      header: String(item.header || '').slice(0, 24),
      question: String(item.question || item.prompt || item.text || 'Continue?'),
      multiSelect,
      isMultiSelect: multiSelect,
      options,
    };
  });

  return {
    questions,
    primaryQuestion: questions[0] ? questions[0].question : 'Continue?',
    primaryOptions: questions[0] ? questions[0].options : [],
  };
}

function formatResolvedAnswer(normalized, answerPayload) {
  if (answerPayload && typeof answerPayload === 'object' && !Array.isArray(answerPayload)) {
    if (answerPayload.skipped) return '(skipped by user)';
    if (answerPayload.answers && typeof answerPayload.answers === 'object') {
      const answers = answerPayload.answers;
      const lines = normalized.questions.map((q) => {
        const val = answers[q.id] ?? answers[q.question] ?? '';
        const textVal = Array.isArray(val) ? val.join(', ') : String(val || '');
        return `${q.header || q.question}: ${textVal}`;
      });
      return `${lines.join('\n')}\n\n${JSON.stringify({ answers })}`;
    }
    if (answerPayload.answer != null) return String(answerPayload.answer);
  }
  return String(answerPayload == null ? '(no answer)' : answerPayload);
}

function formatResolvedPlanAnswer(payload) {
  if (payload && typeof payload === 'object') {
    const note = String(payload.note || payload.feedback || '').trim();
    if (payload.approved) {
      return 'Plan approved. Proceed.' + (note ? ` Note: ${note}` : '');
    }
    return 'Plan not approved.' + (note ? ` Requested changes: ${note}` : '');
  }
  return String(payload || '(plan not approved)');
}

function createQuestionGate(pendingMap = new Map()) {
  let seq = 1;
  const metaById = new Map(); // id -> { runId, convId, kind }

  const clearRun = (runId, emit) => {
    if (!runId) return;
    for (const [id, meta] of [...metaById.entries()]) {
      if (meta.runId === runId) {
        const res = pendingMap.get(id);
        pendingMap.delete(id);
        metaById.delete(id);
        if (typeof res === 'function') {
          try { res(meta.kind === 'plan' ? '(plan not approved)' : '(cancelled)'); } catch (_) {}
        }
        if (typeof emit === 'function') {
          try { emit({ type: 'questionCleared', id, runId, convId: meta.convId || null }); } catch (_) {}
        }
      }
    }
  };

  const ask = async ({ raw, runId = null, convId = null, signal = null, emit }) => {
    const id = 'q' + seq++;
    const normalized = normalizeAskPayload(raw);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (ans) => {
        if (settled) return;
        settled = true;
        pendingMap.delete(id);
        metaById.delete(id);
        if (signal && onAbort) {
          try { signal.removeEventListener('abort', onAbort); } catch (_) {}
        }
        resolve(formatResolvedAnswer(normalized, ans));
      };
      const onAbort = () => {
        if (typeof emit === 'function') {
          try { emit({ type: 'questionCleared', id, runId, convId }); } catch (_) {}
        }
        finish('(cancelled)');
      };

      pendingMap.set(id, finish);
      metaById.set(id, { runId, convId, kind: 'question' });
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (typeof emit === 'function') {
        emit({
          type: 'question',
          id,
          runId,
          convId,
          questions: normalized.questions,
          question: normalized.primaryQuestion,
          options: normalized.primaryOptions,
        });
      }
    });
  };

  const askPlan = async ({ raw, runId = null, convId = null, signal = null, emit }) => {
    const id = 'q' + seq++;
    const p = raw && typeof raw === 'object' ? raw : { plan: String(raw || '') };
    const planText = String(p.plan || p.content || '');
    const allowedPrompts = Array.isArray(p.allowedPrompts) ? p.allowedPrompts : [];

    return new Promise((resolve) => {
      let settled = false;
      const finish = (ans) => {
        if (settled) return;
        settled = true;
        pendingMap.delete(id);
        metaById.delete(id);
        if (signal && onAbort) {
          try { signal.removeEventListener('abort', onAbort); } catch (_) {}
        }
        resolve(formatResolvedPlanAnswer(ans));
      };
      const onAbort = () => {
        if (typeof emit === 'function') {
          try { emit({ type: 'questionCleared', id, runId, convId }); } catch (_) {}
        }
        finish({ approved: false, note: 'run aborted' });
      };

      pendingMap.set(id, finish);
      metaById.set(id, { runId, convId, kind: 'plan' });
      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
      if (typeof emit === 'function') {
        emit({
          type: 'plan',
          id,
          runId,
          convId,
          plan: planText,
          allowedPrompts,
        });
      }
    });
  };

  const answer = (id, payload) => {
    const resolve = pendingMap.get(id);
    if (!resolve) return { ok: false, error: 'question not found (cleared or aborted)' };
    pendingMap.delete(id);
    metaById.delete(id);
    resolve(payload);
    return { ok: true };
  };

  return { ask, askPlan, answer, clearRun };
}

module.exports = {
  normalizeOption,
  normalizeAskPayload,
  formatResolvedAnswer,
  formatResolvedPlanAnswer,
  createQuestionGate,
};
