'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { toolDefinitions, runTool } = require('./tools');
const swarm = require('./swarm');
const hooks = require('./hooks');
const budgetPool = require('./budget');
const modelCatalog = require('./model-catalog');
const providertransport = require('./providertransport');
const mcpSchema = require('./mcp-schema');
const gate = require('./provider-gate');
const router = require('./orch-router');

const LEAN_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'Bash', 'LS', 'TodoWrite', 'WebFetch', 'WebSearch', 'ToolSearch']);
const STANDARD_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'LS', 'Search', 'TodoWrite', 'WebFetch', 'WebSearch',
  'Task', 'Agent', 'TaskOutput', 'TaskStop', 'ListAgents', 'Swarm', 'Workflow', 'ToolSearch', 'find_mcp_tools', 'Skill', 'list_skills',
  'TeamCreate', 'TaskCreate', 'TaskList', 'TaskGet', 'TaskUpdate', 'SendMessage',
  'CreateCustomTool', 'ListCustomTools', 'DeleteCustomTool', 'ext_browser', 'rea',
  'EnterWorktree', 'ExitWorktree', 'EnterPlanMode',
  'AskUserQuestion', 'ExitPlanMode', 'KillShell', 'Artifact', 'Cd',
  'memory_add', 'memory_list', 'mcp__visualize__visualize',
  'browser_open', 'browser_navigate', 'browser_read', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_screenshot',
]);

// Sub-agents may delegate one more level (Antigravity helpers); deeper
// recursion is refused so a confused model cannot fork itself forever.
const MAX_AGENT_DEPTH = 2;

// Opt-in JSONL tracer for live transport forensics. `AUTOBOT_TRACE` must be the
// path of the FILE to append to (e.g. /tmp/akron/trace.jsonl); its parent
// directory is created on demand. Kept off by default and never able to throw
// into a run — every write is best-effort.
let TRACE_READY = false;
function traceLine(obj) {
  const dest = process.env.AUTOBOT_TRACE;
  if (!dest) return;
  try {
    if (!TRACE_READY) {
      const dir = path.dirname(dest);
      if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });
      TRACE_READY = true;
    }
    fs.appendFileSync(dest, JSON.stringify(obj) + '\n');
  } catch (_) { /* tracing must never break a turn */ }
}

// Registry of live sub-agents (for TaskStop / ListAgents).
const subagentControllers = new Map(); // name -> AbortController

// Names of tools handled locally (built-in + virtual MCP namespaces). Anything
// else that starts with mcp__ is an external MCP server tool.
const localToolNames = new Set(toolDefinitions.map((t) => t.name));

// ── Provider tool caps ─────────────────────────────────────────────────────
// Tools that must never be shed when a provider limits the advertised count:
// they are the ones every task needs (read/edit/run/search/browse/todo + the
// discovery escape hatch that makes shed tools findable again).
const CORE_TOOLS = new Set([
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep',
  'WebFetch', 'WebSearch', 'TodoWrite', 'Task', 'Agent', 'rea', 'ext_browser',
  'browser_open', 'browser_navigate', 'browser_read', 'browser_snapshot',
  'browser_click', 'browser_type', 'browser_screenshot', 'browser_js',
  'ToolSearch', 'find_mcp_tools', 'Skill', 'AskUserQuestion', 'KillShell',
]);

// Shed order: lowest marginal value first. The virtual `mcp__*` aliases come
// first because each one duplicates a core tool above (workspace__bash = Bash,
// memory__* = memory_*, chrome__* = browser_*), so dropping them costs nothing
// while the real tool stays advertised.
const AUX_TOOL_ORDER = [
  'mcp__workspace__bash', 'mcp__workspace__read_file', 'mcp__workspace__write_file',
  'mcp__workspace__edit_file', 'mcp__workspace__glob', 'mcp__workspace__grep',
  'mcp__workspace__web_fetch',
  'mcp__chrome__list_tabs', 'mcp__chrome__navigate', 'mcp__chrome__evaluate',
  'mcp__chrome__screenshot',
  'mcp__terminal__list_terminal_tabs', 'mcp__terminal__open_terminal_tab',
  'mcp__terminal__read_terminal', 'mcp__terminal__run_in_terminal',
  'mcp__terminal__stop_terminal_tab',
  'mcp__memory__memory_add', 'mcp__memory__memory_list', 'mcp__memory__memory_delete',
  'mcp__skills__list_skills', 'mcp__skills__load_skill',
  'mcp__ccd_submit', 'mcp__ccd_list', 'mcp__bots__send',
  'mcp__botbridge__start', 'mcp__botbridge__register',
  'mcp__cowork__register_worker', 'mcp__cowork__list_workers', 'mcp__cowork__orchestrate',
  'mcp-registry__list_connectors', 'mcp-registry__search_mcp_registry',
  'mcp-registry__suggest_connectors',
  'plugins__list_plugins', 'plugins__search_plugins', 'plugins__search_connectors',
  'plugins__suggest_plugin_install', 'plugins__install', 'plugins__uninstall',
  'plugins__directory_stats', 'plugins__refresh_registry',
  'PushNotification', 'RemoteTrigger', 'Monitor', 'ScheduleWakeup',
  'CronCreate', 'CronList', 'CronDelete', 'SendUserFile', 'Brief', 'StructuredOutput',
  'Workflow', 'TaskOutput', 'TeamCreate', 'TeamDelete', 'ListAgents',
  'SendUserMessage', 'SetGoal', 'EnterWorktree', 'ExitWorktree',
  'EnterPlanMode', 'ExitPlanMode', 'ConnectGitHub', 'PowerShell', 'Mcp',
  'LS', 'Search', 'Cd', 'Jira', 'Linear', 'Artifact', 'SlashCommand',
  'ListMcpResources', 'ReadMcpResource', 'NotebookRead', 'NotebookEdit',
  'REPL', 'JavaScript', 'create_skill', 'delete_skill',
  'mcp__visualize__visualize', 'list_notebooks', 'list_slash_commands',
  'memory_add', 'memory_list', 'memory_delete', 'list_skills',
];

/**
 * Max tools this provider accepts in one request. 0 = no known cap.
 * `provider.maxTools` wins; otherwise infer from the endpoint, because a
 * provider that rejects the request outright costs the entire turn.
 * A cap learned from a live rejection (`shaveCaps`) always wins over the
 * inferred one — the provider told us the number it will accept.
 */
function toolCapFor(provider) {
  const key = providerCapKey(provider);
  if (shaveCaps.has(key)) return shaveCaps.get(key);
  const explicit = Number(provider && provider.maxTools);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const hay = [
    provider && provider.baseURL,
    provider && provider.name,
    provider && provider.id,
  ].filter(Boolean).join(' ').toLowerCase();
  // Groq: "'tools' : maximum number of items is 128". FreeLLMAPI routes to
  // Groq/Gemini/Cloudflare behind one host, so it inherits the strictest cap.
  if (/groq\.com|127\.0\.0\.1:3001|localhost:3001/.test(hay)) return 128;
  return 0;
}

function providerCapKey(provider) {
  return String((provider && (provider.baseURL || provider.id || provider.transport)) || 'default');
}

// Caps learned from a real rejection, per provider. Session-scoped on purpose:
// a provider's limit can change with an account tier, and a hardcoded guess
// must never outlive the evidence.
const shaveCaps = new Map();

/** Shrink an advertised tool list to `cap`, lowest-value tools first. */
function trimToolsTo(tools, cap) {
  let out = tools;
  const dropped = [];
  if (!cap || out.length <= cap) return { tools: out, dropped };
  const order = AUX_TOOL_ORDER.filter((n) => out.some((t) => t.function && t.function.name === n));
  while (out.length > cap && order.length) {
    const name = order.shift();
    out = out.filter((t) => !(t.function && t.function.name === name));
    dropped.push(name);
  }
  // Still over (a huge MCP surface): shed the fattest non-core schemas too.
  while (out.length > cap) {
    let worst = -1; let worstLen = -1;
    out.forEach((t, i) => {
      const nm = t.function && t.function.name;
      if (CORE_TOOLS.has(nm)) return;
      const len = JSON.stringify(t).length;
      if (len > worstLen) { worstLen = len; worst = i; }
    });
    if (worst < 0) break;
    dropped.push(out[worst].function.name);
    out = out.slice(0, worst).concat(out.slice(worst + 1));
  }
  return { tools: out, dropped };
}

/** True when the provider refused the request shape/size rather than the task. */
function isToolCapError(e) {
  const s = String((e && (e.message || e.reason)) || '');
  return /maximum number of items|too many tools|tools.{0,20}(exceed|limit)|request(ed)? too large|tokens per minute|\bTPM\b|payload too large|reduce your/i.test(s);
}

const SYSTEM_PROMPT = `You are Akron Code, an agentic desktop coding assistant running on the user's Mac (a local alternative to the Example desktop app). You work inside the user's project folder and you actually create, edit, and run code. You do not just describe code — you build it.

## Working style
- Be concise. Do the work with tools; narrate only the key steps.
- Start executing immediately: do at most ONE quick directory/file check (LS or Glob), post your plan with TodoWrite, and begin creating/editing code right away. Never spend multiple turns probing the environment without writing code.
- For anything multi-step, call TodoWrite first, then execute the steps one by one.
- Never claim something is done until a tool result proves it. Verify with ls / Read / running the build.
- Keep working until the task is genuinely complete. Do not stop after a plan, and do not stop after one partial edit.
- If the user asks for something a tool can do, CALL THE TOOL. Never invent tool output.

## Writing files — CRITICAL
- Create or fully replace a file with the Write tool: {"path": "relative/path.ext", "content": "<COMPLETE file contents>"}
  - One Write per file, containing the COMPLETE final contents. No fragments, no placeholders like "// rest of code", no "..." elisions.
  - Relative paths resolve inside <project_workspace>.
- Change an existing file with Edit: {"path": "...", "old_string": "...", "new_string": "..."}
  - Read the file first, then copy old_string EXACTLY (including indentation) from the Read output.
  - Use MultiEdit when you need several changes to the same file in one step.
- NEVER create or modify files with shell heredocs (cat > f <<'EOF'), echo, tee, printf, or sed -i. Those corrupt code and are why builds fail. Shell is for RUNNING programs, installing dependencies, and git — Write/Edit is for content.
- If Write or Edit returns an error, read the error, fix the arguments (usually a wrong path or an old_string that does not match), and retry. Never fall back to bash file-writing hacks.

## Building something the user can SEE (websites, apps, UIs, diagrams)
- When asked for a website / page / app / dashboard / component / SVG / diagram / chart, produce BOTH a real file and a live preview:
  1. TodoWrite the plan.
  2. Write the file(s) into the project folder.
  3. Call Artifact {name, language, content} with the main UI file so it renders live with Code / Preview tabs.
  4. Verify (run or preview it, read errors) and fix.
  5. Finish by listing the file paths you created.
- html, svg, mermaid and react/JSX render live. Keep them self-contained — inline CSS/JS, no build step — unless the user explicitly asks for a framework project (Vite/Next/etc.).
- For data charts (bar/line/pie/scatter/area) use mcp__visualize__visualize instead of hand-writing SVG.

## Verifying your work
- After writing code, actually run it: e.g. \`node file.js\`, \`python3 file.py\`, \`npm run build\`, \`npx serve .\`.
- Read the errors, fix the files, run again. Iterate until it works — do not report success on untested code.
- If Write/Edit returns \`[SYNTAX WARNING]\`, fix that syntax error immediately with Edit before running commands or moving on.

## Multi-agent coordination & fast coding
- Batch independent read-only calls (Read, Glob, Grep, LS, Search, TodoWrite) **in one turn** — wave execution runs consecutive read/agent waves concurrently while mutating writes stay ordered.
- Delegate independent investigations, reviews, or parallel module builds via \`Task\` / \`Agent\` (\`Explore\`, \`general-purpose\`, \`verifier\`, \`code-reviewer\`), and pass \`resume: "<agentId>"\` to continue an existing sub-agent with full prior context instead of restarting cold.
- Always \`Read\` an existing file before \`Edit\`/\`MultiEdit\`; if warned that the file changed on disk, re-\`Read\` it before editing so concurrent agents never overwrite each other.
- Before claiming a complex coding task is complete, verify it with \`Bash\` tests/builds or spawn a \`Task(subagent_type="verifier")\` check.

## When to stop
- Verification is not the task. When the thing you built is confirmed working once, stop checking and report.
- Never repeat a tool call whose arguments you already sent and whose result you already read. If a check passed, it passed.
- If a tool fails twice, change approach or tell the user — do not loop on the same call.
- Finish by writing a short summary: what you built, the file paths, how to run it, and anything unfinished. Then stop calling tools.

## Delegation — when to use a team
- One coherent task you can finish yourself → just do it. Do not delegate ordinary work.
- A goal with 2+ genuinely **independent** parts (frontend + backend, research + implementation,
  refactor + tests, design + docs) → if the \`Swarm\` tool is available (the user enabled it), call
  \`Swarm\` {"goal": "..."}. It runs a team of **frontier models**. The supervisor splits the goal,
  every subtask runs **concurrently**, then the supervisor reviews and merges. Pass "tasks" yourself
  if you already know the split. When \`Swarm\` is not offered, delegate with \`Task\`/\`Agent\` instead.
- One isolated sub-task whose chatter you do not want in your context (a broad search, a file
  survey, a self-contained script) → call \`Task\` {"description","prompt"}. The child runs its own
  loop and returns only its final message.
- Complexity tiers, used by both tools: \`small\` = cheap/fast model for mechanical or boilerplate
  work, \`heavy\` = the workhorse model for real implementation, \`critical\` = the strongest model
  for architecture, security review, or anything that must be right first time. Pass
  {"tier":"small"} / {"tier":"heavy"} / {"tier":"critical"}, or {"model":"<id>"} to pin a specific one.
- Delegate when it genuinely shortens the work or splits it across models — not for a job you can
  do in one or two tool calls. After delegating, use the workers' results; do not redo their work.

## Other capabilities
- Browser tools (browser_open / browser_navigate / browser_snapshot / browser_click / browser_type / browser_screenshot / browser_tabs) for in-app web tasks, plus \`ext_browser\` when the user's Chrome/Brave/Edge browser is connected via Akron Browser Bot.
- Reverse Engineering (built-in REA / \`morluto/rea\`): when asked to reverse engineer, inspect shipped binaries/ASAR/APK/IPA/firmware/captures, decompile, or audit release exposure, use \`rea\` (or \`find_mcp_tools\` for \`mcp__rea__*\`) and load \`Skill\` \`"reverse-engineer-anything"\`.
- web_search / web_fetch for facts you are unsure about.
- Shell, Read, Glob, Grep, memory and todo tools as needed.

## Tone and style
- Answer the question that was asked. Do not pad with restatements, apologies, or "Great question".
- Use plain prose. No emoji unless the user uses them. No headers in a one-line answer.
- When you reference code, name the file and the line: \`src/App.jsx:412\`. Never cite a line number you have not read.
- Report outcomes honestly. If something is broken or untested, say so in one sentence and fix it or explain.

## Tool usage policy
- Prefer one accurate tool call to three speculative ones. Read before you write; Glob/Grep before you guess a path.
- Run independent read-only calls (Read, Glob, Grep, LS, Search, WebFetch, WebSearch) **in the same turn** — they execute concurrently.
- Mutating tools run one at a time, in order. Never batch Write + Bash expecting the shell to see the file.
- Do not use Bash for file edits. Write/Edit/MultiEdit own file content; Bash runs programs, installs deps, and drives git.
- Only mark a TodoWrite item completed when the tool result proves it.

## Skills
- A skill is a reusable instruction pack. Before answering a task that a skill covers, call \`Skill\` with the exact skill name (no leading slash).
- Namespaced skills use \`plugin:skill\`. Pass arguments via \`args\` when the skill expects them.
- If you used a skill, follow its instructions over your own default approach.

## Plan mode
- When plan mode is on you are read-only: research, design, and write ONE plan file. Do not mutate source.
- Work the phases in order: **Explore** (read files, search, gather facts — the only phase that may read) → **Design** (write the plan) → **Review** (re-read your own plan for gaps, risky steps, missing verification) → then **Implement** and **Verify** once the user approves.
- End the turn with \`ExitPlanMode\` {"plan": "<the plan>"} so the user can approve it. Use \`AskUserQuestion\` only for a genuine decision you cannot make yourself. Never ask for approval in plain prose.
- After approval you are out of plan mode: implement, verify, and report.

## Task board and teams
- \`TaskCreate\` / \`TaskUpdate\` / \`TaskList\` / \`TaskGet\` are the durable work board. Use them instead of TodoWrite when work outlives one turn or is shared with teammates.
- Teammates claim \`pending\` tasks that have no owner and no blockers, lowest id first, via \`TaskUpdate\` {owner}. Mark \`in_progress\` when you start and \`completed\` when the result is verified.
- \`TeamCreate\` / \`SendMessage\` / \`TeamDelete\` coordinate named agents. Address a teammate by name; the lead is always "team-lead".

## Automations
- \`CronCreate\` schedules a recurring prompt (5-field local cron). \`ScheduleWakeup\` re-runs you after a delay (60–3600 s). \`Monitor\` watches a command's stdout and wakes you on a line.
- \`Workflow\` runs a multi-phase script of \`agent()\` / \`parallel()\` / \`pipeline()\` calls — use it for a repeatable pipeline, not a one-off.

You are a coding agent first. Files, not chat, are the deliverable.`;

// Prompt appended when a provider cannot do native function calling. Every model
// (including plain-text / free endpoints) still gets full tool + browser control
// through this fenced-block protocol, parsed by parseTextToolCalls().
const TEXT_TOOL_PROTOCOL = `TOOL PROTOCOL (this endpoint has no native function calling):
to use a tool, emit one or more fenced blocks exactly like:

\`\`\`tool
{"name": "<tool_name>", "arguments": {<json arguments>}}
\`\`\`

Rules:
- One JSON object per block; valid JSON only; no comments inside the block.
- You may emit several blocks in one reply; they run in order.
- The system answers each call with a "TOOL RESULT <id>" message. Use those results, never invent them.
- When you are done, reply normally without a tool block.
- To drive the built-in browser use browser_open / browser_navigate / browser_snapshot / browser_click / browser_type / browser_screenshot / browser_tabs exactly like any other tool.`;

