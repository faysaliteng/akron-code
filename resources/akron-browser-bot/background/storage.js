// Local-only persistence for Akron. Everything lives in chrome.storage.local.
// API keys never leave the machine except to the provider you configured.

const PROVIDERS_KEY = "autobot_providers";
const SETTINGS_KEY = "autobot_settings";
const CONVERSATION_KEY = "autobot_conversation";

const STEP_CAP_KEYS = [
  "maxSteps",
  "max_steps",
  "maxIterations",
  "max_iterations",
  "stepLimit",
  "stepCap",
];

function stripStepCaps(value) {
  if (Array.isArray(value)) return value.map(stripStepCaps);
  if (!value || typeof value !== "object") return value;
  const next = {};
  for (const [key, child] of Object.entries(value)) {
    if (STEP_CAP_KEYS.includes(key)) continue;
    next[key] = stripStepCaps(child);
  }
  return next;
}

export const DEFAULT_SETTINGS = {
  activeProviderId: null,
  activeModel: null,
  temperature: 0.7,
  sendScreenshots: false,
  streaming: true,
  confirmNewSites: false,
  permissionMode: "ask",
  planApproval: false,
  pauseOnDomainChange: false,
  confirmTools: [],
  soundOnComplete: true,
  notifyOnComplete: true,
  nativeHost: false,
  desktopBridge: true,
  autoUpdate: true,
  updateChannel: "stable",
  githubUpdateToken: "",
  speakReplies: false,
  voiceEngine: "auto",
  voiceLang: "en-US",
  voiceMethod: "",
  approvedHosts: [],
  systemPromptExtra: "",
  allowedDomains: [],
  blockedDomains: [],
  autoGroupTabs: true,
  groupTitle: "Akron",
  orchestrator: {
    enabled: false,
    endpoints: [],
    maxAttempts: 200,
    cooldownSeconds: 60,
  },
};

export async function getProviders() {
  const r = await chrome.storage.local.get(PROVIDERS_KEY);
  return Array.isArray(r[PROVIDERS_KEY]) ? r[PROVIDERS_KEY] : [];
}

export async function saveProviders(list) {
  await chrome.storage.local.set({ [PROVIDERS_KEY]: list });
}

const FORMER_GROUP_TITLE = "Autobot";

export async function getSettings() {
  const r = await chrome.storage.local.get(SETTINGS_KEY);
  const raw = r[SETTINGS_KEY] || {};
  const cleaned = stripStepCaps(raw);
  if (JSON.stringify(raw) !== JSON.stringify(cleaned)) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, ...cleaned } });
  }
  if (cleaned.permissionMode === "listed" || cleaned.permissionMode == null) {
    cleaned.permissionMode = "ask";
  }
  // A saved tab group name that is still the old product name follows the rename.
  if (cleaned.groupTitle === FORMER_GROUP_TITLE) cleaned.groupTitle = DEFAULT_SETTINGS.groupTitle;
  const merged = { ...DEFAULT_SETTINGS, ...cleaned };
  // Never hand out references to the default arrays.
  for (const key of ["confirmTools", "approvedHosts", "allowedDomains", "blockedDomains"]) {
    merged[key] = Array.isArray(merged[key]) ? [...merged[key]] : [];
  }
  const orch = merged.orchestrator || {};
  merged.orchestrator = {
    ...DEFAULT_SETTINGS.orchestrator,
    ...orch,
    endpoints: Array.isArray(orch.endpoints)
      ? orch.endpoints.map((e) => ({ ...e }))
      : [],
  };
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: stripStepCaps({ ...DEFAULT_SETTINGS, ...settings }),
  });
}

async function readConversationKey(key) {
  const r = await chrome.storage.local.get(key);
  return Array.isArray(r[key]) ? r[key] : [];
}

export function sessionConversationKey(sessionId) {
  return sessionId && sessionId !== "default"
    ? `${CONVERSATION_KEY}_${sessionId}`
    : CONVERSATION_KEY;
}

export async function getSessionConversation(sessionId = "default") {
  return readConversationKey(sessionConversationKey(sessionId));
}

