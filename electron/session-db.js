'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.autobot', 'akron.db');
const DEFAULT_WAL_CHECKPOINT_THRESHOLD = 50;
const DEFAULT_WAL_IDLE_MS = 30_000;

let _sqlInitPromise = null;
async function getSqlJs() {
  if (!_sqlInitPromise) {
    const initSqlJs = require('sql.js');
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm')).replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
    _sqlInitPromise = initSqlJs({
      locateFile: (file) => path.join(wasmDir, file),
    });
  }
  return _sqlInitPromise;
}

const instances = new Map();
let exitHookRegistered = false;

function registerExitHook() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    try { flushAll(); } catch (_) {}
  });
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function walPathFor(dbPath = DEFAULT_DB_PATH) {
  return `${path.resolve(dbPath || DEFAULT_DB_PATH)}.wal.jsonl`;
}

function tokenizeAll(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9_./:-]+/)
    .filter((t) => t.length >= 2 && t.length <= 64);
}

function tokenize(text) {
  return [...new Set(tokenizeAll(text))].slice(0, 180);
}

function safeStr(v, max = 100000) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? s.slice(0, max) : s;
}

function extractMessageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((b) => (typeof b === 'string' ? b : (b && (b.text || b.content)) || '')).filter(Boolean).join('\n');
  }
  return safeStr(m.content || '');
}

function makeSnippet(text, query) {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return '';
  const q = String(query || '').toLowerCase().trim();
  if (!q) return src.slice(0, 180);
  const idx = src.toLowerCase().indexOf(q);
  if (idx >= 0) {
    const start = Math.max(0, idx - 50);
    return (start > 0 ? '…' : '') + src.slice(start, start + 180);
  }
  const firstTok = tokenize(q)[0];
  if (firstTok) {
    const ti = src.toLowerCase().indexOf(firstTok);
    if (ti >= 0) {
      const start = Math.max(0, ti - 50);
      return (start > 0 ? '…' : '') + src.slice(start, start + 180);
    }
  }
  return src.slice(0, 180);
}

