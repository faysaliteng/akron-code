# Claude Desktop — Reverse Engineering Report (→ Akron Bot build spec)

**Target:** `/Applications/Claude.app` — "Claude Desktop" by Anthropic PBC
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
│   ├── ion-dist.asar               (224 MB — embedded "Claude Code" engine)
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

### 2.2 Core chat/tool capabilities (Claude Code engine)
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

## 3. What Akron Bot reproduces

The build below mirrors this surface with a **pluggable OpenAI-compatible LLM adapter** (works with Ollama, LM Studio, Groq, OpenRouter, OpenAI, and any custom `/v1/chat/completions` endpoint), so it behaves like Claude Desktop but runs on **any free LLM API**:

1. **Chat UI** — streaming, markdown + code highlighting, copy buttons.
2. **Agent tool loop** — function calling with the full classic Claude Code tool surface (56 tools, see §4).
3. **MCP client** — connect to external stdio MCP servers, list & call their tools (the defining Example feature).
4. **Artifacts panel** — code/files render in a live preview pane (+ explicit `Artifact` tool). Six renderers (`html` / `svg` / `mermaid` / `react` / `markdown` / `text`) plus the two Desktop canvas types: **`design`** (rail + wrapping canvas of live `srcdoc` artboards, per-board width×height, zoom overlay, save-per-board / save-all, print) and **`slides`** (16:9 stage, keyboard nav, progress bar, speaker-notes toggle, present-fullscreen, one-slide-per-page print). All three surfaces — artifact window, in-chat preview, print-to-PDF — build from one module (`electron/artifactcanvas.js`).
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
    finished), so a run reads call-then-conclusion like Claude Desktop.

---

## 4. Tool parity — 1:1 verification

The complete classic Claude Code tool inventory is reproduced:

`Bash, Edit, Write, Read, Glob, Grep, WebSearch, WebFetch, Task, Agent, TodoWrite,
NotebookEdit, NotebookRead, AskUserQuestion, KillShell, SlashCommand, Skill,
ExitPlanMode, MultiEdit, REPL, JavaScript, Cd, ListMcpResources, ReadMcpResource,
TaskStop, ListAgents, SendUserMessage, SetGoal, ToolSearch, Artifact, Jira, Linear`

**All 32 classic tools are implemented** (56 total definitions including helpers + virtual MCP namespaces). Every classic tool name is present with a functional executor (or a config-gated integration for Jira/Linear).

### Server-side features → local equivalents (config-gated in Settings)

Claude Desktop's server-side multi-agent / cloud-collaboration / bot-bridge features are
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

Claude Desktop's sidebar now maps 1:1 onto working local features — not stubs.

### 5.1 Plugins & connectors
- Curated catalog: **467 connectors / 50 plugins / 31 categories**
  (`electron/connector-catalog.js`) mirroring the Example app's connector directory —
  Google Drive, GitHub, Slack, Notion, Linear, Jira, Figma, Postgres, Snowflake, Stripe,
  Salesforce, Zendesk, Datadog, AWS, GCP, Azure, Okta, Workday, DocuSign, … plus local
  plugins, each with `auth`, `tools` (connectors) or `provides` (plugins), and an MCP
  `endpoint` where one is publicly known.
- Live registry layer: `electron/mcpregistry.js` syncs
  `registry.modelcontextprotocol.io` (paginated, 24 h TTL, versioned disk cache
  `~/.autobot/mcp-registry.json`), categorises by keyword hints, and degrades silently
  offline. Merged pool at runtime: **963 rows** in the panel (467 curated connectors +
  50 plugins + live MCP servers), 33 categories, 451 entries with a live MCP endpoint.
- Ranking search (name > tag > description) + `suggest()` relevance across both layers.
  Multi-word queries are **AND** — every term must match, so “linear issues” narrows to
  Linear instead of widening.
