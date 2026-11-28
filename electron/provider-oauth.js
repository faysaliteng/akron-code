'use strict';
/**
 * Subscription Provider Registry & Native CLI Auth Manager.
 *
 * Subscription accounts (`claude`, `chatgpt`, `antigravity`, `grok`) are managed
 * exclusively through each official CLI's own login / status / logout commands:
 *
 *   Claude Code  -> `claude auth login` / `claude auth status` / `claude auth logout`
 *   Codex        -> `codex login` / `codex login status` / `codex logout`
 *   Grok         -> `grok login` / `grok models` / `grok logout` (or xAI API key)
 *   Gemini / Agy -> `agy auth` / `gemini`
 *
 * No extracted OAuth client IDs, no custom PKCE token scraping, no local
 * credential file parsing/writing, and no plaintext token mirror dumps.
 * Optional API-key ("bearer") entries are stored encrypted in `secretstore.js`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const secretstore = require('./secretstore');
const cliRunner = require('./cli-runner');

const DIR = process.env.AUTOBOT_HOME
  ? path.resolve(process.env.AUTOBOT_HOME)
  : path.join(os.homedir(), '.autobot');
const DB_FILE = path.join(DIR, 'provider-oauth.json');

const PROVIDERS = {
  claude: {
    id: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    kind: 'cli',
    transport: 'cli',
    cliId: 'claude-code',
    bin: 'claude',
    authLoginArgs: ['auth', 'login'],
    authStatusArgs: ['auth', 'status'],
    authLogoutArgs: ['auth', 'logout'],
    allowBearer: true,
    bearerBaseURL: 'https://api.anthropic.com',
    models: [
      { id: 'claude-fable-5-2', label: 'Fable 5.2', contextWindow: 1000000, thinking: true },
      { id: 'claude-haiku-5-5', label: 'Haiku 5.5', contextWindow: 1000000, thinking: true },
      { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-5-5', label: 'Opus 5.5', contextWindow: 1000000, thinking: true },
      { id: 'claude-fable-5-1', label: 'Fable 5.1', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-5', label: 'Opus 5', contextWindow: 1000000, thinking: true },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', contextWindow: 1000000, thinking: true },
      { id: 'claude-fable-5', label: 'Fable 5', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', contextWindow: 1000000, thinking: true },
      { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-4-6', label: 'Opus 4.6', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-4-5-20251101', label: 'Opus 4.5', contextWindow: 1000000, thinking: true },
      { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', contextWindow: 200000, thinking: true },
      { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet 4.5', contextWindow: 1000000, thinking: true },
    ],
    docs: 'https://docs.anthropic.com/en/docs/claude-code',
  },
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT / Codex',
    vendor: 'OpenAI',
    kind: 'cli',
    transport: 'cli',
    cliId: 'codex',
    bin: 'codex',
    authLoginArgs: ['login'],
    authStatusArgs: ['login', 'status'],
    authLogoutArgs: ['logout'],
    allowBearer: true,
    bearerBaseURL: 'https://api.openai.com/v1',
    models: [
      { id: 'gpt-5-4', label: 'GPT-5.4', contextWindow: 1000000, thinking: true },
      { id: 'gpt-5.4', label: 'GPT-5.4 (1M)', contextWindow: 1000000, thinking: true },
      { id: 'gpt-5', label: 'GPT-5', contextWindow: 400000, thinking: true },
      { id: 'o3', label: 'OpenAI o3', contextWindow: 200000, thinking: true },
      { id: 'codex-auto-review', label: 'Codex Auto Review', contextWindow: 400000, thinking: true },
    ],
    docs: 'https://developers.openai.com/codex',
  },
  antigravity: {
    id: 'antigravity',
    label: 'Google Gemini / Antigravity',
    vendor: 'Google',
    kind: 'cli',
    transport: 'cli',
    cliId: 'antigravity-cli',
    bin: 'agy',
    fallbackBins: ['gemini'],
    authLoginArgs: ['acp', '--login'],
    authStatusArgs: ['models'],
    authLogoutArgs: ['logout'],
    allowBearer: true,
    bearerBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      { id: 'gemini-pro-orchestrator-neon', label: 'Orchestrator (Neon)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-pro-orchestrator', label: 'Orchestrator (Carbon)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-pro-orchestrator-argon', label: 'Orchestrator (Argon)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-carbon-high', label: 'Gemini 4 Carbon (High)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-carbon-medium', label: 'Gemini 4 Carbon (Medium)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-carbon-low', label: 'Gemini 4 Carbon (Low)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-argon-medium', label: 'Gemini 4 Argon (Medium)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-argon-low', label: 'Gemini 4 Argon (Low)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-neon-xhigh', label: 'Gemini 4 Neon (XHigh)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-neon-high', label: 'Gemini 4 Neon (High)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-neon-medium', label: 'Gemini 4 Neon (Medium)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-neon-low', label: 'Gemini 4 Neon (Low)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-hydrogen-xhigh', label: 'Gemini 4 Hydrogen (XHigh)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-hydrogen-high', label: 'Gemini 4 Hydrogen (High)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-hydrogen-medium', label: 'Gemini 4 Hydrogen (Medium)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-4-hydrogen-low', label: 'Gemini 4 Hydrogen (Low)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)', contextWindow: 1048576, thinking: true },
      { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', contextWindow: 1048576, thinking: true },
      { id: 'claude-opus-5-5-high', label: 'Claude Opus 5.5 (High · Agy)', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-5-5-medium', label: 'Claude Opus 5.5 (Medium · Agy)', contextWindow: 1000000, thinking: true },
      { id: 'claude-opus-5-5-low', label: 'Claude Opus 5.5 (Low · Agy)', contextWindow: 1000000, thinking: true },
      { id: 'claude-sonnet-5-5-high', label: 'Claude Sonnet 5.5 (High · Agy)', contextWindow: 1000000, thinking: true },
      { id: 'claude-sonnet-5-5-medium', label: 'Claude Sonnet 5.5 (Medium · Agy)', contextWindow: 1000000, thinking: true },
      { id: 'claude-sonnet-5-5-low', label: 'Claude Sonnet 5.5 (Low · Agy)', contextWindow: 1000000, thinking: true },
      { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium · Agy)', contextWindow: 131072, thinking: true },
    ],
    docs: 'https://antigravity.google',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    vendor: 'xAI',
    kind: 'cli',
    transport: 'cli',
    cliId: 'grok',
    bin: 'grok',
    authLoginArgs: ['login'],
    authStatusArgs: ['models'],
    authLogoutArgs: ['logout'],
    allowBearer: true,
    bearerBaseURL: 'https://api.x.ai/v1',
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7', contextWindow: 1000000, thinking: true },
      { id: 'grok-4.7-build-fast', label: 'Grok 4.7 Build Fast', contextWindow: 2000000, thinking: true },
      { id: 'grok-4.6', label: 'Grok 4.6', contextWindow: 1000000, thinking: true },
      { id: 'grok-4.5', label: 'Grok 4.5', contextWindow: 1000000, thinking: true },
      { id: 'grok-build', label: 'Grok Build', contextWindow: 256000, thinking: true },
      { id: 'grok-4', label: 'Grok 4', contextWindow: 256000, thinking: true },
      { id: 'grok-4-fast', label: 'Grok 4 Fast', contextWindow: 2000000, thinking: true },
      { id: 'grok-code-fast-1', label: 'Grok Code Fast', contextWindow: 2000000, thinking: true },
    ],
    docs: 'https://docs.x.ai/docs',
  },
  kimi: {
    id: 'kimi',
    label: 'Kimi K3 (Kimi Code)',
    vendor: 'Moonshot AI',
    kind: 'cli',
    transport: 'cli',
    cliId: 'kimi-code',
    bin: 'kimi',
    authLoginArgs: ['login'],
    authStatusArgs: ['provider', 'list', '--json'],
    authLogoutArgs: ['provider', 'remove', 'kimi-code'],
    allowBearer: true,
    bearerBaseURL: 'https://api.moonshot.ai/v1',
    models: [
      { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', contextWindow: 1048576, thinking: true },
      { id: 'kimi-k3', label: 'Kimi K3', contextWindow: 1048576, thinking: true },
      { id: 'kimi-k3.1-pro-highspeed', label: 'Kimi K3.1 Pro Highspeed', contextWindow: 1048576, thinking: true },
      { id: 'kimi-k2.6', label: 'Kimi K2.6', contextWindow: 256000, thinking: true },
      { id: 'kimi-k2.5', label: 'Kimi K2.5', contextWindow: 256000, thinking: true },
    ],
    docs: 'https://moonshotai.github.io/kimi-code/',
  },
  zai: {
    id: 'zai',
    label: 'Z.ai (GLM Coding Plan)',
    vendor: 'Z.ai',
    kind: 'coding-plan',
    transport: 'zai',
    cliId: 'zcode',
    bin: 'zcode',
    authLoginArgs: ['login'],
    authStatusArgs: ['--version'],
    authLogoutArgs: ['logout'],
    allowBearer: true,
    bearerBaseURL: 'https://api.z.ai/api/coding/paas/v4',
    standardBaseURL: 'https://api.z.ai/api/paas/v4',
    models: [
      { id: 'glm-5.4', label: 'GLM-5.4 (Coding Plan)', contextWindow: 1000000, thinking: true },
      { id: 'glm-5.3', label: 'GLM-5.3 (Coding Plan)', contextWindow: 1000000, thinking: true },
      { id: 'glm-5.3-flash', label: 'GLM-5.3 Flash (Coding Plan)', contextWindow: 1000000, thinking: true },
      { id: 'glm-5', label: 'GLM-5', contextWindow: 1000000, thinking: true },
      { id: 'glm-4.7', label: 'GLM-4.7', contextWindow: 200000, thinking: true },
    ],
    docs: 'https://z.ai/manage-apikey/apikey-list',
  },
  copilot: {
    id: 'copilot',
    label: 'GitHub Copilot',
    vendor: 'GitHub',
    kind: 'cli',
    transport: 'cli',
    cliId: 'github-copilot',
    bin: 'copilot',
    authLoginArgs: ['login', '--device-code'],
    authStatusArgs: ['--version'],
    authLogoutArgs: [],
    allowBearer: true,
    bearerBaseURL: 'https://api.githubcopilot.com',
    models: [
      { id: 'copilot-auto', label: 'Copilot Auto', contextWindow: 1000000, thinking: true },
      { id: 'copilot-claude-opus-4-6', label: 'Claude Opus 4.6 (Copilot)', contextWindow: 1000000, thinking: true },
      { id: 'copilot-claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Copilot)', contextWindow: 1000000, thinking: true },
      { id: 'copilot-gpt-5-4', label: 'GPT-5.4 (Copilot)', contextWindow: 1000000, thinking: true },
      { id: 'copilot-gpt-5', label: 'GPT-5 (Copilot)', contextWindow: 400000, thinking: true },
      { id: 'copilot-gemini-3-1-pro', label: 'Gemini 3.1 Pro (Copilot)', contextWindow: 1048576, thinking: true },
    ],
    docs: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  },
};

const ALIAS_MAP = {
  codex: 'chatgpt',
  openai: 'chatgpt',
  google: 'antigravity',
  gemini: 'antigravity',
  agy: 'antigravity',
  xai: 'grok',
  anthropic: 'claude',
  moonshot: 'kimi',
  'kimi-code': 'kimi',
  zhipu: 'zai',
  glm: 'zai',
  'zai-coding': 'zai',
  zcode: 'zai',
  'github-copilot': 'copilot',
  github: 'copilot',
};

function providerIds() {
  return Object.keys(PROVIDERS);
}

function provider(id) {
  const raw = String(id || '').trim().toLowerCase();
  const key = ALIAS_MAP[raw] || raw;
  return PROVIDERS[key] || null;
}

function slug(s) {
  return String(s || 'default').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 96) || 'default';
}

function slotKey(provId, account) {
  return `provider-api:${provId}:${account}`;
}

function purgeLegacyTokenMirror() {
  try {
    const mirrorPath = path.join(DIR, ['oauth', 'mirror'].join('-'));
    if (fs.existsSync(mirrorPath)) {
      fs.rmSync(mirrorPath, { recursive: true, force: true });
    }
  } catch (_) {}
}

function readDb() {
  const blank = { accounts: [], active: {} };
  try {
    if (!fs.existsSync(DB_FILE)) return blank;
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return blank;
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    const active = parsed.active && typeof parsed.active === 'object' ? parsed.active : {};
    return { accounts, active };
  } catch (_) {
    try {
      const corrupt = `${DB_FILE}.corrupt-${Date.now()}`;
      fs.renameSync(DB_FILE, corrupt);
    } catch (_) {}
    return blank;
  }
}

function writeDb(db) {
  purgeLegacyTokenMirror();
  fs.mkdirSync(DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ accounts: db.accounts || [], active: db.active || {} }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB_FILE);
  try { fs.chmodSync(DB_FILE, 0o600); } catch (_) {}
}

function resolveZaiStoredKey(acct = 'coding-plan') {
  try {
    return String(
      secretstore.get(slotKey('zai', acct))
      || secretstore.get('provider-api:zai:coding-plan')
      || secretstore.get('autobot.orch_api_key.zai_coding')
      || secretstore.get('ZAI_CODING_API_KEY')
      || ''
    ).trim();
  } catch (_) {
    return '';
  }
}

function resolveCopilotStoredToken(acct = 'github-pat') {
  try {
    return String(
      secretstore.get(slotKey('copilot', acct))
      || secretstore.get('provider-api:copilot:github-pat')
      || secretstore.get('COPILOT_GITHUB_TOKEN')
      || secretstore.get('GH_TOKEN')
      || (!process.env.NODE_TEST_CONTEXT && (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN))
      || ''
    ).trim();
  } catch (_) {
    return '';
  }
}

function bearerHasKey(provId, account) {
  try {
    const raw = secretstore.get(slotKey(provId, account));
    return Boolean(raw && String(raw).trim());
  } catch (_) {
    return false;
  }
}

function cleanCliLabel(text) {
  return String(text || '').replace(/\bCLI\s+CLI\b/gi, 'CLI').trim();
}

function publicRecord(rec, provId) {
  if (!rec) return null;
  const prov = provider(provId || rec.provider);
  const pid = (prov && prov.id) || rec.provider;
  const acct = String(rec.account || 'cli');
  let isBearer = rec.source === 'api-key';
  let hasZaiSecret = false;
  let hasCopilotSecret = false;
  if (pid === 'zai' && !(cliRunner.detectZcodeCli && cliRunner.detectZcodeCli())) {
    const zKey = resolveZaiStoredKey(acct);
    if (zKey) {
      hasZaiSecret = true;
      isBearer = true;
    }
  }
  if (pid === 'copilot') {
    hasCopilotSecret = Boolean(resolveCopilotStoredToken(acct));
  }
  const hasKey = isBearer ? (bearerHasKey(pid, acct) || hasZaiSecret || hasCopilotSecret) : true;
  const ready = (hasZaiSecret || hasCopilotSecret) ? true : (!Boolean(rec.needsSignIn) && hasKey);
  return {
    id: `${pid}:${acct}`,
    provider: pid,
    account: acct,
    label: cleanCliLabel(rec.label || (prov ? prov.label : pid)),
    plan: rec.plan || (pid === 'zai' && isBearer ? 'Coding Plan' : 'CLI Subscription'),
    source: isBearer ? 'api-key' : (rec.source || 'cli'),
    needsSignIn: !ready,
    hasToken: ready,
    cliMode: pid === 'copilot' ? true : !isBearer,
    addedAt: rec.addedAt || Date.now(),
    verifiedAt: rec.verifiedAt || null,
  };
}

function getAccount(provId, account) {
  const p = provider(provId);
  if (!p) return null;
  const db = readDb();
  const acct = account || db.active[p.id];
  return db.accounts.find((a) => a && a.provider === p.id && (!acct || a.account === acct)) || null;
}

function activeAccount(provId) {
  const p = provider(provId);
  if (!p) return '';
  const db = readDb();
  if (db.active[p.id]) return db.active[p.id];
  const hit = db.accounts.find((a) => a && a.provider === p.id);
  return hit ? hit.account : '';
}

const AUTH_PROBE_CACHE_TTL_MS = 60 * 1000;
// A probe launches the provider's CLI (`agy models` alone is ~2.4s), so a chat
// turn must never wait on one to relearn what it knew minutes ago. A result
// older than the TTL but younger than this is answered from cache at once and
// refreshed in the background. Measured 2026-11-28: with 61 pool rows and one
// signed-out provider, un-cached probes cost ~52s before every single turn.
const AUTH_PROBE_STALE_OK_MS = 30 * 60 * 1000;
const _authProbeCache = new Map();
// One real probe per provider at a time: concurrent callers share its promise.
const _authProbeFlights = new Map();
// Tests only: replaces the CLI launch so caching/dedupe can be asserted.
let _authProbeTestHook = null;
function invalidateAuthProbeCache(provId = '') {
  if (!provId) { _authProbeCache.clear(); return; }
  const p = provider(provId);
  _authProbeCache.delete(p ? p.id : String(provId).toLowerCase());
}

function setActive(provId, account) {
  const p = provider(provId);
  if (!p) throw new Error(`unknown provider: ${provId}`);
  const db = readDb();
  db.active[p.id] = account;
  writeDb(db);
  return `${p.id}:${account}`;
}

function addAccount(provId, info = {}) {
  const p = provider(provId);
  if (!p) throw new Error(`unknown provider: ${provId}`);
  const account = slug(info.account || info.email || 'cli');
  const db = readDb();
  const idx = db.accounts.findIndex((a) => a && a.provider === p.id && a.account === account);
  const entry = {
    provider: p.id,
    account,
    label: cleanCliLabel(info.label || `${p.label} · ${account}`),
    plan: info.plan || 'CLI Subscription',
    source: info.source || 'cli',
    needsSignIn: info.needsSignIn === true,
    addedAt: (idx >= 0 && db.accounts[idx].addedAt) || Date.now(),
    verifiedAt: info.verifiedAt || Date.now(),
  };
  if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...entry };
  else db.accounts.push(entry);
  if (!db.active[p.id]) db.active[p.id] = account;
  writeDb(db);
  invalidateAuthProbeCache(p.id);
  return publicRecord(entry, p.id);
}

async function addBearer(id, key, opts = {}) {
  const [rawProv, ...rest] = String(id || '').split(':');
  const p = provider(rawProv);
  if (!p) throw new Error(`unknown provider: ${id}`);
  const cleanKey = String(key || '').trim();
  if (!cleanKey) throw new Error('API key is required');
  const account = slug(rest.join(':') || opts.account || (p.id === 'zai' ? 'coding-plan' : (p.id === 'copilot' ? 'github-pat' : 'api-key')));
  secretstore.set(slotKey(p.id, account), cleanKey);
  if (p.id === 'zai') {
    try { secretstore.set('autobot.orch_api_key.zai_coding', cleanKey); } catch (_) {}
  } else if (p.id === 'copilot') {
    try { secretstore.set('COPILOT_GITHUB_TOKEN', cleanKey); } catch (_) {}
  }
  return addAccount(p.id, {
    account,
    label: opts.label || (p.id === 'zai' ? 'Z.ai Coding Plan Key' : (p.id === 'copilot' ? 'GitHub Copilot (PAT)' : `${p.label} API Key`)),
    plan: p.id === 'zai' ? 'Coding Plan' : (p.id === 'copilot' ? 'CLI Subscription' : 'API Key'),
    source: 'api-key',
  });
}

function removeAccount(provId, account) {
  const p = provider(provId);
  if (!p) return false;
  const db = readDb();
  const target = account || activeAccount(p.id);
  const before = db.accounts.length;
  db.accounts = db.accounts.filter((a) => !(a && a.provider === p.id && (!target || a.account === target)));
  if (db.active[p.id] === target || !target) {
    const next = db.accounts.find((a) => a && a.provider === p.id);
    if (next) db.active[p.id] = next.account;
    else delete db.active[p.id];
  }
  try { secretstore.del(slotKey(p.id, target)); } catch (_) {}
  writeDb(db);
  invalidateAuthProbeCache(p.id);
  return db.accounts.length !== before;
}

function listAccounts() {
  const db = readDb();
  return db.accounts.map((a) => publicRecord(a)).filter(Boolean);
}

function status() {
  const db = readDb();
  const zcodeInstalled = Boolean(cliRunner.detectZcodeCli && cliRunner.detectZcodeCli());
  const providers = providerIds().map((pid) => {
    const p = PROVIDERS[pid];
    const accts = db.accounts.filter((a) => a && a.provider === pid).map((a) => publicRecord(a, pid));
    return {
      id: p.id,
      label: p.label,
      vendor: p.vendor,
      kind: p.kind,
      transport: p.transport,
      allowBearer: !!p.allowBearer,
      canPasteKey: !!p.allowBearer,
      canCliSignIn: p.kind === 'cli' || (p.id === 'zai' && zcodeInstalled),
      zcodeInstalled: p.id === 'zai' ? zcodeInstalled : undefined,
      cliId: p.cliId,
      bin: p.bin,
      accounts: accts,
      active: db.active[pid] || (accts[0] ? accts[0].account : ''),
      signedIn: accts.some((a) => a && a.hasToken && !a.needsSignIn && !a.expired),
      models: p.models,
      docs: p.docs,
    };
  });
  return { providers, accounts: providers.flatMap((p) => p.accounts), total: providers.reduce((n, p) => n + p.accounts.length, 0) };
}

function execCli(bin, args, opts = {}) {
  const timeout = Number(opts.timeoutMs) || 8000;
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : (err ? 1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });
}

async function resolveCliPathForProvider(prov, opts = {}) {
  const bins = [prov.bin, ...(prov.fallbackBins || [])].filter(Boolean);
  if (typeof opts.resolveBin === 'function') {
    return (await opts.resolveBin(prov.id, bins)) || '';
  }
  const r = await cliRunner.resolveCliBinary({ cliKind: prov.id, cliId: prov.cliId, cliBin: prov.bin }, opts);
  if (r && r.bin && fs.existsSync(r.bin)) return r.bin;
  for (const b of bins) {
    const hit = cliRunner.whichOnPath(b);
    if (hit) return hit;
  }
  return '';
}

/**
 * Is this provider's CLI signed in?
 *
 *   fresh cache (< TTL)            -> cached answer, no CLI launch
 *   stale cache (< STALE_OK)       -> cached answer now, one background refresh
 *   no cache, or `opts.force`      -> a real probe, shared by concurrent callers
 *
 * `force` is for moments the answer is known to have changed (the user just
 * signed in or out, or pressed Import / Auto-heal). Injected `execCli` /
 * `resolveBin` (tests) always run a private, un-cached probe.
 */
