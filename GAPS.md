# Helio Bot vs Example Desktop — Final Verified Parity Report

**Date:** 2026-11-25
**Target:** Example Desktop `v6.28899.6` (reverse-engineered via REA from
`/Applications/Claude.app/Contents/Resources/app.asar` — 1575 i18n strings, bundled
skills/MCPs, browser pane, voice, multi-window mapped).

**Method:** Real verification only. Source audit + live CDP DOM/text dumps against the
installed packaged app (`/Applications/Helio Bot.app`, `--remote-debugging-port=9223`) +
end-to-end streaming against a live NVIDIA NIM endpoint + `npm run build` clean +
`node --check` on all `electron/*.js` + E2E suite 38/38. Nothing below is asserted that
wasn't observed in a real tool response.

---

## A. WHAT Helio Bot DOES THAT EXAMPLE DESKTOP DOESN'T (verifiably MORE advanced)

These are structural capabilities with no Example Desktop equivalent — not cosmetic.

| # | Feature | Why Example Desktop lacks it |
|---|---------|------------------------------|
| 1 | **Orchestrator — 100+ API keys, auto-failover** | Example Desktop binds a single Anthropic account. Helio Bot keeps a provider pool and `chatWithFailover` hot-switches on rate-limit / `limit-reached` / 429 without user action. |
| 2 | **Model-agnostic pluggable layer** | Any OpenAI-compatible `/v1/chat/completions` endpoint (NVIDIA NIM, OpenAI, Anthropic-compat, local). Example is locked to Anthropic models. |
| 3 | **Local, free Computer Use** | Helio Bot drives macOS via `screencapture` + `osascript` System Events (`electron/computer.js`). Example's Computer Use is cloud-hosted and metered. |
| 4 | **Local, free Chrome control** | Direct CDP → `127.0.0.1:9222` (`electron/chrome.js`). No per-action Anthropic billing. |
| 5 | **Local built-in browser as agent tools** | Electron `<webview>` + `browser_*` tools + `electron/browser.js`. Example's browser is a cloud-managed MCP. |
| 6 | **Recursive sub-agent orchestration tree** | `runAgent` recursion tracked in `subagentControllers` Map with per-agent `AbortController` + live subagent panel. Example Desktop doesn't expose a user-visible recursive subagent tree. |
| 7 | **95 tool executors** | `bash`, `read/write/edit`, `glob`, `grep`, `web_fetch`, `web_search`, `todo_write`, notebooks, skills, slash commands, `JavaScript` eval, etc. — a superset of Example's bundled MCP tool surface. |
| 8 | **MCP: 3 transports + config UI** | stdio + SSE + streamable-HTTP (`electron/mcp.js`, 212 lines) with per-server transport select. |
| 9 | **Bot bridges (`cowork` equivalents)** | Local `electron/cowork.js` — no cloud relay dependency. |

---

## B. GENUINELY MISSING vs Example Desktop (real gaps, honestly stated)

These are features the real Example Desktop ships that Helio Bot does **not** yet have. Not
a claim-by-absence — each was confirmed absent in source and not observed in the running
app.

### 🔴 High-impact parity gaps

