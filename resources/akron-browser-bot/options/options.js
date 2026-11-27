import { PROVIDER_PRESETS, presetByKey, isLocalBaseUrl } from "../shared/presets.js";
import { parseSkillMd, serializeSkillMd } from "../shared/skills.js";
import { describeSchedule } from "../shared/schedules.js";
import {
  getProviders,
  saveProviders,
  getSettings,
  saveSettings,
  makeId,
  getSchedules,
  saveSchedules,
  getSavedPrompts,
  saveSavedPrompts,
  getSkills,
  saveSkills,
} from "../background/storage.js";
import { testProvider, listModels } from "../background/providers.js";
import { buildEndpointPool, providerKeys, summarizePool } from "../background/orchestrator.js";

const $ = (id) => document.getElementById(id);

const TOOL_NAMES = [
  "read_page",
  "read_text",
  "click",
  "type",
  "press_key",
  "scroll",
  "navigate",
  "open_tab",
  "list_tabs",
  "switch_tab",
  "go_back",
  "go_forward",
  "screenshot",
  "wait",
  "find",
  "form_input",
  "hover",
  "drag",
  "upload_image",
  "read_console_messages",
  "read_network_requests",
  "resize_window",
  "group_tabs",
  "ungroup_tabs",
  "update_plan",
  "browser_batch",
  "computer",
  "shortcut",
  "file_upload",
  "gif_creator",
  "execute_javascript",
  "read_clipboard",
  "vault_autofill",
  "write_clipboard",
  "load_skill",
  "save_skill",
  "save_result",
];

let providers = [];
let settings = {};
let schedules = [];
let savedPrompts = [];
let skills = [];

// What each settings form showed when it was last filled in from storage. A
// form that still shows it holds no unsaved input.
const shown = { agent: {}, policy: {}, tools: [], orchestrator: {}, updates: {} };
let latestUpdateState = null;

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// What was changed in a form since it was filled in. Only that is saved: the
// panel changes settings too (the permission mode, the model in use), and a
// field left alone here must not put its old value back.
function editedFields(form, before) {
  return Object.fromEntries(
    Object.entries(form).filter(([key, value]) => !sameValue(value, before[key]))
  );
}

// Every save on this page changes what is stored right now, not what the page
// last read: the panel and running tasks write to the same lists.
async function updateSettings(change) {
  const latest = await getSettings();
  settings = change(latest);
  if (settings !== latest) await saveSettings(settings);
}

async function updateProviders(change) {
  providers = change(await getProviders());
  await saveProviders(providers);
}

async function updateSkills(change) {
  skills = change(await getSkills());
  await saveSkills(skills);
}

async function updateSavedPrompts(change) {
  savedPrompts = change(await getSavedPrompts());
  await saveSavedPrompts(savedPrompts);
}

/* ------------------------------ init ------------------------------ */

function populatePresetSelect() {
  const sel = $("preset-select");
  sel.innerHTML = "";
  for (const p of PROVIDER_PRESETS) {
    const o = document.createElement("option");
    o.value = p.key;
    o.textContent = p.label;
    sel.appendChild(o);
  }
}

async function init() {
  populatePresetSelect();
  providers = await getProviders();
  settings = await getSettings();
  schedules = await getSchedules();
  savedPrompts = await getSavedPrompts();
  skills = await getSkills();
  renderProviders();
  renderAgentSettings();
  renderConfirmTools();
  renderSkills();
  renderSchedules();
  renderSavedPrompts();
  renderOrchestrator();
  renderUpdateSettings();
  loadUpdateState();
  bindEvents();
  applyHash();
}

function applyHash() {
  const raw = String(location.hash || "").replace(/^#/, "");
  const [id, query] = raw.split("?");
  const params = new URLSearchParams(query || "");
  const mic = $("permissions");
  if (mic && (id === "permissions" || params.get("requestMicrophone") === "true")) {
    mic.classList.remove("hidden");
    mic.scrollIntoView({ behavior: "smooth", block: "start" });
    if (params.get("requestMicrophone") === "true") grantMicrophone(params.get("returnTabId"));
  }
}

async function grantMicrophone(returnTabId) {
  const status = $("mic-status");
  status.textContent = "Waiting for the microphone permission…";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    let persisted = true;
    try {
      persisted = (await navigator.permissions.query({ name: "microphone" })).state === "granted";
    } catch {}
    if (!persisted) {
      status.textContent = 'You selected "Allow this time" which doesn\'t persist. Please click the button again and select "Allow while visiting the site" to enable voice narration.';
      return;
    }
    status.textContent = "Microphone allowed. Return to Akron and press the microphone button.";
    const tabId = Number(returnTabId);
    if (Number.isInteger(tabId)) chrome.tabs.update(tabId, { active: true }).catch(() => {});
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      status.textContent = "Microphone access was denied. You can change this in Chrome’s site settings for this extension.";
    } else if (error?.name === "NotFoundError") {
      status.textContent = "No microphone found. Please connect a microphone and try again.";
    } else {
      status.textContent = error?.message || "The microphone could not be opened.";
    }
  }
}

/* --------------------------- provider list --------------------------- */

