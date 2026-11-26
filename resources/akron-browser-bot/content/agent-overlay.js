// Akron page agent. Runs in every frame's main document (isolated world).
// Exposes snapshot / click / type / scroll / press_key / read_text over
// chrome.runtime messages, and renders a small visual indicator.

(() => {
  if (window.__autobotAgent) return;
  window.__autobotAgent = true;

  const refMap = new Map();
  let refCounter = 0;

  /* ----------------------------- utilities ----------------------------- */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (el.getAttribute && el.getAttribute("aria-hidden") === "true") return false;
    const cs = getComputedStyle(el);
    if (
      cs.display === "none" ||
      cs.visibility === "hidden" ||
      cs.visibility === "collapse" ||
      cs.opacity === "0"
    ) {
      return false;
    }
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (tag === "input") {
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button" || type === "reset") return "button";
      if (type === "search") return "searchbox";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return "textbox";
    }
    const map = {
      a: "link",
      button: "button",
      select: "combobox",
      textarea: "textbox",
      h1: "heading",
      h2: "heading",
      h3: "heading",
      h4: "heading",
      h5: "heading",
      h6: "heading",
      img: "image",
      nav: "navigation",
      main: "main",
      header: "banner",
      footer: "contentinfo",
      section: "region",
      article: "article",
      aside: "complementary",
      form: "form",
      table: "table",
      ul: "list",
      ol: "list",
      li: "listitem",
      label: "label",
      summary: "button",
      dialog: "dialog",
    };
    return map[tag] || "generic";
  }

  const INTERACTIVE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "tab",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "switch",
    "textbox",
    "searchbox",
    "combobox",
    "slider",
    "spinbutton",
  ]);

  function isInteractive(el, role) {
    const tag = el.tagName.toLowerCase();
    if (["a", "button", "input", "select", "textarea", "summary"].includes(tag)) {
      return true;
    }
    if (el.isContentEditable) return true;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    if (ti !== null && Number(ti) >= 0) return true;
    return false;
  }

  function ownTextOf(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function accessibleName(el) {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();

    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby
        .split(/\s+/)
        .map((id) => {
          const n = document.getElementById(id);
          return n ? n.innerText || n.textContent || "" : "";
        })
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) return text;
    }

    const tag = el.tagName.toLowerCase();
    if (tag === "img") {
      const alt = el.getAttribute("alt");
      if (alt) return alt.trim();
    }

    const placeholder = el.getAttribute("placeholder");
    if (placeholder) return placeholder.trim();

    const title = el.getAttribute("title");
    if (title) return title.trim();

    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (el.id) {
        try {
          const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lab) return (lab.innerText || "").replace(/\s+/g, " ").trim();
        } catch {}
      }
      const parentLabel = el.closest("label");
      if (parentLabel) return (parentLabel.innerText || "").replace(/\s+/g, " ").trim();
      if (el.getAttribute("name")) return el.getAttribute("name");
    }

    const text = (el.innerText || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 100);
  }

  function describe(el) {
    const role = roleOf(el);
    const name = accessibleName(el).slice(0, 80);
    return name ? `${role} "${name}"` : role;
  }

  function resolveRef(ref) {
    if (!ref) return null;
    let el = refMap.get(ref);
    if (!el || !el.isConnected) {
      try {
        el = document.querySelector(`[data-autobot-ref="${CSS.escape(ref)}"]`);
      } catch {
        el = null;
      }
    }
    return el && el.isConnected ? el : null;
  }

  /* ------------------------------ overlay ------------------------------ */

  const WORKING_TEXT = "Akron is working here";
  const NEEDS_INPUT_TEXT = "Akron needs your input";
  const POINTER_NAME = "Akron";
  const HEARTBEAT_MS = 5000;
  const PAINT_WAIT_MS = 120;
  // Where the pointer waits until the task first acts on the page.
  const POINTER_REST = { x: 0.7, y: 0.3 };
  // The shortest time a step's label stays on the pointer.
  const STEP_MIN_SHOW_MS = 700;

  let overlay = null;
  let cursorEl = null;
  let tagEl = null;
  let highlightEl = null;
  let frameEl = null;
  let bannerEl = null;
  let bannerLabelEl = null;
  let openChatEl = null;
  let heartbeat = null;
  let pointerPlaced = false;
  let waitingForUser = false;
  let stepShownAt = 0;
  let stepTimer = null;

  function ensureOverlay() {
    if (overlay && document.documentElement.contains(overlay)) return;
    overlay = document.createElement("div");
    overlay.id = "autobot-overlay-root";
    overlay.setAttribute("data-autobot-overlay", "1");
    overlay.style.cssText =
      "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
    const shadow = overlay.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .frame {
          position: fixed; inset: 0; box-sizing: border-box;
          border: 3px solid #22c55e;
          box-shadow: inset 0 0 22px 4px rgba(34,197,94,.5);
          opacity: 0; transition: opacity .25s ease;
        }
        .frame::after {
          content: ""; position: absolute; inset: 0;
          box-shadow: inset 0 0 48px 14px rgba(34,197,94,.55);
          opacity: .2; animation: breathe 2.4s ease-in-out infinite;
        }
        .frame.show { opacity: 1; }
        @keyframes breathe { 0%,100% { opacity: .2 } 50% { opacity: 1 } }
        .banner {
          position: fixed; top: 0; left: 50%;
          display: flex; align-items: center; gap: 12px;
          padding: 9px 10px 9px 16px;
          font: 600 14px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #fff; background: #15803d;
          border-radius: 0 0 14px 14px;
          box-shadow: 0 8px 24px rgba(21,128,61,.38);
          opacity: 0; transform: translate(-50%, -110%);
          transition: opacity .2s ease, transform .2s ease;
          white-space: nowrap;
        }
        .banner.show { opacity: 1; transform: translate(-50%, 0); }
        /* The product's mark, turning for as long as work goes on. */
        .spark {
          width: 18px; height: 18px; flex: 0 0 auto; fill: #a7f3d0;
          animation: markTurn 5s linear infinite;
        }
        @keyframes markTurn { to { transform: rotate(360deg) } }
        .stop {
          all: unset; display: flex; align-items: center; gap: 7px;
          padding: 7px 12px; border-radius: 9px; cursor: pointer;
          font: 600 13px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #fff; background: #052e16; pointer-events: none;
        }
        .banner.show .stop { pointer-events: auto; }
        .stop:hover { background: #14532d; }
        .stop:focus-visible { outline: 2px solid #bbf7d0; outline-offset: 2px; }
        .square { width: 10px; height: 10px; border-radius: 2px; background: #fff; flex: 0 0 auto; }
        /* Shown only while the task waits for the person. */
        .open {
          all: unset; display: none; padding: 7px 12px; border-radius: 9px; cursor: pointer;
          font: 600 13px/1 -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #052e16; background: #bbf7d0;
        }
        .banner.show.needs .open { display: block; pointer-events: auto; }
        .open:hover { background: #dcfce7; }
        .open:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
        .banner.needs { background: #b45309; box-shadow: 0 8px 24px rgba(180,83,9,.38); }
        /* The agent's own pointer: an arrow whose tag says what the task is
           doing. It is on the page for the whole task and glides to where it
           acts, so it is never mistaken for the person's cursor. */
        .cursor {
          position: fixed; left: 0; top: 0; width: 24px; height: 28px;
          opacity: 0; transform: translate(50vw, 45vh);
          transition: transform .36s cubic-bezier(.22,.8,.3,1), opacity .2s ease;
          filter: drop-shadow(0 2px 5px rgba(2,44,34,.45));
        }
        .cursor.show { opacity: 1; }
        .cursor svg { display: block; width: 24px; height: 28px; }
        .cursor .tag {
          position: absolute; left: 17px; top: 22px;
          padding: 3px 7px; border-radius: 3px 9px 9px 9px;
          font: 600 10px/1.1 -apple-system, "Segoe UI", Roboto, sans-serif;
          color: #fff; background: #059669; white-space: nowrap;
          max-width: 46vw; overflow: hidden; text-overflow: ellipsis;
        }
        .cursor .ring {
          position: absolute; left: -12px; top: -12px; width: 24px; height: 24px;
          box-sizing: border-box; border-radius: 50%;
          border: 2px solid #10b981; background: rgba(16,185,129,.18); opacity: 0;
        }
        .cursor.click .ring { animation: clickRing .55s ease-out; }
        @keyframes clickRing {
          0% { opacity: .95; transform: scale(.35) }
          100% { opacity: 0; transform: scale(1.7) }
        }
        .hl {
          position: fixed; border: 2px solid #16a34a; border-radius: 4px;
          background: rgba(34,197,94,.12); opacity: 0;
          transition: opacity .12s ease; pointer-events: none;
        }
        .hl.show { opacity: 1; }
        @media (prefers-reduced-motion: reduce) {
          .frame::after, .spark { animation: none; }
          .cursor { transition: opacity .2s ease; }
        }
      </style>
      <div class="frame" id="frame"></div>
      <div class="banner" id="banner" role="status">
        <svg class="spark" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.4"/>
          <rect x="10.9" y="1.5" width="2.2" height="7.5" rx="1.1"/>
          <rect x="10.9" y="1.5" width="2.2" height="7.5" rx="1.1" transform="rotate(60 12 12)"/>
          <rect x="10.9" y="1.5" width="2.2" height="7.5" rx="1.1" transform="rotate(120 12 12)"/>
          <rect x="10.9" y="1.5" width="2.2" height="7.5" rx="1.1" transform="rotate(180 12 12)"/>
          <rect x="10.9" y="1.5" width="2.2" height="7.5" rx="1.1" transform="rotate(240 12 12)"/>
          <rect x="10.9" y="1.5" width="2.2" height="7.5" rx="1.1" transform="rotate(300 12 12)"/>
        </svg>
        <span id="banner-label">${WORKING_TEXT}</span>
        <button class="open" id="open-chat" type="button">Open chat</button>
        <button class="stop" id="stop" type="button"><span class="square" aria-hidden="true"></span>Stop</button>
      </div>
      <div class="cursor" id="cursor" aria-hidden="true">
        <span class="ring"></span>
        <svg viewBox="0 0 24 28"><path d="M2 2v20l5.6-5 3.6 8.4 3.6-1.6-3.6-8.2h7.6z" fill="#10b981" stroke="#fff" stroke-width="1.7" stroke-linejoin="round"/></svg>
        <span class="tag" id="tag">${POINTER_NAME}</span>
      </div>
      <div class="hl" id="hl"></div>
    `;
    document.documentElement.appendChild(overlay);
    cursorEl = shadow.getElementById("cursor");
    tagEl = shadow.getElementById("tag");
    highlightEl = shadow.getElementById("hl");
    frameEl = shadow.getElementById("frame");
    bannerEl = shadow.getElementById("banner");
    bannerLabelEl = shadow.getElementById("banner-label");
    openChatEl = shadow.getElementById("open-chat");
    shadow.getElementById("stop").addEventListener("click", (event) => {
      // Only a real click by the person stops the task, never a script on the page.
      if (!event.isTrusted) return;
      bannerLabelEl.textContent = "Stopping Akron…";
      chrome.runtime.sendMessage({ type: "autobot_stop_here" }).catch(() => setWorking(false));
    });
    shadow.getElementById("open-chat").addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      chrome.runtime.sendMessage({ type: "autobot_open_panel" }).catch(() => {});
    });
  }

  /* The green frame, the "working here" banner and the pointer, shown for as
     long as a task is using this tab. While the task waits for the person the
     banner says so and offers the way to the chat. */
  function setWorking(on, needsInput = false) {
    try {
      ensureOverlay();
      const show = !!on;
      waitingForUser = show && !!needsInput;
      bannerLabelEl.textContent = waitingForUser ? NEEDS_INPUT_TEXT : WORKING_TEXT;
      bannerEl.classList.toggle("needs", waitingForUser);
      openChatEl.tabIndex = waitingForUser ? 0 : -1;
      frameEl.classList.toggle("show", show);
      bannerEl.classList.toggle("show", show);
      if (show && !heartbeat) heartbeat = setInterval(checkStillWorking, HEARTBEAT_MS);
      if (show) restPointer();
      if (!show) {
        if (heartbeat) clearInterval(heartbeat);
        heartbeat = null;
        cursorEl.classList.remove("show");
        pointerPlaced = false;
        setStep(null, { now: true });
      }
    } catch {}
  }

  // The background worker says when a task ends. If the worker was restarted
  // instead, nothing would clear the frame, so ask it now and then.
  async function checkStillWorking() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "autobot_tab_state" });
      if (!reply?.working) setWorking(false);
      else if (!!reply.needsInput !== waitingForUser) setWorking(true, reply.needsInput);
    } catch {
      setWorking(false);
    }
  }

  // Takes Akron's own overlay off the page while the agent looks at it or
  // clicks by position, so it is not in screenshots or in the way of a click.
  async function setOverlayHidden(hidden) {
    if (!overlay) return;
    overlay.style.visibility = hidden ? "hidden" : "";
    if (!hidden) return;
    await Promise.race([
      new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
      sleep(PAINT_WAIT_MS),
    ]);
  }

  // A page opened while a task is already using this tab shows the frame at once.
  // The stored flag is read first so an idle Akron is not woken by every page load.
  chrome.storage.local
    .get("autobot_working")
    .then((stored) =>
      stored?.autobot_working ? chrome.runtime.sendMessage({ type: "autobot_tab_state" }) : null
    )
    .then(async (reply) => {
      if (!reply?.working) return;
      setWorking(true, reply.needsInput);
      setStep(reply.step);
      if (reply.hidden) await setOverlayHidden(true);
    })
    .catch(() => {});

  // What the pointer's tag says: the step that is running, or the product's
  // name between steps. A step can be over in a few milliseconds, so its label
  // stays long enough to be read before the next one replaces it.
  function setStep(label, { now = false } = {}) {
    try {
      ensureOverlay();
      if (stepTimer) clearTimeout(stepTimer);
      stepTimer = null;
      const text = String(label ?? "").trim() || POINTER_NAME;
      const showingStep = tagEl.textContent !== POINTER_NAME;
      const wait = now || !showingStep ? 0 : stepShownAt + STEP_MIN_SHOW_MS - Date.now();
      if (wait > 0) {
        stepTimer = setTimeout(() => setStep(label), wait);
        return;
      }
      tagEl.textContent = text;
      stepShownAt = Date.now();
    } catch {}
  }

  // Puts the pointer on the page before the task has acted anywhere, so it is
  // there from the first step. A pointer that was already used stays put.
  function restPointer() {
    try {
      ensureOverlay();
      if (!pointerPlaced) {
        const x = Math.round(window.innerWidth * POINTER_REST.x);
        const y = Math.round(window.innerHeight * POINTER_REST.y);
        cursorEl.style.transform = `translate(${x}px, ${y}px)`;
      }
      cursorEl.classList.add("show");
    } catch {}
  }

  // Moves the agent's pointer to a point in the window, with a ripple when it
  // acts there. It stays where it was last used until the task ends.
  function pointAt(x, y, acting = true) {
    try {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      ensureOverlay();
      pointerPlaced = true;
      cursorEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
      cursorEl.classList.add("show");
      cursorEl.classList.remove("click");
      if (!acting) return;
      // Reading a layout value restarts the ripple for a second click in a row.
      void cursorEl.offsetWidth;
      cursorEl.classList.add("click");
    } catch {}
  }

  function moveCursor(el) {
    try {
      const r = el.getBoundingClientRect();
      pointAt(r.left + r.width / 2, r.top + r.height / 2);
    } catch {}
  }

  function flashHighlight(el) {
    try {
      ensureOverlay();
      const r = el.getBoundingClientRect();
      highlightEl.style.left = `${r.left - 2}px`;
      highlightEl.style.top = `${r.top - 2}px`;
      highlightEl.style.width = `${r.width + 4}px`;
      highlightEl.style.height = `${r.height + 4}px`;
      highlightEl.classList.add("show");
      setTimeout(() => highlightEl && highlightEl.classList.remove("show"), 700);
    } catch {}
  }

  /* ------------------------------ snapshot ----------------------------- */

  function snapshot(options = {}) {
    const filter = options.filter === "all" ? "all" : "interactive";
    const maxChars = Math.max(500, Number(options.maxChars) || 50000);
    const maxDepth = Number.isFinite(Number(options.depth)) ? Number(options.depth) : 15;
    const focusEl = options.refId ? resolveRef(options.refId) : null;
    if (options.refId && !focusEl) {
      return `Element with ref ${options.refId} was not found. Call read_page without a ref.`;
    }
    refMap.clear();
    refCounter = 0;
    try {
      for (const el of document.querySelectorAll("[data-autobot-ref]")) {
        el.removeAttribute("data-autobot-ref");
      }
    } catch {}

    const lines = [];
    let budget = maxChars;
    let count = 0;
    const MAX_NODES = 10000;
    const SKIP = new Set([
      "script",
      "style",
      "noscript",
      "svg",
      "path",
      "meta",
      "link",
      "head",
      "template",
      "canvas",
    ]);
    const TEXT_ROLES = new Set([
      "heading",
      "listitem",
      "label",
      "generic",
      "region",
      "main",
      "banner",
      "contentinfo",
      "article",
      "complementary",
      "form",
      "table",
      "dialog",
    ]);

    function push(line) {
      if (budget <= 0) return;
      budget -= line.length + 1;
      lines.push(line);
    }

    function walk(el, depth) {
      if (count >= MAX_NODES || budget <= 0 || depth > maxDepth) return;
      if (!(el instanceof Element)) return;
      if (el.hasAttribute && el.hasAttribute("data-autobot-overlay")) return;

      const tag = el.tagName.toLowerCase();
      if (SKIP.has(tag)) return;
      const visible = isVisible(el);
      if (filter !== "all" && !visible) return;

      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      const indent = "  ".repeat(Math.min(depth, 12));
      count += 1;

      if (interactive) {
        const ref = `e${++refCounter}`;
        refMap.set(ref, el);
        try {
          el.setAttribute("data-autobot-ref", ref);
        } catch {}

        const bits = [role];
        const name = accessibleName(el);
        if (name) bits.push(JSON.stringify(name.slice(0, 120)));
        if (tag === "a" && el.getAttribute("href")) {
          bits.push(`href=${JSON.stringify(String(el.getAttribute("href")).slice(0, 160))}`);
        }
        if (tag === "input") {
          bits.push(`type=${el.getAttribute("type") || "text"}`);
          if (el.type === "password") {
            if (el.value) bits.push('value="[redacted]"');
          } else if (el.value) {
            bits.push(`value=${JSON.stringify(String(el.value).slice(0, 80))}`);
          }
          if (el.checked) bits.push("checked");
        }
        if (tag === "select") {
          const opt = el.options && el.options[el.selectedIndex];
          if (opt) bits.push(`selected=${JSON.stringify(opt.text.trim().slice(0, 60))}`);
        }
        if (el.disabled) bits.push("disabled");
        const expanded = el.getAttribute("aria-expanded");
        if (expanded) bits.push(`expanded=${expanded}`);

        push(`${indent}- ${bits.join(" ")} [ref=${ref}]`);
      } else {
        const text = ownTextOf(el);
        if (text && text.length <= 200 && TEXT_ROLES.has(role)) {
          push(`${indent}- ${role} ${JSON.stringify(text.slice(0, 160))}`);
        }
        if (tag === "iframe") {
          push(`${indent}- iframe src=${JSON.stringify((el.getAttribute("src") || "").slice(0, 140))}`);
        }
      }

      for (const child of el.children) {
        if (count >= MAX_NODES || budget <= 0) break;
        walk(child, depth + 1);
      }
    }

    walk(focusEl || document.body || document.documentElement, 0);

    const header = `URL: ${location.href}\nTitle: ${document.title}\n`;
    const body = lines.join("\n");
    const truncated =
      budget <= 0 || count >= MAX_NODES
        ? `\n[output truncated at ${maxChars} characters. Pass a larger maxChars, a smaller depth, or a ref.]`
        : "";
    return `${header}\n${body}${truncated}`;
  }

  /* ------------------------------ actions ------------------------------ */

  async function clickRef(ref) {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Unknown or stale ref "${ref}". Call read_page again.`);
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {
      el.scrollIntoView();
    }
    await sleep(60);
    flashHighlight(el);
    moveCursor(el);

    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: x,
      clientY: y,
      button: 0,
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", base));
      el.dispatchEvent(new PointerEvent("pointerdown", base));
      el.dispatchEvent(new MouseEvent("mousedown", base));
      el.dispatchEvent(new PointerEvent("pointerup", base));
      el.dispatchEvent(new MouseEvent("mouseup", base));
    } catch {}
    try {
      el.focus({ preventScroll: true });
    } catch {}
    if (typeof el.click === "function") {
      el.click();
    } else {
      el.dispatchEvent(new MouseEvent("click", base));
    }
    return `Clicked ${describe(el)}.`;
  }

  async function typeInto(ref, text, { clear = true, submit = false } = {}) {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Unknown or stale ref "${ref}". Call read_page again.`);
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}
    flashHighlight(el);
    moveCursor(el);
    try {
      el.focus({ preventScroll: true });
    } catch {}

    const value = String(text ?? "");

    if (el.isContentEditable) {
      if (clear) el.textContent = "";
      const ok = document.execCommand && document.execCommand("insertText", false, value);
      if (!ok || !(el.textContent || "").includes(value)) {
        el.textContent = (clear ? "" : el.textContent || "") + value;
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: value }));
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto =
        el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      const next = (clear ? "" : el.value || "") + value;
      try {
        setter ? setter.call(el, next) : (el.value = next);
      } catch {
        el.value = next;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      throw new Error(`Element ${ref} is not an editable field.`);
    }

    if (submit) {
      const opts = { bubbles: true, cancelable: true, key: "Enter", code: "Enter" };
      el.dispatchEvent(new KeyboardEvent("keydown", opts));
      el.dispatchEvent(new KeyboardEvent("keyup", opts));
      const form = el.closest && el.closest("form");
      if (form && typeof form.requestSubmit === "function") {
        try {
          form.requestSubmit();
        } catch {}
      }
    }

    return `Typed ${value.length} character(s) into ${describe(el)}${submit ? " and submitted" : ""}.`;
  }

  function pressKey(key) {
    const target = document.activeElement || document.body;
    const opts = { bubbles: true, cancelable: true, key, code: key };
    target.dispatchEvent(new KeyboardEvent("keydown", opts));
    target.dispatchEvent(new KeyboardEvent("keyup", opts));
    return `Pressed ${key}.`;
  }

  function scrollPage({ direction, amount = 600, ref }) {
    const el = ref ? resolveRef(ref) : null;
    const scroller = el || window;
    const delta = direction === "up" ? -amount : amount;
    if (direction === "top") {
      if (el) el.scrollTop = 0;
      else window.scrollTo({ top: 0 });
    } else if (direction === "bottom") {
      if (el) el.scrollTop = el.scrollHeight;
      else window.scrollTo({ top: document.body.scrollHeight });
    } else if (direction === "into" && el) {
      el.scrollIntoView({ block: "center", inline: "nearest" });
      return `Scrolled ${describe(el)} into view.`;
    } else if (el) {
      el.scrollBy({ top: delta, behavior: "instant" });
    } else {
      window.scrollBy({ top: delta, behavior: "instant" });
    }
    return `Scrolled ${direction}${el ? " within element" : ""}.`;
  }

  function readText(maxChars = 50000) {
    const root = document.querySelector("article") || document.querySelector("main") || document.body;
    let text = ((root && root.innerText) || "").replace(/\n{3,}/g, "\n\n").trim();
    const full = text.length;
    const limit = Math.max(200, Number(maxChars) || 50000);
    if (!text) return "(The page has no readable text.)";
    if (text.length > limit) {
      const cut = text.lastIndexOf("\n", limit);
      text = `${text.slice(0, cut > 0 ? cut : limit)}\n[truncated at ${limit} of ${full} characters]`;
    }
    return text;
  }

  /* ------------------------- main-world bridge ------------------------- */

  // page-hooks.js runs in the MAIN world (it can see the page's real console and
  // network activity). Isolated content scripts cannot, so we ask over postMessage.
  const pending = new Map();

  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__autobot_reply) return;
    const entry = pending.get(d.__autobot_reply);
    if (!entry) return;
    pending.delete(d.__autobot_reply);
    entry.resolve(d.payload);
  });

  function requestFromMainWorld(kind, timeout = 1500) {
    return new Promise((resolve) => {
      const reqid = `r${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
      const timer = setTimeout(() => {
        pending.delete(reqid);
        resolve(null);
      }, timeout);
      pending.set(reqid, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      });
      try {
        window.postMessage({ __autobot_request: kind, __autobot_reqid: reqid }, "*");
      } catch {
        clearTimeout(timer);
        pending.delete(reqid);
        resolve(null);
      }
    });
  }

  /* ------------------------------ find --------------------------------- */

  const CLICKABLE_CLIMB = 6;
  const TEXT_SNIPPET_CHARS = 140;
  const NOT_PAGE_TEXT = "[data-autobot-overlay],script,style,noscript,template";

  // The element a click on a piece of text should go to: the row or card
  // around it when the page shows that as clickable, else the text's own element.
  function clickableAncestor(el) {
    try {
      const clickable = (node) => getComputedStyle(node).cursor === "pointer";
      if (!clickable(el)) return el;
      let top = el;
      for (let i = 0; i < CLICKABLE_CLIMB; i++) {
        const parent = top.parentElement;
        if (!parent || parent === document.body || !clickable(parent)) break;
        top = parent;
      }
      return top;
    } catch {
      return el;
    }
  }

  function insideAny(el, elements) {
    for (let node = el; node; node = node.parentElement) {
      if (elements.has(node)) return true;
    }
    return false;
  }

  // Text that is on the page but not inside a control: a row of a list, a
  // table cell, a heading. `controls` holds the controls already reported.
  function findTextMatches(q, controls, limit) {
    const hits = [];
    const seen = new Set();
    let matched = 0;
    if (!document.body) return { hits, matched };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue || !node.nodeValue.toLowerCase().includes(q)) continue;
      const parent = node.parentElement;
      if (!parent || parent.closest(NOT_PAGE_TEXT) || insideAny(parent, controls)) continue;
      if (!isVisible(parent)) continue;
      const target = clickableAncestor(parent);
      if (seen.has(target)) continue;
      seen.add(target);
      matched += 1;
      if (hits.length >= limit) continue;

      const ref = `e${++refCounter}`;
      refMap.set(ref, target);
      try {
        target.setAttribute("data-autobot-ref", ref);
      } catch {}
      const shown = (target.innerText || node.nodeValue).replace(/\s+/g, " ").trim();
      hits.push(`- text "${shown.slice(0, TEXT_SNIPPET_CHARS)}" [ref=${ref}]`);
    }
    return { hits, matched };
  }

  function findElements({ query, role, max = 20 } = {}) {
    const q = String(query || "").trim().toLowerCase();
    const wantRole = role ? String(role).toLowerCase() : null;
    const limit = Math.max(1, Math.min(20, Number(max) || 20));
    const hits = [];
    const controls = new Set();
    let matched = 0;

    const all = document.querySelectorAll(
      "a,button,input,select,textarea,summary,[role],[contenteditable='true'],[tabindex]"
    );

    for (const el of all) {
      if (el.hasAttribute && el.hasAttribute("data-autobot-overlay")) continue;
      if (!isVisible(el)) continue;

      const r = roleOf(el);
      if (wantRole && r !== wantRole) continue;

      const name = accessibleName(el).toLowerCase();
      const text = (el.innerText || "").toLowerCase();
      if (q && !name.includes(q) && !text.includes(q)) continue;
      matched += 1;
      controls.add(el);
      if (hits.length >= limit) continue;

      const ref = `e${++refCounter}`;
      refMap.set(ref, el);
      try {
        el.setAttribute("data-autobot-ref", ref);
      } catch {}
      hits.push(`- ${describe(el)} [ref=${ref}]`);
    }

    // Text outside any control is searched too. Without it a search for words
    // that are plainly on the page (a row of a list) reported nothing, and the
    // agent went looking for them on another site.
    if (q && !wantRole && hits.length < limit) {
      const text = findTextMatches(q, controls, limit - hits.length);
      hits.push(...text.hits);
      matched += text.matched;
    }

    if (!hits.length) {
      const what = `${q ? ` "${query}"` : ""}${wantRole ? ` (role ${wantRole})` : ""}`;
      return `No visible elements or text matched${what}. This searches what is on the page now: read_text shows all of its text, and scrolling or the page's own search box can bring up more.`;
    }
    const more = matched > hits.length ? `\nMore than ${hits.length} matches. Use a more specific query.` : "";
    return `${hits.length} match(es):\n${hits.join("\n")}${more}`;
  }

  /* ---------------------------- form input ---------------------------- */

  async function formInput(ref, value) {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Unknown or stale ref "${ref}". Call read_page again.`);

    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}
    flashHighlight(el);
    moveCursor(el);
    try {
      el.focus({ preventScroll: true });
    } catch {}

    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "text").toLowerCase();

    if (tag === "select") {
      const wanted = String(value ?? "").trim();
      const opts = Array.from(el.options || []);
      const match =
        opts.find((o) => o.value === wanted) ||
        opts.find((o) => o.text.trim() === wanted) ||
        opts.find((o) => o.text.trim().toLowerCase() === wanted.toLowerCase()) ||
        opts.find((o) => o.value.toLowerCase() === wanted.toLowerCase()) ||
        (opts.length === 1 ? opts[0] : null);
      if (!match) {
        throw new Error(
          `No option matching "${wanted}". Options: ${opts
            .map((o) => o.text.trim())
            .slice(0, 30)
            .join(" | ")}`
        );
      }
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      try {
        setter ? setter.call(el, match.value) : (el.value = match.value);
      } catch {
        el.value = match.value;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return `Selected "${match.text.trim()}" in ${describe(el)}.`;
    }

    if (type === "checkbox" || type === "radio") {
      const want =
        value === true ||
        value === 1 ||
        ["true", "1", "on", "yes", "checked"].includes(String(value).toLowerCase());
      if (!!el.checked !== want) {
        try {
          el.click();
        } catch {}
      }
      return `${want ? "Checked" : "Unchecked"} ${describe(el)}.`;
    }

    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) {
      throw new Error(`Element ${ref} is not a form control.`);
    }

    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = value == null ? "" : String(value);
    try {
      setter ? setter.call(el, next) : (el.value = next);
    } catch {
      el.value = next;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Set ${describe(el)} to ${JSON.stringify(next.slice(0, 80))}.`;
  }

  /* --------------------------- hover / drag --------------------------- */

  function hoverRef(ref) {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Unknown or stale ref "${ref}". Call read_page again.`);
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}
    moveCursor(el);
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    };
    try {
      el.dispatchEvent(new PointerEvent("pointerover", base));
      el.dispatchEvent(new PointerEvent("pointerenter", base));
      el.dispatchEvent(new MouseEvent("mouseover", base));
      el.dispatchEvent(new MouseEvent("mousemove", base));
    } catch {}
    return `Hovering ${describe(el)}.`;
  }

  async function dragRef(fromRef, toRef) {
    const from = resolveRef(fromRef);
    const to = resolveRef(toRef);
    if (!from) throw new Error(`Unknown or stale ref "${fromRef}". Call read_page again.`);
    if (!to) throw new Error(`Unknown or stale ref "${toRef}". Call read_page again.`);

    try {
      from.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}

    const fr = from.getBoundingClientRect();
    const tr = to.getBoundingClientRect();
    const at = (r) => ({
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      button: 0,
    });
    const f = at(fr);
    const t = at(tr);

    moveCursor(from);
    try {
      from.dispatchEvent(new PointerEvent("pointerover", f));
      from.dispatchEvent(new PointerEvent("pointerdown", f));
      from.dispatchEvent(new MouseEvent("mousedown", f));
      from.dispatchEvent(new DragEvent("dragstart", f));
      await sleep(40);
      to.dispatchEvent(new PointerEvent("pointermove", t));
      to.dispatchEvent(new MouseEvent("mousemove", t));
      to.dispatchEvent(new DragEvent("dragover", t));
      await sleep(40);
      to.dispatchEvent(new DragEvent("drop", t));
      to.dispatchEvent(new PointerEvent("pointerup", t));
      to.dispatchEvent(new MouseEvent("mouseup", t));
      from.dispatchEvent(new DragEvent("dragend", t));
    } catch {}
    moveCursor(to);
    return `Dragged ${describe(from)} to ${describe(to)}.`;
  }

  /* ------------------------------ upload ------------------------------ */

  async function uploadFile(ref, files, { drop = false } = {}) {
    const el = resolveRef(ref);
    if (!el) throw new Error(`Unknown or stale ref "${ref}". Call read_page again.`);

    const list = Array.isArray(files) ? files : [];
    if (!list.length) throw new Error("No files given.");

    const dt = new DataTransfer();
    for (const f of list) {
      let blob;
      if (f.dataUrl) blob = await (await fetch(f.dataUrl)).blob();
      else if (f.url) blob = await (await fetch(f.url)).blob();
      else blob = new Blob([String(f.text || "")], { type: f.mimeType || "text/plain" });

      const name = f.name || `upload-${Date.now()}`;
      const mime = f.mimeType || blob.type || "application/octet-stream";
      dt.items.add(new File([blob], name, { type: mime }));
    }

    const isFileInput =
      el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "file";

    if (isFileInput && !drop) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files")?.set;
      try {
        setter ? setter.call(el, dt.files) : (el.files = dt.files);
      } catch {
        el.files = dt.files;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return `Attached ${dt.files.length} file(s) to ${describe(el)}.`;
    }

    // Drop-zone path: dispatch a real drag sequence carrying the files.
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    } catch {}
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
      dataTransfer: dt,
    };
    try {
      el.dispatchEvent(new DragEvent("dragenter", base));
      el.dispatchEvent(new DragEvent("dragover", base));
      await sleep(40);
      el.dispatchEvent(new DragEvent("drop", base));
    } catch (e) {
      throw new Error(`Drop failed: ${e?.message || e}`);
    }
    return `Dropped ${dt.files.length} file(s) onto ${describe(el)}.`;
  }

  /* ------------------------- console / network ------------------------- */

  const taughtSteps = [];
  let teaching = false;
  document.addEventListener(
    "click",
    (event) => {
      if (!teaching) return;
      const el = event.target;
      if (el?.closest?.("[data-autobot-overlay]")) return;
      taughtSteps.push({
        action: "click",
        text: String(el?.innerText || el?.getAttribute?.("aria-label") || el?.tagName || "")
          .trim()
          .slice(0, 80),
        url: location.href,
      });
    },
    true
  );

  async function readConsole(limit = 100, options = {}) {
    const logs = await requestFromMainWorld("console");
    if (!logs) {
      return "(No console output captured. The page may have loaded before Akron's hooks were installed; reload the page and try again.)";
    }
    let slice = logs.slice();
    if (options.onlyErrors) slice = slice.filter((entry) => entry.level === "error");
    if (options.pattern) {
      try {
        const expression = new RegExp(options.pattern, "i");
        slice = slice.filter((entry) => expression.test(entry.text || ""));
      } catch {
        return "pattern is not a valid regular expression";
      }
    }
    slice = slice.slice(-Math.max(1, Math.min(300, Number(limit) || 100)));
    if (!slice.length) return "(Console is empty.)";
    return slice.map((l) => `[${l.level}] ${l.text}`).join("\n");
  }

  async function readNetwork(limit = 100) {
    const net = await requestFromMainWorld("network");
    if (!net) {
      return "(No network activity captured. The page may have loaded before Akron's hooks were installed; reload the page and try again.)";
    }
    const slice = net.slice(-Math.max(1, Math.min(300, Number(limit) || 100)));
    if (!slice.length) return "(No requests recorded.)";
    return slice
      .map(
        (n) =>
          `${n.method} ${n.status || (n.error ? "ERR" : "?")} ${n.url}${
            n.ms ? ` (${n.ms}ms)` : ""
          }`
      )
      .join("\n");
  }

  /* ---------------------------- message bus ---------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.channel !== "autobot") return false;

    (async () => {
      try {
        const { cmd, args } = msg;
        let result;
        switch (cmd) {
          case "ping":
            result = "pong";
            break;
          case "snapshot":
            result = snapshot(args || {});
            break;
          case "read_text":
            result = readText(args?.maxChars);
            break;
          case "click":
            result = await clickRef(args?.ref);
            break;
          case "type":
            result = await typeInto(args?.ref, args?.text, {
              clear: args?.clear !== false,
              submit: !!args?.submit,
            });
            break;
          case "press_key":
            result = pressKey(args?.key || "Enter");
            break;
          case "find":
            result = findElements({
              query: args?.query,
              role: args?.role,
              max: args?.max,
            });
            break;
          case "form_input":
            result = await formInput(args?.ref, args?.value);
            break;
          case "hover":
            result = hoverRef(args?.ref);
            break;
          case "drag":
            result = await dragRef(args?.from, args?.to);
            break;
          case "upload":
            result = await uploadFile(args?.ref, args?.files, { drop: !!args?.drop });
            break;
          case "read_console":
            result = await readConsole(args?.limit, args || {});
            break;
          case "teach_start":
            teaching = true;
            taughtSteps.length = 0;
            result = "Recording. Click through the task, then stop teaching.";
            break;
          case "teach_stop":
            teaching = false;
            result = taughtSteps.slice();
            break;
          case "read_network":
            result = await readNetwork(args?.limit);
            break;
          case "read_clipboard":
            try {
              result = await navigator.clipboard.readText();
            } catch (e) {
              throw new Error(
                "Clipboard read was blocked. Click on the page first and try again."
              );
            }
            break;
          case "write_clipboard":
            try {
              await navigator.clipboard.writeText(String(args?.text ?? ""));
              result = `Wrote ${String(args?.text ?? "").length} character(s) to the clipboard.`;
            } catch (e) {
              throw new Error("Clipboard write was blocked. Click on the page first and try again.");
            }
            break;
          case "scroll":
            result = scrollPage({
              direction: args?.direction || "down",
              amount: Number(args?.amount) || 600,
              ref: args?.ref,
            });
            break;
          case "step":
            setStep(args?.label);
            result = "ok";
            break;
          case "working":
            setWorking(!!args?.on, !!args?.needsInput);
            result = "ok";
            break;
          case "pointer":
            pointAt(Number(args?.x), Number(args?.y), args?.acting !== false);
            result = "ok";
            break;
          case "overlay_hidden":
            await setOverlayHidden(!!args?.hidden);
            result = "ok";
            break;
          default:
            throw new Error(`Unknown command: ${cmd}`);
        }
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();

    return true; // async response
  });
})();
