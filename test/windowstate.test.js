'use strict';
// Window geometry persistence (Desktop mainWindow.js parity). The module keeps
// state under ~/.autobot/window-state.json; the test points HOME at a temp dir
// BEFORE requiring it so the real store is never touched.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-winstate-'));
process.env.HOME = tmp; // os.homedir() honours $HOME on POSIX
const ws = require('../electron/windowstate');

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

const DISPLAY = { bounds: { x: 0, y: 0, width: 1440, height: 900 } };

// ---------------------------------------------------------------------------
console.log('\nwindowstate — defaults + round trip');
// ---------------------------------------------------------------------------
ok('file lives under the temp home', ws.FILE.startsWith(tmp), ws.FILE);
eq('no file → default size', (() => { const r = ws.restore([DISPLAY]); return [r.width, r.height]; })(), [1280, 820]);
ok('no file → no position', (() => { const r = ws.restore([DISPLAY]); return r.x === undefined && r.y === undefined; })());

ws.write({ width: 1000, height: 700, x: 120, y: 90, maximized: false });
eq('round trip', (() => { const r = ws.restore([DISPLAY]); return [r.width, r.height, r.x, r.y]; })(), [1000, 700, 120, 90]);

// ---------------------------------------------------------------------------
console.log('\nwindowstate — clamping');
// ---------------------------------------------------------------------------
ws.write({ width: 10, height: 20, x: 5, y: 5 });
const clamped = ws.restore([DISPLAY]);
eq('below minimum is raised', [clamped.width, clamped.height], [940, 600]);

ws.write({ width: 'absurd', height: null });
ok('non-numeric size → defaults', (() => { const r = ws.restore([DISPLAY]); return r.width === 1280 && r.height === 820; })());

fs.writeFileSync(ws.FILE, '{not json');
ok('corrupt file → defaults, no throw', (() => { const r = ws.restore([DISPLAY]); return r.width === 1280; })());

// ---------------------------------------------------------------------------
console.log('\nwindowstate — off-screen guard');
// ---------------------------------------------------------------------------
// A window whose whole rect is on a display that no longer exists must not be
// restored at that position (macOS gives the user no way to drag it back).
ws.write({ width: 1000, height: 700, x: 5000, y: 5000 });
const off = ws.restore([DISPLAY]);
ok('off-screen size kept', off.width === 1000 && off.height === 700);
ok('off-screen position dropped', off.x === undefined && off.y === undefined, off);

// Fully covered by the CURRENT display → restored.
ws.write({ width: 1000, height: 700, x: 200, y: 100 });
const on = ws.restore([DISPLAY]);
eq('on-screen position kept', [on.x, on.y], [200, 100]);

// A second, translated display (external monitor to the right).
ws.write({ width: 1000, height: 700, x: 1600, y: 200 });
const second = ws.restore([DISPLAY, { bounds: { x: 1440, y: 0, width: 1920, height: 1080 } }]);
eq('position on a second display kept', [second.x, second.y], [1600, 200]);
const secondGone = ws.restore([DISPLAY]);
ok('same position dropped when that display is gone', secondGone.x === undefined, secondGone);

// ---------------------------------------------------------------------------
console.log('\nwindowstate — maximize flag');
// ---------------------------------------------------------------------------
ws.write({ width: 1000, height: 700, x: 10, y: 10, maximized: true });
ok('maximized flag surfaces as __maximized', ws.restore([DISPLAY]).__maximized === true);

// ---------------------------------------------------------------------------
console.log('\nwindowstate — track() debounces + persists on close');
// ---------------------------------------------------------------------------
function fakeWin(bounds) {
  const handlers = {};
  return {
    isDestroyed: () => false,
    isMaximized: () => false,
    isFullScreen: () => false,
    getBounds: () => bounds,
    on: (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); },
    once: (evt, fn) => { (handlers[evt] = handlers[evt] || []).push(fn); },
    fire: (evt, arg) => (handlers[evt] || []).forEach((fn) => fn(arg)),
  };
}
const w = fakeWin({ width: 1111, height: 777, x: 30, y: 40 });
ws.track(w);
w.fire('resize');
w.fire('resize'); // must not write twice / must not throw
w.fire('close');  // flushes immediately
const persisted = ws.read();
eq('close flushes current bounds', [persisted.width, persisted.height, persisted.x, persisted.y], [1111, 777, 30, 40]);

// Maximized: keep the floating geometry, only flip the flag.
const wmx = fakeWin({ width: 1440, height: 900, x: 0, y: 0 });
wmx.isMaximized = () => true;
ws.track(wmx);
wmx.fire('close');
const afterMax = ws.read();
ok('maximized does not clobber floating size', afterMax.width !== 1440 || afterMax.height !== 900, afterMax);
ok('maximized sets flag', afterMax.maximized === true);

// onRestore maximize is applied on the next show, not at construction.
const w2 = fakeWin({ width: 900, height: 700, x: 1, y: 2 });
let maximizedOnShow = false;
w2.maximize = () => { maximizedOnShow = true; };
ws.track(w2, { onRestore: true });
w2.fire('show');
ok('maximize applied on show', maximizedOnShow === true);

// ---------------------------------------------------------------------------
console.log('\nwindowstate — getNormalBounds() beats the maximized rect');
// ---------------------------------------------------------------------------
// A zoomed window reports the screen rect from getBounds() but its floating
// rect from getNormalBounds(). The floating rect is what has to be stored, or
// un-maximizing lands wrong.
const wnb = fakeWin({ width: 1920, height: 1080, x: 0, y: 0 });
wnb.isMaximized = () => true;
wnb.getNormalBounds = () => ({ width: 1010, height: 720, x: 61, y: 72 });
ws.track(wnb);
wnb.fire('close');
const nb = ws.read();
eq('normal bounds are stored while maximized', [nb.width, nb.height, nb.x, nb.y], [1010, 720, 61, 72]);
ok('maximized flag still set', nb.maximized === true);

// The first-ever save happening while maximized must not produce a bounds-less
// file (read() would reject it and the next boot would fall back to defaults).
try { fs.unlinkSync(ws.FILE); } catch (_) {}
const wfirst = fakeWin({ width: 1920, height: 1080, x: 0, y: 0 });
wfirst.isMaximized = () => true;
wfirst.getNormalBounds = () => ({ width: 1200, height: 800, x: 100, y: 50 });
ws.track(wfirst);
wfirst.fire('close');
const first = ws.read();
ok('first save while maximized keeps a usable size', !!first && first.width === 1200 && first.height === 800, first);
eq('first save keeps the floating position', [first && first.x, first && first.y], [100, 50]);
ok('first save restores as maximized', ws.restore([DISPLAY]).__maximized === true);

// ---------------------------------------------------------------------------
console.log('\nwindowstate — atomic-ish write leaves no temp files');
// ---------------------------------------------------------------------------
const leftovers = fs.readdirSync(path.dirname(ws.FILE)).filter((f) => f.includes('.tmp'));
eq('no .tmp files left behind', leftovers, []);

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
console.log(`\n${pass} passed, ${process.exitCode ? 'FAILURES' : '0 failed'}`);
