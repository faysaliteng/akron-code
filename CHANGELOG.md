# Changelog

All notable changes to **Akron Code** are documented here.

## [1.7.0] - 2026-11-28

### Speed
- **Replies are 5–10× faster.** A plain "hi" took 37 s – 2 min; it now takes ~3–8 s. Before each message Akron re-checked every provider CLI's sign-in once per orchestrator pool row (61 rows) and one provider at a time (~52 s per message). Sign-in checks are now cached, shared and run in parallel (`electron/provider-oauth.js`).
- CLI turns end on the model's final answer instead of waiting for the CLI to exit (Claude CLI spent 2–3.5 s writing a post-turn summary) (`electron/cli-runner.js`).
- MCP servers and plugins only start for a CLI turn when your message names them; REA stays dormant until asked for (`electron/rea-gate.js`).
- Warm CLI workers stay ready for 10 minutes instead of 90 seconds; out-of-credit accounts are skipped account-wide instead of per model (`electron/provider-gate.js`).
- **Antigravity models with the effort in their name (e.g. `claude-opus-5-5-low`) ran twice per message.** Akron also passed `--effort`, agy rejected the pair, and Akron retried without a model — so the reply came from agy's default model, ~2.5 s later, and never from a warm worker. The flag is no longer sent for those models, and a model rejection now says so in the chat.
- **Pre-warm while you type:** on your first keystroke Akron starts the CLI the last turn used, in this chat's folder, so it is loaded when you press Enter. At launch it pre-starts that same CLI instead of four CLIs in `/` that no turn could use (first reply after launch: 17 s → 3 s).
- The packaged app drops ~110 MB of UI libraries that Vite already bundles (Monaco, Mermaid), which speeds the first launch of each new build.

