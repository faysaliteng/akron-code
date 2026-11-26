'use strict';
// Comprehensive tests for the advanced harness upgrades:
//   1. Antigravity dynamic swarm (swarm_add_worker, swarm_kill_worker, swarm_switch_model,
//      semaphore slot release during swarm_wait)
//   2. Claude Task isolation:'worktree' (clean prune + dirty preservation) & team_name inbox delivery
//   3. Deferred ToolSearch promotion into lean toolProfile mid-turn
//   4. Creator Mode: CreateCustomTool -> execute -> DeleteCustomTool
//   5. DeepSeek Harness prefix-cache ordering (static -> semi-static -> dynamic mindmap tail)
//   6. Audit fixes: sessionlog coalescing/replay, tasks.js CAS + deleted blocker,
//      checkpoints.js reverse multi-turn rewind, store.js atomic writeJSON

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');

const swarm = require('../electron/swarm');
const llm = require('../electron/llm');
const tools = require('../electron/tools');
const customtools = require('../electron/customtools');
const sessionlog = require('../electron/sessionlog');
const tasks = require('../electron/tasks');
const checkpoints = require('../electron/checkpoints');
const store = require('../electron/store');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n# ' + t); }

const PROVIDER = { baseURL: 'http://fake.local/v1', model: 'mock-1', apiKey: 'test', transport: 'openai' };

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startMockServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body || '{}');
          handler(parsed, req, res);
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message } }));
        }
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      resolve({
        server: srv,
        baseURL: `http://127.0.0.1:${addr.port}/v1`,
        close: () => new Promise((r) => srv.close(() => r())),
      });
    });
  });
}

