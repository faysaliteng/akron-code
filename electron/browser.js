'use strict';
// Built-in Browser controller.
//
// The Browser pane in the renderer hosts one or more Electron <webview>s. The
// renderer drives the visible UI (omnibox, back/forward/reload, tabs,
// find-in-page) through the webview DOM API directly. This module keeps a
// reference to the ACTIVE guest WebContents so that (a) the agent tools in
// tools.js can control the same browser, (b) main-process handlers can query
// it, and (c) any model can drive the pane even when it has never been opened
// (ensureGuest asks the renderer to mount the pane and waits for registration).
// It mirrors the capability surface of Example Desktop's browser relay locally.
const { webContents } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');

let guest = null;        // active <webview> guest WebContents
let currentId = null;
let ensurePaneFn = null; // () => void — broadcasts "open the browser pane" to renderers
let tabCommandFn = null; // (cmd) => void — broadcasts a tab command to renderers
let tabsState = { tabs: [], activeId: null };

function setEnsurePane(fn) { ensurePaneFn = typeof fn === 'function' ? fn : null; }
function setTabCommand(fn) { tabCommandFn = typeof fn === 'function' ? fn : null; }

function register(id) {
  const n = Number(id);
  if (!Number.isFinite(n)) return false;
  const wc = webContents.fromId(n);
  if (!wc) return false;
  guest = wc;
  currentId = wc.id;
  return true;
}

function unregister(id) {
  const n = Number(id);
  if (guest && (id == null || guest.id === n)) { guest = null; currentId = null; }
  if (currentId === n) currentId = null;
  return true;
}

function getGuest() {
  if (guest && guest.isDestroyed()) { guest = null; currentId = null; }
  return guest;
}

function hasGuest() {
  return !!getGuest();
}

// Ask every renderer to open the Browser pane, then wait for a guest to
// register. Returns the guest WebContents or null on timeout.
async function ensureGuest(timeoutMs = 5000) {
  let g = getGuest();
  if (g) return g;
  // No renderer can mount a pane (headless / no window): fail fast rather than
  // blocking the agent loop for the full timeout on every browser tool call.
  if (!ensurePaneFn) return null;
  try { ensurePaneFn(); } catch (e) { /* ignore */ }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
    g = getGuest();
    if (g) return g;
  }
  return null;
}

// Turn a local path (absolute, ~-relative, relative-to-cwd) into a file:// URL,
// and — critically — resolve a DIRECTORY to the page inside it. Opening a folder
// in a webview shows a blank/blocked listing, which made a generated website
// look like it "was never made". Example Desktop always lands on the entry page.
function localFileUrl(input, cwd) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let p = null;

  if (raw.startsWith('~')) {
    p = path.join(os.homedir(), raw.slice(1).replace(/^[/\\]+/, ''));
  } else if (/^file:\/\//i.test(raw)) {
    try { p = require('url').fileURLToPath(raw); } catch (_) { return null; }
  } else if (path.isAbsolute(raw)) {
    p = raw;
  } else {
    // Relative: only treat it as a local path when it actually exists in the
    // project folder, otherwise it is a bare hostname like "example.com".
    const cand = path.resolve(cwd || process.cwd(), raw);
    if (fs.existsSync(cand)) p = cand;
  }
  if (!p) return null;
  try { p = decodeURIComponent(p); } catch (_) {}

  let st = null;
  try { st = fs.statSync(p); } catch (_) { return null; }
  if (st.isDirectory()) {
    const candidates = ['index.html', 'index.htm', 'Index.html', 'README.html'];
    let found = null;
    for (const c of candidates) {
      const f = path.join(p, c);
      if (fs.existsSync(f)) { found = f; break; }
    }
    if (!found) {
      try {
        const html = fs.readdirSync(p).filter((f) => /\.(html?|svg)$/i.test(f)).sort()[0];
        if (html) found = path.join(p, html);
      } catch (_) {}
    }
    if (!found) return null;
    p = found;
  }
  try { return require('url').pathToFileURL(p).href; } catch (_) { return null; }
}

function normalizeUrl(url, cwd) {
  url = String(url || '').trim();
  if (!url) return null;
  const local = localFileUrl(url, cwd);
  if (local) return local;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

// Resolve once the guest stops loading (or the timeout elapses). Used so the
// agent never reads a half-loaded page.
function waitForLoad(g, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { g.removeListener('did-stop-loading', finish); } catch (e) {}
      try { g.removeListener('did-fail-load', finish); } catch (e) {}
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      g.once('did-stop-loading', finish);
      g.once('did-fail-load', finish);
    } catch (e) { finish(); }
  });
}

