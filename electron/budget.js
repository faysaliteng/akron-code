'use strict';
// Token budget pool — Claude Code's `budget` workflow global.
//
// Example exposes `budget: { total, spent(), remaining() }` to workflow scripts and
// backs it with a per-turn output-token pool that is SHARED by the main agent loop
// and every workflow agent. `total` comes from a "+500k"-style directive in the
// user's message; null means "no target" and `remaining()` is Infinity. The target
// is a HARD ceiling: once spent() reaches total, further agent() calls throw.
//
// The pool lives here (not in llm.js) so workflow.js, parity.js and the agent loop
// all read the same counter without an import cycle.

const state = {
  total: null,
  spent: 0,
};

// "+500k", "+1.5m", "+250000" — require an explicit '+' so "+880" style phone
// numbers and "5 minutes" cannot be mistaken for a budget. A bare number needs to
// be large enough to obviously be a token target (>= 1000) to count.
const DIRECTIVE = /(?:^|\s)\+\s*(\d+(?:[.,]\d+)?)\s*([kmb])?(?![a-z0-9])/i;

function parseDirective(text) {
  const s = String(text == null ? '' : text);
  const m = DIRECTIVE.exec(s);
  if (!m) return null;
  const n = Number(String(m[1]).replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] || '').toLowerCase();
  const mult = unit === 'k' ? 1000 : unit === 'm' ? 1e6 : unit === 'b' ? 1e9 : 1;
  // A bare number must be plausibly a token target: >= 1000 and not so huge it is
  // obviously something else (a phone number like +8801234567 parses to 8.8e9).
  // Unit-suffixed values are always honoured.
  if (!unit && (n < 1000 || n > 100000000)) return null;
  return Math.round(n * mult);
}

// Set (or clear) the turn's target. Passing null/undefined/0 clears it.
function setTotal(n) {
  const v = Number(n);
  state.total = Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  return state.total;
}

// Scan a user message for a directive. Returns the parsed value (or null) and
// applies it only when one was found, so a plain message never clears the target.
function applyDirective(text) {
  const n = parseDirective(text);
  if (n != null) setTotal(n);
  return n;
}

function addOutput(n) {
  const v = Number(n);
  if (Number.isFinite(v) && v > 0) state.spent += Math.round(v);
  return state.spent;
}

function spent() { return state.spent; }

function remaining() {
  if (state.total == null) return Infinity;
  return Math.max(0, state.total - state.spent);
}

function exhausted() {
  return state.total != null && state.spent >= state.total;
}

// The object handed to workflow scripts (`budget.total` / `budget.spent()` /
// `budget.remaining()`). `spent` and `remaining` are live.
function view() {
  return {
    total: state.total,
    spent,
    remaining,
  };
}

function reset() {
  state.total = null;
  state.spent = 0;
}

module.exports = { parseDirective, applyDirective, setTotal, addOutput, spent, remaining, exhausted, view, reset };
