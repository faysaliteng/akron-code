'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

test('Phase 3: CLI agent loop executes tools, persists & continues SQLite session, and enforces plan mode', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-cli-loop-'));
  const fakeHome = path.join(tmpDir, 'home');
  const workDir = path.join(tmpDir, 'ws');
  const autobotDir = path.join(fakeHome, '.autobot');
  fs.mkdirSync(autobotDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  let turnReqCount = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      turnReqCount++;
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        const hasToolResult = msgs.some((m) => m.role === 'tool');
        const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content || '';

        let msgObj;
        let finishReason = 'stop';
        if (String(lastUser).includes('PLAN_BLOCK_TEST') && !hasToolResult) {
          finishReason = 'tool_calls';
          msgObj = {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_write_blocked',
              type: 'function',
              function: {
                name: 'Write',
                arguments: JSON.stringify({ file_path: path.join(workDir, 'blocked.txt'), content: 'nope' }),
              },
            }],
          };
        } else if (!hasToolResult && String(lastUser).includes('CREATE_HELLO')) {
          finishReason = 'tool_calls';
          msgObj = {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_write_1',
              type: 'function',
              function: {
                name: 'Write',
                arguments: JSON.stringify({ file_path: path.join(workDir, 'hello.txt'), content: 'AKRON_CLI_WORKS' }),
              },
            }],
          };
        } else if (hasToolResult) {
          msgObj = {
            role: 'assistant',
            content: 'Tool executed: ' + msgs.filter((m) => m.role === 'tool').map((m) => String(m.content).slice(0, 80)).join(' '),
          };
        } else {
          msgObj = {
            role: 'assistant',
            content: `Continued session with ${msgs.filter((m) => m.role === 'user').length} user messages.`,
          };
        }

        if (body.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
          const delta = msgObj.tool_calls
            ? { role: 'assistant', tool_calls: msgObj.tool_calls.map((tc, index) => ({ index, ...tc })) }
            : { role: 'assistant', content: msgObj.content };
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl_${turnReqCount}`,
            object: 'chat.completion.chunk',
            model: body.model || 'test-coder',
            choices: [{ index: 0, delta, finish_reason: null }],
          })}\n\n`);
          res.write(`data: ${JSON.stringify({
            id: `chatcmpl_${turnReqCount}`,
            object: 'chat.completion.chunk',
            model: body.model || 'test-coder',
            choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: `chatcmpl_${turnReqCount}`,
          object: 'chat.completion',
          model: body.model || 'test-coder',
          choices: [{ index: 0, message: msgObj, finish_reason: finishReason }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  fs.writeFileSync(path.join(autobotDir, 'settings.json'), JSON.stringify({
    provider: {
      name: 'LocalTest',
      type: 'openai',
      baseURL: `http://127.0.0.1:${port}/v1`,
      apiKey: 'sk-test-local',
      model: 'test-coder',
      supportsTools: true,
    },
  }, null, 2));

  const binPath = path.resolve(__dirname, '..', 'bin', 'akron.js');
  const env = {
    ...process.env,
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    AKRON_NO_INTERACTIVE: '1',
  };

  try {
    // 1. Headless multi-turn write with --yolo --json
    const r1 = await execFileAsync(process.execPath, [
      binPath,
      '-p', 'CREATE_HELLO',
      '--cwd', workDir,
      '--yolo',
      '--json',
    ], { env, encoding: 'utf8', timeout: 15000 });
    const parsed1 = JSON.parse(r1.stdout.trim());
    assert.strictEqual(parsed1.ok, true);
    assert.ok(parsed1.toolCalls.some((t) => t.name === 'Write'));
    assert.strictEqual(fs.readFileSync(path.join(workDir, 'hello.txt'), 'utf8'), 'AKRON_CLI_WORKS');

    // 2. Continue session with --continue --stream-json
    const r2 = await execFileAsync(process.execPath, [
      binPath,
      '-p', 'FOLLOW_UP',
      '--cwd', workDir,
      '--continue',
      '--yolo',
      '--stream-json',
    ], { env, encoding: 'utf8', timeout: 15000 });
    const events = r2.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const resEvt = events.find((e) => e.type === 'result');
    assert.ok(resEvt && resEvt.ok);
    assert.strictEqual(resEvt.convId, parsed1.convId);
    assert.ok(resEvt.response.includes('2 user messages'));

    // 3. Plan permission mode blocks mutating Write tool
    await execFileAsync(process.execPath, [
      binPath,
      '-p', 'PLAN_BLOCK_TEST',
      '--cwd', workDir,
      '--permission-mode', 'plan',
      '--json',
    ], { env, encoding: 'utf8', timeout: 15000 });
    assert.strictEqual(fs.existsSync(path.join(workDir, 'blocked.txt')), false);
  } finally {
    srv.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
