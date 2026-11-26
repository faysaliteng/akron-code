'use strict';
// LIVE E2E verification of:
//   1. extbridge zero-key OpenAI proxy (`akron-fast` with dummy client key -> live FreeLLMAPI response)
//   2. llm.runAgent multi-step coding turn (TodoWrite + Write + Edit + Bash) emitting real-time
//      `checkpoint` events, computing real line-numbered hunks via `checkpoints.computeTurnDiffs`,
//      and cleanly rewinding via `checkpoints.restore`.

const fs = require('fs');
const path = require('path');
const os = require('os');

const extbridge = require('../../electron/extbridge');
const llm = require('../../electron/llm');
const checkpoints = require('../../electron/checkpoints');

(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.autobot', 'freellm.json'), 'utf8'));
  const orch = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.autobot', 'orchestrator.json'), 'utf8'));
  const BASE = `http://${cfg.host || '127.0.0.1'}:${cfg.port || 3001}/v1`;
  const KEY = cfg.token;

  const baseProvider = { baseURL: BASE, apiKey: KEY, model: 'qwen3.8-flash', supportsTools: true, maxTokens: 4096, temperature: 0.2 };
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-live-extcp-'));
  const convId = 'live-cp-' + Date.now();
  const sampleFile = path.join(tmpDir, 'calc.js');
  fs.writeFileSync(sampleFile, 'function mul(a, b) {\n  return a + b;\n}\nmodule.exports = { mul };\n');

  try {
    // 1. Live extbridge proxy test (zero key required by caller)
    const started = await extbridge.start({
      port: 0,
      getProvider: () => baseProvider,
      getOrchestrator: () => orch,
    });
    if (!started.ok) throw new Error('extbridge failed to start: ' + started.error);
    console.log('extbridge live proxy port:', started.port);

    const sse = await fetch(`http://127.0.0.1:${started.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer akron-desktop-local' },
      body: JSON.stringify({
        model: 'akron-fast',
        stream: true,
        messages: [{ role: 'user', content: 'Reply with only the word OK_BRIDGE' }],
      }),
    }).then((r) => r.text());
    console.log('extbridge live stream sample:', sse.slice(0, 220).replace(/\n/g, ' '));
    if (!sse.includes('OK_BRIDGE') && !sse.includes('[DONE]')) {
      throw new Error('Unexpected extbridge live response: ' + sse.slice(0, 300));
    }

    // 2. Live coding agent turn emitting TodoWrite + checkpoint events + computeTurnDiffs + rewind
    const events = [];
    await llm.runAgent({
      provider: baseProvider,
      orchestrator: orch,
      cwd: tmpDir,
      convId,
      turnId: 'live-turn-1',
      maxSteps: 8,
      toolProfile: 'lean',
      approveTool: async () => true,
      emit: (e) => {
        events.push(e);
        if (e.type === 'tool') console.log('  tool:', e.name, JSON.stringify(e.args).slice(0, 90));
        if (e.type === 'checkpoint') console.log('  checkpoint:', e.id, e.path);
      },
      messages: [{
        role: 'user',
        content: `In ${tmpDir}: 1) Call TodoWrite with 2 steps ("Fix calc.js", "Run node assert"), 2) Edit calc.js so mul returns a * b instead of a + b, 3) Run \`node -e "const {mul}=require('./calc'); if(mul(6,7)!==42) process.exit(1); console.log('MUL_OK')"\` with Bash.`,
      }],
    });

    const fixedContent = fs.readFileSync(sampleFile, 'utf8');
    const cpEvents = events.filter((e) => e.type === 'checkpoint');
    const diffs = checkpoints.computeTurnDiffs(convId, 'live-turn-1', tmpDir);
    console.log('checkpoint events:', cpEvents.length, '| diffs computed:', diffs.length);
    if (!cpEvents.length || !diffs.length || !fixedContent.includes('a * b')) {
      throw new Error(`Expected live edit & checkpoint diff; content=${JSON.stringify(fixedContent)}, cp=${cpEvents.length}, diffs=${diffs.length}`);
    }

    // Rewind and verify original broken content is cleanly restored
    const rw = checkpoints.restore(convId, 'live-turn-1');
    const rewound = fs.readFileSync(sampleFile, 'utf8');
    console.log('rewind result:', rw, '| restored mul(a,b) original:', rewound.includes('return a + b;'));
    if (!rewound.includes('return a + b;')) throw new Error('Rewind failed to restore original calc.js');
    console.log('EXTBRIDGE + LIVE CHECKPOINT + DIFF + REWIND: PASS');
  } finally {
    await extbridge.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.join(os.homedir(), '.autobot', 'checkpoints', convId), { recursive: true, force: true }); } catch (_) {}
  }
})();