// Extract tool calls from an assistant text reply (fenced ```tool blocks or
// <tool_use> tags). Returns the same shape as native tool_calls.
function parseTextToolCalls(text, opts = {}) {
  if (!text || typeof text !== 'string') return [];
  // Reasoning models leave <think> blocks in content; a call quoted inside the
  // model's own deliberation is not a call.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
  const out = [];
  let seq = 0;
  const push = (raw) => {
    let o;
    try { o = JSON.parse(raw); } catch { return; }
    if (!o || typeof o !== 'object') return;
    const name = o.name || o.tool || (o.function && o.function.name);
    if (!name || typeof name !== 'string') return;
    let args = o.arguments != null ? o.arguments
      : o.input != null ? o.input
      : o.parameters != null ? o.parameters
      : o.function && o.function.arguments != null ? o.function.arguments
      : {};
    if (typeof args === 'string') {
      const s = args.trim();
      if (!s) args = {};
      else {
        try { args = JSON.parse(s); } catch { return; } // cut off mid-JSON — never run it as {}
      }
    }
    if (!args || typeof args !== 'object') args = {};
    seq++;
    out.push({ id: 'txt_' + seq + '_' + Math.random().toString(36).slice(2, 7), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  };
  let m;
  // Native mode only falls back to unambiguous call syntax: a ```json example
  // in an explanation must never execute.
  if (!opts.nativeFallback) {
    const fence = /```[ \t]*(?:tool|tool_use|json)?[ \t]*\r?\n([\s\S]*?)```/g;
    while ((m = fence.exec(text))) {
      const body = m[1].trim();
      if (/"(?:name|tool)"\s*:/.test(body)) push(body);
    }
  }
  const tag = /<tool_use>([\s\S]*?)<\/tool_use>/g;
  while ((m = tag.exec(text))) push(m[1].trim());
  // Qwen3-Coder / Llama style: <function=Write><parameter=path>…</parameter>…</function>
  // or <function=Write>{json}</function>, usually inside <tool_call>…</tool_call>.
  let rest = text;
  const fn = /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)<\/function>/g;
  while ((m = fn.exec(text))) {
    const nm = m[1];
    const body = m[2].trim();
    let args = null;
    if (/<parameter=/.test(body)) {
      args = {};
      const pr = /<parameter=([A-Za-z0-9_.-]+)>\r?\n?([\s\S]*?)\r?\n?<\/parameter>/g;
      let q;
      while ((q = pr.exec(body))) {
        const v = q[2];
        const t = v.trim();
        if (/^(-?\d+(\.\d+)?|true|false|null)$/.test(t) || /^[[{]/.test(t)) {
          try { args[q[1]] = JSON.parse(t); continue; } catch (_) { /* keep as string */ }
        }
        args[q[1]] = v;
      }
    } else if (body) {
      try { args = JSON.parse(body); } catch (_) { args = null; }
    } else {
      args = {};
    }
    if (args && typeof args === 'object') push(JSON.stringify({ name: nm, arguments: args }));
    rest = rest.replace(m[0], '');
  }
  // Hermes / Qwen: <tool_call>{"name":…,"arguments":…}</tool_call>
  const tcall = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  while ((m = tcall.exec(rest))) {
    const body = m[1].trim();
    if (body.startsWith('{')) push(body);
  }
  // A reply that is nothing but one call object.
  if (!out.length) {
    const t = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
    if (t.startsWith('{') && t.endsWith('}') && /"name"\s*:/.test(t) && /"(?:arguments|parameters|input)"\s*:/.test(t)) push(t);
  }
  return out;
}

// Normalize provider config with sensible defaults.
function normalizeProvider(p) {
  p = p || {};
  let baseURL = (p.baseURL || '').trim();
  // A native transport (Anthropic Messages / Codex responses / Google Cloud
  // Code) knows its own endpoint. Defaulting to Ollama here would POST a
  // subscription bearer token at localhost — so leave it empty for them.
  if (!baseURL && !p.transport) baseURL = 'http://localhost:11434/v1';
  if (baseURL && !baseURL.endsWith('/')) baseURL += '/';
  const model = (p.model || '').trim() || 'llama3.1';
  return {
    baseURL,
    apiKey: p.apiKey || '',
    model,
    temperature: p.temperature != null ? Number(p.temperature) : 0.7,
    // Reasoning models (Kimi K3.1, DeepSeek V4.1, etc.) spend token budget on
    // chain-of-thought BEFORE emitting code/tool calls. 4096 truncates them
    // mid-thinking (finish_reason "length"), so the website/code never appears.
    // Default higher; runAgent also retries with a bigger budget on truncation.
    maxTokens: p.maxTokens != null ? Number(p.maxTokens) : 32000,
    // A caller that already knows the selected model's window (the picker does,
    // and orchestrator entries may) pins it here. Dropping it made budgetForModel
    // resolve the model's *name* instead of the window the user saw in the UI.
    contextWindow: Number(p.contextWindow) > 0 ? Number(p.contextWindow) : 0,
    // Reasoning / thinking level: 'auto' (provider default) | 'low' | 'medium'
    // | 'high'. Only mapped to the OpenAI-style `reasoning_effort` request param
    // when NOT 'auto', so providers that reject it are never sent an unknown field.
    reasoningLevel: ['low', 'medium', 'high'].includes(p.reasoningLevel) ? p.reasoningLevel : 'auto',
    supportsTools: p.supportsTools !== false,
    // Native provider transports (Anthropic Messages, Codex responses, Google
    // Cloud Code). When `transport` names a real adapter, `chatCompletion`
    // delegates instead of assuming an OpenAI-compatible `/chat/completions`
    // gateway — a subscription endpoint is not an API gateway.
    transport: p.transport || '',
    oauth: !!p.oauth,
    accessToken: p.accessToken || '',
    account: p.account || '',
    accountId: p.accountId || '',
    sessionId: p.sessionId || '',
    codexUrl: p.codexUrl || '',
    cloudcodeUrl: p.cloudcodeUrl || '',
    // `<providerId>:<account>` as set by the renderer's account picker. The
    // provider prefix keys the live model catalog, so the token budget must see
    // it — dropping it here silently reverted every model to the 128k default.
    oauthProvider: p.oauthProvider || '',
    project: p.project || '',
    // Pool/gate metadata: per-row concurrency cap and the job it serves.
    maxConcurrent: Number(p.maxConcurrent) > 0 ? Number(p.maxConcurrent) : undefined,
    role: p.role || '',
    gateKey: p.gateKey || '',
  };
}

function sanitizeOpenAIWireMessages(messages, provider) {
  const hay = `${(provider && provider.baseURL) || ''} ${(provider && provider.model) || ''}`;
  const keepReasoning = /deepseek|moonshot|kimi/i.test(hay);
  const idMap = new Map();
  let seq = 0;
  return (messages || []).map((m) => {
    if (!m || typeof m !== 'object') return m;
    const copy = { ...m };
    if (!keepReasoning && 'reasoning_content' in copy) delete copy.reasoning_content;
    if (copy.role === 'assistant' && Array.isArray(copy.tool_calls)) {
      copy.tool_calls = copy.tool_calls.map((tc) => {
        if (!tc || typeof tc !== 'object') return tc;
        const rawId = tc.id || '';
        const cleanId = rawId && /^[A-Za-z0-9_-]{1,64}$/.test(rawId)
          ? rawId
          : (String(rawId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || ('call_akron_' + (++seq)));
        if (rawId) idMap.set(rawId, cleanId);
        const fn = tc.function || {};
        return {
          id: cleanId,
          type: 'function',
          function: {
            name: String(fn.name || tc.name || 'tool'),
            arguments: typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {}),
          },
        };
      });
    }
    if (copy.role === 'tool') {
      const rawId = copy.tool_call_id || copy.toolCallId || '';
      if (rawId && idMap.has(rawId)) copy.tool_call_id = idMap.get(rawId);
      else if (rawId) copy.tool_call_id = String(rawId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
    }
    return copy;
  });
}

async function chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta) {
  // Delegating to a wire adapter keeps one stream contract for the agent loop:
  // the adapter returns the same {content, tool_calls, finish_reason, usage}
  // shape the OpenAI-compatible path does, so failover and parsing are unchanged.
  if (providertransport.needsTransport(provider)) {
    return providertransport.chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride, onToolDelta);
  }
  const url = provider.baseURL + 'chat/completions';
  const wireMessages = sanitizeOpenAIWireMessages(messages, provider);
  const body = {
    model: provider.model,
    messages: wireMessages,
    temperature: provider.temperature,
    max_tokens: maxTokensOverride != null ? maxTokensOverride : provider.maxTokens,
    stream: true,
    // Ask for the final usage chunk so the context meter and token budget work
    // on OpenAI-compatible gateways; dropped below if an endpoint rejects it.
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) body.tools = tools;
  // Reasoning effort — OpenAI-style. Only send when the user picked a level; keep
  // 'auto' out of the payload so every provider behaves as before by default.
  if (provider.reasoningLevel && provider.reasoningLevel !== 'auto') {
    body.reasoning_effort = provider.reasoningLevel;
  }
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers['authorization'] = 'Bearer ' + provider.apiKey;

  const CONNECT_TIMEOUT_MS = Number(process.env.HELIO_CONNECT_TIMEOUT_MS) || 45000;
  const doFetch = async (payload) => {
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { ctrl.abort(); } catch (_) {} }, CONNECT_TIMEOUT_MS);
    if (timer && typeof timer.unref === 'function') timer.unref();
    const onAbort = () => { try { ctrl.abort(); } catch (_) {} };
    if (signal) {
      if (signal.aborted) { clearTimeout(timer); return fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal }); }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      return await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal });
    } catch (e) {
      if (timedOut && !(signal && signal.aborted)) {
        const err = new Error(`LLM connect timed out after ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s`);
        err.transient = true;
        throw err;
      }
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
  const req = { ...body };
  let res = await doFetch(req);
  // Negotiate the request shape instead of failing outright. Some providers
  // reject `reasoning_effort` (unknown field); some cap `max_tokens` below the
  // budget we asked for. Claude Code always sends a large output budget, so when
  // a provider says "too large" we step down rather than killing the run — a
  // hard failure here looked to the user like the agent simply stopped.
  let rejectedText = '';
  let bodyRead = false;
  for (let attempt = 0; attempt < 4 && !res.ok && (res.status === 400 || res.status === 422); attempt++) {
    rejectedText = await res.text().catch(() => '');
    bodyRead = true;
    // "Prompt is too long" cannot be fixed by dropping a request field — every
    // retry sends the same history. Break out (keeping the prose for
    // isContextOverflow) so the agent loop compacts instead of quadrupling the
    // doomed round trip and then losing the message to an already-read body.
    if (isContextOverflow({ message: rejectedText })) break;
    if (/(image_url|input_image|image content|multimodal|does not support images)/i.test(rejectedText)) break;
    let changed = false;
    if (req.stream_options && /stream_options|include_usage/i.test(rejectedText)) {
      delete req.stream_options;
      changed = true;
    } else if (/reasoning_content/i.test(rejectedText) && Array.isArray(req.messages) && req.messages.some((m) => m && 'reasoning_content' in m)) {
      req.messages = req.messages.map((m) => {
        if (!m || !('reasoning_content' in m)) return m;
        const { reasoning_content: _rc, ...rest } = m;
        return rest;
      });
      changed = true;
    } else if (req.reasoning_effort) {
      delete req.reasoning_effort;
      changed = true;
    } else if (req.max_tokens && /max_tokens|max_completion_tokens|maximum|too large|exceed/i.test(rejectedText)) {
      const next = Math.floor(Number(req.max_tokens) / 2);
      if (next >= 1024) { req.max_tokens = next; changed = true; }
    } else if (req.stream_options) {
      delete req.stream_options;
      changed = true;
    }
    if (!changed) break;
    res = await doFetch(req);
    bodyRead = false;
  }
  // Remember what this provider accepted, so we don't pay the failed-request
  // round trip on every single turn of the run.
  if (res.ok) {
    if (!req.reasoning_effort && provider.reasoningLevel && provider.reasoningLevel !== 'auto') provider.reasoningLevel = 'auto';
    if (req.max_tokens && req.max_tokens !== provider.maxTokens) provider.maxTokens = Number(req.max_tokens);
  }
  // Keep the caller's object in sync when we silently dropped a field.
  if (!req.reasoning_effort) delete body.reasoning_effort;
  if (!res.ok) {
    const text = bodyRead ? rejectedText : await res.text().catch(() => '');
    const err = new Error(`LLM ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    // Respect Retry-After when the provider tells us how long to wait.
    const ra = res.headers.get('retry-after');
    if (ra) {
      const secs = Number(ra);
      if (Number.isFinite(secs) && secs > 0) err.retryAfterMs = Math.min(secs * 1000, 60000);
    }
    // Routers (FreeLLMAPI) put the reset in the body: retryAtMs / "reset ~86s".
    if (!err.retryAfterMs) {
      const hint = gate.retryHintMs(text);
      if (hint) err.retryAfterMs = hint;
    }
    err.endpoint = url;
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    // Non-streaming JSON response (some gateways/proxies ignore `stream:true`).
    // Replay the text as one delta so the UI still shows the reply instead of
    // committing an empty message at the end of the run.
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (msg && typeof msg.reasoning_content === 'string' && msg.reasoning_content) onDelta(msg.reasoning_content, true);
    if (msg && typeof msg.content === 'string' && msg.content) onDelta(msg.content);
    if (onToolDelta && msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = (tc && tc.function) || {};
        const argsStr = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || '');
        if (fn.name) {
          onToolDelta({
            id: tc.id || '',
            name: fn.name,
            argsPreview: argsStr.slice(0, 360),
            argsTail: argsStr.slice(-600),
            bytes: Buffer.byteLength(argsStr, 'utf8'),
            lines: argsStr ? (argsStr.match(/\\n|\n/g) || []).length + 1 : 0,
          });
        }
      }
    }
    if (data && data.error && !msg) {
      const err = new Error(`LLM ${Number(data.error.code) || 502}: ${JSON.stringify(data.error).slice(0, 400)}`);
      err.status = Number(data.error.code) || 502;
      throw err;
    }
    return Object.assign({ content: '', tool_calls: [] }, msg, {
      finish_reason: data.choices && data.choices[0] && data.choices[0].finish_reason,
      usage: data.usage || (msg && msg.usage) || undefined,
    });
  }

  // SSE streaming
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const message = { role: 'assistant', content: '', tool_calls: [] };
  const toolAcc = new Map();

  // A provider that opens the stream and then goes silent used to leave the run
  // spinning forever (no error, no progress, composer locked). Watch for dead
  // air and treat it like the transient network fault it is.
  const STALL_MS = Number(process.env.HELIO_STREAM_STALL_MS) || 90000;
  let stallTimer = null;
  const readWithStallGuard = () => Promise.race([
    reader.read(),
    new Promise((_, reject) => {
      stallTimer = setTimeout(() => reject(Object.assign(new Error(`LLM stream stalled: no data for ${STALL_MS / 1000}s`), { transient: true })), STALL_MS);
    }),
  ]).finally(() => clearTimeout(stallTimer));

  while (true) {
    const { done, value } = await readWithStallGuard()
      .catch((e) => {
        // A user Stop is never a partial success.
        if (signal && signal.aborted) {
          try { reader.cancel(); } catch (_) {}
          throw e;
        }
        // Keep whatever the model already emitted; only a totally silent stall
        // is worth retrying from scratch.
        if (message.content || message.tool_calls.length) {
          message.stalled = true;
          return { done: true, value: undefined };
        }
        try { reader.cancel(); } catch (_) {}
        throw e;
      });
    if (done) {
      // A last event without a trailing newline is still an event.
      buf += decoder.decode();
      if (buf.trim()) buf += '\n';
      else break;
    }
    if (!done) buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      // Gateways report upstream failures mid-stream as an error event; that
      // is a failed request (fail over / back off), not an empty success.
      if (json.error && !(json.choices && json.choices.length)) {
        const code = Number(json.error.code || json.error.status) || 502;
        const err = new Error(`LLM ${code}: ${JSON.stringify(json.error).slice(0, 400)}`);
        err.status = code >= 400 && code < 600 ? code : 502;
        const hint = gate.retryHintMs(JSON.stringify(json.error));
        if (hint) err.retryAfterMs = hint;
        if (!message.content && !message.tool_calls.length) {
          try { reader.cancel(); } catch (_) {}
          throw err;
        }
        message.stalled = true;
        continue;
      }
      if (json.usage) message.usage = json.usage;
      const choice = json.choices && json.choices[0];
      if (!choice) continue;
      if (choice.finish_reason) message.finish_reason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.content) {
        message.content += delta.content;
        onDelta(delta.content);
      }
      if (delta.reasoning_content) onDelta(delta.reasoning_content, true); // e.g. DeepSeek-style
      else if (typeof delta.reasoning === 'string' && delta.reasoning) onDelta(delta.reasoning, true); // OpenRouter / Groq gpt-oss
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          // Index-less fragments: a fragment with an id we know continues that
          // call; a fragment naming a function starts a new one; a bare
          // argument fragment continues the most recent call.
          let idx = tc.index;
          const fnPart = tc.function || (tc.name != null || tc.arguments != null ? tc : null);
          if (idx == null) {
            if (tc.id) {
              const hit = [...toolAcc].find(([, x]) => x.id === tc.id);
              idx = hit ? hit[0] : 'n' + toolAcc.size;
            } else if (fnPart && fnPart.name) {
              // A provider that resends the name on every chunk: same name and
              // the previous call's JSON is still open → continuation.
              const keys = [...toolAcc.keys()];
              const prev = keys.length ? toolAcc.get(keys[keys.length - 1]) : null;
              let open = false;
              if (prev && prev.function.name === fnPart.name && !prev.id) {
                try { JSON.parse(prev.function.arguments || ''); } catch (_) { open = true; }
              }
              idx = open ? keys[keys.length - 1] : 'n' + toolAcc.size;
            } else {
              const keys = [...toolAcc.keys()];
              idx = keys.length ? keys[keys.length - 1] : 'n0';
            }
          }
          let acc = toolAcc.get(idx);
          // Same index, different id: a provider reusing index 0 for parallel
          // calls (Gemini-compat). Keep them separate instead of gluing JSON.
          if (acc && tc.id && acc.id && tc.id !== acc.id) {
            idx = 'x' + toolAcc.size;
            acc = null;
          }
          if (!acc) {
            acc = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            toolAcc.set(idx, acc);
            message.tool_calls.push(acc);
          }
          if (tc.id) acc.id = tc.id;
          if (fnPart) {
            // Some providers resend the full name on every chunk.
            if (fnPart.name && acc.function.name !== fnPart.name) acc.function.name = acc.function.name && !fnPart.name.startsWith(acc.function.name) ? acc.function.name + fnPart.name : fnPart.name;
            const a = fnPart.arguments;
            if (a != null) {
              // Standard OpenAI streaming sends `arguments` as a JSON *string*
              // fragment that must be concatenated. Some providers (and some
              // gateways like TokenRouter) instead send a whole object or array.
              // Naively doing `+=` on that yields "[object Object]" and every
              // Write/Edit call then fails — so serialize objects properly.
              if (typeof a === 'string') {
                acc.function.arguments += a;
              } else if (typeof a === 'object') {
                acc.function.arguments = JSON.stringify(a);
              } else {
                acc.function.arguments += String(a);
              }
            }
          }
          if (onToolDelta && acc.function.name) {
            const rawArgs = String(acc.function.arguments || '');
            onToolDelta({
              id: acc.id || String(idx),
              name: acc.function.name,
              argsPreview: rawArgs.slice(0, 360),
              argsTail: rawArgs.slice(-600),
              bytes: Buffer.byteLength(rawArgs, 'utf8'),
              lines: rawArgs ? (rawArgs.match(/\\n|\n/g) || []).length + 1 : 0,
            });
          }
        }
      }
    }
    if (done) break;
  }
  // Every call needs an id or its result cannot be paired (orphan → 400).
  message.tool_calls.forEach((c, i) => {
    if (!c.id) c.id = 'call_' + Date.now().toString(36) + '_' + i + Math.random().toString(36).slice(2, 6);
  });
  return message;
}

// HTTP statuses worth retrying. Rate limits, client timeouts, and the entire 5xx
// family — CDNs and gateways answer 502/503/504 (and Cloudflare's 520-527) with
// an HTML page when the upstream model blips, and that page used to land in the
// transcript verbatim as "LLM 502: <html><head><title>502 Bad Gateway".
// 4xx stays fatal: retrying a rejected request just burns the user's time.
const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529]);

// Providers report "your prompt is bigger than my window" in prose, not with a
// status code: OpenAI-compatible 400s, Anthropic's "prompt is too long: N tokens
// > M maximum", Gemini's "input token count exceeds", DeepSeek's "context length
// exceeded". Those used to fall through to `isRateLimitError()` (it matches
// /exceeded|limit reached/), which made the loop back off five rounds — ~37 s of
// waiting — and then die with "provider error 400" while the history was never
// actually compacted. Classify it separately so the agent loop can shrink the
// prompt and carry on.
function isContextOverflow(e) {
  const msg = String((e && e.message) || e || '');
  if (!msg) return false;
  if (!/context|prompt|input|messages|token|length|request/i.test(msg)) return false;
  return /context[_ -]?length|maximum context|context window(?: is| size)?|prompt is too long|too many tokens|input is too long|input token count|token count exceeds|exceeds? (?:the )?(?:model'?s? )?(?:maximum|context|limit)|reduce the length|too long for (?:this )?model|request (?:is )?too large|larger than (?:the )?(?:model|context)/i.test(msg);
}

// True when the account cannot pay for *this request shape*. Distinct from a
// rate limit (retry later) and from a context overflow (shrink the prompt): for
// subscription agent providers the tool-enabled route is billed against a
// different allowance than plain chat, so a Grok account can answer a chat turn
// while its Build/agent allowance is spent. Classified so the loop can degrade
// to the text tool protocol instead of dying mid-task.
function isCreditExhausted(e) {
  if (e && Number(e.status) === 402) return true;
  const msg = String((e && e.message) || e || '');
  if (!msg) return false;
  if (/\b402\b/.test(msg)) return true;
  return /out of credit|insufficient[_ ]?(?:quota|credit|balance|funds)|credit balance|exceeded your current quota|usage balance exhausted|allowance is \d+% used|payment required|billing (?:issue|problem|required)|extra usage|not your plan limits/i.test(msg);
}

// True when an error is TRANSIENT — rate limit / quota / gateway blip / dropped
// socket — so the run should back off and retry (and possibly fail over) instead
// of dying with a red banner mid-task.
function isRateLimitError(e) {
  if (e && e.transient) return true; // stalled streams, connection resets
  if (e && RETRY_STATUS.has(Number(e.status))) return true;
  const msg = String((e && e.message) || e || '');
  const code = /^\s*LLM\s+(\d{3})\b/.exec(msg);
  if (code && RETRY_STATUS.has(Number(code[1]))) return true;
  return /429|rate.?limit|too many requests|quota|insufficient|exceeded|limit reached|billing|capacity|overloaded|throttl|bad gateway|gateway time-?out|service unavailable|upstream (error|unavailable|connect)|temporarily unavailable|try again later|application error|ECONNRESET|ECONNREFUSED|EPIPE|EAI_AGAIN|ETIMEDOUT|socket hang up|fetch failed|network|stalled/i.test(msg);
}

// Provider errors carry whatever the gateway felt like sending: nginx HTML,
// Cloudflare JS-wrapped JSON, a bare stack trace. None of that belongs in the
// chat. Strip markup, collapse whitespace, and say what actually happened.
function humanizeLLMError(e) {
  const raw = String((e && e.message) || e || 'unknown error');
  // Already human, already actionable (credential problems are worded upstream).
  if (e && e.code === 'provider_needs_signin') return raw;
  const status = Number((e && e.status) || (/^\s*LLM\s+(\d{3})\b/.exec(raw) || [])[1] || 0);
  // Drop HTML tags + the CSS/JS inside <style>/<script>, decode the few
  // entities that matter, and fold newlines.
  let body = raw
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/^\s*LLM\s+\d{3}\s*:?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  const friendly = {
    400: 'The provider rejected the request',
    401: 'The API key was rejected',
    402: 'This account is out of credit for that provider',
    403: 'The provider refused access to this model',
    404: 'The provider says that model or endpoint does not exist',
    408: 'The provider timed out',
    413: 'The request was too large for this provider',
    422: 'The provider could not process the request',
    429: 'The provider is rate limiting this key',
    500: 'The provider hit an internal error',
    502: 'The provider’s gateway returned 502 Bad Gateway',
    503: 'The provider is temporarily unavailable (503)',
    504: 'The provider’s gateway timed out (504)',
    529: 'The provider is overloaded (529)',
  }[status];
  // The adapters format their own HTTP failures, and `chatWithFailover` then
  // formats the wrapper — without this, the banner read
  // "…rate limiting this key — …rate limiting this key — {json}".
  if (friendly && body.toLowerCase().startsWith(friendly.toLowerCase())) {
    body = body.slice(friendly.length).replace(/^\s*[—–-]+\s*/, '');
  }
  // Vendor error envelopes are JSON, not prose. Lift the message so the banner
  // says something useful instead of quoting the envelope.
  try {
    const j = JSON.parse(body);
    if (j && typeof j === 'object') {
      const msg = (j.error && (j.error.message || j.error.error)) || j.message || j.detail || j.error;
      if (typeof msg === 'string' && msg.trim()) body = msg.trim();
    }
  } catch (_) {}
  // A transport that knows the real cause can hand us prose instead of the
  // vendor's envelope (Grok 402 → allowance %, reset date, prepaid balance).
  const hint = String((e && (e.hint || e.creditHint)) || '').trim();
  if (hint) body = hint;
  // A spent subscription allowance is not a rate limit to wait out — the reset
  // time is known, so the allowance read-out is the whole message. Prefixing it
  // with "rate limiting this key" told the user to retry a request that cannot
  // succeed for the next few hours.
  if (hint && e && e.retryHopeless) {
    const sentence = body.charAt(0).toUpperCase() + body.slice(1);
    return sentence.length > 200 ? sentence.slice(0, 197).trimEnd() + '…' : sentence;
  }
  // A 429 that names a credit wall is not a rate limit to wait out. Anthropic
  // answers a long-context request above the plan allowance with
  // `429 rate_limit_error: "Usage credits are required for long context
  // requests."` — telling the user their key is being throttled would send them
  // to retry a request that cannot succeed until credits are added.
  const creditWall = status === 429 &&
    /usage credits|credits? (?:are|is) required|out of credit|insufficient (?:credit|balance)|credit balance|billing (?:hard )?limit/i.test(body);
  const friendlyText = creditWall ? 'This account needs usage credits for that request' : friendly;
  // The hint is our own prose and may already lead with the friendly phrase
  // ("This account is out of credit for that provider — …"), which the earlier
  // dedupe could not see. Strip it again so the banner never repeats itself.
  if (friendlyText && body.toLowerCase().startsWith(friendlyText.toLowerCase())) {
    body = body.slice(friendlyText.length).replace(/^\s*[—–-]+\s*/, '');
  }
  if (body.length > 200) body = body.slice(0, 197).trimEnd() + '…';
  // A 404 is the only status whose prose cannot be trusted on its own: "model
  // or endpoint does not exist" covers a wrong path, a gateway that has never
  // heard of the id, and a genuinely retired model. Name the URL that answered
  // so the next person can tell those apart without a packet capture.
  let where = '';
  if (status === 404 && e && e.endpoint) {
    try {
      const u = new URL(String(e.endpoint));
      where = ' (asked ' + u.host + u.pathname + ')';
    } catch (_) {}
  }
  const head = friendlyText
    ? friendlyText + where
    : (status ? `The provider returned HTTP ${status}` : raw.split('\n')[0].slice(0, 120));
  // Only append the scrubbed detail when it is prose, not boilerplate. Gateway
  // pages are the status phrase repeated a few times with the server name, so
  // strip those tokens and see whether anything of substance is left.
  const residue = body
    .replace(/\b(?:50[0-9]|52[0-9])\b/g, ' ')
    .replace(/bad gateway|gateway time-?out|service (?:temporarily )?unavailable|temporarily unavailable|internal server error|application error|overloaded|upstream (?:error|unavailable)|nginx|cloudflare|the page you are looking for|could not be found|error|ok|undefined/gi, ' ')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
  const noisy = residue.length < 4 || body === head;
  return noisy ? head : `${head} — ${body}`;
}

// Abortable sleep used for rate-limit backoff.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
}

// Try each provider in `list` (starting at index), advancing on rate-limit
// errors. Emits an `orchestrator` event on each switch. Returns the first
// successful message; throws if all providers fail.
async function chatWithFailover(opts) {
  const list = opts.list;
  const onDelta = opts.onDelta || (() => {});
  const emit = opts.emit || (() => {});
  let tools = opts.tools;
  const messages = opts.messages;
  const signal = opts.signal;
  const maxTokens = opts.maxTokens;
  const n = list.length;
  // Advertised tools can be shaved mid-run when a provider says the request is
  // too big (Groq's 8000 TPM free tier, an endpoint capping at 128 tools).
  const shaved = new Set();
  let reqMax = maxTokens;
  // Failover walks DOWN the list from the home row. Cooldowns, dead rows and
  // per-model concurrency live in provider-gate, which every runAgent in the
  // process shares: a row that just answered 429 to one swarm worker is skipped
  // by all of them until its reset, and a saturated row (maxConcurrent) yields
  // to a free row further down, which is what spreads parallel workers.
  const MAX_ROUNDS = 5;
  const BACKOFF = [2000, 5000, 10000, 20000]; // minimum wait before round 2..5
  let lastErr = null;
  let waits = 0;
  const homeOf = () => (typeof opts.getHome === 'function' ? opts.getHome() : opts.getIndex());
  const label = (p) => (p && (p.model || p.baseURL)) || 'model';
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal && signal.aborted) throw new Error('aborted');
    const seq = n > 1 ? gate.order(list, homeOf()) : [0];
    let candidates = seq.filter((i) => gate.usable(list[i]));
    // Nothing usable right now: try the row whose cooldown ends first (a
    // single-row setup always lands here after a 429, exactly like before).
    if (!candidates.length) {
      const alive = seq.filter((i) => !gate.isDead(list[i]));
      candidates = alive.length ? [alive[0]] : (n === 1 ? [0] : []);
    }
    if (!candidates.length) break; // every row is dead for this session
    let rateLimited = false;
    for (let a = 0; a < candidates.length; a++) {
      const i = candidates[a];
      const p = list[i];
      const nextRow = () => {
        for (let b = a + 1; b < candidates.length; b++) return list[candidates[b]];
        return null;
      };
      let release = gate.tryAcquire(p);
      if (!release) release = await gate.acquire(p, signal);
      let retrySame = false;
      try {
        // A model can advertise a window this account cannot actually use
        // (Anthropic serves Sonnet 4.x at 1M only with an entitled beta).
        const winPid = String(p.oauthProvider || '').split(':')[0] || p.transport || '';
        const winBefore = modelCatalog.contextWindowFor(p.model, winPid, p.contextWindow);
        const out = await chatCompletion(p, messages, tools, onDelta, signal, reqMax, opts.onToolDelta);
        const winAfter = modelCatalog.contextWindowFor(p.model, winPid, p.contextWindow);
        if (winAfter && winBefore && winAfter < winBefore) {
          emit({ type: 'notice', text: `${p.model} advertises ${modelCatalog.fmtWindow(winBefore)} but this account is not entitled to it — this session budgets ${modelCatalog.fmtWindow(winAfter)} and compacts to fit.` });
        }
        gate.ok(p);
        if (n > 1 && typeof opts.setIndex === 'function') opts.setIndex(i);
        if (out && typeof out === 'object') out.servedBy = p.model;
        return out;
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // The provider refused the request SHAPE (too many tools, request over a
        // per-minute token limit) — not the task. Halve the advertised surface
        // and retry the same provider.
        if (isToolCapError(e) && shaved.size < 2 && tools && tools.length) {
          const key = providerCapKey(p);
          const msg = String((e && (e.message || e.reason)) || '');
          const tpmLike = /tokens per minute|\bTPM\b/i.test(msg);
          const before = tools.length;
          const nextCap = Math.max(CORE_TOOLS.size + 2, Math.floor(tools.length / 2));
          shaved.add(key);
          shaveCaps.set(key, nextCap);
          const trimmed = trimToolsTo(tools, nextCap);
          if (trimmed.tools.length < before) {
            tools = trimmed.tools;
            if (tpmLike && reqMax != null) reqMax = Math.max(1024, Math.floor(reqMax / 2));
            emit({ type: 'notice', text: `${p.model || 'The provider'} accepts fewer tools per request than we advertise — continuing with the ${tools.length} most useful ones (${trimmed.dropped.length} deferred; still callable via ToolSearch).` });
            retrySame = true;
          }
        }
        if (!retrySame) {
          // An oversized prompt is not transient: hand it back to the agent
          // loop, which compacts or chunks the input.
          if (isContextOverflow(e)) throw e;
          lastErr = e;
          const nx = nextRow();
          // Out of credit is per account, not per minute.
          if (isCreditExhausted(e)) {
            if (nx) {
              gate.markDead(p, 'out of credit', 30 * 60000);
              emit({ type: 'orchestrator', from: label(p), to: label(nx), reason: humanizeLLMError(e).slice(0, 200) });
              continue;
            }
            throw e;
          }
          if (isRateLimitError(e)) {
            // A spent subscription allowance carries its own reset time.
            if (e && e.retryHopeless) {
              if (!nx) throw e;
              gate.markDead(p, 'allowance spent', 60 * 60000);
              continue;
            }
            // A router saying this model cannot call tools at all (FreeLLMAPI:
            // "1 model lacks tool-calling") will say so on every tool request —
            // remember it for the session instead of re-asking on each failover.
            const noTools = tools && tools.length && /lacks tool[- ]calling|does not support (?:tools|tool calling|function calling)|tool(?:s| calling) (?:is |are )?not supported/i.test(String(e && e.message))
              && !/rate-limited or on cooldown/i.test(String(e && e.message));
            if (noTools) gate.markDead(p, 'model cannot call tools', 60 * 60000);
            else gate.rateLimited(p, e.retryAfterMs);
            rateLimited = true;
            if (nx) {
              emit({ type: 'orchestrator', from: label(p), to: label(nx), reason: humanizeLLMError(e).slice(0, 200) });
              continue;
            }
            break; // last candidate this round — fall through to backoff
          }
          // The gateway disowned the model or the credential (404 / 401 / 403,
          // or a 400 naming an unknown model). With healthy rows below, that
          // costs this row, not the turn.
          const st = Number(e && e.status) || Number((/^\s*LLM\s+(\d{3})\b/.exec(String(e && e.message)) || [])[1] || 0);
          const msgTxt = String(e && e.message || '');
          const modelMissing = st === 404 || ((st === 400 || st === 422) && /model[^.]{0,60}(not (found|exist|supported|available|in the catalog)|unknown|invalid|does not exist)|unknown model|no such model|plan|entitl|not included|upgrade|subscription/i.test(msgTxt));
          if ((modelMissing || st === 401 || st === 403) && n > 1) {
            gate.markDead(p, humanizeLLMError(e).slice(0, 160), modelMissing ? 30 * 60000 : 10 * 60000);
            if (nx) {
              emit({ type: 'orchestrator', from: label(p), to: label(nx), reason: humanizeLLMError(e).slice(0, 200) });
              continue;
            }
            // Every other row is cooling: try the soonest one next round.
            if (list.some((q) => !gate.isDead(q))) { rateLimited = true; break; }
          }
          throw e;
        }
      } finally {
        release();
      }
      if (retrySame) a--;
    }
    if (!rateLimited) throw (lastErr || new Error('All providers failed.'));
    if (round < MAX_ROUNDS - 1) {
      // HELIO_BACKOFF_MS pins the delay (tests + impatient operators).
      const envDelay = Number(process.env.HELIO_BACKOFF_MS);
      const base = BACKOFF[round] != null ? BACKOFF[round] : 20000;
      const soon = gate.soonestReset(list);
      const wait = Number.isFinite(envDelay) && process.env.HELIO_BACKOFF_MS !== ''
        ? envDelay
        : Math.min(Math.max(base, soon, (lastErr && lastErr.retryAfterMs) || 0), 45000);
      const code = Number((lastErr && lastErr.status) || (/^\s*LLM\s+(\d{3})\b/.exec(String((lastErr && lastErr.message) || '')) || [])[1] || 0);
      const why = code && code !== 429 ? `provider error ${code}` : 'rate limited';
      const line = `${why} — waiting ${Math.round(wait / 1000)}s before retrying`;
      emit({ type: 'thinking', text: (waits++ === 0 ? '' : '\n') + line });
      await sleep(wait, signal);
    }
  }
  const gaveUp = new Error(`${humanizeLLMError(lastErr)} (gave up after ${MAX_ROUNDS} attempts)`);
  gaveUp.status = lastErr && lastErr.status;
  throw gaveUp;
}

