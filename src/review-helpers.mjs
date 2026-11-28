// Pure helpers shared between CodeReviewPane, App UI, and Node unit tests.

export function fallbackDiffsFromTools(tools = []) {
  const byPath = new Map();
  for (const t of (Array.isArray(tools) ? tools : [])) {
    if (!t) continue;
    const nm = String(t.name || '');
    if (nm !== 'Write' && nm !== 'Edit' && nm !== 'MultiEdit' && nm !== 'StrReplace') continue;
    const a = t.args || {};
    const p = String(a.file_path || a.path || '');
    if (!p) continue;
    const cur = byPath.get(p) || {
      path: p,
      relPath: p.split('/').slice(-2).join('/'),
      status: nm === 'Write' ? 'added' : 'modified',
      added: 0,
      removed: 0,
      lines: [],
    };
    if (nm === 'Write') {
      const arr = String(a.content || '').split('\n');
      arr.forEach((txt, idx) => {
        cur.lines.push({ type: 'add', oldLine: null, newLine: idx + 1, text: txt });
        cur.added++;
      });
    } else {
      const edits = Array.isArray(a.edits)
        ? a.edits
        : [{ old_string: a.old_string ?? a.old_str ?? '', new_string: a.new_string ?? a.new_str ?? '' }];
      let ln = 1;
      for (const e of edits) {
        const dels = String(e?.old_string ?? '').split('\n');
        const adds = String(e?.new_string ?? '').split('\n');
        dels.forEach((txt) => {
          cur.lines.push({ type: 'del', oldLine: ln++, newLine: null, text: txt });
          cur.removed++;
        });
        adds.forEach((txt, i) => {
          cur.lines.push({ type: 'add', oldLine: null, newLine: i + 1, text: txt });
          cur.added++;
        });
      }
    }
    byPath.set(p, cur);
  }
  return [...byPath.values()];
}

export function mergeDiffFiles(primary = [], secondary = []) {
  const out = [];
  const byKey = new Map();
  const normKey = (f) => String(f?.path || f?.relPath || '').replace(/\\/g, '/');

  const ingest = (list, preferRicher) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      if (!item || (!item.path && !item.relPath)) continue;
      const key = normKey(item);
      const existing = byKey.get(key)
        || out.find((x) => {
          const xp = normKey(x);
          const xr = String(x.relPath || '').replace(/\\/g, '/');
          const ir = String(item.relPath || '').replace(/\\/g, '/');
          return xp === key || (xr && ir && (xp.endsWith('/' + ir) || key.endsWith('/' + xr)));
        });
      if (!existing) {
        const copy = { ...item, lines: Array.isArray(item.lines) ? item.lines : [] };
        out.push(copy);
        byKey.set(key, copy);
      } else if (preferRicher && (item.lines?.length || 0) > (existing.lines?.length || 0)) {
        const idx = out.indexOf(existing);
        const copy = { ...existing, ...item, lines: Array.isArray(item.lines) ? item.lines : existing.lines };
        if (idx >= 0) out[idx] = copy;
        byKey.set(key, copy);
      }
    }
  };

  ingest(primary, false);
  ingest(secondary, true);
  return out;
}

export function groupDiffChunks(lines = []) {
  const out = [];
  const CONTEXT = 3;
  const n = lines.length;
  const keep = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (lines[i].type !== 'ctx') {
      for (let k = Math.max(0, i - CONTEXT); k <= Math.min(n - 1, i + CONTEXT); k++) keep[k] = 1;
    }
  }
  let i = 0;
  while (i < n) {
    if (keep[i] || lines[i].type !== 'ctx') {
      out.push({ kind: 'line', idx: i, line: lines[i] });
      i++;
    } else {
      const start = i;
      while (i < n && !keep[i] && lines[i].type === 'ctx') i++;
      if (i - start <= 2) {
        for (let k = start; k < i; k++) out.push({ kind: 'line', idx: k, line: lines[k] });
      } else {
        out.push({ kind: 'fold', id: `fold-${start}-${i}`, start, end: i, count: i - start, lines: lines.slice(start, i) });
      }
    }
  }
  return out;
}

export function computeFoldSlice(fold, revealState) {
  const count = Number(fold?.count ?? fold?.lines?.length ?? 0);
  const start = Number(fold?.start ?? 0);
  const end = Number(fold?.end ?? start + count);
  const lines = Array.isArray(fold?.lines) ? fold.lines : [];
  if (revealState === true) {
    return {
      expanded: true,
      topLines: lines.map((ln, idx) => ({ ln, rowIdx: start + idx })),
      bottomLines: [],
      remaining: 0,
    };
  }
  const top = Math.min(count, Math.max(0, Number(revealState && revealState.top) || 0));
  const bottom = Math.min(count - top, Math.max(0, Number(revealState && revealState.bottom) || 0));
  const remaining = Math.max(0, count - top - bottom);
  if (remaining === 0) {
    return {
      expanded: true,
      topLines: lines.map((ln, idx) => ({ ln, rowIdx: start + idx })),
      bottomLines: [],
      remaining: 0,
    };
  }
  return {
    expanded: false,
    topLines: lines.slice(0, top).map((ln, idx) => ({ ln, rowIdx: start + idx })),
    bottomLines: bottom > 0 ? lines.slice(count - bottom).map((ln, idx) => ({ ln, rowIdx: end - bottom + idx })) : [],
    remaining,
  };
}

