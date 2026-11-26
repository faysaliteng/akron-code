// The side panel belongs to one tab, like Claude's. The worker, the panel page
// and the welcome page share these pieces to open it, find it and close it.

export const PANEL_PAGE = "sidepanel/sidepanel.html";
export const CLOSE_PANEL_MESSAGE = "autobot_close_panel";

/** The address of the panel page for one tab. */
export function panelPath(tabId) {
  return `${PANEL_PAGE}?tabId=${encodeURIComponent(tabId)}`;
}

/**
 * The tab a panel page was opened for.
 * @param {string} url the page's address
 * @returns {number|null} null when the address names no tab
 */
export function panelTabId(url) {
  let raw = null;
  try {
    raw = new URL(String(url), "chrome-extension://panel/").searchParams.get("tabId");
  } catch {
    return null;
  }
  // Number(null) and Number("") are 0, which is not a tab.
  if (raw == null || raw.trim() === "") return null;
  const id = Number(raw);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

/** Whether one of the open panels (from chrome.runtime.getContexts) is this tab's. */
export function isPanelOpenFor(contexts, tabId) {
  if (!Number.isInteger(tabId)) return false;
  return (contexts || []).some((context) => panelTabId(context?.documentUrl) === tabId);
}
