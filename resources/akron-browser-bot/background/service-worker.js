import {
  getProviders,
  saveProviders,
  getSettings,
  saveSettings,
  getConversation,
  clearConversation,
  getSessionConversation,
  saveSessionConversation,
  getSkills,
  saveSkills,
  getSchedules,
} from "./storage.js";
import { runTurn } from "./agent.js";
import { describeTaskTabs, executeTool, isOverlayHidden } from "./tools.js";
import { listModels } from "./providers.js";
import { isLocalBaseUrl } from "../shared/presets.js";
import { installScheduler, syncAlarms, runScheduledTask } from "./scheduler.js";
import { playChime, offscreenRequest, startKeepalive } from "./offscreen-host.js";
import { detach } from "./cdp.js";
import { buildEndpointPool, summarizePool, providerKeys } from "./orchestrator.js";
import { createBridgeHost, createBridgeLink } from "../shared/bridge.js";
import { applyLocalSeed } from "../shared/local-seed.js";
import { CLOSE_PANEL_MESSAGE, isPanelOpenFor, panelPath, panelTabId } from "../shared/panel.js";
import { pointerLabel } from "../shared/step-labels.js";
import { markedGroupTitle, plainGroupTitle } from "../shared/group-title.js";
import { BRAND_BLOCKED_MESSAGE } from "../shared/brand.js";
import { brandProblems } from "./brand-guard.js";
import {
  cleanResults,
  hasUnshownResults,
  markResultsShown,
  previewWithoutResults,
  resultsReport,
} from "../shared/results.js";
import { createConfirmQueue } from "./confirms.js";
import { fileChat, fileTabChats, isChatId, listChats, plainPreview, readChat, removeChat } from "./chat-store.js";
import {
  startRecording as gifStart,
  stopRecording as gifStop,
  exportRecording as gifExport,
  clearRecording as gifClear,
  recordingStatus as gifStatus,
} from "./gif.js";
import { GITHUB_REPO, checkForExtensionUpdate } from "../shared/updater.js";

const ports = new Map(); // port -> session
const sessions = new Map(); // sessionId -> session
const tabSessions = new Map(); // tabId -> sessionId
const confirmQueue = createConfirmQueue(); // approvals waiting for the user
const NEEDS_USER_PREFIX = "autobot_needs_";
const modelCache = new Map();
const MODEL_TTL = 5 * 60 * 1000;

installScheduler();

// Some gateways (e.g. TokenRouter) reject any request that carries an Origin
// header, which Chrome adds to extension fetches. Strip it for that host only.
async function installNetworkRules() {
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [7001],
      addRules: [
        {
          id: 7001,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "origin", operation: "remove" },
              { header: "referer", operation: "remove" },
            ],
          },
          condition: {
            urlFilter: "||api.tokenrouter.com",
            resourceTypes: ["xmlhttprequest", "other"],
          },
        },
      ],
    });
  } catch {}
}
installNetworkRules();

// Optional local-only provider seed (local-provider.json). This file is
// intentionally excluded from the distributed zip, so a key placed here stays
// on this machine only.
async function seedLocalProviders() {
  try {
    const res = await fetch(chrome.runtime.getURL("local-provider.json"));
    if (!res.ok) return;
    const seed = await res.json();
    if (!seed || !Array.isArray(seed.providers) || !seed.providers.length) return;
    const marker = await chrome.storage.local.get("autobot_local_seed");
    if (marker.autobot_local_seed === seed.version) return;

    const seeded = applyLocalSeed({
      seed,
      providers: await getProviders(),
      settings: await getSettings(),
    });
    if (seeded.providersChanged) await saveProviders(seeded.providers);
    await saveSettings(seeded.settings);
    await chrome.storage.local.set({ autobot_local_seed: seed.version || 1 });
  } catch {}
}
seedLocalProviders();

const KEEPALIVE_ALARM = "autobot_keepalive";
const WORKING_FLAG = "autobot_working";

function anySessionRunning() {
  return [...sessions.values()].some((session) => session.running);
}

function syncKeepalive() {
  const anyRunning = anySessionRunning();
  try {
    if (anyRunning) {
      chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
      // The browser shuts an idle worker down after 30 s, and a slow model call
      // looks idle. A hidden page pings the worker every 20 s while a task runs
      // (the approach Claude in Chrome uses); the alarm stays as a backstop.
      startKeepalive();
    } else {
      chrome.alarms.clear(KEEPALIVE_ALARM).catch(() => {});
    }
    // Page scripts read this flag to know whether to ask if their tab is in use.
    chrome.storage.local.set({ [WORKING_FLAG]: anyRunning }).catch(() => {});
  } catch {}
}

// A worker that has just started has no running task, whatever the flag says.
chrome.storage.local.set({ [WORKING_FLAG]: false }).catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM) {
    checkForUpdatesNow({ manual: false }).catch(() => {});
    return;
  }
  if (alarm.name !== KEEPALIVE_ALARM) return;
  try {
    Promise.resolve(chrome.runtime.getPlatformInfo()).catch(() => {});
  } catch {}
});

const UPDATE_ALARM = "autobot_update_check";
const UPDATE_STATE_KEY = "autobot_update_state";
const UPDATE_INTERVAL_MIN = 240;

let activeNativePort = null;
const nativeUpdateWaiters = new Map();
let pendingReloadAfterUpdate = false;

function broadcastUpdateState(updateState) {
  for (const port of ports.keys()) {
    try {
      port.postMessage({ type: "update_state", state: updateState });
    } catch {}
  }
}

function syncUpdateBadge(updateState) {
  try {
    if (!chrome.action?.setBadgeText) return;
    const latest = String(updateState?.latestVersion || "");
    const show = !!updateState?.updateAvailable && latest && updateState?.dismissedVersion !== latest;
    chrome.action.setBadgeText({ text: show ? "UP" : "" }).catch?.(() => {});
    if (show && chrome.action.setBadgeBackgroundColor) {
      chrome.action.setBadgeBackgroundColor({ color: "#10b981" }).catch?.(() => {});
    }
  } catch {}
}

async function getUpdateState() {
  const currentVersion = chrome.runtime?.getManifest?.().version || "1.6.11";
  try {
    const r = await chrome.storage.local.get(UPDATE_STATE_KEY);
    const saved = r?.[UPDATE_STATE_KEY];
    if (saved && typeof saved === "object") {
      return { currentVersion, repo: GITHUB_REPO, ...saved, currentVersion };
    }
  } catch {}
  return {
    ok: true,
    currentVersion,
    latestVersion: currentVersion,
    updateAvailable: false,
    repo: GITHUB_REPO,
    checkedAt: 0,
    dismissedVersion: null,
  };
}

async function saveUpdateState(nextState) {
  try {
    await chrome.storage.local.set({ [UPDATE_STATE_KEY]: nextState });
  } catch {}
  syncUpdateBadge(nextState);
  broadcastUpdateState(nextState);
  return nextState;
}

async function syncUpdateAlarm() {
  try {
    const settings = await getSettings().catch(() => ({}));
    if (settings.autoUpdate === false) {
      await chrome.alarms.clear(UPDATE_ALARM).catch(() => {});
      return;
    }
    chrome.alarms.create(UPDATE_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: UPDATE_INTERVAL_MIN,
    });
  } catch {}
}

async function checkForUpdatesNow({ manual = false } = {}) {
  const [settings, prev] = await Promise.all([
    getSettings().catch(() => ({})),
    getUpdateState(),
  ]);
  const currentVersion = chrome.runtime?.getManifest?.().version || "1.6.11";
  const result = await checkForExtensionUpdate({
    currentVersion,
    repo: GITHUB_REPO,
    channel: settings.updateChannel || "stable",
    token: settings.githubUpdateToken || "",
  });
  const next = {
    ...prev,
    ...result,
    currentVersion,
    repo: GITHUB_REPO,
    dismissedVersion:
      prev.dismissedVersion === result.latestVersion ? prev.dismissedVersion : null,
  };
  await saveUpdateState(next);
  if (manual && next.updateAvailable && settings.notifyOnComplete !== false && chrome.notifications?.create) {
    try {
      chrome.notifications.create(`autobot_update_${next.latestVersion}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icons/icon128.png"),
        title: `Akron Browser Bot v${next.latestVersion} available`,
        message: "Open Akron Settings → Updates or click Update now in the side panel.",
      });
    } catch {}
  }
  return next;
}

function callNativeUpdater(type, payload = {}, timeoutMs = 45000) {
  if (!activeNativePort) return Promise.resolve(null);
  const id = `upd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      nativeUpdateWaiters.delete(id);
      resolve({ ok: false, error: "Native updater timed out." });
    }, timeoutMs);
    nativeUpdateWaiters.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    try {
      activeNativePort.postMessage({ id, type, ...payload });
    } catch (e) {
      clearTimeout(timer);
      nativeUpdateWaiters.delete(id);
      resolve({ ok: false, error: String(e?.message || e) });
    }
  });
}

