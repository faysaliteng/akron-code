'use strict';
/**
 * Per-worker tool selection for the Swarm.
 *
 * The supervisor (manager) knows what each subtask needs, so it may tag a
 * subtask with `tools`: a short list of capability groups, MCP servers and/or
 * exact tool names. A tagged worker is advertised only that surface (plus a
 * small read-only core), instead of every built-in tool on every request; an
 * untagged worker keeps the default surface, exactly as before.
 *
 *   {"title":"Audit the API", "tools":["read","web"]}            research only
 *   {"title":"Build the page","tools":["read","edit","shell"]}   implementation
 *   {"title":"Inspect libfoo","tools":["read","mcp:rea"]}        one MCP server
 *
 * This module is pure (no requires) so tools.js and swarm.js can both load it.
 */

// Always available to a tagged worker: it can look around and track its work.
const CORE_TOOLS = ['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'ToolSearch'];

// group -> exact built-in names, and/or prefixes resolved against the live tool list
const TOOL_GROUPS = {
  read: { names: ['Read', 'Glob', 'Grep', 'LS', 'Search', 'CodebaseSearch', 'NotebookRead', 'ReadDocument', 'read_document'] },
  edit: { names: ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'NotebookEdit'] },
  shell: { names: ['Bash', 'PowerShell', 'KillShell', 'Cd', 'REPL', 'JavaScript', 'RunToolScript', 'ShadowCheck'] },
  web: { names: ['WebFetch', 'WebSearch'] },
  browser: { names: ['ext_browser'], prefixes: ['browser_', 'mcp__chrome__'] },
  computer: { prefixes: ['mcp__computer__'] },
  media: { names: ['GenerateImage', 'create_image', 'EditImage', 'edit_image', 'GenerateVideo', 'generate_video', 'EditVideo', 'edit_video'] },
  docs: { names: ['GenerateDocument', 'generate_document', 'ReadDocument', 'read_document', 'Artifact'] },
  delegate: { names: ['Task', 'Agent', 'TaskOutput', 'TaskStop', 'ListAgents'] },
  memory: { names: ['memory_add', 'memory_list', 'memory_delete'] },
  skills: { names: ['Skill', 'list_skills'] },
};
const GROUP_ALIASES = {
  files: ['read', 'edit'], file: ['read', 'edit'], fs: ['read', 'edit'], write: ['edit'], code: ['read', 'edit', 'shell'],
  bash: ['shell'], terminal: ['shell'], exec: ['shell'], search: ['read'], research: ['read', 'web'],
  internet: ['web'], chrome: ['browser'], desktop: ['computer'], image: ['media'], video: ['media'],
  document: ['docs'], subagents: ['delegate'], agents: ['delegate'],
};
const ALL_TOKENS = new Set(['all', '*', 'full', 'everything', 'default']);
const MAX_SPEC_ITEMS = 24;

/** Clean a supervisor-supplied `tools` value. Returns null when absent/unusable (= default surface). */
function normalizeToolSpec(raw) {
  let list = raw;
  if (typeof list === 'string') list = list.split(/[,\s]+/);
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    const s = String(item == null ? '' : item).trim();
    if (!s || s.length > 96 || out.includes(s)) continue;
    out.push(s);
    if (out.length >= MAX_SPEC_ITEMS) break;
  }
  return out.length ? out : null;
}

function mcpServerOf(toolName) {
  // Same shape main.js dispatches on: mcp__<serverId>__<tool>
  const m = /^mcp__(\w+?)__./.exec(String(toolName || ''));
  return m ? m[1] : '';
}

/**
 * @param {string[]|null} spec normalized `tools` of one subtask
 * @param {object} ctx
 * @param {Array<{name:string}>} [ctx.mcpTools]      MCP tool defs available to the parent turn
 * @param {string[]} [ctx.builtinToolNames]          names of every built-in tool (for prefix groups)
 * @returns {{ toolAllow: Set<string>|null, extraTools: object[], unknown: string[], summary: string }}
 *   toolAllow === null means "default surface" (no restriction).
 */
