'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autobot', {
  run: (payload) => ipcRenderer.invoke('autobot:run', payload),
  cancel: (runId) => ipcRenderer.invoke('autobot:cancel', runId),
  // One-shot completion used by GUI slash commands (/compact, /btw, /recap,
  // /advisor). Same request path + retry semantics as a full run.
  chatOnce: (payload) => ipcRenderer.invoke('autobot:chatOnce', payload),
  compact: (payload) => ipcRenderer.invoke('autobot:compact', payload),
  testProvider: (provider) => ipcRenderer.invoke('autobot:testProvider', provider),
  probeProviders: (list) => ipcRenderer.invoke('autobot:probeProviders', list),
  ollamaModels: (baseURL) => ipcRenderer.invoke('autobot:ollamaModels', baseURL),
  ollamaServe: (action) => ipcRenderer.invoke('autobot:ollamaServe', action),
  onEvent: (cb) => {
    const handler = (event, payload) => cb(payload);
    ipcRenderer.on('autobot:event', handler);
    return () => ipcRenderer.removeListener('autobot:event', handler);
  },

  getMemory: () => ipcRenderer.invoke('autobot:getMemory'),
  addMemory: (content) => ipcRenderer.invoke('autobot:addMemory', content),
  clearMemory: () => ipcRenderer.invoke('autobot:clearMemory'),
  getSkills: () => ipcRenderer.invoke('autobot:getSkills'),
  loadSkill: (name) => ipcRenderer.invoke('autobot:loadSkill', name),
  setSkillEnabled: (name, enabled) => ipcRenderer.invoke('autobot:setSkillEnabled', name, enabled),
  setAllSkillsEnabled: (enabled) => ipcRenderer.invoke('autobot:setAllSkillsEnabled', enabled),
  addSkill: (name, content) => ipcRenderer.invoke('autobot:addSkill', name, content),
  deleteSkill: (name) => ipcRenderer.invoke('autobot:deleteSkill', name),
  pickSkillFile: () => ipcRenderer.invoke('autobot:pickSkillFile'),

  listPlugins: (opts) => ipcRenderer.invoke('autobot:listPlugins', opts),
  pluginCategories: () => ipcRenderer.invoke('autobot:pluginCategories'),
  searchPlugins: (query, opts) => ipcRenderer.invoke('autobot:searchPlugins', query, opts),
  suggestPlugins: (goal, opts) => ipcRenderer.invoke('autobot:suggestPlugins', goal, opts),
  installPlugin: (id) => ipcRenderer.invoke('autobot:installPlugin', id),
  uninstallPlugin: (id) => ipcRenderer.invoke('autobot:uninstallPlugin', id),
  pluginStats: () => ipcRenderer.invoke('autobot:pluginStats'),
  refreshRegistry: (opts) => ipcRenderer.invoke('autobot:refreshRegistry', opts),
  registryStatus: () => ipcRenderer.invoke('autobot:registryStatus'),
  pluginAuthStart: (id, opts) => ipcRenderer.invoke('autobot:pluginAuthStart', id, opts),
  pluginAuthStatus: (id) => ipcRenderer.invoke('autobot:pluginAuthStatus', id),
  pluginSignOut: (id) => ipcRenderer.invoke('autobot:pluginSignOut', id),

  // Subscription accounts (Claude Max / ChatGPT / Antigravity / Grok). Only
  // non-secret status crosses the bridge; tokens stay in the main process.
  providerStatus: () => ipcRenderer.invoke('autobot:providerStatus'),
  providerModels: (id) => ipcRenderer.invoke('autobot:providerModels', id),
  providerSignIn: (id) => ipcRenderer.invoke('autobot:providerSignIn', id),
  providerSignOut: (id, account) => ipcRenderer.invoke('autobot:providerSignOut', id, account),
  providerImport: () => ipcRenderer.invoke('autobot:providerImport'),
  providerAddBearer: (id, token, label) => ipcRenderer.invoke('autobot:providerAddBearer', id, token, label),
  providerSetActive: (id, account) => ipcRenderer.invoke('autobot:providerSetActive', id, account),

  // FreeLLMAPI — the local OpenAI-compatible router that aggregates the free
  // provider keys. Status/models never include key material.
  freellmStatus: () => ipcRenderer.invoke('autobot:freellmStatus'),
  freellmProviders: () => ipcRenderer.invoke('autobot:freellmProviders'),
  freellmSave: (patch) => ipcRenderer.invoke('autobot:freellmSave', patch),

  // Bundled agent runtimes (Claude Code / Codex / Grok CLI). `runtimes` returns
  // non-secret status only: version, latest version, source, update availability.
  runtimes: () => ipcRenderer.invoke('autobot:runtimes'),
  runtimesCheck: () => ipcRenderer.invoke('autobot:runtimesCheck'),
  runtimesUpdate: (id, force) => ipcRenderer.invoke('autobot:runtimesUpdate', id, !!force),
  runtimesRollback: (id) => ipcRenderer.invoke('autobot:runtimesRollback', id),
  runtimesAutoUpdate: (on) => ipcRenderer.invoke('autobot:runtimesAutoUpdate', on),

  listScheduledTasks: () => ipcRenderer.invoke('autobot:listScheduledTasks'),
  createScheduledTask: (input) => ipcRenderer.invoke('autobot:createScheduledTask', input),
  updateScheduledTask: (id, patch) => ipcRenderer.invoke('autobot:updateScheduledTask', id, patch),
  deleteScheduledTask: (id) => ipcRenderer.invoke('autobot:deleteScheduledTask', id),
  runScheduledTask: (id) => ipcRenderer.invoke('autobot:runScheduledTask', id),
  getSettings: () => ipcRenderer.invoke('autobot:getSettings'),
  getSandbox: () => ipcRenderer.invoke('autobot:getSandbox'),
  setSandbox: (patch) => ipcRenderer.invoke('autobot:setSandbox', patch),
  sandboxCheck: (payload) => ipcRenderer.invoke('autobot:sandboxCheck', payload),
  secretSet: (payload) => ipcRenderer.invoke('autobot:secretSet', payload),
  secretGet: (name) => ipcRenderer.invoke('autobot:secretGet', name),
  secretDelete: (name) => ipcRenderer.invoke('autobot:secretDelete', name),
  secretList: () => ipcRenderer.invoke('autobot:secretList'),
  secretStatus: () => ipcRenderer.invoke('autobot:secretStatus'),
  searchAll: (payload) => ipcRenderer.invoke('autobot:searchAll', payload),
  searchFiles: (payload) => ipcRenderer.invoke('autobot:searchFiles', payload),
  setSettings: (patch) => ipcRenderer.invoke('autobot:setSettings', patch),
  getVersion: () => ipcRenderer.invoke('autobot:getVersion'),
  getHooks: (cwd) => ipcRenderer.invoke('autobot:getHooks', cwd),

  // Example-parity config surface: the same `.claude/` files Claude Code reads.
  listCommands: (cwd) => ipcRenderer.invoke('autobot:listCommands', cwd),
  resolveCommand: (name, args, cwd) => ipcRenderer.invoke('autobot:resolveCommand', name, args, cwd),
  listAgentDefs: (cwd) => ipcRenderer.invoke('autobot:listAgents', cwd),
  getProjectMemory: (cwd) => ipcRenderer.invoke('autobot:getProjectMemory', cwd),
  getPermissions: (cwd) => ipcRenderer.invoke('autobot:getPermissions', cwd),
  checkPermission: (toolName, toolArgs, cwd, mode) => ipcRenderer.invoke('autobot:checkPermission', toolName, toolArgs, cwd, mode),
  listCheckpoints: (convId) => ipcRenderer.invoke('autobot:listCheckpoints', convId),
  rewind: (convId, checkpointId) => ipcRenderer.invoke('autobot:rewind', convId, checkpointId),
  getOrchestrator: () => ipcRenderer.invoke('autobot:getOrchestrator'),
  setOrchestrator: (patch) => ipcRenderer.invoke('autobot:setOrchestrator', patch),
  getFeatures: () => ipcRenderer.invoke('autobot:getFeatures'),
  setFeatures: (patch) => ipcRenderer.invoke('autobot:setFeatures', patch),
  getDefaultCwd: (convId, title) => ipcRenderer.invoke('autobot:getDefaultCwd', convId, title),
  getWorkspace: (convId) => ipcRenderer.invoke('autobot:getWorkspace', convId),
  setWorkspace: (convId, dir) => ipcRenderer.invoke('autobot:setWorkspace', convId, dir),
  pickFolder: () => ipcRenderer.invoke('autobot:pickFolder'),
  pickFiles: () => ipcRenderer.invoke('autobot:pickFiles'),
  saveFile: (opts) => ipcRenderer.invoke('autobot:saveFile', opts),
  writeFile: (opts) => ipcRenderer.invoke('autobot:writeFile', opts),
  openExternal: (url) => ipcRenderer.invoke('autobot:openExternal', url),
  speak: (text) => ipcRenderer.invoke('autobot:speak', text),
  stopSpeak: () => ipcRenderer.invoke('autobot:stopSpeak'),

  mcpConnect: (cfg) => ipcRenderer.invoke('autobot:mcpConnect', cfg),
  mcpListTools: (serverId) => ipcRenderer.invoke('autobot:mcpListTools', serverId),
  mcpCallTool: (serverId, name, args) => ipcRenderer.invoke('autobot:mcpCallTool', serverId, name, args),
  mcpDisconnect: (serverId) => ipcRenderer.invoke('autobot:mcpDisconnect', serverId),
  mcpListResources: (serverId) => ipcRenderer.invoke('autobot:mcpListResources', serverId),
  mcpReadResource: (serverId, uri) => ipcRenderer.invoke('autobot:mcpReadResource', serverId, uri),
  mcpStatus: () => ipcRenderer.invoke('autobot:mcpStatus'),
  mcpConfig: (cwd) => ipcRenderer.invoke('autobot:mcpConfig', cwd),

  answerQuestion: (id, answer) => ipcRenderer.invoke('autobot:answerQuestion', id, answer),
  answerPermission: (id, allow) => ipcRenderer.invoke('autobot:answerPermission', id, allow),

  listNotebooks: () => ipcRenderer.invoke('autobot:listNotebooks'),
  getNotebook: (name) => ipcRenderer.invoke('autobot:getNotebook', name),
  saveNotebook: (name, cells) => ipcRenderer.invoke('autobot:saveNotebook', name, cells),
  deleteNotebook: (name) => ipcRenderer.invoke('autobot:deleteNotebook', name),

  shellStart: (opts) => ipcRenderer.invoke('autobot:shellStart', opts),
  shellRun: (id, command, opts) => ipcRenderer.invoke('autobot:shellRun', id, command, opts),
  shellWrite: (id, data) => ipcRenderer.invoke('autobot:shellWrite', id, data),
  shellRead: (id) => ipcRenderer.invoke('autobot:shellRead', id),
  shellList: () => ipcRenderer.invoke('autobot:shellList'),
  shellKill: (id) => ipcRenderer.invoke('autobot:shellKill', id),

  gitInfo: (cwd) => ipcRenderer.invoke('autobot:gitInfo', cwd),
  gitRun: (cwd, args) => ipcRenderer.invoke('autobot:gitRun', cwd, args),
  diff: (oldText, newText, label) => ipcRenderer.invoke('autobot:diff', oldText, newText, label),

  browserRegister: (webContentsId) => ipcRenderer.invoke('autobot:browserRegister', webContentsId),
  browserUnregister: (webContentsId) => ipcRenderer.invoke('autobot:browserUnregister', webContentsId),
  browserLoadURL: (url) => ipcRenderer.invoke('autobot:browserLoadURL', url),
  resolveUrl: (url, cwd) => ipcRenderer.invoke('autobot:resolveUrl', url, cwd),
  browserGoBack: () => ipcRenderer.invoke('autobot:browserGoBack'),
  browserGoForward: () => ipcRenderer.invoke('autobot:browserGoForward'),
  browserReload: () => ipcRenderer.invoke('autobot:browserReload'),
  browserStop: () => ipcRenderer.invoke('autobot:browserStop'),
  browserGetURL: () => ipcRenderer.invoke('autobot:browserGetURL'),
  browserGetTitle: () => ipcRenderer.invoke('autobot:browserGetTitle'),
  browserRead: () => ipcRenderer.invoke('autobot:browserRead'),
  browserEval: (code, userGesture) => ipcRenderer.invoke('autobot:browserEval', code, userGesture),
  browserClick: (selector, index) => ipcRenderer.invoke('autobot:browserClick', selector, index),
  browserType: (selector, text) => ipcRenderer.invoke('autobot:browserType', selector, text),
  browserPress: (key) => ipcRenderer.invoke('autobot:browserPress', key),
  browserHover: (selector, index) => ipcRenderer.invoke('autobot:browserHover', selector, index),
  browserSelect: (selector, value) => ipcRenderer.invoke('autobot:browserSelect', selector, value),
  browserScroll: (direction, amount, selector) => ipcRenderer.invoke('autobot:browserScroll', direction, amount, selector),
  browserWaitFor: (selector, timeoutMs) => ipcRenderer.invoke('autobot:browserWaitFor', selector, timeoutMs),
  browserScreenshot: (fullPage) => ipcRenderer.invoke('autobot:browserScreenshot', fullPage),
  browserSyncTabs: (state) => ipcRenderer.invoke('autobot:browserSyncTabs', state),
  browserListTabs: () => ipcRenderer.invoke('autobot:browserListTabs'),
  onBrowserEnsure: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('autobot:browserEnsure', handler);
    return () => ipcRenderer.removeListener('autobot:browserEnsure', handler);
  },
  onBrowserTabsCommand: (cb) => {
    const handler = (event, cmd) => cb(cmd);
    ipcRenderer.on('autobot:browserTabsCommand', handler);
    return () => ipcRenderer.removeListener('autobot:browserTabsCommand', handler);
  },

  openAbout: () => ipcRenderer.invoke('autobot:openAbout'),
  openQuickEntry: () => ipcRenderer.invoke('autobot:openQuickEntry'),
  quickSubmit: (payload) => ipcRenderer.invoke('autobot:quickSubmit', payload),
  openArtifactWindow: (payload) => ipcRenderer.invoke('autobot:openArtifactWindow', payload),
  artifactDocument: (payload) => ipcRenderer.invoke('autobot:artifactDocument', payload),
  artifactType: (payload) => ipcRenderer.invoke('autobot:artifactType', payload),
  artifactTypes: () => ipcRenderer.invoke('autobot:artifactTypes'),
  printToPdf: (payload) => ipcRenderer.invoke('autobot:printToPdf', payload),

  // ---- Canvas artifact edits (Design artboards / Slides decks) ----
  // The in-chat preview is a `srcdoc` iframe, so it posts edits to the app and
  // the app persists them here; the artifact window writes through its own
  // preload, and `onArtifactSaved` keeps both surfaces in sync.
  artifactSave: (key, edits) => ipcRenderer.invoke('autobot:artifactSave', { key, edits }),
  artifactGet: (key) => ipcRenderer.invoke('autobot:artifactGet', { key }),
  artifactReset: (key) => ipcRenderer.invoke('autobot:artifactReset', { key }),
  slidesUpload: (payload) => ipcRenderer.invoke('autobot:slidesUpload', payload),
  onArtifactSaved: (cb) => {
    const handler = (event, info) => cb(info);
    ipcRenderer.on('autobot:artifactSaved', handler);
    return () => ipcRenderer.removeListener('autobot:artifactSaved', handler);
  },

  // ---- Link unfurl (Desktop og / twitter / xlink parity) ----
  unfurl: (url) => ipcRenderer.invoke('autobot:unfurl', url),
  unfurlMany: (urls) => ipcRenderer.invoke('autobot:unfurlMany', urls),

  // ---- Organization compliance (Desktop `taint:*` parity) ----
  complianceGet: () => ipcRenderer.invoke('autobot:complianceGet'),
  complianceSet: (patch) => ipcRenderer.invoke('autobot:complianceSet', patch),
  complianceReset: () => ipcRenderer.invoke('autobot:complianceReset'),
  complianceDeleteCheck: (meta) => ipcRenderer.invoke('autobot:complianceDeleteCheck', meta),
  complianceAudit: (limit) => ipcRenderer.invoke('autobot:complianceAudit', limit),

  // ---- Computer Use (Desktop `computer:*` consent + `cu:*` capture) ----
  cuInvoke: (channel, payload) => ipcRenderer.invoke('autobot:cu', channel, payload || {}),
  computerUseStatus: () => ipcRenderer.invoke('autobot:computerUseStatus'),
  computerUseRequest: (tier) => ipcRenderer.invoke('autobot:computerUseRequest', tier),
  computerUseGrant: (tier, opts) => ipcRenderer.invoke('autobot:computerUseGrant', tier, opts),
  computerUseRevoke: (tier) => ipcRenderer.invoke('autobot:computerUseRevoke', tier),
  computerUsePermissions: (ask) => ipcRenderer.invoke('autobot:computerUsePermissions', !!ask),
  openComputerPanel: (payload) => ipcRenderer.invoke('autobot:openComputerPanel', payload || {}),
  onComputerUse: (cb) => {
    const handler = (event, evt) => { if (evt && evt.type === 'computerUse') cb(evt.state); };
    ipcRenderer.on('autobot:event', handler);
    return () => ipcRenderer.removeListener('autobot:event', handler);
  },

  // ---- Hosted Chrome extensions (Desktop `extension-host` parity) ----
  extensionList: () => ipcRenderer.invoke('autobot:extensionList'),
  extensionScan: () => ipcRenderer.invoke('autobot:extensionScan'),
  extensionOpen: (payload) => ipcRenderer.invoke('autobot:extensionOpen', payload),
  extensionServePage: (input) => ipcRenderer.invoke('autobot:extensionServePage', input),
  extensionClose: (windowId) => ipcRenderer.invoke('autobot:extensionClose', windowId),
  extensionStatus: () => ipcRenderer.invoke('autobot:extensionStatus'),
  onExtensionWindowError: (cb) => {
    const handler = (event, evt) => {
      if (evt && evt.type === 'extension-window-error') cb(evt);
    };
    ipcRenderer.on('autobot:event', handler);
    return () => ipcRenderer.removeListener('autobot:event', handler);
  },
  onQuickEntry: (cb) => {
    const handler = (event, payload) => cb(payload);
    ipcRenderer.on('autobot:quickEntry', handler);
    return () => ipcRenderer.removeListener('autobot:quickEntry', handler);
  },
});
