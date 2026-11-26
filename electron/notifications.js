'use strict';

const fs = require('fs');
const path = require('path');

const APP_USER_MODEL_ID = 'com.akronbot.app';

function escapeXml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toFileUri(filePath) {
  if (!filePath) return '';
  let norm = String(filePath).replace(/\\/g, '/');
  if (!norm.startsWith('/')) norm = '/' + norm;
  const encoded = norm.split('/').map((seg, i) => (i === 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg))).join('/');
  return 'file://' + encoded;
}

function resolveNotificationIconPath({
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  appRoot = path.join(__dirname, '..'),
  fsMod = fs,
} = {}) {
  const candidates = [];
  if (isPackaged && resourcesPath) {
    candidates.push(path.join(resourcesPath, 'icon.png'));
  }
  if (appRoot) {
    candidates.push(path.join(appRoot, 'build', 'icon.png'));
  }
  for (const candidate of candidates) {
    if (!candidate || candidate.includes('.asar')) continue;
    try {
      if (fsMod.existsSync(candidate)) return candidate;
    } catch (_) {}
  }
  return null;
}

function resolveAppIconPath({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  appRoot = path.join(__dirname, '..'),
  fsMod = fs,
} = {}) {
  if (platform === 'win32') {
    const icoCandidates = [];
    if (isPackaged && resourcesPath) {
      icoCandidates.push(path.join(resourcesPath, 'icon.ico'));
    }
    if (appRoot) {
      icoCandidates.push(path.join(appRoot, 'build', 'icon.ico'));
    }
    for (const candidate of icoCandidates) {
      if (!candidate || candidate.includes('.asar')) continue;
      try {
        if (fsMod.existsSync(candidate)) return candidate;
      } catch (_) {}
    }
  }
  return resolveNotificationIconPath({ isPackaged, resourcesPath, appRoot, fsMod });
}

function buildWindowsToastXml({ title = 'Akron Code', subtitle = '', body = '', iconPath = null, sound = false } = {}) {
  const logoTag = iconPath
    ? `<image placement="appLogoOverride" src="${escapeXml(toFileUri(iconPath))}"/>`
    : '';
  const subTag = subtitle ? `<text>${escapeXml(subtitle)}</text>` : '';
  const bodyTag = body ? `<text>${escapeXml(body)}</text>` : '';
  const audioTag = sound ? '' : '<audio silent="true"/>';
  return (
    `<toast>` +
      `<visual>` +
        `<binding template="ToastGeneric">` +
          logoTag +
          `<text>${escapeXml(title || 'Akron Code')}</text>` +
          subTag +
          bodyTag +
        `</binding>` +
      `</visual>` +
      audioTag +
    `</toast>`
  );
}

function buildNotificationOptions({
  title = 'Akron Code',
  subtitle = '',
  body = '',
  platform = process.platform,
  iconPath = null,
  sound = false,
} = {}) {
  const cleanTitle = String(title || 'Akron Code').slice(0, 120);
  const cleanSubtitle = String(subtitle || '').slice(0, 120);
  const cleanBody = String(body || '').slice(0, 240);
  const silent = !sound;

  if (platform === 'win32') {
    const opts = {
      title: cleanTitle,
      body: cleanBody,
      silent,
    };
    if (iconPath) {
      opts.icon = iconPath;
      opts.toastXml = buildWindowsToastXml({
        title: cleanTitle,
        subtitle: cleanSubtitle,
        body: cleanBody,
        iconPath,
        sound: !!sound,
      });
    }
    return opts;
  }

  if (platform === 'linux') {
    const opts = {
      title: cleanTitle,
      body: cleanBody,
      silent,
    };
    if (iconPath) opts.icon = iconPath;
    return opts;
  }

  const darwinOpts = {
    title: cleanTitle,
    body: cleanBody,
    silent,
  };
  if (cleanSubtitle) darwinOpts.subtitle = cleanSubtitle;
  return darwinOpts;
}

function isAnyWindowFocused(wins) {
  for (const w of wins) {
    if (!w) continue;
    try {
      if (typeof w.isDestroyed === 'function' && w.isDestroyed()) continue;
      const visible = typeof w.isVisible === 'function' ? w.isVisible() : true;
      const minimized = typeof w.isMinimized === 'function' ? w.isMinimized() : false;
      const focused = typeof w.isFocused === 'function' ? w.isFocused() : false;
      if (visible && !minimized && focused) return true;
    } catch (_) {}
  }
  return false;
}

