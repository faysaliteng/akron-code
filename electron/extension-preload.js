'use strict';
// Preload for hosted Chrome extension pages — Helio Bot's equivalent of
// Chromium's extension bindings (Desktop's `extensionWindow.js`).
//
// Two modes, both fed by the same 11 `extension-host:*` channels:
//
//   hosted  the page came from `helio-extension://<id>/…` because Electron
//           refused to load the unpacked extension. Nothing native exists, so
//           this file builds the whole `chrome.*` surface.
//   native  `session.loadExtension` worked, so the page has a real
//           `chrome-extension://` origin and Chromium's own API bindings. We
//           only fill the holes Chromium leaves in Electron (notably
//           `chrome.storage.sync`, unavailable without a signed-in profile) and
//           host the event/port plumbing the rest of the app shares.
//
// The extension id arrives as `--helio-extension-id=<id>`; native mode adds
// `--helio-native=1`.

const { ipcRenderer, contextBridge, webFrame } = require('electron');

const CH = {
  invoke: 'extension-host:invoke',
  listen: 'extension-host:listen',
  event: 'extension-host:event',
  eventAck: 'extension-host:event-ack',
  installed: 'extension-host:installed',
  reportAgain: 'extension-host:report-again',
  portToHost: 'extension-host:port-to-host',
  portToContext: 'extension-host:port-to-context',
  agenticCall: 'extension-host:agentic-call',
  agenticReply: 'extension-host:agentic-reply',
};

const EXT_ID_RE = /^[a-p]{32}$/;

function argValue(prefix) {
  for (const a of process.argv) {
    const s = String(a);
    if (s.startsWith(prefix)) return s.slice(prefix.length);
  }
  return '';
}

const extensionId = argValue('--helio-extension-id=').trim().toLowerCase();
if (!EXT_ID_RE.test(extensionId)) return;
const nativeMode = argValue('--helio-native=') === '1';

// Serve URLs on whatever scheme this page actually came from, so relative
// resources and `runtime.getURL()` assets resolve.
function pageOrigin() {
  try {
    if (typeof location !== 'undefined' && /^(helio|autobot)-extension:$/.test(location.protocol) && location.hostname) {
      return `${location.protocol}//${location.hostname}`;
    }
  } catch (_) {}
  return `chrome-extension://${extensionId}`;
}
const ORIGIN = pageOrigin();

// ---------------------------------------------------------------------------
// Event hub. Handlers live in the page's main world; contextBridge hands the
// preload callable proxies, so dispatch happens locally and only the ack
// travels back to the host.
// ---------------------------------------------------------------------------
const listeners = new Map(); // `${namespace}.${eventName}` -> Set<fn>

function listenerSet(key) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  return listeners.get(key);
}

function emitLocal(key, args) {
  const set = listeners.get(key);
  if (!set || !set.size) return null;
  let failed = false;
  for (const fn of [...set]) {
    try { fn(...args); } catch (_) { failed = true; }
  }
  return failed ? 'listener-error' : null;
}

ipcRenderer.on(CH.event, (_e, frame) => {
  if (!frame || typeof frame !== 'object') return;
  const errorClass = emitLocal(String(frame.eventName || ''), Array.isArray(frame.args) ? frame.args : []);
  try { ipcRenderer.send(CH.eventAck, frame.ackId, errorClass); } catch (_) {}
});

// ---------------------------------------------------------------------------
// Ports: `chrome.runtime.connect()` opens a host port; host -> page messages
// land on the port's `onMessage` listeners.
// ---------------------------------------------------------------------------
const ports = new Map(); // portId -> handlers[]

ipcRenderer.on(CH.portToContext, (_e, frame) => {
  if (!frame || typeof frame !== 'object') return;
  const handlers = ports.get(String(frame.portId));
  if (!handlers) return;
  for (const fn of handlers.slice()) {
    try { fn(frame.message); } catch (_) {}
  }
});

function makeEvent(namespace, eventName) {
  const key = `${namespace}.${eventName}`;
  return {
    addListener(fn) { if (typeof fn === 'function') listenerSet(key).add(fn); },
    removeListener(fn) { const s = listeners.get(key); if (s) s.delete(fn); },
    hasListener(fn) { const s = listeners.get(key); return !!(s && s.has(fn)); },
    hasListeners() { const s = listeners.get(key); return !!(s && s.size); },
  };
}

// ---------------------------------------------------------------------------
// invoke
// ---------------------------------------------------------------------------
async function call(api, args) {
  let res = null;
  try {
    res = await ipcRenderer.invoke(CH.invoke, api, args === undefined ? [] : args, { extensionId });
  } catch (_) {
    res = null;
  }
  if (res && res.ok) return res.value;
  const message = (res && (res.message || res.error)) || 'extension call failed';
  const err = new Error(String(message));
  err.__extensionHostError = true;
  throw err;
}

