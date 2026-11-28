'use strict';
// Regression tests for the 2026-11-28 turn-latency fix and tool gating:
//   - CLI sign-in probes are cached, de-duplicated and run in parallel, so a
//     61-row orchestrator pool no longer costs ~52s of CLI launches per turn
//   - REA stays dormant until the user asks for it
//   - the Swarm supervisor can give each worker only the tools it needs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-latency-'));
process.env.AUTOBOT_HOME = SCRATCH_HOME;

const po = require('../electron/provider-oauth');
const { isReaRequested } = require('../electron/rea-gate');
const swarmTools = require('../electron/swarm-tools');
const swarm = require('../electron/swarm');
const { hydrateOrchestrator } = require('../electron/orch-hydrate');

const I = po._internal;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function installProbeHook({ loggedIn = () => true, delayMs = 0 } = {}) {
  const calls = [];
  I.setAuthProbeTestHook(async (provId) => {
    calls.push(provId);
    if (delayMs) await sleep(delayMs);
    return { ok: true, bin: '/fake/' + provId, loggedIn: Boolean(loggedIn(provId)), account: provId + '-cli', label: provId, plan: 'CLI Subscription' };
  });
  return calls;
}

test.afterEach(() => {
  I.setAuthProbeTestHook(null);
  po.invalidateAuthProbeCache();
});

test('sign-in probe: repeated turn-path syncs launch each CLI once', async () => {
  const calls = installProbeHook({ loggedIn: (id) => id !== 'chatgpt' });
  const n = po.providerIds().length;
  await po.syncCliAccounts();
  assert.strictEqual(calls.length, n, 'first sync probes every provider once');
  // What a turn does: statusAll + one auto-heal per failing pool row.
  for (let i = 0; i < 10; i++) await po.autoHealAll({ importMissing: true, silent: true });
  await po.statusAll();
  assert.strictEqual(calls.length, n, 'no further CLI launches while the answer is fresh');
});

test('sign-in probe: concurrent callers share one launch per provider', async () => {
  const calls = installProbeHook({ delayMs: 25 });
  await Promise.all([po.syncCliAccounts(), po.syncCliAccounts(), po.probeCliAuthStatus('claude'), po.probeCliAuthStatus('claude')]);
  assert.strictEqual(calls.filter((c) => c === 'claude').length, 1);
  assert.strictEqual(calls.length, po.providerIds().length);
});

test('sign-in probe: providers are probed in parallel, not one after another', async () => {
  installProbeHook({ delayMs: 60 });
  const t0 = Date.now();
  await po.syncCliAccounts();
  const took = Date.now() - t0;
  assert.ok(took < 60 * 3, `expected ~60ms for a parallel sync, took ${took}ms`);
});

test('sign-in probe: a stale answer is served at once and refreshed in the background', async () => {
  const calls = installProbeHook({ delayMs: 40 });
  await po.probeCliAuthStatus('grok');
  assert.strictEqual(calls.length, 1);
  I.ageAuthProbeCache(I.AUTH_PROBE_CACHE_TTL_MS + 1000);
  const t0 = Date.now();
  const res = await po.probeCliAuthStatus('grok');
  assert.ok(Date.now() - t0 < 30, 'stale answer must not wait for the CLI');
  assert.strictEqual(res.loggedIn, true);
  await sleep(80);
  assert.strictEqual(calls.length, 2, 'one background refresh');
  I.ageAuthProbeCache(I.AUTH_PROBE_STALE_OK_MS + 1000);
  await po.probeCliAuthStatus('grok');
  assert.strictEqual(calls.length, 3, 'an answer older than the stale window is re-probed');
});

test('sign-in probe: force and explicit user actions always re-probe', async () => {
  const calls = installProbeHook();
  await po.probeCliAuthStatus('kimi');
  await po.probeCliAuthStatus('kimi');
  assert.strictEqual(calls.length, 1);
  await po.probeCliAuthStatus('kimi', { force: true });
  assert.strictEqual(calls.length, 2);
  await po.importLocal('kimi');
  assert.strictEqual(calls.length, 3, 'Import is an explicit user action');
});

