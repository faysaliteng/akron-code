import { getSettings, saveSettings, getSavedPrompts, saveSavedPrompts, getSkills, saveSkills } from "../background/storage.js";
import { describeSchedule } from "../shared/schedules.js";
import { SUMMARY_MARK, formatTaughtWorkflow } from "../shared/session-features.js";
import { mdToHtml } from "../shared/markdown.js";
import { extractDocxText, extractPdfText } from "../shared/files.js";
import { BROWSER_SPEECH_UNAVAILABLE, providerSpeechMessage, voiceErrorMessage } from "../shared/voice.js";
import { CLOSE_PANEL_MESSAGE, panelTabId } from "../shared/panel.js";
import { statusLine, stepLine } from "../shared/step-labels.js";

const $ = (id) => document.getElementById(id);

const messagesEl = $("messages");
const inputEl = $("input");
const sendBtn = $("send");
const stopBtn = $("stop");
const typingEl = $("typing");
const typingText = $("typing-text");
const thoughtEl = $("typing-thought");
const LOGO_STILL = "../icons/icon128.png";
const LOGO_ALIVE = "../icons/logo.svg";
const LESS_MOTION = "(prefers-reduced-motion: reduce)";

// The mark moves all the time, in the header, the welcome screen and the
// working line. Only a system set to reduce motion gets the still picture.
function showLogos() {
  const src = window.matchMedia?.(LESS_MOTION).matches ? LOGO_STILL : LOGO_ALIVE;
  for (const img of document.querySelectorAll(".logo, .empty-logo, .typing-logo")) {
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  }
}
showLogos();
window.matchMedia?.(LESS_MOTION).addEventListener?.("change", showLogos);
const providerSel = $("provider-select");
const modelSel = $("model-select");
const needProviderEl = $("need-provider");
const planEl = $("plan");
const planStepsEl = $("plan-steps");
const planStatusEl = $("plan-status");
const orchToggle = $("orch-toggle");
const orchStatus = $("orch-status");

const EMPTY_HTML = $("empty-state").outerHTML;

let port = null;
let skillLibrary = [];
let state = {
  conversation: [],
  settings: {},
  providers: [],
  orchestrator: null,
  activeEndpoint: null,
  session: null,
  group: null,
  history: [],
};
let running = false;
let actionCount = 0;
let activeTabId = null;
let windowId = null;
let needsState = true;
// The tab this panel was opened for. Null when the page is shown without one
// (opened as a page), and only then does it follow the active tab.
const urlTabId = panelTabId(location.href);
const stepEls = new Map();
const streamBubbles = new Map();
let keepaliveTimer = null;
let prompts = [];
let schedules = [];
let attachments = [];
let recognition = null;
let listening = false;
let gifRecording = false;
let gifFrames = 0;
let gifBusy = false;
let toastTimer = null;
let pendingPromptBusy = false;
const modelRequests = new Map();
let panelZoom = 1;

/* ------------------------------ helpers ------------------------------ */

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 90;
}

function scrollBottom(force = true) {
  if (force || isNearBottom()) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function autosize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
}

function toast(text, ms = 3000) {
  const el = $("toast");
  el.textContent = text;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), ms);
}

function speak(text) {
  if (!state.settings.speakReplies) return;
  try {
    const u = new SpeechSynthesisUtterance(String(text || "").slice(0, 2000));
    u.rate = 1.02;
    u.pitch = 1;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch {}
}

function attachCopy(bubble, text) {
  if (!text) return;
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.textContent = "Copy";
  btn.title = "Copy this reply";
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Copied to clipboard.");
    } catch {
      toast("Could not copy. Select the text instead.");
    }
  });
  bubble.appendChild(btn);
}

function clearMessagesDom() {
  messagesEl.innerHTML = EMPTY_HTML;
  stepEls.clear();
  streamBubbles.clear();
}

function renderPlan(steps, status) {
  const list = Array.isArray(steps) ? steps : [];
  if (!list.length) {
    planEl.classList.add("hidden");
    planStepsEl.innerHTML = "";
    return;
  }
  planStepsEl.innerHTML = "";
  const done = status === "done";
  list.forEach((step, index) => {
    const li = document.createElement("li");
    li.className = "plan-step" + (done ? " done" : "");
    const mark = document.createElement("span");
    mark.className = "plan-mark";
    mark.textContent = done ? "✓" : String(index + 1);
    const text = document.createElement("span");
    text.textContent = String(step);
    li.append(mark, text);
    planStepsEl.appendChild(li);
  });
  planStatusEl.textContent = done ? "done" : "in progress";
  planEl.classList.toggle("done", done);
  planEl.classList.remove("hidden");
}

function renderOrchStatus({ active = null, switching = null } = {}) {
  const summary = state.orchestrator || {};
  const enabled = !!state.settings.orchestrator?.enabled;
  orchToggle.checked = enabled;
  orchStatus.classList.remove("active", "warn", "switching");

  if (!enabled) {
    orchStatus.textContent = "Off";
    return;
  }
  if (!summary.endpoints) {
    orchStatus.textContent = "No models selected — open Settings → Orchestrator";
    orchStatus.classList.add("warn");
    return;
  }
  if (switching) {
    orchStatus.textContent = `Switching to ${switching}…`;
    orchStatus.classList.add("switching");
    return;
  }
  const label = active || state.activeEndpoint;
  orchStatus.textContent = label
    ? `Active: ${label} · ${summary.endpoints} endpoint${summary.endpoints === 1 ? "" : "s"}`
    : `${summary.endpoints} endpoint${summary.endpoints === 1 ? "" : "s"} ready`;
  orchStatus.classList.add("active");
  updateModelChip();
}

function renderGroup() {
  const group = state.group;
  const bar = $("group-bar");
  if (!group) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  const tabs = Number(group.tabs) || 0;
  $("group-label").textContent = `${group.title || "Akron"} group · ${tabs} tab${
    tabs === 1 ? "" : "s"
  }`;
}

/* ---------------------------- rendering ---------------------------- */

// Everything shown in the chat goes through here, so the welcome block leaves
// as soon as there is something to show.
function addToChat(el) {
  messagesEl.querySelector(":scope > .empty")?.remove();
  messagesEl.appendChild(el);
}

function appendUser(text, images = []) {
  const wrap = document.createElement("div");
  wrap.className = "msg user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (text) {
    const p = document.createElement("div");
    p.textContent = text;
    bubble.appendChild(p);
  }
  for (const src of images) {
    const img = document.createElement("img");
    img.className = "attached-img";
    img.src = src;
    img.alt = "Attachment";
    bubble.appendChild(img);
  }
  wrap.appendChild(bubble);
  addToChat(wrap);
  scrollBottom();
}

function appendAssistant(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.innerHTML = mdToHtml(text);
  for (const match of String(text || "").matchAll(/```html\s*([\s\S]*?)```/gi)) {
    const frame = document.createElement("iframe");
    frame.className = "artifact";
    frame.sandbox = "allow-scripts";
    frame.title = "Artifact preview";
    frame.srcdoc = match[1];
    bubble.appendChild(frame);
  }
  attachCopy(bubble, text);
  wrap.appendChild(bubble);
  addToChat(wrap);
  scrollBottom();
}

// Sends the user's last message again. Messages Akron wrote to itself (a
// summary, a screenshot it sent along) are not the user's.
function retryButton() {
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "mini-btn";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    const last = [...(state.conversation || [])].reverse().find((message) => message.role === "user" && !message.auto);
    if (!last?.content) return;
    inputEl.value = String(last.content);
    send();
  });
  return retry;
}

// `retry` is for a task that failed. A notice about anything else (a button
// that cannot be used right now, a file that was skipped) gets no Retry.
function appendError(text, { retry = false } = {}) {
  const wrap = document.createElement("div");
  wrap.className = "msg error";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  if (retry) wrap.appendChild(retryButton());
  addToChat(wrap);
  scrollBottom();
}

// The word at the end of a step row. A finished row already says what was done.
function stepStateText(phase) {
  return phase === "error" ? "Failed" : "";
}

function createStep(id, name, args, phase = "running") {
  const details = document.createElement("details");
  details.className = `step ${phase}`;
  details.dataset.tool = name || "tool";

  // The row says what is being done in plain words; opening it shows the tool
  // that did it, what it was given and what it reported.
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "step-dot";
  const labelEl = document.createElement("span");
  labelEl.className = "step-label";
  labelEl.textContent = stepLine(name, args, phase);
  const stateEl = document.createElement("span");
  stateEl.className = "state";
  stateEl.textContent = stepStateText(phase);
  summary.append(dot, labelEl, stateEl);

  const nameEl = document.createElement("div");
  nameEl.className = "tool-name";
  nameEl.textContent = name || "tool";

  const argsEl = document.createElement("pre");
  argsEl.className = "args";
  const hasArgs = args && Object.keys(args).length;
  argsEl.textContent = hasArgs ? JSON.stringify(args, null, 2) : "(no arguments)";

  const resultEl = document.createElement("pre");
  resultEl.className = "result";
  resultEl.hidden = true;

  details.append(summary, nameEl, argsEl, resultEl);
  addToChat(details);

  const record = { details, labelEl, stateEl, resultEl, name, args };
  stepEls.set(id, record);
  scrollBottom();
  return record;
}