function triggerReloadWhenIdle() {
  pendingReloadAfterUpdate = false;
  setTimeout(() => {
    try {
      chrome.runtime?.reload?.();
    } catch {}
  }, 500);
}

async function applyExtensionUpdate({ manual = true } = {}) {
  const settings = await getSettings().catch(() => ({}));
  const state = await checkForUpdatesNow({ manual: false });
  if (!state.ok) return state;
  if (!state.updateAvailable) {
    return { ...state, updated: false, message: `Already up to date (v${state.currentVersion}).` };
  }

  // 1. Prefer silent on-disk replacement if the optional native host is connected.
  if (settings.nativeHost && activeNativePort) {
    const res = await callNativeUpdater("apply_extension_update", {
      repo: GITHUB_REPO,
      channel: settings.updateChannel || "stable",
      token: settings.githubUpdateToken || "",
    });
    if (res?.ok && res?.updated) {
      const next = await saveUpdateState({
        ...state,
        appliedVersion: res.latestVersion || state.latestVersion,
        reloading: true,
      });
      if (!anySessionRunning()) triggerReloadWhenIdle();
      else pendingReloadAfterUpdate = true;
      return { ...res, mode: "native", state: next };
    }
  }

  // 2. Ask the Akron Desktop bridge to run the updater if connected and waiting.
  if (bridgeLink?.send?.({ type: "ext_self_update", repo: GITHUB_REPO, targetVersion: state.latestVersion })) {
    // Desktop may handle silently; fall through to download if manual click and no immediate ack.
  }

  // 3. Browser fallback: download AkronBrowserBot-<ver>.zip so the user can extract over their unpacked folder.
  if (!manual) {
    return { ok: true, mode: "notify_only", state };
  }

  const rel = state.release || {};
  const token = String(settings.githubUpdateToken || "").trim();
  const filename = rel.zipName || `AkronBrowserBot-${state.latestVersion}.zip`;
  let downloadUrl = rel.zipUrl || rel.htmlUrl || "";

  if (token && rel.zipApiUrl) {
    try {
      const r = await fetch(rel.zipApiUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/octet-stream",
        },
      });
      if (r.ok) {
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        }
        downloadUrl = `data:application/zip;base64,${btoa(bin)}`;
      }
    } catch {}
  }

  if (chrome.downloads?.download && /^https?:|^data:/i.test(downloadUrl)) {
    try {
      const downloadId = await chrome.downloads.download({
        url: downloadUrl,
        filename,
        saveAs: false,
      });
      return {
        ok: true,
        mode: "download",
        downloadId,
        filename,
        htmlUrl: rel.htmlUrl || "",
        message: `Downloaded ${filename}. Extract over your extension folder and reload.`,
      };
    } catch (e) {
      return {
        ok: false,
        mode: "open_release",
        htmlUrl: rel.htmlUrl || "",
        error: String(e?.message || e),
      };
    }
  }

  return {
    ok: true,
    mode: "open_release",
    htmlUrl: rel.htmlUrl || `https://github.com/${GITHUB_REPO}/releases`,
    filename,
  };
}

async function dismissUpdateBanner(version) {
  const prev = await getUpdateState();
  return saveUpdateState({
    ...prev,
    dismissedVersion: version || prev.latestVersion || null,
  });
}

async function connectNativeHost() {
  const settings = await getSettings().catch(() => ({}));
  if (!settings.nativeHost) return;
  try {
    const nativePort = chrome.runtime.connectNative("com.autobot.optimusprime");
    activeNativePort = nativePort;
    nativePort.onMessage.addListener(async (message) => {
      if (message?.kind === "update_result" && nativeUpdateWaiters.has(message.id)) {
        const resolve = nativeUpdateWaiters.get(message.id);
        nativeUpdateWaiters.delete(message.id);
        resolve(message);
        return;
      }
      if (message?.type === "list_tools") {
        const { TOOL_DEFS } = await import("./tools.js");
        nativePort.postMessage({
          id: message.id,
          kind: "tools",
          tools: TOOL_DEFS.map((tool) => ({ name: tool.name, description: tool.description })),
        });
      }
      if (message?.type === "call_tool") {
        const result = await executeTool(message.name, message.input || {}, {
          tabId: message.tabId,
          settings: await getSettings(),
          emit() {},
          confirm: async () => false,
        });
        nativePort.postMessage({ id: message.id, kind: "result", result });
      }
    });
    nativePort.onDisconnect.addListener(() => {
      if (activeNativePort === nativePort) activeNativePort = null;
      for (const resolve of nativeUpdateWaiters.values()) {
        resolve({ ok: false, error: "Native host disconnected." });
      }
      nativeUpdateWaiters.clear();
    });
  } catch {}
}
connectNativeHost();
syncUpdateAlarm();

// Clicking the toolbar icon must open a tab-specific side panel, so disable the
// default auto-open behaviour and handle the click ourselves.
if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: false })
    .catch(() => {});
}

if (chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (Number.isInteger(tab?.id)) openSidePanel(tab.id);
  });
}

/* ------------------------------ sessions ------------------------------ */

