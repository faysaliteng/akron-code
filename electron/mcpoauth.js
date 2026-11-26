'use strict';
/**
 * Akron Code — MCP OAuth 2.1 sign-in for hosted connectors.
 *
 * Implements the flow the Desktop app runs for OAuth-gated MCP servers:
 *
 *   1. Protected-resource metadata   (RFC 9728)  → which AS issues tokens
 *   2. Authorization-server metadata (RFC 8414)  → authorize / token / register
 *   3. Dynamic client registration   (RFC 7591)  → client_id without a dashboard
 *   4. PKCE S256 + state            (RFC 7636)  → loopback redirect on 127.0.0.1
 *   5. Code → token exchange         (RFC 6749)  → bearer for the MCP transport
 *   6. Refresh-token rotation                    → silent re-auth on expiry
 *
 * Pure Node: no Electron import. The caller injects `openExternal`, a secret
 * `store` ({get,set,del}) and (in tests) a `fetchImpl`. That keeps the whole
 * state machine unit-testable and keeps tokens inside the OS keychain.
 */

const http = require('http');
const crypto = require('crypto');

const CALLBACK_PATH = '/callback';
const REDIRECT_HOST = '127.0.0.1';
const DEFAULT_TIMEOUT = 5 * 60 * 1000;
const CLIENT_NAME = 'Akron Code';
const REFRESH_SKEW = 60 * 1000;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: 'S256' };
}

function randomState() { return b64url(crypto.randomBytes(16)); }