function finishStep(id, phase, result, image) {
  let record = stepEls.get(id);
  if (!record) record = createStep(id, "tool", null, "running");
  record.details.classList.remove("running", "done", "error");
  record.details.classList.add(phase);
  record.labelEl.textContent = stepLine(record.name, record.args, phase, result);
  record.stateEl.textContent = stepStateText(phase);

  if (typeof result === "string" && result) {
    record.resultEl.hidden = false;
    record.resultEl.textContent = result;
  }
  if (image) {
    const img = document.createElement("img");
    img.className = "shot";
    img.src = image;
    img.alt = "Screenshot captured by Akron";
    record.details.appendChild(img);
  }
  scrollBottom();
}

/* --------------------------- streaming --------------------------- */

function ensureStreamBubble(streamId) {
  let entry = streamBubbles.get(streamId);
  if (entry) return entry;

  const wrap = document.createElement("div");
  wrap.className = "msg assistant";
  const bubble = document.createElement("div");
  bubble.className = "bubble streaming";
  wrap.appendChild(bubble);

  // Added to the chat by appendDelta once there is text to show.
  entry = { wrap, bubble, text: "" };
  streamBubbles.set(streamId, entry);
  return entry;
}

function appendDelta(streamId, delta) {
  const stick = isNearBottom();
  const entry = ensureStreamBubble(streamId);
  entry.text += delta;
  // Models often send a line break or a space before a tool call.
  if (!entry.text.trim()) return;
  if (!entry.wrap.isConnected) addToChat(entry.wrap);
  entry.bubble.innerHTML = mdToHtml(entry.text) + '<span class="cursor"></span>';
  if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
}

function finalizeStream(streamId, finalText) {
  const entry = streamBubbles.get(streamId);
  if (!entry) return null;
  streamBubbles.delete(streamId);
  entry.bubble.classList.remove("streaming");
  const text = typeof finalText === "string" && finalText ? finalText : entry.text;
  if (!text.trim()) {
    entry.wrap.remove();
    return entry;
  }
  if (!entry.wrap.isConnected) addToChat(entry.wrap);
  entry.bubble.innerHTML = mdToHtml(text);
  attachCopy(entry.bubble, text);
  scrollBottom(false);
  return entry;
}

function finalizeAllStreams() {
  for (const id of [...streamBubbles.keys()]) finalizeStream(id);
}

// The steps of the task that is working right now: they have no result yet.
function stepsInFlight(conv, stillRunning) {
  if (!stillRunning) return new Set();
  const last = conv.findLast((m) => m?.role === "assistant" && Array.isArray(m.toolCalls));
  return new Set((last?.toolCalls || []).map((call) => call.id));
}

function renderConversation(stillRunning = false) {
  stepEls.clear();
  streamBubbles.clear();
  const conv = state.conversation || [];

  if (!conv.length) {
    clearMessagesDom();
    return;
  }

  messagesEl.innerHTML = "";

  for (const m of conv) {
    if (!m || !m.role) continue;
    if (m.role === "user" && m.auto) {
      // Written by Akron for the model (a summary of the older part, a
      // screenshot it sent along), not said by the user.
      if (String(m.content || "").includes(SUMMARY_MARK)) appendAssistant("Conversation compacted");
    } else if (m.role === "user") {
      appendUser(m.content || "", m.images || (m.image ? [m.image] : []));
    } else if (m.role === "assistant") {
      if (String(m.content || "").trim()) appendAssistant(m.content);
      if (Array.isArray(m.toolCalls)) {
        for (const tc of m.toolCalls) createStep(tc.id, tc.name, tc.args, "running");
      }
    } else if (m.role === "tool") {
      finishStep(m.toolCallId, m.isError ? "error" : "done", m.content);
    }
  }

  // A worker restart can leave an assistant tool_call without a result. A
  // step of the task that is still working is simply not finished yet.
  const inFlight = stepsInFlight(conv, stillRunning);
  for (const [id, record] of stepEls) {
    if (record.details.classList.contains("running") && !inFlight.has(id)) {
      finishStep(id, "error", "Interrupted — the extension worker restarted before this step finished.");
    }
  }
  scrollBottom();
}

/* ---------------------------- selectors ---------------------------- */

function showNeedProvider(message) {
  needProviderEl.classList.remove("hidden");
  const strong = needProviderEl.querySelector("strong");
  if (message && strong) strong.textContent = message;
}

function hideNeedProvider() {
  needProviderEl.classList.add("hidden");
}

function populateModels(provider) {
  modelSel.innerHTML = "";
  const models = [...(provider.models || [])];
  const current =
    state.settings.activeProviderId === provider.id ? state.settings.activeModel : null;

  if (current && !models.includes(current)) models.unshift(current);
  if (!models.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No models";
    modelSel.appendChild(o);
    return;
  }
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    modelSel.appendChild(o);
  }
  modelSel.value =
    current && models.includes(current) ? current : provider.defaultModel || models[0];
}

function updateSelectors() {
  const providers = state.providers || [];
  providerSel.innerHTML = "";

  if (!providers.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No providers";
    providerSel.appendChild(o);
    const add = document.createElement("option");
    add.value = "__add_provider__";
    add.textContent = "＋ Add provider…";
    providerSel.appendChild(add);
    modelSel.innerHTML = "";
    const m = document.createElement("option");
    m.value = "";
    m.textContent = "-";
    modelSel.appendChild(m);
    showNeedProvider();
    return;
  }

  hideNeedProvider();
  for (const p of providers) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name || p.type;
    providerSel.appendChild(o);
  }
  const addOption = document.createElement("option");
  addOption.value = "__add_provider__";
  addOption.textContent = "＋ Add provider…";
  providerSel.appendChild(addOption);

  const active = providers.find((p) => p.id === state.settings.activeProviderId) || providers[0];
  providerSel.value = active.id;
  populateModels(active);
  requestModels(active.id);
  updateModelChip();
}

function updateModelChip() {
  const label = $("model-chip-label");
  if (!label) return;
  const provider = providerSel.selectedOptions?.[0]?.textContent || "";
  const model = modelSel.selectedOptions?.[0]?.textContent || "";
  label.textContent = provider && model && model !== "—" ? `${provider} · ${model}` : "Choose a model";
}

function requestModels(providerId) {
  if (!providerId || !port) return;
  const at = modelRequests.get(providerId) || 0;
  if (Date.now() - at < 60000) return;
  modelRequests.set(providerId, Date.now());
  try {
    port.postMessage({ type: "list_models", providerId });
  } catch {}
}

/* ---------------------------- state / run ---------------------------- */

function setRunning(value) {
  running = value;
  sendBtn.disabled = value;
  stopBtn.classList.toggle("hidden", !value);
  typingEl.classList.toggle("hidden", !value);
  inputEl.disabled = false;
  if (!value) {
    actionCount = 0;
    showThinking("");
  }
}

// A model can take a while to answer. After a few silent seconds the status
// line counts them, so a slow answer is not taken for a panel that froze.
const QUIET_BEFORE_COUNTING_MS = 8000;
let lastWordAt = Date.now();

function showWait() {
  const quiet = Date.now() - lastWordAt;
  const waiting = running && !pendingConfirmId && !listening;
  if (waiting && quiet >= QUIET_BEFORE_COUNTING_MS) {
    typingText.dataset.wait = ` · ${Math.round(quiet / 1000)}s`;
  } else {
    delete typingText.dataset.wait;
  }
}
setInterval(showWait, 1000);

// One line under the status with the latest of the model's thinking.
function showThinking(text) {
  const clean = String(text || "").trim();
  if (!thoughtEl) return;
  thoughtEl.textContent = clean;
  thoughtEl.classList.toggle("hidden", !clean);
}

function startKeepalive() {
  if (keepaliveTimer) return;
  // Keep the MV3 worker alive while the panel is open, including after a run,
  // so the conversation is not lost when the worker would otherwise idle out.
  keepaliveTimer = setInterval(() => {
    try {
      port?.postMessage({ type: "ping" });
    } catch {}
  }, 20000);
}

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

