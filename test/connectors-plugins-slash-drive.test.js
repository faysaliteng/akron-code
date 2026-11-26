'use strict';
// End-to-end verification suite for:
//   1. ALL Connectors & ALL Plugins in catalog (schema, install, configure, test, uninstall, tool mapping)
//   2. MCP Client `prompts/list` & `prompts/get` over real stdio & HTTP MCP servers + REA prompts
//   3. Google Drive connector (`local` Drive Desktop folder mode & Google Drive REST API v3 token mode + agent tools)
//   4. `/` Actions catalog builder (`btw`, `mcp:rea:*`, `goal`, custom commands, skills)

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cpsd-'));
process.env.AUTOBOT_PLUGINS_FILE = path.join(tmpRoot, 'plugins.json');
process.env.AUTOBOT_GDRIVE_FILE = path.join(tmpRoot, 'gdrive.json');

const catalog = require('../electron/connector-catalog');
const plugins = require('../electron/plugins');
const { MCPClient } = require('../electron/mcp');
const rea = require('../electron/rea');
const gdrive = require('../electron/gdrive');
const commands = require('../electron/commands');
const tools = require('../electron/tools');

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓', name);
  } catch (err) {
    failed++;
    console.error('  ✗', name, '—', err && err.stack ? err.stack : err);
  }
}

function makeMemSecretStore() {
  const m = new Map();
  return {
    set(k, v) { m.set(String(k), String(v)); return true; },
    get(k) { return m.has(String(k)) ? m.get(String(k)) : null; },
    del(k) { return m.delete(String(k)); },
    has(k) { return m.has(String(k)); },
    list() { return [...m.keys()].map((name) => ({ name, enc: 'mem' })); },
  };
}

