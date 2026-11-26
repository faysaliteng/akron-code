'use strict';
const { exec, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Repo-aware git introspection — the "Claude Code" surface. Runs git commands in a
// given cwd and returns a structured snapshot: root, branch, status, ahead/behind,
// recent commits, and a short file tree. All failures degrade to `{ isRepo: false }`
// rather than throwing, so a non-repo directory is a clean no-op.

function run(cmd, cwd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const sh = process.platform === 'win32' ? true : require('./paths').defaultPosixShell();
    exec(cmd, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: sh, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout || '').replace(/\r?\n+$/, ''));
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

function parseGitDiffOutput(diffText, root) {
  const files = [];
  if (!diffText) return files;
  const rawLines = String(diffText).split('\n');
  let cur = null;
  let oldLn = 1;
  let newLn = 1;
  let inHunk = false;

  const flush = () => {
    if (cur) {
      files.push(cur);
      cur = null;
    }
    inHunk = false;
  };

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (line.startsWith('diff --git ')) {
      flush();
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const rel = m ? m[2] : line.slice(11).trim();
      cur = {
        path: path.join(root, rel),
        relPath: rel,
        status: 'modified',
        added: 0,
        removed: 0,
        lines: [],
        binary: false,
      };
      continue;
    }
    if (!cur) continue;
    if (!inHunk) {
      if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
      if (line.startsWith('deleted file mode')) { cur.status = 'deleted'; continue; }
      if (line.startsWith('rename to ')) {
        const rel = line.slice(10).trim();
        cur.relPath = rel;
        cur.path = path.join(root, rel);
        continue;
      }
      if (line.startsWith('Binary files ')) { cur.binary = true; continue; }
      if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') || line.startsWith('similarity ') || line.startsWith('rename from ')) continue;
    }
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hm) {
      oldLn = parseInt(hm[1], 10) || 1;
      newLn = parseInt(hm[2], 10) || 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || cur.binary) continue;
    if (line === '\\ No newline at end of file') continue;
    const ch = line[0];
    const body = line.slice(1);
    if (ch === '+') {
      cur.lines.push({ type: 'add', oldLine: null, newLine: newLn++, text: body });
      cur.added++;
    } else if (ch === '-') {
      cur.lines.push({ type: 'del', oldLine: oldLn++, newLine: null, text: body });
      cur.removed++;
    } else if (ch === ' ') {
      cur.lines.push({ type: 'ctx', oldLine: oldLn++, newLine: newLn++, text: body });
    }
  }
  flush();
  return files.filter((f) => !f.binary && (f.added > 0 || f.removed > 0 || f.lines.length > 0));
}