/* ----------------------------- history ----------------------------- */

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function renderHistory() {
  const list = $("history-list");
  list.innerHTML = "";
  const history = state.history || [];
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "popover-empty";
    empty.textContent = "No chats yet.";
    list.appendChild(empty);
    return;
  }
  for (const item of history) {
    const row = document.createElement("div");
    row.className = "popover-row history-item";

    const main = document.createElement("button");
    main.className = "popover-main";
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = item.title || "New chat";
    const meta = document.createElement("span");
    meta.className = "history-meta";
    const where = item.current ? " · open here" : "";
    meta.textContent = `${timeAgo(item.updatedAt)}${item.groupTitle ? " · " + item.groupTitle : ""}${where}`;
    if (item.preview) {
      const preview = document.createElement("span");
      preview.className = "history-preview";
      preview.textContent = item.preview;
      main.append(title, preview, meta);
    } else {
      main.append(title, meta);
    }
    main.addEventListener("click", () => {
      $("history-panel").classList.add("hidden");
      try {
        port?.postMessage({ type: "open_session", id: item.id });
      } catch {}
    });
    row.appendChild(main);
    list.appendChild(row);
  }
}

/* ----------------------------- prompts ----------------------------- */

function renderPrompts() {
  const list = $("prompts-list");
  list.innerHTML = "";
  if (!prompts.length) {
    const empty = document.createElement("div");
    empty.className = "popover-empty";
    empty.textContent = "No saved prompts yet.";
    list.appendChild(empty);
    return;
  }
  for (const p of prompts) {
    const row = document.createElement("div");
    row.className = "popover-row";

    const text = document.createElement("button");
    text.className = "popover-main";
    text.title = p.text;
    text.textContent = p.title || p.text.slice(0, 60);
    text.addEventListener("click", () => {
      inputEl.value = p.text;
      autosize();
      inputEl.focus();
      $("prompts-panel").classList.add("hidden");
    });

    const del = document.createElement("button");
    del.className = "mini-btn danger";
    del.textContent = "✕";
    del.title = "Delete prompt";
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      prompts = prompts.filter((x) => x.id !== p.id);
      await saveSavedPrompts(prompts);
      renderPrompts();
    });

    row.append(text, del);
    list.appendChild(row);
  }
}

function renderTasks() {
  const list = $("tasks-list");
  list.innerHTML = "";
  if (!schedules.length) {
    const empty = document.createElement("div");
    empty.className = "popover-empty";
    empty.textContent = "No scheduled tasks yet.";
    list.appendChild(empty);
    return;
  }
  for (const s of schedules) {
    const row = document.createElement("div");
    row.className = "popover-row task";

    const info = document.createElement("div");
    info.className = "popover-main as-div";
    const title = document.createElement("div");
    title.className = "task-title";
    title.textContent = s.title || s.prompt.slice(0, 50);
    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `${s.enabled ? "on" : "paused"} · ${describeSchedule(s)}${
      s.lastStatus ? ` · last: ${s.lastStatus}` : ""
    }`;
    info.append(title, meta);

    const run = document.createElement("button");
    run.className = "mini-btn";
    run.textContent = "Run";
    run.addEventListener("click", () => {
      run.disabled = true;
      run.textContent = "…";
      try {
        port.postMessage({ type: "run_schedule_now", id: s.id });
      } catch {
        run.disabled = false;
        run.textContent = "Run";
      }
    });

    row.append(info, run);
    list.appendChild(row);
  }
}

async function loadPrompts() {
  try {
    prompts = await getSavedPrompts();
  } catch {
    prompts = [];
  }
  renderPrompts();
}

/* ------------------------------ tabs ------------------------------ */

async function renderTabs() {
  const list = $("tabs-list");
  list.innerHTML = "";
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ currentWindow: true });
  } catch {}

  for (const t of tabs) {
    if (!t.id) continue;
    const row = document.createElement("div");
    row.className = "popover-row tab-row";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = String(t.id);
    cb.className = "tab-check";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "popover-main";
    main.title = t.url || "";
    const name = document.createElement("span");
    name.className = "tab-title";
    name.textContent = t.title || t.url || "(untitled)";
    const url = document.createElement("span");
    url.className = "tab-url";
    try {
      url.textContent = new URL(t.url).hostname;
    } catch {
      url.textContent = "";
    }
    main.append(name, url);
    main.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await chrome.tabs.update(t.id, { active: true });
        if (t.windowId != null) await chrome.windows.update(t.windowId, { focused: true });
      } catch {}
    });

    row.append(cb, main);
    list.appendChild(row);
  }

  if (!tabs.length) {
    const empty = document.createElement("div");
    empty.className = "popover-empty";
    empty.textContent = "No tabs.";
    list.appendChild(empty);
  }
}

function selectedTabIds() {
  return [...document.querySelectorAll("#tabs-list .tab-check:checked")].map((el) =>
    Number(el.value)
  );
}

async function groupSelected() {
  const ids = selectedTabIds();
  if (!ids.length) return;
  try {
    const groupId = await chrome.tabs.group({ tabIds: ids });
    const title = $("group-title").value.trim();
    const color = $("group-color").value;
    await chrome.tabGroups.update(groupId, {
      ...(title ? { title } : {}),
      color,
    });
    await renderTabs();
  } catch (e) {
    appendError(`Grouping failed: ${e?.message || e}`);
  }
}

async function ungroupSelected() {
  const ids = selectedTabIds();
  if (!ids.length) return;
  try {
    await chrome.tabs.ungroup(ids);
    await renderTabs();
  } catch (e) {
    appendError(`Ungrouping failed: ${e?.message || e}`);
  }
}

/* --------------------------- GIF recorder --------------------------- */

function updateGifButton() {
  const btn = $("gif-btn");
  btn.classList.toggle("active", gifRecording);
  btn.textContent = gifBusy ? "…" : "⏺";
  btn.title = gifBusy
    ? "Encoding GIF…"
    : gifRecording
      ? `Recording (${gifFrames} frame${gifFrames === 1 ? "" : "s"}) — click to stop and export`
      : "Record a GIF of this tab";
}

async function onGifClick(e) {
  if (gifBusy) return;
  if (e.shiftKey) {
    try {
      port?.postMessage({ type: "gif_clear" });
      toast("Recording discarded.");
    } catch {}
    return;
  }
  await refreshActiveTab();
  try {
    if (!gifRecording) {
      port.postMessage({ type: "gif_start", tabId: activeTabId });
      toast("Recording started. Click the red dot again to stop and save.");
    } else {
      gifBusy = true;
      updateGifButton();
      port.postMessage({ type: "gif_stop", tabId: activeTabId });
      setTimeout(() => {
        try {
          port.postMessage({ type: "gif_export", tabId: activeTabId });
        } catch {}
      }, 150);
    }
  } catch {
    toast("Lost connection to the extension.");
    gifBusy = false;
    updateGifButton();
  }
}

/* --------------------------- pending prompts --------------------------- */

async function maybeRunPendingPrompt() {
  if (pendingPromptBusy) return;
  let pending = null;
  try {
    const r = await chrome.storage.local.get("autobot_pending_prompt");
    pending = r.autobot_pending_prompt;
  } catch {
    return;
  }
  if (!pending || !pending.text) return;
  if (pending.windowId != null && windowId != null && pending.windowId !== windowId) {
    return;
  }
  if (pending.tabId != null && activeTabId != null && pending.tabId !== activeTabId) {
    return;
  }
  if (pending.at && Date.now() - pending.at > 120000) {
    try {
      await chrome.storage.local.remove("autobot_pending_prompt");
    } catch {}
    return;
  }

  pendingPromptBusy = true;
  try {
    await chrome.storage.local.remove("autobot_pending_prompt");
    if (Number.isInteger(pending.tabId)) activeTabId = pending.tabId;
    else await refreshActiveTab();
    inputEl.value = pending.text;
    autosize();
    if (!running) send();
  } finally {
    pendingPromptBusy = false;
  }
}

/* --------------------------- attachments --------------------------- */

function renderAttachments() {
  const wrap = $("attachments");
  wrap.innerHTML = "";
  wrap.classList.toggle("hidden", !attachments.length);
  attachments.forEach((a, idx) => {
    const chip = document.createElement("div");
    chip.className = "attachment";
    if (a.dataUrl && a.type.startsWith("image/")) {
      const img = document.createElement("img");
      img.src = a.dataUrl;
      img.alt = a.name;
      chip.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.textContent = "📄";
      chip.appendChild(icon);
    }
    const label = document.createElement("span");
    label.className = "attachment-name";
    label.textContent = a.name;
    const remove = document.createElement("button");
    remove.className = "attachment-remove";
    remove.textContent = "✕";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      attachments.splice(idx, 1);
      renderAttachments();
    });
    chip.append(label, remove);
    wrap.appendChild(chip);
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsDataURL(file);
  });
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error);
    fr.readAsText(file);
  });
}

