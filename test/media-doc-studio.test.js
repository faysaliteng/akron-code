'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { PNG } = require('pngjs');
const JSZip = require('jszip');

const router = require('../electron/orch-router');
const mediaGen = require('../electron/media-gen');
const { runTool } = require('../electron/tools');
const docStudio = require('../electron/doc-studio');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-media-doc-'));
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    console.error('  ✗ ' + name + '\n    ' + (e && e.stack ? e.stack : e));
  }
}

(async () => {
  console.log('\nPhase 1 — Multimodal & Media Model Router:');
  await test('ROLES includes image_gen, video_gen, audio_speech while freellmPreset keeps 5 core keys', () => {
    assert(router.ROLES.includes('image_gen'));
    assert(router.ROLES.includes('video_gen'));
    assert(router.ROLES.includes('audio_speech'));
    assert.strictEqual(router.normalizeRole('dalle'), 'image_gen');
    assert.strictEqual(router.normalizeRole('veo'), 'video_gen');
    assert.strictEqual(router.normalizeRole('tts'), 'audio_speech');
    assert.deepStrictEqual(Object.keys(router.freellmPreset().roles), ['planner', 'coder', 'vision', 'fast', 'longctx']);
  });

  await test('resolveMediaProvider auto-routes away from text-only active model & includes guaranteed offline fallback', async () => {
    const resImg = await router.resolveMediaProvider({
      kind: 'image',
      provider: { model: 'claude-sonnet-4-6', baseURL: 'https://api.anthropic.com' },
      store: false,
      env: { OPENAI_API_KEY: 'test-key-not-real' },
    });
    assert.strictEqual(resImg.autoRouted, true);
    assert.strictEqual(resImg.model, 'gpt-image-1');
    assert(resImg.candidates.some((c) => c.source === 'offline_fallback' && c.backend === 'offline-image-studio'));

    const resVidOffline = await router.resolveMediaProvider({
      kind: 'video',
      provider: { model: 'deepseek-chat', baseURL: 'https://api.deepseek.com/v1' },
      store: false,
      env: {},
    });
    assert.strictEqual(resVidOffline.autoRouted, true);
    assert.strictEqual(resVidOffline.backend, 'offline-video-studio');

    const resPool = await router.resolveMediaProvider({
      kind: 'image',
      provider: { model: 'qwen3-coder' },
      store: false,
      orchestrator: { pools: { enabled: true, gateway: { baseURL: 'http://127.0.0.1:3001/v1' }, roles: { image_gen: { models: ['custom-flux-pro'] } } } },
      env: {},
    });
    assert.strictEqual(resPool.model, 'custom-flux-pro');
  });

  console.log('\nPhase 2 — Image & Video Generation + Editing:');
  const genImgPath = path.join(tmp, 'hero.png');
  await test('GenerateImage + create_image offline generates crisp PNG and SVG', async () => {
    const out = await runTool('GenerateImage', { prompt: 'Emerald Cyber Cathedral', aspect_ratio: '16:9', format: 'png', output_path: genImgPath, forceOffline: true }, { cwd: tmp, provider: { model: 'claude-sonnet-4-6' } });
    const parsed = JSON.parse(out.content);
    assert.strictEqual(parsed.ok, true);
    assert(fs.existsSync(genImgPath));
    const png = PNG.sync.read(fs.readFileSync(genImgPath));
    assert.strictEqual(png.width, 1344);
    assert.strictEqual(png.height, 768);

    const svgOut = await runTool('create_image', { prompt: 'Akron Sunburst Badge', format: 'svg', output_path: path.join(tmp, 'badge.svg') }, { cwd: tmp });
    const svgParsed = JSON.parse(svgOut.content);
    assert.strictEqual(svgParsed.ok, true);
    assert(fs.readFileSync(path.join(tmp, 'badge.svg'), 'utf8').includes('<svg'));
  });

  await test('EditImage supports resize, crop, convert (PNG->JPG/ICO/WebP), watermark, remove_background, upscale, ocr', async () => {
    const resized = JSON.parse((await runTool('EditImage', { input_path: genImgPath, operation: 'resize', width: 320, height: 180, output_path: path.join(tmp, 'resized.png') }, { cwd: tmp })).content);
    assert.strictEqual(resized.width, 320);
    assert.strictEqual(resized.height, 180);

    const cropped = JSON.parse((await runTool('edit_image', { input_path: genImgPath, operation: 'crop', crop_box: { x: 20, y: 20, width: 200, height: 150 }, output_path: path.join(tmp, 'cropped.png') }, { cwd: tmp })).content);
    assert.strictEqual(cropped.width, 200);
    assert.strictEqual(cropped.height, 150);

    const jpg = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'resized.png'), operation: 'convert', format: 'jpg', output_path: path.join(tmp, 'converted.jpg') }, { cwd: tmp })).content);
    assert(fs.existsSync(jpg.path) && fs.statSync(jpg.path).size > 500);

    const ico = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'resized.png'), operation: 'convert', format: 'ico', output_path: path.join(tmp, 'icon.ico') }, { cwd: tmp })).content);
    const icoBuf = fs.readFileSync(ico.path);
    assert.strictEqual(icoBuf.readUInt16LE(2), 1);

    const webp = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'resized.png'), operation: 'convert', format: 'webp', output_path: path.join(tmp, 'converted.webp') }, { cwd: tmp })).content);
    assert(fs.existsSync(webp.path) && fs.statSync(webp.path).size > 200);

    const wm = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'resized.png'), operation: 'watermark', watermark_text: 'AKRON', output_path: path.join(tmp, 'wm.png') }, { cwd: tmp })).content);
    assert(fs.existsSync(wm.path));

    const bgOut = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'resized.png'), operation: 'remove_background', output_path: path.join(tmp, 'nobg.png') }, { cwd: tmp })).content);
    const bgPng = PNG.sync.read(fs.readFileSync(bgOut.path));
    assert.strictEqual(bgPng.data[3], 0, 'Corner background pixel should become transparent');

    const up = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'cropped.png'), operation: 'upscale', output_path: path.join(tmp, 'up.png') }, { cwd: tmp })).content);
    assert.strictEqual(up.width, 400);
    assert.strictEqual(up.height, 300);

    const ocr = JSON.parse((await runTool('EditImage', { input_path: path.join(tmp, 'badge.svg'), operation: 'ocr' }, { cwd: tmp })).content);
    assert(ocr.text.includes('Akron Sunburst Badge'));
  });

  const vidPath = path.join(tmp, 'clip.mp4');
  await test('GenerateVideo + EditVideo offline generates MP4/GIF, inspects, trims, burns SRT subtitles & extracts contact sheet', async () => {
    const vRes = JSON.parse((await runTool('GenerateVideo', { prompt: 'Akron Studio Launch', duration_sec: 1.5, fps: 24, aspect_ratio: '16:9', format: 'mp4', output_path: vidPath }, { cwd: tmp })).content);
    assert.strictEqual(vRes.ok, true);
    assert(fs.existsSync(vidPath) && fs.statSync(vidPath).size > 2000);

    const insp = JSON.parse((await runTool('EditVideo', { input_path: vidPath, operation: 'inspect' }, { cwd: tmp })).content);
    assert.strictEqual(insp.width, 640);
    assert.strictEqual(insp.height, 360);
    assert(insp.duration > 1.0);

    const trimmed = JSON.parse((await runTool('edit_video', { input_path: vidPath, operation: 'trim', start_sec: 0, end_sec: 0.7, output_path: path.join(tmp, 'trim.mp4') }, { cwd: tmp })).content);
    assert(trimmed.duration > 0.3 && trimmed.duration <= 1.0);

    const frames = JSON.parse((await runTool('EditVideo', { input_path: vidPath, operation: 'extract_frames', count: 4, output_path: path.join(tmp, 'sheet.png') }, { cwd: tmp })).content);
    assert(fs.existsSync(frames.contact_sheet) && frames.frames.length === 4);

    const subVid = JSON.parse((await runTool('EditVideo', { input_path: path.join(tmp, 'trim.mp4'), operation: 'add_subtitles', subtitles_srt: '1\n00:00:00,000 --> 00:00:02,000\nHELLO AKRON\n', output_path: path.join(tmp, 'subbed.mp4') }, { cwd: tmp })).content);
    assert(fs.existsSync(subVid.path) && fs.statSync(subVid.path).size > 1000);

    const gif = JSON.parse((await runTool('EditVideo', { input_path: path.join(tmp, 'trim.mp4'), operation: 'to_gif', output_path: path.join(tmp, 'clip.gif') }, { cwd: tmp })).content);
    assert(fs.existsSync(gif.path) && fs.statSync(gif.path).size > 500);
  });

  console.log('\nPhase 3 — Pre-Bundled Office, PDF, ZIP & LaTeX Engine:');
  await test('PDF generate, merge, watermark, ReadDocument & Read auto-delegation round-trip', async () => {
    const pdf1 = path.join(tmp, 'report1.pdf');
    const pdf2 = path.join(tmp, 'report2.pdf');
    const mergedPdf = path.join(tmp, 'merged.pdf');
    await runTool('GenerateDocument', { format: 'pdf', output_path: pdf1, title: 'Akron Alpha Report', markdown: 'Alpha revenue grew 42 percent.\n\n- Metric one ok' }, { cwd: tmp });
    await runTool('GenerateDocument', { format: 'pdf', output_path: pdf2, title: 'Akron Beta Appendix', markdown: 'Beta appendix verification complete.' }, { cwd: tmp });
    const mRes = JSON.parse((await runTool('GenerateDocument', { format: 'pdf', merge_paths: [pdf1, pdf2], watermark: 'CONFIDENTIAL', output_path: mergedPdf }, { cwd: tmp })).content);
    assert.strictEqual(mRes.pageCount, 2);

    const rDoc = await runTool('ReadDocument', { path: mergedPdf, pages: '2' }, { cwd: tmp });
    assert(rDoc.content.includes('Beta appendix'), 'Page 2 should contain Beta appendix text: ' + rDoc.content);

    const readViaRead = await runTool('Read', { path: pdf1 }, { cwd: tmp });
    assert(readViaRead.content.includes('Alpha revenue'), 'Read tool must auto-delegate PDF to ReadDocument');
  });

  await test('LaTeX (.tex -> .pdf) compiles offline cleanly', async () => {
    const texPdf = path.join(tmp, 'paper.pdf');
    const out = JSON.parse((await runTool('GenerateDocument', {
      format: 'tex',
      output_path: texPdf,
      latex: '\\documentclass{article}\\title{Quantum Compiler Paper}\\author{Akron Research}\\begin{document}\\maketitle\\section{Introduction}Efficiency satisfies $E = mc^2$.\\end{document}',
    }, { cwd: tmp })).content);
    assert(fs.existsSync(texPdf) && out.size > 500);
    const readBack = await runTool('ReadDocument', { path: texPdf }, { cwd: tmp });
    assert(readBack.content.includes('Quantum Compiler Paper'));
  });

  await test('DOCX generate + ReadDocument & Read round-trip', async () => {
    const docxPath = path.join(tmp, 'spec.docx');
    await runTool('GenerateDocument', {
      format: 'docx',
      output_path: docxPath,
      title: 'Architecture Spec',
      markdown: '# Overview\nZero-install Word generation works offline.\n\n| Module | Status |\n| --- | --- |\n| MediaGen | Ready |\n| DocStudio | Ready |',
    }, { cwd: tmp });
    assert(fs.existsSync(docxPath));
    const rd = await runTool('ReadDocument', { path: docxPath }, { cwd: tmp });
    assert(rd.content.includes('Zero-install Word generation'));
    const rdCore = await runTool('Read', { path: docxPath }, { cwd: tmp });
    assert(rdCore.content.includes('MediaGen'));
  });

  await test('XLSX multi-sheet with Excel formulas + ReadDocument round-trip', async () => {
    const xlsxPath = path.join(tmp, 'budget.xlsx');
    await runTool('GenerateDocument', {
      format: 'xlsx',
      output_path: xlsxPath,
      sheets: [
        { name: 'Summary', columns: ['Item', 'Cost'], rows: [['Compute', 100], ['Storage', 50], ['Total', '=SUM(B2:B3)']] },
        { name: 'Notes', columns: ['Owner', 'Status'], rows: [['Core', 'Green']] },
      ],
    }, { cwd: tmp });
    const parsed = await docStudio.readDocument(xlsxPath);
    assert.deepStrictEqual(parsed.sheetNames, ['Summary', 'Notes']);
    assert.strictEqual(parsed.sheets[0].formulas.B4, '=SUM(B2:B3)');
    const rd = await runTool('ReadDocument', { path: xlsxPath }, { cwd: tmp });
    assert(rd.content.includes('Summary') && rd.content.includes('Compute'));
  });

  await test('PPTX slide deck generate + ReadDocument round-trip', async () => {
    const pptxPath = path.join(tmp, 'deck.pptx');
    await runTool('GenerateDocument', {
      format: 'pptx',
      output_path: pptxPath,
      title: 'Q4 Keynote',
      slides: [
        { title: 'Akron Studio Overview', subtitle: 'Local-First Multimodal', bullets: ['Fast offline rendering', 'Zero pip dependencies'], notes: 'Speaker hint one' },
        { title: 'Benchmarks', bullets: ['70/70 green'], notes: 'Mention evals' },
      ],
    }, { cwd: tmp });
    const rd = await runTool('ReadDocument', { path: pptxPath }, { cwd: tmp });
    assert(rd.content.includes('Akron Studio Overview') && rd.content.includes('Speaker hint one'));
  });

  await test('ZIP pack, ReadDocument tree & entry preview, extractArchive & Zip-Slip guard', async () => {
    const zipPath = path.join(tmp, 'bundle.zip');
    await runTool('GenerateDocument', {
      format: 'zip',
      output_path: zipPath,
      files: [{ name: 'hello.txt', content: 'hello inside zip' }, { name: 'sub/data.json', content: '{"ok":true}' }],
    }, { cwd: tmp });
    const tree = await runTool('ReadDocument', { path: zipPath }, { cwd: tmp });
    assert(tree.content.includes('hello.txt') && tree.content.includes('sub/data.json'));
    const entry = await runTool('ReadDocument', { path: zipPath, entry: 'hello.txt' }, { cwd: tmp });
    assert(entry.content.includes('hello inside zip'));

    // Zip-slip guard test (JSZip preserves `../` traversal entry verbatim)
    const evilZipPath = path.join(tmp, 'evil.zip');
    const evilZip = new JSZip();
    evilZip.file('../../evil.txt', 'pwnd');
    fs.writeFileSync(evilZipPath, await evilZip.generateAsync({ type: 'nodebuffer' }));
    let blocked = false;
    try {
      docStudio.extractArchive(evilZipPath, path.join(tmp, 'extract-dest'));
    } catch (e) {
      blocked = /zip-slip/i.test(e.message);
    }
    assert.strictEqual(blocked, true, 'Zip-slip traversal must be blocked');
  });

  await test('extractAttachmentFile handles PDF, DOCX, XLSX, PPTX, and ZIP attachments cleanly', async () => {
    for (const f of ['report1.pdf', 'spec.docx', 'budget.xlsx', 'deck.pptx', 'bundle.zip']) {
      const res = await docStudio.extractAttachmentFile({ path: path.join(tmp, f), name: f });
      assert(res && res.isText && res.content.length > 10, `Expected extracted text for ${f}`);
    }
  });

  await test('REPL / JavaScript exposes pre-bundled pdf-lib & jszip offline via require()', async () => {
    const extTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-ext-repl-'));
    try {
      const r = await runTool('REPL', {
        cwd: extTmp,
        code: 'const { PDFDocument } = require("pdf-lib"); const JSZip = require("jszip"); typeof PDFDocument + ":" + typeof JSZip',
      }, { cwd: extTmp });
      assert(String(r.content || r).includes('function:function'), 'REPL must resolve bundled modules: ' + JSON.stringify(r));
    } finally {
      fs.rmSync(extTmp, { recursive: true, force: true });
    }
  });

  await test('read_document & generate_document lowercase aliases work with latex_pdf & spec', async () => {
    const aliasPdf = path.join(tmp, 'alias-paper.pdf');
    const gRes = JSON.parse((await runTool('generate_document', {
      format: 'latex_pdf',
      output_path: aliasPdf,
      spec: {
        title: 'Alias Spec Report',
        latex: '\\documentclass{article}\\title{Alias Spec Paper}\\begin{document}\\maketitle\\section{Results}Lowercase alias ok.\\end{document}',
      },
    }, { cwd: tmp })).content);
    assert(fs.existsSync(aliasPdf) && gRes.ok === true);
    const rdJson = JSON.parse((await runTool('read_document', { path: aliasPdf, format: 'json' }, { cwd: tmp })).content);
    assert.strictEqual(rdJson.ok, true);
    assert(String(rdJson.text || rdJson.markdown).includes('Alias Spec Paper'));
  });

  await test('listMediaStudioCatalog disables unconfigured image/video models with configKeyId and unlocks them when API keys are set', async () => {
    const emptyCat = router.listMediaStudioCatalog({ store: false, env: {}, provider: {}, orchestrator: {} });
    const veoOff = emptyCat.videoModels.find((m) => m.id === 'veo-2.0-generate-001');
    const soraOff = emptyCat.videoModels.find((m) => m.id === 'sora');
    const grokVidOff = emptyCat.videoModels.find((m) => m.id === 'grok-2-video');
    const wanOff = emptyCat.videoModels.find((m) => m.id === 'wan-video/wan-2.1');
    const klingOff = emptyCat.videoModels.find((m) => m.id === 'kling-v1.6');
    const lumaOff = emptyCat.videoModels.find((m) => m.id === 'ray-2');
    const imagenOff = emptyCat.imageModels.find((m) => m.id === 'imagen-3.0-generate-002');
    const gptImgOff = emptyCat.imageModels.find((m) => m.id === 'gpt-image-1');
    const cfOff = emptyCat.imageModels.find((m) => m.id === '@cf/black-forest-labs/flux-1-schnell');

    assert.strictEqual(veoOff.available, false);
    assert.strictEqual(veoOff.configKeyId, 'GEMINI_API_KEY');
    assert.strictEqual(soraOff.available, false);
    assert.strictEqual(soraOff.configKeyId, 'OPENAI_API_KEY');
    assert.strictEqual(grokVidOff.available, false);
    assert.strictEqual(grokVidOff.configKeyId, 'XAI_API_KEY');
    assert.strictEqual(wanOff.available, false);
    assert.strictEqual(wanOff.configKeyId, 'FAL_KEY');
    assert.strictEqual(klingOff.available, false);
    assert.strictEqual(klingOff.configKeyId, 'KLING_API_KEY');
    assert.strictEqual(lumaOff.available, false);
    assert.strictEqual(lumaOff.configKeyId, 'LUMA_API_KEY');
    assert.strictEqual(imagenOff.available, false);
    assert.strictEqual(imagenOff.configKeyId, 'GEMINI_API_KEY');
    assert.strictEqual(gptImgOff.available, false);
    assert.strictEqual(gptImgOff.configKeyId, 'OPENAI_API_KEY');
    assert.strictEqual(cfOff.available, false);
    assert.strictEqual(cfOff.configKeyId, 'CLOUDFLARE_API_TOKEN');

    const keyedCat = router.listMediaStudioCatalog({
      store: false,
      provider: {},
      orchestrator: {},
      env: {
        GEMINI_API_KEY: 'gm-test',
        OPENAI_API_KEY: 'oa-test',
        XAI_API_KEY: 'xa-test',
        FAL_KEY: 'fal-test',
        KLING_API_KEY: 'kl-test',
        LUMA_API_KEY: 'lu-test',
        CLOUDFLARE_API_TOKEN: 'cf-tok',
        CLOUDFLARE_ACCOUNT_ID: 'cf-acc',
      },
    });
    assert.strictEqual(keyedCat.videoModels.find((m) => m.id === 'veo-2.0-generate-001').available, true);
    assert.strictEqual(keyedCat.videoModels.find((m) => m.id === 'sora').available, true);
    assert.strictEqual(keyedCat.videoModels.find((m) => m.id === 'grok-2-video').available, true);
    assert.strictEqual(keyedCat.videoModels.find((m) => m.id === 'wan-video/wan-2.1').available, true);
    assert.strictEqual(keyedCat.videoModels.find((m) => m.id === 'kling-v1.6').available, true);
    assert.strictEqual(keyedCat.videoModels.find((m) => m.id === 'ray-2').available, true);
    assert.strictEqual(keyedCat.imageModels.find((m) => m.id === 'imagen-3.0-generate-002').available, true);
    assert.strictEqual(keyedCat.imageModels.find((m) => m.id === 'gpt-image-1').available, true);
    assert.strictEqual(keyedCat.imageModels.find((m) => m.id === '@cf/black-forest-labs/flux-1-schnell').available, true);
  });

  await test('UI, Settings & IPC wiring enforce unselectable unconfigured media models + Configure -> Settings navigation', () => {
    const mediaView = fs.readFileSync(path.join(__dirname, '..', 'src/components/MediaStudioView.jsx'), 'utf8');
    const docCard = fs.readFileSync(path.join(__dirname, '..', 'src/components/MediaDocCard.jsx'), 'utf8');
    const extPanels = fs.readFileSync(path.join(__dirname, '..', 'src/components/settings/ExtendedSettingsPanels.jsx'), 'utf8');
    const modalBody = fs.readFileSync(path.join(__dirname, '..', 'src/components/settings/SettingsModalBody.jsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src/App.jsx'), 'utf8');
    const ipcFeat = fs.readFileSync(path.join(__dirname, '..', 'electron/ipc/ipc-features.js'), 'utf8');
    const preload = fs.readFileSync(path.join(__dirname, '..', 'electron/preload.js'), 'utf8');

    assert(docCard.includes('export function MediaModelPicker') && docCard.includes("if (!available) return;") && docCard.includes('Config →'));
    assert(mediaView.includes('<MediaModelPicker') && mediaView.includes('onConfigureMediaKey') && mediaView.includes('akron:media-keys-updated'));
    assert(extPanels.includes('export function MediaStudioApiKeysSection') && extPanels.includes('mediaKeysGet') && extPanels.includes('mediaKeysSave'));
    assert(modalBody.includes('<MediaStudioApiKeysSection') && modalBody.includes("section === 'media'"));
    assert(appSrc.includes("id: 'media'") && appSrc.includes('Images & Video APIs') && appSrc.includes("openSettingsAt('media'"));
    assert(ipcFeat.includes("ipcMain.handle('autobot:mediaKeysGet'") && ipcFeat.includes("ipcMain.handle('autobot:mediaKeysSave'") && ipcFeat.includes('needsApiKey: true'));
    assert(preload.includes('mediaKeysGet') && preload.includes('mediaKeysSave'));
  });

  await test('Cloud models surface HTTP errors cleanly without silent offline fallback & support Gemini/Veo protocol end-to-end', async () => {
    const png = new PNG({ width: 32, height: 32 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 16; png.data[i + 1] = 185; png.data[i + 2] = 129; png.data[i + 3] = 255;
    }
    const pngB64 = PNG.sync.write(png).toString('base64');
    const fakeMp4 = Buffer.alloc(6144, 0);
    Buffer.from('ftypisom').copy(fakeMp4, 4);

    let failMode = false;
    let baseUrl = '';
    const seen = [];
    const srv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const body = raw ? JSON.parse(raw) : null;
        seen.push({ url: req.url, key: req.headers['x-goog-api-key'], body });
        if (failMode) {
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Quota exceeded in test' } }));
          return;
        }
        if (req.url.includes(':generateContent')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            candidates: [{ content: { parts: [{ inline_data: { mime_type: 'image/png', data: pngB64 } }] } }],
          }));
          return;
        }
        if (req.url.includes(':predictLongRunning')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ name: 'operations/test-veo-op' }));
          return;
        }
        if (req.url.includes('/operations/test-veo-op')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            done: true,
            response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${baseUrl}/download/veo.mp4` } }] } },
          }));
          return;
        }
        if (req.url.includes('/download/veo.mp4')) {
          res.writeHead(200, { 'content-type': 'video/mp4' });
          res.end(fakeMp4);
          return;
        }
        res.writeHead(404);
        res.end('not found');
      });
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${srv.address().port}/v1beta`;

    try {
      const mockOrch = {
        providers: [
          { model: 'gemini-2.5-flash-image', baseURL: baseUrl, apiKey: 'GM_TEST_KEY' },
          { model: 'veo-2.0-generate-001', baseURL: baseUrl, apiKey: 'GM_TEST_KEY' },
        ],
      };

      const imgOut = path.join(tmp, 'gemini-flash.png');
      const imgRes = await mediaGen.generateImage(
        { prompt: 'Emerald crystal', model: 'gemini-2.5-flash-image', output_path: imgOut },
        { cwd: tmp, orchestrator: mockOrch, store: false }
      );
      assert.strictEqual(imgRes.model, 'gemini-2.5-flash-image');
      assert.strictEqual(imgRes.backend, 'gemini-flash-image');
      assert.strictEqual(imgRes.width, 32);
      assert(fs.existsSync(imgOut));

      // ai_edit must forward input image bytes via inlineData
      const editOut = path.join(tmp, 'gemini-edited.png');
      const editRes = await mediaGen.editImage(
        { input_path: imgOut, operation: 'ai_edit', instruction: 'Make it glow brighter', model: 'gemini-2.5-flash-image', output_path: editOut },
        { cwd: tmp, orchestrator: mockOrch, store: false }
      );
      assert.strictEqual(editRes.model, 'gemini-2.5-flash-image');
      const editReq = seen.find((s) => s.url.includes(':generateContent') && s.body?.contents?.[0]?.parts?.length === 2);
      assert(editReq && editReq.body.contents[0].parts[1].inlineData.data, 'ai_edit must pass inlineData to Gemini');

      // Veo 2 text-to-video + image-to-video
      const veoOut = path.join(tmp, 'veo-anim.mp4');
      const veoRes = await mediaGen.generateVideo(
        { prompt: 'Animate emerald crystal', model: 'veo-2.0-generate-001', image_path: imgOut, output_path: veoOut, pollIntervalMs: 60 },
        { cwd: tmp, orchestrator: mockOrch, store: false }
      );
      assert.strictEqual(veoRes.model, 'veo-2.0-generate-001');
      assert.strictEqual(veoRes.backend, 'google-veo');
      assert(fs.existsSync(veoOut) && fs.statSync(veoOut).size >= 6144);
      const veoReq = seen.find((s) => s.url.includes(':predictLongRunning'));
      assert(veoReq && veoReq.body?.instances?.[0]?.image?.bytesBase64Encoded, 'Veo 2 animate-video must send source image');

      // Rejection must throw explicitly — NEVER silently generate akron-svg-canvas-studio
      failMode = true;
      const failOut = path.join(tmp, 'should-not-exist.png');
      let errMsg = '';
      try {
        await mediaGen.generateImage(
          { prompt: 'Emerald crystal', model: 'gemini-2.5-flash-image', output_path: failOut },
          { cwd: tmp, orchestrator: mockOrch, store: false }
        );
      } catch (e) {
        errMsg = e.message;
      }
      assert(errMsg.includes('429') && errMsg.includes('Quota exceeded in test'), 'Expected HTTP 429 error, got: ' + errMsg);
      assert.strictEqual(fs.existsSync(failOut), false, 'Failed cloud generation must not write fallback SVG placeholder');
    } finally {
      srv.close();
    }
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nMEDIA_DOC_STUDIO_RESULTS: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
