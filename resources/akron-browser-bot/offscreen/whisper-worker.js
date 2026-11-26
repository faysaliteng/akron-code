// Runs the local speech model in its own thread. All of the extension's pages
// share one thread, so recognising a recording on the offscreen page itself
// froze the side panel until it was done (about half the recording's length).

import { pipeline, env } from "./transformers.min.js";
import { cleanTranscript } from "../shared/voice.js";

// The speech model reads 30 s of sound at a time. Longer recordings are read
// in overlapping pieces; without this everything after the first 30 s is lost.
const WHISPER_CHUNK_SECONDS = 30;
const WHISPER_OVERLAP_SECONDS = 5;

env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = new URL("./ort/", self.location.href).href;
env.backends.onnx.wasm.numThreads = 1;

let transcriberPromise = null;

function loadTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline("automatic-speech-recognition", "Xenova/whisper-tiny.en", {
      progress_callback(update) {
        const pct = Number(update?.progress);
        const text = Number.isFinite(pct) && pct > 0 && pct < 100
          ? `Downloading speech model ${Math.round(pct)}%`
          : "Preparing speech recognition…";
        self.postMessage({ type: "progress", text });
      },
    });
  }
  return transcriberPromise;
}

self.onmessage = async (event) => {
  const { id, samples, lang } = event.data || {};
  try {
    const transcriber = await loadTranscriber();
    const result = await transcriber(samples, {
      language: String(lang || "en").slice(0, 2),
      chunk_length_s: WHISPER_CHUNK_SECONDS,
      stride_length_s: WHISPER_OVERLAP_SECONDS,
    });
    self.postMessage({ type: "result", id, text: cleanTranscript(result?.text) });
  } catch (error) {
    self.postMessage({ type: "error", id, error: String(error?.message || error) });
  }
};