- Install state persisted in `~/.autobot/plugins.json`; `install` / `uninstall` /
  `markConnected` / `setConfig`. Installing an entry that carries a transport
  auto-connects it (`sse`/`http` URL or stdio `command`), stashes `tools/list`, and
  reports failures as one human line (e.g. “this server requires sign-in before its
  tools work”) instead of a raw JSON-RPC envelope.
- Tools: `plugins__list_plugins`, `plugins__search_plugins`, `plugins__search_connectors`,
  `plugins__suggest_plugin_install`, `plugins__install`, `plugins__uninstall`,
  `plugins__directory_stats`, `plugins__refresh_registry`.
- **Real OAuth 2.1 sign-in** for every connector that advertises it (≈425 catalog rows):
  `electron/mcpoauth.js` does RFC 9728 protected-resource discovery → RFC 8414
  authorization-server metadata → RFC 7591 dynamic client registration → RFC 7636 PKCE
  S256 on an ephemeral `127.0.0.1` loopback redirect, carrying the RFC 8707 `resource`
  parameter. Tokens live in `secretstore` under `mcp-oauth:<host><path>`; the MCP
  transport attaches `Authorization: Bearer` and reconnects on success. Installed
  connectors show **Sign in** / **Sign out** pills; a failed sign-in prints one human
  line (HTML stripped, JSON-RPC envelopes unwrapped), never a raw error body.
- Panel: **Plugins & Connectors** — search, type/category filters, installed-only toggle,
  Install/Remove per card, connected badge, directory stats line (built-in vs live MCP
  servers) and a **Refresh registry** button.

### 5.1b Chrome extensions (Desktop `extension-host` parity)
- Akron Bot hosts unpacked Chrome MV3/MV2 extensions with a **real
  `chrome-extension://` origin** — `session.loadExtension()` first, with a
  privileged `helio-extension://` fallback served by `extHost.servePage` when
  native load fails.
- `electron/extensionhost.js` implements 45 namespaces (21 natively: `runtime`,
  `storage` (local/sync/session/managed), `tabs`, `windows`, `cookies`,
  `notifications`, `action`, `alarms`, `i18n`, `permissions`, `management`,
  `commands`, `contextMenus`, `extension`, `tabGroups`, `scripting`,
  `sidePanel`, `debugger`, …), permission + manifest-key gating, page serving
  with web-accessible-resource checks and path-traversal guards, event
  delivery with ack, ports, and a loopback WebSocket bridge that forwards
  anything unnamed to a real Chrome extension. Agentic ops are whitelisted to
  three (`enable`, `fillCredential`, …) and rejected otherwise with
  `{ok:false, reason:'op'}`.
- `electron/extension-preload.js` runs in two modes: **hosted** (builds the
  whole `chrome.*` surface over the main-process host) and **native**
  (`--helio-native=1`, patches only the holes Electron leaves —
  `storage.sync`/`managed`, `runtime.sendMessage` fallback,
  `runtime.onMessage` bridging).
- UI: **Plugins & Connectors → Chrome extensions** tab — installed list,
  version/MV/worker badges, permission chips, Rescan folder, Open/Close, and a
  live `installed · native · open · attached · bridge :port` status row.
- IPC: `autobot:extensionList|extensionScan|extensionOpen|extensionServePage|extensionClose|extensionStatus`
  (+ `autobot:extensionwindowError` broadcast on `did-fail-load`).
- Storage lives in `~/.autobot/extensions/<id>/`, `~/.autobot/extension-storage.json`
  and `~/.autobot/extension-state.json`.

### 5.1c Link previews (Desktop `og` / `twitter` / `xlink` parity)
- Bare URLs in a message become a preview card under the text: site name, title,
  two-line description, and the `og:image` when the page has one, with an icon
  fallback. Up to three per message; each carries a × dismiss.
- Extraction order matches Desktop: `og:title` → `twitter:title` → `<title>`;
  `og:description` → `twitter:description` → `<meta name=description>`;
  `og:image:url` → `og:image` → `twitter:image:src` → `twitter:image`;
  `og:site_name` → `twitter:site` → hostname. Entities decoded, relative URLs
  resolved, values clipped (200 / 400 chars), `data:` images dropped.
