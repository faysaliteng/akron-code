'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const schedulerLock = require('../electron/scheduler-lock');
const daemon = require('../electron/daemon');
const remoteServer = require('../electron/remote-server');

test('Phase 5: scheduler-lock exclusive lease prevents split-brain between desktop and daemon', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sched-lock-'));
  try {
    const desk = schedulerLock.acquireSchedulerLease({ dataDir: tmpDir, owner: 'desktop', pid: process.pid });
    assert.strictEqual(desk.acquired, true);
    assert.strictEqual(schedulerLock.canOwnerRunScheduler({ dataDir: tmpDir, owner: 'desktop', pid: process.pid }), true);
    // Simulate a second live PID attempting to claim 'daemon' lease
    assert.strictEqual(schedulerLock.canOwnerRunScheduler({ dataDir: tmpDir, owner: 'daemon', pid: process.pid + 99999 }), false);
    const blocked = schedulerLock.acquireSchedulerLease({ dataDir: tmpDir, owner: 'daemon', pid: process.pid + 99999 });
    assert.strictEqual(blocked.acquired, false);
    assert.strictEqual(blocked.holder.owner, 'desktop');

    const rel = schedulerLock.releaseSchedulerLease({ dataDir: tmpDir, owner: 'desktop', pid: process.pid });
    assert.strictEqual(rel.ok, true);
    assert.strictEqual(rel.released, true);

    const dmn = schedulerLock.acquireSchedulerLease({ dataDir: tmpDir, owner: 'daemon', pid: process.pid });
    assert.strictEqual(dmn.acquired, true);
    assert.strictEqual(dmn.lease.owner, 'daemon');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 5: daemon start, status, service templates across 3 OSes, and clean stop', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-daemon-'));
  const homeDir = path.join(tmpDir, 'home');
  const dataDir = path.join(tmpDir, 'data');
  const workDir = path.join(tmpDir, 'ws');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  try {
    const started = await daemon.startDaemon({ dataDir, cwd: workDir, port: 0, foreground: false });
    assert.strictEqual(started.ok, true, started.error || 'daemon failed to start');
    assert.ok(started.pid > 0);
    assert.ok(started.port > 0);

    const st = daemon.daemonStatus({ dataDir });
    assert.strictEqual(st.running, true);
    assert.strictEqual(st.pid, started.pid);
    assert.strictEqual(st.port, started.port);

    for (const plat of ['darwin', 'linux', 'win32']) {
      const ins = daemon.installDaemonService({ platform: plat, homeDir, dataDir, cwd: workDir });
      assert.strictEqual(ins.ok, true);
      assert.strictEqual(fs.existsSync(ins.filePath), true);
      const un = daemon.uninstallDaemonService({ platform: plat, homeDir, dataDir, cwd: workDir });
      assert.strictEqual(un.ok, true);
      assert.strictEqual(un.removed, true);
      assert.strictEqual(fs.existsSync(ins.filePath), false);
    }

    const stopped = daemon.stopDaemon({ dataDir });
    assert.strictEqual(stopped.ok, true);
    assert.strictEqual(stopped.stopped, true);

    const after = daemon.daemonStatus({ dataDir });
    assert.strictEqual(after.running, false);
  } finally {
    try { daemon.stopDaemon({ dataDir }); } catch (_) {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Phase 5: remote-server /webhooks/github enforces HMAC-SHA256 and runs isolated git worktree review', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-webhook-'));
  const dataDir = path.join(tmpDir, 'data');
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(repoDir, { recursive: true });

  execFileSync('git', ['init', repoDir], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'ci@akronlogic.com'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'Akron CI'], { stdio: 'ignore' });
  fs.writeFileSync(path.join(repoDir, 'app.js'), 'exports.hello = () => "v1";\n');
  execFileSync('git', ['-C', repoDir, 'add', '.'], { stdio: 'ignore' });
  execFileSync('git', ['-C', repoDir, 'commit', '-m', 'init'], { stdio: 'ignore' });
  const headSha = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const secret = 'akron_test_secret_12345';
  let observedWorktreeDir = null;
  let observedWorktreeInsideReview = false;
  let postedComment = null;

  const rs = remoteServer.createRemoteServer({
    port: 0,
    host: '127.0.0.1',
    token: 'bearer_tok',
    workspaceRoot: repoDir,
    dataDir,
    webhookSecret: secret,
    onWebhookReview: async ({ cwd, rootDir, pr }) => {
      observedWorktreeDir = cwd;
      observedWorktreeInsideReview = fs.existsSync(path.join(cwd, 'app.js')) && cwd !== rootDir;
      return { ok: true, summary: `Reviewed PR #${pr.number} cleanly` };
    },
    onGitHubComment: async (info) => {
      postedComment = info;
    },
  });

  try {
    const { port } = await rs.start();
    const body = JSON.stringify({
      action: 'opened',
      pull_request: {
        number: 42,
        title: 'Add v1.3 feature',
        head: { sha: headSha },
        comments_url: 'https://api.github.com/repos/faysaliteng/akron-code/issues/42/comments',
      },
    });
    const badRes = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64),
      },
      body,
    });
    assert.strictEqual(badRes.status, 401);

    const sig = 'sha256=' + crypto.createHmac('sha256', secret).update(Buffer.from(body, 'utf8')).digest('hex');
    const goodRes = await fetch(`http://127.0.0.1:${port}/webhooks/github`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'pull_request',
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    assert.strictEqual(goodRes.status, 200);
    const json = await goodRes.json();
    assert.strictEqual(json.ok, true);
    assert.strictEqual(json.worktreeIsolated, true);
    assert.strictEqual(observedWorktreeInsideReview, true);
    assert.strictEqual(fs.existsSync(observedWorktreeDir), false, 'worktree should be cleaned up after review');
    assert.strictEqual(json.commentPosted, true);
    assert.strictEqual(postedComment?.body, 'Reviewed PR #42 cleanly');
  } finally {
    await rs.stop().catch(() => {});
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
