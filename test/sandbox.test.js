'use strict';
// Tests for the sandbox/network policy engine (electron/sandbox.js) — the
// Desktop `sandbox.*` / `network.*` parity surface.
//
// The engine reads `~/.autobot/settings.json` through store.js, so every test
// stubs store.getSettings() to avoid touching the real user config.

const path = require('path');
const os = require('os');
const fs = require('fs');
const store = require('../electron/store');
const sandbox = require('../electron/sandbox');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

const realGet = store.getSettings;
function withSettings(s) { store.getSettings = () => s; }
function reset() { store.getSettings = realGet; }

const home = os.homedir();

// ── defaults: disabled means allow everything ────────────────────────────────
withSettings({});
ok('disabled: read allowed', sandbox.isReadAllowed(path.join(home, 'x')) === true);
ok('disabled: write allowed', sandbox.isWriteAllowed('/etc/passwd') === true);
ok('disabled: host allowed', sandbox.isHostAllowed('https://example.com') === true);

// ── denyRead / denyWrite ─────────────────────────────────────────────────────
withSettings({
  sandbox: {
    enabled: true,
    filesystem: { denyRead: [path.join(home, 'secret')], denyWrite: ['/tmp/out'], allowRead: [], allowManagedReadPathsOnly: false },
  },
});
const deny = sandbox.isReadAllowed(path.join(home, 'secret', 'keys.txt'));
ok('denyRead blocks subpath', deny !== true && /denied/.test(deny.reason), JSON.stringify(deny));
ok('denyRead allows sibling', sandbox.isReadAllowed(path.join(home, 'public', 'a.txt')) === true);
const dw = sandbox.isWriteAllowed('/tmp/out/x.bin');
ok('denyWrite blocks subpath', dw !== true && /denied/.test(dw.reason));
ok('denyWrite allows other', sandbox.isWriteAllowed('/tmp/other/x.bin') === true);

// ── allowRead restricts to the list ──────────────────────────────────────────
withSettings({
  sandbox: { enabled: true, filesystem: { allowRead: [path.join(home, 'proj')], denyRead: [], denyWrite: [], allowManagedReadPathsOnly: false } },
});
ok('allowRead permits inside', sandbox.isReadAllowed(path.join(home, 'proj', 'x')) === true);
const outside = sandbox.isReadAllowed(path.join(home, 'elsewhere', 'x'));
ok('allowRead denies outside', outside !== true && /outside allow-list/.test(outside.reason));

// ── network allow/deny ───────────────────────────────────────────────────────
withSettings({ network: { allowedDomains: ['*.example.com', 'api.test'], deniedDomains: ['evil.example.com'] } });
ok('network: allowed wildcard', sandbox.isHostAllowed('https://a.example.com/x') === true);
ok('network: apex matches wildcard', sandbox.isHostAllowed('https://example.com') === true);
ok('network: explicit allow', sandbox.isHostAllowed('https://api.test/v1') === true);
ok('network: unsupported host denied', sandbox.isHostAllowed('https://other.org') !== true);
const evil = sandbox.isHostAllowed('https://evil.example.com');
ok('network: explicit deny beats allow', evil !== true && /denied/.test(evil.reason));
withSettings({});
ok('network: no list = allow all', sandbox.isHostAllowed('https://anything.dev') === true);

// ── wrapShell ────────────────────────────────────────────────────────────────
const expectedPosix = require('../electron/paths').defaultPosixShell();
withSettings({ sandbox: { enabled: false } });
const plain = sandbox.wrapShell('echo hi');
ok('wrapShell disabled → posix shell', plain.file === expectedPosix && plain.sandboxed === false);

withSettings({ sandbox: { enabled: true, filesystem: { denyRead: [path.join(home, 'secret')], denyWrite: [], allowRead: [], allowManagedReadPathsOnly: false } } });
const wrapped = sandbox.wrapShell('cat ~/x');
if (process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec')) {
  ok('wrapShell enabled → sandbox-exec', wrapped.file === '/usr/bin/sandbox-exec' && wrapped.sandboxed === true);
  ok('profile carries deny rule', wrapped.args[1].includes('file-read*') && wrapped.args[1].includes('secret'));
} else {
  ok('wrapShell non-darwin unsandboxed', wrapped.sandboxed === false);
}
const bypass = sandbox.wrapShell('rm -rf ~/x', { dangerouslyDisableSandbox: true });
ok('dangerouslyDisableSandbox bypasses', bypass.file === expectedPosix);

// ── describe() ───────────────────────────────────────────────────────────────
withSettings({ sandbox: { enabled: true, filesystem: { denyRead: ['/tmp/x'], allowRead: [], denyWrite: [], allowManagedReadPathsOnly: false }, network: { allowedDomains: ['a.com'], deniedDomains: [], allowManagedDomainsOnly: false } } });
const d = sandbox.describe();
ok('describe reports enabled', d.enabled === true);
ok('describe merges domains', Array.isArray(d.network.allowedDomains) && d.network.allowedDomains.includes('a.com'));
ok('describe has filesystem block', !!d.filesystem && Array.isArray(d.filesystem.denyRead));

reset();
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
