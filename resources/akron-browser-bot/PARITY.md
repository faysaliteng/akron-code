# Akron ↔ Claude in Chrome — feature parity

Status legend: **✅ parity** · **➕ beyond** (Akron does more) · **➖ intentional** (needs a backend/native host; out of scope by design).

Verified against the Claude in Chrome extension surface (`Claude`, v1.0.107, MV3)
and the tool registry found in its bundle. Akron is an independent implementation.
Per-feature behavior, including what changed in this pass, is in `docs/PARITY-VERIFICATION.md`.

## Agent tools

| Claude tool | Akron | Evidence |
|---|---|---|
| `read_page` | ✅ | accessibility snapshot + stable `[ref=eN]` handles |
| `read_text` | ✅ (➕) | plain visible text |
| `click` | ✅ | |
| `type` | ✅ | |
| `scroll` | ✅ | |
| `press_key` | ✅ (➕) | |
| `navigate` | ✅ | |
| `open_tab` | ✅ | |
| `list_tabs` | ✅ (➕) | |
| `switch_tab` | ✅ (➕) | |
| `go_back` / `go_forward` | ✅ (➕) | |
| `screenshot` | ✅ (➕) | visible tab, element `ref`, or `fullPage` |
| `find` | ✅ | text/role search with fresh refs |
| `form_input` | ✅ | selects, checkboxes, radios, dates, numbers, ranges |
| `hover` | ✅ | |
| `drag` | ✅ | |
| `upload_image` | ✅ | data URL / URL / text |
| `file_upload` | ✅ | file inputs **and** drag-and-drop drop zones |
| `read_console_messages` | ✅ | MAIN-world hooks |
| `read_network_requests` | ✅ | MAIN-world fetch/XHR hooks |
| `resize_window` | ✅ | |
| `group_tabs` / `ungroup_tabs` | ✅ (➕) | |
| `update_plan` | ✅ | plan card, and the run pauses until approve, edit, or reject |
| `browser_batch` | ✅ | nested batches refused to avoid loops |
| `computer` | ✅ | real CDP mouse/keyboard, hover, drag, scroll, wait, screenshots |
| `shortcut` | ✅ | trusted key combos |
| `gif_creator` | ✅ | `start` / `stop` / `export` / `clear` / `status` |
| `wait` | ✅ | |
| `execute_javascript` | ✅ | run JS in the page's main world (CDP), return JSON |
| `read_clipboard` / `write_clipboard` | ✅ | system clipboard via the page |
| `load_skill` / `save_skill` | ✅ (➕) | skill instructions on demand; saving needs approval |
| `save_result` | ✅ (➕) | collected values kept for the whole task and listed at the end |

**36 tools total.** `tests/autobot-test.mjs` asserts every tool exists, has an
object schema, and has a matching `executeTool` branch.

## Side panel

