// Live proof that Example Code's lifecycle hooks actually fire inside the real
// agent loop (electron/llm.js), not just inside electron/hooks.js.
//
// A local OpenAI-compatible stub plays the model. The agent is given a temp
// project with a real `.claude/settings.json`, and every hook appends a marker
// to a log file. We then assert on the log, on the tool transcript, and on the
// filesystem — so "the hook ran" means "the hook ran and changed the outcome".
//
// Covered:
//   SessionStart        additionalContext injected into the system prompt
//   UserPromptSubmit    fires with the prompt text
//   PreToolUse (block)  exit 2 vetoes the tool call
//   PreToolUse (rewrite) updatedInput changes the arguments the tool runs with
//   PostToolUse         additionalContext appended to the tool result
//   Stop                fires when the turn ends
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runAgent } = require('../../electron/llm');

const PORT = 8910;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (res, o) => res.write('data: ' + JSON.stringify(o) + '\n\n');

let turn = 0;
const seen = [];

function startStub() {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch (_) {}
      const msgs = body.messages || [];
      seen.push(msgs.map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 400), tool_calls: m.tool_calls || null })));
      turn += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
      sse(res, { choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });

      const send = (obj, finish) => {
        sse(res, { choices: [{ index: 0, delta: obj }] });
        sse(res, { choices: [{ index: 0, delta: {}, finish_reason: finish || 'stop' }] });
        res.write('data: [DONE]\n\n');
        res.end();
      };
      const toolCall = (name, args) => send({
        tool_calls: [{ index: 0, id: 'call_' + name.toLowerCase(), type: 'function', function: { name, arguments: JSON.stringify(args) } }],
      }, 'tool_calls');

      // Turn 1: a Bash call the hook will veto.
      // Turn 2: a Write call the hook will rewrite.
      // Turn 3: plain text, ending the turn (Stop hook fires).
      if (turn === 1) return toolCall('Bash', { command: 'echo original-command' });
      if (turn === 2) return toolCall('Write', { path: 'a.txt', content: 'written by the agent' });
      return send({ content: 'All done.' });
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

let passed = 0;
let failed = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; fails.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
};

(async () => {
  const server = await startStub();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'helio-hookslive-'));
  const logFile = path.join(root, 'hook.log');
  const hookScript = path.join(root, 'hook.js');

  // One hook script, dispatched by HOOK_EVENT + MATCH, so quoting stays honest.
  fs.writeFileSync(hookScript, `
const fs = require('fs');
const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch (_) {}
  const ev = process.env.HOOK_EVENT;
  fs.appendFileSync(${JSON.stringify(logFile)}, ev + '\\n');
  if (ev === 'SessionStart') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'SESSION-CTX-MARKER' },
    }));
  } else if (ev === 'UserPromptSubmit') {
    fs.appendFileSync(${JSON.stringify(logFile)}, 'PROMPT=' + String(payload.prompt || '').slice(0, 40) + '\\n');
  } else if (ev === 'PreToolUse' && payload.tool_name === 'Bash') {
    process.stderr.write('bash is banned by policy\\n');
    process.exit(2);
  } else if (ev === 'PreToolUse' && payload.tool_name === 'Write') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: { path: 'rewritten.txt' } },
    }));
  } else if (ev === 'PostToolUse') {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'POST-CTX-MARKER' },
    }));
  }
});
`);

  const entry = (ev, matcher) => ({
    matcher: matcher || '',
    hooks: [{ type: 'command', command: `HOOK_EVENT=${ev} node ${JSON.stringify(hookScript)}`, timeout: 20 }],
  });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [entry('SessionStart')],
      UserPromptSubmit: [entry('UserPromptSubmit')],
      PreToolUse: [entry('PreToolUse', 'Bash|Write')],
      PostToolUse: [entry('PostToolUse', 'Write')],
      Stop: [entry('Stop')],
    },
  }, null, 2));

  const events = [];
  const messages = await runAgent({
    messages: [
      { role: 'system', content: 'You are Helio Bot.' },
      { role: 'user', content: 'Please run the two probes.' },
    ],
    provider: {
      baseURL: `http://127.0.0.1:${PORT}`,
      apiKey: 'stub',
      model: 'stub-model',
      temperature: 0,
      maxTokens: 4096,
      supportsTools: true,
    },
    cwd: root,
    emit: (ev) => events.push(ev),
    maxSteps: 6,
  }).catch((e) => {
    console.error('runAgent threw:', e && e.message);
    return null;
  });

  console.log('\n# hooks fired');
  const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']) {
    ok(ev + ' fired', new RegExp('^' + ev + '$', 'm').test(log), log.replace(/\n/g, '|'));
  }
  ok('UserPromptSubmit received the prompt', /PROMPT=Please run the two probes\./.test(log), log.replace(/\n/g, '|'));
  ok('PreToolUse fired once per tool call', (log.match(/^PreToolUse$/gm) || []).length >= 2,
    String((log.match(/^PreToolUse$/gm) || []).length));

  console.log('\n# PreToolUse block (exit 2)');
  const bashResult = (events.find((e) => e.type === 'toolResult' && e.name === 'Bash') || {});
  ok('the Bash call was blocked', /Blocked by hook/.test(String(bashResult.result)), String(bashResult.result).slice(0, 160));
  ok('the block reason came from stderr', /bash is banned by policy/.test(String(bashResult.result)));
  ok('the blocked call is flagged as an error', bashResult.isError === true);

  console.log('\n# PreToolUse rewrite (updatedInput)');
  ok('rewritten.txt was created', fs.existsSync(path.join(root, 'rewritten.txt')));
  ok('a.txt was NOT created', !fs.existsSync(path.join(root, 'a.txt')));
  ok('rewritten.txt has the agent content',
    fs.existsSync(path.join(root, 'rewritten.txt'))
      && /written by the agent/.test(fs.readFileSync(path.join(root, 'rewritten.txt'), 'utf8')));

  console.log('\n# PostToolUse + SessionStart context injection');
  const flat = (messages || []).map((m) => String(m.content || '')).join('\n');
  ok('PostToolUse context reached the model', /POST-CTX-MARKER/.test(flat), flat.slice(-300));
  ok('SessionStart context reached the model', /SESSION-CTX-MARKER/.test(flat));
  ok('the run produced a final answer', /All done\./.test(flat));

  console.log('\n# no leakage into the other hook channels');
  ok('Stop did not fire twice', (log.match(/^Stop$/gm) || []).length === 1,
    String((log.match(/^Stop$/gm) || []).length));

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed) console.log('\nFailures:\n' + fails.map((f) => ' - ' + f).join('\n'));

  server.close();
  await sleep(50);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error('harness crashed:', e);
  process.exit(1);
});
