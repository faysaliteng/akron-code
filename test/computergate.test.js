'use strict';
// Computer Use permission gate: every Computer Use tool must reach approveTool —
// the model calls them as `mcp__computer__*`, and even the read-only ones read
// the user's screen, so "read-only" is not "harmless". A denial must stop the
// call before any OS interaction happens.
const path = require('path');
const assert = require('assert');
const os = require('os');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-cugate-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { runTool, executorsByTool } = require(path.join(__dirname, '..', 'electron', 'tools.js'));

let pass = 0;
async function t(label, fn) {
  try { await fn(); pass++; console.log('  ok   ' + label); }
  catch (e) { console.log('  FAIL ' + label + ' :: ' + (e && e.message)); process.exitCode = 1; }
}

(async () => {
  console.log('Computer Use approval gate');

  await t('mcp__computer__screenshot maps to computer_screenshot', async () => {
    assert.strictEqual(executorsByTool.mcp__computer__screenshot, 'computer_screenshot');
  });

  await t('screenshot asks for approval and is blocked on deny', async () => {
    const calls = [];
    const res = await runTool('mcp__computer__screenshot', {}, {
      approveTool: async (name, args) => { calls.push({ name, args }); return false; },
    });
    assert.deepStrictEqual(calls.map((c) => c.name), ['mcp__computer__screenshot']);
    assert.strictEqual(res.isError, true);
    assert.strictEqual(res.denied, true);
  });

  await t('click is gated too', async () => {
    const calls = [];
    const res = await runTool('mcp__computer__click', { x: 1, y: 1 }, {
      approveTool: async (name) => { calls.push(name); return false; },
    });
    assert.deepStrictEqual(calls, ['mcp__computer__click']);
    assert.strictEqual(res.denied, true);
  });

  await t('screen_size is gated (read-only is still screen access)', async () => {
    const calls = [];
    const res = await runTool('mcp__computer__screen_size', {}, {
      approveTool: async (name) => { calls.push(name); return false; },
    });
    assert.deepStrictEqual(calls, ['mcp__computer__screen_size']);
    assert.strictEqual(res.denied, true);
  });

  await t('read-only Read does not prompt', async () => {
    const calls = [];
    const res = await runTool('Read', { file_path: path.join(TMP, 'nope.txt') }, {
      approveTool: async (name) => { calls.push(name); return false; },
    });
    assert.deepStrictEqual(calls, []);
    assert.strictEqual(!!res.denied, false);
  });

  await t('an allow verdict lets the tool proceed', async () => {
    const calls = [];
    const res = await runTool('mcp__computer__screen_size', {}, {
      approveTool: async (name) => { calls.push(name); return true; },
    });
    assert.deepStrictEqual(calls, ['mcp__computer__screen_size']);
    assert.strictEqual(!!res.denied, false);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log('\n' + pass + ' passed, ' + (process.exitCode ? 'at least 1' : '0') + ' failed');
})();
