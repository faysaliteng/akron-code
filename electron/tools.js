'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec, execFileSync, spawn } = require('child_process');
const store = require('./store');
const visualize = require('./visualize');
const computer = require('./computer');
const chrome = require('./chrome');
const cowork = require('./cowork');
const swarm = require('./swarm');
const browser = require('./browser');
const pluginsDir = require('./plugins');
const scheduler = require('./scheduler');
const parity = require('./parity');
const bg = require('./bg');
const replSession = require('./repl');
const { expandPath } = require('./paths');
const sandbox = require('./sandbox');
const customtools = require('./customtools');
const editGuard = require('./ide/edit-guard');
const applyPatchMod = require('./apply-patch');
const codebaseIndex = require('./ide/codebase-index');
const codemode = require('./codemode');
const skillLearner = require('./skill-learner');
const osSandbox = require('./os-sandbox');
const untrusted = require('./untrusted');
const auditLedger = require('./audit-ledger');
const sideEffectsGuard = auditLedger.createIdempotencyGuard();

const MAX_OUTPUT = 120000; // chars

function clampReplTimeout(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 30000;
  return Math.min(Math.max(n, 1000), 600000);
}

function truncate(s) {
  if (!s) return s;
  s = String(s);
  if (s.length > MAX_OUTPUT) return s.slice(0, MAX_OUTPUT) + '\n…[truncated]';
  return s;
}

// ---------- Bash helpers ----------
const BASH_DEFAULT_TIMEOUT = 120000;
const BASH_MAX_TIMEOUT = 600000;
const BASH_OUTPUT_LIMIT = 30000; // chars returned to the model (head + tail)

function clampBashTimeout(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return BASH_DEFAULT_TIMEOUT;
  // The schema says milliseconds, but free models often send seconds
  // ("timeout": 60). Anything under 1000 is read as seconds.
  const ms = n < 1000 ? n * 1000 : n;
  return Math.min(Math.max(Math.round(ms), 1000), BASH_MAX_TIMEOUT);
}

// Keep the first half and the last half of a stream without ever holding more
// than ~limit chars in memory. The tail matters most: that's where compilers
// and test runners print the actual error.
function boundedOutput(limit) {
  const half = Math.floor(limit / 2);
  let head = '';
  let tail = '';
  let dropped = 0;
  return {
    push(d) {
      let s = String(d);
      if (head.length < half) {
        const take = Math.min(half - head.length, s.length);
        head += s.slice(0, take);
        s = s.slice(take);
      }
      if (!s) return;
      tail += s;
      if (tail.length > half) {
        dropped += tail.length - half;
        tail = tail.slice(tail.length - half);
      }
    },
    text() {
      if (!dropped) return head + tail;
      return head + `\n\n…[${dropped} characters of output truncated]…\n\n` + tail;
    },
  };
}

