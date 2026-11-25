// Prove the MCP tool-surface fix on the live app, end to end:
//   1. connect the REA server (263 tools, ≈384 kB of schema)
//   2. a turn must advertise ZERO of those schemas and one `mcp_find_tools`
//   3. the model calls `mcp_find_tools`, gets real schemas back, and can then
//      call the deferred tool by name (dispatch is by name, not by advert)
// A local stub stands in for Anthropic so nothing is spent.
// Usage: node build/probe-mcp-surface.cjs [port]
const http = require('http');
const WebSocket = require('../node_modules/ws');
const { toolDefinitions } = require('../electron/tools');

const PORT = Number(process.argv[2] || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUILTIN = new Set(toolDefinitions.map((t) => t.name));

async function findPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(BASE + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && /dist\/index\.html/.test(t.url || ''));
      if (page) return page;
    } catch (_) {}
    await sleep(500);
  }
  throw new Error('no page target');
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 64e6 });
    let id = 0;
    const pending = new Map();
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw.toString()); } catch (_) { return; }
      if (m.id && pending.has(m.id)) {
        const p = pending.get(m.id); pending.delete(m.id);
        if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result);
      }
    });
    ws.on('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => { pending.set(mid, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
      },
      close() { try { ws.close(); } catch (_) {} },
    }));
    ws.on('error', reject);
  });
}

async function ev(cdp, expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

const sse = (res, events) => {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
};

const textReply = (text) => [
  ['message_start', { type: 'message_start', message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 1000, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1000, output_tokens: 5 } }],
  ['message_stop', { type: 'message_stop' }],
];

const toolReply = (name, input) => [
  ['message_start', { type: 'message_start', message: { id: 'msg_t', role: 'assistant', usage: { input_tokens: 1000, output_tokens: 1 } } }],
  ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01', name, input: {} } }],
  ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
  ['content_block_stop', { type: 'content_block_stop', index: 0 }],
  ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1000, output_tokens: 25 } }],
  ['message_stop', { type: 'message_stop' }],
];

(async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let b = null;
      try { b = JSON.parse(body); } catch (_) {}
      seen.push(b || { raw: body });
      // Turn 1: the model searches for a deferred tool.
      if (seen.length === 1) return sse(res, toolReply('mcp_find_tools', { query: 'native load image' }));
      // Turn 2: it has the schema from the search result.
      if (seen.length === 2) return sse(res, toolReply('mcp__srv1__inspect_native_load_image', { target: 'none' }));
      return sse(res, textReply('mcp index works'));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const stubPort = srv.address().port;

  const page = await findPage();
  const cdp = await connect(page.webSocketDebuggerUrl);

  const cfg = require(require('os').homedir() + '/.claude.json').mcpServers.rea;
  const conn = await ev(cdp, `(async () => {
    const r = await window.autobot.mcpConnect(${JSON.stringify({ name: 'rea', type: 'stdio', command: cfg.command, args: cfg.args, env: cfg.env || {} })});
    const st = await window.autobot.mcpStatus();
    return { serverId: (r && r.serverId) || null, toolCount: (r && (r.tools || []).length) || 0, status: JSON.stringify(st).slice(0, 400) };
  })()`);
  console.log('connect server   :', conn.serverId, '(' + conn.toolCount + ' tools)');

  const runId = 'mcpsurf' + Date.now();
  await ev(cdp, `(() => {
    window.__ms = { done: false, err: null, events: [] };
    const off = window.autobot.onEvent((e) => {
      if (!e || e.runId !== '${runId}') return;
      if (e.type === 'toolCall') window.__ms.events.push('call:' + e.name);
      if (e.type === 'toolResult') window.__ms.events.push('result:' + e.name + ':' + String(e.result || '').slice(0, 400));
      if (e.type === 'complete') { window.__ms.done = true; off(); }
      if (e.type === 'error') { window.__ms.err = e.error || 'error'; window.__ms.done = true; off(); }
    });
    window.autobot.run({
      runId: '${runId}',
      messages: [{ role: 'user', content: 'hi' }],
      provider: { transport: 'anthropic', model: 'claude-sonnet-4-5-20250929', accessToken: 'stub', oauth: true, baseURL: 'http://127.0.0.1:${stubPort}', supportsTools: true, reasoningLevel: 'auto' },
      permissions: 'auto', title: 'mcp surface check',
    }).catch((e) => { window.__ms.err = String(e && e.message || e); window.__ms.done = true; });
    return true;
  })()`);
  let snap = null;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    snap = await ev(cdp, 'window.__ms');
    if (snap.done) break;
  }
  cdp.close();
  srv.close();

  if (!seen.length) { console.log('no request captured'); return; }
  const b = seen[0];
  const tools = b.tools || [];
  const external = tools.filter((t) => String(t.name || '').startsWith('mcp__') && !BUILTIN.has(t.name));
  const meta = tools.filter((t) => t.name === 'mcp_find_tools');
  const sys = Array.isArray(b.system) ? b.system.map((s) => s.text || '').join('\n') : String(b.system || '');
  const all = JSON.stringify(b).length;

  const searchResult = (snap.events || []).find((e) => e.startsWith('result:mcp_find_tools:')) || '';
  const dispatchResult = (snap.events || []).find((e) => e.startsWith('result:mcp__srv1__')) || '';

  console.log('\n--- wire payload (turn 1) ---');
  console.log('requests         :', seen.length);
  console.log('tool count       :', tools.length);
  console.log('external mcp__   :', external.length, external.slice(0, 3).map((t) => t.name).join(', '));
  console.log('mcp_find_tools   :', meta.length ? 'YES' : 'no');
  console.log('tool schema chars:', JSON.stringify(tools).length, '(was 383801)');
  console.log('system chars     :', sys.length);
  console.log('total body chars :', all, '≈', Math.round(all / 3.4), 'tok', '(was 394626 ≈ 116066 tok)');
  console.log('\n--- deferred dispatch ---');
  console.log('events           :', JSON.stringify((snap.events || []).map((e) => e.slice(0, 90))).slice(0, 700));
  console.log('search returned  :', searchResult.slice(0, 260));
  console.log('deferred call    :', dispatchResult.slice(0, 200) || '(none)');
  console.log('\nPASS             :', [
    external.length === 0 ? 'zero-advertised✓' : 'zero-advertised✗',
    meta.length === 1 ? 'search-tool✓' : 'search-tool✗',
    all < 120000 ? 'payload-small✓' : 'payload-small✗',
    /mcp__srv1__/.test(searchResult) ? 'search-schemas✓' : 'search-schemas✗',
    /result:mcp__srv1__/.test(dispatchResult) ? 'deferred-callable✓' : 'deferred-callable✗',
  ].join(' '));
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
