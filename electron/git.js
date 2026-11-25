'use strict';
const { exec } = require('child_process');
const path = require('path');

// Repo-aware git introspection — the "Example Code" surface. Runs git commands in a
// given cwd and returns a structured snapshot: root, branch, status, ahead/behind,
// recent commits, and a short file tree. All failures degrade to `{ isRepo: false }`
// rather than throwing, so a non-repo directory is a clean no-op.

function run(cmd, cwd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: '/bin/zsh' }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').replace(/\n+$/, ''));
    });
  });
}

// Locate the repo root via `git rev-parse --show-toplevel`.
async function findRoot(cwd) {
  const root = await run('git rev-parse --show-toplevel', cwd);
  return root || null;
}

async function gitInfo(cwd) {
  cwd = cwd || process.cwd();
  const root = await findRoot(cwd);
  if (!root) return { isRepo: false, cwd };

  const [branch, status, log, remote, aheadBehind] = await Promise.all([
    run('git rev-parse --abbrev-ref HEAD', root),
    run('git status --porcelain=v1', root),
    run('git log --oneline -8 --decorate', root),
    run('git remote get-url origin', root),
    run('git rev-list --left-right --count @{u}...HEAD 2>/dev/null || true', root),
  ]);

  // Parse porcelain status into counts.
  const lines = (status || '').split('\n').filter(Boolean);
  let modified = 0, added = 0, deleted = 0, untracked = 0;
  for (const ln of lines) {
    const xy = ln.slice(0, 2);
    const x = xy[0], y = xy[1];
    if (x === '?' && y === '?') untracked++;
    else {
      if (x === 'M' || x === 'A' || x === 'D' || x === 'R') { if (x === 'A') added++; else if (x === 'D') deleted++; else modified++; }
      if (y === 'M' || y === 'A' || y === 'D' || y === 'R') { if (y === 'A') added++; else if (y === 'D') deleted++; else modified++; }
    }
  }

  // Parse ahead/behind ("<behind>\t<ahead>").
  let behind = 0, ahead = 0;
  const ab = (aheadBehind || '').trim();
  if (ab && ab.includes('\t')) {
    const [b, a] = ab.split('\t').map((n) => parseInt(n, 10) || 0);
    behind = b; ahead = a;
  }

  const commits = (log || '').split('\n').filter(Boolean).map((l) => {
    const m = /^(\S+)\s+(.*)$/.exec(l);
    return m ? { hash: m[1], message: m[2] } : { hash: '', message: l };
  });

  return {
    isRepo: true,
    cwd,
    root,
    branch: branch || '(detached)',
    remote: remote || '',
    statusLines: lines.slice(0, 200),
    counts: { modified, added, deleted, untracked },
    behind,
    ahead,
    commits,
  };
}

// Minimal unified diff (old → new) for the Code-mode diff viewer.
function unifiedDiff(oldText, newText, label = 'file', context = 3) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  if (oldText === newText) return null;

  // Simple LCS-based line diff (O(n*m) — fine for typical edit hunks).
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = []; // {type:'='|'-'|'+', text}
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ type: '=', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ type: '-', text: a[i] }); i++; }
    else { ops.push({ type: '+', text: b[j] }); j++; }
  }
  while (i < n) { ops.push({ type: '-', text: a[i++] }); }
  while (j < m) { ops.push({ type: '+', text: b[j++] }); }

  // Build hunks with context.
  const out = [];
  let lineNo = 0;
  const equalRuns = [];
  let cur = { type: '=', items: [] };
  const push = (op) => {
    if (cur.type === op.type) cur.items.push(op.text);
    else { if (cur.items.length) equalRuns.push(cur); cur = { type: op.type, items: [op.text] }; }
  };
  for (const op of ops) push(op);
  if (cur.items.length) equalRuns.push(cur);

  // Mark change indices.
  const changeIdx = new Set();
  let idx = 0;
  for (const op of ops) { if (op.type !== '=') changeIdx.add(idx); idx++; }

  const rendered = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const inChange = changeIdx.has(k);
    // include '=' lines only if within context of a change
    let include = op.type !== '=';
    if (op.type === '=' && !include) {
      for (let d = 1; d <= context; d++) {
        if (changeIdx.has(k - d) || changeIdx.has(k + d)) { include = true; break; }
      }
    }
    if (include) {
      if (op.type === '=' && rendered.length && rendered[rendered.length - 1].type === 'context') {
        rendered.push({ type: 'context', text: ' ' + op.text });
      } else if (op.type === '=') {
        rendered.push({ type: 'context', text: ' ' + op.text });
      } else {
        rendered.push({ type: op.type === '-' ? 'del' : 'add', text: (op.type === '-' ? '-' : '+') + op.text });
      }
    }
  }

  return {
    label,
    hunks: rendered.length ? rendered : [{ type: 'context', text: '(no textual change)' }],
    added: ops.filter((o) => o.type === '+').length,
    removed: ops.filter((o) => o.type === '-').length,
  };
}

module.exports = { gitInfo, findRoot, unifiedDiff };
