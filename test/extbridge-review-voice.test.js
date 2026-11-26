'use strict';
// Unit + integration tests for:
//   1. Akron Browser Bot extension integrity (checkBrand + local-provider.json + desktopBridge)
//   2. extbridge.js HTTP /v1/models, /v1/chat/completions (JSON + SSE) & WS ext_browser round-trip
//   3. checkpoints.computeTurnDiffs & live checkpoint emission in llm.runAgent
//   4. Built-in Whisper ONNX assets (public/whisper + dist/whisper) and Windows build/icon.ico

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { pathToFileURL } = require('url');
const WebSocket = require('ws');

const extbridge = require('../electron/extbridge');
const tools = require('../electron/tools');
const llm = require('../electron/llm');
const checkpoints = require('../electron/checkpoints');

let passed = 0;
let failed = 0;
const failures = [];
function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; failures.push(name + (detail ? ' — ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' — ' + detail : '')); }
}
function section(t) { console.log('\n# ' + t); }

(async () => {
  const tmpRoots = [];
  const cpCleanup = [];

  try {
    // ------------------------------------------------------------------
    section('1. Akron Browser Bot bundle & brand integrity');
    {
      const extDir = extbridge.extensionDir();
      ok('extensionDir exists', fs.existsSync(path.join(extDir, 'manifest.json')), extDir);

      // Run extension's own sealed brand check
      const brandMod = await import(pathToFileURL(path.join(extDir, 'shared', 'brand.js')).href);
      const problems = await brandMod.checkBrand({
        readText: async (rel) => fs.readFileSync(path.join(extDir, rel), 'utf8'),
        readBytes: async (rel) => fs.readFileSync(path.join(extDir, rel)),
      });
      ok('extension checkBrand() reports zero brand problems', Array.isArray(problems) && problems.length === 0, JSON.stringify(problems));

      const lp = JSON.parse(fs.readFileSync(path.join(extDir, 'local-provider.json'), 'utf8'));
      ok('local-provider.json points at 127.0.0.1:8766/v1 with akron-default',
        lp.providers && lp.providers[0] && lp.providers[0].baseUrl === 'http://127.0.0.1:8766/v1' && lp.providers[0].defaultModel === 'akron-default',
        JSON.stringify(lp));

      const storageSrc = fs.readFileSync(path.join(extDir, 'background', 'storage.js'), 'utf8');
      ok('extension desktopBridge defaults to true', /desktopBridge:\s*true/.test(storageSrc));
    }

    // ------------------------------------------------------------------
    section('2. extbridge zero-key /v1 proxy & WebSocket ext_browser control');
    {
      // Mock upstream provider server
      const upstream = await new Promise((resolve) => {
        const s = http.createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => { raw += c; });
          req.on('end', () => {
            const body = JSON.parse(raw || '{}');
            const authOk = req.headers.authorization === 'Bearer secret-desktop-key';
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const reply = authOk ? `Proxy saw model=${body.model}` : 'BAD_AUTH';
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] })}\n\n`);
            res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          });
        });
        s.listen(0, '127.0.0.1', () => resolve({ s, baseURL: `http://127.0.0.1:${s.address().port}/v1` }));
      });

      let bridgePort = 0;
      try {
        const started = await extbridge.start({
          port: 0,
          getProvider: () => ({ baseURL: upstream.baseURL, apiKey: 'secret-desktop-key', model: 'qwen3.8-flash', supportsTools: true }),
          getOrchestrator: () => ({
            enabled: true,
            providers: [{ baseURL: upstream.baseURL, apiKey: 'secret-desktop-key', model: 'gpt-5.6-luna' }],
          }),
        });
        ok('extbridge starts on ephemeral loopback port', started.ok && started.port > 0, JSON.stringify(started));
        bridgePort = started.port;

        // Test GET /v1/models
        const mRes = await fetch(`http://127.0.0.1:${bridgePort}/v1/models`).then((r) => r.json());
        const mIds = (mRes.data || []).map((x) => x.id);
        ok('GET /v1/models exposes akron-default, akron-planner & desktop models',
          mIds.includes('akron-default') && mIds.includes('akron-planner') && mIds.includes('qwen3.8-flash') && mIds.includes('gpt-5.6-luna'),
          JSON.stringify(mIds));

        // Test POST /v1/chat/completions (non-stream) with dummy client key
        const cRes = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer akron-desktop-local' },
          body: JSON.stringify({ model: 'akron-default', messages: [{ role: 'user', content: 'hi' }], stream: false }),
        }).then((r) => r.json());
        ok('POST /v1/chat/completions non-stream injects desktop key upstream',
          cRes.choices && cRes.choices[0] && /Proxy saw model=qwen3\.8-flash/.test(cRes.choices[0].message.content),
          JSON.stringify(cRes));

        // Test POST /v1/chat/completions (stream: true)
        const sseRaw = await fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'gpt-5.6-luna', messages: [{ role: 'user', content: 'hi' }], stream: true }),
        }).then((r) => r.text());
        ok('POST /v1/chat/completions stream=true emits SSE data & [DONE]',
          sseRaw.includes('Proxy saw model=gpt-5.6-luna') && sseRaw.includes('[DONE]'),
          sseRaw.slice(0, 200));

        // Simulated extension WebSocket client pairing & ext_browser tool dispatch
        const client = new WebSocket(`ws://127.0.0.1:${bridgePort}`);
        await new Promise((r) => client.once('open', r));
        client.send(JSON.stringify({ type: 'ext_hello', product: 'Akron Browser Bot', version: '1.6.7' }));
        client.on('message', (raw) => {
          const msg = JSON.parse(String(raw));
          if (msg.type === 'ext_status') {
            client.send(JSON.stringify({
              type: 'ext_status_result',
              request_id: msg.request_id,
              version: '1.6.7',
              tabs: [{ id: 101, title: 'Example Tab', url: 'https://example.com', active: true }],
            }));
          } else if (msg.type === 'ext_tool') {
            client.send(JSON.stringify({
              type: 'ext_tool_result',
              request_id: msg.request_id,
              ok: true,
              result: { text: `Clicked ${msg.args.selector} on tab ${msg.tabId || 'active'}` },
            }));
          }
        });

        await new Promise((r) => setTimeout(r, 40));
        const st = await extbridge.status();
        ok('extbridge status reports connected extension & tabs',
          st.extensionConnected === true && st.tabs.length === 1 && st.tabs[0].id === 101,
          JSON.stringify(st));

        const clickRes = await tools.runTool('ext_browser', { action: 'click', tabId: 101, selector: '#submit-btn' }, { cwd: process.cwd() });
        const clickTxt = clickRes && clickRes.content ? clickRes.content : String(clickRes);
        ok('ext_browser tool dispatches to connected Chrome extension',
          clickTxt.includes('Clicked #submit-btn on tab 101'),
          clickTxt);

        client.close();
      } finally {
        await extbridge.stop();
        await new Promise((r) => upstream.s.close(r));
      }
    }

    // ------------------------------------------------------------------
    section('3. checkpoints.computeTurnDiffs & live checkpoint events');
    {
      const convId = 'ext-cp-' + Date.now();
      cpCleanup.push(convId);
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-diff-'));
      tmpRoots.push(repoDir);
      const targetFile = path.join(repoDir, 'app.js');
      fs.writeFileSync(targetFile, 'const a = 1;\nconst b = 2;\nreturn a + b;\n');

      const mockSrv = await new Promise((resolve) => {
        let step = 0;
        const s = http.createServer((req, res) => {
          let raw = '';
          req.on('data', (c) => { raw += c; });
          req.on('end', () => {
            step++;
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            if (step === 1) {
              res.write(`data: ${JSON.stringify({
                choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c_ed', type: 'function', function: { name: 'Edit', arguments: JSON.stringify({ file_path: targetFile, old_string: 'const b = 2;', new_string: 'const b = 41;' }) } }] }, finish_reason: null }],
              })}\n\n`);
              res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
            } else {
              res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Updated app.js' }, finish_reason: null }] })}\n\n`);
              res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
            }
            res.write('data: [DONE]\n\n');
            res.end();
          });
        });
        s.listen(0, '127.0.0.1', () => resolve({ s, baseURL: `http://127.0.0.1:${s.address().port}/v1` }));
      });

      const events = [];
      try {
        await llm.runAgent({
          provider: { baseURL: mockSrv.baseURL, model: 'mock-diff', apiKey: 'x', transport: 'openai' },
          messages: [{ role: 'user', content: 'Update app.js' }],
          cwd: repoDir,
          convId,
          turnId: 'turn-diff-1',
          emit: (e) => events.push(e),
          approveTool: async () => true,
        });

        const cpEvt = events.find((e) => e.type === 'checkpoint');
        ok('runAgent emits live checkpoint event on file mutation',
          Boolean(cpEvt && cpEvt.id === 'turn-diff-1' && cpEvt.path === fs.realpathSync(targetFile) || cpEvt && cpEvt.path.endsWith('app.js')),
          JSON.stringify(cpEvt));

        const diffs = checkpoints.computeTurnDiffs(convId, 'turn-diff-1', repoDir);
        ok('computeTurnDiffs returns accurate added/removed line hunks',
          diffs.length === 1 && diffs[0].added === 1 && diffs[0].removed === 1
          && diffs[0].lines.some((l) => l.type === 'del' && l.text.includes('const b = 2;'))
          && diffs[0].lines.some((l) => l.type === 'add' && l.text.includes('const b = 41;')),
          JSON.stringify(diffs));
      } finally {
        await new Promise((r) => mockSrv.s.close(r));
      }
    }

    // ------------------------------------------------------------------
    section('4. Built-in Whisper ONNX & Windows ICO assets');
    {
      const root = path.join(__dirname, '..');
      const pubW = path.join(root, 'public', 'whisper');
      const distW = path.join(root, 'dist', 'whisper');
      ok('public/whisper has worker, transformers & wasm',
        fs.existsSync(path.join(pubW, 'whisper-worker.js'))
        && fs.existsSync(path.join(pubW, 'transformers.min.js'))
        && fs.existsSync(path.join(pubW, 'ort-wasm-simd.wasm'))
        && fs.existsSync(path.join(pubW, 'ort-wasm.wasm')));
      ok('dist/whisper includes built-in whisper files after vite build',
        fs.existsSync(path.join(distW, 'whisper-worker.js'))
        && fs.existsSync(path.join(distW, 'ort-wasm-simd.wasm')));
      const icoBuf = fs.readFileSync(path.join(root, 'build', 'icon.ico'));
      ok('build/icon.ico exists with valid ICO magic bytes', icoBuf.readUInt16LE(0) === 0 && icoBuf.readUInt16LE(2) === 1 && icoBuf.readUInt16LE(4) === 6, `size=${icoBuf.length}`);
    }

  } finally {
    for (const c of cpCleanup) {
      try { fs.rmSync(path.join(os.homedir(), '.autobot', 'checkpoints', c.replace(/^[/\\]+/, '').replace(/[/\\:]+/g, '__')), { recursive: true, force: true }); } catch (_) {}
    }
    for (const d of tmpRoots) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  }

  console.log(`\nSUMMARY: ${passed} passed, ${failed} failed`);
  if (failures.length) console.log('FAILURES:\n - ' + failures.join('\n - '));
  process.exit(failed ? 1 : 0);
})();