| Feature | Status | Notes |
|---|---|---|
| Chat + streaming replies | ✅ | SSE for Anthropic/OpenAI/Gemini, automatic non-streaming fallback |
| Tool-call cards | ✅ | one plain line per step ("Opened example.com", "Clicked Sign up"); opens to show the tool name, args, result, and screenshots |
| Live status while working | ✅ | status line follows the current step with an action count; short preview of the model's thinking when the provider streams it |
| One panel per tab | ✅ | no window-wide panel; opening on another tab starts that tab's own session; Ctrl+E toggles the current tab's panel |
| Tab grouped when its panel opens | ✅ | the tab joins its own orange group the moment the panel opens |
| Group dissolved when the panel closes | ✅ | half a second after the panel closes (in case it is only reloading) its tabs leave the group, as in Claude; the chat is kept and opening the panel again groups the tab again. One difference: a task that is still running keeps its group until it ends, because in Akron a task goes on without the panel |
| Status on the group title | ✅ | ⌛ working, 🔔 waiting for approval, ✅ finished out of sight (cleared when a tab of the group is looked at) |
| Plan card | ✅ | `update_plan` planning / in-progress / done |
| Stop / new chat | ✅ | |
| Provider + model switchers | ✅ | multiple providers at once |
| Screenshot previews | ✅ | thumbnails inline in tool cards |
| Copy reply | ✅ | per-message Copy button |
| Saved prompts | ✅ | save current composer text, insert, delete |
| Scheduled tasks list | ✅ | run-now button, status, manage link |
| Tabs & groups UI | ✅ | list/switch, multi-select group, ungroup |
| Automatic agent tab group | ✅ (➕) | one group per session; multiple groups per window |
| Task starts on the panel's tab | ✅ | every model call carries the current tab (id, title, address without query) and the group's other tabs, like Claude's tab context; the prompt says the request is about the current tab unless another site is named |
| Multi-tab work in one group | ✅ | `open_tab` adds a tab to the group; `list_tabs` / `switch_tab` move between the group's tabs |
| Tools confined to the group | ✅ | as in Claude, `list_tabs` shows only the task's own tabs and `switch_tab` refuses a tab outside the group; the user's other tabs are never read or taken over |
| `find` sees plain text | ✅ | besides controls it returns visible text that is not inside a control (a mail row, a table cell) with a ref on the nearest clickable element |
| Independent per-tab sessions | ✅ (➕) | new tab = fresh chat; same group = same chat; own task/stop/group |
| Chat history list | ✅ (➕) | 🕘 corner list of every past chat; New chat, a closed tab and a browser restart keep the conversation, and it opens again in the panel you are in |
| Claude-style light UI | ✅ | warm cream/coral theme across all pages |
| Animated mark | ✅ (➕) | the Akron mark has a clear background (light and dark), moves in the header and on the welcome screen, and is a still picture when the system asks for reduced motion |
| Attachments | ✅ | images + text, click / drag-drop / paste |
| On-page working indicator | ✅ | green frame + "Akron is working here" banner with Stop on the task's tabs; left out of screenshots |
| Pointer with the running step | ✅ | the arrow is on the page for the whole task; its tag names the running step ("Reading the page text") and shows "Akron" between steps |
| "Needs your input" on the page | ✅ | amber banner with an "Open chat" button that opens that tab's panel with the waiting approval |
| Long-running tasks | ✅ | no step limit; waits out rate limits / 5xx / dropped connections; 20 s worker keep-alive; context kept within a size budget (older tool results shortened first, summary only if still too large, capped at 2 minutes) |
| Collected results survive long tasks | ✅ (➕) | `save_result` values are kept outside the conversation, sent with every model call, added under the final answer if the model leaves them out, and shown when a task is stopped; never in the history list or notifications |
| Voice input | ✅ | Web Speech where the browser has it; recording + local Whisper otherwise (works in Brave); provider transcription optional |
| Read replies aloud | ✅ | Speech Synthesis, opt-in |
| GIF record button | ✅ | red dot, shift-click discards, toast status |
| Confirmation modal | ✅ | per-site and per-tool, deny/allow |
| Orchestrator status + toggle | ✅ (➕) | live active endpoint, failover toast, quick on/off |
| Reply persistence | ✅ | saved before broadcast; survives worker restart |
| Error + retry states | ✅ | streaming failures retried; errors shown |
| Empty state + suggestion chips | ✅ | |
| Keyboard shortcut | ✅ | Ctrl/Cmd+Shift+E |

## Settings & platform

| Feature | Status | Notes |
|---|---|---|
| Any provider API key | ✅ | Anthropic, OpenAI, Gemini, any OpenAI-compatible |
| Orchestrator mode / 100+ keys | ✅ (➕) | pool = selected models × every key; ordered failover and cooldowns |
| Model discovery | ✅ | automatic `/models` refresh in the side panel + `Fetch models` button |
| Connection test | ✅ | |
| Step limit | Removed | The loop runs until the model stops calling tools. A saved `maxSteps` (including 20) is deleted on load and is not shown as `N/N`. |
| Temperature | ✅ | |
| Streaming toggle | ✅ | |
| Send screenshots toggle | ✅ | |
| Completion chime | ✅ | offscreen WebAudio |
| Read-aloud toggle | ✅ | |
| Domain allow/block lists | ✅ | host suffix + `*.domain` + `*` |
| Ask before new sites | ✅ | per-host approval cache |
| Ask before chosen tools | ✅ | 36-tool checklist |
| Scheduled tasks | ✅ | Minute intervals, plus once / daily / weekly / monthly / annually at a local time |
| Saved prompts | ✅ | |
| Skills (built-in + custom) | ✅ | injected into the system prompt |
| Context menus | ✅ | page/selection: summarize, ask, fill form |
| Notification click | ✅ | opens the schedules page with the last result |
| Onboarding page | ✅ | first-run welcome, setup status, feature tour |
| Localisation | ✅ | manifest strings in en/de/es/fr/ja/zh_CN |
| Local-only storage | ✅ | `chrome.storage.local`; no backend/proxy |
| Any Chrome/Edge/Brave | ✅ | MV3, Chrome 116+ |

## Intentional exclusions

| Claude feature | Why not included |
|---|---|
| Claude account / OAuth sign-in | Akron is bring-your-own-key; no account system |
| Cowork / Claude cloud tasks | Requires Anthropic backend |
| Google Meet integration | Requires a backend and meeting bot |
| Native MCP bridge | Requires a native messaging host; breaks zero-install |
| Telemetry / analytics | Deliberately omitted; local-only |

