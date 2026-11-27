# Changelog

All notable changes to **Akron Code** are documented here.

## [1.5.6] - 2026-11-27

### Fixed & Hardened
- **Durable Settings & Orchestrator Mode Persistence Across Restarts (`src/utils/settingsPersistence.js`, `src/App.jsx`, `SettingsModalBody.jsx`, `SettingsSections.jsx`, `ExtendedSettingsPanels.jsx`, `electron/ipc/ipc-features.js`, `electron/main.js`):**
  - Synchronized enabling/disabling Orchestrator Mode with `provider.routingMode` (`'orchestrator'` / `'direct'`) across Settings checkboxes, Role Pool presets, Paid Providers, and Auto-Switch toggles, plus boot-time self-healing whenever `~/.autobot/orchestrator.json` has `enabled: true`.
  - Fixed `App.jsx` boot hydration (removed the `if (!base || !saved.apiKey) return` guard that dropped OAuth, `orchestrator`, `auto`, and keyless endpoints) and gated `localStorage` + `~/.autobot/settings.json` mirror writes behind `settingsAdopted` with `_updatedAt` conflict resolution so fresh or upgraded profiles never clobber saved config.
  - Added full disk + `localStorage` persistence for all 50+ Appearance, Harness Profile, Notifications, Sounds, System (`preventSleep`, `keepInTray`), Browser, and Composer session UI toggles (`swarmEnabled`, `webSearch`, `styleId`, `sidebarCollapsed`, `workbenchMode`, `permissions`, `projects`), plus startup `preventSleep`/`keepInTray` restoration, `RolePoolsEditor` unmount/`beforeunload` draft flush, and persisted Outbound Relay settings.
  - Updated bundled **Akron Browser Bot** to **`v1.6.12`** so toggling Orchestrator, pool checkboxes, or Agent/Policy/Tools settings in the extension Options page auto-saves immediately and flushes on `pagehide`.

## [1.5.5] - 2026-11-27

### Fixed & Upgraded
- **Akron Browser Bot `v1.6.11` Pre-Flight Probe, Yieldable `:8766` Bridge Daemon & Seamless Handoff (`resources/akron-browser-bot/`, `electron/extbridge.js`, `scripts/start-bridge-daemon.js`):**
  - Updated bundled **Akron Browser Bot** to **`v1.6.11`**: `createBridgeLink()` now probes `GET http://127.0.0.1:8766/v1/health` before opening a WebSocket so offline intervals never log `WebSocket connection to 'ws://127.0.0.1:8766/' failed:` errors in `chrome://extensions` / `brave://extensions`.
  - Added `yieldable: true` mode in `electron/extbridge.js` + `scripts/start-bridge-daemon.js` so a standalone `:8766` bridge daemon can serve all `~/.autobot` OAuth accounts (`Claude`, `Codex`, `Antigravity/Gemini`), Orchestrator pools, and `FreeLLMAPI` / `akron-default`, and cleanly yields `:8766` to `Akron Code.app` via `POST /v1/ext/yield`.

## [1.5.4] - 2026-11-27

### Fixed & Upgraded
- **Akron Browser Bot `v1.6.10` Sync, No-Downgrade Installer & `:8766` Zero-Key Proxy Hardening (`resources/akron-browser-bot/`, `electron/browser-ext-installer.js`, `electron/extbridge.js`):**
  - Bundled **Akron Browser Bot `v1.6.10`** (`desktopBridge: true` by default + built-in GitHub Releases auto-updater) directly inside `resources/akron-browser-bot/`.
  - Added semver comparison (`compareSemver`) in `syncStandaloneExtension()` so launching Akron Code Desktop **never downgrades** a newer GitHub auto-updated extension folder.
  - Hardened `electron/extbridge.js` on `127.0.0.1:8766` to accept both `/v1/models` & `/models` and `/v1/chat/completions` & `/chat/completions`, return explicit `503` diagnostics (never `404`) if no AI provider/account is configured yet, and run a 10-second background reclaim loop when `state.shared === true` to reclaim `:8766` whenever a standalone MCP listener yields or exits.

## [1.5.3] - 2026-11-27

