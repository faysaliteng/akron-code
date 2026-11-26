'use strict';
// Chrome extension host — Akron Code parity with Desktop's `extension-host`
// namespace (11 IPC channels).
//
// Two halves, exactly like the shipping app:
//
//   1. HOST PROTOCOL (this module, main process)
//      invoke · servesPage · listen · event · event-ack · installed ·
//      report-again · port-to-host · port-to-context · agentic-call ·
//      agentic-reply
//
//      `invoke(api, args)` takes a `chrome.*` path ("tabs.query",
//      "storage.local.get", "cookies.getAll") and answers it. Namespaces Helio
//      Bot can serve itself are answered natively (tabs, windows, storage,
//      cookies, notifications, action, alarms, i18n, runtime, permissions,
//      management, commands, contextMenus, debugger). Everything else is
//      forwarded to a connected Chrome extension over the bridge.
//
//   2. EXTENSION BRIDGE (loopback WebSocket)
//      A real MV3 extension running in the user's Chrome connects to
//      127.0.0.1:<port> and either serves `invoke` requests (so agentic mode
//      and Chrome-only namespaces work) or pushes `event` frames that become
//      `chrome.runtime.onMessage` deliveries in the hosted page.
//
// The channel semantics deliberately mirror the Desktop preload: replies are
// `{ok:true,value}` / `{ok:false,message}`, page lookups respect
// `web_accessible_resources`, and traversal is rejected before the filesystem
// is touched.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Electron is optional so every contract in test/extensionhost.test.js runs
// headless (`node test/extensionhost.test.js`).
let electron = null;
try { electron = require('electron'); } catch (_) { electron = null; }

// ---------------------------------------------------------------------------
// 1. Channel table (verbatim names from the Desktop preload)
// ---------------------------------------------------------------------------
const CHANNELS = Object.freeze({
  invoke: 'extension-host:invoke',
  servesPage: 'extension-host:serves-page',
  listen: 'extension-host:listen',
  event: 'extension-host:event',
  eventAck: 'extension-host:event-ack',
  installed: 'extension-host:installed',
  reportAgain: 'extension-host:report-again',
  portToHost: 'extension-host:port-to-host',
  portToContext: 'extension-host:port-to-context',
  agenticCall: 'extension-host:agentic-call',
  agenticReply: 'extension-host:agentic-reply',
});

// Short name -> canonical channel, so callers may use either form.
const CHANNEL_ALIASES = (() => {
  const m = new Map();
  for (const [short, full] of Object.entries(CHANNELS)) {
    m.set(short, full);
    m.set(full, full);
    m.set(full.replace(/^extension-host:/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase()), full);
  }
  return m;
})();

function canonicalChannel(name) {
  const key = String(name == null ? '' : name);
  return CHANNEL_ALIASES.get(key) || CHANNEL_ALIASES.get(key.toLowerCase()) || null;
}

// ---------------------------------------------------------------------------
// 2. Permission copy (identical wording to the Desktop prompt strings)
// ---------------------------------------------------------------------------
const PERMISSIONS = Object.freeze(new Map(Object.entries({
  clipboardRead: { warning: 'Read data you copy and paste' },
  contextMenus: { plain: 'Add items to right-click menus' },
  cookies: { plain: 'Read and change cookies on the sites it can reach' },
  gcm: { plain: 'Use Google’s messaging service' },
  identity: { plain: 'Ask you to sign in through the browser' },
  nativeMessaging: { warning: 'Communicate with cooperating native applications' },
  notifications: { warning: 'Display notifications' },
  privacy: { warning: 'Change your privacy-related settings' },
  tabs: { warning: 'Read your browsing history' },
  webNavigation: { warning: 'Read your browsing history' },
})));

// The one extension the agentic surface is allowed to drive (Claude in Chrome).
const AGENT_EXTENSION_IDS = Object.freeze(['gejiddohjgogedgjnonbofjigllpkmbf']);
const AGENTIC_OPS = Object.freeze([
  'agenticMode.enable',
  'agenticMode.disable',
  'agenticAutofill.fillCredential',
]);
function isAgenticOp(op) {
  return typeof op === 'string' && AGENTIC_OPS.includes(op);
}

// ---------------------------------------------------------------------------
// 3. Limits (Desktop: 4 MiB arguments, depth 32, 64 MiB port message)
// ---------------------------------------------------------------------------
const MAX_ARGS_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_PORT_MESSAGE = 64 * 1024 * 1024;
const MAX_PATH_LEN = 4096;
const MAX_RESOURCE_RULES = 100;
const INVOKE_TIMEOUT_MS = 30000;
const AGENTIC_TIMEOUT_MS = 25000;

const EXT_ID_RE = /^[a-p]{32}$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

// ---------------------------------------------------------------------------
// 4. Namespace registry
//
// `native` namespaces are answered by Akron Code itself. The rest exist so the
// hosted page sees the full `chrome` object and so `installed` can report
// "not permitted" / "no native namespace" exactly like Desktop.
// ---------------------------------------------------------------------------
function ns(namespace, opts = {}) {
  return {
    namespace,
    permission: opts.permission === undefined ? null : opts.permission,
    manifestKey: opts.manifestKey || null,
    methods: opts.methods || [],
    events: opts.events || [],
    constants: opts.constants || null,
    native: !!opts.native,
  };
}

