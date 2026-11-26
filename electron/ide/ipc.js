'use strict';
const { BrowserWindow } = require('electron');
const fsWatcher = require('./fs-watcher');
const search = require('./search');
const ptyMod = require('./pty');
const lspMod = require('./lsp');
const aiInline = require('./ai-inline');
const git = require('../git');
const { humanizeLLMError } = require('../llm');

const inlineEditControllers = new Map();

function register({ ipcMain, normalizeProvider, hydrateProvider, hydrateOrchestrator, store, broadcast }) {
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
  ipcMain.handle('ide:readTree', (e, payload) => fsWatcher.readTree(payload && payload.cwd, payload || {}));
  ipcMain.handle('ide:readFile', (e, payload) => fsWatcher.readFile(payload && payload.path, payload || {}));
  ipcMain.handle('ide:writeFile', (e, payload) => fsWatcher.writeFile(payload && payload.path, payload && payload.content));
  ipcMain.handle('ide:createEntry', (e, payload) => fsWatcher.createEntry(payload && payload.path, payload && payload.kind));
  ipcMain.handle('ide:renameEntry', (e, payload) => fsWatcher.renameEntry(payload && payload.oldPath, payload && payload.newPath));
  ipcMain.handle('ide:duplicateEntry', (e, payload) => fsWatcher.duplicateEntry(payload && payload.path));
  ipcMain.handle('ide:deleteEntry', (e, payload) => fsWatcher.deleteEntry(payload && payload.path));
  ipcMain.handle('ide:revealInOS', (e, payload) => fsWatcher.revealInOS(payload && payload.path));
  ipcMain.handle('ide:watchWorkspace', (e, payload) => {
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
  ipcMain.handle('ide:search', (e, payload) => search.searchWorkspace(payload || {}));
  ipcMain.handle('ide:replace', (e, payload) => search.replaceInWorkspace(payload || {}));

  // ---- Real Interactive PTY ----
  ipcMain.handle('ide:ptyCreate', (e, payload) => {
    return ptyMod.createPty(payload || {}, {
      onData: (id, data) => sendToSender(e, 'ide:ptyData', { id, data }),
      onExit: (id, exitCode) => sendToSender(e, 'ide:ptyExit', { id, exitCode }),
    });
  });
  ipcMain.handle('ide:ptyWrite', (e, payload) => ptyMod.writePty(payload && payload.id, payload && payload.data));
  ipcMain.handle('ide:ptyResize', (e, payload) => ptyMod.resizePty(payload && payload.id, payload && payload.cols, payload && payload.rows));
  ipcMain.handle('ide:ptyKill', (e, payload) => ptyMod.killPty(payload && payload.id));
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
  ipcMain.handle('ide:gitStatus', (e, payload) => git.gitStatusDetailed(payload && payload.cwd));
  ipcMain.handle('ide:gitStage', (e, payload) => git.stageFiles(payload && payload.cwd, payload && payload.files));
  ipcMain.handle('ide:gitUnstage', (e, payload) => git.unstageFiles(payload && payload.cwd, payload && payload.files));
  ipcMain.handle('ide:gitStagePatch', (e, payload) => git.stagePatch(payload && payload.cwd, payload && payload.patch, !!(payload && payload.reverse)));
  ipcMain.handle('ide:gitDiscard', (e, payload) => git.discardFiles(payload && payload.cwd, payload && payload.files));
  ipcMain.handle('ide:gitCommit', (e, payload) => git.commitChanges(payload && payload.cwd, payload && payload.message));
  ipcMain.handle('ide:gitBranches', (e, payload) => git.listBranches(payload && payload.cwd));
  ipcMain.handle('ide:gitCheckout', (e, payload) => git.checkoutBranch(payload && payload.cwd, payload && payload.branch, !!(payload && payload.createNew)));
  ipcMain.handle('ide:gitFileAtHead', (e, payload) => git.fileAtHead(payload && payload.cwd, payload && payload.path));
}

function cleanup() {
  try { fsWatcher.unwatchAll(); } catch (_) {}
  try { ptyMod.killAll(); } catch (_) {}
  try { lspMod.lspStopAll(); } catch (_) {}
  for (const [, ac] of inlineEditControllers) {
    try { ac.abort(); } catch (_) {}
  }
  inlineEditControllers.clear();
}

module.exports = { register, cleanup };
