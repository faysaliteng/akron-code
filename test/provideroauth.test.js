'use strict';
// Official CLI Auth Wrapper + Encrypted API-Key Account Store tests.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autobot-po-'));
process.env.AUTOBOT_HOME = SCRATCH_HOME;
const REAL_INDEX = path.join(os.homedir(), '.autobot', 'provider-oauth.json');
const realIndexBefore = fs.existsSync(REAL_INDEX) ? fs.readFileSync(REAL_INDEX) : null;

const po = require('../electron/provider-oauth');
const secretstore = require('../electron/secretstore');
const I = po._internal;

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

(async () => {
  console.log('\nprovider registry (official CLI + optional encrypted API key)');
  {
    eq('seven first-party providers are catalogued', po.providerIds(), ['claude', 'chatgpt', 'antigravity', 'grok', 'kimi', 'zai', 'copilot']);
    for (const id of po.providerIds()) {
      const p = po.provider(id);
      eq(id + ' kind matches', p.kind, id === 'zai' ? 'coding-plan' : 'cli');
      eq(id + ' transport matches', p.transport, id === 'zai' ? 'zai' : 'cli');
      ok(id + ' exposes cliId and bin', Boolean(p.cliId && p.bin));
      ok(id + ' exposes authLoginArgs/authStatusArgs', Array.isArray(p.authLoginArgs) && Array.isArray(p.authStatusArgs));
      ok(id + ' exposes at least one model', Array.isArray(p.models) && p.models.length > 0);
      ok(id + ' does NOT ship extracted vendor clientId or PKCE endpoints', !p.clientId && !p.clientSecret && !p.authorizeUrl && !p.tokenUrl);
      ok(id + ' bearerBaseURL is HTTPS', /^https:\/\//.test(p.bearerBaseURL || ''));
    }
    eq('codex alias resolves to chatgpt', po.provider('codex').id, 'chatgpt');
    eq('gemini alias resolves to antigravity', po.provider('gemini').id, 'antigravity');
    eq('xai alias resolves to grok', po.provider('xai').id, 'grok');
    eq('anthropic alias resolves to claude', po.provider('anthropic').id, 'claude');
    eq('moonshot alias resolves to kimi', po.provider('moonshot').id, 'kimi');
    eq('glm alias resolves to zai', po.provider('glm').id, 'zai');
    eq('github-copilot alias resolves to copilot', po.provider('github-copilot').id, 'copilot');
    eq('github alias resolves to copilot', po.provider('github').id, 'copilot');
    eq('unknown provider is null', po.provider('nope'), null);
  }

  console.log('\naccount persistence, encrypted API key storage & active switching');
  {
    const rec = po.addAccount('claude', { account: 'user@example.com', plan: 'max', label: 'Claude · max (user@example.com)' });
    eq('addAccount returns slugged prefixed id', rec.id, 'claude:user_example.com');
    eq('addAccount marks active automatically', po.activeAccount('claude'), 'user_example.com');
    eq('getAccount finds added record', po.getAccount('claude').account, 'user_example.com');

    const apiRec = await po.addBearer('grok:work', 'xai-secret-key-999');
    eq('addBearer stores api-key source', apiRec.source, 'api-key');
    ok('provider-oauth.json never contains plaintext API key',
      !fs.readFileSync(path.join(SCRATCH_HOME, 'provider-oauth.json'), 'utf8').includes('xai-secret-key-999'));
    eq('verifyAccount confirms encrypted key exists', await po.verifyAccount('grok', 'work'), true);

    const resolvedApi = await po.resolve('grok:work');
    eq('resolve on api-key record returns official grok transport', resolvedApi.transport, 'grok');
    eq('resolve on api-key record decrypts apiKey', resolvedApi.apiKey, 'xai-secret-key-999');
    eq('resolve on api-key record sets cliMode false', resolvedApi.cliMode, false);

    const resolvedCli = await po.resolve('claude:user_example.com');
    eq('resolve on CLI record sets transport cli', resolvedCli.transport, 'cli');
    eq('resolve on CLI record sets cliMode true', resolvedCli.cliMode, true);
    eq('resolve on CLI record never scrapes accessToken', resolvedCli.accessToken, '');

    eq('removeAccount removes grok:work', po.removeAccount('grok', 'work'), true);
    eq('removeAccount deletes encrypted key from secretstore', secretstore.get(I.slotKey('grok', 'work')), null);
  }

  console.log('\ncorrupt index quarantine & legacy mirror purge');
  {
    const idxFile = path.join(SCRATCH_HOME, 'provider-oauth.json');
    fs.writeFileSync(idxFile, '{corrupt json', 'utf8');
    const db = I.readDb();
    eq('corrupt index yields empty blank state cleanly', db, { accounts: [], active: {} });
    ok('corrupt index was quarantined aside',
      fs.readdirSync(SCRATCH_HOME).some((n) => n.startsWith('provider-oauth.json.corrupt-')));

    const legacyDir = path.join(SCRATCH_HOME, ['oauth', 'mirror'].join('-'));
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'tok.json'), '{}', 'utf8');
    I.purgeLegacyTokenMirror();
    eq('legacy mirror directory purged from disk', fs.existsSync(legacyDir), false);
  }

  console.log('\nofficial CLI auth probe & sync');
  {
    const fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autobot-cli-bin-'));
    const fakeClaude = path.join(fakeBinDir, 'claude');
    fs.writeFileSync(fakeClaude, '#!/bin/sh\necho \'{"loggedIn":true,"email":"max@example.com","subscriptionType":"max"}\'\n', { mode: 0o755 });

    const probe = await po.probeCliAuthStatus('claude', {
      resolveBin: async () => fakeClaude,
    });
    eq('probeCliAuthStatus parses claude JSON status', probe.loggedIn, true);
    eq('probeCliAuthStatus captures email', probe.account, 'max@example.com');
    eq('probeCliAuthStatus captures plan', probe.plan, 'max');

    const syncRes = await po.syncCliAccounts('claude', {
      resolveBin: async () => fakeClaude,
    });
    eq('syncCliAccounts imports detected CLI account', syncRes.imported, ['claude:max_example.com']);

    const failProbe = await po.probeCliAuthStatus('claude', {
      resolveBin: async () => '',
    });
    eq('missing binary degrades cleanly to loggedIn false', failProbe.loggedIn, false);

    // Clear prior claude accounts before authorize() so active becomes fresh_example.com
    po.removeAccount('claude', 'user_example.com');
    po.removeAccount('claude', 'max_example.com');
    // Test authorize() running mock CLI script emitting login URL + exit 0
    const loginCli = path.join(fakeBinDir, 'claude-login');
    fs.writeFileSync(loginCli, [
      '#!/bin/sh',
      'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
      '  echo "Open https://claude.ai/login?code=abc"',
      '  exit 0',
      'fi',
      'echo \'{"loggedIn":true,"email":"fresh@example.com","subscriptionType":"pro"}\'',
      '',
    ].join('\n'), { mode: 0o755 });
    let openedUrl = '';
    const authRes = await po.authorize('claude', {
      resolveBin: async () => loginCli,
      openExternal: (u) => { openedUrl = u; },
    });
    eq('authorize forwards printed HTTPS login URL', openedUrl, 'https://claude.ai/login?code=abc');
    eq('authorize imports logged-in account after exit 0', authRes.account, 'fresh_example.com');
    fs.rmSync(fakeBinDir, { recursive: true, force: true });
  }

  // Ensure user's real index untouched
  if (realIndexBefore === null) {
    // OK
  } else {
    eq('real ~/.autobot/provider-oauth.json untouched by tests', Buffer.compare(fs.readFileSync(REAL_INDEX), realIndexBefore), 0);
  }
  try { fs.rmSync(SCRATCH_HOME, { recursive: true, force: true }); } catch (_) {}

  console.log('\n=== RESULT: ' + pass + ' passed, ' + (process.exitCode ? 'FAILURES' : '0 failed') + ' ===');
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
