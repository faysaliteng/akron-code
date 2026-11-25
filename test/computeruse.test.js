'use strict';
// Computer Use surface (Desktop `computer:*` consent + `cu:*` capture). The
// module keeps grant/mask state under ~/.autobot/computeruse.json; the test
// points HOME at a temp dir BEFORE requiring it so the real store is untouched.
// No Electron, no screen capture: everything here is the pure state machine,
// the mask maths, the parsers, and the dispatcher's contract.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-computeruse-'));
process.env.HOME = tmp; // os.homedir() honours $HOME on POSIX
const cu = require('../electron/computeruse');

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — channel inventory');
// ---------------------------------------------------------------------------
eq('17 Desktop channels', cu.CHANNELS.length, 17);
eq('3 consent channels', cu.CHANNELS.filter((c) => c.startsWith('computer:')).length, 3);
eq('14 cu channels', cu.CHANNELS.filter((c) => c.startsWith('cu:')).length, 14);
ok('file lives under the temp home', cu.FILE.startsWith(tmp), cu.FILE);

// The three consent tiers exist and are ordered narrow -> wide.
eq('tier order', cu.TIER_ORDER, ['access', 'full_control', 'teach_access']);
ok('unknown tier rejected', cu.tierInfo('root') === null);

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — tier lattice');
// ---------------------------------------------------------------------------
ok('no grant satisfies nothing', !cu.satisfies(null, 'access'));
ok('access satisfies access', cu.satisfies('access', 'access'));
ok('access does not satisfy full_control', !cu.satisfies('access', 'full_control'));
ok('full_control satisfies access', cu.satisfies('full_control', 'access'));
ok('full_control satisfies itself', cu.satisfies('full_control', 'full_control'));
ok('teach does not satisfy full_control', !cu.satisfies('teach_access', 'full_control'));
ok('teach satisfies teach', cu.satisfies('teach_access', 'teach_access'));
eq('capability → narrowest tier', [
  cu.narrowestFor('record'), cu.narrowestFor('control'), cu.narrowestFor('look'), cu.narrowestFor(''),
], ['teach_access', 'full_control', 'access', 'access']);

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — request / grant / revoke');
// ---------------------------------------------------------------------------
cu.reset();
let r = cu.request('access');
ok('request access is pending', r.ok && r.pending && r.requested === 'access', r);
r = cu.grant('access', { remember: false });
ok('grant access', r.ok && r.grant === 'access', r);
eq('status reflects session grant', cu.status().grant, 'access');
ok('re-request inside grant is already granted', cu.request('access').alreadyGranted === true);

r = cu.revoke();
ok('revoke clears', r.ok && r.grant === null);
eq('status grant null', cu.status().grant, null);

// Session-only grants must not survive a fresh load.
cu.reset();
cu.grant('full_control', { remember: false });
// Simulate a restart: drop memory, keep the file.
const before = JSON.parse(fs.readFileSync(cu.FILE, 'utf8'));
ok('session-only grant not written to disk', before.grant === null, before.grant);

// Remembered grants do survive.
cu.reset();
cu.grant('access', { remember: true });
const after = JSON.parse(fs.readFileSync(cu.FILE, 'utf8'));
ok('remembered grant written', after.grant === 'access', after.grant);
cu.reset();
ok('reset removes the file', !fs.existsSync(cu.FILE));

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — mask rectangles');
// ---------------------------------------------------------------------------
eq('masks from {w,h}', cu.sanitizeMasks([{ x: 10, y: 20, w: 30, h: 40 }]), [{ x: 10, y: 20, w: 30, h: 40 }]);
eq('masks from {width,height}', cu.sanitizeMasks([{ x: 1, y: 2, width: 3, height: 4 }]), [{ x: 1, y: 2, w: 3, h: 4 }]);
eq('degenerate rects dropped', cu.sanitizeMasks([{ x: 0, y: 0, w: 1, h: 1 }, { x: 0, y: 0, w: 0, h: 9 }]), []);
eq('non-finite dropped', cu.sanitizeMasks([{ x: 'a', y: 0, w: 5, h: 5 }, null, 7]), []);
eq('negatives clamped to 0', cu.sanitizeMasks([{ x: -20, y: -5, w: 30, h: 30 }]), [{ x: 0, y: 0, w: 30, h: 30 }]);
ok('caps at 32', cu.sanitizeMasks(Array.from({ length: 60 }, (_, i) => ({ x: i, y: i, w: 10, h: 10 }))).length === 32);

