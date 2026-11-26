# 🤖 Akron — by akronlogic.com

A **bring-your-own-key** AI browser agent for Chrome / Edge / Brave.

It works like *Claude in Chrome* — a side panel where you ask for something and an
agent reads the page, clicks, types, scrolls, opens tabs, takes screenshots, and
records GIFs — but instead of one vendor account, **you plug in any provider API key
you like** (Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, xAI, Mistral,
Together, Ollama, LM Studio, or any OpenAI-compatible endpoint).

No account. No proxy. No backend. Your key goes straight from your browser to the
provider you chose.

---

## Install (load unpacked)

1. Open `chrome://extensions` (or `brave://extensions` / `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select this folder (the one that contains
   `manifest.json`).
4. Click the Akron icon in the toolbar (or press **Ctrl+E**) to open the side panel.
5. On first install the **Welcome** page opens. Add a provider from **Settings**.

> There is no build step. The folder *is* the extension. Edit any file and press
> the reload ↻ button on `chrome://extensions` to apply changes.

---

## Add an API key

**New to API keys?** [docs/API-KEYS.md](docs/API-KEYS.md) explains, provider by
provider, where to get a key, how to enter it, how to use it, and what each
provider is good for (including the free ones).

Settings → **API keys & providers**:

1. Pick a preset from the dropdown (e.g. *Anthropic (Claude)*) → **Add provider**.
2. Paste your key. The Base URL and model list are pre-filled; edit them freely.
3. **Fetch models from provider** fills the model list from the provider's own API.
4. **Test connection**, then **Save provider**.
5. Under **Agent settings**, choose the active provider + model and save.

The side panel also auto-discovers the active provider's live model list when it
opens (for example DeepSeek returns `deepseek-flash` and `deepseek-v4-pro`), merges
it with your saved names, and persists it. You do not need to click Fetch for the
model dropdown to show every available model.

You can add several providers at once and switch between them from the side panel
header at any time.

### Supported presets

| Preset | API style | Default endpoint |
|---|---|---|
| Anthropic (Claude) | `anthropic` | `https://api.anthropic.com` |
| OpenAI | `openai` | `https://api.openai.com/v1` |
| Google Gemini | `gemini` | `https://generativelanguage.googleapis.com/v1beta` |
| OpenRouter | `openai-compatible` | `https://openrouter.ai/api/v1` |
| Groq | `openai-compatible` | `https://api.groq.com/openai/v1` |
| DeepSeek | `openai-compatible` | `https://api.deepseek.com/v1` |
| FreeLLMAPI (local router) | `openai-compatible` | `http://localhost:3001/v1` |
| TokenRouter | `openai-compatible` | `https://api.tokenrouter.com/v1` |
| xAI (Grok) | `openai-compatible` | `https://api.x.ai/v1` |
| Mistral AI | `openai-compatible` | `https://api.mistral.ai/v1` |
| Together AI | `openai-compatible` | `https://api.together.xyz/v1` |
| Ollama (local) | `openai-compatible` | `http://localhost:11434/v1` |
| LM Studio (local) | `openai-compatible` | `http://localhost:1234/v1` |
| Custom | `openai-compatible` | your URL |

Local endpoints (localhost / 127.0.0.1 / `.local`) don't require a key.

FreeLLMAPI is the exception: it runs locally at `http://localhost:3001` but still
requires its unified `freellmapi-…` key. Its model list loads automatically from
`/v1/models`, so pick the preset, paste the unified key, and use **Fetch models**.

---

## What the agent can do

`TOOL_DEFS` exposes **36 tools** to the model:

| Tool | Purpose |
|---|---|
| `read_page` | Accessibility snapshot of the tab with `[ref=e12]` element handles |
| `read_text` | Plain visible text of the page |
| `click` | Click an element by ref |
| `type` | Focus a field and type (optionally submit) |
| `press_key` | Send a key to the focused element |
| `scroll` | Scroll the page or an element |
| `navigate` | Go to a URL in the current tab |
| `open_tab` | Open a URL in a new tab |
| `list_tabs` | List the task's own tabs (the current tab and its group) |
| `switch_tab` | Move to another tab of the task's group by id |
| `go_back` / `go_forward` | History navigation |
| `screenshot` | Visible tab, one element (`ref`), or the whole page (`fullPage`) |
| `wait` | Pause for async loading |
| `find` | Search visible elements and visible text (a list row, a table cell) by text or role |
| `form_input` | Set selects, checkboxes, radios, dates, numbers, ranges, colours |
| `hover` | Reveal tooltips / hover-only menus |
| `drag` | Drag one element onto another |
| `upload_image` | Attach files to a file input (data URL, URL or text) |
| `read_console_messages` | Read the page's console output |
| `read_network_requests` | Read the page's fetch/XHR activity |
| `resize_window` | Resize the browser window (responsive testing) |
| `group_tabs` / `ungroup_tabs` | Manage tab groups |
| `update_plan` | Publish a step-by-step plan in the side panel |
| `browser_batch` | Run several actions in one call and get all results |
| `computer` | **Trusted** mouse/keyboard/screenshot via the Chrome DevTools Protocol |
| `shortcut` | Press keyboard shortcuts (e.g. `ctrl+a`, `ctrl+t`) as trusted events |
| `file_upload` | Attach files to a file input **or** a drag-and-drop drop zone |
| `gif_creator` | Record the tab as an animated GIF (`start` → `export`) |
| `execute_javascript` | Run arbitrary JS in the page and return the JSON result |
| `read_clipboard` | Read text from the system clipboard |
| `write_clipboard` | Write text to the system clipboard |
| `load_skill` | Load the full instructions of one enabled skill |
| `save_skill` | Propose a new or updated skill (stored only after you approve) |
| `save_result` | Save one thing the task was asked to collect, or note why it could not be collected |

The model decides which to call, sees the results, and repeats until it has an
answer — the same agent loop pattern the Claude extension uses, just provider-agnostic.

### Collected results (`save_result`)

A long task that gathers values (API keys, links, codes, prices) from several
sites used to lose them: older page reads are shortened to keep the context
small, and nothing made the model repeat the values at the end. Now:

- The model calls `save_result` the moment it has a value, before the next site.
  An item that cannot be collected is saved with an empty value and the reason,
  and the task goes on to the next one.
- Saved results are kept per chat, outside the conversation, and are sent to the
  model with every call, so shortening or summarising older steps cannot drop them.
- The final answer always ends with the full list. If the model leaves any of it
  out, Akron adds "Saved results (X of Y collected)" under the answer.
- If the task is stopped or fails, the chat still shows "Saved before the task
  stopped" with everything saved so far.
- Saved values stay in the chat only. The history list, the notification, the
  step row and read-aloud never show or speak them. **New chat** clears them.

### Trusted input (`computer` / `shortcut`)

Some sites ignore synthetic DOM events. `computer` attaches `chrome.debugger`,
sends real `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` calls, then
detaches. It supports left/right/middle/double click, hover, drag, type, key
combos, scroll, wait, and element/full-page screenshots. Chrome shows a small
“started debugging this browser” infobar while it is attached.

### GIF recording

Click the red dot in the side panel toolbar (or call `gif_creator`) to record the
visible tab. Frames are captured about twice a second, capped at 80 frames and
960 px wide, then encoded locally to GIF89a in an offscreen document and saved
through the Downloads API. Shift-click the red dot to discard a recording.

### Streaming

Anthropic, OpenAI, and Gemini use SSE streaming, so replies appear token by token.
If an endpoint doesn't support streaming, or returns a plain JSON body, Akron
automatically retries once without streaming.

---

## Tab groups and multi-tab work

Akron behaves like Claude in Chrome's isolated workspace:

- The side panel belongs to the tab you opened it on (like Claude's
  `sidepanel.html?tabId=…`). There is no window-wide panel: switch to another tab
  and no panel shows there until you open one on it, and coming back shows the
  first tab's panel again. **Ctrl+E** opens the panel on the current tab and
  closes it if it is already open there.
- Opening the panel on a tab puts that tab in its own tab group at once (default
  title **Akron**, orange), like Claude. Every tab = its own session + its own
  group. A pinned tab, or a tab you already keep in a group of your own, is left
  alone until a task starts there.
- Closing the panel takes that chat's tabs out of the group again, like Claude
  (half a second later, in case the panel is only reloading). The chat itself is
  kept: open the panel on that tab again and it shows the same chat and groups
  the tab again. A task that is still running keeps its group until it ends,
  because a task goes on without the panel.
- The group's title shows how its task stands: **⌛** while it works, **🔔** when
  it waits for your approval, **✅** when it finished while you were on another
  tab. The tick goes away when you look at one of the group's tabs.
- Every chat is kept. **New chat** puts the current conversation aside instead
  of deleting it, and so does closing its tab or restarting the browser. Open
  the **🕘** history button in the corner to list every past chat (title,
  preview, group, time) and open one again in the panel you are in. A chat that
  is in use in another panel takes you to that tab instead; the chat you are
  looking at is marked "open here". Panels with no messages are not listed.
- The Settings page can stay open while you work. It shows what the panel and
  running tasks save (permission mode, approved sites, results of scheduled
  tasks, new skills) as it happens, and a save there writes only what you
  changed on the page.
- A task starts on the tab its panel is on, like Claude. Before every step the
  model is told where it is: the current tab's id, title and address (without
  the query string), the other tabs of its group, and that your request is about
  the current tab unless you name another site. It is told not to jump to a
  different service that does the same job (another mail site, another shop) as
  a guess, but to say what it looked at and ask.
