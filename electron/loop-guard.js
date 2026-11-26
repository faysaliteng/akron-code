'use strict';

const fs = require('fs');

function stableStringify(val) {
  if (val === null || val === undefined) return String(val);
  if (typeof val !== 'object') return JSON.stringify(val);
  if (Array.isArray(val)) return '[' + val.map(stableStringify).join(',') + ']';
  const keys = Object.keys(val).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(val[k])).join(',') + '}';
}

function toolSignature(name, args) {
  try {
    return `${String(name || '')}|${stableStringify(args || {})}`;
  } catch (_) {
    return `${String(name || '')}|?`;
  }
}

function targetPathFromArgs(args) {
  if (!args || typeof args !== 'object') return '';
  return String(args.file_path || args.path || args.filePath || args.filename || args.notebook_path || '');
}

const READ_NAMES = new Set(['Read', 'mcp__workspace__read_file']);
const EDIT_NAMES = new Set(['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'mcp__workspace__write_file', 'mcp__workspace__edit_file']);

function createLoopGuard({ circuitBreakerThreshold = 8 } = {}) {
  let lastSig = '';
  let consecutiveCount = 0;
  const sigCounts = new Map();
  const recentHistory = []; // { name, target, isError }

  function beforeCall(name, args) {
    const sig = toolSignature(name, args);
    if (sig === lastSig) consecutiveCount += 1;
    else {
      lastSig = sig;
      consecutiveCount = 1;
    }
    const totalSame = (sigCounts.get(sig) || 0) + 1;
    sigCounts.set(sig, totalSame);

    if (consecutiveCount >= circuitBreakerThreshold) {
      return {
        blocked: true,
        sig,
        consecutiveCount,
        totalSame,
        reason: `[LOOP GUARD CIRCUIT BREAKER — ${consecutiveCount} repeats] Halted "${name}" because the identical tool call was repeated ${consecutiveCount} times without progress. Change strategy, inspect another file/command, or summarize the blocker for the user.`,
      };
    }

    return { blocked: false, sig, consecutiveCount, totalSame };
  }

  function afterCall(name, args, { isError = false } = {}) {
    const sig = toolSignature(name, args);
    const target = targetPathFromArgs(args);
    recentHistory.push({ name, target, isError: !!isError });
    if (recentHistory.length > 20) recentHistory.shift();

    // Detect cyclical Read -> Edit(fail) -> Read -> Edit(fail) loops on the same file
    let cycleCount = 0;
    if (target && EDIT_NAMES.has(name) && isError) {
      for (const h of recentHistory) {
        if (h.target === target && h.isError && EDIT_NAMES.has(h.name)) cycleCount++;
      }
    }
    const repeatedSameSig = consecutiveCount;
    const totalSameSig = sigCounts.get(sig) || repeatedSameSig;

    if (repeatedSameSig === 5 || (totalSameSig >= 5 && totalSameSig < circuitBreakerThreshold && repeatedSameSig >= 4) || cycleCount >= 4) {
      return {
        level: 'strong',
        note: `[LOOP GUARD — ${Math.max(repeatedSameSig, cycleCount)} repeats] Persistent loop detected on "${name}"${target ? ` (${target})` : ''}. Stop repeating this failing pattern; pick a completely different approach before the circuit breaker halts at ${circuitBreakerThreshold} repeats.`,
      };
    }

    if (repeatedSameSig === 3 || cycleCount === 3) {
      return {
        level: 'advisory',
        note: `[LOOP GUARD — ${Math.max(repeatedSameSig, cycleCount)} repeats] "${name}" has now repeated ${Math.max(repeatedSameSig, cycleCount)} times. Re-read the error/output carefully and adjust arguments or strategy instead of retrying verbatim.`,
      };
    }

    if (repeatedSameSig >= 2) {
      return {
        level: 'nudge',
        note: '', // caller uses existing compatible hint when level === 'nudge'
      };
    }

    return null;
  }

  return {
    beforeCall,
    afterCall,
    getState: () => ({
      lastSig,
      consecutiveCount,
      recentCount: recentHistory.length,
    }),
  };
}

/**
 * Non-blocking read for named pipes (FIFOs) so attempting to Read an idle FIFO
 * never blocks Electron's thread indefinitely.
 */
function readFifoNonBlocking(filePath, { timeoutMs = 20000, maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve) => {
    const flags = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0);
    let fd = null;
    try {
      fd = fs.openSync(filePath, flags);
    } catch (err) {
      if (err && (err.code === 'ENXIO' || err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) {
        return resolve({ ok: false, error: `Error: ${filePath} is a FIFO/named pipe with no active writer.` });
      }
      return resolve({ ok: false, error: `Error opening FIFO ${filePath}: ${err && err.message ? err.message : String(err)}` });
    }

    let settled = false;
    let total = 0;
    const chunks = [];
    const stream = fs.createReadStream(filePath, { fd, autoClose: true, highWaterMark: 16384 });
    const cleanup = () => {
      try { stream.destroy(); } catch (_) {}
      try { if (fd != null) fs.closeSync(fd); } catch (_) {}
      fd = null;
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      const partial = Buffer.concat(chunks).toString('utf8');
      resolve({
        ok: false,
        timedOut: true,
        error: `Error: timed out after ${Math.round(timeoutMs / 1000)}s reading FIFO/named pipe ${filePath}${partial ? ` (partial ${total} bytes read)` : ''}.`,
      });
    }, Math.max(10, Number(timeoutMs) || 20000));
    if (timer && typeof timer.unref === 'function') timer.unref();

    stream.on('data', (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(buf);
      total += buf.length;
      if (total >= maxBytes && !settled) {
        settled = true;
        clearTimeout(timer);
        cleanup();
        resolve({
          ok: true,
          truncated: true,
          content: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8'),
        });
      }
    });
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fd = null;
      if (total === 0) {
        return resolve({ ok: false, error: `Error: ${filePath} is a FIFO/named pipe with no active writer (EOF).` });
      }
      resolve({ ok: true, truncated: false, content: Buffer.concat(chunks).toString('utf8') });
    });
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      if (err && (err.code === 'EAGAIN' || err.code === 'EWOULDBLOCK')) {
        const partial = Buffer.concat(chunks).toString('utf8');
        return resolve(partial
          ? { ok: true, truncated: false, content: partial }
          : { ok: false, error: `Error: FIFO/named pipe ${filePath} has no data ready (EAGAIN).` });
      }
      resolve({ ok: false, error: `Error reading FIFO ${filePath}: ${err && err.message ? err.message : String(err)}` });
    });
  });
}

module.exports = {
  stableStringify,
  toolSignature,
  createLoopGuard,
  readFifoNonBlocking,
  READ_NAMES,
  EDIT_NAMES,
};
