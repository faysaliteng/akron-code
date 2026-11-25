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

const DIR = path.join(os.homedir(), '.autobot');
const FILE = path.join(DIR, 'secrets.json');

function safeStorage() {
  try {
    const { safeStorage: ss } = require('electron');
    if (ss && ss.isEncryptionAvailable && ss.isEncryptionAvailable()) return ss;
  } catch (_) {}
  return null;
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

function fallbackKey() {
  // Deterministic local key material: protects against casual file reads, not
  // a determined attacker. Real protection comes from safeStorage.
  const seed = [os.hostname(), os.userInfo().username, 'helio-bot-secret-store'].join('|');
  return crypto.createHash('sha256').update(seed).digest();
}

function encrypt(value) {
  const ss = safeStorage();
  if (ss) return { enc: 'safeStorage', v: ss.encryptString(String(value)).toString('base64') };
  const iv = crypto.randomBytes(12);
  const key = fallbackKey();
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(String(value), 'utf8'), c.final()]);
  return { enc: 'aes-256-gcm', iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), v: body.toString('base64') };
}

function decrypt(rec) {
  if (!rec) return null;
  if (rec.enc === 'safeStorage') {
    const ss = safeStorage();
    if (!ss) throw new Error('secret was encrypted with the OS keychain, which is unavailable in this context');
    return ss.decryptString(Buffer.from(rec.v, 'base64'));
  }
  if (rec.enc === 'aes-256-gcm') {
    const d = crypto.createDecipheriv('aes-256-gcm', fallbackKey(), Buffer.from(rec.iv, 'base64'));
    d.setAuthTag(Buffer.from(rec.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(rec.v, 'base64')), d.final()]).toString('utf8');
  }
  return null;
}

function set(name, value) { const db = read(); db[name] = encrypt(value); write(db); return true; }
function get(name) { const db = read(); try { return decrypt(db[name]); } catch (_) { return null; } }
function del(name) { const db = read(); const had = name in db; delete db[name]; write(db); return had; }
function list() { const db = read(); return Object.keys(db).map((k) => ({ name: k, enc: db[k].enc })); }
function has(name) { return name in read(); }
function status() { return { encrypted: !!safeStorage(), backend: safeStorage() ? 'safeStorage' : 'aes-256-gcm-fallback', file: FILE }; }

module.exports = { set, get, del, list, has, status };