const NAMESPACES = Object.freeze([
  ns('action', { manifestKey: 'action', native: true, methods: ['setTitle', 'getTitle', 'setIcon', 'setPopup', 'getPopup', 'setBadgeText', 'getBadgeText', 'setBadgeBackgroundColor', 'getBadgeBackgroundColor', 'setBadgeTextColor', 'getBadgeTextColor', 'enable', 'disable', 'isEnabled', 'getUserSettings', 'openPopup'], events: ['onClicked', 'onUserSettingsChanged'] }),
  ns('alarms', { native: true, methods: ['create', 'get', 'getAll', 'clear', 'clearAll'], events: ['onAlarm'] }),
  ns('bookmarks', { permission: 'bookmarks', methods: ['get', 'getChildren', 'search', 'create'], events: ['onCreated', 'onRemoved', 'onChanged'] }),
  ns('browsingData', { permission: 'browsingData', methods: ['remove', 'removeCookies', 'removeHistory'] }),
  ns('commands', { manifestKey: 'commands', native: true, methods: ['getAll'], events: ['onCommand'] }),
  ns('contentSettings', { permission: 'contentSettings', methods: ['get', 'set', 'clear'] }),
  ns('contextMenus', { permission: 'contextMenus', native: true, methods: ['create', 'update', 'remove', 'removeAll'], events: ['onClicked'] }),
  ns('cookies', { permission: 'cookies', native: true, methods: ['get', 'getAll', 'set', 'remove', 'getAllCookieStores'], events: ['onChanged'], constants: { SameSiteStatus: { LAX: 'lax', NO_RESTRICTION: 'no_restriction', STRICT: 'strict', UNSPECIFIED: 'unspecified' } } }),
  ns('debugger', { permission: 'debugger', native: true, methods: ['attach', 'detach', 'sendCommand', 'getTargets'], events: ['onDetach', 'onEvent'] }),
  ns('declarativeContent', { permission: 'declarativeContent', methods: ['onPageChanged'] }),
  ns('desktopCapture', { permission: 'desktopCapture', methods: ['chooseDesktopMedia'] }),
  ns('downloads', { permission: 'downloads', methods: ['download', 'search', 'cancel', 'pause', 'resume'], events: ['onCreated', 'onChanged'] }),
  ns('extension', { native: true, methods: ['isAllowedIncognitoAccess', 'isAllowedFileSchemeAccess', 'getViews'], events: [] }),
  ns('extensionPageClipboard', { native: true, methods: ['writeText'] }),
  ns('fontSettings', { permission: 'fontSettings', methods: ['getFont', 'setFont', 'clearFont'] }),
  ns('gcm', { permission: 'gcm', methods: ['register', 'unregister', 'send'], events: ['onMessage', 'onMessagesDeleted', 'onSendError'], constants: { MAX_MESSAGE_SIZE: 4096 } }),
  ns('history', { permission: 'history', methods: ['search', 'addUrl', 'deleteUrl'], events: ['onVisited', 'onVisitRemoved'] }),
  ns('i18n', { native: true, methods: ['getMessage', 'getUILanguage', 'getAcceptLanguages'] }),
  ns('identity', { permission: 'identity', methods: ['getProfileUserInfo', 'getAuthToken', 'removeCachedAuthToken', 'clearAllCachedAuthTokens'], events: ['onSignInChanged'], constants: { AccountStatus: { ANY: 'ANY', SYNC: 'SYNC' } } }),
  ns('idle', { permission: 'idle', methods: ['queryState', 'setDetectionInterval'], events: ['onStateChanged'] }),
  ns('instanceID', { methods: ['getID', 'deleteID', 'getCreationTime'] }),
  ns('management', { permission: 'management', native: true, methods: ['getAll', 'get', 'setEnabled', 'uninstall', 'getSelf'], events: ['onInstalled', 'onEnabled', 'onDisabled'] }),
  ns('notifications', { permission: 'notifications', native: true, methods: ['create', 'update', 'clear', 'getAll', 'getPermissionLevel'], events: ['onClicked', 'onClosed', 'onButtonClicked'] }),
  ns('omnibox', { manifestKey: 'omnibox', methods: ['setDefaultSuggestion'], events: ['onInputStarted', 'onInputChanged', 'onInputEntered'] }),
  ns('pageCapture', { permission: 'pageCapture', methods: ['saveAsMHTML'] }),
  ns('permissions', { native: true, methods: ['getAll', 'contains', 'request', 'remove'], events: ['onAdded', 'onRemoved'] }),
  ns('power', { permission: 'power', methods: ['requestKeepAwake', 'releaseKeepAwake'] }),
  ns('privacy', { permission: 'privacy', methods: ['network', 'services', 'websites'] }),
  ns('readingList', { permission: 'readingList', methods: ['addEntry', 'query', 'removeEntry'], events: ['onEntryAdded', 'onEntryRemoved'] }),
  ns('runtime', { native: true, methods: ['getManifest', 'getURL', 'getPlatformInfo', 'sendMessage', 'sendNativeMessage', 'connect', 'reload', 'setUninstallURL', 'getBackgroundPage', 'openOptionsPage', 'getContexts'], events: ['onMessage', 'onInstalled', 'onStartup', 'onConnect', 'onSuspend'] }),
  ns('scripting', { permission: 'scripting', native: true, methods: ['executeScript', 'insertCSS', 'removeCSS', 'getRegisteredContentScripts', 'registerContentScripts', 'unregisterContentScripts'], events: [] }),
  ns('search', { permission: 'search', methods: ['query'] }),
  ns('sessions', { permission: 'sessions', methods: ['getRecentlyClosed', 'getDevices', 'restore'], events: ['onChanged'] }),
  ns('sidePanel', { permission: 'sidePanel', native: true, methods: ['setOptions', 'getOptions', 'setPanelBehavior', 'open'] }),
  ns('storage', { native: true, methods: ['get', 'set', 'remove', 'clear', 'getBytesInUse'], events: ['onChanged'] }),
  ns('system', { methods: ['getInfo'] }),
  ns('tabCapture', { permission: 'tabCapture', methods: ['getMediaStreamId', 'capture'], events: ['onStatusChanged'] }),
  ns('tabGroups', { permission: 'tabGroups', native: true, methods: ['get', 'query', 'update'], events: ['onCreated', 'onUpdated', 'onRemoved'] }),
  ns('tabs', { permission: 'tabs', native: true, methods: ['get', 'getCurrent', 'query', 'create', 'update', 'remove', 'reload', 'duplicate', 'goBack', 'goForward', 'sendMessage', 'executeScript', 'captureVisibleTab'], events: ['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onHighlighted'] }),
  ns('topSites', { permission: 'topSites', methods: ['get'] }),
  ns('tts', { permission: 'tts', methods: ['speak', 'stop', 'getVoices'], events: [] }),
  ns('ttsEngine', { permission: 'ttsEngine', events: ['onSpeak', 'onStop'] }),
  ns('webAuthenticationProxy', { permission: 'webAuthenticationProxy', methods: ['attach', 'detach'] }),
  ns('webNavigation', { permission: 'webNavigation', methods: ['getFrame', 'getAllFrames'], events: ['onBeforeNavigate', 'onCommitted', 'onCompleted', 'onDOMContentLoaded', 'onHistoryStateUpdated'] }),
  ns('windows', { native: true, methods: ['get', 'getCurrent', 'getLastFocused', 'getAll', 'create', 'update', 'remove'], events: ['onCreated', 'onRemoved', 'onFocusChanged'] }),
]);

const NS_BY_NAME = new Map(NAMESPACES.map((n) => [n.namespace, n]));

// `chrome.storage.local.get` -> { namespace:'storage', path:['local','get'] }
function parseApi(api) {
  if (typeof api !== 'string' || !api.trim()) return null;
  const parts = api.trim().split('.').filter(Boolean);
  if (parts.length < 2) return null;
  const namespace = parts.shift();
  if (!NS_BY_NAME.has(namespace)) return null;
  return { namespace, path: parts };
}

// ---------------------------------------------------------------------------
// 5. Argument validation — same guard rails as the Desktop preload
// ---------------------------------------------------------------------------
function assertArgs(args, budget = MAX_ARGS_BYTES) {
  let bytes = 0;
  const walk = (v, depth) => {
    if (v == null) return v;
    const t = typeof v;
    if (t === 'string') { bytes += v.length + 2; }
    else if (t === 'number' || t === 'boolean') { bytes += 8; }
    else if (t === 'object') {
      if (depth > MAX_DEPTH) throw new Error('Invalid invocation: arguments are nested too deeply.');
      if (Array.isArray(v)) {
        for (const item of v) walk(item, depth + 1);
      } else {
        for (const k of Object.keys(v)) { bytes += k.length + 2; walk(v[k], depth + 1); }
      }
    } else {
      throw new Error('Invalid invocation: arguments cannot include functions, symbols or BigInt values.');
    }
    if (bytes > budget) throw new Error(`Invalid invocation: arguments are larger than ${Math.floor(budget / (1024 * 1024))} MiB.`);
    return v;
  };
  walk(args, 0);
  return true;
}

