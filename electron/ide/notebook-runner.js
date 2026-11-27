'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');
const { createRequire } = require('module');

const PYTHON_DRIVER = [
  'import sys, json, io, traceback, base64, ast, contextlib',
  'try:',
  '    import matplotlib',
  '    matplotlib.use("Agg")',
  '    import matplotlib.pyplot as _ak_plt',
  'except Exception:',
  '    _ak_plt = None',
  '_ak_ns = {"__name__": "__main__"}',
  'while True:',
  '    line = sys.stdin.readline()',
  '    if not line:',
  '        break',
  '    line = line.strip()',
  '    if not line:',
  '        continue',
  '    try:',
  '        req = json.loads(line)',
  '    except Exception as e:',
  '        sys.stdout.write(json.dumps({"id": None, "ok": False, "error": str(e)}) + "\\n")',
  '        sys.stdout.flush()',
  '        continue',
  '    rid = req.get("id")',
  '    code = req.get("code", "")',
  '    out_buf, err_buf = io.StringIO(), io.StringIO()',
  '    result_text = None',
  '    error_obj = None',
  '    images = []',
  '    try:',
  '        tree = ast.parse(code, mode="exec")',
  '        last_expr = None',
  '        if tree.body and isinstance(tree.body[-1], ast.Expr):',
  '            last_expr = ast.Expression(body=tree.body.pop().value)',
  '            ast.fix_missing_locations(last_expr)',
  '        with contextlib.redirect_stdout(out_buf), contextlib.redirect_stderr(err_buf):',
  '            if tree.body:',
  '                exec(compile(tree, "<notebook>", "exec"), _ak_ns)',
  '            if last_expr is not None:',
  '                val = eval(compile(last_expr, "<notebook>", "eval"), _ak_ns)',
  '                if val is not None:',
  '                    result_text = repr(val)',
  '        if _ak_plt is not None:',
  '            for fnum in list(_ak_plt.get_fignums()):',
  '                fig = _ak_plt.figure(fnum)',
  '                bio = io.BytesIO()',
  '                fig.savefig(bio, format="png", bbox_inches="tight")',
  '                images.append(base64.b64encode(bio.getvalue()).decode("ascii"))',
  '            _ak_plt.close("all")',
  '    except Exception as ex:',
  '        error_obj = {"ename": type(ex).__name__, "evalue": str(ex), "traceback": traceback.format_exc().splitlines()}',
  '    sys.stdout.write(json.dumps({"id": rid, "ok": error_obj is None, "stdout": out_buf.getvalue(), "stderr": err_buf.getvalue(), "result": result_text, "images": images, "error": error_obj}) + "\\n")',
  '    sys.stdout.flush()',
].join('\n');

const kernels = new Map(); // key (notebookPath::lang) -> kernel state

function kernelKey(notebookPath, kernel = 'python') {
  return `${path.resolve(String(notebookPath || 'untitled.ipynb'))}::${kernel}`;
}

function emptyNotebook() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' },
      language_info: { name: 'python' },
    },
    cells: [
      { id: 'cell_1', cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '' },
    ],
  };
}

function normalizeSource(src) {
  if (Array.isArray(src)) return src.join('');
  return String(src == null ? '' : src);
}

function parseNotebook(rawJson) {
  let nb;
  try { nb = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson; } catch (_) { nb = null; }
  if (!nb || !Array.isArray(nb.cells)) return emptyNotebook();
  return {
    nbformat: Number(nb.nbformat) || 4,
    nbformat_minor: Number(nb.nbformat_minor) || 5,
    metadata: nb.metadata && typeof nb.metadata === 'object' ? nb.metadata : emptyNotebook().metadata,
    cells: nb.cells.map((c, idx) => ({
      id: c.id || `cell_${idx + 1}`,
      cell_type: c.cell_type === 'markdown' ? 'markdown' : 'code',
      execution_count: c.execution_count != null ? c.execution_count : null,
      metadata: c.metadata || {},
      outputs: Array.isArray(c.outputs) ? c.outputs : [],
      source: normalizeSource(c.source),
    })),
  };
}

function serializeNotebook(nb) {
  const clean = parseNotebook(nb);
  return JSON.stringify({
    nbformat: clean.nbformat,
    nbformat_minor: clean.nbformat_minor,
    metadata: clean.metadata,
    cells: clean.cells.map((c) => ({
      id: c.id,
      cell_type: c.cell_type,
      ...(c.cell_type === 'code' ? { execution_count: c.execution_count, outputs: c.outputs } : {}),
      metadata: c.metadata || {},
      source: c.source,
    })),
  }, null, 2) + '\n';
}

function resolvePythonBin() {
  const cands = process.platform === 'win32'
    ? ['python.exe', 'python3.exe']
    : ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3', 'python3', 'python'];
  for (const c of cands) {
    if (!c.includes('/')) return c;
    try { if (fs.existsSync(c)) return c; } catch (_) {}
  }
  return 'python3';
}

