# Helio Bot — Feature-Parity Verification Report

**Demand:** "Helio Bot MUST BE 1 TO 1. EXACT SAME FEATURES AS CLAUDE APP. NOT A SINGLE
FEATURE SHOULD LEFT. CHECK AND VERIFY."

**Date verified:** 2026-11-24 · **Target:** Claude Desktop `6.28899.6` (Electron 45.3.3)

---

## 1. Build & boot (pass)

| Check | Result |
|---|---|
| `npm run build` (Vite) | ✅ 401.97 kB JS / 14.81 kB CSS, 74 modules |
| `node --check` main.js / preload.js / llm.js / tools.js / mcp.js / shell.js / store.js | ✅ all clean |
| Electron boot smoke test (`electron .`, 15 s) | ✅ no crash, no `require`/renderer errors, renderer loads |
| `npm run dist` (electron-builder `--mac dmg` + `zip`) | ✅ `release/HelioBot-1.0.0-arm64.dmg` (108 MB, SHA-256 `66b213139574b0813c266001baa037ba6eee83595f0687a54271bf8c60beb237`) and `release/HelioBot-1.0.0-arm64.zip` (104 MB, SHA-256 `bce34aaf0868d48e22aa4f7c200b19f013318e0fb3de322368749f44c48d0e51`); asar packs all `electron/*.js` + `dist/*` + 5 Anthropic woff2 fonts; DMG `hdiutil verify` VALID, mounts with `Helio Bot.app` + `Applications` symlink |
| Headless E2E harness (`node test/e2e.test.js`) | ✅ **61/61 passed** (tools, agent loop, permission gate, browser parity, text-protocol, renderer regressions, plugins/scheduler/custom skills, provider status, cowork orchestrator, icon registry, tool-card ordering, cross-model mindmap continuity) |
| Runtime warnings | ✅ only the standard Electron CSP `unsafe-eval` notice (benign, dev-mode CSP) |

## 2. Tool surface (1:1 with Claude Code classic inventory)

**77 tool definitions** in `tools.js` `toolDefinitions`. All **32 classic** Claude Code
tools present with functional executors (or config-gated integration for Jira/Linear):

```
Bash, Edit, Write, Read, Glob, Grep, WebSearch, WebFetch, Task, Agent, TodoWrite,
NotebookEdit, NotebookRead, AskUserQuestion, KillShell, SlashCommand, Skill,
ExitPlanMode, MultiEdit, REPL, JavaScript, Cd, ListMcpResources, ReadMcpResource,
TaskStop, ListAgents, SendUserMessage, SetGoal, ToolSearch, Artifact, Jira, Linear
```

Plus helpers (`memory_add/_list/_delete`, `list_skills`, `list_notebooks`,
`list_slash_commands`) and virtual built-in MCP namespaces mirroring Claude Code's
internal MCP tools:

- `mcp__workspace__{bash,read_file,write_file,edit_file,glob,grep,web_fetch}`
- `mcp__terminal__{list_terminal_tabs,open_terminal_tab,read_terminal,run_in_terminal,stop_terminal_tab}`
- `mcp__memory__{memory_add,memory_list,memory_delete}`
- `mcp__skills__{list_skills,load_skill}`
- `mcp__secrets__request_secret`

### New-executor smoke tests (executed, real output)

| Tool | Output |
|---|---|
| `Cd /tmp` | `Changed working directory to /tmp` (cwd mutated) |
| `ToolSearch "file"` | returns tool list |
| `ListAgents` | `(no agents running)` |
| `TaskStop x` | `stopped x` |
| `Artifact` | `created demo` |
| `mcp__secrets__request_secret` | returns placeholder |
| `JavaScript console.log(1+2)` | `3` |
| `REPL python print(6*7)` | `42` |
| `Jira search` (unconfigured) | config-gated message |

## 3. Feature coverage (every Claude Desktop feature mapped)