// Parse tool_calls arguments (JSON string) safely. Providers differ: some
// double-encode the arguments (a JSON string literal containing JSON), some
// send an object, some send a whole object under a wrapper key, and some emit
// "[object Object]" after a bad string concat. Every one of those used to
// surface as `{ _raw: ... }`, which made Write/Edit fail and sent the model
// thrashing into bash heredocs. Recover what we can here.
function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  const s = String(raw).trim();
  if (!s) return {};
  const tryParse = (x) => { try { return JSON.parse(x); } catch { return undefined; } };
  const normalize = (v) => {
    // Unwrap common one-key envelopes: {"arguments": {...}} / {"input": {...}}.
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && /^(arguments|input|parameters|args|function)$/i.test(keys[0])) {
        const inner = v[keys[0]];
        if (inner && typeof inner === 'object') return inner;
        if (typeof inner === 'string') return tryParse(inner) || v;
      }
      if (keys.length === 1 && /^function$/i.test(keys[0]) && v.function && typeof v.function.arguments === 'string') {
        return tryParse(v.function.arguments) || v;
      }
    }
    return v;
  };
  let v = tryParse(s);
  // Double-encoded: a JSON string whose decoded value is more JSON.
  if (typeof v === 'string') {
    const inner = tryParse(v);
    if (inner !== undefined) v = inner;
  }
  // Trailing prose after the object: grab the outermost {...} and retry.
  if (v === undefined && s.startsWith('{')) {
    const end = s.lastIndexOf('}');
    if (end > 0) v = tryParse(s.slice(0, end + 1));
  }
  // A bare "[object Object]" is unrecoverable — say so clearly.
  if (/^\[object \w+\]$/.test(s) || (typeof v === 'string' && /^\[object \w+\]$/.test(v))) {
    return { _raw: raw, _parse_error: 'arguments arrived as "[object Object]" (provider serialized them as an object instead of JSON text)' };
  }
  if (v !== undefined && v !== null && typeof v === 'object') {
    const n = normalize(v);
    if (n !== v) return n;
    if (Array.isArray(n)) return { _raw: raw, _parse_error: 'arguments were a JSON array, not an object' };
    return n;
  }
  // Last resort: strip one stray outer quote layer, then parse.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    const v3 = tryParse(s.replace(/^"(.*)"$/s, '$1'));
    if (v3 !== undefined) return v3;
  }
  return { _raw: raw, _parse_error: 'arguments were not valid JSON' };
}

// Did the model's JSON get sliced by the output limit? A `Write`/`Edit` call cut
// mid-string parses as nothing at all, and running it with `{}` produced an empty
// "error" card while the file never appeared — the "coding with any AI is broken"
// symptom. Empty arguments stay legal (tools with no parameters).
function isCutJSON(raw) {
  if (raw == null) return false;
  if (typeof raw === 'object') return false;
  const s = String(raw).trim();
  if (!s) return false;
  try { JSON.parse(s); return false; } catch { return true; }
}

function hasCutCalls(list) {
  return (list || []).some((tc) => isCutJSON(tc && tc.function && tc.function.arguments));
}

