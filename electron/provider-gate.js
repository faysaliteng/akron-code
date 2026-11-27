'use strict';
// ---- Provider gate: shared cooldowns + concurrency caps ---------------------
//
// One process-wide view of "which model rows are usable right now". Before
// this, every runAgent call (the main turn, each Task sub-agent, each swarm
// worker) kept its own failover index and re-discovered the same 429 on its
// own: four parallel workers on a free gateway hit the same rate-limited row
// four times, each sleeping through its own backoff ladder.
//
//   cooldown  — a row that answered 429 is skipped by EVERY caller until the
//               provider's reset time (or an exponential guess) has passed.
//   dead      — a row whose gateway disowned the model (404) or rejected the
//               credential (401/403) is skipped for a while instead of
//               killing the turn while healthy rows remain below it.
//   capacity  — a row may carry `maxConcurrent`; failover prefers a free row
//               over queuing on a busy one, which is what spreads N parallel
//               workers across providers instead of piling onto one.
//
// Pure module state, no Electron imports: unit-testable in plain node.

const state = new Map(); // key -> { until, strikes, deadUntil, deadWhy, inflight, waiters: [] }

function keyOf(p) {
  if (!p) return '';
  if (p.gateKey) return String(p.gateKey);
  if (p.oauthProvider) return 'oauth|' + p.oauthProvider + '|' + String(p.model || '');
  return String(p.baseURL || '').replace(/\/+$/, '').replace('://localhost', '://127.0.0.1') + '|' + String(p.model || '');
}

// Some subscriptions meter usage per ACCOUNT, not per model: Google's
// Antigravity / Cloud Code quota is shared by every Gemini model on the same
// login. A 429 on one model there must cool its siblings too, otherwise the
// failover loop just burns the same allowance on the next Gemini row.
const SHARED_QUOTA = /^(antigravity|google|gemini|cloudcode|gemini-cli)\b/i;

function accountKeyOf(p) {
  if (!p || p.gateKey) return '';
  const op = String(p.oauthProvider || '');
  if (!op || !SHARED_QUOTA.test(op)) return '';
  return 'acct|' + op;
}

function slot(k) {
  let x = state.get(k);
  if (!x) {
    x = { until: 0, strikes: 0, deadUntil: 0, deadWhy: '', inflight: 0, waiters: [] };
    state.set(k, x);
  }
  return x;
}

function acct(p) {
  const k = accountKeyOf(p);
  return k ? slot(k) : null;
}

function s(p) {
  const k = keyOf(p);
  let x = state.get(k);
  if (!x) {
    x = { until: 0, strikes: 0, deadUntil: 0, deadWhy: '', inflight: 0, waiters: [] };
    state.set(k, x);
  }
  return x;
}

const now = () => Date.now();

function isDead(p) { return s(p).deadUntil > now(); }
function deadReason(p) { return s(p).deadWhy || ''; }
function coolingFor(p) {
  const a = acct(p);
  return Math.max(0, s(p).until - now(), a ? a.until - now() : 0);
}
function usable(p) { return !isDead(p) && coolingFor(p) === 0; }
function inflight(p) { return s(p).inflight || 0; }
function keyFor(p) { return keyOf(p); }

// Mark a row rate-limited. `retryAfterMs` (from Retry-After / the gateway's
// own reset estimate) wins; otherwise back off exponentially per strike.
function rateLimited(p, retryAfterMs) {
  const t = now();
  const x = s(p);
  const ra = Number(retryAfterMs) > 0 ? Math.min(Number(retryAfterMs), 15 * 60000) : 0;
  // Do not escalate strikes if this row is already inside an active cooldown window.
  const rowFreshOrExplicit = x.until <= t || ra > 0;
  if (rowFreshOrExplicit) {
    x.strikes = Math.min(x.strikes + 1, 8);
  }
  const guess = Math.min(10000 * Math.pow(2, Math.max(1, x.strikes) - 1), 300000);
  x.until = Math.max(x.until, t + (ra || guess));
  const a = acct(p);
  if (a) {
    if (rowFreshOrExplicit) {
      a.strikes = Math.min(a.strikes + 1, 8);
    }
    const ag = Math.min(10000 * Math.pow(2, Math.max(1, a.strikes) - 1), 300000);
    a.until = Math.max(a.until, t + (ra || ag));
    x.until = Math.max(x.until, a.until);
  }
  return x.until;
}

