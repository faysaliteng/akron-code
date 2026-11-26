'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const push = require('../electron/push-channels');
const remote = require('../electron/remote-server');
const { createPermissionGate } = require('../electron/perm-gate');

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ok   - ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.error('  FAIL - ' + name + ': ' + (e && e.stack ? e.stack : e));
  }
}

function httpGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

(async () => {
  console.log('\nPhase 6 Mobile Push Channels, Outbound Relay, Kill Switch & UI Verification');

  await test('6-digit pairing validates one-time code, rejects replay, and rate-limiter caps burst push alerts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-push-'));
    const storePath = path.join(tmp, 'push.json');
    try {
      const p1 = push.startPairing({ storePath, nowMs: 1000 });
      assert.ok(/^\d{6}$/.test(p1.code));

      const bad = push.completePairing('000000', { label: 'Phone' }, { storePath, nowMs: 2000 });
      assert.strictEqual(bad.ok, false);

      const good = push.completePairing(p1.code, { label: 'iPhone', channel: 'ntfy' }, { storePath, nowMs: 2000 });
      assert.strictEqual(good.ok, true);
      assert.strictEqual(good.config.pairedDevices.length, 1);

      const replay = push.completePairing(p1.code, { label: 'Replay' }, { storePath, nowMs: 2500 });
      assert.strictEqual(replay.ok, false, 'One-time pairing code must not replay');

      push.saveConfig({
        enabled: true,
        ntfy: { enabled: true, topicUrl: 'https://ntfy.example/akron' },
        webhook: { enabled: true, url: 'https://hooks.example/akron', secret: 's3cr3t' },
      }, storePath);

      const limiter = push.createRateLimiter({ maxPerWindow: 2, windowMs: 60000 });
      const sentUrls = [];
      const transport = async (url, headers, body) => {
        sentUrls.push({ url, headers, body });
        return { ok: true, status: 200 };
      };

      const d1 = await push.sendPushAlert({ kind: 'permission', title: 'Approve', body: 'Bash git status', shortId: 'ab12cd', storePath, rateLimiter: limiter, transportFn: transport, nowMs: 100 });
      assert.strictEqual(d1.ok, true);
      assert.strictEqual(d1.deliveries.length, 2);

      const d2 = await push.sendPushAlert({ kind: 'permission', title: 'Approve 2', body: 'Edit', shortId: 'ef34gh', storePath, rateLimiter: limiter, transportFn: transport, nowMs: 200 });
      assert.strictEqual(d2.ok, true);

      const d3 = await push.sendPushAlert({ kind: 'permission', title: 'Approve 3', body: 'Spam', storePath, rateLimiter: limiter, transportFn: transport, nowMs: 300 });
      assert.strictEqual(d3.ok, false);
      assert.strictEqual(d3.rateLimited, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('shortId push commands approve/deny live permGate prompts cleanly', async () => {
    const events = [];
    const gate = createPermissionGate();
    const p1 = gate.prompt({ runId: 'r1', convId: 'c1', toolName: 'Bash', args: { command: 'npm test' }, emit: (e) => events.push(e) });
    const fullId1 = events[0].id;
    const shortId1 = push.registerShortPermission(fullId1);

    const a1 = push.handleInboundPushCommand(`approve ${shortId1}`, gate);
    assert.strictEqual(a1.ok, true);
    assert.strictEqual((await p1).allow, true);

    const p2 = gate.prompt({ runId: 'r1', convId: 'c1', toolName: 'Bash', args: { command: 'git push' }, emit: (e) => events.push(e) });
    const fullId2 = events.filter((e) => e.type === 'permission')[1].id;
    const shortId2 = push.registerShortPermission(fullId2);

    const a2 = push.handleInboundPushCommand(`deny ${shortId2} wait for CI first`, gate);
    assert.strictEqual(a2.ok, true);
    const res2 = await p2;
    assert.strictEqual(res2.allow, false);
    assert.strictEqual(res2.feedback, 'wait for CI first');
  });

  await test('remote.OFF kill switch blocks Remote Server HTTP (503) and immediately disconnects Outbound Relay', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-kill-'));
    const srv = remote.createRemoteServer({ port: 0, token: 'tok123', workspaceRoot: tmp, dataDir: tmp });
    try {
      const info = await srv.start();
      const pingOk = await httpGet(`${info.url}/v1/env/ping`, { Authorization: 'Bearer tok123' });
      assert.strictEqual(pingOk.status, 200);

      let closedReason = '';
      const relay = remote.createOutboundRelay({
        relayUrl: 'wss://relay.example/ws',
        token: 'tok123',
        dataDir: tmp,
        wsFactory: () => ({
          handlers: {},
          on(ev, fn) { this.handlers[ev] = fn; },
          send() {},
          close(_code, reason) { closedReason = reason || 'closed'; if (this.handlers.close) this.handlers.close(); },
          terminate() { closedReason = closedReason || 'terminated'; },
        }),
      });
      const connRes = relay.connect();
      assert.strictEqual(connRes.ok, true);

      // Engage kill switch -> creates remote.OFF + kills relay + blocks HTTP with 503
      const ks = remote.setKillSwitch(true, tmp);
      assert.strictEqual(ks.active, true);
      assert.ok(fs.existsSync(remote.killSwitchPath(tmp)));
      assert.strictEqual(closedReason, 'kill_switch');

      const pingBlocked = await httpGet(`${info.url}/v1/env/ping`, { Authorization: 'Bearer tok123' });
      assert.strictEqual(pingBlocked.status, 503);

      const blockedConnect = relay.connect();
      assert.strictEqual(blockedConnect.ok, false);
    } finally {
      await srv.stop();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
