'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { describe, it } = require('node:test');

const winLinux = require('../electron/computer-win-linux');
const computer = require('../electron/computer');
const hud = require('../electron/computer-hud');

describe('Computer Use 3-OS Claude-parity upgrades & HUD', () => {
  it('computes 60Hz cubic ease-out glide curves and skips tiny <12px moves', () => {
    const short = winLinux.computeGlidePoints(100, 100, 105, 104);
    assert.deepStrictEqual(short, [{ x: 105, y: 104 }]);

    const pts = winLinux.computeGlidePoints(0, 0, 800, 600);
    assert.ok(pts.length >= 8 && pts.length <= 14, `expected smooth curve points, got ${pts.length}`);
    assert.deepStrictEqual(pts[pts.length - 1], { x: 800, y: 600 });
    // Cubic ease-out decelerates near destination
    assert.ok(pts[1].x - pts[0].x >= pts[pts.length - 1].x - pts[pts.length - 2].x);
  });

  it('generates macOS smooth glide and 12-step drag CGEvent operations', () => {
    const ops = computer._internal.buildMacMouseOps('drag', {
      x: 50, y: 60, x2: 500, y2: 400, glideFrom: { x: 10, y: 10 },
    });
    const dragMatches = ops.match(/kCGEventLeftMouseDragged/g) || [];
    assert.ok(dragMatches.length >= 6, `expected multi-step drag, got ${dragMatches.length}`);
    assert.ok(ops.includes('kCGEventMouseMoved') && ops.includes('kCGEventLeftMouseDown') && ops.includes('kCGEventLeftMouseUp'));
  });

  it('builds Windows 11 Per-Monitor DPI v2, SendInput Unicode typing, multi-step drag, and UIAutomation menu scripts', () => {
    const typePs = winLinux.buildWinUnicodeTypePs();
    assert.ok(typePs.includes('SetProcessDpiAwarenessContext((IntPtr)(-4))'));
    assert.ok(typePs.includes('KEYEVENTF_UNICODE'));
    assert.ok(typePs.includes('SendInput('));

    const dragPs = winLinux.buildWinMousePs('drag', { x: 100, y: 100, x2: 400, y2: 300, button: 'right' });
    assert.ok(dragPs.includes('0x0008') && dragPs.includes('0x0010'));
    assert.ok((dragPs.match(/SetCursorPos/g) || []).length >= 5);

    const psLines = winLinux.WIN_USER32_PREAMBLE;
    assert.ok(psLines.includes('EnableDpi'));
  });

  it('supports Wayland & X11 mouse/drag commands and probes Linux/Windows capabilities cleanly', () => {
    const x11Drag = winLinux.buildLinuxMouseCommand('drag', { x: 10, y: 20, x2: 300, y2: 400, button: 'left' });
    assert.deepStrictEqual(x11Drag, ['mousemove', '--sync', '10', '20', 'mousedown', '1', 'mousemove', '--sync', '300', '400', 'mouseup', '1']);
    const capWin = winLinux.probeWinLinuxCapabilities('win32');
    assert.strictEqual(capWin.platform, 'win32');
    const capLin = winLinux.probeWinLinuxCapabilities('linux');
    assert.strictEqual(capLin.platform, 'linux');
    assert.ok(capLin.tools && 'ydotool' in capLin.tools && 'wtype' in capLin.tools && 'grim' in capLin.tools);
  });

  it('enforces HUD Stop/Escape emergency halt cooldown and wraps captures in withHiddenForCapture', async () => {
    hud.clearStop();
    assert.strictEqual(hud.isStopped(), false);
    hud.triggerEmergencyStop('unit_test_esc', 1000);
    assert.strictEqual(hud.isStopped(), true);
    assert.throws(() => hud.assertNotStopped(), /stopped by user/i);
    hud.clearStop();
    assert.strictEqual(hud.isStopped(), false);
    const out = await hud.withHiddenForCapture(async () => 'captured');
    assert.strictEqual(out, 'captured');
  });

  it('fixes ipc-windows-extensions preload path relative to electron/ipc/', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'electron/ipc/ipc-windows-extensions.js'), 'utf8');
    assert.ok(src.includes("path.join(__dirname, '..', 'preload.js')"));
    assert.ok(!src.includes("path.join(__dirname, 'preload.js')"));
    assert.ok(src.includes("ipcMain.handle('autobot:computerUseDoctor'"));
    assert.ok(src.includes("ipcMain.handle('autobot:computerUsePreviewHud'"));
  });

  it('keeps event loop alive for standalone REPL evalJS dynamic imports and suspends HUD shortcuts cleanly', async () => {
    const { spawnSync } = require('child_process');
    const runOut = spawnSync(process.execPath, [
      '-e',
      'require("./electron/repl").evalJS({ code: "const p = await import(\\"node:path\\"); console.log(p.basename(\\"/tmp/check.txt\\"))", reset: true }).then((r) => { if (!r.ok || r.output !== "check.txt") process.exit(2); console.log("REPL_STANDALONE_OK:" + r.output); })',
    ], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 15000,
    });
    assert.strictEqual(runOut.status, 0, `Standalone REPL exited ${runOut.status}: ${runOut.stderr || runOut.stdout}`);
    assert.ok(String(runOut.stdout || '').includes('REPL_STANDALONE_OK:check.txt'), runOut.stdout);

    const out = await hud.withSuspendedShortcut(async () => 'suspended_ok');
    assert.strictEqual(out, 'suspended_ok');

    assert.strictEqual(winLinux.winKeyCodeFor(','), 0xBC);
    assert.strictEqual(winLinux.winKeyCodeFor('/'), 0xBF);
    assert.ok(winLinux.buildWinKeyPs('ctrl+,').includes('188'));
    assert.ok(winLinux.buildWinKeyPs('ctrl+/').includes('191'));

    const mapped = computer._internal.resolvePoint(100, 50, { originX: -1920, originY: 0, width: 1920, height: 1080 });
    assert.deepStrictEqual(mapped, { x: -1820, y: 50 });
    const zbox = computer._internal.resolveZoomBox({ x1: 10, y1: 20, x2: 110, y2: 120 }, { originX: -1920, originY: 0, width: 1920, height: 1080 });
    assert.deepStrictEqual(zbox, { rx: -1910, ry: 20, rw: 100, rh: 100 });
  });
});