function stripMarkup(s) {
  return String(s == null ? '' : s)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[{}"]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a `WWW-Authenticate` header into `{ scheme, params }`.
 * Handles `Bearer resource_metadata="https://…", scope="a b"`.
 */
function parseWwwAuthenticate(header) {
  const out = { scheme: '', params: {} };
  const raw = String(header || '').trim();
  if (!raw) return out;
  const sp = raw.search(/\s/);
  out.scheme = (sp === -1 ? raw : raw.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : raw.slice(sp + 1);
  const re = /([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g;
  let m;
  while ((m = re.exec(rest))) {
    const key = m[1].toLowerCase();
    const val = m[2] !== undefined ? m[2].replace(/\\(.)/g, '$1') : m[3];
    out.params[key] = val;
  }
  return out;
}

/** True when a response demands an OAuth bearer token. */
function isAuthChallenge(status, headers) {
  const get = (h) => (headers && (typeof headers.get === 'function' ? headers.get(h) : headers[h])) || '';
  const www = get('www-authenticate');
  if (Number(status) === 401) return { required: true, resourceMetadata: parseWwwAuthenticate(www).params.resource_metadata || null, header: www || null };
  if (/^\s*bearer\b/i.test(www)) return { required: true, resourceMetadata: parseWwwAuthenticate(www).params.resource_metadata || null, header: www || null };
  return { required: false, resourceMetadata: null, header: null };
}

// ---------------------------------------------------------------------------
// Well-known URL candidates
// ---------------------------------------------------------------------------
function resourceMetadataUrls(endpointUrl) {
  let u;
  try { u = new URL(endpointUrl); } catch (_) { return []; }
  const path = u.pathname.replace(/\/+$/, '');
  const urls = [];
  if (path) urls.push(u.origin + '/.well-known/oauth-protected-resource' + path);
  urls.push(u.origin + '/.well-known/oauth-protected-resource');
  if (path) urls.push(u.origin + path + '/.well-known/oauth-protected-resource');
  return [...new Set(urls)];
}

function authServerMetadataUrls(issuer) {
  let u;
  try { u = new URL(issuer); } catch (_) { return []; }
  const path = u.pathname.replace(/\/+$/, '');
  const urls = [];
  if (path) {
    urls.push(u.origin + '/.well-known/oauth-authorization-server' + path);
    urls.push(u.origin + path + '/.well-known/oauth-authorization-server');
    urls.push(u.origin + path + '/.well-known/openid-configuration');
  }
  urls.push(u.origin + '/.well-known/oauth-authorization-server');
  urls.push(u.origin + '/.well-known/openid-configuration');
  return [...new Set(urls)];
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function fetchJson(url, opts, fetchImpl) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('no fetch implementation available');
  const o = opts || {};
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), o.timeoutMs || 8000);
  try {
    const res = await f(url, { redirect: 'follow', ...(o.request || {}), signal: ctl.signal });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
    return {
      ok: !!res.ok,
      status: res.status,
      headers: res.headers,
      body,
      text: String(text || ''),
    };
  } catch (err) {
    if (err && err.name === 'AbortError') throw new Error('request timed out: ' + url);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
/** RFC 9728 — find the protected-resource metadata for an MCP endpoint. */
async function discoverProtectedResource(endpointUrl, opts) {
  const o = opts || {};
  for (const url of resourceMetadataUrls(endpointUrl)) {
    try {
      const r = await fetchJson(url, { request: { headers: { accept: 'application/json' } }, timeoutMs: o.timeoutMs }, o.fetchImpl);
      if (r.ok && r.body && (r.body.authorization_servers || r.body.resource)) {
        return { metadata: r.body, url };
      }
    } catch (_) { /* try the next candidate */ }
  }
  return null;
}

/**
 * RFC 8414 / OIDC discovery. Falls back to conventional endpoints on the
 * issuer origin when no metadata document is published (many MCP servers do
 * not ship one yet).
 */
async function discoverAuthServer(issuer, opts) {
  const o = opts || {};
  for (const url of authServerMetadataUrls(issuer)) {
    try {
      const r = await fetchJson(url, { request: { headers: { accept: 'application/json' } }, timeoutMs: o.timeoutMs }, o.fetchImpl);
      if (r.ok && r.body && r.body.authorization_endpoint && r.body.token_endpoint) {
        return { ...r.body, metadata_url: url };
      }
    } catch (_) { /* try the next candidate */ }
  }
  let base;
  try { base = new URL(issuer).origin; } catch (_) { base = String(issuer || '').replace(/\/+$/, ''); }
  if (!base) throw new Error('could not discover the authorization server for this connector');
  return {
    issuer: base,
    authorization_endpoint: base + '/authorize',
    token_endpoint: base + '/token',
    registration_endpoint: base + '/register',
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    fallback: true,
  };
}

// ---------------------------------------------------------------------------
// Dynamic client registration (RFC 7591)
// ---------------------------------------------------------------------------
function pickAuthMethod(as, requested) {
  const supported = (as && as.token_endpoint_auth_methods_supported) || [];
  const wanted = requested || 'none';
  if (!supported.length) return wanted;
  if (supported.includes(wanted)) return wanted;
  for (const m of ['none', 'client_secret_post', 'client_secret_basic']) {
    if (supported.includes(m)) return m;
  }
  return supported[0];
}

async function registerClient(as, redirectUri, opts) {
  const o = opts || {};
  if (!as || !as.registration_endpoint) {
    throw new Error('this connector does not support automatic sign-up; paste an API key instead');
  }
  const method = pickAuthMethod(as, o.authMethod);
  const payload = {
    client_name: o.clientName || CLIENT_NAME,
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: method,
    application_type: 'native',
  };
  if (o.scopes) payload.scope = o.scopes;
  const r = await fetchJson(as.registration_endpoint, {
    request: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    },
    timeoutMs: o.timeoutMs,
  }, o.fetchImpl);
  if (!r.ok || !r.body || !r.body.client_id) {
    const detail = r.body && (r.body.error_description || r.body.error) ? stripMarkup(r.body.error_description || r.body.error) : '';
    throw new Error('connector sign-up failed (' + r.status + ')' + (detail ? ': ' + detail : ''));
  }
  return {
    client_id: r.body.client_id,
    client_secret: r.body.client_secret || null,
    token_endpoint_auth_method: r.body.token_endpoint_auth_method || method,
    redirect_uris: r.body.redirect_uris || [redirectUri],
  };
}

// ---------------------------------------------------------------------------
// Authorization request + token exchange
// ---------------------------------------------------------------------------
function buildAuthorizationUrl(p) {
  const u = new URL(p.as.authorization_endpoint);
  const q = u.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId);
  q.set('redirect_uri', p.redirectUri);
  q.set('code_challenge', p.codeChallenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', p.state);
  if (p.scope) q.set('scope', p.scope);
  if (p.resource) q.set('resource', p.resource);
  return u.toString();
}

function normalizeTokens(body) {
  const out = { token_type: body.token_type || 'Bearer' };
  if (body.access_token) out.access_token = String(body.access_token);
  if (body.refresh_token) out.refresh_token = String(body.refresh_token);
  if (body.scope) out.scope = String(body.scope);
  if (body.expires_in != null && isFinite(Number(body.expires_in))) {
    out.expires_in = Number(body.expires_in);
    out.expires_at = Date.now() + Number(body.expires_in) * 1000;
  }
  return out;
}

async function tokenRequest(as, params, opts) {
  const o = opts || {};
  const body = new URLSearchParams(params);
  const headers = {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  };
  if (o.clientSecret && o.authMethod === 'client_secret_basic') {
    headers.authorization = 'Basic ' + Buffer.from(o.clientId + ':' + o.clientSecret).toString('base64');
  } else if (o.clientSecret && o.authMethod !== 'none') {
    // `none` means a public client: the verifier is the only proof we hold.
    body.set('client_secret', o.clientSecret);
  }
  const r = await fetchJson(as.token_endpoint, {
    request: { method: 'POST', headers, body: body.toString() },
    timeoutMs: o.timeoutMs,
  }, o.fetchImpl);
  if (!r.ok || !r.body || !r.body.access_token) {
    const detail = r.body && (r.body.error_description || r.body.error) ? stripMarkup(r.body.error_description || r.body.error) : stripMarkup(r.text).slice(0, 160);
    const err = new Error('token exchange failed (' + r.status + ')' + (detail ? ': ' + detail : ''));
    err.status = r.status;
    err.oauthError = r.body && r.body.error ? r.body.error : null;
    throw err;
  }
  return normalizeTokens(r.body);
}

async function exchangeCode(p) {
  const params = {
    grant_type: 'authorization_code',
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: p.clientId,
    code_verifier: p.codeVerifier,
  };
  if (p.resource) params.resource = p.resource;
  return tokenRequest(p.as, params, p);
}

async function refresh(p) {
  const params = {
    grant_type: 'refresh_token',
    refresh_token: p.refreshToken,
    client_id: p.clientId,
  };
  if (p.resource) params.resource = p.resource;
  return tokenRequest(p.as, params, p);
}

// ---------------------------------------------------------------------------
// Loopback redirect listener
// ---------------------------------------------------------------------------
function resultPage(payload) {
  const bad = !!payload.error;
  const title = bad ? 'Sign-in did not complete' : 'Signed in to Akron Code';
  const line = bad
    ? stripMarkup(payload.errorDescription || payload.error || 'The provider returned an error.')
    : 'You can close this window and return to Akron Code.';
  const color = bad ? '#c0392b' : '#047857';
  return '<!doctype html><html><head><meta charset="utf-8"><title>' + title + '</title>' +
    '<style>html,body{height:100%;margin:0;background:#F5FAF8;color:#12211c;' +
    'font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:flex;' +
    'align-items:center;justify-content:center}main{max-width:420px;padding:36px;text-align:center}' +
    '.dot{width:44px;height:44px;border-radius:50%;background:' + color + ';margin:0 auto 18px}' +
    'h1{font-size:18px;margin:0 0 8px;color:#0b3d2e}p{margin:0;color:#4f6b60}</style></head><body><main>' +
    '<div class="dot"></div><h1>' + title + '</h1><p>' + line + '</p></main></body></html>';
}

/**
 * Start a one-shot loopback listener and resolve the redirect URI.
 * `wait()` resolves `{ code, state }` or `{ error }` — never rejects, so a
 * timeout cannot surface as an unhandled rejection.
 */
function startLoopback(opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    let settle = null;
    const done = new Promise((res) => { settle = res; });
    let timer = null;
    let closed = false;
    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch (_) {}
    };
    const server = http.createServer((req, res) => {
      let u;
      try { u = new URL(req.url, 'http://' + REDIRECT_HOST); } catch (_) { res.writeHead(400); res.end('bad request'); return; }
      if (u.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
        return;
      }
      const payload = {
        code: u.searchParams.get('code'),
        state: u.searchParams.get('state'),
        error: u.searchParams.get('error'),
        errorDescription: u.searchParams.get('error_description'),
      };
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(resultPage(payload));
      stop();
      settle(payload);
    });
    server.on('error', (err) => { stop(); reject(err); });
    server.listen(0, REDIRECT_HOST, () => {
      const port = server.address().port;
      const redirectUri = 'http://' + REDIRECT_HOST + ':' + port + CALLBACK_PATH;
      timer = setTimeout(() => {
        stop();
        settle({ code: null, state: null, error: 'timeout', errorDescription: 'sign-in was not completed in time' });
      }, o.timeoutMs || DEFAULT_TIMEOUT);
      if (typeof timer.unref === 'function') timer.unref();
      resolve({ redirectUri, port, wait: () => done, close: stop });
    });
  });
}

// ---------------------------------------------------------------------------
// Token records
// ---------------------------------------------------------------------------
function storeKey(endpointUrl) {
  let u;
  try { u = new URL(endpointUrl); } catch (_) { return 'mcp-oauth:' + String(endpointUrl || '').slice(0, 80); }
  const p = u.pathname.replace(/\/+$/, '');
  return 'mcp-oauth:' + u.host.toLowerCase() + (p && p !== '/' ? p : '');
}

function readRecord(endpointUrl, store) {
  if (!store) return null;
  try {
    const raw = store.get(storeKey(endpointUrl));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (_) { return null; }
}

function saveRecord(strategy, record) {
  if (!strategy || !strategy.store) return;
  strategy.store.set(storeKey(strategy.endpointUrl), JSON.stringify(record));
}

/**
 * Return a usable bearer token for `endpointUrl`, refreshing when expired.
 * `strategy` = { endpointUrl, store, fetchImpl, timeoutMs }.
 */
async function ensureAccessToken(strategy) {
  const s = strategy || {};
  const rec = readRecord(s.endpointUrl, s.store);
  if (!rec || !rec.access_token) return null;
  const fresh = !rec.expires_at || Date.now() < rec.expires_at - REFRESH_SKEW;
  if (fresh) return rec.access_token;
  if (!rec.refresh_token || !rec.token_endpoint) return null;
  try {
    const tokens = await refresh({
      as: { token_endpoint: rec.token_endpoint },
      clientId: rec.client_id,
      clientSecret: rec.client_secret,
      authMethod: rec.auth_method,
      refreshToken: rec.refresh_token,
      resource: rec.resource || s.endpointUrl,
      fetchImpl: s.fetchImpl,
      timeoutMs: s.timeoutMs,
    });
    const merged = { ...rec, ...tokens, refreshed_at: Date.now() };
    if (!tokens.refresh_token) merged.refresh_token = rec.refresh_token;
    saveRecord(s, merged);
    return merged.access_token;
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Full flow
// ---------------------------------------------------------------------------
/**
 * Run discovery → registration → PKCE → browser → exchange.
 *
 * opts = {
 *   endpointUrl, store, openExternal, fetchImpl, timeoutMs,
 *   resourceMetadataUrl   hint from a 401 WWW-Authenticate header
 *   clientId, clientSecret, tokenEndpointAuthMethod  pre-registered client
 *   scope, clientName
 * }
 */
async function authorize(opts) {
  const o = opts || {};
  if (!o.endpointUrl) throw new Error('this connector has no MCP endpoint to sign in to');
  if (!o.store) throw new Error('no secret store available for the sign-in');

  const loop = await startLoopback({ timeoutMs: o.timeoutMs });
  try {
    // 1. Protected resource metadata (RFC 9728).
    let resource = null;
    if (o.resourceMetadataUrl) {
      try {
        const r = await fetchJson(o.resourceMetadataUrl, { request: { headers: { accept: 'application/json' } } }, o.fetchImpl);
        if (r.ok && r.body) resource = { metadata: r.body, url: o.resourceMetadataUrl };
      } catch (_) {}
    }
    if (!resource) resource = await discoverProtectedResource(o.endpointUrl, o);

    // 2. Which authorization server, and which scopes.
    let issuer = null;
    let scope = o.scope || '';
    if (resource && resource.metadata) {
      const servers = resource.metadata.authorization_servers;
      if (Array.isArray(servers) && servers.length) issuer = servers[0];
      if (!scope && Array.isArray(resource.metadata.scopes_supported)) scope = resource.metadata.scopes_supported.join(' ');
    }
    if (!issuer) {
      try { issuer = new URL(o.endpointUrl).origin; } catch (_) { issuer = String(o.endpointUrl); }
    }

    // 3. Authorization-server metadata (RFC 8414 / OIDC), with fallbacks.
    const as = await discoverAuthServer(issuer, o);
    if (!scope && Array.isArray(as.scopes_supported) && as.scopes_supported.length) {
      scope = as.scopes_supported.join(' ');
    }

    // 4. Client identity: pre-registered or dynamic registration.
    let client;
    if (o.clientId) {
      client = {
        client_id: o.clientId,
        client_secret: o.clientSecret || null,
        token_endpoint_auth_method: o.tokenEndpointAuthMethod || 'none',
      };
    } else {
      client = await registerClient(as, loop.redirectUri, { ...o, scopes: scope });
    }

    // 5. PKCE authorization request.
    const pk = pkce();
    const state = randomState();
    const authUrl = buildAuthorizationUrl({
      as,
      clientId: client.client_id,
      redirectUri: loop.redirectUri,
      codeChallenge: pk.challenge,
      state,
      scope,
      resource: o.endpointUrl,
    });

    let opened = false;
    if (typeof o.openExternal === 'function') {
      await o.openExternal(authUrl);
      opened = true;
    }

    const cb = await loop.wait();
    if (cb.error) {
      const err = new Error(cb.error === 'timeout'
        ? 'sign-in was not completed in time'
        : stripMarkup(cb.errorDescription || cb.error));
      err.oauthError = cb.error;
      throw err;
    }
    if (!cb.code) throw new Error('sign-in was cancelled');
    if (cb.state !== state) throw new Error('sign-in state did not match; the request was rejected');

    // 6. Code → token.
    const tokens = await exchangeCode({
      as,
      clientId: client.client_id,
      clientSecret: client.client_secret,
      authMethod: client.token_endpoint_auth_method,
      code: cb.code,
      codeVerifier: pk.verifier,
      redirectUri: loop.redirectUri,
      resource: o.endpointUrl,
      fetchImpl: o.fetchImpl,
      timeoutMs: o.timeoutMs,
    });

    const record = {
      ...tokens,
      client_id: client.client_id,
      client_secret: client.client_secret || null,
      auth_method: client.token_endpoint_auth_method || 'none',
      issuer: as.issuer || issuer,
      authorization_endpoint: as.authorization_endpoint,
      token_endpoint: as.token_endpoint,
      registration_endpoint: as.registration_endpoint || null,
      resource: o.endpointUrl,
      scope,
      obtained_at: Date.now(),
    };
    saveRecord({ endpointUrl: o.endpointUrl, store: o.store }, record);

    return {
      ok: true,
      authUrl,
      opened,
      tokens: record,
      client,
      authorizationServer: as,
      resourceMetadata: resource ? resource.metadata : null,
    };
  } finally {
    try { loop.close(); } catch (_) {}
  }
}

/** Revoke a connector's stored token record (local sign-out). */
function signOut(endpointUrl, store) {
  if (!store) return false;
  try { return !!store.del(storeKey(endpointUrl)); } catch (_) { return false; }
}

/** Human one-liner for the UI. Never returns raw markup or a JSON-RPC envelope. */
/**
 * Pull the human sentence out of an error before markup stripping.
 * A JSON / JSON-RPC envelope becomes its `error_description` or `message`;
 * anything that is not JSON is returned verbatim for the keyword ladder.
 * Returns '' when the envelope carries no usable text.
 */
function unwrapMessage(err) {
  const text = String((err && (err.message || err.error_description)) || err || '').trim();
  if (!/^[[{]/.test(text)) return text;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return text; // not actually JSON — let the ladder deal with it
  }
  if (!obj || typeof obj !== 'object') return String(obj == null ? '' : obj);
  const pick = [
    obj.error_description,
    obj.message,
    obj.error && obj.error.message,
    typeof obj.error === 'string' ? obj.error : '',
    obj.detail,
    obj.title,
    obj.statusText,
  ].find((v) => typeof v === 'string' && v.trim());
  return pick || '';
}

function describeAuthError(err) {
  const raw = stripMarkup(unwrapMessage(err));
  if (!raw) return 'connector sign-in failed';
  if (/timeout|timed out|not completed in time/i.test(raw)) return 'sign-in was not completed in time';
  if (/cancelled|canceled|denied|access_denied/i.test(raw)) return 'sign-in was cancelled';
  if (/state did not match/i.test(raw)) return 'sign-in was rejected for security reasons — try again';
  if (/dynamic client registration|does not support automatic/i.test(raw)) return 'this connector needs an API key instead of browser sign-in';
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return 'the connector host could not be resolved';
  if (/ECONNREFUSED|ECONNRESET/i.test(raw)) return 'the connector host refused the connection';
  if (/invalid_client|unauthorized_client/i.test(raw)) return 'the connector rejected this app registration';
  if (/unauthori[sz]ed|forbidden|\b401\b|\b403\b/i.test(raw)) return 'the connector rejected the sign-in — it may need a different account';
  // Residue from an envelope that had no message: never echo wire syntax.
  if (/jsonrpc|\bcode\s*:?\s*-?\d{3,}/i.test(raw)) return 'connector sign-in failed';
  if (/^\d+$/.test(raw)) return 'connector sign-in failed';
  return raw.replace(/\s+/g, ' ').slice(0, 160);
}

module.exports = {
  // primitives
  pkce,
  randomState,
  parseWwwAuthenticate,
  isAuthChallenge,
  stripMarkup,
  unwrapMessage,
  // discovery
  resourceMetadataUrls,
  authServerMetadataUrls,
  discoverProtectedResource,
  discoverAuthServer,
  // registration + flow
  registerClient,
  pickAuthMethod,
  buildAuthorizationUrl,
  exchangeCode,
  refresh,
  normalizeTokens,
  startLoopback,
  authorize,
  // token records
  storeKey,
  readRecord,
  ensureAccessToken,
  signOut,
  describeAuthError,
  // reference data
  CALLBACK_PATH,
  REDIRECT_HOST,
  DEFAULT_TIMEOUT,
  CLIENT_NAME,
};
