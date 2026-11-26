'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const permissions = require(path.join(ROOT, 'electron', 'permissions'));
const { createPermissionGate } = require(path.join(ROOT, 'electron', 'perm-gate'));
const { runTool } = require(path.join(ROOT, 'electron', 'tools'));

function loadEsmModule(relPath) {
  const fullPath = path.join(ROOT, relPath);
  const src = fs.readFileSync(fullPath, 'utf8');
  const out = esbuild.transformSync(src, {
    loader: relPath.endsWith('.jsx') ? 'jsx' : 'js',
    format: 'cjs',
    target: 'node20',
  });
  const mod = { exports: {} };
  const reactStub = {
    default: { createElement: () => null },
    useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
  };
  const fn = new Function('require', 'module', 'exports', out.code);
  fn((id) => (id === 'react' ? reactStub : require(id)), mod, mod.exports);
  return mod.exports;
}

const { describePermissionRequest } = loadEsmModule('src/components/PermissionDock.jsx');
const {
  filterQueueForConv,
  pickNextRunnableQueued,
  moveQueueItem,
  stepQueueItemWithinConv,
} = loadEsmModule('src/components/MessageQueueTray.jsx');
const typography = loadEsmModule('src/typography.js');

const results = [];
async function runTest(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ok   - ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.error('  FAIL - ' + name + ': ' + (e && e.stack ? e.stack : e));
  }
}

