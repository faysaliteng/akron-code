'use strict';
// Akron Bot — persistent REPL sessions (Claude Code `REPLInput` parity).
//
// Primary path: persistent isolated child `node` process per session (when
// `resolveNodeBinary()` finds Node), keeping Electron's main process (`app`,
// `BrowserWindow`, credentials in memory) completely out of reach of evaluated
// model code. State survives across calls inside a dedicated `vm.Context`
// inside the child process; top-level `await` and dynamic `import()` work
// seamlessly.
//
// Fallback path (only when no standalone Node binary exists on host): restricted
// in-process `vm.createContext` with `electron` imports blocked and a minimal
// sanitized `process` facade (never exposing main-process `process`).

const vm = require('vm');
const path = require('path');
const util = require('util');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');

const sessions = new Map();
const MAX_OUTPUT = 60000;

function makeSafeProcessFacade(root) {
  return {
    platform: process.platform,
    arch: process.arch,
    version: process.version,
    versions: { ...(process.versions || {}) },
    env: { ...(process.env || {}) },
    argv: ['node', path.join(root, 'repl.js')],
    cwd: () => root,
    nextTick: (...a) => process.nextTick(...a),
    hrtime: process.hrtime,
    stdout: { write: () => true },
    stderr: { write: () => true },
  };
}

function freshSandbox(cwd) {
  const root = cwd || process.cwd();
  const localReq = createRequire(path.join(root, 'noop.js'));
  const appReq = createRequire(path.join(__dirname, '..', 'package.json'));
  const guardElectron = (id) => {
    const s = String(id || '').trim().toLowerCase();
    if (s === 'electron' || s.startsWith('electron/')) {
      throw new Error('Access to "electron" internals is blocked inside the REPL sandbox.');
    }
  };
  const hybridRequire = (id) => {
    guardElectron(id);
    try { return localReq(id); } catch (e) {
      if (id && !id.startsWith('.') && !path.isAbsolute(id)) {
        try { return appReq(id); } catch (_) {}
      }
      throw e;
    }
  };
  hybridRequire.resolve = (id, opts) => {
    guardElectron(id);
    try { return localReq.resolve(id, opts); } catch (e) {
      if (id && !id.startsWith('.') && !path.isAbsolute(id)) {
        try { return appReq.resolve(id, opts); } catch (_) {}
      }
      throw e;
    }
  };
  const sandbox = {
    console: null, // replaced per-run so output is captured
    process: makeSafeProcessFacade(root),
    Buffer,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    AbortController,
    AbortSignal,
    fetch,
    structuredClone,
    require: hybridRequire,
    module: { exports: {} },
    exports: {},
    __dirname: root,
    __filename: path.join(root, 'repl.js'),
  };
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext('globalThis.global = globalThis;', ctx);
  } catch (_) {}
  return { kind: 'vm', sandbox, ctx, cwd: root, req: hybridRequire };
}

