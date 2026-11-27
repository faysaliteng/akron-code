'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const astChunker = require('./ast-chunker');
const embedder = require('./embedder');

const INDEX_DIR = path.join(os.homedir(), '.autobot', 'indexes');
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'out', '.next', '.nuxt',
  '.cache', 'coverage', 'venv', '.venv', '__pycache__', 'target', 'vendor',
]);
const TEXT_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|swift|c|cpp|h|hpp|rb|php|css|scss|html|md|json|yaml|yml|toml|sql|sh)$/i;
const MAX_FILE_BYTES = 1024 * 1024; // 1 MB
const SCHEMA_VERSION = '2';

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

function sha1(s) {
  return crypto.createHash('sha1').update(String(s || '')).digest('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function loadIgnorePatterns(cwd) {
  const pats = [];
  for (const fname of ['.gitignore', '.akronignore']) {
    const fp = path.join(cwd, fname);
    try {
      if (!fs.existsSync(fp)) continue;
      for (const raw of fs.readFileSync(fp, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#') || line.startsWith('!')) continue;
        pats.push(line.replace(/^\.\//, '').replace(/\/+$/, ''));
      }
    } catch (_) {}
  }
  return pats;
}

function isIgnored(relPath, patterns) {
  const norm = relPath.replace(/\\/g, '/');
  for (const pat of patterns) {
    if (!pat) continue;
    if (pat.startsWith('*.')) {
      if (norm.endsWith(pat.slice(1))) return true;
      continue;
    }
    if (norm === pat || norm.startsWith(pat + '/') || norm.split('/').includes(pat)) return true;
  }
  return false;
}

function extractSymbolsAndImports(content, filePathOrExt = '.js') {
  return astChunker.parseFile(content, filePathOrExt);
}

function tokenize(text) {
  return embedder.splitCodeTokens(text);
}

function dbPathFor(cwd, indexDir = INDEX_DIR) {
  return path.join(indexDir, `${sha1(path.resolve(cwd))}.db`);
}

function ensureSchema(db) {
  let ver = '';
  try {
    const m = db.prepare("SELECT value FROM meta WHERE key = 'schema_version' LIMIT 1");
    if (m.step()) ver = String(m.getAsObject().value || '');
    m.free();
  } catch (_) {}

  if (ver && ver !== SCHEMA_VERSION) {
    try {
      db.run('DROP TABLE IF EXISTS chunks; DROP TABLE IF EXISTS files;');
    } catch (_) {}
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      symbols_json TEXT NOT NULL,
      imports_json TEXT NOT NULL,
      exports_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      symbol TEXT NOT NULL DEFAULT '',
      breadcrumb TEXT NOT NULL DEFAULT '',
      calls_json TEXT NOT NULL DEFAULT '[]',
      chunk_sha256 TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL,
      vec_json TEXT NOT NULL,
      dense_vec_json TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
    CREATE TABLE IF NOT EXISTS embedding_cache (
      chunk_sha256 TEXT NOT NULL,
      model TEXT NOT NULL,
      vec_json TEXT NOT NULL,
      PRIMARY KEY (chunk_sha256, model)
    );
  `);
  db.run("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", [SCHEMA_VERSION]);
}

function saveDbAtomic(db, dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const data = Buffer.from(db.export());
  const tmp = `${dbFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, dbFile);
}

async function indexWorkspace(cwd, { indexDir = INDEX_DIR, maxFiles = 15000, embedConfig = null, fetchImpl = null } = {}) {
  const root = path.resolve(cwd || process.cwd());
  const SQL = await getSqlJs();
  const dbFile = dbPathFor(root, indexDir);
  let db;
  if (fs.existsSync(dbFile)) {
    try { db = new SQL.Database(fs.readFileSync(dbFile)); } catch (_) { db = new SQL.Database(); }
  } else {
    db = new SQL.Database();
  }
  ensureSchema(db);

  const ignorePatterns = loadIgnorePatterns(root);
  const existing = new Map();
  const stmt = db.prepare('SELECT path, sha256, mtime_ms FROM files');
  while (stmt.step()) {
    const row = stmt.getAsObject();
    existing.set(row.path, row);
  }
  stmt.free();

  const seenPaths = new Set();
  const fileHashesForMerkle = [];
  let indexed = 0;
  let skippedUnchanged = 0;
  const newlyAddedChunks = []; // { filePath, chunkSha, text }

  const walk = (dir, relBase) => {
    if (seenPaths.size >= maxFiles) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const ent of entries) {
      if (seenPaths.size >= maxFiles) return;
      if (ent.name === '.git' || ent.name === '.' || ent.name === '..') continue;
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (isIgnored(rel, ignorePatterns)) continue;
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(abs, rel);
      } else if (ent.isFile()) {
        if (!TEXT_EXT.test(ent.name)) continue;
        let st;
        try { st = fs.statSync(abs); } catch (_) { continue; }
        if (st.size > MAX_FILE_BYTES) continue;
        seenPaths.add(rel);
        const mtime = Math.floor(st.mtimeMs);
        const prev = existing.get(rel);
        if (prev && prev.mtime_ms === mtime) {
          skippedUnchanged++;
          fileHashesForMerkle.push(`${rel}:${prev.sha256}`);
          continue;
        }
        let buf;
        try { buf = fs.readFileSync(abs); } catch (_) { continue; }
        const hash = sha256(buf);
        fileHashesForMerkle.push(`${rel}:${hash}`);
        if (prev && prev.sha256 === hash) {
          db.run('UPDATE files SET mtime_ms = ? WHERE path = ?', [mtime, rel]);
          skippedUnchanged++;
          continue;
        }
        const content = buf.toString('utf8');
        const parsed = astChunker.parseFile(content, rel);
        const chunks = parsed.chunks && parsed.chunks.length
          ? parsed.chunks
          : [{
              startLine: 1,
              endLine: Math.max(1, parsed.lines.length),
              symbol: '',
              breadcrumb: '',
              calls: [],
              text: content.slice(0, 4800),
              sha256: sha256(Buffer.from(content.slice(0, 4800))),
            }];

        db.run(
          'INSERT OR REPLACE INTO files (path, sha256, mtime_ms, symbols_json, imports_json, exports_json) VALUES (?, ?, ?, ?, ?, ?)',
          [rel, hash, mtime, JSON.stringify(parsed.symbols), JSON.stringify(parsed.imports), JSON.stringify(parsed.exports)]
        );
        db.run('DELETE FROM chunks WHERE file_path = ?', [rel]);
        for (const ch of chunks) {
          const embedText = ch.breadcrumb ? `${rel} ${ch.breadcrumb}\n${ch.text}` : `${rel}\n${ch.text}`;
          const vec = embedder.embedSparse384(embedText);
          db.run(
            'INSERT INTO chunks (file_path, start_line, end_line, symbol, breadcrumb, calls_json, chunk_sha256, text, vec_json, dense_vec_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [
              rel,
              ch.startLine,
              ch.endLine,
              ch.symbol || '',
              ch.breadcrumb || '',
              JSON.stringify(ch.calls || []),
              ch.sha256 || '',
              ch.text,
              JSON.stringify(vec),
              '',
            ]
          );
          if (ch.sha256) newlyAddedChunks.push({ sha: ch.sha256, text: embedText });
        }
        indexed++;
      }
    }
  };

  walk(root, '');

  let removed = 0;
  for (const oldPath of existing.keys()) {
    if (!seenPaths.has(oldPath)) {
      db.run('DELETE FROM files WHERE path = ?', [oldPath]);
      db.run('DELETE FROM chunks WHERE file_path = ?', [oldPath]);
      removed++;
    }
  }

  // Optional dense embedding pass: cache hit by (chunk_sha256, model), zero re-embedding for unchanged chunks.
  let denseEmbeddedCount = 0;
  const resolvedEmbed = embedder.resolveEmbedConfig(embedConfig);
  if (resolvedEmbed && resolvedEmbed.enabled) {
    const modelId = resolvedEmbed.model;
    const toCompute = new Map(); // sha -> text
    const pendingRows = [];
    const cStmt = db.prepare('SELECT id, file_path, breadcrumb, chunk_sha256, text, dense_vec_json FROM chunks');
    while (cStmt.step()) {
      const r = cStmt.getAsObject();
      if (!r.chunk_sha256) continue;
      pendingRows.push(r);
    }
    cStmt.free();

    const cacheMap = new Map();
    const ecStmt = db.prepare('SELECT chunk_sha256, vec_json FROM embedding_cache WHERE model = ?');
    ecStmt.bind([modelId]);
    while (ecStmt.step()) {
      const r = ecStmt.getAsObject();
      cacheMap.set(r.chunk_sha256, r.vec_json);
    }
    ecStmt.free();

    for (const r of pendingRows) {
      if (cacheMap.has(r.chunk_sha256)) {
        if (!r.dense_vec_json) {
          db.run('UPDATE chunks SET dense_vec_json = ? WHERE id = ?', [cacheMap.get(r.chunk_sha256), r.id]);
        }
        denseEmbeddedCount++;
      } else if (!toCompute.has(r.chunk_sha256)) {
        const embedText = r.breadcrumb ? `${r.file_path} ${r.breadcrumb}\n${r.text}` : `${r.file_path}\n${r.text}`;
        toCompute.set(r.chunk_sha256, embedText);
      }
    }

    if (toCompute.size > 0) {
      const entries = [...toCompute.entries()];
      const denseVecs = await embedder.embedDenseBatch(
        entries.map(([, txt]) => txt),
        { embedConfig: resolvedEmbed, fetchImpl }
      );
      for (let i = 0; i < entries.length; i++) {
        const vec = denseVecs[i];
        if (!vec || !vec.length) continue;
        const chunkSha = entries[i][0];
        const vecStr = JSON.stringify(vec);
        db.run('INSERT OR REPLACE INTO embedding_cache (chunk_sha256, model, vec_json) VALUES (?, ?, ?)', [chunkSha, modelId, vecStr]);
        db.run('UPDATE chunks SET dense_vec_json = ? WHERE chunk_sha256 = ?', [vecStr, chunkSha]);
        denseEmbeddedCount += pendingRows.filter((r) => r.chunk_sha256 === chunkSha).length;
      }
    }
  }

  fileHashesForMerkle.sort();
  const merkleRoot = sha1(fileHashesForMerkle.join('\n'));
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['merkle_root', merkleRoot]);
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['cwd', root]);
  saveDbAtomic(db, dbFile);
  db.close();

  return {
    ok: true,
    schemaVersion: Number(SCHEMA_VERSION),
    cwd: root,
    dbFile,
    merkleRoot,
    totalFiles: seenPaths.size,
    indexed,
    skippedUnchanged,
    removed,
    denseEmbeddedCount,
  };
}