function ensureTokenColumns(db) {
  const cols = new Set();
  const s = db.prepare('PRAGMA table_info(message_tokens)');
  while (s.step()) cols.add(String(s.getAsObject().name || ''));
  s.free();
  if (!cols.has('tf')) {
    try { db.run('ALTER TABLE message_tokens ADD COLUMN tf INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  }
  if (!cols.has('doc_len')) {
    try { db.run('ALTER TABLE message_tokens ADD COLUMN doc_len INTEGER NOT NULL DEFAULT 1'); } catch (_) {}
  }
}

function indexConvMessages(inst, conv) {
  const { db, hasFts5 } = inst;
  const convId = String(conv.id);
  const title = String(conv.title || 'Untitled');
  const msgs = Array.isArray(conv.messages) ? conv.messages : [];

  db.run('DELETE FROM messages WHERE conv_id = ?', [convId]);
  db.run('DELETE FROM message_tokens WHERE conv_id = ?', [convId]);
  if (hasFts5) {
    try { db.run('DELETE FROM messages_fts WHERE conv_id = ?', [convId]); } catch (_) {}
  }

  const insMsg = db.prepare('INSERT OR REPLACE INTO messages (id, conv_id, idx, role, content, tool_traces_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insTok = db.prepare('INSERT INTO message_tokens (token, conv_id, msg_id, title, snippet, tf, doc_len) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const insFts = hasFts5 ? db.prepare('INSERT INTO messages_fts (msg_id, conv_id, title, content) VALUES (?, ?, ?, ?)') : null;

  try {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i] || {};
      const msgId = String(m.id || `${convId}:${i}`);
      const text = extractMessageText(m);
      const tracesJson = m.traces || m.tool_calls ? safeStr(m.traces || m.tool_calls, 48000) : '';
      const ts = Number(m.ts || m.createdAt || conv.updatedAt || Date.now());
      insMsg.run([msgId, convId, i, String(m.role || 'user'), text, tracesJson, ts]);
      if (insFts) {
        try { insFts.run([msgId, convId, i === 0 ? title : '', text]); } catch (_) {}
      }
      const combined = (i === 0 ? title + ' ' : '') + text;
      const snip = combined.replace(/\s+/g, ' ').trim().slice(0, 320);
      const rawToks = tokenizeAll(combined);
      const tfMap = new Map();
      for (const tok of rawToks) {
        if (!tfMap.has(tok) && tfMap.size >= 240) continue;
        tfMap.set(tok, (tfMap.get(tok) || 0) + 1);
      }
      const docLen = Math.max(1, rawToks.length);
      for (const [tok, tf] of tfMap.entries()) {
        insTok.run([tok, convId, msgId, title, snip, tf, docLen]);
      }
    }
  } finally {
    insMsg.free();
    insTok.free();
    if (insFts) insFts.free();
  }
}

function applyUpsertToDb(inst, conv) {
  const now = Date.now();
  const id = String(conv.id);
  const title = String(conv.title || 'New chat').slice(0, 240);
  const cwd = String(conv.cwd || '');
  const model = String((conv.provider && conv.provider.model) || conv.model || '');
  const pinned = conv.pinned ? 1 : 0;
  const archived = conv.archived ? 1 : 0;
  const createdAt = Number(conv.createdAt || conv.ts || now);
  const updatedAt = Number(conv.updatedAt || now);
  const rawJson = JSON.stringify(conv);

  inst.db.run(
    `INSERT OR REPLACE INTO conversations (id, title, cwd, model, pinned, archived, created_at, updated_at, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, cwd, model, pinned, archived, createdAt, updatedAt, rawJson]
  );
  indexConvMessages(inst, conv);
  inst.dirty = true;
}

function applyDeleteToDb(inst, convId) {
  const cid = String(convId);
  inst.db.run('DELETE FROM conversations WHERE id = ?', [cid]);
  inst.db.run('DELETE FROM messages WHERE conv_id = ?', [cid]);
  inst.db.run('DELETE FROM message_tokens WHERE conv_id = ?', [cid]);
  if (inst.hasFts5) {
    try { inst.db.run('DELETE FROM messages_fts WHERE conv_id = ?', [cid]); } catch (_) {}
  }
  inst.dirty = true;
}

function applyFlagToDb(inst, convId, field, value) {
  const cid = String(convId);
  const flag = value ? 1 : 0;
  const stmt = inst.db.prepare('SELECT raw_json FROM conversations WHERE id = ? LIMIT 1');
  stmt.bind([cid]);
  let raw = null;
  if (stmt.step()) {
    try { raw = JSON.parse(stmt.getAsObject().raw_json); } catch (_) {}
  }
  stmt.free();
  if (raw && typeof raw === 'object') {
    raw[field] = Boolean(value);
    raw.updatedAt = raw.updatedAt || Date.now();
    inst.db.run(`UPDATE conversations SET ${field} = ?, raw_json = ? WHERE id = ?`, [flag, JSON.stringify(raw), cid]);
  } else {
    inst.db.run(`UPDATE conversations SET ${field} = ? WHERE id = ?`, [flag, cid]);
  }
  inst.dirty = true;
}

function checkpointInstance(inst) {
  if (!inst || !inst.db) return { ok: false };
  if (inst.idleTimer) {
    clearTimeout(inst.idleTimer);
    inst.idleTimer = null;
  }
  ensureDir(path.dirname(inst.dbPath));
  const data = Buffer.from(inst.db.export());
  const tmp = `${inst.dbPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, inst.dbPath);
  try { fs.chmodSync(inst.dbPath, 0o600); } catch (_) {}
  try {
    if (fs.existsSync(inst.walPath)) {
      fs.writeFileSync(inst.walPath, '', { encoding: 'utf8', mode: 0o600 });
    }
  } catch (_) {}
  inst.walFrames = 0;
  inst.dirty = false;
  return { ok: true, dbPath: inst.dbPath, walPath: inst.walPath };
}

function replayWal(inst) {
  if (!inst || !inst.walPath || !fs.existsSync(inst.walPath)) return 0;
  let raw = '';
  try { raw = fs.readFileSync(inst.walPath, 'utf8'); } catch (_) { return 0; }
  if (!raw.trim()) return 0;

  let replayed = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let frame;
    try { frame = JSON.parse(trimmed); } catch (_) { continue; } // ignore truncated/corrupt tail safely
    if (!frame || typeof frame !== 'object') continue;
    if (frame.op === 'upsert_conv' && frame.conv && frame.conv.id) {
      applyUpsertToDb(inst, frame.conv);
      replayed++;
    } else if (frame.op === 'delete_conv' && frame.id) {
      applyDeleteToDb(inst, frame.id);
      replayed++;
    } else if (frame.op === 'pin_conv' && frame.id) {
      applyFlagToDb(inst, frame.id, 'pinned', Boolean(frame.pinned));
      replayed++;
    } else if (frame.op === 'archive_conv' && frame.id) {
      applyFlagToDb(inst, frame.id, 'archived', Boolean(frame.archived));
      replayed++;
    }
  }
  if (replayed > 0) checkpointInstance(inst);
  return replayed;
}

function appendWalFrame(inst, frame, opts = {}) {
  ensureDir(path.dirname(inst.walPath));
  const payload = JSON.stringify({ v: 1, ts: Date.now(), ...frame }) + '\n';
  fs.appendFileSync(inst.walPath, payload, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(inst.walPath, 0o600); } catch (_) {}
  inst.walFrames = (inst.walFrames || 0) + 1;

  const threshold = Number(opts.checkpointThreshold || inst.checkpointThreshold || DEFAULT_WAL_CHECKPOINT_THRESHOLD);
  const idleMs = Number(opts.idleMs != null ? opts.idleMs : inst.idleMs);
  if (opts.checkpointNow === true || inst.walFrames >= threshold) {
    checkpointInstance(inst);
    return;
  }
  if (inst.idleTimer) clearTimeout(inst.idleTimer);
  inst.idleTimer = setTimeout(() => {
    inst.idleTimer = null;
    try { checkpointInstance(inst); } catch (_) {}
  }, Number.isFinite(idleMs) && idleMs >= 10 ? idleMs : DEFAULT_WAL_IDLE_MS);
  if (inst.idleTimer.unref) inst.idleTimer.unref();
}

async function openInstance(dbPath = DEFAULT_DB_PATH, opts = {}) {
  const resolved = path.resolve(dbPath || DEFAULT_DB_PATH);
  if (instances.has(resolved)) {
    const existing = instances.get(resolved);
    if (opts.checkpointThreshold) existing.checkpointThreshold = Number(opts.checkpointThreshold);
    if (opts.idleMs != null) existing.idleMs = Number(opts.idleMs);
    return existing;
  }

  registerExitHook();
  const SQL = await getSqlJs();
  ensureDir(path.dirname(resolved));
  const buf = fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
  const db = buf ? new SQL.Database(buf) : new SQL.Database();

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      cwd TEXT,
      model TEXT,
      pinned INTEGER DEFAULT 0,
      archived INTEGER DEFAULT 0,
      created_at INTEGER,
      updated_at INTEGER,
      raw_json TEXT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conv_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      role TEXT,
      content TEXT,
      tool_traces_json TEXT,
      created_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conv_id, idx);
    CREATE INDEX IF NOT EXISTS idx_convs_updated ON conversations(updated_at DESC);
    CREATE TABLE IF NOT EXISTS message_tokens (
      token TEXT NOT NULL,
      conv_id TEXT NOT NULL,
      msg_id TEXT NOT NULL,
      title TEXT,
      snippet TEXT,
      tf INTEGER NOT NULL DEFAULT 1,
      doc_len INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_message_tokens_tok ON message_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_message_tokens_conv ON message_tokens(conv_id);
  `);
  ensureTokenColumns(db);

  let hasFts5 = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(msg_id UNINDEXED, conv_id UNINDEXED, title, content);`);
    hasFts5 = true;
  } catch (_) {
    hasFts5 = false;
  }

  const inst = {
    db,
    dbPath: resolved,
    walPath: walPathFor(resolved),
    hasFts5,
    dirty: false,
    walFrames: 0,
    idleTimer: null,
    checkpointThreshold: Number(opts.checkpointThreshold || DEFAULT_WAL_CHECKPOINT_THRESHOLD),
    idleMs: opts.idleMs != null ? Number(opts.idleMs) : DEFAULT_WAL_IDLE_MS,
  };
  instances.set(resolved, inst);
  replayWal(inst);
  return inst;
}

