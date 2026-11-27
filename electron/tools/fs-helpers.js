'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ---------- Read helpers ----------
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINE = 2000;      // chars per line
const READ_MAX_CHARS = 100000;   // chars per Read call
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i;
const RASTER_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function quickSyntaxDiagnostic(fp) {
  try {
    const ext = path.extname(fp).toLowerCase();
    if (!['.json', '.cjs', '.mjs', '.js', '.py'].includes(ext)) return '';
    if (ext === '.json') {
      JSON.parse(fs.readFileSync(fp, 'utf8'));
      return '';
    }
    if (ext === '.js') {
      const sample = fs.readFileSync(fp, 'utf8').slice(0, 8000);
      const hasJsx = /<[A-Za-z][A-Za-z0-9.]*(\s|>|\/)/.test(sample)
        && (/from\s+['"]react['"]/.test(sample) || /require\(\s*['"]react['"]\s*\)/.test(sample) || /export\s+default\s+function/.test(sample) || /React\./.test(sample));
      if (hasJsx) return '';
    }
    if (ext === '.cjs' || ext === '.js') {
      const src = fs.readFileSync(fp, 'utf8');
      if (/^\s*(?:import\s+(?:[\w*{]|['"])|export\s+(?:default|const|let|var|async|function|class|\{|\*))/m.test(src)) {
        return '';
      }
      const vm = require('vm');
      new vm.Script(src.replace(/^#!.*\r?\n/, '\n'), { filename: fp });
      return '';
    }
    if (ext === '.mjs') {
      return '';
    }
    if (ext === '.py') {
      execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],"rb").read(), sys.argv[1])', fp], { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return '';
    }
    return '';
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ETIMEDOUT')) return '';
    const rawErr = String((e && (e.stderr || e.message)) || e || '').trim();
    const lines = rawErr.split('\n').filter((l) => !/^Node\.js v\d+/i.test(l.trim())).join('\n').trim();
    const errText = (lines || rawErr).slice(0, 400);
    if (!errText) return '';
    return `\n\n[SYNTAX WARNING in ${path.basename(fp)}]\n${errText}\nFix this syntax error immediately with Edit before running commands or finishing.`;
  }
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Jupyter notebooks: show cells + text outputs instead of raw JSON.
function renderNotebook(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch (_) { return null; }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const src = (v) => (Array.isArray(v) ? v.join('') : String(v || ''));
  return nb.cells.map((c, i) => {
    const id = c.id || String(i);
    let s = `<cell id="${id}" type="${c.cell_type || 'code'}">\n${src(c.source)}\n</cell>`;
    const outs = (c.outputs || []).map((o) => {
      if (o.text) return src(o.text);
      if (o.data && o.data['text/plain']) return src(o.data['text/plain']);
      if (o.ename) return `${o.ename}: ${o.evalue || ''}`;
      if (o.data) return `[${Object.keys(o.data).join(', ')} output]`;
      return '';
    }).filter(Boolean);
    if (outs.length) s += `\n<output>\n${outs.join('\n')}\n</output>`;
    return s;
  }).join('\n\n');
}

// `cat -n` style: 6-wide right-aligned line number, a tab, the line.
function formatNumbered(raw, fp, offset, limit, emptyMsg) {
  const text = String(raw == null ? '' : raw);
  if (!text) return emptyMsg;
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, parseInt(offset, 10) || 1);
  const lim = limit == null || limit === ''
    ? READ_DEFAULT_LINES
    : Math.max(1, Math.min(parseInt(limit, 10) || READ_DEFAULT_LINES, 50000));
  if (start > total) return `(offset ${start} is past the end of ${fp} — the file has ${total} lines)`;
  const end = Math.min(total, start - 1 + lim);
  const out = [];
  let size = 0;
  let last = start - 1;
  let capped = false;
  for (let i = start; i <= end; i++) {
    let l = lines[i - 1];
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l.length > READ_MAX_LINE) l = l.slice(0, READ_MAX_LINE) + '… [line truncated]';
    const row = String(i).padStart(6) + '\t' + l;
    if (out.length && size + row.length + 1 > READ_MAX_CHARS) { capped = true; break; }
    out.push(row);
    size += row.length + 1;
    last = i;
  }
  let s = out.join('\n');
  if (capped) {
    s += `\n…[output capped at ${READ_MAX_CHARS} characters — showing lines ${start}–${last} of ${total}; call Read with offset ${last + 1} to continue]`;
  } else if (last < total) {
    s += `\n…[${total - last} more lines — call Read with offset ${last + 1} to continue]`;
  }
  return s;
}


module.exports = {
  READ_DEFAULT_LINES, READ_MAX_LINE, READ_MAX_CHARS, IMAGE_EXT, RASTER_IMAGE_MIME,
  quickSyntaxDiagnostic, isBinaryBuffer, renderNotebook, formatNumbered,
};