// ---------- Read helpers ----------
const READ_DEFAULT_LINES = 2000;
const READ_MAX_LINE = 2000;      // chars per line
const READ_MAX_CHARS = 100000;   // chars per Read call
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|tiff?|heic|avif)$/i;
const RASTER_IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function quickSyntaxDiagnostic(fp) {
  try {
    const ext = path.extname(fp).toLowerCase();
    if (!['.json', '.cjs', '.mjs', '.js', '.py'].includes(ext)) return '';
    if (ext === '.json') {
      JSON.parse(fs.readFileSync(fp, 'utf8'));
      return '';
    }
    if (ext === '.js') {
      const sample = fs.readFileSync(fp, 'utf8').slice(0, 8000);
      const hasJsx = /<[A-Za-z][A-Za-z0-9.]*(\s|>|\/)/.test(sample)
        && (/from\s+['"]react['"]/.test(sample) || /require\(\s*['"]react['"]\s*\)/.test(sample) || /export\s+default\s+function/.test(sample) || /React\./.test(sample));
      if (hasJsx) return '';
    }
    if (ext === '.cjs' || ext === '.js') {
      const src = fs.readFileSync(fp, 'utf8');
      if (/^\s*(?:import\s+(?:[\w*{]|['"])|export\s+(?:default|const|let|var|async|function|class|\{|\*))/m.test(src)) {
        return '';
      }
      const vm = require('vm');
      new vm.Script(src.replace(/^#!.*\r?\n/, '\n'), { filename: fp });
      return '';
    }
    if (ext === '.mjs') {
      return '';
    }
    if (ext === '.py') {
      execFileSync('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1],"rb").read(), sys.argv[1])', fp], { timeout: 2000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return '';
    }
    return '';
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ETIMEDOUT')) return '';
    const rawErr = String((e && (e.stderr || e.message)) || e || '').trim();
    const lines = rawErr.split('\n').filter((l) => !/^Node\.js v\d+/i.test(l.trim())).join('\n').trim();
    const errText = (lines || rawErr).slice(0, 400);
    if (!errText) return '';
    return `\n\n[SYNTAX WARNING in ${path.basename(fp)}]\n${errText}\nFix this syntax error immediately with Edit before running commands or finishing.`;
  }
}

function isBinaryBuffer(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

// Jupyter notebooks: show cells + text outputs instead of raw JSON.
function renderNotebook(raw) {
  let nb;
  try { nb = JSON.parse(raw); } catch (_) { return null; }
  if (!nb || !Array.isArray(nb.cells)) return null;
  const src = (v) => (Array.isArray(v) ? v.join('') : String(v || ''));
  return nb.cells.map((c, i) => {
    const id = c.id || String(i);
    let s = `<cell id="${id}" type="${c.cell_type || 'code'}">\n${src(c.source)}\n</cell>`;
    const outs = (c.outputs || []).map((o) => {
      if (o.text) return src(o.text);
      if (o.data && o.data['text/plain']) return src(o.data['text/plain']);
      if (o.ename) return `${o.ename}: ${o.evalue || ''}`;
      if (o.data) return `[${Object.keys(o.data).join(', ')} output]`;
      return '';
    }).filter(Boolean);
    if (outs.length) s += `\n<output>\n${outs.join('\n')}\n</output>`;
    return s;
  }).join('\n\n');
}

// `cat -n` style: 6-wide right-aligned line number, a tab, the line.
function formatNumbered(raw, fp, offset, limit, emptyMsg) {
  const text = String(raw == null ? '' : raw);
  if (!text) return emptyMsg;
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, parseInt(offset, 10) || 1);
  const lim = limit == null || limit === ''
    ? READ_DEFAULT_LINES
    : Math.max(1, Math.min(parseInt(limit, 10) || READ_DEFAULT_LINES, 50000));
  if (start > total) return `(offset ${start} is past the end of ${fp} — the file has ${total} lines)`;
  const end = Math.min(total, start - 1 + lim);
  const out = [];
  let size = 0;
  let last = start - 1;
  let capped = false;
  for (let i = start; i <= end; i++) {
    let l = lines[i - 1];
    if (l.endsWith('\r')) l = l.slice(0, -1);
    if (l.length > READ_MAX_LINE) l = l.slice(0, READ_MAX_LINE) + '… [line truncated]';
    const row = String(i).padStart(6) + '\t' + l;
    if (out.length && size + row.length + 1 > READ_MAX_CHARS) { capped = true; break; }
    out.push(row);
    size += row.length + 1;
    last = i;
  }
  let s = out.join('\n');
  if (capped) {
    s += `\n…[output capped at ${READ_MAX_CHARS} characters — showing lines ${start}–${last} of ${total}; call Read with offset ${last + 1} to continue]`;
  } else if (last < total) {
    s += `\n…[${total - last} more lines — call Read with offset ${last + 1} to continue]`;
  }
  return s;
}

// ---------- Edit helpers ----------
// Claude Code semantics: old_string must match exactly once unless
// replace_all is set. A whitespace-tolerant fallback is allowed only when it
// identifies exactly ONE region (and that region isn't wildly longer than
// old_string). Returns { raw, count, fuzzy } or { error }.
function countOccurrences(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = hay.indexOf(needle);
  while (i !== -1) { n++; i = hay.indexOf(needle, i + needle.length); }
  return n;
}

function fuzzyMatches(raw, oldStr) {
  const target = oldStr.replace(/\s+/g, ' ').trim();
  if (!target) return [];
  let normBuf = '';
  const map = [];
  let prevSpace = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (!prevSpace && normBuf.length) { map[normBuf.length] = i; normBuf += ' '; }
      prevSpace = true;
    } else {
      map[normBuf.length] = i;
      normBuf += ch;
      prevSpace = false;
    }
  }
  const spans = [];
  let at = normBuf.indexOf(target);
  while (at !== -1) {
    const start = map[at];
    const lastIdx = map[at + target.length - 1];
    spans.push({ start, end: lastIdx == null ? raw.length : lastIdx + 1 });
    at = normBuf.indexOf(target, at + 1);
  }
  return spans;
}

function applyEdit(raw, oldString, newString, replaceAll) {
  if (typeof oldString !== 'string' || oldString === '') return { error: 'empty' };
  const ns0 = newString == null ? '' : String(newString);
  if (oldString === ns0) return { error: 'same' };
  // Keep the file's line endings: a CRLF file gets CRLF in both strings.
  const crlf = raw.includes('\r\n');
  const toFile = (s) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
  let os = toFile(oldString);
  let ns = toFile(ns0);
  let count = countOccurrences(raw, os);
  if (!count && os !== oldString) { // mixed endings: try the string verbatim
    const c2 = countOccurrences(raw, oldString);
    if (c2) { os = oldString; ns = ns0; count = c2; }
  }
  if (count > 1 && !replaceAll) return { error: 'multiple', count };
  if (count >= 1) {
    if (replaceAll) return { raw: raw.split(os).join(ns), count, fuzzy: false };
    const idx = raw.indexOf(os);
    return { raw: raw.slice(0, idx) + ns + raw.slice(idx + os.length), count: 1, fuzzy: false };
  }
  if (replaceAll) return { error: 'notfound' };
  const spans = fuzzyMatches(raw, oldString);
  if (spans.length > 1) return { error: 'multiple', count: spans.length, fuzzy: true };
  if (spans.length === 1) {
    const { start, end } = spans[0];
    const nlSpan = (raw.slice(start, end).match(/\n/g) || []).length;
    const nlOld = (oldString.match(/\n/g) || []).length;
    // Collapsing whitespace must not stretch one line of old_string over a
    // big chunk of unrelated code.
    if (nlSpan <= nlOld * 2 + 2) {
      return { raw: raw.slice(0, start) + ns + raw.slice(end), count: 1, fuzzy: true };
    }
  }
  return { error: 'notfound' };
}

function editErrorText(r, fp, raw, label) {
  const where = label ? `${label}: ` : '';
  if (r.error === 'empty') return `Error: ${where}old_string must be a non-empty string copied exactly from the file (use Read first).`;
  if (r.error === 'same') return `Error: ${where}old_string and new_string are identical — there is nothing to change.`;
  if (r.error === 'multiple') {
    return `Error: ${where}old_string matches ${r.count} times in ${fp}${r.fuzzy ? ' (ignoring whitespace)' : ''}; add surrounding context to make it unique, or set replace_all:true to replace every occurrence. The file is unchanged.`;
  }
  return `Error: ${where}old_string not found in ${fp}. The file is unchanged. Read the file first and copy old_string exactly (including indentation).\n\n${fileHead(fp, raw)}\n\nRe-copy old_string exactly from the lines above (or use Write to replace the whole file).`;
}

// ---------- Glob helpers ----------
const GLOB_MAX_DEPTH = 20;
const GLOB_MAX_RESULTS = 1000;
const GLOB_MAX_VISITS = 200000;
const GLOB_SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn']);

// `{a,b}` → ['a','b'] (nested braces supported).
function expandBraces(p) {
  const s = String(p);
  let depth = 0;
  let open = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') { i++; continue; }
    if (c === '{') { if (depth === 0) open = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        const body = s.slice(open + 1, i);
        const parts = [];
        let d = 0; let last = 0;
        for (let j = 0; j < body.length; j++) {
          if (body[j] === '\\') { j++; continue; }
          if (body[j] === '{') d++;
          else if (body[j] === '}') d--;
          else if (body[j] === ',' && d === 0) { parts.push(body.slice(last, j)); last = j + 1; }
        }
        parts.push(body.slice(last));
        if (parts.length < 2) continue; // `{x}` is literal
        const pre = s.slice(0, open);
        const post = s.slice(i + 1);
        const out = [];
        for (const part of parts) for (const e of expandBraces(pre + part + post)) out.push(e);
        return out;
      }
    }
  }
  return [s];
}

function globToRegExp(pattern) {
  const p = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atSegStart = i === 0 || p[i - 1] === '/';
        if (atSegStart && p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue; }
        if (atSegStart && i + 2 === p.length) { re += '.*'; i += 1; continue; }
        re += '[^/]*'; i += 1; continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const close = p.indexOf(']', i + 2);
      if (close === -1) { re += '\\['; continue; }
      let body = p.slice(i + 1, close);
      if (body[0] === '!') body = '^' + body.slice(1);
      re += '[' + body.replace(/\\/g, '\\\\') + ']';
      i = close;
    } else {
      re += c.replace(/[.+^${}()|[\]\\/]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

function resolvePath(p, cwd) {
  if (!p) throw new Error('path required');
  const expanded = expandPath(p);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return path.resolve(expandPath(cwd) || process.cwd(), expanded);
}

// Expand a directory string the way the shell would (`~`, $HOME, $VAR).
function resolveDir(d) {
  if (!d) return process.cwd();
  return path.resolve(expandPath(d));
}

// ---------- slash commands registry ----------
const SLASH_COMMANDS = {
  help: 'Show available slash commands and capabilities.',
  clear: 'Clear the current conversation history.',
  compact: 'Summarize the conversation to save context and continue in a fresh window.',
  model: 'Show or switch the active model.',
  review: 'Review the current working tree / recent changes for bugs and issues.',
  memory: 'Show the contents of long-term memory.',
  reset: 'Reset Akron Code to a clean state (clear memory + conversations).',
  status: 'Show provider, model, and tool configuration status.',
};

// ---------- executors ----------
const executors = {
  async bash({ command, cwd, timeout, description, run_in_background, dangerouslyDisableSandbox }, execCtx) {
    if (!command) return 'Error: command required';
    // Example's Bash runs either to completion or detached. A detached job must
    // outlive the tool call and be addressable by TaskOutput / KillShell.
    if (run_in_background) {
      const job = bg.startShell({ command, cwd: resolveDir(cwd) });
      const label = description ? ` (${description})` : '';
      return `Started background shell ${job.id}${label}.\nPoll: TaskOutput {"task_id":"${job.id}","block":true,"timeout":30000}\nStop:  KillShell {"shell_id":"${job.id}"}`;
    }
    if (dangerouslyDisableSandbox) { /* accepted: explicit permission-gated bypass */ }
    else {
      const canonical = osSandbox.checkCanonicalCommand(command, {
        profile: 'workspace-write',
        protectCredentials: !!sandbox.load().sandbox.enabled,
      });
      if (!canonical.ok) return `Sandbox blocked: ${canonical.reason}`;
    }
    // Claude Code semantics: `timeout` is in MILLISECONDS (default 2 min, max 10 min).
    const t = clampBashTimeout(timeout);
    const dir = resolveDir(cwd);
    const abortSignal = execCtx && execCtx.signal;
    if (abortSignal && abortSignal.aborted) return '[aborted before start]';
    return new Promise((resolve) => {
      // `-l` login shell → inherits ~/.zprofile / ~/.zshenv so brew, npm, pip,
      // and other toolchain binaries are on PATH exactly as they are in Terminal.
      // (spawn /bin/zsh with `-l -c` rather than exec `shell:'/bin/zsh -l'`,
      //  which Node would treat as a single executable name and ENOENT on.)
      const buf = boundedOutput(BASH_OUTPUT_LIMIT);
      let settled = false;
      let timedOut = false;
      let aborted = false;
      let wrapped;
      try {
        wrapped = sandbox.wrapShell(command, { dangerouslyDisableSandbox });
      } catch (e) {
        return resolve(`Error: ${e.message}`);
      }
      let child;
      try {
        // detached → on POSIX the command gets its own process group so timeout/abort can
        // kill the whole tree. On Windows use windowsHide + taskkill /T /F.
        child = spawn(wrapped.file, wrapped.args, {
          cwd: dir,
          detached: process.platform !== 'win32',
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        return resolve(`Error (${e.code || 'spawn'}): ${e.message}`);
      }
      const note = wrapped.note ? `[${wrapped.note}]\n` : '';
      const killGroup = () => {
        if (process.platform === 'win32' && child && child.pid) {
          try {
            spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
            return;
          } catch (_) {}
        }
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {
          try { child.kill('SIGKILL'); } catch (__) { /* already gone */ }
        }
      };
      let timer = null;
      let graceTimer = null;
      const onAbort = () => { if (settled) return; aborted = true; killGroup(); armGrace(); };
      const cleanup = () => {
        clearTimeout(timer); clearTimeout(graceTimer);
        if (abortSignal) { try { abortSignal.removeEventListener('abort', onAbort); } catch (_) {} }
      };
      const finish = (code, sig, spawnErr) => {
        if (settled) return; settled = true;
        cleanup();
        let out = buf.text();
        if (spawnErr && !out) out = `Error (${spawnErr.code || 'spawn'}): ${spawnErr.message}`;
        out = note + out;
        const tail = [];
        if (timedOut) tail.push(`[timed out after ${Math.round(t / 1000)}s — process killed]`);
        else if (aborted) tail.push('[aborted — process killed]');
        else if (sig) tail.push(`[killed by ${sig}]`);
        else if (code != null && code !== 0) tail.push(`[exit code ${code}]`);
        if (!out.trim() && !tail.length) out = '(no output)';
        resolve(out + (tail.length ? (out && !out.endsWith('\n') ? '\n' : '') + tail.join('\n') : ''));
        try { child.stdout.destroy(); child.stderr.destroy(); } catch (_) {}
      };
      // After a kill, `close` can stall if a grandchild escaped the group and
      // still holds the pipes; never let that hang the tool call.
      const armGrace = () => {
        if (graceTimer) return;
        graceTimer = setTimeout(() => finish(null, 'SIGKILL'), 2000);
      };
      timer = setTimeout(() => { timedOut = true; killGroup(); armGrace(); }, t);
      if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
      let lastOutStreamAt = 0;
      const emitBashStream = () => {
        if (!execCtx || typeof execCtx.emit !== 'function') return;
        const now = Date.now();
        if (now - lastOutStreamAt < 150) return;
        lastOutStreamAt = now;
        const txt = buf.text();
        const lines = txt ? txt.split('\n').length : 0;
        const target = String(description || command || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        try {
          execCtx.emit({
            type: 'toolStream',
            id: execCtx.currentToolId || '',
            name: 'Bash',
            bytes: Buffer.byteLength(txt, 'utf8'),
            lines,
            target,
            preview: txt.slice(-600),
            phase: 'stdout',
          });
        } catch (_) {}
      };
      child.stdout.on('data', (d) => { buf.push(d); emitBashStream(); });
      child.stderr.on('data', (d) => { buf.push(d); emitBashStream(); });
      child.on('error', (e) => finish(null, null, e));
      // `exit` fires when zsh is done; `close` waits for every holder of the
      // pipes. A backgrounded `server &` keeps them open forever, so settle a
      // moment after exit even if close never comes.
      child.on('exit', (code, sig) => {
        setTimeout(() => finish(code, timedOut || aborted ? null : sig), 300);
      });
      child.on('close', (code, sig) => finish(code, timedOut || aborted ? null : sig));
    });
  },

  async read_file({ path: p, file_path: _fp, cwd, offset, limit, pages, _readMtimes, _allowRichRead }) {
    const target = p || _fp;
    if (!target) return 'Error: Read requires a "path" argument (alias: file_path).';
    const fp = resolvePath(target, cwd);
    const rd = sandbox.isReadAllowed(fp);
    if (rd !== true) return 'Error: ' + rd.reason;
    // PDFs: extract text (optionally a page window) instead of mojibake.
    if (/\.pdf$/i.test(fp)) {
      let range = '';
      if (pages) {
        const a = String(pages).split('-');
        const first = Math.max(1, parseInt(a[0], 10) || 1);
        const last = Math.max(first, parseInt(a[1], 10) || first);
        range = `-f ${first} -l ${last} `;
      }
      const out = await new Promise((resolve) => {
        exec(`pdftotext ${range}-layout ${JSON.stringify(fp)} -`, { maxBuffer: 16 * 1024 * 1024 }, (e, so, se) => resolve(e ? null : so));
      });
      if (out != null) {
        if (_readMtimes instanceof Map) { try { _readMtimes.set(fp, Math.floor(fs.statSync(fp).mtimeMs)); } catch (_) {} }
        return formatNumbered(out, fp, offset, limit, pages ? '(empty PDF page range)' : '(PDF has no extractable text)');
      }
      if (pages) return `Error reading PDF: could not extract pages ${pages} (is pdftotext installed?)`;
      // fall through: report as a binary file below
    }
    try {
      let st;
      try { st = fs.statSync(fp); } catch (e) {
        return `Error reading file: ${fp} does not exist (${e.code || e.message}).`;
      }
      if (st.isDirectory()) return `Error: ${fp} is a directory, not a file. Use Glob or Bash \`ls\` to list it.`;
      if (st.isFIFO && st.isFIFO()) {
        const fifoRes = await require('./loop-guard').readFifoNonBlocking(fp, { timeoutMs: 20000 });
        return fifoRes.ok
          ? formatNumbered(fifoRes.content, fp, offset, limit, '(empty FIFO)')
          : fifoRes.error;
      }
      editGuard.recordFileRead(_readMtimes, fp, null, st);
      if (IMAGE_EXT.test(fp)) {
        const ext = path.extname(fp).toLowerCase();
        const mime = RASTER_IMAGE_MIME[ext];
        if (_allowRichRead && mime && st.size <= 5 * 1024 * 1024) {
          const imgBuf = fs.readFileSync(fp);
          return {
            content: `Image file: ${fp} (${st.size} bytes, ${ext.slice(1)}) — loaded for visual inspection.`,
            imageDataUrl: `data:${mime};base64,${imgBuf.toString('base64')}`,
          };
        }
        return `Image file: ${fp} (${st.size} bytes, ${ext.slice(1)}). Image contents cannot be shown as text.`;
      }
      const buf = fs.readFileSync(fp);
      editGuard.recordFileRead(_readMtimes, fp, buf, st);
      if (isBinaryBuffer(buf)) {
        return `Binary file: ${fp} (${buf.length} bytes) — not shown. Use Bash (e.g. \`file\`, \`xxd | head\`) to inspect it.`;
      }
      const raw = buf.toString('utf8');
      if (/\.ipynb$/i.test(fp)) {
        const nb = renderNotebook(raw);
        if (nb != null) return formatNumbered(nb, fp, offset, limit, '(empty notebook)');
      }
      if (raw === '') return `(${fp} exists but is empty)`;
      return formatNumbered(raw, fp, offset, limit, '(empty file)');
    } catch (e) {
      return 'Error reading file: ' + e.message;
    }
  },

  async write_file({ path: p, file_path: _fp, content, cwd, _readMtimes }) {
    const target = p || _fp;
    if (!target) return 'Error: Write requires a "path" argument, e.g. {"path":"index.html","content":"..."}. Point the file at the project folder with a relative path.';
    if (content === undefined || content === null) {
      return 'Error: Write requires a "content" argument with the COMPLETE file contents. For an empty file pass content: "".';
    }
    let fp;
    try { fp = resolvePath(target, cwd); } catch (e) { return 'Error writing file: ' + e.message; }
    const wr = sandbox.isWriteAllowed(fp);
    if (wr !== true) return 'Error: ' + wr.reason;
    try {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      // Guard against the classic "model wrote a fragment" failure: a file that
      // only contains a placeholder is worse than no file at all.
      fs.writeFileSync(fp, body, 'utf8');
      const st = fs.statSync(fp);
      editGuard.recordFileRead(_readMtimes, fp, body, st);
      const size = st.size;
      const warn = /(\/\/\s*rest of (the )?(code|file)|\.\.\.\s*(rest|omitted)|<placeholder>)/i.test(body)
        ? ' WARNING: content contains a placeholder — rewrite the file with its COMPLETE contents.'
        : '';
      const diag = quickSyntaxDiagnostic(fp) || editGuard.collectPostEditDiagnostics(fp, cwd);
      return `Wrote ${size} bytes to ${fp}.${warn}${diag}`;
    } catch (e) {
      return 'Error writing file (path=' + (p || '?') + '): ' + e.message;
    }
  },

  async edit_file({ path: p, file_path: _fp, old_string, new_string, cwd, replace_all, _readMtimes }) {
    const target = p || _fp;
    if (!target) return 'Error: Edit requires a "path" argument (alias: file_path).';
    let fp;
    try { fp = resolvePath(target, cwd); } catch (e) { return 'Error editing file: ' + e.message; }
    const we = sandbox.isWriteAllowed(fp);
    if (we !== true) return 'Error: ' + we.reason;
    try {
      const stale = editGuard.checkStaleRead(_readMtimes, fp);
      if (!stale.ok) return stale.error;
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); }
      catch (e) {
        // Claude Code: an empty old_string on a missing file creates it.
        if (e.code === 'ENOENT' && old_string === '' && new_string != null) {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, String(new_string), 'utf8');
          editGuard.recordFileRead(_readMtimes, fp, String(new_string));
          return `Created ${fp}${quickSyntaxDiagnostic(fp) || editGuard.collectPostEditDiagnostics(fp, cwd)}`;
        }
        return `Error editing file: cannot read ${fp} (${e.code || e.message}). Use the Write tool to create it first.`;
      }
      if (old_string === undefined || old_string === null || old_string === '') {
        return 'Error: Edit requires a non-empty "old_string" copied exactly from the file (use Read first), plus "new_string".';
      }
      const r = applyEdit(raw, String(old_string), new_string, !!replace_all);
      if (r.error) return editErrorText(r, fp, raw);
      fs.writeFileSync(fp, r.raw, 'utf8');
      editGuard.recordFileRead(_readMtimes, fp, r.raw);
      const diag = quickSyntaxDiagnostic(fp) || editGuard.collectPostEditDiagnostics(fp, cwd);
      if (replace_all) return `Replaced ${r.count} occurrence${r.count === 1 ? '' : 's'} in ${fp}${diag}`;
      return (r.fuzzy
        ? `Replaced 1 occurrence in ${fp} (matched after ignoring whitespace differences).`
        : `Replaced 1 occurrence in ${fp}`) + diag;
    } catch (e) {
      return 'Error editing file: ' + e.message;
    }
  },

  async multi_edit({ path: p, file_path: _fp, edits, cwd, _readMtimes }) {
    const target = p || _fp;
    if (!target) return 'Error: MultiEdit requires a "path" argument (alias: file_path).';
    let fp;
    try { fp = resolvePath(target, cwd); } catch (e) { return 'Error multi-editing file: ' + e.message; }
    const we = sandbox.isWriteAllowed(fp);
    if (we !== true) return 'Error: ' + we.reason;
    try {
      if (!Array.isArray(edits) || !edits.length) {
        return 'Error: MultiEdit requires a non-empty "edits" array of {old_string, new_string} pairs.';
      }
      const stale = editGuard.checkStaleRead(_readMtimes, fp);
      if (!stale.ok) return stale.error;
      let raw;
      try { raw = fs.readFileSync(fp, 'utf8'); }
      catch (e) {
        return `Error multi-editing file: cannot read ${fp} (${e.code || e.message}). Use the Write tool to create it first.`;
      }
      const original = raw;
      // Sequential and all-or-nothing: each edit sees the result of the
      // previous ones, and nothing is written unless every edit applies.
      for (let i = 0; i < edits.length; i++) {
        const e = edits[i];
        const label = `edit #${i + 1} of ${edits.length}`;
        if (!e || typeof e.old_string !== 'string' || e.old_string === '') {
          return `Error: ${label} is missing a non-empty "old_string". No changes were applied.`;
        }
        const r = applyEdit(raw, e.old_string, e.new_string, !!e.replace_all);
        if (r.error) {
          const msg = editErrorText(r, fp, original, label);
          return msg.replace('The file is unchanged.', 'No changes were applied (MultiEdit is all-or-nothing).')
            + (/No changes were applied/.test(msg) ? '' : ' No changes were applied (MultiEdit is all-or-nothing).');
        }
        raw = r.raw;
      }
      fs.writeFileSync(fp, raw, 'utf8');
      editGuard.recordFileRead(_readMtimes, fp, raw);
      return `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${fp}${quickSyntaxDiagnostic(fp) || editGuard.collectPostEditDiagnostics(fp, cwd)}`;
    } catch (e) {
      return 'Error multi-editing file: ' + e.message;
    }
  },

  async glob({ pattern, path: basePath, cwd }) {
    if (!pattern) return 'Error: Glob requires a "pattern".';
    let pat = String(pattern).replace(/\\/g, '/');
    let base = basePath ? resolvePath(basePath, cwd) : resolveDir(cwd);
    // An absolute pattern (`/repo/src/**/*.ts`): its literal leading segments
    // become the search root.
    if (path.isAbsolute(expandPath(pat))) {
      const segs = expandPath(pat).split('/');
      const lit = [];
      while (segs.length > 1 && !/[*?[\]{}]/.test(segs[0])) lit.push(segs.shift());
      base = lit.join('/') || '/';
      pat = segs.join('/');
    }
    const gs = sandbox.isReadAllowed(base);
    if (gs !== true) return 'Error: ' + gs.reason;
    if (!fs.existsSync(base)) return `Error: path does not exist: ${base}`;
    let res;
    try { res = expandBraces(pat).map(globToRegExp); } catch { return 'Error: invalid pattern'; }
    // Skip node_modules/.git unless the pattern names them; only descend into
    // other dot-dirs when the pattern targets dot paths.
    const wantsDot = /(^|\/)\./.test(pat);
    const named = (d) => pat.includes(d);
    const matches = [];
    let visits = 0;
    let truncatedWalk = false;
    const walk = (dir, depth) => {
      if (depth > GLOB_MAX_DEPTH) { truncatedWalk = true; return; }
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (++visits > GLOB_MAX_VISITS) { truncatedWalk = true; return; }
        const full = path.join(dir, e.name);
        const rel = path.relative(base, full).split(path.sep).join('/');
        let isDir = e.isDirectory();
        if (e.isSymbolicLink()) { try { isDir = false; if (!fs.statSync(full).isFile()) continue; } catch { continue; } } // never follow dir links (cycles)
        if (isDir) {
          if (GLOB_SKIP_DIRS.has(e.name) && !named(e.name)) continue;
          if (e.name.startsWith('.') && !wantsDot) continue;
          walk(full, depth + 1);
        } else if (res.some((re) => re.test(rel))) {
          matches.push({ rel, full });
        }
      }
    };
    walk(base, 0);
    if (!matches.length) return truncatedWalk ? '(no matches — search was cut short; narrow `path` or the pattern)' : '(no matches)';
    // Claude Code orders Glob results by modification time, newest first.
    for (const m of matches) { try { m.mtime = fs.statSync(m.full).mtimeMs; } catch { m.mtime = 0; } }
    matches.sort((a, b) => (b.mtime - a.mtime) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    let out = matches.slice(0, GLOB_MAX_RESULTS).map((m) => m.rel).join('\n');
    if (matches.length > GLOB_MAX_RESULTS || truncatedWalk) {
      out += `\n(Results are truncated: showing ${Math.min(matches.length, GLOB_MAX_RESULTS)} of ${matches.length}${truncatedWalk ? '+' : ''} matches. Use a more specific path or pattern.)`;
    }
    return out;
  },

  async grep({ pattern, path: p, cwd, glob: g, output_mode = 'content', context, type, head_limit = 250, offset = 0, multiline }) {
    if (!pattern) return 'Error: Grep requires a "pattern".';
    const target = p ? resolvePath(p, cwd) : resolveDir(cwd);
    const gp = sandbox.isReadAllowed(target);
    if (gp !== true) return 'Error: ' + gp.reason;
    // `path` may be a FILE (Example accepts either). rg's cwd must be a real
    // directory, so search from the file's parent and match just that file.
    let searchCwd = target;
    let onlyFile = null;
    try {
      if (fs.existsSync(target) && fs.statSync(target).isFile()) {
        searchCwd = path.dirname(target);
        onlyFile = target;
      }
    } catch (_) {}
    const mode = ['content', 'files_with_matches', 'count'].includes(output_mode) ? output_mode : 'content';
    const args = ['-n', '--no-heading', '--color', 'never'];
    if (multiline) args.push('-U');
    if (mode === 'files_with_matches') args.push('--files-with-matches');
    if (mode === 'count') args.push('--count');
    if (context) args.push('-C', String(Math.max(0, parseInt(context, 10) || 0)));
    if (g) args.push('-g', String(g));
    if (type) args.push('-t', String(type));
    args.push('--', String(pattern), onlyFile || target);
    const runRg = () => new Promise((resolve) => {
      let out = '';
      let child;
      try {
        child = spawn('rg', args, { cwd: searchCwd, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) { resolve(null); return; }
      child.stdout.on('data', (d) => { if (out.length < 8 * 1024 * 1024) out += d.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', (code) => resolve(code === 0 || code === 1 ? out : (out || null)));
    });
    let out = await runRg();
    if (out === null) {
      // No ripgrep on PATH — same semantics with grep.
      const gargs = ['-rIn'];
      if (mode === 'files_with_matches') gargs.push('-l');
      if (mode === 'count') gargs.push('-c');
      if (context) gargs.push('-C', String(Math.max(0, parseInt(context, 10) || 0)));
      if (g) gargs.push('--include', String(g));
      gargs.push('--', String(pattern), target);
      out = await new Promise((resolve) => {
        exec('grep ' + gargs.map((a) => JSON.stringify(a)).join(' '), { maxBuffer: 8 * 1024 * 1024 }, (e, so) => resolve(so || ''));
      });
    }
    const all = String(out || '').split('\n').filter(Boolean);
    const skip = Math.max(0, parseInt(offset, 10) || 0);
    const cap = Math.max(1, Math.min(parseInt(head_limit, 10) || 250, 10000));
    const shown = all.slice(skip, skip + cap);
    if (!shown.length) return all.length ? `(no results at offset ${skip}; ${all.length} total)` : '(no matches)';
    let text = truncate(shown.join('\n'));
    const rest = all.length - (skip + shown.length);
    if (rest > 0) text += `\n…[${rest} more matches — increase head_limit or set offset ${skip + shown.length}]`;
    return text;
  },

  async web_fetch({ url }) {
    const hostOk = sandbox.isHostAllowed(url);
    if (hostOk !== true) return 'Error: ' + hostOk.reason;
    if (!url || !/^https?:\/\//i.test(url)) return 'Error: absolute http(s) URL required';
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'AkronBot/1.0' } });
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('text/html')) {
        const html = await res.text();
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        return untrusted.wrapUntrusted(truncate(text.slice(0, 30000)), { source: 'WebFetch', url });
      }
      return untrusted.wrapUntrusted(truncate(await res.text()), { source: 'WebFetch', url });
    } catch (e) {
      return 'Error fetching URL: ' + e.message;
    }
  },

  async web_search({ query }) {
    if (!query) return 'Error: query required';
    try {
      const u = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      const res = await fetch(u, { headers: { 'user-agent': 'Mozilla/5.0 (AUTOBOT)' } });
      const html = await res.text();
      const hits = [];
      const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(html)) && hits.length < 8) {
        const title = m[2].replace(/<[^>]+>/g, '').trim();
        let url = m[1];
        const ud = /uddg=([^&]+)/.exec(url);
        if (ud) url = decodeURIComponent(ud[1]);
        hits.push(`${title}\n  ${url}`);
      }
      return hits.length ? untrusted.wrapUntrusted(hits.join('\n\n'), { source: 'WebSearch', url: query }) : '(no results)';
    } catch (e) {
      return 'Error searching: ' + e.message;
    }
  },

  async todo_write({ todos }) {
    if (!Array.isArray(todos)) return 'Error: todos array required';
    const lines = todos.map((t) => {
      const box = t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[-]' : '[ ]';
      const active = t.status === 'in_progress' && t.activeForm ? ` (${t.activeForm})` : '';
      return `${box} ${t.content || t.title || ''}${active}`;
    });
    return 'TODOS:\n' + lines.join('\n');
  },

  // ---- Notebooks ----
  async notebook_read({ name }) {
    if (!name) return 'Error: notebook name required';
    const nb = store.getNotebook(name);
    if (!nb.cells || !nb.cells.length) return `Notebook "${name}" is empty.`;
    return nb.cells.map((c, i) => `### Cell ${i} (${c.language || 'text'})\n${c.source || ''}`).join('\n\n');
  },

  async notebook_edit({ name, cells }) {
    if (!name) return 'Error: notebook name required';
    if (!Array.isArray(cells)) return 'Error: cells array required';
    const nb = store.writeNotebook(name, cells);
    return `Saved notebook "${name}" with ${nb.cells.length} cells.`;
  },

  async list_notebooks() {
    const names = store.listNotebooks();
    return names.length ? 'NOTEBOOKS:\n' + names.map((n) => `- ${n}`).join('\n') : '(no notebooks)';
  },

  // ---- Memory ----
  async memory_add({ content, category, scope, cwd }) {
    if (!content) return 'Error: content required';
    const res = skillLearner.addStructuredMemory({ content, category, scope, cwd });
    if (!res.ok) return 'Error: ' + (res.error || 'failed to save memory');
    if (res.deduplicated) return `Updated existing [${res.category}] memory entry.`;
    return `Saved [${res.category}] memory${res.projectMemoryPath ? ` (also updated ${res.projectMemoryPath})` : ''}.`;
  },

  async memory_list() {
    return 'MEMORY:\n' + store.memoryAsText();
  },

  async memory_delete({ index }) {
    const r = store.deleteMemory(index);
    if (r.ok) return `Deleted memory entry at index ${index}.`;
    return r.error || 'Failed to delete memory entry.';
  },

  // ---- Skills ----
  async list_skills() {
    const skills = store.getSkills().filter((s) => s.enabled !== false);
    if (!skills.length) return 'SKILLS:\n(no skills enabled)';
    return 'SKILLS:\n' + skills.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  },

  async load_skill({ name }) {
    const text = store.loadSkill(name);
    return text ? `SKILL "${name}":\n${text}` : `Skill "${name}" not found.`;
  },

  async skill({ name }) {
    return executors.load_skill({ name });
  },

  // ---- Custom skill authoring ----
  async create_skill({ name, content }) {
    const r = store.addCustomSkill(name, content);
    if (!r.ok) return 'Error: ' + r.error;
    return `Created custom skill "${r.name}" (saved to ${r.file}). It is now available via list_skills and Skill.`;
  },

  async extract_skill({ name, description, triggers, steps, pitfalls, verification, content, scope, cwd }) {
    const r = skillLearner.extractSkillToDisk({ name, description, triggers, steps, pitfalls, verification, content, scope, cwd });
    if (!r.ok) return { content: 'Error: ' + (r.error || 'Failed to extract skill.'), isError: true };
    return `Extracted reusable skill "${r.name}" to ${r.file} (${r.bytes} bytes). Available via list_skills and Skill.`;
  },

  async delete_skill({ name }) {
    const r = store.deleteCustomSkill(name);
    if (!r.ok) return 'Error: ' + r.error;
    return `Deleted custom skill "${r.name}".`;
  },

  // ---- Plugins & connectors ----
  async plugins_list_plugins({ type, category, installedOnly } = {}) {
    const list = pluginsDir.listPlugins({ type, category, installedOnly: !!installedOnly });
    return pluginsDir.formatList(list, 'PLUGINS & CONNECTORS (' + list.length + ')');
  },
  async plugins_search_plugins({ query, limit } = {}) {
    const list = pluginsDir.search(query, { type: 'plugin', limit });
    return pluginsDir.formatList(list, 'PLUGIN SEARCH: ' + (query || ''));
  },
  async plugins_search_connectors({ query, limit } = {}) {
    const list = pluginsDir.search(query, { type: 'connector', limit });
    return pluginsDir.formatList(list, 'CONNECTOR SEARCH: ' + (query || ''));
  },
  async plugins_suggest_plugin_install({ goal, limit } = {}) {
    return pluginsDir.formatSuggest(pluginsDir.suggest(goal, { limit }), goal);
  },
  async plugins_install({ id } = {}) {
    const r = pluginsDir.install(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Installed ${r.entry.name} (${r.entry.id}).${r.entry.auth !== 'none' ? ' It needs a sign-in/credential before its tools work — open Plugins in the sidebar to connect it.' : ''}`;
  },
  async plugins_uninstall({ id } = {}) {
    const r = pluginsDir.uninstall(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Uninstalled ${id}.`;
  },

  async plugins_directory_stats() {
    const st = pluginsDir.stats();
    const r = st.registry || {};
    return [
      'PLUGINS & CONNECTORS DIRECTORY',
      `- total: ${st.total}`,
      `- connectors: ${st.connectors}`,
      `- plugins: ${st.plugins}`,
      `- categories: ${st.categories}`,
      `- with MCP endpoint: ${st.withEndpoint}`,
      `- live MCP registry: ${r.count || 0} entries${r.stale ? ' (stale)' : ''}${r.refreshing ? ' (syncing…)' : ''}`,
    ].join('\n');
  },
  async plugins_refresh_registry({ maxPages } = {}) {
    const r = await pluginsDir.refreshRegistry({ maxPages });
    if (!r.ok) return 'Registry refresh failed: ' + r.error + ' (cached entries still available)';
    return `Refreshed the MCP registry: ${r.count} connectors from ${r.pages} page(s).`;
  },

  // ---- MCP registry (connector view of the same catalog) ----
  async mcp_registry_list_connectors({ installedOnly } = {}) {
    const list = pluginsDir.listPlugins({ type: 'connector', installedOnly: !!installedOnly });
    return pluginsDir.formatList(list, 'MCP CONNECTORS (' + list.length + ')');
  },
  async mcp_registry_search_mcp_registry({ query, limit } = {}) {
    const list = pluginsDir.search(query, { type: 'connector', limit });
    return pluginsDir.formatList(list, 'MCP REGISTRY SEARCH: ' + (query || ''));
  },
  async mcp_registry_suggest_connectors({ goal, limit } = {}) {
    const list = pluginsDir.suggest(goal, { limit });
    return pluginsDir.formatSuggest(list, goal);
  },

  // ---- Scheduled tasks ----
  async scheduled_tasks_create_scheduled_task(args = {}) {
    const r = scheduler.create(args);
    if (!r.ok) return 'Error: ' + r.error;
    return `Created scheduled task ${r.task.id} "${r.task.name}" [${r.task.schedule}].`;
  },
  async scheduled_tasks_list_scheduled_tasks() {
    return scheduler.formatList(scheduler.list());
  },
  async scheduled_tasks_update_scheduled_task({ id, ...patch } = {}) {
    const r = scheduler.update(id, patch);
    if (!r.ok) return 'Error: ' + r.error;
    return `Updated scheduled task ${r.task.id} [${r.task.schedule}].`;
  },
  async scheduled_tasks_delete_scheduled_task({ id } = {}) {
    const r = scheduler.remove(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Deleted scheduled task ${id}.`;
  },
  async scheduled_tasks_run_scheduled_task({ id } = {}) {
    const r = await scheduler.runNow(id);
    if (!r.ok) return 'Error: ' + r.error;
    return `Ran scheduled task ${id}: ` + (r.result.ok ? String(r.result.output || '').slice(0, 1200) : 'ERROR ' + r.result.error);
  },

  // ---- Slash commands ----
  async slash_command({ command }) {
    if (!command) return 'Error: command required';
    const key = String(command).replace(/^\//, '');
    if (SLASH_COMMANDS[key]) return `Slash command "/${key}": ${SLASH_COMMANDS[key]}`;
    return `Unknown slash command "/${key}". Available: ${Object.keys(SLASH_COMMANDS).map((c) => '/' + c).join(', ')}`;
  },

  async list_slash_commands() {
    return 'SLASH COMMANDS:\n' + Object.entries(SLASH_COMMANDS).map(([c, d]) => `/${c} — ${d}`).join('\n');
  },

  // ---- Code execution (REPL / JavaScript) ----
  async javascript({ code, cwd }) {
    if (!code) return 'Error: code required';
    return runCode('javascript', code, cwd, 60000);
  },

  async repl({ language, code, cwd, description, timeout, reset }) {
    if (!code) return 'Error: code required';
    const lang = (language || 'javascript').toLowerCase();
    if (lang === 'javascript' || lang === 'js' || lang === 'node') {
      const r = await replSession.evalJS({
        code,
        timeout,
        cwd: resolveDir(cwd),
        sessionId: resolveDir(cwd),
        reset: reset === true,
      });
      return r.ok ? r.output : { content: r.output, isError: true };
    }
    return runCode(lang, code, cwd, clampReplTimeout(timeout));
  },

  // ---- Tool search ----
  async tool_search({ query }) {
    const q = String(query || '').toLowerCase();
    const matches = toolDefinitions.filter(
      (t) => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
    if (!matches.length) return '(no matching tools)';
    return 'TOOLS:\n' + matches.slice(0, 25).map((t) => `- ${t.name}: ${t.description}`).join('\n');
  },

  // ---- Jira / Linear integrations (config-gated) ----
  async jira({ action, jql, issueKey, project, summary, description, idempotency_key }) {
    const base = process.env.JIRA_BASE_URL || '';
    const email = process.env.JIRA_EMAIL || '';
    const token = process.env.JIRA_API_TOKEN || '';
    if (!base || !email || !token) {
      return 'Jira integration not configured. Set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN to enable (search / get / create issues).';
    }
    const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
    const act = (action || 'search').toLowerCase();
    const idemKey = act === 'create' ? (idempotency_key || `jira:create:${project || ''}:${summary || ''}`) : null;
    if (idemKey) {
      const gate = sideEffectsGuard.beginExecution(idemKey, { tool: 'Jira', action: act, project });
      if (!gate.allowed) {
        return `Skipped duplicate Jira create (idempotency state: ${gate.state}).`;
      }
    }
    try {
      let url, method = 'GET', body;
      if (act === 'search' || act === 'list') {
        url = `${base.replace(/\/$/, '')}/rest/api/3/search?jql=${encodeURIComponent(jql || 'order by created DESC')}&maxResults=10`;
      } else if (act === 'get') {
        url = `${base.replace(/\/$/, '')}/rest/api/3/issue/${encodeURIComponent(issueKey || '')}`;
      } else if (act === 'create') {
        method = 'POST';
        url = `${base.replace(/\/$/, '')}/rest/api/3/issue`;
        body = JSON.stringify({ fields: { project: { key: project || '' }, summary: summary || '', description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: description || '' }] }] } } });
      } else {
        return 'Unsupported Jira action. Use search, get, or create.';
      }
      const res = await fetch(url, { method, headers: { authorization: auth, 'content-type': 'application/json', accept: 'application/json' }, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (idemKey) sideEffectsGuard.finishExecution(idemKey, 'uncertain', `HTTP ${res.status}`);
        return `Jira error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`;
      }
      if (idemKey) {
        sideEffectsGuard.finishExecution(idemKey, 'completed', data.key || 'created');
        try { auditLedger.appendAuditEntry({ type: 'side_effect', tool: 'Jira', action: act, key: data.key || null }); } catch (_) {}
      }
      if (act === 'search' || act === 'list') {
        const issues = data.issues || [];
        if (!issues.length) return '(no Jira issues found)';
        return untrusted.wrapUntrusted(issues.map((i) => `- ${i.key}: ${(i.fields && i.fields.summary) || ''}`).join('\n'), { source: 'Jira' });
      }
      return untrusted.wrapUntrusted(truncate(JSON.stringify(data, null, 2)), { source: 'Jira' });
    } catch (e) {
      if (idemKey) sideEffectsGuard.finishExecution(idemKey, 'uncertain', e.message);
      return 'Jira error: ' + e.message;
    }
  },

  async linear({ action, query }) {
    const key = process.env.LINEAR_API_KEY || '';
    if (!key) return 'Linear integration not configured. Set LINEAR_API_KEY to enable.';
    const act = (action || 'issues').toLowerCase();
    let gql;
    if (act === 'issues' || act === 'list') gql = `query { issues(first: 10, orderBy: updatedAt) { nodes { identifier title state { name } } } }`;
    else if (act === 'search') gql = `query { issueSearch(filter: { query: ${JSON.stringify(query || '')} }, first: 10) { nodes { identifier title } } }`;
    else return 'Unsupported Linear action. Use issues or search.';
    try {
      const res = await fetch('https://api.linear.app/graphql', { method: 'POST', headers: { authorization: key, 'content-type': 'application/json' }, body: JSON.stringify({ query: gql }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return `Linear error ${res.status}: ${JSON.stringify(data).slice(0, 500)}`;
      const nodes = data.data && (data.data.issues ? data.data.issues.nodes : data.data.issueSearch && data.data.issueSearch.nodes) || [];
      if (!nodes.length) return '(no Linear issues found)';
      return nodes.map((n) => `- ${n.identifier}: ${n.title}`).join('\n');
    } catch (e) {
      return 'Linear error: ' + e.message;
    }
  },

  // ---- Computer Use ----
  async computer_screenshot({ dir }) {
    const r = await computer.screenshot({ dir });
    return `Screenshot saved: ${r.path} (${r.size} bytes)`;
  },
  async computer_click({ x, y, button, double }) {
    await computer.click(Number(x), Number(y), button, !!double);
    return `Clicked at (${x}, ${y}).`;
  },
  async computer_move({ x, y }) {
    await computer.move(Number(x), Number(y));
    return `Moved mouse to (${x}, ${y}).`;
  },
  async computer_drag({ x1, y1, x2, y2 }) {
    await computer.drag(Number(x1), Number(y1), Number(x2), Number(y2));
    return `Dragged from (${x1},${y1}) to (${x2},${y2}).`;
  },
  async computer_scroll({ direction, amount }) {
    await computer.scroll(direction, amount);
    return 'Scrolled.';
  },
  async computer_type({ text }) {
    await computer.type(text);
    return 'Typed.';
  },
  async computer_key({ keys }) {
    await computer.key(keys);
    return 'Key pressed.';
  },
  async computer_screen_size() {
    const s = await computer.screenSize();
    return `Screen: ${s.width}x${s.height}`;
  },

  // ---- Chrome (CDP) ----
  async chrome_list_tabs() {
    const ts = await chrome.getTargets();
    return ts.length ? untrusted.wrapUntrusted(ts.map((t) => `- ${t.id}: ${t.title} (${t.url})`).join('\n'), { source: 'ChromeCDP' }) : '(no Chrome tabs found)';
  },
  async chrome_navigate({ url, targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    await cdp.send('Page.enable');
    await cdp.send('Page.navigate', { url });
    cdp.close();
    return `Navigated to ${url}`;
  },
  async chrome_evaluate({ expression, targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    const v = await chrome.evaluate(cdp, expression);
    cdp.close();
    return untrusted.wrapUntrusted(String(v), { source: 'ChromeCDP' });
  },
  async chrome_screenshot({ targetId }) {
    const { cdp } = await chrome.connectToTarget(targetId);
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    cdp.close();
    return r && r.data ? `base64 PNG (length ${r.data.length})` : '(no screenshot)';
  },

  // ---- Built-in Browser (the in-app <webview> pane) ----
  async browser_open({ url, cwd }) {
    const r = await browser.loadURL(url, cwd);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Opened ${r.url} in the built-in browser.`;
  },
  async browser_navigate({ url, cwd }) {
    const r = await browser.loadURL(url, cwd);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Navigated to ${r.url}.`;
  },
  async browser_back() {
    const r = await browser.goBack();
    return r.ok ? `Went back to ${r.url || 'previous page'}.` : 'Browser error: ' + r.error;
  },
  async browser_forward() {
    const r = await browser.goForward();
    return r.ok ? `Went forward to ${r.url || 'next page'}.` : 'Browser error: ' + r.error;
  },
  async browser_reload() {
    const r = await browser.reload();
    return r.ok ? 'Reloaded.' : 'Browser error: ' + r.error;
  },
  async browser_stop() {
    const r = await browser.stop();
    return r.ok ? 'Stopped.' : 'Browser error: ' + r.error;
  },
  async browser_read() {
    const r = await browser.read();
    if (!r.ok) return 'Browser error: ' + r.error;
    const gate = require('./browser-bot-v2').detectHumanGate({ url: r.url, title: r.title, text: r.text });
    const notice = gate.gated ? `\n[HUMAN_HANDOFF_REQUIRED (${gate.gateType})]: ${gate.reason}\n` : '';
    return untrusted.wrapUntrusted(truncate(`PAGE: ${r.title}\nURL: ${r.url}${notice}\n\n${r.text || '(no visible text)'}`), { source: 'BrowserDOM', url: r.url || '' });
  },
  async browser_snapshot(args = {}) {
    if (args.compactAx !== false && typeof browser.snapshotAx === 'function') {
      const ax = await browser.snapshotAx({ som: !!args.som, somFallback: args.somFallback !== false, maxItems: args.maxItems });
      if (ax && ax.ok && ax.snapshotText) {
        const notice = ax.gate && ax.gate.gated ? `\n[HUMAN_HANDOFF_REQUIRED (${ax.gate.gateType})]: ${ax.gate.reason}\n` : '';
        const somNote = ax.som && ax.som.count ? `\n[Set-of-Marks visual badges active: ${ax.som.count} targets]` : '';
        return untrusted.wrapUntrusted(truncate(`${ax.snapshotText}${somNote}${notice}`), { source: 'BrowserAX', url: ax.url || '' });
      }
      if (ax && !ax.ok) return 'Browser error: ' + ax.error;
    }
    const r = await browser.read();
    if (!r.ok) return 'Browser error: ' + r.error;
    const lines = [`PAGE: ${r.title}`, `URL: ${r.url}`];
    if (r.links && r.links.length) { lines.push('\nLINKS:'); r.links.forEach((l) => lines.push('- ' + l)); }
    if (r.buttons && r.buttons.length) { lines.push('\nBUTTONS:'); r.buttons.forEach((b) => lines.push('- ' + b)); }
    if (r.inputs && r.inputs.length) { lines.push('\nINPUTS:'); r.inputs.forEach((i) => lines.push(`- <${i.tag}> name="${i.name}" type="${i.type}" placeholder="${i.placeholder}"`)); }
    return untrusted.wrapUntrusted(truncate(lines.join('\n')), { source: 'BrowserDOM', url: r.url || '' });
  },
  async browser_vault_autofill({ origin, selectors } = {}) {
    const v2 = require('./browser-bot-v2');
    const pageUrl = browser.getURL();
    const res = await v2.vaultAutofill({
      pageUrl,
      expectedOrigin: origin || pageUrl,
      selectors: selectors || {},
      injectFn: async (assignments) => {
        const applied = [];
        for (const item of assignments) {
          const r = await browser.type(item.selector, item.value);
          if (r && r.ok && r.found) applied.push(item.field);
        }
        return { applied };
      },
    });
    return JSON.stringify(res);
  },
  async browser_replay_skill({ name, skipStartUrl } = {}) {
    const skills = require('./browser-skills');
    const sk = skills.loadSkill(name);
    if (!sk) return `Browser skill "${name}" not found.`;
    const res = await skills.replaySkill(sk, {
      navigate: (u) => browser.loadURL(u),
      click: (t) => browser.click(t),
      type: (t, v) => browser.type(t, v),
      select: (t, v) => browser.select(t, v),
      press: (k) => browser.press(k),
      hover: (t) => browser.hover(t),
      snapshot: () => browser.snapshotAx(),
    }, { skipStartUrl: !!skipStartUrl });
    return JSON.stringify(res);
  },
  async browser_click({ selector, index }) {
    const r = await browser.click(selector, index);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}" at index ${Number(index) || 0}.`;
    return `Clicked <${r.tag}> "${r.text}".`;
  },
  async browser_type({ selector, text }) {
    const r = await browser.type(selector, text);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}".`;
    return `Typed into ${selector}.`;
  },
  async browser_press({ key }) {
    const r = await browser.press(key);
    return r.ok ? `Pressed "${key}".` : 'Browser error: ' + r.error;
  },
  async browser_js({ code }) {
    const r = await browser.executeJS(code, true);
    if (!r.ok) return 'Browser error: ' + r.error;
    return typeof r.result === 'object' ? JSON.stringify(r.result, null, 2) : String(r.result);
  },
  async browser_hover({ selector, index }) {
    const r = await browser.hover(selector, index);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No element matched selector "${selector}" at index ${Number(index) || 0}.`;
    return `Hovered <${r.tag}> "${r.text}".`;
  },
  async browser_select({ selector, value }) {
    const r = await browser.select(selector, value);
    if (!r.ok) return 'Browser error: ' + r.error;
    if (!r.found) return `No <select> matched selector "${selector}".`;
    return `Selected "${r.value}" in ${selector}.`;
  },
  async browser_scroll({ direction, amount, selector }) {
    const r = await browser.scroll(direction, amount, selector);
    if (!r.ok) return 'Browser error: ' + r.error;
    const pos = r.scrollY != null ? `scrollY=${r.scrollY}` : `scrollTop=${r.scrollTop}`;
    return `Scrolled ${String(direction || 'down')} ${amount == null ? 600 : amount}px (${pos}).`;
  },
  async browser_wait_for({ selector, timeoutMs }) {
    const r = await browser.waitFor(selector, timeoutMs);
    if (!r.ok) return 'Browser error: ' + r.error;
    return r.found ? `Element "${selector}" appeared after ${r.waited}ms.` : `Timed out after ${r.waited}ms waiting for "${selector}".`;
  },
  async browser_screenshot({ fullPage }) {
    const r = await browser.screenshot(!!fullPage);
    if (!r.ok) return 'Browser error: ' + r.error;
    return `Screenshot saved: ${r.path} (${r.width}x${r.height}${fullPage ? ', full page' : ''}). Use Read to view it.`;
  },
  async browser_tabs({ action, url, index }) {
    const act = String(action || 'list').toLowerCase();
    if (act === 'list') {
      const r = browser.listTabs();
      if (!r.tabs || !r.tabs.length) return 'No browser tabs (pane closed).';
      return 'TABS:\n' + r.tabs.map((t, i) => `${i + 1}. ${t.title || '(untitled)'} — ${t.url}${t.id === r.activeId ? ' [active]' : ''}`).join('\n');
    }
    if (act === 'new') {
      const r = browser.sendTabCommand({ type: 'new', url: url ? browser.normalizeUrl(url) : undefined });
      if (!r.ok) return 'Browser error: ' + r.error;
      await new Promise((res) => setTimeout(res, 1500));
      const st = browser.listTabs();
      const t = (st.tabs || []).find((x) => x.id === st.activeId);
      return t ? `Opened new tab: ${t.title || t.url} — ${t.url}` : 'Opened a new tab.';
    }
    const state = browser.listTabs();
    if (act === 'close' || act === 'switch') {
      const tabs = state.tabs || [];
      const target = tabs[Number(index)] || tabs.find((t) => t.id === state.activeId) || null;
      if (!target) return 'No such tab.';
      const r = browser.sendTabCommand({ type: act, tabId: target.id });
      if (!r.ok) return 'Browser error: ' + r.error;
      await new Promise((res) => setTimeout(res, act === 'switch' ? 400 : 700));
      if (act === 'switch') {
        const wid = browser.getGuest();
        const u = wid ? (() => { try { return wid.getURL(); } catch (e) { return ''; } })() : '';
        return `Switched to tab "${target.title || target.url}"${u ? ' — ' + u : ''}.`;
      }
      return `Closed tab "${target.title || target.url}".`;
    }
    return `Unknown action "${action}". Use list, new, switch, or close.`;
  },

  async apply_patch({ patch, input, cwd, _readMtimes, _takeCheckpoint }) {
    const res = applyPatchMod.applyPatchToWorkspace({
      patch: patch || input || '',
      cwd: resolveDir(cwd),
      resolvePath: (p, d) => resolvePath(p, d),
      readMtimes: _readMtimes || null,
      sandboxMod: sandbox,
      editGuard,
      takeCheckpoint: _takeCheckpoint || null,
    });
    if (!res.ok) return { content: 'Error: ' + res.error, isError: true };
    return res.content;
  },

  async shadow_check({ cwd, timeout }) {
    const res = await editGuard.runShadowCheck(resolveDir(cwd), { timeoutMs: timeout || 30000 });
    if (!res.ok) return { content: res.summary, isError: true };
    return res.summary;
  },

  async codebase_search({ query, limit, cwd }) {
    const res = await codebaseIndex.searchCodebase(resolveDir(cwd), query, { limit: limit || 12 });
    if (!res.ok) return { content: 'CodebaseSearch error: ' + (res.error || 'unknown'), isError: true };
    if (!res.hits || !res.hits.length) return 'No matches in codebase index.';
    return res.hits.map((h) => {
      const syms = h.symbols && h.symbols.length ? ' [' + h.symbols.map((s) => `${s.kind}:${s.name}`).join(', ') + ']' : '';
      return `${h.file}:${h.startLine}-${h.endLine} (score ${h.score})${syms}\n${h.snippet}`;
    }).join('\n---\n');
  },

  async run_tool_script({ code, timeout, cwd, _ctx }) {
    const baseCtx = _ctx || { cwd };
    const callHostTool = async (method, mArgs) => {
      const a = { ...(mArgs || {}), cwd: (mArgs && mArgs.cwd) || cwd };
      const map = {
        read: 'Read',
        glob: 'Glob',
        grep: 'Grep',
        codebaseSearch: 'CodebaseSearch',
        write: 'Write',
        edit: 'Edit',
      };
      const toolName = map[method];
      if (!toolName) throw new Error('Disallowed bridge method: ' + method);
      const out = await runTool(toolName, a, baseCtx);
      return out && out.content != null ? out.content : String(out || '');
    };
    const res = await codemode.runToolScript({
      code,
      cwd: resolveDir(cwd),
      timeoutMs: timeout || 15000,
      callHostTool,
    });
    if (!res.ok) return { content: res.error, isError: true };
    return truncate(res.output);
  },
};

// Run a snippet of code in a language via a local runtime and return output.
function runCode(lang, code, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const t = Math.min(timeoutMs || 60000, 120000);
    let cmd;
    if (lang === 'javascript' || lang === 'js' || lang === 'node') {
      cmd = 'node -e ' + JSON.stringify(String(code));
    } else if (lang === 'python' || lang === 'py' || lang === 'python3') {
      cmd = (process.platform === 'win32' ? 'python' : 'python3') + ' -c ' + JSON.stringify(String(code));
    } else if (lang === 'bash' || lang === 'sh' || lang === 'shell') {
      cmd = process.platform === 'win32'
        ? 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command ' + JSON.stringify(String(code))
        : require('./paths').defaultPosixShell() + ' -c ' + JSON.stringify(String(code));
    } else {
      resolve(`Unsupported REPL language "${lang}". Supported: javascript/node, python, bash/shell.`);
      return;
    }
    exec(cmd, { cwd: resolveDir(cwd), timeout: t, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      let out = '';
      if (stdout) out += stdout;
      if (stderr) out += (out ? '\n[stderr]\n' : '') + stderr;
      if (err && !out) out = 'Error: ' + err.message;
      resolve(truncate(out || '(no output)'));
    });
  });
}

// ---------- tool definitions (OpenAI function-calling schema) ----------
// Names/descriptions mirror Claude Code's tool surface 1:1 where applicable.
const toolDefinitions = [
  { name: 'Bash', description: 'Run a shell command in zsh (run code, git, install deps, list/inspect files). Do NOT create or edit files with heredocs, echo, tee or sed -i — use Write/Edit for file content. Set run_in_background:true for long jobs (servers, builds, watches) and poll them with TaskOutput or stop them with KillShell.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The command to execute' }, description: { type: 'string', description: 'Short human label shown in the UI (3–5 words)' }, cwd: { type: 'string', description: 'Working directory' }, timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000, max 600000)' }, run_in_background: { type: 'boolean', description: 'Run detached; returns a shell id for TaskOutput/KillShell' }, dangerouslyDisableSandbox: { type: 'boolean', description: 'Accepted for parity; commands already run unsandboxed on macOS' } }, required: ['command'] } },
  { name: 'Read', description: 'Read a text file from disk. Output is numbered like `cat -n` (line number, tab, line). Returns up to `limit` lines starting at 1-based `offset` (default 2000 lines; lines over 2000 chars are cut). For PDFs, pass `pages` (e.g. "1-10") to extract a page range. Binary files are detected and not dumped. Always Read a file before editing it; never copy the line-number prefix into old_string.', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string', description: 'Alias for path' }, offset: { type: 'number', description: '1-based line to start at' }, limit: { type: 'number', description: 'Max lines to return (default 2000)' }, pages: { type: 'string', description: 'PDF page range, e.g. "1-10"' }, cwd: { type: 'string' } }, required: ['path'] } },
  { name: 'Write', description: 'Create a new file or fully overwrite an existing one. Provide the COMPLETE final contents (no placeholders, no elisions). Relative paths resolve inside the project folder. This is the only correct way to create files — never use bash heredocs.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'File path, relative to the project folder' }, file_path: { type: 'string', description: 'Alias for path' }, content: { type: 'string', description: 'The complete file contents' }, cwd: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'Edit', description: 'Make a targeted change to an existing file: replace old_string with new_string. old_string must match exactly ONE place in the file (include surrounding lines to make it unique) unless replace_all is true. Read the file first and copy old_string exactly, including indentation (without the Read line-number prefix).', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string', description: 'Alias of path (Example-style)' }, old_string: { type: 'string', description: 'Exact text to replace (copy from Read output)' }, new_string: { type: 'string', description: 'Replacement text' }, replace_all: { type: 'boolean', description: 'Replace every occurrence' }, cwd: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'MultiEdit', description: 'Apply several {old_string,new_string} replacements to one file in a single call, in order (each sees the previous result), all-or-nothing. Each old_string must be unique unless that edit sets replace_all. Use instead of many separate Edits.', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string', description: 'Alias of path' }, edits: { type: 'array', items: { type: 'object', properties: { old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } }, cwd: { type: 'string' } }, required: ['path', 'edits'] } },
  { name: 'ApplyPatch', description: 'Atomically apply multi-file Add/Update/Delete changes in Codex V4A patch format (`*** Begin Patch` ... `*** End Patch`, with fuzzy line matching and post-edit diagnostics).', parameters: { type: 'object', properties: { patch: { type: 'string', description: 'Patch text starting with *** Begin Patch and ending with *** End Patch' }, input: { type: 'string', description: 'Alias for patch' }, cwd: { type: 'string' } }, required: ['patch'] } },
  { name: 'ShadowCheck', description: 'Run fast background typecheck/lint/syntax verification on the workspace before finishing a coding turn.', parameters: { type: 'object', properties: { cwd: { type: 'string' }, timeout: { type: 'number' } } } },
  { name: 'CodebaseSearch', description: 'Hybrid symbol + BM25 + semantic trigram search over the incremental SQLite/Merkle workspace index (respects .gitignore and .akronignore).', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Symbol name, concept, or natural-language code query' }, limit: { type: 'number', description: 'Max ranked hits (default 12)' }, cwd: { type: 'string' } }, required: ['query'] } },
  { name: 'RunToolScript', description: 'Execute an isolated async JavaScript batching script (`tools.read`, `tools.glob`, `tools.grep`, `tools.codebaseSearch`, `tools.write`, `tools.edit`) to combine multi-file reads/searches/edits in 1 turn.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'Async JS body using `await tools.*` and `return`' }, timeout: { type: 'number', description: 'Timeout in ms (default 15000, max 60000)' }, cwd: { type: 'string' } }, required: ['code'] } },
  { name: 'Glob', description: 'Find files matching a glob pattern (supports **, *, ?, [abc], {a,b}), e.g. "**/*.{ts,tsx}". Results are sorted by modification time (newest first); node_modules and .git are skipped. Use `path` to set the search root.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'Directory to search from (default: cwd)' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Grep', description: 'Search file contents for a regex pattern recursively. output_mode: content (default) | files_with_matches | count. Filter with glob/type, add context lines, and page results with offset/head_limit.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string', description: 'File or directory to search' }, glob: { type: 'string', description: 'Only files matching this glob, e.g. "*.js"' }, type: { type: 'string', description: 'File type filter, e.g. js, py, rust' }, output_mode: { type: 'string', enum: ['content', 'files_with_matches', 'count'] }, context: { type: 'number', description: 'Lines of context around each match' }, head_limit: { type: 'number', description: 'Max results (default 250)' }, offset: { type: 'number', description: 'Skip first N results' }, multiline: { type: 'boolean', description: 'Allow patterns to span lines' }, '-i': { type: 'boolean', description: 'Case-insensitive' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'WebFetch', description: 'Fetch the contents of a URL, convert the page to readable markdown, and then answer the given prompt about it. Prefer this over shelling out to curl when you need to understand a web page.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL to fetch' }, prompt: { type: 'string', description: 'What to extract/answer from the page' } }, required: ['url', 'prompt'] } },
  { name: 'WebSearch', description: 'Search the web and return top results (titles + URLs). Optionally restrict to or exclude specific domains.', parameters: { type: 'object', properties: { query: { type: 'string' }, allowed_domains: { type: 'array', items: { type: 'string' }, description: 'Only return results from these domains' }, blocked_domains: { type: 'array', items: { type: 'string' }, description: 'Exclude results from these domains' } }, required: ['query'] } },
  { name: 'TodoWrite', description: 'Create/update a structured todo list to track multi-step work.', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }, activeForm: { type: 'string', description: 'Present-participle label while status is in_progress (e.g. "Running tests")' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] } } } } }, required: ['todos'] } },
  { name: 'Task', description: 'Spawn a sub-agent to complete a self-contained, multi-step task and return its result. Use for parallelizable or independent work. Multiple Task/Agent blocks in one message run concurrently. Supports subagent_type (general-purpose, Explore, Plan, Bash, verifier, code-reviewer, etc.), resume by agentId, fork_context, max_turns, tier/model pinning, run_in_background, team_name, and worktree isolation.', parameters: { type: 'object', properties: { description: { type: 'string', description: 'Short label (3–5 words)' }, prompt: { type: 'string', description: 'The full instructions for the sub-agent' }, subagent_type: { type: 'string', description: 'Agent type/persona, e.g. general-purpose, Explore, Plan, verifier, code-reviewer' }, model: { type: 'string', description: 'Optional model id to run this sub-agent on' }, tier: { type: 'string', enum: ['small', 'heavy', 'critical'], description: 'Optional complexity tier; picks the matching model from the provider pool' }, resume: { type: 'string', description: 'Agent ID from a prior Task/Agent call to resume with full conversation history preserved' }, fork_context: { type: 'boolean', description: 'Include condensed parent conversation context so the sub-agent inherits prior discoveries' }, max_turns: { type: 'number', description: 'Optional max tool-use turns for this sub-agent' }, run_in_background: { type: 'boolean', description: 'Run detached; returns an id and output_file for TaskOutput' }, name: { type: 'string', description: 'Teammate name for team coordination' }, team_name: { type: 'string', description: 'Team to join' }, mode: { type: 'string', description: 'Sub-agent permission mode' }, isolation: { type: 'string', enum: ['worktree'], description: 'Isolate in a git worktree' }, cwd: { type: 'string' } }, required: ['description', 'prompt'] } },
  { name: 'Agent', description: 'Spawn a sub-agent (alias of Task) to delegate a self-contained piece of work. Multiple Agent blocks in one message run concurrently.', parameters: { type: 'object', properties: { description: { type: 'string', description: 'Short label (3–5 words)' }, prompt: { type: 'string' }, subagent_type: { type: 'string' }, model: { type: 'string' }, tier: { type: 'string', enum: ['small', 'heavy', 'critical'] }, resume: { type: 'string', description: 'Agent ID from a prior Task/Agent call to resume with full conversation history preserved' }, fork_context: { type: 'boolean', description: 'Include condensed parent conversation context' }, max_turns: { type: 'number', description: 'Optional max tool-use turns for this sub-agent' }, run_in_background: { type: 'boolean', description: 'Run detached; returns an id and output_file for TaskOutput' }, name: { type: 'string' }, team_name: { type: 'string' }, mode: { type: 'string' }, isolation: { type: 'string', enum: ['worktree'] }, cwd: { type: 'string' } }, required: ['description', 'prompt'] } },
  { name: 'Swarm', description: 'Run a user-enabled supervisor-led team on FRONTIER models only. The supervisor decomposes the goal into subtasks, tags each with a complexity tier, every subtask runs CONCURRENTLY on a frontier model, then the supervisor reviews and merges the results into one answer. Use for large builds or any task that splits into independent parts.', parameters: { type: 'object', properties: { goal: { type: 'string', description: 'The overall objective for the team' }, tasks: { type: 'array', description: 'Optional explicit subtasks; omit to let the supervisor plan', items: { type: 'object', properties: { title: { type: 'string' }, prompt: { type: 'string' }, tier: { type: 'string', enum: ['small', 'heavy', 'critical'] }, model: { type: 'string' } } } }, concurrency: { type: 'number', description: 'Max subtasks running at once (default 4)' }, maxTasks: { type: 'number', description: 'Max subtasks the supervisor may create (default 6)' }, critique: { type: 'boolean', description: 'Run the supervisor review/merge step (default true)' }, cwd: { type: 'string' } }, required: ['goal'] } },
  { name: 'NotebookRead', description: 'Read the cells of a notebook by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'NotebookEdit', description: 'Edit a Jupyter notebook cell. Provide notebook_path and new_source. edit_mode: replace (default) | insert | delete. For insert, cell_id is the cell to insert AFTER (omit to insert at top); for delete, cell_id identifies the cell. Also accepts the legacy {name, cells} form to rewrite a stored notebook.', parameters: { type: 'object', properties: { notebook_path: { type: 'string', description: 'Path to the .ipynb file' }, cell_id: { type: 'string', description: 'Target cell id (for insert/replace/delete)' }, new_source: { type: 'string', description: 'New cell source' }, cell_type: { type: 'string', enum: ['code', 'markdown', 'raw'], description: 'Cell type (default code)' }, edit_mode: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Default replace' }, name: { type: 'string', description: 'Legacy: stored notebook name' }, cells: { type: 'array', description: 'Legacy: full cell list', items: { type: 'object', properties: { language: { type: 'string' }, source: { type: 'string' } } } } }, required: ['notebook_path'] } },
  { name: 'AskUserQuestion', description: 'Ask the user one or more structured questions and wait for the answers. Use when you need a decision, clarification, or choice before proceeding. Each question has a header and 2–4 options; the user may also type their own answer.', parameters: { type: 'object', properties: { questions: { type: 'array', description: 'Questions to ask', items: { type: 'object', properties: { question: { type: 'string' }, header: { type: 'string', description: 'Short label (max 12 chars)' }, options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } } }, multiSelect: { type: 'boolean' } } } }, answers: { type: 'object', description: 'Pre-filled answers keyed by question (optional)' }, annotations: { type: 'object', description: 'Arbitrary annotations returned alongside' }, metadata: { type: 'object', description: 'Free-form metadata' }, question: { type: 'string', description: 'Legacy: shorthand for a single question' }, options: { type: 'array', description: 'Legacy: shorthand options', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } } } } } } },
  { name: 'KillShell', description: 'Kill a running background shell or job by its id (shell_id/task_id).', parameters: { type: 'object', properties: { shell_id: { type: 'string', description: 'Background shell/job id' }, task_id: { type: 'string', description: 'Alias for shell_id' } }, required: ['shell_id'] } },
  { name: 'SlashCommand', description: 'Invoke a slash command by name (e.g. /help, /clear, /compact, /model, /review).', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'ExitPlanMode', description: 'Exit plan mode — present a plan for user approval before execution. Mark the tool call denied to stay in plan mode and refine the plan; approve it to leave plan mode and implement.', parameters: { type: 'object', properties: { plan: { type: 'string', description: 'The plan to execute, in markdown' }, allowedPrompts: { type: 'array', description: 'Prompt-based permissions the plan needs (e.g. run tests, install deps)', items: { type: 'object', properties: { tool: { type: 'string' }, prompt: { type: 'string' } } } } }, required: ['plan'] } },
  { name: 'Skill', description: 'Load the full instructions for a skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'ListMcpResources', description: 'List resources exposed by a connected MCP server.', parameters: { type: 'object', properties: { server: { type: 'string' } } } },
  { name: 'ReadMcpResource', description: 'Read a resource from a connected MCP server by URI.', parameters: { type: 'object', properties: { server: { type: 'string' }, uri: { type: 'string' } }, required: ['uri'] } },
  { name: 'memory_add', description: 'Persist a categorized, deduplicated fact/note to long-term memory.', parameters: { type: 'object', properties: { content: { type: 'string' }, category: { type: 'string', enum: ['architecture', 'build-test', 'style', 'pitfalls', 'workflow', 'general'] }, scope: { type: 'string', enum: ['user', 'project'] }, cwd: { type: 'string' } }, required: ['content'] } },
  { name: 'ExtractSkill', description: 'Persist a solved debugging/build workflow into a reusable SKILL.md (with triggers, steps, pitfalls, and verification).', parameters: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, triggers: { type: 'array', items: { type: 'string' } }, steps: { type: 'array', items: { type: 'string' } }, pitfalls: { type: 'array', items: { type: 'string' } }, verification: { type: 'string' }, content: { type: 'string' }, scope: { type: 'string', enum: ['user', 'project'] }, cwd: { type: 'string' } }, required: ['name'] } },
  { name: 'memory_list', description: 'List everything saved to long-term memory.', parameters: { type: 'object', properties: {} } },
  { name: 'memory_delete', description: 'Delete a memory entry by its index.', parameters: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] } },
  { name: 'list_skills', description: 'List available skills.', parameters: { type: 'object', properties: {} } },
  { name: 'list_notebooks', description: 'List available notebooks.', parameters: { type: 'object', properties: {} } },
  { name: 'list_slash_commands', description: 'List available slash commands.', parameters: { type: 'object', properties: {} } },
  { name: 'REPL', description: 'Run JavaScript in a persistent REPL session. Supports top-level await. State (variables, functions, imports) persists across calls within the session; `reset`/language may be set to start fresh.', parameters: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript to evaluate (top-level await allowed)' }, description: { type: 'string', description: 'What this snippet does (3–5 words)' }, timeout: { type: 'number', description: 'Timeout in ms (default 30000, max 600000)' }, language: { type: 'string', description: 'Language: javascript (default), python, or bash' }, reset: { type: 'boolean', description: 'Start a fresh session' }, cwd: { type: 'string' } }, required: ['code'] } },
  { name: 'JavaScript', description: 'Execute a JavaScript snippet with Node.js and return its stdout/stderr.', parameters: { type: 'object', properties: { code: { type: 'string' }, cwd: { type: 'string' } }, required: ['code'] } },
  { name: 'Cd', description: 'Change the current working directory for subsequent Bash/Read/Write/Glob/Grep tools.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'TaskStop', description: 'Stop a running background task, sub-agent, monitor or shell by its id.', parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'Id of the background task/agent to stop' }, shell_id: { type: 'string', description: 'Alias: id of a background shell to stop' }, name: { type: 'string', description: 'Legacy: sub-agent label to stop' } } } },
  { name: 'ListAgents', description: 'List currently running sub-agents/tasks.', parameters: { type: 'object', properties: {} } },
  { name: 'SendUserMessage', description: 'Send a message/notification to the user outside the normal assistant reply.', parameters: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
  { name: 'SetGoal', description: 'Set or update the current task/goal being worked on.', parameters: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
  { name: 'ToolSearch', description: 'Search the available tool surface by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'Artifact', description: "Create or update a named artifact that appears in the Artifacts panel and can open in its own window. `language` selects the renderer: html | svg | mermaid | react | markdown | text, plus the two canvas types — 'design' (a board of live artboards) and 'slides' (a navigable deck). For 'design' pass JSON: {\"title\":\"...\",\"artboards\":[{\"name\":\"Mobile\",\"width\":390,\"height\":844,\"html\":\"<div>…</div>\",\"notes\":\"…\"}]}. For 'slides' pass JSON: {\"title\":\"...\",\"slides\":[{\"title\":\"Intro\",\"html\":\"<p>…</p>\",\"bullets\":[\"…\"],\"notes\":\"speaker notes\"}]} (markdown separated by --- also works).", parameters: { type: 'object', properties: { name: { type: 'string' }, language: { type: 'string', description: 'html | svg | mermaid | react | markdown | text | design | slides' }, content: { type: 'string' } }, required: ['name', 'content'] } },
  { name: 'Jira', description: 'Interact with Jira (search/list/get/create issues) if JIRA_BASE_URL/JIRA_EMAIL/JIRA_API_TOKEN are configured.', parameters: { type: 'object', properties: { action: { type: 'string', description: 'search | get | create' }, jql: { type: 'string' }, issueKey: { type: 'string' }, project: { type: 'string' }, summary: { type: 'string' }, description: { type: 'string' } }, required: ['action'] } },
  { name: 'Linear', description: 'Interact with Linear (list/search issues) if LINEAR_API_KEY is configured.', parameters: { type: 'object', properties: { action: { type: 'string', description: 'issues | search' }, query: { type: 'string' } } } },
  { name: 'mcp__secrets__request_secret', description: '[secrets] Request a secret value (e.g. API key) by name from the secrets store.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ---- Virtual built-in MCP namespaces (mirror Claude Code's internal MCP tools 1:1) ----
  { name: 'mcp__workspace__bash', description: '[workspace] Run a shell command.', parameters: { type: 'object', properties: { command: { type: 'string' }, cwd: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
  { name: 'mcp__workspace__read_file', description: '[workspace] Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, file_path: { type: 'string', description: 'Alias for path' }, cwd: { type: 'string' } }, required: ['path'] } },
  { name: 'mcp__workspace__write_file', description: '[workspace] Write a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, cwd: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'mcp__workspace__edit_file', description: '[workspace] Edit a file (string replace).', parameters: { type: 'object', properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, cwd: { type: 'string' } }, required: ['path', 'old_string', 'new_string'] } },
  { name: 'mcp__workspace__glob', description: '[workspace] Glob for files.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'mcp__workspace__grep', description: '[workspace] Grep file contents.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, cwd: { type: 'string' } }, required: ['pattern'] } },
  { name: 'mcp__workspace__web_fetch', description: '[workspace] Fetch a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'mcp__terminal__list_terminal_tabs', description: '[terminal] List open terminal tabs.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__terminal__open_terminal_tab', description: '[terminal] Open a new terminal tab.', parameters: { type: 'object', properties: { cwd: { type: 'string' } } } },
  { name: 'mcp__terminal__read_terminal', description: '[terminal] Read output from a terminal tab.', parameters: { type: 'object', properties: { terminal_id: { type: 'string' } }, required: ['terminal_id'] } },
  { name: 'mcp__terminal__run_in_terminal', description: '[terminal] Run a command in a terminal tab.', parameters: { type: 'object', properties: { terminal_id: { type: 'string' }, command: { type: 'string' }, timeout: { type: 'number' } }, required: ['command'] } },
  { name: 'mcp__terminal__stop_terminal_tab', description: '[terminal] Stop and close a terminal tab.', parameters: { type: 'object', properties: { terminal_id: { type: 'string' } }, required: ['terminal_id'] } },
  { name: 'mcp__memory__memory_add', description: '[memory] Add to long-term memory.', parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } },
  { name: 'mcp__memory__memory_list', description: '[memory] List long-term memory.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__memory__memory_delete', description: '[memory] Delete a memory entry.', parameters: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] } },
  { name: 'mcp__skills__list_skills', description: '[skills] List available skills.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__skills__load_skill', description: '[skills] Load a skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ---- Visualize (charts) ----
  { name: 'mcp__visualize__visualize', description: '[visualize] Render a chart (bar/line/pie/scatter/area) from data as an SVG artifact.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'bar | line | pie | scatter | area' }, title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } }, data: { type: 'array', items: { type: 'number' } } } } },

  // ---- Computer Use ----
  { name: 'mcp__computer__screenshot', description: '[computer] Capture the screen to a PNG file and return its path/size.', parameters: { type: 'object', properties: { dir: { type: 'string' } } } },
  { name: 'mcp__computer__click', description: '[computer] Click at screen coordinates (x, y). button: left|right|middle.', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, double: { type: 'boolean' } }, required: ['x', 'y'] } },
  { name: 'mcp__computer__move', description: '[computer] Move the mouse to (x, y).', parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] } },
  { name: 'mcp__computer__drag', description: '[computer] Drag from (x1,y1) to (x2,y2).', parameters: { type: 'object', properties: { x1: { type: 'number' }, y1: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' } }, required: ['x1', 'y1', 'x2', 'y2'] } },
  { name: 'mcp__computer__scroll', description: '[computer] Scroll (direction: up|down|left|right).', parameters: { type: 'object', properties: { direction: { type: 'string' }, amount: { type: 'number' } } } },
  { name: 'mcp__computer__type', description: '[computer] Type text via keystroke.', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'mcp__computer__key', description: '[computer] Press a key chord (e.g. "cmd+c", "enter").', parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] } },
  { name: 'mcp__computer__screen_size', description: '[computer] Get the screen dimensions.', parameters: { type: 'object', properties: {} } },

  // ---- Chrome (CDP) ----
  { name: 'mcp__chrome__list_tabs', description: '[chrome] List open Chrome tabs (requires Chrome started with --remote-debugging-port=9222).', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__chrome__navigate', description: '[chrome] Navigate a Chrome tab to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' }, targetId: { type: 'string' } }, required: ['url'] } },
  { name: 'mcp__chrome__evaluate', description: '[chrome] Evaluate a JavaScript expression in a Chrome tab and return its value.', parameters: { type: 'object', properties: { expression: { type: 'string' }, targetId: { type: 'string' } }, required: ['expression'] } },
  { name: 'mcp__chrome__screenshot', description: '[chrome] Screenshot a Chrome tab (returns base64 PNG length).', parameters: { type: 'object', properties: { targetId: { type: 'string' } } } },

  // ---- Cowork orchestration ----
  { name: 'mcp__cowork__register_worker', description: '[cowork] Register a cowork worker (a sub-agent). Optionally pin it to its own model endpoint (baseURL + model + apiKey) and tier (small/heavy/critical) so different workers run on different backends (e.g. NVIDIA NIM vs local Ollama Gemma).', parameters: { type: 'object', properties: { name: { type: 'string' }, goal: { type: 'string' }, baseURL: { type: 'string', description: 'OpenAI-compatible base URL, e.g. https://integrate.api.nvidia.com/v1 or http://127.0.0.1:11434/v1' }, model: { type: 'string', description: 'Model id for this worker, e.g. nvidia/nemotron-3.5-bolt-e4b or gemma4:latest' }, apiKey: { type: 'string', description: 'API key for this worker (omit for local endpoints)' }, tier: { type: 'string', enum: ['small', 'heavy', 'critical'] }, supportsTools: { type: 'boolean' }, systemPrompt: { type: 'string' } }, required: ['name'] } },
  { name: 'mcp__cowork__list_workers', description: '[cowork] List registered cowork workers.', parameters: { type: 'object', properties: {} } },
  { name: 'mcp__cowork__orchestrate', description: '[cowork] Fan work out to named workers (sub-agents) in parallel and return their results. Pass a single `goal` shared by all workers, or `tasks` with a DISTINCT prompt per worker so each agent does different work. Each entry of `workers` may be a name or an object {name, baseURL, model, apiKey, tier} to run that worker on a specific backend for this call.', parameters: { type: 'object', properties: { goal: { type: 'string', description: 'Shared goal when every worker gets the same prompt' }, tasks: { type: 'array', description: 'Distinct per-worker work: [{worker?, name?, title?, prompt, tier?, model?}]', items: { type: 'object', properties: { worker: { type: 'string' }, name: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' }, tier: { type: 'string' }, model: { type: 'string' } } } }, workers: { type: 'array', items: { type: ['string', 'object'] }, description: 'Worker names, or {name, baseURL, model, apiKey, tier} objects' }, concurrency: { type: 'number' }, maxSteps: { type: 'number' } } } },
  { name: 'mcp__ccd_submit', description: '[ccd] Submit a task to the cloud cowork daemon (CCD) queue.', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'mcp__ccd_list', description: '[ccd] List tasks in the cloud cowork daemon (CCD) queue.', parameters: { type: 'object', properties: {} } },

  // ---- Bot bridges ----
  { name: 'mcp__botbridge__start', description: '[botbridge] Start the local bot-bridge webhook server (hearthbot/slackbot/teamsbot/webagent).', parameters: { type: 'object', properties: { port: { type: 'number' } } } },
  { name: 'mcp__botbridge__register', description: '[botbridge] Register a webhook route that forwards messages to a sub-agent bot.', parameters: { type: 'object', properties: { route: { type: 'string' }, method: { type: 'string' }, bot: { type: 'string' } }, required: ['route'] } },
  { name: 'mcp__bots__send', description: '[bots] Send a message to a connected bot bridge / notify the user.', parameters: { type: 'object', properties: { bot: { type: 'string' }, message: { type: 'string' } }, required: ['message'] } },

  // ---- Built-in Browser (in-app <webview> pane, mirrors Claude Desktop's browser) ----
  { name: 'browser_open', description: 'Open a URL in the built-in browser pane (in-app webview). Use for browsing the web visually.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_navigate', description: 'Navigate the built-in browser to a URL.', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_back', description: 'Go back in the built-in browser history.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_forward', description: 'Go forward in the built-in browser history.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_reload', description: 'Reload the current page in the built-in browser.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_stop', description: 'Stop loading the current page in the built-in browser.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_read', description: 'Read the visible text of the current page in the built-in browser.', parameters: { type: 'object', properties: {} } },
  { name: 'browser_snapshot', description: 'Snapshot the current page as a compact Accessibility Tree (@e1, @e2 refs) with automatic Set-of-Marks fallback for canvas/SVG widgets.', parameters: { type: 'object', properties: { compactAx: { type: 'boolean' }, som: { type: 'boolean' }, maxItems: { type: 'number' } } } },
  { name: 'browser_vault_autofill', description: 'Autofill origin-bound credentials and TOTP into the active browser page from the OS vault without exposing secrets in model context.', parameters: { type: 'object', properties: { origin: { type: 'string' }, selectors: { type: 'object' } } } },
  { name: 'browser_replay_skill', description: 'Deterministically replay a saved self-healing browser skill with zero LLM tokens.', parameters: { type: 'object', properties: { name: { type: 'string' }, skipStartUrl: { type: 'boolean' } }, required: ['name'] } },
  { name: 'browser_click', description: 'Click an element in the built-in browser by @e12 ref or CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, index: { type: 'number' } }, required: ['selector'] } },
  { name: 'browser_type', description: 'Type text into an element (input/textarea) in the built-in browser by @e12 ref or CSS selector.', parameters: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
  { name: 'browser_press', description: 'Press a key (e.g. "Enter", "Escape") in the built-in browser.', parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] } },
  { name: 'browser_js', description: 'Execute a JavaScript expression in the built-in browser page and return its value.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'browser_hover', description: 'Hover an element in the built-in browser by CSS selector (opens CSS/JS menus and tooltips).', parameters: { type: 'object', properties: { selector: { type: 'string' }, index: { type: 'number' } }, required: ['selector'] } },
  { name: 'browser_select', description: 'Choose an option in a <select> dropdown in the built-in browser, by option value or visible label.', parameters: { type: 'object', properties: { selector: { type: 'string' }, value: { type: 'string' } }, required: ['selector', 'value'] } },
  { name: 'browser_scroll', description: 'Scroll the built-in browser page (or a scrollable element) up/down/left/right by pixels.', parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number' }, selector: { type: 'string' } } } },
  { name: 'browser_wait_for', description: 'Wait until an element matching a CSS selector exists in the built-in browser (default 5s, max 30s).', parameters: { type: 'object', properties: { selector: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['selector'] } },
  { name: 'browser_screenshot', description: 'Capture a PNG screenshot of the built-in browser viewport (or the full page) and save it to a temp file.', parameters: { type: 'object', properties: { fullPage: { type: 'boolean' } } } },
  { name: 'browser_tabs', description: 'Manage built-in browser tabs: list open tabs, open a new tab, switch to a tab by index, or close a tab by index.', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'new', 'switch', 'close'] }, url: { type: 'string' }, index: { type: 'number' } }, required: ['action'] } },

  // ---- Plugins & Connectors directory ----
  { name: 'plugins__list_plugins', description: 'List available plugins and connectors, optionally filtered by type (connector|plugin), category, or installed-only.', parameters: { type: 'object', properties: { type: { type: 'string', description: 'connector | plugin' }, category: { type: 'string' }, installedOnly: { type: 'boolean' } } } },
  { name: 'plugins__search_plugins', description: 'Search the plugin directory by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'plugins__search_connectors', description: 'Search the connector (integration) directory by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'plugins__suggest_plugin_install', description: 'Suggest connectors/plugins worth installing for a user goal.', parameters: { type: 'object', properties: { goal: { type: 'string' }, limit: { type: 'number' } }, required: ['goal'] } },
  { name: 'plugins__install', description: 'Install a plugin or connector by id from the directory.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'plugins__uninstall', description: 'Uninstall a plugin or connector by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },

  // ---- MCP Registry ----
  { name: 'mcp-registry__list_connectors', description: 'List all connectors in the MCP registry (installed and available).', parameters: { type: 'object', properties: { installedOnly: { type: 'boolean' } } } },
  { name: 'mcp-registry__search_mcp_registry', description: 'Search the MCP registry for connectors by keyword.', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] } },
  { name: 'plugins__directory_stats', description: 'Report plugin/connector directory size, categories and live MCP registry status.', parameters: { type: 'object', properties: {} } },
  { name: 'plugins__refresh_registry', description: 'Refresh the connector list from the live Model Context Protocol registry.', parameters: { type: 'object', properties: { maxPages: { type: 'number' } } } },
  { name: 'mcp-registry__suggest_connectors', description: 'Suggest MCP connectors that match a described task or goal.', parameters: { type: 'object', properties: { goal: { type: 'string' }, limit: { type: 'number' } }, required: ['goal'] } },

  // ---- Scheduled tasks ----
  { name: 'scheduled-tasks__create_scheduled_task', description: 'Create a scheduled task that runs a prompt on a cadence (once | every | hourly | daily | weekly).', parameters: { type: 'object', properties: { name: { type: 'string' }, prompt: { type: 'string' }, cadence: { type: 'string', enum: ['once', 'every', 'hourly', 'daily', 'weekly'] }, at: { type: 'string', description: 'ISO time for cadence=once' }, everyMinutes: { type: 'number' }, time: { type: 'string', description: 'HH:MM for daily/weekly' }, dayOfWeek: { type: 'number', description: '0=Sunday for weekly' }, enabled: { type: 'boolean' } }, required: ['prompt'] } },
  { name: 'scheduled-tasks__list_scheduled_tasks', description: 'List all scheduled tasks with their next run time.', parameters: { type: 'object', properties: {} } },
  { name: 'scheduled-tasks__update_scheduled_task', description: 'Update a scheduled task (name, prompt, cadence, schedule, or enabled).', parameters: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, cadence: { type: 'string' }, at: { type: 'string' }, everyMinutes: { type: 'number' }, time: { type: 'string' }, dayOfWeek: { type: 'number' }, enabled: { type: 'boolean' } }, required: ['id'] } },
  { name: 'scheduled-tasks__delete_scheduled_task', description: 'Delete a scheduled task by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'scheduled-tasks__run_scheduled_task', description: 'Run a scheduled task immediately, without waiting for its next fire time.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },

  // ---- Custom skill authoring ----
  { name: 'create_skill', description: 'Create a new custom skill from Markdown content (the model writes a SKILL.md-style document with name/description frontmatter).', parameters: { type: 'object', properties: { name: { type: 'string' }, content: { type: 'string', description: 'Full Markdown skill document' } }, required: ['name', 'content'] } },
  { name: 'delete_skill', description: 'Delete a custom skill by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ---- Creator Mode: hot-swappable custom runtime tools (DeepSeek Harness parity) ----
  { name: 'CreateCustomTool', description: 'Create and immediately register a reusable runtime tool (node, bash, or python3). The tool receives JSON args on stdin and in env TOOL_ARGS_JSON, and becomes callable on the very next step.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Lowercase identifier ^[a-z][a-z0-9_]{2,48}$' }, description: { type: 'string' }, runtime: { type: 'string', enum: ['node', 'bash', 'python3'] }, parameters: { type: 'object', description: 'JSON Schema object for tool arguments' }, script: { type: 'string', description: 'Executable source code' }, timeoutMs: { type: 'number' } }, required: ['name', 'description', 'script'] } },
  { name: 'ListCustomTools', description: 'List all saved custom runtime tools.', parameters: { type: 'object', properties: {} } },
  { name: 'DeleteCustomTool', description: 'Delete a saved custom runtime tool by name.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },

  // ---- External Browser Control (Akron Browser Bot Chrome Extension) ----
  {
    name: 'ext_browser',
    description: 'Control the user\'s live external Chrome/Brave/Edge browser via the Akron Browser Bot extension (list_tabs, navigate, read_page, read_text, find, click, type, press_key, scroll, form_input, screenshot, read_console_messages, read_network_requests, execute_javascript).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: 'Extension tool name, e.g. list_tabs, navigate, read_page, read_text, find, click, type, press_key, scroll, form_input, screenshot, execute_javascript' },
        tabId: { type: 'number', description: 'Optional Chrome tab id' },
        args: { type: 'object', description: 'Optional arguments object passed to the extension tool' },
        url: { type: 'string' },
        ref: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        key: { type: 'string' },
        expression: { type: 'string' },
      },
      required: ['action'],
    },
  },

  // ---- Built-in REA (`https://github.com/morluto/rea`, rea-agents 263 MCP tools & CLI) ----
  {
    name: 'rea',
    description: 'Built-in Reverse Engineer Anything (morluto/rea): search or invoke all 263 REA MCP tools (native binaries, Electron/ASAR/JS bundles, Android APKs, Apple bundles, firmware, PCAP/HAR captures, decompile, audit_release_exposure) or run the REA CLI.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'search', 'call', 'cli', 'doctor'], description: 'Action to run (default: search if query given, call if tool given, cli if command given, else status)' },
        query: { type: 'string', description: 'Keywords to search across 263 REA tools (activates matches for direct mcp__rea__* calls)' },
        tool: { type: 'string', description: 'Exact REA MCP tool name to call (e.g. "analyze_javascript_application", "open_binary", "inspect_artifact", "audit_release_exposure", "decompile")' },
        arguments: { type: 'object', description: 'Arguments object for action="call"' },
        command: { description: 'CLI arguments array or string for one-shot REA CLI (e.g. ["analyze-javascript-application", "/abs/path", "--json"])' },
        cwd: { type: 'string' },
      },
    },
  },

  // ---- Example-parity surface (see parity.js / parity-defs.js) ----
  ...require('./parity-defs'),
];

// Map tool name -> executor. Names are case-sensitive per above.
const executorsByTool = {
  Bash: 'bash',
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'multi_edit',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
  TodoWrite: 'todo_write',
  NotebookRead: 'notebook_read',
  NotebookEdit: 'notebook_edit',
  Skill: 'skill',
  SlashCommand: 'slash_command',
  KillShell: 'kill_shell',
  memory_add: 'memory_add',
  ExtractSkill: 'extract_skill',
  memory_list: 'memory_list',
  memory_delete: 'memory_delete',
  list_skills: 'list_skills',
  load_skill: 'load_skill',
  list_notebooks: 'list_notebooks',
  list_slash_commands: 'list_slash_commands',
  JavaScript: 'javascript',
  REPL: 'repl',
  ApplyPatch: 'apply_patch',
  ShadowCheck: 'shadow_check',
  CodebaseSearch: 'codebase_search',
  RunToolScript: 'run_tool_script',
  ToolSearch: 'tool_search',
  Jira: 'jira',
  Linear: 'linear',

  // ---- Virtual built-in MCP namespaces (reuse existing executors) ----
  mcp__workspace__bash: 'bash',
  mcp__workspace__read_file: 'read_file',
  mcp__workspace__write_file: 'write_file',
  mcp__workspace__edit_file: 'edit_file',
  mcp__workspace__glob: 'glob',
  mcp__workspace__grep: 'grep',
  mcp__workspace__web_fetch: 'web_fetch',
  mcp__memory__memory_add: 'memory_add',
  mcp__memory__memory_list: 'memory_list',
  mcp__memory__memory_delete: 'memory_delete',
  mcp__skills__list_skills: 'list_skills',
  mcp__skills__load_skill: 'load_skill',

  // ---- Computer Use / Chrome ----
  mcp__computer__screenshot: 'computer_screenshot',
  mcp__computer__click: 'computer_click',
  mcp__computer__move: 'computer_move',
  mcp__computer__drag: 'computer_drag',
  mcp__computer__scroll: 'computer_scroll',
  mcp__computer__type: 'computer_type',
  mcp__computer__key: 'computer_key',
  mcp__computer__screen_size: 'computer_screen_size',
  mcp__chrome__list_tabs: 'chrome_list_tabs',
  mcp__chrome__navigate: 'chrome_navigate',
  mcp__chrome__evaluate: 'chrome_evaluate',
  mcp__chrome__screenshot: 'chrome_screenshot',

  // ---- Built-in Browser ----
  browser_open: 'browser_open',
  browser_navigate: 'browser_navigate',
  browser_back: 'browser_back',
  browser_forward: 'browser_forward',
  browser_reload: 'browser_reload',
  browser_stop: 'browser_stop',
  browser_read: 'browser_read',
  browser_snapshot: 'browser_snapshot',
  browser_vault_autofill: 'browser_vault_autofill',
  browser_replay_skill: 'browser_replay_skill',
  browser_click: 'browser_click',
  browser_type: 'browser_type',
  browser_press: 'browser_press',
  browser_js: 'browser_js',

  // ---- Plugins / MCP registry / scheduled tasks / custom skills ----
  plugins__list_plugins: 'plugins_list_plugins',
  plugins__search_plugins: 'plugins_search_plugins',
  plugins__search_connectors: 'plugins_search_connectors',
  plugins__suggest_plugin_install: 'plugins_suggest_plugin_install',
  plugins__install: 'plugins_install',
  plugins__uninstall: 'plugins_uninstall',
  'mcp-registry__list_connectors': 'mcp_registry_list_connectors',
  'mcp-registry__search_mcp_registry': 'mcp_registry_search_mcp_registry',
  'mcp-registry__suggest_connectors': 'mcp_registry_suggest_connectors',
  plugins__directory_stats: 'plugins_directory_stats',
  plugins__refresh_registry: 'plugins_refresh_registry',
  'scheduled-tasks__create_scheduled_task': 'scheduled_tasks_create_scheduled_task',
  'scheduled-tasks__list_scheduled_tasks': 'scheduled_tasks_list_scheduled_tasks',
  'scheduled-tasks__update_scheduled_task': 'scheduled_tasks_update_scheduled_task',
  'scheduled-tasks__delete_scheduled_task': 'scheduled_tasks_delete_scheduled_task',
  'scheduled-tasks__run_scheduled_task': 'scheduled_tasks_run_scheduled_task',
  create_skill: 'create_skill',
  delete_skill: 'delete_skill',
};

function fileHead(fp, raw, lines) {
  const head = raw.split('\n').slice(0, lines || 60).map((l, i) => String(i + 1).padStart(4) + '| ' + l).join('\n');
  return `First ${lines || 60} lines of ${path.basename(fp)}:\n${head}`;
}

// Claude Code's file tools use `file_path` / `file_text`; other models copy
// that convention. Accepting it here means a Example-shaped Write from any
// backend actually lands on disk instead of "path argument required".
const FILE_TOOLS = new Set([
  'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
  'mcp__workspace__write_file', 'mcp__workspace__edit_file', 'write_file', 'edit_file',
]);
const FILE_ARG_ALIASES = {
  path: ['file_path', 'filePath', 'filename', 'file'],
  content: ['file_text', 'contents'],
  old_string: ['old_str', 'oldString'],
  new_string: ['new_str', 'newString'],
};
function normalizeFileArgs(args) {
  for (const [canonical, aliases] of Object.entries(FILE_ARG_ALIASES)) {
    if (args[canonical] !== undefined && args[canonical] !== null && args[canonical] !== '') continue;
    for (const alias of aliases) {
      if (args[alias] !== undefined && args[alias] !== null && args[alias] !== '') {
        args[canonical] = args[alias];
        break;
      }
    }
  }
  // MultiEdit payloads arrive as `edits: [{old_string,new_string}]` — same aliasing.
  if (Array.isArray(args.edits)) args.edits.forEach((e) => { if (e && typeof e === 'object') normalizeFileArgs(e); });
  return args;
}

// A tool that never resolves used to freeze the whole run forever: the spinner
// kept ticking, the composer stayed locked and no result ever arrived. Example's
// tools fail fast and let the model recover, so give every executor a deadline.
const LONG_RUNNING = new Set([
  'Task', 'Agent', 'Swarm', 'mcp__cowork__orchestrate', 'mcp__botbridge__register',
  'mcp__ccd_submit', 'mcp__bots__send', 'mcp__visualize__visualize',
  // Example's own long-lived tools: a Workflow script can run for minutes, a
  // Monitor blocks up to an hour, TaskOutput waits on a background task, and a
  // REPL evaluation can take 10 minutes.
  'Workflow', 'Monitor', 'TaskOutput', 'REPL', 'RemoteTrigger',
]);
function toolTimeoutMs(name, args) {
  if (LONG_RUNNING.has(name)) return 30 * 60 * 1000;
  // Bash enforces its own (ms) timeout and kills the process group; give it
  // 10s of grace so its own message wins.
  if (name === 'Bash' || name === 'mcp__workspace__bash') return Math.min(clampBashTimeout(args && args.timeout) + 10000, 610000);
  if (name === 'mcp__terminal__run_in_terminal') return 130 * 1000;
  if (name === 'browser_wait_for') return 45 * 1000;
  if (/^browser_/.test(name)) return 30 * 1000;
  if (name === 'WebFetch') return 60 * 1000;
  return 5 * 60 * 1000;
}
function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      content: `Tool error: ${label} did not respond within ${Math.round(ms / 1000)}s and was abandoned. The run continues — retry with a narrower or simpler call.`,
      isError: true,
      timedOut: true,
    }), ms);
  });
  return Promise.race([Promise.resolve(promise), guard]).finally(() => clearTimeout(timer));
}