async function addFiles(fileList) {
  const MAX = 20 * 1024 * 1024;
  for (const file of fileList) {
    if (file.size > MAX) {
      appendError(`"${file.name}" is larger than 20 MB and was skipped.`);
      continue;
    }
    const name = file.name || "attachment";
    const type = file.type || "application/octet-stream";
    const entry = { name, type };
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/^image\//.test(type) || /\.(png|jpe?g|gif|webp)$/i.test(name)) {
      entry.dataUrl = await readFileAsDataUrl(file);
    } else if (/^text\//.test(type) || /\.(txt|md|json|csv|log|html|css|js|ts)$/i.test(name)) {
      entry.text = new TextDecoder().decode(bytes);
    } else if (type === "application/pdf" || /\.pdf$/i.test(name)) {
      entry.text = extractPdfText(bytes) || "(No text could be read from this PDF.)";
    } else if (/\.docx$/i.test(name) || type.includes("wordprocessingml")) {
      entry.text = (await extractDocxText(bytes)) || "(No text could be read from this document.)";
    } else {
      entry.text = `(Attached ${name}. This file type is not converted to text.)`;
    }
    attachments.push(entry);
  }
  renderAttachments();
}

/* ------------------------------ voice ------------------------------ */

let wantVoice = false;
let voiceCommitted = "";
let voiceStream = null;
let voiceRecorder = null;
let stopVoiceCapture = null;
let voiceFallbackStarted = false;
let voiceHeardByBrowser = false;
const MIC_OPTIONS = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
// A recording that never gets louder than this is room noise, not speech.
const NARRATION_MIN_PEAK = 0.02;

function showVoiceNotice(text) {
  const el = $("voice-notice");
  if (!el) return;
  if (!text) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = text;
  el.classList.remove("hidden");
}

function markListening(on) {
  listening = on;
  $("mic").classList.toggle("active", on);
  if (on) {
    typingEl.classList.remove("hidden");
    typingText.textContent = "Listening…";
  } else if (!running) {
    typingEl.classList.add("hidden");
  }
}

async function micPermissionGranted() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state === "granted";
  } catch {
    return false;
  }
}

async function openMicPermissionTab() {
  let returnTabId = "";
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab?.id) returnTabId = String(tab.id);
  } catch {}
  const url = chrome.runtime.getURL(
    `options/options.html#permissions?requestMicrophone=true&returnTabId=${returnTabId}`
  );
  await chrome.tabs.create({ url });
}

function applyTranscript(text) {
  const spoken = String(text || "").trim();
  if (!spoken) return;
  voiceCommitted = `${voiceCommitted}${voiceCommitted && !voiceCommitted.endsWith(" ") ? " " : ""}${spoken}`;
  inputEl.value = voiceCommitted;
  autosize();
}

async function rememberVoiceMethod(method) {
  try {
    const settings = await getSettings();
    settings.voiceMethod = method;
    await saveSettings(settings);
  } catch {}
}

function resampleTo16k(samples, rate) {
  if (!samples.length) return samples;
  if (rate === 16000) return samples;
  const length = Math.max(1, Math.round(samples.length * 16000 / rate));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * rate / 16000;
    const index = Math.floor(pos);
    const next = Math.min(index + 1, samples.length - 1);
    const mix = pos - index;
    out[i] = samples[index] * (1 - mix) + samples[next] * mix;
  }
  return out;
}

// Records a microphone stream as raw sound. Returns a function that stops the
// recording and gives back the sound at 16 kHz with its loudest level.
function capturePcm(stream) {
  const chunks = [];
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  processor.onaudioprocess = (event) => {
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  ctx.resume().catch(() => {});
  return () => {
    const rate = ctx.sampleRate || 48000;
    try { processor.disconnect(); } catch {}
    try { source.disconnect(); } catch {}
    ctx.close().catch(() => {});
    const merged = new Float32Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    let peak = 0;
    for (let i = 0; i < merged.length; i += 32) peak = Math.max(peak, Math.abs(merged[i]));
    return { samples: resampleTo16k(merged, rate), peak };
  };
}

function startPcmCapture() {
  stopVoiceCapture = capturePcm(voiceStream);
}

function stopPcmCapture() {
  const stop = stopVoiceCapture;
  stopVoiceCapture = null;
  const { samples, peak } = stop ? stop() : { samples: new Float32Array(0), peak: 0 };
  window.__autobotVoicePeak = peak;
  return samples;
}

async function transcribeRecording(lang) {
  const samples = stopPcmCapture();
  showVoiceNotice("Preparing speech recognition…");
  const settings = await getSettings();
  return transcribeSamples(samples, lang, settings.voiceEngine || "auto");
}

// Turns recorded sound into words with the engine chosen in Settings.
// Gives back "" when nothing was said; throws when the engine cannot be used.
async function transcribeSamples(samples, lang, engine) {
  if (engine === "provider") {
    const text = await transcribeWithProvider(samples);
    if (text) await rememberVoiceMethod("provider");
    return text;
  }
  const response = await chrome.runtime.sendMessage({
    type: "transcribe_audio",
    samples: Array.from(samples),
    lang,
  });
  if (response?.ok) {
    if (response.text) await rememberVoiceMethod("whisper");
    return response.text || "";
  }
  if (engine === "auto") {
    try {
      const text = await transcribeWithProvider(samples);
      if (text) {
        await rememberVoiceMethod("provider");
        return text;
      }
    } catch {
      // The provider was only the second try; the local error below says more.
    }
  }
  throw new Error(response?.error || "Speech recognition stopped unexpectedly");
}

function samplesToWav(samples) {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)); };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  new Int16Array(buffer, 44).set(pcm);
  return new Blob([buffer], { type: "audio/wav" });
}

// Sends the recording to the active provider. Throws an Error whose message
// tells the user what to change when the provider cannot recognise speech.
async function transcribeWithProvider(samples) {
  const { getProviders } = await import("../background/storage.js");
  const settings = await getSettings();
  const providers = await getProviders();
  const provider = providers.find((item) => item.id === settings.activeProviderId) || providers[0];
  if (!provider?.apiKey || !provider.baseUrl) throw new Error(providerSpeechMessage("missing"));
  const body = new FormData();
  body.append("file", samplesToWav(samples), "speech.wav");
  body.append("model", "whisper-1");
  let response;
  try {
    response = await fetch(`${String(provider.baseUrl).replace(/\/+$/, "")}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${provider.apiKey}` },
      body,
    });
  } catch {
    throw new Error(providerSpeechMessage(0));
  }
  if (!response.ok) throw new Error(providerSpeechMessage(response.status));
  try {
    const data = await response.json();
    return String(data.text || "").trim();
  } catch {
    throw new Error(providerSpeechMessage(response.status));
  }
}

function startRecorderFallback(lang) {
  if (!voiceStream || voiceRecorder) return;
  voiceRecorder = { state: "recording", lang, discard: false };
  startPcmCapture();
  markListening(true);
  showVoiceNotice("");
}

// The recording is the only source of words (no browser speech service is in
// use), so it must be recognised, not dropped, when the mic is clicked again.
function startRecordingOnly(lang) {
  voiceFallbackStarted = true;
  startRecorderFallback(lang);
}

// Drops a recording that will not be used and frees the microphone.
function discardRecording() {
  if (!voiceRecorder) return;
  voiceRecorder = null;
  stopPcmCapture();
  voiceStream?.getTracks().forEach((track) => track.stop());
  voiceStream = null;
}

async function finishRecorderFallback() {
  const recorder = voiceRecorder;
  if (!recorder) return;
  if (recorder.discard) {
    discardRecording();
    return;
  }
  voiceRecorder = null;
  markListening(false);
  try {
    const text = await transcribeRecording(recorder.lang);
    applyTranscript(text);
    showVoiceNotice("");
  } catch (error) {
    showVoiceNotice(error?.message || "Speech recognition stopped unexpectedly");
  }
  voiceStream?.getTracks().forEach((track) => track.stop());
  voiceStream = null;
  inputEl.focus();
}

async function tryLocalRecognition(recognition, lang) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR || typeof SR.available !== "function") return false;
  try {
    let status = await SR.available({ langs: [lang], processLocally: true });
    if (status === "unavailable") return false;
    if ((status === "downloadable" || status === "downloading") && typeof SR.install === "function") {
      await SR.install({ langs: [lang], processLocally: true });
    }
    recognition.lang = lang;
    recognition.processLocally = true;
    return true;
  } catch {
    return false;
  }
}

