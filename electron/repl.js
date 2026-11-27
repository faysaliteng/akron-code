'use strict';
// Akron Bot — persistent REPL sessions (Claude Code `REPLInput` parity).
//
// One vm context per session id (defaults to the project cwd, so each project
// folder gets its own REPL the way Example's does). State survives across calls:
// top-level `var`/`let`/`const`/`function`/`class` declared in the context's
// global lexical scope remain visible to later evaluations in the SAME context
// (verified against V8 — separate `vm.runInContext` scripts share the context's
// global lexical environment).
//
// Top-level `await` is supported: if a snippet fails to compile because of a
// top-level await, it is wrapped in an async IIFE. To keep declarations across
// await-using snippets, `const|let|var name =` at the start of a line is
// rewritten to `globalThis.name =` in that mode (documented behaviour).

const vm = require('vm');
const path = require('path');
const util = require('util');
const { createRequire } = require('module');

const sessions = new Map();
const MAX_OUTPUT = 60000;

function freshSandbox(cwd) {
  const root = cwd || process.cwd();
  const localReq = createRequire(path.join(root, 'noop.js'));
  const appReq = createRequire(path.join(__dirname, '..', 'package.json'));
  const hybridRequire = (id) => {
    try { return localReq(id); } catch (e) {
      if (id && !id.startsWith('.') && !path.isAbsolute(id)) {
        try { return appReq(id); } catch (_) {}
      }
      throw e;
    }
  };
  hybridRequire.resolve = (id, opts) => {
    try { return localReq.resolve(id, opts); } catch (e) {
      if (id && !id.startsWith('.') && !path.isAbsolute(id)) {
        try { return appReq.resolve(id, opts); } catch (_) {}
      }
      throw e;
    }
  };
  const sandbox = {
    console: null, // replaced per-run so output is captured
    process,
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
  // Make the sandbox self-referential so snippets that touch `global`/`globalThis`
  // behave like a Node REPL.
  try {
    vm.runInContext('globalThis.global = globalThis;', ctx);
  } catch (_) {}
  return { sandbox, ctx };
}

function getSession(id, cwd, reset) {
  const key = String(id || cwd || 'default');
  if (reset) sessions.delete(key);
  let s = sessions.get(key);
  if (!s) {
    s = freshSandbox(cwd);
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
    log: cap,
    info: cap,
    warn: cap,
    error: cap,
    debug: cap,
    trace: cap,
    dir: (o) => push([util.inspect(o, { depth: 4 })]),
    table: (o) => push([util.inspect(o, { depth: 4 })]),
    time: () => {},
    timeEnd: () => {},
    group: () => {},
    groupEnd: () => {},
    assert: (c, ...r) => { if (!c) push(['Assertion failed:', ...r]); },
  };
  return logs;
}

function fmtResult(v) {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  try {
    return util.inspect(v, { depth: 4, maxArrayLength: 100, breakLength: 100 });
  } catch (_) {
    return String(v);
  }
}

function clampTimeout(t) {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return 30000;
  return Math.min(Math.max(n, 1000), 600000);
}

// Evaluate a JavaScript snippet in the persistent session. Returns
// { ok, output } where output is the combined console output + completion value.
async function evalJS({ code, timeout = 30000, cwd, sessionId, reset = false }) {
  const src = String(code == null ? '' : code);
  if (!src.trim()) return { ok: true, output: '' };
  const ms = clampTimeout(timeout);
  const session = getSession(sessionId, cwd, reset);
  const { ctx, sandbox } = session;
  const logs = makeCapture(sandbox);

  let result;
  let asyncMode = false;
  try {
    result = vm.runInContext(src, ctx, { timeout: ms, filename: 'repl.js' });
  } catch (e) {
    const isAwaitSyntax =
      e && e.name === 'SyntaxError' &&
      (/await is only valid/i.test(e.message) || /await/i.test(e.message) || /Illegal await/i.test(e.message));
    if (!isAwaitSyntax) {
      const text = (logs.length ? logs.join('\n') + '\n' : '') + 'Error: ' + (e && e.message ? e.message : String(e));
      return { ok: false, output: text.slice(0, MAX_OUTPUT) };
    }
    asyncMode = true;
    // Rewrite simple top-level declarations so state survives the async wrapper.
    const rewritten = src.replace(/^([ \t]*)(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm, '$1globalThis.$3 =');
    // If the whole snippet is a single expression (the common `await foo()` case),
    // return its value so the REPL echoes it like Node's.
    const trimmed = src.trim();
    const singleExpr = !/[\n;]/.test(trimmed) &&
      !/^(const|let|var|function|class|if|for|while|do|switch|try|return|throw|import|export)\b/.test(trimmed);
    const wrapped = singleExpr
      ? `(async () => (${trimmed}))()`
      : `(async () => {\n${rewritten}\n})()`;
    try {
      result = vm.runInContext(wrapped, ctx, { timeout: ms, filename: 'repl.js' });
    } catch (e2) {
      const text = (logs.length ? logs.join('\n') + '\n' : '') + 'Error: ' + (e2 && e2.message ? e2.message : String(e2));
      return { ok: false, output: text.slice(0, MAX_OUTPUT) };
    }
  }

  // If the snippet returned a promise (top-level await, fetch, timers, ...),
  // resolve it under our own timer because vm's `timeout` only bounds sync work.
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
  if (id == null) sessions.clear();
  else sessions.delete(String(id));
}

function listSessions() {
  return Array.from(sessions.keys());
}

module.exports = { evalJS, resetSession, listSessions };
