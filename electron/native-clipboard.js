'use strict';
const { spawnSync: defaultSpawnSync } = require('child_process');

/**
 * Create a cross-platform native clipboard helper with read-back verification,
 * write deduplication, and native OS CLI fallbacks for macOS, Windows, and Linux.
 */
function createNativeClipboard({
  clipboardImpl = null,
  spawnSyncImpl = defaultSpawnSync,
  platform = process.platform,
  env = process.env,
} = {}) {
  let lastWriteText = '';
  let lastWriteAt = 0;

  function utf8Env() {
    return {
      ...env,
      LANG: (env && env.LANG) || 'en_US.UTF-8',
      LC_ALL: (env && env.LC_ALL) || 'en_US.UTF-8',
    };
  }

  function runReadCmd(cmd, args, opts = {}) {
    try {
      const r = spawnSyncImpl(cmd, args, {
        encoding: 'utf8',
        timeout: opts.timeout || 2000,
        windowsHide: true,
        ...(opts.env ? { env: opts.env } : {}),
      });
      if (r && r.status === 0 && typeof r.stdout === 'string' && r.stdout.length > 0) {
        return r.stdout;
      }
    } catch (_) {}
    return '';
  }

  function runWriteCmd(cmd, args, str, opts = {}) {
    try {
      const r = spawnSyncImpl(cmd, args, {
        input: str,
        encoding: 'utf8',
        timeout: opts.timeout || 2000,
        windowsHide: true,
        ...(opts.env ? { env: opts.env } : {}),
      });
      return !!(r && r.status === 0);
    } catch (_) {
      return false;
    }
  }

  function readElectronText() {
    try {
      if (clipboardImpl && typeof clipboardImpl.readText === 'function') {
        const t = clipboardImpl.readText();
        return typeof t === 'string' ? t : '';
      }
    } catch (_) {}
    return '';
  }

  function readNativeClipboard() {
    const direct = readElectronText();
    if (direct) return direct;

    if (platform === 'darwin') {
      return runReadCmd('/usr/bin/pbpaste', [], { env: utf8Env() });
    }
    if (platform === 'win32') {
      const raw = runReadCmd('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw',
      ], { timeout: 2500 });
      return raw.replace(/\r?\n$/, '');
    }
    if (platform === 'linux') {
      if (env && env.WAYLAND_DISPLAY) {
        const wl = runReadCmd('wl-paste', ['--no-newline']);
        if (wl) return wl;
      }
      const xclip = runReadCmd('xclip', ['-selection', 'clipboard', '-o']);
      if (xclip) return xclip;
      const xsel = runReadCmd('xsel', ['--clipboard', '--output']);
      if (xsel) return xsel;
      const wl = runReadCmd('wl-paste', ['--no-newline']);
      if (wl) return wl;
    }
    return '';
  }

  function writeNativeClipboard(text, html = '', opts = {}) {
    const str = String(text == null ? '' : text);
    if (!str) return opts.detailed ? { ok: false, verified: false } : false;
    const now = Date.now();
    if (!opts.skipDedupe && str === lastWriteText && (now - lastWriteAt) < 200) {
      return opts.detailed ? { ok: true, verified: true, deduped: true } : true;
    }
    lastWriteText = str;
    lastWriteAt = now;

    let ok = false;
    let verified = false;
    try {
      if (clipboardImpl) {
        if (html && typeof clipboardImpl.write === 'function') {
          clipboardImpl.write({ text: str, html: String(html) });
        } else if (typeof clipboardImpl.writeText === 'function') {
          clipboardImpl.writeText(str);
        }
        if (typeof clipboardImpl.readText === 'function' && clipboardImpl.readText() === str) {
          ok = true;
          verified = true;
        }
      }
    } catch (_) {}

    if (!ok || platform === 'darwin') {
      if (platform === 'darwin') {
        if (runWriteCmd('/usr/bin/pbcopy', [], str, { env: utf8Env() })) {
          ok = true;
          if (!verified) {
            const readBack = readElectronText() || runReadCmd('/usr/bin/pbpaste', [], { env: utf8Env() });
            verified = readBack === str;
          }
        }
      } else if (platform === 'win32') {
        const psOk = runWriteCmd('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '[Console]::InputEncoding = [System.Text.Encoding]::UTF8; $input | Set-Clipboard',
        ], str, { timeout: 2500 });
        if (psOk) {
          ok = true;
        } else if (runWriteCmd('clip', [], str, { timeout: 2000 })) {
          ok = true;
        }
        if (ok && !verified) {
          verified = readElectronText() === str;
        }
      } else if (platform === 'linux') {
        const candidates = env && env.WAYLAND_DISPLAY
          ? [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]]
          : [['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']], ['wl-copy', []]];
        for (const [cmd, args] of candidates) {
          if (runWriteCmd(cmd, args, str)) {
            ok = true;
            break;
          }
        }
        if (ok && !verified) {
          verified = readElectronText() === str;
        }
      }
    }

    return opts.detailed ? { ok, verified } : ok;
  }

  function readClipboardImagePayload() {
    try {
      if (!clipboardImpl || typeof clipboardImpl.readImage !== 'function') {
        return { ok: true, hasImage: false };
      }
      const img = clipboardImpl.readImage();
      if (!img || img.isEmpty()) return { ok: true, hasImage: false };
      const size = img.getSize();
      return {
        ok: true,
        hasImage: true,
        dataUrl: img.toDataURL(),
        width: size.width,
        height: size.height,
      };
    } catch (err) {
      return { ok: false, hasImage: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function resetDedupe() {
    lastWriteText = '';
    lastWriteAt = 0;
  }

  return {
    writeNativeClipboard,
    readNativeClipboard,
    readClipboardImagePayload,
    resetDedupe,
  };
}

module.exports = { createNativeClipboard };
