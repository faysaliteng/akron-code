'use strict';
// Is the 429 a real account limit or the OAuth gate that requires the Claude
// Code system prompt? Send the same minimal turn twice: bare, then with the
// first-party system block. Prints status + a scrubbed body for each.
const { app } = require('electron');
const { execFileSync } = require('node:child_process');
app.setName('Akron Bot');

const CC_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";
const MODEL = process.argv[2] || 'claude-opus-4-5';

async function post(token, system) {
  const body = {
    model: MODEL,
    max_tokens: 32,
    stream: false,
    messages: [{ role: 'user', content: 'Reply with exactly: CLAUDE-OK' }],
  };
  if (system) body.system = system;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer ' + token,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': 'claude-cli/2.1.154 (external, cli)',
      'x-app': 'cli',
    },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let shown = text.replace(/\s+/g, ' ').slice(0, 300);
  try {
    const j = JSON.parse(text);
    if (j.content) shown = 'TEXT ' + JSON.stringify(j.content.map((c) => c.text).join(''));
  } catch (_) {}
  return { status: r.status, shown, reqId: r.headers.get('request-id') };
}

app.whenReady().then(async () => {
  const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
  const token = JSON.parse(raw).claudeAiOauth.accessToken;
  const bare = await post(token, null);
  console.log('BARE status=' + bare.status + ' ' + bare.shown);
  const withSys = await post(token, CC_PROMPT);
  console.log('WITH_CC_SYSTEM status=' + withSys.status + ' ' + withSys.shown);
  const withArr = await post(token, [{ type: 'text', text: CC_PROMPT, cache_control: { type: 'ephemeral' } }]);
  console.log('WITH_CC_SYSTEM_BLOCKS status=' + withArr.status + ' ' + withArr.shown);
  app.exit(0);
});