function renderProviders() {
  const list = $("provider-list");
  list.innerHTML = "";
  $("no-providers").classList.toggle("hidden", providers.length > 0);

  for (const p of providers) {
    const card = document.createElement("div");
    card.className = "provider";

    const main = document.createElement("div");
    main.className = "p-main";

    const name = document.createElement("div");
    name.className = "p-name";
    name.textContent = p.name || p.type;

    const typeBadge = document.createElement("span");
    typeBadge.className = "badge";
    typeBadge.textContent = p.type || "openai-compatible";
    name.appendChild(typeBadge);

    const keyBadge = document.createElement("span");
    const totalKeys = providerKeys(p).length;
    const hasKey = totalKeys > 0 || (isLocalBaseUrl(p.baseUrl) && p.requiresKey !== true);
    keyBadge.className = `badge ${hasKey ? "ok" : "warn"}`;
    keyBadge.textContent = hasKey ? "key set" : "no key";
    name.appendChild(keyBadge);

    if (totalKeys > 1) {
      const multiBadge = document.createElement("span");
      multiBadge.className = "badge ok";
      multiBadge.textContent = `${totalKeys} keys`;
      name.appendChild(multiBadge);
    }

    const meta = document.createElement("div");
    meta.className = "p-meta";
    const models = (p.models || []).slice(0, 4).join(", ");
    meta.textContent = `${p.baseUrl || "(default URL)"} · ${
      (p.models || []).length
    } model(s)${models ? `: ${models}${(p.models || []).length > 4 ? "…" : ""}` : ""}`;

    main.append(name, meta);

    const actions = document.createElement("div");
    actions.className = "p-actions";

    const editBtn = document.createElement("button");
    editBtn.className = "btn ghost";
    editBtn.textContent = "Edit";
    editBtn.addEventListener("click", () => openEditor(p));

    const testBtn = document.createElement("button");
    testBtn.className = "btn ghost";
    testBtn.textContent = "Test";
    testBtn.addEventListener("click", async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Testing…";
      try {
        const model = p.defaultModel || (p.models && p.models[0]);
        if (!model) throw new Error("No model configured.");
        const reply = await testProvider(p, model);
        alert(`Success — provider replied: ${reply.slice(0, 200)}`);
      } catch (e) {
        alert(`Test failed: ${e?.message || e}`);
      } finally {
        testBtn.disabled = false;
        testBtn.textContent = "Test";
      }
    });

    const delBtn = document.createElement("button");
    delBtn.className = "btn danger";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteProvider(p));

    actions.append(editBtn, testBtn, delBtn);
    card.append(main, actions);
    list.appendChild(card);
  }
}

async function deleteProvider(p) {
  if (!confirm(`Delete provider "${p.name}"? Its API key will be removed.`)) return;
  await updateProviders((list) => list.filter((x) => x.id !== p.id));

  const first = providers[0];
  await updateSettings((latest) =>
    latest.activeProviderId === p.id
      ? {
          ...latest,
          activeProviderId: first?.id || null,
          activeModel: first?.defaultModel || (first?.models && first.models[0]) || null,
        }
      : latest
  );
  renderProviders();
  renderAgentSettings();
  renderOrchestrator();
}

/* ----------------------------- editor ----------------------------- */

function setHint(preset) {
  const baseHint = $("baseurl-hint");
  const keyHint = $("key-hint");
  if (preset) {
    baseHint.textContent = preset.docs
      ? `Get a key: ${preset.docs}`
      : "Point this at any OpenAI-compatible endpoint.";
    if (preset.docs) {
      baseHint.innerHTML = `Get a key: <a href="${preset.docs}" target="_blank" rel="noopener noreferrer">${preset.docs}</a>`;
    }
    keyHint.textContent = preset.keyHint ? `Example: ${preset.keyHint}` : "";
  } else {
    baseHint.textContent = "";
    keyHint.textContent = "";
  }
}

function updateModelDatalist() {
  const models = parseModels($("f-models").value);
  const dl = $("model-options");
  dl.innerHTML = "";
  for (const m of models) {
    const o = document.createElement("option");
    o.value = m;
    dl.appendChild(o);
  }
  if (!$("f-default-model").value && models.length) {
    $("f-default-model").value = models[0];
  }
}

function openEditor(provider, preset) {
  const form = $("provider-form");
  form.classList.remove("hidden");
  $("test-result").textContent = "";
  $("test-result").className = "test-result";

  if (provider) {
    $("editor-title").textContent = "Edit provider";
    $("f-id").value = provider.id;
    $("f-name").value = provider.name || "";
    $("f-type").value = provider.type || "openai-compatible";
    $("f-baseurl").value = provider.baseUrl || "";
    $("f-apikey").value = provider.apiKey || "";
    $("f-apikeys").value = (provider.apiKeys || []).join("\n");
    $("f-models").value = (provider.models || []).join("\n");
    $("f-default-model").value =
      provider.defaultModel || (provider.models && provider.models[0]) || "";
    $("f-maxtokens").value = provider.maxTokens || 4096;
    setHint(presetByKey(provider.presetKey) || null);
  } else {
    const p = preset || presetByKey($("preset-select").value);
    $("editor-title").textContent = p ? `Add ${p.label}` : "Add provider";
    $("f-id").value = "";
    $("f-name").value = p ? p.label : "";
    $("f-type").value = p ? p.type : "openai-compatible";
    $("f-baseurl").value = p ? p.baseUrl : "";
    $("f-apikey").value = "";
    $("f-apikeys").value = "";
    $("f-models").value = p ? (p.models || []).join("\n") : "";
    $("f-default-model").value = p && p.models ? p.models[0] || "" : "";
    $("f-maxtokens").value = 4096;
    setHint(p || null);
  }

  updateModelDatalist();
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  $("f-name").focus();
}