function sendSSE(res, { content = '', toolCalls = null }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  const delta = {};
  if (content) delta.content = content;
  if (toolCalls) delta.tool_calls = toolCalls;
  const chunk1 = { choices: [{ index: 0, delta, finish_reason: null }] };
  const chunk2 = { choices: [{ index: 0, delta: {}, finish_reason: toolCalls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
  res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
  res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

const keepAlive = setInterval(() => {}, 1000);

(async () => {
  const tmpRoots = [];
  const origCtRoot = customtools.getRoot();
  const teamCleanup = [];
  const cpCleanup = [];

  try {
    // ------------------------------------------------------------------
    section('1. Dynamic Swarm (add/kill/switch_model & semaphore wait yield)');
    // 4 workers with concurrency: 2.
    // Two workers immediately park on swarm_wait (releasing their semaphore slots!);
    // two workers run only AFTER slots are freed and post @messages to wake them.
    // Without slot release on swarm_wait, this deadlocks until timeout.
    {
      const events = [];
      let waiter1Started = false;
      let helperRan = false;
      let killedAbortObserved = false;

      const res = await swarm.swarm('Test dynamic workers and deadlock-free wait', {
        provider: PROVIDER,
        concurrency: 2,
        monitor: false,
        critique: false,
        emit: (e) => events.push(e),
        tasks: [
          { id: 't1', title: 'waiter-one', tier: 'heavy', prompt: 'wait for signal and spawn helper' },
          { id: 't2', title: 'waiter-two', tier: 'heavy', prompt: 'wait for signal' },
          { id: 't3', title: 'runner-one', tier: 'small', prompt: 'wake waiter-one' },
          { id: 't4', title: 'runner-two', tier: 'small', prompt: 'wake waiter-two' },
        ],
        runAgent: async (opts) => {
          const lt = opts.localTools || {};
          const userMsg = opts.messages && opts.messages[opts.messages.length - 1] && opts.messages[opts.messages.length - 1].content || '';
          const match = /you are @([^\s)]+)/i.exec(userMsg);
          const me = match ? match[1] : 'unknown';

          if (me === 'waiter-one') {
            waiter1Started = true;
            // Test unauthorized kill attempt against runner-two (not our helper)
            const denied = await lt.swarm_kill_worker({ name: 'runner-two', reason: 'test' });
            ok('non-owner cannot kill sibling worker', /Permission denied|only the creator/i.test(String(denied)), denied);
            // Switch own model
            const sw = await lt.swarm_switch_model({ model: 'qwen3.8-27b', role: 'fast' });
            ok('worker can switch own model', /Switched .* to qwen3.8-27b/i.test(String(sw)), sw);
            // Wait for runner-one (must release semaphore slot while parked!)
            const woke = await Promise.race([
              lt.swarm_wait({ since: 0, mentionsOnly: false, timeoutMs: 2500 }),
              new Promise((r) => setTimeout(() => r('TIMED_OUT'), 2500)),
            ]);
            ok('waiter-one woke via board message without deadlock', woke !== 'TIMED_OUT' && !/no new messages/i.test(String(woke)), String(woke));
            // Dynamically spawn a helper worker and kill a second sluggish helper
            await lt.swarm_add_worker({ name: 'helper-fast', title: 'Helper Fast', prompt: 'compute fast result', role: 'fast' });
            await lt.swarm_add_worker({ name: 'helper-slow', title: 'Helper Slow', prompt: 'sleep forever', role: 'fast' });
            await new Promise((r) => setTimeout(r, 30));
            const killOk = await lt.swarm_kill_worker({ name: 'helper-slow', reason: 'no longer needed' });
            ok('creator can kill its own helper', /Killed worker|Stopped worker/i.test(String(killOk)), killOk);
            return [{ role: 'assistant', content: 'waiter-one done' }];
          }
          if (me === 'waiter-two') {
            const woke2 = await lt.swarm_wait({ since: 0, mentionsOnly: false, timeoutMs: 2500 });
            ok('waiter-two woke without deadlock', !/no new messages/i.test(String(woke2)), String(woke2));
            return [{ role: 'assistant', content: 'waiter-two done' }];
          }
          if (me === 'runner-one' || me === 'runner-two') {
            await new Promise((r) => setTimeout(r, 25));
            await lt.swarm_post_message({ channel: 'general', text: `wake up @waiter-one @waiter-two from ${me}` });
            return [{ role: 'assistant', content: `${me} posted` }];
          }
          if (me.includes('helper-fast')) {
            helperRan = true;
            await lt.swarm_post_message({ channel: 'general', text: 'helper-fast complete' });
            return [{ role: 'assistant', content: 'helper-fast result' }];
          }
          if (me.includes('helper-slow')) {
            await new Promise((r) => {
              if (opts.signal) opts.signal.addEventListener('abort', () => { killedAbortObserved = true; r(); }, { once: true });
              setTimeout(r, 2000);
            });
            return [{ role: 'assistant', content: 'slow ended' }];
          }
          return [{ role: 'assistant', content: 'ok' }];
        },
      });

      ok('swarm waited only succeeded because semaphore slots yielded during swarm_wait', waiter1Started && helperRan, `waiter1=${waiter1Started}, helper=${helperRan}`);
      ok('killed helper observed AbortSignal', killedAbortObserved);
      ok('swarm returned worker results including dynamic helper', Array.isArray(res.results) && res.results.some((w) => String(w.name).includes('helper-fast')), JSON.stringify((res.results || []).map((w) => w.name)));
      ok('swarm emitted worker update for model switch', events.some((e) => e.type === 'swarm' && e.phase === 'member' && e.member && e.member.model === 'qwen3.8-27b'));
    }

    // ------------------------------------------------------------------
    section('2. ToolSearch promotion into lean toolProfile & Prefix Cache order');
    {
      const workDir = makeTempDir('akron-adv-prefix-');
      tmpRoots.push(workDir);
      fs.writeFileSync(path.join(workDir, 'CLAUDE.md'), 'Always use strict ESM rules.\n');
      fs.writeFileSync(path.join(workDir, 'MINDMAP.md'), '# Dynamic Mindmap\nLatest turn state.\n');

      const seenRequests = [];
      let callNum = 0;
      const srv = await startMockServer((body, _req, res) => {
        seenRequests.push(body);
        callNum++;
        if (callNum === 1) {
          sendSSE(res, {
            toolCalls: [{
              index: 0,
              id: 'call_ts_1',
              type: 'function',
              function: { name: 'ToolSearch', arguments: JSON.stringify({ query: 'CreateCustomTool' }) },
            }],
          });
        } else {
          sendSSE(res, { content: 'ToolSearch promoted CreateCustomTool!' });
        }
      });

      try {
        const res = await llm.runAgent({
          provider: { baseURL: srv.baseURL, model: 'mock-lean', apiKey: 'test', transport: 'openai' },
          messages: [
            { role: 'system', content: 'EXTRA_RENDERER_DIRECTIVE' },
            { role: 'user', content: 'Find and prepare CreateCustomTool.' },
          ],
          cwd: workDir,
          toolProfile: 'lean',
          emit: () => {},
          approveTool: async () => true,
        });

        ok('runAgent completed ToolSearch + final step', seenRequests.length === 2, `steps=${seenRequests.length}`);
        const step1Tools = (seenRequests[0].tools || []).map((t) => t.function.name);
        const step2Tools = (seenRequests[1].tools || []).map((t) => t.function.name);
        ok('lean profile omits CreateCustomTool on step 1', !step1Tools.includes('CreateCustomTool'), JSON.stringify(step1Tools));
        ok('ToolSearch promotes CreateCustomTool onto step 2 tools surface', step2Tools.includes('CreateCustomTool'), JSON.stringify(step2Tools));

        const sysPrompt = seenRequests[0].messages[0].content;
        const idxMem = sysPrompt.indexOf('\n\n<project_memory>\n');
        const idxWs = sysPrompt.indexOf('\n\n<project_workspace>\n');
        const idxDir = sysPrompt.indexOf('EXTRA_RENDERER_DIRECTIVE');
        const idxMap = sysPrompt.indexOf('\n\n<project_mindmap>\n');
        ok('prefix cache order: project_memory < project_workspace < directive < project_mindmap',
          idxMem > 0 && idxWs > idxMem && idxDir > idxWs && idxMap > idxDir,
          `mem=${idxMem}, ws=${idxWs}, dir=${idxDir}, map=${idxMap}`);
      } finally {
        await srv.close();
      }
    }

    // ------------------------------------------------------------------
    section('3. Task isolation:worktree & team_name inbox delivery');
    {
      const repoDir = makeTempDir('akron-adv-wt-');
      tmpRoots.push(repoDir);
      execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@akron.local'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir, stdio: 'ignore' });
      fs.writeFileSync(path.join(repoDir, 'README.md'), 'root repo\n');
      execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

      const teamName = 'adv-team-' + Date.now();
      teamCleanup.push(teamName);
      tasks.createTeam({ team_name: teamName, description: 'test team' });
      tasks.addMember(teamName, { name: 'worker-wt', role: 'worker' });
      tasks.sendMessage({ team_name: teamName, to: 'worker-wt', from: 'lead', summary: 'urgent', message: 'Check README and write note' });

      let reqIdx = 0;
      const capturedPrompts = [];
      const srv = await startMockServer((body, _req, res) => {
        reqIdx++;
        if (reqIdx === 1) {
          // Parent step 1: invoke clean worktree Task
          sendSSE(res, {
            toolCalls: [{
              index: 0, id: 'call_wt_clean', type: 'function',
              function: {
                name: 'Task',
                arguments: JSON.stringify({ description: 'clean check', prompt: 'Just summarize repo', isolation: 'worktree' }),
              },
            }],
          });
        } else if (reqIdx === 2) {
          // Clean child finishes without editing
          capturedPrompts.push(body.messages.find((m) => m.role === 'user').content);
          sendSSE(res, { content: 'Everything is clean.' });
        } else if (reqIdx === 3) {
          // Parent step 2: invoke dirty worktree Task + team_name + name
          sendSSE(res, {
            toolCalls: [{
              index: 0, id: 'call_wt_dirty', type: 'function',
              function: {
                name: 'Task',
                arguments: JSON.stringify({
                  description: 'dirty edit',
                  prompt: 'Create a file in worktree',
                  isolation: 'worktree',
                  team_name: teamName,
                  name: 'worker-wt',
                }),
              },
            }],
          });
        } else if (reqIdx === 4) {
          // Dirty child writes file using Write tool
          capturedPrompts.push(body.messages.find((m) => m.role === 'user').content);
          sendSSE(res, {
            toolCalls: [{
              index: 0, id: 'call_child_write', type: 'function',
              function: {
                name: 'Write',
                arguments: JSON.stringify({ file_path: 'wt-output.txt', content: 'written inside isolated worktree\n' }),
              },
            }],
          });
        } else if (reqIdx === 5) {
          sendSSE(res, { content: 'Created wt-output.txt.' });
        } else {
          const msgs = body.messages || [];
          const toolResults = msgs.filter((m) => m.role === 'tool').map((m) => m.content);
          sendSSE(res, { content: 'DONE: ' + toolResults.join(' | ') });
        }
      });

      try {
        const res = await llm.runAgent({
          provider: { baseURL: srv.baseURL, model: 'mock-wt', apiKey: 'test', transport: 'openai' },
          messages: [{ role: 'user', content: 'Run clean then dirty worktree subagents.' }],
          cwd: repoDir,
          emit: () => {},
          approveTool: async () => true,
        });

        const finalMsg = res[res.length - 1].content || '';
        ok('clean worktree did not preserve branch and auto-pruned', !fs.existsSync(path.join(repoDir, 'wt-output.txt')) && finalMsg.includes('DONE:'));
        ok('team_name + name delivered unread inbox into child prompt',
          capturedPrompts[1] && capturedPrompts[1].includes('<team_inbox') && capturedPrompts[1].includes('Check README and write note'),
          capturedPrompts[1]);

        const wtMatch = /\[Worktree preserved: path=([^,\]]+), branch=([^,\]]+)\]/.exec(finalMsg);
        ok('dirty worktree was preserved and reported in tool result', Boolean(wtMatch), finalMsg);
        if (wtMatch) {
          const [, wtPath, wtBranch] = wtMatch;
          ok('worktree file exists in isolated path, NOT in main repo',
            fs.existsSync(path.join(wtPath, 'wt-output.txt')) && !fs.existsSync(path.join(repoDir, 'wt-output.txt')),
            wtPath);
          // Clean up test worktree & branch
          try { execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: repoDir, stdio: 'ignore' }); } catch (_) {}
          try { execFileSync('git', ['branch', '-D', wtBranch], { cwd: repoDir, stdio: 'ignore' }); } catch (_) {}
        }
      } finally {
        await srv.close();
      }
    }

    // ------------------------------------------------------------------
    section('4. Creator Mode (CreateCustomTool -> run -> DeleteCustomTool)');
    {
      const ctDir = makeTempDir('akron-adv-ct-');
      tmpRoots.push(ctDir);
      customtools.setRoot(ctDir);

      let activatedNames = [];
      const ctx = {
        cwd: ctDir,
        activateTools: (names) => { activatedNames.push(...names); },
      };

      const created = await tools.runTool('CreateCustomTool', {
        name: 'adv_sum_tool',
        description: 'Adds two integers a and b',
        runtime: 'node',
        parameters: {
          type: 'object',
          properties: { a: { type: 'number' }, b: { type: 'number' } },
          required: ['a', 'b'],
        },
        script: 'const args = JSON.parse(process.env.TOOL_ARGS_JSON || "{}"); console.log("SUM=" + ((args.a || 0) + (args.b || 0)));',
      }, ctx);

      ok('CreateCustomTool succeeded & called activateTools',
        /Created and activated/.test(String(created)) && activatedNames.includes('adv_sum_tool'),
        String(created));

      const execOut = await tools.runTool('adv_sum_tool', { a: 19, b: 23 }, ctx);
      const outStr = typeof execOut === 'string' ? execOut : (execOut && execOut.content ? String(execOut.content) : String(execOut));
      ok('custom tool executed immediately and computed SUM=42', outStr.trim() === 'SUM=42', outStr);

      const listed = await tools.runTool('ListCustomTools', {}, ctx);
      ok('ListCustomTools reports newly created tool', String(listed).includes('adv_sum_tool'), String(listed));

      const deleted = await tools.runTool('DeleteCustomTool', { name: 'adv_sum_tool' }, ctx);
      ok('DeleteCustomTool removes tool cleanly', /Deleted|removed/i.test(String(deleted)) && customtools.listTools().length === 0, String(deleted));
    }

    // ------------------------------------------------------------------
    section('5. Audit Fixes: sessionlog, tasks, checkpoints reverse rewind, store atomic');
    {
      // sessionlog coalescing & read
      const slDir = makeTempDir('akron-adv-sl-');
      tmpRoots.push(slDir);
      sessionlog.setRoot(slDir);
      const log = sessionlog.open('conv-1', 'turn-1', { title: 'Test Turn' });
      log.append({ type: 'delta', text: 'Hello ' });
      log.append({ type: 'delta', text: 'World' });
      log.append({ type: 'tool', name: 'Read', args: { file_path: 'a.js' } });
      log.append({ type: 'toolResult', name: 'Read', result: 'ok' });
      log.close();

      const replay = sessionlog.read('conv-1');
      const evs = replay.turns[0].events;
      ok('sessionlog coalesced deltas into one text event',
        evs.filter((e) => e.type === 'text').length === 1 && evs.find((e) => e.type === 'text').text === 'Hello World',
        JSON.stringify(evs));
      ok('sessionlog recorded turn-end', evs[evs.length - 1].type === 'turn-end');

      // tasks.js CAS + deleted blocker
      const tTeam = 'adv-task-' + Date.now();
      teamCleanup.push(tTeam);
      tasks.createTeam({ team_name: tTeam });
      const task1 = tasks.createTask({ team_name: tTeam, subject: 'Parent blocker' });
      const task2 = tasks.createTask({ team_name: tTeam, subject: 'Dependent work', blockedBy: [task1.task.id] });
      tasks.updateTask({ team_name: tTeam, taskId: task1.task.id, status: 'deleted' });
      const listed = tasks.listTasks({ team_name: tTeam });
      const d2 = listed.tasks.find((t) => t.id === task2.task.id);
      ok('tasks.listTasks ignores deleted blocker in openBlockers', d2 && d2.openBlockers.length === 0 && d2.claimable === true, JSON.stringify(d2));

      tasks.updateTask({ team_name: tTeam, taskId: task2.task.id, owner: 'alice' });
      const casFail = tasks.updateTask({ team_name: tTeam, taskId: task2.task.id, owner: 'bob', expectOwner: '' });
      ok('tasks.updateTask rejects stale expectOwner CAS', casFail && casFail.ok === false, JSON.stringify(casFail));

      // checkpoints.js reverse multi-turn rewind
      const cpConv = 'adv-cp-' + Date.now();
      cpCleanup.push(cpConv);
      const cpWork = makeTempDir('akron-adv-cpwork-');
      tmpRoots.push(cpWork);
      const fileA = path.join(cpWork, 'a.txt');
      const fileB = path.join(cpWork, 'b.txt');
      fs.writeFileSync(fileA, 'v1\n');
      checkpoints.snapshotFile(cpConv, 't1', fileA);
      fs.writeFileSync(fileA, 'v2\n');
      // Turn 2: edits fileA (from v2 -> v3)
      checkpoints.snapshotFile(cpConv, 't2', fileA);
      fs.writeFileSync(fileA, 'v3\n');
      // Turn 3: edits fileA (v3 -> v4) AND creates brand-new fileB
      checkpoints.snapshotFile(cpConv, 't3', fileA);
      checkpoints.snapshotFile(cpConv, 't3', fileB);
      fs.writeFileSync(fileA, 'v4\n');
      fs.writeFileSync(fileB, 'brand new in t3\n');

      const rw = checkpoints.restore(cpConv, 't2');
      ok('checkpoints.restore to t2 restored fileA to v2 AND removed t3 fileB',
        rw.errors.length === 0 && fs.readFileSync(fileA, 'utf8') === 'v2\n' && !fs.existsSync(fileB),
        `a=${JSON.stringify(fs.readFileSync(fileA, 'utf8'))}, bExists=${fs.existsSync(fileB)}, rw=${JSON.stringify(rw)}`);

      // Atomic JSON writes leave no lingering .tmp. artifacts in tasks dirs
      const teamDirFiles = fs.readdirSync(path.join(tasks.TASKS_DIR, tasks.safeName(tTeam)));
      ok('tasks atomic writeJSON leaves zero temp files', !teamDirFiles.some((f) => f.includes('.tmp.')), JSON.stringify(teamDirFiles));

      // sanitizeHistory multimodal preservation (vision blocks never flattened to "[image]")
      const mmOut = llm.sanitizeHistory([
        { role: 'system', content: 'sys' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Inspect UI' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ]);
      ok('sanitizeHistory preserves multimodal image_url content array intact',
        Array.isArray(mmOut[1].content) && mmOut[1].content.some((p) => p && p.type === 'image_url' && p.image_url && p.image_url.url.includes('AAAA')),
        JSON.stringify(mmOut[1]));
    }

  } finally {
    clearInterval(keepAlive);
    customtools.setRoot(origCtRoot);
    customtools.registerAll(tools.toolDefinitions, tools.executorsByTool, tools.executors);
    for (const t of teamCleanup) {
      try { tasks.deleteTeam(t); } catch (_) {}
      try { fs.rmSync(path.join(tasks.TASKS_DIR, tasks.safeName(t)), { recursive: true, force: true }); } catch (_) {}
    }
    for (const c of cpCleanup) {
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'checkpoints', c.replace(/^[/\\]+/, '').replace(/[/\\:]+/g, '__')), { recursive: true, force: true }); } catch (_) {}
    }
    for (const d of tmpRoots) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(failed ? 1 : 0);
})();
