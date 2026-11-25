'use strict';
// Extension host: the 11 `extension-host:*` channels, the chrome.* namespace
// surface, permission gating, page serving rules, event/port plumbing and the
// agentic-op whitelist. Pure Node — no Electron, no network, no browser.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const h = require('../electron/extensionhost');

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

// ---------------------------------------------------------------------------
console.log('\nextensionhost — channels');
// ---------------------------------------------------------------------------
const channelNames = Object.values(h.CHANNELS).slice().sort();
eq('11 channels', channelNames.length, 11);
for (const name of ['extension-host:invoke', 'extension-host:serves-page', 'extension-host:listen',
  'extension-host:event', 'extension-host:event-ack', 'extension-host:installed',
  'extension-host:report-again', 'extension-host:port-to-host', 'extension-host:port-to-context',
  'extension-host:agentic-call', 'extension-host:agentic-reply']) {
  ok(`channel ${name}`, channelNames.includes(name));
}
ok('canonicalChannel(short)', h.canonicalChannel('installed') === 'extension-host:installed');
ok('canonicalChannel(full)', h.canonicalChannel('extension-host:port-to-host') === 'extension-host:port-to-host');
ok('canonicalChannel(camel)', h.canonicalChannel('servesPage') === 'extension-host:serves-page');
ok('canonicalChannel(bogus) → null', h.canonicalChannel('nope') === null);

// ---------------------------------------------------------------------------
console.log('\nextensionhost — namespace surface');
// ---------------------------------------------------------------------------
const seen = new Set(h.NAMESPACES.map((n) => n.namespace));
['tabs', 'windows', 'cookies', 'storage', 'runtime', 'notifications', 'action', 'alarms',
  'i18n', 'permissions', 'management', 'commands', 'contextMenus', 'debugger', 'scripting',
  'sidePanel', 'tabGroups', 'extension', 'extensionPageClipboard'].forEach((ns) => {
  ok(`namespace ${ns}`, seen.has(ns));
});
ok('namespaces are unique', seen.size === h.NAMESPACES.length, { unique: seen.size, total: h.NAMESPACES.length });
ok('40+ namespaces (Desktop ships 40)', h.NAMESPACES.length >= 40, h.NAMESPACES.length);
ok('every namespace declares methods or events', h.NAMESPACES.every((n) => n.methods.length || n.events.length));

// ---------------------------------------------------------------------------
console.log('\nextensionhost — argument guard rails');
// ---------------------------------------------------------------------------
ok('small args ok', h.assertArgs({ a: 1, b: ['x'] }) === true);
let threw = null;
try { h.assertArgs({ f: () => 1 }); } catch (e) { threw = e.message; }
ok('functions rejected', !!threw && /functions/.test(threw), threw);
threw = null;
try {
  let deep = {};
  let cur = deep;
  for (let i = 0; i < 40; i++) { cur.next = {}; cur = cur.next; }
  h.assertArgs(deep);
} catch (e) { threw = e.message; }
ok('deep nesting rejected', !!threw && /deeply/.test(threw), threw);
eq('sanitizeError strips markup', h.sanitizeError(new Error('<html><body>boom</body></html>')), 'boom');
eq('sanitizeError one line', h.sanitizeError(new Error('line one\nline two')), 'line one');
ok('sanitizeError never empty', h.sanitizeError(new Error('')) === 'extension call failed');

// ---------------------------------------------------------------------------
console.log('\nextensionhost — paths');
// ---------------------------------------------------------------------------
ok('valid id', h.normalizeExtensionId('a'.repeat(32)) === 'a'.repeat(32));
ok('id with non a-p chars rejected', h.normalizeExtensionId('z'.repeat(32)) === null);
ok('id wrong length rejected', h.normalizeExtensionId('abc') === null);
ok('parseApi splits', JSON.stringify(h.parseApi('storage.local.get')) === JSON.stringify({ namespace: 'storage', path: ['local', 'get'] }));
ok('parseApi unknown ns', h.parseApi('fake.thing') === null);
ok('parseApi needs a method', h.parseApi('tabs') === null);
eq('parseExtensionUrl path', h.parseExtensionUrl(`chrome-extension://${'a'.repeat(32)}/popup/index.html`).path, 'popup/index.html');
ok('parseExtensionUrl rejects http', h.parseExtensionUrl('https://example.com/x') === null);
ok('safe path allows nested', h.safeExtensionPath('a/b.js') === 'a/b.js');
ok('safe path rejects traversal', h.safeExtensionPath('../secrets') === null);
ok('safe path rejects encoded dot', h.safeExtensionPath('a/%2e%2e/b') === null);
ok('safe path rejects NUL', h.safeExtensionPath('a\u0000b') === null);
ok('safe path rejects trailing dot', h.safeExtensionPath('a./b') === null);
ok('safe path rejects backslash', h.safeExtensionPath('a\\b') === null);
ok('glob ** matches nested', h.globToRegExp('pub/**').test('pub/a/b.js'));
ok('glob * stops at slash', !h.globToRegExp('pub/*.js').test('pub/a/b.js'));
ok('match pattern https', h.matchPatternToRegExp('https://example.com/*').test('https://example.com/x?y=1'));
ok('match pattern subdomain', h.matchPatternToRegExp('https://*.example.com/*').test('https://a.example.com/x'));

