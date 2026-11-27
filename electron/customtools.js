'use strict';
// ---- Creator Mode: hot-swappable user/agent-authored runtime tools ----------
//
// Inspired by DeepSeek Harness "Creator Mode": an agent (or user) can define a
// new reusable tool on the fly (`CreateCustomTool`) and invoke it on the very
// next step without restarting Akron Bot. Tool definitions persist under
// ~/.autobot/custom-tools/<name>.json (mode 0o600).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

let ROOT = path.join(os.homedir(), '.autobot', 'custom-tools');
const NAME_RE = /^[a-z][a-z0-9_]{2,48}$/;
const MAX_OUT = 30000;

// Built-in core tools cannot be shadowed by a custom runtime tool.
const PROTECTED = new Set([
  'bash', 'read', 'write', 'edit', 'multiedit', 'glob', 'grep', 'ls',
  'task', 'agent', 'swarm', 'toolsearch', 'createcustomtool', 'deletecustomtool',
  'listcustomtools', 'askuserquestion', 'exitplanmode', 'kill_shell', 'killshell',
]);

function setRoot(dir) { ROOT = dir; }
function getRoot() { return ROOT; }

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function writeAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = file + '.tmp.' + process.pid + '.' + Math.random().toString(36).slice(2, 6);
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function clipOut(s) {
  const txt = String(s || '');
  if (txt.length <= MAX_OUT) return txt;
  const half = Math.floor(MAX_OUT / 2) - 40;
  return txt.slice(0, half) + `\n… [${txt.length - MAX_OUT} chars truncated] …\n` + txt.slice(-half);
}

function normalizeSpec(spec = {}) {
  const name = String(spec.name || '').trim();
  if (!NAME_RE.test(name)) {
    throw new Error('Tool name must match ^[a-z][a-z0-9_]{2,48}$ (lowercase letters, digits, underscores).');
  }
  if (PROTECTED.has(name.toLowerCase())) {
    throw new Error(`Cannot overwrite built-in tool "${name}".`);
  }
  const description = String(spec.description || '').trim();
  if (!description) throw new Error('description is required.');
  const script = String(spec.script || '').trim();
  if (!script) throw new Error('script is required.');
  const runtime = ['node', 'bash', 'python3'].includes(String(spec.runtime || '').toLowerCase())
    ? String(spec.runtime).toLowerCase()
    : 'node';
  const parameters = (spec.parameters && typeof spec.parameters === 'object' && !Array.isArray(spec.parameters))
    ? spec.parameters
    : { type: 'object', properties: {} };
  if (!parameters.type) parameters.type = 'object';
  if (!parameters.properties) parameters.properties = {};
  const timeoutMs = Math.max(1000, Math.min(Number(spec.timeoutMs) || 30000, 120000));
  return {
    name,
    description: `[custom:${runtime}] ${description.replace(/^\[custom:[^\]]+\]\s*/i, '')}`,
    parameters,
    runtime,
    script,
    timeoutMs,
    createdAt: Number(spec.createdAt) || Date.now(),
    updatedAt: Date.now(),
  };
}

