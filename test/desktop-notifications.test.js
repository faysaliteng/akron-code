'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const EventEmitter = require('events');

const ROOT = path.join(__dirname, '..');
const {
  APP_USER_MODEL_ID,
  escapeXml,
  toFileUri,
  resolveNotificationIconPath,
  resolveAppIconPath,
  buildWindowsToastXml,
  buildNotificationOptions,
  createNotificationService,
} = require(path.join(ROOT, 'electron', 'notifications'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log('  ok   - ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.error('  FAIL - ' + name + ': ' + (e && e.stack ? e.stack : e));
  }
}

console.log('\nCross-OS Desktop Notification & Icon suite');

test('package.json ships unpacked icon.png/icon.ico in extraResources and sets build.linux.icon', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const extras = (pkg.build && pkg.build.extraResources) || [];
  assert.ok(extras.some((r) => r && r.from === 'build/icon.png' && r.to === 'icon.png'), 'extraResources must unpack build/icon.png -> icon.png');
  assert.ok(extras.some((r) => r && r.from === 'build/icon.ico' && r.to === 'icon.ico'), 'extraResources must unpack build/icon.ico -> icon.ico');
  assert.strictEqual(pkg.build && pkg.build.linux && pkg.build.linux.icon, 'build/icon.png');
  assert.strictEqual(pkg.build && pkg.build.appId, APP_USER_MODEL_ID);
});

test('electron/main.js sets AppUserModelId before whenReady, attaches window/dock icons, and registers notify IPC', () => {
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'electron', 'preload.js'), 'utf8');
  const appIdIdx = mainSrc.indexOf('app.setAppUserModelId(APP_USER_MODEL_ID)');
  const readyIdx = mainSrc.indexOf('app.whenReady().then');
  assert.ok(appIdIdx > 0 && readyIdx > appIdIdx, 'setAppUserModelId must execute before app.whenReady()');
  assert.ok(mainSrc.includes('...windowIconProps()'), 'BrowserWindow instances must attach windowIconProps()');
  assert.ok(mainSrc.includes('app.dock.setIcon(dockImg)'), 'macOS dev mode must call app.dock.setIcon');
  assert.ok(mainSrc.includes("ipcMain.handle('autobot:notify'"), 'main.js must handle autobot:notify');
  assert.ok(preloadSrc.includes("notify: (payload) => ipcRenderer.invoke('autobot:notify', payload)"), 'preload.js must expose autobot.notify');
});

test('resolveNotificationIconPath and resolveAppIconPath resolve real non-asar files in dev and packaged modes', () => {
  const devIcon = resolveNotificationIconPath({ isPackaged: false, appRoot: ROOT });
  assert.ok(devIcon && fs.existsSync(devIcon), 'dev icon.png must exist');
  assert.strictEqual(devIcon.includes('.asar'), false);

  const devWinIcon = resolveAppIconPath({ platform: 'win32', isPackaged: false, appRoot: ROOT });
  assert.ok(devWinIcon && devWinIcon.endsWith('icon.ico') && fs.existsSync(devWinIcon));

  const tmpRes = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-res-test-'));
  try {
    const pkgPng = path.join(tmpRes, 'icon.png');
    const pkgIco = path.join(tmpRes, 'icon.ico');
    fs.writeFileSync(pkgPng, 'png');
    fs.writeFileSync(pkgIco, 'ico');
    assert.strictEqual(resolveNotificationIconPath({ isPackaged: true, resourcesPath: tmpRes, appRoot: '/nonexistent' }), pkgPng);
    assert.strictEqual(resolveAppIconPath({ platform: 'win32', isPackaged: true, resourcesPath: tmpRes, appRoot: '/nonexistent' }), pkgIco);
    assert.strictEqual(resolveNotificationIconPath({ isPackaged: true, resourcesPath: path.join(tmpRes, 'app.asar'), appRoot: ROOT }), devIcon);
  } finally {
    fs.rmSync(tmpRes, { recursive: true, force: true });
  }
});

test('buildWindowsToastXml & buildNotificationOptions construct valid payloads for win32, linux, and darwin', () => {
  const xml = buildWindowsToastXml({
    title: 'Akron & Code <1>',
    subtitle: 'Build',
    body: 'Done & "Verified"',
    iconPath: 'C:\\Program Files\\Akron Code\\resources\\icon.png',
  });
  assert.ok(xml.includes('placement="appLogoOverride"'));
  assert.ok(xml.includes('file:///C:/Program%20Files/Akron%20Code/resources/icon.png'));
  assert.ok(xml.includes('Akron &amp; Code &lt;1&gt;'));
  assert.ok(xml.includes('Done &amp; &quot;Verified&quot;'));
  assert.ok(xml.includes('<audio silent="true"/>'));

  const winOpts = buildNotificationOptions({ title: 'T', body: 'B', platform: 'win32', iconPath: '/tmp/icon.png' });
  assert.strictEqual(winOpts.icon, '/tmp/icon.png');
  assert.ok(winOpts.toastXml.includes('file:///tmp/icon.png'));

  const linuxOpts = buildNotificationOptions({ title: 'T', body: 'B', platform: 'linux', iconPath: '/tmp/icon.png' });
  assert.strictEqual(linuxOpts.icon, '/tmp/icon.png');
  assert.strictEqual(linuxOpts.toastXml, undefined);

  const darwinOpts = buildNotificationOptions({ title: 'T', subtitle: 'Sub', body: 'B', platform: 'darwin', iconPath: '/tmp/icon.png' });
  assert.strictEqual(darwinOpts.subtitle, 'Sub');
  assert.strictEqual(darwinOpts.icon, undefined);
  assert.strictEqual(darwinOpts.silent, true);
});

