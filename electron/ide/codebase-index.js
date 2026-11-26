'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INDEX_DIR = path.join(os.homedir(), '.autobot', 'indexes');
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'release', 'out', '.next', '.nuxt',
  '.cache', 'coverage', 'venv', '.venv', '__pycache__', 'target', 'vendor',
]);
const TEXT_EXT = /\.(js|jsx|mjs|cjs|ts|tsx|py|go|rs|java|kt|swift|c|cpp|h|hpp|rb|php|css|scss|html|md|json|yaml|yml|toml|sql|sh)$/i;
const MAX_FILE_BYTES = 256 * 1024;
const VECTOR_DIM = 128;

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

function extractSymbolsAndImports(content) {
  const lines = content.split(/\r?\n/);
  const symbols = [];
  const imports = [];
  const patterns = [
    { kind: 'function', re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/ },
    { kind: 'class', re: /^\s*(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: 'interface', re: /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b/ },
    { kind: 'type', re: /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/ },
    { kind: 'const', re: /^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/ },
    { kind: 'def', re: /^\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/ },
    { kind: 'func', re: /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z_][\w]*)\s*\(/ },
    { kind: 'struct', re: /^\s*(?:pub\s+)?struct\s+([A-Za-z_][\w]*)\b/ },
  ];

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    for (const p of patterns) {
      const m = p.re.exec(ln);
      if (m) {
        symbols.push({ name: m[1], kind: p.kind, line: i + 1 });
        break;
      }
    }
    const imp = /^\s*(?:import\s+.*from\s+['"]([^'"]+)['"]|const\s+.*=\s*require\(['"]([^'"]+)['"]\))/.exec(ln);
    if (imp) imports.push(imp[1] || imp[2]);
  }
  return { symbols, imports, lines };
}

function chunkLines(lines, chunkSize = 55, overlap = 10) {
  const chunks = [];
  const step = Math.max(10, chunkSize - overlap);
  for (let i = 0; i < lines.length; i += step) {
    const slice = lines.slice(i, i + chunkSize).join('\n').trim();
    if (!slice) continue;
    chunks.push({ startLine: i + 1, endLine: Math.min(lines.length, i + chunkSize), text: slice.slice(0, 3200) });
    if (i + chunkSize >= lines.length) break;
  }
  return chunks;
}

function tokenize(text) {
  return String(text || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 2);
}

