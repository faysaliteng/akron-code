'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

const git = require('../electron/git');

async function run() {
  let passed = 0;

  // 1. CSS regression check: Browser maximize must sit below 40px macOS titlebar and declare no-drag
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles.css'), 'utf8');
  const expMatch = /\.browser-panel\.expanded\s*\{([^}]+)\}/.exec(css);
  assert(expMatch, 'Expected .browser-panel.expanded rule in styles.css');
  assert(!/inset\s*:\s*0/.test(expMatch[1]), '.browser-panel.expanded must NOT use inset: 0 (overlaps titlebar drag mask)');
  assert(/top\s*:\s*40px/.test(expMatch[1]), '.browser-panel.expanded must anchor top: 40px below titlebar');
  assert(/-webkit-app-region\s*:\s*no-drag/.test(expMatch[1]), '.browser-panel.expanded must set -webkit-app-region: no-drag');
  assert(/\.browser-tabs[\s\S]{0,400}-webkit-app-region\s*:\s*no-drag/.test(css), '.browser-tabs must declare no-drag');
  passed++;

  // 2. git.gitDiffFiles working-tree + untracked files with full context lines
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-gitdiff-'));
  try {
    const g = (...args) => execFileSync('git', args, { cwd: tmp, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    g('init');
    g('config', 'user.email', 'test@example.com');
    g('config', 'user.name', 'Test');
    const lines = [];
    for (let i = 1; i <= 90; i++) lines.push(`const row_${i} = ${i};`);
    const targetFile = path.join(tmp, 'src', 'engine.js');
    fs.mkdirSync(path.dirname(targetFile), { recursive: true });
    fs.writeFileSync(targetFile, lines.join('\n') + '\n');
    g('add', '.');
    g('commit', '-m', 'init');

    // Modify line 5 and line 85 (leaving >70 context lines in middle for fold testing)
    const mod = lines.slice();
    mod[4] = 'const row_5 = 500; // updated';
    mod[84] = 'const row_85 = 8500; // diff-needle-inside';
    fs.writeFileSync(targetFile, mod.join('\n') + '\n');
    // Add an untracked file
    fs.writeFileSync(path.join(tmp, 'src', 'helper.ts'), 'export const greet = (name: string) => `hi ${name}`;\n');

    const diffs = git.gitDiffFiles(tmp);
    assert.strictEqual(diffs.length, 2, `Expected 2 diff files, got ${diffs.length}`);
    const engine = diffs.find((d) => d.relPath === 'src/engine.js');
    const helper = diffs.find((d) => d.relPath === 'src/helper.ts');
    assert(engine, 'Modified tracked file must be returned');
    assert.strictEqual(engine.status, 'modified');
    assert.strictEqual(engine.added, 2);
    assert.strictEqual(engine.removed, 2);
    assert(engine.lines.length >= 90, 'Full context lines must be preserved for fold bars');
    assert(helper && helper.status === 'added' && helper.added >= 1, 'Untracked file must be included');
    passed++;

    // 3. Review helpers: groupDiffChunks, computeFoldSlice (+10 incremental & full), findFoldForLine, buildSearchMatcher
    const modUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'review-helpers.mjs')).href;
    const h = await import(modUrl);
    const chunks = h.groupDiffChunks(engine.lines);
    const fold = chunks.find((c) => c.kind === 'fold');
    assert(fold && fold.count > 60, `Expected collapsed fold chunk > 60 lines, got ${fold && fold.count}`);

    const slice0 = h.computeFoldSlice(fold, undefined);
    assert.strictEqual(slice0.expanded, false);
    assert.strictEqual(slice0.remaining, fold.count);

    const slice10 = h.computeFoldSlice(fold, { top: 10, bottom: 10 });
    assert.strictEqual(slice10.topLines.length, 10);
    assert.strictEqual(slice10.bottomLines.length, 10);
    assert.strictEqual(slice10.remaining, fold.count - 20);

    const insideLineIdx = fold.start + Math.floor(fold.count / 2);
    assert.strictEqual(h.findFoldForLine(chunks, insideLineIdx), fold.id);

    const mWord = h.buildSearchMatcher('row', { wholeWord: true, matchCase: true });
    assert(mWord);
    assert.strictEqual(mWord.test('row_1'), false, 'Whole-word match must reject partial identifier row_1');
    mWord.lastIndex = 0;
    assert.strictEqual(mWord.test('const row = 1'), true, 'Whole-word match must accept standalone row');
    passed++;

    // 4. Subagent derivation across persisted message/conv + Task/Swarm tool calls
    const subs = h.deriveSubAgents(
      [{ key: 'live-1', name: 'planner', status: 'done', model: 'gpt-5.6-luna' }],
      { subAgents: [{ key: 'conv-1', name: 'reviewer', status: 'done' }] },
      [{
        role: 'assistant',
        tools: [
          { id: 't1', name: 'Task', args: { name: 'coder-worker-1', model: 'qwen3.8-flash' }, status: 'done', result: 'ok' },
          { id: 't2', name: 'Swarm', args: { action: 'add', name: 'verifier' }, status: 'running' },
        ],
        subAgents: [{ key: 'm-1', name: 'planner', status: 'done', model: 'gpt-5.6-luna', progress: { tools: 4 } }],
      }]
    );
    assert.strictEqual(subs.length, 4, `Expected 4 deduplicated subagents, got ${subs.length}`);
    const names = new Set(subs.map((s) => s.name));
    assert(names.has('planner') && names.has('reviewer') && names.has('coder-worker-1') && names.has('verifier'));
    passed++;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`review-browser-subagents tests: ${passed} passed, 0 failed`);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
