// Pure helpers behind the model picker's key / quota dots.
// Kept out of App.jsx (JSX) so they can be unit-tested in plain node.

export const normBase = (u) => String(u || '').replace(/\/+$/, '');
export const LOCAL_BASE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;
export const KEY_STATUS_TTL = 60 * 1000;

// Last 6 chars distinguish two keys without storing the secret twice.
export const keySig = (apiKey) => (apiKey || '').slice(-6);

// A cached verdict only applies to the exact key it was learned from and only
// for a minute, so pasting a new key can never inherit the previous dot.
export function statusOf(status, base, apiKey, now = Date.now()) {
  const s = status && status[base];
  if (!s) return null;
  if (s.sig !== undefined && s.sig !== keySig(apiKey)) return null;
  if (s.at && now - s.at > KEY_STATUS_TTL) return null;
  return s;
}

// How one preset should render in the picker:
//   row: 'live' (light green — auth accepted) | 'dim' (no usable key) | ''
//   dot: 'ok' (green, quota available) | 'out' (red, out of credit/bad key) | 'idle'
export function presetStatus(p, ctx) {
  const base = normBase(p.baseURL);
  if (!base) return { row: 'dim', dot: 'idle', label: 'Custom endpoint — configure it in Manage providers' };
  const key = ctx.keyFor(p);
  const local = LOCAL_BASE.test(base);
  if (!key && !local) return { row: 'dim', dot: 'idle', label: 'No API key — click to add one' };
  const s = statusOf(ctx.status, base, key, ctx.now);
  const state = s && s.state;
  if (state === 'ok') return { row: 'live', dot: 'ok', label: s.detail || 'Quota available' };
  if (state === 'out') return { row: 'live', dot: 'out', label: s.detail || 'Out of credit' };
  if (state === 'badkey') return { row: 'dim', dot: 'out', label: s.detail || 'Key rejected' };
  return { row: '', dot: 'idle', label: local ? 'Local endpoint' : (ctx.probing ? 'Checking key…' : 'Key set — status unknown') };
}