// Never let a raw JSON-RPC envelope, stack, or HTML body escape to the UI.
function sanitizeError(err) {
  const message = err && err.message != null ? String(err.message) : '';
  // `new Error('')` stringifies to "Error" — that is noise, not a reason.
  const isErrorLike = err instanceof Error || (err && typeof err.name === 'string' && typeof err.message === 'string');
  const raw = (message || (isErrorLike ? '' : String(err == null ? '' : err))).trim();
  if (!raw) return 'extension call failed';
  const first = raw.split('\n')[0];
  const clean = first
    .replace(/<[^>]{1,200}>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (clean || 'extension call failed').slice(0, 300);
}

function normalizeExtensionId(id) {
  const s = String(id == null ? '' : id).trim().toLowerCase();
  return EXT_ID_RE.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// 6. Page serving — chrome-extension://<id>/<path>
// ---------------------------------------------------------------------------
const PAGE_SCHEMES = Object.freeze(['chrome-extension:', 'autobot-extension:', 'helio-extension:']);

function parseExtensionUrl(url) {
  let u;
  try { u = new URL(String(url || '')); } catch (_) { return null; }
  if (!PAGE_SCHEMES.includes(u.protocol)) return null;
  const id = normalizeExtensionId(u.hostname);
  if (!id) return null;
  if (u.username || u.password || u.port) return null;
  let rel = u.pathname || '/';
  try { rel = decodeURIComponent(rel); } catch (_) { return null; }
  rel = rel.replace(/^\/+/, '');
  if (rel === '') rel = 'index.html';
  return { extensionId: id, path: rel, href: u.href };
}

// Reject encoded separators, dot segments, trailing dots/spaces and NULs
// before anything touches the filesystem.
function safeExtensionPath(rel) {
  const p = String(rel || '');
  if (!p || p.length > MAX_PATH_LEN) return null;
  if (/[\\\0]/.test(p)) return null;
  if (!SAFE_PATH_RE.test(p)) return null;
  const segments = p.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
    if (/[. ]$/.test(seg)) return null;
  }
  return p;
}

function globToRegExp(glob) {
  const g = String(glob || '');
  let out = '^';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { out += '.*'; i++; }
      else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$');
}

function matchPatternToRegExp(pattern) {
  const p = String(pattern || '');
  const m = /^(\*|https?|file|ftp):\/\/([^/]*)(\/.*)$/.exec(p);
  if (!m) return null;
  const [, scheme, host, rest] = m;
  const schemeRe = scheme === '*' ? 'https?' : scheme;
  // Escape the literal first, then splice in the wildcard, otherwise the
  // escaping pass would mangle the `(?:...)` group we just inserted.
  const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  let hostRe;
  if (host === '*') hostRe = '[^/]+';
  else if (host.startsWith('*.')) hostRe = '(?:[^/]+\\.)?' + esc(host.slice(2));
  else hostRe = esc(host);
  const pathRe = rest.split('*').map(esc).join('.*');
  return new RegExp('^' + schemeRe + '://' + hostRe + pathRe + '$');
}

function matchesAnyPattern(url, patterns) {
  if (!url) return false;
  for (const pat of patterns || []) {
    const re = matchPatternToRegExp(pat);
    if (re && re.test(url)) return true;
  }
  return false;
}

// MV2: array of globs. MV3: [{ resources:[glob], matches:[pattern] }].
function isWebAccessible(manifest, rel, initiatorUrl) {
  const war = manifest && manifest.web_accessible_resources;
  if (!Array.isArray(war)) return false;
  if (manifest.manifest_version === 2) {
    return war.slice(0, MAX_RESOURCE_RULES).some((glob) => globToRegExp(glob).test(rel));
  }
  const rules = war.slice(0, MAX_RESOURCE_RULES).filter((r) => r && typeof r === 'object');
  return rules.some((rule) => {
    if (!Array.isArray(rule.resources) || rule.resources.length > MAX_RESOURCE_RULES) return false;
    const hit = rule.resources.some((glob) => globToRegExp(glob).test(rel));
    if (!hit) return false;
    return matchesAnyPattern(initiatorUrl, rule.matches);
  });
}

// ---------------------------------------------------------------------------
// 7. Durable state (~/.autobot, never ~/.claude)
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(os.homedir(), '.autobot');
const EXT_DIR = path.join(DATA_DIR, 'extensions');
const STORAGE_FILE = path.join(DATA_DIR, 'extension-storage.json');
const STATE_FILE = path.join(DATA_DIR, 'extension-state.json');

function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
function readJSON(file, fallback) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fallback;
}
function writeJSON(file, v) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function declaredPermissions(manifest) {
  const perms = new Set();
  for (const k of ['permissions', 'optional_permissions']) {
    for (const p of (manifest && manifest[k]) || []) if (typeof p === 'string') perms.add(p);
  }
  for (const entry of ((manifest && manifest.host_permissions) || [])) if (typeof entry === 'string') perms.add(entry);
  return perms;
}

// ---------------------------------------------------------------------------
// 8. Native namespace implementations
//
// Each handler receives (path, args, ctx) and returns the value the caller
// gets back in `{ok:true,value}`. `ctx` = { host, extensionId, manifest }.
// ---------------------------------------------------------------------------
function electronApi() {
  if (!electron) throw new Error('extension host native APIs are unavailable outside the app');
  return electron;
}

const STORAGE_AREAS = Object.freeze(['local', 'sync', 'session', 'managed']);

function storageBag(host) {
  if (!host.storage || typeof host.storage !== 'object') host.storage = {};
  for (const area of STORAGE_AREAS) {
    if (!host.storage[area] || typeof host.storage[area] !== 'object') host.storage[area] = {};
  }
  return host.storage;
}

function pickKeys(bag, keys) {
  if (keys == null) return { ...bag };
  if (typeof keys === 'string') return { [keys]: Object.prototype.hasOwnProperty.call(bag, keys) ? bag[keys] : undefined };
  if (Array.isArray(keys)) {
    const out = {};
    for (const k of keys) out[k] = Object.prototype.hasOwnProperty.call(bag, k) ? bag[k] : undefined;
    return out;
  }
  if (typeof keys === 'object') {
    const out = { ...keys };
    for (const k of Object.keys(keys)) if (Object.prototype.hasOwnProperty.call(bag, k)) out[k] = bag[k];
    return out;
  }
  return {};
}

function browserTabs() {
  const browser = require('./browser');
  const state = browser.listTabs() || {};
  const tabs = Array.isArray(state.tabs) ? state.tabs : [];
  return tabs.map((t, i) => ({
    id: Number.isFinite(t.id) ? t.id : i + 1,
    index: i,
    active: t.active != null ? !!t.active : t.id === state.activeId,
    highlighted: !!t.active,
    pinned: false,
    url: t.url || '',
    title: t.title || '',
    windowId: 1,
    incognito: false,
  }));
}

function extensionStorage(method, path, args, ctx) {
  const area = path[0] && STORAGE_AREAS.includes(path[0]) ? path[0] : 'local';
  const op = area === path[0] ? path[1] : path[0];
  const bag = storageBag(ctx.host)[area];
  switch (op) {
    case 'get': return pickKeys(bag, args[0]);
    case 'getBytesInUse': {
      const picked = pickKeys(bag, args[0]);
      return Buffer.byteLength(JSON.stringify(picked), 'utf8');
    }
    case 'set': {
      const patch = args[0] && typeof args[0] === 'object' ? args[0] : {};
      const changes = {};
      for (const [k, v] of Object.entries(patch)) {
        changes[k] = { oldValue: bag[k], newValue: v };
        bag[k] = v;
      }
      ctx.host.saveStorage();
      ctx.host.deliverEvent('storage.onChanged', { changes, areaName: area });
      return undefined;
    }
    case 'remove': {
      const keys = Array.isArray(args[0]) ? args[0] : [args[0]];
      const changes = {};
      for (const k of keys) { if (k in bag) { changes[k] = { oldValue: bag[k] }; delete bag[k]; } }
      ctx.host.saveStorage();
      if (Object.keys(changes).length) ctx.host.deliverEvent('storage.onChanged', { changes, areaName: area });
      return undefined;
    }
    case 'clear': {
      const changes = {};
      for (const k of Object.keys(bag)) { changes[k] = { oldValue: bag[k] }; delete bag[k]; }
      ctx.host.saveStorage();
      if (Object.keys(changes).length) ctx.host.deliverEvent('storage.onChanged', { changes, areaName: area });
      return undefined;
    }
    default: throw new Error(`storage.${op} is not supported`);
  }
}

