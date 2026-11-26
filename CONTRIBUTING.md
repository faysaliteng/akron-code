# Contributing to Akron Code

Thank you for helping improve **Akron Code**!

## Development Setup

```bash
git clone https://github.com/faysaliteng/akron-code.git
cd akron-code
npm ci
npm run dev       # Vite dev server
npm start         # Launch Electron against Vite / dist build
```

## Required Quality & Security Gates

Before opening a pull request, every change must pass:

1. **Syntax / JSX Static Check:**
   ```bash
   npm run typecheck
   ```
2. **Production Bundle + Zero Source Maps Audit:**
   ```bash
   npm run build
   node test/cross-platform-audit.test.js
   ```
3. **Full Test Suite:**
   ```bash
   for f in test/*.test.js; do node "$f" || exit 1; done
   ```
4. **Brand Seal Check:**
   ```bash
   npm run brand:check
   ```

## Coding & Architecture Guidelines

- Keep main-process secrets, filesystem tools, SQLite DB (`electron/session-db.js`), and sandbox enforcement isolated behind typed IPC handlers in `electron/main.js` and `electron/preload.js`.
- Never embed external CDN scripts for core IDE, Mermaid, or Markmap rendering (`100%` offline capability).
- Preserve cross-platform compatibility across **macOS**, **Windows 11/10 (`x64` & `arm64`)**, and **Linux**.
- Keep all tests passing with real assertions — never weaken test gates or ship `.map` source maps in packaged builds.