function createNotificationService({
  platform = process.platform,
  env = process.env,
  isPackaged = () => false,
  resourcesPath = () => process.resourcesPath,
  appRoot = path.join(__dirname, '..'),
  fsMod = fs,
  NotificationClass = null,
  appMod = null,
  getWindows = null,
  getMainWindow = () => null,
  focusMainWindow = () => null,
} = {}) {
  let unreadCount = 0;
  const activeNotifications = new Set();

  function getElectronBindings() {
    let Notif = NotificationClass;
    let appObj = appMod;
    if (!Notif || !appObj) {
      try {
        const electron = require('electron');
        if (!Notif) Notif = electron.Notification;
        if (!appObj) appObj = electron.app;
      } catch (_) {}
    }
    return { Notification: Notif, app: appObj };
  }

  function listWindows() {
    if (typeof getWindows === 'function') {
      const res = getWindows();
      if (Array.isArray(res)) return res;
    }
    const w = typeof getMainWindow === 'function' ? getMainWindow() : null;
    return w ? [w] : [];
  }

  function clearAttention(win = null) {
    unreadCount = 0;
    const { app } = getElectronBindings();
    if (platform === 'darwin' && app && app.dock && typeof app.dock.setBadge === 'function') {
      try { app.dock.setBadge(''); } catch (_) {}
    }
    const target = win || (typeof getMainWindow === 'function' ? getMainWindow() : null);
    const seen = new Set();
    for (const w of [target, ...listWindows()]) {
      if (!w || seen.has(w)) continue;
      seen.add(w);
      if (platform === 'win32' && typeof w.flashFrame === 'function') {
        try { w.flashFrame(false); } catch (_) {}
      }
    }
  }

  function notify(payload = {}) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const { Notification, app } = getElectronBindings();

    const focused = isAnyWindowFocused(listWindows());
    if (focused && !p.force && !p.notifyWhenFocused) {
      return { ok: true, shown: false, reason: 'focused' };
    }

    if (platform === 'linux' && (!env || (!env.DISPLAY && !env.WAYLAND_DISPLAY))) {
      return { ok: false, shown: false, reason: 'headless_linux' };
    }

    if (!Notification || (typeof Notification.isSupported === 'function' && !Notification.isSupported())) {
      return { ok: false, shown: false, reason: 'unsupported' };
    }

    const packaged = typeof isPackaged === 'function' ? !!isPackaged() : !!isPackaged;
    const resPath = typeof resourcesPath === 'function' ? resourcesPath() : resourcesPath;
    const iconPath = resolveNotificationIconPath({
      isPackaged: packaged,
      resourcesPath: resPath,
      appRoot,
      fsMod,
    });

    const opts = buildNotificationOptions({
      title: p.title || 'Akron Code',
      subtitle: p.subtitle || '',
      body: p.body || '',
      platform,
      iconPath,
      sound: !!p.sound,
    });

    let notif;
    try {
      notif = new Notification(opts);
    } catch (err) {
      return { ok: false, shown: false, reason: 'construct_failed', error: String((err && err.message) || err) };
    }

    activeNotifications.add(notif);
    const cleanupTimer = setTimeout(() => {
      activeNotifications.delete(notif);
    }, 60000);
    if (cleanupTimer && typeof cleanupTimer.unref === 'function') cleanupTimer.unref();

    const release = () => {
      clearTimeout(cleanupTimer);
      activeNotifications.delete(notif);
    };

    if (typeof notif.on === 'function') {
      notif.on('close', release);
      notif.on('failed', release);
      notif.on('click', () => {
        release();
        const focusedWin = (typeof focusMainWindow === 'function' ? focusMainWindow() : null)
          || (typeof getMainWindow === 'function' ? getMainWindow() : null);
        clearAttention(focusedWin);
        if (focusedWin && focusedWin.webContents && typeof focusedWin.webContents.send === 'function') {
          try {
            focusedWin.webContents.send('autobot:event', {
              type: 'notificationClick',
              convId: p.convId || null,
              kind: p.kind || 'agent',
            });
          } catch (_) {}
        }
      });
    }

    if (!focused) {
      const mainWin = typeof getMainWindow === 'function' ? getMainWindow() : null;
      if (platform === 'win32' && mainWin && typeof mainWin.flashFrame === 'function') {
        try { mainWin.flashFrame(true); } catch (_) {}
      }
      if (platform === 'darwin' && app && app.dock) {
        unreadCount += 1;
        if (typeof app.dock.bounce === 'function') {
          try { app.dock.bounce('informational'); } catch (_) {}
        }
        if (typeof app.dock.setBadge === 'function') {
          try { app.dock.setBadge(String(unreadCount)); } catch (_) {}
        }
      }
    }

    if (typeof notif.show === 'function') notif.show();
    return { ok: true, shown: true, iconPath, options: opts };
  }

  return {
    notify,
    clearAttention,
    getUnreadCount: () => unreadCount,
    _activeCount: () => activeNotifications.size,
  };
}

module.exports = {
  APP_USER_MODEL_ID,
  escapeXml,
  toFileUri,
  resolveNotificationIconPath,
  resolveAppIconPath,
  buildWindowsToastXml,
  buildNotificationOptions,
  createNotificationService,
};