function saveAtomic(inst) {
  return checkpointInstance(inst);
}

async function initSessionDb(opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  if (!fs.existsSync(inst.dbPath)) checkpointInstance(inst);
  return { ok: true, dbPath: inst.dbPath, walPath: inst.walPath, fts5: inst.hasFts5 };
}

async function upsertConversation(conv, opts = {}) {
  if (!conv || !conv.id) return { ok: false, error: 'Conversation id required.' };
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  applyUpsertToDb(inst, conv);
  if (opts.deferSave !== true) {
    appendWalFrame(inst, { op: 'upsert_conv', conv }, opts);
  }
  return { ok: true, id: String(conv.id), walFrames: inst.walFrames };
}

async function deleteConversation(id, opts = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  const cid = String(id);
  applyDeleteToDb(inst, cid);
  appendWalFrame(inst, { op: 'delete_conv', id: cid }, opts);
  return { ok: true, id: cid };
}

async function pinConversation(id, pinned = true, opts = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  const cid = String(id);
  applyFlagToDb(inst, cid, 'pinned', Boolean(pinned));
  appendWalFrame(inst, { op: 'pin_conv', id: cid, pinned: Boolean(pinned) }, opts);
  return { ok: true, id: cid, pinned: Boolean(pinned) };
}

async function archiveConversation(id, archived = true, opts = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  const cid = String(id);
  applyFlagToDb(inst, cid, 'archived', Boolean(archived));
  appendWalFrame(inst, { op: 'archive_conv', id: cid, archived: Boolean(archived) }, opts);
  return { ok: true, id: cid, archived: Boolean(archived) };
}

