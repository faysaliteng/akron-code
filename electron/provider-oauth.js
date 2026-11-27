'use strict';
/**
 * Provider OAuth — sign in to the *actual AI subscriptions* you already pay for
 * and use them as models inside Akron Code.
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

// `AUTOBOT_HOME` relocates every file this module owns (index, rotation
// journal, CLAUDE_LOCK). The test suite points it at a scratch directory so a
// quarantine test can corrupt its index without ever touching the real one —
// the live store must never be writable from a test.
const DIR = process.env.AUTOBOT_HOME
  ? path.resolve(process.env.AUTOBOT_HOME)
  : path.join(os.homedir(), '.autobot');
const FILE = path.join(DIR, 'provider-oauth.json');
const VERSION = 1;
const KEY_PREFIX = 'provider-oauth:';
// Refresh 10 minutes before the token expires so long idle sessions or
// multi-step turns never race a near-expiry token.
const REFRESH_SKEW_MS = 10 * 60 * 1000;

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
    // These four constants are extracted from the bundled Claude Code CLI
    // (vendor/runtimes/claude-code, 2.1.332) and are the only ones that work.
    // The previous pair — claude.ai/oauth/authorize +
    // api.anthropic.com/v1/oauth/token — is a pre-2.x flow: claude.ai now
    // answers the authorize URL with a login-wall redirect (`/login?...&
    // returnTo=...`) and ERR_FAILED inside Electron, and api.anthropic.com does
    // not mint subscription tokens.
    authorizeUrl: 'https://platform.claude.com/oauth/authorize',
    tokenUrl: 'https://platform.claude.com/v1/oauth/token',
    // The page the CLI shows when its loopback listener cannot be reached and
    // the user has to copy the code out by hand.
    manualRedirectUrl: 'https://platform.claude.com/oauth/code/callback',
    // Verified live: this endpoint takes an application/json body, not the
    // form-encoding the OAuth RFC suggests. Posting a form body gets 400.
    tokenFormat: 'json',
    // The CLI always appends `code=true`; without it the authorize page treats
    // the request as a plain web app rather than the CLI/device grant.
    extraAuthParams: { code: 'true' },
    // The CLI echoes the anti-CSRF state in the token request body too.
    echoState: true,
    // Public first-party client id of the Claude Code CLI. Not a secret: it is
    // shipped inside every copy of the CLI and is the documented PKCE client.
    clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    // The exact scope set the CLI requests for a Claude account (`j5s()` in
    // 2.1.332): base scopes + plugins + privacy consents.
    scopes: [
      'org:create_api_key',
      'user:profile',
      'user:inference',
      'user:sessions:claude_code',
      'user:mcp_servers',
      'user:file_upload',
      'user:plugins',
      'user:privacy_consents:write',
    ],
    // The CLI binds an ephemeral loopback port and passes it in redirect_uri.
    // The old fixed 54545 appears nowhere in the shipped binary.
    redirectPort: 0,
    redirectHost: 'localhost',
    redirectPath: '/callback',
    // Fallback only: `autobot:providerModels` replaces this with the account's
    // own `/v1/models` list (15 entries on the verification machine). These are
    // the ids that list returned, newest first, so an offline picker still
    // offers current models instead of the retired 4.5 trio.
    models: [
      { id: 'claude-fable-5-2', label: 'Fable 5.2' },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
      { id: 'claude-opus-5-5', label: 'Opus 5.5' },
      { id: 'claude-fable-5-1', label: 'Fable 5.1' },
      { id: 'claude-opus-5', label: 'Opus 5' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5' },
      { id: 'claude-fable-5', label: 'Fable 5' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8' },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
      { id: 'claude-opus-4-6', label: 'Opus 4.6' },
      { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5' },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5' },
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
    // Strings extracted from the shipped Codex CLI binary: the exchange is
    // `application/x-www-form-urlencoded`, not JSON. A JSON body is what the
    // previous config got wrong and why sign-in never completed.
    tokenFormat: 'form',
    // Public first-party client id of the Codex CLI.
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'api.connectors.read', 'api.connectors.invoke'],
    redirectPort: 1455,
    // OpenAI registered exactly `http://localhost:1455/auth/callback` for this
    // client id. Live-measured 2026-11-26: the authorize endpoint answers
    // `400 {"code":"invalid_authorize_request"}` for *any* other port (1456,
    // 3000, 54321) and `302 -> /log-in` for 1455. So the listener must own 1455
    // or the sign-in cannot start — never fall back to an ephemeral port.
    fixedRedirectPort: true,
    redirectHost: 'localhost',
    redirectPath: '/auth/callback',
    // Codex flags the binary passes on the authorize URL. `codex_cli_simplified_flow`
    // is what selects the loopback (non-workspace) consent screen, and
    // `id_token_add_organizations` puts the org claim on the id_token.
    // `originator` is what the shipped CLI 0.135.0 sends; without it the grant
    // is not attributed to the Codex client.
    extraAuthParams: {
      code_challenge_method: 'S256',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
    },
    // Verified against the binary: the CLI revokes here on sign-out.
    revokeUrl: 'https://auth.openai.com/oauth/revoke',
    // The account's live entitlement, read from `/backend-api/codex/models`
    // (verified 2026-11-26). The picked default must come from the live catalog
    // so a shipped list that goes stale cannot offer a model the grant lacks.
    models: [
      { id: 'gpt-reserve', label: 'GPT-Reserve' },
      { id: 'gpt-6-luna', label: 'GPT-6-Luna' },
      { id: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' },
      { id: 'codex-auto-review', label: 'Codex Auto Review' },
    ],
    docs: 'https://platform.openai.com/docs',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Google Antigravity',
    vendor: 'Google',
    kind: 'oauth',
    transport: 'google',
    // Antigravity's own Cloud Code deployment. The generic Gemini-CLI host
    // (`cloudcode-pa.googleapis.com`) answers 403 for this grant.
    cloudcodeUrl: 'https://daily-cloudcode-pa.googleapis.com/v1internal',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    tokenFormat: 'form',
    // Extracted from Antigravity `app.asar` → `dist/remote/signInUrls.js`: this
    // is the *personal-account* client id the app uses for the consumer tier.
    clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
    // Google desktop ("installed app") clients treat the secret as public — it
    // ships inside the app — but the token endpoint still requires it. This is
    // the secret paired with the personal client above; extracted from the
    // Antigravity `language_server` binary and verified live (refresh → 200).
    clientSecret: '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',
    scopes: [
      'openid',
      'https://www.googleapis.com/auth/cloud-platform',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
      'https://www.googleapis.com/auth/cclog',
      'https://www.googleapis.com/auth/experimentsandconfigs',
      // The AICode scope is what routes a consumer account onto the AICode
      // backend. Without it the account is rejected as UNSUPPORTED_CLIENT.
      'https://www.googleapis.com/auth/aicode',
    ],
    // The app accepts any loopback port >= 1024, so take an ephemeral one
    // rather than fighting a fixed port that may be taken.
    redirectPort: 0,
    // `dist/remote/signInCallback.js`: `SIGN_IN_CALLBACK_PATH = '/auth/callback'`
    // (NOT `/oauth2callback`).
    redirectPath: '/auth/callback',
    redirectHost: 'localhost',
    // Google only returns a refresh token with these set. Nothing else: the
    // Antigravity Hub's `classifyOpenUrl` whitelists the exact param set
    // (`SIGN_IN_PARAMS`) and rejects any extra key, and `include_granted_scopes`
    // would silently widen the grant beyond the scopes we asked for.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
    // Static fallback only. The live catalog comes from `:fetchAvailableModels`
    // and carries the real per-model context windows; see googleModels().
    models: [
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', contextWindow: 1048576 },
      { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', contextWindow: 1048576 },
      { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium)', contextWindow: 1000000 },
      { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium)', contextWindow: 1000000 },
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
    extraAuthParams: { plan: 'generic', referrer: 'akron-bot' },
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
let brokenIndex = { stamp: '', path: '' };

/**
 * Read the account index.
 *
 * "There is no file yet" and "the file is there but I cannot read it" are
 * different facts and must not collapse into the same empty list: the UI shows
 * zero accounts for both, but only the first one is true. A transient read (the
 * atomic rename of a concurrent write, a slow disk) is retried; a file that
 * still will not parse is copied aside for inspection and reported as
 * `unreadable` so `writeDb()` refuses to erase it.
 */