function startPythonKernel(key, cwd) {
  const pyBin = resolvePythonBin();
  const proc = spawn(pyBin, ['-u', '-c', PYTHON_DRIVER], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  let buf = '';
  let reqSeq = 0;
  let execCount = 0;
  const pending = new Map();

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(entry.timer);
        entry.resolve(msg);
      }
    }
  });

  proc.on('exit', (code) => {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({ ok: false, error: { ename: 'KernelExited', evalue: `Python kernel exited (${code})`, traceback: [] } });
    }
    pending.clear();
    if (kernels.get(key) === kObj) kernels.delete(key);
  });

  const kObj = {
    type: 'python',
    proc,
    cwd,
    nextCount: () => ++execCount,
    run(code, timeoutMs = 30000) {
      const id = `py_${++reqSeq}_${Date.now().toString(36)}`;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: { ename: 'TimeoutError', evalue: `Cell execution timed out after ${timeoutMs}ms`, traceback: [] } });
        }, timeoutMs);
        if (timer.unref) timer.unref();
        pending.set(id, { resolve, timer });
        try {
          proc.stdin.write(JSON.stringify({ id, code }) + '\n');
        } catch (err) {
          clearTimeout(timer);
          pending.delete(id);
          resolve({ ok: false, error: { ename: 'WriteError', evalue: err.message, traceback: [] } });
        }
      });
    },
    interrupt() {
      try { proc.kill('SIGINT'); return true; } catch (_) { return false; }
    },
    dispose() {
      try { proc.kill('SIGKILL'); } catch (_) {}
      kernels.delete(key);
    },
  };
  kernels.set(key, kObj);
  return kObj;
}

function startJsKernel(key, cwd) {
  const workCwd = cwd && fs.existsSync(cwd) ? cwd : process.cwd();
  let reqObj = require;
  try { reqObj = createRequire(path.join(workCwd, 'notebook.js')); } catch (_) {}
  let stdout = '';
  let stderr = '';
  let execCount = 0;

  const customConsole = {
    log: (...a) => { stdout += a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ') + '\n'; },
    info: (...a) => { stdout += a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ') + '\n'; },
    warn: (...a) => { stderr += a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ') + '\n'; },
    error: (...a) => { stderr += a.map((x) => (typeof x === 'string' ? x : require('util').inspect(x))).join(' ') + '\n'; },
  };
  const ctx = vm.createContext({
    console: customConsole,
    require: reqObj,
    process,
    Buffer,
    setTimeout,
    clearTimeout,
    URL,
    TextEncoder,
    TextDecoder,
  });

  const kObj = {
    type: 'javascript',
    cwd: workCwd,
    nextCount: () => ++execCount,
    async run(code, timeoutMs = 15000) {
      stdout = '';
      stderr = '';
      try {
        const val = await vm.runInContext(String(code || ''), ctx, { timeout: timeoutMs });
        return {
          ok: true,
          stdout,
          stderr,
          result: val !== undefined ? (typeof val === 'string' ? val : require('util').inspect(val)) : null,
          images: [],
          error: null,
        };
      } catch (err) {
        return {
          ok: false,
          stdout,
          stderr,
          result: null,
          images: [],
          error: { ename: err.name || 'Error', evalue: err.message || String(err), traceback: String(err.stack || err).split('\n') },
        };
      }
    },
    interrupt() { return false; },
    dispose() { kernels.delete(key); },
  };
  kernels.set(key, kObj);
  return kObj;
}

function buildNbOutputs(res, count) {
  const outputs = [];
  if (res.stdout) outputs.push({ output_type: 'stream', name: 'stdout', text: res.stdout });
  if (res.stderr) outputs.push({ output_type: 'stream', name: 'stderr', text: res.stderr });
  for (const imgB64 of (res.images || [])) {
    outputs.push({ output_type: 'display_data', data: { 'image/png': imgB64 }, metadata: {} });
  }
  if (res.result != null) {
    outputs.push({
      output_type: 'execute_result',
      execution_count: count,
      data: { 'text/plain': String(res.result) },
      metadata: {},
    });
  }
  if (res.error) {
    outputs.push({
      output_type: 'error',
      ename: res.error.ename || 'Error',
      evalue: res.error.evalue || 'Execution failed',
      traceback: res.error.traceback || [],
    });
  }
  return outputs;
}

async function executeCell({ notebookPath = 'untitled.ipynb', cwd = process.cwd(), kernel = 'python', code = '', timeoutMs = 30000 } = {}) {
  const lang = kernel === 'javascript' || kernel === 'node' ? 'javascript' : 'python';
  const key = kernelKey(notebookPath, lang);
  let k = kernels.get(key);
  if (!k) {
    k = lang === 'javascript' ? startJsKernel(key, cwd) : startPythonKernel(key, cwd);
  }
  const executionCount = k.nextCount();
  const res = await k.run(String(code || ''), timeoutMs);
  return {
    ok: res.ok !== false && !res.error,
    kernel: lang,
    executionCount,
    outputs: buildNbOutputs(res, executionCount),
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    result: res.result != null ? res.result : null,
    images: res.images || [],
    error: res.error || null,
  };
}

function interruptKernel(notebookPath, kernel = 'python') {
  const key = kernelKey(notebookPath, kernel === 'javascript' || kernel === 'node' ? 'javascript' : 'python');
  const k = kernels.get(key);
  if (!k) return { ok: false, error: 'Kernel not running' };
  return { ok: k.interrupt() };
}

function restartKernel(notebookPath, kernel = 'python') {
  const lang = kernel === 'javascript' || kernel === 'node' ? 'javascript' : 'python';
  const key = kernelKey(notebookPath, lang);
  const k = kernels.get(key);
  if (k) k.dispose();
  return { ok: true, restarted: lang };
}

function kernelStatus(notebookPath) {
  const py = kernels.has(kernelKey(notebookPath, 'python'));
  const js = kernels.has(kernelKey(notebookPath, 'javascript'));
  return { python: py ? 'idle' : 'stopped', javascript: js ? 'idle' : 'stopped' };
}

function shutdownAllKernels() {
  for (const k of [...kernels.values()]) {
    try { k.dispose(); } catch (_) {}
  }
  kernels.clear();
}

module.exports = {
  parseNotebook,
  serializeNotebook,
  executeCell,
  interruptKernel,
  restartKernel,
  kernelStatus,
  shutdownAllKernels,
};
