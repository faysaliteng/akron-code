'use strict';
// Antigravity / Gemini function declarations must be an OpenAPI 3.0 subset,
// not JSON Schema. A single out-of-subset keyword makes the *entire* request
// fail with 400 INVALID_ARGUMENT (`value.enum[0]`, `value.required[13]`) and
// the error carries no tool name — which is why one bad MCP schema used to kill
// every turn on the Antigravity provider.
//
// This test walks the real advertised tool surface, lowers it exactly the way
// googleChat does, and re-validates the result with Gemini's own rules.

const assert = require('assert');
const { _internal } = require('../electron/providertransport');
const { toGeminiSchema, toGeminiDeclarations } = _internal;

let n = 0;
const ok = (cond, msg) => { n++; assert.ok(cond, msg); };

const ALLOWED = new Set([
  'type', 'description', 'nullable', 'enum', 'properties', 'required',
  'items', 'minimum', 'maximum', 'minItems', 'maxItems',
  'minProperties', 'maxProperties',
]);
const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);

// Re-implementation of the subset check the endpoint performs.
function validate(schema, path) {
  ok(schema && typeof schema === 'object' && !Array.isArray(schema), path + ': not an object');
  for (const k of Object.keys(schema)) ok(ALLOWED.has(k), path + ': unexpected keyword ' + k);
  if (schema.type !== undefined) ok(TYPES.has(schema.type), path + ': bad type ' + schema.type);
  if (schema.enum !== undefined) {
    ok(Array.isArray(schema.enum) && schema.enum.length > 0, path + ': enum not a non-empty array');
    for (const v of schema.enum) ok(typeof v === 'string', path + ': enum value is not a string: ' + typeof v);
    ok(schema.type === 'string', path + ': enum on a non-string type');
  }
  if (schema.nullable !== undefined) ok(schema.nullable === true, path + ': nullable not boolean true');
  if (schema.type === 'array') {
    ok(schema.items && typeof schema.items === 'object', path + ': array without items');
    validate(schema.items, path + '.items');
  }
  if (schema.properties !== undefined) {
    ok(schema.type === 'object', path + ': properties on a non-object');
    for (const [k, v] of Object.entries(schema.properties)) validate(v, path + '.properties.' + k);
  }
  if (schema.required !== undefined) {
    ok(Array.isArray(schema.required), path + ': required not an array');
    for (const r of schema.required) {
      ok(schema.properties && schema.properties[r], path + ': required names a missing property: ' + r);
    }
  }
}

// ── 1. The real tool surface ────────────────────────────────────────────────
const { toolDefinitions } = require('../electron/tools');
const TOOLS = toolDefinitions;
const decls = toGeminiDeclarations(TOOLS.map((t) => ({ function: t })));
ok(decls.length > 0, 'no declarations were produced from the built-in tools');
for (const d of decls) {
  ok(/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(d.name), 'bad declaration name: ' + d.name);
  validate(d.parameters, d.name);
}
console.log('built-in tools lowered: ' + decls.length + ' / ' + TOOLS.length);

// No duplicate names (Gemini rejects two declarations with one name).
const names = decls.map((d) => d.name);
ok(new Set(names).size === names.length, 'duplicate declaration names after lowering');

// The Grep enum and the Task enum survive as string enums.
const grep = decls.find((d) => d.name === 'Grep');
ok(!!grep, 'Grep declaration missing');
ok(JSON.stringify(grep.parameters.properties.output_mode.enum) === '["content","files_with_matches","count"]',
  'Grep output_mode enum was not preserved');

// ── 2. Pathological schema shapes ───────────────────────────────────────────
const union = toGeminiSchema({ type: ['string', 'object'] });
ok(union.type === 'string', 'type array did not collapse to its first real type');

const nullableUnion = toGeminiSchema({ anyOf: [{ type: 'string' }, { type: 'null' }] });
ok(nullableUnion.type === 'string' && nullableUnion.nullable === true, 'nullable union was not lowered');

const multiEnum = toGeminiSchema({ anyOf: [{ enum: ['a'] }, { enum: ['b'] }] });
ok(JSON.stringify(multiEnum.enum) === '["a","b"]', 'multi-branch enum was not merged');

const boolEnum = toGeminiSchema({ type: 'boolean', enum: [true, false] });
ok(boolEnum.type === 'string' && JSON.stringify(boolEnum.enum) === '["true","false"]',
  'boolean enum was not stringified: ' + JSON.stringify(boolEnum));

const numEnum = toGeminiSchema({ type: 'integer', enum: [1, 2] });
ok(numEnum.type === 'string' && JSON.stringify(numEnum.enum) === '["1","2"]', 'numeric enum was not stringified');

// `required` naming a property JSON Schema did not declare must not survive.
const stale = toGeminiSchema({
  type: 'object',
  properties: { a: { type: 'string' } },
  required: ['a', 'ghost'],
});
ok(JSON.stringify(stale.required) === '["a"]', 'stale required entry survived: ' + JSON.stringify(stale.required));

// Unsupported keywords are dropped, not forwarded.
const dirty = toGeminiSchema({
  type: 'object',
  $schema: 'http://json-schema.org/draft-07/schema#',
  additionalProperties: false,
  properties: {
    when: { type: 'string', format: 'date-time', pattern: '^\\d+$', default: 'now' },
    n: { type: 'integer', minimum: 0, exclusiveMaximum: 10 },
    list: { type: 'array', items: { type: 'object', additionalProperties: { type: 'string' } } },
  },
  required: ['when'],
});
validate(dirty, 'dirty');
ok(dirty.additionalProperties === undefined, '$schema/additionalProperties leaked');
ok(dirty.properties.when.format === undefined && dirty.properties.when.pattern === undefined,
  'format/pattern leaked');
ok(dirty.properties.n.minimum === 0 && dirty.properties.n.exclusiveMaximum === undefined,
  'numeric bounds were not carried/trimmed');

// Deep nesting stops instead of recursing forever.
let deep = { type: 'string' };
for (let i = 0; i < 30; i++) deep = { type: 'array', items: deep };
validate(toGeminiSchema(deep), 'deep');

// A boolean schema (JSON Schema `true`) must not reach the wire as a boolean.
const boolSchema = toGeminiSchema(true);
ok(typeof boolSchema === 'object' && !Array.isArray(boolSchema), 'boolean schema was forwarded');

// Names Gemini cannot represent are skipped rather than 400-ing the request.
const skipped = toGeminiDeclarations([
  { function: { name: '9bad name', parameters: { type: 'object' } } },
  { function: { name: 'fine', parameters: { type: 'object', properties: {} } } },
]);
ok(skipped.length === 1 && skipped[0].name === 'fine', 'invalid names were not skipped');

console.log('gemini-schema: ' + n + ' assertions passed');
