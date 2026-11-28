'use strict';
/**
 * OS-backed secret store (Desktop parity for the `secret:*` channel family).
 *
 * Uses Electron's safeStorage (Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux) to encrypt values at rest in
 * `~/.autobot/secrets.json` (mode 0600). When safeStorage is unavailable
 * (plain node, headless test) it degrades to an obfuscated-at-rest store and
 * reports `encrypted: false` so the UI can warn.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = process.env.AUTOBOT_HOME
  ? path.resolve(process.env.AUTOBOT_HOME)
  : path.join(os.homedir(), '.autobot');
const FILE = path.join(DIR, 'secrets.json');

function realSafeStorage() {
  try {
    const { safeStorage: ss } = require('electron');
    if (ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable()) return ss;
  } catch (_) {}
  return null;
}

function safeStorage() {
  if (process.env.AKRON_DISABLE_SAFE_STORAGE === '1') return null;
  return realSafeStorage();
}

function hasLegacySafeStorage() {
  try {
    const db = read();
    return Object.values(db).some((rec) => rec && rec.enc === 'safeStorage');
  } catch (_) {
    return false;
  }
}

// Old records encrypted with the OS keychain (Electron safeStorage) are moved to
// the app's own AES key once. This used to re-encrypt them with safeStorage
// again, so they never left the keychain and EVERY launch read it — which on
// macOS asks for the login password whenever the keychain does not recognise
// the build. Now: no keychain access at all when nothing is left to migrate,
// and a record that cannot be unlocked is retried at most once a week (or
// lazily, when that secret is actually needed).
const LEGACY_TRY_FILE = path.join(DIR, '.legacy-keychain-migration');
const LEGACY_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

function migrateLegacySafeStorage(opts = {}) {
  const db = read();
  const legacy = Object.keys(db).filter((k) => db[k] && db[k].enc === 'safeStorage');
  if (!legacy.length) return { migrated: 0, remaining: 0 };
  let migrated = 0;
  let dirty = false;
  // Records written under the mock keychain decrypt without touching the OS keychain.
  for (const k of legacy) {
    const plain = decryptMockSafeStorage(db[k].v);
    if (plain !== null) { db[k] = encryptAes(plain); migrated++; dirty = true; }
  }
  let locked = legacy.filter((k) => db[k] && db[k].enc === 'safeStorage');
  let lastTry = 0;
  try { lastTry = Number(fs.readFileSync(LEGACY_TRY_FILE, 'utf8').trim()) || 0; } catch (_) {}
  if (locked.length && (opts.force || Date.now() - lastTry > LEGACY_RETRY_MS)) {
    try { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(LEGACY_TRY_FILE, String(Date.now()), { mode: 0o600 }); } catch (_) {}
    const ss = realSafeStorage();
    if (ss) {
      for (const k of locked) {
        try {
          const plain = ss.decryptString(Buffer.from(db[k].v, 'base64'));
          if (plain != null) { db[k] = encryptAes(plain); migrated++; dirty = true; }
        } catch (_) {}
      }
    }
    locked = legacy.filter((k) => db[k] && db[k].enc === 'safeStorage');
  }
  if (dirty) {
    try { write(db); } catch (_) {}
  }
  return { migrated, remaining: locked.length };
}

function decryptMockSafeStorage(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const payload = buf.length > 3 && (buf.slice(0, 3).toString('utf8') === 'v10' || buf.slice(0, 3).toString('utf8') === 'v11')
      ? buf.slice(3)
      : buf;
    const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1003, 16, 'sha1');
    const iv = Buffer.alloc(16, 0x20);
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const out = Buffer.concat([d.update(payload), d.final()]).toString('utf8');
    return out || null;
  } catch (_) {
    return null;
  }
}

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (_) { return {}; }
}

function write(db) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch (_) {}
}

const MASTER_KEY_FILE = path.join(DIR, 'master.key');
let cachedMasterKey = null;

function getOrCreateMasterKey() {
  if (cachedMasterKey && Buffer.isBuffer(cachedMasterKey) && cachedMasterKey.length === 32) {
    return cachedMasterKey;
  }
  try {
    if (fs.existsSync(MASTER_KEY_FILE)) {
      const hex = fs.readFileSync(MASTER_KEY_FILE, 'utf8').trim();
      const raw = /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, 'hex') : null;
      if (raw && raw.length === 32) {
        cachedMasterKey = raw;
        return raw;
      }
    }
  } catch (_) {}
  const key = crypto.randomBytes(32);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = MASTER_KEY_FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, key.toString('hex') + '\n', { mode: 0o600 });
    fs.renameSync(tmp, MASTER_KEY_FILE);
    try { fs.chmodSync(MASTER_KEY_FILE, 0o600); } catch (_) {}
  } catch (_) {}
  cachedMasterKey = key;
  return key;
}

function legacyDeterministicFallbackKey() {
  const seed = [os.hostname(), os.userInfo().username, 'helio-bot-secret-store'].join('|');
  return crypto.createHash('sha256').update(seed).digest();
}

// New secrets use the app's own AES-256-GCM key (~/.autobot/master.key, 0600).
// The OS keychain is opt-in (AKRON_USE_SAFE_STORAGE=1): reading it can prompt
// for the login password on every launch of a locally signed build.
function encrypt(value) {
  if (process.env.AKRON_USE_SAFE_STORAGE === '1') {
    const ss = safeStorage();
    if (ss) return { enc: 'safeStorage', v: ss.encryptString(String(value)).toString('base64') };
  }
  return encryptAes(value);
}

function encryptAes(value) {
  const iv = crypto.randomBytes(12);
  const key = getOrCreateMasterKey();
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return { enc: 'aes-256-gcm', kv: 2, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), v: body.toString('base64') };
}

function decrypt(rec) {
  if (!rec) return null;
  if (rec.enc === 'safeStorage') {
    const ss = safeStorage() || (process.platform === 'darwin' ? realSafeStorage() : null);
    if (ss) {
      try { return ss.decryptString(Buffer.from(rec.v, 'base64')); } catch (_) {}
    }
    if (process.platform === 'darwin') {
      const plain = decryptMockSafeStorage(rec.v);
      if (plain !== null) return plain;
    }
    throw new Error('secret was encrypted with the OS keychain, which is unavailable in this context');
  }
  if (rec.enc === 'aes-256-gcm') {
    const keysToTry = rec.kv === 2 ? [getOrCreateMasterKey()] : [getOrCreateMasterKey(), legacyDeterministicFallbackKey()];
    for (const key of keysToTry) {
      try {
        const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(rec.iv, 'base64'));
        d.setAuthTag(Buffer.from(rec.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(rec.v, 'base64')), d.final()]).toString('utf8');
      } catch (_) {}
    }
  }
  return null;
}

function set(name, value) { const db = read(); db[name] = encrypt(value); write(db); return true; }
function get(name) {
  const db = read();
  const rec = db[name];
  if (!rec) return null;
  try {
    const plain = decrypt(rec);
    // Upgrade legacy deterministic fallback records or unencrypted contexts seamlessly.
    // ...and a legacy keychain record read on demand moves to the AES key, so
    // the keychain is never needed for it again.
    if (plain != null && (rec.enc === 'safeStorage' || (rec.enc === 'aes-256-gcm' && !rec.kv))) {
      try {
        db[name] = encrypt(plain);
        write(db);
      } catch (_) {}
    }
    return plain;
  } catch (_) {
    return null;
  }
}
function del(name) { const db = read(); const had = name in db; delete db[name]; write(db); return had; }
function list() { const db = read(); return Object.keys(db).map((k) => ({ name: k, enc: db[k].enc })); }
function has(name) { return name in read(); }
// Reports the backend without touching the keychain (calling safeStorage here
// made the Settings page itself a keychain read).
function status() {
  const kc = process.env.AKRON_USE_SAFE_STORAGE === '1';
  return { encrypted: true, backend: kc ? 'safeStorage' : 'aes-256-gcm-fallback', file: FILE };
}

module.exports = { set, get, del, list, has, status, hasLegacySafeStorage, migrateLegacySafeStorage };
