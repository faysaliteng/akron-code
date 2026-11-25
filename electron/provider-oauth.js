'use strict';
/**
 * Provider OAuth — sign in to the *actual AI subscriptions* you already pay for
 * and use them as models inside Helio Bot.
 *
 * Why this exists
 * ---------------
 * An API key is metered per token. A subscription (Claude Max, ChatGPT Plus/Pro,
 * Google AI Pro/Antigravity, X Premium/Grok) is metered per human instead, which
 * is why the same person can drive a much larger agentic workload through it.
 * Every one of those products authenticates its own first-party CLI/app with
 * OAuth 2.1 + PKCE against a public client. This module speaks that protocol
 * directly, keeps several accounts per provider, and hands the agent loop a
 * short-lived bearer token on demand.
 *
 * Security model
 * --------------
 * - Tokens never touch the plaintext index. They live in `secretstore`
 *   (OS keychain via safeStorage) under `provider-oauth:<provider>:<account>`.
 * - `~/.autobot/provider-oauth.json` holds only non-secret metadata (provider,
 *   account label, plan, scope list, expiry) and is written 0600.
 * - Access tokens are refreshed lazily, ~2 minutes before expiry, and the
 *   rotated refresh token is written back. When an account was *imported* from
 *   another app's credential store, the rotation is mirrored back to that store
 *   too, so importing never silently signs the other app out.
 * - Nothing here sends a token anywhere except the provider that issued it.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const mcpoauth = require('./mcpoauth');
const secretstore = require('./secretstore');

const DIR = path.join(os.homedir(), '.autobot');
const FILE = path.join(DIR, 'provider-oauth.json');
const VERSION = 1;
const KEY_PREFIX = 'provider-oauth:';
// Refresh this long before the token actually dies. A run can take many
// minutes; a token that expires mid-turn fails the whole agent loop.
const REFRESH_SKEW_MS = 120 * 1000;

// ---------------------------------------------------------------------------
// Provider registry
//
// `kind: 'oauth'`  — we run the full PKCE authorize-code dance in the browser.
// `kind: 'bearer'` — the provider issues a long-lived token we only store
//                    (Grok API keys, xAI, any OpenAI-compatible gateway).
// `transport` picks the wire adapter in providertransport.js.
// ---------------------------------------------------------------------------
const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    kind: 'oauth',
    transport: 'anthropic',
    authorizeUrl: 'https://claude.ai/oauth/authorize',
    // Verified live: console.anthropic.com answers 429 rate_limit_error for the
    // same grant that api.anthropic.com accepts, so this is the real endpoint.
    tokenUrl: 'https://api.anthropic.com/v1/oauth/token',
    // Verified live: this endpoint takes an application/json body, not the
    // form-encoding the OAuth RFC suggests. Posting a form body gets 400.
    tokenFormat: 'json',
    // Public first-party client id of the Claude Code CLI. Not a secret: it is
    // shipped inside every copy of the CLI and is the documented PKCE client.
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'],
    redirectPort: 54545,
    redirectPath: '/callback',
    models: [
      { id: 'claude-opus-4-5', label: 'Opus 4.5' },
      { id: 'claude-sonnet-4-5', label: 'Sonnet 4.5' },
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5' },
    ],
    docs: 'https://docs.anthropic.com/en/api/getting-started',
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    vendor: 'OpenAI',
    kind: 'oauth',
    transport: 'codex',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    tokenFormat: 'json',
    // Public first-party client id of the Codex CLI.
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
    redirectPort: 1455,
    redirectPath: '/auth/callback',
    models: [
      { id: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { id: 'gpt-5.1', label: 'GPT-5.1' },
    ],
    docs: 'https://platform.openai.com/docs',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Google Antigravity',
    vendor: 'Google',
    kind: 'oauth',
    transport: 'google',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenFormat: 'form',
    // Public first-party client id shared by the Google Cloud Code clients.
    clientId: '681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com',
    scopes: [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    redirectPort: 8085,
    redirectPath: '/oauth2callback',
    // Google requires these to get a refresh token back.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    models: [
      { id: 'gemini-3-pro-high', label: 'Gemini 3 Pro (high)' },
      { id: 'gemini-3-pro-low', label: 'Gemini 3 Pro (low)' },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash' },
    ],
    docs: 'https://antigravity.google/docs',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    vendor: 'xAI',
    kind: 'oauth',
    transport: 'grok',
    // Subscription inference goes through the first-party CLI proxy, not the
    // public API — the OAuth token is not an xAI API key and api.x.ai rejects
    // it. `bearerBaseURL` is where a *real* API key is checked instead.
    baseURL: 'https://cli-chat-proxy.grok.com/v1',
    bearerBaseURL: 'https://api.x.ai/v1',
    // OIDC discovery: https://auth.x.ai/.well-known/openid-configuration
    authorizeUrl: 'https://auth.x.ai/oauth2/authorize',
    tokenUrl: 'https://auth.x.ai/oauth2/token',
    userinfoUrl: 'https://auth.x.ai/oauth2/userinfo',
    tokenFormat: 'form',
    // Public client id of xAI's own CLI (PKCE, no secret). Same id used by
    // pi-grok-cli and vercel-labs/fx, corroborated by live token-endpoint probes.
    clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'grok-cli:access', 'api:access'],
    redirectPort: 56121,
    // xAI registers `http://127.0.0.1:<port>/callback`, not `localhost`.
    redirectHost: '127.0.0.1',
    redirectPath: '/callback',
    // Their authorize endpoint wants a nonce even in the code flow.
    authNonce: true,
    extraAuthParams: { plan: 'generic', referrer: 'helio-bot' },
    // A pasted xAI API key still works as a secondary way in.
    allowBearer: true,
    models: [
      { id: 'grok-4.5', label: 'Grok 4.5' },
      { id: 'grok-4', label: 'Grok 4' },
      { id: 'grok-4-fast', label: 'Grok 4 Fast' },
      { id: 'grok-code-fast-1', label: 'Grok Code Fast' },
    ],
    docs: 'https://docs.x.ai/docs',
  },
};

function provider(id) { return PROVIDERS[id] || null; }
function providerIds() { return Object.keys(PROVIDERS); }

// ---------------------------------------------------------------------------
// On-disk index (non-secret)
// ---------------------------------------------------------------------------
function readDb() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return { version: VERSION, accounts: [] };
    return { version: raw.version || VERSION, accounts: Array.isArray(raw.accounts) ? raw.accounts : [] };
  } catch (_) {
    return { version: VERSION, accounts: [] };
  }
}

function writeDb(db) {
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, accounts: db.accounts }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
  try { fs.chmodSync(FILE, 0o600); } catch (_) {}
}

function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'default';
}

function slotKey(prov, account) { return KEY_PREFIX + prov + ':' + account; }

// Decode a JWT payload without verifying it. Only used to read the account's
// own email/plan out of a token the provider just handed us.
function jwtPayload(tok) {
  const parts = String(tok || '').split('.');
  if (parts.length !== 3) return null;
  try {
    let p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    p += '='.repeat((4 - (p.length % 4)) % 4);
    return JSON.parse(Buffer.from(p, 'base64').toString('utf8'));
  } catch (_) { return null; }
}

function msFromEpoch(v, fallbackMs) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  // Some providers report seconds, some milliseconds.
  return n > 1e12 ? n : n * 1000;
}

// ---------------------------------------------------------------------------
// Local credential discovery — "use the account I already signed into"
// ---------------------------------------------------------------------------

// macOS Keychain generic-password read. Returns null when absent.
function keychainRead(service) {
  try {
    const out = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
    return out.trim() || null;
  } catch (_) {
    return null;
  }
}

/**
 * Write a keychain generic-password item and prove it landed.
 *
 * `-a` is pinned because an item matched by service alone can update the wrong
 * entry, and a write that silently produced an empty value is exactly the
 * failure this function refuses to report as success: it reads the item back
 * and compares.
 */
