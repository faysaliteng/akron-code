// Browser tools exposed to the model, plus their execution in the service worker.
// Page-level actions are delegated to the content script (content/agent-overlay.js).
// Trusted input, element screenshots and full-page capture go through CDP (cdp.js).

import * as cdp from "./cdp.js";
import { actionLabel, actionNeedsPrompt, normalizePermissionMode } from "../shared/permissions.js";
import {
  startRecording as gifStart,
  stopRecording as gifStop,
  exportRecording as gifExport,
  clearRecording as gifClear,
  recordingStatus as gifStatus,
} from "./gif.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const TOOL_DEFS = [
  {
    name: "read_page",
    description:
      "Get a fresh accessibility snapshot of the current tab. Returns elements with refs like [ref=e12]. Refs are only valid for the most recent snapshot. filter \"interactive\" (default) keeps controls in view; \"all\" includes the rest of the page. Use ref to read one element and its children, depth to limit the tree, and maxChars to raise the character cap (default 50000).",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "string", enum: ["interactive", "all"] },
        ref: { type: "string", description: "Read this element and its children." },
        depth: { type: "number", description: "Maximum tree depth (default 15)." },
        maxChars: { type: "number", description: "Output character limit (default 50000)." },
      },
      required: [],
    },
  },
  {
    name: "read_text",
    description:
      "Get the visible plain text of the current page (cheap alternative to read_page when you only need to read content).",
    parameters: {
      type: "object",
      properties: {
        maxChars: {
          type: "number",
          description: "Maximum characters to return (default 50000). Extra text is cut on a line boundary.",
        },
      },
      required: [],
    },
  },
  {
    name: "click",
    description:
      "Click an element from the latest read_page snapshot by its ref (for example e12).",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref, e.g. e12." },
      },
      required: ["ref"],
    },
  },
  {
    name: "type",
    description:
      "Focus an input/textarea/contenteditable from the latest snapshot and type text into it.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref, e.g. e12." },
        text: { type: "string", description: "Text to type." },
        clear: {
          type: "boolean",
          description: "Clear existing value first (default true).",
        },
        submit: {
          type: "boolean",
          description: "Press Enter / submit the form after typing.",
        },
      },
      required: ["ref", "text"],
    },
  },
  {
    name: "press_key",
    description: "Send a keyboard key to the focused element (Enter, Tab, Escape, ArrowDown, ...).",
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the page or an element.",
    parameters: {
      type: "object",
      properties: {
        direction: {
          type: "string",
          enum: ["up", "down", "top", "bottom"],
        },
        amount: {
          type: "number",
          description: "Pixels to scroll (default 600).",
        },
        ref: {
          type: "string",
          description: "Optional element ref to scroll within.",
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "navigate",
    description: "Navigate the current tab to a URL.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "open_tab",
    description:
      "Open a URL in a new tab and make it the target of your next actions. The tab opens in the background when the user is looking at a different tab.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        active: { type: "boolean", description: "Bring the new tab to the front (default true). Ignored while the user is on another tab." },
      },
      required: ["url"],
    },
  },
  {
    name: "list_tabs",
    description:
      "List the tabs you can work in (the current tab and the other tabs in your group) with their ids, titles and URLs. The user's other tabs are not listed and cannot be used.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "switch_tab",
    description:
      "Make another tab of your group (by id, from list_tabs) the target of your next actions. It is also brought to the front unless the user is looking at a different tab. Tabs outside your group are refused: open the site with open_tab instead.",
    parameters: {
      type: "object",
      properties: { tabId: { type: "number" } },
      required: ["tabId"],
    },
  },
  {
    name: "go_back",
    description: "Go back in the current tab's history.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "go_forward",
    description: "Go forward in the current tab's history.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "screenshot",
    description:
      "Capture the visible area of the current tab, a specific element, or the whole page. The image is shown to the user; include it in your reasoning only if vision is enabled.",
    parameters: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Optional element ref from read_page to capture just that element.",
        },
        fullPage: {
          type: "boolean",
          description: "Capture the entire scrollable page instead of the viewport.",
        },
      },
      required: [],
    },
  },
  {
    name: "wait",
    description: "Wait for a number of milliseconds (useful after actions that trigger async loading).",
    parameters: {
      type: "object",
      properties: { ms: { type: "number" } },
      required: ["ms"],
    },
  },
  {
    name: "find",
    description:
      "Search the page for visible elements and visible text by text or role instead of dumping the whole page. Returns matching controls, and text that is not inside a control (a row of a list, a table cell, a heading), with fresh refs you can pass to click/type/form_input.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text to look for in the element's name, label or visible text (case-insensitive).",
        },
        role: {
          type: "string",
          description:
            "Optional ARIA/HTML role to filter by: button, link, textbox, checkbox, radio, combobox, menuitem, tab, …",
        },
        max: { type: "number", description: "Maximum matches to return (default 40)." },
      },
      required: [],
    },
  },
  {
    name: "form_input",
    description:
      "Set the value of a form control by ref: text inputs, textareas, selects (matches option by value or label), checkboxes/radios (true/false), date/number/range/color inputs. Prefer this over type for non-text fields.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Element ref, e.g. e12." },
        value: {
          description:
            "New value. Use a string for text/select/date fields, or true/false for checkboxes and radios.",
        },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "hover",
    description: "Move the pointer over an element (reveals tooltips, menus, hover-only controls).",
    parameters: {
      type: "object",
      properties: { ref: { type: "string" } },
      required: ["ref"],
    },
  },
  {
    name: "drag",
    description: "Drag one element onto another (sliders, kanban cards, drag-and-drop upload zones).",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Ref of the element to drag." },
        to: { type: "string", description: "Ref of the drop target." },
      },
      required: ["from", "to"],
    },
  },
  {
    name: "upload_image",
    description:
      "Attach file(s) to a file input by ref. Provide each file as a data URL (dataUrl), a public URL (url), or literal text (text).",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref of the <input type=file> element." },
        files: {
          type: "array",
          description: "Files to attach.",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              mimeType: { type: "string" },
              dataUrl: { type: "string", description: "data:...;base64,... payload." },
              url: { type: "string", description: "http(s) URL to download from." },
              text: { type: "string", description: "Literal text content." },
            },
          },
        },
      },
      required: ["ref", "files"],
    },
  },
  {
    name: "read_console_messages",
    description:
      "Read console log/warn/error messages the page produced. Useful for debugging why an action failed.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent messages (default 100, max 300)." },
      },
      required: [],
    },
  },
  {
    name: "read_network_requests",
    description:
      "Read recent fetch/XHR requests the page made (method, status, URL, duration). Useful for verifying an API call succeeded.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "number", description: "How many recent requests (default 100, max 300)." },
      },
      required: [],
    },
  },
  {
    name: "resize_window",
    description: "Resize the browser window (useful for testing responsive layouts).",
    parameters: {
      type: "object",
      properties: {
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["width", "height"],
    },
  },
  {
    name: "group_tabs",
    description: "Put tabs into a named, colour-coded tab group.",
    parameters: {
      type: "object",
      properties: {
        tabIds: { type: "array", items: { type: "number" } },
        title: { type: "string" },
        color: {
          type: "string",
          enum: ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"],
        },
      },
      required: ["tabIds"],
    },
  },
  {
    name: "ungroup_tabs",
    description: "Remove tabs from their tab group.",
    parameters: {
      type: "object",
      properties: { tabIds: { type: "array", items: { type: "number" } } },
      required: ["tabIds"],
    },
  },
  {
    name: "update_plan",
    description:
      "Publish a short step-by-step plan for a multi-step task. Call it at the start of a task and again whenever the plan changes; the user sees it in the side panel.",
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "string" },
          description: "Ordered list of steps, each a short imperative sentence.",
        },
        status: {
          type: "string",
          enum: ["planning", "in_progress", "done"],
          description: "Overall plan status (default in_progress).",
        },
      },
      required: ["steps"],
    },
  },
  {
    name: "browser_batch",
    description:
      "Run several page actions in one call, sequentially, and get all results back. Use for short repetitive sequences (e.g. fill 6 fields then click Submit). Each action is {name, args} using the same tool names.",
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              args: { type: "object" },
            },
            required: ["name"],
          },
        },
      },
      required: ["actions"],
    },
  },
  {
    name: "computer",
    description:
      "Control the page with trusted, real mouse and keyboard events (via Chrome DevTools Protocol). Use this when a site ignores synthetic clicks, needs a right-click context menu, double-click, hover menu, drag, or a precise element/full-page screenshot. Coordinates are CSS pixels in the viewport, with origin at the top-left. You can pass a ref from read_page instead of a coordinate.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "screenshot",
            "left_click",
            "right_click",
            "middle_click",
            "double_click",
            "triple_click",
            "hover",
            "left_click_drag",
            "scroll_to",
            "zoom",
            "type",
            "key",
            "scroll",
            "wait",
          ],
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          description: "[x, y] viewport coordinate.",
        },
        start_coordinate: {
          type: "array",
          items: { type: "number" },
          description: "Start [x, y] for left_click_drag.",
        },
        ref: { type: "string", description: "Element ref from read_page (alternative to coordinate)." },
        text: { type: "string", description: "Text for the type action, or a key chord for the key action (for example Enter or ctrl+a)." },
        region: {
          type: "array",
          items: { type: "number" },
          description: "Zoom rectangle as x, y, width, height in CSS pixels.",
        },
        keys: {
          type: "array",
          items: { type: "string" },
          description: "Key combos for the key action, e.g. [\"ctrl+a\", \"Backspace\"].",
        },
        scroll_direction: { type: "string", enum: ["up", "down", "left", "right"] },
        scroll_amount: { type: "number", description: "Scroll steps (default 3)." },
        duration: { type: "number", description: "Milliseconds to wait (wait action)." },
        full_page: { type: "boolean", description: "Capture the whole page (screenshot action)." },
      },
      required: ["action"],
    },
  },
  {
    name: "shortcut",
    description:
      "Press one or more keyboard shortcuts as trusted key events, in order. Example: keys [\"ctrl+t\"] opens a new tab; [\"ctrl+a\",\"Backspace\"] selects all and deletes. Optionally type text afterwards.",
    parameters: {
      type: "object",
      properties: {
        keys: { type: "array", items: { type: "string" } },
        text: { type: "string", description: "Text to insert after the shortcuts." },
      },
      required: ["keys"],
    },
  },
  {
    name: "file_upload",
    description:
      "Attach files to a file input or a drag-and-drop drop zone. Each file can be a data URL, an http(s) URL, or literal text. Use drop_ref for a non-input drop zone.",
    parameters: {
      type: "object",
      properties: {
        ref: { type: "string", description: "Ref of the <input type=file> element." },
        drop_ref: { type: "string", description: "Ref of a drop zone (if not a file input)." },
        files: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              mimeType: { type: "string" },
              dataUrl: { type: "string" },
              url: { type: "string" },
              text: { type: "string" },
            },
          },
        },
      },
      required: ["files"],
    },
  },
  {
    name: "gif_creator",
    description:
      "Record the visible tab as an animated GIF of what the agent is doing. Call start, perform the actions, then export. Frames are captured about twice a second. Use clear to discard without exporting.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "stop", "export", "clear", "status"] },
        interval_ms: {
          type: "number",
          description: "Milliseconds between frames (min 600, default 600).",
        },
        delay_ms: {
          type: "number",
          description: "Playback delay per frame in milliseconds (default = capture interval).",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "execute_javascript",
    description:
      "Run arbitrary JavaScript in the page's main world and return the JSON value it produces. Use to read or change page state the other tools cannot reach. The expression may use await; anything returned is serialized as the result.",
    parameters: {
      type: "object",
      properties: {
        code: {
          type: "string",
          description:
            "JavaScript to evaluate. Wrap async work in (async () => { ... })() and return a value.",
        },
        await_promise: {
          type: "boolean",
          description: "Await the result if the code returns a Promise (default true).",
        },
      },
      required: ["code"],
    },
  },
  {
    name: "read_clipboard",
    description:
      "Read text from the system clipboard. Returns the clipboard text, or an error if the browser blocks it.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "write_clipboard",
    description: "Write text to the system clipboard.",
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    },
  },
  {
    name: "load_skill",
    description: "Load the full instructions for one enabled skill by name. Use this after the skill catalog in the system prompt matches the task.",
    parameters: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "save_skill",
    description: "Propose a new skill or an update to an existing one. The user must approve before it is stored.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        instructions: { type: "string" },
      },
      required: ["name", "instructions"],
    },
  },
  {
    name: "save_result",
    description:
      "Save one thing the user asked you to collect (an API key, a link, a code, a price) the moment you have it, or record that one could not be collected and why. Saved results are kept for the whole task, even when older page reads are shortened, and the user is shown all of them at the end. Call it once per result, before you move on.",
    parameters: {
      type: "object",
      properties: {
        label: { type: "string", description: 'What it is and where it is from, for example "Cohere API key".' },
        value: { type: "string", description: "The exact value, copied character for character. Leave empty when it could not be collected." },
        note: { type: "string", description: "Why it could not be collected, or anything the user should know about it." },
      },
      required: ["label"],
    },
  },
];