function makeSession(id, windowId = null) {
  return {
    id,
    windowId,
    conversation: [],
    // What this chat's tasks saved with save_result.
    results: [],
    loaded: false,
    running: false,
    abortController: null,
    tabId: null,
    groupId: null,
    groupTitle: "Akron",
    // How the task stands, shown as a mark on the group's title.
    groupStatus: null,
    groupTitleWrite: null,
    needsInput: false,
    // Set when the last panel showing this chat was closed.
    panelClosed: false,
    // The tab the task is acting on now, and what it is doing there.
    targetTabId: null,
    stepLabel: "",
    approvedHosts: [],
    title: null,
    preview: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function sessionForWindow(windowId) {
  const id = Number.isInteger(windowId) ? `w${windowId}` : "default";
  let session = sessions.get(id);
  if (!session) {
    session = makeSession(id, Number.isInteger(windowId) ? windowId : null);
    sessions.set(id, session);
  }
  return session;
}

function sessionById(id, windowId = null, tabId = null) {
  let session = sessions.get(id);
  if (!session) {
    session = makeSession(id, Number.isInteger(windowId) ? windowId : null);
    session.tabId = Number.isInteger(tabId) ? tabId : null;
    sessions.set(id, session);
  } else {
    if (Number.isInteger(windowId)) session.windowId = windowId;
    if (Number.isInteger(tabId) && !Number.isInteger(session.tabId)) session.tabId = tabId;
  }
  return session;
}

async function findSessionIdByGroup(groupId) {
  for (const session of sessions.values()) {
    if (session.groupId === groupId) return session.id;
  }
  try {
    const all = await chrome.storage.local.get(null);
    const prefix = "autobot_session_meta_";
    for (const [key, meta] of Object.entries(all)) {
      if (key.startsWith(prefix) && Number(meta?.groupId) === groupId) {
        return key.slice(prefix.length);
      }
    }
  } catch {}
  return null;
}

async function sessionForTab(tabId, windowId) {
  if (!Number.isInteger(tabId)) return sessionForWindow(windowId);

  const cached = tabSessions.get(tabId);
  if (cached) {
    const session = sessions.get(cached);
    if (session) {
      try {
        const tab = await chrome.tabs.get(tabId);
        if (session.groupId == null || tab.groupId === session.groupId) {
          if (Number.isInteger(windowId)) session.windowId = windowId;
          return session;
        }
      } catch {
        return session;
      }
      tabSessions.delete(tabId);
    }
  }

  let tab = null;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {}

  const groupId = Number(tab?.groupId);
  if (Number.isInteger(groupId) && groupId !== -1) {
    const sessionId = await findSessionIdByGroup(groupId);
    if (sessionId) {
      const session = sessionById(sessionId, windowId, tabId);
      tabSessions.set(tabId, sessionId);
      return session;
    }
  }

  const id = `t${tabId}`;
  const session = sessionById(id, windowId, tabId);
  tabSessions.set(tabId, id);
  return session;
}

function sessionForPort(port) {
  let session = ports.get(port);
  if (!session) {
    session = sessionForWindow(null);
    ports.set(port, session);
  }
  return session;
}

const CHATS_FILED_FLAG = "autobot_chats_filed";

// A chat is kept under its tab's id, and tab ids start over when the browser
// starts. Once per browser start (or reload of the extension) the chats whose
// tab is gone are moved to the history; a tab that is still open keeps its
// chat. The flag lives in session storage, which is emptied at both moments.
async function fileStaleChats() {
  const flags = chrome.storage.session;
  if (!flags || (await flags.get(CHATS_FILED_FLAG))[CHATS_FILED_FLAG]) return;
  const [tabs, windows] = await Promise.all([chrome.tabs.query({}), chrome.windows.getAll()]);
  const open = new Set([...tabs.map((tab) => `t${tab.id}`), ...windows.map((win) => `w${win.id}`)]);
  await fileTabChats((id) => open.has(id));
  await flags.set({ [CHATS_FILED_FLAG]: true });
}

// Chats are read only after this is done. A failed move leaves them where
// they were, still listed in the history; the next start tries again.
const staleChatsFiled = fileStaleChats().catch(() => {});

async function ensureLoaded(session) {
  if (session.loaded) return;
  await staleChatsFiled;
  let conversation = await getSessionConversation(session.id);
  if (!conversation.length) {
    // One-time migration from the single-conversation version.
    const legacy = await getConversation();
    if (legacy.length) {
      conversation = legacy;
      await saveSessionConversation(session.id, conversation);
      await clearConversation();
    }
  }
  session.conversation = conversation;
  const settings = await getSettings();
  session.approvedHosts = Array.isArray(settings.approvedHosts)
    ? [...settings.approvedHosts]
    : [];
  session.groupTitle = settings.groupTitle || "Akron";
  await loadSessionMeta(session);
  if (!conversation.length) {
    // A chat without messages has no name yet: whatever was stored with it
    // belongs to an earlier chat.
    session.title = null;
    session.preview = null;
    session.results = [];
  }
  session.loaded = true;
}

// Ends the session's chat: it goes to the history under an id of its own and
// the session is left empty for the next one. Nothing is deleted.
async function putChatAside(session) {
  await ensureLoaded(session);
  if (session.conversation.length) {
    await saveSessionConversation(session.id, session.conversation);
    await saveSessionMeta(session);
  }
  await fileChat(session.id);
  session.conversation = [];
  session.results = [];
  session.title = null;
  session.preview = null;
  session.createdAt = Date.now();
  session.updatedAt = session.createdAt;
  await saveSessionMeta(session);
}

// Takes a session out of memory. What it stored stays where it is.
function forgetSession(session) {
  sessions.delete(session.id);
  for (const [tabId, id] of [...tabSessions]) {
    if (id === session.id) tabSessions.delete(tabId);
  }
}

function sessionMetaKey(sessionId) {
  return `autobot_session_meta_${sessionId}`;
}

async function loadSessionMeta(session) {
  try {
    const key = sessionMetaKey(session.id);
    const r = await chrome.storage.local.get(key);
    const meta = r[key];
    if (!meta) return;
    session.tabId = Number.isInteger(meta.tabId) ? meta.tabId : null;
    session.groupTitle = meta.groupTitle || session.groupTitle;
    session.title = meta.title || null;
    session.preview = meta.preview || null;
    session.results = cleanResults(meta.results);
    session.createdAt = Number.isInteger(meta.createdAt) ? meta.createdAt : Date.now();
    session.updatedAt = Number.isInteger(meta.updatedAt) ? meta.updatedAt : Date.now();
    if (Number.isInteger(meta.groupId)) {
      const group = await chrome.tabGroups.get(meta.groupId).catch(() => null);
      session.groupId = group ? meta.groupId : null;
    }
  } catch {}
}

async function saveSessionMeta(session) {
  try {
    await chrome.storage.local.set({
      [sessionMetaKey(session.id)]: {
        tabId: session.tabId,
        groupId: session.groupId,
        groupTitle: session.groupTitle,
        title: session.title || null,
        preview: session.preview || null,
        results: session.results || [],
        createdAt: session.createdAt || Date.now(),
        updatedAt: session.updatedAt || Date.now(),
      },
    });
  } catch {}
}

// A task that stops early (an error, or Stop) never reaches its final answer.
// Whatever it saved and has not shown yet is put in the chat, so it is not lost.
async function reportSavedResults(session) {
  if (!hasUnshownResults(session.results)) return;
  const text = resultsReport(session.results, { heading: "Saved before the task stopped" });
  session.conversation.push({ role: "assistant", content: text });
  session.results = markResultsShown(session.results);
  await saveSessionMeta(session);
  broadcastToSession(session, { type: "saved_results", text });
}

function broadcastToSession(session, msg) {
  for (const [port, bound] of ports) {
    if (bound !== session) continue;
    try {
      port.postMessage(msg);
    } catch {
      // port closed; removed by onDisconnect
    }
  }
}

function publicProvider(p) {
  const { apiKey, apiKeys, ...rest } = p;
  return {
    ...rest,
    hasKey: !!apiKey || (Array.isArray(apiKeys) && apiKeys.length > 0),
    keyCount:
      (apiKey ? 1 : 0) + (Array.isArray(apiKeys) ? apiKeys.length : 0),
  };
}

function publicSession(session) {
  return {
    id: session.id,
    windowId: session.windowId,
    tabId: session.tabId,
    groupId: session.groupId,
    groupTitle: session.groupTitle,
    running: session.running,
  };
}

async function groupInfo(session) {
  if (session.groupId == null) return null;
  try {
    const group = await chrome.tabGroups.get(session.groupId).catch(() => null);
    if (!group) {
      session.groupId = null;
      await saveSessionMeta(session);
      return null;
    }
    const tabs = await chrome.tabs.query({ groupId: session.groupId }).catch(() => []);
    return {
      id: session.groupId,
      title: plainGroupTitle(group.title) || session.groupTitle || "Akron",
      color: group.color || "orange",
      tabs: tabs.length,
    };
  } catch {
    return {
      id: session.groupId,
      title: session.groupTitle || "Akron",
      color: "orange",
      tabs: 0,
    };
  }
}

async function ensureSessionGroup(session, tabId) {
  const settings = await getSettings();
  if (settings.autoGroupTabs === false) return null;
  const title = String(settings.groupTitle || "Akron").slice(0, 40);
  session.groupTitle = title;

  if (session.groupId != null) {
    try {
      await chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] });
      await chrome.tabGroups.update(session.groupId, {
        title: markedGroupTitle(title, session.groupStatus),
        color: "orange",
      });
      tabSessions.set(tabId, session.id);
      await saveSessionMeta(session);
      return session.groupId;
    } catch {
      session.groupId = null;
    }
  }

  try {
    const groupId = await chrome.tabs.group({ tabIds: [tabId] });
    await chrome.tabGroups.update(groupId, {
      title: markedGroupTitle(title, session.groupStatus),
      color: "orange",
    });
    session.groupId = groupId;
    tabSessions.set(tabId, session.id);
    await saveSessionMeta(session);
    return groupId;
  } catch {
    return null;
  }
}

async function addTabToSessionGroup(session, tabId) {
  if (!Number.isInteger(tabId)) return;
  if (session.groupId == null) {
    await ensureSessionGroup(session, tabId);
  } else {
    try {
      await chrome.tabs.group({ groupId: session.groupId, tabIds: [tabId] });
    } catch {
      session.groupId = null;
      await ensureSessionGroup(session, tabId);
    }
  }
  if (session.groupId != null) tabSessions.set(tabId, session.id);
  broadcastToSession(session, { type: "group", group: await groupInfo(session) });
  await saveSessionMeta(session);
}

async function releaseSessionGroup(session) {
  const groupId = session.groupId;
  session.groupId = null;
  if (groupId != null) {
    try {
      const tabs = await chrome.tabs.query({ groupId });
      if (tabs.length) await chrome.tabs.ungroup(tabs.map((t) => t.id));
      for (const tab of tabs) tabSessions.delete(tab.id);
    } catch {}
  }
  await saveSessionMeta(session);
  broadcastToSession(session, { type: "group", group: null });
}

