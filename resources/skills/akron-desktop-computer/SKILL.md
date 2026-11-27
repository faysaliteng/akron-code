---
name: akron-desktop-computer
description: "Control and inspect the native desktop GUI (`mcp__computer__screenshot`, `zoom`, `app_screenshot`, mouse/keyboard, `ax_find`), integrated terminal tabs (`mcp__terminal__*`), scheduled automations (`CronCreate`, `ScheduleWakeup`, `Monitor`), and built-in REA reverse engineering (`rea`)."
---

# Desktop Computer Use, Integrated Terminals, Automations & REA

## 1. Computer Use 2.0 (`mcp__computer__*`)
- **Screen capture:**
  - `mcp__computer__screenshot`: Saves a 1x logical-resolution PNG whose coordinates match `click(x, y)` **1:1**, and visually attaches it to the conversation.
  - `mcp__computer__zoom`: Captures a high-DPI crop `{ x1, y1, x2, y2 }` for reading small UI text or icons cleanly.
  - `mcp__computer__app_screenshot`: Captures a specific application window (`app`, `windowId`, `title`) cleanly without taking over the whole screen.
- **Input & UI Tree:**
  - `mcp__computer__click`, `move`, `drag`, `mouse_down`, `mouse_up`, `type`, `key`, `scroll`, `wait`, `batch`.
  - `mcp__computer__ax_find` / desktop accessibility tools inspect native macOS Accessibility elements. If `-25211` (*not allowed assistive access*) appears on macOS, instruct the user to grant Accessibility permission to **Akron Code** under **System Settings → Privacy & Security → Accessibility** (never bypass TCC/OS permission prompts).

## 2. Integrated Terminal Tabs (`mcp__terminal__*`) vs `Bash`
- Use **`Bash`** (or `Bash(run_in_background: true)` + `TaskOutput` + `KillShell`) for standard agent shell commands, builds, tests, and git.
- Use **`mcp__terminal__*`** (`list_terminal_tabs`, `open_terminal_tab`, `run_in_terminal`, `read_terminal`, `stop_terminal_tab`) when running dev servers or commands inside visible IDE Terminal tabs for the user to watch.

## 3. Scheduled Automations & Monitors
- **Recurring & Delayed Runs:** `CronCreate` (5-field local cron), `CronList`, `CronDelete`, `ScheduleWakeup` (`60–3600 s` delayed resume), `Monitor` (watch a background stdout stream and wake on matching output), plus `scheduled-tasks__*` MCP tools and the `automation` skill (`Skill("automation")`).

## 4. Built-In Reverse Engineering (`rea`)
- `rea` wraps **263 REA MCP tools** & CLI (`status`, `search`, `call`, `cli`, `doctor`) for analyzing shipped desktop apps, Electron ASAR/JS bundles, Mach-O/ELF/PE binaries, Android APKs, firmware, and captures (`audit_release_exposure`, `analyze_javascript_application`, `decompile`). Also load `Skill("reverse-engineer-anything")` for full workflows.
