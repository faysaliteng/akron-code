'use strict';
/**
 * Computer Use 2.0 — Cross-platform macOS, Windows 11/10 & Linux OS control.
 *
 * Unifies Claude Desktop (`computer-use` two-tier physical + app_* / zoom /
 * ax_find / menu / batch + single-session lock) and n8n desktop batch actions
 * with zero native C++ (`node-gyp`) addons:
 *   - macOS (`darwin`):  JXA + CoreGraphics CGEventPost + System Events + screencapture + sips 1x normalization
 *   - Windows (`win32`): PowerShell + user32.dll + System.Drawing + UIAutomationClient (computer-win-linux.js)
 *   - Linux (`linux`):   xdotool/ydotool + wmctrl + scrot/import/grim + xclip/wl-copy (computer-win-linux.js)
 */

const { exec, execFileSync, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const winLinux = require('./computer-win-linux');

let enabled = true;
let lastShot = null;
let activeDisplayIndex = 0;

function setEnabled(v) { enabled = !!v; return enabled; }
function isEnabled() { return enabled; }
function gate() { if (!enabled) throw new Error('Computer control is disabled. Enable it in Settings → Features.'); }

// ── Single-session physical input lock (prevents multi-agent cursor wars) ──
function lockFilePath() {
  return path.join(os.homedir(), '.autobot', 'computer.lock');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try { process.kill(n, 0); return true; } catch (_) { return false; }
}

function acquireLock(ownerId = 'default', ttlMs = 15000) {
  const fp = lockFilePath();
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
    if (fs.existsSync(fp)) {
      const cur = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const age = Date.now() - (Number(cur.updatedAt) || 0);
      if (cur.ownerId !== ownerId && age < ttlMs && isPidAlive(cur.pid)) {
        return {
          ok: false,
          holder: cur.ownerId,
          error: `Another session (${cur.ownerId}, pid=${cur.pid}) currently holds the computer input lock. Use app_* tools or wait for it to release.`,
        };
      }
    }
    fs.writeFileSync(fp, JSON.stringify({ ownerId, pid: process.pid, updatedAt: Date.now() }), { mode: 0o600 });
    return { ok: true };
  } catch (_) {
    return { ok: true };
  }
}

function releaseLock(ownerId = 'default') {
  const fp = lockFilePath();
  try {
    if (!fs.existsSync(fp)) return { ok: true };
    const cur = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!ownerId || cur.ownerId === ownerId || !isPidAlive(cur.pid)) {
      fs.rmSync(fp, { force: true });
    }
  } catch (_) {}
  return { ok: true };
}

function execP(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (opts.input != null && child.stdin) {
      child.stdin.write(String(opts.input));
      child.stdin.end();
    }
  });
}