async function sessionGroupState(session) {
  return groupInfo(session);
}

// Claude puts a tab in its own group the moment its panel opens, so the tab
// strip shows which tabs have a chat. A tab the user pinned, or keeps in a
// group already, is left where it is until a task starts there.
async function groupTabOnPanelOpen(session, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.pinned) return;
  if (Number.isInteger(tab.groupId) && tab.groupId !== -1) return;
  await ensureSessionGroup(session, tabId);
}

// How long a closed panel is given to come back (a reload) before its group
// is released. Claude waits the same half second.
const PANEL_CLOSE_SETTLE_MS = 500;

// Like Claude, a group lasts only while its chat is open: closing the panel
// takes the tabs out of the group. A running task keeps its group, because
// here a task goes on without the panel; it is released when the task ends.
async function releaseGroupOnPanelClose(session) {
  await new Promise((resolve) => setTimeout(resolve, PANEL_CLOSE_SETTLE_MS));
  if (sessionHasPanel(session)) return;
  session.panelClosed = true;
  if (session.groupId == null || session.running) return;
  await releaseSessionGroup(session);
}

// Puts the mark for the session's status on its group's title. The group keeps
// whatever name it has now, so a name the user gave it is not lost.
async function writeGroupTitle(session) {
  if (session.groupId == null) return;
  try {
    const group = await chrome.tabGroups.get(session.groupId);
    const title = markedGroupTitle(group.title || session.groupTitle, session.groupStatus);
    if (title !== group.title) await chrome.tabGroups.update(session.groupId, { title });
  } catch {
    // The group is gone, or the user is dragging a tab. The next status
    // change, or looking at the group, writes the title again.
  }
}

// Marks the group like Claude does: an hourglass while its task works, a bell
// when it waits for the user, a tick when it finished out of sight. Writes are
// queued so the last status always wins.
function setGroupStatus(session, status) {
  session.groupStatus = status || null;
  session.groupTitleWrite = (session.groupTitleWrite || Promise.resolve()).then(() =>
    writeGroupTitle(session)
  );
  return session.groupTitleWrite;
}

// Whether the user is looking at one of the session's tabs right now.
async function sessionInSight(session) {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active) return false;
    if (active.id === session.tabId) return true;
    return session.groupId != null && active.groupId === session.groupId;
  } catch {
    return false;
  }
}

// Looking at a tab of a group takes the tick off its title. It also removes a
// mark left behind by a task that is no longer running (a browser restart).
async function clearSeenGroupMark(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const groupId = Number(tab?.groupId);
  if (!Number.isInteger(groupId) || groupId === -1) return;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  const shown = String(group?.title ?? "").trim();
  if (!group || plainGroupTitle(shown) === shown) return;
  const sessionId = await findSessionIdByGroup(groupId);
  if (!sessionId) return;
  const session = sessions.get(sessionId);
  // A working or waiting task keeps its mark: it is still true.
  if (session?.running || session?.needsInput) return;
  if (session) await setGroupStatus(session, null);
  else await chrome.tabGroups.update(groupId, { title: plainGroupTitle(shown) }).catch(() => {});
}

/* ---------------------------- chat history ---------------------------- */

// The history as one panel sees it: every stored chat, its own one marked.
async function chatHistory(port) {
  await staleChatsFiled;
  const currentId = sessionForPort(port).id;
  const chats = await listChats();
  return chats.map((chat) => ({ ...chat, current: chat.id === currentId }));
}

// The tab whose panel shows the session, or else the tab its task works in.
function tabShowing(session) {
  for (const [port, bound] of ports) {
    const tabId = bound === session ? panelTabId(port.sender?.url) : null;
    if (Number.isInteger(tabId)) return tabId;
  }
  return Number.isInteger(session.targetTabId) ? session.targetTabId : session.tabId;
}

async function goToTab(tabId) {
  const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;
  if (!tab) return false;
  await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  return true;
}

// Puts a stored chat into the session, in place of the one it had.
async function adoptChat(session, chat) {
  await releaseSessionGroup(session);
  await putChatAside(session);
  session.conversation = chat.conversation;
  session.results = cleanResults(chat.meta.results);
  session.title = chat.meta.title || null;
  session.preview = chat.meta.preview || null;
  session.createdAt = Number.isInteger(chat.meta.createdAt) ? chat.meta.createdAt : Date.now();
  session.updatedAt = Number.isInteger(chat.meta.updatedAt) ? chat.meta.updatedAt : Date.now();
  // Written under the session's id first, removed from the old place after.
  await saveSessionConversation(session.id, session.conversation);
  await saveSessionMeta(session);
  await removeChat(chat.id);
}

// Opens a past chat in the panel that asked for it. A chat that is at work, or
// on show in another tab's panel, is not taken away: the user is brought to it.
async function openChat(port, chatId) {
  const session = sessionForPort(port);
  if (!isChatId(chatId) || chatId === session.id) return;
  const live = sessions.get(chatId);
  if (live && (live.running || sessionHasPanel(live))) {
    if (!(await goToTab(tabShowing(live)))) {
      port.postMessage({ type: "error", retry: false, message: "That chat is in use in another panel. Open it there." });
    }
    return;
  }
  if (session.running) {
    port.postMessage({ type: "error", retry: false, message: "Wait for the current task to finish before opening another chat." });
    return;
  }
  // Its group goes first: that saves the chat's record one last time.
  if (live && live.groupId != null) await releaseSessionGroup(live);
  const chat = await readChat(chatId);
  if (!chat) {
    await removeChat(chatId);
    port.postMessage({ type: "error", retry: false, message: "That chat is no longer stored in this browser." });
    port.postMessage({ type: "sessions", sessions: await chatHistory(port) });
    return;
  }
  await adoptChat(session, chat);
  if (live) forgetSession(live);
  broadcastToSession(session, { type: "cleared" });
  broadcastToSession(session, await stateMessage(session));
}

async function stateMessage(session) {
  const [settings, providers] = await Promise.all([getSettings(), getProviders()]);
  return {
    type: "state",
    conversation: session.conversation,
    settings,
    providers: providers.map(publicProvider),
    orchestrator: summarizePool(providers, settings),
    running: session.running,
    session: publicSession(session),
    group: await sessionGroupState(session),
  };
}

/* --------------------------- live model list --------------------------- */

async function discoverModels(providerId) {
  const providers = await getProviders();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) throw new Error("Provider not found.");

  const cached = modelCache.get(providerId);
  if (cached && Date.now() - cached.at < MODEL_TTL) return cached.models;

  const keys = providerKeys(provider);
  const attempts = (keys.length ? keys : [""]).slice(0, 8);
  let lastError = null;

  for (const key of attempts) {
    try {
      const models = await listModels({ ...provider, apiKey: key });
      if (!models.length) continue;

      const existing = Array.isArray(provider.models) ? provider.models : [];
      // Put freshly discovered models first, but keep any manual/preset names.
      const merged = [...new Set([...models, ...existing])];
      const added = models.filter((m) => !existing.includes(m));
      if (added.length) {
        const updated = providers.map((p) =>
          p.id === providerId ? { ...p, models: merged } : p
        );
        await saveProviders(updated);
      }
      modelCache.set(providerId, { at: Date.now(), models: merged });
      return merged;
    } catch (e) {
      lastError = e;
      // A revoked or throttled key may fail; try the next key. Provider-wide
      // errors stop early.
      if (![401, 403, 429].includes(Number(e?.status))) break;
    }
  }

  throw lastError || new Error("The provider did not return any models.");
}

/* ------------------------------ helpers ------------------------------ */

async function resolveActiveTabId(windowId = null) {
  try {
    const query =
      windowId != null
        ? { active: true, windowId }
        : { active: true, currentWindow: true };
    const [tab] = await chrome.tabs.query(query);
    return tab?.id ?? null;
  } catch {
    return null;
  }
}

async function tabFor(msg, session) {
  return Number.isInteger(msg?.tabId)
    ? msg.tabId
    : resolveActiveTabId(session?.windowId ?? null);
}

// Which panels are open right now, as { documentUrl } records.
function openPanelContexts() {
  try {
    const found = chrome.runtime.getContexts?.({ contextTypes: ["SIDE_PANEL"] });
    return found && typeof found.catch === "function" ? found.catch(() => []) : Promise.resolve([]);
  } catch {
    return Promise.resolve([]);
  }
}