function embedVector(tokens) {
  const vec = new Float32Array(VECTOR_DIM);
  for (const tok of tokens) {
    const idx = Math.abs(tok.split('').reduce((h, c) => ((h * 31) + c.charCodeAt(0)) | 0, 0)) % VECTOR_DIM;
    vec[idx] += 1;
  }
  let norm = 0;
  for (let i = 0; i < VECTOR_DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function dbPathFor(cwd, indexDir = INDEX_DIR) {
  return path.join(indexDir, `${sha1(path.resolve(cwd))}.db`);
}

function ensureSchema(db) {
  db.run(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      sha256 TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      symbols_json TEXT NOT NULL,
      imports_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_path TEXT NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      text TEXT NOT NULL,
      vec_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_path);
  `);
}

function saveDbAtomic(db, dbFile) {
  fs.mkdirSync(path.dirname(dbFile), { recursive: true, mode: 0o700 });
  const data = Buffer.from(db.export());
  const tmp = `${dbFile}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, dbFile);
}

async function indexWorkspace(cwd, { indexDir = INDEX_DIR, maxFiles = 15000 } = {}) {
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
        const parsed = extractSymbolsAndImports(content);
        const chunks = chunkLines(parsed.lines);
        db.run(
          'INSERT OR REPLACE INTO files (path, sha256, mtime_ms, symbols_json, imports_json) VALUES (?, ?, ?, ?, ?)',
          [rel, hash, mtime, JSON.stringify(parsed.symbols), JSON.stringify(parsed.imports)]
        );
        db.run('DELETE FROM chunks WHERE file_path = ?', [rel]);
        for (const ch of chunks) {
          const vec = embedVector(tokenize(ch.text));
          db.run(
            'INSERT INTO chunks (file_path, start_line, end_line, text, vec_json) VALUES (?, ?, ?, ?, ?)',
            [rel, ch.startLine, ch.endLine, ch.text, JSON.stringify(vec)]
          );
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

  fileHashesForMerkle.sort();
  const merkleRoot = sha1(fileHashesForMerkle.join('\n'));
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['merkle_root', merkleRoot]);
  db.run('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)', ['cwd', root]);
  saveDbAtomic(db, dbFile);
  db.close();

  return {
    ok: true,
    cwd: root,
    dbFile,
    merkleRoot,
    totalFiles: seenPaths.size,
    indexed,
    skippedUnchanged,
    removed,
  };
}

async function searchCodebase(cwd, query, { indexDir = INDEX_DIR, limit = 12 } = {}) {
  const root = path.resolve(cwd || process.cwd());
  const q = String(query || '').trim();
  if (!q) return { ok: true, hits: [] };

  const stats = await indexWorkspace(root, { indexDir });
  const SQL = await getSqlJs();
  const db = new SQL.Database(fs.readFileSync(stats.dbFile));

  const qTokens = tokenize(q);
  const qVec = embedVector(qTokens);
  const qLower = q.toLowerCase();

  // Symbol-name boost index
  const symbolHitsByFile = new Map();
  const fStmt = db.prepare('SELECT path, symbols_json FROM files');
  while (fStmt.step()) {
    const r = fStmt.getAsObject();
    let syms = [];
    try { syms = JSON.parse(r.symbols_json); } catch (_) {}
    const matched = syms.filter((s) => {
      const nl = s.name.toLowerCase();
      return nl.includes(qLower) || qTokens.some((t) => nl.includes(t));
    });
    if (matched.length) symbolHitsByFile.set(r.path, matched);
  }
  fStmt.free();

  // BM25-style TF + cosine vector ranking across chunks
  const allChunks = [];
  const docFreq = new Map();
  const cStmt = db.prepare('SELECT file_path, start_line, end_line, text, vec_json FROM chunks');
  while (cStmt.step()) {
    const r = cStmt.getAsObject();
    const toks = tokenize(r.text);
    const seen = new Set(toks);
    for (const qt of qTokens) {
      if (seen.has(qt)) docFreq.set(qt, (docFreq.get(qt) || 0) + 1);
    }
    allChunks.push({ ...r, toks });
  }
  cStmt.free();
  db.close();

  const N = Math.max(1, allChunks.length);
  const avgLen = allChunks.reduce((n, c) => n + c.toks.length, 0) / N || 1;
  const k1 = 1.5;
  const b = 0.75;

  const scored = [];
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
    let vec = [];
    try { vec = JSON.parse(ch.vec_json); } catch (_) {}
    const cos = cosineSim(qVec, vec);
    const syms = symbolHitsByFile.get(ch.file_path) || [];
    const symBoost = syms.some((s) => s.line >= ch.start_line && s.line <= ch.end_line) ? 3.0 : (syms.length ? 1.0 : 0);
    const exactPhrase = ch.text.toLowerCase().includes(qLower) ? 2.5 : 0;
    const score = bm25 + cos * 2.0 + symBoost + exactPhrase;
    if (score > 0.2) {
      scored.push({
        file: ch.file_path,
        startLine: ch.start_line,
        endLine: ch.end_line,
        score: Number(score.toFixed(3)),
        symbols: syms.slice(0, 5),
        snippet: ch.text.split('\n').slice(0, 10).join('\n'),
      });
    }
  }

  scored.sort((a, b2) => b2.score - a.score);
  return {
    ok: true,
    merkleRoot: stats.merkleRoot,
    totalFiles: stats.totalFiles,
    hits: scored.slice(0, limit),
  };
}

module.exports = {
  INDEX_DIR,
  dbPathFor,
  indexWorkspace,
  searchCodebase,
  extractSymbolsAndImports,
};
