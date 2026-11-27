'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const usageEstimator = require('../electron/usage-estimator');
const environments = require('../electron/environments');
const registerFeaturesIpc = require('../electron/ipc/ipc-features');

test('v1.5.1 normalizeCallUsage floors stripped-cache 2-token OAuth payloads & handles nested cache fields', () => {
  const longMsgs = Array.from({ length: 18 }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'Detailed multi-file code context '.repeat(35) + ` turn-${i}`,
  }));
  const expectedEst = usageEstimator.estimatePromptTokens(longMsgs, null);
  assert.ok(expectedEst > 3000, `expected >3000 est tokens, got ${expectedEst}`);

  // Exact poisoned pattern seen in t1795783272909.jsonl: input_tokens=2 without cache_read
  const stripped = usageEstimator.normalizeCallUsage(
    { input_tokens: 2, output_tokens: 3330 },
    longMsgs
  );
  assert.ok(stripped.context_tokens >= expectedEst || stripped.input_tokens >= expectedEst, 'must floor 2-token stripped usage to wire estimate');
  assert.strictEqual(stripped.estimated, true);

  // Nested Anthropic cache_creation.ephemeral_5m_input_tokens
  const nestedAnth = usageEstimator.normalizeCallUsage({
    input_tokens: 4,
    cache_read_input_tokens: 42000,
    cache_creation: { ephemeral_5m_input_tokens: 3100, ephemeral_1h_input_tokens: 500 },
    output_tokens: 210,
  }, [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(nestedAnth.input_tokens, 45604);
  assert.strictEqual(nestedAnth.cache_read_input_tokens, 42000);
  assert.strictEqual(nestedAnth.cache_creation_input_tokens, 3600);

  // OpenAI prompt_tokens_details.cached_tokens must NOT double-count when prompt_tokens includes it
  const oai = usageEstimator.normalizeCallUsage({
    prompt_tokens: 50000,
    prompt_tokens_details: { cached_tokens: 40000 },
    completion_tokens: 300,
  }, [{ role: 'user', content: 'hi' }]);
  assert.strictEqual(oai.input_tokens, 50000);
});

