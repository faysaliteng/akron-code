'use strict';
// Inspect the signed-in Grok token's non-secret claims plus a per-model probe.
//
//   npx electron build/probe-grok-claims.js [model ...]
//
// Prints only claim names and short scalar values — never the bearer itself.
const { app } = require('electron');
app.setName('Akron Bot');
const oauth = require('../electron/provider-oauth');
const transport = require('../electron/providertransport');

const models = process.argv.slice(2).filter((a) => !a.startsWith('-'));

app.whenReady().then(async () => {
  const out = {};
  const prov = await oauth.resolve('grok');
  try {
    const claims = oauth._internal.jwtPayload(prov.accessToken) || {};
    out.claims = Object.fromEntries(Object.entries(claims).map(([k, v]) => {
      if (typeof v === 'string' && v.length > 40) return [k, String(v).slice(0, 40) + '…'];
      if (v && typeof v === 'object') return [k, JSON.stringify(v).slice(0, 160)];
      return [k, v];
    }));
  } catch (e) { out.claimsError = e.message; }

  out.results = [];
  for (const model of (models.length ? models : ['grok-4.5'])) {
    const r = { model };
    try {
      const t0 = Date.now();
      const msg = await transport.chatCompletion(
        Object.assign({ model }, prov),
        [{ role: 'user', content: 'Reply with exactly: GROK-OK' }], null, () => {},
      );
      r.ms = Date.now() - t0;
      r.ok = !!msg.content;
      r.content = String(msg.content || '').slice(0, 80);
    } catch (e) {
      r.ok = false;
      r.status = e.status || null;
      r.error = e.message;
    }
    out.results.push(r);
  }
  console.log('CLAIMS ' + JSON.stringify(out, null, 1));
  app.exit(0);
});
