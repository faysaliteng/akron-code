'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');

function loadInlineDiffModule() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'InlineEditWidget.jsx'), 'utf8');
  const out = esbuild.transformSync(src, { loader: 'jsx', format: 'cjs', target: 'node20' });
  const mod = { exports: {} };
  const reactStub = {
    default: { createElement: () => null },
    useState: (v) => [v, () => {}],
    useEffect: () => {},
    useRef: (v) => ({ current: v }),
  };
  const fn = new Function('require', 'module', 'exports', out.code);
  fn((id) => (id === 'react' ? reactStub : id.endsWith('/shortcuts') ? { shortcutLabels: () => ({}) } : require(id)), mod, mod.exports);
  return mod.exports;
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log('  ok   - ' + name);
  } catch (e) {
    results.push({ name, ok: false, err: e });
    console.error('  FAIL - ' + name + ': ' + (e && e.stack ? e.stack : e));
  }
}

(async () => {
  console.log('\nIDE Workbench Fixes Regression Verification');

  await test('MonacoPane maintains per-file Uri models, restores viewState only on activeTabPath switch, and maps marker resources accurately', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'MonacoPane.jsx'), 'utf8');
    assert.ok(src.includes('monaco.Uri.file(tab.path)'), 'must key models by monaco.Uri.file(tab.path)');
    assert.ok(src.includes('monaco.editor.getModel(uri)'), 'must reuse cached per-file model');
    assert.ok(/\[activeTab\?\.path\]/.test(src), 'viewState restore must run on activeTab?.path change only');
    assert.ok(src.includes('m.resource.fsPath'), 'marker resolution must inspect m.resource');
    assert.ok(src.includes('splitTab') && src.includes('getOrCreateFileModel(splitTab)'), 'split editor must attach shared per-file model');
  });

  await test('IdeWorkbench & TerminalPanel keep terminal mounted across bottomTab toggles and clean up PTYs on exit/split-close/cwd switch', () => {
    const wb = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'IdeWorkbench.jsx'), 'utf8');
    const tp = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'TerminalPanel.jsx'), 'utf8');
    assert.ok(wb.includes("display: bottomTab === 'terminal' ? 'flex' : 'none'"), 'TerminalPanel must stay mounted when hidden');
    assert.ok(tp.includes('prevCwdRef'), 'TerminalPanel must clean up PTYs when cwd switches');
    assert.ok(tp.includes('killTab(splitId)'), 'Closing split terminal must kill split PTY');
    assert.ok(/onIdePtyExit[\s\S]*setActiveId[\s\S]*setSplitId/.test(tp), 'onIdePtyExit must advance activeId and clear splitId');
  });

  await test('tooLarge (>2MB) guard protects large files and cwd reset clears open tabs & markers', () => {
    const fsw = require(path.join(ROOT, 'electron', 'ide', 'fs-watcher.js'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-big-'));
    try {
      const big = path.join(tmp, 'big.log');
      fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024 + 32, 65));
      const res = fsw.readFile(big);
      assert.strictEqual(res.ok, true);
      assert.strictEqual(res.tooLarge, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    const wb = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'IdeWorkbench.jsx'), 'utf8');
    assert.ok(wb.includes('if (r.tooLarge)'), 'openFile must refuse >2MB files cleanly');
    assert.ok(wb.includes('setTabs([])') && wb.includes('setLspMarkers([])'), 'workspace change must reset tabs and markers');
  });

  await test('Quick Open @ symbols, akron.fixDiagnostic command, text/akron-file drop & LSP lifecycle are wired', () => {
    const setupSrc = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'monacoSetup.js'), 'utf8');
    const wbSrc = fs.readFileSync(path.join(ROOT, 'src', 'ide', 'IdeWorkbench.jsx'), 'utf8');
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'App.jsx'), 'utf8');
    assert.ok(setupSrc.includes("registerCommand('akron.fixDiagnostic'"), 'monacoSetup must register akron.fixDiagnostic command');
    assert.ok(setupSrc.includes('registerHoverProvider') && setupSrc.includes('registerDefinitionProvider'), 'LSP hover/def bridges must be registered');
    assert.ok(wbSrc.includes('extractSymbolsFromText(activeTab.content)'), 'QuickOpen must receive dynamic symbols');
    assert.ok(wbSrc.includes("'textDocument/didChange'") && wbSrc.includes("'textDocument/didSave'") && wbSrc.includes("'textDocument/didClose'"));
    assert.ok(appSrc.includes("getData?.('text/akron-file')") || appSrc.includes("getData('text/akron-file')"), 'InputBar drop handler must support text/akron-file');
    assert.ok(appSrc.includes("workbenchMode === 'ide' && !inAgentDock"), 'App global shortcuts must not hijack IDE pane');
  });

  await test('InlineEditWidget uses real LCS line diff (insertion/deletion alignment without lockstep drift)', () => {
    const { buildInlineDiffLines } = loadInlineDiffModule();
    const diff = buildInlineDiffLines('line1\nline2\nline3', 'line1\ninserted\nline2\nline3');
    assert.deepStrictEqual(diff, [
      { type: 'ctx', text: 'line1' },
      { type: 'add', text: 'inserted' },
      { type: 'ctx', text: 'line2' },
      { type: 'ctx', text: 'line3' },
    ]);
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
})();
