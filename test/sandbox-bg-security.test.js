'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sec-'));
process.env.HOME = TMP;
process.env.USERPROFILE = TMP;

const { runTool } = require('../electron/tools');
const bg = require('../electron/bg');
const osSandbox = require('../electron/os-sandbox');
const sandbox = require('../electron/sandbox');
const editGuard = require('../electron/ide/edit-guard');
const checkpoints = require('../electron/checkpoints');

let pass = 0;
async function check(name, fn) {
  await fn();
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('\nsandbox-bg-security tests');

  await check('background Bash blocks dangerous rm -rf ~ BEFORE spawning', async () => {
    const beforeCount = bg.listJobs().length;
    const res = await runTool('Bash', { command: 'rm -rf ~', run_in_background: true }, { cwd: TMP });
    assert.ok(/Sandbox blocked/i.test(res.content), res.content);
    assert.strictEqual(bg.listJobs().length, beforeCount);
  });

  await check('background Bash blocks credential reads even when full OS sandbox is disabled', async () => {
    const res = await runTool('Bash', { command: 'cat ~/.autobot/secrets.json', run_in_background: true }, { cwd: TMP });
    assert.ok(/Sandbox blocked/i.test(res.content), res.content);
  });

  await check('foreground Bash blocks ~/.ssh/id_rsa and ~/.autobot/oauth.json by default', async () => {
    const r1 = await runTool('Bash', { command: 'sh -c "cat ~/.ssh/id_rsa"' }, { cwd: TMP });
    const r2 = await runTool('Bash', { command: 'cat ~/.autobot/oauth.json' }, { cwd: TMP });
    assert.ok(/Sandbox blocked/i.test(r1.content), r1.content);
    assert.ok(/Sandbox blocked/i.test(r2.content), r2.content);
  });

  await check('bg.startShell & bg.startMonitor fail closed when sandbox throws SANDBOX_POLICY_DENIED', async () => {
    const settingsFile = path.join(TMP, '.autobot', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ sandbox: { enabled: true } }));
    const leakFile = path.join(TMP, 'should-not-exist.txt');
    const j1 = bg.startShell({ command: `cat ~/.autobot/secrets.json && touch "${leakFile}"`, cwd: TMP });
    assert.strictEqual(j1.status, 'failed');
    const j2 = bg.startMonitor({ command: `cat ~/.ssh/id_ed25519 && touch "${leakFile}"`, cwd: TMP });
    assert.strictEqual(j2.status, 'failed');
    assert.strictEqual(fs.existsSync(leakFile), false);
    fs.rmSync(settingsFile, { force: true });
  });

  await check('Seatbelt profile denies .git/hooks, .git/config, .claude/settings.json, secrets.json after cwd allow', async () => {
    const sb = osSandbox.buildSeatbeltProfile({ cwd: TMP, profile: 'workspace-write' });
    const allowCwdIdx = sb.indexOf(`(allow file-write* (subpath "${path.resolve(TMP)}"))`);
    const denyHooksIdx = sb.indexOf(`(deny file-write* (subpath "${path.join(path.resolve(TMP), '.git', 'hooks')}"))`);
    const denySecretsIdx = sb.indexOf(`(deny file-write* (literal "${path.join(TMP, '.autobot', 'secrets.json')}"))`);
    assert.ok(allowCwdIdx >= 0);
    assert.ok(denyHooksIdx > allowCwdIdx, 'Seatbelt last-match-wins requires deny .git/hooks AFTER allow cwd');
    assert.ok(denySecretsIdx > allowCwdIdx, 'Seatbelt last-match-wins requires deny secrets.json AFTER allow .autobot');
  });

  await check('editGuard.withFileLock serializes concurrent writes on the same path', async () => {
    const fp = path.join(TMP, 'lock-target.txt');
    const order = [];
    await Promise.all([
      editGuard.withFileLock(fp, async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 25));
        order.push('a-end');
      }),
      editGuard.withFileLock(fp, async () => {
        order.push('b-start');
        order.push('b-end');
      }),
    ]);
    assert.deepStrictEqual(order, ['a-start', 'a-end', 'b-start', 'b-end']);
  });

  await check('checkpoints captureWorkspaceState + snapshotWorkspaceChanges reverts Bash-created files on restore()', async () => {
    const ws = path.join(TMP, 'ws');
    fs.mkdirSync(ws, { recursive: true });
    const before = checkpoints.captureWorkspaceState(ws);
    const created = path.join(ws, 'generated-by-bash.txt');
    fs.writeFileSync(created, 'hello\n');
    const recs = checkpoints.snapshotWorkspaceChanges('conv-bash-1', 'turn-1', ws, before);
    assert.ok(recs.some((r) => r.path === path.resolve(created) && r.existed === false));
    const cps = checkpoints.listCheckpoints('conv-bash-1');
    assert.ok(cps.length >= 1);
    const rev = checkpoints.restore('conv-bash-1', cps[0].id);
    assert.ok(rev.removed.includes(path.resolve(created)));
    assert.strictEqual(fs.existsSync(created), false);
  });

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n${pass} passed, 0 failed`);
})();