const BUILTINS = Object.freeze({
  async runtime(path, args, ctx) {
    const op = path[0];
    if (op === 'getManifest') return ctx.manifest || {};
    if (op === 'getURL') {
      const rel = String(args[0] == null ? '' : args[0]).replace(/^\/+/, '');
      return `chrome-extension://${ctx.extensionId}/${safeExtensionPath(rel) || ''}`;
    }
    if (op === 'getPlatformInfo') {
      return { os: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux', arch: process.arch === 'x64' ? 'x86-64' : process.arch, nacl_arch: 'x86-64' };
    }
    if (op === 'sendMessage') {
      // Chromium hands listeners (message, sender, sendResponse); keep that
      // shape so extensions written against real Chrome behave identically.
      const message = args[0];
      const sender = {
        id: ctx.extensionId,
        url: `chrome-extension://${ctx.extensionId}/${ctx.page || ''}`,
        origin: `chrome-extension://${ctx.extensionId}`,
        tab: undefined,
      };
      ctx.host.deliverEvent('runtime.onMessage', [message, sender], { extensionId: ctx.extensionId });
      return undefined;
    }
    if (op === 'getBackgroundPage') return null;
    if (op === 'openOptionsPage' || op === 'reload' || op === 'setUninstallURL') return undefined;
    if (op === 'getContexts') return [];
    throw new Error(`runtime.${op} is not supported`);
  },

  async storage(path, args, ctx) { return extensionStorage('storage', path, args, ctx); },

  async tabs(path, args, ctx) {
    const e = electronApi();
    const op = path[0];
    if (op === 'query') {
      const q = (args[0] && typeof args[0] === 'object') ? args[0] : {};
      let tabs = browserTabs();
      if (q.active != null) tabs = tabs.filter((t) => t.active === !!q.active);
      if (q.currentWindow != null) tabs = tabs.filter((t) => t.windowId === 1);
      if (q.url) {
        const list = Array.isArray(q.url) ? q.url : [q.url];
        tabs = tabs.filter((t) => list.some((pat) => globToRegExp(pat).test(t.url)));
      }
      if (Number.isFinite(q.index)) tabs = tabs.filter((t) => t.index === q.index);
      if (Number.isFinite(q.windowId)) tabs = tabs.filter((t) => t.windowId === q.windowId);
      return tabs;
    }
    if (op === 'get' || op === 'getCurrent') {
      const tabs = browserTabs();
      if (op === 'getCurrent') return tabs.find((t) => t.active) || tabs[0] || null;
      const id = Number(args[0]);
      return tabs.find((t) => t.id === id) || null;
    }
    if (op === 'create') {
      const spec = (args[0] && typeof args[0] === 'object') ? args[0] : {};
      const browser = require('./browser');
      if (spec.url) await browser.loadURL(spec.url);
      const tabs = browserTabs();
      const created = tabs[tabs.length - 1] || { id: 1, url: spec.url || '', title: '' };
      ctx.host.deliverEvent('tabs.onCreated', { tab: created });
      return created;
    }
    if (op === 'update') {
      const id = Number(args[0]);
      const spec = (args[1] && typeof args[1] === 'object') ? args[1] : {};
      const browser = require('./browser');
      if (spec.url) await browser.loadURL(spec.url);
      const tab = browserTabs().find((t) => t.id === id) || null;
      if (tab) ctx.host.deliverEvent('tabs.onUpdated', { tabId: id, changeInfo: { url: tab.url }, tab });
      return tab;
    }
    if (op === 'remove') {
      const browser = require('./browser');
      browser.sendTabCommand({ type: 'close', id: Number(args[0]) });
      ctx.host.deliverEvent('tabs.onRemoved', { tabId: Number(args[0]), isWindowClosing: false });
      return undefined;
    }
    if (op === 'reload' || op === 'goBack' || op === 'goForward') {
      const browser = require('./browser');
      if (op === 'reload') await browser.reload();
      else if (op === 'goBack') await browser.goBack();
      else await browser.goForward();
      return undefined;
    }
    if (op === 'duplicate') {
      const tab = browserTabs().find((t) => t.id === Number(args[0]));
      if (!tab) throw new Error('no such tab');
      const browser = require('./browser');
      await browser.loadURL(tab.url);
      return tab;
    }
    if (op === 'executeScript') {
      const browser = require('./browser');
      const spec = args[0] || {};
      const code = spec.code || (Array.isArray(spec.func) ? null : null) || 'undefined';
      const r = await browser.executeJS(code, true);
      if (!r.ok) throw new Error(r.error || 'script failed');
      return [{ frameId: 0, result: r.result, documentId: '0' }];
    }
    if (op === 'captureVisibleTab') {
      const browser = require('./browser');
      const shot = await browser.screenshot();
      if (!shot || !shot.ok) throw new Error((shot && shot.error) || 'screenshot failed');
      return shot.dataUrl || shot.png || 'data:image/png;base64,';
    }
    if (op === 'sendMessage') {
      ctx.host.deliverEvent('tabs.onMessage', { tabId: Number(args[0]), message: args[1] });
      return undefined;
    }
    throw new Error(`tabs.${op} is not supported`);
  },

  async windows(path, args, ctx) {
    const e = electronApi();
    const list = () => e.BrowserWindow.getAllWindows().map((w, i) => {
      const b = w.getBounds();
      return { id: w.id || i + 1, focused: w.isFocused(), alwaysOnTop: w.isAlwaysOnTop(), top: b.y, left: b.x, width: b.width, height: b.height, type: 'normal', incognito: false, state: w.isMaximized() ? 'maximized' : w.isMinimized() ? 'minimized' : 'normal' };
    });
    const op = path[0];
    if (op === 'getAll') return list();
    if (op === 'getCurrent' || op === 'getLastFocused') return list().find((w) => w.focused) || list()[0] || null;
    if (op === 'get') return list().find((w) => w.id === Number(args[0])) || null;
    if (op === 'create') {
      const spec = (args[0] && typeof args[0] === 'object') ? args[0] : {};
      const win = new e.BrowserWindow({ width: spec.width || 900, height: spec.height || 700, show: true });
      if (spec.url) win.loadURL(String(spec.url));
      return { id: win.id, width: spec.width || 900, height: spec.height || 700, focused: true, type: 'normal' };
    }
    if (op === 'update') {
      const win = e.BrowserWindow.fromId(Number(args[0]));
      const spec = (args[1] && typeof args[1] === 'object') ? args[1] : {};
      if (win && [spec.width, spec.height, spec.left, spec.top].some((v) => Number.isFinite(v))) {
        const cur = win.getBounds();
        win.setBounds({ x: Number.isFinite(spec.left) ? spec.left : cur.x, y: Number.isFinite(spec.top) ? spec.top : cur.y, width: spec.width || cur.width, height: spec.height || cur.height });
      }
      if (win && spec.focused) win.focus();
      return win ? { id: win.id, focused: win.isFocused() } : null;
    }
    if (op === 'remove') {
      const win = e.BrowserWindow.fromId(Number(args[0]));
      if (win) win.close();
      return undefined;
    }
    throw new Error(`windows.${op} is not supported`);
  },

  async cookies(path, args, ctx) {
    const e = electronApi();
    const jar = (e.session && (e.session.defaultSession || e.session.fromPartition('persist:main'))) || null;
    if (!jar) throw new Error('no cookie store available');
    const op = path[0];
    if (op === 'get') {
      const d = args[0] || {};
      const list = await jar.cookies.get({ url: d.url, name: d.name, domain: d.domain, path: d.path, secure: d.secure, session: d.session });
      return list[0] || null;
    }
    if (op === 'getAll') {
      const d = args[0] || {};
      return jar.cookies.get({ url: d.url, name: d.name, domain: d.domain, path: d.path, secure: d.secure, session: d.session });
    }
    if (op === 'set') {
      const d = args[0] || {};
      if (!d.url || !d.name) throw new Error('cookies.set requires url and name');
      await jar.cookies.set({ url: d.url, name: d.name, value: String(d.value == null ? '' : d.value), domain: d.domain, path: d.path, secure: !!d.secure, httpOnly: !!d.httpOnly, expirationDate: d.expirationDate, sameSite: d.sameSite });
      return null;
    }
    if (op === 'remove') {
      const d = args[0] || {};
      if (!d.url || !d.name) throw new Error('cookies.remove requires url and name');
      await jar.cookies.remove(d.url, d.name);
      return null;
    }
    if (op === 'getAllCookieStores') return [{ id: '0', tabIds: browserTabs().map((t) => t.id), incognito: false }];
    throw new Error(`cookies.${op} is not supported`);
  },

  async notifications(path, args, ctx) {
    const e = electronApi();
    const op = path[0];
    if (op === 'getPermissionLevel') return 'granted';
    if (op === 'create') {
      const id = `n${++ctx.host.seq}`;
      const spec = args[1] || args[0] || {};
      try {
        const n = new e.Notification({ title: String(spec.title || 'Akron Code'), body: String(spec.message || '') });
        n.show();
      } catch (_) { /* headless: record only */ }
      ctx.host.state.notifications = ctx.host.state.notifications || {};
      ctx.host.state.notifications[id] = { id, title: spec.title || '', message: spec.message || '', createdAt: Date.now() };
      ctx.host.saveState();
      return id;
    }
    if (op === 'getAll') return Object.values(ctx.host.state.notifications || {});
    if (op === 'clear') { const id = args[0]; if (id) delete (ctx.host.state.notifications || {})[id]; else ctx.host.state.notifications = {}; ctx.host.saveState(); return true; }
    if (op === 'update') return true;
    throw new Error(`notifications.${op} is not supported`);
  },

  async action(path, args, ctx) {
    const op = path[0];
    const st = ctx.host.state.action = ctx.host.state.action || {};
    if (op === 'setBadgeText') { st.badgeText = String(args[0] && args[0].text != null ? args[0].text : ''); ctx.host.saveState(); return undefined; }
    if (op === 'getBadgeText') return st.badgeText || '';
    if (op === 'setBadgeBackgroundColor') { st.badgeColor = args[0] && args[0].color; ctx.host.saveState(); return undefined; }
    if (op === 'getBadgeBackgroundColor') return st.badgeColor || [0, 0, 0, 255];
    if (op === 'setBadgeTextColor') { st.badgeTextColor = args[0] && args[0].color; ctx.host.saveState(); return undefined; }
    if (op === 'getBadgeTextColor') return st.badgeTextColor || [255, 255, 255, 255];
    if (op === 'setTitle') { st.title = String(args[0] && args[0].title != null ? args[0].title : ''); ctx.host.saveState(); return undefined; }
    if (op === 'getTitle') return st.title || '';
    if (op === 'setIcon') { st.icon = args[0] && args[0].path; ctx.host.saveState(); return undefined; }
    if (op === 'setPopup') { st.popup = String(args[0] && args[0].popup != null ? args[0].popup : ''); ctx.host.saveState(); return undefined; }
    if (op === 'getPopup') return st.popup || '';
    if (op === 'enable' || op === 'disable') { st.enabled = op === 'enable'; ctx.host.saveState(); return undefined; }
    if (op === 'isEnabled') return st.enabled !== false;
    if (op === 'getUserSettings') return { isOnToolbar: true };
    if (op === 'openPopup') return undefined;
    throw new Error(`action.${op} is not supported`);
  },

  async alarms(path, args, ctx) {
    const op = path[0];
    if (op === 'create') {
      const name = typeof args[0] === 'string' ? args[0] : 'default';
      const info = (typeof args[0] === 'object' ? args[0] : args[1]) || {};
      const delay = Number(info.delayInMinutes || info.periodInMinutes || 1) * 60000;
      const existing = ctx.host.alarms.get(name);
      if (existing && existing.timer) clearTimeout(existing.timer);
      const period = Number(info.periodInMinutes || 0);
      const alarm = { name, scheduledTime: Date.now() + delay, periodInMinutes: period || undefined };
      const timer = setTimeout(() => {
        ctx.host.deliverEvent('alarms.onAlarm', { alarm });
        if (period > 0) ctx.host.invoke('alarms.create', [name, { periodInMinutes: period }]);
      }, delay);
      if (timer.unref) timer.unref();
      ctx.host.alarms.set(name, { ...alarm, timer });
      return undefined;
    }
    if (op === 'get') { const a = ctx.host.alarms.get(String(args[0])); return a ? { name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes } : undefined; }
    if (op === 'getAll') return [...ctx.host.alarms.values()].map((a) => ({ name: a.name, scheduledTime: a.scheduledTime, periodInMinutes: a.periodInMinutes }));
    if (op === 'clear') { const a = ctx.host.alarms.get(String(args[0])); if (a && a.timer) clearTimeout(a.timer); ctx.host.alarms.delete(String(args[0])); return true; }
    if (op === 'clearAll') { for (const a of ctx.host.alarms.values()) if (a.timer) clearTimeout(a.timer); ctx.host.alarms.clear(); return true; }
    throw new Error(`alarms.${op} is not supported`);
  },

  async i18n(path, args, ctx) {
    const op = path[0];
    if (op === 'getUILanguage') return 'en-US';
    if (op === 'getAcceptLanguages') return ['en-US', 'en'];
    if (op === 'getMessage') {
      const key = String(args[0] || '');
      const locale = (ctx.manifest && ctx.manifest.default_locale) || 'en';
      const file = path.join(ctx.host.extensionDir(ctx.extensionId) || '', '_locales', locale, 'messages.json');
      const msgs = readJSON(file, {});
      const entry = msgs[key];
      if (!entry) return '';
      let text = String(entry.message || '');
      const subs = Array.isArray(args[1]) ? args[1] : [];
      text = text.replace(/\$(\d+)/g, (m, n) => (subs[Number(n) - 1] != null ? String(subs[Number(n) - 1]) : m));
      return text;
    }
    throw new Error(`i18n.${op} is not supported`);
  },

  async permissions(path, args, ctx) {
    const op = path[0];
    const granted = declaredPermissions(ctx.manifest);
    if (op === 'getAll') return { permissions: [...granted].filter((p) => !p.includes('://') && !p.startsWith('*')), origins: [...granted].filter((p) => p.includes('://') || p.startsWith('*')) };
    if (op === 'contains') {
      const ask = args[0] || {};
      const want = [...(ask.permissions || []), ...(ask.origins || [])];
      return want.every((p) => granted.has(p));
    }
    if (op === 'request') return op === 'request' ? true : undefined;
    if (op === 'remove') return false;
    throw new Error(`permissions.${op} is not supported`);
  },

  async management(path, args, ctx) {
    const op = path[0];
    const rows = [...ctx.host.extensions.values()].map((x) => ctx.host.extensionInfo(x.id));
    if (op === 'getAll') return rows;
    if (op === 'get') return rows.find((r) => r.id === String(args[0])) || null;
    if (op === 'getSelf') return ctx.host.extensionInfo(ctx.extensionId);
    if (op === 'setEnabled') return undefined;
    if (op === 'uninstall') return undefined;
    throw new Error(`management.${op} is not supported`);
  },

  async commands(path, args, ctx) {
    if (path[0] !== 'getAll') throw new Error(`commands.${path[0]} is not supported`);
    const cmds = (ctx.manifest && ctx.manifest.commands) || {};
    return Object.entries(cmds).map(([name, spec]) => ({ name, description: (spec && spec.description) || '', shortcut: (spec && spec.suggested_key && (spec.suggested_key.default || spec.suggested_key.mac)) || '' }));
  },

  async contextMenus(path, args, ctx) {
    const op = path[0];
    const list = ctx.host.state.contextMenus = ctx.host.state.contextMenus || [];
    if (op === 'create') {
      const spec = args[0] || {};
      const id = String(spec.id != null ? spec.id : `menu${list.length + 1}`);
      const row = { id, title: spec.title || '', contexts: spec.contexts || ['page'], parentId: spec.parentId, enabled: spec.enabled !== false };
      const at = list.findIndex((m) => m.id === id);
      if (at >= 0) list[at] = row; else list.push(row);
      ctx.host.saveState();
      return id;
    }
    if (op === 'update') {
      const at = list.findIndex((m) => m.id === String(args[0]));
      if (at >= 0) list[at] = { ...list[at], ...(args[1] || {}) };
      ctx.host.saveState();
      return undefined;
    }
    if (op === 'remove') { ctx.host.state.contextMenus = list.filter((m) => m.id !== String(args[0])); ctx.host.saveState(); return undefined; }
    if (op === 'removeAll') { ctx.host.state.contextMenus = []; ctx.host.saveState(); return undefined; }
    throw new Error(`contextMenus.${op} is not supported`);
  },

  async extension(path, args, ctx) {
    const op = path[0];
    if (op === 'isAllowedIncognitoAccess' || op === 'isAllowedFileSchemeAccess') return false;
    if (op === 'getViews') return [];
    throw new Error(`extension.${op} is not supported`);
  },

  async tabGroups(path, args, ctx) {
    const op = path[0];
    if (op === 'query') return [];
    if (op === 'get') return null;
    if (op === 'update') return null;
    throw new Error(`tabGroups.${op} is not supported`);
  },

  async scripting(path, args, ctx) {
    const op = path[0];
    if (op === 'executeScript') {
      const browser = require('./browser');
      const spec = args[0] || {};
      const code = spec.code || 'undefined';
      const r = await browser.executeJS(code, true);
      if (!r.ok) throw new Error(r.error || 'script failed');
      return [{ frameId: 0, result: r.result, documentId: '0' }];
    }
    if (op === 'insertCSS' || op === 'removeCSS') return undefined;
    if (op === 'getRegisteredContentScripts') return [];
    if (op === 'registerContentScripts' || op === 'unregisterContentScripts') return undefined;
    throw new Error(`scripting.${op} is not supported`);
  },

  async sidePanel(path, args, ctx) {
    const st = ctx.host.state.sidePanel = ctx.host.state.sidePanel || {};
    const op = path[0];
    if (op === 'setOptions') { Object.assign(st, args[0] || {}); ctx.host.saveState(); return undefined; }
    if (op === 'getOptions') return { ...st };
    if (op === 'setPanelBehavior') return undefined;
    if (op === 'open') { ctx.host.emitToSinks(CHANNELS.event, { eventName: 'sidePanel.open', listenerId: '*', args: [args[0] || {}] }); return undefined; }
    throw new Error(`sidePanel.${op} is not supported`);
  },

  async debugger(path, args, ctx) {
    const chromeCtl = require('./chrome');
    const op = path[0];
    if (op === 'getTargets') {
      try { return await chromeCtl.getTargets(); } catch (e) { return []; }
    }
    if (op === 'attach') { ctx.host.debugTargets = ctx.host.debugTargets || new Map(); ctx.host.debugTargets.set(String(args[0] && args[0].tabId), true); return undefined; }
    if (op === 'detach') { if (ctx.host.debugTargets) ctx.host.debugTargets.delete(String(args[0] && args[0].tabId)); return undefined; }
    if (op === 'sendCommand') {
      const target = args[0] && args[0].tabId;
      try {
        const r = await chromeCtl.evaluate('1');
        return r;
      } catch (e) { throw new Error(sanitizeError(e)); }
    }
    throw new Error(`debugger.${op} is not supported`);
  },
});

// ---------------------------------------------------------------------------
// 9. MIME table for served extension pages
// ---------------------------------------------------------------------------
const MIME = Object.freeze({
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  xml: 'application/xml',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
});

function mimeFor(rel) {
  const ext = String(rel || '').split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

const TEXTUAL = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'map', 'txt', 'md', 'svg', 'xml']);

