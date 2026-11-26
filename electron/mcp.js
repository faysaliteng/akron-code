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
  constructor(opts) {
    this.servers = new Map(); // serverId -> entry
    this.nextServerId = 1;
    // async (url) => bearer token | null — supplied by main.js so OAuth-gated
    // hosted servers authenticate without the caller passing a header.
    this.authProvider = (opts && opts.authProvider) || null;
  }

  async connect(cfg) {
    cfg = cfg || {};
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
    };
    const post = async (body) => {
      const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
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
      const msg = ct.includes('text/event-stream') ? await parseSSE(res) : await res.json();
      if (msg && typeof msg === 'object' && Object.prototype.hasOwnProperty.call(msg, 'jsonrpc')) {
        if (msg.error) throw new Error(msg.error.message || 'MCP error');
        return msg.result !== undefined ? msg.result : msg;
      }
      return msg;
    };
    entry.post = post;
    this.servers.set(serverId, entry);

    const initTimeout = Number(cfg.initTimeoutMs) || 30000;
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
      const pr = await this._request(serverId, 'prompts/list', {}, Math.min(initTimeout, 5000));
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
    const entry = { type: 'stdio', proc, nextId: 1, tools: [], fullTools: [], prompts: [], name: cfg.name || command, pending: new Map(), stderr: () => stderr, exited: false };
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

    const initTimeout = Number(cfg.initTimeoutMs) || 30000;
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
        const pr = await this._request(serverId, 'prompts/list', {}, Math.min(initTimeout, 5000));
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
      return entry.post({ jsonrpc: '2.0', id, method, params });
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
