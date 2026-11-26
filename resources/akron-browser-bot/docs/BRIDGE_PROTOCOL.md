# Akron desktop bridge

A future desktop app connects as the server. The extension connects outbound.

- URL: `ws://127.0.0.1:8766`
- Frames: one JSON object per WebSocket text message
- Reference listener: `node native/bridge-client.mjs`

## Messages

| Type | Direction | Body |
|---|---|---|
| `ping` / `pong` | either | |
| `pairing_request` | desktop to extension | `request_id`, `client_type` |
| `pairing_response` | extension to desktop | `request_id`, `device_id`, `name`, or `dismissed: true` |
| `run_task` | desktop to extension | `request_id`, `text` |
| `task_accepted` | extension to desktop | `request_id` |
| `permission_request` | extension to desktop | `request_id`, `message`, `kind` |
| `permission_response` | desktop to extension | `request_id`, `allowed` |
| `skill_list` / `skill_get` / `skill_put` / `skill_delete` | desktop to extension | skill `id` or `name`, and `skill` on put |
| `skill_*_result` | extension to desktop | the skill or list |
| `settings_get` / `settings_result` | either | non-secret settings only |
| `error` | either | `message` |

The extension shows a permission card before it accepts a pairing request. API keys are not part of this protocol.
