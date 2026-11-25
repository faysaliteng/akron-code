'use strict';
// MCP OAuth 2.1 sign-in — offline coverage of the whole state machine.
//
// Every network hop is a fake fetch; the only real I/O is the loopback
// redirect listener (a genuine 127.0.0.1 HTTP server) so the PKCE round trip is
// exercised end to end without touching a provider.
const crypto = require('crypto');
const o = require('../electron/mcpoauth');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); process.exitCode = 1; }
};
const eq = (name, actual, expected) => ok(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });

function response(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const h = new Headers();
  for (const [k, v] of Object.entries(headers || {})) h.set(k, v);
  return { ok: status >= 200 && status < 300, status, headers: h, text: async () => text, json: async () => JSON.parse(text) };
}

function makeFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    const u = String(url);
    calls.push({ url: u, method: (opts && opts.method) || 'GET', body: opts && opts.body, headers: (opts && opts.headers) || {} });
    const h = routes[u];
    if (!h) return response(404, { error: 'not_found' });
    return h(opts);
  };
  f.calls = calls;
  return f;
}

function memoryStore(seed) {
  const db = new Map(Object.entries(seed || {}));
  return {
    get: (k) => (db.has(k) ? db.get(k) : null),
    set: (k, v) => { db.set(k, v); return true; },
    del: (k) => db.delete(k),
    has: (k) => db.has(k),
    raw: db,
  };
}