test('sign-in probe: a signed-out provider is recorded once and not re-probed per pool row', async () => {
  const calls = installProbeHook({ loggedIn: (id) => id !== 'chatgpt' });
  po.addAccount('chatgpt', { account: 'team', label: 'ChatGPT', source: 'cli' });
  await po.syncCliAccounts();
  const rec = po.getAccount('chatgpt', 'team');
  assert.strictEqual(rec && rec.needsSignIn, true);
  const before = calls.length;
  const rows = Array.from({ length: 5 }, (_, i) => ({ oauthProvider: 'chatgpt:team', model: 'gpt-' + i }));
  const hydrate = async (row) => {
    try { return await po.resolve(row.oauthProvider); } catch (_) {
      await po.autoHealAll({ importMissing: true, silent: true });
      return po.resolve(row.oauthProvider);
    }
  };
  const { dead } = await hydrateOrchestrator({ enabled: true, providers: rows, activeIndex: 0 }, hydrate);
  assert.strictEqual(dead.length, 5, 'signed-out rows are reported, not silently kept');
  assert.strictEqual(calls.length, before, 'no CLI launches for 5 failing rows');
});

test('REA gate: dormant unless the user asks for it', () => {
  for (const t of ['hi', 'how fast you can reply', 'read the area and create a real file', 'already ready']) {
    assert.strictEqual(isReaRequested(t), false, t);
  }
  for (const t of ['use rea on this binary', 'Use REA plugin', '(rea)', 'rea-agents please', 'call mcp__rea__open_binary', 'please decompile libfoo.so']) {
    assert.strictEqual(isReaRequested(t), true, t);
  }
  assert.strictEqual(isReaRequested([{ role: 'system', content: 'REA is built in.' }, { role: 'user', content: 'hi' }]), false,
    'a system prompt describing REA must not switch it on');
  assert.strictEqual(isReaRequested([{ role: 'user', content: [{ type: 'text', text: 'use rea' }] }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'continue' }]), true,
    'once asked for, REA stays available for the conversation');
  assert.strictEqual(isReaRequested(null), false);
});

test('swarm tools: an untagged worker keeps the default surface', () => {
  const r = swarmTools.resolveWorkerTools(null, { mcpTools: [{ name: 'mcp__rea__open_binary' }] });
  assert.strictEqual(r.toolAllow, null);
  assert.deepStrictEqual(r.extraTools, []);
});

test('swarm tools: capability groups, MCP servers and exact names resolve', () => {
  const builtin = require('../electron/tools').toolDefinitions.map((t) => t.name);
  const mcpTools = [{ name: 'mcp__rea__open_binary' }, { name: 'mcp__rea__list_strings' }, { name: 'mcp__linear__list_issues' }];
  const ctx = { mcpTools, builtinToolNames: builtin };

  const research = swarmTools.resolveWorkerTools(['read', 'web'], ctx);
  assert.ok(research.toolAllow.has('WebSearch') && research.toolAllow.has('Read'));
  assert.ok(!research.toolAllow.has('Write') && !research.toolAllow.has('Bash'), 'a research worker gets no write/shell tools');
  assert.deepStrictEqual(research.extraTools, []);

  const build = swarmTools.resolveWorkerTools(['read', 'edit', 'shell'], ctx);
  assert.ok(build.toolAllow.has('Write') && build.toolAllow.has('Bash') && !build.toolAllow.has('WebSearch'));
  assert.ok(build.toolAllow.size < builtin.length / 4, 'far fewer than the full built-in surface');

  const re = swarmTools.resolveWorkerTools(['mcp:rea'], ctx);
  assert.deepStrictEqual(re.extraTools.map((t) => t.name), ['mcp__rea__open_binary', 'mcp__rea__list_strings']);
  assert.ok(re.toolAllow.has('mcp__rea__open_binary') && !re.toolAllow.has('mcp__linear__list_issues'));
  assert.ok(re.toolAllow.has('rea'), 'the built-in gateway of the same name rides along');

  const browser = swarmTools.resolveWorkerTools(['browser'], ctx);
  assert.ok(browser.toolAllow.has('browser_navigate') && browser.toolAllow.has('mcp__chrome__navigate'));

  assert.strictEqual(swarmTools.resolveWorkerTools(['all'], ctx).toolAllow, null);
  const junk = swarmTools.resolveWorkerTools(['nonsense'], ctx);
  assert.strictEqual(junk.toolAllow, null, 'an unusable spec falls back to the default surface');
  assert.deepStrictEqual(junk.unknown, ['nonsense']);
  for (const core of swarmTools.CORE_TOOLS) assert.ok(research.toolAllow.has(core), core);
});

