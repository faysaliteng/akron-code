// Shared "run one task" helper used by scheduled tasks and the side panel.
// Keeps provider/model/skill resolution in one place.

import { getProviders, getSettings, getSkills } from "./storage.js";
import { runTurn } from "./agent.js";
import { describeTaskTabs } from "./tools.js";
import { isLocalBaseUrl } from "../shared/presets.js";
import { buildEndpointPool } from "./orchestrator.js";

export function resolveProvider(providers, settings) {
  return providers.find((p) => p.id === settings.activeProviderId) || providers[0] || null;
}

export async function resolveRunConfig(settingsOverride = {}) {
  const settings = { ...(await getSettings()), ...settingsOverride };
  const providers = await getProviders();
  const endpoints = buildEndpointPool(providers, settings);

  if (!endpoints.length) {
    if (!providers.length) throw new Error("No provider configured. Add an API key in Settings.");
    if (settings.orchestrator?.enabled) {
      throw new Error(
        "Orchestrator mode has no usable endpoints. Select models in Settings → Orchestrator and make sure those providers have API keys."
      );
    }
    const provider = resolveProvider(providers, settings);
    if (!provider) throw new Error("No provider configured. Add an API key in Settings.");
    if (!provider.apiKey && (provider.requiresKey === true || !isLocalBaseUrl(provider.baseUrl))) {
      throw new Error(`Provider "${provider.name || provider.type}" has no API key.`);
    }
    throw new Error("No model selected. Open Settings and choose one.");
  }

  const provider = resolveProvider(providers, settings) || endpoints[0].providerConfig;
  const model = endpoints[0].model;

  const skills = await getSkills();
  settings.activeSkills = skills
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, description: s.description, instructions: s.instructions }));

  return { settings, provider, model, endpoints };
}

export async function runTask({
  text,
  tabId,
  conversation = [],
  emit = () => {},
  settingsOverride = {},
  signal,
}) {
  const { settings, provider, model, endpoints } = await resolveRunConfig(settingsOverride);
  const conv = conversation;
  conv.push({ role: "user", content: String(text || "") });

  const controller = new AbortController();
  const composed = signal
    ? AbortSignal.any
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal
    : controller.signal;

  await runTurn({
    conversation: conv,
    settings,
    providerConfig: provider,
    model,
    endpoints,
    tabId,
    signal: composed,
    emit,
    describeTabs: describeTaskTabs,
    // Unattended runs cannot show a confirmation modal, so gated tools are
    // denied rather than silently allowed.
    confirm: async ({ name }) =>
      !Array.isArray(settings.confirmTools) || !settings.confirmTools.includes(name),
  });

  return {
    conversation: conv,
    settings,
    provider,
    model,
    endpoints,
    stop: () => controller.abort(),
  };
}
