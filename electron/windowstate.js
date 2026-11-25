// Window geometry persistence (parity with Desktop's mainWindow.js, which
// restores size + position per display and never restores a window onto a
// monitor that is no longer attached).
//
// Stored next to the rest of our state in ~/.autobot/window-state.json. Only
// plain numbers are kept, and the file is read defensively: a corrupt or
// hand-edited value must never stop the app from opening a window.
const fs = require('fs');
const os = require('os');
const path = require('path');

const DIR = path.join(os.homedir(), '.autobot');
const FILE = path.join(DIR, 'window-state.json');

const DEFAULTS = { width: 1280, height: 820, minWidth: 940, minHeight: 600 };
const MIN_VISIBLE = 120; // px of the window that must land on a display

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    const n = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
    const width = n(raw.width);
    const height = n(raw.height);
    if (!width || !height) return null;
    return {
      width: Math.max(DEFAULTS.minWidth, width),
      height: Math.max(DEFAULTS.minHeight, height),
      x: n(raw.x),
      y: n(raw.y),
      maximized: !!raw.maximized,
    };
  } catch (_) {
    return null;
  }
}

/**
 * Bounds to hand to `new BrowserWindow(...)`.
 * @param {Array<{bounds:{x:number,y:number,width:number,height:number}}>} displays
 */
function restore(displays) {
  const saved = read();
  if (!saved) return { ...DEFAULTS };
  const out = { width: saved.width, height: saved.height };
  if (saved.x === null || saved.y === null) return out;
  // A window restored entirely off-screen is unreachable: macOS will not let a
  // user drag it back, and the app looks broken. Require a slice of the title
  // bar to intersect some display before trusting the saved position.
  const list = Array.isArray(displays) && displays.length
    ? displays.map((d) => d.bounds)
    : [];
  const visible = list.some((b) => (
    saved.x + saved.width > b.x + MIN_VISIBLE
    && saved.x < b.x + b.width - MIN_VISIBLE
    && saved.y + saved.height > b.y
    && saved.y < b.y + b.height - MIN_VISIBLE
  ));
  if (visible) {
    out.x = saved.x;
    out.y = saved.y;
  }
  if (saved.maximized) out.__maximized = true;
  return out;
}

let timer = null;

/** Persist geometry, debounced so a drag does not write on every frame. */
function track(win, opts) {
  const o = opts || {};
  const save = () => {
    timer = null;
    try {
      if (win.isDestroyed()) return;
      const maximized = win.isMaximized();
      const fullScreen = win.isFullScreen();
      // While maximized/fullscreen getBounds() reports the maximized rect.
      // getNormalBounds() reports the floating rect instead, so un-maximizing
      // later still lands where the user left it — and, crucially, the very
      // first save (which may happen while already maximized) still records a
      // usable size/position instead of a bounds-less file that `read()` drops.
      let b = null;
      if (typeof win.getNormalBounds === 'function') {
        try { b = win.getNormalBounds(); } catch (_) { b = null; }
      }
      if (!b || !b.width || !b.height) {
        // No getNormalBounds(): while zoomed, prefer the last floating rect;
        // otherwise the live bounds are the truth.
        const prev = read();
        if ((maximized || fullScreen) && prev && prev.width && prev.height) {
          write({ ...prev, maximized: true });
          return;
        }
        b = win.getBounds();
      }
      write({ width: b.width, height: b.height, x: b.x, y: b.y, maximized: maximized || fullScreen });
    } catch (_) { /* geometry is a nicety, never fatal */ }
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, 400);
    if (timer.unref) timer.unref();
  };
  win.on('resize', schedule);
  win.on('move', schedule);
  win.on('maximize', schedule);
  win.on('unmaximize', schedule);
  win.on('close', () => { if (timer) { clearTimeout(timer); timer = null; } save(); });
  if (o.onRestore && (read() || {}).maximized) {
    // Applied after the window is shown: maximizing a hidden window on macOS
    // can leave the traffic lights mispositioned.
    win.once('show', () => { try { win.maximize(); } catch (_) {} });
  }
}

function write(data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (_) { /* read-only home, full disk: ignore */ }
}

module.exports = { restore, track, read, write, FILE, DEFAULTS };