### Fixed & Hardened
- **Images & Video Studio Overlap, Alignment & Container Queries (`src/styles/media-doc-studio.css`, `src/components/MediaStudioView.jsx`):**
  - Replaced `repeat(auto-fit, minmax(160px, 1fr))` + rigid `min-width: 240px` on `.media-studio-field-model` (which overflowed Column 1 onto `Aspect Ratio` and `Animate Source Image (Optional)`) with proportional desktop grid tracks (`minmax(230px, 1.9fr) repeat(3, minmax(120px, 1fr)) auto`), `min-width: 0` on all grid children, uniform `34px` control heights, concise single-line field labels with full hover tooltips, and `@container` responsive breakpoints (`<= 860px`, `<= 500px`) inside `.media-studio-composer`.
  - Widened `.media-studio-search` (`width: 268px; max-width: 100%`) so `"Filter by name, prompt, or model…"` renders unclipped, made `.media-model-picker.is-compact` responsive inside cards, aligned card action bars via `.media-studio-grid .media-doc-actions { margin-top: auto }`, and fixed `[data-theme="light"]` contrast on `.media-doc-tab.on` and `.media-studio-gen-btn`.
- **App-Wide Split-Pane Responsiveness, Light-Theme Contrast & Input Placeholders (`src/styles.css`, `src/styles/workspace-panels.css`, `src/components/chat/WorkspaceViews.jsx`, `src/components/settings/`):**
  - Added `container-type: inline-size` + `min-width: 0` across `.cust-hub`, `.cust-hub-inner`, `.cust-market-card`, `.scheduled-panel`, and `.settings-body`; added `flex-wrap: wrap` on `.auto-task-head` so Automations card titles never crush beside action controls when a side pane is open.
  - Replaced hardcoded dark `#1b1c1f` / `#18191c` colors in `.conv-popover`, `.rv-pane`, and `.doc-preview-pane` with theme tokens and crisp `[data-theme="light"]` overrides (and matched `[data-theme="light"]` alongside `.light` on `.duet-*` and `.mc-*` pills); fixed `.project-new button` green-on-green contrast (`#059669` bg / `#ffffff` text) and shortened overlong input placeholders in Global Search, Paradev Key, Relay URL, and FreeLLM platform filter.
- **macOS Window Capture Fallback (`electron/computer.js`):**
  - Added `appScreenshotViaElectron` (`desktopCapturer`) fallback when `/usr/sbin/screencapture -l` lacks CLI Screen Recording TCC permission.
- **Automated Live Full-App DOM Overlap & Contrast Suite (`test/live/ui-layout-overlap-audit.cjs`):**
  - Audits sibling bounding-box intersections, canvas-measured placeholder clipping, container horizontal overflows, and WCAG contrast across Dark, Light, and Narrow Split-Pane modes for every workspace view and Settings section.

## [1.5.2] - 2026-11-27

### Fixed & Upgraded
- **Antigravity Thinking Timeout & Honest Retry Reporting (`electron/providertransport.js`, `electron/llm.js`):**
  - Raised default connect timeout (`120s`, `180s` for deep-thinking/frontier models) and stream stall timeout (`150s`) so deep-thinking models like `gemini-4-carbon` do not abort at `45s` before the first byte.
  - Stopped mislabeling HTTP-less connection timeouts as `'rate limited'`: timeouts now report `'provider connection timed out'`, cap single-provider timeout retries at 2 attempts, and emit `status` + `notice` events rather than injecting fake lines into the model's `Thought` block.
- **Click-to-Open `.md` Files & Rendered Document Preview (`src/utils/linkAndFileHelpers.js`, `src/components/chat/DocPreviewPane.jsx`, `src/components/CodeReviewPane.jsx`, `src/ide/MonacoPane.jsx`, `src/App.jsx`):**
  - Made inline file references in Markdown messages (`` `report.md` ``) and `file://` links clickable (`DocPreviewPane` Rendered/Raw Markdown viewer on click, Monaco IDE on `Alt+Click`).
  - Added **Preview** & **Open** buttons plus a custom right-click context menu (`Preview Rendered File`, `Open in IDE Editor`, `Expand / Collapse Diff`, `Copy File Path`) in `CodeReviewPane`, fixed `IdeWorkbench` external string-path handling (`{ path, at }`), and added a **Preview** toggle for Markdown files inside `MonacoPane`.
