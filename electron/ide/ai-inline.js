'use strict';
const { execFileSync } = require('child_process');
const path = require('path');
const llm = require('../llm');
const router = require('../orch-router');

const completionCache = new Map();
const MAX_CACHE = 64;

function cacheSet(k, v) {
  if (completionCache.has(k)) completionCache.delete(k);
  completionCache.set(k, v);
  if (completionCache.size > MAX_CACHE) {
    const oldest = completionCache.keys().next().value;
    completionCache.delete(oldest);
  }
}

function stripOuterCodeFences(raw) {
  let s = String(raw || '');
  const m = /^\s*```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(s);
  if (m) return m[1];
  s = s.replace(/^\s*```[a-zA-Z0-9_+-]*\r?\n/, '').replace(/\r?\n```\s*$/, '');
  return s;
}

function buildProviderChain({ provider, orchestrator, role }) {
  const base = llm.normalizeProvider(provider || {});
  if (orchestrator && orchestrator.enabled && Array.isArray(orchestrator.providers) && orchestrator.providers.length) {
    try {
      const scoped = router.orchestratorFor(orchestrator, role || 'coder', base);
      if (scoped && Array.isArray(scoped.providers) && scoped.providers.length) {
        return scoped.providers.map(llm.normalizeProvider);
      }
    } catch (_) {}
    const rows = orchestrator.providers.map(llm.normalizeProvider);
    if (!rows.some((r) => r.baseURL === base.baseURL && r.model === base.model)) {
      rows.unshift(base);
    }
    return rows;
  }
  return [base];
}

async function runInlineEdit(opts = {}) {
  const {
    provider,
    orchestrator,
    filePath = '',
    language = '',
    selection = '',
    prefix = '',
    suffix = '',
    instruction = '',
    signal,
    onDelta,
  } = opts;
  const list = buildProviderChain({ provider, orchestrator, role: 'coder' });
  let idx = 0;

  const sysPrompt =
    'You are an inline code editor engine. Output ONLY the exact replacement code for the target selection (or new code to insert at cursor). ' +
    'Do NOT include markdown fences (```), commentary, or explanations unless the instruction explicitly asks for comments inside the code. Preserve indentation.';

  const userPrompt = [
    filePath ? `File: ${path.basename(filePath)} (${language || 'text'})` : (language ? `Language: ${language}` : ''),
    prefix ? `<prefix>\n${prefix.slice(-1800)}\n</prefix>` : '',
    selection ? `<selection>\n${selection}\n</selection>` : '<cursor />',
    suffix ? `<suffix>\n${suffix.slice(0, 1200)}\n</suffix>` : '',
    `Instruction: ${String(instruction || 'Improve this code').trim()}`,
    'Output ONLY the replacement/inserted code:',
  ].filter(Boolean).join('\n\n');

  let acc = '';
  const msg = await llm.chatWithFailover({
    list,
    getIndex: () => idx,
    setIndex: (i) => { idx = i; },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 4096,
    signal,
    onDelta: (chunk, thinking) => {
      if (thinking || !chunk) return;
      acc += chunk;
      if (typeof onDelta === 'function') onDelta(chunk, stripOuterCodeFences(acc));
    },
    emit: () => {},
  });

  const finalRaw = (msg && typeof msg.content === 'string' && msg.content) ? msg.content : acc;
  return { ok: true, text: stripOuterCodeFences(finalRaw), model: (msg && msg.servedBy) || (list[idx] && list[idx].model) || '' };
}

async function runInlineComplete(opts = {}) {
  const {
    provider,
    orchestrator,
    filePath = '',
    language = 'plaintext',
    prefix = '',
    suffix = '',
    signal,
  } = opts;

  const pre = String(prefix || '').slice(-1400);
  const suf = String(suffix || '').slice(0, 500);
  if (!pre.trim()) return { ok: true, insertText: '', cached: false };

  const cacheKey = `${language}|${pre.slice(-280)}|${suf.slice(0, 120)}`;
  if (completionCache.has(cacheKey)) {
    return { ok: true, insertText: completionCache.get(cacheKey), cached: true };
  }

  const list = buildProviderChain({ provider, orchestrator, role: 'fast' });
  let idx = 0;

  const sysPrompt =
    'You are a fast inline code autocomplete engine (ghost text). Output ONLY the missing code immediately following <prefix> and before <suffix>. Never repeat the prefix, never wrap in markdown fences, keep it concise (1-4 lines max).';
  const userPrompt = `File: ${path.basename(filePath || 'file')} (${language})\n<prefix>\n${pre}\n</prefix>\n<suffix>\n${suf}\n</suffix>`;

  let acc = '';
  const msg = await llm.chatWithFailover({
    list,
    getIndex: () => idx,
    setIndex: (i) => { idx = i; },
    messages: [
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt },
    ],
    maxTokens: 96,
    signal,
    onDelta: (c, th) => { if (!th && c) acc += c; },
    emit: () => {},
  });

  const raw = stripOuterCodeFences((msg && msg.content) || acc || '');
  const insertText = raw.replace(/\s+$/, '');
  if (insertText) cacheSet(cacheKey, insertText);
  return { ok: true, insertText, cached: false };
}

async function generateCommitMessage(opts = {}) {
  const { provider, orchestrator, cwd = process.cwd() } = opts;
  let diff = '';
  try {
    diff = execFileSync('git', ['diff', '--cached', '--stat'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (!diff) {
      diff = execFileSync('git', ['status', '--short'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    }
    const patch = execFileSync('git', ['diff', '--cached'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      || execFileSync('git', ['diff'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 4000, maxBuffer: 512 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    if (patch) diff += '\n\n' + patch.slice(0, 6000);
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
  if (!diff.trim()) return { ok: false, error: 'No changes to commit' };

  const list = buildProviderChain({ provider, orchestrator, role: 'fast' });
  let idx = 0;
  let acc = '';
  const msg = await llm.chatWithFailover({
    list,
    getIndex: () => idx,
    setIndex: (i) => { idx = i; },
    messages: [
      { role: 'system', content: 'Write one crisp Conventional Commit subject line (max 72 chars, e.g. "feat: add xterm PTY terminal") describing these git changes. Output ONLY the commit message text.' },
      { role: 'user', content: diff },
    ],
    maxTokens: 120,
    onDelta: (c, th) => { if (!th && c) acc += c; },
    emit: () => {},
  });
  const text = String((msg && msg.content) || acc || '').replace(/^["'`]|["'`]$/g, '').trim();
  return { ok: Boolean(text), message: text };
}

module.exports = {
  runInlineEdit,
  runInlineComplete,
  generateCommitMessage,
  stripOuterCodeFences,
};
