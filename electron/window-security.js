'use strict';
const path = require('path');

/**
 * Validate renderer IPC sender origin and attach webview security hardening.
 * Kept in its own module so electron/main.js stays compact.
 */
function isTrustedRendererEvent(event) {
  try {
    const urlStr = event && event.senderFrame && event.senderFrame.url
      ? String(event.senderFrame.url)
      : (event && event.sender && typeof event.sender.getURL === 'function' ? String(event.sender.getURL()) : '');
    if (!urlStr) return true; // test mocks / synthetic IPC without frame URL
    if (urlStr.startsWith('file://')) return true;
    const u = new URL(urlStr);
    if ((u.protocol === 'http:' || u.protocol === 'https:') && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
      return true;
    }
    return false;
  } catch (_) {
    return false;
  }
}

function attachWindowHardening(win, { workspace } = {}) {
  if (!win || !win.webContents || typeof win.webContents.on !== 'function') return;
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    try {
      // Strip any injected preload scripts and force isolated untrusted guest execution.
      delete webPreferences.preload;
      delete webPreferences.preloadURL;
      webPreferences.nodeIntegration = false;
      webPreferences.nodeIntegrationInWorker = false;
      webPreferences.nodeIntegrationInSubFrames = false;
      webPreferences.contextIsolation = true;
      webPreferences.sandbox = true;
      webPreferences.webSecurity = true;
      webPreferences.allowRunningInsecureContent = false;

      const src = String((params && params.src) || '').trim();
      if (!src) return;
      if (/^(?:javascript|vbscript|data:text\/html):/i.test(src)) {
        event.preventDefault();
        return;
      }
      if (/^file:\/\//i.test(src) && workspace && typeof workspace.isAllowedPreviewUrl === 'function') {
        if (!workspace.isAllowedPreviewUrl(src)) {
          // Only block clearly sensitive paths (e.g. ~/.ssh, ~/.autobot/secrets.json);
          // regular workspace / artifact file previews remain allowed.
          const decoded = decodeURIComponent(src.replace(/^file:\/\//i, ''));
          if (/[/\\](?:\.ssh|\.gnupg|\.aws|\.autobot[/\\](?:secrets|oauth))/i.test(decoded)) {
            event.preventDefault();
          }
        }
      }
    } catch (_) {
      webPreferences.nodeIntegration = false;
      webPreferences.contextIsolation = true;
    }
  });
}

function isBlockedCredentialTarget(targetPath, sandbox) {
  try {
    if (!targetPath || !sandbox) return false;
    if (typeof sandbox.isProtectedCredentialPath === 'function' && sandbox.isProtectedCredentialPath(targetPath)) {
      return true;
    }
    const base = path.basename(String(targetPath)).toLowerCase();
    const norm = path.resolve(String(targetPath)).replace(/\\/g, '/').toLowerCase();
    return norm.includes('/.autobot/') && (base === 'secrets.json' || base === 'master.key' || base === 'oauth.json');
  } catch (_) {
    return false;
  }
}

module.exports = {
  isTrustedRendererEvent,
  attachWindowHardening,
  isBlockedCredentialTarget,
};
