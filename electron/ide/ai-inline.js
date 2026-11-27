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

/**
 * Predict the next related edit location/hunk (`Tab-to-Jump`) after an edit.
 * Stage 1 (deterministic, <2ms): detects symbol renames or call-site arg count mismatches.
 * Stage 2 (optional LLM): predicts non-trivial semantic next edits when live provider is supplied.
 */
async function predictNextEdit(opts = {}) {
  const {
    filePath = '',
    language = 'javascript',
    oldContent = '',
    newContent = '',
    editLine = 1,
    provider = null,
    orchestrator = null,
    signal = null,
  } = opts;

  const oldLines = String(oldContent || '').split(/\r?\n/);
  const newLines = String(newContent || '').split(/\r?\n/);
  const focusIdx = Math.max(0, Math.min(newLines.length - 1, (Number(editLine) || 1) - 1));
  const oldLine = oldLines[focusIdx] || '';
  const newLine = newLines[focusIdx] || '';

  // 1. Detect identifier rename on edited line (`function foo`, `const foo`, `def foo`, `return foo`, etc.)
  const extractIdents = (s) => (String(s || '').match(/\b[A-Za-z_$][\w$]{2,}\b/g) || []);
  const oldIdents = extractIdents(oldLine);
  const newIdents = extractIdents(newLine);
  const removedIdents = oldIdents.filter((id) => !newIdents.includes(id));
  const addedIdents = newIdents.filter((id) => !oldIdents.includes(id));

  if (removedIdents.length === 1 && addedIdents.length === 1) {
    const oldSym = removedIdents[0];
    const newSym = addedIdents[0];
    const re = new RegExp(`\\b${oldSym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    for (let i = 0; i < newLines.length; i++) {
      if (i === focusIdx) continue;
      const ln = newLines[i];
      const m = re.exec(ln);
      if (m) {
        return {
          ok: true,
          source: 'deterministic-rename',
          prediction: {
            line: i + 1,
            column: m.index + 1,
            oldLineText: ln,
            replacementLineText: ln.replace(re, newSym),
            reason: `Update remaining reference "${oldSym}" -> "${newSym}"`,
          },
        };
      }
    }
  }

  // 2. Detect added parameter to function signature (`fn(a)` -> `fn(a, b)`) and find un-updated call site
  const sigRe = /\b(?:function|def|func|async\s+function)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/;
  const oldSig = sigRe.exec(oldLine);
  const newSig = sigRe.exec(newLine);
  if (oldSig && newSig && oldSig[1] === newSig[1]) {
    const fnName = newSig[1];
    const oldParams = oldSig[2].split(',').map((s) => s.trim()).filter(Boolean);
    const newParams = newSig[2].split(',').map((s) => s.trim()).filter(Boolean);
    if (newParams.length > oldParams.length) {
      const addedParam = newParams[newParams.length - 1].split(/[=:]/)[0].trim();
      const callRe = new RegExp(`\\b${fnName}\\s*\\(([^)]*)\\)`);
      for (let i = 0; i < newLines.length; i++) {
        if (i === focusIdx) continue;
        const ln = newLines[i];
        const cm = callRe.exec(ln);
        if (cm) {
          const callArgs = cm[1].split(',').map((s) => s.trim()).filter(Boolean);
          if (callArgs.length < newParams.length) {
            const nextArgs = callArgs.length ? `${cm[1]}, ${addedParam}` : addedParam;
            return {
              ok: true,
              source: 'deterministic-signature',
              prediction: {
                line: i + 1,
                column: cm.index + 1,
                oldLineText: ln,
                replacementLineText: ln.replace(cm[0], `${fnName}(${nextArgs})`),
                reason: `Pass new argument "${addedParam}" to ${fnName}()`,
              },
            };
          }
        }
      }
    }
  }

  // 3. Optional fast LLM Stage-2 prediction only when explicitly configured
  const hasKey = provider && (provider.apiKey || provider.accessToken || /11434/.test(String(provider.baseURL || '')));
  if (hasKey && newLines.length > 0 && newLines.length <= 400) {
    try {
      const list = buildProviderChain({ provider, orchestrator, role: 'fast' });
      let idx = 0;
      const numbered = newLines.map((l, idx0) => `${idx0 + 1}: ${l}`).join('\n').slice(0, 6000);
      const msg = await llm.chatWithFailover({
        list,
        getIndex: () => idx,
        setIndex: (i) => { idx = i; },
        messages: [
          {
            role: 'system',
            content: 'Predict the next single line needing a cascading update after the user edited line ' + (focusIdx + 1) + '. Return JSON only: {"line":number,"replacementLineText":string,"reason":string} or {"none":true}.',
          },
          { role: 'user', content: `File (${language}): ${path.basename(filePath || 'code')}\nEdited L${focusIdx + 1}: "${oldLine}" -> "${newLine}"\n\n${numbered}` },
        ],
        maxTokens: 160,
        signal: signal || AbortSignal.timeout(1500),
        emit: () => {},
      });
      const raw = String((msg && msg.content) || '').trim();
      const jm = /\{[\s\S]*\}/.exec(raw);
      if (jm) {
        const obj = JSON.parse(jm[0]);
        if (obj && Number.isInteger(obj.line) && obj.line >= 1 && obj.line <= newLines.length && typeof obj.replacementLineText === 'string' && obj.line !== focusIdx + 1) {
          return {
            ok: true,
            source: 'llm',
            prediction: {
              line: obj.line,
              column: 1,
              oldLineText: newLines[obj.line - 1],
              replacementLineText: obj.replacementLineText,
              reason: String(obj.reason || 'Predicted related edit'),
            },
          };
        }
      }
    } catch (_) {}
  }

  return { ok: true, source: 'none', prediction: null };
}

module.exports = {
  runInlineEdit,
  runInlineComplete,
  generateCommitMessage,
  predictNextEdit,
  stripOuterCodeFences,
};