function readDb() {
  let raw;
  try {
    raw = fs.readFileSync(FILE, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { version: VERSION, accounts: [], missing: true };
    try { raw = fs.readFileSync(FILE, 'utf8'); } catch (_) {
      console.warn('[provider-oauth] index unreadable:', e && e.message);
      return { version: VERSION, accounts: [], unreadable: true, error: e && e.message };
    }
  }
  let data = null;
  let err = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { data = JSON.parse(raw); err = null; break; } catch (e) {
      err = e;
      // A half-visible file may be replaced by the writer's rename; re-read once.
      try { raw = fs.readFileSync(FILE, 'utf8'); } catch (_) {}
    }
  }
  if (err) {
    // One copy per broken file, not one per read: status() polls this often and
    // would otherwise litter the directory with identical snapshots.
    let stamp = '';
    try { const st = fs.statSync(FILE); stamp = st.size + ':' + st.mtimeMs; } catch (_) {}
    let quarantine = '';
    if (brokenIndex.stamp === stamp && brokenIndex.path) quarantine = brokenIndex.path;
    else {
      quarantine = FILE + '.corrupt-' + Date.now();
      try { fs.copyFileSync(FILE, quarantine); } catch (_) { quarantine = ''; }
      brokenIndex = { stamp, path: quarantine };
      console.warn('[provider-oauth] index parse failed (' + err.message + ')');
    }
    return { version: VERSION, accounts: [], unreadable: true, error: err.message, quarantine };
  }
  if (!data || typeof data !== 'object') return { version: VERSION, accounts: [] };
  return { version: data.version || VERSION, accounts: Array.isArray(data.accounts) ? data.accounts : [] };
}

function writeDb(db) {
  // Refuse to overwrite an index that cannot be parsed. Writing here is how a
  // single bad read silently unlinks every account: the empty list returned
  // above gets persisted and the original rows are gone for good.
  try {
    const cur = fs.readFileSync(FILE, 'utf8');
    if (cur.trim()) {
      try { JSON.parse(cur); } catch (e) {
        const quarantine = FILE + '.corrupt-' + Date.now();
        try { fs.writeFileSync(quarantine, cur, { mode: 0o600 }); } catch (_) {}
        throw new Error('refusing to overwrite unreadable provider index (copy at ' + quarantine + '): ' + e.message);
      }
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
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

function configRoots() {
  const home = os.homedir();
  const appData = process.env.APPDATA || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return { home, appData, localAppData, xdgConfig };
}

function mirrorDir() {
  return path.join(DIR, 'oauth-mirror');
}

function mirrorFile(prov, account) {
  return path.join(mirrorDir(), `${slug(prov)}__${slug(account)}.json`);
}

function writeTokenMirror(prov, account, tokens) {
  if (!tokens || (!tokens.accessToken && !tokens.refreshToken)) return;
  try {
    fs.mkdirSync(mirrorDir(), { recursive: true });
    const file = mirrorFile(prov, account);
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ provider: prov, account: slug(account), tokens, updatedAt: Date.now() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch (_) {}
  } catch (_) {}
}

function readTokenMirror(prov, account) {
  try {
    if (account) {
      const p = mirrorFile(prov, account);
      if (fs.existsSync(p)) {
        const d = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (d && d.tokens && (d.tokens.accessToken || d.tokens.refreshToken)) return d.tokens;
      }
    }
    const dir = mirrorDir();
    if (!fs.existsSync(dir)) return null;
    const prefix = slug(prov) + '__';
    const files = fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json'));
    if (files.length === 1) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
      if (d && d.tokens && (d.tokens.accessToken || d.tokens.refreshToken)) return d.tokens;
    }
  } catch (_) {}
  return null;
}

function readClaudeCodeCredentials() {
  if (process.platform === 'darwin') {
    const raw = keychainRead('Claude Code-credentials');
    if (raw) {
      try {
        const d = JSON.parse(raw);
        if (d && d.claudeAiOauth) return { raw: d, oauth: d.claudeAiOauth };
      } catch (_) {}
    }
  }
  // Cross-platform Claude Code credentials files (Windows, Linux, macOS fallback)
  const { home, appData, localAppData, xdgConfig } = configRoots();
  const candidates = [
    process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json') : '',
    path.join(home, '.claude', '.credentials.json'),
    path.join(home, '.claude', 'credentials.json'),
    path.join(xdgConfig, 'claude', '.credentials.json'),
    appData ? path.join(appData, 'Claude', '.credentials.json') : '',
    localAppData ? path.join(localAppData, 'Claude', '.credentials.json') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const oauth = (d && (d.claudeAiOauth || (d.accessToken ? d : null))) || null;
      if (oauth && (oauth.accessToken || oauth.refreshToken)) return { path: p, raw: d, oauth };
    } catch (_) {}
  }
  return null;
}

/**
 * Write rotated Claude Code tokens back so importing never signs out the CLI.
 *
 * Reads the current item first and merges, so unrelated material (`mcpOAuth`,
 * `organizationUuid`) is preserved, and returns false if the readback does not
 * match — a lost rotation is recoverable only while we still hold it in memory.
 *
 * `expect` is the refresh token the keychain held when the rotation was
 * requested. If the item now holds a different one, another writer (the CLI)
 * rotated in the meantime and writing ours would burn the live credential, so
 * the write is refused and the caller adopts the keychain pair instead.
 */
function writeBackClaudeCode(oauth, expect) {
  const current = readClaudeCodeCredentials();
  if (!current || !current.raw) return false;
  const cur = current.raw.claudeAiOauth || {};
  if (expect && cur.refreshToken && cur.refreshToken !== expect) return false;
  const merged = Object.assign({}, current.raw);
  merged.claudeAiOauth = Object.assign({}, cur, oauth);
  const payload = JSON.stringify(merged);
  const ok = keychainWrite('Claude Code-credentials', payload);
  if (!ok) {
    // One retry: a transient keychain lock should not cost the user a login.
    return keychainWrite('Claude Code-credentials', payload);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Claude Code owns the Claude credential
//
// The refresh token is single-use. Whoever rotates it invalidates it for
// everyone else, so a second app that refreshes on its own is a footgun: one
// lost or late write-back signs the user out of Claude Code itself. Observed on
// this machine 2026-11-25 — the keychain held a 30-minute token whose rotation
// never made it back, and `claude -p` has answered 401 ever since.
//
// The rules below are the fix, not politeness:
//   1. Adopt before rotating. If the CLI refreshed since we imported, take its
//      pair and send no token request at all.
//   2. Journal before writing back. The instant a rotation exists it is on disk,
//      so a crash between "we own the new token" and "the keychain has it" is
//      replayable instead of fatal.
//   3. Write back before trusting. A CLI-owned rotation is committed locally
//      only after the keychain readback proves it landed.
//   4. One refresher at a time. A lock file serialises our own callers.
// ---------------------------------------------------------------------------
const ROTATION_JOURNAL = path.join(DIR, 'claude-rotation.json');
const CLAUDE_LOCK = path.join(DIR, 'claude-cred.lock');
const CLAUDE_LOCK_STALE_MS = 120 * 1000;

/** The pair the owner (Claude Code CLI) currently holds, or null. */
function keychainPair() {
  const c = readClaudeCodeCredentials();
  const o = (c && c.oauth) || null;
  if (!o || !o.refreshToken) return null;
  return {
    accessToken: o.accessToken || '',
    refreshToken: o.refreshToken,
    expiresAt: msFromEpoch(o.expiresAt, 0),
  };
}

function readRotationJournal() {
  try {
    const j = JSON.parse(fs.readFileSync(ROTATION_JOURNAL, 'utf8'));
    return j && j.refreshToken ? j : null;
  } catch (_) { return null; }
}

function writeRotationJournal(j) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = ROTATION_JOURNAL + '.' + process.pid + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, JSON.stringify(j));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, ROTATION_JOURNAL);
    return true;
  } catch (_) { return false; }
}

function clearRotationJournal() {
  try { fs.unlinkSync(ROTATION_JOURNAL); } catch (_) {}
}

/**
 * Finish a rotation whose keychain write-back was interrupted.
 *
 * Runs at boot and before the next Claude refresh. It only acts when the
 * keychain still holds the token the rotation replaced, or holds a strictly
 * older grant — never when the CLI has written something newer, because that
 * token is the live one.
 */
function replayRotationJournal() {
  const j = readRotationJournal();
  if (!j) return false;
  const k = keychainPair();
  if (k && k.refreshToken === j.refreshToken) { clearRotationJournal(); return true; }
  const stale = !k || k.refreshToken === j.previousRefreshToken || (k.expiresAt || 0) <= (j.expiresAt || 0);
  if (!stale) { clearRotationJournal(); return false; }
  const ok = writeBackClaudeCode(
    { accessToken: j.accessToken, refreshToken: j.refreshToken, expiresAt: j.expiresAt },
    j.previousRefreshToken,
  );
  if (ok) clearRotationJournal();
  return !!ok;
}

/**
 * Serialise our own refreshers. A held lock belongs to a refresh that is already
 * running, and waiting is strictly better than starting a second rotation with
 * the same single-use token. Waits are bounded: a stuck lockfile must never
 * stall a turn.
 */
async function withClaudeLock(fn) {
  const deadline = Date.now() + 5000;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(CLAUDE_LOCK, 'wx', 0o600);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') break;
      let st = null;
      try { st = fs.statSync(CLAUDE_LOCK); } catch (_) {}
      if (st && Date.now() - st.mtimeMs > CLAUDE_LOCK_STALE_MS) {
        try { fs.unlinkSync(CLAUDE_LOCK); } catch (_) {}
        continue;
      }
      if (Date.now() > deadline) break;
      await sleep(150);
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(CLAUDE_LOCK); } catch (_) {}
  }
}

