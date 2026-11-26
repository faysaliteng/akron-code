# Changelog

All notable changes to **Akron Code** are documented here.

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
