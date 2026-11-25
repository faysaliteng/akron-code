'use strict';
// Tests for electron/search.js — file + notebook + memory search used by the
// Cmd/Ctrl+Shift+F panel and the `/search` slash command.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('../electron/store');
const sandbox = require('../electron/sandbox');
const search = require('../electron/search');

let passed = 0; let failed = 0; const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-search-'));
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.js'), 'const needleToken = 1;\nfunction other() {}\n');
fs.writeFileSync(path.join(root, 'README.md'), '# Doc\nneedleToken lives here too\n');
fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(root, 'node_modules', 'x.js'), 'needleToken ignored\n');

function hasRg() { try { execFileSync('rg', ['--version'], { stdio: 'ignore' }); return true; } catch (_) { return false; } }

(async () => {
  if (!hasRg()) {
    console.log('  skip ripgrep not installed — file search paths not executable here');
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }

  const realSettings = store.getSettings;
  store.getSettings = () => ({});

  const hits = await search.searchFiles({ query: 'needleToken', cwd: root, limit: 20 });
  ok('finds matches in files', hits.length >= 2, 'got ' + hits.length);
  ok('skips node_modules', !hits.some((h) => h.rel.includes('node_modules')), JSON.stringify(hits.map(h => h.rel)));
  ok('reports line numbers', hits.every((h) => typeof h.line === 'number'));
  ok('reports relative path', hits.some((h) => h.rel === 'src/a.js'));

  const globbed = await search.searchFiles({ query: 'needleToken', cwd: root, glob: '*.md', limit: 20 });
  ok('glob filter narrows results', globbed.length === 1 && globbed[0].rel === 'README.md', JSON.stringify(globbed.map(h => h.rel)));

  // denyRead must be honoured by search too.
  store.getSettings = () => ({ sandbox: { enabled: true, filesystem: { denyRead: [root], allowRead: [], denyWrite: [], allowManagedReadPathsOnly: false } } });
  const blocked = await search.searchFiles({ query: 'needleToken', cwd: root });
  ok('denied root yields no hits', blocked.length === 0, JSON.stringify(blocked));

  store.getSettings = () => ({});
  const realNb = store.listNotebooks; const realGetNb = store.getNotebook; const realMem = store.getMemory;
  store.listNotebooks = () => ['alpha', 'beta'];
  store.getNotebook = (n) => ({ title: n, cells: n === 'beta' ? [{ src: 'needleToken cell' }] : [{ src: 'nothing' }] });
  store.getMemory = () => ({ entries: [{ content: 'remember needleToken rule' }, { content: 'unrelated' }] });
  const rec = search.searchRecords('needletoken');
  ok('finds notebook match', rec.some((h) => h.kind === 'notebook' && h.id === 'beta'), JSON.stringify(rec));
  ok('finds memory match', rec.some((h) => h.kind === 'memory'), JSON.stringify(rec));

  const all = await search.searchAll({ query: 'needleToken', cwd: root, limit: 50 });
  ok('searchAll merges kinds', new Set(all.hits.map((h) => h.kind)).size >= 2, JSON.stringify(all.hits.map(h => h.kind)));

  store.listNotebooks = realNb; store.getNotebook = realGetNb; store.getMemory = realMem; store.getSettings = realSettings;
  fs.rmSync(root, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
})();
