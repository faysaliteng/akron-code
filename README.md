# ⚡ Akron Bot

**Akron Bot** — a Claude Desktop–compatible desktop AI agent that runs
on **any free LLM API** (OpenAI-compatible).

Built by reverse-engineering Claude Desktop (`/Applications/Claude.app`, Electron 45.3.3)
with REA and reproducing its full feature surface on a pluggable local/remote LLM layer.

---

## Features (feature parity with Claude Desktop)

| Example feature | Akron Bot equivalent |
|---|---|
| Streaming chat w/ markdown + code | ✅ SSE streaming, `marked` + `highlight.js` + DOMPurify |
| Agent tool loop (full classic surface, **141 tools**) | ✅ built-in function-calling loop with no-tools fallback — the same definitions are translated for Anthropic (`input_schema`), OpenAI/Codex/Grok (`type:function`) and Google (`functionDeclarations`), so any capable model can write code, run a shell and drive the browser |
| MCP (Model Context Protocol) client | ✅ stdio JSON-RPC MCP client (`initialize` / `tools/list` / `tools/call`); MCP tools + resources auto-exposed to the agent |
| Sub-agents (`Task` / `Agent`) | ✅ parallel recursive sub-agents + `TaskStop` / `ListAgents` |
| Interactive questions (`AskUserQuestion`) | ✅ paused-agent UI round-trip with options + 5-min auto-resolve |
| Plan mode (`ExitPlanMode`) | ✅ agent pauses for user approval of the plan |
| Artifacts panel | ✅ auto-extracts code blocks + explicit `Artifact` tool → tabbed viewer |
| Long-term memory | ✅ persistent memory (`.auto-memory`) injected into prompts, list/add/clear |
| Skills registry | ✅ built-in + custom `.md` skills, loaded by the `Skill` tool |
| Notebooks (`NotebookRead` / `NotebookEdit`) | ✅ Notebooks panel + cell editor |
| Terminal / shells (`KillShell` + `mcp__terminal__*`) | ✅ persistent multi-tab shell manager + Terminal view |
| Code execution (`REPL`, `JavaScript`, `Bash`, `Cd`) | ✅ js/python/bash via local runtime; mutable cwd |
| Provider config | ✅ OpenAI-compatible presets: Ollama, LM Studio, Groq, OpenRouter, OpenAI, Custom |
| **Orchestrator Mode** | ✅ multi-provider/key failover — auto-switches to the next model on rate-limit / limit-reached |
| **Feature toggles** | ✅ Computer Use, Chrome (CDP), and bot-bridge local equivalents (config-gated) |
| Conversation persistence | ✅ `localStorage` (conversations, provider, settings, orchestrator, features) |
| Integrations (`Jira`, `Linear`) | ✅ config-gated via env vars |
| Slash commands | ✅ `/help /clear /compact /model /review /memory /reset /status` |
| Context handling | ✅ **per-model** context window resolved from the provider's live catalog (`16K`–`1M`), shown in the model picker, auto-compact at 90 % of the window, and a single oversized message is trimmed head+tail (or chunked) instead of failing — see [Context windows & auto-compact](#context-windows--auto-compact) |

Full reverse-engineering report + feature map: [`FEATURES.md`](FEATURES.md).

---

## Run it

```bash
cd autobot
npm install
npm run build
npm start
```

First run: open **⚙️ Settings** and pick a provider preset (or paste your own
OpenAI-compatible base URL + key), then **Test connection**.

### Free LLM presets

| Preset | Base URL | Needs key |
|---|---|---|
| FreeLLMAPI (local router) | `http://localhost:3001/v1` | no |
| Ollama (local) | `http://localhost:11434/v1` | no |
| LM Studio (local) | `http://localhost:1234/v1` | no |
| Groq (free tier) | `https://api.groq.com/openai/v1` | yes |
| OpenRouter (free models) | `https://openrouter.ai/api/v1` | yes |

### FreeLLMAPI — seven free providers, one endpoint

