'use strict';
/**
 * Transcript & workspace search — Desktop parity for the transcript-search worker.
 *
 * Two layers:
 *   1. Conversation text lives in the renderer (localStorage). The renderer
 *      searches it in-memory (`searchConversations` in App.jsx) — instant, no IPC.
 *   2. Everything on disk lives here: the conversation's project folder, notebooks,
 *      memory and checkpoints. ripgrep does the heavy lifting; policy from
 *      sandbox.js is applied so a denied path can never be searched.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const sandbox = require('./sandbox');
const { expandPath } = require('./paths');

const RG = 'rg';

function runRg(args, cwd) {
  return new Promise((resolve) => {
    execFile(RG, args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
      resolve(err && !stdout ? '' : String(stdout || ''));
    });
  });
}

function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Search files under a folder. Returns [{file, line, text, kind:'file'}]. */
async function searchFiles({ query, cwd, glob, limit = 80 }) {
  if (!query) return [];
  const root = path.resolve(expandPath(cwd) || process.cwd());
  const chk = sandbox.isReadAllowed(root);
  if (chk !== true) return [];
  if (!fs.existsSync(root)) return [];
  const args = ['--json', '--hidden', '-i', '-m', '3', '-g', '!node_modules', '-g', '!.git', '--', String(query), '.'];
  if (glob) args.splice(1, 0, '-g', glob);
  const out = await runRg(args, root);
  const hits = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'match') continue;
    const file = path.join(root, j.data.path.text || '');
    if (sandbox.isReadAllowed(file) !== true) continue;
    const text = (j.data.lines && j.data.lines.text ? j.data.lines.text : '').replace(/\n$/, '');
    hits.push({ kind: 'file', file, rel: path.relative(root, file), line: j.data.line_number, text: text.trim().slice(0, 400) });
    if (hits.length >= limit) break;
  }
  return hits;
}

/** Search notebooks (title + cell text) and memory entries. */
function searchRecords(query) {
  const q = String(query).toLowerCase();
  const hits = [];
  let names = [];
  try { names = store.listNotebooks() || []; } catch (_) {}
  for (const name of names) {
    let body = '';
    try { body = JSON.stringify(store.getNotebook(name) || ''); } catch (_) {}
    if (String(name).toLowerCase().includes(q) || body.toLowerCase().includes(q)) {
      let snippet = '';
      const idx = body.toLowerCase().indexOf(q);
      if (idx >= 0) snippet = body.slice(Math.max(0, idx - 80), idx + 160);
      hits.push({ kind: 'notebook', id: name, title: name, text: snippet || name });
    }
  }
  try {
    const entries = (store.getMemory() || {}).entries || [];
    for (const e of entries) {
      const text = typeof e === 'string' ? e : (e.content || e.text || JSON.stringify(e));
      if (String(text).toLowerCase().includes(q)) hits.push({ kind: 'memory', text: String(text).slice(0, 400) });
    }
  } catch (_) {}
  return hits;
}

/** Unified search across disk. */
async function searchAll({ query, cwd, glob, limit = 80 }) {
  if (!query) return { query, hits: [] };
  const [files, records] = await Promise.all([
    searchFiles({ query, cwd, glob, limit }),
    Promise.resolve(searchRecords(query)),
  ]);
  return { query, hits: [...files, ...records].slice(0, limit) };
}

module.exports = { searchFiles, searchRecords, searchAll };