function parseModels(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

function parseKeys(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(/[\n,]/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

function collectProvider() {
  const models = parseModels($("f-models").value);
  const id = $("f-id").value || makeId("prov");
  const presetKey = $("preset-select").value;
  const apiKeys = parseKeys($("f-apikeys").value);
  const primary = $("f-apikey").value.trim();
  const apiKey = primary || apiKeys[0] || "";
  return {
    id,
    name: $("f-name").value.trim(),
    type: $("f-type").value,
    baseUrl: $("f-baseurl").value.trim(),
    apiKey,
    apiKeys: apiKeys.filter((key) => key !== apiKey),
    requiresKey:
      (providers.find((p) => p.id === $("f-id").value)?.requiresKey) ||
      presetByKey(presetKey)?.requiresKey === true,
    models,
    defaultModel: $("f-default-model").value.trim() || models[0] || "",
    maxTokens: Number($("f-maxtokens").value) || 4096,
    presetKey,
  };
}

function showTestResult(text, kind) {
  const el = $("test-result");
  el.textContent = text;
  el.className = "test-result" + (kind ? ` ${kind}` : "");
}

async function saveProviderFromForm(e) {
  e.preventDefault();
  const cfg = collectProvider();

  if (!cfg.name) return showTestResult("Give this provider a name.", "err");
  if (!cfg.models.length) return showTestResult("Add at least one model.", "err");
  if (!cfg.apiKey && (cfg.requiresKey || !isLocalBaseUrl(cfg.baseUrl))) {
    return showTestResult("An API key is required.", "err");
  }

  await updateProviders((list) =>
    list.some((p) => p.id === cfg.id)
      ? list.map((p) => (p.id === cfg.id ? cfg : p))
      : [...list, cfg]
  );

  await updateSettings((latest) =>
    latest.activeProviderId
      ? latest
      : { ...latest, activeProviderId: cfg.id, activeModel: cfg.defaultModel }
  );

  $("provider-form").classList.add("hidden");
  renderProviders();
  renderAgentSettings();
  renderOrchestrator();
  showTestResult("", "");
}

async function testFromForm() {
  const cfg = collectProvider();
  const btn = $("test-provider");
  btn.disabled = true;
  btn.textContent = "Testing…";
  showTestResult("Contacting provider…", "");
  try {
    if (!cfg.apiKey && (cfg.requiresKey || !isLocalBaseUrl(cfg.baseUrl))) {
      throw new Error("An API key is required.");
    }
    if (!cfg.defaultModel) throw new Error("Choose a model first.");
    const reply = await testProvider(cfg, cfg.defaultModel);
    showTestResult(`Success: ${reply.slice(0, 160)}`, "ok");
  } catch (e) {
    showTestResult(`Failed: ${e?.message || e}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Test connection";
  }
}

async function fetchModelsFromForm() {
  const cfg = collectProvider();
  const btn = $("fetch-models");
  btn.disabled = true;
  btn.textContent = "Fetching…";
  try {
    if (!cfg.apiKey && (cfg.requiresKey || !isLocalBaseUrl(cfg.baseUrl))) {
      throw new Error("An API key is required.");
    }
    const models = await listModels(cfg);
    if (!models.length) throw new Error("The provider returned no models.");
    $("f-models").value = models.slice(0, 300).join("\n");
    updateModelDatalist();
    if (!$("f-default-model").value) $("f-default-model").value = models[0];
    showTestResult(`Loaded ${models.length} model(s).`, "ok");
  } catch (e) {
    showTestResult(`Failed: ${e?.message || e}`, "err");
  } finally {
    btn.disabled = false;
    btn.textContent = "Fetch models from provider";
  }
}

/* -------------------------- agent settings -------------------------- */

function renderAgentSettings() {
  renderAgentForm();
  renderApprovedSites();
  renderPolicyForm();
}

function renderAgentForm() {
  const sel = $("s-provider");
  sel.innerHTML = "";

  if (!providers.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "No providers";
    sel.appendChild(o);
  } else {
    for (const p of providers) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name || p.type;
      sel.appendChild(o);
    }
    // With no usable choice stored, the first provider is the one in use.
    const active = providers.find((p) => p.id === settings.activeProviderId) || providers[0];
    sel.value = active.id;
  }

  refreshAgentModelList();

  $("s-temperature").value =
    typeof settings.temperature === "number" ? settings.temperature : 0.7;
  $("s-screenshots").checked = !!settings.sendScreenshots;
  $("s-streaming").checked = settings.streaming !== false;
  $("s-sound").checked = settings.soundOnComplete !== false;
  $("s-notify").checked = settings.notifyOnComplete !== false;
  $("s-plan-approval").checked = settings.planApproval === true;
  $("s-native").checked = !!settings.nativeHost;
  $("s-bridge").checked = !!settings.desktopBridge;
  $("s-speak").checked = !!settings.speakReplies;
  $("s-voice-engine").value = settings.voiceEngine || "auto";
  $("s-voice-lang").value = settings.voiceLang || "en-US";
  $("s-confirm-sites").checked = !!settings.confirmNewSites;
  $("s-permission-mode").value = settings.permissionMode === "skip" ? "skip" : "ask";
  $("s-domain-change").checked = !!settings.pauseOnDomainChange;
  $("s-autogroup").checked = settings.autoGroupTabs !== false;
  $("s-group-title").value = settings.groupTitle || "Akron";
  $("s-extra").value = settings.systemPromptExtra || "";
  // A provider or model shown only because nothing usable is stored counts as
  // unsaved, so Save stores it.
  shown.agent = {
    ...readAgentForm(),
    activeProviderId: settings.activeProviderId,
    activeModel: settings.activeModel,
  };
}

function readPolicyForm() {
  return {
    allowedDomains: parseDomainList($("s-allowed").value),
    blockedDomains: parseDomainList($("s-blocked").value),
  };
}

function renderPolicyForm() {
  $("s-allowed").value = (settings.allowedDomains || []).join("\n");
  $("s-blocked").value = (settings.blockedDomains || []).join("\n");
  shown.policy = readPolicyForm();
}

function refreshAgentModelList() {
  const provider = providers.find((p) => p.id === $("s-provider").value);
  const dl = $("s-model-options");
  dl.innerHTML = "";
  if (!provider) {
    $("s-model").value = "";
    return;
  }
  for (const m of provider.models || []) {
    const o = document.createElement("option");
    o.value = m;
    dl.appendChild(o);
  }
  const preferred =
    settings.activeProviderId === provider.id && settings.activeModel
      ? settings.activeModel
      : provider.defaultModel || (provider.models && provider.models[0]) || "";
  $("s-model").value = preferred;
}

function readAgentForm() {
  const temperature = Math.max(0, Math.min(2, Number($("s-temperature").value)));
  return {
    activeProviderId: $("s-provider").value || null,
    activeModel: $("s-model").value.trim() || null,
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    sendScreenshots: $("s-screenshots").checked,
    streaming: $("s-streaming").checked,
    soundOnComplete: $("s-sound").checked,
    notifyOnComplete: $("s-notify").checked,
    planApproval: $("s-plan-approval").checked,
    nativeHost: $("s-native").checked,
    desktopBridge: $("s-bridge").checked,
    speakReplies: $("s-speak").checked,
    voiceEngine: $("s-voice-engine").value || "auto",
    voiceLang: $("s-voice-lang").value.trim() || "en-US",
    permissionMode: $("s-permission-mode").value === "skip" ? "skip" : "ask",
    confirmNewSites: $("s-confirm-sites").checked,
    pauseOnDomainChange: $("s-domain-change").checked,
    autoGroupTabs: $("s-autogroup").checked,
    groupTitle: $("s-group-title").value.trim() || "Akron",
    systemPromptExtra: $("s-extra").value,
  };
}

async function saveAgentSettings() {
  const form = readAgentForm();
  const edits = editedFields(form, shown.agent);
  // A model belongs to its provider: the two are saved together.
  const choice =
    "activeProviderId" in edits || "activeModel" in edits
      ? { activeProviderId: form.activeProviderId, activeModel: form.activeModel }
      : {};
  await updateSettings((latest) => ({ ...latest, ...edits, ...choice }));
  renderAgentForm();
  flash($("save-result"), "Saved.");
}

function flash(el, text) {
  el.textContent = text;
  el.className = "test-result ok";
  setTimeout(() => {
    el.textContent = "";
    el.className = "test-result";
  }, 2000);
}

function parseDomainList(raw) {
  return [
    ...new Set(
      String(raw || "")
        .split(/[\n,]/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

function renderApprovedSites() {
  const list = $("approved-sites");
  const hosts = Array.isArray(settings.approvedHosts) ? settings.approvedHosts : [];
  list.replaceChildren();
  $("approved-empty").classList.toggle("hidden", hosts.length > 0);
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "prompt-row";
    const name = document.createElement("span");
    name.textContent = host;
    const revoke = document.createElement("button");
    revoke.type = "button";
    revoke.className = "btn ghost small";
    revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      await updateSettings((latest) => ({
        ...latest,
        approvedHosts: latest.approvedHosts.filter((item) => item !== host),
      }));
      renderApprovedSites();
    });
    row.append(name, revoke);
    list.appendChild(row);
  }
}

async function savePolicySettings() {
  const form = readPolicyForm();
  await updateSettings((latest) => ({ ...latest, ...form }));
  shown.policy = form;
  flash($("save-policy-result"), "Saved.");
}

/* ------------------------- tool confirmations ------------------------- */

function renderConfirmTools() {
  const list = $("confirm-tools-list");
  list.innerHTML = "";
  const active = new Set(settings.confirmTools || []);
  for (const name of TOOL_NAMES) {
    const label = document.createElement("label");
    label.className = "check-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = name;
    cb.checked = active.has(name);
    const span = document.createElement("span");
    span.textContent = name;
    label.append(cb, span);
    list.appendChild(label);
  }
  shown.tools = checkedTools();
}

function checkedTools() {
  return [...document.querySelectorAll("#confirm-tools-list input:checked")].map(
    (el) => el.value
  );
}

async function saveToolSettings() {
  const confirmTools = checkedTools();
  await updateSettings((latest) => ({ ...latest, confirmTools }));
  shown.tools = confirmTools;
  flash($("save-tools-result"), "Saved.");
}

/* ------------------------------ skills ------------------------------ */

function renderSkills() {
  const list = $("skills-list");
  list.innerHTML = "";
  if (!skills.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "No skills yet.";
    list.appendChild(empty);
    return;
  }

  for (const s of skills) {
    const card = document.createElement("div");
    card.className = "skill-card";

    const head = document.createElement("label");
    head.className = "check-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!s.enabled;
    cb.addEventListener("change", async () => {
      const enabled = cb.checked;
      await updateSkills((list) => list.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    });
    const name = document.createElement("strong");
    name.textContent = s.name;
    head.append(cb, name);

    const desc = document.createElement("p");
    desc.className = "skill-desc";
    desc.textContent = s.description || "";

    card.appendChild(head);
    if (s.description) card.appendChild(desc);

    if (!s.builtin) {
      const edit = document.createElement("button");
      edit.className = "btn ghost small";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        $("sk-name").value = s.name || "";
        $("sk-desc").value = s.description || "";
        $("sk-instructions").value = s.instructions || "";
        $("sk-name").dataset.editId = s.id;
      });
      const del = document.createElement("button");
      del.className = "btn danger small";
      del.textContent = "Delete";
      del.addEventListener("click", async () => {
        await updateSkills((list) => list.filter((x) => x.id !== s.id));
        renderSkills();
      });
      card.append(edit, del);
    }
    list.appendChild(card);
  }
}

async function addSkill() {
  const name = $("sk-name").value.trim();
  const description = $("sk-desc").value.trim();
  const instructions = $("sk-instructions").value.trim();
  if (!name || !instructions) {
    $("skill-result").textContent = "Give the skill a name and instructions.";
    $("skill-result").className = "test-result err";
    return;
  }
  const editId = $("sk-name").dataset.editId || "";
  const added = {
    id: makeId("skill"),
    name,
    description,
    instructions,
    enabled: true,
    builtin: false,
  };
  await updateSkills((list) =>
    list.some((skill) => skill.id === editId)
      ? list.map((skill) =>
          skill.id === editId ? { ...skill, name, description, instructions } : skill
        )
      : [...list, added]
  );
  // A skill that was deleted elsewhere while it was being edited is added again.
  const existing = skills.some((skill) => skill.id === editId);
  $("sk-name").value = "";
  $("sk-desc").value = "";
  $("sk-instructions").value = "";
  delete $("sk-name").dataset.editId;
  renderSkills();
  flash($("skill-result"), existing ? "Skill updated." : "Skill added.");
}

/* ---------------------------- schedules ---------------------------- */

// Changes the list as it is stored right now, not as this page last read it:
// a task that ran in the meantime has written its result there.
async function updateSchedules(change) {
  schedules = change(await getSchedules());
  await saveSchedules(schedules);
  renderSchedules();
}


function renderSchedules() {
  const list = $("schedule-list");
  list.innerHTML = "";
  $("no-schedules").classList.toggle("hidden", schedules.length > 0);

  for (const s of schedules) {
    const row = document.createElement("div");
    row.className = "schedule";

    const main = document.createElement("div");
    main.className = "sch-main";

    const title = document.createElement("div");
    title.className = "sch-title";
    title.textContent = s.title || s.prompt.slice(0, 60);

    const meta = document.createElement("div");
    meta.className = "sch-meta";
    const ran = s.lastRunAt ? ` · last run ${new Date(s.lastRunAt).toLocaleString()}` : "";
    meta.textContent = `${describeSchedule(s)} · ${s.enabled ? "enabled" : "paused"} · ${
      s.lastStatus || "never run"
    }${ran}`;

    main.append(title, meta);

    if (s.lastResult) {
      const result = document.createElement("pre");
      result.className = "sch-result";
      result.textContent = String(s.lastResult).slice(0, 500);
      main.appendChild(result);
    }

    const actions = document.createElement("div");
    actions.className = "sch-actions";

    const toggle = document.createElement("button");
    toggle.className = "btn ghost small";
    toggle.textContent = s.enabled ? "Pause" : "Enable";
    toggle.addEventListener("click", async () => {
      const enabled = !s.enabled;
      await updateSchedules((list) => list.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
    });

    const run = document.createElement("button");
    run.className = "btn ghost small";
    run.textContent = "Run now";
    run.addEventListener("click", async () => {
      run.disabled = true;
      run.textContent = "Running…";
      try {
        const res = await chrome.runtime.sendMessage({ type: "run_schedule_now", id: s.id });
        if (res?.result?.lastResult) {
          alert(String(res.result.lastResult).slice(0, 1000));
        }
      } catch (e) {
        alert(`Run failed: ${e?.message || e}`);
      } finally {
        schedules = await getSchedules();
        renderSchedules();
      }
    });

    const del = document.createElement("button");
    del.className = "btn danger small";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete scheduled task "${s.title || s.prompt.slice(0, 30)}"?`)) return;
      await updateSchedules((list) => list.filter((x) => x.id !== s.id));
    });

    actions.append(toggle, run, del);
    row.append(main, actions);
    list.appendChild(row);
  }
}