async function toggleVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (listening) {
    wantVoice = false;
    // The recording is recognised when it is the only source of words, or when
    // the browser's own recogniser has given nothing by now.
    const useRecording = !!voiceRecorder && (voiceFallbackStarted || !voiceHeardByBrowser);
    if (voiceRecorder) voiceRecorder.discard = !useRecording;
    try {
      // abort() drops words still on their way from the browser, which would
      // otherwise be typed a second time next to the recognised recording.
      if (useRecording) recognition?.abort();
      else recognition?.stop();
    } catch {}
    if (voiceRecorder) finishRecorderFallback();
    else {
      markListening(false);
      voiceStream?.getTracks().forEach((track) => track.stop());
      voiceStream = null;
    }
    return;
  }
  showVoiceNotice("");
  if (!(await micPermissionGranted())) {
    await openMicPermissionTab();
    return;
  }
  const settings = await getSettings();
  const engine = settings.voiceEngine || "auto";
  const lang = settings.voiceLang || navigator.language || "en-US";
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
  } catch (error) {
    const code = error?.name === "NotAllowedError" ? "not-allowed" : "audio-capture";
    showVoiceNotice(voiceErrorMessage(code));
    return;
  }
  // New words are added after what is in the box now, whichever engine listens.
  voiceCommitted = inputEl.value;
  voiceFallbackStarted = false;
  voiceHeardByBrowser = false;
  if (engine === "whisper" || (engine === "auto" && settings.voiceMethod === "whisper")) {
    startRecordingOnly(lang);
    return;
  }
  if (engine === "provider" || (engine === "auto" && settings.voiceMethod === "provider")) {
    startRecordingOnly(lang);
    return;
  }
  if (!SR) {
    startRecordingOnly(lang);
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = lang;
  const local = await tryLocalRecognition(recognition, lang);
  wantVoice = true;
  recognition.onstart = () => {
    markListening(true);
    if (!local) rememberVoiceMethod("browser");
    if (engine === "auto" && voiceStream && !voiceRecorder) startRecorderFallback(lang);
  };
  recognition.onresult = (event) => {
    let interim = "";
    let heardFinal = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const piece = event.results[i][0]?.transcript || "";
      if (event.results[i].isFinal) {
        applyTranscript(piece);
        heardFinal = true;
      } else interim += piece;
    }
    if (heardFinal && voiceRecorder) voiceRecorder.discard = true;
    if (heardFinal || interim.trim()) voiceHeardByBrowser = true;
    if (interim.trim()) {
      inputEl.value = `${voiceCommitted}${voiceCommitted ? " " : ""}${interim.trim()}`;
      autosize();
    }
  };
  recognition.onerror = (event) => {
    if (event.error === "no-speech" || event.error === "aborted") return;
    const serviceDown = event.error === "network" || event.error === "service-not-allowed";
    if (serviceDown && engine !== "browser") {
      if (voiceFallbackStarted) return;
      voiceFallbackStarted = true;
      wantVoice = false;
      try { recognition.stop(); } catch {}
      // The browser's speech service cannot be reached (in Brave it never can,
      // and it fails within half a second). Keep recording: the words are
      // recognised when the mic is clicked again.
      if (!voiceRecorder) startRecorderFallback(lang);
      return;
    }
    wantVoice = false;
    markListening(false);
    discardRecording();
    showVoiceNotice(
      serviceDown
        ? BROWSER_SPEECH_UNAVAILABLE
        : voiceErrorMessage(event.error) || "Speech recognition stopped unexpectedly"
    );
  };
  recognition.onend = () => {
    if (voiceFallbackStarted) return;
    if (wantVoice) {
      try {
        recognition.start();
        return;
      } catch {}
    }
    markListening(false);
    inputEl.focus();
  };
  if (engine === "auto") startRecorderFallback(lang);
  try {
    recognition.start();
  } catch {
    wantVoice = false;
    if (engine !== "browser") startRecordingOnly(lang);
    else showVoiceNotice(voiceErrorMessage("start"));
  }
}

/* ---------------------------- confirmations ---------------------------- */

let pendingConfirmId = null;

function showConfirm(msg) {
  pendingConfirmId = msg.id;
  const kind = msg.kind || "tool";
  const plan = kind === "plan";
  const skill = kind === "skill";
  const site = kind === "site" || kind === "domain";
  $("perm-kicker").textContent = skill
    ? "Save skill"
    : plan
      ? "Akron's plan"
      : site
        ? "Navigation paused"
        : "Your permission is needed to continue";
  $("perm-title").textContent = skill
    ? msg.message || "Save this skill?"
    : plan
      ? "Approve this plan before Akron continues."
      : msg.message || "Allow this action?";
  const host = msg.host || (Array.isArray(msg.domains) && msg.domains.length ? msg.domains.join(", ") : "");
  $("perm-host").textContent = host;
  $("perm-host").classList.toggle("hidden", !host);
  const steps = $("perm-steps");
  steps.replaceChildren();
  if (plan && Array.isArray(msg.steps)) {
    for (const step of msg.steps) {
      const item = document.createElement("li");
      item.textContent = step;
      steps.appendChild(item);
    }
  }
  steps.classList.toggle("hidden", steps.childElementCount === 0);
  const edit = $("perm-edit");
  edit.value = plan ? (msg.steps || []).join("\n") : "";
  edit.classList.add("hidden");
  $("perm-allow").classList.toggle("hidden", plan);
  $("perm-allow").textContent = skill ? "Save skill" : site ? "Continue" : "Allow this action";
  $("perm-decline").classList.remove("hidden");
  $("perm-always").classList.toggle("hidden", plan);
  $("perm-approve").classList.toggle("hidden", !plan);
  $("perm-changes").classList.toggle("hidden", !plan);
  $("perm-note").textContent = plan
    ? "Akron will only use the sites listed. You’ll be asked before accessing anything else."
    : "Akron will not purchase items, create accounts, or bypass captchas without input. Revoke a site from Your approved sites.";
  $("permission-dock").classList.remove("hidden");
  typingEl.classList.remove("hidden");
  typingText.textContent = "Waiting for you";
  (plan ? $("perm-approve") : $("perm-allow")).focus();
}

function answerConfirm(approved, scope = "once") {
  if (!pendingConfirmId) return;
  const edit = $("perm-edit");
  const steps = edit.classList.contains("hidden")
    ? undefined
    : edit.value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
  try {
    port.postMessage({ type: "confirm_response", id: pendingConfirmId, approved, scope, steps });
  } catch {}
  closeConfirm();
}

// Takes a prompt off the screen, and with it the line that said Akron waits
// for the user: a task that goes on is working again, any other is not waiting.
function closeConfirm() {
  pendingConfirmId = null;
  $("permission-dock").classList.add("hidden");
  $("confirm-modal").classList.add("hidden");
  if (running) typingText.textContent = "Working…";
  else if (!listening) typingEl.classList.add("hidden");
}

// Puts away a prompt without answering it: it was answered somewhere else
// (the Stop shortcut, its time ran out), or it belongs to another tab's task,
// which keeps waiting and shows it again when the user returns to that tab.
function dismissConfirm() {
  closeConfirm();
}

/* ---------------------------- messages ---------------------------- */

