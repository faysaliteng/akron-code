'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const extbridge = require('../electron/extbridge');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });
}

function sendMcpReq(child, msg) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const lines = buf.split('\n');
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === msg.id) {
            child.stdout.off('data', onData);
            resolve(parsed);
            return;
          }
        } catch (_) {}
      }
      buf = lines[lines.length - 1];
    };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      child.stdout.off('data', onData);
      reject(new Error(`Timeout waiting for MCP id=${msg.id}`));
    }, 4000);
  });
}

test('Phase 6: standalone MCP yields bridge port cleanly to Akron Code Desktop primary', async () => {
  const mcpServerPath = path.join(os.homedir(), '.gemini', 'config', 'plugins', 'akron-web-bot', 'server', 'mcp-server.mjs');
  const fs = require('node:fs');
  if (!fs.existsSync(mcpServerPath)) {
    return;
  }

  const port = await getFreePort();
  const child = spawn(process.execPath, [mcpServerPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, AKRON_BRIDGE_PORT: String(port) },
  });

  try {
    await sendMcpReq(child, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1.0' } },
    });
    const st = await sendMcpReq(child, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'akron_web_bot_status', arguments: {} },
    });
    assert.ok(st.result);

    const h1 = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
    assert.strictEqual(h1.ok, true);
    assert.strictEqual(h1.mode, 'mcp-standalone');

    const modelsRes = await fetch(`http://127.0.0.1:${port}/v1/models`).then((r) => r.json());
    assert.strictEqual(modelsRes.object, 'list');
    assert.ok(Array.isArray(modelsRes.data));

    // Now start Desktop extbridge on the same port -> should yield & reclaim cleanly
    const desktopStart = await extbridge.start({ port });
    assert.strictEqual(desktopStart.ok, true);
    assert.strictEqual(desktopStart.reclaimedFromStandalone, true);
    assert.strictEqual(desktopStart.port, port);

    const h2 = await fetch(`http://127.0.0.1:${port}/v1/health`).then((r) => r.json());
    assert.strictEqual(h2.ok, true);
    assert.strictEqual(h2.mode, 'desktop-primary');

    // Both /v1/models and /models + /v1/chat/completions and /chat/completions must be handled (never 404)
    const m1 = await fetch(`http://127.0.0.1:${port}/v1/models`);
    const m2 = await fetch(`http://127.0.0.1:${port}/models`);
    assert.strictEqual(m1.status, 200);
    assert.strictEqual(m2.status, 200);

    const c1 = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'akron-default', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    const c2 = await fetch(`http://127.0.0.1:${port}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'akron-default', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
    assert.notStrictEqual(c1.status, 404, '/v1/chat/completions must never return 404');
    assert.notStrictEqual(c2.status, 404, '/chat/completions must never return 404');
  } finally {
    try { await extbridge.stop(); } catch (_) {}
    try { child.kill('SIGTERM'); } catch (_) {}
  }
});
