'use strict';

const git = require('./git');
const checkpoints = require('./checkpoints');

const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

function modelLabel(p) {
  if (!p) return 'unknown';
  if (typeof p === 'string') return p;
  return String(p.label || p.model || p.name || p.provider || 'primary');
}

function detectModelFamily(providerOrModel) {
  const s = (typeof providerOrModel === 'string'
    ? providerOrModel
    : [
        providerOrModel && providerOrModel.model,
        providerOrModel && providerOrModel.provider,
        providerOrModel && providerOrModel.id,
        providerOrModel && providerOrModel.label,
      ].filter(Boolean).join(' ')
  ).toLowerCase();

  if (/claude|anthropic/.test(s)) return 'claude';
  if (/gpt|chatgpt|codex|openai|\bo1\b|\bo3\b|\bo4\b/.test(s)) return 'openai';
  if (/gemini|google|vertex/.test(s)) return 'gemini';
  if (/deepseek/.test(s)) return 'deepseek';
  if (/qwen/.test(s)) return 'qwen';
  if (/llama|meta/.test(s)) return 'llama';
  if (/mistral|mixtral/.test(s)) return 'mistral';
  return 'other';
}

function sameProvider(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  return (a.model || '') === (b.model || '') && (a.baseUrl || '') === (b.baseUrl || '');
}

function pickSecondOpinionProvider({ primary, orchestrator, withSpec = '' } = {}) {
  const pool = Array.isArray(orchestrator && orchestrator.providers)
    ? orchestrator.providers.filter((p) => p && p.enabled !== false)
    : [];
  const primaryFamily = detectModelFamily(primary);
  const spec = String(withSpec || '').trim();

  if (spec) {
    const low = spec.toLowerCase();
    const exact = pool.find((p) =>
      String(p.id || '').toLowerCase() === low ||
      String(p.model || '').toLowerCase() === low ||
      String(p.label || '').toLowerCase() === low
    );
    const partial = exact || pool.find((p) =>
      String(p.model || '').toLowerCase().includes(low) ||
      String(p.label || '').toLowerCase().includes(low) ||
      String(p.provider || '').toLowerCase().includes(low)
    );
    if (partial) {
      const fam = detectModelFamily(partial);
      return {
        provider: partial,
        differentFamily: fam !== primaryFamily,
        sameModelFallback: sameProvider(partial, primary),
        requestedWith: spec,
      };
    }
    const synthetic = { ...(primary || {}), id: 'with-' + low.replace(/[^a-z0-9._-]+/g, '-'), model: spec, label: spec };
    const fam = detectModelFamily(synthetic);
    return {
      provider: synthetic,
      differentFamily: fam !== primaryFamily,
      sameModelFallback: sameProvider(synthetic, primary),
      requestedWith: spec,
    };
  }

  const diffFam = pool.find((p) => !sameProvider(p, primary) && detectModelFamily(p) !== primaryFamily);
  if (diffFam) {
    return { provider: diffFam, differentFamily: true, sameModelFallback: false, requestedWith: '' };
  }
  const other = pool.find((p) => !sameProvider(p, primary));
  if (other) {
    return { provider: other, differentFamily: false, sameModelFallback: false, requestedWith: '' };
  }
  return { provider: primary || {}, differentFamily: false, sameModelFallback: true, requestedWith: '' };
}

function loadProjectGuidelines(cwd) {
  if (!cwd) return '';
  const fs = require('fs');
  const path = require('path');
  const candidates = [
    path.join(cwd, 'CLAUDE.md'),
    path.join(cwd, 'AKRON.md'),
    path.join(cwd, '.claude', 'CLAUDE.md'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const txt = fs.readFileSync(p, 'utf8').trim();
        if (txt) return `Project guidelines (${path.basename(p)}):\n` + txt.slice(0, 3500);
      }
    } catch (_) {}
  }
  return '';
}