function ok(p) {
  const x = s(p);
  x.strikes = 0;
  x.until = 0;
  const a = acct(p);
  if (a) { a.strikes = 0; a.until = 0; }
}

function markDead(p, why, ms) {
  const x = s(p);
  x.deadUntil = now() + (Number(ms) > 0 ? Number(ms) : 10 * 60000);
  x.deadWhy = String(why || '').slice(0, 200);
}

function capOf(p) {
  const c = Number(p && p.maxConcurrent);
  return Number.isFinite(c) && c > 0 ? Math.floor(c) : Infinity;
}

function hasCapacity(p) { return s(p).inflight < capOf(p); }

// Take a slot immediately or return null.
function tryAcquire(p) {
  const x = s(p);
  if (x.inflight >= capOf(p)) return null;
  x.inflight++;
  return makeRelease(p);
}

// Wait for a slot (abortable).
function acquire(p, signal) {
  const rel = tryAcquire(p);
  if (rel) return Promise.resolve(rel);
  const x = s(p);
  return new Promise((resolve, reject) => {
    const w = { resolve: null };
    const onAbort = () => {
      const i = x.waiters.indexOf(w);
      if (i >= 0) x.waiters.splice(i, 1);
      reject(new Error('aborted'));
    };
    w.resolve = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      x.inflight++;
      resolve(makeRelease(p));
    };
    if (signal) {
      if (signal.aborted) return reject(new Error('aborted'));
      signal.addEventListener('abort', onAbort, { once: true });
    }
    x.waiters.push(w);
  });
}

function makeRelease(p) {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const x = s(p);
    x.inflight = Math.max(0, x.inflight - 1);
    const next = x.waiters.shift();
    if (next) next.resolve();
  };
}

// Order a failover list for one request: start at `start`, walk DOWN the list
// (wrapping), usable rows first in that order, then rows that are cooling
// (soonest reset first), dead rows last. Among usable rows, ones with a free
// slot come before saturated ones so parallel callers spread out.
function order(list, start) {
  const n = list.length;
  const idx = [];
  for (let a = 0; a < n; a++) idx.push((((start || 0) + a) % n + n) % n);
  const free = [], busy = [], cooling = [], dead = [];
  for (const i of idx) {
    const p = list[i];
    if (isDead(p)) dead.push(i);
    else if (coolingFor(p) > 0) cooling.push(i);
    else if (hasCapacity(p)) free.push(i);
    else busy.push(i);
  }
  cooling.sort((a, b) => coolingFor(list[a]) - coolingFor(list[b]));
  return free.concat(busy, cooling, dead);
}

function soonestReset(list) {
  let best = Infinity;
  for (const p of list || []) {
    if (isDead(p)) continue;
    best = Math.min(best, coolingFor(p));
  }
  return best === Infinity ? 0 : best;
}

// FreeLLMAPI (and similar routers) put the reset in the JSON body rather than
// a Retry-After header: `{"error":{"retryAtMs":1795666001602,…}}` or prose
// "Soonest reset ~86s" / "~2m".
function retryHintMs(text) {
  const t = String(text || '');
  const at = /"retryAtMs"\s*:\s*(\d{12,})/.exec(t);
  if (at) {
    const d = Number(at[1]) - now();
    if (d > 0) return Math.min(d, 15 * 60000);
  }
  const m = /(?:reset|retry|try again)[^~\d]{0,24}~?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?|m|min|minutes?|h|hours?)\b/i.exec(t);
  if (m) {
    const v = Number(m[1]);
    const u = m[2].toLowerCase();
    const ms = u === 'ms' ? v : u.startsWith('h') ? v * 3600000 : (u === 'm' || u.startsWith('min')) ? v * 60000 : v * 1000;
    if (ms > 0) return Math.min(ms, 15 * 60000);
  }
  return 0;
}

function snapshot() {
  const out = {};
  for (const [k, x] of state) {
    out[k] = { coolingMs: Math.max(0, x.until - now()), strikes: x.strikes, dead: x.deadUntil > now(), deadWhy: x.deadWhy, inflight: x.inflight, queued: x.waiters.length };
  }
  return out;
}

function reset() { state.clear(); }

module.exports = {
  keyOf, keyFor, accountKeyOf, usable, isDead, deadReason, coolingFor, inflight, rateLimited, ok, markDead, capOf, hasCapacity,
  tryAcquire, acquire, order, soonestReset, retryHintMs, snapshot, reset,
};
