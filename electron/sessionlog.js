'use strict';
// ---- Event-sourced session log ---------------------------------------------
//
// DeepSeek Harness records every run as an append-only event log so a turn can
// be inspected and replayed after it ends. This is the same idea for Akron
// Bot: one JSONL file per turn under ~/.autobot/sessions/<conv>/<turn>.jsonl.
//
// Token deltas are not stored one by one (a long answer is thousands of
// events); they are coalesced into `text` / `thinking` events at each
// structural boundary, so the log stays small and still replays the reply.
// Tool results are capped, and nothing secret travels in run events.

const fs = require('fs');
const path = require('path');
const os = require('os');

let ROOT = path.join(os.homedir(), '.autobot', 'sessions');
const MAX_RESULT = 4000;
const MAX_FILE = 8 * 1024 * 1024;
const KEEP_TURNS = 200;

function setRoot(dir) { ROOT = dir; }
const safe = (s) => String(s || 'scratch').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120) || 'scratch';

function clip(v, n) {
  const s = typeof v === 'string' ? v : (v == null ? '' : JSON.stringify(v));
  return s.length > n ? s.slice(0, n) + `… (${s.length - n} more chars)` : s;
}

function shape(evt) {
  if (!evt || typeof evt !== 'object') return null;
  const e = { ...evt };
  delete e.messages; // whole transcripts live in the conversation, not the log
  if (e.type === 'toolResult') e.result = clip(e.result, MAX_RESULT);
  if (e.type === 'tool' && e.args) {
    try {
      const a = { ...e.args };
      for (const k of ['content', 'new_string', 'old_string']) if (typeof a[k] === 'string') a[k] = clip(a[k], 600);
      e.args = a;
    } catch (_) {}
  }
  if (e.type === 'swarm' && typeof e.answer === 'string') e.answer = clip(e.answer, MAX_RESULT);
  return e;
}

function open(convId, turnId, meta = {}) {
  const dir = path.join(ROOT, safe(convId));
  const file = path.join(dir, safe(turnId) + '.jsonl');
  let ok = true;
  let size = 0;
  const pend = { text: '', thinking: '', who: null };
  const t0 = Date.now();
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify({ t: 0, type: 'turn', turnId, convId, startedAt: t0, title: meta.title || '' }) + '\n', { mode: 0o600 });
    prune(dir);
  } catch (_) { ok = false; }
  const write = (obj) => {
    if (!ok || size > MAX_FILE) return;
    try {
      const line = JSON.stringify({ t: Date.now() - t0, ...obj }) + '\n';
      size += line.length;
      fs.appendFileSync(file, line);
    } catch (_) { ok = false; }
  };
  const flush = () => {
    if (pend.text) write({ type: 'text', text: pend.text, subagent: pend.who || undefined });
    if (pend.thinking) write({ type: 'thinking', text: pend.thinking.slice(0, 4000), subagent: pend.who || undefined });
    pend.text = ''; pend.thinking = ''; pend.who = null;
  };
  return {
    file,
    append(evt) {
      if (!evt || typeof evt !== 'object') return;
      const who = evt.subagent || null;
      if (evt.type === 'delta' || evt.type === 'thinking') {
        if (pend.who !== who && (pend.text || pend.thinking)) flush();
        pend.who = who;
        if (evt.type === 'delta') pend.text += String(evt.text || '');
        else pend.thinking += String(evt.text || '');
        return;
      }
      if (evt.type === 'usage' || evt.type === 'retry' || evt.type === 'toolStream') return;
      flush();
      const s = shape(evt);
      if (s) write(s);
    },
    close() { flush(); write({ type: 'turn-end' }); ok = false; },
  };
}

function prune(dir) {
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_TURNS))) fs.unlinkSync(path.join(dir, f));
  } catch (_) {}
}

function read(convId, opts = {}) {
  const dir = path.join(ROOT, safe(convId));
  const limit = Math.max(1, Math.min(Number(opts.limit) || 20, KEEP_TURNS));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort(); } catch (_) { return { turns: [] }; }
  if (opts.turnId) files = files.filter((f) => f === safe(opts.turnId) + '.jsonl');
  const turns = [];
  for (const f of files.slice(-limit)) {
    const events = [];
    try {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { events.push(JSON.parse(line)); } catch (_) {}
      }
    } catch (_) { continue; }
    const head = events[0] && events[0].type === 'turn' ? events[0] : {};
    turns.push({ turnId: head.turnId || f.replace(/\.jsonl$/, ''), startedAt: head.startedAt || 0, title: head.title || '', events });
  }
  return { turns };
}

module.exports = { open, read, setRoot, shape };
