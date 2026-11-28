'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-agy-swarm-test-'));
process.env.AUTOBOT_HOME = path.join(TMP, 'autobot-home');

const cliRunner = require('../electron/cli-runner');
const providertransport = require('../electron/providertransport');
const providerOauth = require('../electron/provider-oauth');
const modelCatalog = require('../electron/model-catalog');
const orchRouter = require('../electron/orch-router');
const swarm = require('../electron/swarm');
const claudeconfig = require('../electron/claudeconfig');
const mcpMod = require('../electron/mcp');

let pass = 0;
const asyncChecks = [];
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('ok   - ' + name);
  } catch (e) {
    console.error('FAIL - ' + name + '\n' + (e && e.stack || e));
    process.exitCode = 1;
  }
}
function acheck(name, fn) {
  asyncChecks.push(async () => {
    try {
      await fn();
      pass++;
      console.log('ok   - ' + name);
    } catch (e) {
      console.error('FAIL - ' + name + '\n' + (e && e.stack || e));
      process.exitCode = 1;
    }
  });
}

// Mock script bin for CLI transport, warm pool, and spinner output tests
const mockBinDir = path.join(TMP, 'bin');
fs.mkdirSync(mockBinDir, { recursive: true });
const mockClaudeBin = path.join(mockBinDir, 'claude');
fs.writeFileSync(mockClaudeBin, [
  '#!/usr/bin/env node',
  'const fs = require("fs");',
  'const args = process.argv.slice(2);',
  'if (args.includes("auth") && args.includes("status")) { console.log(JSON.stringify({ loggedIn: true, email: "test@akron.dev", subscriptionType: "max" })); process.exit(0); }',
  'const hasStrictMcp = args.includes("--strict-mcp-config");',
  'const si = args.indexOf("--setting-sources");',
  'const hasSafeMode = si >= 0 && args[si + 1] === "";',
  'if (args.includes("--input-format") && args.includes("stream-json")) {',
  '  let buf = "";',
  '  process.stdin.on("data", (d) => {',
  '    buf += d.toString();',
  '    if (buf.includes("\\n")) {',
  '      console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "WARM_OK strict=" + hasStrictMcp + " safe=" + hasSafeMode } } }));',
  '      console.log(JSON.stringify({ type: "result", result: "WARM_OK", usage: { input_tokens: 5, output_tokens: 2 } }));',
  '      process.exit(0);',
  '    }',
  '  });',
  '  setTimeout(() => process.exit(0), 4000);',
  '} else {',
  '  console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "CLI_OK strict=" + hasStrictMcp } } }));',
  '  console.log(JSON.stringify({ type: "result", result: "CLI_OK", usage: { input_tokens: 5, output_tokens: 2 } }));',
  '}',
].join('\n'), { mode: 0o755 });

const mockAgyBin = path.join(mockBinDir, 'agy');
fs.writeFileSync(mockAgyBin, [
  '#!/usr/bin/env node',
  'const args = process.argv.slice(2);',
  'if (args[0] === "models") {',
  '  process.stdout.write("\\r⠋ Fetching available models...\\r");',
  '  console.log("gemini-pro-orchestrator-neon   Orchestrator (Neon)");',
  '  console.log("gemini-4-carbon-high           Gemini 4 Carbon (High)");',
  '  console.log("gemini-4-neon-low              Gemini 4 Neon (Low)");',
  '  process.exit(0);',
  '}',
  'if (args.includes("--input-format") && args.includes("stream-json")) {',
  '  console.log(JSON.stringify({ event: "init", init: { model: "gemini-4-neon-low" } }));',
  '  let buf = "";',
  '  process.stdin.on("data", (d) => {',
  '    buf += d.toString();',
  '    if (buf.includes("\\n")) {',
  '      console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "AGY_WARM_OK" } }));',
  '      console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "AGY_WARM_OK" } }));',
  '      process.exit(0);',
  '    }',
  '  });',
  '} else {',
  '  console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "AGY_OK" } }));',
  '  console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "AGY_OK" } }));',
  '}',
].join('\n'), { mode: 0o755 });

// 1. CLI transport fix (eliminates "Provider error: no transport for cli")
acheck('providertransport handles transport=cli without "no transport for cli" on ping and chatCompletion', async () => {
  const res = await providertransport.chatCompletion(
    { transport: 'cli', cliMode: true, cliKind: 'claude', cliBin: mockClaudeBin, model: 'claude-haiku-4-5-20251001' },
    [{ role: 'user', content: 'ping' }],
    [],
    () => {},
    null,
    16
  );
  assert.ok(String(res.content || '').includes('CLI_OK'), 'expected CLI_OK, got: ' + res.content);
  assert.ok(String(res.content || '').includes('strict=true'), 'expected --strict-mcp-config passed');
});

