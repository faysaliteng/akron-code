'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = path.join(os.homedir(), '.autobot');
const DEFAULT_LEDGER_PATH = path.join(DATA_DIR, 'audit-ledger.jsonl');
const DEFAULT_SIDE_EFFECTS_PATH = path.join(DATA_DIR, 'side-effects.json');
const GENESIS_HASH = '0'.repeat(64);

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
}

function ensurePrivateDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function readTailState(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return { seq: 0, prevHash: GENESIS_HASH };
  const raw = fs.readFileSync(ledgerPath, 'utf8').trim();
  if (!raw) return { seq: 0, prevHash: GENESIS_HASH };
  const lines = raw.split('\n').filter(Boolean);
  const last = lines[lines.length - 1];
  try {
    const parsed = JSON.parse(last);
    return {
      seq: Number(parsed.seq) || lines.length,
      prevHash: String(parsed.hash || GENESIS_HASH),
    };
  } catch (_) {
    return { seq: lines.length, prevHash: GENESIS_HASH };
  }
}

/**
 * Append a tamper-evident hash-chained entry to ~/.autobot/audit-ledger.jsonl.
 */
function appendAuditEntry(event, { ledgerPath = DEFAULT_LEDGER_PATH, now = new Date() } = {}) {
  const fp = path.resolve(ledgerPath);
  ensurePrivateDir(path.dirname(fp));
  const { seq: prevSeq, prevHash } = readTailState(fp);
  const body = {
    seq: prevSeq + 1,
    ts: (now instanceof Date ? now : new Date(now)).toISOString(),
    prevHash,
    event: event && typeof event === 'object' ? event : { message: String(event || '') },
  };
  const hash = sha256Hex(prevHash + '\n' + JSON.stringify(body));
  const record = { ...body, hash };
  fs.appendFileSync(fp, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(fp, 0o600); } catch (_) {}
  return record;
}

function verifyAuditLedger({ ledgerPath = DEFAULT_LEDGER_PATH } = {}) {
  const fp = path.resolve(ledgerPath);
  if (!fs.existsSync(fp)) {
    return { ok: true, entries: 0, headHash: GENESIS_HASH, brokenAt: null };
  }
  const raw = fs.readFileSync(fp, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim().length > 0);
  let expectedPrev = GENESIS_HASH;

  for (let i = 0; i < lines.length; i++) {
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch (err) {
      return {
        ok: false,
        entries: lines.length,
        headHash: expectedPrev,
        brokenAt: i + 1,
        error: `Malformed JSON on line ${i + 1}: ${err.message}`,
      };
    }
    if (rec.prevHash !== expectedPrev) {
      return {
        ok: false,
        entries: lines.length,
        headHash: expectedPrev,
        brokenAt: i + 1,
        error: `Hash link mismatch at entry #${i + 1} (expected prevHash ${expectedPrev.slice(0, 12)}, got ${String(rec.prevHash || '').slice(0, 12)})`,
      };
    }
    const { hash, ...body } = rec;
    const recomputed = sha256Hex(rec.prevHash + '\n' + JSON.stringify(body));
    if (hash !== recomputed) {
      return {
        ok: false,
        entries: lines.length,
        headHash: expectedPrev,
        brokenAt: i + 1,
        error: `Tampered payload detected at entry #${i + 1}`,
      };
    }
    expectedPrev = hash;
  }

  return { ok: true, entries: lines.length, headHash: expectedPrev, brokenAt: null };
}

function listAuditEntries({ ledgerPath = DEFAULT_LEDGER_PATH, limit = 40 } = {}) {
  const fp = path.resolve(ledgerPath);
  if (!fs.existsSync(fp)) return [];
  const lines = fs.readFileSync(fp, 'utf8').split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-Math.max(1, limit)).reverse().map((l) => {
    try { return JSON.parse(l); } catch (_) { return { corrupt: true, raw: l }; }
  });
}

/**
 * Execute-once idempotency guard for external side-effecting calls (Jira/Linear/POST webhooks).
 * Records executing -> completed | uncertain so crash recovery never replays a side effect twice.
 */
function createIdempotencyGuard(storePath = DEFAULT_SIDE_EFFECTS_PATH) {
  const fp = path.resolve(storePath);

  const load = () => {
    try {
      if (fs.existsSync(fp)) return JSON.parse(fs.readFileSync(fp, 'utf8')) || {};
    } catch (_) {}
    return {};
  };

  const save = (map) => {
    ensurePrivateDir(path.dirname(fp));
    const tmp = `${fp}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
    fs.writeFileSync(tmp, JSON.stringify(map, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch (_) {}
  };

  return {
    beginExecution(key, meta = {}) {
      if (!key) return { allowed: true };
      const k = String(key);
      const map = load();
      const existing = map[k];
      if (existing && (existing.state === 'completed' || existing.state === 'executing' || existing.state === 'uncertain')) {
        return { allowed: false, state: existing.state, record: existing };
      }
      map[k] = {
        key: k,
        state: 'executing',
        startedAt: Date.now(),
        meta,
      };
      // Prune oldest records if store exceeds 1000 entries
      const keys = Object.keys(map);
      if (keys.length > 1000) {
        keys.sort((a, b) => (map[a].startedAt || 0) - (map[b].startedAt || 0));
        for (const old of keys.slice(0, keys.length - 1000)) delete map[old];
      }
      save(map);
      return { allowed: true };
    },

    finishExecution(key, status = 'completed', summary = '') {
      if (!key) return null;
      const k = String(key);
      const map = load();
      const prev = map[k] || { key: k, startedAt: Date.now() };
      const cleanStatus = status === 'uncertain' || status === 'completed' ? status : 'uncertain';
      map[k] = {
        ...prev,
        state: cleanStatus,
        finishedAt: Date.now(),
        summary: String(summary || '').slice(0, 500),
      };
      save(map);
      return map[k];
    },

    getState(key) {
      const map = load();
      return map[String(key)] || null;
    },
  };
}

module.exports = {
  DEFAULT_LEDGER_PATH,
  DEFAULT_SIDE_EFFECTS_PATH,
  GENESIS_HASH,
  appendAuditEntry,
  verifyAuditLedger,
  listAuditEntries,
  createIdempotencyGuard,
};