const RESTRICTED =/^(chrome|edge|about|devtools|view-source|brave|chrome-extension):/i;

/* --------------------------- domain policy --------------------------- */

function domainMatches(host, pattern) {
  const p = String(pattern || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!p) return false;
  if (p === "*") return true;
  const h = String(host || "").toLowerCase();
  if (p.startsWith("*.")) {
    const base = p.slice(2);
    return h === base || h.endsWith("." + base);
  }
  return h === p || h.endsWith("." + p);
}

/**
 * Returns true if the agent is allowed to touch this URL under the user's
 * allow/block lists. Empty allow list = everything not blocked.
 */
export function normalizeNavigationTarget(raw) {
  const url = String(raw || "").trim();
  const lower = url.toLowerCase();
  if (lower === "back" || lower === "forward") return { history: lower };
  if (/^https?:\/\//i.test(url)) return { url };
  if (/^[\w.-]+\.[a-z]{2,}([/:?#].*)?$/i.test(url)) return { url: `https://${url}` };
  return { error: "URL must start with http:// or https://." };
}

export function hostAllowed(url, settings = {}) {
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host) return false;

  const blocked = Array.isArray(settings.blockedDomains) ? settings.blockedDomains : [];
  const allowed = Array.isArray(settings.allowedDomains) ? settings.allowedDomains : [];

  if (blocked.some((p) => domainMatches(host, p))) return false;
  if (settings.permissionMode === "skip") return true;
  if (allowed.length && !allowed.some((p) => domainMatches(host, p))) return false;
  return true;
}

function assertUrlAllowed(url, ctx) {
  if (!hostAllowed(url, ctx?.settings || {})) {
    throw new Error(
      `Blocked by your domain policy: ${url}. Change the allow/block lists in Settings if this was intentional.`
    );
  }
}

async function assertTabAllowed(tabId, ctx) {
  const tab = await getTab(tabId);
  if (!tab) throw new Error("Tab not found.");
  if (tab.url && !RESTRICTED.test(tab.url)) assertUrlAllowed(tab.url, ctx);
  return tab;
}

// Tools that read or manipulate the page in the current tab.
const PAGE_TOOLS = new Set([
  "read_page",
  "read_text",
  "click",
  "type",
  "press_key",
  "scroll",
  "find",
  "form_input",
  "hover",
  "drag",
  "upload_image",
  "read_console_messages",
  "read_network_requests",
  "screenshot",
  "computer",
  "shortcut",
  "file_upload",
  "gif_creator",
  "execute_javascript",
  "read_clipboard",
  "write_clipboard",
]);


// Tools that look at the page as pixels or click it by position. Akron's own
// frame, banner and Stop button are taken off the page while these run, so the
// model does not see them and a click cannot land on Stop.
const OVERLAY_HIDDEN_TOOLS = new Set(["screenshot", "computer"]);
const overlayHiddenTabs = new Set();

export function isOverlayHidden(tabId) {
  return overlayHiddenTabs.has(tabId);
}

async function setOverlayHidden(tabId, hidden) {
  if (hidden) overlayHiddenTabs.add(tabId);
  else overlayHiddenTabs.delete(tabId);
  try {
    await chrome.tabs.sendMessage(tabId, { channel: "autobot", cmd: "overlay_hidden", args: { hidden } });
  } catch {
    // No page script on this tab (a browser page, or not loaded yet): nothing to hide.
  }
}

async function sendToTab(tabId, cmd, args = {}) {
  const message = { channel: "autobot", cmd, args };
  try {
    const res = await chrome.tabs.sendMessage(tabId, message);
    if (res) return res;
  } catch {
    // content script not present yet — inject and retry
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content/agent-overlay.js"],
    });
    const res = await chrome.tabs.sendMessage(tabId, message);
    if (res) return res;
  } catch (e) {
    throw new Error(
      `Cannot access this page (${e?.message || e}). Browser internal pages, the Web Store, and PDF viewers cannot be automated.`
    );
  }
  throw new Error("No response from the page.");
}

async function getTab(tabId) {
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function waitForLoad(tabId, timeout = 15000) {
  const start = Date.now();
  await sleep(200);
  while (Date.now() - start < timeout) {
    const tab = await getTab(tabId);
    if (!tab) return;
    if (tab.status === "complete") return;
    await sleep(250);
  }
}

function ok(text, extra = {}) {
  return { text, ...extra };
}

const BACKGROUND_CAPTURE_TIMEOUT_MS = 10000;

/**
 * Several tabs can each have a task running while the user looks at only one.
 * Tells whether this task's own tab is the one on screen in its window, and
 * whether that window has the user's focus. When the tab cannot be looked up
 * the task is treated as on screen, which is the single-task behaviour.
 */
async function taskView(tabId) {
  const tab = await getTab(tabId);
  if (!tab) return { visible: true, focused: true };
  if (!tab.active) return { visible: false, focused: false };
  try {
    const win = await chrome.windows.get(tab.windowId);
    return { visible: true, focused: win?.focused !== false };
  } catch {
    return { visible: true, focused: true };
  }
}

/** Captures a tab that is not on screen, where captureVisibleTab would show another tab. */
async function captureBackgroundTab(tabId) {
  const wasAttached = cdp.isAttached(tabId);
  await cdp.attach(tabId);
  let timer = null;
  try {
    const timedOut = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Could not capture this tab while it is in the background.")),
        BACKGROUND_CAPTURE_TIMEOUT_MS
      );
    });
    return await Promise.race([cdp.captureScreenshot(tabId), timedOut]);
  } finally {
    clearTimeout(timer);
    if (!wasAttached) await cdp.detach(tabId).catch(() => {});
  }
}

