'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_STORE = path.join(os.homedir(), '.autobot', 'push-channels.json');

const pendingPairings = new Map(); // storePath -> { code, expiresAt }
const shortPermMap = new Map(); // shortId -> { fullId, createdAt }

function defaultConfig() {
  return {
    enabled: false,
    ntfy: { enabled: false, topicUrl: '', token: '' },
    telegram: { enabled: false, botToken: '', chatId: '' },
    webhook: { enabled: false, url: '', secret: '' },
    events: { permissions: true, longRuns: true, stuckAlerts: true },
    pairedDevices: [],
    updatedAt: 0,
  };
}

function loadConfig(storePath = DEFAULT_STORE) {
  const fp = storePath || DEFAULT_STORE;
  try {
    if (fs.existsSync(fp)) {
      const p = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (p && typeof p === 'object') {
        const def = defaultConfig();
        return {
          ...def,
          ...p,
          ntfy: { ...def.ntfy, ...(p.ntfy || {}) },
          telegram: { ...def.telegram, ...(p.telegram || {}) },
          webhook: { ...def.webhook, ...(p.webhook || {}) },
          events: { ...def.events, ...(p.events || {}) },
          pairedDevices: Array.isArray(p.pairedDevices) ? p.pairedDevices : [],
        };
      }
    }
  } catch (_) {}
  return defaultConfig();
}

