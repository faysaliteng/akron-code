'use strict';
// mcp-schema: compact verbose MCP tool schemas, defer a fat surface behind
// `mcp_find_tools`, and keep every deferred tool discoverable + callable.
const assert = require('assert');
const s = require('../electron/mcp-schema');

let pass = 0, fail = 0;
const ok = (name, fn) => { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '→', e.message); } };

// ── compactSchema keeps shape, drops prose ────────────────────────────────
ok('drops descriptions/defaults/examples/titles', () => {
  const out = s.compactSchema({
    type: 'object',
    title: 'Args',
    description: 'A long explanation of the args.',
    properties: {
      path: { type: 'string', description: 'Where to write it', default: '/tmp/x', examples: ['a'], format: 'uri' },
      mode: { type: 'string', enum: ['a', 'b'], description: 'mode' },
    },
    required: ['path'],
    additionalProperties: false,
  });
  assert.strictEqual(out.title, undefined);
  assert.strictEqual(out.description, undefined);
  assert.strictEqual(out.additionalProperties, undefined);
  assert.strictEqual(out.properties.path.description, undefined);
  assert.strictEqual(out.properties.path.default, undefined);
  assert.strictEqual(out.properties.path.format, undefined);
  assert.deepStrictEqual(out.properties.mode.enum, ['a', 'b']);
  assert.deepStrictEqual(out.required, ['path']);
});

ok('collapses type arrays and anyOf to one type', () => {
  assert.strictEqual(s.compactSchema({ type: ['string', 'null'] }).type, 'string');
  assert.strictEqual(s.compactSchema({ anyOf: [{ type: 'null' }, { type: 'integer' }] }).type, 'integer');
});

ok('keeps nested objects and array items', () => {
  const out = s.compactSchema({
    type: 'object',
    properties: { files: { type: 'array', items: { type: 'object', properties: { p: { type: 'string' } } } } },
  });
  assert.strictEqual(out.properties.files.items.properties.p.type, 'string');
});

ok('caps enum length and flags truncation', () => {
  const many = Array.from({ length: 50 }, (_, i) => 'v' + i);
  const out = s.compactSchema({ type: 'string', enum: many });
  assert.strictEqual(out.enum.length, 24);
  assert.strictEqual(out.enumOpen, true);
});

ok('survives hostile/empty input', () => {
  assert.deepStrictEqual(s.compactSchema(null), { type: 'object' });
  assert.deepStrictEqual(s.compactSchema('nope'), { type: 'object' });
  assert.deepStrictEqual(s.compactSchema({}), {});
});

// ── compactTool ───────────────────────────────────────────────────────────
ok('tool description is one short line', () => {
  const t = s.compactTool({
    name: 'mcp__srv1__x',
    description: 'First sentence here. Second sentence that should be dropped entirely from the advert.',
    inputSchema: { type: 'object', properties: { a: { type: 'string', description: 'junk' } } },
  });
  assert.strictEqual(t.name, 'mcp__srv1__x');
  assert.ok(t.description.length <= s.DESC_LIMIT + 1, 'desc capped: ' + t.description.length);
  assert.ok(!t.description.includes('Second sentence'));
  assert.strictEqual(t.inputSchema.properties.a.description, undefined);
});

// ── buildSurface ──────────────────────────────────────────────────────────
const fat = Array.from({ length: 200 }, (_, i) => ({
  name: `mcp__srv1__tool_${i}`,
  description: 'A verbose MCP tool description that repeats itself at length for no reason whatsoever. ' + 'x'.repeat(400),
  inputSchema: {
    type: 'object',
    description: 'lots of prose',
    properties: Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`p${k}`, { type: 'string', description: 'prose '.repeat(20) }])),
  },
}));

ok('small surface is advertised compacted', () => {
  const small = fat.slice(0, 2);
  const out = s.buildSurface(small);
  assert.strictEqual(out.mode, 'full');
  assert.strictEqual(out.tools.length, 2);
  assert.ok(out.savedChars > 0, 'compaction saves chars');
  assert.strictEqual(out.deferred.length, 0);
});

ok('fat surface is deferred with no schema text', () => {
  const out = s.buildSurface(fat, { budget: 5000 });
  assert.strictEqual(out.mode, 'deferred');
  assert.strictEqual(out.tools.length, 0);
  assert.strictEqual(out.chars, 0);
  assert.strictEqual(out.deferred.length, fat.length, 'every tool stays discoverable');
  assert.ok(out.rawChars > 200000, 'raw was huge: ' + out.rawChars);
});

ok('empty surface is inert', () => {
  const out = s.buildSurface([]);
  assert.strictEqual(out.mode, 'none');
  assert.deepStrictEqual(out.tools, []);
});

ok('REA-shaped payload lands under the default budget', () => {
  // 263 tools × ~1.5 kB of schema-doc inflation is the real-world case.
  const rea = Array.from({ length: 263 }, (_, i) => ({
    name: `mcp__srv1__inspect_thing_${i}`,
    description: 'Inspect a thing. ' + 'Detail: '.repeat(30),
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`arg${k}`, { type: 'string', description: 'Explain arg ' + k + ' in depth.', default: 'x' }])),
      required: ['arg0'],
    },
  }));
  const raw = rea.reduce((n, t) => n + JSON.stringify(t).length, 0);
  const out = s.buildSurface(rea);
  assert.ok(raw > 300000, 'raw ~384 kB like the live capture: ' + raw);
  assert.strictEqual(out.mode, 'deferred');
  assert.ok(out.savedChars >= 300000);
});

// ── searchMcpTools ────────────────────────────────────────────────────────
const catalog = [
  { name: 'mcp__srv1__inspect_android_jni_bindings', description: 'Inspect Android JNI bindings.' },
  { name: 'mcp__srv1__capture_browser_scenario', description: 'Record a Playwright browser scenario.' },
  { name: 'mcp__srv1__decompile_dotnet_assembly', description: 'Decompile a .NET assembly.' },
  { name: 'mcp__srv2__read_file', description: 'Read a file from the workspace.' },
];

ok('search ranks name matches first', () => {
  const hits = s.searchMcpTools(catalog, 'android jni');
  assert.strictEqual(hits[0].name, 'mcp__srv1__inspect_android_jni_bindings');
});

ok('search finds by description keyword', () => {
  const hits = s.searchMcpTools(catalog, 'playwright');
  assert.strictEqual(hits[0].name, 'mcp__srv1__capture_browser_scenario');
});

ok('search filters by server', () => {
  const hits = s.searchMcpTools(catalog, 'read', 'srv2');
  assert.ok(hits.length >= 1);
  assert.ok(hits.every((h) => h.name.startsWith('mcp__srv2__')));
});

ok('search returns matches with usable schemas', () => {
  const hits = s.searchMcpTools([{ name: 'mcp__s__go', description: 'Go.', inputSchema: { type: 'object', properties: { a: { type: 'string' } } } }], 'go');
  assert.deepStrictEqual(hits[0].inputSchema.properties.a, { type: 'string' });
});

ok('no match yields empty list, not a throw', () => {
  assert.deepStrictEqual(s.searchMcpTools(catalog, 'zzzzz'), []);
  assert.deepStrictEqual(s.searchMcpTools(null, 'x'), []);
});

ok('empty query returns the head of the catalog', () => {
  const hits = s.searchMcpTools(catalog, '');
  assert.strictEqual(hits.length, Math.min(s.MAX_HITS, catalog.length));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
