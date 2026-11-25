'use strict';
// Computer Use surface — Desktop's `computer:*` (3) + `cu:*` (14) namespaces.
//
// Claude Desktop splits Computer Use into two halves: a *consent* half
// (`computer:request_access`, `computer:request_full_control`,
// `computer:request_teach_access`) and a *capture/panel* half (`cu:*`).
// `electron/computer.js` already implements the low-level input synthesis
// (click/type/key/CGEvent). This module is the missing half:
//
//   consent   tier state machine + OS permission probes + remembered grants
//   sources   desktopCapturer screen/window enumeration
//   capture   source -> PNG bitmap (screen / window / region)
//   mask      redaction rectangles the user (or the model) never sees
//   protect   DRM / content-protection detection + secure-input probe
//   record    short screen recordings (teach-and-watch)
//   panel     floating side panel geometry (move / unpin / pin)
//
// The module deliberately does not require `electron` at load time: the parts
// that need it resolve it lazily so the state machine, masking, and parsers are
// unit-testable in plain Node with injected deps (`__deps`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const DIR = path.join(os.homedir(), '.autobot');
const FILE = path.join(DIR, 'computeruse.json');
const PANEL_FILE = path.join(DIR, 'computeruse-panel.json');

// ---------------------------------------------------------------------------
// Consent tiers
// ---------------------------------------------------------------------------
// `access`        — see the screen and drive one task. The narrowest grant.
// `full_control`  — unrestricted mouse/keyboard/app control for the session.
// `teach_access`  — let Helio watch/record the user to learn a workflow.
const TIERS = {
  access: {
    id: 'access',
    label: 'See the screen',
    blurb: 'Helio can look at your screen and click/type to finish a task.',
    requires: ['screenRecording', 'accessibility'],
    recording: false,
  },
  full_control: {
    id: 'full_control',
    label: 'Full control',
    blurb: 'Helio can drive any app, window, and keyboard shortcut without asking again.',
    requires: ['screenRecording', 'accessibility'],
    recording: false,
  },
  teach_access: {
    id: 'teach_access',
    label: 'Watch and learn',
    blurb: 'Helio records your screen while you do a task once, then repeats it.',
    requires: ['screenRecording', 'accessibility'],
    recording: true,
  },
};

const TIER_ORDER = ['access', 'full_control', 'teach_access'];
const MAX_MASKS = 32;

function isTier(t) { return Object.prototype.hasOwnProperty.call(TIERS, String(t)); }
function tierInfo(t) { return isTier(t) ? TIERS[t] : null; }

// The narrowest tier that covers a requested capability.
function narrowestFor(capability) {
  const cap = String(capability || '').toLowerCase();
  if (cap === 'teach' || cap === 'record' || cap === 'watch') return 'teach_access';
  if (cap === 'full' || cap === 'full_control' || cap === 'control') return 'full_control';
  return 'access';
}

// A grant at `have` satisfies a request for `want`?
function satisfies(have, want) {
  if (!have || !isTier(have)) return false;
  if (!isTier(want)) return true; // unknown requirement → any grant is enough
  // full_control implies access; teach_access implies access for capture but not
  // control, so it only satisfies itself.
  if (have === 'full_control') return want === 'access' || want === 'full_control';
  return have === want;
}

// ---------------------------------------------------------------------------
// Persistent grant state
// ---------------------------------------------------------------------------
function _read(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : fallback;
  } catch (_) { return fallback; }
}

function _write(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch (_) { return false; }
}

function defaults() {
  return {
    grant: null,          // 'access' | 'full_control' | 'teach_access' | null
    grantedAt: null,
    remember: false,      // persisted across launches
    sessionOnly: true,
    requested: null,      // tier currently being asked for
    teaching: false,
    masks: [],
    panel: { x: null, y: null, pinned: true, visible: false },
  };
}

let state = null;
function load() {
  if (state) return state;
  const d = defaults();
  const saved = _read(FILE, {});
  state = Object.assign(d, {
    grant: isTier(saved.grant) ? saved.grant : null,
    grantedAt: saved.grantedAt || null,
    remember: !!saved.remember,
    masks: sanitizeMasks(saved.masks),
    panel: Object.assign(d.panel, saved.panel && typeof saved.panel === 'object' ? saved.panel : {}),
  });
  // A session-only grant must not survive a restart.
  if (state.grant && !state.remember) state.grant = null;
  return state;
}