test('swarm plan: the supervisor can tag subtasks with tools', () => {
  const plan = swarm.normalizePlan({ subtasks: [
    { title: 'research', prompt: 'look it up', tools: ['read', 'web'] },
    { title: 'build', prompt: 'write it', tools: 'read, edit, shell' },
    { title: 'default', prompt: 'whatever' },
  ] });
  assert.deepStrictEqual(plan.subtasks.map((t) => t.tools), [['read', 'web'], ['read', 'edit', 'shell'], null]);
  assert.ok(swarm.SUPERVISOR_PLAN_PROMPT.includes('"tools" is optional'));
  assert.ok(swarm.SUPERVISOR_PLAN_PROMPT.includes('"tools":["read","edit","shell"]'));
});

test('swarm run: a tagged worker is launched with only its tools', async () => {
  const launches = [];
  const runAgent = async (o) => {
    launches.push(o);
    return [{ role: 'assistant', content: 'done' }];
  };
  const provider = { model: 'test-model', baseURL: 'http://localhost:9/v1', apiKey: 'k' };
  await swarm.swarm('do two things', {
    runAgent,
    provider,
    critique: false,
    worktreeIsolation: 'off',
    tasks: [
      { title: 'research', prompt: 'look it up', tools: ['read', 'web', 'mcp:rea'] },
      { title: 'anything', prompt: 'do it' },
    ],
    mcpTools: [{ name: 'mcp__rea__open_binary', description: 'x', inputSchema: { type: 'object' } }, { name: 'mcp__linear__list_issues' }],
    builtinToolNames: ['Read', 'Write', 'Bash', 'WebSearch', 'WebFetch', 'rea'],
  });
  const tagged = launches.find((o) => o.toolAllow instanceof Set && o.toolAllow.has('WebSearch'));
  assert.ok(tagged, 'the tagged worker received a tool allowlist');
  assert.ok(!tagged.toolAllow.has('Write') && !tagged.toolAllow.has('Bash'));
  const extraNames = tagged.extraTools.map((t) => t.name);
  assert.ok(extraNames.includes('mcp__rea__open_binary') && !extraNames.includes('mcp__linear__list_issues'));
  const untagged = launches.find((o) => !o.toolAllow && Array.isArray(o.extraTools) && o.localTools);
  assert.ok(untagged, 'the untagged worker keeps the default surface');
  assert.ok(!untagged.extraTools.some((t) => /^mcp__/.test(t.name)), 'and is not handed MCP tools it did not ask for');
});

// ---- CLI turns end on the model's final message, not on process exit ----
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const cliRunner = require('../electron/cli-runner');

function fakeCli(lines, { exitAfterMs = 5000, gapMs = 5 } = {}) {
  const spawned = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.killed = true; };
    spawned.push(child);
    (async () => {
      for (const l of lines) { await sleep(gapMs); child.stdout.write(JSON.stringify(l) + '\n'); }
      await sleep(exitAfterMs);
      child.exitCode = 0;
      child.emit('close', 0);
    })();
    return child;
  };
  return { spawnImpl, spawned };
}
const cliProvider = (kind, bin) => ({ cliKind: kind, cliBin: bin, transport: 'cli', cliMode: true, model: kind === 'claude' ? 'claude-sonnet-5' : 'gemini-3.8-flash-low' });

test('CLI turn: Claude ends at the top-level end_turn, not when the CLI exits', async () => {
  const lines = [
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'sub ' } }, parent_tool_use_id: 'toolu_x' },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, parent_tool_use_id: 'toolu_x' },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi there' } }, parent_tool_use_id: null },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 3 } }, parent_tool_use_id: null },
    { type: 'system', subtype: 'post_turn_summary' },
  ];
  const { spawnImpl } = fakeCli(lines, { exitAfterMs: 3000 });
  const t0 = Date.now();
  const res = await cliRunner.runCliTurn({ provider: cliProvider('claude', process.execPath), messages: [{ role: 'user', content: 'hi' }], spawnImpl, cwd: os.tmpdir() });
  assert.ok(Date.now() - t0 < 1000, `resolved after ${Date.now() - t0}ms; must not wait for the CLI to exit`);
  assert.ok(String(res.content).includes('Hi there'));
  assert.strictEqual(res.usage.output_tokens, 3);
});