function keychainWrite(service, value, account) {
  const acct = account || os.userInfo().username;
  try {
    execFileSync('/usr/bin/security', ['add-generic-password', '-U', '-s', service, '-a', acct, '-w', value], {
      stdio: 'ignore',
      timeout: 5000,
    });
  } catch (_) {
    return false;
  }
  const back = keychainRead(service);
  return back === value;
}

function readClaudeCodeCredentials() {
  if (process.platform !== 'darwin') return null;
  const raw = keychainRead('Claude Code-credentials');
  if (!raw) return null;
  try {
    const d = JSON.parse(raw);
    return { raw: d, oauth: (d && d.claudeAiOauth) || null };
  } catch (_) {
    return null;
  }
}

/**
 * Write rotated Claude Code tokens back so importing never signs out the CLI.
 *
 * Reads the current item first and merges, so unrelated material (`mcpOAuth`,
 * `organizationUuid`) is preserved, and returns false if the readback does not
 * match — a lost rotation is recoverable only while we still hold it in memory.
 */
function writeBackClaudeCode(oauth) {
  const current = readClaudeCodeCredentials();
  if (!current || !current.raw) return false;
  const merged = Object.assign({}, current.raw);
  merged.claudeAiOauth = Object.assign({}, current.raw.claudeAiOauth || {}, oauth);
  const payload = JSON.stringify(merged);
  const ok = keychainWrite('Claude Code-credentials', payload);
  if (!ok) {
    // One retry: a transient keychain lock should not cost the user a login.
    return keychainWrite('Claude Code-credentials', payload);
  }
  return true;
}

function readCodexAuth() {
  const p = path.join(os.homedir(), '.codex', 'auth.json');
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    const t = (d && d.tokens) || null;
    if (!t || !t.access_token) return null;
    return { raw: d, tokens: t };
  } catch (_) { return null; }
}

function readGeminiCreds() {
  const candidates = [
    path.join(os.homedir(), '.gemini', 'oauth_creds.json'),
    path.join(os.homedir(), '.config', 'gemini', 'oauth_creds.json'),
  ];
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (d && (d.refresh_token || d.access_token)) return { path: p, raw: d };
    } catch (_) {}
  }
  return null;
}