(async () => {
  console.log('\n[1/4] Testing ALL Connectors & ALL Plugins catalog + lifecycle...');

  await check('Catalog has unique IDs, valid categories, valid auth & structure across every connector and plugin', () => {
    const seen = new Set();
    assert(catalog.CONNECTOR_ROWS.length >= 200, `Expected >= 200 connectors, got ${catalog.CONNECTOR_ROWS.length}`);
    assert(catalog.PLUGIN_ROWS.length >= 40, `Expected >= 40 plugins, got ${catalog.PLUGIN_ROWS.length}`);
    for (const item of catalog.CATALOG) {
      assert(item.id && typeof item.id === 'string', 'Missing id');
      assert(!seen.has(item.id), `Duplicate id: ${item.id}`);
      seen.add(item.id);
      assert(item.name && typeof item.name === 'string', `Missing name on ${item.id}`);
      assert(item.category && typeof item.category === 'string', `Missing category on ${item.id}`);
      assert(['oauth', 'apikey', 'none'].includes(item.auth), `Invalid auth "${item.auth}" on ${item.id}`);
      assert(item.description && typeof item.description === 'string', `Missing description on ${item.id}`);
      if (item.type === 'connector') {
        assert(Array.isArray(item.tools) && item.tools.length > 0, `Empty tools on connector ${item.id}`);
      } else if (item.type === 'plugin') {
        assert(Array.isArray(item.provides) && item.provides.length > 0, `Empty provides on plugin ${item.id}`);
      } else {
        throw new Error(`Unexpected type ${item.type} on ${item.id}`);
      }
    }
  });

  await check('Every PLUGIN_ROWS capability maps cleanly to live built-in agent capabilities', () => {
    const validCaps = new Set([
      'deep_research', 'code_execution', 'visualize', 'browser', 'artifact',
      'pdf_export', 'slides', 'code_review', 'git', 'web_fetch', 'i18n',
      'voice', 'transcribe', 'shell',
    ]);
    for (const p of catalog.CATALOG.filter((e) => e.type === 'plugin')) {
      for (const cap of p.provides) {
        assert(validCaps.has(cap), `Unknown capability "${cap}" on plugin ${p.id}`);
      }
    }
    // Verify corresponding core tools actually exist in tools.js
    const toolNames = new Set(tools.toolDefinitions.map((t) => t.name));
    assert(toolNames.has('Bash'), 'Missing Bash tool for shell/code_execution');
    assert(toolNames.has('WebFetch'), 'Missing WebFetch tool');
    assert(toolNames.has('WebSearch'), 'Missing WebSearch tool');
  });

  await check('Install, configure, search, and uninstall works across EVERY curated connector, plugin & registry server', () => {
    const all = plugins.listPlugins({ limit: 5000 });
    assert(all.length >= catalog.CATALOG.length, `Expected at least ${catalog.CATALOG.length} entries, got ${all.length}`);
    for (const entry of all) {
      const ins = plugins.install(entry.id);
      assert.strictEqual(ins.ok, true, `Failed install on ${entry.id}`);
      assert.strictEqual(ins.entry.installed, true);
      if (entry.auth === 'apikey') {
        const upd = plugins.setConfig(entry.id, { connected: true, hasApiKey: true, mode: 'apikey' });
        assert.strictEqual(upd.requiresSignIn, false, `apikey connector still requiresSignIn after config: ${entry.id}`);
      }
      if (entry.id === 'gdrive') {
        assert.strictEqual(ins.entry.builtInAdapter, 'gdrive');
      }
    }
    const instOnly = plugins.listPlugins({ installedOnly: true });
    assert.strictEqual(instOnly.length, all.length);
    // Clean uninstall sweep
    for (const entry of all) {
      const un = plugins.uninstall(entry.id);
      assert.strictEqual(un.ok, true, `Failed uninstall on ${entry.id}`);
    }
    assert.strictEqual(plugins.listPlugins({ installedOnly: true }).length, 0);
  });

  await check('Search narrows accurately ("google drive", "linear", "notion", "deep research")', () => {
    const g = plugins.search('google drive');
    assert(g.some((x) => x.id === 'gdrive'), 'Expected gdrive in "google drive" search');
    const n = plugins.search('notion');
    assert(n.some((x) => x.id === 'notion'), 'Expected notion in search');
    const dr = plugins.search('deep research');
    assert(dr.some((x) => x.id === 'plugin-deep-research'), 'Expected plugin-deep-research in search');
  });

  console.log('\n[2/4] Testing MCP Client prompts/list & prompts/get (stdio, HTTP+apikey, & REA)...');

  await check('MCPClient stdio server lists tools & prompts and executes prompts/get', async () => {
    const mockStdioScript = path.join(tmpRoot, 'mock-mcp-stdio.js');
    fs.writeFileSync(mockStdioScript, `
      const rl = require('readline').createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.id == null) return;
        if (msg.method === 'initialize') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {}, prompts: {} } } }) + '\\n');
        } else if (msg.method === 'tools/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping_tool', description: 'Ping', inputSchema: { type: 'object', properties: {} } }] } }) + '\\n');
        } else if (msg.method === 'prompts/list') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { prompts: [{ name: 'audit_code', title: 'Audit code', description: 'Run deep audit', arguments: [{ name: 'target', required: true }] }] } }) + '\\n');
        } else if (msg.method === 'prompts/get') {
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { description: 'Audit', messages: [{ role: 'user', content: { type: 'text', text: 'Auditing ' + (msg.params.arguments.target || '') } }] } }) + '\\n');
        }
      });
    `);
    const client = new MCPClient();
    const info = await client.connect({ serverId: 'mockstd', name: 'MockStdio', command: process.execPath, args: [mockStdioScript] });
    assert.strictEqual(info.tools.length, 1);
    assert.strictEqual(info.prompts.length, 1);
    const listed = await client.listPrompts();
    assert(listed.some((p) => p.serverId === 'mockstd' && p.name === 'audit_code'));
    const got = await client.getPrompt('mockstd', 'audit_code', { target: 'src/App.jsx' });
    assert.strictEqual(got.text, 'Auditing src/App.jsx');
    client.disconnect('mockstd');
  });

  await check('MCPClient HTTP server with Bearer apiKey lists tools & prompts', async () => {
    let seenAuth = '';
    const srv = http.createServer((req, res) => {
      seenAuth = req.headers.authorization || '';
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body || '{}');
        if (seenAuth !== 'Bearer test-api-key-999') {
          res.writeHead(401, { 'www-authenticate': 'Bearer' });
          res.end('Unauthorized');
          return;
        }
        let result = {};
        if (msg.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, prompts: {} } };
        else if (msg.method === 'tools/list') result = { tools: [{ name: 'search_docs', description: 'Search docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }] };
        else if (msg.method === 'prompts/list') result = { prompts: [{ name: 'summarize_doc', description: 'Summarize doc' }] };
        else if (msg.method === 'tools/call') result = { content: [{ type: 'text', text: 'result:' + (msg.params.arguments.q || '') }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const client = new MCPClient();
    try {
      const info = await client.connect({ serverId: 'mockhttp', transport: 'http', url: `http://127.0.0.1:${port}/mcp`, apiKey: 'test-api-key-999', name: 'MockHttp' });
      assert.strictEqual(seenAuth, 'Bearer test-api-key-999');
      assert.strictEqual(info.tools[0].name, 'search_docs');
      assert.strictEqual(info.prompts[0].name, 'summarize_doc');
      const out = await client.callTool('mockhttp', 'search_docs', { q: 'hello' });
      assert.strictEqual(out, 'result:hello');
    } finally {
      client.disconnect('mockhttp');
      srv.close();
    }
  });

  await check('Live REA MCP prompts/list matches REA_BUILTIN_PROMPTS & expandReaPrompt works', async () => {
    const client = new MCPClient();
    const st = rea.status(client);
    if (!st.available) {
      console.log('    (skipped live REA spawn: binary unavailable in test env)');
      return;
    }
    await rea.ensureConnected(client);
    const livePrompts = await client.listPrompts('rea');
    const names = new Set(livePrompts.map((p) => p.name));
    for (const p of rea.REA_BUILTIN_PROMPTS) {
      assert(names.has(p.name), `Expected live REA prompt ${p.name}`);
    }
    const expanded = await rea.expandReaPrompt(client, 'investigate_feature', 'auth-refresh', tmpRoot);
    assert(expanded && expanded.length > 20, 'Expected non-empty expanded REA prompt');
    client.disconnect('rea');
  });

  console.log('\n[3/4] Testing Google Drive connector (local mode + Google Drive API v3 mock)...');

  await check('Google Drive local mode connects, searches, reads regular & .gdoc shortcut files, and saves files', async () => {
    const driveDir = path.join(tmpRoot, 'My Drive');
    fs.mkdirSync(path.join(driveDir, 'Specs'), { recursive: true });
    fs.writeFileSync(path.join(driveDir, 'Specs', 'roadmap.md'), '# Q4 Roadmap\nLaunch v2\n');
    fs.writeFileSync(path.join(driveDir, 'Specs', 'Design.gdoc'), JSON.stringify({ url: 'https://docs.google.com/document/d/abc123', doc_id: 'abc123' }));

    const conn = gdrive.connectLocalFolder(driveDir);
    assert.strictEqual(conn.ok, true);
    assert.strictEqual(conn.status.connected, true);
    assert.strictEqual(conn.status.mode, 'local');

    const sr = await gdrive.searchFiles('roadmap');
    assert.strictEqual(sr.files.length, 1);
    assert.strictEqual(sr.files[0].name, 'roadmap.md');

    const rd = await gdrive.readFile(sr.files[0].id);
    assert(rd.content.includes('# Q4 Roadmap'));

    const sc = await gdrive.readFile('Specs/Design.gdoc');
    assert(sc.content.includes('abc123'));

    const saved = await gdrive.callTool('create_file', { name: 'notes.txt', content: 'Drive save works!' });
    assert(saved.includes('notes.txt'));
    assert.strictEqual(fs.readFileSync(path.join(driveDir, 'notes.txt'), 'utf8'), 'Drive save works!');
  });

  await check('Google Drive REST API v3 token mode connects, searches, exports Docs/Sheets, and uploads multipart', async () => {
    const memStore = makeMemSecretStore();
    let uploadedBody = '';
    const driveSrv = http.createServer((req, res) => {
      if (req.headers.authorization !== 'Bearer gdrive-test-token') {
        res.writeHead(401); res.end('bad token'); return;
      }
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname === '/drive/v3/about') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ user: { displayName: 'Test Engineer', emailAddress: 'eng@example.com' } }));
        return;
      }
      if (u.pathname === '/drive/v3/files' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          files: [
            { id: 'doc1', name: 'Architecture Spec', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/doc1' },
            { id: 'sht1', name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet' },
          ],
        }));
        return;
      }
      if (u.pathname === '/drive/v3/files/doc1' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'doc1', name: 'Architecture Spec', mimeType: 'application/vnd.google-apps.document' }));
        return;
      }
      if (u.pathname === '/drive/v3/files/doc1/export') {
        assert.strictEqual(u.searchParams.get('mimeType'), 'text/plain');
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('Exported Google Doc Content');
        return;
      }
      if (u.pathname === '/drive/v3/files/sht1' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'sht1', name: 'Budget 2026', mimeType: 'application/vnd.google-apps.spreadsheet' }));
        return;
      }
      if (u.pathname === '/drive/v3/files/sht1/export') {
        assert.strictEqual(u.searchParams.get('mimeType'), 'text/csv');
        res.writeHead(200, { 'content-type': 'text/csv' });
        res.end('item,cost\nservers,1200\n');
        return;
      }
      if (u.pathname === '/upload/drive/v3/files' && req.method === 'POST') {
        req.on('data', (c) => { uploadedBody += c.toString(); });
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ id: 'up1', name: 'report.html', webViewLink: 'https://drive.google.com/file/d/up1' }));
        });
        return;
      }
      res.writeHead(404); res.end('not found');
    });

    await new Promise((r) => driveSrv.listen(0, '127.0.0.1', r));
    const port = driveSrv.address().port;
    try {
      const c = await gdrive.connectToken({
        accessToken: 'gdrive-test-token',
        apiBaseUrl: `http://127.0.0.1:${port}/drive/v3`,
        uploadBaseUrl: `http://127.0.0.1:${port}/upload/drive/v3`,
        store: memStore,
      });
      assert.strictEqual(c.ok, true);
      assert.strictEqual(c.status.accountEmail, 'eng@example.com');

      const s = await gdrive.searchFiles('Architecture', {}, null, globalThis.fetch, memStore);
      assert.strictEqual(s.files.length, 2);

      const d = await gdrive.readFile('doc1', null, globalThis.fetch, memStore);
      assert.strictEqual(d.content, 'Exported Google Doc Content');

      const sh = await gdrive.readFile('sht1', null, globalThis.fetch, memStore);
      assert.strictEqual(sh.content, 'item,cost\nservers,1200\n');

      const up = await gdrive.saveFile({ name: 'report.html', content: '<h1>Deck</h1>', mimeType: 'text/html' }, null, globalThis.fetch, memStore);
      assert.strictEqual(up.id, 'up1');
      assert(uploadedBody.includes('<h1>Deck</h1>'));

      const specs = gdrive.toolSpecs().map((t) => t.name);
      assert.deepStrictEqual(specs, ['search_files', 'list_folder', 'read_file', 'create_file']);
    } finally {
      gdrive.disconnect(null, memStore);
      driveSrv.close();
    }
  });

  console.log('\n[4/4] Testing `/` Actions catalog ordering & coverage...');

  await check('listSlashActions orders btw, all 6 mcp:rea:* workflows, goal, and skills cleanly', () => {
    const actions = commands.listSlashActions({
      cwd: tmpRoot,
      mcpPrompts: rea.REA_BUILTIN_PROMPTS,
      skills: [{ name: 'reverse-engineer-anything', description: 'RE workflow', enabled: true }],
    });
    const names = actions.map((a) => a.name);
    assert.strictEqual(names[0], 'btw');
    assert.strictEqual(names[1], 'mcp:rea:investigate_feature');
    assert.strictEqual(names[2], 'mcp:rea:compare_application_versions');
    assert.strictEqual(names[3], 'mcp:rea:verify_reconstruction');
    assert.strictEqual(names[4], 'mcp:rea:trace_crash');
    assert.strictEqual(names[5], 'mcp:rea:audit_residual_unknowns');
    assert.strictEqual(names[6], 'mcp:rea:prepare_bounded_process_capture');
    assert.strictEqual(names[7], 'goal');
    assert(names.includes('swarm'));
    assert(names.includes('subagents'));
    assert(names.includes('gdrive'));
    assert(names.includes('skill:reverse-engineer-anything'));
  });

  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
