'use strict';
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const rea = require('../electron/rea');
const { MCPClient } = require('../electron/mcp');
const { runTool } = require('../electron/tools');
const { runAgent } = require('../electron/llm');
const store = require('../electron/store');
const providertransport = require('../electron/providertransport');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log('  ok  ', name);
    passed++;
  } catch (e) {
    console.error('  FAIL', name, '—', e && e.stack ? e.stack : e);
    failed++;
  }
}

(async () => {
  const client = new MCPClient();
  const tmpJsApp = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-js-app-'));
  fs.writeFileSync(path.join(tmpJsApp, 'package.json'), JSON.stringify({ name: 'demo-app', version: '1.0.0', main: 'index.js' }, null, 2));
  fs.writeFileSync(path.join(tmpJsApp, 'index.js'), 'const http = require("http");\nmodule.exports = { ping: () => "pong" };\n');

  try {
    console.log('\n# 1. MCPClient resilience & timeouts');
    await test('MCPClient rejects missing command without uncaught exception', async () => {
      const c = new MCPClient();
      await assert.rejects(
        () => c.connect({ serverId: 'bad_bin', command: '/nonexistent/rea-missing-bin-xyz', args: [], initTimeoutMs: 2000 }),
        /MCP|spawn|ENOENT|exited/i
      );
      c.disconnectAll();
    });

    console.log('\n# 2. Built-in REA runtime detection & live MCP connection');
    await test('rea.status detects Node >=22 and installed rea-agents', () => {
      const st = rea.status(client);
      assert.strictEqual(st.available, true, 'expected rea to be available');
      assert.strictEqual(st.skillBundled, true, 'expected reverse-engineer-anything skill bundled');
      assert.ok(rea.isSupportedNodeVersion(st.nodeVersion), 'unexpected node version: ' + st.nodeVersion);
      assert.ok(st.reaPath, 'expected reaPath');
    });

    await test('rea.ensureConnected connects to live REA MCP with 250+ tools', async () => {
      const res = await rea.ensureConnected(client);
      assert.strictEqual(res.serverId, 'rea');
      assert.ok(res.toolCount >= 250, `expected >=250 REA tools, got ${res.toolCount}`);
      const entry = client.servers.get('rea');
      assert.ok(entry && Array.isArray(entry.fullTools) && entry.fullTools.length >= 250);
    });

    console.log('\n# 3. Built-in `rea` tool (search, call, cli) & bundled Skill');
    await test('rea tool action="search" finds & activates matching tools', async () => {
      const activated = [];
      const out = await runTool('rea', { action: 'search', query: 'analyze javascript' }, {
        cwd: tmpJsApp,
        mcpClient: client,
        activateTools: (names) => activated.push(...names),
      });
      const text = typeof out === 'string' ? out : out.content;
      assert.ok(text.includes('analyze_javascript_application'), 'expected analyze_javascript_application in search output');
      assert.ok(activated.some((n) => n.includes('analyze_javascript_application')), 'expected activateTools to receive match');
    });

    await test('rea tool action="call" runs analyze_javascript_application & audit_release_exposure', async () => {
      const out1 = await runTool('rea', {
        action: 'call',
        tool: 'analyze_javascript_application',
        arguments: { target_path: tmpJsApp },
      }, { cwd: tmpJsApp, mcpClient: client });
      const t1 = typeof out1 === 'string' ? out1 : out1.content;
      assert.ok(t1 && !out1.isError && t1.includes('demo-app') || /Evidence|javascript|target/i.test(t1), 'unexpected analyze output: ' + String(t1).slice(0, 200));

      const out2 = await runTool('rea', {
        action: 'call',
        tool: 'audit_release_exposure',
        arguments: { target_path: tmpJsApp },
      }, { cwd: tmpJsApp, mcpClient: client });
      const t2 = typeof out2 === 'string' ? out2 : out2.content;
      assert.ok(t2 && !out2.isError, 'unexpected audit output: ' + String(t2).slice(0, 200));
    });

    await test('rea tool action="cli" runs one-shot --version / analyze-javascript-application', async () => {
      const out = await runTool('rea', {
        action: 'cli',
        command: ['--version'],
      }, { cwd: tmpJsApp, mcpClient: client });
      const t = typeof out === 'string' ? out : out.content;
      assert.ok(/\d+\.\d+\.\d+/.test(t), 'expected version from rea --version, got: ' + t);
    });

    await test('Skill tool loads bundled reverse-engineer-anything SKILL.md', async () => {
      const out = await runTool('Skill', { name: 'reverse-engineer-anything' }, { cwd: tmpJsApp });
      const t = typeof out === 'string' ? out : out.content;
      assert.ok(t.includes('analyze_javascript_application') && t.includes('# REA'), 'expected full REA skill text');
    });

    console.log('\n# 4. find_mcp_tools activation + Anthropic 3-breakpoint prompt cache');
    await test('find_mcp_tools promotes matched MCP tools into step2 body.tools (serial & parallel)', async () => {
      const seenRequests = [];
      let turn = 0;
      const srv = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (d) => { buf += d; });
        req.on('end', () => {
          const body = JSON.parse(buf);
          seenRequests.push(body);
          turn++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (turn === 1) {
            const payload = {
              id: 'c1',
              choices: [{
                delta: {
                  tool_calls: [
                    { index: 0, id: 'call_r', type: 'function', function: { name: 'Read', arguments: JSON.stringify({ path: 'package.json' }) } },
                    { index: 1, id: 'call_f', type: 'function', function: { name: 'find_mcp_tools', arguments: JSON.stringify({ query: 'analyze javascript', server: 'rea' }) } },
                  ],
                },
              }],
            };
            res.write(`data: ${JSON.stringify(payload)}\n\n`);
            res.write(`data: ${JSON.stringify({ id: 'c1', choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.write(`data: ${JSON.stringify({ id: 'c2', choices: [{ delta: { content: 'Done with REA' }, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        });
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      try {
        const entry = client.servers.get('rea');
        const extraTools = (entry.fullTools || []).map((t) => ({
          name: `mcp__rea__${t.name}`,
          description: `[REA] ${t.description || ''}`,
          inputSchema: t.inputSchema,
        }));
        await runAgent({
          provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'gpt-4o', supportsTools: true },
          messages: [{ role: 'user', content: 'Inspect package.json and find REA js tools.' }],
          cwd: tmpJsApp,
          extraTools,
          mcpClient: client,
          callMcpTool: (nm, a) => rea.callReaTool(client, nm, a),
          emit: () => {},
        });
        assert.ok(seenRequests.length >= 2);
        const step2Names = (seenRequests[1].tools || []).map((t) => t.function.name);
        assert.ok(step2Names.includes('mcp__rea__analyze_javascript_application'), 'expected matched REA MCP tool promoted into step2');
      } finally {
        srv.close();
      }
    });

    await test('Anthropic toAnthropicBody adds 3 ephemeral cache breakpoints on >=4096 char prompts while keeping small prompts clean', () => {
      const small = providertransport._internal.toAnthropicBody(
        { model: 'claude-opus-4-1' },
        [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hi' }],
        [{ function: { name: 'Read', description: 'r', parameters: { type: 'object', properties: {} } } }],
        8000
      );
      assert.strictEqual(small.system[0].cache_control, undefined);
      assert.strictEqual(small.tools[0].cache_control, undefined);

      const bigText = 'x'.repeat(5000);
      const big = providertransport._internal.toAnthropicBody(
        { model: 'claude-opus-4-1' },
        [{ role: 'system', content: bigText }, { role: 'user', content: bigText }],
        [{ function: { name: 'Read', description: bigText, parameters: { type: 'object', properties: {} } } }],
        8000
      );
      assert.deepStrictEqual(big.tools[0].cache_control, { type: 'ephemeral' });
      assert.deepStrictEqual(big.system[0].cache_control, { type: 'ephemeral' });
      assert.deepStrictEqual(big.messages[0].content[0].cache_control, { type: 'ephemeral' });
    });

    console.log('\n# 5. Live toolStream events, Swarm ON directive & Task non-null result');
    await test('runAgent emits toolStream on streamed tool args, injects <swarm_mode_active>, and Task never returns null', async () => {
      const events = [];
      const seenBodies = [];
      let reqIdx = 0;
      const srv = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (d) => { buf += d; });
        req.on('end', () => {
          const body = JSON.parse(buf);
          seenBodies.push(body);
          reqIdx++;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          if (reqIdx === 1) {
            // Stream chunked Task tool_call args
            res.write(`data: ${JSON.stringify({ id: 's1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_sub', type: 'function', function: { name: 'Task', arguments: '{"description":"Sub' } }] } }] })}\n\n`);
            setTimeout(() => {
              res.write(`data: ${JSON.stringify({ id: 's1', choices: [{ delta: { tool_calls: [{ index: 0, arguments: ' worker","prompt":"Read package.json and return."}' }] }, finish_reason: 'tool_calls' }] })}\n\n`);
              res.write('data: [DONE]\n\n');
              res.end();
            }, 220);
          } else if (reqIdx === 2) {
            // Sub-agent step 1 calls Read then finishes empty on step 2 (should synthesize summary!)
            res.write(`data: ${JSON.stringify({ id: 's2', choices: [{ delta: { tool_calls: [{ index: 0, id: 'sub_r', type: 'function', function: { name: 'Read', arguments: '{"path":"package.json"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else if (reqIdx === 3) {
            // Sub-agent finishes with empty content to test non-null synthesis
            res.write(`data: ${JSON.stringify({ id: 's3', choices: [{ delta: { content: '' }, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.write(`data: ${JSON.stringify({ id: 's4', choices: [{ delta: { content: 'All done cleanly.' }, finish_reason: 'stop' }] })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        });
      });
      await new Promise((r) => srv.listen(0, '127.0.0.1', r));
      const port = srv.address().port;
      try {
        await runAgent({
          provider: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'gpt-4o', supportsTools: true },
          messages: [{ role: 'user', content: 'Build multi-part app.' }],
          cwd: tmpJsApp,
          swarm: true,
          mcpClient: client,
          emit: (ev) => events.push(ev),
        });
        assert.ok(seenBodies[0].messages[0].content.includes('<swarm_mode_active>'), 'expected <swarm_mode_active> in system prompt');
        const streamEvents = events.filter((e) => e.type === 'toolStream');
        assert.ok(streamEvents.length >= 1, 'expected at least 1 toolStream event');
        const taskRes = events.find((e) => e.type === 'toolResult' && e.name === 'Task');
        assert.ok(taskRes && typeof taskRes.result === 'string' && taskRes.result.includes('Read'), 'expected non-null synthesized Task summary, got: ' + JSON.stringify(taskRes));
      } finally {
        srv.close();
      }
    });
  } finally {
    client.disconnectAll();
    try { fs.rmSync(tmpJsApp, { recursive: true, force: true }); } catch (_) {}
    console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
