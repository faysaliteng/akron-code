'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocket } = require('ws');

const sessions = new Map();

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

function emitSafe(cb, evt) {
  if (typeof cb === 'function') {
    try { cb(evt); } catch (_) {}
  }
}

async function startNodeDebugger({ sessionId, cwd, filePath, args = [], breakpoints = [], watchExpressions = [], onEvent }) {
  const proc = spawn(process.execPath, ['--inspect-brk=127.0.0.1:0', filePath, ...(Array.isArray(args) ? args : [])], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : path.dirname(filePath),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });

  let ws = null;
  let rpcId = 0;
  const pending = new Map();
  let stopped = false;
  let currentCallFrames = [];
  let handledEntryPause = false;
  let activeWatches = [...(Array.isArray(watchExpressions) ? watchExpressions : [])];
  let activeBreakpoints = [...(Array.isArray(breakpoints) ? breakpoints : [])];

  const cdp = (method, params = {}) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Debugger WebSocket not connected'));
    const id = ++rpcId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 6000);
      if (timer.unref) timer.unref();
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  const inspectPausedState = async (callFrames) => {
    currentCallFrames = Array.isArray(callFrames) ? callFrames : [];
    const frames = currentCallFrames.map((f) => ({
      callFrameId: f.callFrameId,
      functionName: f.functionName || '(anonymous)',
      url: f.url || '',
      line: ((f.location && f.location.lineNumber) || 0) + 1,
      column: ((f.location && f.location.columnNumber) || 0) + 1,
    }));

    const locals = [];
    const top = currentCallFrames[0];
    if (top && Array.isArray(top.scopeChain)) {
      const localScope = top.scopeChain.find((s) => s.type === 'local' || s.type === 'block') || top.scopeChain[0];
      if (localScope && localScope.object && localScope.object.objectId) {
        try {
          const props = await cdp('Runtime.getProperties', { objectId: localScope.object.objectId, ownProperties: true });
          for (const p of (props.result || []).slice(0, 40)) {
            if (!p || !p.value) continue;
            const val = p.value.value !== undefined
              ? JSON.stringify(p.value.value)
              : (p.value.description || p.value.type || 'undefined');
            locals.push({ name: p.name, type: p.value.type, value: String(val).slice(0, 160) });
          }
        } catch (_) {}
      }
    }

    const watches = [];
    if (top && activeWatches.length) {
      for (const expr of activeWatches) {
        try {
          const ev = await cdp('Debugger.evaluateOnCallFrame', {
            callFrameId: top.callFrameId,
            expression: String(expr),
            returnByValue: false,
          });
          const res = ev && ev.result;
          watches.push({
            expression: expr,
            value: res ? (res.value !== undefined ? JSON.stringify(res.value) : (res.description || res.type)) : 'undefined',
          });
        } catch (err) {
          watches.push({ expression: expr, value: `Error: ${err.message}` });
        }
      }
    }

    emitSafe(onEvent, {
      type: 'paused',
      sessionId,
      language: 'javascript',
      line: frames[0] ? frames[0].line : 1,
      file: filePath,
      frames,
      locals,
      watches,
    });
  };

  proc.stdout.on('data', (chunk) => {
    emitSafe(onEvent, { type: 'output', sessionId, stream: 'stdout', text: chunk.toString('utf8') });
  });

  const wsUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for Node inspector WebSocket')), 8000);
    let errBuf = '';
    proc.stderr.on('data', (chunk) => {
      const txt = chunk.toString('utf8');
      errBuf += txt;
      emitSafe(onEvent, { type: 'output', sessionId, stream: 'stderr', text: txt });
      const m = /Debugger listening on (ws:\/\/[^\s]+)/.exec(errBuf);
      if (m) {
        clearTimeout(timer);
        resolve(m[1].trim());
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      if (!ws) reject(new Error(`Node exited (${code}) before debugger attached`));
    });
  });

  ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw || '')); } catch (_) { return; }
    if (msg.id && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) entry.reject(new Error(msg.error.message || 'CDP error'));
      else entry.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Debugger.paused') {
      const cfs = (msg.params && msg.params.callFrames) || [];
      const topLine = cfs[0] && cfs[0].location ? (cfs[0].location.lineNumber + 1) : 1;
      if (!handledEntryPause && activeBreakpoints.length > 0) {
        handledEntryPause = true;
        if (!activeBreakpoints.includes(topLine)) {
          cdp('Debugger.resume').catch(() => {});
          return;
        }
      }
      handledEntryPause = true;
      inspectPausedState(cfs).catch(() => {});
    } else if (msg.method === 'Debugger.resumed') {
      emitSafe(onEvent, { type: 'resumed', sessionId });
    }
  });

  proc.on('exit', (code) => {
    stopped = true;
    try { ws && ws.close(); } catch (_) {}
    sessions.delete(sessionId);
    emitSafe(onEvent, { type: 'terminated', sessionId, exitCode: code });
  });

  await cdp('Runtime.enable');
  await cdp('Debugger.enable');

  const setBreakpoints = async (lines = []) => {
    let realTarget = path.resolve(filePath);
    try { realTarget = fs.realpathSync(realTarget); } catch (_) {}
    const targetNorm = realTarget.replace(/\\/g, '/');
    const rawNorm = path.resolve(filePath).replace(/\\/g, '/');
    const nums = (Array.isArray(lines) ? lines : [])
      .map((bp) => {
        if (typeof bp === 'number') return bp;
        if (bp && typeof bp === 'object') {
          if (bp.file) {
            let bpReal = path.resolve(String(bp.file));
            try { bpReal = fs.realpathSync(bpReal); } catch (_) {}
            if (bpReal.replace(/\\/g, '/') !== targetNorm) return null;
          }
          return Number(bp.line);
        }
        return Number(bp);
      })
      .filter((n) => Number.isFinite(n) && n > 0);
    activeBreakpoints = nums;
    const urls = [...new Set([
      targetNorm.startsWith('/') ? `file://${targetNorm}` : `file:///${targetNorm}`,
      rawNorm.startsWith('/') ? `file://${rawNorm}` : `file:///${rawNorm}`,
    ])];
    for (const ln of activeBreakpoints) {
      const lineNum = Math.max(0, Number(ln) - 1);
      for (const u of urls) {
        await cdp('Debugger.setBreakpointByUrl', { lineNumber: lineNum, url: u }).catch(() => {});
      }
    }
    return { ok: true, count: activeBreakpoints.length };
  };

  await setBreakpoints(activeBreakpoints);
  await cdp('Runtime.runIfWaitingForDebugger');

  const session = {
    sessionId,
    language: 'javascript',
    filePath,
    async command(action, payload = {}) {
      if (stopped) return { ok: false, error: 'Session terminated' };
      if (action === 'continue') { await cdp('Debugger.resume'); return { ok: true }; }
      if (action === 'stepOver') { await cdp('Debugger.stepOver'); return { ok: true }; }
      if (action === 'stepInto') { await cdp('Debugger.stepInto'); return { ok: true }; }
      if (action === 'stepOut') { await cdp('Debugger.stepOut'); return { ok: true }; }
      if (action === 'setBreakpoints') return await setBreakpoints(payload.breakpoints || []);
      if (action === 'setWatches') {
        activeWatches = Array.isArray(payload.watchExpressions) ? payload.watchExpressions : [];
        return { ok: true, watches: activeWatches };
      }
      if (action === 'evaluate') {
        const top = currentCallFrames[0];
        if (!top) return { ok: false, error: 'Not paused' };
        const ev = await cdp('Debugger.evaluateOnCallFrame', {
          callFrameId: top.callFrameId,
          expression: String(payload.expression || ''),
        });
        const r = ev && ev.result;
        return { ok: true, value: r ? (r.value !== undefined ? JSON.stringify(r.value) : (r.description || r.type)) : 'undefined' };
      }
      if (action === 'stop') {
        try { proc.kill('SIGKILL'); } catch (_) {}
        try { ws.close(); } catch (_) {}
        sessions.delete(sessionId);
        return { ok: true };
      }
      return { ok: false, error: `Unknown debugger action: ${action}` };
    },
    stop() {
      try { proc.kill('SIGKILL'); } catch (_) {}
      try { ws && ws.close(); } catch (_) {}
      sessions.delete(sessionId);
    },
  };
  sessions.set(sessionId, session);
  return session;
}

