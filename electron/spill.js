'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SPILL_BYTES = 12 * 1024;
const HEAD_BYTES = 4096;
const HEAD_LINES = 60;
const TAIL_BYTES = 3072;
const TAIL_LINES = 45;
const SPILL_ROOT = path.join(os.homedir(), '.autobot', 'spills');

function sanitizeSegment(raw, fallback) {
  const s = String(raw || '').replace(/[^A-Za-z0-9_.-]/g, '_').replace(/_{2,}/g, '_').slice(0, 80);
  return s || fallback;
}

function sliceHead(text, maxBytes = HEAD_BYTES, maxLines = HEAD_LINES) {
  const lines = text.split('\n');
  const out = [];
  let bytes = 0;
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const ln = lines[i];
    const b = Buffer.byteLength(ln + '\n', 'utf8');
    if (bytes > 0 && bytes + b > maxBytes) break;
    out.push(ln);
    bytes += b;
  }
  if (!out.length && text) return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  return out.join('\n');
}

function sliceTail(text, maxBytes = TAIL_BYTES, maxLines = TAIL_LINES) {
  const lines = text.split('\n');
  const out = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0 && out.length < maxLines; i--) {
    const ln = lines[i];
    const b = Buffer.byteLength(ln + '\n', 'utf8');
    if (bytes > 0 && bytes + b > maxBytes) break;
    out.unshift(ln);
    bytes += b;
  }
  if (!out.length && text) {
    const buf = Buffer.from(text, 'utf8');
    return buf.subarray(Math.max(0, buf.length - maxBytes)).toString('utf8');
  }
  return out.join('\n');
}

function maybeSpillOutput(text, {
  convId = 'scratch',
  callId = '',
  toolName = 'tool',
  thresholdBytes = DEFAULT_SPILL_BYTES,
  spillRoot = SPILL_ROOT,
  skipSpill = false,
} = {}) {
  const str = String(text == null ? '' : text);
  if (skipSpill || !str) {
    return { spilled: false, text: str, bytes: Buffer.byteLength(str, 'utf8'), filePath: null };
  }
  const bytes = Buffer.byteLength(str, 'utf8');
  if (bytes <= thresholdBytes) {
    return { spilled: false, text: str, bytes, filePath: null };
  }

  const safeConv = sanitizeSegment(convId, 'scratch');
  const safeCall = sanitizeSegment(callId || `${toolName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, 'call');
  const dir = path.join(spillRoot, safeConv);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(spillRoot, 0o700); } catch (_) {}
  try { fs.chmodSync(dir, 0o700); } catch (_) {}

  const filePath = path.join(dir, `${safeCall}.txt`);
  fs.writeFileSync(filePath, str, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) {}

  const lineCount = str.split('\n').length;
  const head = sliceHead(str);
  const tail = sliceTail(str);
  const preview = [
    head,
    '',
    `--- [Output spilled to disk: ${bytes} bytes, ${lineCount} lines (${toolName}) -> ${filePath}] ---`,
    `To inspect omitted middle/full sections without re-running:`,
    `  Read {"path": ${JSON.stringify(filePath)}, "offset": 1, "limit": 120}`,
    `  Grep {"path": ${JSON.stringify(filePath)}, "pattern": "<regex>"}`,
    '',
    tail,
  ].join('\n');

  return { spilled: true, text: preview, bytes, lines: lineCount, filePath };
}

function pruneOldSpills({
  maxAgeMs = 7 * 24 * 60 * 60 * 1000,
  spillRoot = SPILL_ROOT,
  now = Date.now(),
} = {}) {
  let removedFiles = 0;
  let removedDirs = 0;
  if (!spillRoot || !fs.existsSync(spillRoot)) return { removedFiles, removedDirs };
  let convDirs;
  try { convDirs = fs.readdirSync(spillRoot, { withFileTypes: true }); } catch (_) { return { removedFiles, removedDirs }; }

  for (const ent of convDirs) {
    const sub = path.join(spillRoot, ent.name);
    if (ent.isFile()) {
      try {
        const st = fs.statSync(sub);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(sub);
          removedFiles++;
        }
      } catch (_) {}
      continue;
    }
    if (!ent.isDirectory()) continue;
    let files;
    try { files = fs.readdirSync(sub, { withFileTypes: true }); } catch (_) { continue; }
    for (const f of files) {
      if (!f.isFile()) continue;
      const fp = path.join(sub, f.name);
      try {
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > maxAgeMs) {
          fs.unlinkSync(fp);
          removedFiles++;
        }
      } catch (_) {}
    }
    try {
      if (fs.readdirSync(sub).length === 0) {
        fs.rmdirSync(sub);
        removedDirs++;
      }
    } catch (_) {}
  }
  return { removedFiles, removedDirs };
}

module.exports = {
  DEFAULT_SPILL_BYTES,
  SPILL_ROOT,
  maybeSpillOutput,
  pruneOldSpills,
  sanitizeSegment,
};
