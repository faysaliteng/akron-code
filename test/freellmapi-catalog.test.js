'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const catMod = require(path.join(ROOT, 'electron/freellmapi-catalog'));
const localRt = require(path.join(ROOT, 'electron/local-runtime'));
const freellm = require(path.join(ROOT, 'electron/freellm'));

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
    failed++;
  }
}

(async () => {
  console.log('\n=== FREELMAPI 1,575-MODEL CATALOG & CROSS-PLATFORM ENGINE TESTS ===');

  await test('Unlocked catalog contains exact 1,575 models (1,345 chat / 74p + 150 multimodal / 7 mod + 80 embed / 16p)', () => {
    const summary = catMod.getCatalogSummary();
    assert.strictEqual(summary.ok, true);
    assert.strictEqual(summary.unlocked, true);
    assert.strictEqual(summary.totals.totalModels, 1575);
    assert.strictEqual(summary.totals.chatModels, 1345);
    assert.strictEqual(summary.totals.chatPlatforms, 74);
    assert.strictEqual(summary.totals.mediaModels, 150);
    assert.strictEqual(summary.totals.mediaModalities, 7);
    assert.strictEqual(summary.totals.embeddingModels, 80);
    assert.strictEqual(summary.totals.embeddingPlatforms, 16);
    assert.ok(summary.totals.totalPlatforms >= 95);

    const openAiList = catMod.toOpenAIModels();
    assert.strictEqual(openAiList.length, 1345);
    assert.ok(openAiList.some((m) => m.id.startsWith('huggingface/')));
    assert.ok(openAiList.some((m) => m.id.startsWith('electronhub/')));
    assert.ok(catMod.listMediaModels({ modality: 'video' }).length === 5);
    assert.ok(catMod.listMediaModels({ modality: 'search' }).length === 10);
    assert.ok(catMod.listMediaModels({ modality: 'image' }).length === 35);
    assert.ok(catMod.listMediaModels({ modality: 'audio' }).length === 45);
    assert.ok(catMod.listMediaModels({ modality: 'transcription' }).length === 28);
    assert.ok(catMod.listMediaModels({ modality: 'decision' }).length === 20);
    assert.ok(catMod.listMediaModels({ modality: 'translation_summarization' }).length === 7);
    assert.strictEqual(catMod.listEmbeddingModels().length, 80);
  });

  await test('Cross-platform FreeLLMAPI desktop detector handles macOS, Windows, and Linux paths without crashes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-detect-'));
    try {
      const macHome = path.join(tmp, 'mac');
      const winHome = path.join(tmp, 'win');
      const linHome = path.join(tmp, 'lin');
      fs.mkdirSync(path.join(macHome, 'Library', 'Application Support', 'FreeLLMAPI'), { recursive: true });
      fs.writeFileSync(path.join(macHome, 'Library', 'Application Support', 'FreeLLMAPI', 'freeapi.db'), '');

      const macInfo = localRt.detectFreeLLMAPIRuntime({ platform: 'darwin', homedir: macHome, env: {} });
      assert.strictEqual(macInfo.platform, 'darwin');
      assert.strictEqual(macInfo.dbDetected, true);
      assert.strictEqual(macInfo.recommendedEndpoint, 'http://127.0.0.1:31415/v1');

      const winLocal = path.join(tmp, 'winLocal');
      fs.mkdirSync(path.join(winLocal, 'Programs', 'FreeLLMAPI'), { recursive: true });
      fs.writeFileSync(path.join(winLocal, 'Programs', 'FreeLLMAPI', 'FreeLLMAPI.exe'), '');
      const winInfo = localRt.detectFreeLLMAPIRuntime({
        platform: 'win32',
        homedir: winHome,
        env: { LOCALAPPDATA: winLocal, APPDATA: path.join(tmp, 'winApp') },
      });
      assert.strictEqual(winInfo.platform, 'win32');
      assert.strictEqual(winInfo.desktopInstalled, true);
      assert.ok(winInfo.appPath.endsWith('FreeLLMAPI.exe'));

      fs.mkdirSync(path.join(linHome, '.local', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(linHome, '.local', 'bin', 'freellmapi'), '');
      const linInfo = localRt.detectFreeLLMAPIRuntime({ platform: 'linux', homedir: linHome, env: {} });
      assert.strictEqual(linInfo.platform, 'linux');
      assert.strictEqual(linInfo.desktopInstalled, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  await test('importFreeLLMKeys & exportFreeLLMKeys support catalog platforms (e.g. huggingface, mistral) and built-in router /v1/catalog', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flm-keys-'));
    const cfgPath = path.join(tmp, 'freellm.json');
    try {
      const imp = localRt.importFreeLLMKeys({
        groq: 'gsk_test_1',
        mistral: 'msk_test_2',
        huggingface: 'hf_test_3',
      }, { configPath: cfgPath });
      assert.strictEqual(imp.ok, true);
      assert.strictEqual(imp.importedCount, 3);
      assert.ok(imp.unifiedKey && imp.unifiedKey.startsWith('flm_akron_'));

      const cfg = freellm.loadConfig(cfgPath);
      assert.strictEqual(freellm.isConfigured('huggingface', cfg), true);
      assert.strictEqual(freellm.isConfigured('mistral', cfg), true);
      assert.strictEqual(freellm.hasInternalProviders(cfg), true);

      const exp = localRt.exportFreeLLMKeys({ configPath: cfgPath });
      assert.strictEqual(exp.ok, true);
      assert.strictEqual(exp.payload.providers.huggingface.apiKey, 'hf_test_3');

      const handle = await freellm.start({ config: cfg, port: 0 });
      try {
        const res = await fetch(`${handle.url}/catalog`);
        assert.strictEqual(res.status, 200);
        const body = await res.json();
        assert.strictEqual(body.totals.totalModels, 1575);
      } finally {
        await handle.stop();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} tests failed (${passed} passed)`);
    process.exit(1);
  }
  console.log(`\nALL_FREELLMAPI_CATALOG_TESTS_PASSED (${passed}/${passed})`);
})();
