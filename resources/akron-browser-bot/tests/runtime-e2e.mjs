// Optional real-browser end-to-end test.
//
// Launches a Chromium build with the unpacked extension, starts a local mock
// OpenAI-compatible provider, then drives the side panel through one complete
// agent task (prompt -> tool call -> tool result -> final answer).
//
// Run with:  npm run test:runtime
// Requires a Chromium/Chrome binary that accepts --load-extension. Set
// CHROME_PATH to override auto-detection.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8788;
const DEBUG_PORT = 9336;
const BASE = `http://127.0.0.1:${DEBUG_PORT}`;

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  for (const root of [
    path.join(local, "ms-playwright"),
    path.join(os.homedir(), ".cache", "ms-playwright"),
  ]) {
    try {
      const versions = fs
        .readdirSync(root)
        .filter((d) => d.startsWith("chromium-"))
        .sort()
        .reverse();
      for (const v of versions) {
        for (const rel of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome"]) {
          const p = path.join(root, v, rel);
          if (fs.existsSync(p)) return p;
        }
      }
    } catch {}
  }
  for (const p of [
    "/tmp/chromium-browsers/chromium/linux-1753710/chrome-linux/chrome",
    "/usr/local/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ]) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error("No Chromium found. Set CHROME_PATH to a Chromium/Chrome binary.");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function listTargets() {
  const res = await fetch(`${BASE}/json/list`);
  return res.json();
}
async function newTarget(url) {
  const res = await fetch(`${BASE}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}
function client(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, ready, send };
}
async function evaluate(target, expression) {
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  const res = await c.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  c.ws.close();
  if (res.exceptionDetails) {
    throw new Error(
      res.exceptionDetails.exception?.description || res.exceptionDetails.text || "evaluation failed"
    );
  }
  return res.result.value;
}

/* ------------------------------ mock provider ------------------------------ */

const server = http.createServer((req, res) => {
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
  };
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors);
    res.end();
    return;
  }
  if (req.url === "/v1/models") {
    res.writeHead(200, { ...cors, "content-type": "application/json" });
    res.end(
      JSON.stringify({
        object: "list",
        data: [{ id: "mock-model" }, { id: "mock-model-2" }],
      })
    );
    return;
  }
  if (req.url.startsWith("/test")) {
    res.writeHead(200, { ...cors, "content-type": "text/html" });
    res.end(`<!doctype html><html><head><title>Autobot Test Page</title></head><body>
      <main>
        <h1>Hello from the test page</h1>
        <p>The page says hello.</p>
        <label for="email">Email</label>
        <input id="email" name="email" value="" />
        <button id="go" type="button">Continue</button>
        <input id="file" type="file" />
      </main>
      <script>
        console.log("autobot-console-marker");
        fetch("/v1/models").catch(() => {});
      </script>
    </body></html>`);
    return;
  }
  if (req.url.startsWith("/v1/chat/completions") && req.method === "POST") {
    const auth = String(req.headers.authorization || "");
    if (auth !== "Bearer good-key") {
      req.resume();
      res.writeHead(401, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid orchestrator key" } }));
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {}
      const messages = parsed.messages || [];
      let lastUser = "";
      let lastUserAt = -1;
      for (let i = 0; i < messages.length; i++) {
        if (messages[i].role !== "user") continue;
        lastUserAt = i;
        const content = messages[i].content;
        lastUser = typeof content === "string" ? content : JSON.stringify(content || "");
      }
      const laterTools = messages.slice(lastUserAt + 1).filter((m) => m.role === "tool");
      const toolMessages = messages.filter((m) => m.role === "tool");
      let payload;
      if (lastUser.includes("PERM-")) {
        const latest = String(laterTools.at(-1)?.content || "");
        if (!laterTools.length && lastUser.includes("PERM-PLAN")) {
          payload = {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call_plan",
                  type: "function",
                  function: {
                    name: "update_plan",
                    arguments: JSON.stringify({
                      steps: ["Read the page"],
                      domains: ["127.0.0.1"],
                      status: "in_progress",
                    }),
                  },
                }],
              },
              finish_reason: "tool_calls",
            }],
          };
        } else if (!laterTools.length) {
          payload = {
            choices: [{
              message: {
                role: "assistant",
                content: "",
                tool_calls: [{
                  id: "call_click",
                  type: "function",
                  function: { name: "click", arguments: JSON.stringify({ ref: "e1" }) },
                }],
              },
              finish_reason: "tool_calls",
            }],
          };
        } else if (latest.includes("rejected")) {
          payload = { choices: [{ message: { role: "assistant", content: "Plan was rejected." }, finish_reason: "stop" }] };
        } else if (lastUser.includes("PERM-PLAN")) {
          payload = { choices: [{ message: { role: "assistant", content: "Plan went through." }, finish_reason: "stop" }] };
        } else if (latest.includes("declined")) {
          payload = { choices: [{ message: { role: "assistant", content: "Declined the click." }, finish_reason: "stop" }] };
        } else {
          payload = { choices: [{ message: { role: "assistant", content: "Clicked." }, finish_reason: "stop" }] };
        }
      } else if (!toolMessages.length) {
        payload = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_read",
                    type: "function",
                    function: { name: "read_text", arguments: "{}" },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      } else if (toolMessages.length === 1) {
        payload = {
          choices: [
            {
              message: {
                role: "assistant",
                content: "",
                tool_calls: [
                  {
                    id: "call_open",
                    type: "function",
                    function: {
                      name: "open_tab",
                      arguments: JSON.stringify({
                        url: `http://127.0.0.1:${PORT}/test?second=1`,
                        active: true,
                      }),
                    },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        };
      } else {
        payload = {
          choices: [
            {
              message: { role: "assistant", content: "The page says hello." },
              finish_reason: "stop",
            },
          ],
        };
      }
      res.writeHead(200, { ...cors, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
    return;
  }
  res.writeHead(404, cors);
  res.end("not found");
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

/* ------------------------------- launch Chrome ------------------------------- */

const voiceWav = path.join(os.tmpdir(), "autobot-voice.wav");
const voiceRaw = path.join(os.tmpdir(), "autobot-voice-raw.wav");
let voiceAvailable = false;
try {
  await new Promise((resolve, reject) => {
    execFile("espeak-ng", ["-w", voiceRaw, "-s", "120", "-v", "en-us", "hello"], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      ["-y", "-i", voiceRaw, "-af", "apad=pad_dur=4", "-ar", "48000", "-ac", "2", voiceWav],
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });
  voiceAvailable = true;
} catch {
  // Windows has no espeak-ng/ffmpeg by default; its built-in voice makes the
  // same clip: the word "hello", then 4 s of silence, 48 kHz stereo.
  try {
    if (process.platform !== "win32") throw new Error("not Windows");
    const script = [
      "Add-Type -AssemblyName System.Speech",
      "$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Stereo)",
      "$voice = New-Object System.Speech.Synthesis.SpeechSynthesizer",
      "$voice.SetOutputToWaveFile($env:AUTOBOT_VOICE_WAV, $format)",
      "$prompt = New-Object System.Speech.Synthesis.PromptBuilder",
      "$prompt.AppendText('hello')",
      "$prompt.AppendBreak([TimeSpan]::FromSeconds(4))",
      "$voice.Speak($prompt)",
      "$voice.Dispose()",
    ].join("; ");
    await new Promise((resolve, reject) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { env: { ...process.env, AUTOBOT_VOICE_WAV: voiceWav } },
        (error) => {
          if (error) reject(error);
          else resolve();
        }
      );
    });
    voiceAvailable = fs.statSync(voiceWav).size > 44;
  } catch {
    console.log("  skip voice fixture: espeak-ng/ffmpeg not installed");
  }
}
const chromeArgs = [
  "--no-first-run",
  "--no-default-browser-check",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--window-position=-32000,-32000",
  "--window-size=1100,800",
  // The window sits off-screen. On Windows an occluded window stops producing
  // frames, which stalls Page.captureScreenshot, so keep it rendering.
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=CalculateNativeWinOcclusion",
  "--user-data-dir=__PROFILE__",
  `--disable-extensions-except=${ROOT}`,
  `--load-extension=${ROOT}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  "about:blank",
];
// The microphone-permission check needs the browser prompt answered whether or
// not the voice fixture exists; only the recorded audio needs espeak-ng/ffmpeg.
chromeArgs.push("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream");
if (voiceAvailable) {
  chromeArgs.push(`--use-file-for-fake-audio-capture=${voiceWav}`);
}
const chrome = findChrome();
const profile = path.join(os.tmpdir(), `autobot-runtime-${Date.now()}`);
const child = spawn(
  chrome,
  chromeArgs.map((arg) => arg.replace("__PROFILE__", profile)),
  { stdio: "ignore" }
);

let failures = 0;
function check(name, cond, extra = "") {
  if (cond) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

try {
  let targets = null;
  for (let i = 0; i < 30; i++) {
    try {
      targets = await listTargets();
      if (
        targets.some(
          (t) =>
            t.url.includes("/onboarding/onboarding.html") ||
            t.url.includes("/background/service-worker.js")
        )
      ) {
        break;
      }
    } catch {}
    await sleep(400);
  }
  if (!targets) throw new Error("Chromium debug endpoint did not come up.");

  const extensionTarget =
    targets.find((t) => t.url.includes("/onboarding/onboarding.html")) ||
    targets.find((t) => t.url.includes("/background/service-worker.js"));
  if (!extensionTarget) throw new Error("The extension did not load.");
  const id = new URL(extensionTarget.url).host;
  const sideUrl = `chrome-extension://${id}/sidepanel/sidepanel.html`;
  const side = await newTarget(sideUrl);
  await sleep(1500);

  targets = await listTargets();
  const sw = targets.find((t) => t.url.includes("background/service-worker.js"));
  if (!sw) throw new Error("The extension service worker did not start.");

  const manifest = JSON.parse(
    await evaluate(
      sw,
      `JSON.stringify({
        version: chrome.runtime.getManifest().version,
        permissions: chrome.runtime.getManifest().permissions
      })`
    )
  );
  check("service worker running", !!manifest.version);
  check("manifest version 1.6.7", manifest.version === "1.6.7", manifest.version);
  check("debugger permission", manifest.permissions.includes("debugger"));
  check("offscreen permission", manifest.permissions.includes("offscreen"));

  await evaluate(
    sw,
    `chrome.storage.local.set({
      autobot_providers: [{
        id: "mock", name: "Mock", type: "openai-compatible",
        apiKey: "bad-key", apiKeys: ["good-key"],
        baseUrl: "http://127.0.0.1:${PORT}/v1",
        models: ["mock-model"], defaultModel: "mock-model"
      }],
      autobot_settings: {
        activeProviderId: "mock",
        activeModel: "mock-model",
        streaming: false,
        confirmNewSites: false,
        permissionMode: "skip",
        // Plan approval is opt-in; turn it on so the plan-approval checks below run.
        planApproval: true,
        soundOnComplete: false,
        maxSteps: 5,
        orchestrator: {
          enabled: true,
          endpoints: [{ providerId: "mock", model: "mock-model" }],
          maxAttempts: 5,
          cooldownSeconds: 60
        }
      }
    })`
  );

  await newTarget(`http://127.0.0.1:${PORT}/test`);
  await sleep(1500);
  const tab = JSON.parse(
    await evaluate(
      sw,
      `(async () => {
        const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:${PORT}/test" });
        if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
        return JSON.stringify(tabs[0] || null);
      })()`
    )
  );
  check("test page opened", !!tab?.id && tab.title === "Autobot Test Page");

  const c = client(side.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Page.reload", { ignoreCache: true });
  await sleep(1500);
  c.ws.close();

  targets = await listTargets();
  const side2 =
    targets.find((t) => t.url === sideUrl || t.url.startsWith(`${sideUrl}?`)) || side;
  const pageInfo = JSON.parse(
    await evaluate(
      side2,
      `JSON.stringify({ title: document.title, hasInput: !!document.getElementById("input") })`
    )
  );
  console.log("  side panel:", JSON.stringify(pageInfo));
  if (!pageInfo.hasInput) throw new Error("Side panel did not render its composer.");

  let modelOptions = [];
  for (let i = 0; i < 12; i++) {
    modelOptions = JSON.parse(
      await evaluate(
        side2,
        `JSON.stringify([...document.getElementById("model-select").options].map((o) => o.value))`
      )
    );
    if (modelOptions.includes("mock-model-2")) break;
    await sleep(400);
  }
  check(
    "live models discovered",
    modelOptions.includes("mock-model-2"),
    JSON.stringify(modelOptions)
  );

  const optionsTarget = await newTarget(`chrome-extension://${id}/options/options.html`);
  await sleep(900);
  const optionsInfo = JSON.parse(
    await evaluate(
      optionsTarget,
      `JSON.stringify({
        title: document.title,
        orchestrator: !!document.getElementById("orch-pool"),
        toggle: !!document.getElementById("s-orchestrator"),
        extraKeys: !!document.getElementById("f-apikeys"),
        toolChecks: document.querySelectorAll("#confirm-tools-list input").length,
        permissionMode: !!document.getElementById("s-permission-mode"),
        approvedSites: !!document.getElementById("approved-sites")
      })`
    )
  );
  check(
    "options page has orchestrator UI",
    optionsInfo.orchestrator &&
      optionsInfo.toggle &&
      optionsInfo.extraKeys &&
      optionsInfo.toolChecks === 36 &&
      optionsInfo.permissionMode &&
      optionsInfo.approvedSites,
    JSON.stringify(optionsInfo)
  );

  await evaluate(
    sw,
    `(async () => {
      const tabs = await chrome.tabs.query({ url: "http://127.0.0.1:${PORT}/test" });
      if (tabs[0]) await chrome.tabs.update(tabs[0].id, { active: true });
      return "ok";
    })()`
  );
  await sleep(400);

  await evaluate(
    side2,
    `(() => {
      const input = document.getElementById("input");
      input.value = "What does this page say?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("send").click();
      return "clicked";
    })()`
  );

  let panel = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    panel = JSON.parse(
      await evaluate(
        side2,
        `JSON.stringify({
          assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map(b => b.textContent.trim()),
          tools: [...document.querySelectorAll(".step .tool-name")].map(e => e.textContent),
          errors: [...document.querySelectorAll(".msg.error .bubble")].map(b => b.textContent.trim()),
          running: !document.getElementById("typing").classList.contains("hidden"),
          orchStatus: document.getElementById("orch-status").textContent,
          groupLabel: document.getElementById("group-label").textContent,
          groupVisible: !document.getElementById("group-bar").classList.contains("hidden"),
          toast: document.getElementById("toast").textContent
        })`
      )
    );
    if (!panel.running && (panel.assistant.length || panel.errors.length)) break;
  }

  const conv = JSON.parse(
    await evaluate(
      sw,
      `(async () => {
        const all = await chrome.storage.local.get(null);
        const key = Object.keys(all).find((k) => k.startsWith("autobot_conversation"));
        return JSON.stringify(key ? all[key] || [] : []);
      })()`
    )
  );

  check("agent ran read_text", panel.tools.includes("read_text"));
  check("agent opened a second tab", panel.tools.includes("open_tab"));
  check(
    "agent tab group created",
    panel.groupVisible && /Akron group/i.test(String(panel.groupLabel)),
    JSON.stringify({ visible: panel.groupVisible, label: panel.groupLabel })
  );
  check(
    "second tab joined the group",
    /2 tabs/i.test(String(panel.groupLabel)),
    String(panel.groupLabel)
  );
  check(
    "orchestrator failed over past the bad key",
    String(panel.orchStatus).includes("key 2/2") ||
      /switching|authentication|failed/i.test(String(panel.toast)),
    JSON.stringify({ status: panel.orchStatus, toast: panel.toast })
  );
  check(
    "final answer rendered",
    panel.assistant.some((t) => t.includes("The page says hello.")),
    JSON.stringify(panel.assistant)
  );
  check("no panel errors", panel.errors.length === 0, JSON.stringify(panel.errors));
  check(
    "tool result stored",
    conv.some(
      (m) => m.role === "tool" && m.name === "read_text" && String(m.content).includes("Hello from the test page")
    )
  );
  check(
    "open_tab result stored",
    conv.some((m) => m.role === "tool" && m.name === "open_tab" && /added to the agent tab group/i.test(String(m.content)))
  );
  check("turn completed", panel.running === false);
  check(
    "final answer saved to storage",
    conv.some((m) => m.role === "assistant" && String(m.content).includes("The page says hello.")),
    JSON.stringify(conv.at(-1))
  );

  // A normal new tab gets its own side panel and session (like Claude's
  // tab-specific side panel), not the previous tab's conversation.
  const fresh = JSON.parse(
    await evaluate(
      sw,
      `(async () => {
        const t = await chrome.tabs.create({
          url: "http://127.0.0.1:${PORT}/test?fresh=1",
          active: true
        });
        return JSON.stringify(t);
      })()`
    )
  );
  await sleep(1200);

  // Switching to the new tab must show a fresh chat with no group yet.
  const freshView = JSON.parse(
    await evaluate(
      side2,
      `JSON.stringify({
        assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map(b => b.textContent.trim()),
        groupVisible: !document.getElementById("group-bar").classList.contains("hidden"),
        groupLabel: document.getElementById("group-label").textContent,
        hasInput: !!document.getElementById("input")
      })`
    )
  );
  check(
    "new tab shows a fresh session and no group yet",
    freshView.hasInput && freshView.assistant.length === 0 && !freshView.groupVisible,
    JSON.stringify(freshView)
  );

  // Run a task from the fresh tab; it must create a second group.
  await evaluate(
    side2,
    `(() => {
      const input = document.getElementById("input");
      input.value = "Read this fresh page.";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("send").click();
      return "clicked";
    })()`
  );

  let freshPanel = null;
  for (let i = 0; i < 30; i++) {
    await sleep(400);
    freshPanel = JSON.parse(
      await evaluate(
        side2,
        `JSON.stringify({
          assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map(b => b.textContent.trim()),
          running: !document.getElementById("typing").classList.contains("hidden"),
          groupVisible: !document.getElementById("group-bar").classList.contains("hidden"),
          groupLabel: document.getElementById("group-label").textContent
        })`
      )
    );
    if (!freshPanel.running && freshPanel.assistant.length) break;
  }
  check(
    "fresh tab task completed",
    freshPanel.assistant.some((t) => t.includes("The page says hello.")),
    JSON.stringify(freshPanel.assistant)
  );
  check(
    "fresh session created its own group",
    freshPanel.groupVisible && /2 tabs/i.test(freshPanel.groupLabel),
    String(freshPanel.groupLabel)
  );

  const groupCount = await evaluate(
    sw,
    `(async () => (await chrome.tabGroups.query({})).filter((g) => /Akron/i.test(g.title || "")).length)()`
  );
  check("two sessions have two groups", Number(groupCount) >= 2, String(groupCount));

  const historyCount = await evaluate(
    sw,
    `(async () => Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith("autobot_session_meta_")).length)()`
  );
  check("chat history stores separate sessions", Number(historyCount) >= 2, String(historyCount));

  // Switch back to the original tab; its conversation must return.
  await evaluate(sw, `chrome.tabs.update(${tab.id}, { active: true })`);
  await sleep(1400);
  const backView = JSON.parse(
    await evaluate(
      side2,
      `JSON.stringify({
        assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map(b => b.textContent.trim()),
        groupLabel: document.getElementById("group-label").textContent,
        groupVisible: !document.getElementById("group-bar").classList.contains("hidden")
      })`
    )
  );
  check(
    "switching tabs restores the original session",
    backView.assistant.some((t) => t.includes("The page says hello.")) &&
      backView.groupVisible &&
      /2 tabs/i.test(backView.groupLabel),
    JSON.stringify(backView)
  );

  const toolReport = JSON.parse(
    await evaluate(
      sw,
      `(async () => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((item) => (item.url || "").includes("/test") && !(item.url || "").includes("second=1"))
          || tabs.find((item) => (item.url || "").includes("/test"));
        const run = (name, args) => globalThis.__autobotExecuteTool(name, args, {
          tabId: tab.id,
          settings: { blockedDomains: [], allowedDomains: [], confirmTools: [] },
          emit() {},
          confirm: async () => true,
        });
        const out = {};
        const page = await run("read_page", { filter: "interactive" });
        out.read_page = page.text.includes("Continue") && page.text.includes("[ref=");
        const text = await run("read_text", {});
        out.read_text = text.text.includes("The page says hello.");
        const found = await run("find", { query: "email" });
        out.find = /textbox|email/i.test(found.text) && found.text.includes("[ref=");
        const ref = (found.text.match(/\\[ref=(e\\d+)\\]/) || [])[1];
        const typed = ref ? await run("form_input", { ref, value: "reader@example.com" }) : { text: "" };
        out.form_input = /set|email/i.test(typed.text);
        const value = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => document.querySelector("#email")?.value });
        out.email = value?.[0]?.result === "reader@example.com";
        await chrome.tabs.sendMessage(tab.id, { channel: "autobot", cmd: "teach_start" });
        const clicked = await run("click", { ref: (page.text.match(/button[^\\n]*\\[ref=(e\\d+)\\]/i) || [])[1] || ref });
        out.click = !/unknown or stale/i.test(clicked.text);
        const taught = await chrome.tabs.sendMessage(tab.id, { channel: "autobot", cmd: "teach_stop" });
        out.teach = Array.isArray(taught?.result) && taught.result.some((step) => step.action === "click");
        const back = await run("navigate", { url: "back" });
        out.navigate_back = /went back/i.test(back.text);
        const listed = await run("list_tabs", {});
        out.list_tabs = listed.text.includes(String(tab.id));
        const waited = await run("wait", { ms: 10 });
        out.wait = /waited/i.test(waited.text);
        const batch = await run("browser_batch", { actions: [{ name: "wait", args: { ms: 5 } }, { name: "not_a_tool", args: {} }, { name: "wait", args: { ms: 5 } }] });
        out.browser_batch = batch.text.includes("not_a_tool: error") && batch.text.includes("were not run");
        const plan = await run("update_plan", { steps: ["Read the page", "Stop"], status: "done" });
        out.update_plan = plan.text.includes("Read the page");
        const js = await run("execute_javascript", { code: "document.title" });
        out.execute_javascript = js.text.includes("Autobot Test Page");
        const nav = await run("navigate", { url: "example.com" }).catch((error) => ({ text: String(error.message || error) }));
        out.navigate_https = /example\\.com/i.test(nav.text);
        const blocked = await run("navigate", { url: "chrome://settings" }).catch((error) => ({ text: String(error.message || error) }));
        out.navigate_blocked = /http/i.test(blocked.text);
        const upload = await run("file_upload", { paths: ["C:/secret.txt"], ref: "e1" }).catch((error) => ({ text: String(error.message || error) }));
        out.file_paths = /local paths/i.test(upload.text);
        let planRejected = false;
        try {
          await globalThis.__autobotExecuteTool("update_plan", { steps: ["Stop"], domains: ["example.com"] }, {
            tabId: tab.id,
            settings: {},
            emit() {},
            confirm: async (req) => req.kind === "plan" ? false : true,
          });
        } catch (error) {
          planRejected = /rejected the plan/i.test(String(error?.message || error));
        }
        out.plan_gate = planRejected;
        return JSON.stringify(out);
      })()`
    )
  );
  for (const [name, ok] of Object.entries(toolReport)) {
    check(`tool behavior ${name}`, ok === true, JSON.stringify(toolReport));
  }

  // On a machine with internet the navigate check above really loads
  // example.com and leaves the working tab there. Put it back on the local test
  // page so the permission checks below act on 127.0.0.1, as they expect.
  await evaluate(
    sw,
    `(async () => {
      const local = "http://127.0.0.1:${PORT}/";
      const current = await chrome.tabs.get(${tab.id}).catch(() => null);
      if (!current || (current.url || "").startsWith(local)) return false;
      await chrome.tabs.update(${tab.id}, { url: local + "test" });
      for (let i = 0; i < 40; i++) {
        const now = await chrome.tabs.get(${tab.id});
        if (now.status === "complete" && (now.url || "").startsWith(local)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return true;
    })()`
  );

  // Stop the MV3 worker, let the panel reconnect, and confirm the reply is
  // restored from storage rather than only existing in the worker's memory.
  await evaluate(side2, `document.getElementById("messages").innerHTML = ""`);
  try {
    await fetch(`${BASE}/json/close/${sw.id}`);
  } catch {}
  await sleep(2500);
  targets = await listTargets();
  const restoredSide =
    targets.find((t) => t.url === sideUrl || t.url.startsWith(`${sideUrl}?`)) || side2;
  const restored = JSON.parse(
    await evaluate(
      restoredSide,
      `JSON.stringify({
        assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map(b => b.textContent.trim()),
        groupLabel: document.getElementById("group-label").textContent,
        groupVisible: !document.getElementById("group-bar").classList.contains("hidden")
      })`
    )
  );
  check(
    "reply survives worker restart",
    restored.assistant.some((t) => t.includes("The page says hello.")),
    JSON.stringify(restored.assistant)
  );
  check(
    "tab group survives worker restart",
    restored.groupVisible && /2 tabs/i.test(String(restored.groupLabel)),
    JSON.stringify({ visible: restored.groupVisible, label: restored.groupLabel })
  );

  const screenDir = "/opt/cursor/artifacts/screens";
  fs.mkdirSync(screenDir, { recursive: true });
  const SHOT_TIMEOUT_MS = 8000;
  const SHOT_ATTEMPTS = 2;
  // Screenshots are artifacts, not checks. A hidden tab can leave
  // Page.captureScreenshot waiting forever for a frame (seen on Windows), so
  // ask again once and then skip the picture instead of hanging the run.
  async function capturePng(c) {
    for (let attempt = 0; attempt < SHOT_ATTEMPTS; attempt++) {
      const capture = c.send("Page.captureScreenshot", { format: "png" });
      capture.catch(() => {});
      let timer = null;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), SHOT_TIMEOUT_MS);
      });
      const shot = await Promise.race([capture, timedOut]);
      clearTimeout(timer);
      if (shot) return shot;
    }
    return null;
  }
  async function shoot(target, filename) {
    const c = client(target.webSocketDebuggerUrl);
    await c.ready;
    try {
      await c.send("Page.enable");
      try {
        await c.send("Emulation.setDeviceMetricsOverride", {
          width: 650,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false,
        });
      } catch {}
      const shot = await capturePng(c);
      if (!shot) {
        console.log(`  skip screenshot ${filename}: capture timed out`);
        return;
      }
      fs.writeFileSync(path.join(screenDir, `${filename}.png`), Buffer.from(shot.data, "base64"));
    } finally {
      c.ws.close();
    }
  }
  async function panelNow(target) {
    return JSON.parse(
      await evaluate(
        target,
        `JSON.stringify({
          dock: !document.getElementById("permission-dock").classList.contains("hidden"),
          title: document.getElementById("perm-title").textContent,
          mode: document.getElementById("perm-mode-label").textContent,
          menu: !document.getElementById("perm-mode-menu").classList.contains("hidden"),
          skip: !document.getElementById("skip-modal").classList.contains("hidden"),
          edit: !document.getElementById("perm-edit").classList.contains("hidden"),
          assistant: [...document.querySelectorAll(".msg.assistant .bubble")].map((b) => b.textContent.trim()),
          steps: [...document.querySelectorAll(".step")].slice(-2).map((row) => row.textContent.trim().slice(0, 180)),
          sites: document.getElementById("sites-list").innerText,
          history: !document.getElementById("history-panel").classList.contains("hidden"),
          prompts: !document.getElementById("prompts-panel").classList.contains("hidden"),
          tabs: !document.getElementById("tabs-panel").classList.contains("hidden")
        })`
      )
    );
  }
  async function until(target, pred) {
    let last = null;
    for (let i = 0; i < 40; i++) {
      last = await panelNow(target);
      if (pred(last)) return last;
      await sleep(300);
    }
    return last;
  }
  async function clickId(target, id) {
    await evaluate(target, `document.getElementById(${JSON.stringify(id)}).click()`);
  }
  async function sendText(target, text) {
    await evaluate(
      target,
      `(() => {
        const input = document.getElementById("input");
        input.value = ${JSON.stringify(text)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
        document.getElementById("send").click();
        return true;
      })()`
    );
  }

  targets = await listTargets();
  const liveSw = targets.find((t) => t.url.includes("background/service-worker.js")) || sw;
  const ui = restoredSide;
  await shoot(ui, "sidepanel-finished-task");
  await clickId(ui, "history-btn");
  await sleep(300);
  await shoot(ui, "sidepanel-history");
  await clickId(ui, "history-btn");
  await clickId(ui, "prompts-btn");
  await sleep(300);
  await shoot(ui, "sidepanel-saved-prompts");
  await clickId(ui, "prompts-btn");
  await clickId(ui, "tabs-btn");
  await sleep(300);
  await shoot(ui, "sidepanel-tabs");
  await clickId(ui, "tabs-btn");
  await clickId(ui, "perm-mode-btn");
  await sleep(200);
  let uiState = await panelNow(ui);
  check("permission mode menu opens", uiState.menu === true, JSON.stringify(uiState));
  await shoot(ui, "permission-mode-menu");
  await evaluate(ui, `document.querySelector('#perm-mode-menu [data-mode="ask"]').click()`);
  uiState = await until(ui, (row) => row.mode === "Ask before acting");
  check("ask before acting is selectable", uiState.mode === "Ask before acting", uiState.mode);
  await shoot(ui, "permission-mode-ask");
  await clickId(ui, "perm-mode-btn");
  await evaluate(ui, `document.querySelector('#perm-mode-menu [data-mode="skip"]').click()`);
  uiState = await until(ui, (row) => row.skip);
  check("act without asking asks for confirmation", uiState.skip === true, JSON.stringify(uiState));
  await shoot(ui, "permission-skip-warning");
  await clickId(ui, "skip-cancel");
  await clickId(ui, "new-chat");
  await sleep(400);
  await sendText(ui, "PERM-CLICK decline");
  uiState = await until(ui, (row) => row.dock && /click/i.test(row.title));
  check("action prompt offers allow, always, and decline", uiState.dock === true, JSON.stringify(uiState));
  await shoot(ui, "permission-action-prompt");
  await clickId(ui, "perm-decline");
  uiState = await until(ui, (row) => row.assistant.some((line) => line.includes("Declined the click.")));
  check("decline stops the action", uiState.assistant.some((line) => line.includes("Declined the click.")), JSON.stringify(uiState.assistant));
  await shoot(ui, "permission-declined");
  await sendText(ui, "PERM-CLICK once");
  uiState = await until(ui, (row) => row.dock);
  await clickId(ui, "perm-allow");
  uiState = await until(ui, (row) => row.assistant.some((line) => line.includes("Clicked.")));
  check("allow once runs the action", uiState.assistant.some((line) => line.includes("Clicked.")), JSON.stringify(uiState.assistant));
  await sendText(ui, "PERM-CLICK always");
  uiState = await until(ui, (row) => row.dock);
  await shoot(ui, "permission-always-allow");
  await clickId(ui, "perm-always");
  uiState = await until(ui, (row) => row.assistant.filter((line) => line.includes("Clicked.")).length >= 2);
  const granted = JSON.parse(
    await evaluate(
      liveSw,
      `(async () => JSON.stringify((await chrome.storage.local.get("autobot_settings")).autobot_settings?.approvedHosts || []))()`
    )
  );
  check("always allow stores the site", granted.includes("127.0.0.1"), JSON.stringify(granted));
  await clickId(ui, "perm-mode-btn");
  await clickId(ui, "perm-sites-btn");
  uiState = await until(ui, (row) => /127\.0\.0\.1/.test(row.sites));
  check("approved sites are listed in the panel", /127\.0\.0\.1/.test(uiState.sites), uiState.sites);
  await shoot(ui, "approved-sites");
  await evaluate(ui, `document.querySelector("#sites-list button").click()`);
  await sleep(300);
  await sendText(ui, "PERM-PLAN approve");
  uiState = await until(ui, (row) => row.dock && /plan/i.test(row.title));
  check("plan approval is in the panel", uiState.dock === true, JSON.stringify(uiState));
  await shoot(ui, "plan-approval");
  await clickId(ui, "perm-changes");
  uiState = await until(ui, (row) => row.edit);
  await evaluate(ui, `(() => { document.getElementById("perm-edit").value = "Edited step"; return true; })()`);
  await shoot(ui, "plan-edit");
  await clickId(ui, "perm-approve");
  uiState = await until(ui, (row) => row.assistant.some((line) => line.includes("Plan went through.")) && !row.dock);
  check(
    "an edited plan is approved",
    uiState.assistant.some((line) => line.includes("Plan went through.")) && uiState.steps.some((line) => line.includes("Edited step")),
    JSON.stringify(uiState)
  );
  await sendText(ui, "PERM-PLAN-NO reject");
  uiState = await until(ui, (row) => row.dock);
  await shoot(ui, "plan-reject");
  await clickId(ui, "perm-decline");
  uiState = await until(ui, (row) => row.assistant.some((line) => line.includes("Plan was rejected.")));
  check("a plan can be rejected", uiState.assistant.some((line) => line.includes("Plan was rejected.")), JSON.stringify(uiState.assistant));
  await clickId(ui, "perm-mode-btn");
  await evaluate(ui, `document.querySelector('#perm-mode-menu [data-mode="skip"]').click()`);
  await until(ui, (row) => row.skip);
  await clickId(ui, "skip-confirm");
  uiState = await until(ui, (row) => row.mode === "Act without asking");
  check("skip permissions turns on act without asking", uiState.mode === "Act without asking", uiState.mode);
  await shoot(ui, "permission-mode-skip");
  await sendText(ui, "PERM-CLICK auto");
  const clicksBefore = uiState.assistant.filter((line) => line.includes("Clicked.")).length;
  uiState = await until(
    ui,
    (row) => !row.dock && row.assistant.filter((line) => line.includes("Clicked.")).length > clicksBefore
  );
  check(
    "act without asking does not show a prompt",
    uiState.dock === false && uiState.assistant.filter((line) => line.includes("Clicked.")).length > clicksBefore,
    JSON.stringify(uiState)
  );
  await clickId(ui, "teach-btn");
  await sleep(200);
  await shoot(ui, "sidepanel-teach");
  await clickId(ui, "teach-btn");
  await evaluate(
    optionsTarget,
    `document.getElementById("s-permission-mode").scrollIntoView({ block: "center" })`
  );
  await shoot(optionsTarget, "options-permissions");
  await evaluate(
    optionsTarget,
    `document.getElementById("approved-sites").scrollIntoView({ block: "center" })`
  );
  await shoot(optionsTarget, "options-approved-sites");
  const micPage = await newTarget(`chrome-extension://${id}/options/options.html#permissions?requestMicrophone=true`);
  let micStatus = "";
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    micStatus = await evaluate(micPage, `document.getElementById("mic-status")?.textContent || ""`);
    if (/allowed|denied|microphone/i.test(micStatus)) break;
  }
  check("microphone permission is requested from a settings tab", /Microphone allowed/i.test(micStatus), micStatus);
  const attached = JSON.parse(await evaluate(ui, `(async () => {
    const input = document.getElementById("file-input");
    const list = new DataTransfer();
    list.items.add(new File(["alpha,beta\\n1,2"], "sheet.csv", { type: "text/csv" }));
    list.items.add(new File([new Uint8Array([137,80,78,71,13,10,26,10])], "dot.png", { type: "image/png" }));
    input.files = list.files;
    input.dispatchEvent(new Event("change"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    return JSON.stringify({
      chips: document.querySelectorAll(".attachment").length,
      names: [...document.querySelectorAll(".attachment-name")].map((node) => node.textContent),
      mic: !!document.querySelector("#mic svg"),
      attach: !!document.querySelector("#attach svg"),
    });
  })()`));
  check("attachments show chips for csv and png", attached.chips === 2 && attached.names.includes("sheet.csv"), JSON.stringify(attached));
  check("composer uses mic and attach icons", attached.mic && attached.attach);
  if (voiceAvailable) {
  await evaluate(ui, `(() => {
    class FakeRecognition {
      start() { setTimeout(() => this.onerror && this.onerror({ error: "network" }), 2500); }
      stop() { this.onend && this.onend(); }
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  })()`);
  await evaluate(ui, `document.getElementById("mic").click()`);
  let voice = { value: "", notice: "", errors: "" };
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    voice = JSON.parse(await evaluate(ui, `JSON.stringify({
      listening: document.getElementById("mic").classList.contains("active"),
      value: document.getElementById("input").value,
      notice: document.getElementById("voice-notice")?.textContent || "",
      peak: window.__autobotVoicePeak || 0,
      errors: [...document.querySelectorAll(".msg.error .bubble")].map((node) => node.textContent).join(" ")
    })`));
    if (/hello/i.test(voice.value)) break;
  }
  if (voice.listening) await evaluate(ui, `document.getElementById("mic").click()`);
  for (let i = 0; i < 90 && !/hello/i.test(voice.value); i++) {
    await sleep(1000);
    voice = JSON.parse(await evaluate(ui, `JSON.stringify({
      listening: document.getElementById("mic").classList.contains("active"),
      value: document.getElementById("input").value,
      notice: document.getElementById("voice-notice")?.textContent || "",
      peak: window.__autobotVoicePeak || 0,
      errors: [...document.querySelectorAll(".msg.error .bubble")].map((node) => node.textContent).join(" ")
    })`));
  }
  console.log("  voice:", JSON.stringify(voice));
  check("voice transcript lands in the composer", /hello/i.test(voice.value), JSON.stringify(voice));
  check("voice errors stay out of the chat", !/speech service|Voice input/i.test(voice.errors), voice.errors);
  } else {
    console.log("  skip voice test: espeak-ng/ffmpeg not installed");
  }
  const onboard = await newTarget(`chrome-extension://${id}/onboarding/onboarding.html`);
  await sleep(600);
  await shoot(onboard, "onboarding");

  try {
    await evaluate(
      liveSw,
      `(async () => {
        const all = await chrome.storage.local.get(null);
        const keys = Object.keys(all).filter(
          (k) => k.startsWith("autobot_conversation") || k.startsWith("autobot_session_meta")
        );
        await chrome.storage.local.remove([...keys, "autobot_providers", "autobot_settings"]);
      })()`
    );
  } catch {}
} catch (e) {
  failures++;
  console.log(`  FAIL runtime: ${e?.message || e}`);
} finally {
  server.close();
  try {
    await new Promise((resolve) => {
      execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => resolve());
    });
  } catch {}
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
}

console.log(failures ? `\nRUNTIME: ${failures} failure(s)` : "\nRUNTIME: all checks passed");
process.exit(failures ? 1 : 0);
