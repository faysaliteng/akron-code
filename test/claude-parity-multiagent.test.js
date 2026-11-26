'use strict';
process.env.HELIO_BACKOFF_MS = '20';
// End-to-end verification of Claude App / Claude Code parity upgrades:
// 1. TodoWrite in_progress + activeForm
// 2. Wave-based concurrent tool execution around mutating Edit calls
// 3. Task/Agent resume (persisted transcript + TaskOutput file), fork_context, max_turns
// 4. Built-in verifier & code-reviewer subagent resolution
// 5. Live in-process SendMessage inbox delivery between steps + shutdown_request abort
// 6. Per-agent readMtimes stale-file guard + instant post-Write/Edit syntax diagnostics
// 7. Multimodal image Read + 400 fallback for text-only providers

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const llm = require('../electron/llm');
const tools = require('../electron/tools');
const agentdefs = require('../electron/agentdefs');
const parity = require('../electron/parity');
const tasksMod = require('../electron/tasks');
const router = require('../electron/orch-router');
const cowork = require('../electron/cowork');
const gate = require('../electron/provider-gate');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  gate.reset();
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + ((e && e.stack) || e));
  }
}

function sse(res, chunks) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const c of chunks) res.write('data: ' + JSON.stringify(c) + '\n\n');
  res.write('data: [DONE]\n\n');
  res.end();
}
function textSse(model, text) {
  return [
    { model, choices: [{ delta: { role: 'assistant', content: text } }] },
    { model, choices: [{ delta: {}, finish_reason: 'stop' }] },
  ];
}
function multiToolSse(model, list) {
  const deltas = list.map((item, idx) => ({
    index: idx,
    id: item.id || `call_${idx}_${Math.random().toString(36).slice(2, 6)}`,
    type: 'function',
    function: { name: item.name, arguments: JSON.stringify(item.args || {}) },
  }));
  return [
    { model, choices: [{ delta: { tool_calls: deltas } }] },
    { model, choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
}

(async () => {
  const createdAgentIds = [];
  const createdTeams = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-claude-parity-'));

  let serverHandler = () => ({ text: 'ok' });
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      try {
        const body = JSON.parse(raw || '{}');
        const r = await serverHandler(body);
        if (r && r.status) {
          res.writeHead(r.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(r.json || { error: { message: 'error' } }));
          return;
        }
        if (r && r.tools) {
          sse(res, multiToolSse(body.model, r.tools));
          return;
        }
        sse(res, textSse(body.model, (r && r.text) || 'ok'));
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
  });

  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const baseURL = `http://127.0.0.1:${srv.address().port}/v1`;
  const provider = { baseURL, apiKey: 'test-key', model: 'mock-coder', supportsTools: true, maxTokens: 4096 };

  try {
    console.log('\nClaude parity + multi-agent harness tests:');

    await test('TodoWrite accepts in_progress + activeForm in schema and formats [-]', async () => {
      const def = tools.toolDefinitions.find((t) => t.name === 'TodoWrite');
      const itemProps = def.parameters.properties.todos.items.properties;
      assert.deepStrictEqual(itemProps.status.enum, ['pending', 'in_progress', 'completed']);
      assert.ok(itemProps.activeForm, 'activeForm field present');
      const out = await tools.executors.todo_write({
        todos: [
          { id: '1', content: 'Plan module', status: 'completed' },
          { id: '2', content: 'Build parser', status: 'in_progress', activeForm: 'Writing parser.js' },
          { id: '3', content: 'Run tests', status: 'pending' },
        ],
      });
      assert.ok(out.includes('[x] Plan module'));
      assert.ok(out.includes('[-] Build parser (Writing parser.js)'));
      assert.ok(out.includes('[ ] Run tests'));
    });

    await test('agentdefs resolves verifier, code-reviewer, and Claude-style aliases', () => {
      const v1 = agentdefs.resolve('verifier', tmp);
      const v2 = agentdefs.resolve('verification_agent', tmp);
      const v3 = agentdefs.resolve('verify', tmp);
      assert.ok(v1 && v1.name === 'verifier');
      assert.strictEqual(v2.name, 'verifier');
      assert.strictEqual(v3.name, 'verifier');
      assert.ok(agentdefs.toolAllowed(v1, 'Bash'));
      assert.ok(!agentdefs.toolAllowed(v1, 'Write'));

      const cr1 = agentdefs.resolve('code-reviewer', tmp);
      const cr2 = agentdefs.resolve('reviewer', tmp);
      assert.ok(cr1 && cr1.name === 'code-reviewer');
      assert.strictEqual(cr2.name, 'code-reviewer');
      assert.ok(agentdefs.toolAllowed(cr1, 'Read'));
      assert.ok(!agentdefs.toolAllowed(cr1, 'Edit'));
    });

    await test('Wave execution runs consecutive Read+TodoWrite concurrently, Edit in order, then trailing Reads', async () => {
      const f1 = path.join(tmp, 'w1.txt');
      const f2 = path.join(tmp, 'w2.txt');
      fs.writeFileSync(f1, 'before_value\n', 'utf8');
      fs.writeFileSync(f2, 'second_file\n', 'utf8');
      let round = 0;
      let trailingToolMsgs = [];
      serverHandler = (body) => {
        round++;
        if (round === 1) {
          return {
            tools: [
              { id: 'c1', name: 'Read', args: { path: f1 } },
              { id: 'c2', name: 'Read', args: { path: f2 } },
              { id: 'c3', name: 'TodoWrite', args: { todos: [{ id: '1', content: 'Update w1', status: 'in_progress', activeForm: 'Updating w1' }] } },
              { id: 'c4', name: 'Edit', args: { path: f1, old_string: 'before_value', new_string: 'after_value' } },
              { id: 'c5', name: 'Read', args: { path: f1 } },
              { id: 'c6', name: 'Read', args: { path: f2 } },
            ],
          };
        }
        trailingToolMsgs = body.messages.filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, m.content]);
        return { text: 'waves_ok' };
      };
      const evts = [];
      const res = await llm.runAgent({
        provider,
        messages: [{ role: 'user', content: 'run mixed waves' }],
        cwd: tmp,
        emit: (e) => evts.push(e),
      });
      assert.strictEqual(res[res.length - 1].content, 'waves_ok');
      const map = new Map(trailingToolMsgs);
      assert.ok(map.get('c1').includes('before_value'), 'Wave 1 saw before_value');
      assert.ok(map.get('c3').includes('[-] Update w1'), 'TodoWrite ran in Wave 1');
      assert.ok(map.get('c4').includes('Replaced 1 occurrence'), 'Wave 2 Edit ran');
      assert.ok(map.get('c5').includes('after_value'), 'Wave 3 Read saw after_value');
      assert.strictEqual(evts.filter((e) => e.type === 'toolResult').length, 6);
    });

    await test('Task resume preserves full transcript, TaskOutput reads file, fork_context & max_turns work', async () => {
      let step = 0;
      let capturedResumedMsgs = null;
      let capturedForkPrompt = '';
      let maxTurnCalls = 0;
      let savedAgentId = '';
      serverHandler = (body) => {
        const lastU = [...body.messages].reverse().find((m) => m.role === 'user');
        const txt = lastU ? String(lastU.content) : '';
        if (txt.includes('Remember token DELTA-99')) {
          return { text: 'Acknowledged secret token.' };
        }
        if (txt.includes('Repeat the secret token')) {
          capturedResumedMsgs = body.messages;
          return { text: 'Resumed token is DELTA-99.' };
        }
        if (txt.includes('Check forked parent note')) {
          capturedForkPrompt = txt;
          return { text: 'Fork saw parent discovery.' };
        }
        if (txt.includes('Loop beyond one turn')) {
          maxTurnCalls++;
          return { tools: [{ name: 'LS', args: { path: tmp } }] };
        }
        step++;
        if (step === 1) {
          return { tools: [{ name: 'Task', args: { description: 'child one', prompt: 'Remember token DELTA-99' } }] };
        }
        if (step === 2) {
          const toolOut = body.messages.filter((m) => m.role === 'tool').pop().content;
          const m = /\[agentId:\s*(agent_[a-z0-9_]+)/i.exec(toolOut);
          assert.ok(m, 'Task output includes [agentId: ...] footer: ' + toolOut);
          savedAgentId = m[1];
          createdAgentIds.push(savedAgentId);
          return { tools: [{ name: 'Task', args: { description: 'resume child', prompt: 'Repeat the secret token', resume: savedAgentId } }] };
        }
        if (step === 3) {
          return { tools: [{ name: 'Task', args: { description: 'fork child', prompt: 'Check forked parent note', fork_context: true } }] };
        }
        if (step === 4) {
          return { tools: [{ name: 'Task', args: { description: 'capped child', prompt: 'Loop beyond one turn', max_turns: 1 } }] };
        }
        return { text: 'resume_fork_max_ok' };
      };

      const msgs = await llm.runAgent({
        provider,
        messages: [{ role: 'user', content: 'Parent discovery: SERVICE_PORT=7744' }],
        cwd: tmp,
        emit: () => {},
      });
      assert.strictEqual(msgs[msgs.length - 1].content, 'resume_fork_max_ok');
      assert.ok(capturedResumedMsgs && capturedResumedMsgs.some((m) => String(m.content).includes('DELTA-99')), 'Resumed subagent received Turn 1 prompt');
      assert.ok(capturedForkPrompt.includes('SERVICE_PORT=7744'), 'fork_context included parent discovery');
      assert.strictEqual(maxTurnCalls, 1, 'max_turns: 1 capped subagent to 1 call');

      const outViaTaskOutput = await parity.handle('TaskOutput', { task_id: savedAgentId }, { cwd: tmp });
      assert.ok(String(outViaTaskOutput && outViaTaskOutput.content).includes('Resumed token is DELTA-99.'), 'TaskOutput found latest persisted agent output');
    });

    await test('Live SendMessage delivers inbox between active teammate steps & shutdown_request aborts', async () => {
      const teamName = 'live_team_' + Date.now().toString(36);
      createdTeams.push(teamName);
      tasksMod.createTeam({ team_name: teamName, description: 'Live inbox test' });

      let workerStep = 0;
      let workerSawLiveMsg = false;
      let sent = false;
      serverHandler = async (body) => {
        const lastU = [...body.messages].reverse().find((m) => m.role === 'user');
        const txt = lastU ? String(lastU.content) : '';
        const allUserText = body.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
        if (allUserText.includes('your member name is "alpha"')) {
          workerStep++;
          if (workerStep === 1) {
            // Queue SendMessage while alpha is mid-step so step 1 drains it before calling the model again.
            if (!sent) {
              sent = true;
              const sendRes = await parity.handle('SendMessage', { team_name: teamName, to: 'alpha', message: 'LIVE_PING_555', summary: 'live' }, {});
              assert.ok(String(sendRes && sendRes.content).includes('delivered to active in-process teammate'), JSON.stringify(sendRes));
            }
            return { tools: [{ name: 'Read', args: { path: path.join(tmp, 'w1.txt') } }] };
          }
          if (txt.includes('<team_inbox') && txt.includes('LIVE_PING_555')) {
            workerSawLiveMsg = true;
            return { text: 'Alpha received LIVE_PING_555 mid-run.' };
          }
          return { text: 'Alpha finished without live inbox.' };
        }
        const lastTool = body.messages.filter((m) => m.role === 'tool').pop();
        if (lastTool) return { text: 'team_done: ' + lastTool.content.slice(0, 60) };
        return { tools: [{ name: 'Task', args: { description: 'alpha', name: 'alpha', team_name: teamName, prompt: 'Do work and check inbox.' } }] };
      };

      const res = await llm.runAgent({
        provider,
        messages: [{ role: 'user', content: 'coordinate live alpha' }],
        cwd: tmp,
        emit: () => {},
      });
      assert.ok(workerSawLiveMsg, 'Active teammate received SendMessage between steps');
      assert.ok(res[res.length - 1].content.startsWith('team_done'));

      // Shutdown request test: send shutdown_request while team member beta is running
      let betaResult = '';
      serverHandler = async (body) => {
        const hasBetaPrompt = body.messages.some((m) => m.role === 'user' && String(m.content).includes('your member name is "beta"'));
        if (hasBetaPrompt) {
          await parity.handle('SendMessage', { team_name: teamName, to: 'beta', type: 'shutdown_request', shutdown: true, message: 'stop now' }, {});
          await new Promise((r) => setTimeout(r, 80));
          return { text: 'should be aborted' };
        }
        const tmsg = body.messages.filter((m) => m.role === 'tool').pop();
        if (tmsg) { betaResult = tmsg.content; return { text: 'parent_after_shutdown' }; }
        return { tools: [{ name: 'Task', args: { description: 'beta', name: 'beta', team_name: teamName, prompt: 'Long task.' } }] };
      };
      const res2 = await llm.runAgent({
        provider,
        messages: [{ role: 'user', content: 'spawn and shutdown beta' }],
        cwd: tmp,
        emit: () => {},
      });
      assert.strictEqual(res2[res2.length - 1].content, 'parent_after_shutdown');
      assert.ok(/stopped before it finished/i.test(betaResult), 'shutdown_request aborted running teammate: ' + betaResult);
    });

    await test('Per-agent readMtimes blocks stale Edit until re-Read, and post-Write/Edit catches syntax errors', async () => {
      const jsFile = path.join(tmp, 'mod.js');
      const mtimes = new Map();
      const ctx = { cwd: tmp, readMtimes: mtimes, allowRichRead: true };

      // Broken JS write warns immediately
      const wBad = await tools.runTool('Write', { path: jsFile, content: 'const x = { ;\n' }, ctx);
      assert.ok(wBad.content.includes('[SYNTAX WARNING in mod.js]'), 'Write flagged broken JS: ' + wBad.content);

      // Broken JSON write warns immediately
      const jsonFile = path.join(tmp, 'cfg.json');
      const wBadJson = await tools.runTool('Write', { path: jsonFile, content: '{"a": 1,,}' }, ctx);
      assert.ok(wBadJson.content.includes('[SYNTAX WARNING in cfg.json]'), 'Write flagged broken JSON');

      // Clean JS write passes with no warning
      const wGood = await tools.runTool('Write', { path: jsFile, content: 'const val = 1;\nmodule.exports = { val };\n' }, ctx);
      assert.ok(!wGood.content.includes('SYNTAX WARNING'), 'Clean JS had no syntax warning');

      // Read records mtime
      await tools.runTool('Read', { path: jsFile }, ctx);

      // Simulate external concurrent edit 2 seconds in the future
      fs.writeFileSync(jsFile, 'const val = 99;\nmodule.exports = { val };\n', 'utf8');
      const future = new Date(Date.now() + 2500);
      fs.utimesSync(jsFile, future, future);

      const staleEdit = await tools.runTool('Edit', { path: jsFile, old_string: 'const val = 1;', new_string: 'const val = 2;' }, ctx);
      assert.ok(staleEdit.content.includes('modified on disk since you last Read it'), 'Stale edit rejected: ' + staleEdit.content);

      // Re-Read clears the conflict and allows Edit
      await tools.runTool('Read', { path: jsFile }, ctx);
      const cleanEdit = await tools.runTool('Edit', { path: jsFile, old_string: 'const val = 99;', new_string: 'const val = 100;' }, ctx);
      assert.ok(cleanEdit.content.startsWith('Replaced 1 occurrence'), cleanEdit.content);
      assert.ok(fs.readFileSync(jsFile, 'utf8').includes('const val = 100;'));
    });

    await test('Multimodal Read attaches image_url for vision models and falls back gracefully on 400', async () => {
      const pngPath = path.join(tmp, 'dot.png');
      // 1x1 transparent PNG
      fs.writeFileSync(pngPath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

      let sawImageUrl = false;
      let callsSeen = 0;
      serverHandler = (body) => {
        callsSeen++;
        if (callsSeen === 1) {
          return { tools: [{ name: 'Read', args: { path: pngPath } }] };
        }
        const hasImg = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
        if (callsSeen === 2) {
          assert.ok(hasImg, 'Second call included inline image_url content');
          sawImageUrl = true;
          // Simulate a text-only endpoint rejecting image_url with 400
          return { status: 400, json: { error: { message: 'This model does not support image_url inputs' } } };
        }
        assert.ok(!hasImg, 'Retry stripped synthetic image_url message');
        return { text: 'image_fallback_ok' };
      };

      const res = await llm.runAgent({
        provider,
        messages: [{ role: 'user', content: 'inspect dot.png' }],
        cwd: tmp,
        emit: () => {},
      });
      assert.ok(sawImageUrl);
      assert.strictEqual(res[res.length - 1].content, 'image_fallback_ok');
    });

    await test('cowork.orchestrate integrates active role pools', async () => {
      const orch = {
        enabled: false,
        providers: [],
        pools: router.freellmPreset(baseURL),
      };
      serverHandler = (body) => ({ text: `worked:${body.model}` });
      const results = await cowork.orchestrate('split task', undefined, {
        runAgent: async (opts) => [{ role: 'assistant', content: `model=${opts.orchestrator ? opts.orchestrator.providers[0].model : opts.provider.model}` }],
        provider: { ...provider, model: 'auto' },
        orchestrator: orch,
        poolOrchestrator: orch,
        tasks: [
          { title: 'Plan', tier: 'critical', prompt: 'plan it' },
          { title: 'Quick', tier: 'small', prompt: 'scan it' },
        ],
      });
      assert.strictEqual(results.length, 2);
      assert.strictEqual(results[0].status, 'done');
      assert.ok(results[0].result.includes('gpt-5.6-luna'), results[0].result);
      assert.ok(results[1].result.includes('qwen3.8-27b') || results[1].result.includes('gpt-oss-120b'), results[1].result);
    });
  } finally {
    await new Promise((ok) => srv.close(ok));
    fs.rmSync(tmp, { recursive: true, force: true });
    for (const id of createdAgentIds) {
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'agent-runs', `${id}.json`), { force: true }); } catch (_) {}
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'agents', `${id}.txt`), { force: true }); } catch (_) {}
    }
    for (const t of createdTeams) {
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'teams', t), { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log(`\nClaude Parity Suite: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
