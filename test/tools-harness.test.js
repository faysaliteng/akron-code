'use strict';
// Claude-Code-parity tests for the core tool harness (electron/tools.js,
// electron/permissions.js, electron/bg.js): Edit/MultiEdit uniqueness and
// atomicity, Glob semantics, Bash timeouts / exit codes / process-group kill,
// Read numbering + paging + binary detection, runTool exception handling,
// deny checks and compound-command permission splitting.
//
// Plain node, no framework:  node test/tools-harness.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../electron/store');
const tools = require('../electron/tools');
const perms = require('../electron/permissions');
const bg = require('../electron/bg');

const { runTool, toolTimeoutMs } = tools;

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}

// Never touch the user's real sandbox config.
const realGet = store.getSettings;
store.getSettings = () => ({});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-harness-'));
const P = (...a) => path.join(tmp, ...a);
const write = (rel, s) => { fs.mkdirSync(path.dirname(P(rel)), { recursive: true }); fs.writeFileSync(P(rel), s); };
const read = (rel) => fs.readFileSync(P(rel), 'utf8');
const rt = async (name, args, ctx) => {
  const r = await runTool(name, args, { cwd: tmp, ...(ctx || {}) });
  return r && typeof r === 'object' ? r : { content: String(r) };
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (_) { return false; } };