async function osascript(script) {
  const file = path.join(os.tmpdir(), `autobot-osa-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.scpt`);
  fs.writeFileSync(file, String(script || ''), 'utf8');
  try {
    const { err, stdout, stderr } = await execP(`/usr/bin/osascript "${file}"`, { timeout: 20000 });
    if (err) {
      const msg = (stderr || err.message || '').trim();
      if (/assistive access|not allowed/i.test(msg)) {
        throw new Error('Accessibility permission missing: open System Settings › Privacy & Security › Accessibility and enable Akron Code.');
      }
      throw new Error(msg || 'osascript failed');
    }
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

async function jxa(src) {
  const file = path.join(os.tmpdir(), `autobot-jxa-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.js`);
  fs.writeFileSync(file, src, 'utf8');
  try {
    const { err, stdout, stderr } = await execP(`/usr/bin/osascript -l JavaScript "${file}"`, { timeout: 20000 });
    if (err) throw new Error((stderr || err.message || '').trim() || 'JXA failed');
    return stdout.trim();
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
}

const JXA_MOUSE = (ops) => `
ObjC.import('CoreGraphics');
function post(t, x, y, btn, clicks) {
  const p = $.CGPointMake(x, y);
  const e = $.CGEventCreateMouseEvent(null, t, p, btn);
  if (e && (typeof e.isNil !== 'function' || !e.isNil())) {
    if (clicks) $.CGEventSetIntegerValueField(e, $.kCGMouseEventClickState, clicks);
    $.CGEventPost($.kCGHIDEventTap, e);
  }
}
${ops}
`;

function mapMouseButton(button) {
  const b = String(button || 'left').toLowerCase().trim();
  if (b === 'right' || b === '2') return 1;
  if (b === 'middle' || b === '3') return 2;
  return 0;
}

function buildMacMouseOps(kind, opts = {}) {
  const x = Math.round(Number(opts.x) || 0);
  const y = Math.round(Number(opts.y) || 0);
  const x2 = Math.round(Number(opts.x2 != null ? opts.x2 : x));
  const y2 = Math.round(Number(opts.y2 != null ? opts.y2 : y));
  const btn = mapMouseButton(opts.button);
  const down = btn === 1 ? '$.kCGEventRightMouseDown' : btn === 2 ? '$.kCGEventOtherMouseDown' : '$.kCGEventLeftMouseDown';
  const up = btn === 1 ? '$.kCGEventRightMouseUp' : btn === 2 ? '$.kCGEventOtherMouseUp' : '$.kCGEventLeftMouseUp';
  const dragEvt = btn === 1 ? '$.kCGEventRightMouseDragged' : btn === 2 ? '$.kCGEventOtherMouseDragged' : '$.kCGEventLeftMouseDragged';

  if (kind === 'move') return `post($.kCGEventMouseMoved, ${x}, ${y}, 0, 0);`;
  if (kind === 'down') return `post(${down}, ${x}, ${y}, ${btn}, 1);`;
  if (kind === 'up') return `post(${up}, ${x}, ${y}, ${btn}, 1);`;
  if (kind === 'drag') {
    return `post($.kCGEventMouseMoved, ${x}, ${y}, 0, 0);\n  post(${down}, ${x}, ${y}, ${btn}, 1);\n  post(${dragEvt}, ${x2}, ${y2}, ${btn}, 1);\n  post(${up}, ${x2}, ${y2}, ${btn}, 1);`;
  }
  const clicks = opts.triple ? 3 : (opts.double ? 2 : 1);
  if (clicks === 1) return `post(${down}, ${x}, ${y}, ${btn}, 1);\n  post(${up}, ${x}, ${y}, ${btn}, 1);`;
  const lines = [];
  for (let c = 1; c <= clicks; c++) {
    lines.push(`post(${down}, ${x}, ${y}, ${btn}, ${c});`);
    lines.push(`post(${up}, ${x}, ${y}, ${btn}, ${c});`);
  }
  return lines.join('\n  ');
}

/** Mouse move/click/drag/down/up in 1x logical screen points across macOS, Windows, and Linux. */
async function mouse(kind, opts = {}, platform = process.platform) {
  gate();
  const x = Math.round(Number(opts.x) || 0);
  const y = Math.round(Number(opts.y) || 0);
  const x2 = Math.round(Number(opts.x2 != null ? opts.x2 : x));
  const y2 = Math.round(Number(opts.y2 != null ? opts.y2 : y));
  const btn = mapMouseButton(opts.button);

  if (platform === 'win32') {
    winLinux.runPS(winLinux.buildWinMousePs(kind, { ...opts, x, y, x2, y2, btn }));
    return { ok: true, kind, x, y, button: btn === 1 ? 'right' : btn === 2 ? 'middle' : 'left', platform };
  }
  if (platform === 'linux') {
    winLinux.linuxMouse(kind, { ...opts, x, y, x2, y2, btn });
    return { ok: true, kind, x, y, button: btn === 1 ? 'right' : btn === 2 ? 'middle' : 'left', platform };
  }
  const ops = buildMacMouseOps(kind, { ...opts, x, y, x2, y2 });
  await jxa(JXA_MOUSE(ops));
  return { ok: true, kind, x, y, button: btn === 1 ? 'right' : btn === 2 ? 'middle' : 'left', platform };
}

async function click(x, y, button = 'left', double = false, opts = {}) {
  return mouse('click', { x, y, button, double, triple: !!(opts && opts.triple) });
}
async function move(x, y) { return mouse('move', { x, y }); }
async function drag(x1, y1, x2, y2, button = 'left') { return mouse('drag', { x: x1, y: y1, x2, y2, button }); }
async function mouseDown(x, y, button = 'left') { return mouse('down', { x, y, button }); }
async function mouseUp(x, y, button = 'left') { return mouse('up', { x, y, button }); }

async function cursorPosition(platform = process.platform) {
  gate();
  if (platform === 'win32') {
    const out = winLinux.runPS(`${winLinux.WIN_USER32_PREAMBLE || ''}\nAdd-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class CurPos { [StructLayout(LayoutKind.Sequential)] public struct PT { public int X; public int Y; } [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool GetCursorPos(out PT p); }' -ErrorAction SilentlyContinue\n[CurPos]::SetProcessDPIAware() | Out-Null\n$p = New-Object CurPos+PT\n[CurPos]::GetCursorPos([ref]$p) | Out-Null\nConvertTo-Json @{ x = $p.X; y = $p.Y } -Compress`);
    return JSON.parse(out);
  }
  if (platform === 'linux') {
    if (winLinux.linuxHas('xdotool')) {
      const out = winLinux.linuxExec('xdotool', ['getmouselocation', '--shell']);
      const mx = /X=(\d+)/.exec(out);
      const my = /Y=(\d+)/.exec(out);
      return { x: mx ? Number(mx[1]) : 0, y: my ? Number(my[1]) : 0 };
    }
    return { x: 0, y: 0 };
  }
  const out = await jxa(`ObjC.import('CoreGraphics'); const ev = $.CGEventCreate(null); const p = $.CGEventGetLocation(ev); JSON.stringify({ x: Math.round(p.x), y: Math.round(p.y) });`);
  return JSON.parse(out);
}

async function scroll(direction = 'down', amount = 3, opts = {}) {
  gate();
  const dir = { up: 1, down: -1, left: -1, right: 1 };
  const d = dir[direction] != null ? dir[direction] : -1;
  const n = Math.max(1, Math.min(Number(amount) || 3, 60));
  const vertical = direction === 'up' || direction === 'down';
  if (opts && opts.x != null && opts.y != null) {
    await move(opts.x, opts.y);
  }
  if (process.platform === 'win32') {
    const delta = (vertical ? d : -d) * n * 120;
    const flag = vertical ? '0x0800' : '0x01000';
    winLinux.runPS(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Scr { [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, int d, UIntPtr e); }' -ErrorAction SilentlyContinue\n[Scr]::mouse_event(${flag}, 0, 0, ${delta}, [UIntPtr]::Zero)\n"ok"`);
    return { ok: true, direction, amount: n };
  }
  if (process.platform === 'linux') {
    if (winLinux.linuxHas('xdotool')) {
      const btn = direction === 'up' ? '4' : direction === 'down' ? '5' : direction === 'left' ? '6' : '7';
      winLinux.linuxExec('xdotool', ['click', '--repeat', String(n), btn]);
      return { ok: true, direction, amount: n };
    }
    throw new Error('xdotool required for Linux scrolling.');
  }
  const dy = vertical ? d * n : 0;
  const dx = vertical ? 0 : d * n;
  await jxa(`ObjC.import('CoreGraphics');\nconst e = $.CGEventCreateScrollWheelEvent(null, 1, 2, ${dy}, ${dx});\n$.CGEventPost($.kCGHIDEventTap, e);\n'ok';`);
  return { ok: true, direction, amount: n };
}

// ── Keyboard ──────────────────────────────────────────────────────────────────

const KEYCODES = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11,
  q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19, '3': 20, '4': 21,
  '6': 22, '5': 23, '=': 24, '9': 25, '7': 26, '-': 27, '8': 28, '0': 29,
  ']': 30, o: 31, u: 32, '[': 33, i: 34, p: 35, l: 37, j: 38, "'": 39, k: 40,
  ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46, '.': 47, '`': 50,
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, cmd: 55, command: 55, meta: 55, shift: 56, capslock: 57,
  alt: 58, option: 58, ctrl: 59, control: 59,
  left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
};

async function macCgType(text) {
  const s = String(text);
  if (!s) return 'typed';
  await jxa(`
ObjC.import('CoreGraphics');
const str = ${JSON.stringify(s)};
for (let i = 0; i < str.length; i += 16) {
  const chunk = str.slice(i, i + 16);
  const down = $.CGEventCreateKeyboardEvent(null, 0, true);
  $.CGEventKeyboardSetUnicodeString(down, chunk.length, chunk);
  $.CGEventPost($.kCGHIDEventTap, down);
  const up = $.CGEventCreateKeyboardEvent(null, 0, false);
  $.CGEventKeyboardSetUnicodeString(up, chunk.length, chunk);
  $.CGEventPost($.kCGHIDEventTap, up);
}
'typed';
`);
  return 'typed';
}

async function macCgKey(keys, holdMs = 0) {
  const parts = String(keys || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  let flags = 0;
  let main = null;
  for (const p of parts) {
    if (['cmd', 'command', 'meta'].includes(p)) flags |= 0x100000; // kCGEventFlagMaskCommand
    else if (['shift'].includes(p)) flags |= 0x020000;            // kCGEventFlagMaskShift
    else if (['alt', 'option'].includes(p)) flags |= 0x080000;     // kCGEventFlagMaskAlternate
    else if (['ctrl', 'control'].includes(p)) flags |= 0x040000;   // kCGEventFlagMaskControl
    else main = p;
  }
  if (!main) main = parts[parts.length - 1] || 'return';
  const kc = KEYCODES[main] != null ? KEYCODES[main] : null;
  const delaySec = holdMs > 0 ? (holdMs / 1000).toFixed(3) : '0';
  if (kc != null) {
    await jxa(`
ObjC.import('CoreGraphics');
const down = $.CGEventCreateKeyboardEvent(null, ${kc}, true);
if (${flags}) $.CGEventSetFlags(down, ${flags});
$.CGEventPost($.kCGHIDEventTap, down);
if (${Number(delaySec) > 0}) delay(${delaySec});
const up = $.CGEventCreateKeyboardEvent(null, ${kc}, false);
if (${flags}) $.CGEventSetFlags(up, ${flags});
$.CGEventPost($.kCGHIDEventTap, up);
'ok';
`);
    return 'ok';
  }
  if (main.length === 1 && !flags) {
    await macCgType(main);
    return 'ok';
  }
  await jxa(`
ObjC.import('CoreGraphics');
const ch = ${JSON.stringify(main)};
const down = $.CGEventCreateKeyboardEvent(null, 0, true);
if (${flags}) $.CGEventSetFlags(down, ${flags});
$.CGEventKeyboardSetUnicodeString(down, ch.length, ch);
$.CGEventPost($.kCGHIDEventTap, down);
if (${Number(delaySec) > 0}) delay(${delaySec});
const up = $.CGEventCreateKeyboardEvent(null, 0, false);
if (${flags}) $.CGEventSetFlags(up, ${flags});
$.CGEventPost($.kCGHIDEventTap, up);
'ok';
`);
  return 'ok';
}

async function type(text, platform = process.platform) {
  gate();
  const s = String(text);
  if (platform === 'win32') {
    if (/[^\x00-\x7F]/.test(s)) {
      winLinux.runPS('Set-Clipboard -Value ([Console]::In.ReadToEnd())', { input: s });
      return key('ctrl+v');
    }
    winLinux.runPS(`Add-Type -AssemblyName System.Windows.Forms\n$txt = [Console]::In.ReadToEnd()\n$escaped = $txt -replace '([+^%~(){}\\[\\]])', '{$1}'\n[System.Windows.Forms.SendKeys]::SendWait($escaped)\n"ok"`, { input: s });
    return 'typed';
  }
  if (platform === 'linux') {
    if (winLinux.linuxHas('xdotool')) {
      winLinux.linuxExec('xdotool', ['type', '--clearmodifiers', '--delay', '8', s]);
      return 'typed';
    }
    if (winLinux.linuxHas('ydotool')) {
      winLinux.linuxExec('ydotool', ['type', s]);
      return 'typed';
    }
    throw new Error('xdotool or ydotool required for typing on Linux.');
  }
  return macCgType(s);
}

async function key(keys, platform = process.platform) {
  gate();
  if (platform === 'win32') {
    winLinux.runPS(winLinux.buildWinKeyPs(keys, 0));
    return 'ok';
  }
  if (platform === 'linux') {
    const combo = String(keys || '').split('+').map(winLinux.linuxKeyToken).filter(Boolean).join('+');
    if (winLinux.linuxHas('xdotool')) {
      winLinux.linuxExec('xdotool', ['key', '--clearmodifiers', combo]);
      return 'ok';
    }
    throw new Error('xdotool required for key chords on Linux.');
  }
  return macCgKey(keys, 0);
}

async function holdKey(keys, durationMs = 500) {
  gate();
  const ms = Math.min(Math.max(50, Number(durationMs) || 500), 10000);
  if (process.platform === 'win32') {
    winLinux.runPS(winLinux.buildWinKeyPs(keys, ms));
    return { ok: true, keys, durationMs: ms };
  }
  if (process.platform === 'linux') {
    const combo = String(keys || '').split('+').map(winLinux.linuxKeyToken).filter(Boolean).join('+');
    winLinux.linuxExec('xdotool', ['keydown', combo]);
    await wait(ms);
    winLinux.linuxExec('xdotool', ['keyup', combo]);
    return { ok: true, keys, durationMs: ms };
  }
  await macCgKey(keys, ms);
  return { ok: true, keys, durationMs: ms };
}

async function wait(ms = 1000) {
  const clamped = Math.min(Math.max(10, Number(ms) || 1000), 30000);
  await new Promise((r) => setTimeout(r, clamped));
  return { ok: true, waitedMs: clamped };
}

// ── Apps / Windows / Clipboard ────────────────────────────────────────────────

async function openApp(nameOrPath) {
  gate();
  const target = String(nameOrPath).trim();
  if (process.platform === 'win32') {
    winLinux.runPS(`Start-Process ${JSON.stringify(target)}`);
    return { ok: true, opened: target };
  }
  if (process.platform === 'linux') {
    const { spawn } = require('child_process');
    const child = spawn('sh', ['-c', target + ' >/dev/null 2>&1 &'], { detached: true, stdio: 'ignore' });
    child.unref();
    return { ok: true, opened: target };
  }
  const { err } = await execP(`/usr/bin/open ${JSON.stringify(target)}`, { timeout: 15000 });
  if (err) throw new Error('open failed: ' + err.message);
  return { ok: true, opened: target };
}

async function activateApp(name) {
  gate();
  const target = String(name || '').trim();
  if (process.platform === 'win32') {
    const wins = winLinux.winListWindows();
    const hit = wins.find((w) => w.app.toLowerCase().includes(target.toLowerCase()) || w.title.toLowerCase().includes(target.toLowerCase()));
    if (!hit) throw new Error(`Window/app not found: ${target}`);
    winLinux.runPS(`${winLinux.WIN_USER32_PREAMBLE || ''}\nAdd-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Act { [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }' -ErrorAction SilentlyContinue\n[Act]::SetForegroundWindow([IntPtr]::new(${hit.windowId})) | Out-Null`);
    return `Activated ${hit.app}: ${hit.title}`;
  }
  if (process.platform === 'linux') {
    if (winLinux.linuxHas('wmctrl')) {
      winLinux.linuxExec('wmctrl', ['-a', target]);
      return `Activated ${target}`;
    }
    winLinux.linuxExec('xdotool', ['search', '--name', target, 'windowactivate']);
    return `Activated ${target}`;
  }
  return osascript(`tell application ${JSON.stringify(target)} to activate`);
}

async function frontmostApp() {
  if (process.platform === 'win32') {
    const out = winLinux.runPS(`Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FG { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p); }' -ErrorAction SilentlyContinue\n$h = [FG]::GetForegroundWindow(); [uint32]$p = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$p); (Get-Process -Id $p -ErrorAction SilentlyContinue).ProcessName`);
    return out || 'unknown';
  }
  if (process.platform === 'linux') {
    if (winLinux.linuxHas('xdotool')) {
      return winLinux.linuxExec('xdotool', ['getactivewindow', 'getwindowname']);
    }
    return 'unknown';
  }
  return osascript('tell application "System Events" to get name of first application process whose frontmost is true');
}

async function listWindowsStructured() {
  if (process.platform === 'win32') return winLinux.winListWindows();
  if (process.platform === 'linux') return winLinux.linuxListWindows();
  const out = await jxa(`
ObjC.import('CoreGraphics');
const cf = $.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, $.kCGNullWindowID);
const ns = ObjC.castRefToObject(cf);
const count = ns ? Number(ns.count) || 0 : 0;
const rows = [];
for (let i = 0; i < count; i++) {
  const d = ns.objectAtIndex(i);
  const layer = Number(ObjC.unwrap(d.objectForKey('kCGWindowLayer')) || 0);
  const alphaRaw = ObjC.unwrap(d.objectForKey('kCGWindowAlpha'));
  const alpha = alphaRaw == null ? 1 : Number(alphaRaw);
  if (layer !== 0 || alpha === 0) continue;
  const b = ObjC.deepUnwrap(d.objectForKey('kCGWindowBounds')) || {};
  if ((b.Width || 0) < 20 || (b.Height || 0) < 20) continue;
  rows.push({
    windowId: Number(ObjC.unwrap(d.objectForKey('kCGWindowNumber')) || 0),
    app: String(ObjC.unwrap(d.objectForKey('kCGWindowOwnerName')) || ''),
    title: String(ObjC.unwrap(d.objectForKey('kCGWindowName')) || ''),
    x: Math.round(b.X || 0),
    y: Math.round(b.Y || 0),
    width: Math.round(b.Width || 0),
    height: Math.round(b.Height || 0),
  });
}
JSON.stringify(rows.slice(0, 60));
`);
  return out ? JSON.parse(out) : [];
}

async function listWindows() {
  const rows = await listWindowsStructured();
  if (!rows.length) return '(no visible windows)';
  return rows.map((w) => `[${w.windowId}] ${w.app} | ${w.title || '(untitled)'} | pos=${w.x},${w.y} | size=${w.width}x${w.height}`).join('\n');
}

async function clipboardRead() {
  if (process.platform === 'win32') return winLinux.runPS('Get-Clipboard -Raw');
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY && winLinux.linuxHas('wl-paste')) return winLinux.linuxExec('wl-paste', []);
    if (winLinux.linuxHas('xclip')) return winLinux.linuxExec('xclip', ['-o', '-selection', 'clipboard']);
    if (winLinux.linuxHas('xsel')) return winLinux.linuxExec('xsel', ['--clipboard', '--output']);
    return '';
  }
  return (await execP('/usr/bin/pbpaste', { timeout: 5000 })).stdout;
}

async function clipboardWrite(text) {
  const str = String(text == null ? '' : text);
  if (process.platform === 'win32') {
    winLinux.runPS('Set-Clipboard -Value ([Console]::In.ReadToEnd())', { input: str });
    return { ok: true };
  }
  if (process.platform === 'linux') {
    if (process.env.WAYLAND_DISPLAY && winLinux.linuxHas('wl-copy')) {
      winLinux.linuxExec('wl-copy', [], { input: str });
      return { ok: true };
    }
    if (winLinux.linuxHas('xclip')) {
      winLinux.linuxExec('xclip', ['-i', '-selection', 'clipboard'], { input: str });
      return { ok: true };
    }
    if (winLinux.linuxHas('xsel')) {
      winLinux.linuxExec('xsel', ['--clipboard', '--input'], { input: str });
      return { ok: true };
    }
  }
  await execP('/usr/bin/pbcopy', { input: str, timeout: 5000 });
  return { ok: true };
}

// ── Screenshots, Retina 1x Scaling, Zoom & App-Scoped Capture ──────────────────

function screenPointsSync(displayIdx = activeDisplayIndex) {
  if (process.platform === 'win32') return winLinux.winScreenPointsSync();
  if (process.platform === 'linux') return winLinux.linuxScreenPointsSync();
  try {
    const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('CoreGraphics');
       const maxD = 8; const out = $.malloc(4 * maxD); const cnt = $.malloc(4);
       let id = $.CGMainDisplayID();
       const ids = ObjC.wrap($.CGGetActiveDisplayList ? [] : []);
       const b = $.CGDisplayBounds(id);
       const s = $.CGDisplayPixelsWide(id) / (b.size.width || 1);
       JSON.stringify({ width: b.size.width, height: b.size.height, scale: Math.round(s * 100) / 100, displayCount: 1 });`],
      { timeout: 10000 });
    const out = String(r.stdout || '').trim();
    if (out) {
      const o = JSON.parse(out);
      return { width: Math.round(o.width), height: Math.round(o.height), scale: o.scale || 1, displayIndex: displayIdx };
    }
  } catch (_) {}
  return { width: 1280, height: 800, scale: 1, displayIndex: displayIdx };
}

async function screenSize() {
  gate();
  return screenPointsSync(activeDisplayIndex);
}

async function switchDisplay(displayIndex = 0) {
  gate();
  const idx = Math.max(0, Math.min(Number(displayIndex) || 0, 7));
  activeDisplayIndex = idx;
  return { ok: true, displayIndex: idx, ...(screenPointsSync(idx)) };
}

function normalizePngToLogicalWidth(file, targetWidth) {
  if (process.platform !== 'darwin' || !targetWidth || targetWidth <= 0) return;
  try {
    execFileSync('/usr/bin/sips', ['--resampleWidth', String(Math.round(targetWidth)), file], { stdio: 'ignore', timeout: 8000 });
  } catch (_) {}
}

async function captureDisplayViaElectron(displayIdx = activeDisplayIndex) {
  let el = null;
  try { el = require('electron'); } catch (_) { el = null; }
  if (!el || !el.desktopCapturer || !el.nativeImage) {
    return { ok: false, error: 'desktopCapturer unavailable (not in Electron main process)' };
  }
  try {
    const pts = screenPointsSync(displayIdx);
    const scale = Math.max(1, pts.scale || 1);
    const sources = await el.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.max(1, Math.round(pts.width * scale)),
        height: Math.max(1, Math.round(pts.height * scale)),
      },
    });
    const src = sources[displayIdx] || sources[0];
    if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
      return { ok: false, error: 'no screen source / empty pixels from desktopCapturer' };
    }
    return { ok: true, image: src.thumbnail, pts, scale };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function sanitizeScreenshotDir(rawDir, fallbackSubdir = 'autobot-computer') {
  if (!rawDir) return path.join(os.tmpdir(), fallbackSubdir);
  const resolved = path.resolve(String(rawDir));
  try {
    const winSec = require('./window-security');
    if (winSec && typeof winSec.isBlockedCredentialTarget === 'function' && winSec.isBlockedCredentialTarget(resolved)) {
      throw new Error(`screenshot dir "${rawDir}" points inside a protected credential location`);
    }
  } catch (e) {
    if (e && /protected credential/i.test(e.message)) throw e;
  }
  if (/^\/(?:etc|System|usr|bin|sbin|private\/etc)(?:\/|$)/i.test(resolved)) {
    throw new Error(`screenshot dir "${rawDir}" targets a restricted system directory`);
  }
  return resolved;
}

function execFileP(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, opts, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function screenshot(opts = {}) {
  gate();
  const dir = sanitizeScreenshotDir(opts.dir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${Date.now()}.png`);
  const dispIdx = opts.displayIndex != null ? Number(opts.displayIndex) : activeDisplayIndex;

  if (process.platform === 'win32') {
    const dim = winLinux.winScreenshot(file, null, dispIdx);
    const buf = fs.readFileSync(file);
    lastShot = file;
    return { path: file, size: buf.length, width: dim.width, height: dim.height, scale: 1, nativeScale: 1, displayIndex: dispIdx, b64: buf.toString('base64') };
  }
  if (process.platform === 'linux') {
    winLinux.linuxScreenshot(file, null, null);
    const size = screenPointsSync(dispIdx);
    const buf = fs.readFileSync(file);
    lastShot = file;
    return { path: file, size: buf.length, width: size.width, height: size.height, scale: 1, nativeScale: 1, displayIndex: dispIdx, b64: buf.toString('base64') };
  }

  const capArgs = [];
  if (dispIdx > 0) capArgs.push('-D', String(dispIdx + 1));
  capArgs.push('-x', file);
  const { err } = await execFileP('/usr/sbin/screencapture', capArgs, { timeout: 20000 });
  const size = screenPointsSync(dispIdx);
  let haveShot = !err && fs.existsSync(file) && fs.statSync(file).size > 0;
  if (!haveShot) {
    const viaEl = await captureDisplayViaElectron(dispIdx);
    if (!viaEl.ok) {
      throw new Error(`screenshot failed: screencapture (${err ? err.message : 'empty file'}); desktopCapturer fallback (${viaEl.error || 'failed'}) — grant Screen Recording permission to Akron Code.`);
    }
    const png = viaEl.image.toPNG();
    if (!png || !png.length) {
      throw new Error(`screenshot failed: screencapture (${err ? err.message : 'empty file'}); desktopCapturer fallback (empty PNG).`);
    }
    fs.writeFileSync(file, png);
  }
  if (opts.normalizeToLogical !== false && size.scale > 1 && size.width > 0) {
    normalizePngToLogicalWidth(file, size.width);
  }
  const buf = fs.readFileSync(file);
  lastShot = file;
  return {
    path: file,
    size: buf.length,
    width: size.width,
    height: size.height,
    scale: 1,
    nativeScale: size.scale,
    displayIndex: dispIdx,
    b64: buf.toString('base64'),
  };
}

function lastScreenshot() { return lastShot; }

async function zoom({ x1 = 0, y1 = 0, x2 = 400, y2 = 300, dir } = {}) {
  gate();
  const rx = Math.round(Math.min(Number(x1) || 0, Number(x2) || 0));
  const ry = Math.round(Math.min(Number(y1) || 0, Number(y2) || 0));
  const rw = Math.max(16, Math.round(Math.abs((Number(x2) || 0) - (Number(x1) || 0))));
  const rh = Math.max(16, Math.round(Math.abs((Number(y2) || 0) - (Number(y1) || 0))));
  const outDir = sanitizeScreenshotDir(dir);
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `zoom-${Date.now()}.png`);

  if (process.platform === 'win32') {
    winLinux.winScreenshot(file, { x: rx, y: ry, w: rw, h: rh }, activeDisplayIndex);
  } else if (process.platform === 'linux') {
    winLinux.linuxScreenshot(file, { x: rx, y: ry, w: rw, h: rh }, null);
  } else {
    const { err } = await execFileP('/usr/sbin/screencapture', ['-x', '-R', `${rx},${ry},${rw},${rh}`, file], { timeout: 20000 });
    const haveShot = !err && fs.existsSync(file) && fs.statSync(file).size > 0;
    if (!haveShot) {
      const viaEl = await captureDisplayViaElectron(activeDisplayIndex);
      if (!viaEl.ok) {
        throw new Error(`zoom failed: screencapture (${err ? err.message : 'empty file'}); desktopCapturer fallback (${viaEl.error || 'failed'}).`);
      }
      const imgSize = viaEl.image.getSize();
      const s = viaEl.pts && viaEl.pts.width ? (imgSize.width / viaEl.pts.width) : (viaEl.scale || 1);
      const cx = Math.max(0, Math.min(imgSize.width - 1, Math.round(rx * s)));
      const cy = Math.max(0, Math.min(imgSize.height - 1, Math.round(ry * s)));
      const cw = Math.max(1, Math.min(imgSize.width - cx, Math.round(rw * s)));
      const ch = Math.max(1, Math.min(imgSize.height - cy, Math.round(rh * s)));
      const cropped = viaEl.image.crop({ x: cx, y: cy, width: cw, height: ch });
      const png = cropped && !cropped.isEmpty() ? cropped.toPNG() : viaEl.image.toPNG();
      if (!png || !png.length) {
        throw new Error(`zoom failed: screencapture (${err ? err.message : 'empty file'}); desktopCapturer fallback (empty cropped PNG).`);
      }
      fs.writeFileSync(file, png);
    }
  }
  const buf = fs.readFileSync(file);
  lastShot = file;
  return { path: file, size: buf.length, region: { x: rx, y: ry, width: rw, height: rh }, b64: buf.toString('base64') };
}

// Capture a single window through Electron's desktopCapturer (uses the app's
// own Screen Recording grant) and write it to `file`. Returns {ok,error}.
async function appScreenshotViaElectron(target, file) {
  let el = null;
  try { el = require('electron'); } catch (_) { el = null; }
  if (!el || !el.desktopCapturer || !el.nativeImage) {
    return { ok: false, error: 'desktopCapturer unavailable (not in Electron main process)' };
  }
  try {
    const sources = await el.desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: Math.max(1, (target.width || 800) * 2), height: Math.max(1, (target.height || 600) * 2) },
    });
    const wantName = String(target.app || '').toLowerCase();
    const wantTitle = String(target.title || '').toLowerCase();
    let src = target.windowId ? sources.find((s) => String(s.id || '').includes(`:${target.windowId}:`) || String(s.id || '').endsWith(`:${target.windowId}`)) : null;
    if (!src && wantTitle) src = sources.find((s) => String(s.name || '').toLowerCase() === wantTitle);
    if (!src && wantTitle) src = sources.find((s) => String(s.name || '').toLowerCase().includes(wantTitle));
    if (!src && wantName) src = sources.find((s) => String(s.name || '').toLowerCase().includes(wantName));
    let png = src && src.thumbnail && !src.thumbnail.isEmpty() ? src.thumbnail.toPNG() : null;
    if ((!png || !png.length) && target.width > 0 && target.height > 0) {
      const screenFb = await captureDisplayViaElectron(activeDisplayIndex);
      if (screenFb.ok && screenFb.image) {
        const imgSize = screenFb.image.getSize();
        const s = screenFb.pts && screenFb.pts.width ? (imgSize.width / screenFb.pts.width) : (screenFb.scale || 1);
        const cx = Math.max(0, Math.min(imgSize.width - 1, Math.round((target.x || 0) * s)));
        const cy = Math.max(0, Math.min(imgSize.height - 1, Math.round((target.y || 0) * s)));
        const cw = Math.max(1, Math.min(imgSize.width - cx, Math.round(target.width * s)));
        const ch = Math.max(1, Math.min(imgSize.height - cy, Math.round(target.height * s)));
        const cropped = screenFb.image.crop({ x: cx, y: cy, width: cw, height: ch });
        if (cropped && !cropped.isEmpty()) png = cropped.toPNG();
      } else if (!src || !src.thumbnail || src.thumbnail.isEmpty()) {
        return { ok: false, error: `no matching window source; screen crop fallback (${screenFb.error || 'empty'})` };
      }
    }
    if (!png || !png.length) return { ok: false, error: 'no matching window source / empty PNG from desktopCapturer' };
    fs.writeFileSync(file, png);
    if (target.width > 0) { try { normalizePngToLogicalWidth(file, target.width); } catch (_) {} }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function appScreenshot({ app = '', windowId = null, title = '', dir } = {}) {
  gate();
  const wins = await listWindowsStructured();
  const target = wins.find((w) => {
    if (windowId && String(w.windowId) === String(windowId)) return true;
    if (app && w.app.toLowerCase().includes(String(app).toLowerCase())) {
      if (!title || w.title.toLowerCase().includes(String(title).toLowerCase())) return true;
    }
    if (title && w.title.toLowerCase().includes(String(title).toLowerCase())) return true;
    return false;
  });
  if (!target) throw new Error(`No visible window matched app="${app}" windowId="${windowId || ''}" title="${title}"`);

  const outDir = dir || path.join(os.tmpdir(), 'autobot-computer');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `app-${Date.now()}.png`);

  if (process.platform === 'win32') {
    winLinux.winScreenshot(file, { x: target.x, y: target.y, w: target.width, h: target.height }, activeDisplayIndex);
  } else if (process.platform === 'linux') {
    winLinux.linuxScreenshot(file, null, target.windowId);
  } else {
    // Primary: screencapture window-id capture. Falls back to Electron's
    // desktopCapturer when the CLI subprocess is denied Screen Recording TCC
    // (which inherits a different grant than the Electron main process).
    const { err } = await execP(`/usr/sbin/screencapture -x -o -l ${target.windowId} "${file}"`, { timeout: 20000 });
    let haveShot = !err && fs.existsSync(file) && fs.statSync(file).size > 0;
    if (haveShot && target.width > 0) {
      try { normalizePngToLogicalWidth(file, target.width); } catch (_) {}
    }
    if (!haveShot) {
      const viaElectron = await appScreenshotViaElectron(target, file);
      if (!viaElectron.ok) {
        const scMsg = err ? err.message : 'screencapture returned empty image';
        const fbMsg = viaElectron.error || 'could not create image from window';
        throw new Error(`app screenshot failed: screencapture (${scMsg}); desktopCapturer fallback (${fbMsg}) — grant Screen Recording to Akron Code in System Settings › Privacy & Security.`);
      }
      haveShot = true;
    }
  }
  const buf = fs.readFileSync(file);
  lastShot = file;
  return {
    path: file,
    size: buf.length,
    window: target,
    b64: buf.toString('base64'),
  };
}