function collectCallerAndFileContext(cwd, files = [], maxChars = 8000) {
  if (!cwd || !Array.isArray(files) || !files.length) {
    return { callerText: '', fileContextText: '', callersCount: 0, fileContextsCount: 0 };
  }
  const fs = require('fs');
  const path = require('path');
  const symbolSet = new Set();
  const fileContextParts = [];
  let ctxChars = 0;

  for (const f of files.slice(0, 8)) {
    const rel = f.relPath || f.path || '';
    const abs = path.isAbsolute(rel) ? rel : path.join(cwd, rel);
    for (const ln of (Array.isArray(f.lines) ? f.lines : [])) {
      if (!ln || ln.type === 'context' || typeof ln.text !== 'string') continue;
      const m = /(?:function|class|async\s+function|def|export\s+(?:async\s+)?function|const)\s+([A-Za-z_][A-Za-z0-9_]{2,})/.exec(ln.text);
      if (m && m[1]) symbolSet.add(m[1]);
    }
    try {
      if (fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size <= 6000 && ctxChars < Math.floor(maxChars * 0.6)) {
        const full = fs.readFileSync(abs, 'utf8');
        const snippet = `--- Full context: ${rel} ---\n${full.slice(0, 2200)}\n`;
        fileContextParts.push(snippet);
        ctxChars += snippet.length;
      }
    } catch (_) {}
  }

  const callerHits = [];
  const symbols = [...symbolSet].slice(0, 6);
  if (symbols.length) {
    const walk = (dir, depth = 0) => {
      if (depth > 3 || callerHits.length >= 24) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const ent of entries) {
        if (callerHits.length >= 24) break;
        if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist' || ent.name === 'release') continue;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (/\.(js|jsx|ts|tsx|mjs|cjs|py|go)$/i.test(ent.name)) {
          try {
            const st = fs.statSync(full);
            if (st.size > 80000) continue;
            const raw = fs.readFileSync(full, 'utf8');
            for (const sym of symbols) {
              if (!raw.includes(sym)) continue;
              const lines = raw.split('\n');
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(sym) && callerHits.length < 24) {
                  callerHits.push(`${path.relative(cwd, full)}:${i + 1}: ${lines[i].trim().slice(0, 120)}`);
                }
              }
            }
          } catch (_) {}
        }
      }
    };
    walk(cwd, 0);
  }

  return {
    callerText: callerHits.length ? `Referenced symbol callers (${callerHits.length}):\n` + callerHits.join('\n') : '',
    fileContextText: fileContextParts.join('\n').slice(0, maxChars),
    callersCount: callerHits.length,
    fileContextsCount: fileContextParts.length,
  };
}

function buildDuetBundle({ cwd, convId, target = null, diffFiles = null, maxFiles = 24, maxChars = 55000 } = {}) {
  let files = Array.isArray(diffFiles) ? diffFiles : null;
  if (!files) {
    if (target && target.checkpointId && convId) {
      try {
        files = checkpoints.computeTurnDiffs(convId, target.checkpointId, cwd);
      } catch (_) {
        files = [];
      }
    }
    if (!files || !files.length) {
      try {
        files = cwd ? git.gitDiffFiles(cwd) : [];
      } catch (_) {
        files = [];
      }
    }
  }

  const list = (Array.isArray(files) ? files : []).slice(0, maxFiles);
  let totalAdded = 0;
  let totalRemoved = 0;
  const parts = [];
  let chars = 0;
  let truncated = (Array.isArray(files) ? files.length : 0) > list.length;
  const guidelinesText = loadProjectGuidelines(cwd);
  const extraCtx = collectCallerAndFileContext(cwd, list);

  for (const f of list) {
    const rel = f.relPath || f.path || 'file';
    const added = Number(f.added) || 0;
    const removed = Number(f.removed) || 0;
    totalAdded += added;
    totalRemoved += removed;

    const header = `=== ${rel} (+${added} -${removed}, ${f.status || 'modified'}) ===\n`;
    const bodyLines = [];
    const lines = Array.isArray(f.lines) ? f.lines : [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!ln) continue;
      if (ln.type === 'context' && i > 2 && i < lines.length - 3) {
        const prevChg = (lines[i - 1] && lines[i - 1].type !== 'context') || (lines[i - 2] && lines[i - 2].type !== 'context');
        const nextChg = (lines[i + 1] && lines[i + 1].type !== 'context') || (lines[i + 2] && lines[i + 2].type !== 'context');
        if (!prevChg && !nextChg) continue;
      }
      const mark = ln.type === 'add' ? '+' : ln.type === 'del' ? '-' : ' ';
      const num = ln.newLine != null ? ln.newLine : (ln.oldLine != null ? ln.oldLine : '');
      bodyLines.push(`L${num}: ${mark} ${ln.text != null ? ln.text : ''}`);
    }
    const block = header + bodyLines.join('\n') + '\n';
    if (chars + block.length > maxChars) {
      const remain = Math.max(0, maxChars - chars);
      if (remain > 200) parts.push(block.slice(0, remain) + '\n... [truncated]');
      truncated = true;
      break;
    }
    parts.push(block);
    chars += block.length;
  }

  return {
    files: list,
    diffText: parts.join('\n'),
    guidelinesText,
    callerText: extraCtx.callerText,
    fileContextText: extraCtx.fileContextText,
    guidelinesIncluded: !!guidelinesText,
    callersCount: extraCtx.callersCount,
    fileContextsCount: extraCtx.fileContextsCount,
    fileCount: list.length,
    added: totalAdded,
    removed: totalRemoved,
    truncated,
  };
}

