# Example Desktop — Reverse Engineering Report (→ Helio Bot build spec)

**Target:** `/Applications/Claude.app` — "Example Desktop" by Anthropic PBC
**Version:** `6.28899.6` (commit `2f5fc59b2d1c672dd9dced86720c50f48cca0cf9`, 2026-11-20)
**Bundle ID:** `com.anthropic.claudefordesktop` · package `@ant/desktop`
**Runtime:** Electron **45.3.3** · Node ≥22 · Vite + Ionic UI

---

## 1. Architecture

```
Claude.app (Electron 45.3.3)
├── MacOS/Example                    (120 KB launcher stub — Mach-O universal arm64)
├── Resources/
│   ├── app.asar                    (106 MB → 208 MB unpacked — the desktop UI shell)
│   │   └── .vite/build/*.js        (Vite-bundled renderer + main-process modules)
│   ├── ion-dist.asar               (224 MB — embedded "Example Code" engine)
│   ├── app.asar.unpacked/
│   │   ├── resources/github-mcp/   (bundled GitHub MCP server)
│   │   ├── resources/office365-mcp/ (bundled Office365 MCP server: msal-node-runtime)
│   │   └── node_modules/node-pty   (native terminal)
│   └── electron.asar               (Electron framework runtime)
└── Frameworks/ (Electron Framework, Squirrel, Mantle, ReactiveObjC)
```

**Monorepo workspaces** (from `package.json` deps):
- `@ant/desktop` — the Electron shell
- `@ant/example-native` — native (Swift/ObjC) bridge
- `@ant/example-swift` — Swift helpers
- `@ant/computer-use-mcp` — Computer Use MCP server
- `@ant/imagine-server` — image generation server
- `@ant/example-for-chrome-mcp` — Chrome control MCP

**Key runtime deps:** `ws` (WebSocket bridge), `https-proxy-agent`, `node-pty` (terminal), `@loc/electron-window`.

---

## 2. Full feature surface (extracted from the bundle)

### 2.1 Model families
`claude-3-5-haiku`, `claude-3-5-sonnet`, `claude-3-7-sonnet`, `claude-3p` / `claude-3p-dev` (preview line), `example-agent-sdk`.