async function addSchedule() {
  const prompt = $("sch-prompt").value.trim();
  if (!prompt) {
    $("schedule-result").textContent = "The prompt cannot be empty.";
    $("schedule-result").className = "test-result err";
    return;
  }
  const everyMinutes = Math.max(1, Number($("sch-every").value) || 60);
  const repeatType = $("sch-repeat").value || "interval";
  const added = {
    id: makeId("sched"),
    title: $("sch-title").value.trim() || prompt.slice(0, 50),
    prompt,
    url: $("sch-url").value.trim() || "",
    everyMinutes,
    repeatType,
    specificTime: $("sch-time").value || "09:00",
    specificDate: $("sch-date").value || "",
    dayOfWeek: Number($("sch-weekday").value),
    dayOfMonth: Math.max(1, Math.min(31, Number($("sch-monthday").value) || 1)),
    monthAndDay: $("sch-annual").value || "01-01",
    enabled: $("sch-enabled").checked,
    createdAt: Date.now(),
  };
  await updateSchedules((list) => [...list, added]);
  $("sch-title").value = "";
  $("sch-prompt").value = "";
  $("sch-url").value = "";
  $("sch-every").value = "60";
  flash($("schedule-result"), "Schedule added.");
}

/* --------------------------- saved prompts --------------------------- */