// If a coding turn ends with the code only pasted in chat (no Write/Edit and no
// Artifact call), the user sees text and no website — the exact "it doesn't
// build anything" complaint. Capture the largest runnable fenced block, write
// it into the project, and emit a live-preview Artifact so the deliverable
// always exists on disk.
function autoCaptureArtifacts(content, cwd, emit) {
  if (!content || typeof content !== 'string') return [];
  const fence = /```([a-zA-Z0-9+#.-]*)[ \t]*\r?\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = fence.exec(content))) {
    const lang = (m[1] || '').toLowerCase();
    const body = m[2] || '';
    const isHtml = lang === 'html' || lang === 'htm' || /<!doctype html|<html[\s>]/i.test(body);
    const isSvg = lang === 'svg' || /^<svg[\s>]/i.test(body.trim());
    const isJsx = /^(jsx|tsx|react)$/.test(lang);
    const isCss = lang === 'css';
    if ((isHtml || isSvg || isJsx || isCss) && body.trim().length > 400) {
      blocks.push({ lang: isHtml ? 'html' : isSvg ? 'svg' : isJsx ? 'jsx' : 'css', body });
    }
  }
  if (!blocks.length) return [];
  blocks.sort((a, b) => b.body.length - a.body.length);
  const created = [];
  const dir = cwd || process.cwd();
  for (const b of blocks.slice(0, 4)) {
    const base = b.lang === 'html' ? 'index.html' : b.lang === 'svg' ? 'artifact.svg' : b.lang === 'css' ? 'styles.css' : 'App.jsx';
    let name = base;
    let n = 2;
    while (fs.existsSync(path.join(dir, name))) { name = base.replace(/(\.[^.]+)$/, `-${n}$1`); n++; }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), b.body, 'utf8');
    } catch { continue; }
    const written = path.join(dir, name);
    emit({ type: 'artifact', name, language: b.lang, content: b.body, path: written });
    emit({ type: 'toolResult', id: 'auto_' + name, name: 'Write', result: `Auto-saved ${name} (${b.body.length} chars) from your reply so it renders live.` });
    created.push(name);
  }
  return created;
}

/**
 * Make a conversation history portable across models.
 *
 * History is stored in whatever shape the *previous* model produced. When the
 * user switches model mid-conversation (gemma4 → Kimi → DeepSeek → Nemotron →
 * TokenRouter), the new endpoint can reject what the old one emitted:
 *   - `role:"tool"` messages are only legal right after an assistant message that
 *     carries a matching `tool_calls` entry (and a `tool_call_id`); text-only
 *     endpoints reject the role outright.
 *   - `content: null` breaks several gateways.
 *   - providers that streamed arguments as an object left non-JSON strings behind.
 *   - a long conversation can exceed a smaller model's context window.
 * This normalizes all of that so any model can continue the same conversation.
 */
/**
 * Split text into chunks of at most `max` characters, preferring paragraph,
 * then line, then word boundaries — so an oversized prompt can be processed in
 * order instead of being amputated. Never returns an empty chunk.
 */
function chunkText(text, max) {
  const s = String(text == null ? '' : text);
  const limit = Math.max(2000, Math.round(Number(max) || 2000));
  if (s.length <= limit) return s ? [s] : [''];
  const parts = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit * 0.25) cut = limit;
    parts.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) parts.push(rest);
  return parts.length ? parts : [s];
}

function sanitizeHistory(messages, opts = {}) {
  const supportsTools = opts.supportsTools !== false;
  const maxChars = opts.maxChars || 220000; // ≈ 55k tokens of history
  const str = (c) => {
    if (c == null) return '';
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map((p) => (p && typeof p === 'object' ? (p.text || (p.type === 'image_url' ? '[image]' : '')) : String(p))).join('\n');
    }
    try { return JSON.stringify(c); } catch { return String(c); }
  };
  const loose = (a) => {
    if (a == null || a === '') return {};
    if (typeof a === 'object') return a;
    if (typeof a === 'string') { try { return JSON.parse(a); } catch { return {}; } }
    return {};
  };
  const truncate = (s, n) => (s.length > n ? s.slice(0, n) + ' …[truncated]' : s);

  const out = [];
  let lastAssistantCalls = null; // ids the next tool messages must answer
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system') {
      if (out.length === 0) out.push({ role: 'system', content: str(m.content) });
      else out.push({ role: 'user', content: '[Context]\n' + str(m.content) });
      continue;
    }
    if (role === 'tool' || role === 'function') {
      const content = truncate(str(m.content), 8000);
      const name = m.name || (m.function && m.function.name) || 'tool';
      if (supportsTools && m.tool_call_id && lastAssistantCalls && lastAssistantCalls.has(m.tool_call_id)) {
        out.push({ role: 'tool', tool_call_id: m.tool_call_id, name, content });
        lastAssistantCalls.delete(m.tool_call_id);
      } else {
        // Text-only endpoint (or orphan result) → hand it over as plain context.
        out.push({ role: 'user', content: `TOOL RESULT${name ? ' (' + name + ')' : ''}:\n${content}` });
      }
      continue;
    }
    if (role === 'assistant') {
      let content = str(m.content);
      const tcs = Array.isArray(m.tool_calls)
        ? m.tool_calls.filter((tc) => {
          const n = tc && ((tc.function && tc.function.name) || tc.name);
          return !!n;
        })
        : [];
      if (!tcs.length) { out.push({ role: 'assistant', content }); lastAssistantCalls = null; continue; }
      if (supportsTools) {
        let seq = 0;
        const norm = tcs.map((tc) => {
          const fn = tc.function || {};
          const name = fn.name || tc.name || 'tool';
          const args = loose(fn.arguments != null ? fn.arguments : tc.arguments);
          seq++;
          return {
            id: tc.id || `call_${Date.now().toString(36)}_${seq}`,
            type: 'function',
            function: { name, arguments: JSON.stringify(args || {}) },
          };
        });
        out.push({ role: 'assistant', content, tool_calls: norm });
        lastAssistantCalls = new Set(norm.map((t) => t.id));
      } else {
        // Flatten native tool calls into the text protocol so a non-tool model
        // can still see what happened (and reply in the same protocol).
        const blocks = tcs.map((tc) => {
          const fn = tc.function || {};
          const name = fn.name || tc.name || 'tool';
          const args = loose(fn.arguments != null ? fn.arguments : tc.arguments);
          return '```tool\n' + JSON.stringify({ name, arguments: args }) + '\n```';
        }).join('\n');
        content = content ? content + '\n\n' + blocks : blocks;
        out.push({ role: 'assistant', content });
        lastAssistantCalls = null;
      }
      continue;
    }
    // user (or anything unknown): preserve multimodal content arrays (image_url / image) intact.
    if (Array.isArray(m.content)) {
      const parts = m.content.filter((p) => p && typeof p === 'object' && (p.type === 'text' || p.type === 'image_url' || p.type === 'image' || typeof p.text === 'string'));
      out.push({ role: 'user', content: parts.length ? parts : str(m.content) });
    } else {
      out.push({ role: 'user', content: str(m.content) });
    }
    lastAssistantCalls = null;
  }

  // Keep the system prompt + the opening user turn, drop the oldest middle
  // messages until the history fits the budget.
  const size = () => out.reduce((n, m) => n + str(m.content).length + 64, 0);
  let total = size();
  if (total > maxChars) {
    let i = 1; // never drop the system prompt
    // keep the first real user turn for task framing
    while (i < out.length && out[i].role !== 'user') i++;
    let dropFrom = i + 1;
    const dropped = [];
    while (total > maxChars && dropFrom < out.length - 2) {
      dropped.push(out[dropFrom]);
      total -= str(out[dropFrom].content).length + 64;
      out.splice(dropFrom, 1);
      // also remove a dangling tool result whose assistant call was dropped
      while (out[dropFrom] && out[dropFrom].role === 'tool') {
        dropped.push(out[dropFrom]);
        total -= str(out[dropFrom].content).length + 64;
        out.splice(dropFrom, 1);
      }
    }
    // A single huge message (a pasted document, a giant diff) cannot be
    // "dropped": the newest turn IS the request, and dropping it would leave the
    // model answering nothing. Trimmed below, after the digest note is inserted,
    // so the note itself counts against the budget.
    let truncatedChars = 0;
    // Example compacts instead of just amputating: give the model a digest of
    // what left the window so it can keep working on the same task.
    const asks = [];
    const notes = [];
    const toolsSeen = new Set();
    for (const m of dropped) {
      const flat = str(m.content).replace(/\s+/g, ' ').trim();
      if (m.role === 'user' && flat && !/^TOOL RESULT/i.test(flat)) asks.push(flat.slice(0, 160));
      else if (m.role === 'assistant' && flat) notes.push(flat.slice(0, 140));
      else if (m.role === 'tool' && m.name) toolsSeen.add(m.name);
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const n = (tc && tc.function && tc.function.name) || (tc && tc.name);
          if (n) toolsSeen.add(n);
        }
      }
    }
    const digest = [
      asks.length ? 'Requests: ' + [...new Set(asks)].slice(-8).map((a) => `"${a}"`).join(' · ') : '',
      notes.length ? 'Progress: ' + notes.slice(-6).join(' · ') : '',
      toolsSeen.size ? 'Tools used: ' + [...toolsSeen].slice(0, 24).join(', ') : '',
    ].filter(Boolean).join('\n');
    const note = `[Compacted ${dropped.length} earlier turns to fit this model's context window. The full transcript stays in this chat, and the project mindmap above has the current file state.${digest ? '\n' + digest : ''}\n]`;
    // Only announce a compaction when something actually left the window. With
    // a single oversized message the loop above drops nothing; saying
    // "Compacted 0 earlier turns" was user-visible nonsense.
    if (dropped.length) out.splice(i + 1, 0, { role: 'user', content: note });

    // Now trim the middle of whatever is still too big. This is what makes a
    // single oversized paste work: the newest message IS the request, so it can
    // never be dropped — but its head and tail (where the instruction lives)
    // fit. Without this the over-budget bytes were re-sent on every retry and
    // the turn looked permanently stuck on "token limit reached".
    total = size();
    if (total > maxChars) {
      const trimOrder = out
        .map((m) => m)
        .filter((m) => m.role !== 'system' && typeof m.content === 'string')
        .sort((a, b) => str(b.content).length - str(a.content).length);
      for (const m of trimOrder) {
        if (total <= maxChars) break;
        const content = str(m.content);
        const over = total - maxChars;
        const keep = Math.max(1600, content.length - over - 300);
        if (keep >= content.length) continue;
        const headLen = Math.max(500, Math.round(keep * 0.35));
        const tailLen = Math.max(700, keep - headLen);
        const cut = content.length - (headLen + tailLen);
        if (cut <= 0) continue;
        const marker = `\n\n…[${cut} characters from the middle of this message were omitted to fit this model's context window; the beginning and the end — including your latest request — are kept]…\n\n`;
        m.content = content.slice(0, headLen) + marker + content.slice(content.length - tailLen);
        truncatedChars += content.length - str(m.content).length;
        total = size();
      }
    }

    if ((dropped.length || truncatedChars) && typeof opts.onCompact === 'function') {
      try { opts.onCompact({ dropped: dropped.length, truncated: truncatedChars, digest }); } catch (_) {}
    }
  }
  return out;
}

/**
 * Run the agent loop.
 * @param {object} opts { provider, messages, cwd, emit, signal, maxSteps, extraTools }
 * messages: array of {role, content} (OpenAI format).
 * emit(evt): send events to renderer.
 * Returns final messages array.
 */
