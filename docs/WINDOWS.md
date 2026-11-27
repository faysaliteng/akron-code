# Akron Code `v1.2.0` on Windows 11 & 10 (`x64` & `ARM64`)

Akron Code ships native **NSIS Setup installers** (`AkronCode-1.2.0-win-setup-x64.exe` and `AkronCode-1.2.0-win-setup-arm64.exe`) and a **Portable executable** (`AkronCode-1.2.0-win-portable-x64.exe`), verified live on **Windows 11 ARM64** (`8819D970-712D-4617-A52F-3445848F17DB`).

---

## 1. Installers, Electron Fuses & Windows Verification

| Artifact / Check | Verified Result on Windows 11 ARM64 |
|---|---|
| Silent NSIS Setup (`AkronCode-1.2.0-win-setup-arm64.exe /S`) | ✅ `NSIS_EXIT=0` (`C:\Users\<user>\AppData\Local\Programs\Akron Code\Akron Code.exe`) |
| Binary Version Metadata & Uninstall Registry | ✅ `ProductVersion = 1.2.0.0`, `HKCU\...\Uninstall\*` → `Akron Code 1.2.0`, Desktop & Start Menu `.lnk` shortcuts created |
| Cold Boot Check (`AKRON_COLD_BOOT_CHECK=1`) | ✅ `COLD_BOOT_OK {"ok":true,"brandOk":true,"domOk":true,"ipcOk":true,"checkedFiles":15,"consoleErrorCount":0}` |
| Stdio Broken-Pipe Hardening (`electron/main.js`) | ✅ `EPIPE` / `ERR_STREAM_DESTROYED` guards on `process.stdout` / `process.stderr` + `uncaughtException` prevent GUI launch console crashes |
| Electron Security Fuses (`scripts/harden-fuses.js`) | ✅ `RunAsNode=0`, `OnlyLoadAppFromAsar=1`, `EnableEmbeddedAsarIntegrityValidation=1` (`resources\app.asar` PE normalized) |
| Standalone `Akron Browser Bot` CRX3 & Edge Registry | ✅ Synced to `%LOCALAPPDATA%\AkronLogic\Akron Browser Bot\akron-browser-bot.crx` (`Cr24` magic) + `HKCU\Software\Microsoft\Edge\Extensions\gbjcokihhhpgdhmhlgbchfanhaoaoegh` (`version: 1.6.7`) |

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