function onMessage(msg) {
  lastWordAt = Date.now();
  showWait();
  switch (msg?.type) {
    case "state": {
      if (
        state.session?.id &&
        msg.session?.id &&
        state.session.id !== msg.session.id
      ) {
        break;
      }
      state.conversation = msg.conversation || [];
      state.settings = msg.settings || {};
      state.providers = msg.providers || [];
      state.orchestrator = msg.orchestrator || null;
      state.session = msg.session || null;
      state.group = msg.group || null;
      state.activeEndpoint = null;
      updateSelectors();
      renderConversation(!!msg.running);
      renderOrchStatus();
      renderGroup();
      renderPermMode();
      setRunning(!!msg.running);
      if (msg.running) typingText.textContent = pendingConfirmId ? "Waiting for you" : "Working…";
      maybeRunPendingPrompt();
      break;
    }
    case "user_echo":
      // Keep the local copy current so Retry resends this message, not an older one.
      state.conversation = [
        ...(state.conversation || []),
        { role: "user", content: msg.text || "" },
      ];
      appendUser(msg.text || "", msg.images || (msg.image ? [msg.image] : []));
      dismissSkillOffer();
      inputEl.value = "";
      attachments = [];
      renderAttachments();
      autosize();
      break;
    case "status": {
      if (msg.running) {
        setRunning(true);
        actionCount = Number(msg.step) || 0;
        typingText.textContent = statusLine(msg.text, actionCount);
        showThinking("");
        // Any streaming bubble from an earlier step is complete once the next
        // step begins; the model only streams text before calling tools.
        if (msg.step) {
          for (const id of [...streamBubbles.keys()]) {
            if (id !== `s${msg.step}`) finalizeStream(id);
          }
        }
      } else {
        finalizeAllStreams();
        setRunning(false);
      }
      break;
    }
    case "assistant_delta":
      showThinking("");
      appendDelta(msg.streamId || "s0", msg.text || "");
      break;
    case "thinking":
      showThinking(msg.text || "");
      break;
    case "assistant_final": {
      if (msg.endpoint) {
        state.activeEndpoint = msg.endpoint;
      }
      if (msg.streamed) {
        const done = finalizeStream(msg.streamId, msg.text || "");
        if (!done) appendAssistant(msg.text || "");
      } else {
        finalizeAllStreams();
        appendAssistant(msg.text || "");
      }
      speak(typeof msg.spoken === "string" ? msg.spoken : msg.text || "");
      renderOrchStatus();
      break;
    }
    case "saved_results": {
      // A task that stopped early: what it had collected by then.
      finalizeAllStreams();
      appendAssistant(msg.text || "");
      break;
    }
    case "step": {
      if (msg.phase === "running") {
        for (const id of [...streamBubbles.keys()]) finalizeStream(id);
        createStep(msg.id, msg.name, msg.args, "running");
        // The status line follows the work: what is being done right now.
        showThinking("");
        typingText.textContent = statusLine(stepLine(msg.name, msg.args, "running"), actionCount);
      } else {
        finishStep(msg.id, msg.phase, msg.result, msg.image);
      }
      break;
    }
    case "plan":
      // The header says "in progress" or "done". Only the approval prompt asks
      // the user for anything, and it says so itself.
      renderPlan(msg.steps, msg.status);
      break;
    case "compacted":
      appendAssistant(msg.text || "Conversation compacted");
      break;
    case "skill_offer":
      showSkillOffer(msg);
      break;
    case "error":
      finalizeAllStreams();
      appendError(msg.message || "Something went wrong.", { retry: msg.retry !== false });
      break;
    case "need_provider":
      showNeedProvider(msg.message);
      break;
    case "config":
      state.settings = msg.settings || {};
      state.providers = msg.providers || [];
      state.orchestrator = msg.orchestrator || null;
      state.session = msg.session || state.session;
      state.group = msg.group ?? state.group;
      updateSelectors();
      renderOrchStatus();
      renderGroup();
      renderPermMode();
      break;
    case "session": {
      const previous = state.session?.id || null;
      const next = msg.session?.id || null;
      const force = needsState;
      needsState = false;
      state.session = msg.session || null;
      state.group = msg.group || null;
      renderGroup();
      if (!previous || previous !== next || force) {
        if (previous && next && previous !== next) {
          // The user switched to a different tab/group session.
          state.conversation = [];
          state.activeEndpoint = null;
          clearMessagesDom();
          renderPlan([], "done");
          setRunning(false);
          dismissConfirm();
        }
        try {
          port?.postMessage({ type: "get_state" });
        } catch {}
      }
      break;
    }
    case "group":
      state.group = msg.group || null;
      renderGroup();
      break;
    case "models": {
      const provider = state.providers.find((p) => p.id === msg.providerId);
      if (provider && Array.isArray(msg.models) && msg.models.length) {
        provider.models = msg.models;
        if (providerSel.value === provider.id || state.settings.activeProviderId === provider.id) {
          const current = state.settings.activeModel;
          populateModels(provider);
          if (current && msg.models.includes(current)) modelSel.value = current;
        }
      } else if (msg.error) {
        modelRequests.delete(msg.providerId);
      }
      break;
    }
    case "cleared":
      state.conversation = [];
      clearMessagesDom();
      renderPlan([], "done");
      setRunning(false);
      break;
    case "confirm_request":
      // The same request is sent again whenever the panel re-opens this chat;
      // leave it alone if it is already on screen (the user may be editing it).
      if (msg.id === pendingConfirmId && !$("permission-dock").classList.contains("hidden")) break;
      showConfirm(msg);
      break;
    case "confirm_closed":
      // The worker settled it (Stop, or nobody answered in time).
      if (msg.id === pendingConfirmId) dismissConfirm();
      break;
    case "schedules":
      schedules = msg.schedules || [];
      renderTasks();
      break;
    case "alarms_synced":
      break;
    case "sessions":
      state.history = Array.isArray(msg.sessions) ? msg.sessions : [];
      renderHistory();
      break;
    case "gif_status":
      gifRecording = !!msg.recording;
      gifFrames = Number(msg.frames) || 0;
      gifBusy = false;
      updateGifButton();
      if (!gifRecording && gifFrames) {
        toast(`Recording stopped (${gifFrames} frame${gifFrames === 1 ? "" : "s"}). Encoding…`);
      }
      break;
    case "gif_done":
      gifRecording = false;
      gifBusy = false;
      gifFrames = 0;
      updateGifButton();
      toast(
        `GIF saved: ${msg.filename} (${msg.frames} frames, ${Math.round(
          (Number(msg.bytes) || 0) / 1024
        )} KB)`,
        5000
      );
      break;
    case "gif_error":
      gifRecording = false;
      gifBusy = false;
      updateGifButton();
      toast(`GIF failed: ${msg.message || "unknown error"}`, 5000);
      break;
    case "stream_reset": {
      const entry = streamBubbles.get(msg.streamId);
      if (entry) {
        entry.text = "";
        entry.bubble.innerHTML = '<span class="cursor"></span>';
      }
      break;
    }
    case "orchestrator_attempt":
      if (Number(msg.total) > 1 && Number(msg.index) > 1) {
        renderOrchStatus({ switching: `${msg.endpoint} (${msg.index}/${msg.total})` });
      }
      break;
    case "orchestrator_active":
      state.activeEndpoint = msg.endpoint?.label || null;
      renderOrchStatus({ active: state.activeEndpoint });
      break;
    case "orchestrator_failover":
      toast(
        `${msg.from}: ${msg.reason || "failed"}${
          msg.to ? ` — switching to ${msg.to}` : " — no endpoints left"
        }`,
        6000
      );
      if (msg.to) renderOrchStatus({ switching: msg.to });
      else renderOrchStatus();
      break;
    case "schedule_result": {
      const idx = schedules.findIndex((s) => s.id === msg.id);
      if (idx >= 0 && msg.result) schedules[idx] = { ...schedules[idx], ...msg.result };
      renderTasks();
      try {
        port.postMessage({ type: "list_schedules" });
      } catch {}
      break;
    }
    default:
      break;
  }
}

function connect() {
  try {
    port = chrome.runtime.connect({ name: "autobot" });
  } catch {
    setTimeout(connect, 800);
    return;
  }
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => {
    stopKeepalive();
    port = null;
    setTimeout(connect, 600);
  });
  startKeepalive();
  needsState = true;
  sendHello();
}

// The first hello of a panel is the moment it was opened: that is when its tab
// joins a group. A reconnect later must not group a tab the user took out.
let greeted = false;

function sendHello() {
  try {
    port?.postMessage({ type: "hello", tabId: activeTabId, windowId, fresh: !greeted });
    greeted = true;
  } catch {}
}

async function bindToActiveTab() {
  await refreshActiveTab();
  sendHello();
}

/* ------------------------------ actions ------------------------------ */

function send() {
  let text = inputEl.value.trim();
  if ((!text && !attachments.length) || running) return;
  if (!state.providers.length) {
    showNeedProvider();
    return;
  }

  const images = attachments
    .filter((a) => a.dataUrl && /^image\//.test(a.type))
    .map((a) => a.dataUrl);
  const textFiles = attachments.filter((a) => a.text);
  const binaryFiles = attachments.filter((a) => a.dataUrl && !/^image\//.test(a.type));
  if (textFiles.length) {
    const blocks = textFiles
      .map((f) => `\n\n--- Attached file: ${f.name} ---\n${f.text.slice(0, 60000)}`)
      .join("");
    text += blocks;
  }
  if (binaryFiles.length) {
    text += binaryFiles
      .map((f) => `\n\n[Attached file: ${f.name} (${f.type}) — binary file, not inlined]`)
      .join("");
  }

  if (!port) connect();
  try {
    port.postMessage({
      type: "user_message",
      text: text || "(see attached files)",
      tabId: activeTabId,
      images,
    });
  } catch {
    appendError("Lost connection to the extension. Reload the panel.", { retry: true });
    return;
  }
}

async function refreshActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) activeTabId = tab.id;
  } catch {}
}

sendBtn.addEventListener("click", send);

stopBtn.addEventListener("click", () => {
  try {
    port.postMessage({ type: "stop" });
  } catch {}
  pendingConfirmId = null;
  $("permission-dock").classList.add("hidden");
  try {
    speechSynthesis.cancel();
  } catch {}
});

inputEl.addEventListener("input", () => {
  autosize();
  renderSlashMenu();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    hideSlashMenu();
    send();
  }
  if (e.key === "Escape") hideSlashMenu();
});

function hideSlashMenu() {
  $("slash-menu").classList.add("hidden");
  $("slash-menu").replaceChildren();
}