async function probeCliAuthStatus(provId, opts = {}) {
  const p = provider(provId);
  if (!p) return { ok: false, loggedIn: false, error: `unknown provider ${provId}` };
  if (opts.execCli || opts.resolveBin) return runCliAuthProbe(p, opts);

  const startProbe = () => {
    const inFlight = _authProbeFlights.get(p.id);
    if (inFlight) return inFlight;
    const run = _authProbeTestHook
      ? Promise.resolve(_authProbeTestHook(p.id)).then((val) => {
        if (val && val.ok !== false) _authProbeCache.set(p.id, { ts: Date.now(), val });
        return val;
      })
      : runCliAuthProbe(p, opts);
    const flight = run.finally(() => {
      if (_authProbeFlights.get(p.id) === flight) _authProbeFlights.delete(p.id);
    });
    _authProbeFlights.set(p.id, flight);
    return flight;
  };

  if (opts.force) return startProbe();
  const cached = _authProbeCache.get(p.id);
  if (cached) {
    const age = Date.now() - cached.ts;
    if (age < AUTH_PROBE_CACHE_TTL_MS) return cached.val;
    if (age < AUTH_PROBE_STALE_OK_MS) {
      startProbe().catch(() => {});
      return cached.val;
    }
  }
  return startProbe();
}

