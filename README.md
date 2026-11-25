# ⚡ Helio Bot

**Helio Bot** — a Example Desktop–compatible desktop AI agent that runs
on **any free LLM API** (OpenAI-compatible).

Built by reverse-engineering Example Desktop (`/Applications/Claude.app`, Electron 45.3.3)
with REA and reproducing its full feature surface on a pluggable local/remote LLM layer.

---

## Features (feature parity with Example Desktop)

| Example feature | Helio Bot equivalent |
|---|---|
| Streaming chat w/ markdown + code | ✅ SSE streaming, `marked` + `highlight.js` + DOMPurify |
| Agent tool loop (full classic surface, **56 tools**) | ✅ built-in function-calling loop with no-tools fallback |
| MCP (Model Context Protocol) client | ✅ stdio JSON-RPC MCP client (`initialize` / `tools/list` / `tools/call`); MCP tools + resources auto-exposed to the agent |
| Sub-agents (`Task` / `Agent`) | ✅ parallel recursive sub-agents + `TaskStop` / `ListAgents` |
| Interactive questions (`AskUserQuestion`) | ✅ paused-agent UI round-trip with options + 5-min auto-resolve |
| Plan mode (`ExitPlanMode`) | ✅ agent pauses for user approval of the plan |
| Artifacts panel | ✅ auto-extracts code blocks + explicit `Artifact` tool → tabbed viewer |
| Long-term memory | ✅ persistent memory (`.auto-memory`) injected into prompts, list/add/clear |
| Skills registry | ✅ built-in + custom `.md` skills, loaded by the `Skill` tool |
| Notebooks (`NotebookRead` / `NotebookEdit`) | ✅ Notebooks panel + cell editor |
| Terminal / shells (`KillShell` + `mcp__terminal__*`) | ✅ persistent multi-tab shell manager + Terminal view |
| Code execution (`REPL`, `JavaScript`, `Bash`, `Cd`) | ✅ js/python/bash via local runtime; mutable cwd |
| Provider config | ✅ OpenAI-compatible presets: Ollama, LM Studio, Groq, OpenRouter, OpenAI, Custom |
| **Orchestrator Mode** | ✅ multi-provider/key failover — auto-switches to the next model on rate-limit / limit-reached |
| **Feature toggles** | ✅ Computer Use, Chrome (CDP), and bot-bridge local equivalents (config-gated) |
| Conversation persistence | ✅ `localStorage` (conversations, provider, settings, orchestrator, features) |
| Integrations (`Jira`, `Linear`) | ✅ config-gated via env vars |
| Slash commands | ✅ `/help /clear /compact /model /review /memory /reset /status` |

Full reverse-engineering report + feature map: [`FEATURES.md`](FEATURES.md).

---

## Run it

```bash
cd autobot
npm install
npm run build
npm start
```

First run: open **⚙️ Settings** and pick a provider preset (or paste your own
OpenAI-compatible base URL + key), then **Test connection**.

### Free LLM presets

| Preset | Base URL | Needs key |
|---|---|---|
| Ollama (local) | `http://localhost:11434/v1` | no |
| LM Studio (local) | `http://localhost:1234/v1` | no |
| Groq (free tier) | `https://api.groq.com/openai/v1` | yes |
| OpenRouter (free models) | `https://openrouter.ai/api/v1` | yes |

### Tool toggles

The agent exposes the complete classic Example Code tool surface (56 total definitions)
to the model: `Bash, Edit, Write, Read, Glob, Grep, WebSearch, WebFetch, Task, Agent,
TodoWrite, NotebookEdit, NotebookRead, AskUserQuestion, KillShell, SlashCommand, Skill,
ExitPlanMode, MultiEdit, REPL, JavaScript, Cd, ListMcpResources, ReadMcpResource,
TaskStop, ListAgents, SendUserMessage, SetGoal, ToolSearch, Artifact, Jira, Linear`
— plus virtual built-in MCP namespaces (`mcp__workspace__*`, `mcp__terminal__*`,
`mcp__memory__*`, `mcp__skills__*`, `mcp__secrets__*`) and any connected MCP server's
tools (namespaced `mcp__<server>__<tool>`).

### 🔄 Orchestrator Mode (multi-key failover)

Add **100+ API keys** in **⚙️ Settings → Orchestrator Mode** and toggle it on. When a
provider returns a rate-limit / quota / "limit reached" error (HTTP 429, `quota`,
`insufficient_quota`, billing/capacity/throttle messages), Helio Bot automatically fails
over to the **next** provider+model in your list — without interrupting the stream. You
select which models participate (each row = name + base URL + key + model) and which one
starts first (radio `#1`, `#2`, …). Failover events are shown in-chat as
`🔄 orchestrator: model A → model B`.

### 🚀 Feature toggles (local equivalents of server-side features)

| Server-side feature | Local equivalent (config-gated in Settings) |
|---|---|
| `mcp__computer__*` (Computer Use) | macOS screen capture + `osascript` System Events mouse/keyboard — gated by **Computer Use** toggle |
| Chrome control (CDP) | `ws`-based CDP client (`chrome.js`) — connect to `--remote-debugging-port=9222`, gated by **Chrome** toggle (host/port configurable) |
| `mcp__cowork__*` / `mcp__ccd_*` | cowork orchestration + cloud-continuity-drain registry (`cowork.js`) |
| Bot bridges (`hearthbot`/`slackbot`/`teamsbot`/`webagent`) | local HTTP webhook bridge server (`cowork.js`) — gated by **Bot bridges** toggle |
| `mcp__visualize__visualize` | built-in SVG chart renderer (`visualize.js`) |

---

## Architecture

```
autobot/
├── electron/          # Electron main process (CommonJS)
│   ├── main.js        # window + IPC handlers + agent orchestration + feature gates
│   ├── preload.js     # contextBridge (window.autobot.*)
│   ├── llm.js         # OpenAI /v1/chat/completions SSE + function-calling loop + orchestrator failover
│   ├── tools.js       # built-in tools (executors + schemas) + virtual MCP namespaces
│   ├── mcp.js         # stdio MCP client
│   ├── visualize.js   # SVG chart renderer (mcp__visualize__visualize)
│   ├── computer.js    # macOS screen + input control (Computer Use, gated)
│   ├── chrome.js      # Chrome CDP client (gated)
│   ├── cowork.js      # cowork orchestration + CCD + bot-bridge webhook server
│   └── store.js       # memory / settings / skills / orchestrator / features persistence (~/.autobot)
├── src/               # React renderer (Vite)
│   ├── main.jsx
│   ├── App.jsx
│   └── styles.css
├── index.html         # CSP (allows local http/https/ws for LLM endpoints)
└── package.json
```

Runtime data lives in `~/.autobot/` (`memory.json`, `settings.json`, `skills/`,
`orchestrator.json`, `features.json`).
