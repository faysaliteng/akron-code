'use strict';
/**
 * Paradev (Superset) Raw API & Cloud Workspace / Voice / Task Client.
 *
 * Uses documented/sanctioned `@superset_sh/sdk` & SuperJSON tRPC wire protocol
 * against `https://api.paradev.com/api/trpc/<procedure>` (or `api.superset.sh`).
 *
 * Sanctioned Credential Sources (strictly in order, NEVER reads auth-token.enc):
 *   1. Akron SecretStore (`paradev:apiKey` / `paradev:orgId` / `paradev:baseURL`)
 *   2. Environment variables (`PARADEV_API_KEY`, `SUPERSET_API_KEY`, `PARADEV_ORGANIZATION_ID`, `SUPERSET_ORGANIZATION_ID`)
 *   3. Standard CLI config JSON (`~/.paradev/config.json` or `~/.superset/config.json`) if written by `paradev login`
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_BASE_URL = 'https://api.paradev.com';
const FALLBACK_BASE_URL = 'https://api.superset.sh';
const DOCS_MCP_URL = 'https://docs.paradev.com/mcp';
const PARADEV_MCP_URL = 'https://api.paradev.com/mcp';

const SECRET_KEYS = {
  apiKey: 'paradev:apiKey',
  orgId: 'paradev:orgId',
  baseURL: 'paradev:baseURL',
};

function cleanBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  return s || DEFAULT_BASE_URL;
}

function encodeSuperJson(value) {
  if (value === undefined) return { json: null };
  return { json: value };
}

function decodeSuperJson(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (payload.result && payload.result.data !== undefined) {
    const d = payload.result.data;
    if (d && typeof d === 'object' && 'json' in d) return d.json;
    return d;
  }
  if ('json' in payload && Object.keys(payload).length <= 2) return payload.json;
  return payload;
}

function readCliConfigFiles() {
  const home = os.homedir();
  const candidates = [
    path.join(home, '.paradev', 'config.json'),
    path.join(home, '.superset', 'config.json'),
  ];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (parsed && typeof parsed === 'object') return { ...parsed, _path: p };
    } catch (_) {}
  }
  return null;
}

function detectLocalInstall() {
  const appExists = process.platform === 'darwin'
    ? fs.existsSync('/Applications/Paradev.app')
    : false;
  const pdevBins = [
    '/Applications/Paradev.app/Contents/Resources/resources/bin/pdev/pdev',
    path.join(os.homedir(), '.paradev', 'bin', 'pdev'),
    path.join(os.homedir(), '.superset', 'bin', 'superset'),
  ];
  const pdevPath = pdevBins.find((b) => { try { return fs.existsSync(b); } catch (_) { return false; } }) || '';
  const paradevHome = fs.existsSync(path.join(os.homedir(), '.paradev'))
    ? path.join(os.homedir(), '.paradev')
    : (fs.existsSync(path.join(os.homedir(), '.superset')) ? path.join(os.homedir(), '.superset') : '');
  const desktopDbExists = Boolean(paradevHome && fs.existsSync(path.join(paradevHome, 'local.db')));
  return {
    appInstalled: appExists,
    pdevPath,
    paradevHome,
    desktopSessionPresent: Boolean(paradevHome && fs.existsSync(path.join(paradevHome, 'auth-token.enc'))),
    desktopDbExists,
  };
}

function resolveCredentials({ secretstore = null, env = process.env, explicit = null } = {}) {
  let ss = secretstore;
  if (!ss && secretstore !== false) {
    try { ss = require('./secretstore'); } catch (_) { ss = null; }
  }
  const getSecret = (k) => {
    if (!ss || typeof ss.get !== 'function') return '';
    try { return String(ss.get(k) || '').trim(); } catch (_) { return ''; }
  };

  const cliCfg = readCliConfigFiles();
  let apiKey = String((explicit && explicit.apiKey) || '').trim();
  let source = apiKey ? 'explicit' : '';

  if (!apiKey) {
    const s = getSecret(SECRET_KEYS.apiKey);
    if (s) { apiKey = s; source = 'secretstore'; }
  }
  if (!apiKey && env) {
    const e = String(env.PARADEV_API_KEY || env.SUPERSET_API_KEY || '').trim();
    if (e) { apiKey = e; source = 'env'; }
  }
  if (!apiKey && cliCfg) {
    const k = String(cliCfg.apiKey || (cliCfg.auth && cliCfg.auth.accessToken) || '').trim();
    if (k) { apiKey = k; source = 'cli-config'; }
  }

  const organizationId = String(
    (explicit && explicit.organizationId)
    || getSecret(SECRET_KEYS.orgId)
    || (env && (env.PARADEV_ORGANIZATION_ID || env.SUPERSET_ORGANIZATION_ID))
    || (cliCfg && cliCfg.organizationId)
    || ''
  ).trim();

  const baseURL = cleanBaseUrl(
    (explicit && explicit.baseURL)
    || getSecret(SECRET_KEYS.baseURL)
    || (env && (env.PARADEV_API_URL || env.SUPERSET_API_URL))
    || DEFAULT_BASE_URL
  );

  return {
    configured: Boolean(apiKey),
    apiKey,
    organizationId,
    baseURL,
    source,
    keyPreview: apiKey ? `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}` : '',
  };
}

function saveConfig({ apiKey, organizationId, baseURL } = {}, { secretstore = null } = {}) {
  const ss = secretstore || require('./secretstore');
  if (apiKey !== undefined) {
    const cleanKey = String(apiKey || '').trim();
    if (cleanKey) ss.set(SECRET_KEYS.apiKey, cleanKey);
    else if (typeof ss.del === 'function') ss.del(SECRET_KEYS.apiKey);
    else ss.set(SECRET_KEYS.apiKey, '');
  }
  if (organizationId !== undefined) {
    const cleanOrg = String(organizationId || '').trim();
    if (cleanOrg) ss.set(SECRET_KEYS.orgId, cleanOrg);
    else if (typeof ss.del === 'function') ss.del(SECRET_KEYS.orgId);
    else ss.set(SECRET_KEYS.orgId, '');
  }
  if (baseURL !== undefined) {
    const cleanUrl = String(baseURL || '').trim();
    if (cleanUrl) ss.set(SECRET_KEYS.baseURL, cleanBaseUrl(cleanUrl));
    else if (typeof ss.del === 'function') ss.del(SECRET_KEYS.baseURL);
    else ss.set(SECRET_KEYS.baseURL, '');
  }
  return resolveCredentials({ secretstore: ss });
}

function buildAuthHeaders(apiKey, extra = {}) {
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Akron-Code-Paradev-Bridge/1.0',
    ...extra,
  };
  const key = String(apiKey || '').trim();
  if (/^sk_(?:live|test)_/i.test(key)) {
    headers['x-api-key'] = key;
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function callTrpc(procedure, {
  method = 'GET',
  input = undefined,
  apiKey = '',
  organizationId = '',
  baseURL = '',
  fetchImpl = global.fetch,
  timeoutMs = 20000,
  signal = null,
} = {}) {
  const creds = (!apiKey || !baseURL) ? resolveCredentials({ explicit: { apiKey, organizationId, baseURL } }) : { apiKey, organizationId, baseURL: cleanBaseUrl(baseURL) };
  if (!creds.apiKey) {
    return { ok: false, status: 401, error: 'Paradev API key not configured. Create a Personal API Key (sk_live_…) in Paradev Settings and paste it here.' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch unavailable' };
  }

  const cleanProc = String(procedure || '').replace(/^\/+/, '');
  let url = `${creds.baseURL}/api/trpc/${cleanProc}`;
  const wirePayload = encodeSuperJson(input);
  const fetchOpts = {
    method: method === 'POST' ? 'POST' : 'GET',
    headers: buildAuthHeaders(creds.apiKey),
    signal: signal || AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 20000)),
  };

  if (fetchOpts.method === 'GET') {
    if (input !== undefined) {
      url += `?input=${encodeURIComponent(JSON.stringify(wirePayload))}`;
    }
  } else {
    fetchOpts.body = JSON.stringify(wirePayload);
  }

  try {
    const res = await fetchImpl(url, fetchOpts);
    const text = await res.text().catch(() => '');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
    if (!res.ok) {
      const msg = (parsed && parsed.error && (parsed.error.json?.message || parsed.error.message))
        || text.slice(0, 240)
        || `HTTP ${res.status}`;
      return { ok: false, status: res.status, error: String(msg), procedure: cleanProc };
    }
    return {
      ok: true,
      status: res.status,
      procedure: cleanProc,
      data: decodeSuperJson(parsed),
    };
  } catch (e) {
    return {
      ok: false,
      procedure: cleanProc,
      error: e && e.message ? e.message : String(e),
    };
  }
}

async function getStatus({ probeNetwork = false, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials();
  const local = detectLocalInstall();
  const out = {
    ok: true,
    ...creds,
    ...local,
    docsMcpUrl: DOCS_MCP_URL,
    paradevMcpUrl: PARADEV_MCP_URL,
    network: null,
  };
  if (probeNetwork && creds.configured) {
    const [planRes, modelRes] = await Promise.all([
      callTrpc('billing.activePlan', { method: 'GET', ...creds, fetchImpl, timeoutMs: 8000 }),
      callTrpc('chat.getModels', { method: 'GET', ...creds, fetchImpl, timeoutMs: 8000 }),
    ]);
    out.network = {
      reachable: Boolean(planRes.ok || modelRes.ok),
      plan: planRes.ok ? planRes.data : null,
      modelsCount: (modelRes.ok && modelRes.data && Array.isArray(modelRes.data.models)) ? modelRes.data.models.length : 0,
      error: (!planRes.ok && !modelRes.ok) ? (planRes.error || modelRes.error || 'Connection failed') : '',
    };
  }
  return out;
}

async function transcribeAudio({ audioBase64, mimeType = 'audio/wav', explicit = null, fetchImpl = global.fetch } = {}) {
  const b64 = String(audioBase64 || '').trim();
  if (!b64) return { ok: false, error: 'Missing base64 audio' };
  const creds = resolveCredentials({ explicit });
  if (!creds.configured) return { ok: false, error: 'Paradev API key not configured' };
  const res = await callTrpc('voice.transcribe', {
    method: 'POST',
    input: { audio: b64, mimeType },
    ...creds,
    fetchImpl,
    timeoutMs: 30000,
  });
  if (!res.ok) return res;
  const txt = res.data && typeof res.data.text === 'string' ? res.data.text.trim() : '';
  return txt
    ? { ok: true, text: txt, engine: 'paradev-voice' }
    : { ok: false, error: 'Empty transcription from Paradev' };
}

async function listWorkspaces({ organizationId, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  const orgId = String(organizationId || creds.organizationId || '').trim();
  return callTrpc('cloudWorkspace.list', {
    method: 'GET',
    input: orgId ? { organizationId: orgId } : {},
    ...creds,
    fetchImpl,
  });
}

async function createWorkspace({ organizationId, environment, name, agent = 'claude', prompt = '', explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  const orgId = String(organizationId || creds.organizationId || '').trim();
  return callTrpc('cloudWorkspace.create', {
    method: 'POST',
    input: {
      ...(orgId ? { organizationId: orgId } : {}),
      ...(environment ? { environment } : {}),
      ...(name ? { name } : {}),
      ...(agent ? { agent } : {}),
      ...(prompt ? { prompt } : {}),
    },
    ...creds,
    fetchImpl,
    timeoutMs: 30000,
  });
}

async function getWorkspace(workspaceId, { explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  return callTrpc('cloudWorkspace.byId', {
    method: 'GET',
    input: String(workspaceId || '').trim(),
    ...creds,
    fetchImpl,
  });
}

async function deleteWorkspace(workspaceId, { explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  return callTrpc('cloudWorkspace.delete', {
    method: 'POST',
    input: { workspaceId: String(workspaceId || '').trim() },
    ...creds,
    fetchImpl,
  });
}

async function listTasks(filter = {}, { explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  return callTrpc('task.list', {
    method: 'GET',
    input: filter && Object.keys(filter).length ? filter : undefined,
    ...creds,
    fetchImpl,
  });
}

async function createTask({ title, description, priority, statusId, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  if (!title) return { ok: false, error: 'Task title is required' };
  return callTrpc('task.create', {
    method: 'POST',
    input: {
      title: String(title).trim(),
      ...(description ? { description: String(description) } : {}),
      ...(priority ? { priority } : {}),
      ...(statusId ? { statusId } : {}),
    },
    ...creds,
    fetchImpl,
  });
}

async function updateTask({ id, title, description, priority, statusId, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  if (!id) return { ok: false, error: 'Task id is required' };
  return callTrpc('task.update', {
    method: 'POST',
    input: {
      id: String(id).trim(),
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(statusId !== undefined ? { statusId } : {}),
    },
    ...creds,
    fetchImpl,
  });
}

function getMcpServerPresets({ explicit = null } = {}) {
  const creds = resolveCredentials({ explicit });
  const list = [
    {
      name: 'paradev-docs',
      transport: 'http',
      url: DOCS_MCP_URL,
      headers: {},
      enabled: true,
    },
  ];
  if (creds.configured) {
    list.push({
      name: 'paradev',
      transport: 'http',
      url: `${creds.baseURL}/mcp`,
      headers: buildAuthHeaders(creds.apiKey),
      enabled: true,
    });
  }
  return list;
}

module.exports = {
  DEFAULT_BASE_URL,
  FALLBACK_BASE_URL,
  DOCS_MCP_URL,
  PARADEV_MCP_URL,
  SECRET_KEYS,
  cleanBaseUrl,
  encodeSuperJson,
  decodeSuperJson,
  detectLocalInstall,
  resolveCredentials,
  saveConfig,
  buildAuthHeaders,
  callTrpc,
  getStatus,
  transcribeAudio,
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  deleteWorkspace,
  listTasks,
  createTask,
  updateTask,
  getMcpServerPresets,
};