- `electron/unfurl.js` is pure Node and testable headless; results cache for
  7 days in `~/.autobot/unfurl-cache.json` (500 entries, LRU-pruned).
- Security: the renderer never fetches. `autobot:unfurl` / `autobot:unfurlMany`
  run in the main process behind an SSRF guard — loopback / private / link-local
  / CGNAT / multicast / cloud-metadata addresses refused (IPv4, IPv6 and
  hostname forms), connection pinned to the DNS-resolved IP with Host + SNI
  preserved so rebinding can't swap in an internal address, 4-hop redirect cap,
  320 KB cap, 7 s timeout, HTML content-types only, `data:` / non-http schemes
  rejected, credentials-in-URL rejected.
- Skips obvious non-pages (`.png|jpg|gif|webp|svg|mp4|mp3|pdf|zip|dmg|exe|…`).

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

### Subscription accounts — Claude Max / ChatGPT Plus-Pro / Antigravity / Grok

- **Use the subscription you already pay for.** `Model → Subscription accounts`
  signs in with loopback OAuth + PKCE and then speaks the provider's *native*
  wire format — Anthropic Messages for Claude, the `codex` Responses shape for
  ChatGPT and Grok, Cloud Code for Antigravity. No proxy needed.
- **Multiple accounts per provider.** Sign in more than once, name each one, and
  pick per conversation. Picking an account stores only
  `provider.oauthProvider = 'claude:<account>'`; the bearer is minted in the main
  process at the start of every turn, refreshed ~120 s before it expires, and
  never reaches the renderer.
- **Import what's already on this Mac** — the Claude Code keychain item, Codex
  `auth.json`, Gemini creds, Grok config. Anything that isn't there is skipped
  rather than faked.
- **Grok signs in with a browser, like Claude does.** `Sign in` opens
  `auth.x.ai/oauth2/authorize` with PKCE S256 and a loopback callback on
  `127.0.0.1`; the resulting subscription token is good against the
  first-party CLI proxy (`cli-chat-proxy.grok.com/v1`, OpenAI **Responses**
  shape) — the same flow the AFK Pilot VS Code extension uses. A paste-key
  input sits next to it for anyone holding a public-API key: the two
  coexist, and `resolve()` keeps them apart, so a public key only ever goes
  to `api.x.ai/v1` and a subscription token never leaves the CLI proxy.
  A pasted key is checked against `GET /models` before it is stored, and a
  wrong one is refused with one plain line (xAI answers `400`, not `401`) so
  it can never masquerade as a working account.
- **Honest labels.** Only Claude is verified end-to-end on this machine; the
  ChatGPT / Antigravity rows carry an `unverified` chip because their adapters
  are built from published wire formats and unit tests, not from a live account
  here. Grok keeps the chip too: the paste-key path and the proxy's 401 are
  live-proven, but the browser round-trip has not completed against a real
  account.