test('CLI turn: a sub-agent end_turn or a tool_use stop does not end the turn early', async () => {
  const lines = [
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, parent_tool_use_id: 'toolu_sub' },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' } }, parent_tool_use_id: null },
  ];
  const { spawnImpl } = fakeCli(lines, { exitAfterMs: 300 });
  const t0 = Date.now();
  await cliRunner.runCliTurn({ provider: cliProvider('claude', process.execPath), messages: [{ role: 'user', content: 'hi' }], spawnImpl, cwd: os.tmpdir() }).catch(() => {});
  assert.ok(Date.now() - t0 >= 300, 'waited for the process because the turn never ended');
});

test('CLI turn: Antigravity ends on a successful result; a failed result still errors', async () => {
  const ok = fakeCli([
    { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Hello!' } },
    { event: 'result', result: { status: 'SUCCESS', response: 'Hello!' } },
  ], { exitAfterMs: 3000 });
  const t0 = Date.now();
  const res = await cliRunner.runCliTurn({ provider: cliProvider('antigravity', '/fake/agy'), messages: [{ role: 'user', content: 'hi' }], spawnImpl: ok.spawnImpl, cwd: os.tmpdir() });
  assert.ok(Date.now() - t0 < 1000);
  assert.strictEqual(res.content, 'Hello!');

  const bad = fakeCli([{ event: 'result', result: { status: 'ERROR', error: 'quota exceeded (429)' } }], { exitAfterMs: 50 });
  await assert.rejects(
    cliRunner.runCliTurn({ provider: cliProvider('antigravity', '/fake/agy'), messages: [{ role: 'user', content: 'hi' }], spawnImpl: bad.spawnImpl, cwd: os.tmpdir() }),
    /quota exceeded/,
  );
});

test('CLI MCP servers: only the servers the user names are started', () => {
  const sel = cliRunner.selectMcpServersForPrompt;
  const servers = { paradev: { url: 'x' }, 'paradev-docs': { url: 'y' }, linear: { url: 'z' } };
  assert.deepStrictEqual(Object.keys(sel(servers, 'hi')), []);
  assert.deepStrictEqual(Object.keys(sel(servers, 'how fast can you reply')), []);
  assert.deepStrictEqual(Object.keys(sel(servers, 'open my paradev workspace')).sort(), ['paradev', 'paradev-docs']);
  assert.deepStrictEqual(Object.keys(sel(servers, 'check Linear issues')), ['linear']);
  assert.deepStrictEqual(Object.keys(sel(servers, 'use the MCP tools')).sort(), ['linear', 'paradev', 'paradev-docs']);
  assert.deepStrictEqual(Object.keys(sel(servers, undefined)).sort(), ['linear', 'paradev', 'paradev-docs'], 'no prompt = unchanged behaviour');
  const a = cliRunner.writeIsolatedMcpConfigFile({ mcpServers: servers, prompt: 'hi' });
  const b = cliRunner.writeIsolatedMcpConfigFile({ mcpServers: servers, prompt: 'use paradev' });
  assert.notStrictEqual(a, b, 'different server sets never share a config file');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(a, 'utf8')), { mcpServers: {} });
});

test('CLI turn: an HTML file written by a CLI model opens in Akron preview, once, only after the write succeeds', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-prev-'));
  const page = path.join(dir, 'counter.html');
  fs.writeFileSync(page, '<p>hi</p>');
  const lines = [
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_w1', name: 'Write', input: { file_path: page, content: '<p>hi</p>' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w1', content: 'File created' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_w2', name: 'Write', input: { file_path: path.join(dir, 'broken.html'), content: 'x' } }] }, parent_tool_use_id: null },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_w2', content: 'EACCES', is_error: true }] } },
    { type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'end_turn' } }, parent_tool_use_id: null },
  ];
  const { spawnImpl } = fakeCli(lines, { exitAfterMs: 50 });
  const events = [];
  await cliRunner.runCliTurn({ provider: cliProvider('claude', process.execPath), messages: [{ role: 'user', content: 'make a page' }], spawnImpl, cwd: dir, emit: (e) => events.push(e) });
  const previews = events.filter((e) => e.type === 'preview');
  assert.deepStrictEqual(previews.map((e) => e.url), [page]);
});

