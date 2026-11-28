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

function migrateLegacySafeStorage() {
  const ss = realSafeStorage();
  if (!ss) return { migrated: 0, remaining: 0 };
  const db = read();
  let migrated = 0;
  let remaining = 0;
  let dirty = false;
  for (const [k, rec] of Object.entries(db)) {
    if (!rec || rec.enc !== 'safeStorage') continue;
    try {
      const plain = ss.decryptString(Buffer.from(rec.v, 'base64'));
      if (plain != null) {
        db[k] = encrypt(plain);
        migrated++;
        dirty = true;
      } else {
        remaining++;
      }
    } catch (_) {
      remaining++;
    }
  }
  if (dirty) {
    try { write(db); } catch (_) {}
  }
  return { migrated, remaining };
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

function encrypt(value) {
  const ss = safeStorage();
  if (ss) return { enc: 'safeStorage', v: ss.encryptString(String(value)).toString('base64') };
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
    if (plain != null && rec.enc === 'aes-256-gcm' && !rec.kv) {
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
function status() { return { encrypted: !!safeStorage(), backend: safeStorage() ? 'safeStorage' : 'aes-256-gcm-fallback', file: FILE }; }

module.exports = { set, get, del, list, has, status, hasLegacySafeStorage, migrateLegacySafeStorage };