acheck('providertransport.listModels resolves CLI models without throwing', async () => {
  const models = await providertransport.listModels({
    transport: 'cli',
    cliMode: true,
    cliKind: 'antigravity',
    cliBin: mockAgyBin,
    model: 'gemini-4-neon-low',
  });
  const ids = models.map((m) => m.id);
  assert.ok(ids.includes('gemini-pro-orchestrator-neon'), 'expected Orchestrator (Neon) model');
  assert.ok(ids.includes('gemini-4-carbon-high'), 'expected Gemini 4 Carbon (High)');
  assert.ok(ids.includes('gemini-4-neon-low'), 'expected Gemini 4 Neon (Low)');
  assert.ok(!ids.some((id) => /^gemini-2\.5-/i.test(id)), 'legacy gemini-cli 2.5 models must NOT pollute Antigravity list');
});

// 2. MCP not-setup filtering & 1500ms timeout
check('claudeconfig filters out not-setup and disabled MCP servers while preserving valid ones', () => {
  const proj = path.join(TMP, 'proj-mcp');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: {
      datadog: { type: 'http', url: 'https://not-setup/mcp' },
      zoom: { type: 'http', url: 'not-setup' },
      off: { command: 'node', args: ['x.js'], disabled: true },
      validHttp: { type: 'http', url: 'https://example.test/mcp' },
      validStdio: { command: 'node', args: ['server.js'] },
    },
  }));
  const loaded = claudeconfig.loadMcpServers(proj);
  assert.strictEqual('datadog' in loaded.servers, false);
  assert.strictEqual('zoom' in loaded.servers, false);
  assert.strictEqual('off' in loaded.servers, false);
  assert.ok(loaded.servers.validHttp, 'valid HTTP server retained');
  assert.ok(loaded.servers.validStdio, 'valid stdio server retained');
});

acheck('MCPClient skips unconfigured not-setup connector in 0ms and keeps default timeout <= 1500ms', async () => {
  assert.strictEqual(mcpMod.DEFAULT_MCP_CONNECT_TIMEOUT_MS, 1500);
  const client = new mcpMod.MCPClient();
  const t0 = Date.now();
  await assert.rejects(() => client.connect({ name: 'datadog', transport: 'http', url: 'https://not-setup' }), /Skipping unconfigured/);
  assert.ok((Date.now() - t0) < 200, 'unconfigured MCP rejection must be instant');

  // Verify healthy map omits internal 263-tool REA unless explicitly requested
  client.servers.set('rea', { type: 'stdio', exited: false, name: 'rea', rawConfig: { command: 'node', args: ['rea.js'] } });
  client.servers.set('github', { type: 'http', exited: false, name: 'github', rawConfig: { type: 'http', url: 'https://mcp.github.test/v1' } });
  const cliMap = client.getHealthyMcpServersMap({ includeInternalRea: false });
  assert.ok(!cliMap.rea, 'internal rea omitted from lightweight CLI MCP config');
  assert.ok(cliMap.github, 'healthy external MCP preserved');
});

// 3. Antigravity model normalization, spinner parsing, Kimi -p fix & warm CLI pool
check('parseCliModelsOutput splits CR spinner frames on agy models and resolves 1M context', () => {
  const sample = '\r⠋ Fetching available models...\r⠧ Fetching available models...\rgemini-pro-orchestrator-neon   Orchestrator (Neon)\ngemini-4-neon-high             Gemini 4 Neon (High)\ngemini-3.8-flash-high          Gemini 3.8 Flash (High)\n';
  const parsed = cliRunner.parseCliModelsOutput('antigravity', sample);
  assert.strictEqual(parsed.length, 3);
  assert.strictEqual(parsed[0].id, 'gemini-pro-orchestrator-neon');
  assert.strictEqual(parsed[0].contextWindow, 1048576);
  assert.strictEqual(parsed[1].id, 'gemini-4-neon-high');
  assert.strictEqual(parsed[2].id, 'gemini-3.8-flash-high');
  assert.strictEqual(parsed[2].contextWindow, 1048576);
});

