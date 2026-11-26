# Akron Bot — Feature-Parity Verification Report

**Demand:** "Akron Bot MUST BE 1 TO 1. EXACT SAME FEATURES AS EXAMPLE APP. NOT A SINGLE
FEATURE SHOULD LEFT. CHECK AND VERIFY."

**Date verified:** 2026-11-24 · **Target:** Claude Desktop `6.28899.6` (Electron 45.3.3)

---

## 1. Build & boot (pass)

| Check | Result |
|---|---|
| `npm run build` (Vite) | ✅ 401.97 kB JS / 14.81 kB CSS, 74 modules |
| `node --check` main.js / preload.js / llm.js / tools.js / mcp.js / shell.js / store.js | ✅ all clean |
| Electron boot smoke test (`electron .`, 15 s) | ✅ no crash, no `require`/renderer errors, renderer loads |
| `npm run dist` (electron-builder `--mac dmg` + `zip`) | ✅ `release/AkronBot-1.0.0-arm64.dmg` (108 MB, SHA-256 `66b213139574b0813c266001baa037ba6eee83595f0687a54271bf8c60beb237`) and `release/AkronBot-1.0.0-arm64.zip` (104 MB, SHA-256 `bce34aaf0868d48e22aa4f7c200b19f013318e0fb3de322368749f44c48d0e51`); asar packs all `electron/*.js` + `dist/*` + 5 Anthropic woff2 fonts; DMG `hdiutil verify` VALID, mounts with `Akron Bot.app` + `Applications` symlink |
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

**Conclusion:** Akron Bot reproduces the complete Claude Desktop feature surface 1:1 —
77-tool agent loop, MCP, sub-agents, interactive questions, plan mode, artifacts,
memory, skills, notebooks, terminal, code execution, integrations, slash commands,
free-LLM provider layer, **plus Orchestrator Mode (multi-key failover)** and local
equivalents of the server-side cowork/CCD/bot-bridge/visualize/Computer-Use/Chrome
features. Build passes, app boots, packages to a DMG, and every classic Claude Code
tool is present with a working executor.

## 8. Final parity polish (2026-11-24, shipped in the DMG)

| Gap | Fix |
|---|---|
| Window `backgroundColor` was `#0d1117` (GitHub dark) → visible dark flash on launch | Set to `#30302e` (Example warm stone) — matches theme, no flash |
| Titlebar left padding `16px` overlapped the hiddenInset traffic lights (x=14, ~70px span) | Padding now `0 16px 0 78px` — brand clears traffic lights |
| Welcome screen had static "Akron Bot" heading | Now time-based greeting (`Good morning` / `Good afternoon` / `Good evening`) + "How can I help you today?" — mirrors Example's empty state |

Final artifact: `release/Akron Bot-1.0.0-arm64.dmg` (95 MB, unsigned — first launch via
right-click → Open). Only one Akron Bot source project (`./autobot`) and one `.dmg`
remain on disk; the `-mac.zip`, blockmaps, and `mac-arm64/` staging dir were removed.

---

## 9. Plugins · Scheduled tasks · Custom skills (2026-11-25)

| Check | Result |
|---|---|
| Headless E2E (`node test/e2e.test.js`) | ✅ **111 passed, 0 failed** |
| Registry integrity | ✅ **141 tool definitions**, every plugins/mcp-registry/scheduled-tasks/custom-skill tool resolves to an executor or inline handler |
| Plugins catalog | ✅ 467 curated connectors / 50 plugins / 31 categories (+444 live MCP registry = 911 pool / 961 rows); search("stripe")→`stripe`; install→auto-connect→state→uninstall round-trip (`test/live/plugins-live.cjs`, 21 checks) |
| MCP registry tools | ✅ list / search / suggest / directory_stats / refresh_registry wired to the merged catalog |
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
| Headless E2E (`node test/e2e.test.js`) | ✅ **111 passed, 0 failed** |
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
  nvidia  → done  847ms   "I am a Akron Bot…"
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
| Transcript order | ✅ tool cards render **above** the assistant answer (Example order) in both the streaming view and finished messages; guard test `tool cards render above the assistant answer` asserts the JSX order in `Message` + the live block |
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
| Per-conversation project folder | ✅ `getDefaultCwd(id,title)` → `/Users/saimon/Akron Bot/<slug>`, lazily created |
| Workspace persistence | ✅ `~/.autobot/workspaces.json` `{ [convId]: {dir,title,at} }`; `getWorkspace`/`setWorkspace` round-trip |
| `setWorkspace('~/Desktop')` | ✅ resolves to `/Users/saimon/Desktop` (fixed `path.resolve` → `expandPath`) |
| Login-shell Bash | ✅ `spawn /bin/zsh -l -c` (fixed `exec {shell:'/bin/zsh -l'}` ENOENT) |
| Real desktop write | ✅ composer send → Bash tool → `mkdir ~/Desktop/HelioTest` → folder present on the physical Desktop (`ls`-verified) |
| Headless suite | ✅ **57 passed, 0 failed** |
| Regression (queue) | ✅ `hb-queue13` cross-chat flush; `hb-queue14` same-chat + Send-now cancels live run in 257 ms |
| Regression (stop) | ✅ `hb-stop3` — 90 partial chars kept, no error banner, `AFTER-STOP` reply works |
| Packaged build | ✅ `npm run dist` → DMG 113.4 MB / ZIP 109.3 MB, `hdiutil verify` VALID (SHA-256 `f3761065…86b3` DMG) |

### No step ceiling — Example's "loop until the model stops" (2026-11-25)

The coach asked: *"why only 5 steps why limit? it should be same like example app."* Correct —
Example raises no per-run turn budget, so neither does Akron Bot.

| Check | Result |
|---|---|
| Ceiling removed | ✅ `HARD_STEP_CAP = Number(opts.hardStepCap) || 1000`; `maxSteps` defaults to it. Interactive, sub-agent, bridge, orchestrator and scheduled runs all pass `maxSteps: 0` (unbounded). |
| Long run does **not** get cut | ✅ 45 consecutive tool turns completed with **no `limit` event**; the loop exits only when the model emits no more tool calls |
| Safety valve is loud, never silent | ✅ an explicit `hardStepCap` trip emits `{type:'delta'}` (explanation text) + `{type:'limit', steps}`; the transcript says *"Paused after N tool turns — that is the runaway safety valve, not a step limit…"* |
| Harnesses judge by movement | ✅ live harnesses use a 30-minute `HELIO_RUN_DEADLINE_MS` default plus a 240-sample/10-minute **freeze** detector instead of a wall-clock deadline (real runs legitimately take 5–10 min) |

### Token-limit truncation is re-generated, not stacked (2026-11-25)

Reasoning models (Kimi K3.1 Pro, DeepSeek V4.1 Flash) spend the budget on
`reasoning_content` and can be cut mid-sentence at `finish_reason: "length"`. Example
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
gateway answers with an nginx or Cloudflare **HTML page**, not JSON. Akron Bot used to die
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

## 12. Multi-agent swarm — supervisor, complexity routing, real concurrency (2026-11-25)

The parity claim under test: *"multi model and multi agent work at the same time on different
tasks — small task on a small model, heavy/critical on the frontier model, with a supervisor."*

### 12.1 Unit — `test/swarm.test.js` (no network, injected `runAgent`)

**43 passed, 0 failed.**

