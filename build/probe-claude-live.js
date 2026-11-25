'use strict';
// Live Claude turn using the real Claude Code credentials from the macOS
// Keychain (service "Claude Code-credentials"). Read-only: the token is never
// printed or persisted. This answers "does Claude actually work on this
// machine?" independently of what our secretstore currently holds.
const { app } = require('electron');
const { execFileSync } = require('node:child_process');
const transport = require('../electron/providertransport');
app.setName('Akron Bot');

function keychainCreds() {
  const raw = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf8' });
  return JSON.parse(raw);
}

const MODELS = (process.argv[2] || 'claude-opus-4-5').split(',');

app.whenReady().then(async () => {
  let oauth;
  try {
    oauth = keychainCreds().claudeAiOauth || {};
  } catch (e) {
    console.log('KEYCHAIN_FAIL ' + e.message);
    return app.exit(0);
  }
  console.log('token expiresIn=' + Math.round(((oauth.expiresAt || 0) - Date.now()) / 1000) + 's plan=' + oauth.subscriptionType);
  for (const model of MODELS) {
    const prov = {
      transport: 'anthropic', oauth: true,
      accessToken: oauth.accessToken, baseURL: 'https://api.anthropic.com',
      model, maxTokens: 64, supportsTools: true,
    };
    const started = Date.now();
    try {
      const msg = await transport.chatCompletion(prov, [{ role: 'user', content: 'Reply with exactly: CLAUDE-OK' }], null, () => {});
      console.log('OK ' + model + ' ms=' + (Date.now() - started) + ' finish=' + msg.finish_reason + ' text=' + JSON.stringify(String(msg.content).slice(0, 160)));
    } catch (e) {
      console.log('ERR ' + model + ' ms=' + (Date.now() - started) + ' status=' + (e.status || '') + ' type=' + (e.type || '') + ' transient=' + !!e.transient);
      console.log('BODY ' + String(e.message || e).replace(/\s+/g, ' ').slice(0, 400));
    }
  }
  app.exit(0);
});
