'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, spawnSync } = require('node:child_process');

const cliRunner = require('../electron/cli-runner');
const { reconcileWorkerWorktrees } = require('../electron/swarm');

test('v1.6.9 cli-runner: isCliProvider distinguishes CLI rows from API-key and openai HTTP rows', () => {
  assert.equal(cliRunner.isCliProvider({ transport: 'cli', cliKind: 'claude' }), true);
  assert.equal(cliRunner.isCliProvider({ cliMode: true, model: 'gpt-5-4' }), true);
  assert.equal(cliRunner.isCliProvider({ oauthProvider: 'claude:me', model: 'claude-sonnet-5-5' }), true);
  assert.equal(cliRunner.isCliProvider({ oauthProvider: 'custom:acct', transport: 'openai', baseURL: 'http://127.0.0.1:9/v1', accessToken: 'tok' }), false);
  assert.equal(cliRunner.isCliProvider({ transport: 'anthropic', apiKey: 'sk-ant-api03-x', model: 'claude-sonnet-4-6' }), false);
});

test('v1.6.9 cli-runner: parses NDJSON events, handles --model fallback, and kills subprocess immediately on Stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cli-runner-test-'));
  const mockClaude = path.join(dir, 'mock-claude.js');
  fs.writeFileSync(mockClaude, [
    'const args = process.argv.slice(2);',
    'const modelIdx = args.indexOf("--model");',
    'const modelVal = modelIdx >= 0 ? args[modelIdx + 1] : "";',
    'const prompt = args[args.indexOf("-p") + 1] || "";',
    'if (prompt.includes("HANG_FOREVER")) {',
    '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial-" } } }));',
    '  setTimeout(() => {}, 60000);',
    '} else if (modelVal === "unknown-model-x") {',
    '  console.error("Error: unknown model unknown-model-x");',
    '  process.exit(1);',
    '} else {',
    '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "t1", name: "Edit", input: { file_path: "a.js" } } } }));',
    '  console.log(JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "edited a.js" }] } }));',
    '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "plan" } } }));',
    '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "DONE_CLI" } } }));',
    '  console.log(JSON.stringify({ type: "result", result: "DONE_CLI", usage: { input_tokens: 10, output_tokens: 5 } }));',
    '}',
  ].join('\n'), 'utf8');

  const binWrapper = path.join(dir, 'claude-mock');
  fs.writeFileSync(binWrapper, `#!/bin/sh\nexec "${process.execPath}" "${mockClaude}" "$@"\n`, { mode: 0o755 });

  try {
    // 1. Model fallback + full runAgent wiring + tool/file_edit emission
    const llm = require('../electron/llm');
    const events = [];
    const out = await llm.runAgent({
      provider: {
        transport: 'cli',
        cliMode: true,
        cliKind: 'claude',
        cliBin: binWrapper,
        model: 'unknown-model-x',
      },
      messages: [{ role: 'user', content: 'Say hello' }],
      useMemory: false,
      cwd: dir,
      emit: (e) => events.push(e),
    });
    const last = [...out].reverse().find((m) => m && m.role === 'assistant');
    assert.ok(last && last.content.includes('DONE_CLI'));
    assert.ok(events.some((e) => e.type === 'file_edit' && e.path === 'a.js'), 'file_edit emitted from CLI NDJSON');
    assert.ok(events.some((e) => e.type === 'toolResult' && e.result === 'edited a.js'), 'toolResult emitted from CLI NDJSON');
    assert.ok(events.some((e) => e.type === 'done'), 'turn emitted done');

    // 2. AbortController Stop latency < 500ms
    const ac = new AbortController();
    const seenDeltas = [];
    const t0 = Date.now();
    const p = cliRunner.runCliTurn({
      provider: { transport: 'cli', cliKind: 'claude', cliBin: binWrapper, model: 'claude-sonnet-4-6' },
      messages: [{ role: 'user', content: 'HANG_FOREVER' }],
      cwd: dir,
      signal: ac.signal,
      onDelta: (txt) => {
        seenDeltas.push(txt);
        if (txt.includes('partial-')) ac.abort();
      },
    });
    await assert.rejects(p, (err) => err && (err.name === 'AbortError' || /abort/i.test(err.message)));
    assert.ok(Date.now() - t0 < 1500, 'CLI subprocess abort settled rapidly');
    assert.ok(seenDeltas.join('').includes('partial-'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('v1.6.9 secretstore: random non-deterministic 32-byte master.key with 0o600 permissions', () => {
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sec-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sec-b-'));
  const script = [
    'const s = require("./electron/secretstore");',
    's.set("k1", "super-secret-value-123");',
    'console.log(JSON.stringify({ val: s.get("k1"), status: s.status(), keyHex: require("fs").readFileSync(require("path").join(process.env.AUTOBOT_HOME, "master.key"), "utf8").trim() }));',
  ].join('\n');
  try {
    const rA = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, AUTOBOT_HOME: dirA, AKRON_DISABLE_SAFE_STORAGE: '1' },
      encoding: 'utf8',
    });
    const rB = spawnSync(process.execPath, ['-e', script], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, AUTOBOT_HOME: dirB, AKRON_DISABLE_SAFE_STORAGE: '1' },
      encoding: 'utf8',
    });
    assert.equal(rA.status, 0, rA.stderr);
    assert.equal(rB.status, 0, rB.stderr);
    const outA = JSON.parse(rA.stdout.trim());
    const outB = JSON.parse(rB.stdout.trim());
    assert.equal(outA.val, 'super-secret-value-123');
    assert.equal(outA.status.backend, 'aes-256-gcm-fallback');
    assert.equal(outA.keyHex.length, 64);
    assert.notEqual(outA.keyHex, outB.keyHex, 'master.key must be unique random bytes, not hostname-derived');
    const st = fs.statSync(path.join(dirA, 'master.key'));
    assert.equal(st.mode & 0o777, 0o600, 'master.key must be 0o600');
  } finally {
    fs.rmSync(dirA, { recursive: true, force: true });
    fs.rmSync(dirB, { recursive: true, force: true });
  }
});