async function listConversations(opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 200), 1000);
  const stmt = inst.db.prepare('SELECT id, title, cwd, model, pinned, archived, created_at, updated_at FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT ?');
  const rows = [];
  stmt.bind([limit]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function getConversation(id, opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  const stmt = inst.db.prepare('SELECT raw_json FROM conversations WHERE id = ? LIMIT 1');
  stmt.bind([String(id)]);
  let row = null;
  if (stmt.step()) {
    const obj = stmt.getAsObject();
    try { row = JSON.parse(obj.raw_json); } catch (_) { row = null; }
  }
  stmt.free();
  return row;
}

async function migrateFromLocalStorage(convsArray, opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);
  const list = Array.isArray(convsArray) ? convsArray : [];
  let migrated = 0;
  for (const c of list) {
    if (!c || !c.id) continue;
    await upsertConversation(c, { dbPath: inst.dbPath, deferSave: true });
    migrated++;
  }
  inst.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_v1', ?)", [String(Date.now())]);
  checkpointInstance(inst);
  return { ok: true, migrated, total: list.length, dbPath: inst.dbPath };
}

/**
 * Full-text search across conversations using Okapi BM25 (k1=1.5, b=0.75) +
 * optional FTS5 + exact-phrase, title, and recency tie-break boosts.
 */
