'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
    case '.mjs':
    case '.cjs':
      return 'jsx';
    case '.jsx':
      return 'jsx';
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
        try {
          const esbuild = require('esbuild');
          esbuild.transformSync(raw, { loader, sourcefile: fp, logLevel: 'silent' });
        } catch (e) {
          const errs = Array.isArray(e && e.errors) ? e.errors : [];
          if (errs.length) {
            for (const er of errs.slice(0, 5)) {
              const loc = er.location ? `L${er.location.line}:${er.location.column}` : '';
              issues.push(`[Syntax error${loc ? ' ' + loc : ''}] ${er.text}`);
            }
          } else {
            issues.push(`[Syntax error] ${e && e.message ? e.message.split('\n')[0] : String(e)}`);
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

  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    const scripts = (pkg && pkg.scripts) || {};
    if (scripts.typecheck) {
      checks.push({ name: 'npm run typecheck', res: await execAsync(npmBin, ['run', 'typecheck'], dir, timeoutMs) });
    } else if (fs.existsSync(path.join(dir, 'tsconfig.json'))) {
      checks.push({ name: 'tsc --noEmit', res: await execAsync(npxBin, ['--no-install', 'tsc', '--noEmit'], dir, timeoutMs) });
    }
    if (scripts.lint) {
      checks.push({ name: 'npm run lint', res: await execAsync(npmBin, ['run', 'lint'], dir, timeoutMs) });
    }
  }

  // Fallback lightweight JS/JSON syntax scan across top source files if no scripts configured
  if (!checks.length) {
    const errors = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isFile()).slice(0, 20);
      for (const e of entries) {
        const fp = path.join(dir, e.name);
        const diag = collectPostEditDiagnostics(fp, dir);
        if (diag) errors.push(diag.trim());
      }
    } catch (_) {}
    checks.push({
      name: 'syntax-scan',
      res: { ok: errors.length === 0, code: errors.length ? 1 : 0, output: errors.join('\n') || 'No syntax errors detected.' },
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

module.exports = {
  recordFileRead,
  checkStaleRead,
  collectPostEditDiagnostics,
  runShadowCheck,
};