function readPageBody(file, rel) {
  const ext = String(rel || '').split('.').pop().toLowerCase();
  const buf = fs.readFileSync(file);
  return TEXTUAL.has(ext) ? buf.toString('utf8') : buf;
}

// ---------------------------------------------------------------------------
// 10. ExtensionHost — the main-process side of the 11 channels
// ---------------------------------------------------------------------------
class ExtensionHost {
  constructor(opts = {}) {
    this.dataDir = opts.dataDir || DATA_DIR;
    this.extDir = path.join(this.dataDir, 'extensions');
    this.storageFile = path.join(this.dataDir, 'extension-storage.json');
    this.stateFile = path.join(this.dataDir, 'extension-state.json');

    this.storage = readJSON(this.storageFile, {});
    this.state = readJSON(this.stateFile, {});
    if (!this.storage || typeof this.storage !== 'object') this.storage = {};
    if (!this.state || typeof this.state !== 'object') this.state = {};

    this.sinks = new Set();            // webContents-like { send(channel, payload), id }
    this.listeners = new Map();        // listenerId -> { extensionId, eventName, ns }
    this.pendingAcks = new Map();      // ackId -> { resolve, timer }
    this.ports = new Map();            // portId -> { portId, extensionId, portName, contextId }
    this.alarms = new Map();           // name -> { name, scheduledTime, timer, periodInMinutes }
    this.extensions = new Map();       // extensionId -> { id, dir, manifest }
    this.debugTargets = new Map();
    this.seq = 0;
    this.bridge = null;                // real-Chrome bridge (see startBridge)
    this.bridgePending = new Map();    // reqId -> { resolve, reject, timer }
    this.bridgeSockets = new Set();
    this.scan();
  }

