'use strict';
// Tests for the Example-parity lifecycle hooks engine (electron/hooks.js) and a
// few parity tools that are pure enough to test without a model.
//
// Everything runs against a throwaway cwd: hooks read
// <cwd>/.claude/settings.json, so no global config is touched.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const hooks = require('../electron/hooks');

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function group(name) { console.log('\n# ' + name); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-hooks-'));
function makeCwd(hooksConfig) {
  const dir = fs.mkdtempSync(path.join(root, 'cwd-'));
  if (hooksConfig) {
    fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ hooks: hooksConfig }, null, 2));
  }
  return dir;
}

(async () => {
  // ── config loading ───────────────────────────────────────────────────────
  group('config');
  {
    const cwd = makeCwd({
      PreToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'echo hi' }] }],
    });
    const cfg = hooks.loadHookConfig(cwd);
    ok('reads <cwd>/.claude/settings.json', cfg.PreToolUse.length === 1);
    ok('keeps the matcher', cfg.PreToolUse[0].matcher === 'Write|Edit');
    ok('keeps the hook command', cfg.PreToolUse[0].hooks[0].command === 'echo hi');
    ok('every event key exists', hooks.EVENTS.every((e) => Array.isArray(cfg[e])));
    ok('hasHooks reports a configured event', hooks.hasHooks('PreToolUse', cwd) === true);
    ok('hasHooks is false for an unconfigured event', hooks.hasHooks('Stop', cwd) === false);
  }

  // ── matcher semantics ────────────────────────────────────────────────────
  group('matcher');
  ok('empty matcher matches everything', hooks.matches('', 'Write') === true);
  ok('"*" matches everything', hooks.matches('*', 'Bash') === true);
  ok('regex alternation matches', hooks.matches('Write|Edit', 'Edit') === true);
  ok('regex alternation rejects', hooks.matches('Write|Edit', 'Bash') === false);
  ok('anchored — "Write" does not match "WriteX"', hooks.matches('Write', 'WriteX') === false);
  ok('invalid regex falls back to equality', hooks.matches('([', '([') === true);

  // ── command hook: allow ──────────────────────────────────────────────────
  group('command hook — allow');
  {
    const cwd = makeCwd({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'exit 0' }] }] });
    const v = await hooks.runEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } }, { cwd });
    ok('exit 0 does not block', v.blocked === false);
    ok('no reason on allow', !v.reason);
    ok('records the hook run', v.results.length === 1 && v.results[0].exitCode === 0);
  }

  // ── command hook: block (exit 2) ─────────────────────────────────────────
  group('command hook — block');
  {
    const cwd = makeCwd({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo "rm is banned" >&2; exit 2' }] }] });
    const v = await hooks.runEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }, { cwd });
    ok('exit 2 blocks', v.blocked === true);
    ok('stderr becomes the reason', /rm is banned/.test(v.reason), JSON.stringify(v.reason));
  }

  // ── command hook: JSON verdict ───────────────────────────────────────────
  group('command hook — JSON verdict');
  {
    const script = `process.stdout.write(JSON.stringify({
      systemMessage: "policy check ran",
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "secrets files are off limits",
        additionalContext: "the .env file is protected"
      }
    }))`;
    const file = path.join(root, 'verdict.js');
    fs.writeFileSync(file, script);
    const cwd = makeCwd({ PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `node ${JSON.stringify(file)}` }] }] });
    const v = await hooks.runEvent('PreToolUse', { tool_name: 'Read', tool_input: { path: '.env' } }, { cwd });
    ok('permissionDecision deny blocks', v.blocked === true);
    ok('permissionDecisionReason is the reason', /off limits/.test(v.reason), JSON.stringify(v.reason));
    ok('systemMessage is surfaced', v.systemMessages.includes('policy check ran'));
    ok('additionalContext is surfaced', /\.env file is protected/.test(v.additionalContext));
  }

  // ── command hook: updatedInput ───────────────────────────────────────────
  group('command hook — updatedInput');
  {
    const script = `process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { command: "echo rewritten" } }
    }))`;
    const file = path.join(root, 'rewrite.js');
    fs.writeFileSync(file, script);
    const cwd = makeCwd({ PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${JSON.stringify(file)}` }] }] });
    const v = await hooks.runEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo original' } }, { cwd });
    ok('not blocked', v.blocked === false);
    ok('updatedInput is returned', v.updatedInput && v.updatedInput.command === 'echo rewritten');
  }

  // ── stdin payload contract ───────────────────────────────────────────────
  group('stdin payload');
  {
    const out = path.join(root, 'payload.json');
    const cwd = makeCwd({
      PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `node -e "process.stdout.write('')" && cat > ${JSON.stringify(out)}` }] }],
    });
    // `cat` runs after the node no-op, so it consumes the stdin the hook runner wrote.
    await hooks.runEvent('PostToolUse', { tool_name: 'Write', tool_input: { path: 'a.txt' }, tool_response: 'written' }, { cwd, sessionId: 'sess-1' });
    const raw = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    ok('hook received stdin', raw.length > 0);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch (_) {}
    ok('stdin has hook_event_name', parsed.hook_event_name === 'PostToolUse', raw.slice(0, 120));
    ok('stdin has tool_name', parsed.tool_name === 'Write');
    ok('stdin has tool_input', parsed.tool_input && parsed.tool_input.path === 'a.txt');
    ok('stdin has tool_response', parsed.tool_response === 'written');
    ok('stdin has session_id', parsed.session_id === 'sess-1');
  }

  // ── stop verdict ─────────────────────────────────────────────────────────
  group('stop verdict');
  {
    const script = `process.stdout.write(JSON.stringify({ continue: false, stopReason: "tests are red" }))`;
    const file = path.join(root, 'stop.js');
    fs.writeFileSync(file, script);
    const cwd = makeCwd({ Stop: [{ matcher: '', hooks: [{ type: 'command', command: `node ${JSON.stringify(file)}` }] }] });
    const v = await hooks.runEvent('Stop', {}, { cwd });
    ok('continue:false sets stop', v.stop === true);
    ok('stopReason is preserved', /tests are red/.test(v.reason));
  }

  // ── unknown event + empty config are inert ───────────────────────────────
  group('safety');
  {
    const cwd = makeCwd(null);
    const v = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' }, { cwd });
    ok('no config → no block', v.blocked === false && v.results.length === 0);
    const bad = await hooks.runEvent('NotAnEvent', {}, { cwd });
    ok('unknown event returns an error, not a crash', typeof bad.error === 'string' && bad.blocked === false);
    const broken = makeCwd({ PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'this-binary-does-not-exist-xyz' }] }] });
    const vb = await hooks.runEvent('PreToolUse', { tool_name: 'Bash' }, { cwd: broken });
    ok('a broken hook does not block the tool', vb.blocked === false);
  }

  // ── hooks are all ten events ─────────────────────────────────────────────
  group('event surface');
  {
    const expected = [
      'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
      'Notification', 'Stop', 'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SessionStart',
    ];
    ok('exactly ten events', hooks.EVENTS.length === 10, String(hooks.EVENTS.length));
    ok('every Example event is implemented', expected.every((e) => hooks.EVENTS.includes(e)),
      expected.filter((e) => !hooks.EVENTS.includes(e)).join(','));
    ok('prompt/agent hooks are limited to tool events',
      hooks.TOOL_EVENTS.has('PreToolUse') && hooks.TOOL_EVENTS.has('PostToolUse') && !hooks.TOOL_EVENTS.has('Stop'));
  }

  // ── parity tools that need no model ──────────────────────────────────────
  group('parity tools');
  {
    const parity = require('../electron/parity');
    ok('parity exposes 27 tools', parity.NAMES.length === 27, String(parity.NAMES.length));
    ok('parity does not shadow Grep', !parity.NAMES.includes('Grep'));
    ok('handle() returns null for foreign tools', (await parity.handle('NotMine', {}, {})) === null);

    const tmp = fs.mkdtempSync(path.join(root, 'proj-'));
    fs.writeFileSync(path.join(tmp, 'a.txt'), 'hello needle\n');
    fs.mkdirSync(path.join(tmp, 'node_modules'));
    fs.writeFileSync(path.join(tmp, 'node_modules', 'skip.txt'), 'needle\n');

    const se = await parity.handle('Search', { pattern: 'needle', path: tmp }, {});
    ok('Search finds a hit', /a\.txt/.test(se.content));
    ok('Search skips node_modules', !/node_modules/.test(se.content));

    const ls = await parity.handle('LS', { path: tmp }, {});
    ok('LS lists entries', /a\.txt/.test(ls.content) && /node_modules/.test(ls.content));

    const bad = await parity.handle('CronCreate', { cron: 'not a cron', prompt: 'x' }, {});
    ok('invalid cron is rejected', bad.isError === true, bad.content);
  }

  // ── workflow DSL ─────────────────────────────────────────────────────────
  group('workflow DSL');
  {
    const { toolDefinitions } = require('../electron/tools');
    const names = toolDefinitions.map((t) => t.name);
    const wanted = ['LS', 'Search', 'TaskCreate', 'TaskGet', 'TaskUpdate', 'TaskList', 'TeamCreate',
      'TeamDelete', 'SendMessage', 'Workflow', 'TaskOutput', 'StructuredOutput', 'EnterPlanMode',
      'EnterWorktree', 'ExitWorktree', 'Mcp', 'PowerShell', 'Brief', 'SendUserFile', 'ConnectGitHub',
      'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger', 'Monitor', 'PushNotification'];
    const missing = wanted.filter((w) => !names.includes(w));
    ok('all 27 parity tools are registered', missing.length === 0, missing.join(','));
    ok('no duplicate tool names', new Set(names).size === names.length);

    const workflow = require('../electron/workflow');
    const parsed = workflow.parseMeta('export const meta = { name: "x", description: "y", phases: ["one"] };\nreturn 1;');
    ok('parseMeta reads a one-line literal', parsed.ok === true && parsed.meta.phases[0].title === 'one');
    const parsed2 = workflow.parseMeta('export const meta = {\n  name: "x",\n  description: "y",\n  phases: ["one", "two"],\n};\nreturn 1;');
    ok('parseMeta reads a multi-line literal', parsed2.ok === true && parsed2.meta.phases.length === 2);
    const badMeta = workflow.parseMeta('const x = 1;');
    ok('missing meta is an error', badMeta.ok === false);
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed) { console.log('\nFailures:\n' + failures.map((f) => ' - ' + f).join('\n')); }
  try { execFileSync('rm', ['-rf', root]); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(1);
});