`localhost:3001/v1` is an OpenAI-compatible **router** that ships with the app and
starts automatically. It fans one model string out to Groq, Google Gemini,
Cloudflare Workers AI, NVIDIA NIM, Cohere (trial), Kilo and OpenRouter, and
falls through to the next provider on 429 / 5xx / network error **before the
first stream byte** — so a dead free tier never kills a turn.

```bash
# address a provider explicitly…
curl -s localhost:3001/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"groq/llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}'
# …or let the router pick (auto | free | fast | smart)
curl -s localhost:3001/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"auto","messages":[{"role":"user","content":"hi"}]}'
curl -s localhost:3001/v1/models     # merged catalogue, ~1000 ids
curl -s localhost:3001/health        # per-provider readiness, keys redacted
```

Keys live in `~/.autobot/freellm.json` (mode `0600`) and are **never** committed —
the repo ships `electron/freellm-config.example.json` with placeholders only.
Run it headless with `npm run freellm`. Responses carry `x-freellm-provider` and
`x-freellm-attempts` so you can see who answered.

### Subscription providers — sign in, don't paste

Four subscription providers are first-class. Open the model menu (or **⌘K**) and
pick the provider card; **Sign in** opens the vendor's own page in your default
browser and catches the redirect on a loopback port. Nothing is sent to a server
of ours — the token exchange goes straight from this machine to the vendor.

| Provider | Transport | What you need | How it authenticates |
|---|---|---|---|
| **Claude** | `anthropic` | A Claude Pro/Max subscription | OAuth (PKCE) against `platform.claude.com/oauth/authorize` with the Claude Code CLI's own client id and 8-scope set, token exchange at `platform.claude.com/v1/oauth/token` (JSON body, no `client_secret`). The loopback callback port is **ephemeral** — the CLI passes `{port: 0}` and the listener binds `127.0.0.1` *and* `::1` on the same port, so `localhost` works on both families. If the browser cannot reach the listener, the **Paste code** path uses `platform.claude.com/oauth/code/callback` as the redirect and accepts the code shown (`code#state` or a pasted redirect URL). If the **Claude Code CLI** is already signed in on this machine, **Import** adopts the keychain item `Claude Code-credentials` with no browser round-trip (and writes rotated tokens back, so the CLI stays signed in). |
| **ChatGPT** | `codex` | A ChatGPT Plus/Pro plan | OAuth against `auth.openai.com`, loopback port **1455**, scopes `openid profile email offline_access api.connectors.*`. The public Codex CLI client id is used, so the vendor sees the same client as `codex login`. |
| **Grok** | `grok` | An X Premium / SuperGrok plan | OAuth against `auth.x.ai` (`openid-configuration`), userinfo at `/oauth2/userinfo`. Inference goes through the first-party CLI proxy `cli-chat-proxy.grok.com/v1` — an OAuth token is **not** an xAI API key and `api.x.ai` rejects it. |
| **Google Antigravity** | `google` | A personal Google account with Antigravity access | Google OAuth (installed-app client, loopback), then Cloud Code at `daily-cloudcode-pa.googleapis.com/v1internal` (`fetchAvailableModels`, `streamGenerateContent?alt=sse`). The generic Gemini-CLI host answers 403 for this grant. |

Two fallbacks exist for when sign-in is not possible:

- **Import** scans this machine and reads an existing credential
  (`~/.claude/.credentials.json` or the macOS keychain item
  `Claude Code-credentials`, `~/.codex/auth.json`, …) and stores it encrypted.
- **Add key** stores a plain bearer token. For Grok a real `x.ai` API key is also
  a valid path (`api.x.ai/v1`), billed as API usage instead of against the plan.

Tokens are encrypted with Electron `safeStorage` in `~/.autobot/secrets.json`
(mode `0600`) and are separate from every other credential file this project
touches. An access token whose stated `expiresAt` has passed is still tried once
before the app asks you to sign in again — vendors frequently serve a token past
its advertised lifetime, and a 200 is a better oracle than a timestamp.