// The panel belongs to the tab it was opened on, like Claude's: there is no
// window-wide panel, so another tab shows no panel until it is opened there,
// and that one starts its own chat. With `toggle`, a tab whose panel is
// already open gets it closed instead.
function openSidePanel(tabId, { toggle = false } = {}) {
  if (!Number.isInteger(tabId) || !chrome.sidePanel) return;
  // Asked before the panel is opened, so it tells what was open until now.
  const openBefore = toggle ? openPanelContexts() : null;
  // Do not await: both calls must happen inside the click gesture, exactly like
  // Claude's own action handler, or Chrome refuses sidePanel.open().
  try {
    chrome.sidePanel.setOptions({
      tabId,
      path: panelPath(tabId),
      enabled: true,
    });
  } catch {}
  try {
    const p = chrome.sidePanel.open({ tabId });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
  if (!openBefore) return;
  openBefore.then((contexts) => {
    if (!isPanelOpenFor(contexts, tabId)) return;
    chrome.runtime.sendMessage({ type: CLOSE_PANEL_MESSAGE, tabId }).catch(() => {});
  });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sessionHasPanel(session) {
  for (const bound of ports.values()) {
    if (bound === session) return true;
  }
  return false;
}

// Points a panel at a chat. The chat it left may now be showing nowhere, which
// pauses the countdown on that chat's waiting approvals.
function bindPort(port, session) {
  const previous = ports.get(port);
  ports.set(port, session);
  session.panelClosed = false;
  if (previous && previous !== session) {
    confirmQueue.setVisible(previous.id, sessionHasPanel(previous));
  }
}

// A task can ask for approval while the user is on another tab. Show what is
// still waiting as soon as a panel opens that task's chat.
function showPendingConfirms(port, session) {
  for (const request of confirmQueue.requestsFor(session.id)) {
    try {
      port.postMessage(request);
    } catch {
      return;
    }
  }
  confirmQueue.setVisible(session.id, true);
}

async function notifyNeedsUser(session) {
  try {
    const settings = await getSettings();
    if (settings.notifyOnComplete === false) return;
    const tabId = Number.isInteger(session.tabId) ? session.tabId : "";
    chrome.notifications.create(`${NEEDS_USER_PREFIX}${tabId}_${Date.now()}`, {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: "Akron Browser Bot needs you",
      message: `${session.title || "A task"} is waiting for your approval. Open its tab to answer.`.slice(0, 180),
    });
  } catch {}
}

function requestConfirm(session, payload) {
  const { request, promise } = confirmQueue.add(session.id, payload);
  const shown = sessionHasPanel(session);
  if (shown) broadcastToSession(session, request);
  else notifyNeedsUser(session);
  confirmQueue.setVisible(session.id, shown);
  setNeedsInput(session, true);
  // The answer does not wait for the title to be rewritten. A panel that
  // still shows the request is told it is settled: it may have been answered
  // by Stop, or by nobody in time.
  return promise.finally(() => {
    broadcastToSession(session, { type: "confirm_closed", id: request.id });
    setNeedsInput(session, confirmQueue.requestsFor(session.id).length > 0);
  });
}

/* ------------- "Akron is working here" on the page ------------- */

const workingTabs = new Map(); // tabId -> id of the session using that tab

function tellTabWorking(tabId, on, needsInput = false) {
  chrome.tabs
    .sendMessage(tabId, { channel: "autobot", cmd: "working", args: { on, needsInput } })
    .catch(() => {});
}

function tellTabStep(tabId, label) {
  chrome.tabs
    .sendMessage(tabId, { channel: "autobot", cmd: "step", args: { label } })
    .catch(() => {});
}

function markTabWorking(session, tabId) {
  if (!Number.isInteger(tabId) || !session.running) return;
  workingTabs.set(tabId, session.id);
  // The tab the task just left stops naming a step it no longer runs.
  const left = session.targetTabId;
  if (Number.isInteger(left) && left !== tabId) tellTabStep(left, "");
  session.targetTabId = tabId;
  tellTabWorking(tabId, true, session.needsInput);
}

function clearWorkingTabs(session) {
  session.targetTabId = null;
  session.stepLabel = "";
  for (const [tabId, sessionId] of [...workingTabs]) {
    if (sessionId !== session.id) continue;
    workingTabs.delete(tabId);
    tellTabWorking(tabId, false);
  }
}

// The pointer on the page says which step is running, like Claude's. Between
// steps the label is empty and the pointer shows the product's name.
function showStepOnPage(session, event) {
  if (event?.type !== "step") return;
  session.stepLabel = event.phase === "running" ? pointerLabel(event.name, event.args) : "";
  if (Number.isInteger(session.targetTabId)) tellTabStep(session.targetTabId, session.stepLabel);
}

// A task that waits for an approval says so on its tabs and on its group.
function setNeedsInput(session, on) {
  session.needsInput = !!on;
  for (const [tabId, sessionId] of workingTabs) {
    if (sessionId === session.id) tellTabWorking(tabId, true, session.needsInput);
  }
  if (session.needsInput) return setGroupStatus(session, "needs_user");
  return setGroupStatus(session, session.running ? "working" : null);
}

function stopSession(session) {
  if (session.abortController) session.abortController.abort();
  confirmQueue.declineSession(session.id);
}

const PAGE_MESSAGES = new Set([
  "autobot_tab_state",
  "autobot_stop_here",
  "autobot_open_panel",
  "autobot_keepalive",
]);

// Messages from Akron's own page script (state of its tab, its Stop and
// "Open chat" buttons) and the keep-alive ping from the hidden page.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg?.type;
  if (!PAGE_MESSAGES.has(type)) return false;
  if (sender?.id !== chrome.runtime.id) return false;
  if (type === "autobot_keepalive") {
    sendResponse({ running: anySessionRunning() });
    return false;
  }
  const tabId = sender.tab?.id;
  const session = sessions.get(workingTabs.get(tabId));
  const working = !!session?.running;
  if (type === "autobot_open_panel") {
    // Sent from the person's own click, which is what lets a panel open.
    if (working) openSidePanel(tabId);
    sendResponse({ ok: working });
    return false;
  }
  if (type === "autobot_stop_here") {
    if (working) stopSession(session);
    sendResponse({ ok: working });
    return false;
  }
  const needsInput = working && session.needsInput;
  const step = working && session.targetTabId === tabId ? session.stepLabel : "";
  sendResponse({ working, hidden: working && isOverlayHidden(tabId), needsInput, step });
  return false;
});

