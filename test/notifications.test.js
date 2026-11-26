'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const notifMod = require(path.join(ROOT, 'electron', 'notifications'));

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test('resolves unpacked icon.png / icon.ico and never returns .asar paths', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-icon-'));
  const resDir = path.join(tmp, 'Resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.writeFileSync(path.join(resDir, 'icon.png'), 'png');
  fs.writeFileSync(path.join(resDir, 'icon.ico'), 'ico');

  const pkgIcon = notifMod.resolveNotificationIconPath({ isPackaged: true, resourcesPath: resDir, appRoot: path.join(resDir, 'app.asar') });
  assert.strictEqual(pkgIcon, path.join(resDir, 'icon.png'));
  assert.ok(!pkgIcon.includes('.asar'));

  const winIcon = notifMod.resolveAppIconPath({ platform: 'win32', isPackaged: true, resourcesPath: resDir, appRoot: path.join(resDir, 'app.asar') });
  assert.strictEqual(winIcon, path.join(resDir, 'icon.ico'));

  const devIcon = notifMod.resolveNotificationIconPath({ isPackaged: false, appRoot: ROOT });
  assert.ok(devIcon && devIcon.endsWith(path.join('build', 'icon.png')));
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('builds Windows Toast XML with escaped special chars & file:// appLogoOverride', () => {
  const xml = notifMod.buildWindowsToastXml({
    title: 'Akron <Code> & "IDE"',
    subtitle: "Build 'v1.1'",
    body: '3 files updated',
    iconPath: 'C:\\Program Files\\Akron Code\\resources\\icon.png',
    sound: false,
  });
  assert.ok(xml.includes('&lt;Code&gt; &amp; &quot;IDE&quot;'));
  assert.ok(xml.includes('&apos;v1.1&apos;'));
  assert.ok(xml.includes('file:///C:/Program%20Files/Akron%20Code/resources/icon.png'));
  assert.ok(xml.includes('<audio silent="true"/>'));

  const loudXml = notifMod.buildWindowsToastXml({ title: 'Done', sound: true });
  assert.ok(!loudXml.includes('silent="true"'));
});

test('suppresses when focused unless force or notifyWhenFocused is true; guards headless Linux', () => {
  const shown = [];
  class MockNotif {
    constructor(opts) { this.opts = opts; this.handlers = {}; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() { shown.push(this); }
    static isSupported() { return true; }
  }
  const focusedWin = { isDestroyed: () => false, isVisible: () => true, isMinimized: () => false, isFocused: () => true };

  const svc = notifMod.createNotificationService({
    platform: 'linux',
    env: { DISPLAY: ':0' },
    NotificationClass: MockNotif,
    getWindows: () => [focusedWin],
    getMainWindow: () => focusedWin,
  });
  assert.deepStrictEqual(svc.notify({ title: 'Hi' }), { ok: true, shown: false, reason: 'focused' });
  assert.strictEqual(svc.notify({ title: 'Focused Allowed', notifyWhenFocused: true }).shown, true);
  assert.strictEqual(svc.notify({ title: 'Forced Test', force: true, sound: true }).options.silent, false);

  const headlessSvc = notifMod.createNotificationService({
    platform: 'linux',
    env: {},
    NotificationClass: MockNotif,
    getWindows: () => [],
  });
  assert.deepStrictEqual(headlessSvc.notify({ title: 'No display', force: true }), { ok: false, shown: false, reason: 'headless_linux' });
});

test('increments macOS dock badge, flashes Windows frame, and clears/focuses on click', () => {
  const sent = [];
  let flashed = [];
  let badge = '';
  let bounced = 0;
  let lastNotif = null;
  class MockNotif {
    constructor(opts) { this.opts = opts; this.handlers = {}; lastNotif = this; }
    on(ev, fn) { this.handlers[ev] = fn; }
    show() {}
    static isSupported() { return true; }
  }
  const bgWin = {
    isDestroyed: () => false,
    isVisible: () => true,
    isMinimized: () => false,
    isFocused: () => false,
    flashFrame: (v) => flashed.push(v),
    webContents: { send: (ch, p) => sent.push({ ch, p }) },
  };
  const mockApp = { dock: { setBadge: (b) => { badge = b; }, bounce: () => { bounced++; } } };

  const macSvc = notifMod.createNotificationService({
    platform: 'darwin',
    NotificationClass: MockNotif,
    appMod: mockApp,
    getWindows: () => [bgWin],
    getMainWindow: () => bgWin,
    focusMainWindow: () => bgWin,
  });
  macSvc.notify({ title: 'Done', convId: 'c1' });
  assert.strictEqual(badge, '1');
  assert.strictEqual(bounced, 1);
  lastNotif.handlers.click();
  assert.strictEqual(badge, '');
  assert.strictEqual(sent[0].p.convId, 'c1');

  const winSvc = notifMod.createNotificationService({
    platform: 'win32',
    NotificationClass: MockNotif,
    getWindows: () => [bgWin],
    getMainWindow: () => bgWin,
  });
  winSvc.notify({ title: 'Win Done' });
  assert.strictEqual(flashed[0], true);
  winSvc.clearAttention();
  assert.strictEqual(flashed[1], false);
});

(async () => {
  let pass = 0;
  let fail = 0;
  console.log('\nNotifications Cross-OS Verification');
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log('  ok   - ' + t.name);
    } catch (e) {
      fail++;
      console.error('  FAIL - ' + t.name + ': ' + (e && e.stack ? e.stack : e));
    }
  }
  console.log(`\nSummary: ${pass}/${tests.length} passed`);
  if (fail) process.exit(1);
})();