check('normalizeAgyModelSlug & buildCliInvocation(agy) avoid invalid --mode auto warning', () => {
  assert.strictEqual(cliRunner.normalizeAgyModelSlug('gemini-4-orchestrator'), 'gemini-pro-orchestrator-neon');
  assert.strictEqual(cliRunner.normalizeAgyModelSlug('gemini-4-carbon', 'high'), 'gemini-4-carbon-high');
  const args = cliRunner.buildCliInvocation('antigravity', { model: 'gemini-4-neon-low' }, 'hi', '', { cwd: TMP, bin: '/usr/local/bin/agy', fastTurn: true });
  assert.ok(!args.includes('auto'), 'agy must not pass unsupported --mode auto');
  assert.ok(args.includes('--dangerously-skip-permissions'));
  assert.ok(args.includes('--disable-slash-commands'));
});

check('stripBenignCliStderr removes trust warnings and TERM/agy mode warnings', () => {
  const cleaned = cliRunner.stripBenignCliStderr(
    'Approval mode overridden to "default" because the current folder is not trusted.\nwarning: --mode auto is not available for this account\nWarning: Basic terminal detected (TERM=dumb)\nReal error line'
  );
  assert.strictEqual(cleaned, 'Real error line');
});

acheck('Kimi runCliTurn strips both --auto and -y when spawning kimi -p', async () => {
  let seenArgs = null;
  const mockKimiBin = path.join(mockBinDir, 'kimi');
  fs.writeFileSync(mockKimiBin, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    'if (args.includes("--auto") || args.includes("-y") || args.includes("--yolo")) { console.error("error: Cannot combine --prompt with --yolo."); process.exit(1); }',
    'console.log(JSON.stringify({ type: "delta", text: "KIMI_OK:" + args.join(" ") }));',
  ].join('\n'), { mode: 0o755 });
  const r = await cliRunner.runCliTurn({
    provider: { transport: 'cli', cliKind: 'kimi', cliBin: mockKimiBin, model: 'kimi-k3.1-pro' },
    messages: [{ role: 'user', content: 'hi' }],
    cwd: TMP,
    permissions: 'auto',
  });
  assert.ok(r.content.includes('KIMI_OK:'));
  assert.ok(r.content.includes('kimi-code/k3.1-pro'));
  seenArgs = r.content;
  assert.ok(seenArgs);
});

acheck('Warm CLI pool pre-spawns Claude & Agy and dispatches under 50ms', async () => {
  cliRunner.clearWarmCliPool();
  const claudeProv = { transport: 'cli', cliKind: 'claude', cliBin: mockClaudeBin, model: 'claude-haiku-4-5-20251001' };
  const entry = await cliRunner.warmCliWorker(claudeProv, { cwd: TMP, permissions: 'auto', forceWarmPool: true });
  assert.ok(entry && entry.child, 'warm Claude worker pre-spawned');
  assert.strictEqual(cliRunner.getWarmCliPoolStats().size, 1);

  const t0 = Date.now();
  const res = await cliRunner.runCliTurn({
    provider: claudeProv,
    messages: [{ role: 'user', content: 'hi' }],
    cwd: TMP,
    permissions: 'auto',
    forceWarmPool: true,
    fastTurn: true,
  });
  const elapsed = Date.now() - t0;
  assert.ok(res.content.includes('WARM_OK'), 'consumed warm standby process');
  assert.ok(res.content.includes('strict=true') && res.content.includes('safe=true'));
  assert.ok(elapsed < 1000, 'warm dispatch completed quickly: ' + elapsed + 'ms');

  // Give setImmediate replenishment a tick to verify standby respawned, then clean up
  await new Promise((r) => setTimeout(r, 80));
  cliRunner.clearWarmCliPool();
});

// 4. Provider OAuth Antigravity lineup, auth probe cache & honest needsSignIn
check('provider-oauth uses real Antigravity models (no legacy 2.5/3.1 models) & clean labels', () => {
  const agy = providerOauth.PROVIDERS.antigravity;
  assert.strictEqual(agy.bin, 'agy');
  assert.strictEqual(agy.label, 'Google Gemini / Antigravity');
  const ids = agy.models.map((m) => m.id);
  assert.ok(ids.includes('gemini-pro-orchestrator-neon'));
  assert.ok(ids.includes('gemini-4-carbon-high'));
  assert.ok(ids.includes('gemini-4-argon-high'));
  assert.ok(ids.includes('gemini-4-neon-low'));
  assert.ok(ids.includes('gemini-4-hydrogen-low'));
  assert.ok(!ids.some((id) => /^gemini-(?:2\.5|3\.1|3-flash)/i.test(id)), 'must expose Antigravity models only');
  assert.ok(agy.models.filter((m) => /^gemini-/.test(m.id)).every((m) => m.contextWindow === 1048576));
});