async function handleUserMessage(msg, port, session) {
  await ensureLoaded(session);

  if (session.running) {
    port.postMessage({
      type: "error",
      retry: false,
      message: "This window's Akron is already working. Press Stop first.",
    });
    return;
  }

  const text = String(msg.text || "").trim();
  if (!text) return;

  // A copy whose name or logo was changed takes no tasks (shared/brand.js).
  if ((await brandProblems()).length) {
    port.postMessage({ type: "error", retry: false, message: BRAND_BLOCKED_MESSAGE });
    return;
  }

  const settings = await getSettings();
  const providers = await getProviders();
  const endpoints = buildEndpointPool(providers, settings);

  let provider =
    providers.find((p) => p.id === settings.activeProviderId) || providers[0];

  if (!endpoints.length) {
    if (!providers.length) {
      port.postMessage({ type: "need_provider" });
      return;
    }
    if (settings.orchestrator?.enabled) {
      port.postMessage({
        type: "error",
        message:
          "Orchestrator mode has no usable endpoints. Select models in Settings → Orchestrator and make sure those providers have API keys.",
      });
      return;
    }
    if (provider && !provider.apiKey && (provider.requiresKey === true || !isLocalBaseUrl(provider.baseUrl))) {
      port.postMessage({ type: "need_provider", message: "This provider has no API key." });
      return;
    }
    port.postMessage({
      type: "error",
      message: "No model selected. Open Settings and choose one.",
    });
    return;
  }

  const model = endpoints[0].model;
  provider = provider || endpoints[0].providerConfig;

  let tabId = Number.isInteger(msg.tabId)
    ? msg.tabId
    : await resolveActiveTabId(session.windowId);
  if (Number.isInteger(msg.tabId)) {
    const exists = await chrome.tabs.get(msg.tabId).catch(() => null);
    if (!exists) tabId = await resolveActiveTabId(session.windowId);
  }
  if (!tabId) {
    port.postMessage({
      type: "error",
      message: "No active tab found. Open a normal web page first.",
    });
    return;
  }

  // Put the working tab into the session's own tab group so the agent works
  // independently from the user's other tabs.
  await ensureSessionGroup(session, tabId);
  session.tabId = tabId;
  await saveSessionMeta(session);
  broadcastToSession(session, { type: "group", group: await groupInfo(session) });

  // Per-site approval.
  let host = "";
  try {
    const tab = await chrome.tabs.get(tabId);
    host = hostOf(tab?.url || "");
  } catch {}

  if (settings.confirmNewSites && host && !session.approvedHosts.includes(host)) {
    const ok = await requestConfirm(session, {
      kind: "site",
      host,
      message: `Allow Akron to read and interact with ${host}?`,
    });
    if (!ok?.approved) {
      port.postMessage({ type: "error", message: "Permission denied for this site." });
      return;
    }
    session.approvedHosts.push(host);
    const latest = await getSettings();
    await chrome.storage.local.set({
      autobot_settings: { ...latest, approvedHosts: session.approvedHosts },
    });
  }

  const skills = await getSkills();
  settings.activeSkills = skills
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, description: s.description, instructions: s.instructions }));

  session.running = true;
  session.abortController = new AbortController();
  syncKeepalive();
  markTabWorking(session, tabId);
  setGroupStatus(session, "working");
  broadcastToSession(session, {
    type: "status",
    running: true,
    step: 0,
    text: "Starting…",
  });

  const userMessage = { role: "user", content: text };
  if (msg.image) userMessage.image = msg.image;
  if (Array.isArray(msg.images) && msg.images.length) userMessage.images = msg.images;
  session.conversation.push(userMessage);
  if (!session.title) session.title = text.slice(0, 60);
  session.preview = text.slice(0, 140);
  session.updatedAt = Date.now();
  await saveSessionMeta(session);
  broadcastToSession(session, {
    type: "user_echo",
    text,
    image: msg.image || null,
    images: msg.images || [],
  });
  await saveSessionConversation(session.id, session.conversation);

  const confirm = async (req) => {
    if (req?.kind === "plan") {
      const approved = await requestConfirm(session, {
        kind: "plan",
        message: req.message,
        steps: req.steps,
        domains: req.domains,
      });
      if (approved?.approved && Array.isArray(req.domains)) {
        for (const domain of req.domains) {
          const host = String(domain).replace(/^https?:\/\//, "").split("/")[0];
          if (host && !session.approvedHosts.includes(host)) session.approvedHosts.push(host);
        }
      }
      return approved?.approved ? approved : false;
    }
    if (req?.kind === "skill") {
      const decision = await requestConfirm(session, {
        kind: "skill",
        message: req.message,
        skill: req.skill,
      });
      return decision?.approved ? decision : false;
    }
    if (req?.kind === "action") {
      const decision = await requestConfirm(session, {
        kind: "action",
        name: req.name,
        host: req.host,
        args: req.args,
        message: req.message,
      });
      return decision?.approved ? { ...decision, host: req.host } : false;
    }
    if (req?.kind === "domain") {
      const decision = await requestConfirm(session, {
        kind: "site",
        host: req.to,
        message: req.message || `Allow Akron to open ${req.to}?`,
      });
      return !!decision?.approved;
    }
    const name = req?.name;
    const args = req?.args;
    if (!Array.isArray(settings.confirmTools) || !settings.confirmTools.includes(name)) {
      return true;
    }
    const decision = await requestConfirm(session, {
      kind: "tool",
      tool: name,
      args,
      message: `Allow the tool "${name}" to run?`,
    });
    return !!decision?.approved;
  };

  try {
    await runTurn({
      conversation: session.conversation,
      settings,
      providerConfig: provider,
      model,
      endpoints,
      tabId,
      signal: session.abortController.signal,
      emit: (event) => {
        broadcastToSession(session, event);
        showStepOnPage(session, event);
      },
      confirm,
      saveSkill: async (draft) => {
        const skills = await getSkills();
        const existing = skills.find((skill) => skill.name.toLowerCase() === draft.name.toLowerCase());
        if (existing) Object.assign(existing, draft, { id: existing.id });
        else skills.push({ ...draft, id: `skill_${Date.now()}`, enabled: true });
        await saveSkills(skills);
      },
      grantHost: async (host) => {
        const fresh = await getSettings();
        const hosts = new Set([...(fresh.approvedHosts || []), host]);
        fresh.approvedHosts = [...hosts];
        await saveSettings(fresh);
        settings.approvedHosts = fresh.approvedHosts;
      },
      addToGroup: (id) => addTabToSessionGroup(session, id),
      onTargetTab: (id) => markTabWorking(session, id),
      describeTabs: describeTaskTabs,
      groupId: session.groupId,
      windowId: session.windowId,
      persist: async () => {
        await saveSessionConversation(session.id, session.conversation);
      },
      results: session.results,
      onResults: async (list) => {
        session.results = list;
        await saveSessionMeta(session);
      },
    });
  } catch (e) {
    if (session.abortController && session.abortController.signal.aborted) {
      broadcastToSession(session, { type: "error", message: "Stopped." });
    } else {
      broadcastToSession(session, { type: "error", message: String(e?.message || e) });
    }
    await reportSavedResults(session);
  } finally {
    session.running = false;
    session.abortController = null;
    syncKeepalive();
    clearWorkingTabs(session);
    session.needsInput = false;
    if (session.panelClosed && !sessionHasPanel(session)) {
      // Its panel was closed while it worked: the group goes now, as it would
      // have at the close.
      session.groupStatus = null;
      await releaseSessionGroup(session);
    } else {
      // A task that ends while the user is elsewhere leaves a tick on its group.
      await setGroupStatus(session, (await sessionInSight(session)) ? null : "done");
    }
    await saveSessionConversation(session.id, session.conversation);
    const lastAssistant = [...session.conversation]
      .reverse()
      .find((m) => m.role === "assistant" && m.content);
    // The history list and the notification are seen outside the chat: they
    // never carry a collected value.
    const outsideLine = lastAssistant
      ? plainPreview(previewWithoutResults(lastAssistant.content, session.results))
      : "";
    if (lastAssistant) session.preview = outsideLine.slice(0, 140);
    session.updatedAt = Date.now();
    await saveSessionMeta(session);
    broadcastToSession(session, { type: "status", running: false });
    broadcastToSession(session, { type: "group", group: await groupInfo(session) });
    if (settings.soundOnComplete !== false) playChime();
    if (settings.notifyOnComplete !== false && lastAssistant) {
      try {
        chrome.notifications.create(`autobot-done-${session.id}-${Date.now()}`, {
          type: "basic",
          iconUrl: chrome.runtime.getURL("icons/icon128.png"),
          title: "Akron Browser Bot finished",
          message: outsideLine.slice(0, 180) || "Your task is completed.",
        });
      } catch {}
    }
  }
}

