/** Wording from Claude in Chrome 1.0.107. Empty means the event is ignored. */

/** For the "Browser speech" engine in a browser that has no speech service (Brave, for one). */
export const BROWSER_SPEECH_UNAVAILABLE =
  "This browser has no speech service. Choose Auto or Local Whisper under Voice in Settings.";

const USE_ANOTHER_ENGINE = "Choose Auto or Local Whisper under Voice in Settings.";

/**
 * For the "Provider transcription" engine when the provider cannot turn speech into text.
 * @param {number|"missing"} status HTTP status, 0 when unreachable, "missing" when no provider has a key.
 * @returns {string}
 */
export function providerSpeechMessage(status) {
  if (status === "missing") return `No provider with an API key is set up. ${USE_ANOTHER_ENGINE}`;
  if (status === 0) {
    return `Your provider could not be reached for speech recognition. Check the connection, or ${lowerFirst(USE_ANOTHER_ENGINE)}`;
  }
  if (status === 401) return "Your provider rejected the API key for speech recognition. Check the key in Settings.";
  if (status === 429 || status >= 500) {
    return `Your provider's speech recognition is not answering right now (HTTP ${status}). Try again, or ${lowerFirst(USE_ANOTHER_ENGINE)}`;
  }
  return `Your provider does not offer speech recognition (HTTP ${status}). ${USE_ANOTHER_ENGINE}`;
}

function lowerFirst(text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** Notes the local speech model writes when it hears no words: "[BLANK_AUDIO]", "(silence)". */
const NON_SPEECH_NOTE = /\[[^\]]*\]|\([a-z_ ]*\)/gi;

/**
 * Removes the model's "nothing was said" notes and leading punctuation.
 * @param {string} text
 * @returns {string} "" when no words were heard
 */
export function cleanTranscript(text) {
  return String(text || "")
    .replace(NON_SPEECH_NOTE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[^a-z0-9]+/i, "")
    .trim();
}

export function voiceErrorMessage(code) {
  if (code === "no-speech" || code === "aborted" || code === "network") return "";
  if (code === "not-allowed" || code === "service-not-allowed") return "Microphone permission denied";
  if (code === "audio-capture" || code === "not-found") {
    return "No microphone found. Please connect a microphone and try again.";
  }
  if (code === "start") return "Failed to start speech recording";
  return "Speech recognition stopped unexpectedly";
}