async function pageHost(ctx) {
  if (ctx?.host) return ctx.host;
  try {
    const tab = await chrome.tabs.get(ctx?.tabId);
    return new URL(tab?.url || "").hostname;
  } catch {
    return "";
  }
}

/**
 * The tab a task acts on and the other tabs of its group, for the prompt.
 * @param {{ tabId: number }} where
 * @returns {Promise<{ current: object, others: object[] } | null>} null when the tab is gone
 */
const isGroupId = (id) => Number.isInteger(id) && id !== -1;

// The agent gives every task the list of tabs it has been on (taskTabIds). A
// direct tool call from the native bridge has no task and is not confined.
const isTask = (ctx) => Array.isArray(ctx?.taskTabIds);

// Like Claude's extension, a task works only in its own tabs: the tab it is
// on, the tabs grouped with it, and the tabs it has been on or opened itself.
// Every other tab is the user's and stays out of reach.
async function taskTabs({ tabId, groupId, taskTabIds = [] }) {
  const current = await chrome.tabs.get(tabId).catch(() => null);
  const groupIds = [...new Set([groupId, current?.groupId].filter(isGroupId))];
  const grouped = await Promise.all(
    groupIds.map((id) => chrome.tabs.query({ groupId: id }).catch(() => []))
  );
  const own = await Promise.all(
    taskTabIds.filter(Number.isInteger).map((id) => chrome.tabs.get(id).catch(() => null))
  );
  const byId = new Map();
  for (const tab of [current, ...grouped.flat(), ...own]) {
    if (tab && Number.isInteger(tab.id) && !byId.has(tab.id)) byId.set(tab.id, tab);
  }
  return { current, tabs: [...byId.values()] };
}

