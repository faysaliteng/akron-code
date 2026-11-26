'use strict';
// Provider OAuth — the layer that turns "I already pay for Claude Max / ChatGPT
// Plus / Google AI Pro" into models inside the app.
//
// Nothing here talks to a real vendor. Token endpoints are local servers that
// replay the exact shapes observed live (JSON vs form bodies, 429 with
// retry-after, 400 encoder complaints), so a regression in the grant body, the
// encoding fallback, or the transient-vs-dead classification fails here rather
// than as a silent "sign-in failed" in the UI.
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a scratch home BEFORE the module is required: the
// quarantine test below deliberately writes `{not json` to the index, and that
// must never be the user's real ~/.autobot/provider-oauth.json.
const SCRATCH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'autobot-po-'));
process.env.AUTOBOT_HOME = SCRATCH_HOME;
const REAL_INDEX = path.join(os.homedir(), '.autobot', 'provider-oauth.json');
const realIndexBefore = fs.existsSync(REAL_INDEX) ? fs.readFileSync(REAL_INDEX) : null;
const realDirBefore = fs.existsSync(path.dirname(REAL_INDEX)) ? fs.readdirSync(path.dirname(REAL_INDEX)).sort() : [];

const po = require('../electron/provider-oauth');
const I = po._internal;

let pass = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

function server(handler) {
  return new Promise((resolve) => {
    const seen = { requests: [] };
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch (_) { parsed = new URLSearchParams(body); }
        seen.requests.push({ method: req.method, url: req.url, headers: req.headers, body: parsed });
        handler(req, res, parsed, seen);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        base: 'http://127.0.0.1:' + srv.address().port,
        port: srv.address().port,
        seen,
        close: () => new Promise((r) => { try { srv.closeAllConnections(); } catch (_) {} srv.close(r); }),
      });
    });
  });
}

const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const jwt = (claims) => 'h.' + b64url(claims) + '.sig';