(async () => {
  // ── Edit ──────────────────────────────────────────────────────────────────
  console.log('# Edit');
  write('dup.txt', 'aaa bbb aaa');
  let r = await rt('Edit', { path: 'dup.txt', old_string: 'aaa', new_string: 'XXX' });
  ok('ambiguous old_string → error', /matches 2 times/.test(r.content) && /replace_all/.test(r.content), r.content);
  ok('ambiguous edit leaves file unchanged', read('dup.txt') === 'aaa bbb aaa');
  r = await rt('Edit', { path: 'dup.txt', old_string: 'aaa', new_string: 'XXX', replace_all: true });
  ok('replace_all replaces every occurrence', read('dup.txt') === 'XXX bbb XXX' && /Replaced 2 occurrences/.test(r.content), r.content);
  r = await rt('Edit', { path: 'dup.txt', old_string: 'bbb', new_string: 'bbb' });
  ok('identical old/new → error', /identical/.test(r.content), r.content);
  r = await rt('Edit', { path: 'dup.txt', old_string: 'zzz', new_string: 'q' });
  ok('not found → error that suggests Read', /not found/.test(r.content) && /Read/.test(r.content));
  r = await rt('Edit', { path: 'dup.txt', old_string: '', new_string: 'q' });
  ok('empty old_string on existing file → error', /non-empty/.test(r.content), r.content);
  write('unique.txt', 'one\ntwo\nthree\n');
  r = await rt('Edit', { path: 'unique.txt', old_string: 'two', new_string: 'TWO' });
  ok('unique match replaced', read('unique.txt') === 'one\nTWO\nthree\n' && /Replaced 1 occurrence/.test(r.content));
  r = await rt('Edit', { path: 'unique.txt', old_string: 'x$&y', new_string: 'a' });
  ok('regex/replacement specials are literal', /not found/.test(r.content));
  write('dollar.txt', 'price: P');
  await rt('Edit', { path: 'dollar.txt', old_string: 'P', new_string: '$& $1' });
  ok('new_string "$&" is inserted verbatim', read('dollar.txt') === 'price: $& $1', read('dollar.txt'));

  // CRLF
  write('crlf.txt', 'alpha\r\nbeta\r\ngamma\r\n');
  r = await rt('Edit', { path: 'crlf.txt', old_string: 'alpha\nbeta', new_string: 'A\nB' });
  ok('CRLF file: LF old_string matches', /Replaced 1/.test(r.content), r.content);
  ok('CRLF file: new_string written with CRLF', read('crlf.txt') === 'A\r\nB\r\ngamma\r\n', JSON.stringify(read('crlf.txt')));

  // whitespace-tolerant fallback
  write('ws.txt', 'line one\n    indented value\nline three\n');
  r = await rt('Edit', { path: 'ws.txt', old_string: 'indented   value', new_string: 'CHANGED' });
  ok('fuzzy match applies when unique', /CHANGED/.test(read('ws.txt')) && /ignoring whitespace/.test(r.content));
  write('ws2.txt', 'foo  bar\nzzz\nfoo bar\n');
  r = await rt('Edit', { path: 'ws2.txt', old_string: 'foo   bar', new_string: 'Q' });
  ok('fuzzy match refused when ambiguous', /matches 2 times/.test(r.content) && read('ws2.txt') === 'foo  bar\nzzz\nfoo bar\n', r.content);
  write('ws3.txt', 'start\n\n\n\n\n\n\n\nend\n');
  r = await rt('Edit', { path: 'ws3.txt', old_string: 'start end', new_string: 'Q' });
  ok('fuzzy match may not span a large unrelated region', /not found/.test(r.content));

  // missing file
  r = await rt('Edit', { path: 'ghost.txt', old_string: 'a', new_string: 'b' });
  ok('missing file → points at Write', /Use the Write tool/.test(r.content));
  r = await rt('Edit', { path: 'new/created.txt', old_string: '', new_string: 'hello' });
  ok('empty old_string on missing file creates it (Claude Code)', fs.existsSync(P('new/created.txt')) && read('new/created.txt') === 'hello', r.content);

  // ── MultiEdit ─────────────────────────────────────────────────────────────
  console.log('# MultiEdit');
  write('multi.txt', 'one two three');
  r = await rt('MultiEdit', { path: 'multi.txt', edits: [{ old_string: 'one', new_string: '1' }, { old_string: 'nope', new_string: 'x' }] });
  ok('failing edit → nothing applied (atomic)', read('multi.txt') === 'one two three' && /No changes were applied/.test(r.content), r.content);
  r = await rt('MultiEdit', { path: 'multi.txt', edits: [{ old_string: 'one', new_string: 'two' }, { old_string: 'two two', new_string: 'X' }] });
  ok('edits apply sequentially', read('multi.txt') === 'X three', read('multi.txt'));
  write('multi2.txt', 'a a b');
  r = await rt('MultiEdit', { path: 'multi2.txt', edits: [{ old_string: 'b', new_string: 'c' }, { old_string: 'a', new_string: 'z' }] });
  ok('uniqueness enforced per edit (atomic)', /matches 2 times/.test(r.content) && read('multi2.txt') === 'a a b', r.content);
  r = await rt('MultiEdit', { path: 'multi2.txt', edits: [{ old_string: 'a', new_string: 'z', replace_all: true }] });
  ok('per-edit replace_all', read('multi2.txt') === 'z z b');
  store.getSettings = () => ({ sandbox: { enabled: true, filesystem: { denyWrite: [tmp], denyRead: [], allowRead: [], allowManagedReadPathsOnly: false } } });
  r = await rt('MultiEdit', { path: 'multi2.txt', edits: [{ old_string: 'b', new_string: 'c' }] });
  store.getSettings = () => ({});
  ok('MultiEdit honours sandbox denyWrite', /^Error/.test(r.content) && read('multi2.txt') === 'z z b', r.content);

  // ── Glob ──────────────────────────────────────────────────────────────────
  console.log('# Glob');
  const g = fs.mkdtempSync(path.join(os.tmpdir(), 'tools-glob-'));
  const gw = (rel) => { fs.mkdirSync(path.dirname(path.join(g, rel)), { recursive: true }); fs.writeFileSync(path.join(g, rel), rel); };
  ['root.ts', 'src/a.ts', 'src/deep/b.ts', 'src/c.tsx', 'src/d.js', 'node_modules/pkg/x.ts', '.git/y.ts'].forEach(gw);
  const old = new Date(Date.now() - 3600 * 1000);
  for (const f of ['root.ts', 'src/a.ts', 'src/deep/b.ts', 'src/c.tsx']) fs.utimesSync(path.join(g, f), old, old);
  fs.utimesSync(path.join(g, 'src/deep/b.ts'), new Date(), new Date());
  r = await rt('Glob', { pattern: '**/*.ts', path: g });
  let lines = r.content.split('\n');
  ok('**/*.ts matches root-level files', lines.includes('root.ts'), r.content);
  ok('**/*.ts matches nested files', lines.includes('src/a.ts') && lines.includes('src/deep/b.ts'));
  ok('node_modules and .git skipped', !/node_modules|\.git/.test(r.content), r.content);
  ok('sorted by mtime (newest first)', lines[0] === 'src/deep/b.ts', lines.join(','));
  r = await rt('Glob', { pattern: 'src/**/*.{ts,tsx}', path: g });
  lines = r.content.split('\n');
  ok('brace expansion {ts,tsx}', lines.includes('src/c.tsx') && lines.includes('src/a.ts') && !lines.includes('src/d.js'), r.content);
  r = await rt('Glob', { pattern: '*.ts', path: g });
  ok('*.ts only matches the root', r.content.trim() === 'root.ts', r.content);
  r = await rt('Glob', { pattern: 'node_modules/**/*.ts', path: g });
  ok('node_modules searched when the pattern names it', /node_modules\/pkg\/x\.ts/.test(r.content), r.content);
  r = await rt('Glob', { pattern: path.join(g, 'src', '*.tsx') });
  ok('absolute pattern', /c\.tsx/.test(r.content), r.content);
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(g, `many${i}.md`), '');
  r = await rt('Glob', { pattern: '*.md', path: g });
  ok('truncation is reported', /Results are truncated/.test(r.content));
  ok('expandBraces nested', JSON.stringify(tools.expandBraces('a{b,c{d,e}}f')) === JSON.stringify(['abf', 'acdf', 'acef']));
  fs.rmSync(g, { recursive: true, force: true });

  // ── Bash ──────────────────────────────────────────────────────────────────
  console.log('# Bash');
  r = await rt('Bash', { command: 'echo hello' });
  ok('plain output, no exit marker on success', r.content.trim() === 'hello', JSON.stringify(r.content));
  r = await rt('Bash', { command: 'echo boom >&2; exit 3' });
  ok('non-zero exit code is reported', /\[exit code 3\]/.test(r.content) && /boom/.test(r.content), r.content);
  let t0 = Date.now();
  const pidFile = P('bgpid');
  r = await rt('Bash', { command: `(sleep 30; echo late) & echo $! > ${JSON.stringify(pidFile)}; sleep 30`, timeout: 1000 });
  const el = Date.now() - t0;
  ok('timeout arg is milliseconds', el < 5000, el + 'ms');
  ok('timeout is reported', /timed out after 1s — process killed/.test(r.content), r.content);
  await new Promise((res) => setTimeout(res, 200));
  const gpid = Number(fs.readFileSync(pidFile, 'utf8').trim());
  ok('whole process group killed on timeout', gpid > 0 && !alive(gpid), 'pid ' + gpid);
  const ac = new AbortController();
  t0 = Date.now();
  setTimeout(() => ac.abort(), 300);
  r = await rt('Bash', { command: 'sleep 20' }, { signal: ac.signal });
  ok('ctx.signal abort kills the command', /aborted/.test(r.content) && Date.now() - t0 < 4000, r.content);
  r = await rt('Bash', { command: 'head -c 200000 /dev/zero | tr "\\0" a; echo; echo TAIL-MARK' });
  ok('large output truncated head+tail', r.content.length < 32000 && /truncated/.test(r.content) && /TAIL-MARK/.test(r.content), String(r.content.length));
  ok('toolTimeoutMs default (120s + grace)', toolTimeoutMs('Bash', {}) === 130000);
  ok('toolTimeoutMs respects args.timeout', toolTimeoutMs('Bash', { timeout: 300000 }) === 310000);
  ok('toolTimeoutMs capped', toolTimeoutMs('Bash', { timeout: 9e9 }) === 610000);
  r = await rt('Bash', { command: 'echo bg-ok', run_in_background: true });
  const id = (/Started background shell (shell_\w+)/.exec(r.content) || [])[1];
  const job = id && await bg.waitFor(id, { block: true, timeout: 5000 });
  ok('run_in_background still works', job && /bg-ok/.test(job.output) && job.status === 'completed', r.content);

  // ── Read ──────────────────────────────────────────────────────────────────
  console.log('# Read');
  write('r.txt', 'l1\nl2\nl3\nl4\n');
  r = await rt('Read', { path: 'r.txt' });
  ok('cat -n numbering', r.content === '     1\tl1\n     2\tl2\n     3\tl3\n     4\tl4', JSON.stringify(r.content));
  r = await rt('Read', { path: 'r.txt', offset: 2, limit: 2 });
  ok('offset (1-based) + limit', r.content.startsWith('     2\tl2\n     3\tl3') && !/l1|l4\b/.test(r.content.split('\n…')[0]) && /offset 4/.test(r.content), JSON.stringify(r.content));
  r = await rt('Read', { path: 'r.txt', offset: 99 });
  ok('offset past end explained', /past the end/.test(r.content));
  write('crlfread.txt', 'a\r\nb\r\n');
  r = await rt('Read', { path: 'crlfread.txt' });
  ok('CR stripped from display', r.content === '     1\ta\n     2\tb', JSON.stringify(r.content));
  write('long.txt', 'x'.repeat(5000) + '\nshort\n');
  r = await rt('Read', { path: 'long.txt' });
  ok('long lines capped at 2000 chars', r.content.split('\n')[0].length < 2100 && /line truncated/.test(r.content));
  fs.writeFileSync(P('bin.dat'), Buffer.from([0x50, 0x4b, 0x00, 0x01, 0xff, 0x00]));
  r = await rt('Read', { path: 'bin.dat' });
  ok('binary file detected', /^Binary file/.test(r.content), r.content);
  fs.writeFileSync(P('pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  r = await rt('Read', { path: 'pic.png' });
  ok('image reported, not dumped', /Image file/.test(r.content) && /8 bytes/.test(r.content), r.content);
  write('big.txt', Array.from({ length: 3000 }, (_, i) => 'y'.repeat(60) + i).join('\n'));
  r = await rt('Read', { path: 'big.txt' });
  ok('total output capped ~100k with paging hint', r.content.length < 101000 && /offset \d+ to continue/.test(r.content), String(r.content.length));
  write('empty.txt', '');
  r = await rt('Read', { path: 'empty.txt' });
  ok('empty file explained', /empty/.test(r.content));
  r = await rt('Read', { path: '.' });
  ok('directory explained', /is a directory/.test(r.content), r.content);

  // ── runTool error handling / deny ─────────────────────────────────────────
  console.log('# runTool');
  r = await runTool('AskUserQuestion', { questions: [] }, { askUser: async () => { throw new Error('boom-ask'); } });
  ok('special-handler exception → isError result', r && r.isError === true && /Tool error: boom-ask/.test(r.content), JSON.stringify(r));
  r = await runTool('ReadMcpResource', { server: 's', uri: 'u' }, { mcpReadResource: () => { throw new Error('mcp-down'); } });
  ok('ReadMcpResource exception → isError', r && r.isError && /mcp-down/.test(r.content));
  const aborted = new AbortController(); aborted.abort();
  let threw = false;
  try { await runTool('AskUserQuestion', {}, { signal: aborted.signal, askUser: async () => { throw new Error('aborted'); } }); } catch (_) { threw = true; }
  ok('abort errors propagate', threw);
  r = await runTool('Read', { path: P('r.txt') }, { checkDeny: (n, a) => (n === 'Read' && /r\.txt$/.test(a.path) ? { decision: 'deny', reason: 'Denied by rule Read(r.txt)' } : null) });
  ok('ctx.checkDeny blocks read-only tools', r.denied === true && r.isError && /Read\(r\.txt\)/.test(r.content), JSON.stringify(r));
  r = await runTool('Read', { path: P('r.txt') }, { checkDeny: () => null });
  ok('ctx.checkDeny null → proceeds', /l1/.test(r.content));
  r = await runTool('Read', { path: P('r.txt') }, { checkDeny: () => perms.denyMatch({ deny: ['Read(r.txt)'] }, 'Read', { path: P('r.txt') }) });
  ok('permissions.denyMatch plugs into checkDeny', r.denied === true);

  // ── background agents: TaskStop aborts ────────────────────────────────────
  console.log('# background agents');
  let seenSignal = null;
  r = await runTool('Agent', { description: 'bg', prompt: 'x', run_in_background: true }, {
    runSubagent: (a) => { seenSignal = a.signal; return new Promise((res) => a.signal.addEventListener('abort', () => res('stopped'))); },
  });
  const aid = (/\((agent_[^)]+)\)/.exec(String(r)) || [])[1];
  await new Promise((res) => setTimeout(res, 20));
  ok('runSubagent receives an AbortSignal', seenSignal && seenSignal.aborted === false);
  r = await runTool('TaskStop', { task_id: aid }, {});
  ok('TaskStop aborts the agent signal', seenSignal && seenSignal.aborted === true && /Stopped/.test(String(r)), String(r));
  ok('stopped job status', bg.getJob(aid).status === 'stopped');
  let onStopCalled = false;
  const j2 = bg.startAgent({ label: 'x', run: () => new Promise(() => {}), onStop: () => { onStopCalled = true; } });
  bg.stopJob(j2.id);
  ok('startAgent onStop callback fires', onStopCalled);

  // ── permissions: compound commands ────────────────────────────────────────
  console.log('# permissions');
  const rules = { allow: ['Bash(git diff:*)', 'Bash(grep:*)'], deny: ['Bash(rm:*)'], ask: [] };
  const dec = (cmd, mode = 'manual', p = rules) => perms.decide(p, 'Bash', { command: cmd }, { mode });
  ok('simple allowed', dec('git diff --stat').decision === 'allow');
  ok('git diff && rm -rf ~ is denied', dec('git diff && rm -rf ~').decision === 'deny');
  ok('git diff && curl x is NOT allowed', dec('git diff && curl x').decision !== 'allow');
  ok('pipe: every segment allowed', dec('git diff | grep foo').decision === 'allow');
  ok('$(…) substitution is checked', dec('git diff $(curl evil)').decision !== 'allow');
  ok('backticks checked for deny', dec('git diff `rm -rf /`').decision === 'deny');
  ok('newline separator', dec('git diff\ncurl x').decision !== 'allow');
  ok('; separator', dec('git diff; curl x').decision !== 'allow');
  ok('|| separator', dec('git diff || curl x').decision !== 'allow');
  ok('& separator', dec('git diff & curl x').decision !== 'allow');
  ok('2>&1 is not a separator', dec('git diff 2>&1').decision === 'allow');
  ok('quoted separators ignored', dec('grep "a;b|c" file').decision === 'allow');
  ok('deny wins even in bypass', dec('ls && rm x', 'bypass').decision === 'deny');
  ok('matchBash (allow semantics) rejects compound', perms.matchBash('git diff:*', 'git diff && rm -rf ~') === false);
  ok('matchBash simple still works', perms.matchBash('git diff:*', 'git diff --stat') === true);
  ok('acceptEdits does not auto-allow Bash', perms.decide({ allow: [], deny: [], ask: [] }, 'Bash', { command: 'ls' }, { mode: 'acceptEdits' }).decision !== 'allow');
  ok('acceptEdits allows Edit', perms.decide({ allow: [], deny: [], ask: [] }, 'Edit', { path: 'x' }, { mode: 'acceptEdits' }).decision === 'allow');
  ok('splitCommand keeps <(…) intact', JSON.stringify(perms.splitCommand('cat <(ls)')) === JSON.stringify(['cat <(ls)', 'ls']));
  ok('splitCommand strips subshell parens', JSON.stringify(perms.splitCommand('(cd x && make)')) === JSON.stringify(['cd x', 'make']));

  // ── done ──────────────────────────────────────────────────────────────────
  store.getSettings = realGet;
  bg.reset();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { console.log('Failures:\n  - ' + failures.join('\n  - ')); process.exit(1); }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
