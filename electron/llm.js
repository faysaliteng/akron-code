'use strict';
const fs = require('fs');
const path = require('path');
const { toolDefinitions, runTool } = require('./tools');
const swarm = require('./swarm');
const hooks = require('./hooks');
const budgetPool = require('./budget');
const modelCatalog = require('./model-catalog');
const providertransport = require('./providertransport');

// Registry of live sub-agents (for TaskStop / ListAgents).
const subagentControllers = new Map(); // name -> AbortController

// Names of tools handled locally (built-in + virtual MCP namespaces). Anything
// else that starts with mcp__ is an external MCP server tool.
const localToolNames = new Set(toolDefinitions.map((t) => t.name));

const SYSTEM_PROMPT = `You are Akron Bot, an agentic desktop coding assistant running on the user's Mac (a local alternative to the Example desktop app). You work inside the user's project folder and you actually create, edit, and run code. You do not just describe code — you build it.

## Working style
- Be concise. Do the work with tools; narrate only the key steps.
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
- Browser tools (browser_open / browser_navigate / browser_snapshot / browser_click / browser_type / browser_screenshot / browser_tabs) for web tasks the user can watch.
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
function parseTextToolCalls(text) {
  if (!text || typeof text !== 'string') return [];
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
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = {}; } }
    if (!args || typeof args !== 'object') args = {};
    seq++;
    out.push({ id: 'txt_' + seq + '_' + Math.random().toString(36).slice(2, 7), type: 'function', function: { name, arguments: JSON.stringify(args) } });
  };
  const fence = /```[ \t]*(?:tool|tool_use|json)?[ \t]*\r?\n([\s\S]*?)```/g;
  let m;
  while ((m = fence.exec(text))) {
    const body = m[1].trim();
    if (/"(?:name|tool)"\s*:/.test(body)) push(body);
  }
  const tag = /<tool_use>([\s\S]*?)<\/tool_use>/g;
  while ((m = tag.exec(text))) push(m[1].trim());
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
  };
}

async function chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride) {
  // Delegating to a wire adapter keeps one stream contract for the agent loop:
  // the adapter returns the same {content, tool_calls, finish_reason, usage}
  // shape the OpenAI-compatible path does, so failover and parsing are unchanged.
  if (providertransport.needsTransport(provider)) {
    return providertransport.chatCompletion(provider, messages, tools, onDelta, signal, maxTokensOverride);
  }
  const url = provider.baseURL + 'chat/completions';
  const body = {
    model: provider.model,
    messages,
    temperature: provider.temperature,
    max_tokens: maxTokensOverride != null ? maxTokensOverride : provider.maxTokens,
    stream: true,
  };
  if (tools && tools.length) body.tools = tools;
  // Reasoning effort — OpenAI-style. Only send when the user picked a level; keep
  // 'auto' out of the payload so every provider behaves as before by default.
  if (provider.reasoningLevel && provider.reasoningLevel !== 'auto') {
    body.reasoning_effort = provider.reasoningLevel;
  }
  const headers = { 'content-type': 'application/json' };
  if (provider.apiKey) headers['authorization'] = 'Bearer ' + provider.apiKey;

  const doFetch = (payload) => fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
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
    let changed = false;
    if (req.reasoning_effort) {
      delete req.reasoning_effort;
      changed = true;
    } else if (req.max_tokens && /max_tokens|max_completion_tokens|maximum|too large|exceed/i.test(rejectedText)) {
      const next = Math.floor(Number(req.max_tokens) / 2);
      if (next >= 1024) { req.max_tokens = next; changed = true; }
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
    return Object.assign({ content: '', tool_calls: [] }, msg, {
      finish_reason: data.choices && data.choices[0] && data.choices[0].finish_reason,
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
        // Keep whatever the model already emitted; only a totally silent stall
        // is worth retrying from scratch.
        if (message.content || message.tool_calls.length) {
          message.stalled = true;
          return { done: true, value: undefined };
        }
        try { reader.cancel(); } catch (_) {}
        throw e;
      });
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
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
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index != null ? tc.index : toolAcc.size;
          let acc = toolAcc.get(idx);
          if (!acc) {
            acc = { id: tc.id || '', type: 'function', function: { name: '', arguments: '' } };
            toolAcc.set(idx, acc);
            message.tool_calls.push(acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function) {
            if (tc.function.name) acc.function.name += tc.function.name;
            const a = tc.function.arguments;
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
        }
      }
    }
  }
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
  if (body.length > 200) body = body.slice(0, 197).trimEnd() + '…';
  const head = friendly || (status ? `The provider returned HTTP ${status}` : raw.split('\n')[0].slice(0, 120));
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
  const tools = opts.tools;
  const messages = opts.messages;
  const signal = opts.signal;
  const maxTokens = opts.maxTokens;
  const n = list.length;
  // Rate limits (HTTP 429 / "too many requests") are TRANSIENT. Previously a
  // single-provider setup threw immediately and the whole run died with a red
  // banner mid-task. Now: try every provider once per round, then back off and
  // retry the whole set — so a burst of tool-call round-trips survives 429s.
  const MAX_ROUNDS = 5;
  const BACKOFF = [2000, 5000, 10000, 20000]; // wait before round 2..5
  let lastErr = null;
  let waits = 0; // so repeated back-offs read as a list, not one glued run-on
  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (signal && signal.aborted) throw new Error('aborted');
    const start = opts.getIndex();
    let rateLimited = false;
    for (let a = 0; a < n; a++) {
      const i = (start + a) % n;
      const p = list[i];
      try {
        return await chatCompletion(p, messages, tools, onDelta, signal, maxTokens);
      } catch (e) {
        if (signal && signal.aborted) throw e;
        // An oversized prompt is not transient: re-sending the identical history
        // five times only stalls for ~37 s and then blames the provider. Hand it
        // back to the agent loop, which compacts or chunks the input.
        if (isContextOverflow(e)) throw e;
        if (isRateLimitError(e)) {
          lastErr = e;
          rateLimited = true;
          if (n > 1 && a < n - 1) {
            const next = (i + 1) % n;
            opts.setIndex(next);
            emit({ type: 'orchestrator', from: p.model || p.baseURL, to: list[next].model || list[next].baseURL, reason: humanizeLLMError(e).slice(0, 200) });
            continue;
          }
          break; // last provider this round — fall through to backoff
        }
        throw e;
      }
    }
    if (!rateLimited) throw (lastErr || new Error('All providers failed.'));
    if (round < MAX_ROUNDS - 1) {
      // HELIO_BACKOFF_MS pins the delay (tests + impatient operators) without
      // changing the production ladder.
      const envDelay = Number(process.env.HELIO_BACKOFF_MS);
      const base = Number.isFinite(envDelay) ? envDelay : (BACKOFF[round] != null ? BACKOFF[round] : 20000);
      const wait = Math.min(Math.max(base, (lastErr && lastErr.retryAfterMs) || 0), 45000);
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
    // user (or anything unknown)
    out.push({ role: 'user', content: str(m.content) });
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
        .filter((m) => m.role !== 'system')
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
    providerList = orch.providers.map((p) => normalizeProvider({
      baseURL: p.baseURL, apiKey: p.apiKey, model: p.model,
      temperature: p.temperature, maxTokens: p.maxTokens, reasoningLevel: p.reasoningLevel,
      transport: p.transport, oauth: p.oauth, accessToken: p.accessToken,
      account: p.account, accountId: p.accountId, sessionId: p.sessionId,
      codexUrl: p.codexUrl, cloudcodeUrl: p.cloudcodeUrl, project: p.project,
      oauthProvider: p.oauthProvider,
    }));
    activeIndex = Math.max(0, Math.min(Number(orch.activeIndex) || 0, providerList.length - 1));
  }
  const getIndex = () => activeIndex % providerList.length;
  const setIndex = (i) => { activeIndex = i % providerList.length; };
  const provider = providerList[getIndex()];

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
  const isAllowed = (name) => {
    // Swarm is an explicit user opt-in. When it is off, the tool is never
    // advertised to the model (multi-agent Task/Agent remains available).
    if (name === 'Swarm' && opts.swarm !== true) return false;
    if (!toolAllow) return true;
    if (toolAllow.has(name) || toolAllow.has('*')) return true;
    if (name.startsWith('mcp__') && (toolAllow.has('mcp') || toolAllow.has('mcp__*'))) return true;
    return false;
  };
  let tools = toolDefinitions.filter((t) => isAllowed(t.name)).map((t) => ({ type: 'function', function: t }));
  const extra = opts.extraTools || [];
  for (const t of extra) {
    if (!isAllowed(t.name)) continue;
    tools.push({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } } });
  }

  // Always ensure the core system prompt is the first message. The renderer may
  // send its own system message (style / project / web-search directives); that
  // stays as a second system message, but the core Akron Bot guidance (tool use,
  // browser, artifact/visualization instructions) must be present for EVERY
  // model — Gemini/Gemma via Ollama, Kimi, DeepSeek, Nemotron, etc.
  const corePrompt = messages.find((m) => m.role === 'system' && m.content === SYSTEM_PROMPT);
  if (!corePrompt) {
    messages.unshift({ role: 'system', content: SYSTEM_PROMPT });
  } else if (messages[0] !== corePrompt) {
    // Move the core prompt to the front if a renderer system message precedes it.
    const i = messages.indexOf(corePrompt);
    messages.splice(i, 1);
    messages.unshift(corePrompt);
  }

  // Fold the renderer's extra system messages (style / project / reasoning
  // directives) INTO the core prompt. Some gateways reject or silently ignore a
  // second system message, which made "be a coding agent" guidance disappear on
  // exactly the models that needed it most.
  for (let i = messages.length - 1; i >= 1; i--) {
    if (messages[i].role === 'system') {
      const extra = String(messages[i].content || '').trim();
      if (extra) messages[0].content += '\n\n' + extra;
      messages.splice(i, 1);
    }
  }

  // Inject the project working directory so every model (Gemma4, Kimi, DeepSeek,
  // Nemotron, …) writes files into the SAME conversation project folder instead
  // of an arbitrary location — Claude Desktop per-project parity.
  if (currentCwd) {
    messages[0].content += `\n\n<project_workspace>\nYour project working directory is: ${currentCwd}\nCreate and edit files in this folder by default (prefer relative paths). Run shell commands in this folder unless the user specifies another location. When the user asks for code or a file, write it here.\n</project_workspace>`;
  }

  // Inject the per-project mindmap so a model switch (gemma4 → Kimi → DeepSeek →
  // Nemotron → TokenRouter) picks up the SAME project state — goal, progress,
  // decisions, and files — without any shared provider state. Claude Desktop
  // continuity parity: switching models mid-conversation keeps full context.
  try {
    const { read: readMindmap } = require('./mindmap');
    const mm = readMindmap(currentCwd);
    if (mm) messages[0].content += `\n\n<project_mindmap>\n${mm}\n</project_mindmap>`;
  } catch (_) {}

  // CLAUDE.md project memory hierarchy (global → ancestors → cwd → local),
  // including @import expansion. This is what a project already checked into a
  // Example repo carries, so its standing instructions apply here too.
  try {
    const memory = require('./memory');
    const memText = memory.loadMemoryText(currentCwd);
    if (memText) messages[0].content += `\n\n<project_memory>\n${memText}\n</project_memory>`;
  } catch (_) {}

  // Optionally inject memory into system prompt
  const { memoryAsText } = require('./store');
  if (opts.useMemory !== false) {
    const mem = memoryAsText();
    if (mem !== '(no saved memory)') {
      messages[0].content += `\n\n<long_term_memory>\n${mem}\n</long_term_memory>`;
    }
  }

  // Custom output style (settings.outputStyle → ~/.claude/output-styles/<name>.md)
  // and statusline config live in settings; the output style body is appended to
  // the system prompt exactly like Claude Code does.
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

  // Sub-agent definitions the model can dispatch to via `subagent_type`.
  try {
    const agentdefs = require('./agentdefs');
    const defs = agentdefs.discover(currentCwd, { fresh: true });
    if (defs.length) {
      const roster = defs.map((d) => `- ${d.name}${d.model ? ` (model: ${d.model})` : ''}: ${d.description}`).join('\n');
      messages[0].content += `\n\n<subagent_types>\nWhen calling Task or Agent you may set subagent_type to one of these to run it with that definition (prompt + tool restrictions + model):\n${roster}\n</subagent_types>`;
    }
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
  const knownToolNames = new Set(tools.map((t) => t.function.name));
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
        ck.snapshotFile(opts.convId, opts.turnId || 'turn', abs);
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
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, calls: 0, model: provider.model };
  const addUsage = (u) => {
    if (!u || typeof u !== 'object') return;
    const pin = Number(u.prompt_tokens != null ? u.prompt_tokens : u.input_tokens);
    const pout = Number(u.completion_tokens != null ? u.completion_tokens : u.output_tokens);
    const ptotal = Number(u.total_tokens);
    if (Number.isFinite(pin) && pin > 0) usageTotals.prompt_tokens += pin;
    if (Number.isFinite(pout) && pout > 0) usageTotals.completion_tokens += pout;
    usageTotals.total_tokens += (Number.isFinite(ptotal) && ptotal > 0
      ? ptotal
      : (Number.isFinite(pin) ? pin : 0) + (Number.isFinite(pout) ? pout : 0));
    usageTotals.calls++;
    emit({ type: 'usage', usage: { ...usageTotals }, model: provider.model });
  };

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal && opts.signal.aborted) throw new Error('aborted');
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
      return chatWithFailover({
        list: providerList,
        getIndex,
        setIndex,
        messages,
        tools: withTools ? tools : undefined,
        onDelta: (text, thinking) => {
          if (thinking) turnThink += text.length; else turnChars += text.length;
          emit({ type: thinking ? 'thinking' : 'delta', text });
        },
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
        return m;
      });
    };
    // One chat round with automatic recovery for an oversized prompt. Providers
    // report "prompt is too long" / "context length exceeded" in prose, not as a
    // distinct status, so isContextOverflow() classifies it; we compact further
    // (or trim the biggest result) and resend instead of dying mid-task.
    const chatRound = async (withTools, maxTokens) => {
      let tries = 0;
      for (;;) {
        try {
          return await doChat(withTools, maxTokens);
        } catch (e) {
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
      message = await chatRound(toolMode);
    } catch (e) {
      if (toolMode && !isContextOverflow(e) && /tool|function|400|422|unknown/i.test(String(e.message)) && !/max_tokens|max_completion_tokens/i.test(String(e.message))) {
        // provider doesn't support tools — fall back to plain chat + text protocol
        toolMode = false;
        if (!textToolMode) {
          textToolMode = true;
          // Re-normalize the history (earlier steps may already contain native
          // tool_calls / role:"tool" entries that this endpoint would reject).
          messages = sanitizeHistory(messages, { supportsTools: false, maxChars: historyBudget });
          if (messages[0] && messages[0].role === 'system') messages[0].content += '\n\n' + TEXT_TOOL_PROTOCOL;
        }
        message = await chatRound(false);
      } else {
        throw e;
      }
    }

    // Reasoning models (Kimi K3.1 Pro, DeepSeek V4.1 Flash) burn the token budget
    // on chain-of-thought BEFORE emitting the code/tool calls. When the stream is
    // cut at the token limit (finish_reason "length") the website/code silently
    // never appears — either no tool calls at all, or a call whose JSON arguments
    // were sliced mid-string. Escalate the output budget; if the answer is STILL
    // cut, continue it in place so a long file or explanation finishes instead of
    // stopping at "…" (this is the Claude-app behaviour).
    if (message && message.finish_reason === 'length') {
      const broken = (list) => (list || []).some((tc) => {
        const raw = tc.function && tc.function.arguments;
        if (!raw || !String(raw).trim()) return false; // no-arg tools are legal
        try { JSON.parse(String(raw)); return false; } catch { return true; }
      });
      let cutCalls = message.tool_calls || [];
      if (!cutCalls.length || broken(cutCalls)) {
        const base = provider.maxTokens || 16384;
        // Never exceed the room the window reserved for output, but never ask for
        // less than we already did either.
        const ceiling = Math.max(base, Math.min(65536, Math.max(8192, modelBudget.reserveOut * 2)));
        const bumped = Math.min(Math.max(base * 2, base + 4096), ceiling);
        // Tell the UI to drop the cut-off attempt before the retry streams, then
        // show what is happening (no silent re-generation).
        emit({ type: 'retry', chars: turnChars, thinkingChars: turnThink });
        emit({ type: 'thinking', text: ' (the reply reached the output limit — regenerating with a larger budget)' });
        message = await chatRound(toolMode, bumped);
        cutCalls = message.tool_calls || [];
        // A complete tool call wins. Otherwise merge continuation passes so the
        // user gets the whole answer rather than a truncated one.
        let part = 1;
        while (message && message.finish_reason === 'length' && !(cutCalls.length && !broken(cutCalls)) && part <= 3) {
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
    if (!calls.length && textToolMode) {
      const parsed = parseTextToolCalls(message.content || '').filter((c) => knownToolNames.has(c.function.name));
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
          if (v.additionalContext) messages.push({ role: 'user', content: `[hook] ${v.additionalContext}` });
          if (v.additionalContext) continue;
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
    const agentRoster = swarm.buildRoster({ orchestrator: orch, provider: providerList[getIndex()] });
    const runSubagent = async (args) => {
      const name = args.description || args.name || 'sub-agent';
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (opts.signal) {
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      // A delegated task may pin a sub-agent DEFINITION (`subagent_type`), which
      // carries its own system prompt, tool allowlist, and model — Example's
      // `.claude/agents/*.md` contract.
      let def = null;
      if (args.subagent_type || args.agent_type || args.type) {
        try {
          const agentdefs = require('./agentdefs');
          def = agentdefs.resolve(args.subagent_type || args.agent_type || args.type, currentCwd);
          if (!def) {
            // Unknown type: fall back to general-purpose but tell the caller.
            def = agentdefs.BUILTIN['general-purpose'];
          }
        } catch (_) {}
      }
      // A delegated task may name the model it needs, or just its complexity
      // tier. Example lets a subagent definition pin `model: sonnet|opus|haiku`;
      // here the same idea maps onto the configured provider pool so cheap work
      // runs on a cheap model and hard work lands on the frontier model.
      const defModel = def && def.model ? def.model : null;
      const wantModel = args.model || args.model_id || defModel || null;
      const wantTier = args.tier || args.complexity || null;
      const pinned = Boolean(wantModel || wantTier);
      let subProvider = providerList[getIndex()];
      let tier = null;
      if (pinned) {
        const base = swarm.pickProvider(agentRoster, wantTier || 'heavy') || subProvider;
        subProvider = wantModel ? { ...base, model: String(wantModel) } : { ...base };
        tier = base.tier || swarm.normalizeTier(wantTier, 'heavy');
      }
      // Tool allowlist from the definition, or read-only enforcement for the
      // built-in Explore/Plan types even when they were not explicitly resolved.
      let toolAllow = null;
      if (def) {
        try { toolAllow = require('./agentdefs').allowedToolSet(def); } catch (_) { toolAllow = null; }
      }
      const defPrompt = def && def.body ? require('./agentdefs').promptFor(def) : null;
      subagentControllers.set(name, { controller: ac, status: 'running', started: Date.now(), model: subProvider && subProvider.model, tier, subagentType: def && def.name });
      emit({ type: 'subagent', id: name, name, status: 'started', role: 'worker', model: subProvider ? subProvider.model : null, tier, subagentType: def && def.name });
      try {
        const userPrompt = args.prompt || args.description || '';
        const subMsgs = defPrompt
          ? [{ role: 'system', content: defPrompt }, { role: 'user', content: userPrompt }]
          : [{ role: 'user', content: userPrompt }];
        const subResult = await runAgent({
          provider: subProvider,
          // A pinned provider must not be replaced by the parent's failover list.
          orchestrator: pinned ? null : opts.orchestrator,
          messages: subMsgs,
          cwd: args.cwd || currentCwd,
          emit: (evt) => emit({ ...evt, subagent: name }),
          maxSteps: opts.subagentMaxSteps || 0,
          useMemory: opts.useMemory,
          callMcpTool: opts.callMcpTool,
          askUser: opts.askUser,
          exitPlanMode: opts.exitPlanMode,
          mcpListResources: opts.mcpListResources,
          mcpReadResource: opts.mcpReadResource,
          approveTool: opts.approveTool,
          shell: opts.shell,
          extraTools: opts.extraTools,
          signal: ac.signal,
          toolAllow,
          // A delegated agent inherits plan mode: Example's Explore phase runs
          // read-only sub-agents, so they must not be able to write source.
          permissionMode,
          convId: opts.convId,
          turnId: opts.turnId,
        });
        const last = [...subResult].reverse().find((m) => m.role === 'assistant' && m.content);
        return last ? last.content : '(sub-agent completed)';
      } finally {
        subagentControllers.delete(name);
        emit({ type: 'subagent', id: name, name, status: 'done', role: 'worker', model: subProvider ? subProvider.model : null, tier });
        if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      }
    };

    const listAgents = () => {
      const entries = [...subagentControllers.entries()];
      if (!entries.length) return '(no agents running)';
      return 'RUNNING AGENTS:\n' + entries.map(([n, s]) => `- ${n} [${s.status}]${s.model ? ' · ' + s.model : ''}${s.tier ? ' · ' + s.tier : ''} (${Math.round((Date.now() - s.started) / 1000)}s)`).join('\n');
    };
    const stopTask = (name) => {
      const match = [...subagentControllers.entries()].find(([n]) => n === name || n.includes(name));
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
        askUser: opts.askUser,
        exitPlanMode: opts.exitPlanMode,
        mcpListResources: opts.mcpListResources,
        mcpReadResource: opts.mcpReadResource,
        approveTool: opts.approveTool,
        extraTools: opts.extraTools,
        permissionMode,
        ...subOpts,
      }),
      get provider() { return providerList[getIndex()]; },
      orchestrator: opts.orchestrator || null,
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
    };

    // Example runs independent read-only calls from the same turn concurrently
    // and shows all of the rows at once. Doing them one-by-one made a 4-file
    // read take 4 round trips of wall time and stacked rows progressively.
    const PARALLEL_SAFE = new Set(['Read', 'Glob', 'Grep', 'LS', 'Search', 'ListDir', 'ListFiles', 'WebFetch', 'WebSearch', 'TaskList', 'TaskGet', 'CronList', 'ListMcpResources']);
    if (!textCalls && calls.length > 1 && calls.every((tc) => PARALLEL_SAFE.has(tc.function.name))) {
      const batch = calls.map((tc) => ({ tc, name: tc.function.name, args: parseArgs(tc.function.arguments) }));
      batch.forEach((p) => emit({ type: 'tool', id: p.tc.id, name: p.name, args: p.args }));
      const results = await Promise.all(batch.map(async (p) => {
        try {
          if (toolAllow && !isAllowed(p.name)) return { content: `Tool "${p.name}" is not available to this sub-agent.`, isError: true };
          const pre = await beforeTool(p.name, p.args);
          if (pre.blocked) return { content: pre.planGate ? pre.reason : `Blocked by hook: ${pre.reason}`, isError: true };
          const r = await runTool(p.name, pre.args, ctx);
          const content = typeof r === 'string' ? r : r.content;
          const isErr = (typeof r === 'object' && Boolean(r.isError))
            || /^(Error|Tool error)/i.test(String(content).trim());
          return { content: await afterTool(p.name, pre.args, String(content), isErr), isError: isErr };
        } catch (e) {
          return { content: 'Error: ' + (e && e.message ? e.message : String(e)), isError: true };
        }
      }));
      batch.forEach((p, i) => {
        emit({ type: 'toolResult', id: p.tc.id, name: p.name, result: results[i].content, isError: results[i].isError });
        messages.push({ role: 'tool', tool_call_id: p.tc.id, name: p.name, content: results[i].content });
      });
      continue;
    }

    for (const tc of calls) {
      const name = tc.function.name;
      let args = parseArgs(tc.function.arguments);
      emit({ type: 'tool', id: tc.id, name, args });

      // Loop detection: identical tool + identical args repeated back-to-back.
      let sig;
      try { sig = name + '|' + JSON.stringify(args); } catch { sig = name + '|?'; }
      if (sig === lastSig) repeatCount++; else { lastSig = sig; repeatCount = 1; }

      let result;
      let isError = false;
      // A sub-agent definition's `tools:` list is a hard allowlist — a model that
      // tries a tool it was not granted gets a clear refusal, not a silent no-op.
      if (toolAllow && !isAllowed(name)) {
        result = `Tool "${name}" is not available to this sub-agent (its definition restricts tools).`;
        isError = true;
        emit({ type: 'toolResult', id: tc.id, name, result, isError });
        if (textCalls) messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${result}` });
        else messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result });
        continue;
      }
      // Example's PreToolUse hook can veto or rewrite the call before it runs.
      const pre = await beforeTool(name, args);
      if (pre.blocked) {
        result = pre.planGate ? pre.reason : `Blocked by hook: ${pre.reason}`;
        isError = true;
        emit({ type: 'toolResult', id: tc.id, name, result, isError });
        if (textCalls) messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${result}` });
        else messages.push({ role: 'tool', tool_call_id: tc.id, name, content: result });
        continue;
      }
      args = pre.args;
      // Record the pre-change state of any file this mutating tool will touch.
      if (WRITE_TOOLS.has(name)) takeCheckpoint(name, args);
      // Route virtual mcp__* names (built-in equivalents) to runTool first;
      // only unknown mcp__* (external MCP servers) go to callMcpTool.
      if (name.startsWith('mcp__') && !localToolNames.has(name)) {
        result = await opts.callMcpTool ? await opts.callMcpTool(name, args) : `MCP tool ${name} unavailable`;
      } else {
        const r = await runTool(name, args, ctx);
        result = typeof r === 'string' ? r : r.content;
        isError = typeof r === 'object' && Boolean(r.isError);
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
      if (textCalls) {
        messages.push({ role: 'user', content: `TOOL RESULT ${tc.id} (${name}):\n${await afterTool(name, args, result, isError)}` });
      } else {
        messages.push({ role: 'tool', tool_call_id: tc.id, name, content: await afterTool(name, args, result, isError) });
      }
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

module.exports = { runAgent, normalizeProvider, chatOnce, SYSTEM_PROMPT, parseTextToolCalls, TEXT_TOOL_PROTOCOL, parseArgs, autoCaptureArtifacts, sanitizeHistory, chunkText, humanizeLLMError, isRateLimitError, isContextOverflow };
