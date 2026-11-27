'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { pathToFileURL } = require('node:url');

const REPO = path.resolve(__dirname, '..');

test('1. syncStandaloneExtension upgrades legacy Documents/AkronBrowserBot in lockstep', () => {
  const installer = require(path.join(REPO, 'electron/browser-ext-installer'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ext-sync-'));
  const legacyDir = path.join(home, 'Documents', 'AkronBrowserBot');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: '__MSG_appName__',
    version: '1.6.7',
    default_locale: 'en',
    background: { service_worker: 'background/service-worker.js', type: 'module' },
  }));

  try {
    const res = installer.syncStandaloneExtension({ homeDir: home, platform: 'darwin' });
    assert.equal(res.ok, true);
    assert.equal(res.version, '1.6.13');
    assert.ok(res.syncedExtraDirs.includes(legacyDir));

    const primaryManifest = JSON.parse(fs.readFileSync(path.join(res.extensionDir, 'manifest.json'), 'utf8'));
    const legacyManifest = JSON.parse(fs.readFileSync(path.join(legacyDir, 'manifest.json'), 'utf8'));
    assert.equal(primaryManifest.version, '1.6.13');
    assert.equal(legacyManifest.version, '1.6.13');
    assert.equal(legacyManifest.key, primaryManifest.key);

    const legacyTools = fs.readFileSync(path.join(legacyDir, 'background', 'tools.js'), 'utf8');
    assert.match(legacyTools, /case "close_tab":/);
    const legacySw = fs.readFileSync(path.join(legacyDir, 'background', 'service-worker.js'), 'utf8');
    assert.match(legacySw, /sidepanel_status/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('2a. extbridge ensureConnectedOrShared never self-routes to shared when server owns port', async () => {
  const extbridge = require(path.join(REPO, 'electron/extbridge'));
  const { state, ensureConnectedOrShared } = extbridge._internal;
  const saved = {
    running: state.running,
    server: state.server,
    shared: state.shared,
    activeSocket: state.activeSocket,
  };
  try {
    state.running = true;
    state.server = { dummy: true };
    state.shared = false;
    state.activeSocket = null;
    setTimeout(() => {
      state.activeSocket = { readyState: 1 };
    }, 150);
    const modeReconnected = await ensureConnectedOrShared();
    assert.equal(modeReconnected, 'direct');

    state.activeSocket = null;
    const modeDisconnected = await ensureConnectedOrShared();
    assert.equal(modeDisconnected, 'none');
  } finally {
    state.running = saved.running;
    state.server = saved.server;
    state.shared = saved.shared;
    state.activeSocket = saved.activeSocket;
  }
});

test('2b. browser background tools allow fromBridge close_tab & switch_tab outside taskTabIds', async () => {
  const removed = [];
  const fakeTab = { id: 799399994, url: 'https://example.com', title: 'Example Domain', windowId: 1 };
  globalThis.chrome = {
    tabs: {
      get: async (id) => (id === 799399994 ? fakeTab : { id, url: 'https://google.com', windowId: 1 }),
      remove: async (id) => { removed.push(id); },
      update: async (id, patch) => ({ ...fakeTab, ...patch }),
      query: async () => [fakeTab, { id: 799399993, url: 'https://google.com', windowId: 1 }],
    },
    debugger: {
      detach: async () => {},
    },
    runtime: { lastError: null },
  };
  try {
    const toolsMod = await import(pathToFileURL(path.join(REPO, 'resources/akron-browser-bot/background/tools.js')).href);
    const ctx = {
      tabId: 799399993,
      fromBridge: true,
      taskTabIds: [799399993],
      addToGroup: async () => null,
      settings: { permissionMode: 'allow_all' },
      emit: () => {},
      confirm: async () => ({ approved: true }),
    };
    const sw = await toolsMod.executeTool('switch_tab', { tabId: 799399994 }, ctx);
    assert.equal(sw.tabId, 799399994);
    const cl = await toolsMod.executeTool('close_tab', { tabId: 799399994 }, ctx);
    assert.equal(cl.closedTabId, 799399994);
    assert.deepEqual(removed, [799399994]);
  } finally {
    delete globalThis.chrome;
  }
});

test('3. ShadowCheck supports explicit path/files and ignores broken JSON in temp scratch dir', async () => {
  const { runShadowCheck } = require(path.join(REPO, 'electron/ide/edit-guard'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-shadow-'));
  const mjsFile = path.join(dir, 'akron-cap-test.mjs');
  const badMjsFile = path.join(dir, 'bad.mjs');
  const badJsonFile = path.join(dir, 'access_path_counts.json');
  fs.writeFileSync(mjsFile, 'export const fib = (n) => (n <= 1 ? n : fib(n - 1) + fib(n - 2));\n');
  fs.writeFileSync(badMjsFile, 'export const broken = (;\n');
  fs.writeFileSync(badJsonFile, '{not-valid-json');

  try {
    const okByPath = await runShadowCheck(dir, { path: mjsFile });
    assert.equal(okByPath.ok, true, okByPath.summary);

    const okByFileAsCwd = await runShadowCheck(mjsFile);
    assert.equal(okByFileAsCwd.ok, true, okByFileAsCwd.summary);

    const failBadMjs = await runShadowCheck(dir, { path: badMjsFile });
    assert.equal(failBadMjs.ok, false);

    // Scanning the shared OS tmpdir itself skips stray broken JSON files.
    const osTmpBroken = path.join(os.tmpdir(), `akron-stray-${Date.now()}.json`);
    fs.writeFileSync(osTmpBroken, '{broken');
    try {
      const scanTmp = await runShadowCheck(os.tmpdir());
      assert.doesNotMatch(scanTmp.summary, new RegExp(path.basename(osTmpBroken)));
    } finally {
      try { fs.unlinkSync(osTmpBroken); } catch (_) {}
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('4. runAgent auto-continue halts on blocked TodoWrite instead of repeating 8 times', async () => {
  const llm = require(path.join(REPO, 'electron/llm'));
  let reqCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      reqCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (reqCount === 1) {
        res.end(JSON.stringify({
          id: 'c1',
          model: 'mock-auto',
          choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{
                id: 'tc_todo',
                type: 'function',
                function: {
                  name: 'TodoWrite',
                  arguments: JSON.stringify({
                    todos: [
                      { id: '1', content: 'Swarm', status: 'completed' },
                      { id: '2', content: 'Close tab', status: 'in_progress' },
                    ],
                  }),
                },
              }],
            },
          }],
        }));
        return;
      }
      res.end(JSON.stringify({
        id: 'c' + reqCount,
        model: 'mock-auto',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: {
            role: 'assistant',
            content: 'Manual step needed: close tab 799399994 in Brave by hand. Final scorecard: 8 of 13 pass.',
          },
        }],
      }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await llm.runAgent({
      provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'mock-auto' },
      messages: [{ role: 'user', content: 'Run check' }],
      permissionMode: 'auto',
      useMemory: false,
      maxSteps: 16,
      emit: () => {},
    });
    assert.ok(reqCount <= 2, `Expected immediate halt on explicit manual blocker without looping, got ${reqCount} calls`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('5a. runAgent hydrates baseURL-less / token-less providerList rows via opts.hydrateProvider', async () => {
  const llm = require(path.join(REPO, 'electron/llm'));
  let seenAuth = '';
  const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization || '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: 'h1',
      model: 'claude-sonnet-5-5',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hydrated OK' } }],
    }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const out = await llm.runAgent({
      provider: { model: 'claude-sonnet-5-5', oauthProvider: 'custom:acct', routingMode: 'direct' },
      hydrateProvider: async (p) => ({
        ...p,
        baseURL: `http://127.0.0.1:${port}/v1`,
        accessToken: 'tok-hydrated-163',
        transport: 'openai',
      }),
      messages: [{ role: 'user', content: 'ping' }],
      permissionMode: 'auto',
      useMemory: false,
      emit: () => {},
    });
    assert.equal(seenAuth, 'Bearer tok-hydrated-163');
    const last = [...out].reverse().find((m) => m.role === 'assistant');
    assert.equal(last.content, 'Hydrated OK');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('5b. swarm upgrades non-frontier supervisor to frontier and synthesizes tool-only worker summary', async () => {
  const swarmMod = require(path.join(REPO, 'electron/swarm'));
  const seenModels = [];
  const res = await swarmMod.swarm('Verify single file syntax', {
    provider: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'claude-fable-5-2', tier: 'critical' },
    orchestrator: {
      enabled: true,
      providers: [
        { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'claude-fable-5-2', tier: 'critical' },
        { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'claude-sonnet-5-5', tier: 'heavy' },
      ],
    },
    supervisor: { baseURL: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'claude-haiku-5-5', tier: 'small' },
    tasks: [{ id: 't1', title: 'Worker 1', prompt: 'Check mjs', tier: 'heavy' }],
    monitor: false,
    critique: true,
    runAgent: async ({ provider, toolAllow, messages }) => {
      seenModels.push(provider.model);
      const userTxt = String(messages[0]?.content || '');
      if (!toolAllow) {
        return [
          { role: 'user', content: userTxt },
          { role: 'assistant', content: '', tool_calls: [{ id: 's1', type: 'function', function: { name: 'ShadowCheck', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 's1', name: 'ShadowCheck', content: 'PASS [syntax-scan]\nChecked 1 target file — no syntax errors detected.' },
          { role: 'assistant', content: '' },
        ];
      }
      return [{ role: 'assistant', content: 'Synthesis OK' }];
    },
  });

  assert.equal(res.supervisor && res.supervisor.model, 'claude-fable-5-2', `Expected frontier upgrade, got ${JSON.stringify(res.supervisor)}`);
  assert.deepEqual(seenModels, ['claude-sonnet-5-5', 'claude-fable-5-2']);
  assert.ok(Array.isArray(res.results) && res.results.length === 1);
  assert.doesNotMatch(res.results[0].result, /worker finished with no text/);
  assert.match(res.results[0].result, /Completed 1 tool step\(s\):/);
  assert.match(res.results[0].result, /ShadowCheck: PASS \[syntax-scan\]/);
});
