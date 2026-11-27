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

function buildAuthHeaders(apiKeyOrCreds, extra = {}) {
  const isObj = apiKeyOrCreds && typeof apiKeyOrCreds === 'object';
  const key = String(isObj ? (apiKeyOrCreds.apiKey || '') : (apiKeyOrCreds || '')).trim();
  const orgId = String(isObj ? (apiKeyOrCreds.organizationId || '') : '').trim();
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'Akron-Code-Paradev-Bridge/1.0',
    ...(orgId ? { 'x-organization-id': orgId } : {}),
    ...extra,
  };
  if (/^sk_(?:live|test)_/i.test(key)) {
    headers['x-api-key'] = key;
  } else if (key) {
    headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

function parseMcpWirePayload(text, targetId = 1) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  if (/^data:/m.test(raw) || /\nevent:/m.test(raw)) {
    const frames = [];
    for (const block of raw.split(/\r?\n\r?\n/)) {
      const dataLines = [];
      for (const line of block.split(/\r?\n/)) {
        const t = line.trim();
        if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
      }
      const joined = dataLines.filter(Boolean).join('\n');
      if (!joined || joined === '[DONE]') continue;
      try { frames.push(JSON.parse(joined)); } catch (_) {}
    }
    if (!frames.length) return null;
    const byId = frames.find((f) => f && f.id === targetId && (f.result !== undefined || f.error !== undefined));
    return byId || frames.find((f) => f && (f.result !== undefined || f.error !== undefined)) || frames[frames.length - 1];
  }
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function callMcpTool(toolName, args = {}, {
  apiKey = '',
  organizationId = '',
  baseURL = '',
  explicit = null,
  fetchImpl = global.fetch,
  timeoutMs = 25000,
  signal = null,
} = {}) {
  const creds = resolveCredentials({
    explicit: explicit || (apiKey || baseURL ? { apiKey, organizationId, baseURL } : null),
  });
  if (!creds.configured) {
    return { ok: false, status: 401, error: 'Paradev API key not configured. Create a Personal API Key (sk_live_…) in Paradev Settings and paste it here.' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, error: 'fetch unavailable' };
  }
  const url = `${creds.baseURL}/mcp`;
  const rpcBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: String(toolName || '').trim(), arguments: args && typeof args === 'object' ? args : {} },
  };
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: buildAuthHeaders(creds, { accept: 'application/json, text/event-stream' }),
      body: JSON.stringify(rpcBody),
      signal: signal || AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 25000)),
    });
    const text = await res.text().catch(() => '');
    const msg = parseMcpWirePayload(text, 1);
    if (!res.ok) {
      const errMsg = (msg && msg.error && msg.error.message) || text.slice(0, 240) || `HTTP ${res.status}`;
      return { ok: false, status: res.status, tool: toolName, error: String(errMsg) };
    }
    if (!msg || typeof msg !== 'object' || (msg.result === undefined && msg.error === undefined)) {
      return { ok: false, notMcp: true, tool: toolName, error: 'Non-MCP response' };
    }
    if (msg.error) {
      return { ok: false, tool: toolName, error: String(msg.error.message || JSON.stringify(msg.error)) };
    }
    const result = msg.result;
    if (!result || !Array.isArray(result.content)) {
      return { ok: false, notMcp: true, tool: toolName, error: 'Malformed MCP tool result' };
    }
    const textParts = result.content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text);
    const joinedText = textParts.join('\n').trim();
    if (result.isError) {
      return { ok: false, tool: toolName, error: joinedText || 'Paradev MCP tool error' };
    }
    let data = joinedText;
    if (/^\s*[\[{]/.test(joinedText)) {
      try { data = JSON.parse(joinedText); } catch (_) {}
    }
    return { ok: true, via: 'mcp', tool: toolName, data, rawText: joinedText };
  } catch (e) {
    return { ok: false, tool: toolName, error: e && e.message ? e.message : String(e) };
  }
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
    const [planRes, modelRes, orgRes] = await Promise.all([
      callTrpc('billing.activePlan', { method: 'GET', ...creds, fetchImpl, timeoutMs: 8000 }),
      callTrpc('chat.getModels', { method: 'GET', ...creds, fetchImpl, timeoutMs: 8000 }),
      callTrpc('organization.list', { method: 'GET', ...creds, fetchImpl, timeoutMs: 8000 }).catch(() => ({ ok: false })),
    ]);
    let discoveredOrg = null;
    if (orgRes && orgRes.ok && Array.isArray(orgRes.data) && orgRes.data.length) {
      discoveredOrg = orgRes.data[0];
      if (!creds.organizationId && discoveredOrg.id) {
        try { saveConfig({ organizationId: discoveredOrg.id }); out.organizationId = discoveredOrg.id; } catch (_) {}
      }
    }
    out.network = {
      reachable: Boolean(planRes.ok || modelRes.ok || (orgRes && orgRes.ok)),
      plan: planRes.ok ? planRes.data : null,
      organization: discoveredOrg ? { id: discoveredOrg.id, name: discoveredOrg.name, slug: discoveredOrg.slug } : null,
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

async function listWorkspaces({ organizationId, hostId, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  const orgId = String(organizationId || creds.organizationId || '').trim();
  const cloudRes = await callTrpc('cloudWorkspace.list', {
    method: 'GET',
    input: orgId ? { organizationId: orgId } : {},
    ...creds,
    fetchImpl,
  });
  if (cloudRes && cloudRes.ok) return cloudRes;
  // On Free plan or personal API keys, cloudWorkspace.list returns 403 — query host/local workspaces via Paradev MCP.
  const [hostsRes, wsRes] = await Promise.all([
    callMcpTool('hosts_list', {}, { explicit, ...creds, fetchImpl }),
    callMcpTool('workspaces_list', hostId ? { hostId } : {}, { explicit, ...creds, fetchImpl }),
  ]);
  if (wsRes.ok || hostsRes.ok) {
    return {
      ok: true,
      via: 'mcp',
      data: {
        workspaces: wsRes.ok ? wsRes.data : [],
        hosts: hostsRes.ok ? hostsRes.data : [],
        cloudNote: cloudRes && cloudRes.error ? cloudRes.error : undefined,
      },
    };
  }
  return cloudRes;
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

async function listTaskStatuses(filter = {}, { explicit = null, fetchImpl = global.fetch } = {}) {
  return callMcpTool('tasks_statuses_list', filter && typeof filter === 'object' ? filter : {}, { explicit, fetchImpl });
}

async function listTasks(filter = {}, { explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  const args = filter && typeof filter === 'object' ? { ...filter } : {};
  const mcpRes = await callMcpTool('tasks_list', args, { explicit, ...creds, fetchImpl });
  if (mcpRes && mcpRes.ok) return mcpRes;
  if (mcpRes && !mcpRes.notMcp && mcpRes.status && mcpRes.status !== 404) return mcpRes;
  return callTrpc('task.list', {
    method: 'GET',
    input: Object.keys(args).length ? args : undefined,
    ...creds,
    fetchImpl,
  });
}

async function createTask({ title, description, priority, statusId, tracker, team, assigneeId, labels, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  if (!title) return { ok: false, error: 'Task title is required' };
  const payload = {
    title: String(title).trim(),
    ...(description ? { description: String(description) } : {}),
    ...(priority ? { priority } : {}),
    ...(statusId ? { statusId } : {}),
    ...(tracker ? { tracker } : {}),
    ...(team ? { team } : {}),
    ...(assigneeId ? { assigneeId } : {}),
    ...(Array.isArray(labels) ? { labels } : {}),
  };
  const mcpRes = await callMcpTool('tasks_create', payload, { explicit, ...creds, fetchImpl });
  if (mcpRes && mcpRes.ok) return mcpRes;
  return callTrpc('task.create', {
    method: 'POST',
    input: payload,
    ...creds,
    fetchImpl,
  });
}

async function updateTask({ id, title, description, priority, statusId, tracker, assigneeId, prUrl, labels, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  if (!id) return { ok: false, error: 'Task id is required' };
  const payload = {
    id: String(id).trim(),
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(priority !== undefined ? { priority } : {}),
    ...(statusId !== undefined ? { statusId } : {}),
    ...(tracker !== undefined ? { tracker } : {}),
    ...(assigneeId !== undefined ? { assigneeId } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
  const mcpRes = await callMcpTool('tasks_update', payload, { explicit, ...creds, fetchImpl });
  if (mcpRes && mcpRes.ok) return mcpRes;
  return callTrpc('task.update', {
    method: 'POST',
    input: payload,
    ...creds,
    fetchImpl,
  });
}

async function deleteTask({ id, tracker, explicit = null, fetchImpl = global.fetch } = {}) {
  const creds = resolveCredentials({ explicit });
  if (!id) return { ok: false, error: 'Task id is required' };
  return callMcpTool('tasks_delete', { id: String(id).trim(), ...(tracker ? { tracker } : {}) }, { explicit, ...creds, fetchImpl });
}

function getMcpServerPresets({ explicit = null } = {}) {
  const creds = resolveCredentials({ explicit });
  const list = [
    {
      serverId: 'paradev_docs',
      name: 'paradev-docs',
      transport: 'http',
      url: DOCS_MCP_URL,
      headers: {},
      enabled: true,
    },
  ];
  if (creds.configured) {
    list.push({
      serverId: 'paradev',
      name: 'paradev',
      transport: 'http',
      url: `${creds.baseURL}/mcp`,
      headers: buildAuthHeaders(creds),
      enabled: true,
    });
  }
  return list;
}

const _mcpAttempted = new Set();
async function ensureParadevMcpConnected(mcpClient, { force = false, explicit = null } = {}) {
  if (!mcpClient || typeof mcpClient.connect !== 'function' || !mcpClient.servers) return { connected: [] };
  const creds = resolveCredentials({ explicit });
  if (!creds.configured && !force) return { connected: [] };
  const presets = getMcpServerPresets({ explicit });
  const connected = [];
  for (const srv of presets) {
    const sid = srv.serverId || srv.name;
    if (!force && mcpClient.servers.has(sid)) { connected.push(sid); continue; }
    if (!force && _mcpAttempted.has(sid)) continue;
    _mcpAttempted.add(sid);
    try {
      const info = await mcpClient.connect(srv);
      const entry = mcpClient.servers.get(info.serverId);
      if (entry) entry.fullTools = info.tools || [];
      connected.push(info.serverId || sid);
    } catch (_) {}
  }
  return { connected };
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
  callMcpTool,
  getStatus,
  transcribeAudio,
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  deleteWorkspace,
  listTaskStatuses,
  listTasks,
  createTask,
  updateTask,
  deleteTask,
  getMcpServerPresets,
  ensureParadevMcpConnected,
};