function makeMockElectron(initialFocused = false) {
  const created = [];
  class MockNotification extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.shown = false;
      created.push(this);
    }
    show() {
      this.shown = true;
    }
  }
  MockNotification.isSupported = () => true;

  const sentEvents = [];
  const winState = {
    destroyed: false,
    visible: true,
    minimized: !initialFocused,
    focused: initialFocused,
    flashed: [],
    shownCount: 0,
    focusCount: 0,
  };
  const win = {
    isDestroyed: () => winState.destroyed,
    isVisible: () => winState.visible,
    isMinimized: () => winState.minimized,
    isFocused: () => winState.focused,
    restore: () => { winState.minimized = false; },
    show: () => { winState.shownCount += 1; },
    focus: () => { winState.focused = true; winState.focusCount += 1; },
    flashFrame: (flag) => { winState.flashed.push(flag); },
    webContents: {
      send: (ch, payload) => sentEvents.push({ ch, payload }),
    },
  };
  const dockCalls = { bounces: [], badges: [] };
  const appMod = {
    dock: {
      bounce: (t) => dockCalls.bounces.push(t),
      setBadge: (b) => dockCalls.badges.push(b),
    },
  };
  return { MockNotification, created, win, winState, sentEvents, appMod, dockCalls };
}

test('createNotificationService respects focus gating unless force=true and routes click -> focus + convId', () => {
  const mock = makeMockElectron(true);
  const svc = createNotificationService({
    platform: 'win32',
    isPackaged: () => false,
    appRoot: ROOT,
    NotificationClass: mock.MockNotification,
    appMod: mock.appMod,
    getWindows: () => [mock.win],
    getMainWindow: () => mock.win,
    focusMainWindow: () => {
      mock.win.restore();
      mock.win.show();
      mock.win.focus();
      return mock.win;
    },
  });

  // Focused window -> suppressed
  const suppressed = svc.notify({ title: 'Agent done', body: 'Hello', convId: 'conv_42' });
  assert.strictEqual(suppressed.shown, false);
  assert.strictEqual(suppressed.reason, 'focused');
  assert.strictEqual(mock.created.length, 0);

  // Forced from Settings Test Notification -> shown even when focused
  const forced = svc.notify({ title: 'Test', body: 'Logo active', convId: 'conv_42', force: true });
  assert.strictEqual(forced.shown, true);
  assert.strictEqual(mock.created.length, 1);
  assert.ok(mock.created[0].opts.icon.endsWith('icon.png'));

  // Unfocused -> shown, flashes frame, click restores/focuses & sends convId event
  mock.winState.focused = false;
  mock.winState.minimized = true;
  const shown = svc.notify({ kind: 'permissions', title: 'Permission', body: 'Allow?', convId: 'conv_99' });
  assert.strictEqual(shown.shown, true);
  assert.deepStrictEqual(mock.winState.flashed, [true]);
  assert.strictEqual(svc._activeCount(), 2);

  mock.created[1].emit('click');
  assert.strictEqual(mock.winState.minimized, false);
  assert.strictEqual(mock.winState.focused, true);
  assert.deepStrictEqual(mock.winState.flashed, [true, false]);
  assert.strictEqual(mock.sentEvents.length, 1);
  assert.strictEqual(mock.sentEvents[0].ch, 'autobot:event');
  assert.deepStrictEqual(mock.sentEvents[0].payload, { type: 'notificationClick', convId: 'conv_99', kind: 'permissions' });
});

test('darwin unfocused notification bounces dock, increments badge, and clearAttention resets badge', () => {
  const mock = makeMockElectron(false);
  const svc = createNotificationService({
    platform: 'darwin',
    isPackaged: () => false,
    appRoot: ROOT,
    NotificationClass: mock.MockNotification,
    appMod: mock.appMod,
    getWindows: () => [mock.win],
    getMainWindow: () => mock.win,
    focusMainWindow: () => mock.win,
  });

  svc.notify({ title: 'Done 1', body: 'First', convId: 'c1' });
  svc.notify({ title: 'Done 2', body: 'Second', convId: 'c2' });
  assert.deepStrictEqual(mock.dockCalls.bounces, ['informational', 'informational']);
  assert.deepStrictEqual(mock.dockCalls.badges, ['1', '2']);
  assert.strictEqual(svc.getUnreadCount(), 2);

  svc.clearAttention(mock.win);
  assert.strictEqual(svc.getUnreadCount(), 0);
  assert.strictEqual(mock.dockCalls.badges[mock.dockCalls.badges.length - 1], '');
});

const failed = results.filter((r) => !r.ok);
console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
if (failed.length) process.exit(1);
