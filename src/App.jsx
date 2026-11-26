import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import 'highlight.js/styles/github-dark.css';
import './styles.css';
import iconsMap from './icons.json';
import { t as _t, LOCALES, localeDir } from './i18n.js';
import { stripToolProtocol } from './textproto.mjs';
import { normBase, LOCAL_BASE, KEY_STATUS_TTL, keySig, statusOf, presetStatus } from './providerstatus-ui.mjs';
import { hydrateProvider, endpointKey } from './providerhydrate.mjs';
import { ctxToastState } from './ctx-toast.mjs';
import ConnectorLogo from './ConnectorLogo.jsx';
import { useVoiceDictation } from './voice';
import { LiveChecklistCard, LiveToolActivityCard, StickyLiveToolBar, FilesChangedBar, summarizeChangedFiles } from './components/LiveProgress.jsx';
import { CodeReviewPane } from './components/CodeReviewPane.jsx';
import { AboutSection } from './components/AboutSection.jsx';
import { NotificationCenter, useNotificationCenter } from './components/NotificationCenter.jsx';
import PermissionDock from './components/PermissionDock.jsx';
import MessageQueueTray, { filterQueueForConv, pickNextRunnableQueued, moveQueueItem, stepQueueItemWithinConv } from './components/MessageQueueTray.jsx';
import { UI_FONT_PRESETS, MONO_FONT_PRESETS, DEFAULT_TYPOGRAPHY, normalizeTypography, resolveUiFontStack, resolveMonoFontStack, applyTypographyToDocument } from './typography.js';
import { deriveSubAgents } from './review-helpers.mjs';
import { IdeWorkbench } from './ide/IdeWorkbench.jsx';
import { MindMapView } from './ide/MindMapView.jsx';
import { shortcutLabels } from './ide/shortcuts';
import { Icon, iconChar, GoogleDriveIcon } from './components/Icon.jsx';
import { QuestionModal, ComputerUseModal, CommandPalette, FindBar, GoogleDriveModal } from './features/AppModals.jsx';
import { MemoryView, ProjectsView, McpView, NotebooksView } from './features/WorkspacePanels.jsx';

// Icon, iconChar, GoogleDriveIcon imported from ./components/Icon.jsx

// ---------- provider notices ----------
// Every banner in the account/picker surface is dismissible. The dismissed
// value is the banner's own text, so hiding "Imported 2 accounts" can never
// also hide the next, different message — a new failure always speaks up.
// `storeError` stays honest: dismissal is per surface and per mounted
// component, so it never clears the underlying error, only this rendering of it.
function ProvNotice({ text, warn, className }) {
  const [closed, setClosed] = useState(null);
  if (!text) return null;
  if (closed === text) return null;
  return (
    <div className={'prov-notice' + (warn ? ' warn' : '') + (className ? ' ' + className : '')}>
      <span className="prov-notice-text">{text}</span>
      <button
        type="button"
        className="prov-notice-x"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={(e) => { e.stopPropagation(); setClosed(text); }}
      ><Icon name="X" size={11} /></button>
    </div>
  );
}

// ---------- OpenCode-style UI sound synthesizer (WebAudio) ----------
const SOUND_PRESETS = [
  { id: 'staplebops-01', label: 'Staplebops 01', notes: [523.25, 659.25], dur: 0.08, type: 'sine' },
  { id: 'staplebops-02', label: 'Staplebops 02', notes: [587.33, 440.0], dur: 0.09, type: 'triangle' },
  { id: 'staplebops-05', label: 'Staplebops 05', notes: [493.88, 659.25, 783.99], dur: 0.075, type: 'sine' },
  { id: 'aurora-01', label: 'Aurora Chime', notes: [659.25, 880.0, 1046.5], dur: 0.09, type: 'sine' },
  { id: 'soft-pulse', label: 'Soft Pulse', notes: [392.0, 523.25], dur: 0.07, type: 'triangle' },
  { id: 'none', label: 'None (Muted)', notes: [], dur: 0, type: 'sine' },
];

function playUiSound(presetId) {
  try {
    const preset = SOUND_PRESETS.find((s) => s.id === presetId);
    if (!preset || !preset.notes.length) return;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    preset.notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = preset.type || 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.07);
      gain.gain.setValueAtTime(0.0001, now + idx * 0.07);
      gain.gain.exponentialRampToValueAtTime(0.08, now + idx * 0.07 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.07 + preset.dur + 0.05);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.07);
      osc.stop(now + idx * 0.07 + preset.dur + 0.07);
    });
    setTimeout(() => { try { ctx.close(); } catch (_) {} }, 500);
  } catch (_) {}
}

function sendDesktopNotification(kind, title, body, settings, opts = {}) {
  try {
    const notif = (settings && settings.notifications) || { agent: true, permissions: true, questions: true, errors: false };
    const sounds = (settings && settings.sounds) || { agent: 'staplebops-01', permissions: 'staplebops-02', questions: 'staplebops-05', errors: 'none' };
    if (sounds[kind] && sounds[kind] !== 'none') playUiSound(sounds[kind]);
    if (!opts.force && !notif[kind]) return;
    const cleanTitle = title || 'Akron Code';
    const cleanBody = String(body || '').slice(0, 180);
    if (typeof window !== 'undefined' && window.autobot && typeof window.autobot.notify === 'function') {
      window.autobot.notify({
        kind,
        title: cleanTitle,
        subtitle: opts.subtitle || '',
        body: cleanBody,
        convId: opts.convId || null,
        force: !!opts.force,
        notifyWhenFocused: !!notif.notifyWhenFocused,
        sound: !!notif.sound,
      }).catch(() => {});
      return;
    }
    if (typeof Notification !== 'undefined') {
      if (Notification.permission === 'granted') {
        new Notification(cleanTitle, { body: cleanBody, silent: true });
      } else if (Notification.permission === 'default' && Notification.requestPermission) {
        Notification.requestPermission().then((p) => {
          if (p === 'granted') new Notification(cleanTitle, { body: cleanBody, silent: true });
        }).catch(() => {});
      }
    }
  } catch (_) {}
}

// ---------- DeepSeek Harness runtime profiles ----------
const HARNESS_PROFILES = [
  { id: 'full', name: 'Full IDE', hint: 'All 146+ tools, subagents, browser & computer use', prompt: '' },
  { id: 'fast', name: 'Fast Coder', hint: 'Minimal deliberation, rapid Read → Edit → Test loop', prompt: '[Harness Profile: Fast Coder] Move directly to Read/Edit/Bash with crisp, concise edits and immediate verification.' },
  { id: 'architect', name: 'Deep Architect', hint: 'System boundaries, design tradeoffs & multi-file invariants', prompt: '[Harness Profile: Deep Architect] Analyze module boundaries, invariants, and tradeoffs thoroughly before modifying code.' },
  { id: 'security', name: 'Security & REA', hint: 'Audit-first hardening, secret safety & binary inspection', prompt: '[Harness Profile: Security & REA] Prioritize security boundaries, input validation, and binary/package verification via REA tools.' },
];

// ---------- chat notice bar ----------
// The bar above the composer carries compaction notes, goal echoes and the
// orchestrator-pool drop ("Left 1 orchestrator model out of this turn — …").
// Dismissal clears the parent notice state directly so the same message can
// appear again cleanly if triggered later, and it also auto-clears after 5s.
function ChatNoticeBar({ text, onDismiss }) {
  if (!text) return null;
  return (
    <div className="noticebar">
      <span className="noticebar-text">{text}</span>
      <button
        type="button"
        className="noticebar-x"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => onDismiss && onDismiss()}
      ><Icon name="X" size={12} /></button>
    </div>
  );
}

// ---------- markdown ----------
// Parse a code fence info string into { lang, file }. Supports Claude Code's
// ` ```lang path/to/file.ext ` and ` ```lang:file.ext ` conventions so the
// "Apply to file" button knows where to write the block.
function parseCodeInfo(infostring) {
  const raw = (infostring || '').trim();
  if (!raw) return { lang: '', file: '' };
  const colon = raw.match(/^([\w+-]*):(.+)$/);
  if (colon) return { lang: colon[1] || '', file: colon[2].trim() };
  const parts = raw.split(/\s+/);
  const lang = parts[0] || '';
  for (const tok of parts.slice(1)) {
    if (/[\/\\]/.test(tok) || /\.[A-Za-z0-9]{1,8}$/.test(tok)) return { lang, file: tok };
  }
  return { lang, file: '' };
}

const mdRenderer = {
  code(code, infostring) {
    const { lang, file } = parseCodeInfo(infostring);
    let out;
    try {
      if (lang && hljs.getLanguage(lang)) out = hljs.highlight(code, { language: lang }).value;
      else out = hljs.highlightAuto(code).value;
    } catch {
      out = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    const applyBtn = file
      ? `<button class="apply-btn" data-file="${escapeHtml(file)}" data-code="${encodeURIComponent(code)}" title="Write this block to ${escapeHtml(file)}">Apply</button>`
      : '';
    const fileTag = file ? `<span class="codeblock-file" title="Apply writes this file">${escapeHtml(file)}</span>` : '';
    return `<div class="codeblock"><div class="codeblock-head"><span class="codeblock-lang">${escapeHtml(lang || 'code')}</span>${fileTag}<span class="codeblock-actions"><button class="copy-btn" data-code="${encodeURIComponent(code)}">Copy</button>${applyBtn}</span></div><pre><code class="hljs">${out}</code></pre></div>`;
  },
};
marked.use({ renderer: mdRenderer, gfm: true, breaks: true });

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A failed provider call can hand us a gateway page ("LLM 502: <html><head>…")
// or a Cloudflare interstitial. The main process already scrubs it, but the
// banner is a text surface — never render markup fragments the user can't read.
function cleanErr(s) {
  return String(s == null ? '' : s)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

function fmtSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Assistant text is sanitised Markdown; tool-protocol blocks are removed by
// stripToolProtocol() (src/textproto.mjs) since the call already renders as a card.
function renderMarkdown(md) {
  let html;
  try { html = marked.parse(stripToolProtocol(md)); } catch { html = escapeHtml(stripToolProtocol(md)); }
  return DOMPurify.sanitize(html);
}

// ---------- Link unfurl (Claude Desktop og / twitter / xlink parity) ----------
// Bare URLs in a message become preview cards. The fetch happens in the main
// process behind an SSRF guard (electron/unfurl.js) — the renderer only ever
// receives sanitised metadata, never page HTML.
const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

function extractLinks(text) {
  const out = [];
  const seen = new Set();
  const src = String(text || '');
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(src))) {
    let url = m[0].replace(/[.,;:!?*_~]+$/, '');
    // Balance a trailing ")" only when the URL itself contains "("
    while (url.endsWith(')') && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) url = url.slice(0, -1);
    const key = url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    if (/\.(png|jpe?g|gif|webp|avif|svg|ico|mp4|webm|mov|mp3|wav|pdf|zip|tar|gz|dmg|exe)$/i.test(key)) continue;
    seen.add(key);
    out.push(url);
    if (out.length >= 3) break;
  }
  return out;
}

const UNFURL_MEMO = new Map(); // url -> Promise<result>

function fetchUnfurl(url) {
  if (!UNFURL_MEMO.has(url)) {
    const p = (window.autobot && window.autobot.unfurl)
      ? window.autobot.unfurl(url).catch(() => ({ ok: false, url, message: 'Preview failed.' }))
      : Promise.resolve({ ok: false, url, message: 'Preview unavailable.' });
    UNFURL_MEMO.set(url, p);
    // A failure is not worth remembering forever; a success is cached in main.
    p.then((r) => { if (!r || !r.ok) setTimeout(() => UNFURL_MEMO.delete(url), 30000); });
  }
  return UNFURL_MEMO.get(url);
}

function LinkPreviews({ text }) {
  const links = useMemo(() => extractLinks(text), [text]);
  const [cards, setCards] = useState({});
  const [dismissed, setDismissed] = useState({});
  useEffect(() => {
    let alive = true;
    links.forEach((url) => {
      fetchUnfurl(url).then((res) => {
        if (!alive || !res || !res.ok) return;
        if (!res.title && !res.image && !res.description) return;
        setCards((prev) => (prev[url] ? prev : { ...prev, [url]: res }));
      });
    });
    return () => { alive = false; };
  }, [links.join('|')]);
  const visible = links.filter((u) => cards[u] && !dismissed[u]);
  if (!visible.length) return null;
  return (
    <div className="link-previews">
      {visible.map((url) => {
        const c = cards[url];
        const host = c.siteName || '';
        return (
          <div className="link-card" key={url}>
            <a className="link-card-main" href={c.resolvedUrl || url} target="_blank" rel="noreferrer">
              {c.image ? (
                <span className="link-card-img"><img src={c.image} alt="" loading="lazy" onError={(e) => { e.currentTarget.parentElement.style.display = 'none'; }} /></span>
              ) : (
                <span className="link-card-icon"><Icon name="Globe" size={18} /></span>
              )}
              <span className="link-card-text">
                <span className="link-card-site">{host}</span>
                <span className="link-card-title">{c.title}</span>
                {c.description ? <span className="link-card-desc">{c.description}</span> : null}
              </span>
            </a>
            <button className="icon-btn link-card-x" title="Hide preview" onClick={() => setDismissed((d) => ({ ...d, [url]: true }))}>
              <Icon name="X" size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

function extractCodeBlocks(md) {
  const blocks = [];
  const re = /```([^\n]*)\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(md || ''))) {
    const lang = m[1].trim() || 'text';
    if (lang.toLowerCase() === 'tool') continue;
    blocks.push({ lang, code: m[2] });
  }
  return blocks;
}

const PRESETS = [
  // --- Local / self-hosted ---
  { name: 'Ollama (local)', baseURL: 'http://localhost:11434/v1', model: 'llama3.1', apiKey: '', supportsTools: true },
  { name: 'LM Studio (local)', baseURL: 'http://localhost:1234/v1', model: 'local-model', apiKey: '', supportsTools: true },
  { name: 'FreeLLMAPI (local router)', baseURL: 'http://localhost:3001/v1', model: 'auto', apiKey: '', supportsTools: true },
  { name: 'FreeLLMAPI · Unified Router', baseURL: 'http://127.0.0.1:31415/v1', model: 'auto', apiKey: '', supportsTools: true },

  // --- DeepSeek ---
  { name: 'DeepSeek (official)', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', supportsTools: true },
  { name: 'DeepSeek Reasoner', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', apiKey: '', supportsTools: true },

  // --- TokenRouter (Kimi K3.1 Pro + DeepSeek V4.1 Flash) ---
  { name: 'TokenRouter · Kimi K3.1 Pro', baseURL: 'https://api.tokenrouter.com/v1', model: 'moonshotai/kimi-k3.1-pro', apiKey: '', supportsTools: true, maxTokens: 8192, reasoningLevel: 'auto' },
  { name: 'TokenRouter · DeepSeek V4.1 Flash', baseURL: 'https://api.tokenrouter.com/v1', model: 'deepseek/deepseek-v4.1-flash-1017', apiKey: '', supportsTools: true, maxTokens: 8192, reasoningLevel: 'auto' },

  // --- Free tiers (OpenAI-compatible) ---
  { name: 'Groq (free tier)', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '', supportsTools: true },
  { name: 'Cerebras (free)', baseURL: 'https://api.cerebras.ai/v1', model: 'llama3.1-8b', apiKey: '', supportsTools: true },
  { name: 'Mistral (La Plateforme)', baseURL: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', apiKey: '', supportsTools: true },
  { name: 'Cohere', baseURL: 'https://api.cohere.com/v1', model: 'command-r-plus', apiKey: '', supportsTools: true },
  { name: 'Z.ai / Zhipu (GLM)', baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-4-plus', apiKey: '', supportsTools: true },
  { name: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-bolt-e4b', apiKey: '', supportsTools: true },
  { name: 'HuggingFace Inference', baseURL: 'https://router.huggingface.co/v1', model: 'meta-llama/Llama-3.3-70B-Instruct', apiKey: '', supportsTools: true },
  { name: 'Together AI (free)', baseURL: 'https://api.together.xyz/v1', model: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', apiKey: '', supportsTools: true },
  { name: 'OpenRouter (free models)', baseURL: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.1-8b-instruct:free', apiKey: '', supportsTools: true },
  { name: 'GitHub Models', baseURL: 'https://models.inference.ai.azure.com', model: 'gpt-4o-mini', apiKey: '', supportsTools: true },
  { name: 'ModelScope', baseURL: 'https://api-inference.modelscope.cn/v1', model: 'Qwen/Qwen3-32B', apiKey: '', supportsTools: true },

  // --- Paid (any key) ---
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', supportsTools: true },

  // --- Any OpenAI-compatible endpoint ---
  { name: 'Custom', baseURL: '', model: '', apiKey: '', supportsTools: true },
];

// ---------- Provider key status (model picker dots) ----------
// Keys live per-endpoint so picking a different preset never reuses another
// provider's credential. Presets that ship a working key seed the map.
// Status classification lives in ./providerstatus-ui.mjs (unit-tested).
const PRESET_KEYS = PRESETS.reduce((acc, p) => { if (p.apiKey && p.baseURL) acc[normBase(p.baseURL)] = p.apiKey; return acc; }, {});
const FREELLM_LOOPBACK_BASES = [
  'http://localhost:3001/v1',
  'http://127.0.0.1:3001/v1',
  'http://localhost:31415/v1',
  'http://127.0.0.1:31415/v1',
];
const isFreeLlmLoopback = (base) => FREELLM_LOOPBACK_BASES.includes(normBase(base));
const resolveLoopbackKey = (base, map, cur) => {
  const nb = normBase(base);
  const m = map || {};
  if (nb && m[nb]) return m[nb];
  if (nb && PRESET_KEYS[nb]) return PRESET_KEYS[nb];
  if (cur && nb && normBase(cur.baseURL) === nb && cur.apiKey) return cur.apiKey;
  if (nb && isFreeLlmLoopback(nb)) {
    for (const alt of FREELLM_LOOPBACK_BASES) {
      if (m[alt]) return m[alt];
    }
    if (cur && isFreeLlmLoopback(cur.baseURL) && cur.apiKey) return cur.apiKey;
  }
  return '';
};

// ---------- Styles (Claude Desktop parity: preset writing styles) ----------
const STYLES = [
  { id: 'default', name: 'Default', hint: '', prompt: '' },
  { id: 'concise', name: 'Concise', hint: 'Keep it short', prompt: 'Be concise and direct. Prefer short answers, bullet points, and skip preamble.' },
  { id: 'explanatory', name: 'Explanatory', hint: 'Explain everything', prompt: 'Explain concepts thoroughly. Define terms, give context, and walk through reasoning step by step.' },
  { id: 'formal', name: 'Formal', hint: 'Professional tone', prompt: 'Use a formal, professional tone. Avoid slang and contractions. Structure answers clearly.' },
  { id: 'casual', name: 'Casual', hint: 'Friendly tone', prompt: 'Use a friendly, casual, conversational tone.' },
  { id: 'code', name: 'Code-first', hint: 'Prioritize code', prompt: 'Prioritize working code and concrete examples over prose. Include full, runnable snippets.' },
];

// ---------- Thinking level (user-facing control for reasoning models) ----------
// Only meaningful for models that reason; harmless for the rest (the directive
// is ignored and `reasoning_effort` is stripped on endpoints that reject it).
const REASON_LEVELS = [
  { id: 'auto',   name: 'Auto',   hint: 'Model decides' },
  { id: 'low',    name: 'Low',    hint: 'Fast, minimal thinking' },
  { id: 'medium', name: 'Medium', hint: 'Balanced reasoning' },
  { id: 'high',   name: 'High',   hint: 'Deep, thorough reasoning' },
];
const REASON_LABELS = REASON_LEVELS.reduce((acc, l) => { acc[l.id] = l.name; return acc; }, {});

// ---------- token / cost helpers (slash commands: /usage /cost /context) ----------
// Per-million-token list prices in USD. Matched by substring against the model
// id; the default is a mid-tier frontier rate so an unknown model still gives a
// sane order-of-magnitude estimate rather than $0.
const PRICES = [
  { re: /opus/i, in: 15, out: 75 },
  { re: /sonnet/i, in: 3, out: 15 },
  { re: /haiku/i, in: 0.8, out: 4 },
  { re: /kimi|moonshot/i, in: 0.6, out: 2.5 },
  { re: /deepseek/i, in: 0.28, out: 0.42 },
  { re: /glm|zhipu/i, in: 0.6, out: 2.2 },
  { re: /gpt-5|gpt5|o[1-4]/i, in: 1.25, out: 10 },
  { re: /gpt-4/i, in: 2.5, out: 10 },
  { re: /gemini.*(pro|ultra)/i, in: 1.25, out: 10 },
  { re: /qwen/i, in: 0.4, out: 1.2 },
  { re: /grok/i, in: 2, out: 10 },
  { re: /command-r/i, in: 2.5, out: 10 },
  { re: /mistral-large/i, in: 2, out: 6 },
];
const priceFor = (model) => {
  const m = PRICES.find((p) => p.re.test(String(model || '')));
  return m ? { in: m.in, out: m.out } : { in: 3, out: 15 };
};
const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
};
// Grouped exact count — used where the real number matters (context meter).
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const estimateCost = (model, prompt, completion) => {
  const p = priceFor(model);
  return ((Number(prompt) || 0) / 1e6) * p.in + ((Number(completion) || 0) / 1e6) * p.out;
};
const fmtCost = (usd) => {
  const v = Number(usd) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return '$' + v.toFixed(4);
  return '$' + v.toFixed(v < 1 ? 3 : 2);
};
// Context windows come from the account wherever the account will tell us.
// `autobot:providerModels` resolves each model's real window (Antigravity's
// catalog states `maxTokens`; Claude/Grok advertise nothing so the main-side
// `model-catalog` rule fills in the documented value) and InputBar caches the
// result here. Exact-id hits win; the regexes below are only the offline
// fallback for a provider that was never loaded in this install.
const MODEL_WINDOW_CACHE = 'autobot:modelWindows';
const contextWindowFor = (model) => {
  const m = String(model || '');
  try {
    const cache = loadJSON(MODEL_WINDOW_CACHE, {}) || {};
    const hit = Number(cache[m]);
    if (Number.isFinite(hit) && hit > 0) return hit;
  } catch (_) { /* cache is advisory */ }
  if (/kimi|moonshot/i.test(m)) return 256000;
  if (/deepseek/i.test(m)) return 128000;
  if (/glm|zhipu/i.test(m)) return 200000;
  if (/gemini-4|gemini-3/i.test(m)) return 1048576;
  if (/gemini/i.test(m)) return 1000000;
  if (/gpt-5|o[1-4]/i.test(m)) return 400000;
  if (/gpt-4/i.test(m)) return 128000;
  if (/qwen/i.test(m)) return 128000;
  if (/grok/i.test(m)) return 131072;
  if (/sonnet|opus|haiku|anthropic/i.test(m)) return 200000;
  return 128000;
};
// Two different numbers live in a usage record: `prompt_tokens` is the *sum*
// across every model call in a turn (that is what `/cost` prices), while
// `context_tokens` is the prompt size of the last call — the only figure that
// can be compared against a context window. Older records have no
// `context_tokens`, so fall back to prompt_tokens/max(calls,1) rather than
// claiming the window is full three times over.
const usedTokens = (u) => {
  if (!u) return 0;
  const ctx = Number(u.context_tokens);
  if (Number.isFinite(ctx) && ctx > 0) return ctx;
  const p = Number(u.prompt_tokens) || 0;
  const calls = Number(u.calls) || 0;
  return calls > 1 ? Math.round(p / calls) : p;
};
const msgText = (m) => {
  const c = m && m.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text || '') : String(x))).join('\n');
  try { return JSON.stringify(c); } catch { return String(c); }
};

// ---------- payload builders (pure) ----------
const buildDirectives = (styleId, reasoningLevel, opts = {}) => {
  const style = STYLES.find((s) => s.id === styleId);
  const d = [];
  const profile = opts.harnessProfile ? HARNESS_PROFILES.find((p) => p.id === opts.harnessProfile) : null;
  if (profile && profile.prompt) d.push(profile.prompt);
  if (style && style.prompt) d.push('[Style: ' + style.name + '] ' + style.prompt);
  if (reasoningLevel && reasoningLevel !== 'auto') {
    const dir = {
      low: 'Reasoning level: LOW. Think briefly, then answer directly and efficiently. Do not over-deliberate.',
      medium: 'Reasoning level: MEDIUM. Think step by step and reason carefully before answering.',
      high: 'Reasoning level: HIGH. Reason deeply and thoroughly step by step before answering; consider edge cases, verify your logic, then respond.',
    }[reasoningLevel];
    if (dir) d.push(dir);
  }
  if (opts.webSearch) d.push('Use the WebSearch tool to find current, accurate, up-to-date information whenever the question benefits from it.');
  if (opts.project && opts.project.instructions) d.push('[Project: ' + opts.project.name + ']\nProject instructions (follow these):\n' + opts.project.instructions);
  return d;
};
// Compact record of what the assistant actually did with tools last turn.
// Model switches need this: the new model sees files + mindmap, but without the
// action trace it re-does work or claims things it never ran.
const summarizeTrace = (tools) => {
  const list = Array.isArray(tools) ? tools.filter((t) => t && t.name) : [];
  if (!list.length) return '';
  const clip = (v, n) => {
    if (v == null) return '';
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, n || 110);
  };
  const lines = list.slice(-15).map((t) => {
    const a = t.args || {};
    const target = a.path || a.file || a.command || a.query || a.url || a.name || a.description || a.prompt || '';
    const bad = /^(Error|Tool error)/i.test(String(t.result || '').trim());
    const lim = /^(Task|Agent|Swarm|Workflow)$/.test(t.name) ? 600 : 110;
    return `- ${t.name}${target ? '(' + clip(target, 90) + ')' : ''} → ${bad ? 'ERROR: ' : ''}${clip(t.result, lim) || '(no result)'}`;
  });
  return '\n\n[Tool actions taken in your previous turn — this already happened, do not redo it]\n' + lines.join('\n');
};

const buildPayloadMessages = (msgs) => msgs.map((m) => {
  const atts = m.attachments || [];
  const images = atts.filter((a) => a.isImage && a.dataUrl);
  const textAtts = atts.filter((a) => !(a.isImage && a.dataUrl));
  let textPart = m.content || '';
  if (m.role === 'assistant' && Array.isArray(m.tools) && m.tools.length) {
    textPart += summarizeTrace(m.tools);
  }
  if (textAtts.length) {
    textPart += '\n\nAttached files:\n' + textAtts.map((a) => (a.isText && a.content != null
      ? `\n--- FILE: ${a.name} ---\n${a.content}\n--- END FILE: ${a.name} ---`
      : `\n[Attached file: ${a.name} (${a.size} bytes, binary)]`)).join('\n');
  }
  if (images.length) {
    const parts = [];
    if (textPart.trim()) parts.push({ type: 'text', text: textPart });
    for (const img of images) parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    return { role: m.role, content: parts };
  }
  const out = { role: m.role, content: textPart };
  if (m.tool_calls) out.tool_calls = m.tool_calls;
  if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
  if (m.name) out.name = m.name;
  return out;
});

// Never ship a credential in the renderer bundle. The default is the keyless
// local FreeLLMAPI router; a real key is only ever typed by the user (and then
// persisted per endpoint in `autobot:providerKeys` / main's settings file).
const DEFAULT_PROVIDER = { baseURL: 'http://localhost:3001/v1', apiKey: '', model: 'auto', temperature: 0.7, maxTokens: 8192, reasoningLevel: 'auto', supportsTools: true };

// ---------- persistence helpers ----------
function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// Dismiss a popover on outside mousedown, Escape, or when focus moves into a
// guest <webview>/<iframe> (clicks inside a guest never reach this document, but
// the host window blurs). A plain app switch does NOT dismiss: a sign-in that
// opened the system browser, or a native file dialog, must not lose the menu.
function useDismiss(open, refs, close) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return undefined;
    const inside = (t) => refs.some((r) => r && r.current && t && r.current.contains(t));
    const onDown = (e) => { if (!inside(e.target)) closeRef.current(); };
    const onKey = (e) => { if (e.key === 'Escape') closeRef.current(); };
    const onBlur = () => {
      setTimeout(() => {
        const ae = document.activeElement;
        const tag = ae && ae.tagName ? ae.tagName.toUpperCase() : '';
        if (tag === 'WEBVIEW' || tag === 'IFRAME') closeRef.current();
      }, 0);
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('blur', onBlur);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
}

// ---------- voice dictation (Web Speech API; matches Claude Desktop dictate) ----------
let _rec = null;
function toggleDictation(inputRef, setDictating) {
  const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
  if (!SR) { if (window.autobot?.speak) window.autobot.speak('Speech recognition is not available in this environment.'); return; }
  if (_rec) {
    // already listening → stop
    try { _rec.stop(); } catch {}
    setDictating(false);
    _rec = null;
    return;
  }
  const rec = new SR();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.continuous = false;
  rec.onresult = (e) => {
    const transcript = Array.from(e.results).map((r) => r[0].transcript).join(' ');
    if (inputRef.current) {
      const el = inputRef.current;
      const v = el.value;
      el.value = v ? v + ' ' + transcript : transcript;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  };
  rec.onend = () => { setDictating(false); _rec = null; };
  rec.onerror = () => { setDictating(false); _rec = null; };
  _rec = rec;
  setDictating(true);
  try { rec.start(); } catch { setDictating(false); _rec = null; }
}

// Client-side File/Blob → attachment (used by drag-drop + paste). Images become
// base64 data-URLs for vision; text files are inlined up to a cap.
const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html|css|scss|less|xml|yaml|yml|toml|ini|sh|bash|zsh|fish|sql|log|csv|tsv|vue|svelte|graphql|gql|prisma|env|conf|gitignore|dockerfile)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?)$/i;
function readBlobAsDataUrl(blob) { return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); }); }
async function filesToAttachments(files) {
  const out = [];
  for (const f of Array.from(files || [])) {
    const att = { name: f.name, path: '', size: f.size, isText: false, isImage: false, content: null, dataUrl: null };
    if (IMAGE_EXT.test(f.name)) {
      att.isImage = true;
      if (f.size <= 8 * 1024 * 1024) att.dataUrl = await readBlobAsDataUrl(f);
    } else if (TEXT_EXT.test(f.name) && f.size <= 200 * 1024) {
      try { const txt = await f.text(); if (!txt.includes('\u0000')) { att.content = txt; att.isText = true; } } catch (_) {}
    }
    out.push(att);
  }
  return out;
}

export default function App() {
  const [convs, setConvs] = useState(() => loadJSON('autobot:convs', []));
  const [activeId, setActiveId] = useState(() => loadJSON('autobot:activeId', null));
  const [openTabIds, setOpenTabIds] = useState(() => {
    const savedTabs = loadJSON('autobot:openTabs', null);
    const curId = loadJSON('autobot:activeId', null);
    if (Array.isArray(savedTabs) && savedTabs.length) return savedTabs;
    return curId ? [curId] : [];
  });
  useEffect(() => { saveJSON('autobot:openTabs', openTabIds); }, [openTabIds]);
  useEffect(() => {
    if (!activeId) return;
    setOpenTabIds((tabs) => (tabs.includes(activeId) ? tabs : [...tabs, activeId]));
  }, [activeId]);
  const [provider, setProvider] = useState(() => hydrateProvider(loadJSON('autobot:provider', {}), DEFAULT_PROVIDER, PRESETS));
  const [providerKeys, setProviderKeys] = useState(() => loadJSON('autobot:providerKeys', {}));
  const [settings, setSettings] = useState(() => {
    const base = loadJSON('autobot:settings', { theme: 'dark', useMemory: true, locale: 'en' });
    return {
      ...base,
      harnessProfile: base.harnessProfile || 'full',
      typography: normalizeTypography(base.typography),
      notifications: { agent: true, permissions: true, questions: true, errors: false, ...(base.notifications || {}) },
      sounds: { agent: 'staplebops-01', permissions: 'staplebops-02', questions: 'staplebops-05', errors: 'none', ...(base.sounds || {}) },
    };
  });
  const T = useCallback((k) => _t(settings.locale, k), [settings.locale]);
  const [orchestrator, setOrchestrator] = useState(() => ({ enabled: false, providers: [], activeIndex: -1 }));
  const [features, setFeatures] = useState(() => ({ computerUse: true, chrome: false, bridges: false, quickEntry: true, computerUseTeach: false, buddy: false, remoteControl: false, extensions: false, developerMode: false, trustedFolders: false, chromeHost: '127.0.0.1', chromePort: 9222 }));
  // Single write path for feature toggles: state + main-process mirror. The
  // Environment pane and Settings both call this; before it existed the pane
  // threw `ReferenceError: saveFeat is not defined` and blanked the window.
  const saveFeat = useCallback((next) => {
    setFeatures(next);
    try { window.autobot.setFeatures(next); } catch (_) { /* main may be older */ }
  }, []);
  const [account, setAccount] = useState(() => loadJSON('autobot:account', {
    signedIn: false,
    authMethod: null, // null | 'anthropic' | 'sso'
    email: '',
    plan: 'Free', // Free | Pro | Max
    sso: { enabled: false, idpName: '', issuer: '', clientId: '', domain: '' },
    sync: { enabled: false, lastSync: null, status: 'never', deviceCount: 1 },
  }));
  const [panel, setPanel] = useState('chats'); // chats | memory | skills | notebooks | mcp | artifacts | terminal | projects | search | plugins | scheduled
  const [workbenchMode, setWorkbenchMode] = useState('agent'); // 'agent' | 'ide'
  const [ideExternalOpenFile, setIdeExternalOpenFile] = useState(null);
  const editorContextXmlRef = useRef('');
  // Jump-to-message target set by the global search panel; cleared once scrolled.
  const [pendingScroll, setPendingScroll] = useState(null);
  const [showSettings, setShowSettings] = useState(false);
  // A keyless preset clicked in the model picker: Settings opens with it staged
  // and the session provider only switches once a key is saved.
  const [pendingPreset, setPendingPreset] = useState(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(false);
  pausedRef.current = paused;
  const [scrolledAway, setScrolledAway] = useState(false);
  // Wall-clock start of the active run — powers the live "Working · 12s" row.
  const [runStartedAt, setRunStartedAt] = useState(0);
  // Token accounting for /usage, /cost, /context and /insights. `usage` events
  // stream from the main process each step; the final `done` carries the total.
  const [lastUsage, setLastUsage] = useState(() => loadJSON('autobot:lastUsage', null));
  useEffect(() => { saveJSON('autobot:lastUsage', lastUsage); }, [lastUsage]);
  const [goal, setGoal] = useState('');
  const [queued, setQueued] = useState(() => {
    const saved = loadJSON('autobot:queued', []);
    return Array.isArray(saved) ? saved : [];
  }); // messages typed while a reply streams
  const [queuePausedByConv, setQueuePausedByConv] = useState(() => {
    const saved = loadJSON('autobot:queuePausedByConv', {});
    return saved && typeof saved === 'object' ? saved : {};
  });
  useEffect(() => { saveJSON('autobot:queued', queued); }, [queued]);
  useEffect(() => { saveJSON('autobot:queuePausedByConv', queuePausedByConv); }, [queuePausedByConv]);
  const [thinking, setThinking] = useState('');
  const [live, setLive] = useState(null); // { content, tools: [] }
  // The live stream is mirrored in a ref and every update goes through
  // setLiveSync, so commitLive can read the final stream synchronously instead
  // of calling setConvs from inside a setLive updater — React.StrictMode runs
  // updaters twice, which duplicated every assistant reply.
  const liveRef = useRef(null);
  const setLiveSync = useCallback((v) => {
    const next = typeof v === 'function' ? v(liveRef.current) : v;
    liveRef.current = next;
    setLive(next);
  }, []);
  const [cwd, setCwd] = useState('');
  const [error, setErrorRaw] = useState('');
  const [question, setQuestion] = useState(null); // { id, type, text, options }

  // Organization compliance profile (`taint:*` capability namespace). The main
  // process owns the file; the renderer keeps the evaluated snapshot so every
  // gate resolves synchronously while the UI renders.
  const [compliance, setCompliance] = useState(null); // { profile, state, catalog }

  const [memory, setMemory] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpForm, setMcpForm] = useState({ transport: 'stdio', command: '', args: '', url: '' });
  const [subAgents, setSubAgents] = useState([]); // { key, name, status, role, jobRole, model, tier, ms, failover, posts, progress }
  const [swarmInfo, setSwarmInfo] = useState(null); // { supervisor, roster, pools, phase, wave, startedAt }
  const [swarmBoard, setSwarmBoard] = useState([]); // [{ seq, from, to, channel, text, at }]
  const [notebooks, setNotebooks] = useState([]); // names
  const [activeNotebook, setActiveNotebook] = useState(null);
  const [notebookCells, setNotebookCells] = useState([]);
  const [terminal, setTerminal] = useState({ tabs: [], active: null }); // { tabs: [{id,cwd,running,output}], active }
  const [artifactsExplicit, setArtifactsExplicit] = useState([]); // { name, language, content }
  const notifCenter = useNotificationCenter();
  const setNotice = useCallback((text, opts) => {
    const s = String(text || '').trim();
    if (!s) { notifCenter.dismissToast(); return; }
    notifCenter.pushNotification(s, opts);
  }, [notifCenter.pushNotification, notifCenter.dismissToast]);
  const setError = useCallback((msg) => {
    const s = String(msg || '').trim();
    if (!s) { setErrorRaw(''); return; }
    if (s.startsWith('✅')) {
      setErrorRaw('');
      notifCenter.pushNotification(s, { kind: 'success' });
      return;
    }
    setErrorRaw(s);
    notifCenter.pushNotification(s, { kind: 'error' });
  }, [notifCenter.pushNotification]);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setErrorRaw((cur) => (cur === error ? '' : cur)), 5000);
    return () => clearTimeout(t);
  }, [error]);
  const [attachments, setAttachments] = useState([]); // { name, path, size, isText, content }
  // Reasoning / thinking level is stored on the provider object so it (a) drives
  // the prompt directive and (b) is sent to the API as `reasoning_effort`.
  const reasoningLevel = provider.reasoningLevel || 'auto';
  const setReasoningLevel = (lv) => setProvider((p) => ({ ...p, reasoningLevel: lv }));
  const [styleId, setStyleId] = useState('default');
  const [showPalette, setShowPalette] = useState(false); // Command Palette (⌘K)
  const [showFind, setShowFind] = useState(false);       // in-chat Find (⌘F)
  const [findQuery, setFindQuery] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  // Swarm is an OPT-IN escalation the user chooses, not something the model
  // decides on its own: multi-agent (Task/Agent) is the automatic default, and
  // `Swarm` only becomes visible to the model when this pill is on. The roster
  // it uses is restricted to frontier models (see electron/swarm.js).
  const [swarmEnabled, setSwarmEnabled] = useState(() => !!loadJSON('autobot:swarmEnabled', false));
  useEffect(() => { saveJSON('autobot:swarmEnabled', swarmEnabled); }, [swarmEnabled]);
  const [dictating, setDictating] = useState(false);
  const [projects, setProjects] = useState(() => loadJSON('autobot:projects', [])); // { id, name, instructions }
  const [activeProject, setActiveProject] = useState(() => loadJSON('autobot:activeProject', null));
  const [sessionPane, setSessionPane] = useState({ type: null, width: 480 }); // type: null | 'browser' | 'env' | 'runlog' | 'review' | 'subagents' | 'files' | 'terminal'
  const [openPaneTabs, setOpenPaneTabs] = useState(['review']);
  const [settingsInitialSection, setSettingsInitialSection] = useState('providers');
  const openSettingsAt = useCallback((sec = 'providers') => {
    setSettingsInitialSection(sec || 'providers');
    setShowSettings(true);
  }, []);
  const lastPaneRef = useRef('review');
  const [reviewTarget, setReviewTarget] = useState(null);
  const [previewUrl, setPreviewUrl] = useState(null); // file the browser pane should show (generated site)
  const [voiceMode, setVoiceMode] = useState(false); // full-duplex conversational voice session
  const [permissions, setPermissions] = useState(() => loadJSON('autobot:permissions', 'auto')); // 'auto' | 'ask' (B8 Claude Code mode)
  const [permissionQueue, setPermissionQueue] = useState([]); // FIFO pending permission prompts
  const [permError, setPermError] = useState('');
  const [permSubmitting, setPermSubmitting] = useState(false);
  const waitingPermissionConvIds = useMemo(
    () => new Set(permissionQueue.map((p) => p.convId).filter(Boolean)),
    [permissionQueue]
  );
  const [cuConsent, setCuConsent] = useState(null); // pending Computer Use consent { id, tier, tool, sensitive }
  const [planMode, setPlanMode] = useState(null); // active plan-mode banner { active, file }
  const [gdriveModalOpen, setGdriveModalOpen] = useState(false);
  const [gdriveState, setGdriveState] = useState({ connected: false, mode: null, detectedLocalFolders: [] });
  const [envState, setEnvState] = useState({
    active: { kind: 'local', id: null, label: 'This Computer', cwd: '' },
    sshProfiles: [],
    remoteProfiles: [],
    sshConfigHosts: [],
    hostServer: { enabled: false, port: 9477, running: false },
  });

  const refreshEnvState = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.envGetState) {
        const st = await window.autobot.envGetState();
        if (st && st.active) setEnvState(st);
      }
    } catch (_) {}
  }, []);
  useEffect(() => {
    refreshEnvState();
    if (window.autobot && window.autobot.onEnvChanged) {
      return window.autobot.onEnvChanged((st) => {
        if (st && st.active) {
          setEnvState(st);
          if ((st.active.kind === 'ssh' || st.active.kind === 'remote') && st.active.cwd) {
            setCwd(st.active.cwd);
          }
        }
      });
    }
    return undefined;
  }, [refreshEnvState]);

  const switchEnvironment = useCallback(async (spec) => {
    if (!window.autobot || !window.autobot.envSetActive) return;
    const r = await window.autobot.envSetActive(spec);
    if (r && r.ok && r.state) {
      setEnvState(r.state);
      if (r.active && r.active.cwd) setCwd(r.active.cwd);
      setNotice(`Environment: ${r.active?.label || 'This Computer'}`);
    } else if (r && r.error) {
      setError(r.error);
    }
  }, []);

  const refreshGdriveStatus = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.gdriveStatus) {
        const st = await window.autobot.gdriveStatus();
        if (st && typeof st === 'object') setGdriveState(st);
      }
    } catch (_) {}
  }, []);
  useEffect(() => { refreshGdriveStatus(); }, [refreshGdriveStatus]);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const runIdRef = useRef(null);
  const streamingRef = useRef(false);
  streamingRef.current = streaming;
  const voiceActiveRef = useRef(false);
  const voiceRecRef = useRef(null);
  const spokenIdsRef = useRef(new Set());

  const active = convs.find((c) => c.id === activeId) || null;
  const messages = active ? active.messages : [];

  const showSessionPane = useCallback((type) => {
    if (!type) {
      setSessionPane((p) => ({ ...p, type: null }));
      return;
    }
    lastPaneRef.current = type;
    setOpenPaneTabs((tabs) => (tabs.includes(type) ? tabs : [...tabs, type]));
    setSessionPane((p) => ({
      ...p,
      type,
      width: type === 'review' ? Math.max(Number(p.width) || 540, 520) : (p.width || 480),
    }));
    setPanel('chats');
  }, []);

  // Example parity: session panes coexist with chat and toggle via dispatchToggleSessionPane semantics
  const toggleSessionPane = useCallback((type) => {
    const targetType = type || lastPaneRef.current || 'review';
    setSessionPane((p) => {
      if (p.type === targetType || (!type && p.type)) return { ...p, type: null };
      lastPaneRef.current = targetType;
      setOpenPaneTabs((tabs) => (tabs.includes(targetType) ? tabs : [...tabs, targetType]));
      return { ...p, type: targetType };
    });
    // Opening a session pane always returns the main area to the chat context
    setPanel('chats');
  }, []);

  const closeSessionTab = useCallback((tabType) => {
    const nextTabs = openPaneTabs.filter((t) => t !== tabType);
    setOpenPaneTabs(nextTabs);
    setSessionPane((p) => {
      if (!tabType || p.type === tabType) {
        return { ...p, type: nextTabs.length ? nextTabs[nextTabs.length - 1] : null };
      }
      return p;
    });
  }, [openPaneTabs]);

  const openReview = useCallback((target = null) => {
    setReviewTarget(target);
    lastPaneRef.current = 'review';
    setOpenPaneTabs((tabs) => (tabs.includes('review') ? tabs : [...tabs, 'review']));
    setSessionPane((p) => ({ ...p, type: 'review', width: Math.max(Number(p.width) || 540, 520) }));
    setPanel('chats');
  }, []);

  // persist
  useEffect(() => { saveJSON('autobot:convs', convs); }, [convs]);
  // One-time non-destructive sync of existing localStorage chats to SQLite WAL+FTS (~/.autobot/akron.db)
  // plus throttled incremental sync for instant full-text search across sessions.
  const dbMigratedRef = useRef(false);
  useEffect(() => {
    if (!window.autobot?.dbMigrate || dbMigratedRef.current) return;
    dbMigratedRef.current = true;
    if (Array.isArray(convs) && convs.length) {
      window.autobot.dbMigrate(convs).catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!window.autobot?.dbUpsertConv || !activeId) return;
    const cur = Array.isArray(convs) ? convs.find((c) => c.id === activeId) : null;
    if (!cur) return;
    const t = setTimeout(() => {
      window.autobot.dbUpsertConv(cur).catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [convs, activeId]);
  useEffect(() => { saveJSON('autobot:activeId', activeId); }, [activeId]);
  useEffect(() => { saveJSON('autobot:provider', provider); }, [provider]);
  useEffect(() => { saveJSON('autobot:providerKeys', providerKeys); }, [providerKeys]);
  // Credentials live in the main process file (~/.autobot/settings.json, 0600)
  // because headless/scheduled runs read them from there. A renderer profile
  // with no stored provider starts on the built-in default, so adopt the saved
  // endpoint + key once — and hold the mirror below until that decision is made,
  // otherwise the empty default overwrote the user's keyed configuration on
  // every launch. Never overwrites a key the user already has.
  const [settingsAdopted, setSettingsAdopted] = useState(false);
  // Snapshot what the profile held *before* any effect ran. The persist effects
  // above fire on mount and replace an absent profile with the built-in default,
  // so reading localStorage inside the adoption effect would always see the
  // default's key and never adopt the saved one.
  const bootRef = useRef(null);
  if (bootRef.current === null) {
    const bootSettings = loadJSON('autobot:settings', null);
    bootRef.current = {
      own: loadJSON('autobot:provider', null),
      keys: loadJSON('autobot:providerKeys', {}),
      hasTypography: !!(bootSettings && bootSettings.typography),
    };
  }
  // Main's saved provider, remembered so the mirror below can never overwrite a
  // real credential with a renderer profile that merely echoes the built-in
  // default (that clobber cost the user's stored gateway key twice).
  const savedProvRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    Promise.resolve(window.autobot.getSettings()).then((s) => {
      if (cancelled || !s) return;
      if (s.typography && !(bootRef.current && bootRef.current.hasTypography)) {
        setSettings((prev) => ({ ...prev, typography: normalizeTypography(s.typography) }));
      }
      const saved = (s.provider) || {};
      if (saved.baseURL) savedProvRef.current = saved;
      const base = normBase(saved.baseURL);
      if (!base || !saved.apiKey) return;
      const boot = bootRef.current || {};
      const own = boot.own;
      const keys = boot.keys || {};
      const ownBase = endpointKey((own && own.baseURL) || '');
      const ownKey = (own && own.apiKey) || keys[base] || '';
      if (ownKey) {
        // The key is already here, but the *model* can be a stale fallback: the
        // picker only re-inserts an alias the catalog omits while it is the
        // active model, so a reload that starts from an older profile demoted
        // `auto:fast` to the preset's `auto` and the mirror then persisted it.
        // Same endpoint means the saved model is the last one the user chose.
        const sameEndpoint = !ownBase || ownBase === endpointKey(base);
        if (sameEndpoint && saved.model && (own && own.model) !== saved.model) {
          setProvider((v) => ({ ...v, model: saved.model }));
        }
        return;                                            // the user's own key wins
      }
      if (ownBase && ownBase !== endpointKey(base)) return; // a different endpoint was chosen
      savedProvRef.current = saved;
      setProvider((v) => hydrateProvider({ ...v, ...saved }, v, PRESETS));
      setProviderKeys((m) => ({ ...(m || {}), [base]: saved.apiKey }));
    }).catch(() => {}).finally(() => { if (!cancelled) setSettingsAdopted(true); });
    return () => { cancelled = true; };
  }, []);
  // Mirror the active provider into the main-process settings so headless runs
  // (scheduled tasks) use the same model the user picked.
  useEffect(() => {
    if (!settingsAdopted) return;
    // Never let a profile that is just the built-in default overwrite a real
    // keyed endpoint in main's settings file — that file is what headless and
    // scheduled runs read, and the default carries a hardcoded key of its own.
    const boot = (bootRef.current && bootRef.current.own) || null;
    const saved = savedProvRef.current;
    const untouchedDefault = boot
      && endpointKey(boot.baseURL || '') === endpointKey(DEFAULT_PROVIDER.baseURL || '')
      && String(boot.apiKey || '') === String(DEFAULT_PROVIDER.apiKey || '');
    const savedIsOther = saved && saved.apiKey
      && endpointKey(saved.baseURL || '') !== endpointKey(DEFAULT_PROVIDER.baseURL || '');
    if (untouchedDefault && savedIsOther) return;
    try { window.autobot.setSettings({ provider }); } catch (_) {}
  }, [provider, settingsAdopted]);
  useEffect(() => {
    saveJSON('autobot:settings', settings);
    applyTypographyToDocument(settings.typography);
    // Push OS-level & persistent settings (login item + typography) to main.
    try {
      window.autobot.setSettings({
        launchAtLogin: !!settings.launchAtLogin,
        typography: settings.typography,
      });
    } catch (_) {}
  }, [settings]);
  useEffect(() => { saveJSON('autobot:account', account); }, [account]);
  useEffect(() => { saveJSON('autobot:projects', projects); }, [projects]);
  useEffect(() => { saveJSON('autobot:activeProject', activeProject); }, [activeProject]);
  useEffect(() => { saveJSON('autobot:permissions', permissions); }, [permissions]);

  // init cwd + memory + skills
  useEffect(() => {
    // Restore the active conversation's project folder (creates one lazily).
    const id = loadJSON('autobot:activeId', null);
    const ws = loadJSON('autobot:workspace:' + (id || ''), null);
    if (id && ws) window.autobot.getWorkspace(id).then((d) => { if (d) setCwd(d); });
    else if (id) window.autobot.getDefaultCwd(id, '').then(setCwd);
    // No conversation yet → no project folder. Minting one here created that
    // stale `untitled-*` folder every launch and the first build landed in it.
    window.autobot.getMemory().then((m) => setMemory(m.entries || []));
    window.autobot.getSkills().then(setSkills);
    window.autobot.listNotebooks().then(setNotebooks);
    window.autobot.getOrchestrator().then(setOrchestrator);
    window.autobot.getFeatures().then(setFeatures);
    if (window.autobot.complianceGet) window.autobot.complianceGet().then(setCompliance).catch(() => {});
  }, []);

  // When the active conversation changes, switch the working folder to its
  // project workspace (or create one) — Claude Desktop per-project parity.
  useEffect(() => {
    if (!activeId) return;
    window.autobot.getWorkspace(activeId).then((d) => {
      if (d) { setCwd(d); saveJSON('autobot:workspace:' + activeId, d); }
      else {
        const conv = convsRef.current.find((c) => c.id === activeId);
        window.autobot.getDefaultCwd(activeId, conv?.title || '').then((dir) => {
          setCwd(dir); saveJSON('autobot:workspace:' + activeId, dir);
        });
      }
    });
  }, [activeId]);

  // Skill activation/deactivation (per-skill toggle, persisted server-side).
  const refreshSkills = useCallback(async () => {
    const list = await window.autobot.getSkills();
    setSkills(list);
    return list;
  }, []);

  const toggleSkill = useCallback(async (name) => {
    const target = skills.find((x) => x.name === name);
    if (!target) return;
    const next = await window.autobot.setSkillEnabled(name, !target.enabled);
    setSkills(next);
  }, [skills]);

  const setAllSkills = useCallback(async (enabled) => {
    const next = await window.autobot.setAllSkillsEnabled(enabled);
    setSkills(next);
  }, []);

  // Example parity: CmdOrCtrl+Shift+B toggles the Browser session pane
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'B' || e.key === 'b')) {
        e.preventDefault();
        toggleSessionPane('browser');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSessionPane]);

  // Agent tools can request the browser pane (idempotent: never closes it).
  useEffect(() => {
    if (!window.autobot || !window.autobot.onBrowserEnsure) return;
    return window.autobot.onBrowserEnsure(() => {
      setSessionPane((p) => (p.type === 'browser' ? p : { ...p, type: 'browser', width: p.width || 460 }));
      setPanel('chats');
    });
  }, []);

  // Example parity: CmdOrCtrl+K command palette, CmdOrCtrl+F in-chat find, CmdOrCtrl+Shift+E Agent/IDE toggle
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.shiftKey && (e.key === 'e' || e.key === 'E')) {
        e.preventDefault();
        setWorkbenchMode((m) => (m === 'ide' ? 'agent' : 'ide'));
        return;
      }
      const inMonaco = Boolean(e.target && e.target.closest && e.target.closest('.monaco-editor'));
      if (inMonaco) return;
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setShowPalette((v) => !v); }
      else if (e.key === 'f' || e.key === 'F') {
        if (workbenchMode === 'ide' && e.shiftKey) return;
        e.preventDefault();
        // Shift+F is the cross-conversation search panel; plain F is in-chat find.
        if (e.shiftKey) setPanel((p) => (p === 'search' ? 'chats' : 'search'));
        else setShowFind((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [workbenchMode]);

  // subscribe to events
  const openPreview = useCallback((url) => {
    if (!url) return;
    // Object identity (not the bare string) so previewing the same file again —
    // after an edit — still triggers a reload in the pane.
    setPreviewUrl({ url, at: Date.now() });
    setSessionPane((p) => (p.type === 'browser' ? p : { ...p, type: 'browser', width: p.width || 520 }));
  }, []);

  useEffect(() => {
    const off = window.autobot.onEvent((evt) => {
      // A run emits `done` (stream finished) and then `complete` (run promise
      // settled). Those late events used to land after the NEXT run had already
      // started and clobber it — drop anything still tagged with an older run.
      if (evt.runId && runIdRef.current && evt.runId !== runIdRef.current
        && /^(delta|thinking|tool|toolStream|toolResult|done|complete|cancelled|error|notice|limit|retry|usage|subagent|swarm|paused)$/.test(evt.type)) return;
      // A sub-agent's events belong to ITS row, never to the parent reply. Without
      // this, three concurrent workers interleaved their tokens into one garbled
      // paragraph ("done on cheadone on mid-…"), every worker tool row landed in
      // the parent's tool list, and a child's `done` / `complete` / `error` ended
      // the PARENT's stream (commitLive) mid-run. Anything tagged with a
      // sub-agent is consumed here — except events that need the user (question,
      // permission, consent, plan) or surface UI (artifact, preview, nested
      // subagent/swarm rows), which still flow to the shared handlers below.
      const subTag = evt.subagent != null ? String(evt.subagent) : (evt.agentId != null ? String(evt.agentId) : '');
      if (subTag && evt.type === 'checkpoint') {
        const cp = { id: evt.id || 'turn', path: evt.path || '', existed: !!evt.existed, at: evt.at || Date.now() };
        setLiveSync((l) => (l ? { ...l, checkpointId: cp.id, checkpoints: [...(l.checkpoints || []), cp] } : l));
        return;
      }
      if (subTag && !/^(question|plan|permission|computerUseConsent|permissionMode|planMode|artifact|preview|subagent|swarm|cwd|deeplink|compliance)$/.test(evt.type)) {
        const agentKey = evt.agentId != null ? String(evt.agentId) : '';
        const normHandle = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
        setSubAgents((prev) => prev.map((a) => {
          const hit = a.key === subTag || a.name === subTag || (agentKey && a.key === agentKey) || (a.handle && a.handle === normHandle(subTag));
          if (!hit) return a;
          const p = a.progress || { chars: 0, tools: 0, last: '', log: [] };
          switch (evt.type) {
            case 'delta': {
              const chars = p.chars + String(evt.text || '').length;
              return { ...a, progress: { ...p, chars, last: (p.last + String(evt.text || '')).slice(-500) } };
            }
            case 'thinking': return { ...a, progress: { ...p, think: (p.think || 0) + String(evt.text || '').length } };
            case 'tool': {
              const args = evt.args || {};
              const shortArg = String(args.path || args.file_path || args.command || args.pattern || args.query || args.text || '').replace(/\s+/g, ' ').slice(0, 80);
              const entry = { kind: 'tool', id: evt.id || '', name: evt.name, arg: shortArg, at: Date.now() };
              const log = [...(p.log || []), entry].slice(-20);
              return { ...a, progress: { ...p, tools: p.tools + 1, currentTool: { name: evt.name, arg: shortArg }, log, last: p.last || ('using ' + evt.name) } };
            }
            case 'toolResult': {
              const log = (p.log || []).slice();
              for (let j = log.length - 1; j >= 0; j--) {
                if ((evt.id && log[j].id === evt.id) || log[j].name === evt.name) {
                  log[j] = { ...log[j], done: true, isError: !!evt.isError };
                  break;
                }
              }
              return { ...a, progress: { ...p, log } };
            }
            case 'orchestrator':
              return {
                ...a,
                model: evt.to || a.model,
                failover: { from: evt.from, to: evt.to, reason: evt.reason, count: ((a.failover && a.failover.count) || 0) + 1 },
              };
            case 'retry': return { ...a, progress: { ...p, retried: (p.retried || 0) + 1 } };
            case 'notice': return { ...a, progress: { ...p, notice: String(evt.text || '') } };
            case 'error': return { ...a, status: 'error', progress: { ...p, last: String(evt.message || 'error').slice(-400) } };
            // done / complete / cancelled / usage / limit: lifecycle `subagent` owns status.
            default: return a;
          }
        }));
        return;
      }
      switch (evt.type) {
        case 'retry':
          // The turn was cut at the token limit and is being re-generated. Drop
          // the truncated attempt so the transcript shows one clean answer, the
          // way Example replaces a cut-off message instead of stacking a second.
          setLiveSync((l) => {
            if (!l) return l;
            const segments = (l.segments || []).slice();
            let text = Number(evt.chars) || 0;
            let think = Number(evt.thinkingChars) || 0;
            for (let i = segments.length - 1; i >= 0 && (text > 0 || think > 0); i--) {
              const seg = segments[i];
              if (seg.type === 'text' && text > 0) {
                const drop = Math.min(text, seg.text.length);
                text -= drop;
                segments[i] = { ...seg, text: seg.text.slice(0, seg.text.length - drop) };
              } else if (seg.type === 'thinking' && think > 0) {
                const drop = Math.min(think, seg.text.length);
                think -= drop;
                segments[i] = { ...seg, text: seg.text.slice(0, seg.text.length - drop) };
              }
            }
            const kept = segments.filter((s) => s.type === 'tools' || (s.text && s.text.trim()));
            const content = kept.filter((s) => s.type === 'text').map((s) => s.text).join('');
            return { ...l, content, segments: kept };
          });
          break;
        case 'delta':
          setThinking('');
          // Each agent step is its own text block. Appending every step into one
          // string glued sentences together ("…planning.Empty project.") and stacked
          // every tool row above the whole reply, so a long run read as one wall of
          // text. Keep an ordered segment list instead: text, tools, text, tools…
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            if (last && last.type === 'text') segments[segments.length - 1] = { type: 'text', text: last.text + evt.text };
            else segments.push({ type: 'text', text: evt.text });
            return { ...base, content: base.content + evt.text, segments, streamingTool: null };
          });
          break;
        case 'thinking':
          // Example shows reasoning inline in the transcript ("Thought for 4s"),
          // not just in the status line. Keep it as an ordered segment so the
          // record reads: thinking → text → tools → text, in the real order.
          setThinking((t) => t + evt.text);
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            const GROW = 12000; // reasoning models can stream huge traces; keep a tail
            if (last && last.type === 'thinking') {
              const merged = last.text + evt.text;
              segments[segments.length - 1] = { type: 'thinking', text: merged.length > GROW ? merged.slice(-GROW) : merged };
            } else {
              segments.push({ type: 'thinking', text: evt.text });
            }
            return { ...base, segments };
          });
          break;
        case 'toolStream': {
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const prev = base.streamingTool;
            const startedAt = (prev && prev.name === evt.name && (!evt.id || prev.id === evt.id)) ? prev.startedAt : Date.now();
            const tools = Array.isArray(base.tools) && evt.id
              ? base.tools.map((t) => (t.id === evt.id && t.status === 'running'
                ? { ...t, liveBytes: Number(evt.bytes) || 0, liveLines: Number(evt.lines) || 0, livePreview: evt.preview || t.livePreview || '' }
                : t))
              : (base.tools || []);
            return {
              ...base,
              tools,
              streamingTool: {
                id: evt.id || '',
                name: evt.name || '',
                bytes: Number(evt.bytes) || 0,
                lines: Number(evt.lines) || 0,
                target: evt.target || '',
                preview: evt.preview || '',
                phase: evt.phase || 'args',
                startedAt,
                at: Date.now(),
              },
            };
          });
          break;
        }
        case 'tool': {
          // A provider that omits the call id must not collapse every such row
          // onto `undefined` (one shared key, results landing on the wrong row).
          const tid = evt.id || uid();
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            if (last && last.type === 'tools') segments[segments.length - 1] = { type: 'tools', ids: [...last.ids, tid] };
            else segments.push({ type: 'tools', ids: [tid] });
            const st = base.streamingTool;
            const seededBytes = (st && (st.id === tid || st.name === evt.name)) ? st.bytes : 0;
            const seededLines = (st && (st.id === tid || st.name === evt.name)) ? st.lines : 0;
            return {
              ...base,
              streamingTool: null,
              tools: [...(base.tools || []), { id: tid, name: evt.name, args: evt.args, result: null, status: 'running', startedAt: Date.now(), liveBytes: seededBytes, liveLines: seededLines }],
              segments,
            };
          });
          break;
        }
        case 'paused':
          setPaused(!!evt.paused);
          break;
        case 'toolResult':
          setLiveSync((l) => {
            if (!l) return l;
            return { ...l, tools: l.tools.map((t) => (t.id === evt.id ? { ...t, result: evt.result, status: evt.isError ? 'error' : 'done' } : t)) };
          });
          break;
        case 'done':
        case 'complete': {
          setPaused(false);
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          if (evt && evt.usage) setLastUsage({ ...evt.usage, model: evt.usage.model || (evt.usage && evt.usage.model) || null, at: Date.now() });
          const snapTools = (liveRef.current && liveRef.current.tools) || [];
          const snapCps = (liveRef.current && liveRef.current.checkpoints) || [];
          const elapsedSec = runStartedAtRef.current ? Math.max(1, Math.round((Date.now() - runStartedAtRef.current) / 1000)) : 0;
          const touched = summarizeChangedFiles(snapTools, snapCps).files.length;
          const summaryBits = [
            elapsedSec ? `Finished in ${elapsedSec}s` : 'Agent finished working in your workspace',
            touched > 0 ? `${touched} file${touched === 1 ? '' : 's'} updated` : '',
          ].filter(Boolean);
          commitLive();
          sendDesktopNotification('agent', 'Akron Code', summaryBits.join(' · ') + '.', settings, { convId: evt.convId || runConvRef.current || activeIdRef.current || null });
          break;
        }
        case 'cancelled':
          setPaused(false);
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          // Stopping keeps whatever the model had already produced.
          commitLive();
          break;
        case 'error':
          setPaused(false);
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => evt.runId && p.runId && p.runId !== evt.runId));
          // Preserve anything already streamed, then show the failure.
          commitLive();
          setError(cleanErr(evt.message));
          sendDesktopNotification('errors', 'Akron Code · Error', cleanErr(evt.message), settings, { convId: evt.convId || runConvRef.current || activeIdRef.current || null });
          // A dead credential is fixed by signing in, not by retrying — open the
          // model menu so the button that resolves it is one click away.
          if (evt.needsSignIn) setModelMenuOpen(true);
          break;
        case 'question':
          setQuestion({ id: evt.id, type: 'question', text: evt.question, options: evt.options || [] });
          sendDesktopNotification('questions', 'Akron Code needs input', evt.question, settings, { convId: evt.convId || runConvRef.current || activeIdRef.current || null });
          break;
        case 'plan':
          setQuestion({ id: evt.id, type: 'plan', text: evt.plan, options: [] });
          sendDesktopNotification('questions', 'Akron Code · Plan approval', 'Review proposed execution plan.', settings, { convId: evt.convId || runConvRef.current || activeIdRef.current || null });
          break;
        case 'permission': {
          const item = {
            id: evt.id,
            runId: evt.runId || runIdRef.current || null,
            convId: evt.convId || runConvRef.current || activeIdRef.current || null,
            tool: evt.tool,
            args: evt.args || {},
            summary: evt.summary || '',
            suggestedRule: evt.suggestedRule || null,
          };
          setPermError('');
          setPermissionQueue((q) => (q.some((x) => x.id === item.id) ? q : [...q, item]));
          sendDesktopNotification('permissions', 'Permission required', `${evt.tool}: ${evt.summary || 'approval needed'}`, settings, { convId: item.convId });
          break;
        }
        case 'permissionCleared':
          setPermError('');
          setPermissionQueue((q) => q.filter((p) => {
            if (evt.id) return p.id !== evt.id;
            if (evt.runId) return p.runId !== evt.runId;
            return false;
          }));
          break;
        case 'notificationClick':
          setShowSettings(false);
          setPanel('chats');
          if (evt.convId) setActiveId(evt.convId);
          break;
        case 'computerUseConsent':
          // Desktop's `computer:request_access` / `request_full_control` /
          // `request_teach_access`. The turn is blocked until the user answers.
          setCuConsent({ id: evt.id, tier: evt.tier || 'access', tool: evt.tool || '', sensitive: !!evt.sensitive });
          sendDesktopNotification('permissions', 'Computer Use approval needed', `Allow ${evt.tier || 'access'} for ${evt.tool || 'desktop action'}?`, settings, { convId: runConvRef.current || activeIdRef.current || null });
          break;
        case 'permissionMode':
          // Plan mode (or any mode change) requested by the agent itself, e.g.
          // EnterPlanMode / ExitPlanMode approval. Keep the pill in sync.
          if (evt.mode) setPermissions(evt.mode);
          break;
        case 'planMode':
          setPlanMode(evt.active ? { active: true, file: evt.file || 'PLAN.md' } : null);
          break;
        case 'orchestrator':
          setLiveSync((l) => (l ? { ...l, failover: { from: evt.from, to: evt.to, reason: evt.reason }, model: evt.to || l.model } : l));
          break;
        case 'model':
          setLiveSync((l) => {
            if (!l) return l;
            return {
              ...l,
              model: evt.model || l.model || '',
              modelsUsed: Array.isArray(evt.modelsUsed) && evt.modelsUsed.length ? evt.modelsUsed : l.modelsUsed,
            };
          });
          break;
        case 'checkpoint': {
          const cp = { id: evt.id || 'turn', path: evt.path || '', existed: !!evt.existed, at: evt.at || Date.now() };
          setLiveSync((l) => {
            const base = l || { content: '', tools: [], segments: [], checkpoints: [] };
            return { ...base, checkpointId: cp.id, checkpoints: [...(base.checkpoints || []), cp] };
          });
          break;
        }
        case 'subagent': {
          const key = String(evt.id || evt.name || 'agent');
          const status = evt.status === 'started' || evt.status === 'running' ? 'running'
            : evt.status === 'queued' ? 'queued'
              : evt.status === 'waiting' ? 'waiting'
                : evt.status === 'error' ? 'error'
                  : evt.status === 'killed' ? 'killed'
                    : evt.status === 'stopped' ? 'stopped' : 'done';
          const handle = String(evt.name || evt.id || 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
          setSubAgents((prev) => {
            const next = [...prev];
            const i = next.findIndex((a) => a.key === key);
            const cur = i >= 0 ? next[i] : null;
            const row = {
              key,
              handle: (cur && cur.handle) || handle,
              name: evt.name || (cur ? cur.name : key),
              status,
              role: evt.role || (cur ? cur.role : null),
              jobRole: evt.jobRole || (cur ? cur.jobRole : null),
              model: evt.model || (cur ? cur.model : null),
              tier: evt.tier || (cur ? cur.tier : null),
              round: evt.round || (cur ? cur.round : 1),
              ms: evt.ms != null ? evt.ms : (cur ? cur.ms : null),
              startedAt: (cur && cur.startedAt) || Date.now(),
              failover: cur ? cur.failover : null,
              posts: cur ? cur.posts || 0 : 0,
              progress: cur ? cur.progress : undefined,
            };
            if (i >= 0) next[i] = row; else next.push(row);
            return next;
          });
          break;
        }
        case 'swarm': {
          if (evt.phase === 'start') {
            setSwarmInfo({ supervisor: evt.supervisor, roster: evt.roster || [], pools: !!evt.pools, phase: 'planning', wave: 0, startedAt: Date.now() });
            setSwarmBoard([]);
          } else if (evt.phase === 'planned') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'dispatch', taskCount: (evt.tasks || []).length }));
            setSubAgents((prev) => {
              const byKey = new Map(prev.map((a) => [a.key, a]));
              (evt.tasks || []).forEach((t) => {
                const key = String(t.id);
                const cur = byKey.get(key);
                const handle = String(t.title || t.id || 'worker').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
                byKey.set(key, {
                  key,
                  handle: (cur && cur.handle) || handle,
                  name: t.title || t.id,
                  status: cur && cur.status !== 'queued' ? cur.status : 'queued',
                  role: 'worker',
                  jobRole: t.role || (cur && cur.jobRole) || null,
                  model: t.model || (cur && cur.model) || null,
                  tier: t.tier || (cur && cur.tier) || null,
                  round: (cur && cur.round) || 1,
                  ms: cur && cur.ms != null ? cur.ms : null,
                  startedAt: (cur && cur.startedAt) || Date.now(),
                  failover: cur ? cur.failover : null,
                  posts: (cur && cur.posts) || 0,
                  progress: cur ? cur.progress : undefined,
                });
              });
              return [...byKey.values()];
            });
          } else if (evt.phase === 'board' && evt.msg) {
            setSwarmBoard((prev) => {
              if (prev.some((m) => m.seq === evt.msg.seq)) return prev;
              return [...prev, evt.msg].slice(-200);
            });
          } else if (evt.phase === 'member' && evt.member) {
            const mem = evt.member;
            if (mem.name === 'supervisor') {
              setSwarmInfo((w) => ({
                ...(w || {}),
                supervisorState: mem.state,
                phase: mem.state === 'reviewing' ? 'review' : (w && w.phase),
              }));
            } else {
              setSubAgents((prev) => {
                const next = [...prev];
                const idx = next.findIndex((a) => a.handle === mem.name || a.key === mem.name || a.name === mem.name);
                const mapped = mem.state === 'working' ? 'running'
                  : mem.state === 'pending' ? 'queued'
                    : (mem.state === 'waiting' || mem.state === 'done' || mem.state === 'error' || mem.state === 'stopped' || mem.state === 'killed') ? mem.state
                      : null;
                if (idx >= 0) {
                  const cur = next[idx];
                  next[idx] = {
                    ...cur,
                    status: mapped || cur.status,
                    posts: mem.posts != null ? mem.posts : cur.posts,
                    model: mem.model || cur.model,
                  };
                } else {
                  next.push({
                    key: mem.name,
                    handle: mem.name,
                    name: mem.name,
                    status: mapped || 'queued',
                    role: mem.role || 'worker',
                    jobRole: mem.jobRole || null,
                    model: mem.model || null,
                    tier: mem.tier || null,
                    posts: mem.posts || 0,
                    startedAt: Date.now(),
                  });
                }
                return next;
              });
            }
          } else if (evt.phase === 'monitor') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'wakeup', wave: evt.wave || ((w && w.wave) || 0) + 1 }));
            const who = [...(evt.stalled || []), ...(evt.addressed || [])].filter((v, i, a) => a.indexOf(v) === i);
            if (who.length) setNotice(`Team monitor: re-briefing ${who.join(', ')} (${evt.stalled && evt.stalled.length ? 'no board report' : 'addressed on the board'}).`);
          } else if (evt.phase === 'dispatched') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'review' }));
          } else if (evt.phase === 'done') {
            setSwarmInfo((w) => ({ ...(w || {}), phase: 'done', ms: evt.ms }));
          }
          break;
        }
        case 'artifact':
          setArtifactsExplicit((a) => [...a.filter((x) => x.name !== evt.name), { name: evt.name, language: evt.language, content: evt.content, path: evt.path }]);
          setNotice(`Artifact created: ${evt.name || evt.language || 'code'} (view in Artifacts panel)`);
          if (evt.path && /\.(html?|svg)$/i.test(evt.name || evt.path)) openPreview(evt.path);
          break;
        case 'preview':
          if (evt.url) openPreview(evt.url);
          break;
        case 'cwd':
          // The backend resolved the conversation's real project folder. Show it,
          // so the bar and the pane can never point at different directories.
          if (evt.dir) setCwd(evt.dir);
          break;
        case 'userMessage':
          setNotice(String(evt.text || ''));
          break;
        case 'goal':
          setGoal(String(evt.goal || ''));
          setNotice('Goal: ' + evt.goal);
          break;
        case 'usage':
          if (evt.usage) setLastUsage({ ...evt.usage, model: evt.model || (evt.usage && evt.usage.model) || null, at: Date.now() });
          if (evt.model) {
            setLiveSync((l) => (l ? { ...l, model: evt.model || l.model } : l));
          }
          break;
        case 'notice':
          // Context compaction and other system-level messages from the agent.
          setNotice(String(evt.text || ''));
          break;
        case 'limit':
          setNotice(`Paused after ${evt.steps} tool turns — the runaway safety valve, not a step limit. Say "continue" to carry on.`);
          break;
        case 'compliance':
          // Settings changed in another window (or via IPC) — re-render gates.
          if (evt.state) {
            setCompliance((prev) => ({ ...(prev || { profile: null, catalog: [] }), state: evt.state }));
          }
          break;
        case 'deeplink': {
          // Desktop's launcher.js routes claude:// links to app surfaces. We map
          // the equivalent helio:// forms: new chat, a specific conversation,
          // settings, search, and a prefilled prompt (`helio://ask?q=…`).
          // Unknown routes are ignored rather than erroring.
          const raw = String(evt.url || '');
          let u = null;
          try { u = new URL(raw); } catch (_) { u = null; }
          if (!u) break;
          const parts = u.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
          const route = (u.hostname || parts.shift() || '').toLowerCase();
          const rest = parts[0] ? decodeURIComponent(parts[0]) : '';
          if (route === 'new' || route === 'chat') {
            if (rest) selectConv(rest); else newChat();
          } else if (route === 'search') {
            setPanel('search');
          } else if (route === 'settings') {
            setShowSettings(true);
          } else if (route === 'ask') {
            newChat();
            const q = u.searchParams.get('q') || u.searchParams.get('prompt') || '';
            if (q) setNotice(`Prompt loaded — press Enter to send: ${q}`);
            setTimeout(() => { const el = inputRef.current; if (el) { el.value = q; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); } }, 60);
          }
          break;
        }
        default:
          break;
      }
    });
    return off;
  }, []);

  useEffect(() => {
    // A pending jump-to-message (from global search) wins over auto-scroll.
    if (pendingScroll) return;
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, live, thinking, pendingScroll]);

  // Global search → jump: scroll the matched message into view and flash it.
  useEffect(() => {
    if (!pendingScroll) return;
    const el = document.getElementById('msg-' + pendingScroll);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('msg-flash');
    const t = setTimeout(() => el.classList.remove('msg-flash'), 1600);
    setPendingScroll(null);
    return () => clearTimeout(t);
  }, [pendingScroll, activeId]);

  // Which conversation the in-flight run belongs to (survives chat switching).
  const runConvRef = useRef(null);
  const runActiveRef = useRef(false);
  // The conversation the current team (sub-agents / swarm) belongs to. The
  // rows are global state, so without this they painted into every chat.
  const teamConvRef = useRef(null);
  const subAgentsRef = useRef(subAgents);
  subAgentsRef.current = subAgents;
  const swarmInfoRef = useRef(swarmInfo);
  swarmInfoRef.current = swarmInfo;
  const swarmBoardRef = useRef(swarmBoard);
  swarmBoardRef.current = swarmBoard;
  const runStartedAtRef = useRef(0);
  runStartedAtRef.current = runStartedAt;
  const commitLive = useCallback(() => {
    // A run emits BOTH `done` (stream ended) and `complete` (run promise settled).
    // Ignore the duplicate — otherwise it would swallow the next run's stream.
    if (!runActiveRef.current) return;
    runActiveRef.current = false;
    // Resolve the owning conversation NOW: the setLive updater below runs in the
    // render phase, long after runConvRef has been cleared.
    const target = runConvRef.current || activeIdRef.current;
    runConvRef.current = null;
    setStreaming(false);
    setPaused(false);
    setScrolledAway(false);
    setThinking('');
    setPermError('');
    setPermissionQueue((q) => q.filter((p) => {
      if (runIdRef.current && p.runId && p.runId !== runIdRef.current) return true;
      return false;
    }));
    const startedAt = runStartedAtRef.current;
    // Read the stream from the ref and issue two independent state updates.
    // Calling setConvs inside a setLive updater double-appended under StrictMode.
    const l = liveRef.current;
    setLiveSync(null);
    const hasTeam = teamConvRef.current === target && subAgentsRef.current && subAgentsRef.current.length > 0;
    if (l && (l.content || (l.tools && l.tools.length) || (l.checkpoints && l.checkpoints.length) || hasTeam)) {
      // Bind the reply to the conversation the run was started from — the user
      // may have switched chats while it streamed.
      const msg = {
        id: uid(),
        role: 'assistant',
        content: l.content || '',
        tools: l.tools || [],
        segments: l.segments,
        checkpoints: l.checkpoints || [],
        checkpointId: l.checkpointId || null,
        model: l.model || '',
        modelsUsed: Array.isArray(l.modelsUsed) && l.modelsUsed.length ? l.modelsUsed : undefined,
        subAgents: hasTeam ? subAgentsRef.current : undefined,
        swarmInfo: teamConvRef.current === target && swarmInfoRef.current ? swarmInfoRef.current : undefined,
        ts: Date.now(),
        durationMs: startedAt ? Date.now() - startedAt : 0,
      };
      setConvs((cs) => cs.map((c) => (c.id === target ? {
        ...c,
        messages: [...c.messages, msg],
        ...(hasTeam ? {
          subAgents: subAgentsRef.current,
          swarmInfo: swarmInfoRef.current,
          swarmBoard: swarmBoardRef.current,
        } : {}),
      } : c)));
    }
  }, [setLiveSync]);

  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const convsRef = useRef(convs);
  convsRef.current = convs;

  const send = useCallback(async (textOverride, attsOverride, convOverride) => {
    // Guard: React event handlers may pass the event object when the handler is
    // wired as `onClick={send}`. Only accept an explicit string override.
    const override = typeof textOverride === 'string' ? textOverride : undefined;
    const text = (override !== undefined ? override : (inputRef.current?.value || '')).trim();
    const atts = Array.isArray(attsOverride) ? attsOverride : attachments;
    if (!text && atts.length === 0) return;
    if (streamingRef.current && pausedRef.current && text && runIdRef.current && window.autobot && window.autobot.resume) {
      if (override === undefined && inputRef.current) inputRef.current.value = '';
      await window.autobot.resume(runIdRef.current, text);
      return;
    }
    // Example parity: a message sent while a reply is streaming is not dropped —
    // it is queued and dispatched the moment the current turn finishes.
    if (streamingRef.current) {
      if (override === undefined) inputRef.current.value = '';
      if (!Array.isArray(attsOverride)) setAttachments([]);
      setQueued((q) => [...q, { id: uid(), text, atts, convId: activeId, paused: false }]);
      return;
    }
    if (override === undefined) inputRef.current.value = '';
    setError('');

    let convId = (typeof convOverride === 'string' && convOverride) ? convOverride : activeId;
    const autoTitle = text.slice(0, 48) || atts.map((a) => a.name).join(', ').slice(0, 48);
    const isNewConv = !convId;
    if (isNewConv) convId = uid();

    // Resolve the project folder for the conversation we are about to run in.
    // The run must never inherit `cwd` state from a different conversation: that
    // is how a generated site landed in a stale `untitled-*` folder while the
    // preview pane and the cwd bar pointed at the titled folder.
    let runCwd = cwd;
    if (isNewConv || convId !== activeId || !runCwd) {
      const existingTitle = convsRef.current.find((c) => c.id === convId)?.title || '';
      runCwd = await window.autobot.getWorkspace(convId)
        || await window.autobot.getDefaultCwd(convId, existingTitle || autoTitle);
      if (runCwd) { saveJSON('autobot:workspace:' + convId, runCwd); setCwd(runCwd); }
    }

    if (isNewConv) {
      setActiveId(convId);
      setConvs((cs) => [{ id: convId, title: autoTitle, messages: [], ts: Date.now() }, ...cs]);
    } else {
      setConvs((cs) => cs.map((c) => (c.id === convId && c.messages.length === 0 ? { ...c, title: autoTitle } : c)));
    }

    const userMsg = {
      id: uid(),
      role: 'user',
      content: text || (atts.length ? '📎 ' + atts.map((a) => a.name).join(', ') : ''),
      attachments: atts.map((a) => ({ name: a.name, size: a.size, isText: a.isText, content: a.content, isImage: a.isImage, dataUrl: a.dataUrl })),
      ts: Date.now(),
    };
    const currentMessages = convId ? (convsRef.current.find((c) => c.id === convId)?.messages || []) : [];
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: [...c.messages, userMsg] } : c)));

    const payloadMessages = buildPayloadMessages([...currentMessages, userMsg]);
    const directives = buildDirectives(styleId, provider.reasoningLevel, { webSearch, project: activeProject, harnessProfile: settings.harnessProfile });
    if (workbenchMode === 'ide' && editorContextXmlRef.current) {
      directives.push(editorContextXmlRef.current);
    }
    if (directives.length) payloadMessages.unshift({ role: 'system', content: directives.join('\n') });

    // Only consume the composer's attachment tray when this send came from the
    // composer — a queued message carries its own snapshot.
    if (!Array.isArray(attsOverride)) setAttachments([]);

    // Pin the run to its conversation before any event can arrive.
    runConvRef.current = convId;
    runActiveRef.current = true;
    teamConvRef.current = convId;
    const effKey = provider.apiKey || resolveLoopbackKey(provider.baseURL, providerKeys, provider);
    const effProvider = effKey && !provider.apiKey ? { ...provider, apiKey: effKey } : provider;
    setPaused(false);
    setStreaming(true);
    setRunStartedAt(Date.now());
    setThinking('');
    setLiveSync({ content: '', tools: [], model: effProvider.model || provider.model || '' });
    setSubAgents([]);
    setSwarmInfo(null);
    setSwarmBoard([]);
    const runId = uid();
    runIdRef.current = runId;

    const started = await window.autobot.run({
      runId,
      messages: payloadMessages,
      provider: effProvider,
      cwd: runCwd || undefined,
      useMemory: settings.useMemory,
      orchestrator,
      permissions,
      convId,
      title: convsRef.current.find((c) => c.id === convId)?.title || autoTitle,
      // Gate for the Swarm tool: off by default, on only when the user opts in.
      swarm: swarmEnabled,
    });
    // Backstop: the handler emits a proper `error` event, but if that delivery
    // is ever lost the composer must not stay spinning forever.
    if (started && started.ok === false && runActiveRef.current) {
      runActiveRef.current = false;
      runConvRef.current = null;
      setStreaming(false);
      setThinking('');
      setLiveSync(null);
      setError(cleanErr(started.error || 'The provider rejected this run.'));
      if (started.needsSignIn) setModelMenuOpen(true);
    }
  }, [activeId, convs, provider, cwd, settings.useMemory, settings.harnessProfile, streaming, orchestrator, attachments, styleId, webSearch, activeProject, permissions, swarmEnabled]);

  const stop = useCallback(() => {
    setPaused(false);
    if (runIdRef.current) window.autobot.cancel(runIdRef.current);
  }, []);

  const pauseRun = useCallback(() => {
    if (runIdRef.current && window.autobot && window.autobot.pause) {
      setPaused(true);
      window.autobot.pause(runIdRef.current);
    }
  }, []);

  const resumeRun = useCallback((note = '') => {
    if (runIdRef.current && window.autobot && window.autobot.resume) {
      setPaused(false);
      window.autobot.resume(runIdRef.current, note);
    }
  }, []);

  // Auto-dispatch the first unpaused queued message once idle and its conversation queue isn't paused.
  useEffect(() => {
    if (streaming || !queued.length) return;
    const { next, rest } = pickNextRunnableQueued(queued, queuePausedByConv);
    if (!next) return;
    setQueued(rest);
    send(next.text, next.atts, next.convId);
  }, [streaming, queued, queuePausedByConv, send]);

  const unqueue = useCallback((id) => setQueued((q) => q.filter((x) => x.id !== id)), []);
  const clearQueuedForConv = useCallback((convId) => {
    if (!convId) return;
    setQueued((q) => q.filter((x) => x.convId !== convId));
    setQueuePausedByConv((m) => ({ ...m, [convId]: false }));
  }, []);
  const toggleQueuePaused = useCallback((convId) => {
    if (!convId) return;
    setQueuePausedByConv((m) => ({ ...m, [convId]: !m[convId] }));
  }, []);
  const toggleQueueItemPaused = useCallback((id) => {
    setQueued((q) => q.map((x) => (x.id === id ? { ...x, paused: !x.paused } : x)));
  }, []);
  const reorderQueued = useCallback((fromId, toId) => {
    setQueued((q) => moveQueueItem(q, fromId, toId));
  }, []);
  const stepQueued = useCallback((id, delta) => {
    setQueued((q) => stepQueueItemWithinConv(q, id, delta));
  }, []);
  const updateQueuedText = useCallback((id, text) => {
    setQueued((q) => q.map((x) => (x.id === id ? { ...x, text } : x)));
  }, []);
  // Dispatch a specific queued item immediately: if idle, send now; if streaming, move it to front and cancel live run.
  const sendQueuedNow = useCallback((id) => {
    const target = id ? queued.find((x) => x.id === id) : queued[0];
    if (!target) return;
    if (!streamingRef.current) {
      setQueued((q) => q.filter((x) => x.id !== target.id));
      send(target.text, target.atts, target.convId);
      return;
    }
    if (target.convId) {
      setQueuePausedByConv((m) => ({ ...m, [target.convId]: false }));
    }
    setQueued((q) => {
      const unpaused = { ...target, paused: false };
      return [unpaused, ...q.filter((x) => x.id !== target.id)];
    });
    if (runIdRef.current) window.autobot.cancel(runIdRef.current);
  }, [queued, send]);

  // Quick Entry (menu-bar / global-hotkey) → insert or send into the composer.
  useEffect(() => {
    const off = window.autobot.onQuickEntry(({ text, mode }) => {
      if (mode === 'send') {
        send(text);
      } else {
        if (inputRef.current) {
          inputRef.current.value = text;
          inputRef.current.dispatchEvent(new Event('input', { bubbles: true }));
          inputRef.current.focus();
        }
      }
    });
    return off;
  }, [send]);

  // Full-duplex conversational Voice Mode: continuous speech → transcript → send →
  // assistant reply spoken via TTS → keep listening until toggled off.
  const startVoiceMode = useCallback(() => {
    const SR = (window.SpeechRecognition || window.webkitSpeechRecognition);
    if (!SR) { if (window.autobot?.speak) window.autobot.speak('Speech recognition is not available in this environment.'); return; }
    if (voiceActiveRef.current) return;
    const rec = new SR();
    rec.lang = 'en-US';
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      const transcript = Array.from(e.results).map((r) => r[0].transcript).join(' ').trim();
      if (transcript && voiceActiveRef.current && !streamingRef.current) send(transcript);
    };
    rec.onerror = () => { /* non-fatal: restart loop on end */ };
    rec.onend = () => {
      // Some platforms auto-stop after a silence gap; restart while session is live.
      if (voiceActiveRef.current) { try { rec.start(); } catch (_) {} }
    };
    voiceRecRef.current = rec;
    voiceActiveRef.current = true;
    setVoiceMode(true);
    try { rec.start(); } catch (_) {}
  }, [send]);

  const stopVoiceMode = useCallback(() => {
    voiceActiveRef.current = false;
    setVoiceMode(false);
    if (voiceRecRef.current) { try { voiceRecRef.current.stop(); } catch (_) {} voiceRecRef.current = null; }
    if (window.autobot?.stopSpeak) window.autobot.stopSpeak();
  }, []);

  // Speak assistant replies aloud while a voice session is live.
  useEffect(() => {
    if (!voiceMode || streaming) return;
    const last = [...messages].reverse().find((m) => m.role === 'assistant');
    if (last && last.content && !spokenIdsRef.current.has(last.id)) {
      spokenIdsRef.current.add(last.id);
      const clean = last.content
        .replace(/```[\s\S]*?```/g, ' code block ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[#*_`>~|]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (clean) window.autobot.speak(clean.slice(0, 2000));
    }
  }, [messages, streaming, voiceMode]);

  const answerQuestion = useCallback(async (ans) => {
    if (!question) return;
    const id = question.id;
    setQuestion(null);
    await window.autobot.answerQuestion(id, ans);
  }, [question]);

  const answerPermission = useCallback(async (id, payload) => {
    if (!id) return;
    setPermSubmitting(true);
    setPermError('');
    try {
      const res = await window.autobot.answerPermission(id, payload);
      if (res && res.ok) {
        setPermissionQueue((q) => q.filter((x) => x.id !== id));
      } else {
        const msg = (res && res.error) || 'Failed to deliver permission response.';
        setPermError(msg);
        setError(msg);
        if (/not found|closed|timed out/i.test(msg)) {
          setPermissionQueue((q) => q.filter((x) => x.id !== id));
        }
      }
    } catch (err) {
      const msg = (err && err.message) || 'Permission response failed.';
      setPermError(msg);
      setError(msg);
    } finally {
      setPermSubmitting(false);
    }
  }, [setError]);

  // Computer Use consent: allow grants the requested tier (which resolves the
  // blocked turn in the main process), deny revokes so the tool call fails fast.
  const answerCuConsent = useCallback(async (allow, remember = false) => {
    if (!cuConsent) return;
    const { tier } = cuConsent;
    setCuConsent(null);
    try {
      if (allow) await window.autobot.computerUseGrant(tier, { remember });
      else await window.autobot.computerUseRevoke(tier);
    } catch (_) {}
  }, [cuConsent]);

  // The live stream belongs to one conversation; don't paint it into another one.
  const liveForActive = live && (!runConvRef.current || runConvRef.current === activeId) ? live : null;

  // Starting a new chat must not discard an in-flight run's stream — that run is
  // committed to its own conversation and `liveForActive` keeps it off-screen.
  const newChat = () => { if (!streamingRef.current) setLiveSync(null); setActiveId(null); setError(''); setPanel('chats'); inputRef.current?.focus(); };
  const selectConv = (id) => { setActiveId(id); setPanel('chats'); };
  const deleteConv = async (id) => {
    // Compliance gate first — under an HIPAA / ZDR profile Desktop refuses the
    // delete outright, and under a marked-retention profile it writes an audit
    // record first. Ask the main process before touching local state.
    if (window.autobot && window.autobot.complianceDeleteCheck) {
      const conv = convsRef.current.find((c) => c.id === id);
      let gate = null;
      try {
        gate = await window.autobot.complianceDeleteCheck({ id, title: conv ? conv.title : '' });
      } catch (_) { gate = null; }
      if (gate && gate.allowed === false) {
        setError(gate.line || 'This session can’t be deleted under your organization’s configuration.');
        return;
      }
    }
    setConvs((cs) => cs.filter((c) => c.id !== id));
    setOpenTabIds((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (activeId === id) setActiveId(next.length ? next[next.length - 1] : null);
      return next;
    });
  };
  const closeWorkspaceTab = (id, e) => {
    if (e) e.stopPropagation();
    setOpenTabIds((tabs) => {
      const next = tabs.filter((t) => t !== id);
      if (activeId === id) setActiveId(next.length ? next[next.length - 1] : null);
      return next;
    });
  };
  const renameConv = (id, title) => {
    const clean = String(title || '').trim();
    if (!clean) return;
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, title: clean } : c)));
  };
  const pinConv = (id) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, pinned: !c.pinned } : c)));
  };
  const archiveConv = (id) => {
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, archived: !c.archived } : c)));
    setError('✅ Conversation archive state toggled.');
  };
  const splitConv = (id) => {
    const src = convsRef.current.find((c) => c.id === id);
    if (!src) return;
    const copyId = uid();
    const copy = { ...src, id: copyId, title: (src.title || 'Untitled') + ' (split)', pinned: false, ts: Date.now() };
    setConvs((cs) => [copy, ...cs]);
    setActiveId(copyId);
    setPanel('chats');
  };

  const copyMessage = (m) => { navigator.clipboard?.writeText(m.content || '').catch(() => {}); };

  // Fork the conversation up to response index `idx` into a new branched chat.
  const forkFromMessage = useCallback((convId, idx) => {
    const src = convsRef.current.find((c) => c.id === convId);
    if (!src) return;
    const msgs = Array.isArray(src.messages) ? src.messages : [];
    const sliced = msgs.slice(0, Math.min(msgs.length, idx + 1)).map((msg) => ({ ...msg }));
    const forkId = uid();
    const forkConv = {
      ...src,
      id: forkId,
      title: ((src.title || 'Untitled') + ' (fork)').slice(0, 80),
      pinned: false,
      ts: Date.now(),
      messages: sliced,
      forkedFrom: { convId, idx },
    };
    setConvs((cs) => [forkConv, ...cs]);
    setActiveId(forkId);
    setPanel('chats');
    setNotice('✅ Forked conversation from response.');
  }, []);

  // Share a specific assistant response (plus transcript up to it) via clipboard or HTML/MD/JSON save.
  const shareFromMessage = useCallback(async (convId, idx, format = 'copy') => {
    const src = convsRef.current.find((c) => c.id === convId);
    if (!src) return;
    const msgs = Array.isArray(src.messages) ? src.messages : [];
    const targetMsg = msgs[idx];
    if (format === 'copy') {
      const md = targetMsg ? String(targetMsg.content || '') : '';
      try { await navigator.clipboard?.writeText(md); } catch (_) {}
      setNotice('✅ Copied response Markdown to clipboard.');
      return;
    }
    const slicedConv = { ...src, messages: msgs.slice(0, Math.min(msgs.length, idx + 1)) };
    const slug = (slicedConv.title || 'response').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'response';
    let content = '';
    let defaultName = slug + '.md';
    let filters = [{ name: 'Markdown', extensions: ['md'] }];
    if (format === 'html') {
      content = convToHtml(slicedConv);
      defaultName = slug + '.html';
      filters = [{ name: 'HTML', extensions: ['html'] }];
    } else if (format === 'json') {
      content = JSON.stringify(slicedConv, null, 2);
      defaultName = slug + '.json';
      filters = [{ name: 'JSON', extensions: ['json'] }];
    } else {
      content = convToMarkdown(slicedConv);
    }
    const r = await window.autobot.saveFile({ defaultName, content, filters });
    if (r.ok && r.path) setError('✅ Shared to ' + r.path);
    else if (r.ok && !r.path) setError('');
    else setError('❌ Share failed: ' + (r.error || 'unknown'));
  }, []);

  // Export / share the active conversation (markdown / HTML / JSON) via native save.
  const exportConv = useCallback(async (format) => {
    const conv = convsRef.current.find((c) => c.id === activeIdRef.current) || null;
    if (!conv) { setError('No conversation to export.'); return; }
    const slug = (conv.title || 'conversation').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 48) || 'conversation';
    let content = '';
    let defaultName = slug + '.md';
    let filters = [{ name: 'Markdown', extensions: ['md'] }];
    if (format === 'html') {
      content = convToHtml(conv);
      defaultName = slug + '.html';
      filters = [{ name: 'HTML', extensions: ['html'] }];
    } else if (format === 'json') {
      content = JSON.stringify(conv, null, 2);
      defaultName = slug + '.json';
      filters = [{ name: 'JSON', extensions: ['json'] }];
    } else {
      content = convToMarkdown(conv);
    }
    const r = await window.autobot.saveFile({ defaultName, content, filters });
    if (r.ok && r.path) setError('✅ Exported to ' + r.path);
    else if (r.ok && !r.path) setError('');
    else setError('❌ Export failed: ' + (r.error || 'unknown'));
  }, []);
  const editMessage = (m) => {
    if (inputRef.current) { inputRef.current.value = m.content || ''; inputRef.current.dispatchEvent(new Event('input', { bubbles: true })); inputRef.current.focus(); }
  };
  const deleteMessage = (convId, idx) => {
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: c.messages.filter((_, i) => i !== idx) } : c)));
  };
  const retryMessage = async (convId, idx) => {
    // Retry regenerates in place; it never queues behind a live run.
    if (streamingRef.current || runActiveRef.current) { setNotice('Wait for the current reply to finish before retrying.'); return; }
    const conv = convsRef.current.find((c) => c.id === convId);
    if (!conv) return;
    const msgs = conv.messages;
    let userIdx = idx - 1;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;
    const kept = msgs.slice(0, userIdx + 1);
    setError('');
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: kept } : c)));
    const payloadMessages = buildPayloadMessages(kept);
    const directives = buildDirectives(styleId, provider.reasoningLevel, { webSearch, project: activeProject, harnessProfile: settings.harnessProfile });
    if (directives.length) payloadMessages.unshift({ role: 'system', content: directives.join('\n') });
    // Same project-folder rule as send(): never inherit another chat's cwd.
    let runCwd = cwd;
    if (convId !== activeIdRef.current || !runCwd) {
      runCwd = await window.autobot.getWorkspace(convId)
        || await window.autobot.getDefaultCwd(convId, conv.title || '');
      if (runCwd) { saveJSON('autobot:workspace:' + convId, runCwd); if (convId === activeIdRef.current) setCwd(runCwd); }
    }
    // Pin the run to its conversation before any event can arrive — without
    // this commitLive bailed (runActiveRef false), the composer spun forever
    // and the regenerated reply was dropped.
    runConvRef.current = convId;
    runActiveRef.current = true;
    teamConvRef.current = convId;
    const effKey = provider.apiKey || resolveLoopbackKey(provider.baseURL, providerKeys, provider);
    const effProvider = effKey && !provider.apiKey ? { ...provider, apiKey: effKey } : provider;
    setPaused(false);
    setStreaming(true);
    setRunStartedAt(Date.now());
    setThinking('');
    setLiveSync({ content: '', tools: [], model: effProvider.model || provider.model || '' });
    setSubAgents([]);
    setSwarmInfo(null);
    setSwarmBoard([]);
    const runId = uid();
    runIdRef.current = runId;
    const started = await window.autobot.run({
      runId, messages: payloadMessages, provider: effProvider,
      cwd: runCwd || undefined, useMemory: settings.useMemory, orchestrator, permissions,
      convId, title: conv.title || '',
      swarm: swarmEnabled,
    });
    if (started && started.ok === false && runActiveRef.current) {
      runActiveRef.current = false;
      runConvRef.current = null;
      setStreaming(false);
      setThinking('');
      setLiveSync(null);
      setError(cleanErr(started.error || 'The provider rejected this run.'));
      if (started.needsSignIn) setModelMenuOpen(true);
    }
  };

  const copyBlock = (e) => {
    const btn = e.target.closest('.copy-btn');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    navigator.clipboard?.writeText(code).then(() => {
      btn.textContent = 'Copied!';
      setTimeout(() => (btn.textContent = 'Copy'), 1200);
    });
  };

  // "Apply to file" (Claude Code parity): write a code block into the project
  // folder the block's fence names, resolving relative to the active workspace.
  const applyBlock = async (e) => {
    const btn = e.target.closest('.apply-btn');
    if (!btn) return;
    const code = decodeURIComponent(btn.dataset.code || '');
    const file = btn.dataset.file || '';
    const r = await window.autobot.writeFile({ file, content: code, cwd: cwd || undefined });
    if (r && r.ok) {
      btn.textContent = 'Saved';
      setNotice(`Wrote ${r.path}`);
      setTimeout(() => (btn.textContent = 'Apply'), 1500);
    } else {
      btn.textContent = 'Error';
      setError('Apply failed: ' + ((r && r.error) || 'unknown error'));
      setTimeout(() => (btn.textContent = 'Apply'), 1500);
    }
  };

  const testProvider = async () => {
    setError('');
    const effKey = provider.apiKey || resolveLoopbackKey(provider.baseURL, providerKeys, provider);
    const effProvider = effKey && !provider.apiKey ? { ...provider, apiKey: effKey } : provider;
    const r = await window.autobot.testProvider(effProvider);
    if (r.ok) setError('✅ Provider OK — reply: ' + r.reply);
    else setError('❌ Provider error: ' + r.error);
  };

  const refreshMemory = async () => setMemory((await window.autobot.getMemory()).entries || []);
  const addMemory = async () => {
    const content = prompt('Memory note:');
    if (!content) return;
    await window.autobot.addMemory(content);
    refreshMemory();
  };
  const clearMemory = async () => { await window.autobot.clearMemory(); refreshMemory(); };

  const connectMcp = async () => {
    setError('');
    const transport = mcpForm.transport || 'stdio';
    if (transport === 'stdio' && !mcpForm.command) { setError('MCP command required'); return; }
    if ((transport === 'sse' || transport === 'http') && !mcpForm.url) { setError('MCP URL required'); return; }
    const cfg = transport === 'stdio'
      ? { transport: 'stdio', command: mcpForm.command, args: mcpForm.args ? mcpForm.args.split(/\s+/) : [] }
      : { transport, url: mcpForm.url };
    const r = await window.autobot.mcpConnect(cfg);
    if (r.ok) {
      setMcpServers((s) => [...s, { serverId: r.serverId, name: (transport === 'stdio' ? mcpForm.command : mcpForm.url), tools: r.tools }]);
      setMcpForm({ transport: 'stdio', command: '', args: '', url: '' });
    } else setError('MCP connect failed: ' + r.error);
  };
  const disconnectMcp = async (serverId) => {
    await window.autobot.mcpDisconnect(serverId);
    setMcpServers((s) => s.filter((x) => x.serverId !== serverId));
  };

  // ---- Notebooks ----
  const openNotebook = async (name) => {
    const nb = await window.autobot.getNotebook(name);
    setActiveNotebook(name);
    setNotebookCells(nb.cells || []);
  };
  const newNotebook = () => {
    const name = prompt('Notebook name:');
    if (!name) return;
    setActiveNotebook(name);
    setNotebookCells([]);
    setNotebooks((n) => (n.includes(name) ? n : [...n, name]));
  };
  const saveActiveNotebook = async () => {
    if (!activeNotebook) return;
    await window.autobot.saveNotebook(activeNotebook, notebookCells);
    setNotebooks((n) => (n.includes(activeNotebook) ? n : [...n, activeNotebook]));
    setError('✅ Saved notebook "' + activeNotebook + '"');
  };
  const deleteActiveNotebook = async () => {
    if (!activeNotebook) return;
    await window.autobot.deleteNotebook(activeNotebook);
    setNotebooks((n) => n.filter((x) => x !== activeNotebook));
    setActiveNotebook(null);
    setNotebookCells([]);
  };

  // ---- Terminal ----
  const refreshTerminal = async () => {
    const tabs = await window.autobot.shellList();
    setTerminal((t) => ({ tabs, active: t.active || (tabs[0] ? tabs[0].id : null) }));
  };
  const startTerminal = async () => {
    const t = await window.autobot.shellStart({ cwd: cwd || undefined });
    await refreshTerminal();
    setTerminal((s) => ({ ...s, active: t.id }));
  };
  const runInTerminal = async (command) => {
    const id = terminal.active;
    if (!id) return;
    const r = await window.autobot.shellRun(id, command);
    await refreshTerminal();
    if (!r.ok) setError('Terminal error: ' + r.error);
  };
  const writeTerminal = async (data) => {
    const id = terminal.active;
    if (!id) return;
    await window.autobot.shellWrite(id, data);
    await refreshTerminal();
  };
  const killTerminal = async (id) => {
    await window.autobot.shellKill(id);
    await refreshTerminal();
  };

  // ---- Slash commands ----
  // Built-ins are client-side; everything else is resolved against the SAME
  // command files Claude Code reads (`.claude/commands/*.md`, bundled, user).
  // Every command Claude Code 2.1.x ships is either implemented here, mapped to
  // its GUI surface, or documented as GUI-EQ / N-A — never silently "unknown".
  const runSlashCommand = async (raw) => {
    const body = String(raw || '').replace(/^\//, '');
    const [head, ...rest] = body.trim().split(/\s+/);
    const rawCmd = (head || '').toLowerCase();
    // Claude Code 2.1.x aliases → canonical command (matches the real registry's
    // aliases[] fields exactly; undocumented ones are noted inline).
    const ALIAS = {
      q: 'quit', exit: 'quit', bye: 'quit',
      c: 'compact',
      cost: 'usage', stats: 'usage', 'usage-credits': 'usage', 'extra-usage': 'usage',
      bashes: 'bashes', tasks: 'bashes',
      plugins: 'plugins', plugin: 'plugins', marketplace: 'plugins',
      branch: 'fork', fork: 'fork',
      name: 'rename',
      'code-review': 'review',
      schedule: 'schedule', loops: 'schedule', loop: 'schedule',
    };
    const cmd = ALIAS[rawCmd] || rawCmd;
    const argText = rest.join(' ');
    const model = provider.model || '';
    const note = (s) => appendAssistant(s);
    const lastAssistant = () => [...messages].reverse().find((m) => m.role === 'assistant' && m.content);
    // One-shot model call shared by /advisor, /btw, /recap, /brief. Errors are
    // surfaced, never swallowed.
    const askOnce = async (system, question, maxTokens = 1200) => {
      try {
        const r = await window.autobot.chatOnce({
          provider, maxTokens,
          messages: [{ role: 'system', content: system }, { role: 'user', content: question }],
        });
        if (r && r.ok) return String(r.content || '').trim() || '_(empty response)_';
        return '⚠️ ' + ((r && r.error) || 'model call failed');
      } catch (e) { return '⚠️ ' + (e.message || 'model call failed'); }
    };
    const transcriptText = () => (messages || [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => (m.role === 'user' ? 'User: ' : 'Assistant: ') + msgText(m)).join('\n\n');

    switch (cmd) {
      case 'help': {
        let custom = [];
        try { custom = (await window.autobot.listCommands(cwd)) || []; } catch (_) {}
        const groups = [
          ['Session', [
            ['/help', 'this help'], ['/clear', 'clear current conversation'], ['/compact', 'summarize the transcript, then continue from the digest'],
            ['/resume', 'list conversations to switch to'], ['/continue', 'continue the last turn'], ['/fork', 'branch a copy of this conversation'],
            ['/export [md|html|json]', 'export the conversation'], ['/copy', 'copy my last reply'], ['/reset', 'clear memory + conversations'],
          ]],
          ['Model & context', [
            ['/model', 'open provider settings'], ['/usage', 'token usage for the last run'], ['/cost', 'estimated cost of the last run'],
            ['/context', 'context-window usage'], ['/insights', 'usage summary'], ['/effort [auto|low|medium|high]', 'set thinking level'],
            ['/output-style [name]', 'writing style'], ['/config', 'open settings'], ['/theme', 'toggle light/dark'],
          ]],
          ['Workspace', [
            ['/status', 'provider / model / tools'], ['/diff', 'git diff of the workspace'], ['/add-dir [path]', 'change working directory'],
            ['/init', 'write a CLAUDE.md for this project'], ['/todos', 'show the current todo list'], ['/plan [off]', 'toggle plan mode (read-only)'],
            ['/notebooks', 'open notebooks'], ['/terminal', 'open terminal'], ['/bashes', 'list background shells'],
          ]],
          ['Agent', [
            ['/agents', 'list sub-agent definitions'], ['/permissions', 'show permission rules'], ['/rewind', 'restore files from a checkpoint'],
            ['/memory', 'open memory panel'], ['/review', 'review the working-tree diff'], ['/security-review', 'security review of the diff'],
            ['/simplify', 'simplify the changed code'], ['/advisor [q]', 'second opinion from the model'], ['/btw [q]', 'quick side answer'],
            ['/recap', 'recap this conversation'], ['/brief', 'short brief of this conversation'], ['/goal [text]', 'set the run goal'],
          ]],
          ['Config & system', [
            ['/hooks', 'show merged hook config'], ['/mcp', 'show MCP servers'], ['/skills', 'list skills'], ['/reload-skills', 'refresh skills'],
            ['/plugins', 'list plugins'], ['/debug', 'build + environment info'], ['/doctor', 'diagnose the setup'], ['/version', 'app version'],
          ]],
        ];
        const fmtGroup = (title, rows) => '**' + title + '**\n' + rows.map((r) => '`' + r[0] + '` — ' + r[1]).join('\n');
        const builtins = groups.map((g) => fmtGroup(g[0], g[1])).join('\n\n');
        const customList = custom.length ? '\n\n**Project commands**\n' + custom.map((c) => '`/' + c.name + '`' + (c.description ? ' — ' + c.description : '')).join('\n') : '';
        note('Slash commands:\n\n' + builtins + customList);
        break;
      }
      case 'clear':
        clearActiveConversation();
        break;
      case 'commands': {
        let custom = [];
        try { custom = (await window.autobot.listCommands(cwd)) || []; } catch (_) {}
        const only = custom.filter((c) => c.custom);
        note('**Custom commands** (' + only.length + ')\n' + (only.length ? only.map((c) => '- `/' + c.name + '`' + (c.description ? ' — ' + c.description : '') + ' _(' + c.source + ')_').join('\n') : '_(none — add `.claude/commands/*.md`)_'));
        break;
      }
      case 'compact': {
        const msgs = (active && active.messages) || [];
        if (msgs.length < 4) { note('Nothing to compact — this conversation is still short.'); break; }
        note('⏳ Compacting ' + msgs.length + ' messages…');
        const r = await window.autobot.compact({ provider, messages: msgs });
        if (!r || !r.ok) { note('❌ Compact failed: ' + ((r && r.error) || 'unknown error')); break; }
        const digest = { id: uid(), role: 'assistant', content: '**Compacted conversation** — earlier turns were summarized.\n\n' + String(r.summary || ''), ts: Date.now() };
        setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, messages: [digest], compactedAt: Date.now() } : c)));
        if (r.usage) setLastUsage({ ...r.usage, model: r.model || model, at: Date.now() });
        break;
      }
      case 'model':
        setShowSettings(true);
        break;
      case 'review': {
        const rawArg = String(arg || '').trim();
        const adv = /--adversarial\b/i.test(rawArg);
        const withMatch = /--with\s+("([^"]+)"|'([^']+)'|(\S+))/i.exec(rawArg);
        const withSpec = withMatch ? (withMatch[2] || withMatch[3] || withMatch[4] || '') : '';
        const wantDuet = adv || Boolean(withSpec) || /--duet\b/i.test(rawArg);
        if (wantDuet) {
          openReview({ scope: 'all', duetAutoRun: true, withSpec, adversarial: adv, at: Date.now() });
          break;
        }
        if (streaming) { note('A run is in progress — wait for it to finish before /review.'); break; }
        send('Review the current working-tree changes. Run `git diff` (or `git status` then read the changed files), then give a concise code review: correctness bugs, security issues, edge cases, and concrete fixes. Reference files and line numbers.');
        break;
      }
      case 'security-review': {
        if (streaming) { note('A run is in progress — wait for it to finish.'); break; }
        send('Perform a security review of the current working-tree changes. Run `git diff`, read the affected files, and report concrete vulnerabilities (injection, authz/IDOR, secrets, unsafe deserialization, SSRF, path traversal, XSS) with file/line references and fixes. If nothing is exploitable, say so briefly.');
        break;
      }
      case 'simplify': {
        if (streaming) { note('A run is in progress — wait for it to finish.'); break; }
        send('Simplify the code in the current working-tree changes without changing behavior. Run `git diff`, then apply focused edits that remove duplication, dead code, and needless complexity. Keep the diff small and explain each change.');
        break;
      }
      case 'memory': {
        setPanel('memory');
        let pm = null;
        try { pm = await window.autobot.getProjectMemory(cwd); } catch (_) {}
        const files = (pm && pm.files) || [];
        const chars = ((pm && pm.text) || '').length;
        note('**Memory** — the Memory panel lists saved notes. Project memory comes from the `CLAUDE.md` hierarchy:\n' +
          (files.length
            ? files.map((f) => '- `' + (f.file || f.path) + '` (' + (f.scope || 'project') + ', ' + (f.bytes || 0) + ' B)').join('\n') + '\n\nCombined size: ' + chars + ' characters.'
            : '_(no CLAUDE.md found in this folder, its parents, or ~/.claude)_'));
        break;
      }
      case 'agents': {
        let list = [];
        try { list = (await window.autobot.listAgentDefs(cwd)) || []; } catch (_) {}
        appendAssistant(list.length
          ? '**Sub-agent definitions**\n' + list.map((a) => '- `' + a.name + '`' + (a.model ? ' (`' + a.model + '`)' : '') + (a.description ? ' — ' + a.description : '')).join('\n')
          : 'No sub-agent definitions found (`.claude/agents/*.md` or built-ins).');
        break;
      }
      case 'permissions': {
        let p = null;
        try { p = await window.autobot.getPermissions(cwd); } catch (_) {}
        if (!p) { appendAssistant('Permission rules unavailable.'); break; }
        const fmt = (arr) => (arr && arr.length ? arr.map((r) => '`' + r + '`').join(', ') : '_(none)_');
        appendAssistant('**Permission rules**\n- Default mode: `' + (p.defaultMode || 'auto') + '`\n- allow: ' + fmt(p.allow) + '\n- deny: ' + fmt(p.deny) + '\n- ask: ' + fmt(p.ask));
        break;
      }
      case 'rewind': {
        let cps = [];
        try { cps = (await window.autobot.listCheckpoints(activeId)) || []; } catch (_) {}
        if (!cps.length) { appendAssistant('No checkpoints for this conversation yet.'); break; }
        const target = argText ? cps.find((c) => String(c.id) === argText || String(c.turnId) === argText) : cps[cps.length - 1];
        if (!target) { appendAssistant('Checkpoint not found: `' + argText + '`\n\n' + cps.map((c) => '- `' + c.id + '`').join('\n')); break; }
        const res = await window.autobot.rewind(activeId, target.id);
        if (res && res.ok) {
          const bits = [];
          if (res.restored) bits.push(res.restored + ' file(s) restored');
          if (res.removed) bits.push(res.removed + ' file(s) removed');
          appendAssistant('✅ Rewound to checkpoint `' + target.id + '`' + (bits.length ? ' (' + bits.join(', ') + ').' : '.'));
        } else {
          appendAssistant('❌ Rewind failed: ' + (((res && res.errors) || []).join('; ') || 'unknown'));
        }
        break;
      }
      case 'reset':
        clearMemory();
        setConvs([]);
        setActiveId(null);
        setLiveSync(null);
        setError('✅ Reset complete.');
        break;
      case 'status':
        appendAssistant('**Status**\n- Provider: `' + provider.baseURL + '`\n- Model: `' + provider.model + '`\n- Tools: function-calling ' + (provider.supportsTools ? 'enabled' : 'disabled') + '\n- Memory: ' + (settings.useMemory ? 'on' : 'off') + '\n- CWD: `' + (cwd || '~') + '`');
        break;
      case 'notebooks':
        setPanel('notebooks');
        break;
      case 'terminal':
        setPanel('terminal');
        break;
      // ---------- model & context ----------
      case 'usage': {
        if (!lastUsage) { note('No token usage recorded yet for this session. Run a message first.'); break; }
        const u = lastUsage;
        const cost = estimateCost(u.model || model, u.prompt_tokens, u.completion_tokens);
        const ctxUsed = usedTokens(u);
        const ctxWin = contextWindowFor(u.model || model);
        const ctxPct = ctxWin > 0 ? Math.round((ctxUsed / ctxWin) * 100) : 0;
        note('**Usage** (last run)\n- Model: `' + (u.model || model) + '`\n- Prompt: ' + fmtTokens(u.prompt_tokens) + ' tokens (sum across ' + (u.calls || 1) + ' call(s))\n- Completion: ' + fmtTokens(u.completion_tokens) + ' tokens\n- Total: ' + fmtTokens(u.total_tokens) + ' tokens across ' + (u.calls || 1) + ' call(s)\n- Context now: ' + fmtTokens(ctxUsed) + ' / ' + fmtTokens(ctxWin) + ' (' + ctxPct + '% of window)\n- Est. cost: ' + fmtCost(cost));
        break;
      }
      case 'cost': {
        if (!lastUsage) { note('No usage recorded yet. Nothing to price.'); break; }
        const u = lastUsage;
        const cost = estimateCost(u.model || model, u.prompt_tokens, u.completion_tokens);
        const p = priceFor(u.model || model);
        note('**Cost** (last run)\n- Model: `' + (u.model || model) + '`\n- Rate: $' + p.in + ' / $' + p.out + ' per 1M in/out\n- ' + fmtTokens(u.prompt_tokens) + ' in + ' + fmtTokens(u.completion_tokens) + ' out\n- **' + fmtCost(cost) + '** (estimate)');
        break;
      }
      case 'context': {
        const chars = (messages || []).reduce((n, m) => n + msgText(m).length, 0) + (live ? (live.content || '').length : 0);
        const est = Math.round(chars / 4);
        const win = contextWindowFor(model);
        const pct = win ? Math.min(100, (est / win) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
        note('**Context**\n- Model: `' + model + '`\n- Window: ' + fmtTokens(win) + ' tokens\n- This conversation: ~' + fmtTokens(est) + ' tokens (' + pct.toFixed(1) + '%)\n`' + bar + '`\n- Messages: ' + (messages || []).length);
        break;
      }
      case 'insights': {
        const turns = (messages || []).filter((m) => m.role === 'user').length;
        const replies = (messages || []).filter((m) => m.role === 'assistant').length;
        const u = lastUsage || {};
        const conv = convs.find((c) => c.id === activeId);
        note('**Insights**\n- Conversation: ' + (conv ? conv.title : '(none)') + '\n- User turns: ' + turns + '\n- Assistant turns: ' + replies + '\n- Last model: `' + (u.model || model) + '`\n- Last total tokens: ' + fmtTokens(u.total_tokens || 0) + '\n- Est. last-run cost: ' + fmtCost(estimateCost(u.model || model, u.prompt_tokens, u.completion_tokens)) + '\n- Total conversations: ' + convs.length);
        break;
      }
      case 'effort': {
        const lv = String(argText || '').trim().toLowerCase();
        if (!lv) { note('Current thinking level: **' + (reasoningLevel || 'auto') + '**\nUse `/effort auto|low|medium|high` or the Thinking control in the composer.'); break; }
        if (!['auto', 'low', 'medium', 'high'].includes(lv)) { note('Unknown level `' + lv + '`. Pick auto, low, medium, or high.'); break; }
        setReasoningLevel(lv);
        note('Thinking level set to **' + lv + '**.');
        break;
      }
      case 'output-style': {
        const st = String(argText || '').trim().toLowerCase();
        const found = STYLES.find((s) => s.id === st || s.name.toLowerCase() === st);
        if (!st) {
          note('**Output styles**\n' + STYLES.map((s) => '- `' + s.id + '` — ' + s.name + (s.hint ? ' (' + s.hint + ')' : '') + (s.id === styleId ? '  ← current' : '')).join('\n') + '\n\nUse `/output-style <id>`.');
          break;
        }
        if (!found) { note('Unknown style `' + st + '`. Run `/output-style` to list them.'); break; }
        setStyleId(found.id);
        note('Output style set to **' + found.name + '**.');
        break;
      }
      case 'theme':
      case 'color': {
        const next = (settings.theme === 'dark') ? 'light' : 'dark';
        setSettings((s) => ({ ...s, theme: next }));
        note('Theme switched to **' + next + '**.');
        break;
      }
      case 'config':
        setShowSettings(true);
        break;
      case 'version': {
        let v = null;
        try { v = await window.autobot.getVersion(); } catch (_) {}
        note(v ? ('**Version**\n- Akron Code `' + v.app + '`\n- Electron `' + v.electron + '` · Chrome `' + v.chrome + '` · Node `' + v.node + '`\n- Platform: ' + v.platform + '/' + v.arch) : 'Version info unavailable.');
        break;
      }
      case 'debug': {
        let v = null;
        try { v = await window.autobot.getVersion(); } catch (_) {}
        let gi = null;
        try { gi = await window.autobot.gitInfo(cwd); } catch (_) {}
        note('**Debug**\n- Provider: `' + provider.baseURL + '`\n- Model: `' + model + '`\n- Tools: ' + (provider.supportsTools ? 'on' : 'off') + '\n- Reasoning: `' + (reasoningLevel || 'auto') + '`\n- Swarm: ' + (swarmEnabled ? 'on' : 'off') + '\n- Permission mode: `' + (permissions || 'auto') + '`\n- CWD: `' + (cwd || '~') + '`\n' + (gi && gi.isRepo ? '- Repo: `' + gi.root + '` on `' + gi.branch + '` (+' + gi.ahead + '/-' + gi.behind + ')' : '- Repo: none') + (v ? '\n- Build: ' + v.app + ' · Electron ' + v.electron : ''));
        break;
      }
      case 'doctor': {
        const checks = [];
        let v = null;
        try { v = await window.autobot.getVersion(); } catch (_) {}
        checks.push((v ? '✅' : '❌') + ' App runtime' + (v ? ' (' + v.app + ')' : ''));
        checks.push((provider.baseURL && provider.model ? '✅' : '❌') + ' Provider configured (' + (provider.model || 'none') + ')');
        checks.push((provider.apiKey || provider.baseURL) ? '✅' : '⚠️' + ' Credentials');
        let gi = null;
        try { gi = await window.autobot.gitInfo(cwd); } catch (_) {}
        checks.push((gi && gi.isRepo ? '✅' : '⚠️') + ' Git repo ' + (gi && gi.isRepo ? gi.root : 'not detected'));
        let sk = [];
        try { sk = (await window.autobot.getSkills()) || []; } catch (_) {}
        checks.push('✅ Skills loaded: ' + sk.length);
        let hooks = null;
        try { hooks = await window.autobot.getHooks(cwd); } catch (_) {}
        const hookCount = hooks ? Object.values(hooks).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0) : 0;
        checks.push((hookCount ? '✅' : 'ℹ️') + ' Hooks: ' + hookCount);
        note('**Doctor**\n' + checks.join('\n') + '\n\nIf a provider check is red, open `/model` and re-enter the key.');
        break;
      }
      // ---------- workspace ----------
      case 'diff': {
        let gi = null;
        try { gi = await window.autobot.gitInfo(cwd); } catch (_) {}
        if (!gi || !gi.isRepo) { note('Not a git repository (`' + (cwd || '~') + '`).'); break; }
        const c = gi.counts || {};
        let stat = null;
        try { stat = await window.autobot.gitRun(gi.root, ['diff', '--stat']); } catch (_) {}
        let full = null;
        try { full = await window.autobot.gitRun(gi.root, ['diff']); } catch (_) {}
        const body = (full && full.stdout ? full.stdout : '').slice(0, 12000);
        note('**Git diff** — `' + gi.branch + '`\n- modified ' + (c.modified || 0) + ' · added ' + (c.added || 0) + ' · deleted ' + (c.deleted || 0) + ' · untracked ' + (c.untracked || 0) + '\n\n' + ((stat && stat.stdout) ? '```\n' + stat.stdout + '\n```\n\n' : '') + (body ? '```diff\n' + body + '\n```' : '_(no unstaged changes)_'));
        break;
      }
      case 'add-dir':
      case 'cwd': {
        const dir = String(argText || '').trim();
        if (!dir) { note('Current working directory: `' + (cwd || '~') + '`\nUse `/add-dir <path>` to change it.'); break; }
        setCwd(dir);
        note('Working directory set to `' + dir + '`.');
        break;
      }
      case 'init': {
        const content = [
          '# Project guide',
          '',
          'This file (`CLAUDE.md`) is read automatically at the start of every conversation. Keep it short and factual.',
          '',
          '## Overview',
          '<!-- what this project is, one paragraph -->',
          '',
          '## Commands',
          '- install: `npm install`',
          '- build: `npm run build`',
          '- test: `npm test`',
          '',
          '## Conventions',
          '- <!-- style, structure, gotchas -->',
          '',
        ].join('\n');
        const r = await window.autobot.writeFile({ file: 'CLAUDE.md', content, cwd });
        note(r && r.ok ? '✅ Created `CLAUDE.md` at `' + r.path + '`. Edit it to describe this project.' : '❌ Could not write CLAUDE.md: ' + ((r && r.error) || 'unknown'));
        break;
      }
      case 'note': {
        const topic = String(argText || '').trim();
        if (!topic) {
          note('Use `/note <decision title>` to record an Agent Note in `.agents/notes/` (DeepSeek Harness pattern).');
          break;
        }
        const day = new Date().toISOString().slice(0, 10);
        const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'decision';
        const relPath = `.agents/notes/implemented/architecture/${day}-${slug}.md`;
        const content = [
          `# Agent Note: ${topic}`,
          '',
          'Status: implemented',
          '',
          '## Problem',
          'Describe the constraint, failure mode, or design tension this decision resolves.',
          '',
          '## Decision',
          `- Recorded in Akron Code workspace (\`${cwd || '.'}\`).`,
          '',
          '## Verification',
          '- Concrete checks / E2E tests covering this change.',
          '',
        ].join('\n');
        const r = await window.autobot.writeFile({ file: relPath, content, cwd });
        note(r && r.ok ? `✅ Created Agent Note at \`${relPath}\`.` : `❌ Could not write Agent Note: ${(r && r.error) || 'unknown'}`);
        break;
      }
      case 'todos': {
        let todos = null;
        for (let i = (messages || []).length - 1; i >= 0; i--) {
          const m = messages[i];
          const tool = (m.tools || []).find((t) => t && t.name === 'TodoWrite' && t.args && Array.isArray(t.args.todos));
          if (tool) { todos = tool.args.todos; break; }
        }
        if (!todos || !todos.length) { note('No todo list in this conversation yet. The agent creates one with the TodoWrite tool.'); break; }
        const mark = (s) => s === 'completed' ? '✅' : s === 'in_progress' ? '🔄' : '⬜';
        note('**Todos**\n' + todos.map((t) => mark(t.status) + ' ' + (t.content || t.activeForm || '')).join('\n'));
        break;
      }
      case 'plan': {
        const off = /^(off|stop|exit|false)$/i.test(String(argText || '').trim());
        if (off) { setPermissions('auto'); note('Plan mode off — back to auto.'); break; }
        setPermissions('plan');
        note('Plan mode on — the agent is read-only and writes only the plan file until you approve. Use the permission pill or `/plan off` to exit.');
        break;
      }
      case 'bashes': {
        let jobs = [];
        try { jobs = (await window.autobot.shellList()) || []; } catch (_) {}
        if (!jobs.length) { note('No background shells running.'); break; }
        note('**Background shells**\n' + jobs.map((j) => '- `' + (j.id || '?') + '` ' + (j.status || '') + (j.label ? ' — ' + j.label : '')).join('\n'));
        break;
      }
      // ---------- session ----------
      case 'copy': {
        const last = lastAssistant();
        if (!last) { note('Nothing to copy yet.'); break; }
        try { await navigator.clipboard.writeText(last.content || ''); note('Copied the last reply to the clipboard.'); }
        catch (_) { note('Clipboard unavailable.'); }
        break;
      }
      case 'export': {
        const fmt = ['md', 'html', 'json'].includes(String(argText || '').trim().toLowerCase()) ? String(argText).trim().toLowerCase() : 'md';
        await exportConv(fmt);
        break;
      }
      case 'resume': {
        const want = String(argText || '').trim();
        if (want) {
          const hit = convs.find((c) => c.id === want || (c.title || '').toLowerCase().includes(want.toLowerCase()));
          if (hit) { setActiveId(hit.id); note('Resumed **' + (hit.title || hit.id) + '**.'); break; }
        }
        const rows = convs.slice(0, 25).map((c) => '- `' + c.id + '` — ' + (c.title || 'Untitled') + ' (' + (c.messages || []).length + ' msgs)' + (c.id === activeId ? '  ← current' : ''));
        note('**Conversations**\n' + (rows.length ? rows.join('\n') : '_(none yet)_') + '\n\nUse `/resume <id-or-title>`.');
        break;
      }
      case 'continue': {
        if (streaming) { note('Already running — the current turn will finish first.'); break; }
        send('continue');
        break;
      }
      case 'fork': {
        const conv = convs.find((c) => c.id === activeId);
        if (!conv) { note('No active conversation to fork.'); break; }
        const copy = { ...conv, id: uid(), title: (conv.title || 'Untitled') + ' (fork)', messages: (conv.messages || []).map((m) => ({ ...m, id: uid() })), ts: Date.now() };
        setConvs((cs) => [copy, ...cs]);
        setActiveId(copy.id);
        note('Forked into **' + copy.title + '**.');
        break;
      }
      case 'goal': {
        if (!argText) {
          note(goal ? 'Current goal: ' + goal + '\nUse `/goal <objective>` to run autonomously until that goal is completely finished.' : 'No goal set. Use `/goal <objective>` to run until the specified goal is completely finished.');
          break;
        }
        setGoal(argText);
        setNotice('Goal: ' + argText);
        if (!streaming) {
          send(`[AUTONOMOUS GOAL MODE]\nGoal: ${argText}\n\nWork thoroughly step-by-step, verify everything end-to-end with concrete checks/tests, and do not stop until this goal is completely finished.`);
        } else {
          note('🎯 Goal updated: ' + argText);
        }
        break;
      }
      case 'swarm': {
        const clean = String(argText || '').trim();
        if (clean === 'off') {
          setSwarmEnabled(false);
          note('Swarm mode **OFF**.');
          break;
        }
        if (clean === 'on' || !clean) {
          const next = clean === 'on' ? true : !swarmEnabled;
          setSwarmEnabled(next);
          note('Swarm mode **' + (next ? 'ON' : 'OFF') + '** — multi-model Planner + role-pooled Swarm workers ' + (next ? 'enabled.' : 'disabled.'));
          break;
        }
        setSwarmEnabled(true);
        if (!streaming) send(clean);
        else note('Swarm mode ON. Current run is still active.');
        break;
      }
      case 'subagents': {
        showSessionPane('subagents');
        break;
      }
      case 'worktrees': {
        openSettingsAt('worktrees');
        break;
      }
      case 'gdrive': {
        setGdriveModalOpen(true);
        break;
      }
      // ---------- one-shot model calls ----------
      case 'advisor': {
        if (!argText) { note('Use `/advisor <question>` for a second opinion from the model without adding a turn to the transcript.'); break; }
        const q = transcriptText().slice(-6000) + '\n\nQuestion: ' + argText;
        note('**Advisor**\n' + await askOnce('You are a second-opinion advisor. Given the conversation and a question, give a direct, critical answer. Point out risks and concrete next steps. Be brief.', q, 900));
        break;
      }
      case 'btw': {
        if (!argText) { note('Use `/btw <question>` for a quick side answer that stays out of the main thread.'); break; }
        note('**By the way**\n' + await askOnce('Answer the user\'s side question briefly and directly. It is a tangent, not the main task.', argText, 700));
        break;
      }
      case 'recap': {
        if (!messages.length) { note('Nothing to recap yet.'); break; }
        note('**Recap**\n' + await askOnce('Summarize this conversation in a short recap: what the user wanted, what was done, current state, and what is left. Terse bullets.', transcriptText().slice(-12000), 900));
        break;
      }
      case 'brief': {
        if (!messages.length) { note('Nothing to brief yet.'); break; }
        note('**Brief**\n' + await askOnce('Give a one-paragraph brief of this conversation and 3 bullet next steps.', transcriptText().slice(-12000), 600));
        break;
      }
      // ---------- config & system ----------
      case 'hooks': {
        let hooks = null;
        try { hooks = await window.autobot.getHooks(cwd); } catch (_) {}
        if (!hooks) { note('Hook config unavailable.'); break; }
        const rows = [];
        for (const [ev, arr] of Object.entries(hooks)) {
          if (!Array.isArray(arr) || !arr.length) continue;
          for (const entry of arr) rows.push('- `' + ev + '`' + (entry.matcher ? ' [' + entry.matcher + ']' : '') + ' — ' + (entry.hooks || []).map((h) => h.type + (h.command ? ': `' + h.command + '`' : '')).join(', '));
        }
        note('**Hooks**\n' + (rows.length ? rows.join('\n') : '_(no hooks configured — checked ~/.claude, ./.claude, ~/.autobot/hooks.json)_'));
        break;
      }
      case 'mcp': {
        let cfg = null;
        try { cfg = await window.autobot.mcpConfig(cwd); } catch (_) {}
        if (!cfg) { note('MCP config unavailable.'); break; }
        const st = (cfg.status || []).map((s) => '- `' + (s.id || s.name) + '` — ' + (s.status || s.state || 'configured'));
        note('**MCP servers**\n' + (cfg.servers && cfg.servers.length ? cfg.servers.join(', ') : '_(none configured)_') + (st.length ? '\n\n**Status**\n' + st.join('\n') : ''));
        break;
      }
      case 'skills':
      case 'reload-skills': {
        let list = [];
        try { list = (await window.autobot.getSkills()) || []; } catch (_) {}
        setSkills(list);
        note('**Skills** (' + list.length + ')\n' + (list.length ? list.map((s) => '- `' + (s.name || s.id) + '`' + (s.enabled === false ? ' _(disabled)_' : '') + (s.description ? ' — ' + s.description : '')).join('\n') : '_(none found)_'));
        break;
      }
      case 'plugins':
      case 'reload-plugins': {
        let list = [];
        try { list = (await window.autobot.listPlugins({})) || []; } catch (_) {}
        const arr = Array.isArray(list) ? list : (list.items || []);
        note('**Plugins** (' + arr.length + ')\n' + (arr.length ? arr.map((p) => '- `' + (p.name || p.id) + '`' + (p.description ? ' — ' + p.description : '')).join('\n') : '_(none installed)_'));
        break;
      }
      // ---------- GUI-EQ / informational ----------
      case 'statusline':
        note('`/statusline` — Akron Code renders status in the composer (provider, model, thinking level, context). Use `/status` for a text dump.');
        break;
      case 'login':
        setShowSettings(true);
        note('Sign-in lives in Settings → Accounts.');
        break;
      case 'logout': {
        // Sign out the subscription this session is actually using (not a mock
        // identity). Clear the OAuth binding so the next turn falls back to the
        // configured gateway until an account is picked again.
        const active = provider.oauthProvider || '';
        if (active) {
          const cut = active.indexOf(':');
          const pid = cut > 0 ? active.slice(0, cut) : active;
          const acct = cut > 0 ? active.slice(cut + 1) : '';
          try { await window.autobot.providerSignOut(pid, acct); } catch (_) { /* main may not hold it */ }
          setProvider((v) => ({ ...v, oauthProvider: '', oauth: false, accessToken: '' }));
        }
        setAccount((a) => ({ ...a, signedIn: false, email: '', authMethod: null, plan: 'Free' }));
        note(active ? 'Signed out of the active provider account.' : 'No provider account is active.');
        break;
      }
      case 'quit':
        note('`/quit` — Akron Code is a GUI app, so there is no terminal to exit. Close the window (⌘W) to quit, or use the app menu.');
        break;
      case 'pr-comments':
        note('`/pr-comments` — pull request comments are reviewed in the Artifacts / GitHub panel. Connect a repo with `/init` and view PRs there.');
        break;
      case 'sandbox': {
        let d = null;
        try { d = await window.autobot.getSandbox(); } catch (_) {}
        if (!d) { note('Sandbox policy unavailable.'); break; }
        const fsb = d.filesystem || {};
        const net = d.network || {};
        const list = (a) => (Array.isArray(a) && a.length ? a.join(', ') : '—');
        note(
          `**Sandbox**: ${d.enabled ? 'enabled' : 'disabled'}${d.managed ? ' · managed by administrator' : ''}\n\n` +
          `Filesystem\n- deny read: ${list(fsb.denyRead)}\n- deny write: ${list(fsb.denyWrite)}\n- allow read: ${list(fsb.allowRead)}\n\n` +
          `Network\n- allowed domains: ${list(net.allowedDomains)}\n- denied domains: ${list(net.deniedDomains)}\n\n` +
          `Shell backend: ${d.backend || 'none'}`
        );
        break;
      }
      case 'search':
        setPanel((p) => (p === 'search' ? 'chats' : 'search'));
        break;
      case 'alias':
        note('`/alias` — command aliases are configured in Settings → Commands. Project commands live in `.claude/commands/*.md`.');
        break;
      case 'focus':
        note('`/focus` — narrow the working set with a project (Projects panel) or `/add-dir`.');
        break;
      case 'bug':
        note('Found a bug? File it with `/feedback` or the akronlogic.com support link. Include `/debug` output.');
        break;
      case 'feedback': {
        const fb = compliance && compliance.state ? compliance.state.feedback : null;
        if (fb && fb.allowed === false) {
          note((compliance.state && compliance.state.feedbackLine) || 'Product feedback is turned off by your organization’s policy.');
          break;
        }
        note('Feedback goes to akronlogic.com. Include `/debug` and `/version` output so it is actionable.');
        break;
      }
      case 'init-verifiers':
        note('`/init-verifiers` — add test/verification steps to `CLAUDE.md`. Use `/init` first, then describe how to verify changes.');
        break;
      // ---------- remaining Claude Code 2.1.x commands implemented in the GUI ----------
      case 'rename': {
        if (!argText) { note('Usage: `/rename <new title>` (alias: `/name`).'); break; }
        setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, title: argText } : c)));
        note('Renamed this conversation to **' + argText + '**.');
        break;
      }
      case 'toggle-memory': {
        const cur = localStorage.getItem('autobot:autoMemory') !== 'off';
        localStorage.setItem('autobot:autoMemory', cur ? 'off' : 'on');
        note('Auto-memory ' + (cur ? 'OFF' : 'ON') + ' for this session. (Settings → Memory toggles the global default.)');
        break;
      }
      case 'autocompact': {
        if (!argText) {
          const w = localStorage.getItem('autobot:autoCompactWindow') || 'auto';
          note('Auto-compact window: **' + w + '**. Set with `/autocompact <tokens|auto>`.');
          break;
        }
        localStorage.setItem('autobot:autoCompactWindow', argText);
        note('Auto-compact window set to **' + argText + '**. `/compact` still works on demand.');
        break;
      }
      case 'fast': {
        setReasoningLevel('low');
        note('⚡ Fast mode — reasoning level set to **Low**. Use `/effort` to change it.');
        break;
      }
      case 'background': {
        note('Akron Code runs every task in-app, so there is no terminal to background. Use `/tasks` to see background shells, sub-agents, and monitors.');
        break;
      }
      case 'stop': {
        if (streaming) { stop(); note('Stopped the current run — the partial reply is kept.'); }
        else { note('Nothing is running. `/tasks` lists background work you can inspect or kill.'); }
        break;
      }
      case 'schedule': {
        setPanel('scheduled');
        note('Opened **Scheduled** — create, edit, or pause recurring runs here.');
        break;
      }
      case 'workflows': {
        setPanel('scheduled');
        note('**Workflows** — dynamic multi-step runs live under **Scheduled**. Completed and running workflow history is listed there.');
        break;
      }
      // ---------- terminal/account/product surfaces: GUI equivalents ----------
      case 'voice': {
        if (voiceMode) { stopVoiceMode(); note('Voice mode stopped.'); }
        else { startVoiceMode(); note('🎙️ Voice mode on — speak, and the reply is read back. Send `/voice` again to stop.'); }
        break;
      }
      case 'chrome': {
        const on = !features.chrome;
        const next = { ...features, chrome: on };
        setFeatures(next);
        window.autobot.setFeatures(next);
        note('Chrome control (CDP) is now **' + (on ? 'ON' : 'OFF') + '**. Point it at a running Chrome with `--remote-debugging-port=9222` (Settings → Chrome host/port).');
        break;
      }
      case 'daemon': {
        setPanel('scheduled');
        note('**Background services** — Akron Code keeps scheduled tasks, background shells, sub-agents, and monitors inside the app (no separate daemon). Opened **Scheduled**; `/tasks` lists live work.');
        break;
      }
      case 'session': {
        const conv = convs.find((c) => c.id === activeId);
        note('**Session** `' + (activeId || 'new') + '` — ' + (conv ? (conv.messages || []).length + ' messages, titled “' + (conv.title || 'Untitled') + '”' : 'not yet persisted') + '.\nWorking folder: `' + cwd + '`. Use `/export` to save the transcript.');
        break;
      }
      case 'remote-env': {
        const on = !features.remoteControl;
        const next = { ...features, remoteControl: on };
        setFeatures(next);
        window.autobot.setFeatures(next);
        note('Remote control is now **' + (on ? 'ON' : 'OFF') + '** (Settings → Features). Akron Code has no cloud workspace, so remote sessions run against this machine.');
        break;
      }
      case 'setup-bedrock': {
        setProvider((v) => ({ ...v, baseURL: 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1', model: v.model || 'anthropic.claude-sonnet-4-5', apiKey: v.apiKey || '', supportsTools: true }));
        setShowSettings(true);
        note('**Amazon Bedrock** — Bedrock ships an OpenAI-compatible endpoint. Set the API key to a Bedrock API key (or `AWS_BEARER_TOKEN_BEDROCK`) and change the region in the URL, then press **Test** in Settings.');
        break;
      }
      case 'setup-vertex': {
        setProvider((v) => ({ ...v, baseURL: 'https://us-central1-aiplatform.googleapis.com/v1/projects/PROJECT_ID/locations/us-central1/endpoints/openapi', model: v.model || 'google/gemini-2.5-pro', apiKey: v.apiKey || '', supportsTools: true }));
        setShowSettings(true);
        note('**Google Vertex AI** — replace `PROJECT_ID` with your GCP project, put an OAuth access token in the API key field, and press **Test** in Settings.');
        break;
      }
      case 'ide': {
        setWorkbenchMode('ide');
        note('Switched to **IDE Mode** (Monaco Editor, File Explorer, Search, Source Control & PTY Terminal). Press `⌘⇧E` to toggle back.');
        break;
      }
      case 'desktop': {
        note('You are already in the desktop app, so there is nothing to hand off. `/session` shows the current session and folder.');
        break;
      }
      case 'tui': {
        note('Akron Code renders a full GUI, so the terminal renderer setting does not apply. Use **Settings → Appearance** for density.');
        break;
      }
      case 'keybindings': {
        note('Keybindings are configured in **Settings → Shortcuts** (they are stored with the app, not in a JSON file). Press `⌘K` for the command palette.');
        break;
      }
      case 'scroll-speed': {
        note('Scroll speed follows the OS pointer setting. In-app transcript scrolling is momentum-based, so there is no separate multiplier to tune.');
        break;
      }
      case 'wellbeing': {
        note('Break reminders are handled by the OS. Akron Code keeps long runs visible with elapsed time and a live activity row instead of nudging you.');
        break;
      }
      case 'privacy-settings': {
        setShowSettings(true);
        note('Opened **Settings**. Akron Code sends data only to the provider you configure — there is no telemetry endpoint and no account requirement.');
        break;
      }
      case 'rate-limit-options': {
        setShowSettings(true);
        note('Hit a provider limit? Opened **Settings** — switch provider/model, add a second key, or enable the orchestrator to fail over automatically.');
        break;
      }
      case 'release-notes': {
        let v = '';
        try { v = (await window.autobot.getVersion()) || ''; } catch (_) {}
        note('**Akron Code** ' + (v ? 'v' + v : '') + ' — no changelog feed is bundled; release notes ship with each build at akronlogic.com.');
        break;
      }
      case 'update':
      case 'upgrade':
      case 'install': {
        note('Akron Code updates by installing a new build (DMG/ZIP) — `/version` shows the current one. Provider plans are managed at the provider, not in-app.');
        break;
      }
      case 'powerup': {
        note('**Quick tour** — start with `/help`, then try `/plan` for read-only exploration, `/compact` to shrink context, `/context` to see what is loaded, and `/usage` for tokens and cost.');
        break;
      }
      case 'team-onboarding': {
        note('**Onboarding a teammate:** install the app, set a provider in Settings, open the project folder, then `/init` writes `CLAUDE.md`. `/usage` summarises tokens and cost.');
        break;
      }
      case 'autofix-pr': {
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        send('Monitor the current pull request: run `gh pr checks --watch` (or `gh pr view --json statusCheckRollup`) and, for every failing check, read the logs, fix the cause in the working tree, re-run the failing command locally, and commit. Repeat until all checks pass, then summarise the fixes.');
        break;
      }
      case 'ultrareview': {
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        send('Perform an exhaustive review of the pending changes (`git diff` plus untracked files). For each hunk: correctness, edge cases, security (injection, authz, secrets), performance, and test coverage. Rank findings by severity, quote the exact lines, and propose a concrete patch for each. Do not apply changes — report only.');
        break;
      }
      case 'install-github-app': {
        if (streaming) { note('Already running — wait for the current turn to finish.'); break; }
        send('Set up GitHub Actions for this repository: inspect the project type, write `.github/workflows/ci.yml` that installs dependencies and runs the existing test/lint scripts, and explain how to add the API key as a repository secret. Ask before committing.');
        break;
      }
      case 'install-slack-app':
      case 'web-setup':
      case 'mobile':
      case 'teleport':
      case 'stickers':
      case 'radio':
      case 'heapdump':
      case 'bridge-kick':
      case 'pro-trial-expired': {
        note('`/' + cmd + '` targets Anthropic-hosted services (Slack app, claude.ai web/mobile/teleport, trial billing, debug tooling) that do not exist in Akron Code. Nothing to configure locally.');
        break;
      }
      default: {
        // MCP Prompt / REA guided workflow: `/mcp:<serverId>:<promptName> [args]`
        if (/^mcp:[^:\s]+:[^:\s]+$/i.test(cmd)) {
          const [, serverId, ...restParts] = cmd.split(':');
          const promptName = restParts.join(':');
          try {
            const expanded = await window.autobot.expandMcpPrompt({ serverId, name: promptName, argText, cwd });
            if (expanded && expanded.ok && expanded.prompt) {
              if (!streaming) send(expanded.prompt);
              else note(expanded.prompt);
              break;
            }
            if (expanded && expanded.error) {
              note('⚠️ ' + expanded.error);
              break;
            }
          } catch (e) {
            note('⚠️ ' + (e.message || 'MCP prompt expansion failed'));
            break;
          }
        }
        // Installed/built-in skill invocation: `/skill:<name> [args]`
        if (/^skill:.+$/i.test(cmd)) {
          const skillName = cmd.slice(6);
          try {
            const loaded = await window.autobot.loadSkill(skillName);
            if (loaded && loaded.content) {
              const prompt = `[Skill: ${skillName}]\n${loaded.content}\n\nUser request: ${argText || `Apply the ${skillName} skill to the current task in ${cwd || 'workspace'}.`}`;
              if (!streaming) send(prompt);
              else note('Loaded skill `' + skillName + '`.');
              break;
            }
          } catch (_) {}
        }
        // Project / user command: expand its markdown body into a real prompt.
        let hit = null;
        try { hit = await window.autobot.resolveCommand(cmd, argText, cwd); } catch (_) {}
        if (hit && hit.prompt) {
          send(hit.prompt);
        } else {
          appendAssistant('Unknown slash command: `/' + cmd + '`');
        }
      }
    }
  };

  const appendAssistant = (content) => {
    const msg = { id: uid(), role: 'assistant', content, ts: Date.now() };
    const id = activeIdRef.current;
    // Self-heal: `activeId` can point at a conversation that no longer exists
    // (deleted chat, or a stale id restored from localStorage). Without this the
    // map() below matched nothing and the message vanished — /help looked dead.
    const known = id && (convsRef.current || []).some((c) => c.id === id);
    if (!known) {
      // No active conversation (e.g. /help on a fresh chat) — create one so the message is visible.
      const convId = uid();
      setActiveId(convId);
      setConvs((cs) => [{ id: convId, title: (content.slice(0, 48) || 'Assistant'), messages: [msg], ts: Date.now() }, ...cs]);
      return;
    }
    setConvs((cs) => cs.map((c) => (c.id === id ? { ...c, messages: [...c.messages, msg] } : c)));
  };

  const clearActiveConversation = () => {
    setConvs((cs) => cs.map((c) => (c.id === activeId ? { ...c, messages: [] } : c)));
    setLiveSync(null);
  };

  const artifacts = useMemo(() => {
    const blocks = [];
    for (const m of messages) if (m.role === 'assistant') blocks.push(...extractCodeBlocks(m.content));
    if (live) blocks.push(...extractCodeBlocks(live.content));
    for (const a of artifactsExplicit) blocks.push({ lang: a.language || 'text', code: a.content, label: a.name });
    return blocks;
  }, [messages, live, artifactsExplicit]);

  const liveTeam = teamConvRef.current === activeId;
  const effectiveSubAgents = useMemo(
    () => deriveSubAgents(liveTeam ? subAgents : [], active, messages, liveForActive),
    [liveTeam, subAgents, active, messages, liveForActive]
  );
  const effectiveSwarmInfo = (liveTeam && swarmInfo) || (active && active.swarmInfo) || null;
  const effectiveSwarmBoard = (liveTeam && swarmBoard.length ? swarmBoard : null) || (active && active.swarmBoard) || [];
  const allActiveTools = useMemo(
    () => (messages || []).flatMap((m) => m.tools || []).concat((liveForActive && liveForActive.tools) || []),
    [messages, liveForActive]
  );
  const allActiveCheckpoints = useMemo(
    () => (messages || []).flatMap((m) => m.checkpoints || []).concat((liveForActive && liveForActive.checkpoints) || []),
    [messages, liveForActive]
  );
  const changedFilesBadge = useMemo(
    () => summarizeChangedFiles(allActiveTools, allActiveCheckpoints).files.length,
    [allActiveTools, allActiveCheckpoints]
  );
  const paneProps = {
    activeType: sessionPane.type,
    openTabs: openPaneTabs,
    onSelectTab: showSessionPane,
    onCloseTab: closeSessionTab,
    badges: {
      subagents: effectiveSubAgents.length,
      review: changedFilesBadge,
    },
    width: sessionPane.type === 'review' ? Math.max(sessionPane.width || 540, 520) : (sessionPane.width || 480),
    onWidth: (w) => setSessionPane((p) => ({ ...p, width: w })),
    onHide: () => setSessionPane((p) => ({ ...p, type: null })),
  };

  const isWinHost = typeof navigator !== 'undefined' && /Win/i.test(navigator.platform || '');
  const modShift = isWinHost ? 'Ctrl+Shift+' : '⌘⇧';
  const visibleTabs = openTabIds.map((id) => convs.find((c) => c.id === id)).filter(Boolean);

  return (
    <div className="app" data-theme={settings.theme} data-platform={isWinHost ? 'win32' : 'darwin'} dir={localeDir(settings.locale)} lang={settings.locale}>
      <div className="titlebar">
        <div className="titlebar-brand">
          <Logo size={16} active={streaming} />
          <span className="brand">Akron Code</span>
          <span className="sub">{T('brand.sub')}</span>
          <div className="ws-mode-switch" role="group" aria-label="Workspace mode">
            <button
              type="button"
              className={'ws-mode-btn' + (workbenchMode === 'agent' ? ' on' : '')}
              onClick={() => setWorkbenchMode('agent')}
              title={`Agent & Mission Control view (${modShift}E)`}
            >
              <Icon name="Sparkles" size={12} /> <span>Agent</span>
            </button>
            <button
              type="button"
              className={'ws-mode-btn' + (workbenchMode === 'ide' ? ' on' : '')}
              onClick={() => setWorkbenchMode('ide')}
              title={`Full AI IDE Workbench with Monaco & Terminal (${modShift}E)`}
            >
              <Icon name="Code" size={12} /> <span>IDE</span>
            </button>
          </div>
        </div>
        <div className="ws-tabs" role="tablist" aria-label="Workspace sessions">
          {visibleTabs.map((tab) => (
            <div
              key={tab.id}
              role="tab"
              aria-selected={tab.id === activeId && panel === 'chats'}
              className={'ws-tab' + (tab.id === activeId && panel === 'chats' ? ' on' : '')}
              onClick={() => selectConv(tab.id)}
              title={tab.title || 'Untitled session'}
            >
              {streaming && runConvRef.current === tab.id && <span className="ws-tab-dot" />}
              {waitingPermissionConvIds.has(tab.id) && (
                <span className="conv-perm-bell" title="Waiting for permission">
                  <Icon name="Notification" size={11} />
                </span>
              )}
              <span className="ws-tab-label">{tab.title || 'Untitled session'}</span>
              <button type="button" className="ws-tab-x" aria-label="Close tab" onClick={(e) => closeWorkspaceTab(tab.id, e)}>
                <Icon name="X" size={10} />
              </button>
            </div>
          ))}
          <button type="button" className="ws-tab-add" title="New session tab" aria-label="New session tab" onClick={newChat}>
            <Icon name="Add" size={14} />
          </button>
        </div>
        <NotificationCenter {...notifCenter} Icon={Icon} />
      </div>

      {workbenchMode === 'ide' ? (
        <IdeWorkbench
          cwd={cwd || ''}
          setCwd={(dir) => {
            setCwd(dir);
            if (activeId && dir) {
              saveJSON('autobot:workspace:' + activeId, dir);
              try { window.autobot.setWorkspace(activeId, dir); } catch (_) {}
            }
          }}
          theme={settings.theme}
          typography={settings.typography}
          provider={provider}
          orchestrator={orchestrator}
          envState={envState}
          contextPct={(() => {
            const win = contextWindowFor((lastUsage && lastUsage.model) || (provider && provider.model) || '');
            const used = usedTokens(lastUsage);
            return win > 0 && used > 0 ? Math.min(100, Math.round((used / win) * 100)) : null;
          })()}
          setError={setError}
          setNotice={setNotice}
          externalOpenFile={ideExternalOpenFile}
          onAttachToChat={(node) => {
            setAttachments((a) => [...a, { name: node.name, path: node.path, size: 0, isText: true, content: `@${node.relPath || node.name}` }]);
          }}
          onSendToAgent={(prompt) => send(prompt)}
          onOpenSettings={() => openSettingsAt('providers')}
          onOpenEnvironments={() => openSettingsAt('environments')}
          onOpenRuntimes={() => openSettingsAt('runtimes')}
          onSwitchToAgent={() => setWorkbenchMode('agent')}
          renderAgentDock={({ editorContextXml, onOpenFileDiff }) => {
            editorContextXmlRef.current = editorContextXml || '';
            return (
              <>
                <ChatView
                  messages={messages} live={liveForActive} thinking={liveForActive ? thinking : ''} paused={paused} onScrollAway={setScrolledAway}
                  subAgents={effectiveSubAgents} swarmInfo={effectiveSwarmInfo} swarmBoard={effectiveSwarmBoard} planMode={planMode}
                  copyBlock={copyBlock} applyBlock={applyBlock} bottomRef={bottomRef} convId={activeId} cwd={cwd}
                  copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage}
                  forkFromMessage={forkFromMessage} shareFromMessage={shareFromMessage} conv={active} exportConv={exportConv}
                  T={T} runStartedAt={runStartedAt}
                  envOpen={sessionPane.type === 'env'} onToggleEnv={() => { setWorkbenchMode('agent'); toggleSessionPane('env'); }}
                  runLogOpen={sessionPane.type === 'runlog'} onToggleRunLog={() => { setWorkbenchMode('agent'); showSessionPane('runlog'); }}
                  reviewOpen={false} sessionPaneType={null}
                  onOpenReview={(target) => {
                    const summary = summarizeChangedFiles((target && target.tools) || allActiveTools, (target && target.checkpoints) || allActiveCheckpoints);
                    const first = summary.files && summary.files[0];
                    if (first && onOpenFileDiff) {
                      onOpenFileDiff(first.path.startsWith('/') || /^[A-Za-z]:/.test(first.path) ? first.path : `${cwd}/${first.path}`);
                    } else {
                      setWorkbenchMode('agent');
                      openReview(target);
                    }
                  }}
                  onTogglePane={(tp) => { setWorkbenchMode('agent'); tp ? showSessionPane(tp) : toggleSessionPane(); }}
                  onOpenPlugins={() => openSettingsAt('skills')}
                  onRenameConv={(title) => active && renameConv(active.id, title)}
                  onPinConv={() => active && pinConv(active.id)}
                  onArchiveConv={() => active && archiveConv(active.id)}
                  onSplitConv={() => (active ? splitConv(active.id) : openReview({ scope: 'all' }))}
                  onDeleteConv={() => active && deleteConv(active.id)}
                  setError={setError}
                />
                {error && (
                  <div className={'errorbar' + (String(error).startsWith('✅') ? ' ok' : '')}>
                    <span className="errorbar-text">{error}</span>
                    <button type="button" className="errorbar-x" title="Dismiss" aria-label="Dismiss" onClick={() => setError('')}><Icon name="X" size={12} /></button>
                  </div>
                )}
                {streaming && paused && (
                  <div className="paused-banner" role="status">
                    <div className="paused-banner-left"><span className="paused-banner-dot" /><span>Paused — Resume or type a steering note</span></div>
                    <button type="button" className="paused-resume-btn" onClick={() => resumeRun('')}><Icon name="Play" size={12} /> Resume</button>
                  </div>
                )}
                <PermissionDock
                  queue={permissionQueue.filter((p) => !p.convId || p.convId === activeId)}
                  onRespond={answerPermission}
                  errorMsg={permError}
                  submitting={permSubmitting}
                />
                <InputBar
                  streaming={streaming} paused={paused} onPause={pauseRun} onResume={resumeRun} send={send} stop={stop} inputRef={inputRef} cwd={cwd} setCwd={setCwd} runSlashCommand={runSlashCommand}
                  queued={filterQueueForConv(queued, activeId)}
                  queuePaused={!!(activeId && queuePausedByConv[activeId])}
                  onToggleQueuePaused={() => toggleQueuePaused(activeId)}
                  onClearQueue={() => clearQueuedForConv(activeId)}
                  onToggleQueueItemPaused={toggleQueueItemPaused}
                  onReorderQueue={reorderQueued}
                  onStepQueueItem={stepQueued}
                  onUpdateQueueItemText={updateQueuedText}
                  unqueue={unqueue} sendQueuedNow={sendQueuedNow}
                  settings={settings} onVoiceError={setError}
                  provider={provider} setProvider={setProvider} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} openSettings={(opts) => { setPendingPreset(opts && opts.preset ? opts.preset : null); openSettingsAt('providers'); }}
                  providerKeys={providerKeys} setProviderKeys={setProviderKeys}
                  attachments={attachments} setAttachments={setAttachments}
                  reasoningLevel={reasoningLevel} setReasoningLevel={setReasoningLevel}
                  swarmEnabled={swarmEnabled} setSwarmEnabled={setSwarmEnabled}
                  styleId={styleId} setStyleId={setStyleId}
                  webSearch={webSearch} setWebSearch={setWebSearch}
                  dictating={dictating} setDictating={setDictating}
                  voiceMode={voiceMode} startVoiceMode={startVoiceMode} stopVoiceMode={stopVoiceMode}
                  sessionPane={sessionPane} toggleSessionPane={toggleSessionPane}
                  permissions={permissions} setPermissions={setPermissions}
                  lastUsage={lastUsage}
                  gdriveState={gdriveState}
                  onOpenGdrive={() => setGdriveModalOpen(true)}
                  envState={envState}
                  onSwitchEnvironment={switchEnvironment}
                  onOpenEnvironments={() => openSettingsAt('environments')}
                  T={T}
                />
              </>
            );
          }}
          Icon={Icon}
        />
      ) : (
      <div className="layout">
        {/* Sidebar — 3-zone layout: pinned Workspace + Dock, scrollable Recents, pinned Customizations & Settings */}
        <aside className={'sidebar' + (sidebarCollapsed ? ' collapsed' : '')}>
          <div className="sidebar-top">
            <div className="sidebar-head">
              <button className="newchat" onClick={newChat} title={T('sidebar.newChat')}>
                <Icon name="Add" size={15} />
                <span className="label">{T('sidebar.newChat')}</span>
              </button>
              <div className="sidebar-actions">
                <button className="icon-btn" title={`${T('sidebar.search')} (${modShift}F)`} onClick={() => setPanel((p) => (p === 'search' ? 'chats' : 'search'))}><Icon name="Search" size={16} /></button>
                <button className="icon-btn" title={sidebarCollapsed ? T('sidebar.expand') : T('sidebar.collapse')} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
                  <Icon name={sidebarCollapsed ? 'SidebarOpen' : 'SidebarClose'} size={16} />
                </button>
              </div>
            </div>

            <div className="section-label">Workspace</div>
            <nav className="sidenav">
              <button className={panel === 'search' ? 'on' : ''} onClick={() => setPanel('search')} title="Search conversations"><Icon name="Search" size={15} /><span className="label">Search</span><span className="kbd-hint">{modShift}F</span></button>
              <button className={panel === 'projects' ? 'on' : ''} onClick={() => setPanel('projects')} title={T('sidebar.projects')}><Icon name="Folder" size={15} /><span className="label">{T('sidebar.projects')}</span>{projects.length > 0 && <span className="count">{projects.length}</span>}</button>
              <button className={panel === 'artifacts' ? 'on' : ''} onClick={() => setPanel('artifacts')} title={T('sidebar.artifacts')}><Icon name="Artifacts" size={15} /><span className="label">{T('sidebar.artifacts')}</span>{artifacts.length > 0 && <span className="count">{artifacts.length}</span>}</button>
              <button className={panel === 'scheduled' ? 'on' : ''} onClick={() => setPanel('scheduled')} title="Automations & Scheduled Tasks"><Icon name="Clock" size={15} /><span className="label">Automations</span></button>
              <div className="sidenav-dock">
                <button
                  className={(panel === 'chats' ? sessionPane.type === 'files' : panel === 'code') ? 'on' : ''}
                  onClick={() => (panel === 'chats' ? toggleSessionPane('files') : setPanel('code'))}
                  title="Code & Files"
                >
                  <Icon name="Code" size={14} /><span className="label">{T('sidebar.code')}</span>
                </button>
                <button
                  className={(panel === 'chats' ? sessionPane.type === 'terminal' : panel === 'terminal') ? 'on' : ''}
                  onClick={() => (panel === 'chats' ? toggleSessionPane('terminal') : setPanel('terminal'))}
                  title={T('sidebar.terminal')}
                >
                  <Icon name="CommandLine" size={14} /><span className="label">{T('sidebar.terminal')}</span>
                </button>
                <button
                  className={sessionPane.type === 'browser' ? 'on' : ''}
                  onClick={() => toggleSessionPane('browser')}
                  title={T('sidebar.browser')}
                >
                  <Icon name="Globe" size={14} /><span className="label">{T('sidebar.browser')}</span>
                </button>
              </div>
            </nav>
          </div>

          <div className="sidebar-recents">
            <div className="section-label recents-head">
              <span>{T('sidebar.recents')}</span>
              {convs.length > 0 && <span className="recents-count">{convs.length}</span>}
            </div>
            <div className="convlist">
              {[...convs].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)).map((c) => (
                <div key={c.id} className={'conv ' + (c.id === activeId && panel === 'chats' ? 'on' : '')} onClick={() => selectConv(c.id)}>
                  {c.pinned && <span className="conv-pin" title="Pinned"><Icon name="Pin" size={12} /></span>}
                  <Icon name="Chat" size={15} className="conv-ico" />
                  <div className="conv-title">{c.title || 'Untitled'}</div>
                  {waitingPermissionConvIds.has(c.id) && (
                    <span className="conv-perm-bell" title="Waiting for permission approval">
                      <Icon name="Notification" size={12} />
                    </span>
                  )}
                  <button className="conv-del" onClick={(e) => { e.stopPropagation(); deleteConv(c.id); }}><Icon name="Trash" size={13} /></button>
                </div>
              ))}
              {convs.length === 0 && <div className="muted">No conversations yet</div>}
            </div>
          </div>

          <div className="sidebar-bottom">
            <button
              type="button"
              className="sidebar-custom-btn"
              onClick={() => openSettingsAt('skills')}
              title="Open Customizations in Settings (Skills, Plugins, MCP Connectors, Memory & Notebooks)"
            >
              <Icon name="Lightbulb" size={15} />
              <span className="label">Customizations</span>
              <span className="custom-meta">Skills · MCP</span>
            </button>
            <button
              type="button"
              className="sidebar-settings-btn"
              onClick={() => openSettingsAt('providers')}
              title={T('sidebar.settings')}
            >
              <Icon name="Settings" size={15} />
              <span className="label">{T('sidebar.settings')}</span>
              <span className="custom-meta">{(provider && provider.model) || 'auto'}</span>
            </button>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="main-split">
            <div className="main-content">
              {panel === 'chats' && <ChatView messages={messages} live={liveForActive} thinking={liveForActive ? thinking : ''} paused={paused} onScrollAway={setScrolledAway} subAgents={effectiveSubAgents} swarmInfo={effectiveSwarmInfo} swarmBoard={effectiveSwarmBoard} planMode={planMode} copyBlock={copyBlock} applyBlock={applyBlock} bottomRef={bottomRef} convId={activeId} cwd={cwd} copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage} forkFromMessage={forkFromMessage} shareFromMessage={shareFromMessage} conv={active} exportConv={exportConv} T={T} runStartedAt={runStartedAt} envOpen={sessionPane.type === 'env'} onToggleEnv={() => toggleSessionPane('env')} runLogOpen={sessionPane.type === 'runlog'} onToggleRunLog={() => showSessionPane('runlog')} reviewOpen={sessionPane.type === 'review'} sessionPaneType={sessionPane.type} onOpenReview={openReview} onTogglePane={(tp) => (tp ? showSessionPane(tp) : toggleSessionPane())} onOpenPlugins={() => openSettingsAt('skills')} onRenameConv={(title) => active && renameConv(active.id, title)} onPinConv={() => active && pinConv(active.id)} onArchiveConv={() => active && archiveConv(active.id)} onSplitConv={() => (active ? splitConv(active.id) : openReview({ scope: 'all' }))} onDeleteConv={() => active && deleteConv(active.id)} setError={setError} />}
              {panel === 'search' && <SearchView convs={convs} cwd={cwd} onOpenConv={(convId, msgId) => { setActiveId(convId); setPanel('chats'); if (msgId) setPendingScroll(msgId); }} />}
              {panel === 'artifacts' && <ArtifactsView blocks={artifacts} />}
              {panel === 'memory' && <MemoryView memory={memory} addMemory={addMemory} clearMemory={clearMemory} />}
              {panel === 'skills' && <SkillsView skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills} />}
              {panel === 'notebooks' && <NotebooksView notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells} openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook} />}
              {panel === 'mcp' && <McpView mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp} />}
              {panel === 'terminal' && <TerminalView terminal={terminal} setTerminal={setTerminal} startTerminal={startTerminal} runInTerminal={runInTerminal} writeTerminal={writeTerminal} killTerminal={killTerminal} />}
              {panel === 'code' && <CodeView cwd={cwd} setCwd={setCwd} permissions={permissions} setPermissions={setPermissions} T={T} />}
              {panel === 'projects' && <ProjectsView projects={projects} setProjects={setProjects} activeProject={activeProject} setActiveProject={setActiveProject} />}
              {panel === 'plugins' && <PluginsView onOpenGdrive={() => setGdriveModalOpen(true)} gdriveState={gdriveState} />}
              {panel === 'scheduled' && <ScheduledView />}
            </div>

            {sessionPane.type === 'browser' && (
              <SessionPane {...paneProps} icon="Globe" title={T('sidebar.browser')}>
                <BrowserView
                  cwd={cwd}
                  previewUrl={previewUrl}
                  onClose={() => setSessionPane((p) => ({ ...p, type: null }))}
                  onAttachInspect={(items) => {
                    if (!items || !items.length) return;
                    setAttachments((a) => [...a, ...items]);
                    setNotice('Inspected element attached to composer');
                    setTimeout(() => { try { inputRef.current && inputRef.current.focus(); } catch (_) {} }, 50);
                  }}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'env' && (
              <SessionPane {...paneProps} icon="DotsHorizontal" title="Environment">
                <EnvPanel
                  cwd={cwd} setCwd={setCwd} provider={provider} lastUsage={lastUsage}
                  mcpServers={mcpServers} features={features} saveFeat={saveFeat}
                  runSlashCommand={runSlashCommand}
                  onOpenConnectors={() => openSettingsAt('mcp')}
                  T={T}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'runlog' && (
              <SessionPane {...paneProps} icon="Activity" title="Background Tasks">
                <RunLogPanel convId={activeId} />
              </SessionPane>
            )}
            {sessionPane.type === 'review' && (
              <SessionPane {...paneProps} icon="File" title="Review">
                <CodeReviewPane
                  convId={activeId}
                  cwd={cwd}
                  target={reviewTarget}
                  allTools={allActiveTools}
                  provider={provider}
                  orchestrator={orchestrator}
                  onSendComment={(txt) => send(txt)}
                  onRewindDone={(r) => setError(`✅ Rewound: restored ${(r && r.restored) || 0}, removed ${(r && r.removed) || 0}.`)}
                  onClose={() => closeSessionTab('review')}
                  voiceOpts={{ engine: settings.voiceEngine || 'auto', lang: settings.voiceLang || 'en-US' }}
                  Icon={Icon}
                />
              </SessionPane>
            )}
            {sessionPane.type === 'subagents' && (
              <SessionPane {...paneProps} icon="GitBranch" title="Subagents">
                <SubagentsPane subAgents={effectiveSubAgents} swarmInfo={effectiveSwarmInfo} swarmBoard={effectiveSwarmBoard} />
              </SessionPane>
            )}
            {sessionPane.type === 'files' && (
              <SessionPane {...paneProps} icon="Files" title="Files">
                <CodeView cwd={cwd} setCwd={setCwd} permissions={permissions} setPermissions={setPermissions} T={T} />
              </SessionPane>
            )}
            {sessionPane.type === 'terminal' && (
              <SessionPane {...paneProps} icon="CommandLine" title="Terminal">
                <TerminalView terminal={terminal} setTerminal={setTerminal} startTerminal={startTerminal} runInTerminal={runInTerminal} writeTerminal={writeTerminal} killTerminal={killTerminal} />
              </SessionPane>
            )}
            {sessionPane.type === 'mindmap' && (
              <SessionPane {...paneProps} icon="Grid" title="Mind Map">
                <MindMapView cwd={cwd} theme={settings.theme === 'light' ? 'light' : 'dark'} onClose={() => closeSessionTab('mindmap')} />
              </SessionPane>
            )}
          </div>

          {error && (
            <div className={'errorbar' + (String(error).startsWith('✅') ? ' ok' : '') + (showSettings || gdriveModalOpen ? ' floating-modal-toast' : '')}>
              <span className="errorbar-text">{error}</span>
              <button type="button" className="errorbar-x" title="Dismiss" aria-label="Dismiss" onClick={() => setError('')}><Icon name="X" size={12} /></button>
            </div>
          )}

          {streaming && scrolledAway && (
            <StickyLiveToolBar
              live={liveForActive}
              thinking={thinking}
              startedAt={runStartedAt}
              paused={paused}
              onJumpToLive={() => bottomRef.current?.scrollIntoView({ behavior: 'smooth' })}
              Icon={Icon}
            />
          )}

          {streaming && paused && (
            <div className="paused-banner" role="status">
              <div className="paused-banner-left">
                <span className="paused-banner-dot" aria-hidden="true" />
                <span>Paused — Resume or type a steering note</span>
              </div>
              <button type="button" className="paused-resume-btn" onClick={() => resumeRun('')}>
                <Icon name="Play" size={12} /> Resume
              </button>
            </div>
          )}

          <PermissionDock
            queue={permissionQueue.filter((p) => !p.convId || p.convId === activeId)}
            onRespond={answerPermission}
            errorMsg={permError}
            submitting={permSubmitting}
          />

          <InputBar
            streaming={streaming} paused={paused} onPause={pauseRun} onResume={resumeRun} send={send} stop={stop} inputRef={inputRef} cwd={cwd} setCwd={setCwd} runSlashCommand={runSlashCommand}
            queued={filterQueueForConv(queued, activeId)}
            queuePaused={!!(activeId && queuePausedByConv[activeId])}
            onToggleQueuePaused={() => toggleQueuePaused(activeId)}
            onClearQueue={() => clearQueuedForConv(activeId)}
            onToggleQueueItemPaused={toggleQueueItemPaused}
            onReorderQueue={reorderQueued}
            onStepQueueItem={stepQueued}
            onUpdateQueueItemText={updateQueuedText}
            unqueue={unqueue} sendQueuedNow={sendQueuedNow}
            settings={settings} onVoiceError={setError}
            provider={provider} setProvider={setProvider} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} openSettings={(opts) => { setPendingPreset(opts && opts.preset ? opts.preset : null); openSettingsAt('providers'); }}
            providerKeys={providerKeys} setProviderKeys={setProviderKeys}
            attachments={attachments} setAttachments={setAttachments}
            reasoningLevel={reasoningLevel} setReasoningLevel={setReasoningLevel}
            swarmEnabled={swarmEnabled} setSwarmEnabled={setSwarmEnabled}
            styleId={styleId} setStyleId={setStyleId}
            webSearch={webSearch} setWebSearch={setWebSearch}
            dictating={dictating} setDictating={setDictating}
            voiceMode={voiceMode} startVoiceMode={startVoiceMode} stopVoiceMode={stopVoiceMode}
            sessionPane={sessionPane} toggleSessionPane={toggleSessionPane}
            permissions={permissions} setPermissions={setPermissions}
            lastUsage={lastUsage}
            gdriveState={gdriveState}
            onOpenGdrive={() => setGdriveModalOpen(true)}
            envState={envState}
            onSwitchEnvironment={switchEnvironment}
            onOpenEnvironments={() => openSettingsAt('environments')}
            T={T}
          />
        </main>
      </div>
      )}

      {showSettings && (
        <SettingsModal
          provider={provider} setProvider={setProvider} providerKeys={providerKeys} setProviderKeys={setProviderKeys}
          settings={settings} setSettings={setSettings} orchestrator={orchestrator} setOrchestrator={setOrchestrator}
          features={features} setFeatures={setFeatures} testProvider={testProvider}
          onClose={() => { setShowSettings(false); setPendingPreset(null); }}
          T={T} permissions={permissions} setPermissions={setPermissions}
          compliance={compliance} setCompliance={setCompliance}
          pendingPreset={pendingPreset} clearPendingPreset={() => setPendingPreset(null)}
          initialSection={settingsInitialSection}
          skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills}
          mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp}
          memory={memory} addMemory={addMemory} clearMemory={clearMemory}
          notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells}
          openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook}
          cwd={cwd} setCwd={setCwd} activeId={activeId}
          onOpenGdrive={() => setGdriveModalOpen(true)}
          gdriveState={gdriveState}
          envState={envState}
          refreshEnvState={refreshEnvState}
          onSwitchEnvironment={switchEnvironment}
          setError={setError}
          setNotice={setNotice}
        />
      )}

      {gdriveModalOpen && (
        <GoogleDriveModal
          gdriveState={gdriveState}
          onRefreshStatus={refreshGdriveStatus}
          onAttachFiles={(atts) => setAttachments((a) => [...a, ...atts])}
          onClose={() => setGdriveModalOpen(false)}
        />
      )}

      {question && (
        <QuestionModal question={question} answer={answerQuestion} />
      )}

      {cuConsent && (
        <ComputerUseModal consent={cuConsent} answer={answerCuConsent} />
      )}


      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewChat={newChat}
          onSearch={() => { setShowPalette(false); setPanel('search'); }}
          onToggleBrowser={() => { setShowPalette(false); toggleSessionPane('browser'); }}
          onToggleCode={() => { setShowPalette(false); setPanel('code'); }}
          onSettings={() => { setShowPalette(false); setShowSettings(true); }}
          onQuickEntry={() => { setShowPalette(false); window.autobot.openQuickEntry(); }}
          onAbout={() => { setShowPalette(false); window.autobot.openAbout(); }}
          onExport={() => { setShowPalette(false); if (active) exportConv(active); }}
          onToggleSidebar={() => { setShowPalette(false); setSidebarCollapsed((v) => !v); }}
          onToggleTheme={() => { setShowPalette(false); setSettings((s) => ({ ...s, theme: s.theme === 'dark' ? 'light' : 'dark' })); }}
        />
      )}

      {showFind && (
        <FindBar query={findQuery} setQuery={setFindQuery} messages={messages} onClose={() => { setShowFind(false); setFindQuery(''); }} />
      )}

      <ContextLimitToast
        lastUsage={lastUsage}
        model={(lastUsage && lastUsage.model) || (provider && provider.model) || ''}
        T={T}
      />
    </div>
  );
}

function uid() { return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Re-render on a timer while a run is active so elapsed time / spinners stay live.
function useTicker(active, ms = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

function shortPath(p) {
  p = String(p || '').replace(/\\/g, '/');
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// Turn a raw tool call into the human line Example shows ("Writing index.html").
function describeTool(name, args) {
  const a = args || {};
  const base = (p) => String(p || '').replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
  const pick = a.command || a.cmd || a.script || '';
  const firstLine = String(pick).split('\n')[0].trim();
  switch (String(name || '')) {
    case 'Bash': return { verb: 'Running', target: firstLine.slice(0, 90), icon: 'Play' };
    case 'Write': return { verb: 'Writing', target: shortPath(a.path || a.file_path || a.filename), icon: 'File' };
    case 'Edit': case 'MultiEdit': case 'StrReplace': return { verb: 'Editing', target: shortPath(a.path || a.file_path || a.filename), icon: 'Settings' };
    case 'Read': case 'ReadFile': return { verb: 'Reading', target: shortPath(a.path || a.file_path), icon: 'Eye' };
    case 'Glob': return { verb: 'Finding files', target: String(a.pattern || a.glob || '').slice(0, 60), icon: 'Search' };
    case 'Grep': case 'Search': return { verb: 'Searching', target: String(a.pattern || a.query || '').slice(0, 60), icon: 'Search' };
    case 'WebFetch': case 'WebSearch': case 'browser_open': case 'browser_navigate': return { verb: 'Browsing', target: String(a.url || a.query || '').slice(0, 70), icon: 'Globe' };
    case 'TodoWrite': {
      const todos = a.todos || [];
      const done = todos.filter((t) => (t && t.status) === 'completed').length;
      return { verb: 'Updating plan', target: todos.length ? `${done}/${todos.length} done` : '', icon: 'Check' };
    }
    case 'Artifact': return { verb: 'Creating', target: a.name || a.language || 'artifact', icon: 'Sparkles' };
    case 'Task': case 'Agent': return { verb: 'Delegating', target: String(a.description || a.prompt || '').slice(0, 60), icon: 'Sparkles' };
    case 'Swarm': return { verb: 'Orchestrating swarm', target: String(a.goal || a.objective || '').slice(0, 70), icon: 'AgentsSimple' };
    case 'rea': return { verb: 'Reverse engineering', target: String(a.tool || a.query || a.action || '').slice(0, 70), icon: 'Orbit' };
    case 'AskUser': case 'exitPlanMode': return { verb: 'Waiting on you', target: '', icon: 'Clock' };
    default: {
      const nStr = String(name || '');
      if (nStr.startsWith('mcp__rea__')) {
        return { verb: 'REA · ' + nStr.replace(/^mcp__rea__/, ''), target: shortPath(a.path || a.binary_path || a.target || a.query || ''), icon: 'Orbit' };
      }
      return { verb: String(name || 'Working'), target: base(a.path || a.file_path || ''), icon: 'Wrench' };
    }
  }
}

// One-line "what the agent is doing right now" banner above the reply.
function RunActivity({ live, thinking, startedAt }) {
  const now = useTicker(Boolean(live), 500);
  const tools = (live && live.tools) || [];
  const segments = (live && live.segments) || [];
  const running = tools.find((t) => t.status === 'running');
  const stTool = live && live.streamingTool;
  // Plan/approval tools are bookkeeping — the banner says "Working 5 steps"
  // forever if we let TodoWrite win. Prefer real work, then the current phase.
  const work = tools.filter((t) => t.name !== 'TodoWrite' && t.name !== 'exitPlanMode');
  const last = running || work[work.length - 1] || null;
  const lastSeg = segments[segments.length - 1];
  let label = 'Thinking';
  let target = '';
  if (running) {
    const d = describeTool(running.name, running.args);
    const verb = (d && d.verb) ? d.verb : (running.name || 'Working');
    label = verb + '…';
    target = (d && d.target) || '';
  } else if (stTool && stTool.name) {
    const d = describeTool(stTool.name, stTool.target ? { path: stTool.target, file_path: stTool.target, query: stTool.target, tool: stTool.target, goal: stTool.target, command: stTool.target } : {});
    const kb = stTool.bytes >= 1024 ? (stTool.bytes / 1024).toFixed(1) + ' KB' : (stTool.bytes ? stTool.bytes + ' B' : '');
    const verb = (d && d.verb) ? d.verb : (stTool.name || 'Working');
    label = verb + '…';
    target = [stTool.target || (d && d.target), kb].filter(Boolean).join(' · ');
  } else if (lastSeg && lastSeg.type === 'text' && live && live.content) {
    label = 'Writing…';
  } else if (last) {
    const d = describeTool(last.name, last.args);
    label = 'Working…';
    target = d.target;
  } else if (thinking) {
    label = 'Thinking…';
    target = String(thinking).replace(/\s+/g, ' ').trim().slice(0, 80);
  } else {
    label = 'Thinking…';
  }
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  return (
    <div className="activity" role="status" aria-live="polite">
      <span className="activity-spin"><Logo size={15} active /></span>
      <span className="activity-text">{label}</span>
      {target ? <span className="activity-target">{target}</span> : null}
      {elapsed ? <span className="activity-time">{fmtElapsed(elapsed)}</span> : null}
    </div>
  );
}

function timeGreeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

// Akron Code brand mark — emerald symbiote sunburst (user-supplied artwork,
// build/logo-mark.svg). Below ~30 px the full 12-ray mark plus its orbiting
// tendrils collapses into mush, so small surfaces (titlebar, avatars, list
// rows) get a compact 8-ray cut that keeps the same silhouette.
const MARK = '#10B981';
const MARK_GLOW = '#A7F3D0';
const COMPACT_RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

function CompactMark({ size, active }) {
  return (
    <svg className={'logo' + (active ? ' logo-live' : '')} width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Akron Code">
      <g fill={MARK} className="logo-rays">
        <circle cx="50" cy="50" r="17" className="logo-core" />
        {COMPACT_RAYS.map((deg) => (
          <rect key={deg} x="43.5" y="5" width="13" height="31" rx="6.5" transform={`rotate(${deg} 50 50)`} />
        ))}
      </g>
      <circle className="logo-core" cx="50" cy="50" r="7.5" fill={MARK_GLOW} opacity="0.55" />
    </svg>
  );
}

// Full mark: 12 radial rays in two counter-breathing groups, a pulsing core and
// six orbiting tendril circles, all through a gooey filter (the "symbiote"
// look). Animation is CSS/SMIL inside the SVG and honours reduced-motion.
function FullMark({ size, active }) {
  const raysA = [
    [191, 76, 18, 96, 9, 0], [192, 88, 16, 84, 8, 32], [190, 72, 20, 102, 10, 64],
    [192, 92, 16, 80, 8, 95], [191, 74, 18, 98, 9, 128], [192, 86, 16, 86, 8, 158],
  ];
  const raysB = [
    [190, 75, 20, 98, 10, 188], [192, 90, 16, 82, 8, 218], [191, 70, 18, 104, 9, 248],
    [192, 88, 16, 84, 8, 278], [190, 76, 20, 96, 10, 306], [192, 92, 16, 80, 8, 334],
  ];
  const glowSpokes = [[0, 96, 58], [64, 94, 62], [128, 96, 58], [188, 94, 62], [248, 92, 64], [306, 96, 58]];
  return (
    <svg className={'logo' + (active ? ' logo-live' : '')} width={size} height={size} viewBox="0 0 400 400" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Akron Code">
      <defs>
        <filter id="akGooMark" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
          <feColorMatrix in="blur" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 22 -9" result="goo" />
          <feComposite in="SourceGraphic" in2="goo" operator="atop" />
        </filter>
        <style>{`
          .ak-core-spin { transform-origin: 200px 200px; animation: akSlowPulseSpin 12s ease-in-out infinite; }
          .ak-orbit-1 { transform-origin: 200px 200px; animation: akOrbitCw 7s linear infinite; }
          .ak-orbit-2 { transform-origin: 200px 200px; animation: akOrbitCcw 9s linear infinite; }
          .ak-ray-a { transform-origin: 200px 200px; animation: akBreathe 3.2s ease-in-out infinite alternate; }
          .ak-ray-b { transform-origin: 200px 200px; animation: akBreathe 2.6s ease-in-out infinite alternate-reverse; }
          @keyframes akSlowPulseSpin { 0% { transform: rotate(0deg) scale(0.97); } 50% { transform: rotate(180deg) scale(1.04); } 100% { transform: rotate(360deg) scale(0.97); } }
          @keyframes akOrbitCw { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
          @keyframes akOrbitCcw { 0% { transform: rotate(360deg); } 100% { transform: rotate(0deg); } }
          @keyframes akBreathe { 0% { transform: scale(0.92); } 100% { transform: scale(1.09); } }
          @media (prefers-reduced-motion: reduce) { .ak-core-spin, .ak-orbit-1, .ak-orbit-2, .ak-ray-a, .ak-ray-b { animation: none; } }
        `}</style>
      </defs>
      <g filter="url(#akGooMark)">
        <g fill={MARK}>
          <circle cx="200" cy="200" r="34">
            <animate attributeName="r" values="30;38;29;35;30" dur="3.5s" repeatCount="indefinite" />
          </circle>
          <g className="ak-core-spin">
            <g className="ak-ray-a">
              {raysA.map(([x, y, w, h, rx, deg]) => (
                <rect key={deg} x={x} y={y} width={w} height={h} rx={rx} transform={`rotate(${deg} 200 200)`} />
              ))}
            </g>
            <g className="ak-ray-b">
              {raysB.map(([x, y, w, h, rx, deg]) => (
                <rect key={deg} x={x} y={y} width={w} height={h} rx={rx} transform={`rotate(${deg} 200 200)`} />
              ))}
            </g>
          </g>
          <g className="ak-orbit-1">
            <circle cx="200" cy="84" r="13">
              <animate attributeName="cy" values="84;62;92;74;84" dur="2.8s" repeatCount="indefinite" />
              <animate attributeName="r" values="13;8;15;10;13" dur="2.8s" repeatCount="indefinite" />
            </circle>
            <circle cx="304" cy="245" r="12">
              <animate attributeName="cx" values="304;326;294;316;304" dur="3.4s" repeatCount="indefinite" />
              <animate attributeName="r" values="12;7;14;9;12" dur="3.4s" repeatCount="indefinite" />
            </circle>
            <circle cx="102" cy="252" r="11">
              <animate attributeName="cx" values="102;78;112;88;102" dur="3.1s" repeatCount="indefinite" />
              <animate attributeName="r" values="11;6;13;8;11" dur="3.1s" repeatCount="indefinite" />
            </circle>
          </g>
          <g className="ak-orbit-2">
            <circle cx="278" cy="112" r="10">
              <animate attributeName="cy" values="112;88;122;98;112" dur="2.5s" repeatCount="indefinite" />
              <animate attributeName="r" values="10;5;12;7;10" dur="2.5s" repeatCount="indefinite" />
            </circle>
            <circle cx="118" cy="118" r="12">
              <animate attributeName="cy" values="118;92;128;104;118" dur="3.6s" repeatCount="indefinite" />
              <animate attributeName="r" values="12;7;14;9;12" dur="3.6s" repeatCount="indefinite" />
            </circle>
            <circle cx="200" cy="316" r="13">
              <animate attributeName="cy" values="316;342;306;330;316" dur="2.9s" repeatCount="indefinite" />
              <animate attributeName="r" values="13;7;15;9;13" dur="2.9s" repeatCount="indefinite" />
            </circle>
          </g>
        </g>
      </g>
      <g className="ak-core-spin" opacity="0.55" fill={MARK_GLOW}>
        <circle cx="200" cy="200" r="14">
          <animate attributeName="r" values="12;17;11;15;12" dur="3.5s" repeatCount="indefinite" />
        </circle>
        {glowSpokes.map(([deg, y, h]) => (
          <rect key={deg} x="197" y={y} width="6" height={h} rx="3" transform={`rotate(${deg} 200 200)`} />
        ))}
      </g>
    </svg>
  );
}

function Logo({ size = 20, active = false }) {
  return size < 30 ? <CompactMark size={size} active={active} /> : <FullMark size={size} active={active} />;
}

// ---------- Conversation export / share ----------
// Claude Desktop's "Share chat" publishes a public link; Akron Code has no backend, so
// the local equivalent is a self-contained HTML share file (open in any browser, no
// server) plus Markdown/JSON export. All three route through the renderer and land in
// a native save dialog via `autobot:saveFile`.
function convToMarkdown(conv) {
  const title = conv.title || 'Untitled conversation';
  const lines = ['# ' + title, ''];
  const ts = new Date(conv.ts || Date.now()).toISOString();
  lines.push('> Exported from Akron Code — ' + ts, '');
  for (const m of conv.messages || []) {
    const who = m.role === 'user' ? '**You**' : '**Akron Code**';
    lines.push('## ' + who, '');
    if (m.content) lines.push(m.content, '');
    for (const a of m.attachments || []) {
      if (a.isImage && a.dataUrl) lines.push('![image](' + a.dataUrl + ')', '');
      else lines.push('📎 ' + (a.name || 'file') + (a.size ? ' (' + fmtSize(a.size) + ')' : ''), '');
    }
    lines.push('');
  }
  return lines.join('\n');
}

function convToHtml(conv) {
  const title = escapeHtml(conv.title || 'Untitled conversation');
  const ts = new Date(conv.ts || Date.now()).toISOString();
  const body = (conv.messages || []).map((m) => {
    const role = m.role === 'user' ? 'You' : 'Akron Code';
    let html = '<div class="msg ' + m.role + '"><div class="role">' + role + '</div>';
    if (m.content) html += '<div class="content">' + renderMarkdown(m.content) + '</div>';
    for (const a of m.attachments || []) {
      if (a.isImage && a.dataUrl) html += '<img class="att" src="' + escapeHtml(a.dataUrl) + '" alt="' + escapeHtml(a.name || '') + '"/>';
      else html += '<div class="att">📎 ' + escapeHtml(a.name || 'file') + (a.size ? ' (' + fmtSize(a.size) + ')' : '') + '</div>';
    }
    return html + '</div>';
  }).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:820px;margin:0 auto;padding:32px 20px;background:#f7f7f5;color:#1a1a1a;line-height:1.6}
h1{font-size:22px;margin:0 0 4px} .meta{color:#888;font-size:12px;margin-bottom:24px}
.msg{background:#fff;border:1px solid #e5e5e0;border-radius:10px;padding:14px 16px;margin:12px 0}
.msg.assistant{background:#fbfbf9} .role{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#059669;margin-bottom:8px}
.msg.user .role{color:#0b5fff} .content pre{background:#f0f0ee;padding:12px;border-radius:8px;overflow:auto}
.content img{max-width:100%} .att{color:#666;font-size:13px;margin-top:6px} img.att{max-width:100%;border-radius:8px;margin-top:8px}
</style></head><body><h1>${title}</h1><div class="meta">Exported from Akron Code — ${ts}</div>${body}</body></html>`;
}

// ---------- Environment panel (the ··· pane) ----------
// Example's right-hand pane answers three questions in one place: which machine
// and folder the agent is working in, how much of the context window is spent,
// and which connectors are attached. It is a view over state that already
// exists — nothing here invents a number.
function ContextMeter({ used, win, size = 44 }) {
  const pct = win > 0 ? Math.max(0, Math.min(100, (used / win) * 100)) : 0;
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const dash = (pct / 100) * c;
  const tone = pct >= 90 ? 'hot' : pct >= 70 ? 'warm' : 'cool';
  return (
    <span className={'ctx-meter ' + tone} title={fmtInt(used) + ' of ' + fmtInt(win) + ' tokens used'}>
      <svg width={size} height={size} viewBox={'0 0 ' + size + ' ' + size}>
        <circle className="ctx-track" cx={size / 2} cy={size / 2} r={r} strokeWidth="3" fill="none" />
        <circle
          className="ctx-arc" cx={size / 2} cy={size / 2} r={r} strokeWidth="3" fill="none"
          strokeDasharray={dash + ' ' + c} strokeDashoffset="0"
          transform={'rotate(-90 ' + size / 2 + ' ' + size / 2 + ')'}
        />
      </svg>
      <span className="ctx-pct">{Math.round(pct)}%</span>
    </span>
  );
}

// ---------- context pressure toast ----------
// The ring in the composer/Environment pane is easy to miss while typing, and
// running out of context mid-turn is the one failure a user cannot retry away.
// This is a small fixed toast at the bottom of the window that appears once the
// last turn's *context* size crosses the warm threshold, for every provider
// (the window comes from the model in the usage record, not from a hardcoded
// table). It never prints provider token-limit wording: it reports pressure and
// offers the same action the Environment pane does.
function ContextLimitToast({ lastUsage, model, T }) {
  const win = contextWindowFor(model);
  const used = usedTokens(lastUsage);
  // Dismissal is keyed to the tone, so hiding the 70 % warning does not
  // suppress the 90 % one — and a fresh conversation starts clean. The rule
  // lives in ./ctx-toast.mjs so it can be tested without a DOM.
  const [closedTone, setClosedTone] = useState(null);
  const [closedAt, setClosedAt] = useState(0);
  const seenAt = Number(lastUsage && lastUsage.at) || 0;
  const { tone, pct, visible } = ctxToastState({ used, win, closedTone, closedAt, seenAt });
  // Sit *above* the composer, never on top of it. The message box grows with
  // every line typed, so the offset is measured, not guessed: a fixed 18px
  // toast covered the bottom of the input on this very screen.
  const [lift, setLift] = useState(0);
  useEffect(() => {
    if (!visible) return;
    const measure = () => {
      const box = document.querySelector('.composer');
      if (!box) { setLift(0); return; }
      const r = box.getBoundingClientRect();
      // Distance from the composer's top edge to the bottom of the window,
      // plus a 10px breather. 0 when the composer is not laid out yet.
      const next = Math.max(0, Math.round(window.innerHeight - r.top) + 10);
      setLift((cur) => (cur === next ? cur : next));
    };
    measure();
    window.addEventListener('resize', measure);
    const box = document.querySelector('.composer');
    const ro = box && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro) ro.observe(box);
    return () => {
      window.removeEventListener('resize', measure);
      if (ro) ro.disconnect();
    };
  }, [visible]);
  if (!visible) return null;
  const label = String(model || '').split('/').pop();
  return (
    <div className={'ctx-toast ' + tone} role="status" aria-live="polite" style={lift ? { bottom: lift } : undefined}>
      <span className="ctx-toast-ico"><Icon name={tone === 'hot' ? 'Warning' : 'Info'} size={15} /></span>
      <div className="ctx-toast-main">
        <div className="ctx-toast-title">
          {tone === 'hot'
            ? (T('ctx.hot') || 'Almost out of room in this conversation')
            : (T('ctx.warm') || 'This conversation is getting long')}
        </div>
        <div className="ctx-toast-sub">
          {pct}% of the window used{label ? ' · ' + label : ''}
        </div>
      </div>
      <button
        type="button"
        className="ctx-toast-x"
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => { setClosedTone(tone); setClosedAt(seenAt); }}
      ><Icon name="X" size={12} /></button>
    </div>
  );
}

function EnvPanel({ cwd, setCwd, provider, lastUsage, mcpServers, features, saveFeat, runSlashCommand, onOpenConnectors, T }) {
  const model = (provider && provider.model) || '';
  // The meter measures the turn that just ran, so prefer the model recorded
  // in the usage event over whatever is selected now.
  const win = contextWindowFor((lastUsage && lastUsage.model) || model);
  const used = usedTokens(lastUsage);
  const pct = win > 0 ? Math.round((used / win) * 100) : 0;
  const connected = mcpServers || [];
  const toolCount = connected.reduce((n, s) => n + ((s.tools && s.tools.length) || 0), 0);
  // A server that answered but exposed no tools is the honest "needs
  // reconnecting" signal — we never show a fabricated pending count.
  const idle = connected.filter((s) => !s.tools || s.tools.length === 0);
  const folderName = String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean).pop() || '~';
  const chooseFolder = async () => {
    const d = await window.autobot.pickFolder();
    if (!d) return;
    setCwd(d);
    try {
      const id = loadJSON('autobot:activeId', null);
      if (id) window.autobot.setWorkspace(id, d).catch(() => {});
    } catch (_) { /* workspace sync is best-effort */ }
  };
  return (
    <div className="envpanel">
      <section className="env-sec">
        <div className="env-sec-title">This computer</div>
        <div className="env-card">
          <span className="env-ico"><Icon name="Laptop" size={16} /></span>
          <div className="env-card-main">
            <div className="env-card-title">This computer</div>
            <div className="env-card-sub" title={cwd || '~'}>{folderName}{cwd ? ' · ' + cwd : ''}</div>
          </div>
        </div>
        <button type="button" className="env-action" onClick={chooseFolder}>
          <Icon name="Folder" size={14} /> Choose folder…
        </button>
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Remote Control</div>
        <button
          type="button"
          className={'env-toggle' + (features && features.remoteControl ? ' on' : '')}
          onClick={() => saveFeat({ ...features, remoteControl: !(features && features.remoteControl) })}
          aria-pressed={!!(features && features.remoteControl)}
        >
          <span className="env-toggle-track"><span className="env-toggle-knob" /></span>
          <span className="env-toggle-label">
            {features && features.remoteControl ? 'On — this machine can be driven remotely' : 'Off — local control only'}
          </span>
        </button>
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Context</div>
        <div className="env-card">
          <ContextMeter used={used} win={win} size={46} />
          <div className="env-card-main">
            <div className="env-card-title">{pct}% used</div>
            <div className="env-card-sub">{fmtInt(used)} / {fmtInt(win)} tokens · {model ? model.split('/').pop() : 'no model'}</div>
          </div>
        </div>
        <div className="env-meter"><span className={'env-meter-fill' + (pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : '')} style={{ width: Math.max(1, Math.min(100, pct)) + '%' }} /></div>
        <div className="env-row">
          <button type="button" className="env-action" onClick={() => runSlashCommand('compact')}>
            <Icon name="Frame" size={14} /> Compact now
          </button>
          <button type="button" className="env-action" onClick={() => runSlashCommand('context')}>
            <Icon name="Activity" size={14} /> What is loaded
          </button>
        </div>
      </section>

      <section className="env-sec">
        <div className="env-sec-title">Connectors</div>
        {connected.length === 0 && (
          <div className="env-empty">No connectors attached. Add an MCP server to give the agent more tools.</div>
        )}
        {connected.length > 0 && (
          <div className="env-card-sub env-summary">
            {connected.length} connected · {toolCount} tools{idle.length ? ' · ' + idle.length + ' need attention' : ''}
          </div>
        )}
        {connected.map((s) => (
          <div key={s.serverId} className={'env-conn' + (s.tools && s.tools.length ? '' : ' idle')}>
            <span className="env-conn-dot" />
            <span className="env-conn-name" title={s.url || s.name}>{s.name}</span>
            <span className="env-conn-meta">{(s.tools && s.tools.length) || 0}</span>
          </div>
        ))}
        <button type="button" className="env-action" onClick={onOpenConnectors}>
          <Icon name="Connectors" size={14} /> Manage connectors
        </button>
      </section>

      <section className="env-sec env-sec-last">
        <div className="env-sec-title">Session</div>
        <div className="env-card-sub env-summary">
          {provider ? (provider.label || provider.id || 'provider') : 'no provider'} · tools {provider && provider.supportsTools === false ? 'via text protocol' : 'native'}
        </div>
      </section>
    </div>
  );
}

// ---------- Mission Control (Swarm + Multi-agent dashboard) ----------
const MC_PHASES = [
  { id: 'planning', label: 'Plan' },
  { id: 'dispatch', label: 'Dispatch' },
  { id: 'wakeup', label: 'Coordinate' },
  { id: 'review', label: 'Review' },
  { id: 'done', label: 'Done' },
];

function renderBoardText(text) {
  const s = String(text || '');
  const parts = s.split(/(@[a-z0-9][a-z0-9_-]*)/gi);
  return parts.map((p, i) => (
    /^@[a-z0-9]/i.test(p) ? <span key={i} className="mc-mention">{p}</span> : p
  ));
}

function MissionControl({ subAgents, swarmInfo, swarmBoard, inline = false, onOpenSubagents }) {
  const anyActive = Boolean(
    (swarmInfo && swarmInfo.phase !== 'done')
    || (subAgents || []).some((a) => a.status === 'running' || a.status === 'working' || a.status === 'queued' || a.status === 'waiting')
  );
  const [collapsed, setCollapsed] = useState(() => Boolean(inline && !anyActive));
  const [expandedKey, setExpandedKey] = useState(null);
  const [showBoard, setShowBoard] = useState(true);
  const boardEndRef = useRef(null);
  const wasActiveRef = useRef(anyActive);
  useEffect(() => {
    if (inline && wasActiveRef.current && !anyActive) setCollapsed(true);
    wasActiveRef.current = anyActive;
  }, [inline, anyActive]);
  const normSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const now = useTicker(anyActive, 1000);

  useEffect(() => {
    if (showBoard && boardEndRef.current) {
      boardEndRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [swarmBoard && swarmBoard.length, showBoard]);

  const counts = { working: 0, waiting: 0, done: 0, err: 0 };
  for (const a of subAgents || []) {
    if (a.status === 'running' || a.status === 'working') counts.working++;
    else if (a.status === 'waiting') counts.waiting++;
    else if (a.status === 'done') counts.done++;
    else if (a.status === 'error') counts.err++;
  }
  const curPhase = (swarmInfo && swarmInfo.phase) || 'planning';
  const curIdx = MC_PHASES.findIndex((p) => p.id === curPhase);
  const postsCount = (swarmBoard && swarmBoard.length) || 0;

  return (
    <div className={'mc-panel' + (anyActive ? ' active' : '') + (inline ? ' inline' : '')}>
      <button type="button" className="mc-head" onClick={() => setCollapsed((v) => !v)} aria-expanded={!collapsed}>
        <span className="mc-head-ico"><Icon name="Orbit" size={15} /></span>
        <span className="mc-title">{swarmInfo ? 'Swarm Mission Control' : 'Agent Workers'}</span>
        <div className="mc-badges">
          {counts.working > 0 && <span className="mc-pill working">{counts.working} active</span>}
          {counts.waiting > 0 && <span className="mc-pill waiting">{counts.waiting} waiting</span>}
          {counts.done > 0 && <span className="mc-pill done">{counts.done} done</span>}
          {counts.err > 0 && <span className="mc-pill err">{counts.err} err</span>}
          {postsCount > 0 && <span className="mc-pill">{postsCount} board</span>}
        </div>
        {inline && onOpenSubagents && (
          <span
            className="mc-open-pane"
            role="button"
            tabIndex={0}
            title="Open Subagents pane"
            onClick={(e) => { e.stopPropagation(); onOpenSubagents(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onOpenSubagents(); } }}
          >
            Details →
          </span>
        )}
        <Icon name={collapsed ? 'CaretRight' : 'CaretDown'} size={13} className="mc-caret" />
      </button>

      {!collapsed && (
        <div className="mc-body">
          {swarmInfo && (
            <div className="mc-phases">
              {MC_PHASES.map((ph, idx) => {
                const isDone = curPhase === 'done' ? true : idx < curIdx;
                const isActive = curPhase !== 'done' && idx === curIdx;
                return (
                  <div key={ph.id} className={'mc-phase' + (isDone ? ' done' : '') + (isActive ? ' active' : '')}>
                    <span className="mc-phase-dot" />
                    <span className="mc-phase-label">{ph.label}</span>
                    {ph.id === 'wakeup' && swarmInfo.wave > 0 && (
                      <span className="mc-phase-wave">w{swarmInfo.wave}</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          <div className={'mc-grid' + (!swarmInfo && (subAgents || []).length <= 1 ? ' single-worker' : '')}>
            {swarmInfo && swarmInfo.supervisor && (
              <div className={'mc-card supervisor ' + (swarmInfo.supervisorState || (curPhase === 'done' ? 'done' : 'running'))}>
                <div className="mc-card-top">
                  <span className={'mc-dot ' + (swarmInfo.supervisorState || (curPhase === 'done' ? 'done' : 'running'))} />
                  <span className="mc-card-name">Supervisor · @supervisor</span>
                  <span className="mc-role planner">planner</span>
                </div>
                <div className="mc-card-meta">
                  {swarmInfo.supervisor.model && <span className="mc-model" title={swarmInfo.supervisor.model}>{swarmInfo.supervisor.model}</span>}
                  <span className="mc-stat">{swarmInfo.supervisorState || curPhase}</span>
                </div>
              </div>
            )}

            {(subAgents || []).map((a) => {
              const p = a.progress || {};
              const expanded = expandedKey === a.key;
              const roleClass = a.jobRole || a.tier || 'coder';
              const elapsedMs = a.ms != null ? a.ms : (a.startedAt ? Math.max(0, now - a.startedAt) : 0);
              const showHandle = a.handle && normSlug(a.handle) !== normSlug(a.name);
              return (
                <button
                  type="button"
                  key={a.key}
                  className={'mc-card ' + a.status + (a.role === 'supervisor' ? ' supervisor' : '')}
                  onClick={() => setExpandedKey(expanded ? null : a.key)}
                >
                  <div className="mc-card-top">
                    <span className={'mc-dot ' + a.status} />
                    <span className="mc-card-name" title={a.name}>
                      {a.name}{showHandle ? ` · @${a.handle}` : ''}
                    </span>
                    <span className={'mc-role ' + roleClass}>{a.jobRole || a.tier || 'worker'}</span>
                  </div>
                  <div className="mc-card-meta">
                    {a.model && <span className="mc-model" title={a.model}>{a.model}</span>}
                    {a.failover && (
                      <span className="mc-failover" title={`Failover ${a.failover.from} → ${a.failover.to}: ${a.failover.reason || ''}`}>
                        ⇣ failover{a.failover.count > 1 ? ' ×' + a.failover.count : ''}
                      </span>
                    )}
                    <span className="mc-stat">
                      {p.tools ? p.tools + 't' : ''}{p.tools && a.posts ? ' · ' : ''}{a.posts ? a.posts + 'p' : ''}
                      {(p.tools || a.posts) && elapsedMs ? ' · ' : ''}
                      {elapsedMs ? Math.round(elapsedMs / 1000) + 's' : ''}
                    </span>
                  </div>
                  {p.currentTool && (a.status === 'running' || a.status === 'working' || a.status === 'waiting') && (
                    <div className="mc-action">
                      <Icon name="Wrench" size={11} />
                      <span>{p.currentTool.name}{p.currentTool.arg ? ' ' + p.currentTool.arg : ''}</span>
                    </div>
                  )}
                  {expanded && (
                    <div className="mc-trace" onClick={(e) => e.stopPropagation()}>
                      {(p.log || []).slice(-12).map((item, idx) => (
                        <div key={idx} className={'mc-trace-item' + (item.isError ? ' err' : '')}>
                          <span className="mc-trace-name">{item.name}</span>
                          <span className="mc-trace-arg">{item.arg}</span>
                        </div>
                      ))}
                      {p.last && <div className="mc-trace-snip">{String(p.last).slice(-280)}</div>}
                      {!(p.log && p.log.length) && !p.last && <div className="muted" style={{ fontSize: 11 }}>Waiting for activity…</div>}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {postsCount > 0 && (
            <div className="mc-board">
              <div className="mc-board-head">
                <span><Icon name="Chat" size={12} /> Shared Message Board ({postsCount})</span>
                <button type="button" className="btn-mini" onClick={() => setShowBoard((v) => !v)}>
                  {showBoard ? 'Hide' : 'Show'}
                </button>
              </div>
              {showBoard && (
                <div className="mc-board-feed">
                  {swarmBoard.map((m) => (
                    <div key={m.seq} className="mc-post">
                      <div className="mc-post-meta">
                        <span>#{m.seq}</span>
                        <span className="mc-post-from">@{m.from}</span>
                        {m.to && <span className="mc-post-to">→ @{m.to}</span>}
                        {m.channel && <span className="mc-post-chan">{m.channel}</span>}
                      </div>
                      <div className="mc-post-text">{renderBoardText(m.text)}</div>
                    </div>
                  ))}
                  <div ref={boardEndRef} />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Run Log & Checkpoints (Replay Blueprint + Rewind) ----------
function RunLogPanel({ convId }) {
  const [tab, setTab] = useState('replay'); // 'replay' | 'checkpoints'
  const [turns, setTurns] = useState([]);
  const [turnIdx, setTurnIdx] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);
  const [rewindMsg, setRewindMsg] = useState('');
  useEffect(() => {
    if (!rewindMsg) return undefined;
    const t = setTimeout(() => setRewindMsg((cur) => (cur === rewindMsg ? '' : cur)), 5000);
    return () => clearTimeout(t);
  }, [rewindMsg]);

  const loadLog = useCallback(async () => {
    if (!convId || !window.autobot || !window.autobot.sessionLog) return;
    try {
      const r = await window.autobot.sessionLog(convId, { limit: 30 });
      const list = (r && Array.isArray(r.turns)) ? r.turns.slice().reverse() : [];
      setTurns(list);
      setTurnIdx(0);
      setStep(list[0] && list[0].events ? list[0].events.length : 0);
      setPlaying(false);
    } catch (_) { setTurns([]); }
  }, [convId]);

  const loadCps = useCallback(async () => {
    if (!convId || !window.autobot || !window.autobot.listCheckpoints) return;
    try {
      const list = await window.autobot.listCheckpoints(convId);
      setCheckpoints(Array.isArray(list) ? list.slice().reverse() : []);
    } catch (_) { setCheckpoints([]); }
  }, [convId]);

  useEffect(() => { loadLog(); loadCps(); }, [loadLog, loadCps]);

  const activeTurn = turns[turnIdx] || null;
  const events = (activeTurn && activeTurn.events) || [];
  useEffect(() => {
    if (!playing) return undefined;
    const t = setInterval(() => {
      setStep((s) => {
        if (s >= events.length) { setPlaying(false); return s; }
        return s + 1;
      });
    }, 450);
    return () => clearInterval(t);
  }, [playing, events.length]);

  const visible = events.slice(0, Math.max(1, step));
  const doRewind = async (id) => {
    if (!window.autobot || !window.autobot.rewind) return;
    setRewindMsg('');
    try {
      const r = await window.autobot.rewind(convId, id);
      const rest = Array.isArray(r && r.restored) ? r.restored.length : (Number(r && r.restored) || 0);
      const rem = Array.isArray(r && r.removed) ? r.removed.length : (Number(r && r.removed) || 0);
      setRewindMsg(`Rewound: restored ${rest} file${rest === 1 ? '' : 's'}, removed ${rem}.`);
    } catch (e) { setRewindMsg('Rewind failed: ' + String((e && e.message) || e)); }
  };

  return (
    <div className="rl-panel">
      <div className="rl-tabs">
        <button type="button" className={'rl-tab' + (tab === 'replay' ? ' on' : '')} onClick={() => setTab('replay')}>Replay ({turns.length})</button>
        <button type="button" className={'rl-tab' + (tab === 'checkpoints' ? ' on' : '')} onClick={() => { setTab('checkpoints'); loadCps(); }}>Checkpoints ({checkpoints.length})</button>
        <button type="button" className="btn-mini" style={{ marginLeft: 'auto' }} onClick={() => { loadLog(); loadCps(); }}>
          <Icon name="Reload" size={12} /> Refresh
        </button>
      </div>

      {tab === 'replay' && (
        <>
          {turns.length === 0 ? (
            <div className="env-empty">No recorded runs yet for this conversation. Send a prompt to record an event-sourced trace.</div>
          ) : (
            <>
              <div className="rl-controls">
                <select
                  className="rl-select"
                  value={turnIdx}
                  onChange={(e) => {
                    const idx = Number(e.target.value) || 0;
                    setTurnIdx(idx);
                    setPlaying(false);
                    setStep((turns[idx] && turns[idx].events && turns[idx].events.length) || 0);
                  }}
                >
                  {turns.map((t, i) => (
                    <option key={t.turnId || i} value={i}>
                      {t.startedAt ? new Date(t.startedAt).toLocaleTimeString() : 'Turn'} · {t.events.length} events
                    </option>
                  ))}
                </select>
                <button type="button" className="btn-mini" onClick={() => { setPlaying(false); setStep((s) => Math.max(1, s - 1)); }}><Icon name="CaretLeft" size={12} /></button>
                <button type="button" className="btn-mini" onClick={() => { if (step >= events.length) setStep(1); setPlaying((p) => !p); }}>
                  <Icon name={playing ? 'Pause' : 'Play'} size={12} />
                </button>
                <button type="button" className="btn-mini" onClick={() => { setPlaying(false); setStep((s) => Math.min(events.length, s + 1)); }}><Icon name="CaretRight" size={12} /></button>
              </div>
              <div className="rl-scrubber">
                <input type="range" min={1} max={Math.max(1, events.length)} value={Math.min(Math.max(1, step), Math.max(1, events.length))} onChange={(e) => { setPlaying(false); setStep(Number(e.target.value)); }} />
                <span className="rl-step-count">{Math.min(step, events.length)} / {events.length}</span>
              </div>
              <div className="rl-timeline">
                {visible.map((ev, i) => (
                  <div key={i} className={'rl-ev' + (i === visible.length - 1 ? ' current' : '')}>
                    <div className="rl-ev-head">
                      <span className="rl-ev-time">+{((Number(ev.t) || 0) / 1000).toFixed(1)}s</span>
                      <span className={'rl-ev-type ' + (ev.type || '')}>{ev.type}</span>
                      {ev.subagent && <span className="mc-role coder">{ev.subagent}</span>}
                      {ev.name && <b>{ev.name}</b>}
                      {ev.phase && <b>{ev.phase}</b>}
                    </div>
                    {(ev.text || ev.reason || ev.message || ev.result || ev.args || ev.from) && (
                      <div className="rl-ev-body">
                        {ev.from ? `${ev.from} → ${ev.to}: ${ev.reason || ''}`
                          : ev.text || ev.message || ev.result || JSON.stringify(ev.args)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}

      {tab === 'checkpoints' && (
        <div className="rl-cp-list">
          {rewindMsg && (
            <div className="noticebar" style={{ borderRadius: 8, padding: '7px 10px' }}>
              <span className="noticebar-text">{rewindMsg}</span>
              <button type="button" className="noticebar-x" title="Dismiss" aria-label="Dismiss" onClick={() => setRewindMsg('')}><Icon name="X" size={12} /></button>
            </div>
          )}
          {checkpoints.length === 0 ? (
            <div className="env-empty">No file checkpoints recorded yet for this conversation.</div>
          ) : checkpoints.map((cp) => (
            <div key={cp.id} className="rl-cp-card">
              <div className="rl-cp-head">
                <b>{cp.at ? new Date(cp.at).toLocaleString() : cp.id}</b>
                <button type="button" className="btn-mini" onClick={() => doRewind(cp.id)}>
                  <Icon name="ArrowCounterClockwise" size={12} /> Rewind here
                </button>
              </div>
              <div className="rl-cp-files">
                {(cp.files || []).slice(0, 6).map((f, j) => (
                  <span key={j}>{f.existed ? 'restore ' : 'remove '}{String(f.path || '').split('/').slice(-2).join('/')}</span>
                ))}
                {(cp.files || []).length > 6 && <span>+{cp.files.length - 6} more</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Chat view ----------
function ChatView({ messages, live, thinking, paused, onScrollAway, subAgents, swarmInfo, swarmBoard, planMode, copyBlock, applyBlock, bottomRef, convId, cwd, copyMessage, editMessage, deleteMessage, retryMessage, forkFromMessage, shareFromMessage, conv, exportConv, T, runStartedAt, onToggleEnv, envOpen, onToggleRunLog, runLogOpen, reviewOpen, sessionPaneType, onOpenReview, onTogglePane, onOpenPlugins, onRenameConv, onPinConv, onArchiveConv, onSplitConv, onDeleteConv, setError }) {
  const [moreOpen, setMoreOpen] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [subExpanded, setSubExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const moreRef = useRef(null);
  const overviewRef = useRef(null);
  useDismiss(moreOpen, [moreRef], () => setMoreOpen(false));
  useDismiss(overviewOpen, [overviewRef], () => { setOverviewOpen(false); setSubExpanded(false); });

  const allTools = useMemo(
    () => (messages || []).flatMap((m) => m.tools || []).concat((live && live.tools) || []),
    [messages, live]
  );
  const allCheckpoints = useMemo(
    () => (messages || []).flatMap((m) => m.checkpoints || []).concat((live && live.checkpoints) || []),
    [messages, live]
  );
  const changedSummary = useMemo(() => summarizeChangedFiles(allTools, allCheckpoints), [allTools, allCheckpoints]);
  const wsLeaf = String(cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'Akron Code';
  const subCount = (subAgents && subAgents.length) || 0;
  const bgTasksCount = allCheckpoints.length + allTools.filter((t) => t && (t.name === 'Bash' || t.name === 'Task' || t.name === 'Agent' || t.name === 'Swarm' || t.background)).length;

  const turnPrompts = useMemo(() => {
    const out = [];
    let lastUser = '';
    for (const m of messages || []) {
      if (m && m.role === 'user') {
        const line = String(m.content || '').split('\n').find((s) => s.trim()) || '';
        lastUser = line.trim().slice(0, 28);
      }
      out.push(lastUser);
    }
    return out;
  }, [messages]);
  const liveTurnLabel = useMemo(() => {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'user') {
        const line = String(messages[i].content || '').split('\n').find((s) => s.trim()) || '';
        return line.trim().slice(0, 28);
      }
    }
    return '';
  }, [messages]);

  return (
    <div
      className="chat"
      onClick={(e) => { copyBlock(e); applyBlock(e); }}
      onScroll={(e) => {
        if (!onScrollAway) return;
        const el = e.currentTarget;
        const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
        onScrollAway(dist > 140);
      }}
    >
      {planMode && planMode.active && (
        <div className="planmode-banner" title={'The agent is read-only until you approve the plan. Plan file: ' + (planMode.file || 'PLAN.md')}>
          <Icon name="Clipboard" size={13} /> Plan mode · read-only · writes go to {planMode.file || 'PLAN.md'}
        </div>
      )}
      <div className="conv-toolbar">
        {renaming && conv ? (
          <input
            className="conv-rename-in"
            value={renameVal}
            autoFocus
            onChange={(e) => setRenameVal(e.target.value)}
            onBlur={() => { if (onRenameConv && renameVal.trim()) onRenameConv(renameVal.trim()); setRenaming(false); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { if (onRenameConv && renameVal.trim()) onRenameConv(renameVal.trim()); setRenaming(false); }
              if (e.key === 'Escape') setRenaming(false);
            }}
          />
        ) : (
          <div className="conv-toolbar-title">
            {conv && conv.pinned && <Icon name="Pin" size={13} style={{ marginRight: 5, color: 'var(--accent-text)' }} />}
            <span className="conv-ws-leaf">{wsLeaf}</span>
            <span className="conv-crumb-slash">/</span>
            <span className="conv-title-text">{(conv && conv.title) || 'New Conversation'}</span>
          </div>
        )}
        <div className="conv-toolbar-right">
          {subCount > 0 && (
            <button
              type="button"
              className={'conv-subagents-pill' + (sessionPaneType === 'subagents' ? ' active' : '')}
              title={`${subCount} subagents — open Subagents visualization`}
              onClick={() => onTogglePane && onTogglePane('subagents')}
            >
              <Icon name="GitBranch" size={12} />
              <span>{subCount}</span>
            </button>
          )}

          <div className="conv-pop-wrap" ref={moreRef}>
            <button
              type="button"
              className={'icon-btn conv-env-btn' + (moreOpen ? ' active' : '')}
              title="Conversation actions — Rename, Pin, Archive, Split, Copy, Plugins"
              onClick={(e) => { e.stopPropagation(); setOverviewOpen(false); setMoreOpen((v) => !v); }}
            >
              <Icon name="DotsVertical" size={15} />
            </button>
            {moreOpen && (
              <div className="conv-popover" onClick={(e) => e.stopPropagation()}>
                {conv && (
                  <>
                    <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); setRenameVal(conv.title || ''); setRenaming(true); }}>
                      <Icon name="Edit" size={14} /> <span>Rename</span>
                    </button>
                    <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onPinConv && onPinConv(); }}>
                      <Icon name="Pin" size={14} /> <span>{conv.pinned ? 'Unpin' : 'Pin'}</span>
                    </button>
                    <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onArchiveConv && onArchiveConv(); }}>
                      <Icon name="Bookmark" size={14} /> <span>{conv.archived ? 'Unarchive' : 'Archive'}</span>
                    </button>
                    <div className="conv-pop-sep" />
                  </>
                )}
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onSplitConv && onSplitConv(); }}>
                  <Icon name="ArrowSplitRight" size={14} /> <span>Split</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <button
                  type="button"
                  className="conv-pop-item"
                  onClick={() => {
                    setMoreOpen(false);
                    const payload = conv ? convToMarkdown(conv) : (cwd || '');
                    navigator.clipboard?.writeText(payload).catch(() => {});
                    setError && setError('✅ Copied to clipboard.');
                  }}
                >
                  <Icon name="Copy" size={14} /> <span>Copy</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onOpenPlugins && onOpenPlugins(); }}>
                  <Icon name="Plugin" size={14} /> <span>Plugins</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setMoreOpen(false); onToggleEnv && onToggleEnv(); }}>
                  <Icon name="Settings" size={14} /> <span>Environment</span>
                </button>
                {conv && (
                  <>
                    <div className="conv-pop-sep" />
                    <button type="button" className="conv-pop-item danger" onClick={() => { setMoreOpen(false); onDeleteConv && onDeleteConv(); }}>
                      <Icon name="Trash" size={14} /> <span>Delete</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="conv-pop-wrap" ref={overviewRef}>
            <button
              type="button"
              className={'icon-btn conv-env-btn conv-overview-btn' + (overviewOpen ? ' active' : '')}
              title="Overview — Review, Files, Terminal, Plugins, Subagents, Background Tasks"
              onClick={(e) => { e.stopPropagation(); setMoreOpen(false); setOverviewOpen((v) => !v); }}
            >
              <Icon name="BookText" size={15} />
              {(subCount > 0 || changedSummary.files.length > 0) && (
                <span className="conv-overview-badge">{subCount > 0 ? subCount : changedSummary.files.length}</span>
              )}
            </button>
            {overviewOpen && (
              <div className="conv-popover overview-pop" onClick={(e) => e.stopPropagation()}>
                <div className="conv-pop-head-row">
                  <span>Overview</span>
                  <button type="button" className="icon-btn" onClick={() => { setOverviewOpen(false); onToggleEnv && onToggleEnv(); }} title="Environment">
                    <Icon name="DotsVertical" size={13} />
                  </button>
                </div>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onOpenReview && onOpenReview({ tools: allTools, checkpoints: allCheckpoints, checkpointId: (live && live.checkpointId) || 'latest', turnLabel: liveTurnLabel, scope: 'all' }); }}>
                  <Icon name="File" size={14} /> <span>Review</span>
                  {changedSummary.files.length > 0 && <span className="conv-pop-count">{changedSummary.files.length}</span>}
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('files'); }}>
                  <Icon name="Files" size={14} /> <span>Files</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('terminal'); }}>
                  <Icon name="CommandLine" size={14} /> <span>Terminal</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('mindmap'); }}>
                  <Icon name="Grid" size={14} /> <span>Mind Map</span>
                </button>
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onOpenPlugins && onOpenPlugins(); }}>
                  <Icon name="Plugin" size={14} /> <span>Plugins</span>
                  <Icon name="CaretRight" size={12} className="conv-pop-chev" />
                </button>
                <div className="conv-pop-sep" />
                <button
                  type="button"
                  className="conv-pop-item"
                  onClick={() => {
                    if (subCount > 0 && !subExpanded) {
                      setSubExpanded(true);
                    } else {
                      setOverviewOpen(false);
                      onTogglePane && onTogglePane('subagents');
                    }
                  }}
                >
                  <span>Subagents</span>
                  <span className="conv-pop-right">
                    <span className="conv-pop-num">{subCount}</span>
                    <Icon name={subExpanded ? 'CaretDown' : 'CaretRight'} size={12} className="conv-pop-chev-inline" />
                  </span>
                </button>
                {subExpanded && (
                  <div className="ov-sub-list">
                    {(subAgents || []).slice(0, 6).map((a) => (
                      <button
                        key={a.key}
                        type="button"
                        className="ov-sub-row"
                        onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('subagents'); }}
                      >
                        <span className={'mc-dot ' + (a.status || 'done')} />
                        <span className="ov-sub-name">{a.name}</span>
                        {a.model && <span className="ov-sub-model">{a.model}</span>}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="ov-sub-open-all"
                      onClick={() => { setOverviewOpen(false); onTogglePane && onTogglePane('subagents'); }}
                    >
                      Open Subagents Panel ({subCount}) →
                    </button>
                  </div>
                )}
                <button type="button" className="conv-pop-item" onClick={() => { setOverviewOpen(false); onToggleRunLog && onToggleRunLog(); }}>
                  <span>Background Tasks</span>
                  <span className="conv-pop-right">
                    <span className="conv-pop-num">{bgTasksCount}</span>
                  </span>
                </button>
              </div>
            )}
          </div>

          <button
            type="button"
            className={'icon-btn conv-env-btn' + (sessionPaneType ? ' active' : '')}
            title={sessionPaneType ? 'Toggle side pane' : 'Open side pane (Review / Subagents / Files)'}
            onClick={() => onTogglePane && onTogglePane()}
          >
            <Icon name="SidebarRight" size={15} />
          </button>
        </div>
      </div>
      {messages.length === 0 && !live && (
        <div className="welcome">
          <Logo size={56} />
          <h1>{timeGreeting()}</h1>
          <p className="muted">{T('welcome.prompt')}</p>
        </div>
      )}
      {messages.map((m, i) => <Message key={m.id} m={m} convId={convId} idx={i} turnLabel={turnPrompts[i]} subAgentCount={subCount} taskCount={bgTasksCount} copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage} forkFromMessage={forkFromMessage} shareFromMessage={shareFromMessage} onOpenReview={onOpenReview} onOpenSubagents={() => onTogglePane && onTogglePane('subagents')} onOpenRunLog={onToggleRunLog} />)}
      {Boolean((subAgents && subAgents.length > 0) || swarmInfo) && (
        <MissionControl subAgents={subAgents} swarmInfo={swarmInfo} swarmBoard={swarmBoard} inline onOpenSubagents={() => onTogglePane && onTogglePane('subagents')} />
      )}
      {live && <div className="msg assistant">
        <div className="avatar avatar-assistant"><Logo size={20} /></div>
        <div className="body">
          <RunActivity live={live} thinking={thinking} startedAt={runStartedAt} />
          <LiveChecklistCard tools={live.tools} subAgents={subAgents} swarmInfo={swarmInfo} streamingTool={live.streamingTool} streaming Icon={Icon} />
          {live.segments && live.segments.length > 0 ? (
            <SegmentView segments={live.segments} tools={live.tools} streaming />
          ) : (
            <>
              {live.tools.length > 0 && (
                <div className="tools">
                  <ToolGroup rows={live.tools} streaming />
                </div>
              )}
              {live.content ? <div className="md streaming" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.content) + '<span class="cursor">▍</span>' }} /> : null}
            </>
          )}
          <LiveToolActivityCard tools={live.tools} streamingTool={live.streamingTool} paused={paused} describeTool={describeTool} Icon={Icon} />
          <FilesChangedBar tools={live.tools} checkpoints={live.checkpoints} checkpointId={live.checkpointId} turnLabel={liveTurnLabel} convId={convId} subAgentCount={subCount} taskCount={bgTasksCount} onOpenReview={onOpenReview} onOpenSubagents={() => onTogglePane && onTogglePane('subagents')} onOpenRunLog={onToggleRunLog} streaming Icon={Icon} />
          {live.content === '' && live.tools.length === 0 && !thinking && <span className="cursor">▍</span>}
        </div>
      </div>}
      <div ref={bottomRef} />
    </div>
  );
}

// A run is a sequence of steps: assistant text → tool rows → assistant text …
// Rendering that order (instead of "all tools, then one giant paragraph") is
// what makes a long agent run readable, and keeps separate steps from being
// glued into a single sentence.
// Example's transcript carries the model's reasoning as a collapsible block you
// can peek at, streaming live and folding to one line when done.
function ThinkBlock({ text, streaming }) {
  const [open, setOpen] = useState(false);
  const body = (text || '').slice(0, 24000);
  const preview = body.replace(/\s+/g, ' ').trim().slice(0, 88);
  return (
    <div className={'thinkblock' + (streaming ? ' streaming' : '')}>
      <button className="think-head" onClick={() => setOpen(!open)} title={open ? 'Hide reasoning' : 'Show reasoning'}>
        <Icon name={streaming ? 'Spinner' : 'Sparkles'} size={13} className={streaming ? 'spin think-ico' : 'think-ico'} />
        <span className="think-verb">{streaming ? 'Thinking' : 'Thought'}</span>
        {!open && preview && <span className="think-preview">{preview}</span>}
        <Icon name={open ? 'CaretUp' : 'CaretRight'} size={12} className="think-caret" />
      </button>
      {open && <pre className="think-body">{body}</pre>}
    </div>
  );
}

function SegmentView({ segments, tools, streaming }) {
  const list = segments || [];
  const lastIdx = list.length - 1;
  return list.map((s, i) => {
    if (s.type === 'thinking') {
      const txt = s.text || '';
      if (!txt.trim()) return null;
      return <ThinkBlock key={'seg-th-' + i} text={txt} streaming={streaming && i === lastIdx} />;
    }
    if (s.type === 'tools') {
      const rows = (s.ids || []).map((id) => (tools || []).find((t) => t.id === id)).filter(Boolean);
      if (!rows.length) return null;
      return <div className="tools" key={'seg-t-' + i}><ToolGroup rows={rows} streaming={streaming} /></div>;
    }
    const txt = s.text || '';
    if (!txt.trim()) return null;
    const caret = streaming && i === lastIdx ? '<span class="cursor">▍</span>' : '';
    return <div className={'md' + (streaming ? ' streaming' : '')} key={'seg-m-' + i} dangerouslySetInnerHTML={{ __html: renderMarkdown(txt) + caret }} />;
  });
}

function Message({ m, convId, idx, turnLabel = '', subAgentCount = 0, taskCount = 0, copyMessage, editMessage, deleteMessage, retryMessage, forkFromMessage, shareFromMessage, onOpenReview, onOpenSubagents, onOpenRunLog }) {
  const [copied, setCopied] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const shareRef = useRef(null);
  useDismiss(shareOpen, [shareRef], () => setShareOpen(false));
  const doCopy = () => { copyMessage(m); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const images = (m.attachments || []).filter((a) => a.isImage && a.dataUrl);
  const otherAtts = (m.attachments || []).filter((a) => !(a.isImage && a.dataUrl));
  return (
    <div className={'msg ' + m.role} id={'msg-' + m.id} data-msg-id={m.id}>
      <div className={m.role === 'user' ? 'avatar avatar-user' : 'avatar avatar-assistant'}>{m.role === 'user' ? <Icon name="User" size={16} /> : <Logo size={20} />}</div>
      <div className="body">
        {images.length > 0 && (
          <div className="msg-images">
            {images.map((a, i) => (
              <figure key={i} className="msg-image">
                <img src={a.dataUrl} alt={a.name} title={a.name} />
                <figcaption>{a.name}{a.size ? ` · ${fmtSize(a.size)}` : ''}</figcaption>
              </figure>
            ))}
          </div>
        )}
        {otherAtts.length > 0 && (
          <div className="msg-files">
            {otherAtts.map((a, i) => (
              <span key={i} className={'attach-chip' + (a.isText ? ' text' : ' bin')} title={a.name}>
                <Icon name={a.isText ? 'File' : 'FileZip'} size={14} />
                <span className="attach-name">{a.name}</span>
                {a.size ? <span className="attach-size"> · {fmtSize(a.size)}</span> : null}
              </span>
            ))}
          </div>
        )}
        {m.segments && m.segments.length > 0 ? (
          <SegmentView segments={m.segments} tools={m.tools} />
        ) : (
          <>
            {m.tools && m.tools.length > 0 && (
              <div className="tools">
                <ToolGroup rows={m.tools} />
              </div>
            )}
            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
            <LinkPreviews text={m.content} />
          </>
        )}
        {m.role === 'assistant' && m.tools && m.tools.some((t) => t && t.name === 'TodoWrite') && (
          <LiveChecklistCard tools={m.tools} durationMs={m.durationMs} streaming={false} Icon={Icon} />
        )}
        {m.role === 'assistant' && (
          <FilesChangedBar tools={m.tools} checkpoints={m.checkpoints} checkpointId={m.checkpointId} turnLabel={turnLabel} convId={convId} subAgentCount={subAgentCount} taskCount={taskCount} onOpenReview={onOpenReview} onOpenSubagents={onOpenSubagents} onOpenRunLog={onOpenRunLog} streaming={false} Icon={Icon} />
        )}
        {m.role === 'assistant' && (
          <div className="response-actions" data-response-actions>
            <button type="button" className={'response-action-btn' + (copied ? ' copied' : '')} title="Copy response" onClick={doCopy}>
              <Icon name={copied ? 'Check' : 'Copy'} size={13} />
              <span>{copied ? 'Copied' : 'Copy'}</span>
            </button>
            <button type="button" className="response-action-btn" title="Fork conversation from this response" onClick={() => forkFromMessage && forkFromMessage(convId, idx)}>
              <Icon name="GitBranch" size={13} />
              <span>Fork</span>
            </button>
            <button type="button" className="response-action-btn" title="Retry this response" onClick={() => retryMessage && retryMessage(convId, idx)}>
              <Icon name="History" size={13} />
              <span>Retry</span>
            </button>
            <div className="response-share-wrap" ref={shareRef}>
              <button type="button" className="response-action-btn" title="Share or export response" onClick={() => setShareOpen((v) => !v)}>
                <Icon name="Share" size={13} />
                <span>Share</span>
              </button>
              {shareOpen && (
                <div className="response-share-menu" onClick={(e) => e.stopPropagation()}>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'copy'); }}>
                    <Icon name="Copy" size={13} /> <span>Copy Markdown</span>
                  </button>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'html'); }}>
                    <Icon name="File" size={13} /> <span>Share as HTML…</span>
                  </button>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'md'); }}>
                    <Icon name="FileAdd" size={13} /> <span>Export Markdown…</span>
                  </button>
                  <button type="button" onClick={() => { setShareOpen(false); shareFromMessage && shareFromMessage(convId, idx, 'json'); }}>
                    <Icon name="Code" size={13} /> <span>Export JSON…</span>
                  </button>
                </div>
              )}
            </div>
            {(m.model || m.durationMs > 800) && (
              <span className="response-actions-meta">
                {m.model && (
                  <span
                    className="response-model-badge"
                    title={m.modelsUsed && m.modelsUsed.length > 1 ? `Models used: ${m.modelsUsed.join(' → ')}` : `Model: ${m.model}`}
                  >
                    <Icon name="Sparkles" size={11} />
                    <span className="response-model-name">{m.model}</span>
                  </span>
                )}
                {m.model && m.durationMs > 800 && <span className="response-meta-sep" aria-hidden="true">·</span>}
                {m.durationMs > 800 && (
                  <span className="response-worked-time"><Icon name="Clock" size={12} /> Worked for {fmtElapsed(m.durationMs)}</span>
                )}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="msg-toolbar">
        <button className="icon-btn" title={copied ? 'Copied' : 'Copy'} onClick={doCopy}><Icon name={copied ? 'Check' : 'Copy'} size={15} /></button>
        {m.role === 'user' && <button className="icon-btn" title="Edit" onClick={() => editMessage(m)}><Icon name="Edit" size={15} /></button>}
        {m.role === 'assistant' && <button className="icon-btn" title="Fork from here" onClick={() => forkFromMessage && forkFromMessage(convId, idx)}><Icon name="GitBranch" size={15} /></button>}
        {m.role === 'assistant' && <button className="icon-btn" title="Retry" onClick={() => retryMessage(convId, idx)}><Icon name="History" size={15} /></button>}
        <button className="icon-btn" title="Delete" onClick={() => deleteMessage(convId, idx)}><Icon name="Trash" size={15} /></button>
      </div>
    </div>
  );
}

// Share / export dropdown for a conversation (Markdown / HTML / JSON).
function ExportMenu({ conv, exportConv, T }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="export-wrap">
      <button className="icon-btn" title={T('export.share')} onClick={() => setOpen(!open)}>
        <Icon name="Share" size={16} />
      </button>
      {open && (
        <div className="export-menu" onClick={(e) => e.stopPropagation()}>
          <div className="export-menu-head">{T('export.title')}</div>
          <button onClick={() => { setOpen(false); exportConv('html'); }}><Icon name="File" size={14} /> {T('export.html')} <span className="export-hint">{T('export.html.hint')}</span></button>
          <button onClick={() => { setOpen(false); exportConv('md'); }}><Icon name="FileAdd" size={14} /> {T('export.md')}</button>
          <button onClick={() => { setOpen(false); exportConv('json'); }}><Icon name="Code" size={14} /> {T('export.json')}</button>
        </div>
      )}
    </div>
  );
}

// Example renders the agent's todo list as a live checklist; a raw
// "Planning — 5 steps" row made it look like a step *limit*. Show the items.
function TodoList({ todos }) {
  return (
    <div className="todolist">
      {todos.map((t, i) => {
        const s = (t && (t.status || t.state)) || 'pending';
        const label = (t && (t.content || t.text || t.title || t.activeForm)) || String(t || '');
        return (
          <div className={'todo ' + s} key={i}>
            <span className="todo-mark">{s === 'completed' ? '✓' : s === 'in_progress' ? '▸' : '○'}</span>
            <span className="todo-text">{label}</span>
          </div>
        );
      })}
    </div>
  );
}

// ── Change accounting ──────────────────────────────────────────────────────
// Example summarises a run inline — "Ran 6 commands, read and edited
// opencode.json, 1 blocked +2 −2" — instead of dumping a column of tool JSON.
// The counters are derived from the args the model actually sent, so they can
// never drift from what hit disk.
const BLOCKED_RE = /denied at permission|prompt blocked|blocked by hook|not available to this sub-agent|blocked by pretooluse|needs approval|permission denied|user rejected/i;

function countLines(s) {
  const t = String(s == null ? '' : s);
  if (!t) return 0;
  return t.split('\n').length;
}

// Per-row line delta. Write replaces the whole file, so every line it emits is
// new. Edit/MultiEdit carry the exact span they replaced — that is what the
// counter measures.
function toolDelta(t) {
  const a = (t && t.args) || {};
  const name = String((t && t.name) || '');
  if (name === 'Write' && a.content != null) return { added: countLines(a.content), removed: 0 };
  if (name === 'Edit' || name === 'MultiEdit' || name === 'StrReplace') {
    if (Array.isArray(a.edits)) {
      let added = 0;
      let removed = 0;
      for (const e of a.edits) {
        removed += countLines(e && (e.old_string ?? e.old_str));
        added += countLines(e && (e.new_string ?? e.new_str));
      }
      return { added, removed };
    }
    return { removed: countLines(a.old_string ?? a.old_str), added: countLines(a.new_string ?? a.new_str) };
  }
  return { added: 0, removed: 0 };
}

function isBlockedRow(t) {
  if (!t || t.status !== 'error') return false;
  return BLOCKED_RE.test(String(t.result || ''));
}

// Bucket a tool call into the vocabulary the summary line speaks.
function groupKind(name) {
  switch (String(name || '')) {
    case 'Bash': return 'command';
    case 'Read': case 'ReadFile': case 'LS': case 'ListDir': case 'ListFiles': return 'file';
    case 'Write': return 'write';
    case 'Edit': case 'MultiEdit': case 'StrReplace': return 'edit';
    case 'Glob': case 'Grep': case 'Search': return 'search';
    case 'WebFetch': case 'WebSearch': case 'browser_open': case 'browser_navigate': return 'page';
    case 'TodoWrite': case 'exitPlanMode': return 'plan';
    case 'Task': return 'agent';
    default: return 'other';
  }
}

function describeGroup(rows) {
  const counts = new Map();
  const files = [];
  let added = 0;
  let removed = 0;
  let blocked = 0;
  for (const t of rows) {
    const kind = groupKind(t.name);
    counts.set(kind, (counts.get(kind) || 0) + 1);
    const d = toolDelta(t);
    added += d.added;
    removed += d.removed;
    if (isBlockedRow(t)) blocked += 1;
    if (kind === 'file' || kind === 'write' || kind === 'edit') {
      const p = (t.args && (t.args.path || t.args.file_path)) || '';
      const name = String(p).replace(/\\/g, '/').split('/').filter(Boolean).pop();
      if (name && !files.includes(name)) files.push(name);
    }
  }
  const parts = [];
  const n = (k) => counts.get(k) || 0;
  if (n('command')) parts.push('Ran ' + n('command') + (n('command') === 1 ? ' command' : ' commands'));
  if (n('file')) parts.push('read ' + n('file') + (n('file') === 1 ? ' file' : ' files'));
  if (n('write')) parts.push('wrote ' + n('write') + (n('write') === 1 ? ' file' : ' files'));
  if (n('edit')) parts.push('edited ' + n('edit') + (n('edit') === 1 ? ' file' : ' files'));
  if (n('search')) parts.push('searched ' + n('search') + '×');
  if (n('page')) parts.push('fetched ' + n('page') + (n('page') === 1 ? ' page' : ' pages'));
  if (n('agent')) parts.push('ran ' + n('agent') + (n('agent') === 1 ? ' agent' : ' agents'));
  if (n('plan')) parts.push('updated the plan');
  if (n('other')) parts.push(n('other') + (n('other') === 1 ? ' other tool' : ' other tools'));
  let text = parts.join(', ');
  // Name at most two touched files: the point is orientation, not an inventory.
  if (files.length) {
    const shown = files.slice(0, 2).join(', ');
    text += (text ? ' · ' : '') + shown + (files.length > 2 ? ' +' + (files.length - 2) : '');
  }
  if (!text) text = rows.length + (rows.length === 1 ? ' tool call' : ' tool calls');
  return { text, added, removed, blocked };
}

function DeltaChips({ added, removed }) {
  if (!added && !removed) return null;
  return (
    <span className="delta-chips" title={added + ' line(s) added, ' + removed + ' line(s) removed'}>
      <span className="delta-add">+{added}</span>
      <span className="delta-del">−{removed}</span>
    </span>
  );
}

const clipText = (s, n) => {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '\n… ' + (t.length - n) + ' more characters' : t;
};

// An Edit rendered as the change it makes (− old / + new) rather than the JSON
// blob that encodes it. This is the difference between "the agent is working"
// and "I can see what it did".
function DiffBlock({ oldText, newText, file }) {
  const MAX = 260;
  const del = oldText ? String(oldText).split('\n') : [];
  const add = newText ? String(newText).split('\n') : [];
  return (
    <div className="td-diff">
      {file ? <div className="td-file">{shortPath(file)}</div> : null}
      {del.slice(0, MAX).map((l, i) => (
        <div key={'d' + i} className="td-line del"><span className="td-sign">−</span><span className="td-code">{l || ' '}</span></div>
      ))}
      {add.slice(0, MAX).map((l, i) => (
        <div key={'a' + i} className="td-line add"><span className="td-sign">+</span><span className="td-code">{l || ' '}</span></div>
      ))}
      {(del.length > MAX || add.length > MAX) ? <div className="td-more">truncated for display — full text is in the file</div> : null}
    </div>
  );
}

function ToolDetail({ t }) {
  const a = t.args || {};
  const name = String(t.name || '');
  const out = t.result != null ? String(t.result) : '';
  const body = [];
  if (name === 'Edit' || name === 'MultiEdit' || name === 'StrReplace') {
    const edits = Array.isArray(a.edits)
      ? a.edits
      : [{ old_string: a.old_string ?? a.old_str, new_string: a.new_string ?? a.new_str }];
    edits.forEach((e, i) => {
      body.push(
        <DiffBlock
          key={'e' + i}
          file={a.path || a.file_path}
          oldText={(e && (e.old_string ?? e.old_str)) ?? ''}
          newText={(e && (e.new_string ?? e.new_str)) ?? ''}
        />
      );
    });
  } else if (name === 'Write') {
    body.push(<DiffBlock key="w" file={a.path || a.file_path} oldText="" newText={a.content ?? ''} />);
  } else if (name === 'Bash') {
    body.push(
      <div key="c" className="td-cmd"><span className="td-prompt">$</span><span className="td-cmd-text">{clipText(a.command || a.cmd || '', 1200)}</span></div>
    );
  } else {
    const kv = Object.entries(a).filter(([, v]) => v != null && v !== '' && typeof v !== 'object');
    if (kv.length) {
      body.push(
        <dl key="kv" className="td-kv">
          {kv.slice(0, 12).map(([k, v]) => (
            <React.Fragment key={k}>
              <dt>{k}</dt>
              <dd>{clipText(v, 400)}</dd>
            </React.Fragment>
          ))}
        </dl>
      );
    }
  }
  return (
    <div className="tool-detail">
      {body}
      {out ? <pre className="tool-result">{clipText(out, 6000)}</pre> : null}
    </div>
  );
}

function ToolCard({ t }) {
  const todos = t.name === 'TodoWrite' && t.args && Array.isArray(t.args.todos) ? t.args.todos : null;
  const [open, setOpen] = useState(Boolean(todos && todos.length));
  const d = describeTool(t.name, t.args);
  const delta = toolDelta(t);
  const blocked = isBlockedRow(t);
  const status = t.status === 'error' ? 'error' : t.status === 'running' ? 'running' : 'done';
  let title = '';
  try { title = JSON.stringify(t.args || {}).slice(0, 400); } catch { title = ''; }
  return (
    <div className={'toolcard ' + status + (blocked ? ' blocked' : '')}>
      <div className="toolcard-head" onClick={() => setOpen(!open)}>
        <span className="tool-ico"><Icon name={d.icon} size={14} /></span>
        <span className="tool-name">{d.verb}</span>
        {d.target ? <span className="tool-args" title={title}>{d.target}</span> : <span className="tool-args" />}
        <DeltaChips added={delta.added} removed={delta.removed} />
        <span className="tool-state">
          {status === 'running' && <Icon name="Spinner" size={13} className="spin" />}
          {status === 'error' && <Icon name="Warning" size={13} />}
          {status === 'done' && <Icon name="Check" size={13} />}
        </span>
        <span className="caret"><Icon name={open ? 'CaretUp' : 'CaretRight'} size={11} /></span>
      </div>
      {open && todos && todos.length > 0 && <TodoList todos={todos} />}
      {open && !(todos && todos.length) && <ToolDetail t={t} />}
    </div>
  );
}

// A run's tool calls collapse into one row you can open. Keeping every row
// expanded turned a 20-step run into a wall of cards and buried the answer.
function ToolGroup({ rows, streaming }) {
  const live = rows.some((t) => t.status === 'running');
  const [open, setOpen] = useState(false);
  const info = describeGroup(rows);
  const onlyOne = rows.length === 1;
  // A single call is its own row — no summary header needed.
  if (onlyOne) return <ToolCard t={rows[0]} />;
  return (
    <div className={'toolgroup' + (live ? ' running' : '') + (open ? ' open' : '')}>
      <button type="button" className="toolgroup-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="toolgroup-ico">
          {live ? <Icon name="Spinner" size={13} className="spin" /> : <Icon name="Wrench" size={13} />}
        </span>
        <span className="toolgroup-text">{info.text}</span>
        <DeltaChips added={info.added} removed={info.removed} />
        {info.blocked > 0 ? <span className="toolgroup-blocked">{info.blocked} blocked</span> : null}
        <span className="toolgroup-count">{rows.length}</span>
        <span className="caret"><Icon name={open ? 'CaretUp' : 'CaretRight'} size={11} /></span>
      </button>
      {open && (
        <div className="toolgroup-rows">
          {rows.map((t) => <ToolCard key={t.id} t={t} />)}
        </div>
      )}
    </div>
  );
}

// ---------- Artifacts ----------
// Live interactive preview for artifact blocks (HTML/SVG/Mermaid/React/markdown),
// mirroring Claude Desktop's sandboxed artifact runtime. HTML/SVG/Mermaid render
// fully offline; React/JSX use a sandboxed iframe with CDN React + Babel (best-effort).
function ArtifactPreview({ block }) {
  const lang = (block.lang || 'text').toLowerCase().trim();
  const code = block.code || '';
  const [mermaidSvg, setMermaidSvg] = useState('');
  const [mermaidErr, setMermaidErr] = useState('');

  useEffect(() => {
    if (lang !== 'mermaid') return;
    let cancelled = false;
    setMermaidSvg('');
    setMermaidErr('');
    const id = 'mmd' + Math.random().toString(36).slice(2, 9);
    const isLightTheme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
    import('mermaid')
      .then((mod) => {
        const mermaid = mod.default || mod;
        if (cancelled) return;
        mermaid.initialize({ startOnLoad: false, theme: isLightTheme ? 'default' : 'dark', securityLevel: 'strict' });
        return mermaid.render(id, code);
      })
      .then((res) => {
        if (!cancelled && res && res.svg) setMermaidSvg(res.svg);
      })
      .catch((e) => {
        if (!cancelled) setMermaidErr(String((e && e.message) ? e.message : e));
      });
    return () => { cancelled = true; };
  }, [lang, code]);

  // Design canvas / slide deck: both are built by the main process (one source of
  // truth with the artifact window and print-to-PDF) and rendered in a sandbox.
  const isCanvas = ['design', 'canvas', 'artboard', 'slides', 'deck', 'presentation'].includes(lang);
  const [canvasDoc, setCanvasDoc] = useState('');
  const [canvasKey, setCanvasKey] = useState('');
  const [canvasTick, setCanvasTick] = useState(0);
  useEffect(() => {
    if (!isCanvas) return undefined;
    let live = true;
    setCanvasDoc('');
    const api = window.autobot;
    const p = api && api.artifactDocument
      ? api.artifactDocument({ name: block.label || '', language: lang, content: code })
      : Promise.resolve('');
    Promise.resolve(p)
      .then((h) => {
        if (!live || typeof h !== 'string') return;
        setCanvasDoc(h);
        // The document carries its own store key; the preview posts edits back
        // with that key so main writes the right slot.
        const m = /"key":"(canvas-[A-Za-z0-9-]+)"/.exec(h);
        setCanvasKey(m ? m[1] : '');
      })
      .catch(() => { /* leave the placeholder */ });
    return () => { live = false; };
  }, [isCanvas, lang, code, block.label, canvasTick]);

  // Edits made inside the preview (design artboards / slide deck) are posted to
  // the app window; persist them so the artifact window and every other surface
  // see one document.
  useEffect(() => {
    if (!isCanvas) return undefined;
    const onMsg = (ev) => {
      const d = ev && ev.data;
      if (!d || d.type !== 'helio:artifact-change' || !d.patch) return;
      const api = window.autobot;
      if (!api || !api.artifactSave) return;
      const key = d.key || canvasKey;
      if (!key) return;
      try { api.artifactSave(key, d.patch).catch(() => {}); } catch (_) {}
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [isCanvas, canvasKey]);

  // A change made elsewhere (artifact window, another conversation) reloads this
  // preview from the store instead of drifting out of sync.
  useEffect(() => {
    if (!isCanvas) return undefined;
    const api = window.autobot;
    if (!api || !api.onArtifactSaved) return undefined;
    const off = api.onArtifactSaved((info) => {
      if (!canvasKey || !info || info.key !== canvasKey) return;
      setCanvasTick((n) => n + 1);
    });
    return typeof off === 'function' ? off : undefined;
  }, [isCanvas, canvasKey]);

  if (isCanvas) {
    if (!canvasDoc) return <div className="artifact-fallback muted">Building {lang === 'slides' || lang === 'deck' || lang === 'presentation' ? 'deck' : 'canvas'}…</div>;
    return <iframe className="artifact-frame" title={lang + ' canvas'} sandbox="allow-scripts allow-modals allow-popups" srcDoc={canvasDoc} />;
  }
  if (lang === 'html' || lang === 'htm' || lang === 'xml') {
    return <iframe className="artifact-frame" title="artifact preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcDoc={code} />;
  }
  if (lang === 'svg') {
    const clean = DOMPurify.sanitize(code, { USE_PROFILES: { svg: true, svgFilters: true } });
    return <iframe className="artifact-frame" title="artifact preview" sandbox="" srcDoc={`<!doctype html><html><body style="margin:0;background:#fff">${clean}</body></html>`} />;
  }
  if (lang === 'mermaid') {
    if (mermaidErr) {
      return <div className="artifact-fallback"><p className="muted">Diagram render failed: {mermaidErr}</p><pre>{code}</pre></div>;
    }
    if (!mermaidSvg) return <div className="artifact-fallback muted">Rendering diagram…</div>;
    return <div className="artifact-frame artifact-mermaid" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(mermaidSvg, { USE_PROFILES: { svg: true, svgFilters: true } }) }} />;
  }
  if (lang === 'markmap' || lang === 'mindmap') {
    const isLightTheme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light';
    return <MindMapView markdown={code} theme={isLightTheme ? 'light' : 'dark'} compact />;
  }
  if (lang === 'react' || lang === 'jsx' || lang === 'js') {
    return <iframe className="artifact-frame" title="artifact preview" sandbox="allow-scripts" srcDoc={reactIframeHtml(code)} />;
  }
  if (lang === 'markdown' || lang === 'md') {
    return <div className="artifact-md" dangerouslySetInnerHTML={{ __html: renderMarkdown(code) }} />;
  }
  if (lang === 'text' || lang === 'txt') {
    return <pre className="artifact-plain">{code}</pre>;
  }
  return <div className="artifact-fallback"><p className="muted">No live preview for “{block.lang || 'text'}”. Switch to Code to view the source.</p></div>;
}

// Build a sandboxed HTML shell that loads React + Babel from a CDN and renders a
// JSX/React artifact. The user code is base64-embedded to avoid escaping issues.
function reactIframeHtml(code) {
  let b64 = '';
  try { b64 = btoa(unescape(encodeURIComponent(code))); } catch { b64 = btoa(code); }
  return `<!doctype html><html><head><meta charset="utf-8">
<script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"><\/script>
<script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"><\/script>
<script src="https://unpkg.com/@babel/standalone/babel.min.js"><\/script>
<style>body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:16px;background:#fff;color:#111}</style>
</head><body><div id="root"></div>
<script>
function __err(e){var d=document.createElement('pre');d.style.cssText='color:#c00;white-space:pre-wrap;padding:16px;font-size:12px';d.textContent='Render error: '+(e&&e.message?e.message:e);document.body.appendChild(d);}
function __go(){
  try{
    var __code = decodeURIComponent(escape(atob('${b64}')));
    var out = Babel.transform(__code, {presets:['env','react']}).code;
    var module = {exports:{}}; var exports = module.exports;
    var require = function(){ return window.React; };
    (function(){ eval(out); }).call(window);
    var App = (module.exports && module.exports.default) ? module.exports.default : module.exports;
    if (!App && window.App) App = window.App;
    if (!App){ document.getElementById('root').textContent = 'No default export found. Export a component as default.'; return; }
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(App));
  }catch(e){ __err(e); }
}
if (window.React && window.ReactDOM && window.Babel) { __go(); }
else { document.getElementById('root').textContent = 'Could not load React/Babel from CDN. Preview requires network access.'; }
<\/script></body></html>`;
}

// ── Global search (Cmd/Ctrl+Shift+F) — Desktop transcript-search parity ──────
// Searches the conversation history in-memory (instant, no IPC) plus the
// project folder / notebooks / memory through the main process (ripgrep).
function searchConversations(convs, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const out = [];
  for (const c of convs || []) {
    const title = (c.title || '').toLowerCase();
    if (title.includes(q)) out.push({ kind: 'conv', convId: c.id, msgId: null, title: c.title || 'Untitled', text: c.title || '', ts: c.ts || 0 });
    for (const m of c.messages || []) {
      const text = String(m.content || '');
      const idx = text.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const from = Math.max(0, idx - 70);
        out.push({ kind: 'conv', convId: c.id, msgId: m.id, role: m.role, title: c.title || 'Untitled', text: (from > 0 ? '…' : '') + text.slice(from, idx + 120).replace(/\s+/g, ' '), ts: m.ts || c.ts || 0 });
      }
    }
  }
  return out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
}

function SearchView({ convs, cwd, onOpenConv }) {
  const [q, setQ] = useState('');
  const [convHits, setConvHits] = useState([]);
  const [diskHits, setDiskHits] = useState([]);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current && inputRef.current.focus(); }, []);
  useEffect(() => {
    setConvHits(searchConversations(convs, q));
    if (!q.trim()) { setDiskHits([]); return; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await window.autobot.searchAll({ query: q.trim(), cwd: cwd || '', limit: 60 });
        if (alive) setDiskHits((res && res.hits) || []);
      } catch (_) { if (alive) setDiskHits([]); }
      if (alive) setBusy(false);
    }, 220);
    return () => { alive = false; clearTimeout(t); };
  }, [q, convs, cwd]);
  const total = convHits.length + diskHits.length;
  return (
    <div className="searchview">
      <div className="search-bar">
        <Icon name="Search" size={16} />
        <input ref={inputRef} className="search-input" placeholder="Search conversations, files, notebooks, memory…" value={q} onChange={(e) => setQ(e.target.value)} />
        {busy && <span className="search-busy">searching…</span>}
        <span className="search-count">{q.trim() ? total + ' result' + (total === 1 ? '' : 's') : ''}</span>
      </div>
      {!q.trim() && <div className="search-empty">Type to search. Conversations are searched in memory; files, notebooks and memory on disk.</div>}
      {q.trim() > '' && convHits.length > 0 && (
        <section className="search-group">
          <h4>Conversations</h4>
          {convHits.map((h, i) => (
            <button key={'c' + i} className="search-hit" onClick={() => onOpenConv(h.convId, h.msgId)}>
              <span className="search-hit-title">{h.title}</span>
              <span className="search-hit-sub">{h.role ? (h.role === 'user' ? 'you' : 'assistant') + ' · ' : ''}{h.text}</span>
            </button>
          ))}
        </section>
      )}
      {q.trim() > '' && diskHits.length > 0 && (
        <section className="search-group">
          <h4>Project files, notebooks &amp; memory</h4>
          {diskHits.map((h, i) => (
            <div key={'d' + i} className="search-hit search-hit-static">
              <span className="search-hit-title">{h.kind === 'file' ? (h.rel || h.file) + ':' + h.line : h.kind === 'notebook' ? 'Notebook · ' + h.title : 'Memory'}</span>
              <span className="search-hit-sub">{h.text}</span>
            </div>
          ))}
        </section>
      )}
      {q.trim() && !busy && total === 0 && <div className="search-empty">No matches for “{q.trim()}”.</div>}
    </div>
  );
}

function ArtifactsView({ blocks }) {
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState('preview'); // 'preview' | 'code'
  const block = blocks[idx];
  // Frame type manifests (🎨 Design / 📽️ Slides) come from main so the tab strip,
  // header and Open button use the same title/tint/icon as the artifact window.
  const langs = blocks.map((b) => String(b.lang || '').toLowerCase().trim());
  const typeMeta = useArtifactTypes(langs);
  const meta = block ? typeMeta[String(block.lang || '').toLowerCase().trim()] || null : null;
  // Tab labels read like Desktop: the explicit artifact name, else the frame
  // type ("Design"/"Slides"), else the fence language. A number is only added
  // when more than one artifact of that type exists, so the common case is a
  // clean "🎨 Design" instead of "🎨design #1".
  const tabLabels = useMemo(() => {
    const counts = {};
    for (const l of langs) counts[l] = (counts[l] || 0) + 1;
    const seen = {};
    return blocks.map((b) => {
      const l = String(b.lang || '').toLowerCase().trim();
      const mt = typeMeta[l];
      const base = b.label || (mt && mt.title) || b.lang || 'artifact';
      if ((counts[l] || 0) < 2) return base;
      seen[l] = (seen[l] || 0) + 1;
      return base + ' ' + seen[l];
    });
  }, [blocks, langs.join('|'), typeMeta]);
  let highlighted = '';
  if (block) {
    try {
      highlighted = block.lang && hljs.getLanguage(block.lang) ? hljs.highlight(block.code, { language: block.lang }).value : hljs.highlightAuto(block.code).value;
    } catch {}
  }
  const canPreview = block && ['html', 'htm', 'xml', 'svg', 'mermaid', 'react', 'jsx', 'js', 'markdown', 'md', 'text', 'txt', 'design', 'canvas', 'artboard', 'slides', 'deck', 'presentation'].includes((block.lang || 'text').toLowerCase().trim());
  return (
    <div className="panel artifacts">
      <h2>Artifacts</h2>
      {blocks.length === 0 && <p className="muted">No code artifacts yet. Ask Akron Code to write code and it will appear here.</p>}
      {blocks.length > 0 && (
        <>
          <div className="artifact-tabs">
            {blocks.map((b, i) => {
              const mt = typeMeta[String(b.lang || '').toLowerCase().trim()];
              return (
                <button key={i} className={i === idx ? 'on' : ''} onClick={() => { setIdx(i); setMode('preview'); }}
                  style={mt ? { '--artifact-tint': mt.tintColor } : undefined}
                  title={mt ? `${mt.title} · contract ${mt.contract}` : undefined}>
                  {mt && <span className="artifact-tab-emoji" aria-hidden="true">{mt.favicon}</span>}
                  {tabLabels[i]}
                </button>
              );
            })}
          </div>
          {block && (
            <div className="artifact-body">
              <div className="artifact-toolbar">
                {meta ? (
                  <div className="codeblock-head artifact-type-head" style={{ '--artifact-tint': meta.tintColor }}>
                    <span className="artifact-type-badge">
                      <Icon name={meta.icon || 'Artifacts'} size={14} />
                      {meta.title}
                    </span>
                    <span className="artifact-type-contract">contract {meta.contract}</span>
                    {meta.mcp && meta.mcp.length > 0 && (
                      <span className={meta.mcp.some((s) => s.available) ? 'artifact-cap on' : 'artifact-cap'} title={meta.mcp.some((s) => s.available) ? 'Save to Drive is available' : 'Connect Google Drive to save decks there'}>
                        {meta.mcp.some((s) => s.available) ? 'Drive ready' : 'Drive not connected'}
                      </span>
                    )}
                  </div>
                ) : (
                  <div className="codeblock-head"><span>{block.lang}</span></div>
                )}
                <div className="artifact-toggle">
                  <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')} disabled={!canPreview}>Preview</button>
                  <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>Code</button>
                  <button className="copy-btn" data-code={encodeURIComponent(block.code)} onClick={(e) => { const btn = e.currentTarget; const c = decodeURIComponent(btn.dataset.code || ''); navigator.clipboard?.writeText(c).then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }); }}>Copy</button>
                  <button onClick={() => window.autobot.openArtifactWindow({ name: block.label || '', language: block.lang, content: block.code })}>Open</button>
                  <button onClick={() => window.autobot.printToPdf({ defaultName: (block.label || 'artifact').replace(/[^\w.-]+/g, '_') + '.pdf', language: (block.lang || '').toLowerCase(), html: ['html', 'htm', 'svg'].includes((block.lang || '').toLowerCase()) ? block.code : undefined, content: block.code })}>PDF</button>
                </div>
              </div>
              {mode === 'code' || !canPreview ? (
                <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
              ) : (
                <ArtifactPreview block={block} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Fetch frame type metadata once per distinct artifact language. Main resolves
// the manifest against the current install (flag overrides, connected MCP
// servers, local profile), so the badge never claims a capability that is off.
function useArtifactTypes(langs) {
  const [map, setMap] = useState({});
  const seen = useRef({});
  const key = langs.filter(Boolean).join('|');
  useEffect(() => {
    const api = window.autobot;
    if (!api || !api.artifactType) return undefined;
    const want = key.split('|').filter(Boolean).filter((l) => !seen.current[l]);
    if (!want.length) return undefined;
    want.forEach((l) => { seen.current[l] = 'pending'; });
    let live = true;
    Promise.all(want.map((l) => Promise.resolve(api.artifactType({ language: l })).then((m) => [l, m]).catch(() => [l, null])))
      .then((pairs) => {
        if (!live) return;
        setMap((prev) => {
          const next = { ...prev };
          for (const [l, m] of pairs) { next[l] = m; seen.current[l] = m ? 'done' : 'none'; }
          return next;
        });
      });
    return () => { live = false; };
  }, [key]);
  return map;
}

// MemoryView extracted to src/features/WorkspacePanels.jsx

// ---------- Skills ----------
const SKILL_SOURCE_LABELS = { bundled: 'Bundled', claude: 'Claude Code', custom: 'Custom' };
const SKILL_SOURCE_ORDER = ['bundled', 'claude', 'custom'];

function SkillsView({ skills, toggleSkill, setAllSkills, refreshSkills }) {
  const [q, setQ] = useState('');
  const [group, setGroup] = useState('all'); // 'all' | source | 'enabled' | 'disabled'
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newContent, setNewContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Re-read from disk when the panel opens so skills added by the model
  // (create_skill) or by another window show up immediately.
  useEffect(() => { if (refreshSkills) refreshSkills(); }, [refreshSkills]);

  const enabledCount = skills.filter((s) => s.enabled !== false).length;

  // Upload a .md file from disk → parsed + saved as a custom skill.
  const uploadSkill = async () => {
    setErr('');
    const picked = await window.autobot.pickSkillFile();
    if (!picked) return;
    if (picked.ok === false) { setErr(picked.error || 'Could not read file.'); return; }
    setBusy(true);
    const r = await window.autobot.addSkill(picked.name, picked.content);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not save skill.'); return; }
    if (refreshSkills) await refreshSkills();
  };

  // Author a skill inline (name + Markdown body).
  const saveSkill = async () => {
    setErr('');
    if (!newName.trim() || !newContent.trim()) { setErr('Name and content are required.'); return; }
    setBusy(true);
    const r = await window.autobot.addSkill(newName.trim(), newContent);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not save skill.'); return; }
    setAdding(false); setNewName(''); setNewContent('');
    if (refreshSkills) await refreshSkills();
  };

  const removeSkill = async (name) => {
    setErr('');
    const r = await window.autobot.deleteSkill(name);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not delete skill.'); return; }
    if (refreshSkills) await refreshSkills();
  };

  const filtered = useMemo(() => {
    const query = q.trim().toLowerCase();
    return skills.filter((s) => {
      if (group === 'enabled' && s.enabled === false) return false;
      if (group === 'disabled' && s.enabled !== false) return false;
      if (group !== 'all' && group !== 'enabled' && group !== 'disabled' && s.source !== group) return false;
      if (query) {
        const hay = (s.name + ' ' + s.description + ' ' + (s.source || '')).toLowerCase();
        if (!hay.includes(query)) return false;
      }
      return true;
    });
  }, [skills, q, group]);

  const groups = useMemo(() => {
    const bySource = {};
    for (const s of filtered) (bySource[s.source || 'custom'] = bySource[s.source || 'custom'] || []).push(s);
    return SKILL_SOURCE_ORDER.map((src) => ({ src, label: SKILL_SOURCE_LABELS[src] || src, items: bySource[src] || [] }))
      .filter((g) => g.items.length > 0);
  }, [filtered]);

  return (
    <div className="panel skills-panel">
      <div className="panel-head">
        <h2>Skills</h2>
        <span className="muted">{enabledCount}/{skills.length} enabled</span>
      </div>

      <div className="skills-toolbar">
        <input
          className="skills-search"
          placeholder="Search skills by name or description…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <select className="skills-filter" value={group} onChange={(e) => setGroup(e.target.value)}>
          <option value="all">All sources</option>
          <option value="enabled">Enabled only</option>
          <option value="disabled">Disabled only</option>
          {SKILL_SOURCE_ORDER.map((src) => (
            <option key={src} value={src}>{SKILL_SOURCE_LABELS[src] || src}</option>
          ))}
        </select>
        <button onClick={() => setAllSkills(true)}>Enable all</button>
        <button onClick={() => setAllSkills(false)}>Disable all</button>
        <button className="primary" disabled={busy} onClick={uploadSkill}><Icon name="Upload" size={13} /> Add skill (.md)</button>
        <button disabled={busy} onClick={() => { setAdding((v) => !v); setErr(''); }}>{adding ? 'Cancel' : 'New skill'}</button>
      </div>

      {err && <p className="form-error">{err}</p>}

      {adding && (
        <div className="skill-author">
          <input placeholder="Skill name (e.g. release-notes)" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <textarea
            rows={6}
            placeholder={'Markdown body. Optional frontmatter:\n---\nname: my-skill\ndescription: What it does\n---\n\n# Instructions…'}
            value={newContent}
            onChange={(e) => setNewContent(e.target.value)}
          />
          <div className="row-actions">
            <button className="primary" disabled={busy} onClick={saveSkill}>Save skill</button>
            <span className="muted">Saved to ~/.autobot/skills/ and discoverable via the list_skills tool.</span>
          </div>
        </div>
      )}

      <p className="muted skills-hint">Enabled skills are auto-discoverable by the model via the "list_skills" tool. Toggle any skill on or off; changes persist and apply immediately. Upload any <code>.md</code> file to add your own skill.</p>

      {filtered.length === 0 && <p className="muted">No skills match.</p>}

      {groups.map((g) => (
        <div key={g.src} className="skills-group">
          <div className="skills-group-head">{g.label} <span className="muted">{g.items.length}</span></div>
          {g.items.map((s) => {
            const on = s.enabled !== false;
            return (
              <div key={s.name} className={'skillitem' + (on ? '' : ' off')}>
                <button
                  className={'switch' + (on ? ' on' : '')}
                  role="switch"
                  aria-checked={on}
                  onClick={() => toggleSkill(s.name)}
                  title={on ? 'Click to deactivate' : 'Click to activate'}
                >
                  <span className="knob" />
                </button>
                <div className="skillitem-body">
                  <div className="skillitem-title">
                    <b>{s.name}</b>
                    <span className="skill-src">{SKILL_SOURCE_LABELS[s.source] || s.source}</span>
                  </div>
                  <span className="skillitem-desc">{s.description}</span>
                </div>
                {s.source === 'custom' && (
                  <button className="icon-btn" title="Delete skill" onClick={() => removeSkill(s.name)}><Icon name="Trash" size={13} /></button>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

// ---------- Plugins & Connectors (Claude Desktop parity: directory + install + configure + test) ----------
function PluginsView({ onOpenGdrive, gdriveState } = {}) {
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [cat, setCat] = useState('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [stats, setStats] = useState(null);
  const [shown, setShown] = useState(120);
  const [tab, setTab] = useState('directory');
  const [authBusy, setAuthBusy] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [cfgDraft, setCfgDraft] = useState({ apiKey: '', endpointUrl: '', command: '' });
  const [testMap, setTestMap] = useState({}); // id -> { ok, detail, error }

  const refreshStats = useCallback(async () => {
    try {
      const s = await window.autobot.pluginStats();
      if (s) setStats(s);
      const c = await window.autobot.pluginCategories();
      if (Array.isArray(c)) setCats(c);
    } catch (_) {}
  }, []);

  const refresh = useCallback(async () => {
    const opts = {};
    if (type !== 'all') opts.type = type;
    if (cat !== 'all') opts.category = cat;
    if (installedOnly) opts.installedOnly = true;
    const query = q.trim();
    const list = query
      ? await window.autobot.searchPlugins(query, { ...opts, limit: 600 })
      : await window.autobot.listPlugins(opts);
    setItems(Array.isArray(list) ? list : []);
  }, [q, type, cat, installedOnly]);

  useEffect(() => { refreshStats(); }, [refreshStats]);
  useEffect(() => { refresh(); }, [refresh]);
  // Any filter change starts the list over at the first page.
  useEffect(() => { setShown(120); }, [q, type, cat, installedOnly]);

  // Registry sync runs in the background; pick it up shortly after first paint.
  useEffect(() => {
    if (!stats || stats.registry) return;
    const t = setTimeout(refreshStats, 4000);
    return () => clearTimeout(t);
  }, [stats, refreshStats]);

  const setInstalled = async (id, on) => {
    setErr('');
    setBusy(true);
    try {
      const r = on ? await window.autobot.installPlugin(id) : await window.autobot.uninstallPlugin(id);
      if (r && r.ok === false) setErr(r.error);
      else if (r && r.needsSetup === 'gdrive' && onOpenGdrive) {
        onOpenGdrive();
      } else if (r && r.needsAuth) {
        // OAuth-gated connector: installation succeeded, the server wants a token.
        setErr('Installed. Click “Sign in” (or “Configure”) on the card to authorize with the provider.');
      } else if (r && r.connectError) setErr('Installed, but could not connect: ' + r.connectError);
      else if (on && r && r.entry && r.entry.auth === 'apikey' && !r.entry.connected) {
        setEditingId(id);
        setCfgDraft({ apiKey: '', endpointUrl: (r.entry.endpoint && r.entry.endpoint.url) || '', command: '' });
      }
    } finally {
      setBusy(false);
      await refresh();
      refreshStats();
    }
  };

  const openConfigure = (it) => {
    if (it.builtInAdapter === 'gdrive' && onOpenGdrive) {
      onOpenGdrive();
      return;
    }
    setEditingId((prev) => (prev === it.id ? null : it.id));
    setCfgDraft({
      apiKey: '',
      endpointUrl: (it.endpoint && it.endpoint.url) || '',
      command: (it.command && it.command.command) || '',
    });
  };

  const saveConfigure = async (it) => {
    setErr('');
    setAuthBusy(it.id);
    try {
      const r = await window.autobot.configurePlugin(it.id, cfgDraft);
      if (!r || r.ok === false) {
        const msg = (r && r.error) || 'Failed to save configuration';
        setErr(msg);
        setTestMap((m) => ({ ...m, [it.id]: { ok: false, error: msg } }));
      } else {
        setEditingId(null);
        setTestMap((m) => ({ ...m, [it.id]: { ok: true, detail: r.detail || `Connected (${(r.tools || []).length || 'OK'})` } }));
      }
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  const testConnector = async (it) => {
    setErr('');
    setAuthBusy(it.id);
    try {
      const r = await window.autobot.testPlugin(it.id);
      if (r && r.needsSetup === 'gdrive' && onOpenGdrive) {
        onOpenGdrive();
      }
      setTestMap((m) => ({
        ...m,
        [it.id]: r && r.ok
          ? { ok: true, detail: r.detail || 'OK' }
          : { ok: false, error: (r && r.error) || 'Test failed' },
      }));
    } catch (e) {
      setTestMap((m) => ({ ...m, [it.id]: { ok: false, error: e && e.message ? e.message : String(e) } }));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  // Browser sign-in for an OAuth-gated connector (MCP OAuth 2.1 + PKCE).
  const signIn = async (id) => {
    setErr('');
    setAuthBusy(id);
    try {
      const r = await window.autobot.pluginAuthStart(id);
      if (!r || r.ok === false) setErr((r && r.error) || 'sign-in failed');
      else if (r.connected === false) setErr('Signed in, but the connector still refused: ' + (r.connectError || 'unknown error'));
      else if (r.error) setErr(r.error);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  const signOut = async (id) => {
    setErr('');
    setAuthBusy(id);
    try {
      const r = await window.autobot.pluginSignOut(id);
      if (r && r.ok === false) setErr(r.error);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    } finally {
      setAuthBusy(null);
      await refresh();
      refreshStats();
    }
  };

  const refreshRegistry = async () => {
    setErr('');
    setBusy(true);
    try {
      await window.autobot.refreshRegistry();
      await refreshStats();
      await refresh();
    } finally { setBusy(false); }
  };

  const installedCount = items.filter((i) => i.installed).length;
  const visible = items.slice(0, shown);
  const reg = stats && stats.registry;
  const regCount = reg ? reg.count || 0 : 0;

  return (
    <div className="panel plugins-panel">
      <div className="panel-head">
        <h2>Plugins &amp; Connectors</h2>
        <span className="muted">{installedCount} installed · {items.length} available</span>
      </div>
      <div className="seg">
        <button className={tab === 'directory' ? 'on' : ''} onClick={() => setTab('directory')}>Directory</button>
        <button className={tab === 'extensions' ? 'on' : ''} onClick={() => setTab('extensions')}>Chrome extensions</button>
      </div>

      {tab === 'extensions' && <ExtensionsView />}

      {tab === 'directory' && (<>
      <p className="muted">Connect external services so the model can read your docs, issues, messages, and data. Installing a connector registers it with the MCP layer; connectors marked “needs sign-in” require credentials before their tools work.</p>

      <div className="skills-toolbar">
        <input className="skills-search" placeholder="Search plugins & connectors…" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="skills-filter" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="all">All types</option>
          <option value="connector">Connectors</option>
          <option value="plugin">Plugins</option>
        </select>
        <select className="skills-filter" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="check"><input type="checkbox" checked={installedOnly} onChange={(e) => setInstalledOnly(e.target.checked)} /> Installed only</label>
      </div>

      {stats && (
        <div className="plugin-registry-row">
          <span className="muted">
            {(stats.curated && stats.curated.connectors) || stats.connectors} built-in connectors ·{' '}
            {(stats.curated && stats.curated.plugins) || stats.plugins} plugins · {stats.categories} categories
          </span>
          <span className="muted">
            {regCount > 0
              ? `+${regCount} live MCP servers${reg && reg.refreshing ? ' (syncing…)' : ''}`
              : reg && reg.refreshing ? 'Syncing MCP registry…' : 'MCP registry not synced yet'}
          </span>
          <button disabled={busy || (reg && reg.refreshing)} onClick={refreshRegistry}>Refresh registry</button>
        </div>
      )}

      {err && <p className="form-error">{err}</p>}
      {items.length === 0 && <p className="muted">No plugins or connectors match.</p>}

      <div className="plugin-grid">
        {visible.map((it) => {
          const isDrive = it.builtInAdapter === 'gdrive';
          const isConnected = isDrive ? !!(gdriveState && gdriveState.connected) : !it.requiresSignIn;
          const tr = testMap[it.id];
          return (
          <div key={it.id} className={'plugin-card' + (it.installed ? ' installed' : '')}>
            <div className="plugin-card-head">
              <div className="plugin-card-id">
                <ConnectorLogo id={it.id} name={it.name} url={it.endpoint && it.endpoint.url} type={it.type} />
                <div className="plugin-card-meta">
                  <b>{it.name}</b>
                  <span className="skill-src">{it.category}</span>
                </div>
              </div>
              <button
                className={it.installed ? '' : 'primary'}
                disabled={busy}
                onClick={() => setInstalled(it.id, !it.installed)}
              >
                {it.installed ? 'Remove' : 'Install'}
              </button>
            </div>
            <p className="plugin-card-desc">{it.description}</p>
            <div className="plugin-card-foot">
              <span className="muted">{it.auth === 'none' ? 'No sign-in needed' : it.auth === 'oauth' ? 'OAuth sign-in' : 'API key'}</span>
              <span className="badge">{it.type}</span>
              {it.origin === 'registry' && <span className="badge">registry</span>}
              {it.installed && !isConnected && <span className="badge warn">needs sign-in</span>}
              {it.installed && isConnected && <span className="badge ok">{it.toolCount > 0 ? `${it.toolCount} tools` : (isDrive && gdriveState ? `connected (${gdriveState.mode || 'drive'})` : 'connected')}</span>}
              {it.installed && isDrive && (
                <button className="plugin-auth primary" onClick={() => onOpenGdrive && onOpenGdrive()}>
                  {isConnected ? 'Configure Drive' : 'Set up'}
                </button>
              )}
              {it.installed && !isDrive && it.endpoint && it.auth === 'oauth' && (
                it.requiresSignIn
                  ? <button className="plugin-auth primary" disabled={authBusy === it.id} onClick={() => signIn(it.id)}>
                      {authBusy === it.id ? 'Signing in…' : 'Sign in'}
                    </button>
                  : <button className="plugin-auth" disabled={authBusy === it.id} onClick={() => signOut(it.id)}>
                      Sign out
                    </button>
              )}
              {it.installed && !isDrive && (it.auth === 'apikey' || (it.auth === 'oauth' && !it.endpoint)) && (
                <button className={'plugin-auth' + (it.requiresSignIn ? ' primary' : '')} disabled={authBusy === it.id} onClick={() => openConfigure(it)}>
                  {editingId === it.id ? 'Close' : (it.requiresSignIn ? 'Configure' : 'Edit key')}
                </button>
              )}
              {it.installed && (
                <button className="plugin-auth" disabled={authBusy === it.id} onClick={() => testConnector(it)}>
                  {authBusy === it.id ? 'Testing…' : 'Test'}
                </button>
              )}
            </div>
            {tr && (
              <div className={'plugin-test-res ' + (tr.ok ? 'ok' : 'err')}>
                {tr.ok ? `✓ ${tr.detail}` : `✕ ${tr.error}`}
              </div>
            )}
            {it.installed && editingId === it.id && (
              <div className="plugin-cfg-drawer">
                <input
                  type="password"
                  placeholder={it.auth === 'oauth' ? 'Bearer / personal access token…' : 'Paste API key / token…'}
                  value={cfgDraft.apiKey}
                  onChange={(e) => setCfgDraft((d) => ({ ...d, apiKey: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="Optional MCP server URL (https://.../mcp)"
                  value={cfgDraft.endpointUrl}
                  onChange={(e) => setCfgDraft((d) => ({ ...d, endpointUrl: e.target.value }))}
                />
                <input
                  type="text"
                  placeholder="Optional stdio MCP command (e.g. npx -y @org/mcp)"
                  value={cfgDraft.command}
                  onChange={(e) => setCfgDraft((d) => ({ ...d, command: e.target.value }))}
                />
                <div className="plugin-cfg-actions">
                  <button className="btn-mini primary" disabled={authBusy === it.id} onClick={() => saveConfigure(it)}>
                    {authBusy === it.id ? 'Connecting…' : 'Save & Connect'}
                  </button>
                  <button className="btn-mini" onClick={() => setEditingId(null)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
          );
        })}
      </div>

      {items.length > visible.length && (
        <div className="plugin-more">
          <button onClick={() => setShown((n) => n + 240)}>
            Show more ({items.length - visible.length} left)
          </button>
        </div>
      )}
      </>)}
    </div>
  );
}

// ---------- Chrome extensions (Desktop `extension-host` parity) ----------
function ExtensionsView() {
  const [rows, setRows] = useState([]);
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [opened, setOpened] = useState({});

  const refresh = useCallback(async () => {
    try {
      const list = await window.autobot.extensionList();
      setRows(Array.isArray(list) ? list : []);
      const st = await window.autobot.extensionStatus();
      if (st) setStatus(st);
    } catch (e) {
      setErr(e && e.message ? e.message : String(e));
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  useEffect(() => window.autobot.onExtensionWindowError((msg) => {
    setErr(String(msg || 'The extension window could not load.'));
    refresh();
  }), [refresh]);

  const rescan = async () => {
    setBusy(true); setErr('');
    try { await window.autobot.extensionScan(); await refresh(); }
    catch (e) { setErr(e && e.message ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const open = async (row) => {
    setBusy(true); setErr('');
    try {
      const r = await window.autobot.extensionOpen({ extensionId: row.id, page: row.defaultPage });
      if (!r || r.ok === false) setErr((r && (r.message || r.error)) || 'Could not open the extension.');
      else setOpened((o) => ({ ...o, [row.id]: r.windowId }));
      await refresh();
    } catch (e) { setErr(e && e.message ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const close = async (row) => {
    const id = opened[row.id];
    if (!id) return;
    await window.autobot.extensionClose(id);
    setOpened((o) => { const n = { ...o }; delete n[row.id]; return n; });
    await refresh();
  };

  return (
    <div className="extensions-view">
      <p className="muted">
        Unpacked Chrome MV3/MV2 extensions are hosted with a real <code>chrome-extension://</code> origin and a
        <code> chrome.*</code> surface backed by Akron Code. Drop a folder in <code>~/.autobot/extensions/&lt;id&gt;</code> and rescan.
      </p>
      <div className="plugin-registry-row">
        <span className="muted">
          {rows.length} installed{status ? ` · ${status.native} native · ${status.windows} open · ${status.sinks} attached` : ''}
          {status && status.bridge ? ` · bridge ${status.bridge.ready ? 'ready' : 'off'}${status.bridge.port ? ' on :' + status.bridge.port : ''}` : ''}
        </span>
        <button disabled={busy} onClick={rescan}>{busy ? 'Working…' : 'Rescan folder'}</button>
      </div>

      {err && <p className="form-error">{err}</p>}
      {rows.length === 0 && (
        <p className="muted">No extensions installed. Add one under <code>~/.autobot/extensions/&lt;id&gt;/manifest.json</code>.</p>
      )}

      <div className="plugin-grid">
        {rows.map((row) => (
          <div key={row.id} className="plugin-card">
            <div className="plugin-card-head">
              <div>
                <b>{row.name}</b>
                <span className="skill-src">{row.version} · MV{row.manifestVersion}{row.hasBackground ? ' · worker' : ''}</span>
              </div>
              <div className="ext-actions">
                {opened[row.id]
                  ? <button onClick={() => close(row)}>Close</button>
                  : <button className="primary" disabled={busy} onClick={() => open(row)}>Open</button>}
              </div>
            </div>
            {row.description && <p className="plugin-card-desc">{row.description}</p>}
            <div className="plugin-card-foot">
              <span className="muted mono-id">{row.id}</span>
            </div>
            {row.permissions.length > 0 && (
              <div className="ext-perms">
                {row.permissions.slice(0, 8).map((p) => <span key={p} className="badge">{p}</span>)}
                {row.permissions.length > 8 && <span className="badge">+{row.permissions.length - 8}</span>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Scheduled tasks (Claude Desktop parity) ----------
const CADENCES = [
  { id: 'once', label: 'Once' },
  { id: 'every', label: 'Every N minutes' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Daily' },
  { id: 'weekly', label: 'Weekly' },
];

function ScheduledView() {
  const [tasks, setTasks] = useState([]);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [cadence, setCadence] = useState('daily');
  const [time, setTime] = useState('09:00');
  const [everyMinutes, setEveryMinutes] = useState(60);
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const list = await window.autobot.listScheduledTasks();
    setTasks(Array.isArray(list) ? list : []);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => window.autobot.onEvent((evt) => {
    if (evt && evt.type === 'scheduled-task') refresh();
  }), [refresh]);

  const create = async () => {
    setErr('');
    if (!prompt.trim()) { setErr('Prompt is required.'); return; }
    setBusy(true);
    const input = { name: name.trim() || undefined, prompt: prompt.trim(), cadence };
    if (cadence === 'every') input.everyMinutes = Number(everyMinutes) || 60;
    if (cadence === 'daily' || cadence === 'weekly') input.time = time;
    if (cadence === 'weekly') input.dayOfWeek = Number(dayOfWeek);
    const r = await window.autobot.createScheduledTask(input);
    setBusy(false);
    if (!r || r.ok === false) { setErr((r && r.error) || 'Could not create task.'); return; }
    setName(''); setPrompt('');
    await refresh();
  };

  const toggle = async (t) => {
    await window.autobot.updateScheduledTask(t.id, { enabled: t.enabled === false });
    await refresh();
  };
  const remove = async (id) => { await window.autobot.deleteScheduledTask(id); await refresh(); };
  const runNow = async (id) => { setBusy(true); await window.autobot.runScheduledTask(id); setBusy(false); await refresh(); };

  return (
    <div className="panel scheduled-panel">
      <div className="panel-head">
        <h2>Scheduled tasks</h2>
        <span className="muted">{tasks.length} task{tasks.length === 1 ? '' : 's'}</span>
      </div>
      <p className="muted">Scheduled tasks run a prompt through the agent automatically — a daily brief, a periodic check, or a one-off reminder. Results are saved with each task.</p>

      <div className="sched-form">
        <input placeholder="Task name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea rows={3} placeholder="Prompt to run, e.g. “Summarize overnight changes in ~/projects and list anything broken.”" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        <div className="sched-row">
          <select value={cadence} onChange={(e) => setCadence(e.target.value)}>
            {CADENCES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          {cadence === 'every' && (
            <label className="inline-num">Every <input type="number" min={1} value={everyMinutes} onChange={(e) => setEveryMinutes(e.target.value)} /> min</label>
          )}
          {(cadence === 'daily' || cadence === 'weekly') && (
            <label className="inline-num">at <input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          )}
          {cadence === 'weekly' && (
            <select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>
              {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}
            </select>
          )}
          <button className="primary" disabled={busy} onClick={create}>Schedule</button>
        </div>
      </div>

      {err && <p className="form-error">{err}</p>}
      {tasks.length === 0 && <p className="muted">No scheduled tasks yet.</p>}

      {tasks.map((t) => (
        <div key={t.id} className={'sched-item' + (t.enabled === false ? ' off' : '')}>
          <div className="sched-item-head">
            <button className={'switch' + (t.enabled !== false ? ' on' : '')} role="switch" aria-checked={t.enabled !== false} onClick={() => toggle(t)} title="Enable/disable"><span className="knob" /></button>
            <div className="sched-item-body">
              <b>{t.name}</b>
              <span className="muted">{t.schedule}{t.nextRunAt ? ' · next ' + new Date(t.nextRunAt).toLocaleString() : ''}{t.runCount ? ' · ran ' + t.runCount + '×' : ''}</span>
              <span className="skillitem-desc">{t.prompt}</span>
              {t.lastResult && (
                <span className={'muted sched-last' + (t.lastResult.ok ? '' : ' err')}>
                  Last run {new Date(t.lastRunAt || t.lastResult.at).toLocaleString()}: {t.lastResult.ok ? String(t.lastResult.output || '').slice(0, 240) : 'ERROR ' + t.lastResult.error}
                </span>
              )}
            </div>
            <div className="sched-actions">
              <button className="icon-btn" title="Run now" disabled={busy} onClick={() => runNow(t.id)}><Icon name="CheckCircle" size={14} /></button>
              <button className="icon-btn" title="Delete" onClick={() => remove(t.id)}><Icon name="Trash" size={13} /></button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

// ProjectsView, McpView, NotebooksView extracted to src/features/WorkspacePanels.jsx

// ---------- Terminal ----------
function TerminalView({ terminal, setTerminal, startTerminal, runInTerminal, writeTerminal, killTerminal }) {
  const [cmd, setCmd] = useState('');
  const active = terminal.tabs.find((t) => t.id === terminal.active);
  const submit = (e) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    runInTerminal(cmd);
    setCmd('');
  };
  return (
    <div className="panel terminal-panel">
      <div className="panel-head"><h2>Terminal</h2>
        <div><button onClick={startTerminal}>+ New tab</button> <button onClick={() => writeTerminal('\x03')} title="Send Ctrl-C">Ctrl-C</button></div>
      </div>
      {terminal.tabs.length === 0 && <p className="muted">No terminal tabs. Start one to run shell commands.</p>}
      {terminal.tabs.length > 0 && (
        <div className="term-tabs">
          {terminal.tabs.map((t) => (
            <button key={t.id} className={'term-tab ' + (t.id === terminal.active ? 'on' : '')} onClick={() => setTerminal((s) => ({ ...s, active: t.id }))}>
              {t.id} <span className="term-cwd">{t.cwd.split('/').pop()}</span>
              <span className="term-close" onClick={(e) => { e.stopPropagation(); killTerminal(t.id); }}>×</span>
            </button>
          ))}
        </div>
      )}
      {active && (
        <>
          <pre className="term-output">{active.output || '(no output)'}</pre>
          <form className="term-input" onSubmit={submit}>
            <span className="term-prompt">$</span>
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="command…" autoFocus />
          </form>
        </>
      )}
    </div>
  );
}

// ---------- Claude Code (repo-aware) ----------
function CodeView({ cwd, setCwd, permissions, setPermissions, T }) {
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [diffOld, setDiffOld] = useState('');
  const [diffNew, setDiffNew] = useState('');
  const [diffRes, setDiffRes] = useState(null);

  const refresh = useCallback(async (dir) => {
    setLoading(true);
    try {
      const g = await window.autobot.gitInfo(dir || cwd || undefined);
      setInfo(g);
    } catch (e) {
      setInfo({ isRepo: false, error: String(e) });
    } finally {
      setLoading(false);
    }
  }, [cwd]);

  useEffect(() => { refresh(); }, [refresh]);

  const pickFolder = async () => {
    const dir = await window.autobot.pickFolder();
    if (dir) {
      setCwd(dir); refresh(dir);
      const id = loadJSON('autobot:activeId', null);
      if (id) window.autobot.setWorkspace(id, dir).catch(() => {});
    }
  };

  const runDiff = async () => {
    const d = await window.autobot.diff(diffOld, diffNew, 'edit');
    setDiffRes(d);
  };

  const counts = (info && info.counts) || {};

  return (
    <div className="panel code-panel">
      <div className="panel-head">
        <h2>{T('code.title')}</h2>
        <div className="code-head-actions">
          <button onClick={pickFolder}><Icon name="Folder" size={14} /> {T('code.openFolder')}</button>
          <button onClick={() => refresh()} disabled={loading}><Icon name="ArrowClockwise" size={14} /> {T('code.refresh')}</button>
        </div>
      </div>

      <div className="code-cwd muted">{cwd || '(no folder open)'}</div>

      <div className="code-perms">
        <span className="code-k">{T('code.permissions')}</span>
        <div className="seg seg-4">
          <button className={permissions === 'auto' ? 'on' : ''} onClick={() => setPermissions('auto')} title={T('code.permissions.autoHint')}>{T('code.permissions.auto')}</button>
          <button className={permissions === 'ask' ? 'on' : ''} onClick={() => setPermissions('ask')} title={T('code.permissions.askHint')}>{T('code.permissions.ask')}</button>
          <button className={permissions === 'acceptEdits' ? 'on' : ''} onClick={() => setPermissions('acceptEdits')} title={T('code.permissions.acceptEditsHint')}>{T('code.permissions.acceptEdits')}</button>
          <button className={permissions === 'plan' ? 'on' : ''} onClick={() => setPermissions('plan')} title={T('code.permissions.planHint')}>{T('code.permissions.plan')}</button>
          <button className={permissions === 'bypass' ? 'on' : ''} onClick={() => setPermissions('bypass')} title={T('perm.bypassDesc')}>{T('perm.bypass')}</button>
        </div>
      </div>
      <p className="muted code-perms-hint">{T('code.permissions.hint')}</p>

      {loading && <p className="muted">{T('code.loading')}</p>}

      {info && !info.isRepo && (
        <div className="code-norepo">
          <p><b>{T('code.noRepo')}</b></p>
          <p className="muted">{T('code.noRepo.hint')}</p>
        </div>
      )}

      {info && info.isRepo && (
        <div className="code-dash">
          <div className="code-row">
            <span className="code-k">{T('code.branch')}</span>
            <span className="code-v">
              <b>{info.branch}</b>
              {info.ahead > 0 && <span className="code-tag ahead">↑{info.ahead} {T('code.ahead')}</span>}
              {info.behind > 0 && <span className="code-tag behind">↓{info.behind} {T('code.behind')}</span>}
            </span>
          </div>
          {info.remote && (
            <div className="code-row"><span className="code-k">{T('code.remote')}</span><span className="code-v">{info.remote}</span></div>
          )}
          <div className="code-row">
            <span className="code-k">{T('code.changes')}</span>
            <span className="code-v">
              {counts.modified > 0 && <span className="code-chip m">{counts.modified} {T('code.modified')}</span>}
              {counts.added > 0 && <span className="code-chip a">{counts.added} {T('code.added')}</span>}
              {counts.deleted > 0 && <span className="code-chip d">{counts.deleted} {T('code.deleted')}</span>}
              {counts.untracked > 0 && <span className="code-chip u">{counts.untracked} {T('code.untracked')}</span>}
              {!counts.modified && !counts.added && !counts.deleted && !counts.untracked && <span className="muted">{T('code.clean')}</span>}
            </span>
          </div>

          {info.statusLines && info.statusLines.length > 0 && (
            <div className="code-status">
              <div className="code-k">{T('code.changes')}</div>
              <pre>{info.statusLines.join('\n')}</pre>
            </div>
          )}

          {info.commits && info.commits.length > 0 && (
            <div className="code-commits">
              <div className="code-k">{T('code.commits')}</div>
              <ul>
                {info.commits.map((c) => (
                  <li key={c.hash}><code>{c.hash.slice(0, 7)}</code> {c.message}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="code-diff">
        <div className="code-k">{T('code.diff')}</div>
        <div className="code-diff-grid">
          <textarea value={diffOld} onChange={(e) => setDiffOld(e.target.value)} placeholder="old text…" />
          <textarea value={diffNew} onChange={(e) => setDiffNew(e.target.value)} placeholder="new text…" />
        </div>
        <button onClick={runDiff}>{T('code.diff.run')}</button>
        {diffRes && (
          <div className="code-diff-out">
            {diffRes.hunks.map((h, i) => <div key={i} className={'diff-' + h.type}>{h.text}</div>)}
            <div className="muted">−{diffRes.removed} +{diffRes.added}</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Built-in Browser ----------
function normalizeUrl(url, cwd) {
  url = String(url || '').trim();
  if (!url) return null;
  // A local path (`/…`, `~/…`, `file://…`) is resolved in the main process so a
  // FOLDER becomes its index.html — a webview on a folder renders nothing.
  if (/^(file:|~\/|\/)/i.test(url) && window.autobot?.resolveUrl) return window.autobot.resolveUrl(url, cwd);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = 'https://' + url;
  return url;
}

function BrowserView({ cwd, previewUrl, onClose, onAttachInspect }) {
  // `launch` is the URL handed to <webview src> at mount and never changes afterwards.
  // `url` tracks the live location. Keeping src stable stops React from re-issuing a
  // navigation on every did-navigate (which aborted and duplicated in-flight loads).
  const [tabs, setTabs] = useState([{ id: 'tab1', launch: 'https://www.google.com', url: 'https://www.google.com', title: 'New Tab', loading: false }]);
  const [activeId, setActiveId] = useState('tab1');
  const [omnibox, setOmnibox] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findRes, setFindRes] = useState(null); // {active, total}
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);
  const menuBtnRef = useRef(null);
  useDismiss(menuOpen, [menuRef, menuBtnRef], () => setMenuOpen(false));
  const [expanded, setExpanded] = useState(false);   // ⌘↑ / ⌘↓
  const [responsive, setResponsive] = useState(false);
  const [cookiesShared, setCookiesShared] = useState(true);
  const [dev, setDev] = useState(null);             // {hasScript, script, running, port, framework}
  const [devBusy, setDevBusy] = useState(false);
  const [menuNote, setMenuNote] = useState('');
  const [inspectMode, setInspectMode] = useState(false);
  const [inspectedEl, setInspectedEl] = useState(null);
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const inspectModeRef = useRef(false);
  inspectModeRef.current = inspectMode;
  const webviews = useRef({});
  const omniboxRef = useRef(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

  // Cookies either ride the app's own partition (`persist:autobot`, shared with any
  // sign-in the user already did) or an isolated one. Switching remounts the
  // webviews, which is the only honest way to change a partition at runtime.
  const partition = cookiesShared ? 'persist:autobot' : 'persist:autobot-isolated';

  // Which dev server, if any, this project can start. Nothing is invented: the card
  // only renders when package.json has a dev-ish script (or a port is already live).
  useEffect(() => {
    if (!cwd || !window.autobot || !window.autobot.devServerDetect) return undefined;
    let cancelled = false;
    window.autobot.devServerDetect(cwd)
      .then((r) => { if (!cancelled && r && r.ok) setDev(r); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd]);

  // ⌘↑ expands the pane to the whole window, ⌘↓ (or Esc) puts it back.
  useEffect(() => {
    const onKey = (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === 'ArrowUp') { e.preventDefault(); setExpanded(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setExpanded(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => {
    if (!expanded) return undefined;
    const onEsc = (e) => {
      if (e.key === 'Escape' && document.activeElement !== omniboxRef.current) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onEsc);
    return () => window.removeEventListener('keydown', onEsc);
  }, [expanded]);

  const active = tabs.find((t) => t.id === activeId);
  const patchTab = (id, patch) => setTabs((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  const nextTabNum = useRef(2);

  const openTab = useCallback((url) => {
    const id = 'tab' + nextTabNum.current++;
    const launch = url || 'https://www.google.com';
    setTabs((ts) => [...ts, { id, launch, url: launch, title: 'New Tab', loading: true }]);
    setActiveId(id);
    setOmnibox(launch);
  }, []);

  const closeTab = (id) => {
    // Drop the dead <webview> handle: bindWebview skips ids it already knows,
    // and tools/menus must never drive a destroyed guest.
    const wv = webviews.current[id];
    if (wv) {
      try { const wid = wv.getWebContentsId(); if (wid) window.autobot.browserUnregister(wid); } catch {}
      delete webviews.current[id];
    }
    if (previewTabRef.current === id) previewTabRef.current = null;
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const remaining = tabs.filter((t) => t.id !== id);
    if (!remaining.length) {
      // Closing the last tab opens a fresh one AND selects it — the id used to
      // be minted inside the updater while activeId fell back to 'tab1', which
      // no longer existed, so the pane went blank.
      const nid = 'tab' + nextTabNum.current++;
      const home = 'https://www.google.com';
      setTabs([{ id: nid, launch: home, url: home, title: 'New Tab', loading: false }]);
      setActiveId(nid);
      setOmnibox(home);
      return;
    }
    setTabs((ts) => ts.filter((t) => t.id !== id));
    if (activeId === id) {
      const next = remaining[Math.min(idx, remaining.length - 1)];
      setActiveId(next.id);
      setOmnibox(next.url || '');
    }
  };

  const selectTab = (id) => {
    setActiveId(id);
    const t = tabs.find((x) => x.id === id);
    if (t) setOmnibox(t.url);
    // Re-point the agent's guest at the tab the user just picked.
    const wv = webviews.current[id];
    if (wv) {
      try { const wid = wv.getWebContentsId(); if (wid) window.autobot.browserRegister(wid); } catch {}
      try { const u = wv.getURL(); if (u) { patchTab(id, { url: u }); setOmnibox(u); } } catch {}
    }
  };

  const exitInspectMode = useCallback(async () => {
    setInspectMode(false);
    inspectModeRef.current = false;
    const wv = webviews.current[activeIdRef.current];
    if (wv && window.autobot && window.autobot.browserInspectSet) {
      try {
        const wid = wv.getWebContentsId();
        if (wid) await window.autobot.browserInspectSet(wid, false);
      } catch (_) {}
    }
  }, []);

  const enterInspectMode = useCallback(async () => {
    const wv = webviews.current[activeIdRef.current];
    if (!wv || !window.autobot || !window.autobot.browserInspectSet) return;
    setInspectMode(true);
    inspectModeRef.current = true;
    try {
      const wid = wv.getWebContentsId();
      if (wid) await window.autobot.browserInspectSet(wid, true);
    } catch (_) {}
  }, []);

  const toggleInspectMode = useCallback(() => {
    if (inspectModeRef.current) exitInspectMode();
    else enterInspectMode();
  }, [enterInspectMode, exitInspectMode]);

  useEffect(() => {
    if (!inspectMode) return undefined;
    const onEsc = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        exitInspectMode();
      }
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [inspectMode, exitInspectMode]);

  const bindWebview = (id) => (el) => {
    if (!el || webviews.current[id]) return;
    webviews.current[id] = el;
    const isActive = () => activeIdRef.current === id;
    el.addEventListener('did-start-loading', () => patchTab(id, { loading: true }));
    el.addEventListener('did-stop-loading', () => {
      patchTab(id, { loading: false });
      if (isActive() && inspectModeRef.current && window.autobot && window.autobot.browserInspectSet) {
        try {
          const wid = el.getWebContentsId();
          if (wid) window.autobot.browserInspectSet(wid, true).catch(() => {});
        } catch (_) {}
      }
    });
    el.addEventListener('did-navigate', (e) => { patchTab(id, { url: e.url }); if (isActive()) setOmnibox(e.url); });
    el.addEventListener('did-navigate-in-page', (e) => { patchTab(id, { url: e.url }); if (isActive()) setOmnibox(e.url); });
    el.addEventListener('page-title-updated', (e) => patchTab(id, { title: e.title || 'Untitled' }));
    el.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) patchTab(id, { loading: false }); });
    el.addEventListener('dom-ready', () => {
      try { const wid = el.getWebContentsId(); if (wid) window.autobot.browserRegister(wid); } catch {}
      try { const u = el.getURL(); patchTab(id, { url: u }); if (isActive()) setOmnibox(u); } catch {}
    });
    el.addEventListener('console-message', async (e) => {
      const msg = String((e && e.message) || '');
      if (!msg.startsWith('__AKRON_INSPECT__:')) return;
      try {
        const payload = JSON.parse(msg.slice('__AKRON_INSPECT__:'.length));
        if (!payload) return;
        if (payload.type === 'exit') {
          setInspectMode(false);
          inspectModeRef.current = false;
          return;
        }
        if (payload.type === 'select') {
          let shotDataUrl = '';
          try {
            const wid = el.getWebContentsId();
            if (wid && window.autobot && window.autobot.browserCaptureElement && payload.rect) {
              const r = await window.autobot.browserCaptureElement(wid, payload.rect);
              if (r && r.ok && r.dataUrl) shotDataUrl = r.dataUrl;
            }
          } catch (_) {}
          setInspectedEl({ ...payload, screenshot: shotDataUrl });
        }
      } catch (_) {}
    });
    el.addEventListener('new-window', (e) => { try { e.preventDefault(); if (e.url) openTab(e.url); } catch {} });
    el.addEventListener('found-in-page', (e) => setFindRes({ active: e.result.activeMatchOrdinal, total: e.result.matches }));
  };

  const navigate = (e) => {
    e.preventDefault();
    const wv = webviews.current[activeId];
    const raw = String(omnibox || '').trim();
    if (!wv || !raw) return;
    const go = (u) => {
      if (!u) return;
      patchTab(activeId, { loading: true });
      wv.loadURL(u);
    };
    const r = normalizeUrl(raw, cwd);
    if (r && typeof r.then === 'function') r.then(go).catch(() => {}); else go(r);
  };

  const goBack = () => { const wv = webviews.current[activeId]; if (wv && wv.canGoBack()) wv.goBack(); };
  const goForward = () => { const wv = webviews.current[activeId]; if (wv && wv.canGoForward()) wv.goForward(); };
  const reload = () => { const wv = webviews.current[activeId]; if (wv) wv.reload(); };
  const stopLoading = () => { const wv = webviews.current[activeId]; if (wv) wv.stop(); };
  const goHome = () => { const wv = webviews.current[activeId]; if (wv) wv.loadURL('https://www.google.com'); };

  const runFind = (text) => {
    setFindText(text);
    const wv = webviews.current[activeId];
    if (!wv) return;
    if (!text) { wv.stopFindInPage('clearSelection'); setFindRes(null); return; }
    wv.findInPage(text, { findNext: false, forward: true });
  };
  const closeFind = () => { runFind(''); setFindOpen(false); };

  // Keep the main process's copy of tab state fresh so agent tools can list tabs.
  useEffect(() => {
    if (!window.autobot || !window.autobot.browserSyncTabs) return;
    window.autobot.browserSyncTabs({ tabs: tabs.map((t) => ({ id: t.id, url: t.url, title: t.title })), activeId });
  }, [tabs, activeId]);

  // Agent tab commands (browser_tabs tool) → renderer tab actions.
  const handlersRef = useRef({});
  handlersRef.current = { openTab, closeTab, selectTab };
  useEffect(() => {
    if (!window.autobot || !window.autobot.onBrowserTabsCommand) return undefined;
    return window.autobot.onBrowserTabsCommand((cmd) => {
      if (!cmd || !cmd.type) return;
      const h = handlersRef.current;
      if (cmd.type === 'new') h.openTab(cmd.url);
      else if (cmd.type === 'close') h.closeTab(cmd.tabId || activeIdRef.current);
      else if (cmd.type === 'switch') h.selectTab(cmd.tabId);
    });
  }, []);

  // A generated page (Write / Artifact) opens right here. Without this the
  // "website" only existed as a chat code block and the pane kept showing
  // Google — the exact "the site was never made" complaint.
  const previewTabRef = useRef(null);
  useEffect(() => {
    const target = previewUrl && previewUrl.url;
    if (!target) return undefined;
    let cancelled = false;
    const apply = (u) => {
      if (cancelled || !u) return;
      const pid = previewTabRef.current;
      const wv = pid ? webviews.current[pid] : null;
      if (wv) {
        patchTab(pid, { loading: true });
        try { wv.loadURL(u); } catch (_) {}
        setActiveId(pid);
        setOmnibox(u);
        return;
      }
      const reuse = !pid && tabs.length === 1 && /google\.com/i.test(tabs[0].url || '');
      const id = pid || (reuse ? tabs[0].id : 'tab' + nextTabNum.current++);
      previewTabRef.current = id;
      setTabs((ts) => (reuse
        ? ts.map((t) => ({ ...t, launch: u, url: u, title: 'Preview', loading: true }))
        : ts.some((t) => t.id === id)
          ? ts.map((t) => (t.id === id ? { ...t, launch: u, url: u, loading: true } : t))
          : [...ts, { id, launch: u, url: u, title: 'Preview', loading: true }]));
      setActiveId(id);
      setOmnibox(u);
    };
    const r = normalizeUrl(target, cwd);
    if (r && typeof r.then === 'function') r.then(apply).catch(() => {}); else apply(r);
    return () => { cancelled = true; };
  }, [previewUrl, cwd]);

  // When the pane closes every <webview> is destroyed: clear the guest so tools
  // don't drive a dead WebContents, and re-open the pane on the next tool call.
  useEffect(() => () => {
    Object.values(webviews.current).forEach((wv) => {
      try { const wid = wv.getWebContentsId(); if (wid) window.autobot.browserUnregister(wid); } catch {}
    });
    try { window.autobot.browserUnregister(); } catch {}
  }, []);

  // ---- ··· menu actions -------------------------------------------------
  // Every handler returns a short, honest status string for the menu footer.
  const currentUrl = () => {
    const wv = webviews.current[activeId];
    try { const u = wv && wv.getURL(); if (u) return u; } catch {}
    return (active && active.url) || omnibox || '';
  };
  const note = (msg) => { setMenuNote(msg); };
  const openExternal = async (profile) => {
    const url = currentUrl();
    if (!url) return note('Nothing to open yet');
    const r = await window.autobot.browserOpenExternal(url, profile);
    if (r && r.ok) { note('Opened in ' + r.app); setMenuOpen(false); return; }
    if (r && r.fallback === 'default') {
      const r2 = await window.autobot.browserOpenExternal(url, 'default');
      if (r2 && r2.ok) { note('Brave not installed — opened in ' + r2.app); setMenuOpen(false); return; }
    }
    note((r && r.error) || 'Could not open the page');
  };
  const copyLink = async () => {
    const url = currentUrl();
    if (!url) return note('Nothing to copy yet');
    try { await navigator.clipboard.writeText(url); note('Link copied'); }
    catch { note('Clipboard unavailable'); }
  };
  const saveShot = async () => {
    const name = String((active && active.title) || 'screenshot').replace(/[^\w.-]+/g, '-').slice(0, 60);
    const r = await window.autobot.browserSaveScreenshot(name);
    if (r && r.ok) { note('Saved to ' + r.path); setMenuOpen(false); }
    else if (!(r && r.canceled)) note((r && r.error) || 'Screenshot failed');
  };
  const openHtml = async () => {
    const r = await window.autobot.browserOpenFile();
    if (r && r.ok) { openTab(r.url); setMenuOpen(false); note('Opened ' + r.path); }
  };
  const toggleResponsive = () => {
    setResponsive((v) => { note('Viewport: ' + (!v ? 'Responsive (390px)' : 'Fill pane')); return !v; });
  };
  const toggleCookies = () => {
    setCookiesShared((v) => {
      note('Cookies: ' + (!v ? 'Shared with app sign-ins' : 'Isolated browser jar'));
      return !v;
    });
  };
  const importCookies = async () => {
    const r = await window.autobot.browserImportCookies(partition);
    if (r && r.ok) { note('Imported ' + r.added + ' cookies' + (r.failed ? ' (' + r.failed + ' skipped)' : '')); reload(); }
    else if (!(r && r.canceled)) note((r && r.error) || 'Import failed');
  };
  const clearData = async () => {
    const r = await window.autobot.browserClearData(partition);
    if (r && r.ok) { note('Cookies, cache and storage cleared'); reload(); }
    else note((r && r.error) || 'Could not clear data');
  };
  const openDevTools = async () => {
    const wv = webviews.current[activeId];
    if (!wv) return note('Developer tools unavailable');
    try {
      if (window.autobot && window.autobot.browserToggleDevTools) {
        const wid = wv.getWebContentsId();
        const r = await window.autobot.browserToggleDevTools(wid);
        if (r && r.ok) {
          setDevToolsOpen(!!r.opened);
          setMenuOpen(false);
          note(r.opened ? 'Developer tools opened' : 'Developer tools closed');
          return;
        }
      }
      if (wv.isDevToolsOpened && wv.isDevToolsOpened()) {
        wv.closeDevTools();
        setDevToolsOpen(false);
      } else {
        wv.openDevTools();
        setDevToolsOpen(true);
      }
      setMenuOpen(false);
    } catch {
      note('Developer tools unavailable');
    }
  };

  const sendInspectedToAgent = () => {
    if (!inspectedEl || !onAttachInspect) return;
    const styleLines = Object.entries(inspectedEl.computedStyles || {})
      .map(([k, v]) => `  - \`${k}\`: \`${v}\``)
      .join('\n');
    const summary = [
      `# Inspected Browser Element`,
      `- **Page**: ${inspectedEl.title || 'Untitled'} (${inspectedEl.url || ''})`,
      `- **Element**: \`${inspectedEl.tagLabel || inspectedEl.tagName}\``,
      `- **CSS Selector**: \`${inspectedEl.selector}\``,
      styleLines ? `- **Computed Styles**:\n${styleLines}` : '',
      inspectedEl.innerText ? `- **Text**: ${JSON.stringify(inspectedEl.innerText)}` : '',
      `\`\`\`html\n${inspectedEl.outerHTML || ''}\n\`\`\``,
    ].filter(Boolean).join('\n');
    const atts = [
      {
        name: 'inspected-element.md',
        path: 'inspected-element.md',
        size: summary.length,
        isText: true,
        content: summary,
      },
    ];
    if (inspectedEl.screenshot) {
      atts.push({
        name: 'inspected-element.png',
        path: 'inspected-element.png',
        isImage: true,
        mimeType: 'image/png',
        dataUrl: inspectedEl.screenshot,
      });
    }
    onAttachInspect(atts);
    setInspectedEl(null);
    exitInspectMode();
  };
  const runDevServer = async () => {
    if (!cwd) return;
    setDevBusy(true);
    note('Starting ' + ((dev && dev.script) || 'dev server') + '…');
    try {
      const r = await window.autobot.devServerStart(cwd);
      if (r && r.ok && r.url) {
        openTab(r.url);
        setDev((d) => ({ ...(d || {}), running: true, port: r.port, url: r.url }));
        note('Dev server up on :' + r.port);
      } else if (r && r.ok && r.pending) {
        setDev((d) => ({ ...(d || {}), running: true }));
        note('Started — waiting for the port to answer');
      } else {
        note((r && r.error) || 'Could not start the dev server');
      }
    } finally {
      setDevBusy(false);
      setMenuOpen(false);
    }
  };

  return (
    <div className={'browser-panel' + (expanded ? ' expanded' : '')}>
      <div className="browser-tabs">
        <div className="browser-tab-strip">
          {tabs.map((t) => (
            <div key={t.id} className={'browser-tab ' + (t.id === activeId ? 'on' : '')} onClick={() => selectTab(t.id)} title={t.url}>
              {t.loading ? <Icon name="Spinner" size={12} className="spin" /> : <Icon name="Globe" size={12} />}
              <span className="browser-tab-title">{t.title || 'New Tab'}</span>
              <button className="browser-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><Icon name="X" size={11} /></button>
            </div>
          ))}
        </div>
        {/* The actions live in the tab row, pinned right, so they can never be
            squeezed out of the toolbar by a narrow pane. */}
        <div className="browser-tabs-actions">
          <button className="browser-act" onClick={() => openTab()} title="New tab"><Icon name="Add" size={14} /></button>
          <button
            className={'browser-act' + (expanded ? ' browser-restore-btn on' : '')}
            onClick={() => setExpanded(!expanded)}
            title={expanded ? 'Minimize / Restore side pane (⌘↓ or Esc)' : 'Expand (⌘↑)'}
          >
            <Icon name={expanded ? 'ArrowsIn' : 'ArrowsOut'} size={14} />
            {expanded && <span>Minimize</span>}
          </button>
          {expanded && onClose && (
            <button
              className="browser-act"
              onClick={() => { setExpanded(false); onClose(); }}
              title="Close browser pane"
            >
              <Icon name="X" size={14} />
            </button>
          )}
          <button ref={menuBtnRef} className={'browser-act browser-menu-btn' + (menuOpen ? ' on' : '')} onClick={() => { setMenuNote(''); setMenuOpen(!menuOpen); }} title="Browser options"><Icon name="DotsHorizontal" size={15} /></button>
        </div>
      </div>

      <div className="browser-toolbar">
        <button className="icon-btn" onClick={goBack} title="Back"><Icon name="ArrowLeft" size={16} /></button>
        <button className="icon-btn" onClick={goForward} title="Forward"><Icon name="ArrowRight" size={16} /></button>
        {active && active.loading
          ? <button className="icon-btn" onClick={stopLoading} title="Stop"><Icon name="X" size={15} /></button>
          : <button className="icon-btn" onClick={reload} title="Reload"><Icon name="ArrowClockwise" size={15} /></button>}
        <button className="icon-btn" onClick={goHome} title="Home"><Icon name="Home" size={15} /></button>
        <form className="omnibox" onSubmit={navigate}>
          <Icon name="Lock" size={12} className="omnibox-lock" />
          <input ref={omniboxRef} value={omnibox} onChange={(e) => setOmnibox(e.target.value)} placeholder="Search or enter address" spellCheck={false} />
        </form>
        <button
          type="button"
          className={'icon-btn browser-inspect-btn' + (inspectMode ? ' on' : '')}
          onClick={toggleInspectMode}
          title={inspectMode ? 'Exit Inspect Mode (Esc)' : 'Inspect Element'}
          aria-pressed={inspectMode}
        >
          <Icon name="Eye" size={15} />
        </button>
        <button
          type="button"
          className={'icon-btn browser-devtools-btn' + (devToolsOpen ? ' on' : '')}
          onClick={openDevTools}
          title="Toggle Preview DevTools"
          aria-pressed={devToolsOpen}
        >
          <Icon name="Wrench" size={14} />
        </button>
        <button className={'icon-btn' + (findOpen ? ' on' : '')} onClick={() => setFindOpen(!findOpen)} title="Find in page"><Icon name="Search" size={15} /></button>
      </div>

      {inspectMode && (
        <div className="browser-inspect-banner" role="status">
          <div className="browser-inspect-banner-left">
            <span className="browser-inspect-dot" />
            <span>
              <strong>Inspect Element</strong> — Hover to highlight, click any element to inspect &amp; capture
            </span>
          </div>
          <button type="button" className="browser-exit-inspect-btn" onClick={exitInspectMode}>
            Exit Inspect Mode <kbd>Esc</kbd>
          </button>
        </div>
      )}

      {menuOpen && (
        <div className="browser-menu" role="menu" ref={menuRef}>
          <button className="bm-item" role="menuitem" onClick={() => { setExpanded((v) => !v); setMenuOpen(false); }}>
            <Icon name={expanded ? 'ArrowsIn' : 'ArrowsOut'} size={14} />
            <span className="bm-label">{expanded ? 'Minimize to side pane' : 'Maximize browser'}</span>
          </button>
          <div className="bm-sep" />
          <button className="bm-item" role="menuitem" onClick={() => openExternal('brave')}><Icon name="ArrowUpRight" size={14} /><span className="bm-label">Open in Brave Browser</span></button>
          <button className="bm-item" role="menuitem" onClick={() => openExternal('default')}><Icon name="Globe" size={14} /><span className="bm-label">Open in default browser</span></button>
          <button className="bm-item" role="menuitem" onClick={copyLink}><Icon name="Copy" size={14} /><span className="bm-label">Copy link</span></button>
          <button className="bm-item" role="menuitem" onClick={saveShot}><Icon name="Camera" size={14} /><span className="bm-label">Save screenshot</span></button>
          <button className="bm-item" role="menuitem" onClick={openHtml}><Icon name="Code" size={14} /><span className="bm-label">Open HTML file…</span></button>
          <div className="bm-sep" />
          <button className="bm-item" role="menuitem" onClick={toggleResponsive}><Icon name="Frame" size={14} /><span className="bm-label">Viewport</span><span className="bm-value">{responsive ? 'Responsive' : 'Fill'}</span></button>
          <button className="bm-item" role="menuitem" onClick={openDevTools}><Icon name="Wrench" size={14} /><span className="bm-label">More settings · Developer tools</span></button>
          <div className="bm-sep" />
          <button className="bm-item" role="menuitem" onClick={importCookies}><Icon name="Download" size={14} /><span className="bm-label">Import cookies…</span></button>
          <button className="bm-item" role="menuitem" onClick={toggleCookies}><Icon name={cookiesShared ? 'Share' : 'Lock'} size={14} /><span className="bm-label">Keep cookies</span><span className="bm-value">{cookiesShared ? 'Shared' : 'Isolated'}</span></button>
          <button className="bm-item danger" role="menuitem" onClick={clearData}><Icon name="Broom" size={14} /><span className="bm-label">Clear browsing data</span></button>
          {menuNote && <div className="bm-note">{menuNote}</div>}
        </div>
      )}

      {findOpen && (
        <div className="browser-find">
          <input autoFocus value={findText} onChange={(e) => runFind(e.target.value)} placeholder="Find in page…" />
          <span className="find-res">{findRes ? `${findRes.active}/${findRes.total}` : ''}</span>
          <button className="icon-btn" onClick={() => runFind('')}><Icon name="X" size={13} /></button>
        </div>
      )}

      {dev && (dev.hasScript || dev.running) && (
        <div className={'devfound' + (dev.running ? ' running' : '')}>
          <span className="devfound-dot" />
          <span className="devfound-text">
            <b>Dev server {dev.running ? 'running' : 'found'}</b>
            <span className="devfound-sub">
              {dev.script ? dev.script + ' · ' : ''}{dev.framework}{dev.port ? ' :' + dev.port : ''}
            </span>
          </span>
          {dev.running && dev.url ? (
            <button className="devfound-btn" onClick={() => openTab(dev.url)}>Open</button>
          ) : (
            <button className="devfound-btn" disabled={devBusy || !dev.hasScript} onClick={runDevServer}>
              {devBusy ? 'Starting…' : 'Run'}
            </button>
          )}
        </div>
      )}

      <div className={'browser-stage' + (responsive ? ' responsive' : '')}>
        {tabs.map((t) => (
          <webview
            key={t.id + ':' + partition}
            ref={bindWebview(t.id)}
            className="browser-webview"
            style={{ display: t.id === activeId ? 'flex' : 'none' }}
            src={t.launch || t.url}
            partition={partition}
          />
        ))}
        {inspectedEl && (
          <div className="browser-inspect-card" role="region" aria-label="Inspected element details">
            <div className="bic-head">
              <span className="bic-tag">{inspectedEl.tagLabel || inspectedEl.tagName}</span>
              <button type="button" className="icon-btn" onClick={() => setInspectedEl(null)} title="Dismiss"><Icon name="X" size={12} /></button>
            </div>
            <div className="bic-body">
              {inspectedEl.screenshot && (
                <img className="bic-shot" src={inspectedEl.screenshot} alt={inspectedEl.tagLabel || 'Inspected element'} />
              )}
              <code className="bic-selector" title={inspectedEl.selector}>{inspectedEl.selector}</code>
              <div className="bic-styles">
                {Object.entries(inspectedEl.computedStyles || {}).slice(0, 6).map(([k, v]) => (
                  <span key={k} className="bic-style-chip">{k}: {String(v).slice(0, 28)}</span>
                ))}
              </div>
              {inspectedEl.outerHTML && (
                <details className="bic-html-details">
                  <summary>outerHTML ({inspectedEl.outerHTML.length} chars)</summary>
                  <pre className="bic-html">{inspectedEl.outerHTML.slice(0, 800)}</pre>
                </details>
              )}
            </div>
            <div className="bic-actions">
              <button type="button" className="bic-btn primary" onClick={sendInspectedToAgent}>
                <Icon name="Sparkles" size={12} /> Send to Agent
              </button>
              <button
                type="button"
                className="bic-btn"
                onClick={() => { navigator.clipboard?.writeText(inspectedEl.selector || '').catch(() => {}); note('Selector copied'); }}
              >
                Copy Selector
              </button>
              <button
                type="button"
                className="bic-btn"
                onClick={() => { navigator.clipboard?.writeText(inspectedEl.outerHTML || '').catch(() => {}); note('HTML copied'); }}
              >
                Copy HTML
              </button>
              {inspectMode && (
                <button type="button" className="bic-btn" onClick={exitInspectMode}>Exit Inspect Mode</button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const PANE_TAB_META = [
  { id: 'review', label: 'Review', icon: 'File' },
  { id: 'subagents', label: 'Subagents', icon: 'GitBranch' },
  { id: 'files', label: 'Files', icon: 'Files' },
  { id: 'terminal', label: 'Terminal', icon: 'CommandLine' },
  { id: 'browser', label: 'Browser', icon: 'Globe' },
  { id: 'runlog', label: 'Background Tasks', icon: 'Activity' },
  { id: 'env', label: 'Environment', icon: 'DotsHorizontal' },
];

function SubagentsPane({ subAgents = [], swarmInfo = null, swarmBoard = [] }) {
  const counts = { active: 0, done: 0, error: 0 };
  for (const a of subAgents) {
    if (a.status === 'running' || a.status === 'working' || a.status === 'waiting' || a.status === 'queued') counts.active++;
    else if (a.status === 'error') counts.error++;
    else counts.done++;
  }
  return (
    <div className="subagents-pane">
      <div className="sa-summary">
        <div className="sa-summary-title">
          <Icon name="GitBranch" size={15} />
          <span>Subagents</span>
          <span className="sa-count-pill">{subAgents.length}</span>
        </div>
        <div className="sa-summary-stats">
          {counts.active > 0 && <span className="mc-pill working">{counts.active} active</span>}
          {counts.done > 0 && <span className="mc-pill done">{counts.done} completed</span>}
          {counts.error > 0 && <span className="mc-pill err">{counts.error} error</span>}
        </div>
      </div>
      {subAgents.length === 0 && !swarmInfo ? (
        <div className="sa-empty">
          <Icon name="AgentsSimple" size={28} />
          <div className="sa-empty-title">No subagents yet in this turn</div>
          <div className="sa-empty-sub">When the agent delegates subtasks (`Task` / `Agent`) or starts a Swarm wave, every worker, model, failover, and board message appears here.</div>
        </div>
      ) : (
        <MissionControl subAgents={subAgents} swarmInfo={swarmInfo} swarmBoard={swarmBoard} />
      )}
    </div>
  );
}

// ---------- Session pane (Antigravity tabbed right pane) ----------
function SessionPane({ icon, title, activeType, openTabs = [], onSelectTab, onCloseTab, badges = {}, width, onWidth, onHide, children }) {
  const dragRef = useRef(null);
  const startX = useRef(0);
  const startW = useRef(0);
  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef(null);
  useDismiss(addOpen, [addRef], () => setAddOpen(false));

  const onDragStart = (e) => {
    e.preventDefault();
    e.stopPropagation();
    startX.current = e.clientX;
    startW.current = width;
    const onMove = (ev) => {
      const dx = startX.current - ev.clientX; // drag left widens, right narrows
      onWidth(Math.max(320, Math.min(900, startW.current + dx)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.classList.remove('pane-resizing');
    };
    document.body.classList.add('pane-resizing');
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const tabIds = openTabs && openTabs.length ? openTabs : (activeType ? [activeType] : []);

  return (
    <div className="session-pane" style={{ width }}>
      <div ref={dragRef} className="session-pane-divider" onMouseDown={onDragStart} title="Drag to resize" />
      <div className="session-pane-head">
        <div className="sp-tab-strip">
          {tabIds.length > 0 ? tabIds.map((tid) => {
            const meta = PANE_TAB_META.find((m) => m.id === tid) || { id: tid, label: title, icon };
            const badge = badges[tid];
            return (
              <div
                key={tid}
                className={'sp-tab' + (tid === activeType ? ' on' : '')}
                onClick={() => onSelectTab && onSelectTab(tid)}
                title={meta.label}
              >
                <Icon name={meta.icon} size={13} />
                <span className="sp-tab-label">{meta.label}</span>
                {badge > 0 && <span className="sp-tab-badge">{badge}</span>}
                <button
                  type="button"
                  className="sp-tab-x"
                  onClick={(e) => { e.stopPropagation(); if (onCloseTab) onCloseTab(tid); else if (onHide) onHide(); }}
                  title={'Close ' + meta.label}
                  aria-label={'Close ' + meta.label}
                >
                  <Icon name="X" size={11} />
                </button>
              </div>
            );
          }) : (
            <div className="sp-tab on">
              <Icon name={icon} size={14} />
              <span className="sp-tab-label">{title}</span>
              <button
                type="button"
                className="sp-tab-x"
                onClick={(e) => { e.stopPropagation(); if (onHide) onHide(); }}
                title={'Close ' + title}
                aria-label={'Close ' + title}
              >
                <Icon name="X" size={11} />
              </button>
            </div>
          )}
          <div className="sp-add-wrap" ref={addRef}>
            <button
              type="button"
              className={'icon-btn sp-add-btn' + (addOpen ? ' active' : '')}
              onClick={() => setAddOpen((v) => !v)}
              title="Open view tab (Review, Subagents, Files, Terminal, Browser)"
            >
              <Icon name="Add" size={14} />
            </button>
            {addOpen && (
              <div className="sp-add-menu">
                {PANE_TAB_META.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    className={'sp-add-item' + (m.id === activeType ? ' on' : '')}
                    onClick={() => { setAddOpen(false); onSelectTab && onSelectTab(m.id); }}
                  >
                    <Icon name={m.icon} size={13} />
                    <span>{m.label}</span>
                    {badges[m.id] > 0 && <span className="conv-pop-count">{badges[m.id]}</span>}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <button type="button" className="icon-btn session-pane-hide" onClick={(e) => { e.stopPropagation(); onHide && onHide(); }} title={'Close ' + title} aria-label={'Close ' + title}><Icon name="X" size={15} /></button>
      </div>
      <div className="session-pane-body">{children}</div>
    </div>
  );
}

// ---------- Subscription model list (Claude Max / ChatGPT / Antigravity / Grok) ----------
// A signed-in account can expose dozens of models — Antigravity returns 38 — which
// used to render as one flat, unscrollable column that buried the current pick.
// Group them by family, add a filter once the list gets long, cap the height with
// its own scroll, and scroll the active model into view on open.
function ProvModelList({ list, picked, onPick }) {
  const [q, setQ] = useState('');
  const boxRef = useRef(null);
  const selRef = useRef(null);

  // Grouping rule: the provider (this menu's account) is the ONLY shelf — the
  // same convention opencode uses. Sub-shelves by model family would re-slice a
  // single provider into Gemini/Claude/… headers, so instead every model in the
  // account renders in one natural-sorted list and the model's serving family
  // shows up as an inline tag only when the account mixes families.
  const famLabel = (g) => {
    const s = String(g || '').trim();
    if (!s) return '';
    const api = s.match(/^API_PROVIDER_([A-Za-z0-9_]+)$/);
    if (api) {
      const known = { openai: 'OpenAI', vertex: 'Vertex', anthropic: 'Anthropic', google: 'Google', azure: 'Azure' };
      return api[1].toLowerCase().split('_').filter(Boolean)
        .map((p) => known[p] || p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
    }
    return s.charAt(0).toUpperCase() + s.slice(1);
  };

  const { rows, total, mixed } = useMemo(() => {
    const query = q.trim().toLowerCase();
    const all = [];
    const fams = new Set();
    for (const raw of list || []) {
      const m = typeof raw === 'string' ? { id: raw, label: raw } : (raw || {});
      const id = String(m.id || '');
      if (!id) continue;
      const label = String(m.label || id);
      const fam = famLabel(m.group);
      if (fam) fams.add(fam);
      if (query && !(id.toLowerCase().includes(query) || label.toLowerCase().includes(query))) continue;
      all.push({ ...m, id, label, fam });
    }
    all.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
    return { rows: all, total: (list || []).length, mixed: fams.size > 1 };
  }, [list, q]);

  // Bring the selected model into view once the catalog has populated.
  useEffect(() => {
    const el = selRef.current, box = boxRef.current;
    if (!el || !box) return;
    const eb = el.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (eb.top < bb.top || eb.bottom > bb.bottom) {
      box.scrollTop += (eb.top - bb.top) - (box.clientHeight - el.offsetHeight) / 2;
    }
  }, [picked, total]);
  return (
    <div className="prov-models">
      {total > 12 && (
        <div className="prov-search">
          <Icon name="Search" size={12} />
          <input
            className="prov-search-in"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Filter ${total} models…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && <button className="prov-search-x" onClick={() => setQ('')} title="Clear"><Icon name="X" size={11} /></button>}
        </div>
      )}
      <div className="prov-model-scroll" ref={boxRef}>
        {!total && <div className="prov-none">Loading models…</div>}
        {total > 0 && !rows.length && <div className="prov-none">No models match “{q}”.</div>}
        {rows.map((m) => {
          const on = picked === m.id;
          return (
            <button
              key={m.id}
              ref={on ? selRef : null}
              className={'model-opt prov-model' + (on ? ' on' : '')}
              title={m.id + (m.windowLabel ? ' · ' + m.windowLabel + ' context' : '')}
              onClick={() => onPick(m.id)}
            >
              <span className="model-opt-name">{m.label}</span>
              {m.tag && <span className="prov-model-tag">{m.tag}</span>}
              {mixed && m.fam && <span className="prov-model-fam">{m.fam}</span>}
              {on && <Icon name="Check" size={13} className="model-check" />}
              <span className="model-opt-prov">{m.windowLabel || ''}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ---------- Session model list (presets + locally-installed catalogs) ----------
// The FreeLLMAPI router alone contributes ~1050 installed models, and the menu
// used to render every one of them as a flat row in a 340 px box. Same shell as
// the subscription list: group by provider, filter when long, one capped scroll,
// and put the group holding the current pick first so it is visible on open.
const SESSION_SHELF_CAP = 30;

function SessionModelList({ rows, isActive, renderRow }) {
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState({});
  const boxRef = useRef(null);
  const selRef = useRef(null);

  const groups = useMemo(() => {
    const query = q.trim().toLowerCase();
    const buckets = new Map();
    for (const r of rows || []) {
      if (query) {
        const hay = (String(r.label || '') + ' ' + String(r.model || '') + ' ' + String(r.prov || '') + ' ' + String((r.preset && r.preset.name) || '')).toLowerCase();
        if (!hay.includes(query)) continue;
      }
      const fam = String(r.prov || 'Other').replace(/\s*·\s*installed$/, '');
      if (!buckets.has(fam)) buckets.set(fam, { fam, installed: false, items: [] });
      const g = buckets.get(fam);
      if (/·\s*installed$/.test(String(r.prov || ''))) g.installed = true;
      g.items.push(r);
    }
    const list = Array.from(buckets.values());
    // Active group first, otherwise keep preset order (local → paid).
    const ai = list.findIndex((g) => g.items.some((r) => isActive(r)));
    if (ai > 0) list.unshift(list.splice(ai, 1)[0]);
    return list;
  }, [rows, q]);

  const total = (rows || []).length;
  const searching = !!q.trim();

  // A router catalog can be 1000+ models. Mounting all of them inside one
  // scroll box makes the shelf 35 000 px tall and the menu unusable, so each
  // shelf mounts a bounded slice — the current pick is pinned to the top of
  // its slice when it would otherwise fall outside it — and "Show all" opens
  // the rest on demand. A filter query lifts the cap.
  const shelf = (g) => {
    const cap = searching ? 400 : (expanded[g.fam] ? Infinity : SESSION_SHELF_CAP);
    if (!isFinite(cap) || g.items.length <= cap) return { shown: g.items, hidden: 0 };
    const ai = g.items.findIndex((r) => isActive(r));
    if (ai >= cap) {
      return { shown: [g.items[ai], ...g.items.slice(0, cap - 1)], hidden: g.items.length - cap, pinned: true };
    }
    return { shown: g.items.slice(0, cap), hidden: g.items.length - cap };
  };

  useEffect(() => {
    const el = selRef.current, box = boxRef.current;
    if (!el || !box) return;
    const eb = el.getBoundingClientRect(), bb = box.getBoundingClientRect();
    if (eb.top < bb.top || eb.bottom > bb.bottom) {
      box.scrollTop += (eb.top - bb.top) - (box.clientHeight - el.offsetHeight) / 2;
    }
  }, [q, total, expanded]);

  return (
    <>
      {total > 12 && (
        <div className="prov-search">
          <Icon name="Search" size={12} />
          <input
            className="prov-search-in"
            type="text"
            autoComplete="off"
            spellCheck={false}
            placeholder={`Filter ${total} models…`}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          {q && <button className="prov-search-x" onClick={() => setQ('')} title="Clear"><Icon name="X" size={11} /></button>}
        </div>
      )}
      <div className="prov-model-scroll" ref={boxRef}>
        {total > 0 && !groups.length && <div className="prov-none">No models match “{q}”.</div>}
        {groups.map((g) => {
          const { shown, hidden, pinned } = shelf(g);
          return (
            <div key={g.fam} className="prov-fam">
              <div className="prov-fam-head">
                <span className="prov-fam-name">{g.fam}</span>
                {g.installed && <span className="prov-model-tag">installed</span>}
                <span className="prov-fam-count">{g.items.length}</span>
              </div>
              {shown.map((r) => {
                const active = isActive(r);
                const node = renderRow(r);
                if (!active) return node;
                return React.cloneElement(node, { ref: selRef });
              })}
              {hidden > 0 && (
                <button className="prov-more" onClick={() => setExpanded((e) => ({ ...e, [g.fam]: true }))}>
                  Show all {g.items.length}{pinned ? ' · current pick pinned above' : ''}
                </button>
              )}
              {!hidden && expanded[g.fam] && g.items.length > SESSION_SHELF_CAP && !searching && (
                <button className="prov-more" onClick={() => setExpanded((e) => ({ ...e, [g.fam]: false }))}>
                  Show fewer
                </button>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ---------- Input bar (composer) — Example parity: model-selector pill bottom-left, attach + style + think + send right ----------
const PERM_MODES = [
  { id: 'auto',        title: 'perm.auto',        desc: 'perm.autoDesc',        icon: 'LockOpen' },
  { id: 'ask',         title: 'perm.manual',      desc: 'perm.manualDesc',      icon: 'LockShield' },
  { id: 'acceptEdits', title: 'perm.acceptEdits', desc: 'perm.acceptEditsDesc', icon: 'Lock' },
  { id: 'plan',        title: 'perm.plan',        desc: 'perm.planDesc',        icon: 'Sliders' },
  { id: 'bypass',      title: 'perm.bypass',      desc: 'perm.bypassDesc',      icon: 'Keyboard' },
];
const PERM_SHORT = { auto: 'perm.auto', ask: 'perm.manual', acceptEdits: 'perm.acceptEdits', plan: 'perm.plan', bypass: 'perm.bypass' };

const BUILTIN_MENTION_AGENTS = [
  { name: 'verifier', kind: 'agent', description: 'Run independent tests & adversarial build verification' },
  { name: 'code-reviewer', kind: 'agent', description: 'Review pending changes for bugs, security & conventions' },
  { name: 'Explore', kind: 'agent', description: 'Fast codebase search & architecture trace subagent' },
  { name: 'Plan', kind: 'agent', description: 'Read-only planning & design subagent' },
];

function EnvironmentPicker({ envState, onSwitchEnvironment, onOpenEnvironments }) {
  const [open, setOpen] = useState(false);
  const [sshOpen, setSshOpen] = useState(false);
  const [remoteOpen, setRemoteOpen] = useState(false);
  const [sshQuery, setSshQuery] = useState('');
  const wrapRef = useRef(null);
  useDismiss(open, [wrapRef], () => { setOpen(false); setSshOpen(false); setRemoteOpen(false); });

  const active = (envState && envState.active) || { kind: 'local', id: null, label: 'This Computer' };
  const isRemote = active.kind === 'ssh' || active.kind === 'remote';
  const sshAll = [
    ...((envState && envState.sshConfigHosts) || []),
    ...((envState && envState.sshProfiles) || []),
  ];
  const sshFiltered = sshQuery.trim()
    ? sshAll.filter((h) => (`${h.name} ${h.host} ${h.username}`).toLowerCase().includes(sshQuery.trim().toLowerCase()))
    : sshAll;
  const remotes = (envState && envState.remoteProfiles) || [];

  return (
    <div className="env-picker-wrap" ref={wrapRef}>
      <button
        type="button"
        className={'env-picker-btn' + (isRemote ? ' remote' : '')}
        onClick={() => { setOpen((v) => !v); setSshOpen(false); setRemoteOpen(false); }}
        title="Switch execution environment (This Computer · SSH Host · Remote Server)"
      >
        <span className={'env-status-dot' + (isRemote ? ' on' : '')} />
        <Icon name={active.kind === 'remote' ? 'Globe' : (active.kind === 'ssh' ? 'CommandLine' : 'Window')} size={12} />
        <span>{active.label || 'This Computer'}</span>
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>

      {open && (
        <div className="env-menu" role="menu">
          <button
            type="button"
            className={'env-menu-row' + (active.kind === 'local' ? ' on' : '')}
            onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'local' }); setOpen(false); }}
          >
            <Icon name="Window" size={14} />
            <div className="env-menu-row-meta">
              <span className="env-menu-row-title">This Computer</span>
              <span className="env-menu-row-sub">Runs on this machine</span>
            </div>
            {active.kind === 'local' && <Icon name="Check" size={13} />}
          </button>

          <button
            type="button"
            className={'env-menu-row' + (active.kind === 'remote' || remoteOpen ? ' on' : '')}
            onClick={() => { setRemoteOpen((v) => !v); setSshOpen(false); }}
          >
            <Icon name="Globe" size={14} />
            <div className="env-menu-row-meta">
              <span className="env-menu-row-title">Remote</span>
              <span className="env-menu-row-sub">{remotes.length ? `${remotes.length} configured server(s)` : 'Runs in a cloud environment'}</span>
            </div>
            <span style={{ opacity: 0.65 }}>›</span>
          </button>

          <button
            type="button"
            className={'env-menu-row' + (active.kind === 'ssh' || sshOpen ? ' on' : '')}
            onClick={() => { setSshOpen((v) => !v); setRemoteOpen(false); }}
          >
            <Icon name="CommandLine" size={14} />
            <div className="env-menu-row-meta">
              <span className="env-menu-row-title">SSH Host</span>
              <span className="env-menu-row-sub">{sshAll.length ? `${sshAll.length} host(s) available` : 'Connect via SSH'}</span>
            </div>
            <span style={{ opacity: 0.65 }}>›</span>
          </button>

          {sshOpen && (
            <div className="env-flyout">
              <div className="env-flyout-search">
                <Icon name="Search" size={12} />
                <input
                  value={sshQuery}
                  onChange={(e) => setSshQuery(e.target.value)}
                  placeholder="Search Hosts..."
                  autoFocus
                />
              </div>
              {sshFiltered.some((h) => h.source === 'ssh-config') && (
                <div className="env-flyout-sect">SSH Config</div>
              )}
              {sshFiltered.filter((h) => h.source === 'ssh-config').map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={'env-menu-row' + (active.kind === 'ssh' && active.id === h.id ? ' on' : '')}
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'ssh', id: h.id, cwd: h.remoteCwd || '' }); setOpen(false); }}
                >
                  <Icon name="CommandLine" size={13} />
                  <div className="env-menu-row-meta">
                    <span className="env-menu-row-title">{h.name}</span>
                    <span className="env-menu-row-sub">{h.username ? `${h.username}@` : ''}{h.host}</span>
                  </div>
                  {active.kind === 'ssh' && active.id === h.id && <Icon name="Check" size={12} />}
                </button>
              ))}
              {sshFiltered.some((h) => h.source !== 'ssh-config') && (
                <div className="env-flyout-sect">Saved Hosts</div>
              )}
              {sshFiltered.filter((h) => h.source !== 'ssh-config').map((h) => (
                <button
                  key={h.id}
                  type="button"
                  className={'env-menu-row' + (active.kind === 'ssh' && active.id === h.id ? ' on' : '')}
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'ssh', id: h.id, cwd: h.remoteCwd || '' }); setOpen(false); }}
                >
                  <Icon name="CommandLine" size={13} />
                  <div className="env-menu-row-meta">
                    <span className="env-menu-row-title">{h.name}</span>
                    <span className="env-menu-row-sub">{h.username ? `${h.username}@` : ''}{h.host}</span>
                  </div>
                  {active.kind === 'ssh' && active.id === h.id && <Icon name="Check" size={12} />}
                </button>
              ))}
              <div className="env-sep" />
              <button
                type="button"
                className="env-menu-row"
                onClick={() => { setOpen(false); onOpenEnvironments && onOpenEnvironments(); }}
              >
                <Icon name="Add" size={13} />
                <span className="env-menu-row-title">Connect to SSH Host...</span>
              </button>
            </div>
          )}

          {remoteOpen && (
            <div className="env-flyout">
              <div className="env-flyout-sect">Remote Servers</div>
              {remotes.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={'env-menu-row' + (active.kind === 'remote' && active.id === r.id ? ' on' : '')}
                  onClick={() => { onSwitchEnvironment && onSwitchEnvironment({ kind: 'remote', id: r.id, cwd: r.remoteCwd || '' }); setOpen(false); }}
                >
                  <Icon name="Globe" size={13} />
                  <div className="env-menu-row-meta">
                    <span className="env-menu-row-title">{r.name}</span>
                    <span className="env-menu-row-sub">{r.url}</span>
                  </div>
                  {active.kind === 'remote' && active.id === r.id && <Icon name="Check" size={12} />}
                </button>
              ))}
              <div className="env-sep" />
              <button
                type="button"
                className="env-menu-row"
                onClick={() => { setOpen(false); onOpenEnvironments && onOpenEnvironments(); }}
              >
                <Icon name="Add" size={13} />
                <span className="env-menu-row-title">Connect to Remote Server...</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function InputBar({ streaming, paused, onPause, onResume, send, stop, inputRef, cwd, setCwd, runSlashCommand, provider, setProvider, providerKeys, setProviderKeys, modelMenuOpen, setModelMenuOpen, openSettings, attachments, setAttachments, reasoningLevel, setReasoningLevel, swarmEnabled, setSwarmEnabled, styleId, setStyleId, webSearch, setWebSearch, dictating, setDictating, voiceMode, startVoiceMode, stopVoiceMode, sessionPane, toggleSessionPane, permissions, setPermissions, queued, queuePaused, onToggleQueuePaused, onClearQueue, onToggleQueueItemPaused, onReorderQueue, onStepQueueItem, onUpdateQueueItemText, unqueue, sendQueuedNow, lastUsage, settings, onVoiceError, gdriveState, onOpenGdrive, envState, onSwitchEnvironment, onOpenEnvironments, T }) {
  const [reasonOpen, setReasonOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  const [addCtxOpen, setAddCtxOpen] = useState(false);
  const [inputText, setInputText] = useState(() => (inputRef.current && inputRef.current.value) || '');
  const [slashActions, setSlashActions] = useState([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [mentionFiles, setMentionFiles] = useState([]);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const addCtxWrapRef = useRef(null);
  const slashPaletteRef = useRef(null);
  const mentionPaletteRef = useRef(null);
  useDismiss(addCtxOpen, [addCtxWrapRef], () => setAddCtxOpen(false));

  const refreshSlashActions = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.listSlashActions) {
        const list = await window.autobot.listSlashActions(cwd);
        if (Array.isArray(list)) setSlashActions(list);
      }
    } catch (_) {}
  }, [cwd]);
  useEffect(() => { refreshSlashActions(); }, [refreshSlashActions]);

  // Slash token detection: active whenever text starts with `/<token>` (no spaces/newlines yet),
  // regardless of whether attachments are present in the composer (Antigravity Screenshot 2 parity).
  const slashMatch = /^\/([^\s\n]*)$/.exec(inputText);
  const slashQuery = slashMatch ? slashMatch[1].toLowerCase() : null;
  const filteredSlashActions = useMemo(() => {
    if (slashQuery === null) return [];
    const list = slashActions || [];
    if (!slashQuery) return list.slice(0, 60);
    const hits = [];
    for (const item of list) {
      const n = String(item.name || '').toLowerCase();
      const d = String(item.description || '').toLowerCase();
      const al = (item.aliases || []).some((x) => String(x).toLowerCase().includes(slashQuery));
      let rank = 99;
      if (n.startsWith(slashQuery)) rank = 0;
      else if (n.includes(slashQuery) || al) rank = 1;
      else if (d.includes(slashQuery)) rank = 2;
      if (rank < 99) hits.push({ item, rank });
    }
    hits.sort((a, b) => a.rank - b.rank);
    return hits.slice(0, 40).map((h) => h.item);
  }, [slashQuery, slashActions]);
  const slashOpen = slashQuery !== null && !slashDismissed && filteredSlashActions.length > 0;
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  // @ Mentions detection when typing `@<query>` (either empty or immediately after whitespace)
  const mentionMatch = !slashOpen ? /(?:^|\s)@([^\s@\n]*)$/.exec(inputText) : null;
  const mentionQuery = mentionMatch ? mentionMatch[1] : null;
  useEffect(() => {
    if (mentionQuery === null || mentionDismissed) return;
    let cancelled = false;
    Promise.resolve(window.autobot && window.autobot.listWorkspaceFiles ? window.autobot.listWorkspaceFiles(cwd, mentionQuery) : [])
      .then((list) => { if (!cancelled && Array.isArray(list)) setMentionFiles(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [mentionQuery, mentionDismissed, cwd]);

  const mentionItems = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    const agents = BUILTIN_MENTION_AGENTS
      .filter((a) => !q || a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q))
      .map((a) => ({ id: 'agent:' + a.name, label: '@' + a.name, insert: '@' + a.name + ' ', kind: 'agent', sub: a.description }));
    const files = (mentionFiles || []).map((f) => ({
      id: 'file:' + f.path,
      label: f.path,
      insert: '@' + f.path + ' ',
      kind: 'file',
      sub: f.name,
      fileObj: f,
    }));
    return [...agents, ...files].slice(0, 25);
  }, [mentionQuery, mentionFiles]);
  const mentionOpen = mentionQuery !== null && !mentionDismissed && mentionItems.length > 0;
  useEffect(() => { setMentionIdx(0); }, [mentionQuery]);

  const syncInputState = useCallback((val) => {
    setInputText(val);
    setHasText(!!String(val || '').trim());
    setSlashDismissed(false);
    setMentionDismissed(false);
  }, []);

  const applySlashItem = useCallback((item, mode = 'enter') => {
    if (!item || !inputRef.current) return;
    const el = inputRef.current;
    if (mode === 'tab' || item.takesArgs) {
      const next = '/' + item.name + ' ';
      el.value = next;
      syncInputState(next);
      el.focus();
      try { el.setSelectionRange(next.length, next.length); } catch (_) {}
      setSlashDismissed(true);
      return;
    }
    el.value = '';
    syncInputState('');
    runSlashCommand(item.name);
  }, [inputRef, runSlashCommand, syncInputState]);

  const applyMentionItem = useCallback((item) => {
    if (!item || !inputRef.current) return;
    const el = inputRef.current;
    const cur = el.value || '';
    const updated = cur.replace(/(^|\s)@([^\s@\n]*)$/, '$1' + item.insert);
    el.value = updated;
    syncInputState(updated);
    el.focus();
    try { el.setSelectionRange(updated.length, updated.length); } catch (_) {}
    setMentionDismissed(true);
  }, [inputRef, syncInputState]);

  const attachFolderContext = useCallback(async () => {
    setAddCtxOpen(false);
    if (!window.autobot || !window.autobot.pickFolder) return;
    const dir = await window.autobot.pickFolder();
    if (!dir) return;
    let listing = '';
    try {
      const files = await window.autobot.listWorkspaceFiles(dir, '');
      if (Array.isArray(files) && files.length) {
        listing = '\nFiles:\n' + files.slice(0, 30).map((f) => `- ${f.path}`).join('\n');
      }
    } catch (_) {}
    const folderName = dir.split('/').filter(Boolean).pop() || dir;
    setAttachments((a) => [...a, {
      name: `📁 ${folderName}`,
      path: dir,
      size: 0,
      isText: true,
      content: `Attached workspace folder context: ${dir}${listing}`,
    }]);
  }, [setAttachments]);

  const attachBrowserContext = useCallback(async () => {
    setAddCtxOpen(false);
    try {
      const ext = window.autobot && window.autobot.extBridgeStatus ? await window.autobot.extBridgeStatus() : null;
      const liveTab = ext && Array.isArray(ext.tabs) && ext.tabs.find((t) => t.active) || (ext && ext.tabs && ext.tabs[0]);
      if (liveTab && liveTab.url) {
        setAttachments((a) => [...a, {
          name: `🌐 ${liveTab.title || liveTab.url}`,
          path: liveTab.url,
          size: 0,
          isText: true,
          content: `External Browser tab context (Akron Browser Bot):\nTitle: ${liveTab.title || ''}\nURL: ${liveTab.url}`,
        }]);
        return;
      }
      const inAppUrl = window.autobot && window.autobot.browserGetURL ? await window.autobot.browserGetURL() : '';
      if (inAppUrl) {
        const title = await window.autobot.browserGetTitle().catch(() => '');
        const text = await window.autobot.browserRead().catch(() => '');
        setAttachments((a) => [...a, {
          name: `🌐 ${title || inAppUrl}`,
          path: inAppUrl,
          size: String(text || '').length,
          isText: true,
          content: `Built-in Browser context:\nTitle: ${title || ''}\nURL: ${inAppUrl}\n\n${String(text || '').slice(0, 12000)}`,
        }]);
        return;
      }
    } catch (_) {}
    toggleSessionPane('browser');
  }, [setAttachments, toggleSessionPane]);

  const triggerMentionInsert = useCallback(() => {
    setAddCtxOpen(false);
    if (!inputRef.current) return;
    const el = inputRef.current;
    const cur = el.value || '';
    const next = cur && !/\s$/.test(cur) ? cur + ' @' : cur + '@';
    el.value = next;
    syncInputState(next);
    el.focus();
    try { el.setSelectionRange(next.length, next.length); } catch (_) {}
  }, [inputRef, syncInputState]);

  const triggerActionsInsert = useCallback(() => {
    setAddCtxOpen(false);
    refreshSlashActions();
    if (!inputRef.current) return;
    const el = inputRef.current;
    const cur = el.value || '';
    const next = cur.startsWith('/') ? cur : '/';
    el.value = next;
    syncInputState(next);
    el.focus();
    try { el.setSelectionRange(next.length, next.length); } catch (_) {}
  }, [inputRef, syncInputState, refreshSlashActions]);
  const voice = useVoiceDictation({
    engine: (settings && settings.voiceEngine) || 'auto',
    lang: (settings && settings.voiceLang) || 'en-US',
    onTranscript: (transcript) => {
      if (inputRef.current) {
        const el = inputRef.current;
        el.value = el.value ? el.value + ' ' + transcript : transcript;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        setHasText(!!el.value.trim());
      }
    },
    onError: (msg) => { if (onVoiceError) onVoiceError(msg); },
  });
  useEffect(() => {
    setDictating(voice.state !== 'idle');
  }, [voice.state, setDictating]);
  // Tracks whether the composer holds text so that, while a reply is streaming,
  // the send arrow can appear alongside the stop button (Example parity: type a
  // follow-up mid-stream and the arrow queues it instead of being lost).
  const [hasText, setHasText] = useState(() => !!((inputRef.current && inputRef.current.value) || '').trim());
  const permWrapRef = useRef(null);
  const [keyStatus, setKeyStatus] = useState(() => loadJSON('autobot:keyStatus', {}));
  const [keyProbing, setKeyProbing] = useState(false);
  // The probe effects read the cache through a ref: having keyStatus in their
  // deps while they also write it re-ran them on every verdict.
  const keyStatusRef = useRef(keyStatus);
  keyStatusRef.current = keyStatus;
  // Local model discovery: an Ollama box only runs the models that were pulled,
  // so the preset's hard-coded `llama3.1` pointed at a model that often does not
  // exist (404 → "cannot use"), and nothing else ever showed up in the picker.
  const [ollama, setOllama] = useState({});
  const [ollamaBusy, setOllamaBusy] = useState(false);
  // Subscription accounts (Claude Max, ChatGPT, Antigravity, Grok). The
  // renderer only ever sees non-secret metadata; tokens are minted in main.
  const [provOauth, setProvOauth] = useState(null);
  const [provBusy, setProvBusy] = useState('');
  const [provNotice, setProvNotice] = useState('');
  // Bearer providers (xAI/Grok) have no browser flow: the user pastes a key.
  const [provToken, setProvToken] = useState({});
  // Manual code sign-in: the authorize page shows the code, the user pastes it
  // back. Used when the browser cannot reach the loopback listener.
  const [provManual, setProvManual] = useState(null);
  // Live model inventory per provider (`autobot:providerModels`). The accounts
  // expose 5–40 models each and they change, so the picker asks the provider
  // instead of shipping a stale hardcoded list. Values carry the resolved
  // context window used for the per-model label and the auto-compact budget.
  const [provModels, setProvModels] = useState({});

  // Context ring in the composer: measure the window of the model that served
  // the last turn. `provider.model` is right on a fresh chat, but switching
  // models (or sitting on a gateway alias like `auto`) would otherwise rescale
  // an existing conversation against the wrong window.
  const ctxWindow = contextWindowFor((lastUsage && lastUsage.model) || provider.model);

  const loadProvOauth = useCallback(async () => {
    const r = await Promise.resolve(window.autobot.providerStatus()).catch(() => null);
    if (r && r.ok && r.status) setProvOauth(r.status);
    return r && r.status;
  }, []);

  const loadProvModels = useCallback(async (provId, account) => {
    if (!provId || !window.autobot.providerModels) return null;
    // Cache under the account-specific key when we know it, and always also
    // under the bare provider id so the warm-up fetch and the picker agree.
    const key = account ? provId + ':' + account : provId;
    try {
      const r = await window.autobot.providerModels(key);
      if (r && r.ok) {
        setProvModels((m) => (account ? { ...m, [provId]: r, [key]: r } : { ...m, [provId]: r }));
        // Share the resolved windows with the `/context` command, which runs
        // outside this component and cannot see this state.
        try {
          const cache = loadJSON(MODEL_WINDOW_CACHE, {}) || {};
          for (const m of r.models || []) {
            if (m.id && m.contextWindow > 0) cache[m.id] = m.contextWindow;
          }
          saveJSON(MODEL_WINDOW_CACHE, cache);
        } catch (_) {}
        return r;
      }
    } catch (_) {}
    return null;
  }, []);

  useEffect(() => {
    if (modelMenuOpen) loadProvOauth();
  }, [modelMenuOpen, loadProvOauth]);

  // Warm the per-provider model lists as soon as the menu opens so the picker
  // shows every model (and its window) without a second click. The account the
  // conversation is actually using is fetched first — that is the one whose
  // catalog the composer pill reports.
  useEffect(() => {
    if (!modelMenuOpen || !provOauth) return;
    const sel = String(provider.oauthProvider || '');
    for (const pv of provOauth.providers || []) {
      const accounts = pv.accounts || [];
      if (!accounts.length) continue;
      const acct = sel.startsWith(pv.id + ':') ? sel.slice(pv.id.length + 1) : '';
      if (acct && accounts.some((a) => a.account === acct)) loadProvModels(pv.id, acct);
      else loadProvModels(pv.id);
    }
  }, [modelMenuOpen, provOauth, provider.oauthProvider, loadProvModels]);

  // Sign in / import / sign out always refresh the list so the picker reflects
  // the real account state (never an optimistic guess).
  //
  // Claude is special: its credential is owned by the Claude Code CLI, so this
  // surface drives the CLI's own login (the same flow Settings → Accounts uses)
  // instead of a second independent OAuth, which would sign the CLI out.
  const claudeSignIn = useClaudeReconnect({ t: T, onChanged: loadProvOauth });

  // Stop a browser sign-in that is still waiting for the redirect. Without this
  // the row spins until the 10-minute timeout when the browser never returns.
  const cancelBrowserSignIn = async (id) => {
    try { await window.autobot.providerSignInCancel(id); } catch (_) {}
  };

  const providerAction = async (kind, id, account) => {
    if (kind === 'signin' && id === 'claude') return claudeSignIn.start();
    setProvBusy(kind + ':' + (id || ''));
    try {
      let r;
      if (kind === 'signin') r = await window.autobot.providerSignIn(id);
      else if (kind === 'signout') r = await window.autobot.providerSignOut(id, account);
      else if (kind === 'import') r = await window.autobot.providerImport();
      else if (kind === 'bearer') r = await window.autobot.providerAddBearer(id, account);
      if (r && r.cancelled) {
        // The user stopped it — that is not a failure and must not read like one.
        setProvNotice('Sign-in cancelled — no account was added.');
      } else if (kind === 'import' && r && r.ok !== false && r.result) {
        // A scan that finds nothing new must still say so — otherwise the button
        // flashes "Scanning…" and appears dead.
        const im = (r.result.imported || []).length;
        const sk = (r.result.skipped || []).length;
        const er = (r.result.errors || []).length;
        const parts = ['Imported ' + im];
        if (sk) parts.push('already present ' + sk);
        if (er) parts.push('failed ' + er);
        setProvNotice(parts.join(' · ') + (im ? '.' : ' — nothing new to import.'));
      } else if (r && r.ok === false && r.error) {
        // One human line, never a stack trace or raw markup.
        setProvNotice(String(r.error).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220));
      } else {
        setProvNotice('');
        if (kind === 'bearer') setProvToken({});
      }
      await loadProvOauth();
      return r;
    } finally {
      setProvBusy('');
    }
  };

  // Start the paste-the-code fallback: no loopback listener, the provider page
  // shows a code and we hand it back. This is what the Claude CLI does when it
  // cannot get the browser to return to localhost.
  const startManualSignIn = async (id) => {
    setProvBusy('manual:' + id);
    try {
      const r = await window.autobot.providerSignInManual(id);
      if (!r || r.ok === false) {
        setProvNotice(String((r && r.error) || 'could not start sign-in').replace(/<[^>]*>/g, ' ').slice(0, 220));
        return;
      }
      setProvNotice('');
      setProvManual({ flowId: r.flowId, provId: id, url: r.url || '', code: '', sent: false });
    } catch (e) {
      setProvNotice(String((e && e.message) || 'could not start sign-in').slice(0, 220));
    } finally {
      setProvBusy('');
    }
  };

  const submitManualCode = async () => {
    const m = provManual;
    if (!m || !String(m.code || '').trim()) return;
    setProvBusy('manual:' + m.provId);
    try {
      const r = await window.autobot.providerSubmitCode(m.flowId, String(m.code).trim());
      if (r && r.ok === false) {
        setProvNotice(String(r.error || 'paste the code the sign-in page shows').slice(0, 220));
        return;
      }
      setProvNotice('');
      setProvManual({ ...m, code: '', sent: true });
    } finally {
      setProvBusy('');
    }
  };

  // The main process reports the outcome of a manual sign-in here — success
  // brings a new account (refresh the list), failure is one human line.
  useEffect(() => {
    if (!window.autobot.onProviderManualResult) return undefined;
    return window.autobot.onProviderManualResult(async (flowId, result) => {
      setProvManual((cur) => (cur && cur.flowId === flowId ? null : cur));
      if (result && result.ok) {
        setProvNotice('');
        await loadProvOauth();
      } else {
        setProvNotice(String((result && result.error) || 'sign-in did not complete').replace(/<[^>]*>/g, ' ').slice(0, 220));
      }
    });
  }, [loadProvOauth]);

  const scanOllama = useCallback(async () => {
    const bases = new Set();
    for (const p of PRESETS) {
      const b = normBase(p.baseURL);
      if (b && LOCAL_BASE.test(b)) bases.add(b);
    }
    const activeBase = normBase(provider.baseURL);
    if (activeBase && LOCAL_BASE.test(activeBase)) bases.add(activeBase);
    if (!bases.size) return {};
    // A keyed local router (FreeLLMAPI on :3001) refuses an anonymous
    // GET /models, so the scan must carry the same bearer the turn will use —
    // otherwise a working endpoint renders as "not set up" and lists nothing.
    const keyForBase = (b) => resolveLoopbackKey(b, providerKeys, provider);
    const found = {};
    for (const b of bases) {
      const res = await Promise.resolve(window.autobot.ollamaModels(b, keyForBase(b))).catch(() => null);
      if (res) found[b] = res;
    }
    setOllama((prev) => ({ ...prev, ...found }));
    return found;
  }, [provider, providerKeys]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    scanOllama();
  }, [modelMenuOpen, scanOllama]);

  // One-click "Connect Ollama": start the server if it is not up, then jump
  // straight onto the first installed model.
  const connectOllama = async () => {
    setOllamaBusy(true);
    try {
      const r = await Promise.resolve(window.autobot.ollamaServe('start')).catch(() => null);
      const found = await scanOllama();
      const base = normBase((r && r.base) || 'http://localhost:11434/v1');
      const scan = (r && r.ok ? r : null) || found[base] || null;
      const first = scan && scan.models && scan.models[0];
      if (first) {
        setProvider((v) => ({ ...v, baseURL: base, model: first.name, apiKey: '', supportsTools: true }));
        setModelMenuOpen(false);
      }
      return { ok: !!first, detail: (r && r.detail) || (scan && scan.detail) || '' };
    } finally {
      setOllamaBusy(false);
    }
  };

  const keyFor = useCallback((p) => {
    return (p && p.apiKey) || resolveLoopbackKey(p && p.baseURL, providerKeys, provider);
  }, [providerKeys, provider]);

  // When the picker opens (or a key changes), ask each configured endpoint for
  // its status once — a cheap authenticated GET /models, no tokens burned.
  // Entries are stamped with the key signature + timestamp; anything stale is
  // re-probed and anything whose signature no longer matches is ignored.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const seen = new Set();
    const targets = [];
    for (const p of PRESETS) {
      const base = normBase(p.baseURL);
      if (!base) continue;
      const apiKey = keyFor(p);
      if (!apiKey && !LOCAL_BASE.test(base)) continue;
      const sig = base + '|' + keySig(apiKey);
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (statusOf(keyStatusRef.current, base, apiKey)) continue; // fresh verdict already cached
      targets.push({ baseURL: base, apiKey });
    }
    if (!targets.length) return;
    let cancelled = false;
    setKeyProbing(true);
    Promise.resolve(window.autobot.probeProviders(targets)).then((res) => {
      if (cancelled || !res || res._error) return;
      const sigByBase = {};
      for (const t of targets) sigByBase[normBase(t.baseURL)] = keySig(t.apiKey);
      const at = Date.now();
      setKeyStatus((prev) => {
        const next = { ...prev };
        for (const [base, v] of Object.entries(res)) {
          next[base] = { state: v.state, detail: v.detail, sig: sigByBase[base] || '', at };
        }
        saveJSON('autobot:keyStatus', next);
        return next;
      });
    }).catch(() => {}).finally(() => { if (!cancelled) setKeyProbing(false); });
    // A cancelled probe must not leave "checking keys…" stuck in the header.
    return () => { cancelled = true; setKeyProbing(false); };
  }, [modelMenuOpen, keyFor]);

  // The composer pill mirrors the active endpoint, so probe it once on load too.
  useEffect(() => {
    if (modelMenuOpen) return;
    const base = normBase(provider.baseURL);
    if (!base) return;
    const apiKey = resolveLoopbackKey(base, providerKeys, provider);
    if (!apiKey && !LOCAL_BASE.test(base)) return;
    if (statusOf(keyStatusRef.current, base, apiKey)) return;
    let cancelled = false;
    Promise.resolve(window.autobot.probeProviders([{ baseURL: base, apiKey }])).then((res) => {
      if (cancelled || !res || res._error) return;
      const v = res[base];
      if (!v) return;
      setKeyStatus((prev) => {
        const next = { ...prev, [base]: { state: v.state, detail: v.detail, sig: keySig(apiKey), at: Date.now() } };
        saveJSON('autobot:keyStatus', next);
        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [provider, providerKeys, modelMenuOpen]);

  const activeBase = normBase(provider.baseURL);
  const activeKey = resolveLoopbackKey(activeBase, providerKeys, provider);
  const activeKeyState = statusOf(keyStatus, activeBase, activeKey);
  const activeDot = activeKeyState ? (activeKeyState.state === 'ok' ? 'ok' : (activeKeyState.state === 'out' || activeKeyState.state === 'badkey') ? 'out' : null) : null;
  const modelMenuRef = useRef(null);
  const modelWrapRef = useRef(null);
  useDismiss(modelMenuOpen, [modelWrapRef], () => setModelMenuOpen(false));

  // What the picker lists: every preset, except a reachable Ollama preset, which
  // expands into one row per model the server actually reports.
  // Memoized: SessionModelList memoizes its 1000-row grouping on `rows`, which
  // a fresh array every render defeated.
  const pickerRows = useMemo(() => {
  const pickerRows = [];
  for (const p of PRESETS) {
    const base = normBase(p.baseURL);
    const scan = ollama[base];
    if (scan && scan.ok && scan.models && scan.models.length) {
      // A local router lists its whole catalog. Label it for what it is
      // ("live" = the key authenticated the endpoint) and keep the model the
      // user already picked selectable even when it is a router alias that the
      // catalog does not enumerate (FreeLLMAPI's `auto:fast`).
      const isOllamaBase = /:11434\b/.test(base);
      const list = scan.models.slice();
      if (base === normBase(provider.baseURL) && provider.model && !list.some((m) => m.name === provider.model)) {
        list.unshift({ name: provider.model, size: 0, family: '' });
      }
      for (const m of list) {
        pickerRows.push({
          key: base + '|' + m.name,
          preset: p,
          model: m.name,
          label: m.name.split('/').pop().replace(/:latest$/, ''),
          prov: p.name.replace(/\s*\(.*\)$/, '') + (isOllamaBase ? ' · installed' : ' · live'),
          local: true,
        });
      }
      continue;
    }
    pickerRows.push({ key: p.name, preset: p, model: p.model, label: (p.model || 'custom').split('/').pop(), prov: p.name });
  }
  return pickerRows;
  }, [ollama, provider.baseURL, provider.model]);
  const ollamaEmpty = PRESETS.some((p) => {
    const b = normBase(p.baseURL);
    return /:11434\b/.test(b) && ollama[b] && !(ollama[b].ok && ollama[b].models && ollama[b].models.length);
  });

  // Example parity: opening the picker scrolls the current model into view.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const el = modelMenuRef.current && modelMenuRef.current.querySelector('.model-opt.on');
    if (el) el.scrollIntoView({ block: 'center' });
  }, [modelMenuOpen]);

  // Permissions dropdown: outside-click dismiss + 1..5 shortcut selection (Example parity)
  useEffect(() => {
    if (!permOpen) return;
    const onDocDown = (e) => {
      if (permWrapRef.current && !permWrapRef.current.contains(e.target)) setPermOpen(false);
    };
    const onMenuKey = (e) => {
      if (e.key === 'Escape') { setPermOpen(false); return; }
      const n = parseInt(e.key, 10);
      if (!Number.isNaN(n) && n >= 1 && n <= PERM_MODES.length) {
        e.preventDefault();
        setPermissions(PERM_MODES[n - 1].id);
        setPermOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onMenuKey);
    return () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onMenuKey);
    };
  }, [permOpen, setPermissions]);

  const onDropFiles = async (e) => {
    e.preventDefault(); setDragOver(false);
    const files = e.dataTransfer?.files;
    if (files && files.length) {
      const atts = await filesToAttachments(files);
      setAttachments((a) => [...a, ...atts]);
    }
  };
  const onPasteFiles = async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) {
      e.preventDefault();
      const atts = await filesToAttachments(files);
      setAttachments((a) => [...a, ...atts]);
    }
  };

  const onKey = (e) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => Math.min(i + 1, filteredSlashActions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applySlashItem(filteredSlashActions[slashIdx] || filteredSlashActions[0], 'tab');
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const picked = filteredSlashActions[slashIdx] || filteredSlashActions[0];
        if (picked) {
          // If the exact token already matches `/${picked.name}` and it is an MCP workflow (which has a default workspace action),
          // run it directly when pressed twice or on exact Enter match for no-arg commands.
          if (slashQuery === picked.name.toLowerCase() && /^mcp:/i.test(picked.name)) {
            inputRef.current.value = '';
            syncInputState('');
            runSlashCommand(picked.name);
          } else {
            applySlashItem(picked, 'enter');
          }
        }
        return;
      }
    }
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => Math.min(i + 1, mentionItems.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionDismissed(true);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applyMentionItem(mentionItems[mentionIdx] || mentionItems[0]);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = (inputRef.current?.value || '').trim();
      if (text.startsWith('/')) {
        inputRef.current.value = '';
        syncInputState('');
        runSlashCommand(text.slice(1));
      } else {
        send();
        syncInputState('');
      }
    }
  };

  const pickModel = (p, model) => {
    const base = normBase(p.baseURL);
    const key = keyFor(p);
    setProvider((v) => ({ ...v, baseURL: p.baseURL, model: model || p.model, apiKey: key, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto', oauthProvider: '', transport: '', accessToken: '', oauth: false }));
    if (key && base) setProviderKeys((m) => ({ ...(m || {}), [base]: key }));
    setModelMenuOpen(false);
  };

  // Pick a subscription account. Only the *id* goes into provider state: main
  // resolves it to a short-lived bearer token at the start of every turn.
  // Selecting an *account* keeps the menu open so its model list is visible;
  // selecting a *model* commits the choice and closes it.
  const pickOauthAccount = (prov, account, model) => {
    const key = prov.id + ':' + account;
    const live = provModels[key] || provModels[prov.id];
    const list = (live && live.models) || prov.models || [];
    const ids = list.map((m) => m.id);
    const dflt = model || (ids.includes(provider.model) ? provider.model : '') || ids[0] || provider.model;
    setProvider((v) => ({
      ...v,
      baseURL: '',
      apiKey: '',
      model: dflt || v.model,
      supportsTools: true,
      oauthProvider: prov.id + ':' + account,
      transport: prov.transport,
      oauth: true,
      accessToken: '',
    }));
    // Loaded per account, so two accounts of the same vendor never show each
    // other's catalogs (plan tiers expose different model sets).
    if (!provModels[key]) loadProvModels(prov.id, account);
    if (model) setModelMenuOpen(false);
  };

  // Unconfigured preset → open Settings with that preset staged. The session
  // provider is NOT switched here: it only changes once a key is saved, so
  // closing Settings leaves the working model untouched.
  const configurePreset = (p) => {
    setModelMenuOpen(false);
    openSettings({ preset: p });
  };

  const attachFiles = async () => {
    const files = await window.autobot.pickFiles();
    if (files && files.length) setAttachments((a) => [...a, ...files]);
  };
  const removeAttachment = (i) => setAttachments((a) => a.filter((_, j) => j !== i));

  const modelLabel = (provider.model || '').split('/').pop() || 'Select model';
  // Short window chip ("1M", "200K") next to the model name so the user can see
  // the effective context length without opening the picker. Backed by the
  // live per-model window cached from `autobot:providerModels`.
  const modelWindowLabel = (() => {
    const w = contextWindowFor(provider.model);
    if (!w) return '';
    if (w >= 1000000) return Math.round(w / 100000) / 10 + 'M';
    return Math.round(w / 1000) + 'K';
  })();
  const activeStyle = STYLES.find((s) => s.id === styleId) || STYLES[0];

  return (
    <div className={'inputbar' + (dragOver ? ' drag-over' : '')} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }} onDrop={onDropFiles}>
      <div className="cwdbar">
        <EnvironmentPicker
          envState={envState}
          onSwitchEnvironment={onSwitchEnvironment}
          onOpenEnvironments={onOpenEnvironments}
        />
        <span className="cwd"><Icon name="Folder" size={13} /> {cwd || '~'}</span>
        {(!envState || !envState.active || envState.active.kind === 'local') ? (
          <button className="cwd-pick" onClick={async () => { const d = await window.autobot.pickFolder(); if (d) { setCwd(d); const id = loadJSON('autobot:activeId', null); if (id) window.autobot.setWorkspace(id, d).catch(() => {}); } }}>Change</button>
        ) : (
          <button className="cwd-pick" onClick={() => onSwitchEnvironment && onSwitchEnvironment({ kind: 'local' })}>Disconnect</button>
        )}
      </div>

      <MessageQueueTray
        items={queued}
        queuePaused={queuePaused}
        streaming={streaming}
        onToggleQueuePaused={onToggleQueuePaused}
        onClearAll={onClearQueue}
        onToggleItemPaused={onToggleQueueItemPaused}
        onReorder={onReorderQueue}
        onStepItem={onStepQueueItem}
        onUpdateItemText={onUpdateQueueItemText}
        onSendNow={sendQueuedNow}
        onDeleteItem={unqueue}
      />

      {/* Settings row — outside the composer box, above it (Claude-style).
          The box itself keeps only what Claude keeps in it: the command hint,
          attach, the context ring, the model pill and send. Every control that
          carries a label lives up here, because a labelled control inside a
          682 px flex footer overflows the row, and `overflow: hidden` then
          clips it out of existence — which is exactly why the tools button was
          unclickable at every width above 1100 px while the context ring sat
          on top of it. Nothing can be squeezed past the border now. */}
      <div className="composer-topbar">
        <div className="topbar-left">
            {/* Reasoning / thinking level — deliberately labelled so it is
                discoverable: a bare icon select was impossible to find. */}
            <div className="style-wrap f-think">
              <button
                type="button"
                className={'reason-pick' + (reasoningLevel !== 'auto' ? ' active' : '')}
                title={'Thinking level — ' + (reasoningLevel === 'auto' ? 'model decides' : reasoningLevel) + ' (applies to reasoning models)'}
                onClick={() => setReasonOpen(!reasonOpen)}
                aria-haspopup="listbox"
                aria-expanded={reasonOpen}
                aria-label="Thinking level"
              >
                <Icon name="ExtendedThinking" size={16} />
                <span className="reason-label">Thinking</span>
                <span className="reason-val">{REASON_LABELS[reasoningLevel] || 'Auto'}</span>
                <span className="reason-caret" aria-hidden="true">▾</span>
              </button>
              {reasonOpen && (
                <div className="style-menu reason-menu" role="listbox">
                  <div className="model-menu-head">Thinking level</div>
                  {REASON_LEVELS.map((lv) => (
                    <button
                      key={lv.id}
                      type="button"
                      role="option"
                      aria-selected={reasoningLevel === lv.id}
                      className={'model-opt' + (reasoningLevel === lv.id ? ' on' : '')}
                      onClick={() => { setReasoningLevel(lv.id); setReasonOpen(false); }}
                    >
                      <span className="model-opt-name">{lv.name}</span>
                      <span className="model-opt-prov">{lv.hint}</span>
                      {reasoningLevel === lv.id && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Swarm — user-opted escalation to a frontier-model team. Off by
                default; multi-agent (Task/Agent) still happens automatically.
                Labelled on purpose: an icon-only toggle was invisible. */}
            <button
              type="button"
              className={'swarm-pill' + (swarmEnabled ? ' active' : '')}
              title={swarmEnabled
                ? 'Swarm ON — Planner coordinates parallel role-pooled workers across a shared message board with automatic failover'
                : 'Swarm OFF — click to enable multi-model Swarm orchestration (multi-agent Task/Agent still runs automatically)'}
              aria-pressed={swarmEnabled}
              aria-label={'Swarm ' + (swarmEnabled ? 'on' : 'off')}
              onClick={() => setSwarmEnabled(!swarmEnabled)}
            >
              <Icon name="Users" size={15} />
              <span className="swarm-label">Swarm</span>
              <span className="swarm-state">{swarmEnabled ? 'On' : 'Off'}</span>
            </button>

            {/* Secondary answer tools live behind one button, exactly like the
                `+` menu in the Claude app. Nine inline controls could not fit a
                712 px composer and spilled past the border; a popover keeps
                every one of them reachable at any width without moving the
                primary row (attach · thinking · swarm  |  context · model · send). */}
            <div className="tools-wrap">
              <button
                type="button"
                className={'icon-btn tools-btn' + ((webSearch || (sessionPane && sessionPane.type === 'browser') || dictating || voiceMode || styleId !== 'default') ? ' active' : '')}
                title="Answer tools — style, web search, browser, dictation, voice"
                aria-haspopup="menu"
                aria-expanded={toolsOpen}
                onClick={() => setToolsOpen(!toolsOpen)}
              >
                <Icon name="Sliders" size={17} />
              </button>
              {toolsOpen && (
                <div className="tools-menu" role="menu">
                  <div className="model-menu-head">Answer tools</div>
                  <button type="button" role="menuitemcheckbox" aria-checked={!!webSearch} className="tools-row" onClick={() => setWebSearch(!webSearch)}>
                    <Icon name="Globe" size={15} />
                    <span className="tools-row-label">Web search</span>
                    <span className={'tools-state' + (webSearch ? ' on' : '')}>{webSearch ? 'On' : 'Off'}</span>
                  </button>
                  <button type="button" role="menuitem" className="tools-row" onClick={() => { toggleSessionPane('browser'); setToolsOpen(false); }}>
                    <Icon name="Window" size={15} />
                    <span className="tools-row-label">Browser</span>
                    <span className={'tools-state' + (sessionPane && sessionPane.type === 'browser' ? ' on' : '')}>{sessionPane && sessionPane.type === 'browser' ? 'Open' : 'Closed'}</span>
                  </button>
                  <button type="button" role="menuitemcheckbox" aria-checked={voice.state !== 'idle'} className="tools-row" onClick={() => voice.toggle()}>
                    <Icon name={voice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={15} className={voice.state === 'transcribing' ? 'spin' : ''} />
                    <span className="tools-row-label">Dictate (Built-in Whisper)</span>
                    <span className={'tools-state' + (voice.state !== 'idle' ? ' on' : '')}>
                      {voice.state === 'recording' ? `Listening ${voice.seconds}s` : (voice.state === 'transcribing' ? 'Transcribing…' : 'Off')}
                    </span>
                  </button>
                  <button type="button" role="menuitemcheckbox" aria-checked={!!voiceMode} className="tools-row" onClick={() => (voiceMode ? stopVoiceMode() : startVoiceMode())}>
                    <Icon name="Voice" size={15} />
                    <span className="tools-row-label">Voice mode</span>
                    <span className={'tools-state' + (voiceMode ? ' on' : '')}>{voiceMode ? 'On' : 'Off'}</span>
                  </button>
                  <div className="model-menu-divider" />
                  <div className="model-menu-head">Style</div>
                  {STYLES.map((st) => (
                    <button key={st.id} type="button" role="menuitemradio" aria-checked={styleId === st.id} className={'model-opt' + (styleId === st.id ? ' on' : '')} onClick={() => { setStyleId(st.id); setToolsOpen(false); }}>
                      <span className="model-opt-name">{st.name}</span>
                      {st.hint && <span className="model-opt-prov">{st.hint}</span>}
                      {styleId === st.id && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
        </div>
        <div className="topbar-right">
            <div className="perm-pill-wrap" ref={permWrapRef}>
              <button className={'perm-pill' + (permOpen ? ' open' : '')} onClick={() => setPermOpen(!permOpen)} title={T('perm.sessionHead')}>
                <span className="perm-name">{T(PERM_SHORT[permissions] || 'perm.auto')}</span>
              </button>
              {permOpen && (
                <div className="perm-menu">
                  <div className="perm-menu-head">{T('perm.sessionHead')}</div>
                  {PERM_MODES.map((m, i) => {
                    const active = permissions === m.id;
                    return (
                      <button key={m.id} className={'perm-opt' + (active ? ' on' : '')} onClick={() => { setPermissions(m.id); setPermOpen(false); }}>
                        <span className="perm-opt-body">
                          <span className="perm-opt-title">{T(m.title)}</span>
                          <span className="perm-opt-desc">{T(m.desc)}</span>
                        </span>
                        <span className="perm-opt-meta">
                          {active && <Icon name="Check" size={14} className="model-check" />}
                          <span className="perm-opt-num">{i + 1}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
        </div>
      </div>

      <div className={'composer-shell' + (slashOpen || mentionOpen ? ' has-palette' : '')}>
        {slashOpen && (
          <div className="slash-palette" ref={slashPaletteRef} role="listbox" aria-label="Slash actions">
            {filteredSlashActions.map((item, idx) => (
              <button
                key={item.name}
                type="button"
                role="option"
                aria-selected={idx === slashIdx}
                className={'slash-row' + (idx === slashIdx ? ' sel' : '')}
                onMouseEnter={() => setSlashIdx(idx)}
                onMouseDown={(e) => { e.preventDefault(); applySlashItem(item, 'enter'); }}
              >
                <span className="slash-ico">
                  <Icon
                    name={item.icon === 'btw' ? 'ChatAdd' : item.icon === 'mcp' ? 'CommandLinePrompt' : item.icon === 'goal' ? 'Clock' : item.icon === 'skill' ? 'Sparkles' : 'CommandLine'}
                    size={15}
                  />
                </span>
                <span className="slash-name">{item.name}</span>
                <span className="slash-desc">{item.description}</span>
              </button>
            ))}
          </div>
        )}

        {mentionOpen && (
          <div className="mention-palette" ref={mentionPaletteRef} role="listbox" aria-label="Mentions">
            <div className="mention-head">Mentions · Agents &amp; Files</div>
            {mentionItems.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                role="option"
                aria-selected={idx === mentionIdx}
                className={'slash-row' + (idx === mentionIdx ? ' sel' : '')}
                onMouseEnter={() => setMentionIdx(idx)}
                onMouseDown={(e) => { e.preventDefault(); applyMentionItem(item); }}
              >
                <span className="slash-ico">
                  <Icon name={item.kind === 'agent' ? 'Agent' : 'File'} size={14} />
                </span>
                <span className="slash-name">{item.label}</span>
                <span className="slash-desc">{item.sub}</span>
              </button>
            ))}
          </div>
        )}

      <div className={'composer' + (streaming ? ' is-streaming' : '')}>
        {attachments.length > 0 && (
          <div className="attach-chips">
            {attachments.map((a, i) => (
              <span key={i} className={'attach-chip' + (a.isImage ? ' img' : a.isText ? ' text' : ' bin')} title={a.path || a.name}>
                {a.isImage && a.dataUrl
                  ? <img className="attach-thumb" src={a.dataUrl} alt={a.name} />
                  : <Icon name={a.isText ? 'File' : 'Attachment'} size={12} />}
                <span className="attach-name">{a.name}</span>
                {a.isText || a.isImage ? null : <span className="attach-size"> · {a.size} B</span>}
                <button className="attach-x" onClick={() => removeAttachment(i)}><Icon name="X" size={11} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={T('composer.placeholder')}
          onFocus={() => refreshSlashActions()}
          onKeyDown={onKey}
          onInput={(e) => syncInputState(e.target.value)}
          onPaste={onPasteFiles}
        />
        <div className="composer-foot">
          <div className="composer-actions">
            <div className="add-context-wrap" ref={addCtxWrapRef}>
              <button
                type="button"
                className={'icon-btn add-context-btn' + (addCtxOpen ? ' open' : '')}
                title="Add Context (Files, Folder, @Mentions, /Actions, Browser, Drive)"
                aria-label="Add Context"
                aria-haspopup="menu"
                aria-expanded={addCtxOpen}
                onClick={() => setAddCtxOpen((v) => !v)}
              >
                <Icon name="Plus" size={16} />
              </button>
              {addCtxOpen && (
                <div className="add-context-menu" role="menu">
                  <div className="add-context-head">Add Context</div>
                  <button type="button" role="menuitem" className="add-context-item" onClick={() => { setAddCtxOpen(false); attachFiles(); }}>
                    <Icon name="Attachment" size={15} />
                    <span className="add-context-label">Files</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={attachFolderContext}>
                    <Icon name="Folder" size={15} />
                    <span className="add-context-label">Folder</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={triggerMentionInsert}>
                    <span className="add-context-glyph">@</span>
                    <span className="add-context-label">Mentions</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={triggerActionsInsert}>
                    <Icon name="CommandLinePrompt" size={15} />
                    <span className="add-context-label">Actions</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={attachBrowserContext}>
                    <Icon name="Globe" size={15} />
                    <span className="add-context-label">Browser</span>
                  </button>
                  <button type="button" role="menuitem" className="add-context-item" onClick={() => { setAddCtxOpen(false); onOpenGdrive && onOpenGdrive(); }}>
                    <GoogleDriveIcon size={15} />
                    <span className="add-context-label">Drive</span>
                    <span className={'add-context-badge' + (gdriveState && gdriveState.connected ? ' ok' : ' setup')}>
                      {gdriveState && gdriveState.connected ? 'Connected' : 'Set up'}
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button className="icon-btn attach-btn f-attach" title="Attach files" onClick={attachFiles}><Icon name="Attachment" size={16} /></button>
          </div>

          <div className="composer-right">
            <button
              type="button"
              className="ctx-btn"
              title={'Context: ' + fmtInt(usedTokens(lastUsage)) + ' of ' + fmtInt(ctxWindow) + ' tokens used — open Environment'}
              onClick={() => toggleSessionPane('env')}
            >
              <ContextMeter used={usedTokens(lastUsage)} win={ctxWindow} size={26} />
            </button>
            <div className="model-pill-wrap" ref={modelWrapRef}>
              <button className={'model-pill' + (modelMenuOpen ? ' open' : '')} onClick={() => setModelMenuOpen(!modelMenuOpen)} title="Change model">
                <Icon name="Agent" size={14} className="model-ico" />
                <span className="model-name">{modelLabel}</span>
                {modelWindowLabel && <span className="model-win" title={'Context window: ' + modelWindowLabel + ' tokens'}>{modelWindowLabel}</span>}
                {activeDot && <span className={'model-dot ' + activeDot} title={activeKeyState.detail || ''} />}
                <Icon name={modelMenuOpen ? 'CaretUp' : 'CaretDown'} size={12} className="model-caret" />
              </button>
              {modelMenuOpen && (
                <div className="model-menu" ref={modelMenuRef}>
                  <div className="model-menu-head">Model · this session{keyProbing ? ' · checking keys…' : ''}</div>
                  <SessionModelList
                    rows={pickerRows}
                    isActive={(r) => provider.baseURL === r.preset.baseURL && provider.model === r.model}
                    renderRow={(r) => {
                      const active = provider.baseURL === r.preset.baseURL && provider.model === r.model;
                      const st = presetStatus(r.preset, { keyFor, status: keyStatus, probing: keyProbing });
                      const rowBase = normBase(r.preset.baseURL);
                      const isOllama = /:11434\b/.test(rowBase);
                      const scan = ollama[rowBase];
                      const ollamaDown = isOllama && !(scan && scan.ok && scan.models && scan.models.length);
                      return (
                        <button
                          key={r.key}
                          className={'model-opt' + (active ? ' on' : '') + (st.row ? ' ' + st.row : '')}
                          title={r.local ? 'Local Ollama model — ' + r.model : (ollamaDown || st.row === 'dim' ? undefined : st.label)}
                          onClick={() => {
                            if (r.local) return pickModel(r.preset, r.model);
                            if (ollamaDown) return connectOllama();
                            if (st.row === 'dim') return configurePreset(r.preset);
                            return pickModel(r.preset, r.model);
                          }}
                        >
                          <span className={'model-dot ' + (r.local ? 'ok' : st.dot)} />
                          <span className="model-opt-name">{r.label}</span>
                          <span className="model-opt-prov">{ollamaDown ? 'click to connect' : (!r.local && st.row === 'dim' ? st.label : r.prov)}</span>
                          {active && <Icon name="Check" size={13} className="model-check" />}
                        </button>
                      );
                    }}
                  />
                  {ollamaEmpty && (
                    <button className="model-opt model-connect" disabled={ollamaBusy} onClick={connectOllama}>
                      <Icon name="Plug" size={14} />
                      <span className="model-opt-name">{ollamaBusy ? 'Connecting to Ollama…' : 'Connect Ollama (local)'}</span>
                      <span className="model-opt-prov">{ollamaBusy ? '' : 'starts the server'}</span>
                    </button>
                  )}
                  {provOauth && (
                    <>
                      <div className="model-menu-divider" />
                      <div className="model-menu-head">Subscription accounts</div>
                      {/* An index that could not be parsed is not "no accounts":
                          say so here too, where the user picks a model. */}
                      {provOauth.storeError && (
                        <ProvNotice warn text={T('account.storeError')} />
                      )}
                      {provOauth.providers.map((pv) => {
                        const accounts = pv.accounts || [];
                        const live = provModels[pv.id];
                        // Honesty: a provider is "unverified" only when no real
                        // account of that kind was ever exercised here. Claude
                        // and Antigravity are field-verified (including live
                        // model enumeration); a provider that just answered a
                        // live catalog request is verified for that much at
                        // least. A live `warning` (dead token, 403) keeps the
                        // badge on.
                        const anyVerified = accounts.some((a) => (a.verifiedAt || 0) > 0);
                        const unverified = !(pv.id === 'claude' || pv.id === 'antigravity'
                          || (live && live.live) || anyVerified);
                        return (
                          <div key={pv.id} className="prov-group">
                            <div className="prov-head">
                              <span className="prov-name">{pv.label}</span>
                              {unverified && <span className="prov-unv" title="Adapter implemented from the published wire format and unit-tested; no account of this kind exists on this machine to verify end-to-end.">unverified</span>}
                              {pv.id === 'claude' && (
                                <button
                                  className="prov-link"
                                  title="The Claude Code CLI owns this credential — this starts its own sign-in and adopts the result, so the CLI stays signed in."
                                  disabled={!!provBusy || claudeSignIn.busy}
                                  onClick={claudeSignIn.start}
                                >{claudeSignIn.busy ? 'Opening…' : (accounts.length ? 'Reconnect' : 'Sign in')}</button>
                              )}
                              {pv.id !== 'claude' && pv.canBrowserSignIn && (
                                <button
                                  className="prov-link"
                                  title={provBusy === 'signin:' + pv.id ? 'Stop waiting for the browser' : 'Open the provider sign-in page'}
                                  disabled={!!provBusy && provBusy !== 'signin:' + pv.id}
                                  onClick={() => (provBusy === 'signin:' + pv.id ? cancelBrowserSignIn(pv.id) : providerAction('signin', pv.id))}
                                >{provBusy === 'signin:' + pv.id ? 'Cancel' : (accounts.length ? 'Add account' : 'Sign in')}</button>
                              )}
                              {pv.id !== 'claude' && pv.canManualCode && (
                                <button
                                  className="prov-link prov-link-sub"
                                  title="The sign-in page shows a code you paste back here — use this when the browser cannot reach this machine."
                                  disabled={!!provBusy}
                                  onClick={() => startManualSignIn(pv.id)}
                                >{provBusy === 'manual:' + pv.id ? 'Opening…' : 'Paste code'}</button>
                              )}
                            </div>
                            {accounts.map((a) => {
                              const on = provider.oauthProvider === a.id;
                              // Per-account catalogs: the same vendor can hold
                              // several accounts whose plans expose different
                              // models, so resolve the list for this account.
                              const own = provModels[pv.id + ':' + a.account] || live;
                              const list = (own && own.models && own.models.length ? own.models : (pv.models || []));
                              return (
                                <div key={a.id} className={'prov-acct' + (on ? ' on' : '')}>
                                  <button className="prov-pick" title={a.expired ? 'Stated expiry passed and the refresh was refused — a turn may still work; sign in again if it is rejected' : (a.label || a.account)} onClick={() => pickOauthAccount(pv, a.account)}>
                                    <span className={'model-dot ' + (a.expired ? 'out' : 'ok')} />
                                    <span className="model-opt-name">{a.label || a.account}</span>
                                    <span className="model-opt-prov">{a.plan || a.source || 'signed in'}</span>
                                    {on && !provider.model && <Icon name="Check" size={13} className="model-check" />}
                                  </button>
                                  <button className="prov-x" title="Sign out" disabled={!!provBusy} onClick={() => providerAction('signout', pv.id, a.account)}><Icon name="X" size={12} /></button>
                                  {on && (
                                    <>
                                      {own && own.warning && !list.length && (
                                        <div className="prov-none">{own.warning}</div>
                                      )}
                                      <ProvModelList
                                        list={list}
                                        picked={provider.model}
                                        onPick={(mid) => pickOauthAccount(pv, a.account, mid)}
                                      />
                                    </>
                                  )}
                                </div>
                              );
                            })}
                            {!accounts.length && pv.canBrowserSignIn && !pv.canPasteKey && !pv.canManualCode && pv.id !== 'claude' && (
                              <div className="prov-none">Not signed in</div>
                            )}
                            {pv.id === 'claude' && (
                              <ClaudeReconnectPanel
                                t={T}
                                rc={claudeSignIn.rc}
                                busy={provBusy || claudeSignIn.busy}
                                onCancel={claudeSignIn.cancel}
                                onChange={claudeSignIn.setCode}
                                onSubmit={claudeSignIn.submit}
                              />
                            )}
                            {pv.id === 'claude' && claudeSignIn.notice && (
                              <ProvNotice text={claudeSignIn.notice} />
                            )}
                            {provManual && provManual.provId === pv.id && (
                              <div className="prov-token prov-manual">
                                <div className="prov-manual-hint">
                                  {provManual.sent ? 'Code sent — checking with ' + pv.vendor + '…'
                                    : 'Sign in in the browser, then paste the code it shows (looks like xxxx#yyyy).'}
                                </div>
                                <input
                                  className="prov-token-in"
                                  type="text"
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder="Paste code"
                                  value={provManual.code || ''}
                                  disabled={!!provBusy || provManual.sent}
                                  onChange={(e) => setProvManual((m) => (m ? { ...m, code: e.target.value } : m))}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter') { e.preventDefault(); submitManualCode(); }
                                  }}
                                />
                                <button
                                  className="prov-link"
                                  disabled={!!provBusy || provManual.sent || !String(provManual.code || '').trim()}
                                  onClick={submitManualCode}
                                >{provManual.sent ? 'Checking…' : 'Submit'}</button>
                                <button
                                  className="prov-x"
                                  title="Cancel"
                                  onClick={() => setProvManual(null)}
                                ><Icon name="X" size={12} /></button>
                              </div>
                            )}
                            {pv.canPasteKey && (
                              <div className="prov-token">
                                <input
                                  className="prov-token-in"
                                  type="password"
                                  autoComplete="off"
                                  spellCheck={false}
                                  placeholder={(accounts.length ? 'or paste a ' : 'Paste your ') + pv.vendor + ' API key'}
                                  value={provToken[pv.id] || ''}
                                  disabled={!!provBusy}
                                  onChange={(e) => setProvToken((m) => ({ ...m, [pv.id]: e.target.value }))}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Enter' && (provToken[pv.id] || '').trim()) {
                                      e.preventDefault();
                                      providerAction('bearer', pv.id, (provToken[pv.id] || '').trim());
                                    }
                                  }}
                                />
                                <button
                                  className="prov-link"
                                  disabled={!!provBusy || !(provToken[pv.id] || '').trim()}
                                  onClick={() => providerAction('bearer', pv.id, (provToken[pv.id] || '').trim())}
                                >{provBusy === 'bearer:' + pv.id ? 'Checking…' : 'Add key'}</button>
                              </div>
                            )}
                          </div>
                        );
                      })}
                      <button className="model-opt" disabled={!!provBusy} onClick={() => providerAction('import')}>
                        <Icon name="Plug" size={14} />
                        <span className="model-opt-name">{provBusy === 'import:' ? 'Scanning this Mac…' : 'Import accounts from this Mac'}</span>
                      </button>
                      <ProvNotice text={provNotice} />
                    </>
                  )}
                  <div className="model-menu-divider" />
                  <button className="model-opt" onClick={() => { setModelMenuOpen(false); openSettings(); }}>
                    <Icon name="Settings" size={14} /><span className="model-opt-name">Manage providers…</span>
                  </button>
                </div>
              )}
            </div>

            <button
              type="button"
              className={'mic-btn' + (voice.state !== 'idle' ? ' ' + voice.state : '')}
              onClick={voice.toggle}
              title={voice.statusNote || (voice.state === 'recording' ? 'Stop recording and transcribe (Whisper)' : (voice.state === 'transcribing' ? 'Transcribing speech…' : 'Voice type with built-in Whisper model'))}
            >
              <Icon name={voice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={15} className={voice.state === 'transcribing' ? 'spin' : ''} />
              {voice.state === 'recording' && <span className="mic-time">{Math.floor(voice.seconds / 60)}:{String(voice.seconds % 60).padStart(2, '0')}</span>}
            </button>

            {streaming && (
              <button
                type="button"
                className={'pause-btn' + (paused ? ' paused' : '')}
                onClick={() => (paused ? (onResume && onResume('')) : (onPause && onPause()))}
                title={paused ? 'Resume agent' : 'Pause agent at next boundary'}
                aria-label={paused ? 'Resume' : 'Pause'}
              >
                <Icon name={paused ? 'Play' : 'Pause'} size={15} />
              </button>
            )}
            {streaming && <button className="send stop" onClick={stop} title="Stop"><Icon name="Stop" size={16} /></button>}
            {(!streaming || hasText) && (
              <button
                className={'send' + (streaming ? ' queued' : '')}
                onClick={() => { send(); syncInputState(''); }}
                title={streaming ? 'Queue message' : 'Send'}
              >
                <Icon name="ArrowUp" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// ---------- Settings ----------
// ---------- Accounts ----------

/**
 * One human-readable line out of any error value: strip markup, collapse
 * whitespace, cap the length. Every surface that shows a provider error uses
 * this so nothing raw (HTML, stack trace, JSON) ever reaches the user.
 */
function humanText(v) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
}

/**
 * The Claude credential belongs to the Claude Code CLI, so this app never runs
 * its own OAuth for Claude — a second grant would mint a competing refresh
 * token and sign the CLI out. Both sign-in surfaces (Settings → Accounts and
 * the composer's model menu) drive the same CLI-owned flow through this hook:
 * start `claude auth login`, surface the URL it prints, forward the pasted
 * `code#state`, then let main adopt the keychain pair the CLI writes.
 *
 * `onChanged` is refreshed after every completed sign-in so the caller can
 * reload its account list without this hook knowing about it.
 */
function useClaudeReconnect({ t, onChanged }) {
  const [rc, setRc] = useState(null); // { flowId, url, code, sent, line }
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const changed = useRef(onChanged);
  changed.current = onChanged;
  const tRef = useRef(t);
  tRef.current = t;
  const rcRef = useRef(rc);
  rcRef.current = rc;

  const refresh = useCallback(async () => {
    const fn = changed.current;
    if (typeof fn === 'function') { try { await fn(); } catch (_) {} }
  }, []);

  // A Claude reconnect finishes when the CLI exits and we adopt its keychain.
  useEffect(() => {
    if (!window.autobot.onProviderReconnectResult) return undefined;
    return window.autobot.onProviderReconnectResult(async (flowId, result) => {
      setRc((m) => (m && m.flowId === flowId ? null : m));
      if (result && result.ok) { setNotice(''); await refresh(); }
      else setNotice(humanText((result && result.error) || 'sign-in did not complete'));
    });
  }, [refresh]);

  // The CLI judges a pasted code line by line. A rejected code that leaves it
  // waiting produces no result event at all, so quote its own words and hand
  // the box back (`sent: false`) whenever it asks for the full code.
  useEffect(() => {
    if (!window.autobot.onProviderReconnectLine) return undefined;
    return window.autobot.onProviderReconnectLine((flowId, payload) => {
      const line = humanText(payload && payload.line);
      if (!line) return;
      const retry = !!(payload && payload.retryable);
      setRc((m) => {
        if (!m || m.flowId !== flowId) return m;
        return retry ? { ...m, line, sent: false } : { ...m, line };
      });
      if (retry) setNotice('');
    });
  }, []);

  // A flow can be started from the other surface (the model menu vs Settings →
  // Accounts). Main owns the single login child, so on mount adopt whatever it
  // is already waiting on: the same sign-in then shows its paste box in both
  // places instead of looking dead in the one the user happens to be looking at.
  useEffect(() => {
    if (!window.autobot.providerReconnectState) return undefined;
    let stop = false;
    (async () => {
      try {
        const s = await window.autobot.providerReconnectState();
        if (stop || !s || !s.waiting || !s.url) return;
        setRc((m) => (m ? m : { flowId: s.flowId, url: s.url, code: '', sent: false, line: '' }));
      } catch (_) {}
    })();
    return () => { stop = true; };
  }, []);

  // The CLI can exit while the panel still shows a paste box. Ask main whether
  // the login is actually still waiting; a completed sign-in also stops the
  // flow, so only a window still closed a moment later is reported as closed.
  const rcFlowId = rc ? rc.flowId : '';
  const rcSent = !!(rc && rc.sent);
  useEffect(() => {
    if (!rcFlowId || rcSent || !window.autobot.providerReconnectState) return undefined;
    let stop = false;
    const probe = async () => {
      try { return await window.autobot.providerReconnectState(); } catch (_) { return null; }
    };
    const tick = async () => {
      const s = await probe();
      if (stop || !s || s.waiting) return;
      await new Promise((r) => setTimeout(r, 1200));
      if (stop) return;
      const again = await probe();
      if (stop || !again || again.waiting) return;
      setRc((m) => (m && m.flowId === rcFlowId ? null : m));
      setNotice(String(tRef.current ? tRef.current('account.reconnect.closed') : 'The Claude Code sign-in window closed.'));
    };
    const iv = setInterval(tick, 3000);
    return () => { stop = true; clearInterval(iv); };
  }, [rcFlowId, rcSent]);

  const start = useCallback(async () => {
    setBusy(true);
    setNotice('');
    try {
      const r = await window.autobot.providerReconnectClaude();
      if (!r || r.ok === false) {
        setNotice(humanText((r && r.error) || 'could not start Claude Code sign-in'));
        return null;
      }
      setRc({ flowId: r.flowId, url: r.url || '', code: '', sent: false, line: '' });
      try { if (r.url && window.autobot.openExternal) await window.autobot.openExternal(r.url); } catch (_) {}
      return r;
    } catch (e) {
      setNotice(humanText((e && e.message) || 'could not start Claude Code sign-in'));
      return null;
    } finally { setBusy(false); }
  }, []);

  const cancel = useCallback(async () => {
    try { if (window.autobot.providerReconnectClaudeCancel) await window.autobot.providerReconnectClaudeCancel(); } catch (_) {}
    setRc(null);
  }, []);

  const setCode = useCallback((code) => setRc((m) => (m ? { ...m, code } : m)), []);

  const submit = useCallback(async () => {
    const m = rcRef.current;
    if (!m || !String(m.code || '').trim()) return;
    setBusy(true);
    try {
      const r = await window.autobot.providerReconnectClaudeCode(m.flowId, String(m.code).trim());
      if (r && r.ok === false) {
        const said = humanText(r.error || 'paste the code the sign-in page shows');
        // A dead flow is cleared so the panel stops offering a box that cannot
        // accept the code; anything else keeps the box and explains itself in
        // place, where the user is actually looking.
        if (/no longer waiting|window closed|expired/i.test(String(r.error || ''))) {
          setRc(null);
          setNotice(said);
          return;
        }
        setNotice('');
        setRc((cur) => (cur ? { ...cur, line: said, sent: false } : cur));
        return;
      }
      setNotice('');
      setRc({ ...m, code: '', sent: true, line: '' });
    } finally { setBusy(false); }
  }, []);

  return { rc, busy, notice, setNotice, start, cancel, submit, setCode };
}

/** Shared markup for the Claude paste-the-code box (both sign-in surfaces). */
function ClaudeReconnectPanel({ t, rc, busy, onCancel, onChange, onSubmit }) {
  if (!rc) return null;
  return (
    <div className="prov-token prov-manual">
      <div className="prov-manual-hint">
        {rc.sent ? t('account.manual.checking') : t('account.reconnect.hint')}
      </div>
      {rc.line && <div className={'prov-manual-line' + (rc.sent ? '' : ' warn')}>{rc.line}</div>}
      {rc.url && (
        <button className="prov-link" onClick={async () => { try { await window.autobot.openExternal(rc.url); } catch (_) {} }}>
          {t('account.reconnect.open')}
        </button>
      )}
      <input
        className="prov-token-in"
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder={t('account.manual.placeholder')}
        value={rc.code || ''}
        disabled={!!busy || rc.sent}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); onSubmit(); } }}
      />
      <button
        className="prov-link"
        disabled={!!busy || rc.sent || !String(rc.code || '').trim()}
        onClick={onSubmit}
      >{rc.sent ? t('account.manual.submitting') : t('account.manual.submit')}</button>
      <button className="prov-x" title={t('account.cancel')} aria-label={t('account.cancel')} onClick={onCancel}><Icon name="X" size={12} /></button>
    </div>
  );
}

// The real, local account surface. It reads this machine's provider subscriptions
// through the same IPC the model picker uses and drives real sign-in / sign-out /
// import. There is no account backend and no fabricated identity: every row below
// came from a token this app actually holds, so what you see is what will be used.
function AccountSection({ T, provider, setProvider }) {
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');
  const [manual, setManual] = useState(null); // { flowId, provId, code, sent }
  const [token, setToken] = useState({}); // per-provider pasted API key

  const load = useCallback(async () => {
    try {
      const r = await window.autobot.providerStatus();
      setSt(r && r.ok ? r.status : null);
    } catch (_) { setSt(null); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Claude sign-in is CLI-owned; this hook gives the panel the same flow the
  // composer's model menu uses.
  const claude = useClaudeReconnect({ t: T, onChanged: load });

  // Main reports the outcome of a paste-the-code sign-in here.
  useEffect(() => {
    if (!window.autobot.onProviderManualResult) return undefined;
    return window.autobot.onProviderManualResult(async (flowId, result) => {
      setManual((m) => (m && m.flowId === flowId ? null : m));
      if (result && result.ok) { setNotice(''); await load(); }
      else setNotice(humanText((result && result.error) || 'sign-in did not complete'));
    });
  }, [load]);

  // Browser sign-in does not resolve until the round-trip finishes (main waits
  // up to 10 minutes on the loopback listener). Never hold the panel open on
  // it: start the flow, keep the row spinner honest, and refresh when it lands
  // so the paste-a-code fallback stays clickable the whole time.
  const startBrowserSignIn = (id) => {
    setBusy('signin:' + id);
    setNotice('');
    Promise.resolve()
      .then(() => window.autobot.providerSignIn(id))
      .then((r) => {
        if (r && r.cancelled) setNotice('Sign-in cancelled — no account was added.');
        else if (r && r.ok === false) setNotice(humanText(r.error || 'sign-in was refused'));
      })
      .catch((e) => setNotice(humanText((e && e.message) || 'sign-in was refused')))
      .finally(() => { setBusy(''); load(); });
  };

  // Same cancel as the composer picker: the browser can be closed or lost, and
  // waiting out the timeout would look like a hang.
  const cancelBrowserSignIn = async (id) => {
    try { await window.autobot.providerSignInCancel(id); } catch (_) {}
  };

  const act = async (kind, id, account) => {
    if (kind === 'signin') { startBrowserSignIn(id); return null; }
    setBusy(kind + ':' + (id || ''));
    try {
      let r;
      if (kind === 'signout') r = await window.autobot.providerSignOut(id, account);
      else if (kind === 'import') r = await window.autobot.providerImport();
      else if (kind === 'bearer') r = await window.autobot.providerAddBearer(id, account);
      if (kind === 'import') {
        // Summarise the scan so a successful or all-skipped import is never silent.
        if (r && r.ok !== false && r.result) {
          const im = (r.result.imported || []).length;
          const sk = (r.result.skipped || []).length;
          const er = (r.result.errors || []).length;
          const parts = ['Imported ' + im];
          if (sk) parts.push('already present ' + sk);
          if (er) parts.push('failed ' + er);
          setNotice(parts.join(' · ') + (im ? ' — listed below.' : ' — nothing new to import.'));
        } else if (r && r.error) {
          setNotice(humanText(r.error));
        }
      } else if (r && r.ok === false && r.error) {
        // One human line, never a stack trace or raw markup.
        setNotice(humanText(r.error));
      } else {
        setNotice('');
        if (kind === 'bearer') setToken({});
      }
      await load();
      return r;
    } finally { setBusy(''); }
  };

  // Paste-the-code fallback: no loopback listener; we open the consent page which
  // prints a code, and hand it back here (what the Claude CLI does when the
  // browser cannot reach localhost).
  const signInManual = async (id) => {
    setBusy('manual:' + id);
    try {
      const r = await window.autobot.providerSignInManual(id);
      if (!r || r.ok === false) {
        setNotice(humanText((r && r.error) || 'could not start sign-in'));
        return;
      }
      setNotice('');
      setManual({ flowId: r.flowId, provId: id, url: r.url || '', code: '', sent: false });
    } catch (e) {
      setNotice(humanText((e && e.message) || 'could not start sign-in'));
    } finally { setBusy(''); }
  };

  const submit = async () => {
    const m = manual;
    if (!m || !String(m.code || '').trim()) return;
    setBusy('manual:' + m.provId);
    try {
      const r = await window.autobot.providerSubmitCode(m.flowId, String(m.code).trim());
      if (r && r.ok === false) {
        setNotice(humanText(r.error || 'paste the code the sign-in page shows'));
        return;
      }
      setNotice('');
      setManual({ ...m, code: '', sent: true });
    } finally { setBusy(''); }
  };

  // Selecting an account here does the same thing the composer's model menu
  // does: only the id goes into provider state, and main resolves it to a
  // short-lived bearer at the start of every turn. Pick a model the vendor
  // actually advertises so the first turn is not sent with a foreign id.
  const use = async (pv, a) => {
    if (!setProvider) return;
    const ids = (pv.models || []).map((m) => m.id);
    const dflt = ids.includes(provider.model) ? provider.model : (ids[0] || provider.model || '');
    setProvider((v) => ({
      ...v,
      baseURL: '',
      apiKey: '',
      model: dflt || v.model,
      supportsTools: true,
      oauthProvider: a.id,
      transport: pv.transport,
      oauth: true,
      accessToken: '',
    }));
    try { if (window.autobot.providerSetActive) await window.autobot.providerSetActive(pv.id, a.account); } catch (_) { /* main may not persist */ }
  };

  const providers = (st && st.providers) || [];

  // Secondary line under an account name. Never repeat the plan when the label
  // already carries it ("Claude · max" + "max"), and never show a bare internal
  // token like "oauth" when we know which app the credential came from.
  const SOURCE_NAMES = {
    'claude-code': 'Claude Code app',
    'antigravity-app': 'Antigravity app',
    'codex-cli': 'Codex CLI',
    'grok-cli': 'Grok CLI',
    oauth: T('account.subscription'),
    manual: T('account.keySource'),
  };
  const acctSub = (a) => {
    const label = String(a.label || '');
    // The provider's own name for the plan when it gave us one ("Free", "Plus"),
    // else the internal slug. Both come from a real entitlement check.
    const plan = String(a.planName || a.plan || '');
    const planShown = plan && !label.toLowerCase().includes(plan.toLowerCase());
    if (planShown) return plan;
    return SOURCE_NAMES[a.source] || plan || T('account.signedIn');
  };

  return (
    <div className="account-section">
      <h3><Icon name="Plug" size={14} /> {T('account.title')}</h3>
      <p className="muted" style={{ margin: '2px 0 12px' }}>{T('account.blurb')}</p>

      {!st && <p className="muted">{T('account.loading')}</p>}

      {/* An index that cannot be parsed is not "no accounts". Say so instead of
          rendering an empty list the user would read as their sign-ins being gone. */}
      {st && st.storeError && (
        <ProvNotice warn text={T('account.storeError')} />
      )}

      <div className="acct-prov-list">
      {st && providers.map((pv) => {
        const hasAccounts = pv.accounts && pv.accounts.length > 0;
        const needsAction = !hasAccounts || pv.accounts.some((a) => a.needsSignIn || a.expired);
        return (
        <div key={pv.id} className="prov-group acct-prov">
          <div className="prov-head acct-card-head">
            <div className="acct-title-wrap">
              <span className="prov-name">{pv.label}</span>
              <span className={'acct-count' + (hasAccounts ? ' connected' : '')}>
                {pv.accounts.length === 1 ? '1 account' : (pv.accounts.length ? pv.accounts.length + ' ' + T('account.count') : T('account.none'))}
              </span>
            </div>
            <div className="acct-actions">
              {pv.id === 'claude' && (
                <button type="button" className={needsAction ? 'primary' : ''} disabled={!!busy || claude.busy} onClick={claude.start}>
                  <Icon name="ArrowInSquare" size={13} /> {claude.busy ? T('account.opening') : T('account.reconnect')}
                </button>
              )}
              {pv.id !== 'claude' && pv.canBrowserSignIn && (
                <button
                  type="button"
                  className={needsAction ? 'primary' : ''}
                  disabled={!!busy && busy !== 'signin:' + pv.id}
                  onClick={() => (busy === 'signin:' + pv.id ? cancelBrowserSignIn(pv.id) : act('signin', pv.id))}
                >
                  <Icon name="ArrowInSquare" size={13} /> {busy === 'signin:' + pv.id ? T('account.cancel') : (pv.accounts.length ? T('account.add') : T('account.signIn'))}
                </button>
              )}
              {pv.id !== 'claude' && pv.canManualCode && (
                <button type="button" disabled={!!busy} onClick={() => signInManual(pv.id)}>
                  <Icon name="Clipboard" size={13} /> {busy === 'manual:' + pv.id ? T('account.opening') : T('account.paste')}
                </button>
              )}
            </div>
          </div>

          {hasAccounts && (
            <div className="acct-rows">
              {pv.accounts.map((a) => {
                const on = provider && provider.oauthProvider === a.id;
                return (
                  <div key={a.id} className={'prov-acct' + (on ? ' on' : '')}>
                    <span className={'model-dot ' + (a.needsSignIn || a.expired ? 'out' : 'ok')} />
                    <button
                      type="button"
                      className="prov-pick"
                      title={a.needsSignIn ? T('account.needsSignIn') : (a.expired ? T('account.expired') : (a.label || a.account))}
                      onClick={() => use(pv, a)}
                    >
                      <span className="model-opt-name">{a.label || a.account}</span>
                      <span className="model-opt-prov">{a.needsSignIn ? T('account.needsSignIn') : acctSub(a)}</span>
                      {on && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                    <button type="button" className="prov-x" title={T('account.signOut')} disabled={busy === 'signout:' + pv.id} onClick={() => act('signout', pv.id, a.account)}>
                      <Icon name="Logout" size={13} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {pv.id === 'claude' && (
            <ClaudeReconnectPanel
              t={T}
              rc={claude.rc}
              busy={busy || claude.busy}
              onCancel={claude.cancel}
              onChange={claude.setCode}
              onSubmit={claude.submit}
            />
          )}

          {manual && manual.provId === pv.id && (
            <div className="prov-token prov-manual">
              <div className="prov-manual-hint">
                {manual.sent ? T('account.manual.checking') : T('account.manual.hint')}
              </div>
              <input
                className="prov-token-in"
                type="text"
                autoComplete="off"
                spellCheck={false}
                placeholder={T('account.manual.placeholder')}
                value={manual.code || ''}
                disabled={!!busy || manual.sent}
                onChange={(e) => setManual((m) => (m ? { ...m, code: e.target.value } : m))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
              />
              <button
                type="button"
                className="prov-link"
                disabled={!!busy || manual.sent || !String(manual.code || '').trim()}
                onClick={submit}
              >{manual.sent ? T('account.manual.submitting') : T('account.manual.submit')}</button>
              <button type="button" className="prov-x" title={T('account.cancel')} aria-label={T('account.cancel')} onClick={() => setManual(null)}><Icon name="X" size={12} /></button>
            </div>
          )}

          {pv.canPasteKey && (
            <div className="prov-token acct-key-row">
              <input
                className="prov-token-in"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={T('account.key') + ' ' + pv.vendor + ' ' + T('account.key.suffix')}
                value={token[pv.id] || ''}
                disabled={!!busy}
                onChange={(e) => setToken((m) => ({ ...m, [pv.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter' && (token[pv.id] || '').trim()) { e.preventDefault(); act('bearer', pv.id, (token[pv.id] || '').trim()); } }}
              />
              <button
                type="button"
                className="acct-key-btn"
                disabled={!!busy || !(token[pv.id] || '').trim()}
                onClick={() => act('bearer', pv.id, (token[pv.id] || '').trim())}
              >{busy === 'bearer:' + pv.id ? T('account.key.checking') : T('account.key.add')}</button>
            </div>
          )}
        </div>
        );
      })}
      </div>

      {st && (
        <div className="account-actions">
          <button disabled={!!busy} onClick={() => act('import')}>
            <Icon name="Download" size={13} /> {busy === 'import:' ? T('account.import.scanning') : T('account.import')}
          </button>
        </div>
      )}

      <ProvNotice text={notice || claude.notice} />
    </div>
  );
}

// ---------- Organization compliance (`taint:*` capabilities) ----------
// Desktop reads `memberships[].organization.capabilities` from the account API
// and derives every gate from it. Akron Code has no account backend, so the
// profile is declared here and the main process evaluates the exact same
// arithmetic (`electron/compliance.js`). Toggles map 1:1 onto capability strings.
function ComplianceSection({ compliance, setCompliance }) {
  const [busy, setBusy] = useState(false);
  const [auditCount, setAuditCount] = useState(null);
  const profile = (compliance && compliance.profile) || { capabilities: [], dataRetention: 'default' };
  const state = (compliance && compliance.state) || null;
  const catalog = (compliance && compliance.catalog) || [];

  useEffect(() => {
    if (!window.autobot || !window.autobot.complianceAudit) return;
    window.autobot.complianceAudit(500).then((rows) => setAuditCount((rows || []).length)).catch(() => {});
  }, [compliance]);

  const save = async (patch) => {
    if (!window.autobot || !window.autobot.complianceSet) return;
    setBusy(true);
    try {
      const snap = await window.autobot.complianceSet(patch);
      setCompliance(snap);
    } catch (_) {} finally { setBusy(false); }
  };

  const reset = async () => {
    if (!window.autobot || !window.autobot.complianceReset) return;
    setBusy(true);
    try {
      const snap = await window.autobot.complianceReset();
      setCompliance(snap);
    } catch (_) {} finally { setBusy(false); }
  };

  const caps = profile.capabilities || [];
  const toggle = (id) => {
    if (id.endsWith('*')) return; // prefix row is documentation only
    const next = caps.includes(id) ? caps.filter((c) => c !== id) : [...caps, id];
    save({ capabilities: next });
  };

  const tone = state ? state.tone : 'unknown';
  const toneLabel = { ok: 'Allowed', warn: 'Marked', blocked: 'Blocked', unknown: 'Unknown' }[tone] || 'Unknown';

  const rows = catalog.filter((r) => !r.prefix);
  const taintRows = rows.filter((r) => String(r.id).startsWith('taint:'));
  const relatedRows = rows.filter((r) => !String(r.id).startsWith('taint:'));

  const derived = state
    ? [
        ['Retention', state.retention],
        ['HIPAA', state.hipaa],
        ['CMEK', state.cmek === null ? 'not applicable' : state.cmek ? 'blocked' : 'available'],
        ['Cloud & model moves', state.cloudMove && state.cloudMove.verdict ? state.cloudMove.verdict + (state.cloudMove.why ? ' · ' + state.cloudMove.why : '') : 'unverified'],
        ['MCP tool toggles', state.toolSwitch && state.toolSwitch.allowed ? 'local only' : 'local only · blocked from sync'],
        ['Session deletion', state.deletion && state.deletion.allowed ? (state.audit ? 'allowed · audited' : 'allowed') : 'refused'],
        ['Product feedback', state.feedback && state.feedback.allowed ? 'allowed' : 'off'],
        ['Deployment', state.deployment + (state.deploymentPending ? ' · pending' : '')],
        ['Chat', state.chat ? (state.chat.allowed ? (state.chat.planAllowed ? 'allowed · paid plan' : 'allowed') : 'refused') : 'unknown'],
      ]
    : [];

  return (
    <>
      <h3><Icon name="WarningShield" size={14} /> Compliance</h3>
      <p className="muted">
        Organization data-classification for this device. Capabilities gate session deletion, cloud moves,
        MCP tool sync and product feedback exactly as the desktop app does. Nothing leaves this machine.
      </p>

      <div className="row">
        <label>Organization
          <input
            value={profile.organization || ''}
            placeholder="Local profile (no account backend)"
            onChange={(e) => save({ organization: e.target.value })}
            disabled={busy}
          />
        </label>
        <label>Data retention
          <select value={profile.dataRetention || 'default'} onChange={(e) => save({ dataRetention: e.target.value })} disabled={busy}>
            <option value="default">default (no agreement)</option>
            <option value="none">none (zero retention)</option>
            <option value="limited">limited</option>
          </select>
        </label>
      </div>

      <div className={'compliance-badge tone-' + tone}>
        <b>{toneLabel}</b>
        <span>{state ? state.headline : 'Loading compliance state…'}</span>
      </div>

      {derived.length > 0 && (
        <div className="compliance-grid">
          {derived.map(([k, v]) => (
            <div key={k} className="compliance-cell"><span>{k}</span><b>{v}</b></div>
          ))}
        </div>
      )}

      <h4 className="compliance-sub">Organization capabilities</h4>
      {taintRows.map((r) => (
        <label className="check" key={r.id} title={r.summary}>
          <input type="checkbox" checked={caps.includes(r.id)} onChange={() => toggle(r.id)} disabled={busy} />
          {r.label}
          <code className="compliance-code">{r.id}</code>
        </label>
      ))}

      <h4 className="compliance-sub">Retention flags</h4>
      {relatedRows.map((r) => (
        <label className="check" key={r.id} title={r.summary}>
          <input type="checkbox" checked={caps.includes(r.id)} onChange={() => toggle(r.id)} disabled={busy} />
          {r.label}
          <code className="compliance-code">{r.id}</code>
        </label>
      ))}

      <div className="row compliance-actions">
        <label className="check">
          <input
            type="checkbox"
            checked={profile.visibilityStatus === 'pending'}
            onChange={(e) => save({ visibilityStatus: e.target.checked ? 'pending' : null })}
            disabled={busy}
          />
          Deployment visibility pending
        </label>
        <span className="muted">Deletion audit records: {auditCount === null ? '—' : auditCount}</span>
        <button onClick={reset} disabled={busy}>Reset profile</button>
      </div>
    </>
  );
}


// ---------- Bundled agent runtimes (Claude Code / Codex / Grok CLI) ----------
// Every CLI the Bash tool can spawn ships inside the DMG and updates itself from
// upstream. This panel is the only place that shows which copy is actually in
// effect, because a stale bundled binary silently degrades every agent run.
function RuntimesSection() {
  const [rows, setRows] = useState([]);
  const [meta, setMeta] = useState({ bundledDir: '', error: '' });
  const [busy, setBusy] = useState('');   // runtime id, or '' when idle
  const [live, setLive] = useState({});   // id -> progress line
  const [note, setNote] = useState('');
  const api = (typeof window !== 'undefined' && window.autobot) || {};

  const apply = (r) => {
    if (r && r.runtimes) setRows(r.runtimes);
    if (r && r.bundledDir !== undefined) setMeta({ bundledDir: r.bundledDir || '', error: r.ok === false ? (r.error || '') : '' });
  };

  const refresh = useCallback(async () => {
    if (!api.runtimes) return;
    try { apply(await api.runtimes()); }
    catch (e) { setMeta((m) => ({ ...m, error: String((e && e.message) || e) })); }
  }, [api]);

  useEffect(() => { refresh(); }, [refresh]);

  // Live progress + auto-refresh when a background pass promotes something.
  useEffect(() => {
    if (!api.onEvent) return undefined;
    return api.onEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'runtime' && evt.id) {
        setLive((l) => ({ ...l, [evt.id]: evt.message || evt.phase || '' }));
        if (evt.phase === 'done' || evt.phase === 'error') refresh();
      } else if (evt.type === 'runtimes-updated') {
        refresh();
        const n = (evt.results || []).length;
        if (n) setNote('Updated ' + n + ' runtime' + (n === 1 ? '' : 's') + ' in the background.');
      }
    });
  }, [api, refresh]);

  const autoUpdate = rows.length ? rows.every((r) => r.autoUpdate !== false) : true;

  const check = async () => {
    setBusy('check'); setNote('');
    try { const r = await api.runtimesCheck(); apply(r); const n = r && r.updates ? r.updates.length : 0; setNote(n ? (n + ' update' + (n === 1 ? '' : 's') + ' available.') : 'Everything is current.'); }
    catch (e) { setNote(String((e && e.message) || e)); }
    finally { setBusy(''); }
  };

  const update = async (id, force) => {
    setBusy(id || 'all');
    setLive((l) => ({ ...l, [id || 'all']: 'Starting…' }));
    try { const r = await api.runtimesUpdate(id || undefined, !!force); apply(r); if (r && r.ok === false) setNote(r.error || 'Update failed.'); }
    catch (e) { setNote(String((e && e.message) || e)); }
    finally { setBusy(''); setLive((l) => { const n = { ...l }; delete n[id || 'all']; return n; }); }
  };

  const rollback = async (id) => {
    setBusy(id);
    try { const r = await api.runtimesRollback(id); apply(r); if (r && r.ok === false) setNote(r.error || 'Rollback failed.'); }
    catch (e) { setNote(String((e && e.message) || e)); }
    finally { setBusy(''); }
  };

  const toggleAuto = async (on) => {
    try { await api.runtimesAutoUpdate(on); setRows((rs) => rs.map((r) => ({ ...r, autoUpdate: on }))); }
    catch (_) { /* preference is best-effort */ }
  };

  const sourceLabel = (src) => src === 'installed' ? 'self-updated' : src === 'bundled' ? 'bundled in app' : src === 'system' ? 'from PATH' : 'not found';

  return (
    <>
      <h3><Icon name="Settings" size={14} /> Bundled agent runtimes</h3>
      <p className="muted" style={{ marginTop: -6 }}>
        The Claude Code, Codex and Grok CLIs the Bash tool runs. Each ships inside the app and
        updates itself from the vendor&apos;s own release feed.
      </p>
      <label className="check">
        <input type="checkbox" checked={autoUpdate} onChange={(e) => toggleAuto(e.target.checked)} />
        Check for newer versions automatically on launch
      </label>
      <div className="rt-list">
        {rows.length === 0 && <p className="muted">{meta.error || 'Reading runtime status…'}</p>}
        {rows.map((r) => {
          const prog = live[r.id];
          const stale = r.latest && r.version && r.latest !== r.version;
          return (
            <div key={r.id} className={'rt-item' + (r.busy ? ' busy' : '')}>
              <div className="rt-main">
                <span className="rt-name">{r.label || r.id}</span>
                <span className="rt-vendor">{r.vendor}</span>
                <span className={'rt-src rt-src-' + (r.source || 'missing')}>{sourceLabel(r.source)}</span>
              </div>
              <div className="rt-ver">
                <code>{r.version || '—'}</code>
                {stale && <span className="rt-arrow"> → <b>{r.latest}</b></span>}
                {!stale && r.latest && <span className="rt-uptodate"> · latest</span>}
                {r.error && <span className="rt-err" title={r.error}> · {r.error.slice(0, 60)}</span>}
              </div>
              <div className="rt-actions">
                <button type="button" className="btn-mini" disabled={!!busy} onClick={() => update(r.id, r.source !== 'missing' && !stale)}>
                  {busy === r.id ? 'Updating…' : (r.source === 'missing' ? 'Install' : stale ? 'Update' : 'Reinstall')}
                </button>
                {r.source === 'installed' && (
                  <button type="button" className="btn-mini" disabled={!!busy} onClick={() => rollback(r.id)} title="Switch back to the previous version">Rollback</button>
                )}
              </div>
              {prog && <div className="rt-prog">{prog}</div>}
            </div>
          );
        })}
      </div>
      <div className="rt-foot">
        <button type="button" className="btn-mini" disabled={!!busy} onClick={check}>{busy === 'check' ? 'Checking…' : 'Check for updates'}</button>
        <button type="button" className="btn-mini" disabled={!!busy} onClick={() => update('')}>{busy === 'all' ? 'Updating…' : 'Update all'}</button>
        {note && <span className="muted rt-note">{note}</span>}
      </div>
      {meta.bundledDir && <p className="muted rt-path">Bundled copies: <code>{meta.bundledDir}</code></p>}
      {meta.error && !rows.length && <p className="muted rt-path">{meta.error}</p>}
    </>
  );
}

function DependenciesAndUpdaterSection({ setNotice }) {
  const [deps, setDeps] = useState(null);
  const [installingId, setInstallingId] = useState('');
  const [lspNote, setLspNote] = useState('');
  const [upd, setUpd] = useState(null);
  const [updBusy, setUpdBusy] = useState('');
  const [updProg, setUpdProg] = useState(null);
  const [staged, setStaged] = useState(null);
  const api = (typeof window !== 'undefined' && window.autobot) || {};

  const refreshDeps = useCallback(async () => {
    if (!api.depsStatus) return;
    try {
      const r = await api.depsStatus();
      if (r && r.ok) setDeps(r);
    } catch (_) {}
  }, [api]);

  useEffect(() => { refreshDeps(); }, [refreshDeps]);

  useEffect(() => {
    if (!api.onEvent) return undefined;
    return api.onEvent((evt) => {
      if (!evt) return;
      if (evt.type === 'dep-lsp' && evt.message) setLspNote(evt.message);
      if (evt.type === 'app-update-progress') setUpdProg(evt);
    });
  }, [api]);

  const installLsp = async (id) => {
    if (!api.depsInstallLsp) return;
    setInstallingId(id);
    setLspNote(`Installing ${id} language server…`);
    try {
      const r = await api.depsInstallLsp(id);
      if (r && r.ok) {
        if (r.status) setDeps(r.status);
        setLspNote(`✅ Installed ${id} language server (${r.path || 'ready'})`);
        setNotice && setNotice(`Installed ${id} LSP server`);
      } else {
        setLspNote(`❌ Install failed: ${(r && r.error) || 'unknown'}`);
      }
    } finally {
      setInstallingId('');
    }
  };

  const checkAppUpdate = async () => {
    if (!api.updateCheck) return;
    setUpdBusy('check');
    try {
      const r = await api.updateCheck();
      setUpd(r);
      if (r && r.ok && r.updateAvailable) {
        setNotice && setNotice(`Update available: Akron Code v${r.latestVersion}`);
      }
    } finally {
      setUpdBusy('');
    }
  };

  const downloadUpdate = async () => {
    if (!upd || !upd.asset || !api.updateDownload) return;
    setUpdBusy('download');
    setUpdProg({ percent: 0 });
    try {
      const r = await api.updateDownload({ asset: upd.asset, sumsUrl: upd.sumsUrl });
      if (r && r.ok) {
        setStaged(r);
        setNotice && setNotice(`Verified SHA-256 update ready: ${r.name}`);
      } else {
        setUpd((u) => ({ ...(u || {}), error: (r && r.error) || 'Download failed' }));
      }
    } finally {
      setUpdBusy('');
    }
  };

  const installStagedUpdate = async () => {
    if (!staged || !staged.path || !api.updateApply) return;
    const r = await api.updateApply(staged.path);
    if (r && r.ok) setNotice && setNotice('Launching Akron Code installer…');
  };

  return (
    <>
      <div className="settings-card">
        <h3>App Auto-Update (GitHub Releases)</h3>
        <div className="env-prof-row">
          <div className="env-prof-meta">
            <span className="env-prof-title">Akron Code v{(upd && upd.currentVersion) || '1.0.0'}</span>
            <span className="env-prof-sub">
              {upd
                ? (upd.ok
                  ? (upd.updateAvailable ? `New version v${upd.latestVersion} available (${upd.asset?.name || 'package'})` : `Up to date (latest v${upd.latestVersion})`)
                  : (upd.error || 'Could not check releases'))
                : 'Checks GitHub Releases & verifies SHA-256 checksums (settings & chats preserved).'}
            </span>
          </div>
          <div className="env-prof-actions">
            <button type="button" className="btn-mini primary" disabled={!!updBusy} onClick={checkAppUpdate}>
              {updBusy === 'check' ? 'Checking…' : 'Check for Updates'}
            </button>
            {upd && upd.updateAvailable && upd.asset && !staged && (
              <button type="button" className="btn-mini" disabled={!!updBusy} onClick={downloadUpdate}>
                {updBusy === 'download' ? `Downloading ${updProg?.percent || 0}%` : 'Download & Verify'}
              </button>
            )}
            {staged && (
              <button type="button" className="btn-mini primary" onClick={installStagedUpdate}>
                Install v{upd?.latestVersion || ''}
              </button>
            )}
          </div>
        </div>
        {upd && upd.releaseNotes && (
          <pre className="bic-html" style={{ marginTop: 8 }}>{upd.releaseNotes.slice(0, 600)}</pre>
        )}
      </div>

      <div className="settings-card">
        <h3>Built-in Dependencies &amp; Optional LSP Servers</h3>
        {deps && (
          <p className="muted" style={{ marginTop: -4 }}>
            Core stack: <b>{deps.healthyCount}/{deps.totalBundled}</b> bundled modules healthy
          </p>
        )}
        <div className="env-prof-list">
          {((deps && deps.bundled) || []).map((b) => (
            <div key={b.id} className="env-prof-row">
              <div className="env-prof-meta">
                <span className="env-prof-title">{b.label}</span>
                <span className="env-prof-sub">{b.detail}</span>
              </div>
              <span className={'mc-pill ' + (b.ok ? 'done' : 'err')}>{b.ok ? 'Bundled' : 'Fallback'}</span>
            </div>
          ))}
        </div>

        <h4 style={{ margin: '16px 0 6px', fontSize: 13 }}>Optional Language Servers (LSP)</h4>
        <div className="env-prof-list">
          {((deps && deps.lspServers) || []).map((l) => (
            <div key={l.id} className="env-prof-row">
              <div className="env-prof-meta">
                <span className="env-prof-title">{l.label}</span>
                <span className="env-prof-sub">{l.languages} · {l.installed ? l.path : 'Not installed'}</span>
              </div>
              <div className="env-prof-actions">
                <button
                  type="button"
                  className={'btn-mini ' + (l.installed ? '' : 'primary')}
                  disabled={!!installingId}
                  onClick={() => installLsp(l.id)}
                >
                  {installingId === l.id ? 'Installing…' : (l.installed ? 'Repair / Update' : 'Auto-Install')}
                </button>
              </div>
            </div>
          ))}
        </div>
        {lspNote && <p className="muted" style={{ marginTop: 8 }}>{lspNote}</p>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Orchestrator pool — data-driven checklist
//
// The pool used to be free-text rows (#1 / URL / model / key / "+ Add
// provider"), which meant the user re-typed a provider that the app had
// already signed in and loaded. It is now a checklist of models this machine
// can actually serve: every signed-in subscription account's live catalog plus
// the local/API gateway the composer is pointed at. Ticking a row is the only
// way an entry enters `orchestrator.providers`, so the swarm roster can never
// name an endpoint that was never loaded. Subscription rows persist only
// `oauthProvider`; main resolves the bearer token per turn.
function orchId(row) {
  return row.oauthProvider
    ? 'oauth|' + row.oauthProvider + '|' + row.model
    : 'gw|' + normBase(row.baseURL) + '|' + row.model;
}

function OrchModelChecklist({ orchestrator, provider, localModels, localBase, saveOrch }) {
  const [cat, setCat] = useState({ status: null, models: {}, busy: false, error: '' });
  const [q, setQ] = useState('');

  const load = useCallback(async () => {
    setCat((c) => ({ ...c, busy: true, error: '' }));
    let status = null;
    let error = '';
    try {
      const r = await window.autobot.providerStatus();
      if (r && r.ok && r.status) {
        status = r.status;
        if (r.status.storeError) error = String(r.status.storeError);
      } else {
        error = (r && (r.error || r.message)) || 'could not read provider status';
      }
    } catch (e) {
      error = String((e && e.message) || e);
    }
    const models = {};
    if (status) {
      for (const pv of status.providers || []) {
        const accounts = (pv.accounts || []).filter((a) => a.hasToken !== false);
        // Ask per account: plan tiers expose different model sets, and the
        // account key is what the turn will resolve against.
        const keys = accounts.length ? accounts.map((a) => pv.id + ':' + a.account) : [pv.id];
        for (const key of keys) {
          try {
            const r = await window.autobot.providerModels(key);
            if (r && r.ok && (r.models || []).length) models[key] = r.models;
          } catch (_) {}
        }
      }
    }
    setCat({ status, models, busy: false, error });
  }, []);

  useEffect(() => { load(); }, [load]);

  const groups = useMemo(() => {
    const out = [];
    const status = cat.status;
    if (status) {
      for (const pv of status.providers || []) {
        const accounts = (pv.accounts || []).filter((a) => a.hasToken !== false);
        for (const a of accounts) {
          const key = pv.id + ':' + a.account;
          const list = cat.models[key] || cat.models[pv.id] || pv.models || [];
          const rows = (list || []).map((m) => ({
            oauthProvider: key,
            transport: pv.transport || '',
            oauth: true,
            baseURL: '',
            apiKey: '',
            model: m.id,
            label: m.label || m.id,
            window: m.windowLabel || '',
            contextWindow: m.contextWindow || 0,
            name: (pv.label || pv.id) + ' · ' + (a.planName || a.plan || a.account) + ' · ' + (m.label || m.id),
          }));
          if (rows.length) {
            out.push({
              key,
              title: (pv.label || pv.id) + ' · ' + (a.planName || a.plan || a.account || ''),
              rows: rows.map((r) => ({ ...r, id: orchId(r) })),
            });
          }
        }
      }
    }
    // Gateway + local models: whatever the composer is currently pointed at,
    // plus the models this machine's Ollama actually has pulled.
    const gw = [];
    const pb = normBase(provider && provider.baseURL);
    if (pb && !(provider && provider.oauthProvider) && provider.model) {
      gw.push({
        id: orchId({ baseURL: provider.baseURL, model: provider.model }),
        oauthProvider: '', transport: '', oauth: false,
        baseURL: provider.baseURL, apiKey: provider.apiKey || '',
        model: provider.model, label: provider.model,
        window: '', contextWindow: contextWindowFor(provider.model),
        name: 'Gateway · ' + provider.model,
      });
    }
    for (const m of localModels || []) {
      const base = localBase || 'http://localhost:11434/v1';
      const row = {
        id: orchId({ baseURL: base, model: m.name }),
        oauthProvider: '', transport: '', oauth: false,
        baseURL: base, apiKey: '',
        model: m.name, label: m.name,
        window: '', contextWindow: 0,
        name: 'Ollama · ' + m.name,
      };
      if (!gw.some((g) => g.id === row.id)) gw.push(row);
    }
    if (gw.length) out.push({ key: 'gateway', title: 'Local / API gateway', rows: gw });
    return out;
  }, [cat, provider, localModels, localBase]);

  // Rows saved before ids existed get a derived one, so they key, toggle and
  // re-tier individually (an undefined id used to match — and remove — them all).
  const entries = useMemo(() => (orchestrator.providers || []).map((p, i) => (p && p.id ? p : { ...p, id: (p && (p.model || p.baseURL || p.oauthProvider)) ? orchId(p || {}) : 'legacy|' + i })), [orchestrator.providers]);
  const byId = useMemo(() => new Map(entries.map((p) => [p.id, p])), [entries]);
  const known = new Set();
  for (const g of groups) for (const r of g.rows) known.add(r.id);
  // Entries saved before this panel existed (free-text baseURL rows) must stay
  // visible and removable instead of vanishing behind the new checklist.
  const legacy = entries.filter((p) => !known.has(p.id));

  const toggle = (row, on) => {
    const cur = entries;
    if (on) {
      if (cur.some((p) => p.id === row.id)) return;
      const entry = {
        id: row.id,
        name: row.name,
        baseURL: row.baseURL || '',
        apiKey: row.apiKey || '',
        model: row.model,
        tier: 'heavy',
        oauth: !!row.oauth,
        oauthProvider: row.oauthProvider || '',
        transport: row.transport || '',
        contextWindow: row.contextWindow || 0,
      };
      const ai = orchestrator.activeIndex;
      saveOrch({ ...orchestrator, providers: [...cur, entry], activeIndex: cur.length && ai >= 0 && ai < cur.length ? ai : 0 });
    } else {
      const next = cur.filter((p) => p.id !== row.id);
      // Re-anchor 'start' on the same model: removing a row above it used to
      // shift the index and silently move the start marker to another model.
      const startId = cur[orchestrator.activeIndex] ? cur[orchestrator.activeIndex].id : null;
      let ai = startId ? next.findIndex((p) => p.id === startId) : -1;
      if (ai < 0) ai = next.length ? 0 : -1;
      saveOrch({ ...orchestrator, providers: next, activeIndex: ai });
    }
  };
  const setTier = (id, tier) => saveOrch({ ...orchestrator, providers: entries.map((p) => (p.id === id ? { ...p, tier } : p)) });
  const setActive = (id) => saveOrch({ ...orchestrator, activeIndex: entries.findIndex((p) => p.id === id) });

  const query = q.trim().toLowerCase();
  const match = (r) => !query || String(r.model).toLowerCase().includes(query) || String(r.name).toLowerCase().includes(query);
  const total = groups.reduce((n, g) => n + g.rows.length, 0);
  const picked = entries.length;

  return (
    <div className="orch-pool">
      <div className="orch-pool-head">
        <span className="orch-count">{picked} of {total} selected</span>
        <input className="orch-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter models…" />
        <button type="button" className="btn-mini" disabled={cat.busy} onClick={load}>
          <Icon name="Refresh" size={12} /> {cat.busy ? 'Loading…' : 'Reload'}
        </button>
      </div>
      {cat.error && <p className="muted orch-err">{cat.error}</p>}
      {!cat.busy && total === 0 && (
        <p className="muted">Nothing loadable yet. Sign in to a provider under Accounts, or point the composer at a gateway, then press Reload.</p>
      )}
      {groups.map((g) => {
        const rows = g.rows.filter(match);
        if (!rows.length) return null;
        return (
          <div key={g.key} className="orch-grp">
            <div className="orch-grp-head">{g.title}</div>
            {rows.map((r) => {
              const entry = byId.get(r.id);
              const on = !!entry;
              return (
                <div key={r.id} className={'orch-row' + (on ? ' on' : '')}>
                  <label className="orch-check" title={r.name}>
                    <input type="checkbox" checked={on} onChange={(e) => toggle(r, e.target.checked)} />
                    <span className="orch-name">{r.label}</span>
                    {r.window ? <span className="orch-win">{r.window}</span> : null}
                  </label>
                  {on && (
                    <>
                      <select className="orch-tier" value={entry.tier || 'heavy'} onChange={(e) => setTier(r.id, e.target.value)} title="Complexity tier this model serves">
                        <option value="small">small</option>
                        <option value="heavy">heavy</option>
                        <option value="critical">critical</option>
                      </select>
                      <label className="orch-radio" title="Start here (failover order + supervisor)">
                        <input type="radio" name="orch-active" checked={entries.indexOf(entry) === orchestrator.activeIndex} onChange={() => setActive(r.id)} /> start
                      </label>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        );
      })}
      {legacy.length > 0 && (
        <div className="orch-grp">
          <div className="orch-grp-head">Saved earlier</div>
          {legacy.map((p) => (
            <div key={p.id} className="orch-row on">
              <label className="orch-check" title={p.name || p.model}>
                <input type="checkbox" checked onChange={() => toggle({ id: p.id }, false)} />
                <span className="orch-name">{p.model || p.baseURL}</span>
                <span className="orch-win">{p.baseURL ? normBase(p.baseURL).replace(/^https?:\/\//, '') : p.oauthProvider}</span>
              </label>
              <select className="orch-tier" value={p.tier || 'heavy'} onChange={(e) => setTier(p.id, e.target.value)}>
                <option value="small">small</option>
                <option value="heavy">heavy</option>
                <option value="critical">critical</option>
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------- Role pools (orchestrator.pools) ----------
// One failover list per role, routed through a single OpenAI-compatible gateway.
// Edited as text — one model per line, `model-id @N` caps that model at N
// concurrent calls — and stored as `{ model, max }` objects.
const POOL_ROLES = [
  { id: 'planner', label: 'Planner / Reasoner' },
  { id: 'coder', label: 'Implementer / Coder' },
  { id: 'vision', label: 'Vision' },
  { id: 'fast', label: 'Fast' },
  { id: 'longctx', label: 'Long context' },
];

function parsePoolModels(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^(.*?)\s*@\s*(\d+)\s*$/);
    const model = (m ? m[1] : line).trim();
    if (!model) continue;
    const max = m ? parseInt(m[2], 10) : 0;
    out.push(max > 0 ? { model, max } : { model });
  }
  return out;
}

function serializePoolModels(models) {
  return (Array.isArray(models) ? models : [])
    .map((e) => (typeof e === 'string' ? { model: e } : e || {}))
    .filter((e) => e.model)
    .map((e) => e.model + (Number(e.max) > 0 ? ' @' + Number(e.max) : ''))
    .join('\n');
}

function RolePoolsEditor({ orchestrator, saveOrch }) {
  const pools = (orchestrator && orchestrator.pools) || {};
  const roles = pools.roles || {};
  const gateway = pools.gateway || {};
  // Textareas keep their own text while focused so typing is never reformatted;
  // they commit (parse → save) on blur.
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [health, setHealth] = useState(null);

  useEffect(() => {
    if (!pools.enabled || !window.autobot || !window.autobot.poolStatus) { setHealth(null); return undefined; }
    let alive = true;
    const poll = async () => {
      try {
        const res = await window.autobot.poolStatus();
        if (alive && res) setHealth(res);
      } catch (_) {}
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => { alive = false; clearInterval(id); };
  }, [pools.enabled, orchestrator]);

  const rowByModel = useMemo(() => {
    const m = new Map();
    for (const r of (health && health.rows) || []) {
      if (r && r.model && !m.has(r.model)) m.set(r.model, r);
    }
    return m;
  }, [health]);

  const savePools = (patch) => {
    const next = { enabled: !!pools.enabled, gateway: { baseURL: gateway.baseURL || '', apiKey: gateway.apiKey || '' }, roles: { ...roles }, ...pools, ...patch };
    saveOrch({ ...orchestrator, pools: next });
  };
  const saveRole = (id, patch) => {
    const def = POOL_ROLES.find((r) => r.id === id);
    const cur = roles[id] || { label: def ? def.label : id, models: [] };
    savePools({ roles: { ...roles, [id]: { ...cur, ...patch } } });
  };
  const commitText = (id) => {
    if (drafts[id] === undefined) return;
    const models = parsePoolModels(drafts[id]);
    setDrafts((d) => { const n = { ...d }; delete n[id]; return n; });
    saveRole(id, { models });
  };
  const loadPreset = async () => {
    if (!window.autobot || !window.autobot.poolsPreset) { setNote('Preset unavailable in this build.'); return; }
    setBusy(true);
    setNote('');
    try {
      const preset = await window.autobot.poolsPreset();
      if (!preset || typeof preset !== 'object' || !preset.roles) { setNote('The preset came back empty.'); return; }
      setDrafts({});
      saveOrch({ ...orchestrator, pools: { ...preset, enabled: preset.enabled !== false } });
      setNote('FreeLLMAPI preset loaded.');
    } catch (e) {
      setNote('Could not load the preset: ' + String((e && e.message) || e).slice(0, 160));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pools-ed">
      <div className="pools-top">
        <label className="pools-toggle">
          <input type="checkbox" checked={!!pools.enabled} onChange={(e) => savePools({ enabled: e.target.checked })} />
          <span>Enable role pools</span>
        </label>
        <button type="button" className="btn-mini" disabled={busy} onClick={loadPreset}>
          <Icon name="Download" size={12} /> {busy ? 'Loading…' : 'Load FreeLLMAPI preset'}
        </button>
      </div>
      <p className="muted pools-help">
        Pools apply only when the session provider is this gateway. Each role fails over downward; the swarm
        supervisor uses Planner, workers use Coder, images use Vision, compaction/titles use Fast, oversized
        prompts use Long context.
      </p>
      {note && <p className="muted pools-note">{note}</p>}
      <div className="pools-gw">
        <label className="pools-field pools-grow">
          <span>Gateway base URL</span>
          <input
            key={'gw-url|' + (gateway.baseURL || '')}
            defaultValue={gateway.baseURL || ''}
            placeholder="http://127.0.0.1:3001/v1"
            spellCheck={false}
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (gateway.baseURL || '')) savePools({ gateway: { ...gateway, baseURL: v } }); }}
          />
        </label>
        <label className="pools-field pools-key">
          <span>Key (optional)</span>
          <input
            key={'gw-key|' + (gateway.apiKey ? 'set' : '')}
            type="password"
            defaultValue={gateway.apiKey || ''}
            placeholder="reuse session key"
            onBlur={(e) => { const v = e.target.value.trim(); if (v !== (gateway.apiKey || '')) savePools({ gateway: { ...gateway, apiKey: v } }); }}
          />
        </label>
      </div>
      <div className="pools-roles">
        {POOL_ROLES.map((r) => {
          const role = roles[r.id] || {};
          const text = drafts[r.id] !== undefined ? drafts[r.id] : serializePoolModels(role.models);
          const lines = Math.max(2, Math.min(6, text.split('\n').length));
          return (
            <div key={r.id} className="pools-role">
              <div className="pools-role-head">
                <span className="pools-role-name">{role.label || r.label}</span>
                <span className="pools-role-id">{r.id}</span>
                <label className="pools-field pools-max" title="Max parallel calls for this role">
                  <span>max parallel</span>
                  <input
                    type="number"
                    min="1"
                    max="64"
                    value={role.maxConcurrent != null ? role.maxConcurrent : ''}
                    placeholder="—"
                    onChange={(e) => { const n = parseInt(e.target.value, 10); saveRole(r.id, { maxConcurrent: Number.isFinite(n) && n > 0 ? n : undefined }); }}
                  />
                </label>
              </div>
              <textarea
                className="pools-models"
                rows={lines}
                spellCheck={false}
                value={text}
                placeholder={'model-id @2\nfallback-model'}
                onChange={(e) => { const v = e.target.value; setDrafts((d) => ({ ...d, [r.id]: v })); }}
                onBlur={() => commitText(r.id)}
              />
              {pools.enabled && (role.models || []).length > 0 && (
                <div className="pools-health">
                  {(role.models || []).map((entry, idx) => {
                    const mid = typeof entry === 'string' ? entry.split('@')[0].trim() : entry.model;
                    if (!mid) return null;
                    const st = rowByModel.get(mid);
                    const cls = st && st.dead ? 'dead' : (st && st.coolingMs > 0 ? 'cooling' : 'ok');
                    const meta = st && st.dead ? 'dead'
                      : (st && st.coolingMs > 0 ? `${Math.ceil(st.coolingMs / 1000)}s` : (st && st.inflight > 0 ? `${st.inflight} active` : 'ready'));
                    return (
                      <span key={mid + ':' + idx} className={'pools-chip ' + cls} title={st && st.deadWhy ? st.deadWhy : mid}>
                        <span className="pools-chip-dot" />
                        <span>{mid}</span>
                        <span className="pools-chip-meta">{meta}</span>
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EnvironmentsSection({ envState, refreshEnvState, onSwitchEnvironment, setError, setNotice, cwd }) {
  const [sshDraft, setSshDraft] = useState({ name: '', host: '', port: 22, username: '', identityFile: '', remoteCwd: '', secret: '' });
  const [remDraft, setRemDraft] = useState({ name: '', url: '', token: '', remoteCwd: '' });
  const [busy, setBusy] = useState('');
  const [statusOut, setStatusOut] = useState('');
  const [remoteWsList, setRemoteWsList] = useState([]);
  const [hostTokenShown, setHostTokenShown] = useState('');

  const active = (envState && envState.active) || { kind: 'local', label: 'This Computer' };
  const sshProfiles = (envState && envState.sshProfiles) || [];
  const sshConfigHosts = (envState && envState.sshConfigHosts) || [];
  const remoteProfiles = (envState && envState.remoteProfiles) || [];
  const hostServer = (envState && envState.hostServer) || {};

  const saveSsh = async (e) => {
    e && e.preventDefault();
    if (!sshDraft.host.trim()) return;
    setBusy('save-ssh');
    try {
      const r = await window.autobot.envSaveSsh(sshDraft);
      if (r && r.ok) {
        setSshDraft({ name: '', host: '', port: 22, username: '', identityFile: '', remoteCwd: '', secret: '' });
        setStatusOut(`Saved SSH host "${r.profile.name}". Passphrase/password stored in encrypted keychain.`);
        refreshEnvState && refreshEnvState();
      } else setStatusOut((r && r.error) || 'Failed to save SSH host');
    } finally { setBusy(''); }
  };

  const runTestSsh = async (profOrId) => {
    setBusy('test-ssh');
    setStatusOut('Testing SSH connection…');
    try {
      const r = await window.autobot.envTestSsh(profOrId);
      if (r && r.ok) setStatusOut(`✅ SSH connected in ${r.latencyMs}ms · ${r.uname} · pwd: ${r.remoteCwd}`);
      else setStatusOut(`❌ SSH failed (${r?.latencyMs || 0}ms): ${r?.error || 'unknown error'}`);
    } finally { setBusy(''); }
  };

  const saveRemote = async (e) => {
    e && e.preventDefault();
    if (!remDraft.url.trim()) return;
    setBusy('save-rem');
    try {
      const r = await window.autobot.envSaveRemote(remDraft);
      if (r && r.ok) {
        setRemDraft({ name: '', url: '', token: '', remoteCwd: '' });
        setStatusOut(`Saved Remote Server "${r.profile.name}". Auth token encrypted in secret store.`);
        refreshEnvState && refreshEnvState();
      } else setStatusOut((r && r.error) || 'Failed to save Remote Server');
    } finally { setBusy(''); }
  };

  const runTestRemote = async (profOrId) => {
    setBusy('test-rem');
    setStatusOut('Testing Remote Server connection…');
    try {
      const r = await window.autobot.envTestRemote(profOrId);
      if (r && r.ok) {
        setRemoteWsList(r.workspaces || []);
        setStatusOut(`✅ Remote Server ready in ${r.latencyMs}ms · ${r.hostname} (${r.platform}) · ${r.workspaces?.length || 0} workspace(s)`);
      } else {
        setStatusOut(`❌ Remote Server failed (${r?.latencyMs || 0}ms): ${r?.error || 'unreachable'}`);
      }
    } finally { setBusy(''); }
  };

  const toggleHostSrv = async () => {
    setBusy('host-srv');
    try {
      const r = await window.autobot.envToggleHostServer(!hostServer.running, { workspaceRoot: cwd || undefined });
      if (r && r.token) setHostTokenShown(r.token);
      setStatusOut(r && r.running ? `✅ Remote Server host listening at ${r.url}` : 'Host Remote Server stopped');
      refreshEnvState && refreshEnvState();
    } finally { setBusy(''); }
  };

  return (
    <>
      <div className="settings-card">
        <h3>Active Execution Environment</h3>
        <div className={'env-prof-row' + (active.kind !== 'local' ? ' active' : '')}>
          <div className="env-prof-meta">
            <span className="env-prof-title">{active.label || 'This Computer'}</span>
            <span className="env-prof-sub">Mode: {active.kind} · Workspace: {active.cwd || cwd || '~'} · Secrets: {envState?.secretStatus?.backend || 'safeStorage'}</span>
          </div>
          <div className="env-prof-actions">
            {active.kind !== 'local' && (
              <button type="button" className="btn-mini primary" onClick={() => onSwitchEnvironment({ kind: 'local' })}>
                Switch to This Computer
              </button>
            )}
          </div>
        </div>
        {statusOut && <p className="muted" style={{ marginTop: 10 }}>{statusOut}</p>}
      </div>

      <div className="settings-card">
        <h3>SSH Hosts</h3>
        <form onSubmit={saveSsh}>
          <div className="row">
            <label>Display name<input value={sshDraft.name} onChange={(e) => setSshDraft({ ...sshDraft, name: e.target.value })} placeholder="prod-gpu" /></label>
            <label>Hostname / IP<input value={sshDraft.host} onChange={(e) => setSshDraft({ ...sshDraft, host: e.target.value })} placeholder="192.168.1.50" /></label>
          </div>
          <div className="row">
            <label>Username<input value={sshDraft.username} onChange={(e) => setSshDraft({ ...sshDraft, username: e.target.value })} placeholder="ubuntu" /></label>
            <label>Port<input type="number" value={sshDraft.port} onChange={(e) => setSshDraft({ ...sshDraft, port: Number(e.target.value) || 22 })} /></label>
          </div>
          <div className="row">
            <label>Identity key path (optional)<input value={sshDraft.identityFile} onChange={(e) => setSshDraft({ ...sshDraft, identityFile: e.target.value })} placeholder="~/.ssh/id_ed25519" /></label>
            <label>Remote workspace path<input value={sshDraft.remoteCwd} onChange={(e) => setSshDraft({ ...sshDraft, remoteCwd: e.target.value })} placeholder="/home/ubuntu/app" /></label>
          </div>
          <label>Password / key passphrase (stored encrypted in OS keychain)
            <input type="password" value={sshDraft.secret} onChange={(e) => setSshDraft({ ...sshDraft, secret: e.target.value })} placeholder="Optional when using SSH key or agent" />
          </label>
          <div className="row-actions" style={{ marginTop: 6 }}>
            <button type="submit" className="btn-mini primary" disabled={!sshDraft.host.trim() || busy === 'save-ssh'}>Save SSH Host</button>
            <button type="button" className="btn-mini" disabled={!sshDraft.host.trim() || busy === 'test-ssh'} onClick={() => runTestSsh(sshDraft)}>Test Connection</button>
          </div>
        </form>

        {(sshProfiles.length > 0 || sshConfigHosts.length > 0) && (
          <div className="env-prof-list">
            {[...sshProfiles, ...sshConfigHosts].map((p) => {
              const isAct = active.kind === 'ssh' && active.id === p.id;
              return (
                <div key={p.id} className={'env-prof-row' + (isAct ? ' active' : '')}>
                  <div className="env-prof-meta">
                    <span className="env-prof-title">{p.name} {p.source === 'ssh-config' ? '(~/.ssh/config)' : ''}</span>
                    <span className="env-prof-sub">{p.username ? `${p.username}@` : ''}{p.host}:{p.port} {p.remoteCwd ? `· ${p.remoteCwd}` : ''}</span>
                  </div>
                  <div className="env-prof-actions">
                    <button type="button" className="btn-mini" onClick={() => runTestSsh(p.id)}>Test</button>
                    <button
                      type="button"
                      className={'btn-mini ' + (isAct ? '' : 'primary')}
                      onClick={() => onSwitchEnvironment(isAct ? { kind: 'local' } : { kind: 'ssh', id: p.id, cwd: p.remoteCwd || '' })}
                    >
                      {isAct ? 'Disconnect' : 'Connect'}
                    </button>
                    {p.source !== 'ssh-config' && (
                      <button type="button" className="btn-mini" onClick={async () => { await window.autobot.envDeleteSsh(p.id); refreshEnvState && refreshEnvState(); }}>Delete</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Remote Servers</h3>
        <form onSubmit={saveRemote}>
          <div className="row">
            <label>Server name<input value={remDraft.name} onChange={(e) => setRemDraft({ ...remDraft, name: e.target.value })} placeholder="Akron Cloud Runner" /></label>
            <label>Server URL<input value={remDraft.url} onChange={(e) => setRemDraft({ ...remDraft, url: e.target.value })} placeholder="http://127.0.0.1:9477" /></label>
          </div>
          <div className="row">
            <label>Auth Bearer token (stored encrypted)<input type="password" value={remDraft.token} onChange={(e) => setRemDraft({ ...remDraft, token: e.target.value })} placeholder="Bearer token" /></label>
            <label>Remote workspace path<input value={remDraft.remoteCwd} onChange={(e) => setRemDraft({ ...remDraft, remoteCwd: e.target.value })} placeholder="/workspace/project" /></label>
          </div>
          <div className="row-actions" style={{ marginTop: 6 }}>
            <button type="submit" className="btn-mini primary" disabled={!remDraft.url.trim() || busy === 'save-rem'}>Save Remote Server</button>
            <button type="button" className="btn-mini" disabled={!remDraft.url.trim() || busy === 'test-rem'} onClick={() => runTestRemote(remDraft)}>Test Connection</button>
          </div>
        </form>

        {remoteWsList.length > 0 && (
          <div className="row" style={{ marginTop: 10 }}>
            <label>Discovered remote workspaces
              <select value={remDraft.remoteCwd} onChange={(e) => setRemDraft({ ...remDraft, remoteCwd: e.target.value })}>
                <option value="">Select workspace…</option>
                {remoteWsList.map((w) => <option key={w.path} value={w.path}>{w.name} ({w.path})</option>)}
              </select>
            </label>
          </div>
        )}

        {remoteProfiles.length > 0 && (
          <div className="env-prof-list">
            {remoteProfiles.map((r) => {
              const isAct = active.kind === 'remote' && active.id === r.id;
              return (
                <div key={r.id} className={'env-prof-row' + (isAct ? ' active' : '')}>
                  <div className="env-prof-meta">
                    <span className="env-prof-title">{r.name}</span>
                    <span className="env-prof-sub">{r.url} {r.remoteCwd ? `· ${r.remoteCwd}` : ''}</span>
                  </div>
                  <div className="env-prof-actions">
                    <button type="button" className="btn-mini" onClick={() => runTestRemote(r.id)}>Test</button>
                    <button
                      type="button"
                      className={'btn-mini ' + (isAct ? '' : 'primary')}
                      onClick={() => onSwitchEnvironment(isAct ? { kind: 'local' } : { kind: 'remote', id: r.id, cwd: r.remoteCwd || '' })}
                    >
                      {isAct ? 'Disconnect' : 'Connect'}
                    </button>
                    <button type="button" className="btn-mini" onClick={async () => { await window.autobot.envDeleteRemote(r.id); refreshEnvState && refreshEnvState(); }}>Delete</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="settings-card">
        <h3>Host Akron Remote Server on This Machine</h3>
        <p className="muted">Expose this computer&apos;s workspace over an encrypted-token HTTP/WebSocket endpoint on port {hostServer.port || 9477}.</p>
        <div className="row-actions">
          <button type="button" className={'btn-mini ' + (hostServer.running ? '' : 'primary')} onClick={toggleHostSrv}>
            {hostServer.running ? 'Stop Remote Host' : 'Start Remote Host'}
          </button>
          {hostServer.running && (
            <button
              type="button"
              className="btn-mini"
              onClick={async () => {
                const tok = hostTokenShown || (await window.autobot.envGetHostToken());
                if (tok) { navigator.clipboard?.writeText(tok).catch(() => {}); setNotice && setNotice('Remote host token copied'); }
              }}
            >
              Copy Auth Token
            </button>
          )}
        </div>
      </div>
    </>
  );
}

const SETTINGS_SECTIONS = [
  { id: 'providers', group: 'ai', label: 'Models & Providers', icon: 'Sparkles', sub: 'Primary endpoints, presets, local Ollama, and subscription sign-in.', keys: 'model provider ollama api key preset subscription oauth temperature token' },
  { id: 'orchestrator', group: 'ai', label: 'Orchestrator & Pools', icon: 'Orbit', sub: 'DeepSeek Harness profiles, multi-model failover tiers, and role pools.', keys: 'orchestrator pool planner coder vision fast longctx failover swarm profile harness' },
  { id: 'notifications', group: 'ai', label: 'Notifications', icon: 'Notification', sub: 'Choose when to receive desktop notifications and hear synthesized sounds.', keys: 'notifications sound chime staplebops alert agent permissions questions errors' },
  { id: 'environments', group: 'workspace', label: 'Environments', icon: 'Globe', sub: 'Execute locally, over SSH Hosts, or on an authenticated Remote Server.', keys: 'environment ssh host remote server cloud secret keychain' },
  { id: 'worktrees', group: 'workspace', label: 'Worktrees', icon: 'GitBranch', sub: 'Create and switch isolated git worktree checkouts for parallel branches.', keys: 'git worktree branch checkout parallel workspace' },
  { id: 'skills', group: 'workspace', label: 'Skills & Plugins', icon: 'Lightbulb', sub: 'Manage SKILL.md packs, agent capabilities, and plugins.', keys: 'skills plugins packs extensions' },
  { id: 'mcp', group: 'workspace', label: 'MCP Connectors', icon: 'Connectors', sub: 'Connect external Model Context Protocol servers & tools.', keys: 'mcp connectors servers tools' },
  { id: 'memory', group: 'workspace', label: 'Memory & Notebooks', icon: 'Memory', sub: 'Long-term saved facts and interactive notebooks.', keys: 'memory facts notebooks cells' },
  { id: 'harness', group: 'workspace', label: 'Harness & Custom Tools', icon: 'AgentsSimple', sub: 'Creator Mode runtime tools, developer features, and agent capabilities.', keys: 'creator custom tool harness developer extension buddy remote control' },
  { id: 'rea', group: 'ext', label: 'Reverse Engineering', icon: 'Orbit', sub: 'Built-in REA (morluto/rea) MCP & CLI, 263 tools, doctor & runtime.', keys: 'rea reverse engineer binary ghidra hopper ida rizin asar apk firmware mcp decompile' },
  { id: 'browser', group: 'ext', label: 'Browser Extension', icon: 'Globe', sub: 'Zero-key Chrome extension bridge for live browser control & shared desktop models.', keys: 'chrome extension akron browser bot bridge websocket tabs 8766' },
  { id: 'server', group: 'ext', label: 'Server & Pairing', icon: 'Plug', sub: 'Local HTTP/WebSocket host endpoint, bridge health, and device info.', keys: 'server pairing port 8766 endpoint websocket health' },
  { id: 'voice', group: 'ext', label: 'Voice & Dictation', icon: 'Microphone', sub: 'Built-in offline ONNX Whisper speech model & fast gateway transcription.', keys: 'voice dictation whisper microphone speech audio language' },
  { id: 'shortcuts', group: 'system', label: 'Shortcuts', icon: 'Keyboard', sub: 'Keyboard shortcuts for fast navigation and editing.', keys: 'shortcuts hotkeys keybindings keyboard cmd ctrl' },
  { id: 'runtimes', group: 'system', label: 'Runtimes & Updates', icon: 'Refresh', sub: 'Built-in IDE dependencies, optional LSP installers, bundled CLIs & app auto-updater.', keys: 'runtimes updates auto-update github release lsp dependencies repair' },
  { id: 'security', group: 'system', label: 'Permissions & Security', icon: 'LockShield', sub: 'Tool consent rules, Computer Use, Chrome CDP, bridges, and compliance.', keys: 'permission security computer use chrome cdp bridge compliance trusted folders' },
  { id: 'system', group: 'system', label: 'Appearance & System', icon: 'Palette', sub: 'Theme, language locale, memory injection, launch behavior, and runtimes.', keys: 'theme dark light locale language memory login quick entry runtime' },
  { id: 'about', group: 'system', label: 'About & License', icon: 'Info', sub: 'Akron Code details, AkronLogic brand identity, runtime diagnostics, license & trademarks.', keys: 'about akronlogic logo version license trademarks copyright legal brand seal info' },
];

function SettingsModal({
  provider, setProvider, providerKeys, setProviderKeys, settings, setSettings, orchestrator, setOrchestrator,
  features, setFeatures, testProvider, onClose, T, permissions, setPermissions, compliance, setCompliance,
  pendingPreset, clearPendingPreset, initialSection = 'providers',
  skills = [], toggleSkill, setAllSkills, refreshSkills,
  mcpServers = [], mcpForm, setMcpForm, connectMcp, disconnectMcp,
  memory = [], addMemory, clearMemory,
  notebooks = [], activeNotebook, notebookCells = [], setNotebookCells, openNotebook, newNotebook, saveActiveNotebook, deleteActiveNotebook,
  cwd, setCwd, activeId,
  onOpenGdrive, gdriveState,
  envState, refreshEnvState, onSwitchEnvironment, setError, setNotice,
}) {
  const [section, setSection] = useState(initialSection || 'providers');
  const [navFilter, setNavFilter] = useState('');
  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);

  // Editing an endpoint/model by hand means this is no longer a signed-in
  // subscription selection — drop the OAuth binding so the gateway path wins.
  const set = (k) => (e) => setProvider({ ...provider, [k]: e.target.value, ...(k === 'baseURL' || k === 'apiKey' ? { oauthProvider: '', transport: '', accessToken: '', oauth: false } : {}) });
  // Persist every key against its own endpoint so switching models never reuses
  // (or loses) another provider's credential.
  const keyForEntry = (baseURL) => (providerKeys || {})[normBase(baseURL)] || PRESET_KEYS[normBase(baseURL)] || '';
  const setKeyForEntry = (baseURL, value) => {
    const base = normBase(baseURL);
    if (!base) return;
    setProviderKeys((m) => ({ ...(m || {}), [base]: value }));
  };

  const saveOrch = (next) => { setOrchestrator(next); window.autobot.setOrchestrator(next); };
  const saveFeat = (next) => { setFeatures(next); window.autobot.setFeatures(next); };

  // Staged preset from the model picker (no key yet). Nothing is committed to
  // the session provider until "Save key & use" — Cancel leaves it untouched.
  const [stage, setStage] = useState(() => (pendingPreset ? { baseURL: pendingPreset.baseURL || '', model: pendingPreset.model || '', apiKey: keyForEntry(pendingPreset.baseURL) } : null));
  useEffect(() => {
    setStage(pendingPreset ? { baseURL: pendingPreset.baseURL || '', model: pendingPreset.model || '', apiKey: keyForEntry(pendingPreset.baseURL) } : null);
    if (pendingPreset) setSection('providers');
  }, [pendingPreset]); // eslint-disable-line react-hooks/exhaustive-deps
  const stageNeedsKey = !!(stage && !LOCAL_BASE.test(normBase(stage.baseURL)));
  const stageReady = !!(stage && normBase(stage.baseURL) && stage.model && (!stageNeedsKey || String(stage.apiKey || '').trim()));
  const commitStage = () => {
    if (!stageReady) return;
    const p = pendingPreset || {};
    const key = String(stage.apiKey || '').trim();
    setKeyForEntry(stage.baseURL, key);
    setProvider((v) => ({ ...v, baseURL: stage.baseURL, model: stage.model, apiKey: key, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto', oauthProvider: '', transport: '', accessToken: '', oauth: false }));
    if (clearPendingPreset) clearPendingPreset();
  };

  // Local Ollama
  const [ollama, setOllama] = useState({ ok: false, base: '', models: [], detail: '' });
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const applyOllamaModel = (name) => {
    const base = ollama.base || 'http://localhost:11434/v1';
    setProvider((v) => ({ ...v, baseURL: base, model: name, apiKey: '', supportsTools: true, oauthProvider: '', transport: '', accessToken: '', oauth: false }));
    setKeyForEntry(base, '');
  };
  const connectOllama = async (start) => {
    setOllamaBusy(true);
    try {
      const r = start
        ? await Promise.resolve(window.autobot.ollamaServe('start')).catch(() => null)
        : await Promise.resolve(window.autobot.ollamaModels(ollama.base || 'http://localhost:11434/v1')).catch(() => null);
      if (r) setOllama({ ok: !!r.ok, base: r.base || '', models: r.models || [], detail: r.detail || '' });
      const first = r && r.ok && r.models && r.models[0];
      if (first) {
        const base = r.base || 'http://localhost:11434/v1';
        setProvider((v) => ({ ...v, baseURL: base, model: first.name, apiKey: '', supportsTools: true }));
        setKeyForEntry(base, '');
      }
      return r;
    } finally {
      setOllamaBusy(false);
    }
  };
  useEffect(() => {
    window.autobot.ollamaModels('http://localhost:11434/v1')
      .then((r) => r && setOllama({ ok: !!r.ok, base: r.base || '', models: r.models || [], detail: r.detail || '' }))
      .catch(() => {});
  }, []);

  // Custom runtime tools (Creator Mode)
  const [customTools, setCustomTools] = useState([]);
  const [ctDraft, setCtDraft] = useState({ name: '', description: '', runtime: 'node', script: 'const args = JSON.parse(process.env.TOOL_ARGS_JSON || "{}");\nconsole.log("ok", args);' });
  const [ctMsg, setCtMsg] = useState('');
  const refreshCustomTools = useCallback(async () => {
    if (!window.autobot || !window.autobot.customToolList) return;
    try {
      const list = await window.autobot.customToolList();
      setCustomTools(Array.isArray(list) ? list : []);
    } catch (_) {}
  }, []);
  useEffect(() => { refreshCustomTools(); }, [refreshCustomTools]);

  // Built-in REA (morluto/rea) status & diagnostics
  const [reaInfo, setReaInfo] = useState(null);
  const [reaDiagOut, setReaDiagOut] = useState('');
  const [reaBusy, setReaBusy] = useState(false);
  const refreshReaStatus = useCallback(async () => {
    if (!window.autobot || !window.autobot.reaStatus) return;
    try {
      const res = await window.autobot.reaStatus();
      if (res) setReaInfo(res);
    } catch (_) {}
  }, []);
  useEffect(() => {
    refreshReaStatus();
  }, [refreshReaStatus]);

  // Browser extension bridge status
  const [extStatus, setExtStatus] = useState(null);
  const refreshExtStatus = useCallback(async () => {
    if (!window.autobot || !window.autobot.extBridgeStatus) return;
    try {
      const res = await window.autobot.extBridgeStatus();
      if (res) setExtStatus(res);
    } catch (_) {}
  }, []);
  useEffect(() => {
    refreshExtStatus();
    if (section !== 'browser') return undefined;
    const id = setInterval(refreshExtStatus, 3000);
    return () => clearInterval(id);
  }, [section, refreshExtStatus]);

  // Voice tester inside Voice settings tab
  const [voiceTestOut, setVoiceTestOut] = useState('');
  const [voiceTestErr, setVoiceTestErr] = useState('');
  const testVoice = useVoiceDictation({
    engine: settings.voiceEngine || 'auto',
    lang: settings.voiceLang || 'en-US',
    onTranscript: (t) => setVoiceTestOut(t),
    onError: (e) => setVoiceTestErr(e),
  });

  // Worktrees & local Server info
  const [wtInfo, setWtInfo] = useState({ isRepo: false, root: null, worktrees: [] });
  const [wtBranch, setWtBranch] = useState('');
  const [wtBusy, setWtBusy] = useState(false);
  const [wtMsg, setWtMsg] = useState('');
  const refreshWorktrees = useCallback(async () => {
    if (!window.autobot || !window.autobot.worktreeList) return;
    try {
      const r = await window.autobot.worktreeList(cwd || undefined);
      if (r) setWtInfo(r);
    } catch (_) {}
  }, [cwd]);
  useEffect(() => {
    if (section === 'worktrees') refreshWorktrees();
  }, [section, refreshWorktrees]);

  const [serverMeta, setServerMeta] = useState(null);
  const refreshServerMeta = useCallback(async () => {
    if (!window.autobot || !window.autobot.serverInfo) return;
    try {
      const r = await window.autobot.serverInfo();
      if (r) setServerMeta(r);
    } catch (_) {}
  }, []);
  useEffect(() => {
    if (section === 'server') refreshServerMeta();
  }, [section, refreshServerMeta]);

  const notifCfg = { agent: true, permissions: true, questions: true, errors: false, notifyWhenFocused: false, sound: false, ...(settings.notifications || {}) };
  const soundCfg = { agent: 'staplebops-01', permissions: 'staplebops-02', questions: 'staplebops-05', errors: 'none', ...(settings.sounds || {}) };
  const toggleNotif = (k) => setSettings({ ...settings, notifications: { ...notifCfg, [k]: !notifCfg[k] } });
  const setSoundPreset = (k, val) => {
    setSettings({ ...settings, sounds: { ...soundCfg, [k]: val } });
    if (val && val !== 'none') playUiSound(val);
  };

  const q = navFilter.trim().toLowerCase();
  const visibleSections = q
    ? SETTINGS_SECTIONS.filter((s) => s.label.toLowerCase().includes(q) || s.keys.includes(q) || s.sub.toLowerCase().includes(q))
    : SETTINGS_SECTIONS;
  const activeMeta = SETTINGS_SECTIONS.find((s) => s.id === section) || SETTINGS_SECTIONS[0];

  const badgeFor = (id) => {
    if (id === 'providers') return provider.model ? '' : 'Setup';
    if (id === 'notifications') return notifCfg.agent ? 'On' : 'Off';
    if (id === 'orchestrator') return (orchestrator.pools && orchestrator.pools.enabled) ? 'Pools' : (orchestrator.enabled ? 'On' : '');
    if (id === 'environments') return envState && envState.active && envState.active.kind !== 'local' ? envState.active.kind.toUpperCase() : 'Local';
    if (id === 'worktrees') return wtInfo.worktrees && wtInfo.worktrees.length ? `${wtInfo.worktrees.length}` : '';
    if (id === 'skills') { const n = skills.filter((s) => s.enabled !== false).length; return n > 0 ? `${n}` : ''; }
    if (id === 'mcp') return mcpServers.length > 0 ? `${mcpServers.length}` : '';
    if (id === 'memory') return memory.length > 0 ? `${memory.length}` : '';
    if (id === 'harness') return customTools.length ? `${customTools.length}` : '';
    if (id === 'rea') return reaInfo && reaInfo.connected ? `${reaInfo.toolCount}` : (reaInfo && reaInfo.available ? 'Ready' : '');
    if (id === 'browser') return extStatus && extStatus.extensionConnected ? 'Live' : '8766';
    if (id === 'server') return '8766';
    if (id === 'voice') return settings.voiceEngine === 'local' ? 'Whisper' : 'Auto';
    if (id === 'security') return permissions;
    if (id === 'system') return settings.theme || 'dark';
    if (id === 'about') return 'v1.0';
    return '';
  };

  return (
    <div className="modal-overlay settings-fullscreen" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <aside className="settings-sidebar" aria-label="Settings categories">
          <button type="button" className="settings-back-btn" onClick={onClose}>
            <Icon name="ArrowLeft" size={14} />
            <span>Back to app</span>
          </button>
          <div className="settings-filter">
            <Icon name="Search" size={13} />
            <input
              value={navFilter}
              onChange={(e) => setNavFilter(e.target.value)}
              placeholder="Search settings…"
            />
          </div>
          <nav className="settings-nav">
            {visibleSections.map((s, idx) => {
              const badge = badgeFor(s.id);
              const showSep = !q && idx > 0 && visibleSections[idx - 1].group !== s.group;
              return (
                <React.Fragment key={s.id}>
                  {showSep && <div className="settings-nav-sep" role="separator" />}
                  <button
                    type="button"
                    className={'settings-nav-btn' + (section === s.id ? ' on' : '')}
                    onClick={() => setSection(s.id)}
                  >
                    <Icon name={s.icon} size={15} />
                    <span>{s.label}</span>
                    {badge && <span className="settings-nav-pill">{badge}</span>}
                  </button>
                </React.Fragment>
              );
            })}
          </nav>
          <button
            type="button"
            className="settings-side-foot"
            onClick={() => setSection('about')}
            title="Open About & License"
          >
            <span>Akron Code v1.1</span>
            <span>{settings.theme === 'light' ? 'Light' : 'Dark'}</span>
          </button>
        </aside>

        <section className="settings-main">
          <header className="settings-head">
            <div className="settings-head-inner">
              <div>
                <h2>{activeMeta.label}</h2>
                <p className="settings-head-sub">{activeMeta.sub}</p>
              </div>
              <button type="button" className="icon-btn" onClick={onClose} title="Close settings">
                <Icon name="X" size={16} />
              </button>
            </div>
          </header>

          <div className="settings-body">
            <div className="settings-body-inner">
            {section === 'providers' && (
              <>
                {stage && (
                  <div className="stage-key">
                    <div className="stage-key-head">
                      <Icon name="Lock" size={13} /> Set up <b>{(pendingPreset && pendingPreset.name) || 'provider'}</b>
                      <span className="muted"> — your current model stays active until you save.</span>
                    </div>
                    <div className="row">
                      <label>Base URL<input value={stage.baseURL} onChange={(e) => setStage({ ...stage, baseURL: e.target.value })} placeholder="https://api.example.com/v1" /></label>
                      <label>Model<input value={stage.model} onChange={(e) => setStage({ ...stage, model: e.target.value })} placeholder="model-id" /></label>
                    </div>
                    <label>API key{stageNeedsKey ? '' : ' (optional for a local endpoint)'}
                      <input type="password" autoFocus value={stage.apiKey} onChange={(e) => setStage({ ...stage, apiKey: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') commitStage(); }} placeholder="sk-…" />
                    </label>
                    <div className="stage-key-actions">
                      <button type="button" className="btn-mini" onClick={() => { if (clearPendingPreset) clearPendingPreset(); }}>Cancel</button>
                      <button type="button" className="btn-mini primary" disabled={!stageReady} onClick={commitStage}>Save key &amp; use</button>
                    </div>
                  </div>
                )}

                <div className="settings-card">
                  <h3>{T('settings.provider')}</h3>
                  <div className="presets">
                    {PRESETS.map((p) => (
                      <button key={p.name} className={provider.baseURL === p.baseURL && provider.model === p.model ? 'on' : ''} onClick={() => { const k = p.apiKey || keyForEntry(p.baseURL); setProvider((v) => ({ ...v, baseURL: p.baseURL, model: p.model, apiKey: k, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto', oauthProvider: '', transport: '', accessToken: '', oauth: false })); if (k) setKeyForEntry(p.baseURL, k); }}>{p.name}</button>
                    ))}
                  </div>
                  <div className="ollama-box">
                    <div className="ollama-head">
                      <span><Icon name="Plug" size={13} /> Ollama (local)</span>
                      <span className="ollama-actions">
                        <button type="button" className="btn-mini" disabled={ollamaBusy} onClick={() => connectOllama(false)}>
                          <Icon name="Refresh" size={12} /> Scan
                        </button>
                        <button type="button" className="btn-mini primary" disabled={ollamaBusy} onClick={() => connectOllama(true)}>
                          {ollamaBusy ? 'Connecting…' : (ollama.ok ? 'Start / reconnect' : 'Connect')}
                        </button>
                      </span>
                    </div>
                    <div className="ollama-detail">
                      {ollama.ok
                        ? (ollama.detail || (ollama.models.length + ' models installed'))
                        : (ollama.detail && ollama.detail !== 'Unreachable' ? ollama.detail : 'Not running — press Connect to launch ollama serve')}
                    </div>
                    {ollama.ok && ollama.models.length > 0 && (
                      <div className="ollama-models">
                        {ollama.models.map((m) => (
                          <button type="button" key={m.name} className={'ollama-model' + (provider.model === m.name ? ' on' : '')} title={m.family ? m.family : m.name} onClick={() => applyOllamaModel(m.name)}>
                            {m.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <label>Base URL<input value={provider.baseURL} onChange={set('baseURL')} placeholder="http://localhost:11434/v1" /></label>
                  <label>API Key (optional)<input value={provider.apiKey} onChange={(e) => { const v = e.target.value; setProvider({ ...provider, apiKey: v }); setKeyForEntry(provider.baseURL, v); }} placeholder="sk-…" /></label>
                  <label>Model<input value={provider.model} onChange={set('model')} placeholder="llama3.1" /></label>
                  <div className="row">
                    <label>Temperature<input type="number" step="0.1" value={provider.temperature} onChange={set('temperature')} /></label>
                    <label>Max tokens<input type="number" value={provider.maxTokens} onChange={set('maxTokens')} /></label>
                  </div>
                  <label>Reasoning / thinking level
                    <select value={provider.reasoningLevel || 'auto'} onChange={(e) => setProvider({ ...provider, reasoningLevel: e.target.value })}>
                      <option value="auto">Auto (provider default)</option>
                      <option value="low">Low — fast, minimal thinking</option>
                      <option value="medium">Medium — balanced</option>
                      <option value="high">High — deep, thorough reasoning</option>
                    </select>
                  </label>
                  <p className="muted" style={{ marginTop: -6 }}>Sent to OpenAI-compatible APIs as <code>reasoning_effort</code>; providers that reject it auto-retry without it.</p>
                  <label className="check"><input type="checkbox" checked={provider.supportsTools} onChange={(e) => setProvider({ ...provider, supportsTools: e.target.checked })} /> Function calling / tools</label>
                </div>

                <div className="settings-card">
                  <AccountSection T={T} provider={provider} setProvider={setProvider} />
                </div>
              </>
            )}

            {section === 'notifications' && (
              <>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8 }}>
                    <h3 className="oc-sec-title" style={{ margin: 0 }}>Desktop notifications</h3>
                    <button
                      type="button"
                      className="btn-mini"
                      data-testid="test-desktop-notification-btn"
                      onClick={() => {
                        sendDesktopNotification(
                          'agent',
                          'Akron Code',
                          'Desktop notifications and the Akron Code logo are working across OS targets.',
                          settings,
                          { force: true, convId: activeId || null }
                        );
                        setNotice && setNotice('Sent test desktop notification');
                      }}
                    >
                      <Icon name="Notification" size={12} /> Test Notification
                    </button>
                  </div>
                  <div className="oc-group">
                    {[
                      { k: 'agent', title: 'Agent', sub: 'Show system notification when the agent is complete or needs attention' },
                      { k: 'permissions', title: 'Permissions', sub: 'Show system notification when a permission is required' },
                      { k: 'questions', title: 'Questions', sub: 'Show system notification when the agent asks a question' },
                      { k: 'errors', title: 'Errors', sub: 'Show system notification when an error occurs' },
                      { k: 'notifyWhenFocused', title: 'Notify when focused', sub: 'Also deliver OS notifications even when Akron Code is the active window' },
                      { k: 'sound', title: 'OS notification sound', sub: 'Play native OS alert chime alongside desktop banners' },
                    ].map((row) => (
                      <div key={row.k} className="oc-row">
                        <div className="oc-row-meta">
                          <div className="oc-row-title">{row.title}</div>
                          <div className="oc-row-sub">{row.sub}</div>
                        </div>
                        <div className="oc-row-ctrl">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={!!notifCfg[row.k]}
                            className={'oc-switch' + (notifCfg[row.k] ? ' on' : '')}
                            onClick={() => toggleNotif(row.k)}
                          >
                            <span className="oc-switch-knob" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div>
                  <h3 className="oc-sec-title">Sound effects</h3>
                  <div className="oc-group">
                    {[
                      { k: 'agent', title: 'Agent', sub: 'Play sound when the agent is complete or needs attention' },
                      { k: 'permissions', title: 'Permissions', sub: 'Play sound when a permission is required' },
                      { k: 'questions', title: 'Questions', sub: 'Play sound when the agent asks a question' },
                      { k: 'errors', title: 'Errors', sub: 'Play sound when an error occurs' },
                    ].map((row) => (
                      <div key={row.k} className="oc-row">
                        <div className="oc-row-meta">
                          <div className="oc-row-title">{row.title}</div>
                          <div className="oc-row-sub">{row.sub}</div>
                        </div>
                        <div className="oc-row-ctrl">
                          <select className="oc-select" value={soundCfg[row.k] || 'none'} onChange={(e) => setSoundPreset(row.k, e.target.value)}>
                            {SOUND_PRESETS.map((sp) => <option key={sp.id} value={sp.id}>{sp.label}</option>)}
                          </select>
                          <button type="button" className="btn-mini" title="Preview sound" onClick={() => playUiSound(soundCfg[row.k] || 'staplebops-01')}>
                            <Icon name="Play" size={11} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {section === 'orchestrator' && (
              <>
                <div>
                  <h3 className="oc-sec-title">DeepSeek Harness Runtime Profile</h3>
                  <div className="oc-group">
                    <div className="oc-row">
                      <div className="oc-row-meta">
                        <div className="oc-row-title">Active harness profile</div>
                        <div className="oc-row-sub">Controls system instruction focus, cache-prefix discipline, and agent aggressiveness.</div>
                      </div>
                      <div className="oc-row-ctrl">
                        <select className="oc-select" value={settings.harnessProfile || 'full'} onChange={(e) => setSettings({ ...settings, harnessProfile: e.target.value })}>
                          {HARNESS_PROFILES.map((hp) => <option key={hp.id} value={hp.id}>{hp.name}</option>)}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-card">
                  <h3><Icon name="Settings" size={14} /> {T('settings.orchestrator')}</h3>
                  <label className="check"><input type="checkbox" checked={!!orchestrator.enabled} onChange={(e) => saveOrch({ ...orchestrator, enabled: e.target.checked })} /> Enable — multi-model pool for failover AND swarm tier routing</label>
                  {orchestrator.enabled && (
                    <>
                      <p className="muted" style={{ marginTop: -4 }}>
                        Tick the models this pool may use — the list is everything this machine has loaded
                        (signed-in subscription accounts and the local/API gateway). <b>Tier</b> decides which
                        model a supervisor-assigned subtask runs on: <b>small</b> = cheap/mechanical work,
                        <b> heavy</b> = real implementation, <b>critical</b> = architecture/security/review
                        (also the supervisor's own model). <b>start</b> marks the first model failover tries.
                      </p>
                      <OrchModelChecklist
                        orchestrator={orchestrator}
                        provider={provider}
                        localModels={ollama.ok ? ollama.models : []}
                        localBase={ollama.base}
                        saveOrch={saveOrch}
                      />
                    </>
                  )}
                </div>

                <div className="settings-card">
                  <h3><Icon name="Users" size={14} /> Role pools</h3>
                  <RolePoolsEditor orchestrator={orchestrator} saveOrch={saveOrch} />
                </div>
              </>
            )}

            {section === 'harness' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Wrench" size={14} /> Creator Mode · Custom Runtime Tools</h3>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Hot-swappable tools authored by you or the agent (<code>CreateCustomTool</code>). Saved under <code>~/.autobot/custom-tools/</code> and runnable immediately on Node, Bash/PowerShell, or Python.
                  </p>
                  <div className="row">
                    <label>Tool identifier<input value={ctDraft.name} onChange={(e) => setCtDraft({ ...ctDraft, name: e.target.value })} placeholder="repo_health_check" /></label>
                    <label>Runtime
                      <select value={ctDraft.runtime} onChange={(e) => setCtDraft({ ...ctDraft, runtime: e.target.value })}>
                        <option value="node">Node.js</option>
                        <option value="bash">Shell (zsh / PowerShell)</option>
                        <option value="python3">Python 3</option>
                      </select>
                    </label>
                  </div>
                  <label>Description<input value={ctDraft.description} onChange={(e) => setCtDraft({ ...ctDraft, description: e.target.value })} placeholder="Check git & lint status in one command" /></label>
                  <label>Script (receives JSON args in <code>process.env.TOOL_ARGS_JSON</code> &amp; stdin)
                    <textarea rows={4} style={{ width: '100%', marginTop: 5, fontFamily: 'var(--mono)', fontSize: 12, padding: 8, background: 'var(--bg-000)', color: 'var(--text-000)', border: '1px solid var(--border-strong)', borderRadius: 8 }} value={ctDraft.script} onChange={(e) => setCtDraft({ ...ctDraft, script: e.target.value })} />
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      type="button"
                      className="btn-mini primary"
                      onClick={async () => {
                        setCtMsg('');
                        try {
                          await window.autobot.customToolSave(ctDraft);
                          setCtMsg(`Saved tool "${ctDraft.name}".`);
                          setCtDraft({ name: '', description: '', runtime: 'node', script: 'const args = JSON.parse(process.env.TOOL_ARGS_JSON || "{}");\nconsole.log("ok", args);' });
                          refreshCustomTools();
                        } catch (e) { setCtMsg('Error: ' + String(e?.message || e)); }
                      }}
                    >
                      Save custom tool
                    </button>
                    {ctMsg && <span className="muted" style={{ margin: 0 }}>{ctMsg}</span>}
                  </div>
                  {customTools.length > 0 && (
                    <div className="ct-list">
                      {customTools.map((ct) => (
                        <div key={ct.name} className="ct-row">
                          <div>
                            <b>{ct.name}</b> <span className="muted">({ct.runtime})</span>
                            <div className="muted" style={{ margin: 0 }}>{ct.description}</div>
                          </div>
                          <button type="button" className="btn-mini" onClick={async () => { await window.autobot.customToolDelete(ct.name); refreshCustomTools(); }}>Delete</button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="settings-card">
                  <h3><Icon name="Code" size={14} /> Developer &amp; Agent Capabilities</h3>
                  <label className="check"><input type="checkbox" checked={!!features.extensions} onChange={(e) => saveFeat({ ...features, extensions: e.target.checked })} /> Extensions (custom tools / MCP servers)</label>
                  <label className="check"><input type="checkbox" checked={!!features.developerMode} onChange={(e) => saveFeat({ ...features, developerMode: e.target.checked })} /> Developer mode (debug tools + local exec consent)</label>
                  <label className="check"><input type="checkbox" checked={!!features.buddy} onChange={(e) => saveFeat({ ...features, buddy: e.target.checked })} /> Buddy (pair-hunting co-pilot)</label>
                  <label className="check"><input type="checkbox" checked={!!features.remoteControl} onChange={(e) => saveFeat({ ...features, remoteControl: e.target.checked })} /> Remote Control (Drive / co-browsing session)</label>
                </div>
              </>
            )}

            {section === 'rea' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Orbit" size={14} /> Built-In REA Engine (<code>morluto/rea</code>)</h3>
                  <div className="ext-card-status">
                    <div>
                      <span className={'ext-dot' + (reaInfo && reaInfo.connected ? ' on' : '')} />
                      <b>
                        {reaInfo && reaInfo.connected
                          ? `Connected (${reaInfo.toolCount} MCP tools active${reaInfo.version ? ' · v' + reaInfo.version : ''})`
                          : (reaInfo && reaInfo.available ? `Ready (${reaInfo.mode}${reaInfo.version ? ' · v' + reaInfo.version : ''})` : 'Node 22+ or rea-agents not found')}
                      </b>
                      <p className="muted" style={{ margin: '4px 0 0' }}>
                        Built-in reverse engineering across native binaries (Hopper / Ghidra / IDA / Rizin), Electron/ASAR/JS, Android APKs, Apple bundles, firmware, PCAP/HAR captures, and AgentEnv via <code>rea</code>, <code>find_mcp_tools</code>, and bundled skill <code>reverse-engineer-anything</code>.
                      </p>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn-mini primary"
                      disabled={reaBusy}
                      onClick={async () => {
                        if (!window.autobot || !window.autobot.reaConnect) return;
                        setReaBusy(true); setReaDiagOut('');
                        try {
                          const r = await window.autobot.reaConnect();
                          if (r && r.status) setReaInfo(r.status); else refreshReaStatus();
                          setReaDiagOut(r && r.ok ? `Connected ${r.toolCount} REA tools.` : `Connect error: ${(r && r.error) || 'unknown'}`);
                        } finally { setReaBusy(false); }
                      }}
                    >
                      <Icon name={reaBusy ? 'Spinner' : 'Refresh'} size={12} className={reaBusy ? 'spin' : ''} /> Connect / Reconnect MCP
                    </button>
                    <button
                      type="button"
                      className="btn-mini"
                      disabled={reaBusy}
                      onClick={async () => {
                        if (!window.autobot || !window.autobot.reaDoctor) return;
                        setReaBusy(true); setReaDiagOut('');
                        try {
                          const r = await window.autobot.reaDoctor();
                          if (r && r.status) setReaInfo(r.status);
                          setReaDiagOut((r && r.output) || (r && r.error) || 'Doctor finished.');
                        } finally { setReaBusy(false); }
                      }}
                    >
                      Run REA Doctor
                    </button>
                    <button
                      type="button"
                      className="btn-mini"
                      disabled={reaBusy}
                      onClick={async () => {
                        if (!window.autobot || !window.autobot.reaInstall) return;
                        setReaBusy(true); setReaDiagOut('Installing/updating rea-agents...');
                        try {
                          const r = await window.autobot.reaInstall();
                          if (r && r.status) setReaInfo(r.status);
                          setReaDiagOut((r && r.output) || (r && r.error) || 'Done.');
                        } finally { setReaBusy(false); }
                      }}
                    >
                      Install / Update REA
                    </button>
                  </div>
                  {reaInfo && (
                    <div className="ct-list" style={{ marginTop: 12 }}>
                      <div className="ct-row"><span>Node runtime</span><code>{reaInfo.nodeVersion ? `${reaInfo.nodeVersion} (${reaInfo.nodePath})` : 'Not detected'}</code></div>
                      <div className="ct-row"><span>REA package</span><code>{reaInfo.reaPath || 'Unavailable'}</code></div>
                      <div className="ct-row"><span>Bundled skill</span><code>{reaInfo.skillBundled ? 'reverse-engineer-anything (active)' : 'Missing'}</code></div>
                    </div>
                  )}
                  {reaDiagOut && (
                    <pre className="tool-result" style={{ marginTop: 12, maxHeight: 220, overflow: 'auto' }}>{reaDiagOut}</pre>
                  )}
                </div>
              </>
            )}

            {section === 'browser' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Globe" size={14} /> Akron Browser Bot · External Browser Bridge</h3>
                  <div className="ext-card-status">
                    <div>
                      <span className={'ext-dot' + (extStatus && extStatus.extensionConnected ? ' on' : '')} />
                      <b>{extStatus && extStatus.extensionConnected ? `Connected (v${extStatus.extensionVersion || '1.6.7'})` : 'Listening for extension on ws://127.0.0.1:8766'}</b>
                      <p className="muted" style={{ margin: '4px 0 0' }}>
                        All models configured in Akron Code Desktop are automatically shared with Akron Browser Bot at <code>http://127.0.0.1:8766/v1</code> — zero separate API keys required.
                      </p>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button type="button" className="btn-mini" onClick={refreshExtStatus}><Icon name="Refresh" size={12} /> Refresh</button>
                      <button type="button" className="btn-mini primary" onClick={() => window.autobot.extBridgeOpenFolder && window.autobot.extBridgeOpenFolder()}>
                        <Icon name="Folder" size={12} /> Open Extension Folder
                      </button>
                    </div>
                  </div>
                </div>

                <div className="settings-card">
                  <h3>Setup in Chrome / Brave / Edge (1 minute)</h3>
                  <ol className="muted" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.65 }}>
                    <li>Click <b>Open Extension Folder</b> above (points to <code>{(extStatus && extStatus.extensionDir) || 'resources/akron-browser-bot'}</code>).</li>
                    <li>Open <code>chrome://extensions</code>, enable <b>Developer mode</b>, click <b>Load unpacked</b>, and select that folder.</li>
                    <li>Open the Akron Browser Bot side panel — it connects automatically with access to <code>akron-default</code>, <code>akron-planner</code>, <code>akron-coder</code>, <code>akron-vision</code>, <code>akron-fast</code>, and <code>akron-longctx</code>, and Desktop agents can drive tabs via <code>ext_browser</code>.</li>
                  </ol>
                  {extStatus && Array.isArray(extStatus.tabs) && extStatus.tabs.length > 0 && (
                    <div className="ct-list" style={{ marginTop: 12 }}>
                      {extStatus.tabs.slice(0, 6).map((t) => (
                        <div key={t.id} className="ct-row">
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.active ? '● ' : ''}{t.title || t.url}</span>
                          <span className="muted" style={{ margin: 0 }}>tab #{t.id}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}

            {section === 'voice' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Microphone" size={14} /> Built-In Voice Model &amp; Dictation</h3>
                  <p className="muted" style={{ marginTop: 0 }}>
                    Speak directly into the composer or Code Review comments using the built-in ONNX Whisper speech model (offline) or fast gateway Whisper transcription when available.
                  </p>
                  <div className="row">
                    <label>Voice recognition engine
                      <select value={settings.voiceEngine || 'auto'} onChange={(e) => setSettings({ ...settings, voiceEngine: e.target.value })}>
                        <option value="auto">Auto (Gateway Whisper → Built-in Offline Whisper)</option>
                        <option value="local">Built-in Whisper (Offline ONNX)</option>
                        <option value="gateway">Gateway Whisper only</option>
                      </select>
                    </label>
                    <label>Dictation language
                      <select value={settings.voiceLang || 'en-US'} onChange={(e) => setSettings({ ...settings, voiceLang: e.target.value })}>
                        <option value="en-US">English (US)</option>
                        <option value="en-GB">English (UK)</option>
                        <option value="pl-PL">Polish</option>
                        <option value="de-DE">German</option>
                        <option value="es-ES">Spanish</option>
                        <option value="fr-FR">French</option>
                        <option value="ja-JP">Japanese</option>
                        <option value="zh-CN">Chinese</option>
                      </select>
                    </label>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6 }}>
                    <button type="button" className={'btn-mini ' + (testVoice.state !== 'idle' ? 'primary' : '')} onClick={testVoice.toggle}>
                      <Icon name={testVoice.state === 'transcribing' ? 'Spinner' : 'Microphone'} size={13} className={testVoice.state === 'transcribing' ? 'spin' : ''} />
                      {testVoice.state === 'recording' ? ` Stop recording (${testVoice.seconds}s)` : (testVoice.state === 'transcribing' ? ' Transcribing…' : ' Test Microphone')}
                    </button>
                    {testVoice.statusNote && <span className="muted" style={{ margin: 0 }}>{testVoice.statusNote}</span>}
                    {voiceTestErr && <span style={{ color: '#f87171', fontSize: 12 }}>{voiceTestErr}</span>}
                  </div>
                  {voiceTestOut && (
                    <div className="ct-row" style={{ marginTop: 10 }}>
                      <span>Heard: <b>{voiceTestOut}</b></span>
                    </div>
                  )}
                </div>
              </>
            )}

            {section === 'environments' && (
              <EnvironmentsSection
                envState={envState}
                refreshEnvState={refreshEnvState}
                onSwitchEnvironment={onSwitchEnvironment}
                setError={setError}
                setNotice={setNotice}
                cwd={cwd}
              />
            )}

            {section === 'security' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="LockShield" size={14} /> Permissions &amp; Automation</h3>
                  <div className="row">
                    <label>{T('code.permissions')}
                      <select value={permissions} onChange={(e) => setPermissions(e.target.value)}>
                        <option value="auto">{T('code.permissions.auto')}</option>
                        <option value="ask">{T('code.permissions.ask')}</option>
                        <option value="acceptEdits">{T('code.permissions.acceptEdits')}</option>
                        <option value="plan">{T('code.permissions.plan')}</option>
                        <option value="bypass">{T('perm.bypass')}</option>
                      </select>
                    </label>
                  </div>
                  <p className="muted">{T('code.permissions.hint')}</p>
                  <label className="check"><input type="checkbox" checked={!!features.trustedFolders} onChange={(e) => saveFeat({ ...features, trustedFolders: e.target.checked })} /> Trusted folders (pre-approve shell exec in these dirs)</label>
                  <label className="check"><input type="checkbox" checked={!!features.computerUse} onChange={(e) => saveFeat({ ...features, computerUse: e.target.checked })} /> Computer Use (screen + mouse/keyboard via OS automation)</label>
                  <label className="check"><input type="checkbox" checked={!!features.computerUseTeach} onChange={(e) => saveFeat({ ...features, computerUseTeach: e.target.checked })} /> Computer Use — teach &amp; watch/record</label>
                  <label className="check"><input type="checkbox" checked={!!features.chrome} onChange={(e) => saveFeat({ ...features, chrome: e.target.checked })} /> Chrome control (CDP)</label>
                  {features.chrome && (
                    <div className="row">
                      <label>Chrome host<input value={features.chromeHost} onChange={(e) => saveFeat({ ...features, chromeHost: e.target.value })} /></label>
                      <label>Chrome port<input type="number" value={features.chromePort} onChange={(e) => saveFeat({ ...features, chromePort: Number(e.target.value) })} /></label>
                    </div>
                  )}
                  <label className="check"><input type="checkbox" checked={!!features.bridges} onChange={(e) => saveFeat({ ...features, bridges: e.target.checked })} /> Bot bridges (webhook server for hearthbot/slackbot/teamsbot/webagent)</label>
                </div>

                <div className="settings-card">
                  <PermissionRulesSection cwd={cwd} setNotice={setNotice} />
                </div>

                <div className="settings-card">
                  <ComplianceSection compliance={compliance} setCompliance={setCompliance} />
                </div>
              </>
            )}

            {section === 'skills' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Lightbulb" size={14} /> Skills</h3>
                  <SkillsView skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills} />
                </div>
                <div className="settings-card">
                  <h3><Icon name="Plugin" size={14} /> Plugins &amp; Connectors</h3>
                  <PluginsView onOpenGdrive={onOpenGdrive} gdriveState={gdriveState} />
                </div>
              </>
            )}

            {section === 'mcp' && (
              <div className="settings-card">
                <McpView mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp} />
              </div>
            )}

            {section === 'memory' && (
              <>
                <div className="settings-card">
                  <h3><Icon name="Memory" size={14} /> Long-Term Memory</h3>
                  <MemoryView memory={memory} addMemory={addMemory} clearMemory={clearMemory} />
                </div>
                <div className="settings-card">
                  <h3><Icon name="Book" size={14} /> Notebooks</h3>
                  <NotebooksView notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells} openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook} />
                </div>
              </>
            )}

            {section === 'worktrees' && (
              <>
                <div>
                  <h3 className="oc-sec-title">Create isolated git worktree</h3>
                  <div className="settings-card">
                    <p className="muted" style={{ marginTop: 0 }}>
                      Check out another branch in a parallel directory without disturbing your active workspace. Switch any session into a worktree in one click.
                    </p>
                    <div className="row">
                      <label>New or existing branch
                        <input value={wtBranch} onChange={(e) => setWtBranch(e.target.value)} placeholder="feat/native-win32-perf" />
                      </label>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <button
                        type="button"
                        className="btn-mini primary"
                        disabled={wtBusy || !wtBranch.trim()}
                        onClick={async () => {
                          if (!window.autobot || !window.autobot.worktreeAdd) return;
                          setWtBusy(true); setWtMsg('');
                          try {
                            const r = await window.autobot.worktreeAdd(cwd || undefined, wtBranch.trim());
                            if (r && r.ok) {
                              setWtInfo(r);
                              setWtBranch('');
                              setWtMsg(`✅ Created worktree at ${r.path}`);
                            } else {
                              setWtMsg(`❌ ${(r && r.error) || 'Failed to create worktree'}`);
                            }
                          } finally { setWtBusy(false); }
                        }}
                      >
                        <Icon name="GitBranch" size={12} /> Create worktree
                      </button>
                      <button type="button" className="btn-mini" onClick={refreshWorktrees}><Icon name="Refresh" size={12} /> Refresh</button>
                      {wtMsg && <span className="muted" style={{ margin: 0 }}>{wtMsg}</span>}
                    </div>
                  </div>
                </div>

                <div>
                  <h3 className="oc-sec-title">Repository worktrees {wtInfo.root ? `(${wtInfo.worktrees.length})` : ''}</h3>
                  <div className="oc-group">
                    {!wtInfo.isRepo ? (
                      <div className="oc-row"><div className="oc-row-meta"><div className="oc-row-title">Open a git repository workspace to inspect worktrees</div><div className="oc-row-sub">Current workspace: {cwd || '~'}</div></div></div>
                    ) : wtInfo.worktrees.map((w) => (
                      <div key={w.path} className="oc-row">
                        <div className="oc-row-meta">
                          <div className="oc-row-title">{w.branch || '(detached)'} {w.main ? '· main' : ''}</div>
                          <div className="oc-row-sub">{w.path} {w.head ? `· ${w.head}` : ''}</div>
                        </div>
                        <div className="oc-row-ctrl">
                          <button type="button" className="btn-mini" onClick={() => { if (setCwd) { setCwd(w.path); setWtMsg(`✅ Workspace switched to ${w.path}`); } }}>
                            {cwd === w.path ? 'Active' : 'Use'}
                          </button>
                          {!w.main && (
                            <button
                              type="button"
                              className="btn-mini"
                              onClick={async () => {
                                if (!window.autobot || !window.autobot.worktreeRemove) return;
                                const r = await window.autobot.worktreeRemove(cwd || undefined, w.path);
                                if (r && r.ok) setWtInfo(r);
                                else setWtMsg(`❌ ${(r && r.error) || 'Failed to remove worktree'}`);
                              }}
                            >Remove</button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}

            {section === 'server' && (
              <div>
                <h3 className="oc-sec-title">Local Host &amp; Bridge Endpoints</h3>
                <div className="oc-group">
                  <div className="oc-row">
                    <div className="oc-row-meta">
                      <div className="oc-row-title">Local Gateway API (Zero-Key Extension Bridge)</div>
                      <div className="oc-row-sub"><code>{(serverMeta && serverMeta.url) || 'http://127.0.0.1:8766'}</code> · {serverMeta && serverMeta.extensionConnected ? 'Akron Browser Bot connected' : 'Ready for connections'}</div>
                    </div>
                    <div className="oc-row-ctrl">
                      <button type="button" className="btn-mini" onClick={() => { navigator.clipboard?.writeText((serverMeta && serverMeta.url) || 'http://127.0.0.1:8766'); setError('✅ Copied server URL'); }}>Copy URL</button>
                      <button type="button" className="btn-mini" onClick={refreshServerMeta}><Icon name="Refresh" size={12} /></button>
                    </div>
                  </div>
                  <div className="oc-row">
                    <div className="oc-row-meta">
                      <div className="oc-row-title">WebSocket Control Channel</div>
                      <div className="oc-row-sub"><code>{(serverMeta && serverMeta.wsUrl) || 'ws://127.0.0.1:8766'}</code> · {serverMeta ? `${serverMeta.connectedClients || 0} client(s)` : 'Listening'}</div>
                    </div>
                  </div>
                  <div className="oc-row">
                    <div className="oc-row-meta">
                      <div className="oc-row-title">Host Runtime</div>
                      <div className="oc-row-sub">{serverMeta ? `${serverMeta.platform} / ${serverMeta.arch} · PID ${serverMeta.pid}` : 'Akron Code Desktop Host'}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {section === 'shortcuts' && (() => {
              const sc = shortcutLabels();
              return (
                <div>
                  <h3 className="oc-sec-title">Keyboard Shortcuts</h3>
                  <div className="oc-group">
                    {[
                      ['New conversation tab', sc.newTab],
                      ['Quick Open / Command Center', sc.quickOpen],
                      ['Inline AI Edit', sc.inlineEdit],
                      ['Project Search & Replace', sc.globalSearch],
                      ['Go to Symbol in Editor', sc.goToSymbol],
                      ['Toggle Terminal / Problems', sc.toggleTerminal],
                      ['Toggle Sidebar / Agent Dock', sc.toggleAgent],
                      ['Find in Chat / Terminal', sc.find],
                      ['Open Settings', sc.settings],
                      ['Slash actions & skills menu', '/'],
                      ['File & agent @mentions', '@'],
                      ['Quick Entry global launcher', sc.quickEntry],
                    ].map(([title, kbd]) => (
                      <div key={title} className="oc-row">
                        <div className="oc-row-meta"><div className="oc-row-title">{title}</div></div>
                        <div className="oc-row-ctrl"><span className="oc-kbd">{kbd}</span></div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })()}

            {section === 'runtimes' && (
              <>
                <DependenciesAndUpdaterSection setNotice={setNotice} />
                <div className="settings-card">
                  <RuntimesSection />
                </div>
              </>
            )}

            {section === 'system' && (
              <>
                <div className="settings-card">
                  <h3>{T('settings.behavior')}</h3>
                  <div className="row">
                    <label>{T('settings.theme')}
                      <select value={settings.theme} onChange={(e) => setSettings({ ...settings, theme: e.target.value })}>
                        <option value="dark">{T('settings.theme.dark')}</option>
                        <option value="light">{T('settings.theme.light')}</option>
                      </select>
                    </label>
                    <label>{T('settings.locale')}
                      <select value={settings.locale || 'en'} onChange={(e) => setSettings({ ...settings, locale: e.target.value })}>
                        {LOCALES.map((l) => <option key={l.code} value={l.code}>{l.label}</option>)}
                      </select>
                    </label>
                  </div>
                  <label className="check"><input type="checkbox" checked={settings.useMemory} onChange={(e) => setSettings({ ...settings, useMemory: e.target.checked })} /> Inject long-term memory into prompts</label>
                  <label className="check"><input type="checkbox" checked={!!settings.launchAtLogin} onChange={(e) => setSettings({ ...settings, launchAtLogin: e.target.checked })} /> Launch Akron Code at login</label>
                  <label className="check"><input type="checkbox" checked={!!features.quickEntry} onChange={(e) => saveFeat({ ...features, quickEntry: e.target.checked })} /> Quick Entry (global hotkey CmdOrCtrl+Shift+Space)</label>
                </div>

                <div className="settings-card">
                  <TypographySettingsSection
                    typography={settings.typography}
                    onChange={(nextTypo) => setSettings({ ...settings, typography: nextTypo })}
                    setNotice={setNotice}
                  />
                </div>

                <div className="settings-card">
                  <RuntimesSection />
                </div>
              </>
            )}

            {section === 'about' && (
              <AboutSection theme={settings.theme || 'dark'} setNotice={setNotice} />
            )}
            </div>
          </div>

          <footer className="settings-foot">
            <div className="settings-foot-inner">
              <span className="muted" style={{ margin: 0 }}>{provider.model ? `Active model: ${provider.model}` : 'Configure a provider to begin'}</span>
              <div className="modal-actions">
                <button onClick={testProvider}>Test connection</button>
                <button className="primary" onClick={onClose}>{T('settings.done')}</button>
              </div>
            </div>
          </footer>
        </section>
      </div>
    </div>
  );
}

// QuestionModal extracted to src/features/AppModals.jsx

function PermissionRulesSection({ cwd, setNotice }) {
  const [perms, setPerms] = useState({ allow: [], deny: [], ask: [], customRules: [] });
  const [ruleInput, setRuleInput] = useState('');
  const [ruleList, setRuleList] = useState('allow');
  const [customLabel, setCustomLabel] = useState('');
  const [customPattern, setCustomPattern] = useState('');
  const [customMode, setCustomMode] = useState('ask');
  const [ledgerStatus, setLedgerStatus] = useState(null);
  const [ledgerEntries, setLedgerEntries] = useState([]);
  const [busy, setBusy] = useState(false);

  const loadRules = useCallback(async () => {
    try {
      if (window.autobot && window.autobot.getPermissions) {
        const res = await window.autobot.getPermissions(cwd);
        if (res) setPerms({ allow: res.allow || [], deny: res.deny || [], ask: res.ask || [], customRules: res.customRules || [] });
      }
      if (window.autobot && window.autobot.listAuditLedger) {
        const entries = await window.autobot.listAuditLedger(12);
        if (Array.isArray(entries)) setLedgerEntries(entries);
      }
    } catch (_) {}
  }, [cwd]);

  useEffect(() => { loadRules(); }, [loadRules]);

  const handleAdd = async () => {
    const clean = ruleInput.trim();
    if (!clean || !window.autobot?.addPermissionRule) return;
    setBusy(true);
    try {
      const res = await window.autobot.addPermissionRule({ rule: clean, list: ruleList });
      if (res && res.ok) {
        setRuleInput('');
        await loadRules();
        setNotice && setNotice(`Saved permission rule: ${clean}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async (rule, list) => {
    if (!window.autobot?.removePermissionRule) return;
    setBusy(true);
    try {
      await window.autobot.removePermissionRule({ rule, list });
      await loadRules();
    } finally {
      setBusy(false);
    }
  };

  const handleSaveCustom = async () => {
    if (!customPattern.trim() || !window.autobot?.saveCustomRule) return;
    setBusy(true);
    try {
      const r = await window.autobot.saveCustomRule({ label: customLabel.trim() || customPattern.trim(), pattern: customPattern.trim(), mode: customMode });
      if (r && r.ok) {
        setCustomLabel('');
        setCustomPattern('');
        await loadRules();
        setNotice && setNotice(`Saved custom rule: ${r.rule.label}`);
      }
    } finally { setBusy(false); }
  };

  const handleInstallStarter = async () => {
    if (!window.autobot?.installStarterRules) return;
    setBusy(true);
    try {
      const r = await window.autobot.installStarterRules();
      if (r && r.ok) {
        await loadRules();
        setNotice && setNotice(`Installed ${r.installed} Safe Starter Pack rules`);
      }
    } finally { setBusy(false); }
  };

  const handleVerifyLedger = async () => {
    if (!window.autobot?.verifyAuditLedger) return;
    const res = await window.autobot.verifyAuditLedger();
    setLedgerStatus(res);
  };

  const CUSTOM_MODE_LABELS = {
    auto: 'Take action without asking',
    explicit: 'Take action when you say so',
    ask: 'Ask before taking action',
    handoff: 'Hand off to you',
  };

  const groups = [
    { key: 'allow', label: 'Always Allow', rules: perms.allow || [], badge: 'allow' },
    { key: 'ask', label: 'Always Ask', rules: perms.ask || [], badge: 'ask' },
    { key: 'deny', label: 'Always Deny', rules: perms.deny || [], badge: 'deny' },
  ];

  return (
    <div className="perm-rules-card">
      <div className="perm-rules-head">
        <div>
          <h3><Icon name="LockShield" size={14} /> Custom Rules &amp; Guardrails</h3>
          <p className="muted">4-tier autonomous action policy + Safe Starter Pack + scoped rules in <code>~/.autobot/settings.json</code>.</p>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn-mini primary" onClick={handleInstallStarter} disabled={busy} data-testid="install-starter-pack-btn">
            Install Safe Starter Pack
          </button>
          <button type="button" className="btn-subtle" onClick={loadRules} disabled={busy}>Refresh</button>
        </div>
      </div>

      <div className="perm-rules-add-row" style={{ marginBottom: 10 }}>
        <input
          type="text"
          value={customLabel}
          onChange={(e) => setCustomLabel(e.target.value)}
          placeholder="Rule label (e.g. Deploy script)"
          aria-label="Custom rule label"
        />
        <input
          type="text"
          value={customPattern}
          onChange={(e) => setCustomPattern(e.target.value)}
          placeholder="Tool/Pattern (e.g. Bash(git push:*) or POST)"
          aria-label="Custom rule pattern"
        />
        <select value={customMode} onChange={(e) => setCustomMode(e.target.value)} aria-label="Custom rule mode">
          <option value="auto">Take action without asking</option>
          <option value="explicit">Take action when you say so</option>
          <option value="ask">Ask before taking action</option>
          <option value="handoff">Hand off to you</option>
        </select>
        <button type="button" className="primary" onClick={handleSaveCustom} disabled={busy || !customPattern.trim()}>
          Save Policy
        </button>
      </div>

      {(perms.customRules || []).length > 0 && (
        <div className="perm-rules-list" style={{ marginBottom: 12 }}>
          {(perms.customRules || []).map((cr) => (
            <div key={cr.id || cr.pattern} className={`perm-rule-chip kind-${cr.mode === 'handoff' ? 'deny' : cr.mode === 'auto' ? 'allow' : 'ask'}`}>
              <span><b>{cr.label || cr.pattern}</b> · <code>{cr.pattern}</code> · {CUSTOM_MODE_LABELS[cr.mode] || cr.mode}</span>
              <button
                type="button"
                className="perm-rule-del"
                onClick={() => window.autobot?.deleteCustomRule && window.autobot.deleteCustomRule({ id: cr.id, pattern: cr.pattern }).then(loadRules)}
                title="Remove custom rule"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="perm-rules-add-row">
        <select value={ruleList} onChange={(e) => setRuleList(e.target.value)} aria-label="Rule list">
          <option value="allow">Allow</option>
          <option value="ask">Ask</option>
          <option value="deny">Deny</option>
        </select>
        <input
          type="text"
          value={ruleInput}
          onChange={(e) => setRuleInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
          placeholder="e.g. Bash(lsof:*) or Edit(src/**) or mcp__rea__inspect_analysis_view"
          aria-label="New permission rule"
        />
        <button type="button" className="primary" onClick={handleAdd} disabled={busy || !ruleInput.trim()}>
          Add Rule
        </button>
      </div>

      <div className="perm-rules-groups">
        {groups.map((g) => (
          <div key={g.key} className="perm-rules-group">
            <div className="perm-rules-group-label">{g.label} <span>({g.rules.length})</span></div>
            {g.rules.length === 0 ? (
              <div className="perm-rules-empty">No {g.key} rules configured.</div>
            ) : (
              <div className="perm-rules-list">
                {g.rules.map((r) => (
                  <div key={`${g.key}:${r}`} className={`perm-rule-chip kind-${g.badge}`}>
                    <code>{r}</code>
                    <button
                      type="button"
                      className="perm-rule-del"
                      onClick={() => handleRemove(r, g.key)}
                      title={`Remove ${r}`}
                      aria-label={`Remove rule ${r}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid rgba(128,128,128,0.18)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
          <div>
            <strong>Hash-Chained Audit Ledger</strong>
            <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}><code>~/.autobot/audit-ledger.jsonl</code></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {ledgerStatus && (
              <span className={`pill ${ledgerStatus.ok ? 'ok' : 'bad'}`} data-testid="audit-ledger-status">
                {ledgerStatus.ok ? `Verified (${ledgerStatus.entries} entries)` : `Integrity Fail (#${ledgerStatus.brokenAt})`}
              </span>
            )}
            <button type="button" className="btn-mini" onClick={handleVerifyLedger} data-testid="verify-audit-ledger-btn">
              Verify Audit Ledger
            </button>
          </div>
        </div>
        {ledgerEntries.length > 0 && (
          <div style={{ fontSize: 11, fontFamily: 'var(--mono-font, monospace)', opacity: 0.8, maxHeight: 96, overflowY: 'auto' }}>
            {ledgerEntries.slice(0, 5).map((e) => (
              <div key={e.seq}>#{e.seq} {e.ts} [{e.event?.type || 'event'}] {e.event?.tool || ''} → {String(e.hash || '').slice(0, 14)}…</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function TypographySettingsSection({ typography, onChange, setNotice }) {
  const cfg = normalizeTypography(typography);
  const patch = (next) => onChange(normalizeTypography({ ...cfg, ...next }));
  const resetDefaults = () => {
    onChange({ ...DEFAULT_TYPOGRAPHY });
    setNotice && setNotice('Typography reset to defaults');
  };
  const uiStack = resolveUiFontStack(cfg);
  const monoStack = resolveMonoFontStack(cfg);

  return (
    <div className="typo-card" data-testid="typography-settings-card">
      <div className="typo-head">
        <div>
          <h3><Icon name="Palette" size={14} /> Typography &amp; Fonts</h3>
          <p className="muted">Applies live across chat messages, code blocks, Monaco editor, and integrated terminals.</p>
        </div>
        <button type="button" className="btn-subtle" onClick={resetDefaults}>Reset Defaults</button>
      </div>

      <div className="typo-grid">
        <div className="typo-col">
          <div className="typo-col-title">UI &amp; Chat Prose</div>
          <label>
            Font Family
            <select
              value={cfg.uiPreset}
              onChange={(e) => patch({ uiPreset: e.target.value })}
              aria-label="UI font family"
            >
              {UI_FONT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          {cfg.uiPreset === 'custom' && (
            <label>
              Custom UI Font Name
              <input
                type="text"
                value={cfg.uiCustomFont}
                onChange={(e) => patch({ uiCustomFont: e.target.value })}
                placeholder="e.g. Plus Jakarta Sans, Helvetica Neue"
              />
            </label>
          )}
          <label>
            UI &amp; Chat Size ({cfg.uiSize}px)
            <div className="typo-size-row">
              <input
                type="range"
                min={12}
                max={20}
                step={0.5}
                value={cfg.uiSize}
                onChange={(e) => patch({ uiSize: Number(e.target.value) })}
                aria-label="UI font size slider"
              />
              <input
                type="number"
                min={12}
                max={20}
                step={0.5}
                value={cfg.uiSize}
                onChange={(e) => patch({ uiSize: Number(e.target.value) })}
                aria-label="UI font size"
                className="typo-size-num"
              />
            </div>
          </label>
        </div>

        <div className="typo-col">
          <div className="typo-col-title">Code, Editor &amp; Terminal</div>
          <label>
            Monospace Family
            <select
              value={cfg.monoPreset}
              onChange={(e) => patch({ monoPreset: e.target.value })}
              aria-label="Code font family"
            >
              {MONO_FONT_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          {cfg.monoPreset === 'custom' && (
            <label>
              Custom Monospace Font Name
              <input
                type="text"
                value={cfg.monoCustomFont}
                onChange={(e) => patch({ monoCustomFont: e.target.value })}
                placeholder="e.g. Berkeley Mono, Victor Mono"
              />
            </label>
          )}
          <label>
            Code &amp; Editor Size ({cfg.monoSize}px)
            <div className="typo-size-row">
              <input
                type="range"
                min={11}
                max={20}
                step={0.5}
                value={cfg.monoSize}
                onChange={(e) => patch({ monoSize: Number(e.target.value) })}
                aria-label="Code font size slider"
              />
              <input
                type="number"
                min={11}
                max={20}
                step={0.5}
                value={cfg.monoSize}
                onChange={(e) => patch({ monoSize: Number(e.target.value) })}
                aria-label="Code font size"
                className="typo-size-num"
              />
            </div>
          </label>
          <label className="check" style={{ marginTop: 6 }}>
            <input
              type="checkbox"
              checked={!!cfg.ligatures}
              onChange={(e) => patch({ ligatures: e.target.checked })}
            />
            Enable code font ligatures (<code>!= === =&gt; -&gt;</code>)
          </label>
        </div>
      </div>

      <div className="typo-preview-box">
        <div className="typo-preview-label">Live Preview</div>
        <div className="typo-preview-prose" style={{ fontFamily: uiStack, fontSize: `${cfg.uiSize}px` }}>
          Akron Code updates prose and code metrics immediately — crisp, readable, zero flash on reload.
        </div>
        <pre
          className="typo-preview-code"
          style={{
            fontFamily: monoStack,
            fontSize: `${cfg.monoSize}px`,
            fontVariantLigatures: cfg.ligatures ? 'normal' : 'none',
            fontFeatureSettings: cfg.ligatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
          }}
        >{`const check = (x) => x !== null && x >= 1 ? 'ready' : 'idle';`}</pre>
      </div>
    </div>
  );
}

// ComputerUseModal, CommandPalette, FindBar, GoogleDriveModal extracted to src/features/AppModals.jsx