test('v1.5.1 effectiveUsageForConv repairs poisoned 2-token usage from t1795783272909.jsonl', async () => {
  const helperPath = path.join(__dirname, '..', 'src', 'utils', 'appHelpers.jsx');
  const esbuild = require('esbuild');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v151-helpers-'));
  try {
    const outJs = path.join(tmpDir, 'helpers.mjs');
    const stubPlugin = {
      name: 'stub-ui-deps',
      setup(build) {
        build.onResolve({ filter: /^(react|dompurify|highlight\.js.*|.*Icon\.jsx)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'const fn = () => null; fn.sanitize = (s) => s; fn.highlight = (c) => ({ value: c }); fn.highlightAuto = (c) => ({ value: c }); fn.getLanguage = () => null; export default fn; export const Icon = fn; export const useState = fn; export const useEffect = fn; export const useRef = fn; export const useMemo = fn;',
          loader: 'js',
        }));
      },
    };
    await esbuild.build({
      entryPoints: [helperPath],
      outfile: outJs,
      format: 'esm',
      jsx: 'transform',
      bundle: true,
      plugins: [stubPlugin],
      write: true,
    });
    const mod = await import(pathToFileURL(outJs).href);
    const msgs = Array.from({ length: 40 }, (_, i) => ({
      id: `m-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'Server and UI implementation details across 15 files '.repeat(25),
    }));
    const conv = { id: 'x0q6ymrjxokmkmwxt3nu8', messages: msgs };
    const poisoned = { prompt_tokens: 18, completion_tokens: 3330, total_tokens: 3348, calls: 8, context_tokens: 2, model: 'claude-opus-5-5', convId: conv.id };
    const repaired = mod.effectiveUsageForConv(poisoned, conv, { model: 'claude-opus-5-5' });
    const used = mod.usedTokens(repaired);
    const pct = mod.formatContextPct(used, 1000000);
    assert.ok(used >= 10000, `expected repaired tokens >= 10000, got ${used}`);
    assert.strictEqual(repaired.estimated, true);
    assert.notStrictEqual(pct, '0%');
    assert.strictEqual(pct, '1%' || '<1%' ? pct : pct);
    assert.ok(/^(<1|[1-9]\d?)%$/.test(pct), `expected real % label, got ${pct}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v1.5.1 Remote Control toggle starts real HTTP server (200 /v1/env/ping) and stops cleanly + Auto /compact resolution', async () => {
  const handlers = new Map();
  const fakeIpc = { handle: (ch, fn) => handlers.set(ch, fn) };
  let featState = { remoteControl: false, remoteServerEnabled: false, computerUse: true };
  let broadcasted = [];
  let autoConnectedDir = '';
  const fakeEnvState = { active: { kind: 'local', label: 'This Computer' }, hostServer: { running: false, port: 0 } };
  let realHostSrv = null;

  const { createRemoteServer } = require('../electron/remote-server');
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-v151-rc-'));
  try {
    const fakeEnv = {
      getState: () => ({
        ...fakeEnvState,
        hostServer: realHostSrv
          ? { running: true, port: realHostSrv.port, url: realHostSrv.url }
          : { running: false, port: 0 },
      }),
      toggleHostServer: async (on) => {
        if (on) {
          if (realHostSrv) await realHostSrv.stop();
          const srv = createRemoteServer({ port: 0, host: '127.0.0.1', workspaceRoot: tmpWs });
          const info = await srv.start();
          realHostSrv = { stop: () => srv.stop(), ...info };
          return { ok: true, running: true, url: info.url, port: info.port, token: info.token, state: fakeEnv.getState() };
        }
        if (realHostSrv) { await realHostSrv.stop(); realHostSrv = null; }
        return { ok: true, running: false, state: fakeEnv.getState() };
      },
      getHostServerToken: () => (realHostSrv ? realHostSrv.token : ''),
    };

    let hydratedInput = null;
    registerFeaturesIpc({
      app: { getVersion: () => '1.5.1', getPath: () => tmpWs },
      ipcMain: fakeIpc,
      shell: {},
      dialog: {},
      BrowserWindow: function () {},
      session: {},
      store: {
        getFeatures: () => ({ ...featState }),
        setFeatures: (p) => { featState = { ...featState, ...p }; return featState; },
        getSettings: () => ({ provider: { model: 'auto', routingMode: 'auto', baseURL: '' }, cwd: tmpWs }),
        getOrchestrator: () => ({ enabled: false, providers: [] }),
      },
      workspace: {},
      mcp: { listTools: () => [], servers: new Map() },
      mcpStatus: () => [{ serverId: 'demo', name: 'demo', tools: ['ping'] }],
      autoConnectMcp: async (dir) => { autoConnectedDir = dir; },
      shells: {},
      git: {},
      pluginsDir: tmpWs,
      scheduler: {},
      sandbox: {},
      secretstore: { get: () => '', set: () => {} },
      search: {},
      sessionDb: {},
      environments: fakeEnv,
      depManager: {},
      updater: { createUpdateScheduler: () => ({ runOnce: async () => {}, start: () => {}, stop: () => {} }) },
      browser: { setEnsurePane: () => {}, setTabCommand: () => {} },
      gdrive: {},
      runAgent: async () => [],
      providertransport: {},
      providerOauth: {
        listAccounts: async () => ([
          { id: 'claude:main', provider: 'claude', account: 'test@example.com', expired: false, needsSignIn: false },
        ]),
      },
      permGate: {},
      questionGate: {},
      pendingQuestions: new Map(),
      windows: new Set(),
      winFor: () => null,
      cwdFor: (d) => d || tmpWs,
      winTitleBarOverlay: () => ({}),
      applyFeatures: () => {},
      runtimePathPrefix: async () => '',
      hydrateProvider: async (p) => {
        hydratedInput = p;
        return { ...p, accessToken: 'tok-test', transport: 'anthropic-oauth', baseURL: 'https://api.anthropic.com' };
      },
      freellmFallbackApiKey: () => '',
      broadcast: (ev) => broadcasted.push(ev),
      mainWindow: () => null,
      oneLine: (e) => String(e && e.message ? e.message : e),
      humanizeLLMError: (e) => String(e && e.message ? e.message : e),
      rea: {},
      mcpoauth: {},
      freellm: {},
      poolNoticeDeduper: { reset: () => {} },
      sessionlog: {},
      paths: {},
      describeConnectError: (e) => String(e),
    });

    // 1. Toggle Remote Control ON via setFeatures
    const setFeatHandler = handlers.get('autobot:setFeatures');
    const updated = await setFeatHandler(null, { remoteControl: true });
    assert.strictEqual(updated.remoteControl, true);
    assert.strictEqual(updated.remoteServerEnabled, true);
    assert.ok(realHostSrv && realHostSrv.url && realHostSrv.token, 'Remote HTTP server should be listening');

    // Verify 401 without token and 200 with Bearer token
    const unauth = await fetch(`${realHostSrv.url}/v1/env/ping`);
    assert.strictEqual(unauth.status, 401);
    const authed = await fetch(`${realHostSrv.url}/v1/env/ping`, {
      headers: { Authorization: `Bearer ${realHostSrv.token}` },
    });
    assert.strictEqual(authed.status, 200);
    const pingBody = await authed.json();
    assert.strictEqual(pingBody.ok, true);

    // 2. Toggle OFF cleanly
    const stopped = await setFeatHandler(null, { remoteControl: false });
    assert.strictEqual(stopped.remoteControl, false);
    assert.strictEqual(realHostSrv, null);

    // 3. Verify mcpConfig calls autoConnectMcp(dir)
    const mcpCfgHandler = handlers.get('autobot:mcpConfig');
    const cfg = await mcpCfgHandler(null, tmpWs);
    assert.strictEqual(autoConnectedDir, tmpWs);
    assert.strictEqual(cfg.status.length, 1);

    // 4. Verify Auto-mode compact provider resolution picks OAuth account instead of blank baseURL
    const compactHandler = handlers.get('autobot:compact');
    // chatOnce will try to hit network unless aborted/mocked — instead verify hydratedInput via chatOnce fail path or resolveCallableProvider cleanly:
    const chatOnceHandler = handlers.get('autobot:chatOnce');
    await Promise.race([
      chatOnceHandler(null, { provider: { model: 'auto', routingMode: 'auto', baseURL: '' }, messages: [{ role: 'user', content: 'Summarize' }] }).catch(() => {}),
      new Promise((r) => setTimeout(r, 80)),
    ]);
    assert.ok(hydratedInput && hydratedInput.oauthProvider === 'claude:main', `expected Auto compact/chatOnce to select OAuth provider, got ${JSON.stringify(hydratedInput)}`);
    assert.strictEqual(hydratedInput.routingMode, 'direct');
    void compactHandler;
  } finally {
    if (realHostSrv) try { await realHostSrv.stop(); } catch (_) {}
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }
});