/**
 * Run a built-in tool. Never throws for a tool failure: any exception becomes
 * { content: 'Tool error: …', isError: true } so the model can recover. Only an
 * abort (ctx.signal aborted) propagates.
 * @param {string} name tool name
 * @param {object} args tool arguments
 * @param {object} ctx optional context: { cwd, shell, askUser, runSubagent, exitPlanMode, mcpListResources, mcpReadResource, signal, checkDeny, approveTool, ... }
 */
async function runTool(name, args, ctx) {
  ctx = ctx || {};
  try {
    return await runToolInner(name, args, ctx);
  } catch (e) {
    if (ctx.signal && ctx.signal.aborted) throw e;
    return { content: 'Tool error: ' + (e && e.message ? e.message : String(e)), isError: true };
  }
}

// ctx.checkDeny(name, args) → falsy to proceed; true / 'reason' / { reason } /
// { decision: 'deny', reason } to block. Applies to EVERY tool, read-only ones
// included (settings.json `deny: ["Read(./.env)"]`).
function denyReason(v) {
  if (!v) return null;
  if (v === true) return 'denied by permission rules';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') {
    if (v.decision && v.decision !== 'deny') return null;
    if (v.deny === false || v.denied === false) return null;
    return v.reason || (v.rule ? `Denied by rule ${v.rule}` : 'denied by permission rules');
  }
  return null;
}