- **Dead account is a sign-in problem, not an LLM error**: one human line
  ("ChatGPT needs to be signed in again — open the model menu and choose Sign
  in.") and `needsSignIn: true`, never a raw OAuth code or markup.
- Files: `electron/provider-oauth.js`, `electron/providertransport.js`; suites
  `test/provideroauth.test.js` (180) and `test/providertransport.test.js` (108).

### Computer Use — see and drive the desktop, with consent

- **A real consent gate, not a checkbox.** Nothing reads the screen or moves
  the mouse until you grant a tier: `Access` (screenshot, click, type, scroll)
  or `Full control` (launching apps, global shortcuts, right-click). A grant
  can be session-only or remembered across restarts; session grants are never
  written to disk.
- **Floating live panel** (`electron/computer-panel.html`) — the model's-eye
  view, always-on-top, with drag-to-mask, pin/unpin and a Stop button.
- **Masks** hide regions of the screen from the model (≤32 rectangles,
  degenerate ones dropped). **Protected content** (video call sharing, Netflix,
  Hulu, Apple TV, Spotify…) is detected and withheld automatically.
- **Read-only is not harmless**: every Computer Use tool is gated, including
  `screenshot` — it reads your whole screen.
- **Shared with the browser tools**: the same turn can drive the built-in
  browser pane *and* the desktop.
- Files: `electron/computeruse.js`, `electron/computer-panel.html`,
  `electron/tools.js` (`isMutatingTool`), `electron/main.js` (`approveTool`);
  suites `test/computeruse.test.js` (67), `test/computergate.test.js` (6).

### Desktop lifecycle — geometry, deep links, launch at login

- **The window remembers where it was.** Geometry persists to
  `~/.autobot/window-state.json`, debounced 400 ms; a position that no longer
  touches any display is dropped instead of opening off-screen; maximise is
  reapplied on show.
- **`helio://` links work.** `helio://new`, `helio://chat/<id>`,
  `helio://search?q=…`, `helio://settings`, `helio://ask?q=…`. A second launch
  focuses the running window and hands it the link (single-instance lock), so
  two processes never fight over `~/.autobot`.
- **Launch at login** is a Settings toggle mirrored to the OS login item.
- Files: `electron/windowstate.js`, `electron/main.js`; suite
  `test/windowstate.test.js` (18).

### Local filesystem + per-conversation project folders

- **`electron/paths.js`** — `expandPath`/`resolvePath` expand `~`/`$HOME`/`~user` so every
  tool lands files in the real filesystem, never a literal `~/` directory.
- **`electron/workspace.js`** — every conversation gets a project folder under
  `~/Akron Bot/<slug>` created on demand (Example "auto create a project folder" parity),
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
  conversation's project folder (`~/Akron Bot/<slug>/MINDMAP.md`). It captures the goal
  (first user message), todos, decisions, file list, last exchange and working directory.
  `workspace.js` auto-creates a stub the moment a folder is created; `main.js` refreshes it
  on every completed or stopped run.
- **Injection** — `runAgent` appends `<project_workspace>` **and** `<project_mindmap>` to the
  first system message, so the very next model that takes over reads the full project state
  from the prompt itself — no shared provider memory required. Verified end-to-end
  (`test/live/hb-mindmap-inject.cjs` → PASS; 4 regression tests in `test/e2e.test.js`).


### Organization compliance — the `taint:*` capability panel (2026-11-25)

Settings → **Compliance** reproduces the Desktop organization-capability gate
locally. The profile is a file on this machine (`~/.autobot/compliance.json`);
nothing is fetched from an account backend, and no data leaves the device.

- **Capability catalogue** — 15 `taint:*` capabilities plus the three retention
  flags (`zero_retention_lock`, `retain_restricted_pii`,
  `no_anthropic_human_review_enabled`), each with an authored label, an effect
  list and its raw code chip. `taint:limit-to-service-terms-<term>` is handled
  as a prefix row and shown as the term it limits.
- **Nine derived verdicts** — Retention (`allowed` / `marked` / `unknown`),
  HIPAA (`regulated` / `not_regulated` / `not_known`), CMEK (`blocked` /
  `not applicable`), Cloud & model moves, MCP tool toggles, Session deletion,
  Product feedback, Deployment, Chat. The headline badge is one authored
  sentence explaining the most severe consequence.
- **What it actually gates** — `/delete` awaits the deletion gate and prints
  *"This session can't be deleted while the workspace is marked
  HIPAA-regulated."* instead of removing the conversation; `/feedback` turns
  off under FERPA or the explicit disable flag; allowed deletions append a row
  to `~/.autobot/compliance-audit.jsonl` (rotated at 512 KB, newest-first
  reads). HIPAA takes precedence over ZDR.
- **No new tools** — the capability set is a settings surface, not a tool, so
  the tool count stays at 141 and the swarm frontier gate is unchanged.
- Tests: `node test/compliance.test.js` → **147 passed, 0 failed**;
  live CDP verified the HIPAA / ZDR / CMEK profiles end to end.

### FreeLLMAPI — one OpenAI-compatible endpoint over seven free providers (2026-11-25)

`http://localhost:3001/v1` is a local router that presents the OpenAI wire format
and multiplexes to Groq, Google Gemini, Cloudflare Workers AI, NVIDIA NIM,
Cohere trial, Kilo and OpenRouter.

- **Addressing** — `provider/model`, `provider:model`, a bare provider id (→ its
  configured default), a `freellm/` prefix, or an alias: `auto` / `free` / `fast`
  / `smart`.
- **Fallback** — 429, 5xx, network failure and empty completions fall through to
  the next configured provider, but only *before* the first stream byte reaches
  the client. An explicit `provider/…` request never falls back, so you get the
  error you asked for.
- **Surfaces** — `POST /v1/chat/completions` (stream + non-stream),
  `GET /v1/models` (merged, ~1000 ids, 10-minute cache), `GET /health`
  (all providers + defaults, keys redacted), `GET /v1/providers`. CORS `*`,
  8 MB body cap, optional `FREELM_TOKEN` bearer gate.
- **Secrets** — `~/.autobot/freellm.json` at mode `0600`; env overrides
  (`GROQ_API_KEY`, `GEMINI_API_KEY`, …) win when present. Repo ships only
  `electron/freellm-config.example.json` with `PASTE_*` placeholders.
- **Error hygiene** — upstream HTML is flattened to a single sentence, so a 429
  reads `rate-limited`, never markup.
- **In-app** — starts inside `app.whenReady()` (non-fatal on failure) and stops
  on `will-quit`; Settings exposes status, providers and a save-and-restart path
  through `autobot:freellmStatus` / `autobot:freellmProviders` /
  `autobot:freellmSave`. Preset **`FreeLLMAPI (local router)`** points at it.
- **Provider quirks encoded** — Cloudflare `/ai/v1/chat/completions`; Kilo
  `/api/openrouter/chat/completions` (5–20 s, reasoning field); Gemini
  `/v1beta/openai/chat/completions` with current model names; Cohere
  `api.cohere.com` (no `/models` compat path); OpenRouter `:free` ids only;
  reasoning models need `max_tokens ≥ 300` before `content` is non-empty.
- Tests: `node test/freellm.test.js` → **37 passed, 0 failed** (hermetic, fake
  upstream); all seven keys proven live through the router with `PONG`.

### Brand mark + emerald palette (2026-11-25)

The mark is a 12-ray emerald symbiote (`#10B981`), `#A7F3D0` inner glow at 0.55,
six orbit tendrils and a gooey filter — one set of geometry constants drives the
in-app `FullMark`/`CompactMark`, the tray template image and the app icon.

- **Canonical artwork** — `build/logo-mark.svg` (animated), `build/icon.svg`
  (dark squircle plate), `build/tray.svg` (monochrome, thick rays for 16 px).
- **Rasterisation** — `npm run icons` → `build/render_icon.cjs` drives
  Electron/Chromium (`canvas.toDataURL`) to emit `icon.png` (1024),
  `icon.iconset/*`, `icon.icns` and `trayTemplate{,@2x}.png`. macOS template
  naming means the menu-bar icon auto-inverts.
- **Palette** — dark `--accent #10b981` / `--accent-strong #059669` /
  `--accent-text #a7f3d0`; light `--accent #047857` / `#036b4e` / `#065f46`.
  `--green` semantic tokens are untouched; warnings moved to amber so they no
  longer read as brand.
- **Every surface swept** — About window, MCP-OAuth result page, `quick.html`
  overlay, Computer-Use panel, artifact canvas chrome, artifact swatch
  (`clay` → `emerald`), landing page. Zero `#D97757` remains in source.