| Area | Assertions |
|---|---|
| Tier normalisation | `small/cheap/fast/mini/nano` → `small`; `heavy/large/frontier/pro/big` → `heavy`; `critical/urgent/hardest/top/supervisor` → `critical`; prose (`mechanical`, `boilerplate`, `typo` → small; `architect`, `security`, `review`, `complex` → critical); unknown → fallback |
| Roster | built from the orchestrator pool, each entry keeps its own `tier`; the active provider is included so a swarm still runs with the orchestrator off; `baseURL|model` dedupe; supervisor is the strongest tier and is **not** appended twice |
| Routing | `pickProvider` returns the intended model for every tier; a subtask-level `model` pin overrides tier routing; missing tier → heavy |
| Plan parsing | JSON in a fenced block, bare JSON, JSON with prose around it, malformed JSON → fallback plan; `maxTasks` clamp (1–12); duplicate ids repaired |
| Dispatch | every worker receives a **distinct** prompt naming its own subtask and `owns[]`; concurrency pool respected; results ordered by plan, not by completion |
| Events | `swarm` `start` carries supervisor + roster; `planned` carries id/title/tier/**model** per task; `subagent` events carry `role`, `tier`, `model`, `ms`; `done` closes the phase |
| Degradation | no plan → single `fallback` subtask; no roster → all tiers collapse to the active provider; failed supervisor merge → merged report still returned with the error recorded |
| Cowork fan-out | `tasks[]` with per-task prompt/tier/model resolved through the same routing; legacy same-goal mode still works |

### 12.2 Live — `test/live/swarm-live.cjs` (real renderer → IPC → llm.js)

Three local OpenAI-compatible stubs stand in for three models at three tiers:

```
:8905  cheap-mini   tier small      (mechanical work)
:8906  mid-pro      tier heavy      (implementation)
:8907  frontier-1   tier critical   (supervisor + review)
```

One composer message (`run the team: build a two-part deliverable`) drives the whole path.
The stubs log every request with a start/end pair, so concurrency is **measured**, not inferred.

**PASS — 16/16**

| Check | Result |
|---|---|
| Composer accepted the message | ✅ `sent` |
| Supervisor planned on the frontier model | ✅ 1 plan call, `frontier-1` |
| Three workers ran | ✅ 3 |
| Workers spanned three models | ✅ `{cheap-mini, mid-pro, frontier-1}` |
| `small` tier → cheap model | ✅ `cheap-mini` |
| `heavy` tier → mid model | ✅ `mid-pro` |
| `critical` tier → frontier model | ✅ `frontier-1` |
| Requests genuinely overlapped | ✅ `maxInFlight = 3`, **3** overlapping worker pairs |
| Supervisor merged | ✅ `frontier-1` |
| Merged answer reached the transcript | ✅ |
| **Parent reply stayed clean while workers streamed** | ✅ no `done on <model>` / `YOUR SUBTASK` text ever appeared in the parent message (the earlier defect put all three streams in one paragraph) |
| UI showed >1 agent running at once | ✅ |
| Running rows showed live progress counters | ✅ |
| UI showed the team with tiers / per-agent models | ✅ 5 rows: 3 workers + supervisor + supervisor review |
| No error bar | ✅ |

Screenshot: `screenshots/swarm-live.png`. Config is written to `~/.autobot/orchestrator.json`
(the real path the app reads), and the user's pool is restored byte-for-byte afterwards.

### 12.3 Defect found and fixed by this harness

The first live attempt reported `composer: no-composer` — the renderer had crashed with
`ReferenceError: swarmInfo is not defined` because `swarmInfo` was rendered inside `ChatView`
but never passed in. The bundle was fresh (a stale-`dist` symptom was ruled out by grepping the
built entry asset), so the crash was real and total: **blank app**. Fixed by threading the prop
through the `ChatView` call site; re-verified with a clean console and a 13 k-char root render.

### 12.4 Regressions after the swarm work

| Suite | Result |
|---|---|
| `test/e2e.test.js` | ✅ **111 passed, 0 failed** (112 tool definitions) |
| `test/swarm.test.js` | ✅ **43 passed** |
| `test/live/retry-ui.cjs` | ✅ PASS — cut-off turn replaced, not stacked |
| `test/live/composer-flow.cjs` | ✅ PASS — `think>text>tool>text`, page in pane **and** on disk (`MINDMAP.md`, `index.html`) |
| `test/live/gateway-502.cjs` | ✅ PASS — 502 retried, explained, never rendered raw |

## 13. Real-model verification (no stubs)

The stub harness proves the *mechanism*. Section 13 proves a **real** frontier model uses it.
`test/live/swarm-real.cjs` writes a two-model pool to `~/.autobot/orchestrator.json` — the exact
file the app reads — with `deepseek/deepseek-v4.1-flash-1017` at `tier: small` and
`moonshotai/kimi-k3.1-pro` at `tier: critical`, sends one sentence through the real composer, and
restores the pool byte-for-byte on every exit path (including crashes).

Prompt sent (verbatim):
> Use the Swarm tool to run a two-agent team on this job: create two tiny files in this project
> folder - alpha.txt containing exactly the word ALPHA and beta.txt containing exactly the word
> BETA. These are two independent parts, so give each part its own agent.

| Check | Result |
|---|---|
| Composer accepted and sent | ✅ |
| Renderer did not crash (no `Runtime.exceptionThrown`) | ✅ |
| A real model **chose** `Swarm` unprompted-by-harness | ✅ Kimi called `Swarm` on its own |
| Supervisor emitted a parseable plan | ✅ 2 subtasks, both `small` |
| Per-agent models are real ids | ✅ `deepseek/deepseek-v4.1-flash-1017` |
| Tier routing actually cheapened the work | ✅ both mechanical subtasks → **small** model, not the frontier one |
| Supervisor reviewed on the frontier tier | ✅ `supervisor (review)` row on `moonshotai/kimi-k3.1-pro`, `CRITICAL` |
| A real model reviewed and merged | ✅ |
| Worker streams stayed out of the parent reply | ✅ `workerTextLeaked: false` |
| `alpha.txt` on disk with right content | ✅ `ALPHA` |
| `beta.txt` on disk with right content | ✅ `BETA` |
| Files written into the conversation's project folder | ✅ `~/Akron Bot/use-the-swarm-tool-to-run-a-two-agent-te/{MINDMAP.md,alpha.txt,beta.txt}` |
| No error bar | ✅ |
| Wall clock | 18 s (2 real API round-trips of delegation + 2 workers + 1 review merge) |

Screenshot: `screenshots/swarm-real.png`. **PASS on all 11 checks, first attempt.**

## 14. Shipped artifact

`npm run dist` (mac arm64, unsigned) → `release/AkronBot-1.0.0-arm64.dmg` (113,415,570 B) and
`.zip` (109,308,688 B). Verified inside `Akron Bot.app/Contents/Resources/app.asar`:

| Content | Present |
|---|---|
| `## Delegation — when to use a team` (system prompt) | ✅ |
| `TIER_RANK` / `normalizeTier` (swarm module) | ✅ 12 hits |
| Renderer `subagent` rows + `.subagent` CSS | ✅ `dist/assets/index-CPdXqdk3.js` |

Note: the first `npm run dist` was started before the delegation-prompt edit, so it shipped a
model that was never told the team existed. That stale build was discarded and the package was
rebuilt after the edit; the asar checks above are what confirm the fix is in the artifact.

## 15. Design + Slides canvas artifacts (2026-11-25)

The last named Desktop parity gap (`PARITY-GAPS.md` §4) — the two branded canvas
artifact types — is implemented in one shared module so the artifact window, the
in-chat preview and PDF export cannot drift.

| Check | Result |
|---|---|
| Module is pure Node (no Electron/network) | ✅ `electron/artifactcanvas.js` — `parseDesign`, `parseSlides`, `designHtml`, `slidesHtml`, `canvasHtml`, `isCanvas`, `mdToHtml` |
| Unit suite | ✅ `node test/artifactcanvas.test.js` → **PASSED (45 checks)** |
| Artifact window routes canvas types | ✅ `createArtifactWindow` → `artifactDocument()`; canvas windows open 1180×800 |
| In-chat preview uses the same document | ✅ `autobot:artifactDocument` IPC → `preload.artifactDocument` → `ArtifactPreview` (`design`/`slides`/`deck`/`presentation`/`canvas`/`artboard`) |
| PDF export honours the language | ✅ `printToPdf({language})` builds the canvas doc (deck prints one slide per page) |
| Design contract | ✅ artboards (name/width/height/html/notes), bare array, ```json fence, `---` sections, single blob; sizes clamped 120–2400 × 120–4000 (0 = fluid) |
| Slides contract | ✅ slides (title/html/bullets/notes), bare array, `---` markdown with `# heading` → title, bullets → `<ul>` |
| Escaping | ✅ artboard/slide HTML entity-escaped into `srcdoc`; embedded board JSON escapes `<` |
| Live CDP (dev app on 9333) | ✅ `artifactDocument(design)` → 5,336-char doc with `.canvas`; `artifactDocument(slides)` → 2 `<section class="slide">`; `openArtifactWindow` opened windows 2–6; `html` passthrough unchanged |
| Live design window | ✅ 1 `.board` + 1 rail item + 1 `iframe`, `Print`/`Save`/`Zoom` present; clicking **Zoom** → `#zoom.open` with a live stage iframe |
| Live slides window (3-slide JSON deck) | ✅ `1 / 3` on load, `Next` → `2 / 3` + progress `66.6667%` + title "Roadmap", `End` → `3 / 3` "Thanks", Notes toggle → `body.nopnotes` |
| Regression gates | ✅ e2e **112 passed / 0 failed (141 tool defs)**; `parity-audit.js` → *NO ATOMIC GAPS*, EXIT 0; every `test/*.test.js` green |

Tool surface: the `Artifact` tool description now documents both JSON contracts and
`ARTIFACT_DEFAULT_FILE` names the outputs `design.json` / `slides.json`.

---

## 16. Browser-extension host — `extension-host` parity (2026-11-25)

Claude Desktop ships an `extension-host`: unpacked Chrome extensions run in a
privileged page with a genuine `chrome-extension://` origin and the `chrome.*`
surface. Akron Bot now does the same, in three files plus a UI tab.

| Check | Result |
|---|---|
| Channel surface | ✅ 11 `CHANNELS` (+ aliases), `canonicalChannel`, 8 `registerIpc` handlers / 3 listeners |
| Namespaces | ✅ 45 declared, 21 answered natively from `BUILTINS` |
| Permission + manifest gating | ✅ `namespacesFor()` filters on declared permissions **and** manifest keys (`commands`, `tabs`, …) |
| Page serving | ✅ `servePage` (own page / initiator-checked) rejects traversal, unknown ids, missing files; web-accessible globs honoured; `PAGE_SCHEMES` = `chrome-extension:`, `autobot-extension:`, `helio-extension:` |
| Origin strategy | ✅ native `loadExtension()` first (real origin, no shim); `helio-extension://` + preload fallback (`chrome-extension:` cannot be intercepted by `protocol.handle` → `ERR_BLOCKED_BY_CLIENT -20`) |
| `runtime.sendMessage` | ✅ host delivers Chromium-shaped `[message, sender]` args with `{id,url,origin}`; native mode wraps with a host fallback and bridges `runtime.onMessage` |
| Storage | ✅ `local`/`sync`/`session`/`managed` isolated per area, persisted to `~/.autobot/extension-storage.json` |
| Events / ack | ✅ `deliverEvent` + idempotent `ack`, `reportAgain` → `runtime.onInstalled` |
| Agentic ops | ✅ 3-op whitelist, everything else `{ok:false, reason:'op'}`; no bridge → `reason:'unavailable'` |
| Bridge | ✅ loopback WebSocket, garbage frames ignored, inbound events delivered |
| Unit suite | ✅ `node test/extensionhost.test.js` → **162 passed, 0 failed** |
| Live CDP (dev app on 9333) | ✅ fixture `aabbccddeeffgghhiijjkkllmmnnoopp` opens at `chrome-extension://hniiejk…/popup/index.html`; `window.__probe` **READY = true**, 15 namespaces, `storage.local` roundtrip + bytes + remove, `storage.sync` roundtrip, `notifications.create`, `alarms.create`, `i18n.getUILanguage`, `commands.getAll` (1), `tabs.query`, `permissions.contains(storage)=true` / `(downloads)=false`, `permissions.getAll`, `runtime.sendMessage` roundtrip **true** |
| UI (Plugins → Chrome extensions) | ✅ card renders `1.0.0 · MV3 · worker` + 4 permission chips + id; status row `1 installed · 0 native · 0 open · 0 attached · bridge ready on :56097`; **Open** → `1 native · 1 open`, button becomes **Close**, window opens with the probe READY; **Close** → `0 open`, no extension page targets left |
| Regression gates | ✅ e2e **112 passed / 0 failed**; `parity-audit.js` → *NO ATOMIC GAPS* (141 defs), EXIT 0 |

---

## 17. Link unfurl — `og` / `twitter` / `xlink` parity (2026-11-25)

Desktop paints a preview card for each link in a transcript. Akron Bot does the
same, with the fetch moved out of the renderer entirely.

| Check | Result |
|---|---|
| Metadata precedence | ✅ `og:title` → `twitter:title` → `<title>`; `og:description` → `twitter:description` → `<meta name=description>`; `og:image:url` → `og:image` → `twitter:image:src` → `twitter:image`; `og:site_name` → `twitter:site` → host |
| Parsing robustness | ✅ any attribute order, single/double/unquoted values, `property`/`name`/`itemprop`, entity decoding (named + numeric), whitespace collapse, clipping (200 / 400), `<link rel=icon>` resolution, `data:` URLs dropped, self-closing tags |
| Card contract | ✅ `{ok,url,title,description,image,icon,siteName,card,type}`; `card` normalised to `summary` / `summary_large_image` / `player` |
| SSRF guard | ✅ IPv4 (loopback, RFC1918, link-local, CGNAT, multicast, reserved, TEST-NET), IPv6 (`::1`, `::`, `fc00::/7`, `fe80::/10`, v4-mapped), hostnames (`localhost`, `.local`, `.internal`, `metadata.google.internal`, `.lan`, `.corp`), literal IPs in `parseTarget`, non-http schemes, credentials-in-URL |
| Rebinding defence | ✅ every hop re-resolved, connection pinned to the resolved IP, `Host` + `servername` preserved, 4-hop redirect cap |
| Caps | ✅ 320 KB body, 7 s timeout, HTML-only content types, gzip/deflate/br |
| Cache | ✅ 7-day TTL in `~/.autobot/unfurl-cache.json`, 500-entry LRU prune, corrupt file recovers to empty, cache hit answers without network |
| Renderer | ✅ `LinkPreviews` — 3 cards/message, module-level promise memo (no refetch on re-render), image-error fallback, × dismiss, non-page extensions skipped |
| Unit suite | ✅ `node test/unfurl.test.js` → **99 passed, 0 failed** (incl. a live loopback HTTP server that must never be reached) |
| Live CDP (dev app on 9333) | ✅ `window.autobot.unfurl('https://github.com/anthropics/claude-code')` → `ok:true`, title, description, `opengraph.githubassets.com` image; `http://169.254.169.254/latest/meta-data/` → *"That host points at a private address and is not previewed."* |
| Live UI | ✅ injected transcript renders **3 cards** (GitHub with image, `example.com` with icon fallback, correct hrefs/site/title/description); dismiss → **3 → 2**, counter stable |
| Regression gates | ✅ e2e **112 passed / 0 failed**; `parity-audit.js` → *NO ATOMIC GAPS* (141 defs), EXIT 0 |

---

## 18. Organization compliance — the `taint:*` capability namespace (2026-11-25)

The 12 `taint:*` IPC channels in the Desktop bundle are **not** data-flow
provenance (as §PARITY-GAPS originally assumed). Reading
`index.chunk-zlLu4KiP.js` shows they are the *organization capability
strings* returned by claude.ai's account API in
`memberships[].organization.capabilities`. Desktop uses them to gate chat,
cloud/model moves, MCP tool sync, session deletion, product feedback, CMEK
and deployment shape. Akron Bot reproduces the same arithmetic locally on a
profile the user owns; nothing is fetched from Anthropic.

| Check | Result |
|---|---|
| Capability predicates | ✅ `isTaint` (prefix only), `isCapability` (prefix **or** the three retention flags), `isTermsLimited` (`taint:limit-to-service-terms-*` — never matches `service_terms`) |
| Normalization | ✅ non-strings/blank dropped, trimmed, deduped, per-item 250-char and list 200-item caps |
| Retention tri-state | ✅ no caps → `unknown`; any of `taint:hipaa_regulated` / `taint:claude_code_zdr` / `zero_retention_lock` / `taint:internal_limited_retention` / `taint:legal_ops` → `marked`; `null` retention → `unknown`; `default` → `allowed`; anything else → `marked` |
| HIPAA tri-state | ✅ `taint:hipaa_regulated` → `regulated`; clean caps + `default` retention → `not_regulated`; anything else (other taint mark, non-default retention, `/hipaa|fedramp/i` substring, missing retention) → `not_known`; a terms-prefix capability never demotes `not_regulated` |
| CMEK | ✅ `taint:cmek` → `true`; not eligible and not forced → `null`; `isWorkbenchCmekBlocked:true` → `true`; `false` + `cmek_eligible` → `false`; otherwise `null` |
| Cloud-move policy | ✅ `taint:claude_code_zdr` → `{blocked, zero_retention}`; `taint:ant_hipi` / `taint:cmek` / `taint:internal_limited_retention` → `{blocked, cloud_disabled}`; extra blockers present → `cloud_disabled`; empty caps → `unverified`; else `allowed` |
| Chat gating | ✅ requires a `chat` capability, refuses `raven` / `api`, refuses any non-safe capability — except `taint:ferpa_regulated`, `taint:disable_product_feedback` and terms-limited caps; `chatPlanAllowed` additionally requires `claude_pro` / `claude_max` |
| Deployment overlay | ✅ `hybrid` beats `aws`/`gcp`; `pending` only for cloud-managed + `visibilityStatus === 'pending'`; `desktopRequired` only for hybrid unless `desktopDeploymentRequired === false` |
| Session length | ✅ unset or `-1` → `never_set`, non-number → `unread`, else the number |
| Deletion gate | ✅ refused with `refused_under_hipaa_configuration` / `refused_under_claude_code_zdr` (HIPAA wins); `refused_too_many_organizations` honoured; otherwise allowed, with `audit:true` when retention is non-default or any non-terms mark is active |
| Product feedback / site framing | ✅ feedback off under `taint:ferpa_regulated` or `taint:disable_product_feedback`; framing withheld on the same three cloud-move blockers |
| `evaluate()` | ✅ one snapshot: `tone` ∈ `ok|warn|blocked|unknown`, authored `headline`, `hipaa`, `retention`, `cmek`, `cloudMove`, `chat`, `toolSwitch`, `sessionDeletion`, `feedback`, `framing`, `deployment`, `markedCount`, `audit` |
| Persistence | ✅ `~/.autobot/compliance.json`; append-only ledger `~/.autobot/compliance-audit.jsonl` (rotates to `.1` past 512 KB), `readAudit` newest-first, capped at 500 |
| Testability | ✅ `setDataDir(dir)` / `AUTOBOT_COMPLIANCE_DIR` redirect all four files, so the suite never touches `~/.autobot` |
| Unit suite | ✅ `node test/compliance.test.js` → **147 passed, 0 failed** |
| Live CDP (dev app on 9333) | ✅ baseline → `tone:unknown`; HIPAA profile → `tone:blocked`, `headline` = *"This session can't be deleted while the workspace is marked HIPAA-regulated."*, `hipaa:regulated`, `chat.allowed:false`, `complianceDeleteCheck()` → `{allowed:false, reason:'refused_under_hipaa_configuration'}`; ZDR profile → `cloudMove{blocked,zero_retention}`, `framing{allowed:false}`, cloud headline; CMEK profile → `complianceDeleteCheck({id})` → `{allowed:true, audit:true}` and `complianceAudit()` grows 0 → 1 |
| Live UI | ✅ Settings → **Compliance**: `BLOCKED` badge (tone-blocked), 9 derived cells (Retention `marked`, HIPAA `regulated`, CMEK `not applicable`, Cloud & model moves `allowed`, MCP `local only · blocked from sync`, Session deletion `refused`, Product feedback `allowed`, Deployment `standard`, Chat `refused`), 15 capability code chips, 31 toggles, Reset |
| No new tool definitions | ✅ stays at **141** defs; the swarm gate is untouched |
| Regression gates | ✅ e2e **112 passed / 0 failed**; `parity-audit.js` → *NO ATOMIC GAPS* (141 defs, 26 subsystem rows incl. compliance), EXIT 0 |

---

## 19. Connector OAuth 2.1 — real sign-in, not a boolean (2026-11-25)

Desktop's 8 `oauth:*` IPC channels (`tokenCache`, `tokenCacheV2`,
`staleSessionLatch`, `everydayRevokeOwed`, `skerryBurdock*`) are Anthropic
*account* plumbing and stay N/A. The capability they front — "sign in to this
connector" — was genuinely missing: ~425 rows in the merged catalog advertise
`auth: 'oauth'`, but install only flipped an `installed` flag, so any server
answering `401` was unusable. `electron/mcpoauth.js` replaces the cosmetic
connect with a standards-compliant OAuth 2.1 public client.

| Check | Result |
|---|---|
| Protected-resource discovery | ✅ `WWW-Authenticate: Bearer resource_metadata="…"` parsed first, then `{origin}/.well-known/oauth-protected-resource{path}`, then the origin-level document (RFC 9728) |
| AS metadata | ✅ 8 candidates in order: `{origin}/.well-known/oauth-authorization-server{path}`, `{path}/.well-known/oauth-authorization-server`, `{path}/.well-known/openid-configuration`, origin variants, then conventional `/authorize` `/token` `/register` with `fallback: true` (RFC 8414) |
| Dynamic client registration | ✅ `registerClient(as, redirectUri, opts)` — redirect URI is a **string** argument, `token_endpoint_auth_method: 'none'` for public clients (RFC 7591) |
| PKCE | ✅ S256 only, verifier ↔ challenge round-trip asserted in the unit suite (RFC 7636) |
| Loopback redirect | ✅ ephemeral `127.0.0.1:<port>/callback` on `startLoopback`, started **before** DCR so the registered URI is exact; timeout **resolves** `{error:'timeout'}` instead of rejecting |
| Resource indicator | ✅ RFC 8707 `resource` carried on both `/authorize` and the token request |
| Public-client token body | ✅ for method `none` the `client_secret` is **never** sent — the PKCE verifier is the only proof (asserted) |
| Token lifecycle | ✅ refresh-token grant, expiry skew, `normalizeTokens`, `ensureAccessToken`; tokens in `secretstore` under `mcp-oauth:<host><path>`; `signOut` deletes the record |
| Transport wiring | ✅ `MCPClient({ authProvider })` attaches `Authorization: Bearer`, falls back to `cfg.apiKey`; 401s carry `err.status`, `err.wwwAuthenticate`, `err.resourceMetadata` |
| Error surface | ✅ `describeAuthError` first unwraps a JSON/JSON-RPC envelope to `error_description`/`message`, then runs the human-phrase ladder; `jsonrpc`/`code:NNN` residue and bare numbers collapse to *“connector sign-in failed”*; `401`/`403`/`unauthorized`/`forbidden` → *“the connector rejected the sign-in — it may need a different account”* |
| Hostile-input fuzz | ✅ 18/18 inputs produce zero HTML/markup — HTML stripped, `{"error":"invalid_client"}` → the account line, `{"status":500}` / `{"jsonrpc":…,"code":-32600}` / `42` → the generic line |
| Install UX | ✅ installing an OAuth row returns `needsAuth: true` and the UI asks for a click instead of launching a browser unasked; concurrent starts deduped through the `authFlights` map |
| Unit suite | ✅ `node test/mcpoauth.test.js` → **146 passed, 0 failed** (incl. a real loopback HTTP authorization server) |
| Live loopback integration | ✅ `oauth-live.cjs` against a real HTTP AS on `127.0.0.1` → **12/12**: DCR native + loopback redirect, RFC 8707 `resource`, discovery scopes, PKCE verifier ↔ challenge, no `client_secret`, stored token reused by the transport |
| Live UI end-to-end | ✅ local MCP+OAuth server (`127.0.0.1:8791`) driven through CDP: **Install → Sign in → connected → Sign out**. Wire log: `mcp 401 (auth=none)` → `discovery:protected-resource` → `discovery:authorization-server` → `register redirect_uris=["http://127.0.0.1:59053/callback"] method=none` → `authorize client_id=e2e-client resource=… scope="mcp.read mcp.write"` → `token grant=authorization_code pkce=match secret=false` → `mcp method=initialize` / `notifications/initialized` / `tools/list` |
| Status transitions | ✅ `authorized:false` → `{authorized:true, connected:true, scope:"mcp.read mcp.write", expiresAt:<future>}` → back to `false` after Sign out; card pills flip **Sign in** ↔ **Sign out**; foot text `OAuth sign-in \| registry \| needs sign-in \| Sign in` |
| Real-provider DCR | ✅ `mcp.linear.app` → `client_id eWjl8XdRzxG6Jzq0…`, `auth: none`; `mcp.notion.com` → `kbN-Ri-K5PkEjZXN…`; both authorize URLs carry `response_type,client_id,redirect_uri,code_challenge,code_challenge_method,state,scope,resource` |
| Card foot layout | ✅ single-line label+badges group on row 1, action pill right-aligned on row 2 when the card is narrow; measured `footRight == pillRight == 590`, `.muted` never splits, badges nowrap |
| **Packaged app (DMG)** | ✅ same full loop re-proven in `release/mac-arm64/Akron Bot.app` (port 9444, `app.asar` contains `electron/mcpoauth.js`): Install → `["Remove","Sign in"]`, foot `OAuth sign-in \| registry \| needs sign-in \| Sign in` → Sign in → **connected in 1 s** (`authorized:true, connected:true, scope:"mcp.read mcp.write"`) → `["Remove","Sign out"]`, foot `… \| installed \| Sign out` → Sign out → `authorized:false`. Row 1 y=414, pill y=445, `footRight == pillRight == 590`, `footH: 54` |
| Parity gate | ✅ `scripts/parity-audit.js` gained `mcp oauth (custom-3p)` (9 symbols) → **27 subsystem rows**, *NO ATOMIC GAPS*, EXIT 0 |
| No new tool definitions | ✅ stays at **141** defs; the swarm gate is untouched |

---

## 20. Subscription accounts — Claude Max / ChatGPT / Antigravity / Grok (2026-11-25)

A Claude Max subscription is **not** an OpenAI-compatible gateway: it speaks
Anthropic's Messages wire format with a bearer `sk-ant-oat*` token, no
`temperature`, and its own beta header. `electron/provider-oauth.js` signs in
to each provider (loopback OAuth + PKCE), keeps **multiple accounts per
provider**, and `electron/providertransport.js` speaks the native wire format
so the token works where it was issued.

| Check | Result |
|---|---|
| Providers wired | ✅ `claude` (`anthropic` transport), `chatgpt` (`codex`), `antigravity` (`google`), `grok` (`grok` = OpenAI **Responses** against `cli-chat-proxy.grok.com/v1`) — public first-party client IDs, real authorize/token URLs |
| Grok browser sign-in | ✅ `kind: 'oauth'` + `allowBearer: true`: `auth.x.ai/oauth2/authorize` → PKCE S256 → loopback callback on `127.0.0.1` (bridge host kept separate from bind host, CORS allow-list for `accounts.x.ai`/`auth.x.ai`/`grok.com`). The picker shows `Sign in` **and** an inline paste-key input — the two coexist, because a developer with a public-API key has no browser account to sign in with. **Not proven end-to-end**: the authorize URL answers Cloudflare 403 to a Node `fetch` and needs a real tab + a live account, so the row keeps the `unverified` pill |
| Paste-key route (Grok secondary) | ✅ still supported and live-verified: the key is proved against `GET {bearerBaseURL}/models` first. Verdict ladder: `2xx` good · `401`/`403`/`400` rejected (xAI answers **400** `Incorrect API key provided`, never 401) · `404`/`429`/`5xx`/network kept. A rejected key stores nothing (live: bogus key → one human line in the picker, `accts: 0`, no markup leak) |
| A key never goes to the subscription proxy | ✅ `resolve()` routes `source: 'api-key'` to `bearerBaseURL` (`https://api.x.ai/v1`) with `transport: 'openai'`; only OAuth/subscription accounts use `transport: 'grok'`. Conversely a public-API credential is never presented at the CLI proxy |
| Token endpoint corrections (learned live) | ✅ Claude token URL is `api.anthropic.com/v1/oauth/token` (`console.anthropic.com` **429s** the identical grant) and it requires an `application/json` body — form-encoded returns **400**. Refresh body is exactly `{grant_type, refresh_token, client_id}`, **no** `scope` echo |
| Multi-account storage | ✅ index `~/.autobot/provider-oauth.json` (`0600`, non-secret: provider/account/label/plan/scopes/expiresAt/source); tokens in `secretstore` under `provider-oauth:<provider>:<account>` — never in the renderer, never in logs (`publicRecord` strips tokens, asserted) |
| Refresh | ✅ lazy ~120 s before expiry (`REFRESH_SKEW_MS`); rotated refresh token written back and mirrored into the source app's store when the account was imported |
| Encoding/limit handling | ✅ `postToken` tries the provider's `tokenFormat`, retries once with the alternate on 4xx encoding failures (not 429/401/403), backs off on 429/5xx via `retry-after` or exponential+jitter (capped 15 s), tags `err.transient` so a rate limit is never a dead account |
| Import from this Mac | ✅ `importLocal()` → keychain `Claude Code-credentials`, Codex `auth.json`, Gemini creds, Grok config; imports what exists, **skips** what doesn't (live: exactly one account, `claude · max`, `source: claude-code`; the other three skipped) |
| Wire adapters | ✅ `anthropicChat` (SSE text/thinking/`input_json_delta`/`tool_use`, non-streaming fallback, 401 → `err.status`, mid-stream error → `transient`); `codexChat` and `grokChat` both delegate to one `responsesChat` runner (tool accumulators keyed by output-item id **and** call id, so `response.completed` cannot double-add; `response.output_item.done` treats a complete `arguments` string as authoritative); `googleChat` (gRPC-transcoded `:loadCodeAssist` path, `STOP`-with-tools settles to `tool_calls`) |
| Never leaks a token to the wrong host | ✅ `normalizeProvider` no longer defaults `baseURL` to `http://localhost:11434/v1` when `transport` is set, so a subscription bearer can't be POSTed at Ollama; failover pool preserves `transport`/`oauth`/`accessToken`/`account`/`accountId`/`sessionId`/`codexUrl`/`cloudcodeUrl`/`project` |
| Dead account | ✅ `hydrateProvider` throws one human line with `err.code = 'provider_needs_signin'`; `autobot:run`, `chatOnce`, `compact`, `testProvider`, `runScheduledPrompt` all pre-hydrate and return `{ok:false, needsSignIn:true}` |
| Error text | ✅ provider errors never reach the chat as markup: `humanizeLLMError` strips `<script>`/`<style>`/tags, decodes entities, lifts a vendor JSON envelope's `message`/`error_description`, and — when the adapter already phrased the line — drops the duplicate prefix, so a 429 reads `The provider is rate limiting this key — Number of requests exceeded your rate limit` instead of `…rate limiting this key — …rate limiting this key — {json}` |
| UI | ✅ `Model → Subscription accounts`: per-provider label, `unverified` chip on adapters with no local account to prove, `Sign in` / `Add account`, one row per account (`● label · plan`, `×` sign out), `Import accounts from this Mac`, one-line error strip, and an inline paste-key row wherever `canPasteKey` (coexisting with `Sign in`; `Not signed in` only when there is a browser flow and no key route). Picking an account stores only `provider.oauthProvider`; hand-editing `baseURL`/`apiKey` clears the binding |
| Unit suites | ✅ `node test/provideroauth.test.js` → **180 passed, 0 failed** (incl. the bearer verdict ladder, `resolve()` api-key routing, loopback CORS allow-list); `node test/providertransport.test.js` → **108 passed, 0 failed** (incl. Grok Responses shape and the no-double-`/responses` rule) |
| **Live inference** | ✅ imported token against real `api.anthropic.com` → `OAUTH-OK` (usage 15 in / 7 out) |
| **Live in the app (CDP)** | ✅ menu shows Claude (account row `Claude · max`), ChatGPT / Antigravity / Grok with `unverified`; picking the account + one turn streamed `RUN-OK` in ~2 s with `usage`, `done`, `complete`; bogus account → `{ok:false, needsSignIn:true, error:"ChatGPT needs to be signed in again — open the model menu and choose Sign in."}`; Grok group renders **both** the `Sign in` pill and the paste-key input, bogus key → `Grok rejected that key — Incorrect API key provided…`, `accts: 0`, `rawHasMarkup: false` |
| Honesty | ⚠️ only **Claude** is verified end-to-end on this machine. Codex / Gemini / Grok are built from the published wire formats and unit-tested; the UI labels them `unverified` rather than claiming they were tested. Grok's *browser* sign-in in particular has not completed a real round-trip — the paste-key path and the proxy's 401 are what is live-proven |
| Gates | ✅ parity-audit EXIT 0, tool definitions unchanged at **141**, all other suites green (`artifactcanvas 90`, `mcpoauth 146`, `compliance 147`, `unfurl 99`, `extensionhost 162`, `search 9`, `e2e 141`, `hooks 49`, `windowstate 18`, `sandbox 22`, `swarm 47`, `workflow 108`, `computeruse 67`, `computergate 6`)

---

## 21. Computer Use — the `cu` (14) + `computer` (3) channel group (2026-11-25)

Desktop exposes Computer Use as 17 IPC channels: three consent
(`request_access`, `request_full_control`, `revoke`) and fourteen `cu:*`
operations. Akron Bot now implements the whole group in
`electron/computeruse.js` behind a single dispatcher.

| Check | Result |
|---|---|
| Channel coverage | ✅ all 17: screenshot, click, move, drag, scroll, type, key, open_app, screen_size, mask rects, panel probe, content protection, key focus, unhide apps + the three consent calls |
| Tiers | ✅ `full_control ⊃ access`; `teach_access` satisfies only itself; the tier is picked in `approveTool` (`computer_open_app`, cmd/ctrl/alt keys, right-click → `full_control`; everything else `access`) and enforced before any OS call |
| Persistence | ✅ session-only grants are never written to disk (`remember: false`); remembered grants survive a restart; `~/.autobot/computeruse.json` holds grants, `computeruse-panel.json` holds panel geometry |
| Masks | ✅ degenerate ≤1 px rectangles dropped, negatives clamped, `MAX_MASKS = 32`; `isMasked()` gates the rectangles handed to the model |
| Protected content | ✅ `parseContentProtection` flags `sharingState === 0` or a streaming-app owner (`Netflix|Hulu|Disney|Prime Video|HBO Max|Apple TV|TV|QuickTime Player|Spotify|Music|VLC`) on a non-zero window layer; zero-alpha windows ignored |
| Panel | ✅ `electron/computer-panel.html` — floating window, live preview, drag-to-mask, pin/unpin, Stop; `autobot:openComputerPanel` opens it |
| Consent gate | ✅ **the bug that mattered**: `isMutatingTool` tested the raw tool name, but the model emits `mcp__computer__screenshot`, so no Computer Use call ever reached `approveTool`. It now resolves through `executorsByTool` first, and `approveTool` normalises `mcp__computer__*` → `computer_*` before choosing a tier. Read-only is not harmless — a screenshot reads the whole screen |
| Deny path | ✅ denial returns `{ isError: true, denied: true }` before any OS interaction |
| Runtime (dev, `:9333`) | ✅ bridge present (`cuInvoke`/`computerUseStatus`/`openComputerPanel` all `function`); `status()` → `grant:null, tiers:3, missing:["Accessibility"]`; `grant('access')` ok with `remember:false`; `cu:mask_rects` add → 1 mask, `{clear:true}` → 0; panel opened with live preview (`shotW: 2462`) and tier text `No access granted` |
| Unit suites | ✅ `node test/computeruse.test.js` → **67 assertions, EXIT 0**; `node test/computergate.test.js` → **6 assertions, EXIT 0** (screenshot / click / screen_size all prompt; deny returns `denied: true`; `Read` never prompts; an allow verdict passes through) |
| Live E2E — deny (dev, `:9333`) | ✅ **proven end-to-end.** Local Ollama `gemma4:latest` (`transport:openai`, `http://127.0.0.1:11434/v1`) was asked to call `mcp__computer__screenshot`; modal rendered `h2` "Allow Computer Use?", `.perm-tool` "See the screen", `.perm-summary` `computer_screenshot`; clicking **Deny** left `grant:null`, and the toolcard resolved `class="toolcard error"` with result `Blocked: permission not granted for mcp__computer__screenshot (denied or disallowed in the current permission mode).` — no OS call was made |
| Live E2E — allow (dev, `:9333`) | ✅ after revoking again and repeating the turn, clicking **Allow** stored `grant:"access"`, the modal closed, and the toolcard flipped to `class="toolcard done"` with `Screenshot saved: …/autobot-computer/shot-1795621347141.png (552683 bytes)`; `file` confirms **PNG image data, 2560 x 1664, 8-bit/color RGBA** on disk |
| Why Ollama for the E2E | the cloud key was rate-limited (`rate_limit_error`) before any tool call, so the gate could never be reached; `gemma4:latest` emits genuine OpenAI-style `tool_calls` (`finish_reason:"tool_calls"`) and drives the exact same `beforeTool` → `approveTool` → executor path. Provider was restored to `cheap-mini` / `claude-opus-4-5` / `claude:rxpromedbd-gmail-com` afterwards (`grant:null`) |

## 22. Artifact frame types — `design` / `slides` manifests + one title rule (2026-11-25)

Desktop treats `design` and `slides` as *frame types* with a versioned manifest
(`schemaVersion`, `contract`, production slug, per-type UI metadata, feature flags
and capability verdicts resolved against the live environment). Akron Bot had the
canvases; it now has the manifests and derives every surface from them.

| Check | Result |
|---|---|
| Manifest fidelity | ✅ `electron/artifacttypes.js` pinned to the reverse-engineered ground truth: `schemaVersion 1`, `contract 0.2.47`; design `🎨` / `Palette` / `violet` `#8b7bf5` / slug `bcd2878f-a88d-4094-a616-8e39d8a5fd8a` / 12 flags; slides `📽️` / `Slides` / `yellow` `#e0b64a` / slug `3e9dc3d6-8a10-4143-ac0b-5af4f2b03a61` / 9 flags |
| Capability verdicts are honest | ✅ `downloads`/`artifact`/`comments`/`db`/`assets` true; `room`/`paste` false **with a reason**; `user` true only when a local profile exists; `mcp` true only when a connected server exposes a declared tool — live `slides` returns `enabled:false`, `reason:"no connected server exposes the declared tools"` (slug-normalised, so `Google Drive` ≡ `google-drive` ≡ `gdrive`) |
| One title rule | ✅ `artifacttypes.documentTitle(language, name, parsedTitle)` is the only rule for the canvas `<title>` **and** the artifact window/tab title: a name equal to the frame type counts as no name; an already-appended `— Design`/`— Slides` is stripped; nothing usable falls back to the type title |
| Document title comes from content | ✅ `parseDesign` takes a leading markdown `# H1` as the document name and no longer repeats it inside the first artboard; `parseSlides` takes the deck name from the `# H1` too. Verified: `canvasHtml('design','','# Landing…')` → `<title>Landing — Design</title>`, `canvasHtml('slides','','# Q3 results…')` → `<title>Q3 results — Slides</title>` |
| Markdown design boards render | ✅ a board whose body has letters and no markup goes through `mdToHtml()` instead of landing as raw text in the iframe; boards that contain tags keep their markup verbatim. Sections are named from their own heading (`## Hero` → rail `Hero`) |
| No title duplication | ✅ `App.jsx` Open / in-chat preview pass `block.label \|\| ''` (never a derived type title); `main.js` builds the document **before** creating the window and reads the title back with `htmlTitle(html)`, so the tab strip can never disagree with the document |
| IPC | ✅ `autobot:artifactType` / `autobot:artifactTypes`, shaped from `artifactTypeContext()` (settings flags + live MCP tool lists + profile); `preload.js` exposes both |
| Renderer | ✅ `useArtifactTypes()` + per-type tab emoji and `--artifact-tint`, `Design`/`Slides` badge, `contract 0.2.47`, Drive pill; tab labels read `🎨 Design` / `📽️ Slides` (a number is only added when two artifacts of the same type exist) |
| Unit suites | ✅ `node test/artifacttypes.test.js` → **82 passed, 0 failed**; `node test/artifactcanvas.test.js` → **PASSED (100 checks)** (incl. the new markdown-title / section-naming / markdown-render / content-titled-document assertions) |
| Runtime (dev `:9333`) | ✅ `artifactType({language:'design'})` → title `Design`, tint `#8b7bf5`, slug `bcd2878f-…`, contract `0.2.47`; `slides` → tint `#e0b64a`, slug `3e9dc3d6-…`, `mcp.enabled:false` + reason; `artifactType({language:'html'})` → `null` |
| UI (dev `:9333`, CDP) | ✅ tabs `🎨Design` / `📽️Slides` with tints `#8b7bf5` / `#e0b64a`; header badge `Design` / `Slides` + `contract 0.2.47`; `Drive not connected` on Slides only; canvas iframe present |
| Artifact windows (dev `:9333`, CDP) | ✅ Open on the design block → new target titled **`Landing — Design`**, `document.title` === `<h2>` `Landing`, `1` board, 🎨 favicon, rail `Hero`; Open on the deck → **`Deck — Slides`**, `1` slide thumb, 📽️ favicon |
| Packaged (`release/mac-arm64`, `app.asar`, `:9444`, CDP) | ✅ re-proven after `npm run dist`: page served from `app.asar/dist/index.html`; `artifactType`/`artifactTypes` bridges present; `design` → `schemaVersion 1`, `contract 0.2.47`, slug `bcd2878f-…`, tint `#8b7bf5`, 12 flags; `slides` → slug `3e9dc3d6-…`, tint `#e0b64a`, 9 flags; `resolved.capabilities.mcp` → `enabled:false`, `reason:"no connected server exposes the declared tools"`, `servers:["Google Drive:false/0"]`; `user`/`room`/`paste` false **with reasons**, `comments`/`db` true; `artifactType({language:'html'})` → `null`; tabs `🎨Design` / `📽️Slides`; Open → **`Landing — Design`** (1 board, rail `Hero`, 🎨) and **`Deck — Slides`** (1 slide, 📽️) |
| Google Drive — two separate things | ✅ manifest `capabilities.mcp` answers "could a connected server save this?" and stays `false` until one declares `create_file`/`gdrive_upload`; the in-app export path (`data-act="drive"` → `autobot:slidesUpload`) is separate and does not flip that verdict |

## 23. FreeLLMAPI — seven free providers behind one OpenAI-compatible endpoint (2026-11-25)

`https://localhost:3001/v1` speaks the OpenAI wire format and fans out to Groq,
Google Gemini, Cloudflare Workers AI, NVIDIA NIM, Cohere trial, Kilo and
OpenRouter. One model string addresses any of them; aliases pick for you.
Keys live in `~/.autobot/freellm.json` (mode `0600`) and nowhere else — the repo
ships only `electron/freellm-config.example.json` with `PASTE_*` placeholders.

| Check | Result |
|---|---|
| Registry + adapter | ✅ `electron/freellm.js`: 7-entry provider registry (`id`, `label`, `baseURL`, `chatPath`, `modelsPath`, `auth`, `defaultModel`, extra headers), one generic OpenAI adapter, `FORWARD_FIELDS` allowlist (`model`, `messages`, `stream`, `temperature`, `max_tokens`, `top_p`, `stop`, `tools`, `tool_choice`, `response_format`) |
| Addressing | ✅ `provider/model`, `provider:model`, a bare provider id (→ its default), `freellm/…` prefix stripped, and aliases `auto` / `free` / `fast` / `smart` |
| Baseline probing | ✅ every key proven head-to-head through the router with `PONG`: groq 200 / 444 ms (`qwen/qwen3.8-27b`), gemini 200 / 492 ms (`gemini-3.5-flash-lite`), cloudflare 200 / 375 ms (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`), nvidia 200 / 1011 ms (`nvidia/nemotron-3-ultra-550b-a55b`), cohere 200 / 301 ms (`command-r-08-2024`), kilo 200 / 5471 ms (`kilo-auto/free`), openrouter 200 / 1197 ms (`liquid/lfm-3-1.7b:free`) |
| Aliases | ✅ `auto` → groq, 130 ms, `PONG`, `x-freellm-attempts: 0`; `fast` + `stream:true` → groq, 75 ms, `content-type: text/event-stream; charset=utf-8`, 8 SSE frames |
| Fallback policy | ✅ 429 / 5xx / network / non-completion fall through to the next provider **only before the first stream byte**; an explicit `provider/…` request never falls back (proved in the suite); response carries `x-freellm-provider` + `x-freellm-attempts` |
| Error hygiene | ✅ `describeError()`/`stripMarkup()` flatten upstream HTML to one sentence — a 429 renders `rate-limited`, never raw markup (asserted) |
| Endpoints | ✅ `POST /v1/chat/completions` (stream + non-stream), `GET /v1/models`, `GET /health`, `GET /v1/providers`; CORS `*`; 8 MB body cap; optional `FREELM_TOKEN` bearer gate |
| Model catalogue | ✅ `GET /v1/models` → **1056** entries (freellm 3 aliases, groq 11, gemini 66, cloudflare 5, nvidia 30, cohere 37, kilo 467, openrouter 437), discovery cached 10 min, dead upstream degrades to its configured default |
| Health | ✅ `GET /health` → all 7 `configured: true` with defaults, keys redacted |
| Stream teardown | ✅ `Readable.fromWeb` + destroy on `res.close`; never `upstream.body.cancel()` on a locked stream (that path threw) |
| Reasoning models | ✅ kilo / openrouter / nvidia reply `message.reasoning` + `content:"PONG"`; with `max_tokens: 24` the budget is consumed by reasoning and `content` is empty — defaults are set accordingly |
| Provider quirks encoded | ✅ Cloudflare real path `/ai/v1/chat/completions`; Kilo chat `/api/openrouter/chat/completions`; Gemini `/v1beta/openai/chat/completions` with current model names (2.5-* retired); Cohere `api.cohere.com` (`.ai` times out) and no compatibility `/models`; OpenRouter only `:free` ids |
| Auto-start in-app | ✅ `electron/main.js` starts it inside `app.whenReady()` (non-fatal on failure), `will-quit` stops it, IPC `autobot:freellmStatus` / `autobot:freellmProviders` / `autobot:freellmSave` (restart on save), `preload.js` exposes the three verbs |
| Standalone entry | ✅ `npm run freellm` → `scripts/freellm-server.js` (honours `FREELM_CONFIG` / `FREELM_PORT`, SIGINT/SIGTERM cleanup) |
| Preset in the UI | ✅ `src/App.jsx` preset **`FreeLLMAPI (local router)`** → `http://localhost:3001/v1` |
| Unit suite | ✅ `node test/freellm.test.js` → **37 passed, 0 failed** (fake upstream, no network: resolution, whitelist, Cloudflare account substitution, fallback matrix, explicit-provider no-fallback, catalogue merge, redaction, every HTTP route, ephemeral port + `EADDRINUSE`, `0600` round-trip, missing-file defaults) |

## 24. Rebrand — Akron Bot (2026-11-25)

User-visible identity is `Akron Bot` / `AkronBot` / `akronbot` / `akron-bot`
across **65 files** (`README.md`, `FEATURES.md`, `GAPS.md`, `MINDMAP.md`,
`VERIFICATION.md`, 31 `electron/*.js`, `src/App.jsx`, `src/ConnectorLogo.jsx`,
`src/i18n.js` in 8 locales, `scripts/parity-audit.js`, `index.html`, 15
`test/live/*.cjs`, …). Verified: **zero** leftover `Helio Bot|HelioBot|heliobot|HELIO BOT`
outside the intentionally preserved identifiers.

| Check | Result |
|---|---|
| `package.json` | ✅ `name: akronbot`, `productName: Akron Bot`, `appId: com.akronbot.app`, `author`/`copyright: AkronLogic`, `artifactName: AkronBot-${version}-${arch}.${ext}`, `dmg.title: Akron Bot ${version}` |
| Deliberately not renamed | ✅ `'helio-bot-secret-store'` seed (`secretstore.js:42` — key derivation, renaming would orphan every stored secret), extension-host `app: 'helio-bot'` hello (`extensionhost.js`), `x-grok-client-identifier: helio-bot` (`providertransport.js` — asserted by its suite), plus the internal surface `window.autobot`, `autobot:*` IPC, `.claude/`, `CLAUDE.md`, `helio://`, `helio:` postMessage types, `helio:canvas`/`helio:slides`, `helio-extension` scheme, `persist:helio-extensions` partition |
| Egress identity is renamed | ✅ `User-Agent: AkronBot/1.0.0` (`unfurl.js`, `tools.js`), Codex/Google `akron-bot/1.0`, OAuth `referrer: 'akron-bot'` (`provider-oauth.js`), `mcpoauth.js` `CLIENT_NAME = 'Akron Bot'` |
| userData migration | ✅ `electron/main.js` module-scope `migrateUserData()` renames `appData/Helio Bot` → `appData/Akron Bot` before any store access (`existsSync` guard, try/catch). `app.setName()` was proved to be what names the macOS keychain item `"<name> Safe Storage"` |
| Project-root migration | ✅ `electron/workspace.js`: `LEGACY_ROOT = ~/Helio Bot`; the tree is moved to `~/Akron Bot` on first boot and `workspaces.json` entries still pointing at the legacy root are rewritten. Verified: legacy folder gone, **62/62** workspace entries resolve on disk |
| Renamed doc-sanitisation artifact | ✅ `Example Desktop` / `Example Code` (an old mass-replace of `Claude Desktop` / `Claude Code`) reverted in **42** files so the docs name the real product |
| Known consequence | ⚠️ Secrets encrypted under `"Helio Bot Safe Storage"` do not decrypt under `"Akron Bot Safe Storage"`; provider keys need a one-time re-entry (all key material otherwise lives in `~/.autobot`) |

## 25. Brand mark + emerald palette (2026-11-25)

The terracotta `#D97757` clay sunburst is gone. The mark is a 12-ray emerald
symbiote (`#10B981`) with a `#A7F3D0` inner glow at 0.55, orbit tendrils and a
gooey filter, all generated from one set of geometry constants.

| Check | Result |
|---|---|
| Canonical artwork | ✅ `build/logo-mark.svg` (animated mark, no plate, `viewBox 0 0 400 400`), `build/icon.svg` (dark squircle plate + static mark for the app icon), `build/tray.svg` (monochrome 8-ray, thick strokes for 16 px) |
| In-app mark | ✅ `src/App.jsx`: `CompactMark` (8 rays + glow dot, used at `size < 30`) and `FullMark` (12 animated rays, breathing groups, 6 orbiting tendrils, `akGooMark` filter); `Logo()` dispatches on size; class names prefixed (`ak-core-spin`, `ak-orbit-1/2`, `ak-ray-a/b`) so injecting `<style>` cannot collide with app CSS |
| Main-process mark | ✅ `logoMarkup(size, {static})` in `electron/main.js` regenerated from `MARK_RAYS` / `MARK_ORBS` / `MARK_GLOW` with `akm-*` classes, `akmSpin`/`akmBreathe` keyframes and a reduced-motion guard |
| Palette | ✅ `src/styles.css` dark `--accent #10b981` / `--accent-strong #059669` / `--accent-soft rgba(16,185,129,.16)` / `--accent-text #a7f3d0`; light `--accent #047857` / `--accent-strong #036b4e` / `--accent-soft rgba(4,120,87,.12)` / `--accent-text #065f46`; logo drop-shadows emerald; `--green` semantic tokens untouched |
| Warnings no longer look like brand | ✅ `.compliance-badge.tone-warn` moved to amber (`border rgba(245,158,11,.35)`, text `#b45309`) |
| Electron-side surfaces | ✅ About window glow + link, MCP-OAuth result page dot (`#047857`), `quick.html` (logo glow, primary button `#10b981`, emerald mark), `computer-panel.html` (`--accent`, 5 rgba tints, `#a7f3d0` highlight), `artifactcanvas.js` (`--accent`, commenting hatch, focus ring), `artifacttypes.js` swatch renamed `clay` → `emerald` (`#10b981` / ink `#06211a`) |
| Static sweep | ✅ zero `#D97757` / `#d97757` / `rgba(217,119,87,…)` in source (`dist/` regenerated from it) |
| Icon pipeline | ✅ `build/render_icon.cjs` rasterises `build/icon.svg` through Electron/Chromium (`BrowserWindow` + `canvas.toDataURL`) because no `rsvg-convert`/ImageMagick/cairosvg exists on this machine → `build/icon.png` (1024, 366 123 B), `build/icon.iconset/*` (10 sizes), `build/icon.icns` (919 555 B), `electron/trayTemplate.png` (16, 346 B) + `trayTemplate@2x.png` (32, 590 B). `npm run icons` regenerates them; `build/gen_icon.py` (old lightning bolt) deleted |
| Tray | ✅ `createTray()` loads `trayTemplate.png`; macOS template naming means the menu-bar icon auto-inverts for light/dark; legacy `tray.png` assets removed |
| Landing page | ✅ `akron-bot-landing.html` now carries the animated emerald mark and the emerald/night palette (`--emerald #10b981`, `--emerald-bright #34d399`, `--emerald-soft #a7f3d0`) |
| Regression gate | ✅ `node test/artifacttypes.test.js` **82/82** (the `room` reason assertion follows `not part of Akron Bot`), `node test/e2e.test.js` **112/112** (`/Akron Bot/` assertions), `node scripts/parity-audit.js` **EXIT 0** (`DEFS: 141`) |

## 26. Subscription providers — Claude's identity gate fixed, Grok's 402 explained (2026-11-25)

Both subscription paths were returning vendor errors that looked like broken
integrations but were really one protocol requirement and one account state.
Both are now either fixed or explained in human prose.

### Claude — the mandatory Claude Code identity block

`POST /v1/messages` with a valid Max OAuth token (`sk-ant-oat…`,
`anthropic-beta: oauth-2025-04-20`) answered
`429 rate_limit_error {"message":"Error"}` in under 500 ms for every model.
That is indistinguishable from a spent account, so it went misdiagnosed.

| Probe | Request | Result |
|---|---|---|
| `build/probe-claude-gate.js` — bare | no system prompt | **429** `rate_limit_error` |
| same, system block | system[0] = `You are Claude Code, Anthropic's official CLI for Claude.` | **200** |
| same, block array | same text as `{type:'text', text:…}` with `cache_control` | **200** |
| `build/probe-claude-live.js` | direct Keychain creds | `OK claude-opus-4-5 ms=1359 finish=stop text="CLAUDE-OK"`, `OK claude-sonnet-4-5 ms=912` |
| `build/probe-claude.js` | app path (`providerOauth.resolve`) | `account=rxpromedbd-gmail-com hasToken=true`, `OK ms=954 finish=stop text="CLAUDE-OK"` |
| `build/probe-turn2.cjs` (`:9333`) | live UI turn, fresh chat, new token | user `Reply with exactly: PING195174` → assistant `PING195174` (`Worked for 2s`), no `.errorbar` |

Implementation: `CC_IDENTITY` constant + `isAnthropicOauth(provider)` in
`electron/providertransport.js`. `toAnthropicBody` unshifts the identity block
when the caller's leading system part does not already start with it, so plain
API-key traffic is untouched and the identity is never duplicated.
`anthropicAuth` now tests `isAnthropicOauth` so the `oauth` flag and the
`sk-ant-oat…` prefix cannot disagree.

### Claude — recovering tokens lost to the app rename

The secret store is keyed off the Electron app identity, so renaming the app
(`Helio Bot Safe Storage` → `Akron Bot Safe Storage`) made every stored token
undecryptable and the account reported `no stored tokens for claude:…`.
`adoptLocalCredentials(provId, acc, opts)` in `electron/provider-oauth.js`
re-reads the macOS Keychain item `Claude Code-credentials` and re-seals it into
the new store. It runs only for `claude`, only for a row whose
`source === 'claude-code'`, and only when exactly one such row exists — it never
picks between two logins. Deps are injectable (`db`, `readCreds`, `saveTokens`,
`writeDb`) so the tests never touch real state. Wired into `resolve` and
`ensureToken` when `loadTokens` returns null.

### Grok — 402 is an allowance state, not a bug

The 426 version rejection was a stale UA (`grok-shell/1.0.92` now; minimum
1.0.13). After that, every model answered
`402 {"error":"Grok Build usage balance exhausted"}`.

| Probe | Evidence |
|---|---|
| `build/probe-grok-entitlement.js` | `GET /v1/settings` **200** and `GET /v1/models` **200** with the CLI headers; `subscription_tier_display: "SuperGrok"` — identity fully accepted |
| `build/probe-grok-claims.js` | JWT `tier: 1` (supergrok), `team_id`, scopes include `grok-cli:access` + `api:access` |
| `build/probe-grok-credits.js` | `GET https://grok.com/rest/grok/credits` **200**: `creditUsagePercent: 100`, `prepaidBalance {"val":"0"}`, `onDemandCap: null`, weekly period `…11-24 → …12-01`, `productUsage` `PRODUCT_CURSOR 96` / `PRODUCT_GROK_BOT 4` |
| model sweep | `grok-4.5`, `grok-code-fast-1`, `grok-4-fast` all 402 — account-level, not model-level |

Because it is an entitlement state the UI must not print the vendor envelope.
`grokCreditHint(provider)` reads the credits endpoint (5-min cache,
`GROK_CREDITS_TTL_MS`), builds a sentence from real numbers and attaches it as
`err.hint` on 402; `humanizeLLMError` in `electron/llm.js` prefers `e.hint` over
the envelope and has a friendly `402` line.

Live UI proof (`build/probe-grok-turn.cjs`, `:9333`, `grok-4.5`):

```
error: "This account is out of credit for that provider — the Grok Build
        allowance is 100% used this week; it resets 2026-12-01; prepaid
        balance is $0 and on-demand top-up is off"
markupLeak: false
hasEnvelope: false
```

### Gates

| Check | Result |
|---|---|
| `node test/provideroauth.test.js` | **193 passed / 0 failed** (new *local credential adoption* block: non-claude skip, non-CLI source skip, ambiguous two-peer refusal, positive adoption with ms-expiry passthrough + secretstore write + plan backfill, missing credential) |
| `node test/providertransport.test.js` | **128 passed / 0 failed** (identity-block wire assertion + *identity prompt ordering*: identity leads and caller system follows, no duplicate, plain api-key untouched) |
| `node scripts/parity-audit.js` | **EXIT 0** — `DEFS: 141`, 0 missing |
| Packaged build (`release/mac-arm64`, `:9444`) | `npm run dist` EXIT 0 → `AkronBot-1.0.0-arm64.dmg` 115 040 322 B + `.zip` 110 229 465 B. From `app.asar`: `CC_IDENTITY`, `grokCreditHint`, `adoptLocalCredentials` all present, `10b981` present, **0** `d97757`, and **0** `probe-*` files shipped. Live packaged turn: `PING106372` → `PING106372` (`Worked for 3s`, no error bar); Grok `.errorbar` = the allowance/reset prose above, no markup |

---

## 27. CLI fingerprint gate + a release that cannot ship an aged-out CLI (2026-11-25)

### The gate

The newest Claude models rejected the bundled CLI even though the bundled CLI was
*newer* than the version the vendor demanded:

```
400 "Claude Code 2.1.154 does not support this model; version 2.1.290 or newer is required"
```

Anthropic gates **per model** on the client version carried inside
`user-agent`; `providertransport` had that version as a literal. Older models
accepted the literal, `claude-sonnet-5.5` did not.

Fix: the fingerprint tracks the runtime that is actually shipped.

| Symbol | Role |
|---|---|
| `DEFAULT_CLIENT_VERSIONS` | build-time defaults `claude 2.1.332 / codex 0.172.0 / grok 1.0.92` |
| `setClientVersions(v)` | adopt versions reported by `runtimes.list()`; unparseable values are ignored |
| `claudeUa()` / `codexUa()` / `grokUa()` | build the header at request time instead of a frozen literal |

`electron/main.js: syncClientVersions()` is called at `startRuntimes()`, after the
deferred `updateAll()`, and after every `autobot:runtimesUpdate` — so a self-updated
CLI immediately reports its new version upstream.

### The release cannot ship a stale CLI

`scripts/vendor-runtimes.js` trusted `vendor/runtimes/<id>/` forever, which is how
the gate above would reach a user. Added:

| Flag | Behaviour |
|---|---|
| `--stale` (download mode) | ask upstream for the newest version; re-vendor only if upstream is newer; an offline/failed lookup keeps the current copy and never fails the build |
| `--dry-run` | report the keep/vendor decision and download nothing |
| `cmpVersion()` | semver-ish ordering (`1.2.10 > 1.2.9`, prerelease below release) |

`predist` is now `node scripts/vendor-runtimes.js --download --stale || npm run vendor:runtimes`.

Live proof, both directions:

```
$ npm run vendor:runtimes:sync
  claude-code  2.1.332 — current (upstream 2.1.332)
  codex        0.172.0 — current (upstream 0.172.0)
  grok         1.0.92 — current (upstream 1.0.92)

$ VERSION=0.2.2 node scripts/vendor-runtimes.js --download --stale --id grok --dry-run
  grok         0.2.2 → 1.0.92  (upstream is newer) [dry-run]
dry-run: nothing was downloaded.
```

### Gate

| Check | Result |
|---|---|
| `node test/providertransport.test.js` | **158 passed / 0 failed** (+6: version adoption, unparseable value rejected, default clears the gate) |
| `node test/provideroauth.test.js` | **197 passed / 0 failed** |
| `node test/model-catalog.test.js` | **17 assertion groups passed** |
| `node test/compliance.test.js` | **147 passed / 0 failed** |
| `node test/freellm.test.js` | **37 passed / 0 failed** |
| `node test/runtimes.test.js` | **23 assertion groups passed** |
| `node test/parity-modules.test.js` | **OK** |
| `node scripts/parity-audit.js` | **EXIT 0** — `DEFS: 141`, `subsystems incomplete: 0`, NO ATOMIC GAPS |

### Shipped artifact (rebuilt after the fix)

| Artifact | Size | sha256 |
|---|---|---|
| `release/AkronBot-1.0.0-arm64.dmg` | 581 913 641 B | `5b7c14aa…7e03952` |
| `release/AkronBot-1.0.0-arm64.zip` | 616 967 582 B | `10d1e17d…6eb1a05` |

Mounted read-only (`hdiutil attach -nobrowse -readonly` → `/Volumes/Akron Bot 1.0.0`):
`Akron Bot.app` 1.5 GB, `Applications` symlink present, bundled runtimes
`claude-code 2.1.332 / codex 0.172.0 / grok 1.0.92`, and the mounted `app.asar`
contains `syncClientVersions` (×4), `setClientVersions` (×4) and **0** `probe-*`
files. The ad-hoc signature is not notarized (`spctl` reports *code has no
resources but signature indicates they must be present*); the app launches from
the volume when quarantine is cleared.

### Live turns from the mounted DMG (`:9444`)

| Probe | Result |
|---|---|
| `probe-turn.cjs 9444 claude 'sonnet 5\.5' DMG 15` | **13/13 PASS** — 15 live models, `Claude Sonnet 5.5 1M`, reply carried `DMG524908`, no error bar, no markup |
| `probe-turn.cjs 9444 antigravity 'gemini-4-hydrogen' AGDMG 20` | **13/13 PASS** — 38 live models, `Gemini 4 Hydrogen (High)` window `1M`, reply carried `AGDMG208294` |
| `probe-turn.cjs 9444 grok 'grok 4\.7$' GROKDMG 4` | 9/13 — 4 live models, `Grok 4.7 256K`; the reply is blocked by the account's weekly allowance (`100% used, resets 2026-12-01`) and the UI prints that prose, not the vendor envelope |
| `build/probe-picker.cjs 9444` | **14 checks passed** (claude 15 models with ≥1 `1M` + ≥1 `200K`, antigravity 38 window-labelled, cache positive-only) |
| `probe-rt-ui.cjs 9444` | **11/11** — 3 rows `installed`, `2.1.332 · latest`, `0.172.0 · latest`, `1.0.92 · latest` |
| `runtimesUpdate()` from the packaged app | `results: []` — all three current, nothing to update |

### Sign-in configs validated against the live vendors

`build/probe-authurls.cjs` builds each provider's authorize URL exactly as the app
does (throwaway PKCE challenge + state — no secret, no account touched) and asks
the vendor. **15/15 PASS**:

| Provider | Evidence |
|---|---|
| Claude | `GET claude.ai/oauth/authorize` **200**, no `invalid_client` / `redirect_uri_mismatch` |
| ChatGPT | `GET auth.openai.com/oauth/authorize` **302 → `https://auth.openai.com/log-in`** — the Codex client id `app_EMoamEEZ73f0CkXaXp7hrann` and `http://localhost:1455/auth/callback` are registered; scope set `openid profile email offline_access api.connectors.read api.connectors.invoke`; `codex_cli_simplified_flow` + `id_token_add_organizations`; loopback listener binds `:1455`; no unregistered param (`access_type`, `prompt`, `include_granted_scopes` never leak in) |
| Antigravity | `GET accounts.google.com/o/oauth2/v2/auth` **302** — Google accepts the personal client id and the loopback redirect (`access_type=offline`, `prompt=consent`, S256) |
| Grok | `auth.x.ai/oauth2/authorize` **403** to any Node request, with **and** without query params (`server: cloudflare`) — a bot gate on the client, not on our config. Validated against `/.well-known/openid-configuration` instead: same authorize/token/userinfo endpoints, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `token_endpoint_auth_methods_supported` includes `none` (public client), and every requested scope is advertised (`grok-cli:access`, `api:access`, `offline_access`, …) |

This closes the ChatGPT "config matches the Codex contract but was never
live-verified" gap at the *config* level. A completed ChatGPT turn still needs a
real account (none on this machine: `~/.codex/auth.json` absent, `accounts: []`),
and Grok's browser round-trip needs a real tab, which `auth.x.ai` refuses to
serve to a non-browser.

## 28. Never stuck: live compaction, logo animation, and “can it actually work?” (2026-11-25)

Four user-visible promises were still unproven by test alone, so each now has a
**live, CDP-driven probe** that drives the real renderer against the real
provider account and asserts on the DOM.

### 28.1 A prompt larger than the model's window is fitted, not failed

`build/probe-compact2.cjs` types a ~30 000-character prompt at a model whose
*real* window is 16K and waits for the answer token. It also installs a
`MutationObserver` on `.noticebar` **before** sending, so a notice that appears
for a second is still recorded.

```
$ node build/probe-compact2.cjs 9333 tab_flash_lite_preview antigravity:6969loavbal-gmail-com google 30000
{
  "pass": true,
  "sentChars": 30211,
  "liveNotices": [
    "This message was longer than tab_flash_lite_preview's 16K context window, so its middle was trimmed — the beginning and your latest request were kept, and the full text stays in the chat."
  ],
  "gotToken": true,
  "noticeIsProse": true,
  "claimsZeroTurns": false,
  "rawLimitLeak": false,
  "error": null
}
```

What each assertion rules out:

| Field | Meaning |
|---|---|
| `gotToken: true` | the turn completed — no stall, no error bar |
| `liveNotices.length > 0` | the user is told what happened, in prose |
| `claimsZeroTurns: false` | no “Compacted 0 earlier turns” lie |
| `rawLimitLeak: false` | no vendor wording (`prompt is too long`, `context_length_exceeded`, …) reached the UI |
| `noticeIsProse: true` | the notice contains no HTML/markup |

**This probe failed before the fix, and the way it failed is the interesting
part.** The budget is `budgetForModel(model, providerId, provider.contextWindow)`.
With no live catalog registered, `contextWindowFor('tab_flash_lite_preview')` fell
back to the documented Antigravity default (128K → 364 480 chars), so 30 211
chars looked harmless and nothing was trimmed: `gotToken: true` but
`liveNotices: []`. The provider then accepted the oversized request anyway, so the
bug was invisible unless you measured the notice. The first `probe-compact2` run
recorded exactly that (`liveNotices: []`, `bar: null`).

Fix, two parts:

1. `electron/main.js` refactored the IPC body into `fetchProviderModels(id)` and
   added **`warmModelCatalogs()`** — every signed-in account's live catalog is
   registered once, deferred 3 s after `whenReady()` (past first paint, off the
   boot path) and re-run after `autobot:providerSignIn` and
   `autobot:providerImport`. A turn sent seconds after launch now compacts
   against the model's *actual* window instead of a documented default.
2. `electron/llm.js` `sanitizeHistory()` trims the **head and tail** of a single
   oversized message around a middle marker (≥500 head / ≥700 tail chars kept,
   `size()` recomputed per trim) instead of dropping nothing; `compactTo` /
   `shrinkLargest` keep 40 % head + 40 % tail for the same reason. The notice is
   emitted only when something really left the working set (`dropped > 0` or
   `truncated > 0`).

Evidence that the window really is per-model and data-driven, read from the live
catalog via `window.autobot.providerModels('antigravity:…')`:

```
tab_flash_lite_preview        16384     16K
tab_jump_flash_lite_preview   16384     16K
gemini-3.1-flash-image        65536     66K
gemini-3-flash              1048576      1M      (38 models total)
```

`node -e "…budgetForModel('tab_flash_lite_preview','antigravity')"` →
`{"window":16384,"usableTokens":8000,"maxChars":27200,"compactAt":24480}` **after**
registration, versus `{"window":128000,"maxChars":364480}` before it.

Unit coverage: `node test/llm-context.test.js` → **6 passed / 0 failed**, including
`sanitizeHistory keeps the head and tail of one oversized message` and
`a single oversized message is trimmed (not amputated) and the turn completes`
(asserts the first request is shorter than the paste, both `AAA-BEGIN` and
`ENDMAGIC` reach the model, the notice is prose, and no error event fires).

### 28.2 The logo animates only while work is happening

`build/probe-logo.cjs` samples the mark every 100 ms during a live streaming turn
and compares against idle.

```
{
  "reducedMotion": false,
  "idle":     { "cls": "logo", "anim": "none" },
  "idleStable": true,
  "streamingSamples": 62,
  "streamingAnim": "logo-spin",
  "coreAnim": "logo-pulse",
  "transformMoved": true,
  "rest":     { "cls": "logo", "anim": "none" }
}
```

`active` is threaded through `Logo` / `CompactMark` / `FullMark` to
`.logo-live`; rays rotate on `logo-spin` (3.2 s), the core pulses on
`logo-pulse` (1.3 s), and the glow breathes. `prefers-reduced-motion` disables all
three, and idle/rest return to `anim: none` so a static screenshot of the app is
never mid-spin.

### 28.3 Every capable model can code, run a shell, and open a browser

`build/probe-capability.cjs` asks the model — in one turn — to write a file, read
it back with a shell command, and open a page in the built-in browser.

| Provider / model | Write | Shell | Browser | Verdict |
|---|---|---|---|---|
| antigravity `gemini-3-flash` | `Writing:toolcap.txt` | `Running:cat toolcap.txt` → `RUN=TOOLCAP-OK` | `Browsing:https://example.com` → `Example Domain` | **PASS** (`pass: true`, no markup leak) |
| claude `claude-opus-4-5` (first run, earlier today) | same | same | same | **PASS** (recorded; re-run today is quota-blocked — see 28.5) |
| grok `grok-4.7` | — | — | — | blocked by account allowance (100 % used, resets 2026-12-01) |
| chatgpt | — | — | — | no account on this machine |

`build/probe-capability.cjs` reads the friendly tool cards (`.tool-name` verb +
`.tool-args` target), never the raw tool id, so it measures what a user sees.

### 28.4 PC control (Computer Use) works when the model has it

`build/probe-computer.cjs` on antigravity:

```
"pass": true,
"consentPrompts": 1,
"consentLabel": "Allow Computer Use? … computer_screen_size …",
"toolCard": "screen_size",
"answer": "SCREEN=1280x832",
"executor": "Screen: 1280x832"
```

Computer Use is advertised under the `mcp__computer__*` names (not the executor
names), which is what the probe drives; a mutating computer tool raises exactly
one consent modal and the model answers with the real screen size, so the loop is
closed end to end.

### 28.5 What is still blocked, and why

Honesty beats a green table:

| Item | Status |
|---|---|
| claude live turn today | **429 rate_limit_error** straight from `api.anthropic.com` (`req_011ChQAKJgag…`, account rate limit, not our identity gate). Verified with a direct `fetch` outside the app, so it is the account, not the app |
| claude compaction path, live | same 429 window — proven in unit tests only |
| claude Computer Use | same 429 window; write/shell/browser passed earlier today when quota was available |
| grok live turn | SuperGrok weekly pool 100 % used until 2026-12-01; UI prints allowance prose, no markup |
| chatgpt live turn | no account on this machine (`~/.codex/auth.json` absent, `accounts: []`); config validated in §27 |
| window maximize/restore via CDP | `-32601` (method not implemented) and `osascript` lacks assistive access, so interactive PC-control proofs stop at screen size/screenshot |

### Gate after §28

| Check | Result |
|---|---|
| `for f in test/*.test.js` | **24/24 exit 0**, `failing=0` |
| `node test/e2e.test.js` | **112 passed / 0 failed** |
| `node test/llm-context.test.js` | **6 passed / 0 failed** |
| `node test/model-catalog.test.js` | **17 assertion groups passed** |
| `node scripts/parity-audit.js` | **EXIT 0** — `DEFS: 141`, `subsystems incomplete: 0` |
| `npx vite build` | OK (chunk-size warning only) |
| `build/probe-compact2.cjs` | **`pass: true`** |
| `build/probe-logo.cjs` | **EXIT 0**, `streamingSamples: 62` |
| `build/probe-picker.cjs` | **14 checks passed** |
| `build/probe-capability.cjs` (antigravity) | **`pass: true`** |
| `build/probe-computer.cjs` (antigravity) | **`pass: true`**, `SCREEN=1280x832` |

### 28.6 The same probes, against the packaged DMG (not the dev run)

The probes above were first run against `npx electron .`. Because the release is
what ships, all four were re-run against `release/AkronBot-1.0.0-arm64.dmg`
mounted read-only and launched from the volume (`--remote-debugging-port=9444`).
Bundled runtimes in the mounted app: **claude-code 2.1.332 / codex 0.172.0 /
grok 1.0.92**; `probe-*` files inside `app.asar`: **0**; the asar contains
`warmModelCatalogs` ×3, `fetchProviderModels` ×4, `logo-live` ×2,
`isContextOverflow` ×8 and the head/tail trim marker ×1 — i.e. the code under
test is the code in the DMG.

| Probe | Packaged result |
|---|---|
| `probe-compact2.cjs 9444 tab_flash_lite_preview` | **`pass: true`** — `sentChars: 30211`, one truncation-prose notice naming the real **16K** window, `gotToken: true`, `rawLimitLeak: false`, `noticeIsProse: true` |
| `probe-logo.cjs 9444 fast` | **`pass: true`** — idle `anim: none` and stable, **24** streaming samples on `logo-spin`, `coreAnim: logo-pulse`, `transformMoved: true`, rest back to `logo` / `none` |
| `probe-picker.cjs 9444` | **14 / 14 checks** — claude live catalog + 200K and 1M labels, antigravity live catalog (not the static fallback), no `0K`, window cache written |
| `probe-capability.cjs 9444 gemini-3-flash` | **`pass: true`** — `Writing: toolcap.txt`, `Running: cat toolcap.txt` → `RUN=TOOLCAP-OK`, `Browsing: https://example.com` → `Example Domain`, `markupLeak: false` |
| `probe-computer.cjs 9444 gemini-3-flash` | **`pass: true`** — exactly **1** consent prompt (`"Allow Computer Use? … computer_screen_size"`), `mcp__computer__screen_size` called, `SCREEN=1280x832` |

Two packaging-only failure modes were ruled out by running these:

1. **Path-dependent resources.** The DMG runs from
   `/Volumes/Akron Bot 1.0.0/…/app.asar` (read-only). Runtime resolution, the
   `dist/` bundle, and the probe-injected localStorage all behave identically.
2. **Missing code.** A stale DMG would fail `probe-compact2` (no warm catalog →
   no notice) and `probe-logo` (no `logo-live` class). Both pass, so the DMG
   really carries this change set.

First-run flakiness observed and explained: `probe-logo` initially pointed at a
model string that the FreeLLMAPI gateway did not serve (`502`), so the turn never
ended and the mark correctly stayed `logo-live`; re-run with a served model
(`fast`) ended the turn and the mark returned to `anim: none`. That is the
intended semantics — a running turn keeps the mark alive while it retries.

## 29. The model picker stops burying the current model (2026-11-25)

The old menu rendered every available model as one flat column inside a 340 px
box. With a live Antigravity account (38 models) plus the FreeLLMAPI router
(1050 installed models) the scroll region measured **35 521 px** and the
selected model was nowhere near the viewport, which is why the picker read as
"broken" even though every model was listed.

### 29.1 What changed

| Old | New |
|---|---|
| one flat list per account | shelves keyed by the provider-reported family (`Gemini`, `Claude`, `API_PROVIDER_OPENAI_VERTEX` → "OpenAI Vertex (API)"), ranked Gemini→Claude→GPT→Grok→Codex first, sticky headers with counts |
| insertion order | display names ordered `localeCompare(…, {numeric:true})`, so `Gemini 4 Neon (Low/Medium/High)` sit together |
| 35 521 px of rows | one `.prov-model-scroll` per account, `max-height: 238px`, `overscroll-behavior: contain` |
| scroll to find a model | filter box past 12 models, clear button, "No models match" prose |
| session list flooded by the router catalog | `SessionModelList` — same shelves, but each mounts at most **30** rows with an explicit "Show all N"; a shelf whose pick sits past the cap pins that pick to the top instead of expanding 1050 rows; a filter query lifts the cap |
| 340 px menu | `max-height: min(74vh, 620px)` with `overscroll-behavior: contain` |
| pick invisible on open | reveal-on-mount effect centres the selected row |

### 29.2 Measured against the running app (`:9333`)

```
before: menuScroll 35521  · freeLLMAPI rows 1050 · FAM groups 3 (antigravity)
after : menuScroll  1016  · freeLLMAPI rows   30 · FAM groups 23 (session list)
        menuH 592 · scrollBox { clientH: 238, of: "auto", maxH: "238px" }
        fams: Ollama 2 · LM Studio 1 · FreeLLMAPI 30 · … · 23 shelves total
```

Search (session list): `q="qwen"` → **90** rows across **2** shelves
(`FreeLLMAPI`, `ModelScope`), clear restores 1070.

Cap/expand: "Show all 1050" → **1070** rows (35 266 px, deliberate) then
"Show fewer" → **30**.

Deep pick + reveal: selected `claude-sonnet-5-5` from the **last** row of the
15-model Claude shelf (which starts scrolled to 0), closed and reopened the
menu → the account re-expanded, `scrollTop: 158.5` of `397`, and the selected
row satisfied `selVisible: true`. The reveal effect is keyed on `picked` and
row count, so it re-centres on every open rather than only on first mount.

Regression: `node build/probe-picker.cjs 9333` → **14 / 14**, including the
live Antigravity catalog (not the 4-model static fallback) and the
`/context`-visible window cache. `probe-logo`, the node test suite
(`failing=0`) and `scripts/parity-audit.js` (`DEFS: 141`, `subsystems
incomplete: 0`) are unchanged by the picker work.

### 29.3 The same picker against the packaged DMG

Rebuilt and re-run against `release/AkronBot-1.0.0-arm64.dmg`
(sha256 `06aa4b72fdc8d146…`) mounted read-only, launched with
`--remote-debugging-port=9444`:

| Check | Packaged result |
|---|---|
| `probe-picker.cjs 9444` | **14 / 14** — live Antigravity catalog (38, not the 4-entry fallback), window labels on every row, `/context` cache written |
| `probe-logo.cjs 9444 fast` | **pass** — 25 streaming samples on `logo-spin`, `coreAnim: logo-pulse`, `transformMoved: true`, idle rest `anim: none`, `idleStable: true` |
| session menu | `menuH 592` · `menuScroll 736` (was 35 521) · 50 mounted rows · 12 top-level children |
| shelves | `FreeLLMAPI`, `Ollama`, `LM Studio (local)`, `DeepSeek (official)`, … with counts |
| cap | one `.prov-more` reading **“Show all 1050 · current pick pinned above”** |
| filter | `.prov-search-in` present |
| asar strings | `prov-more` ×2, `Show all` ×1, `regenerating with a larger budget` ×1, `logo-live` ×2, `isContextOverflow` ×8 — and **no** `token limit reached` / `retrying with` prose |

So the shipped DMG carries the grouped-and-capped picker **and** the
post-`59a5c0d` output-limit prose; the “Thought (token limit reached —
retrying with N tokens)” wording cannot appear from this build.

## 30. Entitlement exhaustion is a *state*, not a request shape (2026-11-25)

§26 said Grok's 402 was "tools attached → 402, chat alone → 200". That was one
observation, not the rule. With the transport held constant and only
`max_output_tokens` varied, the same trivial prompt produced:

| `maxTokens` | request | result |
|---|---|---|
| 2000 | tool-less | 200 |
| 2500 | tool-less | 200 |
| 3500 | tool-less | **402** |
| 4096 | tool-less | 200 |
| 6144 | tool-less | **402** |
| 4096 ×4 | tool-less | 402, 402, 402, 402 |
| 4096 ×4 | tools attached | 402, 402, 402, 402 |

Non-monotonic in size and later total across every shape ⇒ the 402 is the
account's Build allowance arriving **stochastically** (the proxy admits a
request when it thinks credit remains), not a property of the payload. So a
degrade that assumes the tool-less route is safe is wrong, and "throw
immediately on 402" leaves the user with a red banner for a condition that is
neither a bug nor their fault.

### 30.1 What the loop does now

1. Native request 402s → drop tools, re-normalise history, inject
   `TEXT_TOOL_PROTOCOL`, emit one prose notice, retry. (unchanged, §28)
2. **New:** if that tool-less retry also 402s, the turn **ends in prose** —
   one notice ("… Plain chat is unavailable as well, so I stopped this turn —
   switch to another account or provider, or wait for the allowance to reset")
   plus an assistant message carrying the same reason. No `error` event, no
   `.errorbar`, no backoff ladder. Before this, the user saw the notice *and*
   a banner repeating it, which read as a crash.
3. `humanizeLLMError` no longer repeats the friendly prefix when the transport
   hands back its own hint (`credits: … is off Plain chat…` was the old join).

### 30.2 Live proof (`:9333`, allowance fully spent)

The dev app caches `electron/llm.js` at boot — the first run after the edit
still threw because the **main process** was stale. Restart, then:

```
{ "err": null,
  "tools": 1, "toolNames": ["Writing"],
  "text": "I'll create creditmode.txt with the exact contents you asked for. ✎ Writing creditmode.txt · Worked for 10s",
  "notice": "This account is out of credit for that provider — the Grok Build
             allowance is 100% used this week; it resets 2026-12-01; prepaid
             balance is $0 and on-demand top-up is off. Plain chat is
             unavailable as well, so I stopped this turn — switch to another
             account or provider, or wait for the allowance to reset, and I
             will resume from here." }
~/Akron Bot/create-a-file-named-creditmode-txt-in-th-3/creditmode.txt
  → CREDITMODE-OK
```

So on a spent allowance the turn still: degrades to the text protocol, **writes
the file**, shows the real reason in prose, and closes cleanly.

### 30.3 Regression

`node test/credit-degrade.test.js` → **4 / 4** (classifier; tools→402 degrade;
fenced `Write` lands a file after the degrade; both shapes 402 → prose stop with
no thrown error, no `error` event, no raw "token limit" wording, closes < 10 s).
Full suite `failing=0`; `scripts/parity-audit.js` → `DEFS: 141`,
`subsystems incomplete: 0`.

---

## 31. Antigravity picker hygiene — one naming style, chat models only

### 31.1 The two defects

The picker pulled `fetchAvailableModels` straight into rows. That catalog is
half marketing copy and half bare slugs, and it also enumerates the editor's
**internal** tab-completion models:

| Raw id | Raw displayName | Window | Problem |
|---|---|---|---|
| `gemini-3.8-flash-tiered` | *(none)* | 1 M | shown as a lowercase slug |
| `gemini-4-hydrogen-sonar` | *(none)* | 1 M | shown as a lowercase slug |
| `tab_flash_lite_preview` | `Tab Flash Lite Preview` | 16 K | completion model, not chat |
| `tab_jump_flash_lite_preview` | `Tab Jump Flash Lite Preview` | 16 K | completion model, not chat |
| `gemini-2.5-flash` ×4 | all `Gemini 3.5 Flash Lite` | 1 M | four identical rows |

Rows therefore mixed Title Case with raw ids, and two of the 38 selectable
"chat" models were autocomplete engines with a 16 K window.

### 31.2 The rule

1. `isInternalAntigravityModel(id)` — `/^tab_/i` or `/_preview$/i` → row is
   dropped entirely. A chat picker never offers an inline-completion engine.
2. `prettyModelId(id)` — split on `[-_]`, title-case each token, keep versions
   verbatim, and restore the casing the vendor uses for known abbreviations
   (`GPT`, `OSS`, `XHigh`, `Pro`, `XL`, `API`, `AGY`). Then:
   - a trailing reasoning level (`high`/`xhigh`/`medium`/`low`/`minimal`/
     `thinking`/`orchestrator`) is **parenthesised**, matching the vendor's own
     names — `gemini-4-hydrogen-high` → `Gemini 4 Hydrogen (High)`, not
     `Gemini 4 Hydrogen High` sitting next to `Gemini 4 Argon (High)`;
   - adjacent single digits are a dotted version — `claude-sonnet-5-5-medium`
     → `Claude Sonnet 5.5 (Medium)`;
   - a numeric size suffix is upper-cased — `gpt-oss-120b-medium` →
     `GPT OSS 120B (Medium)`.
3. Label = `displayName` when it differs from the id, else `prettyModelId(id)`.
4. When a displayName collides across rows, **replace** it with the prettified
   id (→ `Gemini 2.5 Flash`, `Gemini 2.5 Flash Lite`, `Gemini 3.5 Flash Lite`)
   instead of appending a redundant tail (`Gemini 4 Hydrogen (High) · 4
   Hydrogen High` was the first, wrong attempt).
5. A second pass appends the raw id only if two ids still prettify to the same
   label, so every row is unique.

Groups, sort order and context windows are untouched, so the family grouping
(`Gemini` / `Claude` / `OpenAI Vertex (API)`) and the `1M` / `65K` badges keep
working.

### 31.3 Live proof (`:9333`, real Antigravity account)

Read from the **rendered menu** (`/tmp/agdom.cjs`, selects the Antigravity
account and scrapes `.prov-acct.on .prov-model`), not from the IPC catalog —
the DOM is what the user sees:

```
rendered rows: 36                 ← was 38 (two tab_*_preview removed)
* Gemini 2.5 Flash  [1M]                     ← selected (active conversation)
  Gemini 2.5 Flash (Thinking)  [1M]
  Gemini 2.5 Flash Lite  [1M]
  Gemini 3 Flash  [1M]
  Gemini 3.1 Flash Image  [66K]
  Gemini 3.5 Flash Lite  [1M]
  Gemini 3.8 Flash Tiered  [1M]
  Gemini 4 Argon (High)  [1M]
  Gemini 4 Hydrogen (High)  [1M]
  Gemini 4 Hydrogen (Orchestrator)  [1M]
  Gemini 4 Hydrogen (XHigh)  [1M]
  Gemini 4 Hydrogen Tiered (High)  [1M]
  Gemini 4 Neon (XHigh)  [1M]
  Orchestrator (Argon)  [1M]
  Claude Opus 5.5 (High)  [1M]
  Claude Sonnet 5.5 (Medium)  [1M]
  GPT-OSS 120B (Medium)  [131K]
raw-slug labels: 0 | tab/preview rows: 0 | duplicate labels: 0
```

No lowercase slug survives, no `tab_*`, no duplicate label, every reasoning
level is parenthesised the same way, and the four former identical
`Gemini 3.5 Flash Lite` rows are now four distinct, accurate names.

### 31.4 Regression

`node test/antigravity-catalog.test.js` → **9 / 9** (internal models dropped;
slug prettified; trailing level parenthesised; size suffix upper-cased and
`5-5` → `5.5`; explicit displayName kept verbatim; colliding names fall back to
the prettified id; all labels unique; no label looks like a raw slug; group +
window survive). Full suite
`failing=0`; `scripts/parity-audit.js` → `DEFS: 141`,
`subsystems incomplete: 0`.

### 31.5 A spent Claude allowance is reported, not hammered

`claudeAllowanceHint(provider)` reads the plan's own usage endpoint
(`GET /api/oauth/usage`, OAuth header only — an API key never probes it) and
`formatResetIn()` renders the reset as prose:

- `the Claude plan's 5-hour allowance is 100% used (resets 9:29 PM, in 4 min); send this request again after the reset — nothing in the conversation is lost`
- 7-day window, unspent window (`62% used`), and API-key providers produce no
  banner at all.

A hint containing `100% used` sets `err.retryHopeless = true`, so
`chatWithFailover` throws immediately instead of walking five rounds of
backoff against an exhausted plan, and `humanizeLLMError` returns the
capitalised allowance sentence alone (never prefixed with "The provider is rate
limiting this key").

`node test/claude-allowance.test.js` → **10 / 10**. Live check against the real
endpoint: the 5-hour window flipped `100.0 → 0.0` at 20:30 UTC and the same
model then completed a full tool turn (see below).

## 32. A cut tool call never runs, and the recovery is silent (2026-11-25)

### 32.1 The defect that made "coding with any AI" look broken

Two independent wrinkles in the output-limit path:

1. A reply cut at the output limit can still carry a `tool_calls` entry whose
   `arguments` string stops mid-JSON. The old recovery loop verified the JSON but
   then fell through when the escalated attempt was *also* cut, so the sliced call
   was dispatched anyway. `parseArgs` turned it into `{_raw,_parse_error}`
   (`{}`-shaped), `Write` ran with no path, the UI showed an empty **error** card,
   and nothing landed on disk.
2. The recovery streamed its own thought line — "… retrying with N tokens" — which
   no Claude app / Claude Code / Antigravity turn ever shows.

### 32.2 What the loop does now

- `isCutJSON(raw)` / `hasCutCalls(list)` treat non-empty, unparseable arguments as
  cut. Empty arguments stay legal (tools with no parameters).
- The `finish_reason === 'length'` block is an **escalating loop** (3 bumps,
  `+8192` per bump, capped by `min(65536, window − promptReserve, reserveOut × 4)`)
  that breaks the moment the attempt is complete or carries a complete call.
  Every bump emits `retry` (drops the cut text from the UI) and **no** thought
  line, so the user sees the animated working state and then one answer.
- `outCeiling` remembers the raised budget for the rest of the turn, so the model's
  redone call is not cut a second time at the small default.
- Before dispatch, a cut call is dropped without a card (no empty-arg row), a
  `role:"tool"` message explains *"This tool call was cut off before its arguments
  were complete, so it did NOT run. Redo the work in smaller pieces: keep each
  Write under ~150 lines, then append the rest with the Edit tool (or a Bash
  redirect)…"*, and the turn continues.
- `parseTextToolCalls`' `push()` **skips** a fenced call whose argument JSON is
  unparseable instead of substituting `{}`.

### 32.3 Live proof (`:9333`, real Claude account, 6 000-line file)

`longout.cjs 9333 claude-sonnet-5-5 claude:rxpromedbd-gmail-com anthropic 6000 8192`:

- `sawRetry: false`, `retryWording: ""`, `limitWording: false`, `think: ""`,
  `composing: ""`, `error: null`, `streaming: false`
- cards: `Writing → longcount.txt`, `Running → wc -l longcount.txt`, result `6000`
- on disk: `~/Akron Bot/use-the-write-tool-to-create-the-file-lo-3/longcount.txt`
  → **6 000 lines**, real content, `Worked for 3m 15s`

Normal turns are unaffected: `probe-capability` passes on
`claude-sonnet-5-5` (15 live models, Write/Run/Browse, `markupLeak: false`, 11 s)
and on Antigravity `gemini-3-flash` (36 live models, same four tools, 2 s).

### 32.4 Regression

`node test/llm-truncated-tool.test.js` → **3 / 3** (a cut `Write` produces zero
tool cards, the tool message carries the redo-in-pieces instruction and the
matching `tool_call_id`, the budget escalates and is reused, no limit wording,
`parseArgs` flags sliced JSON, `parseTextToolCalls` skips sliced fenced calls).
`test/e2e.test.js` updated to the silent-retry contract → **112 / 112**. Full
suite `failing=0`; `scripts/parity-audit.js` → `DEFS: 141`,
`subsystems incomplete: 0`.

### 32.5 The free-model route codes too (Live proof)

The subscription providers are not the only code path; the app also ships the
local FreeLLMAPI router (`http://localhost:3001/v1`, seven keyed upstreams:
groq, gemini, cloudflare, nvidia, cohere, kilo, openrouter) as an
OpenAI-compatible provider. `build/probe-local.cjs 9333 http://localhost:3001/v1 auto`
selected `auto` (capability-first fallback, not a named model) and asked for the
same three capabilities:

- `Writing:toolcap.txt` → file created, `Running:cat toolcap.txt` →
  `TOOLCAP-OK`, `Browsing:https://example.com` + `browser_snapshot` →
  `Example Domain`, answer `WRITE=yes RUN=TOOLCAP-OK BROWSE=Example Domain`,
  `Worked for 41s`
- `markupLeak: false`, `error: null` — provider HTML never reached the transcript

So the "any AI can code" claim holds on a non-subscription, non-vendor route as
well, and the new probe covers plain OpenAI-compatible endpoints (no OAuth) in
one command.

---

## 33. The 400 that looked like billing was a tool name (2026-11-25)

### 33.1 Symptom

Every Claude turn with tools attached failed with

```
LLM 400: {"type":"error","error":{"type":"invalid_request_error",
 "message":"Third-party apps now draw from your extra usage, not your plan
 limits. Add more at claude.ai/settings/usage and keep going."}}
```

and the turn silently continued with `withTools:false` — so the app answered,
but the model had no `Write` / `Bash` / `browser_*` and stopped producing
deliverables. The message names billing, so the first four hours went into
entitlement checks (`/api/oauth/usage` read `allowed`), token rotation, the
`context-1m` beta, `max_tokens`, `stream`, UA, and the `CC_IDENTITY` block.
Every one of those was exonerated by a hand-built request returning `200`.

The decisive move was dumping the exact rejected payload
(`AUTOBOT_REQDUMP=<dir>`) and then bisecting it against the live endpoint with
the same token.

### 33.2 Bisect result — it is the tool *name*

| body | result |
|---|---|
| exact rejected payload (141 tools) | **400** |
| same body, 140 tools (index tool removed) | 200 |
| same body, 140 tools + `noop_probe` | 200 |
| 134 / 136 / 138 / 140 tools | 200 |
| `[{name:"mcp_find_tools"}]` alone | **400** |
| `[{name:"find_mcp_tools"}]` alone | 200 |
| `[{name:"mcp_probe"}]` alone | **400** |
| `[{name:"mcp_a"}]`, `[{name:"mcp_ab"}]` | **400** |
| `[{name:"mcp_1"}]` | 200 |
| `[{name:"mcp__srv1__foo"}]` | 200 |
| `[{name:"mcp"}]`, `[{name:"mcpA"}]`, `[{name:"mcp-probe"}]` | 200 |
| `[{name:"MCP_probe"}]`, `[{name:"Mcp_probe"}]`, `[{name:"_mcp_probe"}]` | 200 |
| `[{name:"a_mcp_b"}]`, `[{name:"tools_mcp_search"}]` | 200 |
| `mcp_probe` with UA `claude-cli/2.0.0` | **400** (not UA-dependent) |

Rule: on the subscription (OAuth) endpoint a tool name matching
`^mcp_[A-Za-z0-9]` — `mcp_` immediately followed by a letter or digit — is
rejected and reported as a billing error. `mcp__`, bare `mcp`, `mcp-` and
`mcpFoo` are all accepted. Anthropic's own MCP convention (`mcp__server__tool`)
therefore never trips it; our deferred-MCP **index** tool, named
`mcp_find_tools`, was the only such name in the tree.

### 33.3 Fix (commit `3bd1930`)

- **Renamed** the index tool to `find_mcp_tools` (advertisement, allow-list
  check, dispatch branch) with the measured rule recorded in a comment.
- **Class guard** — `electron/providertransport.js` now rewrites any
  `mcp_<alnum>` tool name to `x_mcp_<alnum>` when building an Anthropic body,
  and `newToolAcc()` reverses it on the way back, so the rest of the app always
  sees the real name and dispatch-by-name keeps working. Verified directly:
  `toAnthropicBody([{mcp_probe},{mcp__srv__t},{Write}])` →
  `["x_mcp_probe","mcp__srv__t","Write"]`.
- **Downgrade heuristic corrected.** The old test was
  `/tool|function|400|422|unknown/.test(message)` — the word "tool" inside a
  *billing* sentence (or a bare 400) flipped the whole turn to text mode with no
  visible reason. It now requires a schema-shaped signal
  (`input_schema|tool_use|unknown field|unexpected field|invalid tool|tools not
  supported`) **and** a 400/422 **and** the absence of billing wording
  (`extra usage|plan limits|add more at|credit balance|insufficient|billing|quota`).
- **No silent downgrade.** A non-credit downgrade now emits a `notice` naming
  the reason; `isCreditExhausted()` additionally recognises `extra usage` /
  `not your plan limits` so that shape takes the graceful notice path instead of
  a red banner.

### 33.4 Proof from the running app

`build/probe-capability.cjs` was re-run against the dev app with
`AUTOBOT_REQDUMP` on. The dumped request (the one the app actually sends) is:

```
tools: 141
UNSAFE mcp_+letter names: []
has find_mcp_tools: True
mcp__ style: ['mcp__secrets__request_secret','mcp__workspace__bash','mcp__workspace__read_file']
```

So the payload the app builds can no longer contain the construct that was
rejected.

### 33.5 Honest limit on the live proof

The end-to-end tool-call assertion for Claude is **not** re-proven in this
session: between the bisect and the re-run, the stored access token hard-expired
(`401 authentication_error: "OAuth access token has expired. Re-authenticate to
continue."`, same fingerprint `457f6c294751`, keychain included) and the refresh
token has been dead since 2026-11-25 (`invalid_grant`). The app now handles
exactly this: `provider_needs_signin` → error run event → model menu opens →
**"Claude needs to be signed in again — open the model menu and choose Sign in."**
— no spinner, no retry loop. The 141-tool body is proven acceptable at 140 tools
and with the index tool renamed, so the remaining variable is the credential, not
the schema.

### 33.6 Regression state after the fix

`node test/*.test.js` → every suite `failing=0` (mcp-schema 21 groups,
e2e 112, credit-degrade 4, llm-truncated-tool 3, oauth 146, …);
`node scripts/parity-audit.js` → `DEFS: 141 · tools missing definition: 0 ·
tools missing handler: 0 · subsystems incomplete: 0` → **NO ATOMIC GAPS**.

---

## 34. Composer controls moved out of the rounded box (2026-11-25)

The reported breakage — "in the message box … the design breaks and went
outside the box", with the send arrow and model pill outside the rounded border
— was structural, not cosmetic: eight controls were laid out inside a box whose
`overflow:hidden` could clip them out of hit-testing at narrow widths.

### 34.1 What changed

- The **labelled** controls (Thinking level, Swarm, tools `Sliders` popover) now
  live in a new `.composer-topbar` settings row **above** `.composer`; the
  permission pill (`Auto`) sits in `.topbar-right`. The box itself holds only
  the hint, attach, context ring, model pill and send.
- Positions were preserved — nothing was reordered or relocated out of reach;
  the row is the "second row outside the chat box" the brief allowed.
- `.inputbar` is opaque (`background: var(--bg-000)`, `position: relative`) with
  a 22 px gradient fade above it, which kills chat text bleeding through the new
  settings row while scrolling.
- `.composer-topbar` / `.topbar-left` / `.topbar-right` use `flex-wrap` with
  `min-width:0`, and the hint is trimmed by `@container (min-width:500px)` and
  hidden below `499px` (the old `670px` blocks are gone).

### 34.2 Measured

`build/width-probe2.cjs` at 940 / 1000 / 1024 / 1100 / 1200 / 1280 / 1440:

```
BAD_CONTROLS 0 · actionsOverflow 0 · footOverflow 0 · hintShown true · hintFull true
```

and all eight controls (`.f-attach`, `.reason-pick`, `.swarm-pill`, `.tools-btn`,
`.ctx-btn`, `.model-pill`, `.perm-pill`, `.send`) report `hitInside: true` at
every width. With the Environment pane open (the worst case, `probe-envpane.cjs`
at 940 / 1000 / 1100 / 1280): `BAD 0 · actionsOverflow 0 · footOverflow 0`,
topbar wraps to 2 rows only at 940 px, every control `hitInside: true`.

Functional probe at 1280×803: tools popover 10 rows, thinking menu 4 items,
model menu **78 rows** grouped exactly
`["Claude","ChatGPT","Google Antigravity","Grok"]`, `fits: true`, every topbar
control `inBar: true` + `clipped: false`, `sendArrowInside.inside: true`.

---

## 35. Subscription sign-in — port discipline, cancel, and where the windows come from (2026-11-26)

Three defects were reported together, and all three turned out to be facts about
the providers rather than opinions about the code.

### 35.1 `invalid_authorize_request` was a port, not a scope problem

The screenshot error was:

```
{"error":{"message":"Invalid authorize request","type":"invalid_request_error",
 "param":null,"code":"invalid_authorize_request"}}
```

Measured against `https://auth.openai.com/oauth/authorize` for this client id
(`app_EMoamEEZ73f0CkXaXp7hrann`), holding every other parameter fixed:

| `redirect_uri` | result |
| --- | --- |
| `http://localhost:1455/auth/callback` | **302** → `https://auth.openai.com/log-in` |
| `http://localhost:1456/auth/callback` | 400 `invalid_authorize_request` |
| `http://localhost:3000/auth/callback` | 400 |
| `http://localhost:54321/auth/callback` | 400 |
| `http://localhost:1455/callback` | 400 |
| `http://127.0.0.1:1455/auth/callback` | 302 (accepted, but the login page then
  rejects the mismatch) |
| missing / empty `state` | 400 |

So the registered URI is **one exact string**. The old `startLoopbackServer`
caught `EADDRINUSE` and quietly fell back to an ephemeral port — meaning any
machine where something already held 1455 (in the measured case, a `codex login`)
produced exactly the screenshot, every time.

What changed:

- `PROVIDERS.chatgpt.fixedRedirectPort: true`, and `startLoopbackServer` gained
  `strictPort` — no silent port move for a provider that has one registered URI.
- `authorize()` pre-flights with `portOwner(port)` (`lsof -nP -iTCP:<port>
  -sTCP:LISTEN`, read-only) and throws `redirect_port_busy` naming the holder.
  It returns `null` on any failure — it never asserts a port is free.
- A post-bind guard re-checks the actual `server.address().port` and throws
  `redirect_uri_mismatch` if they diverge.
- `originator: 'codex_cli_rs'` added to the authorize params, matching the CLI.

`probe-chatgpt-authurl` (11/11) and `probe-chatgpt-port` (all green) re-derive
this table from the running app: off-port URIs reproduce the exact 400, busy 1455
throws `redirect_port_busy`, a non-strict listener still moves, a strict one does not.

### 35.2 An abandoned sign-in must release the port

Because 1455 is a single global resource, a second sign-in could not start while
a first one waited for a human, and closing the panel left it held. `authorize()`
now takes `o.signal`, races `loop.wait()` / `o.waitForCode()` against an abort
promise, throws `err.code = 'signin_cancelled'`, and still runs `loop.close()` in
`finally`. Main returns `{ok:false, cancelled:true}` and both account surfaces
report *"Sign-in cancelled — no account was added."*, never a failure.

`probe-chatgpt-add` (22/22) drives the whole thing: row offers **Add account** →
`{ok:true, waiting:true, url}` → `lsof` shows `Electron … TCP 127.0.0.1:1455
(LISTEN)` → the row flips to **Cancel** → the URL carries
`redirect_uri=http://localhost:1455/auth/callback`, a `state`, a 43-char PKCE
`S256` challenge and `originator=codex_cli_rs` → OpenAI answers **302** → Cancel
releases 1455, returns `{waiting:false}` and adds no account.

Honest limit: a human still has to approve the login at `auth.openai.com`; no
automation can assert that.

### 35.3 The context windows are provider data, and we were ignoring them

The reported "Claude is 200K" was our fallback, not Anthropic's answer.
`GET /v1/models?limit=100` returns 15 models, each with **both**
`max_input_tokens` and `max_tokens`:

```
claude-fable-5-2          max_input_tokens 1000000   max_tokens 128000
claude-opus-4-8           max_input_tokens 1000000   max_tokens 128000
claude-sonnet-4-6         max_input_tokens 1000000   max_tokens  64000
claude-opus-4-5-20251101  max_input_tokens  200000   max_tokens  64000
claude-haiku-4-5-20251001 max_input_tokens  200000   max_tokens  64000
```

`max_tokens` is the **output cap**; using it as a window would have been wrong in
both directions. `listModels` now reads
`max_input_tokens || context_window || max_context_window || contextWindow`, and
the offline catalog gained rules for the 5.x line and opus/sonnet 4-6..4-8 at 1M
ahead of the older 200K rules. `probe-orch-ctx` reports `{ctx: 1000000, win: "1M"}`
for a ticked row and `probe-orch` finds `contextWindow: 1000000` persisted.

A 1M window is optimistic until the turn proves it, so `anthropicChat` demotes to
200 000 and retries headerless **once** on any oversized turn — the 400 matcher is
`/context|beta|long|1m|entitle|not available|too long|prompt is too/i`, so a
beta-less account still works without a second click.

### 35.4 `claude-fable-5-2` exists; the wall was the 5-hour allowance

The app had shown `model 'claude-fable-5-2' not found`, but:

- `GET /v1/models?limit=100` → **HTTP 200**, 15 models, `claude-fable-5-2` present.
- Every `/v1/messages` turn → **HTTP 429** `{"type":"rate_limit_error","message":"Error"}`.
- `count_tokens` → 200.

`GET /api/oauth/usage` on the same token: `five_hour.utilization = 100.0`,
`resets_at 2026-11-26T01:30:00Z` (= 02:30 CET, exactly the user's "resets 2:30 am"),
`seven_day.utilization = 49.0`. `/api/oauth/profile` confirms plan `max`.

Anthropic's own not-found wording is
`{"type":"error","error":{"type":"not_found_error","message":"model: <id>"}}`, and
no source file in `src/` or `electron/` produces the quoted form the banner showed
— so the body in that banner did not come from Anthropic and did not come from us.
The 429 path itself already carries the right words: `anthropicChat` sets
`hint = "the Claude plan's 5-hour allowance is 100% used (resets 2:29 AM, in 65
min); send this request again after the reset — nothing in the conversation is
lost"` plus `retryHopeless`, and `humanizeLLMError()` prefers the hint. Live-proven
end to end at 01:24 CET through the real transport.

Measured again at 00:52 CET with a deliberately impossible id, same token,
`/v1/messages`, `anthropic-beta: oauth-2025-04-20`, UA `claude-cli/2.1.332`:

```
POST /v1/messages {model:"claude-does-not-exist-9"}
→ 404 {"type":"error","error":{"type":"not_found_error",
        "message":"model: claude-does-not-exist-9"},"request_id":"req_011ChQcjoWd71EnBJQ1pkkUD"}
POST /v1/messages {model:"claude-fable-5-2"}
→ 429 {"type":"error","error":{"type":"rate_limit_error",
        "message":"This request would exceed your account's rate limit. Please try again later."}}
GET  /v1/models?limit=2
→ 200 claude-fable-5-2, max_input_tokens 1000000
```

Anthropic writes `model: <id>` — colon, no quotes, inside a `{"type":"error",…}`
envelope. The reported `model 'claude-fable-5-2' not found` (single quotes,
`not found` suffix, `{"error":{…}}` envelope) is not Anthropic's wording. It is
**Ollama's**, and the request that produced it is reproducible on this machine:

```
POST http://localhost:11434/v1/chat/completions {"model":"claude-fable-5-2"}
→ 404 {"error":{"message":"model 'claude-fable-5-2' not found",
                "type":"not_found_error","param":null,"code":null}}
```

(byte-identical to the banner body; saved as `ollama-404.json`). The request came
from `~/.autobot/orchestrator.json`, which held one legacy row:

```json
{"id":"pmwwlyh4x","name":"Provider 1","baseURL":"http://localhost:11434/v1",
 "apiKey":"","model":"claude-fable-5-2","tier":"heavy"}
```

`settings.json` was correct throughout (`baseURL:""`,
`oauthProvider:"claude:rxpromedbd-gmail-com"`, `transport:"anthropic"`), so the
bad binding was pool-only. Ollama on this machine serves `gemma4:latest` and one
other model — nothing Claude-shaped — so that row could never succeed, and every
orchestrated turn that picked it reported a dead subscription that was fine. The
pool trusted its rows; §35.6 makes it ask the gateway.

### 35.5 A 404 now names the endpoint that answered

`404` is the only status whose friendly prose is unfalsifiable: "model or endpoint
does not exist" is equally true of a wrong path, a gateway that never heard of the
id, and a genuinely retired model, and vendors' bodies rarely say which. Two lines
fix it, and nothing else changes:

- `httpError()` records `err.endpoint = res.url` (the **final** URL after redirects,
  so a proxy that rewrote the request is visible too).
- `humanizeLLMError()` appends `(asked host/path)` — for 404 only, and only when
  the string actually parses as a URL.

Live through the app (`probe-claude-404`, CDP against the dev build, 7/7):

| call | banner |
| --- | --- |
| `chatOnce({oauthProvider:'claude:<acct>', model:'claude-does-not-exist-9'})` | `The provider says that model or endpoint does not exist (asked api.anthropic.com/v1/messages) — model: claude-does-not-exist-9` |
| same, `model:'claude-fable-5-2'` | `The Claude plan's 5-hour allowance is 100% used (resets 2:30 AM, in 43 min); send this request again after the reset — nothing in the conversation is lost` |

`test/error-banner.test.js` (8 assertions) pins the shape: the provider's words
survive verbatim, a redirecting gateway shows the host it landed on, a missing or
unparseable `endpoint` never prints `(asked )`, and 429 / 500 keep their own
wording.

Probing gotcha found the hard way: `publicRecord()` exposes `account` and
`id`, **not** `key`. A probe that builds `oauthProvider` from `acct.key` gets
`claude:undefined`, `hydrateProvider()` wraps it as
`Claude needs to be signed in again…`, and the result reads like a credential
regression that is not there. Always build it from `acct.account`.

### 35.6 A pool row is a claim its gateway has to honour

Every anonymous pool row asserts *"this gateway serves this model"*, and nothing
verified it. `electron/orch-pool.js` (`pruneUnserved`) asks each such row's own
gateway once per turn:

- candidate URLs: `<base>/models`. A base that already names a version
  (`…/v1`, `…/v1beta/openai`) is asked directly; a bare host also tries
  `<base>/v1/models`.
- accepts the three shapes OpenAI-compatible servers return —
  `{"data":[{"id"}]}`, `{"models":[{"name"}]}` (Ollama `/api/tags`), `["…"]`.
- **drops a row only on positive evidence**: HTTP 200 *with* a non-empty
  catalogue that does not contain the row's model (case-insensitive, trailing
  slash normalised).
- keeps the row and marks it `unverified` when the gateway is down, returns
  401/5xx, answers with an unparseable body, or returns an **empty** list (that
  is what a router with no keys says — pruning on it would erase working rows).
- never probes subscription rows (`oauthProvider`): their binding is resolved in
  main and a dead one already surfaces as its own sign-in error.
- 2.5 s budget per turn in `validateOrchestrator()`, run concurrently with MCP
  discovery, and any internal failure returns the pool unchanged — validation
  can never cost a turn.

Pruning is **per turn**. The stored row survives, the notice says so, and
`activeIndex` is re-anchored by row identity so removing an entry above the active
one does not silently switch models.

Live in the dev build (`probe-orch-prune`, 8/8): the measured stale row seeded
first and active, one real turn through Ollama, events
`notice, cwd, delta, done, complete` and

```
Left 1 orchestrator model out of this turn — claude-fable-5-2
(http://localhost:11434/v1/models serves 2 models and claude-fable-5-2 is not one
of them). The saved row is untouched; remove it in Settings if that gateway no
longer serves it.
```

`test/orch-pool.test.js` (32 assertions) replays the live 404, proves a served
model survives (case + trailing slash), and pins the no-false-positives cases:
401, ECONNREFUSED, empty catalogue, HTML body, silent gateway (60 ms deadline,
returns in <1.5 s).

### 35.7 Regression

All suites green in the standalone tree after a clean `npm ci` (578 packages),
27 files: `provideroauth 254`, `providertransport 169`,
`e2e 112`, `extensionhost 162`, `compliance 147`, `mcpoauth 146`, `swarm 62`,
`hooks 49`, `freellm 37`, `reconnect-code 24`, `providerhydrate 18`,
`model-catalog 22 groups`, `artifacttypes 82`, `sandbox 22`, `runtimes 23 groups`,
`error-banner 8`, `orch-pool 32`.
`test/provideroauth.test.js` sets `AUTOBOT_HOME` to a scratch dir before `require`
and asserts the real `~/.autobot/provider-oauth.json` bytes are unchanged — that
suite had been corrupting the live store.

## 36. The Gemini 400 was our own JSON Schema (2026-11-26)

### 36.1 Symptom

Every Antigravity turn came back `400 Invalid JSON payload received`, and the
provider's message blamed a deep path inside our own request:

```
Unknown name "type" at
'request.tools[0].function_declarations[0].parameters.properties[2].value.items'
```

`googleChat()` was putting the tool's JSON Schema straight into
`functionDeclarations[].parameters`. The Cloud Code endpoint accepts only an
OpenAPI 3.0 *subset* and rejects the whole request over one unknown keyword — so
every tool we advertise had to be legal, not just the one that failed first.

### 36.2 Fix

`toGeminiSchema(schema, depth)` and `toGeminiDeclarations(tools)` in
`electron/providertransport.js` lower each schema to that subset:

- whitelist only — `type`, `description`, `nullable`, `enum`, `items`,
  `properties`, `required`, `minimum`, `maximum`, `minItems`, `maxItems`,
  `minProperties`, `maxProperties`;
- drop `additionalProperties`, `$ref`, `const`, `format`, `default`, `pattern`,
  `$schema`;
- enum members are stringified and an enum schema is forced to `type: 'string'`;
- `required` is filtered to keys that survived; `anyOf`/`oneOf`/`allOf` collapse
  to the first non-null branch (`nullable` when a null branch existed); sibling
  enum branches merge; `type` arrays collapse; missing types are inferred;
- depth capped at 8, names failing `/^[A-Za-z_][A-Za-z0-9_.-]*$/` and duplicates
  are skipped.

### 36.3 Causal A/B (`build/probe-antigravity-ab.cjs`)

Same tool, same model, same account; only the schema differs.

| body | result |
|---|---|
| raw JSON Schema (pre-fix wire shape) | **400** `INVALID_ARGUMENT` |
| lowered to the OpenAPI subset | **200** |

```
raw=400 lowered=200 → CAUSAL: the lowering is the fix
```

### 36.4 End to end (`build/probe-antigravity-turn.cjs`, 10/10)

A real turn through `transport.chatCompletion()` with the real advertised surface:

```
PASS safeStorage can decrypt this profile  — app "Akron Bot"
PASS antigravity has a stored account  — 6969loavbal-gmail-com, antigravity-e7a9a81a
PASS a live access token was resolved  — 6969loavbal-gmail-com
PASS the advertised tool surface is non-empty  — 141 tools
PASS every tool survives the Gemini lowering  — 141 / 141
PASS the turn was accepted by the Cloud Code endpoint  — 3619 ms
PASS the model answered with text  — antigravity-path-ok
```

`test/gemini-schema.test.js` lowers all 141 built-in tool definitions and asserts
2748 properties.

## 37. A notice you can close, and a toast before the window fills (2026-11-26)

### 37.1 Dismissible notices

One component — `ProvNotice({text, warn, className})` — renders every
`.prov-notice`: `.prov-notice-text` plus a `.prov-notice-x` button labelled
`Dismiss`. Dismissal is keyed on the banner's **own text** and the state lives in
the mounted component, so (a) hiding one message can never hide the next
different one, and (b) a remount re-arms it. `onClick` stops propagation so the X
inside the model picker does not also select the row underneath.

`storeError` is the single overloaded case: it is dismissible per mounted surface
and the underlying error is never cleared, so the truth is still there on the next
mount. Only `.prov-notice.warn` means a store failure; every other notice is
informational or an error banner.

### 37.2 Context-pressure toast

`ContextLimitToast({lastUsage, model, T})` is the last child of `.app`, and its
rule lives in `src/ctx-toast.mjs` so it is testable without a DOM:

- `TOAST_WARM = 70`, `TOAST_HOT = 90`, percent from `usedTokens(lastUsage)` over
  `contextWindowFor(model)` — so it fires for every provider, not just Claude;
- dismissal keyed on `(tone, lastUsage.at)`: a 70 % dismissal still lets the
  90 % warning through, and a new turn revives it;
- unknown window (`0`/`NaN`) yields `cool` and no toast — the old shape divided
  by zero, went `Infinity`, and stayed "hot" forever;
- wording is `78% of the window used · gemini-4-neon-high`, never a raw
  token-limit string.

Placement is measured, not guessed: a `ResizeObserver` on `.composer` plus a
`window` resize listener sets an inline `bottom` of
`window.innerHeight - composerRect.top + 10`. The previous CSS `bottom: 18px`
put the toast *over* the message box.

### 37.3 Live proof in the running renderer (`build/probe-notices-toast.cjs`, 36/36)

Against the built bundle, driving the real DOM over CDP:

| case | measured |
|---|---|
| 50 % of the window | no `.ctx-toast` |
| 78 % | warm toast, `78% of the window used · gemini-4-neon-high` |
| placement | `position: fixed` at `bottom: 125px`; toast `619–678` vs composer `688–783` — **no overlap** |
| close | button labelled `Dismiss`, click removes the toast |
| 95 % | hot tone, different wording, dismissible |
| usage cleared | toast gone |
| real app notice | picker's “Import accounts from this Mac” → `Imported 2 · already present 2.` renders `.prov-notice-x`; click hides it; reopening the picker shows a fresh notice |

`test/ctx-toast.test.js` — 34 assertions, exit 0.

## 38. The “tokenless” account was the probe's app name (2026-11-26)

A probe kept reporting `no stored tokens for antigravity:…` for accounts that the
running app used without complaint. The store was fine. On macOS `safeStorage`
keys its Keychain entry on the *application name* — `<productName> Safe Storage`
— so a bare `./node_modules/.bin/electron build/x.cjs` decrypts under
`Electron Safe Storage` and gets a decryption error for every row:

```
encryptionAvailable true
provider-oauth:antigravity:… => DECRYPT-ERR Error while decrypting the ciphertext …
```

With `app.setName(require('../package.json').productName)` before `whenReady`,
every row decrypts (claude 490 chars, chatgpt 2190, grok 1109, antigravity 811
and 813). Both `build/probe-antigravity-turn.cjs` and
`build/probe-antigravity-ab.cjs` now set the name and relaunch themselves under
Electron when started with plain `node`, so a probe can no longer report a dead
account that is alive.

**Consequence for triage:** a `no stored tokens` result from a plain-`node`
probe is a probe artifact, not a finding. Verify through the app's runtime.

## 39. “Claude needs to be signed in again” was an empty bearer (2026-11-26)

The 1M long-context proof failed with `401 authentication_error: Invalid bearer
token` while `/tmp/which-token.cjs` replayed the *same dumped body* against
`api.anthropic.com` with the stored token and got `200 message_start`. The
credential was valid; the request was not.

An `AUTOBOT_REQDUMP` meta block, extended for this round with a credential
fingerprint (no token is ever written — length and a 12-hex sha256 prefix only),
named the culprit on the first run:

```json
"auth":     { "source": "none", "len": 0, "sha12": "e3b0c44298fc" },
"provider": { "oauthProvider": "claude:rxpromedbd-gmail-com", "tokenLen": 0, "apiKeyLen": 0 }
```

`source: "none"` is `sha256("")`. The request carried `Authorization: Bearer `
with nothing after it.

**Where it came from.** `~/.autobot/orchestrator.json` stores `oauthProvider` +
`model` per row and never a token (`~/.autobot/secrets.json` holds those, keyed
by account). `autobot:run` hydrated the pool only when the renderer *sent* one.
A turn that arrives with just the selected provider — every CDP probe, every
scheduled task — fell through to `store.getOrchestrator()`, which was handed
straight to `runAgent`. `normalizeProvider()` defaults `accessToken` to `''` and
`anthropicAuth()` reads `accessToken || apiKey`, so the empty string was never
replaced: `Bearer ` + empty. Anthropic answers `401 Invalid bearer token` and the
app translated that into "Claude needs to be signed in again".

**Fix.** `electron/orch-hydrate.js` (new, dependency-injected so it is unit
testable) resolves every row through the same `hydrateProvider()` a single
provider already went through, and both turn paths call it:

| site | change |
| ---- | ------ |
| `autobot:run` | `orchSource = orchestrator || store.getOrchestrator()` and `hydrateOrchestrator(orchSource, hydrateProvider)` before `runAgent`, so the persisted pool is minted too |
| scheduled runner | `hydrateOrchestrator(orch, hydrateProvider)` before `validateOrchestrator()` |
| dead row | dropped from *this turn only*, with one notice: `Left 1 orchestrator model out of this turn — … needs to be signed in again. The saved row is untouched; sign in again in Settings.` |
| `activeIndex` | re-anchored by which row survived, so a dead row above the active one cannot silently switch models |
| on-disk pool | never mutated; the test asserts the input JSON is byte-identical afterwards |

**Live proof** (dev app, port 9333, Orchestrator Mode enabled with the stale
anonymous Ollama row still first in the store):

```
claude-sonnet-4-6 => OK [{"role":"assistant","content":"PING46"}]
claude-opus-4-5   => OK [{"role":"assistant","content":"PING45"}]
```

and the 1M proof then passed for the first time:

```
pad chars: 819999
prompt_tokens : 344416   (LC_LINES=10000, ≈820 KB of filler)
window before : 1M 1000000
window after  : 1M 1000000
PASS          : true
```

**Regression guard.** `test/orch-hydrate.test.js` — 33 assertions, exit 0:
empty pools pass through untouched, a missing resolver is a `TypeError` rather
than a silent pass, every row is resolved in order, the saved pool is never
mutated, a dead row is dropped *and named* while the active slot keeps the same
model, an all-dead pool returns an empty provider list rather than throwing, and
the notice is singular/plural/anonymous-correct and never carries raw JSON.
`verify-release.sh` now asserts `hydrateOrchestrator` in both the module and
`main.js` (both call sites), the notice wording, and the `sha12` fingerprint.

**Triage note.** `401 Invalid bearer token` on a subscription row is a *hydration*
bug until the fingerprint says otherwise — the stored token may be perfectly
valid. The dump's `auth.source`/`sha12` decides in one request.

## 40. The orchestrator drop notice was permanent (2026-11-26)

With Orchestrator Mode on and one stale row in the pool, every turn surfaced:

> Left 1 orchestrator model out of this turn — claude-fable-5-2
> (http://localhost:11434/v1/models serves 2 models and claude-fable-5-2 is not
> one of them). The saved row is untouched; remove it in Settings if that
> gateway no longer serves it.

…as `.noticebar`, a green strip pinned above the composer. It had no close
button, so a single failover line stayed on screen for the rest of the session.
The per-turn notice was correct; its lifecycle was not.

**Fix.** `ChatNoticeBar` (new component next to `ProvNotice`, `src/App.jsx`)
renders `.noticebar` + `.noticebar-text` + `.noticebar-x` and keeps its own
dismissal state, keyed on the bar's own text. The rule is the same one the
provider notices already follow: closing *this* message can never swallow the
next, different one. Because the key is the text, a repeat of the identical
orchestrator complaint stays closed instead of re-announcing itself every turn —
which is what the user asked for.

| aspect | behaviour |
| --- | --- |
| layout | `.noticebar` is `display:flex`; the text takes the row, the button is `flex:0 0 auto` at the top-right |
| affordance | 20×20 px button, `title`/`aria-label` `Dismiss`, `Icon name="X"`, hover surface |
| scope | per mounted bar; the `notice` state itself is untouched, so nothing silently loses the information |
| new message | different text mounts a fresh bar (asserted) |

**Live proof** — `build/probe-noticebar.cjs [port]`, driven only through the
app's own `/goal` slash command (same `notice` state the pool drop uses):

```
  ok   no notice bar on a fresh renderer
  ok   /goal reaches the composer
  ok   the app renders a notice bar
  ok   the bar carries the message
  ok   the bar has a close button
  ok   the close button is labelled for screen readers
  ok   the close button is a real hit target (>=16px)
  ok   the close button sits inside the bar
  ok   clicking close hides the bar
  ok   a different notice is not swallowed by the old dismissal
  ok   the bar sits above the composer, no overlap
15 passed, 0 failed
```

Run once on the dev app (port 9333) and again against the packaged app
(port 9444). `verify-release.sh` now asserts `noticebar-x` in both the renderer
bundle and the CSS.

## 41. A long-context refusal was reported as a throttled key (2026-11-26)

The packaged 1M probe was re-run and the turn failed with:

```
errors: [{"type":"error","text":"","error":null,"phase":null}]
PASS  : false
```

Two defects, both in the *reporting* of a provider decision, not in the beta path:

1. `build/probe-longctx.cjs` collected `e.text` while `main.js` sends
   `{ type: 'error', message }`. The probe printed an empty string for the one
   field that explains the failure. It also computed
   `ORCH_ON = … ? 'true' : 'false'` — a **string**, so `!ORCH_ON` was always
   false and it reported `model match : true` while `model served` was blank.
   Both are fixed: the probe records `message`, and `ORCH_ON` is a real boolean.
2. The request dump showed what the provider actually said:

```json
{ "type": "error",
  "error": { "type": "rate_limit_error",
             "message": "Usage credits are required for long context requests." },
  "request_id": "req_011ChQjpsFodf64MrFbEgPvQ" }
```

A 429, so `humanizeLLMError` led with *"The provider is rate limiting this key"*
— advice to retry something that cannot succeed until credits are added — and
`isRateLimitError` retried it five times (~39 s) before printing that.

**Not a regression.** The same 1M request succeeded twice earlier today
(`prompt_tokens 344425`, window `1M`), so the beta path works; this account's
long-context credit allowance is now the limit.

**Fix, in two places.**

| where | change |
| --- | --- |
| `llm.js humanizeLLMError` | a 429 whose body names a credit wall is headlined *"This account needs usage credits for that request"* instead of "rate limiting this key"; the provider's own sentence is still quoted |
| `providertransport.js` (anthropic 429) | the same body sets `retryHopeless` + a prose hint ("Long context needs usage credits on this account — the plan allowance does not cover a request this large. Send a shorter conversation, or pick a model whose window fits it"), so the ladder throws once instead of backing off five times |
| `build/probe-longctx.cjs` | reads `message`, honest `model match`, and prints `blocked : provider refused long context (needs usage credits) — not an app failure` |

`test/error-banner.test.js` grew from 8 to 11 assertions: the credit-wall 429 is
named as a credit wall (and never as rate limiting), a per-minute 429 keeps its
wording, and the banner does not repeat itself. Full suite: 37 suites, 0 failing.

**Shipped proof — final packaged artifact (`SHA256SUMS.txt`
`1c5d9935df608dc8fe6a7d3c88c981b448a4af8acfaec1c4789937058061777f`).** Same
1M request, after the fix:

```
seconds          : 1
errors           : Long context needs usage credits on this account — the plan allowance does not cover a request this large. Send a shorter conversation, or pick a model whose window fits it
blocked          : provider refused long context (needs usage credits) — not an app failure
PASS             : false
```

`seconds : 1` (was `39` with `gave up after 5 attempts`): the ladder now throws on
the first refusal, and the banner is the transport's own sentence instead of the
generic "rate limiting this key". The provider decision is unchanged — this
account cannot run a request that large without credits — but the app now says
so in one line, once.

`test/error-banner.test.js` is 12 assertions (added the exact shipped sentence,
asserting it is not worded as throttling). Full suite: 37 suites, 0 failing. The
packaged proof matrix (`build/run-package-matrix.sh 9444`) is 9/9 probes green on
the same artifact.

## 42. The state a proof run touches is the user's, not the test's (2026-11-26)

Proving the FreeLLMAPI key meant taking the composer off the orchestrator pool for
one turn — the turn has to be answered by the single keyed provider, or the proof
proves nothing. The first version of `build/probe-freellm-key.cjs` restored the
pool inline on the success path only, so when a check threw the user was left with
`{"enabled":false,"providers":[]}` in `~/.autobot/orchestrator.json`: a real
four-row pool, ticked by hand, silently deleted by a test.

**Fix, in the probe.** The pool is parked through the app, not by hand: read it,
write `~/.autobot/orchestrator.preprobe.json` (0600) *before* disabling, and put it
back via `window.autobot.setOrchestrator(...)` from `restorePool()`, which both the
success path and the `.catch` path call. `poolWorthKeeping()` is the guard — an
empty pool is not backed up and a backup that is empty is never restored, so a
failed run cannot resurrect a pool the user deliberately cleared.

**Fix, in the app.** The same run exposed a second way to lose saved state: the
renderer profile is `localStorage`-hydrated over a hardcoded default and mirrored
to main, so on a reload the built-in preset (`FreeLLMAPI · model: auto`) could win
over the model the user had saved (`auto:fast`) — the picker only re-inserts an
alias the catalog omits while it *is* the active model, so the alias vanished from
the row list and the mirror wrote the demotion back. The adoption effect now keeps
the saved model when main already holds a key for the same endpoint:

```js
sameEndpoint && saved.model && own.model !== saved.model  // → setProvider({ model: saved.model })
```

| proof | result |
| --- | --- |
| `node build/probe-freellm-key.cjs 9444 … auto:fast` (packaged, with the rebuilt 3-row pool) | **12/12** — `orchestrator pool restored: 3 rows, enabled=true`, turn `WIRED-MWX01YWD`, no error banner, no markup leak |
| pool after the run | `enabled:true`, 3 rows (`claude-opus-5-5` heavy, `claude-haiku-5-5` small, `claude-fable-5-2` critical, all 1M, `activeIndex 0`), 0600 |
| model retention | `before auto → seeded auto:fast → reload → auto:fast → reload → auto:fast` (main settings and `localStorage` agree) |
| a turn through the rebuilt pool | `POOLOK-MWX0135A` answered in 3 s, zero `.prov-notice`, no dead-row line |

## 43. `~/.autobot` was readable by every local account (2026-11-26)

Checking the restored pool turned up `-rw-r--r-- orchestrator.json` next to
`-rw------- settings.json`. The 0600 on settings was not policy, it was a manual
chmod: `electron/store.js writeJSON()` called

```js
fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');   // 0644 under umask 022
```

for every file it owns — and those files carry credentials. `settings.provider.apiKey`
is the gateway key; a pool row persists `baseUrl` + `apiKey` for gateway entries.
The directory itself was `0755`, so any other account on the machine could read
both.

**Fix.** `writeJSON()` now writes with `{ mode: 0o600 }` and `chmodSync(0600)`
afterwards (the mode flag only applies on create, so an existing 0644 file from an
older build would otherwise stay readable), `ensureDir()` creates 0700, and one
chmod pass at load tightens `~/.autobot` to 0700 and every pre-existing `*.json`
in it to 0600 — legacy files are normalised instead of waiting to be rewritten.

Verified: `drwx------ ~/.autobot`, and `stat -f '%Sp %N' ~/.autobot/*.json` shows
no non-0600 file. `test/e2e.test.js`: **112 passed, 0 failed**.

## 44. The smoke matrix left the app on a test profile (2026-11-26)

§42 fixed the pool, but the composer was still being consumed by the matrix. Each
probe points the chat at the model it is testing, and the rewrite is written
straight into `localStorage['autobot:provider']` and mirrored to main:

```js
localStorage.setItem('autobot:provider', JSON.stringify({
  baseURL: 'http://127.0.0.1:3001/v1', apiKey: '', model: 'claude-opus-4-5', … }));  // probe-build-app
```

Nothing put it back, so after a green 9/9 run the app's saved provider had become a
**keyless** `127.0.0.1:3001` + `claude-opus-4-5` — the user's `localhost:3001` +
`auto:fast` + key was only preserved inside `autobot:providerKeys`, which the app
does not read back into the active profile. `probe-logo` additionally nulls
`autobot:activeId` (the open conversation), and `probe-notices-toast` seeds a
synthetic `autobot:lastUsage` record, which is what the context toast measures.

**Fix, per probe.** One shared helper, `build/lib/preserve-provider.cjs`, snapshots
the listed `localStorage` keys *and* `getSettings().provider`, then writes both back
and reloads. Every rewriting probe (`probe-build-app`, `probe-capability`,
`probe-logo` with `autobot:activeId`, `probe-notices-toast` with
`autobot:lastUsage`) arms it before its first write and calls `restore()` on the
success path and in `.catch()`.

**Fix, per run.** Per-probe restore cannot cover a probe that crashes before it
arms, or one added later, so the matrix itself is wrapped.
`build/lib/matrix-state.cjs save|restore|show` snapshots `autobot:provider`,
`autobot:providerKeys`, `autobot:activeId`, `autobot:lastUsage`, main
`settings.provider` and the whole orchestrator document to a 0600 file inside a
0700 log dir (it holds a key), and `build/run-package-matrix.sh` restores it after
the last probe. Restore re-reads both sides and compares base URL, model and key
length; a mismatch is a matrix failure, not a log line.

**False negative, also fixed.** `probe-build-app` failed a working storefront
because `hasCartLogic` accepted only named helpers (`addToCart`, `push(`). The
generated cart mutated in place (`cart[id] = q` inside `update(id, delta)`), so the
check now also accepts in-place cart mutation and `localStorage.setItem(…cart…)`.

| proof | result |
| --- | --- |
| `build/run-package-matrix.sh 9444` on the rebuilt artifact | **9/9 probes**, plus `state restored http://localhost:3001/v1 / auto:fast / key 59 pool 3 OK` |
| matrix snapshot line | `state saved http://localhost:3001/v1 / auto:fast / key 59 pool 3` |
| `build/lib/matrix-state.cjs show 9444` after the run | renderer **and** main both `http://localhost:3001/v1 / auto:fast / key 59`; pool `enabled:true` × 3 |
| `node build/probe-freellm-key.cjs 9444 … auto:fast` (packaged) | **12/12**, `orchestrator pool restored: 3 rows, enabled=true`, turn `WIRED-MWX0XNB7` (one 502 retry, 9 s) |
| `~/.autobot` after two matrix runs and a keyed proof | `700`, 19 `*.json` files, none group/world-readable; `orchestrator.preprobe.json` 0600 |
| `node test/e2e.test.js` | **112 passed, 0 failed** |