export async function describeTaskTabs({ tabId, groupId, taskTabIds }) {
  const { current, tabs } = await taskTabs({ tabId, groupId, taskTabIds: taskTabIds || [] });
  if (!current) return null;
  return { current, others: tabs.filter((tab) => tab.id !== current.id) };
}

export async function executeTool(name, args, ctx) {
  if (typeof globalThis.__autobotToolOverride === "function") {
    return globalThis.__autobotToolOverride(name, args, ctx);
  }
  const tabId = ctx.tabId;

  if (name === "file_upload" && Array.isArray(args?.paths) && args.paths.length) {
    throw new Error("file_upload does not accept local paths. Pass file contents in files.");
  }

  // Ask before acting, unless this site was always-allowed or the mode is skip.
  if (ctx?.confirm && actionNeedsPrompt(name, ctx.settings, await pageHost(ctx))) {
    const host = await pageHost(ctx);
    const decision = await ctx.confirm({
      kind: "action",
      name,
      args,
      host,
      message: `Akron wants to ${actionLabel(name)}:`,
    });
    const approved = decision === true || decision?.approved === true;
    if (!approved) throw new Error("The user declined this action.");
    if (decision?.scope === "always" && host && typeof ctx.grantHost === "function") {
      await ctx.grantHost(host);
      ctx.settings = ctx.settings || {};
      const hosts = new Set([...(ctx.settings.approvedHosts || []), host]);
      ctx.settings.approvedHosts = [...hosts];
    }
  } else if (
    ctx?.confirm &&
    Array.isArray(ctx.settings?.confirmTools) &&
    ctx.settings.confirmTools.includes(name)
  ) {
    const approved = await ctx.confirm({ name, args });
    if (approved !== true && approved?.approved !== true) throw new Error("The user declined this action.");
  }

  // Domain policy: page-touching tools refuse URLs the user has blocked (or
  // that fall outside a non-empty allow list).
  if (PAGE_TOOLS.has(name)) {
    await assertTabAllowed(tabId, ctx);
  }

  if (!OVERLAY_HIDDEN_TOOLS.has(name)) return runTool(name, args, ctx);
  await setOverlayHidden(tabId, true);
  let out = null;
  try {
    out = await runTool(name, args, ctx);
    return out;
  } finally {
    await setOverlayHidden(tabId, false);
    // The overlay is back: show where the action just happened.
    if (out?.pointer) showPointer(tabId, out.pointer);
  }
}

// Moves the agent's pointer on the page to a point it acted on by position.
function showPointer(tabId, pointer) {
  chrome.tabs
    .sendMessage(tabId, { channel: "autobot", cmd: "pointer", args: pointer })
    .catch(() => {});
}