async function loadURL(url, cwd) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open (could not be opened automatically)' };
  const u = normalizeUrl(url, cwd);
  if (!u) return { ok: false, error: 'URL required' };
  const loaded = waitForLoad(g);
  try { await g.loadURL(u); } catch (e) { /* aborted navigations reject */ }
  await loaded;
  let finalUrl = u;
  try { finalUrl = g.getURL() || u; } catch (e) {}
  return { ok: true, url: finalUrl };
}

async function goBack() {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  if (!g.canGoBack()) return { ok: false, error: 'Cannot go back' };
  const loaded = waitForLoad(g);
  g.goBack();
  await loaded;
  return { ok: true, url: getURL() };
}

async function goForward() {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  if (!g.canGoForward()) return { ok: false, error: 'Cannot go forward' };
  const loaded = waitForLoad(g);
  g.goForward();
  await loaded;
  return { ok: true, url: getURL() };
}

async function reload() {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  const loaded = waitForLoad(g);
  g.reload();
  await loaded;
  return { ok: true };
}

async function stop() {
  const g = getGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try { g.stop(); } catch (e) {}
  return { ok: true };
}

function getURL() { const g = getGuest(); try { return g ? g.getURL() : ''; } catch (e) { return ''; } }
function getTitle() { const g = getGuest(); try { return g ? g.getTitle() : ''; } catch (e) { return ''; } }

// A page snippet can return a promise that never settles (an await on an event
// that never fires, a navigation mid-flight). Race it so a hung page never
// freezes the agent loop, and always hand back a reason the model can act on.
function jsWithTimeout(g, code, userGesture, ms) {
  const limit = Number(ms) || 15000;
  let timer = null;
  const guard = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`page script did not settle within ${Math.round(limit / 1000)}s`)), limit);
  });
  return Promise.race([g.executeJavaScript(String(code), !!userGesture), guard])
    .finally(() => clearTimeout(timer));
}