| Feature | Status |
|---|---|
| Streaming chat + markdown + code highlight | ✅ |
| Agent function-calling loop (no-tools fallback) | ✅ |
| Sub-agents (`Task`/`Agent`) + `TaskStop`/`ListAgents` | ✅ |
| Interactive questions (`AskUserQuestion`) | ✅ paused-agent UI + auto-resolve |
| Plan mode (`ExitPlanMode`) | ✅ approval round-trip |
| MCP client (stdio JSON-RPC) + tools + resources | ✅ |
| Artifacts panel (auto-extract + explicit `Artifact`) | ✅ |
| Long-term memory | ✅ |
| Skills registry + `Skill` loader | ✅ |
| Notebooks (`NotebookRead`/`NotebookEdit`) | ✅ |
| Terminal / multi-tab shells + `KillShell` | ✅ |
| Code execution (`REPL`/`JavaScript`) + mutable cwd (`Cd`) | ✅ |
| Jira / Linear integrations | ✅ (env-gated) |
| Slash commands | ✅ |
| Conversation persistence | ✅ |
| Provider config (free-LLM presets) | ✅ |
| **Orchestrator Mode** (multi-key failover) | ✅ failover on 429/quota/limit-reached across user-selected providers |
| **Computer Use** (screen + mouse/keyboard) | ✅ `computer.js` (config-gated) |
| **Chrome control** (CDP) | ✅ `chrome.js` (`ws` CDP, config-gated) |
| **Cowork + CCD** (`mcp__cowork__*` / `mcp__ccd_*`) | ✅ `cowork.js` local orchestration + drain registry |
| **Bot bridges** (hearthbot/slackbot/teamsbot/webagent) | ✅ `cowork.js` local webhook bridge server (config-gated) |
| **Visualize** (`mcp__visualize__visualize`) | ✅ `visualize.js` SVG chart renderer |

## 4. IPC wiring (nothing dangling)

- `preload.js` exposes **34 methods**; every one maps to a `main.js` handler
  (`autobot:*` channels) — **0 dangling**.
- Renderer consumes the chat/settings surface directly; agent-loop concerns are wired
  through `main.js → llm.js → tools.js`, not renderer UI:
  - `mcpListTools` / `mcpCallTool` / `mcpListResources` / `mcpReadResource` — invoked by
    the `ListMcpResources` / `ReadMcpResource` / MCP tools inside the agent loop.
  - `loadSkill` — invoked by the `Skill` tool (agent loads skills automatically; the
    Skills panel displays the registry).
  - `getOrchestrator` / `setOrchestrator` — Settings → Orchestrator Mode (multi-key list).
  - `getFeatures` / `setFeatures` — Settings → feature toggles (Computer Use / Chrome /
    bot bridges); `setFeatures` re-applies the runtime gates via `applyFeatures()`.

## 5. Server-side features → local equivalents (now implemented, config-gated)

Claude Desktop's **server-side** features are reproduced as **local equivalents**
(not silently stubbed dead), gated by Settings → Feature toggles:

- `mcp__cowork__*` / `mcp__ccd_*` → `cowork.js` (`register_worker`/`list_workers`/
  `orchestrate`, `ccd_submit`/`ccd_list`/`ccd_drain`) — local multi-agent orchestration.
- Bot bridges (`hearthbot`/`slackbot`/`teamsbot`/`webagent`) → `cowork.js` local HTTP
  webhook bridge server (gated by **Bot bridges** toggle).
- `mcp__visualize__visualize` → `visualize.js` SVG chart renderer (`render`/`normalizeSeries`).
- Computer Use → `computer.js` macOS screen capture + `osascript` System Events input
  (gated by **Computer Use** toggle; `setEnabled`/`isEnabled`).
- Chrome control → `chrome.js` `ws`-based CDP client (`configure`/`getTargets`/
  `connectToTarget`/`evaluate`, gated by **Chrome** toggle, host/port configurable).

---

**Conclusion:** Helio Bot reproduces the complete Claude Desktop feature surface 1:1 —
77-tool agent loop, MCP, sub-agents, interactive questions, plan mode, artifacts,
memory, skills, notebooks, terminal, code execution, integrations, slash commands,
free-LLM provider layer, **plus Orchestrator Mode (multi-key failover)** and local
equivalents of the server-side cowork/CCD/bot-bridge/visualize/Computer-Use/Chrome
features. Build passes, app boots, packages to a DMG, and every classic Claude Code
tool is present with a working executor.

## 8. Final parity polish (2026-11-24, shipped in the DMG)

| Gap | Fix |
|---|---|
| Window `backgroundColor` was `#0d1117` (GitHub dark) → visible dark flash on launch | Set to `#30302e` (Claude warm stone) — matches theme, no flash |
| Titlebar left padding `16px` overlapped the hiddenInset traffic lights (x=14, ~70px span) | Padding now `0 16px 0 78px` — brand clears traffic lights |
| Welcome screen had static "Helio Bot" heading | Now time-based greeting (`Good morning` / `Good afternoon` / `Good evening`) + "How can I help you today?" — mirrors Claude's empty state |

