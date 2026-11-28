'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autobot-copilot-test-'));
process.env.AUTOBOT_HOME = TMP_HOME;
process.env.AKRON_NO_DIALOG = '1';
process.env.AKRON_ISOLATE_RUNTIMES = '1';

const providerOauth = require('../electron/provider-oauth');
const cliRunner = require('../electron/cli-runner');
const modelCatalog = require('../electron/model-catalog');
const providertransport = require('../electron/providertransport');
const registerOauthModelIpc = require('../electron/ipc/ipc-oauth-models');

test.after(() => {
  try { cliRunner.clearWarmCliPool(); } catch (_) {}
  try { fs.rmSync(TMP_HOME, { recursive: true, force: true }); } catch (_) {}
});

test('provider-oauth copilot catalog, alias resolution, encrypted PAT bearer & cliMode', async () => {
  const cop = providerOauth.provider('copilot');
  assert.ok(cop);
  assert.equal(cop.id, 'copilot');
  assert.equal(cop.cliId, 'github-copilot');
  assert.equal(cop.bin, 'copilot');
  assert.equal(cop.kind, 'cli');
  assert.equal(cop.transport, 'cli');
  assert.ok(cop.models.length >= 6);
  assert.equal(providerOauth.provider('github-copilot').id, 'copilot');
  assert.equal(providerOauth.provider('github').id, 'copilot');

  const rec = await providerOauth.addBearer('copilot:github-pat', 'github_pat_test_secret_123');
  assert.equal(rec.source, 'api-key');

  const rawDb = fs.readFileSync(path.join(TMP_HOME, 'provider-oauth.json'), 'utf8');
  assert.equal(rawDb.includes('github_pat_test_secret_123'), false);

  const pub = providerOauth._internal.publicRecord(rec);
  assert.equal(pub.cliMode, true);

  const resolved = await providerOauth.resolve('copilot');
  assert.equal(resolved.transport, 'cli');
  assert.equal(resolved.cliMode, true);
  assert.equal(resolved.copilotToken, 'github_pat_test_secret_123');

  providerOauth.removeAccount('copilot:github-pat');
});

