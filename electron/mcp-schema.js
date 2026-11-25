'use strict';
// ── MCP tool-surface compaction & deferral ──────────────────────────────────
// A connected MCP server can publish hundreds of tools with verbose JSON
// Schema. The REA server alone advertises 263 tools whose schemas serialise to
// ~384 000 characters — ≈113 000 tokens of prompt on EVERY step, before the
// user has typed anything. That burns subscription allowance, crowds out a 1M
// context window, and measurably degrades tool choice.
//
// Two levers, applied in order:
//   1. compact()  — keep only the structural part of a schema (type / properties
//      / required / items / enum). Drop prose, defaults, examples, titles,
//      formats and patterns. The model needs *shape*, not documentation.
//   2. defer()    — if the compacted surface still exceeds a character budget,
//      advertise a single `find_mcp_tools` search tool instead. The model
//      searches, gets exact schemas for the matches, and calls
//      `mcp__<server>__<tool>` directly (dispatch is by name, so a deferred
//      tool is still callable). The index tool is deliberately NOT named
//      `mcp_*`: Anthropic's subscription endpoint 400s a `mcp_`+letter name.
//
// Both levers are lossless for execution: nothing is removed from the set of
// callable tools, only from the advertised text.

const MAX_ENUM = 24;
const MAX_DEPTH = 6;
const DESC_LIMIT = 160;
const DEFAULT_BUDGET = 24000; // ≈7 000 tokens of tool schema
const MAX_HITS = 8;

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

function firstSentence(s) {
  const t = oneLine(s);
  if (!t) return '';
  const m = /^[^.!?]{1,200}[.!?]/.exec(t);
  const head = m ? m[0] : t;
  return head.length > DESC_LIMIT ? head.slice(0, DESC_LIMIT - 1).trimEnd() + '…' : head;
}

// Structural schema only. Unknown keys are dropped on purpose.
function compactSchema(schema, depth) {
  const d = depth || 0;
  if (!schema || typeof schema !== 'object' || d > MAX_DEPTH) return { type: 'object' };
  if (Array.isArray(schema)) return schema.map((s) => compactSchema(s, d + 1));
  // anyOf / oneOf / allOf: keep the first branch that carries a real type
  // (a `null` branch is an optionality marker, not the shape).
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(schema[k]) && schema[k].length) {
      const typed = schema[k].filter((b) => b && typeof b === 'object' && b.type && b.type !== 'null');
      if (typed.length) return compactSchema(typed[0], d + 1);
      return compactSchema(schema[k][0], d + 1);
    }
  }
  const out = {};
  const t = Array.isArray(schema.type)
    ? (schema.type.find((x) => x && x !== 'null') || 'string')
    : schema.type;
  const type = t || (schema.properties ? 'object' : schema.items ? 'array' : schema.enum ? 'string' : undefined);
  if (type) out.type = type;
  if (Array.isArray(schema.enum)) {
    out.enum = schema.enum.slice(0, MAX_ENUM).map((v) => (v && typeof v === 'object' ? String(v.value ?? v) : v));
    if (schema.enum.length > MAX_ENUM) out.enumOpen = true;
  }
  if (schema.const !== undefined && typeof schema.const !== 'object') out.const = schema.const;
  if (schema.properties && typeof schema.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties)) out.properties[k] = compactSchema(v, d + 1);
  }
  if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required.slice();
  if (schema.items !== undefined) out.items = compactSchema(schema.items, d + 1);
  if (!out.type && !out.properties && !out.items && !out.enum) return {};
  return out;
}

// One advertised MCP tool: compact schema + a single short line of prose.
function compactTool(t) {
  const name = String(t && t.name || '');
  return {
    name,
    description: firstSentence(t && t.description),
    inputSchema: compactSchema(t && (t.inputSchema || t.parameters) || { type: 'object', properties: {} }),
  };
}

const sizeOf = (tool) => name_(tool).length + (tool.description || '').length + JSON.stringify(tool.inputSchema || {}).length;
const name_ = (tool) => String(tool && tool.name || '');

// Decide what to advertise. Returns
//   { mode, tools, deferred: [names], chars, savedChars }
function buildSurface(fullTools, opts) {
  const budget = Number((opts && opts.budget) || DEFAULT_BUDGET);
  const list = Array.isArray(fullTools) ? fullTools : [];
  const compacted = list.map(compactTool);
  const chars = compacted.reduce((n, t) => n + sizeOf(t), 0);
  const rawChars = list.reduce((n, t) => n + JSON.stringify(t).length, 0);
  if (!compacted.length) return { mode: 'none', tools: [], deferred: [], chars: 0, rawChars: 0, savedChars: 0 };
  if (chars <= budget) {
    return { mode: 'full', tools: compacted, deferred: [], chars, rawChars, savedChars: rawChars - chars };
  }
  return {
    mode: 'deferred',
    tools: [],
    deferred: compacted.map((t) => t.name),
    chars: 0,
    rawChars,
    savedChars: rawChars,
  };
}

// Search a full (uncompacted) MCP tool list by keyword. Name matches outrank
// description matches; a server name narrows the pool.
function searchMcpTools(fullTools, query, server) {
  const q = oneLine(query).toLowerCase();
  const terms = q.split(/[^a-z0-9_]+/).filter((w) => w.length > 1);
  const pool = (Array.isArray(fullTools) ? fullTools : []).filter((t) => {
    if (!server) return true;
    return name_(t).toLowerCase().startsWith(`mcp__${String(server).toLowerCase()}__`);
  });
  if (!terms.length) {
    return pool.slice(0, MAX_HITS).map(compactTool);
  }
  const scored = [];
  for (const t of pool) {
    const nm = name_(t).toLowerCase();
    const ds = oneLine(t && t.description).toLowerCase();
    let score = 0;
    for (const w of terms) {
      if (nm.includes(w)) score += 6;
      if (nm.includes(`_${w}`) || nm.includes(`${w}_`)) score += 3;
      if (ds.includes(w)) score += 2;
    }
    if (score > 0) scored.push([score, t]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  return scored.slice(0, MAX_HITS).map(([, t]) => compactTool(t));
}

module.exports = {
  compactSchema,
  compactTool,
  buildSurface,
  searchMcpTools,
  firstSentence,
  DEFAULT_BUDGET,
  MAX_HITS,
  DESC_LIMIT,
};