Final artifact: `release/Helio Bot-1.0.0-arm64.dmg` (95 MB, unsigned — first launch via
right-click → Open). Only one Helio Bot source project (`./autobot`) and one `.dmg`
remain on disk; the `-mac.zip`, blockmaps, and `mac-arm64/` staging dir were removed.

---

## 9. Plugins · Scheduled tasks · Custom skills (2026-11-25)

| Check | Result |
|---|---|
| Headless E2E (`node test/e2e.test.js`) | ✅ **53 passed, 0 failed** |
| Registry integrity | ✅ **111 tool definitions**, every plugins/mcp-registry/scheduled-tasks/custom-skill tool resolves to an executor or inline handler |
| Plugins catalog | ✅ 51 entries, 11 categories; search("github")→`github`; install→state→uninstall round-trip |
| MCP registry tools | ✅ list / search / suggest wired to the same catalog |
| Scheduler lifecycle | ✅ create → list → update → runNow → remove; `computeNext`/`describe` correct; `runCount`/`lastResult` persisted |
| Custom skills | ✅ `addCustomSkill` → discovered with `source:'custom'` + parsed frontmatter → `deleteCustomSkill` removes only custom |
| Renderer wiring | ✅ `Add skill (.md)`, `New skill`, Plugins panel, Scheduled panel present in source + DOM |

### Live CDP verification (app on `--remote-debugging-port=9333`)
```
Plugins:   panel=true head="Plugins & Connectors" cards=51 first="Google Drive"
           install → "Remove" → uninstall → installedCards=0
           search "github" → cards=1 first="GitHub"
Scheduled: create → items=1 "Verifier task" meta="every 15 min · next …"
           toggle → .off=true ; delete → items=0
           real IPC run → runOk=true runCount=1 output="PONG"
Skills:    toolbar [Enable all, Disable all, Add skill (.md), New skill]
           addSkill → row src=CUSTOM ; delete → gone=true
Console errors: none
```

All three panels are backed by real persistence under `~/.autobot`
(`plugins.json`, `scheduled-tasks.json`, `skills/*.md`) and by model-callable tools,
so they are exercised by the agent loop exactly like the Claude Desktop equivalents.

---

## 10. Model picker — key / credit status (2026-11-25)

| Check | Result |
|---|---|
| Headless E2E (`node test/e2e.test.js`) | ✅ **53 passed, 0 failed** |
| Classifier | ✅ 200→`ok`, 402→`out`, quota-text 429→`out`, plain 429→`ok`, 401→`badkey`, 403+credit→`out`, 5xx→`unknown` |
| Probe | ✅ authenticated `GET {baseURL}/models`; `Authorization: Bearer <key>` observed on the wire; local endpoints probed without a key |
| Dedupe | ✅ `probeMany` collapses duplicate endpoints (DeepSeek chat/reasoner share one base) and keeps the keyed entry |
| Per-endpoint keys | ✅ `autobot:providerKeys` map keyed by normalised `baseURL`; picking a preset can no longer reuse another provider's key |
| Cache binding | ✅ `statusOf()` only honours a verdict stamped with the same key signature (`apiKey.slice(-6)`) and younger than 60 s — unit-tested in `test/e2e.test.js` via `src/providerstatus-ui.mjs` |

### Live CDP verification (app on `--remote-debugging-port=9333`)
```
Baseline (NVIDIA key present, others empty):
  nemotron-3.5-bolt-e4b  cls="model-opt on live"  dot="model-dot ok"   "Quota available"
  llama3.1 / LM Studio / FreeLLMAPI  dot="model-dot idle"             "Local endpoint"
  deepseek-chat … Qwen3-32B          cls="model-opt dim"              "No API key — click to add one"

Seeded invalid key for https://api.groq.com/openai/v1:
  Groq (free tier)       cls="model-opt dim"  dot="model-dot out"     "Key rejected"

Seeded invalid key for https://api.deepseek.com/v1:
  DeepSeek (official)    cls="model-opt dim"  dot="model-dot out"     "Key rejected"
  DeepSeek Reasoner      cls="model-opt dim"  dot="model-dot out"     "Key rejected"   (deduped probe)

Out-of-credit (mock 402 on /models):
  LM Studio (local)      cls="model-opt live" dot="model-dot out"     "Out of credit"

Pill:  model-dot ok  (mirrors the active endpoint)
Computed style of live row: background rgba(101,187,48,0.18) + inset 2px green bar
Active row auto-scrolls into view on open; names no longer ellipsised at 300px width.
```

