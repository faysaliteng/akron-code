'use strict';
/**
 * Windows: no console window for Akron's child processes.
 *
 * Every console program Akron starts (git, node, PowerShell, the CLI runtimes,
 * ripgrep, MCP servers) opens its own console window on Windows unless
 * `windowsHide: true` is passed. About forty call sites did not pass it, so a
 * black console flashed at launch and on git / Computer Use / MCP activity.
 *
 * `install()` makes `windowsHide: true` the default for every child_process
 * function. It must run before other modules destructure child_process
 * (`const { spawn } = require('child_process')`), i.e. first in main.js.
 * A call that sets `windowsHide` explicitly keeps its value.
 */
const cp = require('child_process');

const FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

const isOpts = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Return the argument list with `windowsHide: true` defaulted in its options object. */
function withHide(args) {
  const out = args.slice();
  // The options object follows the command (and the args array, when given).
  let idx = Array.isArray(out[1]) || (out[1] == null && out.length > 2) ? 2 : 1;
  if (isOpts(out[idx])) {
    if (out[idx].windowsHide === undefined) out[idx] = { ...out[idx], windowsHide: true };
  } else if (out[idx] === undefined || typeof out[idx] === 'function') {
    if (idx === 2 && out[1] == null) out[1] = [];
    out.splice(idx, 0, { windowsHide: true });
  }
  return out;
}

function install({ platform = process.platform, target = cp } = {}) {
  if (platform !== 'win32' || target.__akronWindowsHide) return false;
  for (const name of FNS) {
    const orig = target[name];
    if (typeof orig !== 'function') continue;
    target[name] = function akronHidden(...args) { return orig.apply(this, withHide(args)); };
  }
  Object.defineProperty(target, '__akronWindowsHide', { value: true });
  return true;
}

module.exports = { install, withHide };
