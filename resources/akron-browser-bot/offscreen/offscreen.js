// Offscreen document: GIF encoding (needs canvas) and audio playback.
// The service worker cannot use canvas or WebAudio, so it delegates here.

let audioCtx = null;

function playChime() {
  try {
    audioCtx = audioCtx || new AudioContext();
    if (audioCtx.state === "suspended") audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    const notes = [660, 880, 1100];
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + i * 0.09);
      gain.gain.exponentialRampToValueAtTime(0.12, now + i * 0.09 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.09 + 0.16);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.09);
      osc.stop(now + i * 0.09 + 0.18);
    });
  } catch {}
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Frame failed to load."));
    img.src = src;
  });
}

async function encodeGif({ frames, width, height, delayMs }) {
  const MAX_W = 960;
  const scale = width > MAX_W ? MAX_W / width : 1;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  const imageDataFrames = [];
  for (const src of frames) {
    const img = await loadImage(src);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    imageDataFrames.push(ctx.getImageData(0, 0, w, h));
  }

  const bytes = window.AutobotGif.encode(imageDataFrames, w, h, delayMs);
  const blob = new Blob([bytes], { type: "image/gif" });
  const filename = `autobot-recording-${Date.now()}.gif`;

  // Offscreen documents only have chrome.runtime, so return a data URL. The
  // service worker performs the actual chrome.downloads call.
  const dataUrl = await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ""));
    fr.onerror = () => reject(fr.error || new Error("Could not read the GIF blob."));
    fr.readAsDataURL(blob);
  });

  return { dataUrl, filename, bytes: bytes.length, frames: imageDataFrames.length };
}

/* --------------------------- speech recognition --------------------------- */

// The speech model runs in whisper-worker.js, its own thread, so this page and
// the side panel (which share a thread) stay responsive while it works.
const SPEECH_FAILED = "Speech recognition stopped unexpectedly";
let whisperWorker = null;
let nextTranscriptionId = 1;
const pendingTranscriptions = new Map();

function failPendingTranscriptions(message) {
  for (const pending of pendingTranscriptions.values()) pending.reject(new Error(message));
  pendingTranscriptions.clear();
}

function onWhisperMessage(event) {
  const msg = event.data || {};
  if (msg.type === "progress") {
    chrome.runtime.sendMessage({ type: "voice_progress", text: msg.text }).catch(() => {});
    return;
  }
  const pending = pendingTranscriptions.get(msg.id);
  if (!pending) return;
  pendingTranscriptions.delete(msg.id);
  if (msg.type === "result") pending.resolve(msg.text);
  else pending.reject(new Error(msg.error || SPEECH_FAILED));
}

function getWhisperWorker() {
  if (whisperWorker) return whisperWorker;
  const worker = new Worker(chrome.runtime.getURL("offscreen/whisper-worker.js"), { type: "module" });
  worker.onmessage = onWhisperMessage;
  worker.onerror = (event) => {
    // The worker could not start or broke down: fail what is waiting and
    // start a new one for the next recording.
    failPendingTranscriptions(event?.message || SPEECH_FAILED);
    worker.terminate();
    if (whisperWorker === worker) whisperWorker = null;
  };
  whisperWorker = worker;
  return worker;
}

function transcribeAudio(samples, lang) {
  const audio = Float32Array.from(samples || []);
  if (!audio.length) return Promise.reject(new Error(SPEECH_FAILED));
  return new Promise((resolve, reject) => {
    const id = nextTranscriptionId++;
    pendingTranscriptions.set(id, { resolve, reject });
    getWhisperWorker().postMessage({ id, samples: audio, lang }, [audio.buffer]);
  });
}

/* ------------------------------ keep-alive ------------------------------ */

// The browser shuts the background worker down after 30 s without activity,
// and a slow model call counts as none. This page is not shut down that way,
// so while a task runs it messages the worker every 20 s to keep it awake.
const KEEPALIVE_MS = 20000;
let keepaliveTimer = null;

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

async function pingWorker() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: "autobot_keepalive" });
    if (reply && reply.running === false) stopKeepalive();
  } catch {
    // The worker is restarting; the next ping wakes it.
  }
}

function startKeepalive() {
  if (!keepaliveTimer) keepaliveTimer = setInterval(pingWorker, KEEPALIVE_MS);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;

  (async () => {
    try {
      if (msg.type === "keepalive_start") {
        startKeepalive();
        sendResponse({ ok: true });
      } else if (msg.type === "encode_gif") {
        const result = await encodeGif(msg);
        sendResponse({ ok: true, result });
      } else if (msg.type === "play_chime") {
        playChime();
        sendResponse({ ok: true });
      } else if (msg.type === "transcribe") {
        const text = await transcribeAudio(msg.samples, msg.lang);
        sendResponse({ ok: true, text });
      } else {
        sendResponse({ ok: false, error: `Unknown offscreen task: ${msg.type}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();

  return true;
});
