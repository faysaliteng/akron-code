// Chrome DevTools Protocol bridge.
// Used by the `computer` tool for *trusted* input (real mouse/keyboard events
// that sites cannot distinguish from a human), precise element screenshots,
// full-page capture, and native dialog dismissal.
//
// The debugger shows Chrome's "started debugging this browser" infobar while
// attached; we detach as soon as a computer session goes idle.

const attached = new Set();

export function isAttached(tabId) {
  return attached.has(tabId);
}

export function send(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    try {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

export async function attach(tabId) {
  if (attached.has(tabId)) return;
  await new Promise((resolve, reject) => {
    try {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
  attached.add(tabId);
  // Best-effort domain enabling; failures are not fatal.
  await Promise.allSettled([
    send(tabId, "Page.enable"),
    send(tabId, "DOM.enable"),
    send(tabId, "Runtime.enable"),
  ]);
}

export function detach(tabId) {
  if (!attached.has(tabId)) return Promise.resolve();
  attached.delete(tabId);
  return new Promise((resolve) => {
    try {
      chrome.debugger.detach({ tabId }, () => resolve());
    } catch {
      resolve();
    }
  });
}

export function detachAll() {
  return Promise.all([...attached].map((id) => detach(id)));
}

if (chrome.debugger?.onDetach) {
  chrome.debugger.onDetach.addListener((source) => {
    if (source && source.tabId != null) attached.delete(source.tabId);
  });
}

/* ---------------------------- geometry ---------------------------- */

function jsString(value) {
  return JSON.stringify(String(value));
}

export async function viewport(tabId) {
  try {
    const res = await send(tabId, "Runtime.evaluate", {
      expression: "({ w: window.innerWidth, h: window.innerHeight })",
      returnByValue: true,
    });
    const v = res?.result?.value;
    if (v && v.w > 0 && v.h > 0) return { w: v.w, h: v.h };
  } catch {}
  return { w: 1280, h: 800 };
}

export async function evaluateJS(tabId, expression, { awaitPromise = false } = {}) {
  await attach(tabId);
  try {
    const res = await send(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: false,
    });
    if (res?.exceptionDetails) {
      const d = res.exceptionDetails;
      throw new Error(
        d.exception?.description || d.text || "JavaScript evaluation failed."
      );
    }
    return res?.result?.value;
  } finally {
    await detach(tabId).catch(() => {});
  }
}

export async function elementBox(tabId, ref) {
  const selector = jsString(`[data-autobot-ref="${ref}"]`);
  const expr = `(() => {
    const el = document.querySelector(${selector});
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      x: r.left, y: r.top, width: r.width, height: r.height,
      cx: r.left + r.width / 2, cy: r.top + r.height / 2,
      vw: window.innerWidth, vh: window.innerHeight,
      sx: window.scrollX, sy: window.scrollY
    };
  })()`;
  const res = await send(tabId, "Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
  });
  return res?.result?.value || null;
}

/* ------------------------------ mouse ------------------------------ */

const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 };

export async function mouseMove(tabId, x, y, buttons = 0) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
    buttons,
  });
}

export async function mouseClick(tabId, x, y, { button = "left", clickCount = 1 } = {}) {
  const bits = BUTTON_BITS[button] || 1;
  await mouseMove(tabId, x, y, 0);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons: bits,
    clickCount,
  });
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount,
  });
}

export async function mouseDown(tabId, x, y, button = "left") {
  await mouseMove(tabId, x, y, 0);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button,
    buttons: BUTTON_BITS[button] || 1,
    clickCount: 1,
  });
}

export async function mouseUp(tabId, x, y, button = "left") {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button,
    buttons: 0,
    clickCount: 1,
  });
}

export async function mouseWheel(tabId, x, y, deltaX, deltaY) {
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x,
    y,
    deltaX,
    deltaY,
  });
}

/* ---------------------------- keyboard ---------------------------- */

const MODIFIERS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, shift: 8 };

const SPECIAL_KEYS = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
};

function parseCombo(combo) {
  const parts = String(combo)
    .split("+")
    .map((p) => p.trim())
    .filter(Boolean);
  let modifiers = 0;
  let main = parts.pop() || "";
  for (const p of parts) {
    const bit = MODIFIERS[p.toLowerCase()];
    if (bit) modifiers |= bit;
  }
  const lower = main.toLowerCase();
  if (SPECIAL_KEYS[lower]) return { ...SPECIAL_KEYS[lower], modifiers };
  if (main.length === 1) {
    const ch = main;
    const upper = ch.toUpperCase();
    return {
      key: ch,
      code: /[a-z]/i.test(ch) ? `Key${upper}` : `Digit${ch}`,
      vk: upper.charCodeAt(0),
      text: ch,
      modifiers,
    };
  }
  return { key: main, code: main, vk: 0, modifiers };
}

export async function keyCombo(tabId, combo) {
  const k = parseCombo(combo);
  const base = {
    modifiers: k.modifiers,
    key: k.key,
    code: k.code,
    windowsVirtualKeyCode: k.vk,
    nativeVirtualKeyCode: k.vk,
  };
  await send(tabId, "Input.dispatchKeyEvent", {
    type: k.text ? "keyDown" : "rawKeyDown",
    ...base,
    ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

export async function insertText(tabId, text) {
  await send(tabId, "Input.insertText", { text: String(text ?? "") });
}

/* --------------------------- screenshots --------------------------- */

export async function captureScreenshot(tabId, { ref, fullPage = false, format = "png", clip = null } = {}) {
  const params = { format };
  if (clip && Number.isFinite(clip.width) && Number.isFinite(clip.height)) {
    params.clip = {
      x: Math.max(0, Number(clip.x) || 0),
      y: Math.max(0, Number(clip.y) || 0),
      width: Math.min(16384, Math.max(1, Number(clip.width))),
      height: Math.min(16384, Math.max(1, Number(clip.height))),
      scale: 1,
    };
    params.captureBeyondViewport = true;
  } else if (ref) {
    const box = await elementBox(tabId, ref);
    if (!box) throw new Error(`Element ${ref} is not visible on the page.`);
    params.clip = {
      x: Math.max(0, box.x + box.sx),
      y: Math.max(0, box.y + box.sy),
      width: Math.min(16384, Math.max(1, box.width)),
      height: Math.min(16384, Math.max(1, box.height)),
      scale: 1,
    };
    params.captureBeyondViewport = true;
  } else if (fullPage) {
    const m = await send(tabId, "Page.getLayoutMetrics");
    const size = m.cssContentSize || m.contentSize || { width: 1280, height: 800 };
    params.clip = {
      x: 0,
      y: 0,
      width: Math.min(16384, Math.max(1, size.width)),
      height: Math.min(16384, Math.max(1, size.height)),
      scale: 1,
    };
    params.captureBeyondViewport = true;
  }
  const { data } = await send(tabId, "Page.captureScreenshot", params);
  return `data:image/${format};base64,${data}`;
}

/* ------------------------ dialogs / navigation ------------------------ */

export async function handleJavaScriptDialog(tabId, accept = true, promptText) {
  await send(tabId, "Page.handleJavaScriptDialog", {
    accept,
    ...(promptText != null ? { promptText: String(promptText) } : {}),
  });
}

export async function navigate(tabId, url) {
  await send(tabId, "Page.navigate", { url });
}