test('Claude CLI never gets the claude.ai publishing tools', () => {
  const args = cliRunner.buildCliInvocation('claude', { model: 'claude-sonnet-5' }, 'hi', 'sys', { cwd: os.tmpdir() });
  assert.ok(args.includes('--disallowedTools=Artifact,ArtifactComments,ArtifactData'), 'equals form, so the variadic flag cannot swallow the prompt');
});

test('provider gate: out of credit on one model skips every model on that account', () => {
  const gate = require('../electron/provider-gate');
  gate.reset();
  const a = { oauthProvider: 'grok:grok-cli', model: 'grok-4-fast' };
  const b = { oauthProvider: 'grok:grok-cli', model: 'grok-4.7' };
  const other = { oauthProvider: 'claude:me', model: 'claude-sonnet-5' };
  gate.markAccountDead(a, 'out of credit', 60000);
  assert.strictEqual(gate.isDead(b), true);
  assert.strictEqual(gate.deadReason(b), 'out of credit');
  assert.strictEqual(gate.isDead(other), false);
  gate.ok(b);
  assert.strictEqual(gate.isDead(b), false, 'a success on the account clears it');
  gate.reset();
});

test('dev server detection: only a server running inside the project counts', { skip: process.platform === 'win32' }, async () => {
  const { spawn } = require('node:child_process');
  const devserver = require('../electron/devserver');
  const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akron-dev-')));
  const other = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akron-other-')));
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ scripts: { dev: 'node server.js' } }));
  const srv = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('ok')).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd: proj, stdio: ['ignore', 'pipe', 'ignore'] });
  try {
    const port = await new Promise((resolve, reject) => {
      srv.stdout.once('data', (d) => resolve(Number(String(d).trim())));
      srv.once('error', reject);
    });
    const mine = await devserver.detect(proj);
    assert.strictEqual(mine.running, true);
    assert.strictEqual(mine.port, port);
    assert.strictEqual(mine.framework, 'dev server', 'no framework guessed from the port when package.json exists');
    const theirs = await devserver.detect(other);
    assert.strictEqual(theirs.running, false, 'another project must not claim this server');
  } finally {
    srv.kill();
  }
});

test('secret store: never needs the OS keychain at launch; old keychain records move to the app key once', () => {
  const { spawnSync } = require('node:child_process');
  const crypto = require('node:crypto');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-sec-'));
  // A record as Chromium's mock keychain would have written it ("v10" + AES-128-CBC, key from "peanuts").
  const key = crypto.pbkdf2Sync('peanuts', 'saltysalt', 1003, 16, 'sha1');
  const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const enc = Buffer.concat([Buffer.from('v10'), c.update('legacy-secret'), c.final()]).toString('base64');
  fs.writeFileSync(path.join(home, 'secrets.json'), JSON.stringify({ old: { enc: 'safeStorage', v: enc } }));
  const script = `
    const ss = require('./electron/secretstore');
    const first = ss.migrateLegacySafeStorage();
    const second = ss.migrateLegacySafeStorage();
    ss.set('fresh', 'new-secret');
    console.log(JSON.stringify({ first, second, list: ss.list(), old: ss.get('old'), fresh: ss.get('fresh'), status: ss.status() }));`;
  const r = spawnSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, AUTOBOT_HOME: home }, encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.deepStrictEqual(out.first, { migrated: 1, remaining: 0 });
  assert.deepStrictEqual(out.second, { migrated: 0, remaining: 0 }, 'nothing left to migrate on the next launch');
  assert.ok(out.list.every((x) => x.enc === 'aes-256-gcm'), 'no record stays keychain-encrypted');
  assert.strictEqual(out.old, 'legacy-secret');
  assert.strictEqual(out.fresh, 'new-secret');
  assert.strictEqual(out.status.backend, 'aes-256-gcm-fallback');
  fs.rmSync(home, { recursive: true, force: true });
});