export function findFoldForLine(chunks = [], lineIdx) {
  for (const ch of chunks || []) {
    if (ch && ch.kind === 'fold' && lineIdx >= ch.start && lineIdx < ch.end) {
      return ch.id;
    }
  }
  return null;
}

export function buildSearchMatcher(query, { matchCase = false, wholeWord = false, useRegex = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  try {
    let pat = useRegex ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) pat = `\\b(?:${pat})\\b`;
    return new RegExp(pat, matchCase ? 'g' : 'gi');
  } catch {
    return null;
  }
}

export function extInfo(filePath) {
  const m = /\.([a-zA-Z0-9]+)$/.exec(String(filePath || ''));
  const ext = m ? m[1].toUpperCase().slice(0, 4) : 'FILE';
  const low = ext.toLowerCase();
  let cls = 'other';
  if (low === 'js' || low === 'mjs' || low === 'cjs') cls = 'js';
  else if (low === 'jsx' || low === 'ts' || low === 'tsx') cls = 'ts';
  else if (low === 'css' || low === 'scss') cls = 'css';
  else if (low === 'py') cls = 'py';
  else if (low === 'json' || low === 'yml' || low === 'yaml') cls = 'json';
  else if (low === 'md' || low === 'txt') cls = 'md';
  return { label: ext, cls };
}

export function deriveSubAgents(liveSubAgents = [], conv = null, messages = [], live = null) {
  const byKey = new Map();
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);

  const hasSwarmSup = Boolean(conv && conv.swarmInfo && conv.swarmInfo.supervisor);
  const upsert = (item) => {
    if (!item) return;
    if (hasSwarmSup && (item.key === 'supervisor' || item.role === 'supervisor')) return;
    const rawKey = String(item.key || item.handle || item.name || '');
    if (!rawKey) return;
    const k = (item.key && /^(?:t|h)\d+$/i.test(String(item.key)))
      ? String(item.key)
      : (norm(item.handle || item.name || item.key) || rawKey);
    const prev = byKey.get(k);
    if (!prev) {
      byKey.set(k, { ...item });
      return;
    }
    byKey.set(k, {
      ...prev,
      ...item,
      progress: item.progress && (item.progress.tools || item.progress.chars || item.progress.last)
        ? { ...(prev.progress || {}), ...item.progress }
        : (prev.progress || item.progress),
    });
  };

  for (const a of (conv && Array.isArray(conv.subAgents) ? conv.subAgents : [])) upsert(a);
  for (const m of messages || []) {
    if (m && Array.isArray(m.subAgents)) {
      for (const a of m.subAgents) upsert(a);
    }
  }
  for (const a of liveSubAgents || []) upsert(a);

  // Also infer subagent entries from recorded Task / Agent / Swarm spawn tool calls
  // so conversations reloaded from disk retain subagent counts and cards.
  const allTools = [];
  for (const m of messages || []) {
    if (m && Array.isArray(m.tools)) allTools.push(...m.tools);
  }
  if (live && Array.isArray(live.tools)) allTools.push(...live.tools);

  for (let i = 0; i < allTools.length; i++) {
    const t = allTools[i];
    if (!t) continue;
    const nm = String(t.name || '');
    const args = t.args || {};
    const isTask = nm === 'Task' || nm === 'Agent' || nm === 'dispatch_agent';
    const isSwarmSpawn = nm === 'Swarm' && (args.action === 'add' || args.action === 'spawn');
    if (!isTask && !isSwarmSpawn) continue;
    const label = String(args.name || args.description || args.subagent_type || `subagent-${i + 1}`).slice(0, 48);
    const k = norm(label || t.id || `tool-${i}`);
    if (byKey.has(k)) continue;
    byKey.set(k, {
      key: String(t.id || k || `sub-${i}`),
      handle: k,
      name: label,
      status: t.status === 'running' ? 'running' : (t.isError ? 'error' : 'done'),
      role: 'worker',
      jobRole: args.subagent_type || args.role || 'coder',
      model: args.model || null,
      ms: t.ms || null,
      progress: {
        tools: 1,
        chars: String(t.result || '').length,
        last: String(args.prompt || args.brief || t.result || '').slice(0, 240),
        log: [],
      },
    });
  }

  return [...byKey.values()];
}
