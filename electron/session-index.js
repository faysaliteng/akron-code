'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const digest = require('./session-digest');

const DEFAULT_INDEX_PATH = path.join(os.homedir(), '.autobot', 'session-index.db');

let _sqlInitPromise = null;
async function getSqlJs() {
  if (!_sqlInitPromise) {
    const initSqlJs = require('sql.js');
    const wasmDir = path.dirname(require.resolve('sql.js/dist/sql-wasm.wasm')).replace(/app\.asar([\\/])/g, 'app.asar.unpacked$1');
    _sqlInitPromise = initSqlJs({ locateFile: (file) => path.join(wasmDir, file) });
  }
  return _sqlInitPromise;
}

const handles = new Map();

function tokenize(text) {
  return [...new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9_./:-]+/)
      .filter((t) => t.length >= 2 && t.length <= 64)
  )].slice(0, 120);
}

function writeAtomic(filePath, dataUint8) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, Buffer.from(dataUint8));
  fs.renameSync(tmp, filePath);
}

async function openIndex(dbPath = DEFAULT_INDEX_PATH) {
  const resolved = path.resolve(dbPath || DEFAULT_INDEX_PATH);
  if (handles.has(resolved)) return handles.get(resolved);

  const SQL = await getSqlJs();
  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const buf = fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
  const db = buf ? new SQL.Database(buf) : new SQL.Database();

  try { db.exec('PRAGMA journal_mode=WAL;'); } catch (_) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS indexed_files (
      file_path TEXT PRIMARY KEY,
      mtime_ms REAL,
      conv_id TEXT
    );
    CREATE TABLE IF NOT EXISTS session_steps (
      step_pk INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id TEXT NOT NULL,
      turn_id TEXT,
      step_id TEXT NOT NULL,
      anchor_type TEXT,
      role TEXT,
      tool_name TEXT,
      title TEXT,
      text TEXT NOT NULL,
      ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_steps_conv ON session_steps(conv_id, ts);
    CREATE TABLE IF NOT EXISTS session_step_tokens (
      token TEXT NOT NULL,
      step_pk INTEGER NOT NULL,
      PRIMARY KEY (token, step_pk)
    );
    CREATE INDEX IF NOT EXISTS idx_step_tok ON session_step_tokens(token);
  `);

  let hasFts5 = false;
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_steps_fts USING fts5(
        text,
        conv_id UNINDEXED,
        step_id UNINDEXED,
        title UNINDEXED,
        content='session_steps',
        content_rowid='step_pk'
      );
    `);
    hasFts5 = true;
  } catch (_) {
    hasFts5 = false;
  }

  const persist = () => {
    try { writeAtomic(resolved, db.export()); } catch (_) {}
  };

  const handle = { db, dbPath: resolved, hasFts5, persist };
  handles.set(resolved, handle);
  return handle;
}

function listAllSessionFiles(sessionsRoot) {
  const root = sessionsRoot || path.join(os.homedir(), '.autobot', 'sessions');
  if (!fs.existsSync(root)) return [];
  const out = [];
  let convDirs = [];
  try { convDirs = fs.readdirSync(root); } catch (_) { return []; }
  for (const cd of convDirs) {
    const fullDir = path.join(root, cd);
    try {
      if (!fs.statSync(fullDir).isDirectory()) continue;
      for (const f of fs.readdirSync(fullDir)) {
        if (!f.endsWith('.jsonl')) continue;
        const fp = path.join(fullDir, f);
        const st = fs.statSync(fp);
        out.push({ convId: cd, filePath: fp, mtimeMs: st.mtimeMs });
      }
    } catch (_) {}
  }
  return out;
}

