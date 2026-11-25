'use strict';
// LIVE agent-driven cowork test (manual; needs network + a local Ollama).
//   node test/live-orchestrator-agent.js
// The PARENT agent runs on NVIDIA NIM and — using nothing but its tool calls —
// registers a cowork worker pinned to a local Ollama Gemma 4 endpoint, fans a
// goal out to it, and reports the worker's answer. This exercises the real
// llm.js ctx (runAgent/provider getter) end to end, not a hand-built stub.

const { runAgent, normalizeProvider } = require('../electron/llm');

const NVIDIA = normalizeProvider({
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: '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',
  model: 'nvidia/nemotron-3.5-bolt-e4b',
  temperature: 0.2,
  maxTokens: 1024,
});

const PROMPT = [
  'You are testing the cowork orchestrator. Do exactly this, in order, with tool calls:',
  '1. Call mcp__cowork__register_worker with name "gemma-local", baseURL "http://127.0.0.1:11434/v1", model "gemma4:latest", supportsTools false.',
  '2. Call mcp__cowork__orchestrate with goal "In one short sentence, name your model family." and workers ["gemma-local"].',
  '3. Reply with the worker\'s answer verbatim.',
].join('\n');

(async () => {
  const t0 = Date.now();
  const events = [];
  const msgs = await runAgent({
    provider: NVIDIA,
    messages: [{ role: 'user', content: PROMPT }],
    maxSteps: 8,
    emit: (e) => {
      events.push(e);
      if (e.type === 'tool') console.log('  → tool', e.name, JSON.stringify(e.args));
      if (e.type === 'toolResult') console.log('  ←', String(e.result).slice(0, 300).replace(/\n/g, '\n     '));
    },
  });
  const last = msgs.filter((m) => m.role === 'assistant' && m.content).pop();
  console.log('\n--- parent final ---\n' + (last ? last.content : '(none)'));
  console.log(`\nWALL: ${Date.now() - t0}ms, events=${events.length}`);
  const usedOrch = events.some((e) => e.type === 'tool' && e.name === 'mcp__cowork__orchestrate');
  const workerAnswered = events.some((e) => e.type === 'toolResult' && /gemma4:latest/.test(String(e.result)));
  console.log(usedOrch && workerAnswered ? '\nPASS: cowork orchestrated on NVIDIA + local Gemma 4' : '\nINCONCLUSIVE: see events above');
  process.exit(usedOrch && workerAnswered ? 0 : 2);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
