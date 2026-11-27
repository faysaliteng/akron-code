'use strict';
/**
 * Complete Unlocked FreeLLMAPI Catalog (1,575 Models across 97 Platforms).
 * Provides zero-config cross-platform access on macOS, Windows, and Linux to:
 *   - 74 Chat & Coding LLM platforms (1,345 models)
 *   - 7 Multimodal / Media / Search / Decision modalities (150 models)
 *   - 16 Embedding platforms (80 models)
 */
const fs = require('fs');
const path = require('path');

let _cachedCatalog = null;

function loadCatalog() {
  if (_cachedCatalog) return _cachedCatalog;
  const p = path.join(__dirname, 'freellmapi-catalog.json');
  const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  _cachedCatalog = raw;
  return _cachedCatalog;
}

function getCatalogSummary() {
  const cat = loadCatalog();
  const countsByPlatform = {};
  for (const m of cat.chatModels || []) {
    countsByPlatform[m.platform] = countsByPlatform[m.platform] || { chat: 0, media: 0, embedding: 0 };
    countsByPlatform[m.platform].chat += 1;
  }
  for (const m of cat.mediaModels || []) {
    countsByPlatform[m.platform] = countsByPlatform[m.platform] || { chat: 0, media: 0, embedding: 0 };
    countsByPlatform[m.platform].media += 1;
  }
  for (const m of cat.embeddingModels || []) {
    countsByPlatform[m.platform] = countsByPlatform[m.platform] || { chat: 0, media: 0, embedding: 0 };
    countsByPlatform[m.platform].embedding += 1;
  }
  const platforms = Object.values(cat.platforms || {}).map((p) => ({
    ...p,
    counts: countsByPlatform[p.id] || { chat: 0, media: 0, embedding: 0 },
  }));
  const mediaByModality = {};
  for (const m of cat.mediaModels || []) {
    const mod = m.modality || m.rawModality || 'other';
    if (!mediaByModality[mod]) mediaByModality[mod] = { count: 0, platforms: new Set() };
    mediaByModality[mod].count += 1;
    mediaByModality[mod].platforms.add(m.platform);
  }
  const modalitySummary = Object.entries(mediaByModality).map(([modality, info]) => ({
    modality,
    count: info.count,
    platforms: info.platforms.size,
  }));
  return {
    ok: true,
    unlocked: true,
    totals: cat.totals,
    platforms,
    modalitySummary,
  };
}

function listChatModels({ platform = '', search = '', limit = 0 } = {}) {
  const cat = loadCatalog();
  const p = String(platform || '').trim().toLowerCase();
  const q = String(search || '').trim().toLowerCase();
  let rows = (cat.chatModels || []).filter((m) => {
    if (p && m.platform !== p) return false;
    if (q && !m.id.toLowerCase().includes(q) && !String(m.name || '').toLowerCase().includes(q) && !m.platform.toLowerCase().includes(q)) return false;
    return true;
  });
  if (limit > 0) rows = rows.slice(0, limit);
  return rows;
}

function listMediaModels({ modality = '', platform = '', search = '' } = {}) {
  const cat = loadCatalog();
  const mod = String(modality || '').trim().toLowerCase();
  const p = String(platform || '').trim().toLowerCase();
  const q = String(search || '').trim().toLowerCase();
  return (cat.mediaModels || []).filter((m) => {
    if (mod && String(m.modality || '').toLowerCase() !== mod && String(m.rawModality || '').toLowerCase() !== mod) return false;
    if (p && m.platform !== p) return false;
    if (q && !m.id.toLowerCase().includes(q) && !String(m.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function listEmbeddingModels({ platform = '', search = '' } = {}) {
  const cat = loadCatalog();
  const p = String(platform || '').trim().toLowerCase();
  const q = String(search || '').trim().toLowerCase();
  return (cat.embeddingModels || []).filter((m) => {
    if (p && m.platform !== p) return false;
    if (q && !m.id.toLowerCase().includes(q) && !String(m.name || '').toLowerCase().includes(q)) return false;
    return true;
  });
}

function toOpenAIModels(cfg = null) {
  const cat = loadCatalog();
  const providersCfg = (cfg && cfg.providers) || {};
  const entries = [];
  for (const m of cat.chatModels || []) {
    const pc = providersCfg[m.platform];
    const platMeta = (cat.platforms && cat.platforms[m.platform]) || {};
    const configured = Boolean((pc && pc.enabled !== false && pc.apiKey) || platMeta.keyless);
    entries.push({
      id: m.id,
      object: 'model',
      created: 0,
      owned_by: m.platform,
      provider: m.platform,
      display_name: m.name,
      context_window: m.contextWindow || 131072,
      vision: !!m.vision,
      tools: m.tools !== false,
      free: true,
      configured,
      source: 'freellmapi-catalog',
    });
  }
  return entries;
}

function getWebBotQuickProviders() {
  const cat = loadCatalog();
  const priority = ['openrouter', 'google', 'groq', 'mistral', 'cohere', 'cloudflare', 'nvidia', 'huggingface', 'puter', 'electronhub'];
  return priority.map((id) => ({
    ...(cat.platforms[id] || { id, name: id }),
    chatCount: (cat.chatModels || []).filter((m) => m.platform === id).length,
    mediaCount: (cat.mediaModels || []).filter((m) => m.platform === id).length,
  }));
}

module.exports = {
  loadCatalog,
  getCatalogSummary,
  listChatModels,
  listMediaModels,
  listEmbeddingModels,
  toOpenAIModels,
  getWebBotQuickProviders,
};
