'use strict';
const { spawn } = require('child_process');

// Minimal Model Context Protocol client.
// Transports: stdio (spawn), SSE, and streamable-HTTP.
// JSON-RPC 2.0; tool/resource calls mapped back to the agent.

async function parseSSE(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const dataLines = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      const t = line.trim();
      if (t.startsWith('data:')) dataLines.push(t.slice(5).trim());
    }
  }
  const payload = dataLines.filter(Boolean).join('\n');
  if (!payload || payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch { return { _raw: payload }; }
}

class MCPClient {
  constructor() {
    this.servers = new Map(); // serverId -> entry
    this.nextServerId = 1;
  }

  async connect(cfg) {
    cfg = cfg || {};
    if (cfg.url && (cfg.transport === 'sse' || cfg.transport === 'http')) {
      return this._connectHttp(cfg);
    }
    return this._connectStdio(cfg);
  }

  async _connectHttp(cfg) {
    const serverId = 'srv' + this.nextServerId++;
    const url = cfg.url;
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(cfg.headers || {}) };
    const entry = {
      type: 'http', url, headers, nextId: 1, tools: [], name: cfg.name || url,
      pending: new Map(), stderr: () => '', sessionId: null,
    };
    const post = async (body) => {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        throw new Error(`MCP HTTP ${res.status}: ${t.slice(0, 200)}`);
      }
      const sid = res.headers.get('mcp-session-id');
      if (sid) { entry.sessionId = sid; headers['mcp-session-id'] = sid; }
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/event-stream')) return await parseSSE(res);
      return await res.json();
    };
    entry.post = post;
    this.servers.set(serverId, entry);

    await this._request(serverId, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'autobot', version: '1.0.0' },
    });
    this._notify(serverId, 'notifications/initialized', {});
    let tools = [];
    try {
      const r = await this._request(serverId, 'tools/list', {});
      tools = (r && r.tools) || [];
    } catch (_) {}
    entry.tools = tools.map((t) => t.name);
    return { serverId, name: entry.name, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  }

  async _connectStdio(cfg) {
    const { command, args = [], env = {}, cwd } = cfg;
    const serverId = 'srv' + this.nextServerId++;
    const proc = spawn(command, args, {
      cwd: cwd || undefined,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const entry = { type: 'stdio', proc, nextId: 1, tools: [], name: command, pending: new Map(), stderr: () => stderr };
    this.servers.set(serverId, entry);

    let buffer = '';
    proc.stdout.on('data', (d) => {
      buffer += d.toString();
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id != null && entry.pending.has(msg.id)) {
          const { resolve, reject } = entry.pending.get(msg.id);
          entry.pending.delete(msg.id);
          if (msg.error) reject(new Error(msg.error.message || 'MCP error'));
          else resolve(msg.result);
        }
      }
    });

    proc.on('exit', (code) => {
      for (const [, p] of entry.pending) p.reject(new Error('MCP server exited (code ' + code + ')'));
      entry.pending.clear();
      entry.exited = true;
    });

    await this._request(serverId, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'autobot', version: '1.0.0' },
    });
    this._notify(serverId, 'notifications/initialized', {});
    let tools = [];
    try {
      const r = await this._request(serverId, 'tools/list', {});
      tools = (r && r.tools) || [];
    } catch (_) {}
    entry.tools = tools.map((t) => t.name);
    return { serverId, name: command, tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
  }

  _request(serverId, method, params) {
    const entry = this.servers.get(serverId);
    if (!entry) return Promise.reject(new Error('server not found'));
    if (entry.type === 'http') {
      const id = entry.nextId++;
      return entry.post({ jsonrpc: '2.0', id, method, params });
    }
    const id = entry.nextId++;
    return new Promise((resolve, reject) => {
      entry.pending.set(id, { resolve, reject });
      entry.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
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
    return content
      .map((c) => {
        if (c.type === 'text') return c.text;
        if (c.type === 'image') return `[image: ${c.mimeType || 'image'}]`;
        return JSON.stringify(c);
      })
      .join('\n');
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

module.exports = { MCPClient };
