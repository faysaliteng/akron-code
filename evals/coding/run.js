'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const applyPatch = require('../../electron/apply-patch');
const editGuard = require('../../electron/ide/edit-guard');
const codebaseIndex = require('../../electron/ide/codebase-index');
const codemode = require('../../electron/codemode');
const spill = require('../../electron/spill');
const contextPipeline = require('../../electron/context-pipeline');
const loopGuard = require('../../electron/loop-guard');

async function runCodingEval() {
  const startedAt = Date.now();
  const results = [];

  const record = async (id, category, fn) => {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ id, category, passed: true, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ id, category, passed: false, error: e.message, ms: Date.now() - t0 });
    }
  };

  // --- A. 6 ApplyPatch multi-file coding tasks ---
  for (let i = 1; i <= 6; i++) {
    await record(`code-patch-${i}`, 'apply-patch', () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-patch-'));
      try {
        if (i === 1) {
          const p = '*** Begin Patch\n*** Add File: hello.js\n+module.exports = () => "hi";\n*** End Patch';
          const r = applyPatch.applyPatchToWorkspace({ patch: p, cwd: ws });
          assert.strictEqual(r.ok, true);
          assert.ok(fs.existsSync(path.join(ws, 'hello.js')));
        } else if (i === 2) {
          fs.writeFileSync(path.join(ws, 'cfg.js'), 'const a = 1;\nconst b = 2;\n');
          const p = '*** Begin Patch\n*** Update File: cfg.js\n@@\n const a = 1;\n-const b = 2;\n+const b = 42;\n*** End Patch';
          const r = applyPatch.applyPatchToWorkspace({ patch: p, cwd: ws });
          assert.strictEqual(r.ok, true);
          assert.ok(fs.readFileSync(path.join(ws, 'cfg.js'), 'utf8').includes('42'));
        } else if (i === 3) {
          fs.writeFileSync(path.join(ws, 'f1.txt'), 'alpha\nbeta\ngamma\ndelta\nepsilon\n');
          const p = '*** Begin Patch\n*** Update File: f1.txt\n@@\n-alpha\n+ALPHA\n beta\n@@\n delta\n-epsilon\n+OMEGA\n*** End Patch';
          const r = applyPatch.applyPatchToWorkspace({ patch: p, cwd: ws });
          assert.strictEqual(r.ok, true);
          const got = fs.readFileSync(path.join(ws, 'f1.txt'), 'utf8');
          assert.ok(got.includes('ALPHA') && got.includes('OMEGA'));
        } else if (i === 4) {
          fs.writeFileSync(path.join(ws, 'old.txt'), 'line1\nline2\n');
          const p = '*** Begin Patch\n*** Update File: old.txt\n*** Move to: sub/new.txt\n@@\n line1\n-line2\n+line2_moved\n*** End Patch';
          const r = applyPatch.applyPatchToWorkspace({ patch: p, cwd: ws });
          assert.strictEqual(r.ok, true);
          assert.strictEqual(fs.existsSync(path.join(ws, 'old.txt')), false);
          assert.ok(fs.readFileSync(path.join(ws, 'sub/new.txt'), 'utf8').includes('line2_moved'));
        } else if (i === 5) {
          fs.writeFileSync(path.join(ws, 'gone.txt'), 'bye\n');
          const p = '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch';
          const r = applyPatch.applyPatchToWorkspace({ patch: p, cwd: ws });
          assert.strictEqual(r.ok, true);
          assert.strictEqual(fs.existsSync(path.join(ws, 'gone.txt')), false);
        } else {
          fs.writeFileSync(path.join(ws, 'safe.txt'), 'real content\n');
          const p = '*** Begin Patch\n*** Update File: safe.txt\n@@\n-nonexistent line\n+mutated\n*** End Patch';
          const r = applyPatch.applyPatchToWorkspace({ patch: p, cwd: ws });
          assert.strictEqual(r.ok, false);
          assert.strictEqual(fs.readFileSync(path.join(ws, 'safe.txt'), 'utf8'), 'real content\n');
        }
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  // --- B. 4 EditGuard stale-read & post-edit diagnostics tasks ---
  for (let i = 1; i <= 4; i++) {
    await record(`code-editguard-${i}`, 'edit-guard', () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-eg-'));
      try {
        const f = path.join(ws, i === 4 ? 'pkg.json' : 'mod.js');
        fs.writeFileSync(f, i === 4 ? '{"ok":true}' : 'const x = 1;\n');
        const mtimes = new Map();
        editGuard.recordFileRead(mtimes, f);
        if (i === 1) {
          assert.strictEqual(editGuard.checkStaleRead(mtimes, f).ok, true);
        } else if (i === 2) {
          fs.writeFileSync(f, 'const x = 999;\n');
          assert.strictEqual(editGuard.checkStaleRead(mtimes, f).ok, false);
        } else if (i === 3) {
          fs.writeFileSync(f, 'const broken = (;\n');
          const diag = editGuard.collectPostEditDiagnostics(f);
          assert.ok(diag.includes('Syntax error'), 'Expected syntax diagnostic on broken JS');
        } else {
          fs.writeFileSync(f, '{ bad json');
          const diag = editGuard.collectPostEditDiagnostics(f);
          assert.ok(diag.includes('JSON syntax'), 'Expected JSON diagnostic on malformed JSON');
        }
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  // --- C. 4 CodebaseSearch semantic index tasks ---
  for (let i = 1; i <= 4; i++) {
    await record(`code-search-${i}`, 'codebase-index', async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-idx-'));
      const idxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-idxdb-'));
      try {
        fs.writeFileSync(path.join(ws, 'auth.js'), 'function verifyJwtSignature(token) { return true; }\nmodule.exports = { verifyJwtSignature };\n');
        fs.writeFileSync(path.join(ws, 'billing.js'), 'function computeInvoiceTotal(items) { return items.length * 10; }\n');
        fs.writeFileSync(path.join(ws, 'router.js'), 'function dispatchRouteHandler(req) { return 200; }\n');
        const queries = ['verifyJwtSignature', 'computeInvoiceTotal', 'dispatchRouteHandler', 'invoice'];
        const expectFiles = ['auth.js', 'billing.js', 'router.js', 'billing.js'];
        const res = await codebaseIndex.searchCodebase(ws, queries[i - 1], { indexDir: idxDir, limit: 5 });
        const hits = (res && res.hits) || [];
        assert.ok(hits.length > 0 && String(hits[0].file).includes(expectFiles[i - 1]), `Expected ${expectFiles[i - 1]} first for "${queries[i - 1]}"`);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
        fs.rmSync(idxDir, { recursive: true, force: true });
      }
    });
  }

  // --- D. 4 CodeMode batched read-only script execution tasks ---
  for (let i = 1; i <= 4; i++) {
    await record(`code-codemode-${i}`, 'codemode', async () => {
      const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-cm-'));
      try {
        fs.writeFileSync(path.join(ws, `item${i}.txt`), `value=${i * 10}`);
        const res = await codemode.runToolScript({
          code: `const txt = await tools.read({ path: "item${i}.txt" }); return { step: ${i}, hasVal: String(txt).includes("value=${i * 10}") };`,
          cwd: ws,
          callHostTool: async (name, a) => {
            if (name === 'read' || name === 'Read') return fs.readFileSync(path.join(ws, a.path), 'utf8');
            return '';
          },
        });
        assert.strictEqual(res.ok, true);
        const parsed = JSON.parse(res.output);
        assert.strictEqual(parsed.hasVal, true);
      } finally {
        fs.rmSync(ws, { recursive: true, force: true });
      }
    });
  }

  // --- E. 4 Context 2.0 & Loop Guard tasks ---
  await record('code-spill-1', 'spill-to-disk', () => {
    const tmpSpill = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eval-sp-'));
    try {
      const large = Array.from({ length: 1200 }, (_, n) => `line ${n + 1}: ok log payload`).join('\n');
      const sp = spill.maybeSpillOutput(large, { thresholdBytes: 4000, spillRoot: tmpSpill, toolName: 'Bash' });
      assert.strictEqual(sp.spilled, true);
      assert.ok(sp.text.length < large.length * 0.6);
      assert.ok(fs.existsSync(sp.filePath));
    } finally {
      fs.rmSync(tmpSpill, { recursive: true, force: true });
    }
  });

  await record('code-ctx-mask-2', 'progressive-masking', () => {
    const verbose = 'INFO: build step\n'.repeat(250) + 'Error: missing export foo on line 19\n';
    const msgs = [
      { role: 'user', content: 'Fix build' },
      { role: 'tool', tool_call_id: '1', content: verbose },
      { role: 'assistant', content: 'Step 1' },
      { role: 'assistant', content: 'Step 2' },
      { role: 'assistant', content: 'Done' },
    ];
    const masked = contextPipeline.maskOlderToolOutputs(msgs, { keepRecentSteps: 1, minChars: 1000 });
    assert.ok(masked[1].content.length < verbose.length);
    assert.ok(masked[1].content.includes('Error: missing export foo'));
  });

  await record('code-shrink-budgets-3', 'shrink-budgets', () => {
    const budgets = contextPipeline.shrinkingBudgets(64000);
    assert.strictEqual(budgets.length, 3);
    assert.ok(budgets[0] > budgets[1] && budgets[1] > budgets[2]);
  });

  await record('code-loop-guard-4', 'loop-guard', () => {
    const lg = loopGuard.createLoopGuard({ circuitBreakerThreshold: 8 });
    let blocked = false;
    for (let i = 0; i < 8; i++) {
      const pre = lg.beforeCall('Read', { path: 'a.js' });
      if (pre.blocked) blocked = true;
      lg.afterCall('Read', { path: 'a.js' }, { isError: true });
    }
    assert.strictEqual(blocked, true, 'Loop guard must halt identical call at circuitBreakerThreshold=8');
  });

  const passed = results.filter((r) => r.passed).length;
  return {
    suite: 'coding',
    total: results.length,
    passed,
    failed: results.length - passed,
    passRatePct: Math.round((passed / results.length) * 1000) / 10,
    durationMs: Date.now() - startedAt,
    results,
  };
}

if (require.main === module) {
  runCodingEval().then((r) => {
    console.log(JSON.stringify(r, null, 2));
    if (r.failed > 0) process.exit(1);
  });
}

module.exports = { runCodingEval };
