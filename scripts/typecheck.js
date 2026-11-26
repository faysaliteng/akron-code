'use strict';

const fs = require('fs');
const path = require('path');
const { transformSync } = require('esbuild');

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['electron', 'src', 'scripts', 'test'];
const TARGET_EXTS = new Set(['.js', '.jsx', '.mjs', '.cjs']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'release' || ent.name === 'fixtures') continue;
    const fp = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(fp, out);
    else if (TARGET_EXTS.has(path.extname(ent.name).toLowerCase())) out.push(fp);
  }
  return out;
}

let checked = 0;
const failures = [];

for (const d of DIRS) {
  for (const fp of walk(path.join(ROOT, d))) {
    const ext = path.extname(fp).toLowerCase();
    const loader = ext === '.jsx' ? 'jsx' : 'js';
    const src = fs.readFileSync(fp, 'utf8');
    checked++;
    try {
      transformSync(src, {
        loader,
        sourcefile: path.relative(ROOT, fp),
        jsx: 'automatic',
        format: loader === 'jsx' || ext === '.mjs' || /\bimport\b|\bexport\b/.test(src.slice(0, 600)) ? 'esm' : 'cjs',
      });
    } catch (err) {
      failures.push({
        file: path.relative(ROOT, fp),
        message: err && err.message ? err.message.split('\n')[0] : String(err),
      });
    }
  }
}

if (failures.length) {
  console.error(`TYPECHECK_FAILED (${failures.length}/${checked} files):`);
  for (const f of failures) console.error(`  - ${f.file}: ${f.message}`);
  process.exit(1);
}

console.log(`TYPECHECK_OK: verified ${checked} JS/JSX/MJS/CJS files with 0 syntax/transform errors.`);