/**
 * Take the owner's credential when it is newer than ours.
 *
 * This is the case that makes the two apps coexist: the CLI rotates on its own
 * schedule, and the moment it does, our stored pair is stale. Refreshing with a
 * stale pair would rotate again for no reason and burn a token nobody needed.
 */
function adoptKeychainIfNewer(provId, acc, t) {
  const k = keychainPair();
  if (!k) return null;
  if (t && k.refreshToken === t.refreshToken) return null;
  const merged = {
    accessToken: k.accessToken || (t && t.accessToken) || '',
    refreshToken: k.refreshToken,
    tokenType: (t && t.tokenType) || 'Bearer',
    expiresAt: k.expiresAt || (t && t.expiresAt) || 0,
    scopes: (t && t.scopes) || [],
    organizationUuid: (t && t.organizationUuid) || '',
    accountId: (t && t.accountId) || '',
  };
  saveTokens(provId, acc, merged);
  const db = readDb();
  const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
  if (row) {
    row.expiresAt = merged.expiresAt;
    row.updatedAt = Date.now();
    delete row.needsSignIn;
    writeDb(db);
  }
  return merged;
}

/**
 * Refresh a Claude account without ever signing out the owner.
 *
 * `invalid_grant` is recorded on the row as `needsSignIn` so the UI can stop
 * pretending the account is merely throttled. Before this existed the missing
 * User-Agent turned that permanent answer into a 429 and the app retried a dead
 * credential forever.
 */
async function refreshClaudeAccount(provId, acc, t, opts) {
  const prov = provider(provId);
  const db0 = readDb();
  const row0 = db0.accounts.find((a) => a.provider === provId && a.account === acc);
  const cliOwned = !!(row0 && row0.source === 'claude-code');

  // A rotation that never reached the keychain is still ours to finish.
  replayRotationJournal();

  return withClaudeLock(async () => {
    // 1. Take the owner's pair if it moved on without us: no network, no risk.
    const adopted = adoptKeychainIfNewer(provId, acc, t);
    if (adopted && adopted.accessToken &&
        (!adopted.expiresAt || adopted.expiresAt - Date.now() > REFRESH_SKEW_MS)) {
      return {
        accessToken: adopted.accessToken,
        expiresAt: adopted.expiresAt,
        refreshed: false,
        adopted: true,
        mirrored: true,
      };
    }
    const base = adopted || t;

    let json;
    try {
      json = await postToken(prov, {
        grant_type: 'refresh_token',
        refresh_token: base.refreshToken,
        client_id: prov.clientId,
        client_secret: prov.clientSecret,
      }, opts);
    } catch (e) {
      if (e && e.status === 400 && /invalid_grant/i.test(String(e.message || ''))) {
        const db = readDb();
        const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
        if (row) { row.needsSignIn = Date.now(); writeDb(db); }
        e.code = 'invalid_grant';
        e.needsSignIn = true;
        e.human = true;
        if (cliOwned && !/claude code/i.test(String(e.message || ''))) {
          e.message = 'Claude Code session expired — reconnect Claude in Accounts';
        }
      }
      throw e;
    }

    const next = normalizeTokens(prov, json);
    const merged = {
      accessToken: next.accessToken || base.accessToken,
      refreshToken: next.refreshToken || base.refreshToken,
      tokenType: next.tokenType || base.tokenType || 'Bearer',
      expiresAt: next.expiresAt || base.expiresAt,
      scopes: next.scopes || base.scopes || [],
      organizationUuid: base.organizationUuid || '',
      accountId: base.accountId || '',
    };

    // 2. Journal the rotation in the same tick it exists, but only for a
    // credential the CLI owns: replaying our own OAuth token into the CLI's
    // keychain would be exactly the interference this section prevents.
    if (cliOwned) {
      writeRotationJournal({
        provider: provId,
        account: acc,
        accessToken: merged.accessToken,
        refreshToken: merged.refreshToken,
        expiresAt: merged.expiresAt,
        previousRefreshToken: base.refreshToken,
        at: Date.now(),
      });
    }

    // 3. The keychain has to hold it before we consider the rotation safe.
    let mirrored = null;
    if (cliOwned) {
      mirrored = writeBackClaudeCode({
        accessToken: merged.accessToken,
        refreshToken: merged.refreshToken,
        expiresAt: merged.expiresAt,
      }, base.refreshToken);
      // The CLI rotated concurrently: its pair is the live one, keep ours in
      // the journal for nothing and adopt instead.
      if (!mirrored) {
        const k = keychainPair();
        if (k && k.refreshToken && k.refreshToken !== base.refreshToken) {
          clearRotationJournal();
          saveTokens(provId, acc, Object.assign({}, merged, {
            accessToken: k.accessToken || merged.accessToken,
            refreshToken: k.refreshToken,
            expiresAt: k.expiresAt || merged.expiresAt,
          }));
          const db = readDb();
          const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
          if (row) { row.expiresAt = k.expiresAt || merged.expiresAt; row.updatedAt = Date.now(); delete row.needsSignIn; writeDb(db); }
          return {
            accessToken: k.accessToken || merged.accessToken,
            expiresAt: k.expiresAt || merged.expiresAt,
            refreshed: true,
            adopted: true,
            mirrored: true,
          };
        }
      }
    }

    saveTokens(provId, acc, merged);
    if (cliOwned && mirrored) clearRotationJournal();

    const db2 = readDb();
    const row = db2.accounts.find((a) => a.provider === provId && a.account === acc);
    if (row) {
      row.expiresAt = merged.expiresAt;
      row.updatedAt = Date.now();
      delete row.needsSignIn;
      if (merged.scopes && merged.scopes.length) row.scopes = merged.scopes;
      if (cliOwned && !mirrored) row.mirrorError = Date.now();
      else delete row.mirrorError;
      writeDb(db2);
    }
    return {
      accessToken: merged.accessToken,
      expiresAt: merged.expiresAt,
      refreshed: true,
      mirrored: cliOwned ? !!mirrored : true,
    };
  });
}

function readCodexAuth() {
  const { home, appData, localAppData, xdgConfig } = configRoots();
  const candidates = [
    process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'auth.json') : '',
    path.join(home, '.codex', 'auth.json'),
    path.join(xdgConfig, 'codex', 'auth.json'),
    appData ? path.join(appData, 'codex', 'auth.json') : '',
    localAppData ? path.join(localAppData, 'codex', 'auth.json') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const t = (d && (d.tokens || (d.access_token ? d : null))) || null;
      if (t && (t.access_token || t.refresh_token)) return { path: p, raw: d, tokens: t };
    } catch (_) {}
  }
  return null;
}

function readGeminiCreds() {
  const { home, appData, localAppData, xdgConfig } = configRoots();
  const candidates = [
    path.join(home, '.gemini', 'oauth_creds.json'),
    path.join(home, '.gemini', 'antigravity', 'oauth_creds.json'),
    path.join(xdgConfig, 'gemini', 'oauth_creds.json'),
    appData ? path.join(appData, 'gemini', 'oauth_creds.json') : '',
    localAppData ? path.join(localAppData, 'gemini', 'oauth_creds.json') : '',
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (d && (d.refresh_token || d.access_token)) return { path: p, raw: d };
    } catch (_) {}
  }
  // Antigravity (the desktop app) keeps its grant in the login keychain under
  // service `gemini`, account `antigravity`, as a go-keyring base64 blob:
  //   { token: { access_token, token_type, refresh_token, expiry }, id_token }
  // Reading it is the only way to adopt an Antigravity sign-in without asking
  // the user to repeat the OAuth dance, and the refresh token it holds is the
  // same one the app rotates, so mirroring writes back keep both alive.
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'gemini', '-a', 'antigravity', '-w'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
      }).trim();
      const b64 = out.replace(/^go-keyring-base64:/, '');
      if (b64) {
        const d = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
        const t = (d && d.token) || {};
        if (t.refresh_token || t.access_token) {
          const expiry = t.expiry ? Date.parse(String(t.expiry)) : 0;
          return {
            path: 'keychain:gemini/antigravity',
            raw: {
              access_token: t.access_token || '',
              refresh_token: t.refresh_token || '',
              id_token: d.id_token || '',
              token_type: t.token_type || 'Bearer',
              expiry_date: Number.isFinite(expiry) ? expiry : 0,
            },
          };
        }
      }
    } catch (_) {}
  }
  return null;
}