async function syncSessionIndex({ dbPath = DEFAULT_INDEX_PATH, sessionsRoot = null, forceRebuild = false } = {}) {
  const h = await openIndex(dbPath);
  const { db, hasFts5, persist } = h;

  if (forceRebuild) {
    db.exec('DELETE FROM session_step_tokens; DELETE FROM session_steps; DELETE FROM indexed_files;');
    if (hasFts5) {
      try { db.exec("INSERT INTO session_steps_fts(session_steps_fts) VALUES('rebuild');"); } catch (_) {}
    }
  }

  const files = listAllSessionFiles(sessionsRoot);
  let indexedFilesCount = 0;
  let totalAnchorsAdded = 0;

  db.exec('BEGIN TRANSACTION;');
  try {
    const chkStmt = db.prepare('SELECT mtime_ms FROM indexed_files WHERE file_path = ?');
    const delStepsStmt = db.prepare('SELECT step_pk FROM session_steps WHERE conv_id = ? AND turn_id = ?');
    const delTokStmt = db.prepare('DELETE FROM session_step_tokens WHERE step_pk = ?');
    const rmStepsStmt = db.prepare('DELETE FROM session_steps WHERE conv_id = ? AND turn_id = ?');
    const insStepStmt = db.prepare(
      'INSERT INTO session_steps (conv_id, turn_id, step_id, anchor_type, role, tool_name, title, text, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    const insTokStmt = db.prepare('INSERT OR IGNORE INTO session_step_tokens (token, step_pk) VALUES (?, ?)');
    const insFileStmt = db.prepare('INSERT OR REPLACE INTO indexed_files (file_path, mtime_ms, conv_id) VALUES (?, ?, ?)');
    const insFtsStmt = hasFts5
      ? db.prepare('INSERT INTO session_steps_fts (rowid, text, conv_id, step_id, title) VALUES (?, ?, ?, ?, ?)')
      : null;

    for (const f of files) {
      chkStmt.bind([f.filePath]);
      const existingMtime = chkStmt.step() ? chkStmt.getAsObject().mtime_ms : null;
      chkStmt.reset();
      if (existingMtime != null && Math.abs(Number(existingMtime) - f.mtimeMs) < 1) continue;

      const turn = digest.extractTurnAnchors(f.filePath);
      delStepsStmt.bind([f.convId, turn.turnId]);
      while (delStepsStmt.step()) {
        const pk = delStepsStmt.getAsObject().step_pk;
        delTokStmt.run([pk]);
      }
      delStepsStmt.reset();
      rmStepsStmt.run([f.convId, turn.turnId]);

      for (const a of turn.anchors) {
        insStepStmt.run([f.convId, turn.turnId, a.stepId, a.anchorType, a.role, a.toolName, turn.title || f.convId, a.text, a.ts]);
        const rowId = db.exec('SELECT last_insert_rowid() AS id')[0].values[0][0];
        if (insFtsStmt) {
          try { insFtsStmt.run([rowId, a.text, f.convId, a.stepId, turn.title || f.convId]); } catch (_) {}
        }
        for (const tok of tokenize(`${turn.title || ''} ${a.toolName} ${a.text}`)) {
          insTokStmt.run([tok, rowId]);
        }
        totalAnchorsAdded++;
      }
      insFileStmt.run([f.filePath, f.mtimeMs, f.convId]);
      indexedFilesCount++;
    }

    chkStmt.free();
    delStepsStmt.free();
    delTokStmt.free();
    rmStepsStmt.free();
    insStepStmt.free();
    insTokStmt.free();
    insFileStmt.free();
    if (insFtsStmt) insFtsStmt.free();
    db.exec('COMMIT;');
  } catch (e) {
    try { db.exec('ROLLBACK;'); } catch (_) {}
    throw e;
  }

  if (indexedFilesCount > 0 || forceRebuild) persist();
  return { ok: true, indexedFiles: indexedFilesCount, totalFiles: files.length, totalAnchorsAdded, hasFts5 };
}

async function searchHistory({ query, limit = 20, dbPath = DEFAULT_INDEX_PATH, sessionsRoot = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: true, hits: [] };
  await syncSessionIndex({ dbPath, sessionsRoot });
  const h = await openIndex(dbPath);
  const { db, hasFts5 } = h;
  const toks = tokenize(q);
  const hitsMap = new Map();

  if (hasFts5 && toks.length) {
    try {
      const ftsQuery = toks.map((t) => `"${t.replace(/"/g, '')}"*`).join(' AND ');
      const stmt = db.prepare(`
        SELECT s.step_pk, s.conv_id, s.turn_id, s.step_id, s.anchor_type, s.role, s.tool_name, s.title, s.text, s.ts
        FROM session_steps_fts f
        JOIN session_steps s ON s.step_pk = f.rowid
        WHERE session_steps_fts MATCH ?
        ORDER BY s.ts DESC
        LIMIT ?
      `);
      stmt.bind([ftsQuery, limit]);
      while (stmt.step()) {
        const r = stmt.getAsObject();
        hitsMap.set(r.step_pk, { ...r, score: 2 });
      }
      stmt.free();
    } catch (_) {}
  }

  if (toks.length && hitsMap.size < limit) {
    const placeholders = toks.map(() => '?').join(',');
    const stmt = db.prepare(`
      SELECT s.step_pk, s.conv_id, s.turn_id, s.step_id, s.anchor_type, s.role, s.tool_name, s.title, s.text, s.ts, COUNT(*) AS hits
      FROM session_step_tokens t
      JOIN session_steps s ON s.step_pk = t.step_pk
      WHERE t.token IN (${placeholders})
      GROUP BY s.step_pk
      ORDER BY hits DESC, s.ts DESC
      LIMIT ?
    `);
    stmt.bind([...toks, limit]);
    while (stmt.step()) {
      const r = stmt.getAsObject();
      if (!hitsMap.has(r.step_pk)) hitsMap.set(r.step_pk, { ...r, score: Number(r.hits) || 1 });
    }
    stmt.free();
  }

  if (hitsMap.size === 0) {
    const stmt = db.prepare(`
      SELECT step_pk, conv_id, turn_id, step_id, anchor_type, role, tool_name, title, text, ts
      FROM session_steps
      WHERE LOWER(text) LIKE ? OR LOWER(title) LIKE ?
      ORDER BY ts DESC
      LIMIT ?
    `);
    const pat = `%${q.toLowerCase()}%`;
    stmt.bind([pat, pat, limit]);
    while (stmt.step()) {
      const r = stmt.getAsObject();
      hitsMap.set(r.step_pk, { ...r, score: 1 });
    }
    stmt.free();
  }

  const hits = [...hitsMap.values()]
    .sort((a, b) => (b.score - a.score) || ((b.ts || 0) - (a.ts || 0)))
    .slice(0, limit)
    .map((r) => ({
      convId: r.conv_id,
      turnId: r.turn_id,
      stepId: r.step_id,
      anchorType: r.anchor_type,
      role: r.role,
      toolName: r.tool_name,
      title: r.title || r.conv_id,
      snippet: r.text,
      ts: r.ts,
      deepLink: `session://${encodeURIComponent(r.conv_id)}?focus=${encodeURIComponent(r.step_id).replace(/%3A/gi, ':')}`,
    }));

  return { ok: true, hits };
}

async function askAcrossHistory({
  question,
  provider = null,
  chatFn = null,
  limit = 10,
  dbPath = DEFAULT_INDEX_PATH,
  sessionsRoot = null,
} = {}) {
  const q = String(question || '').trim();
  if (!q) return { ok: false, error: 'Question is required.' };
  const searchRes = await searchHistory({ query: q, limit, dbPath, sessionsRoot });
  const hits = searchRes.hits || [];
  if (!hits.length) {
    return {
      ok: true,
      answer: 'No matching past coding sessions were found in your local session index.',
      citations: [],
      hits: [],
    };
  }

  const seenConvs = [...new Set(hits.map((h) => h.convId))].slice(0, 4);
  const digests = seenConvs.map((cid) => digest.buildTrajectoryDigest({ convId: cid, sessionsRoot, maxTokens: 450 }));

  const citations = hits.slice(0, 6).map((h) => ({
    label: `${h.title} · ${h.stepId}`,
    convId: h.convId,
    stepId: h.stepId,
    deepLink: h.deepLink,
    snippet: h.snippet,
  }));

  const canUseModel = typeof chatFn === 'function' || (provider && (provider.apiKey || provider.oauthAccount || provider.baseUrl || provider.provider === 'ollama'));
  if (!canUseModel) {
    const answerLines = [
      `Found **${hits.length}** matching step(s) across **${seenConvs.length}** session(s):`,
      '',
      ...citations.map((c) => `- [${c.label}](${c.deepLink}): ${c.snippet}`),
    ];
    return { ok: true, answer: answerLines.join('\n'), citations, hits };
  }

  const invokeChat = chatFn || require('./llm').chatOnce;
  const prompt = [
    'Answer the user question using ONLY the grounded session trajectory digests below.',
    'Cite every key fact inline using clickable markdown deep links in the exact format:',
    '[short label](session://<convId>?focus=<stepId>)',
    '',
    `QUESTION: ${q}`,
    '',
    'MATCHING HITS:',
    ...citations.map((c) => `- ${c.deepLink} (${c.title}): ${c.snippet}`),
    '',
    'TRAJECTORY DIGESTS:',
    ...digests.map((d) => `=== Session ${d.convId} (${d.title}) ===\n${d.digest}`),
  ].join('\n');

  const res = await invokeChat({
    provider,
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1200,
  });

  const answer = String((res && res.content) || '').trim() ||
    citations.map((c) => `- [${c.label}](${c.deepLink}): ${c.snippet}`).join('\n');
  return { ok: true, answer, citations, hits };
}

module.exports = {
  openIndex,
  syncSessionIndex,
  searchHistory,
  askAcrossHistory,
};