// Structured working-tree diff (modified + untracked files) with full context
// so CodeReviewPane can collapse/expand unchanged regions and search inside them.
function gitDiffFiles(cwd) {
  cwd = cwd || process.cwd();
  let root = '';
  try {
    root = String(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }) || '').trim();
  } catch {
    return [];
  }
  if (!root) return [];

  let diffOut = '';
  try {
    diffOut = execFileSync('git', ['diff', 'HEAD', '--no-color', '--unified=99999'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 6000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    try {
      diffOut = execFileSync('git', ['diff', '--cached', '--no-color', '--unified=99999'], {
        cwd: root,
        encoding: 'utf8',
        timeout: 6000,
        maxBuffer: 8 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    } catch {
      diffOut = '';
    }
  }

  const files = parseGitDiffOutput(diffOut, root);
  const seen = new Set(files.map((f) => f.relPath));

  // Include untracked non-binary text files up to a safe cap.
  try {
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const rels = String(untracked || '').split('\n').filter(Boolean).slice(0, 30);
    for (const rel of rels) {
      if (seen.has(rel)) continue;
      if (/^(?:node_modules|dist|release|\.git)\//.test(rel)) continue;
      const full = path.join(root, rel);
      try {
        const st = fs.statSync(full);
        if (!st.isFile() || st.size > 200 * 1024) continue;
        const buf = fs.readFileSync(full);
        const probe = buf.subarray(0, Math.min(buf.length, 4096));
        if (probe.includes(0)) continue; // binary
        const textLines = buf.toString('utf8').split('\n');
        files.push({
          path: full,
          relPath: rel,
          status: 'added',
          added: textLines.length,
          removed: 0,
          lines: textLines.map((txt, idx) => ({ type: 'add', oldLine: null, newLine: idx + 1, text: txt })),
        });
      } catch (_) {}
    }
  } catch (_) {}

  return files;
}

// Git Worktrees (OpenCode-style parallel branch isolation).
async function listWorktrees(cwd) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { isRepo: false, root: null, worktrees: [] };
  const raw = await run('git worktree list --porcelain', root);
  if (!raw) return { isRepo: true, root, worktrees: [{ path: root, branch: await run('git rev-parse --abbrev-ref HEAD', root) || '', main: true }] };
  const blocks = raw.split(/\r?\n\r?\n/).filter(Boolean);
  const worktrees = [];
  for (let i = 0; i < blocks.length; i++) {
    const lines = blocks[i].split(/\r?\n/).filter(Boolean);
    const entry = { path: '', head: '', branch: '', bare: false, detached: false, main: i === 0 };
    for (const ln of lines) {
      if (ln.startsWith('worktree ')) entry.path = ln.slice(9).trim();
      else if (ln.startsWith('HEAD ')) entry.head = ln.slice(5).trim().slice(0, 8);
      else if (ln.startsWith('branch ')) entry.branch = ln.slice(7).trim().replace(/^refs\/heads\//, '');
      else if (ln === 'bare') entry.bare = true;
      else if (ln === 'detached') entry.detached = true;
    }
    if (entry.path) worktrees.push(entry);
  }
  return { isRepo: true, root, worktrees };
}

async function addWorktree(cwd, branch, targetDir) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not inside a git repository.' };
  const safeBranch = String(branch || '').trim().replace(/[^\w./-]+/g, '-');
  if (!safeBranch) return { ok: false, error: 'Branch name is required.' };
  const dest = targetDir && String(targetDir).trim()
    ? path.resolve(root, String(targetDir).trim())
    : path.join(path.dirname(root), `${path.basename(root)}-${safeBranch.replace(/[\\/]+/g, '-')}`);
  try {
    execFileSync('git', ['worktree', 'add', '-b', safeBranch, dest], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, path: dest, branch: safeBranch, ...(await listWorktrees(root)) };
  } catch (e) {
    // Branch might already exist — try attaching existing branch without -b
    try {
      execFileSync('git', ['worktree', 'add', dest, safeBranch], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, path: dest, branch: safeBranch, ...(await listWorktrees(root)) };
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.stderr) || (e && e.stderr) || (e2 && e2.message) || e) };
    }
  }
}

async function removeWorktree(cwd, targetDir) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not inside a git repository.' };
  if (!targetDir) return { ok: false, error: 'Worktree path required.' };
  try {
    execFileSync('git', ['worktree', 'remove', '--force', String(targetDir)], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, ...(await listWorktrees(root)) };
  } catch (e) {
    return { ok: false, error: String((e && e.stderr) || (e && e.message) || e) };
  }
}

async function gitStatusDetailed(cwd) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { isRepo: false, root: null, branch: '', ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [] };
  let raw = '';
  try {
    raw = execFileSync('git', ['status', '--porcelain=v1', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (_) { raw = ''; }
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const tokens = raw ? raw.split('\0').filter(Boolean) : [];
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    let relPath = entry.slice(3);
    if ((x === 'R' || x === 'C') && tokens[i + 1]) {
      relPath = tokens[i + 1];
      i++;
    }
    const full = path.join(root, relPath);
    if (x === '?' && y === '?') {
      untracked.push({ relPath, path: full, status: 'U' });
      continue;
    }
    if (x !== ' ') staged.push({ relPath, path: full, status: x });
    if (y !== ' ') unstaged.push({ relPath, path: full, status: y });
  }
  const info = await gitInfo(root);
  return {
    isRepo: true,
    root,
    branch: info.branch || 'HEAD',
    ahead: info.ahead || 0,
    behind: info.behind || 0,
    staged,
    unstaged,
    untracked,
  };
}

async function stageFiles(cwd, relPaths) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not a git repository' };
  const files = Array.isArray(relPaths) && relPaths.length ? relPaths.map(String) : ['.'];
  try {
    execFileSync('git', ['add', '--', ...files], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, status: await gitStatusDetailed(root) };
  } catch (e) {
    return { ok: false, error: String((e && e.stderr) || e.message || e) };
  }
}