async function searchMessages(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = Math.min(Math.max(1, Number(opts.limit) || 30), 100);
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH, opts);

  const byKey = new Map();

  // Load conversation titles + updated_at for title & recency tie-breaks
  const convInfo = new Map();
  let maxUpdated = 1;
  const cStmt = inst.db.prepare('SELECT id, title, updated_at FROM conversations');
  while (cStmt.step()) {
    const r = cStmt.getAsObject();
    const u = Number(r.updated_at || 0);
    if (u > maxUpdated) maxUpdated = u;
    convInfo.set(String(r.id), { title: r.title || 'Chat', updatedAt: u });
  }
  cStmt.free();

  // 1. Native FTS5 bm25() when available
  if (inst.hasFts5) {
    try {
      const ftsQ = tokenize(q).map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
      if (ftsQ) {
        const stmt = inst.db.prepare(`SELECT msg_id, conv_id, title, content, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`);
        stmt.bind([ftsQ, limit * 2]);
        while (stmt.step()) {
          const r = stmt.getAsObject();
          const key = `${r.conv_id}:${r.msg_id}`;
          byKey.set(key, {
            convId: r.conv_id,
            msgId: r.msg_id,
            title: r.title || (convInfo.get(r.conv_id)?.title) || 'Chat',
            snippet: makeSnippet(r.content, q),
            score: 10 - (Number(r.rank) || 0),
          });
        }
        stmt.free();
      }
    } catch (_) {}
  }

  // 2. True Okapi BM25 across message_tokens
  const qToks = tokenize(q);
  if (qToks.length) {
    let totalDocs = 1;
    let avgDocLen = 12;
    try {
      const statStmt = inst.db.prepare('SELECT COUNT(DISTINCT msg_id) AS n, AVG(doc_len) AS avdl FROM message_tokens');
      if (statStmt.step()) {
        const st = statStmt.getAsObject();
        totalDocs = Math.max(1, Number(st.n) || 1);
        avgDocLen = Math.max(1, Number(st.avdl) || 12);
      }
      statStmt.free();
    } catch (_) {}

    const dfMap = new Map();
    const ph = qToks.map(() => '?').join(',');
    try {
      const dfStmt = inst.db.prepare(`SELECT token, COUNT(DISTINCT msg_id) AS df FROM message_tokens WHERE token IN (${ph}) GROUP BY token`);
      dfStmt.bind(qToks);
      while (dfStmt.step()) {
        const r = dfStmt.getAsObject();
        dfMap.set(r.token, Number(r.df) || 0);
      }
      dfStmt.free();
    } catch (_) {}

    const k1 = 1.5;
    const b = 0.75;
    const msgBuckets = new Map();
    const rowStmt = inst.db.prepare(
      `SELECT conv_id, msg_id, token, title, snippet, tf, doc_len
       FROM message_tokens
       WHERE token IN (${ph})`
    );
    rowStmt.bind(qToks);
    while (rowStmt.step()) {
      const r = rowStmt.getAsObject();
      const key = `${r.conv_id}:${r.msg_id}`;
      let bucket = msgBuckets.get(key);
      if (!bucket) {
        bucket = {
          convId: r.conv_id,
          msgId: r.msg_id,
          title: r.title || (convInfo.get(r.conv_id)?.title) || 'Chat',
          snippet: r.snippet || '',
          docLen: Math.max(1, Number(r.doc_len) || 12),
          bm25: 0,
        };
        msgBuckets.set(key, bucket);
      }
      const df = dfMap.get(r.token) || 0;
      const tf = Math.max(1, Number(r.tf) || 1);
      const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
      bucket.bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (bucket.docLen / avgDocLen))));
    }
    rowStmt.free();

    const qLower = q.toLowerCase();
    for (const [key, bucket] of msgBuckets.entries()) {
      const info = convInfo.get(bucket.convId) || { title: bucket.title, updatedAt: 0 };
      const titleLower = String(info.title || bucket.title || '').toLowerCase();
      const phraseBoost = String(bucket.snippet || '').toLowerCase().includes(qLower) ? 4.0 : 0;
      const titleBoost = (titleLower.includes(qLower) || qToks.some((t) => titleLower.includes(t))) ? 3.0 : 0;
      const recencyBoost = maxUpdated > 0 ? Math.min(0.35, Math.max(0, (info.updatedAt / maxUpdated) * 0.35)) : 0;
      const score = Number((bucket.bm25 + phraseBoost + titleBoost + recencyBoost).toFixed(4));
      const existing = byKey.get(key);
      if (!existing || score > existing.score) {
        byKey.set(key, {
          convId: bucket.convId,
          msgId: bucket.msgId,
          title: info.title || bucket.title || 'Chat',
          snippet: makeSnippet(bucket.snippet, q),
          score,
        });
      }
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

const searchConversationsDb = searchMessages;

function checkpointSessionDb(dbPath = DEFAULT_DB_PATH) {
  const resolved = path.resolve(dbPath || DEFAULT_DB_PATH);
  const inst = instances.get(resolved);
  if (!inst) return { ok: false, error: 'Instance not open' };
  return checkpointInstance(inst);
}

function flushAll() {
  let count = 0;
  for (const inst of instances.values()) {
    try {
      checkpointInstance(inst);
      count++;
    } catch (_) {}
  }
  return { ok: true, flushed: count };
}

function closeSessionDb(dbPath = null) {
  if (dbPath) {
    const resolved = path.resolve(dbPath);
    const inst = instances.get(resolved);
    if (inst) {
      try {
        if (inst.dirty || inst.walFrames > 0) checkpointInstance(inst);
        if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }
      } catch (_) {}
      try { inst.db.close(); } catch (_) {}
      instances.delete(resolved);
    }
    return;
  }
  for (const [k, inst] of instances.entries()) {
    try {
      if (inst.dirty || inst.walFrames > 0) checkpointInstance(inst);
      if (inst.idleTimer) { clearTimeout(inst.idleTimer); inst.idleTimer = null; }
    } catch (_) {}
    try { inst.db.close(); } catch (_) {}
    instances.delete(k);
  }
}

function verifyWithHostSqlite(dbPath = DEFAULT_DB_PATH) {
  const resolved = path.resolve(dbPath || DEFAULT_DB_PATH);
  let mod;
  try { mod = require('node:sqlite'); } catch (_) {
    return { ok: false, supported: false, reason: 'node:sqlite unavailable on this runtime' };
  }
  if (!mod || typeof mod.DatabaseSync !== 'function') {
    return { ok: false, supported: false, reason: 'DatabaseSync missing' };
  }
  const hostDb = new mod.DatabaseSync(resolved, { readOnly: true });
  try {
    const row = hostDb.prepare('SELECT COUNT(*) AS count FROM conversations').get();
    return { ok: true, supported: true, conversationsCount: Number(row && row.count) || 0 };
  } finally {
    try { hostDb.close(); } catch (_) {}
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  walPathFor,
  initSessionDb,
  migrateFromLocalStorage,
  upsertConversation,
  deleteConversation,
  pinConversation,
  archiveConversation,
  listConversations,
  getConversation,
  searchMessages,
  searchConversationsDb,
  checkpointSessionDb,
  flushAll,
  closeSessionDb,
  verifyWithHostSqlite,
};
