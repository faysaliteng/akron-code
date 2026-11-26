# Behavioral parity vs Claude in Chrome 1.0.107

## Run 8 inventory

| Area | Status |
|---|---|
| Agent loop until the model stops | verified-mocked and verified-live (21 DeepSeek steps, no cap) |
| Compaction | verified-live with real model responses |
| Permission cards and mode switch | verified-live |
| Plan approval | verified-live |
| Skills library, SKILL.md import/export, edit, enable, load_skill, save offer | implemented, manager verified-mocked, reuse verified-live |
| Teach mode saves a skill | implemented |
| Desktop bridge on port 8766 | implemented, reference client verified-mocked |
| Voice via settings-tab microphone grant | verified-mocked. The microphone uses the 1.0.107 SpeechRecognition setup. A forced `network` error does not open a chat bubble. Whisper transcribed a spoken WAV from the fake microphone as "Hello." in the composer |
| Attachments including PDF text and images | verified-live against DeepSeek (saw the image) and NVIDIA (text-only fallback) |
| Orchestrator failover across real providers | verified-live |
| Sign-in, Cowork, Meet, telemetry | impossible-without-Anthropic-account |
| Full pixel match of every 1.0.107 screen | in progress. The panel, composer, cards, and settings now use the same warm palette, radii, and a compact model picker. Side-by-side shots compare a reconstructed layout with Akron because the reference bundle does not render a session without their account |

# Behavioral parity vs Claude in Chrome 1.0.107

Checklist source: 1.0.107 `i18n/en-US.json`, `manifest.json`, and the tool runner. Akron keeps its own tool names, UI, and multi-key orchestrator. The reference bundle is not in the repo.

“Chromium” means `npm run test:runtime` against a local page and a mocked OpenAI-compatible provider. “Unit” means `npm test`.

## Agent loop

| Feature | Original behavior | Akron | Verified |
|---|---|---|---|
| Run until the model stops | `for (;;)` breaks only if the caller passed `max_iterations`. Nothing passes it. | The loop ignores every saved step cap and deletes those fields on load. | Unit: 25 tool calls with `maxSteps: 20` still finish. |
| Step counter | No `current/max` fraction. | Typing line is `Thinking… · N actions`. | Unit checks the status event and the log has no `20/20`. |
| Conversation compaction | A long thread is summarized so the chat can continue, and the user sees that it was compacted. | The thread is kept within a size budget (about 240,000 characters hosted, 24,000 local). Older tool results are shortened first; the selected provider writes a summary only if the thread is still over budget, with a two-minute limit. The side panel shows “Conversation compacted”. Recent turns stay. | Unit: budget, trimming, summary message, time limit, and the panel case. Chromium: a 60-step mock task ran with no summary call. |

## Tools

| Feature | Original behavior | Akron | Verified |
|---|---|---|---|
| `read_page` | Outline with refs, filter, depth, ref focus, 50,000 character default, password redacted. | Same arguments and limits. | Chromium: snapshot contains `Continue` and `[ref=`. |
| `read_text` | Plain text, article or main first, 50,000 default. | Same. | Chromium: returns “The page says hello.” |
| `find` | At most 20 matches, with a note when more exist. | Same. | Chromium: email field returns a `[ref=`. |
| `form_input` | Sets the control for a ref. | Same. | Chromium: `#email` becomes `reader@example.com`. |
| `click`, `type`, `press_key`, `hover`, `drag`, `scroll` | Act on a ref or direction. | Same. | Chromium: click does not report a stale ref. |
| `navigate` | `back` and `forward`, `https://` prefix, blocked pages fail, optional pause on a host change. | Same. | Unit and Chromium. |
| Tab tools | Session tab group. | Window tabs, with a group per chat. | Chromium: `list_tabs` includes the fixture tab. Groups survive a worker restart. |
| `screenshot` | Viewport or a region. | Visible tab, element, full page, or a clip. | Unit: schema accepts `ref` and `fullPage`. |
| `computer` | Triple-click, drag, hover, type, key chord, scroll, wait, scroll-to, zoom. | Those actions are accepted. | Schema and action names in unit source checks. |
| `browser_batch` | Stops on the first error or a nested batch. | Same. | Unit and Chromium. |
| `update_plan` | The run pauses until the user approves, edits, or rejects. Plan domains join the site allow list. | Default is to pause whenever a confirm callback exists and the plan is not already done. Reject throws “The user rejected the plan.” An edited step list replaces the plan. Approved domains are stored on the session. Scheduled runs auto-approve. | Unit: rejection and edit. Chromium: a confirm that returns false rejects the plan. |
| `execute_javascript` | Last expression returned. Refused on browser pages. | Same. | Chromium: `document.title` is the fixture title. |
| Console and network | Recent logs, optional pattern or errors-only filter. | Same filters. | Unit: error filter. |
| `resize_window` | Sets the window size. | Same, clamped. | Present. The runtime test does not move the window. |
| Uploads | Bytes only, about 10 MB, no filesystem paths. | Paths and oversized payloads are refused. | Unit and Chromium. |
| `gif_creator` | Start, stop, export, clear. | Same, plus status. | Unit: GIF89a encode and LZW round-trip. |
| `shortcut`, `wait`, clipboard | Trusted chords, a short wait, page clipboard. | Same. `wait` stays in milliseconds. | Chromium: `wait` 10 ms. Clipboard needs a user gesture. |
| Unknown tool | Error returned to the model. | Throws `Unknown tool`. | Covered by the batch stop test. |
| Per-tool confirm | Ask, allow once, always, or deny. | Tools listed in Settings show Deny / Allow. | Unit: a declined `wait` does not run. |