### Tool toggles

The agent exposes the complete classic Claude Code tool surface (141 total definitions)
to the model: `Bash, Edit, Write, Read, Glob, Grep, WebSearch, WebFetch, Task, Agent,
TodoWrite, NotebookEdit, NotebookRead, AskUserQuestion, KillShell, SlashCommand, Skill,
ExitPlanMode, MultiEdit, REPL, JavaScript, Cd, ListMcpResources, ReadMcpResource,
TaskStop, ListAgents, SendUserMessage, SetGoal, ToolSearch, Artifact, Jira, Linear`
— plus virtual built-in MCP namespaces (`mcp__workspace__*`, `mcp__terminal__*`,
`mcp__memory__*`, `mcp__skills__*`, `mcp__secrets__*`) and any connected MCP server's
tools (namespaced `mcp__<server>__<tool>`).

### 🧭 Role pools (job-based routing for free gateways)

When the session provider is the FreeLLMAPI router, every job gets its own
ordered model pool that fails over **downward** (Settings → Role pools →
*Load FreeLLMAPI preset*; stored as `pools` in `~/.autobot/orchestrator.json`):

| Job | Used by | Default pool (`model @maxConcurrent`) |
|---|---|---|
| Planner / Reasoner | swarm supervisor (plan + read-only review), `opus` agents | `gpt-5.6-luna @1` → `glm-5.3 @1` → `nemotron-3-ultra-550b-a55b @2` |
| Implementer / Coder | main turn, swarm workers, `Task` sub-agents (N in parallel) | `qwen3.8-flash @1` → `qwen3-coder-30b-a3b-instruct @1` → `mistral-devstral-2512 @1` → `qwen3.8-27b @3` → `nemotron-3-ultra-550b-a55b @2` → `gpt-oss-120b @3` → `kilo-auto @2` |
| Vision | turns whose last message carries images | `qwen3.8-flash` → `qwen3.8-27b` → `glm-4.6v-flash` → `gemini-3.8-flash` |
| Fast | `small` tier, `haiku`/Explore agents | `qwen3.8-27b` → `gpt-oss-120b` → `glm-4.7-flash` → `kilo-auto` |
| Long context | history larger than the head model's window | `gpt-5.6-luna` → `qwen3.8-flash` → `minimax-m3` → `deepseek-v4-flash` |

`electron/provider-gate.js` is shared by every agent in the process: a row that
answers 429 is cooled for everyone until the router's `retryAtMs` / "reset ~Ns",
a row that 404s or "lacks tool-calling" is skipped for the session, and
`@maxConcurrent` makes parallel workers spread down the pool instead of queuing
on ElectronHub's shared credits. Workers and sub-agents advertise a lean coding
tool surface (~2k tokens instead of ~15k for all 141 tools — the rest stay
callable through `ToolSearch`), which keeps Groq's per-minute token budget
usable. Subscription sessions (Claude / ChatGPT / Gemini) ignore pools and use
the classic orchestrator list.

### 🔄 Orchestrator Mode (multi-key failover)

Add **100+ API keys** in **⚙️ Settings → Orchestrator Mode** and toggle it on. When a
provider returns a rate-limit / quota / "limit reached" error (HTTP 429, `quota`,
`insufficient_quota`, billing/capacity/throttle messages), Akron Bot automatically fails
over to the **next** provider+model in your list — without interrupting the stream. You
select which models participate (each row = name + base URL + key + model) and which one
starts first (radio `#1`, `#2`, …). Failover events are shown in-chat as
`🔄 orchestrator: model A → model B`.

### 🚀 Feature toggles (local equivalents of server-side features)