function makeExecutor(spec) {
  return (args = {}, execCtx = {}) => new Promise((resolve) => {
    const cwd = (args && args.cwd) || (execCtx && execCtx.cwd) || process.cwd();
    const abortSignal = execCtx && execCtx.signal;
    if (abortSignal && abortSignal.aborted) return resolve({ content: '[aborted before start]', isError: true });

    const payload = JSON.stringify(args || {});
    let cmd, argv;
    let useInlineReplFallback = false;
    if (spec.runtime === 'bash') {
      if (process.platform === 'win32') {
        cmd = 'powershell.exe';
        argv = ['-NoLogo', '-NoProfile', '-Command', spec.script];
      } else {
        cmd = require('./paths').defaultPosixShell();
        argv = ['-c', spec.script];
      }
    } else if (spec.runtime === 'python3') {
      cmd = process.platform === 'win32' ? 'python' : 'python3';
      argv = ['-c', spec.script];
    } else {
      const nodeBin = require('./paths').resolveNodeBinary();
      if (nodeBin) {
        cmd = nodeBin;
        argv = ['-e', spec.script];
      } else {
        useInlineReplFallback = true;
      }
    }

    if (useInlineReplFallback) {
      const wrappedCode = `process.env.TOOL_ARGS_JSON = ${JSON.stringify(payload)};\n${spec.script}`;
      require('./repl').evalJS({ code: wrappedCode, timeout: spec.timeoutMs, cwd, reset: true })
        .then((r) => resolve({ content: clipOut((r && r.output) || '(no output)'), isError: !(r && r.ok) }))
        .catch((e) => resolve({ content: `Custom tool "${spec.name}" error: ${e && e.message ? e.message : String(e)}`, isError: true }));
      return;
    }

    let child;
    try {
      child = spawn(cmd, argv, {
        cwd,
        detached: process.platform !== 'win32',
        env: { ...process.env, TOOL_ARGS_JSON: payload },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      return resolve({ content: `Custom tool "${spec.name}" spawn error: ${e.message}`, isError: true });
    }

    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    let aborted = false;

    const killTree = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch (_) {
        try { child.kill('SIGKILL'); } catch (_) {}
      }
    };

    const done = (code, sig) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
      const outClean = out.trimEnd();
      const errClean = err.trimEnd();
      const combined = [outClean, errClean ? (outClean ? `[stderr]\n${errClean}` : errClean) : ''].filter(Boolean).join('\n');
      const tail = timedOut
        ? `\n[timed out after ${Math.round(spec.timeoutMs / 1000)}s — killed]`
        : aborted
          ? '\n[aborted — killed]'
          : (code && code !== 0 ? `\n[exit code ${code}]` : (sig ? `\n[killed by ${sig}]` : ''));
      const failed = Boolean(timedOut || aborted || (code && code !== 0) || sig);
      const fallbackMsg = failed && !combined ? `Error (exit ${code != null ? code : (sig || 'spawn')}): custom tool produced no output` : (combined || '(no output)');
      const text = clipOut(fallbackMsg + (combined || !failed ? tail : ''));
      resolve({ content: text, isError: failed });
    };

    const onAbort = () => { aborted = true; killTree(); setTimeout(() => done(1, 'SIGKILL'), 200); };
    if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => { timedOut = true; killTree(); setTimeout(() => done(1, 'SIGKILL'), 200); }, spec.timeoutMs);
    if (timer.unref) timer.unref();

    child.stdout.on('data', (d) => { if (out.length < MAX_OUT * 2) out += d.toString(); });
    child.stderr.on('data', (d) => { if (err.length < MAX_OUT * 2) err += d.toString(); });
    child.on('error', (e) => { err += '\n' + e.message; done(1, null); });
    child.on('close', (code, sig) => done(code, sig));

    try {
      child.stdin.write(payload);
      child.stdin.end();
    } catch (_) {}
  });
}

function listTools() {
  if (!fs.existsSync(ROOT)) return [];
  const out = [];
  for (const f of fs.readdirSync(ROOT).sort()) {
    if (!f.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
      if (s && s.name && s.script) out.push(s);
    } catch (_) {}
  }
  return out;
}

function mountInto(spec, toolDefinitions, executorsByTool, executors) {
  const execKey = 'custom_' + spec.name;
  const def = { name: spec.name, description: spec.description, parameters: spec.parameters };
  const idx = toolDefinitions.findIndex((t) => t.name === spec.name);
  if (idx >= 0) toolDefinitions[idx] = def;
  else toolDefinitions.push(def);
  executorsByTool[spec.name] = execKey;
  executors[execKey] = makeExecutor(spec);
}

function registerAll(toolDefinitions, executorsByTool, executors) {
  const list = listTools();
  for (const spec of list) {
    try { mountInto(spec, toolDefinitions, executorsByTool, executors); } catch (_) {}
  }
  return list.length;
}

function saveTool(rawSpec, registries) {
  const spec = normalizeSpec(rawSpec);
  writeAtomic(path.join(ROOT, spec.name + '.json'), spec);
  if (registries) {
    mountInto(spec, registries.toolDefinitions, registries.executorsByTool, registries.executors);
  }
  return spec;
}

function deleteTool(name, registries) {
  const clean = String(name || '').trim();
  if (!NAME_RE.test(clean)) return { ok: false, error: 'invalid tool name' };
  const file = path.join(ROOT, clean + '.json');
  const existed = fs.existsSync(file);
  if (existed) try { fs.unlinkSync(file); } catch (_) {}
  if (registries) {
    const { toolDefinitions, executorsByTool, executors } = registries;
    for (let i = toolDefinitions.length - 1; i >= 0; i--) {
      if (toolDefinitions[i].name === clean) toolDefinitions.splice(i, 1);
    }
    delete executorsByTool[clean];
    delete executors['custom_' + clean];
  }
  return { ok: true, deleted: existed, name: clean };
}

module.exports = {
  setRoot, getRoot, normalizeSpec, listTools, registerAll, saveTool, deleteTool, makeExecutor,
};