  // -- persistence -------------------------------------------------------
  saveState() { try { writeJSON(this.stateFile, this.state); } catch (_) {} }
  saveStorage() { try { writeJSON(this.storageFile, this.storage); } catch (_) {} }

  nextId(prefix) { return `${prefix}${++this.seq}`; }

  // -- installed extension discovery -------------------------------------
  scan() {
    this.extensions.clear();
    try {
      if (!fs.existsSync(this.extDir)) return this;
      for (const dirent of fs.readdirSync(this.extDir, { withFileTypes: true })) {
        if (!dirent.isDirectory()) continue;
        const id = normalizeExtensionId(dirent.name);
        if (!id) continue;
        const dir = path.join(this.extDir, dirent.name);
        const manifest = readManifest(dir);
        if (!manifest) continue;
        this.extensions.set(id, { id, dir, manifest });
      }
    } catch (_) {}
    return this;
  }

  extensionDir(extensionId) {
    const id = normalizeExtensionId(extensionId);
    if (!id) return null;
    return path.join(this.extDir, id);
  }

  extensionInfo(extensionId) {
    const id = normalizeExtensionId(extensionId);
    const entry = this.extensions.get(id);
    if (!entry) return null;
    const m = entry.manifest || {};
    return {
      id,
      name: String(m.name || id),
      shortName: String(m.short_name || m.name || id),
      version: String(m.version || '0.0.0'),
      description: String(m.description || ''),
      enabled: true,
      type: 'extension',
      installType: 'development',
      mayDisable: true,
      icons: m.icons || {},
    };
  }

  // -- channel: installed ------------------------------------------------
  installed(extensionId) {
    this.scan();
    const id = normalizeExtensionId(extensionId);
    if (!id) return { ok: false, error: 'Invalid extension id' };
    const entry = this.extensions.get(id);
    if (!entry) return { ok: false, error: 'Extension is not installed', id };
    const m = entry.manifest || {};
    const granted = declaredPermissions(m);

    const warnings = [];
    for (const p of granted) {
      const copy = PERMISSIONS.get(p);
      if (!copy) continue;
      if (copy.warning) warnings.push({ permission: p, text: copy.warning, level: 'warning' });
      else if (copy.plain) warnings.push({ permission: p, text: copy.plain, level: 'plain' });
    }

    return {
      ok: true,
      id,
      name: String(m.name || id),
      version: String(m.version || '0.0.0'),
      manifestVersion: Number(m.manifest_version || 3),
      manifest: m,
      permissions: warnings,
      namespaces: this.namespacesFor(m),
      hostPermissions: ((m.host_permissions) || []).slice(0, MAX_RESOURCE_RULES),
      hasBackground: !!(m.background && (m.background.service_worker || m.background.scripts)),
      contentScripts: Array.isArray(m.content_scripts) ? m.content_scripts.length : 0,
    };
  }

  // -- channel: report-again ---------------------------------------------
  // Re-delivers chrome.runtime.onInstalled to the extension's pages. This is
  // what Desktop's "report again" does when a page attaches after the fact.
  reportAgain(extensionId, reason = 'install') {
    const id = normalizeExtensionId(extensionId);
    if (!id) return { ok: false, error: 'Invalid extension id' };
    const info = this.extensionInfo(id);
    if (!info) return { ok: false, error: 'Extension is not installed', id };
    const ackId = this.deliverEvent('runtime.onInstalled', { reason, previousVersion: undefined }, { extensionId: id });
    return { ok: true, id, ackId };
  }

  // -- namespace surface -------------------------------------------------
  namespacesFor(manifest) {
    const granted = declaredPermissions(manifest || {});
    const out = [];
    for (const n of NAMESPACES) {
      if (n.permission && !granted.has(n.permission)) continue;
      if (n.manifestKey && !(manifest && manifest[n.manifestKey])) continue;
      out.push({
        namespace: n.namespace,
        methods: n.methods.slice(),
        events: n.events.slice(),
        constants: n.constants || null,
        native: n.native,
      });
    }
    return out;
  }

