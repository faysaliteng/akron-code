// Does the Antigravity chat path still 400? Send a REAL request with the REAL
// advertised tool surface through the exact code path the app uses, and report
// the endpoint's own answer.
//
//   node build/probe-antigravity-turn.cjs
//
// Run it with `node` and it relaunches itself under Electron: the stored
// accounts are encrypted with Electron's safeStorage (Keychain), which plain
// node cannot decrypt. Without the real runtime this probe would report
// "no stored tokens" for an account that resolves perfectly inside the app.
'use strict';

const path = require('path');

if (!process.versions.electron) {
  const { spawnSync } = require('child_process');
  const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'electron');
  const r = spawnSync(bin, [__filename], { stdio: 'inherit', env: process.env });
  process.exit(r.status === null ? 2 : r.status);
}

const { app, safeStorage } = require('electron');
// safeStorage keys the macOS Keychain entry on the app's own name ("<productName>
// Safe Storage"). A bare `electron <script>` run is named "Electron" and decrypts
// nothing — which looks exactly like a tokenless account. Adopt the real name
// before anything touches the store.
app.setName(require('../package.json').productName || 'Akron Bot');
const oauth = require('../electron/provider-oauth');
const transport = require('../electron/providertransport');
const { toolDefinitions } = require('../electron/tools');

const results = [];
const ok = (n, c, d) => { results.push({ n, c: !!c, d: d === undefined ? '' : String(d).slice(0, 900) }); };

async function main() {
  ok('safeStorage can decrypt this profile', safeStorage.isEncryptionAvailable(),
    'app "' + app.getName() + '"');
  const all = oauth.status();
  const prov = ((all && all.providers) || []).find((p) => p.id === 'antigravity');
  ok('antigravity provider is present in the account store', !!prov);
  const accounts = (prov && (prov.accounts || []).map((a) => a.account)) || [];
  ok('antigravity has a stored account', accounts.length > 0, accounts.join(', '));

  // Resolve the same way main.js does before a turn; the first account whose
  // grant actually resolves is the one we exercise.
  let provider = null;
  let lastErr = null;
  for (const name of accounts) {
    try {
      const r = await oauth.resolve('antigravity:' + name);
      if (!r.accessToken) continue;
      provider = {
        id: 'antigravity',
        vendor: 'Google Antigravity',
        transport: r.transport,
        baseURL: r.baseURL || '',
        apiKey: r.accessToken,
        accessToken: r.accessToken,
        cloudcodeUrl: r.cloudcodeUrl || '',
        model: (r.models && r.models[0] && r.models[0].id) || 'gemini-4-neon-high',
        oauthProvider: 'antigravity',
        account: name,
      };
      break;
    } catch (e) { lastErr = e; }
  }
  ok('a live access token was resolved', !!provider, lastErr ? lastErr.message : (provider && provider.account));
  if (!provider) return done();
  ok('a model id is available', !!provider.model, provider.model);

  const tools = toolDefinitions.map((t) => ({ type: 'function', function: t }));
  ok('the advertised tool surface is non-empty', tools.length > 0, tools.length + ' tools');
  // The lowering itself must survive the trip: count what the wire will carry.
  const decls = transport._internal.toGeminiDeclarations(tools);
  ok('every tool survives the Gemini lowering', decls.length === tools.length,
    decls.length + ' / ' + tools.length);

  const messages = [
    { role: 'system', content: 'You are Akron Bot. Be brief.' },
    { role: 'user', content: 'Reply with exactly: antigravity-path-ok' },
  ];

  let text = '';
  let err = null;
  const t0 = Date.now();
  try {
    const out = await transport.chatCompletion(provider, messages, tools, (d) => { text += d || ''; }, null, 256);
    if (out && typeof out === 'object' && typeof out.content === 'string') text = out.content || text;
    if (out && typeof out === 'object' && out.error) err = new Error(out.error);
  } catch (e) { err = e; }
  const ms = Date.now() - t0;

  if (err) {
    ok('the turn was accepted by the Cloud Code endpoint', false,
      (err.status || '') + ' ' + (err.endpoint || '') + ' :: ' + (err.message || err));
  } else {
    ok('the turn was accepted by the Cloud Code endpoint', true, ms + ' ms');
    ok('the model answered with text', /\S/.test(text), text.trim().slice(0, 300));
    ok('the reply carries no schema rejection',
      !/INVALID_ARGUMENT|function_declarations|value\.enum|value\.required/i.test(text));
  }
  done();

  function done() {
    console.log('\n=== antigravity turn ===');
    let bad = 0;
    for (const r of results) {
      if (!r.c) bad++;
      console.log((r.c ? 'PASS ' : 'FAIL ') + r.n + (r.d ? '  — ' + r.d : ''));
    }
    console.log(bad ? `\n${bad} FAILED` : `\nall ${results.length} checks passed`);
    process.exit(bad ? 1 : 0);
  }
}

app.whenReady().then(main).catch((e) => {
  console.error('probe crashed:', (e && e.stack) || e);
  process.exit(2);
});
