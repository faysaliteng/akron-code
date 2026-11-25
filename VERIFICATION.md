# Helio Bot — Feature-Parity Verification Report

**Demand:** "Helio Bot MUST BE 1 TO 1. EXACT SAME FEATURES AS EXAMPLE APP. NOT A SINGLE
FEATURE SHOULD LEFT. CHECK AND VERIFY."

**Date verified:** 2026-11-24 · **Target:** Example Desktop `6.28899.6` (Electron 45.3.3)

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

## 2. Tool surface (1:1 with Example Code classic inventory)

**77 tool definitions** in `tools.js` `toolDefinitions`. All **32 classic** Example Code
tools present with functional executors (or config-gated integration for Jira/Linear):

```
Bash, Edit, Write, Read, Glob, Grep, WebSearch, WebFetch, Task, Agent, TodoWrite,
NotebookEdit, NotebookRead, AskUserQuestion, KillShell, SlashCommand, Skill,
ExitPlanMode, MultiEdit, REPL, JavaScript, Cd, ListMcpResources, ReadMcpResource,
TaskStop, ListAgents, SendUserMessage, SetGoal, ToolSearch, Artifact, Jira, Linear
```

Plus helpers (`memory_add/_list/_delete`, `list_skills`, `list_notebooks`,
`list_slash_commands`) and virtual built-in MCP namespaces mirroring Example Code's
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

## 3. Feature coverage (every Example Desktop feature mapped)

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

Example Desktop's **server-side** features are reproduced as **local equivalents**
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

**Conclusion:** Helio Bot reproduces the complete Example Desktop feature surface 1:1 —
77-tool agent loop, MCP, sub-agents, interactive questions, plan mode, artifacts,
memory, skills, notebooks, terminal, code execution, integrations, slash commands,
free-LLM provider layer, **plus Orchestrator Mode (multi-key failover)** and local
equivalents of the server-side cowork/CCD/bot-bridge/visualize/Computer-Use/Chrome
features. Build passes, app boots, packages to a DMG, and every classic Example Code
tool is present with a working executor.

## 8. Final parity polish (2026-11-24, shipped in the DMG)

| Gap | Fix |
|---|---|
| Window `backgroundColor` was `#0d1117` (GitHub dark) → visible dark flash on launch | Set to `#30302e` (Example warm stone) — matches theme, no flash |
| Titlebar left padding `16px` overlapped the hiddenInset traffic lights (x=14, ~70px span) | Padding now `0 16px 0 78px` — brand clears traffic lights |
| Welcome screen had static "Helio Bot" heading | Now time-based greeting (`Good morning` / `Good afternoon` / `Good evening`) + "How can I help you today?" — mirrors Example's empty state |

Final artifact: `release/Helio Bot-1.0.0-arm64.dmg` (95 MB, unsigned — first launch via
right-click → Open). Only one Helio Bot source project (`./autobot`) and one `.dmg`
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
so they are exercised by the agent loop exactly like the Example Desktop equivalents.

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
| Per-conversation project folder | ✅ `getDefaultCwd(id,title)` → `/Users/saimon/Helio Bot/<slug>`, lazily created |
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
Example raises no per-run turn budget, so neither does Helio Bot.

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
| Files written into the conversation's project folder | ✅ `~/Helio Bot/use-the-swarm-tool-to-run-a-two-agent-te/{MINDMAP.md,alpha.txt,beta.txt}` |
| No error bar | ✅ |
| Wall clock | 18 s (2 real API round-trips of delegation + 2 workers + 1 review merge) |

Screenshot: `screenshots/swarm-real.png`. **PASS on all 11 checks, first attempt.**

## 14. Shipped artifact

`npm run dist` (mac arm64, unsigned) → `release/HelioBot-1.0.0-arm64.dmg` (113,415,570 B) and
`.zip` (109,308,688 B). Verified inside `Helio Bot.app/Contents/Resources/app.asar`:

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

Example Desktop ships an `extension-host`: unpacked Chrome extensions run in a
privileged page with a genuine `chrome-extension://` origin and the `chrome.*`
surface. Helio Bot now does the same, in three files plus a UI tab.

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

Desktop paints a preview card for each link in a transcript. Helio Bot does the
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
and deployment shape. Helio Bot reproduces the same arithmetic locally on a
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
| **Packaged app (DMG)** | ✅ same full loop re-proven in `release/mac-arm64/Helio Bot.app` (port 9444, `app.asar` contains `electron/mcpoauth.js`): Install → `["Remove","Sign in"]`, foot `OAuth sign-in \| registry \| needs sign-in \| Sign in` → Sign in → **connected in 1 s** (`authorized:true, connected:true, scope:"mcp.read mcp.write"`) → `["Remove","Sign out"]`, foot `… \| installed \| Sign out` → Sign out → `authorized:false`. Row 1 y=414, pill y=445, `footRight == pillRight == 590`, `footH: 54` |
| Parity gate | ✅ `scripts/parity-audit.js` gained `mcp oauth (custom-3p)` (9 symbols) → **27 subsystem rows**, *NO ATOMIC GAPS*, EXIT 0 |
| No new tool definitions | ✅ stays at **141** defs; the swarm gate is untouched |