- When a task needs more than one page it adds tabs to its own group: tabs
  opened with `open_tab` and link-opened tabs during a task join the group. Tabs
  in one group share one conversation and can be read/switched/worked across
  together.
- The task's tools reach only its own tabs, like Claude: the current tab, the
  tabs grouped with it, and the tabs it opened. `list_tabs` shows only those and
  `switch_tab` refuses any other tab, so your other open tabs are never read or
  taken over. To let Akron use a tab you already have open, drag it into the
  Akron group.
- A tab outside the group gets its own session. Open the panel on another tab of
  the same group and it shows the same chat; open it on any other tab and it
  starts a fresh one.
- **＋ New chat** releases the current group and starts a new session; the next task
  creates a new group.
- Multiple groups/sessions can exist in one window, each with its own conversation,
  running task, Stop controller, and approvals. Tasks keep running when you switch
  to another tab's session, so you can start a second task in another tab while the
  first one works. A background task screenshots its own tab and opens or switches
  tabs without taking the screen; if it needs an approval it waits (no countdown)
  until you return to its tab, and a notification tells you it is waiting.
- While Akron works in a tab, that page shows a green glowing frame and a banner
  reading **Akron is working here** with a **Stop** button. Only the tabs of the
  running task show it, Stop on the page stops that task, and the indicator is left
  out of Akron's own screenshots. It disappears when the task ends.
