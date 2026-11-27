<p align="center">
  <img src="docs/assets/icon.png" alt="Akron Code" width="88" height="88" />
</p>

<h1 align="center">Akron Code</h1>

<p align="center">
  <strong>by <a href="https://akronlogic.com">Akronlogic.com</a></strong><br />
  <em>The Autonomous Multi-Agent Coding IDE, Universal Media Studio &amp; Browser Workstation for macOS, Windows 11/10 &amp; Linux</em>
</p>

<p align="center">
  <a href="https://github.com/faysaliteng/akron-code/actions/workflows/build-desktop.yml">
    <img src="https://github.com/faysaliteng/akron-code/actions/workflows/build-desktop.yml/badge.svg" alt="CI Build Status" />
  </a>
  <a href="https://github.com/faysaliteng/akron-code/releases/latest">
    <img src="https://img.shields.io/badge/Release-v1.6.7-10b981?style=for-the-badge" alt="Release v1.6.7" />
  </a>
  <a href="./VERIFICATION.md">
    <img src="https://img.shields.io/badge/Verified-198%2F198%20Test%20Suites%20%C2%B7%2070%2F70%20Evals-059669?style=for-the-badge" alt="198/198 Test Suites · 70/70 Evals" />
  </a>
  <a href="https://github.com/faysaliteng/akron-code/releases/latest">
    <img src="https://img.shields.io/badge/Platforms-macOS%20%7C%20Windows%20%7C%20Linux-111827?style=for-the-badge" alt="Cross-Platform Desktop" />
  </a>
  <a href="./SECURITY.md">
    <img src="https://img.shields.io/badge/Security-6%2F6%20Electron%20Fuses%20%2B%20Brand%20Seal-059669?style=for-the-badge" alt="Electron Fuses Hardened" />
  </a>
  <a href="./LICENSE.md">
    <img src="https://img.shields.io/badge/License-Akron%20Open%20Ecosystem-334155?style=for-the-badge" alt="License" />
  </a>
</p>

<p align="center">
  <a href="https://github.com/faysaliteng/akron-code/releases/latest"><strong>⬇️ Download v1.6.7</strong></a>
  ·
  <a href="#how-it-works">How It Works</a>
  ·
  <a href="./docs/FREELLMAPI-GUIDE.md">FreeLLMAPI Guide (1,575 Models)</a>
  ·
  <a href="#visual-product-gallery">Screenshots</a>
  ·
  <a href="#architecture--diagrams">Architecture</a>
  ·
  <a href="#core-capabilities">Capabilities</a>
  ·
  <a href="#companion-cli-akron">CLI</a>
  ·
  <a href="#keyboard-shortcuts-macos--windows--linux">Shortcuts</a>
  ·
  <a href="#benchmark-evaluations">Benchmarks (70/70)</a>
</p>

---

## Downloads (Official Releases `v1.6.7`)