function parseJsonResponse(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return {};
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(txt);
  const candidate = fence ? fence[1].trim() : txt;
  try {
    return JSON.parse(candidate);
  } catch (_) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch (_) {}
    }
  }
  return { summary: txt.slice(0, 500), findings: [] };
}

function normalizeFinding(raw, idx, passTag) {
  if (!raw || typeof raw !== 'object') return null;
  const title = String(raw.title || raw.issue || raw.message || '').trim();
  if (!title) return null;
  const sev = String(raw.severity || 'medium').toLowerCase();
  const severity = SEVERITY_RANK[sev] != null ? sev : 'medium';
  const confRaw = Number(raw.confidence);
  const confidence = Number.isFinite(confRaw) ? Math.max(0, Math.min(100, Math.round(confRaw))) : 75;
  return {
    id: String(raw.id || `${passTag}_${idx + 1}`),
    severity,
    category: String(raw.category || (passTag === 'adv' ? 'adversarial' : 'bug')).toLowerCase(),
    file: String(raw.file || '').trim(),
    line: raw.line != null && raw.line !== '' ? Number(raw.line) || raw.line : null,
    title,
    detail: String(raw.detail || raw.description || raw.why || '').trim(),
    fix: String(raw.fix || raw.suggestedFix || raw.fixPrompt || '').trim(),
    evidence: String(raw.evidence || raw.quote || '').trim(),
    confidence,
    pass: passTag,
  };
}

