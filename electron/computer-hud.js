'use strict';
/**
 * Cross-platform Computer Use HUD (Claude-parity Halo + Phantom Cursor + Stop/Esc Pill).
 *
 * Renders:
 *   1. Non-activating click-through full-display overlay (`overlayWin`) with an
 *      Emerald `#10b981` pulsing inset perimeter glow, smooth phantom cursor +
 *      "Akron" badge + action label, and click ripples.
 *   2. Floating top-center pill (`pillWin`) with a clickable `Stop (Esc)` button
 *      and a temporary global `Escape` shortcut so a user can halt Computer Use
 *      immediately at any point.
 *
 * Both windows enable `setContentProtection(true)` and are hidden cleanly around
 * screenshots via `withHiddenForCapture(fn)` so the model sees only real pixels.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

let hudEnabled = true;
let overlayWin = null;
let pillWin = null;
let currentDisplayId = null;
let hudVisible = false;
let idleTimer = null;
let escRegistered = false;
let quitHooked = false;
let stoppedUntilMs = 0;
let stopReason = '';
let lastLabel = 'Computer Use';
let hudHtmlPath = '';
let pillHtmlPath = '';
const stopListeners = new Set();

const IDLE_HIDE_MS = 4500;
const STOP_COOLDOWN_MS = 2500;

function getElectron() {
  try {
    const el = require('electron');
    if (el && el.BrowserWindow && el.screen && el.app) return el;
  } catch (_) {}
  return null;
}

function isHeadlessOrTest() {
  return process.env.AKRON_NO_DIALOG === '1'
    || !!process.env.NODE_TEST_CONTEXT
    || !hudEnabled;
}

function setHudEnabled(v) {
  hudEnabled = !!v;
  if (!hudEnabled) hideHud();
  return hudEnabled;
}

function isHudEnabled() { return hudEnabled; }

function onStop(fn) {
  if (typeof fn !== 'function') return () => {};
  stopListeners.add(fn);
  return () => stopListeners.delete(fn);
}

function isStopped() {
  return Date.now() < stoppedUntilMs;
}

function assertNotStopped() {
  if (isStopped()) {
    throw new Error(`Computer Use stopped by user (${stopReason || 'Esc / Stop button'}).`);
  }
}

function clearStop() {
  stoppedUntilMs = 0;
  stopReason = '';
}

function triggerEmergencyStop(reason = 'Escape / Stop', cooldownMs = STOP_COOLDOWN_MS) {
  stoppedUntilMs = Date.now() + Math.max(200, Number(cooldownMs) || STOP_COOLDOWN_MS);
  stopReason = String(reason || 'Escape / Stop');
  hideHud();
  for (const fn of stopListeners) {
    try { fn(stopReason); } catch (_) {}
  }
  return { ok: true, stoppedUntilMs, reason: stopReason };
}

function buildOverlayHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  #glow {
    position: fixed; inset: 0; pointer-events: none;
    box-shadow:
      inset 0 0 0 2px rgba(16, 185, 129, 0.72),
      inset 0 0 36px rgba(16, 185, 129, 0.34),
      inset 0 0 88px rgba(16, 185, 129, 0.16);
    animation: glowPulse 2.2s ease-in-out infinite;
  }
  @keyframes glowPulse {
    0%, 100% { opacity: 0.78; }
    50% { opacity: 1; }
  }
  #cursor-wrap {
    position: fixed; left: 0; top: 0; pointer-events: none;
    transform: translate3d(-999px, -999px, 0);
    transition: transform 95ms cubic-bezier(0.22, 1, 0.36, 1);
    display: flex; align-items: flex-start; gap: 6px;
    will-change: transform;
  }
  #pointer {
    width: 22px; height: 22px;
    filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.55));
  }
  #tag {
    margin-top: 12px;
    background: rgba(11, 20, 17, 0.92);
    border: 1px solid rgba(16, 185, 129, 0.65);
    color: #ecfdf5;
    border-radius: 999px;
    padding: 3px 9px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
    display: flex; align-items: center; gap: 5px;
  }
  #tag .dot {
    width: 6px; height: 6px; border-radius: 50%; background: #10b981;
  }
  #tag .act { color: #a7f3d0; font-weight: 500; }
  #ripple {
    position: fixed; left: 0; top: 0; width: 28px; height: 28px;
    margin-left: -14px; margin-top: -14px;
    border-radius: 50%;
    border: 2px solid #10b981;
    background: rgba(16, 185, 129, 0.22);
    pointer-events: none;
    opacity: 0;
    transform: translate3d(-999px, -999px, 0) scale(0.35);
  }
  #ripple.pop {
    animation: ripplePop 380ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  }
  @keyframes ripplePop {
    0% { opacity: 0.95; transform: translate3d(var(--rx), var(--ry), 0) scale(0.35); }
    100% { opacity: 0; transform: translate3d(var(--rx), var(--ry), 0) scale(1.75); }
  }
</style>
</head>
<body>
  <div id="glow"></div>
  <div id="ripple"></div>
  <div id="cursor-wrap">
    <svg id="pointer" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 2.5L20 12.2L12.7 14.1L9.6 21.2Z" fill="#10b981" stroke="#06281e" stroke-width="1.6" stroke-linejoin="round" />
    </svg>
    <div id="tag"><span class="dot"></span><span>Akron</span><span class="act" id="act">Working</span></div>
  </div>
  <script>
    window.__akronMoveCursor = (x, y, label, ripple) => {
      const wrap = document.getElementById('cursor-wrap');
      const act = document.getElementById('act');
      if (act && label) act.textContent = label;
      if (wrap && Number.isFinite(x) && Number.isFinite(y)) {
        wrap.style.transform = 'translate3d(' + Math.round(x) + 'px,' + Math.round(y) + 'px,0)';
      }
      if (ripple && Number.isFinite(x) && Number.isFinite(y)) {
        const rp = document.getElementById('ripple');
        if (rp) {
          rp.classList.remove('pop');
          rp.style.setProperty('--rx', Math.round(x) + 'px');
          rp.style.setProperty('--ry', Math.round(y) + 'px');
          void rp.offsetWidth;
          rp.classList.add('pop');
        }
      }
    };
  </script>
</body>
</html>`;
}

function buildPillHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0; width: 100%; height: 100%;
    background: transparent; overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    display: flex; align-items: center; justify-content: center;
  }
  .pill {
    display: flex; align-items: center; gap: 9px;
    padding: 6px 8px 6px 12px;
    background: rgba(11, 18, 16, 0.94);
    border: 1px solid rgba(16, 185, 129, 0.55);
    border-radius: 999px;
    color: #ecfdf5;
    font-size: 12px; font-weight: 600;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    user-select: none;
  }
  .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #10b981;
    box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.22);
    animation: p 1.6s ease-in-out infinite;
  }
  @keyframes p { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
  .txt { white-space: nowrap; }
  .act { color: #a7f3d0; font-weight: 500; max-width: 110px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  button {
    border: 1px solid rgba(239, 68, 68, 0.48);
    background: rgba(239, 68, 68, 0.16);
    color: #fecaca;
    border-radius: 999px;
    padding: 3px 10px;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    cursor: pointer;
  }
  button:hover { background: rgba(239, 68, 68, 0.30); color: #fff; }
</style>
</head>
<body>
  <div class="pill">
    <span class="dot"></span>
    <span class="txt">Akron is working</span>
    <span class="act" id="act">Screen</span>
    <button id="stop" type="button">Stop (Esc)</button>
  </div>
  <script>
    window.__akronSetLabel = (lbl) => {
      const el = document.getElementById('act');
      if (el && lbl) el.textContent = lbl;
    };
    document.getElementById('stop').addEventListener('click', () => {
      window.location.hash = 'stop-' + Date.now();
    });
  </script>
</body>
</html>`;
}

function ensureHtmlFiles() {
  const dir = path.join(os.tmpdir(), 'autobot-hud');
  fs.mkdirSync(dir, { recursive: true });
  if (!hudHtmlPath || !fs.existsSync(hudHtmlPath)) {
    hudHtmlPath = path.join(dir, 'cu-overlay.html');
    fs.writeFileSync(hudHtmlPath, buildOverlayHtml(), 'utf8');
  }
  if (!pillHtmlPath || !fs.existsSync(pillHtmlPath)) {
    pillHtmlPath = path.join(dir, 'cu-pill.html');
    fs.writeFileSync(pillHtmlPath, buildPillHtml(), 'utf8');
  }
}

function resolveDisplay(el, displayIndex = 0) {
  const all = el.screen.getAllDisplays();
  if (!all.length) return el.screen.getPrimaryDisplay();
  const idx = Math.max(0, Math.min(Number(displayIndex) || 0, all.length - 1));
  return all[idx] || el.screen.getPrimaryDisplay();
}

function registerEscapeShortcut(el) {
  if (escRegistered || !el || !el.globalShortcut) return;
  try {
    const okPrimary = el.globalShortcut.register('Escape', () => triggerEmergencyStop('Escape key'));
    try { el.globalShortcut.register('CommandOrControl+Shift+Escape', () => triggerEmergencyStop('Hotkey Stop')); } catch (_) {}
    escRegistered = !!okPrimary;
  } catch (_) {
    escRegistered = false;
  }
}

function unregisterEscapeShortcut(el) {
  if (!el || !el.globalShortcut) return;
  try { el.globalShortcut.unregister('Escape'); } catch (_) {}
  try { el.globalShortcut.unregister('CommandOrControl+Shift+Escape'); } catch (_) {}
  escRegistered = false;
}

async function withSuspendedShortcut(fn) {
  const el = getElectron();
  const wasRegistered = escRegistered;
  if (wasRegistered && el) unregisterEscapeShortcut(el);
  try {
    return await fn();
  } finally {
    if (wasRegistered && hudVisible && !isStopped() && el) {
      await new Promise((r) => setTimeout(r, 80));
      if (hudVisible && !isStopped()) registerEscapeShortcut(el);
    }
  }
}

function applyClickThrough(win) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setIgnoreMouseEvents(true, { forward: true });
  } catch (_) {
    try { win.setIgnoreMouseEvents(true); } catch (_) {}
  }
}

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => hideHud(), IDLE_HIDE_MS);
}

async function ensureWindows(displayIndex = 0) {
  if (isHeadlessOrTest()) return false;
  const el = getElectron();
  if (!el || !el.app.isReady()) return false;
  if (!quitHooked) {
    quitHooked = true;
    el.app.once('will-quit', () => hideHud());
  }
  ensureHtmlFiles();
  const disp = resolveDisplay(el, displayIndex);
  const b = disp.bounds || { x: 0, y: 0, width: 1280, height: 800 };
  const winTypeOpt = process.platform === 'darwin'
    ? { type: 'panel' }
    : (process.platform === 'linux' ? { type: 'toolbar' } : {});

  if (!overlayWin || overlayWin.isDestroyed()) {
    overlayWin = new el.BrowserWindow({
      x: b.x, y: b.y, width: b.width, height: b.height,
      transparent: true,
      frame: false,
      roundedCorners: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...winTypeOpt,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setFullScreenable(false);
    applyClickThrough(overlayWin);
    try { overlayWin.setContentProtection(true); } catch (_) {}
    if (process.platform === 'darwin') {
      try { overlayWin.setHiddenInMissionControl(true); } catch (_) {}
    }
    overlayWin.on('closed', () => { overlayWin = null; });
    await overlayWin.loadFile(hudHtmlPath).catch(() => {});
  } else if (currentDisplayId !== disp.id) {
    try { overlayWin.setBounds(b); } catch (_) {}
  }

  const pillW = 340;
  const pillH = 44;
  const px = Math.round(b.x + (b.width - pillW) / 2);
  const py = Math.round(b.y + 10);

  if (!pillWin || pillWin.isDestroyed()) {
    pillWin = new el.BrowserWindow({
      x: px, y: py, width: pillW, height: pillH,
      transparent: true,
      frame: false,
      hasShadow: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      ...winTypeOpt,
      show: false,
      backgroundColor: '#00000000',
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
    });
    pillWin.setAlwaysOnTop(true, 'screen-saver');
    pillWin.setFullScreenable(false);
    try { pillWin.setContentProtection(true); } catch (_) {}
    if (process.platform === 'darwin') {
      try { pillWin.setHiddenInMissionControl(true); } catch (_) {}
    }
    pillWin.webContents.on('did-navigate-in-page', (_e, url) => {
      if (String(url || '').includes('#stop')) triggerEmergencyStop('HUD Stop button');
    });
    pillWin.on('closed', () => { pillWin = null; });
    await pillWin.loadFile(pillHtmlPath).catch(() => {});
  } else if (currentDisplayId !== disp.id) {
    try { pillWin.setBounds({ x: px, y: py, width: pillW, height: pillH }); } catch (_) {}
  }

  currentDisplayId = disp.id;
  return true;
}

async function showAction({ displayIndex = 0, x = null, y = null, label = 'Computer Use', ripple = false } = {}) {
  lastLabel = label || 'Computer Use';
  if (isHeadlessOrTest()) return false;
  const ok = await ensureWindows(displayIndex);
  if (!ok) return false;
  const el = getElectron();
  if (!el) return false;
  const disp = resolveDisplay(el, displayIndex);
  const b = disp.bounds || { x: 0, y: 0 };

  if (overlayWin && !overlayWin.isDestroyed()) {
    if (!overlayWin.isVisible()) overlayWin.showInactive();
    applyClickThrough(overlayWin);
    if (x != null && y != null) {
      const lx = Math.round(Number(x) - b.x);
      const ly = Math.round(Number(y) - b.y);
      overlayWin.webContents.executeJavaScript(
        `window.__akronMoveCursor && window.__akronMoveCursor(${lx}, ${ly}, ${JSON.stringify(lastLabel)}, ${!!ripple});`
      ).catch(() => {});
    }
  }
  if (pillWin && !pillWin.isDestroyed()) {
    if (!pillWin.isVisible()) pillWin.showInactive();
    pillWin.webContents.executeJavaScript(
      `window.__akronSetLabel && window.__akronSetLabel(${JSON.stringify(lastLabel)});`
    ).catch(() => {});
  }
  hudVisible = true;
  registerEscapeShortcut(el);
  resetIdleTimer();
  return true;
}

function hideHud() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const el = getElectron();
  unregisterEscapeShortcut(el);
  hudVisible = false;
  if (overlayWin && !overlayWin.isDestroyed()) {
    try { overlayWin.hide(); } catch (_) {}
  }
  if (pillWin && !pillWin.isDestroyed()) {
    try { pillWin.hide(); } catch (_) {}
  }
}

async function withHiddenForCapture(fn) {
  if (isHeadlessOrTest() || (!overlayWin && !pillWin)) return fn();
  const wasOverlayVisible = !!(overlayWin && !overlayWin.isDestroyed() && overlayWin.isVisible());
  const wasPillVisible = !!(pillWin && !pillWin.isDestroyed() && pillWin.isVisible());
  if (wasOverlayVisible) { try { overlayWin.hide(); } catch (_) {} }
  if (wasPillVisible) { try { pillWin.hide(); } catch (_) {} }
  if (wasOverlayVisible || wasPillVisible) {
    await new Promise((r) => setTimeout(r, 65));
  }
  try {
    return await fn();
  } finally {
    if (hudVisible && !isStopped()) {
      if (wasOverlayVisible && overlayWin && !overlayWin.isDestroyed()) {
        try { overlayWin.showInactive(); } catch (_) {}
      }
      if (wasPillVisible && pillWin && !pillWin.isDestroyed()) {
        try { pillWin.showInactive(); } catch (_) {}
      }
    }
  }
}

async function previewHud(durationMs = 1800) {
  clearStop();
  const el = getElectron();
  if (!el || isHeadlessOrTest()) return { ok: true, previewed: false, reason: 'headless_or_test' };
  const disp = resolveDisplay(el, 0);
  const b = disp.bounds || { x: 0, y: 0, width: 1280, height: 800 };
  const cx = Math.round(b.x + b.width / 2);
  const cy = Math.round(b.y + b.height / 2);
  await showAction({ displayIndex: 0, x: cx, y: cy, label: 'HUD Preview', ripple: true });
  setTimeout(() => { hideHud(); }, Math.min(Math.max(500, Number(durationMs) || 1800), 6000));
  return { ok: true, previewed: true };
}

function status() {
  return {
    hudEnabled,
    hudVisible,
    escRegistered,
    stopped: isStopped(),
    stoppedUntilMs,
    stopReason,
  };
}

module.exports = {
  setHudEnabled,
  isHudEnabled,
  onStop,
  isStopped,
  assertNotStopped,
  clearStop,
  triggerEmergencyStop,
  showAction,
  hideHud,
  withHiddenForCapture,
  withSuspendedShortcut,
  previewHud,
  status,
};
