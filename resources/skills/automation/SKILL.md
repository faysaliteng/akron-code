---
name: automation
description: Guide the user interactively through designing, scheduling, and testing an automated recurring or event-driven task.
---

# Interactive Automation Builder (`/automation`)

Use this skill when the user wants to create a recurring schedule, event-driven watcher, or manual automation routine through interactive dialogue.

## Workflow
1. **Detect local context first**: Use the active workspace (`cwd`) and note the user's detected local IANA timezone (via Node/Intl or current session context).
2. **Gather essentials concisely with `AskUserQuestion`** (keep questions crisp and batched—skip anything the user already answered in their prompt):
   - **Cadence / Trigger**: Daily, Weekdays (Mon–Fri), Weekly, Hourly / Every N min, Custom Cron (`CRON_TZ=`), or Git/File Watch.
   - **Preferred Time & Jitter**: Suggest jittered non-`:00` times (e.g. `07:18`, `07:52`, `08:47`) in the user's local timezone to avoid top-of-hour API stampedes.
   - **Scope & Isolation**: Workspace folder, whether to isolate edits in a Git Worktree (`useWorktree`), and permission mode (`auto` vs `plan` read-only).
3. **Create the task immediately**: Call `scheduled-tasks__create_scheduled_task` with a clear `name`, concise 1-line `description`, detailed actionable `prompt`, chosen `cadence`/schedule fields, `cwd`, and flags (`useWorktree`, `durable`, `permissionMode`, `attentionGate`).
4. **Confirm & offer instant test run**: Report the created task ID, schedule summary, `~/.autobot/scheduled-tasks/<id>/SKILL.md` path, and ask if they want a 1-click immediate test run via `scheduled-tasks__run_scheduled_task`.