async function runAgent(opts) {
  const emit = opts.emit || (() => {});
  // Preserve every field (tool_calls, tool_call_id, name) — flattening to
  // role+content silently destroyed the tool transcript of the previous model,
  // which is exactly what a model switch needs to see.
  let messages = (opts.messages || []).map((m) => ({ ...m }));
  // Example's agent loop has no step budget: it keeps calling tools until the
  // model stops asking for them. A fixed `40` (and 10/12 for sub-agents) meant
  // long build tasks were cut off mid-work with no explanation. Default to
  // unbounded; HARD_STEP_CAP is only a runaway guard, and when it trips the
  // renderer is told explicitly (`limit`) instead of the run just ending.
  const HARD_STEP_CAP = Number(opts.hardStepCap) || 1000;
  const maxSteps = Number(opts.maxSteps) > 0 ? Number(opts.maxSteps) : HARD_STEP_CAP;
  let currentCwd = opts.cwd || process.cwd();

  // ── Lifecycle hooks (Claude Code parity) ────────────────────────────────
  // The same ten events Claude Code fires, read from ~/.claude/settings.json,
  // <cwd>/.claude/settings.json and ~/.autobot/hooks.json. A hook that crashes
  // or times out degrades to "no verdict" — it can never kill the run.
  let hookConfig = null;
  const getHookConfig = () => {
    if (!hookConfig) {
      try { hookConfig = hooks.loadHookConfig(currentCwd); } catch (_) { hookConfig = {}; }
    }
    return hookConfig;
  };
  const runHook = async (event, payload = {}) => {
    try {
      if (!(getHookConfig()[event] || []).length) return null;
      return await hooks.runEvent(event, payload, {
        cwd: currentCwd,
        sessionId: opts.sessionId,
        emit,
        config: getHookConfig(),
        runPrompt: opts.hookPrompt,
      });
    } catch (_) {
      return null;
    }
  };

  // Orchestrator: build the provider failover list. When enabled, iterate over
  // the user-selected providers; otherwise use the single active provider.
  const orch = opts.orchestrator || null;
  let providerList = [normalizeProvider(opts.provider)];
  let activeIndex = 0;
  if (orch && orch.enabled && Array.isArray(orch.providers) && orch.providers.length) {
    // Preserve native-transport fields too: an orchestrator pool may mix
    // gateways with subscription accounts, and dropping `transport`/tokens here
    // would silently send a subscription model down the OpenAI-compatible path.
    const rows = orch.providers.filter((p) => p && p.enabled !== false);
    providerList = (rows.length ? rows : orch.providers).map((p) => normalizeProvider({
      maxConcurrent: p.maxConcurrent, role: p.role, gateKey: p.gateKey, supportsTools: p.supportsTools,
      baseURL: p.baseURL, apiKey: p.apiKey, model: p.model,
      temperature: p.temperature, maxTokens: p.maxTokens, reasoningLevel: p.reasoningLevel,
      transport: p.transport, oauth: p.oauth, accessToken: p.accessToken,
      account: p.account, accountId: p.accountId, sessionId: p.sessionId,
      codexUrl: p.codexUrl, cloudcodeUrl: p.cloudcodeUrl, project: p.project,
      oauthProvider: p.oauthProvider,
      // A ticked subscription row already knows the window the picker showed;
      // carry it so budgetForModel/auto-compact use it instead of re-guessing.
      contextWindow: p.contextWindow,
    }));
    activeIndex = Math.max(0, Math.min(Number(orch.activeIndex) || 0, providerList.length - 1));
  }
  // Role pools (FreeLLMAPI layout). When the session provider is the pool
  // gateway, the failover chain for this turn comes from the job's pool: the
  // selected model's own pool (or Coder), Vision when the turn carries images,
  // or the role a caller asked for. A role-scoped orchestrator (sub-agents,
  // swarm workers) already IS a pool and is used as-is.
  let poolMode = false;
  if (orch && !orch.role && router.poolsActive(orch, opts.provider)) {
    const role = opts.role || (router.hasImages(opts.messages) ? 'vision' : null);
    const chain = router.chainFor(orch, opts.provider, role);
    if (chain.length) {
      providerList = chain.map((p) => normalizeProvider(p));
      activeIndex = 0;
      poolMode = true;
      if (role === 'vision' && opts.turnStart) emit({ type: 'notice', text: 'This message has images, so it runs on the Vision pool (' + chain.map((p) => p.model).join(' → ') + ').' });
    }
  } else if (orch && orch.role && orch.pools) {
    poolMode = true;
  }
  // Long context: when the history is bigger than the head row's window and a
  // Long-context pool exists, move the turn there instead of amputating it.
  if (poolMode && orch && router.poolsConfig(orch)) {
    try {
      const head = providerList[activeIndex];
      const pidH = String(head.oauthProvider || '').split(':')[0] || head.transport || '';
      const winH = modelCatalog.contextWindowFor(head.model, pidH, head.contextWindow);
      const chars = (opts.messages || []).reduce((n, m) => n + (typeof (m && m.content) === 'string' ? m.content.length : JSON.stringify((m && m.content) || '').length), 0);
      const cap = modelCatalog.budgetFor(winH).maxChars;
      if (cap && chars > cap * 0.85 && head.role !== 'longctx') {
        const lc = router.resolve(orch, 'longctx', head).filter((r) => r.role === 'longctx');
        if (lc.length) {
          providerList = lc.map((p) => normalizeProvider(p));
          activeIndex = 0;
          emit({ type: 'notice', text: `This conversation is larger than ${head.model}'s context window, so it moved to the Long-context pool (${lc.map((p) => p.model).join(' → ')}).` });
        }
      }
    } catch (_) { /* routing hint only */ }
  }
  const homeIndex = activeIndex;
  const getIndex = () => activeIndex % providerList.length;
  const setIndex = (i) => { activeIndex = i % providerList.length; };
  const provider = providerList[getIndex()];
  const depth = Number(opts.depth) || 0;

  // ── Oversized single input → sequential chunks ──────────────────────────
  // sanitizeHistory only drops *earlier* turns, so one pasted document larger
  // than the window used to be amputated: the model never saw most of the prompt
  // and the turn looked stuck. Split it, run the parts in order, merge the
  // answers — the turn always completes instead of stalling on a 400.
  if (opts._chunked !== true) {
    const pid = String(provider.oauthProvider || '').split(':')[0] || provider.transport || '';
    const win = modelCatalog.contextWindowFor(provider.model, pid, provider.contextWindow);
    const per = Math.max(8000, Math.round(modelCatalog.budgetFor(win).maxChars * 0.6));
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i] && messages[i].role === 'user') { lastUserIdx = i; break; }
    const body = lastUserIdx >= 0 && typeof messages[lastUserIdx].content === 'string' ? messages[lastUserIdx].content : '';
    if (body.length > per * 2) {
      // Never make an absurd number of round-trips: widen the slices instead.
      const size = Math.max(per, Math.ceil(body.length / 40));
      const parts = chunkText(body, size);
      const total = parts.length;
      emit({ type: 'notice', text: `Your message is larger than ${provider.model}'s context window, so it is being handled in ${total} parts.` });
      const prefix = messages.slice(0, lastUserIdx).filter((m) => m.role !== 'system').map((m) => ({ ...m }));
      // Sub-runs stream deltas/thinking/usage but must NOT emit `done` — the
      // renderer would close the turn after part 1.
      const usageSum = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, model: provider.model };
      const partEmit = (ev) => {
        if (!ev) return;
        if (ev.type === 'done') {
          const u = ev.usage || {};
          for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'calls']) usageSum[k] += Number(u[k]) || 0;
          return;
        }
        if (ev.type === 'limit') return;
        emit(ev);
      };
      let merged = '';
      for (let k = 0; k < total; k++) {
        if (opts.signal && opts.signal.aborted) throw new Error('aborted');
        if (k > 0) emit({ type: 'delta', text: `\n\n— part ${k + 1}/${total} —\n\n` });
        const subMessages = prefix.map((m) => ({ ...m }));
        if (merged.trim()) subMessages.push({ role: 'assistant', content: merged });
        subMessages.push({
          role: 'user',
          content: `[Part ${k + 1}/${total} of one long message]\n${parts[k]}\n\n[Work through only this part now. Keep any artifact/file work going; a later part will finish the job.]`,
        });
        const partMsgs = await runAgent({ ...opts, messages: subMessages, _chunked: true, turnStart: false, emit: partEmit });
        const last = [...partMsgs].reverse().find((m) => m.role === 'assistant');
        const text = last && typeof last.content === 'string' ? last.content : '';
        if (text.trim()) merged = merged ? `${merged}\n\n${text}` : text;
      }
      const out = prefix.concat([
        { role: 'user', content: body },
        { role: 'assistant', content: merged },
      ]);
      emit({ type: 'done', messages: out, usage: usageSum });
      return out;
    }
  }

  // Merge built-in tools + MCP tools (if any) + custom extraTools. A sub-agent
  // definition can restrict the tool surface (`tools:` frontmatter), which is
  // Example's read-only Explore / tool-scoped agent contract.
  const toolAllow = opts.toolAllow instanceof Set ? opts.toolAllow : null;
  // Host-local tools (e.g. the swarm board's swarm_post_message / read_board /
  // swarm_wait). They live in the caller's memory, not in tools.js, so the
  // executor dispatches them directly. They are always advertised unless the
  // sub-agent definition explicitly allowlists a different surface.
  const localTools = (opts.localTools && typeof opts.localTools === 'object') ? opts.localTools : null;
  const isLocal = (name) => !!(localTools && typeof localTools[name] === 'function');
  const isAllowed = (name) => {
    if (isLocal(name)) return true;
    // Swarm is an explicit user opt-in. When it is off, the tool is never
    // advertised to the model (multi-agent Task/Agent remains available).
    if (name === 'Swarm' && opts.swarm !== true) return false;
    // Delegation depth guard: a sub-agent at the limit does the work itself.
    if ((name === 'Task' || name === 'Agent' || name === 'Swarm') && depth >= MAX_AGENT_DEPTH) return false;
    if (!toolAllow) return true;
    if (toolAllow.has(name) || toolAllow.has('*')) return true;
    if (name.startsWith('mcp__') && (toolAllow.has('mcp') || toolAllow.has('mcp__*'))) return true;
    return false;
  };
  let tools = toolDefinitions.filter((t) => isAllowed(t.name)).map((t) => ({ type: 'function', function: t }));
  const allAllowedDefs = new Map();
  for (const t of tools) allAllowedDefs.set(t.function.name, t.function);
  let extraToolsDeferred = false;
  const extra = opts.extraTools || [];
  for (const t of extra) {
    if (t && t.name && isAllowed(t.name)) {
      allAllowedDefs.set(t.name, { name: t.name, description: t.description, parameters: t.inputSchema || t.parameters });
    }
  }
  // MCP servers publish verbose schemas; a big one (REA: 263 tools, ≈384 kB of
  // JSON) would cost ≈113 k prompt tokens on every step. Compact the schemas,
  // and when even the compacted surface is still too fat, defer it behind a
  // single search tool. Nothing stops being callable either way — dispatch is
  // by name — only the advertised text shrinks.
  const mcpSurface = mcpSchema.buildSurface(extra, { budget: opts.mcpToolBudget });
  if (mcpSurface.mode === 'deferred') {
    const servers = [...new Set(extra.map((t) => (String(t.name).split('__')[1] || '')))].filter(Boolean);
    // A tool-scoped sub-agent that never asked for MCP keeps its surface clean.
    const allowIndex = !toolAllow || toolAllow.has('*') || toolAllow.has('mcp') || toolAllow.has('mcp__*') || toolAllow.has('find_mcp_tools');
    if (allowIndex) {
      tools.push({
        type: 'function',
        function: {
          // NOTE: must NOT start with `mcp_` + letter. Anthropic's subscription
          // (OAuth) endpoint rejects such a name with a misleading
          // "Third-party apps now draw from your extra usage…" 400 — measured:
          // `mcp_find_tools` → 400, `find_mcp_tools`/`mcp__srv__tool` → 200.
          name: 'find_mcp_tools',
          description:
            `Search the ${extra.length} tools published by connected MCP servers (${servers.join(', ')}). `
            + 'Their schemas are deferred to keep the prompt small. Call this with a keyword, then call the '
            + 'returned tool by its exact mcp__<server>__<tool> name.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Keywords, e.g. "android jni", "browser capture", "decompile"' },
              server: { type: 'string', description: 'Optional MCP server id to restrict the search' },
            },
            required: ['query'],
          },
        },
      });
      extraToolsDeferred = true;
    }
  } else {
    for (const t of mcpSurface.tools) {
      if (!isAllowed(t.name)) continue;
      tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } });
    }
  }

  // ── Provider tool cap ────────────────────────────────────────────────────
  // Some OpenAI-compatible endpoints hard-cap how many tools may be advertised
  // in one request. Groq answers 141 tools with the 400 `'tools' : maximum
  // number of items is 128` and the whole turn dies before the model ever sees
  // the prompt (measured through the FreeLLMAPI gateway: gpt-oss-120b refuses
  // at 141, accepts at 128). Dispatch here is by NAME, and `tool_search`
  // indexes the full definition list, so a tool we stop advertising is still
  // discoverable and still callable — only the request shrinks.
  const cap = toolCapFor(provider);
  if (cap) tools = trimToolsTo(tools, cap).tools;

  // Tool profiles. 141 schemas are ~15k prompt tokens on EVERY request — more
  // than a whole minute of a free tier's token budget (Groq TPM), so a free
  // gateway rate-limits the first call of every worker. Like Claude Code's
  // deferred tools, advertise a focused surface and keep the rest callable by
  // name / discoverable through ToolSearch:
  //   lean     — workers & sub-agents on a pool: the coding core (~2k tokens)
  //   standard — the main agent on a pool: core + team/plan tools
  //   full     — everything (subscription providers, explicit opt-in)
  const isLocalOllama = /:11434\b|ollama/i.test(String((provider && provider.baseURL) || ''));
  const profile = opts.toolProfile || ((poolMode || isLocalOllama) ? (depth >= 1 ? 'lean' : 'standard') : 'full');
  if (profile === 'lean' || profile === 'standard') {
    const keep = profile === 'lean' ? LEAN_TOOLS : STANDARD_TOOLS;
    tools = tools.filter((t) => {
      const nm = t.function && t.function.name;
      return keep.has(nm) || isLocal(nm) || (toolAllow && toolAllow.has(nm));
    });
  }

  // Always ensure the core system prompt is the first message. The renderer may
  // send its own system message (style / project / web-search directives); that
  // stays as a second system message, but the core Akron Code guidance (tool use,
  // browser, artifact/visualization instructions) must be present for EVERY
  // model — Gemini/Gemma via Ollama, Kimi, DeepSeek, Nemotron, etc.
  const corePrompt = messages.find((m) => m.role === 'system' && typeof m.content === 'string' && m.content.startsWith('You are Akron Code,'));
  if (!corePrompt) {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  } else {
    // Move existing core prompt to index 0 and strip previously appended dynamic suffixes
    // (subagent_types, project_workspace, etc.) so multi-turn re-entry never duplicates blocks.
    if (messages[0] !== corePrompt) {
      const i = messages.indexOf(corePrompt);
      messages.splice(i, 1);
      messages.unshift(corePrompt);
    }
    messages[0] = { role: 'system', content: SYSTEM_PROMPT };
  }

  // Collect extra system directives sent by the renderer and splice them out so
  // everything is merged into messages[0] in strict static → semi-static → dynamic
  // order for KV prefix-cache stability (DeepSeek / Anthropic / OpenAI).
  const foldedDirectives = [];
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === 'system') {
      const extra = String(messages[i].content || '').trim();
      if (extra) foldedDirectives.unshift(extra);
      messages.splice(i, 1);
    }
  }

  // 1. Static per repo: CLAUDE.md project memory hierarchy (global → ancestors → cwd → local).
  try {
    const memory = require('./memory');
    const memText = memory.loadMemoryText(currentCwd);
    if (memText) messages[0].content += `\n\n<project_memory>\n${memText}\n</project_memory>`;
  } catch (_) {}

  // 2. Static per config: custom output style (~/.claude/output-styles/<name>.md).
  try {
    const cc = require('./claudeconfig');
    const { settings } = cc.loadSettings(currentCwd);
    const styleName = settings && (settings.outputStyle || settings.output_style);
    if (styleName && String(styleName).toLowerCase() !== 'default') {
      const dirs = [path.join(cc.CONFIG_DIR, 'output-styles')];
      if (currentCwd) dirs.push(path.join(currentCwd, '.claude', 'output-styles'));
      dirs.push(path.join(cc.AUTOBOT_DIR, 'output-styles'));
      let found = null;
      for (const d of dirs) {
        const f = path.join(d, `${styleName}.md`);
        const txt = cc.readText(f);
        if (txt != null) { found = txt; break; }
      }
      if (found) {
        const { body } = cc.parseFrontmatter(found);
        if (body && body.trim()) messages[0].content += `\n\n<output_style name="${styleName}">\n${body.trim()}\n</output_style>`;
      }
    }
  } catch (_) {}

  // 3. Semi-static: sub-agent definitions the model can dispatch to via `subagent_type`.
  try {
    const agentdefs = require('./agentdefs');
    const defs = agentdefs.discover(currentCwd, { fresh: true });
    if (defs.length) {
      const roster = defs.map((d) => `- ${d.name}${d.model ? ` (model: ${d.model})` : ''}: ${d.description}`).join('\n');
      messages[0].content += `\n\n<subagent_types>\nWhen calling Task or Agent you may set subagent_type to one of these to run it with that definition (prompt + tool restrictions + model):\n${roster}\n</subagent_types>`;
    }
  } catch (_) {}

  // 4. Semi-static per session cwd: project working directory.
  if (currentCwd) {
    messages[0].content += `\n\n<project_workspace>\nYour project working directory is: ${currentCwd}\nCreate and edit files in this folder by default (prefer relative paths). Run shell commands in this folder unless the user specifies another location. When the user asks for code or a file, write it here.\n</project_workspace>`;
  }

  if (opts.swarm === true && depth === 0 && allAllowedDefs.has('Swarm')) {
    messages[0].content += `\n\n<swarm_mode_active>\nSwarm mode is ON. For any non-trivial build, multi-file implementation, audit, or research task with 2 or more independent workstreams, call \`Swarm\` {"goal": "..."} (optionally passing "tasks") or spawn parallel \`Task\` workers right away after at most ONE quick directory check rather than doing every file sequentially yourself.\n</swarm_mode_active>`;
  }

  // 5. Per-turn renderer directives (style / web-search / context notes).
  for (const dirText of foldedDirectives) {
    messages[0].content += '\n\n' + dirText;
  }

  // 6. Semi-dynamic: user long-term memory.
  const { memoryAsText } = require('./store');
  if (opts.useMemory !== false) {
    const mem = memoryAsText();
    if (mem !== '(no saved memory)') {
      messages[0].content += `\n\n<long_term_memory>\n${mem}\n</long_term_memory>`;
    }
  }

  // 7. Dynamic (changes on every turn/edit): per-project mindmap at the very tail
  // so model switches retain continuity while preserving the static prefix cache.
  try {
    const { read: readMindmap } = require('./mindmap');
    const mm = readMindmap(currentCwd);
    if (mm) messages[0].content += `\n\n<project_mindmap>\n${mm}\n</project_mindmap>`;
  } catch (_) {}

  // SessionStart + UserPromptSubmit. Claude Code fires both before the model
  // ever sees the prompt, and both may inject context (or, for the prompt
  // one, veto the turn outright).
  {
    const v = await runHook('SessionStart', { source: opts.continuation ? 'resume' : 'startup' });
    if (v) {
      if (v.additionalContext) messages[0].content += `\n\n<hook_context>\n${v.additionalContext}\n</hook_context>`;
      for (const m of v.systemMessages || []) emit({ type: 'notice', text: m });
    }
  }
  {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const promptText = typeof (lastUser && lastUser.content) === 'string' ? lastUser.content : '';
    const v = await runHook('UserPromptSubmit', { prompt: promptText, user_prompt: promptText });
    if (v) {
      if (v.blocked || v.stop) {
        const why = v.reason || 'Blocked by UserPromptSubmit hook';
        emit({ type: 'notice', text: `Prompt blocked: ${why}` });
        emit({ type: 'done', messages, blocked: true });
        return messages;
      }
      if (v.additionalContext) messages[0].content += `\n\n<hook_context>\n${v.additionalContext}\n</hook_context>`;
      for (const m of v.systemMessages || []) emit({ type: 'notice', text: m });
    }
  }

  // ── Token budget pool (Example's workflow `budget` global) ────────────────
  // A top-level turn (the main IPC handler sets `turnStart`) owns the pool: it
  // resets the counter and reads a "+500k"/"+1.5m" directive out of the user's
  // message. Sub-agents and workflow agents inherit the SAME pool, so the target
  // really is a ceiling for everything this turn spends — exactly Example's
  // contract. Sub-runs never reset it (they would erase the parent's spend).
  if (opts.turnStart) {
    budgetPool.reset();
    const firstUser = messages.find((m) => m.role === 'user');
    const budgetText = typeof (firstUser && firstUser.content) === 'string' ? firstUser.content : '';
    const target = budgetPool.applyDirective(budgetText);
    if (target != null) emit({ type: 'notice', text: `Token budget for this turn: ${target.toLocaleString()} output tokens.` });
  }

  let toolMode = provider.supportsTools;
  // Text-protocol fallback lets endpoints without function calling (many free
  // LLMs) still call every tool, including the built-in browser.
  let textToolMode = !provider.supportsTools;
  // Normalize the carried-over history for THIS provider so a mid-conversation
  // model switch never 400s on the previous model's message shapes.
  // Example compacts the conversation when it outgrows the model window and says
  // so. The window is resolved per model (live catalog → explicit → documented
  // rule) instead of one hardcoded character count, so a 1M-token Gemini model
  // is not amputated at 55k tokens while a small model still fits.
  const providerId = String(provider.oauthProvider || '').split(':')[0] || provider.transport || '';
  const modelBudget = modelCatalog.budgetForModel(provider.model, providerId, provider.contextWindow);
  // The character budget actually enforced this turn. It starts at the model's
  // own window-derived figure and shrinks on demand: a provider can still reject
  // the prompt as too long (tokeniser drift, tool schemas, image parts), and
  // re-sending the identical history only stalls. Compacting and retrying keeps
  // the turn alive, exactly like the Claude app.
  let historyBudget = modelBudget.maxChars;
  messages = sanitizeHistory(messages, {
    supportsTools: toolMode,
    maxChars: historyBudget,
    onCompact: ({ dropped = 0, truncated = 0 } = {}) => {
      // PreCompact/PostCompact fire around the compaction itself. They run
      // fire-and-forget: compaction is synchronous and must not block on I/O.
      const payload = { trigger: 'auto', dropped };
      Promise.resolve()
        .then(() => hooks.runEvent('PreCompact', payload, { cwd: currentCwd, config: getHookConfig() }))
        .then((v) => {
          if (v && v.additionalContext) messages[0].content += `\n\n<hook_context>\n${v.additionalContext}\n</hook_context>`;
          return hooks.runEvent('PostCompact', payload, { cwd: currentCwd, config: getHookConfig() });
        })
        .catch(() => {});
      // Say what actually happened. "Compacted 0 earlier turns" was nonsense for
      // a single pasted document — there were no earlier turns to compact, so
      // the message itself was shortened while its head and tail were kept.
      const win = modelCatalog.fmtWindow(modelBudget.window);
      let text;
      if (dropped && truncated) {
        text = `Fitted this conversation to ${provider.model}'s ${win} context window: ${dropped} earlier turn${dropped === 1 ? '' : 's'} left the working set and one very long message was shortened in the middle. The full transcript stays in this chat.`;
      } else if (dropped) {
        text = `Compacted ${dropped} earlier turn${dropped === 1 ? '' : 's'} to fit ${provider.model}'s ${win} context window — the chat history and project files are unchanged.`;
      } else {
        text = `This message was longer than ${provider.model}'s ${win} context window, so its middle was trimmed — the beginning and your latest request were kept, and the full text stays in the chat.`;
      }
      emit({ type: 'notice', text });
    },
  });
  const knownToolNames = new Set([...allAllowedDefs.keys(), ...tools.map((t) => t.function.name)]);
  const activateTools = (names) => {
    if (!Array.isArray(names) || !names.length) return [];
    const added = [];
    const have = new Set(tools.map((t) => t.function && t.function.name).filter(Boolean));
    for (const nm of names) {
      const clean = String(nm || '').trim();
      if (!clean || have.has(clean) || !isAllowed(clean)) continue;
      if (cap && tools.length >= cap) break;
      let def = toolDefinitions.find((t) => t.name === clean) || allAllowedDefs.get(clean);
      if (!def && extra.length) {
        const ex = extra.find((t) => t.name === clean);
        if (ex) def = { name: ex.name, description: ex.description, parameters: ex.inputSchema || ex.parameters };
      }
      if (!def) continue;
      tools.push({ type: 'function', function: def });
      have.add(clean);
      knownToolNames.add(clean);
      allAllowedDefs.set(clean, def);
      added.push(clean);
    }
    return added;
  };
  if (textToolMode) messages[0].content += '\n\n' + TEXT_TOOL_PROTOCOL;

  // ── Live compaction helpers ──────────────────────────────────────────────
  // Compaction used to run once, before the first model call. A long tool loop
  // then grew the history past the window mid-turn and the provider 400'd. These
  // helpers let the loop re-compact on demand and, when dropping turns is not
  // enough, shrink the single biggest message so the prompt always fits.
  const msgChars = (m) => {
    const c = m && m.content;
    if (c == null) return 0;
    if (typeof c === 'string') return c.length;
    if (Array.isArray(c)) {
      return c.reduce((n, p) => {
        if (!p || typeof p !== 'object') return n + String(p || '').length;
        if (typeof p.text === 'string') return n + p.text.length;
        if (p.type === 'image_url' || p.type === 'image') return n + 1500;
        return n + 128;
      }, 0);
    }
    try { return JSON.stringify(c).length; } catch { return String(c).length; }
  };
  const historyChars = () => messages.reduce((n, m) => n + msgChars(m) + 64, 0);
  const compactTo = (target) => {
    const want = Math.max(24000, Math.round(target));
    if (want >= historyBudget) return { dropped: 0, freed: 0 };
    const beforeCount = messages.length;
    const beforeChars = historyChars();
    const compacted = sanitizeHistory(messages, { supportsTools: toolMode, maxChars: want });
    const dropped = Math.max(0, beforeCount - compacted.length);
    // sanitizeHistory returns a fresh array; keep the live reference so every
    // closure (doChat, tool loop) sees the compacted history.
    messages.length = 0;
    messages.push(...compacted);
    historyBudget = want;
    return { dropped, freed: Math.max(0, beforeChars - historyChars()) };
  };
  // Last resort: the history is already minimal, so the overflow is one huge turn
  // (a giant file read, a command dump, a pasted document). Halve it in place.
  const shrinkLargest = () => {
    let idx = -1;
    let biggest = 0;
    for (let i = 1; i < messages.length; i++) {
      const len = msgChars(messages[i]);
      if (len > biggest) { biggest = len; idx = i; }
    }
    if (idx < 0 || biggest < 2000) return false;
    const c = messages[idx].content;
    const flat = typeof c === 'string' ? c : (() => { try { return JSON.stringify(c); } catch { return String(c); } })();
    // Keep the head AND the tail: a user turn's instruction almost always sits at
    // the end of a long paste, so truncating only the tail silently deleted the
    // actual request and the model answered the wrong question.
    const headLen = Math.max(1000, Math.floor(flat.length * 0.4));
    const tailLen = Math.max(1000, Math.floor(flat.length * 0.4));
    const cut = flat.length - headLen - tailLen;
    if (cut <= 0) return false;
    messages[idx] = {
      ...messages[idx],
      content: flat.slice(0, headLen)
        + `\n…[${cut} characters omitted to fit the model context window — the beginning and the end are kept; ask again for the rest if you need it]…\n`
        + flat.slice(flat.length - tailLen),
    };
    return true;
  };

  // Anti-thrash state. Weak tool-callers often repeat the exact same failing
  // call (or retry a broken Write) until the step budget runs out. Track it and
  // steer them back on course instead of silently burning tokens.
  const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'mcp__workspace__write_file', 'mcp__workspace__edit_file', 'Artifact']);
  let wroteSomething = false;
  let lastPreview = null;
  let lastSig = '';
  let repeatCount = 0;
  let nudges = 0;
  // Plan mode: track whether the turn already ended on ExitPlanMode/AskUserQuestion
  // so a prose-only finish gets nudged back onto the contract.
  let planEnded = false;
  let planNudges = 0;
  let hookNudges = 0;
  let subSpawnCount = 0;

  // Snapshot a file before a mutating tool touches it, so /rewind can restore
  // the working tree to any earlier turn. Best-effort: never blocks the tool.
  const checkpointTargets = (name, a) => {
    if (!a) return [];
    const out = [];
    const push = (p) => { if (p) out.push(String(p)); };
    if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
      push(a.file_path || a.path || a.notebook_path || a.filePath);
    } else if (name === 'mcp__workspace__write_file' || name === 'mcp__workspace__edit_file') {
      push(a.path || a.file_path);
    } else if (name === 'Artifact') {
      // Artifact writes a file derived from name+language; snapshot it too.
      const nm = a.name ? String(a.name) : 'artifact.txt';
      push(nm);
    }
    return out;
  };
  const takeCheckpoint = (name, a) => {
    if (!opts.convId) return;
    let ck;
    try { ck = require('./checkpoints'); } catch (_) { return; }
    for (const p of checkpointTargets(name, a)) {
      try {
        const abs = path.isAbsolute(p) ? p : path.resolve(currentCwd || process.cwd(), p);
        const rec = ck.snapshotFile(opts.convId, opts.turnId || 'turn', abs);
        if (rec) emit({ type: 'checkpoint', id: String(opts.turnId || 'turn'), path: abs, existed: !!rec.existed, at: Date.now() });
      } catch (_) {}
    }
  };

  // ── Plan mode ───────────────────────────────────────────────────────────
  // Example's plan mode is a phase machine, not a blanket "deny writes": the
  // agent explores read-only, designs, self-reviews, writes ONE plan file, then
  // ends the turn with ExitPlanMode. Only source mutations are refused, and the
  // refusal tells the model exactly what to do instead (a bare denial made the
  // agent retry the same Write until the turn died).
  const PLAN_FILE_REL = String(opts.planFile || 'PLAN.md');
  let permissionMode = String(opts.permissionMode || opts.permissions || 'auto');
  let planPrevMode = 'auto';
  const PLAN_SAFE = new Set([
    'Read', 'Glob', 'Grep', 'LS', 'Search', 'ListDir', 'ListFiles',
    'WebFetch', 'WebSearch', 'TodoWrite', 'AskUserQuestion', 'ExitPlanMode',
    'EnterPlanMode', 'Artifact', 'StructuredOutput', 'Monitor', 'TaskOutput',
    'TaskList', 'TaskGet', 'TeamCreate', 'SendMessage', 'ListAgents', 'Skill',
    'ListMcpResources', 'ReadMcpResource', 'Brief', 'SendUserFile',
    'PushNotification', 'CronList', 'NotebookRead', 'Task', 'Agent', 'Swarm',
  ]);
  const planAbsPath = () => path.resolve(currentCwd, PLAN_FILE_REL);
  const isPlanFileArg = (args) => {
    const p = args && (args.path || args.file_path || args.filePath || args.file);
    if (!p) return false;
    try { return path.resolve(currentCwd, String(p)) === planAbsPath(); } catch (_) { return false; }
  };
  // Returns null when the call is allowed, or a directive message when it is not.
  const planGate = (name, args) => {
    if (permissionMode !== 'plan') return null;
    if (name === 'Write' || name === 'Edit' || name === 'MultiEdit' || name === 'NotebookEdit') {
      if (isPlanFileArg(args)) return null;
      return `Plan mode: source files are read-only. Write the change you want into ${PLAN_FILE_REL} instead, then call ExitPlanMode {"plan": "..."} so the user can approve it before you touch source.`;
    }
    if (PLAN_SAFE.has(name) || /^browser_/.test(name)) return null;
    if (/^mcp__[^_]+__.*(read|list|get|search|fetch|query|describe)/i.test(name)) return null;
    return `Plan mode: "${name}" is unavailable until the user approves the plan. Keep researching with read-only tools, record the plan in ${PLAN_FILE_REL}, and finish the turn with ExitPlanMode (or AskUserQuestion for a decision you cannot make).`;
  };
  const planBlockText = () => `\n\n<plan-mode>
PLAN MODE IS ACTIVE. You may read and research, but you must not modify source files.
Work the phases in order:
  1. Explore — read the relevant files, search, gather facts. Read-only.
  2. Design — write the complete plan to ${PLAN_FILE_REL} (the only writable file).
  3. Review — re-read your plan critically: missing files, risky steps, how you will verify.
  4. Implement / Verify — these happen ONLY after the user approves the plan.
Finish the turn with ExitPlanMode {"plan": "<the plan>"} so the user can approve it. Never ask for approval in prose, and never edit source before approval.
</plan-mode>`;
  // Install/remove the plan-mode system block as the mode flips mid-run, so the
  // model is never told "plan mode is active" after the user approved.
  let planBlockInstalled = false;
  const applyPlanBlock = (on) => {
    if (!messages[0] || messages[0].role !== 'system') return;
    if (on && !planBlockInstalled) { messages[0].content += planBlockText(); planBlockInstalled = true; }
    else if (!on && planBlockInstalled) {
      messages[0].content = String(messages[0].content).split(planBlockText()).join('');
      planBlockInstalled = false;
    }
  };
  const setPermissionMode = (mode) => {
    const next = ['auto', 'ask', 'acceptEdits', 'plan', 'bypass'].includes(String(mode)) ? String(mode) : 'auto';
    if (next === 'plan' && permissionMode !== 'plan') planPrevMode = permissionMode;
    permissionMode = next;
    applyPlanBlock(next === 'plan');
    emit({ type: 'permissionMode', mode: next });
    return next;
  };
  if (permissionMode === 'plan') {
    // Same five phases Claude Code walks. Implement/Verify only run after the
    // user approves, which is why the prompt says "once the user approves".
    applyPlanBlock(true);
    emit({ type: 'planMode', active: true, file: PLAN_FILE_REL });
  }

  // Hook wrappers around a single tool call. PreToolUse may block the call
  // (exit 2 or permissionDecision "deny") or rewrite its arguments
  // (updatedInput); PostToolUse/PostToolUseFailure may append context that the
  // model then sees as part of the result.
  const beforeTool = async (name, args) => {
    // Plan mode is checked first: it is a product-level gate, not a user hook,
    // and its message must read as guidance rather than as a hook denial.
    const gate = planGate(name, args);
    if (gate) return { blocked: true, reason: gate, args, planGate: true };
    const v = await runHook('PreToolUse', { tool_name: name, tool_input: args });
    if (!v) return { args };
    for (const m of v.systemMessages || []) emit({ type: 'notice', text: m });
    if (v.blocked) return { blocked: true, reason: v.reason || `Blocked by PreToolUse hook for ${name}`, args };
    let effArgs = args;
    if (v.updatedInput && typeof v.updatedInput === 'object') {
      try {
        effArgs = { ...args, ...v.updatedInput };
        emit({ type: 'notice', text: `A PreToolUse hook rewrote the ${name} arguments.` });
      } catch (_) {}
    }
    if (v.needsAsk && typeof opts.approveTool === 'function') {
      let ok = false;
      try { ok = await opts.approveTool(name, effArgs); } catch (_) { ok = false; }
      if (!ok) return { blocked: true, reason: `Denied at permission prompt for ${name}`, args: effArgs };
    }
    return { args: effArgs, context: v.additionalContext || '' };
  };
  const afterTool = async (name, args, result, isError) => {
    const v = await runHook(isError ? 'PostToolUseFailure' : 'PostToolUse', {
      tool_name: name,
      tool_input: args,
      tool_response: result,
      error: isError ? String(result) : undefined,
    });
    if (!v) return String(result);
    let text = String(result);
    if (v.additionalContext) text += `\n\n<hook_context>\n${v.additionalContext}\n</hook_context>`;
    for (const m of v.systemMessages || []) emit({ type: 'notice', text: m });
    return text;
  };

  // ── Token / usage accounting ────────────────────────────────────────────
  // Example surfaces `/usage`, `/cost` and `/context`; every one of those needs
  // numbers, and until now the run threw `json.usage` away after reading it.
  // Accumulate prompt/completion tokens across every step of this turn (and any
  // sub-agent share, since sub-runs report their own totals upward) and stream
  // a `usage` event so the renderer can show live spend.
  // `prompt_tokens`/`completion_tokens` are summed across every step so `/cost`
  // can price the whole turn. `context_tokens` is the *last* call's prompt size —
  // that is what the window meter must show, because summed prompt tokens exceed
  // the context window on any multi-step turn (a 3-step turn bills ~3× the
  // prompt). Rendering the sum as "context used" produced "168,145 of 128,000".
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, context_tokens: 0, model: provider.model };
  const addUsage = (u) => {
    if (!u || typeof u !== 'object') return;
    const pin = Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens);
    const pout = Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens);
    const ptotal = Number(u.total_tokens);
    if (Number.isFinite(pin) && pin > 0) { usageTotals.prompt_tokens += pin; usageTotals.context_tokens = pin; }
    if (Number.isFinite(pout) && pout > 0) usageTotals.completion_tokens += pout;
    usageTotals.total_tokens += (Number.isFinite(ptotal) && ptotal > 0
      ? ptotal
      : (Number.isFinite(pin) ? pin : 0) + (Number.isFinite(pout) ? pout : 0));
    usageTotals.calls++;
    emit({ type: 'usage', usage: { ...usageTotals }, model: provider.model });
  };

  // Output budget for this turn. Starts as "whatever the provider config says"
  // and is raised if a reply gets cut, so later retries in the same turn ask
  // for the bigger budget straight away instead of being cut a second time.
  let outCeiling = 0;
  // Per-agent read-state mtime tracking so Edit/MultiEdit detects external or
  // concurrent modifications since this agent last Read the file.
  const agentReadMtimes = opts.readMtimes instanceof Map ? opts.readMtimes : new Map();
  const pauseCtrl = opts.pauseController || null;

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
    if (pauseCtrl) {
      await pauseCtrl.waitIfPaused(opts.signal);
      const notes = pauseCtrl.drainSteering();
      if (notes.length) {
        const joined = notes.join('\n\n');
        messages.push({ role: 'user', content: joined });
        emit({ type: 'notice', text: `Resumed with steering note: ${joined.slice(0, 120)}` });
      }
    }
    // Live teammate inbox delivery between steps: active team agents pick up
    // new SendMessage payloads (or shutdown requests) mid-run without restart.
    if (step > 0 && opts.teamContext && opts.teamContext.teamName && opts.teamContext.agentName) {
      try {
        const tasks = require('./tasks');
        const drained = tasks.drainInbox({ team_name: opts.teamContext.teamName, name: opts.teamContext.agentName });
        const incoming = Array.isArray(drained) ? drained : (drained && Array.isArray(drained.messages) ? drained.messages : []);
        if (incoming.length) {
          const shutdownReq = incoming.find((m) => m && typeof m === 'object' && (m.type === 'shutdown_request' || m.shutdown === true || /shutdown_request/i.test(String(m.summary || ''))));
          if (shutdownReq) {
            messages.push({ role: 'assistant', content: 'Received shutdown request from team; stopping cleanly.' });
            emit({ type: 'done', messages, usage: { ...usageTotals } });
            return messages;
          }
          const formatted = incoming.map((m) => (typeof m === 'string'
            ? `- ${m}`
            : `- [${m.from || 'team'}] ${m.message || m.text || m.summary || JSON.stringify(m)}`)).join('\n');
          messages.push({
            role: 'user',
            content: `<team_inbox team="${opts.teamContext.teamName}" agent="${opts.teamContext.agentName}">\n${formatted}\n</team_inbox>`,
          });
        }
      } catch (_) {}
    }
    let message;
    // Count what this turn streamed so a discarded attempt (token-limit retry)
    // can be removed from the transcript instead of showing the same paragraph
    // twice, once truncated.
    let turnChars = 0;
    let turnThink = 0;
    // Mid-run compaction: a long tool loop keeps appending results, so re-check
    // the live size every step and compact before the provider has to reject it.
    if (step > 0) {
      const liveCap = Math.round(historyBudget * 0.95);
      if (historyChars() > liveCap) {
        const c = compactTo(Math.round(historyBudget * 0.7));
        if (c.dropped) {
          emit({ type: 'notice', text: `Compacted ${c.dropped} earlier turn${c.dropped === 1 ? '' : 's'} mid-run to keep this tool loop inside ${provider.model}'s context window.` });
        } else if (!shrinkLargest()) {
          // Nothing left to shrink — the next call will decide (chatRound retries).
        }
      }
    }
    const doChat = (withTools, maxTokens) => {
      turnChars = 0;
      turnThink = 0;
      let lastToolStreamAt = 0;
      let lastToolStreamKey = '';
      const unescapeToolTail = (raw) => String(raw || '')
        .replace(/\\n/g, '\n')
        .replace(/\\t/g, '  ')
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, '\\')
        .trim();
      const onToolDelta = (info) => {
        if (!info || !info.name) return;
        const now = Date.now();
        const key = `${info.id || ''}|${info.name}`;
        if (key === lastToolStreamKey && now - lastToolStreamAt < 150) return;
        lastToolStreamAt = now;
        lastToolStreamKey = key;
        let target = '';
        if (info.argsPreview) {
          const m = /"(?:file_path|path|filePath|filename|command|cmd|description|goal|query|tool|url)"\s*:\s*"([^"\n]{1,90})/i.exec(info.argsPreview);
          if (m) target = m[1];
        }
        const preview = unescapeToolTail(info.argsTail || info.argsPreview || '').slice(-480);
        emit({
          type: 'toolStream',
          id: info.id || '',
          name: info.name,
          bytes: Number(info.bytes) || 0,
          lines: Number(info.lines) || 0,
          target,
          preview,
          phase: 'args',
        });
      };
      return chatWithFailover({
        list: providerList,
        getIndex,
        getHome: () => homeIndex,
        setIndex,
        messages,
        tools: withTools ? tools : undefined,
        onDelta: (text, thinking) => {
          if (thinking) turnThink += text.length; else turnChars += text.length;
          emit({ type: thinking ? 'thinking' : 'delta', text });
        },
        onToolDelta,
        emit,
        signal: opts.signal,
        maxTokens,
      }).then((m) => {
        // Record the output tokens this attempt produced into the shared pool.
        // A discarded token-limit attempt still cost tokens, so it counts too.
        if (m && m.usage) {
          const out = Number(m.usage.completion_tokens != null ? m.usage.completion_tokens : m.usage.output_tokens);
          if (Number.isFinite(out) && out > 0) budgetPool.addOutput(out);
        }
        addUsage(m && m.usage);
        if (process.env.AUTOBOT_TRACE) {
          traceLine({
            t: new Date().toISOString(),
            model: provider.model,
            transport: provider.transport || null,
            withTools: !!withTools,
            toolsSent: withTools ? (tools || []).length : 0,
            maxTokens: maxTokens || null,
            finish: m && m.finish_reason,
            contentChars: m ? String(m.content || '').length : null,
            calls: m && m.tool_calls ? m.tool_calls.map((c) => c.function && c.function.name) : [],
            usage: m && m.usage ? m.usage : null,
          });
        }
        return m;
      }).catch((e) => {
        if (process.env.AUTOBOT_TRACE) {
          traceLine({
            t: new Date().toISOString(),
            model: provider.model,
            transport: provider.transport || null,
            withTools: !!withTools,
            toolsSent: withTools ? (tools || []).length : 0,
            maxTokens: maxTokens || null,
            msgs: (messages || []).length,
            // Fingerprint (not the token) so a logged failure can be matched to
            // the credential that produced it without writing a secret to disk.
            tokTag: (() => {
              const tok = String(provider.accessToken || provider.apiKey || '');
              if (!tok) return null;
              try {
                return require('crypto').createHash('sha256').update(tok).digest('hex').slice(0, 12);
              } catch (_) { return 'len' + tok.length; }
            })(),
            apiKeyHeader: !!(provider.apiKey && !provider.accessToken),
            oauth: !!provider.oauth,
            status: e && e.status != null ? e.status : null,
            error: String((e && e.message) || e).slice(0, 600),
          });
        }
        throw e;
      });
    };
    // One chat round with automatic recovery for an oversized prompt. Providers
    // report "prompt is too long" / "context length exceeded" in prose, not as a
    // distinct status, so isContextOverflow() classifies it; we compact further
    // (or trim the biggest result) and resend instead of dying mid-task.
    const chatRound = async (withTools, maxTokens) => {
      let tries = 0;
      let imageFallbackTried = false;
      for (;;) {
        try {
          return await doChat(withTools, maxTokens);
        } catch (e) {
          const msg = String((e && e.message) || e || '');
          const imgErr = /\b(400|422)\b/.test(msg)
            && /(image_url|input_image|image content|multimodal|does not support images|invalid.*content.*array)/i.test(msg);
          if (imgErr && !imageFallbackTried && messages.some((m) => m && m._syntheticImageRead)) {
            imageFallbackTried = true;
            for (let k = messages.length - 1; k >= 0; k--) {
              if (messages[k] && messages[k]._syntheticImageRead) messages.splice(k, 1);
            }
            emit({ type: 'notice', text: `${provider.model} does not accept inline image content — falling back to text-only tool output.` });
            continue;
          }
          if (!isContextOverflow(e) || (opts.signal && opts.signal.aborted)) throw e;
          if (tries >= 5) throw e;
          tries++;
          const c = compactTo(Math.round(historyBudget * 0.55));
          const shrunk = c.freed > 0 || shrinkLargest();
          if (!shrunk) throw e;
          emit({
            type: 'notice',
            text: `“${provider.model}” reported the prompt was over its context window — ${c.dropped ? `compacted ${c.dropped} earlier turn${c.dropped === 1 ? '' : 's'}` : 'trimmed the largest tool result'} and retrying.`,
          });
        }
      }
    };
    try {
      message = await chatRound(toolMode, outCeiling || undefined);
    } catch (e) {
      // Two different reasons to stop using native tool calls, both recoverable:
      //   • the endpoint rejects the tools schema (capability mismatch), and
      //   • the account cannot pay for the tool-enabled request shape. For
      //     subscription agent providers the agent route is metered separately
      //     from plain chat, so a Grok account whose Build allowance is spent
      //     answers a chat turn and 402s the moment tools are attached.
      // Either way, fall back to plain chat + the fenced text tool protocol so
      // the model can still edit files, and tell the user why in prose.
      const errMsg = String(e.message || '');
      // An entitlement/billing 400 is NOT a statement about tools. Before this
      // guard, the word "tool" anywhere in the body (or any bare 400) flipped
      // the whole turn into text mode with no visible reason — so a real
      // "extra usage" rejection looked like a tooling bug and the model
      // silently lost Write/Bash. Only a schema-shaped signal may downgrade.
      const billingish = /extra usage|plan limits|add more at|credit balance|insufficient|billing|quota/i.test(errMsg);
      const schemaish = /input_schema|tool_use|unexpected field|unknown field|tools? (are |is )?(not supported|unsupported)|invalid tool/i.test(errMsg);
      const statusish = /\b(400|422)\b/.test(errMsg);
      const toolRejected = statusish && schemaish && !billingish
        && !/max_tokens|max_completion_tokens/i.test(errMsg);
      if (toolMode && !isContextOverflow(e) && (isCreditExhausted(e) || toolRejected)) {
        const credit = isCreditExhausted(e);
        toolMode = false;
        if (!textToolMode) {
          textToolMode = true;
          // Re-normalize the history (earlier steps may already contain native
          // tool_calls / role:"tool" entries that this endpoint would reject).
          messages = sanitizeHistory(messages, { supportsTools: false, maxChars: historyBudget });
          if (messages[0] && messages[0].role === 'system') messages[0].content += '\n\n' + TEXT_TOOL_PROTOCOL;
        }
        if (credit) {
          emit({
            type: 'notice',
            text: `${humanizeLLMError(e)} — native tools are unavailable on this allowance, so I am continuing the task in text mode (files still get written). Nothing was lost.`,
          });
        } else {
          // Never drop tools silently: the user must know the turn degraded.
          emit({
            type: 'notice',
            text: `${humanizeLLMError(e)} — this endpoint would not accept the native tool schema, so I am continuing in text mode (files are still written). Nothing was lost.`,
          });
        }
        try {
          message = await chatRound(false, outCeiling || undefined);
        } catch (e2) {
          if (!isCreditExhausted(e2) || (opts.signal && opts.signal.aborted)) throw e2;
          // The allowance is spent for plain chat too. Throwing here put a red
          // error banner *underneath* the notice, which said the same thing
          // twice and looked like a crash. End the turn in prose instead: the
          // user gets one clear reason and one clear next step.
          const reason = humanizeLLMError(e2);
          const prose = reason.replace(/[\s.]+$/, '');
          emit({
            type: 'notice',
            text: `${prose}. Plain chat is unavailable as well, so I stopped this turn — switch to another account or provider, or wait for the allowance to reset, and I will resume from here.`,
          });
          messages.push({
            role: 'assistant',
            content: `I could not run this turn. ${prose}. Nothing was changed on disk beyond what is shown above, and the conversation is intact — switch account or provider and send the same request again.`,
          });
          emit({ type: 'done', messages, usage: { ...usageTotals } });
          return messages;
        }
      } else {
        throw e;
      }
    }

    // Stop pressed while the reply streamed: never run the calls it carried.
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');

    // Reasoning models (Kimi K3.1 Pro, DeepSeek V4.1 Flash) burn the token budget
    // on chain-of-thought BEFORE emitting the code/tool calls. When the stream is
    // cut at the token limit (finish_reason "length") the website/code silently
    // never appears — either no tool calls at all, or a call whose JSON arguments
    // were sliced mid-string. Escalate the output budget and regenerate; if the
    // answer is STILL cut, continue it in place so a long file or explanation
    // finishes instead of stopping at "…" (this is the Claude-app behaviour).
    //
    // The escalation is silent: `retry` drops the cut attempt from the UI and the
    // animated "Working…" keeps the turn visibly alive, so the user gets one
    // continuous answer instead of a "retrying with N tokens" thought line.
    if (message && message.finish_reason === 'length') {
      const base = outCeiling || (Number(provider.maxTokens) > 0 ? Number(provider.maxTokens) : 16384);
      // Never ask for more room than the window can hold: output + a prompt
      // reserve must still fit, and no model accepts more than 65536 output.
      const roomLeft = Math.max(8192, Math.round(modelBudget.window - modelBudget.promptReserve));
      const ceiling = Math.max(base, Math.min(65536, roomLeft, Math.max(8192, modelBudget.reserveOut * 4)));
      let bumped = base;
      let cutCalls = message.tool_calls || [];
      for (let attempt = 0; attempt < 3; attempt++) {
        // A complete tool call (or any complete answer) is the win condition.
        if (message && message.finish_reason !== 'length') break;
        if (cutCalls.length && !hasCutCalls(cutCalls)) break;
        const next = Math.min(Math.max(bumped * 2, bumped + 8192), ceiling);
        if (next <= bumped) break;
        bumped = next;
        emit({ type: 'retry', chars: turnChars, thinkingChars: turnThink });
        message = await chatRound(toolMode, bumped);
        cutCalls = (message && message.tool_calls) || [];
      }
      // Remember the larger budget for the rest of this turn: if a call was cut
      // and the model redoes it, that retry must not start over at the small
      // default and get cut again.
      outCeiling = Math.max(outCeiling, bumped);
      {
        // A complete tool call wins. Otherwise merge continuation passes so the
        // user gets the whole answer rather than a truncated one.
        let part = 1;
        while (message && message.finish_reason === 'length' && !(cutCalls.length && !hasCutCalls(cutCalls)) && part <= 3) {
          const partial = String(message.content || '');
          if (!partial.trim()) break;
          const partialMsg = { role: 'assistant', content: partial };
          part++;
          emit({ type: 'thinking', text: ` (composing a long reply — part ${part})` });
          messages.push(partialMsg);
          const continueAsk = { role: 'user', content: '[continue] Resume the reply exactly where it stopped. Output only the continuation — do not repeat earlier text and do not add a preamble.' };
          messages.push(continueAsk);
          let more;
          try {
            more = await chatRound(toolMode, bumped);
          } finally {
            // Remove by identity: compaction may have rebuilt the array mid-call.
            for (const ref of [continueAsk, partialMsg]) {
              const i = messages.lastIndexOf(ref);
              if (i >= 0) messages.splice(i, 1);
            }
          }
          const add = String((more && more.content) || '');
          message = {
            ...(more || message),
            content: partial + (add && !partial.endsWith('\n') ? '\n' : '') + add,
          };
          cutCalls = (more && more.tool_calls) || [];
        }
      }
    }

    let calls = message.tool_calls && message.tool_calls.length ? message.tool_calls : [];
    let textCalls = false;
    if (!calls.length && (textToolMode || message.content)) {
      // Free models often answer with <tool_call>/<function=…> text even when
      // native tools are on; run those instead of ending the turn on raw JSON.
      const parsed = parseTextToolCalls(message.content || '', { nativeFallback: !textToolMode }).filter((c) => knownToolNames.has(c.function.name));
      if (parsed.length) { calls = parsed; textCalls = true; }
    }

    if (!calls.length) {
      // Safety net: if this turn produced visible code but never touched a file
      // or the Artifact tool, materialize it so the "website" actually exists.
      let extraNote = '';
      if (!wroteSomething) {
        const created = autoCaptureArtifacts(message.content || '', currentCwd, emit);
        if (created.length) extraNote = `\n\n(Saved ${created.join(', ')} to your project so it renders live.)`;
      }
      messages.push({ role: 'assistant', content: (message.content || '') + extraNote });
      // Plan mode contract: the turn has to end on ExitPlanMode or
      // AskUserQuestion, never on a prose "shall I proceed?". If the model just
      // talked, push it back onto the tool instead of ending the turn.
      if (permissionMode === 'plan' && !planEnded && planNudges < 3) {
        planNudges++;
        emit({ type: 'notice', text: 'Plan mode — the turn must end with ExitPlanMode or AskUserQuestion.' });
        messages.push({ role: 'user', content: `[plan-mode] Do not ask for approval in prose. Write the plan to ${PLAN_FILE_REL} if you have not, then call ExitPlanMode {"plan": "<the plan>"} (or AskUserQuestion if you genuinely cannot decide).` });
        continue;
      }
      // Stop hook: Claude Code fires this when the turn ends. It may add a
      // system message, or `continue: false` to force the loop to keep going
      // (a Stop hook that refuses to let the agent finish).
      {
        const v = await runHook('Stop', { stop_hook_active: false, transcript_length: messages.length });
        if (v) {
          for (const m of v.systemMessages || []) emit({ type: 'notice', text: m });
          if (v.stop && nudges < 3) {
            nudges++;
            messages.push({ role: 'user', content: `[hook] ${v.reason || 'Continue — the Stop hook says the work is not finished.'}` });
            continue;
          }
          if (v.additionalContext && hookNudges < 5) {
            hookNudges++;
            messages.push({ role: 'user', content: `[hook] ${v.additionalContext}` });
            continue;
          }
        }
      }
      emit({ type: 'done', messages, usage: { ...usageTotals } });
      return messages;
    }

    // record assistant message with tool_calls (text protocol keeps plain content)
    if (textCalls) {
      messages.push({ role: 'assistant', content: message.content || '' });
    } else {
      messages.push({
        role: 'assistant',
        content: message.content || '',
        tool_calls: calls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
      });
    }

    // Context handed to built-in tools for sub-agents, questions, plan mode, shells, MCP resources.
    // Model roster for tier routing: the orchestrator pool + the active provider.
    const AGENT_RUNS_DIR = path.join(os.homedir(), '.autobot', 'agent-runs');
    const AGENT_OUT_DIR = path.join(os.homedir(), '.autobot', 'agents');
    const buildForkContextDigest = (parentMsgs, maxChars = 5000) => {
      try {
        const recent = (Array.isArray(parentMsgs) ? parentMsgs : [])
          .filter((m) => m && m.role !== 'system' && !m._syntheticImageRead)
          .slice(-10)
          .map((m) => {
            let txt = '';
            if (typeof m.content === 'string') txt = m.content;
            else if (Array.isArray(m.content)) txt = m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '[part]')).join(' ');
            else if (m.content != null) txt = JSON.stringify(m.content);
            txt = txt.replace(/\s+/g, ' ').trim().slice(0, 700);
            const tc = Array.isArray(m.tool_calls) && m.tool_calls.length
              ? ` [calls: ${m.tool_calls.map((c) => c.function && c.function.name).filter(Boolean).join(', ')}]`
              : '';
            return `[${m.role}${m.name ? ':' + m.name : ''}${tc}] ${txt}`;
          })
          .filter(Boolean);
        let out = '';
        for (let i = recent.length - 1; i >= 0; i--) {
          const line = recent[i];
          if (out.length + line.length + 2 > maxChars) break;
          out = line + (out ? '\n' + out : '');
        }
        return out ? `\n\n<forked_parent_context>\n${out}\n</forked_parent_context>` : '';
      } catch (_) { return ''; }
    };
    const agentRoster = swarm.buildRoster({ orchestrator: orch, provider: providerList[getIndex()] });
    const runSubagent = async (args) => {
      args = args || {};
      if (depth >= MAX_AGENT_DEPTH) {
        return 'Sub-agents at this depth cannot spawn further sub-agents. Do this part of the work yourself with the tools you have.';
      }
      // Resume support (Claude Code `resume: agentId`) + persisted output artifacts.
      const resumeId = args.resume ? String(args.resume).replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 80) : '';
      let priorRun = null;
      if (resumeId) {
        try {
          const rf = path.join(AGENT_RUNS_DIR, `${resumeId}.json`);
          if (fs.existsSync(rf)) priorRun = JSON.parse(fs.readFileSync(rf, 'utf8'));
        } catch (_) { priorRun = null; }
      }
      const agentId = resumeId || (`agent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`);
      const startedAt = Date.now();
      // Unique handle: two agents with the same description must not share a
      // controller (TaskStop would stop the wrong one, ListAgents would hide one).
      const baseName = String(args.name || (priorRun && priorRun.name) || args.description || 'sub-agent').slice(0, 80);
      let name = baseName;
      for (let k = 2; subagentControllers.has(name); k++) name = `${baseName} #${k}`;
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      const parents = [opts.signal, args.signal].filter((x) => x && typeof x.addEventListener === 'function');
      for (const sig of parents) {
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort, { once: true });
      }
      // A delegated task may pin a sub-agent DEFINITION (`subagent_type`), which
      // carries its own system prompt, tool allowlist, and model — Claude Code's
      // `.claude/agents/*.md` contract.
      let def = null;
      const wantSubType = args.subagent_type || args.agent_type || args.type || (priorRun && priorRun.subagentType) || null;
      if (wantSubType) {
        try {
          const agentdefs = require('./agentdefs');
          def = agentdefs.resolve(wantSubType, currentCwd);
          if (!def) def = agentdefs.BUILTIN['general-purpose'];
        } catch (_) {}
      }
      // Model selection. `haiku|sonnet|opus|inherit` are ALIASES (agent
      // definitions use them) and are never sent as wire ids — they map to a
      // role/tier. A real model id pins that model first, with the rest of the
      // pool behind it for failover. Nothing pinned → inherit the parent chain.
      const rawModel = args.model || args.model_id || null;
      const defModel = def && def.model ? def.model : null;
      const aliasR = rawModel && router.isModelAlias(rawModel) ? router.aliasRole(rawModel)
        : (!rawModel && defModel && router.isModelAlias(defModel) ? router.aliasRole(defModel) : undefined);
      const wantModel = rawModel && !router.isModelAlias(rawModel) ? String(rawModel)
        : (!rawModel && defModel && !router.isModelAlias(defModel) ? String(defModel) : null);
      const wantRole = router.normalizeRole(args.role)
        || (def && router.normalizeRole(def.role))
        || aliasR
        || ((args.tier || args.complexity) ? router.tierToRole(args.tier || args.complexity) : null);
      const parentProvider = providerList[getIndex()];
      let subProvider = parentProvider;
      // Unpinned: inherit the parent's whole failover chain (pool or list).
      let subOrch = poolMode && orch && orch.role ? orch
        : (poolMode ? { enabled: true, providers: providerList, activeIndex: getIndex(), pools: orch && orch.pools, role: 'inherit' } : opts.orchestrator);
      let tier = null;
      let role = null;
      const poolsOn = poolMode && orch && router.poolsConfig(orch);
      if (poolsOn && (wantRole || wantModel || !(orch && orch.role))) {
        role = wantRole || (orch && orch.role && orch.role !== 'inherit' ? orch.role : 'coder');
        const scoped = router.orchestratorFor(orch, role, parentProvider, { index: subSpawnCount, preferModel: wantModel });
        if (scoped) {
          subOrch = scoped;
          subProvider = scoped.providers[0];
          tier = router.ROLE_TIER[role] || 'heavy';
          if (wantModel && !scoped.providers.some((r) => r.model === wantModel)) {
            // A gateway model outside the pool: the gateway serves it, so try it
            // first and keep the pool behind it.
            subProvider = { ...scoped.providers[0], model: wantModel, id: 'pinned:' + wantModel, maxConcurrent: undefined };
            subOrch = { ...scoped, providers: [subProvider].concat(scoped.providers) };
          }
        }
      } else if (!poolsOn && (wantModel || wantRole)) {
        const wantTier = (args.tier || args.complexity) ? swarm.normalizeTier(args.tier || args.complexity)
          : (wantRole ? (router.ROLE_TIER[wantRole] || 'heavy') : 'heavy');
        const byModel = wantModel ? agentRoster.find((r) => r.model === wantModel) : null;
        const base = byModel || swarm.pickProvider(agentRoster, wantTier) || parentProvider;
        subProvider = byModel ? { ...byModel } : (wantModel ? { ...base, model: wantModel } : { ...base });
        tier = base.tier || wantTier;
        // Keep failover: chosen row first, same-tier rows next, the rest last.
        const rest = agentRoster.filter((r) => r !== base && r !== byModel);
        const chain = [subProvider].concat(rest.filter((r) => r.tier === tier), rest.filter((r) => r.tier !== tier));
        subOrch = chain.length > 1 ? { enabled: true, providers: chain, activeIndex: 0, role: 'pinned' } : null;
      }
      subSpawnCount++;
      // Tool allowlist from the definition (read-only Explore/Plan types).
      let toolAllow = null;
      if (def) {
        try { toolAllow = require('./agentdefs').allowedToolSet(def); } catch (_) { toolAllow = null; }
      }
      const defPrompt = def && def.body ? require('./agentdefs').promptFor(def) : null;
      const teamName = args.team_name ? String(args.team_name).trim() : '';
      let liveUnreg = null;
      if (teamName) {
        try {
          const tasks = require('./tasks');
          tasks.addMember(teamName, {
            name,
            role: role || (def && def.name) || 'worker',
            status: 'active',
            model: subProvider ? subProvider.model : null,
          });
          if (typeof tasks.registerLiveMember === 'function') {
            liveUnreg = tasks.registerLiveMember(teamName, name, {
              onSignal: (sig) => { if (sig && sig.shutdown) ac.abort(); },
            });
          }
          if (toolAllow && !toolAllow.has('*')) {
            for (const tmTool of ['TaskList', 'TaskGet', 'TaskUpdate', 'TaskCreate', 'SendMessage']) {
              toolAllow.add(tmTool);
            }
          }
        } catch (_) {}
      }
      // Git worktree isolation (`isolation: 'worktree'`): spawn subagent in an
      // isolated branch worktree; auto-prune if clean, preserve if modified.
      let subCwd = args.cwd || currentCwd;
      let worktreeInfo = null;
      if (args.isolation === 'worktree' && subCwd) {
        try {
          const gitRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: subCwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          const baseHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
          const slug = name.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 32) || 'sub';
          const wtBranch = `wt-${slug}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
          const wtDir = path.join(os.tmpdir(), `akron-${wtBranch}`);
          execFileSync('git', ['worktree', 'add', '-b', wtBranch, wtDir, 'HEAD'], { cwd: gitRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          const relSub = path.relative(gitRoot, subCwd);
          subCwd = relSub && !relSub.startsWith('..') ? path.join(wtDir, relSub) : wtDir;
          worktreeInfo = { gitRoot, wtDir, wtBranch, baseHead };
        } catch (_) { worktreeInfo = null; }
      }
      // Per-role parallelism cap (pool `maxConcurrent`): the N+1th coder waits
      // for a slot instead of piling onto rate-limited free tiers.
      const roleCap = role && orch ? router.roleLimit(orch, role) : 0;
      let releaseRole = null;
      subagentControllers.set(name, { controller: ac, agentId, status: roleCap ? 'queued' : 'running', started: startedAt, model: subProvider && subProvider.model, tier, role, subagentType: def && def.name });
      emit({ type: 'subagent', id: name, agentId, name, status: 'started', role: 'worker', jobRole: role, model: subProvider ? subProvider.model : null, tier, subagentType: def && def.name });
      let failed = null;
      const subToolsRun = [];
      try {
        if (roleCap) {
          releaseRole = await gate.acquire({ gateKey: 'role|' + role, maxConcurrent: roleCap }, ac.signal);
          const rec = subagentControllers.get(name);
          if (rec) rec.status = 'running';
        }
        let userPrompt = args.prompt || args.description || '';
        if (teamName) {
          let inboxBlock = '';
          try {
            const tasks = require('./tasks');
            const drained = tasks.drainInbox({ team_name: teamName, name });
            const msgs = Array.isArray(drained) ? drained : (drained && Array.isArray(drained.messages) ? drained.messages : []);
            if (msgs.length) {
              const formatted = msgs.map((m) => (typeof m === 'string' ? `- ${m}` : `- [${m.from || 'team'}] ${m.message || m.text || m.summary || JSON.stringify(m)}`)).join('\n');
              inboxBlock = `\n\n<team_inbox team="${teamName}" agent="${name}">\n${formatted}\n</team_inbox>`;
            }
          } catch (_) {}
          userPrompt = `[Team "${teamName}", your member name is "${name}". Use TaskList/TaskUpdate/SendMessage to coordinate.]\n\n${userPrompt}${inboxBlock}`;
        }
        if (args.fork_context === true && !(priorRun && Array.isArray(priorRun.messages))) {
          userPrompt += buildForkContextDigest(messages);
        }
        let subMsgs;
        if (priorRun && Array.isArray(priorRun.messages) && priorRun.messages.length) {
          const priorBody = priorRun.messages.filter((m) => m && m.role !== 'system');
          subMsgs = (defPrompt ? [{ role: 'system', content: defPrompt }] : []).concat(priorBody, [{ role: 'user', content: userPrompt }]);
        } else {
          subMsgs = defPrompt
            ? [{ role: 'system', content: defPrompt }, { role: 'user', content: userPrompt }]
            : [{ role: 'user', content: userPrompt }];
        }
        const subMaxSteps = Number(args.max_turns) > 0
          ? Math.min(1000, Math.floor(Number(args.max_turns)))
          : (opts.subagentMaxSteps || 0);
        const subResult = await runAgent({
          provider: subProvider,
          orchestrator: subOrch,
          messages: subMsgs,
          cwd: subCwd,
          // The child's own `done` must not end the parent's stream in the UI;
          // the parent reports the child's status itself.
          emit: (evt) => {
            if (!evt || evt.type === 'done' || evt.type === 'complete') return;
            if (evt.type === 'tool' && evt.name) subToolsRun.push(evt.name);
            emit({ ...evt, subagent: name });
          },
          maxSteps: subMaxSteps,
          useMemory: opts.useMemory,
          callMcpTool: opts.callMcpTool,
          mcpClient: opts.mcpClient,
          askUser: opts.askUser,
          exitPlanMode: opts.exitPlanMode,
          mcpListResources: opts.mcpListResources,
          mcpReadResource: opts.mcpReadResource,
          approveTool: opts.approveTool,
          shell: opts.shell,
          extraTools: opts.extraTools,
          signal: ac.signal,
          toolAllow,
          depth: depth + 1,
          // A delegated agent inherits plan mode: Explore runs read-only.
          permissionMode,
          convId: opts.convId,
          turnId: opts.turnId,
          teamContext: teamName ? { teamName, agentName: name } : null,
        });
        const last = [...(Array.isArray(subResult) ? subResult : [])].reverse().find((m) => m.role === 'assistant' && m.content && String(m.content).trim());
        let outText = last && last.content ? String(last.content) : '';
        if (!outText.trim()) {
          const uniq = [...new Set(subToolsRun)].slice(0, 8);
          outText = uniq.length
            ? `Sub-agent "${name}" completed (${subToolsRun.length} tool actions: ${uniq.join(', ')}) with no final prose summary.`
            : `Sub-agent "${name}" completed with no final message.`;
        }
        if (worktreeInfo) {
          let dirtyOrCommitted = false;
          try {
            const st = execFileSync('git', ['status', '--porcelain'], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
            const headCount = Number(execFileSync('git', ['rev-list', '--count', `${worktreeInfo.baseHead}..HEAD`], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) || 0;
            dirtyOrCommitted = Boolean(st) || headCount > 0;
          } catch (_) { dirtyOrCommitted = true; }
          if (dirtyOrCommitted) {
            outText += `\n\n[Worktree preserved: path=${worktreeInfo.wtDir}, branch=${worktreeInfo.wtBranch}]`;
            worktreeInfo = null;
          }
        }
        try {
          fs.mkdirSync(AGENT_RUNS_DIR, { recursive: true });
          fs.mkdirSync(AGENT_OUT_DIR, { recursive: true });
          fs.writeFileSync(path.join(AGENT_RUNS_DIR, `${agentId}.json`), JSON.stringify({
            agentId,
            name,
            subagentType: (def && def.name) || null,
            model: subProvider ? subProvider.model : null,
            cwd: subCwd,
            updatedAt: Date.now(),
            toolCount: subToolsRun.length,
            messages: Array.isArray(subResult) ? subResult.slice(-60) : [],
          }), 'utf8');
          fs.writeFileSync(path.join(AGENT_OUT_DIR, `${agentId}.txt`), outText, 'utf8');
        } catch (_) {}
        const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
        outText += `\n\n[agentId: ${agentId} · ${subToolsRun.length} tool${subToolsRun.length === 1 ? '' : 's'} · ${secs}s]`;
        return outText;
      } catch (e) {
        if (ac.signal.aborted || (opts.signal && opts.signal.aborted)) {
          failed = 'stopped';
          if (opts.signal && opts.signal.aborted) throw e;
          return `Sub-agent "${name}" was stopped before it finished.`;
        }
        failed = 'error';
        // A child's provider failure is a tool result for the parent, not the
        // end of the parent's turn.
        return `Error: sub-agent "${name}" failed — ${humanizeLLMError(e)}. Continue without it or retry with a narrower task.`;
      } finally {
        if (liveUnreg) liveUnreg();
        if (worktreeInfo) {
          let dirtyOrCommitted = false;
          try {
            const st = execFileSync('git', ['status', '--porcelain'], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
            const headCount = Number(execFileSync('git', ['rev-list', '--count', `${worktreeInfo.baseHead}..HEAD`], { cwd: worktreeInfo.wtDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()) || 0;
            dirtyOrCommitted = Boolean(st) || headCount > 0;
          } catch (_) {}
          if (!dirtyOrCommitted) {
            try { execFileSync('git', ['worktree', 'remove', '--force', worktreeInfo.wtDir], { cwd: worktreeInfo.gitRoot, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {}
            try { fs.rmSync(worktreeInfo.wtDir, { recursive: true, force: true }); } catch (_) {}
            try { execFileSync('git', ['worktree', 'prune'], { cwd: worktreeInfo.gitRoot, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {}
            try { execFileSync('git', ['branch', '-D', worktreeInfo.wtBranch], { cwd: worktreeInfo.gitRoot, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (_) {}
          }
        }
        if (teamName) {
          try { require('./tasks').setMemberStatus(teamName, name, failed ? 'stopped' : 'idle'); } catch (_) {}
        }
        if (releaseRole) releaseRole();
        subagentControllers.delete(name);
        emit({ type: 'subagent', id: name, agentId, name, status: failed || 'done', role: 'worker', jobRole: role, model: subProvider ? subProvider.model : null, tier, toolCount: subToolsRun.length, durationMs: Date.now() - startedAt });
        for (const sig of parents) sig.removeEventListener('abort', onAbort);
      }
    };

    const listAgents = () => {
      const entries = [...subagentControllers.entries()];
      if (!entries.length) return '(no agents running)';
      return 'RUNNING AGENTS:\n' + entries.map(([n, s]) => `- ${n} [${s.status}]${s.model ? ' · ' + s.model : ''}${s.role ? ' · ' + s.role : (s.tier ? ' · ' + s.tier : '')} (${Math.round((Date.now() - s.started) / 1000)}s)`).join('\n');
    };
    const stopTask = (name) => {
      const all = [...subagentControllers.entries()];
      const match = all.find(([n]) => n === name) || all.find(([n]) => n.toLowerCase() === String(name || '').toLowerCase()) || (name ? all.find(([n]) => n.includes(name)) : null);
      if (!match) return `No running agent matches "${name}".`;
      match[1].controller.abort();
      match[1].status = 'stopped';
      return `Stopped agent "${match[0]}".`;
    };
    const sendUserMessage = (text) => emit({ type: 'userMessage', text });
    const setGoal = (goal) => emit({ type: 'goal', goal });
    // An artifact is a FILE, not just a chat decoration: write it into the
    // conversation's project folder so the deliverable exists on disk (and the
    // browser pane can open it) even when the model never calls Write.
    const ARTIFACT_DEFAULT_FILE = {
      html: 'index.html', htm: 'index.html',
      svg: 'artifact.svg',
      css: 'styles.css',
      js: 'app.js', javascript: 'app.js',
      jsx: 'App.jsx', tsx: 'App.tsx',
      ts: 'app.ts', typescript: 'app.ts',
      json: 'data.json', md: 'README.md', markdown: 'README.md',
      python: 'main.py', py: 'main.py', sh: 'script.sh', bash: 'script.sh',
      sql: 'query.sql', yaml: 'config.yaml', yml: 'config.yml',
      design: 'design.json', canvas: 'design.json', artboard: 'design.json',
      slides: 'slides.json', deck: 'slides.json', presentation: 'slides.json',
    };
    const createArtifact = (args) => {
      const language = String(args.language || '').toLowerCase().trim();
      const content = args.content == null ? '' : String(args.content);
      let name = String(args.name || '').trim();
      const ext = ARTIFACT_DEFAULT_FILE[language] || '';
      if (!name) name = ext || 'artifact.txt';
      else if (!/\.[a-z0-9]{1,8}$/i.test(name) && ext) name = `${name}${path.extname(ext) || '.txt'}`;
      // Never escape the project folder.
      name = name.replace(/\\/g, '/').replace(/^\/+/, '');
      let filePath = null;
      try {
        const dir = currentCwd || process.cwd();
        filePath = path.resolve(dir, name);
        if (!filePath.startsWith(path.resolve(dir))) filePath = path.join(dir, path.basename(name));
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
      } catch (e) {
        filePath = null;
      }
      emit({ type: 'artifact', name, language: language || 'text', content, path: filePath || undefined });
      // A renderable artifact is also the deliverable preview: ask the renderer
      // to mount the browser pane on the file so the site is visibly there.
      if (filePath && /\.(html?|svg)$/i.test(name)) emit({ type: 'preview', url: filePath });
      return filePath
        ? `Artifact "${name}" written to ${filePath} (${Buffer.byteLength(content)} bytes). It is the file the browser pane opens.`
        : `Artifact "${name}" created in chat (could not write to disk).`;
    };
    const requestSecret = async (name) => `No secret "${name}" found in the secrets store. Provide the value directly to continue.`;

    const ctx = {
      cwd: currentCwd,
      setCwd: (d) => { currentCwd = d; },
      shell: opts.shell,
      // Stop must reach every nested runner (Swarm workers, cowork, Workflow
      // agents, Bash) — before this the ctx carried no signal at all.
      signal: opts.signal,
      depth,
      activateTools,
      // settings.json `permissions.deny` applies to EVERY tool (e.g.
      // `deny: Read(./.env)`), not only to the mutating ones that prompt.
      checkDeny: (toolName, toolArgs) => {
        try {
          const permissions = require('./permissions');
          return permissions.denyMatch(permissions.loadPermissions(currentCwd), toolName, toolArgs || {}, { cwd: currentCwd });
        } catch (_) { return null; }
      },
      runSubagent,
      // Agent runner + provider for cowork orchestration / bot bridges.
      runAgent: (subOpts) => runAgent({
        provider: providerList[getIndex()],
        // A sub-run that pins its own provider must NOT re-expand into the
        // parent's orchestrator list, or the pin would be silently replaced.
        orchestrator: subOpts && subOpts.provider ? null : opts.orchestrator,
        cwd: subOpts.cwd || currentCwd,
        useMemory: opts.useMemory,
        shell: opts.shell,
        callMcpTool: opts.callMcpTool,
        mcpClient: opts.mcpClient,
        askUser: opts.askUser,
        exitPlanMode: opts.exitPlanMode,
        mcpListResources: opts.mcpListResources,
        mcpReadResource: opts.mcpReadResource,
        approveTool: opts.approveTool,
        extraTools: opts.extraTools,
        permissionMode,
        signal: opts.signal,
        depth: depth + 1,
        ...subOpts,
      }),
      mcpClient: opts.mcpClient || null,
      get provider() { return providerList[getIndex()]; },
      orchestrator: opts.orchestrator || null,
      // The un-scoped pool config (role pools) for Swarm/Workflow routing.
      poolOrchestrator: poolMode && orch ? orch : null,
      emit,
      agentRoster,
      askUser: opts.askUser,
      // Plan approval flips plan mode off when the user approves, so the same
      // run can go on to implement and verify — exactly Example's behaviour.
      exitPlanMode: async (p) => {
        const text = opts.exitPlanMode
          ? String(await opts.exitPlanMode(p) || '')
          : '(plan approval unavailable — assume approved)';
        const approved = /approved/i.test(text) && !/not approved|rejected/i.test(text);
        if (approved) {
          setPermissionMode(planPrevMode || 'auto');
          emit({ type: 'planMode', active: false });
          emit({ type: 'notice', text: 'Plan approved — plan mode is off, implementing now.' });
        } else {
          emit({ type: 'notice', text: 'Plan not approved yet — staying in plan mode. Revise the plan and try again.' });
        }
        return text;
      },
      mcpListResources: opts.mcpListResources,
      mcpReadResource: opts.mcpReadResource,
      setPermissionMode,
      // PermissionRequest hooks run before the user is prompted, exactly as in
      // Claude Code: an allow/deny hook saves the prompt entirely.
      approveTool: async (toolName, toolArgs) => {
        const v = await runHook('PermissionRequest', { tool_name: toolName, tool_input: toolArgs });
        if (v && v.blocked) return false;
        if (v && v.updatedInput && toolArgs && typeof toolArgs === 'object') {
          try { Object.assign(toolArgs, v.updatedInput); } catch (_) {}
        }
        for (const m of (v && v.systemMessages) || []) emit({ type: 'notice', text: m });
        if (!opts.approveTool) return true;
        try { return await opts.approveTool(toolName, toolArgs); } catch (_) { return false; }
      },
      listAgents,
      stopTask,
      sendUserMessage,
      setGoal,
      createArtifact,
      requestSecret,
      readMtimes: agentReadMtimes,
      allowRichRead: true,
    };

    // A tool call whose JSON was sliced by the output limit must never run with
    // empty arguments: that produced an empty "error" card, lost the work, and
    // made long writes look like the agent was broken. Drop the cut call, tell
    // the model precisely how to redo it in pieces, and keep the turn alive.
    if (!textCalls && hasCutCalls(calls)) {
      const cutNote = 'This tool call was cut off before its arguments were complete, so it did NOT run. Redo the work in smaller pieces: keep each Write under ~150 lines, then append the rest with the Edit tool (or a Bash redirect), and do not resend the same oversized call.';
      const kept = [];
      for (const tc of calls) {
        const name = (tc.function && tc.function.name) || 'tool';
        if (!isCutJSON(tc.function && tc.function.arguments)) { kept.push(tc); continue; }
        // No card for a call that never ran: an empty-argument "error" row is
        // exactly the broken-looking output users complained about. The tool
        // message still goes back so the assistant/tool pairing stays valid.
        messages.push({ role: 'tool', tool_call_id: tc.id, name, content: cutNote });
      }
      calls = kept;
      if (!calls.length) continue;
    }

    const runFindMcpTools = (findArgs) => {
      const hits = mcpSchema.searchMcpTools(extra, (findArgs && (findArgs.query || findArgs.q)) || '', findArgs && findArgs.server);
      if (hits.length) activateTools(hits.map((h) => h.name));
      return hits.length
        ? `MCP tools matching ${JSON.stringify((findArgs && findArgs.query) || '')} (now active and callable by exact name):\n`
          + hits.map((h) => `\n### ${h.name}\n${h.description}\n${JSON.stringify(h.inputSchema)}`).join('\n')
        : `No MCP tool matched ${JSON.stringify((findArgs && findArgs.query) || '')}. Try a broader keyword, or omit "server".`;
    };

    // Example runs independent read-only / agent calls concurrently in waves,
    // while keeping mutating calls strictly ordered between waves.
    const PARALLEL_SAFE = new Set([
      'Read', 'Glob', 'Grep', 'LS', 'Search', 'ListDir', 'ListFiles',
      'WebFetch', 'WebSearch', 'TodoWrite', 'TaskList', 'TaskGet', 'CronList',
      'ListMcpResources', 'find_mcp_tools', 'ToolSearch', 'list_skills', 'Skill',
      'ListAgents', 'ListCustomTools', 'list_notebooks', 'list_slash_commands', 'memory_list',
    ]);
    // Claude Code runs several Task/Agent blocks from one message concurrently;
    // bounded so a model that emits ten delegations cannot open ten streams at once.
    const PARALLEL_AGENT = new Set(['Task', 'Agent']);
    const isWaveParallel = (tc) => {
      const nm = tc && tc.function && tc.function.name;
      return PARALLEL_SAFE.has(nm) || PARALLEL_AGENT.has(nm);
    };
    const partitionToolWaves = (list) => {
      const waves = [];
      let i = 0;
      while (i < list.length) {
        if (isWaveParallel(list[i])) {
          let j = i + 1;
          while (j < list.length && isWaveParallel(list[j])) j++;
          if (j - i >= 2) {
            waves.push({ parallel: true, items: list.slice(i, j) });
            i = j;
            continue;
          }
        }
        waves.push({ parallel: false, items: [list[i]] });
        i++;
      }
      return waves;
    };

    const pendingImages = [];
    const waves = (!textCalls && calls.length > 1)
      ? partitionToolWaves(calls)
      : calls.map((tc) => ({ parallel: false, items: [tc] }));
    const agentCap = Math.max(1, Number(process.env.AKRON_MAX_PARALLEL_AGENTS) || 4);
    let agentsRunning = 0;
    const agentWaiters = [];
    const agentSlot = async () => {
      if (agentsRunning < agentCap) { agentsRunning++; return; }
      await new Promise((r) => agentWaiters.push(r));
      agentsRunning++;
    };
    const agentFree = () => { agentsRunning--; const w = agentWaiters.shift(); if (w) w(); };

    async function runOneParallel(p) {
      try {
        if (isLocal(p.name)) {
          const out = await localTools[p.name](p.args || {});
          return { content: typeof out === 'string' ? out : String(out), isError: false };
        }
        if (p.name === 'find_mcp_tools' && extraToolsDeferred) {
          return { content: runFindMcpTools(p.args), isError: false };
        }
        if (toolAllow && !isAllowed(p.name)) return { content: `Tool "${p.name}" is not available to this sub-agent.`, isError: true };
        const pre = await beforeTool(p.name, p.args);
        if (pre.blocked) return { content: pre.planGate ? pre.reason : `Blocked by hook: ${pre.reason}`, isError: true };
        const r = await runTool(p.name, pre.args, ctx);
        const content = typeof r === 'string' ? r : r.content;
        const imageDataUrl = (r && typeof r === 'object' && r.imageDataUrl) ? r.imageDataUrl : null;
        const isErr = (typeof r === 'object' && Boolean(r.isError))
          || /^(Error|Tool error)/i.test(String(content).trim());
        return { content: await afterTool(p.name, pre.args, String(content), isErr), isError: isErr, imageDataUrl };
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw e;
        return { content: 'Error: ' + (e && e.message ? e.message : String(e)), isError: true };
      }
    }

    async function runOneSequential(tc) {
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      if (pauseCtrl) await pauseCtrl.waitIfPaused(opts.signal);
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      const name = tc.function.name;
      let args = parseArgs(tc.function.arguments);
      emit({ type: 'tool', id: tc.id, name, args });

      // Loop detection: identical tool + identical args repeated back-to-back.
      let sig;
      try { sig = name + '|' + JSON.stringify(args); } catch { sig = name + '|?'; }
      if (sig === lastSig) repeatCount++; else { lastSig = sig; repeatCount = 1; }

      let result;
      let isError = false;
      let imageDataUrl = null;
      // Host-local tools (swarm board) run in-process: no hooks, no shell, no
      // MCP round trip. They are pure memory operations on the board object.
      if (isLocal(name)) {
        try {
          const out = await localTools[name](args || {});
          result = typeof out === 'string' ? out : String(out);
        } catch (e) {
          result = 'Error: ' + (e && e.message ? e.message : String(e));
          isError = true;
        }
        emit({ type: 'toolResult', id: tc.id, name, result: String(result), isError });
        if (textCalls) messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${result}` });
        else messages.push({ role: 'tool', tool_call_id: tc.id, name, content: String(result) });
        return;
      }
      // A sub-agent definition's `tools:` list is a hard allowlist — a model that
      // tries a tool it was not granted gets a clear refusal, not a silent no-op.
      if (toolAllow && !isAllowed(name)) {
        result = `Tool "${name}" is not available to this sub-agent (its definition restricts tools).`;
        isError = true;
        emit({ type: 'toolResult', id: tc.id, name, result, isError });
        if (textCalls) messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${result}` });
        else messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result });
        return;
      }
      // Example's PreToolUse hook can veto or rewrite the call before it runs.
      const pre = await beforeTool(name, args);
      if (pre.blocked) {
        result = pre.planGate ? pre.reason : `Blocked by hook: ${pre.reason}`;
        isError = true;
        emit({ type: 'toolResult', id: tc.id, name, result, isError });
        if (textCalls) messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${result}` });
        else messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result });
        return;
      }
      args = pre.args;
      // Record the pre-change state of any file this mutating tool will touch.
      if (WRITE_TOOLS.has(name)) takeCheckpoint(name, args);
      // Route virtual mcp__* names (built-in equivalents) to runTool first;
      // only unknown mcp__* (external MCP servers) go to callMcpTool.
      // Any executor may throw (an MCP server error, a child provider failure,
      // a bug in a handler). That is a tool result the model can react to —
      // never the end of the user's turn.
      try {
        if (name === 'find_mcp_tools' && extraToolsDeferred) {
          result = runFindMcpTools(args);
        } else if (name.startsWith('mcp__') && !localToolNames.has(name)) {
          if (!opts.callMcpTool) {
            result = `MCP tool ${name} unavailable`;
            isError = true;
          } else {
            let to = null;
            const r = await Promise.race([
              Promise.resolve(opts.callMcpTool(name, args)),
              new Promise((resolve) => { to = setTimeout(() => resolve({ content: `Tool error: ${name} did not respond within 300s and was abandoned.`, isError: true }), 300000); }),
            ]).finally(() => clearTimeout(to));
            if (r && typeof r === 'object' && !Array.isArray(r) && 'content' in r && typeof r.content === 'string') {
              result = r.content;
              isError = !!r.isError;
            } else {
              result = typeof r === 'string' ? r : JSON.stringify(r);
              if (r && typeof r === 'object' && r.isError) isError = true;
            }
          }
        } else {
          const r = await runTool(name, args, { ...ctx, currentToolId: tc.id });
          result = typeof r === 'string' ? r : r.content;
          isError = typeof r === 'object' && Boolean(r.isError);
          if (r && typeof r === 'object' && r.imageDataUrl) imageDataUrl = r.imageDataUrl;
        }
      } catch (e) {
        if (opts.signal && opts.signal.aborted) throw e;
        result = 'Tool error: ' + (e && e.message ? e.message : String(e));
        isError = true;
      }
      const resultStr = String(result);
      if (!isError && /^(Error|Tool error)/i.test(resultStr.trim())) isError = true;
      if (WRITE_TOOLS.has(name) && !/^(Error|Tool error)/i.test(resultStr.trim())) {
        wroteSomething = true;
        // Surface the deliverable the moment it lands on disk: the browser pane
        // opens on the page so "it works" is visible, not just claimed.
        const rawPath = args.path || args.file_path || args.filePath || args.filename;
        if (rawPath && /\.(html?|svg)$/i.test(String(rawPath))) {
          try {
            const abs = path.isAbsolute(String(rawPath)) ? String(rawPath) : path.resolve(currentCwd || process.cwd(), String(rawPath));
            if (abs !== lastPreview && fs.existsSync(abs)) { lastPreview = abs; emit({ type: 'preview', url: abs }); }
          } catch (_) {}
        }
      }

      // Steer out of a loop instead of letting it eat the whole step budget.
      // Two identical calls in a row already means the retry strategy is broken.
      if (repeatCount >= 2 && nudges < 5) {
        nudges++;
        const hint = name === 'Bash'
          ? 'You are repeating the exact same shell command. Do not retry it unchanged — inspect the error, then use a different approach (e.g. Write for files).'
          : WRITE_TOOLS.has(name)
            ? 'You are repeating the exact same file call. Check the error text: Write needs {"path","content"} with the COMPLETE file; Edit needs old_string copied exactly via Read. Do not switch to bash heredocs.'
            : 'You are repeating the exact same tool call. Stop and change your approach.';
        result = resultStr + `\n\n[SYSTEM NOTE: ${hint}]`;
      }

      emit({ type: 'toolResult', id: tc.id, name, result: String(result), isError });
      if (name === 'ExitPlanMode' || name === 'AskUserQuestion') planEnded = true;
      if (imageDataUrl && !isError && !textToolMode) {
        pendingImages.push({ name, summary: String(result).slice(0, 200), imageDataUrl });
      }
      if (textCalls) {
        messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${await afterTool(name, args, result, isError)}` });
      } else {
        messages.push({ role: 'tool', tool_call_id: tc.id, name, content: await afterTool(name, args, result, isError) });
      }
    }

    for (const wave of waves) {
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      if (pauseCtrl) await pauseCtrl.waitIfPaused(opts.signal);
      if (opts.signal && opts.signal.aborted) throw new Error('aborted');
      if (wave.parallel) {
        const batch = wave.items.map((tc) => ({ tc, name: tc.function.name, args: parseArgs(tc.function.arguments) }));
        batch.forEach((p) => emit({ type: 'tool', id: p.tc.id, name: p.name, args: p.args }));
        let waveSig;
        try { waveSig = 'WAVE|' + JSON.stringify(batch.map((b) => [b.name, b.args])); } catch { waveSig = 'WAVE|?'; }
        if (waveSig === lastSig) repeatCount++; else { lastSig = waveSig; repeatCount = 1; }
        const results = await Promise.all(batch.map(async (p) => {
          const isAgent = PARALLEL_AGENT.has(p.name);
          if (isAgent) await agentSlot();
          try { return await runOneParallel(p); } finally { if (isAgent) agentFree(); }
        }));
        if (opts.signal && opts.signal.aborted) throw new Error('aborted');
        batch.forEach((p, i) => {
          let content = results[i].content;
          if (repeatCount >= 2 && nudges < 5 && i === batch.length - 1) {
            nudges++;
            content += '\n\n[SYSTEM NOTE: You repeated the exact same parallel batch of calls. Use the results you already received or change approach.]';
          }
          emit({ type: 'toolResult', id: p.tc.id, name: p.name, result: content, isError: results[i].isError });
          if (results[i].imageDataUrl && !results[i].isError && !textToolMode) {
            pendingImages.push({ name: p.name, summary: String(content).slice(0, 200), imageDataUrl: results[i].imageDataUrl });
          }
          messages.push({ role: 'tool', tool_call_id: p.tc.id, name: p.name, content });
        });
      } else {
        await runOneSequential(wave.items[0]);
      }
    }
    if (pendingImages.length && !textToolMode) {
      messages.push({
        role: 'user',
        _syntheticImageRead: true,
        content: [
          { type: 'text', text: pendingImages.map((x) => `[Image loaded via ${x.name}: ${x.summary}]`).join('\n') },
          ...pendingImages.map((x) => ({ type: 'image_url', image_url: { url: x.imageDataUrl } })),
        ],
      });
    }
  }

  // Reached only when the runaway guard trips — the model kept calling tools for
  // 1000 turns without producing a final answer. Say so instead of ending the
  // turn silently, and leave the partial transcript intact so "continue" works.
  const stopNote = `(Paused after ${maxSteps} tool turns — that is the runaway safety valve, not a step limit. Say "continue" and I'll carry on from here.)`;
  messages.push({ role: 'assistant', content: stopNote });
  emit({ type: 'delta', text: '\n\n' + stopNote });
  emit({ type: 'limit', steps: maxSteps });
  emit({ type: 'done', messages, stopped: true, usage: { ...usageTotals } });
  return messages;
}

