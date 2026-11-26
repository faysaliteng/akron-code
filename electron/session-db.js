'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DB_PATH = path.join(os.homedir(), '.autobot', 'akron.db');

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

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function tokenize(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_./:-]+/)
      .filter((t) => t.length >= 2 && t.length <= 64)
  )].slice(0, 180);
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

async function openInstance(dbPath = DEFAULT_DB_PATH) {
  const resolved = path.resolve(dbPath || DEFAULT_DB_PATH);
  if (instances.has(resolved)) return instances.get(resolved);

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
      snippet TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_message_tokens_tok ON message_tokens(token);
    CREATE INDEX IF NOT EXISTS idx_message_tokens_conv ON message_tokens(conv_id);
  `);

  let hasFts5 = false;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(msg_id UNINDEXED, conv_id UNINDEXED, title, content);`);
    hasFts5 = true;
  } catch (_) {
    hasFts5 = false;
  }

  const inst = { db, dbPath: resolved, hasFts5, dirty: false };
  instances.set(resolved, inst);
  return inst;
}

function saveAtomic(inst) {
  if (!inst || !inst.db) return;
  ensureDir(path.dirname(inst.dbPath));
  const data = Buffer.from(inst.db.export());
  const tmp = `${inst.dbPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 7)}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, inst.dbPath);
  try { fs.chmodSync(inst.dbPath, 0o600); } catch (_) {}
  inst.dirty = false;
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
  const insTok = db.prepare('INSERT INTO message_tokens (token, conv_id, msg_id, title, snippet) VALUES (?, ?, ?, ?, ?)');
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
      for (const tok of tokenize(combined)) {
        insTok.run([tok, convId, msgId, title, snip]);
      }
    }
  } finally {
    insMsg.free();
    insTok.free();
    if (insFts) insFts.free();
  }
}

async function initSessionDb(opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);
  if (!fs.existsSync(inst.dbPath)) saveAtomic(inst);
  return { ok: true, dbPath: inst.dbPath, fts5: inst.hasFts5 };
}

async function upsertConversation(conv, opts = {}) {
  if (!conv || !conv.id) return { ok: false, error: 'Conversation id required.' };
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);
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
  if (opts.deferSave !== true) saveAtomic(inst);
  else inst.dirty = true;
  return { ok: true, id };
}

async function deleteConversation(id, opts = {}) {
  if (!id) return { ok: false, error: 'id required' };
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);
  const cid = String(id);
  inst.db.run('DELETE FROM conversations WHERE id = ?', [cid]);
  inst.db.run('DELETE FROM messages WHERE conv_id = ?', [cid]);
  inst.db.run('DELETE FROM message_tokens WHERE conv_id = ?', [cid]);
  if (inst.hasFts5) {
    try { inst.db.run('DELETE FROM messages_fts WHERE conv_id = ?', [cid]); } catch (_) {}
  }
  saveAtomic(inst);
  return { ok: true, id: cid };
}

async function listConversations(opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);
  const limit = Math.min(Math.max(1, Number(opts.limit) || 200), 1000);
  const stmt = inst.db.prepare('SELECT id, title, cwd, model, pinned, archived, created_at, updated_at FROM conversations ORDER BY pinned DESC, updated_at DESC LIMIT ?');
  const rows = [];
  stmt.bind([limit]);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

async function getConversation(id, opts = {}) {
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);
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
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);
  const list = Array.isArray(convsArray) ? convsArray : [];
  let migrated = 0;
  for (const c of list) {
    if (!c || !c.id) continue;
    await upsertConversation(c, { dbPath: inst.dbPath, deferSave: true });
    migrated++;
  }
  inst.db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('migrated_v1', ?)", [String(Date.now())]);
  saveAtomic(inst);
  return { ok: true, migrated, total: list.length, dbPath: inst.dbPath };
}

async function searchConversationsDb(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = Math.min(Math.max(1, Number(opts.limit) || 30), 100);
  const inst = await openInstance(opts.dbPath || DEFAULT_DB_PATH);

  const byKey = new Map();

  // 1. FTS5 query when compiled into sql.js WASM
  if (inst.hasFts5) {
    try {
      const ftsQ = tokenize(q).map((t) => `"${t.replace(/"/g, '""')}"*`).join(' AND ');
      if (ftsQ) {
        const stmt = inst.db.prepare(`SELECT msg_id, conv_id, title, content, bm25(messages_fts) AS rank FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`);
        stmt.bind([ftsQ, limit]);
        while (stmt.step()) {
          const r = stmt.getAsObject();
          const key = `${r.conv_id}:${r.msg_id}`;
          byKey.set(key, {
            convId: r.conv_id,
            msgId: r.msg_id,
            title: r.title || 'Chat',
            snippet: makeSnippet(r.content, q),
            score: 10 - (Number(r.rank) || 0),
          });
        }
        stmt.free();
      }
    } catch (_) {}
  }

  // 2. Inverted token index query (handles non-FTS5 WASM & phrase boosts cleanly)
  const qToks = tokenize(q);
  if (qToks.length) {
    const ph = qToks.map(() => '?').join(',');
    const stmt = inst.db.prepare(
      `SELECT conv_id, msg_id, MAX(title) AS title, MAX(snippet) AS snippet, COUNT(DISTINCT token) AS matched
       FROM message_tokens
       WHERE token IN (${ph})
       GROUP BY conv_id, msg_id
       ORDER BY matched DESC
       LIMIT ?`
    );
    stmt.bind([...qToks, limit * 2]);
    while (stmt.step()) {
      const r = stmt.getAsObject();
      const key = `${r.conv_id}:${r.msg_id}`;
      const phraseBoost = String(r.snippet || '').toLowerCase().includes(q.toLowerCase()) ? 4 : 0;
      const score = Number(r.matched || 0) * 2 + phraseBoost;
      const existing = byKey.get(key);
      if (!existing || score > existing.score) {
        byKey.set(key, {
          convId: r.conv_id,
          msgId: r.msg_id,
          title: r.title || 'Chat',
          snippet: makeSnippet(r.snippet, q),
          score,
        });
      }
    }
    stmt.free();
  }

  // Enrich conversation titles from conversations table if missing
  const titleStmt = inst.db.prepare('SELECT title FROM conversations WHERE id = ? LIMIT 1');
  const results = [...byKey.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  for (const hit of results) {
    if (!hit.title || hit.title === 'Chat') {
      try {
        titleStmt.bind([hit.convId]);
        if (titleStmt.step()) hit.title = titleStmt.getAsObject().title || 'Chat';
        titleStmt.reset();
      } catch (_) {}
    }
  }
  titleStmt.free();
  return results;
}

function closeSessionDb(dbPath = null) {
  if (dbPath) {
    const resolved = path.resolve(dbPath);
    const inst = instances.get(resolved);
    if (inst) {
      try { if (inst.dirty) saveAtomic(inst); } catch (_) {}
      try { inst.db.close(); } catch (_) {}
      instances.delete(resolved);
    }
    return;
  }
  for (const [k, inst] of instances.entries()) {
    try { if (inst.dirty) saveAtomic(inst); } catch (_) {}
    try { inst.db.close(); } catch (_) {}
    instances.delete(k);
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  initSessionDb,
  migrateFromLocalStorage,
  upsertConversation,
  deleteConversation,
  listConversations,
  getConversation,
  searchConversationsDb,
  closeSessionDb,
};
