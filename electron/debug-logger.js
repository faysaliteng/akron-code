'use strict';
/**
 * Persistent Scrubbed Debug Logger & Opt-In Developer Auto-Reporter.
 *
 * - Writes rolling scrubbed JSONL logs to ~/.autobot/logs/debug.jsonl (2 MB max x 3).
 * - Redacts API keys, Bearer/OAuth tokens, emails, and user home directories before disk/network write.
 * - Cleans stale temporary runtime directories under ~/.autobot (N23) and writes
 *   `.gitignore` inside workspace `.autobot/` & `.akron/` directories (N25).
 * - When opt-in `autoSend` is enabled with an HTTPS (or loopback) developer collector
 *   endpoint, debounces and dispatches scrubbed error/self-test reports asynchronously.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { scrubDiagnosticText, scrubObject, generateDiagnosticBundle } = require('./diagnostics');

function postJsonReport(urlStr, bodyObj, appVersion, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(bodyObj);
    const req = mod.request(u, {
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'user-agent': `AkronCode/${appVersion}`,
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode || 0 }));
    });
    req.on('timeout', () => req.destroy(new Error('collector request timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_BACKUPS = 2;
const DEFAULT_COOLDOWN_MS = 30000;

let _baseDirOverride = '';
let _appVersion = '1.6.0';
let _lastAutoSentAt = 0;
let _autoSendTimer = null;

function setBaseDir(dir) { _baseDirOverride = dir ? String(dir) : ''; }
function getBaseDir() { return _baseDirOverride || path.join(os.homedir(), '.autobot'); }
function setAppVersion(v) { if (v) _appVersion = String(v); }

function logsDir() { return path.join(getBaseDir(), 'logs'); }
function logFilePath() { return path.join(logsDir(), 'debug.jsonl'); }
function configFilePath() { return path.join(getBaseDir(), 'debug-config.json'); }
function reportsDir() { return path.join(logsDir(), 'reports'); }
function outboxDir() { return path.join(logsDir(), 'outbox'); }

function ensureDirs() {
  for (const d of [getBaseDir(), logsDir(), reportsDir(), outboxDir()]) {
    try { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); } catch (_) {}
  }
}

function ensureWorkspaceGitignore(cwd) {
  if (!cwd) return;
  const base = path.resolve(String(cwd));
  if (!fs.existsSync(base)) return;
  for (const sub of ['.autobot', '.akron']) {
    const dir = path.join(base, sub);
    if (fs.existsSync(dir)) {
      const gi = path.join(dir, '.gitignore');
      if (!fs.existsSync(gi)) {
        try { fs.writeFileSync(gi, '*\n!.gitignore\n', 'utf8'); } catch (_) {}
      }
    }
  }
}

function rotateIfNeeded() {
  try {
    const fp = logFilePath();
    if (!fs.existsSync(fp)) return;
    const st = fs.statSync(fp);
    if (st.size < MAX_LOG_BYTES) return;
    for (let i = MAX_BACKUPS; i >= 1; i--) {
      const src = i === 1 ? fp : `${fp}.${i - 1}`;
      const dst = `${fp}.${i}`;
      if (fs.existsSync(src)) {
        try { fs.renameSync(src, dst); } catch (_) {}
      }
    }
  } catch (_) {}
}

function getConfig() {
  const defaults = {
    autoSend: false,
    endpointUrl: '',
    includeToolErrors: true,
    lastSentAt: null,
    lastReportId: null,
    lastStatus: null,
    sentCount: 0,
  };
  try {
    const fp = configFilePath();
    if (!fs.existsSync(fp)) return defaults;
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return { ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
  } catch (_) {
    return defaults;
  }
}

function isAllowedEndpoint(urlStr) {
  const s = String(urlStr || '').trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return true;
    if (u.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(u.hostname)) return true;
    return false;
  } catch (_) {
    return false;
  }
}

function setConfig(patch = {}) {
  ensureDirs();
  const cur = getConfig();
  const endpointUrl = patch.endpointUrl !== undefined ? String(patch.endpointUrl || '').trim() : cur.endpointUrl;
  const next = {
    ...cur,
    autoSend: patch.autoSend !== undefined ? Boolean(patch.autoSend) : cur.autoSend,
    endpointUrl,
    includeToolErrors: patch.includeToolErrors !== undefined ? Boolean(patch.includeToolErrors) : cur.includeToolErrors,
    lastSentAt: patch.lastSentAt !== undefined ? patch.lastSentAt : cur.lastSentAt,
    lastReportId: patch.lastReportId !== undefined ? patch.lastReportId : cur.lastReportId,
    lastStatus: patch.lastStatus !== undefined ? patch.lastStatus : cur.lastStatus,
    sentCount: patch.sentCount !== undefined ? Number(patch.sentCount) || 0 : cur.sentCount,
  };
  try {
    fs.writeFileSync(configFilePath(), JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}
  return next;
}

function tail(limit = 100) {
  const max = Math.max(1, Math.min(Number(limit) || 100, 1000));
  try {
    const fp = logFilePath();
    if (!fs.existsSync(fp)) return [];
    const lines = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-max).map((l) => {
      try { return JSON.parse(l); } catch (_) { return { ts: new Date().toISOString(), level: 'info', category: 'raw', event: l }; }
    });
  } catch (_) {
    return [];
  }
}

function clear() {
  try {
    const fp = logFilePath();
    if (fs.existsSync(fp)) fs.writeFileSync(fp, '', 'utf8');
    for (let i = 1; i <= MAX_BACKUPS; i++) {
      const bk = `${fp}.${i}`;
      if (fs.existsSync(bk)) fs.rmSync(bk, { force: true });
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendReportNow({ summary = '', category = 'debug-auto', extra = null, recentLimit = 80 } = {}) {
  ensureDirs();
  const cfg = getConfig();
  const entries = tail(recentLimit);
  const errorLines = entries
    .filter((e) => e && (e.level === 'error' || e.level === 'warn'))
    .map((e) => `[${e.ts}] ${e.category}/${e.event}: ${typeof e.detail === 'string' ? e.detail : JSON.stringify(e.detail || '')}`);

  const bundle = generateDiagnosticBundle({
    category,
    summary: summary || `Akron Code automated debug snapshot (${entries.length} log entries)`,
    appVersion: _appVersion,
    recentErrors: errorLines,
    settings: { autoSend: cfg.autoSend, includeToolErrors: cfg.includeToolErrors },
  });
  bundle.logTail = scrubObject(entries.slice(-recentLimit));
  if (extra && typeof extra === 'object') {
    bundle.extra = scrubObject(extra);
  }

  const reportId = bundle.bundleId || ('diag-' + crypto.randomBytes(5).toString('hex'));
  const savedPath = path.join(reportsDir(), `${reportId}.json`);
  try {
    fs.writeFileSync(savedPath, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (_) {}

  let delivered = false;
  let status = 0;
  let deliverError = '';
  if (isAllowedEndpoint(cfg.endpointUrl)) {
    try {
      const res = await postJsonReport(cfg.endpointUrl, bundle, _appVersion, 8000);
      status = res.status;
      delivered = res.ok;
      if (!res.ok) deliverError = `HTTP ${res.status}`;
    } catch (e) {
      deliverError = e && e.message ? e.message : String(e);
    }
  } else if (cfg.endpointUrl) {
    deliverError = 'Collector URL must be https:// (or loopback http://127.0.0.1)';
  }

  setConfig({
    lastSentAt: new Date().toISOString(),
    lastReportId: reportId,
    lastStatus: delivered ? `delivered:${status}` : (cfg.endpointUrl ? `queued:${deliverError || 'offline'}` : 'saved_locally'),
    sentCount: delivered ? (cfg.sentCount || 0) + 1 : (cfg.sentCount || 0),
  });

  if (!delivered) {
    try {
      const obFile = path.join(outboxDir(), `${reportId}.json`);
      fs.writeFileSync(obFile, JSON.stringify(bundle, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (_) {}
  }

  return { ok: true, reportId, savedPath, delivered, status, error: deliverError || null, entryCount: entries.length };
}

function scheduleAutoSend(category, event) {
  const cfg = getConfig();
  if (!cfg.autoSend || !isAllowedEndpoint(cfg.endpointUrl)) return;
  const now = Date.now();
  const wait = Math.max(250, DEFAULT_COOLDOWN_MS - (now - _lastAutoSentAt));
  if (_autoSendTimer) return;
  _autoSendTimer = setTimeout(() => {
    _autoSendTimer = null;
    _lastAutoSentAt = Date.now();
    sendReportNow({ category: 'auto-error', summary: `Auto-report triggered by ${category}/${event}` }).catch(() => {});
  }, _lastAutoSentAt === 0 ? 300 : wait);
  if (_autoSendTimer && typeof _autoSendTimer.unref === 'function') _autoSendTimer.unref();
}

function record(level = 'info', category = 'app', event = 'log', detail = '') {
  try {
    ensureDirs();
    rotateIfNeeded();
    const safeEntry = {
      ts: new Date().toISOString(),
      pid: process.pid,
      appVersion: _appVersion,
      level: String(level || 'info'),
      category: scrubDiagnosticText(category),
      event: scrubDiagnosticText(event),
      detail: typeof detail === 'string' ? scrubDiagnosticText(detail).slice(0, 2000) : scrubObject(detail),
    };
    fs.appendFileSync(logFilePath(), JSON.stringify(safeEntry) + '\n', { encoding: 'utf8', mode: 0o600 });
    if (level === 'error' || category === 'selftest') {
      scheduleAutoSend(category, event);
    }
    return safeEntry;
  } catch (_) {
    return null;
  }
}

// Retention janitor (N23): prevents ~/.autobot/agents, teams, media-cache & logs/reports from growing unbounded.
function pruneRuntimeDirs({ maxFilesPerDir = 150, maxAgeMs = 7 * 24 * 60 * 60 * 1000 } = {}) {
  const base = getBaseDir();
  const now = Date.now();
  let removed = 0;
  for (const rel of ['agents', 'teams', 'media-cache', path.join('logs', 'reports'), path.join('logs', 'outbox')]) {
    const dir = path.join(base, rel);
    if (!fs.existsSync(dir)) continue;
    try {
      const items = fs.readdirSync(dir)
        .map((name) => {
          const fp = path.join(dir, name);
          try { return { fp, mtimeMs: fs.statSync(fp).mtimeMs }; } catch (_) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      for (let i = maxFilesPerDir; i < items.length; i++) {
        if (now - items[i].mtimeMs >= maxAgeMs) {
          fs.rmSync(items[i].fp, { recursive: true, force: true });
          removed++;
        }
      }
    } catch (_) {}
  }
  return { ok: true, removed };
}

module.exports = {
  setBaseDir,
  getBaseDir,
  setAppVersion,
  logFilePath,
  configFilePath,
  reportsDir,
  outboxDir,
  getConfig,
  setConfig,
  isAllowedEndpoint,
  record,
  tail,
  clear,
  sendReportNow,
  pruneRuntimeDirs,
  ensureWorkspaceGitignore,
};
