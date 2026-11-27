'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PNG } = require('pngjs');
const jpeg = require('jpeg-js');

const router = require('../electron/orch-router');
const mediaGen = require('../electron/media-gen');
const depManager = require('../electron/dep-manager');
const createRuntimesController = require('../electron/ipc/ipc-runtimes');
const { runTool } = require('../electron/tools');

const root = path.resolve(__dirname, '..');

describe('Zero-Mock Production Audit', () => {
  it('separates chat OAuth logins from paid media API keys in orch-router catalog and routing', async () => {
    const oauthOnlyAccts = [
      { id: 'claude-max', provider: 'claude', needsSignIn: false, expired: false },
      { id: 'chatgpt-codex', provider: 'chatgpt', needsSignIn: false, expired: false },
      { id: 'google-ag', provider: 'antigravity', needsSignIn: false, expired: false },
      { id: 'xai-cli', provider: 'grok', needsSignIn: false, expired: false },
    ];

    const catalogOauthOnly = router.listMediaStudioCatalog({
      store: false,
      env: {},
      oauthAccounts: oauthOnlyAccts,
    });
    for (const id of ['veo-2.0-generate-001', 'sora', 'grok-2-video']) {
      const row = catalogOauthOnly.videoModels.find((m) => m.id === id);
      assert(row, `missing video catalog row ${id}`);
      assert.equal(row.available, false, `${id} must NOT appear available with OAuth-only chat sessions`);
      assert.equal(row.statusLabel, 'Needs API Key');
    }
    for (const id of ['gpt-image-1', 'dall-e-3', 'imagen-3.0-generate-002', 'gemini-2.5-flash-image', 'grok-2-image']) {
      const row = catalogOauthOnly.imageModels.find((m) => m.id === id);
      assert(row, `missing image catalog row ${id}`);
      assert.equal(row.available, false, `${id} must NOT appear available without an image API key`);
      assert.equal(row.statusLabel, 'Needs API Key');
    }

    const catalogWithKeys = router.listMediaStudioCatalog({
      store: false,
      env: { GEMINI_API_KEY: 'gm-test', OPENAI_API_KEY: 'oa-test', XAI_API_KEY: 'xai-test' },
      oauthAccounts: oauthOnlyAccts,
    });
    for (const id of ['veo-2.0-generate-001', 'sora', 'grok-2-video']) {
      const row = catalogWithKeys.videoModels.find((m) => m.id === id);
      assert.equal(row.available, true, `${id} must be available when API key is configured`);
      assert.equal(row.statusLabel, 'Available');
    }
    for (const id of ['gpt-image-1', 'dall-e-3', 'imagen-3.0-generate-002', 'gemini-2.5-flash-image', 'grok-2-image']) {
      const row = catalogWithKeys.imageModels.find((m) => m.id === id);
      assert.equal(row.available, true, `${id} must be available when API key is configured`);
      assert.equal(row.statusLabel, 'Available');
    }

    // Honest offline fallback attribution (never claims requested frontier model offline)
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-audit-offline-'));
    try {
      const imgOut = path.join(tmp, 'offline.png');
      const imgRes = await mediaGen.generateImage(
        { prompt: 'Emerald Studio Card', model: 'gpt-image-1', forceOffline: true, output_path: imgOut },
        { cwd: tmp, store: false }
      );
      assert.equal(imgRes.model, 'akron-svg-canvas-studio');
      assert.equal(imgRes.backend, 'offline-image-studio');

      const vidOut = path.join(tmp, 'offline.mp4');
      const vidRes = await mediaGen.generateVideo(
        { prompt: 'Emerald Motion', model: 'veo-2.0-generate-001', duration_sec: 1, forceOffline: true, output_path: vidOut },
        { cwd: tmp, store: false }
      );
      assert.equal(vidRes.model, 'akron-motion-canvas-30fps');
      assert.equal(vidRes.backend, 'offline-video-studio');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('decodes images by magic bytes first and trims trailing bytes after PNG IEND', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-magic-bytes-'));
    try {
      // 1. Real JPEG bytes written with a misleading .png extension
      const w = 64;
      const h = 48;
      const rgba = Buffer.alloc(w * h * 4);
      for (let i = 0; i < rgba.length; i += 4) {
        rgba[i] = 16; rgba[i + 1] = 185; rgba[i + 2] = 129; rgba[i + 3] = 255;
      }
      const jpgEnc = jpeg.encode({ data: rgba, width: w, height: h }, 90);
      const misleadingPng = path.join(tmp, 'misleading.png');
      fs.writeFileSync(misleadingPng, jpgEnc.data);

      const upRes = await mediaGen.editImage(
        { input_path: misleadingPng, operation: 'upscale', output_path: path.join(tmp, 'upscaled.png') },
        { cwd: tmp }
      );
      assert.equal(upRes.ok, true);
      assert.equal(upRes.width, 128);
      assert.equal(upRes.height, 96);

      // 2. Real PNG buffer with 64 garbage bytes appended after IEND
      const png = new PNG({ width: w, height: h });
      rgba.copy(png.data);
      const cleanPngBuf = PNG.sync.write(png);
      const trailingPng = path.join(tmp, 'trailing.png');
      fs.writeFileSync(trailingPng, Buffer.concat([cleanPngBuf, Buffer.alloc(64, 0x7f)]));

      const bgRes = await mediaGen.editImage(
        { input_path: trailingPng, operation: 'remove_background', output_path: path.join(tmp, 'nobg.png') },
        { cwd: tmp }
      );
      assert.equal(bgRes.ok, true);
      const decodedBg = PNG.sync.read(fs.readFileSync(bgRes.path));
      assert.equal(decodedBg.data[3], 0, 'Corner backdrop must be transparent after remove_background');

      const resizedRes = await mediaGen.editImage(
        { input_path: trailingPng, operation: 'resize', width: 32, output_path: path.join(tmp, 'half.png') },
        { cwd: tmp }
      );
      assert.equal(resizedRes.width, 32);
      assert.equal(resizedRes.height, 24);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('guards ~/.autobot/media-cache and ~/.autobot/media-library/index.json from transient test paths', async () => {
    assert.equal(mediaGen.isTransientTestPath('/tmp/sample/out.png'), true);
    assert.equal(mediaGen.isTransientTestPath('/var/folders/xx/yy/akron-media-doc-123/a.png'), true);
    assert.equal(mediaGen.isTransientTestPath(path.join(os.tmpdir(), '_tooltest', 'clip.mp4')), true);
    assert.equal(mediaGen.isTransientTestPath(path.join(os.tmpdir(), '_videotest', 'clip.mp4')), true);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-media-doc-guard-'));
    const idxFile = path.join(os.homedir(), '.autobot', 'media-library', 'index.json');
    const cacheDir = path.join(os.homedir(), '.autobot', 'media-cache');
    const beforeCache = fs.existsSync(cacheDir) ? new Set(fs.readdirSync(cacheDir)) : new Set();
    try {
      const png = new PNG({ width: 16, height: 16 });
      const testPng = path.join(tmp, 'transient-audit.png');
      fs.writeFileSync(testPng, PNG.sync.write(png));

      const cacheRes = mediaGen.cacheMediaArtifact(testPng);
      assert.equal(cacheRes.cachePath, '', 'transient path must NOT be written into ~/.autobot/media-cache');
      assert(cacheRes.previewDataUrl.startsWith('data:image/png;base64,'));

      const recRes = mediaGen.recordMediaLibraryItem({ kind: 'image', path: testPng, cwd: tmp });
      assert.equal(recRes, null, 'transient path must NOT be recorded in ~/.autobot/media-library');

      const afterCache = fs.existsSync(cacheDir) ? fs.readdirSync(cacheDir) : [];
      const added = afterCache.filter((f) => !beforeCache.has(f) && f.includes('transient-audit'));
      assert.equal(added.length, 0);

      if (fs.existsSync(idxFile)) {
        const idx = JSON.parse(fs.readFileSync(idxFile, 'utf8'));
        assert(!idx.some((x) => x && x.path === testPng));
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('symlinks bundled native runtimes (ffmpeg, ffprobe, rg, claude, codex, grok) into binDir and resolves via Bash', async () => {
    const ff = mediaGen.resolveFfmpeg();
    const fp = mediaGen.resolveFfprobe();
    const rg = depManager.resolveRipgrepBinary();
    assert(ff && fs.existsSync(ff), 'ffmpeg binary must exist');
    assert(fp && fs.existsSync(fp), 'ffprobe binary must exist');
    assert(rg && fs.existsSync(rg), 'ripgrep binary must exist');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-bins-'));
    try {
      const binDir = path.join(tmp, 'bin');
      const fakeDir = path.join(tmp, 'fake-clis');
      fs.mkdirSync(fakeDir, { recursive: true });
      const claudeFake = path.join(fakeDir, 'claude');
      const codexFake = path.join(fakeDir, 'codex');
      const grokFake = path.join(fakeDir, 'grok');
      for (const f of [claudeFake, codexFake, grokFake]) {
        fs.writeFileSync(f, '#!/bin/sh\necho 1.0.0\n', { mode: 0o755 });
      }
      const res = createRuntimesController.syncBundledBinsToDir({
        binDir,
        links: [
          { name: 'ffmpeg', target: ff },
          { name: 'ffprobe', target: fp },
          { name: 'rg', target: rg },
          { name: 'claude', target: claudeFake },
          { name: 'codex', target: codexFake },
          { name: 'grok', target: grokFake },
        ],
      });
      assert.equal(res.linked.length, 6);
      for (const tool of ['ffmpeg', 'ffprobe', 'rg', 'claude', 'codex', 'grok']) {
        const expected = process.platform === 'win32' && ['ffmpeg', 'ffprobe', 'rg', 'claude', 'grok'].includes(tool)
          ? `${tool}.exe`
          : tool;
        assert(fs.existsSync(path.join(binDir, expected)) || fs.existsSync(path.join(binDir, tool)), `missing symlink for ${tool}`);
      }

      if (process.platform !== 'win32') {
        const prevPath = process.env.PATH || '';
        try {
          process.env.PATH = `${binDir}${path.delimiter}${prevPath}`;
          const out = await runTool('Bash', { command: 'command -v ffmpeg && command -v ffprobe && command -v rg' }, { cwd: tmp });
          const text = typeof out === 'string' ? out : (out && out.content) || '';
          assert(text.includes('ffmpeg') && text.includes('ffprobe') && text.includes('rg'), `Bash must find bundled binaries: ${text}`);
        } finally {
          process.env.PATH = prevPath;
        }
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('enforces single-composer layout (panel === "chats") and MediaDocCard / MediaStudioView contracts', () => {
    const appSrc = fs.readFileSync(path.join(root, 'src/App.jsx'), 'utf8');
    const cardSrc = fs.readFileSync(path.join(root, 'src/components/MediaDocCard.jsx'), 'utf8');
    const studioSrc = fs.readFileSync(path.join(root, 'src/components/MediaStudioView.jsx'), 'utf8');
    const studioCss = fs.readFileSync(path.join(root, 'src/styles/media-doc-studio.css'), 'utf8');

    assert(appSrc.includes("{panel === 'chats' && (\n            <InputBar") || /\{panel === 'chats' && \(\s*<InputBar/.test(appSrc), 'InputBar must render strictly inside panel === "chats"');
    assert(cardSrc.includes('Media Studio'), 'MediaDocCard must provide Media Studio button for binary media');
    assert(cardSrc.includes('Open in IDE'), 'MediaDocCard must keep Open in IDE for .svg/docs');
    assert(cardSrc.includes('↺ Original') && cardSrc.includes('historyStack'), 'MediaDocCard must maintain undo history stack');
    assert(cardSrc.includes('Needs API Key') && studioSrc.includes('Needs API Key'), 'UI pickers must label unkeyed models honestly');
    assert(/\.media-doc-head\s*\{[\s\S]*flex-wrap:\s*wrap/.test(studioCss), '.media-doc-head must wrap cleanly');
  });
});