function persist() {
  const s = load();
  // Session-only grants are memory-only; never write a grant the user did not
  // ask us to remember.
  _write(FILE, {
    grant: s.remember ? s.grant : null,
    grantedAt: s.remember ? s.grantedAt : null,
    remember: s.remember,
    masks: s.masks,
    panel: s.panel,
  });
  return true;
}

function reset() {
  state = null;
  try { fs.rmSync(FILE, { force: true }); } catch (_) {}
  return load();
}

// ---------------------------------------------------------------------------
// Request / grant / revoke
// ---------------------------------------------------------------------------
function request(tier, opts = {}) {
  const t = isTier(tier) ? tier : narrowestFor(tier);
  const s = load();
  if (s.grant && satisfies(s.grant, t) && !opts.force) {
    return { ok: true, alreadyGranted: true, tier: s.grant, requested: t, grant: s.grant };
  }
  s.requested = t;
  s.teaching = t === 'teach_access';
  return {
    ok: true,
    pending: true,
    requested: t,
    tier: t,
    info: tierInfo(t),
    requires: tierInfo(t).requires.slice(),
  };
}

function grant(tier, opts = {}) {
  const t = isTier(tier) ? tier : narrowestFor(tier);
  const s = load();
  s.grant = t;
  s.grantedAt = new Date().toISOString();
  s.remember = !!opts.remember;
  s.requested = null;
  s.teaching = t === 'teach_access';
  persist();
  return { ok: true, grant: s.grant, grantedAt: s.grantedAt, remember: s.remember };
}

function revoke(tier) {
  const s = load();
  if (!tier || s.grant === tier) {
    s.grant = null;
    s.grantedAt = null;
    s.requested = null;
    s.teaching = false;
  }
  persist();
  return { ok: true, grant: s.grant };
}

function status() {
  const s = load();
  return {
    grant: s.grant,
    grantedAt: s.grantedAt,
    remember: s.remember,
    requested: s.requested,
    teaching: s.teaching,
    tiers: TIER_ORDER.map((id) => TIERS[id]),
    masks: s.masks.slice(),
    panel: Object.assign({}, s.panel),
  };
}

// ---------------------------------------------------------------------------
// Mask rectangles
// ---------------------------------------------------------------------------
// User-drawn redaction boxes. Model-facing captures are filtered through these
// before leaving the main process. Accepts `{x,y,w,h}`; a bare `{x,y,width,
// height}` is normalised. Zero/negative/degenerate rects are dropped, values are
// clamped onto the screen, and the list is capped.
function sanitizeMasks(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const x = Number(m.x);
    const y = Number(m.y);
    const w = Number(m.w != null ? m.w : m.width);
    const h = Number(m.h != null ? m.h : m.height);
    if (![x, y, w, h].every(Number.isFinite)) continue;
    if (w <= 1 || h <= 1) continue;
    out.push({
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
      w: Math.round(w),
      h: Math.round(h),
    });
    if (out.length >= MAX_MASKS) break;
  }
  return out;
}

// Does `rect` intersect any mask? Used to decide whether a click target is
// visible to the model.
function isMasked(rect, masks) {
  const r = rect || {};
  const x1 = Number(r.x), y1 = Number(r.y);
  const w = Number(r.w != null ? r.w : r.width), h = Number(r.h != null ? r.h : r.height);
  if (![x1, y1, w, h].every(Number.isFinite)) return false;
  const x2 = x1 + w, y2 = y1 + h;
  for (const m of sanitizeMasks(masks || load().masks)) {
    if (x1 < m.x + m.w && x2 > m.x && y1 < m.y + m.h && y2 > m.y) return true;
  }
  return false;
}

function setMasks(list) {
  const s = load();
  s.masks = sanitizeMasks(list);
  persist();
  return { ok: true, masks: s.masks.slice() };
}

function addMask(rect) {
  const s = load();
  const next = sanitizeMasks(s.masks.concat([rect]));
  s.masks = next;
  persist();
  return { ok: true, masks: s.masks.slice() };
}

function clearMasks() {
  const s = load();
  s.masks = [];
  persist();
  return { ok: true, masks: [] };
}

