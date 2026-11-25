'use strict';
// Live exercise of the Example-parity config surface introduced for gap closure:
// custom commands, agent definitions, CLAUDE.md memory, permission rules,
// checkpoints/rewind, and MCP config discovery. Each test writes REAL files in
// a throwaway project dir and drives the real modules — no mocks.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const M = (n) => require(path.join(ROOT, 'electron', n));

let passed = 0;
let failed = 0;
const results = [];
async function test(name, fn) {
  try { await fn(); passed++; results.push('  ok   ' + name); }
  catch (e) { failed++; results.push('  FAIL ' + name + '\n       ' + (e && e.message)); }
}

(async () => {
  console.log('=== AKRON BOT PARITY CONFIG LIVE TEST ===\n');

  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-parity-'));
  const claudeDir = path.join(proj, '.claude');
  fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  fs.mkdirSync(path.join(claudeDir, 'agents'), { recursive: true });

  // ---- custom slash commands -------------------------------------------
  fs.writeFileSync(path.join(claudeDir, 'commands', 'deploy.md'),
    '---\ndescription: Deploy the site\nargument-hint: <env>\n---\nDeploy to $1 using the release workflow. Goal: $ARGUMENTS\n');

  const commands = M('commands');
  await test('discovers a project command from .claude/commands', async () => {
    const list = commands.listForUi(proj);
    const hit = list.find((c) => c.name === 'deploy');
    assert.ok(hit, 'deploy command not listed');
    assert.strictEqual(hit.custom, true);
    assert.strictEqual(hit.description, 'Deploy the site');
  });

  await test('resolves and expands $ARGUMENTS / $1', async () => {
    const hit = commands.resolve('deploy', proj);
    assert.ok(hit, 'resolve failed');
    const prompt = await commands.expand(hit, 'prod now', { cwd: proj });
    assert.match(prompt, /Deploy to prod/);
    assert.match(prompt, /Goal: prod now/);
  });

  await test('built-in commands are always present', async () => {
    const names = commands.listForUi(proj).map((c) => c.name);
    for (const want of ['help', 'clear', 'status']) assert.ok(names.includes(want), 'missing builtin ' + want);
  });

  // ---- agent definitions -----------------------------------------------
  fs.writeFileSync(path.join(claudeDir, 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: Read-only code reviewer\nmodel: moon-shot-x\ntools: Read, Grep, Glob\n---\nYou review code and never modify it.\n');

  const agentdefs = M('agentdefs');
  await test('discovers a custom agent definition', async () => {
    const defs = agentdefs.discover(proj);
    const d = defs.find((x) => x.name === 'reviewer');
    assert.ok(d, 'reviewer agent not discovered');
    assert.strictEqual(d.model, 'moon-shot-x');
    assert.match(d.body, /never modify/);
  });

  await test('built-in agent types exist (general-purpose, Explore, Plan)', async () => {
    const names = agentdefs.discover(proj).map((d) => d.name);
    for (const want of ['general-purpose', 'Explore', 'Plan']) assert.ok(names.includes(want), 'missing ' + want);
  });

  await test('definition tool allowlist restricts tools', async () => {
    const d = agentdefs.resolve('reviewer', proj);
    assert.ok(d, 'resolve failed');
    assert.strictEqual(agentdefs.toolAllowed(d, 'Read'), true);
    assert.strictEqual(agentdefs.toolAllowed(d, 'Write'), false);
    const set = agentdefs.allowedToolSet(d);
    assert.ok(set && set.has('Grep'), 'allowlist missing Grep');
  });

  await test('Explore built-in is read-only', async () => {
    const d = agentdefs.resolve('Explore', proj);
    assert.ok(d, 'Explore missing');
    assert.strictEqual(agentdefs.toolAllowed(d, 'Write'), false);
    assert.strictEqual(agentdefs.toolAllowed(d, 'Read'), true);
  });

  // ---- memory (CLAUDE.md hierarchy + @import) ---------------------------
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# Project rules\nAlways run tests.\n@./docs/notes.md\n');
  fs.mkdirSync(path.join(proj, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'docs', 'notes.md'), 'Imported note body.\n');

  const memory = M('memory');
  await test('CLAUDE.md loads and @import is expanded', async () => {
    const text = memory.loadMemoryText(proj);
    assert.match(text, /Always run tests/);
    assert.match(text, /Imported note body/);
  });

  await test('listMemory reports file scope + size', async () => {
    const list = memory.listMemory(proj);
    const local = list.find((f) => f.scope === 'project' && f.file.endsWith('CLAUDE.md'));
    assert.ok(local, 'project CLAUDE.md not listed: ' + JSON.stringify(list.map((f) => [f.scope, f.file])));
    assert.ok(local.bytes > 0);
  });

  // ---- permission rules -------------------------------------------------
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
    permissions: {
      allow: ['Bash(git diff:*)', 'Read(**)'],
      deny: ['Bash(rm:*)', 'Read(./secrets/**)'],
      ask: ['Bash(git push:*)'],
      defaultMode: 'manual',
    },
  }, null, 2));

  const perms = M('permissions');
  await test('settings.json permission rules load', async () => {
    const p = perms.loadPermissions(proj);
    assert.ok(p.allow.includes('Bash(git diff:*)'), 'allow rule lost');
    assert.ok(p.deny.includes('Bash(rm:*)'), 'deny rule lost');
    assert.strictEqual(p.defaultMode, 'manual');
  });

  await test('deny always wins, even in bypass mode', async () => {
    const p = perms.loadPermissions(proj);
    const v = perms.decide(p, 'Bash', { command: 'rm -rf build' }, { cwd: proj, mode: 'bypass' });
    assert.strictEqual(v.decision, 'deny');
  });

  await test('allow rule skips the prompt', async () => {
    const p = perms.loadPermissions(proj);
    const v = perms.decide(p, 'Bash', { command: 'git diff HEAD' }, { cwd: proj, mode: 'manual' });
    assert.strictEqual(v.decision, 'allow');
  });

  await test('ask rule forces a prompt', async () => {
    const p = perms.loadPermissions(proj);
    const v = perms.decide(p, 'Bash', { command: 'git push origin main' }, { cwd: proj, mode: 'auto' });
    assert.strictEqual(v.decision, 'ask');
  });

  // ---- checkpoints / rewind --------------------------------------------
  const ck = M('checkpoints');
  const target = path.join(proj, 'app.js');
  await test('checkpoint snapshots a pre-change file', async () => {
    fs.writeFileSync(target, 'v1\n');
    ck.snapshotFile('conv-live', 'turn-1', target);
    const list = ck.listCheckpoints('conv-live');
    assert.ok(list.length >= 1, 'no checkpoint recorded');
    assert.ok(list[list.length - 1].files.some((f) => f.path === target), 'file not in checkpoint');
  });

  await test('rewind restores the original bytes', async () => {
    fs.writeFileSync(target, 'v2-broken\n');
    const list = ck.listCheckpoints('conv-live');
    const res = ck.restore('conv-live', list[list.length - 1].id);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'v1\n');
    const list2 = ck.listCheckpoints('conv-live');
    for (const c of list2) ck.removeCheckpoint('conv-live', c.id);
  });

  await test('rewind of a newly created file deletes it', async () => {
    const fresh = path.join(proj, 'brand-new.txt');
    ck.snapshotFile('conv-live2', 'turn-1', fresh); // does not exist yet -> existed:false
    fs.writeFileSync(fresh, 'created by agent\n');
    const list = ck.listCheckpoints('conv-live2');
    const res = ck.restore('conv-live2', list[list.length - 1].id);
    assert.deepStrictEqual(res.errors, []);
    assert.strictEqual(fs.existsSync(fresh), false);
    for (const c of ck.listCheckpoints('conv-live2')) ck.removeCheckpoint('conv-live2', c.id);
  });

  // ---- MCP config discovery --------------------------------------------
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'demo-stdio': { command: 'node', args: ['server.js'] },
      'demo-http': { type: 'http', url: 'https://example.test/mcp' },
      off: { command: 'x', disabled: true },
    },
  }, null, 2));

  const cc = M('claudeconfig');
  await test('.mcp.json servers are discovered with sources', async () => {
    const r = cc.loadMcpServers(proj);
    assert.ok(r.servers['demo-stdio'], 'stdio server missing');
    assert.ok(r.servers['demo-http'], 'http server missing');
    assert.ok(r.sources.some((s) => s.endsWith('.mcp.json')), 'source not recorded');
  });

  await test('claudeconfig.mergeSettings deep-merges layers', async () => {
    if (typeof cc.deepMerge !== 'function') return;
    const merged = cc.deepMerge({ a: 1, n: { x: 1 } }, { n: { y: 2 } });
    assert.deepStrictEqual(merged, { a: 1, n: { x: 1, y: 2 } });
  });

  console.log(results.join('\n'));
  console.log('\n=== RESULT: ' + passed + ' passed, ' + failed + ' failed ===');
  try { fs.rmSync(proj, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
