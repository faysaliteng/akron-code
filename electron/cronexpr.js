'use strict';
// Minimal 5-field cron parser (local time), matching the semantics Example Code
// uses for CronCreate: "minute hour day-of-month month day-of-week".
//
//   *  *  *  *  *     any
//   0  9  *  *  1-5   weekdays at 09:00
//   */15 * * * *      every 15 minutes
//   30 8 1 * *        the 1st of each month at 08:30
//
// Supports: numbers, `*`, ranges `a-b`, lists `a,b,c`, steps `*/n` and `a-b/n`.
// Day-of-week accepts 0-7 (0 and 7 are both Sunday). Field names (sun, mon…) are
// accepted for month and day-of-week. Returns the next fire time strictly after
// `from`, or null if the expression can never fire (e.g. `0 0 30 2 *`).

const DOW_NAMES = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseField(expr, min, max, names) {
  const values = new Set();
  const parts = String(expr || '').trim().split(',');
  for (const rawPart of parts) {
    let part = rawPart.trim().toLowerCase();
    if (!part) continue;
    let step = 1;
    const slash = part.split('/');
    if (slash.length === 2) {
      part = slash[0];
      step = parseInt(slash[1], 10);
      if (!Number.isFinite(step) || step < 1) return { ok: false, error: `bad step in "${rawPart}"` };
    } else if (slash.length > 2) {
      return { ok: false, error: `bad field "${rawPart}"` };
    }
    let lo, hi;
    if (part === '*' || part === '') { lo = min; hi = max; }
    else if (part.includes('-')) {
      const [a, b] = part.split('-');
      lo = resolveToken(a, min, max, names);
      hi = resolveToken(b, min, max, names);
    } else {
      lo = resolveToken(part, min, max, names);
      hi = lo;
      // `5/10` means "from 5 to max, every 10".
      if (step > 1) hi = max;
    }
    if (lo == null || hi == null) return { ok: false, error: `bad value in "${rawPart}"` };
    if (lo > hi) return { ok: false, error: `reversed range in "${rawPart}"` };
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (!values.size) return { ok: false, error: 'empty field' };
  return { ok: true, values };
}

function resolveToken(t, min, max, names) {
  const s = String(t).trim().toLowerCase();
  if (s === '*' || s === '?') return min;
  if (names && names[s] != null) return names[s];
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return null;
  let v = n;
  if (names === DOW_NAMES && v === 7) v = 0; // 7 is Sunday, same as 0
  if (v < min || v > max) return null;
  return v;
}

function parse(expr) {
  const fields = String(expr || '').trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: 'cron must have exactly 5 fields: minute hour day-of-month month day-of-week' };
  const minute = parseField(fields[0], 0, 59, null);
  if (!minute.ok) return { ok: false, error: 'minute: ' + minute.error };
  const hour = parseField(fields[1], 0, 23, null);
  if (!hour.ok) return { ok: false, error: 'hour: ' + hour.error };
  const dom = parseField(fields[2], 1, 31, null);
  if (!dom.ok) return { ok: false, error: 'day-of-month: ' + dom.error };
  const month = parseField(fields[3], 1, 12, MON_NAMES);
  if (!month.ok) return { ok: false, error: 'month: ' + month.error };
  const dow = parseField(fields[4], 0, 6, DOW_NAMES);
  if (!dow.ok) return { ok: false, error: 'day-of-week: ' + dow.error };
  return {
    ok: true,
    spec: {
      minute: minute.values, hour: hour.values, dom: dom.values, month: month.values, dow: dow.values,
      domStar: fields[2].trim() === '*', dowStar: fields[4].trim() === '*',
    },
  };
}

/** Next fire time strictly after `from` (epoch ms), or null. */
function next(expr, from) {
  const p = typeof expr === 'string' ? parse(expr) : expr;
  if (!p || !p.ok) return null;
  const s = p.spec;
  let d = new Date(from == null ? Date.now() : from);
  d.setSeconds(0, 0);
  d = new Date(d.getTime() + 60 * 1000); // strictly after
  // Bound the search: 4 years covers any legal cron including Feb 29.
  for (let i = 0; i < 60 * 24 * 366 * 4; i++) {
    if (!s.month.has(d.getMonth() + 1)) { d = new Date(d.getFullYear(), d.getMonth() + 1, 1, 0, 0, 0, 0); continue; }
    // Standard cron: if BOTH dom and dow are restricted, either may match.
    const domOk = s.dom.has(d.getDate());
    const dowOk = s.dow.has(d.getDay());
    let dayOk;
    if (s.domStar && s.dowStar) dayOk = true;
    else if (s.domStar) dayOk = dowOk;
    else if (s.dowStar) dayOk = domOk;
    else dayOk = domOk || dowOk;
    if (!dayOk) { d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 0, 0); continue; }
    if (!s.hour.has(d.getHours())) { d = new Date(d.getTime() + 60 * 60 * 1000); d.setMinutes(0, 0, 0); continue; }
    if (!s.minute.has(d.getMinutes())) { d = new Date(d.getTime() + 60 * 1000); continue; }
    return d.getTime();
  }
  return null;
}

function validate(expr) {
  const p = parse(expr);
  if (!p.ok) return p;
  if (next(p, Date.now()) == null) return { ok: false, error: 'expression can never fire' };
  return { ok: true };
}

function describe(expr) {
  const p = parse(expr);
  if (!p.ok) return expr;
  const s = p.spec;
  const fmt = (set, fn) => [...set].sort((a, b) => a - b).map(fn).join(',');
  const mins = fmt(s.minute, (m) => String(m).padStart(2, '0'));
  const hrs = fmt(s.hour, (h) => String(h).padStart(2, '0'));
  const days = s.dowStar ? '' : ' on ' + fmt(s.dow, (x) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][x]);
  return `${hrs}:${mins}${days}`;
}

module.exports = { parse, next, validate, describe };
