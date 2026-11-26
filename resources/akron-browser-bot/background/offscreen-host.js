// Single offscreen document host (GIF encoding + audio).
// Chrome allows at most one offscreen document per extension.

let creating = null;

export async function ensureOffscreen() {
  if (!chrome.offscreen) throw new Error("The offscreen API is unavailable.");
  if (await chrome.offscreen.hasDocument()) return;
  if (creating) return creating;
  creating = chrome.offscreen
    .createDocument({
      url: "offscreen/offscreen.html",
      reasons: ["BLOBS", "AUDIO_PLAYBACK", "USER_MEDIA"],
      justification:
        "Encode GIF recordings, play a completion sound, and transcribe speech on this device.",
    })
    .catch((e) => {
      // A concurrent create may have won the race.
      if (!/single offscreen/i.test(String(e?.message || e))) throw e;
    })
    .finally(() => {
      creating = null;
    });
  return creating;
}

export async function offscreenRequest(payload) {
  await ensureOffscreen();
  let lastError = null;
  // The offscreen document can exist before its script has registered the
  // listener, so retry the first message briefly.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ target: "offscreen", ...payload });
    } catch (e) {
      lastError = e;
      await new Promise((r) => setTimeout(r, 120));
    }
  }
  throw lastError || new Error("The offscreen document did not respond.");
}

/** Asks the hidden page to keep pinging the worker for as long as a task runs. */
export async function startKeepalive() {
  try {
    await offscreenRequest({ type: "keepalive_start" });
  } catch {
    // The keep-alive alarm still runs as a backstop.
  }
}

export async function playChime() {
  try {
    await offscreenRequest({ type: "play_chime" });
  } catch {
    // Audio is best-effort.
  }
}
