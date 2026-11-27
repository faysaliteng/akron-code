'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

function ensureUnpackedEsbuildBinary() {
  const cur = String(process.env.ESBUILD_BINARY_PATH || '').trim();
  if (cur && fs.existsSync(cur) && !/app\.asar(?:[/\\]|$)/i.test(cur)) {
    return cur;
  }
  const pkg = `${process.platform}-${process.arch}`;
  const binName = process.platform === 'win32' ? 'esbuild.exe' : 'esbuild';
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', pkg, 'bin', binName));
  }
  if (__dirname.includes('app.asar')) {
    const unpackedRoot = __dirname.replace(/app\.asar(?:[/\\][^]*)$/, 'app.asar.unpacked');
    candidates.push(path.join(unpackedRoot, 'node_modules', '@esbuild', pkg, 'bin', binName));
  }
  candidates.push(path.join(__dirname, '..', '..', 'node_modules', '@esbuild', pkg, 'bin', binName));
  for (const c of candidates) {
    try {
      if (c && fs.existsSync(c)) {
        process.env.ESBUILD_BINARY_PATH = c;
        return c;
      }
    } catch (_) {}
  }
  return '';
}

function checkEsmFallback(raw, fp) {
  let nodeBin = '';
  try { nodeBin = require('../paths').resolveNodeBinary(); } catch (_) {}
  if (nodeBin && !/app\.asar(?:[/\\]|$)/i.test(nodeBin)) {
    try {
      const r = spawnSync(nodeBin, ['--check', fp], { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      if (!r.error) {
        if (r.status === 0) return { checked: true, error: null };
        const msg = String(r.stderr || r.stdout || 'syntax error').trim().split('\n').slice(0, 3).join(' ');
        return { checked: true, error: msg };
      }
    } catch (_) {}
  }
  try {
    const vm = require('vm');
    const stripped = String(raw || '')
      .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
      .replace(/^\s*import\s+['"][^'"]+['"];?/gm, '')
      .replace(/^\s*export\s+default\s+/gm, 'void ')
      .replace(/^\s*export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gm, '');
    new vm.Script(stripped, { filename: fp });
    return { checked: true, error: null };
  } catch (e) {
    return { checked: true, error: e && e.message ? e.message.split('\n')[0] : String(e) };
  }
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function recordFileRead(readMtimes, fp, buf = null, st = null) {
  if (!(readMtimes instanceof Map) || !fp) return;
  try {
    const stat = st || fs.statSync(fp);
    const data = buf != null ? buf : fs.readFileSync(fp);
    readMtimes.set(fp, {
      mtimeMs: Math.floor(stat.mtimeMs),
      sha256: sha256Buffer(Buffer.isBuffer(data) ? data : Buffer.from(String(data))),
    });
  } catch (_) {}
}

function checkStaleRead(readMtimes, fp) {
  if (!(readMtimes instanceof Map) || !readMtimes.has(fp)) return { ok: true };
  const entry = readMtimes.get(fp);
  let st;
  try {
    st = fs.statSync(fp);
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, error: `Error: ${fp} was deleted on disk since you last Read it. Verify the file state with Read/Glob first.` };
    }
    return { ok: true };
  }
  const curMtime = Math.floor(st.mtimeMs);
  if (typeof entry === 'number') {
    if (curMtime > entry + 5) {
      return {
        ok: false,
        error: `Error: ${fp} was modified on disk since you last Read it (by another agent or command). Call Read on ${fp} first to inspect the latest contents before editing.`,
      };
    }
    return { ok: true };
  }
  if (entry && typeof entry === 'object') {
    if (entry.sha256) {
      try {
        const curHash = sha256Buffer(fs.readFileSync(fp));
        if (curHash !== entry.sha256) {
          return {
            ok: false,
            error: `Error: ${fp} was modified on disk since you last Read it (content hash changed). Call Read on ${fp} first to inspect the latest contents before editing.`,
          };
        }
        return { ok: true };
      } catch (_) {}
    }
    if (typeof entry.mtimeMs === 'number' && curMtime > entry.mtimeMs + 5) {
      return {
        ok: false,
        error: `Error: ${fp} was modified on disk since you last Read it. Call Read on ${fp} first before editing.`,
      };
    }
  }
  return { ok: true };
}

function esbuildLoaderFor(ext) {
  switch (ext) {
    case '.js':
    case '.jsx':
      return 'jsx';
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.json':
      return 'json';
    default:
      return null;
  }
}

function collectPostEditDiagnostics(fp, _cwd = null) {
  const issues = [];
  const ext = path.extname(String(fp || '')).toLowerCase();
  let raw = null;
  try {
    if (fs.existsSync(fp)) raw = fs.readFileSync(fp, 'utf8');
  } catch (_) {}

  if (raw != null) {
    if (ext === '.json') {
      try {
        JSON.parse(raw);
      } catch (e) {
        issues.push(`[JSON syntax] ${e && e.message ? e.message : String(e)}`);
      }
    } else {
      const loader = esbuildLoaderFor(ext);
      if (loader) {
        let syntaxChecked = false;
        let esbuild = null;
        try {
          ensureUnpackedEsbuildBinary();
          esbuild = require('esbuild');
        } catch (_) {
          esbuild = null;
        }
        if (esbuild && typeof esbuild.transformSync === 'function') {
          try {
            esbuild.transformSync(raw, { loader, sourcefile: fp, logLevel: 'silent' });
            syntaxChecked = true;
          } catch (e) {
            const errs = Array.isArray(e && e.errors) ? e.errors : [];
            if (errs.length) {
              syntaxChecked = true;
              for (const er of errs.slice(0, 5)) {
                const loc = er.location ? `L${er.location.line}:${er.location.column}` : '';
                issues.push(`[Syntax error${loc ? ' ' + loc : ''}] ${er.text}`);
              }
            }
          }
        }
        if (!syntaxChecked && (ext === '.js' || ext === '.cjs' || ext === '.mjs')) {
          const isEsmSyntax = ext === '.mjs' || /^\s*(?:import|export)\b/m.test(raw);
          if (!isEsmSyntax) {
            try {
              const vm = require('vm');
              new vm.Script(raw, { filename: fp });
            } catch (e) {
              issues.push(`[Syntax error] ${e && e.message ? e.message.split('\n')[0] : String(e)}`);
            }
          } else {
            const fb = checkEsmFallback(raw, fp);
            if (fb.error) issues.push(`[Syntax error] ${fb.error}`);
          }
        }
      }
    }
  }

  try {
    const lsp = require('./lsp');
    const lspDiags = lsp.getDiagnosticsForFile(fp) || [];
    for (const d of lspDiags.slice(0, 6)) {
      const sev = d.severity === 1 ? 'LSP Error' : d.severity === 2 ? 'LSP Warning' : 'LSP Info';
      const line = d.range && d.range.start ? `L${d.range.start.line + 1}` : '';
      issues.push(`[${sev}${line ? ' ' + line : ''}] ${d.message}`);
    }
  } catch (_) {}

  if (!issues.length) return '';
  return `\n\nDiagnostics for ${fp}:\n` + issues.map((x) => `  - ${x}`).join('\n');
}

function collectSourceFilesRecursive(dir, limit = 250) {
  const out = [];
  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'vendor', '.autobot', '.akron', '.next', '.nuxt']);
  const EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.json']);
  const walk = (cur) => {
    if (out.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) break;
      if (!e || !e.name) continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || /^release/i.test(e.name)) continue;
        walk(path.join(cur, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name).toLowerCase();
        if (EXTS.has(ext)) out.push(path.join(cur, e.name));
      }
    }
  };
  walk(dir);
  return out;
}