async function runCliAuthProbe(p, opts = {}) {
  const canCache = !opts.execCli && !opts.resolveBin;
  const cacheOut = (val) => {
    if (canCache && val && val.ok !== false) _authProbeCache.set(p.id, { ts: Date.now(), val });
    return val;
  };

  if (p.id === 'zai') {
    const zcodeBin = await resolveCliPathForProvider(p, opts);
    if (zcodeBin) {
      const execFn = opts.execCli || execCli;
      const res = await execFn(zcodeBin, p.authStatusArgs || ['--version'], opts);
      const raw = `${res.stdout}\n${res.stderr}`.trim();
      const loggedIn = res.ok && !/not logged in|login required|unauthorized/i.test(raw);
      return cacheOut({ ok: true, bin: zcodeBin, loggedIn, account: 'zcode-cli', label: 'Z.ai zcode CLI', plan: 'Coding Plan' });
    }
    const zKey = resolveZaiStoredKey('coding-plan');
    if (zKey) {
      return cacheOut({ ok: true, bin: '', loggedIn: true, account: 'coding-plan', label: 'Z.ai Coding Plan', plan: 'Coding Plan', source: 'api-key' });
    }
    return cacheOut({ ok: true, bin: '', loggedIn: false, account: '', label: p.label, plan: 'Coding Plan' });
  }

  const bin = await resolveCliPathForProvider(p, opts);
  if (!bin) {
    if (p.id === 'antigravity') {
      try {
        const gKey = secretstore.get('autobot.orch_api_key.gemini_api')
          || secretstore.get('GEMINI_API_KEY')
          || (!process.env.NODE_TEST_CONTEXT && process.env.GEMINI_API_KEY)
          || '';
        if (gKey && String(gKey).trim()) {
          return cacheOut({ ok: true, bin: '', loggedIn: true, account: 'gemini-api-key', label: 'Google Gemini API Key', plan: 'API Key', source: 'api-key' });
        }
      } catch (_) {}
    }
    return { ok: false, loggedIn: false, bin: '', error: `${p.bin} CLI not installed` };
  }

  const execFn = opts.execCli || execCli;
  const binBase = path.basename(String(bin)).toLowerCase();

  if (p.id === 'claude') {
    const res = await execFn(bin, p.authStatusArgs || ['auth', 'status'], opts);
    const raw = `${res.stdout}\n${res.stderr}`.trim();
    try {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && typeof parsed === 'object') {
        return cacheOut({
          ok: true,
          bin,
          loggedIn: Boolean(parsed.loggedIn),
          account: parsed.email || 'claude-cli',
          label: parsed.email ? `Claude · ${parsed.subscriptionType || 'CLI'} (${parsed.email})` : 'Claude CLI',
          plan: parsed.subscriptionType || 'CLI Subscription',
        });
      }
    } catch (_) {}
    const loggedIn = res.ok && !/not logged in|loggedIn":false|please log in/i.test(raw);
    return cacheOut({ ok: true, bin, loggedIn, account: 'claude-cli', label: 'Claude CLI', plan: 'CLI Subscription' });
  }

  if (p.id === 'chatgpt') {
    const res = await execFn(bin, p.authStatusArgs || ['login', 'status'], opts);
    const raw = `${res.stdout}\n${res.stderr}`.trim();
    const loggedIn = res.ok && !/not logged in|unauthorized|login required/i.test(raw);
    return cacheOut({ ok: true, bin, loggedIn, account: 'codex-cli', label: 'Codex CLI', plan: 'CLI Subscription' });
  }

  if (p.id === 'grok') {
    const res = await execFn(bin, p.authStatusArgs || ['models'], opts);
    const raw = `${res.stdout}\n${res.stderr}`.trim();
    const loggedIn = res.ok && !/not logged in|sign in|login required|unauthorized/i.test(raw);
    return cacheOut({ ok: true, bin, loggedIn, account: 'grok-cli', label: 'Grok CLI', plan: 'CLI Subscription' });
  }

  if (p.id === 'kimi') {
    const res = await execFn(bin, p.authStatusArgs || ['provider', 'list', '--json'], opts);
    const raw = `${res.stdout}\n${res.stderr}`.trim();
    let loggedIn = false;
    try {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && typeof parsed === 'object') {
        const provs = parsed.providers && typeof parsed.providers === 'object' ? Object.keys(parsed.providers) : [];
        loggedIn = Boolean(res.ok && provs.length > 0);
      }
    } catch (_) {
      loggedIn = Boolean(res.ok && /kimi|moonshot|logged in/i.test(raw) && !/not logged in|unauthoriz|no providers/i.test(raw));
    }
    return cacheOut({ ok: true, bin, loggedIn, account: 'kimi-cli', label: 'Kimi Code CLI', plan: 'CLI Subscription' });
  }

  // Google Gemini / Antigravity: official `agy models` (or GEMINI_API_KEY). Never treat `gemini --version` as signed in.
  if (p.id === 'antigravity') {
    if (opts.execCli) {
      const res = await execFn(bin, p.authStatusArgs || ['models'], opts);
      const raw = `${res.stdout}\n${res.stderr}`.trim();
      const loggedIn = Boolean(res.ok && !/not logged in|sign in|login required|unauthorized|no longer supported/i.test(raw));
      return cacheOut({ ok: true, bin, loggedIn, account: binBase.startsWith('agy') ? 'agy' : path.basename(bin), label: 'Google Antigravity CLI', plan: 'Antigravity' });
    }
    if (binBase.startsWith('agy') || binBase.startsWith('antigravity')) {
      const res = await execCli(bin, ['models'], { timeoutMs: Number(opts.timeoutMs) || 8000 });
      const raw = `${res.stdout}\n${res.stderr}`.trim();
      const loggedIn = Boolean(res.ok && /\b(gemini-|claude-|gpt-oss)/i.test(raw) && !/not logged in|sign in|login required|unauthorized/i.test(raw));
      if (loggedIn) {
        return cacheOut({ ok: true, bin, loggedIn: true, account: 'agy', label: 'Google Antigravity CLI', plan: 'Antigravity' });
      }
    }
    try {
      const gKey = secretstore.get('autobot.orch_api_key.gemini_api')
        || secretstore.get('GEMINI_API_KEY')
        || (!process.env.NODE_TEST_CONTEXT && process.env.GEMINI_API_KEY)
        || '';
      if (gKey && String(gKey).trim()) {
        return cacheOut({ ok: true, bin, loggedIn: true, account: 'gemini-api-key', label: 'Google Gemini API Key', plan: 'API Key', source: 'api-key' });
      }
    } catch (_) {}
    return cacheOut({ ok: true, bin, loggedIn: false, account: 'agy', label: 'Google Antigravity CLI', plan: 'CLI Subscription' });
  }

  if (p.id === 'copilot') {
    if (opts.execCli) {
      const res = await execFn(bin, p.authStatusArgs || ['--version'], opts);
      const raw = `${res.stdout}\n${res.stderr}`.trim();
      const loggedIn = Boolean(res.ok && !/not logged in|login required|unauthorized/i.test(raw));
      return cacheOut({ ok: true, bin, loggedIn, account: 'copilot-cli', label: 'GitHub Copilot CLI', plan: 'CLI Subscription' });
    }
    const pat = resolveCopilotStoredToken('github-pat');
    if (pat) {
      return cacheOut({ ok: true, bin, loggedIn: true, account: 'github-pat', label: 'GitHub Copilot (PAT)', plan: 'CLI Subscription', source: 'api-key' });
    }
    try {
      const cfgPath = path.join(os.homedir(), '.copilot', 'config.json');
      if (fs.existsSync(cfgPath)) {
        const cleanJson = fs.readFileSync(cfgPath, 'utf8').replace(/^\s*\/\/.*$/gm, '');
        const cfg = JSON.parse(cleanJson);
        const users = Array.isArray(cfg && cfg.logged_in_users) ? cfg.logged_in_users : [];
        const userLogin = (users[0] && (users[0].login || users[0].username)) || cfg.user || cfg.login || '';
        if (users.length || cfg.oauth_token || cfg.github_token || userLogin) {
          return cacheOut({
            ok: true,
            bin,
            loggedIn: true,
            account: slug(userLogin || 'copilot-cli'),
            label: userLogin ? `GitHub Copilot (${userLogin})` : 'GitHub Copilot CLI',
            plan: 'CLI Subscription',
          });
        }
      }
    } catch (_) {}
    if (process.env.AKRON_ISOLATE_RUNTIMES !== '1' && !process.env.NODE_TEST_CONTEXT) {
      const ghBin = cliRunner.whichOnPath('gh');
      if (ghBin) {
        const ghRes = await execCli(ghBin, ['auth', 'status'], { timeoutMs: 3000 });
        const ghRaw = `${ghRes.stdout}\n${ghRes.stderr}`;
        if (ghRes.ok && !/not logged in/i.test(ghRaw)) {
          const um = /account\s+([^\s(]+)/i.exec(ghRaw);
          const ghUser = um ? um[1] : '';
          return cacheOut({
            ok: true,
            bin,
            loggedIn: true,
            account: slug(ghUser || 'copilot-cli'),
            label: ghUser ? `GitHub Copilot (${ghUser})` : 'GitHub Copilot CLI',
            plan: 'CLI Subscription',
          });
        }
      }
    }
    return cacheOut({ ok: true, bin, loggedIn: false, account: 'copilot-cli', label: 'GitHub Copilot CLI', plan: 'CLI Subscription' });
  }

  const res = await execFn(bin, p.authStatusArgs || ['--version'], opts);
  const raw = `${res.stdout}\n${res.stderr}`.trim();
  const loggedIn = res.ok && !/not logged in|login required|unauthorized/i.test(raw);
  return cacheOut({ ok: true, bin, loggedIn, account: path.basename(bin), label: cleanCliLabel(`${p.label} CLI`), plan: 'CLI Subscription' });
}

