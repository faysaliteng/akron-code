'use strict';
// Read-only entitlement probe: fetch the Grok CLI proxy's own `/v1/settings`
// and `/v1/models` with the signed-in token, using exactly the CLI's header set.
// Prints only non-secret, billing/tier-relevant fields.
//
//   npx electron build/probe-grok-entitlement.js
const { app } = require('electron');
app.setName('Akron Bot');
const oauth = require('../electron/provider-oauth');
const transport = require('../electron/providertransport');

const BASE = 'https://cli-chat-proxy.grok.com/v1';

function pick(obj, depth) {
  const out = {};
  const walk = (o, path, d) => {
    if (!o || typeof o !== 'object' || d > depth) return;
    for (const [k, v] of Object.entries(o)) {
      const p = path ? path + '.' + k : k;
      if (/balance|credit|quota|allowance|tier|plan|subscri|limit|billing|on_demand|ondemand|entitle/i.test(k)) {
        out[p] = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 300) : v;
      } else if (v && typeof v === 'object') {
        walk(v, p, d + 1);
      }
    }
  };
  walk(obj, '', 0);
  return out;
}

app.whenReady().then(async () => {
  const prov = await oauth.resolve('grok');
  const H = transport.grokHeaders
    ? transport.grokHeaders({ model: 'grok-4.5' })
    : {};
  const headers = Object.assign({}, H, { Authorization: 'Bearer ' + prov.accessToken });
  const res = { base: BASE };
  for (const p of ['/settings', '/models']) {
    try {
      const r = await fetch(BASE + p, { headers });
      const text = await r.text();
      let body = null;
      try { body = JSON.parse(text); } catch (_) { body = text.slice(0, 300); }
      res[p] = {
        status: r.status,
        topKeys: body && typeof body === 'object' ? Object.keys(body).slice(0, 40) : null,
        relevant: body && typeof body === 'object' ? pick(body, 2) : null,
        sample: body && typeof body === 'object' ? null : body,
      };
    } catch (e) {
      res[p] = { error: e.message };
    }
  }
  console.log('ENTITLEMENT ' + JSON.stringify(res, null, 1));
  app.exit(0);
});
