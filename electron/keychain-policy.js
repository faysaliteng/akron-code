'use strict';
/**
 * When should this build use the macOS keychain?
 *
 * Every keychain item carries a "partition list" of who may read it without a
 * password prompt. For an app with an Apple Team ID the partition is
 * `teamid:<ID>`, which survives updates. For an app WITHOUT one (self-signed or
 * ad-hoc, like local and CI builds of Akron Code) macOS records `cdhash:<hash>`
 * — the exact binary — so every new build or update is a stranger again and
 * macOS asks for the login password, even after "Always Allow".
 * Measured on "Akron Code Safe Storage": 28 cdhash partitions, one per build.
 *
 * Such a build cannot be remembered by the keychain, so it does not use it:
 * Chromium's cookie key comes from Chromium's mock keychain, and Akron's own
 * secrets live in ~/.autobot/master.key (see secretstore.js). A build signed
 * with a Developer ID (Team ID present) keeps the real keychain, where one
 * "Always Allow" lasts across updates.
 *
 * Linux: Chromium keeps its cookie key in the desktop keyring (GNOME Keyring /
 * KWallet), which on many setups (Kali, root sessions, no keyring daemon) asks
 * to create or unlock a keyring. Same policy: the basic store unless opted in.
 * Windows uses DPAPI, which never prompts, and is left alone.
 *
 * Override: AKRON_USE_SAFE_STORAGE=1 always uses the real keychain/keyring;
 *           AKRON_USE_SAFE_STORAGE=0 never does.
 */
const path = require('path');
const { spawnSync } = require('child_process');

function bundlePathOf(execPath) {
  // …/Akron Code.app/Contents/MacOS/Akron Code -> …/Akron Code.app
  const p = String(execPath || '');
  const i = p.indexOf('.app/Contents/MacOS/');
  return i >= 0 ? p.slice(0, i + 4) : '';
}

function teamIdOf(bundle) {
  if (!bundle) return '';
  try {
    const r = spawnSync('/usr/bin/codesign', ['-dv', bundle], { encoding: 'utf8', timeout: 3000 });
    const m = /TeamIdentifier=([A-Z0-9]{10})\b/.exec(String(r.stderr || '') + String(r.stdout || ''));
    return m ? m[1] : '';
  } catch (_) {
    return '';
  }
}

/** Decide, and apply before `app.whenReady()`. Returns the decision for logging/tests. */
function apply(app, opts = {}) {
  const platform = opts.platform || process.platform;
  const env = opts.env || process.env;
  if (platform === 'linux') {
    if (env.AKRON_USE_SAFE_STORAGE === '1') return { keychain: 'real', reason: 'AKRON_USE_SAFE_STORAGE=1' };
    try { app.commandLine.appendSwitch('password-store', 'basic'); } catch (_) {}
    return { keychain: 'basic', reason: 'no desktop-keyring prompt (Linux)' };
  }
  if (platform !== 'darwin') return { keychain: 'os-default' };
  if (env.AKRON_USE_SAFE_STORAGE === '1') return { keychain: 'real', reason: 'AKRON_USE_SAFE_STORAGE=1' };
  const packaged = opts.packaged != null ? opts.packaged : Boolean(app && app.isPackaged);
  const forceOff = env.AKRON_USE_SAFE_STORAGE === '0';
  if (!packaged && !forceOff) return { keychain: 'real', reason: 'development run' };
  const team = forceOff ? '' : (opts.teamId != null ? opts.teamId : teamIdOf(bundlePathOf(opts.execPath || process.execPath)));
  if (team) return { keychain: 'real', reason: 'signed with Team ID ' + team };
  try { app.commandLine.appendSwitch('use-mock-keychain'); } catch (_) {}
  return { keychain: 'mock', reason: forceOff ? 'AKRON_USE_SAFE_STORAGE=0' : 'no Team ID: macOS cannot remember this build in the keychain' };
}

module.exports = { apply, teamIdOf, bundlePathOf };