  // -- channel: serve-page -----------------------------------------------
  servePage(input) {
    const req = (typeof input === 'string' ? { url: input } : input) || {};
    let extensionId = normalizeExtensionId(req.extensionId);
    let rel = req.path;
    if (req.url) {
      const parsed = parseExtensionUrl(req.url);
      if (!parsed) return { ok: false, error: 'Not an extension page URL' };
      extensionId = extensionId || parsed.extensionId;
      rel = rel || parsed.path;
    }
    if (!extensionId) return { ok: false, error: 'Invalid extension id' };

    this.scan();
    const entry = this.extensions.get(extensionId);
    if (!entry) return { ok: false, error: 'Extension is not installed' };

    const safe = safeExtensionPath(rel);
    if (!safe) return { ok: false, error: 'Invalid resource path' };

    // A page inside the extension itself may load anything it ships. Anything
    // else has to be declared in web_accessible_resources.
    const initiator = String(req.initiatorUrl || '');
    const ownPage = !initiator || initiator.startsWith(`chrome-extension://${extensionId}/`) || initiator.startsWith('autobot-extension://') || initiator.startsWith(`helio-extension://${extensionId}/`);
    if (!ownPage && !isWebAccessible(entry.manifest, safe, initiator)) {
      return { ok: false, error: 'Resource is not web accessible', status: 403 };
    }

    const root = path.resolve(entry.dir);
    const file = path.resolve(root, safe);
    if (!file.startsWith(root + path.sep) && file !== root) return { ok: false, error: 'Invalid resource path' };

    let stat = null;
    try { stat = fs.statSync(file); } catch (_) { return { ok: false, error: 'Not found', status: 404 }; }
    if (!stat.isFile()) return { ok: false, error: 'Not found', status: 404 };
    if (stat.size > 64 * 1024 * 1024) return { ok: false, error: 'Resource is too large', status: 413 };

    try {
      return { ok: true, extensionId, path: safe, mime: mimeFor(safe), size: stat.size, body: readPageBody(file, safe) };
    } catch (e) {
      return { ok: false, error: sanitizeError(e) };
    }
  }

  // -- channel: invoke ---------------------------------------------------
  async invoke(api, args, opts = {}) {
    const started = Date.now();
    try {
      assertArgs(args);
      const parsed = parseApi(api);
      if (!parsed) return { ok: false, message: `Unknown API "${String(api).slice(0, 80)}"` };

      const spec = NS_BY_NAME.get(parsed.namespace);
      const extensionId = normalizeExtensionId(opts.extensionId) || (this.extensions.size === 1 ? [...this.extensions.keys()][0] : null);
      const entry = extensionId ? this.extensions.get(extensionId) : null;
      const manifest = (entry && entry.manifest) || null;
      const granted = declaredPermissions(manifest || {});

      if (spec.permission && !granted.has(spec.permission)) {
        return { ok: false, message: `chrome.${parsed.namespace} requires the "${spec.permission}" permission` };
      }

      const ctx = { host: this, extensionId, manifest: manifest || {}, started };
      const handler = BUILTINS[parsed.namespace];
      if (handler) {
        const value = await handler(parsed.path, Array.isArray(args) ? args : [args], ctx);
        return { ok: true, value: value === undefined ? null : value };
      }

      // No native implementation: this namespace only exists if a real Chrome
      // extension is bridged in (Desktop behaves the same way).
      if (!this.bridge || !this.bridge.ready) {
        return { ok: false, message: `chrome.${parsed.namespace} is not available: connect a Chrome extension to use it` };
      }
      const value = await this.bridgeInvoke(api, args);
      return { ok: true, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, message: sanitizeError(e) };
    }
  }

  // -- channel: listen ---------------------------------------------------
  listen(extensionId, eventName) {
    const id = normalizeExtensionId(extensionId);
    const name = String(eventName || '');
    const [nsName, eventKey] = name.split('.');
    const spec = NS_BY_NAME.get(nsName);
    if (!spec) return { ok: false, error: `Unknown namespace "${nsName}"` };
    if (!spec.events.includes(eventKey)) return { ok: false, error: `Unknown event "${name}"` };
    const listenerId = this.nextId('l');
    this.listeners.set(listenerId, { listenerId, extensionId: id, eventName: name, ns: nsName });
    return { ok: true, listenerId, eventName: name };
  }

  unlisten(listenerId) {
    const had = this.listeners.delete(String(listenerId));
    return { ok: had };
  }

  // -- channel: event / event-ack ---------------------------------------
  attachSink(sink) {
    if (!sink || typeof sink.send !== 'function') return false;
    this.sinks.add(sink);
    return true;
  }

  detachSink(sink) {
    this.sinks.delete(sink);
    return true;
  }

  // Diagnostics: how many extension pages are currently listening for events.
  sinkCount() {
    return this.sinks.size;
  }

  // Push an event into every attached page, mirroring Desktop's buffered
  // dispatch: the frame carries an ackId the renderer answers on
  // `event-ack` with either null or an error-class string.
  deliverEvent(eventName, args, opts = {}) {
    const ackId = this.nextId('a');
    const frame = {
      ackId,
      eventName: String(eventName),
      extensionId: opts.extensionId ? normalizeExtensionId(opts.extensionId) : null,
      listenerId: opts.listenerId || null,
      args: Array.isArray(args) ? args : [args],
      at: Date.now(),
    };
    this.emitToSinks(CHANNELS.event, frame);
    return ackId;
  }

