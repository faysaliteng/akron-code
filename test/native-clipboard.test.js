'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createNativeClipboard } = require('../electron/native-clipboard');

const root = path.resolve(__dirname, '..');

describe('Native OS Clipboard & Universal Copy/Paste Contracts', () => {
  it('supports multi-paragraph UTF-8 roundtrip via native macOS pbcopy/pbpaste', () => {
    if (process.platform !== 'darwin') return;
    const sample = [
      'Line 1: Both files still pass a syntax check.',
      '',
      'Line 2: Why images don\'t show in chat 🚀',
      'Line 3: `console.log("Akron Code");` — last line intact!',
    ].join('\n');
    const prev = (spawnSync('/usr/bin/pbpaste', { encoding: 'utf8' }).stdout) || '';
    try {
      const wr = spawnSync('/usr/bin/pbcopy', [], {
        input: sample,
        encoding: 'utf8',
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      });
      assert.equal(wr.status, 0);
      const rd = spawnSync('/usr/bin/pbpaste', {
        encoding: 'utf8',
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      });
      assert.equal(rd.status, 0);
      assert.equal(rd.stdout, sample);
    } finally {
      spawnSync('/usr/bin/pbcopy', [], {
        input: prev,
        encoding: 'utf8',
        env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      });
    }
  });

  it('electron/main.js and preload.js wire verified native clipboard + clipboardReadImage without racing keydown listeners', () => {
    const mainSrc = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
    const preloadSrc = fs.readFileSync(path.join(root, 'electron/preload.js'), 'utf8');
    assert(mainSrc.includes('function writeNativeClipboard'), 'writeNativeClipboard missing');
    assert(mainSrc.includes("ipcMain.handle('autobot:clipboardWrite'"), 'clipboardWrite IPC missing');
    assert(mainSrc.includes("ipcMain.handle('autobot:clipboardRead'"), 'clipboardRead IPC missing');
    assert(mainSrc.includes("ipcMain.handle('autobot:clipboardReadImage'"), 'clipboardReadImage IPC missing');
    assert(!mainSrc.includes("executeJavaScript(\n        '(function(){try{return window.__akronGetSelectedText"), 'main.js must not race renderer before-input-event on Cmd+C');
    assert(preloadSrc.includes('clipboardWrite:'), 'preload clipboardWrite missing');
    assert(preloadSrc.includes('clipboardRead:'), 'preload clipboardRead missing');
    assert(preloadSrc.includes('clipboardReadImage:'), 'preload clipboardReadImage missing');
  });

  it('appHelpers.jsx handles Cmd+C/Ctrl+C, macOS Ctrl+V/Ctrl+X/Ctrl+A without Cocoa pageDown, guards Monaco & xterm, and uses native value setter', () => {
    const helpersSrc = fs.readFileSync(path.join(root, 'src/utils/appHelpers.jsx'), 'utf8');
    assert(helpersSrc.includes('export async function copyTextToClipboard'), 'copyTextToClipboard missing');
    assert(helpersSrc.includes('export async function readTextFromClipboard'), 'readTextFromClipboard missing');
    assert(helpersSrc.includes('function insertTextIntoEditable'), 'insertTextIntoEditable missing');
    assert(helpersSrc.includes('function setNativeInputValue'), 'setNativeInputValue React tracker setter missing');
    assert(helpersSrc.includes('HTMLTextAreaElement.prototype'), 'HTMLTextAreaElement.prototype setter missing');
    assert(helpersSrc.includes('function emitCopiedOnce'), 'emitCopiedOnce debounce missing');
    assert(helpersSrc.includes("isMac && e.ctrlKey && !e.metaKey"), 'macOS Ctrl+V/X/A override missing');
    assert(helpersSrc.includes("ae.closest('.monaco-editor')"), 'Monaco guard missing');
    assert(helpersSrc.includes("ae.closest('.xterm')"), 'xterm guard missing');
    assert(helpersSrc.includes("'akron:clipboard-image'"), 'clipboard image event bridge missing');
  });

  it('InputBarView.jsx auto-expands composer textarea height (24px-200px) on paste and sync', () => {
    const inputBarSrc = fs.readFileSync(path.join(root, 'src/components/chat/InputBarView.jsx'), 'utf8');
    assert(inputBarSrc.includes('resizeTextarea'), 'resizeTextarea missing');
    assert(inputBarSrc.includes('Math.min(200, Math.max(24'), '24px-200px textarea clamp missing');
    assert(inputBarSrc.includes('clipboardReadImage'), 'clipboardReadImage paste fallback missing');
    assert(inputBarSrc.includes('akron:clipboard-image'), 'akron:clipboard-image listener missing');
    assert(inputBarSrc.includes('syncInputState(inputRef.current.value)'), 'post-paste syncInputState missing');
  });

  it('verifies Electron clipboard.write / clipboard.readText read-back verification and 200ms dedupe guard', () => {
    let memText = '';
    let memHtml = '';
    let writeCalls = 0;
    const clipboardImpl = {
      write({ text, html }) {
        writeCalls++;
        memText = text;
        memHtml = html || '';
      },
      writeText(t) {
        writeCalls++;
        memText = t;
      },
      readText() {
        return memText;
      },
      readImage() {
        return {
          isEmpty: () => false,
          getSize: () => ({ width: 320, height: 180 }),
          toDataURL: () => 'data:image/png;base64,iVBORw0KGgo=',
        };
      },
    };
    const clip = createNativeClipboard({
      clipboardImpl,
      spawnSyncImpl: () => ({ status: 0, stdout: '' }),
      platform: 'linux',
      env: {},
    });

    const r1 = clip.writeNativeClipboard('Hello\nWorld 🚀', '<b>Hello</b>', { detailed: true });
    assert.deepEqual(r1, { ok: true, verified: true });
    assert.equal(memHtml, '<b>Hello</b>');
    assert.equal(clip.readNativeClipboard(), 'Hello\nWorld 🚀');

    // Immediate duplicate write within 200ms should dedupe without invoking clipboardImpl again
    const r2 = clip.writeNativeClipboard('Hello\nWorld 🚀', '', { detailed: true });
    assert.equal(r2.ok, true);
    assert.equal(r2.deduped, true);
    assert.equal(writeCalls, 1);

    const img = clip.readClipboardImagePayload();
    assert.equal(img.ok, true);
    assert.equal(img.hasImage, true);
    assert.equal(img.width, 320);
    assert.equal(img.height, 180);
    assert(img.dataUrl.startsWith('data:image/png;base64,'));
  });

  it('exercises Windows fallback commands (PowerShell UTF-8 Set-Clipboard / Get-Clipboard and clip fallback)', () => {
    const calls = [];
    let electronText = '';
    const clip = createNativeClipboard({
      clipboardImpl: {
        writeText: () => { throw new Error('clipboard lock'); },
        readText: () => electronText,
      },
      platform: 'win32',
      env: {},
      spawnSyncImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts && opts.input });
        if (cmd === 'powershell.exe' && opts && opts.input) {
          return { status: 1, stdout: '' }; // simulate PowerShell unavailable -> must fall back to clip
        }
        if (cmd === 'clip') {
          return { status: 0, stdout: '' };
        }
        if (cmd === 'powershell.exe') {
          return { status: 0, stdout: 'Win Clipboard Text 🚀\r\n' };
        }
        return { status: 1, stdout: '' };
      },
    });

    const ok = clip.writeNativeClipboard('Win Text');
    assert.equal(ok, true);
    assert.equal(calls[0].cmd, 'powershell.exe');
    assert.equal(calls[1].cmd, 'clip');
    assert.equal(calls[1].input, 'Win Text');

    assert.equal(clip.readNativeClipboard(), 'Win Clipboard Text 🚀');
    electronText = 'Electron Win Text';
    assert.equal(clip.readNativeClipboard(), 'Electron Win Text');
  });

  it('exercises Linux fallback commands (wl-copy / xclip / xsel)', () => {
    const x11Calls = [];
    const x11Clip = createNativeClipboard({
      clipboardImpl: {
        writeText: () => {},
        readText: () => '', // force native CLI fallback on write + read
      },
      platform: 'linux',
      env: {},
      spawnSyncImpl: (cmd, args, opts) => {
        x11Calls.push({ cmd, args, input: opts && opts.input });
        if (cmd === 'xclip' && opts && opts.input) return { status: 0, stdout: '' };
        if (cmd === 'xclip' && args.includes('-o')) return { status: 0, stdout: 'From xclip' };
        return { status: 1, stdout: '' };
      },
    });

    assert.equal(x11Clip.writeNativeClipboard('X11 payload'), true);
    assert.equal(x11Calls[0].cmd, 'xclip');
    assert.deepEqual(x11Calls[0].args, ['-selection', 'clipboard']);
    assert.equal(x11Clip.readNativeClipboard(), 'From xclip');

    const wlCalls = [];
    const wlClip = createNativeClipboard({
      clipboardImpl: { writeText: () => {}, readText: () => '' },
      platform: 'linux',
      env: { WAYLAND_DISPLAY: 'wayland-0' },
      spawnSyncImpl: (cmd, args, opts) => {
        wlCalls.push({ cmd, args, input: opts && opts.input });
        if (cmd === 'wl-copy') return { status: 0, stdout: '' };
        if (cmd === 'wl-paste') return { status: 0, stdout: 'From wl-paste' };
        return { status: 1, stdout: '' };
      },
    });

    assert.equal(wlClip.writeNativeClipboard('Wayland payload'), true);
    assert.equal(wlCalls[0].cmd, 'wl-copy');
    assert.equal(wlClip.readNativeClipboard(), 'From wl-paste');
    assert.equal(wlCalls[1].cmd, 'wl-paste');
    assert.deepEqual(wlCalls[1].args, ['--no-newline']);
  });
});