export async function saveSessionConversation(sessionId, messages) {
  await chrome.storage.local.set({
    [sessionConversationKey(sessionId)]: stripForStorage(messages),
  });
}

export async function clearSessionConversation(sessionId = "default") {
  await chrome.storage.local.remove(sessionConversationKey(sessionId));
}

export async function getConversation() {
  return readConversationKey(CONVERSATION_KEY);
}

// Images are large; don't persist them across service-worker restarts.
function stripForStorage(messages) {
  const trimmed = messages.slice(-60);
  return trimmed.map((m) => {
    if (!m || typeof m !== "object") return m;
    const copy = { ...m };
    delete copy.image;
    delete copy.images;
    if (typeof copy.content === "string" && copy.content.length > 100000) {
      copy.content = copy.content.slice(0, 100000) + "\n…(truncated)";
    }
    return copy;
  });
}

export async function saveConversation(messages) {
  await chrome.storage.local.set({
    [CONVERSATION_KEY]: stripForStorage(messages),
  });
}

export async function clearConversation() {
  await chrome.storage.local.remove(CONVERSATION_KEY);
}

/* --------------------------- productivity --------------------------- */

const SCHEDULES_KEY = "autobot_schedules";
const PROMPTS_KEY = "autobot_saved_prompts";
const SKILLS_KEY = "autobot_skills";

export const BUILTIN_SKILLS = [
  {
    id: "skill_forms",
    name: "Form filler",
    description: "Fill forms carefully and verify every field before submitting.",
    instructions:
      "When filling a form: read the page first, map each field to its label, use form_input for selects/checkboxes/radios, and re-read the page to verify values before submitting. Never submit a form that spends money or sends a message without asking.",
    enabled: false,
    builtin: true,
  },
  {
    id: "skill_research",
    name: "Research summarizer",
    description: "Read several tabs and produce a short, sourced summary.",
    instructions:
      "When researching: open the relevant tabs, read each with read_text, and produce a compact summary with a bullet per source including its URL. Prefer primary sources and say when something is uncertain.",
    enabled: false,
    builtin: true,
  },
  {
    id: "skill_qa",
    name: "Web app QA",
    description: "Exercise a flow, check console/network errors, and report findings.",
    instructions:
      "When testing a web app: walk the requested flow with real interactions, then call read_console_messages and read_network_requests to catch errors. Report each issue with the step that caused it and the exact error text.",
    enabled: false,
    builtin: true,
  },
];

export async function getSchedules() {
  const r = await chrome.storage.local.get(SCHEDULES_KEY);
  return Array.isArray(r[SCHEDULES_KEY]) ? r[SCHEDULES_KEY] : [];
}

export async function saveSchedules(list) {
  await chrome.storage.local.set({ [SCHEDULES_KEY]: list });
}

export async function getSavedPrompts() {
  const r = await chrome.storage.local.get(PROMPTS_KEY);
  return Array.isArray(r[PROMPTS_KEY]) ? r[PROMPTS_KEY] : [];
}

export async function saveSavedPrompts(list) {
  await chrome.storage.local.set({ [PROMPTS_KEY]: list });
}

export async function getSkills() {
  const r = await chrome.storage.local.get(SKILLS_KEY);
  const stored = Array.isArray(r[SKILLS_KEY]) ? r[SKILLS_KEY] : [];
  if (!stored.length) return BUILTIN_SKILLS.map((s) => ({ ...s }));
  // Merge built-ins so new ones appear, keeping user edits/enabled state.
  const byId = new Map(stored.map((s) => [s.id, s]));
  const merged = BUILTIN_SKILLS.map((b) => ({ ...b, ...(byId.get(b.id) || {}) }));
  for (const s of stored) if (!merged.some((m) => m.id === s.id)) merged.push(s);
  return merged;
}

export async function saveSkills(list) {
  await chrome.storage.local.set({ [SKILLS_KEY]: list });
}

export function makeId(prefix = "p") {
  const rand =
    globalThis.crypto && crypto.randomUUID
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}_${rand}`;
}
