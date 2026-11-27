'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
    assert(mainSrc.includes('ipcMain.handle(\'autobot:clipboardWrite\''), 'clipboardWrite IPC missing');
    assert(mainSrc.includes('ipcMain.handle(\'autobot:clipboardRead\''), 'clipboardRead IPC missing');
    assert(mainSrc.includes('ipcMain.handle(\'autobot:clipboardReadImage\''), 'clipboardReadImage IPC missing');
    assert(!mainSrc.includes('executeJavaScript(\n        \'(function(){try{return window.__akronGetSelectedText'), 'main.js must not race renderer before-input-event on Cmd+C');
    assert(preloadSrc.includes('clipboardWrite:'), 'preload clipboardWrite missing');
    assert(preloadSrc.includes('clipboardRead:'), 'preload clipboardRead missing');
    assert(preloadSrc.includes('clipboardReadImage:'), 'preload clipboardReadImage missing');
  });

  it('appHelpers.jsx handles Cmd+C/Ctrl+C, macOS Ctrl+V/Ctrl+X/Ctrl+A, and debounced toast emission', () => {
    const helpersSrc = fs.readFileSync(path.join(root, 'src/utils/appHelpers.jsx'), 'utf8');
    assert(helpersSrc.includes('export async function copyTextToClipboard'), 'copyTextToClipboard missing');
    assert(helpersSrc.includes('export async function readTextFromClipboard'), 'readTextFromClipboard missing');
    assert(helpersSrc.includes('function insertTextIntoEditable'), 'insertTextIntoEditable missing');
    assert(helpersSrc.includes('function emitCopiedOnce'), 'emitCopiedOnce debounce missing');
    assert(helpersSrc.includes("isMac && e.ctrlKey && !e.metaKey"), 'macOS Ctrl+V/X/A override missing');
  });

  it('InputBarView.jsx auto-expands composer textarea height on paste and sync', () => {
    const inputBarSrc = fs.readFileSync(path.join(root, 'src/components/chat/InputBarView.jsx'), 'utf8');
    assert(inputBarSrc.includes('resizeTextarea'), 'resizeTextarea missing');
    assert(inputBarSrc.includes('clipboardReadImage'), 'clipboardReadImage paste fallback missing');
    assert(inputBarSrc.includes('syncInputState(inputRef.current.value)'), 'post-paste syncInputState missing');
  });
});