async function startPythonDebugger({ sessionId, cwd, filePath, args = [], breakpoints = [], watchExpressions = [], onEvent }) {
  const pyBin = resolvePythonBin();
  const proc = spawn(pyBin, ['-u', '-m', 'pdb', filePath, ...(Array.isArray(args) ? args : [])], {
    cwd: cwd && fs.existsSync(cwd) ? cwd : path.dirname(filePath),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });

  let outBuf = '';
  let stopped = false;
  let waitResolver = null;
  let activeWatches = [...(Array.isArray(watchExpressions) ? watchExpressions : [])];

  const sendPdb = (cmd, waitMs = 3000) => {
    if (stopped) return Promise.resolve('');
    return new Promise((resolve) => {
      outBuf = '';
      const timer = setTimeout(() => {
        waitResolver = null;
        resolve(outBuf);
      }, waitMs);
      if (timer.unref) timer.unref();
      waitResolver = (full) => {
        clearTimeout(timer);
        waitResolver = null;
        resolve(full);
      };
      try {
        proc.stdin.write(String(cmd) + '\n');
      } catch (_) {
        clearTimeout(timer);
        waitResolver = null;
        resolve('');
      }
    });
  };

  proc.stdout.on('data', (chunk) => {
    const txt = chunk.toString('utf8');
    outBuf += txt;
    const clean = txt.replace(/__AKRON_LOCALS__[^\n]*\n?/g, '').replace(/\(Pdb\)\s*/g, '');
    if (clean.trim()) emitSafe(onEvent, { type: 'output', sessionId, stream: 'stdout', text: clean });
    if (waitResolver && outBuf.includes('(Pdb)')) {
      waitResolver(outBuf);
    }
  });
  proc.stderr.on('data', (chunk) => {
    emitSafe(onEvent, { type: 'output', sessionId, stream: 'stderr', text: chunk.toString('utf8') });
  });
  proc.on('exit', (code) => {
    stopped = true;
    if (waitResolver) waitResolver(outBuf);
    sessions.delete(sessionId);
    emitSafe(onEvent, { type: 'terminated', sessionId, exitCode: code });
  });

  // Wait for initial (Pdb) prompt
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 4000);
    const poll = setInterval(() => {
      if (outBuf.includes('(Pdb)') || stopped) {
        clearInterval(poll);
        clearTimeout(timer);
        resolve();
      }
    }, 30);
  });

  const emitPausedFromPdb = async (rawBlock = '') => {
    if (stopped) return;
    let line = 1;
    const lm = /\((\d+)\):/.exec(rawBlock);
    if (lm) line = Number(lm[1]) || 1;
    else {
      const wOut = await sendPdb('w', 1500);
      const wm = /\((\d+)\)/.exec(wOut.split('\n').pop() || wOut);
      if (wm) line = Number(wm[1]) || 1;
    }

    const locOut = await sendPdb('import json as _ak_j; print("__AKRON_LOCALS__" + _ak_j.dumps({k: repr(v)[:120] for k, v in locals().items() if not k.startswith("_")}))', 1500);
    const locals = [];
    const jm = /__AKRON_LOCALS__(\{.*\})/.exec(locOut);
    if (jm) {
      try {
        const parsed = JSON.parse(jm[1]);
        for (const [name, value] of Object.entries(parsed)) {
          locals.push({ name, type: 'python', value: String(value) });
        }
      } catch (_) {}
    }

    const watches = [];
    for (const expr of activeWatches) {
      const wres = await sendPdb(`p ${expr}`, 1200);
      const val = wres.replace(/\(Pdb\)/g, '').trim();
      watches.push({ expression: expr, value: val || 'None' });
    }

    emitSafe(onEvent, {
      type: 'paused',
      sessionId,
      language: 'python',
      file: filePath,
      line,
      frames: [{ callFrameId: '0', functionName: path.basename(filePath), url: filePath, line, column: 1 }],
      locals,
      watches,
    });
  };

  const normPyLines = (Array.isArray(breakpoints) ? breakpoints : [])
    .map((bp) => (typeof bp === 'number' ? bp : Number(bp?.line)))
    .filter((n) => Number.isFinite(n) && n > 0);
  for (const ln of normPyLines) {
    await sendPdb(`b ${ln}`, 1200);
  }
  if (normPyLines.length > 0) {
    const r = await sendPdb('c', 5000);
    await emitPausedFromPdb(r);
  } else {
    await emitPausedFromPdb(outBuf);
  }

  const session = {
    sessionId,
    language: 'python',
    filePath,
    async command(action, payload = {}) {
      if (stopped) return { ok: false, error: 'Session terminated' };
      if (action === 'continue') { const r = await sendPdb('c', 5000); await emitPausedFromPdb(r); return { ok: true }; }
      if (action === 'stepOver') { const r = await sendPdb('n', 3000); await emitPausedFromPdb(r); return { ok: true }; }
      if (action === 'stepInto') { const r = await sendPdb('s', 3000); await emitPausedFromPdb(r); return { ok: true }; }
      if (action === 'stepOut') { const r = await sendPdb('r', 3000); await emitPausedFromPdb(r); return { ok: true }; }
      if (action === 'setWatches') {
        activeWatches = Array.isArray(payload.watchExpressions) ? payload.watchExpressions : [];
        return { ok: true, watches: activeWatches };
      }
      if (action === 'evaluate') {
        const r = await sendPdb(`p ${String(payload.expression || '')}`, 1500);
        return { ok: true, value: r.replace(/\(Pdb\)/g, '').trim() };
      }
      if (action === 'stop') {
        try { proc.stdin.write('q\n'); } catch (_) {}
        try { proc.kill('SIGKILL'); } catch (_) {}
        sessions.delete(sessionId);
        return { ok: true };
      }
      return { ok: false, error: `Unknown pdb action: ${action}` };
    },
    stop() {
      try { proc.stdin.write('q\n'); } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
      sessions.delete(sessionId);
    },
  };
  sessions.set(sessionId, session);
  return session;
}