function renderSlashMenu() {
  const menu = $("slash-menu");
  const value = inputEl.value;
  menu.replaceChildren();
  if (!value.startsWith("/") || value.includes("\n")) {
    menu.classList.add("hidden");
    return;
  }
  const query = value.slice(1).trim().toLowerCase();
  const skillItems = (skillLibrary || []).filter((skill) => skill.enabled !== false).map((skill) => ({
    title: `Skill: ${skill.name}`,
    text: skill.instructions || skill.description || skill.name,
  }));
  const matches = [...prompts, ...skillItems]
    .filter((prompt) => {
      const title = String(prompt.title || "").toLowerCase();
      const text = String(prompt.text || "").toLowerCase();
      return !query || title.includes(query) || text.includes(query);
    })
    .slice(0, 8);
  if (!matches.length) {
    menu.classList.add("hidden");
    return;
  }
  menu.classList.remove("hidden");
  for (const prompt of matches) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${prompt.title || "Prompt"} — ${String(prompt.text || "").slice(0, 80)}`;
    button.addEventListener("click", () => {
      inputEl.value = prompt.text || "";
      hideSlashMenu();
      autosize();
      inputEl.focus();
    });
    menu.appendChild(button);
  }
}

$("new-chat").addEventListener("click", () => {
  try {
    port.postMessage({ type: "clear" });
  } catch {}
});

$("open-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
$("callout-settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

/* --------------------------- prompts panel --------------------------- */

$("history-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  $("prompts-panel").classList.add("hidden");
  $("tabs-panel").classList.add("hidden");
  const panel = $("history-panel");
  const showing = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", showing);
  if (!showing) {
    try {
      port?.postMessage({ type: "list_sessions" });
    } catch {}
    renderHistory();
  }
});

$("refresh-history").addEventListener("click", () => {
  try {
    port?.postMessage({ type: "list_sessions" });
  } catch {}
});

$("prompts-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  $("tabs-panel").classList.add("hidden");
  $("history-panel").classList.add("hidden");
  const panel = $("prompts-panel");
  const showing = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", showing);
  if (!showing) {
    await loadPrompts();
    try {
      port.postMessage({ type: "list_schedules" });
    } catch {}
    renderTasks();
  }
});

$("save-prompt").addEventListener("click", async () => {
  const text = inputEl.value.trim();
  if (!text) {
    appendError("Type a prompt in the composer first, then save it.");
    return;
  }
  const title = text.split("\n")[0].slice(0, 50) || "Saved prompt";
  prompts.unshift({
    id: `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    title,
    text,
    createdAt: Date.now(),
  });
  await saveSavedPrompts(prompts);
  renderPrompts();
});

$("manage-tasks").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#schedules") });
});

/* ---------------------------- tabs panel ---------------------------- */

$("tabs-btn").addEventListener("click", async (e) => {
  e.stopPropagation();
  $("prompts-panel").classList.add("hidden");
  $("history-panel").classList.add("hidden");
  const panel = $("tabs-panel");
  const showing = !panel.classList.contains("hidden");
  panel.classList.toggle("hidden", showing);
  if (!showing) await renderTabs();
});

$("refresh-tabs").addEventListener("click", renderTabs);
$("group-selected").addEventListener("click", groupSelected);
$("ungroup-selected").addEventListener("click", ungroupSelected);
$("gif-btn").addEventListener("click", onGifClick);

// Listens while a workflow is taught. The browser's speech service is used
// where the Voice setting allows it; the microphone is also recorded so the
// words can still be recognised when that service hears nothing (Brave).
async function startTeachNarration() {
  const session = { engine: "auto", lang: navigator.language || "en-US", text: "", recognition: null, stream: null, stopCapture: null };
  try {
    const settings = await getSettings();
    session.engine = settings.voiceEngine || "auto";
    session.lang = settings.voiceLang || session.lang;
  } catch {
    // Unreadable settings: keep the defaults above.
  }
  const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (Speech && (session.engine === "auto" || session.engine === "browser")) {
    session.recognition = new Speech();
    session.recognition.continuous = true;
    session.recognition.lang = session.lang;
    session.recognition.onresult = (event) => {
      session.text = [...event.results].map((result) => result[0]?.transcript || "").join(" ");
    };
    try {
      session.recognition.start();
    } catch {}
  }
  if (session.engine !== "browser" && (await micPermissionGranted())) {
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_OPTIONS });
      session.stopCapture = capturePcm(session.stream);
    } catch {
      // No microphone: the clicks are still recorded.
    }
  }
  return session;
}

// Stops listening and gives back what was said while teaching ("" if nothing).
async function finishTeachNarration(session) {
  if (!session) return "";
  try {
    session.recognition?.stop();
  } catch {}
  const recording = session.stopCapture ? session.stopCapture() : null;
  session.stream?.getTracks().forEach((track) => track.stop());
  const heard = session.text.trim();
  if (heard || !recording || recording.peak < NARRATION_MIN_PEAK) return heard;
  toast("Recognising what you said…");
  try {
    return await transcribeSamples(recording.samples, session.lang, session.engine);
  } catch (error) {
    toast(`Your spoken notes were not added: ${error?.message || "speech recognition failed"}`);
    return "";
  } finally {
    showVoiceNotice("");
  }
}

let teaching = false;
let teachNarration = null;
$("teach-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  if (!teaching) {
    teaching = true;
    teachNarration = startTeachNarration();
    try {
      await chrome.tabs.sendMessage(tab.id, { channel: "autobot", cmd: "teach_start" });
    } catch {}
    $("teach-btn").classList.add("recording");
    toast("Teaching. Click through the task, then press Teach again.");
    return;
  }
  teaching = false;
  const narrationSession = teachNarration;
  teachNarration = null;
  let steps = [];
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { channel: "autobot", cmd: "teach_stop" });
    steps = Array.isArray(response?.result) ? response.result : [];
  } catch {}
  const narration = await finishTeachNarration(await narrationSession);
  const text = formatTaughtWorkflow(steps, narration);
  prompts.unshift({ id: `teach_${Date.now()}`, title: "Taught workflow", text, createdAt: Date.now() });
  try {
    const skills = await getSkills();
    skills.push({
      id: `skill_${Date.now()}`,
      name: "Taught workflow",
      description: narration || "Recorded from the page",
      instructions: text,
      enabled: true,
    });
    await saveSkills(skills);
    skillLibrary = skills;
  } catch {}
  try {
    await saveSavedPrompts(prompts);
  } catch {}
  $("teach-btn").classList.remove("recording");
  toast("Shortcut added");
});
$("group-release").addEventListener("click", () => {
  try {
    port?.postMessage({ type: "release_group" });
  } catch {}
});

// The menus that open over the chat. A click outside one, or Escape, closes it.
const POPOVER_IDS = ["prompts-panel", "tabs-panel", "history-panel", "sites-panel", "perm-mode-menu", "model-menu"];

document.addEventListener("click", (e) => {
  for (const id of POPOVER_IDS) {
    const panel = $(id);
    if (panel.classList.contains("hidden")) continue;
    if (panel.contains(e.target)) continue;
    panel.classList.add("hidden");
  }
});

/* --------------------------- attachments --------------------------- */

$("attach").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", async (e) => {
  const files = e.target.files ? [...e.target.files] : [];
  e.target.value = "";
  if (files.length) await addFiles(files);
});
$("mic").addEventListener("click", toggleVoice);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "voice_progress" && msg.text) showVoiceNotice(msg.text);
});

// Drag and drop files onto the composer.
const composerEl = document.querySelector(".composer");
composerEl.addEventListener("dragover", (e) => {
  e.preventDefault();
  composerEl.classList.add("dragover");
});
composerEl.addEventListener("dragleave", () => composerEl.classList.remove("dragover"));
composerEl.addEventListener("drop", async (e) => {
  e.preventDefault();
  composerEl.classList.remove("dragover");
  const files = e.dataTransfer?.files ? [...e.dataTransfer.files] : [];
  if (files.length) await addFiles(files);
});

// Paste an image or file straight into the composer.
inputEl.addEventListener("paste", async (e) => {
  const files = e.clipboardData?.files ? [...e.clipboardData.files] : [];
  if (files.length) {
    e.preventDefault();
    await addFiles(files);
  }
});

/* ---------------------------- confirmations ---------------------------- */

$("confirm-allow").addEventListener("click", () => answerConfirm(true, "once"));
$("confirm-deny").addEventListener("click", () => answerConfirm(false, "deny"));
let pendingSkill = null;
const SKILL_OFFER_LINES = 6;