function resolveWorkerTools(spec, ctx = {}) {
  const mcpTools = Array.isArray(ctx.mcpTools) ? ctx.mcpTools.filter((t) => t && t.name) : [];
  const builtin = Array.isArray(ctx.builtinToolNames) ? ctx.builtinToolNames.map(String) : [];
  const items = normalizeToolSpec(spec);
  if (!items) return { toolAllow: null, extraTools: [], unknown: [], summary: '' };
  if (items.some((s) => ALL_TOKENS.has(s.toLowerCase()))) {
    return { toolAllow: null, extraTools: mcpTools.slice(), unknown: [], summary: 'all tools' };
  }

  const allow = new Set(CORE_TOOLS);
  const extra = new Map();
  const unknown = [];
  const labels = [];
  const servers = new Set(mcpTools.map((t) => mcpServerOf(t.name)).filter(Boolean));
  const builtinLower = new Map(builtin.map((n) => [n.toLowerCase(), n]));

  const addGroup = (g) => {
    const def = TOOL_GROUPS[g];
    if (!def) return false;
    for (const n of def.names || []) allow.add(n);
    for (const pre of def.prefixes || []) {
      for (const n of builtin) if (n.startsWith(pre)) allow.add(n);
    }
    return true;
  };
  const addServer = (sid) => {
    let n = 0;
    for (const t of mcpTools) {
      if (mcpServerOf(t.name) !== sid) continue;
      extra.set(t.name, t);
      allow.add(t.name);
      n++;
    }
    return n;
  };

  for (const item of items) {
    const low = item.toLowerCase();
    if (TOOL_GROUPS[low]) { addGroup(low); labels.push(low); continue; }
    if (GROUP_ALIASES[low]) { for (const g of GROUP_ALIASES[low]) addGroup(g); labels.push(low); continue; }
    if (low === 'mcp') {
      for (const t of mcpTools) { extra.set(t.name, t); allow.add(t.name); }
      labels.push('mcp');
      continue;
    }
    // "mcp:<server>" or a bare connected server id ("rea", "linear")
    const srv = /^mcp:(.+)$/.exec(low);
    if (srv || servers.has(low)) {
      const sid = srv ? srv[1] : low;
      const n = servers.has(sid) ? addServer(sid) : 0;
      // The built-in gateway tool of the same name (e.g. `rea`) rides along.
      if (builtinLower.has(sid)) allow.add(builtinLower.get(sid));
      if (n || builtinLower.has(sid)) labels.push('mcp:' + sid);
      else unknown.push(item);
      continue;
    }
    // exact tool name: built-in (case-insensitive) or one MCP tool
    const mcpHit = mcpTools.find((t) => t.name.toLowerCase() === low);
    if (mcpHit) { extra.set(mcpHit.name, mcpHit); allow.add(mcpHit.name); labels.push(mcpHit.name); continue; }
    if (builtinLower.has(low)) { allow.add(builtinLower.get(low)); labels.push(builtinLower.get(low)); continue; }
    if (!builtin.length && /^[A-Za-z][\w-]*$/.test(item)) { allow.add(item); labels.push(item); continue; }
    unknown.push(item);
  }

  // A spec that resolved to nothing must not leave a worker with only the
  // read-only core: fall back to the default surface instead.
  if (!labels.length) return { toolAllow: null, extraTools: [], unknown, summary: '' };
  return { toolAllow: allow, extraTools: [...extra.values()], unknown, summary: labels.join(', ') };
}

const TOOLS_PROMPT_HELP = '"tools" is optional: the smallest set of capabilities that subtask needs, from '
  + Object.keys(TOOL_GROUPS).join(' | ')
  + ' | mcp:<server> (one connected MCP server/plugin) | an exact tool name. '
  + 'Every worker can always read and search files. Omit "tools" to give a worker the default full toolset; '
  + 'never omit a capability the subtask needs (a subtask that writes code needs "edit", usually with "shell").';

module.exports = { CORE_TOOLS, TOOL_GROUPS, GROUP_ALIASES, normalizeToolSpec, resolveWorkerTools, mcpServerOf, TOOLS_PROMPT_HELP };