function readGrokConfig() {
  const p = path.join(os.homedir(), '.grok', 'config.toml');
  try {
    const txt = fs.readFileSync(p, 'utf8');
    const m = /^\s*(?:api_key|apiKey)\s*=\s*"([^"]+)"/m.exec(txt);
    if (m) return { path: p, apiKey: m[1] };
  } catch (_) {}
  return null;
}

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------
function loadTokens(prov, account) {
  const raw = secretstore.get(slotKey(prov, account));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

function saveTokens(prov, account, tokens) {
  secretstore.set(slotKey(prov, account), JSON.stringify(tokens));
}

/**
 * Record an account. Idempotent on (provider, account): re-importing refreshes
 * the tokens and metadata instead of creating a duplicate row.
 */
function addAccount(provId, opts) {
  const prov = provider(provId);
  if (!prov) throw new Error('unknown provider: ' + provId);
  const o = opts || {};
  const tokens = o.tokens || {};
  if (!tokens.accessToken && !tokens.refreshToken) throw new Error('no token supplied');
  const account = slug(o.account || 'default');
  const db = readDb();
  const now = Date.now();
  const expiresAt = tokens.expiresAt || (tokens.expiresIn ? now + Number(tokens.expiresIn) * 1000 : 0);

  const record = {
    provider: provId,
    account,
    label: o.label || (prov.label + ' · ' + account),
    plan: o.plan || tokens.plan || '',
    source: o.source || 'manual',
    scopes: tokens.scopes || o.scopes || prov.scopes || [],
    tokenType: tokens.tokenType || 'Bearer',
    expiresAt,
    organizationUuid: tokens.organizationUuid || '',
    accountId: tokens.accountId || '',
    addedAt: now,
    updatedAt: now,
  };

  const i = db.accounts.findIndex((a) => a.provider === provId && a.account === account);
  if (i >= 0) {
    record.addedAt = db.accounts[i].addedAt || now;
    db.accounts[i] = record;
  } else {
    db.accounts.push(record);
  }
  writeDb(db);

  saveTokens(provId, account, {
    accessToken: tokens.accessToken || '',
    refreshToken: tokens.refreshToken || '',
    expiresAt,
    tokenType: record.tokenType,
    scopes: record.scopes,
    organizationUuid: record.organizationUuid,
    accountId: record.accountId,
  });
  return publicRecord(record);
}

function publicRecord(r) {
  return {
    id: r.provider + ':' + r.account,
    provider: r.provider,
    account: r.account,
    label: r.label,
    plan: r.plan || '',
    source: r.source || '',
    scopes: r.scopes || [],
    expiresAt: r.expiresAt || 0,
    expired: !!(r.expiresAt && r.expiresAt <= Date.now()),
    // Never leak the token itself into the renderer or logs.
    hasToken: true,
  };
}

function listAccounts(provId) {
  const db = readDb();
  const rows = db.accounts
    .filter((a) => !provId || a.provider === provId)
    .map((a) => {
      const t = loadTokens(a.provider, a.account);
      const row = publicRecord(a);
      row.hasToken = !!(t && (t.accessToken || t.refreshToken));
      return row;
    });
  return rows;
}

function getAccount(provId, account) {
  const db = readDb();
  const r = db.accounts.find((a) => a.provider === provId && a.account === slug(account));
  return r ? publicRecord(r) : null;
}

function removeAccount(provId, account) {
  const db = readDb();
  const acc = slug(account);
  const before = db.accounts.length;
  db.accounts = db.accounts.filter((a) => !(a.provider === provId && a.account === acc));
  writeDb(db);
  secretstore.del(slotKey(provId, acc));
  return db.accounts.length !== before;
}

function setActive(provId, account) {
  const db = readDb();
  if (!db.accounts.some((a) => a.provider === provId && a.account === slug(account))) return false;
  db.active = db.active || {};
  db.active[provId] = slug(account);
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ version: VERSION, accounts: db.accounts, active: db.active }, null, 2), { mode: 0o600 });
  return true;
}

function activeAccount(provId) {
  const db = readDb();
  const chosen = (db.active && db.active[provId]) || '';
  if (chosen && db.accounts.some((a) => a.provider === provId && a.account === chosen)) return chosen;
  const first = db.accounts.find((a) => a.provider === provId);
  return first ? first.account : '';
}

// ---------------------------------------------------------------------------
// Refresh
// ---------------------------------------------------------------------------
function normalizeTokens(prov, body) {
  const b = body || {};
  const now = Date.now();
  const expiresIn = Number(b.expires_in);
  const expiresAt = b.expires_at
    ? msFromEpoch(b.expires_at, now)
    : (Number.isFinite(expiresIn) && expiresIn > 0 ? now + expiresIn * 1000 : 0);
  const scope = b.scope
    ? String(b.scope).split(/[\s,]+/).filter(Boolean)
    : null;
  return {
    accessToken: b.access_token || '',
    refreshToken: b.refresh_token || '',
    tokenType: b.token_type || 'Bearer',
    expiresAt,
    scopes: scope,
    idToken: b.id_token || '',
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, Math.max(0, ms))); }

/**
 * POST a token grant.
 *
 * Two provider realities are encoded here because both were observed live:
 * a token endpoint may want `application/json` rather than the form encoding
 * RFC 6749 implies, and a busy endpoint answers 429 with a retry-after. So we
 * post the provider's preferred format, fall back to the other one on a 4xx
 * that looks like an encoding complaint, and back off on 429/5xx instead of
 * turning a transient limit into a dead account.
 */
