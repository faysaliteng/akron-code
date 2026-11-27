'use strict';
// Akron Bot — lifecycle hooks (Claude Code parity).
//
// Claude Code lets a user attach shell commands, prompts, or agents to ten
// lifecycle events. Akron Bot implements the same ten events and the same
// on-disk contract, so a `.claude/settings.json` hooks block works unchanged.
//
// EVENTS
//   PermissionRequest  PreToolUse  PostToolUse  PostToolUseFailure
//   Notification       Stop        PreCompact   PostCompact
//   UserPromptSubmit   SessionStart
//
// CONFIG  (settings.json)
//   { "hooks": { "PreToolUse": [ { "matcher": "Write|Edit",
//                                  "hooks": [ { "type": "command",
//                                               "command": "node fmt.js",
//                                               "timeout": 30,
//                                               "statusMessage": "formatting" } ] } ] } }
//
// A `matcher` is a regex over the tool name ("" or "*" matches everything).
// Types: `command` works on every event; `prompt` and `agent` are only
// meaningful for tool events (they get the tool call as context).
//
// STDIN (command hooks) — a single JSON object:
//   { session_id, tool_name, tool_input, tool_response, hook_event_name, cwd }
//
// STDOUT — optional JSON:
//   { systemMessage, continue, stopReason, suppressOutput, decision, reason,
//     hookSpecificOutput: { hookEventName, additionalContext,
//                           permissionDecision: "allow"|"deny"|"ask",
//                           permissionDecisionReason, updatedInput } }
//
// Exit code 2 blocks the action; any other non-zero exit is a non-fatal error.
// A `permissionDecision` of "deny" in hookSpecificOutput blocks the tool call.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const EVENTS = [
  'PermissionRequest', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'Notification', 'Stop', 'PreCompact', 'PostCompact',
  'UserPromptSubmit', 'SessionStart',
];

const TOOL_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']);
const MAX_HOOK_OUTPUT_BYTES = 50 * 1024;
const MAX_STREAM = MAX_HOOK_OUTPUT_BYTES;

function capHookText(s, limit = MAX_HOOK_OUTPUT_BYTES) {
  const str = String(s == null ? '' : s);
  const bytes = Buffer.byteLength(str, 'utf8');
  if (bytes <= limit) return str;
  const note = `\n...[hook output truncated to ${Math.round(limit / 1024)} KB (was ${bytes} bytes)]`;
  return Buffer.from(str, 'utf8').subarray(0, Math.max(0, limit - Buffer.byteLength(note, 'utf8'))).toString('utf8') + note;
}

function expand(p) { return String(p || '').replace(/^~(?=$|\/)/, os.homedir()); }

function readJSON(file, fb) {
  try { if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  return fb;
}

// Hooks come from the project's .claude/settings.json plus the user-level one.
// Project hooks win on identical matcher+command (last one registered wins).
function loadHookConfig(cwd) {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const includeUser = process.env.AUTOBOT_DISABLE_USER_HOOKS !== '1';
  const sources = [
    includeUser ? path.join(claudeDir, 'settings.json') : null,
    cwd ? path.join(String(cwd), '.claude', 'settings.json') : null,
    includeUser ? path.join(os.homedir(), '.autobot', 'hooks.json') : null,
  ].filter(Boolean);
  const merged = {};
  for (const ev of EVENTS) merged[ev] = [];
  for (const file of sources) {
    const cfg = readJSON(file, null);
    if (!cfg || !cfg.hooks || typeof cfg.hooks !== 'object') continue;
    for (const ev of EVENTS) {
      const list = cfg.hooks[ev];
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        if (!entry || !Array.isArray(entry.hooks)) continue;
        merged[ev].push({
          matcher: entry.matcher == null ? '' : String(entry.matcher),
          hooks: entry.hooks.filter((h) => h && h.type).map((h) => ({
            type: String(h.type),
            command: h.command ? String(h.command) : null,
            prompt: h.prompt ? String(h.prompt) : null,
            timeout: h.timeout != null ? Number(h.timeout) : 60,
            statusMessage: h.statusMessage || h.status_message || null,
          })),
          source: file,
        });
      }
    }
  }
  return merged;
}

function matches(matcher, toolName) {
  const m = String(matcher || '').trim();
  if (!m || m === '*' || m === '.*') return true;
  if (!toolName) return true;
  try { return new RegExp('^(?:' + m + ')$').test(toolName); } catch (_) {
    return m === toolName;
  }
}

function runCommandHook(hook, payload, cwd) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const shFile = process.platform === 'win32' ? 'powershell.exe' : require('./paths').defaultPosixShell();
    const shArgs = process.platform === 'win32'
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', hook.command]
      : ['-l', '-c', hook.command];
    const child = spawn(shFile, shArgs, { cwd: cwd || process.cwd(), windowsHide: true });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} done({ exitCode: 124, stdout: out, stderr: 'timeout', timedOut: true }); }, Math.max(1, hook.timeout || 60) * 1000);
    child.stdout.on('data', (d) => { if (out.length < MAX_STREAM) out += d; });
    child.stderr.on('data', (d) => { if (err.length < MAX_STREAM) err += d; });
    child.on('error', (e) => { clearTimeout(timer); done({ exitCode: 1, stdout: out, stderr: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); done({ exitCode: code == null ? 1 : code, stdout: out, stderr: err }); });
    try {
      child.stdin.write(JSON.stringify(payload || {}));
      child.stdin.end();
    } catch (_) { try { child.stdin.end(); } catch (_) {} }
  });
}