- **Built-in Browser Link Routing & Bare Domain Linkification (`src/utils/appHelpers.jsx`, `src/utils/linkAndFileHelpers.js`, `src/components/browser/BrowserPaneView.jsx`, `electron/main.js`):**
  - Automatically linkifies bare domain+path URLs in assistant Markdown (e.g. `community.lovable.app/events`, `luma.com/lovable`), routes clicked web links into Akron Code's built-in Browser pane (`newTab` preserved when another site is open, `Alt+Click` opens external browser), and adds a `will-navigate` guard in `main.js`.
- **Dynamic Live Model Discovery, Retired-Model Fallback & Per-Model Thinking Controls (`electron/model-catalog.js`, `electron/providertransport.js`, `electron/ipc/ipc-oauth-models.js`, `electron/llm.js`, `src/components/chat/InputBarView.jsx`):**
  - Grouped discrete Antigravity sibling tiers (`-minimal/-low/-medium/-high/-xhigh`) into `thinkingVariants` / `thinkingLevels`, propagated Anthropic/Codex/Grok thinking capability metadata, added 30-min periodic background catalog refresh + `Refresh models` button, auto-replaced retired/removed models in `hydrateProvider` / `validateOrchestrator` / mid-turn `404`, and updated composer `Thinking` menu (`XHigh`, `N/A` disabled pill for non-thinking models, and sibling auto-switching).
- **Capability Report Tooling Fixes (`electron/tools/browser-executors.js`, `electron/computer.js`):**
  - Fixed `require('../browser-bot-v2')` path in `browser_read` / `browser_vault_autofill` and added JXA `isNil` function guard + `Array.isArray` / `System Events` fallback in macOS `listWindowsStructured`.

## [1.5.1] - 2026-11-27

### Fixed & Wired End-to-End
- **Stripped-Cache `2`-Token Context Bug & Poisoned Session Recovery (`electron/usage-estimator.js`, `src/utils/appHelpers.jsx`):**
  - Added full vendor cache-token normalization across Anthropic nested `cache_creation.ephemeral_*_input_tokens`, OpenAI `prompt_tokens_details.cached_tokens` / `input_tokens_details.cached_tokens` (without double-counting), and Gemini `cachedContentTokenCount` / `cached_tokens`, plus a wire-estimate sanity floor whenever OAuth gateways strip cached tokens down to uncached tail counts (such as `context_tokens: 2`).
  - Updated `effectiveUsageForConv` and `usedTokens` so existing multi-turn conversations whose `usageByConv` held `<20%` truncated records automatically recover the true baseline token count.
- **Modular Live Environment Pane (`src/components/chat/EnvPanelView.jsx`, `src/components/chat/WorkspaceViews.jsx`):**
  - Synced `ContextMeter` ring `%` and `EnvPanel` header (`<1% used` / `7% used`, never `0% used` mismatch), replaced `"No connectors attached"` with live status across connected MCP servers + built-in `rea` (`263` tools), `Computer Use 2.0` (`24` tools), and `Akron Browser Bot (:8766)`, added live Execution Environment host switcher (`This Computer` / SSH / Remote), interactive inline `What is loaded` context inspector card, and spinner + post-compaction baseline refresh on `Compact now`.
- **Real `Remote Control`, `Auto`-Mode `/compact`, & Feature Toggle Wiring (`electron/ipc/ipc-features.js`, `electron/main.js`, `src/App.jsx`):**
  - Unified `features.remoteControl` and `features.remoteServerEnabled` with `environments.toggleHostServer` so toggling Remote Control starts/stops the real authenticated HTTP/WebSocket host server (`127.0.0.1:9477`) and shows live URL, **Copy Token**, and **Kill Switch** controls.
  - Added `resolveCallableProvider` in `autobot:compact` & `autobot:chatOnce` so `/compact`, `/recap`, `/brief`, `/advisor`, and `/btw` resolve OAuth/Orchestrator routes when running in `Auto` mode (`baseURL: ''`).
  - Made `autobot:mcpConfig` invoke `autoConnectMcp` on workspace load, and wired `bridges` (`cowork.startBridge`/`stopBridge`), `trustedFolders`, `computerUseTeach`, `extensions` (`extHost.scan`), and `buddy` in `electron/main.js`.

