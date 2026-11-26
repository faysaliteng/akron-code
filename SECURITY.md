# Security Policy

## Reporting a Vulnerability

AkronLogic takes the security of **Akron Code** seriously. If you discover a security vulnerability in Akron Code, its Electron main process, execution sandbox, SSH/Remote transport, or Browser Bot bridge, please do **not** open a public GitHub issue with exploit details.

- Report vulnerabilities privately via GitHub Security Advisories or contact **security@akronlogic.com**.
- Include steps to reproduce, affected version (`Settings › About`), OS/architecture, and any proof-of-concept patch or logs (redacting API keys and tokens).

## Hardening Controls Built into Akron Code

- **Electron Fuses**: Packaged builds enforce `RunAsNode=0`, `EnableNodeOptionsEnvironmentVariable=0`, `EnableNodeCliInspectArguments=0`, `EnableCookieEncryption=1`, `EnableEmbeddedAsarIntegrityValidation=1`, and `OnlyLoadAppFromAsar=1`.
- **Cryptographic Brand Seal**: `electron/brand-seal.json` + `electron/brand-guard.js` validate official branding and core extension integrity at runtime (`node scripts/seal-brand.js` / `npm run brand:check`).
- **OS Keychain Encryption**: Provider tokens, SSH passphrases/passwords, and remote pairing secrets stay in main-process `safeStorage` and never cross the renderer IPC boundary.
- **OS-Level Sandbox & Policy Engine**: `electron/sandbox.js` + `electron/os-sandbox.js` inspect chained/wrapped shell subcommands (`canonicalizeShellCommand`) and support macOS Seatbelt, Linux `bwrap`, and Windows PowerShell policies.
- **Private Spill Files**: Tool outputs spilled to disk under `~/.autobot/spills/` are written with `0o600` file permissions and auto-pruned after 7 days.
