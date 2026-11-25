'use strict';
// Helio Bot — preload for standalone artifact windows.
//
// A canvas artifact (Design artboards, Slides deck) is a generated document
// that the user can then edit by hand. Those edits have to go somewhere
// durable, and the window that hosts the document is loaded from a `data:`
// URL — an opaque origin with no `localStorage`, no `fetch` back to the app and
// no access to the renderer's React state. So the document gets a tiny, explicit
// bridge instead of ambient privileges:
//
//   save(edits)   persist the edits for *this* artifact (key comes from argv,
//                 never from the page, so one artifact cannot rewrite another)
//   get()         read them back on load
//   reset()       drop them (reset-to-generated)
//   download(...) save a file the user asked for
//   print()       render this document to PDF through the save dialog
//   invoke(ch, p) a short allowlist of main-process channels (Drive upload,
//                 external links) — never arbitrary IPC
//
// The key is passed as `--helio-artifact-key=<key>` by createArtifactWindow,
// which is the same FNV-1a hash `artifactstore.keyFor(language, content)`
// produces, so artifacts opened from the in-chat preview and from the artifact
// window resolve to the same edit slot.

const { contextBridge, ipcRenderer } = require('electron');

function readArg(prefix) {
  for (const arg of process.argv) {
    if (typeof arg === 'string' && arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

const KEY = readArg('--helio-artifact-key=');

// Channels the document itself is allowed to reach. Anything else — including
// every channel the app's own preload exposes — stays unreachable from a
// generated artifact.
const INVOKE_ALLOW = new Set([
  'autobot:slidesUpload',
  'autobot:artifactPrint',
  'autobot:openExternal',
]);

const bridge = {
  get key() { return KEY; },
  get ready() { return !!KEY; },

  // Persist the current canvas state. `edits` is the same shape that
  // artifactcanvas.applyDesignEdits / applySlidesEdits consume.
  save: (edits) => {
    if (!KEY) return Promise.resolve({ ok: false, error: 'no artifact key' });
    return ipcRenderer.invoke('autobot:artifactSave', { key: KEY, edits: edits || {} });
  },

  get: () => {
    if (!KEY) return Promise.resolve({ ok: true, edits: null });
    return ipcRenderer.invoke('autobot:artifactGet', { key: KEY });
  },

  reset: () => {
    if (!KEY) return Promise.resolve({ ok: false, error: 'no artifact key' });
    return ipcRenderer.invoke('autobot:artifactReset', { key: KEY });
  },

  // Save a file the user explicitly asked for. Preload shares the document's
  // DOM (contextIsolation isolates the JS world, not the page tree), so an
  // anchor click is enough — no temp files, no writes outside Downloads.
  // Promise-returning like every other bridge method.
  download: (name, text, mime) => new Promise((resolve) => {
    try {
      const body = String(text == null ? '' : text);
      const blob = new Blob([body], { type: String(mime || 'text/plain;charset=utf-8') });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = String(name || 'artifact.txt').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 120);
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 4000);
      resolve({ ok: true, name: a.download, bytes: body.length });
    } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : 'download failed' });
    }
  }),

  print: () => ipcRenderer.invoke('autobot:artifactPrint', { key: KEY }),

  invoke: (channel, payload) => {
    if (!INVOKE_ALLOW.has(channel)) {
      return Promise.resolve({ ok: false, error: 'channel not allowed: ' + String(channel) });
    }
    return ipcRenderer.invoke(channel, payload);
  },
};

try {
  contextBridge.exposeInMainWorld('helioArtifact', bridge);
} catch (_) {
  // contextIsolation disabled (should not happen) — fall back to a plain global.
  try { window.helioArtifact = bridge; } catch (_e) {}
}

// An edit made somewhere else (the in-chat preview) for this same artifact:
// reload so both surfaces show one document. Every edit is pushed on change, so
// there is nothing unsaved to lose.
ipcRenderer.on('autobot:artifactSaved', (event, info) => {
  if (!KEY || !info || info.key !== KEY) return;
  try { location.reload(); } catch (_) {}
});