## [1.5.0] - 2026-11-27

### Fixed & Upgraded
- **Context Meter `0%` Fix & Accurate Token Accounting (`electron/usage-estimator.js`, `electron/providertransport.js`, `electron/llm.js`, `electron/swarm.js`, `src/utils/appHelpers.jsx`, `src/hooks/useAutobotEventStream.js`):**
  - Fixed Anthropic SSE `message_delta` wiping `message_start` `input_tokens` and cache token counts; now merges usage frames and counts `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` in `prompt_tokens`/`context_tokens`.
  - Added deterministic fallback token estimation when gateways omit SSE usage, per-conversation usage tracking + reloaded-conversation baseline estimation (`effectiveUsageForConv`), Swarm cumulative sub-run aggregation that preserves parent context % downward, and `<1%` arc/label precision on 1M-token context windows.
- **LiveProgress & Streaming Indicator Accuracy (`src/components/LiveProgress.jsx`, `src/components/chat/WorkspaceViews.jsx`):**
  - Verification/browser/MCP/search/computer tools keep Step 4 marked `in_progress` while actively running instead of prematurely showing `4/4` completed under a spinner, and suppressed duplicate active-tool pills between `RunActivity` and `LiveToolActivityCard`.
- **Always-High Supervisor Thinking (`electron/swarm.js`, `electron/task-router.js`, `electron/orch-router.js`, `electron/llm.js`, `electron/providertransport.js`):**
  - Enforced `reasoningLevel = 'high'` across Supervisor, Auto planner, Orchestrator planner pools, and Swarms (upgrading `-low`/`-medium` variants to `-high` when available), and wired Gemini `thinkingConfig` + `part.thought` live streaming into `googleChat`.
- **Paradev Raw API Subscription Bridge & Worktree Hooks (`electron/paradev-client.js`, `src/components/settings/ParadevIntegrationCard.jsx`, `electron/tools.js`, `electron/git.js`):**
  - Added SuperJSON tRPC client supporting Personal API Keys (`sk_live_*`) for server-backed Whisper dictation (`voice.transcribe` fallback), cloud sandboxes (`ParadevWorkspaces`), organization tasks (`ParadevTasks`), MCP server registration, and native `.akron/worktree.json` + `.superset/config.json` `setup`/`teardown` worktree scripts.
- **Rate-Limit-Proof Cross-OS Auto-Updater (`electron/updater.js`, `src/components/settings/SettingsSections.jsx`, `scripts/inject-mac-ext-folder.js`, `electron/cli/index.js`):**
  - Added GitHub Web redirect + `latest-mac.yml`/`latest.yml`/`latest-linux.yml` fallback when GitHub REST API returns HTTP `403`/`429`, atomic macOS `.zip` bundle swap (or Finder reveal when `/Applications` is read-only) / `.dmg` open, Windows NSIS launch + quit, Linux `.AppImage`/`.tar.gz` support, `akron update [--check] [--apply]` CLI command, fixed Settings initial `v1.0.0` string, and `test/hooks.test.js` `CLAUDE_CONFIG_DIR` isolation.

## [1.4.0] - 2026-11-27

### Added & Upgraded
- **Long-Horizon Complex Project Engine (`electron/task-router.js`, `electron/llm.js`, `electron/swarm.js`)**:
  - Upgraded `Auto` routing so multi-file build prompts (`make|create|website|platform|dashboard|server|admin|fullstack`), Swarm turns, and active coding session follow-ups never downgrade to `fast`/`haiku`.
  - Switched mid-run `maskOlderToolOutputs` to context-pressure adaptive windowing (preserving up to 28 recent steps verbatim under 45% context fill), enriched `sanitizeHistory` compaction digests with `Files created/modified`, `Checklist state` (`TodoWrite`), and `Recent commands`, and added an autonomous completion gate (continuing open `TodoWrite` tasks and premature `"Want me to do that?"` endings up to completion).
  - Upgraded `swarm.js` with an automatic failed-worker retry wave on alternate healthy models and conditional `Write`/`Edit`/`MultiEdit` repair tools for Supervisor recovery when any worker fails (`READONLY_REVIEW_TOOLS` preserved for read-only/all-pass runs).