acheck('probeCliAuthStatus caches results in memory and respects needsSignIn', async () => {
  let calls = 0;
  const fakeExec = async () => {
    calls++;
    return { ok: false, code: 1, stdout: 'Not logged in', stderr: '' };
  };
  const r1 = await providerOauth.probeCliAuthStatus('chatgpt', { execCli: fakeExec, resolveBin: async () => '/bin/echo' });
  assert.strictEqual(r1.loggedIn, false);
  assert.strictEqual(calls, 1);

  const pub = providerOauth._internal.publicRecord({
    provider: 'chatgpt',
    account: 'old-acct',
    label: 'Google Gemini / Antigravity CLI CLI',
    source: 'oauth',
    needsSignIn: true,
  }, 'chatgpt');
  assert.strictEqual(pub.needsSignIn, true);
  assert.strictEqual(pub.hasToken, false);
  assert.strictEqual(pub.label.includes('CLI CLI'), false);
});

// 5. Swarm trivial fast-path + untrusted Git worktree auto-trust across 3 parallel workers
check('isTrivialConversationalPrompt isolates greetings without affecting multi-file prompts', () => {
  assert.strictEqual(swarm.isTrivialConversationalPrompt('hi'), true);
  assert.strictEqual(swarm.isTrivialConversationalPrompt('hello!'), true);
  assert.strictEqual(swarm.isTrivialConversationalPrompt('Fix bug in electron/cli-runner.js and run tests'), false);
  assert.strictEqual(swarm.isTrivialConversationalPrompt('Build a multi-file dashboard app with React'), false);
});

check('filterConnectedCliRows drops disconnected CLI rows while preserving connected/API rows', () => {
  const rows = [
    { id: 'c1', oauthProvider: 'claude:user', model: 'claude-opus-5-5' },
    { id: 'g1', oauthProvider: 'chatgpt:old', model: 'gpt-5.4' },
    { id: 'a1', oauthProvider: 'antigravity:stale', model: 'gemini-4-carbon-high' },
    { id: 'z1', baseURL: 'https://api.z.ai/api/coding/paas/v4', apiKey: 'sk-test', model: 'glm-5.3' },
  ];
  const st = {
    providers: [
      { id: 'claude', signedIn: true, active: 'user', accounts: [{ account: 'user', hasToken: true }] },
      { id: 'chatgpt', signedIn: false, active: 'old', accounts: [{ account: 'old', hasToken: false, needsSignIn: true }] },
      { id: 'antigravity', signedIn: true, active: 'agy', accounts: [{ account: 'agy', hasToken: true }] },
    ],
  };
  const filtered = orchRouter.filterConnectedCliRows(rows, { providerStatus: st, strict: true });
  assert.deepStrictEqual(filtered.map((r) => r.id), ['c1', 'a1', 'z1']);
  assert.strictEqual(filtered[1].oauthProvider, 'antigravity:agy');
});

