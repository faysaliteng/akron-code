'use strict';

const fs = require('fs');
const path = require('path');

function normalizePunctuation(s) {
  return String(s || '')
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ');
}

// 4-tier fuzzy line-sequence matcher: exact -> trimEnd -> trim -> normalized punctuation
function seekSequence(lines, pattern, startIdx = 0) {
  if (!pattern.length) return Math.max(0, Math.min(startIdx, lines.length));
  if (pattern.length > lines.length) return -1;

  const tiers = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
    (a, b) => normalizePunctuation(a) === normalizePunctuation(b),
  ];

  const maxStart = lines.length - pattern.length;
  for (const eq of tiers) {
    for (let i = Math.max(0, startIdx); i <= maxStart; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j], pattern[j])) { ok = false; break; }
      }
      if (ok) return i;
    }
    for (let i = 0; i < Math.max(0, startIdx) && i <= maxStart; i++) {
      let ok = true;
      for (let j = 0; j < pattern.length; j++) {
        if (!eq(lines[i + j], pattern[j])) { ok = false; break; }
      }
      if (ok) return i;
    }
  }
  return -1;
}

function parseChunks(lines, startIdx) {
  const chunks = [];
  let i = startIdx;
  let current = null;

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = null;
    }
  };

  while (i < lines.length) {
    const ln = lines[i];
    if (ln.startsWith('*** End Patch') || ln.startsWith('*** Add File:') || ln.startsWith('*** Delete File:') || ln.startsWith('*** Update File:')) {
      break;
    }
    if (ln.startsWith('@@')) {
      flush();
      current = { contextHint: ln.slice(2).trim(), lines: [] };
      i++;
      continue;
    }
    if (ln.startsWith('*** End of File')) {
      if (current) current.eof = true;
      i++;
      continue;
    }
    if (!current) current = { contextHint: '', lines: [] };
    if (ln.startsWith('+') || ln.startsWith('-') || ln.startsWith(' ')) {
      current.lines.push({ op: ln[0], text: ln.slice(1) });
    } else {
      current.lines.push({ op: ' ', text: ln });
    }
    i++;
  }
  flush();
  return { chunks, nextIdx: i };
}

