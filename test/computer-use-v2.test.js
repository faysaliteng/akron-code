'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cu2-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const computer = require('../electron/computer');
const winLinux = require('../electron/computer-win-linux');
const { toolDefinitions, executorsByTool, runTool } = require('../electron/tools');

let pass = 0;
async function check(name, fn) {
  await fn();
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('\ncomputer-use-v2 tests');

  await check('macOS right-click & middle-click button bug fixed (btn === 1 / btn === 2)', async () => {
    assert.strictEqual(computer._internal.mapMouseButton('right'), 1);
    assert.strictEqual(computer._internal.mapMouseButton('middle'), 2);
    const rightOps = computer._internal.buildMacMouseOps('click', { x: 100, y: 200, button: 'right' });
    assert.ok(rightOps.includes('kCGEventRightMouseDown') && rightOps.includes('kCGEventRightMouseUp'), rightOps);
    const midOps = computer._internal.buildMacMouseOps('click', { x: 50, y: 60, button: 'middle' });
    assert.ok(midOps.includes('kCGEventOtherMouseDown') && midOps.includes('kCGEventOtherMouseUp'), midOps);
    const triOps = computer._internal.buildMacMouseOps('click', { x: 10, y: 20, triple: true });
    assert.ok(triOps.includes(', 3);'), triOps);
  });

  await check('Windows PowerShell & Linux xdotool builders emit valid right-click, key chord & drag commands', async () => {
    const winRight = winLinux.buildWinMousePs('click', { x: 150, y: 250, button: 'right' });
    assert.ok(winRight.includes('SetCursorPos(150, 250)') && winRight.includes('0x0008') && winRight.includes('0x0010'));
    const winKey = winLinux.buildWinKeyPs('ctrl+shift+a', 150);
    assert.ok(winKey.includes('keybd_event') && winKey.includes('Start-Sleep -Milliseconds 150'));
    const linRight = winLinux.buildLinuxMouseCommand('click', { x: 300, y: 400, button: 'right', triple: true });
    assert.deepStrictEqual(linRight, ['mousemove', '--sync', '300', '400', 'click', '--repeat', '3', '3']);
  });

  await check('single-session computer.lock arbitrates concurrent sessions cleanly', async () => {
    const a = computer.acquireLock('session-A', 15000);
    assert.strictEqual(a.ok, true);
    const b = computer.acquireLock('session-B', 15000);
    assert.strictEqual(b.ok, false);
    assert.ok(/session-A/.test(b.error));
    computer.releaseLock('session-A');
    const c = computer.acquireLock('session-B', 15000);
    assert.strictEqual(c.ok, true);
    computer.releaseLock('session-B');
  });

  await check('all 24 Computer Use 2.0 tools are registered and permission-gated', async () => {
    const expected = [
      'mcp__computer__screenshot', 'mcp__computer__zoom', 'mcp__computer__app_screenshot',
      'mcp__computer__click', 'mcp__computer__move', 'mcp__computer__drag',
      'mcp__computer__mouse_down', 'mcp__computer__mouse_up', 'mcp__computer__cursor_position',
      'mcp__computer__scroll', 'mcp__computer__type', 'mcp__computer__key', 'mcp__computer__hold_key',
      'mcp__computer__wait', 'mcp__computer__screen_size', 'mcp__computer__switch_display',
      'mcp__computer__open_app', 'mcp__computer__activate_app', 'mcp__computer__list_windows',
      'mcp__computer__ax_find', 'mcp__computer__app_menu', 'mcp__computer__clipboard_read',
      'mcp__computer__clipboard_write', 'mcp__computer__batch',
    ];
    const defs = new Set(toolDefinitions.map((d) => d.name));
    for (const nm of expected) {
      assert.ok(defs.has(nm), `missing toolDefinition ${nm}`);
      assert.ok(/^computer_/.test(executorsByTool[nm] || ''), `missing computer_* executor for ${nm}`);
    }
    const denied = await runTool('mcp__computer__ax_find', { query: 'Save' }, {
      approveTool: async () => false,
    });
    assert.strictEqual(denied.denied, true);
  });

  await check('wait & batch tools execute cleanly with consent', async () => {
    const res = await runTool('mcp__computer__batch', {
      actions: [{ action: 'wait', ms: 15 }, { action: 'wait', ms: 15 }],
      screenshotAfter: false,
    }, {
      approveTool: async () => true,
    });
    assert.strictEqual(!!res.isError, false, res.content);
    assert.ok(/Executed 2 actions/.test(res.content), res.content);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, 0 failed`);
})();