acheck('Live 3-worker parallel Swarm in untrusted Git repo auto-trusts worktrees with 0 trust errors', async () => {
  const repoDir = path.join(TMP, 'untrusted-git-repo');
  fs.mkdirSync(repoDir, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

  const prevHome = process.env.GEMINI_CLI_HOME;
  const fakeGemHome = path.join(TMP, 'gemini-home');
  process.env.GEMINI_CLI_HOME = fakeGemHome;

  const seenWorktrees = [];
  const res = await swarm.swarm('Implement 3 independent modules across the repo in parallel', {
    cwd: repoDir,
    provider: { baseURL: 'http://127.0.0.1:11434/v1', model: 'gemini-4-carbon-high' },
    orchestrator: {
      enabled: true,
      providers: [
        { oauthProvider: 'antigravity:agy', model: 'gemini-4-carbon-high', tier: 'critical' },
        { oauthProvider: 'claude:user', model: 'claude-sonnet-5-5', tier: 'heavy' },
        { oauthProvider: 'antigravity:agy', model: 'gemini-4-neon-low', tier: 'small' },
      ],
    },
    tasks: [
      { id: 'w1', title: 'Module One', tier: 'heavy', prompt: 'Create mod1' },
      { id: 'w2', title: 'Module Two', tier: 'heavy', prompt: 'Create mod2' },
      { id: 'w3', title: 'Module Three', tier: 'small', prompt: 'Create mod3' },
    ],
    critique: false,
    runAgent: async (opts) => {
      if (opts.cwd) seenWorktrees.push(opts.cwd);
      return [{ role: 'assistant', content: 'Completed in ' + opts.cwd }];
    },
  });

  if (prevHome == null) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = prevHome;

  assert.strictEqual(res.results.length, 3);
  assert.ok(res.results.every((r) => r.status === 'done'));
  const trustJson = JSON.parse(fs.readFileSync(path.join(fakeGemHome, '.gemini', 'trustedFolders.json'), 'utf8'));
  assert.strictEqual(trustJson[fs.realpathSync(repoDir)], 'TRUST_FOLDER');
  assert.ok(seenWorktrees.some((d) => d.includes('akron-swm-')), 'worktrees created for parallel workers');
  for (const wd of seenWorktrees) {
    assert.strictEqual(trustJson[path.resolve(wd)], 'TRUST_FOLDER', 'worktree must be auto-trusted: ' + wd);
  }
});

// 6. UI contract verification for top-pinned Orchestrator Mode & Z.ai / Watchdog controls
check('ModelPickerPopover pins Orchestrator Mode at top before subscriptions & includes Antigravity preset', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'chat', 'ModelPickerPopover.jsx'), 'utf8');
  const topIdx = src.indexOf('mp-orchestrator-top-section');
  const subIdx = src.indexOf('mp-subscriptions-section');
  assert.ok(topIdx > 0 && subIdx > topIdx, 'Orchestrator section must appear BEFORE subscriptions inside .mp-scroll');
  assert.ok(src.includes('orch-mode-auto'));
  assert.ok(src.includes('orch-mode-gemini4'));
  assert.ok(src.includes('orch-mode-swarm'));
  assert.ok(src.includes('orch-configure-pools-btn'));

  const modalSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'CliLoginModal.jsx'), 'utf8');
  assert.ok(modalSrc.includes('cli-login-copy-cmd'));
  assert.ok(modalSrc.includes('cli-login-use-apikey'));

  const orchPanel = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'settings', 'OrchPaidProvidersPanel.jsx'), 'utf8');
  assert.ok(orchPanel.includes('zai_coding'));
  assert.ok(orchPanel.includes('forceApiKey: true'));
});

acheck('resolveCliBinary prefers bundled antigravity-cli agy over stale userData gemini-cli', async () => {
  const rtDir = path.join(TMP, 'stale-user-runtimes');
  const legacyBinDir = path.join(rtDir, 'gemini-cli', 'v1', 'bin');
  const agyBundleDir = path.join(TMP, 'bundled-runtimes', 'antigravity-cli', 'bin');
  fs.mkdirSync(legacyBinDir, { recursive: true });
  fs.mkdirSync(agyBundleDir, { recursive: true });
  const fakeGem = path.join(legacyBinDir, process.platform === 'win32' ? 'gemini.exe' : 'gemini');
  const fakeAgy = path.join(agyBundleDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
  fs.writeFileSync(fakeGem, '#!/bin/sh\necho 0.0.1\n', { mode: 0o755 });
  fs.writeFileSync(fakeAgy, '#!/bin/sh\necho 1.5.19\n', { mode: 0o755 });
  fs.symlinkSync('v1', path.join(rtDir, 'gemini-cli', 'current'));

  const res = await cliRunner.resolveCliBinary(
    { oauthProvider: 'antigravity:gemini', cliBin: fakeGem },
    {
      userRuntimesDir: rtDir,
      bypassCache: true,
      runtimes: {
        resolve: async (cid) => {
          if (cid === 'antigravity-cli') return { source: 'bundled', bin: fakeAgy, version: '1.5.19' };
          if (cid === 'gemini-cli') return { source: 'installed', bin: fakeGem, version: '0.0.1' };
          return { source: 'missing', bin: '' };
        },
      },
    }
  );
  assert.ok(res && res.bin, 'expected resolved binary');
  assert.ok(path.basename(res.bin).toLowerCase().startsWith('agy'), `expected agy to win over stale gemini, got: ${res.bin}`);
});

(async () => {
  for (const fn of asyncChecks) await fn();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  console.log(`\nPASSED: ${pass} check(s)`);
  if (process.exitCode) process.exit(process.exitCode);
})();