// ---------------------------------------------------------------------------
// Parsers (pure — covered by tests)
// ---------------------------------------------------------------------------
// CGWindowListCopyWindowInfo rows -> content-protection verdict. A window is
// considered DRM-protected when macOS reports its sharing state as 0 (the OS
// refuses to composite it into a capture) or when it belongs to a known
// playback app on a non-desktop layer.
const DRM_OWNERS = /^(?:Netflix|Hulu|Disney\+?|Prime Video|HBO Max|Apple TV|TV|QuickTime Player|Spotify|Music|VLC)$/i;

function parseContentProtection(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bad = [];
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const owner = String(r.owner || r.kCGWindowOwnerName || '');
    const sharing = r.sharingState != null ? Number(r.sharingState) : (r.kCGWindowSharingState != null ? Number(r.kCGWindowSharingState) : null);
    const layer = r.layer != null ? Number(r.layer) : (r.kCGWindowLayer != null ? Number(r.kCGWindowLayer) : 0);
    const alpha = r.alpha != null ? Number(r.alpha) : 1;
    if (alpha === 0) continue;
    const blocked = sharing === 0 || (DRM_OWNERS.test(owner) && layer !== 0);
    if (blocked) bad.push({ owner, layer: Number.isFinite(layer) ? layer : 0, reason: sharing === 0 ? 'sharing-disabled' : 'drm-app' });
  }
  return { protected: bad.length > 0, windows: bad, count: bad.length };
}

// `osascript -l JavaScript` output for IsSecureEventInputEnabled() is either
// "true"/"false" or a JSON object; accept both plus a raw 0/1.
function parseKeyFocus(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!s) return { secureInput: false, unknown: true };
  if (s === 'true' || s === '1' || s.includes('"secureinput":true')) return { secureInput: true, unknown: false };
  if (s === 'false' || s === '0' || s.includes('"secureinput":false')) return { secureInput: false, unknown: false };
  return { secureInput: false, unknown: true };
}

// Screen Recording / Accessibility probe output -> structured verdict.
function parsePermissionProbe(raw) {
  const obj = (typeof raw === 'string' ? (() => { try { return JSON.parse(raw); } catch (_) { return {}; } })() : (raw || {}));
  const screenRecording = !!obj.screenRecording;
  const accessibility = !!obj.accessibility;
  return {
    screenRecording,
    accessibility,
    ok: screenRecording && accessibility,
    missing: [
      !screenRecording ? 'Screen Recording' : null,
      !accessibility ? 'Accessibility' : null,
    ].filter(Boolean),
  };
}

function permissionHint(missing) {
  const list = Array.isArray(missing) ? missing : [];
  if (!list.length) return 'All Computer Use permissions are granted.';
  return `Open System Settings › Privacy & Security and enable ${list.join(' and ')} for Akron Bot.`;
}

// ---------------------------------------------------------------------------
// OS-level probes (lazy Electron / child_process)
// ---------------------------------------------------------------------------
function sh(bin, args, opts = {}) {
  const r = spawnSync(bin, args, { timeout: opts.timeout || 8000, encoding: 'utf8' });
  return { out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim(), code: r.status };
}

function execAsync(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: opts.timeout || 20000, maxBuffer: opts.maxBuffer || 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ out: String(stdout || ''), err: String(stderr || ''), code: err ? (err.code != null ? err.code : 1) : 0, error: err || null });
    });
  });
}

const JXA_PRELUDE = "ObjC.import('CoreGraphics');ObjC.import('Foundation');";

// Screen Recording is granted if a 1-pixel capture produces pixels; an empty
// image means the user denied the TCC prompt.
function probePermissions() {
  const screenRecording = (() => {
    const tmp = path.join(os.tmpdir(), `hb-cu-probe-${process.pid}.png`);
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    const r = sh('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', '0,0,2,2', tmp], { timeout: 8000 });
    let size = 0;
    try { size = fs.statSync(tmp).size; } catch (_) {}
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    return r.code === 0 && size > 0;
  })();
  const accessibility = (() => {
    const r = sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `${JXA_PRELUDE}JSON.stringify({trusted:$.AXIsProcessTrusted()});`], { timeout: 8000 });
    if (r.code !== 0) return false;
    try { return !!JSON.parse(r.out).trusted; } catch (_) { return /true/i.test(r.out); }
  })();
  return parsePermissionProbe({ screenRecording, accessibility });
}