function mergeCandidateFindings(listA, listB) {
  const seen = new Set();
  const out = [];
  for (const item of [...listA, ...listB]) {
    if (!item) continue;
    const key = `${item.file.toLowerCase()}:${item.line || ''}:${item.title.toLowerCase().slice(0, 64)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

async function runDuetReview({
  cwd,
  convId,
  target = null,
  primaryProvider,
  secondProvider,
  orchestrator = null,
  withSpec = '',
  adversarial = false,
  diffFiles = null,
  chatFn = null,
} = {}) {
  const startedAt = Date.now();
  const bundle = buildDuetBundle({ cwd, convId, target, diffFiles });
  const pick = secondProvider
    ? {
        provider: secondProvider,
        differentFamily: detectModelFamily(secondProvider) !== detectModelFamily(primaryProvider),
        sameModelFallback: sameProvider(secondProvider, primaryProvider),
      }
    : pickSecondOpinionProvider({ primary: primaryProvider, orchestrator, withSpec });

  const primaryLabel = modelLabel(primaryProvider);
  const reviewerLabel = modelLabel(pick.provider);

  if (!bundle.files.length) {
    return {
      ok: true,
      empty: true,
      primaryLabel,
      reviewerLabel,
      differentFamily: pick.differentFamily,
      sameModelFallback: pick.sameModelFallback,
      adversarial: !!adversarial,
      passesRun: 0,
      summary: 'No uncommitted diffs or turn changes found to review.',
      findings: [],
      openQuestions: [],
      bundleMeta: { fileCount: 0, added: 0, removed: 0, truncated: false },
      durationMs: Date.now() - startedAt,
    };
  }

  const invokeChat = chatFn || require('./llm').chatOnce;
  let passesRun = 0;

  const contextBlocks = [
    bundle.guidelinesText,
    bundle.callerText,
    bundle.fileContextText,
  ].filter(Boolean).join('\n\n');

  // Pass 1: Precision + GAP code review on second opinion model
  const pass1Prompt = [
    'You are the independent second-opinion code reviewer in a Duet Review.',
    'Analyze the diff for: (1) correctness bugs & regressions, (2) security/injection/auth gaps, (3) missing edge cases & unhandled errors (GAPs).',
    'Cite exact file paths, line numbers, and evidence from the diff. Do NOT invent code not in the diff.',
    'Return strict JSON ONLY:',
    '{"summary":"concise 1-2 sentence overview","findings":[{"id":"f1","severity":"critical|high|medium|low","category":"bug|security|gap|performance","file":"path","line":12,"title":"short title","detail":"why it breaks","fix":"concrete fix","evidence":"diff line quote","confidence":0-100}]}',
    contextBlocks ? '\nPROJECT CONTEXT & CALLERS:\n' + contextBlocks : '',
    '',
    'DIFF BUNDLE:',
    bundle.diffText,
  ].filter((x) => x !== '').join('\n');

  const p1Res = await invokeChat({
    provider: pick.provider,
    messages: [{ role: 'user', content: pass1Prompt }],
    maxTokens: 3200,
  });
  passesRun++;
  const p1Json = parseJsonResponse(p1Res && p1Res.content);
  const pass1Findings = (Array.isArray(p1Json.findings) ? p1Json.findings : [])
    .map((f, i) => normalizeFinding(f, i, 'p1'))
    .filter(Boolean);

  // Pass 2: Optional Adversarial pass
  let pass2Findings = [];
  if (adversarial) {
    const pass2Prompt = [
      'You are an adversarial red-team reviewer challenging the changed code below.',
      'Assume bad inputs, concurrent execution, partial failures, race conditions, malformed payloads, and trust-boundary bypasses.',
      'Focus on failure modes missed by standard happy-path review. Do not duplicate these already-noted titles:',
      pass1Findings.map((f) => `- ${f.title}`).join('\n') || '(none)',
      'Return strict JSON ONLY:',
      '{"findings":[{"id":"adv1","severity":"critical|high|medium|low","category":"adversarial|security|race|resilience","file":"path","line":12,"title":"short title","detail":"attack/failure scenario","fix":"concrete hardening","evidence":"diff line quote","confidence":0-100}]}',
      '',
      'DIFF BUNDLE:',
      bundle.diffText,
    ].join('\n');

    const p2Res = await invokeChat({
      provider: pick.provider,
      messages: [{ role: 'user', content: pass2Prompt }],
      maxTokens: 2800,
    });
    passesRun++;
    const p2Json = parseJsonResponse(p2Res && p2Res.content);
    pass2Findings = (Array.isArray(p2Json.findings) ? p2Json.findings : [])
      .map((f, i) => normalizeFinding(f, i, 'adv'))
      .filter(Boolean);
  }

  const candidates = mergeCandidateFindings(pass1Findings, pass2Findings);

  // Pass 3: Primary Verification Pass (verifies against diff & assigns 0-100 confidence)
  let verifiedList = candidates;
  let finalSummary = String(p1Json.summary || '').trim();

  if (candidates.length > 0) {
    const verifyPrompt = [
      'You are the Primary Model verifying candidate review findings from the second-opinion reviewer.',
      'Check each candidate against the actual diff. Score confidence 0-100 (use >= 70 ONLY if concrete and verified against the code; use < 70 if speculative, minor nitpick, or unverified).',
      'Return strict JSON ONLY preserving every candidate id (never silently drop items):',
      '{"summary":"verified review summary","verified":[{"id":"...","verified":true,"confidence":0-100,"verificationNote":"why confirmed or uncertain","fixPrompt":"clean actionable instruction"}]}',
      '',
      'CANDIDATE FINDINGS:',
      JSON.stringify(candidates, null, 2),
      '',
      'DIFF BUNDLE:',
      bundle.diffText.slice(0, 32000),
    ].join('\n');

    const p3Res = await invokeChat({
      provider: primaryProvider || pick.provider,
      messages: [{ role: 'user', content: verifyPrompt }],
      maxTokens: 3000,
    });
    passesRun++;
    const p3Json = parseJsonResponse(p3Res && p3Res.content);
    if (p3Json.summary) finalSummary = String(p3Json.summary).trim();

    const byId = new Map();
    for (const v of (Array.isArray(p3Json.verified) ? p3Json.verified : [])) {
      if (v && v.id) byId.set(String(v.id), v);
    }
    verifiedList = candidates.map((c) => {
      const v = byId.get(c.id);
      if (!v) return c;
      const vConf = Number(v.confidence);
      const confidence = Number.isFinite(vConf) ? Math.max(0, Math.min(100, Math.round(vConf))) : c.confidence;
      return {
        ...c,
        verified: v.verified !== false,
        confidence,
        verificationNote: String(v.verificationNote || '').trim(),
        fix: String(v.fix || v.fixPrompt || '').trim(),
        fixPrompt: String(v.fixPrompt || v.fix || '').trim(),
      };
    });
  }

  verifiedList.sort((a, b) => {
    const sr = (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
    if (sr !== 0) return sr;
    return (b.confidence || 0) - (a.confidence || 0);
  });

  const findings = verifiedList.filter((f) => f.confidence >= 70);
  const openQuestions = verifiedList.filter((f) => f.confidence < 70);

  return {
    ok: true,
    empty: false,
    primaryLabel,
    reviewerLabel,
    differentFamily: pick.differentFamily,
    sameModelFallback: pick.sameModelFallback,
    adversarial: !!adversarial,
    passesRun,
    summary: finalSummary || `Verified ${findings.length} actionable issue(s) and ${openQuestions.length} open question(s).`,
    findings,
    openQuestions,
    bundleMeta: {
      fileCount: bundle.fileCount,
      added: bundle.added,
      removed: bundle.removed,
      truncated: bundle.truncated,
      guidelinesIncluded: !!bundle.guidelinesIncluded,
      callersCount: Number(bundle.callersCount) || 0,
      fileContextsCount: Number(bundle.fileContextsCount) || 0,
    },
    durationMs: Date.now() - startedAt,
  };
}

module.exports = {
  detectModelFamily,
  pickSecondOpinionProvider,
  buildDuetBundle,
  runDuetReview,
  parseJsonResponse,
};
