'use strict';
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('os');
const path = require('path');

const usageEstimator = require('../electron/usage-estimator');
const swarmMod = require('../electron/swarm');
const taskRouter = require('../electron/task-router');
const orchRouter = require('../electron/orch-router');
const updater = require('../electron/updater');
const paradev = require('../electron/paradev-client');
const gitMod = require('../electron/git');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    failed++;
  }
}

(async () => {
  console.log('\n=== v1.5.0 SUPERVISOR THINKING, CONTEXT 0% FIX, UPDATER FALLBACK & PARADEV BRIDGE ===');

  await test('Anthropic message_start + message_delta usage merging preserves cached context tokens', () => {
    const startUsage = {
      input_tokens: 12,
      cache_read_input_tokens: 42500,
      cache_creation_input_tokens: 1800,
      output_tokens: 1,
    };
    const deltaUsage = { output_tokens: 195 };
    const merged = usageEstimator.mergeUsageObjects(startUsage, deltaUsage);
    const norm = usageEstimator.normalizeCallUsage(merged);
    assert.strictEqual(norm.prompt_tokens, 44312);
    assert.strictEqual(norm.input_tokens, 44312);
    assert.strictEqual(norm.completion_tokens, 195);
    assert.strictEqual(norm.total_tokens, 44507);
    assert.strictEqual(norm.cache_read_input_tokens, 42500);
  });

  await test('Deterministic token estimation prevents 0% context when gateway omits SSE usage', () => {
    const msgs = [
      { role: 'system', content: 'You are an expert software engineer.' },
      { role: 'user', content: 'Build a full production app with SQLite and React.' + 'x'.repeat(2400) },
    ];
    const tools = [{ type: 'function', function: { name: 'Write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } }];
    const norm = usageEstimator.normalizeCallUsage(null, msgs, tools, { role: 'assistant', content: 'Done building the module.' });
    assert.ok(norm && norm.prompt_tokens > 600, `expected >600 estimated tokens, got ${norm && norm.prompt_tokens}`);
    assert.ok(norm.completion_tokens > 0);
    assert.strictEqual(norm.estimated, true);
  });

  await test('Supervisor thinking mode is ALWAYS forced to high in Swarm, Auto planner, and OrchRouter', async () => {
    // 1. OrchRouter forces planner role to high
    const orch = {
      pools: {
        enabled: true,
        gateway: { baseURL: 'http://127.0.0.1:11434/v1', apiKey: '' },
        roles: {
          planner: { models: ['claude-opus-5-5-medium', 'claude-opus-5-5-high'] },
          coder: { models: ['claude-sonnet-5-5'] },
        },
      },
    };
    const plannerRows = orchRouter.resolve(orch, 'planner', { reasoningLevel: 'low' });
    assert.strictEqual(plannerRows[0].reasoningLevel, 'high');

    // 2. Swarm upgrades -medium/-low supervisor to -high and forces reasoningLevel = 'high' + aggregates usage
    const seenSupervisorLevels = [];
    const seenSupervisorModels = [];
    const res = await swarmMod.swarm('Architect a distributed job runner', {
      provider: { baseURL: 'http://127.0.0.1:9/v1', model: 'claude-opus-5-5-medium', oauthProvider: 'antigravity:a', reasoningLevel: 'low', frontier: true },
      orchestrator: {
        enabled: true,
        providers: [
          { baseURL: 'http://127.0.0.1:9/v1', model: 'claude-opus-5-5-medium', tier: 'critical', reasoningLevel: 'low', frontier: true },
          { baseURL: 'http://127.0.0.1:9/v1', model: 'claude-opus-5-5-high', tier: 'critical', reasoningLevel: 'low', frontier: true },
          { baseURL: 'http://127.0.0.1:9/v1', model: 'claude-sonnet-5-5', tier: 'heavy', reasoningLevel: 'auto', frontier: true },
        ],
      },
      tasks: [{ id: 't1', title: 'Core engine', prompt: 'Write engine.js', tier: 'heavy' }],
      runAgent: async ({ provider, toolAllow, messages }) => {
        if (toolAllow === swarmMod.PLAN_TOOLS || toolAllow === swarmMod.READONLY_REVIEW_TOOLS) {
          seenSupervisorLevels.push(provider.reasoningLevel);
          seenSupervisorModels.push(provider.model);
        }
        return [
          ...messages,
          { role: 'assistant', content: 'Verified complete.', usage: { prompt_tokens: 1500, completion_tokens: 200, total_tokens: 1700 } },
        ];
      },
    });
    assert.strictEqual(res.supervisor.reasoningLevel, 'high');
    assert.strictEqual(res.supervisor.model, 'claude-opus-5-5-high');
    assert.ok(seenSupervisorLevels.every((lv) => lv === 'high'), `Supervisor must always run high, got ${seenSupervisorLevels}`);
    assert.ok(res.usage && res.usage.total_tokens >= 3400, 'Swarm must aggregate child usage');

    // 3. Auto Task Router forces planner tier to high
    const sel = await taskRouter.selectModelForTier({
      classification: { role: 'planner', tier: 5, complexity: 5, reason: 'Architecture design' },
      oauthAccounts: [{ id: 'claude:main', provider: 'claude', account: 'main@test', expired: false, needsSignIn: false }],
    });
    assert.strictEqual(sel.chosen.reasoningLevel, 'high');
    assert.strictEqual(sel.classification.reasoningLevel, 'high');
  });

  await test('Updater falls back cleanly to GitHub Web redirect + latest-*.yml when API returns 403 rate limit', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-upd-fb-'));
    const pkgBytes = Buffer.from('FAKE_MAC_ZIP_V150');
    const sha = crypto.createHash('sha256').update(pkgBytes).digest('hex');
    const yml = [
      'version: 1.5.0',
      'files:',
      '  - url: AkronCode-1.5.0-arm64.zip',
      `    sha512: fake`,
      `    size: ${pkgBytes.length}`,
      'path: AkronCode-1.5.0-arm64.zip',
      'releaseDate: "2026-11-27T12:00:00Z"',
    ].join('\n');

    const mockFetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        return { ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }), text: async () => 'rate limit' };
      }
      if (u.endsWith('/releases/latest')) {
        return { ok: true, status: 200, url: 'https://github.com/faysaliteng/akron-code/releases/tag/v1.5.0', text: async () => '' };
      }
      if (u.endsWith('/latest-mac.yml')) {
        return { ok: true, status: 200, text: async () => yml };
      }
      if (u.endsWith('/SHA256SUMS.txt')) {
        return { ok: true, status: 200, text: async () => `${sha}  AkronCode-1.5.0-arm64.zip\n` };
      }
      if (u.endsWith('/AkronCode-1.5.0-arm64.zip')) {
        if (init.method === 'HEAD') return { ok: true, status: 200 };
        const rs = new ReadableStream({
          start(c) { c.enqueue(new Uint8Array(pkgBytes)); c.close(); },
        });
        return { ok: true, status: 200, headers: new Headers({ 'content-length': String(pkgBytes.length) }), body: rs };
      }
      return { ok: false, status: 404, text: async () => 'not found' };
    };

    try {
      const chk = await updater.checkForUpdates({
        currentVersion: '1.4.0',
        platform: 'darwin',
        arch: 'arm64',
        fetchImpl: mockFetch,
      });
      assert.strictEqual(chk.ok, true);
      assert.strictEqual(chk.via, 'github-web-fallback');
      assert.strictEqual(chk.latestVersion, '1.5.0');
      assert.strictEqual(chk.updateAvailable, true);
      assert.strictEqual(chk.asset.name, 'AkronCode-1.5.0-arm64.zip');

      const dl = await updater.downloadAndVerifyUpdate({
        asset: chk.asset,
        sumsUrl: chk.sumsUrl,
        destDir: tmp,
        fetchImpl: mockFetch,
      });
      assert.strictEqual(dl.ok, true);
      assert.strictEqual(dl.verified, true);
      assert.strictEqual(dl.sha256, sha);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('Paradev SuperJSON tRPC client sends x-api-key for sk_live_* and decodes voice/workspaces/tasks', async () => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        calls.push({ url: req.url, method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (req.url.includes('voice.transcribe')) {
          res.end(JSON.stringify({ result: { data: { json: { text: 'ship release v1.5.0' } } } }));
        } else if (req.url.includes('cloudWorkspace.list')) {
          res.end(JSON.stringify({ result: { data: { json: [{ id: 'ws-1', name: 'sandbox-a', status: 'awake' }] } } }));
        } else if (req.url.includes('task.create')) {
          res.end(JSON.stringify({ result: { data: { json: { id: 'task-1', title: 'Audit updater' } } } }));
        } else {
          res.end(JSON.stringify({ result: { data: { json: {} } } }));
        }
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${srv.address().port}`;
    try {
      const vt = await paradev.transcribeAudio({
        audioBase64: Buffer.from('RIFF_DUMMY').toString('base64'),
        mimeType: 'audio/wav',
        explicit: { apiKey: 'sk_live_testkey_12345', baseURL: base },
      });
      assert.strictEqual(vt.ok, true);
      assert.strictEqual(vt.text, 'ship release v1.5.0');
      assert.strictEqual(calls[0].headers['x-api-key'], 'sk_live_testkey_12345');

      const ws = await paradev.listWorkspaces({
        organizationId: 'org-1',
        explicit: { apiKey: 'sk_live_testkey_12345', baseURL: base },
      });
      assert.strictEqual(ws.ok, true);
      assert.strictEqual(ws.data[0].id, 'ws-1');
      assert.ok(calls[1].url.includes('/api/trpc/cloudWorkspace.list?input='));

      const tk = await paradev.createTask({
        title: 'Audit updater',
        explicit: { apiKey: 'sk_live_testkey_12345', baseURL: base },
      });
      assert.strictEqual(tk.ok, true);
      assert.strictEqual(tk.data.id, 'task-1');
      assert.strictEqual(tk.data.title, 'Audit updater');
    } finally {
      srv.close();
    }
  });

  await test('Git worktree add/remove executes .superset/config.json setup and teardown scripts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-wt-hooks-'));
    const repoDir = path.join(tmp, 'repo');
    const wtDir = path.join(tmp, 'wt-feat');
    fs.mkdirSync(repoDir, { recursive: true });
    const { execFileSync } = require('node:child_process');
    execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@akronlogic.com'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
    fs.mkdirSync(path.join(repoDir, '.superset'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.superset', 'config.json'), JSON.stringify({
      setup: ['node -e "require(\'fs\').writeFileSync(\'.wt_setup_ok\', process.env.SUPERSET_WORKSPACE_PATH || \'ok\')"'],
      teardown: ['node -e "require(\'fs\').writeFileSync(\'../.wt_teardown_ok\', \'done\')"'],
    }));
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    try {
      const added = await gitMod.addWorktree(repoDir, 'feat/superset-hooks', wtDir);
      assert.strictEqual(added.ok, true);
      assert.ok(fs.existsSync(path.join(wtDir, '.wt_setup_ok')), '.superset setup script must run in new worktree');
      const removed = await gitMod.removeWorktree(repoDir, wtDir);
      assert.strictEqual(removed.ok, true);
      assert.ok(fs.existsSync(path.join(tmp, '.wt_teardown_ok')), '.superset teardown script must run before removal');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log(`\nSummary: ${passed}/${passed + failed} passed`);
  if (failed > 0) process.exit(1);
})();
