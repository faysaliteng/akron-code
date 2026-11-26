'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const COMP_PATH = path.join(ROOT, 'src', 'components', 'NotificationCenter.jsx');
const APP_PATH = path.join(ROOT, 'src', 'App.jsx');

function loadNotificationExports() {
  const src = fs.readFileSync(COMP_PATH, 'utf8');
  const out = esbuild.transformSync(src, {
    loader: 'jsx',
    format: 'cjs',
    target: 'node20',
  });
  const mod = { exports: {} };
  const reactStub = {
    default: { createElement: () => null },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  const fn = new Function('require', 'module', 'exports', out.code);
  fn((id) => (id === 'react' ? reactStub : require(id)), mod, mod.exports);
  return mod.exports;
}

const {
  STORAGE_KEY,
  MAX_NOTIFICATIONS,
  TOAST_DURATION_MS,
  classifyNotification,
  appendNotificationEntry,
  formatRelativeTime,
} = loadNotificationExports();

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   - ' + name);
  } catch (e) {
    fail++;
    console.error('  FAIL - ' + name + ': ' + (e && e.stack ? e.stack : e));
  }
}

console.log('\nNotificationCenter unit & wiring verification');

test('constants & classification rules', () => {
  assert.strictEqual(STORAGE_KEY, 'autobot:notifications:v1');
  assert.strictEqual(MAX_NOTIFICATIONS, 200);
  assert.strictEqual(TOAST_DURATION_MS, 3800);

  const orch = classifyNotification('Left 5 orchestrator models out of this turn — a, b');
  assert.strictEqual(orch.kind, 'warning');
  assert.strictEqual(orch.category, 'Orchestrator');

  const ctx = classifyNotification('Compacted 3 earlier turns mid-run to keep inside context window');
  assert.strictEqual(ctx.kind, 'warning');
  assert.strictEqual(ctx.category, 'Context');

  const ok = classifyNotification('✅ Exported to /tmp/chat.md');
  assert.strictEqual(ok.kind, 'success');
  assert.strictEqual(ok.text, 'Exported to /tmp/chat.md');

  const err = classifyNotification('❌ Save failed: permission denied');
  assert.strictEqual(err.kind, 'error');
  assert.strictEqual(err.category, 'Error');
  assert.strictEqual(err.text, 'Save failed: permission denied');

  const art = classifyNotification('Artifact created: app.js (view in Artifacts panel)');
  assert.strictEqual(art.kind, 'info');
  assert.strictEqual(art.category, 'Artifact');
});

test('appendNotificationEntry coalesces duplicate consecutive items & tracks unread', () => {
  let list = [];
  const t1 = 1_700_000_000_000;
  let res = appendNotificationEntry(list, 'Left 5 orchestrator models out of this turn — x', {}, t1);
  list = res.list;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].read, false);
  assert.strictEqual(list[0].count, 1);

  // Mark read, then repeat identical text -> coalesces, increments count, restores unread
  list = list.map((it) => ({ ...it, read: true }));
  res = appendNotificationEntry(list, 'Left 5 orchestrator models out of this turn — x', {}, t1 + 5000);
  list = res.list;
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].count, 2);
  assert.strictEqual(list[0].read, false);

  // Distinct item prepends on top
  res = appendNotificationEntry(list, 'Artifact created: index.html', {}, t1 + 9000);
  list = res.list;
  assert.strictEqual(list.length, 2);
  assert.strictEqual(list[0].category, 'Artifact');
  assert.strictEqual(list[1].count, 2);
});

test('appendNotificationEntry caps log at MAX_NOTIFICATIONS', () => {
  let list = [];
  for (let i = 0; i < MAX_NOTIFICATIONS + 15; i++) {
    list = appendNotificationEntry(list, `Event #${i}`, {}, 1_700_000_000_000 + i * 1000).list;
  }
  assert.strictEqual(list.length, MAX_NOTIFICATIONS);
  assert.strictEqual(list[0].text, `Event #${MAX_NOTIFICATIONS + 14}`);
});

test('formatRelativeTime formats seconds, minutes, hours cleanly', () => {
  const now = 1_700_000_100_000;
  assert.strictEqual(formatRelativeTime(now - 5_000, now), 'just now');
  assert.strictEqual(formatRelativeTime(now - 35_000, now), '35s ago');
  assert.strictEqual(formatRelativeTime(now - 5 * 60_000, now), '5m ago');
  assert.strictEqual(formatRelativeTime(now - 3 * 3600_000, now), '3h ago');
});

test('App.jsx mounts NotificationCenter in .titlebar and removes <ChatNoticeBar>', () => {
  const appSrc = fs.readFileSync(APP_PATH, 'utf8');
  assert.strictEqual(appSrc.includes('<ChatNoticeBar'), false, 'ChatNoticeBar JSX must be removed from App.jsx');
  const titlebarStart = appSrc.indexOf('<div className="titlebar">');
  assert(titlebarStart > -1, 'Missing .titlebar in App.jsx');
  const titlebarSlice = appSrc.slice(titlebarStart, titlebarStart + 2500);
  assert(titlebarSlice.includes('<NotificationCenter'), 'Expected <NotificationCenter inside .titlebar');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