async function runToolInner(name, args, ctx) {
  // A provider that mangled the tool arguments used to look like a generic
  // "Unknown tool"/"path required" error, which made models give up and fall
  // back to bash heredocs. Tell them exactly what went wrong so they retry
  // with clean JSON.
  if (args && args._parse_error) {
    return {
      content: `Error: could not parse arguments for ${name}: ${args._parse_error}. Re-send the call with a single valid JSON object of arguments (no wrapping string, no arrays). Raw: ${String(args._raw == null ? '' : args._raw).slice(0, 300)}`,
      isError: true,
    };
  }
  const { shell, askUser, runSubagent, exitPlanMode, mcpListResources, mcpReadResource, setCwd, listAgents, stopTask, sendUserMessage, setGoal, createArtifact, requestSecret, approveTool } = ctx;

  if (typeof ctx.checkDeny === 'function') {
    const why = denyReason(await ctx.checkDeny(name, args || {}));
    if (why) return { content: `Blocked: ${name} — ${why}.`, isError: true, denied: true };
  }

  // B8 Claude Code mode: require user approval before mutating tools.
  const MUTATING = new Set([
    'Bash', 'Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'ExtractSkill', 'RunToolScript', 'NotebookEdit', 'JavaScript', 'REPL',
    'KillShell', 'Jira', 'Linear', 'POST', 'CreateCustomTool', 'DeleteCustomTool',
    'mcp__workspace__write_file', 'mcp__workspace__edit_file',
    'mcp__terminal__run_in_terminal', 'mcp__terminal__open_terminal_tab',
  ]);
  // Any MCP tool whose name implies a state change is gated too, and every
  // Computer Use tool is gated regardless of whether it mutates: a screenshot
  // reads the user's screen, so read-only is not the same as harmless. The
  // model calls them as `mcp__computer__*`, so gate on the resolved executor
  // name as well as the raw one. The consent tier itself is enforced in
  // main.js's approveTool.
  const isMutatingTool = (name) => {
    const exec = executorsByTool[name] || name;
    return MUTATING.has(name) ||
      /^computer_/.test(exec) ||
      (/^mcp__/.test(name) && /(write|edit|create|delete|remove|run|exec|move|rename|upload|patch)/i.test(name));
  };
  if (approveTool && isMutatingTool(name)) {
    const verdict = await approveTool(name, args);
    const ok = typeof verdict === 'boolean' ? verdict : !!(verdict && (verdict.allow ?? verdict.approved));
    if (!ok) {
      const fb = verdict && typeof verdict === 'object' && verdict.feedback ? String(verdict.feedback).trim() : '';
      const msg = fb
        ? `User declined this tool call (${name}) with guidance: ${fb}`
        : `Blocked: permission not granted for ${name} (denied or disallowed in the current permission mode).`;
      return { content: msg, isError: true, denied: true, feedback: fb || undefined };
    }
  }

  // Special tools handled via context
  if (name === 'Task' || name === 'Agent') {
    if (!runSubagent) return 'Sub-agents unavailable (no subagent runner).';
    // Example's AgentInput.run_in_background: the agent keeps working after the
    // tool call returns, and the model polls it with TaskOutput / stops it with
    // TaskStop. Same job registry as background shells and monitors.
    if (args && args.run_in_background) {
      const label = args.description || args.name || 'sub-agent';
      const agentsDir = path.join(os.homedir(), '.autobot', 'agents');
      try { fs.mkdirSync(agentsDir, { recursive: true }); } catch (_) {}
      const emitFn = typeof ctx.emit === 'function' ? ctx.emit : (() => {});
      let jobRef = null;
      let outputFile = '';
      const job = bg.startAgent({
        label,
        description: args.description,
        model: args.model || args.tier || null,
        // TaskStop aborts the signal; runSubagent honours args.signal as an
        // extra parent signal.
        run: async (signal) => {
          await Promise.resolve();
          const id = jobRef ? jobRef.id : ('bg_' + Date.now().toString(36));
          outputFile = outputFile || path.join(agentsDir, `${id}.txt`);
          try {
            const res = await runSubagent({ ...args, run_in_background: false, signal });
            const outText = res == null ? '(completed with no text output)' : String(res);
            try { fs.writeFileSync(outputFile, outText, 'utf8'); } catch (_) {}
            emitFn({ type: 'subagent', id, name: label, status: 'done', role: 'worker', background: true });
            emitFn({ type: 'notice', text: `Background agent "${label}" (${id}) finished.` });
            return outText;
          } catch (e) {
            const errText = 'Error: ' + (e && e.message ? e.message : String(e));
            try { fs.writeFileSync(outputFile, errText, 'utf8'); } catch (_) {}
            emitFn({ type: 'subagent', id, name: label, status: 'error', role: 'worker', background: true });
            throw e;
          }
        },
      });
      jobRef = job;
      outputFile = path.join(agentsDir, `${job.id}.txt`);
      job.outputFile = outputFile;
      emitFn({ type: 'subagent', id: job.id, name: label, status: 'started', role: 'worker', background: true });
      return `Started background agent "${label}" (${job.id}). output_file: ${outputFile}\nPoll it with TaskOutput({task_id:"${job.id}"}) (optionally block:true) or stop it with TaskStop({task_id:"${job.id}"}).`;
    }
    const subOut = await withTimeout(runSubagent(args), toolTimeoutMs(name, args), name);
    return (subOut == null || subOut === '') ? '(sub-agent completed with no text output)' : subOut;
  }
  if (name === 'Swarm') {
    if (!ctx.runAgent) return 'Swarm unavailable (no agent runner wired).';
    const goal = args.goal || args.objective || args.task || '';
    if (!goal) return 'Error: goal required.';
    try {
      const out = await withTimeout(swarm.swarm(String(goal), {
        runAgent: ctx.runAgent,
        provider: ctx.provider,
        orchestrator: ctx.orchestrator,
        emit: ctx.emit || (() => {}),
        tasks: Array.isArray(args.tasks) && args.tasks.length ? args.tasks : undefined,
        concurrency: Math.min(Number(args.concurrency) || 4, 8),
        maxTasks: Number(args.maxTasks) || 6,
        signal: ctx.signal,
        poolOrchestrator: ctx.poolOrchestrator,
        depth: ctx.depth,
        critique: args.critique !== false,
        cwd: args.cwd || ctx.cwd,
        maxSteps: Number(args.maxSteps) || 0,
      }), toolTimeoutMs(name, args), name);
      if (out && out.timedOut) return out;
      const table = out.results
        .map((r) => `- ${r.title} — ${r.tier} · ${r.model || 'model'} · ${r.status} (${r.ms}ms)`)
        .join('\n');
      // The board is how workers coordinated; a short tail of it is the cheapest
      // way for the lead to see who handed off what (and who needed a re-brief).
      const posts = Array.isArray(out.board) ? out.board : [];
      const feed = posts.length
        ? `\n\nBOARD (${posts.length} messages)\n` + posts.slice(-12)
          .map((m) => `- #${m.seq} ${m.from}${m.to ? ' → @' + m.to : ''}: ${String(m.text).replace(/\s+/g, ' ').slice(0, 160)}`)
          .join('\n')
        : '';
      return `SWARM COMPLETE — ${out.results.length} agents, supervisor ${out.supervisor.model}, ${Math.round(out.ms / 1000)}s\n\nROSTER\n${table}${feed}\n\nFINAL ANSWER\n${out.answer}`;
    } catch (e) {
      if (ctx.signal && ctx.signal.aborted) throw e;
      return 'Swarm error: ' + (e && e.message ? e.message : String(e));
    }
  }
  if (name === 'AskUserQuestion') {
    if (!askUser) return 'Error: interactive questions unavailable.';
    return await askUser(args);
  }
  if (name === 'ExitPlanMode') {
    if (!exitPlanMode) return 'Plan approval unavailable.';
    return await exitPlanMode(args);
  }
  if (name === 'KillShell') {
    const id = args.shell_id || args.task_id || args.id;
    if (bg && id && bg.getJob(id)) {
      const ok = bg.stopJob(id);
      return ok ? `Killed background shell ${id}.` : `Could not kill background shell ${id}.`;
    }
    if (!shell) return 'Error: no shell manager.';
    return shell.kill(id) ? `Killed shell ${id}.` : `No shell with id "${id}".`;
  }
  if (name === 'ListMcpResources') {
    if (!mcpListResources) return 'No MCP resources available.';
    return await mcpListResources(args.server);
  }
  if (name === 'ReadMcpResource') {
    if (!mcpReadResource) return 'MCP resource reading unavailable.';
    return await mcpReadResource(args.server, args.uri);
  }
  if (name === 'Cd') {
    const p = args.path || args.dir || '.';
    const newCwd = resolvePath(p, ctx.cwd || process.cwd());
    try {
      if (!fs.statSync(newCwd).isDirectory()) return `Not a directory: ${newCwd}`;
    } catch {
      return `Directory does not exist: ${newCwd}`;
    }
    if (setCwd) setCwd(newCwd);
    return `Changed working directory to ${newCwd}`;
  }
  if (name === 'TaskStop' || name === 'StopTask') {
    const want = args.task_id || args.shell_id || args.id || args.name || args.description || '';
    if (bg && want && bg.getJob(want)) {
      const ok = bg.stopJob(want);
      return ok ? `Stopped background task ${want}.` : `Could not stop background task ${want}.`;
    }
    if (!stopTask) return 'Task stopping unavailable.';
    return stopTask(args.name || args.description || want);
  }
  if (name === 'ListAgents') {
    if (!listAgents) return '(no agents running)';
    return listAgents();
  }
  if (name === 'SendUserMessage') {
    const text = args.message || args.text || args.content || '';
    if (sendUserMessage) sendUserMessage(text);
    return 'Message sent to user.';
  }
  if (name === 'SetGoal') {
    const goal = args.goal || args.text || '';
    if (setGoal) setGoal(goal);
    return 'Goal updated.';
  }
  if (name === 'ToolSearch') {
    const q = String((args && (args.query || args.q)) || '').toLowerCase();
    const matches = toolDefinitions.filter(
      (t) => !q || t.name.toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q)
    );
    if (!matches.length) return '(no matching tools)';
    const top = matches.slice(0, 10);
    if (typeof ctx.activateTools === 'function') {
      try { ctx.activateTools(top.map((t) => t.name)); } catch (_) {}
    }
    return 'TOOLS (now active and callable):\n' + top.map((t) => `- ${t.name}: ${t.description}\n  parameters: ${JSON.stringify(t.parameters || {})}`).join('\n');
  }
  if (name === 'CreateCustomTool') {
    try {
      const spec = customtools.saveTool(args, { toolDefinitions, executorsByTool, executors });
      if (typeof ctx.activateTools === 'function') {
        try { ctx.activateTools([spec.name]); } catch (_) {}
      }
      return `Created and activated custom tool "${spec.name}" (${spec.runtime}). You can call ${spec.name} directly on the next step.`;
    } catch (e) {
      return { content: 'Error creating custom tool: ' + e.message, isError: true };
    }
  }
  if (name === 'ListCustomTools') {
    const list = customtools.listTools();
    return list.length
      ? 'CUSTOM TOOLS:\n' + list.map((t) => `- ${t.name} [${t.runtime}]: ${t.description}`).join('\n')
      : '(no custom tools registered)';
  }
  if (name === 'DeleteCustomTool') {
    const r = customtools.deleteTool(args && args.name, { toolDefinitions, executorsByTool, executors });
    return r.ok ? (r.deleted ? `Deleted custom tool "${r.name}".` : `No custom tool "${r.name}" found.`) : { content: 'Error: ' + r.error, isError: true };
  }
  if (name === 'Artifact') {
    if (!createArtifact) return 'Artifact creation unavailable.';
    return createArtifact(args);
  }
  if (name === 'mcp__secrets__request_secret') {
    if (!requestSecret) return 'No secrets store configured. Ask the user to provide the secret directly.';
    return await requestSecret(args.name || '');
  }

  // ---- Example-parity tools (parity.js owns LS/Search/task board/teams/
  // Workflow/plan mode/worktrees/Mcp/cron/monitor/notify/etc). Returns null
  // when the name is not one of ours, so normal dispatch continues.
  {
    const handled = await parity.handle(name, args, ctx);
    if (handled != null) return handled;
  }

  // ---- Virtual terminal MCP namespace (mirrors Claude Code's mcp__terminal__*) ----
  if (name === 'mcp__terminal__list_terminal_tabs') {
    if (!shell) return 'No shell manager available.';
    const tabs = await shell.list();
    return tabs.length ? 'TERMINAL TABS:\n' + tabs.map((t) => `- ${t.id} [${t.running ? 'running' : 'exited'}] (${t.cwd})`).join('\n') : '(no terminal tabs)';
  }
  if (name === 'mcp__terminal__open_terminal_tab') {
    if (!shell) return 'No shell manager available.';
    const t = shell.start({ cwd: resolveDir(args.cwd || ctx.cwd) });
    return `Opened terminal tab "${t.id}" in ${t.cwd}.`;
  }
  if (name === 'mcp__terminal__read_terminal') {
    if (!shell) return 'No shell manager available.';
    const id = args.terminal_id || args.id;
    const out = shell.read(id);
    return out || '(no output)';
  }
  if (name === 'mcp__terminal__run_in_terminal') {
    if (!shell) return 'No shell manager available.';
    const id = args.terminal_id || args.id;
    try {
      const out = await shell.run(id, args.command, { timeoutMs: Math.min(Number(args.timeout) || 60, 120) * 1000 });
      return out;
    } catch (e) {
      return 'Terminal error: ' + e.message;
    }
  }
  if (name === 'mcp__terminal__stop_terminal_tab') {
    if (!shell) return 'No shell manager available.';
    const id = args.terminal_id || args.id;
    return shell.kill(id) ? `Stopped terminal tab "${id}".` : `No terminal tab with id "${id}".`;
  }

  // ---- Visualize (charts) ----
  if (name === 'mcp__visualize__visualize') {
    const chart = visualize.render(args);
    if (createArtifact) createArtifact({ name: chart.title || 'chart', language: 'svg', content: chart.svg });
    return `Rendered ${chart.type} chart "${chart.title}" as an SVG artifact (${chart.svg.length} chars).`;
  }

  // ---- Cowork orchestration (needs agent runner + provider) ----
  if (name === 'mcp__cowork__register_worker') {
    if (!ctx.runAgent) return 'Cowork unavailable (no agent runner wired).';
    if (!args.name) return 'Error: worker name required.';
    const w = cowork.registerWorker(args.name, {
      runAgent: ctx.runAgent,
      provider: ctx.provider,
      goal: args.goal || '',
      baseURL: args.baseURL,
      model: args.model,
      apiKey: args.apiKey,
      tier: args.tier,
      supportsTools: args.supportsTools,
      systemPrompt: args.systemPrompt,
    });
    const pin = w.model ? ` pinned to ${w.model} @ ${w.baseURL}` : ' (uses the active provider)';
    return `Registered cowork worker "${args.name}"${pin}${w.tier ? ' [' + w.tier + ' tier]' : ''}.`;
  }
  if (name === 'mcp__cowork__list_workers') {
    const ws = cowork.listWorkers();
    return ws.length
      ? 'COWORK WORKERS:\n' + ws.map((w) => `- ${w.name} [${w.status}]${w.model ? ' ' + w.model + ' @ ' + w.baseURL : ''}${w.goal ? ' goal="' + w.goal + '"' : ''}`).join('\n')
      : '(no cowork workers registered)';
  }
  if (name === 'mcp__cowork__orchestrate') {
    if (!ctx.runAgent) return 'Cowork unavailable (no agent runner wired).';
    const hasTasks = Array.isArray(args.tasks) && args.tasks.length;
    if (!args.goal && !hasTasks) return 'Error: goal (or tasks) required.';
    const results = await cowork.orchestrate(args.goal || '', args.workers, {
      runAgent: ctx.runAgent,
      provider: ctx.provider,
      orchestrator: ctx.orchestrator,
      poolOrchestrator: ctx.poolOrchestrator,
      tasks: hasTasks ? args.tasks : undefined,
      concurrency: Number(args.concurrency) || 4,
      maxSteps: Number(args.maxSteps) || 0,
      emit: ctx.emit,
      signal: ctx.signal,
    });
    const lines = results.map((r) => {
      const who = r.provider ? `${r.title || r.name} (${r.provider.model} @ ${r.provider.baseURL})` : (r.title || r.name);
      return `--- ${who} [${r.tier || 'n/a'}${r.status ? ', ' + r.status : ''}${r.ms != null ? ', ' + r.ms + 'ms' : ''}] ---\n${r.result}`;
    });
    return 'ORCHESTRATION RESULTS:\n' + lines.join('\n\n') + '\n\n(JSON)\n' + JSON.stringify(results, null, 2);
  }

  // ---- CCD (cloud cowork daemon) ----
  if (name === 'mcp__ccd_submit') {
    const e = cowork.ccdSubmit(args.task || args.goal || '');
    return `CCD task queued (id=${e.id}).`;
  }
  if (name === 'mcp__ccd_list') {
    const q = cowork.ccdList();
    return q.length
      ? 'CCD QUEUE:\n' + q.map((t) => `- [${t.id}] ${t.status}: ${t.task}`).join('\n')
      : '(CCD queue empty)';
  }

  // ---- Bot bridges ----
  if (name === 'mcp__botbridge__start') {
    const r = await cowork.startBridge(Number(args.port) || 0);
    return `Bot bridge running at ${r.url}${r.alreadyRunning ? ' (already running)' : ''}.`;
  }
  if (name === 'mcp__botbridge__register') {
    if (!ctx.runAgent) return 'Bot bridge requires an agent runner.';
    if (!args.route) return 'Error: route required.';
    cowork.registerBridge(args.route, args.method, async ({ body }) => {
      const msg = (body && (body.message || body.text || body.prompt)) || JSON.stringify(body || {});
      const out = await ctx.runAgent({ messages: [{ role: 'user', content: String(msg) }], maxSteps: 0 });
      const last = [...out].reverse().find((m) => m.role === 'assistant' && m.content);
      return { reply: last ? last.content : '(bot completed)' };
    });
    return `Registered bot bridge route ${(args.method || 'POST').toUpperCase()} ${args.route}.`;
  }
  if (name === 'mcp__bots__send') {
    const bot = args.bot || args.channel || 'user';
    const text = args.message || args.text || '';
    if (sendUserMessage) sendUserMessage(`${bot && bot !== 'user' ? '[' + bot + '] ' : ''}${text}`);
    return `Message sent to ${bot}.`;
  }

  if (name === 'ext_browser') {
    try {
      const bridge = require('./extbridge');
      const action = String((args && (args.action || args.tool)) || '').trim();
      if (!action) return { content: 'ext_browser requires `action` (e.g. list_tabs, navigate, read_page, read_text, click, type).', isError: true };
      const { action: _a, tool: _t, tabId: rawTab, args: nested, cwd: _c, ...rest } = args || {};
      const mergedArgs = { ...(nested && typeof nested === 'object' ? nested : {}), ...rest };
      const tabId = Number.isInteger(rawTab) ? rawTab : undefined;
      const out = await bridge.callTool(action, mergedArgs, tabId);
      const textOut = (out && typeof out === 'object' && typeof out.text === 'string')
        ? out.text
        : (typeof out === 'string' ? out : JSON.stringify(out, null, 2));
      if (/^(read_|find|list_tabs|execute_javascript)/.test(action)) {
        return untrusted.wrapUntrusted(textOut, { source: `ChromeBot:${action}` });
      }
      return textOut;
    } catch (e) {
      return { content: 'External browser error: ' + String((e && e.message) || e), isError: true };
    }
  }

  if (name === 'rea') {
    const reaMod = require('./rea');
    const getReaClient = () => {
      if (ctx.mcpClient) return ctx.mcpClient;
      if (!runTool._fallbackReaClient) {
        const { MCPClient } = require('./mcp');
        runTool._fallbackReaClient = new MCPClient();
      }
      return runTool._fallbackReaClient;
    };
    const a = args || {};
    const inferredAction = a.action
      || (a.tool ? 'call' : (a.query || a.q ? 'search' : (a.command || a.args ? 'cli' : 'status')));
    try {
      if (inferredAction === 'status') {
        const client = getReaClient();
        try { await reaMod.ensureConnected(client); } catch (_) {}
        return JSON.stringify(reaMod.status(client), null, 2);
      }
      if (inferredAction === 'doctor') {
        const d = await reaMod.doctor(getReaClient(), { cwd: a.cwd || ctx.cwd });
        return JSON.stringify(d, null, 2);
      }
      if (inferredAction === 'search') {
        const client = getReaClient();
        const { total, hits } = await reaMod.searchReaTools(client, a.query || a.q || '', 10);
        if (typeof ctx.activateTools === 'function' && hits.length) {
          try {
            // Register matches cleanly into ctx.activateTools when caller has mcp__* defs loaded;
            // either way the model can call them via rea(action="call") or direct mcp__rea__* when deferred.
            ctx.activateTools(hits.map((h) => h.name));
          } catch (_) {}
        }
        if (!hits.length) return `REA (${total} tools loaded): no tool matched ${JSON.stringify(a.query || '')}. Try another keyword or call rea(action="cli", command=[...]).`;
        return `REA (${total} tools loaded) matching ${JSON.stringify(a.query || '')} — invoke via rea(action="call", tool="<name>", arguments={...}) or directly as mcp__rea__<name>:\n`
          + hits.map((h) => `\n### ${h.name.replace(/^mcp__rea__/, '')} (${h.name})\n${h.description}\n${JSON.stringify(h.inputSchema)}`).join('\n');
      }
      if (inferredAction === 'call') {
        const toolName = String(a.tool || a.name || '').trim();
        if (!toolName) return { content: 'rea action="call" requires `tool` (e.g. "analyze_javascript_application", "open_binary", "inspect_artifact", "audit_release_exposure", "decompile").', isError: true };
        const { action: _a, tool: _t, arguments: callArgs, args: legacyArgs, cwd: _c, query: _q, command: _cmd, ...rest } = a;
        const merged = { ...(legacyArgs && typeof legacyArgs === 'object' ? legacyArgs : {}), ...(callArgs && typeof callArgs === 'object' ? callArgs : {}), ...rest };
        const out = await reaMod.callReaTool(getReaClient(), toolName, merged);
        return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
      }
      if (inferredAction === 'cli') {
        const rawCmd = a.command !== undefined ? a.command : a.args;
        if (!rawCmd || (Array.isArray(rawCmd) && !rawCmd.length)) {
          return { content: 'rea action="cli" requires `command` (array or string, e.g. ["analyze-javascript-application", "/abs/path", "--json"]).', isError: true };
        }
        const r = await reaMod.runCli(rawCmd, { cwd: a.cwd || ctx.cwd, signal: ctx.signal });
        const text = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
        return r.ok ? (text || '(rea completed with exit 0)') : { content: `REA CLI exit ${r.exitCode}:\n${text}`, isError: true };
      }
      return { content: `Unknown rea action "${inferredAction}". Expected status | search | call | cli | doctor.`, isError: true };
    } catch (e) {
      return { content: 'REA error: ' + String((e && e.message) || e), isError: true };
    }
  }

  const execName = executorsByTool[name] || name;
  const fn = executors[execName];
  if (!fn) return { content: `Unknown tool: ${name}` };
  try {
    let finalArgs = { ...(args || {}) };
    // Last-ditch unwrap: a `_raw` string that still parses to a JSON object.
    if (finalArgs._raw !== undefined && typeof finalArgs._raw === 'string') {
      try {
        const parsed = JSON.parse(finalArgs._raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) finalArgs = { ...parsed };
      } catch { /* leave as-is; the executor's own validation will explain */ }
    }
    if (FILE_TOOLS.has(name) || FILE_TOOLS.has(execName)) {
      normalizeFileArgs(finalArgs);
      if (ctx.readMtimes instanceof Map) finalArgs._readMtimes = ctx.readMtimes;
      if (ctx.allowRichRead) finalArgs._allowRichRead = true;
    }
    if (!finalArgs.cwd && ctx.cwd) finalArgs.cwd = ctx.cwd;
    if (execName === 'apply_patch') {
      if (ctx.readMtimes instanceof Map) finalArgs._readMtimes = ctx.readMtimes;
      if (typeof ctx.takeCheckpoint === 'function') finalArgs._takeCheckpoint = ctx.takeCheckpoint;
    }
    if (execName === 'run_tool_script') finalArgs._ctx = ctx;
    if (!(ctx && ctx.forceLocal) && ['bash', 'read_file', 'write_file', 'edit_file', 'multi_edit', 'glob', 'grep'].includes(execName)) {
      try {
        const environments = require('./environments');
        if (environments.isRemoteActive()) {
          const remoteOut = await withTimeout(environments.runActiveTool(execName, finalArgs), toolTimeoutMs(name, finalArgs), name);
          return { content: String(remoteOut == null ? '' : remoteOut) };
        }
      } catch (remErr) {
        return { content: 'Remote environment error: ' + (remErr && remErr.message ? remErr.message : String(remErr)), isError: true };
      }
    }
    const content = await withTimeout(fn(finalArgs, { signal: ctx.signal, cwd: finalArgs.cwd, emit: ctx.emit, currentToolId: ctx.currentToolId }), toolTimeoutMs(name, finalArgs), name);
    if (content && typeof content === 'object' && (content.isError || typeof content.content === 'string')) return content;
    return { content: String(content) };
  } catch (e) {
    if (ctx.signal && ctx.signal.aborted) throw e;
    return { content: 'Tool error: ' + (e && e.message ? e.message : String(e)), isError: true };
  }
}

// Load persisted custom runtime tools (Creator Mode) at startup.
try { customtools.registerAll(toolDefinitions, executorsByTool, executors); } catch (_) {}

module.exports = { executors, toolDefinitions, runTool, executorsByTool, SLASH_COMMANDS, toolTimeoutMs, withTimeout, applyEdit, globToRegExp, expandBraces, formatNumbered };
