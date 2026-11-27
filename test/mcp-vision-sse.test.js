'use strict';
const assert = require('assert');
const http = require('http');
const { MCPClient } = require('../electron/mcp');

let pass = 0;
async function check(name, fn) {
  await fn();
  pass++;
  console.log('  ✓ ' + name);
}

(async () => {
  console.log('\nmcp-vision-sse tests');

  await check('MCPClient HTTP handles multi-event SSE and returns matching JSON-RPC id + imageDataUrl', async () => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        const rpc = JSON.parse(body || '{}');
        if (rpc.method === 'initialize') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: {} } }));
          return;
        }
        if (rpc.method === 'tools/list') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { tools: [{ name: 'snap', description: 'take shot', inputSchema: { type: 'object' } }] } }));
          return;
        }
        if (rpc.method === 'tools/call') {
          // Multi-event SSE stream: notification frame followed by matching JSON-RPC result containing text + PNG image
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progress":50}}\n\n');
          res.write(`event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: rpc.id,
            result: {
              content: [
                { type: 'text', text: 'Captured dashboard' },
                { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
              ],
            },
          })}\n\n`);
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
      });
    });

    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    try {
      const client = new MCPClient();
      const conn = await client.connect({ url, transport: 'http', name: 'TestHTTP' });
      assert.strictEqual(conn.tools.length, 1);
      const out = await client.callTool(conn.serverId, 'snap', {});
      assert.strictEqual(typeof out, 'object');
      assert.ok(out.content.includes('Captured dashboard'));
      assert.strictEqual(out.imageDataUrl, 'data:image/png;base64,iVBORw0KGgo=');
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  await check('MCPClient HTTP honours timeoutMs via AbortSignal.timeout', async () => {
    const srv = http.createServer((_req, _res) => { /* intentionally hang */ });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    try {
      const client = new MCPClient();
      await assert.rejects(() => client.connect({ url, transport: 'http', initTimeoutMs: 120 }), /timed out|aborted/i);
    } finally {
      await new Promise((r) => srv.close(r));
    }
  });

  console.log(`\n${pass} passed, 0 failed`);
})();