test('cli-runner normalizeCopilotModelSlug, getCopilotMcpFlags, buildCliInvocation & stripBenignCliStderr', () => {
  assert.equal(cliRunner.normalizeCopilotModelSlug('copilot-auto'), 'auto');
  assert.equal(cliRunner.normalizeCopilotModelSlug('copilot-claude-opus-4-6'), 'claude-opus-4.6');
  assert.equal(cliRunner.normalizeCopilotModelSlug('copilot-claude-sonnet-4-5'), 'claude-sonnet-4.5');
  assert.equal(cliRunner.normalizeCopilotModelSlug('copilot-gpt-5-4'), 'gpt-5.4');
  assert.equal(cliRunner.normalizeCopilotModelSlug('copilot-gpt-5'), 'gpt-5');
  assert.equal(cliRunner.normalizeCopilotModelSlug('copilot-gemini-3-1-pro'), 'gemini-3.1-pro');

  const cfgFile = path.join(TMP_HOME, 'mcp-config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ mcpServers: { rea: { command: 'node' }, custom: { command: 'node' } } }));

  const normalFlags = cliRunner.getCopilotMcpFlags('hello summarize this file', { copilotMcpConfig: cfgFile });
  assert.ok(normalFlags.includes('--no-auto-update'));
  assert.ok(normalFlags.includes('--disable-builtin-mcps'));
  assert.ok(normalFlags.includes('--disable-mcp-server'));
  assert.ok(normalFlags.includes('rea'));
  assert.ok(normalFlags.includes('custom'));

  const reFlags = cliRunner.getCopilotMcpFlags('please reverse engineer and decompile libfoo.so', { copilotMcpConfig: cfgFile });
  assert.ok(reFlags.includes('--disable-mcp-server'));
  assert.equal(reFlags.includes('rea'), false);
  assert.ok(reFlags.includes('custom'));

  const yoloArgs = cliRunner.buildCliInvocation(
    'copilot',
    { id: 'copilot', model: 'copilot-claude-opus-4-6', reasoningLevel: 'high' },
    'Explain this diff',
    '',
    { cwd: TMP_HOME, permissions: 'auto' },
  );
  assert.equal(yoloArgs[0], '-p');
  assert.ok(yoloArgs.includes('--output-format'));
  assert.equal(yoloArgs[yoloArgs.indexOf('--output-format') + 1], 'json');
  assert.ok(yoloArgs.includes('--no-color'));
  assert.ok(yoloArgs.includes('--no-auto-update'));
  assert.ok(yoloArgs.includes('--disable-builtin-mcps'));
  assert.ok(yoloArgs.includes('--yolo'));
  assert.equal(yoloArgs[yoloArgs.indexOf('--model') + 1], 'claude-opus-4.6');
  assert.equal(yoloArgs[yoloArgs.indexOf('--reasoning-effort') + 1], 'high');

  const planArgs = cliRunner.buildCliInvocation(
    'copilot',
    { id: 'copilot', model: 'copilot-auto' },
    'Plan this change',
    '',
    { cwd: TMP_HOME, permissions: 'plan' },
  );
  assert.ok(planArgs.includes('--plan'));

  const stripped = cliRunner.stripBenignCliStderr([
    'Warning: Basic terminal detected',
    'AI Credits 0.00',
    'Changes +0 -0',
    'To authenticate, visit https://github.com/login/device',
    'Actual fatal error line',
  ].join('\n'));
  assert.equal(stripped, 'Actual fatal error line');
});

test('cli-runner parseNdjsonEvent handles copilot JSONL deltas, toolRequests & auto_mode_resolved', () => {
  const deltas = [];
  const evts = [];
  const state = {
    model: 'copilot-auto',
    streamedText: '',
    finalText: '',
    resultText: '',
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    seenToolIds: new Set(),
    seenAssistantIds: new Set(),
    cliError: '',
    rateLimitError: '',
  };

  cliRunner.parseNdjsonEvent(
    { type: 'session.auto_mode_resolved', data: { availableModels: ['claude-opus-4.6', 'gpt-5.4'] } },
    state,
    (e) => evts.push(e),
    (d, th) => deltas.push({ d, th }),
  );
  const copWin = modelCatalog.contextWindowFor('copilot-claude-opus-4-6', 'copilot');
  assert.ok(copWin >= 200000);

  cliRunner.parseNdjsonEvent(
    { type: 'assistant.message_delta', data: { deltaContent: 'Hello ' } },
    state,
    (e) => evts.push(e),
    (d, th) => deltas.push({ d, th }),
  );
  cliRunner.parseNdjsonEvent(
    {
      type: 'assistant.message',
      data: {
        model: 'claude-opus-4.6',
        content: 'Hello world',
        toolRequests: [{ toolCallId: 'tc-1', name: 'edit_file', arguments: { path: '/tmp/a.js' } }],
      },
    },
    state,
    (e) => evts.push(e),
    (d, th) => deltas.push({ d, th }),
  );

  assert.equal(state.streamedText, 'Hello ');
  assert.equal(state.model, 'claude-opus-4.6');
  assert.ok(evts.some((e) => e.type === 'tool_use' && e.id === 'tc-1' && e.name === 'edit_file'));
  assert.ok(evts.some((e) => e.type === 'file_edit' && e.path === '/tmp/a.js'));
});

test('cli-runner persistent copilot --acp warm pool drives initialize -> session/new -> session/prompt', async () => {
  const mockBin = path.join(TMP_HOME, 'mock-copilot-acp');
  fs.writeFileSync(mockBin, `#!/usr/bin/env node
const readline = require('readline');
if (process.argv.includes('--version')) {
  console.log('GitHub Copilot CLI 1.0.117');
  process.exit(0);
}
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let req;
  try { req = JSON.parse(s); } catch (_) { return; }
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { protocolVersion: 1 } }) + '\\n');
  } else if (req.method === 'session/new') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { sessionId: 'acp-sess-42' } }) + '\\n');
  } else if (req.method === 'session/prompt') {
    const sid = req.params && req.params.sessionId;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'COPILOT_ACP_OK' } } } }) + '\\n');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: { stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } } }) + '\\n');
  }
});
`);
  fs.chmodSync(mockBin, 0o755);

  const mockRuntimes = {
    resolve: async () => ({ bin: mockBin, source: 'installed' }),
  };
  const prov = { id: 'copilot', kind: 'cli', model: 'copilot-auto' };
  const warm = await cliRunner.warmCliWorker(prov, {
    cwd: TMP_HOME,
    forceWarmPool: true,
    runtimes: mockRuntimes,
  });
  assert.ok(warm);
  assert.equal(warm.protocol, 'copilot-acp');
  const sid = await warm.acpReadyPromise;
  assert.equal(sid, 'acp-sess-42');

  const deltas = [];
  const res = await cliRunner.runCliTurn({
    provider: prov,
    messages: [{ role: 'user', content: 'Say COPILOT_ACP_OK' }],
    cwd: TMP_HOME,
    forceWarmPool: true,
    runtimes: mockRuntimes,
    onDelta: (txt, isThinking) => deltas.push({ txt, isThinking }),
  });

  assert.equal(res.content, 'COPILOT_ACP_OK');
  assert.equal(res.usage.total_tokens, 16);
  assert.ok(deltas.some((d) => d.isThinking === true && d.txt === 'thinking...'));
  assert.ok(deltas.some((d) => d.isThinking === false && d.txt === 'COPILOT_ACP_OK'));
  await new Promise((r) => setImmediate(r));
  cliRunner.clearWarmCliPool();
});

test('oauth:startCliLogin for copilot extracts github device URL & 8-char code', async () => {
  const electronCacheId = require.resolve('electron');
  const origElectron = require.cache[electronCacheId];
  require.cache[electronCacheId] = {
    id: electronCacheId,
    filename: electronCacheId,
    loaded: true,
    exports: { dialog: {}, shell: { openExternal: () => {} } },
  };
  const mockLoginBin = path.join(TMP_HOME, 'mock-copilot-login');
  fs.writeFileSync(mockLoginBin, `#!/usr/bin/env node
console.log('To authenticate, visit https://github.com/login/device and enter code 1FA2-BB14');
setTimeout(() => {}, 1500);
`);
  fs.chmodSync(mockLoginBin, 0o755);

  const handlers = new Map();
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
      broadcast: () => {},
      poolNoticeDeduper: { reset: () => {}, shouldEmitPruned: () => true },
      bundledRuntimeDir: () => '',
      getRuntimes: () => ({ resolve: async () => ({ bin: mockLoginBin }) }),
      runtimePathPrefix: async () => TMP_HOME,
    });

    const startHandler = handlers.get('oauth:startCliLogin');
    const cancelHandler = handlers.get('oauth:cancelCliLogin');
    const fakeEvt = { sender: { isDestroyed: () => false, send: () => {} } };

    const res = await startHandler(fakeEvt, 'copilot', { autoOpen: false, forceInteractive: true, waitMs: 1200 });
    assert.equal(res.ok, true);
    assert.equal(res.provider, 'copilot');
    assert.equal(res.url, 'https://github.com/login/device');
    assert.equal(res.userCode, '1FA2-BB14');
    assert.equal(res.waiting, true);
    assert.equal(res.cliCommand, 'copilot login --device-code');

    const cancelled = await cancelHandler(fakeEvt, 'copilot');
    assert.equal(cancelled.cancelled, true);
  } finally {
    if (origElectron) require.cache[electronCacheId] = origElectron;
    else delete require.cache[electronCacheId];
  }
});