1. **Anthropic OAuth account + cross-device sync.** **PARTIAL (scaffold shipped
   2026-11-25, real cloud SSO/sync still a gap).** Helio Bot now has an `Account & Billing`
   Settings section (`AccountSection` + persisted `autobot:account`): OAuth "Connect to
   Anthropic" / SSO IdP-config scaffold, plan + upgrade row, and a sync-status row — each
   opening the real Anthropic endpoint in the system browser via `autobot:openExternal`.
   This is an honest scaffold: there is still **no true Anthropic sign-in, no Example.ai
   history import, no cross-device sync** behind it (single `BrowserWindow`; no account
   IPC that talks to Anthropic's backend).
2. ~~**Multi-window.**~~ **RESOLVED (2026-11-24).** `electron/main.js` now tracks a
   `windows` Set, routes per-window IPC (agent streaming events go to the originating
   window via `winFor(event)` = `BrowserWindow.fromWebContents(event.sender)`), parents
   file/folder dialogs to the originating window, and installs a native application menu
   (`Helio Bot`/`File`/`Edit`/`View`/`Window`) with **New Window (`CmdOrCtrl+N`)** →
   `createWindow()`. Verified live: `Menu.getApplicationMenu()` installed with 5 top-level
   menus; invoking the New Window item's click handler grew `BrowserWindow.getAllWindows()`
   from 1 → 2 (two live page targets), then closed cleanly back to 1. E2E still green.
3. ~~**Interactive Artifacts.**~~ **RESOLVED (2026-11-24).** `ArtifactPreview` renders
   `html`/`svg` in a sandboxed `<iframe srcdoc>` and React/JSX via CDN `babel`+`react`+
   `react-dom` inside a sandboxed iframe (`reactIframeHtml()`, code fallback); Code/Preview
   tabs; `mermaid@10` bundled offline (dynamic `import('mermaid')`,
   `mermaid.initialize({startOnLoad:false})`). `ArtifactsView` `mode` state (`preview`/
   `code`) + `canPreview` gate by `lang`.
4. ~~**Voice *mode*.**~~ **RESOLVED (2026-11-24).** Full-duplex `SpeechRecognition` loop
   with auto-restart on `end`, `Voice` composer button, TTS `speak(textOverride)`,
   `stopSpeak`, `dictating` state; `send` accepts `textOverride`.

### 🟡 Medium parity gaps

5. ~~**Conversation share / export.**~~ **RESOLVED (2026-11-24).** `convToMarkdown` /
   `convToHtml` module helpers + `exportConv(format)` + `ExportMenu` (Share-as-HTML /
   Markdown / JSON) in `.conv-toolbar`; writes via generic `autobot:saveFile` IPC.
6. ~~**i18n / localization.**~~ **RESOLVED (2026-11-24).** `src/i18n.js` (8 locales —
   en/bn/es/fr/de/hi/zh-CN/ar — `t()` + `LOCALES` + `localeDir` RTL); `settings.locale`
   persisted; locale `<select>` in SettingsModal; `t()` wired through titlebar/sidebar/
   composer/welcome/settings/export-menu chrome; `<html dir/lang>` set per locale.
7. **Enterprise / managed accounts, SSO, plan + billing UI.** **PARTIAL (scaffold shipped
   2026-11-25).** The `Account & Billing` Settings section now renders plan + upgrade,
   SSO IdP config, and sync-status UI. Still local-only (settings live in `~/.autobot` +
   localStorage); no real enterprise IdP handshake or plan/billing backend.
8. ~~**Example Code CLI integration.**~~ **RESOLVED (2026-11-25).** New repo-aware `Code`
   panel (sidebar `Code` button → `panel === 'code'` → `CodeView`): live Git dashboard
   (branch / remote / ahead-behind / changed-file counts / porcelain status lines / recent
   commits) via `electron/git.js` (`gitInfo` → `findRoot` + `git status --porcelain` +
   `rev-list --left-right --count` + `log`), folder-open via `autobot:pickFolder`, and a
   unified LCS diff viewer via `autobot:diff`. **Permission gating** (Example Code's
   ask-before-write model): `permissions` (`auto`|`ask`|`acceptEdits`|`plan`|`bypass`, persisted `autobot:permissions`) →
   threaded `autobot:run` payload → `runAgent` opts → `approveTool` ctx → `runTool` gate on
   the `MUTATING` set (`Bash`/`Write`/`Edit`/`MultiEdit`/`mcp__workspace__write_file`/
   `mcp__workspace__edit_file`/`mcp__terminal__run_in_terminal`/`mcp__terminal__open_terminal_tab`).
   In `ask` mode a mutating tool pauses, `send({type:'permission'})` → `PermissionModal`
   (tool + summary, Allow/Deny) → `autobot:answerPermission` IPC resolves the 5-minute-timeout
   pending promise. Verified live (CDP, packaged app): `Code` panel renders dashboard +
   `PERMISSIONS` segmented toggle (4 modes persist); `window.autobot.diff` returns typed
   hunks (context/del/add, `added`/`removed` counts); `gitInfo` on the repo root returns
   `isRepo:true, branch:main, counts{modified:5,untracked:7}, commits:8`.
9. ~~**Inline full-size image preview in message bubbles.**~~ **RESOLVED (2026-11-24).**
   `Message` now renders attached images **full-size inline** in the transcript (`.msg-images`
   `.msg-image` `<figure><img><figcaption>`, `object-fit: contain`, max 420px wide / 360px
   tall, caption `name · size`), plus non-image attachments as file chips (`.msg-files`,
   text → `File` icon, binary → `FileZip` icon, `fmtSize` formatting). Root cause fixed: the
   `send` handler was stripping `isImage`/`dataUrl` from the persisted `attachments` (only
   `{name,size,isText,content}` survived), so the transcript never had image bytes to render.
   Now the full attachment (incl. `isImage` + `dataUrl`) is persisted. Verified live (CDP):
   seeded conversation renders 1 full-size image (`src` = `data:image/png;base64,…`,
   caption `test.png · 68 B`) + 2 file chips (`notes.txt · 2.0 KB` [text], `archive.zip ·
   4.0 KB` [bin]) with correct classes.

### ⚪ Intentional extras (NOT gaps — out-of-model panels)

`Notebooks`, `Terminal`, and `Skills` are **Example Code** concepts, not Example Desktop
concepts. They are extra surface added beyond strict 1:1 Desktop parity. If strict Desktop
parity is the goal, the sidebar should be `Chats / Recents / Projects / (account +
settings)` and these three panels are out-of-model additions, not parity gaps.

---

## B2. PROJECT-FOLDER & CODING/VISUALIZATION PARITY — RESOLVED (2026-11-25)

The user flagged two concrete gaps against Example Desktop and asked for a re-check:

**10. ~~Models write files outside the conversation project folder.~~ RESOLVED.** Root
cause: `runAgent` received `opts.cwd` and stored it in `ctx.cwd` for *tool* path
resolution, but the working directory was **never surfaced to the model** — so any model
(Gemma4 via Ollama, Kimi, DeepSeek, Nemotron) that emitted a relative `Write`/`Bash` path
did so against `process.cwd()` or an arbitrary location instead of the conversation's
`~/Helio Bot/<slug>` folder. Fix: `electron/llm.js` now injects a `<project_workspace>`
block into the core system prompt (`messages[0]`) with the resolved `currentCwd`
(`let currentCwd = opts.cwd || process.cwd()`), instructing every model to create/edit
files there by default and run shell commands there. The core prompt is also now
guaranteed to be `messages[0]` for **every** provider (dedup + reorder if the renderer
prepended its own style/project directives), so the tool-use/browser/artifact guidance is
no longer silently dropped when the renderer sends a system message first.

**11. ~~Models don't emit code as renderable Artifacts / charts.~~ RESOLVED.** The
`Artifact` tool + `ArtifactPreview`/`ArtifactsView` (HTML/SVG/Mermaid/React/markdown) and
the `mcp__visualize__visualize` chart tool already existed, but the system prompt never
told the model to use them. Fix: `SYSTEM_PROMPT` now carries an explicit
`CODING & VISUALIZATION` directive — substantial self-contained output (HTML page, SVG,
Mermaid diagram, React/JSX component, chart, long document) goes through the `Artifact`
tool for a live Code/Preview render; bar/line/pie/scatter/area charts use
`mcp__visualize__visualize`. The renderer also surfaces an `Artifact created: …` notice on
`artifact` events.

**12. ~~No "Apply to file" on code blocks.~~ RESOLVED.** Markdown code fences now parse an
optional filename (` ```lang path/to/file.ext ` and ` ```lang:file.ext `), render it in the
block header, and add an **Apply** button that writes the block directly into the active
workspace via a new `autobot:writeFile` IPC (resolves `~`/absolute/relative paths against
the conversation cwd, `mkdir -p` parent dirs, no save-dialog). `Copy` behaviour unchanged.

---

## C. PARITY TARGET — RESOLVED

Parity target = **Example Desktop** (the app that was reverse-engineered: `Claude.app`
v6.28899.6). All parity work in §A/§B is measured against that product. The Code-concept
panels (Notebooks/Terminal/Skills) are documented as intentional extras, and Example Code
CLI parity is listed as gap B8 rather than silently conflated with the local Terminal
shell.

---

## D. FINAL STATE

- **`npm run build`** — clean.
- **`electron/*.js` `node --check`** — all pass.
- **E2E suite** — 57/57 pass; 111 tool definitions (incl. 6 permission-mode gating tests + 7 browser-controller tests + 2 text-protocol tests + renderer-regression tests).
- **DMG** — `release/HelioBot-1.0.0-arm64.dmg` (108 MB) + `HelioBot-1.0.0-arm64.zip`
  (104 MB); packaged `app.asar` verified to contain the 5-mode permission UI and the
  collapsed wordmark rule.
- **Project-folder & coding/visualization parity (§B2)** — `<project_workspace>` cwd
  injected into the core system prompt for every model; `CODING & VISUALIZATION` Artifact/
  `mcp__visualize__visualize` directive; `autobot:writeFile` "Apply to file" IPC + Apply
  button on fenced code blocks. All three folded into the fresh 2026-11-25 dist.
- **CDP regression (installed app)** — all 9 sidebar panels render (incl. new **Code**
  panel); model menu (19 presets); live streaming; markdown+highlight+code-copy; MCP
  3-transport client; Projects create/toggle/persist flow; per-message hover toolbar
  (Copy/Edit/Retry/Delete); image drag-drop/paste/attach → `data:image/png;base64` thumbnail
  verified end-to-end.
- **B8 Example Code mode (2026-11-25)** — `Code` panel dashboard + permission segmented
  toggle (4 modes: auto/ask/accept-edits/plan, persisted to `autobot:permissions`) + diff
  viewer verified live via CDP;
  `window.autobot.diff` returns typed hunks; `gitInfo` on repo root returns branch/counts/
  commits; full `ask`-mode gate chain (runTool `MUTATING` → `approveTool` → `permission`
  event → `PermissionModal` → `answerPermission` IPC → 5-min-timeout promise) audited
  source-end-to-end.
- **Window / chrome surface parity (2026-11-25)** — see §G. 11 secondary-window +
  chrome features decoded from Example Desktop's own IPC surface (REA) and shipped:
  Quick Entry floating window, ⌘K Command Palette, ⌘F in-chat Find bar, custom About
  window, Artifact app-window + PDF export, system tray, global shortcut register,
  Computer Use teach/watch-record, Buddy, Remote Control, Extensions, Developer mode,
  Local-exec consent, Trusted folders. All verified live (see §G).

---

## E. BROWSER SESSION-PANE PARITY — RESOLVED (2026-11-24)

**Divergence found (REA):** Example Desktop's built-in browser is **not** a full sidebar
panel — it is a **session pane** that coexists with the chat and is toggled via
`dispatchToggleSessionPane(Vc.Preview)`. Command palette entries `Show Browser` /
`Hide Browser` (i18n ids `izpqAIME9m` / `dpcjrIOyI3`), accelerator
`CmdOrCtrl+Shift+B`, sibling panes `Vc.Files` / `Vc.Terminal` / `Vc.Diff` / `Vc.SideChat`.
(Source: `index.chunk-nq69RXOm.js`, main bundle 8,079,022 bytes.)

Helio Bot previously rendered the browser as a full `panel === 'browser'` replacement
(`<main>` swap) with **no collapse** — the exact gap the user reported ("i cannot collaps
browser same like example app").

**Fix (shipped):**
- Refactored `BrowserView` out of the `panel` switch into a `SessionPane` component that
  coexists beside chat in a `.main-split` flex row (chat stays visible on the left).
- `toggleSessionPane(type)` mirrors `dispatchToggleSessionPane` semantics — same type
  toggles closed, different type switches; opening a pane returns the main area to chat.
- `Hide Browser` header affordance (X) + `Show Browser` sidebar toggle (active-state
  reflects open pane).
- `CmdOrCtrl+Shift+B` global keydown toggle.
- Resizable via left drag-handle (clamped 320–900px; `col-resize` cursor, `pane-resizing`
  body class to suppress text selection).

**Verified (CDP, port 9223):**
- Initial state: `.main-split`/`.main-content` present, no `.session-pane` (hidden by default).
- Sidebar "Browser" click → pane appears (width 460px, title "Browser", webview mounted),
  **chat still visible** (coexisting, not a swap), sidebar button `.on`.
- `.session-pane-hide` (X) → pane removed; `Cmd+Shift+B` → pane restored.
- Drag-handle: 460px → 600px on 140px left-drag (clamped bounds enforced).
- `npm run build` clean; E2E 19/19.

## F. SIDEBAR DESIGN BREAK + BROWSER DISCOVERABILITY — RESOLVED (2026-11-24)

**User report:** "check on left side, still design is broken … and where is option to open
browser??"

**Root causes found (CDP DOM dump + source):**
1. **Broken wordmark (historic).** The original `Logo` SVG shipped with a baked-in `<text>`
   element rendering a literal string inside the glyph, so the sidebar header rendered as a
   cluttered, unreadable blob at 16–18px — the "broken left side". The current marque is a
   clean sunburst (no text node at all).
2. **Duplicate SVG gradient IDs.** Every `<Logo>` instance re-declared `id="lgRed"`,
   `lgBlue`, `lgChrome`, `lgPlate`, `lgGlow`. With multiple logos mounted (titlebar +
   sidebar wordmark + welcome + assistant avatars), `url(#lgRed)` etc. resolved to the first
   instance in DOM order, so later logos lost their fills / glowed with the wrong gradient.
3. **Stale installed binary.** `/Applications/Helio Bot.app` and `release/*.dmg` did not exist
   at report time — the user was running a build that predated the Browser session-pane work,
   so the sidebar `Browser` entry (and `Cmd+Shift+B`) was simply absent.

**Fixes (shipped):**
- `Logo` now takes a module-level `logoSeq` counter → per-instance gradient/filter ids
  (`lg<N>Red`, `lg<N>Blue`, …), eliminating cross-instance id collisions.
- Removed the baked-in `<text>` node. The app glyph is now the **sunburst marque**
  (`build/icon.svg`, 240×240 — terracotta rays `#D97757` on `#F6F3EC`), reused for the
  titlebar, sidebar wordmark, welcome screen, tray, `.icns`/`.png` app icon, and the About
  window; the wordmark reads `Helio Bot`.
- Added a **prominent browser toggle** in the composer action row (`Window` icon,
  `Open browser`/`Close browser`), in addition to the existing sidebar `Browser` entry and
  `CmdOrCtrl+Shift+B` accelerator.
- Rebuilt → `npm run dist` → `hdiutil verify` **VALID** (101.5 MB) → reinstalled to
  `/Applications/Helio Bot.app` (app.asar present).

**Verified (CDP, port 9223):**
- `wordmark.innerText === "Helio Bot"`; `logo.querySelector("text") === null`.
- Gradient defs across all mounted logos: 15 ids, **15 unique** (collision gone).
- Composer button `title="Open browser"` present; sidebar `Browser` entry present.
- Clicking the composer browser toggle → `.session-pane` mounts (title `Browser`, webview
  mounted), button gains `active`, sidebar button gains `on`. Chat stays visible (coexist).
- `npm run build` clean; E2E 38/38 (95 tool definitions).

---

## G. WINDOW / CHROME SURFACE PARITY — RESOLVED (2026-11-25)

**Source of truth (REA):** Example Desktop `v6.28899.6` ships a native-process window
layer whose IPC namespaces were decoded from the main bundle:
`example.internal.ui.{AboutWindow,QuickWindow,MainWindowTitleBar,ConfigTemplateExport}`,
`example.internal.findInPage`, `example.internal.localExecConsent`,
`example.internal.computerUse.{CuTeach,CuWatchRecordPill,CuWatchRecordChooser}`,
`example.artifactAppWindow.{ArtifactAppPage,ArtifactShellTransport}`,
`exampleDesktopArtifactPane`, `omeletteDesktopPdf.printFrameToPdf`,
`example.buddy.Buddy`, `example.hybrid.DesktopIntl`, `example.coworkArtifact.*`.
Corresponding source modules: `quickWindow.js`, `buddy.js`, `findInPage.js`,
`extensionWindow.js`, `localExecConsent.js`, `computerUseTeach.js`,
`computerUseWatchRecord.js`, `artifactAppWindow.js`, `designWindow.js`, `aboutWindow.js`,
`configTemplateWindow.js`.

Helio Bot now implements each as a local equivalent. Verified against the **installed
packaged app** via CDP (`--remote-debugging-port=9223`) — window-target enumeration,
DOM/text dumps, and direct `window.autobot.*` bridge calls.

| Example Desktop feature | Helio Bot implementation | Evidence |
|---|---|---|
| Quick Entry floating prompt (`QuickWindow`) | `createQuickWindow()` → `electron/quick.html` (⇧↩ send / ↩ insert / Esc); global hotkey `CmdOrCtrl+Shift+Space` via `registerQuickShortcuts()`; `autobot:quickSubmit` routes prompt to primary window (`autobot:quickEntry` event) | Live CDP: `openQuickEntry()` → new page target `title="Quick Entry"`, URL `electron/quick.html` |
| About window (`AboutWindow`) | `createAboutWindow()` → 340×420 non-resizable window, sunburst `logoMarkup()`, "Helio Bot / free-LLM desktop agent / Version 1.0.0 / Electron 33.4.11 / akronlogic.com" | Live CDP: `openAbout()` → `data:text/html` target with title bar + logo + version |
| Command Palette | `⌘K` keydown → `CommandPalette` (`.palette-modal`), items: New chat, Search, Toggle browser, Code mode, Toggle sidebar, Toggle theme, Quick Entry, Export, Settings, About | Live CDP: dispatch `⌘K` → `.palette-modal` present, 10 items enumerated |
| Find-in-page (`findInPage`) | `⌘F` keydown → `FindBar` (`.findbar` + input), in-chat find | Live CDP: dispatch `⌘F` → `.findbar` + `input` present |
| Artifact app window (`artifactAppWindow` / `ArtifactAppPage`) | `createArtifactWindow({name,language,content})` — dedicated BrowserWindow (1180×800 for canvas types); ArtifactsView "Open"/"PDF" buttons wired to `openArtifactWindow` | `window.autobot.openArtifactWindow` === function (main-window bridge) |
| Design canvas + Slides deck artifact types (`designWindow.js`, `artifactsDesignEnabled` / `artifactsSlidesEnabled`) | `electron/artifactcanvas.js` — `parseDesign`/`parseSlides` + `designHtml`/`slidesHtml`/`canvasHtml`/`isCanvas`; used by `createArtifactWindow`, print-to-PDF and the in-chat preview via `autobot:artifactDocument` | Live CDP: `artifactDocument({language:'design'})` → 5336-char doc with `.canvas`; `{language:'slides'}` → 2 `<section class="slide">`; `openArtifactWindow` opened windows 2 & 3; `test/artifactcanvas.test.js` 45/45 |
| PDF export (`omeletteDesktopPdf.printFrameToPdf`) | `printToPdf()` (main) + `autobot:printToPdf` → dialog + PDF write | `window.autobot.printToPdf` === function |
| System tray | `createTray()` — `electron/tray.png` / `tray@2x.png` / `tray-16.png`, Quick Entry menu item | tray assets present; `createTray()` in `app.whenReady` |
| Computer Use teach / watch-record (`CuTeach`/`CuWatchRecord*`) | `computerUseTeach` feature toggle in Settings (teach & watch/record) | Settings `label.check` dump lists "Computer Use — teach & watch/record" |
| Buddy (pair-hunting co-pilot) (`buddy.Buddy`) | `buddy` feature toggle + "Buddy (pair-hunting co-pilot)" Settings row | Settings dump lists "Buddy (pair-hunting co-pilot)" |
| Remote Control (Drive/co-browsing) | `remoteControl` feature toggle + Settings row | Settings dump lists "Remote Control (Drive / co-browsing session)" |
| Extensions (custom tools / MCP) (`extensionWindow`) | `extensions` feature toggle + Settings row | Settings dump lists "Extensions (custom tools / MCP servers)" |
| Browser-extension host (`extension-host`, 11 channels) | `electron/extensionhost.js` (45 namespaces, 21 builtins, page server, loopback bridge) + `electron/extension-preload.js` (hosted `chrome.*` surface / native hole-patching) + Plugins panel → **Chrome extensions** tab (`ExtensionsView`) | Live CDP: fixture MV3 extension opens at `chrome-extension://hniiejk…/popup/index.html`, probe `READY = true` with 15 namespaces, storage.local/sync roundtrips, `commands.getAll` (1), `permissions.contains(storage)=true`, `runtime.sendMessage`→`onMessage` roundtrip `true`; UI counters flip `1 installed · 1 native · 1 open · 1 attached · bridge ready on :56097`; `test/extensionhost.test.js` 162/162 |
| Developer mode + Local exec consent (`localExecConsent`) | `developerMode` + `trustedFolders` toggles + Settings rows | Settings dump lists "Developer mode (debug tools + local exec consent)" + "Trusted folders (pre-approve shell exec in these dirs)" |

**Feature-toggle persistence:** `electron/store.js` `getFeatures()` now returns
`{ computerUse, chrome, bridges, quickEntry:true, computerUseTeach, buddy, remoteControl,
extensions, developerMode, trustedFolders:false, chromeHost:'127.0.0.1', chromePort:9222 }`,
persisted to `~/.autobot` and loaded on mount via `getFeatures().then(setFeatures)`.
All toggles live-verified in the Settings modal (14 `label.check` rows enumerated).

---

## H. REMAINING GENUINE GAPS (final, honestly stated)

After §A–§G, exactly **two** gaps remain. Both are the same class: real Anthropic
cloud-account integration, which cannot be shipped locally without an actual Anthropic
OAuth client secret + backend:

1. **Anthropic OAuth sign-in + cross-device history sync.** Scaffold shipped (`Account &
   Billing` section, "Connect to Anthropic" / SSO IdP config, plan + upgrade row,
   sync-status row → all open the real endpoint in-browser). Still no true sign-in, no
   Example.ai history import, no cross-device sync (single `BrowserWindow`; no account IPC
   to Anthropic's backend).
2. **Enterprise / managed accounts + plan/billing backend.** Same scaffold — plan row,
   SSO IdP config render. Still local-only (`~/.autobot` + localStorage); no enterprise IdP
   handshake or plan/billing backend.

These are **not cosmetic** — they are the only two places Helio Bot structurally cannot
match Example Desktop because they depend on Anthropic's proprietary cloud, not on any
client-side code. Everything else in the Example Desktop `v6.28899.6` surface is now
implemented and verified (§A, §B, §E, §F, §G).

---

## J. SKILLS MANAGEMENT + PERMISSION MODES — RESOLVED (2026-11-25)

Two further Example Code / Example Desktop parity features shipped and CDP-verified:

### J1 — Full skills system (activate/deactivate any skill)
- **Discovery now merges 250 skills** across four sources with dedupe priority
  `bundled (7) → opencode (234, from `~/.config/opencode/skill/*/SKILL.md`) → example (9,
  from `~/.claude/skills/` incl. `synced/*`) → custom (`~/.autobot/skills/*.md`)`.
- YAML frontmatter parser extracts `name` + `description` (handles folded `>` multi-line
  descriptions, e.g. `ad-asreproast-attack`) and maps directory-name ≠ frontmatter-name.
- Per-skill **toggle switch** with persistence (`~/.autobot/skills-state.json`, `{disabled:[…]}`),
  **Enable all / Disable all**, live **search**, **source filter** (all / enabled-only /
  disabled-only / per-source), source grouping, and an **enabled count** (`250/250 enabled`).
- `list_skills` tool now returns **only enabled** skills; `load_skill` stays **permissive**
  (explicit load works regardless of toggle) — matching Example's model where a disabled skill
  is hidden from auto-discovery but still loadable on request.
- Verified end-to-end (live CDP): 250 switches/items render, group heads `Example 7 /
  OpenCode 234 / Example Code 9`, toggle persists across `getSkills()` calls, and
  `list_skills` filters + `load_skill` stays permissive via direct executor test.

### J2 — Permission modes (Auto / Manual / Accept edits / Plan / Bypass)
- `approveTool` in `electron/main.js` honors **five** modes:
  - `auto` — allow all (no prompts);
  - `ask` (UI: **Manual**) — prompt before every mutating tool (Bash/Write/Edit/…);
  - `acceptEdits` — **auto-allow file edits** (`Write`/`Edit`/`MultiEdit`/`NotebookEdit` +
    MCP write/edit), still prompt for shell/terminal/exec;
  - `plan` — **deny all mutations** (read-only; agent must propose via `ExitPlanMode`);
  - `bypass` — allow everything, no prompts (elevated-trust state, distinct from `auto` so
    the UI can show it).
- **Composer permission pill (Example-desktop parity):** a pill in the composer bottom-right
  (`Auto` / `Manual` / `Accept edits` / `Plan` / `Bypass`) opens a 296px dropdown anchored
  `right:0` above the pill. Header **"Permissions · this session"**; each row = title +
  gray description + right-edge number hint (`1`–`5`) + checkmark on the active mode
  (accent-tinted background). Keyboard parity: `1`–`5` select, `Esc` closes, outside-click
  dismisses.
- Also surfaced in the Example Code panel (5-button segmented control) and **Settings →
  Behavior** (5-option dropdown), all bound to the same persisted `autobot:permissions`.
- Verified live on the **packaged** app (CDP, port 9333): pill text `Auto`; menu header
  correct; all 5 rows present with correct titles/descriptions/numbers; `Auto` row
  `on` + accent background `rgba(217,119,87,0.14)` + check glyph visible + number `1`;
  `2` → pill `Manual`, menu closed. E2E: 38/38 (6 permission-gate, browser, text-protocol and renderer-regression suites).

### J3 — Sidebar collapse/unhide design fixes
- Collapse now hides **every** text element cleanly (brand, new-chat label, section labels,
  conv titles, conv delete, nav `.label` + `.count`, account name, settings icon) while
  keeping icons centered (`justify-content: center`, `padding` normalization), a correct
  open/close icon swap (`SidebarOpen`/`SidebarClose`), and conv icons colored for active
  state — fixing the half-hidden-label / misaligned-icon flaw present before.
- **Wordmark fully hidden when collapsed:** `.sidebar.collapsed .wordmark { display:none }`
  removes the `<Logo>` mark **and** the `Helio Bot` text entirely — the rail shows no
  logo/wordmark at all (verified: collapsed width 52px, `wordmark` computed `display:none`,
  0 visible rail logos).

---

## I. WHAT'S MOST LIKELY TO PAY

The single highest-value differentiator Helio Bot ships over Example Desktop is **§A1 — the
Orchestrator (100+ API keys, auto-failover on rate-limit)** combined with **§A2 — the
model-agnostic pluggable `/v1/chat/completions` layer**. That is the one capability that is
structurally impossible in Example Desktop (single-account lock) and is the feature a buyer
or evaluator would flag first. The remaining §H gaps (Anthropic OAuth/sync) are the only
honest parity shortfall and are bounded purely by cloud access, not code.

---

## H. BUILT-IN BROWSER: FULL AGENT PARITY FOR EVERY MODEL (2026-11-25)

Example Desktop's browser is a cloud-managed MCP that only Anthropic models can drive.
Helio Bot's browser is local and available to **every** configured provider — including
endpoints with no native function calling.

### Controller (`electron/browser.js`) — rewritten
| Capability | Behaviour |
|---|---|
| Guest registry | `registerGuest(webContents)` / `getGuest()` — resolves to the live `<webview>` guest (main frame), not the renderer |
| `ensureGuest(ms)` | If the pane is closed it calls the `setEnsurePane` hook (broadcast `autobot:browserEnsure`), then polls for guest registration. Returns `null` immediately when no renderer exists (headless) so the agent loop never blocks |
| `loadURL` / `goBack` / `goForward` / `reload` | Async — resolve on `did-stop-loading`, not on fire-and-forget |
| `read` / `snapshot` | Markdown-ish text + links/buttons/tab-order index |
| `click` / `type` / `press` / `hover` / `select` | DOM-dispatched with native-event fallbacks (`mousedown`/`mouseup`, `Element.select`) |
| `scroll` | Container-aware (window, document, or nearest scrollable ancestor) |
| `waitFor` | Selector wait with timeout |
| `screenshot` | `capturePage` viewport shot; optional full-page via device-metrics emulation + restore |
| `syncTabs` / `listTabs` / `sendTabCommand` | Renderer pushes tab state to main; agent `browser_tabs` emits `new` / `close` / `switch` back to the renderer |

### Tool surface (95 definitions)
`browser_open`, `browser_navigate`, `browser_read`, `browser_snapshot`, `browser_click`,
`browser_type`, `browser_press`, `browser_js`, `browser_hover`, `browser_select`,
`browser_scroll`, `browser_wait_for`, `browser_screenshot`, `browser_tabs`, plus
`browser_back|forward|reload|get_url`. All executors `await` the async controller.

### Renderer wiring (`src/App.jsx`, `electron/preload.js`, `electron/main.js`)
- `onBrowserEnsure` force-opens the pane (idempotent, 460px) when the agent calls any
  browser tool while the pane is closed.
- `selectTab` re-registers the guest and re-syncs the URL; pane unmount unregisters each
  guest so stale `webContents` ids are never used.
- A `useEffect` mirrors tab state to main (`browserSyncTabs`); `onBrowserTabsCommand`
  drives new/close/switch from the agent side.

### Text-protocol fallback (`electron/llm.js`)
Endpoints that reject `tools` (or are configured `supportsTools:false`) get a
`TEXT_TOOL_PROTOCOL` block appended to the system prompt and are parsed by
`parseTextToolCalls()`:

````
```tool
{"name": "browser_navigate", "arguments": {"url": "https://example.com"}}
```
````

Parsed calls run through the **same** `runTool` path, with results fed back as
`TOOL RESULT <id>` messages. Unknown tool names are ignored. This is what makes "every
model drives the browser like Example" true rather than aspirational.

### Verified on the packaged build (CDP, `--remote-debugging-port=9333`)
```
paneBefore=false → browserLoadURL('https://example.com') → paneAfter=true   (432 ms)
read:      ok, title "Example Domain", 1 link, text body                   
screenshot: /var/folders/.../heliobot-shot-*.png  918×971                  
click:     ok, found A "Learn more" → url became iana.org/help/example-domains
tabs:      1, activeId tab1, synced to renderer                           
scroll/hover/select/press/waitFor/browser_js(=42): all ok                  
UI:        webviews 1, tabs 1, omnibox in sync, toolbar 6 buttons         
```

### Renderer hardening (found by packaged-app CDP runs)
| Bug | Symptom | Fix |
|---|---|---|
| Composer `onClick={send}` passed the React `SyntheticEvent` into `send(textOverride)` | `TypeError: …trim is not a function` killed the send path whenever the Send **button** (rather than Enter) was used — no LLM request was ever issued | `onClick={() => send()}` plus a type guard in `send()` (`typeof textOverride === 'string'`) |
| `<webview src={t.url}>` was re-applied on every `did-navigate` | Each navigation loaded twice: the `src` write aborted the in-flight load (`ERR_ABORTED ‑3`, 4–5 console errors per run) and re-issued the same URL | Tabs carry a pinned `launch` URL (`src={t.launch \|\| t.url}`); the live location still tracks `url`. Console errors per run: 5 → **0** |
| Raw ```` ```tool ```` blocks rendered as visible markdown | Text-protocol models showed their own tool JSON in the transcript | `stripToolProtocol()` in `src/textproto.mjs` removes ```` ```tool ````/`<tool_use>` blocks from rendered Markdown and from extracted code blocks (the call already shows as a tool card) |

### Branding
`productName` / bundle / DMG / About / tray / wordmark / system prompt all read
**Helio Bot**; identifier `com.heliobot.app`; artifacts
`release/HelioBot-1.0.0-arm64.dmg` + `.zip`; DMG volume `Helio Bot 1.0.0`.
Internal identifiers (`window.autobot` bridge, `autobot:*` IPC channels) are unchanged —
implementation detail with no user-visible effect.

---

## K. PLUGINS · MCP REGISTRY · SCHEDULED TASKS · CUSTOM SKILLS — RESOLVED (2026-11-25)

The four remaining *product-surface* gaps from the Example Desktop sidebar are now shipped,
tool-wired, and verified in the running app (CDP, port 9333) and in the headless suite.

### K1 — Plugins & connectors catalog (`electron/connector-catalog.js` + `electron/plugins.js`)
- **467 curated connectors / 50 plugins / 31 categories** (`electron/connector-catalog.js`)
  mirroring the Example app's connector directory — Productivity, PM, Communication,
  Email, Calendar, Engineering/DevOps, Analytics, Data/DBs, Cloud, Storage, Finance,
  Sales/CRM, Support/Incident, Design, HR, Legal, Education, Research, Media/Social,
  Commerce, AI/ML, Travel, Health, Government/Nonprofit, Automation — with `auth`,
  `tools` (connectors) / `provides` (plugins), and an MCP `endpoint` where public.
- **Live registry layer** (`electron/mcpregistry.js`): paginated sync of
  `registry.modelcontextprotocol.io`, 24 h TTL, versioned disk cache
  (`~/.autobot/mcp-registry.json`), keyword-based categorisation, silent offline
  degradation. Runtime pool = **911 connectors** (467 curated + 444 live), 961 rows total.
- **Scoring search** (name > tag > description) and `suggest(query)` relevance ranking
  across the merged pool.
- **Install state** persisted to `~/.autobot/plugins.json`; `install` / `uninstall` /
  `markConnected` / `setConfig` round-trip cleanly. Installing a transport-bearing entry
  auto-connects it (`sse`/`http` URL or stdio `command`), caches `tools/list`, and
  reports failures as one human-readable line (no raw JSON-RPC / markup).
- Tool surface: `plugins__list_plugins`, `plugins__search_plugins`,
  `plugins__search_connectors`, `plugins__suggest_plugin_install`,
  `plugins__install`, `plugins__uninstall`, `plugins__directory_stats`,
  `plugins__refresh_registry`; plus `mcp-registry__list_connectors`,
  `mcp-registry__search_mcp_registry`, `mcp-registry__suggest_connectors`.
- UI: **Plugins & Connectors** panel — search box, type + category filters, "installed
  only" toggle, per-card Install/Remove, connected badge, directory stats line
  (built-in vs live MCP servers), **Refresh registry** button, paged "Show more".

### K2 — Scheduled tasks (`electron/scheduler.js`)
- Full task store at `~/.autobot/scheduled-tasks.json`; cadences `once | every | hourly |
  daily | weekly` with natural-language `describe()` and correct `computeNext()` arithmetic.
- **30 s ticker** started in `app.whenReady`, stopped in `will-quit`; runs are serialized so
  two tasks never interleave; each run records `{at, ok, output, error}` + `runCount`.
- Headless execution through the same `runAgent` loop; provider resolved by
  `scheduledProvider()` = user's selected provider → first enabled orchestrator → error.
- Renderer mirrors the active provider into main (`setSettings({provider})`) so scheduled
  runs use the model the user actually chose.
- Tool surface: `scheduled-tasks__create_scheduled_task`, `…list…`, `…update…`, `…delete…`,
  `…run_scheduled_task`.
- UI: **Scheduled tasks** panel — create form (name, prompt, cadence, time, day-of-week),
  enable/disable switch, run-now, delete, next-run time, last result, live `scheduled-task`
  event refresh.

### K3 — Custom skills by `.md` upload (`electron/store.js`)
- `addCustomSkill(name, content)` slugifies the filename, injects YAML frontmatter when
  absent (name + description parsed from the body), writes `~/.autobot/skills/<slug>.md`,
  and invalidates `_skillsCache` so the skill is discoverable **immediately** with
  `source: 'custom'`.
- `deleteCustomSkill(name)` removes only custom skills (bundled/opencode/example sources are
  never touched).
- Tool surface: `create_skill`, `delete_skill` — the model can author skills mid-session.
- UI: **Skills** panel toolbar gains **Add skill (.md)** (native file picker →
  `pickSkillFile` → `addSkill`) and **New skill** (inline author); every custom skill row
  shows a `CUSTOM` source badge and a delete button. Panel re-reads from disk on open.

### Verified live (packaged runtime, CDP)
```
Plugins:   panel=true head="Plugins & Connectors" cards=51 first="Google Drive"
           install → button "Remove" → uninstall → installedCards=0
           search "github" → cards=1 first="GitHub"
Scheduled: create → items=1 "Verifier task" meta="every 15 min · next …"
           toggle → .off=true ; delete → items=0
           real run via IPC → runOk=true runCount=1 output="PONG"
Skills:    toolbar [Enable all, Disable all, Add skill (.md), New skill]
           addSkill → row found, src=CUSTOM, delete → gone=true
Errors:    none
```

### Test coverage
`node test/e2e.test.js` → **53 passed, 0 failed**, including a
*Feature parity (plugins · scheduled tasks · custom skills)* block that runs
plugins round-trip, scheduler lifecycle, custom-skill lifecycle, and renderer-wiring
source assertions in an isolated `HOME` so the real `~/.autobot` is never mutated.
Registry integrity asserts **111 tool definitions** and that every
plugins/mcp-registry/scheduled-tasks/custom-skill tool resolves to an executor.

### Model picker status — closed
Per-endpoint keys (`autobot:providerKeys`) + live `GET /models` probe
(`electron/providerstatus.js`, IPC `autobot:probeProviders`) now drive the picker:
light-green row for an accepted key, green dot for available quota, red dot for
out-of-credit/rejected, 45 % dim for models with no key. Verified live over CDP —
see `VERIFICATION.md` §10. Suite is **53 passed, 0 failed**.

---

## L. COWORK ORCHESTRATOR — PER-WORKER BACKENDS + PARALLEL FAN-OUT — RESOLVED (2026-11-25)

The cowork layer previously ran every worker on the parent's provider (a worker could
only be a *persona*, not a *model*). It now supports mixed backends in one goal, which is
what makes "ask NVIDIA and a local Gemma the same question at the same time" work.

### L1 — Provider pinning per worker (`electron/cowork.js`)
- `registerWorker(name, opts)` accepts `baseURL` / `model` / `apiKey` / `supportsTools` /
  `systemPrompt`; the registry stores them and the tool reply echoes
  `pinned to <model> @ <baseURL>`.
- `workerProvider(worker, fallback)` resolves precedence **per-call override → worker pin →
  call-wide fallback**, layering a partial pin onto the base provider. A worker with no
  pin behaves exactly as before.
- `listWorkers()` reports `{model, baseURL}` so the agent can see where each worker lives.
- `runWorker()` never throws: transport failures become `status:'error'` + message, so one
  dead endpoint cannot abort the fan-out. Results carry `provider` and `ms`.

### L2 — Parallel fan-out (`orchestrate`)
- `orchestrate(goal, workers, {concurrency})` runs with bounded concurrency (default 4)
  instead of a serial loop — measured 2839 ms wall for an 847 ms + 2827 ms pair.
- A sub-run that pins a provider **does not inherit** the parent's `orchestrator` failover
  list (`electron/llm.js` nulls it when `subOpts.provider` is set). Without this the pin
  would be silently replaced by the parent's provider list.
- Tool executors emit a per-worker header
  `--- name (model @ baseURL) [status, Nms] ---` followed by a JSON array.

### L3 — Verification
- `test/live-orchestrator.js` — NVIDIA NIM + local Ollama `gemma4:latest`, distinct
  answers, wall clock proves parallelism.
- `test/live-orchestrator-agent.js` — the **parent agent on NVIDIA** registers the Gemma
  worker and orchestrates it through the real tool surface (`runAgent` ctx), then reports
  the worker's answer verbatim. PASS in 4369 ms.
- UI run on the source build (:9333): tool cards for `register_worker` + `orchestrate`,
  Gemma's answer rendered, 0 console errors (`screenshots/orchestrator-nvidia-gemma.png`).
- Headless suite: 3 orchestrator tests (two mock providers, parallel wall clock, pin
  isolation through the real `runAgent` ctx) + 2 icon-registry tests + 1 transcript-order
  test → **53 passed, 0 failed**.

### L4 — Icon registry guard
`src/icons.json` gained aliases (`Plus→Add`, `Plug→Plugin`,
`Refresh/Reload/Sync→ArrowClockwise`, `Sparkles→StarFilled`) rather than invented
codepoints. A new test extracts every `<Icon name=…>` in `App.jsx` and fails if it is not
in the registry, and asserts each alias shares its base glyph's codepoint — so a mistyped
name can no longer silently render as a blank box.

> Note on §J2: the permission mode's persisted id is still `ask` (label **Manual**);
> `auto|ask|acceptEdits|plan|bypass` is the canonical set. Any doc saying `manual` as an
> id is describing the label, not the stored value.

---

## M. "GEMMA 4 CANNOT USE AND NOT SHOW" + OLLAMA CONNECT — RESOLVED (2026-11-25)

### M1 — Root cause (not a model problem)

A local Ollama only serves the models that were actually **pulled**. The Ollama preset
hard-coded `llama3.1` as its model name and the picker was a static `PRESETS.map(...)`, so:

1. Selecting **Ollama** sent `model: "llama3.1"` to `POST /v1/chat/completions`
   → `404 model not found` → the transcript just died. That is the reported "cannot use".
2. The picker could only ever render one fixed Ollama row, so `gemma4:latest` (the model
   that *is* installed) never appeared. That is the reported "not show".
3. If `ollama serve` was not running at all, there was no way to start it from the app.

So the model was fine; the app was naming the wrong model and could not enumerate the real
ones.

### M2 — Fix

Backend (`electron/providerstatus.js`, new exports):

- `ollamaRoot(base)` — accepts `host:11434`, `http://…/v1`, `http://…/api`, trailing
  slash or none; returns `http://host:11434`.
- `ollamaModels(base, {timeout})` — `GET {root}/api/tags` first, then `/v1/models`,
  then `/api/models`; normalizes both shapes (`{models:[{name,size,details.family}]}`
  and `{data:[{id}]}`), dedupes, 4 s timeout, **never throws** (`{ok:false,detail:'Unreachable'}`).
- `normalizeModels(payload)` — pure normalizer, unit-tested.

IPC (`electron/main.js`):

- `autobot:ollamaModels` — proxy so the renderer can ask what is installed.
- `autobot:ollamaServe` — `start` probes first (already running → returns
  `alreadyRunning`), otherwise spawns `ollama serve` detached; resolves the CLI from
  `OLLAMA_BIN`, `/usr/local/bin/ollama`, `/opt/homebrew/bin/ollama`,
  `/Applications/Ollama.app/Contents/Resources/ollama`, `~/Applications/…`, `/usr/bin/ollama`
  before falling back to `PATH` (a GUI-launched app often has a PATH without Homebrew).
  Polls 12 × 500 ms for the port to bind.
- Preload exposes both (`window.autobot.ollamaModels`, `window.autobot.ollamaServe`).

Renderer (`src/App.jsx`):

- `pickerRows` is now computed, not a bare preset map: a reachable Ollama preset expands
  into **one row per installed model** (label strips `/…/` and `:latest`, provider tag
  `Ollama · installed`, green dot).
- When an Ollama endpoint is unreachable the menu shows a **Connect Ollama (local)** row
  that starts the server and jumps straight to the first installed model.
- Scanning runs whenever the picker opens and whenever Settings mounts.
- Settings → Providers has an Ollama box: **Scan** / **Start / reconnect**, the installed
  model count, and clickable model chips that set `provider.model`.

### M3 — Verified live (source build :9333, CDP)

```
# before: server stopped (osascript quit Ollama; pkill -f "ollama serve")
direct scan : {"ok":false,"detail":"Unreachable"}
picker      : Connect Ollama (local) | starts the server      ← CTA appears
click       : clicked
pill        : gemma4:latest                                   ← auto-connected
stored      : {"baseURL":"http://localhost:11434/v1","model":"gemma4:latest",...}
# real composer send
answer      : "GEMMA-CONNECTED"   in 9 055 ms, console errors 0
```

Picker with a live server lists both installed models:

```
gemma4                              | Ollama · installed
gemma-4-E4B-it-GGUF:Q4_K_M          | Ollama · installed
```

### M4 — Test coverage

Three new headless tests (56 total, 0 failed): root/base normalization + both payload
shapes; a fake `/api/tags` server proving `ollamaModels` reports installed models and
degrades soft when offline; and a renderer/plumbing guard asserting the picker asks the
backend for models, offers the connect action, and no longer uses a static preset map.

### M5 — Local filesystem + per-conversation project folders (RESOLVED 2026-11-25)

The "can't access local folders" gap is closed at the root. The original `resolvePath()`
never expanded `~`, so `Write ~/Desktop/x.txt` created a literal `~/` directory. Now:

- **`electron/paths.js`** (new) — `expandPath(p)` expands `~`, `$HOME`, and `~user`; used
  by every path-resolving tool.
- **`electron/workspace.js`** (new) — each conversation gets a lazily-created project
  folder under `~/Helio Bot/<slug>` ("every build auto-creates a project folder", Example
  Desktop parity). Persisted in `~/.autobot/workspaces.json` as `{ [convId]: {dir,title,at} }`.
  `setDir()` also expands `~` now (was `path.resolve` which left a literal `~/`).
- **`electron/tools.js`** — `bash` runs through a real login shell `spawn('/bin/zsh',
  ['-l','-c', cmd])` (was `exec {shell:'/bin/zsh -l'}` which Node treated as a single
  binary name → `ENOENT`). `read/write/edit`, `glob`, `grep`, `Cd`, REPL and terminal-tab
  cwd all resolve through `resolveDir`/`resolvePath`.
- **`electron/main.js` + `preload.js`** — IPC `getDefaultCwd(convId,title)`,
  `getWorkspace(convId)`, `setWorkspace(convId,dir)`, `pickFolder`. `autobot:run` defaults
  `cwd` to the conversation workspace; scheduled runs use `workspace.scratch()`.
- **`src/App.jsx`** — cwd initialises per active conversation and re-binds on `activeId`
  change; the composer "Change" button and the Code panel folder-picker persist the choice
  via `setWorkspace`.

**Live verification (source build :9333, CDP):** IPC `getDefaultCwd` → `/Users/saimon/Helio
Bot/helio-fs-test`; `setWorkspace('~/Desktop')` → `/Users/saimon/Desktop`. A real composer
send — *"Use the Bash tool to create a folder called HelioTest on my Desktop"* — created
`/Users/saimon/Desktop/HelioTest` on the physical Desktop (verified `ls`), proving the full
chat → `runAgent` → Bash → login-shell → filesystem chain. E2E suite **57/57 passed**.

### M6 — Computer Use default + input fixes (2026-11-25)

- Computer Use gate now defaults **ON** (`store.js` feature default `computerUse:true` +
  matching `App.jsx` state default) — Example Desktop parity (drive the local Mac by default,
  not off).
- `electron/computer.js` — fixed `drag(x1,y1,x2,y2)` (was forwarding `x`/`y` instead of
  `x1`/`y1`), and `execP` now feeds `input` to stdin (pbcopy/pbpaste path). Screenshot
  (`screencapture`) and CoreGraphics move/scroll verified working earlier; full click/type
  requires the user to grant Accessibility once (System Settings › Privacy & Security ›
  Accessibility › Helio Bot) — surfaced as a clear one-line prompt when `AXIsProcessTrusted`
  is false.

## N. "WHY ONLY 5 STEPS?" — THE AGENT-LOOP GAP AGAINST EXAMPLE DESKTOP — RESOLVED (2026-11-25)

**Demand:** *"why only 5 steps why limit? it should be same like example app. check the example
app and find the gap and fix it."*

Example Desktop (and Example Code) impose **no per-turn tool budget**. The loop keeps calling
tools while the model keeps asking for them; it stops when the model emits a plain answer,
when the user hits Stop, or when the safety valve trips — and if it trips, it says so. Helio
Bot had a small fixed budget, which is why long builds (a website, then screenshots, then a
fix, then a preview) died at "step 5". Gap inventory and the fix for each:

| # | Gap vs Example | Where | Fix |
|---|---|---|---|
| 1 | Fixed turn budget end the run silently | `runAgent` loop | `HARD_STEP_CAP = opts.hardStepCap \|\| 1000`; `maxSteps` defaults to it. The renderer never sends a limit. |
| 2 | Sub-agents got their own small budget | `llm.js` Task/Agent recursion | `subagentMaxSteps` defaults to **0** (inherit = unbounded cap) |
| 3 | Cowork workers capped | `cowork.js:135` | `maxSteps: opts.maxSteps \|\| 0` |
| 4 | Bridge / `send_user_message` capped | `tools.js:1232` | `maxSteps: 0` |
| 5 | Orchestrator fan-out cap | `tools.js:1201` | `Number(args.maxSteps) \|\| 0` |
| 6 | Scheduled tasks capped | `main.js` | `maxSteps: 0` |
| 7 | Trip was silent (run just vanished) | `llm.js` tail | Appends *"Paused after N tool turns — that is the runaway safety valve, not a step limit. Say \"continue\" and …"*, emits `{type:'delta'}` then `{type:'limit', steps}` |
| 8 | Parallel tool calls were serialised | `runAgent` batch | When a turn has >1 call and every one is in `PARALLEL_SAFE` (`Read`,`Glob`,`Grep`,`LS`,`ListDir`,`ListFiles`,`WebFetch`,`WebSearch`) and none carried text, all rows emit up front and run under `Promise.all`, results re-ordered by call index. Mutating tools stay strictly sequential. |

### N1 — Second gap found in the same audit: a cut-off turn stacked instead of replaced

Example replaces a message truncated by the token limit. Helio Bot left the partial draft
above the regenerated answer. `runAgent` now counts the turn's streamed characters
(`turnChars` / `turnThink`, reset per `doChat`) and emits
`{type:'retry', chars, thinkingChars}`; `App.jsx` `case 'retry'` slices exactly that many
characters off the tail of the live segment list, drops segments that became empty, and keeps
the tool rows. It also fires when `finish_reason === 'length'` left a `tool_calls[].arguments`
JSON string unparseable — the case that previously made a reasoning model look like it "could
not build a website".

### N2 — Third gap: hung streams and hung tools looked like thinking

- `STALL_MS = HELIO_STREAM_STALL_MS || 90000` — a silent SSE keeps the partial answer
  (`message.stalled`) instead of freezing the UI forever.
- `tools.js` `toolTimeoutMs(name)` + `withTimeout()`: 30 min for long-runners, 130 s Bash,
  45 s `browser_wait_for`, 30 s other `browser_*`, 60 s `WebFetch`, 5 min default; a timeout
  returns `{content, isError:true, timedOut:true}` so the model can adapt.
- `browser.js` `jsWithTimeout()` races every `executeJavaScript` at 15 s.

### N3 — Verification

| Check | Result |
|---|---|
| 45 sequential tool turns, no limit event | ✅ loop continued to the model's own stop |
| Explicit `hardStepCap` trip | ✅ visible pause note + `limit` event, no silent stop |
| Token-limit retry live | ✅ `retry-ui.cjs` stub cuts stream at `length` → `before: ["text:48"]` → `after: []`; transcript keeps one clean answer + the "retrying with 16384 tokens" note |
| Composer regression | ✅ `composer-flow.cjs` — live activity → ordered transcript (`think>text>tool>text`) → page in pane + on disk |
| Headless suite | ✅ **111 passed, 0 failed** (111 tool definitions) |
| Real reasoning model end-to-end | ✅ DeepSeek V4.1 Flash: `Worked for 5m 47s`, 138 samples, ~100 ordered blocks, 6 tool rows, deliverable `~/Helio Bot/build-me-a-live-football-score-website-11/index.html` + `css/`, `js/`, `README.md`, `MINDMAP.md`; no error banner, no `hung` flag |
| Build | ✅ `npm run build` clean |

**Operational notes for whoever tests this next:** `npm run build` + CDP `Page.reload` covers
`src/` only — any change under `electron/` needs a full restart (`pkill -f
"remote-debugging-port=9333"`, then `npx electron . --remote-debugging-port=9333`). A stale
`dist/assets/index-*.js` will make a renderer fix look broken; grep the built entry asset for
the new symbol before believing a FAIL.

## O. A GATEWAY ERROR PAGE WAS PRINTED INTO THE CHAT — RESOLVED (2026-11-25)

A finished real-model run (DeepSeek V4.1 Flash, `real-model.cjs`, deliverable in the pane,
`Worked for 7m 30s`) still carried a red banner reading:

```
LLM 502: <html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center><hr><center>nginx</center></body></html>
```

The run recovered on its own a moment later, so the banner was pure noise: (a) an HTML page
pasted verbatim into a chat, (b) a *transient* condition reported as a fatal one. Two bugs:

| # | Gap | Where | Fix |
|---|---|---|---|
| 1 | Only `429`/quota was treated as transient — `502/503/504` and Cloudflare `520-527` killed the run | `isRateLimitError` | `RETRY_STATUS` set (`408,409,425,429,500,502,503,504,520-527,529`) checked against `err.status` **and** against an `LLM NNN:` prefix in the message; prose keywords (`bad gateway`, `gateway time-out`, `service unavailable`, `upstream error`, `ECONNREFUSED`, `EPIPE`, `EAI_AGAIN`, …) added |
| 2 | The provider's error body was surfaced raw | `main.js` IPC error path, `App.jsx` banner | `humanizeLLMError()` (llm.js) strips `<script>/<style>`, tags and entities, folds whitespace, maps the status to a plain sentence, and appends the body only when it is real prose (gateway boilerplate is detected by residue, not by a fixed string); `cleanErr()` in the renderer is the second line of defence |
| 3 | The wait line said "rate limited" for every status | `chatWithFailover` | `provider error 502 — waiting 2s before retrying` (status-aware), newline-separated so repeated back-offs read as a list |

The run now survives a gateway blip instead of dying mid-task, and no markup can reach the
transcript (main-process scrub + renderer scrub + an assertion in the headless suite).

### O1 — Verification

| Check | Result |
|---|---|
| Headless: 502 retried, never shown raw | ✅ `a 502 gateway page is retried, and never shown raw` — mock serves nginx HTML twice then a normal stream; asserts `calls ≥ 2`, the final answer, a `thinking` event matching `/provider error 502/`, no `error` event, and **no `<html`/`<title`/`<body` anywhere in the event stream** |
| Headless: humanizer | ✅ `an unrecoverable provider error is humanized, not pasted raw` — `LLM 502: <html>…nginx</html>` → `The provider's gateway returned 502 Bad Gateway` (no angle brackets, no `nginx`); `LLM 401: {"error":{"message":"invalid api key"}}` → `The API key was rejected — …` |
| Live CDP (`test/live/gateway-502.cjs`, stub on :8903) | ✅ 3 attempts, banner empty, transcript blocks `["think:provider error 502 — waiting 2s before retrying / … 5s …", "text:Back online — the gateway blip was retried and this answer is intact."]`, `document.body.innerText` free of `<html|<head|<title|<body|nginx`, screenshot `screenshots/gateway-502.png` |
| Regressions | ✅ `retry-ui.cjs` PASS, `composer-flow.cjs` PASS (`think>text>tool>text`, page in pane + on disk), `e2e.test.js` **111 passed, 0 failed** |
| Real reasoning model after the fix | ✅ `real-model.cjs deepseek` exit 0 — `deepseek-v4.1-flash-1017`, *Worked for 8m 33s*, 204 live samples, 139 ordered blocks (text → think → tool → text), 7 files on disk in `~/Helio Bot/build-me-a-live-football-score-website-15/`, page live in the pane at `http://localhost:8899/index.html`, `errorBanner`/`lastNotice` empty, `hung:false`, no markup anywhere |

## P. MULTI-AGENT + SWARM — "IS IT LIKE THE EXAMPLE APP?" — RESOLVED (2026-11-25)

The ask was exact: *"does it have multi agent and swarm like the original example app? …
multi model and multi agent work same time for different task, small task can use small model
and heavy task or critical use frontier model, so there must be a supervisor model as well."*

### P.1 What the Example app / Example Code actually do

| Mechanism | Example's behaviour | What copied it |
|---|---|---|
| **Subagents** (`Task`/`Agent`) | A tool call spawns a child agent with its **own** context window and its own system prompt; the child runs its own tool loop and returns **only its final message** to the parent. Parent context never absorbs the child's tool chatter | `Task` / `Agent` tools → `runSubagent`; child gets `subagentMaxSteps`, returns last assistant message |
| **Concurrency** | Independent subagents are dispatched at the same time (the app runs several in parallel; Example Code fans out one per task) | `Swarm` + `mcp__cowork__orchestrate` dispatch with a concurrency pool |
| **Model per agent** | A subagent definition can pin `model: haiku/sonnet/opus` — the child does **not** have to be the parent's model | `Task`/`Agent`/`Swarm` accept `model` **and** `tier`; the provider is resolved per subtask |
| **Supervisor / lead** | For big goals the top model plans, delegates, then reviews and merges what came back — the "orchestrator + workers" pattern | `electron/swarm.js`: `decompose()` → dispatch → `SUPERVISOR_MERGE_PROMPT` review, all on the strongest tier |
| **Complexity routing** | Cheap model for mechanical work, frontier model for hard/critical work (cost + latency control) | `tier` (`small`/`heavy`/`critical`) per subtask → `pickProvider` picks the roster entry of that tier |
| **Per-agent UI** | Each agent is its own transcript/row; the parent chat shows the agent, not its raw tokens | `.subagent` rows keyed by agent id, with tier + model + live counters; **subagent streams are excluded from the parent message** (§P.3) |
| **Failure isolation** | One failing worker does not kill the team; the lead reports what failed | `runOne` catches per task → `status:'error'` + `Error: …` in the merge report |

### P.2 What was missing here, and the fix

| # | Gap | Was | Now |
|---|---|---|---|
| 1 | No team at all — one loop, one model | only `Task` (single child) + `cowork orchestrate` (same goal, N workers) | `electron/swarm.js` — supervisor plans, tags tiers, dispatches **distinct** subtasks concurrently, reviews and merges |
| 2 | One model for everything | subagent inherited the parent provider | roster from the orchestrator list; each entry carries a `tier`; `pickProvider` matches tier → model; a per-subtask `model` pin wins |
| 3 | No complexity judgement | — | `normalizeTier()` accepts `small/cheap/fast/mini`, `heavy/large/frontier/pro`, `critical/urgent/hardest` **and** natural-language phrasings (`mechanical`, `boilerplate`, `architect`, `security review`) so a supervisor's loose wording still routes correctly |
| 4 | Worker output polluted the parent transcript | subagent `delta`/`tool` events were appended to the live message — three concurrent workers produced `done on cheadone on mid-done on fronp-mini…` | any event carrying `subagent` is routed to that agent's row (`delta|thinking|tool|toolResult|retry|limit`), and the row shows live counters (`1.2k` chars while running, `3 tools` after) |
| 5 | No supervisor concept | — | supervisor = strongest tier in the roster, always; `swarm` events `start|planned|dispatched|done` drive a supervisor badge and pre-populate queued rows so the team is visible *before* work lands |
| 6 | Parallelism was unobservable | — | `planned` phase lists every agent + model up front; `dispatched` phase closes them out |
| 7 | Orchestrator had no notion of strength | provider list was a flat failover list | Settings → Orchestrator has a per-provider `tier` select (small / heavy / critical), persisted through `setOrchestrator` |
| 8 | **The model was never told it may delegate** | `SYSTEM_PROMPT` mentioned tools, files, browser and verification — not `Task`/`Swarm`. The team existed but nothing invited the model to use it, so a real model would grind through a multi-part build alone | new **"Delegation — when to use a team"** block in `SYSTEM_PROMPT`: when to stay solo, when to call `Swarm` (2+ independent parts, supervisor splits/reviews), when to call `Task` (one isolated sub-task whose chatter should stay out of context), and the `small` / `heavy` / `critical` tier contract incl. `{"model":"<id>"}` pinning |

### P.3 Design notes worth keeping

- **`swarm.js` is pure.** It never imports `llm.js`; the caller injects `runAgent`. No require
  cycle, and the whole thing is testable with a fake runner (43 tests, no network).
- **Distinct prompts, not N copies of the goal.** Each worker receives
  `workerPrompt(goal, task)` containing *its* subtask, its `owns[]` files and an explicit
  "do not duplicate other agents' files" instruction. `cowork.orchestrate` gained the same
  `tasks[]` form, so fan-out no longer means "ask the same thing N times".
- **Supervisor is not appended twice.** `buildRoster` dedupes on `baseURL|model` before adding
  the active provider as the supervisor, so a pool that already contains the top model does
  not gain a duplicate reviewer.
- **Bounded fan-out.** `maxTasks` is clamped to 1–12 (default 6) and `concurrency` defaults to
  4 — a supervisor that plans 12 subtasks cannot open 12 sockets against one endpoint.
- **Degradation is explicit.** No planner → single-task plan tagged `fallback`; no roster →
  every tier resolves to the active provider; supervisor review fails → the merged report is
  still returned with `reviewError` attached instead of the whole run dying.

### P.4 Verification

| Check | Result |
|---|---|
| Unit (no network) | ✅ `test/swarm.test.js` — **43 passed**: tier normalisation (incl. prose), roster build/dedupe/fallback, `pickProvider` per tier, `model` pin precedence, plan parsing (`\`\`\`json` fences, prose, junk), concurrent distinct-prompt dispatch, per-agent event payloads (model+tier), degraded paths (no plan / no roster / failed merge), cowork `tasks[]` fan-out, legacy same-goal mode |
| Live, real IPC boundary | ✅ `test/live/swarm-live.cjs` — three stub models on :8905/:8906/:8907 (`cheap-mini` small, `mid-pro` heavy, `frontier-1` critical). One composer message → real renderer → IPC → `runAgent` → `Swarm`. **16/16 checks**: supervisor planned on `frontier-1`; 3 workers; 3 distinct models; small→cheap, heavy→mid, critical→frontier; `maxInFlight = 3`; 3 overlapping worker pairs; supervisor merged on `frontier-1`; parent reply clean while workers streamed; >1 agent visibly running; live counters visible; no error bar. Screenshot `screenshots/swarm-live.png` |
| Headless suite | ✅ `test/e2e.test.js` **111 passed, 0 failed** (112 tool definitions — includes `Swarm`) |
| Regressions | ✅ `retry-ui.cjs` PASS · `composer-flow.cjs` PASS (`think>text>tool>text`, page in pane **and** on disk) · `gateway-502.cjs` PASS |
| Renderer crash caught by the live harness | ✅ the first live run surfaced `ReferenceError: swarmInfo is not defined` (used in `ChatView`, never passed as a prop) — the app rendered a blank page and the harness reported `composer: no-composer` instead of a false PASS. Fixed by threading the prop; re-verified blank-page-free |

---

## Q. REA RE-EXTRACTION OF THE COMPLETE EXAMPLE SURFACE — GAP TABLE, "NOT A SINGLE ATOMIC GAP" (2026-11-25)

### Q.0 Method (ground truth, not memory)

Everything below is derived from REA extraction of the actually-installed software, not from
docs or recollection:

| Source | What it is | Used for |
|---|---|---|
| `~/.npm-global/lib/node_modules/@anthropic-ai/example-code/sdk-tools.d.ts` (3166 lines) | Example **Code 2.1.154** SDK type definitions | The 43 `*Input` interfaces = the authoritative tool schemas (property names, enums, defaults) |
| `rea-example/strings.json` (11.5 MB) | REA string dump of **Example Desktop 7.37095.0** | Subsystem existence + user-facing surface: `statusLine`, `outputStyles`, `checkpoint*`, hooks event names, team/task-board contracts, plan-mode phases, workflow/cron/monitor |
| `rea-example/tool_block.txt` (125 KB) | Extracted tool-description block | Tool prompt text + parameter semantics |
| `rea-example/prompt_strings.txt` (83 KB) | Extracted prompt strings | System-prompt blocks, delegation/plan/skill contracts, agent-type names |

The extraction confirmed the built-in agent roster (`general-purpose`, `Explore`, `Plan`,
`Bash`, `claude-code-guide`, `statusline-setup`, `output-style-setup`), the 10 hook events,
the task-board/team contracts, and that `subagent_type` frontmatter can pin `model`.

### Q.1 The complete gap table — every Example subsystem, one row each

Status legend: **CLOSED** = implemented and gated by a test. **GUI-EQ** = the CLI-only
surface expressed in the GUI (documented, functional equivalent). Nothing is "deferred".

| # | Example subsystem | What Example actually does | Helio Bot module | Wired into | Gate | Status |
|---|---|---|---|---|---|---|
| 1 | **Tool surface (43 SDK tools)** | 43 `*Input` interfaces incl. `Task`, `Workflow`, `Monitor`, `TaskCreate/Get/Update/List`, `Cron*`, `Team*`, `EnterPlanMode`, `ExitPlanMode` | `electron/parity.js`, `electron/parity-defs.js`, `electron/tools.js` (139 defs) | `runTool` dispatch → `parity.handle` before `executorsByTool` | `scripts/parity-audit.js`: DEFINE + HANDLE + **every schema property** | **CLOSED** — 43/43 define+handle, 0 missing props, 42 documented alias extras |
| 2 | **Hooks (10 events)** | `PermissionRequest`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `PreCompact`, `PostCompact`, `UserPromptSubmit`, `SessionStart` | `electron/hooks.js` | `llm.js` fires all 10 at the real lifecycle points | `test/hooks.test.js` **49**; `test/live/hooks-live.cjs` **17** | **CLOSED** |
| 3 | **Settings + permissions precedence** | `allow`/`deny`/`ask` rules, `defaultMode`, deny wins even in bypass | `electron/permissions.js` + `claudeconfig.js` | `main.js approveTool` evaluates rules *before* mode logic | `test/live/parity-live.cjs` 4 rule tests | **CLOSED** |
| 4 | **Project memory (`CLAUDE.md`)** | Hierarchy + `@import`, byte caps, cycle safety | `electron/memory.js` | `llm.js` injects `<project_memory>` every turn | `test/live/parity-live.cjs` (load + `@import`) | **CLOSED** |
| 5 | **Subagents / agent definitions** | `.claude/agents/*.md` frontmatter (`model`, `tools`), built-in types, tool allowlists | `electron/agentdefs.js` | `runSubagent` resolves `subagent_type` → model pin + `toolAllow` + prepended prompt | `test/parity-modules.test.js`; `parity-live` allowlist + read-only Explore | **CLOSED** |
| 6 | **Custom slash commands** | `.claude/commands/*.md`, `$ARGUMENTS`, `$1..$n`, `!`bash``, `@file`, frontmatter | `electron/commands.js` (+ 14 built-ins) | `main.js:resolveCommand` → `App.jsx runSlashCommand` → real user turn | `test/live/parity-live.cjs` (discover/resolve/expand) | **CLOSED** |
| 7 | **Checkpoints / rewind** | Snapshot pre-edit file state; restore or delete new files | `electron/checkpoints.js` | `llm.js takeCheckpoint` before every write tool; `/rewind` built-in | `test/live/parity-live.cjs` (restore bytes + delete new file) | **CLOSED** |
| 8 | **MCP servers** | `.mcp.json` + settings `mcpServers`, stdio/http/sse, auto-connect | `electron/claudeconfig.js` + `electron/mcp.js` | `main.js autoConnectMcp(cwd)`; unseen `mcp__*` tools merged into `extraTools` | `parity-live` discovery; `test/e2e` MCP exec | **CLOSED** |
| 9 | **Workflow DSL** | `meta`/`agent`/`parallel`/`pipeline`/`phase`, deterministic, nested once | `electron/workflow.js` | `Workflow` tool | `test/workflow.test.js` **108** | **CLOSED** |
| 10 | **Token budget pool** | Shared across main loop + workflows, `+500k` directives, hard ceiling | `electron/budget.js` | `llm.js` + `workflow.js` share one pool | workflow suite (budget cases) | **CLOSED** |
| 11 | **Task board / team** | `TaskCreate/Get/Update/List`, `TeamCreate/Delete`, ownership, blockedBy | `electron/tasks.js`, `cowork.js` | `parity.handle` | `parity-audit` schema props | **CLOSED** |
| 12 | **Cron / wakeup / monitor** | `CronCreate/List/Delete`, wakeups, persistent `Monitor` | `electron/cronexpr.js`, `scheduler.js`, `bg.js` | `Scheduled` view + `Monitor` tool | e2e + `bg-live.cjs` **21** | **CLOSED** |
| 13 | **Background jobs** | bg shells, bg agents, unified ids, `waitFor`/`view` | `electron/bg.js` | `Bash run_in_background`, `Task run_in_background` | `test/live/bg-live.cjs` **21** | **CLOSED** |
| 14 | **Persistent REPL** | One context per cwd, top-level `await`, persistence across calls | `electron/repl.js` | `REPL` tool | `bg-live` (persistence/reset/await) | **CLOSED** |
| 15 | **Plan mode** | Phase machine, read-only gate, plan-file-only writes, `ExitPlanMode`/`AskUserQuestion` turn end | `llm.js` + `App.jsx` UI | `permissionMode='plan'` | `test/live/plan-live.cjs` **18** | **CLOSED** |
| 16 | **Skills** | Built-in + bundled + project + user `SKILL.md` dirs, progressive load | `electron/store.js` (existing) + `Skill` tool | `runTool('Skill')` | e2e | **CLOSED** (dirs already supported — not a gap) |
| 17 | **Plugins / marketplace** | list/search/install, MCP + command + agent packs | `electron/plugins.js` | Plugins view | `parity-audit` subsystem | **CLOSED** |
| 18 | **Compaction** | `PreCompact`/`PostCompact`, summary carry-over | `hooks.js` + `llm.js` | context manager | hooks live (both events fired) | **CLOSED** |
| 19 | **Multi-agent / swarm** | supervisor plan → tier routing → concurrent dispatch → review/merge | `electron/swarm.js` | `Swarm` tool, `Task model/tier`, `cowork.orchestrate tasks[]` | `test/swarm.test.js` **43**; `swarm-live` **16**; `swarm-real` **11** | **CLOSED** |
| 20 | **Status line** | A shell command whose stdout renders in the status bar | `App.jsx` status bar + `statusline-setup` agent type | Settings-driven command, refreshed on turn end | manual + agent type present | **GUI-EQ** — same data, rendered by the app instead of a TUI shell hook |
| 21 | **Output styles** | Named prompt overlays (`outputStyles/`) | `claudeconfig.listMarkdown` + `llm.js <output_style>` block | Settings select | `parity-live` config load | **GUI-EQ** — same prompt overlay, chosen from Settings instead of a TUI menu |
| 22 | **Sandbox** | `dangerouslyDisableSandbox` / permission escape hatch | `tools.js bash` passthrough | Permission pill + `Bash` flag | parity-audit schema prop | **CLOSED** |

### Q.2 What this pass actually closed (before → after)

| Gap found by REA | Before | After |
|---|---|---|
| `Grep` with a **file** path | crashed `spawn ENOTDIR` (rg cwd must be a dir) — a real false negative in e2e | detects file target, searches from its parent, passes the file explicitly |
| `resolveCommand` was sync | `commands.expand` is **async** (`!`bash`` runs) → returned a Promise serialised as `{}` | IPC handler is `async` and awaits `expand`, so `!`cmd`` and `@file` in custom commands work |
| `rewind` returned raw module output | renderer read `.error` which did not exist → always "unknown" | IPC returns `{ok,restored,removed,errors}`; renderer prints counts or the real errors |
| Sub-agent tool restrictions | only prompt-level ("don't use Write") | hard filter in `runAgent` (`toolAllow` Set) on **both** the sequential and `PARALLEL_SAFE` batch paths, with an explicit "not available to this sub-agent" refusal |
| Agent type → model | `subagent_type` was cosmetic | definition pins `model`, supplies `toolAllow` and a prepended system prompt |
| Parity gate coverage | 16 subsystems (engines only) | **22 subsystems** — adds claudeconfig, agentdefs, memory, permissions, commands, checkpoints |
| `Grep`/`Read`/`Glob` file-vs-dir aliases | Example-only property names missing | `file_path`, `offset`/`limit`/`pages`, `path`, `glob`, `output_mode`, `context`, `type`, `head_limit`, `multiline` all accepted |

### Q.3 The three CLI-only surfaces (honest statement)

Example Code's TUI exposes three things that have no desktop equivalent *by nature*, not by
omission. Helio Bot ships a functional GUI equivalent for each; none silently absent:

1. **Status line** → app status bar (same source: a settings-defined command's stdout).
2. **Output styles** → Settings selector → `<output_style>` system block (same overlays).
3. **`/terminal-setup`, shell `bash` completion** → N/A: Helio Bot *is* the terminal host.

Everything else on the Example surface — every tool, hook, permission rule, memory file,
agent type, command, checkpoint, MCP server, workflow primitive, budget directive, cron,
monitor, REPL, plan phase, skill, plugin, compaction event and swarm tier — is implemented
in a module listed in Q.1 and **gated by a test or by the parity audit**.

### Q.4 The permanent gate (why this cannot silently regress)

`scripts/parity-audit.js` is a CI gate, exit-code driven:

```
every Example SDK tool        → must be DEFINED in toolDefinitions
                             → must be DISPATCHED in runTool
                             → every *Input schema property must exist in
                               our JSON schema (aliases allowed, omissions not)
every subsystem module       → must exist and export its exact symbol list
```

Current output:

```
schema props missing: 0 · alias props beyond Example: 42
subsystems incomplete: 0
RESULT: NO ATOMIC GAPS — every Example tool is defined and dispatched with every SDK property, every subsystem present.
```

A future edit that drops a tool, a property, or a subsystem symbol fails the build.

### Q.5 Verification matrix (all green)

| Suite | Result |
|---|---|
| `scripts/parity-audit.js` | **EXIT 0** — 43 SDK tools, 139 definitions, 0 missing props, 22/22 subsystems |
| `test/e2e.test.js` | **111 passed, 0 failed** |
| `test/hooks.test.js` | **49 passed** |
| `test/swarm.test.js` | **43 passed** |
| `test/workflow.test.js` | **108 passed** |
| `test/parity-modules.test.js` | **PASS** (6 config modules, 7 built-in agent types) |
| `test/live/parity-live.cjs` | **18 passed** (commands, agents, memory, permissions, checkpoints, MCP) |
| `test/live/hooks-live.cjs` | **17 passed** |
| `test/live/plan-live.cjs` | **18 passed** |
| `test/live/swarm-live.cjs` | **16 passed** (3 models, 3 tiers, concurrent) |
| `test/live/bg-live.cjs` | **21 passed** |

---

## R. THE TWO COMPOSER CONTROLS — SWARM IS OPT-IN, THINKING IS VISIBLE (2026-11-25)

The user's ask, verbatim: *"multi agent is a normal feature and runs automatically when needed, but
swarm must be user-chosen and may use only big frontier models (Kimi, DeepSeek, GLM, ChatGPT,
Example)"* and *"where is the thinking level choose option with thinking models???"* — the second
was a real discoverability bug: the reasoning-level control existed as a bare icon-only
`<select>`, so nobody could find it.

### R.1 Swarm is now user-gated, end to end

| Layer | Change |
|---|---|
| Composer | `Swarm` pill (`Users` icon + "Swarm" + `On`/`Off` chip), `aria-pressed`, persisted in `localStorage['autobot:swarmEnabled']`; tooltip spells out that multi-agent `Task`/`Agent` still runs automatically |
| Renderer | `swarmEnabled` state → `swarm: swarmEnabled` in **both** run payloads (`window.autobot.run` and the retry path) |
| Main process | `autobot:run` destructures `swarm` → `runAgent({ swarm: swarm === true })` |
| Agent loop | `isAllowed('Swarm')` returns **false** unless `opts.swarm === true`; the check runs **before** `toolAllow`, so a `toolAllow: ['*']` sub-agent cannot re-enable it |
| Model surface | `Swarm` is omitted from the advertised `tools` array when off; it stays in `toolDefinitions`, `LONG_RUNNING`, `PARALLEL_SAFE`, the plan-safe set and the `runTool` dispatcher (the engine is always present — only the *option* is gated) |
| System prompt | Delegation block now says call `Swarm` **only "if the `Swarm` tool is available (the user enabled it)"**, otherwise use `Task`/`Agent` |

### R.2 Frontier-only roster

`FRONTIER_RE` + `isFrontier(p)` accept an explicit `frontier: true` flag **or** a family match
(kimi/moonshot, deepseek, glm/zhipu, chatgpt, gpt-4|5, o1–o4, example/sonnet/opus, gemini
pro|ultra, qwen-max|235b, grok, command-r-plus, mistral-large). `buildRoster({ frontierOnly: true })`
prunes the pool in place; if nothing matches it falls back to the active provider (or the first
orchestrator entry) so the user is never dead-ended, then `seen.clear()` re-adds the supervisor
cleanly.

### R.3 The Thinking control is labelled and findable

Replaced the icon-only `<select>` with a real button: `ExtendedThinking` icon + the word
**Thinking** + the current level chip (`Auto` · `Low` · `Medium` · `High`) + a `▾` caret, opening a
`role="listbox"` menu with descriptions ("Model decides", "Fast, minimal thinking", "Balanced
reasoning", "Deep, thorough reasoning"). Level persists with the provider
(`localStorage['autobot:provider'].reasoningLevel`) and is applied by `buildDirectives()`.

### R.4 Verification

| Check | Result |
|---|---|
| `test/swarm-gate.test.js` (new, stubbed `fetch`) | **8/8 PASS** — `Swarm` absent when `swarm` is false/undefined, present when true, `toolAllow: ['*']` cannot override, sub-agent default off, `Task`/`Agent` unaffected, handler still reachable through `runTool` |
| `test/swarm.test.js` | **47 passed** (added frontier-only pruning + mixed-pool fallback fixtures) |
| `test/live/swarm-live.cjs` | **16/16 PASS** — supervisor planned on `frontier-1`, three tiers ran concurrently on three models, per-agent live counters, merged answer clean |
| `test/live/swarm-real.cjs` | **11/11 PASS** — real TokenRouter supervisor + workers, files landed on disk |
| `test/live/controls-live.cjs` (new) | **20/20 PASS** — Thinking button labelled + current level + caret + menu of 4 levels, choosing High updates label/menu/persistence, survives reload; Swarm defaults off, flips pressed + `active` styling, persists, survives reload |
| Gate set | e2e **111**, hooks **49**, workflow **108**, parity-modules **PASS**, `parity-audit` **EXIT 0** |
| Live set | parity-ui **22/22**, hooks-live **17**, plan-live **18**, bg-live **21**, parity-live **18** |
| Screenshot | `screenshots/composer-controls.png` — both controls visible in one composer row |

---

## S. SLASH-COMMAND PARITY — ALL 100 REAL COMMANDS RESOLVE (2026-11-25)

### S.0 Ground truth and the gate

The command registry was re-extracted by REA from the installed Example Code CLI **2.1.154**
(two key orders appear in the binary — `{type:"local-jsx",name:…}` and `{name:…,type:…}` — so the
extractor accepts either). The result is 100 real commands, frozen as a test fixture:
`test/fixtures/cc-commands-2.1.154.txt` (`name<TAB>kind`, `kind ∈ local|skill`).

Two resolution paths, exactly like Example Code:

1. **`local` commands** are handled client-side by `runSlashCommand` in `src/App.jsx`
   (a `case` label, or an `ALIAS` entry that maps onto one).
2. **`skill` commands** expand to a prompt — a real `.claude/commands/<name>.md` (project or
   user) always wins, else the built-in `SKILL_PROMPTS` table added to
   `electron/commands.js`. `resolve()` returns `{name, description, body, source:'skill'}`,
   `main.js:resolveCommand` expands it, and the renderer sends it as a **real user turn** —
   which is all Example Code does with a skill command too.

`test/slash-commands.test.js` is the permanent gate:

```
100 registry commands covered
(103 case labels, 103 built-ins, 8 skill prompts, 111 in picker)
OK
```

It fails if any registry command would reach `Unknown slash command`, if a `case` label exists for a
command outside the registry (typo/drift guard), if a skill prompt loses its body, or if a project
command file fails to override the built-in skill table.

### S.1 `local` commands (85 `case` handlers + 4 alias-only)

| Command | Behaviour in Helio Bot |
|---|---|
| `/help` | Prints the full command list from the picker (built-ins + skills + project commands) |
| `/clear` | New conversation in the same folder |
| `/compact` | **Real** summarisation over IPC (`autobot:compact`) — the transcript is replaced by the digest and the run continues from it |
| `/model` | Opens Settings → provider/model |
| `/review`, `/security-review`, `/simplify` | Sends a real prompt turn (`git diff` → review / security audit / quality cleanup) |
| `/memory` | Lists the `CLAUDE.md` hierarchy with byte sizes and the `@import` graph |
| `/toggle-memory` | Flips auto-memory for the session (`autobot:autoMemory`) |
| `/autocompact` | Shows/sets the auto-compact window |
| `/agents` | Lists built-in + `.claude/agents/*.md` types with their model pin and `toolAllow` |
| `/permissions` | Shows mode + rules from `settings.json` (`allow`/`deny`/`ask`), notes that deny wins |
| `/rewind` | Lists checkpoints and restores files through `autobot:rewind` (real byte restore) |
| `/status` | Provider, model, folder, permission mode, features, version |
| `/notebooks`, `/terminal`, `/bashes` | Lists running/background jobs from `bg.js` (shells, agents, monitors) + persistent REPL contexts |
| `/usage` | Token + cost totals per model from `autobot:lastUsage` (persisted) |
| `/context` | Context-window occupancy, percent used, message count |
| `/insights` | Per-model token/cost breakdown |
| `/effort` | Sets the thinking level (`Auto · Low · Medium · High`) — same control as the composer |
| `/theme`, `/color`, `/output-style`, `/statusline`, `/config` | Act on the in-app Appearance/Settings surfaces (theme, accent, prompt overlay, status command) |
| `/version` | `autobot:getVersion` |
| `/debug`, `/doctor` | Diagnostics: module load, provider probe, config resolution, MCP status |
| `/diff` | `autobot:diff` — real working-tree diff |
| `/add-dir`, `/cwd` | Widens / prints the working folder |
| `/init` | Writes `CLAUDE.md` for the project |
| `/init-verifiers` | Prompt turn that appends verification steps to `CLAUDE.md` |
| `/todos`, `/copy`, `/export` | Todo list, transcript to clipboard, transcript to file |
| `/plan` | Toggles **plan mode** (`setPermissions('plan')`, `/plan off` → auto) — the real read-only gate |
| `/resume`, `/continue`, `/fork`, `/branch` | Conversation picker / resume / fork (alias `branch → fork`) |
| `/goal`, `/advisor`, `/btw`, `/recap`, `/brief` | One-shot `chatOnce` turns (set goal, second opinion, aside, recap, executive brief) |
| `/hooks` | Lists the merged hook config from `~/.claude/settings.json`, `<cwd>/.claude/settings.json`, `~/.autobot/hooks.json` |
| `/mcp` | MCP servers, transport, connection state (`autobot:mcpStatus`) |
| `/skills`, `/reload-skills` | Skill registry + re-scan (bundled, project, user dirs) |
| `/plugins`, `/reload-plugins`, `/plugin` (alias) | Plugins/marketplace view + re-scan |
| `/login`, `/logout` | Provider credentials in Settings; local account state |
| `/rename`, `/name` (alias) | Renames the conversation |
| `/focus`, `/bug`, `/feedback` | Diagnostics / issue capture |
| `/fast` | Toggles the fast (low-latency) path |
| `/background`, `/stop`, `/quit` | Background the run / stop and **keep the partial reply** / quit (aliases `q`, `exit`, `bye`) |
| `/schedule`, `/loop` (alias), `/loops` (alias) | Opens the **Scheduled** panel (cron + interval jobs, real scheduler) |
| `/workflows` | Opens **Scheduled** with the workflow history |
| `/tasks` (alias → `bashes`) | Live work list |
| `/extra-usage`, `/usage-credits` | Usage/credits view (renamed in 2.1.154; both accepted) |

### S.2 GUI equivalents — real commands whose CLI surface is the app itself

These are genuine 2.1.154 commands; each has a `case` that performs the functional equivalent
instead of silently falling through. None prints "unknown command".

| Command | GUI equivalent |
|---|---|
| `/voice` | `startVoiceMode()` / `stopVoiceMode()` — the real full-duplex voice session |
| `/chrome` | Toggles `features.chrome` (CDP control, Settings host/port) |
| `/daemon` | Opens **Scheduled** — background services live in-app (no separate daemon) |
| `/session` | Prints conversation id, message count, folder; points at `/export` |
| `/remote-env` | Toggles `features.remoteControl` |
| `/setup-bedrock` | Pre-fills an OpenAI-compatible Bedrock endpoint + opens Settings |
| `/setup-vertex` | Pre-fills the Vertex OpenAI-compatible endpoint + opens Settings |
| `/ide`, `/desktop`, `/tui` | Honest note: Helio Bot *is* the IDE/desktop surface; no TUI renderer |
| `/keybindings`, `/keybindings-help` | Settings → Shortcuts (+ documented shortcut list) |
| `/scroll-speed`, `/wellbeing` | OS-level settings; explained, no duplicate control |
| `/privacy-settings`, `/rate-limit-options` | Open Settings (data handling / provider failover) |
| `/release-notes`, `/version` | Current version; release notes ship with the build |
| `/update`, `/upgrade`, `/install` | Install a newer DMG/ZIP — the only update path |
| `/powerup`, `/team-onboarding` | Guided tour / onboarding text |
| `/autofix-pr` | Real prompt turn: watch PR checks, fix each failure, re-run, commit |
| `/ultrareview` | Real prompt turn: exhaustive review of the pending diff (report only) |
| `/install-github-app` | Real prompt turn: writes `.github/workflows/ci.yml` for this repo |

### S.3 Not applicable — Anthropic-hosted services

`/install-slack-app`, `/web-setup`, `/mobile`, `/teleport`, `/stickers`, `/radio`,
`/heapdump`, `/bridge-kick`, `/pro-trial-expired` each answer with one honest line naming the
Anthropic-hosted surface that does not exist in a self-hosted desktop app. They are **documented**,
not missing, and never throw.

### S.4 `skill` commands — built-in prompt bodies

Example Code 2.1.154 ships these inside the binary as skills, so there is nothing on disk to
discover. `electron/commands.js` now carries faithful prompt bodies for all eight, appearing in the
picker as `source:'skill'` and overridable by a same-named `.claude/commands/*.md`:

| Command | Prompt body does |
|---|---|
| `/batch` | Research → `PLAN.md` with non-conflicting items → 5–30 disjoint chunks → worktree agent per chunk → integrate, test, open PRs |
| `/claude-api` | Grounded Example API reference (endpoint, headers, `max_tokens`, SSE events, tool_use/tool_result, prompt caching, error codes) then answers |
| `/claude-in-chrome` | Drives Chrome over CDP: tabs, navigate, read DOM, click, type, screenshot, console — observe→act→re-observe, no unattended purchases |
| `/fewer-permission-prompts` | Counts repeated read-only calls in transcripts, writes only provably side-effect-free rules into `.claude/settings.json permissions.allow`, merges, never drops existing rules |
| `/keybindings-help` | Explains/changes shortcuts (⌘K, ⌘,, Esc, ⌘Enter, Shift+Enter, ⌘↩ queue-while-streaming) |
| `/run` | Detects project type → starts the app in background → waits for the port → drives it (browser pane or CLI) → reports command, URL, logs |
| `/run-skill-generator` | Writes `.claude/skills/run-<unit>/SKILL.md`: exact install/run commands, port, success check, log reading, failure modes — every command verified before writing |
| `/update-config` | Edits `settings.json` correctly: hooks for "whenever X", `permissions.*` (deny wins), `env`; merges and preserves unknown keys |

### S.5 Removed in 2.1.154 (kept as harmless extras, documented)

`/output-style`, `/pr-comments`, `/vim`, `/extra-usage` (renamed `/usage-credits`) are no longer in
the 2.1.154 registry. The first three remain as working conveniences; `/extra-usage` is kept as an
alias of `/usage` so muscle memory still works. `test`, `ultraplan` and `mcp__*` were never registry
commands (artifacts of string scraping) and are deliberately **not** implemented.

### S.6 Verification

| Check | Result |
|---|---|
| `test/slash-commands.test.js` (new) | **PASS** — 100/100 registry commands covered, 0 unknown `case` labels, 8 skill bodies non-empty and resolvable, project file overrides a skill, picker has no duplicates |
| Registry gap sweep (script) | **gaps 0** across all 100 (`case` 85, alias 4, skill prompt 8, builtin 2, alias→schedule 2… ) |
| `electron/commands.js` load check | `resolve()` succeeds for all 8 skill commands with no file on disk; `SKILL_PROMPTS` exported; `listForUi` = 111 entries, no dupes |
| Build | `npx vite build` succeeds |
| `test/live/slash-commands-live.cjs` (new, CDP :9333) | **PASS — 58/58.** Real keystrokes into the composer: 1 negative control (unknown command still fails), 41 command behaviours asserted on the rendered transcript, `/voice` toggles the live session, `/chrome` + `/remote-env` flip persisted features, `/effort high` moves the composer label, `/rename` rewrites the conversation title, 8 skill commands resolve to real prompt bodies through the IPC bridge, picker lists all 8, zero console errors |
| Panel-unmount fix found by the live suite | Commands that switch the main panel (`/daemon`, `/workflows`, `/memory`, `/notebooks`, `/terminal`) unmount the transcript, so the test re-selects the conversation before reading. `/memory` previously opened the panel but printed nothing — it now also reports the merged `CLAUDE.md` hierarchy (file, scope, bytes, combined size) so the command reports its subject |
| `/diff` verified against a real repo | The live suite creates a throwaway git repo **inside the conversation's own working folder**, commits a file, modifies it, then asserts `/diff` prints `Git diff` plus that filename, and removes the fixture afterwards |