cu.reset();
cu.setMasks([{ x: 0, y: 0, w: 100, h: 100 }]);
ok('isMasked inside', cu.isMasked({ x: 10, y: 10, w: 10, h: 10 }) === true);
ok('isMasked outside', cu.isMasked({ x: 200, y: 200, w: 10, h: 10 }) === false);
ok('isMasked edge overlap counts', cu.isMasked({ x: 99, y: 99, w: 10, h: 10 }) === true);
cu.addMask({ x: 500, y: 500, w: 50, h: 50 });
eq('addMask appends', cu.load().masks.length, 2);
cu.clearMasks();
eq('clearMasks empties', cu.load().masks.length, 0);

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — content-protection parser');
// ---------------------------------------------------------------------------
let cp = cu.parseContentProtection([
  { owner: 'Safari', sharingState: 1, layer: 0, alpha: 1 },
  { owner: 'Terminal', sharingState: 1, layer: 0, alpha: 1 },
]);
ok('normal windows are not protected', cp.protected === false && cp.count === 0, cp);
cp = cu.parseContentProtection([{ owner: 'Netflix', sharingState: 1, layer: 3, alpha: 1 }]);
ok('DRM owner on non-desktop layer flagged', cp.protected === true && cp.count === 1, cp);
cp = cu.parseContentProtection([{ owner: 'Whatever', sharingState: 0, layer: 0, alpha: 1 }]);
ok('sharing-disabled window flagged', cp.protected === true && cp.windows[0].reason === 'sharing-disabled', cp);
cp = cu.parseContentProtection([{ owner: 'Ghost', sharingState: 0, layer: 0, alpha: 0 }]);
ok('invisible windows ignored', cp.protected === false, cp);
cp = cu.parseContentProtection(null);
ok('null input → empty verdict', cp.protected === false && cp.count === 0);

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — key-focus + permission parsers');
// ---------------------------------------------------------------------------
eq('key focus true', cu.parseKeyFocus('true'), { secureInput: true, unknown: false });
eq('key focus 1', cu.parseKeyFocus(1), { secureInput: true, unknown: false });
eq('key focus json', cu.parseKeyFocus('{"secureInput":true}'), { secureInput: true, unknown: false });
eq('key focus false', cu.parseKeyFocus('false'), { secureInput: false, unknown: false });
eq('key focus garbage', cu.parseKeyFocus('huh'), { secureInput: false, unknown: true });
eq('key focus empty', cu.parseKeyFocus(''), { secureInput: false, unknown: true });

let pp = cu.parsePermissionProbe({ screenRecording: true, accessibility: true });
ok('both granted', pp.ok === true && pp.missing.length === 0, pp);
pp = cu.parsePermissionProbe({ screenRecording: false, accessibility: true });
ok('screen recording missing', pp.ok === false && pp.missing[0] === 'Screen Recording', pp);
pp = cu.parsePermissionProbe('{"screenRecording":false,"accessibility":false}');
ok('parses a JSON string', pp.missing.length === 2, pp);
ok('hint names both', /Screen Recording and Accessibility/.test(cu.permissionHint(['Screen Recording', 'Accessibility'])));
ok('hint when all granted', /granted/.test(cu.permissionHint([])));

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — side panel geometry');
// ---------------------------------------------------------------------------
cu.reset();
const p0 = cu.panelState();
eq('default panel pinned + hidden', [p0.pinned, p0.visible], [true, false]);
cu.sidePanelMove({ x: 300, y: 200 });
eq('absolute move', [cu.panelState().x, cu.panelState().y], [300, 200]);
cu.sidePanelMove({ dx: 40, dy: -25 });
eq('relative move', [cu.panelState().x, cu.panelState().y], [340, 175]);
cu.sidePanelUnpin();
ok('unpin', cu.panelState().pinned === false);
cu.sidePanelPin();
ok('pin', cu.panelState().pinned === true);
cu.sidePanelVisibility(true);
ok('visibility set', cu.panelState().visible === true);

// ---------------------------------------------------------------------------
console.log('\ncomputeruse — dispatcher contract');
// ---------------------------------------------------------------------------
(async () => {
  cu.reset();
  let d = await cu.invoke('computer:request_access', {});
  ok('dispatch request_access pending', d.ok && d.pending, d);
  d = await cu.invoke('computer:request_teach_access', {});
  ok('dispatch request_teach_access → teach', d.requested === 'teach_access', d);

  d = await cu.invoke('cu:mask_rects', { mask: { x: 5, y: 5, w: 50, h: 50 } });
  ok('dispatch mask_rects add', d.ok && d.masks.length === 1, d);
  d = await cu.invoke('cu:mask_rects', { clear: true });
  ok('dispatch mask_rects clear', d.ok && d.masks.length === 0, d);

  d = await cu.invoke('cu:mask_rects', {});
  ok('mask_rects with no args lists', Array.isArray(d.masks), d);

  d = await cu.invoke('cu:nope', {});
  ok('unknown channel is an error, not a throw', d.ok === false && /Unknown/.test(d.error), d);

  // These need no Electron and no permission: they must always answer.
  d = await cu.invoke('cu:side_panel_move', { x: 11, y: 22 });
  ok('side_panel_move', d.ok && d.panel.x === 11, d);
  d = await cu.invoke('cu:side_panel_unpin', { pin: false });
  ok('side_panel_unpin', d.ok && d.panel.pinned === false, d);
  d = await cu.invoke('cu:side_panel_unpin', { pin: true });
  ok('side_panel_unpin re-pins', d.ok && d.panel.pinned === true, d);

  // save_panel_probe / content_protection / key_focus probe the real OS, so the
  // dispatcher is exercised here only on paths that need neither Electron nor a
  // TCC grant (getSources answers a structured error without Electron).
  d = await cu.invoke('cu:get_sources', {});
  ok('get_sources without Electron is a clean error', d.ok === false && Array.isArray(d.sources), d);

  d = await cu.invoke('cu:mask_rects');
  ok('mask_rects with no payload at all', d && Array.isArray(d.masks), d);

  console.log('\n' + pass + ' assertions passed');
  if (process.exitCode) console.log('FAILED');
  else console.log('OK');
})();
