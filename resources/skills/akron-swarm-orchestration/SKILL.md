---
name: akron-swarm-orchestration
description: "Orchestrate parallel multi-agent work in Akron Code using frontier `Swarm` teams (with explicit tasks, Git worktrees, and live message boards), `Task`/`Agent` subagent personas, durable `TeamCreate`/`TaskCreate` boards, and repeatable `Workflow` pipelines."
---

# Swarm, Orchestrator & Multi-Agent Execution

Choose the lightest coordination primitive that gives full parallelism and verification:

## 1. Choosing the Right Orchestration Tool
- **Single-step or tightly sequential work:** Execute directly with `Read` / `Edit` / `Bash` / `RunToolScript`.
- **Focused delegation (`Task` / `Agent`):** Spawn one or more subagents in parallel in a single assistant turn (consecutive read/agent calls execute in concurrent waves, capped safely).
  - Built-in personas (`subagent_type`): `general-purpose`, `Explore` (fast read-only), `Plan`, `Bash`, `verifier`, `code-reviewer`.
  - Options: `tier` (`small` | `heavy` | `critical`), `model`, `resume: "<agentId>"` (preserves full conversation history), `fork_context: true`, `max_turns`, `run_in_background: true` (+ `TaskOutput`), `isolation: "worktree"`.
- **Frontier Team (`Swarm`, available when user enabled Swarm / Full AI Team):**
  - Runs on **frontier models only** (`claude-fable`, `claude-sonnet`, `gemini-3/4/2.5-pro`, `gpt-5/6`, `deepseek`, `grok`, etc.; excludes small fast/mini models from Swarm leadership).
  - Pass `tasks: [{ title, prompt, tier, model, owns, isolation }]` whenever the user specifies exact subtasks — your explicit `tasks` array is preserved verbatim instead of being overwritten by the supervisor planner.
  - Set `isolation: "auto"` or `"worktree"` when multiple workers edit overlapping files so each gets an isolated Git worktree.
  - Always include concise final reporting in workers; even if a worker finishes tool calls with empty prose, the runtime synthesizes a structured summary of executed tool steps.
- **Persistent Collaboration (`TeamCreate` + `TaskCreate` / `TaskUpdate` + `SendMessage` + `TeamDelete`):**
  - Use when teammates need named inbox messaging and dependency-tracked tasks across turns (`blockedBy` / `owner` claims).
- **Deterministic Scripted Pipelines (`Workflow`):**
  - Run sandboxed Python/JS workflows with `agent()`, `parallel()`, `pipeline()`, `phase()`, replay caching (`resume`), and hard token budgets (`budget`).

## 2. Inside a Swarm Worker
Workers automatically receive board tools:
- `swarm_post`, `swarm_read`, `swarm_wait` (yields your concurrency slot while waiting for teammates — never deadlocks!), `swarm_status`, `swarm_add_worker`, `swarm_kill_worker`, `swarm_switch_model`.
- Finish every worker run with verified outputs (command exit codes, exact file paths, captured values) before exiting.

## 3. Verification & Blocker Hygiene (`TodoWrite` + `ShadowCheck`)
- Mark `TodoWrite` items `completed` only when a tool result proves completion.
- Use `ShadowCheck({ path: "..." })` for isolated single-file checks (or `ShadowCheck({ cwd })` for project-wide typecheck/lint/syntax scan).
- If an external manual action blocks completion (e.g., an extension reload or CAPTCHA), state `"Manual step needed: ..."` clearly **once** and stop calling tools — never repeat the same scorecard in a loop.
