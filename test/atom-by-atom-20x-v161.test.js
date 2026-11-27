'use strict';

const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');
const assert = require('assert');
const { pathToFileURL } = require('url');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('20x atom-by-atom verification of v1.6.1 fixes (UI sync, collapsed sidebar, ext_browser, Gemini thoughtSignature, Swarm)', async () => {
  const presetsMod = await import(pathToFileURL(path.join(ROOT, 'src/utils/tutorialPresets.js')).href);
  const { syncProviderForOrchestratorToggle } = await import(pathToFileURL(path.join(ROOT, 'src/utils/settingsPersistence.js')).href);
  const pt = require('../electron/providertransport');
  const swarmMod = require('../electron/swarm');
  const tools = require('../electron/tools');
  const extbridge = require('../electron/extbridge');

  const appSrc = fs.readFileSync(path.join(ROOT, 'src/App.jsx'), 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'electron/main.js'), 'utf8');
  const sidebarJsx = fs.readFileSync(path.join(ROOT, 'src/components/sidebar/ProjectsSidebar.jsx'), 'utf8');
  const inputBarJsx = fs.readFileSync(path.join(ROOT, 'src/components/chat/InputBarView.jsx'), 'utf8');
  const stylesCss = fs.readFileSync(path.join(ROOT, 'src/styles.css'), 'utf8');
  const emeraldCss = fs.readFileSync(path.join(ROOT, 'src/styles/emerald-carbon.css'), 'utf8');
  const extToolsSrc = fs.readFileSync(path.join(ROOT, 'resources/akron-browser-bot/background/tools.js'), 'utf8');
  const extSwSrc = fs.readFileSync(path.join(ROOT, 'resources/akron-browser-bot/background/service-worker.js'), 'utf8');
  const llmSrc = fs.readFileSync(path.join(ROOT, 'electron/llm.js'), 'utf8');
  const icons = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/icons.json'), 'utf8'));

  // Line caps & icons
  assert.ok(appSrc.split('\n').length < 3500, `src/App.jsx exceeded 3500 lines: ${appSrc.split('\n').length}`);
  assert.ok(mainSrc.split('\n').length < 1600, `electron/main.js exceeded 1600 lines: ${mainSrc.split('\n').length}`);
  for (const src of [appSrc, sidebarJsx, inputBarJsx, fs.readFileSync(path.join(ROOT, 'src/components/InteractiveTutorialModal.jsx'), 'utf8')]) {
    for (const m of src.matchAll(/<Icon\s+name="([A-Za-z0-9_]+)"/g)) {
      assert.ok(icons[m[1]], `Missing Icon "${m[1]}" in src/icons.json`);
    }
  }

  for (let iter = 1; iter <= 20; iter++) {
    // 1. UI preset atomic sync + skipProviderSync
    assert.ok(appSrc.includes('skipProviderSync') && appSrc.includes('handleApplyPreset'), `Missing handleApplyPreset/skipProviderSync (iter ${iter})`);
    let prov = { model: 'claude-fable-5-2', routingMode: 'auto' };
    let orch = { enabled: false, providers: [{ model: 'claude-fable-5-2', enabled: true }], activeIndex: 0 };
    for (const pid of ['orchestrator', 'swarm', 'direct', 'auto']) {
      const r = presetsMod.applyBeginnerPreset(pid, { provider: prov, orchestrator: orch, reasoningLevel: 'auto', permissions: 'auto' });
      prov = r.provider;
      orch = r.orchestrator;
      assert.strictEqual(presetsMod.detectActivePreset(r).id, pid);
      if (pid === 'orchestrator' || pid === 'swarm') {
        assert.strictEqual(prov.routingMode, 'orchestrator');
        assert.strictEqual(orch.enabled, true);
      } else if (pid === 'auto') {
        assert.strictEqual(prov.routingMode, 'auto');
        assert.strictEqual(orch.enabled, false);
      } else {
        assert.strictEqual(prov.routingMode, 'direct');
        assert.strictEqual(orch.enabled, false);
      }
      // Also confirm syncProviderForOrchestratorToggle wouldn't drift when skipped vs normal
      assert.strictEqual(syncProviderForOrchestratorToggle({ model: 'x', routingMode: 'direct' }, { enabled: true }, { enabled: false }).routingMode, 'orchestrator');
    }

    // 2. Collapsed left sidebar & Model Picker CSS guards
    assert.ok(appSrc.includes('collapsed={sidebarCollapsed}'), 'ProjectsSidebar must receive collapsed={sidebarCollapsed}');
    assert.ok(sidebarJsx.includes('collapsed = false') && sidebarJsx.includes('{!collapsed && ('), 'ProjectsSidebar collapsed header guard missing');
    assert.ok(stylesCss.includes('.sidebar.collapsed .proj-group-head') && emeraldCss.includes('.sidebar.collapsed .proj-group-head'));
    assert.ok(stylesCss.includes('.model-menu') && /overflow-x:\s*hidden/.test(stylesCss.slice(stylesCss.indexOf('.model-menu'), stylesCss.indexOf('.model-menu') + 260)));
    assert.ok(/overflow-x:\s*hidden/.test(stylesCss.slice(stylesCss.indexOf('.orch-picker-body'), stylesCss.indexOf('.orch-picker-body') + 200)));
    assert.ok(inputBarJsx.includes('hasMatchingOrchRow'), 'Model picker must avoid duplicate supervisor checkmark');

    // 3. Gemini 2.5 + 3+ + thinking thoughtSignature injection
    for (const gm of ['gemini-2.5-flash-thinking', 'gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-4-carbon-high']) {
      const built = pt._internal.toGeminiContents([
        { role: 'user', content: 'run tool' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'Read', arguments: '{"path":"a.txt"}' } }] },
        { role: 'tool', tool_call_id: 'tc1', name: 'Read', content: 'ok' },
      ], gm);
      const modelTurn = built.contents.find((c) => c.role === 'model');
      assert.ok(modelTurn && modelTurn.parts[0].functionCall, `Missing functionCall for ${gm}`);
      assert.strictEqual(modelTurn.parts[0].thoughtSignature, 'skip_thought_signature_validator', `Missing thoughtSignature for ${gm} (iter ${iter})`);
    }

    // 4. Swarm frontier-only filter excludes haiku/flash/mini/nano/lite when frontier exists
    assert.strictEqual(swarmMod.isFrontier({ model: 'claude-haiku-5-5' }), false);
    assert.strictEqual(swarmMod.isFrontier({ model: 'gemini-2.5-flash-thinking' }), false);
    assert.strictEqual(swarmMod.isFrontier({ model: 'gpt-5-mini' }), false);
    assert.strictEqual(swarmMod.isFrontier({ model: 'claude-fable-5-2' }), true);
    assert.strictEqual(swarmMod.isFrontier({ model: 'claude-sonnet-5-5' }), true);
    assert.strictEqual(swarmMod.isFrontier({ model: 'gemini-4-carbon-high' }), true);
    assert.strictEqual(swarmMod.isFrontier({ model: 'gemini-2.5-pro' }), true);
    const frontierRoster = swarmMod.buildRoster({
      frontierOnly: true,
      orchestrator: {
        enabled: true,
        providers: [
          { model: 'claude-haiku-5-5', oauthProvider: 'claude:a' },
          { model: 'gemini-2.5-flash-thinking', oauthProvider: 'antigravity:a' },
          { model: 'claude-sonnet-5-5', oauthProvider: 'claude:a' },
          { model: 'gemini-4-carbon-high', oauthProvider: 'antigravity:a' },
        ],
      },
      provider: { model: 'claude-fable-5-2', oauthProvider: 'claude:a' },
    });
    assert.ok(frontierRoster.every((r) => !/haiku|flash/i.test(r.model)), `Unexpected non-frontier model in swarm roster: ${frontierRoster.map((r) => r.model).join(', ')}`);

    // Swarm preserves explicit caller tasks with brief/goal/subtasks aliases & prompt rule
    const normPlan = swarmMod.normalizePlan({
      subtasks: [
        { id: 'x1', name: 'Audit UI', brief: 'Inspect UI css' },
        { id: 'x2', label: 'Audit Bridge', goal: 'Inspect extbridge' },
      ],
    });
    assert.strictEqual(normPlan.subtasks.length, 2);
    assert.strictEqual(normPlan.subtasks[0].prompt, 'Inspect UI css');
    assert.strictEqual(normPlan.subtasks[1].prompt, 'Inspect extbridge');
    assert.ok(swarmMod.SUPERVISOR_PLAN_PROMPT.includes('preserve those EXACT subtasks 1-for-1'));

    // 5. llm.js blank post-tool/post-Swarm recovery guard
    assert.ok(llmSrc.includes('recentToolTurn') && llmSrc.includes('hasContinuePrompt') && llmSrc.includes('FINAL ANSWER'));

    // 6. Browser bot extension + tools.js contract checks
    assert.ok(extToolsSrc.includes('case "close_tab":') && extToolsSrc.includes('case "tabs_close":'));
    assert.ok(extToolsSrc.includes('args?.code ?? args?.expression ?? args?.script'));
    assert.ok(extToolsSrc.includes('ctx?.fromBridge'));
    assert.ok(extToolsSrc.includes('captureBackgroundTab(tabId)'));
    assert.ok(extSwSrc.includes('pickDefaultWebTabId') && extSwSrc.includes('runSidepanelBridgeAction'));
    assert.ok(extSwSrc.includes('sidepanel_send') && extSwSrc.includes('sidepanel_stop') && extSwSrc.includes('sidepanel_status'));
  }

  // Live mock HTTP peer test for extbridge shared-mode forwarding (127.0.0.1 ephemeral port)
  const receivedCalls = [];
  const tinyPngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
  const mockPeer = http.createServer((req, res) => {
    const pathname = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && pathname === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, mode: 'desktop-primary', yieldable: false }));
    }
    if (req.method === 'GET' && pathname === '/v1/ext/tabs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        extensionConnected: true,
        extensionVersion: '1.6.8',
        tabs: [{ id: 42, title: 'Mock Tab', url: 'https://example.com', active: true, windowId: 1 }],
      }));
    }
    if (req.method === 'POST' && pathname === '/v1/ext/tool') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const j = JSON.parse(body || '{}');
        receivedCalls.push(j);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        if (j.action === 'screenshot') {
          return res.end(JSON.stringify({ ok: true, result: { text: 'Captured', tabId: j.tabId || 42, image: `data:image/png;base64,${tinyPngB64}` } }));
        }
        return res.end(JSON.stringify({ ok: true, result: { text: `ran:${j.action}:${j.args?.code || ''}`, tabId: j.tabId || 42 } }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => mockPeer.listen(0, '127.0.0.1', resolve));
  const peerPort = mockPeer.address().port;
  try {
    const startRes = await extbridge.start({ port: peerPort });
    assert.strictEqual(startRes.ok, true);
    assert.strictEqual(startRes.shared, true);

    const tabs = await extbridge.listTabs();
    assert.strictEqual(tabs.length, 1);
    assert.strictEqual(tabs[0].id, 42);

    const jsOut = await tools.runTool('ext_browser', { action: 'execute_javascript', expression: 'document.title', tabId: '42' }, { cwd: ROOT });
    assert.ok(String(jsOut).includes('ran:execute_javascript:document.title'));
    assert.strictEqual(receivedCalls[0].tabId, 42);
    assert.strictEqual(receivedCalls[0].args.code, 'document.title');

    const tmpPng = path.join(os.tmpdir(), `ext-shot-v161-${Date.now()}.png`);
    const shotOut = await tools.runTool('ext_browser', { action: 'screenshot', path: tmpPng, tabId: 42 }, { cwd: ROOT });
    assert.ok(shotOut && typeof shotOut === 'object' && shotOut.imageDataUrl && shotOut.imageDataUrl.startsWith('data:image/png;base64,'));
    const parsedShot = JSON.parse(shotOut.content);
    assert.strictEqual(parsedShot.ok, true);
    assert.strictEqual(parsedShot.width, 1);
    assert.strictEqual(parsedShot.height, 1);
    assert.ok(fs.existsSync(tmpPng));
    fs.unlinkSync(tmpPng);
  } finally {
    await extbridge.stop();
    await new Promise((resolve) => mockPeer.close(resolve));
  }
});