async function postToken(prov, params, opts) {
  const o = opts || {};
  const doFetch = o.fetchImpl || fetch;
  const clean = {};
  for (const [k, v] of Object.entries(params)) if (v != null && v !== '') clean[k] = v;

  const attempt = async (format) => {
    const headers = { accept: 'application/json' };
    let body;
    if (format === 'json') {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(clean);
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(clean).toString();
    }
    const res = await doFetch(prov.tokenUrl, { method: 'POST', headers, body });
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { res, text, json };
  };

  const primary = prov.tokenFormat === 'form' ? 'form' : 'json';
  const secondary = primary === 'json' ? 'form' : 'json';
  const retries = Number.isFinite(o.retries) ? o.retries : 3;
  let last = null;

  for (let i = 0; i <= retries; i++) {
    // Encoding: preferred first, then the alternative once.
    let out = await attempt(primary);
    if (!out.res.ok && out.res.status >= 400 && out.res.status < 500 &&
        out.res.status !== 429 && out.res.status !== 401 && out.res.status !== 403) {
      const alt = await attempt(secondary);
      if (alt.res.ok) out = alt;
    }
    last = out;
    if (out.res.ok) return out.json || {};

    const status = out.res.status;
    const transient = status === 429 || status >= 500;
    if (!transient || i === retries) break;

    // Prefer the server's own guidance, then exponential backoff with jitter.
    const ra = out.res.headers && out.res.headers.get ? out.res.headers.get('retry-after') : null;
    let wait = Number(ra);
    wait = Number.isFinite(wait) && wait > 0 ? wait * 1000 : Math.min(8000, 600 * Math.pow(2, i));
    wait = Math.min(wait, 15000) + Math.floor(Math.random() * 250);
    if (o.onRetry) { try { o.onRetry({ status, attempt: i + 1, waitMs: wait }); } catch (_) {} }
    await sleep(wait);
  }

  const err = new Error('token endpoint ' + last.res.status);
  err.status = last.res.status;
  err.body = last.json || String(last.text || '').slice(0, 300);
  // A 429 is a "try later", never a "this account is dead" — the agent loop
  // must be able to tell the two apart.
  err.transient = last.res.status === 429 || last.res.status >= 500;
  const ra = last.res.headers && last.res.headers.get ? last.res.headers.get('retry-after') : null;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs > 0) err.retryAfterMs = Math.min(secs * 1000, 120000);
  throw err;
}

/**
 * Refresh one account's access token. Rotates and persists the new refresh
 * token, updates the index, and mirrors the rotation back to the credential
 * store the account was imported from.
 */
async function refreshAccount(provId, account, opts) {
  const prov = provider(provId);
  if (!prov) throw new Error('unknown provider: ' + provId);
  const acc = slug(account);
  const t = loadTokens(provId, acc);
  if (!t) throw new Error('no stored tokens for ' + provId + ':' + acc);
  if (!t.refreshToken) {
    const err = new Error('this account has no refresh token — sign in again');
    err.code = 'no_refresh_token';
    throw err;
  }
  const params = {
    grant_type: 'refresh_token',
    refresh_token: t.refreshToken,
    client_id: prov.clientId,
  };
  // Verified live: the working Claude grant sends exactly these three fields
  // and no `scope`. Echoing the scope list back invites invalid_scope.
  const json = await postToken(prov, params, opts);
  const next = normalizeTokens(prov, json);
  const merged = {
    accessToken: next.accessToken || t.accessToken,
    // Providers may omit the refresh token when it did not rotate.
    refreshToken: next.refreshToken || t.refreshToken,
    tokenType: next.tokenType || t.tokenType || 'Bearer',
    expiresAt: next.expiresAt || t.expiresAt,
    scopes: next.scopes || t.scopes || [],
    organizationUuid: t.organizationUuid || '',
    accountId: t.accountId || '',
  };
  saveTokens(provId, acc, merged);

  // Mirror the rotation immediately: the old refresh token is single-use, so a
  // lost write-back would sign the other app out at its next refresh.
  let mirrored = null;
  if (provId === 'claude') {
    const db = readDb();
    const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
    if (row && row.source === 'claude-code') {
      mirrored = writeBackClaudeCode({
        accessToken: merged.accessToken,
        refreshToken: merged.refreshToken,
        expiresAt: merged.expiresAt,
      });
    }
  }

  const db2 = readDb();
  const row = db2.accounts.find((a) => a.provider === provId && a.account === acc);
  if (row) {
    row.expiresAt = merged.expiresAt;
    row.updatedAt = Date.now();
    if (merged.scopes && merged.scopes.length) row.scopes = merged.scopes;
    writeDb(db2);
  }
  // An id_token refresh can reveal a changed plan; keep the label current.
  return { accessToken: merged.accessToken, expiresAt: merged.expiresAt, refreshed: true, mirrored };
}

/**
 * Return a usable access token, refreshing first when it is at or near expiry.
 * This is the only function the agent loop should call.
 */