function readGrokConfig() {
  const { home, appData, localAppData, xdgConfig } = configRoots();
  const jsonCandidates = [
    path.join(home, '.grok', 'auth.json'),
    path.join(home, '.grok', 'credentials.json'),
    path.join(xdgConfig, 'grok', 'auth.json'),
    appData ? path.join(appData, 'grok', 'auth.json') : '',
    localAppData ? path.join(localAppData, 'grok', 'auth.json') : '',
  ].filter(Boolean);
  for (const p of jsonCandidates) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      const tok = d && (d.tokens || d);
      if (tok && (tok.access_token || tok.accessToken || tok.refresh_token || tok.refreshToken)) {
        return {
          path: p,
          oauth: {
            accessToken: tok.access_token || tok.accessToken || '',
            refreshToken: tok.refresh_token || tok.refreshToken || '',
            expiresAt: epochToMs(tok.expires_at || tok.expiresAt),
          },
        };
      }
    } catch (_) {}
  }
  const tomlCandidates = [
    path.join(home, '.grok', 'config.toml'),
    path.join(xdgConfig, 'grok', 'config.toml'),
    appData ? path.join(appData, 'grok', 'config.toml') : '',
  ].filter(Boolean);
  for (const p of tomlCandidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8');
      const m = /^\s*(?:api_key|apiKey)\s*=\s*"([^"]+)"/m.exec(txt);
      if (m) return { path: p, apiKey: m[1] };
    } catch (_) {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// Account store
// ---------------------------------------------------------------------------
function loadTokens(prov, account) {
  const raw = secretstore.get(slotKey(prov, account));
  if (raw) {
    try { return JSON.parse(raw); } catch (_) {}
  }
  return readTokenMirror(prov, account);
}

function saveTokens(prov, account, tokens) {
  secretstore.set(slotKey(prov, account), JSON.stringify(tokens));
  writeTokenMirror(prov, account, tokens);
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

function isExpired(r) {
  if (!r.expiresAt || r.expiresAt > Date.now()) return false;
  // Metadata expiry alone is not proof: the first-party CLI rotates credentials
  // and a stored access token routinely outlives `expiresAt` (verified live
  // 2026-11-25 — a "past expiry" keychain token still answered HTTP 200). Only
  // report dead after a probe has had its chance to clear it.
  return !(r.verifiedAt && Date.now() - r.verifiedAt < 10 * 60 * 1000);
}

function publicRecord(r) {
  return {
    id: r.provider + ':' + r.account,
    provider: r.provider,
    account: r.account,
    label: r.label,
    plan: r.plan || '',
    // The provider's own human name for the plan ("Free", "Plus", "Max") when
    // it told us one. The internal slug stays in `plan` for matching/compat.
    planName: r.planName || '',
    source: r.source || '',
    scopes: r.scopes || [],
    expiresAt: r.expiresAt || 0,
    expired: isExpired(r),
    // The token endpoint said `invalid_grant`: only a fresh sign-in fixes this,
    // so the UI must offer one instead of "try again later".
    needsSignIn: !!r.needsSignIn,
    // A CLI-owned rotation that did not reach the keychain. The credential still
    // works for us; Claude Code will not, until the write-back is replayed.
    mirrorPending: !!r.mirrorError,
    // A real probe answered for this account, so the adapter is verified by
    // evidence rather than by its unit tests. Only the timestamp crosses the
    // bridge — never the token.
    verifiedAt: r.verifiedAt || 0,
    // Never leak the token itself into the renderer or logs.
    hasToken: true,
  };
}

function listAccounts(provId) {
  const db = readDb();
  const rows = db.accounts
    .filter((a) => !provId || a.provider === provId)
    .map((a) => {
      let t = loadTokens(a.provider, a.account);
      if (!t) t = autoHealAccount(a.provider, a.account);
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

/**
 * Cheap authenticated probe for an account whose refresh just failed. A dead
 * refresh token does not imply a dead access token, so ask the API directly and
 * record `verifiedAt` on success — that is what clears a stale `expired` badge
 * and keeps a working credential out of a pointless re-login.
 */
async function verifyAccount(provId, account, opts) {
  const o = opts || {};
  const prov = provider(provId);
  if (!prov) return false;
  const acc = slug(account);
  const t = loadTokens(provId, acc);
  if (!t || !t.accessToken) return false;
  const headers = { accept: 'application/json' };
  let url = '';
  if (provId === 'claude') {
    url = 'https://api.anthropic.com/v1/models?limit=1';
    headers.authorization = 'Bearer ' + t.accessToken;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-beta'] = 'oauth-2025-04-20';
    headers['user-agent'] = 'claude-cli/2.0.0 (external, cli)';
  } else if (provId === 'grok') {
    url = 'https://api.x.ai/v1/models';
    headers.authorization = 'Bearer ' + t.accessToken;
  } else if (provId === 'chatgpt') {
    // The same cheap list call the transport uses to fill the model picker.
    // Before this branch existed the badge could claim "signed in" from
    // metadata alone with a dead token behind it.
    url = 'https://chatgpt.com/backend-api/codex/models';
    headers.authorization = 'Bearer ' + t.accessToken;
    headers.originator = 'codex_cli_rs';
    headers['user-agent'] = 'codex-cli/0.172.0';
    const row = getAccount(provId, acc);
    if (row && row.accountId) headers['chatgpt-account-id'] = row.accountId;
  } else {
    return false; // no cheap probe for this provider — don't spend a turn to find out
  }
  try {
    const res = await (o.fetchImpl || fetch)(url, { headers, signal: o.signal });
    if (!res || !res.ok) return false;
    const db = readDb();
    const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
    if (row) {
      row.verifiedAt = Date.now();
      writeDb(db);
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Record that a real API call answered for this account.
 *
 * `verifyAccount` is only consulted when a row looks expired; a healthy account
 * would therefore keep `verifiedAt: 0` forever and the picker would keep calling
 * its adapter "unverified" even after a live catalog came back. The catalog path
 * calls this on success so the badge is cleared by evidence, not by a hardcoded
 * list of provider ids in the renderer.
 */
function markVerified(provId, account) {
  const acc = account ? slug(account) : activeAccount(provId);
  if (!acc) return false;
  const db = readDb();
  const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
  if (!row) return false;
  row.verifiedAt = Date.now();
  writeDb(db);
  return true;
}

/**
 * Correct the plan label from the provider's live entitlement.
 *
 * ChatGPT's token often omits the plan claim entirely (the account on the
 * verification machine had no id_token at all, so every refresh kept the
 * sign-up default). `/backend-api/accounts/check` reports the real thing, so it
 * is the only honest source for "is this account free/plus/pro/team". Best
 * effort and never fatal: a failure leaves the previous label in place.
 */
async function refreshEntitlement(provId, account, opts) {
  const o = opts || {};
  const acc = account ? slug(account) : activeAccount(provId);
  if (!acc || provId !== 'chatgpt') return false;
  const t = loadTokens(provId, acc);
  if (!t || !t.accessToken) return false;
  const before = readDb().accounts.find((a) => a.provider === provId && a.account === acc);
  const headers = {
    accept: 'application/json',
    authorization: 'Bearer ' + t.accessToken,
    originator: 'codex_cli_rs',
    'user-agent': 'codex-cli/0.172.0',
  };
  if (before && before.accountId) headers['chatgpt-account-id'] = before.accountId;
  try {
    const res = await (o.fetchImpl || fetch)('https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27', {
      headers,
      signal: o.signal,
    });
    if (!res || !res.ok) return false;
    const j = await res.json();
    const table = (j && j.accounts) || {};
    // Our own workspace when we know its id, else the only real workspace.
    const keys = Object.keys(table).filter((k) => k !== 'default');
    const pick = (before && before.accountId && table[before.accountId])
      || (keys.length === 1 ? table[keys[0]] : table.default)
      || null;
    const a = (pick && pick.account) || {};
    const plan = String(a.plan_type || '').trim();
    const planName = String(a.plan_display_name || '').trim();
    if (!plan && !planName) return false;
    const db = readDb();
    const row = db.accounts.find((x) => x.provider === provId && x.account === acc);
    if (!row) return false;
    let changed = false;
    if (plan && row.plan !== plan) { row.plan = plan; changed = true; }
    if (planName && row.planName !== planName) { row.planName = planName; changed = true; }
    if (changed) writeDb(db);
    return true;
  } catch (_) {
    return false;
  }
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
 * The User-Agent to present to a provider's token endpoint.
 *
 * Live-verified 2026-11-25 on platform.claude.com/v1/oauth/token: the exact same
 * JSON body answered HTTP 429 `rate_limit_error` with no User-Agent and HTTP 400
 * `invalid_grant` with this one. The first-party endpoints gate on the client
 * identity they were built for, so mirror the CLI that owns the grant. Versions
 * come from the transport module (main.js injects the on-disk runtime versions).
 */
function tokenUserAgent(prov) {
  const id = (prov && prov.id) || '';
  try {
    const t = require('./providertransport');
    if (id === 'claude' && t.claudeUa) return t.claudeUa();
    if (id === 'chatgpt' && t.codexUa) return t.codexUa();
    if (id === 'grok' && t.grokUa) return t.grokUa();
  } catch (_) { /* transport not loaded: use the version floor below */ }
  if (id === 'claude') return 'claude-cli/2.1.332 (external, cli)';
  if (id === 'chatgpt') return 'codex-cli/0.172.0';
  if (id === 'grok') return 'grok/1.0.92 (macos; aarch64)';
  return 'akron-bot/1.0';
}

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
    // Verified live 2026-11-25 against platform.claude.com/v1/oauth/token:
    // a request with no User-Agent gets HTTP 429 `rate_limit_error` no matter
    // whether the refresh token is valid or garbage. The identical body sent
    // with this UA answers the truth (HTTP 400 `invalid_grant`). Without it the
    // app mistook a permanent "sign in again" for a transient throttle and
    // retried forever, which is exactly how a dead credential looked like a
    // busy server and the user was never told to re-authenticate.
    const headers = { accept: 'application/json', 'user-agent': tokenUserAgent(prov) };
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
    // Encoding: preferred first, then the alternative once. A grant that is
    // already answered `invalid_grant` is not an encoding complaint, and the
    // endpoint is rate-limited per client — do not spend a second request
    // re-sending a token the provider has just declared dead.
    let out = await attempt(primary);
    const deadGrant = clean.grant_type === 'refresh_token' &&
      !!(out.json && /invalid_grant/i.test(String(out.json.error || out.json.message || '')));
    if (!deadGrant && !out.res.ok && out.res.status >= 400 && out.res.status < 500 &&
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

  // Surface the provider's own reason. "token endpoint 400" tells the user
  // nothing; "invalid_grant — the code was already used" tells them what to do.
  const body = last.json || {};
  const rawReason = String(
    (body && (body.error_description || body.error || body.message || body.detail)) || ''
  );
  const reason = rawReason.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  const err = new Error(reason ? reason : 'the provider refused the token request (HTTP ' + last.res.status + ')');
  err.status = last.res.status;
  err.body = last.json || String(last.text || '').slice(0, 300);
  err.human = true;
  // A 429 is a "try later", never a "this account is dead" — the agent loop
  // must be able to tell the two apart.
  err.transient = last.res.status === 429 || last.res.status >= 500;
  const ra = last.res.headers && last.res.headers.get ? last.res.headers.get('retry-after') : null;
  const secs = Number(ra);
  if (Number.isFinite(secs) && secs > 0) err.retryAfterMs = Math.min(secs * 1000, 120000);
  throw err;
}

const refreshFlights = new Map();

/**
 * Refresh one account's access token. Rotates and persists the new refresh
 * token, updates the index, and mirrors the rotation back to the credential
 * store the account was imported from.
 *
 * Single-flight per `provider:account` so concurrent calls (e.g. orchestrator
 * hydrating multiple pool rows or Swarm workers) share one token request and
 * never burn a single-use refresh token.
 */
async function refreshAccount(provId, account, opts) {
  const prov = provider(provId);
  if (!prov) throw new Error('unknown provider: ' + provId);
  const acc = slug(account);
  const flightKey = provId + ':' + acc;
  if (refreshFlights.has(flightKey)) {
    return refreshFlights.get(flightKey);
  }
  const run = (async () => {
    const t = loadTokens(provId, acc);
    if (!t) throw new Error('no stored tokens for ' + provId + ':' + acc);
    if (!t.refreshToken) {
      const err = new Error('this account has no refresh token — sign in again');
      err.code = 'no_refresh_token';
      throw err;
    }
    // Claude's grant is owned by the Claude Code CLI; that path has its own
    // adopt/journal/write-back rules and must not share the generic flow.
    if (provId === 'claude') return refreshClaudeAccount(provId, acc, t, opts);
    const params = {
      grant_type: 'refresh_token',
      refresh_token: t.refreshToken,
      client_id: prov.clientId,
      client_secret: prov.clientSecret,
    };
    // Verified live: the working Claude grant sends exactly these three fields
    // and no `scope`. Echoing the scope list back invites invalid_scope.
    let json;
    try {
      json = await postToken(prov, params, opts);
    } catch (e) {
      const isInvalidGrant = e && e.status === 400 && /invalid_grant/i.test(String(e.message || ''));
      if (isInvalidGrant && (provId === 'antigravity' || provId === 'chatgpt')) {
        // Check if the first-party desktop app / CLI already rotated the token on disk or keychain.
        const adopted = adoptLocalCredentials(provId, acc);
        if (adopted && adopted.refreshToken && adopted.refreshToken !== t.refreshToken) {
          if (adopted.accessToken && (!adopted.expiresAt || adopted.expiresAt - Date.now() > REFRESH_SKEW_MS)) {
            return { accessToken: adopted.accessToken, expiresAt: adopted.expiresAt, refreshed: false, adopted: true };
          }
          json = await postToken(prov, {
            grant_type: 'refresh_token',
            refresh_token: adopted.refreshToken,
            client_id: prov.clientId,
            client_secret: prov.clientSecret,
          }, opts);
        } else {
          throw e;
        }
      } else {
        throw e;
      }
    }
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
      delete row.needsSignIn;
      if (merged.scopes && merged.scopes.length) row.scopes = merged.scopes;
      writeDb(db2);
    }
    // An id_token refresh can reveal a changed plan; keep the label current.
    return { accessToken: merged.accessToken, expiresAt: merged.expiresAt, refreshed: true, mirrored };
  })();
  refreshFlights.set(flightKey, run);
  try {
    return await run;
  } finally {
    if (refreshFlights.get(flightKey) === run) refreshFlights.delete(flightKey);
  }
}

/**
 * Return a usable access token, refreshing first when it is at or near expiry.
 * This is the only function the agent loop should call.
 */
async function ensureToken(provId, account, opts) {
  const o = opts || {};
  const acc = slug(account || activeAccount(provId) || 'default');
  let t = loadTokens(provId, acc);
  if (!t) t = adoptLocalCredentials(provId, acc);
  if (!t) throw new Error('no stored tokens for ' + provId + ':' + acc);
  const fresh = t.accessToken && (!t.expiresAt || t.expiresAt - Date.now() > REFRESH_SKEW_MS);
  if (fresh && !o.force) {
    return { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshed: false, account: acc };
  }
  if (!t.refreshToken) {
    if (t.accessToken) return { accessToken: t.accessToken, expiresAt: t.expiresAt, refreshed: false, account: acc };
    throw new Error('account ' + provId + ':' + acc + ' has no usable token — sign in again');
  }
  // A failed refresh is not proof the access token is dead: the first-party CLI
  // rotates credentials under us, and a stored access token routinely outlives
  // its stated `expiresAt` (verified live 2026-11-25: keychain token past its
  // expiry still answered HTTP 200). Prefer attempting the real request — only a
  // 401 from the API is an authoritative "sign in again".
  const r = await refreshAccount(provId, acc, o).catch((e) => {
    if (!t.accessToken) throw e;
    return {
      accessToken: t.accessToken,
      expiresAt: t.expiresAt,
      refreshed: false,
      stale: true,
      needsSignIn: !!(e && e.needsSignIn),
      refreshError: (e && e.message) || String(e),
    };
  });
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
    ? 'Akron Code can close this tab and keep working.'
    : escapeHtml(payload.errorDescription || payload.error || 'no authorization code was returned');
  return renderPage(title, detail);
}

// One page renderer for every outcome, so the browser tab can never claim more
// than the app actually knows. A "code" in the callback is not a finished
// sign-in: the token exchange still has to succeed.
function renderPage(title, detail) {
  return '<!doctype html><meta charset="utf-8"><title>' + escapeHtml(title) + '</title>' +
    '<style>body{font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;' +
    'background:#F5FAF8;color:#12211c;display:grid;place-items:center;height:100vh;margin:0}' +
    '.c{max-width:30rem;padding:2.2rem 2.4rem;background:#fff;border-radius:16px;' +
    'box-shadow:0 10px 40px rgba(6,50,38,.10);text-align:center}' +
    'h1{font-size:1.15rem;margin:0 0 .6rem;color:#0b3d2e}p{margin:0;color:#4f6b60}</style>' +
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

// Who, if anyone, owns a TCP port. Read-only (`lsof`), best-effort: an empty or
// unavailable answer is reported as "unknown", never as "free".
function portOwner(port) {
  return new Promise((resolve) => {
    let cp = null;
    try { cp = require('child_process'); } catch (_) { resolve(null); return; }
    try {
      cp.execFile('lsof', ['-nP', '-iTCP:' + port, '-sTCP:LISTEN'], { timeout: 4000 }, (err, stdout) => {
        const rows = String(stdout || '').trim().split('\n').filter(Boolean);
        if (rows.length < 2) { resolve(null); return; }
        const cols = rows[1].split(/\s+/);
        resolve({ command: cols[0] || '', pid: cols[1] || '' });
      });
    } catch (_) { resolve(null); }
  });
}

function startLoopbackServer(opts) {
  const o = opts || {};
  // The redirect *host* is what the provider's console registered and what the
  // browser is sent to; it is not necessarily the bind address. `localhost`
  // resolves to `::1` first on macOS and to `127.0.0.1` elsewhere, so a listener
  // on one family alone leaves every callback from the other at ECONNREFUSED.
  // Bind both loopback families on the same port instead of guessing.
  const redirectHost = o.redirectHost || 'localhost';
  const wantPath = o.path || '/callback';
  const wantPort = Number(o.port) > 0 ? Number(o.port) : 0;
  const hosts = o.host ? [o.host] : ['127.0.0.1', '::1'];
  return new Promise((resolve, reject) => {
    let settle = null;
    const done = new Promise((res) => { settle = res; });
    let timer = null;
    let closed = false;
    const servers = [];
    const stop = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      for (const s of servers) { try { s.close(); } catch (_) {} }
    };
    const onRequest = (req, res) => {
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
      try { u = new URL(req.url, 'http://localhost'); } catch (_) {
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
      // A callback carrying a state we did not mint does not belong to this
      // attempt. Refuse it in the browser and keep the listener open for the
      // real redirect instead of consuming the flow with a garbage code.
      if (o.state && payload.state && payload.state !== o.state) {
        res.writeHead(400, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, cors));
        res.end(renderPage('Sign-in did not complete', escapeHtml('That callback did not belong to this sign-in attempt. Akron Code is still waiting — finish signing in from the window it opened.')));
        return;
      }
      const respond = (title, detailHtml, after) => {
        let done = false;
        const once = () => { if (done) return; done = true; if (typeof after === 'function') after(); };
        res.writeHead(200, Object.assign({
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        }, cors));
        res.end(renderPage(title, detailHtml));
        // Let the browser finish reading the page before the listener closes,
        // otherwise the tab shows a reset instead of the verdict.
        res.on('finish', once);
        res.on('close', once);
      };
      // When the caller can prove the code is good (the token exchange), show
      // that verdict instead of optimistically declaring success on any `code`.
      if (typeof o.verify === 'function') {
        Promise.resolve()
          .then(() => o.verify(payload))
          .then((verdict) => {
            const v = verdict || {};
            if (v.ok) {
              respond('Signed in', 'Akron Code can close this tab and keep working.', () => {
                stop();
                settle(Object.assign({}, payload, { verified: v }));
              });
            } else {
              const detail = v.detail || 'the provider refused the sign-in';
              respond('Sign-in did not complete', escapeHtml(detail), () => {
                stop();
                settle(Object.assign({}, payload, { error: payload.error || 'exchange_failed', errorDescription: detail }));
              });
            }
          })
          .catch((e) => {
            const msg = String((e && e.message) || 'sign-in failed').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
            respond('Sign-in did not complete', escapeHtml(msg), () => {
              stop();
              settle(Object.assign({}, payload, { error: 'exchange_failed', errorDescription: msg }));
            });
          });
        return;
      }
      // No verifier supplied: never claim success on a bare code.
      respond('Finishing sign-in', 'Akron Code is completing the sign-in. You can close this tab.', () => {
        stop();
        settle(payload);
      });
    };

    // A provider whose console registered one exact redirect URI (OpenAI:
    // `http://localhost:1455/auth/callback`) refuses every other port, so a
    // busy port is a hard failure there — pretending to sign in on an ephemeral
    // port only produces the provider's bare `invalid_authorize_request` page.
    const strictPort = !!(o.strictPort && wantPort > 0);
    // Bind every requested host on one shared port. The first host picks the
    // port: a fixed port that is busy falls back to an ephemeral one (claude
    // and google accept any loopback port), and an ephemeral port is reused by
    // the remaining hosts.
    const bindAll = (hostsLeft, port) => {
      if (!hostsLeft.length) {
        const redirectUri = 'http://' + redirectHost + ':' + port + wantPath;
        timer = setTimeout(() => {
          stop();
          settle({ code: null, state: null, error: 'timeout', errorDescription: 'sign-in was not completed in time' });
        }, o.timeoutMs || 10 * 60 * 1000);
        if (typeof timer.unref === 'function') timer.unref();
        resolve({ redirectUri, port, host: servers.length ? 'dual' : 'none', wait: () => done, close: stop });
        return;
      }
      const host = hostsLeft[0];
      const server = http.createServer(onRequest);
      servers.push(server);
      let settled = false;
      const onError = (err) => {
        if (settled) return;
        settled = true;
        try { server.close(); } catch (_) {}
        const i = servers.indexOf(server);
        if (i >= 0) servers.splice(i, 1);
        if (servers.length === 0) {
          // Nothing bound yet. A registered port cannot move: report who owns
          // it instead of handing the provider a redirect_uri it will reject.
          if (err && err.code === 'EADDRINUSE' && port !== 0) {
            if (strictPort) {
              stop();
              const e = new Error('port ' + port + ' is already in use');
              e.code = 'EADDRINUSE';
              e.port = port;
              reject(e);
              return;
            }
            bindAll(hosts, 0);
            return;
          }
          stop();
          reject(err);
          return;
        }
        // The other family already owns the port; serve the one that works.
        bindAll(hostsLeft.slice(1), servers.length ? servers[0].address().port : port);
      };
      server.once('error', onError);
      server.listen({ port, host }, () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        server.on('error', () => {});
        const bound = server.address().port;
        bindAll(hostsLeft.slice(1), bound);
      });
    };
    bindAll(hosts, wantPort);
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
 * Normalise a pasted manual sign-in code. The CLI's manual page prints
 * `code#state`; users also paste the whole redirect URL. Both are accepted.
 */
function parseManualCode(input, fallbackState) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('sign-in returned no authorization code');
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try { u = new URL(raw); } catch (_) {
      throw new Error("That's a web address, not the code. Paste the code the page shows.");
    }
    const code = u.searchParams.get('code') || '';
    if (!code) throw new Error('that link carried no authorization code — paste the code the page shows');
    return { code, state: u.searchParams.get('state') || fallbackState || '' };
  }
  // `code#state` is what the manual callback page displays.
  const m = raw.match(/^([^#]+)#(.*)$/);
  if (m) return { code: m[1], state: m[2] };
  return { code: raw, state: fallbackState || '' };
}

/**
 * Run the browser sign-in flow for one provider and persist the account.
 * @param {string} provId
 * @param {{openExternal:Function, fetchImpl?:Function, timeoutMs?:number, label?:string,
 *          manual?:boolean, waitForCode?:Function}} opts
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
  // A browser sign-in can be abandoned — the user clicks the wrong provider,
  // or the browser never comes back. Without a cancel handle the caller stays
  // busy until the 10-minute timeout, so honour an AbortSignal and unwind the
  // listener immediately.
  const signal = o.signal || null;
  const cancelled = () => {
    const err = new Error('sign-in cancelled');
    err.code = 'signin_cancelled';
    return err;
  };
  const abortPromise = signal ? new Promise((_, rej) => {
    if (signal.aborted) return rej(cancelled());
    signal.addEventListener('abort', () => rej(cancelled()), { once: true });
  }) : null;
  // Keep an unhandled rejection from the losing side of a race off the process.
  if (abortPromise) abortPromise.catch(() => {});
  if (signal && signal.aborted) throw cancelled();
  // Manual mode: no loopback listener. The provider shows the code on its own
  // page and the caller hands it back through `waitForCode`. This is the only
  // path that works when the browser cannot reach 127.0.0.1 (containers,
  // remote sessions, a browser on another machine).
  const manual = !!(o.manual && prov.manualRedirectUrl && typeof o.waitForCode === 'function');
  let loop = null;
  let redirectUri = '';
  // The browser page must report what actually happened, so the token exchange
  // runs inside the listener and its verdict becomes the page the user sees.
  let verified = null;
  const exchange = async (code, st) => {
    const body = {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: prov.clientId,
      client_secret: prov.clientSecret,
      code_verifier: verifier,
    };
    if (prov.echoState) body.state = state;
    const json = await postToken(prov, body, { fetchImpl: o.fetchImpl });
    const tokens = normalizeTokens(prov, json);
    if (!tokens.accessToken) throw new Error('the provider returned no access token');
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
  };
  if (manual) {
    redirectUri = prov.manualRedirectUrl;
  } else {
    // A registered redirect URI means one exact port. Check it before we open
    // anything so the failure names the culprit instead of ending in the
    // provider's bare `invalid_authorize_request` page.
    if (prov.fixedRedirectPort) {
      const holder = await portOwner(prov.redirectPort);
      if (holder) {
        const where = 'http://' + prov.redirectHost + ':' + prov.redirectPort + prov.redirectPath;
        const who = (holder.command ? holder.command + ' (pid ' + holder.pid + ')' : 'another program');
        const err = new Error(
          prov.label + ' only accepts ' + where + ' as its redirect URI, but port ' +
          prov.redirectPort + ' is held by ' + who + '. Quit that process — a finished ' +
          '`codex login`, or a previous sign-in attempt still waiting — then retry.',
        );
        err.code = 'redirect_port_busy';
        err.port = prov.redirectPort;
        err.redirectUri = where;
        err.holder = holder;
        throw err;
      }
    }
    // Listen before we open the browser: the redirect can land instantly.
    loop = await startLoopbackServer({
      path: prov.redirectPath,
      port: prov.redirectPort,
      // OpenID providers that registered one exact redirect URI reject the
      // whole request when the port differs, so fail loudly on a busy port.
      strictPort: !!prov.fixedRedirectPort,
      redirectHost: prov.redirectHost,
      timeoutMs: o.timeoutMs || 10 * 60 * 1000,
      state,
      verify: async (payload) => {
        if (payload.error) return { ok: false, detail: payload.errorDescription || payload.error };
        if (!payload.code) return { ok: false, detail: 'the provider returned no authorization code' };
        try {
          verified = await exchange(payload.code, payload.state);
          return { ok: true };
        } catch (e) {
          return { ok: false, detail: String((e && e.message) || 'the provider refused the sign-in').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
        }
      },
    }).catch((e) => {
      if (e && e.code === 'EADDRINUSE') {
        const where = 'http://' + prov.redirectHost + ':' + prov.redirectPort + prov.redirectPath;
        const err = new Error(
          prov.label + ' only accepts ' + where + ' as its redirect URI, but port ' +
          prov.redirectPort + ' is already in use — so the browser request cannot be started. ' +
          'Quit whatever owns the port (usually a running `codex login`, or a previous attempt ' +
          'that is still waiting) and retry.',
        );
        err.code = 'redirect_port_busy';
        err.port = prov.redirectPort;
        err.redirectUri = where;
        throw err;
      }
      throw e;
    });
    redirectUri = loop.redirectUri;
    // Belt and braces: whatever the listener reports must be the URI the
    // provider registered. A mismatch is caught here instead of becoming an
    // opaque `invalid_authorize_request` page in the user's browser.
    if (prov.fixedRedirectPort && redirectUri !== 'http://' + prov.redirectHost + ':' + prov.redirectPort + prov.redirectPath) {
      const err = new Error(prov.label + ' redirected to the wrong address (' + redirectUri + ') — refusing to open a sign-in that cannot complete.');
      err.code = 'redirect_uri_mismatch';
      try { loop.close(); } catch (_) {}
      throw err;
    }
    redirectUri = loop.redirectUri;
  }
  const url = buildAuthorizeUrl(prov, { redirectUri, state, challenge, nonce });
  try { o.openExternal(url); } catch (_) {}
  let cb;
  if (manual) {
    let pasted = '';
    try {
      const wait = Promise.resolve().then(() => o.waitForCode({ url, state }));
      wait.catch(() => {});
      pasted = await (abortPromise ? Promise.race([wait, abortPromise]) : wait);
    } finally {
      if (loop) loop.close();
    }
    cb = parseManualCode(pasted, state);
  } else {
    try {
      const wait = loop.wait();
      wait.catch(() => {});
      cb = await (abortPromise ? Promise.race([wait, abortPromise]) : wait);
    } finally {
      loop.close();
    }
  }
  if (cb.error) {
    const err = new Error(cb.errorDescription || cb.error);
    err.code = cb.error;
    throw err;
  }
  if (!cb.code) throw new Error('sign-in returned no authorization code');
  if (cb.state && cb.state !== state) {
    throw new Error('sign-in state mismatch — the callback did not belong to this attempt');
  }
  // The loopback path already exchanged the code (that is what the browser page
  // reported). Only the manual path still has to do it here.
  if (verified) return verified;
  return exchange(cb.code, cb.state);
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
        source: /^keychain:/.test(g.path) ? 'antigravity-app' : 'gemini-cli',
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
  // An unreadable index is not an empty app. Report it so the UI can say so
  // instead of showing zero accounts as though that were the truth.
  if (db.unreadable) {
    out.storeError = db.error || 'the account index could not be read';
    out.storeQuarantine = db.quarantine || '';
  }
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
      // A provider whose authorize page can print the code instead of calling
      // back to localhost: the fallback when the browser cannot reach the
      // loopback listener at all. Claude is the one that ships this page.
      canManualCode: !!(prov.kind === 'oauth' && prov.manualRedirectUrl),
      // A provider that signs in through the browser may still accept a pasted
      // API key as a secondary route (Grok today).
      canPasteKey: prov.kind !== 'oauth' || prov.allowBearer === true,
    });
  }
  out.total = db.accounts.length;
  return out;
}

/**
 * Re-adopt an account's token from the first-party credential store.
 *
 * The secretstore is encrypted with an app-identity-derived keychain item, so a
 * rename (Helio Bot → Akron Code) makes every previously stored token
 * undecryptable, and a keychain item can also disappear on its own. Accounts
 * that were imported from a first-party CLI (`source: 'claude-code'`) still have
 * a live credential one read away, so healing is preferable to telling the user
 * to sign in again. Only adopts when exactly one account of that provider came
 * from that CLI, so it can never swap in somebody else's login.
 */
function adoptLocalCredentials(provId, acc, opts) {
  const o = opts || {};
  const db = o.db || readDb();
  const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
  if (!row) return null;
  const save = o.saveTokens || saveTokens;
  const persist = o.writeDb || writeDb;

  if (provId === 'claude') {
    if (row.source !== 'claude-code') return null;
    const peers = db.accounts.filter((a) => a.provider === provId && a.source === 'claude-code');
    if (peers.length > 1) return null;
    const read = o.readCreds || readClaudeCodeCredentials;
    const cc = read();
    const oauth = cc && cc.oauth;
    if (!oauth || !oauth.accessToken) return null;
    const tokens = {
      accessToken: oauth.accessToken,
      refreshToken: oauth.refreshToken || '',
      tokenType: 'Bearer',
      expiresAt: epochToMs(oauth.expiresAt),
      scopes: oauth.scopes || row.scopes || [],
      organizationUuid: cc.organizationUuid || row.organizationUuid || '',
      accountId: '',
    };
    save(provId, acc, tokens);
    row.expiresAt = tokens.expiresAt;
    row.updatedAt = Date.now();
    if (tokens.scopes.length) row.scopes = tokens.scopes;
    if (!row.plan && oauth.subscriptionType) row.plan = oauth.subscriptionType;
    persist(db);
    return tokens;
  }

  if (provId === 'antigravity') {
    if (row.source !== 'antigravity-app' && row.source !== 'gemini-cli') return null;
    const peers = db.accounts.filter((a) => a.provider === provId && (a.source === 'antigravity-app' || a.source === 'gemini-cli'));
    if (peers.length > 1) return null;
    const g = (o.readGemini || readGeminiCreds)();
    const d = g && g.raw;
    if (!d || (!d.access_token && !d.refresh_token)) return null;
    const tokens = {
      accessToken: d.access_token || '',
      refreshToken: d.refresh_token || '',
      tokenType: d.token_type || 'Bearer',
      expiresAt: epochToMs(d.expiry_date || d.expiry),
      scopes: d.scope ? String(d.scope).split(/\s+/).filter(Boolean) : (row.scopes || []),
      organizationUuid: '',
      accountId: '',
    };
    save(provId, acc, tokens);
    row.expiresAt = tokens.expiresAt;
    row.updatedAt = Date.now();
    delete row.needsSignIn;
    persist(db);
    return tokens;
  }

  if (provId === 'chatgpt') {
    if (row.source !== 'codex-cli') return null;
    const peers = db.accounts.filter((a) => a.provider === provId && a.source === 'codex-cli');
    if (peers.length > 1) return null;
    const cx = (o.readCodex || readCodexAuth)();
    const t = cx && cx.tokens;
    if (!t || (!t.access_token && !t.refresh_token)) return null;
    const tokens = {
      accessToken: t.access_token || '',
      refreshToken: t.refresh_token || '',
      tokenType: 'Bearer',
      expiresAt: 0,
      scopes: row.scopes || [],
      organizationUuid: '',
      accountId: t.account_id || row.accountId || '',
    };
    save(provId, acc, tokens);
    row.updatedAt = Date.now();
    delete row.needsSignIn;
    persist(db);
    return tokens;
  }

  if (provId === 'grok') {
    if (row.source !== 'grok-config') return null;
    const peers = db.accounts.filter((a) => a.provider === provId && a.source === 'grok-config');
    if (peers.length > 1) return null;
    const gr = (o.readGrok || readGrokConfig)();
    if (!gr) return null;
    const tokens = gr.oauth
      ? {
          accessToken: gr.oauth.accessToken || '',
          refreshToken: gr.oauth.refreshToken || '',
          tokenType: 'Bearer',
          expiresAt: gr.oauth.expiresAt || 0,
          scopes: row.scopes || [],
          organizationUuid: '',
          accountId: '',
        }
      : (gr.apiKey ? {
          accessToken: gr.apiKey,
          refreshToken: '',
          tokenType: 'Bearer',
          expiresAt: 0,
          scopes: [],
          organizationUuid: '',
          accountId: '',
        } : null);
    if (!tokens) return null;
    save(provId, acc, tokens);
    row.updatedAt = Date.now();
    delete row.needsSignIn;
    persist(db);
    return tokens;
  }

  return null;
}

/**
 * Cross-platform self-healing for any existing account on macOS, Windows, or Linux.
 * Checks our encrypted mirror first, then first-party CLI/app stores on this PC
 * regardless of `row.source` (only when unambiguous for that provider).
 */
function autoHealAccount(provId, acc, opts) {
  const strict = adoptLocalCredentials(provId, acc, opts);
  if (strict) return strict;

  const o = opts || {};
  const db = o.db || readDb();
  const row = db.accounts.find((a) => a.provider === provId && a.account === acc);
  if (!row) return null;
  const save = o.saveTokens || saveTokens;
  const persist = o.writeDb || writeDb;

  const mirrored = readTokenMirror(provId, acc);
  if (mirrored && (mirrored.accessToken || mirrored.refreshToken)) {
    save(provId, acc, mirrored);
    row.updatedAt = Date.now();
    delete row.needsSignIn;
    persist(db);
    return mirrored;
  }

  // Only adopt shared PC credentials for a row when this provider has 1 account on disk.
  const sameProv = db.accounts.filter((a) => a.provider === provId);
  if (sameProv.length > 1) return null;

  let healed = null;
  if (provId === 'claude') {
    const cc = readClaudeCodeCredentials();
    const oauth = cc && cc.oauth;
    if (oauth && (oauth.accessToken || oauth.refreshToken)) {
      healed = {
        accessToken: oauth.accessToken || '',
        refreshToken: oauth.refreshToken || '',
        tokenType: 'Bearer',
        expiresAt: epochToMs(oauth.expiresAt),
        scopes: oauth.scopes || row.scopes || [],
        organizationUuid: cc.organizationUuid || row.organizationUuid || '',
        accountId: '',
      };
    }
  } else if (provId === 'antigravity') {
    const g = readGeminiCreds();
    const d = g && g.raw;
    if (d && (d.access_token || d.refresh_token)) {
      healed = {
        accessToken: d.access_token || '',
        refreshToken: d.refresh_token || '',
        tokenType: d.token_type || 'Bearer',
        expiresAt: epochToMs(d.expiry_date || d.expiry),
        scopes: d.scope ? String(d.scope).split(/\s+/).filter(Boolean) : (row.scopes || []),
        organizationUuid: '',
        accountId: '',
      };
    }
  } else if (provId === 'chatgpt') {
    const cx = readCodexAuth();
    const t = cx && cx.tokens;
    if (t && (t.access_token || t.refresh_token)) {
      healed = {
        accessToken: t.access_token || '',
        refreshToken: t.refresh_token || '',
        tokenType: 'Bearer',
        expiresAt: 0,
        scopes: row.scopes || [],
        organizationUuid: '',
        accountId: t.account_id || row.accountId || '',
      };
    }
  } else if (provId === 'grok') {
    const gr = readGrokConfig();
    if (gr && gr.oauth) {
      healed = {
        accessToken: gr.oauth.accessToken || '',
        refreshToken: gr.oauth.refreshToken || '',
        tokenType: 'Bearer',
        expiresAt: gr.oauth.expiresAt || 0,
        scopes: row.scopes || [],
        organizationUuid: '',
        accountId: '',
      };
    } else if (gr && gr.apiKey) {
      healed = {
        accessToken: gr.apiKey,
        refreshToken: '',
        tokenType: 'Bearer',
        expiresAt: 0,
        scopes: [],
        organizationUuid: '',
        accountId: '',
      };
    }
  }

  if (!healed) return null;
  save(provId, acc, healed);
  if (healed.expiresAt) row.expiresAt = healed.expiresAt;
  if (healed.accountId) row.accountId = healed.accountId;
  row.updatedAt = Date.now();
  delete row.needsSignIn;
  persist(db);
  return healed;
}

/**
 * Scan all configured accounts + PC credentials across macOS, Windows, and Linux.
 * Heals broken/missing tokens for existing rows and optionally imports newly
 * discovered first-party CLI/desktop accounts when `importMissing: true`.
 */
async function autoHealAll(opts) {
  const o = opts || {};
  const db = readDb();
  const healed = [];
  for (const a of db.accounts || []) {
    const cur = loadTokens(a.provider, a.account);
    const broken = !cur || (!cur.accessToken && !cur.refreshToken) || !!a.needsSignIn || isExpired(a);
    if (!broken) continue;
    const tok = autoHealAccount(a.provider, a.account, o);
    if (tok) healed.push(a.provider + ':' + a.account);
  }
  let imported = [];
  if (o.importMissing) {
    const haveProv = new Set((db.accounts || []).map((a) => a.provider));
    const missingAny = providerIds().some((id) => !haveProv.has(id));
    if (missingAny) {
      try {
        const res = await importLocal({ fetchImpl: o.fetchImpl });
        imported = (res && res.imported) || [];
      } catch (_) {}
    }
  }
  return { ok: true, healed, imported };
}

/**
 * Re-import the Claude credential after the owner (Claude Code CLI) re-signed in.
 *
 * The app never runs its own Claude OAuth: a second flow would mint a refresh
 * token the CLI does not know about, and the first rotation on either side
 * would sign the other out. The correct reconnect is the CLI's own login, then
 * this adoption.
 *
 * A stale account whose grant the CLI has replaced is removed, because its
 * refresh token is dead by construction and keeping the row would show the user
 * two Claude accounts, one of which can never work.
 */
async function adoptClaudeFromCli(opts) {
  const o = opts || {};
  const cc = readClaudeCodeCredentials();
  if (!cc || !cc.oauth || !cc.oauth.accessToken) {
    const e = new Error('Claude Code has no saved sign-in on this machine — run `claude` and finish its sign-in first');
    e.code = 'provider_needs_signin';
    e.human = true;
    throw e;
  }
  const tokens = {
    accessToken: cc.oauth.accessToken,
    refreshToken: cc.oauth.refreshToken || '',
    tokenType: 'Bearer',
    expiresAt: epochToMs(cc.oauth.expiresAt),
    scopes: cc.oauth.scopes || [],
    organizationUuid: cc.organizationUuid || '',
    accountId: '',
  };
  const sub = cc.oauth.subscriptionType || 'subscription';
  const existing = readDb().accounts.filter((a) => a.provider === 'claude');
  const previous = existing.length === 1 ? existing[0] : null;

  // The keychain can hold a token the CLI never managed to refresh. Adopting it
  // would clear the sign-in flag without a working credential, so ask the API
  // first: 401 means the CLI is still signed out, and only a transport failure
  // (where the answer is genuinely unknown) falls back to offline adoption.
  const doFetch = o.fetchImpl || fetch;
  try {
    const res = await doFetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: {
        authorization: 'Bearer ' + tokens.accessToken,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json',
        'user-agent': 'claude-cli/2.1.332 (external, cli)',
      },
    });
    if (res && (res.status === 401 || res.status === 403)) {
      const e = new Error('Claude Code is still signed out — finish its sign-in, then reconnect');
      e.code = 'provider_needs_signin';
      e.human = true;
      throw e;
    }
  } catch (e) {
    if (e && e.code === 'provider_needs_signin') throw e;
    /* network below us: adopt the credential we have and let the next turn test it */
  }

  // The profile probe names the account. If it is unavailable the credential is
  // still adopted under the row we already track, so a flaky network can never
  // cost the user their sign-in.
  let account = '';
  let plan = '';
  try {
    const ident = await identify('claude', tokens, { fetchImpl: o.fetchImpl });
    account = ident.account || '';
    plan = ident.plan || '';
  } catch (_) { /* offline adoption is fine */ }
  account = account || (previous && previous.account) || slug('claude');
  plan = plan || (previous && previous.plan) || sub;

  const rec = addAccount('claude', {
    account,
    label: 'Claude · ' + (cc.oauth.subscriptionType || (previous && previous.plan) || 'subscription'),
    plan,
    source: 'claude-code',
    tokens,
  });
  // The CLI signed into a different account: retire the row whose grant is gone.
  if (previous && previous.account !== account) {
    try { removeAccount('claude', previous.account); } catch (_) {}
  }
  try { setActive('claude', account); } catch (_) {}
  return rec;
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
    // ChatGPT's responses endpoint requires the account id header, and the
    // Google transport needs its own Cloud Code host — both live on the
    // provider registry, so carry them through instead of re-looking them up.
    accountId: rec ? (rec.accountId || '') : '',
    codexUrl: prov.codexUrl || '',
    cloudcodeUrl: prov.cloudcodeUrl || '',
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
  verifyAccount,
  /** A live call answered: clear the "unverified" badge from evidence. */
  markVerified,
  /** Ask the provider for the real plan name and correct a stale label. */
  refreshEntitlement,
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
  autoHealAccount,
  autoHealAll,
  /** Finish a Claude rotation whose keychain write-back was interrupted. */
  replayRotationJournal,
  /** The credential the Claude Code CLI owns (keychain), or null. */
  readClaudeCodeCredentials,
  /** Adopt the current Claude Code keychain credential (no OAuth of our own). */
  adoptClaudeFromCli,
  // exposed for tests
  _internal: {
    readDb, writeDb, slotKey, slug, jwtPayload, msFromEpoch, epochToMs, fingerprint,
    normalizeTokens, buildAuthorizeUrl, startLoopbackServer, readClaudeCodeCredentials,
    portOwner,
    readCodexAuth, readGeminiCreds, readGrokConfig, callbackPage, publicRecord,
    adoptLocalCredentials, parseManualCode,
    postToken, identify, REFRESH_SKEW_MS,
    tokenUserAgent, keychainPair, writeBackClaudeCode, replayRotationJournal,
    writeRotationJournal, readRotationJournal, withClaudeLock, adoptKeychainIfNewer,
    refreshClaudeAccount, refreshEntitlement, markVerified, ROTATION_JOURNAL, CLAUDE_LOCK,
  },
};