### 2.2 Core chat/tool capabilities (Example Code engine)
`Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, `Agent`, `TodoWrite`, `NotebookEdit`, `NotebookRead`, `AskUserQuestion`, `KillShell`, `SlashCommand`, `Skill`, `ExitPlanMode`.

### 2.3 Native MCP tool surface (67 tools) — grouped
| Group | Tools |
|---|---|
| **Workspace** | `workspace__bash`, `workspace__web_fetch` |
| **Terminal** | `terminal__open_terminal_tab`, `read_terminal`, `run_in_terminal`, `stop_terminal_tab` |
| **Memory** | `memory__memory_list`, `memory__memory_read` |
| **Skills** | `skills__list_skills`, `skills__suggest_skills` |
| **Plugins** | `plugins__list_plugins`, `search_connectors`, `search_plugins`, `suggest_plugin_install`, `directory_stats`, `refresh_registry` |
| **MCP Registry** | `mcp-registry__list_connectors`, `search_mcp_registry`, `suggest_connectors` |
| **Scheduled tasks** | `scheduled-tasks__create/list/update_scheduled_task` |
| **Cowork (multi-agent)** | `cowork__create_from_type`, `db_write`, `launch_code_session`, `present_files`, `publish_files`, `request_cowork_directory`, `upload_asset`, `import_files`, `allow_cowork_file_delete` + `cowork-onboarding__show_onboarding_role_picker` |
| **Chrome control** | `claude-in-chrome__navigate`, `read_page`, `get_page_text`, `form_input`, `computer`, `upload_image`, `tabs_*`, `shortcuts_*`, `read_console_messages`, `read_network_requests`, `gif_creator`, `javascript_tool`, `file_upload`, `browser_batch` |
| **Remote devices** | `remote-devices__computer_*` |
| **Session orchestration** | `ccd_session__*`, `ccd_session_mgmt__*`, `ccd_turn__update_plan`, `ccd_view__show_pane`, `ccd_window__open_session_in`, `conversation__reply` |
| **GitHub** | `github__get_*` |

### 2.4 Product features (feature-flag strings)
- **Artifacts** — `artifactAppWindow`, `coworkArtifact`, `examplePagePreview`, `artifactsEnabled`, `artifactsSlidesEnabled`, `artifactsDesignEnabled`
- **Computer Use** — `computerUseTeach`, `computerUseWatchRecord`, Android `emulator-grpc-worker`
- **Extensions** — `extensionWindow`, `extensionWorker`
- **File indexing** — `file-index-worker`
- **MCP** — `mcpServers`, `mcpEnableServer`, `mcpReconnect`, `mcpCallTool`, `mcpListResources`, `mcpReadResource`, `mcpAuthenticate`, `mcpSubmitOAuthCallbackUrl`, `mcpToolTimeoutSec`, `mcpCallsPerMinute`, `mcpPersistentAlwaysAllowEnabled`, `mcpServerPolicy`
- **Memory** — `.auto-memory`
- **Projects / Spaces / Shares / Notebooks / Scheduled tasks**
- **Chrome import** — `example-chrome-import`, screenshots
- **Buddy** (embedded pairing assistant)

### 2.5 API surface
- Anthropic API: `api.anthropic.com`, `/v1/messages`, SSE `stream_event`, `content_block`, `text_delta`, `thinking`, `tool_use` (the Anthropic Messages streaming protocol).

---

## 3. What Helio Bot reproduces

The build below mirrors this surface with a **pluggable OpenAI-compatible LLM adapter** (works with Ollama, LM Studio, Groq, OpenRouter, OpenAI, and any custom `/v1/chat/completions` endpoint), so it behaves like Example Desktop but runs on **any free LLM API**:

1. **Chat UI** — streaming, markdown + code highlighting, copy buttons.
2. **Agent tool loop** — function calling with the full classic Example Code tool surface (56 tools, see §4).
3. **MCP client** — connect to external stdio MCP servers, list & call their tools (the defining Example feature).
4. **Artifacts panel** — code/files render in a live preview pane (+ explicit `Artifact` tool).
5. **Memory** — persistent `.auto-memory` store.
6. **Skills registry** — list/load skills.
7. **Provider settings** — base URL / API key / model / presets.
8. **Conversation persistence** — projects-like local history.
9. **Notebooks** — `NotebookRead` / `NotebookEdit` + a Notebooks panel.
10. **Terminal** — persistent multi-tab shell (`mcp__terminal__*`) + Terminal view.
11. **Sub-agents** — `Task` / `Agent` spawn parallel sub-agents (`TaskStop`, `ListAgents`).
12. **Interactive questions + plan mode** — `AskUserQuestion` / `ExitPlanMode` pause the agent for UI approval.
13. **Slash commands** — `/help /clear /compact /model /review /memory /reset /status`.
14. **Code execution** — `REPL` (js/python/bash) and `JavaScript`.
15. **Integrations** — `Jira`, `Linear` (config-gated via env vars).
16. **Orchestrator Mode** — add 100+ API keys; auto-switch to the next provider+model on
    rate-limit / limit-reached; toggle from Settings; user selects participating models.
17. **Computer Use** — macOS screen capture + `osascript` System Events input (config-gated).
18. **Chrome control** — `ws` CDP client for `--remote-debugging-port` (config-gated).
19. **Cowork + CCD** — local multi-agent orchestration with **per-worker provider pinning** and parallel fan-out (cloud + local LLMs in one goal), plus the drain registry (`cowork.js`).
20. **Bot bridges** — local HTTP webhook bridge server for hearthbot/slackbot/teamsbot/webagent.
21. **Visualize** — built-in SVG chart renderer (`visualize.js`).
22. **Example-order transcript** — tool cards render above the assistant answer (streaming and
    finished), so a run reads call-then-conclusion like Example Desktop.

---

## 4. Tool parity — 1:1 verification

The complete classic Example Code tool inventory is reproduced:

`Bash, Edit, Write, Read, Glob, Grep, WebSearch, WebFetch, Task, Agent, TodoWrite,
NotebookEdit, NotebookRead, AskUserQuestion, KillShell, SlashCommand, Skill,
ExitPlanMode, MultiEdit, REPL, JavaScript, Cd, ListMcpResources, ReadMcpResource,
TaskStop, ListAgents, SendUserMessage, SetGoal, ToolSearch, Artifact, Jira, Linear`

**All 32 classic tools are implemented** (56 total definitions including helpers + virtual MCP namespaces). Every classic tool name is present with a functional executor (or a config-gated integration for Jira/Linear).

### Server-side features → local equivalents (config-gated in Settings)

Example Desktop's server-side multi-agent / cloud-collaboration / bot-bridge features are
reproduced as **local equivalents** (not stubbed dead), each gated by a Settings → Feature
toggle:

- `mcp__cowork__*` / `mcp__ccd_*` / `mcp__conversation__reply` → `cowork.js` — local
  cowork orchestration (`register_worker`/`list_workers`/`orchestrate`) + CCD
  continuity-drain registry (`ccd_submit`/`ccd_list`/`ccd_drain`). Each worker may be
  **pinned to its own backend** (`baseURL`/`model`/`apiKey`/`supportsTools`/`systemPrompt`),
  so a single goal fans out to mixed providers (e.g. NVIDIA NIM + a local Ollama Gemma)
  **in parallel** with bounded concurrency (default 4). Precedence: per-call override →
  worker pin → call-wide fallback; a pinned worker never inherits the parent's
  orchestrator failover list. Results carry per-worker `provider` + `ms`, and a dead
  worker returns `status:'error'` without aborting the others.
- Bot bridges (`hearthbot` / `slackbot` / `teamsbot` / `webagent`) → `cowork.js` local
  HTTP webhook bridge server (gated by **Bot bridges** toggle).
- `mcp__visualize__visualize` → `visualize.js` SVG chart renderer (`render`/`normalizeSeries`).
- Computer Use → `computer.js` macOS screen capture + `osascript` System Events
  mouse/keyboard (gated by **Computer Use** toggle; `setEnabled`/`isEnabled`).
- Chrome control → `chrome.js` `ws`-based CDP client (`configure`/`getTargets`/
  `connectToTarget`/`evaluate`, gated by **Chrome** toggle, host/port configurable).

---

## 5. Product-surface parity: Plugins, Scheduled tasks, Custom skills (2026-11-25)

Example Desktop's sidebar now maps 1:1 onto working local features — not stubs.

### 5.1 Plugins & connectors
- Curated catalog: **406 connectors / 50 plugins / 31 categories**
  (`electron/connector-catalog.js`) mirroring the Example app's connector directory —
  Google Drive, GitHub, Slack, Notion, Linear, Jira, Figma, Postgres, Snowflake, Stripe,
  Salesforce, Zendesk, Datadog, AWS, GCP, Azure, Okta, Workday, DocuSign, … plus local
  plugins, each with `auth`, `tools` (connectors) or `provides` (plugins), and an MCP
  `endpoint` where one is publicly known.
- Live registry layer: `electron/mcpregistry.js` syncs
  `registry.modelcontextprotocol.io` (paginated, 24 h TTL, versioned disk cache
  `~/.autobot/mcp-registry.json`), categorises by keyword hints, and degrades silently
  offline. Merged pool at runtime: **850 connectors** (406 curated + 444 live).
- Ranking search (name > tag > description) + `suggest()` relevance across both layers.
- Install state persisted in `~/.autobot/plugins.json`; `install` / `uninstall` /
  `markConnected` / `setConfig`. Installing an entry that carries a transport
  auto-connects it (`sse`/`http` URL or stdio `command`), stashes `tools/list`, and
  reports failures as one human line (e.g. “this server requires sign-in before its
  tools work”) instead of a raw JSON-RPC envelope.
- Tools: `plugins__list_plugins`, `plugins__search_plugins`, `plugins__search_connectors`,
  `plugins__suggest_plugin_install`, `plugins__install`, `plugins__uninstall`,
  `plugins__directory_stats`, `plugins__refresh_registry`.
- Panel: **Plugins & Connectors** — search, type/category filters, installed-only toggle,
  Install/Remove per card, connected badge, directory stats line (built-in vs live MCP
  servers) and a **Refresh registry** button.

### 5.2 MCP registry
- Tools: `mcp-registry__list_connectors`, `mcp-registry__search_mcp_registry`,
  `mcp-registry__suggest_connectors` (shares the curated catalog and scoring).
- IPC: `autobot:registryStatus`, `autobot:refreshRegistry`, `autobot:pluginStats`.

### 5.3 Scheduled tasks
- Store: `~/.autobot/scheduled-tasks.json`; cadences `once | every | hourly | daily |
  weekly`; `computeNext()` / `describe()`; 30 s ticker started on `whenReady`, stopped on
  `will-quit`; serialized runs; per-run `{at, ok, output, error}` + `runCount`.
- Headless `runAgent` execution; provider = user's selected provider → first enabled
  orchestrator. Renderer mirrors the active provider into main.
- Tools: `scheduled-tasks__create_scheduled_task`, `…list_scheduled_tasks`,
  `…update_scheduled_task`, `…delete_scheduled_task`, `…run_scheduled_task`.
- Panel: **Scheduled tasks** — create (name, prompt, cadence, time, day-of-week),
  enable/disable, run-now, delete, next-run + last-result, live refresh.

### 5.4 Custom skills via `.md` upload
- `store.addCustomSkill(name, content)` — slugify, auto-frontmatter, write
  `~/.autobot/skills/<slug>.md`, invalidate cache → immediate discovery as `source:'custom'`.
- `store.deleteCustomSkill(name)` — removes custom skills only.
- Tools: `create_skill`, `delete_skill` (the model can author skills mid-session).
- Panel: **Skills** — **Add skill (.md)** file picker, **New skill** inline author,
  `CUSTOM` badge, per-row delete, re-reads disk on open.

### 5.5 Model picker status (key · quota · credit)
- **Per-endpoint key map** — credentials persist under `autobot:providerKeys`, keyed by the
  normalised base URL, so selecting a different preset never reuses (or drops) another
  provider's key. Settings writes every typed key back to its own endpoint; presets that
  ship a key seed the map.
- **Live status probe** — `electron/providerstatus.js`: `classify(status, body)`,
  `probe(baseURL, apiKey)`, `probeMany(list)`. One cheap authenticated `GET
  {baseURL}/models` per unique endpoint (no tokens burned), 6 s timeout, results cached in
  the renderer for 60 s and refreshed whenever the picker opens.
- **States** — `ok` (2xx, green filled dot, light-green row), `out` (402 / 403-with-credit /
  quota text in a 429, red dot), `badkey` (401/403, dim row + red dot), `unknown`
  (4xx/5xx/network, hollow dot), `nokey` (no credential — row grayed out), local endpoints
  are probed without a key.
- **Cache binding** — every verdict is stored with the key tail (`sig`) and a timestamp
  (`at`); `statusOf()` (`src/providerstatus-ui.mjs`) ignores a verdict learned from a
  different key and expires it after 60 s. Pasting a new key therefore re-probes on the
  next picker open instead of inheriting the previous dot. The composer pill probes the
  active endpoint on load, so it shows a dot before the menu is ever opened.
- **Picker** — `.model-dot` per row, light-green `.live` tint for accepted keys,
  `.dim` 45 % opacity for models with no key, active row gets a green left bar; the
  composer pill mirrors the active endpoint's dot. Clicking a grayed-out row preloads the
  preset and opens Settings so the key can be pasted immediately.
- IPC: `window.autobot.probeProviders([{baseURL, apiKey}])` → `{ [base]: {state, detail} }`.

### Local models (Ollama) — real discovery, not a hard-coded name

- The picker asks the local server what is actually pulled (`GET /api/tags`, then
  `/v1/models`), so **every installed model gets its own row** — `gemma4:latest`,
  `hf.co/unsloth/gemma-4-E4B-it-GGUF:Q4_K_M`, … — tagged `Ollama · installed`.
- Cold start: if nothing is listening on `:11434`, the picker offers
  **Connect Ollama (local)**, which starts `ollama serve` (PATH + Homebrew + Ollama.app
  bundle paths) and selects the first installed model.
- Settings → Providers has the same control (Scan / Start, model count, model chips).

### Local filesystem + per-conversation project folders

- **`electron/paths.js`** — `expandPath`/`resolvePath` expand `~`/`$HOME`/`~user` so every
  tool lands files in the real filesystem, never a literal `~/` directory.
- **`electron/workspace.js`** — every conversation gets a project folder under
  `~/Helio Bot/<slug>` created on demand (Example "auto create a project folder" parity),
  persisted in `~/.autobot/workspaces.json`, with a `scratch()` folder for headless runs.
- **Bash tool** runs through a genuine login shell (`/bin/zsh -l -c`) so `brew`/`npm`/`pip`
  binaries resolve exactly as in Terminal.
- **IPC** — `getDefaultCwd`, `getWorkspace`, `setWorkspace`, `pickFolder`; `autobot:run`
  defaults to the conversation workspace. The composer "Change" button and Code-panel picker
  rebind the working directory and persist it per conversation.
- **Computer Use ON by default** — screen capture + mouse/keyboard/application control
  gated on, with a one-line Accessibility prompt when the permission hasn't been granted yet.

### Cross-model continuity — per-project mindmap (2026-11-25)

Switching models mid-conversation (gemma4 → Kimi → DeepSeek → Nemotron → TokenRouter)
keeps **the same project folder, memory, chat history and project state**. No provider
holds the conversation — everything is keyed by `convId` on the client:

- **Conversation history** persists under `autobot:convs` keyed by `convId`; the active
  model (`autobot:provider`) and its per-endpoint keys (`autobot:providerKeys`) are stored
  separately, so changing models never touches the transcript. Memory (`~/.autobot/memory.json`)
  is global, injected via `<long_term_memory>`, and applies across every model.
- **Per-project mindmap** — `electron/mindmap.js` writes a `MINDMAP.md` into each
  conversation's project folder (`~/Helio Bot/<slug>/MINDMAP.md`). It captures the goal
  (first user message), todos, decisions, file list, last exchange and working directory.
  `workspace.js` auto-creates a stub the moment a folder is created; `main.js` refreshes it
  on every completed or stopped run.
- **Injection** — `runAgent` appends `<project_workspace>` **and** `<project_mindmap>` to the
  first system message, so the very next model that takes over reads the full project state
  from the prompt itself — no shared provider memory required. Verified end-to-end
  (`test/live/hb-mindmap-inject.cjs` → PASS; 4 regression tests in `test/e2e.test.js`).

