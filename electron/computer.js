'use strict';
// Computer Use — full macOS screen capture + mouse/keyboard/app control.
// Claude Desktop parity: screenshot, click, double-click, right-click, drag,
// scroll, type, key chords, open/activate apps, list windows, clipboard.
//
// Input is synthesized two ways and the best available is picked at runtime:
//   1. JXA (osascript -l JavaScript) + CoreGraphics CGEventPost — fast, no deps.
//   2. AppleScript System Events — fallback for keystroke text.
// Both require the app to be granted Accessibility (and Screen Recording for
// screenshots) under System Settings › Privacy & Security. We surface a clear
// message + one-click request when it's missing.

const { exec, spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

let enabled = true; // gate: computer control (Claude parity — on by default)
let lastShot = null;

function setEnabled(v) { enabled = !!v; return enabled; }
function isEnabled() { return enabled; }
function gate() { if (!enabled) throw new Error('Computer control is disabled. Enable it in Settings → Features.'); }

function execP(cmd, opts = {}) {
  return new Promise((resolve) => {
    const child = exec(cmd, { timeout: opts.timeout || 15000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    // `exec` has no `input` option — feed stdin manually for pbcopy & friends.
    if (opts.input != null && child.stdin) {
      child.stdin.write(String(opts.input));
      child.stdin.end();
    }
  });
}

async function osascript(script) {
  const { err, stdout, stderr } = await execP('/usr/bin/osascript -e ' + JSON.stringify(script), { timeout: 20000 });
  if (err) {
    const msg = (stderr || err.message || '').trim();
    if (/assistive access|not allowed/i.test(msg)) {
      throw new Error('Accessibility permission missing: open System Settings › Privacy & Security › Accessibility and enable Helio Bot.');
    }
    throw new Error(msg || 'osascript failed');
  }
  return stdout.trim();
}

// Run a JXA snippet (ObjC bridge). Writes to a temp file to avoid -e quoting pain.
async function jxa(src) {
  const file = path.join(os.tmpdir(), `autobot-jxa-${process.pid}-${Date.now()}.js`);
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
function post(t, x, y, btn) { const p = $.CGPointMake(x, y); const e = $.CGEventCreateMouseEvent(null, t, p, btn); if (e && !e.isNil()) $.CGEventPost($.kCGHIDEventTap, e); }
${ops}
`;

/** Mouse move/click/drag in **CG points** (not retina pixels). */
async function mouse(kind, opts = {}) {
  gate();
  const { x = 0, y = 0, button = 'left', double = false, x2 = x, y2 = y } = opts;
  const btn = { left: 0, right: 1, middle: 2 }[button] != null ? { left: 0, right: 1, middle: 2 }[button] : 0;
  let ops;
  if (kind === 'move') {
    ops = `post($.kCGEventMouseMoved, ${x}, ${y}, 0);`;
  } else if (kind === 'drag') {
    ops = `post($.kCGEventLeftMouseDown, ${x}, ${y}, 0);\n  post($.kCGEventLeftMouseDragged, ${x2}, ${y2}, 0);\n  post($.kCGEventLeftMouseUp, ${x2}, ${y2}, 0);`;
  } else { // click
    const down = button === 1 ? '$.kCGEventRightMouseDown' : button === 2 ? '$.kCGEventOtherMouseDown' : '$.kCGEventLeftMouseDown';
    const up = button === 1 ? '$.kCGEventRightMouseUp' : button === 2 ? '$.kCGEventOtherMouseUp' : '$.kCGEventLeftMouseUp';
    const state = double ? `\n  const d=$.CGEventCreateMouseEvent(null, ${down}, $.CGPointMake(${x},${y}), ${btn}); $.CGEventSetIntegerValueField(d, $.kCGMouseEventClickState, 2); $.CGEventPost($.kCGHIDEventTap, d);` : '';
    ops = `post(${down}, ${x}, ${y}, ${btn});\n  post(${up}, ${x}, ${y}, ${btn});${state}`;
  }
  await jxa(JXA_MOUSE(ops));
  return { ok: true, kind, x, y };
}

async function click(x, y, button = 'left', double = false) { return mouse('click', { x, y, button, double }); }
async function move(x, y) { return mouse('move', { x, y }); }
async function drag(x1, y1, x2, y2) { return mouse('drag', { x: x1, y: y1, x2, y2 }); }

async function scroll(direction = 'down', amount = 3) {
  gate();
  const dir = { up: 1, down: -1, left: -1, right: 1 };
  const d = dir[direction] != null ? dir[direction] : -1;
  const n = Math.max(1, Math.min(Number(amount) || 3, 40));
  const vertical = direction === 'up' || direction === 'down';
  const dy = vertical ? d * n : 0;
  const dx = vertical ? 0 : d * n;
  await jxa(`ObjC.import('CoreGraphics');\nconst e = $.CGEventCreateScrollWheelEvent(null, 1, 1, ${dy}, ${dx});\n$.CGEventPost($.kCGHIDEventTap, e);\n'ok';`);
  return { ok: true };
}

// --- keyboard ---------------------------------------------------------------

const KEYCODES = {
  return: 36, enter: 36, tab: 48, space: 49, delete: 51, backspace: 51,
  escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  home: 115, end: 119, pageup: 116, pagedown: 121, forwarddelete: 117,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111, f13: 105, f14: 107, f15: 113,
};

async function type(text) {
  gate();
  const s = String(text);
  // Non-ASCII → paste via clipboard (keystroke can't do unicode reliably).
  if (/[^\x00-\x7F]/.test(s)) {
    const before = (await execP('/usr/bin/pbpaste', { timeout: 5000 })).stdout;
    await execP(`/usr/bin/pbcopy`, { input: s, timeout: 5000 });
    const r = await key('cmd+v');
    await execP(`printf %s ${JSON.stringify(before)} | /usr/bin/pbcopy`, { timeout: 5000 });
    return r;
  }
  return await osascript(`tell application "System Events"
  keystroke ${JSON.stringify(s)}
end tell`);
}

async function key(keys) {
  gate();
  const parts = String(keys).toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  const mods = [];
  let main = null;
  for (const p of parts) {
    if (['cmd', 'command', 'meta'].includes(p)) mods.push('command down');
    else if (['ctrl', 'control'].includes(p)) mods.push('control down');
    else if (['alt', 'option'].includes(p)) mods.push('option down');
    else if (['shift'].includes(p)) mods.push('shift down');
    else main = p;
  }
  if (!main) main = parts[parts.length - 1] || 'return';
  const using = mods.length ? ` using {${mods.join(', ')}}` : '';
  // Named key → numeric key code; single char → keystroke.
  if (KEYCODES[main] != null) {
    return await osascript(`tell application "System Events"
  key code ${KEYCODES[main]}${using}
end tell`);
  }
  const char = main.length === 1 ? main : String(keys);
  return await osascript(`tell application "System Events"
  keystroke ${JSON.stringify(char)}${using}
end tell`);
}

// --- apps / windows / clipboard ---------------------------------------------

async function openApp(nameOrPath) {
  gate();
  const target = String(nameOrPath).trim();
  const { err } = await execP(`/usr/bin/open ${JSON.stringify(target)}`, { timeout: 15000 });
  if (err) throw new Error('open failed: ' + err.message);
  return { ok: true, opened: target };
}

async function activateApp(name) {
  gate();
  return await osascript(`tell application ${JSON.stringify(String(name))} to activate`);
}

async function frontmostApp() {
  return await osascript(`tell application "System Events" to get name of first application process whose frontmost is true`);
}

async function listWindows() {
  const script = `tell application "System Events"
  set out to ""
  repeat with p in (every application process whose background only is false)
    try
      repeat with w in (every window of p)
        set out to out & (name of p) & " | " & (name of w) & " | pos=" & (item 1 of (position of w)) & "," & (item 2 of (position of w)) & " | size=" & (item 1 of (size of w)) & "x" & (item 2 of (size of w)) & linefeed
      end repeat
    end try
  end repeat
  return out
end tell`;
  const out = await osascript(script);
  return out || '(no visible windows)';
}

async function clipboardRead() {
  return (await execP('/usr/bin/pbpaste', { timeout: 5000 })).stdout;
}

async function clipboardWrite(text) {
  await execP(`/usr/bin/pbcopy`, { input: String(text), timeout: 5000 });
  return { ok: true };
}

// --- screenshot / screen ----------------------------------------------------

async function screenshot(opts = {}) {
  gate();
  const dir = opts.dir || path.join(os.tmpdir(), 'autobot-computer');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `shot-${Date.now()}.png`);
  const { err } = await execP(`/usr/sbin/screencapture -x "${file}"`, { timeout: 20000 });
  if (err) throw new Error('screencapture failed (grant Screen Recording permission): ' + err.message);
  const buf = fs.readFileSync(file);
  const size = screenPointsSync();
  lastShot = file;
  return { path: file, size: buf.length, width: size.width, height: size.height, scale: size.scale, b64: buf.toString('base64') };
}

function lastScreenshot() { return lastShot; }

// CG display bounds (in points) + retina scale, without a full screenshot.
function screenPointsSync() {
  try {
    const r = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
      `ObjC.import('CoreGraphics'); const b=$.CGDisplayBounds($.CGMainDisplayID()); const s=$.CGDisplayPixelsWide($.CGMainDisplayID())/b.size.width; JSON.stringify({width:b.size.width,height:b.size.height,scale:Math.round(s*100)/100});`],
      { timeout: 10000 });
    const out = String(r.stdout || '').trim();
    if (out) {
      const o = JSON.parse(out);
      return { width: Math.round(o.width), height: Math.round(o.height), scale: o.scale || 2 };
    }
  } catch (_) {}
  return { width: 0, height: 0, scale: 2 };
}

async function screenSize() {
  gate();
  return screenPointsSync();
}

async function permission(prompt) {
  const j = `ObjC.import('ApplicationServices'); $.AXIsProcessTrusted() ? 'granted' : 'denied';`;
  const status = await jxa(j);
  if (status === 'denied' && prompt) {
    // Pop the OS dialog prompting the user to enable Accessibility for this app.
    try { spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('ApplicationServices'); $.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey(true, 'AXTrustedCheckOptionPrompt'));`], { timeout: 3000, stdio: 'ignore' }); } catch (_) {}
  }
  return { granted: status === 'granted', status };
}

module.exports = {
  setEnabled, isEnabled, screenshot, lastScreenshot, screenSize, screenPointsSync,
  click, move, drag, scroll, type, key,
  openApp, activateApp, frontmostApp, listWindows, clipboardRead, clipboardWrite,
  permission,
};