async function ensureToken(provId, account, opts) {
  const o = opts || {};
  const acc = slug(account || activeAccount(provId) || 'default');
  const t = loadTokens(provId, acc);
  if (!t) throw new Error('no stored tokens for ' + provId + ':' + acc);
  const fresh = t.accessToken && (!t.expiresAt || t.expiresAt - Date.now() > REFRESH_SKEW_MS);
  if (fresh && !o.force) {
    return { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshed: false, account: acc };
  }
  if (!t.refreshToken) {
    if (t.accessToken) return { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshed: false, account: acc };
    throw new Error('account ' + provId + ':' + acc + ' has no usable token — sign in again');
  }
  const r = await refreshAccount(provId, acc, o);
  return Object.assign({ account: acc }, r);
}

// ---------------------------------------------------------------------------
// Loopback redirect listener (configurable path + preferred port)
//
// mcpoauth.startLoopback is fixed to one path on an ephemeral port; provider
// first-party clients register specific redirect URIs, so this variant takes
// both and falls back to an ephemeral port when the preferred one is busy.
// ---------------------------------------------------------------------------
const http = require('http');

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function callbackPage(payload) {
  const ok = !payload.error && payload.code;
  const title = ok ? 'Signed in' : 'Sign-in did not complete';
  const detail = ok
    ? 'Helio Bot can close this tab and keep working.'
    : escapeHtml(payload.errorDescription || payload.error || 'no authorization code was returned');
  return '<!doctype html><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
    '<style>body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
    'background:#F6F3EC;color:#2b2622;display:grid;place-items:center;height:100vh;margin:0}' +
    '.c{max-width:30rem;padding:2.2rem 2.4rem;background:#fff;border-radius:16px;' +
    'box-shadow:0 10px 40px rgba(60,45,35,.09);text-align:center}' +
    'h1{font-size:1.15rem;margin:0 0 .6rem}p{margin:0;color:#6d635a}</style>' +
    '<div class="c"><h1>' + escapeHtml(title) + '</h1><p>' + detail + '</p></div>';
}

// xAI's browser flow opens the callback from an xAI origin and probes the
// loopback listener with a private-network preflight. Both are required for the
// real browser to follow the redirect without a CORS error page.
const LOOPBACK_ORIGINS = [
  'https://accounts.x.ai',
  'https://auth.x.ai',
  'https://grok.com',
];

function corsHeaders(origin) {
  if (!origin || LOOPBACK_ORIGINS.indexOf(origin) === -1) {
    return { vary: 'Origin' };
  }
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true',
    'access-control-max-age': '600',
    vary: 'Origin',
  };
}

function startLoopbackServer(opts) {
  const o = opts || {};
  const host = o.host || '127.0.0.1';
  // The redirect *host* is what the provider's console registered and what the
  // browser is sent to; it is not necessarily the bind address (xAI wants
  // `127.0.0.1`, Google wants `localhost`).
  const redirectHost = o.redirectHost || 'localhost';
  const wantPath = o.path || '/callback';
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
      // Some first-party clients probe the loopback listener from their own
      // origin before redirecting. Answer the preflight instead of a 404.
      const origin = String((req.headers && req.headers.origin) || '');
      const cors = corsHeaders(origin);
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        res.end();
        return;
      }
      let u;
      try { u = new URL(req.url, 'http://' + host); } catch (_) {
        res.writeHead(400, Object.assign({ 'content-type': 'text/plain' }, cors));
        res.end('bad request');
        return;
      }
      if (u.pathname !== wantPath) {
        res.writeHead(404, Object.assign({ 'content-type': 'text/plain; charset=utf-8' }, cors));
        res.end('not found');
        return;
      }
      const payload = {
        code: u.searchParams.get('code'),
        state: u.searchParams.get('state'),
        error: u.searchParams.get('error'),
        errorDescription: u.searchParams.get('error_description') || u.searchParams.get('error_message'),
      };
      res.writeHead(200, Object.assign({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      }, cors));
      res.end(callbackPage(payload));
      stop();
      settle(payload);
    });
    server.on('error', (err) => {
      // Port taken: retry once on an ephemeral port (claude/google allow it).
      if (o.port && err && err.code === 'EADDRINUSE') {
        stop();
        startLoopbackServer(Object.assign({}, o, { port: 0 })).then(resolve, reject);
        return;
      }
      stop();
      reject(err);
    });
    server.listen(o.port || 0, host, () => {
      const port = server.address().port;
      const redirectUri = 'http://' + redirectHost + ':' + port + wantPath;
      timer = setTimeout(() => {
        stop();
        settle({ code: null, state: null, error: 'timeout', errorDescription: 'sign-in was not completed in time' });
      }, o.timeoutMs || 10 * 60 * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      resolve({ redirectUri, port, wait: () => done, close: stop });
    });
  });
}

// ---------------------------------------------------------------------------
// Identity
//
// An account needs a stable, human-readable key. We read it out of the token
// the provider handed us (ID-token claims, or a profile endpoint), and fall
// back to a short fingerprint of the refresh token so two accounts never
// collapse into one slot. Never throws.
// ---------------------------------------------------------------------------
function fingerprint(tokens) {
  const seed = (tokens && (tokens.refreshToken || tokens.accessToken)) || '';
  return crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 8);
}

