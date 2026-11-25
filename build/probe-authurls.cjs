#!/usr/bin/env node
/**
 * Validate every subscription provider's browser sign-in config against the live
 * vendor, without completing a sign-in and without touching any account.
 *
 *   node build/probe-authurls.cjs
 *
 * Two kinds of proof are used, because a bare Node `fetch` is not a browser:
 *   1. ask the vendor — GET the authorize URL we build and read the answer. A
 *      config mistake shows up as `invalid_client`, `invalid_redirect_uri`,
 *      `redirect_uri_mismatch` or `unsupported_response_type`; a good config
 *      redirects to the vendor's own login surface.
 *   2. ask the discovery document — xAI fronts `auth.x.ai` with Cloudflare bot
 *      management, so *every* Node request 403s (even with no query string).
 *      That is a client-fingerprint gate, not a config error, and the app opens
 *      the URL in the real browser where it passes. For that provider the
 *      endpoint, PKCE method, auth method and scope set are checked against
 *      `/.well-known/openid-configuration` instead.
 *
 * No secrets are involved: these URLs carry a throwaway PKCE challenge and state.
 */
const path = require('path');
const P = require(path.join(__dirname, '..', 'electron', 'provider-oauth.js'));
const mcpoauth = require(path.join(__dirname, '..', 'electron', 'mcpoauth.js'));

const T = P._internal;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const CONFIG_ERROR = /invalid_client|invalid_redirect_uri|unauthorized_client|redirect_uri_mismatch|unsupported_response_type|access_denied/i;

const rows = [];
const check = (name, ok, detail) => rows.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) });

function authorizeUrl(prov) {
  const { challenge } = mcpoauth.pkce();
  const state = mcpoauth.randomState();
  return T.buildAuthorizeUrl(prov, {
    redirectUri: `http://${prov.redirectHost}:${prov.redirectPort}${prov.redirectPath}`,
    state,
    challenge,
    nonce: prov.authNonce ? mcpoauth.randomState() : '',
  });
}

async function get(url) {
  const res = await fetch(url, { redirect: 'manual', headers: { 'user-agent': UA } });
  const body = await res.text();
  return {
    status: res.status,
    location: res.headers.get('location') || '',
    server: res.headers.get('server') || '',
    body,
  };
}

async function probeClaude(prov) {
  const url = authorizeUrl(prov);
  const r = await get(url);
  const bad = (r.location + ' ' + r.body).match(CONFIG_ERROR);
  check('claude authorize page renders', r.status === 200 || (r.status >= 300 && r.status < 400), 'HTTP ' + r.status);
  check('claude config accepted', !bad, bad ? bad[0] : 'no config error in the response');
}

async function probeChatgpt(prov) {
  const url = authorizeUrl(prov);
  const u = new URL(url);
  check('chatgpt uses the Codex client id', u.searchParams.get('client_id') === prov.clientId, u.searchParams.get('client_id'));
  check('chatgpt asks for the CLI scope set', /offline_access/.test(u.searchParams.get('scope')) && /api\.connectors\.invoke/.test(u.searchParams.get('scope')), u.searchParams.get('scope'));
  check('chatgpt sends the simplified-flow flags', u.searchParams.get('codex_cli_simplified_flow') === 'true' && u.searchParams.get('id_token_add_organizations') === 'true', 'codex_cli_simplified_flow + id_token_add_organizations');
  const r = await get(url);
  const bad = (r.location + ' ' + r.body).match(CONFIG_ERROR);
  check('chatgpt config accepted', r.status > 0 && r.status < 400 && !bad, 'HTTP ' + r.status + (r.location ? ' → ' + r.location : '') + (bad ? ' !! ' + bad[0] : ''));
}

async function probeAntigravity(prov) {
  const url = authorizeUrl(prov);
  const u = new URL(url);
  check('antigravity keeps the personal client id', /apps\.googleusercontent\.com$/.test(u.searchParams.get('client_id')), String(u.searchParams.get('client_id')).slice(0, 24) + '…');
  check('antigravity asks for offline consent', u.searchParams.get('access_type') === 'offline' && u.searchParams.get('prompt') === 'consent', u.searchParams.get('access_type') + '/' + u.searchParams.get('prompt'));
  const r = await get(url);
  const bad = (r.location + ' ' + r.body).match(CONFIG_ERROR);
  check('antigravity redirect_uri accepted by Google', r.status > 0 && r.status < 400 && !bad, 'HTTP ' + r.status + (bad ? ' !! ' + bad[0] : ''));
}

async function probeGrok(prov) {
  const url = authorizeUrl(prov);
  const r = await get(url);
  const cfBlocked = r.status === 403 && /cloudflare/i.test(r.server) && /Attention Required|cf-error/i.test(r.body);
  if (cfBlocked) {
    // Prove the block is unrelated to our parameters: even a bare request 403s.
    const bare = await get(prov.authorizeUrl);
    check('grok endpoint is Cloudflare-gated for non-browsers', bare.status === 403 && /cloudflare/i.test(bare.server), 'HTTP ' + r.status + ' with and without params (server: ' + r.server + ') — the app opens a real browser');
  } else {
    const bad = (r.location + ' ' + r.body).match(CONFIG_ERROR);
    check('grok config accepted', r.status > 0 && r.status < 400 && !bad, 'HTTP ' + r.status + (bad ? ' !! ' + bad[0] : ''));
  }

  const disc = await (await fetch('https://auth.x.ai/.well-known/openid-configuration')).json();
  check('grok authorize endpoint matches discovery', disc.authorization_endpoint === prov.authorizeUrl, disc.authorization_endpoint);
  check('grok token endpoint matches discovery', disc.token_endpoint === prov.tokenUrl, disc.token_endpoint);
  check('grok userinfo endpoint matches discovery', disc.userinfo_endpoint === prov.userinfoUrl, disc.userinfo_url || disc.userinfo_endpoint);
  check('grok is a public PKCE code client', (disc.response_types_supported || []).includes('code') && (disc.code_challenge_methods_supported || []).includes('S256') && (disc.token_endpoint_auth_methods_supported || []).includes('none'), JSON.stringify(disc.code_challenge_methods_supported));
  const missing = (prov.scopes || []).filter((s) => !(disc.scopes_supported || []).includes(s));
  check('grok advertises every requested scope', missing.length === 0, missing.length ? 'missing: ' + missing.join(',') : (prov.scopes || []).join(' '));
}

(async () => {
  const probes = [['claude', probeClaude], ['chatgpt', probeChatgpt], ['antigravity', probeAntigravity], ['grok', probeGrok]];
  for (const [id, fn] of probes) {
    const prov = P.provider(id);
    if (!prov) { check(id + ' provider exists', false, 'missing descriptor'); continue; }
    try { await fn(prov); } catch (e) { check(id + ' probe ran', false, String(e && e.message || e)); }
  }
  // One provider's checks are contiguous; regroup by provider for readable output.
  let current = '';
  for (const r of rows) {
    const owner = r.name.split(' ')[0];
    if (owner !== current) { current = owner; console.log('\n' + current); }
    console.log('  ' + (r.ok ? 'PASS' : 'FAIL') + ' ' + r.name + (r.detail ? '  — ' + r.detail : ''));
  }
  const bad = rows.filter((r) => !r.ok);
  console.log('\n' + (rows.length - bad.length) + '/' + rows.length + (bad.length ? ' — ' + bad.length + ' FAILURE(S)' : ' PASS'));
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error('ERR', (e && e.stack) || e); process.exit(2); });
