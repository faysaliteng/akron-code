'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const spill = require(path.join(ROOT, 'electron', 'spill'));
const ctxPipe = require(path.join(ROOT, 'electron', 'context-pipeline'));
const loopGuardMod = require(path.join(ROOT, 'electron', 'loop-guard'));
const hooks = require(path.join(ROOT, 'electron', 'hooks'));
const { MCPClient } = require(path.join(ROOT, 'electron', 'mcp'));
const { runTool } = require(path.join(ROOT, 'electron', 'tools'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('spill.maybeSpillOutput writes 0o600 spill file and returns head/tail pointer', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-spill-'));
  try {
    const big = Array.from({ length: 400 }, (_, i) => `line-${i + 1}: ` + 'x'.repeat(60)).join('\n');
    const res = spill.maybeSpillOutput(big, {
      convId: 'conv_abc',
      callId: 'call_1',
      toolName: 'Bash',
      thresholdBytes: 4096,
      spillRoot: tmp,
    });
    assert.strictEqual(res.spilled, true);
    assert.ok(res.filePath && fs.existsSync(res.filePath));
    const st = fs.statSync(res.filePath);
    if (process.platform !== 'win32') {
      assert.strictEqual(st.mode & 0o777, 0o600);
    }
    assert.ok(res.text.includes('line-1:'));
    assert.ok(res.text.includes('line-400:'));
    assert.ok(res.text.includes('Output spilled to disk:'));
    assert.ok(res.text.includes(res.filePath));

    const small = spill.maybeSpillOutput('hello world', { thresholdBytes: 4096, spillRoot: tmp });
    assert.strictEqual(small.spilled, false);
    assert.strictEqual(small.text, 'hello world');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spill.pruneOldSpills removes files older than maxAgeMs and preserves recent spills', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-spill-prune-'));
  try {
    const convDir = path.join(tmp, 'c1');
    fs.mkdirSync(convDir, { recursive: true });
    const oldFile = path.join(convDir, 'old.txt');
    const newFile = path.join(convDir, 'new.txt');
    fs.writeFileSync(oldFile, 'stale');
    fs.writeFileSync(newFile, 'fresh');
    const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    const out = spill.pruneOldSpills({ spillRoot: tmp });
    assert.strictEqual(out.removedFiles, 1);
    assert.strictEqual(fs.existsSync(oldFile), false);
    assert.strictEqual(fs.existsSync(newFile), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('context-pipeline preserves last 4 steps verbatim and masks older verbose tool outputs', () => {
  const verboseOld = 'src/App.jsx\n' + 'TRACE: ok\n'.repeat(180) + 'Error: sample failure on line 42\n';
  const verboseRecent = 'RECENT_VERBATIM_' + 'z'.repeat(2000);
  const msgs = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'assistant', content: `step ${i}` });
    msgs.push({
      role: 'tool',
      tool_call_id: `c${i}`,
      name: 'Bash',
      content: i < 2 ? verboseOld : verboseRecent,
    });
  }
  const masked = ctxPipe.maskOlderToolOutputs(msgs, { keepRecentSteps: 4, minChars: 500 });
  // Step 0 & step 1 masked; steps 2..5 verbatim; original array untouched
  assert.ok(masked[2].content.startsWith('[Masked step output (Bash)'));
  assert.ok(masked[2].content.includes('src/App.jsx'));
  assert.ok(masked[2].content.includes('Error: sample failure on line 42'));
  assert.strictEqual(msgs[2].content, verboseOld);
  assert.strictEqual(masked[masked.length - 1].content, verboseRecent);
  assert.deepStrictEqual(ctxPipe.shrinkingBudgets(100000), [65000, 45000, 28000]);
});

test('loop-guard escalates at 3 & 5 repeats and circuit-breaks at 8 repeats', () => {
  const lg = loopGuardMod.createLoopGuard({ circuitBreakerThreshold: 8 });
  const args = { command: 'npm test', a: 1, b: 2 };
  const argsReordered = { b: 2, command: 'npm test', a: 1 };
  assert.strictEqual(loopGuardMod.toolSignature('Bash', args), loopGuardMod.toolSignature('Bash', argsReordered));

  for (let i = 1; i <= 7; i++) {
    const pre = lg.beforeCall('Bash', args);
    assert.strictEqual(pre.blocked, false);
    const post = lg.afterCall('Bash', args, { isError: true });
    if (i === 3) assert.strictEqual(post.level, 'advisory');
    if (i === 5) assert.strictEqual(post.level, 'strong');
  }
  const halt = lg.beforeCall('Bash', args);
  assert.strictEqual(halt.blocked, true);
  assert.ok(halt.reason.includes('LOOP GUARD CIRCUIT BREAKER'));
});

test('FIFO non-blocking read times out / fails fast on named pipes without hanging', async () => {
  if (process.platform === 'win32') return;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-fifo-'));
  const fifoPath = path.join(tmp, 'locked.pipe');
  try {
    execFileSync('mkfifo', [fifoPath]);
    const res = await runTool('Read', { path: fifoPath }, {});
    assert.ok(typeof res.content === 'string' && /FIFO|named pipe/i.test(res.content), 'expected FIFO error message, got: ' + res.content);

    const direct = await loopGuardMod.readFifoNonBlocking(fifoPath, { timeoutMs: 80 });
    assert.strictEqual(direct.ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('hooks cap output at 50 KB', () => {
  assert.strictEqual(hooks.MAX_HOOK_OUTPUT_BYTES, 51200);
  const huge = 'A'.repeat(70 * 1024);
  const capped = hooks.capHookText(huge);
  assert.ok(Buffer.byteLength(capped, 'utf8') <= hooks.MAX_HOOK_OUTPUT_BYTES);
  assert.ok(capped.includes('truncated to 50 KB'));
});

test('MCP stdio client aborts and rejects pending requests on stdout flood without newlines', async () => {
  const client = new MCPClient();
  const script = `process.stdout.write('X'.repeat(80000)); setTimeout(() => {}, 2000);`;
  let err = null;
  try {
    await client.connect({
      transport: 'stdio',
      command: process.execPath,
      args: ['-e', script],
      maxStdoutBufferBytes: 16384,
      initTimeoutMs: 3000,
    });
  } catch (e) {
    err = e;
  }
  assert.ok(err && /flood|exited|MCP/i.test(err.message), 'expected flood protection error, got: ' + (err && err.message));
});

(async () => {
  let pass = 0;
  let fail = 0;
  console.log('\nPhase 1 Context Engine & Harness Verification');
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log('  ok   - ' + t.name);
    } catch (e) {
      fail++;
      console.error('  FAIL - ' + t.name + ': ' + (e && e.stack ? e.stack : e));
    }
  }
  console.log(`\nSummary: ${pass}/${tests.length} passed`);
  if (fail) process.exit(1);
})();