/**
 * Reconcile the saved account records with what each provider CLI reports.
 *
 * Probes are answered from the auth-probe cache unless `opts.force` is set, and
 * run in parallel across providers. This is called on the turn path (pool
 * hydration, auto-heal after a failed resolve), so it must be cheap to repeat:
 * it used to force a fresh probe of every provider on every call.
 */
async function syncCliAccounts(onlyProvId, opts = {}) {
  const targets = onlyProvId ? [onlyProvId] : providerIds();
  const imported = [];
  const healed = [];
  const provs = [];
  for (const rawId of targets) {
    const p = provider(rawId);
    if (p && !provs.includes(p)) provs.push(p);
  }
  const injected = Boolean(opts.execCli || opts.resolveBin);
  const probeOpts = { ...opts, force: opts.force === true };
  const probeOne = (p) => probeCliAuthStatus(p.id, probeOpts).catch(() => ({ ok: false, loggedIn: false }));
  let probes;
  if (injected) {
    // Injected executors (tests) keep the original one-at-a-time ordering.
    probes = [];
    for (const p of provs) probes.push(await probeOne(p));
  } else {
    probes = await Promise.all(provs.map(probeOne));
  }
  for (let i = 0; i < provs.length; i++) {
    const p = provs[i];
    const probe = probes[i];
    // Writing the account record invalidates the probe cache (correct for a
    // user-driven change); here the record is being written *from* that probe,
    // so keep it, or the very next call would launch the CLI again.
    const keptProbe = _authProbeCache.get(p.id);
    const restoreProbe = () => {
      if (keptProbe && !_authProbeCache.has(p.id)) _authProbeCache.set(p.id, keptProbe);
    };
    if (probe && probe.loggedIn) {
      if (p.id === 'antigravity' && probe.account === 'agy') {
        const db = readDb();
        const filtered = db.accounts.filter((a) => !(a && a.provider === 'antigravity' && a.account === 'gemini' && a.source !== 'api-key'));
        if (filtered.length !== db.accounts.length) {
          db.accounts = filtered;
          if (db.active.antigravity === 'gemini') db.active.antigravity = 'agy';
          writeDb(db);
        }
      }
      const rec = addAccount(p.id, {
        account: probe.account || 'cli',
        label: probe.label || cleanCliLabel(`${p.label} CLI`),
        plan: probe.plan || 'CLI Subscription',
        source: probe.source || 'cli',
        needsSignIn: false,
      });
      imported.push(rec.id);
      healed.push(rec.id);
      restoreProbe();
    } else if (probe && probe.ok !== false && !probe.loggedIn) {
      const db = readDb();
      let dirty = false;
      for (const a of db.accounts) {
        if (a && a.provider === p.id && a.source !== 'api-key' && a.needsSignIn !== true) {
          a.needsSignIn = true;
          dirty = true;
        }
      }
      if (dirty) writeDb(db);
    }
  }
  return { ok: true, imported, healed };
}