async function runTool(name, args, ctx) {
  const tabId = ctx.tabId;

  switch (name) {
    case "read_page": {
      const res = await sendToTab(tabId, "snapshot", {
        filter: args?.filter,
        depth: args?.depth,
        refId: args?.ref || args?.ref_id,
        maxChars: Number(args?.maxChars || args?.max_chars) || 50000,
      });
      if (!res.ok) throw new Error(res.error || "Snapshot failed");
      return ok(res.result);
    }
    case "read_text": {
      const res = await sendToTab(tabId, "read_text", {
        maxChars: Number(args?.maxChars || args?.max_chars) || 50000,
      });
      if (!res.ok) throw new Error(res.error || "read_text failed");
      return ok(res.result);
    }
    case "click": {
      const res = await sendToTab(tabId, "click", { ref: args?.ref });
      if (!res.ok) throw new Error(res.error || "click failed");
      await sleep(150);
      return ok(res.result);
    }
    case "type": {
      const res = await sendToTab(tabId, "type", {
        ref: args?.ref,
        text: args?.text ?? "",
        clear: args?.clear !== false,
        submit: !!args?.submit,
      });
      if (!res.ok) throw new Error(res.error || "type failed");
      await sleep(150);
      return ok(res.result);
    }
    case "press_key": {
      const res = await sendToTab(tabId, "press_key", { key: args?.key });
      if (!res.ok) throw new Error(res.error || "press_key failed");
      return ok(res.result);
    }
    case "scroll": {
      const res = await sendToTab(tabId, "scroll", {
        direction: args?.direction || "down",
        amount: Number(args?.amount) || 600,
        ref: args?.ref,
      });
      if (!res.ok) throw new Error(res.error || "scroll failed");
      return ok(res.result);
    }
    case "navigate": {
      const target = normalizeNavigationTarget(args?.url);
      if (target.error) throw new Error(target.error);
      if (target.history === "back") {
        await chrome.tabs.goBack(tabId).catch(() => {});
        await waitForLoad(tabId);
        const tab = await getTab(tabId);
        return ok(`Went back. Now at ${tab?.url || ""}`);
      }
      if (target.history === "forward") {
        await chrome.tabs.goForward(tabId).catch(() => {});
        await waitForLoad(tabId);
        const tab = await getTab(tabId);
        return ok(`Went forward. Now at ${tab?.url || ""}`);
      }
      const url = target.url;
      assertUrlAllowed(url, ctx);
      if (ctx?.settings?.pauseOnDomainChange && typeof ctx.confirm === "function") {
        const current = await getTab(tabId);
        let fromHost = "";
        let toHost = "";
        try {
          fromHost = new URL(current?.url || "").hostname;
          toHost = new URL(url).hostname;
        } catch {}
        if (fromHost && toHost && fromHost !== toHost) {
          const approved = await ctx.confirm({
            kind: "domain",
            name: "navigate",
            to: toHost,
            message: `Allow Akron to move from ${fromHost} to ${toHost}?`,
          });
          if (!approved) {
            throw new Error(`Navigation from ${fromHost} to ${toHost} was declined.`);
          }
        }
      }
      await chrome.tabs.update(tabId, { url });
      await waitForLoad(tabId);
      const tab = await getTab(tabId);
      return ok(`Navigated to ${tab?.url || url}\nTitle: ${tab?.title || ""}`);
    }
    case "open_tab": {
      const url = String(args?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("Only http(s) URLs are allowed.");
      }
      assertUrlAllowed(url, ctx);
      // A task the user is not watching must not pull the screen away from the
      // tab they are on (or from another task's tab).
      const view = await taskView(tabId);
      const createOptions = { url, active: view.visible && args?.active !== false };
      if (Number.isInteger(ctx?.windowId)) createOptions.windowId = ctx.windowId;
      const tab = await chrome.tabs.create(createOptions);
      if (ctx?.addToGroup) {
        try {
          await ctx.addToGroup(tab.id);
        } catch {}
      }
      await waitForLoad(tab.id);
      return ok(`Opened tab ${tab.id}: ${url}` + (ctx?.addToGroup ? " (added to the agent tab group)" : ""), { tabId: tab.id });
    }
    case "list_tabs": {
      const tabs = isTask(ctx)
        ? (await taskTabs({ tabId, groupId: ctx.groupId, taskTabIds: ctx.taskTabIds })).tabs
        : await chrome.tabs.query(
            Number.isInteger(ctx?.windowId) ? { windowId: ctx.windowId } : { currentWindow: true }
          );
      const lines = tabs
        .filter((t) => !RESTRICTED.test(t.url || ""))
        .map(
          (t) =>
            `${t.id === tabId ? "*" : " "} [${t.id}] ${t.active ? "(active) " : ""}${
              ctx?.groupId != null && t.groupId === ctx.groupId ? "[agent group] " : ""
            }${t.title || "(untitled)"} — ${t.url || ""}`
        );
      return ok(lines.join("\n") || "(no tabs)");
    }
    case "switch_tab": {
      const id = Number(args?.tabId);
      if (!Number.isInteger(id)) throw new Error("tabId must be an integer.");
      if (isTask(ctx)) {
        const mine = await taskTabs({ tabId, groupId: ctx.groupId, taskTabIds: ctx.taskTabIds });
        if (!mine.tabs.some((t) => t.id === id)) {
          throw new Error(
            `Tab ${id} is not one of your tabs. You can work only in the current tab and the tabs in your group: ${mine.tabs.map((t) => t.id).join(", ")}. To use another site, open it with open_tab.`
          );
        }
      }
      // Only a task the user is watching brings the tab to the front; a
      // background task just retargets its own actions.
      const view = await taskView(tabId);
      const tab = view.visible
        ? await chrome.tabs.update(id, { active: true })
        : await chrome.tabs.get(id);
      if (
        ctx?.addToGroup &&
        (!Number.isInteger(ctx.windowId) || tab?.windowId === ctx.windowId)
      ) {
        try {
          await ctx.addToGroup(id);
        } catch {}
      }
      if (view.focused && tab?.windowId != null) {
        try {
          await chrome.windows.update(tab.windowId, { focused: true });
        } catch {}
      }
      return ok(`Switched to tab ${id}: ${tab?.title || ""} — ${tab?.url || ""}`, {
        tabId: id,
      });
    }
    case "go_back": {
      await chrome.tabs.goBack(tabId).catch(() => {});
      await waitForLoad(tabId);
      const tab = await getTab(tabId);
      return ok(`Went back. Now at ${tab?.url || ""}`);
    }
    case "go_forward": {
      await chrome.tabs.goForward(tabId).catch(() => {});
      await waitForLoad(tabId);
      const tab = await getTab(tabId);
      return ok(`Went forward. Now at ${tab?.url || ""}`);
    }
    case "screenshot": {
      const tab = await getTab(tabId);
      if (!tab) throw new Error("Tab not found.");
      if (args?.ref || args?.fullPage) {
        await cdp.attach(tabId);
        try {
          const image = await cdp.captureScreenshot(tabId, {
            ref: args?.ref,
            fullPage: !!args?.fullPage,
          });
          return ok(
            args?.ref
              ? `Captured element ${args.ref}.`
              : "Captured the full page.",
            { image }
          );
        } finally {
          await cdp.detach(tabId).catch(() => {});
        }
      }
      // captureVisibleTab shows whatever tab is on screen. When this task's tab
      // is in the background that would be someone else's page.
      const dataUrl = tab.active === false
        ? await captureBackgroundTab(tabId)
        : await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
      return ok("Screenshot captured and shown to the user.", { image: dataUrl });
    }
    case "wait": {
      const ms = Math.max(0, Math.min(15000, Number(args?.ms) || 1000));
      await sleep(ms);
      return ok(`Waited ${ms} ms.`);
    }
    case "find": {
      const res = await sendToTab(tabId, "find", {
        query: args?.query,
        role: args?.role,
        max: args?.max,
      });
      if (!res.ok) throw new Error(res.error || "find failed");
      return ok(res.result);
    }
    case "form_input": {
      const res = await sendToTab(tabId, "form_input", {
        ref: args?.ref,
        value: args?.value,
      });
      if (!res.ok) throw new Error(res.error || "form_input failed");
      await sleep(120);
      return ok(res.result);
    }
    case "hover": {
      const res = await sendToTab(tabId, "hover", { ref: args?.ref });
      if (!res.ok) throw new Error(res.error || "hover failed");
      await sleep(120);
      return ok(res.result);
    }
    case "drag": {
      const res = await sendToTab(tabId, "drag", {
        from: args?.from,
        to: args?.to,
      });
      if (!res.ok) throw new Error(res.error || "drag failed");
      await sleep(150);
      return ok(res.result);
    }
    case "upload_image": {
      const res = await sendToTab(tabId, "upload", {
        ref: args?.ref,
        files: args?.files,
      });
      if (!res.ok) throw new Error(res.error || "upload failed");
      await sleep(150);
      return ok(res.result);
    }
    case "read_console_messages": {
      const res = await sendToTab(tabId, "read_console", {
        limit: args?.limit,
        pattern: args?.pattern,
        onlyErrors: args?.onlyErrors,
      });
      if (!res.ok) throw new Error(res.error || "read_console failed");
      return ok(res.result);
    }
    case "read_network_requests": {
      const res = await sendToTab(tabId, "read_network", {
        limit: args?.limit,
      });
      if (!res.ok) throw new Error(res.error || "read_network failed");
      return ok(res.result);
    }
    case "resize_window": {
      const width = Math.max(320, Math.min(3840, Number(args?.width) || 1280));
      const height = Math.max(240, Math.min(2160, Number(args?.height) || 800));
      const tab = await getTab(tabId);
      if (!tab || tab.windowId == null) throw new Error("Tab not found.");
      await chrome.windows.update(tab.windowId, { width, height });
      return ok(`Resized window to ${width}×${height}.`);
    }
    case "group_tabs": {
      const ids = (Array.isArray(args?.tabIds) ? args.tabIds : [])
        .map(Number)
        .filter(Number.isInteger);
      if (!ids.length) throw new Error("tabIds must be a non-empty array of integers.");
      const groupId = await chrome.tabs.group({ tabIds: ids });
      const update = {};
      if (args?.title) update.title = String(args.title).slice(0, 40);
      if (args?.color) update.color = args.color;
      if (Object.keys(update).length && chrome.tabGroups?.update) {
        await chrome.tabGroups.update(groupId, update);
      }
      return ok(`Grouped ${ids.length} tab(s) into group ${groupId}${args?.title ? ` ("${args.title}")` : ""}.`);
    }
    case "ungroup_tabs": {
      const ids = (Array.isArray(args?.tabIds) ? args.tabIds : [])
        .map(Number)
        .filter(Number.isInteger);
      if (!ids.length) throw new Error("tabIds must be a non-empty array of integers.");
      await chrome.tabs.ungroup(ids);
      return ok(`Removed ${ids.length} tab(s) from their group.`);
    }
    case "update_plan": {
      const steps = (Array.isArray(args?.steps) ? args.steps : [])
        .map((s) => String(s).trim())
        .filter(Boolean)
        .slice(0, 20);
      if (!steps.length) throw new Error("steps must be a non-empty array of strings.");
      const status = ["planning", "in_progress", "done"].includes(args?.status)
        ? args.status
        : "in_progress";
      const domains = (Array.isArray(args?.domains) ? args.domains : [])
        .map((domain) => String(domain).trim())
        .filter(Boolean);
      try {
        ctx?.emit?.({ type: "plan", steps, status, domains });
      } catch {}
      // The agent plans for itself. The plan is only put to the user when plan
      // approval is on, and never in "Act without asking" mode.
      const needsApproval =
        status !== "done" &&
        ctx?.settings?.planApproval !== false &&
        normalizePermissionMode(ctx?.settings?.permissionMode) !== "skip" &&
        typeof ctx?.confirm === "function";
      if (needsApproval) {
        const decision = await ctx.confirm({
          kind: "plan",
          name: "update_plan",
          steps,
          domains,
          message: `Approve this plan?\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}${
            domains.length ? `\nSites: ${domains.join(", ")}` : ""
          }`,
        });
        const approved = decision === true || decision?.approved === true;
        if (!approved) throw new Error("The user rejected the plan.");
        const edited = Array.isArray(decision?.steps)
          ? decision.steps.map((step) => String(step).trim()).filter(Boolean).slice(0, 20)
          : [];
        if (edited.length) {
          steps.splice(0, steps.length, ...edited);
          try {
            ctx?.emit?.({ type: "plan", steps, status, domains });
          } catch {}
        }
      }
      return ok(
        `Plan ${needsApproval ? "approved" : "published"} (${status}):\n${steps
          .map((step, index) => `${index + 1}. ${step}`)
          .join("\n")}`
      );
    }
    case "browser_batch": {
      const actions = Array.isArray(args?.actions) ? args.actions.slice(0, 25) : [];
      if (!actions.length) throw new Error("actions must be a non-empty array.");
      const lines = [];
      for (let i = 0; i < actions.length; i++) {
        const a = actions[i] || {};
        const childName = String(a.name || "");
        if (!childName) {
          lines.push(`${i + 1}. (skipped: missing name)`);
          continue;
        }
        if (childName === "browser_batch") {
          lines.push(`${i + 1}. ${childName}: error — nested batches are not allowed`);
          const rest = actions.length - i - 1;
          if (rest) lines.push(`${rest} later action(s) were not run.`);
          break;
        }
        try {
          const out = await executeTool(childName, a.args || {}, ctx);
          if (out && Number.isInteger(out.tabId)) ctx.tabId = out.tabId;
          lines.push(`${i + 1}. ${childName}: ok — ${String(out.text || "").slice(0, 400)}`);
        } catch (e) {
          lines.push(`${i + 1}. ${childName}: error — ${e?.message || e}`);
          const rest = actions.length - i - 1;
          if (rest) lines.push(`${rest} later action(s) were not run.`);
          break;
        }
      }
      return ok(lines.join("\n"));
    }
    case "computer": {
      const action = String(args?.action || "");
      await cdp.attach(tabId);
      try {
        const point = async (which) => {
          const coord = which === "start" ? args?.start_coordinate : args?.coordinate;
          if (Array.isArray(coord) && coord.length >= 2) {
            return { x: Number(coord[0]), y: Number(coord[1]) };
          }
          if (args?.ref) {
            const box = await cdp.elementBox(tabId, args.ref);
            if (!box) throw new Error(`Element ${args.ref} is not visible.`);
            return { x: box.cx, y: box.cy };
          }
          throw new Error("Provide coordinate [x,y] or ref.");
        };

        switch (action) {
          case "screenshot": {
            const image = await cdp.captureScreenshot(tabId, {
              ref: args?.ref,
              fullPage: !!args?.full_page,
            });
            return ok("Screenshot captured.", { image });
          }
          case "hover": {
            const p = await point();
            await cdp.mouseMove(tabId, p.x, p.y);
            return ok(`Hovered at ${Math.round(p.x)},${Math.round(p.y)}.`, { pointer: { x: p.x, y: p.y, acting: false } });
          }
          case "left_click":
          case "right_click":
          case "middle_click":
          case "double_click":
          case "triple_click": {
            const p = await point();
            const button =
              action === "right_click" ? "right" : action === "middle_click" ? "middle" : "left";
            const clickCount = action === "triple_click" ? 3 : action === "double_click" ? 2 : 1;
            await cdp.mouseClick(tabId, p.x, p.y, { button, clickCount });
            await sleep(120);
            return ok(`Performed ${action} at ${Math.round(p.x)},${Math.round(p.y)}.`, { pointer: { x: p.x, y: p.y } });
          }
          case "scroll_to": {
            if (!args?.ref) throw new Error("scroll_to requires a ref from read_page.");
            const res = await sendToTab(tabId, "scroll", { ref: args.ref, direction: "into", amount: 0 });
            if (!res.ok) throw new Error(res.error || "scroll_to failed");
            return ok(res.result);
          }
          case "zoom": {
            const region = Array.isArray(args?.region) ? args.region : null;
            const clip =
              region && region.length >= 4
                ? {
                    x: Number(region[0]),
                    y: Number(region[1]),
                    width: Number(region[2]),
                    height: Number(region[3]),
                  }
                : null;
            const image = await cdp.captureScreenshot(tabId, { ref: args?.ref, clip });
            return ok("Zoomed screenshot captured.", { image });
          }
          case "left_click_drag": {
            const from = await point("start");
            const to = await point();
            await cdp.mouseDown(tabId, from.x, from.y);
            await cdp.mouseMove(tabId, (from.x + to.x) / 2, (from.y + to.y) / 2, 1);
            await sleep(40);
            await cdp.mouseMove(tabId, to.x, to.y, 1);
            await sleep(40);
            await cdp.mouseUp(tabId, to.x, to.y);
            return ok(`Dragged from ${Math.round(from.x)},${Math.round(from.y)} to ${Math.round(to.x)},${Math.round(to.y)}.`, { pointer: { x: to.x, y: to.y } });
          }
          case "type": {
            if (args?.coordinate || args?.ref) {
              const p = await point();
              await cdp.mouseClick(tabId, p.x, p.y);
              await sleep(80);
            }
            await cdp.insertText(tabId, args?.text ?? "");
            return ok(`Typed ${String(args?.text ?? "").length} character(s).`);
          }
          case "key": {
            const keys =
              Array.isArray(args?.keys) && args.keys.length
                ? args.keys
                : args?.text
                  ? [String(args.text)]
                  : [];
            if (!keys.length) throw new Error("Provide keys or text for the key action.");
            for (const k of keys) await cdp.keyCombo(tabId, k);
            return ok(`Pressed ${keys.join(", ")}.`);
          }
          case "scroll": {
            let p;
            try {
              p = await point();
            } catch {
              const v = await cdp.viewport(tabId);
              p = { x: v.w / 2, y: v.h / 2 };
            }
            const amount = Number(args?.scroll_amount) || 3;
            const dir = args?.scroll_direction || "down";
            const dx = dir === "left" ? -amount * 100 : dir === "right" ? amount * 100 : 0;
            const dy = dir === "up" ? -amount * 100 : dir === "down" ? amount * 100 : 0;
            await cdp.mouseWheel(tabId, p.x, p.y, dx, dy);
            return ok(`Scrolled ${dir} by ${amount} step(s).`);
          }
          case "wait": {
            const ms = Math.max(0, Math.min(15000, Number(args?.duration) || 1000));
            await sleep(ms);
            return ok(`Waited ${ms} ms.`);
          }
          default:
            throw new Error(`Unknown computer action: ${action}`);
        }
      } finally {
        await cdp.detach(tabId).catch(() => {});
      }
    }
    case "shortcut": {
      const keys = Array.isArray(args?.keys) ? args.keys : [];
      if (!keys.length && !args?.text) throw new Error("Provide keys or text.");
      await cdp.attach(tabId);
      try {
        for (const k of keys) await cdp.keyCombo(tabId, k);
        if (args?.text) await cdp.insertText(tabId, args.text);
      } finally {
        await cdp.detach(tabId).catch(() => {});
      }
      return ok(`Pressed ${keys.join(", ") || "(none)"}${args?.text ? ` and typed ${String(args.text).length} character(s)` : ""}.`);
    }
    case "file_upload": {
      if (Array.isArray(args?.paths) && args.paths.length) {
        throw new Error("file_upload does not accept local paths. Pass file contents in files.");
      }
      const files = Array.isArray(args?.files) ? args.files : [];
      const roughBytes = files.reduce(
        (sum, file) => sum + String(file?.dataUrl || file?.text || "").length,
        0
      );
      if (roughBytes > 14 * 1024 * 1024) {
        throw new Error("Total upload size exceeds 10 MB.");
      }
      const targetRef = args?.ref || args?.drop_ref;
      if (!targetRef) throw new Error("Provide ref or drop_ref.");
      const res = await sendToTab(tabId, "upload", {
        ref: targetRef,
        files: args?.files,
        drop: !args?.ref,
      });
      if (!res.ok) throw new Error(res.error || "file_upload failed");
      await sleep(150);
      return ok(res.result);
    }
    case "gif_creator": {
      const action = String(args?.action || "start");
      if (action === "start") {
        const r = gifStart(tabId, {
          intervalMs: args?.interval_ms,
        });
        try {
          ctx?.emit?.({ type: "gif_status", recording: true, frames: r.frames });
        } catch {}
        return ok(
          r.alreadyRunning
            ? `Already recording (${r.frames} frame(s) so far).`
            : "Started recording the tab. Perform the actions, then call gif_creator with action \"export\"."
        );
      }
      if (action === "stop") {
        const r = gifStop(tabId);
        try {
          ctx?.emit?.({ type: "gif_status", recording: false, frames: r.frames });
        } catch {}
        return ok(`Stopped recording with ${r.frames} frame(s). Call export to save the GIF.`);
      }
      if (action === "status") {
        const r = gifStatus(tabId);
        return ok(`Recording: ${r.recording ? "yes" : "no"}, frames: ${r.frames}.`);
      }
      if (action === "clear") {
        gifClear(tabId);
        try {
          ctx?.emit?.({ type: "gif_status", recording: false, frames: 0 });
        } catch {}
        return ok("Discarded the recording.");
      }
      if (action === "export") {
        try {
          const res = await gifExport(tabId, { delayMs: args?.delay_ms });
          try {
            ctx?.emit?.({ type: "gif_done", ...res });
          } catch {}
          return ok(
            `Exported ${res.frames} frame(s) to ${res.filename} (${Math.round(
              res.bytes / 1024
            )} KB).`
          );
        } catch (e) {
          try {
            ctx?.emit?.({ type: "gif_error", message: String(e?.message || e) });
          } catch {}
          throw e;
        }
      }
      throw new Error(`Unknown gif_creator action: ${action}`);
    }
    case "execute_javascript": {
      const code = String(args?.code || "").trim();
      if (!code) throw new Error("code must be a non-empty JavaScript string.");
      const value = await cdp.evaluateJS(tabId, code, {
        awaitPromise: args?.await_promise !== false,
      });
      let text;
      try {
        text = value === undefined ? "undefined" : JSON.stringify(value);
      } catch {
        text = String(value);
      }
      return ok(text);
    }
    case "read_clipboard": {
      const res = await sendToTab(tabId, "read_clipboard");
      if (!res.ok) throw new Error(res.error || "read_clipboard failed");
      return ok(res.result);
    }
    case "write_clipboard": {
      const res = await sendToTab(tabId, "write_clipboard", { text: String(args?.text ?? "") });
      if (!res.ok) throw new Error(res.error || "write_clipboard failed");
      return ok(res.result);
    }
    case "load_skill": {
      const wanted = String(args?.name || "").trim().toLowerCase();
      const skills = Array.isArray(ctx?.settings?.activeSkills) ? ctx.settings.activeSkills : [];
      const skill = skills.find((item) => String(item.name || "").toLowerCase() === wanted && item.enabled !== false);
      if (!skill) throw new Error(`No enabled skill named "${args?.name || ""}".`);
      ctx.loadedSkills = ctx.loadedSkills || [];
      if (!ctx.loadedSkills.includes(skill.name)) ctx.loadedSkills.push(skill.name);
      return ok(`# ${skill.name}\n${skill.description || ""}\n\n${skill.instructions || ""}`.trim());
    }
    case "save_skill": {
      const name = String(args?.name || "").trim();
      const instructions = String(args?.instructions || "").trim();
      if (!name || !instructions) throw new Error("name and instructions are required.");
      const description = String(args?.description || "").trim();
      if (typeof ctx?.confirm === "function") {
        const decision = await ctx.confirm({
          kind: "skill",
          name: "save_skill",
          message: `Save the skill "${name}"?\n${description}`,
          skill: { name, description, instructions },
        });
        const approved = decision === true || decision?.approved === true;
        if (!approved) throw new Error("The user declined the skill.");
      }
      if (typeof ctx?.saveSkill === "function") {
        await ctx.saveSkill({ name, description, instructions, enabled: true });
      }
      return ok(`Saved skill ${name}.`);
    }
    case "save_result": {
      if (typeof ctx?.saveResult !== "function") {
        throw new Error("Results cannot be saved in this run. Give them in your reply instead.");
      }
      const saved = await ctx.saveResult({ label: args?.label, value: args?.value, note: args?.note });
      const collected = saved.filter((item) => item.value).length;
      const missing = saved.length - collected;
      // The value is not repeated here: it is already kept and sent with every step.
      return ok(`Saved. ${collected} collected${missing ? `, ${missing} noted as not collected` : ""} so far.`);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
