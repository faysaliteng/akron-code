'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('autobot', {
  run: (payload) => ipcRenderer.invoke('autobot:run', payload),
  pause: (runId) => ipcRenderer.invoke('autobot:pause', runId),
  resume: (runId, steeringNote) => ipcRenderer.invoke('autobot:resume', runId, steeringNote),
  cancel: (runId) => ipcRenderer.invoke('autobot:cancel', runId),
  // One-shot completion used by GUI slash commands (/compact, /btw, /recap,
  // /advisor). Same request path + retry semantics as a full run.
  chatOnce: (payload) => ipcRenderer.invoke('autobot:chatOnce', payload),
  compact: (payload) => ipcRenderer.invoke('autobot:compact', payload),
  testProvider: (provider) => ipcRenderer.invoke('autobot:testProvider', provider),
  probeProviders: (list) => ipcRenderer.invoke('autobot:probeProviders', list),
  ollamaModels: (baseURL, apiKey) => ipcRenderer.invoke('autobot:ollamaModels', baseURL, apiKey || ''),
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
  configurePlugin: (id, cfg) => ipcRenderer.invoke('autobot:configurePlugin', id, cfg),
  testPlugin: (id) => ipcRenderer.invoke('autobot:testPlugin', id),

  // Subscription accounts (Claude Max / ChatGPT / Antigravity / Grok). Only
  // non-secret status crosses the bridge; tokens stay in the main process.
  providerStatus: () => ipcRenderer.invoke('autobot:providerStatus'),
  providerModels: (id) => ipcRenderer.invoke('autobot:providerModels', id),
  providerSignIn: (id) => ipcRenderer.invoke('autobot:providerSignIn', id),
  providerSignInCancel: (id) => ipcRenderer.invoke('autobot:providerSignInCancel', id),
  providerSignInState: (id) => ipcRenderer.invoke('autobot:providerSignInState', id),
  providerSignInManual: (id) => ipcRenderer.invoke('autobot:providerSignInManual', id),
  providerSubmitCode: (flowId, code) => ipcRenderer.invoke('autobot:providerSubmitCode', flowId, code),
  onProviderManualResult: (cb) => {
    const h = (e, flowId, result) => { try { cb(flowId, result); } catch (_) {} };
    ipcRenderer.on('autobot:providerManualResult', h);
    return () => ipcRenderer.removeListener('autobot:providerManualResult', h);
  },
  providerSignOut: (id, account) => ipcRenderer.invoke('autobot:providerSignOut', id, account),
  providerImport: () => ipcRenderer.invoke('autobot:providerImport'),
  providerAdoptClaude: () => ipcRenderer.invoke('autobot:providerAdoptClaude'),
  // Claude reconnect always goes through the owner (Claude Code CLI) so the two
  // never hold competing refresh tokens.
  providerReconnectClaude: () => ipcRenderer.invoke('autobot:providerReconnectClaude'),
  providerReconnectClaudeCode: (flowId, code) => ipcRenderer.invoke('autobot:providerReconnectClaudeCode', flowId, code),
  providerReconnectClaudeCancel: () => ipcRenderer.invoke('autobot:providerReconnectClaudeCancel'),
  providerReconnectState: () => ipcRenderer.invoke('autobot:providerReconnectState'),
  onProviderReconnectResult: (cb) => {
    const h = (e, flowId, result) => { try { cb(flowId, result); } catch (_) {} };
    ipcRenderer.on('autobot:providerReconnectResult', h);
    return () => ipcRenderer.removeListener('autobot:providerReconnectResult', h);
  },
  // The CLI's live chatter while a paste is being judged ("copy all of it…").
  // A rejected paste leaves the process waiting and emits no result event, so
  // without this the panel would show nothing at all.
  onProviderReconnectLine: (cb) => {
    const h = (e, flowId, payload) => { try { cb(flowId, payload); } catch (_) {} };
    ipcRenderer.on('autobot:providerReconnectLine', h);
    return () => ipcRenderer.removeListener('autobot:providerReconnectLine', h);
  },
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
  getMindmap: (cwd, mode) => ipcRenderer.invoke('autobot:getMindmap', cwd, mode),
  dbMigrate: (convs) => ipcRenderer.invoke('autobot:dbMigrate', convs),
  dbListConvs: (opts) => ipcRenderer.invoke('autobot:dbListConvs', opts),
  dbGetConv: (id) => ipcRenderer.invoke('autobot:dbGetConv', id),
  dbUpsertConv: (conv) => ipcRenderer.invoke('autobot:dbUpsertConv', conv),
  dbDeleteConv: (id) => ipcRenderer.invoke('autobot:dbDeleteConv', id),
  dbSearch: (query, opts) => ipcRenderer.invoke('autobot:dbSearch', query, opts),
  setSettings: (patch) => ipcRenderer.invoke('autobot:setSettings', patch),
  getVersion: () => ipcRenderer.invoke('autobot:getVersion'),
  getHooks: (cwd) => ipcRenderer.invoke('autobot:getHooks', cwd),

  // Example-parity config surface: the same `.claude/` files Claude Code reads.
  listCommands: (cwd) => ipcRenderer.invoke('autobot:listCommands', cwd),
  listSlashActions: (cwd) => ipcRenderer.invoke('autobot:listSlashActions', cwd),
  expandMcpPrompt: (payload) => ipcRenderer.invoke('autobot:expandMcpPrompt', payload),
  listWorkspaceFiles: (cwd, query) => ipcRenderer.invoke('autobot:listWorkspaceFiles', cwd, query),
  gdriveStatus: () => ipcRenderer.invoke('autobot:gdriveStatus'),
  gdrivePickFolder: () => ipcRenderer.invoke('autobot:gdrivePickFolder'),
  gdriveConnect: (payload) => ipcRenderer.invoke('autobot:gdriveConnect', payload),
  gdriveDisconnect: () => ipcRenderer.invoke('autobot:gdriveDisconnect'),
  gdriveSearch: (query, opts) => ipcRenderer.invoke('autobot:gdriveSearch', query, opts),
  gdriveRead: (idOrPath) => ipcRenderer.invoke('autobot:gdriveRead', idOrPath),
  resolveCommand: (name, args, cwd) => ipcRenderer.invoke('autobot:resolveCommand', name, args, cwd),
  listAgentDefs: (cwd) => ipcRenderer.invoke('autobot:listAgents', cwd),
  getProjectMemory: (cwd) => ipcRenderer.invoke('autobot:getProjectMemory', cwd),
  getPermissions: (cwd) => ipcRenderer.invoke('autobot:getPermissions', cwd),
  addPermissionRule: (payload) => ipcRenderer.invoke('autobot:addPermissionRule', payload),
  removePermissionRule: (payload) => ipcRenderer.invoke('autobot:removePermissionRule', payload),
  checkPermission: (toolName, toolArgs, cwd, mode) => ipcRenderer.invoke('autobot:checkPermission', toolName, toolArgs, cwd, mode),
  listCheckpoints: (convId) => ipcRenderer.invoke('autobot:listCheckpoints', convId),
  rewind: (convId, checkpointId) => ipcRenderer.invoke('autobot:rewind', convId, checkpointId),
  turnDiffs: (convId, checkpointId, cwd) => ipcRenderer.invoke('autobot:turnDiffs', convId, checkpointId, cwd),
  gitDiffFiles: (cwd) => ipcRenderer.invoke('autobot:gitDiffFiles', cwd),
  extBridgeStatus: () => ipcRenderer.invoke('autobot:extBridgeStatus'),
  extBridgeOpenFolder: () => ipcRenderer.invoke('autobot:extBridgeOpenFolder'),
  reaStatus: () => ipcRenderer.invoke('autobot:reaStatus'),
  reaConnect: () => ipcRenderer.invoke('autobot:reaConnect'),
  reaDoctor: () => ipcRenderer.invoke('autobot:reaDoctor'),
  reaInstall: () => ipcRenderer.invoke('autobot:reaInstall'),
  transcribeAudio: (payload) => ipcRenderer.invoke('autobot:transcribeAudio', payload),
  getOrchestrator: () => ipcRenderer.invoke('autobot:getOrchestrator'),
  setOrchestrator: (patch) => ipcRenderer.invoke('autobot:setOrchestrator', patch),
  // FreeLLMAPI role-pool preset ({ enabled, gateway, roles }) for Settings → Role pools.
  poolsPreset: () => ipcRenderer.invoke('autobot:poolsPreset'),
  poolStatus: () => ipcRenderer.invoke('autobot:poolStatus'),
  sessionLog: (convId, opts) => ipcRenderer.invoke('autobot:sessionLog', convId, opts),
  customToolList: () => ipcRenderer.invoke('autobot:customToolList'),
  customToolSave: (tool) => ipcRenderer.invoke('autobot:customToolSave', tool),
  customToolDelete: (name) => ipcRenderer.invoke('autobot:customToolDelete', name),
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
  answerPermission: (id, payload) => ipcRenderer.invoke('autobot:answerPermission', id, payload),
  notify: (payload) => ipcRenderer.invoke('autobot:notify', payload),

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
  worktreeList: (cwd) => ipcRenderer.invoke('autobot:worktreeList', cwd),
  worktreeAdd: (cwd, branch, targetDir) => ipcRenderer.invoke('autobot:worktreeAdd', cwd, branch, targetDir),
  worktreeRemove: (cwd, targetDir) => ipcRenderer.invoke('autobot:worktreeRemove', cwd, targetDir),
  serverInfo: () => ipcRenderer.invoke('autobot:serverInfo'),
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
  browserInspectSet: (webContentsId, enabled) => ipcRenderer.invoke('autobot:browserInspectSet', webContentsId, enabled),
  browserCaptureElement: (webContentsId, rect) => ipcRenderer.invoke('autobot:browserCaptureElement', webContentsId, rect),
  browserToggleDevTools: (webContentsId) => ipcRenderer.invoke('autobot:browserToggleDevTools', webContentsId),
  browserOpenExternal: (url, profile) => ipcRenderer.invoke('autobot:browserOpenExternal', url, profile),
  browserSaveScreenshot: (name) => ipcRenderer.invoke('autobot:browserSaveScreenshot', name),
  browserOpenFile: () => ipcRenderer.invoke('autobot:browserOpenFile'),
  browserImportCookies: (partition) => ipcRenderer.invoke('autobot:browserImportCookies', partition),
  browserClearData: (partition) => ipcRenderer.invoke('autobot:browserClearData', partition),
  devServerDetect: (cwd) => ipcRenderer.invoke('autobot:devServerDetect', cwd),
  devServerStart: (cwd) => ipcRenderer.invoke('autobot:devServerStart', cwd),
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
  brandStatus: () => ipcRenderer.invoke('autobot:brandStatus'),
  getLegalDocs: () => ipcRenderer.invoke('autobot:getLegalDocs'),
  openLegalDoc: (which) => ipcRenderer.invoke('autobot:openLegalDoc', which),
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

  // ---- IDE Workbench (Monaco, FS Watcher, Ripgrep Search, PTY, LSP, Cmd+K, Git) ----
  ideReadTree: (payload) => ipcRenderer.invoke('ide:readTree', payload),
  ideReadFile: (payload) => ipcRenderer.invoke('ide:readFile', payload),
  ideWriteFile: (payload) => ipcRenderer.invoke('ide:writeFile', payload),
  ideCreateEntry: (payload) => ipcRenderer.invoke('ide:createEntry', payload),
  ideRenameEntry: (payload) => ipcRenderer.invoke('ide:renameEntry', payload),
  ideDuplicateEntry: (payload) => ipcRenderer.invoke('ide:duplicateEntry', payload),
  ideDeleteEntry: (payload) => ipcRenderer.invoke('ide:deleteEntry', payload),
  ideRevealInOS: (payload) => ipcRenderer.invoke('ide:revealInOS', payload),
  ideWatchWorkspace: (payload) => ipcRenderer.invoke('ide:watchWorkspace', payload),
  ideUnwatchWorkspace: (payload) => ipcRenderer.invoke('ide:unwatchWorkspace', payload),
  onIdeFsChanged: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('ide:fsChanged', h);
    return () => ipcRenderer.removeListener('ide:fsChanged', h);
  },

  ideSearch: (payload) => ipcRenderer.invoke('ide:search', payload),
  ideReplace: (payload) => ipcRenderer.invoke('ide:replace', payload),

  idePtyCreate: (payload) => ipcRenderer.invoke('ide:ptyCreate', payload),
  idePtyWrite: (payload) => ipcRenderer.invoke('ide:ptyWrite', payload),
  idePtyResize: (payload) => ipcRenderer.invoke('ide:ptyResize', payload),
  idePtyKill: (payload) => ipcRenderer.invoke('ide:ptyKill', payload),
  idePtyList: () => ipcRenderer.invoke('ide:ptyList'),
  onIdePtyData: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('ide:ptyData', h);
    return () => ipcRenderer.removeListener('ide:ptyData', h);
  },
  onIdePtyExit: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('ide:ptyExit', h);
    return () => ipcRenderer.removeListener('ide:ptyExit', h);
  },

  ideLspStatus: (payload) => ipcRenderer.invoke('ide:lspStatus', payload),
  ideLspEnsure: (payload) => ipcRenderer.invoke('ide:lspEnsure', payload),
  ideLspNotify: (payload) => ipcRenderer.invoke('ide:lspNotify', payload),
  ideLspRequest: (payload) => ipcRenderer.invoke('ide:lspRequest', payload),
  onIdeLspDiagnostics: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('ide:lspDiagnostics', h);
    return () => ipcRenderer.removeListener('ide:lspDiagnostics', h);
  },

  ideInlineEdit: (payload) => ipcRenderer.invoke('ide:inlineEdit', payload),
  ideInlineEditCancel: (editId) => ipcRenderer.invoke('ide:inlineEditCancel', editId),
  ideInlineComplete: (payload) => ipcRenderer.invoke('ide:inlineComplete', payload),
  ideGenerateCommitMsg: (payload) => ipcRenderer.invoke('ide:generateCommitMsg', payload),
  onIdeInlineEditDelta: (cb) => {
    const h = (e, payload) => cb(payload);
    ipcRenderer.on('ide:inlineEditDelta', h);
    return () => ipcRenderer.removeListener('ide:inlineEditDelta', h);
  },

  ideGitStatus: (payload) => ipcRenderer.invoke('ide:gitStatus', payload),
  ideGitStage: (payload) => ipcRenderer.invoke('ide:gitStage', payload),
  ideGitUnstage: (payload) => ipcRenderer.invoke('ide:gitUnstage', payload),
  ideGitStagePatch: (payload) => ipcRenderer.invoke('ide:gitStagePatch', payload),
  ideGitDiscard: (payload) => ipcRenderer.invoke('ide:gitDiscard', payload),
  ideGitCommit: (payload) => ipcRenderer.invoke('ide:gitCommit', payload),
  ideGitBranches: (payload) => ipcRenderer.invoke('ide:gitBranches', payload),
  ideGitCheckout: (payload) => ipcRenderer.invoke('ide:gitCheckout', payload),
  ideGitFileAtHead: (payload) => ipcRenderer.invoke('ide:gitFileAtHead', payload),
  ideLoadLayout: (payload) => ipcRenderer.invoke('ide:loadLayout', payload),
  ideSaveLayout: (payload) => ipcRenderer.invoke('ide:saveLayout', payload),

  // ---- Execution Environments (This Computer / SSH Host / Remote Server) ----
  envGetState: () => ipcRenderer.invoke('autobot:envGetState'),
  envSetActive: (spec) => ipcRenderer.invoke('autobot:envSetActive', spec),
  envSaveSsh: (profile) => ipcRenderer.invoke('autobot:envSaveSsh', profile),
  envDeleteSsh: (id) => ipcRenderer.invoke('autobot:envDeleteSsh', id),
  envTestSsh: (profileOrId) => ipcRenderer.invoke('autobot:envTestSsh', profileOrId),
  envSaveRemote: (profile) => ipcRenderer.invoke('autobot:envSaveRemote', profile),
  envDeleteRemote: (id) => ipcRenderer.invoke('autobot:envDeleteRemote', id),
  envTestRemote: (profileOrId) => ipcRenderer.invoke('autobot:envTestRemote', profileOrId),
  envToggleHostServer: (enabled, opts) => ipcRenderer.invoke('autobot:envToggleHostServer', enabled, opts),
  envGetHostToken: () => ipcRenderer.invoke('autobot:envGetHostToken'),
  depsStatus: () => ipcRenderer.invoke('autobot:depsStatus'),
  depsInstallLsp: (id) => ipcRenderer.invoke('autobot:depsInstallLsp', id),
  updateCheck: (opts) => ipcRenderer.invoke('autobot:updateCheck', opts),
  updateDownload: (opts) => ipcRenderer.invoke('autobot:updateDownload', opts),
  updateApply: (stagedPath) => ipcRenderer.invoke('autobot:updateApply', stagedPath),
  onEnvChanged: (cb) => {
    const h = (e, state) => cb(state);
    ipcRenderer.on('autobot:envChanged', h);
    return () => ipcRenderer.removeListener('autobot:envChanged', h);
  },
});
