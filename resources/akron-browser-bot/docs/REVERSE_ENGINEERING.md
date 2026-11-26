# Skills, shortcuts, and the desktop bridge in Claude in Chrome 1.0.107

The reference bundle is not shipped in this repo. These notes are from reading its built files.

## Shortcuts

Saved prompts live in the side panel slash menu. Typing `/` filters them. A shortcut is a reusable instruction, not a skill file. The original also schedules shortcuts.

## Voice, side by side

The only `SpeechRecognition` in 1.0.107 is the teach-mode narration control in `sidepanel-C79rwKTq.js`. Akron uses that same setup for the microphone button.

| Step | 1.0.107 | Akron |
|---|---|---|
| Recognition | `new (SpeechRecognition or webkitSpeechRecognition)`, then `continuous = true`, `interimResults = true`, `lang = "en-US"`. | Same three settings. Language is the Settings value, default `en-US`. |
| On-device | Not present. | If `SpeechRecognition.available({ processLocally: true })` exists, that is tried before the cloud service. |
| Permission check | `navigator.permissions.query({ name: "microphone" })`. Only `granted` counts. | Same query. |
| No permission | Tooltip “Microphone permission needed”. The workflow screen opens `options.html#permissions?requestMicrophone=true&returnTabId=`. | The first microphone click opens that same options URL. It does not add a chat message. |
| Options grant | `getUserMedia({ audio: true })`, stop the tracks, then require `permissions.query` state `granted`. “Allow this time” shows: You selected "Allow this time" which doesn't persist. Please click the button again and select "Allow while visiting the site" to enable voice narration. | Same calls and the same sentence. |
| No device | Options banner: “No microphone found. Please connect a microphone and try again.” | Same sentence. |
| Button on | Brand-colored microphone. Tooltip “Turn off voice narration”. | The microphone button stays active until speech stops. |
| Button off | Microphone with a slash. Tooltip “Turn on voice narration”. | The button returns to its idle icon. |
| Results | Final segments are kept. Interim text replaces the previous interim. The teach list shows “Listening...” or the quoted interim. | Final text is kept in the composer. Interim text replaces the previous interim. |
| `no-speech` | Ignored. | Ignored. |
| `not-allowed` | Sets “Microphone permission denied” and stops. It is not a chat bubble. | Same sentence, in the composer status line. Not a chat bubble and not a Retry button. |
| Start failure | “Speech recognition not supported in this browser”, “Microphone permission not granted”, “Failed to start speech recording”. | Same sentences, in the composer status line. |
| `onend` while still recording | Calls `start()` again. If that throws: “Speech recognition stopped unexpectedly”. | Same restart. Same sentence if it cannot restart. |
| `network` | The handler ignores every code except `not-allowed` and `no-speech`, so a network failure just ends the session. | No error is shown. The samples already captured from the granted microphone are transcribed on device with Whisper (`Xenova/whisper-tiny.en`, downloaded once and cached). The working method is remembered. |

## Teach mode and voice

Workflow recording uses the page and the Web Speech API (`SpeechRecognition`, `continuous`, `interimResults`). Final phrases are kept. Interim text is shown and then replaced. `no-speech` is ignored. `not-allowed` is a permission error. `onend` restarts while recording is still on.

A side panel cannot show the microphone prompt. The original opens `options.html#permissions?requestMicrophone=true&returnTabId=…`. That page calls `getUserMedia({ audio: true })`, stops the tracks, and checks that the permission stayed `granted`. See `assets/sidepanel-C79rwKTq.js` and `assets/options-CSAKac7n.js`.

## Skills

The side panel treats a `SKILL.md` file as a skill block (“Loading skill” / “Loaded skill”). The catalog is separate from the full instructions. Akron follows that split: names and descriptions stay in the system prompt, and `load_skill` reads the body.

## Memory

“Read memory” and “Edited a memory” go through Anthropic’s account. Akron stores skills locally instead.

## Desktop bridge

`assets/service-worker.ts-z5o5oPsj.js` connects to `ws://localhost:8765` in local mode, otherwise `wss://bridge.claudeusercontent.com`. Types include `pairing_request`, `pairing_response`, `permission_response`, `tool_request`, `tool_result`, `ping`, and `pong`. Akron uses the same shapes on port 8766. See `docs/BRIDGE_PROTOCOL.md`.