// ── Native Desktop Accessibility Tree & Menu Actions ──────────────────────────

async function axFind({ app = '', query = '', role = '', maxResults = 40 } = {}) {
  gate();
  if (process.platform === 'win32') {
    return winLinux.winAxFind({ app, query, role, maxResults });
  }
  if (process.platform === 'linux') {
    return (await listWindowsStructured()).slice(0, maxResults).map((w) => ({
      role: 'window',
      title: `${w.app}: ${w.title}`,
      x: w.x,
      y: w.y,
      width: w.width,
      height: w.height,
      centerX: Math.round(w.x + w.width / 2),
      centerY: Math.round(w.y + w.height / 2),
    }));
  }
  const appMatch = JSON.stringify(String(app || '').toLowerCase());
  const qMatch = JSON.stringify(String(query || '').toLowerCase());
  const rMatch = JSON.stringify(String(role || '').toLowerCase());
  const cap = Math.min(Math.max(1, Number(maxResults) || 40), 100);
  const out = await jxa(`
const se = Application('System Events');
const targetApp = ${appMatch};
const q = ${qMatch};
const wantRole = ${rMatch};
let proc = null;
if (targetApp) {
  for (const p of se.processes.whose({ backgroundOnly: false })()) {
    try {
      if (String(p.name() || '').toLowerCase().includes(targetApp)) { proc = p; break; }
    } catch (_) {}
  }
}
if (!proc) proc = se.processes.whose({ frontmost: true })()[0];
const results = [];
if (proc) {
  const win = proc.windows.length ? proc.windows[0] : null;
  if (win) {
    const els = win.entireContents();
    for (let i = 0; i < Math.min(els.length, 280); i++) {
      const el = els[i];
      try {
        const r = String(el.role() || '');
        const title = String(el.title() || el.description() || el.name() || '');
        const pos = el.position();
        const sz = el.size();
        const x = Math.round(pos[0] || 0); const y = Math.round(pos[1] || 0);
        const w = Math.round(sz[0] || 0); const h = Math.round(sz[1] || 0);
        if (w <= 0 || h <= 0) continue;
        if (wantRole && !r.toLowerCase().includes(wantRole)) continue;
        const val = String(el.value() || '').slice(0, 80);
        if (q && !(title.toLowerCase().includes(q) || val.toLowerCase().includes(q))) continue;
        results.push({ role: r, title, value: val, x, y, width: w, height: h, centerX: Math.round(x + w / 2), centerY: Math.round(y + h / 2) });
        if (results.length >= ${cap}) break;
      } catch (_) {}
    }
  }
}
JSON.stringify(results);
`);
  return out ? JSON.parse(out) : [];
}