async function startDebug({ cwd = process.cwd(), filePath, args = [], breakpoints = [], watchExpressions = [], onEvent } = {}) {
  const abs = path.resolve(String(filePath || ''));
  if (!abs || !fs.existsSync(abs)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }
  const sessionId = `dbg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 5)}`;
  const ext = path.extname(abs).toLowerCase();
  if (ext === '.py') {
    const s = await startPythonDebugger({ sessionId, cwd, filePath: abs, args, breakpoints, watchExpressions, onEvent });
    return { ok: true, sessionId: s.sessionId, language: 'python', filePath: abs };
  }
  if (/^\.(js|mjs|cjs)$/.test(ext)) {
    const s = await startNodeDebugger({ sessionId, cwd, filePath: abs, args, breakpoints, watchExpressions, onEvent });
    return { ok: true, sessionId: s.sessionId, language: 'javascript', filePath: abs };
  }
  return { ok: false, error: `Debugger supports Node (.js/.mjs/.cjs) and Python (.py); got "${ext}"` };
}

async function debugCommand({ sessionId, action, breakpoints, watchExpressions, expression } = {}) {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: `Debug session not running: ${sessionId}` };
  return await s.command(action, { breakpoints, watchExpressions, expression });
}

function stopAllDebuggers() {
  for (const s of [...sessions.values()]) {
    try { s.stop(); } catch (_) {}
  }
  sessions.clear();
}

module.exports = {
  startDebug,
  debugCommand,
  stopAllDebuggers,
};