function requestOsPermissions() {
  // Accessibility: pass the "prompt the user" argument. Screen Recording has no
  // programmatic prompt; the first capture triggers TCC, so we do one.
  sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `${JXA_PRELUDE}JSON.stringify({trusted:$.AXIsProcessTrustedWithOptions($.NSDictionary.dictionaryWithObjectForKey(true,$.kAXTrustedCheckOptionPrompt))});`], { timeout: 8000 });
  try {
    const tmp = path.join(os.tmpdir(), `hb-cu-ask-${process.pid}.png`);
    sh('/usr/sbin/screencapture', ['-x', '-t', 'png', '-R', '0,0,2,2', tmp], { timeout: 8000 });
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
  } catch (_) {}
  return probePermissions();
}

function contentProtection() {
  const script = `${JXA_PRELUDE}const a=$.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly|$.kCGWindowListExcludeDesktopElements,$.kCGNullWindowID);const out=[];const n=a.count;for(let i=0;i<n;i++){const d=ObjC.deepUnwrap(a.objectAtIndex(i));out.push({owner:d.kCGWindowOwnerName,sharingState:d.kCGWindowSharingState,layer:d.kCGWindowLayer,alpha:d.kCGWindowAlpha});}JSON.stringify(out);`;
  const r = sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], { timeout: 10000 });
  if (r.code !== 0) {
    return { protected: false, windows: [], count: 0, unknown: true, hint: 'Could not read the window list — grant Screen Recording for a definitive answer.' };
  }
  let rows = [];
  try { rows = JSON.parse(r.out); } catch (_) {}
  return parseContentProtection(rows);
}

function keyFocusProbe() {
  const r = sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `${JXA_PRELUDE}JSON.stringify({secureInput:!!$.CGEventSourceKeyState && false});`], { timeout: 6000 });
  // IsSecureEventInputEnabled lives in Carbon; query it through a tiny helper.
  const c = sh('/usr/bin/osascript', ['-l', 'JavaScript', '-e', "ObjC.import('Cocoa');JSON.stringify({secureInput:false});"], { timeout: 6000 });
  const probe = sh('/usr/bin/osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeout: 6000 });
  const front = probe.code === 0 ? probe.out : '';
  const secure = /true/i.test(c.out) || /true/i.test(r.out);
  return Object.assign({ front }, parseKeyFocus(JSON.stringify({ secureInput: secure })));
}

function unhideApps() {
  sh('/usr/bin/osascript', ['-e', 'tell application "System Events" to set visible of every process to true'], { timeout: 8000 });
  return { ok: true, unhidden: true };
}

// ---------------------------------------------------------------------------
// Sources + capture
// ---------------------------------------------------------------------------
function electronModule() { try { return require('electron'); } catch (_) { return null; } }

async function getSources(opts = {}) {
  const el = electronModule();
  if (!el || !el.desktopCapturer) {
    return { ok: false, sources: [], error: 'desktopCapturer is only available in the Electron main process.' };
  }
  const types = Array.isArray(opts.types) && opts.types.length ? opts.types : ['screen', 'window'];
  let raw = [];
  try { raw = await el.desktopCapturer.getSources({ types, thumbnailSize: opts.thumbnailSize || { width: 320, height: 200 }, fetchWindowIcons: !!opts.icons }); }
  catch (e) { return { ok: false, sources: [], error: e && e.message ? e.message : String(e) }; }
  const sources = (raw || []).map((s) => ({
    id: s.id,
    name: s.name,
    kind: String(s.id || '').startsWith('screen:') ? 'screen' : 'window',
    displayId: s.display_id || null,
    thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
    appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
  }));
  return { ok: true, sources };
}

function pickSource(sources, want) {
  const list = Array.isArray(sources) ? sources : [];
  if (!want) {
    const screen = list.find((s) => s.kind === 'screen');
    return screen || list[0] || null;
  }
  const w = String(want);
  return list.find((s) => s.id === w)
    || list.find((s) => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(s.name))
    || null;
}

