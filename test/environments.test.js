'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const _isolatedEnvDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-env-cfg-'));
process.env.AUTOBOT_ENVIRONMENTS_FILE = path.join(_isolatedEnvDir, 'environments.json');
const { execFileSync } = require('node:child_process');
const WebSocket = require('ws');

const environments = require('../electron/environments');
const { createRemoteServer } = require('../electron/remote-server');
const tools = require('../electron/tools');
const ptyMod = require('../electron/ide/pty');

async function testSshConfigParsing() {
  const sample = `
# comment
Host *
  ServerAliveInterval 60

Host seventrip
  HostName 192.168.10.22
  User deploy
  Port 2222
  IdentityFile ~/.ssh/id_ed25519_seventrip

Host prod-box
  HostName prod.akronlogic.com
  User ubuntu
`;
  const parsed = environments.parseSshConfig(sample);
  assert.strictEqual(parsed.length, 2, 'Should parse 2 concrete SSH hosts and ignore wildcard');
  assert.strictEqual(parsed[0].name, 'seventrip');
  assert.strictEqual(parsed[0].host, '192.168.10.22');
  assert.strictEqual(parsed[0].username, 'deploy');
  assert.strictEqual(parsed[0].port, 2222);
  assert.strictEqual(parsed[1].host, 'prod.akronlogic.com');
  console.log('✓ 2.1 ~/.ssh/config parser');
}

async function testSecretIsolationAndRemoteServerE2E() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-env-test-'));
  const g = (...a) => execFileSync('git', a, { cwd: tmpDir, encoding: 'utf8' });
  g('init', '-b', 'main');
  g('config', 'user.email', 'test@akronlogic.com');
  g('config', 'user.name', 'Akron Test');
  fs.writeFileSync(path.join(tmpDir, 'hello.js'), 'const envMarker = "REMOTE_OK_123";\n', 'utf8');
  g('add', 'hello.js');
  g('commit', '-m', 'init');

  const secretToken = 'super-secret-remote-token-9988';
  const srv = createRemoteServer({ port: 0, host: '127.0.0.1', token: secretToken, workspaceRoot: tmpDir });
  const started = await srv.start();
  assert(started.ok && started.port > 0, 'Remote server started');

  let sshProfId = null;
  let remProfId = null;
  const prevActive = environments.getActive();
  try {
    // 1. Verify unauthorized access returns 401
    const unauth = await fetch(`${started.url}/v1/env/ping`, { headers: { Authorization: 'Bearer wrong' } });
    assert.strictEqual(unauth.status, 401, 'Unauthorized request must return 401');

    // 2. Save SSH + Remote profile and verify plaintext secrets are stripped from environments.json
    const sshSave = environments.saveSshProfile({
      name: 'test-ssh-box',
      host: '127.0.0.1',
      username: 'ubuntu',
      secret: 'top-secret-passphrase-xyz',
    });
    sshProfId = sshSave.profile.id;
    const remSave = environments.saveRemoteProfile({
      name: 'Local Test Remote',
      url: started.url,
      token: secretToken,
      remoteCwd: tmpDir,
    });
    remProfId = remSave.profile.id;

    const envJsonPath = path.join(os.homedir(), '.autobot', 'environments.json');
    const rawJson = fs.readFileSync(envJsonPath, 'utf8');
    assert(!rawJson.includes('top-secret-passphrase-xyz'), 'SSH secret must NEVER exist in plaintext environments.json');
    assert(!rawJson.includes(secretToken), 'Remote token must NEVER exist in plaintext environments.json');

    // 3. Test Remote connection
    const ping = await environments.testRemote(remProfId);
    assert(ping.ok && ping.cwd === tmpDir && ping.workspaces.length >= 1, 'testRemote ping + workspaces ok');

    // 4. Activate Remote environment and exercise routed FS, Search, Git, Tools & PTY
    const sw = environments.setActive({ kind: 'remote', id: remProfId, cwd: tmpDir });
    assert(sw.ok && environments.isRemoteActive());

    const tree = await environments.dispatchIde('fs', 'readTree', { cwd: tmpDir });
    assert(tree.ok && tree.nodes.some((n) => n.name === 'hello.js'));

    const wf = await environments.dispatchIde('fs', 'writeFile', { path: path.join(tmpDir, 'added.txt'), content: 'remote-line\n' });
    assert(wf.ok);
    const rf = await environments.dispatchIde('fs', 'readFile', { path: path.join(tmpDir, 'added.txt') });
    assert(rf.ok && rf.content === 'remote-line\n');

    const srch = await environments.dispatchIde('search', 'search', { cwd: tmpDir, query: 'REMOTE_OK_123' });
    assert(srch.ok && srch.matches.length === 1);

    const gst = await environments.dispatchIde('git', 'status', { cwd: tmpDir });
    assert(gst && gst.isRepo && gst.untracked.some((f) => f.relPath === 'added.txt'));

    // Routed Agent Tool (read_file & bash via tools.runTool -> environments.runActiveTool)
    const bashOut = await tools.runTool('bash', { command: 'echo TOOL_ROUTED_OK', cwd: tmpDir }, {});
    assert(String(bashOut.content).includes('TOOL_ROUTED_OK'), `Unexpected bash output: ${JSON.stringify(bashOut)}`);

    // Routed Interactive PTY over Remote Server WebSocket
    let ptyOut = '';
    const pRes = ptyMod.createPty({ cwd: tmpDir, cols: 80, rows: 24 }, { onData: (_id, d) => { ptyOut += d; } });
    assert.strictEqual(pRes.backend, 'remote-ws-pty');
    ptyMod.writePty(pRes.id, 'echo REMOTE_PTY_ECHO\r');
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !ptyOut.includes('REMOTE_PTY_ECHO')) {
      await new Promise((r) => setTimeout(r, 60));
    }
    ptyMod.killPty(pRes.id);
    assert(ptyOut.includes('REMOTE_PTY_ECHO'), `Remote WS PTY failed to echo: ${ptyOut.slice(0, 150)}`);

    // Verify unauthorized WS upgrade is rejected
    await new Promise((resolve) => {
      const { wsUrl } = environments.getRemoteWsUrl(remProfId, { cwd: tmpDir });
      const badWs = new WebSocket(wsUrl, { headers: { Authorization: 'Bearer nope' } });
      badWs.on('unexpected-response', (_req, res) => {
        assert.strictEqual(res.statusCode, 401);
        resolve();
      });
      badWs.on('error', () => resolve());
    });

    console.log('✓ 2.2 Secret isolation, Remote Server routing, Agent tool routing & WS PTY');
  } finally {
    try { environments.setActive(prevActive || { kind: 'local' }); } catch (_) {}
    if (sshProfId) environments.deleteSshProfile(sshProfId);
    if (remProfId) environments.deleteRemoteProfile(remProfId);
    await srv.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(_isolatedEnvDir, { recursive: true, force: true });
  }
}

(async () => {
  await testSshConfigParsing();
  await testSecretIsolationAndRemoteServerE2E();
  console.log('ENVIRONMENTS_ALL_PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