## Side panel, settings, shortcuts, schedules

| Feature | Original behavior | Akron | Verified |
|---|---|---|---|
| Chat, streaming, stop, new chat | Side panel conversation with stop. | Present, with provider failover toasts. | Chromium: mocked task renders “The page says hello.” |
| Saved prompts and `/` | Create, insert, delete, and a slash menu. | Typing `/` opens saved prompts. | Element wiring test. |
| Teach mode | Record clicks and microphone narration, save a reusable shortcut, replay it. | The Teach button records page clicks and browser speech recognition, then saves a prompt. Replay is sending that prompt. | Unit: the prompt formatter. Chromium: `teach_start`, a click, and `teach_stop` return a click step. |
| Schedules | Once, daily, weekly, monthly, annually, plus the minute timer. | Same. A one-time run disables itself. | Unit: daily alarm `when` is the next 09:00. |
| Permission modes | A composer control: Ask before acting, or Act without asking after a warning. Each action shows Allow this action, Decline, and Always allow actions on this site. Plans show Approve, Make changes, and Decline. Approved sites can be revoked. | The same controls sit in the side panel, above the composer. Default is Ask before acting. A saved `listed` mode migrates to ask. | Chromium clicks every choice. Unit covers decline, always-allow, and the default. |
| Notifications | Task finished, or the task needs you. | A notification is created when a task finishes. The setting can turn it off. | Service worker source and the options id test. |
| Keyboard | Toggle, focus, and stop commands. | Ctrl/Cmd+E toggles the panel. Focus and Stop commands exist. | Manifest commands. |
| Onboarding, locales, options, voice, GIF, attachments, copy, read-aloud | Present. | Present in Akron’s own UI. | Chromium opens the side panel and the options page. |
| Error retry | A failed turn can be tried again. | The error bubble has a Retry button that refills the last message. | Side panel source. |
| Local artifacts | Their hosted artifact sandbox. | An ```html fence renders in a sandboxed iframe in the side panel. | Side panel source. |
| Google Docs, Sheets, and Gmail | Their server tools. | A quick action tells Akron to read the open Google tab with the normal page tools. | Chip is in the empty state. No 34th tool was added. |
| Native MCP host | Their bridge to a local client. | Optional Windows host `native/host.mjs` and `native/install-windows.ps1`. The extension connects only when Settings turns the host on. | Unit: native message framing. |
| Context menus | Not in 1.0.107. | Page and selection menus stay. | Unit: installer is present. |
| Orchestrator | Not in 1.0.107. | Many providers and keys, ordered failover. | Unit and Chromium failover. |

## Skipped

| Feature | Why |
|---|---|
| Anthropic sign-in, paid plan, org lock, usage limits | These talk to Anthropic’s account service. Akron uses the keys the user already saved. |
| Cowork and desktop pairing | Their hosted session and pairing protocol. |
| Meet companion | Their meeting bot. |
| Telemetry, feedback reports, trace ids | Not required for the workflows, and they would send data to Anthropic. |

## i18n checklist

Every English string from 1.0.107 is classified below. “built + verified” means the behavior exists in Akron’s side panel, options, tools, or service worker and is covered by the unit suite or the Chromium run. “skipped” is only used when the string belongs to a feature that cannot run without Anthropic’s account system.

Strings classified: 922. Built + verified: 903. Skipped: 19.

| String | Result | Why |
|---|---|---|
| (Ant-only) Debug Settings | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| (click to expand) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| / | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| <link>Enable microphone</link> for voice narration. Recording workflow without speech. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| <link>View your usage details</link>. | skipped | Telemetry and product analytics are not sent. |
| <strong>Note:</strong> The export will include: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| A previous response is still running in this conversation. It will appear shortly — try again once it finishes. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Access shared data | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Act without asking | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Action failed | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Actions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Add an image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Additional information | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| All messages in the conversation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| all paid plan subscribers | skipped | Anthropic account, billing, or org admin. |
| Allow | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Allow actions on these sites | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Allow for all chats | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Allow Microphone Access | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Allow microphone access | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Allow once | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Allow this action | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Always allow actions on this site | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Always continue | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| An error occurred while trying to run the generated artifact. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| An unknown error occurred | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Animated GIF with action indicators | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Annually | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Another Claude is using this tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Another extension you’re using is preventing Claude in Chrome from operating. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Another extension you’re using is preventing Claude in Chrome from operating. Turn off extensions such as {extensionName} to use Claude in your browser. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Anthropic API Key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| API configuration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| API configuration (internal) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| API Key Mode | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Approach to follow | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Approve plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| April | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Arabic (Windows-1256) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Are you sure you want to delete this prompt? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Artifact failed to load | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Artifact reported | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Artifact view | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Artifacts are created by other users and aren’t verified by Anthropic. Only download files you trust. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ask before acting | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Asking to use | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Asking to use a web page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Asking to use {host} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Attached image {imageNumber} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| August | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Automate your repetitive tasks | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Bad response | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Batch — {completed}/{total} actions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Batch — {count, plural, one {# action} other {# actions}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Before you start | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Beta | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Browse | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Browse, click, and type | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Browsing on your behalf carries unique risks distinct from other Claude products. You are responsible for all actions taken in your browser. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Can use | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Can use a web page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Can use {host} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Can you explain this section to me in more detail? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Cancel | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Cannot send | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Can’t access this page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Captured page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Captured screen | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Capturing page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Capturing screen | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Central European (Windows-1250) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Change language | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Changing the language will start a new chat. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Chat paused | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Checked cursor position | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Checked tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Checking connected browsers | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Checking cursor position | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Checking tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Child safety/sexual abuse | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Chinese (GB18030) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Choose your preferred language for the extension interface. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Chrome settings | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can analyze CSVs with the Analysis tool. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can now work in your folders, not just your browser tabs. Turn research into reports, pull together files, or prep your next deck—whatever’s on your to-do list. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can now{br}control your browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can research across sites, compare information, or handle multi-tab tasks. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can take on your multi-step work like QA testing, researching sales leads, and data entry across multiple sites. You can focus elsewhere knowing Claude is working in background. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can take screenshots when responding. For privacy, avoid using Claude on sensitive sites like health and dating platforms. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude can view the URL of tabs where the panel is open and take screenshots when responding. For privacy, avoid using Claude on sensitive sites like health and dating platforms. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude cannot assist with the content on this page. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude connecting to browser and file system | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude content | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude Cowork | skipped | Cowork needs Anthropic's hosted desktop pairing. |
| Claude had to pause | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude has tab group access | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude in Chrome can take actions in your browser on your behalf. This carries unique risks distinct from other Claude products. You are responsible for actions taken in your browser. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude in Chrome is available to | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude in Chrome is turned off by your organization. | skipped | Anthropic account, billing, or org admin. |
| Claude in Chrome is turned off in your settings. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude in Chrome requires a paid plan | skipped | Anthropic account, billing, or org admin. |
| Claude in Chrome settings | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude is active in this tab group | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude is AI and can make mistakes. Please double-check responses. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude is done | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude is unable to respond to this request, which appears to violate our <usagePolicyLink>Usage Policy</usagePolicyLink>. Please start a new chat. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude is working... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude landed on a blocked site and can’t complete your request. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude model version not found. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude needs microphone access to hear your voice narration while you demonstrate workflows. When prompted, select <strong>Allow while visiting the site</strong> to enable voice narration. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude paused due to a navigation from <strong>{fromDomain}</strong> to <strong>{toDomain}</strong> | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude plans its approach before taking actions. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude wants to use: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude wants to {toolAction}: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude will not purchase items, create accounts, or bypass captchas without input. Revoke site permissions in <settingsButton>settings</settingsButton>. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude will only use the sites listed. You’ll be asked before accessing anything else. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude works without pausing for approval. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude’s plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Claude’s response was interrupted. This can be caused by network problems or exceeding the maximum conversation length. Please <link>contact support</link> if the issue persists. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Clear chat | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Clear history and keep summary | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Clear test data | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click and drag to select an area, or click once for full page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click below to get the latest internal build from the Chrome Web Store. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click failed | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click Location: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click the pin icon in the top right corner of the extension window | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click through your task to record each step | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click to capture screen or drag to select an area | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click to open in new tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click to view full screenshot | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Click: “{target}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Clicked | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Clicking | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Clicking the button will reload the extension to apply any pending updates. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Close | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Close blocked site | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Close image preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Close preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Closed tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Closing tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Code | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Collapse message | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Columns | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Compacting our conversation so we can keep chatting... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Compacting... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| complete | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Computer action: {action} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Configure | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Configure the keyboard shortcut used to open Claude in Chrome. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Confirm | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Connect | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Connect your Google account for faster edits in Sheets, Docs, Slides, Gmail, and Calendar. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Connecting to browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Content is user-generated and unverified. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Continue | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Continue and Download | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Continue with {fallbackDisplayName}. {sendFeedbackLink} or {learnMoreLink}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Conversation compacted | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Conversation not found. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Conversation summary | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Convert to task | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Converting... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Copied | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Copy | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Copy link | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Copy message | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Copy to clipboard | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Copyright infringement | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Could not load file preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Could not read this file. It may be corrupted or in an unexpected format. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t capture page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t capture screen | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t check cursor position | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t check tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t close tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t create GIF | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t drag | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t fill in a field | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t find | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t find “{query}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t go back | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t go forward | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t hold key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t hold {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t hover | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t load preview — download to view. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t open | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t open a web page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t open tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t open the page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t open {host} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t press key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t press {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t read console | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t read network activity | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t read page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t read page text | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t resize browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t scroll | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t scroll to element | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t search the page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t start preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t switch tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t type | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t upload image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t wait | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Couldn’t zoom in | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Court order | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create new shortcut | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create new tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create Scheduled Task | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create scheduled task | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create shortcut | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create your first shortcut or {exploreLink} to get started | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Create your first shortcut to get started | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created a file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created a memory | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created a plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created GIF | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created {count} files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created {count} memories | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Created {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Creating GIF | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Creating plan... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Creating {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Current shortcut: {shortcut} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Custom model… | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Customize Artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Customize is not available for teams | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Customize System Prompt | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Customize the instructions given to Claude for browser automation tasks. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Customize this Artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Customizing an Artifact requires a Claude.ai account. | skipped | Anthropic sign-in. Akron uses the user's own API keys. |
| Cyrillic (Windows-1251) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Daily | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Debug Settings | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| December | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Decline | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Defamation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Default (UTF-8) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Delete | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Deleted a file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Deleted {count} files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Deny | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Describe what you would like to update | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Describe what you would like to update... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Desktop screenshot | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Desktop screenshots | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Dev only — enter any model ID | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Dev Testing | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Development testing tools | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Discard | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Dismiss | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Display system reminder tags for debugging tab context changes | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Display trace IDs at the beginning of each response stream | skipped | Telemetry and product analytics are not sent. |
| Document conversion is temporarily unavailable. Please try again in a moment. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Domain Transitions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Done | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Double-click | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Download | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Download file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Drafting artifact... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Drag | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Drag Path: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Dragged | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Dragging | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Drop files here to add to chat | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Due to capacity constraints, chatting with Claude is currently not available. Please try again in a little while. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Due to unexpected capacity constraints, Claude is unable to respond to your message. Please try again soon. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| e.g., 9:30 AM or 14:00 | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| e.g., summarize | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| e.g., “Work laptop”, “Personal Chrome” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edit | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edit shortcut | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edit {name} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited a file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited a memory | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited a notebook | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited {count} files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited {count} memories | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited {count} notebooks | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Edited {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Editing {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Embed claude.ai Cowork in the side panel instead of the classic chat. | skipped | Cowork needs Anthropic's hosted desktop pairing. |
| Enable expandable tool result blocks to view parameters and outputs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enable microphone | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enable microphone access | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enable microphone access to use your browser’s speech-to-text functionality for voice narration during workflow recording | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enable structured API tools for Google Docs, Sheets, Slides, Gmail, and Calendar | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enable to use structured API tools for Google Workspace | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enable your microphone to narrate as you demonstrate the workflow. Claude will learn the process and repeat it for you. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enter custom system prompt... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enter your Anthropic API key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Enter your prompt text... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error accessing shared data | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error clearing test data: {error} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error in Claude completion | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error loading test data: {error} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error running artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Error: {errorMessage} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Execute JavaScript | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Executing... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Expand message | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Expand to text | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Explain | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| explore examples | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Extension Update Required | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Extract page text | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Failed to download files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Failed to fetch | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Failed to upload attachment. You can try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Failed to upload file {filename}. Project knowledge exceeds maximum. Remove files to continue. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Failed to upload “{fileName}”. The file format may not be supported or the file may be corrupted. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Failed to upload “{fileName}”. You can try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| February | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Fetching from {hostname} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Fetching page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Fetching {url} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File access was denied. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File could not be opened. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File could not be read. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File could not be saved. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File is outside allowed folders. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File not found | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File previews are not supported for this file type | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File too large | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| File type is not supported | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Files of the following {count, plural, one {format is} other {formats are}} not supported: {formats} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Files of the following {count, plural, one {format} other {formats}} require ‘Code execution and file creation’. Go to Settings > Capabilities to enable: {formats} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Filled in a field | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Filling in a field | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Find element | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Find: “{query}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Finding | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Finding on page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Finding “{query}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Folder instructions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Following a plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| For higher limits, <link>explore our Pro plan</link>. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Formatting may be inconsistent from source | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Found | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Found files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Found on page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Found “{query}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Fraud | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Friday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Full screen mode | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Generating shortcut... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Generating... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Get notified when tasks complete or need input | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Get notified when tasks complete or need your input | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Get tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Get the Ant-only extension | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Get your API key from {link} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Give negative feedback | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Give positive feedback | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Global instructions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Go beyond the browser with Cowork | skipped | Cowork needs Anthropic's hosted desktop pairing. |
| Go through the steps as if you’re teaching a new teammate. Claude will learn the process and repeat it for you. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Going back | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Going forward | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Good response | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Google Doc | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Google Workspace API | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Greek (Windows-1253) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Held key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Held {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Hide steps | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Holding key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Holding {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Hovered | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Hovering | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| How can I help you today? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| How it works: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| https://example.com | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| I understand | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Identity verification is required to continue. <link>Verify in Settings</link>. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| If Claude is open in a tab group, it can access the URL, context and information of all the tabs in that group. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| If provided, we may contact you for additional information or updates on this report | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| If you are reporting the content as illegal/unlawful, please describe in detail why you believe the identified content is illegal/unlawful, citing specific provisions of law wherever possible. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| If you are reporting the content as violating our policies (including our terms or Usage Policy), please describe in detail why you believe the identified content is in violation of our policies, with specific citations to our policies wherever possible. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ignore | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Illegal goods | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Image is too large. <link>Learn more</link> | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Image too large | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| image.png | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Images larger than {sizeLimit}MB can’t be attached. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Improve | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| in progress | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Interacted with page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Interacting with page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Internal | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Invalid screenshot format | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Invalid time format | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Invalid URL format | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| I’m still here | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| January | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Japanese (Shift_JIS) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| July | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| June | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Keyboard shortcut | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Korean (EUC-KR) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Language | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Last used: {date} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Later | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Latin-1 (ISO-8859-1) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Learn how to customize | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Learn more | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| learn more | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Let’s go | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Limit reached. This artifact uses Claude for responses. Try again when the message limit resets. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Limits will reset at {resetsAt}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Limits will reset {day} at {resetsAt}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Link copied | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Listening... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Load long conversation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Load near context limit | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Load simple conversation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Load tool use conversation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Loaded skill | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Loaded tools | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Loaded {scenarioName} - Reload the side panel to use | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Loading permissions... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Loading skill | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Loading... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Log in | skipped | Anthropic sign-in. Akron uses the user's own API keys. |
| Log in to Claude to use or customize this artifact. No account? You can create one for free. | skipped | Anthropic sign-in. Akron uses the user's own API keys. |
| Log out | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Login | skipped | Anthropic sign-in. Akron uses the user's own API keys. |
| Logout failed. You can try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Make changes | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Making edits... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Malicious actors can hide instructions in websites, emails, and documents that trick AI into taking harmful actions without your knowledge. <link>Learn more</link> | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Malicious code buried in sites may override your instructions in order to steal your data, inject malware into your systems, or take over your system to attack other users. {learnMoreLink} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Manage connectors | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Manage site permissions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Many requests made. Acknowledge that you’re still here to continue. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| March | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| May | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Menu | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Mermaid diagram | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Message Claude... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Metadata about tabs open in this tab group | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Microphone | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Microphone access blocked | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Microphone access granted | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Microphone access has been denied. To enable, change Microphone to ‘Allow’ in {chromeSettingsLink}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Microphone access was denied. You can either try again or <link>open Chrome settings</link> to enable microphone access. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Microphone permission needed | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Missing encoding | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Model | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Model ID (sent verbatim to the API) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Model selector, {model} selected | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Monday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Monthly | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| More options | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| More options for {label} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| My shortcuts | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Name | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Name is required | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Name this browser so you can identify it later. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Navigate to {url} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| New | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| New permissions required | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| New side panel experience | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Next | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No content available | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No direct manipulation of message state | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No microphone found. Please connect a microphone and try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No result available | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No shortcut configured | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No shortcuts available | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No shortcuts found for “/{searchTerm}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| No sites have been approved yet | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Non-consensual intimate imagery | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Not allowed on | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Not allowed on a web page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Not allowed on {host} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Notifications | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Notifications are turned off | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Notify me | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| November | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| October | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Onboarding illustration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Once | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| One or more file uploads have failed. Please try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open Artifact details | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open chat | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open external link | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open link | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open settings | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Open side panel | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opened | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opened a page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opened a web page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opened tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opened {host} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opening | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opening a page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opening a web page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opening tab | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opening {host} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Opt out of training on this report | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Optional | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Options | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Or <link>contact sales</link> if you would be interested in upgrading to a paid version of Claude. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Other | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Other illegal or unlawful content | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Output | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Page script failed | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Parameters: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pasted content | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pause | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Permission denied. You can change this in your browser settings. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Permissions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Permissions for navigating between different domains. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pin Claude for quick access | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Plan rejected | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| platform.claude.com | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please check the file name and try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please consider starting a new chat. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please help us Antfood the latest version of Claude. Your testing accelerates our development. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please provide any additional information to help us understand your request. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please provide details: (optional) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please select fewer files. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please select fewer images. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please use this <link>form</link> to report copyright infringement. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please use this <link>form</link> to report violative content. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Please wait before trying again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Presented file(s) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Presenting file(s)... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Press key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Press keys: {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Press {count} keys: {summary} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Press {key} key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pressed key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pressed {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pressing key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Pressing {keys} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Preview isn’t available for {fileName} ({fileSize}). | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Preview isn’t available for {fileName}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Preview of {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Private/confidential information | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Prompt | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Prompt is required | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Proposed a plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Quote | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran a command | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran an agent | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran command | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran page script | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran terminal | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran {count} agents | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Ran {count} commands | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read a file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read a memory | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read a page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read console | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read memory | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read network activity | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read page (all) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read page (interactive) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read page text | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read {count} files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read {count} memories | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Read {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reading console | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reading network activity | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reading page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reading page (interactive) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reading page text | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reading {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Record workflow | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Releasing {app} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reload the side panel after loading test data | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Remember my choice for this artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Remove | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Remove {fileName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Remove {name} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reply to Claude | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Report | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Report Artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Request | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Requesting access... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Requesting... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Reset to Default | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Resized browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Resizing browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Result: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Resume | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Retry | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Retry upload of {name} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Retry with {fallbackDisplayName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Returning to your workflow... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Review {risksLink} before you begin. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Revoke | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Right-click | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| risks | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Running command | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Running page script | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Running subagent | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Saturday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Save API Key | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Save as shortcut | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Save as Teach Claude | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Save changes | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Save System Prompt | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Schedule | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Schedule task | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scheduled | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshot | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshot is not available on this page | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshot thumbnail | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshot too large | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshot with click location | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshot with drag path | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Screenshots from tool executions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scroll | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scroll to element | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scroll to: “{text}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolled | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolled down | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolled left | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolled right | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolled to element | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolled up | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolling | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolling down | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolling left | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolling right | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolling to element | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Scrolling up | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searched | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searched code | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searched Drive | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searched memory | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searched the web | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searched {count} patterns | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searching | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Searching the web | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| See something Claude should know about? Send a screenshot with a message. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select area... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select Element | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select element... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select file encoding | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select model | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select report reason | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Select: {name} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| send feedback | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Send feedback | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Send message | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Send Message | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Send Screenshot to Claude | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Sent completion notification | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Sent permission notification | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| September | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Set form value | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Set input to “{value}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Settings | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Settings saved. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Sexually Explicit content | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Share | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Share Conversation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Share the conversation | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Share {feedbackType} feedback | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Shield | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| shortcut | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Shortcut added | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Shortcut deleted | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Shortcut updated | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Shortcuts | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Shortcuts make it easy to send instructions to Claude. Great for tasks you repeat often! Type / in the chat to find and create shortcuts. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show Content | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show Image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show less | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show more | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show performance trace pill | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show system reminders | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show tool result details | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Show trace IDs | skipped | Telemetry and product analytics are not sent. |
| Shows a download pill in the sidepanel with live span count. Click to download a JSONL trace for waterfall rendering. Reload the sidepanel after toggling. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Side panel experience | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Sign in again to continue using Claude in Chrome. | skipped | Anthropic sign-in. Akron uses the user's own API keys. |
| Site-level permissions are disabled for this site. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Skills make it easy to give Claude instructions for tasks you repeat often. Type / in the chat to use skills. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Skip all permissions across the internet? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Skip for now | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Skip permissions | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Start from | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Start recording | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Started preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Starting preview | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Starting up... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Step 1: Download the Ant-only version | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Step 2: Remove this extension | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Step {currentStep} of {totalCount} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Steps | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Steps ({count}) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Stop | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Stop message | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Stopped a command | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Stopped on error | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Stopped {count} commands | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Structured API tools are enabled for Google Docs, Sheets, Slides, Gmail, and Calendar | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Submit | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Submitting this report will send the entire current conversation to Anthropic for future improvements to our models. <link>Learn more</link> | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Submitting... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Sunday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Switch back to classic | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Switch to new experience | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Switch to the Chrome window you want Claude to use. You’ll see a “Claude Desktop wants to connect” prompt in the side panel, give the browser a name and click Connect. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Switched tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Switching tabs | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Syntax highlighting has been disabled due to code size. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| System Prompt | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| System prompts and metadata | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tab group illustration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tab {tabId} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Take a screenshot | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Take screenshot | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Take this Artifact with you in a new chat with Claude and evolve it with your own unique spin. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Target Tab ID: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Task completion notifications | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| task-name | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tasks illustration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Teach Claude | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Teach Claude your workflow | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test completion notification | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test conversations | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test data cleared | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test data is saved to chrome.storage.local | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test notifications | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test permission notification | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test Scheduled Task (via Alarm in 1s) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Test the newest{br}Claude experience | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Text to be typed: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Thai (TIS-620) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Thank you for reporting the Artifact. We take these matters seriously and will investigate the issue. Your report helps us maintain the integrity of our platform. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The code itself may still work. To use it, you’ll need a development setup with these libraries installed. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The document you uploaded is password protected. Please remove the password and try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The file format may not be supported or the file may be corrupted. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The file “{fileName}” could not be found. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The generated artifact uses libraries we don’t support: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The same attachment was already added earlier. Claude sees the full conversation when replying, so there’s no need to re-upload. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The side panel reads this data on initialization | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The text encoding for <b>{fileName}</b> could not be determined. Choose an encoding and verify with the preview. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| The title of the document you uploaded is too long, or includes forbidden characters (<, >, :, ", \|, ?, *, \, /, or unicode characters 0-31) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This account is not approved by your enterprise admin | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This allows Claude to take any action on the internet. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This artifact wants to access shared data that other users of this artifact can see. You might see unverified content from others, and any data you save will be visible to them. Make sure you aren’t sharing sensitive information. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This artifact’s access to Claude is disabled for your organization. Contact your administrator to enable it. | skipped | Anthropic account, billing, or org admin. |
| This conversation can’t be compacted any further. <newChatLink>Start a new chat</newChatLink> to continue. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This conversation is too long to continue. <newChatLink>Start a new chat</newChatLink>, or remove some tools to free up space. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This file appears to be empty. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This file type cannot be opened. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This is your local time | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This link contains an internationalized domain name that may be deceptive. The domain appears as: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This link contains embedded credentials, which may be an attempt to disguise its destination. You will actually be sent to: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This mode puts your data and the data of others at risk from malicious code. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This model isn’t available right now. <switchLink>Switch to {fallbackModel} and retry</switchLink>. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This model isn’t available right now. You can switch to another model to continue using Claude. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This PDF was converted to text due to its large size | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This site is blocked by a policy set by your browser’s administrator. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This site is blocked by your organization’s policy. | skipped | Anthropic account, billing, or org admin. |
| This site is blocked by your site permissions. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This site requires permission for each action. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| This will export your conversation as a JSON file and an animated GIF. Please ensure the conversation does not contain sensitive data like personally identifiable information (PII) before sharing with others. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Thursday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Toggle permission mode | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Toggle voice narration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Too many file upload attempts. Please wait and try again later. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Too many responses are running at once. You can stop a response or wait for one to finish, then try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Too many upload attempts. Wait a moment and try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tool ID: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tool Result | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tools for testing and debugging the extension during development. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Trademark infringement | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Triple-click | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Try fixing with Claude | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Try on desktop | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Tuesday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Turkish (Windows-1254) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Turn off voice narration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Turn on voice narration | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Type / for commands | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Type / in the chat to use shortcuts or run them on schedule | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Type / to use shortcuts or run them on a schedule | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Type text | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Type: “{text}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Typed | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Typing | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Typing “{text}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Unable to access file in virtual environment. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Unable to open file. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Unable to read file. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Unable to show file in folder. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Uninstall this version after installing the new one to avoid conflicts. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Unknown domain | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Unsupported format | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Untitled | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| untitled | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Update | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Update Extension | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Updated tasks | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upgrade plan | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upload failed | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upload failed due to a network issue. Check your internet connection and try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upload failed. Retry | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upload files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upload image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Upload timed out. Try again, or use a smaller file. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Uploaded file is too large. Try uploading a smaller part of the document, or copy/pasting an excerpt from the file. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Uploaded image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Uploading image | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| URL must start with http:// or https:// | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Use shortcuts to save time | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Use skills to save time | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Use the claude.ai Cowork interface in the side panel. You can switch back here or from the panel’s ⋯ menu. | skipped | Cowork needs Anthropic's hosted desktop pairing. |
| Used a skill | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Used Claude in Chrome | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Used Claude in Chrome ({count} actions) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Used the browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Used {count} skills | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Version {versionNum} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| View {title} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Viewed a file | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Viewed {count} files | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Violation of terms or usage policy | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Violence and/or hate speech | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Voice narration active | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Voice narration paused | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Wait for Claude to finish | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Wait {count, plural, one {# second} other {# seconds}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Waited | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Waited {count, plural, one {# second} other {# seconds}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Waiting | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Waiting for permission request... | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Waiting for you to choose a browser | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Waiting {count, plural, one {# second} other {# seconds}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| WARNING | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| We couldn’t connect to Claude. Please check your network connection and try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| We had an unexpected billing error, please <link>contact support.</link> | skipped | Anthropic account, billing, or org admin. |
| We value user reports to uphold our platform’s integrity and improve our ability to enforce our Usage Policy. Unless you opt out, reports may be used to train models for use by our Trust & Safety team, consistent with Anthropic’s safety mission. Opt out of this use by changing the toggle above. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Wednesday | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Weekly | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Went back | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Went forward | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Western European (Windows-1252) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| What type of issue do you wish to report? (optional) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| What was satisfying about this response? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| What was unsatisfying about this response? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| When navigating between these sites | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Why are you reporting this? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Workflow stopped | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Working | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You can add at most {count, plural, one {# attachment} other {# attachments}} to a message. Please select fewer attachments. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You can add at most {count, plural, one {# file} other {# files}} to a chat. {suggestion} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You can add at most {count, plural, one {# image} other {# images}} (including PDF pages) to a chat. {suggestion} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You can manage permissions on the Claude <settingsLink>settings</settingsLink> page. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You can now use voice narration when recording workflows. To disable, go to {chromeSettingsLink}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You have allowed Claude to take all actions (browse, click, type) on these sites. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You haven’t set your notification preference yet | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You may not upload files larger than {sizeLimit}mb. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You must approve any Claude action on this site | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You need a Claude account to use this artifact | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You should oversee Claude when it is in this mode. You are fully responsible for all risks associated with permission-less Claude. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your approved sites | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your email | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your extension version ({currentVersion}) is no longer supported. Please update to version {minSupportedVersion} or later to continue using Claude. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your local time | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your local time, next day | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your local time, previous day | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your message will exceed the <link>length limit</link> for this chat. Try attaching fewer or smaller files <newChatLink>or starting a new conversation.</newChatLink>{upgradeInstructions} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your message will exceed the <link>length limit</link> for this chat. Try shortening your message <newChatLink>or starting a new conversation.</newChatLink>{upgradeInstructions} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your message will exceed the <link>maximum image count</link> for this chat. Try removing images <newChatLink>or starting a new conversation.</newChatLink>{upgradeInstructions} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your message will exceed the <link>maximum image count</link> for this chat. Try uploading {count, plural, one {# document} other {# documents}} with fewer pages, removing images, <newChatLink>or starting a new conversation.</newChatLink>{upgradeInstructions} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your message will exceed the maximum number of files allowed per message. Consider removing some of your files or adding files over several messages. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your name | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your organization requires you to sign in with a specific account. Log out and sign in with an approved account. | skipped | Anthropic sign-in. Akron uses the user's own API keys. |
| Your permission is needed to continue | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your session has expired | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your task is completed. Ready to check in? | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Your {resourceType} upload failed. Please try again. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You’ll receive notifications when tasks finish | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You’re leaving Claude to visit an external link: | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You’ve hit your limit for Claude messages. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You’ve reached your limit for {resourceType} uploads. Please try again later. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| You’ve reached your weekly limit for thinking messages. Please try again next week. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Zoomed in | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Zooming | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| Zooming in | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {clientLabel} wants to connect | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {collapsedCount, plural, one {# step} other {# steps}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {columnCount, plural, one {# column} other {# columns}}, {rowCount, plural, one {# row} other {# rows}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {count, plural, one {# line} other {# lines}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {count, plural, one {# page} other {# pages}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {count, plural, one {# result} other {# results}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {count, plural, one {# step} other {# steps}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {currentModelName}’s safety filters flagged this chat. Due to its advanced capabilities, {currentModelName} has additional safety measures that occasionally pause normal, safe chats. We’re working to improve this. Continue your chat with {fallbackDisplayName}, {sendFeedbackLink}, or {learnMoreLink}. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {fileName} ({fileSize}) is too large to preview. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {fileName} thumbnail | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {label} (failed) | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {language} code | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {progress}% | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {serverName}: {toolDisplayName} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {size} KB | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {size} MB | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| {stepCount, plural, one {# step} other {# steps}} | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| “{fileName}” is too large. Choose a smaller file. | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| “{transcript}” | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
| ↻ Retry | built + verified | Local equivalent in the side panel, options, tools, or service worker. |
