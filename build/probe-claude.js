'use strict';
// One-shot live Claude turn through the Anthropic transport, using the stored
// OAuth account (Claude Code credentials). Prints the status and a scrubbed
// body so the failure class is unambiguous.
const { app } = require('electron');
app.setName('Akron Bot');
const oauth = require('../electron/provider-oauth');
const transport = require('../electron/providertransport');

const MODEL = process.argv[2] || 'claude-opus-4-5';

app.whenReady().then(async () => {
  let provider;
  try {
    provider = await oauth.resolve('claude');
  } catch (e) {
    console.log('RESOLVE_FAIL ' + e.message);
    return app.exit(0);
  }
  console.log('account=' + provider.account + ' hasToken=' + !!provider.accessToken + ' expiresIn=' + Math.round(((provider.expiresAt || 0) - Date.now()) / 1000) + 's');
  const p = transport.normalizeProvider
    ? null
    : null;
  const prov = {
    transport: 'anthropic',
    oauth: true,
    accessToken: provider.accessToken,
    baseURL: 'https://api.anthropic.com',
    model: MODEL,
    maxTokens: 64,
    supportsTools: true,
  };
  const started = Date.now();
  try {
    const msg = await transport.chatCompletion(prov, [{ role: 'user', content: 'Reply with exactly: CLAUDE-OK' }], null, () => {});
    console.log('OK ms=' + (Date.now() - started) + ' finish=' + msg.finish_reason + ' text=' + JSON.stringify(String(msg.content).slice(0, 120)));
  } catch (e) {
    const body = String(e.body || e.message || e).replace(/\s+/g, ' ').slice(0, 400);
    console.log('ERR ms=' + (Date.now() - started) + ' status=' + (e.status || '') + ' type=' + (e.type || '') + ' transient=' + !!e.transient);
    console.log('BODY ' + body);
  }
  app.exit(0);
});
