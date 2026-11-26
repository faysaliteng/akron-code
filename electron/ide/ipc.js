'use strict';
const { BrowserWindow } = require('electron');
const fsWatcher = require('./fs-watcher');
const search = require('./search');
const ptyMod = require('./pty');
const lspMod = require('./lsp');
const aiInline = require('./ai-inline');
const git = require('../git');
const { humanizeLLMError } = require('../llm');
const environments = require('../environments');
const layoutStore = require('./layout-store');

const inlineEditControllers = new Map();

function register({ ipcMain, normalizeProvider, hydrateProvider, hydrateOrchestrator, store, broadcast }) {
  // ---- Per-Workspace IDE Layout Persistence ----
  ipcMain.handle('ide:loadLayout', (e, payload) => layoutStore.loadLayout(payload && payload.cwd));
  ipcMain.handle('ide:saveLayout', (e, payload) => layoutStore.saveLayout(payload && payload.cwd, payload && payload.layout));
  const sendToSender = (event, channel, payload) => {
    try {
      const win = event && event.sender ? BrowserWindow.fromWebContents(event.sender) : null;
      if (win && !win.isDestroyed()) {
        win.webContents.send(channel, payload);
        return;
      }
    } catch (_) {}
    if (typeof broadcast === 'function') broadcast({ ...payload, ideChannel: channel });
  };

  // ---- File Tree & File CRUD + Watcher ----
  ipcMain.handle('ide:readTree', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'readTree', payload || {});
    return fsWatcher.readTree(payload && payload.cwd, payload || {});
  });
  ipcMain.handle('ide:readFile', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'readFile', payload || {});
    return fsWatcher.readFile(payload && payload.path, payload || {});
  });
  ipcMain.handle('ide:writeFile', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'writeFile', payload || {});
    return fsWatcher.writeFile(payload && payload.path, payload && payload.content);
  });
  ipcMain.handle('ide:createEntry', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'createEntry', payload || {});
    return fsWatcher.createEntry(payload && payload.path, payload && payload.kind);
  });
  ipcMain.handle('ide:renameEntry', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'renameEntry', payload || {});
    return fsWatcher.renameEntry(payload && payload.oldPath, payload && payload.newPath);
  });
  ipcMain.handle('ide:duplicateEntry', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'duplicateEntry', payload || {});
    return fsWatcher.duplicateEntry(payload && payload.path);
  });
  ipcMain.handle('ide:deleteEntry', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('fs', 'deleteEntry', payload || {});
    return fsWatcher.deleteEntry(payload && payload.path);
  });
  ipcMain.handle('ide:revealInOS', (e, payload) => fsWatcher.revealInOS(payload && payload.path));
  ipcMain.handle('ide:watchWorkspace', (e, payload) => {
    if (environments.isRemoteActive()) return { ok: true, remote: true };
    const cwd = payload && payload.cwd;
    return fsWatcher.watchWorkspace(cwd, (events) => {
      sendToSender(e, 'ide:fsChanged', { cwd, events });
    });
  });
  ipcMain.handle('ide:unwatchWorkspace', (e, payload) => {
    fsWatcher.unwatchWorkspace(payload && payload.cwd);
    return { ok: true };
  });

  // ---- Search & Replace ----
  ipcMain.handle('ide:search', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('search', 'search', payload || {});
    return search.searchWorkspace(payload || {});
  });
  ipcMain.handle('ide:replace', (e, payload) => {
    if (environments.isRemoteActive()) return environments.dispatchIde('search', 'replace', payload || {});
    return search.replaceInWorkspace(payload || {});
  });

  // ---- Real Interactive PTY ----
  const senderPtys = new Map(); // webContents -> Set<ptyId>
  const removeTrackedPty = (wc, id) => {
    const set = wc ? senderPtys.get(wc) : null;
    if (set) set.delete(id);
  };

  ipcMain.handle('ide:ptyCreate', (e, payload) => {
    const wc = e && e.sender;
    let res = null;
    if (wc && typeof wc.once === 'function' && !senderPtys.has(wc)) {
      const set = new Set();
      senderPtys.set(wc, set);
      wc.once('destroyed', () => {
        for (const pid of [...set]) {
          try { ptyMod.killPty(pid); } catch (_) {}
        }
        senderPtys.delete(wc);
      });
    }
    res = ptyMod.createPty(payload || {}, {
      onData: (id, data) => sendToSender(e, 'ide:ptyData', { id, data }),
      onExit: (id, exitCode) => {
        removeTrackedPty(wc, id);
        sendToSender(e, 'ide:ptyExit', { id, exitCode });
      },
    });
    if (res && res.ok && res.id && wc && senderPtys.has(wc)) {
      senderPtys.get(wc).add(res.id);
    }
    return res;
  });
  ipcMain.handle('ide:ptyWrite', (e, payload) => ptyMod.writePty(payload && payload.id, payload && payload.data));
  ipcMain.handle('ide:ptyResize', (e, payload) => ptyMod.resizePty(payload && payload.id, payload && payload.cols, payload && payload.rows));
  ipcMain.handle('ide:ptyKill', (e, payload) => {
    if (payload && payload.id && e && e.sender) removeTrackedPty(e.sender, payload.id);
    return ptyMod.killPty(payload && payload.id);
  });
  ipcMain.handle('ide:ptyList', () => ptyMod.listPtys());

  // ---- Pluggable LSP ----
  ipcMain.handle('ide:lspStatus', (e, payload) => lspMod.lspStatus(payload && payload.cwd));
  ipcMain.handle('ide:lspEnsure', (e, payload) => lspMod.lspEnsure(
    payload && payload.cwd,
    payload && payload.language,
    (diag) => sendToSender(e, 'ide:lspDiagnostics', diag),
    payload && payload.customCommand
  ));
  ipcMain.handle('ide:lspNotify', (e, payload) => lspMod.lspNotify(
    payload && payload.cwd,
    payload && payload.language,
    payload && payload.method,
    payload && payload.params,
    (diag) => sendToSender(e, 'ide:lspDiagnostics', diag)
  ));
  ipcMain.handle('ide:lspRequest', (e, payload) => lspMod.lspRequest(
    payload && payload.cwd,
    payload && payload.language,
    payload && payload.method,
    payload && payload.params,
    (diag) => sendToSender(e, 'ide:lspDiagnostics', diag)
  ));

  // ---- AI Inline Edit (Cmd+K), Ghost Text Completion & AI Commit Msg ----
  const resolveAuth = async (payload) => {
    const provRaw = (payload && payload.provider) || (store.getSettings().provider) || {};
    const provider = await hydrateProvider(normalizeProvider(provRaw));
    const orchRaw = (payload && payload.orchestrator) || store.getOrchestrator();
    const hy = await hydrateOrchestrator(orchRaw, hydrateProvider);
    return { provider, orchestrator: hy.orch || orchRaw };
  };

  ipcMain.handle('ide:inlineEdit', async (e, payload) => {
    const editId = (payload && payload.editId) || ('edit_' + Date.now());
    const ac = new AbortController();
    inlineEditControllers.set(editId, ac);
    try {
      const { provider, orchestrator } = await resolveAuth(payload);
      const res = await aiInline.runInlineEdit({
        ...(payload || {}),
        provider,
        orchestrator,
        signal: ac.signal,
        onDelta: (delta, full) => {
          sendToSender(e, 'ide:inlineEditDelta', { editId, delta, full });
        },
      });
      return { ...res, editId };
    } catch (err) {
      if (ac.signal.aborted) return { ok: false, editId, aborted: true };
      return { ok: false, editId, error: humanizeLLMError(err) };
    } finally {
      inlineEditControllers.delete(editId);
    }
  });

  ipcMain.handle('ide:inlineEditCancel', (e, editId) => {
    const ac = inlineEditControllers.get(editId);
    if (ac) { try { ac.abort(); } catch (_) {} }
    return { ok: true };
  });

  ipcMain.handle('ide:inlineComplete', async (e, payload) => {
    try {
      const { provider, orchestrator } = await resolveAuth(payload);
      return await aiInline.runInlineComplete({ ...(payload || {}), provider, orchestrator });
    } catch (err) {
      return { ok: false, insertText: '', error: humanizeLLMError(err) };
    }
  });

  ipcMain.handle('ide:generateCommitMsg', async (e, payload) => {
    try {
      const { provider, orchestrator } = await resolveAuth(payload);
      return await aiInline.generateCommitMessage({ ...(payload || {}), provider, orchestrator });
    } catch (err) {
      return { ok: false, error: humanizeLLMError(err) };
    }
  });

  // ---- Extended Git Source Control ----
  ipcMain.handle('ide:gitStatus', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'status', payload || {}) : git.gitStatusDetailed(payload && payload.cwd));
  ipcMain.handle('ide:gitStage', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'stage', payload || {}) : git.stageFiles(payload && payload.cwd, payload && payload.files));
  ipcMain.handle('ide:gitUnstage', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'unstage', payload || {}) : git.unstageFiles(payload && payload.cwd, payload && payload.files));
  ipcMain.handle('ide:gitStagePatch', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'stagePatch', payload || {}) : git.stagePatch(payload && payload.cwd, payload && payload.patch, !!(payload && payload.reverse)));
  ipcMain.handle('ide:gitDiscard', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'discard', payload || {}) : git.discardFiles(payload && payload.cwd, payload && payload.files));
  ipcMain.handle('ide:gitCommit', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'commit', payload || {}) : git.commitChanges(payload && payload.cwd, payload && payload.message));
  ipcMain.handle('ide:gitBranches', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'branches', payload || {}) : git.listBranches(payload && payload.cwd));
  ipcMain.handle('ide:gitCheckout', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'checkout', payload || {}) : git.checkoutBranch(payload && payload.cwd, payload && payload.branch, !!(payload && payload.createNew)));
  ipcMain.handle('ide:gitFileAtHead', (e, payload) => environments.isRemoteActive() ? environments.dispatchIde('git', 'fileAtHead', payload || {}) : git.fileAtHead(payload && payload.cwd, payload && payload.path));
}

function hasActivePtys() {
  return ptyMod.hasActiveSessions();
}

function cleanup() {
  try { fsWatcher.unwatchAll(); } catch (_) {}
  try { lspMod.lspStopAll(); } catch (_) {}
  for (const [, ac] of inlineEditControllers) {
    try { ac.abort(); } catch (_) {}
  }
  inlineEditControllers.clear();
  try { return ptyMod.shutdown(); } catch (_) { return Promise.resolve(); }
}

module.exports = { register, cleanup, hasActivePtys };