| Server-side feature | Local equivalent (config-gated in Settings) |
|---|---|
| `mcp__computer__*` (Computer Use) | macOS screen capture + `osascript` System Events mouse/keyboard — gated by **Computer Use** toggle |
| Chrome control (CDP) | `ws`-based CDP client (`chrome.js`) — connect to `--remote-debugging-port=9222`, gated by **Chrome** toggle (host/port configurable) |
| `mcp__cowork__*` / `mcp__ccd_*` | cowork orchestration + cloud-continuity-drain registry (`cowork.js`) |
| Bot bridges (`hearthbot`/`slackbot`/`teamsbot`/`webagent`) | local HTTP webhook bridge server (`cowork.js`) — gated by **Bot bridges** toggle |
| `mcp__visualize__visualize` | built-in SVG chart renderer (`visualize.js`) |

---

## Architecture

```
autobot/
├── electron/          # Electron main process (CommonJS)
│   ├── main.js        # window + IPC handlers + agent orchestration + feature gates
│   ├── preload.js     # contextBridge (window.autobot.*)
│   ├── llm.js         # OpenAI /v1/chat/completions SSE + function-calling loop + orchestrator failover
│   ├── tools.js       # built-in tools (executors + schemas) + virtual MCP namespaces
│   ├── mcp.js         # stdio MCP client
│   ├── visualize.js   # SVG chart renderer (mcp__visualize__visualize)
│   ├── computer.js    # macOS screen + input control (Computer Use, gated)
│   ├── chrome.js      # Chrome CDP client (gated)
│   ├── cowork.js      # cowork orchestration + CCD + bot-bridge webhook server
│   └── store.js       # memory / settings / skills / orchestrator / features persistence (~/.autobot)
├── src/               # React renderer (Vite)
│   ├── main.jsx
│   ├── App.jsx
│   └── styles.css
├── index.html         # CSP (allows local http/https/ws for LLM endpoints)
└── package.json
```

Runtime data lives in `~/.autobot/` (`memory.json`, `settings.json`, `skills/`,
`orchestrator.json`, `features.json`).

### Bundled CLI runtimes

The DMG ships the three subscription CLIs it drives, so a fresh install works
offline-with-respect-to-downloads (nothing to `npm i -g`):

| runtime | upstream | check |
|---|---|---|
| `claude-code` | npm `@anthropic-ai/claude-code-<platform>` (`dist.integrity` sha512) | `claude --version` |
| `codex` | npm `@openai/codex` | `codex --version` |
| `grok` | pointer `https://x.ai/cli/stable` → `https://x.ai/cli/grok-<ver>-<platform>` (no upstream checksum) | `grok --version` |

They live in `vendor/runtimes/<id>/` at build time and are copied to
`Contents/Resources/runtimes/` by `extraResources`. At run time
`electron/runtimes.js` resolves `userData/runtimes/<id>/current` → bundled →
`PATH`, downloads over HTTPS with a host allowlist, sha512-verifies when the
vendor publishes one, `--version`-smoke-tests the staged binary, then atomically
swaps the `current` symlink (keeping the previous two versions for `rollback()`).
A deferred `updateAll()` ~20 s after boot refreshes anything the vendor moved.

```bash
npm run vendor:runtimes:check   # what is vendored today
npm run vendor:runtimes:sync    # --download --stale: refresh only if upstream moved
npm run dist                    # predist runs the same sync, then builds dmg+zip
```

`--stale` exists because a vendored tree is otherwise trusted forever. A stale
CLI is not a cosmetic problem: Anthropic gates **per-model** on the CLI version
in the `user-agent`, so an old bundled binary makes the newest models answer
`400 "Claude Code 2.1.154 does not support this model; version 2.1.290 or newer
is required"`. For that reason `electron/providertransport.js` never hardcodes
the fingerprint — `setClientVersions()` is refreshed from `runtimes.list()` at
boot, after the deferred update, and after every `autobot:runtimesUpdate`.

Use `--dry-run` to see the vendoring decision without downloading anything:

```text
$ node scripts/vendor-runtimes.js --download --stale --id grok --dry-run
  grok         0.2.2 → 1.0.92  (upstream is newer) [dry-run]

dry-run: nothing was downloaded.
```