// ---------------------------------------------------------------------------
console.log('\nOAUTH — PKCE and state');
// ---------------------------------------------------------------------------
const pk = o.pkce();
ok('verifier is base64url-safe', /^[A-Za-z0-9_-]{43,128}$/.test(pk.verifier), pk.verifier.length);
eq('challenge is S256', pk.method, 'S256');
eq('challenge = base64url(sha256(verifier))',
  pk.challenge,
  crypto.createHash('sha256').update(pk.verifier).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
ok('two verifiers differ', o.pkce().verifier !== pk.verifier);
ok('state is 16+ bytes', /^[A-Za-z0-9_-]{20,}$/.test(o.randomState()), o.randomState().length);
ok('two states differ', o.randomState() !== o.randomState());

// ---------------------------------------------------------------------------
console.log('\nOAUTH — WWW-Authenticate parsing');
// ---------------------------------------------------------------------------
const p1 = o.parseWwwAuthenticate('Bearer realm="mcp", resource_metadata="https://x/.well-known/oauth-protected-resource/mcp", error="invalid_token"');
eq('scheme lowercased', p1.scheme, 'bearer');
eq('resource_metadata extracted', p1.params.resource_metadata, 'https://x/.well-known/oauth-protected-resource/mcp');
eq('multiple params', p1.params.realm, 'mcp');
eq('error param', p1.params.error, 'invalid_token');
eq('empty header', o.parseWwwAuthenticate(''), { scheme: '', params: {} });
eq('bare scheme', o.parseWwwAuthenticate('Bearer').scheme, 'bearer');
eq('unquoted value', o.parseWwwAuthenticate('Bearer scope=read').params.scope, 'read');
eq('escaped quote', o.parseWwwAuthenticate('Bearer a="x\\"y"').params.a, 'x"y');
eq('param names lowercased', o.parseWwwAuthenticate('Bearer Resource_Metadata="u"').params.resource_metadata, 'u');

const c401 = o.isAuthChallenge(401, { 'www-authenticate': 'Bearer resource_metadata="https://r"' });
ok('401 requires auth', c401.required);
eq('401 surfaces resource_metadata', c401.resourceMetadata, 'https://r');
ok('403 without bearer is not a challenge', !o.isAuthChallenge(403, {}).required);
ok('200 with bearer challenge still counts', o.isAuthChallenge(200, new Headers({ 'www-authenticate': 'Bearer realm="x"' })).required);
ok('no headers → not a challenge', !o.isAuthChallenge(500, {}).required);

// ---------------------------------------------------------------------------
console.log('\nOAUTH — well-known URL candidates');
// ---------------------------------------------------------------------------
eq('resource metadata: path-scoped first',
  o.resourceMetadataUrls('https://mcp.linear.app/mcp'),
  ['https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
   'https://mcp.linear.app/.well-known/oauth-protected-resource',
   'https://mcp.linear.app/mcp/.well-known/oauth-protected-resource']);
eq('resource metadata: origin root only once',
  o.resourceMetadataUrls('https://host/'),
  ['https://host/.well-known/oauth-protected-resource']);
eq('bad URL yields nothing', o.resourceMetadataUrls('not a url'), []);
eq('AS metadata: RFC 8414 path insertion',
  o.authServerMetadataUrls('https://auth.example/tenant1')[0],
  'https://auth.example/.well-known/oauth-authorization-server/tenant1');
ok('AS metadata includes OIDC fallback',
  o.authServerMetadataUrls('https://auth.example').includes('https://auth.example/.well-known/openid-configuration'));
eq('AS metadata dedupes for bare origin', o.authServerMetadataUrls('https://auth.example').length, 2);

// ---------------------------------------------------------------------------
console.log('\nOAUTH — discovery');
// ---------------------------------------------------------------------------
(async () => {
  const prmUrl = 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp';
  const asUrl = 'https://auth.linear.app/.well-known/oauth-authorization-server';
  const prmBody = { resource: 'https://mcp.linear.app/mcp', authorization_servers: ['https://auth.linear.app'], scopes_supported: ['read', 'write'] };
  const asBody = {
    issuer: 'https://auth.linear.app',
    authorization_endpoint: 'https://auth.linear.app/authorize',
    token_endpoint: 'https://auth.linear.app/token',
    registration_endpoint: 'https://auth.linear.app/register',
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  };
  const fetch1 = makeFetch({ [prmUrl]: () => response(200, prmBody), [asUrl]: () => response(200, asBody) });

  const prm = await o.discoverProtectedResource('https://mcp.linear.app/mcp', { fetchImpl: fetch1 });
  ok('protected resource found', prm && prm.metadata.authorization_servers[0] === 'https://auth.linear.app', prm && prm.url);
  eq('matched the path-scoped well-known', prm.url, prmUrl);

  const as = await o.discoverAuthServer('https://auth.linear.app', { fetchImpl: fetch1 });
  eq('authorization endpoint', as.authorization_endpoint, 'https://auth.linear.app/authorize');
  eq('token endpoint', as.token_endpoint, 'https://auth.linear.app/token');
  eq('registration endpoint', as.registration_endpoint, 'https://auth.linear.app/register');
  eq('metadata URL recorded', as.metadata_url, asUrl);

  // Discovery order: a 404 on the first candidate must not stop the walk.
  const fetch2 = makeFetch({
    'https://mcp.x.dev/.well-known/oauth-protected-resource': () => response(200, { authorization_servers: ['https://as.x.dev'] }),
  });
  const prm2 = await o.discoverProtectedResource('https://mcp.x.dev/mcp', { fetchImpl: fetch2 });
  ok('falls through to origin-level metadata', prm2 && prm2.url === 'https://mcp.x.dev/.well-known/oauth-protected-resource');

  const fetch3 = makeFetch({});
  ok('no metadata → null', (await o.discoverProtectedResource('https://mcp.none.dev/mcp', { fetchImpl: fetch3 })) === null);

  // AS metadata absent → conventional endpoints on the issuer origin.
  const as2 = await o.discoverAuthServer('https://as.none.dev', { fetchImpl: makeFetch({}) });
  ok('fallback flagged', as2.fallback === true);
  eq('fallback authorize path', as2.authorization_endpoint, 'https://as.none.dev/authorize');
  eq('fallback token path', as2.token_endpoint, 'https://as.none.dev/token');
  eq('fallback register path', as2.registration_endpoint, 'https://as.none.dev/register');
  eq('fallback keeps S256', as2.code_challenge_methods_supported, ['S256']);

  let threw = false;
  try { await o.discoverAuthServer('', { fetchImpl: makeFetch({}) }); } catch (_) { threw = true; }
  ok('empty issuer throws', threw);

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — client registration');
  // -------------------------------------------------------------------------
  const regFetch = makeFetch({
    'https://auth.linear.app/register': () => response(201, { client_id: 'cid-123', client_secret: 'sec-456', token_endpoint_auth_method: 'none' }),
  });
  const client = await o.registerClient(as, 'http://127.0.0.1:5000/callback', { fetchImpl: regFetch, scopes: 'read write' });
  eq('client_id returned', client.client_id, 'cid-123');
  eq('client_secret returned', client.client_secret, 'sec-456');
  const regCall = regFetch.calls[0];
  eq('registration is a POST', regCall.method, 'POST');
  const regBody = JSON.parse(regCall.body);
  eq('redirect URI registered', regBody.redirect_uris, ['http://127.0.0.1:5000/callback']);
  eq('grant types', regBody.grant_types, ['authorization_code', 'refresh_token']);
  eq('response types', regBody.response_types, ['code']);
  eq('native application', regBody.application_type, 'native');
  eq('auth method negotiated to none', regBody.token_endpoint_auth_method, 'none');
  eq('client name branded', regBody.client_name, 'Akron Bot');
  eq('scope forwarded', regBody.scope, 'read write');

  eq('pickAuthMethod prefers none', o.pickAuthMethod({ token_endpoint_auth_methods_supported: ['none', 'client_secret_post'] }), 'none');
  eq('pickAuthMethod falls back to post', o.pickAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_post'] }), 'client_secret_post');
  eq('pickAuthMethod falls back to basic', o.pickAuthMethod({ token_endpoint_auth_methods_supported: ['client_secret_basic'] }), 'client_secret_basic');
  eq('pickAuthMethod with no list keeps none', o.pickAuthMethod({}), 'none');
  eq('pickAuthMethod honours a request', o.pickAuthMethod({ token_endpoint_auth_methods_supported: ['none', 'client_secret_basic'] }, 'client_secret_basic'), 'client_secret_basic');

  const noRegFetch = makeFetch({});
  let regErr = null;
  try { await o.registerClient({ authorization_endpoint: 'a', token_endpoint: 't' }, 'http://127.0.0.1:1/callback', { fetchImpl: noRegFetch }); }
  catch (e) { regErr = e; }
  ok('missing registration endpoint throws', !!regErr && /API key/.test(regErr.message), regErr && regErr.message);

  const badReg = makeFetch({ 'https://as.bad/register': () => response(400, { error: 'invalid_redirect_uri', error_description: 'redirect_uri <script>x</script> is not allowed' }) });
  let badErr = null;
  try { await o.registerClient({ registration_endpoint: 'https://as.bad/register' }, 'http://127.0.0.1:1/callback', { fetchImpl: badReg }); }
  catch (e) { badErr = e; }
  ok('registration error is humanized', !!badErr && /sign-up failed/.test(badErr.message));
  ok('registration error strips markup', !!badErr && !/[<>]/.test(badErr.message), badErr && badErr.message);

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — authorization URL and token exchange');
  // -------------------------------------------------------------------------
  const authUrl = o.buildAuthorizationUrl({
    as, clientId: 'cid-123', redirectUri: 'http://127.0.0.1:5000/callback',
    codeChallenge: 'chal', state: 'st8', scope: 'read write', resource: 'https://mcp.linear.app/mcp',
  });
  const au = new URL(authUrl);
  eq('authorize host', au.origin + au.pathname, 'https://auth.linear.app/authorize');
  eq('response_type', au.searchParams.get('response_type'), 'code');
  eq('client_id', au.searchParams.get('client_id'), 'cid-123');
  eq('redirect_uri', au.searchParams.get('redirect_uri'), 'http://127.0.0.1:5000/callback');
  eq('code_challenge', au.searchParams.get('code_challenge'), 'chal');
  eq('challenge method', au.searchParams.get('code_challenge_method'), 'S256');
  eq('state', au.searchParams.get('state'), 'st8');
  eq('scope', au.searchParams.get('scope'), 'read write');
  eq('resource indicator (RFC 8707)', au.searchParams.get('resource'), 'https://mcp.linear.app/mcp');
  ok('no scope param when empty',
    !new URL(o.buildAuthorizationUrl({ as, clientId: 'c', redirectUri: 'r', codeChallenge: 'x', state: 's' })).searchParams.has('scope'));

  const tokFetch = makeFetch({
    'https://auth.linear.app/token': () => response(200, { access_token: 'at-1', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt-1', scope: 'read' }),
  });
  const tokens = await o.exchangeCode({
    as, clientId: 'cid-123', clientSecret: 'sec-456', authMethod: 'none',
    code: 'authcode', codeVerifier: 'verifier', redirectUri: 'http://127.0.0.1:5000/callback',
    resource: 'https://mcp.linear.app/mcp', fetchImpl: tokFetch,
  });
  eq('access token', tokens.access_token, 'at-1');
  eq('refresh token', tokens.refresh_token, 'rt-1');
  eq('token type', tokens.token_type, 'Bearer');
  ok('expiry timestamp computed', tokens.expires_at > Date.now() + 3000 * 1000);
  const tokBody = new URLSearchParams(tokFetch.calls[0].body);
  eq('grant type', tokBody.get('grant_type'), 'authorization_code');
  eq('code sent', tokBody.get('code'), 'authcode');
  eq('verifier sent', tokBody.get('code_verifier'), 'verifier');
  eq('redirect sent', tokBody.get('redirect_uri'), 'http://127.0.0.1:5000/callback');
  eq('resource sent', tokBody.get('resource'), 'https://mcp.linear.app/mcp');
  ok('content-type is form-encoded', /x-www-form-urlencoded/.test(tokFetch.calls[0].headers['content-type']));
  ok('no client_secret for method none', !tokBody.has('client_secret'));

  // client_secret_post vs client_secret_basic
  const postFetch = makeFetch({ 'https://auth.linear.app/token': () => response(200, { access_token: 'a' }) });
  await o.exchangeCode({ as, clientId: 'c', clientSecret: 's', authMethod: 'client_secret_post', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetchImpl: postFetch });
  eq('secret goes in the body for post', new URLSearchParams(postFetch.calls[0].body).get('client_secret'), 's');

  const basicFetch = makeFetch({ 'https://auth.linear.app/token': () => response(200, { access_token: 'a' }) });
  await o.exchangeCode({ as, clientId: 'c', clientSecret: 's', authMethod: 'client_secret_basic', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetchImpl: basicFetch });
  ok('secret goes in Basic auth', /^Basic /.test(basicFetch.calls[0].headers.authorization || ''), basicFetch.calls[0].headers);
  ok('no secret in body for basic', !new URLSearchParams(basicFetch.calls[0].body).has('client_secret'));

  const failFetch = makeFetch({ 'https://auth.linear.app/token': () => response(400, { error: 'invalid_grant', error_description: 'code expired' }) });
  let tokErr = null;
  try { await o.exchangeCode({ as, clientId: 'c', code: 'x', codeVerifier: 'v', redirectUri: 'r', fetchImpl: failFetch }); }
  catch (e) { tokErr = e; }
  ok('token failure carries status', tokErr && tokErr.status === 400, tokErr && tokErr.status);
  eq('oauth error code preserved', tokErr && tokErr.oauthError, 'invalid_grant');
  ok('token failure message is readable', /code expired/.test(tokErr.message));

  eq('normalizeTokens drops non-numeric expiry', o.normalizeTokens({ access_token: 'a', expires_in: 'soon' }).expires_at, undefined);
  eq('normalizeTokens keeps defaults', o.normalizeTokens({ access_token: 'a' }).token_type, 'Bearer');

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — loopback redirect listener');
  // -------------------------------------------------------------------------
  const loop = await o.startLoopback({ timeoutMs: 5000 });
  ok('listener bound to loopback', /^http:\/\/127\.0\.0\.1:\d+\/callback$/.test(loop.redirectUri), loop.redirectUri);
  const miss = await fetch(loop.redirectUri.replace('/callback', '/nope'));
  eq('unknown path is 404', miss.status, 404);
  const cbRes = await fetch(loop.redirectUri + '?code=abc&state=xyz');
  eq('callback page is 200', cbRes.status, 200);
  const html = await cbRes.text();
  ok('callback page is branded', /Akron Bot/.test(html));
  const got = await loop.wait();
  eq('code captured', got.code, 'abc');
  eq('state captured', got.state, 'xyz');

  const loop2 = await o.startLoopback({ timeoutMs: 5000 });
  const errRes = await fetch(loop2.redirectUri + '?error=access_denied&error_description=user%20said%20no');
  ok('error page renders', /did not complete/.test(await errRes.text()));
  const got2 = await loop2.wait();
  eq('error captured', got2.error, 'access_denied');
  eq('description captured', got2.errorDescription, 'user said no');

  const loop3 = await o.startLoopback({ timeoutMs: 120 });
  const got3 = await loop3.wait();
  eq('timeout resolves (never rejects)', got3.error, 'timeout');
  loop3.close();

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — token records');
  // -------------------------------------------------------------------------
  const store = memoryStore();
  const rec = { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3600 * 1000, client_id: 'c', token_endpoint: 'https://auth.linear.app/token', resource: 'https://mcp.linear.app/mcp' };
  store.set(o.storeKey('https://mcp.linear.app/mcp'), JSON.stringify(rec));
  eq('storeKey derives from host + path', o.storeKey('https://mcp.linear.app/mcp/'), 'mcp-oauth:mcp.linear.app/mcp');
  eq('storeKey lowercases the host', o.storeKey('https://MCP.Linear.App/mcp'), 'mcp-oauth:mcp.linear.app/mcp');
  eq('readRecord returns the object', o.readRecord('https://mcp.linear.app/mcp', store).access_token, 'at');
  eq('readRecord on a missing key', o.readRecord('https://nope.dev/mcp', store), null);
  eq('readRecord tolerates garbage', o.readRecord('https://mcp.linear.app/mcp', memoryStore({ [o.storeKey('https://mcp.linear.app/mcp')]: 'not json' })), null);
  eq('fresh token returned as-is', await o.ensureAccessToken({ endpointUrl: 'https://mcp.linear.app/mcp', store }), 'at');
  eq('no record → null', await o.ensureAccessToken({ endpointUrl: 'https://nope.dev/mcp', store }), null);
  eq('no store → null', await o.ensureAccessToken({ endpointUrl: 'https://mcp.linear.app/mcp' }), null);

  // Expired with a refresh token → refresh runs and the new token is stored.
  const expStore = memoryStore({
    [o.storeKey('https://mcp.linear.app/mcp')]: JSON.stringify({ ...rec, expires_at: Date.now() - 1000 }),
  });
  const refFetch = makeFetch({ 'https://auth.linear.app/token': () => response(200, { access_token: 'at-2', expires_in: 3600 }) });
  const fresh = await o.ensureAccessToken({ endpointUrl: 'https://mcp.linear.app/mcp', store: expStore, fetchImpl: refFetch });
  eq('refresh returns the new token', fresh, 'at-2');
  eq('refresh grant type', new URLSearchParams(refFetch.calls[0].body).get('grant_type'), 'refresh_token');
  eq('refresh keeps the old refresh token', JSON.parse(expStore.get(o.storeKey('https://mcp.linear.app/mcp'))).refresh_token, 'rt');
  eq('refreshed record persisted', JSON.parse(expStore.get(o.storeKey('https://mcp.linear.app/mcp'))).access_token, 'at-2');

  // Expired without a refresh token → null (caller triggers a new sign-in).
  const deadStore = memoryStore({
    [o.storeKey('https://mcp.linear.app/mcp')]: JSON.stringify({ ...rec, refresh_token: null, expires_at: Date.now() - 1000 }),
  });
  eq('expired without refresh → null', await o.ensureAccessToken({ endpointUrl: 'https://mcp.linear.app/mcp', store: deadStore }), null);

  // A failing refresh is swallowed, not thrown into the tool loop.
  const badRefStore = memoryStore({
    [o.storeKey('https://mcp.linear.app/mcp')]: JSON.stringify({ ...rec, expires_at: Date.now() - 1000 }),
  });
  const badRefFetch = makeFetch({ 'https://auth.linear.app/token': () => response(500, { error: 'server_error' }) });
  eq('failed refresh → null', await o.ensureAccessToken({ endpointUrl: 'https://mcp.linear.app/mcp', store: badRefStore, fetchImpl: badRefFetch }), null);

  ok('signOut removes the record', o.signOut('https://mcp.linear.app/mcp', store) === true);
  eq('record gone after signOut', o.readRecord('https://mcp.linear.app/mcp', store), null);
  ok('signOut on an absent key is false', o.signOut('https://nope.dev/mcp', store) === false);

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — end-to-end authorize()');
  // -------------------------------------------------------------------------
  const endpoints = {
    prm: 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
    as: 'https://auth.linear.app/.well-known/oauth-authorization-server',
    reg: 'https://auth.linear.app/register',
    tok: 'https://auth.linear.app/token',
  };
  const e2eRoutes = {
    [endpoints.prm]: () => response(200, prmBody),
    [endpoints.as]: () => response(200, asBody),
    [endpoints.reg]: () => response(201, { client_id: 'cid-e2e' }),
    [endpoints.tok]: () => response(200, { access_token: 'at-e2e', refresh_token: 'rt-e2e', expires_in: 1800 }),
  };
  let sawAuthUrl = null;
  const e2eStore = memoryStore();
  const e2eFetch = makeFetch(e2eRoutes);
  const result = await o.authorize({
    endpointUrl: 'https://mcp.linear.app/mcp',
    store: e2eStore,
    fetchImpl: e2eFetch,
    openExternal: async (url) => {
      sawAuthUrl = url;
      const u = new URL(url);
      const state = u.searchParams.get('state');
      const redirect = u.searchParams.get('redirect_uri');
      // Play the user: hit the loopback callback with a code.
      await fetch(redirect + '?code=code-e2e&state=' + encodeURIComponent(state));
    },
    scope: 'read',
  });
  ok('authorize succeeded', result.ok === true);
  eq('token returned', result.tokens.access_token, 'at-e2e');
  eq('client id recorded', result.tokens.client_id, 'cid-e2e');
  eq('resource recorded', result.tokens.resource, 'https://mcp.linear.app/mcp');
  eq('issuer recorded', result.tokens.issuer, 'https://auth.linear.app');
  ok('browser was opened', !!sawAuthUrl && /^https:\/\/auth\.linear\.app\/authorize/.test(sawAuthUrl), sawAuthUrl);
  eq('token persisted', JSON.parse(e2eStore.get(o.storeKey('https://mcp.linear.app/mcp'))).access_token, 'at-e2e');
  eq('PKCE verifier echoed in the exchange', new URLSearchParams(e2eFetch.calls.find((c) => c.url === endpoints.tok).body).get('code_verifier').length, 43);
  eq('state round-trips', new URL(sawAuthUrl).searchParams.get('state').length > 20, true);

  // State mismatch must abort before the token exchange.
  const mismatchFetch = makeFetch({ ...e2eRoutes, [endpoints.tok]: () => { throw new Error('must not exchange'); } });
  let mismatch = null;
  try {
    await o.authorize({
      endpointUrl: 'https://mcp.linear.app/mcp', store: memoryStore(), fetchImpl: mismatchFetch,
      openExternal: async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri');
        await fetch(redirect + '?code=c&state=wrong');
      },
    });
  } catch (e) { mismatch = e; }
  ok('state mismatch rejected', !!mismatch && /state did not match/.test(mismatch.message), mismatch && mismatch.message);

  // Provider-side error surfaces as a cancellation.
  let denied = null;
  try {
    await o.authorize({
      endpointUrl: 'https://mcp.linear.app/mcp', store: memoryStore(), fetchImpl: makeFetch(e2eRoutes),
      openExternal: async (url) => {
        const redirect = new URL(url).searchParams.get('redirect_uri');
        await fetch(redirect + '?error=access_denied&error_description=user%20denied');
      },
    });
  } catch (e) { denied = e; }
  ok('access_denied is a cancellation', !!denied && /cancelled/.test(o.describeAuthError(denied)), denied && denied.message);

  // Pre-registered client skips dynamic registration entirely.
  const preRegFetch = makeFetch({ ...e2eRoutes });
  await o.authorize({
    endpointUrl: 'https://mcp.linear.app/mcp', store: memoryStore(), fetchImpl: preRegFetch,
    clientId: 'pre-registered', clientSecret: 'pw',
    openExternal: async (url) => {
      const u = new URL(url);
      const redirect = u.searchParams.get('redirect_uri');
      ok('pre-registered client_id used', u.searchParams.get('client_id') === 'pre-registered');
      await fetch(redirect + '?code=c&state=' + encodeURIComponent(u.searchParams.get('state')));
    },
  });
  ok('no registration call for a pre-registered client', !preRegFetch.calls.some((c) => c.url === endpoints.reg));

  // No endpoint → hard error before any listener work.
  let noEp = null;
  try { await o.authorize({ store: memoryStore() }); } catch (e) { noEp = e; }
  ok('missing endpoint throws', !!noEp && /no MCP endpoint/.test(noEp.message));
  let noStore = null;
  try { await o.authorize({ endpointUrl: 'https://x.dev/mcp' }); } catch (e) { noStore = e; }
  ok('missing store throws', !!noStore && /secret store/.test(noStore.message));

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — error humanization');
  // -------------------------------------------------------------------------
  eq('timeout wording', o.describeAuthError(new Error('sign-in was not completed in time')), 'sign-in was not completed in time');
  eq('cancel wording', o.describeAuthError(new Error('access_denied')), 'sign-in was cancelled');
  eq('state wording', o.describeAuthError(new Error('sign-in state did not match; the request was rejected')), 'sign-in was rejected for security reasons — try again');
  eq('registration wording', o.describeAuthError(new Error('connector sign-up failed (400): nope')), 'connector sign-up failed (400): nope');
  eq('no-API-key wording', o.describeAuthError(new Error('this connector does not support automatic sign-up; paste an API key instead')), 'this connector needs an API key instead of browser sign-in');
  eq('DNS wording', o.describeAuthError(new Error('getaddrinfo ENOTFOUND auth.example')), 'the connector host could not be resolved');
  eq('refused wording', o.describeAuthError(new Error('connect ECONNREFUSED 127.0.0.1:1')), 'the connector host refused the connection');
  eq('empty error', o.describeAuthError(null), 'connector sign-in failed');
  const markup = o.describeAuthError(new Error('<html><body><h1>502 Bad Gateway</h1></body></html>'));
  ok('markup stripped', !/[<>]/.test(markup), markup);
  ok('long errors clamped', o.describeAuthError(new Error('x'.repeat(400))).length <= 160);

  // A JSON-RPC envelope must become a human sentence, never wire syntax.
  const envelope = o.describeAuthError(new Error('{"jsonrpc":"2.0","error":{"code":-32000,"message":"Unauthorized"}}'));
  ok('jsonrpc envelope humanized', !/jsonrpc|code|[{"]/i.test(envelope), envelope);
  eq('envelope message extracted', o.describeAuthError(new Error('{"error":"invalid_grant","error_description":"PKCE verification failed"}')), 'PKCE verification failed');
  eq('envelope without message', o.describeAuthError(new Error('{"jsonrpc":"2.0","error":{"code":-32600}}')), 'connector sign-in failed');
  eq('bare numeric error', o.describeAuthError(new Error('42')), 'connector sign-in failed');
  eq('unwrapMessage extracts description', o.unwrapMessage('{"error":"x","error_description":"No account"}'), 'No account');
  eq('unwrapMessage passes plain text', o.unwrapMessage('plain failure'), 'plain failure');
  eq('unwrapMessage on empty envelope', o.unwrapMessage('{"status":500}'), '');

  // -------------------------------------------------------------------------
  console.log('\nOAUTH — '+pass+' passed, '+fail+' failed');
  if (fail) process.exitCode = 1;
})().catch((err) => { console.error('\nFATAL: ' + (err && err.stack || err)); process.exitCode = 1; });