These are the only ❌ rows. Everything that can be implemented inside a
zero-backend MV3 extension is implemented.

## Verification

Run inside the extension folder:

```bash
npm test              # 786 checks
npm run check         # syntax-check every JS file
npm run test:runtime  # real Chromium end-to-end test
```

Last run of `npm test`:

```
==== 786 passed, 0 failed ====
```

Last run of `npm run test:runtime` (real Chromium, unpacked extension):

```
  ok   service worker running
  ok   manifest version 1.6.7
  ok   debugger permission
  ok   offscreen permission
  ok   test page opened
  ok   live models discovered
  ok   options page has orchestrator UI
  ok   agent ran read_text
  ok   agent opened a second tab
  ok   agent tab group created
  ok   second tab joined the group
  ok   orchestrator failed over past the bad key
  ok   final answer rendered
  ok   no panel errors
  ok   tool result stored
  ok   open_tab result stored
  ok   turn completed
  ok   final answer saved to storage
  ok   new tab side panel has a fresh session and its own group
  ok   original tab keeps its conversation
  ok   fresh tab task completed
  ok   fresh session created its own group
  ok   two sessions have two groups
  ok   chat history stores separate sessions
  ok   tool behavior read_page
  ok   tool behavior read_text
  ok   tool behavior find
  ok   tool behavior form_input
  ok   tool behavior email
  ok   tool behavior click
  ok   tool behavior teach
  ok   tool behavior navigate_back
  ok   tool behavior list_tabs
  ok   tool behavior wait
  ok   tool behavior browser_batch
  ok   tool behavior update_plan
  ok   tool behavior execute_javascript
  ok   tool behavior navigate_https
  ok   tool behavior navigate_blocked
  ok   tool behavior file_paths
  ok   tool behavior plan_gate
  ok   reply survives worker restart
  ok   tab group survives worker restart

RUNTIME: all checks passed
```

Live DeepSeek run (`deepseek-chat`, real browser): the side panel auto-loaded
`deepseek-flash`, `deepseek-v4-pro`, and `deepseek-chat`; orchestrator started with
a deliberately invalid key and the real key second. The first call returned 401,
the panel showed `authentication failed — switching to … (key 2/2)`, and the next
call succeeded. DeepSeek then used `read_page`, `browser_batch`, `click`, and
`read_page` to fill a live form (`Name = Optimus`), set a `<select>` to `High`,
click **Submit**, and read `Submitted: Optimus (high)` back. The reply survived a
worker restart. No key is stored in the repository or zip.

Separately, onboarding, side panel, and options pages were loaded in Chromium 147
with **zero console exceptions**, and the options page exposed all 36 tool-permission
checks.

Coverage highlights:

1. **Adapters** — request shapes, auth headers, endpoint URLs, tool-schema mapping,
   multi-image content, tool-result history for all three families. Gemini tool-call
   signatures are kept, sent back with the call, and replaced by Google's stand-in
   for a call another provider made (after a failover). A provider that refuses
   another model's `reasoning_content` is asked again without it, and a wait given
   only in the error text is read.
2. **Streaming** — feeds real SSE through a mocked `ReadableStream` reader:
   OpenAI text + fragmented tool calls, Anthropic `content_block_delta` +
   `input_json_delta`, Gemini `streamGenerateContent`, and the fallback path when
   the stream endpoint fails or returns no text.
3. **Agent loop** - tool call → tool result → final answer; plan events; streamed
   delta IDs finalized by `assistant_final`.
4. **Tab groups / sessions** - active tab joins the group, `open_tab` adds a second
   tab, a normal new tab opens a fresh session, switching back restores the first
   chat, a second task creates a second group, and both groups/replies survive a
   worker restart.
5. **Orchestrator** - 100 keys → 100 endpoints, ordered pools, 429/401/404/5xx
   cooldowns, `Retry-After`, live failover, all-endpoints-failed aggregation,
   scheduled-task failover, and provider `ProviderError` status metadata.
6. **Domain policy** — exact host, wildcard, allow-list restriction, block-beats-allow,
   block-everything, invalid URL.
7. **Confirmation gate** — deny blocks the tool and reports “declined”; allow runs it.
8. **Scheduler** — enabled schedules create alarms, disabled ones don't, removals clear them.
9. **GIF** — real encoder output parsed as GIF89a: signature, dimensions, frame count,
   palette, LZW round-trip for solid colours and a 64×64 gradient.
10. **UI wiring** — every `$("id")` in each page script exists in its HTML; every port
   message type emitted by the service worker or agent has a side-panel case.
11. **Manifest** — every referenced file exists, all permissions present,
   `default_locale` set, six complete locales.
