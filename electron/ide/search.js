'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IGNORE_DIRS = new Set(['.git', 'node_modules', 'dist', 'release', 'build', '__pycache__', '.venv']);

function resolveRipgrep() {
  try {
    const { rgPath } = require('@vscode/ripgrep');
    if (rgPath) {
      const unpacked = rgPath.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(rgPath)) return rgPath;
    }
  } catch (_) {}
  const candidates = process.platform === 'win32'
    ? ['rg.exe']
    : ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return null;
}

function buildRegex(query, { isRegex, caseSensitive }) {
  const flags = caseSensitive ? 'g' : 'gi';
  if (isRegex) return new RegExp(query, flags);
  const esc = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(esc, flags);
}

function searchWithRipgrep(rgBin, opts) {
  const { cwd, query, isRegex, caseSensitive, includeGlob, excludeGlob, maxResults = 500 } = opts;
  return new Promise((resolve, reject) => {
    const args = ['--json', '--line-number', '--column', '--no-heading', '--max-count', '50', '--max-filesize', '1M'];
    if (!caseSensitive) args.push('-i');
    if (!isRegex) args.push('-F');
    if (includeGlob) args.push('--glob', String(includeGlob));
    if (excludeGlob) args.push('--glob', '!' + String(excludeGlob).replace(/^!/, ''));
    args.push('--glob', '!.git', '--glob', '!node_modules', '--glob', '!dist', '--glob', '!release');
    args.push('--', String(query), '.');

    const child = spawn(rgBin, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const matches = [];
    let truncated = false;
    let buf = '';
    let errText = '';

    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (_) { continue; }
        if (obj.type === 'match' && obj.data) {
          const d = obj.data;
          const rel = String((d.path && d.path.text) || '').replace(/^\.[\\/]/, '').replace(/\\/g, '/');
          const ln = Number(d.line_number) || 1;
          const sub = Array.isArray(d.submatches) && d.submatches[0];
          const col = sub ? (Number(sub.start) || 0) + 1 : 1;
          const text = String((d.lines && d.lines.text) || '').replace(/\r?\n$/, '').slice(0, 300);
          matches.push({
            file: path.resolve(cwd, rel),
            relPath: rel,
            line: ln,
            column: col,
            text,
          });
          if (matches.length >= maxResults) {
            truncated = true;
            try { child.kill(); } catch (_) {}
            break;
          }
        }
      }
    });
    child.stderr.on('data', (d) => { errText += d.toString('utf8'); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code > 1 && !matches.length && errText) {
        return reject(new Error(errText.trim()));
      }
      resolve({ ok: true, engine: 'rg', matches, truncated });
    });
  });
}

function searchWithJs(opts) {
  const { cwd, query, isRegex, caseSensitive, includeGlob, maxResults = 500 } = opts;
  const root = path.resolve(cwd);
  let re;
  try {
    re = buildRegex(query, { isRegex, caseSensitive });
  } catch (e) {
    return { ok: false, error: `Invalid search pattern: ${e.message}`, matches: [] };
  }
  const incRe = includeGlob
    ? new RegExp('^' + String(includeGlob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i')
    : null;
  const matches = [];
  let truncated = false;

  const walk = (dir) => {
    if (truncated) return;
    let list;
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const d of list) {
      if (truncated) return;
      if (IGNORE_DIRS.has(d.name)) continue;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { walk(full); continue; }
      if (!d.isFile()) continue;
      const rel = path.relative(root, full).replace(/\\/g, '/');
      if (incRe && !incRe.test(rel) && !incRe.test(d.name)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > 1024 * 1024) continue;
        const buf = fs.readFileSync(full);
        if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) continue;
        const lines = buf.toString('utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          re.lastIndex = 0;
          const m = re.exec(lines[i]);
          if (m) {
            matches.push({
              file: full,
              relPath: rel,
              line: i + 1,
              column: (m.index || 0) + 1,
              text: lines[i].replace(/\r$/, '').slice(0, 300),
            });
            if (matches.length >= maxResults) { truncated = true; return; }
          }
        }
      } catch (_) {}
    }
  };
  walk(root);
  return { ok: true, engine: 'js', matches, truncated };
}

async function searchWorkspace(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const query = String(opts.query || '');
  if (!query) return { ok: true, engine: 'none', matches: [], truncated: false };
  if (!fs.existsSync(cwd)) return { ok: false, error: 'Workspace not found', matches: [] };
  const rg = opts.forceJs ? null : resolveRipgrep();
  if (rg) {
    try {
      return await searchWithRipgrep(rg, { ...opts, cwd, query });
    } catch (_) {
      // Fall through cleanly to JS matcher
    }
  }
  return searchWithJs({ ...opts, cwd, query });
}

async function replaceInWorkspace(opts = {}) {
  const cwd = path.resolve(opts.cwd || process.cwd());
  const query = String(opts.query || '');
  const replacement = String(opts.replacement == null ? '' : opts.replacement);
  if (!query) return { ok: false, error: 'Query required', filesChanged: 0, replacements: 0 };

  let re;
  try {
    re = buildRegex(query, { isRegex: !!opts.isRegex, caseSensitive: !!opts.caseSensitive });
  } catch (e) {
    return { ok: false, error: `Invalid regex: ${e.message}`, filesChanged: 0, replacements: 0 };
  }

  let targetFiles = Array.isArray(opts.files) && opts.files.length ? opts.files.map((f) => path.resolve(cwd, f)) : null;
  if (!targetFiles) {
    const res = await searchWorkspace({ ...opts, cwd, maxResults: 2000 });
    if (!res.ok) return { ok: false, error: res.error, filesChanged: 0, replacements: 0 };
    targetFiles = [...new Set(res.matches.map((m) => m.file))];
  }

  let filesChanged = 0;
  let replacements = 0;
  for (const fp of targetFiles) {
    try {
      if (!fs.existsSync(fp)) continue;
      const orig = fs.readFileSync(fp, 'utf8');
      let fileCount = 0;
      const next = orig.replace(re, (...args) => {
        fileCount++;
        return replacement.replace(/\$\$|\$&|\$(\d+)/g, (tok, g) => {
          if (tok === '$$') return '$';
          if (tok === '$&') return args[0];
          const idx = Number(g);
          return args[idx] != null ? args[idx] : '';
        });
      });
      if (fileCount > 0 && next !== orig) {
        fs.writeFileSync(fp, next, 'utf8');
        filesChanged++;
        replacements += fileCount;
      }
    } catch (_) {}
  }
  return { ok: true, filesChanged, replacements };
}

module.exports = { resolveRipgrep, searchWorkspace, replaceInWorkspace };