async function appMenu({ app = '', menuPath = [] } = {}) {
  gate();
  const segments = Array.isArray(menuPath) ? menuPath.map(String).filter(Boolean) : String(menuPath || '').split('>').map((s) => s.trim()).filter(Boolean);
  if (segments.length < 2) throw new Error('appMenu requires menuPath with at least [menuName, itemName], e.g. ["File", "Save"]');
  if (process.platform !== 'darwin') {
    throw new Error('Native app menu traversal is currently supported on macOS; use keyboard shortcuts via `mcp__computer__key` on Windows/Linux.');
  }
  const appExpr = app ? `process ${JSON.stringify(String(app))}` : 'first application process whose frontmost is true';
  const menuTop = JSON.stringify(segments[0]);
  const itemFinal = JSON.stringify(segments[segments.length - 1]);
  return osascript(`tell application "System Events"
  tell ${appExpr}
    click menu item ${itemFinal} of menu 1 of menu bar item ${menuTop} of menu bar 1
  end tell
end tell`);
}

/** Execute a sequence of micro-actions atomically under the session computer lock (Claude app_batch + n8n pattern). */
async function batch({ actions = [], screenshotAfter = false, dir, ownerId = 'batch' } = {}) {
  gate();
  if (!Array.isArray(actions) || !actions.length) throw new Error('batch requires a non-empty actions array');
  const lk = acquireLock(ownerId);
  if (!lk.ok) throw new Error(lk.error);
  const log = [];
  try {
    for (let i = 0; i < Math.min(actions.length, 30); i++) {
      const a = actions[i] || {};
      const act = String(a.action || a.type || '').toLowerCase();
      if (act === 'move' || act === 'mouse_move') await move(a.x, a.y);
      else if (act === 'click' || act === 'left_click') await click(a.x, a.y, a.button || 'left', !!a.double, { triple: !!a.triple });
      else if (act === 'double_click') await click(a.x, a.y, a.button || 'left', true);
      else if (act === 'triple_click') await click(a.x, a.y, a.button || 'left', false, { triple: true });
      else if (act === 'right_click') await click(a.x, a.y, 'right', false);
      else if (act === 'middle_click') await click(a.x, a.y, 'middle', false);
      else if (act === 'mouse_down' || act === 'left_mouse_down') await mouseDown(a.x, a.y, a.button || 'left');
      else if (act === 'mouse_up' || act === 'left_mouse_up') await mouseUp(a.x, a.y, a.button || 'left');
      else if (act === 'drag' || act === 'left_click_drag') await drag(a.x1 ?? a.x, a.y1 ?? a.y, a.x2, a.y2, a.button || 'left');
      else if (act === 'scroll') await scroll(a.direction || 'down', a.amount || 3, a);
      else if (act === 'type') await type(a.text || '');
      else if (act === 'key') await key(a.keys || a.key || '');
      else if (act === 'hold_key') await holdKey(a.keys || a.key || '', a.durationMs || 500);
      else if (act === 'wait') await wait(a.ms || a.durationMs || 500);
      else if (act === 'open_app') await openApp(a.app || a.name || '');
      else if (act === 'activate_app') await activateApp(a.app || a.name || '');
      else throw new Error(`Unknown batch action #${i + 1}: ${act}`);
      log.push(`${i + 1}:${act}`);
    }
    let shot = null;
    if (screenshotAfter) shot = await screenshot({ dir });
    return { ok: true, executed: log, screenshot: shot };
  } finally {
    releaseLock(ownerId);
  }
}

async function permission(prompt) {
  if (process.platform === 'win32' || process.platform === 'linux') {
    return { granted: true, status: 'granted', platform: process.platform };
  }
  const j = 'ObjC.import(\'ApplicationServices\'); $.AXIsProcessTrusted() ? \'granted\' : \'denied\';';
  const status = await jxa(j);
  if (status === 'denied' && prompt) {
    try {
      spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', 'ObjC.import(\'ApplicationServices\'); $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey(true, \'AXTrustedCheckOptionPrompt\'));'], { timeout: 3000, stdio: 'ignore' });
    } catch (_) {}
  }
  return { granted: status === 'granted', status };
}

module.exports = {
  setEnabled, isEnabled, acquireLock, releaseLock,
  screenshot, lastScreenshot, screenSize, screenPointsSync, switchDisplay, zoom, appScreenshot,
  click, move, drag, mouseDown, mouseUp, cursorPosition, scroll, type, key, holdKey, wait,
  openApp, activateApp, frontmostApp, listWindows, listWindowsStructured, axFind, appMenu, batch,
  clipboardRead, clipboardWrite, permission,
  _internal: { mapMouseButton, buildMacMouseOps },
};