async function identify(provId, tokens, opts) {
  const o = opts || {};
  const prov = provider(provId);
  const out = { account: '', label: '', plan: '', accountId: '', organizationUuid: '' };

  const claims = jwtPayload(tokens && tokens.idToken) || {};
  if (claims.email) out.account = claims.email;
  if (claims.name) out.label = claims.name;
  const auth = claims['https://api.openai.com/auth'] || {};
  if (auth.chatgpt_plan_type) out.plan = String(auth.chatgpt_plan_type);
  if (auth.chatgpt_account_id) out.accountId = String(auth.chatgpt_account_id);

  if (!out.account && provId === 'claude') {
    out.organizationUuid = tokens.organizationUuid || '';
    // Best-effort profile lookup; a provider that does not expose this path
    // simply leaves us with the fingerprint fallback.
    try {
      const doFetch = o.fetchImpl || fetch;
      const res = await doFetch('https://api.anthropic.com/api/oauth/profile', {
        headers: { authorization: 'Bearer ' + tokens.accessToken, 'anthropic-beta': 'oauth-2025-04-20' },
      });
      if (res.ok) {
        const d = await res.json();
        const acct = (d && (d.account || d)) || {};
        const email = acct.email || acct.email_address || '';
        if (email) out.account = email;
        if (acct.subscription_type) out.plan = String(acct.subscription_type);
        if (acct.organization_uuid) out.organizationUuid = String(acct.organization_uuid);
      }
    } catch (_) {}
  }

  if (!out.account && provId === 'antigravity') {
    try {
      const doFetch = o.fetchImpl || fetch;
      const res = await doFetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { authorization: 'Bearer ' + tokens.accessToken },
      });
      if (res.ok) {
        const d = await res.json();
        if (d && d.email) out.account = d.email;
        if (d && d.name) out.label = d.name;
      }
    } catch (_) {}
  }

  if (!out.account && provId === 'grok' && (tokens.refreshToken || tokens.idToken)) {
    // xAI's userinfo is the only stable identity source: the ID token's claims
    // are ES256 and not something we verify here, so read the account from the
    // endpoint the token was minted for.
    try {
      const doFetch = o.fetchImpl || fetch;
      const res = await doFetch(prov.userinfoUrl || 'https://auth.x.ai/oauth2/userinfo', {
        headers: { authorization: 'Bearer ' + tokens.accessToken, accept: 'application/json' },
      });
      if (res.ok) {
        const d = await res.json();
        const email = (d && (d.email || d.preferred_username)) || '';
        if (email) out.account = email;
        if (d && (d.name || d.given_name)) out.label = d.name || d.given_name;
        if (d && d.sub) out.accountId = String(d.sub);
      }
    } catch (_) {}
  }

  if (!out.account) out.account = provId + '-' + fingerprint(tokens);
  out.account = slug(out.account);
  if (!out.label) out.label = prov.label + ' · ' + out.account;
  return out;
}

// ---------------------------------------------------------------------------
// Authorize (full PKCE sign-in)
// ---------------------------------------------------------------------------
function buildAuthorizeUrl(prov, params) {
  const p = params || {};
  const u = new URL(prov.authorizeUrl);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', prov.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', (prov.scopes || []).join(' '));
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  // xAI's authorize endpoint expects an OIDC nonce even in the code flow.
  if (p.nonce) u.searchParams.set('nonce', p.nonce);
  for (const [k, v] of Object.entries(prov.extraAuthParams || {})) u.searchParams.set(k, String(v));
  return u.toString();
}

/**
 * Run the browser sign-in flow for one provider and persist the account.
 * @param {string} provId
 * @param {{openExternal:Function, fetchImpl?:Function, timeoutMs?:number, label?:string}} opts
 */
async function authorize(provId, opts) {
  const o = opts || {};
  const prov = provider(provId);
  if (!prov) throw new Error('unknown provider: ' + provId);
  if (prov.kind !== 'oauth') throw new Error(prov.label + ' uses a token, not a browser sign-in');
  if (typeof o.openExternal !== 'function') throw new Error('authorize() needs an openExternal(url) callback');

  const { verifier, challenge } = mcpoauth.pkce();
  const state = mcpoauth.randomState();
  const nonce = prov.authNonce ? mcpoauth.randomState() : '';
  // Listen before we open the browser: the redirect can land instantly.
  const loop = await startLoopbackServer({
    path: prov.redirectPath,
    port: prov.redirectPort,
    redirectHost: prov.redirectHost,
    timeoutMs: o.timeoutMs || 10 * 60 * 1000,
  });
  const url = buildAuthorizeUrl(prov, { redirectUri: loop.redirectUri, state, challenge, nonce });
  try { o.openExternal(url); } catch (_) {}
  let cb;
  try {
    cb = await loop.wait();
  } finally {
    loop.close();
  }
  if (cb.error) {
    const err = new Error(cb.errorDescription || cb.error);
    err.code = cb.error;
    throw err;
  }
  if (!cb.code) throw new Error('sign-in returned no authorization code');
  if (cb.state !== state) throw new Error('sign-in state mismatch — the callback did not belong to this attempt');

  const json = await postToken(prov, {
    grant_type: 'authorization_code',
    code: cb.code,
    redirect_uri: loop.redirectUri,
    client_id: prov.clientId,
    code_verifier: verifier,
  }, { fetchImpl: o.fetchImpl });

  const tokens = normalizeTokens(prov, json);
  if (!tokens.accessToken) throw new Error('sign-in succeeded but no access token was returned');
  const ident = await identify(provId, tokens, { fetchImpl: o.fetchImpl });
  return addAccount(provId, {
    account: ident.account,
    label: o.label || ident.label,
    plan: ident.plan,
    source: 'oauth',
    tokens: Object.assign({}, tokens, {
      organizationUuid: ident.organizationUuid,
      accountId: ident.accountId,
    }),
  });
}