- When the task waits for your approval the banner turns amber and reads **Akron
  needs your input**, with an **Open chat** button that opens that tab's panel
  with the question in it.
- A green pointer arrow is on the page for the whole task. Its tag names the step
  that is running ("Reading the page text", "Clicking", "Opening example.com")
  and says **Akron** between steps. It moves to wherever Akron hovers, clicks,
  types or drags, with a ripple on each click.
- The panel says what is happening as it happens. The line above the composer
  follows the current step and counts the actions so far ("Opening
  example.com… · 6 actions"), with a short preview of the model's thinking under
  it when the provider sends one. Each finished step is one plain line ("Opened
  example.com", "Clicked Sign up", "Read the page text"); open a line to see the
  tool name, its arguments and its result. Text typed into a page and field
  values are not shown on these lines.
- Akron plans on its own and shows the plan as a progress list. To review plans
  before they run, turn on **Settings → Agent settings → Ask me to approve
  Akron's plan** (never asked in "Act without asking" mode).
- The side panel shows the live group name and tab count, with a **Release** button
  that ungroups the agent's tabs.
- Grouping is configurable in **Settings → Agent settings** (on/off + group name).
- Conversation and group are restored after an MV3 worker restart.

The interface uses a warm cream/coral **Claude-style light theme** across the side
panel, settings, and welcome pages.

## Orchestrator mode (multi-key failover)

Orchestrator mode turns your providers into one large failover pool.

1. Open a provider in Settings and paste **Extra API keys for orchestrator**, one
   per line. The primary key plus every extra key becomes a separate endpoint.
   You can add 100+ keys this way.
2. In **Settings → Orchestrator mode**, tick **Enable** and select every model that
   should participate.
3. The pool is the selected models × every API key on those providers. For example,
   3 models on a provider with 100 keys = 300 endpoints.
4. Click **Save orchestrator**.

At runtime:

- Akron keeps using the last working endpoint until it fails.
- On a **rate limit / quota**, **401/403 auth failure**, **404 model error**,
  **5xx/529 overload**, **network error**, or a rejected stream, that endpoint is
  cooled down (default 60 s for rate limits) and the **same step** is retried on the
  next endpoint. Partial streamed text is discarded so the answer is not duplicated.
- A provider's own wait time is used for the cooldown, whether it arrives in a
  `Retry-After` header or only in the error text (Gemini: "Please retry in
  17h29m15s"). An endpoint that has used up a daily quota is rested until then
  instead of being asked again every minute.
- A step made by one provider can be continued by another. Gemini's tool-call
  signatures are kept and sent back (a call another provider made gets Google's
  stand-in), and a provider that refuses another model's `reasoning_content`
  (Groq) is asked again without it.
- **Max endpoints to try per step** defaults to 200 (all of a 100+ key pool).
- The side panel has an Orchestrator toggle and a live status line:
  `Active: Provider / model (key 2/4) · 4 endpoints`, plus a toast whenever a
  failover happens.
- Scheduled tasks use the same pool.

Cooldowns are tracked per endpoint while the service worker is alive. A successful
call clears that endpoint's cooldown.

### Local key file (optional)

A `local-provider.json` next to `manifest.json` pre-loads providers, their keys and
the orchestrator pool when the extension loads, so nothing has to be typed into
Settings. The file is gitignored and left out of the zip: keys in it stay on this
machine.

```json
{
  "version": 2,
  "providers": [
    {
      "id": "free-groq",
      "name": "Groq (free)",
      "type": "openai-compatible",
      "baseUrl": "https://api.groq.com/openai/v1",
      "apiKey": "…",
      "models": ["openai/gpt-oss-120b"],
      "defaultModel": "openai/gpt-oss-120b"
    }
  ],
  "orchestrator": {
    "enabled": true,
    "endpoints": [{ "providerId": "free-groq", "model": "openai/gpt-oss-120b" }]
  }
}
```

- The file is applied once per `version`. Raise the number to apply it again.
- A provider that is already stored keeps everything you set in Settings; only a
  missing key is filled in.
- `orchestrator.endpoints` go to the front of the pool in the order written (the
  pool is tried from the top). Models you had already selected stay, after them.
  `"enabled": true` switches orchestrator mode on.
- List a provider's models in the file when it has no model list of its own
  (Cloudflare Workers AI answers **Fetch models** with HTTP 405).

### Long tasks

A task has no step limit and is meant to run for as long as the work takes:

- A temporary provider problem (rate limit, 5xx, dropped connection, or every
  endpoint cooling down) does not end the task. Akron says so in the status line,
  waits (2 s, 4 s, 8 s … up to 60 s, or as long as the provider's `retry-after`
  asks), and tries the same step again, up to 10 times in a row. It gives up only
  on a permanent failure (bad key, unknown model), when a provider asks for a wait
  longer than 5 minutes, or when you press **Stop**.
- While a task runs, the offscreen page messages the background worker every 20 s
  (with an alarm as a second guard) so the browser does not shut the worker down
  during a slow model call, even with the side panel closed.
- The conversation is kept within a size budget (about 240,000 characters for a
  hosted model, 24,000 for a local one) instead of being summarized every few
  steps. When it grows past the budget, older tool results are shortened first;
  a summary is written only if that is not enough, and it is given at most two
  minutes so a slow provider cannot stall the task. The task in your own words
  is always carried along, so the model still knows what it is working on.

---

## Productivity features

### Scheduled tasks

Settings → **Scheduled tasks**: give a prompt, an interval in minutes, and an
optional start URL. Akron opens a background tab on each tick, runs the task,
stores the result, shows a notification, plays a chime, and closes the tab.
Clicking the notification opens the schedules page with the last result.
The side panel also has a **📌 → Scheduled tasks** list with a **Run** button.

### Saved prompts

Save the current composer text with **📌 → Save current input**, or manage them
in Settings. Click a saved prompt to drop it back into the composer.

### Skills

Built-in skills add reusable instructions to the system prompt:

- **Form filler** — map fields carefully and verify before submitting.
- **Research summarizer** — read several tabs and produce sourced bullets.
- **Web app QA** — exercise a flow and report console/network errors.

Enable them in Settings → **Skills**, or add your own name/description/instructions.

### Voice, attachments, clipboard

- 🎤 **Voice input**: click the mic, speak, click the mic again. **Settings → Agent
  settings → Voice** chooses the engine:
  - **Auto** (default) uses the browser's speech service where there is one
    (Chrome). Where there is none (Brave), it records the microphone and recognises
    the words on your computer with a local Whisper model (English, downloaded once
    on first use). Recordings of any length are recognised in full.
  - **Local Whisper** always recognises on your computer.
  - **Browser speech** only uses the browser's speech service; in Brave it tells
    you to pick Auto or Local Whisper.
  - **Provider transcription** sends the recording to your provider's `/audio/transcriptions`
    (`whisper-1`). If the provider does not offer that, Akron says so.
- Spoken notes while **teaching** a workflow use the same engine.
- **Read replies aloud** can be enabled in Agent settings (Speech Synthesis).
- 📎 Attach images or text files, drag files onto the composer, or paste an image.
- Every assistant reply has a **Copy** button.

### Context menus

Right-click a page or a selection:

- Summarize this page with Akron
- Ask Akron about this page
- Fill this form with Akron
- Summarize selection with Akron
- Ask Akron about selection

Akron opens the side panel and runs the matching prompt.

---

## Permissions and safety

Settings → **Permissions & domains**:

- **Allowed domains** — if non-empty, only these hosts are permitted.
- **Blocked domains** — always refused; wins over the allow list.
- **Ask before Akron touches a new site** — per-host approval prompt.
- **Ask before these tools run** — per-tool confirmation, checked individually.

Patterns are host suffixes: `example.com` also covers `app.example.com`, and
`*.example.com` matches subdomains. `*` blocks everything. The guard is enforced
in the service worker for every page-touching tool and for `navigate` / `open_tab`.

Confirmations appear in a modal in the side panel; denying a tool stops that
action and reports the refusal back to the model.

---

## Architecture

```
manifest.json                 MV3 manifest (v1.6.7)
background/
  service-worker.js           session, panel port, confirmations, context menus
  agent.js                    tool-calling loop + streaming + fallback + failover
  providers.js                Anthropic / OpenAI / Gemini / compatible adapters
  orchestrator.js             key pool, endpoint expansion, cooldowns, ordered failover
  tools.js                    36 tool schemas + execution
  cdp.js                      chrome.debugger: trusted input, element/full-page capture
  prompts.js                  system prompt + domain policy + active skills
  storage.js                  chrome.storage.local persistence, skills, schedules, prompts
  chat-store.js               past chats: list, file under an id of their own, read, remove
  scheduler.js                chrome.alarms scheduled tasks
  run-task.js                 shared provider/model/skill resolution for task runs
  gif.js                      frame capture + export orchestration
  offscreen-host.js           single offscreen document lifecycle + audio
shared/
  presets.js                  provider presets
  local-seed.js               applies the optional local-provider.json (keys + pool)
  panel.js                    side panel address per tab + the close message
  step-labels.js              plain wording for steps, the status line, thinking preview
  markdown.js                 answers as safe HTML: lists, headings, code, links
  results.js                  results saved with save_result: list rules, report, masking
  group-title.js              status mark on the tab group's title (⌛ 🔔 ✅)
  tab-context.js              "where you are" block of the prompt: current tab + group tabs
  brand.js                    the product's name and maker, and the check that they are unchanged
  brand-seal.js               fingerprints of the logo files (written by npm run brand:seal)
content/
  page-hooks.js               MAIN-world console + fetch/XHR hooks
  agent-overlay.js            snapshot, refs, click/type/form/hover/drag/upload,
                              working banner + pointer arrow
sidepanel/                    chat UI, streaming, plan, prompts, tabs, GIF, voice
options/                      providers, agent, tools, skills, schedules, prompts
onboarding/                   first-run welcome page
offscreen/                    GIF89a encoder (LZW), chime, worker keep-alive, local speech model (in its own thread)
_locales/                     en, de, es, fr, ja, zh_CN manifest strings
tools/seal-brand.mjs          renews the logo fingerprints after the owner changes the logo
tests/                        node test suite (786 checks)
```

**Flow**

1. Side panel sends a message over a `runtime.connect` port.
2. Service worker appends it to the conversation and calls the selected provider
   with streaming enabled (falling back to non-streaming).
3. Provider returns text and/or tool calls.
4. The service worker executes tool calls against the active tab via the content
   script, CDP, or Chrome tab APIs, and feeds results back.
5. Plan updates, tool cards, screenshots, and streamed deltas are broadcast to the panel.
6. Loop repeats until the model answers without calling tools, or the user hits **Stop**.
   There is no step cap. A `maxSteps` value saved by an older version is ignored.

---

## Verification

```bash
npm test              # 786 checks, 0 failures
npm run test:live     # optional real NVIDIA/DeepSeek run; skips if the env keys are absent
npm run check         # syntax-check every JS file
npm run test:runtime  # real Chromium end-to-end test (61 checks)
```

`npm run test:runtime` launches a Chromium build with the unpacked extension,
serves a local mock OpenAI-compatible provider, and drives the side panel through
a complete task. It auto-detects Playwright's Chromium; set `CHROME_PATH` to use
another Chromium/Chrome binary that accepts `--load-extension`.

Last runtime run:

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
  ok   new tab side panel has a fresh session
  ok   original tab keeps its conversation
  ok   fresh tab task completed
  ok   fresh session created its own group
  ok   two sessions have two groups
  ok   reply survives worker restart
  ok   tab group survives worker restart

RUNTIME: all checks passed
```

### Live DeepSeek run

A real-browser run was also performed with a live DeepSeek `deepseek-chat` key:

- the provider was configured with a deliberately invalid first key and the real
  key second, with orchestrator mode enabled
- the live model list loaded into the side panel automatically:
  `deepseek-flash`, `deepseek-v4-pro`, and `deepseek-chat`
- streaming was enabled; the first call returned **401**, the panel showed
  `authentication failed — switching to … (key 2/2)`, and the next call succeeded
- DeepSeek then used `read_page`, `browser_batch`, `click`, and `read_page` to fill a
  live form (`Name = Optimus`), set a `<select>` to `High`, click **Submit**, and
  read the result area
- the page ended at `Submitted: Optimus (high)` and the final reply matched exactly
- after the run, the reply was persisted and survived a worker restart

No API key is stored in the repository or the zip.

The unit suite covers:

- tool registry and every `executeTool` branch
- Anthropic / OpenAI / Gemini non-streaming **and** SSE streaming adapters,
  multi-image messages, tool-call fragment assembly, and streaming fallback
- Gemini tool-call signatures: kept when a reply is read, sent back with the call,
  Google's stand-in for a call another provider made, none for Gemini 2.x / Gemma,
  and the model's private thinking kept out of the reply
- reasoning handed to another provider: asked again without it when refused,
  remembered per host, still sent to providers that need it
- a wait written only in the error text ("Please retry in 17h29m15s") is read
- the local key file: providers added without touching stored ones, its models put
  at the front of the orchestrator pool, nothing rewritten when nothing is new
- the full agent loop, plan events, and streamed deltas
- domain allow/block policy
- per-tool confirmation gate (deny and allow)
- **orchestrator**: 100 keys → 100 endpoints, ordered pools, cooldowns,
  `Retry-After`, 401/429/5xx classification, live failover, all-endpoints-failed
  aggregation, and scheduled-task failover
- live model discovery (`/models`) and reply persistence across a worker restart
- schedules / saved prompts / built-in skill merging
- alarm creation and cleanup
- a **GIF round-trip**: encode with the real encoder, parse the GIF container,
  LZW-decode frames, and compare pixels including a 64×64 gradient
- manifest files, permissions, all six locales, and every side-panel/options/
  onboarding element ID used by the scripts
- every port message type the service worker or agent sends has a panel handler

See [`PARITY.md`](PARITY.md) for the 1:1 feature comparison.

---

## Name and logo

"Akron Browser Bot", "Akron" and the logo belong to akronlogic.com and may not
be changed ([LICENSE](LICENSE)). The extension checks its own name, maker and
logo files when a task starts; a copy in which they were changed refuses to run
tasks. [TRADEMARK.md](TRADEMARK.md) explains the check, how strong it is, how
the owner renews it after a logo change (`npm run brand:seal`), and why a
signed Chrome Web Store package from a private repository is the real lock.

---

## Security & privacy

- Keys are stored in `chrome.storage.local` for **this Chrome profile only**.
- They are sent only to the provider endpoint you configured.
- The extension requests `<all_urls>` because it must read and interact with
  whatever page you point it at, and call arbitrary provider endpoints.
- Screenshots are only sent to the model if you enable **Send screenshots** in
  Agent settings (needs a vision-capable model).
- GIF frames and the encoder run locally; nothing is uploaded.
- Treat keys like passwords. Anyone with access to this browser profile can read
  them. Revoke a key at the provider if you stop using it.

---

## Limitations

- Browser-internal pages (`chrome://`, `edge://`, `brave://`), the Web Store, and
  the PDF viewer cannot be automated.
- `computer` and `shortcut` show Chrome's debugger infobar while attached.
- Pages loaded before you installed/updated the extension may need a refresh.
- Tool support varies by model. Models without function/tool calling won't be able
  to drive the browser; pick a tool-capable model.
- Speech recognition depends on the browser and may need a network connection.
- Scheduled tasks need a start URL for page tools (otherwise they run on `about:blank`).
- Element refs are per-snapshot; the agent is instructed to re-read the page after
  navigation.
- Orchestrator failover is reactive: Akron keeps using the working endpoint
  until it fails. It does not proactively spread requests across keys. Cooldowns
  live in the service-worker memory and reset when the worker is evicted.
- Check your provider's terms before rotating a large number of keys.
- Local model servers (Ollama / LM Studio) must allow requests from browser
  extensions. If a local test fails, enable CORS on the server (e.g. set
  `OLLAMA_ORIGINS=*` for Ollama, or enable CORS in LM Studio's server settings).

---

## Relationship to the Claude extension

This project was built after studying the Claude in Chrome extension
(`Claude`, v1.0.107, MV3). It borrows the same high-level architecture —
service worker agent loop + accessibility-tree content script + side panel +
options page — but is an independent implementation with a different goal:
**any provider, any key, fully local**.

Claude's tool registry (verified in its bundle): `read_page, find, form_input,
computer, navigate, browser_batch, upload_image, read_console_messages,
read_network_requests, resize_window, update_plan, gif_creator, shortcut, wait,
screenshot, click, type, scroll, open_tab, file_upload, drag, hover`.

Akron implements every one of those, plus `read_text`, `press_key`, `list_tabs`,
`switch_tab`, `go_back`, `go_forward`, `group_tabs`, and `ungroup_tabs`.

Account/OAuth, native MCP, Cowork, Meet, and telemetry are intentionally out of
scope: they require a backend or a native host, which would break the
“bring-your-own-key, no server” design.