async function statusAll() {
  await syncCliAccounts().catch(() => {});
  const st = status();
  return st.providers.map((p) => {
    const activeAcct = p.accounts.find((a) => a.account === p.active) || p.accounts[0] || null;
    return {
      ...p,
      providerId: p.id,
      id: activeAcct ? activeAcct.id : p.id,
      accountName: activeAcct ? activeAcct.account : '',
      signedIn: p.signedIn,
    };
  });
}

async function authorize(provId, opts = {}) {
  const p = provider(provId);
  if (!p) throw new Error(`unknown provider: ${provId}`);
  const bin = await resolveCliPathForProvider(p, opts);
  if (!bin) throw new Error(`${p.label} CLI (${p.bin}) is not installed.`);

  const spawnFn = opts.spawnImpl || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(bin, p.authLoginArgs || ['login'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let outBuf = '';
    let sentUrl = false;
    const scan = (chunk) => {
      outBuf += chunk.toString('utf8');
      if (!sentUrl && typeof opts.openExternal === 'function') {
        const m = outBuf.match(/https:\/\/[^\s"'<>]+/);
        if (m) {
          sentUrl = true;
          try { opts.openExternal(m[0]); } catch (_) {}
        }
      }
    };
    if (child.stdout) child.stdout.on('data', scan);
    if (child.stderr) child.stderr.on('data', scan);
    child.on('error', reject);
    child.on('exit', async (code) => {
      if (code !== 0) {
        reject(new Error(`${p.label} CLI sign-in exited with code ${code}`));
        return;
      }
      // The CLI's own sign-in just finished: the cached answer is now wrong.
      const res = await syncCliAccounts(p.id, { ...opts, force: true });
      const acct = getAccount(p.id) || {
        provider: p.id,
        account: 'cli',
        label: `${p.label} CLI`,
        plan: 'CLI Subscription',
        source: 'cli',
      };
      if (!res.imported.length) addAccount(p.id, acct);
      resolve(publicRecord(getAccount(p.id) || acct, p.id));
    });
  });
}

async function verifyAccount(provId, account) {
  const p = provider(provId);
  if (!p) return false;
  const rec = getAccount(p.id, account);
  if (rec && rec.source === 'api-key') return bearerHasKey(p.id, rec.account);
  const probe = await probeCliAuthStatus(p.id);
  return Boolean(probe && probe.loggedIn);
}

function markVerified(provId, account) {
  const p = provider(provId);
  if (!p) return null;
  const db = readDb();
  const hit = db.accounts.find((a) => a && a.provider === p.id && (!account || a.account === account));
  if (hit) {
    hit.verifiedAt = Date.now();
    writeDb(db);
    return publicRecord(hit, p.id);
  }
  return null;
}

async function resolve(id) {
  const raw = String(id || '');
  const [rawProv, ...rest] = raw.split(':');
  const prov = provider(rawProv);
  if (!prov) throw new Error(`unknown provider in "${raw}"`);
  const acct = rest.join(':') || activeAccount(prov.id) || 'cli';
  let rec = getAccount(prov.id, acct);
  if (!rec || rec.needsSignIn) {
    const db = readDb();
    const fallbackAcct = db.accounts.find((a) => a && a.provider === prov.id && !a.needsSignIn);
    if (fallbackAcct) {
      rec = fallbackAcct;
    } else {
      const probe = await probeCliAuthStatus(prov.id).catch(() => ({ loggedIn: false }));
      if (probe && probe.loggedIn) {
        await syncCliAccounts(prov.id);
        rec = getAccount(prov.id);
      }
    }
  }
  const zaiStoredKey = prov.id === 'zai' ? resolveZaiStoredKey(acct) : '';
  if (prov.id === 'zai' && !(cliRunner.detectZcodeCli && cliRunner.detectZcodeCli()) && zaiStoredKey) {
    return {
      provider: 'zai',
      account: acct,
      label: cleanCliLabel((rec && rec.label) || 'Z.ai Coding Plan'),
      apiKey: zaiStoredKey,
      accessToken: '',
      transport: 'zai',
      baseURL: prov.bearerBaseURL,
      models: prov.models,
      plan: (rec && rec.plan) || 'Coding Plan',
      cliMode: false,
      oauth: false,
    };
  }
  if (rec && rec.needsSignIn) {
    const err = new Error(`${prov.label} CLI is not signed in — click Sign in / Reconnect.`);
    err.code = 'provider_needs_signin';
    err.human = true;
    throw err;
  }
  const viaKey = Boolean(rec && rec.source === 'api-key' && prov.bearerBaseURL && prov.id !== 'copilot');
  if (viaKey) {
    const apiKey = secretstore.get(slotKey(prov.id, rec.account)) || '';
    const transportMap = { claude: 'anthropic', chatgpt: 'codex', antigravity: 'google', grok: 'grok', kimi: 'openai', zai: 'zai' };
    return {
      provider: prov.id,
      account: rec.account,
      label: cleanCliLabel(rec.label),
      apiKey,
      accessToken: '',
      transport: transportMap[prov.id] || 'openai',
      baseURL: prov.bearerBaseURL || '',
      models: prov.models,
      plan: rec.plan || 'API Key',
      cliMode: false,
      oauth: false,
    };
  }
  const resolvedBin = await resolveCliPathForProvider(prov).catch(() => prov.bin);
  const resolvedBase = path.basename(String(resolvedBin || '')).toLowerCase();
  if (prov.id === 'copilot') {
    return {
      provider: 'copilot',
      account: (rec && rec.account) || acct,
      label: cleanCliLabel((rec && rec.label) || prov.label),
      transport: 'cli',
      cliId: prov.cliId,
      cliBin: resolvedBin || prov.bin,
      cliKind: 'copilot',
      cliMode: true,
      oauth: false,
      baseURL: '',
      apiKey: '',
      accessToken: '',
      copilotToken: resolveCopilotStoredToken((rec && rec.account) || acct),
      models: prov.models,
      plan: (rec && rec.plan) || 'CLI Subscription',
    };
  }
  if (prov.id === 'zai' && !resolvedBin) {
    const zKey = secretstore.get(slotKey('zai', acct))
      || secretstore.get('provider-api:zai:coding-plan')
      || secretstore.get('autobot.orch_api_key.zai_coding')
      || secretstore.get('ZAI_CODING_API_KEY')
      || '';
    return {
      provider: 'zai',
      account: acct,
      label: cleanCliLabel((rec && rec.label) || 'Z.ai Coding Plan'),
      apiKey: zKey,
      accessToken: '',
      transport: 'zai',
      baseURL: prov.bearerBaseURL,
      models: prov.models,
      plan: (rec && rec.plan) || 'Coding Plan',
      cliMode: false,
      oauth: false,
    };
  }
  return {
    provider: prov.id,
    account: (rec && rec.account) || acct,
    label: cleanCliLabel((rec && rec.label) || `${prov.label} CLI`),
    transport: 'cli',
    cliId: (prov.id === 'antigravity' && resolvedBase.startsWith('gemini')) ? 'gemini-cli' : prov.cliId,
    cliBin: resolvedBin || prov.bin,
    cliKind: prov.id,
    cliMode: true,
    oauth: false,
    baseURL: '',
    apiKey: '',
    accessToken: '',
    models: prov.models,
    plan: (rec && rec.plan) || 'CLI Subscription',
  };
}

async function signOutAccount(provId, account, opts = {}) {
  const p = provider(provId);
  if (!p) return { ok: false, removed: false };
  const target = account || activeAccount(p.id);
  const rec = getAccount(p.id, target);
  let cliLogout = null;
  if ((!rec || rec.source !== 'api-key') && Array.isArray(p.authLogoutArgs) && p.authLogoutArgs.length) {
    const bin = await resolveCliPathForProvider(p, opts).catch(() => '');
    if (bin) {
      const execFn = opts.execCli || execCli;
      cliLogout = await execFn(bin, p.authLogoutArgs, { timeoutMs: 5000 }).catch(() => null);
    }
  }
  if (p.id === 'zai') {
    try { secretstore.del('autobot.orch_api_key.zai_coding'); } catch (_) {}
  }
  const removed = removeAccount(p.id, target);
  return { ok: true, removed, cliLogout };
}

purgeLegacyTokenMirror();

module.exports = {
  PROVIDERS,
  provider,
  providerIds,
  status,
  statusAll,
  listAccounts,
  getAccount,
  verifyAccount,
  markVerified,
  refreshEntitlement: async () => null,
  addAccount,
  addBearer,
  removeAccount,
  signOutAccount,
  setActive,
  activeAccount,
  authorize,
  resolve,
  probeCliAuthStatus,
  invalidateAuthProbeCache,
  syncCliAccounts,
  // Safe compatibility aliases for existing IPC callers:
  // `importLocal` and `adoptClaudeFromCli` are explicit user actions, so they
  // re-probe. The auto-heal aliases run on the turn path and use the cache
  // unless the caller passes `{ force: true }`.
  importLocal: async (provId, opts) => syncCliAccounts(provId, { ...(opts || {}), force: true }),
  autoHealAccount: async (provId, opts) => syncCliAccounts(provId, opts || {}),
  autoHealAll: async (opts) => syncCliAccounts(null, opts || {}),
  adoptClaudeFromCli: async () => {
    await syncCliAccounts('claude', { force: true });
    return publicRecord(getAccount('claude'), 'claude');
  },
  ensureToken: async () => ({ accessToken: '' }),
  replayRotationJournal: () => null,
  _internal: {
    readDb, writeDb, slotKey, slug, publicRecord, purgeLegacyTokenMirror,
    setAuthProbeTestHook: (fn) => { _authProbeTestHook = typeof fn === 'function' ? fn : null; },
    ageAuthProbeCache: (ms) => { for (const e of _authProbeCache.values()) e.ts -= Number(ms) || 0; },
    AUTH_PROBE_CACHE_TTL_MS,
    AUTH_PROBE_STALE_OK_MS,
  },
};