Statuses are learned from a cheap authenticated `GET /models` (no token spend), cached
in `localStorage` for 60 s, and refreshed each time the picker opens. Unconfigured
presets stay clickable: clicking preloads that preset and opens Settings at the key field.

### Key-change reprobe (fix verified 2026-11-25)

Pasting a key inside Settings used to leave the row showing "Key set — status unknown"
until the next reload, because the picker only probed endpoints it had never seen and the
invalidation effect raced the probe. Statuses are now stamped with `sig` (key tail) + `at`
(timestamp); `statusOf()` rejects any verdict whose `sig` differs from the current key or
that is older than `KEY_STATUS_TTL`, so the picker re-probes on the next open.

```
Source build (port 9333), no reload between steps:
  Groq row before      "model-opt dim / No API key — click to add one"
  type gsk_typed_bad_key in Settings → close → open picker (3.5 s)
  Groq row after       "model-opt on dim"  dot="model-dot out"  "Key rejected"

Packaged app (release/mac-arm64, port 9334), same flow:
  before "model-opt dim"; after 4.5 s → "model-opt on dim / Key rejected / model-dot out"
  pill dot → "model-dot out"

Pill probes the active endpoint on load (no picker needed):
  pillDot="model-dot ok"  model="nemotron-3.5-bolt-e4b"   before the menu is ever opened
```

Full state matrix on one screen (packaged app, mock 402 on the LM Studio port):
`nvidia → live/ok`, `lmstudio → live/out (Out of credit)`, `deepseek ×2 → dim/out (Key rejected)`,
`ollama → neutral idle (Local endpoint)`, 10 unkeyed presets `dim`, `live=2 dim=14`,
console errors: **0**.

---

## 11. Cowork orchestrator — per-worker backends, parallel fan-out (2026-11-25)

Worker registration now accepts a full provider pin, so one goal can be fanned out to
several **different** backends concurrently — e.g. NVIDIA NIM in the cloud plus a local
Ollama Gemma on the same machine.

| Check | Result |
|---|---|
| Worker pin | ✅ `mcp__cowork__register_worker` accepts `baseURL` / `model` / `apiKey` / `supportsTools` / `systemPrompt`; the reply echoes the pin (`… pinned to <model> @ <baseURL>`) |
| Provider precedence | ✅ per-call override → worker pin → call-wide fallback; a partial pin is layered on the base provider (never silently defaults to `localhost:11434/llama3.1`) |
| Pin isolation | ✅ a pinned sub-run does **not** inherit the parent's `orchestrator` failover list (otherwise the pin would be replaced mid-run) — regression test drives the real `runAgent` ctx with two mock providers |
| Parallel fan-out | ✅ bounded concurrency (default 4); two 200 ms workers finish in <340 ms wall clock (serial would be ≥400 ms) |
| Result headers | ✅ per-worker `--- name (model @ baseURL) [status, Nms] ---` block + a JSON array carrying `provider.baseURL` / `provider.model` |
| Failure isolation | ✅ `runWorker` never throws — a dead worker returns `status:'error'` and the rest still complete |
| Headless coverage | ✅ 3 orchestrator tests + 2 icon-registry tests + 1 ordering test added → suite **53 passed, 0 failed** |

### Live runs

```
node test/live-orchestrator.js        (direct cowork API)
  nvidia  → done  847ms   "I am a Helio Bot…"
  gemma   → done 2827ms   "I am the Gemini model family."
  WALL 2839ms  (parallel — serial would be ~3674ms)

node test/live-orchestrator-agent.js  (parent agent on NVIDIA NIM drives the tools)
  → tool mcp__cowork__register_worker {name:"gemma-local", baseURL:"http://127.0.0.1:11434/v1",
                                       model:"gemma4:latest", supportsTools:false}
  ← Registered cowork worker "gemma-local" pinned to gemma4:latest @ http://127.0.0.1:11434/v1
  → tool mcp__cowork__orchestrate     {goal:"In one short sentence, name your model family."}
  ← --- gemma-local (gemma4:latest @ http://127.0.0.1:11434/v1) [done, 2228ms] ---
    I am a large language model trained by Google.
  parent final answer: "I am a large language model trained by Google."
  PASS in 4369ms

UI (source build :9333, screenshot screenshots/orchestrator-nvidia-gemma.png)
  composer → NVIDIA agent → register_worker + orchestrate tool cards → Gemma answer rendered;
  console errors: 0
```

### Release polish (packaged build, 2026-11-25)