All desktop installers are hardened with **6/6 Electron Fuses** + cryptographic **SHA-256 Brand Seal** integrity verification, paired with `latest*.yml` auto-updater manifests (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`) and `SHA256SUMS.txt` on the [**GitHub Releases Page**](https://github.com/faysaliteng/akron-code/releases/latest) (ad-hoc / unsigned locally without paid Developer ID or EV Authenticode certificates).

| Platform / Component | Artifacts | Highlights |
|---|---|---|
| **macOS (Apple Silicon)** | `AkronCode-1.6.7-arm64.dmg` · `AkronCode-1.6.7-arm64.zip` | Top-level `Akron Code.app` + standalone `Akron Browser Bot/` folder, ad-hoc signed, `RunAsNode=false` Fuse, ASAR integrity verified, `CGEvent` 60Hz glide + Emerald HUD |
| **Windows 11 / 10 (x64 & ARM64)** | `AkronCode-1.6.7-win-setup-x64.exe` · `AkronCode-1.6.7-win-setup-arm64.exe` | NSIS Setup, native dark titlebar overlay (`Ctrl+` shortcuts), ConPTY `node-pty`, Per-Monitor DPI v2 + `SendInput` Unicode + UIAutomation Computer Use 2.0, Toast XML |
| **Windows Portable (x64)** | `AkronCode-1.6.7-win-portable-x64.exe` | Zero-install single portable executable |
| **Linux (x64)** | `AkronCode-1.6.7-linux-x86_64.AppImage` · `AkronCode-1.6.7-linux-x64.tar.gz` | Single-file `AppImage` + portable `.tar.gz` archive (`npmRebuild: false`, X11 + Wayland `ydotool`/`wtype`/`grim`/AT-SPI2 Computer Use 2.0, ASAR + Fuses hardened) |
| **Standalone Akron Browser Bot (`1.6.13`)** | `AkronBrowserBot-1.6.13.crx` · `AkronBrowserBot-1.6.13.zip` | Deterministic RSA-2048 signed CRX3 (`Cr24`) + unpacked MV3 bundle auto-synced to user-accessible OS folder, `close_tab` & `list_tabs` fixes, `:8766` bridge, GitHub auto-updater |
| **Companion Terminal CLI & Daemon** | `./bin/akron.js` (`npm link` → `akron`) | Multi-turn `akron` REPL & `akron -p` coding agent (`--continue`/`--yolo`/`--stream-json`), `akron daemon`, `akron update`, `akron review --adversarial`, `akron doctor`, `akron eval` |

Verify downloaded installers against `SHA256SUMS.txt`:

```bash
shasum -a 256 -c SHA256SUMS.txt --ignore-missing   # macOS
sha256sum -c SHA256SUMS.txt --ignore-missing       # Linux / Git Bash
```

---

## How It Works

### 1. The Story Way (For Everyone): The Dinosaurs vs. The Apex Predator 🦕➡️🦖🔥

Every major AI company wants you trapped inside its own **Four Walled Gardens**: Claude.app locks you to Anthropic quotas, Codex/ChatGPT locks you to OpenAI quotas, and Antigravity/Cursor lock you to proprietary limits. The moment your primary subscription hits a 5-hour cap or struggles on a stubborn bug, single-vendor apps stall while your other accounts and free APIs sit idle.

**Akron Code** unites every AI subscription, CLI login, local Ollama/LM Studio runtime, and **1,575 unlocked FreeLLMAPI models** inside one unified workstation:

> **In that room:**
> - **Single-vendor apps** = the dinosaurs guarding their own walled garden 🦕
> - **You + Akron Code** = the apex predator that eats from all four gardens at once 🦖🔥

| Pillar | What Happens on Your Machine |
|---|---|
| **1. One Command Center** | Sign in once (or auto-import existing `~/.claude`, `~/.codex`, `~/.gemini`, `~/.grok`, or `freellmapi-keys.json`). Claude Max, ChatGPT Plus/Pro, Gemini/Antigravity, Grok, Ollama, LM Studio, and FreeLLMAPI sit side by side in one Model Picker. |
| **2. The Smart Brain (`⚡ Auto` with DeepSeek V4.1 Flash)** | Powered by **OpenRouter Free ($0.00 forever)**, **DeepSeek Platform API**, or **FreeLLMAPI**. Before each turn (~120 ms), DeepSeek V4.1 Flash scores complexity (`Tier 1–5`) and sends quick lookups to **Fast**, coding to **Coder**, hard architecture to **Frontier Planner**, and screenshots/docs to **Vision / 1M Context** — never wasting your Claude Max or ChatGPT quotas on trivial turns. |
| **3. Automatic Self-Healing & Failover (`🛰️ Orchestrator`)** | Put your chosen model in command as **Supervisor** while 8 Role Pools back it up. On `429` rate limits or token expiry, OAuth Auto-Heal refreshes credentials or fails over seamlessly to the next healthy provider mid-run. |
| **4. The 9-Agent Swarm** | Spawn up to 9 specialized parallel worker agents across different model families in isolated workspaces/worktrees, plus cross-vendor **Duet Adversarial Review** (`Claude Opus × GPT / Gemini`) before merging. |

---

### 2. The Technical Way (Under the Hood) ⚙️

```mermaid
flowchart TD
  UI["Akron Code UI (4-Mode Welcome · 3-Mode Picker · Editable AGENTS.md · Monaco IDE · Notebooks · Markmap)"] --> Preload["Context-Isolated Preload Bridge"]
  Preload --> Main["Electron Main Process & Agent Harness (v1.6.7)"]

  Main --> Vault["1. OAuth 2.1 PKCE Vault & AES-256-GCM SecretStore"]
  Main --> Brain["2. DeepSeek V4.1 Flash Dispatcher (OpenRouter Free / DeepSeek API / FreeLLMAPI)"]
  Main --> Context["3. Context Pipeline 2.0 (Spill-to-Disk · 20k Budget · AGENTS.md · Mindmap Bridge)"]
  Main --> Failover["4. 8-Role Failover Engine (planner · coder · vision · fast · longctx · image · video · audio)"]
  Main --> Swarm["5. 9-Agent Parallel Swarm DAG & Duet Adversarial Review"]
  Main --> Harness["6. 428 Tools (Computer Use 2.0 3-OS + Emerald HUD · ApplyPatch · Media/Office Studio · 263 REA Tools · Browser Bot :8766)"]
```

| Stage | Module & Mechanism |
|---|---|
| **1. Credential & OAuth 2.1 PKCE Vault** | `electron/provider-oauth.js` + `electron/secretstore.js` — portable cross-OS `aes-256-gcm` secret store (`~/.autobot/secrets.json`, `0o600`), encrypted `oauth-mirror/`, and single-flight `refreshFlights` (10-minute `autoHealAll`). |
| **2. DeepSeek V4.1 Flash Dispatcher & 3-Mode Router** | `electron/task-router.js` + `electron/llm.js` — enforces strict `direct`, `orchestrator`, or `auto` dispatch (`1,200 ms` hard timeout, connected-only allowlist, `0 ms` deterministic heuristic fallback, and `<runtime_identity>` attribution). |
| **3. Cross-Provider Context Bridge & Prompt Cache Preservation** | `electron/context-pipeline.js` + `electron/mindmap.js` + `electron/spill.js` — preserves KV prefix cache ordering, keeps newest 4 turns verbatim, spills `>12 KB` outputs to `0o600` files, and syncs live project mindmaps across model switches. |
| **4. Self-Healing Failover Engine** | `electron/orch-router.js` + `electron/provider-gate.js` — cooldown-aware 8-role failover pools across OAuth subscriptions, local runtimes, and the **1,575-model / 97-platform FreeLLMAPI Unified Engine**. |
| **5. Parallel 9-Agent Swarm DAG** | `electron/swarm.js` + `electron/duet-review.js` — asynchronous multi-worker task graph with shared board communication, stall monitor, git worktrees, and cross-vendor Duet code review. |
| **6. Full Local Execution Harness** | `electron/tools.js` + `electron/apply-patch.js` + `electron/doc-studio.js` + `electron/media-gen.js` + `electron/rea.js` — 165 native tools + 263 built-in REA MCP tools (428 total), offline Office/PDF/ZIP/FFmpeg studio, OS sandbox, and `:8766` Chrome Browser Bot. |

---

### Why Akron Code (`v1.6.7` Head-to-Head Matrix)

| Capability | **Akron Code v1.6.7** | **Claude.app** | **ChatGPT / Codex.app** | **Google Antigravity** | **Cursor** |
|---|---|---|---|---|---|
| Multi-Vendor Subscriptions (`Claude` + `GPT` + `Gemini` + `Grok` + `Ollama`) | **Native OAuth + Auto-Heal** | Anthropic only | OpenAI only | Google / Partner | Proprietary billing |
| 8-Role Auto-Routing (`planner`, `coder`, `image_gen`, `video_gen`, `audio_speech`, …) | **Yes + 429 Failover** | No | No | Partial | Partial |
| 3-OS Computer Use 2.0 (`macOS` · `Win 11 PMv2` · `Linux X11/Wayland`) + Emerald HUD | **Yes + `Stop (Esc)` Pill** | macOS/Win beta | Limited | No | No |
| Editable Global & Workspace `AGENTS.md` + `CLAUDE.md` in Settings | **UI Editor + Reset Default** | File only | Partial | `.gemini` rules | `.cursorrules` |
| Cross-Vendor Duet Adversarial Code Review (`Claude × GPT / Gemini`) | **Built-in 3-Pass** | Single family | Single family | Single family | Single family |
| Non-Blocking `<PermissionDock />` + `<QuestionDock />` + Editable Queue Tray | **Yes (1–4 / Esc / Queue)** | Blocking modal | Partial | Inline dock | Inline prompt |
| Offline Media & Office Studio (`PDF`/`DOCX`/`XLSX`/`PPTX`/`ZIP`/`PNG`/`MP4`) | **Pre-Bundled Offline** | Text/Preview only | Sandbox required | Cloud tools | External only |
| Dual `[Agent \| IDE]` Workbench (Monaco + Multi-PTY + Offline Mind Map) | **Unified Desktop IDE** | Chat only | Codex CLI / App | Separate panes | IDE only (no media/REA) |
| Built-in Browser Inspect Element + Chrome MV3 Extension Bridge (`:8766`) | **Both Built-in + Chrome** | MCP Beta | No native IDE preview | Built-in webview | External browser |
| Reverse Engineering MCP Suite (**263 tools built-in `rea`**) | **Included (`428` total tools)** | Manual install | Manual install | External MCP | External MCP |
| UI Customization Studio (Surface Finish, Custom Accent, Density, Timestamps) | **Full Live Studio** | Minimal | Minimal | Theme picker | VS Code JSON |
| Electron Fuses (6/6) + SHA-256 Cryptographic Brand Seal + SQLite WAL/FTS5 | **Verified (`0` `.map` files)** | Proprietary | Proprietary | Proprietary | Proprietary |

---

## Architecture & Diagrams

### System Architecture

```mermaid
flowchart TD
  UI["Akron Code Desktop UI (React 18 · Monaco · Notebooks · Debugger · Markmap · Appearance Studio)"] --> Preload["Context-Isolated Preload Bridge (contextIsolation: true)"]
  Preload --> Main["Electron Main Process & Agent Harness (v1.6.7)"]

  Main --> Brand["Brand Guard & 6/6 Electron Fuses (SHA-256 Assets + ASAR Integrity)"]
  Main --> Auth["OAuth Auto-Heal & AES-256-GCM Secret Store (Claude · Codex · Gemini · Grok · Keyring)"]
  Main --> Router["8-Role Capability & Failover Router (planner · coder · vision · image_gen · video_gen · FreeLLMAPI)"]
  Main --> Context["Context Engine 2.0 (spill.js · context-pipeline.js · loop-guard.js · 20k Token Budget)"]
  Main --> Intel["Code Intel & Safety (apply-patch.js · edit-guard.js · codebase-index.js · os-sandbox.js)"]
  Main --> Studio["Universal Media & Pre-Bundled Office Studio (media-gen.js · doc-studio.js · ffmpeg · pdf/xlsx/docx/pptx)"]
  Main --> Envs["Execution Environments & SQLite WAL/FTS5 Store (Local · SSH2 · Remote WS · akron.db)"]
  Main --> Ext["MCP Client (stdio/SSE/HTTP · 263-Tool Built-In REA · Customizations Hub · Skills & Agents)"]
  Main --> Bridge["Built-in Chromium Inspect + Akron Browser Bot MV3 Extension (:8766)"]
```

### Multi-Vendor Request & Failover Lifecycle

```mermaid
sequenceDiagram
  autonumber
  actor User
  participant UI as "Akron Code UI + InputBar"
  participant Main as "Main Harness & Context 2.0"
  participant Router as "8-Role Capability Router"
  participant Vendor as "Claude / Codex / Gemini / Ollama"
  participant Studio as "Media & Doc Studio / IDE"

  User->>UI: "Prompt + optional attachments (PDF, XLSX, PNG, ZIP)"
  UI->>Main: "autobot:run + doc-studio auto-extract + timestamp (m.ts)"
  Main->>Main: "Apply 20k customizations budget & mask verbose tool history"
  Main->>Router: "Select role pool (planner / coder / image_gen / video_gen)"
  Router->>Vendor: "Stream native wire request (single-flight OAuth token)"
  alt Rate Limit (429) or Quota Exhausted
    Router->>Vendor: "Automatic cross-vendor failover to next healthy pool key"
  end
  Vendor-->>Main: "Tool calls (Read, ApplyPatch, GenerateImage, GenerateDocument, Browser)"
  Main->>Studio: "Execute inside os-sandbox + capture inline <MediaDocCard />"
  Studio-->>UI: "Stream segments, checkpoints, Mission Control telemetry & output timestamp"
```

---

## Visual Product Gallery

### 1. Autonomous Agent Workspace, 4-Mode Quick-Start, 5-Step Interactive Tour & Timestamps
Crisp Dark & Light Agent Mode featuring the **4-Mode Welcome Quick-Start** (`Smart Auto`, `Lead + Builder`, `Full AI Team`, `Single Model`), built-in **5-Step Interactive Hands-On Guide**, **per-message timestamps** (`Today · HH:MM`), compact `11px` **Response Action Bar** (`Copy · Fork · Retry · Share · Delete`), zero floating toolbar overlap, inline tool summaries, and active model + work duration badges.

![Akron Code 4-Mode Welcome Quick-Start Dark](docs/screenshots/welcome-4modes-quickstart-dark.png)

![Akron Code Interactive 5-Step Tutorial & Quick Start](docs/screenshots/interactive-tutorial-tour-dark.png)

![Akron Code Agent Workspace Dark](docs/screenshots/agent-dark.png)

![Sidebar Conversation Context Menu Icons](docs/screenshots/sidebar-context-menu-dark.png)

![Akron Code Agent Workspace Light](docs/screenshots/agent-light.png)

---

### 2. Non-Blocking `<PermissionDock />`, `<QuestionDock />` & Mission Control
- **Inline `<PermissionDock />`:** Non-blocking 4-option consent card (`1`–`4` keys or `↑`/`↓` + `Enter`, `Esc` to deny) with FIFO queue badge so chat and code remain scrollable.
- **Inline `<QuestionDock />`:** Multi-question `AskUserQuestion` stepper + `ExitPlanMode` plan approval card docked cleanly above the composer.
- **Mission Control:** Live deterministic health monitor across concurrent sessions and worktrees with 1-click actions and clean header telemetry in Dark & Light modes.

![Akron Code Inline Permission Dock Dark](docs/screenshots/permission-dock-dark.png)

![Akron Code Inline Question Dock Dark](docs/screenshots/question-dock-dark.png)

![Akron Code Editable Message Queue Tray Dark](docs/screenshots/message-queue-dark.png)

![Akron Code Emerald Sidebar & Mission Control Dark](docs/screenshots/emerald-dark-sidebar-mission.png)

![Akron Code Emerald Sidebar & Mission Control Light](docs/screenshots/emerald-light-sidebar-mission.png)

![Live Environment Pane, Context Meter & Remote Host](docs/screenshots/environment-pane-live-v151.png)

---

### 3. Full IDE Workbench + Offline Interactive Mind Map (Dark & Light)
Integrated **Monaco Editor** (`⌘K` inline diff, Ghost Text, LSP hover/definition, split editor, per-hunk accept/reject), persistent **`@xterm/xterm`** PTY terminal (`Send to Agent`), File Explorer + Git panel, live **Agent Dock**, and **100% offline Markmap Mind Maps** (`MINDMAP.md + Files` / `Workspace Overview`) with click-to-open navigation and SVG export.

![Akron Code IDE Workbench & Swarm Agent Dock](docs/screenshots/ide-agent-dock-swarm.png)

![Akron Code IDE Workbench & Mind Map Dark](docs/screenshots/ide-mindmap-dark.png)

![Akron Code IDE Workbench & Mind Map Light](docs/screenshots/ide-mindmap-light.png)

---

### 4. Antigravity-Style Full-Page `Customizations` Hub (`Marketplace | Installed`)
Manage all integrations, slash skills, `@`-mentionable Custom Sub-Agents (`~/.autobot/agents/*.md`, `.claude/agents/*.md`), Custom Output Styles (`~/.autobot/output-styles/*.md`), and the **263-tool built-in REA** MCP suite in one unified hub.

![Akron Code Customizations Marketplace Dark](docs/screenshots/customizations-marketplace-dark.png)

![Akron Code Customizations Installed Dark](docs/screenshots/customizations-installed-dark.png)

---

### 5. Universal Media Studio, Pre-Bundled Office/PDF Engine & Duet Cross-Model Review
- **Inline `<MediaDocCard />`:** Interactive preview cards for generated images (`Copy Image`, `Remove BG`, `Upscale 2×`, `Resize 50%`, `Reveal in Finder`), multi-sheet **Excel `.xlsx`** tables, **PDF** page text/previews, **Word `.docx`**, **PowerPoint `.pptx`**, and **`.zip`** archives.
- **Duet Review:** Cross-vendor adversarial diff auditing (`Claude Opus × GPT-5.4`) with severity badges and 1-click **Apply Fix**.

![Akron Code Universal Media & Document Studio Dark](docs/screenshots/media-doc-studio-dark.png)

![Akron Code Duet Adversarial Review Dark](docs/screenshots/duet-review-dark.png)

![Akron Code Duet Adversarial Review Light](docs/screenshots/duet-review-light.png)

---

### 6. Built-In Browser Inspect Element & Standalone `Akron Browser Bot` (`:8766` CRX3 Auto-Installer)
- **Standalone User-Accessible Extension Folder:** Automatically synced outside `.app` (`~/Applications/Akron Browser Bot` on macOS, `%LOCALAPPDATA%\AkronLogic\Akron Browser Bot` on Windows, `~/Akron Browser Bot` on Linux) AND shipped top-level alongside `Akron Code.app` inside macOS DMG & ZIP releases.
- **Deterministic RSA-2048 CRX3 & 1-Click Browser Auto-Setup:** Generates `akron-browser-bot.crx` (`Cr24` v3 signed header), detects the OS default browser, registers Chromium External Extensions JSON / Windows `HKCU\Software\Microsoft\Edge\Extensions` keys automatically, and offers 1-click **Launch Browser with Extension Pre-Loaded**.

![Built-In Browser 1-Click Screenshot & Region Crop](docs/screenshots/browser-screenshot-narrow-chat.png)

![Built-In Browser Inspect Element Showcase](docs/screenshots/browser-inspect.png)

![Akron Browser Bot Standalone & 1-Click Auto-Setup](docs/screenshots/browser-ext-autosetup-dark.png)

![Browser Permissions & Site Access Rules Settings](docs/screenshots/settings-browser-rules-dark.png)

---

### 6B. Full-Page `Automations` Hub, `/automation` Skill & Multi-Trigger Scheduler
- **Full-Page Hub (`Yours` | `Templates` | `Proactive`):** Search, Status filters (`All | Active | Paused | Failed`), Sort (`Next run | Last run | Name`), stopwatch empty state, and **6 jittered non-`:00` starter templates** (*Morning Briefing `7:18 AM`*, *Git & PR Digest `7:52 AM`*, *Nightly Build Sweep `2:14 AM`*, *System Health `7:47 AM`*, *Bug Triage `7:23 AM`*, *Weekly Security Audit `9:37 AM`*).
- **Guided `/automation` Composer Pill & `New scheduled task` Modal:** Click **`✨ Create with Prompt`** to open Chat with a removable **`🕒 automation`** skill pill, or use the modal featuring an **embedded `<ModelLogo />` picker** (`Auto · DeepSeek V4.1`, `Orchestrator`, Subscriptions, Ollama), **Multi-Trigger Builder** (`Schedule` with `CRON_TZ=` timezone + `Git / File Watch` + `Manual`), **Project & SSH/Remote Environment** pickers, 4-tab **Advanced Settings** (`General | Connectors | Behavior | Notifications`), MCP tool allowlists, and **`Open Run →`** jumping straight to each run's persisted SQLite transcript.

![Automations Hub Dark](docs/screenshots/automations-hub-dark.png)

![New Scheduled Task Modal & Embedded Model Picker](docs/screenshots/automations-modal-dark.png)

---

### 6C. Live Cross-Platform Desktop & Windows 11 NSIS Verification (macOS Apple Silicon + Windows 11 ARM64/x64 + Linux)
Every release is validated with real native execution — including silent NSIS setup (`AkronCode-1.2.0-win-setup-arm64.exe /S` → `NSIS_EXIT=0`, Desktop & Start Menu shortcuts, Uninstall Registry `1.2.0`), cold-boot pass (`COLD_BOOT_OK`, 0 errors), live GUI Automations Hub verification, standalone `%LOCALAPPDATA%\AkronLogic\Akron Browser Bot` CRX3 (`Cr24`) sync, and live Edge `HKCU` extension registration (`1.6.7`).

![Akron Code Live on Windows 11 Desktop](docs/screenshots/windows11-akron-code-live.png)

![Windows 11 NSIS Setup & CRX3 Installation Verification](docs/screenshots/windows11-installer-verified.png)

---

### 7. 3-OS Computer Use 2.0 + Emerald HUD, Editable `AGENTS.md`, UI Studio & Environments
Claude-parity **3-OS Computer Use 2.0** (`macOS`, `Windows 11 PMv2`, `Linux X11 + Wayland`) with live **Emerald Screen Glow HUD**, animated phantom cursor, and `Stop (Esc)` emergency halt pill; **Editable Global & Workspace `AGENTS.md` in Settings** with 1-click **Reset to Default**; **Orchestrator Auto-Swarm & Auto-Detect** across OAuth and Paid APIs (`Kimi`, `Z.AI`, `DeepSeek`, `Grok`, `OpenRouter`); full **UI & Design Studio**, quota rings, notifications, runtimes, auto-updater, migration wizard, token budgets, diagnostics, and SSH/Remote execution environments.

![3-OS Computer Use 2.0 & Live Emerald Screen HUD](docs/screenshots/computer-use-3os-hud-dark.png)

![Editable Global & Workspace AGENTS.md Settings](docs/screenshots/settings-agents-md-dark.png)

![Orchestrator Auto-Swarm, OAuth & Paid API Auto-Detect](docs/screenshots/settings-orchestrator-autodetect-dark.png)

![Settings UI & Design Customization Studio Dark](docs/screenshots/ui-design-studio-dark.png)

![Settings Models & Limit Rings Dark](docs/screenshots/settings-models-limit-rings-dark.png)

![Settings Models & Limit Rings Light](docs/screenshots/settings-models-limit-rings-light.png)

![Cross-OS Notifications Settings](docs/screenshots/notifications-settings.png)

![Runtimes & Package Updates Settings](docs/screenshots/runtimes-updates.png)

![Application Auto-Updater Settings](docs/screenshots/settings-application-updater-dark.png)

![Agent Migration Wizard Settings](docs/screenshots/settings-migration-wizard-dark.png)

![Project Token Budget & Cost Controls](docs/screenshots/settings-project-token-budget-dark.png)

![Feedback & Diagnostics Bundle Export](docs/screenshots/settings-feedback-diagnostics-dark.png)

![Paradev Subscription Bridge (Voice Dictation, Cloud Sandboxes & Tasks)](docs/screenshots/paradev-subscription-bridge-dark.png)

![Execution Environments Settings](docs/screenshots/environments.png)

---

### 8. ⚡ DeepSeek V4.1 Flash Auto-Switch Brain, 3-Mode Model Picker & 1,575-Model FreeLLMAPI Hub
- **3-Mode Composer Model Picker:** Instant choice between **`⚡ Auto · DeepSeek V4.1 Flash`** (OpenRouter Free `$0.00` / DeepSeek Platform API / FreeLLMAPI), **`🛰️ Orchestrator Models`** (Supervisor + 8 Role Pools), and strict **Direct Model** selection across Ollama, LM Studio, FreeLLMAPI, and signed-in Subscriptions.
- **Full Unlocked Cross-Platform FreeLLMAPI Integration (`macOS · Windows · Linux`):** All **1,575 models across 97 platforms** (1,345 Chat, 150 Multimodal across 7 modalities, 80 Embeddings) built in, complete with `freellmapi-keys.json` Import/Export and **🤖 Akron Web Bot Assisted Key Setup**.
- **Step-by-Step Illustrated Guide:** [**Read `docs/FREELLMAPI-GUIDE.md` →**](./docs/FREELLMAPI-GUIDE.md)

![Akron Code 3-Mode Model Picker Popup](docs/screenshots/model-picker-3modes.png)

![Auto-Switch Brain DeepSeek V4.1 Flash Settings](docs/screenshots/autoswitch-brain-dark.png)

![FreeLLMAPI 1,575-Model Unlocked Catalog Hub](docs/screenshots/freellmapi-hub-dark.png)

![FreeLLMAPI Guided Akron Web Bot Setup](docs/screenshots/freellmapi-webbot-setup.png)

#### Complete Unlocked FreeLLMAPI Catalog Summary (1,575 Models · 97 Platforms)

| Category | Platforms / Modalities | Unlocked Models | Highlight Examples |
|---|---:|---:|---|
| **Chat & Coding LLMs** | **74 platforms** | **1,345** | HuggingFace (140), ElectronHub (130), Inferbase (98), Puter (78), AI Horde (70), Navy (69), xKiro (61), Cloudflare (36), OpenRouter (29), NVIDIA NIM (27), Mistral (23), Groq (9) |
| **Image Generation** | 11 platforms | 35 | `flux-1-schnell`, `sdxl`, `imagen`, Cloudflare / ElectronHub / AI Horde / NVIDIA / Pollinations |
| **Video Generation** | 4 platforms | 5 | HuggingFace, NovAI, Pollinations, Varosity |
| **Audio / Text-to-Speech (TTS)** | 13 platforms | 45 | Google, ElectronHub, Free.ai, Varosity, Cloudflare, OVH, Cartesia, Speechify, Groq, Mistral |
| **Speech Transcription (STT)** | 13 platforms | 28 | Cloudflare, Mistral Voxtral, OVH, Typhoon, Cartesia, Cohere, Groq |
| **Web Search Engines** | 10 engines | 10 | `brave`, `exa`, `firecrawl`, `keenable`, `linkup`, `outcrawl`, `parallel`, `serpsearch`, `tavily`, `tinyfish` |
| **Decision / Router Classifiers** | 12 platforms | 20 | `@cf/cloudflare/clairic`, AISense, BeatAPI, Nutrient, Silvr, BlockRun, OpenRouter |
| **Translation & Summarization** | 4 platforms | 7 | Cloudflare `m2m100`, OVH `Olala-v1.0`, xKiro, Tanod |
| **Vector Embeddings** | **16 platforms** | **80** | HuggingFace, Cloudflare BGE, Cohere, Mistral, NVIDIA, Google, SiliconFlow, Jina / Voyage |

<details>
<summary><strong>Click to expand the Full Unlocked 97-Platform / 1,575-Model FreeLLMAPI Catalog</strong></summary>

| # | Platform | ID | Models | Top Sample Models | Signup / Keys | Free Tier Notes |
|---:|---|---|---:|---|---|---|
| 1 | **HuggingFace Inference Router** | `huggingface` | 140 | `Sao10K/L3-8B-Stheno-v3.2`, `Sao10K/L3-8B-Lunaris-v1`, `meta-llama/Llama-Guard-4-12B` | [Get Key](https://huggingface.co/settings/tokens) | 140+ routed open-weight models + video/image/embeddings |
| 2 | **ElectronHub** | `electronhub` | 130 | `nemotron-3.5-super-vl`, `lfm-3-1.7b`, `l3-8b-stheno-v3.2` | [Get Key](https://www.electronhub.ai/) | 130 chat + image + TTS + STT models (:free daily & weekly tiers) |
| 3 | **Inferbase Free** | `inferbase` | 98 | `deepseek-v3:fp4`, `meta-llama-4-scout-17b-16e-instruct`, `meta-muse-glimmer-30b` | [Get Key](https://inferbase.ai/) | 98 free managed inference models |
| 4 | **Puter AI** | `puter` | 78 | `gemini-3.8-flash`, `gpt-5.4-nano`, `qwen3.8-flash` | [Get Key](https://puter.com/) | 78 user-pays / free cloud models |
| 5 | **AI Horde** | `aihorde` | 70 | `koboldcpp/LFM3-1.7B-Q8_0.gguf`, `koboldcpp/Llama-3.2-1B-Instruct-Uncensored`, `koboldcpp/mradermacher/Qwen3.5-9B-Claude-4.6-HighIQ-THINKING-HERETIC-UNCENSORED-i1` | [Get Key](https://aihorde.net/register) | 70 community worker LLM + 5 Stable Diffusion image models (anonymous key supported) |
| 6 | **NavyAI** | `navy` | 69 | `command-r-7b`, `command-r`, `c4ai-aya-expanse-32b` | [Get Key](https://api.navy/) | 69 OpenAI-compatible community models |
| 7 | **xKiro** | `xkiro` | 61 | `stealth/big-pickle`, `cohere/north-mini-code`, `cohere/command-a-plus` | [Get Key](https://xkiro.com/) | 61 free chat, image & translation models |
| 8 | **Cloudflare Workers AI** | `cloudflare` | 36 | `@cf/google/gemma-2b-it-lora`, `@cf/google/gemma-7b-it-lora`, `@cf/llava-hf/llava-1.5-7b-hf` | [Get Key](https://dash.cloudflare.com/profile/api-tokens) | 10,000 free Neurons/day across 36 chat + image/TTS/STT/decision models |
| 9 | **FreeModel** | `freemodel` | 35 | `gpt-6-luna`, `qwen3.8-omni-flash`, `claude-haiku-5.5` | [Get Key](https://freemodel.in/) | 35 free models |
| 10 | **Kenari AI** | `kenari` | 32 | `hy4-flash:free`, `ernie-5-5-flash-preview:free`, `lfm-3-1-7b:free` | [Get Key](https://kenari.id/) | 32 chat + 3 image models |
| 11 | **Kilo Gateway** | `kilo` | 31 | `nvidia/nemotron-3.5-content-safety:free`, `baidu/ernie-5.5-flash-preview:free`, `particle-ai/particle-1:free` | [Get Key](https://kilo.ai/) | 31 free coding/chat models (keyless & keyed pools) |
| 12 | **Experiential AI** | `experiential` | 30 | `command-r-08-2024`, `command-r7b-12-2024`, `codestral-2508` | [Get Key](https://experiential.ai/) | 30 models with monthly free credit |
| 13 | **Aclide** | `aclide` | 29 | `mistralai/codestral-2508`, `mistralai/ministral-8b`, `mistralai/ministral-3b` | [Get Key](https://aclide.com/) | 29 free models |
| 14 | **OpenRouter** | `openrouter` | 29 | `nvidia/nemotron-3.5-content-safety:free`, `baidu/ernie-5.5-flash-preview:free`, `particle-ai/particle-1:free` | [Get Key](https://openrouter.ai/keys) | $0 free models (:free suffix), no card needed |
| 15 | **Blaze AI** | `blaze` | 27 | `free/lfm-3-1.7b`, `free/nemotron-3.5-bolt-e4b`, `free/flint-v1.0` | [Get Key](https://blaze.ai/) | 27 daily-free models |
| 16 | **NVIDIA NIM** | `nvidia` | 27 | `nvidia/nemotron-3.5-content-safety`, `nvidia/llama-3.1-nemoguard-8b-content-safety`, `nvidia/llama-3.1-nemoguard-8b-topic-control` | [Get Key](https://build.nvidia.com/settings/api-keys) | Free serverless NIM credits & 27+ frontier open weights |
| 17 | **Mistral AI (La Plateforme)** | `mistral` | 23 | `voxtral-small-2507`, `voxtral-small-latest`, `codestral-latest` | [Get Key](https://console.mistral.ai/api-keys) | Free Experiment tier across 23+ chat, TTS & Voxtral STT models |
| 18 | **OVH AI Endpoints** | `ovh` | 23 | `DeepSeek-V4.1-Flash-1017`, `laguna-xs-2.1`, `qwen3.6-35b-a3b` | [Get Key](https://endpoints.ai.cloud.ovh.net/) | 23 anonymous/free rate-limited EU models + TTS/STT/translation |
| 19 | **Airforce API** | `airforce` | 20 | `voxtral-small-2507`, `voxtral-small-latest`, `codestral-2508` | [Get Key](https://api.airforce/) | 20 daily-free models |
| 20 | **Onomeo** | `onomeo` | 20 | `codestral-latest`, `ministral-14b-latest`, `gpt-oss-20b` | [Get Key](https://onomeo.com/) | 20 5-hour rolling free models |
| 21 | **Cohere** | `cohere` | 17 | `command-r-08-2024`, `c4ai-aya-expanse-32b`, `c4ai-aya-vision-32b` | [Get Key](https://dashboard.cohere.com/api-keys) | 1,000 trial API calls/month free |
| 22 | **Google AI Studio (Gemini)** | `google` | 16 | `gemini-4-hydrogen`, `gemini-2.5-flash-lite`, `gemini-2.5-flash` | [Get Key](https://aistudio.google.com/apikey) | Free Gemini chat, 1M context, TTS & STT quotas |
| 23 | **Pollinations AI** | `pollinations` | 15 | `community/chigwell/llm7-fast`, `community/morriszdweck/osaii-api-fast`, `community/pegalink/jimmy` | [Get Key](https://enter.pollinations.ai/) | 15 chat + image + video models |
| 24 | **DreamPrompting** | `dreamprompting` | 14 | `cloudflare/@cf/ibm-granite/granite-4.0-h-micro`, `codestral/codestral-latest`, `nvidia-vision/meta/llama-3.2-11b-vision-instruct` | [Get Key](https://dreamprompting.com/) | 14 daily-free models |
| 25 | **Speka** | `speka` | 14 | `meta/llama-3.2-11b-vision-instruct`, `openai/gpt-oss-20b`, `nvidia/nemotron-3-super-120b-a12b` | [Get Key](https://speka.me/) | 14 free models |
| 26 | **NaraRouter** | `nara` | 13 | `atria-dawn`, `nemotron-3-super-free`, `nemotron-3.5-lightning-free` | [Get Key](https://bynara.id/) | 13 routed models |
| 27 | **Sail** | `sail` | 13 | `openai/gpt-oss-120b`, `nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-BF16`, `google/gemma-4-12B-it` | [Get Key](https://sail.ai/) | 13 models |
| 28 | **LLM7** | `llm7` | 12 | `gpt-oss:120b`, `gemma-3-27b`, `glm-5.3-flash` | [Get Key](https://token.llm7.io/) | 12 models (supports anonymous or free token) |
| 29 | **Volcengine Ark** | `volcengine` | 12 | `doubao-seed-1.6-flash`, `doubao-seed-1.6-vision`, `doubao-seed-1.6` | [Get Key](https://console.volcengine.com/ark) | 12 Doubao/DeepSeek free trial tokens |
| 30 | **LLMTR** | `llmtr` | 11 | `thinkingmachines/inkling-2-mini-free`, `motif/motif-3`, `nvidia/nemotron-3-super-120b-a12b` | [Get Key](https://llmtr.com/) | 11 free models |
| 31 | **ModelScope Inference** | `modelscope` | 11 | `Qwen/Qwen3-Next-80B-A3B-Instruct`, `Qwen/Qwen3-Coder-30B-A3B-Instruct`, `Qwen/Qwen3-VL-235B-A22B-Instruct` | [Get Key](https://modelscope.cn/my/myaccesstoken) | 11 Qwen/DeepSeek free daily calls |
| 32 | **Waterfall** | `waterfall` | 11 | `lfm-2.5-2.6b-free`, `nemotron-3-nano-omni-30b-a3b-reasoning-free`, `nemotron-3-super-120b-a12b-free` | [Get Key](https://waterfall.ai/) | 11 community-free models |
| 33 | **Apinex** | `apinex` | 10 | `free/deepseek-v4-flash-0731`, `free/mimo-v2.6-pro`, `free/glm-5.3-flashx` | [Get Key](https://apinex.bond/) | 10 daily-free models + decision classifier |
| 34 | **Custom OpenAI-Compatible** | `custom` | 10 | `qwen3.8-27b`, `glm-5.3-flash`, `mimo-v2.6-flash` | `Local / Custom` | 10 pre-wired open-weight profiles |
| 35 | **Routeway** | `routeway` | 10 | `gemma-4-26b-a4b-it-chimerax:free`, `gemma-4-26b-a4b-it-darksoul:free`, `gemma-4-26b-a4b-it-luminous:free` | [Get Key](https://routeway.ai/) | 10 free models |
| 36 | **TokenReply** | `tokenreply` | 10 | `ernie-5.5-flash-preview`, `nemotron-3-nano-omni-30b-a3b-reasoning`, `nvidia/nemotron-3.5-lightning-30b-a3b` | [Get Key](https://tokenreply.com/) | 10 free models |
| 37 | **Groq** | `groq` | 9 | `meta-llama/llama-prompt-guard-2-22m`, `meta-llama/llama-prompt-guard-2-86m`, `allam-2-7b` | [Get Key](https://console.groq.com/keys) | 30 RPM / 1K–14.4K RPD free LPU inference |
| 38 | **Requesty Router** | `requesty` | 9 | `nvidia/nemotron-3.5-content-safety`, `mistral/leanstral-1-5`, `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | [Get Key](https://app.requesty.ai/) | 9 routed free/credit models |
| 39 | **Router9** | `router9` | 9 | `qwen/qwen3-30b-a3b-instruct-2507`, `qwen/qwen3-235b-a22b-2507`, `minimax/minimax-m3` | [Get Key](https://router9.ai/) | 9 monthly-credit models |
| 40 | **Ollama Cloud** | `ollama` | 7 | `gpt-oss:20b`, `nemotron-3-nano:30b`, `gpt-oss:120b` | [Get Key](https://ollama.com/settings/keys) | 7 cloud-hosted open-weight models |
| 41 | **OpenCode Zen** | `opencode` | 7 | `nemotron-3.5-lightning-free`, `big-pickle`, `nemotron-3-ultra-free` | [Get Key](https://opencode.ai/) | 7 promo free coding models |
| 42 | **Silvr AI** | `silvr` | 7 | `deepseek-flash`, `deepseek-v4-pro`, `glm-5-3` | [Get Key](https://silvrai.net/) | 7 chat + 2 STT + 1 decision model |
| 43 | **BlockRun** | `blockrun` | 6 | `nvidia/nemotron-3-ultra-550b`, `nvidia/minimax-m3.1-flash`, `nvidia/llama-3.2-11b-vision` | [Get Key](https://blockrun.ai/) | 6 chat + 1 decision model |
| 44 | **Gizmo Platforms** | `gizmo` | 6 | `nvidia/nemotron-3.5-lightning:free`, `nvidia/nemotron-3-super-120b-a12b:free`, `poolside/laguna-xs-2.1:free` | [Get Key](https://gizmoplatforms.com/) | 6 free models |
| 45 | **SEA-LION** | `sealion` | 6 | `aisingapore/SEA-Guard`, `aisingapore/Gemma-SEA-LION-v4-27B-IT`, `aisingapore/Llama-SEA-LION-v3-70B-IT` | [Get Key](https://playground.sea-lion.ai/) | 6 Southeast Asian / multilingual LLMs |
| 46 | **Agnes AI** | `agnes` | 5 | `agnes-2.0-flash`, `agnes-2.5-flash`, `agnes-2.5-pro-alpha` | [Get Key](https://agnes-ai.com/) | 5 free models |
| 47 | **KiosAPI** | `kiosapi` | 5 | `meta/llama-3.1-8b`, `qwen/qwen3-30b`, `zai/glm-4.7-flash` | [Get Key](https://kiosapi.id/) | 5 free models |
| 48 | **Septor** | `septor` | 5 | `hermes-3-llama-3.1-405b-free`, `qwen3-next-80b-a3b-instruct-free`, `qwen3-coder-free` | [Get Key](https://septor.ai/) | 5 daily-free models |
| 49 | **Aion Labs** | `aion` | 4 | `aion-labs/aion-rp-llama-3.1-8b`, `aion-labs/aion-2.0`, `aion-labs/aion-3.0-mini` | [Get Key](https://aionlabs.ai/) | 4 free models |
| 50 | **Clod** | `clod` | 4 | `GPT OSS 20B`, `GPT OSS 120B`, `Qwen 3.5 9B` | [Get Key](https://clod.io/) | 4 daily-free models |
| 51 | **JamAI Base** | `jamai` | 4 | `ellm/Qwen/Qwen3.6-35B-A3B`, `ellm/google/gemma-4-26B-A4B-it`, `ellm/Qwen/Qwen-2-Audio-7B` | [Get Key](https://cloud.jamaibase.com/) | 4 free models |
| 52 | **Lucidity** | `lucidity` | 4 | `mistralai/mistral-nemo:free`, `lucidityai/synth-2.5-flash:free`, `lucidityai/synth-2.5-pro:free` | [Get Key](https://lucidity.ai/) | 4 daily-free models |
| 53 | **OrcaRouter** | `orcarouter` | 4 | `orcarouter/free`, `deepseek/deepseek-v4-flash-free`, `tencent/hy3-free` | [Get Key](https://orcarouter.ai/) | 4 free models |
| 54 | **BazaarLink** | `bazaarlink` | 3 | `auto:free`, `qwen/qwen3.7-flash:free`, `deepseek/deepseek-v4-flash-0731free:free` | [Get Key](https://bazaarlink.ai/) | 3 free models |
| 55 | **NovAI** | `novai` | 3 | `glm-4.1v-thinking-flash`, `glm-4.6v-flash`, `glm-4.7-flash` | [Get Key](https://aiapi-pro.com/) | 3 chat + image + video models |
| 56 | **Reka AI** | `reka` | 3 | `reka-flash`, `reka-flash-3`, `reka-edge-2603` | [Get Key](https://platform.reka.ai/) | 3 multimodal research models |
| 57 | **Zhipu GLM (Z.AI)** | `zhipu` | 3 | `glm-4.6v-flash`, `glm-4.5-flash`, `glm-4.7-flash` | [Get Key](https://z.ai/manage-apikey/apikey-list) | 3 free GLM Flash chat + embedding models |
| 58 | **FreeInference** | `freeinference` | 2 | `qwen3.6-35b`, `deepseek-v4-flash` | [Get Key](https://freeinference.org/) | 2 free models |
| 59 | **Logfare** | `logfare` | 2 | `logfare/auto`, `gemma-4-26b` | [Get Key](https://logfare.com/) | 2 free models |
| 60 | **Moondream** | `moondream` | 2 | `moondream3.1-9B-A2B`, `moondream3-preview` | [Get Key](https://console.moondream.ai/) | 2 free compact vision-language models |
| 61 | **Nutrient** | `nutrient` | 2 | `nutrient-s`, `nutrient-m` | [Get Key](https://nutrient.io/) | 2 chat + 2 decision models |
| 62 | **Plugsky** | `plugsky` | 2 | `plugsky-micro`, `plugsky-lite` | [Get Key](https://plugsky.com/) | 2 fair-use chat + 2 image models |
| 63 | **AMD Radeon Cloud** | `radeon` | 2 | `DeepSeek-V4-Flash`, `Qwen3.8-Flash-Next` | [Get Key](https://developer.amd.com.cn/) | 2 free AMD Instinct models |
| 64 | **SimpleLLM** | `simplellm` | 2 | `free-gemma-4-E4B`, `free-Llama-3.1-8B-Instruct` | [Get Key](https://simplellm.eu/) | 2 EU-hosted free models |
| 65 | **UnoRouter** | `unorouter` | 2 | `glm-5.3-flash:free`, `glm-5.3:free` | [Get Key](https://unorouter.com/) | 2 free models |
| 66 | **cheapllm.shop** | `cheapllm` | 1 | `deepseek-v4.1-flash-1017` | [Get Key](https://cheapllm.shop/) | 1 free starter model |
| 67 | **IteraCompute** | `iteracompute` | 1 | `qwen/qwen3.8-27b` | [Get Key](https://iteracompute.com/) | 1 monthly-free model |
| 68 | **LLM Kiwi** | `llmkiwi` | 1 | `auto` | [Get Key](https://llm.kiwi/) | 1 free model |
| 69 | **Meldport** | `meldport` | 1 | `gpt-6-luna:free` | [Get Key](https://meldport.ai/) | 1 free model |
| 70 | **Nabh Cloud** | `nabh` | 1 | `gpt-oss-20b` | [Get Key](https://nabh.cloud/) | 1 free model |
| 71 | **PowerTokens** | `powertokens` | 1 | `glm-4.7-flash` | [Get Key](https://powertokens.ai/) | 1 free model |
| 72 | **Typhoon AI** | `typhoon` | 1 | `typhoon-v2.5-30b-a3b-instruct` | [Get Key](https://opentyphoon.ai/) | 1 Thai/English chat + 3 STT models |
| 73 | **iFlytek Spark** | `xfyun` | 1 | `lite` | [Get Key](https://console.xfyun.cn/) | 1 free Spark Lite model |
| 74 | **Zro Moonmath** | `zro` | 1 | `deepseek-v4.1-flash` | [Get Key](https://zro.moonmath.ai/) | 1 free model |

#### Image Generation (35 models · 11 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **Cloudflare Workers AI** (`cloudflare`) | 9 | `@cf/leonardo/phoenix-1.0`, `@cf/leonardo/lucid-origin`, `@cf/black-forest-labs/flux-2-dev`, `@cf/lykon/dreamshaper-8-lcm` |
| **ElectronHub** (`electronhub`) | 6 | `qwen-image-2512`, `flux-2-klein-base-4b`, `flux-2-flex`, `realvisxl-5.0` |
| **AI Horde** (`aihorde`) | 5 | `Flat-2D Animerge`, `stable_diffusion`, `Deliberate`, `Dreamshaper` |
| **Varosity AI** (`varosity`) | 4 | `flux-3-klein`, `qwen-image-3.0`, `gpt-image-2.5-flare`, `flux-2-pro` |
| **Kenari AI** (`kenari`) | 3 | `agnes-image-2-0-flash:free`, `agnes-image-2-1-flash:free`, `agnes-image-2-5-flash:free` |
| **NVIDIA NIM** (`nvidia`) | 2 | `black-forest-labs/flux.2-klein-4b`, `black-forest-labs/flux.1-dev` |
| **Plugsky** (`plugsky`) | 2 | `plugsky-flux`, `dall-e-3` |
| **NovAI** (`novai`) | 1 | `cogview-3-flash` |
| **OVH AI Endpoints** (`ovh`) | 1 | `stable-diffusion-xl-base-v10` |
| **Pollinations AI** (`pollinations`) | 1 | `sana` |
| **xKiro** (`xkiro`) | 1 | `sensenova/sensenova-u1.5-lite` |

#### Video Generation (5 models · 4 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **HuggingFace Inference Router** (`huggingface`) | 2 | `Lightricks/LTX-Video-0.9.7-distilled`, `Lightricks/LTX-Video-0.9.5` |
| **NovAI** (`novai`) | 1 | `cogvideox-flash` |
| **Pollinations AI** (`pollinations`) | 1 | `nova-reel` |
| **Varosity AI** (`varosity`) | 1 | `grok-imagine-video` |

#### Audio / Text-to-Speech (45 models · 13 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **Google AI Studio (Gemini)** (`google`) | 6 | `gemini-2.5-flash-preview-tts`, `gemini-3.1-flash-tts-preview`, `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` |
| **ElectronHub** (`electronhub`) | 5 | `gpt-4o-mini-tts`, `kokoro-tts`, `gemini-3.8-flash-tts`, `gemini-3.8-flash-lite-tts` |
| **Free.ai** (`freeai`) | 5 | `melotts`, `chatterbox`, `qwen3-tts`, `vibevoice` |
| **Varosity AI** (`varosity`) | 5 | `openai-tts-1`, `elevenlabs-tts-v3`, `fal-kokoro`, `heygen-voice-turbo` |
| **Cloudflare Workers AI** (`cloudflare`) | 4 | `@cf/deepgram/aura-1`, `@cf/deepgram/aura-2-en`, `@cf/deepgram/aura-2-es`, `@cf/myshell-ai/melotts` |
| **OVH AI Endpoints** (`ovh`) | 4 | `nvr-tts-en-us`, `nvr-tts-de-de`, `nvr-tts-es-es`, `nvr-tts-it-it` |
| **Cartesia Sonic** (`cartesia`) | 3 | `sonic-3.6`, `sonic-3.5`, `sonic-3` |
| **Speechify** (`speechify`) | 3 | `simba-3.2`, `simba-3.0`, `simba-3.5` |
| **Typecast** (`typecast`) | 3 | `ssfm-v31`, `ssfm-v30`, `ssfm-v21` |
| **Groq** (`groq`) | 2 | `canopylabs/orpheus-v1-english`, `canopylabs/orpheus-arabic-saudi` |
| **Mistral AI (La Plateforme)** (`mistral`) | 2 | `voxtral-mini-tts-3-0`, `voxtral-mini-tts-2603` |
| **Rime Voice** (`rime`) | 2 | `coda`, `mistv3` |
| **FreeTTS** (`freetts`) | 1 | `neural-tts` |

#### Speech Transcription / STT (28 models · 13 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **Cloudflare Workers AI** (`cloudflare`) | 4 | `@cf/openai/whisper-tiny-en`, `@cf/deepgram/nova-3`, `@cf/openai/whisper`, `@cf/openai/whisper-large-v3-turbo` |
| **Mistral AI (La Plateforme)** (`mistral`) | 3 | `voxtral-mini-2602`, `voxtral-mini-transcribe-3`, `voxtral-small-transcribe-3` |
| **OVH AI Endpoints** (`ovh`) | 3 | `solaria-3`, `whisper-large-v3-turbo`, `whisper-large-v3` |
| **Typhoon AI** (`typhoon`) | 3 | `typhoon-isan-asr-realtime`, `typhoon-asr-realtime`, `typhoon-asr-edge` |
| **Cartesia Sonic** (`cartesia`) | 2 | `ink-2`, `ink-whisper` |
| **Cohere** (`cohere`) | 2 | `cohere-transcribe-arabic-07-2026`, `cohere-transcribe-03-2026` |
| **ElectronHub** (`electronhub`) | 2 | `voxtral-mini-2602`, `deepgram-nova-3` |
| **Google AI Studio (Gemini)** (`google`) | 2 | `gemini-3.5-transcribe-live`, `gemini-3.5-transcribe` |
| **Groq** (`groq`) | 2 | `whisper-large-v3`, `whisper-large-v3-turbo` |
| **Silvr AI** (`silvr`) | 2 | `whisper-large-v3-turbo`, `whisper-large-v3` |
| **Free.ai** (`freeai`) | 1 | `whisper` |
| **Rime Voice** (`rime`) | 1 | `rime-stt` |
| **SpeechFlow** (`speechflow`) | 1 | `speechflow-asr` |

#### Web Search Engines (10 engines · 10 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **Brave Search** (`brave`) | 1 | `brave-search` |
| **Exa Search** (`exa`) | 1 | `exa-search` |
| **Firecrawl** (`firecrawl`) | 1 | `firecrawl-search` |
| **Keenable** (`keenable`) | 1 | `keenable-search` |
| **Linkup Search** (`linkup`) | 1 | `linkup-search` |
| **Outcrawl** (`outcrawl`) | 1 | `outcrawl-search` |
| **Parallel Web** (`parallel`) | 1 | `parallel-search` |
| **SerpSearch** (`serpsearch`) | 1 | `serpsearch-search` |
| **Tavily** (`tavily`) | 1 | `tavily-search` |
| **TinyFish** (`tinyfish`) | 1 | `tinyfish-search` |

#### Decision / Router Classifiers (20 models · 12 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **Cloudflare Workers AI** (`cloudflare`) | 5 | `@cf/cloudflare/clairic`, `@cf/cloudflare/clairic-flash`, `@cf/cloudflare/clef-omni`, `@cf/cloudflare/clef` |
| **AISense** (`aisense`) | 3 | `tev1`, `nimble`, `clef` |
| **BeatAPI** (`beatapi`) | 2 | `jev-1.13-free`, `jev-1.14-free` |
| **Nutrient** (`nutrient`) | 2 | `nutrient-systemone`, `nutrient-document-decision` |
| **Apinex** (`apinex`) | 1 | `free/jev-1.13` |
| **BlockRun** (`blockrun`) | 1 | `gpt-6-luna` |
| **Classifier.dev** (`classifierdev`) | 1 | `jev-latest` |
| **Google AI Studio (Gemini)** (`google`) | 1 | `gemini-decision-1` |
| **Halx** (`halx`) | 1 | `THX-01` |
| **OpenRouter** (`openrouter`) | 1 | `inception/mercury-decide:free` |
| **Silvr AI** (`silvr`) | 1 | `gemini-decision-1` |
| **Tanod** (`tanod`) | 1 | `nli-deberta-v3-xsmall` |

#### Translation & Summarization (7 models · 4 platforms)

| Platform | Models / Engines | Sample IDs |
|---|---:|---|
| **Cloudflare Workers AI** (`cloudflare`) | 2 | `@cf/meta/m2m100-1.2b`, `@cf/ai4bharat/indictrans2-en-indic-1B` |
| **OVH AI Endpoints** (`ovh`) | 2 | `Olala-v1.0-summarise`, `Olala-v1.0-translate` |
| **xKiro** (`xkiro`) | 2 | `cohere/command-a-translate`, `cohere/north-small-translate` |
| **Tanod** (`tanod`) | 1 | `argos-translate` |

| # | Platform | ID | Models | Sample Embedding Models | Signup / Keys |
|---:|---|---|---:|---|---|
| 1 | **Inferbase Free** | `inferbase` | 14 | `baai-bge-m3`, `google-embeddinggemma-2`, `nvidia-nemotron-3-embed-1b` | [Get Key](https://inferbase.ai/) |
| 2 | **HuggingFace Inference Router** | `huggingface` | 13 | `BAAI/bge-m3`, `BAAI/bge-small-en-v1.5`, `BAAI/bge-base-en-v1.5` | [Get Key](https://huggingface.co/settings/tokens) |
| 3 | **Cloudflare Workers AI** | `cloudflare` | 8 | `@cf/google/embeddinggemma-2`, `@cf/baai/bge-m3`, `@cf/google/embeddinggemma-300m` | [Get Key](https://dash.cloudflare.com/profile/api-tokens) |
| 4 | **ElectronHub** | `electronhub` | 8 | `codestral-embed`, `mistral-embed`, `gemini-embedding-2` | [Get Key](https://www.electronhub.ai/) |
| 5 | **Cohere** | `cohere` | 7 | `embed-v5.0-pro`, `embed-v5.0-fast`, `embed-multilingual-light-v3.0` | [Get Key](https://dashboard.cohere.com/api-keys) |
| 6 | **OpenRouter** | `openrouter` | 5 | `nvidia/llama-nemotron-embed-vl-1b-v2:free`, `nvidia/nemotron-3.5-embed-1b:free`, `nvidia/nemotron-3.5-embed-8b:free` | [Get Key](https://openrouter.ai/keys) |
| 7 | **Silvr AI** | `silvr` | 5 | `gemini-embedding-2`, `gemini-embedding-001`, `text-embedding-3-small` | [Get Key](https://silvrai.net/) |
| 8 | **NVIDIA NIM** | `nvidia` | 4 | `nvidia/nemotron-3-embed-1b`, `nvidia/nemotron-3.5-embed-1b`, `nvidia/nemotron-3.5-embed-8b` | [Get Key](https://build.nvidia.com/settings/api-keys) |
| 9 | **SEA-LION** | `sealion` | 4 | `BAAI/bge-m3`, `aisingapore/SEA-LION-E5-Embedding-600M`, `aisingapore/SEA-LION-ModernBERT-Embedding-300M` | [Get Key](https://playground.sea-lion.ai/) |
| 10 | **Free.ai** | `freeai` | 2 | `bge-m3`, `embeddinggemma-2` | [Get Key](https://free.ai/) |
| 11 | **Google AI Studio (Gemini)** | `google` | 2 | `gemini-embedding-001`, `gemini-embedding-2` | [Get Key](https://aistudio.google.com/apikey) |
| 12 | **LLMTR** | `llmtr` | 2 | `llmtr/embeddingmagibu-200m`, `liquid/lfm-2.5-embedding-350m-free` | [Get Key](https://llmtr.com/) |
| 13 | **Speka** | `speka` | 2 | `nvidia/nemotron-3-embed-1b`, `nvidia/llama-nemotron-embed-vl-1b-v2` | [Get Key](https://speka.me/) |
| 14 | **Tanod** | `tanod` | 2 | `multilingual`, `small-en` | [Get Key](https://tanod.ai/) |
| 15 | **FreeInference** | `freeinference` | 1 | `bge-m3` | [Get Key](https://freeinference.org/) |
| 16 | **JamAI Base** | `jamai` | 1 | `ellm/BAAI/bge-m3` | [Get Key](https://cloud.jamaibase.com/) |

</details>

---

## Core Capabilities

- **UI & Design Customization Studio (`Settings → Appearance & System`):** Live styling controls via CSS custom properties + `data-*` attributes (**Dark / Light / Auto**, 4 Surface Finishes, 6 Accent Swatches + custom hex picker, 3 Background Patterns, 3 UI Densities, 4 Chat Reading Widths, Editorial vs. Bubbles layout, 3 Corner Roundnesses, per-message timestamp formatters `date-time | 12h | relative | iso`, `compact | icons-only | hover` Action Bar styles, and 1-click Reset).
- **Context Engine 2.0 & Hardened Agent Harness:**
  - **Spill-to-Disk (`electron/spill.js`):** Large tool outputs (`>12 KB`) spill to private `0o600` files (`~/.autobot/spills/`) with clean head/tail slices + 7-day auto-pruning.
  - **Progressive Output Masking (`electron/context-pipeline.js`):** Preserves the newest 4 tool turns verbatim while distilling older verbose outputs and respecting a 20,000-token customizations budget.
  - **Doom-Loop Circuit Breaker (`electron/loop-guard.js`):** Escalates at 3/5/8 identical or cyclical retries, enforces 20s FIFO/named-pipe timeouts, caps hook output at 50 KB, and stops MCP stdout flooding.
- **Elite Code Editing & Codebase Indexing 2.0 (`electron/apply-patch.js`, `electron/ide/ast-chunker.js`, `electron/ide/embedder.js`, `electron/ide/codebase-index.js`, `electron/codemode.js`):**
  - Atomic multi-file **Codex V4A `ApplyPatch`** with 4-tier fuzzy matching, **SHA-256 + mtime stale-read guard** + instant `ShadowCheck` syntax/LSP verification, multi-language AST scope chunking (`1 MB` ceiling) + 384-dim/dense **Reciprocal Rank Fusion (`RRF k=60`) `CodebaseSearch`**, and isolated `worker_threads` **`RunToolScript`** batching.
- **Storage Engine 2.0: Crash-Safe WAL Sidecar, Okapi BM25 & OS Sandbox:**
  - Pure-WASM **SQLite + `<db>.wal.jsonl` WAL sidecar + Okapi BM25 (`k1=1.5, b=0.75`) + FTS5** store (`~/.autobot/akron.db`), deduplicated categorized memory, `/learn` skill extraction, and **OS Sandbox (`electron/os-sandbox.js`)** across macOS Seatbelt, Linux `bwrap`, and Windows PowerShell policies.
- **Background Daemon & GitHub Webhook Bot (`electron/daemon.js`, `electron/scheduler-lock.js`, `electron/remote-server.js`):**
  - Headless background daemon (`akron daemon start|stop|status|install|uninstall`) with exclusive `scheduler.lock.json` coordination and authenticated `POST /webhooks/github` PR/issue reviews running in isolated detached `git worktree` sandboxes.
- **Universal Media & Pre-Bundled Office Studio (`electron/media-gen.js`, `electron/doc-studio.js`):**
  - Automatic routing for **`GenerateImage`**, **`EditImage`**, **`GenerateVideo`**, **`EditVideo`**, **`ReadDocument`**, and **`GenerateDocument`** supporting PDF, LaTeX, `.docx`, `.xlsx`/`.csv`, `.pptx`, `.epub`, `.sqlite`, and `.zip`/`.tar.gz` completely offline.
- **Cross-Platform OAuth Auto-Heal & Portable Encrypted Storage:**
  - AES-256-GCM portable secret store (`~/.autobot/secrets.json`), encrypted `oauth-mirror/`, single-flight `refreshFlights`, and 1-click **Auto-Heal PC Accounts** across macOS, Windows, and Linux.
- **Hardened Dual `[Agent | IDE]` Workbench, `.ipynb` Notebooks, Debugger & Next-Edit Prediction:**
  - Per-file Monaco models (`monaco.Uri.file`), shared split-editor state, stateful **`.ipynb` Python/JS Notebooks**, live **Node CDP + Python `pdb` Debugger** (gutter breakpoints, Call Stack, Locals, Watches), **Next-Edit Prediction (`Alt+]`)**, persistent non-leaking PTY lifecycle, full LSP sync, per-hunk `ideGitStagePatch`, and offline **Markmap** mind maps.

---

## Installation & Build from Source

```bash
git clone https://github.com/faysaliteng/akron-code.git
cd akron-code
npm ci
npm run typecheck
npm run build
npm start
```

Run verification suites and package installers locally:

```bash
npm run brand:check
for f in test/*.test.js; do node "$f" || exit 1; done
npm run eval:all

npm run dist:mac     # macOS .dmg + .zip (+ ./verify-release.sh)
npm run dist:win     # Windows NSIS Setup .exe + Portable .exe
npm run dist:linux   # Linux .AppImage + .deb (requires dpkg/fakeroot on Linux CI or Ubuntu)
```

Start a headless remote workspace daemon for **Environments → Remote Server**:

```bash
node scripts/akron-remote-server.js --port 8770 --workspace /path/to/repo
```

---

## Companion CLI (`akron`) & Daemon

Akron Code includes a standalone multi-turn coding agent & daemon CLI wired at [`bin/akron.js`](./bin/akron.js):

```bash
npm link                                               # exposes global `akron` command
akron                                                  # interactive multi-turn REPL with /model /diff /undo
akron -p "Audit auth boundaries" --yolo --stream-json  # headless multi-turn tool loop + NDJSON stream
akron -p "Follow up on findings" --continue            # resume persisted SQLite+WAL session
akron daemon start                                     # run background scheduler & webhook server
akron daemon install                                   # install launchd / systemd / Windows Task service
akron review --adversarial                             # cross-vendor Duet review on current git diff
akron remote start --port 8770                         # launch authenticated remote WebSocket server
akron doctor --json                                    # verify AST index v2, WAL+BM25 DB, ripgrep & tools
akron eval all                                         # run reproducible 70-case evaluation suite
```

---

## Keyboard Shortcuts (`macOS` & `Windows / Linux`)

| Action | macOS | Windows / Linux |
|---|---|---|
| Quick Open File / Command Center (`>` cmd, `@` sym) | `⌘P` | `Ctrl+P` |
| Inline AI Code Edit (`⌘K` Diff Widget) | `⌘K` | `Ctrl+K` |
| Accept Inline AI Edit | `⌘⏎` | `Ctrl+Enter` |
| Project Search & Replace (`@vscode/ripgrep`) | `⇧⌘F` | `Ctrl+Shift+F` |
| Go to Symbol in Active File | `⇧⌘O` | `Ctrl+Shift+O` |
| Toggle Terminal / Problems / Output Drawer | `⌘J` | `Ctrl+J` |
| Find in Terminal / Chat | `⌘F` | `Ctrl+F` |
| Toggle Sidebar / Akron Agent Dock | `⌘B` | `Ctrl+B` |
| Save Active File | `⌘S` | `Ctrl+S` |
| Open Settings | `⌘,` | `Ctrl+,` |
| Permission Dock Approve (`1`–`4`) / Deny (`Esc`) | `1`–`4` / `Esc` | `1`–`4` / `Esc` |
| Exit Browser Inspect Element Mode | `Esc` | `Esc` |

---

## Open Ecosystem Extensibility

- **Slash Skills & Workflows:** Stored in `~/.autobot/skills/`, `~/.claude/skills/`, or extracted live via `/learn` (`ExtractSkill`) and managed inside **Customizations → Installed**.
- **Custom Sub-Agents (`.md` + YAML frontmatter):** Define specialist `@agent` profiles in `~/.autobot/agents/*.md` or `.claude/agents/*.md` with scoped model roles and tool allowlists; surfaced directly in `@` autocomplete.
- **Custom Output Styles:** Customize response structure and tone via `~/.autobot/output-styles/*.md` or built-in presets (`Emerald Executive`, `Principal Architect`, `/output-style`).
- **Plugins & MCP Connectors:** Connect any `stdio`, `SSE`, or streamable `HTTP` MCP server in `.mcp.json` or **Customizations → Marketplace / Installed** (400+ curated & MCP registry connectors + **263-tool built-in `rea`**).
- **Custom Runtime Tools (`CreateCustomTool`):** Extend the agent loop safely at runtime or via remote SSH/WebSocket adapters.

---

## Benchmark Evaluations

Executed deterministically offline via `npm run eval:all` (see [`docs/BENCHMARKS.md`](./docs/BENCHMARKS.md)):

| Suite | Tasks | Passed | Pass Rate | Focus Area |
|---|---:|---:|---:|---|
| **Security & WhisperBench Guard** | 32 | 32 | **100%** | Prompt injection resistance, Zip-Slip defense, 0 unauthorized calls |
| **Coding Intelligence & Context 2.0** | 22 | 22 | **100%** | `ApplyPatch`, `EditGuard` rollback, `CodebaseSearch`, `RunToolScript`, `Spill`, `LoopGuard` |
| **Akron Browser Bot 2.0** | 16 | 16 | **100%** | Compact AX DOM reduction, healed replay, RFC 6238 TOTP Vault |
| **Total Reproducible Suite** | **70** | **70** | **100%** | `npm run eval:all` |

---

## Security Hardening, Brand Seal & Legal

- **Electron Security Fuses (`scripts/harden-fuses.js`):** Every packaged binary enforces `RunAsNode=0`, `OnlyLoadAppFromAsar=1`, `EnableEmbeddedAsarIntegrityValidation=1`, `EnableCookieEncryption=1`, `EnableNodeOptionsEnvironmentVariable=0`, and `EnableNodeCliInspectArguments=0`, with **0 `.map` files** in `dist/` or ASAR.
- **Cryptographic Brand Seal (`electron/brand-seal.json`):** Validates SHA-256 digests of sealed desktop icons, ASAR runtime artwork, and **Akron Browser Bot** MV3 extension resources on boot.
- **Portable Encrypted Credentials (`electron/secretstore.js`):** Secrets are encrypted with AES-256-GCM at `~/.autobot/secrets.json` (`0o600`) with zero hardcoded keys or personal identifiers in git.
- **Docs & Legal:** [VERIFICATION.md](./VERIFICATION.md) · [GAPS.md](./GAPS.md) · [CHANGELOG.md](./CHANGELOG.md) · [SECURITY.md](./SECURITY.md) · [CONTRIBUTING.md](./CONTRIBUTING.md) · [LICENSE.md](./LICENSE.md) · [TRADEMARKS.md](./TRADEMARKS.md)
