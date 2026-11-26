import { getProviders } from "../background/storage.js";
import { panelPath } from "../shared/panel.js";

const $ = (id) => document.getElementById(id);

function openSettings() {
  chrome.runtime.openOptionsPage();
}

async function refreshStatus() {
  let providers = [];
  try {
    providers = await getProviders();
  } catch {}

  const ready = providers.some(
    (p) =>
      p.apiKey ||
      (p.requiresKey !== true &&
        /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(p.baseUrl || ""))
  );
  const status = $("status");
  status.classList.toggle("ready", ready);
  if (ready) {
    $("status-text").textContent = `${providers.length} provider${
      providers.length === 1 ? "" : "s"
    } configured. You're ready to go.`;
  } else if (providers.length) {
    $("status-text").textContent =
      "A provider exists but has no API key yet. Open settings to finish it.";
  } else {
    $("status-text").textContent = "No provider yet. Add your first API key to get started.";
  }
}

$("open-settings").addEventListener("click", openSettings);
$("open-settings-2").addEventListener("click", openSettings);
$("open-panel").addEventListener("click", async () => {
  try {
    // The panel belongs to a tab; here that is this welcome tab.
    const tab = await chrome.tabs.getCurrent();
    if (!Number.isInteger(tab?.id)) throw new Error("this tab could not be found");
    await chrome.sidePanel.setOptions({ tabId: tab.id, path: panelPath(tab.id), enabled: true });
    await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) {
    alert(`Could not open the side panel: ${e?.message || e}`);
  }
});
$("done").addEventListener("click", () => window.close());

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.autobot_providers) refreshStatus();
});

refreshStatus();
