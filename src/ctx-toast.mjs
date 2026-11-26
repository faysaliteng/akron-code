// Context-pressure toast: when it may speak, and which warning a dismissal covers.
//
// The rule lives here rather than inline in the component so it can be tested
// without a DOM: the interesting part is not the markup, it is that hiding the
// 70 % warning must never swallow the 90 % one, and that a dismissal must not
// outlive the turn that earned it.

export const TOAST_WARM = 70; // % of the window where the first warning is earned
export const TOAST_HOT = 90; // % where the wording escalates

// Tone from a single rounded percentage, so the number the user reads
// ("90% of the window used") can never disagree with the wording above it.
export function ctxTone(pct) {
  const p = Number(pct);
  if (!Number.isFinite(p)) return 'cool';
  if (p >= TOAST_HOT) return 'hot';
  if (p >= TOAST_WARM) return 'warm';
  return 'cool';
}

export function ctxPercent(used, win) {
  const w = Number(win) || 0;
  const u = Number(used) || 0;
  if (!(w > 0) || !(u > 0)) return 0;
  return Math.round((u / w) * 100);
}

/**
 * @param {object} s
 * @param {number} s.used      tokens attributed to this conversation
 * @param {number} s.win       the model's context window
 * @param {string|null} s.closedTone  the tone the user last dismissed
 * @param {number} s.closedAt  the usage timestamp that dismissal belonged to
 * @param {number} s.seenAt    the current turn's usage timestamp
 * @returns {{tone:string, pct:number, visible:boolean}}
 */
export function ctxToastState(s) {
  const o = s || {};
  const pct = ctxPercent(o.used, o.win);
  const tone = ctxTone(pct);
  const seenAt = Number(o.seenAt) || 0;
  const closedAt = Number(o.closedAt) || 0;
  // Keyed to the tone: a 70 % dismissal stays dismissed while the turn it was
  // earned on is the current turn, but the 90 % escalation is a different tone
  // and therefore speaks. A later turn (seenAt > closedAt) revives the toast
  // too, because pressure you already acknowledged can still be getting worse.
  const dismissed = tone !== 'cool' && o.closedTone === tone && seenAt <= closedAt;
  return { tone, pct, visible: tone !== 'cool' && !dismissed };
}
