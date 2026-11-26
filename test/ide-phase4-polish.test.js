'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

(async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

  // 1. OS-aware shortcuts (macOS vs Windows)
  const scMod = await import('../src/ide/shortcuts.js');
  const macSc = scMod.shortcutLabels('darwin');
  const winSc = scMod.shortcutLabels('win32');
  assert.strictEqual(macSc.isWin, false);
  assert.strictEqual(macSc.quickOpen, '⌘P');
  assert.strictEqual(macSc.inlineEdit, '⌘K');
  assert.strictEqual(macSc.globalSearch, '⇧⌘F');
  assert.strictEqual(macSc.revealLabel, 'Reveal in Finder');
  assert.strictEqual(winSc.isWin, true);
  assert.strictEqual(winSc.quickOpen, 'Ctrl+P');
  assert.strictEqual(winSc.inlineEdit, 'Ctrl+K');
  assert.strictEqual(winSc.globalSearch, 'Ctrl+Shift+F');
  assert.strictEqual(winSc.submit, 'Ctrl+Enter');
  assert.strictEqual(winSc.revealLabel, 'Reveal in Explorer');
  console.log('✓ shortcuts.js (darwin + win32 labels)');

  // 2. Per-workspace IDE layout persistence
  const layoutStore = require('../electron/ide/layout-store');
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-layout-test-'));
  const origHome = process.env.HOME;
  process.env.HOME = fakeHome;
  const origHomedir = os.homedir;
  os.homedir = () => fakeHome;
  try {
    const ws = path.join(fakeHome, 'demo-proj');
    fs.mkdirSync(ws, { recursive: true });
    const empty = layoutStore.loadLayout(ws);
    assert(empty.ok && empty.layout === null);

    const saved = layoutStore.saveLayout(ws, {
      openTabs: [{ path: path.join(ws, 'index.js'), pinned: true }],
      activeTabPath: path.join(ws, 'index.js'),
      splitTabPath: null,
      viewStates: { [path.join(ws, 'index.js')]: { line: 42, column: 7, scrollTop: 320 } },
      leftTab: 'changes',
      leftW: 260,
      bottomTab: 'terminal',
      bottomH: 240,
      rightOpen: true,
      rightW: 410,
      ghostEnabled: true,
      terminalSerialized: 'akron$ echo hello\r\nhello\r\n',
    });
    assert(saved.ok, saved.error);

    const loaded = layoutStore.loadLayout(ws);
    assert(loaded.ok && loaded.layout);
    assert.strictEqual(loaded.layout.leftTab, 'changes');
    assert.strictEqual(loaded.layout.leftW, 260);
    assert.strictEqual(loaded.layout.ghostEnabled, true);
    assert.strictEqual(loaded.layout.openTabs.length, 1);
    assert.strictEqual(loaded.layout.viewStates[path.join(ws, 'index.js')].line, 42);
    assert(loaded.layout.terminalSerialized.includes('echo hello'));
    console.log('✓ layout-store.js save/load roundtrip');
  } finally {
    os.homedir = origHomedir;
    process.env.HOME = origHome;
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }

  // 3. File watcher backend + event delivery
  const fsWatcher = require('../electron/ide/fs-watcher');
  const backend = fsWatcher.watcherBackend();
  assert(backend === 'parcel' || backend === 'fs.watch', 'unexpected watcher backend: ' + backend);
  const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'akron-watch-test-'));
  try {
    let seen = false;
    const wRes = fsWatcher.watchWorkspace(watchDir, (evts) => {
      if (Array.isArray(evts) && evts.length) seen = true;
    });
    assert(wRes.ok, wRes.error);
    await new Promise((r) => setTimeout(r, 150));
    fs.writeFileSync(path.join(watchDir, 'hello.txt'), 'world', 'utf8');
    const deadline = Date.now() + 2500;
    while (!seen && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
    }
    fsWatcher.unwatchWorkspace(watchDir);
    assert(seen, `expected file change event from ${backend}`);
    console.log(`✓ fs-watcher.js (${backend}) delivered file change event`);
  } finally {
    fsWatcher.unwatchAll();
    fs.rmSync(watchDir, { recursive: true, force: true });
  }

  // 4. Distinct Windows NSIS + Portable artifact names
  assert(pkg.build?.nsis?.artifactName && pkg.build?.portable?.artifactName);
  assert.notStrictEqual(pkg.build.nsis.artifactName, pkg.build.portable.artifactName);
  assert(pkg.build.nsis.artifactName.includes('setup') && pkg.build.portable.artifactName.includes('portable'));
  console.log('✓ package.json distinct Windows NSIS + Portable artifact names');

  // 5. Phase 4 components exist and are wired
  const wb = fs.readFileSync(path.join(__dirname, '..', 'src', 'ide', 'IdeWorkbench.jsx'), 'utf8');
  assert(wb.includes('IdeStatusBar'), 'IdeStatusBar must be mounted in IdeWorkbench');
  assert(wb.includes('AgentChangesPanel'), 'AgentChangesPanel must be mounted in IdeWorkbench');
  assert(wb.includes('ideLoadLayout') && wb.includes('ideSaveLayout'), 'layout persistence must be wired');
  const tp = fs.readFileSync(path.join(__dirname, '..', 'src', 'ide', 'TerminalPanel.jsx'), 'utf8');
  assert(tp.includes('SearchAddon') && tp.includes('WebLinksAddon') && tp.includes('SerializeAddon'), 'xterm addons missing');
  assert(tp.includes('setTimeout(flushWrites, 14)'), 'PTY <=16ms batching missing');
  console.log('✓ Phase 4 UI components & xterm addons verified');

  console.log('\nIDE_PHASE4_POLISH_ALL_PASS');
})();