test('swarm worktrees: worker changes land uncommitted unless auto-commit is opted in', async () => {
  const { execFileSync } = require('node:child_process');
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const mk = (label) => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akron-wt-' + label + '-')));
    git(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
    git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'base');
    const wt = repo + '-wt';
    git(repo, 'worktree', 'add', '-q', '-b', 'swm-w1', wt, 'HEAD');
    fs.writeFileSync(path.join(wt, 'b.txt'), 'BETA\n');
    git(wt, 'add', '.'); git(wt, 'commit', '-qm', 'swarm: w1');
    return { repo, wt, done: [{ name: 'w1', status: 'done', result: 'ok', worktree: { branch: 'swm-w1', path: wt, gitRoot: repo } }] };
  };

  const a = mk('plain');
  const headBefore = git(a.repo, 'rev-parse', 'HEAD');
  const outA = await swarm.reconcileWorkerWorktrees(a.done, a.repo, () => {});
  assert.strictEqual(fs.readFileSync(path.join(a.repo, 'b.txt'), 'utf8'), 'BETA\n');
  assert.strictEqual(git(a.repo, 'rev-parse', 'HEAD'), headBefore, 'no commit added to the user branch');
  assert.match(git(a.repo, 'status', '--porcelain'), /\?\? b\.txt/);
  assert.strictEqual(git(a.repo, 'branch', '--list', 'swm-*'), '', 'temporary worker branch removed');
  assert.strictEqual(outA.merged.length, 1);

  const b = mk('commit');
  const before = git(b.repo, 'rev-parse', 'HEAD');
  await swarm.reconcileWorkerWorktrees(b.done, b.repo, () => {}, { autoCommit: true });
  assert.notStrictEqual(git(b.repo, 'rev-parse', 'HEAD'), before, 'opt-in still merges with a commit');
  for (const d of [a.repo, a.wt, b.repo, b.wt]) fs.rmSync(d, { recursive: true, force: true });
});

test('keychain policy: no login/keyring prompt on builds the OS cannot remember', () => {
  const kp = require('../electron/keychain-policy');
  const fakeApp = () => ({ isPackaged: true, sw: [], commandLine: { appendSwitch(...a) { fakeApp.last.sw.push(a.join('=')); } } });
  const run = (opts) => { const a = fakeApp(); fakeApp.last = a; const r = kp.apply(a, opts); return { r, sw: a.sw }; };
  let x = run({ platform: 'darwin', env: {}, teamId: '' });
  assert.strictEqual(x.r.keychain, 'mock'); assert.deepStrictEqual(x.sw, ['use-mock-keychain']);
  x = run({ platform: 'darwin', env: {}, teamId: 'ABCDE12345' });
  assert.strictEqual(x.r.keychain, 'real', 'Developer ID builds keep the real keychain'); assert.deepStrictEqual(x.sw, []);
  x = run({ platform: 'darwin', env: { AKRON_USE_SAFE_STORAGE: '1' }, teamId: '' });
  assert.strictEqual(x.r.keychain, 'real');
  x = run({ platform: 'linux', env: {} });
  assert.strictEqual(x.r.keychain, 'basic'); assert.deepStrictEqual(x.sw, ['password-store=basic']);
  x = run({ platform: 'win32', env: {} });
  assert.strictEqual(x.r.keychain, 'os-default'); assert.deepStrictEqual(x.sw, []);
  assert.strictEqual(kp.bundlePathOf('/Applications/Akron Code.app/Contents/MacOS/Akron Code'), '/Applications/Akron Code.app');
});

test('agy: no --effort next to a model slug that already carries the effort', () => {
  const cr = require('../electron/cli-runner');
  const bin = '/x/agy';
  const withSuffix = cr.buildCliInvocation('antigravity', { model: 'claude-opus-5-5-low', reasoningLevel: 'high' }, 'hi', '', { cwd: '/tmp', bin });
  assert.ok(withSuffix.includes('claude-opus-5-5-low'));
  assert.ok(!withSuffix.includes('--effort'), withSuffix.join(' '));
  const bare = cr.buildCliInvocation('antigravity', { model: 'gemini-pro-orchestrator', reasoningLevel: 'high' }, 'hi', '', { cwd: '/tmp', bin });
  assert.ok(!bare.includes('--effort'));
});

