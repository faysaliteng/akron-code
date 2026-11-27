// What a tool step looks like to the person watching: "Clicking" while it runs,
// 'Clicked button "Send code"' once it is done. Plain text in, plain text out.

const MAX_LABEL_CHARS = 96;
const MAX_QUOTE_CHARS = 36;

function clip(text, max) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function quoted(text) {
  const clean = clip(text, MAX_QUOTE_CHARS);
  return clean ? `“${clean}”` : "";
}

/** "https://www.example.com/a?b" becomes "example.com". */
export function siteOf(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return "";
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`).hostname.replace(/^www\./, "");
  } catch {
    return clip(raw, MAX_QUOTE_CHARS);
  }
}

function seconds(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const rounded = Math.round(value / 100) / 10;
  return `${rounded} second${rounded === 1 ? "" : "s"}`;
}

function join(...parts) {
  return parts.filter(Boolean).join(" ");
}

const pair = (doing, done) => ({ doing, done });

function navigation(url, tail = "") {
  const target = String(url ?? "").trim().toLowerCase();
  if (target === "back") return pair("Going back", "Went back");
  if (target === "forward") return pair("Going forward", "Went forward");
  const site = siteOf(url);
  return pair(join("Opening", site || "a page", tail), join("Opened", site || "a page", tail));
}

const COMPUTER_ACTIONS = {
  screenshot: pair("Taking a screenshot", "Took a screenshot"),
  left_click: pair("Clicking", "Clicked"),
  right_click: pair("Right-clicking", "Right-clicked"),
  middle_click: pair("Middle-clicking", "Middle-clicked"),
  double_click: pair("Double-clicking", "Double-clicked"),
  triple_click: pair("Selecting a line", "Selected a line"),
  hover: pair("Moving the pointer", "Moved the pointer"),
  left_click_drag: pair("Dragging", "Dragged"),
  scroll_to: pair("Scrolling to an element", "Scrolled to an element"),
  zoom: pair("Looking closer", "Looked closer"),
  type: pair("Typing", "Typed"),
  scroll: pair("Scrolling", "Scrolled"),
  wait: pair("Waiting", "Waited"),
};

function computer(args) {
  const action = String(args?.action || "");
  if (action === "key") {
    const keys = clip(Array.isArray(args?.keys) ? args.keys.join(" + ") : args?.keys || args?.text, 30);
    return pair(join("Pressing", keys || "a key"), join("Pressed", keys || "a key"));
  }
  if (action === "scroll" && args?.scroll_direction) {
    return pair(`Scrolling ${args.scroll_direction}`, `Scrolled ${args.scroll_direction}`);
  }
  return COMPUTER_ACTIONS[action] || pair("Using the page", "Used the page");
}

const RECORDING = {
  start: pair("Starting a recording", "Started a recording"),
  stop: pair("Stopping the recording", "Stopped the recording"),
  export: pair("Saving the recording", "Saved the recording"),
  clear: pair("Discarding the recording", "Discarded the recording"),
};

const LABELS = {
  read_page: () => pair("Reading the page", "Read the page"),
  read_text: () => pair("Reading the page text", "Read the page text"),
  find: (args) => pair(join("Looking for", quoted(args?.query) || "an element"), join("Looked for", quoted(args?.query) || "an element")),
  click: () => pair("Clicking", "Clicked"),
  type: () => pair("Typing", "Typed"),
  press_key: (args) => pair(join("Pressing", clip(args?.key, 24) || "a key"), join("Pressed", clip(args?.key, 24) || "a key")),
  scroll: (args) => pair(join("Scrolling", clip(args?.direction, 12) || "down"), join("Scrolled", clip(args?.direction, 12) || "down")),
  navigate: (args) => navigation(args?.url),
  open_tab: (args) => navigation(args?.url, "in a new tab"),
  list_tabs: () => pair("Checking the open tabs", "Checked the open tabs"),
  switch_tab: () => pair("Switching tabs", "Switched tabs"),
  close_tab: () => pair("Closing the tab", "Closed the tab"),
  go_back: () => pair("Going back", "Went back"),
  go_forward: () => pair("Going forward", "Went forward"),
  screenshot: () => pair("Taking a screenshot", "Took a screenshot"),
  wait: (args) => pair(join("Waiting", seconds(args?.ms)), join("Waited", seconds(args?.ms))),
  form_input: () => pair("Filling in a field", "Filled in a field"),
  hover: () => pair("Pointing at an element", "Pointed at an element"),
  drag: () => pair("Dragging", "Dragged"),
  upload_image: () => pair("Attaching a file", "Attached a file"),
  file_upload: () => pair("Attaching a file", "Attached a file"),
  read_console_messages: () => pair("Reading the console", "Read the console"),
  read_network_requests: () => pair("Checking network activity", "Checked network activity"),
  resize_window: (args) => {
    const size = Number(args?.width) && Number(args?.height) ? `to ${args.width}×${args.height}` : "";
    return pair("Resizing the window", join("Resized the window", size));
  },
  group_tabs: () => pair("Grouping tabs", "Grouped tabs"),
  ungroup_tabs: () => pair("Ungrouping tabs", "Ungrouped tabs"),
  update_plan: () => pair("Updating the plan", "Updated the plan"),
  browser_batch: (args) => {
    const count = Array.isArray(args?.actions) ? args.actions.length : 0;
    const what = count ? `${count} action${count === 1 ? "" : "s"}` : "several actions";
    return pair(`Running ${what}`, `Ran ${what}`);
  },
  computer,
  shortcut: (args) => {
    const keys = clip(Array.isArray(args?.keys) ? args.keys.join(" + ") : args?.keys, 30) || "a shortcut";
    return pair(`Pressing ${keys}`, `Pressed ${keys}`);
  },
  gif_creator: (args) => RECORDING[args?.action] || pair("Checking the recording", "Checked the recording"),
  execute_javascript: () => pair("Running a script on the page", "Ran a script on the page"),
  read_clipboard: () => pair("Reading the clipboard", "Read the clipboard"),
  vault_autofill: () => pair("Autofilling saved credentials", "Autofilled saved credentials"),
  write_clipboard: () => pair("Copying to the clipboard", "Copied to the clipboard"),
  load_skill: (args) => pair(join("Loading the skill", quoted(args?.name)), join("Loaded the skill", quoted(args?.name))),
  save_skill: (args) => pair(join("Saving the skill", quoted(args?.name)), join("Saved the skill", quoted(args?.name))),
  // The label only: a collected value is never put on a row.
  save_result: (args) =>
    String(args?.value ?? "").trim()
      ? pair(join("Saving", quoted(args?.label) || "a result"), join("Saved", quoted(args?.label) || "a result"))
      : pair(join("Noting what could not be collected", quoted(args?.label)), join("Could not collect", quoted(args?.label) || "a result")),
};

/**
 * The two wordings of a step.
 * @param {string} name tool name
 * @param {object} [args] the tool's arguments
 * @returns {{ doing: string, done: string }}
 */
export function describeStep(name, args) {
  const build = LABELS[name];
  if (build) return build(args || {});
  const plain = clip(String(name || "a tool").replaceAll("_", " "), 40);
  return pair(`Running ${plain}`, `Ran ${plain}`);
}

// Tools whose own report is one short sentence about an element, worth showing
// instead of the bare verb. Typed text and field values are left out of the
// row: they can be passwords.
const REPORT_REWRITES = {
  click: [/^Clicked (.+?)\.?$/, "Clicked $1"],
  type: [/^Typed \d+ character\(s\) into (.+?)( and submitted)?\.?$/, "Typed into $1$2"],
  form_input: [/^Set (.+?) to [\s\S]*$/, "Filled in $1"],
  hover: [/^Hovering (.+?)\.?$/, "Pointed at $1"],
  drag: [/^Dragged (.+?)\.?$/, "Dragged $1"],
};

function fromReport(name, result) {
  const rule = REPORT_REWRITES[name];
  const firstLine = String(result ?? "").split("\n", 1)[0].trim();
  if (!rule || !firstLine || !rule[0].test(firstLine)) return "";
  return firstLine.replace(rule[0], rule[1]);
}

/**
 * The line shown for a step in the chat.
 * @param {string} name tool name
 * @param {object} args the tool's arguments
 * @param {"running"|"done"|"error"} phase
 * @param {string} [result] what the tool reported
 */
export function stepLine(name, args, phase, result) {
  const label = describeStep(name, args);
  if (phase === "running") return `${clip(label.doing, MAX_LABEL_CHARS)}…`;
  if (phase === "error") return clip(label.doing, MAX_LABEL_CHARS);
  return clip(fromReport(name, result) || label.done, MAX_LABEL_CHARS);
}

const MAX_POINTER_CHARS = 48;

/** The few words shown next to Akron's pointer on the page while a step runs. */
export function pointerLabel(name, args) {
  return clip(describeStep(name, args).doing, MAX_POINTER_CHARS);
}

/** The status line: what is happening now, and how far the task has come. */
export function statusLine(text, actions) {
  const count = Number(actions) || 0;
  const label = String(text || "Thinking…");
  return count ? `${label} · ${count} ${count === 1 ? "action" : "actions"}` : label;
}

/** The last stretch of the model's thinking, as one line. */
export function thinkingPreview(text, max = 140) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(clean.length - max);
  // Start at a word, not in the middle of one.
  return `…${tail.slice(tail.indexOf(" ") + 1)}`;
}