// ── One-shot completion ────────────────────────────────────────────────────
// The primitive behind `/compact`, `/btw`, `/recap` and `/advisor`: same request
// path (and retry/failover behaviour) as a full run, but it returns the finished
// text instead of streaming events into a transcript.
async function chatOnce({ provider, messages, maxTokens, signal, tools }) {
  const p = normalizeProvider(provider || {});
  let streamed = '';
  const msg = await chatWithFailover({
    list: [p],
    getIndex: () => 0,
    setIndex: () => {},
    messages,
    tools,
    signal,
    maxTokens: maxTokens != null ? maxTokens : p.maxTokens,
    onDelta: (t, thinking) => { if (!thinking) streamed += t; },
    emit: () => {},
  });
  const content = msg && typeof msg.content === 'string' && msg.content ? msg.content : streamed;
  return { content: String(content || ''), usage: (msg && msg.usage) || null, model: p.model };
}

function createPauseController() {
  let paused = false;
  const waiters = new Set();
  const steeringQueue = [];
  const flushWaiters = () => {
    for (const w of waiters) {
      waiters.delete(w);
      try { w.resolve(); } catch (_) {}
    }
  };
  return {
    isPaused: () => paused,
    pause() {
      paused = true;
      return true;
    },
    resume(steeringNote) {
      const note = String(steeringNote || '').trim();
      if (note) steeringQueue.push(note);
      paused = false;
      flushWaiters();
      return true;
    },
    drainSteering() {
      return steeringQueue.splice(0, steeringQueue.length);
    },
    waitIfPaused(signal) {
      if (signal && signal.aborted) return Promise.reject(new Error('aborted'));
      if (!paused) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const entry = {
          resolve: () => {
            if (signal) { try { signal.removeEventListener('abort', onAbort); } catch (_) {} }
            resolve();
          },
        };
        const onAbort = () => {
          waiters.delete(entry);
          paused = false;
          reject(new Error('aborted'));
        };
        waiters.add(entry);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      });
    },
  };
}

module.exports = { runAgent, createPauseController, normalizeProvider, chatOnce, chatWithFailover, SYSTEM_PROMPT, parseTextToolCalls, TEXT_TOOL_PROTOCOL, parseArgs, autoCaptureArtifacts, sanitizeHistory, chunkText, humanizeLLMError, isRateLimitError, isContextOverflow, isCreditExhausted };