/* ---------------------------- port protocol ---------------------------- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "autobot") return;
  ports.set(port, sessionForWindow(null));

  port.onDisconnect.addListener(() => {
    const session = ports.get(port);
    ports.delete(port);
    if (!session) return;
    confirmQueue.setVisible(session.id, sessionHasPanel(session));
    releaseGroupOnPanelClose(session).catch(() => {});
  });

  port.onMessage.addListener(async (msg) => {
    try {
      switch (msg?.type) {
        case "hello": {
          const session = Number.isInteger(msg.tabId)
            ? await sessionForTab(
                msg.tabId,
                Number.isInteger(msg.windowId) ? msg.windowId : null
              )
            : sessionForWindow(
                Number.isInteger(msg.windowId) ? msg.windowId : null
              );
          bindPort(port, session);
          await ensureLoaded(session);
          // Only a panel that was just opened for this very tab groups it.
          if (msg.fresh && panelTabId(port.sender?.url) === msg.tabId) {
            await groupTabOnPanelOpen(session, msg.tabId);
            // The panel may have been closed again in the meantime.
            if (!ports.has(port)) {
              await releaseGroupOnPanelClose(session);
              break;
            }
          }
          port.postMessage({
            type: "session",
            session: publicSession(session),
            group: await groupInfo(session),
          });
          showPendingConfirms(port, session);
          break;
        }
        case "get_state": {
          const session = sessionForPort(port);
          await ensureLoaded(session);
          port.postMessage(await stateMessage(session));
          break;
        }
        case "user_message":
          await handleUserMessage(msg, port, sessionForPort(port));
          break;
        case "get_config": {
          const session = sessionForPort(port);
          const [settings, providers] = await Promise.all([
            getSettings(),
            getProviders(),
          ]);
          port.postMessage({
            type: "config",
            settings,
            providers: providers.map(publicProvider),
            orchestrator: summarizePool(providers, settings),
            session: publicSession(session),
            group: await sessionGroupState(session),
          });
          break;
        }
        case "confirm_response": {
          confirmQueue.answer(msg.id, {
            approved: !!msg.approved,
            steps: msg.steps,
            scope: msg.scope || "once",
          });
          break;
        }
        case "stop": {
          stopSession(sessionForPort(port));
          break;
        }
        case "clear": {
          const session = sessionForPort(port);
          if (session.running) {
            port.postMessage({
              type: "error",
              retry: false,
              message: "Wait for the current task to finish before clearing.",
            });
            break;
          }
          // New chat = new session. Release the old group so the next task
          // creates a fresh group, like starting a new Claude session. The
          // chat that ends here stays in the history.
          await releaseSessionGroup(session);
          await putChatAside(session);
          broadcastToSession(session, { type: "cleared" });
          break;
        }
        case "release_group": {
          const session = sessionForPort(port);
          if (session.running) {
            port.postMessage({
              type: "error",
              retry: false,
              message: "Stop the current task before releasing the tab group.",
            });
            break;
          }
          await releaseSessionGroup(session);
          break;
        }
        case "run_schedule_now": {
          const result = await runScheduledTask(msg.id, { manual: true });
          port.postMessage({ type: "schedule_result", id: msg.id, result });
          break;
        }
        case "sync_alarms": {
          await syncAlarms();
          port.postMessage({ type: "alarms_synced" });
          break;
        }
        case "list_schedules": {
          port.postMessage({ type: "schedules", schedules: await getSchedules() });
          break;
        }
        case "list_sessions": {
          port.postMessage({ type: "sessions", sessions: await chatHistory(port) });
          break;
        }
        case "open_session": {
          await openChat(port, String(msg.id || ""));
          break;
        }
        case "list_models": {
          try {
            const models = await discoverModels(msg.providerId);
            port.postMessage({
              type: "models",
              providerId: msg.providerId,
              models,
            });
          } catch (e) {
            port.postMessage({
              type: "models",
              providerId: msg.providerId,
              models: [],
              error: String(e?.message || e),
            });
          }
          break;
        }
        case "gif_start": {
          const session = sessionForPort(port);
          const tabId = await tabFor(msg, session);
          if (!tabId) {
            port.postMessage({ type: "gif_error", message: "No active tab to record." });
            break;
          }
          const r = gifStart(tabId, { intervalMs: msg.intervalMs });
          port.postMessage({
            type: "gif_status",
            tabId,
            recording: true,
            frames: r.frames,
            alreadyRunning: r.alreadyRunning,
          });
          break;
        }
        case "gif_stop": {
          const tabId = await tabFor(msg, sessionForPort(port));
          const r = tabId ? gifStop(tabId) : { frames: 0 };
          port.postMessage({
            type: "gif_status",
            tabId,
            recording: false,
            frames: r.frames,
          });
          break;
        }
        case "gif_export": {
          const tabId = await tabFor(msg, sessionForPort(port));
          if (!tabId) {
            port.postMessage({ type: "gif_error", message: "No active tab to export." });
            break;
          }
          try {
            const res = await gifExport(tabId, { delayMs: msg.delayMs });
            port.postMessage({ type: "gif_done", ...res });
          } catch (e) {
            port.postMessage({ type: "gif_error", message: String(e?.message || e) });
          }
          break;
        }
        case "gif_clear": {
          const tabId = await tabFor(msg, sessionForPort(port));
          if (tabId) gifClear(tabId);
          port.postMessage({ type: "gif_status", tabId, recording: false, frames: 0 });
          break;
        }
        case "gif_status": {
          const tabId = await tabFor(msg, sessionForPort(port));
          const s = tabId ? gifStatus(tabId) : { frames: 0, recording: false };
          port.postMessage({ type: "gif_status", tabId, ...s });
          break;
        }
        case "get_update_state": {
          port.postMessage({ type: "update_state", state: await getUpdateState() });
          break;
        }
        case "check_updates": {
          const state = await checkForUpdatesNow({ manual: !!msg.manual });
          port.postMessage({ type: "update_state", state });
          break;
        }
        case "apply_update": {
          const res = await applyExtensionUpdate({ manual: true });
          port.postMessage({ type: "update_apply_result", ...res });
          break;
        }
        case "dismiss_update": {
          const state = await dismissUpdateBanner(msg.version);
          port.postMessage({ type: "update_state", state });
          break;
        }
        default:
          break;
      }
    } catch (e) {
      try {
        port.postMessage({ type: "error", message: String(e?.message || e) });
      } catch {}
    }
  });
});

/* ---------------- toolbar / keyboard ---------------- */

// Runtime messages (used by the options page for schedules & updates).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const type = msg?.type;
  if (
    type !== "run_schedule_now" &&
    type !== "list_schedules" &&
    type !== "sync_alarms" &&
    type !== "transcribe_audio" &&
    type !== "get_update_state" &&
    type !== "check_updates" &&
    type !== "apply_update" &&
    type !== "dismiss_update"
  ) {
    return false;
  }
  (async () => {
    try {
      if (type === "run_schedule_now") {
        sendResponse({ ok: true, result: await runScheduledTask(msg.id, { manual: true }) });
      } else if (type === "list_schedules") {
        sendResponse({ ok: true, schedules: await getSchedules() });
      } else if (type === "transcribe_audio") {
        sendResponse(await offscreenRequest({ type: "transcribe", samples: msg.samples, lang: msg.lang }));
      } else if (type === "get_update_state") {
        sendResponse({ ok: true, state: await getUpdateState() });
      } else if (type === "check_updates") {
        sendResponse(await checkForUpdatesNow({ manual: !!msg.manual }));
      } else if (type === "apply_update") {
        sendResponse(await applyExtensionUpdate({ manual: true }));
      } else if (type === "dismiss_update") {
        sendResponse({ ok: true, state: await dismissUpdateBanner(msg.version) });
      } else {
        await syncAlarms();
        sendResponse({ ok: true });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true;
});

function installContextMenus() {
  if (!chrome.contextMenus) return;
  const menus = [
    { id: "autobot-summarize-page", title: "Summarize this page with Akron", contexts: ["page"] },
    { id: "autobot-ask-page", title: "Ask Akron about this page", contexts: ["page"] },
    { id: "autobot-fill-form", title: "Fill this form with Akron", contexts: ["page"] },
    {
      id: "autobot-summarize-selection",
      title: "Summarize selection with Akron",
      contexts: ["selection"],
    },
    {
      id: "autobot-ask-selection",
      title: "Ask Akron about selection",
      contexts: ["selection"],
    },
  ];
  try {
    chrome.contextMenus.removeAll(() => {
      for (const m of menus) {
        try {
          chrome.contextMenus.create(m);
        } catch {}
      }
    });
  } catch {}
}

const CONTEXT_PROMPTS = {
  "autobot-summarize-page": "Summarize this page.",
  "autobot-ask-page":
    "Give me a short overview of this page and the main actions I can take on it.",
  "autobot-fill-form":
    "Fill this form with sensible test data. Show me the values you entered before submitting.",
  "autobot-summarize-selection": (info) =>
    `Summarize this selection:\n\n"${String(info.selectionText || "").slice(0, 6000)}"`,
  "autobot-ask-selection": (info) =>
    `Explain this selection in the context of the page:\n\n"${String(
      info.selectionText || ""
    ).slice(0, 6000)}"`,
};

if (chrome.contextMenus?.onClicked) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const entry = CONTEXT_PROMPTS[info.menuItemId];
    if (!entry) return;
    const text = typeof entry === "function" ? entry(info) : entry;
    const tabId = tab?.id ?? (await resolveActiveTabId());

    // Call openSidePanel() before awaiting anything else so the click still
    // counts as the user gesture Chrome requires.
    let opening = Promise.resolve();
    try {
      if (tabId != null) opening = openSidePanel(tabId);
    } catch {}

    try {
      await chrome.storage.local.set({
        autobot_pending_prompt: { text, tabId, windowId: tab?.windowId ?? null, at: Date.now() },
      });
    } catch {}
    try {
      await opening;
    } catch {}
  });
}