function saveConfig(patch = {}, storePath = DEFAULT_STORE) {
  const fp = storePath || DEFAULT_STORE;
  const cur = loadConfig(fp);
  const next = {
    ...cur,
    ...patch,
    ntfy: { ...cur.ntfy, ...(patch.ntfy || {}) },
    telegram: { ...cur.telegram, ...(patch.telegram || {}) },
    webhook: { ...cur.webhook, ...(patch.webhook || {}) },
    events: { ...cur.events, ...(patch.events || {}) },
    pairedDevices: Array.isArray(patch.pairedDevices) ? patch.pairedDevices : cur.pairedDevices,
    updatedAt: Date.now(),
  };
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  const tmp = `${fp}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, fp);
  try { fs.chmodSync(fp, 0o600); } catch (_) {}
  return next;
}

function startPairing({ storePath = DEFAULT_STORE, ttlMs = 10 * 60 * 1000, nowMs = Date.now() } = {}) {
  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = nowMs + ttlMs;
  pendingPairings.set(storePath || DEFAULT_STORE, { code, expiresAt });
  return { ok: true, code, expiresAt };
}

function completePairing(code, deviceMeta = {}, { storePath = DEFAULT_STORE, nowMs = Date.now() } = {}) {
  const key = storePath || DEFAULT_STORE;
  const pending = pendingPairings.get(key);
  if (!pending) return { ok: false, error: 'No active pairing code.' };
  if (nowMs > pending.expiresAt) {
    pendingPairings.delete(key);
    return { ok: false, error: 'Pairing code expired.' };
  }
  const supplied = String(code || '').trim();
  if (supplied.length !== pending.code.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(pending.code))) {
    return { ok: false, error: 'Invalid pairing code.' };
  }
  pendingPairings.delete(key);
  const cfg = loadConfig(key);
  const device = {
    id: 'dev_' + crypto.randomBytes(6).toString('hex'),
    label: String(deviceMeta.label || 'Mobile / Remote Client').slice(0, 80),
    channel: String(deviceMeta.channel || 'webhook'),
    pairedAt: nowMs,
  };
  const next = saveConfig({ pairedDevices: [...cfg.pairedDevices.slice(-19), device] }, key);
  return { ok: true, device, config: next };
}

function createRateLimiter({ maxPerWindow = 10, windowMs = 60 * 1000 } = {}) {
  const timestamps = [];
  return {
    tryConsume(nowMs = Date.now()) {
      const cutoff = nowMs - windowMs;
      while (timestamps.length && timestamps[0] <= cutoff) timestamps.shift();
      if (timestamps.length >= maxPerWindow) {
        return { allowed: false, rateLimited: true, remaining: 0 };
      }
      timestamps.push(nowMs);
      return { allowed: true, rateLimited: false, remaining: maxPerWindow - timestamps.length };
    },
    reset() {
      timestamps.length = 0;
    },
  };
}

const defaultLimiter = createRateLimiter({ maxPerWindow: 10, windowMs: 60 * 1000 });

function registerShortPermission(fullId) {
  if (!fullId) return '';
  for (const [sid, rec] of shortPermMap.entries()) {
    if (rec.fullId === fullId) return sid;
  }
  const sid = crypto.createHash('sha256').update(String(fullId)).digest('hex').slice(0, 6);
  shortPermMap.set(sid, { fullId: String(fullId), createdAt: Date.now() });
  if (shortPermMap.size > 500) {
    const firstKey = shortPermMap.keys().next().value;
    if (firstKey) shortPermMap.delete(firstKey);
  }
  return sid;
}

function resolveShortPermission(shortId) {
  const rec = shortPermMap.get(String(shortId || '').trim().toLowerCase());
  return rec ? rec.fullId : null;
}

function parseInboundPushCommand(text) {
  const raw = String(text || '').trim();
  const m = /^(approve|deny)\s+([A-Za-z0-9_-]{4,24})(?:\s+([\s\S]+))?$/i.exec(raw);
  if (!m) return null;
  return {
    verb: m[1].toLowerCase(),
    allow: m[1].toLowerCase() === 'approve',
    shortId: m[2].trim().toLowerCase(),
    feedback: String(m[3] || '').trim(),
  };
}

function handleInboundPushCommand(text, permGate) {
  const cmd = parseInboundPushCommand(text);
  if (!cmd) return { ok: false, error: 'Unrecognized push command. Use: approve <shortId> | deny <shortId> [reason]' };
  const fullId = resolveShortPermission(cmd.shortId) || cmd.shortId;
  if (!permGate || typeof permGate.answer !== 'function') {
    return { ok: false, error: 'Permission gate not wired' };
  }
  const res = permGate.answer(fullId, {
    allow: cmd.allow,
    scope: 'once',
    feedback: cmd.feedback,
  });
  return { ...res, shortId: cmd.shortId, fullId, allow: cmd.allow };
}

async function defaultHttpPost(url, headers, bodyStr) {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyStr,
    signal: AbortSignal.timeout(8000),
  });
  return { ok: res.ok, status: res.status };
}

async function sendPushAlert({
  kind = 'info',
  title = 'Akron Code',
  body = '',
  shortId = '',
  storePath = DEFAULT_STORE,
  force = false,
  rateLimiter = defaultLimiter,
  transportFn = defaultHttpPost,
  nowMs = Date.now(),
} = {}) {
  const cfg = loadConfig(storePath);
  if (!force && !cfg.enabled) return { ok: false, skipped: 'disabled' };
  if (!force) {
    if (kind === 'permission' && cfg.events && cfg.events.permissions === false) return { ok: false, skipped: 'event_disabled' };
    if (kind === 'longRun' && cfg.events && cfg.events.longRuns === false) return { ok: false, skipped: 'event_disabled' };
    if (kind === 'stuck' && cfg.events && cfg.events.stuckAlerts === false) return { ok: false, skipped: 'event_disabled' };
  }

  const rl = rateLimiter.tryConsume(nowMs);
  if (!rl.allowed) return { ok: false, rateLimited: true, error: 'Push rate limit exceeded' };

  const fullText = shortId
    ? `${body}\nReply: approve ${shortId} | deny ${shortId} <reason>`
    : body;

  const deliveries = [];

  if (cfg.ntfy && cfg.ntfy.enabled && cfg.ntfy.topicUrl) {
    const headers = { Title: title, Priority: kind === 'permission' || kind === 'stuck' ? 'high' : 'default' };
    if (cfg.ntfy.token) headers.Authorization = `Bearer ${cfg.ntfy.token}`;
    try {
      const r = await transportFn(cfg.ntfy.topicUrl, headers, fullText);
      deliveries.push({ channel: 'ntfy', ok: Boolean(r && r.ok !== false), status: r && r.status });
    } catch (e) {
      deliveries.push({ channel: 'ntfy', ok: false, error: e.message });
    }
  }

  if (cfg.telegram && cfg.telegram.enabled && cfg.telegram.botToken && cfg.telegram.chatId) {
    const tgUrl = `https://api.telegram.org/bot${cfg.telegram.botToken}/sendMessage`;
    const payload = JSON.stringify({ chat_id: cfg.telegram.chatId, text: `${title}\n${fullText}` });
    try {
      const r = await transportFn(tgUrl, { 'Content-Type': 'application/json' }, payload);
      deliveries.push({ channel: 'telegram', ok: Boolean(r && r.ok !== false), status: r && r.status });
    } catch (e) {
      deliveries.push({ channel: 'telegram', ok: false, error: e.message });
    }
  }

  if (cfg.webhook && cfg.webhook.enabled && cfg.webhook.url) {
    const payload = JSON.stringify({ kind, title, body: fullText, shortId: shortId || null, ts: nowMs });
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.webhook.secret) {
      headers['X-Akron-Signature'] = crypto.createHmac('sha256', cfg.webhook.secret).update(payload).digest('hex');
    }
    try {
      const r = await transportFn(cfg.webhook.url, headers, payload);
      deliveries.push({ channel: 'webhook', ok: Boolean(r && r.ok !== false), status: r && r.status });
    } catch (e) {
      deliveries.push({ channel: 'webhook', ok: false, error: e.message });
    }
  }

  return {
    ok: deliveries.some((d) => d.ok) || deliveries.length === 0,
    deliveries,
    remainingRateQuota: rl.remaining,
  };
}

module.exports = {
  loadConfig,
  saveConfig,
  startPairing,
  completePairing,
  createRateLimiter,
  registerShortPermission,
  resolveShortPermission,
  parseInboundPushCommand,
  handleInboundPushCommand,
  sendPushAlert,
};