function renderSavedPrompts() {
  const list = $("saved-prompt-list");
  list.innerHTML = "";
  $("no-prompts").classList.toggle("hidden", savedPrompts.length > 0);

  for (const p of savedPrompts) {
    const row = document.createElement("div");
    row.className = "saved-prompt";

    const main = document.createElement("div");
    main.className = "sp-main";
    const title = document.createElement("div");
    title.className = "sp-title";
    title.textContent = p.title || p.text.slice(0, 60);
    const text = document.createElement("div");
    text.className = "sp-text";
    text.textContent = p.text;
    main.append(title, text);

    const del = document.createElement("button");
    del.className = "btn danger small";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      await updateSavedPrompts((list) => list.filter((x) => x.id !== p.id));
      renderSavedPrompts();
    });

    row.append(main, del);
    list.appendChild(row);
  }
}

async function addSavedPrompt() {
  const text = $("sp-text").value.trim();
  if (!text) {
    $("prompt-result").textContent = "The prompt cannot be empty.";
    $("prompt-result").className = "test-result err";
    return;
  }
  const added = {
    id: makeId("p"),
    title: $("sp-title").value.trim() || text.split("\n")[0].slice(0, 50),
    text,
    createdAt: Date.now(),
  };
  await updateSavedPrompts((list) => [added, ...list]);
  $("sp-title").value = "";
  $("sp-text").value = "";
  renderSavedPrompts();
  flash($("prompt-result"), "Prompt saved.");
}