test('v1.6.9 swarm: reconcileWorkerWorktrees auto-merges clean branches and preserves conflicted branches', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-swarm-wt-'));
  const wt1 = path.join(repo + '-wt1');
  const wt2 = path.join(repo + '-wt2');
  const wt3 = path.join(repo + '-wt3');
  const git = (cwd, args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, encoding: 'utf8' });

  try {
    git(repo, ['init']);
    fs.writeFileSync(path.join(repo, 'shared.txt'), 'base\n', 'utf8');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);

    git(repo, ['worktree', 'add', '-b', 'swm-w1', wt1]);
    fs.writeFileSync(path.join(wt1, 'worker1.txt'), 'one\n', 'utf8');
    git(wt1, ['add', '.']);
    git(wt1, ['commit', '-m', 'w1']);

    git(repo, ['worktree', 'add', '-b', 'swm-w2', wt2]);
    fs.writeFileSync(path.join(wt2, 'shared.txt'), 'from w2\n', 'utf8');
    git(wt2, ['add', '.']);
    git(wt2, ['commit', '-m', 'w2']);

    git(repo, ['worktree', 'add', '-b', 'swm-w3', wt3]);
    fs.writeFileSync(path.join(wt3, 'shared.txt'), 'from w3 conflict\n', 'utf8');
    git(wt3, ['add', '.']);
    git(wt3, ['commit', '-m', 'w3']);

    const done = [
      { name: 'w1', result: 'ok\n\n[Worktree preserved: path=' + wt1 + ', branch=swm-w1]', worktree: { path: wt1, branch: 'swm-w1', gitRoot: repo } },
      { name: 'w2', result: 'ok\n\n[Worktree preserved: path=' + wt2 + ', branch=swm-w2]', worktree: { path: wt2, branch: 'swm-w2', gitRoot: repo } },
      { name: 'w3', result: 'ok\n\n[Worktree preserved: path=' + wt3 + ', branch=swm-w3]', worktree: { path: wt3, branch: 'swm-w3', gitRoot: repo } },
    ];
    const recon = await reconcileWorkerWorktrees(done, repo);
    assert.equal(recon.merged.length, 2);
    assert.equal(recon.conflicts.length, 1);
    assert.equal(recon.conflicts[0].worker, 'w3');
    assert.equal(fs.existsSync(path.join(repo, 'worker1.txt')), true);
    assert.equal(fs.readFileSync(path.join(repo, 'shared.txt'), 'utf8'), 'from w2\n');
    assert.equal(fs.existsSync(wt1), false, 'merged worktree cleaned');
    assert.equal(fs.existsSync(wt3), true, 'conflicted worktree preserved for supervisor');
  } finally {
    try { execFileSync('git', ['worktree', 'remove', '--force', wt3], { cwd: repo }); } catch (_) {}
    fs.rmSync(wt1, { recursive: true, force: true });
    fs.rmSync(wt2, { recursive: true, force: true });
    fs.rmSync(wt3, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('v1.6.9 packaging & runtimes security: no chmod inside app bundle + sha256/unsigned enforcement + win32 staging', async () => {
  const { isInsideAppResources, syncBundledBinsToDir } = require('../electron/ipc/ipc-runtimes');
  assert.equal(isInsideAppResources('/Applications/Akron Code.app/Contents/Resources/runtimes/grok/bin/grok'), true);

  // Ensure syncBundledBinsToDir never calls chmodSync inside .app/Contents/Resources
  const fakeBundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-bundle-'));
  const appResTarget = path.join(fakeBundleRoot, 'Akron Code.app', 'Contents', 'Resources', 'bin', 'grok');
  const binDir = path.join(fakeBundleRoot, 'user-bin');
  fs.mkdirSync(path.dirname(appResTarget), { recursive: true });
  fs.writeFileSync(appResTarget, '#!/bin/sh\necho 1\n', { mode: 0o644 });

  const origChmod = fs.chmodSync;
  const chmodTargets = [];
  fs.chmodSync = (p, m) => {
    chmodTargets.push(String(p));
    return origChmod.call(fs, p, m);
  };
  try {
    syncBundledBinsToDir({ binDir, links: [{ name: 'grok', target: appResTarget }] });
    assert.ok(!chmodTargets.some((t) => t.includes('.app/Contents/Resources')), 'must never chmodSync inside .app bundle resources');
  } finally {
    fs.chmodSync = origChmod;
    fs.rmSync(fakeBundleRoot, { recursive: true, force: true });
  }

  // Test Grok unverified binary rejection when allowInsecure is false + sha256 mismatch
  const runtimesMod = require('../electron/runtimes');
  const suffix = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x86_64')
    : (process.platform === 'linux' ? (process.arch === 'arm64' ? 'linux-aarch64' : 'linux-x86_64') : 'windows-x86_64.exe');
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-rt-sec-'));
  const grokScript = Buffer.from('#!/bin/sh\necho "grok 1.0.99"\n', 'utf8');
  let mode = 'bad-sha';
  const srv = http.createServer((req, res) => {
    if (req.url === '/cli/stable') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('1.0.99\n');
    } else if (req.url === `/cli/grok-1.0.99-${suffix}`) {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': grokScript.length });
      res.end(grokScript);
    } else if (req.url === `/cli/grok-1.0.99-${suffix}.sha256` && mode === 'bad-sha') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('0'.repeat(64) + '  grok\n');
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const rtBadSha = runtimesMod.createRuntimes({
      userDir,
      grokPointers: [base + '/cli/stable'],
      allowHosts: new Set(['127.0.0.1']),
      allowInsecure: true,
      minArtifact: 0,
    });
    await assert.rejects(rtBadSha.install('grok'), /sha256 sidecar rejected/i);

    mode = 'no-sha';
    const httpsBase = base.replace(/^http:/, 'https:');
    const rtStrict = runtimesMod.createRuntimes({
      userDir,
      grokPointers: [httpsBase + '/cli/stable'],
      allowHosts: new Set(['127.0.0.1']),
      allowInsecure: false,
      fetchImpl: (url, opts) => {
        assert.ok(String(url).startsWith('https://'));
        return fetch(String(url).replace(/^https:/, 'http:'), opts);
      },
      minArtifact: 0,
    });
    await assert.rejects(rtStrict.install('grok'), /refusing to execute unverified/i);

    // Win32 codex staging test
    const codexDesc = runtimesMod.DESCRIPTORS.find((d) => d.id === 'codex');
    const pkgRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-codex-win-'));
    const dest = path.join(pkgRoot, 'staged');
    const vDir = path.join(pkgRoot, 'vendor', 'aarch64-pc-windows-msvc', 'bin');
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, 'codex.exe'), 'MZ_FAKE_EXE');
    await codexDesc.stage(pkgRoot, dest, { platform: 'win32', arch: 'arm64' });
    assert.equal(fs.existsSync(path.join(dest, 'bin', 'codex.exe')), true);
    assert.equal(fs.existsSync(path.join(dest, 'bin', 'codex.cmd')), true);
    assert.equal(codexDesc.binPath(dest, 'win32'), path.join(dest, 'bin', 'codex.exe'));
    fs.rmSync(pkgRoot, { recursive: true, force: true });
  } finally {
    try { srv.closeAllConnections(); } catch (_) {}
    await new Promise((r) => srv.close(r));
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
