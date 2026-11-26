'use strict';
const assert = require('assert');
const extbridge = require('../../electron/extbridge');

async function main() {
  const started = await extbridge.start({ port: 8766 });
  assert.ok(started && started.ok, 'extbridge failed to bind :8766: ' + (started && started.error));
  try {
    let st = null;
    for (let i = 0; i < 24; i++) {
      st = await extbridge.status();
      if (st.extensionConnected) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(st && st.extensionConnected, 'Akron Browser Bot extension did not connect within 12s');
    console.log(`EXT_BRIDGE_CONNECTED: version=${st.extensionVersion} clients=${st.connectedClients}`);

    const listed = await extbridge.callTool('list_tabs');
    assert.ok(Array.isArray(listed.tabs), 'list_tabs must return tabs array');
    console.log(`EXT_LIST_TABS_OK: openTabs=${listed.tabs.length}`);

    const opened = await extbridge.callTool('open_tab', { url: 'https://example.com', active: false });
    assert.ok(opened && Number.isInteger(opened.tabId), 'open_tab must return integer tabId');
    console.log(`EXT_OPEN_TAB_OK: tabId=${opened.tabId}`);

    const readRes = await extbridge.callTool('read_text', { maxChars: 2000 }, opened.tabId);
    assert.ok(readRes && /documentation examples/i.test(String(readRes.text || '')), 'read_text on example.com failed: ' + JSON.stringify(readRes));
    console.log('EXT_READ_TEXT_OK: verified live page text from external Brave tab');

    const jsRes = await extbridge.callTool('execute_javascript', { code: 'document.title' }, opened.tabId);
    assert.ok(jsRes && /Example Domain/i.test(String(jsRes.text || '')), 'execute_javascript failed: ' + JSON.stringify(jsRes));
    console.log('EXT_JS_EVAL_OK: title=' + String(jsRes.text || '').trim());

    const shotRes = await extbridge.callTool('screenshot', {}, opened.tabId);
    assert.ok(shotRes && typeof shotRes.image === 'string' && shotRes.image.startsWith('data:image/png;base64,'), 'screenshot failed');
    console.log('EXT_SCREENSHOT_OK: bytes=' + shotRes.image.length);

    console.log('EXT_BROWSER_LIVE_E2E_OK');
  } finally {
    await extbridge.stop();
  }
}

main().catch((e) => {
  console.error('EXT_BROWSER_E2E_FAILED:', e);
  process.exit(1);
});