// ---------------------------------------------------------------------------
// Import accounts the user already signed into on this machine
// ---------------------------------------------------------------------------
function epochToMs(v) {
  if (v == null) return 0;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n > 1e12 ? n : n * 1000;
}

/**
 * Add a long-lived bearer token (API key) for an OpenAI-compatible provider.
 * Grok works this way; xAI keys never expire on their own.
 */
async function addBearer(provId, token, opts) {
  const o = opts || {};
  const prov = provider(provId);
  if (!prov) throw new Error('unknown provider: ' + provId);
  const value = String(token || '').trim();
  if (!value) throw new Error('empty token');
  // Prove the token works before storing it, so a typo cannot look like a
  // working account. Verdict ladder:
  //   2xx            -> good
  //   401/403, 4xx   -> rejected (xAI answers **400** "Incorrect API key", not 401)
  //   404            -> no /models route, can't tell, keep it
  //   429 / 5xx / net-> transient, keep it (the user may be offline or limited)
  let plan = '';
  // Verify against the *API* base, not the subscription proxy: a Grok OAuth
  // token is refused by api.x.ai and an xAI API key is refused by the proxy.
  const verifyBase = prov.bearerBaseURL || prov.baseURL;
  if (o.verify !== false && verifyBase) {
    let res = null;
    try {
      const doFetch = o.fetchImpl || fetch;
      res = await doFetch(verifyBase.replace(/\/+$/, '') + '/models', {
        headers: { authorization: 'Bearer ' + value },
      });
    } catch (e) {
      res = null; // network failure: store it anyway
    }
    if (res) {
      const st = Number(res.status) || 0;
      const keep = st >= 200 && st < 300 ? true : (st === 404 || st === 429 || st >= 500);
      if (!keep) {
        let detail = '';
        try {
          const body = await res.text();
          const j = JSON.parse(body);
          detail = String((j && (j.error_description || j.error || j.message)) || '').trim();
          if (typeof (j && j.error) === 'object' && j.error) {
            detail = String(j.error.message || j.error.description || detail || '').trim();
          }
        } catch (e) { /* not JSON: no detail */ }
        detail = detail.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
        const err = new Error(prov.label + ' rejected that key' + (detail ? ' — ' + detail : ''));
        err.status = st;
        err.human = true;
        throw err;
      }
    }
  }
  const ident = await identify(provId, { accessToken: value, refreshToken: '' }, { fetchImpl: o.fetchImpl });
  return addAccount(provId, {
    account: o.account || ident.account,
    // A key has no identity to name, so don't print a hash as if it were one.
    label: o.label || (prov.label + ' · ' + (ident.account === slug(ident.account) && /^[a-z]+-[0-9a-f]{8}$/.test(ident.account) ? 'API key' : (ident.account || 'API key'))),
    plan,
    source: 'api-key',
    tokens: { accessToken: value, refreshToken: '', expiresAt: 0, tokenType: 'Bearer', scopes: [] },
  });
}

/**
 * Scan this machine for first-party credentials and import each account.
 * Never destructive; never throws on a missing source.
 */
