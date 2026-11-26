'use strict';

const { Worker } = require('worker_threads');

const MAX_OUTPUT_BYTES = 32 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

const ALLOWED_BRIDGES = new Set(['read', 'glob', 'grep', 'codebaseSearch', 'write', 'edit']);

const WORKER_BOOTSTRAP = `
'use strict';
const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');

const logs = [];
let logBytes = 0;
const maxBytes = workerData.maxOutputBytes || 32768;
const pushLog = (prefix, args) => {
  const line = (prefix ? prefix + ' ' : '') + args.map((a) => {
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
  const b = Buffer.byteLength(line + '\\n', 'utf8');
  if (logBytes + b <= maxBytes) {
    logs.push(line);
    logBytes += b;
  }
};

let nextId = 1;
const pending = new Map();
parentPort.on('message', (msg) => {
  if (!msg || msg.id == null || !pending.has(msg.id)) return;
  const p = pending.get(msg.id);
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
});

const callBridge = (method, args) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'call', id, method, args: args || {} });
});

const tools = {
  read: (a) => callBridge('read', a),
  glob: (a) => callBridge('glob', a),
  grep: (a) => callBridge('grep', a),
  codebaseSearch: (a) => callBridge('codebaseSearch', a),
  write: (a) => callBridge('write', a),
  edit: (a) => callBridge('edit', a),
};

const sandbox = {
  tools,
  console: {
    log: (...a) => pushLog('', a),
    warn: (...a) => pushLog('[warn]', a),
    error: (...a) => pushLog('[err]', a),
  },
  JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Promise, Map, Set,
  parseInt, parseFloat, isNaN, isFinite,
};

(async () => {
  try {
    const wrapped = '(async () => {\\n' + workerData.code + '\\n})()';
    const ctx = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
    const ret = await vm.runInContext(wrapped, ctx, { timeout: workerData.timeoutMs || 15000 });
    parentPort.postMessage({ type: 'done', result: ret === undefined ? null : ret, logs: logs.join('\\n') });
  } catch (err) {
    parentPort.postMessage({ type: 'error', error: (err && err.stack) ? err.stack : String(err), logs: logs.join('\\n') });
  }
})();
`;

function runToolScript({
  code,
  cwd,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = MAX_OUTPUT_BYTES,
  callHostTool,
} = {}) {
  const src = String(code || '').trim();
  if (!src) return Promise.resolve({ ok: false, error: 'RunToolScript requires a non-empty "code" script.' });
  if (typeof callHostTool !== 'function') {
    return Promise.resolve({ ok: false, error: 'Host tool bridge unavailable.' });
  }

  return new Promise((resolve) => {
    const limitMs = Math.min(Math.max(500, Number(timeoutMs) || DEFAULT_TIMEOUT_MS), 60000);
    let settled = false;
    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: { code: src, timeoutMs: limitMs, maxOutputBytes, cwd },
      resourceLimits: {
        maxOldGenerationSizeMb: 128,
        maxYoungGenerationSizeMb: 32,
      },
    });

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { worker.terminate(); } catch (_) {}
      resolve(payload);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, error: `RunToolScript timed out after ${limitMs}ms.` });
    }, limitMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    worker.on('message', async (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'call') {
        if (!ALLOWED_BRIDGES.has(msg.method)) {
          worker.postMessage({ id: msg.id, error: `Disallowed tool bridge method: ${msg.method}` });
          return;
        }
        try {
          const out = await callHostTool(msg.method, msg.args || {});
          worker.postMessage({ id: msg.id, result: out });
        } catch (err) {
          worker.postMessage({ id: msg.id, error: err && err.message ? err.message : String(err) });
        }
        return;
      }
      if (msg.type === 'done') {
        const retText = msg.result == null ? '' : (typeof msg.result === 'string' ? msg.result : JSON.stringify(msg.result, null, 2));
        const combined = [msg.logs, retText].filter(Boolean).join('\n').trim().slice(0, maxOutputBytes);
        finish({ ok: true, output: combined || '(script completed with no output)' });
        return;
      }
      if (msg.type === 'error') {
        const combined = [msg.logs, `Script error: ${msg.error}`].filter(Boolean).join('\n').slice(0, maxOutputBytes);
        finish({ ok: false, error: combined });
      }
    });

    worker.on('error', (err) => {
      finish({ ok: false, error: `Worker error: ${err && err.message ? err.message : String(err)}` });
    });
    worker.on('exit', (exitCode) => {
      if (!settled) {
        finish({ ok: false, error: `RunToolScript worker exited unexpectedly (code ${exitCode}).` });
      }
    });
  });
}

module.exports = {
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  runToolScript,
};