function parsePatch(patchText) {
  const raw = String(patchText || '').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');
  const hunks = [];

  if (lines.some((l) => l.trim() === '*** Begin Patch')) {
    let i = lines.findIndex((l) => l.trim() === '*** Begin Patch') + 1;
    while (i < lines.length) {
      const ln = lines[i];
      if (ln.trim() === '*** End Patch') break;
      if (ln.startsWith('*** Add File:')) {
        const filePath = ln.slice('*** Add File:'.length).trim();
        i++;
        const addLines = [];
        while (i < lines.length && !lines[i].startsWith('*** ')) {
          const l = lines[i];
          addLines.push(l.startsWith('+') ? l.slice(1) : l);
          i++;
        }
        hunks.push({ type: 'add', path: filePath, content: addLines.join('\n') });
        continue;
      }
      if (ln.startsWith('*** Delete File:')) {
        const filePath = ln.slice('*** Delete File:'.length).trim();
        hunks.push({ type: 'delete', path: filePath });
        i++;
        continue;
      }
      if (ln.startsWith('*** Update File:')) {
        const filePath = ln.slice('*** Update File:'.length).trim();
        i++;
        let moveTo = null;
        if (i < lines.length && lines[i].startsWith('*** Move to:')) {
          moveTo = lines[i].slice('*** Move to:'.length).trim();
          i++;
        }
        const parsed = parseChunks(lines, i);
        i = parsed.nextIdx;
        hunks.push({ type: 'update', path: filePath, moveTo, chunks: parsed.chunks });
        continue;
      }
      i++;
    }
    return { ok: hunks.length > 0, hunks };
  }

  // Fallback: standard unified diff (`--- a/...` + `+++ b/...`)
  let i = 0;
  while (i < lines.length) {
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      const oldP = lines[i].slice(4).trim().replace(/^a\//, '');
      const newP = lines[i + 1].slice(4).trim().replace(/^b\//, '');
      i += 2;
      const chunks = [];
      let cur = null;
      while (i < lines.length && !lines[i].startsWith('--- ')) {
        const ln = lines[i];
        if (ln.startsWith('@@')) {
          if (cur) chunks.push(cur);
          cur = { contextHint: '', lines: [] };
        } else if (cur && (ln.startsWith('+') || ln.startsWith('-') || ln.startsWith(' '))) {
          cur.lines.push({ op: ln[0], text: ln.slice(1) });
        }
        i++;
      }
      if (cur) chunks.push(cur);
      if (oldP === '/dev/null') {
        const addContent = chunks.flatMap((c) => c.lines.filter((x) => x.op === '+').map((x) => x.text)).join('\n');
        hunks.push({ type: 'add', path: newP, content: addContent });
      } else if (newP === '/dev/null') {
        hunks.push({ type: 'delete', path: oldP });
      } else {
        hunks.push({ type: 'update', path: oldP, moveTo: oldP !== newP ? newP : null, chunks });
      }
      continue;
    }
    i++;
  }
  return { ok: hunks.length > 0, hunks };
}

function applyChunksToText(originalText, chunks, fileLabel) {
  const hadTrailingNewline = originalText.endsWith('\n');
  let lines = originalText.split('\n');
  if (hadTrailingNewline && lines[lines.length - 1] === '') lines.pop();

  let cursor = 0;
  let added = 0;
  let removed = 0;

  for (let cIdx = 0; cIdx < chunks.length; cIdx++) {
    const ch = chunks[cIdx];
    const oldSeq = ch.lines.filter((x) => x.op === ' ' || x.op === '-').map((x) => x.text);
    const newSeq = ch.lines.filter((x) => x.op === ' ' || x.op === '+').map((x) => x.text);
    added += ch.lines.filter((x) => x.op === '+').length;
    removed += ch.lines.filter((x) => x.op === '-').length;

    let searchStart = cursor;
    if (ch.contextHint) {
      const hintPos = seekSequence(lines, [ch.contextHint], 0);
      if (hintPos >= 0) searchStart = hintPos;
    }
    if (ch.eof && oldSeq.length) {
      searchStart = Math.max(0, lines.length - oldSeq.length);
    }

    if (!oldSeq.length) {
      const insertAt = ch.eof ? lines.length : cursor;
      lines.splice(insertAt, 0, ...newSeq);
      cursor = insertAt + newSeq.length;
      continue;
    }

    const pos = seekSequence(lines, oldSeq, searchStart);
    if (pos < 0) {
      return {
        ok: false,
        error: `Patch failed in ${fileLabel}: could not locate hunk #${cIdx + 1} starting with ${JSON.stringify(oldSeq[0] || '')}`,
      };
    }
    lines.splice(pos, oldSeq.length, ...newSeq);
    cursor = pos + newSeq.length;
  }

  let nextText = lines.join('\n');
  if (hadTrailingNewline && !nextText.endsWith('\n')) nextText += '\n';
  return { ok: true, content: nextText, added, removed };
}

function applyPatchToWorkspace({
  patch,
  cwd,
  resolvePath = (p, d) => (path.isAbsolute(p) ? p : path.resolve(d || process.cwd(), p)),
  readMtimes = null,
  sandboxMod = null,
  editGuard = null,
  takeCheckpoint = null,
} = {}) {
  const parsed = parsePatch(patch);
  if (!parsed.ok) {
    return {
      ok: false,
      error: 'Invalid or empty patch. Expected Codex V4A format (`*** Begin Patch` ... `*** End Patch`) or unified diff.',
    };
  }

  // Stage 1: Validate every operation in memory before mutating any file (all-or-nothing)
  const ops = [];
  for (const h of parsed.hunks) {
    let absPath;
    try {
      absPath = resolvePath(h.path, cwd);
    } catch (e) {
      return { ok: false, error: `Invalid patch path "${h.path}": ${e.message}` };
    }
    if (sandboxMod) {
      const wr = sandboxMod.isWriteAllowed(absPath);
      if (wr !== true) return { ok: false, error: wr.reason || `Write blocked for ${absPath}` };
    }

    if (h.type === 'add') {
      ops.push({ type: 'add', absPath, relPath: h.path, content: h.content, added: h.content.split('\n').length, removed: 0 });
    } else if (h.type === 'delete') {
      if (!fs.existsSync(absPath)) {
        return { ok: false, error: `Delete failed: ${absPath} does not exist.` };
      }
      if (editGuard) {
        const stale = editGuard.checkStaleRead(readMtimes, absPath);
        if (!stale.ok) return { ok: false, error: stale.error };
      }
      ops.push({ type: 'delete', absPath, relPath: h.path, added: 0, removed: 1 });
    } else if (h.type === 'update') {
      if (!fs.existsSync(absPath)) {
        return { ok: false, error: `Update failed: ${absPath} does not exist.` };
      }
      if (editGuard) {
        const stale = editGuard.checkStaleRead(readMtimes, absPath);
        if (!stale.ok) return { ok: false, error: stale.error };
      }
      const orig = fs.readFileSync(absPath, 'utf8');
      const applied = applyChunksToText(orig, h.chunks || [], h.path);
      if (!applied.ok) return applied;
      let destPath = absPath;
      if (h.moveTo) {
        destPath = resolvePath(h.moveTo, cwd);
        if (sandboxMod) {
          const wr2 = sandboxMod.isWriteAllowed(destPath);
          if (wr2 !== true) return { ok: false, error: wr2.reason || `Write blocked for ${destPath}` };
        }
      }
      ops.push({
        type: 'update',
        absPath,
        destPath,
        relPath: h.moveTo || h.path,
        content: applied.content,
        added: applied.added,
        removed: applied.removed,
      });
    }
  }

  // Stage 2: Checkpoints + commit all disk mutations
  const summaries = [];
  const diags = [];
  for (const op of ops) {
    if (typeof takeCheckpoint === 'function') {
      try { takeCheckpoint(op.absPath); } catch (_) {}
      if (op.destPath && op.destPath !== op.absPath) {
        try { takeCheckpoint(op.destPath); } catch (_) {}
      }
    }
    if (op.type === 'add') {
      fs.mkdirSync(path.dirname(op.absPath), { recursive: true });
      fs.writeFileSync(op.absPath, op.content, 'utf8');
      if (editGuard) {
        editGuard.recordFileRead(readMtimes, op.absPath);
        const d = editGuard.collectPostEditDiagnostics(op.absPath, cwd);
        if (d) diags.push(d.trim());
      }
      summaries.push(`A ${op.relPath} (+${op.added})`);
    } else if (op.type === 'delete') {
      fs.unlinkSync(op.absPath);
      if (readMtimes instanceof Map) readMtimes.delete(op.absPath);
      summaries.push(`D ${op.relPath}`);
    } else if (op.type === 'update') {
      const writePath = op.destPath || op.absPath;
      fs.mkdirSync(path.dirname(writePath), { recursive: true });
      fs.writeFileSync(writePath, op.content, 'utf8');
      if (writePath !== op.absPath && fs.existsSync(op.absPath)) {
        fs.unlinkSync(op.absPath);
        if (readMtimes instanceof Map) readMtimes.delete(op.absPath);
      }
      if (editGuard) {
        editGuard.recordFileRead(readMtimes, writePath);
        const d = editGuard.collectPostEditDiagnostics(writePath, cwd);
        if (d) diags.push(d.trim());
      }
      summaries.push(`M ${op.relPath} (+${op.added} -${op.removed})`);
    }
  }

  const out = `Success. Applied patch to ${ops.length} file${ops.length === 1 ? '' : 's'}:\n` + summaries.join('\n')
    + (diags.length ? '\n\n' + diags.join('\n') : '');
  return { ok: true, count: ops.length, summaries, content: out };
}

module.exports = {
  parsePatch,
  seekSequence,
  applyChunksToText,
  applyPatchToWorkspace,
};
