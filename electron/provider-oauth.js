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
    label: 'Google Gemini / Antigravity CLI',
    vendor: 'Google',
    kind: 'cli',
    transport: 'cli',
    cliId: 'gemini-cli',
    bin: 'gemini',
    fallbackBins: ['agy'],
    authLoginArgs: [],
    authStatusArgs: ['--version'],
    authLogoutArgs: [],
    allowBearer: true,
    bearerBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
    models: [
      { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', contextWindow: 1048576 },
      { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', contextWindow: 1048576 },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', contextWindow: 1048576 },
      { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', contextWindow: 1048576 },
      { id: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite', contextWindow: 1048576 },
    ],
    docs: 'https://ai.google.dev/gemini-api/docs',
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

function bearerHasKey(provId, account) {
  try {
    const raw = secretstore.get(slotKey(provId, account));
    return Boolean(raw && String(raw).trim());
  } catch (_) {
    return false;
  }
}

function publicRecord(rec, provId) {
  if (!rec) return null;
  const prov = provider(provId || rec.provider);
  const pid = (prov && prov.id) || rec.provider;
  const acct = String(rec.account || 'cli');
  const isBearer = rec.source === 'api-key';
  const hasKey = isBearer ? bearerHasKey(pid, acct) : true;
  return {
    id: `${pid}:${acct}`,
    provider: pid,
    account: acct,
    label: rec.label || (prov ? prov.label : pid),
    plan: rec.plan || (isBearer ? 'API Key' : 'CLI Subscription'),
    source: rec.source || 'cli',
    needsSignIn: !hasKey,
    hasToken: hasKey,
    cliMode: !isBearer,
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
    label: info.label || `${p.label} · ${account}`,
    plan: info.plan || 'CLI Subscription',
    source: info.source || 'cli',
    addedAt: (idx >= 0 && db.accounts[idx].addedAt) || Date.now(),
    verifiedAt: info.verifiedAt || Date.now(),
  };
  if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...entry };
  else db.accounts.push(entry);
  if (!db.active[p.id]) db.active[p.id] = account;
  writeDb(db);
  return publicRecord(entry, p.id);
}

async function addBearer(id, key, opts = {}) {
  const [rawProv, ...rest] = String(id || '').split(':');
  const p = provider(rawProv);
  if (!p) throw new Error(`unknown provider: ${id}`);
  const cleanKey = String(key || '').trim();
  if (!cleanKey) throw new Error('API key is required');
  const account = slug(rest.join(':') || opts.account || (p.id === 'zai' ? 'coding-plan' : 'api-key'));
  secretstore.set(slotKey(p.id, account), cleanKey);
  if (p.id === 'zai') {
    try { secretstore.set('autobot.orch_api_key.zai_coding', cleanKey); } catch (_) {}
  }
  return addAccount(p.id, {
    account,
    label: opts.label || (p.id === 'zai' ? 'Z.ai Coding Plan Key' : `${p.label} API Key`),
    plan: p.id === 'zai' ? 'Coding Plan' : 'API Key',
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
      signedIn: accts.some((a) => a && a.hasToken),
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

async function probeCliAuthStatus(provId, opts = {}) {
  const p = provider(provId);
  if (!p) return { ok: false, loggedIn: false, error: `unknown provider ${provId}` };

  if (p.id === 'zai') {
    const zcodeBin = await resolveCliPathForProvider(p, opts);
    if (zcodeBin) {
      const execFn = opts.execCli || execCli;
      const res = await execFn(zcodeBin, p.authStatusArgs || ['--version'], opts);
      const raw = `${res.stdout}\n${res.stderr}`.trim();
      const loggedIn = res.ok && !/not logged in|login required|unauthorized/i.test(raw);
      return { ok: true, bin: zcodeBin, loggedIn, account: 'zcode-cli', label: 'Z.ai zcode CLI', plan: 'Coding Plan' };
    }
    try {
      const key = secretstore.get('autobot.orch_api_key.zai_coding') || secretstore.get('ZAI_CODING_API_KEY') || '';
      if (key && String(key).trim()) {
        return { ok: true, bin: '', loggedIn: true, account: 'coding-plan', label: 'Z.ai Coding Plan', plan: 'Coding Plan', source: 'api-key' };
      }
    } catch (_) {}
    return { ok: true, bin: '', loggedIn: false, account: '', label: p.label, plan: 'Coding Plan' };
  }

  const bin = await resolveCliPathForProvider(p, opts);
  if (!bin) return { ok: false, loggedIn: false, bin: '', error: `${p.bin} CLI not installed` };

  const execFn = opts.execCli || execCli;
  const res = await execFn(bin, p.authStatusArgs || ['--version'], opts);
  const raw = `${res.stdout}\n${res.stderr}`.trim();

  if (p.id === 'claude') {
    try {
      const parsed = JSON.parse(res.stdout.trim());
      if (parsed && typeof parsed === 'object') {
        return {
          ok: true,
          bin,
          loggedIn: Boolean(parsed.loggedIn),
          account: parsed.email || 'claude-cli',
          label: parsed.email ? `Claude · ${parsed.subscriptionType || 'CLI'} (${parsed.email})` : 'Claude CLI',
          plan: parsed.subscriptionType || 'CLI Subscription',
        };
      }
    } catch (_) {}
    const loggedIn = res.ok && !/not logged in|loggedIn":false|please log in/i.test(raw);
    return { ok: true, bin, loggedIn, account: 'claude-cli', label: 'Claude CLI', plan: 'CLI Subscription' };
  }

  if (p.id === 'chatgpt') {
    const loggedIn = res.ok && !/not logged in|unauthorized|login required/i.test(raw);
    return { ok: true, bin, loggedIn, account: 'codex-cli', label: 'Codex CLI', plan: 'CLI Subscription' };
  }

  if (p.id === 'grok') {
    const loggedIn = res.ok && !/not logged in|sign in|login required|unauthorized/i.test(raw);
    return { ok: true, bin, loggedIn, account: 'grok-cli', label: 'Grok CLI', plan: 'CLI Subscription' };
  }

  if (p.id === 'kimi') {
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
    return { ok: true, bin, loggedIn, account: 'kimi-cli', label: 'Kimi Code CLI', plan: 'CLI Subscription' };
  }

  // Gemini / Antigravity CLI
  const loggedIn = res.ok && !/not logged in|login required|unauthorized/i.test(raw);
  return { ok: true, bin, loggedIn, account: path.basename(bin), label: `${p.label} CLI`, plan: 'CLI Subscription' };
}

async function syncCliAccounts(onlyProvId, opts = {}) {
  const targets = onlyProvId ? [onlyProvId] : providerIds();
  const imported = [];
  const healed = [];
  for (const rawId of targets) {
    const p = provider(rawId);
    if (!p) continue;
    const probe = await probeCliAuthStatus(p.id, opts).catch(() => ({ ok: false, loggedIn: false }));
    if (probe && probe.loggedIn) {
      const rec = addAccount(p.id, {
        account: probe.account || 'cli',
        label: probe.label || `${p.label} CLI`,
        plan: probe.plan || 'CLI Subscription',
        source: 'cli',
      });
      imported.push(rec.id);
      healed.push(rec.id);
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
      const res = await syncCliAccounts(p.id, opts);
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
  if (!rec) {
    const probe = await probeCliAuthStatus(prov.id).catch(() => ({ loggedIn: false }));
    if (probe && probe.loggedIn) {
      await syncCliAccounts(prov.id);
      rec = getAccount(prov.id);
    }
  }
  const viaKey = Boolean(rec && rec.source === 'api-key' && prov.bearerBaseURL);
  if (viaKey) {
    const apiKey = secretstore.get(slotKey(prov.id, rec.account)) || '';
    const transportMap = { claude: 'anthropic', chatgpt: 'codex', antigravity: 'google', grok: 'grok', kimi: 'openai', zai: 'zai' };
    return {
      provider: prov.id,
      account: rec.account,
      label: rec.label,
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
  if (prov.id === 'zai' && !resolvedBin) {
    const zKey = secretstore.get(slotKey('zai', acct)) || secretstore.get('autobot.orch_api_key.zai_coding') || '';
    return {
      provider: 'zai',
      account: acct,
      label: (rec && rec.label) || 'Z.ai Coding Plan',
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
    label: (rec && rec.label) || `${prov.label} CLI`,
    transport: 'cli',
    cliId: prov.cliId,
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
  syncCliAccounts,
  // Safe compatibility aliases for existing IPC callers:
  importLocal: syncCliAccounts,
  autoHealAccount: async (provId) => syncCliAccounts(provId),
  autoHealAll: async (opts) => syncCliAccounts(null, opts),
  adoptClaudeFromCli: async () => {
    await syncCliAccounts('claude');
    return publicRecord(getAccount('claude'), 'claude');
  },
  ensureToken: async () => ({ accessToken: '' }),
  replayRotationJournal: () => null,
  _internal: { readDb, writeDb, slotKey, slug, publicRecord, purgeLegacyTokenMirror },
};
