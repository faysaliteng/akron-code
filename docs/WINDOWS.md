# Akron Code `v1.4.0` on Windows 11 & 10 (`x64` & `ARM64`)

Akron Code ships native **NSIS Setup installers** (`AkronCode-1.4.0-win-setup-x64.exe` and `AkronCode-1.4.0-win-setup-arm64.exe`) and a **Portable executable** (`AkronCode-1.4.0-win-portable-x64.exe`), plus zero-`node-gyp` PowerShell/C# `user32.dll` + `UIAutomationClient` Windows Computer Use 2.0.

---

## 1. Installers, Electron Fuses & Windows Verification

| Artifact / Check | Verified Result |
|---|---|
| Windows x64 & ARM64 Packaging (`electron-builder --win nsis --x64 --arm64`, `portable --x64`) | ✅ Built `AkronCode-1.4.0-win-setup-x64.exe`, `AkronCode-1.4.0-win-setup-arm64.exe`, `AkronCode-1.4.0-win-portable-x64.exe` |
| Electron Security Fuses (`scripts/harden-fuses.js`) | ✅ `RunAsNode=0`, `OnlyLoadAppFromAsar=1`, `EnableEmbeddedAsarIntegrityValidation=1` verified on both x64 and ARM64 `Akron Code.exe` binaries |
| Prior Windows 11 ARM64 VM Smoke (`v1.2.0`) | ✅ Silent NSIS `/S` (`NSIS_EXIT=0`, Desktop & Start Menu shortcuts, `COLD_BOOT_OK` 0 errors, CRX3 & Edge registry `1.6.7`) — shared NSIS/main-process template retained in `v1.4.0` |
| Stdio Broken-Pipe Hardening (`electron/main.js`) | ✅ `EPIPE` / `ERR_STREAM_DESTROYED` guards on `process.stdout` / `process.stderr` + `uncaughtException` prevent GUI launch console crashes |
| Windows Computer Use 2.0 (`electron/computer-win-linux.js`) | ✅ PowerShell / C# `user32.dll` mouse/keyboard/window capture + `UIAutomationClient` `ax_snapshot`/`ax_find` with zero native C++ `node-gyp` addons |

---

## 2. Windows-Native Runtime Architecture

- **Shell & PTY (`electron/os-sandbox.js`, `electron/ide/ipc.js`):** Tool shell execution uses PowerShell (`powershell.exe -NoProfile -NonInteractive`) cleanly (no `/bin/zsh` assumption), paired with bundled ConPTY `node-pty` binaries for both `win32-x64` and `win32-arm64`.
- **Portable AES-256-GCM Secret Store (`electron/secretstore.js`):** OAuth tokens, provider API keys, and environment credentials persist encrypted in `~/.autobot/secrets.json` (`%USERPROFILE%\.autobot\secrets.json`) across Windows/macOS/Linux without relying on legacy DPAPI profile migration.
- **Native Windows Notifications (`electron/notifications.js`):** Renders Windows Toast XML payloads with unpacked PNG/ICO app artwork and registered `com.akronbot.app` AppUserModelID.
- **Bundled Native Tools (`electron/runtimes.js`):** Resolves `win32` x64/arm64 binaries for `@vscode/ripgrep`, `@ffmpeg-installer/ffmpeg`, `@ffprobe-installer/ffprobe`, SQLite WASM (`sql-wasm.wasm`), `pdf-lib`, `docx`, `xlsx`, and `pptxgenjs` offline.

---

## 3. Standalone `Akron Browser Bot` Extension on Windows

On first launch (and from **Settings → Browser Extension**), Akron Code automatically:

1. Syncs the unpacked MV3 bundle + deterministic RSA-2048 signed **`akron-browser-bot.crx`** into `%LOCALAPPDATA%\AkronLogic\Akron Browser Bot\`.
2. Writes `HKCU\Software\{Google\Chrome|BraveSoftware\Brave-Browser|Microsoft\Edge}\Extensions\gbjcokihhhpgdhmhlgbchfanhaoaoegh` pointing to the local `.crx` package.
3. Exposes **1-Click Launch Browser with Extension Pre-Loaded** (`--load-extension`) wired over the `:8766` local WebSocket bridge (`127.0.0.1:8766`).

---

## 4. Building Windows Installers from Source

```bash
npm ci
npm run dist:win                          # x64 NSIS Setup + Portable .exe
npx electron-builder --win nsis --arm64   # ARM64 NSIS Setup
```

> **Note:** Installers are currently unsigned (no EV Authenticode certificate configured in local dev), so Windows SmartScreen may prompt **"More info → Run anyway"** on first run.
