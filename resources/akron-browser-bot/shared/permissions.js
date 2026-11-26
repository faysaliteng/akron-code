/** Side-panel permission policy. Ask is the default. Skip never pauses. */

export const ACTION_TOOLS = new Set([
  "click",
  "type",
  "press_key",
  "scroll",
  "navigate",
  "open_tab",
  "switch_tab",
  "go_back",
  "go_forward",
  "form_input",
  "hover",
  "drag",
  "upload_image",
  "file_upload",
  "computer",
  "shortcut",
  "execute_javascript",
  "write_clipboard",
]);

const LABELS = {
  click: "click",
  type: "type",
  press_key: "press a key",
  scroll: "scroll",
  navigate: "open a page",
  open_tab: "open a tab",
  switch_tab: "switch tabs",
  go_back: "go back",
  go_forward: "go forward",
  form_input: "fill a field",
  hover: "hover",
  drag: "drag",
  upload_image: "upload an image",
  file_upload: "upload a file",
  computer: "use the page",
  shortcut: "press a shortcut",
  execute_javascript: "run JavaScript",
  write_clipboard: "write to the clipboard",
};

export function actionLabel(name) {
  return LABELS[name] || String(name || "act").replaceAll("_", " ");
}

export function normalizePermissionMode(mode) {
  return mode === "skip" ? "skip" : "ask";
}

export function hostIsApproved(host, settings) {
  const name = String(host || "").toLowerCase();
  if (!name) return false;
  const list = Array.isArray(settings?.approvedHosts) ? settings.approvedHosts : [];
  return list.some((entry) => {
    const pattern = String(entry || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!pattern) return false;
    return name === pattern || name.endsWith(`.${pattern}`);
  });
}

export function actionNeedsPrompt(name, settings, host) {
  if (!ACTION_TOOLS.has(name)) return false;
  if (normalizePermissionMode(settings?.permissionMode) === "skip") return false;
  if (hostIsApproved(host, settings)) return false;
  return true;
}