  ack(ackId, errorClass = null) {
    const id = String(ackId == null ? '' : ackId);
    if (!id) return { ok: false, error: 'ackId required' };
    const pending = this.pendingAcks.get(id);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      this.pendingAcks.delete(id);
      pending.resolve({ ackId: id, errorClass: errorClass || null });
      return { ok: true };
    }
    this.lastAcks = this.lastAcks || new Map();
    this.lastAcks.set(id, errorClass || null);
    return { ok: true, late: true };
  }

  emitToSinks(channel, payload) {
    let sent = 0;
    for (const sink of this.sinks) {
      try { sink.send(channel, payload); sent++; } catch (_) {}
    }
    return sent;
  }

  // -- channel: port-to-host / port-to-context ---------------------------
  portToHost(extensionId, portName, contextId) {
    const id = normalizeExtensionId(extensionId);
    const portId = this.nextId('p');
    const port = { portId, extensionId: id, portName: String(portName || 'port'), contextId: contextId || null, at: Date.now() };
    this.ports.set(portId, port);
    this.emitToSinks(CHANNELS.portToHost, port);
    return { ok: true, portId, portName: port.portName, extensionId: id };
  }

  portToContext(portId, message) {
    const id = String(portId == null ? '' : portId);
    const port = this.ports.get(id);
    if (!port) return { ok: false, error: 'Unknown port' };
    const encoded = JSON.stringify(message == null ? null : message);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_PORT_MESSAGE) return { ok: false, error: 'Port message is too large' };
    this.emitToSinks(CHANNELS.portToContext, { portId: id, message: message == null ? null : message });
    return { ok: true };
  }

  closePort(portId) {
    const id = String(portId == null ? '' : portId);
    return { ok: this.ports.delete(id) };
  }

  // -- channel: agentic-call / agentic-reply ----------------------------
  async agenticCall(op, payload, opts = {}) {
    if (!isAgenticOp(op)) return { ok: false, reason: 'op', message: `Unknown agentic operation "${String(op).slice(0, 60)}"` };
    const extensionId = normalizeExtensionId(opts.extensionId);
    if (extensionId && !AGENT_EXTENSION_IDS.includes(extensionId)) {
      return { ok: false, reason: 'extension', message: 'This extension cannot drive agentic mode' };
    }
    if (!this.bridge || !this.bridge.ready) {
      return { ok: false, reason: 'unavailable', message: 'Connect a Chrome extension to use agentic mode' };
    }
    try {
      const callId = opts.callId || this.nextId('c');
      const value = await this.bridgeRequest({ type: 'agentic', callId, op, payload: payload == null ? null : payload }, AGENTIC_TIMEOUT_MS);
      return { ok: true, callId, value: value === undefined ? null : value };
    } catch (e) {
      return { ok: false, reason: 'error', message: sanitizeError(e) };
    }
  }

  agenticReply(callId, result) {
    const id = String(callId == null ? '' : callId);
    if (!id) return { ok: false, error: 'callId required' };
    const pending = this.bridgePending.get(id);
    if (!pending) return { ok: false, error: 'Unknown agentic call' };
    this.bridgePending.delete(id);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(result && result.error ? Promise.reject(new Error(result.error)) : result && result.value);
    return { ok: true };
  }

  // -- bridge (real Chrome extension over loopback WebSocket) -----------
  bridgeInvoke(api, args, timeoutMs = INVOKE_TIMEOUT_MS) {
    const reqId = this.nextId('r');
    return this.bridgeRequest({ type: 'invoke', reqId, api, args }, timeoutMs);
  }

  bridgeRequest(frame, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = frame.reqId || frame.callId;
      const timer = setTimeout(() => {
        this.bridgePending.delete(id);
        reject(new Error('The connected Chrome extension did not answer in time'));
      }, timeoutMs || INVOKE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      this.bridgePending.set(id, { resolve, reject, timer });
      let payload;
      try { payload = JSON.stringify(frame); } catch (e) { clearTimeout(timer); this.bridgePending.delete(id); reject(e); return; }
      let sent = 0;
      for (const sock of this.bridgeSockets) {
        try { if (sock.readyState === 1) { sock.send(payload); sent++; } } catch (_) {}
      }
      if (!sent) {
        clearTimeout(timer);
        this.bridgePending.delete(id);
        reject(new Error('No Chrome extension is connected'));
      }
    });
  }

  // Loopback listener: a packed MV3 extension connects to
  // ws://127.0.0.1:<port> and speaks {type:'hello'|'invoke-reply'|'agentic-reply'|'event'}.
  async startBridge(preferredPort = 0, bindHost = '127.0.0.1') {
    if (this.bridge && this.bridge.ready) return { ok: true, port: this.bridge.port };
    let WebSocketServer;
    try {
      ({ WebSocketServer } = require('ws'));
    } catch (_) {
      this.bridge = { ready: false, port: 0, reason: 'ws is not installed' };
      return { ok: false, error: this.bridge.reason };
    }
    return new Promise((resolve) => {
      const state = { ready: false, port: 0, reason: null, server: null };
      const server = new WebSocketServer({ host: bindHost, port: preferredPort });
      state.server = server;
      this.bridge = state;

      server.on('listening', () => {
        state.ready = true;
        state.port = server.address().port;
        resolve({ ok: true, port: state.port });
      });

      server.on('error', (err) => {
        state.ready = false;
        state.reason = sanitizeError(err);
        resolve({ ok: false, error: state.reason });
      });

      server.on('connection', (sock) => {
        this.bridgeSockets.add(sock);
        sock.on('message', (raw) => this.onBridgeFrame(raw));
        sock.on('close', () => { this.bridgeSockets.delete(sock); });
        sock.on('error', () => { this.bridgeSockets.delete(sock); });
        try { sock.send(JSON.stringify({ type: 'hello', protocol: 1, app: 'helio-bot' })); } catch (_) {}
      });
    });
  }

  stopBridge() {
    for (const sock of this.bridgeSockets) { try { sock.close(); } catch (_) {} }
    this.bridgeSockets.clear();
    const server = this.bridge && this.bridge.server;
    if (server) { try { server.close(); } catch (_) {} }
    this.bridge = { ready: false, port: 0, reason: 'stopped' };
    return { ok: true };
  }

  onBridgeFrame(raw) {
    let frame = null;
    try { frame = JSON.parse(String(raw)); } catch (_) { return; }
    if (!frame || typeof frame !== 'object') return;
    const id = frame.reqId || frame.callId || frame.id;

    if (frame.type === 'invoke-reply' || frame.type === 'agentic-reply' || frame.type === 'reply') {
      const pending = this.bridgePending.get(String(id));
      if (!pending) return;
      this.bridgePending.delete(String(id));
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.error) pending.reject(new Error(sanitizeError(frame.error)));
      else pending.resolve(frame.value);
      return;
    }

    if (frame.type === 'event') {
      const ackId = this.deliverEvent(String(frame.eventName || ''), frame.args || [], { extensionId: frame.extensionId });
      for (const sock of this.bridgeSockets) {
        try { if (sock.readyState === 1) sock.send(JSON.stringify({ type: 'event-ack', ackId, errorClass: null })); } catch (_) {}
      }
      return;
    }

    if (frame.type === 'hello') {
      this.emitToSinks(CHANNELS.installed, { extensionId: frame.extensionId ? normalizeExtensionId(frame.extensionId) : null, bridge: true });
    }
  }

  // -- test / diagnostics helpers ---------------------------------------
  listenerCount() { return this.listeners.size; }
  sinkCount() { return this.sinks.size; }
  pendingAckCount() { return this.pendingAcks.size; }
}

// ---------------------------------------------------------------------------
// 11. IPC registration (main process)
// ---------------------------------------------------------------------------
// Wires all 11 channels to one ExtensionHost instance. `onEvent` is the
// renderer-side callback used when a page registers `listen`; we keep the
// listener registry in the host so multiple windows share it.
function registerIpc(ipcMain, host) {
  if (!ipcMain || !host) throw new Error('registerIpc requires ipcMain and a host');

  ipcMain.handle(CHANNELS.invoke, async (event, api, args, opts) => {
    host.attachSink(event.sender);
    return host.invoke(api, args, opts || {});
  });

  ipcMain.handle(CHANNELS.servesPage, async (event, input) => {
    host.attachSink(event.sender);
    return host.servePage(input);
  });

  ipcMain.handle(CHANNELS.listen, async (event, extensionId, eventName) => {
    host.attachSink(event.sender);
    return host.listen(extensionId, eventName);
  });

  ipcMain.handle(CHANNELS.event, async (event, eventName, args, opts) => {
    host.attachSink(event.sender);
    return { ok: true, ackId: host.deliverEvent(eventName, args, opts || {}) };
  });

  ipcMain.on(CHANNELS.eventAck, (event, ackId, errorClass) => {
    host.ack(ackId, errorClass);
  });

  ipcMain.handle(CHANNELS.installed, async (event, extensionId) => {
    host.attachSink(event.sender);
    return host.installed(extensionId);
  });

  ipcMain.handle(CHANNELS.reportAgain, async (event, extensionId, reason) => {
    host.attachSink(event.sender);
    return host.reportAgain(extensionId, reason);
  });

  ipcMain.handle(CHANNELS.portToHost, async (event, extensionId, portName, contextId) => {
    host.attachSink(event.sender);
    return host.portToHost(extensionId, portName, contextId);
  });

  ipcMain.on(CHANNELS.portToContext, (event, portId, message) => {
    host.portToContext(portId, message);
  });

  ipcMain.handle(CHANNELS.agenticCall, async (event, op, payload, opts) => {
    host.attachSink(event.sender);
    return host.agenticCall(op, payload, opts || {});
  });

  ipcMain.on(CHANNELS.agenticReply, (event, callId, result) => {
    host.agenticReply(callId, result);
  });

  return host;
}

function createExtensionHost(opts) {
  return new ExtensionHost(opts || {});
}

module.exports = {
  CHANNELS,
  CHANNEL_ALIASES,
  canonicalChannel,
  PERMISSIONS,
  NAMESPACES,
  NS_BY_NAME,
  AGENT_EXTENSION_IDS,
  AGENTIC_OPS,
  isAgenticOp,
  MAX_ARGS_BYTES,
  MAX_PORT_MESSAGE,
  MAX_DEPTH,
  assertArgs,
  sanitizeError,
  normalizeExtensionId,
  parseApi,
  parseExtensionUrl,
  safeExtensionPath,
  globToRegExp,
  matchPatternToRegExp,
  isWebAccessible,
  declaredPermissions,
  mimeFor,
  ExtensionHost,
  createExtensionHost,
  registerIpc,
  BUILTINS,
  STORAGE_AREAS,
  PAGE_SCHEMES,
};
