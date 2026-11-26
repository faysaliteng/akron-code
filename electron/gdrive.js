'use strict';
/**
 * Google Drive connector for Akron Bot.
 *
 * Supports three connection modes so Google Drive works both out-of-the-box and
 * against cloud OAuth / MCP endpoints:
 *   1. `local` — Google Drive for Desktop synced folder (`~/Library/CloudStorage/GoogleDrive-*` or chosen folder)
 *   2. `oauth` / `token` — Google Drive REST API v3 (OAuth 2.0 PKCE loopback, refresh token, or pasted access token)
 *   3. `mcp` — External Google Drive MCP server (`@modelcontextprotocol/server-gdrive` stdio or HTTP/SSE)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const mcpoauth = require('./mcpoauth');
const defaultSecretStore = require('./secretstore');

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DEFAULT_DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
].join(' ');
const SECRET_KEY = 'gdrive:oauth_tokens';

const SKIP_DIRS = new Set(['.Trash', '.Trashes', '.git', 'node_modules', '.DS_Store', '.Spotlight-V100']);
const TEXT_EXT_RE = /\.(txt|md|markdown|csv|tsv|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|css|scss|html|htm|xml|yaml|yml|toml|ini|sh|sql|log|env|gdoc|gsheet|gslides|gform)$/i;

function configFile() {
  return process.env.AUTOBOT_GDRIVE_FILE || path.join(os.homedir(), '.autobot', 'gdrive.json');
}

function readConfig() {
  try {
    const f = configFile();
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (_) {}
  return {};
}

function writeConfig(cfg) {
  const f = configFile();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(f, 0o600); } catch (_) {}
}

function readSecretTokens(store = defaultSecretStore) {
  try {
    const raw = store.get(SECRET_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function writeSecretTokens(obj, store = defaultSecretStore) {
  store.set(SECRET_KEY, JSON.stringify(obj));
}

function deleteSecretTokens(store = defaultSecretStore) {
  try { store.del(SECRET_KEY); } catch (_) {}
}

function detectLocalDriveFolders() {
  const out = [];
  const seen = new Set();
  const home = os.homedir();
  const pushCandidate = (folderPath, label, email = '') => {
    try {
      const clean = path.resolve(folderPath);
      if (seen.has(clean)) return;
      if (!fs.existsSync(clean) || !fs.statSync(clean).isDirectory()) return;
      seen.add(clean);
      out.push({ path: clean, label: label || path.basename(clean), email });
    } catch (_) {}
  };

  try {
    const cs = path.join(home, 'Library', 'CloudStorage');
    if (fs.existsSync(cs)) {
      for (const name of fs.readdirSync(cs)) {
        if (!/^GoogleDrive/i.test(name)) continue;
        const base = path.join(cs, name);
        const myDrive = path.join(base, 'My Drive');
        const email = name.replace(/^GoogleDrive-/i, '');
        if (fs.existsSync(myDrive) && fs.statSync(myDrive).isDirectory()) {
          pushCandidate(myDrive, `${email || name} (My Drive)`, email);
        } else {
          pushCandidate(base, email || name, email);
        }
      }
    }
  } catch (_) {}

  pushCandidate('/Volumes/GoogleDrive/My Drive', 'Google Drive Volume (My Drive)');
  pushCandidate('/Volumes/GoogleDrive', 'Google Drive Volume');
  pushCandidate(path.join(home, 'Google Drive'), 'Google Drive');
  return out;
}

function status(mcpClient) {
  const cfg = readConfig();
  const detectedLocalFolders = detectLocalDriveFolders();
  let connected = !!cfg.connected;
  if (cfg.mode === 'local') {
    connected = !!(cfg.folderPath && fs.existsSync(cfg.folderPath));
  } else if (cfg.mode === 'mcp') {
    const sid = cfg.serverId || 'gdrive';
    const srv = mcpClient && mcpClient.servers ? mcpClient.servers.get(sid) : null;
    connected = !!(srv && !srv.exited);
  }
  return {
    ok: true,
    connected,
    mode: connected ? (cfg.mode || null) : (cfg.mode || null),
    accountEmail: cfg.accountEmail || '',
    accountName: cfg.accountName || '',
    folderPath: cfg.folderPath || '',
    serverId: cfg.serverId || 'gdrive',
    mcpName: cfg.mcpName || '',
    apiBaseUrl: cfg.apiBaseUrl || DEFAULT_DRIVE_API_BASE,
    connectedAt: cfg.connectedAt || null,
    detectedLocalFolders,
  };
}

function connectLocalFolder(folderPath) {
  const raw = String(folderPath || '').trim();
  if (!raw) throw new Error('Drive folder path is required');
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`Drive folder does not exist or is not a directory: ${resolved}`);
  }
  fs.readdirSync(resolved); // verify read permission
  const cfg = {
    connected: true,
    mode: 'local',
    folderPath: resolved,
    accountName: path.basename(resolved),
    accountEmail: /GoogleDrive-([^/]+)/i.test(resolved) ? RegExp.$1 : '',
    connectedAt: Date.now(),
  };
  writeConfig(cfg);
  return { ok: true, status: status() };
}

async function fetchDriveAbout(accessToken, apiBaseUrl, fetchImpl = globalThis.fetch) {
  const base = String(apiBaseUrl || DEFAULT_DRIVE_API_BASE).replace(/\/+$/, '');
  const res = await fetchImpl(`${base}/about?fields=user(displayName,emailAddress)`, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Google Drive API error (${res.status}): ${mcpoauth._internal ? mcpoauth._internal.stripMarkup(txt).slice(0, 180) : txt.slice(0, 180)}`);
  }
  const data = await res.json();
  return (data && data.user) || {};
}

async function connectToken({
  accessToken,
  refreshToken = '',
  clientId = '',
  clientSecret = '',
  apiBaseUrl = DEFAULT_DRIVE_API_BASE,
  uploadBaseUrl = DEFAULT_DRIVE_UPLOAD_BASE,
  verify = true,
  fetchImpl = globalThis.fetch,
  store = defaultSecretStore,
} = {}) {
  const token = String(accessToken || '').trim();
  if (!token) throw new Error('Google OAuth access token is required');
  let user = {};
  if (verify) {
    user = await fetchDriveAbout(token, apiBaseUrl, fetchImpl);
  }
  writeSecretTokens({
    access_token: token,
    refresh_token: refreshToken || undefined,
    client_id: clientId || undefined,
    client_secret: clientSecret || undefined,
    expires_at: refreshToken ? Date.now() + 3600 * 1000 : undefined,
  }, store);

  const cfg = {
    connected: true,
    mode: refreshToken ? 'oauth' : 'token',
    accountEmail: user.emailAddress || '',
    accountName: user.displayName || 'Google Drive',
    apiBaseUrl: String(apiBaseUrl || DEFAULT_DRIVE_API_BASE).replace(/\/+$/, ''),
    uploadBaseUrl: String(uploadBaseUrl || DEFAULT_DRIVE_UPLOAD_BASE).replace(/\/+$/, ''),
    connectedAt: Date.now(),
  };
  writeConfig(cfg);
  return { ok: true, user, status: status() };
}

async function connectOAuth({
  clientId,
  clientSecret = '',
  openExternal,
  fetchImpl = globalThis.fetch,
  tokenUrl = GOOGLE_TOKEN_URL,
  authUrl = GOOGLE_AUTH_URL,
  apiBaseUrl = DEFAULT_DRIVE_API_BASE,
  uploadBaseUrl = DEFAULT_DRIVE_UPLOAD_BASE,
  scope = DEFAULT_SCOPES,
  store = defaultSecretStore,
  timeoutMs,
} = {}) {
  const cid = String(clientId || '').trim();
  if (!cid) throw new Error('Google OAuth Client ID is required');
  if (typeof openExternal !== 'function') throw new Error('openExternal handler is required');

  const pair = mcpoauth.pkce();
  const state = mcpoauth.randomState();
  const loop = await mcpoauth.startLoopback({ timeoutMs });

  const url = new URL(authUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', cid);
  url.searchParams.set('redirect_uri', loop.redirectUri);
  url.searchParams.set('scope', scope);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', pair.challenge);
  url.searchParams.set('code_challenge_method', pair.method);
  url.searchParams.set('state', state);

  await openExternal(url.toString());
  const cb = await loop.wait();
  if (cb.error) throw new Error(cb.errorDescription || cb.error);
  if (!cb.code) throw new Error('Google sign-in did not return an authorization code');
  if (cb.state !== state) throw new Error('OAuth state mismatch during Google sign-in');

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: cb.code,
    redirect_uri: loop.redirectUri,
    client_id: cid,
    code_verifier: pair.verifier,
  });
  if (clientSecret) body.set('client_secret', String(clientSecret).trim());

  const res = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: body.toString(),
  });
  const tokData = await res.json().catch(() => null);
  if (!res.ok || !tokData || !tokData.access_token) {
    throw new Error(`Google token exchange failed (${res.status}): ${(tokData && (tokData.error_description || tokData.error)) || 'unknown error'}`);
  }
  const user = await fetchDriveAbout(tokData.access_token, apiBaseUrl, fetchImpl);
  writeSecretTokens({
    access_token: tokData.access_token,
    refresh_token: tokData.refresh_token || undefined,
    client_id: cid,
    client_secret: clientSecret ? String(clientSecret).trim() : undefined,
    scope: tokData.scope || scope,
    expires_at: tokData.expires_in ? Date.now() + Number(tokData.expires_in) * 1000 : undefined,
  }, store);

  writeConfig({
    connected: true,
    mode: 'oauth',
    accountEmail: user.emailAddress || '',
    accountName: user.displayName || 'Google Drive',
    apiBaseUrl: String(apiBaseUrl || DEFAULT_DRIVE_API_BASE).replace(/\/+$/, ''),
    uploadBaseUrl: String(uploadBaseUrl || DEFAULT_DRIVE_UPLOAD_BASE).replace(/\/+$/, ''),
    connectedAt: Date.now(),
  });
  return { ok: true, user, status: status() };
}

async function connectMcp(cfg, mcpClient) {
  if (!mcpClient) throw new Error('MCP client required');
  const connectCfg = {
    serverId: 'gdrive',
    name: (cfg && cfg.name) || 'Google Drive',
    ...(cfg && cfg.url ? { url: cfg.url, transport: cfg.transport === 'sse' ? 'sse' : 'http', headers: cfg.headers } : {}),
    ...(cfg && cfg.command ? { command: cfg.command, args: cfg.args || [], env: cfg.env || {} } : {}),
  };
  if (!connectCfg.url && !connectCfg.command) {
    connectCfg.command = 'npx';
    connectCfg.args = ['-y', '@modelcontextprotocol/server-gdrive'];
  }
  const info = await mcpClient.connect(connectCfg);
  const srv = mcpClient.servers.get(info.serverId);
  if (srv) srv.fullTools = info.tools || [];
  writeConfig({
    connected: true,
    mode: 'mcp',
    serverId: info.serverId,
    mcpName: info.name || 'Google Drive',
    endpointUrl: connectCfg.url || '',
    command: connectCfg.command || '',
    connectedAt: Date.now(),
  });
  return { ok: true, serverId: info.serverId, tools: info.tools || [], status: status(mcpClient) };
}

function disconnect(mcpClient, store = defaultSecretStore) {
  const cfg = readConfig();
  if (mcpClient && mcpClient.servers && mcpClient.servers.has(cfg.serverId || 'gdrive')) {
    try { mcpClient.disconnect(cfg.serverId || 'gdrive'); } catch (_) {}
  }
  deleteSecretTokens(store);
  writeConfig({ connected: false, mode: null });
  return { ok: true, status: status(mcpClient) };
}

async function validAccessToken(store = defaultSecretStore, fetchImpl = globalThis.fetch) {
  const tok = readSecretTokens(store);
  if (!tok || !tok.access_token) throw new Error('Google Drive is not signed in. Open Add Context -> Drive -> Set up.');
  if (tok.expires_at && Date.now() >= tok.expires_at - 60000 && tok.refresh_token && tok.client_id) {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tok.refresh_token,
      client_id: tok.client_id,
    });
    if (tok.client_secret) body.set('client_secret', tok.client_secret);
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
    });
    const next = await res.json().catch(() => null);
    if (res.ok && next && next.access_token) {
      tok.access_token = next.access_token;
      if (next.expires_in) tok.expires_at = Date.now() + Number(next.expires_in) * 1000;
      writeSecretTokens(tok, store);
    }
  }
  return tok.access_token;
}

function walkLocalFiles(rootDir, query = '', limit = 50, maxDepth = 6) {
  const out = [];
  const q = String(query || '').trim().toLowerCase();
  const stack = [{ dir: rootDir, depth: 0 }];
  while (stack.length && out.length < limit) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
      const full = path.join(dir, ent.name);
      const rel = path.relative(rootDir, full);
      if (ent.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!ent.isFile()) continue;
      if (q && !rel.toLowerCase().includes(q) && !ent.name.toLowerCase().includes(q)) continue;
      let st = null;
      try { st = fs.statSync(full); } catch (_) {}
      out.push({
        id: full,
        path: full,
        name: ent.name,
        relativePath: rel,
        mimeType: /\.(gdoc|gsheet|gslides)$/i.test(ent.name) ? 'application/vnd.google-apps.shortcut' : 'text/plain',
        size: st ? st.size : 0,
        modifiedTime: st ? new Date(st.mtimeMs).toISOString() : null,
        source: 'local',
      });
      if (out.length >= limit) break;
    }
  }
  return out;
}

async function searchFiles(query = '', opts = {}, mcpClient, fetchImpl = globalThis.fetch, store = defaultSecretStore) {
  const cfg = readConfig();
  const limit = Math.max(1, Math.min(Number(opts.limit) || 30, 100));
  if (!cfg.connected) throw new Error('Google Drive is not connected');

  if (cfg.mode === 'local') {
    const files = walkLocalFiles(cfg.folderPath, query, limit);
    return { ok: true, mode: 'local', files };
  }

  if (cfg.mode === 'mcp') {
    const sid = cfg.serverId || 'gdrive';
    const srv = mcpClient && mcpClient.servers ? mcpClient.servers.get(sid) : null;
    if (!srv) throw new Error('Google Drive MCP server is not connected');
    const searchTool = (srv.fullTools || []).find((t) => /search/i.test(t.name)) || (srv.fullTools || [])[0];
    if (!searchTool) throw new Error('Google Drive MCP server exposed no search tool');
    const raw = await mcpClient.callTool(sid, searchTool.name, { query: String(query || '') });
    return { ok: true, mode: 'mcp', files: [{ id: String(query || 'search'), name: `${searchTool.name} result`, mimeType: 'text/plain', preview: raw }] };
  }

  const token = await validAccessToken(store, fetchImpl);
  const base = cfg.apiBaseUrl || DEFAULT_DRIVE_API_BASE;
  const escaped = String(query || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const qExpr = escaped
    ? `trashed=false and (name contains '${escaped}' or fullText contains '${escaped}')`
    : 'trashed=false';
  const u = new URL(`${base}/files`);
  u.searchParams.set('q', qExpr);
  u.searchParams.set('pageSize', String(limit));
  u.searchParams.set('orderBy', 'modifiedTime desc');
  u.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size,webViewLink)');

  const res = await fetchImpl(u.toString(), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Drive search failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const data = await res.json();
  return { ok: true, mode: cfg.mode, files: Array.isArray(data && data.files) ? data.files : [] };
}

async function listFolder(folderId = 'root', opts = {}, mcpClient, fetchImpl = globalThis.fetch, store = defaultSecretStore) {
  const cfg = readConfig();
  const limit = Math.max(1, Math.min(Number(opts.limit) || 50, 200));
  if (!cfg.connected) throw new Error('Google Drive is not connected');

  if (cfg.mode === 'local') {
    const dir = folderId && folderId !== 'root' ? path.resolve(cfg.folderPath, folderId) : cfg.folderPath;
    if (!dir.startsWith(path.resolve(cfg.folderPath))) throw new Error('Folder outside configured Drive root');
    const items = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
      .slice(0, limit)
      .map((e) => {
        const full = path.join(dir, e.name);
        return {
          id: full,
          name: e.name,
          mimeType: e.isDirectory() ? 'application/vnd.google-apps.folder' : 'text/plain',
          relativePath: path.relative(cfg.folderPath, full),
        };
      });
    return { ok: true, mode: 'local', files: items };
  }

  const token = await validAccessToken(store, fetchImpl);
  const base = cfg.apiBaseUrl || DEFAULT_DRIVE_API_BASE;
  const fid = String(folderId || 'root').replace(/'/g, "\\'");
  const u = new URL(`${base}/files`);
  u.searchParams.set('q', `'${fid}' in parents and trashed=false`);
  u.searchParams.set('pageSize', String(limit));
  u.searchParams.set('fields', 'files(id,name,mimeType,modifiedTime,size,webViewLink)');
  const res = await fetchImpl(u.toString(), {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Drive listFolder failed (${res.status})`);
  const data = await res.json();
  return { ok: true, mode: cfg.mode, files: Array.isArray(data && data.files) ? data.files : [] };
}

async function readFile(idOrPath, mcpClient, fetchImpl = globalThis.fetch, store = defaultSecretStore) {
  const cfg = readConfig();
  if (!cfg.connected) throw new Error('Google Drive is not connected');
  const target = String(idOrPath || '').trim();
  if (!target) throw new Error('File id or path is required');

  if (cfg.mode === 'local') {
    const root = path.resolve(cfg.folderPath);
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(root, target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new Error(`Path must stay inside configured Drive folder: ${root}`);
    }
    if (!fs.existsSync(resolved)) throw new Error(`Drive file not found: ${resolved}`);
    const name = path.basename(resolved);
    if (/\.(gdoc|gsheet|gslides)$/i.test(name)) {
      const raw = fs.readFileSync(resolved, 'utf8');
      let meta = null;
      try { meta = JSON.parse(raw); } catch (_) {}
      return {
        ok: true,
        id: resolved,
        name,
        mimeType: 'application/vnd.google-apps.shortcut',
        content: meta ? `Google Workspace shortcut (${name})\nURL: ${meta.url || 'n/a'}\nDoc ID: ${meta.doc_id || 'n/a'}` : raw,
      };
    }
    if (!TEXT_EXT_RE.test(name)) {
      const st = fs.statSync(resolved);
      if (st.size > 256 * 1024) {
        return { ok: true, id: resolved, name, mimeType: 'application/octet-stream', content: `[Binary Drive file: ${name}, ${st.size} bytes]` };
      }
    }
    const content = fs.readFileSync(resolved, 'utf8').slice(0, 256 * 1024);
    return { ok: true, id: resolved, name, mimeType: 'text/plain', content };
  }

  if (cfg.mode === 'mcp') {
    const sid = cfg.serverId || 'gdrive';
    const content = await mcpClient.readResource(sid, target.startsWith('gdrive:///') ? target : `gdrive:///${target}`);
    return { ok: true, id: target, name: path.basename(target), mimeType: 'text/plain', content };
  }

  const token = await validAccessToken(store, fetchImpl);
  const base = cfg.apiBaseUrl || DEFAULT_DRIVE_API_BASE;
  const metaRes = await fetchImpl(`${base}/files/${encodeURIComponent(target)}?fields=id,name,mimeType,size,webViewLink`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!metaRes.ok) throw new Error(`Drive metadata lookup failed (${metaRes.status})`);
  const meta = await metaRes.json();

  let fetchUrl = `${base}/files/${encodeURIComponent(target)}?alt=media`;
  if (meta.mimeType === 'application/vnd.google-apps.document' || meta.mimeType === 'application/vnd.google-apps.presentation') {
    fetchUrl = `${base}/files/${encodeURIComponent(target)}/export?mimeType=text/plain`;
  } else if (meta.mimeType === 'application/vnd.google-apps.spreadsheet') {
    fetchUrl = `${base}/files/${encodeURIComponent(target)}/export?mimeType=text/csv`;
  }
  const bodyRes = await fetchImpl(fetchUrl, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!bodyRes.ok) throw new Error(`Drive file read failed (${bodyRes.status})`);
  const content = (await bodyRes.text()).slice(0, 256 * 1024);
  return {
    ok: true,
    id: meta.id || target,
    name: meta.name || target,
    mimeType: meta.mimeType || 'text/plain',
    webViewLink: meta.webViewLink || '',
    content,
  };
}

async function saveFile({ name, content, mimeType = 'text/plain', folderId } = {}, mcpClient, fetchImpl = globalThis.fetch, store = defaultSecretStore) {
  const cfg = readConfig();
  if (!cfg.connected) throw new Error('Google Drive is not connected');
  const fileName = String(name || 'akron-export.txt').replace(/[/\\]/g, '_');
  const bodyText = String(content == null ? '' : content);

  if (cfg.mode === 'local') {
    const destDir = folderId && folderId !== 'root' ? path.resolve(cfg.folderPath, folderId) : cfg.folderPath;
    const dest = path.join(destDir, fileName);
    fs.writeFileSync(dest, bodyText, 'utf8');
    return { ok: true, id: dest, name: fileName, path: dest, mode: 'local' };
  }

  if (cfg.mode === 'mcp') {
    const sid = cfg.serverId || 'gdrive';
    const srv = mcpClient && mcpClient.servers ? mcpClient.servers.get(sid) : null;
    const uploadTool = srv && (srv.fullTools || []).find((t) => /create|upload|write/i.test(t.name));
    if (!uploadTool) throw new Error('Connected Google Drive MCP server has no file creation tool');
    const out = await mcpClient.callTool(sid, uploadTool.name, { name: fileName, content: bodyText, mimeType });
    return { ok: true, name: fileName, mode: 'mcp', result: out };
  }

  const token = await validAccessToken(store, fetchImpl);
  const uploadBase = cfg.uploadBaseUrl || DEFAULT_DRIVE_UPLOAD_BASE;
  const boundary = 'akron_drive_' + Date.now().toString(16);
  const metadata = { name: fileName, mimeType, ...(folderId ? { parents: [folderId] } : {}) };
  const multipart = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mimeType}; charset=UTF-8`,
    '',
    bodyText,
    `--${boundary}--`,
  ].join('\r\n');

  const res = await fetchImpl(`${uploadBase}/files?uploadType=multipart&fields=id,name,webViewLink`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/related; boundary=${boundary}`,
    },
    body: multipart,
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Drive upload failed (${res.status}): ${txt.slice(0, 200)}`);
  }
  const created = await res.json();
  return { ok: true, mode: cfg.mode, id: created.id, name: created.name || fileName, webViewLink: created.webViewLink || '' };
}

function toolSpecs() {
  return [
    {
      name: 'search_files',
      description: '[Google Drive] Search files, Docs, Sheets, and Slides in connected Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text or file name' },
          limit: { type: 'number', description: 'Max files to return (default 20)' },
        },
      },
    },
    {
      name: 'list_folder',
      description: '[Google Drive] List files inside a Google Drive folder (default root).',
      inputSchema: {
        type: 'object',
        properties: {
          folderId: { type: 'string', description: 'Folder ID or relative path (default root)' },
          limit: { type: 'number' },
        },
      },
    },
    {
      name: 'read_file',
      description: '[Google Drive] Read or export text content of a Google Drive file / Google Doc / Sheet.',
      inputSchema: {
        type: 'object',
        properties: {
          fileId: { type: 'string', description: 'Google Drive file ID or local Drive path' },
        },
        required: ['fileId'],
      },
    },
    {
      name: 'create_file',
      description: '[Google Drive] Save/upload a new file into connected Google Drive.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'File name' },
          content: { type: 'string', description: 'File text content' },
          mimeType: { type: 'string', description: 'MIME type (default text/plain)' },
          folderId: { type: 'string', description: 'Optional destination folder ID or relative path' },
        },
        required: ['name', 'content'],
      },
    },
  ];
}

async function callTool(toolName, args = {}, mcpClient) {
  if (toolName === 'search_files') {
    const r = await searchFiles(args.query || '', { limit: args.limit }, mcpClient);
    return JSON.stringify(r.files, null, 2);
  }
  if (toolName === 'list_folder') {
    const r = await listFolder(args.folderId || 'root', { limit: args.limit }, mcpClient);
    return JSON.stringify(r.files, null, 2);
  }
  if (toolName === 'read_file') {
    const r = await readFile(args.fileId || args.id || args.path, mcpClient);
    return `# ${r.name} (${r.mimeType})\n\n${r.content}`;
  }
  if (toolName === 'create_file') {
    const r = await saveFile(args, mcpClient);
    return JSON.stringify(r, null, 2);
  }
  throw new Error(`Unknown Google Drive tool: ${toolName}`);
}

module.exports = {
  detectLocalDriveFolders,
  status,
  connectLocalFolder,
  connectToken,
  connectOAuth,
  connectMcp,
  disconnect,
  searchFiles,
  listFolder,
  readFile,
  saveFile,
  toolSpecs,
  callTool,
};
