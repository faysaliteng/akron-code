'use strict';
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');

async function testCssTokens() {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  assert(/:root\s*\{[\s\S]*?--text-100:\s*#[0-9a-fA-F]{6}/.test(css), '--text-100 must be defined in :root');
  assert(/\[data-theme="light"\]\s*\{[\s\S]*?--text-100:\s*#[0-9a-fA-F]{6}/.test(css), '--text-100 must be defined in [data-theme="light"]');
  assert(/var\(--text-100,\s*var\(--text-000\)\)/.test(css), 'shimmer/dots must include var(--text-100, var(--text-000)) fallback');
  assert(css.includes('.live-tool-card'), '.live-tool-card styles missing');
  assert(css.includes('.sticky-live-bar'), '.sticky-live-bar styles missing');
  assert(css.includes('.paused-banner'), '.paused-banner styles missing');
  assert(css.includes('.pause-btn'), '.pause-btn styles missing');
  console.log('✓ 1.1 CSS --text-100 tokens & live-activity styles');
}

async function testPauseControllerAndRunAgent() {
  const { runAgent, createPauseController } = require('../electron/llm');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-p1-'));

  let round = 0;
  let capturedMessagesOnRound2 = null;

  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const ch of req) raw += ch;
    const body = JSON.parse(raw);
    round++;

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (round === 1) {
      // Stream a Write tool call in multiple chunks so toolStream fires
      const args1 = '{"file_path":"hello.txt","co';
      const args2 = 'ntent":"line1\\nline2\\nline3"}';
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_p1_1', type: 'function', function: { name: 'Write', arguments: args1 } }] } }] })}\n\n`);
      await new Promise((r) => setTimeout(r, 170));
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, arguments: args2 }] }, finish_reason: 'tool_calls' }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    capturedMessagesOnRound2 = body.messages;
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Done with steering applied!' }, finish_reason: 'stop' }] })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;

  const pauseCtrl = createPauseController();
  const events = [];
  let sawPausedHold = false;

  const ac = new AbortController();
  const runPromise = runAgent({
    provider: { baseURL: `http://127.0.0.1:${port}/v1`, model: 'mock-model', apiKey: 'k' },
    messages: [{ role: 'user', content: 'Write hello.txt' }],
    cwd: tmpDir,
    pauseController: pauseCtrl,
    signal: ac.signal,
    emit: (e) => {
      events.push(e);
      if (e.type === 'toolStream' && !pauseCtrl.isPaused()) {
        // Pause cleanly before Write executes at the tool boundary!
        pauseCtrl.pause();
      }
    },
  });

  // Wait briefly to confirm execution is held while paused (round 1 tool hasn't executed yet)
  await new Promise((r) => setTimeout(r, 400));
  assert(pauseCtrl.isPaused(), 'Pause controller must stay paused');
  assert(!fs.existsSync(path.join(tmpDir, 'hello.txt')), 'Tool should be held at boundary until resumed');
  sawPausedHold = true;

  // Resume with a steering note!
  pauseCtrl.resume('Also confirm line count in your final answer.');
  const finalMsgs = await runPromise;

  assert(sawPausedHold, 'Should have paused before executing tool');
  assert(fs.existsSync(path.join(tmpDir, 'hello.txt')), 'hello.txt should be written after resume');

  const tsEvts = events.filter((e) => e.type === 'toolStream');
  assert(tsEvts.length >= 2, `Expected >=2 toolStream events, got ${tsEvts.length}`);
  assert(tsEvts[0].target === 'hello.txt' || tsEvts.some((x) => x.target === 'hello.txt'), 'toolStream should extract target hello.txt');
  assert(tsEvts.some((x) => x.lines >= 3 && x.bytes > 20), 'toolStream should count lines and bytes');

  assert(Array.isArray(capturedMessagesOnRound2), 'Round 2 should receive messages');
  const lastMsg = capturedMessagesOnRound2[capturedMessagesOnRound2.length - 1];
  assert.strictEqual(lastMsg.role, 'user');
  assert(lastMsg.content.includes('Also confirm line count'), 'Steering note should be injected before next LLM round');
  // Verify tool_call adjacency was preserved
  const toolIdx = capturedMessagesOnRound2.findIndex((m) => m.role === 'tool');
  assert(toolIdx > 0 && capturedMessagesOnRound2[toolIdx - 1].role === 'assistant', 'tool message must follow assistant tool_call');
  assert(finalMsgs.some((m) => m.role === 'assistant' && String(m.content).includes('Done with steering applied')));

  // Verify Abort while paused exits cleanly
  const p2 = createPauseController();
  p2.pause();
  const ac2 = new AbortController();
  setTimeout(() => ac2.abort(), 50);
  let abortedCleanly = false;
  try {
    await p2.waitIfPaused(ac2.signal);
  } catch (e) {
    abortedCleanly = /abort/i.test(e.message);
  }
  assert(abortedCleanly, 'waitIfPaused must reject immediately when aborted');

  srv.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('✓ 1.2 toolStream + Pause/Resume + Steering Note + Abort while paused');
}