function execAsync(file, args, cwd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const child = execFile(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        output: [stdout, stderr].filter(Boolean).join('\n').trim(),
      });
    });
    if (!child) resolve({ ok: false, code: 1, output: 'failed to spawn command' });
  });
}

async function runShadowCheck(cwd, { timeoutMs = 30000 } = {}) {
  const dir = cwd ? path.resolve(cwd) : process.cwd();
  const checks = [];

  const pkgPath = path.join(dir, 'package.json');
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npxBin = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  let hasTypecheck = false;

  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    const scripts = (pkg && pkg.scripts) || {};
    if (scripts.typecheck) {
      hasTypecheck = true;
      checks.push({ name: 'npm run typecheck', res: await execAsync(npmBin, ['run', 'typecheck'], dir, timeoutMs) });
    } else if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      hasTypecheck = true;
      checks.push({ name: 'tsc --noEmit', res: await execAsync(npxBin, ['--no-install', 'tsc', '--noEmit'], dir, timeoutMs) });
    }
    if (scripts.lint) {
      checks.push({ name: 'npm run lint', res: await execAsync(npmBin, ['run', 'lint'], dir, timeoutMs) });
    }
  }

  // Always scan JS/MJS/CJS/JSX/TS files recursively (even when package.json typecheck
  // runs, because workspace sandboxes or standalone .mjs/.js files may sit outside it).
  const scanned = collectSourceFilesRecursive(dir, 250);
  const scanTargets = scanned;
  if (scanTargets.length > 0 || !hasTypecheck) {
    const errors = [];
    for (const fp of scanTargets) {
      const diag = collectPostEditDiagnostics(fp, dir);
      if (diag) errors.push(diag.trim());
    }
    checks.push({
      name: 'syntax-scan',
      res: {
        ok: errors.length === 0,
        code: errors.length ? 1 : 0,
        output: errors.join('\n') || `Checked ${scanTargets.length} file${scanTargets.length === 1 ? '' : 's'} — no syntax errors detected.`,
      },
    });
  }

  const failed = checks.filter((c) => !c.res.ok);
  const summaryLines = checks.map((c) => `${c.res.ok ? 'PASS' : 'FAIL'} [${c.name}]${c.res.output ? '\n' + c.res.output.slice(0, 1200) : ''}`);
  return {
    ok: failed.length === 0,
    checks: checks.map((c) => ({ name: c.name, ok: c.res.ok, code: c.res.code, output: c.res.output })),
    summary: summaryLines.join('\n\n'),
  };
}

const _fileLocks = new Map();

/** Serialize async file mutations targeting the same resolved path across concurrent subagents/Swarm workers. */
async function withFileLock(filePath, fn) {
  const key = filePath ? path.resolve(String(filePath)) : '__default__';
  const prev = _fileLocks.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((r) => { release = r; });
  const tail = prev.catch(() => {}).then(() => gate);
  _fileLocks.set(key, tail);
  await prev.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (_fileLocks.get(key) === tail) _fileLocks.delete(key);
  }
}

module.exports = {
  recordFileRead,
  checkStaleRead,
  collectPostEditDiagnostics,
  runShadowCheck,
  withFileLock,
};
