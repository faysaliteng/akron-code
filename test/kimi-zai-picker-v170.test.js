'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const cliRunner = require('../electron/cli-runner');
const modelCatalog = require('../electron/model-catalog');
const providertransport = require('../electron/providertransport');
const orchRouter = require('../electron/orch-router');
const taskRouter = require('../electron/task-router');
const runtimesMod = require('../electron/runtimes');

test('v1.7.0 kimi-code runtime descriptor & win32/POSIX staging', async () => {
  const desc = runtimesMod.DESCRIPTORS.find((d) => d.id === 'kimi-code');
  assert.ok(desc, 'kimi-code descriptor must exist');
  assert.equal(desc.bin, 'kimi');
  assert.equal(desc.vendor, 'Moonshot AI');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-kimi-stage-'));
  try {
    const pkg = path.join(tmp, 'pkg');
    const destPosix = path.join(tmp, 'dest-posix');
    const destWin = path.join(tmp, 'dest-win');
    fs.mkdirSync(path.join(pkg, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(pkg, 'dist', 'main.mjs'), '#!/usr/bin/env node\nconsole.log("2.8.1");\n', 'utf8');
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@moonshot-ai/kimi-code', version: '2.8.1' }));

    await desc.stage(pkg, destPosix, { platform: 'darwin', arch: 'arm64' });
    assert.equal(fs.existsSync(desc.binPath(destPosix, 'darwin')), true);
    assert.equal(fs.lstatSync(path.join(destPosix, 'bin', 'kimi')).isSymbolicLink(), true);

    await desc.stage(pkg, destWin, { platform: 'win32', arch: 'x64' });
    assert.equal(fs.existsSync(path.join(destWin, 'bin', 'kimi.cmd')), true);
    assert.match(fs.readFileSync(path.join(destWin, 'bin', 'kimi.cmd'), 'utf8'), /dist\\main\.mjs/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('v1.7.0 cli-runner supports kimi invocation flags, stream-json NDJSON parsing, and zcode detection', () => {
  assert.equal(cliRunner.providerKind({ oauthProvider: 'kimi:kimi-cli', model: 'kimi-k3.1-pro' }), 'kimi');
  assert.equal(cliRunner.isCliProvider({ oauthProvider: 'kimi:kimi-cli', transport: 'cli', model: 'kimi-k3' }), true);
  assert.equal(typeof cliRunner.detectZcodeCli, 'function');

  const args = cliRunner.buildCliInvocation('kimi', { model: 'kimi-k3.1-pro' }, 'Fix bug', 'Sys', { cwd: '/tmp/proj', permissions: 'auto' });
  assert.ok(args.includes('-p'));
  assert.ok(args.includes('--output-format'));
  assert.ok(args.includes('stream-json'));
  assert.ok(args.includes('--add-dir'));
  assert.ok(args.includes('-m'));
  assert.ok(args.includes('kimi-k3.1-pro'));
  assert.ok(args.includes('--auto'));

  const state = { streamedText: '', finalText: '', resultText: '', seenToolIds: new Set(), seenAssistantIds: new Set() };
  const emitted = [];
  const deltas = [];
  cliRunner.parseNdjsonEvent(
    {
      role: 'assistant',
      reasoning_content: 'thinking step',
      content: [{ type: 'text', text: 'Kimi K3 answer' }],
      tool_calls: [{ id: 'tc1', function: { name: 'Edit', arguments: '{"file_path":"foo.js"}' } }],
    },
    state,
    (e) => emitted.push(e),
    (txt, isTh) => deltas.push({ txt, isTh }),
  );
  assert.equal(state.streamedText, 'Kimi K3 answer');
  assert.ok(deltas.some((d) => d.isTh && d.txt === 'thinking step'));
  assert.ok(emitted.some((e) => e.type === 'file_edit' && e.path === 'foo.js'));
});

test('v1.7.0 model-catalog & routers recognize Kimi K3 and Z.ai GLM-5.4 / GLM-5.3 1M context', () => {
  assert.equal(modelCatalog.contextWindowFor('kimi-k3.1-pro'), 1048576);
  assert.equal(modelCatalog.contextWindowFor('kimi-k3'), 1048576);
  assert.equal(modelCatalog.contextWindowFor('glm-5.4'), 1000000);
  assert.equal(modelCatalog.contextWindowFor('glm-5.3'), 1000000);
  assert.equal(modelCatalog.contextWindowFor('glm-5.3-flash'), 1000000);
  assert.equal(modelCatalog.thinkingCapabilitiesFor('kimi-k3.1-pro').supported, true);
  assert.equal(modelCatalog.thinkingCapabilitiesFor('glm-5.4').supported, true);

  const zaiCoding = orchRouter.ORCH_PAID_API_PRESETS.find((p) => p.id === 'zai_coding');
  assert.ok(zaiCoding, 'zai_coding preset must exist');
  assert.equal(zaiCoding.baseURL, 'https://api.z.ai/api/coding/paas/v4');
  assert.ok(zaiCoding.models.some((m) => m.id === 'glm-5.4' && m.tier === 'critical' && m.contextWindow === 1000000));
  assert.ok(zaiCoding.models.some((m) => m.id === 'glm-5.3' && m.tier === 'heavy' && m.contextWindow === 1000000));
  assert.ok(zaiCoding.models.some((m) => m.id === 'glm-5.3-flash' && m.tier === 'small' && m.contextWindow === 1000000));

  const kimiPreset = orchRouter.ORCH_PAID_API_PRESETS.find((p) => p.id === 'kimi');
  assert.ok(kimiPreset.models.some((m) => m.id === 'kimi-k3.1-pro' && m.contextWindow === 1048576));

  assert.ok(taskRouter.VENDOR_MODELS_BY_PROVIDER.kimi.includes('kimi-k3.1-pro'));
  assert.ok(taskRouter.VENDOR_MODELS_BY_PROVIDER.zai.includes('glm-5.4'));
});

test('v1.7.0 zai transport streams SSE chat + reasoning + tool calls and lists Coding Plan models', async () => {
  assert.equal(providertransport.needsTransport({ transport: 'zai' }), true);
  let lastReq = null;
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    lastReq = { url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    if (req.url === '/api/coding/paas/v4/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'glm-5.4', context_window: 1000000 }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: ' + JSON.stringify({ model: 'glm-5.4', choices: [{ delta: { reasoning_content: 'plan...' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'GLM Coding Ready' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_z1', function: { name: 'Read', arguments: '{"path":"a.js"}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n');
    res.write('data: [DONE]\n\n');
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseURL = `http://127.0.0.1:${srv.address().port}/api/coding/paas/v4`;
  try {
    const deltas = [];
    const msg = await providertransport.chatCompletion(
      { transport: 'zai', baseURL, apiKey: 'zai-test-key-123', model: 'glm-5.4', reasoningLevel: 'high' },
      [{ role: 'user', content: 'hi' }],
      [{ type: 'function', function: { name: 'Read', description: 'read', parameters: { type: 'object', properties: {} } } }],
      (txt, isReason) => deltas.push({ txt, isReason }),
    );
    assert.equal(lastReq.auth, 'Bearer zai-test-key-123');
    assert.equal(lastReq.body.model, 'glm-5.4');
    assert.deepEqual(lastReq.body.thinking, { type: 'enabled' });
    assert.equal(msg.content, 'GLM Coding Ready');
    assert.equal(msg.tool_calls[0].function.name, 'Read');
    assert.ok(deltas.some((d) => d.isReason && d.txt === 'plan...'));

    const models = await providertransport.listModels({ transport: 'zai', baseURL, apiKey: 'zai-test-key-123' });
    assert.ok(models.some((m) => m.id === 'glm-5.4' && m.contextWindow === 1000000));
    assert.ok(models.some((m) => m.id === 'glm-5.3' && m.contextWindow === 1000000));
  } finally {
    try { srv.closeAllConnections(); } catch (_) {}
    await new Promise((r) => srv.close(r));
  }
});

test('v1.7.0 startCliLogin / cancelCliLogin / signOutAccount work across all 5 CLI providers', async () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cli-login-test-'));
  const binDir = path.join(tmpHome, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  // Mock scripts per CLI bin printing URL + 8-char device code cleanly
  const mockBins = ['claude', 'codex', 'gemini', 'grok', 'kimi'];
  for (const name of mockBins) {
    const script = path.join(binDir, name);
    fs.writeFileSync(script, [
      '#!/usr/bin/env node',
      'const args = process.argv.slice(2).join(" ");',
      'if (args.includes("logout") || args.includes("remove")) { console.log("logged out"); process.exit(0); }',
      'if (args.includes("status") || args.includes("models") || args.includes("list") || args.includes("--version")) {',
      '  console.log(JSON.stringify({ loggedIn: true, providers: { kimi: { ok: true } }, email: "dev@akronlogic.com" }));',
      '  process.exit(0);',
      '}',
      'console.log("Open: https://example.com/oauth/authorize?client=test&code=1");',
      'console.log("Enter code: ABCD-EFGH");',
      'setTimeout(() => {}, 20000);',
    ].join('\n'), { mode: 0o755 });
  }

  const prevHome = process.env.AUTOBOT_HOME;
  const prevPath = process.env.PATH;
  const prevNoDlg = process.env.AKRON_NO_DIALOG;
  const prevIsolate = process.env.AKRON_ISOLATE_RUNTIMES;
  process.env.AUTOBOT_HOME = tmpHome;
  process.env.PATH = binDir + path.delimiter + prevPath;
  process.env.AKRON_NO_DIALOG = '1';
  process.env.AKRON_ISOLATE_RUNTIMES = '1';

  // Stub minimal Electron + IPC harness
  const handlers = new Map();
  const sent = [];
  const registerOauthMod = path.resolve(__dirname, '../electron/ipc/ipc-oauth-models.js');
  const electronCacheId = require.resolve('electron');
  const origElectron = require.cache[electronCacheId];
  require.cache[electronCacheId] = {
    id: electronCacheId,
    filename: electronCacheId,
    loaded: true,
    exports: { dialog: {}, shell: { openExternal: () => {} } },
  };
  delete require.cache[require.resolve('../electron/provider-oauth')];
  delete require.cache[registerOauthMod];
  const providerOauth = require('../electron/provider-oauth');
  const registerOauthModelIpc = require(registerOauthMod);

  try {
    registerOauthModelIpc({
      ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
      store: { getSettings: () => ({}) },
      secretstore: { get: () => '', set: () => {}, del: () => {} },
      freellm: {},
      providerOauth,
      providertransport,
      modelCatalog,
      orchPool: { pruneUnserved: async (p) => ({ providers: p, dropped: [] }) },
      normalizeReconnectCode: (v) => ({ ok: !!v, value: v }),
      isRetryableLine: () => false,
      winFor: () => null,
      broadcast: (msg) => sent.push(msg),
      poolNoticeDeduper: { reset: () => {}, shouldEmitPruned: () => true },
      bundledRuntimeDir: () => '',
      getRuntimes: () => ({ resolve: async (id) => ({ bin: path.join(binDir, id === 'claude-code' ? 'claude' : (id === 'kimi-code' ? 'kimi' : (id === 'gemini-cli' ? 'gemini' : id))) }) }),
      runtimePathPrefix: async () => binDir,
    });

    const startHandler = handlers.get('oauth:startCliLogin');
    const cancelHandler = handlers.get('oauth:cancelCliLogin');
    const stateHandler = handlers.get('oauth:cliLoginState');
    const fakeEvt = { sender: { isDestroyed: () => false, send: () => {} } };

    for (const pid of ['claude', 'chatgpt', 'antigravity', 'grok', 'kimi']) {
      const res = await startHandler(fakeEvt, pid, { autoOpen: false, waitMs: 1200 });
      assert.equal(res.ok, true, `${pid} startCliLogin must succeed: ${res && res.error}`);
      assert.match(res.url, /https:\/\/example\.com\/oauth\/authorize/);
      assert.equal(res.userCode, 'ABCD-EFGH');
      const st = await stateHandler(fakeEvt, pid);
      assert.equal(st.waiting, true);
      const cancelRes = await cancelHandler(fakeEvt, pid);
      assert.equal(cancelRes.cancelled, true);
    }

    // Native CLI logout test
    providerOauth.addAccount('kimi', { account: 'kimi-cli', label: 'Kimi CLI', source: 'cli' });
    const out = await providerOauth.signOutAccount('kimi', 'kimi-cli');
    assert.equal(out.ok, true);
    assert.equal(out.removed, true);
    assert.equal(out.cliLogout.ok, true);
  } finally {
    if (origElectron) require.cache[electronCacheId] = origElectron;
    else delete require.cache[electronCacheId];
    delete require.cache[require.resolve('../electron/provider-oauth')];
    delete require.cache[registerOauthMod];
    process.env.AUTOBOT_HOME = prevHome;
    process.env.PATH = prevPath;
    process.env.AKRON_NO_DIALOG = prevNoDlg;
    if (prevIsolate === undefined) delete process.env.AKRON_ISOLATE_RUNTIMES;
    else process.env.AKRON_ISOLATE_RUNTIMES = prevIsolate;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('v1.7.0 modelPickerPrefs defaults, pin/hide toggles, and reset', async () => {
  const mod = await import(pathToFileURL(path.resolve(__dirname, '../src/utils/modelPickerPrefs.js')).href);
  assert.equal(mod.DEFAULT_MODEL_PICKER_PREFS.hideUnconfiguredProviders, true);
  assert.equal(mod.DEFAULT_MODEL_PICKER_PREFS.layout, 'cards');

  let p = mod.normalizeModelPickerPrefs({});
  p = mod.togglePinnedModel(p, 'kimi:kimi-k3.1-pro');
  assert.equal(mod.isModelPinned(p, 'kimi', 'kimi-k3.1-pro'), true);
  p = mod.toggleHiddenProvider(p, 'api:groq');
  assert.ok(p.hiddenProviders.includes('api:groq'));
  p = mod.toggleHiddenModel(p, 'zai:glm-5.4');
  assert.equal(mod.isModelHidden(p, 'zai', 'glm-5.4'), true);

  const reset = mod.resetModelPickerPrefs();
  assert.equal(reset.hideUnconfiguredProviders, true);
  assert.equal(reset.pinnedModels.length, 0);
  assert.equal(reset.hiddenProviders.length, 0);
  assert.equal(reset.hiddenModels.length, 0);
});

test('v1.7.0 cli-runner resolves userData runtime over stale bundled seed & self-heals 426 Upgrade Required', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-grok-426-test-'));
  const prevIso = process.env.AKRON_ISOLATE_RUNTIMES;
  process.env.AKRON_ISOLATE_RUNTIMES = '0';
  try {
    const staleBin = path.join(tmpRoot, 'vendor', 'runtimes', 'grok', 'bin', 'grok');
    fs.mkdirSync(path.dirname(staleBin), { recursive: true });
    fs.writeFileSync(staleBin, '#!/usr/bin/env node\nconsole.error("426 Upgrade Required: please upgrade your grok cli"); process.exit(1);\n', { mode: 0o755 });

    const userRtDir = path.join(tmpRoot, 'userData', 'runtimes');
    const v1092Bin = path.join(userRtDir, 'grok', '1.0.92', 'bin', 'grok');
    fs.mkdirSync(path.dirname(v1092Bin), { recursive: true });
    fs.writeFileSync(v1092Bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"fixed after 426"}]}}));\n', { mode: 0o755 });
    fs.symlinkSync('1.0.92', path.join(userRtDir, 'grok', 'current'));
    fs.writeFileSync(path.join(userRtDir, 'grok', 'current.ptr'), '1.0.92', 'utf8');

    // Even when stale bundled path is passed in cliBin, userData 1.0.92 wins
    const resolved = await cliRunner.resolveCliBinary(
      { oauthProvider: 'grok:grok-cli', cliBin: staleBin },
      { userRuntimesDir: userRtDir }
    );
    assert.equal(resolved.source, 'installed');
    assert.equal(fs.realpathSync(resolved.bin), fs.realpathSync(v1092Bin));

    // When symlink is missing, current.ptr still resolves latest version
    fs.unlinkSync(path.join(userRtDir, 'grok', 'current'));
    const v1093Bin = path.join(userRtDir, 'grok', '1.0.93', 'bin', 'grok');
    fs.mkdirSync(path.dirname(v1093Bin), { recursive: true });
    fs.writeFileSync(v1093Bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"ok 1.0.93"}]}}));\n', { mode: 0o755 });
    fs.writeFileSync(path.join(userRtDir, 'grok', 'current.ptr'), '1.0.93', 'utf8');

    const resolvedPtr = await cliRunner.resolveCliBinary(
      { oauthProvider: 'grok:grok-cli', cliBin: staleBin },
      { userRuntimesDir: userRtDir }
    );
    assert.equal(resolvedPtr.source, 'installed');
    assert.equal(fs.realpathSync(resolvedPtr.bin), fs.realpathSync(v1093Bin));

    // 426 self-heal hook: first call fails with 426 on stale binary, triggers selfHealUpdate, retries on 1.0.92
    fs.rmSync(path.join(userRtDir, 'grok', '1.0.93'), { recursive: true, force: true });
    fs.rmSync(path.join(userRtDir, 'grok', '1.0.92'), { recursive: true, force: true });
    fs.unlinkSync(path.join(userRtDir, 'grok', 'current.ptr'));

    const notices = [];
    let healCalled = 0;
    const turnRes = await cliRunner.runCliTurn({
      provider: { oauthProvider: 'grok:grok-cli', model: 'grok-4', cliBin: staleBin },
      messages: [{ role: 'user', content: 'hi' }],
      userRuntimesDir: userRtDir,
      resolveBin: async () => (healCalled > 0 ? v1092Bin : staleBin),
      selfHealUpdate: async () => {
        healCalled++;
        fs.mkdirSync(path.dirname(v1092Bin), { recursive: true });
        fs.writeFileSync(v1092Bin, '#!/usr/bin/env node\nconsole.log(JSON.stringify({type:"assistant",message:{content:[{type:"text",text:"fixed after 426"}]}}));\n', { mode: 0o755 });
      },
      emit: (e) => { if (e && e.type === 'notice') notices.push(e.text); },
    });
    assert.equal(healCalled, 1);
    assert.ok(notices.some((n) => /426 Upgrade Required/i.test(n)));
    assert.equal(turnRes.content, 'fixed after 426');
  } finally {
    if (prevIso === undefined) delete process.env.AKRON_ISOLATE_RUNTIMES;
    else process.env.AKRON_ISOLATE_RUNTIMES = prevIso;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('v1.7.0 git plugins fast-forward auto-update preserves user config & dep-manager detects LSP updates', async () => {
  const { execFileSync } = require('child_process');
  const depManager = require('../electron/dep-manager');
  const plugins = require('../electron/plugins');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-eco-upd-'));
  const prevPluginsFile = process.env.AUTOBOT_PLUGINS_FILE;
  const prevGitDir = process.env.AUTOBOT_GIT_PLUGINS_DIR;
  const prevSkillsDir = process.env.AUTOBOT_SKILLS_DIR;
  try {
    // 1. LSP version read & update check
    const lspRoot = path.join(tmpRoot, 'lsp');
    const tsBin = path.join(lspRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'typescript-language-server.cmd' : 'typescript-language-server');
    const tsPkg = path.join(lspRoot, 'node_modules', 'typescript-language-server', 'package.json');
    fs.mkdirSync(path.dirname(tsBin), { recursive: true });
    fs.mkdirSync(path.dirname(tsPkg), { recursive: true });
    fs.writeFileSync(tsBin, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    fs.writeFileSync(tsPkg, JSON.stringify({ name: 'typescript-language-server', version: '4.1.0' }), 'utf8');

    const st = depManager.getDependenciesStatus({ lspRoot });
    const tsEntry = st.lspServers.find((x) => x.id === 'typescript');
    assert.equal(tsEntry.installed, true);
    assert.equal(tsEntry.installedVersion, '4.1.0');

    let lspUpdated = false;
    const updCheck = await depManager.checkAndUpdateInstalledLsps({
      lspRoot,
      apply: true,
      fetchRegistry: async () => ({ ok: true, version: '4.3.3', integrity: 'sha512-test' }),
      installer: async (id) => {
        lspUpdated = true;
        fs.writeFileSync(tsPkg, JSON.stringify({ name: 'typescript-language-server', version: '4.3.3' }), 'utf8');
        return { ok: true, id, version: '4.3.3' };
      },
    });
    assert.equal(lspUpdated, true);
    assert.equal(updCheck.checkedCount, 1);
    assert.equal(updCheck.updatedCount, 1);

    // 2. Git plugin clone -> remote commit -> fast-forward update preserving local config & syncing SKILL.md
    process.env.AUTOBOT_PLUGINS_FILE = path.join(tmpRoot, 'plugins.json');
    process.env.AUTOBOT_GIT_PLUGINS_DIR = path.join(tmpRoot, 'plugins-git');
    process.env.AUTOBOT_SKILLS_DIR = path.join(tmpRoot, 'skills');

    const upstreamWork = path.join(tmpRoot, 'upstream-work');
    const bareRemote = path.join(tmpRoot, 'remote.git');
    fs.mkdirSync(upstreamWork, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: upstreamWork });
    execFileSync('git', ['config', 'user.email', 'ci@akronlogic.com'], { cwd: upstreamWork });
    execFileSync('git', ['config', 'user.name', 'Akron CI'], { cwd: upstreamWork });
    fs.writeFileSync(path.join(upstreamWork, 'SKILL.md'), '---\nname: sample-git-skill\ndescription: v1\n---\n# v1\n');
    execFileSync('git', ['add', '.'], { cwd: upstreamWork });
    execFileSync('git', ['commit', '-m', 'init v1'], { cwd: upstreamWork });
    execFileSync('git', ['clone', '--bare', upstreamWork, bareRemote]);

    const installed = await plugins.installGitPlugin({
      url: bareRemote,
      id: 'sample-git-pack',
      config: { apiEndpoint: 'https://custom.local', apiKey: 'keep-me' },
    });
    assert.equal(installed.ok, true);
    assert.equal(installed.syncedSkills.length, 1);
    const sha1 = installed.entry.commitSha;

    // Push v2 upstream
    fs.writeFileSync(path.join(upstreamWork, 'SKILL.md'), '---\nname: sample-git-skill\ndescription: v2\n---\n# v2\n');
    execFileSync('git', ['add', '.'], { cwd: upstreamWork });
    execFileSync('git', ['commit', '-m', 'update v2'], { cwd: upstreamWork });
    execFileSync('git', ['push', bareRemote, 'main'], { cwd: upstreamWork });

    const checkRes = await plugins.updateAllGitPlugins({ checkOnly: true });
    assert.equal(checkRes.updatesAvailable, 1);
    assert.equal(checkRes.updatedCount, 0);

    const applyRes = await plugins.updateAllGitPlugins({ checkOnly: false });
    assert.equal(applyRes.updatedCount, 1);
    const updatedItem = plugins.listGitPlugins().find((g) => g.id === 'sample-git-pack');
    assert.notEqual(updatedItem.commitSha, sha1);
    const syncedContent = fs.readFileSync(path.join(process.env.AUTOBOT_SKILLS_DIR, 'git-sample-git-pack-sample-git-pack', 'SKILL.md'), 'utf8');
    assert.match(syncedContent, /# v2/);
    // User config preserved untouched
    assert.equal(plugins.getState().config['sample-git-pack'].apiEndpoint, 'https://custom.local');
  } finally {
    if (prevPluginsFile === undefined) delete process.env.AUTOBOT_PLUGINS_FILE;
    else process.env.AUTOBOT_PLUGINS_FILE = prevPluginsFile;
    if (prevGitDir === undefined) delete process.env.AUTOBOT_GIT_PLUGINS_DIR;
    else process.env.AUTOBOT_GIT_PLUGINS_DIR = prevGitDir;
    if (prevSkillsDir === undefined) delete process.env.AUTOBOT_SKILLS_DIR;
    else process.env.AUTOBOT_SKILLS_DIR = prevSkillsDir;
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