// ---------------------------------------------------------------------------
console.log('\nextensionhost — host against a real extension folder');
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-ext-'));
const extId = 'abcdefghijklmnopabcdefghijklmnop';
const extDir = path.join(root, 'extensions', extId);
fs.mkdirSync(path.join(extDir, 'popup'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'pub'), { recursive: true });
fs.mkdirSync(path.join(extDir, 'private'), { recursive: true });
const manifest = {
  manifest_version: 3,
  name: 'Helio Probe',
  version: '1.2.3',
  description: 'test extension',
  permissions: ['storage', 'tabs', 'notifications', 'contextMenus'],
  host_permissions: ['https://example.com/*'],
  background: { service_worker: 'sw.js' },
  action: { default_popup: 'popup/index.html' },
  commands: { _execute_action: { suggested_key: { default: 'Ctrl+Shift+Y' }, description: 'Open' } },
  web_accessible_resources: [{ resources: ['pub/*'], matches: ['https://example.com/*'] }],
};
fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
fs.writeFileSync(path.join(extDir, 'popup', 'index.html'), '<!doctype html><title>probe</title>');
fs.writeFileSync(path.join(extDir, 'pub', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
fs.writeFileSync(path.join(extDir, 'private', 'secret.txt'), 'nope');

const host = h.createExtensionHost({ dataDir: root });
ok('host discovers the extension', host.extensions.size === 1, host.extensions.size);

const inst = host.installed(extId);
ok('installed ok', inst.ok === true, inst);
ok('installed name', inst.name === 'Helio Probe', inst.name);
ok('installed version', inst.version === '1.2.3', inst.version);
ok('installed manifest v3', inst.manifestVersion === 3);
ok('tabs permission advertised as warning', inst.permissions.some((p) => p.permission === 'tabs' && p.level === 'warning'), inst.permissions);
ok('declares a background worker', inst.hasBackground === true);
const nsNames = inst.namespaces.map((n) => n.namespace);
ok('namespaces include storage', nsNames.includes('storage'), nsNames.length);
ok('namespaces include tabs', nsNames.includes('tabs'));
ok('namespaces exclude cookies (not granted)', !nsNames.includes('cookies'));
ok('namespaces include commands (manifest key present)', nsNames.includes('commands'));
ok('namespaces exclude omnibox (manifest key absent)', !nsNames.includes('omnibox'));

ok('unknown extension reports cleanly', host.installed('q'.repeat(32)).ok === false);
ok('bad id rejected', host.installed('nope').ok === false);

// ---------------------------------------------------------------------------
console.log('\nextensionhost — serve-page');
// ---------------------------------------------------------------------------
const ownPage = host.servePage({ extensionId: extId, path: 'popup/index.html' });
ok('serves own page', ownPage.ok === true, ownPage);
ok('page mime is html', /^text\/html/.test(ownPage.mime), ownPage.mime);
ok('page body is a string', typeof ownPage.body === 'string' && ownPage.body.includes('probe'));

const fromUrl = host.servePage(`chrome-extension://${extId}/popup/index.html`);
ok('serves by chrome-extension URL', fromUrl.ok === true && fromUrl.path === 'popup/index.html', fromUrl);

const waived = host.servePage({ extensionId: extId, path: 'pub/logo.svg', initiatorUrl: 'https://example.com/app' });
ok('web accessible resource served to a matching origin', waived.ok === true, waived);
ok('svg mime', waived.mime === 'image/svg+xml', waived.mime);

const blocked = host.servePage({ extensionId: extId, path: 'private/secret.txt', initiatorUrl: 'https://example.com/app' });
ok('non-declared resource blocked for a web origin', blocked.ok === false && blocked.status === 403, blocked);

const ownPrivate = host.servePage({ extensionId: extId, path: 'private/secret.txt' });
ok('extension can read its own private file', ownPrivate.ok === true, ownPrivate);

const traversal = host.servePage({ extensionId: extId, path: '../../etc/passwd' });
ok('traversal rejected', traversal.ok === false, traversal);
const missing = host.servePage({ extensionId: extId, path: 'popup/missing.html' });
ok('missing file → 404', missing.ok === false && missing.status === 404, missing);
ok('non-extension scheme rejected', host.servePage('https://evil.test/x').ok === false);

// ---------------------------------------------------------------------------
console.log('\nextensionhost — invoke');
// ---------------------------------------------------------------------------
(async () => {
  const setRes = await host.invoke('storage.local.set', [{ theme: 'dark', n: 2 }], { extensionId: extId });
  ok('storage.local.set ok', setRes.ok === true, setRes);
  const getRes = await host.invoke('storage.local.get', ['theme'], { extensionId: extId });
  eq('storage round trip', getRes.value, { theme: 'dark' });
  const allRes = await host.invoke('storage.local.get', [null], { extensionId: extId });
  eq('storage.get(null) returns everything', allRes.value, { theme: 'dark', n: 2 });
  const bytes = await host.invoke('storage.local.getBytesInUse', [null], { extensionId: extId });
  ok('getBytesInUse is a number', typeof bytes.value === 'number' && bytes.value > 0, bytes);
  ok('storage persists to disk', JSON.parse(fs.readFileSync(path.join(root, 'extension-storage.json'), 'utf8')).local.theme === 'dark');

  const manifestRes = await host.invoke('runtime.getManifest', [], { extensionId: extId });
  ok('runtime.getManifest returns the manifest', manifestRes.value.name === 'Helio Probe');
  const urlRes = await host.invoke('runtime.getURL', ['pub/logo.svg'], { extensionId: extId });
  ok('runtime.getURL builds a chrome-extension URL', urlRes.value === `chrome-extension://${extId}/pub/logo.svg`, urlRes.value);
  const platform = await host.invoke('runtime.getPlatformInfo', [], { extensionId: extId });
  ok('runtime.getPlatformInfo has os/arch', !!platform.value.os && !!platform.value.arch, platform.value);

  const perms = await host.invoke('permissions.getAll', [], { extensionId: extId });
  ok('permissions.getAll lists storage', perms.value.permissions.includes('storage'), perms.value);
  ok('permissions.getAll lists origins', perms.value.origins.includes('https://example.com/*'), perms.value);
  const contains = await host.invoke('permissions.contains', [{ permissions: ['tabs'] }], { extensionId: extId });
  ok('permissions.contains true for granted', contains.value === true);

  const cmds = await host.invoke('commands.getAll', [], { extensionId: extId });
  ok('commands.getAll from manifest', cmds.value.length === 1 && cmds.value[0].name === '_execute_action', cmds.value);

  const badge = await host.invoke('action.setBadgeText', [{ text: '3' }], { extensionId: extId });
  ok('action.setBadgeText ok', badge.ok === true);
  const badgeGet = await host.invoke('action.getBadgeText', [], { extensionId: extId });
  ok('action.getBadgeText reads back', badgeGet.value === '3', badgeGet.value);

  const i18n = await host.invoke('i18n.getUILanguage', [], { extensionId: extId });
  ok('i18n.getUILanguage answers', typeof i18n.value === 'string' && i18n.value.length >= 2);

  const denied = await host.invoke('cookies.getAll', [{}], { extensionId: extId });
  ok('cookies denied without permission', denied.ok === false && /cookies/.test(denied.message), denied);

  const unknownApi = await host.invoke('nope.nope', [], { extensionId: extId });
  ok('unknown namespace → clean message', unknownApi.ok === false && /Unknown API/.test(unknownApi.message), unknownApi);

  const bridged = await host.invoke('instanceID.getID', [], { extensionId: extId });
  ok('non-native namespace without bridge → friendly message', bridged.ok === false && /Chrome extension/.test(bridged.message), bridged);

  const badArgs = await host.invoke('storage.local.get', [{ fn: () => 1 }], { extensionId: extId });
  ok('bad args → ok:false, never throws', badArgs.ok === false && /functions/.test(badArgs.message), badArgs);

  // -------------------------------------------------------------------------
  console.log('\nextensionhost — events, acks, ports');
  // -------------------------------------------------------------------------
  const sent = [];
  host.attachSink({ send: (channel, payload) => sent.push({ channel, payload }) });
  ok('sink attached', host.sinkCount() === 1);

  const listenRes = host.listen(extId, 'runtime.onMessage');
  ok('listen accepted', listenRes.ok === true && !!listenRes.listenerId, listenRes);
  ok('listener registered', host.listenerCount() === 1);
  ok('listen rejects unknown event', host.listen(extId, 'runtime.nope').ok === false);
  ok('listen rejects unknown namespace', host.listen(extId, 'nope.onMessage').ok === false);

  const ackId = host.deliverEvent('runtime.onMessage', [{ hello: 1 }], { extensionId: extId });
  const evt = sent.find((s) => s.channel === h.CHANNELS.event);
  ok('event reached the sink', !!evt, sent.map((s) => s.channel));
  ok('event frame carries the ack id', evt && evt.payload.ackId === ackId, evt && evt.payload);
  ok('event frame carries the args', evt && evt.payload.args[0].hello === 1);
  const ackRes = host.ack(ackId, null);
  ok('ack accepted', ackRes.ok === true, ackRes);
  ok('ack is idempotent (late ack tolerated)', host.ack(ackId, 'listener-error').ok === true);

  const again = host.reportAgain(extId);
  ok('report-again emits runtime.onInstalled', again.ok === true && sent.some((s) => s.channel === h.CHANNELS.event && s.payload.eventName === 'runtime.onInstalled'), again);

  const port = host.portToHost(extId, 'sidepanel');
  ok('port-to-host opens a port', port.ok === true && !!port.portId, port);
  ok('port-to-host notified the sink', sent.some((s) => s.channel === h.CHANNELS.portToHost && s.payload.portId === port.portId));
  const pmsg = host.portToContext(port.portId, { msg: 'hi' });
  ok('port-to-context delivers', pmsg.ok === true && sent.some((s) => s.channel === h.CHANNELS.portToContext && s.payload.message.msg === 'hi'), pmsg);
  ok('port-to-context rejects unknown port', host.portToContext('nope', 1).ok === false);
  ok('port-to-context caps message size', host.portToContext(port.portId, 'x'.repeat(h.MAX_PORT_MESSAGE + 10)).ok === false);
  ok('closePort', host.closePort(port.portId).ok === true);

  // -------------------------------------------------------------------------
  console.log('\nextensionhost — agentic ops');
  // -------------------------------------------------------------------------
  eq('3 agentic ops whitelisted', h.AGENTIC_OPS.length, 3);
  ok('enable is whitelisted', h.isAgenticOp('agenticMode.enable'));
  ok('fillCredential is whitelisted', h.isAgenticOp('agenticAutofill.fillCredential'));
  ok('unknown op is not', !h.isAgenticOp('agenticMode.selfDestruct'));
  const deniedOp = await host.agenticCall('agenticMode.selfDestruct', {});
  ok('unknown op rejected with reason op', deniedOp.ok === false && deniedOp.reason === 'op', deniedOp);
  const noBridge = await host.agenticCall('agenticMode.enable', {});
  ok('no bridge → reason unavailable', noBridge.ok === false && noBridge.reason === 'unavailable', noBridge);
  const wrongExt = await host.agenticCall('agenticMode.enable', {}, { extensionId: extId });
  ok('non-agent extension rejected', wrongExt.ok === false && wrongExt.reason === 'extension', wrongExt);
  ok('agent extension id is the Claude id', h.AGENT_EXTENSION_IDS[0] === 'gejiddohjgogedgjnonbofjigllpkmbf');
  ok('agenticReply on an unknown call fails cleanly', host.agenticReply('nope', { value: 1 }).ok === false);

  // -------------------------------------------------------------------------
  console.log('\nextensionhost — IPC wiring shape');
  // -------------------------------------------------------------------------
  const handled = [];
  const onned = [];
  const fakeIpc = {
    handle: (c) => handled.push(c),
    on: (c) => onned.push(c),
  };
  h.registerIpc(fakeIpc, host);
  eq('registerIpc handles 8 channels', handled.length, 8);
  eq('registerIpc listens on 3 channels', onned.length, 3);
  ok('invoke is handled', handled.includes(h.CHANNELS.invoke));
  ok('event-ack is a listener', onned.includes(h.CHANNELS.eventAck));
  ok('port-to-context is a listener', onned.includes(h.CHANNELS.portToContext));
  ok('agentic-reply is a listener', onned.includes(h.CHANNELS.agenticReply));

  // -------------------------------------------------------------------------
  console.log('\nextensionhost — bridge frame handling (no sockets)');
  // -------------------------------------------------------------------------
  host.onBridgeFrame(JSON.stringify({ type: 'event', eventName: 'runtime.onMessage', args: [{ ping: 1 }] }));
  ok('bridge event becomes a delivered event', sent.some((s) => s.channel === h.CHANNELS.event && s.payload.args[0].ping === 1));
  host.onBridgeFrame('not json at all');
  ok('garbage bridge frame is ignored', true);

  // -------------------------------------------------------------------------
  console.log('\nextensionhost — page schemes (hosted fallback) and sinks');
  // -------------------------------------------------------------------------
  ok('helio-extension is a page scheme', h.PAGE_SCHEMES.includes('helio-extension:'));
  ok('autobot-extension is a page scheme', h.PAGE_SCHEMES.includes('autobot-extension:'));
  const helioOwn = host.servePage({ extensionId: extId, path: 'private/secret.txt', initiatorUrl: `helio-extension://${extId}/popup/index.html` });
  ok('helio-extension page reads its own private file', helioOwn.ok === true, helioOwn);
  const helioOther = host.servePage({ extensionId: extId, path: 'private/secret.txt', initiatorUrl: `helio-extension://${'b'.repeat(32)}/popup/index.html` });
  ok('another extension cannot read private files', helioOther.ok === false && helioOther.status === 403, helioOther);
  const webStillBlocked = host.servePage({ extensionId: extId, path: 'private/secret.txt', initiatorUrl: 'https://evil.test/' });
  ok('helio scheme did not weaken web-access rules', webStillBlocked.ok === false && webStillBlocked.status === 403, webStillBlocked);
  ok('parseExtensionUrl accepts helio-extension', (() => {
    const p = h.parseExtensionUrl(`helio-extension://${extId}/popup/index.html`);
    return p && p.extensionId === extId && p.path === 'popup/index.html';
  })());
  ok('parseExtensionUrl rejects credentials', h.parseExtensionUrl(`helio-extension://u:p@${extId}/x`) === null);
  ok('sinks counted', host.sinkCount() === 1, host.sinkCount());
  const extraSink = { send: () => {} };
  host.attachSink(extraSink);
  ok('two sinks after attach', host.sinkCount() === 2, host.sinkCount());
  ok('detachSink removes one', host.detachSink(extraSink) === true && host.sinkCount() === 1, host.sinkCount());

  // -------------------------------------------------------------------------
  console.log('\nextensionhost — runtime.sendMessage / storage areas / commands');
  // -------------------------------------------------------------------------
  sent.length = 0;
  const sendRes = await host.invoke('runtime.sendMessage', [{ ping: 'hello' }], { extensionId: extId, page: 'popup/index.html' });
  ok('runtime.sendMessage resolves', sendRes.ok === true, sendRes);
  const msgFrame = sent.find((s) => s.channel === h.CHANNELS.event && s.payload.eventName === 'runtime.onMessage');
  ok('sendMessage emits runtime.onMessage', !!msgFrame, sent.map((s) => s.payload.eventName));
  ok('onMessage args are (message, sender)', !!msgFrame && msgFrame.payload.args[0].ping === 'hello' && msgFrame.payload.args[1].id === extId, msgFrame && msgFrame.payload.args);
  ok('sender origin points at the extension', !!msgFrame && msgFrame.payload.args[1].origin === `chrome-extension://${extId}`);

  for (const area of ['local', 'sync', 'session', 'managed']) {
    const w = await host.invoke(`storage.${area}.set`, [{ [area]: 1 }], { extensionId: extId });
    const r = await host.invoke(`storage.${area}.get`, [null], { extensionId: extId });
    ok(`storage.${area} round trip`, w.ok === true && r.ok === true && r.value[area] === 1, { w, r });
  }
  const syncOnly = await host.invoke('storage.sync.get', [null], { extensionId: extId });
  ok('storage areas are isolated', syncOnly.value.local === undefined && syncOnly.value.sync === 1, syncOnly.value);

  const cmdList = await host.invoke('commands.getAll', [], { extensionId: extId });
  ok('commands.getAll returns the manifest commands', cmdList.ok === true && Array.isArray(cmdList.value) && cmdList.value.length >= 1, cmdList);
  const permHas = await host.invoke('permissions.contains', [{ permissions: ['storage'] }], { extensionId: extId });
  ok('permissions.contains(storage) is true', permHas.ok === true && permHas.value === true, permHas);
  const permNo = await host.invoke('permissions.contains', [{ permissions: ['downloads'] }], { extensionId: extId });
  ok('permissions.contains(downloads) is false', permNo.ok === true && permNo.value === false, permNo);

  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}

  console.log(`\n=== RESULT: ${pass} passed${process.exitCode ? ' (with failures)' : ', 0 failed'} ===`);
})();