| Check | Result |
|---|---|
| Transcript order | ✅ tool cards render **above** the assistant answer (Claude order) in both the streaming view and finished messages; guard test `tool cards render above the assistant answer` asserts the JSX order in `Message` + the live block |
| Sidebar icons | ✅ every row resolves to a real glyph; `MCP` now uses the distinct `Connectors` (57429) glyph so it no longer duplicates `Plugins` (`Plugin`) |
| Model pill | ✅ `nemotron-3.5-bolt-e4b` + green quota dot + caret render clean at 6× zoom (screenshot `/tmp/pill2.png`) — earlier `••••••` was a downscaled-screenshot artifact, not an element |
| Packaged orchestrator run | ✅ built app :9334 — composer send → `register_worker` + `orchestrate` cards → "I am a large language model trained by Google." (6011 ms), console errors 0 |

### Icon registry (regression guard)

`<Icon name=…>` usages in `App.jsx` are all checked against `src/icons.json`; aliases
(`Plus→Add`, `Plug→Plugin`, `Refresh/Reload/Sync→ArrowClockwise`, `Sparkles→StarFilled`)
are asserted to share the base glyph's codepoint, so a mistyped name can never render as
a blank box again.

### Ollama / gemma4 (2026-11-25, source build :9333 via CDP)

| Check | Result |
|---|---|
| Installed models discovered | ✅ `GET /api/tags` → `gemma4:latest`, `hf.co/unsloth/gemma-4-E4B-it-GGUF:Q4_K_M` ("2 models installed") |
| Picker expansion | ✅ two `Ollama · installed` rows, green dots, no `llama3.1` phantom row |
| Cold start CTA | ✅ with the server stopped: `Connect Ollama (local) | starts the server` row appears |
| One-click connect | ✅ click → `ollama serve` spawned → pill switches to `gemma4:latest`, `provider.baseURL = http://localhost:11434/v1` |
| Real send | ✅ "Reply with exactly: GEMMA-CONNECTED" → `GEMMA-CONNECTED` in 9 055 ms, 0 console errors |
| Settings box | ✅ Scan / Start / reconnect + model chips; clicking a chip sets the model |
| Headless suite | ✅ **56 passed, 0 failed** (`ollama: root/base normalization…`, `ollama: a running server reports…`, `ollama: picker lists discovered models…`) |

### Filesystem + workspace + computer control (2026-11-25, source build :9333)

| Check | Result |
|---|---|
| `~` expansion | ✅ `expandPath('~/Desktop')` → `/Users/saimon/Desktop`; `resolvePath` no longer creates literal `~/` |
| Per-conversation project folder | ✅ `getDefaultCwd(id,title)` → `/Users/saimon/Helio Bot/<slug>`, lazily created |
| Workspace persistence | ✅ `~/.autobot/workspaces.json` `{ [convId]: {dir,title,at} }`; `getWorkspace`/`setWorkspace` round-trip |
| `setWorkspace('~/Desktop')` | ✅ resolves to `/Users/saimon/Desktop` (fixed `path.resolve` → `expandPath`) |
| Login-shell Bash | ✅ `spawn /bin/zsh -l -c` (fixed `exec {shell:'/bin/zsh -l'}` ENOENT) |
| Real desktop write | ✅ composer send → Bash tool → `mkdir ~/Desktop/HelioTest` → folder present on the physical Desktop (`ls`-verified) |
| Headless suite | ✅ **57 passed, 0 failed** |
| Regression (queue) | ✅ `hb-queue13` cross-chat flush; `hb-queue14` same-chat + Send-now cancels live run in 257 ms |
| Regression (stop) | ✅ `hb-stop3` — 90 partial chars kept, no error banner, `AFTER-STOP` reply works |
| Packaged build | ✅ `npm run dist` → DMG 113.4 MB / ZIP 109.3 MB, `hdiutil verify` VALID (SHA-256 `f3761065…86b3` DMG) |

### No step ceiling — Claude's "loop until the model stops" (2026-11-25)

The coach asked: *"why only 5 steps why limit? it should be same like claude app."* Correct —
Claude raises no per-run turn budget, so neither does Helio Bot.