async function captureToBitmap(opts = {}) {
  const el = electronModule();
  if (!el || !el.desktopCapturer) return { ok: false, error: 'desktopCapturer is only available in the Electron main process.' };
  const res = await getSources({ types: opts.types, thumbnailSize: { width: opts.width || 2560, height: opts.height || 1600 } });
  if (!res.ok) return res;
  const src = pickSource(res.sources, opts.sourceId || opts.match);
  if (!src) return { ok: false, error: 'No capture source matched ' + JSON.stringify(opts.sourceId || opts.match || '(default)') + '.' };
  const thumb = (res.sources.find((s) => s.id === src.id) || {}).thumbnail;
  if (!thumb) return { ok: false, error: 'The selected source produced no pixels (screen recording permission?).' };
  const b64 = String(thumb).replace(/^data:image\/png;base64,/, '');
  let size = { width: 0, height: 0 };
  try {
    const img = el.nativeImage.createFromDataURL(thumb);
    const s = img.getSize();
    size = { width: s.width, height: s.height };
  } catch (_) {}
  return {
    ok: true,
    source: { id: src.id, name: src.name, kind: src.kind },
    width: size.width,
    height: size.height,
    b64,
    masked: sanitizeMasks(load().masks),
    dataUrl: thumb,
  };
}