/* --------------------------- orchestrator --------------------------- */

function selectedOrchestratorEndpoints() {
  const seen = new Set();
  const out = [];
  for (const cb of document.querySelectorAll("#orch-pool input[type=checkbox]:checked")) {
    const providerId = cb.dataset.provider;
    const model = cb.dataset.model;
    if (!providerId || !model) continue;
    const key = `${providerId}::${model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ providerId, model, enabled: true });
  }
  return out;
}

function updateOrchSummary() {
  const selected = selectedOrchestratorEndpoints();
  const trial = {
    ...settings,
    orchestrator: {
      ...(settings.orchestrator || {}),
      enabled: true,
      endpoints: selected,
    },
  };
  const summary = summarizePool(providers, trial);
  const el = $("orch-summary");
  el.className = `badge ${summary.endpoints ? "ok" : "warn"}`;
  el.textContent = summary.endpoints
    ? `${selected.length} model(s) → ${summary.endpoints} endpoint(s)`
    : "no endpoints selected";
}

function renderOrchestrator() {
  const orch = settings.orchestrator || {};
  $("s-orchestrator").checked = !!orch.enabled;
  $("s-orch-max").value = Math.max(1, Math.min(200, Number(orch.maxAttempts) || 200));
  $("s-orch-cooldown").value = Math.max(
    5,
    Math.min(86400, Number(orch.cooldownSeconds) || 60)
  );

  const selected = new Set(
    (Array.isArray(orch.endpoints) ? orch.endpoints : []).map(
      (entry) => `${entry.providerId}::${entry.model}`
    )
  );
  const pool = $("orch-pool");
  pool.innerHTML = "";

  if (!providers.length) {
    const empty = document.createElement("div");
    empty.className = "empty-note";
    empty.textContent = "Add a provider first, then select models for orchestrator mode.";
    pool.appendChild(empty);
    updateOrchSummary();
    shown.orchestrator = readOrchestratorForm();
    return;
  }

  for (const provider of providers) {
    const models = [...new Set(Array.isArray(provider.models) ? provider.models : [])];
    const keys = providerKeys(provider).length;
    const card = document.createElement("div");
    card.className = "orch-provider";

    const head = document.createElement("div");
    head.className = "orch-provider-head";
    const name = document.createElement("strong");
    name.textContent = provider.name || provider.type || provider.id;
    const meta = document.createElement("span");
    meta.textContent = `${keys} key${keys === 1 ? "" : "s"} · ${models.length} model${
      models.length === 1 ? "" : "s"
    }`;
    head.append(name, meta);
    card.appendChild(head);

    if (!models.length) {
      const note = document.createElement("div");
      note.className = "orch-empty";
      note.textContent = "No models listed for this provider. Add models in its settings.";
      card.appendChild(note);
    } else {
      const list = document.createElement("div");
      list.className = "check-list";
      for (const model of models) {
        const label = document.createElement("label");
        label.className = "check-row";
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.dataset.provider = provider.id;
        checkbox.dataset.model = model;
        checkbox.checked = selected.has(`${provider.id}::${model}`);
        const text = document.createElement("span");
        text.textContent = model;
        label.append(checkbox, text);
        list.appendChild(label);
      }
      card.appendChild(list);
    }

    pool.appendChild(card);
  }

  updateOrchSummary();
  shown.orchestrator = readOrchestratorForm();
}

function readOrchestratorForm() {
  return {
    enabled: $("s-orchestrator").checked,
    endpoints: selectedOrchestratorEndpoints(),
    maxAttempts: Math.max(1, Math.min(200, Number($("s-orch-max").value) || 200)),
    cooldownSeconds: Math.max(5, Math.min(86400, Number($("s-orch-cooldown").value) || 60)),
  };
}

// The panel switches orchestrator mode on and off as well, so only what was
// changed here is written.
async function saveOrchestrator() {
  const edits = editedFields(readOrchestratorForm(), shown.orchestrator);
  await updateSettings((latest) => ({
    ...latest,
    orchestrator: { ...latest.orchestrator, ...edits },
  }));
  renderOrchestrator();
  flash($("orch-result"), "Orchestrator saved.");
}

async function refreshAllModelLists() {
  const btn = $("orch-refresh-models");
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  const found = new Map();
  let failed = 0;
  const queue = [...providers];

  const worker = async () => {
    while (queue.length) {
      const provider = queue.shift();
      try {
        const keys = providerKeys(provider);
        const attempts = (keys.length ? keys : [""]).slice(0, 3);
        let models = null;
        for (const key of attempts) {
          try {
            models = await listModels({ ...provider, apiKey: key });
            if (models.length) break;
          } catch (e) {
            if (![401, 403, 429].includes(Number(e?.status))) break;
          }
        }
        if (models?.length) found.set(provider.id, models);
        else failed++;
      } catch {
        failed++;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(4, Math.max(1, queue.length)) }, worker)
  );

  // Asking every provider takes a while: the names go into the list as it is
  // stored now, not as it was when the asking started.
  if (found.size) {
    await updateProviders((list) =>
      list.map((p) =>
        found.has(p.id)
          ? { ...p, models: [...new Set([...found.get(p.id), ...(p.models || [])])] }
          : p
      )
    );
  }
  renderProviders();
  renderAgentSettings();
  renderOrchestrator();
  flash(
    $("orch-result"),
    `Refreshed ${found.size} provider(s)${failed ? `, ${failed} failed` : ""}.`
  );
  btn.disabled = false;
  btn.textContent = "Refresh model lists";
}

/* ------------------------------ events ------------------------------ */

function bindEvents() {
  $("add-provider").addEventListener("click", () => {
    openEditor(null, presetByKey($("preset-select").value));
  });

  $("provider-form").addEventListener("submit", saveProviderFromForm);

  $("cancel-provider").addEventListener("click", () => {
    $("provider-form").classList.add("hidden");
    showTestResult("", "");
  });

  $("test-provider").addEventListener("click", testFromForm);
  $("fetch-models").addEventListener("click", fetchModelsFromForm);

  $("toggle-key").addEventListener("click", () => {
    const input = $("f-apikey");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("toggle-key").textContent = showing ? "Show" : "Hide";
  });

  $("f-models").addEventListener("input", updateModelDatalist);

  $("s-provider").addEventListener("change", refreshAgentModelList);

  $("save-settings").addEventListener("click", saveAgentSettings);
  $("save-policy").addEventListener("click", savePolicySettings);
  $("save-tools").addEventListener("click", saveToolSettings);
  $("save-orchestrator").addEventListener("click", saveOrchestrator);
  $("orch-refresh-models").addEventListener("click", refreshAllModelLists);
  $("orch-select-all").addEventListener("click", () => {
    for (const cb of document.querySelectorAll("#orch-pool input[type=checkbox]")) {
      cb.checked = true;
    }
    updateOrchSummary();
  });
  $("orch-clear").addEventListener("click", () => {
    for (const cb of document.querySelectorAll("#orch-pool input[type=checkbox]")) {
      cb.checked = false;
    }
    updateOrchSummary();
  });
  $("orch-pool").addEventListener("change", updateOrchSummary);
  $("add-skill").addEventListener("click", addSkill);
  $("mic-grant")?.addEventListener("click", () => {
    const params = new URLSearchParams(String(location.hash || "").split("?")[1] || "");
    grantMicrophone(params.get("returnTabId"));
  });
  $("import-skill").addEventListener("click", () => $("skill-file").click());
  $("skill-file").addEventListener("change", async () => {
    const file = $("skill-file").files?.[0];
    if (!file) return;
    const parsed = parseSkillMd(await file.text());
    const imported = { id: makeId("skill"), ...parsed, enabled: true };
    await updateSkills((list) => [...list, imported]);
    renderSkills();
    flash($("skill-result"), `Imported ${parsed.name}.`);
    $("skill-file").value = "";
  });
  $("export-skills").addEventListener("click", () => {
    const blob = new Blob([skills.map((skill) => serializeSkillMd(skill)).join("\n")], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "autobot-skills.md";
    link.click();
    URL.revokeObjectURL(url);
  });
  $("add-schedule").addEventListener("click", addSchedule);
  $("add-saved-prompt").addEventListener("click", addSavedPrompt);
  $("toggle-gh-token")?.addEventListener("click", () => {
    const input = $("s-github-token");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    $("toggle-gh-token").textContent = showing ? "Show" : "Hide";
  });
  $("save-update-settings")?.addEventListener("click", saveUpdateSettings);
  $("check-updates-btn")?.addEventListener("click", triggerUpdateCheck);
  $("apply-update-btn")?.addEventListener("click", triggerUpdateApply);
}

/* ------------------------ updates from github ----------------------- */

function readUpdateForm() {
  return {
    autoUpdate: $("s-autoupdate") ? $("s-autoupdate").checked : true,
    updateChannel: $("s-update-channel")?.value === "prerelease" ? "prerelease" : "stable",
    githubUpdateToken: ($("s-github-token")?.value || "").trim(),
  };
}

function renderUpdateSettings() {
  if ($("s-autoupdate")) $("s-autoupdate").checked = settings.autoUpdate !== false;
  if ($("s-update-channel")) {
    $("s-update-channel").value = settings.updateChannel === "prerelease" ? "prerelease" : "stable";
  }
  if ($("s-github-token")) $("s-github-token").value = settings.githubUpdateToken || "";
  shown.updates = readUpdateForm();
}

function renderUpdateStatus(updateState) {
  latestUpdateState = updateState || latestUpdateState;
  const ver = chrome.runtime?.getManifest?.().version || "1.6.8";
  const badge = $("update-badge");
  const statusEl = $("update-status-text");
  const notesEl = $("update-notes");
  const applyBtn = $("apply-update-btn");
  if (!badge || !statusEl) return;

  if (!latestUpdateState) {
    badge.className = "badge";
    badge.textContent = `v${ver}`;
    statusEl.textContent = "Ready to check GitHub for updates.";
    notesEl?.classList.add("hidden");
    applyBtn?.classList.add("hidden");
    return;
  }

  if (latestUpdateState.ok && latestUpdateState.updateAvailable) {
    badge.className = "badge ok";
    badge.textContent = `v${latestUpdateState.latestVersion} available`;
    statusEl.textContent = `Current: v${latestUpdateState.currentVersion || ver} · Latest on GitHub: v${latestUpdateState.latestVersion}`;
    if (latestUpdateState.release?.notes && notesEl) {
      notesEl.textContent = latestUpdateState.release.notes;
      notesEl.classList.remove("hidden");
    } else {
      notesEl?.classList.add("hidden");
    }
    applyBtn?.classList.remove("hidden");
  } else if (latestUpdateState.ok) {
    badge.className = "badge ok";
    badge.textContent = `v${latestUpdateState.currentVersion || ver}`;
    const when = latestUpdateState.checkedAt
      ? ` · Checked ${new Date(latestUpdateState.checkedAt).toLocaleTimeString()}`
      : "";
    statusEl.textContent = `Up to date on v${latestUpdateState.currentVersion || ver}${when}.`;
    notesEl?.classList.add("hidden");
    applyBtn?.classList.add("hidden");
  } else {
    badge.className = "badge warn";
    badge.textContent = `v${ver}`;
    statusEl.textContent = latestUpdateState.error || "Could not check GitHub for updates.";
    notesEl?.classList.add("hidden");
    applyBtn?.classList.add("hidden");
  }
}

async function loadUpdateState() {
  try {
    const res = await chrome.runtime.sendMessage({ type: "get_update_state" });
    if (res?.state) renderUpdateStatus(res.state);
  } catch {
    renderUpdateStatus(null);
  }
}

async function saveUpdateSettings() {
  const edits = editedFields(readUpdateForm(), shown.updates);
  await updateSettings((latest) => ({ ...latest, ...edits }));
  renderUpdateSettings();
  flash($("update-result"), "Update settings saved.");
}

async function triggerUpdateCheck() {
  const btn = $("check-updates-btn");
  if (btn) btn.disabled = true;
  if ($("update-result")) $("update-result").textContent = "Checking GitHub…";
  try {
    const edits = editedFields(readUpdateForm(), shown.updates);
    if (Object.keys(edits).length) {
      await updateSettings((latest) => ({ ...latest, ...edits }));
      renderUpdateSettings();
    }
    const res = await chrome.runtime.sendMessage({ type: "check_updates", manual: true });
    renderUpdateStatus(res);
    if ($("update-result")) {
      $("update-result").textContent = res?.ok
        ? res.updateAvailable
          ? `Found v${res.latestVersion}`
          : "Up to date."
        : res?.error || "Check failed.";
    }
  } catch (e) {
    if ($("update-result")) $("update-result").textContent = e?.message || "Check failed.";
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function triggerUpdateApply() {
  const btn = $("apply-update-btn");
  if (btn) btn.disabled = true;
  if ($("update-result")) $("update-result").textContent = "Applying update…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "apply_update" });
    if (res?.mode === "download" && $("update-result")) {
      flash($("update-result"), res.message || `Downloaded ${res.filename}`);
    } else if (res?.mode === "open_release" && res.htmlUrl) {
      chrome.tabs.create({ url: res.htmlUrl });
    } else if (res?.ok && $("update-result")) {
      flash($("update-result"), `Updated to v${res.latestVersion || latestUpdateState?.latestVersion}. Reloading…`);
    } else if ($("update-result")) {
      $("update-result").textContent = res?.error || "Update failed.";
    }
  } catch (e) {
    if ($("update-result")) $("update-result").textContent = e?.message || "Update failed.";
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ---------------------- changes made elsewhere ---------------------- */

// The panel and running tasks write to the same storage while this page is
// open. The lists follow at once; a form follows unless it holds unsaved input.
function followSettings() {
  renderApprovedSites();
  if (sameValue(readAgentForm(), shown.agent)) renderAgentForm();
  if (sameValue(readPolicyForm(), shown.policy)) renderPolicyForm();
  if (sameValue(checkedTools(), shown.tools)) renderConfirmTools();
  if (sameValue(readOrchestratorForm(), shown.orchestrator)) renderOrchestrator();
  if (sameValue(readUpdateForm(), shown.updates)) renderUpdateSettings();
}

const FOLLOWED = {
  autobot_settings: async () => {
    settings = await getSettings();
    followSettings();
  },
  autobot_providers: async () => {
    providers = await getProviders();
    renderProviders();
    followSettings();
  },
  autobot_skills: async () => {
    skills = await getSkills();
    renderSkills();
  },
  autobot_saved_prompts: async () => {
    savedPrompts = await getSavedPrompts();
    renderSavedPrompts();
  },
  autobot_schedules: async () => {
    schedules = await getSchedules();
    renderSchedules();
  },
  autobot_update_state: async () => {
    await loadUpdateState();
  },
};

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  for (const [key, follow] of Object.entries(FOLLOWED)) {
    if (changes[key]) follow();
  }
});

window.addEventListener("hashchange", applyHash);

init();
