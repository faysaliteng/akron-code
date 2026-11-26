'use strict';

// ---- Orchestrator pool validation -------------------------------------------
// Every anonymous pool row is a claim: "<this gateway> serves <this model>".
// Only the gateway can settle it, and the price of not asking is a mystery 404
// at turn time. Measured 2026-11-26: a stale row in ~/.autobot/orchestrator.json
// pointed at http://localhost:11434/v1 (Ollama) and asked for `claude-fable-5-2`,
// so the user saw
//
//   "The provider says that model or endpoint does not exist —
//    model 'claude-fable-5-2' not found"
//
// which reads like a dead Claude subscription and was in fact a local model
// server doing exactly what it was told. Nothing in that sentence named Ollama.
//
// So before a row is allowed to carry a turn, ask its gateway once:
//
//   GET <base>/models        (and <base>/v1/models when the base has no /v1)
//
// A row is dropped ONLY on positive evidence — the gateway answered 200 with a
// model list, and the row's model is not in it. A gateway we cannot ask (no
// answer, 401, 5xx, a body with no ids, an empty catalogue) leaves the row
// untouched and reports it as unverified: the app never invents a failure it
// did not observe. Subscription rows have no anonymous endpoint to ask; their
// binding is resolved in main and a bad one surfaces as its own error.

function normBase(u) {
  return String(u || '').trim().replace(/\/+$/, '');
}

function candidateURLs(base) {
  const b = normBase(base);
  if (!b) return [];
  // A base that already names the API version (…/v1, …/v1beta/openai) mounts
  // /models directly; a bare host is usually one segment shy.
  if (/\/v\d+(?:[a-z0-9./-]*)$/i.test(b)) return [b + '/models'];
  return [b + '/models', b + '/v1/models'];
}

// Accepts the three shapes OpenAI-compatible servers actually return:
//   {"data":[{"id":"…"}]}   {"models":[{"name":"…"}]}   ["…","…"]
function parseIds(text) {
  let j;
  try {
    j = JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
  const list = Array.isArray(j)
    ? j
    : (j && Array.isArray(j.data) ? j.data
      : (j && Array.isArray(j.models) ? j.models : null));
  if (!list) return null;
  const ids = new Set();
  for (const m of list) {
    const id = typeof m === 'string' ? m : (m && (m.id || m.name || m.model));
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  // A 200 with entries we cannot name is not evidence about anything, and an
  // empty catalogue is what a router with no keys answers — never prune on it.
  return ids.size ? ids : null;
}

async function servedModels(row, opts) {
  const fetchImpl = (opts && opts.fetchImpl) || (typeof fetch === 'function' ? fetch : null);
  const timeoutMs = Number(opts && opts.timeoutMs) || 4000;
  if (!fetchImpl) return { ok: false, why: 'no fetch available' };
  const headers = {};
  if (row && row.apiKey) headers.authorization = 'Bearer ' + row.apiKey;
  let last = { ok: false, why: 'no answer' };
  for (const url of candidateURLs(row && row.baseURL)) {
    const ac = (opts && opts.controllerFactory) ? opts.controllerFactory() : new AbortController();
    let timer = null;
    try {
      const call = fetchImpl(url, { headers, signal: ac.signal });
      const res = timeoutMs > 0
        ? await Promise.race([
          call,
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              try { ac.abort(); } catch (_) {}
              reject(new Error('timed out after ' + timeoutMs + 'ms'));
            }, timeoutMs);
          }),
        ])
        : await call;
      const text = await res.text();
      if (!res.ok) {
        last = { ok: false, why: 'HTTP ' + res.status + ' from ' + url };
        continue;
      }
      const ids = parseIds(text);
      if (!ids) {
        last = { ok: false, why: 'no model list in the answer from ' + url };
        continue;
      }
      return { ok: true, url, ids };
    } catch (e) {
      last = { ok: false, why: (e && e.message) || 'request failed' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return last;
}

// Returns the rows worth keeping, plus a named reason for every row that was
// dropped and for every row that could not be asked. `index` is the row's
// position in the input array, so a caller can filter a parallel (hydrated)
// array with the same offsets.
async function pruneUnserved(entries, opts) {
  const rows = Array.isArray(entries) ? entries : [];
  const decisions = await Promise.all(rows.map(async (row, index) => {
    if (!row || typeof row !== 'object') return { index, keep: true };
    if (row.oauthProvider) return { index, keep: true };
    const base = normBase(row.baseURL);
    const model = String(row.model || '').trim();
    if (!base || !model) return { index, keep: true };
    const r = await servedModels(row, opts || {});
    if (!r.ok) return { index, keep: true, unverified: r.why };
    const wanted = model.toLowerCase();
    let hit = false;
    for (const id of r.ids) {
      if (String(id).toLowerCase() === wanted) { hit = true; break; }
    }
    if (hit) return { index, keep: true, checked: true };
    return {
      index,
      keep: false,
      checked: true,
      why: r.url + ' serves ' + r.ids.size + ' model' + (r.ids.size === 1 ? '' : 's') + ' and ' + model + ' is not one of them',
    };
  }));

  const out = { providers: [], dropped: [], unverified: [], checked: 0 };
  for (let i = 0; i < rows.length; i++) {
    const d = decisions.find((x) => x.index === i) || { index: i, keep: true };
    if (d.checked) out.checked++;
    if (d.keep) {
      out.providers.push(rows[i]);
      if (d.unverified) out.unverified.push({ index: i, entry: rows[i], why: d.unverified });
    } else {
      out.dropped.push({ index: i, entry: rows[i], why: d.why });
    }
  }
  return out;
}

module.exports = { pruneUnserved, servedModels, parseIds, candidateURLs, normBase };
