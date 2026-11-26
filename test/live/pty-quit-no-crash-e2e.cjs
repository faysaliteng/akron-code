const { dialog } = require('electron'); dialog.showErrorBox = () => {};
const assert = require('assert');
const { app } = require('electron');
const ptyMod = require('../../electron/ide/pty');
const ideIpc = require('../../electron/ide/ipc');

let ptyQuitDrained = false;
app.on('before-quit', (e) => {
  if (ptyQuitDrained) return;
  if (ideIpc.hasActivePtys()) {
    e.preventDefault();
    ptyQuitDrained = true;
    Promise.resolve(ideIpc.cleanup())
      .catch(() => {})
      .finally(() => { app.quit(); });
  }
});

app.on('will-quit', () => {
  try { ideIpc.cleanup(); } catch (_) {}
});

app.whenReady().then(async () => {
  try {
    let out1 = '';
    let out2 = '';
    const s1 = ptyMod.createPty({ cols: 90, rows: 24 }, { onData: (_id, d) => { out1 += d; } });
    const s2 = ptyMod.createPty({ cols: 90, rows: 24, forceWorker: true }, { onData: (_id, d) => { out2 += d; } });
    assert(s1.ok && s2.ok, 'Both PTY sessions must start cleanly');
    ptyMod.writePty(s1.id, 'echo QUIT_RACE_OK_1\r');
    ptyMod.writePty(s2.id, 'echo QUIT_RACE_OK_2\r');

    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && (!out1.includes('QUIT_RACE_OK_1') || !out2.includes('QUIT_RACE_OK_2'))) {
      await new Promise((r) => setTimeout(r, 60));
    }
    assert(out1.includes('QUIT_RACE_OK_1'), `Missing output 1 (${s1.backend}): ${out1.slice(0, 120)}`);
    assert(out2.includes('QUIT_RACE_OK_2'), `Missing output 2 (${s2.backend}): ${out2.slice(0, 120)}`);
    console.log('PTY_QUIT_E2E_STARTED', s1.backend, s2.backend);

    // Exercise graceful quit while PTYs are still alive (regression check against SIGABRT)
    app.quit();
  } catch (err) {
    console.error('PTY_QUIT_E2E_FAIL:', err);
    app.exit(1);
  }
});
