# Akron Bot on Windows — what works, what does not

This document is deliberately conservative: it separates **code that is
platform-neutral** from **features that have only ever been run on macOS**.
Nothing in this file is claimed as tested on Windows unless it says so. At the
time of writing the only platform this build has been exercised on is
`darwin arm64`.

---

## 1. Build

```powershell
cd autobot
npm install
npm run build          # vite → dist/
npx electron .         # dev run, no packaging
npm run dist           # produces release\AkronBot-<version>-<arch>.exe
```

`electron-builder` will emit an **NSIS installer** and a **portable `.exe`** for
`--win`. Code signing is not configured, so Windows SmartScreen will warn on
first launch (More info → Run anyway). There is no `--win` block in
`package.json` today; add one if you want a stable installer name:

```json
"win": { "target": ["nsis", "portable"], "artifactName": "${productName}-${version}-${arch}.${ext}" }
```

The bundled runtimes (`vendor/runtimes/<id>/`) are resolved per platform by
`electron/runtimes.js` (`win32` → `win-x64` binaries from the vendors' own
release feeds), so `npm run dist` on a Windows box vendors the Windows CLIs
rather than copying the macOS ones.

---

## 2. Platform-neutral (should work unchanged)

| Area | Why it is portable |
|---|---|
| Chat, streaming, markdown, artifacts | Pure renderer + HTTPS. |
| The 141-tool agent loop | Tools dispatch through Node APIs (`fs`, `child_process`, `fetch`). **Except `Bash`** — see the blocker below. |
| Claude / ChatGPT / Grok / Antigravity sign-in | OAuth + PKCE over HTTPS with a loopback redirect (`http://127.0.0.1:<port>`). No OS keychain is required; tokens go to the encrypted store. |
| FreeLLMAPI router | Node HTTP server on `127.0.0.1:3001`. |
| Model catalog, context windows, auto-compact, chunking | Data-driven (`electron/model-catalog.js`), no OS dependency. |
| MCP (stdio) client | Spawns the configured command; `npx`/`node` work if Node is on `PATH`. |
| Browser pane (Electron `webview`) | Chromium is bundled with Electron. |

### 2.1 The `Bash` tool is a macOS shell today (port blocker, not a config flag)

The tool the agent loop actually dispatches (`electron/tools.js` → `runTool`,
required by `electron/llm.js`) builds the shell with
`electron/sandbox.js:wrapShell()`, which returns

```js
{ file: '/bin/zsh', args: ['-l', '-c', command] }
```

unconditionally. On Windows `spawn('/bin/zsh', …)` fails with `ENOENT`, so
`Bash` is dead even though every other tool works. `electron/parity.js` already
contains the correct branch (`powershell.exe -NoProfile -NonInteractive
-Command <cmd>` on `win32`) but that file is the tool *implementation* the loop
does not call.

To port: make `wrapShell()` return `{ file: shellForPlatform(), args: ['-c', cmd] }`
(and skip the `sandbox-exec` branch, which is already guarded), then route
`tools.js`'s `Bash` through it. Roughly a 10-line change — but it is a code
change, and until it lands Windows is a chat-only build.

---

## 3. macOS-only today

These are gated with `process.platform` checks and **degrade rather than crash**
on Windows. Do not expect them to work:

| Feature | Gate | Behaviour on Windows |
|---|---|---|
| **Claude keychain adoption** (`Claude Code-credentials`) | `provider-oauth.js` → `readClaudeCodeCredentials()` returns `null` on non-darwin | Import reports `no Claude Code credentials on this machine`; use **Sign in** or **Add key** instead. |
| **Computer Use** (screen capture + mouse/keyboard via `osascript`) | `electron/computer.js` shells out to `/usr/bin/osascript` with no platform branch | The `cu` / `computer` tools fail with `ENOENT` (`osascript` does not exist). The rest of the agent is unaffected — nothing else is blocked by it, but do not tell a Windows user this feature exists. |
| **`sandbox-exec` confinement for shell tools** | `electron/sandbox.js` — `platform === 'darwin' && existsSync(SANDBOX_EXEC)` | Falls back to an unsandboxed shell and prepends `[sandbox unavailable — ran unsandboxed]` to the output. This is a real difference in blast radius: on Windows the shell tool runs with your full user rights. |
| **Brave Browser / browser-app menu item** | checks `/Applications/Brave Browser.app` | Falls back to "open in default browser". |

If you want to close the Computer Use gap on Windows, the pieces to replace are
the screen grab (`screencapture` → PowerShell `Add-Type` + `Graphics.CopyFromScreen`)
and input injection (`osascript` System Events → `SendInput` via `Add-Type`).
That is a port, not a config flag.

---

## 4. Firewall / proxy notes

- Loopback OAuth ports: **ephemeral** for Claude (the Claude Code CLI passes
  `redirectPort: 0`; the listener takes a free port and binds `127.0.0.1` and
  `::1` on it), **1455** (ChatGPT), **56121** (Grok), ephemeral for Google.
- FreeLLMAPI: **3001**.
- DevTools when launched with `--remote-debugging-port`: whatever you pass.

Windows Defender Firewall prompts on first listen for each port; allow *private*
networks only.

---

## 5. Known unknowns

- No automated tests have been run on Windows (`test/*.test.js` uses POSIX paths
  in a few fixtures and `os.userInfo().username` assumptions).
- `electron/parity.js` has a `win32` branch, but it has not been exercised
  against a real Windows session.
- Long-path handling: `~/.autobot` → `%USERPROFILE%\.autobot`. Windows' 260-char
  limit can bite on deep project folders; enable long paths
  (`HKLM\SYSTEM\CurrentControlSet\Control\FileSystem\LongPathsEnabled=1`).

Treat a Windows build as **experimental** until the probe suite
(`build/probe-capability.cjs`, `probe-logo.cjs`, `probe-picker.cjs`) is green on
it.
