'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const notebookRunner = require('../electron/ide/notebook-runner');
const debuggerMod = require('../electron/ide/debugger');
const aiInline = require('../electron/ide/ai-inline');

test('Phase 4: notebook-runner executes stateful Python & JavaScript cells, interrupts loops, and restarts kernels', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-nb-'));
  const nbPath = path.join(tmpDir, 'demo.ipynb');
  try {
    const nb = notebookRunner.parseNotebook(JSON.stringify({
      cells: [
        { cell_type: 'code', source: 'x = 41\n' },
        { cell_type: 'code', source: 'print(x + 1)\n' },
      ],
    }));
    assert.strictEqual(nb.cells.length, 2);
    assert.ok(notebookRunner.serializeNotebook(nb).includes('"nbformat"'));

    const r1 = await notebookRunner.executeCell({ notebookPath: nbPath, cwd: tmpDir, kernel: 'python', code: 'x = 41' });
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.executionCount, 1);

    const r2 = await notebookRunner.executeCell({ notebookPath: nbPath, cwd: tmpDir, kernel: 'python', code: 'print(x + 1)' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.executionCount, 2);
    assert.ok(r2.stdout.includes('42'));

    const js1 = await notebookRunner.executeCell({ notebookPath: nbPath, cwd: tmpDir, kernel: 'javascript', code: 'globalThis.nbVal = 10;' });
    assert.strictEqual(js1.ok, true);
    const js2 = await notebookRunner.executeCell({ notebookPath: nbPath, cwd: tmpDir, kernel: 'javascript', code: 'globalThis.nbVal * 5' });
    assert.strictEqual(js2.ok, true);
    assert.strictEqual(String(js2.result).trim(), '50');

    const st = notebookRunner.kernelStatus(nbPath);
    assert.strictEqual(st.python, 'idle');
    assert.strictEqual(st.javascript, 'idle');

    // Interrupt infinite loop
    const loopPromise = notebookRunner.executeCell({
      notebookPath: nbPath,
      cwd: tmpDir,
      kernel: 'python',
      code: 'while True:\n  pass',
      timeoutMs: 8000,
    });
    setTimeout(() => { notebookRunner.interruptKernel(nbPath, 'python'); }, 250);
    const interrupted = await loopPromise;
    assert.strictEqual(interrupted.ok, false);

    const restarted = notebookRunner.restartKernel(nbPath, 'python');
    assert.strictEqual(restarted.ok, true);
  } finally {
    notebookRunner.shutdownAllKernels();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 4: debugger attaches via Node CDP, hits breakpoint, inspects locals & stepOver, and stops', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-dbg-'));
  const scriptPath = path.join(tmpDir, 'sample.js');
  fs.writeFileSync(scriptPath, [
    'function compute(n) {',
    '  const doubled = n * 2;',
    '  const result = doubled + 5;',
    '  return result;',
    '}',
    'const out = compute(12);',
    'console.log("DONE", out);',
  ].join('\n'));

  const pausedEvents = [];
  const waiters = [];
  const waitForPaused = (predicate, timeoutMs = 6000) => {
    const existing = pausedEvents.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timed out waiting for paused debug event')), timeoutMs);
      waiters.push({ predicate, resolve: (e) => { clearTimeout(t); resolve(e); } });
    });
  };

  let sessionId = null;
  try {
    const started = await debuggerMod.startDebug({
      cwd: tmpDir,
      filePath: scriptPath,
      breakpoints: [{ file: scriptPath, line: 3 }],
      watchExpressions: ['doubled + 1'],
      onEvent: (evt) => {
        if (evt.type === 'paused') {
          pausedEvents.push(evt);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(evt)) {
              const w = waiters.splice(i, 1)[0];
              w.resolve(evt);
            }
          }
        }
      },
    });
    assert.strictEqual(started.ok, true, started.error || 'startDebug failed');
    sessionId = started.sessionId;

    const hitBp = await waitForPaused((e) => e.line === 3);
    assert.strictEqual(hitBp.line, 3);
    assert.ok(Array.isArray(hitBp.frames) && hitBp.frames.length >= 1);
    assert.ok(hitBp.locals.some((l) => l.name === 'doubled' && l.value === '24'));

    await debuggerMod.debugCommand({ sessionId, action: 'stepOver' });
    const afterStep = await waitForPaused((e) => e.line === 4);
    assert.strictEqual(afterStep.line, 4);
    assert.ok(afterStep.locals.some((l) => l.name === 'result' && l.value === '29'));

    await debuggerMod.debugCommand({ sessionId, action: 'continue' });
  } finally {
    try { await debuggerMod.debugCommand({ sessionId, action: 'stop' }); } catch (_) {}
    debuggerMod.stopAllDebuggers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 4: predictNextEdit Stage 1 deterministically predicts call-site update on function rename', async () => {
  const oldContent = [
    'function computeTotal(items) {',
    '  return items.length;',
    '}',
    '',
    'const orderCount = computeTotal(cart);',
  ].join('\n');
  const newContent = oldContent.replace('function computeTotal(items)', 'function calculateGrandTotal(items)');
  const res = await aiInline.predictNextEdit({
    filePath: 'billing.js',
    language: 'javascript',
    oldContent,
    newContent,
    editLine: 1,
  });
  assert.strictEqual(res.ok, true);
  assert.ok(res.prediction);
  assert.strictEqual(res.prediction.line, 5);
  assert.ok(res.prediction.replacementLineText.includes('calculateGrandTotal(cart)'));
});