// Persistent child-worker bootstrapper executed by external Node binary.
const WORKER_BOOTSTRAP = `'use strict';
const vm = require('vm');
const path = require('path');
const util = require('util');
const readline = require('readline');
const { pathToFileURL } = require('url');
const { createRequire } = require('module');

const MAX_OUTPUT = ${MAX_OUTPUT};
const root = process.env.AKRON_REPL_CWD || process.cwd();
const appPkg = process.env.AKRON_REPL_APP_PKG || '';
const localReq = createRequire(path.join(root, 'noop.js'));
const appReq = appPkg ? createRequire(appPkg) : null;

const guardElectron = (id) => {
  const s = String(id || '').trim().toLowerCase();
  if (s === 'electron' || s.startsWith('electron/')) {
    throw new Error('Access to "electron" internals is blocked inside the REPL worker.');
  }
};
const hybridRequire = (id) => {
  guardElectron(id);
  try { return localReq(id); } catch (e) {
    if (appReq && id && !id.startsWith('.') && !path.isAbsolute(id)) {
      try { return appReq(id); } catch (_) {}
    }
    throw e;
  }
};
hybridRequire.resolve = (id, opts) => {
  guardElectron(id);
  try { return localReq.resolve(id, opts); } catch (e) {
    if (appReq && id && !id.startsWith('.') && !path.isAbsolute(id)) {
      try { return appReq.resolve(id, opts); } catch (_) {}
    }
    throw e;
  }
};

const logs = [];
const pushLog = (args) => {
  logs.push(args.map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, maxArrayLength: 100, breakLength: 100 }))).join(' '));
};
const cap = (...a) => pushLog(a);
const dynImport = async (specifier) => {
  const spec = String(specifier || '').trim();
  if (!spec) throw new Error('Empty module specifier');
  guardElectron(spec);
  if (spec.startsWith('node:') || spec.startsWith('file:') || spec.startsWith('data:')) return import(spec);
  if (spec.startsWith('.') || path.isAbsolute(spec)) return import(pathToFileURL(path.resolve(root, spec)).href);
  try {
    const res = hybridRequire.resolve(spec);
    if (res) return import(path.isAbsolute(res) ? pathToFileURL(res).href : res);
  } catch (_) {}
  return import(spec);
};

const sandbox = {
  console: {
    log: cap, info: cap, warn: cap, error: cap, debug: cap, trace: cap,
    dir: (o) => pushLog([util.inspect(o, { depth: 4 })]),
    table: (o) => pushLog([util.inspect(o, { depth: 4 })]),
    time: () => {}, timeEnd: () => {}, group: () => {}, groupEnd: () => {},
    assert: (c, ...r) => { if (!c) pushLog(['Assertion failed:', ...r]); },
  },
  process, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
  setImmediate, clearImmediate, queueMicrotask, URL, URLSearchParams,
  TextEncoder, TextDecoder, AbortController, AbortSignal, fetch, structuredClone,
  require: hybridRequire, module: { exports: {} }, exports: {},
  __dirname: root, __filename: path.join(root, 'repl.js'),
  __akronDynamicImport: dynImport,
};
const ctx = vm.createContext(sandbox);
try { vm.runInContext('globalThis.global = globalThis;', ctx); } catch (_) {}

function fmtResult(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return util.inspect(v, { depth: 4, maxArrayLength: 100, breakLength: 100 }); }
  catch (_) { return String(v); }
}

async function runSnippet(rawSrc, timeoutMs) {
  logs.length = 0;
  const src = String(rawSrc || '').replace(/(?<![.\\w$])import\\s*\\(/g, '__akronDynamicImport(');
  let result;
  let asyncMode = false;
  try {
    result = new vm.Script(src, { filename: 'repl.js' }).runInContext(ctx, { timeout: timeoutMs });
  } catch (e) {
    const isAwaitSyntax = e && e.name === 'SyntaxError' && /await/i.test(e.message || '');
    if (!isAwaitSyntax) {
      return { ok: false, output: ((logs.length ? logs.join('\\n') + '\\n' : '') + 'Error: ' + (e && e.message ? e.message : String(e))).slice(0, MAX_OUTPUT) };
    }
    asyncMode = true;
    const rewritten = src.replace(/^([ \\t]*)(const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=/gm, '$1globalThis.$3 =');
    const trimmed = src.trim();
    const singleExpr = !/[\\n;]/.test(trimmed) && !/^(const|let|var|function|class|if|for|while|do|switch|try|return|throw|import|export)\\b/.test(trimmed);
    const wrapped = singleExpr ? \`(async () => (\${trimmed}))()\` : \`(async () => {\\n\${rewritten}\\n})()\`;
    try {
      result = new vm.Script(wrapped, { filename: 'repl.js' }).runInContext(ctx, { timeout: timeoutMs });
    } catch (e2) {
      return { ok: false, output: ((logs.length ? logs.join('\\n') + '\\n' : '') + 'Error: ' + (e2 && e2.message ? e2.message : String(e2))).slice(0, MAX_OUTPUT) };
    }
  }
  if (result && typeof result.then === 'function') {
    let timer = null;
    try {
      result = await Promise.race([
        result.then((v) => ({ __v: v })),
        new Promise((res) => { timer = setTimeout(() => res({ __timeout: true }), timeoutMs); }),
      ]);
      if (result && result.__timeout) {
        return { ok: false, output: ((logs.length ? logs.join('\\n') + '\\n' : '') + \`Error: evaluation did not settle within \${timeoutMs}ms.\`).slice(0, MAX_OUTPUT) };
      }
      result = result ? result.__v : undefined;
    } catch (e) {
      return { ok: false, output: ((logs.length ? logs.join('\\n') + '\\n' : '') + 'Error: ' + (e && e.message ? e.message : String(e))).slice(0, MAX_OUTPUT) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  const parts = [];
  if (logs.length) parts.push(logs.join('\\n'));
  const printed = fmtResult(result);
  if (printed !== '') parts.push(printed);
  let output = parts.join('\\n');
  if (!output) output = asyncMode ? '(ok)' : '(no output)';
  return { ok: true, output: output.slice(0, MAX_OUTPUT) };
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch (_) { return; }
  const res = await runSnippet(req.code, req.timeout || 30000);
  process.stdout.write(JSON.stringify({ id: req.id, ...res }) + '\\n');
});
`;

