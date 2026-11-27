'use strict';
// Slash-command parity gate.
//
// Ground truth: the command registry extracted from Claude Code CLI 2.1.154
// (test/fixtures/cc-commands-2.1.154.txt — one `name<TAB>kind` per line, where
// kind is `local` for a real local/local-jsx command and `skill` for a
// prompt/skill command).
//
// A command is "covered" when the GUI can act on it:
//   local  -> a `case` in src/App.jsx runSlashCommand (directly or via ALIAS),
//             or a BUILTIN entry (aliases included) that a handler picks up.
//   skill  -> a BUILTIN entry, a SKILL_PROMPTS built-in body, or a real
//             `.claude/commands/<name>.md` discoverable at runtime (resolve()).
//
// The test fails if any registry command would fall through to
// "Unknown slash command", and also fails if the app grows a `case` for a
// command that does not exist in the registry (typo / drift guard).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const cmds = require('../electron/commands');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixtures/cc-commands-2.1.154.txt');

// ---------------------------------------------------------------- fixture ---
const registry = fs.readFileSync(FIXTURE, 'utf8')
  .split('\n')
  .map((l) => l.replace(/\r$/, ''))
  .filter(Boolean)
  .map((l) => {
    const [name, kind] = l.split('\t');
    return { name: name.trim(), kind: (kind || 'local').trim() };
  })
  .filter((r) => r.name);

assert.ok(registry.length >= 90, `registry fixture looks truncated (${registry.length} entries)`);

// ------------------------------------------------------- runSlashCommand ---
const start = APP.indexOf('const runSlashCommand');
assert.ok(start > 0, 'runSlashCommand not found in src/App.jsx');
const end = APP.indexOf('const appendAssistant', start);
assert.ok(end > start, 'could not bound the runSlashCommand segment');
const seg = APP.slice(start, end);

const caseLabels = new Set([...seg.matchAll(/case\s+'([\w:_-]+)'/g)].map((m) => m[1]));
assert.ok(caseLabels.size > 60, `expected many handled commands, found ${caseLabels.size}`);

// `const ALIAS = { a: 'b', ... }` inside the handler.
const aliasAt = seg.indexOf('const ALIAS');
const aliasMap = {};
if (aliasAt >= 0) {
  const aliasSeg = seg.slice(aliasAt, seg.indexOf('};', aliasAt));
  for (const m of aliasSeg.matchAll(/([\w'-]+)\s*:\s*'([\w:_-]+)'/g)) {
    aliasMap[m[1]] = m[2];
  }
}
assert.ok(Object.keys(aliasMap).length > 5, 'ALIAS map not detected');

const builtinNames = new Set(cmds.BUILTIN.map((b) => b.name.toLowerCase()));
const builtinAliases = new Set();
for (const b of cmds.BUILTIN) for (const a of (b.aliases || [])) builtinAliases.add(String(a).toLowerCase());
const skillNames = new Set(Object.keys(cmds.SKILL_PROMPTS || {}).map((n) => n.toLowerCase()));

const cwd = path.join(ROOT, 'test', 'fixtures'); // a dir with no .claude/commands

// ------------------------------------------------------------- coverage ---
const gaps = [];
for (const { name, kind } of registry) {
  const n = name.toLowerCase();
  const viaCase = caseLabels.has(n) || caseLabels.has(aliasMap[n] || '');
  const viaBuiltin = builtinNames.has(n) || builtinAliases.has(n);
  const viaSkill = kind === 'skill' && (skillNames.has(n) || Boolean(cmds.resolve(n, cwd)));
  const viaResolve = kind === 'skill' && Boolean(cmds.resolve(n, cwd));
  if (!(viaCase || viaBuiltin || viaResolve || viaSkill)) gaps.push(`${name} (${kind})`);
}
assert.deepStrictEqual(
  gaps,
  [],
  `${gaps.length} registry command(s) have no GUI handler:\n  ` + gaps.join('\n  '),
);

// ------------------------------------------------- reverse drift guard ----
// `case` labels that are neither in the registry nor a documented extra.
// Extras are aliases/renames the GUI keeps for convenience (older names that
// 2.1.154 dropped, or shorthands that map onto a registry command).
const EXTRA_CASES = new Set([
  'continue', 'reset', 'cost', 'output-style', 'init', 'todos', 'notebooks',
  'terminal', 'bashes', 'plugins', 'commands', 'fast', 'code-review', 'sandbox',
  'alias', 'bug', 'pr-comments', 'exit', 'quit', 'cwd', 'search',
  'swarm', 'subagents', 'gdrive', 'note', 'worktrees',
  'mission', 'ask-history', 'learn', 'customizations',
]);
const registryNames = new Set(registry.map((r) => r.name.toLowerCase()));
const unknownCases = [...caseLabels]
  .filter((c) => !registryNames.has(c) && !EXTRA_CASES.has(c));
assert.deepStrictEqual(
  unknownCases,
  [],
  'runSlashCommand has case(s) for commands outside the registry and the extras list: ' + unknownCases.join(', '),
);

// --------------------------------------------------- skill prompt sanity ---
for (const [name, def] of Object.entries(cmds.SKILL_PROMPTS || {})) {
  assert.ok(def.description && def.description.length > 8, `${name}: missing description`);
  assert.ok(def.body && def.body.length > 80, `${name}: prompt body too short`);
  const resolved = cmds.resolve(name, cwd);
  assert.ok(resolved && resolved.body === def.body, `${name}: resolve() does not return the built-in body`);
}

// A project command file must beat the built-in skill table.
const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'helio-cmd-'));
try {
  fs.mkdirSync(path.join(tmp, '.claude', 'commands'), { recursive: true });
  fs.writeFileSync(
    path.join(tmp, '.claude', 'commands', 'batch.md'),
    '---\ndescription: override\n---\nCUSTOM OVERRIDE BODY',
  );
  const overridden = cmds.resolve('batch', tmp);
  assert.ok(overridden, 'override command not resolved');
  assert.strictEqual(overridden.source, 'project', 'override file must win over the skill table');
  assert.ok(/CUSTOM OVERRIDE BODY/.test(overridden.body), 'override body not used');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// The picker must offer every built-in skill exactly once.
const ui = cmds.listForUi(cwd);
const uiNames = ui.map((c) => c.name.toLowerCase());
assert.strictEqual(uiNames.length, new Set(uiNames).size, 'listForUi() produced duplicate names');
for (const n of skillNames) {
  assert.ok(uiNames.includes(n), `picker is missing skill command "${n}"`);
}

console.log(
  `slash-commands: ${registry.length} registry commands covered ` +
  `(${caseLabels.size} case labels, ${builtinNames.size} built-ins, ${skillNames.size} skill prompts, ${ui.length} in picker)`,
);
console.log('OK');