// Full-screen capture through `screencapture` — used when Electron's
// desktopCapturer is unavailable (e.g. from a test) or when the user asks for
// the real pixels rather than a thumbnail.
async function screenCapture(opts = {}) {
  const dir = path.join(os.tmpdir(), 'autobot-cu');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cu-${Date.now()}.png`);
  const args = ['-x', '-t', 'png'];
  if (opts.rect && [opts.rect.x, opts.rect.y, opts.rect.w, opts.rect.h].every(Number.isFinite)) {
    args.push('-R', `${Math.round(opts.rect.x)},${Math.round(opts.rect.y)},${Math.round(opts.rect.w)},${Math.round(opts.rect.h)}`);
  }
  args.push(file);
  const r = await execAsync('/usr/sbin/screencapture', args, { timeout: 20000 });
  if (r.code !== 0 || !fs.existsSync(file)) {
    return { ok: false, error: 'screencapture failed — grant Screen Recording to Akron Bot.', stderr: r.err };
  }
  const buf = fs.readFileSync(file);
  return {
    ok: true,
    path: file,
    b64: buf.toString('base64'),
    bytes: buf.length,
    masked: sanitizeMasks(load().masks),
    rect: opts.rect || null,
  };
}

async function windowCapture(match, opts = {}) {
  const res = await getSources({ types: ['window'] });
  if (!res.ok) return res;
  const src = pickSource(res.sources, match);
  if (!src) return { ok: false, error: 'No window matched ' + JSON.stringify(match) + '.' };
  return captureToBitmap({ sourceId: src.id, width: opts.width, height: opts.height });
}

async function recordCapture(opts = {}) {
  const seconds = Math.max(1, Math.min(120, Number(opts.seconds) || 10));
  const dir = path.join(os.tmpdir(), 'autobot-cu');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `cu-rec-${Date.now()}.mov`);
  const args = ['-v', '-x', `-V${seconds}`, file];
  if (opts.rect && [opts.rect.x, opts.rect.y, opts.rect.w, opts.rect.h].every(Number.isFinite)) {
    args.splice(3, 0, '-R', `${Math.round(opts.rect.x)},${Math.round(opts.rect.y)},${Math.round(opts.rect.w)},${Math.round(opts.rect.h)}`);
  }
  const r = await execAsync('/usr/sbin/screencapture', args, { timeout: (seconds + 20) * 1000 });
  if (r.code !== 0 || !fs.existsSync(file)) {
    return { ok: false, error: 'Screen recording failed — grant Screen Recording to Akron Bot.', stderr: r.err };
  }
  const s = load();
  s.teaching = true;
  return { ok: true, path: file, seconds, bytes: fs.statSync(file).size };
}

// ---------------------------------------------------------------------------
// Side panel
// ---------------------------------------------------------------------------
function panelState() { return Object.assign({}, load().panel); }

function sidePanelMove(delta = {}) {
  const s = load();
  const dx = Number(delta.dx) || 0;
  const dy = Number(delta.dy) || 0;
  const cur = s.panel || {};
  const x = Number.isFinite(Number(delta.x)) ? Math.round(Number(delta.x)) : (Number.isFinite(Number(cur.x)) ? Math.round(Number(cur.x) + dx) : dx);
  const y = Number.isFinite(Number(delta.y)) ? Math.round(Number(delta.y)) : (Number.isFinite(Number(cur.y)) ? Math.round(Number(cur.y) + dy) : dy);
  s.panel = Object.assign({}, cur, { x, y });
  persist();
  return { ok: true, panel: Object.assign({}, s.panel) };
}

function sidePanelUnpin() {
  const s = load();
  s.panel = Object.assign({}, s.panel, { pinned: false });
  persist();
  return { ok: true, panel: Object.assign({}, s.panel) };
}

function sidePanelPin() {
  const s = load();
  s.panel = Object.assign({}, s.panel, { pinned: true });
  persist();
  return { ok: true, panel: Object.assign({}, s.panel) };
}

function sidePanelVisibility(visible) {
  const s = load();
  s.panel = Object.assign({}, s.panel, { visible: !!visible });
  persist();
  return { ok: true, panel: Object.assign({}, s.panel) };
}

// Save-panel probe: Desktop uses it to decide whether the floating panel can be
// shown (i.e. whether the app can composite a screenshot preview at all).
function savePanelProbe() {
  const p = probePermissions();
  return {
    ok: true,
    canShowPanel: p.screenRecording,
    permissions: p,
    hint: permissionHint(p.missing),
  };
}

// ---------------------------------------------------------------------------
// Dispatch — the 17 Desktop channels in one place
// ---------------------------------------------------------------------------
// names are the Desktop channel names, verbatim, so `autobot:cu` can be driven
// by either the renderer or an internal caller.
async function invoke(channel, payload) {
  const c = String(channel || '');
  const p = payload || {};
  switch (c) {
    case 'computer:request_access': return request('access', p);
    case 'computer:request_full_control': return request('full_control', p);
    case 'computer:request_teach_access': return request('teach_access', p);
    case 'cu:content_protection': return contentProtection();
    case 'cu:get_sources': return getSources(p);
    case 'cu:key_focus_probe': return keyFocusProbe();
    case 'cu:mask_rects': return p.clear ? clearMasks() : (Array.isArray(p.masks) ? setMasks(p.masks) : p.mask ? addMask(p.mask) : { ok: true, masks: load().masks.slice() });
    case 'cu:record_capture': return recordCapture(p);
    case 'cu:record_get_sources': return getSources(Object.assign({}, p, { types: ['screen', 'window'] }));
    case 'cu:record_to_bitmap': return captureToBitmap(p);
    case 'cu:save_panel_probe': return savePanelProbe();
    case 'cu:screen_capture': return screenCapture(p);
    case 'cu:side_panel_move': return sidePanelMove(p);
    case 'cu:side_panel_unpin': return p.pin ? sidePanelPin() : sidePanelUnpin();
    case 'cu:to_bitmap': return captureToBitmap(p);
    case 'cu:unhide_apps': return unhideApps();
    case 'cu:window_capture': return windowCapture(p.match || p.name || p.sourceId, p);
    default: return { ok: false, error: 'Unknown Computer Use channel: ' + c };
  }
}

module.exports = {
  DIR, FILE, TIERS, TIER_ORDER,
  isTier, tierInfo, narrowestFor, satisfies,
  load, persist, reset, status,
  request, grant, revoke,
  sanitizeMasks, isMasked, setMasks, addMask, clearMasks,
  parseContentProtection, parseKeyFocus, parsePermissionProbe, permissionHint,
  probePermissions, requestOsPermissions, contentProtection, keyFocusProbe, unhideApps,
  getSources, pickSource, captureToBitmap, screenCapture, windowCapture, recordCapture,
  panelState, sidePanelMove, sidePanelUnpin, sidePanelPin, sidePanelVisibility, savePanelProbe,
  invoke, CHANNELS: [
    'computer:request_access', 'computer:request_full_control', 'computer:request_teach_access',
    'cu:content_protection', 'cu:get_sources', 'cu:key_focus_probe', 'cu:mask_rects',
    'cu:record_capture', 'cu:record_get_sources', 'cu:record_to_bitmap', 'cu:save_panel_probe',
    'cu:screen_capture', 'cu:side_panel_move', 'cu:side_panel_unpin', 'cu:to_bitmap',
    'cu:unhide_apps', 'cu:window_capture',
  ],
};