async function executeJS(code, userGesture) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try {
    const result = await jsWithTimeout(g, code, userGesture, 15000);
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Read the current page as structured text (what the agent "sees").
async function read() {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try {
    const snapshot = await jsWithTimeout(g, `(function () {
      const links = Array.from(document.querySelectorAll('a[href]')).map(a => a.innerText.trim() + ' -> ' + a.href).filter(x => x).slice(0, 200);
      const buttons = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).map(b => (b.innerText || b.value || b.getAttribute('aria-label') || '').trim()).filter(x => x).slice(0, 100);
      const inputs = Array.from(document.querySelectorAll('input, textarea, select')).map(i => ({
        tag: i.tagName.toLowerCase(),
        name: i.name || '',
        type: i.type || '',
        id: i.id || '',
        placeholder: i.placeholder || ''
      })).slice(0, 60);
      return {
        title: document.title,
        url: location.href,
        text: (document.body ? document.body.innerText : '').slice(0, 60000),
        links, buttons, inputs
      };
    })()`);
    return { ok: true, url: getURL(), ...snapshot };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function click(selector, index) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  const i = Number(index) || 0;
  try {
    const r = await jsWithTimeout(g, `(function () {
      const els = document.querySelectorAll(${JSON.stringify(selector)});
      const el = els[${i}];
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      el.click();
      return { found: true, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 200) };
    })()`, true);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function type(selector, text) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try {
    const r = await jsWithTimeout(g, `(function () {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true };
    })()`, true);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function press(key) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try {
    await jsWithTimeout(g, `(function () {
      const el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: ${JSON.stringify(key)}, bubbles: true }));
    })()`, true);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Hover: dispatch the full mouseover/mouseenter/mousemove chain so CSS :hover
// menus and JS tooltips open.
async function hover(selector, index) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  const i = Number(index) || 0;
  try {
    const r = await jsWithTimeout(g, `(function () {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${i}];
      if (!el) return { found: false };
      el.scrollIntoView({ block: 'center' });
      const rect = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      ['mouseover', 'mouseenter', 'mousemove'].forEach((t) => el.dispatchEvent(new MouseEvent(t, opts)));
      return { found: true, tag: el.tagName, text: (el.innerText || '').slice(0, 200) };
    })()`, true);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Select an <option> in a <select> by value or visible label.
async function select(selector, value) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try {
    const r = await jsWithTimeout(g, `(function () {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { found: false };
      const want = ${JSON.stringify(String(value == null ? '' : value))};
      let matched = false;
      for (const opt of Array.from(el.options || [])) {
        if (opt.value === want || opt.text.trim() === want) { el.value = opt.value; matched = true; break; }
      }
      if (!matched && el.options && el.options.length) { el.selectedIndex = Number(want); matched = true; }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, value: el.value };
    })()`, true);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Scroll the page (or a selector) by a pixel delta.
async function scroll(direction, amount, selector) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  const dir = String(direction || 'down').toLowerCase();
  const amt = Number(amount) || 600;
  const dx = dir === 'left' ? -amt : dir === 'right' ? amt : 0;
  const dy = dir === 'up' ? -amt : dir === 'down' ? amt : 0;
  try {
    const r = await jsWithTimeout(g, `(function () {
      const target = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : 'null'};
      const el = target || window;
      if (target) {
        target.scrollBy({ top: ${dy}, left: ${dx}, behavior: 'instant' });
        return { found: true, scrollTop: target.scrollTop, scrollLeft: target.scrollLeft };
      }
      window.scrollBy(${dx}, ${dy});
      return { found: true, scrollY: window.scrollY, scrollX: window.scrollX };
    })()`);
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// Poll until an element matching the selector exists (or times out).
async function waitFor(selector, timeoutMs) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  const limit = Math.min(Math.max(Number(timeoutMs) || 5000, 250), 30000);
  const start = Date.now();
  while (Date.now() - start < limit) {
    try {
      const found = await jsWithTimeout(g, `!!document.querySelector(${JSON.stringify(selector)})`, false);
      if (found) return { ok: true, found: true, waited: Date.now() - start };
    } catch (e) { /* page may be navigating */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  return { ok: true, found: false, waited: Date.now() - start };
}

// Capture a PNG of the visible viewport and save it to a temp file. Returns the
// path (the agent can Read it) plus dimensions.
async function screenshot(fullPage) {
  const g = await ensureGuest();
  if (!g) return { ok: false, error: 'Browser pane is not open' };
  try {
    if (fullPage) {
      // Scroll-to-fit capture: measure the document and emulate a tall viewport.
      try {
        const h = await jsWithTimeout(g, 'Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)', false);
        if (h && h > 0) {
          const width = g.getOwnerBrowserWindow() ? g.getOwnerBrowserWindow().getContentSize()[0] : 1280;
          const dev = await jsWithTimeout(g, 'window.devicePixelRatio || 1', false);
          await g.setVisualZoomLevelLimits(1, 1).catch(() => {});
          await g.enableDeviceEmulation({
            screenPosition: 'desktop',
            screenSize: { width, height: Math.min(h, 20000) },
            viewSize: { width, height: Math.min(h, 20000) },
            deviceScaleFactor: dev || 1,
            viewPosition: { x: 0, y: 0 },
          }).catch(() => {});
          await new Promise((r) => setTimeout(r, 250));
          const img = await g.capturePage();
          await g.disableDeviceEmulation().catch(() => {});
          const file = path.join(os.tmpdir(), 'heliobot-shot-' + Date.now() + '.png');
          fs.writeFileSync(file, img.toPNG());
          const sz = img.getSize();
          return { ok: true, path: file, width: sz.width, height: sz.height };
        }
      } catch (e) { /* fall through to viewport capture */ }
    }
    const img = await g.capturePage();
    const file = path.join(os.tmpdir(), 'heliobot-shot-' + Date.now() + '.png');
    fs.writeFileSync(file, img.toPNG());
    const sz = img.getSize();
    return { ok: true, path: file, width: sz.width, height: sz.height };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- Tabs (state is owned by the renderer; commands are broadcast to it) ----
function syncTabs(state) {
  if (state && typeof state === 'object') tabsState = { tabs: state.tabs || [], activeId: state.activeId || null };
  return { ok: true };
}

function listTabs() {
  return { ok: true, tabs: tabsState.tabs, activeId: tabsState.activeId };
}

function sendTabCommand(cmd) {
  if (!tabCommandFn) return { ok: false, error: 'No browser pane attached' };
  try { tabCommandFn(cmd); } catch (e) { return { ok: false, error: e.message }; }
  return { ok: true };
}

module.exports = {
  setEnsurePane, setTabCommand,
  register, unregister, getGuest, hasGuest, ensureGuest,
  loadURL, goBack, goForward, reload, stop,
  getURL, getTitle, executeJS, read, click, type, press,
  hover, select, scroll, waitFor, screenshot,
  syncTabs, listTabs, sendTabCommand,
  normalizeUrl, localFileUrl,
};