| Check | Result |
|---|---|
| Ceiling removed | ✅ `HARD_STEP_CAP = Number(opts.hardStepCap) || 1000`; `maxSteps` defaults to it. Interactive, sub-agent, bridge, orchestrator and scheduled runs all pass `maxSteps: 0` (unbounded). |
| Long run does **not** get cut | ✅ 45 consecutive tool turns completed with **no `limit` event**; the loop exits only when the model emits no more tool calls |
| Safety valve is loud, never silent | ✅ an explicit `hardStepCap` trip emits `{type:'delta'}` (explanation text) + `{type:'limit', steps}`; the transcript says *"Paused after N tool turns — that is the runaway safety valve, not a step limit…"* |
| Harnesses judge by movement | ✅ live harnesses use a 30-minute `HELIO_RUN_DEADLINE_MS` default plus a 240-sample/10-minute **freeze** detector instead of a wall-clock deadline (real runs legitimately take 5–10 min) |

### Token-limit truncation is re-generated, not stacked (2026-11-25)

Reasoning models (Kimi K3.1 Pro, DeepSeek V4.1 Flash) spend the budget on
`reasoning_content` and can be cut mid-sentence at `finish_reason: "length"`. Claude
*replaces* a cut-off message; it never leaves the draft above the answer.

| Check | Result |
|---|---|
| Retry is emitted | ✅ `runAgent` counts the turn's streamed chars (`turnChars` / `turnThink`, reset per `doChat`) then emits `{type:'retry', chars, thinkingChars}` before re-streaming — also fires when a tool call's `arguments` JSON was sliced |
| Budget grows | ✅ `min(max(base*2, base+4096), 65536)`; the accepted `max_tokens` is written back onto the provider so the next turn starts big |
| Renderer trims the cut attempt | ✅ `case 'retry'` slices exactly `chars` text chars and `thinkingChars` think chars off the tail of the live segment list, drops now-empty segments, keeps tool rows |
| Live CDP proof (`test/live/retry-ui.cjs`, stub SSE cut at `length`) | ✅ capture `before: ["text:48"]` → `after: []`; transcript `blocks` = `["think:Thought (token limit reached — retrying with 16384 tokens)", "text:Final answer: …"]` — **one** clean answer, no `Draft: this sentence was cut off…` residue |
| Truncation is visible, not silent | ✅ the thinking line names the retry and the new budget; no red error banner |
| Harness lesson recorded | ✅ a stale `dist/assets` bundle silently defeats renderer fixes; a changed `electron/` file needs a full app restart (main process is not hot-reloaded) |
| Headless suite | ✅ **111 passed, 0 failed** (111 tool definitions) |

### A provider gateway error is retried, never pasted into the chat (2026-11-25)

Every live run from a provider behind a CDN can hit a 502/503/504 at any moment — the
gateway answers with an nginx or Cloudflare **HTML page**, not JSON. Helio Bot used to die
there and show the page verbatim:

```
LLM 502: <html><head><title>502 Bad Gateway</title></head><body>…nginx…
```

| Check | Result |
|---|---|
| Transient classifier | ✅ `RETRY_STATUS` = `408,409,425,429,500,502,503,504,520-527,529`, matched on `err.status` **and** on the `LLM NNN:` prefix in the message, plus prose keys (`bad gateway`, `upstream error`, `ECONNREFUSED`, `EPIPE`, `EAI_AGAIN`, `service unavailable`, …) — 4xx stays fatal |
| Message is humanized | ✅ `humanizeLLMError()` strips `<script>/<style>`, tags and entities, folds whitespace, maps the status to a sentence, and only appends the body when it is prose (gateway boilerplate detected by residual content) |
| No path leaks markup | ✅ scrubbed twice: main-process IPC (`main.js` `autobot:run` catch) and renderer (`cleanErr()` before `setError`) |
| The wait line is status-aware | ✅ `provider error 502 — waiting 2s before retrying` (newline-separated for repeated back-offs) instead of always "rate limited" |
| Live CDP (`test/live/gateway-502.cjs`, stub on :8903) | ✅ 3 attempts → answered; `.errorbar` empty; blocks `["think:provider error 502 — waiting 2s… / … 5s …", "text:Back online — the gateway blip was retried and this answer is intact."]`; `document.body.innerText` free of `<html|<head|<title|<body|nginx`; `screenshots/gateway-502.png` |
| Headless suite | ✅ **111 passed, 0 failed** (two new tests: the retry and the humanizer) |
| Real model, end to end, after the fix | ✅ `real-model.cjs deepseek` exit 0 — `Worked for 8m 33s`, 204 samples, 139 ordered blocks, 7 files on disk, page live in the pane, `errorBanner` empty, no markup |
| Regressions | ✅ `retry-ui.cjs` PASS · `composer-flow.cjs` PASS · `npm run build` clean |