if (chrome.notifications?.onClicked) {
  chrome.notifications.onClicked.addListener(async (id) => {
    if (String(id).startsWith(NEEDS_USER_PREFIX)) {
      // Take the user to the tab whose task is waiting for them.
      const tabId = Number(String(id).slice(NEEDS_USER_PREFIX.length).split("_")[0]);
      try {
        chrome.notifications.clear(id);
        if (Number.isInteger(tabId)) {
          const tab = await chrome.tabs.update(tabId, { active: true });
          if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
        }
      } catch {}
      return;
    }
    if (!String(id).startsWith("autobot_task_")) return;
    try {
      chrome.notifications.clear(id);
    } catch {}
    try {
      await chrome.tabs.create({
        url: chrome.runtime.getURL("options/options.html#schedules"),
      });
    } catch {}
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  installContextMenus();
  seedLocalProviders();
  syncUpdateAlarm();
  checkForUpdatesNow({ manual: false }).catch(() => {});
  if (details.reason === "install") {
    chrome.tabs.create({ url: chrome.runtime.getURL("onboarding/onboarding.html") });
  }
});

chrome.runtime.onStartup?.addListener(() => {
  installContextMenus();
  seedLocalProviders();
  syncUpdateAlarm();
  checkForUpdatesNow({ manual: false }).catch(() => {});
});

chrome.commands.onCommand.addListener((command) => {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (!tab?.id) return;
    if (command === "toggle-side-panel") {
      openSidePanel(tab.id, { toggle: true });
    } else if (command === "focus-side-panel") {
      openSidePanel(tab.id);
    } else if (command === "stop-task") {
      // Also answers an approval the task is waiting for, like the Stop button.
      sessionForTab(tab.id, tab.windowId).then((session) => stopSession(session));
    }
  });
});

// Release the debugger when its tab goes away, and abort sessions whose window
// closed. Conversations stay in storage so reopening a window can continue.
chrome.tabs.onRemoved.addListener((tabId) => {
  tabSessions.delete(tabId);
  workingTabs.delete(tabId);
  detach(tabId).catch(() => {});
  // Dissolve a session's tab group when its main (panel) tab closes, like Claude.
  for (const session of sessions.values()) {
    if (session.tabId === tabId && session.groupId != null) {
      releaseSessionGroup(session).catch(() => {});
    }
  }
});

// Coming back to a group's tab is what takes the "finished" tick off its title.
chrome.tabs.onActivated.addListener(({ tabId }) => {
  clearSeenGroupMark(tabId).catch(() => {});
});
if (chrome.windows?.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(async (windowId) => {
    if (!Number.isInteger(windowId) || windowId === chrome.windows.WINDOW_ID_NONE) return;
    const [active] = await chrome.tabs.query({ active: true, windowId }).catch(() => []);
    if (active) clearSeenGroupMark(active.id).catch(() => {});
  });
}

// Tabs opened from a link inside the agent group join the same group, so a
// click that opens a new tab does not silently escape the workspace.
if (chrome.tabs.onCreated) {
  chrome.tabs.onCreated.addListener(async (tab) => {
    if (!Number.isInteger(tab?.openerTabId)) return;
    const target = String(tab.pendingUrl || tab.url || "");
    // "New tab" pages are user tabs, not links; leave them outside the group.
    if (!/^https?:\/\//i.test(target)) return;
    try {
      const opener = await chrome.tabs.get(tab.openerTabId);
      for (const session of sessions.values()) {
        if (
          session.running &&
          session.groupId != null &&
          opener.groupId === session.groupId &&
          tab.windowId === session.windowId
        ) {
          await addTabToSessionGroup(session, tab.id);
          break;
        }
      }
    } catch {}
  });
}

globalThis.__autobotExecuteTool = executeTool;

const bridgeTaskTabIds = new Set();

async function handleBridgeMessage(event, socket) {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message?.type === "ext_status") {
    try {
      const tabs = await chrome.tabs.query({}).catch(() => []);
      socket.send(JSON.stringify({
        type: "ext_status_result",
        request_id: message.request_id,
        version: chrome.runtime?.getManifest?.().version || "1.6.7",
        tabs: tabs.map((t) => ({ id: t.id, title: t.title || "", url: t.url || "", active: !!t.active, windowId: t.windowId })),
      }));
    } catch (e) {
      try { socket.send(JSON.stringify({ type: "ext_status_result", request_id: message.request_id, error: String(e?.message || e), tabs: [] })); } catch {}
    }
    return;
  }
  if (message?.type === "ext_tool") {
    try {
      let tabId = Number.isInteger(message.tabId) ? message.tabId : null;
      if (!Number.isInteger(tabId) && message.tool !== "list_tabs" && message.tool !== "open_tab") {
        const activeTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []);
        if (activeTabs[0] && Number.isInteger(activeTabs[0].id)) tabId = activeTabs[0].id;
        else {
          const anyTabs = await chrome.tabs.query({}).catch(() => []);
          if (anyTabs[0] && Number.isInteger(anyTabs[0].id)) tabId = anyTabs[0].id;
        }
      }
      if (Number.isInteger(tabId)) bridgeTaskTabIds.add(tabId);
      const settings = await getSettings().catch(() => ({}));
      const result = await executeTool(message.tool, message.args || {}, {
        tabId,
        taskTabIds: bridgeTaskTabIds.size ? [...bridgeTaskTabIds] : undefined,
        allowedDomains: settings.allowedDomains || [],
        blockedDomains: settings.blockedDomains || [],
        settings: { ...settings, permissionMode: "allow_all" },
        addToGroup: async (newTabId) => {
          if (Number.isInteger(newTabId)) bridgeTaskTabIds.add(newTabId);
          return null;
        },
        emit: () => {},
        confirm: async () => ({ approved: true }),
      });
      if (Number.isInteger(result?.tabId)) bridgeTaskTabIds.add(result.tabId);
      socket.send(JSON.stringify({ type: "ext_tool_result", request_id: message.request_id, ok: true, result }));
    } catch (e) {
      try { socket.send(JSON.stringify({ type: "ext_tool_result", request_id: message.request_id, ok: false, error: String(e?.message || e) })); } catch {}
    }
    return;
  }
  const skills = await getSkills().catch(() => []);
  const host = createBridgeHost({
    skills,
    onPair: async (request) => {
      const session = [...ports.values()][0];
      if (!session) return false;
      const decision = await requestConfirm(session, {
        kind: "skill",
        message: `A desktop app wants to pair (${request.client_type || "desktop"}). Allow it?`,
      });
      return !!decision?.approved;
    },
  });
  const replies = await host.receive(message);
  if (message.type === "skill_put" || message.type === "skill_delete") await saveSkills(host.skills);
  for (const reply of replies) {
    try {
      socket.send(JSON.stringify(reply));
    } catch {}
  }
}

// Connects to the desktop bridge automatically when reachable, probing /v1/health
// before opening a WebSocket so offline periods never log extension socket errors.
const bridgeLink = createBridgeLink({
  probeReachable: async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 900);
      const r = await fetch("http://127.0.0.1:8766/v1/health", { signal: ctrl.signal });
      clearTimeout(t);
      return !!(r && r.ok);
    } catch {
      return false;
    }
  },
  createSocket: (url) => new WebSocket(url),
  onOpen: (socket) => {
    try {
      socket.send(JSON.stringify({
        type: "ext_hello",
        product: "Akron Browser Bot",
        version: chrome.runtime?.getManifest?.().version || "1.6.11",
      }));
    } catch {}
  },
  onMessage: handleBridgeMessage,
});

async function syncLocalBridge() {
  if (typeof WebSocket !== "function") return;
  const settings = await getSettings().catch(() => ({}));
  bridgeLink.setEnabled(!!settings.desktopBridge);
}
syncLocalBridge();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.autobot_settings) {
    syncLocalBridge();
    syncUpdateAlarm();
  }
  if (area === "local" && changes[WORKING_FLAG] && changes[WORKING_FLAG].newValue === false && pendingReloadAfterUpdate) {
    triggerReloadWhenIdle();
  }
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, session] of sessions) {
    if (session.windowId === windowId) {
      if (session.abortController) session.abortController.abort();
      sessions.delete(id);
    }
  }
  syncKeepalive();
});
