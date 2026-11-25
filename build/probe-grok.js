'use strict';
// Live one-shot Grok probe: resolves the signed-in subscription token from the
// real provider-oauth registry, then drives the real grok transport once.
//
//   npx electron build/probe-grok.js [model]
//
// Prints the HTTP status/body on rejection (so a version gate is visible as
// `LLM 426: ...`), or the reply text on success. SafeStorage needs `app` ready,
// otherwise the secret store cannot decrypt and this reports that plainly.
const { app } = require('electron');
// `electron build/probe-grok.js` has no package.json beside the script, so the
// app name would default to "Electron" and safeStorage would look up the wrong
// Keychain item ("Electron Safe Storage"). Pin the real product name first.
app.setName('Akron Bot');
const oauth = require('../electron/provider-oauth');
const transport = require('../electron/providertransport');

const model = process.argv[2] || 'grok-4.5';

app.whenReady().then(async () => {
  const out = { model };
  try {
    const prov = await oauth.resolve('grok');
    out.provider = { account: prov.account, transport: prov.transport, baseURL: prov.baseURL, expiresAt: new Date(prov.expiresAt || 0).toISOString() };
    const deltas = [];
    const t0 = Date.now();
    const msg = await transport.chatCompletion(
      Object.assign({ model }, prov),
      [{ role: 'user', content: 'Reply with exactly: GROK-OK' }],
      null,
      (txt) => deltas.push(txt),
    );
    out.ms = Date.now() - t0;
    out.content = msg.content;
    out.finish = msg.finish_reason;
    out.usage = msg.usage;
    out.streamedDeltas = deltas.length;
    out.ok = !!msg.content;
  } catch (e) {
    out.ok = false;
    out.error = e.message;
    out.status = e.status || null;
  }
  console.log('PROBE ' + JSON.stringify(out, null, 1));
  app.exit(out.ok ? 0 : 1);
});