An offline or failed metadata lookup keeps the existing copy and never fails a
build (`predist` falls back to plain local vendoring).

### Context windows & auto-compact

The Claude app compacts when the **model's own** window is nearly full. Akron Bot
does the same, and the window is data, not a constant:

| Resolution order | Source |
|---|---|
| 1 | live provider catalog (`/models` on Claude, `:fetchAvailableModels` on Antigravity, `/v1/models` on Grok, Codex) |
| 2 | explicit `contextWindow` on the registry entry |
| 3 | documented defaults in `electron/model-catalog.js` → `RULES` |

`electron/main.js` warms every signed-in account's catalog 3 s after boot,
again after a sign-in and again after a credential import, so a prompt typed in
the first seconds after launch is already measured against the real window. The
picker shows the resolved window (`16K`, `66K`, `200K`, `256K`, `400K`, `1M`), and
`budgetForModel()` turns it into characters at 3.4 chars/token with an output and
prompt reserve; compaction triggers at 90 % of that budget.

Three distinct paths keep a turn from stalling:

1. **Conversation too big** → earlier turns leave the working set and a one-line
   prose notice says so (the chat history and project files are untouched).
2. **One message too big** → `sanitizeHistory()` trims its middle (≥500 head and
   ≥700 tail chars kept, the latest request always survives) around a visible
   marker; `compactTo` / `shrinkLargest` fall back to 40 % head + 40 % tail.
3. **Still bigger than what one request can carry** → `chunkText()` splits the
   message into sequential sub-runs and the reply is stitched back.

A provider's *"prompt is too long / context length exceeded"* response is
classified as **non-transient** (`isContextOverflow`), so it never enters the
429 backoff ladder; the loop compacts and retries immediately. Raw vendor
wording never reaches the UI — the user sees prose.

Live proof (`build/probe-compact2.cjs`, 30 000-char prompt at a 16K model):

```
pass: true · gotToken: true · liveNotices: [ "This message was longer than
tab_flash_lite_preview's 16K context window, so its middle was trimmed — the
beginning and your latest request were kept, and the full text stays in the chat." ]
noticeIsProse: true · claimsZeroTurns: false · rawLimitLeak: false
```

### What is verified live, and what is not

Honesty over a green table — these are the only claims backed by a probe run on
this machine:

| Claim | Evidence |
|---|---|
| Code + shell + browser, antigravity `gemini-3-flash` | `build/probe-capability.cjs` **pass** — `Writing:toolcap.txt`, `Running:cat toolcap.txt` → `RUN=TOOLCAP-OK`, `Browsing:https://example.com` → `Example Domain` |
| Code + shell + browser, claude `claude-opus-4-5` | passed earlier on 2026-11-25; re-runs are blocked by the account's rate limit (`429` straight from `api.anthropic.com`) |
| Computer Use (PC control), antigravity | `build/probe-computer.cjs` **pass** — one consent prompt, `SCREEN=1280x832` |
| Logo animates only while working | `build/probe-logo.cjs` — 62 streaming samples on `logo-spin` / `logo-pulse`, `anim: none` when idle |
| Auto-compact + oversized-message trim | `build/probe-compact2.cjs` **pass** (§ above) + `test/llm-context.test.js` 6/0 |
| Grok / ChatGPT turns | **not** verified: Grok's weekly pool is spent until 2026-12-01; there is no ChatGPT account on the build machine. Their OAuth configs are vendor-validated (`build/probe-authurls.cjs`, 15/15) but no turn has completed |

`GAPS.md` tracks the same list with the exact blockers.

### Skill library export / import

`python3 scripts/export-skills.py` writes every installed skill (bundled +
`~/.config/opencode/skill` + `~/.claude/skills`) to `~/Example Skills/` as one
self-contained `.md` per skill — original frontmatter, body, and any bundled
scripts/references inlined in an appendix — plus an `INDEX.md`. To bring a file
back in, use **Skills panel → Upload .md**, or drop it in `~/.autobot/skills/`
(flat `.md` files are discovered directly).