(async () => {
  // -------------------------------------------------------------------------
  console.log('\nprovider registry');
  // -------------------------------------------------------------------------
  {
    eq('four first-party providers are catalogued', po.providerIds(), ['claude', 'chatgpt', 'antigravity', 'grok']);
    const need = ['id', 'label', 'vendor', 'kind', 'transport', 'authorizeUrl', 'tokenUrl', 'clientId', 'scopes', 'models', 'docs'];
    for (const id of po.providerIds()) {
      const p = po.provider(id);
      const missing = need.filter((k) => p[k] === undefined || p[k] === '');
      eq(id + ' is fully described', missing, []);
      ok(id + ' exposes at least one model', Array.isArray(p.models) && p.models.length > 0);
      ok(id + ' uses a public (non-empty) client id', typeof p.clientId === 'string' && p.clientId.length >= 8);
    }
    eq('claude speaks the anthropic transport', po.provider('claude').transport, 'anthropic');
    eq('chatgpt speaks the codex transport', po.provider('chatgpt').transport, 'codex');
    eq('antigravity speaks the google transport', po.provider('antigravity').transport, 'google');
    eq('grok signs in through the browser like the CLI does', po.provider('grok').kind, 'oauth');
    eq('grok speaks the grok transport', po.provider('grok').transport, 'grok');
    eq('grok inference goes through the CLI proxy, not the public API',
      po.provider('grok').baseURL, 'https://cli-chat-proxy.grok.com/v1');
    eq('grok still accepts a pasted API key as a second route', po.provider('grok').allowBearer, true);
    eq('grok verifies a pasted key against the public API base',
      po.provider('grok').bearerBaseURL, 'https://api.x.ai/v1');
    eq('grok redirects to 127.0.0.1 (xAI registers the IP, not localhost)',
      po.provider('grok').redirectHost, '127.0.0.1');
    eq('grok uses the CLI client id', po.provider('grok').clientId,
      'b1a00492-073a-47ea-816f-4c329264a828');
    eq('grok authorizes at auth.x.ai', po.provider('grok').authorizeUrl,
      'https://auth.x.ai/oauth2/authorize');
    eq('grok tokens come from auth.x.ai', po.provider('grok').tokenUrl,
      'https://auth.x.ai/oauth2/token');
    eq('grok asks for the CLI scopes', po.provider('grok').scopes.includes('grok-cli:access'), true);
    eq('grok posts a form body', po.provider('grok').tokenFormat, 'form');
    eq('unknown provider is null, not a throw', po.provider('nope'), null);
  }
  {
    // Extracted from the bundled Claude Code CLI 2.1.332 — the pre-2.x pair
    // (claude.ai authorize + api.anthropic.com token) is dead: claude.ai now
    // 307s to a login wall and api.anthropic.com mints no subscription token.
    eq('claude token endpoint is platform.claude.com',
      po.provider('claude').tokenUrl, 'https://platform.claude.com/v1/oauth/token');
    eq('claude authorize endpoint is platform.claude.com',
      po.provider('claude').authorizeUrl, 'https://platform.claude.com/oauth/authorize');
    eq('claude asks for the CLI code grant', po.provider('claude').extraAuthParams, { code: 'true' });
    eq('claude binds an ephemeral loopback port', po.provider('claude').redirectPort, 0);
    eq('claude requests the full CLI scope set', po.provider('claude').scopes.length, 8);
    ok('claude includes the plugins scope', po.provider('claude').scopes.includes('user:plugins'));
    eq('claude echoes the CSRF state in the token body', po.provider('claude').echoState, true);
    eq('claude posts JSON, not a form body', po.provider('claude').tokenFormat, 'json');
    eq('google requires a form body', po.provider('antigravity').tokenFormat, 'form');
    eq('google asks for a refresh token explicitly',
      po.provider('antigravity').extraAuthParams, { access_type: 'offline', prompt: 'consent' });
    ok('no provider points at the endpoint that rate-limits the same grant',
      po.providerIds().every((id) => po.provider(id).tokenUrl.indexOf('console.anthropic.com') === -1));
    for (const id of po.providerIds()) {
      const p = po.provider(id);
      ok(id + ' authorize/token urls are https', /^https:\/\//.test(p.authorizeUrl) && /^https:\/\//.test(p.tokenUrl));
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nnaming + slot keys');
  // -------------------------------------------------------------------------
  eq('email becomes a safe slot', I.slug('Ada.Lovelace+dev@Example.COM'), 'ada-lovelace-dev-example-com');
  eq('unsluggable input falls back to default', I.slug('///'), 'default');
  eq('empty input falls back to default', I.slug(''), 'default');
  ok('slot is capped at 48 chars', I.slug('x'.repeat(90)).length === 48);
  eq('slot key namespacing is stable', I.slotKey('claude', 'me@x.com'), 'provider-oauth:claude:me@x.com');
  eq('two accounts of one provider never collide',
    I.slotKey('claude', 'a') === I.slotKey('claude', 'b'), false);
  eq('the same account name under two providers never collides',
    I.slotKey('claude', 'me') === I.slotKey('chatgpt', 'me'), false);

  // -------------------------------------------------------------------------
  console.log('\nclaim + expiry decoding');
  // -------------------------------------------------------------------------
  {
    eq('jwt payload decodes url-safe base64', I.jwtPayload(jwt({ email: 'a@b.c' })).email, 'a@b.c');
    eq('jwt payload tolerates padding loss', I.jwtPayload('h.' + Buffer.from('{"a":"b"}').toString('base64').replace(/=+$/, '') + '.s').a, 'b');
    eq('non-jwt token yields null', I.jwtPayload('opaque-token'), null);
    eq('garbage jwt yields null, not a throw', I.jwtPayload('a.!!!.c'), null);
    eq('null token yields null', I.jwtPayload(null), null);

    eq('seconds are scaled', I.msFromEpoch(1700000000, 0), 1700000000000);
    eq('milliseconds pass through', I.msFromEpoch(1700000000000, 0), 1700000000000);
    eq('missing value uses the fallback', I.msFromEpoch(undefined, 42), 42);
    eq('zero uses the fallback', I.msFromEpoch(0, 42), 42);
    eq('garbage uses the fallback', I.msFromEpoch('soon', 42), 42);
    eq('epochToMs treats 0/null as absent', [I.epochToMs(0), I.epochToMs(null)], [0, 0]);
    eq('epochToMs scales seconds', I.epochToMs(1700000000), 1700000000000);
  }

  // -------------------------------------------------------------------------
  console.log('\ntoken response normalisation');
  // -------------------------------------------------------------------------
  {
    const before = Date.now();
    const n = I.normalizeTokens(po.provider('claude'), {
      access_token: 'at', refresh_token: 'rt', expires_in: 28800, scope: 'user:inference user:profile',
    });
    eq('access token captured', n.accessToken, 'at');
    eq('refresh token captured', n.refreshToken, 'rt');
    eq('expiry derived from expires_in seconds', Math.round((n.expiresAt - before) / 1000), 28800);
    eq('scopes split on whitespace', n.scopes, ['user:inference', 'user:profile']);
    eq('default token type', n.tokenType, 'Bearer');
    const abs = I.normalizeTokens(po.provider('chatgpt'), { access_token: 'a', expires_at: 1700000000 });
    eq('absolute seconds expiry supported', abs.expiresAt, 1700000000000);
    const absMs = I.normalizeTokens(po.provider('chatgpt'), { access_token: 'a', expires_at: 1700000000000 });
    eq('absolute millisecond expiry supported', absMs.expiresAt, 1700000000000);
    const none = I.normalizeTokens(po.provider('grok'), { access_token: 'a' });
    eq('no expiry means "does not expire"', none.expiresAt, 0);
    const comma = I.normalizeTokens(po.provider('claude'), { access_token: 'a', scope: 'a,b  c' });
    eq('scopes split on commas too', comma.scopes, ['a', 'b', 'c']);
    const empty = I.normalizeTokens(po.provider('claude'), null);
    eq('a null body does not throw', [empty.accessToken, empty.expiresAt], ['', 0]);
    eq('a returned id_token is kept for identity', I.normalizeTokens(po.provider('claude'), { id_token: 'x' }).idToken, 'x');
  }

  // -------------------------------------------------------------------------
  console.log('\nfingerprint + public record');
  // -------------------------------------------------------------------------
  {
    const a = I.fingerprint({ refreshToken: 'rt1' });
    const b = I.fingerprint({ refreshToken: 'rt2' });
    ok('fingerprint is 8 hex chars', /^[0-9a-f]{8}$/.test(a));
    eq('fingerprint is deterministic', I.fingerprint({ refreshToken: 'rt1' }), a);
    ok('different tokens give different fingerprints', a !== b);
    eq('refresh token wins as the seed', I.fingerprint({ refreshToken: 'rt1', accessToken: 'at' }), a);
    eq('access token is used when there is no refresh token',
      I.fingerprint({ accessToken: 'at' }), I.fingerprint({ accessToken: 'at' }));
  }
  {
    const rec = I.publicRecord({
      provider: 'claude', account: 'me', label: 'Claude · max', plan: 'max', source: 'claude-code',
      scopes: ['user:inference'], expiresAt: Date.now() + 60000, accessToken: 'secret', refreshToken: 'secret2',
    });
    ok('record never carries the access token', !('accessToken' in rec));
    ok('record never carries the refresh token', !('refreshToken' in rec));
    ok('record never contains the secret value at all', JSON.stringify(rec).indexOf('secret') === -1);
    eq('record reports it has a token', rec.hasToken, true);
    eq('record is addressable as provider:account', rec.id, 'claude:me');
    eq('a future expiry is not flagged', rec.expired, false);
    const dead = I.publicRecord({ provider: 'claude', account: 'x', expiresAt: Date.now() - 1000 });
    eq('a past expiry is flagged', dead.expired, true);
    const noExp = I.publicRecord({ provider: 'claude', account: 'x', expiresAt: 0 });
    eq('a non-expiring account is never flagged', noExp.expired, false);
    eq('missing scopes default to an empty list', noExp.scopes, []);
  }

  // -------------------------------------------------------------------------
  console.log('\nauthorize URL');
  // -------------------------------------------------------------------------
  {
    const prov = po.provider('claude');
    const u = new URL(I.buildAuthorizeUrl(prov, {
      redirectUri: 'http://localhost:54545/callback', state: 'st8', challenge: 'chal',
    }));
    eq('response_type is code', u.searchParams.get('response_type'), 'code');
    eq('public client id is used', u.searchParams.get('client_id'), prov.clientId);
    eq('redirect uri is echoed', u.searchParams.get('redirect_uri'), 'http://localhost:54545/callback');
    eq('scope is space joined', u.searchParams.get('scope'), prov.scopes.join(' '));
    eq('state is carried for CSRF', u.searchParams.get('state'), 'st8');
    eq('PKCE challenge is carried', u.searchParams.get('code_challenge'), 'chal');
    eq('PKCE method is S256 (never plain)', u.searchParams.get('code_challenge_method'), 'S256');
    ok('no client secret leaks into the URL', !u.searchParams.has('client_secret'));
    const g = new URL(I.buildAuthorizeUrl(po.provider('antigravity'), { redirectUri: 'r', state: 's', challenge: 'c' }));
    eq('google offline params applied', [g.searchParams.get('access_type'), g.searchParams.get('prompt')], ['offline', 'consent']);
    ok('authorize url keeps the provider host', g.host === 'accounts.google.com');
    // Field-verified against Antigravity `dist/remote/signInUrls.js`:
    // `SIGN_IN_PARAMS` whitelists exactly these ten names and rejects any other
    // key, so an extra param makes the Hub refuse the URL it was handed.
    const SIGN_IN_PARAMS = ['access_type', 'client_id', 'code_challenge', 'code_challenge_method',
      'prompt', 'provider_name', 'redirect_uri', 'response_type', 'scope', 'state'];
    const got = [...g.searchParams.keys()].sort();
    eq('antigravity authorize params are exactly the Hub whitelist',
      got, SIGN_IN_PARAMS.filter((p) => got.includes(p)));
    ok('antigravity sends no param the Hub would reject',
      got.every((k) => SIGN_IN_PARAMS.includes(k)), got);
    // `hasExactScopes` requires the same cardinality and membership, no dupes.
    const wantsScopes = [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
      'https://www.googleapis.com/auth/aicode',
    ];
    const sentScopes = g.searchParams.get('scope').split(' ');
    eq('antigravity personal scope set matches the Hub byte for byte',
      sentScopes.slice().sort(), wantsScopes.slice().sort());
    eq('antigravity sends no duplicate scope', new Set(sentScopes).size, sentScopes.length);
  }

  // -------------------------------------------------------------------------
  console.log('\ncallback page');
  // -------------------------------------------------------------------------
  {
    const good = I.callbackPage({ code: 'c', state: 's' });
    ok('success page says signed in', /Signed in/.test(good));
    ok('success page tells the user to go back to the app', /Akron Bot/.test(good));
    const bad = I.callbackPage({ error: 'access_denied', errorDescription: 'user said no' });
    ok('error page carries the reason', /user said no/.test(bad));
    ok('error page is not the success page', !/Signed in/.test(bad));
    const xss = I.callbackPage({ error: 'e', errorDescription: '<script>alert(1)</script>' });
    ok('provider text is HTML-escaped', xss.indexOf('<script>') === -1 && xss.indexOf('&lt;script&gt;') !== -1);
    const fallback = I.callbackPage({});
    ok('empty payload still renders guidance', /no authorization code/.test(fallback));
  }

  // -------------------------------------------------------------------------
  console.log('\nloopback redirect listener');
  // -------------------------------------------------------------------------
  {
    const srv = await I.startLoopbackServer({ path: '/cb', timeoutMs: 5000 });
    ok('redirect uri is loopback with the right path', /^http:\/\/localhost:\d+\/cb$/.test(srv.redirectUri), srv.redirectUri);
    const res = await fetch(srv.redirectUri.replace('localhost', '127.0.0.1') + '?code=abc&state=xyz');
    eq('listener answers 200', res.status, 200);
    // A code in the callback is not a finished sign-in. Without a verifier the
    // page must not claim success.
    const page = await res.text();
    ok('listener does not claim success without a verifier', !/Signed in/.test(page) && /Finishing sign-in/.test(page));
    eq('code and state are handed back', await srv.wait(), { code: 'abc', state: 'xyz', error: null, errorDescription: null });
    srv.close();
  }
  {
    // A callback minted by someone else must not consume the flow.
    const srv = await I.startLoopbackServer({ path: '/cb', timeoutMs: 5000, state: 'mine' });
    const res = await fetch('http://127.0.0.1:' + srv.port + '/cb?code=abc&state=theirs');
    eq('a foreign state is refused', res.status, 400);
    ok('and says the app is still waiting', /still waiting/.test(await res.text()));
    const good = await fetch('http://127.0.0.1:' + srv.port + '/cb?code=abc&state=mine');
    eq('the real callback still lands', good.status, 200);
    eq('with our own code', (await srv.wait()).code, 'abc');
    srv.close();
  }
  {
    // The page reports the token exchange verdict, not the presence of a code.
    const bad = await I.startLoopbackServer({
      path: '/cb', timeoutMs: 5000, state: 's',
      verify: async () => ({ ok: false, detail: 'invalid_grant' }),
    });
    const badRes = await fetch('http://127.0.0.1:' + bad.port + '/cb?code=c&state=s');
    const badPage = await badRes.text();
    ok('a refused exchange is not called success', !/Signed in/.test(badPage) && /did not complete/.test(badPage));
    ok('and the provider reason is shown', /invalid_grant/.test(badPage));
    const badPayload = await bad.wait();
    eq('the caller learns why', [badPayload.error, /invalid_grant/.test(badPayload.errorDescription)], ['exchange_failed', true]);

    const good = await I.startLoopbackServer({
      path: '/cb', timeoutMs: 5000, state: 's',
      verify: async () => ({ ok: true, record: { id: 'claude:x' } }),
    });
    const goodPage = await (await fetch('http://127.0.0.1:' + good.port + '/cb?code=c&state=s')).text();
    ok('a proven exchange is called success', /Signed in/.test(goodPage));
    eq('and the record travels back', (await good.wait()).verified.record.id, 'claude:x');
  }
  {
    const srv = await I.startLoopbackServer({ path: '/cb', timeoutMs: 5000 });
    const base = srv.redirectUri.replace('localhost', '127.0.0.1');
    const wrong = await fetch(base.replace('/cb', '/nope'));
    eq('an unexpected path is refused', wrong.status, 404);
    const err = await fetch(base + '?error=access_denied&error_description=nope');
    ok('error callback still answers', err.status === 200);
    const payload = await srv.wait();
    eq('error is surfaced to the caller', [payload.code, payload.error, payload.errorDescription], [null, 'access_denied', 'nope']);
    srv.close();
  }
  {
    const srv = await I.startLoopbackServer({ path: '/cb', timeoutMs: 40 });
    const payload = await srv.wait();
    eq('an abandoned sign-in times out instead of hanging', payload.error, 'timeout');
    ok('timeout message is human', /not completed in time/.test(payload.errorDescription));
  }
  {
    // Preferred port busy -> ephemeral fallback (claude/google accept any loopback port).
    const blocker = await server((req, res) => { res.writeHead(200); res.end('x'); });
    const srv = await I.startLoopbackServer({ path: '/cb', port: blocker.port, timeoutMs: 5000 });
    ok('a taken port does not break sign-in', srv.port !== blocker.port && srv.port > 0);
    eq('fallback is still loopback', /^http:\/\/localhost:\d+\/cb$/.test(srv.redirectUri), true);
    srv.close();
    await blocker.close();
  }
  {
    // `localhost` resolves to ::1 first on macOS. A listener that only bound
    // 127.0.0.1 left every callback at ECONNREFUSED, which is exactly what
    // broke sign-in. Both families must answer on the same port.
    const srv = await I.startLoopbackServer({ path: '/cb', timeoutMs: 5000 });
    ok('the listener covers both loopback families', srv.host === 'dual');
    const v4 = await fetch('http://127.0.0.1:' + srv.port + '/cb/nope').catch(() => null);
    ok('IPv4 answers', !!(v4 && v4.status === 404));
    const v6 = await fetch('http://[::1]:' + srv.port + '/cb?code=c6&state=s6').catch(() => null);
    ok('IPv6 answers', !!(v6 && v6.status === 200));
    const payload = await srv.wait();
    eq('the IPv6 callback carries the code', payload.code, 'c6');
    srv.close();
  }
  {
    // The manual path prints `code#state`; users also paste the whole URL.
    const ps = I.parseManualCode;
    eq('a bare code is accepted', ps('abc123', 'st'), { code: 'abc123', state: 'st' });
    eq('code#state is split', ps('abc123#st9', 'zz'), { code: 'abc123', state: 'st9' });
    eq('a pasted redirect URL is parsed',
      ps('https://platform.claude.com/oauth/code/callback?code=abc&state=st7', 'zz'),
      { code: 'abc', state: 'st7' });
    let threw = '';
    try { ps('https://platform.claude.com/oauth/code/callback', 'zz'); } catch (e) { threw = e.message; }
    ok('a link with no code is refused in one human line', /no authorization code/.test(threw));
    let empty = '';
    try { ps('   ', 'zz'); } catch (e) { empty = e.message; }
    ok('an empty paste is refused', /no authorization code/.test(empty));
  }

  // -------------------------------------------------------------------------
  console.log('\ntoken grant — postToken');
  // -------------------------------------------------------------------------
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 }));
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    const out = await I.postToken(prov, { grant_type: 'refresh_token', refresh_token: 'r', client_id: 'c' });
    eq('json grant returns the parsed body', out.access_token, 'at');
    const req = s.seen.requests[0];
    eq('json is the preferred encoding', req.headers['content-type'], 'application/json');
    eq('grant is posted, not queried', req.method, 'POST');
    eq('only the three load-bearing refresh fields are sent', Object.keys(JSON.parse(JSON.stringify(req.body))).sort(), ['client_id', 'grant_type', 'refresh_token']);
    ok('no empty scope is echoed back (invalid_scope on refresh)', !('scope' in req.body));
    await s.close();
  }
  {
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"g"}');
    });
    const prov = Object.assign({}, po.provider('antigravity'), { tokenUrl: s.base + '/token' });
    await I.postToken(prov, { grant_type: 'authorization_code', code: 'c' });
    eq('form providers post a form body', s.seen.requests[0].headers['content-type'], 'application/x-www-form-urlencoded');
    await s.close();
  }
  {
    // 400 "expected json" -> retry with the other encoding and win.
    let n = 0;
    const s = await server((req, res) => {
      n++;
      const isJson = String(req.headers['content-type'] || '').indexOf('json') !== -1;
      if (isJson) { res.writeHead(400, { 'content-type': 'application/json' }); res.end('{"error":"invalid_request","error_description":"expected form encoding"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"access_token":"second-try"}');
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    const out = await I.postToken(prov, { grant_type: 'refresh_token', refresh_token: 'r' }, { retries: 0 });
    eq('an encoding complaint is retried with the other format', out.access_token, 'second-try');
    eq('exactly two wire attempts were made', n, 2);
    eq('fallback attempt used the form encoding', s.seen.requests[1].headers['content-type'], 'application/x-www-form-urlencoded');
    await s.close();
  }
  {
    // 401 is a dead account, never retried.
    const s = await server((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}');
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    let err = null;
    try { await I.postToken(prov, { grant_type: 'refresh_token', refresh_token: 'dead' }, { retries: 3 }); } catch (e) { err = e; }
    ok('a rejected grant throws', !!err);
    eq('status is preserved for classification', err && err.status, 401);
    eq('a rejected grant is not transient', err && err.transient, false);
    eq('the provider reason is kept for the UI', err && err.body && err.body.error_description, 'Refresh token not found or invalid');
    eq('a 401 is attempted exactly once', s.seen.requests.length, 1);
    await s.close();
  }
  {
    // 429 is "try later": retried, then surfaced as transient.
    const s = await server((req, res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
      res.end('{"error":"rate_limit_error"}');
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    const retries = [];
    let err = null;
    try { await I.postToken(prov, { grant_type: 'refresh_token', refresh_token: 'r' }, { retries: 1, onRetry: (r) => retries.push(r.status) }); } catch (e) { err = e; }
    eq('a rate limit is flagged transient (the account is alive)', err && err.transient, true);
    eq('a rate limit reports its status', err && err.status, 429);
    eq('the caller is told a retry happened', retries, [429]);
    ok('more than one attempt was made', s.seen.requests.length >= 2);
    await s.close();
  }
  {
    const s = await server((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_grant"}');
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    let err = null;
    try { await I.postToken(prov, { grant_type: 'x', refresh_token: 'r' }, { retries: 2 }); } catch (e) { err = e; }
    eq('a plain 400 is fatal, not retried as transient', err && err.transient, false);
    eq('a plain 400 tries both encodings only', s.seen.requests.length, 2);
    await s.close();
  }
  {
    // Live-verified 2026-11-25 on platform.claude.com/v1/oauth/token: the same
    // body answered 429 `rate_limit_error` with no User-Agent and 400
    // `invalid_grant` with a CLI User-Agent. Losing the UA turns a permanent
    // "sign in again" into a transient throttle, which is how a dead credential
    // became an endless retry loop.
    const s = await server((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"access_token":"at"}');
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    await I.postToken(prov, { grant_type: 'refresh_token', refresh_token: 'r', client_id: 'c' }, { retries: 0 });
    const ua = String(s.seen.requests[0].headers['user-agent'] || '');
    ok('the token request presents a Claude CLI user-agent', /^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/.test(ua));
    await s.close();
  }
  {
    // A refresh grant the provider has already rejected is not an encoding
    // complaint: resending it costs a second request against a rate-limited
    // endpoint and holds the same single-use token.
    const s = await server((req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"error":"invalid_grant","error_description":"Refresh token not found or invalid"}');
    });
    const prov = Object.assign({}, po.provider('claude'), { tokenUrl: s.base + '/token' });
    let err = null;
    try { await I.postToken(prov, { grant_type: 'refresh_token', refresh_token: 'r', client_id: 'c' }, { retries: 0 }); } catch (e) { err = e; }
    ok('a dead refresh grant throws', !!err);
    eq('a dead refresh grant is not transient', err && err.transient, false);
    eq('a dead refresh grant is sent exactly once', s.seen.requests.length, 1);
    await s.close();
  }

  // -------------------------------------------------------------------------
  console.log('\nidentity resolution');
  // -------------------------------------------------------------------------
  {
    const out = await I.identify('claude', { idToken: jwt({ email: 'Ada@Example.com', name: 'Ada' }) }, {});
    eq('id_token email becomes the slot', out.account, 'ada-example-com');
    eq('id_token name becomes the label', out.label, 'Ada');
  }
  {
    const out = await I.identify('chatgpt', {
      idToken: jwt({ email: 'g@x.io', 'https://api.openai.com/auth': { chatgpt_plan_type: 'plus', chatgpt_account_id: 'acct-1' } }),
    }, {});
    eq('chatgpt plan is read from the auth claim', out.plan, 'plus');
    eq('chatgpt account id is read from the auth claim', out.accountId, 'acct-1');
  }
  {
    // No claims and a profile endpoint that fails -> fingerprint fallback, no throw.
    const out = await I.identify('claude', { accessToken: 'at', refreshToken: 'rt' }, {
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    eq('unidentifiable account falls back to provider + fingerprint', out.account, 'claude-' + I.fingerprint({ refreshToken: 'rt' }));
    ok('fallback label is still readable', /^Claude · /.test(out.label));
  }
  {
    const out = await I.identify('antigravity', { accessToken: 'at' }, {
      fetchImpl: async () => ({ ok: true, json: async () => ({ email: 'g@x.io', name: 'G' }) }),
    });
    eq('google profile endpoint fills the slot', out.account, 'g-x-io');
    eq('google profile name fills the label', out.label, 'G');
  }
  {
    const seen = [];
    const out = await I.identify('claude', { accessToken: 'at', refreshToken: 'rt' }, {
      fetchImpl: async (url, init) => { seen.push({ url, headers: init.headers }); return { ok: true, json: async () => ({ account: { email: 'p@x.io', subscription_type: 'max', organization_uuid: 'org-1' } }) }; },
    });
    eq('profile lookup uses a bearer token', seen[0].headers.authorization, 'Bearer at');
    eq('profile lookup talks to the anthropic oauth beta', seen[0].headers['anthropic-beta'], 'oauth-2025-04-20');
    eq('profile lookup hits the anthropic profile route', seen[0].url, 'https://api.anthropic.com/api/oauth/profile');
    eq('plan comes from the account record', [out.plan, out.organizationUuid], ['max', 'org-1']);
  }

  // -------------------------------------------------------------------------
  console.log('\nindex file is non-secret and private');
  // -------------------------------------------------------------------------
  {
    const realFile = path.join(SCRATCH_HOME, 'provider-oauth.json');
    I.writeDb({ accounts: [{ provider: 'claude', account: 'tmp-test', label: 'x', expiresAt: 1 }] });
    const mode = fs.statSync(realFile).mode & 0o777;
    eq('the index is written 0600', mode, 0o600);
    const back = I.readDb();
    eq('the index round-trips', back.accounts[0].account, 'tmp-test');
    eq('the index carries a version', back.version, 1);
    ok('no token-shaped value is stored in the index', !/sk-ant|access_token|refresh_token/i.test(fs.readFileSync(realFile, 'utf8')));
    // A corrupt index must degrade to empty AND quarantine itself next to the
    // index — inside the scratch home, never in the user's real directory.
    fs.writeFileSync(realFile, '{not json');
    eq('a corrupt index degrades to empty instead of throwing', I.readDb().accounts, []);
    ok('the corrupt index is quarantined beside the scratch index',
      fs.readdirSync(SCRATCH_HOME).some((n) => /^provider-oauth\.json\.corrupt-\d+$/.test(n)));
    const realIndexAfter = fs.existsSync(REAL_INDEX) ? fs.readFileSync(REAL_INDEX) : null;
    ok('the real ~/.autobot index was not touched by this suite',
      (realIndexBefore === null ? realIndexAfter === null : realIndexAfter !== null && realIndexAfter.equals(realIndexBefore)));
    ok('no quarantine file appeared in the real ~/.autobot',
      JSON.stringify(fs.readdirSync(path.dirname(REAL_INDEX)).sort()) === JSON.stringify(realDirBefore));
    // Leave the scratch index usable: later blocks in this file keep writing.
    fs.unlinkSync(realFile);
  }

  // -------------------------------------------------------------------------
  console.log('\nstatus (read-only)');
  // -------------------------------------------------------------------------
  {
    const st = po.status();
    eq('status lists every provider', st.providers.length, 4);
    eq('status reports the secret backend', typeof st.secretBackend, 'object');
    eq('status counts the stored accounts', st.total, I.readDb().accounts.length);
    for (const p of st.providers) {
      ok(p.id + ' reports an account list', Array.isArray(p.accounts));
      ok(p.id + ' reports active as a string', typeof p.active === 'string');
      eq(p.id + ' says whether browser sign-in is possible', p.canBrowserSignIn, p.kind === 'oauth');
      ok(p.id + ' accounts never expose a token', p.accounts.every((a) => !('accessToken' in a) && !('refreshToken' in a)));
    }
    const before = JSON.stringify(po.status());
    eq('status does not mutate the index', JSON.stringify(po.status()), before);
  }

  // -------------------------------------------------------------------------
  console.log('\ninput guards');
  // -------------------------------------------------------------------------
  {
    let e1 = null;
    try { await po.addBearer('nope', 'tok', { verify: false }); } catch (e) { e1 = e; }
    ok('an unknown provider is rejected', !!(e1 && /unknown provider/.test(e1.message)));
    let e2 = null;
    try { await po.addBearer('grok', '   ', { verify: false }); } catch (e) { e2 = e; }
    ok('an empty token is rejected before storage', !!(e2 && /empty token/.test(e2.message)));
    let e3 = null;
    try { await po.resolve('grok:missing-account'); } catch (e) { e3 = e; }
    ok('resolving an account that is not stored fails loudly', !!(e3 && /no stored tokens|no .* account is signed in/.test(e3.message)));
    let e4 = null;
    try { await po.resolve('nosuchprov:x'); } catch (e) { e4 = e; }
    ok('resolving an unknown provider names it', !!(e4 && /unknown provider/.test(e4.message)));
  }

  // -------------------------------------------------------------------------
  console.log('\nbearer verification verdict ladder (xAI answers 400, not 401)');
  // -------------------------------------------------------------------------
  {
    const before = I.readDb().accounts.filter((a) => a.provider === 'grok').length;
    const fake = (status, body) => async () => ({
      status,
      text: async () => body,
      json: async () => ({ data: [] }),
    });

    // A wrong key must never become an "account".
    let e400 = null;
    try {
      await po.addBearer('grok', 'sk-bogus-test-key', {
        fetchImpl: fake(400, '{"code":"invalid-argument","error":"Incorrect API key provided."}'),
      });
    } catch (e) { e400 = e; }
    ok('a 400 "Incorrect API key" is a rejection, not an account',
      !!(e400 && /rejected that key/.test(e400.message) && /Incorrect API key/.test(e400.message)), e400 && e400.message);
    eq('a rejected key stores nothing',
      I.readDb().accounts.filter((a) => a.provider === 'grok').length, before);

    for (const [name, status] of [['403', 403], ['401', 401]]) {
      let e = null;
      try { await po.addBearer('grok', 'sk-bogus-test-key', { fetchImpl: fake(status, '{}') }); } catch (x) { e = x; }
      ok('a ' + name + ' is a rejection', !!(e && /rejected that key/.test(e.message)));
    }

    // Anything we cannot judge is kept: no /models route, rate limit, server
    // error, or a network failure (offline user).
    for (const [name, status] of [['404', 404], ['429', 429], ['500', 500], ['200', 200]]) {
      let id = '';
      try {
        const rec = await po.addBearer('grok', 'sk-unverifiable-test-key', { fetchImpl: fake(status, '') });
        id = rec && rec.account;
        ok('a ' + name + ' is kept (cannot judge the key)', !!id, rec);
      } catch (e) {
        ok('a ' + name + ' is kept (cannot judge the key)', false, e.message);
      } finally {
        if (id) { try { po.removeAccount('grok', id); } catch (_) { /* already gone */ } }
      }
    }
    let netKept = '';
    try {
      const rec = await po.addBearer('grok', 'sk-offline-test-key', { fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
      netKept = rec && rec.account;
      ok('a network failure keeps the key (offline user)', !!netKept);
    } catch (e) {
      ok('a network failure keeps the key (offline user)', false, e.message);
    } finally {
      if (netKept) { try { po.removeAccount('grok', netKept); } catch (_) { /* gone */ } }
    }
    eq('the ladder leaves the account index clean',
      I.readDb().accounts.filter((a) => a.provider === 'grok').length, before);
  }

  // -------------------------------------------------------------------------
  console.log('\nlocal credential adoption (recovering after an app rename)');
  // -------------------------------------------------------------------------
  {
    // The secretstore is keyed off the app identity, so renaming the app makes
    // every stored token undecryptable. An account originally imported from
    // `claude` CLI still has a live credential one keychain read away; these
    // cases pin the safety rails on that recovery path without touching the
    // real index or the real keychain (db/save/read are all injected).
    const row = (over) => Object.assign({
      provider: 'claude', account: 'cc-adopt', source: 'claude-code',
      plan: '', scopes: [], organizationUuid: '',
    }, over);
    const fakeDb = (rows) => ({ version: 1, accounts: rows, active: {} });
    const creds = {
      oauth: {
        accessToken: 'at-live', refreshToken: 'rt-live',
        expiresAt: 1795642583650, subscriptionType: 'max', scopes: ['user:inference'],
      },
    };

    eq('only Claude has a first-party credential to adopt',
      I.adoptLocalCredentials('grok', 'cc-adopt', {}), null);

    {
      const saved = [];
      const out = I.adoptLocalCredentials('claude', 'cc-adopt', {
        db: fakeDb([row({ account: 'other', source: 'oauth' })]),
        readCreds: () => creds,
        saveTokens: (p, a, t) => saved.push([p, a, t]),
        writeDb: () => { throw new Error('must not persist when there is nothing to adopt'); },
      });
      eq('an account that was never imported from the CLI is not adopted', out, null);
      eq('nothing is saved in that case', saved.length, 0);
    }
    {
      // Two CLI-imported accounts: adopting would be a coin flip between logins.
      const out = I.adoptLocalCredentials('claude', 'cc-adopt', {
        db: fakeDb([row({}), row({ account: 'second' })]),
        readCreds: () => creds,
        saveTokens: () => { throw new Error('must not save when the owner is ambiguous'); },
        writeDb: () => {},
      });
      eq('adoption is refused when two CLI accounts could own the credential', out, null);
    }
    {
      const saved = [];
      const db = fakeDb([row({ account: 'cc-adopt' })]);
      const out = I.adoptLocalCredentials('claude', 'cc-adopt', {
        db,
        readCreds: () => creds,
        saveTokens: (p, a, t) => saved.push([p, a, t]),
        writeDb: () => {},
      });
      ok('a single CLI-imported account re-adopts the live credential', !!out);
      eq('the access token comes from the first-party store', out && out.accessToken, 'at-live');
      eq('the refresh token comes too (so it can still rotate)', out && out.refreshToken, 'rt-live');
      eq('an already-millisecond expiry is left alone', out && out.expiresAt, 1795642583650);
      eq('the token is written back to the secretstore', saved.length, 1);
      eq('it is written under provider:account', saved[0] && saved[0].slice(0, 2), ['claude', 'cc-adopt']);
      eq('the account row learns the expiry', db.accounts[0].expiresAt, 1795642583650);
      eq('a blank plan is filled from the subscription type', db.accounts[0].plan, 'max');
    }
    {
      const out = I.adoptLocalCredentials('claude', 'cc-adopt', {
        db: fakeDb([row({})]),
        readCreds: () => null,
        saveTokens: () => { throw new Error('must not save without a credential'); },
        writeDb: () => {},
      });
      eq('no credential on disk means no adoption', out, null);
    }
  }

  // -------------------------------------------------------------------------
  console.log('\nverification badge + live entitlement');
  // -------------------------------------------------------------------------
  {
    // The picker must stop calling an adapter "unverified" as soon as a real
    // call answered. `verifyAccount` alone never runs on a healthy row, so the
    // catalog path needs its own, side-effect-light marker.
    po.addAccount('chatgpt', {
      account: 'unit-mark',
      label: 'Chat Unit',
      plan: 'free',
      tokens: { accessToken: 'at-unit', refreshToken: 'rt-unit' },
    });
    eq('a fresh row has never been verified', po.getAccount('chatgpt', 'unit-mark').verifiedAt, 0);
    eq('markVerified accepts a live answer', po.markVerified('chatgpt', 'unit-mark'), true);
    ok('markVerified stamps a timestamp the bridge may carry',
      po.getAccount('chatgpt', 'unit-mark').verifiedAt > 0);
    eq('markVerified on an unknown account is a loud false, not a throw',
      po.markVerified('chatgpt', 'no-such-row'), false);

    // ChatGPT's token need not carry a plan claim; the account endpoint is the
    // only honest source. A stale default is corrected, not displayed forever.
    let asked = '';
    const fake = async (url) => {
      asked = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          accounts: {
            'acct-1': { account: { plan_type: 'plus', plan_display_name: 'Plus' } },
          },
        }),
      };
    };
    const did = await po.refreshEntitlement('chatgpt', 'unit-mark', { fetchImpl: fake });
    eq('refreshEntitlement reads the account endpoint', did, true);
    ok('it asks accounts/check', /\/backend-api\/accounts\/check\//.test(asked), asked);
    eq('the plan slug becomes the live one', po.getAccount('chatgpt', 'unit-mark').plan, 'plus');
    eq('the human plan name is kept for the UI', po.getAccount('chatgpt', 'unit-mark').planName, 'Plus');

    let touched = 0;
    const never = async () => { touched++; return { ok: true, status: 200, json: async () => ({}) }; };
    eq('other providers have no entitlement endpoint to poll',
      await po.refreshEntitlement('claude', 'unit-mark', { fetchImpl: never }), false);
    eq('and it does not spend a request to find that out', touched, 0);

    const failing = async () => ({ ok: false, status: 500, json: async () => ({}) });
    eq('a failed entitlement check leaves the label alone',
      await po.refreshEntitlement('chatgpt', 'unit-mark', { fetchImpl: failing }), false);
    eq('the previously known plan survives a failure', po.getAccount('chatgpt', 'unit-mark').plan, 'plus');

    const throws = async () => { throw new Error('ENOTFOUND'); };
    eq('an offline entitlement check is not fatal',
      await po.refreshEntitlement('chatgpt', 'unit-mark', { fetchImpl: throws }), false);

    po.removeAccount('chatgpt', 'unit-mark');
    eq('the fixture account is gone', po.getAccount('chatgpt', 'unit-mark'), null);
  }

  // -------------------------------------------------------------------------
  // A registered redirect URI is one exact address (OpenAI: localhost:1455).
  // -------------------------------------------------------------------------
  // Live-measured 2026-11-26: auth.openai.com answers the authorize request
  // with `302 -> /log-in` for port 1455 and `400 invalid_authorize_request` for
  // every other port. The listener therefore may not "helpfully" move to an
  // ephemeral port: that produced a blank error page instead of a sign-in.
  {
    const chatgpt = po.provider('chatgpt');
    eq('chatgpt declares the port it cannot move off', chatgpt.fixedRedirectPort, true);
    eq('chatgpt carries the redirect port it registered', chatgpt.redirectPort, 1455);
    eq('the authorize URL matches the shipped Codex CLI', chatgpt.extraAuthParams.originator, 'codex_cli_rs');
    const url = I.buildAuthorizeUrl(chatgpt, {
      redirectUri: 'http://localhost:1455/auth/callback', state: 's'.repeat(22), challenge: 'c'.repeat(43), nonce: '',
    });
    ok('the built URL keeps the registered redirect URI', url.includes('redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback'), url);
    ok('and carries originator', url.includes('originator=codex_cli_rs'), url);

    const claude = po.provider('claude');
    ok('claude is not pinned to a port (it accepts any loopback port)', !claude.fixedRedirectPort);

    // Occupy 1455, then require a typed, self-explaining failure.
    const blocker = await new Promise((resolve) => {
      const s = http.createServer((_q, r) => r.end('held'));
      s.once('error', () => resolve(null));
      s.listen(1455, '127.0.0.1', () => resolve(s));
    });
    if (blocker) {
      let opened = '';
      let err = null;
      try {
        await po.authorize('chatgpt', { openExternal: (u) => { opened = u; }, timeoutMs: 800 });
      } catch (e) { err = e; }
      eq('a busy registered port is a typed failure', err && err.code, 'redirect_port_busy');
      ok('the message names the URI OpenAI accepts',
        /only accepts http:\/\/localhost:1455\/auth\/callback/.test(String(err && err.message)), err && err.message);
      ok('the message names who holds the port', /is held by /.test(String(err && err.message)), err && err.message);
      eq('no unusable authorize URL is opened', opened, '');
      eq('the failure carries the port for the UI', err && err.port, 1455);

      // The listener itself must refuse rather than rebind.
      let strictErr = null;
      try {
        const loop = await I.startLoopbackServer({ path: '/auth/callback', port: 1455, redirectHost: 'localhost', strictPort: true, timeoutMs: 300, state: 's' });
        loop.close();
      } catch (e) { strictErr = e; }
      eq('a strict listener reports EADDRINUSE', strictErr && strictErr.code, 'EADDRINUSE');

      // Providers that accept any loopback port keep the ephemeral fallback.
      const loop2 = await I.startLoopbackServer({ path: '/callback', port: 1455, redirectHost: 'localhost', timeoutMs: 300, state: 's' });
      ok('a non-strict listener still finds a free port', loop2.port > 0 && loop2.port !== 1455, loop2.port);
      loop2.close();
      blocker.close();
      await new Promise((r) => setTimeout(r, 50));
    } else {
      ok('port 1455 was occupiable for the strict-port test', false, 'listen failed');
    }
  }

  console.log('\n=== RESULT: ' + pass + ' passed, ' + (process.exitCode ? 'FAILURES' : '0 failed') + ' ===');
})().catch((e) => { console.error('SUITE CRASHED', e); process.exit(1); });