- **3-OS Computer Use 2.0 (`electron/computer.js`, `electron/computer-win-linux.js`, `electron/tools.js`)**:
  - Exposed 24 `mcp__computer__*` tools including `zoom` region crop, `app_screenshot`, `ax_find`, `app_menu`, `list_windows`, `ax_snapshot`, `open_app`, `activate_app`, `clipboard_read`/`write`, `triple_click`, `hold_key`, `cursor_position`, `switch_display`, and `batch`.
  - Fixed `btn === 1` / `btn === 2` right/middle-click dispatch, normalized screenshots to `1x` logical Retina display points, added inline multimodal `imageDataUrl` vision responses, single-session `~/.autobot/computer.lock`, plus zero-`node-gyp` native Windows 11/10 (PowerShell/C# `user32.dll` + `UIAutomationClient`) and Linux (`xdotool`/`ydotool`/`wmctrl`/`grim`) backends.
- **Built-In Browser 1-Click Screenshot & UI Design Fixes (`src/components/browser/BrowserPaneView.jsx`, `src/ide/ide.css`, `src/components/sidebar/ProjectsSidebar.jsx`, `src/styles.css`)**:
  - Added Antigravity-style `Camera` Screenshot button (`data-testid="browser-screenshot-btn"`) to `.browser-toolbar` with 1-click capture-to-chat, drag-to-crop `Select Area` overlay, `Full Page` capture, and `Save…` PNG card.
  - Fixed `.response-actions` / `.response-model-badge` flex wrapping so narrow chat columns (with Browser/Review/Terminal open) never crush model badges or clip timestamps.
  - Fixed `[IDE]` Agent dock horizontal padding (`12px`) and `Swarm Mission Control` wrapping, added icons to left sidebar conversation `⋮` menus (`Pin`, `Rename…`, `Archive`, `Delete`), replaced broken `window.prompt` with inline `<input data-testid="conv-rename-input">`, and suppressed hover-card overlap while menus/renames are active.

### Security & Protocol Fixes
- **Fail-Closed Background Shell & Seatbelt Hardening (`electron/tools.js`, `electron/bg.js`, `electron/os-sandbox.js`)**: Validated `osSandbox.checkCanonicalCommand(..., { protectCredentials: true })` before background `Bash`/`Monitor` execution, aborted unsandboxed fallback spawns on policy denial, and explicitly denied writes inside `.git/hooks`, `.git/config`, `.claude/settings.json`, `~/.autobot/secrets.json`, and `~/.autobot/oauth.json`.
- **Live Multi-Source `WebSearch` & SSRF-Safe `WebFetch` (`electron/tools/web-search.js`)**: Implemented multi-tier search (`Tavily`/`Brave`/`SearXNG` -> Bing RSS -> DuckDuckGo Lite -> Wikipedia `query=search` + HN Algolia + GitHub API) and manual redirect-hop IP checking blocking loopback/link-local/RFC1918 SSRF targets.
- **Real `.ipynb` `NotebookEdit`, MCP Vision/SSE, Anthropic Extended Thinking, Codex Transport & Checkpoints (`electron/tools.js`, `electron/mcp.js`, `electron/providertransport.js`, `electron/checkpoints.js`, `electron/daemon.js`)**: Added real `.ipynb` cell edit + `editGuard.withFileLock`, MCP `imageDataUrl` forwarding + multi-frame SSE parsing + timeouts, Anthropic `thinking` budget & signed block replay with automatic fallback, Codex `max_output_tokens` + `reasoning.encrypted_content`, `Bash`/`ApplyPatch` rewind workspace snapshots, and `daemon.js` `runAgent` contract fix.

## [1.3.0] - 2026-11-27

### Added
- **Codebase Indexing 2.0 (`electron/ide/ast-chunker.js`, `electron/ide/embedder.js`, `electron/ide/codebase-index.js`)**: Multi-language structural AST scope chunker across JS/JSX/TS/TSX, Python, Go, Rust, C/C++, Java, Kotlin, Ruby, and Swift with comment/string masking and `1 MB` file ceiling, 384-dim signed FNV-1a subword/trigram embeddings plus optional dense embeddings (`Ollama`/`OpenAI`/`OpenRouter`/`Gemini`) cached by `(chunk_sha256, model)`, and Reciprocal Rank Fusion (`RRF k=60`).
- **Storage Engine 2.0: Crash-Safe WAL Sidecar & Okapi BM25 (`electron/session-db.js`)**: `O(1)` append-only `<dbPath>.wal.jsonl` sidecar with startup crash replay (ignoring partial/corrupt tail frames), threshold/idle compaction, `tf`/`doc_len` Okapi BM25 (`k1=1.5, b=0.75`) search ranking, `pinConversation` / `archiveConversation`, and dynamic `node:sqlite` integrity verifier.
- **Standalone Multi-Turn Terminal Coding Agent CLI (`bin/akron.js`, `electron/cli/index.js`, `electron/provider-hydrate.js`)**: Shared pure-Node provider/OAuth/FreeLLMAPI/Ollama hydration powering interactive multi-turn REPL and headless `akron -p` loops with `llm.runAgent`, `--model`, `--mode`, `--max-turns`, `--permission-mode <auto|ask|plan>`, `--yolo`, `--continue`/`--resume`, `--json`/`--stream-json`, and slash commands (`/help`, `/model`, `/status`, `/diff`, `/undo`, `/clear`, `/review`, `/doctor`).
- **IDE Interactive Notebooks, Integrated Debugger & Next-Edit Prediction (`src/ide/NotebookPane.jsx`, `src/ide/DebugPanel.jsx`, `electron/ide/{notebook-runner,debugger,ai-inline}.js`)**: Stateful Python 3 + Node VM `.ipynb` kernels (stdout/stderr + inline `matplotlib` PNG rendering, interrupt/restart), live Node CDP + Python `pdb` debugging (gutter breakpoints, call stack, locals, watch expressions), and `predictNextEdit` call-site detection with `Alt+]` Jump & Apply.
- **Background Daemon & GitHub Webhook Review Bot (`electron/daemon.js`, `electron/scheduler-lock.js`, `electron/remote-server.js`)**: `akron daemon <start|stop|status|install|uninstall>` across `launchd` (macOS), `systemd` user units (Linux), and Windows Task Scheduler scripts, `scheduler.lock.json` exclusive lease preventing Desktop/Daemon duplicate execution, and authenticated `POST /webhooks/github` with raw-buffer HMAC-SHA256 verification and isolated detached `git worktree` reviews.
- **Seamless `:8766` Browser Bridge Handoff & Standalone Fallback (`electron/extbridge.js`, `akron-web-bot/server/mcp-server.mjs`)**: Loopback `POST /v1/ext/yield` protocol enabling Desktop `desktop-primary` to cleanly reclaim port `:8766` from `mcp-standalone`, standalone `/v1/models` + `/v1/chat/completions` fallback, and fixed `akron_web_bot_eval_js` `code` + `expression` forwarding.

## [1.2.0] - 2026-11-27

### Added
- **Full-Page `Automations` Hub & `/automation` Guided Skill (`src/components/AutomationsView.jsx`, `resources/skills/automation/SKILL.md`)**: Upgraded Scheduled Tasks with `Yours | Templates | Proactive` tabs, search, status filter, sort, stopwatch empty state, 6 jittered non-`:00` starter templates (`7:18 AM`, `7:52 AM`, `2:14 AM`, `7:47 AM`, `7:23 AM`, `9:37 AM`), removable composer `automation` pill, and interactive `<QuestionDock />` builder.
- **Multi-Trigger Scheduler & Session Run Continuity (`electron/cronexpr.js`, `electron/scheduler.js`, `electron/ipc/ipc-runtimes.js`)**: Added `detectLocalTimezone()`, `CRON_TZ=<IANA>` evaluation, debounced `fs.watch` + `.git/HEAD` Git/File Watch triggers, embedded `<ModelLogo />` model selector, `allowedMcpServers` filtering, SQLite `sessionDb` persistence (`sched_<taskId>_<ts>`) with 1-click **`Open Run →`**, and quiet-hours notifications.
- **Standalone `Akron Browser Bot` & RSA-2048 CRX3 Auto-Installer (`electron/browser-ext-installer.js`, `scripts/inject-mac-ext-folder.js`)**: Automatically syncs the extension folder outside `.app` (`~/Applications/Akron Browser Bot`, `%LOCALAPPDATA%\AkronLogic\Akron Browser Bot`, `~/Akron Browser Bot`), builds deterministic signed CRX3 (`Cr24`) packages without altering sealed resources, registers Chromium External Extensions / Windows `HKCU` Edge/Chrome/Brave keys, ships top-level `Akron Browser Bot/` inside macOS `.dmg`/`.zip` releases, and publishes standalone `AkronBrowserBot-1.6.7.{crx,zip}`.
- **Per-Message Input & Output Timestamps (`fmtMessageTimestamp` / `fmtMessageFullTimestamp`)**: Renders compact timestamps (`date-time`, `12h`, `relative`, `iso` with full localized tooltip) below every user input alongside quick `Copy`/`Edit`/`Delete` controls, and in every assistant footer alongside model attribution and worked duration.
- **Compact Response Action Bar & Overlap Fix**: Tightened `.response-actions` and `.response-action-btn` (`11px` icons, `2px 6px` padding), added `compact` / `icons-only` / `hover` bar styles plus inline `Delete`, and disabled duplicate top-right floating `.msg-toolbar` overlap by default.
- **UI & Design Customization Studio (`Settings → Appearance & System`)**: Live CSS variable & `data-*` controls (`computeAppearanceVars`, `<AppearanceStudioSection />`) for Theme Mode (`dark`/`light`/`auto`), Surface Finish (`emerald-carbon`, `matte-obsidian`, `midnight-glass`, `minimal-slate`), 6 preset accent swatches + custom `<input type="color">`, Background Pattern, UI Density, Chat Reading Width, Message Layout Style (`editorial`/`bubbles`), Corner Roundness, Timestamps/ActionBar/ModelBadge/Avatars visibility toggles, and 1-click Factory Reset.
- **Universal Media Studio, Pre-Bundled Office/PDF/ZIP Engine & `Customizations` Hub**: 8-role capability router (`planner`, `coder`, `vision`, `fast`, `longctx`, `image_gen`, `video_gen`, `audio_speech`) with `GenerateImage`, `EditImage`, `GenerateVideo`, `EditVideo`, `ReadDocument`, and `GenerateDocument` offline support (`pdf-lib`, `docx`, `xlsx`, `pptxgenjs`, `jszip`, `katex`, `@ffmpeg-installer/ffmpeg`), inline `<MediaDocCard />` & non-blocking `<QuestionDock />`, and full-page `Customizations` hub (`Marketplace | Installed` + 263-tool built-in `rea`).
- **Build, Reliability & Windows 11 Fixes (`vite.config.mjs`, `electron/main.js`, `electron/doc-studio.js`)**: Split Vite vendor bundles via `manualChunks` (`index` bundle ~1.90 MB, `0` `.map` files), added Windows/POSIX `process.stdout`/`process.stderr` `EPIPE` broken-pipe crash guards in `electron/main.js`, fixed Node 24 `Uint8Array`/compressed `/XRef` PDF parsing in `electron/doc-studio.js`, cleaned dead slash command stubs, and verified all `114/114` test suites, `70/70` evals, macOS cold boot, and silent Windows 11 ARM64 NSIS Setup install (`NSIS_EXIT=0`, `COLD_BOOT_OK`, 0 errors).

## [1.1.0] - 2026-11-26

### Added
- **Context Engine 2.0 & Bulletproof Agent Harness**:
  - Tool output spill-to-disk (`electron/spill.js`) with `0o600` permissions, head/tail pointers, and 7-day auto-pruning.
  - Progressive tool output masking (`electron/context-pipeline.js`) preserving the latest 4 steps verbatim and distilling older verbose outputs without mutating transcripts.
  - Doom-loop circuit breaker (`electron/loop-guard.js`) escalating at 3/5/8 identical or cyclical repeats, plus 20s non-blocking FIFO pipe reads, 50 KB hook output caps, and MCP stdout flood protection.
- **Elite Code Editing & Codebase Intelligence**:
  - Atomic multi-file Codex V4A `ApplyPatch` (`electron/apply-patch.js`) with all-or-nothing in-memory validation and 4-tier fuzzy sequence matching.
  - SHA-256 + mtime stale-read guard, instant syntax + LSP post-edit diagnostics, and `ShadowCheck` (`electron/ide/edit-guard.js`).
  - Incremental Merkle-tree + BM25 + trigram-vector SQLite hybrid workspace index (`electron/ide/codebase-index.js`, `.akronignore`, `CodebaseSearch`, and `CodebaseInvestigator`).
  - Sandboxed `RunToolScript` (`electron/codemode.js`) via `worker_threads` + `vm` (`disallow codeGeneration`) batching multi-file reads/searches/edits in 1 turn.
- **Crash-Safe SQLite Session Store, Categorized Memory & `/learn`**:
  - Pure-WASM SQLite store (`electron/session-db.js`) with atomic disk writes, instant FTS5/token full-text search, and non-destructive `localStorage` migration.
  - Categorized/deduplicated long-term memory + `/learn` command + `ExtractSkill` tool writing reusable `SKILL.md` skills (`electron/skill-learner.js`).
  - OS-level sandbox profiles (`electron/os-sandbox.js`: `workspace-write`, `read-only`, `strict-isolated`, `full-access`) with chained/wrapped `sh -c`/`&&` canonicalization.
- **Interactive Markmap Mind Maps & Cross-OS Notification Upgrades**:
  - Bundled offline `src/ide/MindMapView.jsx` (`markmap-lib` + `markmap-view`) with Dark/Light themes, Zoom/Fit/Expand-Collapse/Source switch, SVG export, and click-to-open files in Monaco.
  - Theme-aware Mermaid diagrams + ````markmap` / ````mindmap` fence previews in `ArtifactPreview`.
  - Headless Linux guard, `notifyWhenFocused`, optional OS alert sound, completion elapsed/file summary, and Computer Use notification triggers in `electron/notifications.js` + Settings UI.
- **Codebase Hygiene & Linux `.deb` Packaging**:
  - Extracted modular UI components (`src/components/Icon.jsx`, `src/features/AppModals.jsx`, `src/features/WorkspacePanels.jsx`), added `npm run typecheck` (`scripts/typecheck.js`), and added Linux `.deb` target alongside `.AppImage`.

### Fixed
- Packaged Brand Seal validation (`electron/brand-guard.js` + `scripts/harden-fuses.js`) for `extraResources`-unpacked `icon.png` / `icon.ico`.
- `electron/llm.js` history compaction digest headroom so long multi-turn conversations always emit clean compaction notices instead of unexpectedly middle-truncating kept turns.
- Stale user-facing `"Akron Bot"` strings across core agent prompts and commands updated to `"Akron Code"` while keeping `~/Akron Bot` workspace root and user-data migration intact.

---

## [1.0.0] - 2026-11-26

### Added
- Built-in Monaco + xterm.js PTY + Ripgrep + Git + LSP + Ghost Text + `⌘K` / `Ctrl+K` IDE Workbench.
- Built-in Browser Inspect Element + Exit Inspect Mode + Preview DevTools + Chrome MV3 **Akron Browser Bot** inline checklist UI.
- Execution Environments (`This Computer`, `SSH Host`, `Remote Server`) with OS keychain encrypted credentials.
- Inline 4-option Antigravity-style Permission Dock, FIFO `permissionQueue`, advanced editable Message Queue Tray, live Typography Settings, and top-right Notification Center.
- Hardened Electron Fuses (`RunAsNode=0`, `OnlyLoadAppFromAsar=1`, `EnableEmbeddedAsarIntegrityValidation=1`) and cryptographic Brand Seal.
