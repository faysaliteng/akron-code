'use strict';

const VECTOR_DIM = 384;
const DEFAULT_BATCH_SIZE = 32;

const CODE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'true', 'false', 'null',
  'undefined', 'none', 'var', 'let', 'const', 'return',
]);

function hash32(str, seed = 0x811c9dc5) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Split camelCase / PascalCase / snake_case / dot / slash identifiers while
 * preserving compound tokens when meaningful.
 */
function splitCodeTokens(text) {
  const s = String(text || '');
  const parts = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-./\\:]+/g, ' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2 && !CODE_STOPWORDS.has(t));
  return parts;
}

function l2Normalize(vec) {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
  }
  return vec;
}

/**
 * 384-dim signed feature hashing over subword tokens (log-TF weighted) +
 * identifier character 3-grams, L2-normalized. Deterministic & zero-network.
 */
function embedSparse384(text) {
  const tokens = splitCodeTokens(text);
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

  const vec = new Float32Array(VECTOR_DIM);
  for (const [tok, count] of tf.entries()) {
    const w = 1 + Math.log(count);
    const idx = hash32('t:' + tok, 0x811c9dc5) % VECTOR_DIM;
    const sign = (hash32('s:' + tok, 0x9e3779b1) & 1) ? 1 : -1;
    vec[idx] += sign * w;

    if (tok.length >= 3) {
      const padded = `^${tok}$`;
      for (let i = 0; i <= padded.length - 3; i++) {
        const tri = padded.slice(i, i + 3);
        const tidx = hash32('g:' + tri, 0x811c9dc5) % VECTOR_DIM;
        const tsign = (hash32('gs:' + tri, 0x9e3779b1) & 1) ? 1 : -1;
        vec[tidx] += tsign * 0.45;
      }
    }
  }

  l2Normalize(vec);
  return Array.from(vec);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function resolveEmbedConfig(embedConfig = null) {
  const cfg = embedConfig && typeof embedConfig === 'object' ? { ...embedConfig } : null;
  if (cfg && (cfg.baseURL || cfg.baseUrl || cfg.provider || cfg.model)) {
    const provider = String(cfg.provider || (/11434/.test(String(cfg.baseURL || cfg.baseUrl || '')) ? 'ollama' : (/generativelanguage/.test(String(cfg.baseURL || cfg.baseUrl || '')) ? 'gemini' : 'openai'))).toLowerCase();
    const baseURL = String(cfg.baseURL || cfg.baseUrl || (provider === 'ollama'
      ? 'http://127.0.0.1:11434'
      : (provider === 'gemini' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com/v1'))).replace(/\/+$/, '');
    const model = String(cfg.model || (provider === 'ollama' ? 'nomic-embed-text' : (provider === 'gemini' ? 'text-embedding-004' : 'text-embedding-3-small')));
    return {
      enabled: cfg.enabled !== false,
      provider,
      baseURL,
      model,
      apiKey: String(cfg.apiKey || '').trim(),
      timeoutMs: Number(cfg.timeoutMs) || 4000,
    };
  }
  if (process.env.AKRON_EMBED_URL) {
    return {
      enabled: true,
      provider: String(process.env.AKRON_EMBED_PROVIDER || (/11434/.test(process.env.AKRON_EMBED_URL) ? 'ollama' : 'openai')).toLowerCase(),
      baseURL: String(process.env.AKRON_EMBED_URL).replace(/\/+$/, ''),
      model: String(process.env.AKRON_EMBED_MODEL || 'nomic-embed-text'),
      apiKey: String(process.env.AKRON_EMBED_KEY || '').trim(),
      timeoutMs: 4000,
    };
  }
  return null;
}

/**
 * Optional dense embedding batch caller (Ollama / OpenAI / OpenRouter / Gemini).
 * Never makes unconfigured network calls; returns array of normalized vectors or nulls.
 */
async function embedDenseBatch(texts, opts = {}) {
  const list = Array.isArray(texts) ? texts.map((t) => String(t || '').slice(0, 6000)) : [];
  if (!list.length) return [];
  const cfg = resolveEmbedConfig(opts.embedConfig || opts);
  if (!cfg || !cfg.enabled) return list.map(() => null);
  const fetchFn = opts.fetchImpl || globalThis.fetch;
  if (typeof fetchFn !== 'function') return list.map(() => null);

  const batchSize = Math.max(1, Math.min(64, Number(opts.batchSize) || DEFAULT_BATCH_SIZE));
  const results = [];

  for (let i = 0; i < list.length; i += batchSize) {
    const batch = list.slice(i, i + batchSize);
    let vecs = null;
    try {
      if (cfg.provider === 'ollama') {
        const r = await fetchFn(`${cfg.baseURL}/api/embed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, input: batch }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          if (j && Array.isArray(j.embeddings)) vecs = j.embeddings;
        }
        if (!vecs) {
          vecs = [];
          for (const prompt of batch) {
            const r2 = await fetchFn(`${cfg.baseURL}/api/embeddings`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ model: cfg.model, prompt }),
              signal: AbortSignal.timeout(cfg.timeoutMs),
            });
            const j2 = r2 && r2.ok ? await r2.json().catch(() => null) : null;
            vecs.push(j2 && Array.isArray(j2.embedding) ? j2.embedding : null);
          }
        }
      } else if (cfg.provider === 'gemini') {
        const hdrs = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) hdrs['x-goog-api-key'] = cfg.apiKey;
        const r = await fetchFn(`${cfg.baseURL}/v1beta/models/${encodeURIComponent(cfg.model)}:batchEmbedContents`, {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({
            requests: batch.map((txt) => ({
              model: `models/${cfg.model}`,
              content: { parts: [{ text: txt }] },
            })),
          }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          if (j && Array.isArray(j.embeddings)) {
            vecs = j.embeddings.map((e) => (e && Array.isArray(e.values) ? e.values : null));
          }
        }
      } else {
        const hdrs = { 'Content-Type': 'application/json' };
        if (cfg.apiKey) hdrs.Authorization = `Bearer ${cfg.apiKey}`;
        const url = /\/embeddings$/.test(cfg.baseURL) ? cfg.baseURL : `${cfg.baseURL}/embeddings`;
        const r = await fetchFn(url, {
          method: 'POST',
          headers: hdrs,
          body: JSON.stringify({ model: cfg.model, input: batch }),
          signal: AbortSignal.timeout(cfg.timeoutMs),
        });
        if (r && r.ok) {
          const j = await r.json().catch(() => null);
          if (j && Array.isArray(j.data)) {
            vecs = j.data
              .slice()
              .sort((a, b) => (a.index || 0) - (b.index || 0))
              .map((d) => (d && Array.isArray(d.embedding) ? d.embedding : null));
          }
        }
      }
    } catch (_) {
      vecs = null;
    }

    for (let k = 0; k < batch.length; k++) {
      const v = vecs && Array.isArray(vecs[k]) && vecs[k].length ? l2Normalize([...vecs[k]]) : null;
      results.push(v);
    }
  }

  return results;
}

module.exports = {
  VECTOR_DIM,
  splitCodeTokens,
  embedSparse384,
  cosineSimilarity,
  resolveEmbedConfig,
  embedDenseBatch,
  l2Normalize,
};