(async () => {
  console.log('\nPermission Gate, Advanced Queue & Typography unit suite');

  await runTest('electron/perm-gate.js & main.js do not enforce a 300s silent permission auto-deny timeout', async () => {
    const gateSrc = fs.readFileSync(path.join(ROOT, 'electron', 'perm-gate.js'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'electron', 'main.js'), 'utf8');
    assert.strictEqual(gateSrc.includes('300000'), false, 'perm-gate.js must not have a 300000ms auto-deny timeout');
    assert.strictEqual(mainSrc.includes('pendingPermissions'), false, 'main.js must delegate permissions to permGate');
  });

  await runTest('createPermissionGate handles FIFO concurrent prompts and unknown IDs', async () => {
    const events = [];
    const gate = createPermissionGate();
    const p1 = gate.prompt({ runId: 'r1', convId: 'c1', toolName: 'Bash', args: { command: 'lsof -i :3000' }, emit: (e) => events.push(e) });
    const p2 = gate.prompt({ runId: 'r1', convId: 'c1', toolName: 'mcp__rea__inspect_analysis_view', args: { path: '/bin' }, emit: (e) => events.push(e) });

    assert.strictEqual(gate.pendingCount(), 2);
    assert.strictEqual(events.filter((e) => e.type === 'permission').length, 2);
    const id1 = events[0].id;
    const id2 = events[1].id;
    assert.strictEqual(events[0].suggestedRule, 'Bash(lsof:*)');
    assert.strictEqual(events[1].suggestedRule, 'mcp__rea__inspect_analysis_view');

    const bad = gate.answer('missing_id', { allow: true });
    assert.strictEqual(bad.ok, false);

    const a1 = gate.answer(id1, { allow: true, scope: 'once' });
    assert.strictEqual(a1.ok, true);
    assert.strictEqual((await p1).allow, true);
    assert.strictEqual(gate.pendingCount(), 1);

    const a2 = gate.answer(id2, { allow: false, feedback: 'Skip binary analysis' });
    assert.strictEqual(a2.ok, true);
    const res2 = await p2;
    assert.strictEqual(res2.allow, false);
    assert.strictEqual(res2.feedback, 'Skip binary analysis');
    assert.strictEqual(gate.pendingCount(), 0);
    assert.strictEqual(events.filter((e) => e.type === 'permissionCleared').length, 2);
  });

  await runTest('AbortController.abort() and clearRun() immediately clear waiting permission prompts', async () => {
    const events = [];
    const gate = createPermissionGate();
    const ac = new AbortController();
    const p1 = gate.prompt({ runId: 'r_abort', convId: 'c1', toolName: 'Bash', args: { command: 'git status' }, signal: ac.signal, emit: (e) => events.push(e) });
    assert.strictEqual(gate.pendingCount('r_abort'), 1);

    ac.abort();
    const r1 = await p1;
    assert.strictEqual(r1.allow, false);
    assert.strictEqual(r1.aborted, true);
    assert.strictEqual(gate.pendingCount('r_abort'), 0);
    assert.ok(events.some((e) => e.type === 'permissionCleared' && e.reason === 'aborted'));

    const p2 = gate.prompt({ runId: 'r_clear', convId: 'c1', toolName: 'Edit', args: { file_path: 'src/App.jsx' }, cwd: ROOT, emit: (e) => events.push(e) });
    const cleared = gate.clearRun('r_clear', 'run_ended');
    assert.strictEqual(cleared.length, 1);
    const r2 = await p2;
    assert.strictEqual(r2.allow, false);
    assert.strictEqual(r2.cleared, true);
  });

  await runTest('conversation allow memory and safe persisted always-allow rules (isolated temp file)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-perm-test-'));
    const settingsPath = path.join(tmpDir, 'settings.json');
    try {
      const gate = createPermissionGate({
        savePermissionRule: ({ rule, list }) => permissions.savePermissionRule({ rule, list, settingsPath }),
      });
      const emitted = [];
      const pConv = gate.prompt({ runId: 'r1', convId: 'conv_mem', toolName: 'Bash', args: { command: 'lsof -i :8766' }, emit: (e) => emitted.push(e) });
      gate.answer(emitted[0].id, { allow: true, scope: 'conversation' });
      await pConv;

      assert.strictEqual(gate.checkConversationAllow('conv_mem', 'Bash', { command: 'lsof -n' }), 'Bash(lsof:*)');
      assert.strictEqual(gate.checkConversationAllow('other_conv', 'Bash', { command: 'lsof -n' }), null);
      assert.strictEqual(fs.existsSync(settingsPath), false, 'conversation allow must not write to disk');

      const pAlways = gate.prompt({ runId: 'r2', convId: 'conv_mem', toolName: 'mcp__rea__binary_overview', args: {}, emit: (e) => emitted.push(e) });
      const ansAlways = gate.answer(emitted.find((e) => e.tool === 'mcp__rea__binary_overview').id, { allow: true, scope: 'always' });
      await pAlways;
      assert.strictEqual(ansAlways.rule, 'mcp__rea__binary_overview');
      const disk = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepStrictEqual(disk.permissions.allow, ['mcp__rea__binary_overview']);

      const rmRes = permissions.removePermissionRule({ rule: 'mcp__rea__binary_overview', list: 'allow', settingsPath });
      assert.strictEqual(rmRes.removed, true);
      const diskAfter = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.deepStrictEqual(diskAfter.permissions.allow, []);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await runTest('suggestSafeAllowRule scopes safe commands and blocks dangerous/chained commands', async () => {
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'lsof -i :8080' }, ROOT), 'Bash(lsof:*)');
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'git status --short' }, ROOT), 'Bash(git status:*)');
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'echo ok && rm -rf /tmp/foo' }, ROOT), null);
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'rm -rf dist' }, ROOT), null);
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'sudo whoami' }, ROOT), null);
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'ls > /tmp/out' }, ROOT), null);
    assert.strictEqual(permissions.suggestSafeAllowRule('Bash', { command: 'echo $(id)' }, ROOT), null);
    assert.strictEqual(permissions.suggestSafeAllowRule('mcp__rea__inspect_analysis_view', {}, ROOT), 'mcp__rea__inspect_analysis_view');
    assert.strictEqual(permissions.suggestSafeAllowRule('Edit', { file_path: 'src/App.jsx' }, ROOT), 'Edit(src/App.jsx)');
    assert.strictEqual(permissions.suggestSafeAllowRule('Edit', { file_path: '../secret.txt' }, ROOT), null);
    assert.strictEqual(permissions.suggestSafeAllowRule('Edit', { file_path: '.env.local' }, ROOT), null);
  });

  await runTest('runTool propagates option-4 guidance feedback on permission decline and stays bool-compatible', async () => {
    const rFeedback = await runTool(
      'Bash',
      { command: 'find . -name "*.js"' },
      { approveTool: async () => ({ allow: false, feedback: 'Use ripgrep (rg) instead of find' }) }
    );
    assert.strictEqual(rFeedback.isError, true);
    assert.strictEqual(rFeedback.denied, true);
    assert.ok(rFeedback.content.includes('User declined this tool call (Bash) with guidance: Use ripgrep (rg) instead of find'));

    const rBoolDeny = await runTool('Bash', { command: 'echo blocked' }, { approveTool: async () => false });
    assert.strictEqual(rBoolDeny.isError, true);
    assert.strictEqual(rBoolDeny.denied, true);
  });

  await runTest('describePermissionRequest maps command, MCP, edit, and read headers', async () => {
    assert.strictEqual(describePermissionRequest({ tool: 'Bash', args: { command: 'npm test' } }).title, 'Allow running this command?');
    assert.strictEqual(describePermissionRequest({ tool: 'mcp__rea__inspect_analysis_view', args: {} }).title, 'Allow using this MCP tool?');
    assert.strictEqual(describePermissionRequest({ tool: 'Edit', args: { file_path: 'a.js' } }).title, 'Allow editing this file?');
    assert.strictEqual(describePermissionRequest({ tool: 'Read', args: { file_path: 'a.js' } }).title, 'Allow read access to this path?');
  });

  await runTest('MessageQueueTray helpers isolate per-conversation queues, skip paused items, and reorder cleanly', async () => {
    const queue = [
      { id: 'q1', convId: 'c1', text: 'first', paused: true },
      { id: 'q2', convId: 'c2', text: 'other-conv', paused: false },
      { id: 'q3', convId: 'c1', text: 'second', paused: false },
      { id: 'q4', convId: 'c1', text: 'third', paused: false },
    ];
    assert.deepStrictEqual(filterQueueForConv(queue, 'c1').map((x) => x.id), ['q1', 'q3', 'q4']);

    // c2 queue paused + q1 item paused -> should pick q3 first
    const picked = pickNextRunnableQueued(queue, { c2: true });
    assert.strictEqual(picked.next.id, 'q3');
    assert.deepStrictEqual(picked.rest.map((x) => x.id), ['q1', 'q2', 'q4']);

    // c1 queue also paused -> nothing runnable
    const none = pickNextRunnableQueued(queue, { c1: true, c2: true });
    assert.strictEqual(none.next, null);
    assert.strictEqual(none.rest.length, 4);

    // Step q1 down within c1 (should swap with q3 without disturbing q2)
    const stepped = stepQueueItemWithinConv(queue, 'q1', 1);
    assert.deepStrictEqual(stepped.map((x) => x.id), ['q3', 'q2', 'q1', 'q4']);

    // Drag move q4 onto q1
    const moved = moveQueueItem(stepped, 'q4', 'q1');
    assert.deepStrictEqual(moved.map((x) => x.id), ['q3', 'q2', 'q4', 'q1']);
  });

  await runTest('typography module normalizes sizes, formats custom stacks, and writes CSS vars', async () => {
    const norm = typography.normalizeTypography({ uiPreset: 'custom', uiCustomFont: 'Plus Jakarta Sans', uiSize: 28, monoPreset: 'fira-code', monoSize: 6, ligatures: false });
    assert.strictEqual(norm.uiSize, 20);
    assert.strictEqual(norm.monoSize, 11);
    assert.strictEqual(norm.ligatures, false);
    assert.ok(typography.resolveUiFontStack(norm).startsWith("'Plus Jakarta Sans',"));
    assert.ok(typography.resolveMonoFontStack(norm).startsWith("'Fira Code',"));

    const vars = {};
    const mockDoc = { documentElement: { style: { setProperty: (k, v) => { vars[k] = v; } } } };
    typography.applyTypographyToDocument(norm, mockDoc);
    assert.strictEqual(vars['--fs-body'], '20px');
    assert.strictEqual(vars['--fs-code'], '11px');
    assert.strictEqual(vars['--font-ligatures'], 'none');
    assert.strictEqual(vars['--font-feature-settings'], '"liga" 0, "calt" 0');
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