function syncWorkerRef(entry) {
  if (!entry || entry.kind !== 'child' || !entry.proc || !entry.proc.stdout) return;
  try {
    if (entry.pending.size > 0 && typeof entry.proc.stdout.ref === 'function') entry.proc.stdout.ref();
    else if (entry.pending.size === 0 && typeof entry.proc.stdout.unref === 'function') entry.proc.stdout.unref();
  } catch (_) {}
}

function destroySession(entry) {
  if (!entry) return;
  if (entry.kind === 'child' && entry.proc) {
    try {
      for (const [, p] of entry.pending.entries()) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, output: 'Error: REPL session terminated.' });
      }
      entry.pending.clear();
      syncWorkerRef(entry);
      entry.proc.kill('SIGKILL');
    } catch (_) {}
  }
}

function createChildWorkerSession(key, cwd) {
  let nodeBin = null;
  try { nodeBin = require('./paths').resolveNodeBinary(); } catch (_) {}
  if (!nodeBin) return null;
  const root = cwd || process.cwd();
  const env = { ...process.env, AKRON_REPL_CWD: root, AKRON_REPL_APP_PKG: path.join(__dirname, '..', 'package.json') };
  delete env.ELECTRON_RUN_AS_NODE;
  let proc;
  try {
    proc = spawn(nodeBin, ['--input-type=commonjs', '-e', WORKER_BOOTSTRAP], {
      cwd: root,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (_) {
    return null;
  }
  const entry = {
    kind: 'child',
    id: key,
    proc,
    cwd: root,
    seq: 1,
    buf: '',
    errBuf: '',
    pending: new Map(),
    exited: false,
  };
  const settleExit = (why) => {
    entry.exited = true;
    for (const [id, p] of entry.pending.entries()) {
      clearTimeout(p.timer);
      entry.pending.delete(id);
      p.resolve({ ok: false, output: `Error: REPL worker exited (${why}${entry.errBuf ? ': ' + entry.errBuf.slice(0, 300) : ''}).` });
    }
    syncWorkerRef(entry);
    if (sessions.get(key) === entry) sessions.delete(key);
  };
  proc.stdout.on('data', (chunk) => {
    entry.buf += chunk.toString('utf8');
    let nl;
    while ((nl = entry.buf.indexOf('\n')) >= 0) {
      const line = entry.buf.slice(0, nl).trim();
      entry.buf = entry.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      const p = entry.pending.get(msg.id);
      if (p) {
        clearTimeout(p.timer);
        entry.pending.delete(msg.id);
        syncWorkerRef(entry);
        p.resolve({ ok: !!msg.ok, output: String(msg.output || '') });
      }
    }
  });
  proc.stderr.on('data', (d) => {
    if (entry.errBuf.length < 4000) entry.errBuf += d.toString('utf8');
  });
  proc.on('error', (e) => settleExit(e && e.message ? e.message : 'spawn error'));
  proc.on('exit', (code, sig) => settleExit(`code=${code}, sig=${sig || 'none'}`));
  if (typeof proc.unref === 'function') proc.unref();
  if (proc.stdin && typeof proc.stdin.unref === 'function') proc.stdin.unref();
  if (proc.stdout && typeof proc.stdout.unref === 'function') proc.stdout.unref();
  if (proc.stderr && typeof proc.stderr.unref === 'function') proc.stderr.unref();
  return entry;
}

function getSession(id, cwd, reset) {
  const key = String(id || cwd || 'default');
  if (reset && sessions.has(key)) {
    destroySession(sessions.get(key));
    sessions.delete(key);
  }
  let s = sessions.get(key);
  if (s && s.exited) s = null;
  if (!s) {
    s = createChildWorkerSession(key, cwd) || freshSandbox(cwd);
    s.id = key;
    sessions.set(key, s);
  }
  return s;
}

function makeCapture(sandbox) {
  const logs = [];
  const push = (args) => {
    const line = args
      .map((a) => (typeof a === 'string' ? a : util.inspect(a, { depth: 4, maxArrayLength: 100, breakLength: 100 })))
      .join(' ');
    logs.push(line);
  };
  const cap = (...args) => push(args);
  sandbox.console = {
    log: cap, info: cap, warn: cap, error: cap, debug: cap, trace: cap,
    dir: (o) => push([util.inspect(o, { depth: 4 })]),
    table: (o) => push([util.inspect(o, { depth: 4 })]),
    time: () => {}, timeEnd: () => {}, group: () => {}, groupEnd: () => {},
    assert: (c, ...r) => { if (!c) push(['Assertion failed:', ...r]); },
  };
  return logs;
}

function fmtResult(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try { return util.inspect(v, { depth: 4, maxArrayLength: 100, breakLength: 100 }); }
  catch (_) { return String(v); }
}

function clampTimeout(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 30000;
  return Math.min(Math.max(n, 1000), 600000);
}

function makeImportModuleDynamically(session) {
  return async (specifier) => {
    const spec = String(specifier || '').trim();
    if (!spec) throw new Error('Empty module specifier');
    if (spec.toLowerCase() === 'electron' || spec.toLowerCase().startsWith('electron/')) {
      throw new Error('Access to "electron" internals is blocked inside the REPL sandbox.');
    }
    if (spec.startsWith('node:') || spec.startsWith('file:') || spec.startsWith('data:')) return import(spec);
    if (spec.startsWith('.') || path.isAbsolute(spec)) {
      return import(pathToFileURL(path.resolve((session && session.cwd) || process.cwd(), spec)).href);
    }
    try {
      const resolved = session && session.req ? session.req.resolve(spec) : null;
      if (resolved) return import(path.isAbsolute(resolved) ? pathToFileURL(resolved).href : resolved);
    } catch (_) {}
    return import(spec);
  };
}

function rewriteDynamicImport(src) {
  return String(src || '').replace(/(?<![.\w$])import\s*\(/g, '__akronDynamicImport(');
}

// Evaluate a JavaScript snippet in the persistent session.
async function evalJS({ code, timeout = 30000, cwd, sessionId, reset = false }) {
  const rawSrc = String(code == null ? '' : code);
  if (!rawSrc.trim()) return { ok: true, output: '' };
  const ms = clampTimeout(timeout);
  const session = getSession(sessionId, cwd, reset);

  if (session.kind === 'child') {
    return await new Promise((resolve) => {
      const reqId = session.seq++;
      const timer = setTimeout(() => {
        session.pending.delete(reqId);
        syncWorkerRef(session);
        destroySession(session);
        sessions.delete(session.id);
        resolve({ ok: false, output: `Error: REPL evaluation timed out after ${ms}ms.` });
      }, ms + 500);
      session.pending.set(reqId, { resolve, timer });
      syncWorkerRef(session);
      try {
        session.proc.stdin.write(JSON.stringify({ id: reqId, code: rawSrc, timeout: ms }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        session.pending.delete(reqId);
        syncWorkerRef(session);
        resolve({ ok: false, output: 'Error: ' + (e && e.message ? e.message : String(e)) });
      }
    });
  }

  const { ctx, sandbox } = session;
  const logs = makeCapture(sandbox);
  sandbox.__akronDynamicImport = makeImportModuleDynamically(session);
  const src = rewriteDynamicImport(rawSrc);

  let result;
  let asyncMode = false;
  try {
    const scriptObj = new vm.Script(src, { filename: 'repl.js' });
    result = scriptObj.runInContext(ctx, { timeout: ms });
  } catch (e) {
    const isAwaitSyntax = e && e.name === 'SyntaxError' && /await/i.test(e.message || '');
    if (!isAwaitSyntax) {
      const text = (logs.length ? logs.join('\n') + '\n' : '') + 'Error: ' + (e && e.message ? e.message : String(e));
      return { ok: false, output: text.slice(0, MAX_OUTPUT) };
    }
    asyncMode = true;
    const rewritten = src.replace(/^([ \t]*)(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, '$1globalThis.$3 =');
    const trimmed = src.trim();
    const singleExpr = !/[\n;]/.test(trimmed) && !/^(const|let|var|function|class|if|for|while|do|switch|try|return|throw|import|export)\b/.test(trimmed);
    const wrapped = singleExpr ? `(async () => (${trimmed}))()` : `(async () => {\n${rewritten}\n})()`;
    try {
      result = new vm.Script(wrapped, { filename: 'repl.js' }).runInContext(ctx, { timeout: ms });
    } catch (e2) {
      const text = (logs.length ? logs.join('\n') + '\n' : '') + 'Error: ' + (e2 && e2.message ? e2.message : String(e2));
      return { ok: false, output: text.slice(0, MAX_OUTPUT) };
    }
  }

  if (result && typeof result.then === 'function') {
    let timer = null;
    const guard = new Promise((resolve) => {
      timer = setTimeout(() => resolve({ __timeout: true }), ms);
    });
    try {
      result = await Promise.race([result.then((v) => ({ __value: v })), guard]);
      if (result && result.__timeout) {
        const text = (logs.length ? logs.join('\n') + '\n' : '') + `Error: evaluation did not settle within ${ms}ms.`;
        return { ok: false, output: text.slice(0, MAX_OUTPUT) };
      }
      result = result ? result.__value : undefined;
    } catch (e) {
      const text = (logs.length ? logs.join('\n') + '\n' : '') + 'Error: ' + (e && e.message ? e.message : String(e));
      return { ok: false, output: text.slice(0, MAX_OUTPUT) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const parts = [];
  if (logs.length) parts.push(logs.join('\n'));
  const printed = fmtResult(result);
  if (printed !== '') parts.push(printed);
  let output = parts.join('\n');
  if (!output) output = asyncMode ? '(ok)' : '(no output)';
  return { ok: true, output: output.slice(0, MAX_OUTPUT) };
}

function resetSession(id) {
  if (id == null) {
    for (const s of sessions.values()) destroySession(s);
    sessions.clear();
  } else {
    const key = String(id);
    if (sessions.has(key)) {
      destroySession(sessions.get(key));
      sessions.delete(key);
    }
  }
}

function listSessions() {
  return Array.from(sessions.keys());
}

module.exports = { evalJS, resetSession, listSessions };
