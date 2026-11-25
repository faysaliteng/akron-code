'use strict';
// LIVE cowork-orchestrator test (manual; needs network + a local Ollama).
//   node test/live-orchestrator.js
// Registers two workers on two DIFFERENT backends — NVIDIA NIM (cloud) and a
// local Ollama Gemma 4 — then fans one goal out to both through the real
// mcp__cowork__* tool surface, exactly as the agent would call it.

const { runAgent } = require('../electron/llm');
const { runTool } = require('../electron/tools');

const NVIDIA = {
  baseURL: 'https://integrate.api.nvidia.com/v1',
  apiKey: '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',
  model: 'nvidia/nemotron-3.5-bolt-e4b',
  temperature: 0.3,
  maxTokens: 512,
  supportsTools: true,
};
const GEMMA = {
  baseURL: 'http://127.0.0.1:11434/v1',
  model: 'gemma4:latest',
  apiKey: '',
  temperature: 0.3,
  maxTokens: 512,
  supportsTools: false,
};

// Mirrors the ctx llm.js builds for tool execution.
const ctx = {
  runAgent: (sub) => runAgent({ ...sub }),
  get provider() { return NVIDIA; },
  cwd: process.cwd(),
};

const GOAL = 'In one short sentence, say which model family you are. Do not call any tools.';

(async () => {
  console.log('register:', await runTool('mcp__cowork__register_worker', {
    name: 'nvidia', baseURL: NVIDIA.baseURL, model: NVIDIA.model, apiKey: NVIDIA.apiKey, supportsTools: true,
  }, ctx));
  console.log('register:', await runTool('mcp__cowork__register_worker', {
    name: 'gemma', baseURL: GEMMA.baseURL, model: GEMMA.model, apiKey: '', supportsTools: false,
  }, ctx));
  console.log('\n' + await runTool('mcp__cowork__list_workers', {}, ctx));

  const t0 = Date.now();
  const out = await runTool('mcp__cowork__orchestrate', {
    goal: GOAL, workers: ['nvidia', 'gemma'], concurrency: 2, maxSteps: 2,
  }, ctx);
  const wall = Date.now() - t0;
  console.log('\n' + out);
  console.log(`\nWALL: ${wall}ms`);
})().catch((e) => { console.error('FAILED:', e); process.exit(1); });
