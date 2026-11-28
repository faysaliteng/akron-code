'use strict';
const { spawn } = require('child_process');

// Minimal Model Context Protocol client.
// Transports: stdio (spawn), SSE, and streamable-HTTP.
// JSON-RPC 2.0; tool/resource calls mapped back to the agent.

async function parseSSE(res, targetId = null) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const frames = [];
  const flushFrame = (block) => {
    const lines = block.split(/\r?\n/);
    const data = [];
    for (const ln of lines) {
      const t = ln.trim();
      if (t.startsWith('data:')) data.push(t.slice(5).trim());
    }
    const payload = data.filter(Boolean).join('\n');
    if (!payload || payload === '[DONE]') return;
    try { frames.push(JSON.parse(payload)); } catch (_) { frames.push({ _raw: payload }); }
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buf.search(/\r?\n\r?\n/)) !== -1) {
      const block = buf.slice(0, sep);
      const nlMatch = buf.slice(sep).match(/^\r?\n\r?\n/);
      buf = buf.slice(sep + (nlMatch ? nlMatch[0].length : 2));
      flushFrame(block);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) flushFrame(buf);
  if (!frames.length) return null;
  if (targetId != null) {
    const match = frames.find((f) => f && typeof f === 'object' && f.id === targetId && (Object.prototype.hasOwnProperty.call(f, 'result') || Object.prototype.hasOwnProperty.call(f, 'error')));
    if (match) return match;
  }
  const rpc = [...frames].reverse().find((f) => f && typeof f === 'object' && (Object.prototype.hasOwnProperty.call(f, 'result') || Object.prototype.hasOwnProperty.call(f, 'error')));
  return rpc || frames[frames.length - 1];
}

let _activeMcpClient = null;
const DEFAULT_MCP_CONNECT_TIMEOUT_MS = 1500;

function isValidMcpConnectorConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || cfg.disabled === true) return false;
  const badToken = /(?:^|[/:.@])not[-_]?setup(?:$|[/:.?&#])|<[^>]+>|YOUR_API_KEY|\bplaceholder\b/i;
  const transport = String(cfg.transport || cfg.type || '').toLowerCase();
  if (cfg.url != null || transport === 'http' || transport === 'sse') {
    const u = String(cfg.url || '').trim();
    if (!u || !/^https?:\/\//i.test(u) || badToken.test(u)) return false;
    return true;
  }
  const cmd = String(cfg.command || '').trim();
  if (!cmd || badToken.test(cmd)) return false;
  if (Array.isArray(cfg.args)) {
    for (const a of cfg.args) {
      const s = String(a == null ? '' : a).trim();
      if (s === 'not-setup' || /^https?:\/\/not[-_]?setup\b/i.test(s) || badToken.test(s)) return false;
    }
  }
  if (cfg.env && typeof cfg.env === 'object') {
    for (const v of Object.values(cfg.env)) {
      const s = String(v == null ? '' : v).trim();
      if (s === 'not-setup' || /^https?:\/\/not[-_]?setup\b/i.test(s)) return false;
    }
  }
  return true;
}

class MCPClient {
  constructor(opts) {
    this.servers = new Map(); // serverId -> entry
    this.nextServerId = 1;
    // async (url) => bearer token | null — supplied by main.js so OAuth-gated
    // hosted servers authenticate without the caller passing a header.
    this.authProvider = (opts && opts.authProvider) || null;
    if ((opts && opts.authProvider) || !_activeMcpClient) {
      _activeMcpClient = this;
    }
  }

  async connect(cfg) {
    cfg = cfg || {};
    if (!isValidMcpConnectorConfig(cfg)) {
      throw new Error(`Skipping unconfigured MCP server "${(cfg && (cfg.name || cfg.url || cfg.command)) || 'not-setup'}"`);
    }
    if (cfg.url && (cfg.transport === 'sse' || cfg.transport === 'http')) {
      return this._connectHttp(cfg);
    }
    return this._connectStdio(cfg);
  }

  async _connectHttp(cfg) {
    const customId = cfg.serverId && /^[A-Za-z0-9_]+$/.test(String(cfg.serverId)) ? String(cfg.serverId) : null;
    if (customId && this.servers.has(customId)) this.disconnect(customId);
    const serverId = customId || ('srv' + this.nextServerId++);
    const url = cfg.url;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(cfg.headers || {}) };
    if (!headers.authorization && typeof this.authProvider === 'function') {
      try {
        const tok = await this.authProvider(url);
        if (tok) headers.authorization = 'Bearer ' + tok;
      } catch (_) { /* anonymous attempt; a 401 below can still trigger sign-in */ }
    }
    // Optional per-connector API key pasted in settings.
    if (!headers.authorization && cfg.apiKey) headers.authorization = 'Bearer ' + cfg.apiKey;
    const entry = {
      type: 'http', url, headers, nextId: 1, tools: [], fullTools: [], prompts: [], name: cfg.name || url,
      pending: new Map(), stderr: () => '', sessionId: null,
      rawConfig: {
        type: cfg.transport || 'http',
        url,
        ...(Object.keys(headers).length ? { headers: { ...headers } } : {}),
      },
    };
    const post = async (body, timeoutMs = 60000) => {
      const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 60000;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(limit),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        const www = res.headers.get('www-authenticate') || '';
        const err = new Error(`MCP HTTP ${res.status}: ${t.slice(0, 200)}`);
        err.status = res.status;
        err.wwwAuthenticate = www;
        err.resourceMetadata = (www.match(/resource_metadata\s*=\s*"([^"]+)"/) || [])[1] || null;
        throw err;
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) { entry.sessionId = sid; headers['mcp-session-id'] = sid; }
      const ct = res.headers.get('content-type') || '';
      const msg = ct.includes('text/event-stream') ? await parseSSE(res, body && body.id) : await res.json();
      if (msg && typeof msg === 'object' && Object.prototype.hasOwnProperty.call(msg, 'jsonrpc')) {
        if (msg.error) throw new Error(msg.error.message || 'MCP error');
        return msg.result !== undefined ? msg.result : msg;
      }
      return msg;
    };
    entry.post = post;
    this.servers.set(serverId, entry);

    const initTimeout = Number(cfg.initTimeoutMs) || DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    await this._request(serverId, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'autobot', version: '1.0.0' },
    }, initTimeout);
    this._notify(serverId, 'notifications/initialized', {});
    let tools = [];
    try {
      const r = await this._request(serverId, 'tools/list', {}, initTimeout);
      tools = (r && r.tools) || [];
    } catch (_) {}
    entry.fullTools = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
    entry.tools = entry.fullTools.map((t) => t.name);
    let prompts = [];
    try {
      const pr = await this._request(serverId, 'prompts/list', {}, Math.min(initTimeout, DEFAULT_MCP_CONNECT_TIMEOUT_MS));
      prompts = (pr && Array.isArray(pr.prompts)) ? pr.prompts : [];
    } catch (_) {}
    entry.prompts = prompts;
    return { serverId, name: entry.name, tools: entry.fullTools, prompts: entry.prompts };
  }

  async _connectStdio(cfg) {
    const { command, args = [], env = {}, cwd } = cfg;
    const customId = cfg.serverId && /^[A-Za-z0-9_]+$/.test(String(cfg.serverId)) ? String(cfg.serverId) : null;
    if (customId && this.servers.has(customId)) this.disconnect(customId);
    const serverId = customId || ('srv' + this.nextServerId++);
    let proc;
    try {
      proc = spawn(command, args, {
        cwd: cwd || undefined,
        env: { ...process.env, ...env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      throw new Error(`Failed to spawn MCP server "${command}": ${err.message}`);
    }
    let stderr = '';
    proc.stderr.on('data', (d) => {
      if (stderr.length < 32768) stderr += d.toString();
    });
    const entry = {
      type: 'stdio', proc, nextId: 1, tools: [], fullTools: [], prompts: [], name: cfg.name || command, pending: new Map(), stderr: () => stderr, exited: false,
      rawConfig: {
        command,
        args: Array.isArray(args) ? [...args] : [],
        ...(cfg.env && Object.keys(cfg.env).length ? { env: { ...cfg.env } } : {}),
      },
    };
    this.servers.set(serverId, entry);

    proc.on('error', (err) => {
      entry.exited = true;
      for (const [, p] of entry.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`MCP process error (${command}): ${err.message}`));
      }
      entry.pending.clear();
      this.servers.delete(serverId);
    });

    const maxStdoutBufferBytes = Number(cfg.maxStdoutBufferBytes) || 8 * 1024 * 1024;
    let buffer = '';
    proc.stdout.on('data', (d) => {
      if (entry.exited) return;
      buffer += d.toString();
      if (Buffer.byteLength(buffer, 'utf8') > maxStdoutBufferBytes) {
        buffer = '';
        entry.exited = true;
        const err = new Error(`MCP stdout flood exceeded ${maxStdoutBufferBytes} bytes without newline delimiter`);
        for (const [, p] of entry.pending) {
          clearTimeout(p.timer);
          p.reject(err);
        }
        entry.pending.clear();
        try { proc.kill('SIGKILL'); } catch (_) {}
        return;
      }
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && entry.pending.has(msg.id)) {
          const { resolve, reject, timer } = entry.pending.get(msg.id);
          clearTimeout(timer);
          entry.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
          else resolve(msg.result);
        }
      }
    });

    proc.on('exit', (code) => {
      for (const [, p] of entry.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('MCP server exited (code ' + code + ')' + (stderr ? ': ' + stderr.slice(-240) : '')));
      }
      entry.pending.clear();
      entry.exited = true;
    });

    const initTimeout = Number(cfg.initTimeoutMs) || DEFAULT_MCP_CONNECT_TIMEOUT_MS;
    try {
      await this._request(serverId, 'initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'autobot', version: '1.0.0' },
      }, initTimeout);
      this._notify(serverId, 'notifications/initialized', {});
      let tools = [];
      try {
        const r = await this._request(serverId, 'tools/list', {}, initTimeout);
        tools = (r && r.tools) || [];
      } catch (_) {}
      entry.fullTools = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      entry.tools = entry.fullTools.map((t) => t.name);
      let prompts = [];
      try {
        const pr = await this._request(serverId, 'prompts/list', {}, Math.min(initTimeout, DEFAULT_MCP_CONNECT_TIMEOUT_MS));
        prompts = (pr && Array.isArray(pr.prompts)) ? pr.prompts : [];
      } catch (_) {}
      entry.prompts = prompts;
      return { serverId, name: entry.name, tools: entry.fullTools, prompts: entry.prompts };
    } catch (e) {
      this.disconnect(serverId);
      throw e;
    }
  }

  _request(serverId, method, params, timeoutMs) {
    const entry = this.servers.get(serverId);
    if (!entry) return Promise.reject(new Error('server not found'));
    if (entry.type === 'http') {
      const id = entry.nextId++;
      return entry.post({ jsonrpc: '2.0', id, method, params }, timeoutMs);
    }
    if (entry.exited) return Promise.reject(new Error('MCP server already exited'));
    const id = entry.nextId++;
    const limit = Number(timeoutMs) || 300000;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (entry.pending.has(id)) {
          entry.pending.delete(id);
          reject(new Error(`MCP ${method} timed out after ${limit}ms`));
        }
      }, limit);
      if (timer && typeof timer.unref === 'function') timer.unref();
      entry.pending.set(id, { resolve, reject, timer });
      try {
        entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        entry.pending.delete(id);
        reject(e);
      }
    });
  }

  _notify(serverId, method, params) {
    const entry = this.servers.get(serverId);
    if (!entry) return;
    if (entry.type === 'http') {
      entry.post({ jsonrpc: '2.0', method, params }).catch(() => {});
      return;
    }
    entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  listTools(serverId) {
    const entry = this.servers.get(serverId);
    return entry ? entry.tools : [];
  }

  async listPrompts(serverId) {
    if (serverId) {
      const entry = this.servers.get(serverId);
      if (!entry) throw new Error('server not found');
      try {
        const r = await this._request(serverId, 'prompts/list', {}, 8000);
        const prompts = (r && Array.isArray(r.prompts)) ? r.prompts : [];
        entry.prompts = prompts;
        return prompts.map((p) => ({
          serverId,
          serverName: entry.name || serverId,
          name: p.name,
          title: p.title || '',
          description: p.description || '',
          arguments: Array.isArray(p.arguments) ? p.arguments : [],
        }));
      } catch (_) {
        return (entry.prompts || []).map((p) => ({
          serverId,
          serverName: entry.name || serverId,
          name: p.name,
          title: p.title || '',
          description: p.description || '',
          arguments: Array.isArray(p.arguments) ? p.arguments : [],
        }));
      }
    }
    const all = [];
    for (const sid of [...this.servers.keys()]) {
      try {
        const items = await this.listPrompts(sid);
        all.push(...items);
      } catch (_) {}
    }
    return all;
  }

  async getPrompt(serverId, name, args = {}) {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error('server not found');
    const r = await this._request(serverId, 'prompts/get', { name, arguments: args || {} }, 15000);
    const msgs = Array.isArray(r && r.messages) ? r.messages : [];
    const parts = [];
    for (const m of msgs) {
      const c = m && m.content;
      if (typeof c === 'string') parts.push(c);
      else if (c && typeof c.text === 'string') parts.push(c.text);
      else if (Array.isArray(c)) {
        for (const item of c) {
          if (item && typeof item.text === 'string') parts.push(item.text);
        }
      } else if (c != null) {
        parts.push(JSON.stringify(c));
      }
    }
    return {
      description: (r && r.description) || '',
      messages: msgs,
      text: parts.filter(Boolean).join('\n\n'),
    };
  }

  async listResources(serverId) {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error('server not found');
    try {
      const r = await this._request(serverId, 'resources/list', {});
      return (r && r.resources) || [];
    } catch (e) {
      return [];
    }
  }

  async readResource(serverId, uri) {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error('server not found');
    const r = await this._request(serverId, 'resources/read', { uri });
    const contents = (r && r.contents) || [];
    return contents
      .map((c) => (c.text != null ? c.text : JSON.stringify(c)))
      .join('\n');
  }

  async callTool(serverId, name, args) {
    const entry = this.servers.get(serverId);
    if (!entry) throw new Error('server not found');
    const result = await this._request(serverId, 'tools/call', { name, arguments: args || {} });
    const content = (result && result.content) || [];
    let firstImageDataUrl = null;
    const text = content
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') {
          if (!firstImageDataUrl && c.data) {
            firstImageDataUrl = `data:${c.mimeType || 'image/png'};base64,${c.data}`;
          }
          return `[image: ${c.mimeType || 'image/png'}]`;
        }
        return JSON.stringify(c);
      })
      .join('\n');
    if (firstImageDataUrl) {
      return {
        content: text || '[MCP image captured]',
        imageDataUrl: firstImageDataUrl,
        isError: !!(result && result.isError),
      };
    }
    return text;
  }

  getHealthyMcpServersMap({ includeInternalRea = false } = {}) {
    const out = {};
    for (const [sid, entry] of this.servers.entries()) {
      if (!entry || entry.exited || !entry.rawConfig) continue;
      if (!includeInternalRea && (sid === 'rea' || /\brea\b/i.test(String(entry.name || '')))) continue;
      if (!isValidMcpConnectorConfig(entry.rawConfig)) continue;
      const key = String(entry.name || sid).trim() || sid;
      out[key] = entry.rawConfig;
    }
    return out;
  }

  disconnect(serverId) {
    const entry = this.servers.get(serverId);
    if (entry) {
      if (entry.proc) { try { entry.proc.kill(); } catch (_) {} }
      this.servers.delete(serverId);
    }
  }

  disconnectAll() {
    for (const id of [...this.servers.keys()]) this.disconnect(id);
  }
}

function getActiveHealthyMcpServers(opts = {}) {
  if (!_activeMcpClient || typeof _activeMcpClient.getHealthyMcpServersMap !== 'function') {
    return {};
  }
  return _activeMcpClient.getHealthyMcpServersMap(opts);
}

module.exports = {
  MCPClient,
  isValidMcpConnectorConfig,
  DEFAULT_MCP_CONNECT_TIMEOUT_MS,
  getActiveMcpClient: () => _activeMcpClient,
  getActiveHealthyMcpServers,
};