test('CLI models can ask Akron for a Swarm with an <akron-swarm> plan', () => {
  const { parseCliSwarmRequest } = require('../electron/llm');
  const plan = parseCliSwarmRequest('<akron-swarm>{"goal":"build app","tasks":[{"title":"api","prompt":"write the API"},{"prompt":"write the UI"}]}</akron-swarm>');
  assert.strictEqual(plan.goal, 'build app');
  assert.strictEqual(plan.tasks.length, 2);
  assert.strictEqual(plan.tasks[1].title, 'write the UI');
  assert.deepStrictEqual(parseCliSwarmRequest('<akron-swarm>```json\n{"goal":"x"}\n```</akron-swarm>'), { goal: 'x' });
  assert.deepStrictEqual(parseCliSwarmRequest('<akron-swarm>split the refactor</akron-swarm>'), { goal: 'split the refactor' });
  assert.strictEqual(parseCliSwarmRequest('Hi! 4'), null);
  assert.deepStrictEqual(parseCliSwarmRequest('<akron-swarm>{"tasks":[]}</akron-swarm>', 'user goal'), { goal: 'user goal' });
});

test('swarm: the DeepSeek Flash dispatcher picks the supervisor among usable frontier models', async () => {
  const swarm = require('../electron/swarm');
  const roster = [{ model: 'claude-opus-5-5', frontier: true }, { model: 'gemini-4-neon-high', frontier: true }, { model: 'small-x', frontier: false }];
  const taskRouter = { dispatchWithDeepSeekFlash: async ({ availableModels }) => ({ model: availableModels[1] }) };
  const picked = await swarm.pickSupervisorWithDispatcher('build it', roster, { autoRouterConfig: { hasKey: true }, taskRouter });
  assert.strictEqual(picked && picked.model, 'gemini-4-neon-high');
  assert.strictEqual(await swarm.pickSupervisorWithDispatcher('x', roster, { autoRouterConfig: { hasKey: false }, taskRouter }), null);
  const bogus = { dispatchWithDeepSeekFlash: async () => ({ model: 'not-available' }) };
  assert.strictEqual(await swarm.pickSupervisorWithDispatcher('x', roster, { autoRouterConfig: { hasKey: true }, taskRouter: bogus }), null);
});

test('Windows: child processes start hidden (no console window flashes)', () => {
  const { install } = require('../electron/win-hide-console');
  const seen = [];
  const fake = { spawn: (...a) => seen.push(a), execFile: (...a) => seen.push(a), execFileSync: (...a) => seen.push(a) };
  assert.strictEqual(install({ platform: 'darwin', target: fake }), false);
  assert.strictEqual(install({ platform: 'win32', target: fake }), true);
  assert.strictEqual(install({ platform: 'win32', target: fake }), false); // once only
  fake.spawn('git', ['status'], { cwd: 'C:/x' });
  fake.execFile('agy.exe', ['--version'], () => {});
  fake.execFileSync('git', ['diff'], { windowsHide: false });
  assert.strictEqual(seen[0][2].windowsHide, true);
  assert.strictEqual(seen[0][2].cwd, 'C:/x');
  assert.strictEqual(seen[1][2].windowsHide, true);
  assert.strictEqual(typeof seen[1][3], 'function');
  assert.strictEqual(seen[2][2].windowsHide, false); // an explicit choice is kept
});

test('a failed turn keeps its reason in the conversation (not only a 5s toast)', () => {
  const esbuild = require('esbuild');
  const raw = fs.readFileSync(path.join(__dirname, '..', 'src/hooks/useSessionRuns.js'), 'utf8');
  const code = esbuild.transformSync(raw, { loader: 'jsx', format: 'cjs' }).code;
  const mod = { exports: {} };
  const req = (s) => (s === 'react' ? { useCallback: (f) => f, useRef: (v) => ({ current: v }), useState: (i) => [i, () => {}] }
    : s.endsWith('appHelpers.jsx') ? { uid: () => 'id1' } : require(s));
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports);
  const { buildCommittedAssistantMessage } = mod.exports;
  const empty = { live: { content: '', tools: [], segments: [] }, startedAt: Date.now() };
  assert.strictEqual(buildCommittedAssistantMessage(empty), null);
  const failed = buildCommittedAssistantMessage(empty, 'no provider is configured');
  assert.ok(failed && /This reply failed:\*\* no provider is configured/.test(failed.content));
  assert.strictEqual(failed.error, 'no provider is configured');
  const partial = buildCommittedAssistantMessage({ live: { content: 'Half an answer', tools: [], segments: [{ type: 'text', text: 'Half an answer' }] } }, 'timed out');
  assert.ok(partial.content.startsWith('Half an answer\n\n⚠️'));
  assert.strictEqual(partial.segments.length, 2);
});