function invokeFactory(api) {
  return (...args) => call(api, args);
}

function buildNamespace(ns) {
  const out = {};
  for (const method of ns.methods || []) if (method !== 'connect') out[method] = invokeFactory(`${ns.namespace}.${method}`);
  for (const evt of ns.events || []) out[evt] = makeEvent(ns.namespace, evt);
  if (ns.constants && typeof ns.constants === 'object') Object.assign(out, ns.constants);
  return out;
}

function connect(info) {
  const portName = typeof info === 'string' ? info : (info && info.name) || '';
  const handlers = [];
  let portId = null;
  const port = {
    name: portName || 'port',
    onMessage: {
      addListener(fn) { if (typeof fn === 'function') handlers.push(fn); },
      removeListener(fn) { const i = handlers.indexOf(fn); if (i >= 0) handlers.splice(i, 1); },
      hasListener(fn) { return handlers.includes(fn); },
    },
    onDisconnect: makeEvent('runtime', 'onDisconnect'),
    postMessage(message) {
      if (!portId) return;
      try { ipcRenderer.send(CH.portToContext, portId, message); } catch (_) {}
    },
    disconnect() {
      if (portId) ports.delete(portId);
      portId = null;
    },
  };
  ipcRenderer.invoke(CH.portToHost, extensionId, port.name).then((res) => {
    if (res && res.ok) { portId = String(res.portId); ports.set(portId, handlers); }
  }).catch(() => {});
  return port;
}

const bridge = {
  extensionId,
  origin: ORIGIN,
  native: nativeMode,
  call: (api, args) => call(api, args),
  on: (key, fn) => {
    if (typeof fn !== 'function') return;
    listenerSet(String(key)).add(fn);
  },
  off: (key, fn) => {
    const s = listeners.get(String(key));
    if (s) s.delete(fn);
  },
  agentic: (op, payload) => ipcRenderer.invoke(CH.agenticCall, op, payload, { extensionId }),
  reportAgain: (reason) => ipcRenderer.invoke(CH.reportAgain, extensionId, reason),
};

// ---------------------------------------------------------------------------
// Hosted mode: replace the whole surface.
// ---------------------------------------------------------------------------
function installHosted(namespaces, manifest, descriptor) {
  const chrome = {};
  const runtimeNs = (namespaces || []).find((n) => n.namespace === 'runtime');
  const runtime = runtimeNs ? buildNamespace(runtimeNs) : buildNamespace({ namespace: 'runtime', methods: [], events: ['onMessage', 'onInstalled', 'onStartup', 'onConnect', 'onSuspend'] });

  // Synchronous Chrome semantics: these must never be promises.
  runtime.id = extensionId;
  runtime.getURL = (rel) => `${ORIGIN}/${String(rel == null ? '' : rel).replace(/^\/+/, '')}`;
  runtime.getManifest = () => manifest || {};
  runtime.lastError = undefined;
  runtime.connect = (info) => connect(info);
  chrome.runtime = runtime;

  for (const ns of namespaces || []) {
    if (ns.namespace === 'runtime') continue;
    chrome[ns.namespace] = buildNamespace(ns);
  }

  const fullBridge = Object.assign({}, bridge, { ready: true, descriptor: descriptor || null });
  try {
    contextBridge.exposeInMainWorld('chrome', chrome);
    contextBridge.exposeInMainWorld('__helioExtensionHost', fullBridge);
  } catch (_) {
    // contextIsolation disabled by the page — install directly.
    try { globalThis.chrome = chrome; globalThis.__helioExtensionHost = fullBridge; } catch (_) {}
  }
}