// An offer to save the last run is put away once the next task starts, so it
// does not sit over the chat while work goes on.
function dismissSkillOffer() {
  if (!pendingSkill || pendingConfirmId) return;
  pendingSkill = null;
  $("permission-dock").classList.add("hidden");
}
function showSkillOffer(msg) {
  pendingSkill = msg;
  $("perm-kicker").textContent = "Save as skill";
  $("perm-title").textContent = msg.title || "Reuse this run";
  // A long run has hundreds of steps. The card shows the first few; the skill
  // is still saved with all of them.
  const lines = String(msg.instructions || "").split("\n").filter(Boolean);
  const shown = lines.slice(0, SKILL_OFFER_LINES).join("\n");
  const more = lines.length - SKILL_OFFER_LINES;
  $("perm-host").textContent = more > 0 ? `${shown}\n… and ${more} more step${more === 1 ? "" : "s"}` : shown;
  $("perm-host").classList.remove("hidden");
  $("perm-steps").classList.add("hidden");
  $("perm-edit").classList.add("hidden");
  $("perm-allow").classList.remove("hidden");
  $("perm-allow").textContent = "Save as skill";
  $("perm-decline").classList.remove("hidden");
  $("perm-always").classList.add("hidden");
  $("perm-approve").classList.add("hidden");
  $("perm-changes").classList.add("hidden");
  $("perm-note").textContent = "Only the steps from this run are saved. You can edit the skill in Settings.";
  $("permission-dock").classList.remove("hidden");
}
$("perm-allow").addEventListener("click", async () => {
  if (pendingSkill && !pendingConfirmId) {
    const skills = await getSkills();
    skills.push({
      id: `skill_${Date.now()}`,
      name: String(pendingSkill.title || "Learned task").slice(0, 60),
      description: "Learned from a completed run",
      instructions: pendingSkill.instructions || "",
      enabled: true,
    });
    await saveSkills(skills);
    pendingSkill = null;
    $("permission-dock").classList.add("hidden");
    toast("Skill saved");
    return;
  }
  answerConfirm(true, "once");
});
$("perm-decline").addEventListener("click", () => {
  if (pendingSkill && !pendingConfirmId) {
    pendingSkill = null;
    $("permission-dock").classList.add("hidden");
    return;
  }
  answerConfirm(false, "deny");
});
$("perm-always").addEventListener("click", () => answerConfirm(true, "always"));
$("perm-approve").addEventListener("click", () => answerConfirm(true, "once"));
$("perm-changes").addEventListener("click", () => {
  $("perm-edit").classList.remove("hidden");
  $("perm-edit").focus();
});
$("confirm-modal").addEventListener("click", (e) => {
  if (e.target === $("confirm-modal")) answerConfirm(false);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("confirm-modal").classList.contains("hidden")) {
      answerConfirm(false);
      return;
    }
    for (const id of POPOVER_IDS) $(id).classList.add("hidden");
    $("model-chip").setAttribute("aria-expanded", "false");
    $("perm-mode-btn").setAttribute("aria-expanded", "false");
    if (listening) recognition?.stop();
    return;
  }
  // Panel zoom (Ctrl/Cmd + / - / 0), like Claude's panel zoom keys.
  if (e.ctrlKey || e.metaKey) {
    const k = e.key;
    if (k === "+" || k === "=") {
      e.preventDefault();
      panelZoom = Math.min(1.6, panelZoom + 0.1);
      document.documentElement.style.zoom = String(panelZoom);
    } else if (k === "-" || k === "_") {
      e.preventDefault();
      panelZoom = Math.max(0.7, panelZoom - 0.1);
      document.documentElement.style.zoom = String(panelZoom);
    } else if (k === "0") {
      e.preventDefault();
      panelZoom = 1;
      document.documentElement.style.zoom = "1";
    }
  }
});

/* ------------------------------ selectors ------------------------------ */

providerSel.addEventListener("change", async () => {
  if (providerSel.value === "__add_provider__") {
    const active =
      state.providers.find((p) => p.id === state.settings.activeProviderId) ||
      state.providers[0];
    providerSel.value = active?.id || "";
    chrome.runtime.openOptionsPage();
    return;
  }
  const provider = state.providers.find((p) => p.id === providerSel.value);
  if (!provider) return;
  const s = await getSettings();
  s.activeProviderId = provider.id;
  s.activeModel = provider.defaultModel || (provider.models && provider.models[0]) || null;
  await saveSettings(s);
  state.settings = { ...state.settings, ...s };
  populateModels(provider);
  requestModels(provider.id);
});

modelSel.addEventListener("focus", () => requestModels(providerSel.value));

modelSel.addEventListener("change", async () => {
  const s = await getSettings();
  s.activeModel = modelSel.value || null;
  await saveSettings(s);
  state.settings = { ...state.settings, ...s };
});

function renderPermMode() {
  const skip = state.settings?.permissionMode === "skip";
  $("perm-mode-label").textContent = skip ? "Act without asking" : "Ask before acting";
  for (const button of $("perm-mode-menu").querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-current", button.dataset.mode === (skip ? "skip" : "ask") ? "true" : "false");
  }
}

async function applyPermissionMode(mode) {
  const s = await getSettings();
  s.permissionMode = mode === "skip" ? "skip" : "ask";
  await saveSettings(s);
  state.settings = { ...state.settings, ...s };
  renderPermMode();
}

async function renderSites() {
  const s = await getSettings();
  state.settings = { ...state.settings, approvedHosts: s.approvedHosts || [], permissionMode: s.permissionMode };
  const hosts = state.settings.approvedHosts;
  const list = $("sites-list");
  list.replaceChildren();
  $("sites-empty").classList.toggle("hidden", hosts.length > 0);
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "popover-row";
    const name = document.createElement("span");
    name.textContent = host;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "mini-btn";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      const s = await getSettings();
      s.approvedHosts = (s.approvedHosts || []).filter((item) => item !== host);
      await saveSettings(s);
      state.settings = { ...state.settings, approvedHosts: s.approvedHosts };
      renderSites();
    });
    row.append(name, revoke);
    list.appendChild(row);
  }
}

$("model-chip").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("model-menu");
  const open = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !open);
  $("model-chip").setAttribute("aria-expanded", open ? "true" : "false");
});
modelSel.addEventListener("change", updateModelChip);
providerSel.addEventListener("change", () => setTimeout(updateModelChip, 0));

$("perm-mode-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = $("perm-mode-menu");
  const willOpen = menu.classList.contains("hidden");
  menu.classList.toggle("hidden", !willOpen);
  $("perm-mode-btn").setAttribute("aria-expanded", willOpen ? "true" : "false");
  $("sites-panel").classList.add("hidden");
});

$("perm-mode-menu").addEventListener("click", async (e) => {
  const choice = e.target.closest("[data-mode]");
  if (!choice) return;
  e.stopPropagation();
  $("perm-mode-menu").classList.add("hidden");
  $("perm-mode-btn").setAttribute("aria-expanded", "false");
  if (choice.dataset.mode === "skip" && state.settings?.permissionMode !== "skip") {
    $("skip-modal").classList.remove("hidden");
    return;
  }
  await applyPermissionMode(choice.dataset.mode);
});

$("perm-sites-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  $("perm-mode-menu").classList.add("hidden");
  renderSites();
  $("sites-panel").classList.remove("hidden");
});

$("skip-cancel").addEventListener("click", () => $("skip-modal").classList.add("hidden"));
$("skip-confirm").addEventListener("click", async () => {
  $("skip-modal").classList.add("hidden");
  await applyPermissionMode("skip");
});

orchToggle.addEventListener("change", async () => {
  const s = await getSettings();
  s.orchestrator = { ...(s.orchestrator || {}), enabled: orchToggle.checked };
  await saveSettings(s);
  state.settings = { ...state.settings, orchestrator: s.orchestrator };
  if (orchToggle.checked && !(state.orchestrator?.endpoints)) {
    toast(
      "Orchestrator is on, but no models are selected. Open Settings → Orchestrator.",
      6000
    );
  }
  renderOrchStatus();
  try {
    port?.postMessage({ type: "get_config" });
  } catch {}
});

// suggestion chips (delegated so it survives empty-state re-renders)
messagesEl.addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  inputEl.value = chip.textContent.trim();
  autosize();
  inputEl.focus();
});

// A panel opened for a tab keeps that tab's chat: the browser hides it on other
// tabs, where opening the panel starts another chat, like Claude. Only a page
// shown without a tab follows the active one.
if (urlTabId == null) {
  chrome.tabs.onActivated.addListener(() => {
    bindToActiveTab();
  });
  chrome.windows.onFocusChanged.addListener(() => {
    bindToActiveTab();
  });
}

// The shortcut that opened this panel closes it again.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === CLOSE_PANEL_MESSAGE && urlTabId != null && msg.tabId === urlTabId) window.close();
  return false;
});

// Keep provider/model selectors in sync when Settings changes them.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.autobot_settings || changes.autobot_providers) {
    try {
      port?.postMessage({ type: "get_config" });
    } catch {}
  }
  if (changes.autobot_saved_prompts) loadPrompts();
  if (changes.autobot_schedules) {
    try {
      port?.postMessage({ type: "list_schedules" });
    } catch {}
  }
  if (changes.autobot_pending_prompt && changes.autobot_pending_prompt.newValue) {
    maybeRunPendingPrompt();
  }
  if (Object.keys(changes).some((k) => k.startsWith("autobot_session_meta_"))) {
    if (!$("history-panel").classList.contains("hidden")) {
      try {
        port?.postMessage({ type: "list_sessions" });
      } catch {}
    }
  }
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}
async function boot() {
  try {
    skillLibrary = await getSkills();
    applyTheme((await getSettings()).theme);
  } catch {}
  $("theme-btn").addEventListener("click", async () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    const settings = await getSettings();
    settings.theme = next;
    await saveSettings(settings);
  });
  try {
    const win = await chrome.windows.getCurrent();
    windowId = win?.id ?? null;
  } catch {}
  if (urlTabId != null) {
    activeTabId = urlTabId;
  } else {
    await refreshActiveTab();
  }
  connect();
}

boot();
autosize();
