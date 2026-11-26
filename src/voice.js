import { useState, useRef, useEffect, useCallback } from 'react';

/**
 * Downsample Float32 PCM buffer from `inRate` to `outRate` (16 kHz for Whisper).
 */
export function downsampleFloat32(samples, inRate, outRate = 16000) {
  if (!samples || !samples.length || inRate === outRate) return samples;
  const ratio = inRate / outRate;
  const newLen = Math.max(1, Math.round(samples.length / ratio));
  const out = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end; j++) { sum += samples[j]; count++; }
    out[i] = count ? sum / count : (samples[start] || 0);
  }
  return out;
}

/**
 * Encode mono Float32Array samples into base64 16-bit PCM WAV.
 */
export function encodeWavBase64(samples, sampleRate = 16000) {
  const len = samples.length;
  const buf = new ArrayBuffer(44 + len * 2);
  const view = new DataView(buf);
  const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + len * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, len * 2, true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    off += 2;
  }
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

let sharedWorker = null;
const workerWaiters = new Map();
let progressSub = null;
let seq = 0;

function getWhisperWorker(onProgress) {
  progressSub = onProgress || null;
  if (sharedWorker) return sharedWorker;
  const w = new Worker('./whisper/whisper-worker.js', { type: 'module' });
  w.onmessage = (e) => {
    const d = e.data || {};
    if (d.type === 'progress') {
      if (progressSub) progressSub(String(d.text || 'Preparing speech model…'));
      return;
    }
    if (d.id && workerWaiters.has(d.id)) {
      const p = workerWaiters.get(d.id);
      workerWaiters.delete(d.id);
      if (d.type === 'error') p.reject(new Error(d.error || 'Speech recognition failed'));
      else p.resolve(String(d.text || '').trim());
    }
  };
  w.onerror = (err) => {
    for (const [, p] of workerWaiters) p.reject(new Error(err?.message || 'Whisper worker error'));
    workerWaiters.clear();
  };
  sharedWorker = w;
  return w;
}

function runLocalWhisper(samples, lang, onProgress) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    const worker = getWhisperWorker(onProgress);
    workerWaiters.set(id, { resolve, reject });
    worker.postMessage({ id, samples, lang: lang || 'en-US' });
  });
}

/**
 * Built-in voice typing hook (ONNX Whisper + optional gateway fast transcription).
 */
export function useVoiceDictation({ engine = 'auto', lang = 'en-US', onTranscript, onError } = {}) {
  const [state, setState] = useState('idle'); // idle | recording | transcribing
  const [seconds, setSeconds] = useState(0);
  const [statusNote, setStatusNote] = useState('');

  const ctxRef = useRef(null);
  const streamRef = useRef(null);
  const procRef = useRef(null);
  const chunksRef = useRef([]);
  const rateRef = useRef(16000);
  const onTranscriptRef = useRef(onTranscript);
  const onErrorRef = useRef(onError);
  onTranscriptRef.current = onTranscript;
  onErrorRef.current = onError;

  useEffect(() => {
    if (state !== 'recording') { setSeconds(0); return undefined; }
    const t0 = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - t0) / 1000)), 250);
    return () => clearInterval(id);
  }, [state]);

  const cleanupAudio = useCallback(() => {
    try { procRef.current && procRef.current.disconnect(); } catch (_) {}
    try { ctxRef.current && ctxRef.current.close(); } catch (_) {}
    try {
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    } catch (_) {}
    procRef.current = null;
    ctxRef.current = null;
    streamRef.current = null;
  }, []);

  useEffect(() => () => cleanupAudio(), [cleanupAudio]);

  const start = useCallback(async () => {
    if (state !== 'idle') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      if (onErrorRef.current) onErrorRef.current('Microphone access is unavailable in this environment.');
      return;
    }
    try {
      setStatusNote('');
      chunksRef.current = [];
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const AC = window.AudioContext || window.webkitAudioContext;
      const ctx = new AC({ sampleRate: 16000 });
      ctxRef.current = ctx;
      rateRef.current = ctx.sampleRate || 16000;
      const src = ctx.createMediaStreamSource(stream);
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      proc.onaudioprocess = (ev) => {
        const ch = ev.inputBuffer.getChannelData(0);
        chunksRef.current.push(new Float32Array(ch));
      };
      src.connect(proc);
      proc.connect(ctx.destination);
      procRef.current = proc;
      setState('recording');
    } catch (e) {
      cleanupAudio();
      if (onErrorRef.current) onErrorRef.current(e?.message || 'Microphone permission denied');
    }
  }, [state, cleanupAudio]);

  const stop = useCallback(async () => {
    if (state !== 'recording') return;
    cleanupAudio();
    const chunks = chunksRef.current;
    chunksRef.current = [];
    if (!chunks.length) { setState('idle'); return; }

    let total = 0;
    for (const c of chunks) total += c.length;
    const raw = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) { raw.set(c, offset); offset += c.length; }
    const samples = downsampleFloat32(raw, rateRef.current, 16000);
    if (samples.length < 1600) { setState('idle'); return; }

    setState('transcribing');
    setStatusNote('Transcribing…');
    try {
      let text = '';
      if (engine !== 'local' && window.autobot && window.autobot.transcribeAudio) {
        try {
          const wavBase64 = encodeWavBase64(samples, 16000);
          const res = await window.autobot.transcribeAudio({ wavBase64, lang });
          if (res && res.ok && res.text) text = String(res.text).trim();
        } catch (_) {}
      }
      if (!text && engine !== 'gateway') {
        text = await runLocalWhisper(samples, lang, (msg) => setStatusNote(msg));
      }
      if (text && onTranscriptRef.current) onTranscriptRef.current(text);
    } catch (e) {
      if (onErrorRef.current) onErrorRef.current(e?.message || 'Transcription failed');
    } finally {
      setStatusNote('');
      setState('idle');
    }
  }, [state, engine, lang, cleanupAudio]);

  const toggle = useCallback(() => {
    if (state === 'recording') return stop();
    if (state === 'idle') return start();
    return undefined;
  }, [state, start, stop]);

  return { state, seconds, statusNote, start, stop, toggle };
}
