'use strict';

const DEFAULT_KEEP_RECENT_STEPS = 4;
const DEFAULT_MASK_MIN_CHARS = 1400;
const SHRINK_RATIOS = [0.65, 0.45, 0.28];

function shrinkingBudgets(baseBudget) {
  const b = Math.max(24000, Number(baseBudget) || 64000);
  return SHRINK_RATIOS.map((r) => Math.max(24000, Math.round(b * r)));
}

function extractImportantSignals(text) {
  const lines = String(text || '').split('\n');
  const filePaths = new Set();
  const keyLines = [];

  for (const ln of lines) {
    const mPath = /(?:^|[\s`"'(])((?:\/|\.\.?\/|[A-Za-z]:\\)[A-Za-z0-9_.\-/\\]{2,120}\.[A-Za-z0-9]{1,10}|(?:src|electron|test|scripts|docs)\/[A-Za-z0-9_.\-/]{2,100})/g;
    let pm;
    while ((pm = mPath.exec(ln)) && filePaths.size < 10) {
      filePaths.add(pm[1]);
    }
    if (keyLines.length < 10 && /(error|fail|exception|traceback|exit code|exited with|assert|\d+ passed|\d+ failed|---|\+\+\+|@@|warning:|denied|blocked|spilled to disk)/i.test(ln)) {
      keyLines.push(ln.trim().slice(0, 180));
    }
  }

  return {
    lineCount: lines.length,
    bytes: Buffer.byteLength(String(text || ''), 'utf8'),
    filePaths: Array.from(filePaths),
    keyLines,
    headLines: lines.slice(0, 5).map((l) => l.slice(0, 180)),
    tailLines: lines.slice(-5).map((l) => l.slice(0, 180)),
  };
}

function summarizeToolResult(text, name = 'tool') {
  const s = String(text || '');
  const info = extractImportantSignals(s);
  const parts = [
    `[Masked step output (${name}) — ${info.lineCount} lines, ${info.bytes} bytes]`,
  ];
  if (info.filePaths.length) {
    parts.push(`Paths: ${info.filePaths.join(', ')}`);
  }
  if (info.keyLines.length) {
    parts.push('Key signals:\n' + info.keyLines.join('\n'));
  } else {
    if (info.headLines.length) parts.push('Head:\n' + info.headLines.join('\n'));
    if (info.lineCount > 10 && info.tailLines.length) parts.push('Tail:\n' + info.tailLines.join('\n'));
  }
  return parts.join('\n');
}

function isTextProtocolToolMessage(m) {
  return !!(
    m &&
    m.role === 'user' &&
    typeof m.content === 'string' &&
    /^TOOL RESULT\s+\S+\s+\([^)]+\):/m.test(m.content)
  );
}

/**
 * Progressively mask verbose tool outputs older than the last `keepRecentSteps`
 * assistant turns. Always returns a shallow-cloned wire array so live/persisted
 * transcript objects are never mutated in place.
 */
function maskOlderToolOutputs(messages, {
  keepRecentSteps = DEFAULT_KEEP_RECENT_STEPS,
  minChars = DEFAULT_MASK_MIN_CHARS,
  quantizeSteps = 0,
} = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return [];

  // Identify indices of assistant turns; everything before the cutoff assistant
  // turn is eligible for progressive tool output masking.
  const assistantIndices = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].role === 'assistant') assistantIndices.push(i);
  }
  if (assistantIndices.length <= keepRecentSteps) {
    return list.slice();
  }
  // Quantize the cutoff boundary in buckets of 8 assistant turns for large
  // production windows so prefix cache hashes stay byte-identical across steps.
  const rawCutPos = assistantIndices.length - keepRecentSteps;
  const stepBucket = Number(quantizeSteps) > 1 ? Math.floor(Number(quantizeSteps)) : (keepRecentSteps >= 16 ? 8 : 1);
  const bucketedPos = stepBucket > 1 ? Math.max(0, Math.floor(rawCutPos / stepBucket) * stepBucket) : rawCutPos;
  const cutoffIdx = assistantIndices[bucketedPos];

  return list.map((m, idx) => {
    if (!m || idx >= cutoffIdx) return m;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > minChars) {
      return {
        ...m,
        content: summarizeToolResult(m.content, m.name || 'tool'),
      };
    }
    if (isTextProtocolToolMessage(m) && m.content.length > minChars) {
      const nl = m.content.indexOf('\n');
      const header = nl > 0 ? m.content.slice(0, nl) : 'TOOL RESULT:';
      const body = nl > 0 ? m.content.slice(nl + 1) : m.content;
      const nameMatch = /\(([^)]+)\):/.exec(header);
      return {
        ...m,
        content: `${header}\n${summarizeToolResult(body, (nameMatch && nameMatch[1]) || 'tool')}`,
      };
    }
    return m;
  });
}

module.exports = {
  DEFAULT_KEEP_RECENT_STEPS,
  DEFAULT_MASK_MIN_CHARS,
  SHRINK_RATIOS,
  shrinkingBudgets,
  summarizeToolResult,
  maskOlderToolOutputs,
};