async function testTransportToolDeltasAndBashStdout() {
  const pt = require('../electron/providertransport');
  const { runTool } = require('../electron/tools');

  // Anthropic SSE mock
  const origFetch = global.fetch;
  try {
    const sseBody = [
      'event: content_block_start',
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Write' } })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"a.js","content":"line1\\nline2"}' } })}`,
      '',
      'event: message_delta',
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 10, output_tokens: 20 } })}`,
      '',
    ].join('\n');

    global.fetch = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(Buffer.from(sseBody)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const deltas = [];
    const msg = await pt.chatCompletion(
      { transport: 'anthropic', model: 'claude-sonnet-4-6', apiKey: 'sk-test' },
      [{ role: 'user', content: 'hi' }],
      [],
      () => {},
      null,
      undefined,
      (d) => deltas.push(d)
    );
    assert.strictEqual(msg.tool_calls.length, 1);
    assert(deltas.some((d) => d.name === 'Write' && d.bytes > 10 && d.lines >= 2 && d.argsTail), 'Anthropic transport must emit rich toolDeltaPayload');

    // Codex / Responses SSE mock
    const codexSse = [
      'event: response.output_item.added',
      `data: ${JSON.stringify({ type: 'response.output_item.added', item: { type: 'function_call', id: 'it_1', call_id: 'call_cx_1', name: 'Edit' } })}`,
      '',
      'event: response.function_call_arguments.delta',
      `data: ${JSON.stringify({ type: 'response.function_call_arguments.delta', item_id: 'it_1', delta: '{"file_path":"b.js","old_string":"a","new_string":"b\\nc"}' })}`,
      '',
      'event: response.completed',
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } })}`,
      '',
    ].join('\n');
    global.fetch = async () => new Response(new ReadableStream({
      start(c) { c.enqueue(Buffer.from(codexSse)); c.close(); },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

    const codexDeltas = [];
    const cmsg = await pt.chatCompletion(
      { transport: 'codex', model: 'gpt-5', accessToken: 'tok' },
      [{ role: 'user', content: 'hi' }],
      [],
      () => {},
      null,
      undefined,
      (d) => codexDeltas.push(d)
    );
    assert.strictEqual(cmsg.tool_calls.length, 1);
    assert(codexDeltas.some((d) => d.name === 'Edit' && d.bytes > 10 && d.lines >= 2), 'Codex transport must emit toolDeltaPayload');
  } finally {
    global.fetch = origFetch;
  }

  // Bash live stdout streaming
  const bashEvents = [];
  const res = await runTool('Bash', { command: 'printf "first line\\nsecond line\\n"' }, {
    cwd: ROOT,
    currentToolId: 'bash_live_1',
    emit: (e) => bashEvents.push(e),
  });
  const resText = typeof res === 'string' ? res : (res && res.content) || '';
  assert(resText.includes('first line'), `Bash should return stdout, got: ${JSON.stringify(res)}`);
  assert(bashEvents.some((e) => e.type === 'toolStream' && e.phase === 'stdout' && e.preview.includes('first line')), 'Bash should emit throttled stdout toolStream');
  console.log('✓ 1.3 Cross-transport toolDeltas & Bash live stdout streaming');
}

(async () => {
  await testCssTokens();
  await testPauseControllerAndRunAgent();
  await testTransportToolDeltasAndBashStdout();
  console.log('PHASE1_LIVE_UX_ALL_PASS');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