async function searchCodebase(cwd, query, { indexDir = INDEX_DIR, limit = 12, embedConfig = null, fetchImpl = null } = {}) {
  const root = path.resolve(cwd || process.cwd());
  const q = String(query || '').trim();
  if (!q) return { ok: true, schemaVersion: Number(SCHEMA_VERSION), hits: [] };

  const stats = await indexWorkspace(root, { indexDir, embedConfig, fetchImpl });
  const SQL = await getSqlJs();
  const db = new SQL.Database(fs.readFileSync(stats.dbFile));

  const qTokens = tokenize(q);
  const qVec = embedder.embedSparse384(q);
  const qLower = q.toLowerCase();

  let qDense = null;
  const resolvedEmbed = embedder.resolveEmbedConfig(embedConfig);
  if (resolvedEmbed && resolvedEmbed.enabled) {
    const dv = await embedder.embedDenseBatch([q], { embedConfig: resolvedEmbed, fetchImpl });
    if (dv && dv[0]) qDense = dv[0];
  }

  // Symbol/import/export index
  const fileMeta = new Map();
  const symbolHitsByFile = new Map();
  const fStmt = db.prepare('SELECT path, symbols_json, imports_json, exports_json FROM files');
  while (fStmt.step()) {
    const r = fStmt.getAsObject();
    let syms = [];
    let imps = [];
    let exps = [];
    try { syms = JSON.parse(r.symbols_json); } catch (_) {}
    try { imps = JSON.parse(r.imports_json); } catch (_) {}
    try { exps = JSON.parse(r.exports_json || '[]'); } catch (_) {}
    fileMeta.set(r.path, { syms, imps, exps });
    const matched = syms.filter((s) => {
      const nl = String(s.name || '').toLowerCase();
      return nl.includes(qLower) || qTokens.some((t) => nl.includes(t));
    });
    if (matched.length) symbolHitsByFile.set(r.path, matched);
  }
  fStmt.free();

  // Load chunks
  const allChunks = [];
  const docFreq = new Map();
  const cStmt = db.prepare('SELECT id, file_path, start_line, end_line, symbol, breadcrumb, calls_json, text, vec_json, dense_vec_json FROM chunks');
  while (cStmt.step()) {
    const r = cStmt.getAsObject();
    const toks = tokenize(`${r.file_path} ${r.breadcrumb} ${r.text}`);
    const seen = new Set(toks);
    for (const qt of qTokens) {
      if (seen.has(qt)) docFreq.set(qt, (docFreq.get(qt) || 0) + 1);
    }
    let vec = [];
    let denseVec = null;
    let calls = [];
    try { vec = JSON.parse(r.vec_json); } catch (_) {}
    try { if (r.dense_vec_json) denseVec = JSON.parse(r.dense_vec_json); } catch (_) {}
    try { calls = JSON.parse(r.calls_json || '[]'); } catch (_) {}
    allChunks.push({ ...r, toks, vec, denseVec, calls });
  }
  cStmt.free();
  db.close();

  const N = Math.max(1, allChunks.length);
  const avgLen = allChunks.reduce((n, c) => n + c.toks.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;

  for (const ch of allChunks) {
    let bm25 = 0;
    const tfMap = new Map();
    for (const t of ch.toks) tfMap.set(t, (tfMap.get(t) || 0) + 1);
    for (const qt of qTokens) {
      const tf = tfMap.get(qt) || 0;
      if (!tf) continue;
      const df = docFreq.get(qt) || 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      bm25 += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (ch.toks.length / avgLen))));
    }
    ch._bm25 = bm25;
    ch._sparseCos = Math.max(0, embedder.cosineSimilarity(qVec, ch.vec));
    ch._denseCos = (qDense && ch.denseVec) ? Math.max(0, embedder.cosineSimilarity(qDense, ch.denseVec)) : 0;

    const symLower = String(ch.symbol || '').toLowerCase();
    const breadLower = String(ch.breadcrumb || '').toLowerCase();
    const syms = symbolHitsByFile.get(ch.file_path) || [];
    const exactSymbol = symLower && (symLower === qLower || breadLower.endsWith(`> ${qLower}`));
    const symInRange = syms.some((s) => s.line >= ch.start_line && s.line <= ch.end_line);
    const callHit = ch.calls.some((c) => c.toLowerCase() === qLower || qTokens.includes(c.toLowerCase()));
    const exactPhrase = ch.text.toLowerCase().includes(qLower);

    let boost = 0;
    if (exactSymbol) boost += 4.0;
    else if (symInRange) boost += 2.6;
    else if (syms.length) boost += 0.8;
    if (callHit) boost += 0.9;
    if (exactPhrase) boost += 2.2;
    ch._boost = boost;
  }

  // Build ranked lists for Reciprocal Rank Fusion (RRF, k = 60)
  const rrfK = 60;
  const bm25Order = allChunks.filter((c) => c._bm25 > 0).sort((a, z) => z._bm25 - a._bm25);
  const sparseOrder = allChunks.filter((c) => c._sparseCos > 0.04).sort((a, z) => z._sparseCos - a._sparseCos);
  const denseOrder = qDense ? allChunks.filter((c) => c._denseCos > 0.05).sort((a, z) => z._denseCos - a._denseCos) : [];

  const rrfScores = new Map();
  const addRankList = (list, weight) => {
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      rrfScores.set(ch, (rrfScores.get(ch) || 0) + weight / (rrfK + i + 1));
    }
  };
  addRankList(bm25Order, 1.0);
  addRankList(sparseOrder, 0.9);
  if (denseOrder.length) addRankList(denseOrder, 1.35);

  const scored = [];
  for (const ch of allChunks) {
    const rrf = (rrfScores.get(ch) || 0) * 100;
    const total = rrf + ch._bm25 * 0.45 + ch._sparseCos * 1.5 + ch._denseCos * 3.0 + ch._boost;
    if (total <= 0.35 && ch._bm25 === 0 && ch._boost === 0 && ch._denseCos < 0.25 && ch._sparseCos < 0.2) continue;

    const meta = fileMeta.get(ch.file_path) || { syms: [], imps: [], exps: [] };
    const syms = symbolHitsByFile.get(ch.file_path) || meta.syms || [];
    scored.push({
      file: ch.file_path,
      startLine: ch.start_line,
      endLine: ch.end_line,
      score: Number(total.toFixed(3)),
      symbol: ch.symbol || '',
      breadcrumb: ch.breadcrumb || '',
      symbols: syms.slice(0, 6),
      imports: (meta.imps || []).slice(0, 8),
      exports: (meta.exps || []).slice(0, 8),
      calls: ch.calls.slice(0, 8),
      snippet: ch.text.split('\n').slice(0, 12).join('\n'),
    });
  }

  scored.sort((a, b2) => b2.score - a.score);
  return {
    ok: true,
    schemaVersion: Number(SCHEMA_VERSION),
    merkleRoot: stats.merkleRoot,
    totalFiles: stats.totalFiles,
    denseEmbeddedCount: stats.denseEmbeddedCount || 0,
    hits: scored.slice(0, limit),
  };
}

module.exports = {
  INDEX_DIR,
  MAX_FILE_BYTES,
  VECTOR_DIM: embedder.VECTOR_DIM,
  dbPathFor,
  indexWorkspace,
  searchCodebase,
  extractSymbolsAndImports,
};
