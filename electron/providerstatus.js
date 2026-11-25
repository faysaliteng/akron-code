'use strict';
// Provider key/credit status for the model picker.
//
// The picker shows, per model preset:
//   - "not set up" (no API key)      → dimmed row
//   - "key active" (auth accepted)   → light-green row
//   - green dot  = quota available
//   - red dot    = out of credit / key rejected
//
// We can only learn that by asking the provider. `GET {baseURL}/models` is the
// cheapest authenticated call every OpenAI-compatible API exposes: it costs no
// tokens and 200/401/402/429 distinguish "fine" from "no credit" from "bad key".

const QUOTA_RE = /(insufficient|quota|credit|billing|payment|balance|out of funds|exceeded your current quota|no funds)/i;
const RATE_RE = /(rate limit|too many requests|slow down)/i;

// Pure classifier — unit-tested without any network.
function classify(status, body) {
  const text = String(body == null ? '' : body);
  if (status >= 200 && status < 300) return { state: 'ok', detail: 'Quota available' };
  if (status === 402) return { state: 'out', detail: 'Out of credit' };
  if (status === 429) {
    if (QUOTA_RE.test(text)) return { state: 'out', detail: 'Out of credit' };
    if (RATE_RE.test(text)) return { state: 'ok', detail: 'Rate limited — quota available' };
    return { state: 'ok', detail: 'Rate limited — quota available' };
  }
  if (status === 401 || status === 403) {
    if (QUOTA_RE.test(text)) return { state: 'out', detail: 'Out of credit' };
    return { state: 'badkey', detail: 'Key rejected' };
  }
  if (status === 404 || status === 405) return { state: 'unknown', detail: 'No status endpoint' };
  if (QUOTA_RE.test(text)) return { state: 'out', detail: 'Out of credit' };
  return { state: 'unknown', detail: 'Status ' + status };
}

const LOCAL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/i;

// Probe one provider. Never throws: every failure maps to a state string so the
// renderer can always paint a dot.
async function probe(baseURL, apiKey, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeout = opts.timeout || 6000;
  const base = String(baseURL || '').replace(/\/+$/, '');
  if (!base) return { state: 'unknown', detail: 'No endpoint' };
  // Local servers (Ollama, LM Studio, routers) usually need no key at all.
  const local = LOCAL_RE.test(base);
  if (!apiKey && !local) return { state: 'nokey', detail: 'No API key' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeout);
  try {
    const headers = apiKey ? { authorization: 'Bearer ' + apiKey } : {};
    const res = await fetchImpl(base + '/models', { method: 'GET', headers, signal: ctrl.signal });
    let body = '';
    try { body = (await res.text()).slice(0, 600); } catch (_) {}
    return classify(res.status, body);
  } catch (e) {
    const msg = String((e && e.message) || e);
    return { state: /abort/i.test(msg) ? 'unknown' : 'unknown', detail: 'Unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

// Probe many at once, keyed by baseURL. Duplicates (DeepSeek chat/reasoner share
// an endpoint) are collapsed so we never hammer a provider twice.
async function probeMany(list, opts = {}) {
  const entries = Array.isArray(list) ? list : [];
  const byBase = new Map();
  for (const p of entries) {
    if (!p || !p.baseURL) continue;
    const base = String(p.baseURL).replace(/\/+$/, '');
    const prev = byBase.get(base);
    // Prefer an entry that actually carries a key.
    if (!prev || (!prev.apiKey && p.apiKey)) byBase.set(base, { baseURL: base, apiKey: p.apiKey || '' });
  }
  const out = {};
  await Promise.all([...byBase.values()].slice(0, 32).map(async (p) => {
    out[p.baseURL] = await probe(p.baseURL, p.apiKey, opts);
  }));
  return out;
}

// ---------------------------------------------------------------------------
// Ollama / local model discovery
//
// A local Ollama only runs the models that were actually pulled, so a preset
// that hardcodes `llama3.1` 404s on a machine that only has `gemma4`. We ask the
// server what it has and let the picker offer exactly those models.
// ---------------------------------------------------------------------------

// Accepts `http://host:11434`, `.../v1`, `.../api`, with or without a trailing
// slash, and returns the server root used by Ollama's native API.
function ollamaRoot(baseURL) {
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return base.replace(/\/v1$/i, '').replace(/\/api$/i, '');
}

// Both shapes → [{ name, size, family }]: `/api/tags` returns { models: [...] },
// the OpenAI-compatible `/v1/models` returns { data: [{ id }] }.
function normalizeModels(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const raw = Array.isArray(payload.models) ? payload.models
    : Array.isArray(payload.data) ? payload.data
      : Array.isArray(payload) ? payload : [];
  const out = [];
  const seen = new Set();
  for (const m of raw) {
    const name = m && (m.name || m.model || m.id);
    if (!name || typeof name !== 'string') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      size: Number((m && m.size) || 0) || 0,
      family: String((m && m.details && m.details.family) || ''),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Never throws. Tries the native API first (works on every Ollama build, and is
// the only endpoint that reports sizes), then the OpenAI-compatible one.
async function ollamaModels(baseURL, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  const timeout = opts.timeout || 4000;
  const base = String(baseURL || '').trim().replace(/\/+$/, '');
  const root = ollamaRoot(base);
  if (!root) return { ok: false, base: '', models: [], via: '', detail: 'No endpoint' };

  const attempts = [
    { url: root + '/api/tags', via: 'api/tags' },
    { url: base + '/models', via: 'v1/models' },
    { url: root + '/v1/models', via: 'v1/models' },
  ];

  let lastDetail = 'Unreachable';
  for (const a of attempts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => { try { ctrl.abort(); } catch (_) {} }, timeout);
    try {
      const res = await fetchImpl(a.url, { method: 'GET', signal: ctrl.signal });
      const text = await res.text().catch(() => '');
      if (!res.ok) { lastDetail = 'Status ' + res.status; continue; }
      let payload = null;
      try { payload = JSON.parse(text); } catch (_) { lastDetail = 'Not an Ollama server'; continue; }
      const models = normalizeModels(payload);
      return {
        ok: true,
        base: root + '/v1',
        via: a.via,
        models,
        detail: models.length ? models.length + ' model' + (models.length === 1 ? '' : 's') + ' installed' : 'No models pulled yet',
      };
    } catch (e) {
      lastDetail = /abort/i.test(String((e && e.message) || e)) ? 'Timed out' : 'Unreachable';
    } finally {
      clearTimeout(timer);
    }
  }
  return { ok: false, base: root + '/v1', via: '', models: [], detail: lastDetail };
}

module.exports = { classify, probe, probeMany, ollamaRoot, normalizeModels, ollamaModels, QUOTA_RE, LOCAL_RE };
