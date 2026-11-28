'use strict';
// Read-only credit/usage readout for the signed-in Grok account.
// The CLI's `x.ai/billing` extension documents the response shape but not the
// host; the desktop product reads `GET /rest/grok/credits` on the web origin.
// This tries the documented paths and prints only balance/period fields.
const { app } = require('electron');
app.setName('Akron Bot');
const oauth = require('../electron/provider-oauth');
const transport = require('../electron/providertransport');

const CANDIDATES = [
  'https://grok.com/rest/grok/credits',
  'https://grok.com/rest/grok/billing',
  'https://cli-chat-proxy.grok.com/v1/credits',
  'https://cli-chat-proxy.grok.com/v1/usage',
];

app.whenReady().then(async () => {
  const prov = await oauth.resolve('grok');
  const out = [];
  for (const url of CANDIDATES) {
    // Only the official auth header when probing bearer billing paths.
    const headers = {
      authorization: 'Bearer ' + (prov.accessToken || ''),
      accept: 'application/json',
      'user-agent': 'akron-code/1.6.9',
    };
    try {
      const r = await fetch(url, { headers });
      const text = await r.text();
      let body;
      try { body = JSON.parse(text); } catch (_) { body = null; }
      out.push({
        url,
        status: r.status,
        ctype: r.headers.get('content-type'),
        body: body ? body : text.slice(0, 160).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      });
    } catch (e) {
      out.push({ url, error: e.message });
    }
  }
  console.log('CREDITS ' + JSON.stringify(out, null, 1).slice(0, 4000));
  app.exit(0);
});
