/** One-off screenshots for the design pass. Not part of npm test. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = "/opt/cursor/artifacts/screens";
const PORT = 9344;
const chrome = process.env.CHROME_PATH || "/tmp/chromium-browsers/chromium/linux-1753710/chrome-linux/chrome";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const reference = `<!doctype html><meta charset="utf-8"><title>layout</title>
<style>
  body{margin:0;background:#faf9f5;color:#141413;font:14px "Segoe UI",sans-serif}
  .panel{width:360px;height:640px;display:flex;flex-direction:column;border-right:1px solid #e6e0d4}
  header{display:flex;justify-content:space-between;padding:10px 12px}
  .icons{display:flex;gap:4px}
  .dot{width:16px;height:16px;border:1.5px solid #6f6a62;border-radius:4px}
  .empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:24px;color:#6f6a62}
  .composer{margin:10px;border:1px solid #e6e0d4;border-radius:16px;padding:10px;background:#fff}
  .send{float:right;background:#c96442;color:#fff;border:0;border-radius:999px;padding:6px 12px}
</style>
<div class="panel"><header><strong>Agent</strong><div class="icons"><i class="dot"></i><i class="dot"></i><i class="dot"></i></div></header>
<div class="empty"><h1>How can I help?</h1><p>Ask about the open tab.</p></div>
<div class="composer">Message…<button class="send">Send</button></div></div>`;

const server = http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end(reference);
});
await new Promise((r) => server.listen(8794, "127.0.0.1", r));

const profile = path.join(os.tmpdir(), `autobot-shots-${Date.now()}`);
const child = spawn(chrome, [
  "--no-first-run", "--no-sandbox", "--disable-dev-shm-usage",
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${ROOT}`,
  `--load-extension=${ROOT}`,
  `--remote-debugging-port=${PORT}`,
  "about:blank",
], { stdio: "ignore" });

function client(url) {
  const ws = new WebSocket(url);
  let id = 1;
  const pending = new Map();
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const waiter = pending.get(msg.id);
      pending.delete(msg.id);
      waiter.resolve(msg.result);
    }
  });
  return { ws, ready, send: (method, params={}) => new Promise((resolve, reject) => {
    const n = id++;
    pending.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  })};
}
async function evaluate(target, expression) {
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  const res = await c.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  c.ws.close();
  return res.result?.value;
}
async function shoot(target, name) {
  const c = client(target.webSocketDebuggerUrl);
  await c.ready;
  await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride", { width: 650, height: 900, deviceScaleFactor: 1, mobile: false });
  const shot = await c.send("Page.captureScreenshot", { format: "png" });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(shot.data, "base64"));
  c.ws.close();
}

let targets;
for (let i = 0; i < 30; i++) {
  try {
    targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    if (targets.some((t) => t.url.includes("onboarding") || t.url.includes("service-worker"))) break;
  } catch {}
  await sleep(300);
}
const ext = targets.find((t) => t.url.includes("onboarding") || t.url.includes("service-worker"));
const id = new URL(ext.url).host;
async function open(url) {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: "PUT" });
  return res.json();
}
const side = await open(`chrome-extension://${id}/sidepanel/sidepanel.html`);
await sleep(1200);
await shoot(side, "ui-empty.png");
await evaluate(side, `(() => {
  document.getElementById("empty-state").classList.add("hidden");
  const main = document.getElementById("messages");
  main.insertAdjacentHTML("beforeend", '<div class="msg user"><div class="bubble">Summarize this page</div></div><div class="msg assistant"><div class="bubble">The page says hello.</div></div><div class="step done"><div class="step-head"><span class="tool-name">read_text</span><span class="state">Done</span></div></div>');
  document.getElementById("permission-dock").classList.remove("hidden");
  document.getElementById("perm-title").textContent = "Autobot wants to click:";
  return true;
})()`);
await shoot(side, "ui-chat-permission.png");
await evaluate(side, `(() => {
  document.getElementById("perm-kicker").textContent = "Autobot's plan";
  document.getElementById("perm-title").textContent = "Approve this plan before Autobot continues.";
  document.getElementById("perm-allow").classList.add("hidden");
  document.getElementById("perm-approve").classList.remove("hidden");
  document.documentElement.dataset.theme = "dark";
  return true;
})()`);
await shoot(side, "ui-plan-dark.png");
const options = await open(`chrome-extension://${id}/options/options.html#skills`);
await sleep(800);
await shoot(options, "ui-skills.png");
const onboard = await open(`chrome-extension://${id}/onboarding/onboarding.html`);
await sleep(500);
await shoot(onboard, "ui-onboarding.png");
const ref = await open("http://127.0.0.1:8794/");
await sleep(400);
await shoot(ref, "ui-reference-layout.png");

const compare = await open("about:blank");
await evaluate(compare, `document.body.innerHTML = '<div style="display:flex;gap:8px;background:#ddd;padding:8px"><img width="320" src="http://127.0.0.1:8794/" alt=""><p>see files</p></div>'`);
console.log("shots written");
server.close();
try { process.kill(child.pid); } catch {}
try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
