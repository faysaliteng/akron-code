// GIF recording: capture visible-tab frames, then hand them to the offscreen
// document for encoding. Chrome rate-limits captureVisibleTab to ~2/s, so the
// default interval is 600 ms.

import { offscreenRequest } from "./offscreen-host.js";

const sessions = new Map();

function pngSize(dataUrl) {
  const b64 = String(dataUrl).split(",")[1] || "";
  const bin = atob(b64.slice(0, 64));
  const be = (o) =>
    ((bin.charCodeAt(o) << 24) |
      (bin.charCodeAt(o + 1) << 16) |
      (bin.charCodeAt(o + 2) << 8) |
      bin.charCodeAt(o + 3)) >>>
    0;
  return { width: be(16), height: be(20) };
}

export function isRecording(tabId) {
  return sessions.has(tabId);
}

export function startRecording(tabId, { intervalMs = 600, maxFrames = 80 } = {}) {
  const existing = sessions.get(tabId);
  if (existing) return { frames: existing.frames.length, alreadyRunning: true };

  const session = {
    frames: [],
    timer: null,
    intervalMs: Math.max(600, Number(intervalMs) || 600),
    maxFrames: Math.max(2, Math.min(200, Number(maxFrames) || 80)),
  };
  sessions.set(tabId, session);

  const capture = async () => {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) return;
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      if (session.frames.length < session.maxFrames) session.frames.push(dataUrl);
      if (session.frames.length >= session.maxFrames && session.timer) {
        clearInterval(session.timer);
        session.timer = null;
      }
    } catch {
      // Tab may be closing or the window unfocused; skip this frame.
    }
  };

  capture();
  session.timer = setInterval(capture, session.intervalMs);
  return { frames: 0, alreadyRunning: false };
}

export function stopRecording(tabId) {
  const s = sessions.get(tabId);
  if (!s) return { frames: 0 };
  if (s.timer) clearInterval(s.timer);
  s.timer = null;
  return { frames: s.frames.length };
}

export function clearRecording(tabId) {
  const s = sessions.get(tabId);
  if (s?.timer) clearInterval(s.timer);
  sessions.delete(tabId);
  return { frames: 0 };
}

export async function exportRecording(tabId, { delayMs } = {}) {
  const s = sessions.get(tabId);
  if (!s || !s.frames.length) {
    throw new Error("No frames recorded yet. Call gif_creator with action \"start\" first.");
  }
  if (s.timer) clearInterval(s.timer);
  s.timer = null;

  const { width, height } = pngSize(s.frames[0]);
  const res = await offscreenRequest({
    type: "encode_gif",
    frames: s.frames.slice(),
    width,
    height,
    delayMs: Number(delayMs) || s.intervalMs,
  });

  if (!res?.ok) throw new Error(res?.error || "GIF encoding failed.");
  const { dataUrl, ...meta } = res.result || {};
  if (!dataUrl) throw new Error("The encoder returned no GIF data.");

  await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename: meta.filename, saveAs: false },
      (id) => {
        const err = chrome.runtime.lastError;
        if (err) reject(new Error(err.message));
        else resolve(id);
      }
    );
  });

  sessions.delete(tabId);
  return meta;
}

export function recordingStatus(tabId) {
  const s = sessions.get(tabId);
  return s ? { frames: s.frames.length, recording: !!s.timer } : { frames: 0, recording: false };
}
