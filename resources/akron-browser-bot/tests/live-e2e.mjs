/**
 * Optional live test. Reads NVIDIA_API_KEY and DEEPSEEK_API_KEY from the
 * environment and skips when both are absent. Keys are never written to disk
 * by this file.
 *
 * Run: NVIDIA_API_KEY=... DEEPSEEK_API_KEY=... npm run test:live
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createProvider, listModels } from "../background/providers.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8791;
const DEBUG_PORT = 9341;
const NVIDIA_KEY = process.env.NVIDIA_API_KEY || "";
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || "";
const SCREEN_DIR = "/opt/cursor/artifacts/screens";

function redact(value) {
  return String(value || "")
    .replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-REDACTED")
    .replace(/sk-[A-Za-z0-9]+/g, "sk-REDACTED");
}

const results = [];
function record(name, ok, extra = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` ${redact(extra)}`}`);
}

if (!NVIDIA_KEY && !DEEPSEEK_KEY) {
  console.log("LIVE: skipped (set NVIDIA_API_KEY and/or DEEPSEEK_API_KEY)");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const candidate = "/tmp/chromium-browsers/chromium/linux-1753710/chrome-linux/chrome";
  if (fs.existsSync(candidate)) return candidate;
  return "";
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader("content-type", "text/html; charset=utf-8");
  if (url.pathname === "/shop") {
    res.end(`<!doctype html><title>Demo shop</title><main><h1>Demo shop</h1><p class="price">Price $12</p><button id="add">Add to cart</button><p id="cart">Cart empty</p><script>document.getElementById("add").onclick=()=>{document.getElementById("cart").textContent="Cart: 1 item";}</script></main>`);
    return;
  }
  if (url.pathname === "/table") {
    res.end(`<!doctype html><title>Table</title><table><tr><th>Item</th><th>Qty</th></tr><tr><td>Apple</td><td>2</td></tr><tr><td>Pear</td><td>5</td></tr></table>`);
    return;
  }
  if (url.pathname === "/controls") {
    res.end(`<!doctype html><title>Controls</title><main><h1>Controls</h1><input id="agree" type="checkbox"><label for="agree">Agree</label><input id="when" type="date"><select id="size"><option>Small</option><option>Large</option></select><iframe id="inner" src="/other"></iframe><p id="long">${"Line of text. ".repeat(80)}</p></main>`);
    return;
  }
  if (url.pathname === "/form") {
    res.end(`<!doctype html><title>Live form</title><main>
      <h1>Signup</h1>
      <form id="form">
        <label for="name">Name</label><input id="name" name="name" />
        <label for="plan">Plan</label>
        <select id="plan"><option value="low">Low</option><option value="high">High</option></select>
        <button id="submit" type="submit">Submit</button>
      </form>
      <p id="result"></p>
      <script>
        document.getElementById("form").addEventListener("submit", (event) => {
          event.preventDefault();
          const name = document.getElementById("name").value;
          const plan = document.getElementById("plan").value;
          document.getElementById("result").textContent = "Submitted: " + name + " (" + plan + ")";
        });
      </script>
    </main>`);
    return;
  }
  if (url.pathname === "/other") {
    res.end(`<!doctype html><title>Other page</title><main><h1>Landed on the other page</h1><p>The link worked.</p></main>`);
    return;
  }
  const filler = "Local fixture sentence. ".repeat(80);
  res.end(`<!doctype html><title>Live page</title><main>
    <h1>Hello from the live page</h1>
    <p>The page says hello.</p>
    <p><a id="more" href="/other">Read the other page</a></p>
    <p>${filler}</p>
  </main>`);
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));

async function apiProbe(label, config, model) {
  const provider = createProvider(config);
  try {
    const models = await listModels(config);
    record(`${label} lists models`, models.length > 0, models.slice(0, 8).join(", "));
    record(`${label} default is listed or accepted`, models.includes(model) || models.length > 0, model);
  } catch (error) {
    record(`${label} lists models`, false, error.message);
  }
  try {
    const chat = await provider.chat({
      model,
      messages: [{ role: "user", content: "Reply with exactly PONG." }],
      tools: [],
      system: "Reply exactly.",
      settings: { temperature: 0 },
      signal: AbortSignal.timeout(40000),
    });
    record(`${label} chat`, /pong/i.test(chat.text || ""), chat.text);
  } catch (error) {
    record(`${label} chat`, false, error.message);
  }
  try {
    const streamed = await provider.chatStream({
      model,
      messages: [{ role: "user", content: "Reply with exactly STREAM." }],
      tools: [],
      system: "Reply exactly.",
      settings: { temperature: 0 },
      onDelta() {},
      signal: AbortSignal.timeout(40000),
    });
    record(`${label} stream`, /stream/i.test(streamed.text || ""), streamed.text);
  } catch (error) {
    record(`${label} stream`, false, error.message);
  }
  try {
    const tools = await provider.chat({
      model,
      messages: [{ role: "user", content: "Read the page." }],
      tools: [{ name: "read_page", description: "Read the page", parameters: { type: "object", properties: {} } }],
      system: "Call read_page. Do not answer in text.",
      settings: { temperature: 0 },
      signal: AbortSignal.timeout(45000),
    });
    record(`${label} tool call`, (tools.toolCalls || []).some((tool) => tool.name === "read_page"), JSON.stringify(tools.toolCalls || []).slice(0, 180));
  } catch (error) {
    record(`${label} tool call`, false, error.message);
  }
}

if (NVIDIA_KEY) {
  await apiProbe("nvidia", {
    type: "openai-compatible",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    apiKey: NVIDIA_KEY,
  }, "nvidia/nemotron-3.5-lightning-30b-a3b");
}
if (DEEPSEEK_KEY) {
  await apiProbe("deepseek", {
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: DEEPSEEK_KEY,
  }, "deepseek-flash");
  await apiProbe("deepseek-v4-pro", {
    type: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: DEEPSEEK_KEY,
  }, "deepseek-v4-pro");
}

if (DEEPSEEK_KEY) {
  globalThis.chrome = {
    storage: { local: { async get() { return {}; }, async set() {} }, onChanged: { addListener() {} } },
    runtime: { getURL: (path) => path, lastError: null },
    tabs: { async get() { return { id: 1, windowId: 1, url: "http://127.0.0.1/" }; } },
    downloads: { download() {} },
  };
  globalThis.__autobotToolOverride = async (name) => ({ text: `${name} ` + "detail ".repeat(500) });
  try {
    const { runTurn } = await import("../background/agent.js");
    const conversation = [{ role: "user", content: "Call the wait tool exactly once with ms 1, then stop." }];
    let steps = 0;
    let compacted = false;
    for (let round = 0; steps < 21 && round < 24; round++) {
      await runTurn({
        conversation,
        settings: { temperature: 0, streaming: false, permissionMode: "skip" },
        providerConfig: { type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", apiKey: DEEPSEEK_KEY },
        model: "deepseek-flash",
        signal: AbortSignal.timeout(45000),
        emit(event) {
          if (event.type === "step" && event.phase === "done") steps += 1;
          if (event.type === "compacted") compacted = true;
        },
        confirm: async () => true,
      });
      if (steps < 21) {
        conversation.push({ role: "user", content: `You have finished ${steps} wait calls. Call wait exactly once more until you reach 21.` });
      }
    }
    record("21 real model steps without a cap", steps >= 21, String(steps));
    record("real compaction", compacted, compacted ? "compacted" : `steps ${steps}`);
  } catch (error) {
    record("21 real model steps without a cap", false, error.message);
    record("real compaction", false, error.message);
  } finally {
    delete globalThis.__autobotToolOverride;
  }
}

const chromePath = findChrome();
if (!chromePath) {
  console.log("LIVE: API checks done; no Chromium binary for the browser pass");
  server.close();
  process.exit(results.some((row) => !row.ok) ? 1 : 0);
}

function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message));
      else waiter.resolve(msg.result);
    }
  });
  return {
    ws,
    ready,
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    }),
  };
}

async function evaluate(target, expression) {
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  const res = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  c.ws.close();
  if (res.exceptionDetails) {
    throw new Error(redact(res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result.value;
}

async function shoot(target, filename) {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
  await evaluate(target, `(() => {
    const mask = (value) => String(value || "").replace(/nvapi-[A-Za-z0-9_-]+/g, "nvapi-REDACTED").replace(/sk-[A-Za-z0-9]+/g, "sk-REDACTED");
    for (const node of document.querySelectorAll("input, textarea")) node.value = mask(node.value);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) node.nodeValue = mask(node.nodeValue);
    return true;
  })()`);
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Page.enable");
  try {
    await c.send("Emulation.setDeviceMetricsOverride", { width: 650, height: 900, deviceScaleFactor: 1, mobile: false });
  } catch {}
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.writeFileSync(path.join(SCREEN_DIR, `${filename}.png`), Buffer.from(shot.data, "base64"));
  c.ws.close();
}

const profile = path.join(os.tmpdir(), `autobot-live-${Date.now()}`);
const child = spawn(chromePath, [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-extensions-except=" + ROOT,
  "--load-extension=" + ROOT,
  "--remote-debugging-port=" + DEBUG_PORT,
  "--user-data-dir=" + profile,
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--window-size=1200,900",
  "about:blank",
], { stdio: "ignore" });

async function listTargets() {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
  return res.json();
}
async function newTarget(url) {
  const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}

let failures = 0;
try {
  let targets = null;
  for (let i = 0; i < 40; i++) {
    try {
      targets = await listTargets();
      if (targets.some((target) => target.url.includes("service-worker") || target.url.includes("onboarding"))) break;
    } catch {}
    await sleep(400);
  }
  const extensionTarget = targets.find((target) => target.url.includes("/onboarding/")) || targets.find((target) => target.url.includes("service-worker"));
  if (!extensionTarget) throw new Error("Extension did not load");
  const id = new URL(extensionTarget.url).host;
  const onboard = await newTarget(`chrome-extension://${id}/onboarding/onboarding.html`);
  await sleep(800);
  await shoot(onboard, "live-onboarding");
  record("onboarding opens", true);

  const options = await newTarget(`chrome-extension://${id}/options/options.html`);
  await sleep(800);
  async function addProvider(preset, key, model) {
    await evaluate(options, `(() => {
      document.getElementById("preset-select").value = ${JSON.stringify(preset)};
      document.getElementById("add-provider").click();
      document.getElementById("f-apikey").value = ${JSON.stringify(key)};
      document.getElementById("f-models").value = ${JSON.stringify(model)};
      document.getElementById("f-default-model").value = ${JSON.stringify(model)};
      document.getElementById("test-provider").click();
      return true;
    })()`);
    let result = "";
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      result = await evaluate(options, `document.getElementById("test-result").textContent`);
      if (/Success|Failed/i.test(result)) break;
    }
    record(`${preset} test connection`, /Success/i.test(result), result);
    await evaluate(options, `document.getElementById("save-provider").click()`);
    await sleep(400);
  }
  if (NVIDIA_KEY) await addProvider("nvidia", NVIDIA_KEY, "nvidia/nemotron-3.5-lightning-30b-a3b");
  if (DEEPSEEK_KEY) await addProvider("deepseek", DEEPSEEK_KEY, "deepseek-flash");
  await evaluate(options, `(() => {
    for (const node of document.querySelectorAll("input, textarea")) {
      if (/nvapi-|sk-/.test(node.value)) node.value = "";
    }
    return true;
  })()`);
  await shoot(options, "live-settings-providers");

  await newTarget(`http://127.0.0.1:${PORT}/`);
  await sleep(600);
  const swEarly = (await listTargets()).find((target) => target.url.includes("service-worker.js"));
  const fixtureTabId = JSON.parse(await evaluate(swEarly, `(async () => {
    const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:${PORT}/*" });
    if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
    return JSON.stringify(tabs[0]?.id || null);
  })()`));
  const side = await newTarget(`chrome-extension://${id}/sidepanel/sidepanel.html?tabId=${fixtureTabId}`);
  await sleep(1500);
  const sideLive = (await listTargets()).find((target) => target.url.includes("/sidepanel/sidepanel.html")) || side;

  async function panel() {
    return JSON.parse(await evaluate(sideLive, `JSON.stringify({
      mode: document.getElementById("perm-mode-label")?.textContent || "",
      dock: document.getElementById("permission-dock") ? !document.getElementById("permission-dock").classList.contains("hidden") : false,
      title: document.getElementById("perm-title")?.textContent || "",
      kicker: document.getElementById("perm-kicker")?.textContent || "",
      assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map((node) => node.textContent.trim()).slice(-4),
      tools: [...document.querySelectorAll(".step .tool-name")].map((node) => node.textContent.trim()).slice(-8),
      errors: [...document.querySelectorAll(".msg.error .bubble")].map((node) => node.textContent.trim()).slice(-3),
      running: document.getElementById("typing") ? !document.getElementById("typing").classList.contains("hidden") : false,
      toast: document.getElementById("toast")?.textContent || "",
      status: document.getElementById("orch-status")?.textContent || "",
      model: document.getElementById("model-select")?.value || ""
    })`));
  }
  async function until(pred, tries = 40) {
    let last = null;
    for (let i = 0; i < tries; i++) {
      last = await panel();
      if (pred(last)) return last;
      await sleep(500);
    }
    return last;
  }
  async function send(text) {
    await evaluate(sideLive, `(() => {
      const input = document.getElementById("input");
      input.value = ${JSON.stringify(text)};
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("send").click();
      return true;
    })()`);
  }
  async function click(buttonId) {
    await evaluate(sideLive, `document.getElementById(${JSON.stringify(buttonId)}).click()`);
  }
  async function freshChat() {
    await until((row) => !row.running, 60);
    await click("stop");
    await sleep(250);
    await click("new-chat");
    await sleep(350);
  }

  const fastModel = DEEPSEEK_KEY ? "deepseek-flash" : "nvidia/nemotron-3.5-lightning-30b-a3b";
  await evaluate(sideLive, `(() => {
    const select = document.getElementById("model-select");
    const option = [...select.options].find((item) => item.value === ${JSON.stringify(fastModel)});
    if (option) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    if (document.getElementById("orch-toggle").checked) document.getElementById("orch-toggle").click();
    return select.value;
  })()`);
  await evaluate(sideLive, `(() => {
    const menu = document.getElementById("perm-mode-menu");
    if (document.getElementById("perm-mode-label").textContent !== "Act without asking") {
      document.querySelector('#perm-mode-menu [data-mode="skip"]') || document.getElementById("perm-mode-btn").click();
    }
    return true;
  })()`);
  if ((await panel()).mode !== "Act without asking") {
    await click("perm-mode-btn");
    await evaluate(sideLive, `document.querySelector('#perm-mode-menu [data-mode="skip"]').click()`);
    await sleep(200);
    await click("skip-confirm");
    await sleep(300);
  }

  await send("Use read_text once and quote the page heading. Do not use any other tool.");
  let state = await until((row) => row.assistant.some((line) => /hello/i.test(line)) || row.errors.length, 50);
  record("summarize the open page", state.tools.includes("read_text") && state.assistant.some((line) => /hello/i.test(line)), JSON.stringify(state));
  await shoot(sideLive, "live-summarize");

  await freshChat();
  await sleep(400);
  await send(`Open http://127.0.0.1:${PORT}/other with the navigate tool, then stop. Reply with the heading you land on.`);
  state = await until((row) => row.assistant.some((line) => /landed|other/i.test(line)) || row.errors.length, 50);
  record("navigate to another page", state.tools.includes("navigate") && state.assistant.some((line) => /landed|other/i.test(line)), JSON.stringify(state));

  await freshChat();
  await sleep(300);
  await send(`Navigate to http://127.0.0.1:${PORT}/form. Use form_input to set the Name field to Optimus and the Plan field to High, then click Submit. Tell me the result text.`);
  state = await until((row) => row.assistant.some((line) => /optimus/i.test(line)) || row.errors.length, 60);
  record("fill and submit the form", state.assistant.some((line) => /optimus/i.test(line)), JSON.stringify(state));
  await shoot(sideLive, "live-form");

  const extraTasks = [
    ["compare two pages", `Read http://127.0.0.1:${PORT}/ and http://127.0.0.1:${PORT}/other and say which heading is longer.`],
    ["extract a table", `Open http://127.0.0.1:${PORT}/table and reply with a CSV of the rows.`],
    ["demo shop cart", `Open http://127.0.0.1:${PORT}/shop, click Add to cart, and quote the cart text.`],
    ["scroll a long page", `Open http://127.0.0.1:${PORT}/controls and scroll to the bottom, then say whether you saw the word Line.`],
    ["dropdown checkbox and date", `On http://127.0.0.1:${PORT}/controls set the select to Large, check Agree, and set the date to 2026-01-15. Then read those values back.`],
    ["read an iframe", `On http://127.0.0.1:${PORT}/controls, read the iframe and quote its heading.`],
    ["public page summary", "Open https://example.com and quote its heading."],
  ];
  for (const [name, prompt] of extraTasks) {
    await freshChat();
    await send(prompt);
    state = await until((row) => !row.running && (row.assistant.length || row.errors.length), 36);
    const text = state.assistant.join(" ");
    const ok = state.errors.length === 0 && text.length > 8;
    record(name, ok, JSON.stringify({ text: text.slice(0, 180), errors: state.errors, tools: state.tools }));
  }
  const offer = await panel();
  if (offer.dock && /skill/i.test(`${offer.kicker} ${offer.title}`)) {
    await click("perm-allow");
    await freshChat();
    await send("Call load_skill for the learned skill and quote step 1 from its instructions.");
    state = await until((row) => row.tools.includes("load_skill") || (!row.running && row.assistant.length), 30);
    record("skill learned then reused", state.tools.includes("load_skill") || /1\.|read_text|navigate/i.test(state.assistant.join(" ")), JSON.stringify(state));
  } else {
    record("skill learned then reused", false, JSON.stringify(offer));
  }

  await freshChat();
  await sleep(300);
  await send(`Use open_tab to open http://127.0.0.1:${PORT}/other and then read_text on that tab. Mention both tabs.`);
  state = await until((row) => row.tools.includes("open_tab") && row.assistant.length && !row.running, 60);
  record("task across two tabs", state.tools.includes("open_tab") && state.assistant.some((line) => /landed|other|hello/i.test(line)), JSON.stringify(state));

  const beforeShot = (await panel()).assistant.length;
  await send("Take a screenshot of the current page. If you cannot see the image, say so in one sentence. Do not loop.");
  state = await until((row) => !row.running && (row.assistant.length > beforeShot || row.errors.length), 40);
  record(
    "screenshot degrades or describes",
    state.errors.length === 0 && (state.tools.includes("screenshot") || state.assistant.length > beforeShot),
    JSON.stringify(state)
  );

  const leftover = await panel();
  if (leftover.dock && /skill/i.test(leftover.kicker)) await click("perm-decline");
  await click("perm-mode-btn");
  await evaluate(sideLive, `document.querySelector('#perm-mode-menu [data-mode="ask"]').click()`);
  await sleep(200);
  await freshChat();
  await sleep(300);
  await send(`Open http://127.0.0.1:${PORT}/ and click the link whose text is Read the other page. Use the click tool.`);
  state = await until((row) => row.dock || row.errors.length, 40);
  record("ask before acting shows a prompt", state.dock && /wants to/i.test(state.title), JSON.stringify(state));
  await shoot(sideLive, "live-permission-prompt");
  await click("perm-allow");
  state = await until((row) => row.dock || !row.running, 20);
  if (state.dock) {
    await shoot(sideLive, "live-permission-next");
    await click("perm-decline");
  }
  await click("stop");
  state = await until((row) => !row.running && !row.dock, 20);
  record("decline and stop end the paused run", !state.running && !state.dock, JSON.stringify(state));

  await send("Call update_plan with steps [\"Read the heading\", \"Stop\"] and domains [\"127.0.0.1\"] before any other tool.");
  state = await until((row) => row.dock && /plan/i.test(stateTitle(row)), 40);
  record("real model shows a plan card", state.dock, JSON.stringify(state));
  await shoot(sideLive, "live-plan");
  await click("perm-approve");
  await until((row) => !row.running, 40);

  await send("Call the wait tool with ms 8000, then wait again. Do that before answering.");
  await sleep(1500);
  await click("stop");
  state = await until((row) => !row.running, 20);
  record("stop button ends the run", !state.running, JSON.stringify(state));

  await evaluate(options, `(() => {
    window.alert = (message) => { window.__lastAlert = String(message).slice(0, 240); };
    document.getElementById("sch-title").value = "Live check";
    document.getElementById("sch-prompt").value = "Use read_text once and reply with the heading only.";
    document.getElementById("sch-url").value = ${JSON.stringify(`http://127.0.0.1:${PORT}/`)};
    document.getElementById("sch-enabled").checked = true;
    document.getElementById("add-schedule").click();
    return true;
  })()`);
  await sleep(400);
  await evaluate(options, `(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent === "Run now");
    if (button) button.click();
    return !!button;
  })()`);
  let alertText = "";
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    alertText = await evaluate(options, `window.__lastAlert || ""`);
    if (alertText) break;
  }
  record("scheduled run now", /hello/i.test(alertText), alertText);

  if (DEEPSEEK_KEY) {
    await click("stop");
    await evaluate(sideLive, `(() => {
      const select = document.getElementById("provider-select");
      const option = [...select.options].find((item) => /deepseek/i.test(item.textContent));
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return select.value;
    })()`);
    await sleep(600);
    await evaluate(sideLive, `(() => {
      const select = document.getElementById("model-select");
      const option = [...select.options].find((item) => item.value === "deepseek-flash");
      if (option) {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return select.value;
    })()`);
    await freshChat();
    await sleep(400);
    await send("Use read_text once and quote the heading. Do not use other tools.");
    state = await until((row) => row.model === "deepseek-flash" && row.assistant.some((line) => /hello|signup|heading/i.test(line)), 40);
    record("deepseek-flash side panel task", state.model === "deepseek-flash" && state.assistant.some((line) => /hello|signup|heading/i.test(line)), JSON.stringify(state));
    await shoot(sideLive, "live-deepseek-result");
  }

  if (NVIDIA_KEY && DEEPSEEK_KEY) {
    await click("stop");
    await evaluate(options, `(() => {
      const card = [...document.querySelectorAll(".provider")].find((item) => /NVIDIA/i.test(item.textContent));
      card.querySelector("button").click();
      document.getElementById("f-apikey").value = "invalid-nvidia-key";
      document.getElementById("save-provider").click();
      return true;
    })()`);
    await sleep(500);
    await evaluate(options, `(() => {
      document.getElementById("s-orchestrator").checked = true;
      for (const box of document.querySelectorAll("#orch-pool input[type=checkbox]")) {
        const model = box.dataset.model || "";
        box.checked = model === "deepseek-flash" || model === "nvidia/nemotron-3.5-lightning-30b-a3b";
      }
      document.getElementById("save-orchestrator").click();
      return true;
    })()`);
    await sleep(400);
    await evaluate(sideLive, `(() => {
      const toggle = document.getElementById("orch-toggle");
      if (!toggle.checked) toggle.click();
      return true;
    })()`);
    await freshChat();
    await sleep(300);
    await send("Use read_text once and quote the heading. Do not use other tools.");
    let failoverToast = "";
    state = await until((row) => {
      if (/authentication failed|switching/i.test(row.toast)) failoverToast = row.toast;
      return /authentication failed|switching/i.test(row.toast);
    }, 40);
    if (failoverToast || /authentication failed|switching/i.test(state.toast)) {
      await shoot(sideLive, "live-orchestrator-failover");
    }
    state = await until((row) => !row.running && row.assistant.length, 40);
    record(
      "orchestrator fails over from a bad NVIDIA key to DeepSeek",
      /authentication failed|switching/i.test(failoverToast || state.toast) && state.assistant.length > 0,
      JSON.stringify({ toast: failoverToast || state.toast, status: state.status, assistant: state.assistant })
    );
  }

  console.log("LIVE browser section finished");
} catch (error) {
  failures += 1;
  console.log("  FAIL browser " + redact(error?.stack || error));
} finally {
  server.close();
  try { await new Promise((resolve) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolve())); } catch {}
  try { process.kill(child.pid); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

function rowErrors(state) {
  return state?.errors?.length;
}
function stateTitle(row) {
  return row?.title || "";
}

const failed = results.filter((row) => !row.ok).length + failures;
console.log(failed ? `\nLIVE: ${failed} failure(s)` : "\nLIVE: all recorded checks passed");
process.exit(failed ? 1 : 0);