### Subscription models (Claude, Gemini/Antigravity, Codex, Grok)
- **Swarm now works with subscription CLI models**: Akron starts the Swarm itself for medium-to-large or explicitly parallel tasks (say "use swarm" to force it) (supervisor plans, workers run in parallel worktrees, supervisor merges).
- **Subscription models can ask for a Swarm themselves.** With Swarm ON, Claude / Antigravity / Codex / Grok CLI models reply with an `<akron-swarm>` plan when a task splits into independent parts, and Akron runs it (they cannot call Akron's Swarm tool directly).
- **The Auto-router ("ignition") model picks the Swarm supervisor** from the frontier models available right now when its key is saved; a supervisor pinned in Settings still wins. Supervisor plans → workers run in parallel → supervisor reviews and approves.
- **Plan mode works end to end**: the CLI model's plan goes to the approval card; approving switches back to your previous mode and implements it. The run's live mode is honoured when approving tools after plan approval.
- HTML/SVG files written by CLI models open in Akron's preview; Claude CLI no longer publishes them to claude.ai.
- The Swarm supervisor can give each worker only the tools it needs (`electron/swarm-tools.js`).

### Fixed
- Admin/login password prompt at launch: secrets no longer live in the macOS keychain, and builds without an Apple Team ID use Chromium's mock keychain, so a new build never asks again (`electron/keychain-policy.js`, `electron/secretstore.js`).
- Stop pressed in the first second was ignored; Stop now pauses the queue; interrupted steps no longer spin forever; deleting a chat stops its run and queue.
- Reloading the window mid-run re-attaches to the running turn; queued messages from a previous session wait for you instead of sending themselves.
- Chats with many screenshots kept saving silently failing; older bulky attachments are now trimmed and you are told.
- Computer Use approval no longer hangs when two chats ask at once.
- New chat, Fork and Split keep the current chat's model, routing, Swarm setting and folder.
- MCP: duplicate servers per chat, crashed servers never restarted, project `.mcp.json` servers never auto-connected.
- "Trusted folders" honours the shell-safety check; failed turns show their reason in the chat.
- Browser pane only treats a server running inside the project as its dev server.
- Swarm applies workers' changes as uncommitted edits by default (opt in to auto-commit with `swarmAutoCommit`).

- **Windows: no more console windows flashing.** Akron's child processes (git, node, PowerShell, the CLI runtimes, ripgrep, MCP servers) now start hidden; a black console used to pop up at launch and during git, MCP and Computer Use work (`electron/win-hide-console.js`).
- **A failed reply stays in the chat with its reason** (e.g. "no provider is configured") instead of only a toast that disappeared after 5 seconds.
### Design
- Swarm runs: no second "Orchestrating swarm…" card under the worker panel, "Write & update files" waits while workers run instead of spinning beside them, and the supervisor card says *supervising* (not *planning*) once the plan is made.
- Six theme colours were never defined (error states, muted text, borders, small radii); account status pills show in full; Settings sections open at the top; per-message subagent/task counts; titles cut at a word; Mission Control idle count; duplicate tool rows; stale plan banner; IDE status bar model.

## [1.6.9] - 2026-11-28

### Fixed & Verified Live
- **Mid-Stream `Stop`, Abort Propagation & Instant Queue Unblock (`electron/providertransport.js`, `electron/llm.js`, `electron/main.js`, `src/App.jsx`):**
  - Fixed the streaming transport bug where `fetchWithTimeout` / `doFetch` detached the parent `AbortSignal` listener as soon as HTTP headers arrived and `reader.read()` blocked until the model finished on its own — `Stop` now cancels underlying HTTP streams immediately across Anthropic, OpenAI-compatible, Codex Responses, and Gemini adapters with zero leaked `abort` listeners.
  - Released `sendingLocksRef` immediately once a run is registered (before awaiting the long-running `autobot:run` IPC promise), added `queueWakeTick`, and updated `stop()` + `sendQueuedNow({ forceImmediate: true })` so prompts sent or triggered right after `Stop` dispatch immediately instead of getting stuck in `QUEUED`.
  - Added automatic HTTP `500` negotiation retry for local/gateway OpenAI-compatible servers that reject `reasoning_effort`, `stream_options`, `max_tokens`, or `reasoning_content`.
- **Per-Conversation Independent Model, Mode, Swarm & Workspace Isolation (`src/utils/sessionModelState.js`, `src/App.jsx`):**
  - Scoped `provider`, `routingMode` (`direct` / `orchestrator` / `auto`), `orchestrator.enabled` / `activeIndex` / `executorModel`, `swarmEnabled`, `reasoningLevel`, and `cwd` per conversation tab (`autobot:sessionConfigs` + `cwdByConv`), so multiple chats can run concurrently on completely different models, modes, Swarm settings, and project folders without one tab overwriting another or `+ New chat` resetting open sessions.
- **Orphaned OAuth Model Auto-Heal, Supervisor Fallback & Diff Crash Guard (`electron/ipc/ipc-oauth-models.js`, `electron/orch-hydrate.js`, `electron/llm.js`, `src/utils/tutorialPresets.js`, `src/components/CodeReviewPane.jsx`, `src/review-helpers.mjs`):**
  - Auto-healed orphaned OAuth models (e.g. `claude-fable-5-2` saved with empty `oauthProvider` or keyless `localhost:11434` fallback) onto the signed-in matching OAuth account, rejected stale unkeyed rows in `hydrateOrchestrator` before falling back to Ollama, selected a valid configured supervisor in Orchestrator mode when `rawProv` is unusable, preserved `oauthProvider`/`transport`/`oauth`/`baseURL` across `applyBeginnerPreset` switches, and guarded `CodeReviewPane` / `mergeDiffFiles` against non-iterable values.
- **Settings → MCP Connectors Layout & Footer Summary (`src/features/WorkspacePanels.jsx`, `src/styles/workspace-panels.css`, `src/components/settings/SettingsModalBody.jsx`):**
  - Normalized string vs. `{ name, description }` MCP tool entries (`normalizeMcpToolEntry`) inside `McpView`, eliminated the 263 blank chip bars and `.tools` CSS collision with searchable collapsible `.mcp-tool-chips`, fixed `.mcp-form` `select` & input flex widths, and wired `formatFooterModelSummary` into the Settings footer.
- **Official CLI Subprocess Transport, Secret Store & Swarm Worktree Isolation (`electron/cli-runner.js`, `electron/provider-oauth.js`, `electron/providertransport.js`, `electron/secretstore.js`, `electron/swarm.js`, `electron/ipc/ipc-runtimes.js`, `electron/runtimes.js`):**
  - Replaced consumer OAuth header spoofing and local token scrapers with `electron/cli-runner.js` executing official CLI binaries (`claude`, `codex`, `grok`, `gemini`/`agy`) in NDJSON streaming mode, thin native CLI auth wrappers in `electron/provider-oauth.js`, and official API-key REST transports in `electron/providertransport.js`.
  - Enabled macOS `safeStorage` by default in `electron/secretstore.js` alongside a random 32-byte `0o600` `~/.autobot/master.key` and purged legacy plaintext token mirrors.
  - Enabled default Git worktree isolation for concurrent writing workers and automatic branch merge/cleanup (`reconcileWorkerWorktrees()`) before Supervisor review in `electron/swarm.js`.
  - Prevented `chmodSync` inside signed `.app/Contents/Resources` bundles (`electron/ipc/ipc-runtimes.js`) and enforced `.sha256` sidecar / OS signature verification, Windows `codex.exe`/`.cmd` shims, and `current.ptr` + NTFS junctions in `electron/runtimes.js`.

## [1.6.8] - 2026-11-28

### Fixed & Verified Live Across All 3 Platforms (macOS, Windows 11, Kali Linux)
- **Windows SVG CRLF Integrity Fix (`.gitattributes`, `electron/brand-guard.js`, `test/brand-integrity.test.js`):**
  - Added repository-wide `.gitattributes` enforcing `eol=lf` on `.svg`, source, script, and config files (and `eol=crlf` for `.bat`/`.ps1`) so Windows CI checkouts never alter sealed `.svg` byte hashes (`build/icon.svg`, `build/logo-mark.svg`, `resources/akron-browser-bot/icons/logo.svg`).
  - Normalized `\r\n` → `\n` inside `sha256File()` for `.svg` assets in `electron/brand-guard.js` and added CRLF seal-pass + CRLF-tamper-fail regression coverage in `test/brand-integrity.test.js`.
- **Windows/macOS ARM64 `esbuild` Unpacked Fallback (`electron/ide/edit-guard.js`):** Updated `ensureUnpackedEsbuildBinary()` on `win32`/`darwin` `arm64` hosts to fall back cleanly to `x64` unpacked `esbuild` when running x64 bundles under Prism or Rosetta.
- **CI Cross-OS Release & Verification Hardening (`.github/workflows/build-desktop.yml`):** Added Linux `arm64` `.tar.gz` packaging alongside `x64`, added Windows extracted-ASAR `verifyBrandIntegrity()` verification, and added Linux extracted-ASAR brand check + headless `xvfb-run` `AKRON_COLD_BOOT_CHECK=1` gate.
- **Live 3-OS Verification & Fresh Screenshots:** Verified `COLD_BOOT_OK` (`15` checked files, `0` console errors) and live rendered GUI windows on macOS Apple Silicon, Windows 11 ARM64 VM (`AkronCode-1.6.8-win-setup-arm64.exe`), and Kali Linux 7.1 ARM64 VM (`AkronCode-1.6.8-linux-arm64.tar.gz`), and refreshed `docs/screenshots/` (`40+` captures).

## [1.6.7] - 2026-11-28

### Fixed, Hardened & Visualized Across All 3 Platforms
- **3-Platform GitHub Actions Release Fix (`electron/repl.js`, `package-lock.json`, `scripts/inject-mac-ext-folder.js`):** Fixed premature `.unref()` on child REPL stdout handles while awaiting dynamic `import()` promises (which caused Node test cancellation on Linux CI), synced `package-lock.json` for `npm ci`, and exported `AkronBrowserBot-1.6.13.crx` + `.zip` in releases.
- **3-OS Computer Use 2.0 + Live Emerald HUD Refinements (`electron/computer-hud.js`, `electron/computer.js`, `electron/computer-win-linux.js`):**
  - Suspended `Escape` / `CommandOrControl+Shift+Escape` emergency-stop shortcuts around synthetic `key('Escape')` / `holdKey('Escape')` calls so agent keystrokes never self-abort.
  - Added cross-OS HUD window typing (`panel` on macOS, `toolbar` on Linux, omitted on Windows), click-through re-assertion after `showInactive()`, `will-quit` cleanup, multi-monitor negative-origin `zoom()` coordinate resolution, `withHiddenForCapture` wrapping around `appScreenshot()`, and Windows OEM virtual-key mappings (`;`, `=`, `,`, `-`, `.`, `/`, `` ` ``, `[`, `\`, `]`, `'`).
- **UI & Showcase Verification (`src/components/settings/OrchPaidProvidersPanel.jsx`, `src/components/settings/ProjectSettingsPanel.jsx`, `docs/screenshots/`):** Guarded provider name rendering and token-budget `toLocaleString()` formatting against partial payloads, and regenerated all `docs/screenshots/` PNGs at `v1.6.7` including 4-Mode Welcome Quick-Start, 5-Step Interactive Tour, Orchestrator Auto-Detect, Editable `AGENTS.md`, and 3-OS Computer Use Emerald HUD.

## [1.6.6] - 2026-11-27

### Added
- **Claude Desktop 3-OS Parity & Emerald HUD (`electron/computer-hud.js`, `electron/computer.js`, `electron/computer-win-linux.js`):** Added `#10b981` non-activating perimeter glow, phantom cursor, floating `Stop (Esc)` pill, 60Hz cubic ease-out mouse glide & multi-step drags, Per-Monitor DPI v2 + `SendInput` Unicode + `winAppMenu` on Windows 11, Wayland (`ydotool`, `wtype`, `grim`, `spectacle`, AT-SPI2) on Linux, universal `desktopCapturer` fallback, and `doctor()` / `previewHud()` controls in Settings.
- **Editable `AGENTS.md` + Reset to Default (`electron/memory.js`, `src/components/settings/AgentsMdSection.jsx`):** Added Global (`~/.autobot/AGENTS.md`) and Workspace `AGENTS.md` editor in Settings with `Save`, `Reload from Disk`, and `Reset to Default` (`DEFAULT_AGENTS_MD`).

## [1.6.5] - 2026-11-27

### Added
- **Orchestrator Swarm Default, Mandatory Model Guard & Universal Auto-Detect (`src/App.jsx`, `src/components/settings/OrchPaidProvidersPanel.jsx`):** Defaulted Swarm ON when activating Orchestrator, added a setup notice/guard when no Orchestrator models are configured, and added 1-click OAuth & Paid API (`Kimi`, `Z.AI`, `Grok`, `DeepSeek`, `OpenRouter`) Auto-Detect.

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