function parseHookOutput(stdout) {
  const s = String(stdout || '').trim();
  if (!s) return {};
  // Allow a hook to print prose plus a trailing JSON object.
  try { return JSON.parse(s); } catch (_) {}
  const i = s.indexOf('{');
  if (i >= 0) {
    try { return JSON.parse(s.slice(i)); } catch (_) {}
  }
  return { systemMessage: s };
}

/**
 * Fire an event. Returns an aggregate verdict:
 *   { blocked, reason, additionalContext, systemMessages[], updatedInput, suppressOutput, stop, results[] }
 */
async function runEvent(event, payload = {}, opts = {}) {
  const name = String(event);
  if (!EVENTS.includes(name)) {
    return { blocked: false, reason: '', additionalContext: '', systemMessages: [], results: [], error: `Unknown hook event "${name}".` };
  }
  const config = opts.config || loadHookConfig(opts.cwd);
  const entries = config[name] || [];
  const toolName = payload.tool_name || payload.toolName || '';
  const verdict = {
    blocked: false, reason: '', additionalContext: '', systemMessages: [],
    updatedInput: null, suppressOutput: false, stop: false, results: [],
  };
  if (!entries.length) return verdict;

  const fullPayload = {
    session_id: opts.sessionId || payload.session_id || '',
    hook_event_name: name,
    cwd: opts.cwd || process.cwd(),
    tool_name: toolName,
    tool_input: payload.tool_input || payload.args || {},
    tool_response: payload.tool_response || payload.result || null,
    ...payload,
    hook_event_name: name,
  };

  for (const entry of entries) {
    if (!matches(entry.matcher, toolName)) continue;
    for (const hook of entry.hooks) {
      const ctxNotes = [];
      let res;
      if (hook.type === 'command' && hook.command) {
        if (opts.emit && hook.statusMessage) opts.emit({ type: 'hook', event: name, status: hook.statusMessage });
        res = await runCommandHook(hook, fullPayload, opts.cwd);
      } else if (hook.type === 'prompt' || hook.type === 'agent') {
        // prompt/agent hooks ask a model whether to allow, deny, or ask.
        if (typeof opts.runPrompt !== 'function') continue;
        if (!TOOL_EVENTS.has(name)) continue;
        try {
          const answer = await opts.runPrompt({
            prompt: String(hook.prompt || '') + '\n\n<tool_call>' + JSON.stringify({ tool_name: toolName, tool_input: fullPayload.tool_input }) + '</tool_call>',
            agent: hook.type === 'agent',
          });
          res = { exitCode: 0, stdout: answer || '', stderr: '' };
        } catch (e) {
          res = { exitCode: 1, stdout: '', stderr: e.message };
        }
      } else {
        continue;
      }

      const parsed = parseHookOutput(res.stdout);
      const record = { event: name, hook: hook.command || hook.prompt || hook.type, exitCode: res.exitCode, output: parsed, stderr: res.stderr };
      verdict.results.push(record);

      // Exit code 2 = block (Example's documented convention).
      if (res.exitCode === 2) {
        verdict.blocked = true;
        verdict.reason = parsed.reason || res.stderr || String(parsed.systemMessage || 'Blocked by PreToolUse hook');
      }
      if (parsed.systemMessage) verdict.systemMessages.push(capHookText(parsed.systemMessage));
      if (parsed.continue === false) { verdict.stop = true; verdict.reason = parsed.stopReason || verdict.reason; }
      if (parsed.suppressOutput) verdict.suppressOutput = true;

      const hs = parsed.hookSpecificOutput;
      if (hs && typeof hs === 'object') {
        if (hs.additionalContext) ctxNotes.push(capHookText(hs.additionalContext));
        if (hs.permissionDecision === 'deny') {
          verdict.blocked = true;
          verdict.reason = hs.permissionDecisionReason || verdict.reason || 'Denied by hook';
        }
        if (hs.permissionDecision === 'ask') verdict.needsAsk = true;
        if (hs.updatedInput && typeof hs.updatedInput === 'object') verdict.updatedInput = hs.updatedInput;
      }
      if (parsed.decision === 'block' || parsed.decision === 'deny') {
        verdict.blocked = true;
        verdict.reason = parsed.reason || verdict.reason;
      }
      if (ctxNotes.length) {
        verdict.additionalContext = capHookText(
          verdict.additionalContext ? `${verdict.additionalContext}\n${ctxNotes.join('\n')}` : ctxNotes.join('\n')
        );
      }
    }
  }
  return verdict;
}

// A cached pre-check so a hot loop does not stat settings.json on every call.
function hasHooks(event, cwd) {
  const cfg = loadHookConfig(cwd);
  return Boolean((cfg[event] || []).length);
}

module.exports = { EVENTS, TOOL_EVENTS, MAX_HOOK_OUTPUT_BYTES, capHookText, loadHookConfig, runEvent, hasHooks, matches };