describe('AGENTS.md memory hierarchy, default seeding, save & reset', () => {
  it('seeds default AGENTS.md, loads workspace + global AGENTS.md, saves edits, and resets to default', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-agentsmd-home-'));
    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-agentsmd-proj-'));
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = tmpHome;
      const memory = require('../electron/memory');
      assert.ok(typeof memory.DEFAULT_AGENTS_MD === 'string' && memory.DEFAULT_AGENTS_MD.includes('Akron Code'));
      assert.ok(!/jailbreak|uncensored|ignore\s+safety/i.test(memory.DEFAULT_AGENTS_MD));

      const st1 = memory.getAgentsMdState(tmpProj);
      assert.strictEqual(st1.ok, true);
      assert.ok(fs.existsSync(st1.globalPath));
      assert.strictEqual(st1.globalContent, memory.DEFAULT_AGENTS_MD);

      const customGlobal = '# My Global Standing Rules\nAlways use pnpm.';
      const st2 = memory.saveAgentsMd({ scope: 'global', cwd: tmpProj, content: customGlobal });
      assert.strictEqual(st2.globalContent, customGlobal);

      const customProj = '# Repo AGENTS.md\nRun npm test after every edit.';
      const st3 = memory.saveAgentsMd({ scope: 'project', cwd: tmpProj, content: customProj });
      assert.strictEqual(st3.projectExists, true);
      assert.strictEqual(st3.projectContent, customProj);

      const memText = memory.loadMemoryText(tmpProj);
      assert.ok(memText.includes('Always use pnpm.'), 'global AGENTS.md must inject');
      assert.ok(memText.includes('Run npm test after every edit.'), 'workspace AGENTS.md must inject');

      const stReset = memory.resetAgentsMd({ scope: 'global', cwd: tmpProj });
      assert.strictEqual(stReset.globalContent, memory.DEFAULT_AGENTS_MD);
      assert.strictEqual(fs.readFileSync(stReset.globalPath, 'utf8'), memory.DEFAULT_AGENTS_MD);
    } finally {
      process.env.HOME = prevHome;
      fs.rmSync(tmpHome, { recursive: true, force: true });
      fs.rmSync(tmpProj, { recursive: true, force: true });
    }
  });
});