// ---------------------------------------------------------------------------
// Native mode: keep Chromium's bindings, patch only what Electron lacks.
//
// Chromium's `chrome` lives in the page's main world, which the isolated
// preload cannot touch. So the surface is exposed through contextBridge (which
// does cross into the main world) and the fill-in script is evaluated there.
// Everything it builds is main-world code calling only proxied primitives:
// `H.call(api, args)` and `H.on(key, fn)` / `H.off(key, fn)`.
// ---------------------------------------------------------------------------
const PATCH_SCRIPT = `
(() => {
  const H = window.__helioExtensionHost;
  if (!H) return 'no-bridge';
  const chrome = window.chrome;
  if (!chrome) return 'no-chrome';

  const report = { added: [], filled: [], areas: [] };

  function eventObject(key, filter) {
    const set = new Set();
    let bound = false;
    const fire = (payload) => {
      if (filter && !filter(payload)) return;
      for (const fn of [...set]) { try { fn(payload); } catch (_) {} }
    };
    return {
      addListener(fn) {
        if (typeof fn !== 'function') return;
        set.add(fn);
        if (!bound) { bound = true; H.on(key, fire); }
      },
      removeListener(fn) { set.delete(fn); },
      hasListener(fn) { return set.has(fn); },
      hasListeners() { return set.size > 0; },
    };
  }

  function ensureNs(name) {
    if (!chrome[name] || typeof chrome[name] !== 'object') {
      chrome[name] = {};
      report.added.push(name);
    }
    return chrome[name];
  }

  function area(areaName) {
    const base = 'storage.' + areaName;
    const onChanged = eventObject('storage.onChanged', (payload) => {
      if (!payload || payload.areaName !== areaName) return false;
      return true;
    });
    const fix = (args) => (args.length >= 0 ? args : []);
    return {
      get: (...a) => H.call(base + '.get', fix(a)),
      getKeys: (...a) => H.call(base + '.get', fix(a)),
      getBytesInUse: (...a) => H.call(base + '.getBytesInUse', fix(a)),
      set: (...a) => H.call(base + '.set', fix(a)),
      remove: (...a) => H.call(base + '.remove', fix(a)),
      clear: (...a) => H.call(base + '.clear', fix(a)),
      QUOTA_BYTES: 5242880,
      onChanged: onChanged,
    };
  }

  // Storage areas. Electron ships local/session, but "sync" exists only as a
  // stub whose methods throw ("sync is not available in this instance of
  // Chrome") because there is no signed-in profile. So sync and managed are
  // always re-pointed at the host, and local/session only when Electron did not
  // provide real methods.
  if (chrome.storage && typeof chrome.storage === 'object') {
    const FORCED = ['sync', 'managed'];
    for (const name of ['local', 'sync', 'session', 'managed']) {
      const existing = chrome.storage[name];
      const usable = existing && typeof existing.get === 'function';
      if (!usable || FORCED.includes(name)) {
        try {
          chrome.storage[name] = area(name);
          report.areas.push(name);
        } catch (_) {}
      }
    }
  }

  // runtime.sendMessage: in Chromium it reaches the background context. Electron
  // only runs page contexts, so when Chromium reports that nobody is listening
  // we fall back to the host, which fans the message out to the extension's
  // attached pages.
  if (chrome.runtime && typeof chrome.runtime.sendMessage === 'function') {
    const nativeSend = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...a) => {
      let res;
      try { res = nativeSend(...a); } catch (e) { res = Promise.reject(e); }
      return Promise.resolve(res).catch((e) => {
        const msg = (e && e.message) || '';
        if (/Receiving end does not exist|Could not establish connection/i.test(msg)) {
          return H.call('runtime.sendMessage', a);
        }
        throw e;
      });
    };
    report.filled.push('runtime.sendMessage(fallback)');
  }

  // The host delivers messages as extension-host events, which Chromium's own
  // onMessage never sees, so bridge that event in native mode as well.
  if (chrome.runtime) {
    chrome.runtime.onMessage = eventObject('runtime.onMessage', null);
    report.filled.push('runtime.onMessage(bridged)');
  }

  // Namespaces/methods Chromium either gates behind hardware or omits in
  // Electron. Only missing members are filled, so real bindings stay real.
  for (const ns of (H.namespaces || [])) {
    const name = ns.namespace;
    if (name === 'runtime' || name === 'storage') continue;
    const target = ensureNs(name);
    for (const m of (ns.methods || [])) {
      if (typeof target[m] !== 'function') target[m] = (...a) => H.call(name + '.' + m, a);
    }
    for (const evt of (ns.events || [])) {
      if (!target[evt] || typeof target[evt].addListener !== 'function') {
        target[evt] = eventObject(name + '.' + evt, null);
        report.filled.push(name + '.' + evt);
      }
    }
  }

  window.__helioExtensionPatch = report;
  return report;
})();
`;

async function installNative(descriptor) {
  const info = descriptor || {};
  const surface = Object.assign({}, bridge, {
    ready: true,
    namespaces: info.namespaces || [],
    manifest: info.manifest || {},
  });
  try {
    contextBridge.exposeInMainWorld('__helioExtensionHost', surface);
  } catch (_) {
    try { globalThis.__helioExtensionHost = surface; } catch (_) {}
  }
  try {
    await webFrame.executeJavaScript(PATCH_SCRIPT);
  } catch (e) {
    console.error('[helio] extension patch failed:', e && e.message);
  }
}

// Boot: ask the host for the descriptor (permission-filtered namespaces +
// manifest), then install the right surface.
(async () => {
  let info = null;
  try { info = await ipcRenderer.invoke(CH.installed, extensionId); } catch (_) { info = null; }
  if (!info || !info.ok) return;
  if (nativeMode) return installNative(info);
  return installHosted(info.namespaces || [], info.manifest || {}, info);
})();