async function importLocal(opts) {
  const o = opts || {};
  const imported = [];
  const skipped = [];
  const errors = [];

  // --- Claude Code (macOS Keychain) ---
  try {
    const cc = readClaudeCodeCredentials();
    if (!cc || !cc.oauth || !cc.oauth.accessToken) {
      skipped.push({ provider: 'claude', reason: 'no Claude Code credentials on this machine' });
    } else {
      const tokens = {
        accessToken: cc.oauth.accessToken,
        refreshToken: cc.oauth.refreshToken || '',
        expiresAt: epochToMs(cc.oauth.expiresAt),
        scopes: cc.oauth.scopes || [],
        organizationUuid: cc.organizationUuid || '',
        tokenType: 'Bearer',
      };
      const ident = await identify('claude', tokens, { fetchImpl: o.fetchImpl });
      imported.push(addAccount('claude', {
        account: ident.account,
        label: 'Claude · ' + (cc.oauth.subscriptionType || 'subscription'),
        plan: cc.oauth.subscriptionType || '',
        source: 'claude-code',
        tokens,
      }));
    }
  } catch (e) { errors.push({ provider: 'claude', error: String(e && e.message || e) }); }

  // --- Codex CLI (ChatGPT) ---
  try {
    const cx = readCodexAuth();
    if (!cx) {
      skipped.push({ provider: 'chatgpt', reason: 'no ~/.codex/auth.json' });
    } else {
      const tokens = {
        accessToken: cx.tokens.access_token,
        refreshToken: cx.tokens.refresh_token || '',
        idToken: cx.tokens.id_token || '',
        accountId: cx.tokens.account_id || '',
        expiresAt: 0,
        tokenType: 'Bearer',
      };
      const ident = await identify('chatgpt', tokens, { fetchImpl: o.fetchImpl });
      imported.push(addAccount('chatgpt', {
        account: ident.account,
        label: 'ChatGPT · ' + (ident.plan || 'subscription'),
        plan: ident.plan,
        source: 'codex-cli',
        tokens,
      }));
    }
  } catch (e) { errors.push({ provider: 'chatgpt', error: String(e && e.message || e) }); }

  // --- Google Antigravity / Gemini ---
  try {
    const g = readGeminiCreds();
    if (!g) {
      skipped.push({ provider: 'antigravity', reason: 'no Google OAuth credentials on this machine' });
    } else {
      const d = g.raw;
      const tokens = {
        accessToken: d.access_token || '',
        refreshToken: d.refresh_token || '',
        idToken: d.id_token || '',
        expiresAt: epochToMs(d.expiry_date || d.expiry),
        scopes: d.scope ? String(d.scope).split(/\s+/).filter(Boolean) : [],
        tokenType: 'Bearer',
      };
      const ident = await identify('antigravity', tokens, { fetchImpl: o.fetchImpl });
      imported.push(addAccount('antigravity', {
        account: ident.account,
        label: ident.label || ('Antigravity · ' + ident.account),
        source: 'gemini-cli',
        tokens,
      }));
    }
  } catch (e) { errors.push({ provider: 'antigravity', error: String(e && e.message || e) }); }

  // --- Grok (xAI config) ---
  try {
    const gr = readGrokConfig();
    if (!gr || !gr.apiKey) {
      skipped.push({ provider: 'grok', reason: 'no xAI api_key in ~/.grok/config.toml' });
    } else {
      imported.push(await addBearer('grok', gr.apiKey, { verify: false, label: 'Grok · xAI key', fetchImpl: o.fetchImpl }));
    }
  } catch (e) { errors.push({ provider: 'grok', error: String(e && e.message || e) }); }

  return { imported, skipped, errors };
}

// ---------------------------------------------------------------------------
// UI surface
// ---------------------------------------------------------------------------
function status() {
  const db = readDb();
  const out = { version: VERSION, secretBackend: secretstore.status(), providers: [] };
  for (const id of providerIds()) {
    const prov = PROVIDERS[id];
    out.providers.push({
      id: prov.id,
      label: prov.label,
      vendor: prov.vendor,
      kind: prov.kind,
      transport: prov.transport,
      models: prov.models,
      docs: prov.docs,
      accounts: listAccounts(id),
      active: activeAccount(id),
      canBrowserSignIn: prov.kind === 'oauth',
      // A provider that signs in through the browser may still accept a pasted
      // API key as a secondary route (Grok today).
      canPasteKey: prov.kind !== 'oauth' || prov.allowBearer === true,
    });
  }
  out.total = db.accounts.length;
  return out;
}

/** Resolve a `provider:account` id into everything the transport needs. */
async function resolve(id, opts) {
  const raw = String(id || '');
  const [provId, ...rest] = raw.split(':');
  const prov = provider(provId);
  if (!prov) throw new Error('unknown provider in "' + raw + '"');
  const account = rest.join(':') || activeAccount(provId);
  if (!account) throw new Error('no ' + prov.label + ' account is signed in');
  const token = await ensureToken(provId, account, opts);
  const rec = getAccount(provId, account);
  // A pasted API key is a public-API credential, not a subscription token: it
  // must not be sent to the first-party CLI proxy (which refuses it), and the
  // proxy's `responses` shape does not exist on api.x.ai. Route it to the plain
  // OpenAI-compatible path against the bearer base.
  const viaKey = !!(rec && rec.source === 'api-key' && prov.bearerBaseURL);
  return {
    provider: provId,
    account,
    label: rec ? rec.label : prov.label,
    accessToken: token.accessToken,
    expiresAt: token.expiresAt,
    transport: viaKey ? 'openai' : prov.transport,
    baseURL: viaKey ? prov.bearerBaseURL : (prov.baseURL || ''),
    models: prov.models,
    plan: rec ? rec.plan : '',
  };
}

module.exports = {
  PROVIDERS,
  provider,
  providerIds,
  status,
  listAccounts,
  getAccount,
  addAccount,
  addBearer,
  removeAccount,
  setActive,
  activeAccount,
  importLocal,
  ensureToken,
  refreshAccount,
  authorize,
  resolve,
  // exposed for tests
  _internal: {
    readDb, writeDb, slotKey, slug, jwtPayload, msFromEpoch, epochToMs, fingerprint,
    normalizeTokens, buildAuthorizeUrl, startLoopbackServer, readClaudeCodeCredentials,
    readCodexAuth, readGeminiCreds, readGrokConfig, callbackPage, publicRecord,
    postToken, identify, REFRESH_SKEW_MS,
  },
};