async function unstageFiles(cwd, relPaths) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not a git repository' };
  const files = Array.isArray(relPaths) && relPaths.length ? relPaths.map(String) : ['.'];
  try {
    execFileSync('git', ['reset', 'HEAD', '--', ...files], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, status: await gitStatusDetailed(root) };
  } catch (e) {
    try {
      execFileSync('git', ['rm', '--cached', '--', ...files], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, status: await gitStatusDetailed(root) };
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.stderr) || e.message || e) };
    }
  }
}

async function stagePatch(cwd, patchText, reverse = false) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not a git repository' };
  try {
    const args = ['apply', '--cached'];
    if (reverse) args.push('--reverse');
    execFileSync('git', args, { cwd: root, input: String(patchText || ''), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, status: await gitStatusDetailed(root) };
  } catch (e) {
    return { ok: false, error: String((e && e.stderr) || e.message || e) };
  }
}

async function discardFiles(cwd, relPaths) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not a git repository' };
  const files = Array.isArray(relPaths) ? relPaths.map(String).filter(Boolean) : [];
  if (!files.length) return { ok: false, error: 'No files specified' };
  const errors = [];
  for (const rel of files) {
    try {
      execFileSync('git', ['checkout', '--', rel], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) {
      try {
        const full = path.resolve(root, rel);
        if (full.startsWith(root) && fs.existsSync(full)) fs.rmSync(full, { recursive: true, force: true });
      } catch (e2) {
        errors.push(`${rel}: ${e2.message}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, status: await gitStatusDetailed(root) };
}

async function commitChanges(cwd, message) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not a git repository' };
  const msg = String(message || '').trim();
  if (!msg) return { ok: false, error: 'Commit message required' };
  try {
    execFileSync('git', ['commit', '-m', msg], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, status: await gitStatusDetailed(root) };
  } catch (e) {
    return { ok: false, error: String((e && e.stderr) || e.message || e) };
  }
}

async function listBranches(cwd) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, branches: [], current: '' };
  try {
    const out = execFileSync('git', ['branch', '--format=%(HEAD)|%(refname:short)'], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const branches = [];
    let current = '';
    for (const ln of out.split(/\r?\n/)) {
      if (!ln.trim()) continue;
      const [head, name] = ln.split('|');
      if (head && head.trim() === '*') current = name;
      branches.push({ name, current: head && head.trim() === '*' });
    }
    return { ok: true, branches, current };
  } catch (e) {
    return { ok: false, error: e.message || String(e), branches: [], current: '' };
  }
}

async function checkoutBranch(cwd, branch, createNew = false) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, error: 'Not a git repository' };
  const name = String(branch || '').trim();
  if (!name) return { ok: false, error: 'Branch name required' };
  try {
    const args = createNew ? ['checkout', '-b', name] : ['checkout', name];
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, ...(await listBranches(root)), status: await gitStatusDetailed(root) };
  } catch (e) {
    return { ok: false, error: String((e && e.stderr) || e.message || e) };
  }
}

async function fileAtHead(cwd, filePath) {
  const root = await findRoot(cwd || process.cwd());
  if (!root) return { ok: false, content: '' };
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath);
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    const content = execFileSync('git', ['show', `HEAD:${rel}`], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, content, existsAtHead: true, relPath: rel };
  } catch (_) {
    return { ok: true, content: '', existsAtHead: false };
  }
}

module.exports = {
  gitInfo,
  findRoot,
  unifiedDiff,
  gitDiffFiles,
  parseGitDiffOutput,
  listWorktrees,
  addWorktree,
  removeWorktree,
  gitStatusDetailed,
  stageFiles,
  unstageFiles,
  stagePatch,
  discardFiles,
  commitChanges,
  listBranches,
  checkoutBranch,
  fileAtHead,
};
