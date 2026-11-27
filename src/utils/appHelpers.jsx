import React, { useState, useEffect, useRef, useMemo } from 'react';
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';
import { stripToolProtocol } from '../textproto.mjs';
import { normBase, LOCAL_BASE } from '../providerstatus-ui.mjs';
import { Icon } from '../components/Icon.jsx';
import { parseFileToken, linkifyBareDomains } from './linkAndFileHelpers.js';

// Every banner in the account/picker surface is dismissible. The dismissed
// value is the banner's own text, so hiding "Imported 2 accounts" can never
// also hide the next, different message — a new failure always speaks up.
// `storeError` stays honest: dismissal is per surface and per mounted
// component, so it never clears the underlying error, only this rendering of it.
export function ProvNotice({ text, warn, className }) {
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
export const SOUND_PRESETS = [
  { id: 'staplebops-01', label: 'Staplebops 01', notes: [523.25, 659.25], dur: 0.08, type: 'sine' },
  { id: 'staplebops-02', label: 'Staplebops 02', notes: [587.33, 440.0], dur: 0.09, type: 'triangle' },
  { id: 'staplebops-05', label: 'Staplebops 05', notes: [493.88, 659.25, 783.99], dur: 0.075, type: 'sine' },
  { id: 'aurora-01', label: 'Aurora Chime', notes: [659.25, 880.0, 1046.5], dur: 0.09, type: 'sine' },
  { id: 'soft-pulse', label: 'Soft Pulse', notes: [392.0, 523.25], dur: 0.07, type: 'triangle' },
  { id: 'none', label: 'None (Muted)', notes: [], dur: 0, type: 'sine' },
];

export function playUiSound(presetId) {
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

export function sendDesktopNotification(kind, title, body, settings, opts = {}) {
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
export const HARNESS_PROFILES = [
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
export function ChatNoticeBar({ text, onDismiss }) {
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
export function parseCodeInfo(infostring) {
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

export const mdRenderer = {
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
  codespan(text) {
    const raw = typeof text === 'string' ? text : (text && text.text ? String(text.text) : '');
    const decoded = raw.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const parsed = parseFileToken(decoded);
    if (parsed) {
      return `<code class="md-file-chip" data-akron-file="${escapeHtml(parsed.path)}" data-akron-line="${parsed.line || ''}" title="Click to open ${escapeHtml(parsed.path)} (Alt+Click for IDE)" role="button" tabindex="0">${raw}</code>`;
    }
    return `<code>${raw}</code>`;
  },
};
marked.use({ renderer: mdRenderer, gfm: true, breaks: true });

export function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A failed provider call can hand us a gateway page ("LLM 502: <html><head>…")
// or a Cloudflare interstitial. The main process already scrubs it, but the
// banner is a text surface — never render markup fragments the user can't read.
export function cleanErr(s) {
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

export function fmtSize(bytes) {
  if (bytes == null || isNaN(bytes)) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Assistant text is sanitised Markdown; tool-protocol blocks are removed by
// stripToolProtocol() (src/textproto.mjs) since the call already renders as a card.
export function renderMarkdown(md) {
  let html;
  const normalized = linkifyBareDomains(stripToolProtocol(md));
  try { html = marked.parse(normalized); } catch { html = escapeHtml(normalized); }
  return DOMPurify.sanitize(html, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp|file|session):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i,
    ADD_ATTR: ['data-akron-file', 'data-akron-line', 'data-file', 'data-code', 'tabindex', 'role'],
  });
}

// ---------- Link unfurl (Claude Desktop og / twitter / xlink parity) ----------
// Bare URLs in a message become preview cards. The fetch happens in the main
// process behind an SSRF guard (electron/unfurl.js) — the renderer only ever
// receives sanitised metadata, never page HTML.
export const URL_RE = /https?:\/\/[^\s<>"'`)\]}]+/gi;

export function extractLinks(text) {
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

export const UNFURL_MEMO = new Map(); // url -> Promise<result>

export function fetchUnfurl(url) {
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

export function LinkPreviews({ text }) {
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

export function extractCodeBlocks(md) {
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

export const PRESETS = [
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
  { name: 'OpenRouter (Paid & Frontier)', baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.6', apiKey: '', supportsTools: true },
  { name: 'GhostMetal API', baseURL: 'https://api.ghostmetal.ai/v1', model: 'ghostmetal-pro', apiKey: '', supportsTools: true },
  { name: 'OpenAI', baseURL: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: '', supportsTools: true },

  // --- Any OpenAI-compatible endpoint ---
  { name: 'Custom', baseURL: '', model: '', apiKey: '', supportsTools: true },
];

// ---------- Provider key status (model picker dots) ----------
// Keys live per-endpoint so picking a different preset never reuses another
// provider's credential. Presets that ship a working key seed the map.
// Status classification lives in ./providerstatus-ui.mjs (unit-tested).
export const PRESET_KEYS = PRESETS.reduce((acc, p) => { if (p.apiKey && p.baseURL) acc[normBase(p.baseURL)] = p.apiKey; return acc; }, {});
export const FREELLM_LOOPBACK_BASES = [
  'http://localhost:3001/v1',
  'http://127.0.0.1:3001/v1',
  'http://localhost:31415/v1',
  'http://127.0.0.1:31415/v1',
];
export const isFreeLlmLoopback = (base) => FREELLM_LOOPBACK_BASES.includes(normBase(base));
export const resolveLoopbackKey = (base, map, cur) => {
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
export const STYLES = [
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
export const REASON_LEVELS = [
  { id: 'auto',    name: 'Auto',    hint: 'Model decides' },
  { id: 'minimal', name: 'Minimal', hint: 'Quickest light pass' },
  { id: 'low',     name: 'Low',     hint: 'Fast, minimal thinking' },
  { id: 'medium',  name: 'Medium',  hint: 'Balanced reasoning' },
  { id: 'high',    name: 'High',    hint: 'Deep, thorough reasoning' },
  { id: 'xhigh',   name: 'XHigh',   hint: 'Maximum deep reasoning' },
];
export const REASON_LABELS = REASON_LEVELS.reduce((acc, l) => { acc[l.id] = l.name; return acc; }, {});
export const MODEL_CAPABILITY_CACHE = 'autobot:modelCaps';
export const thinkingCapabilitiesForUi = (model) => {
  const m = String(model || '').trim();
  if (!m || /^(auto|fast|smart|fusion|default|free|akron-.*)$/i.test(m)) {
    return { supported: true, levels: ['auto', 'low', 'medium', 'high'], variants: null };
  }
  try {
    const cache = loadJSON(MODEL_CAPABILITY_CACHE, {}) || {};
    const hit = cache[m];
    if (hit && typeof hit === 'object') {
      const variants = hit.thinkingVariants && Object.keys(hit.thinkingVariants).length ? hit.thinkingVariants : null;
      const supported = hit.thinking !== undefined ? !!hit.thinking : true;
      const levels = Array.isArray(hit.thinkingLevels) && hit.thinkingLevels.length
        ? hit.thinkingLevels
        : (supported ? ['auto', 'low', 'medium', 'high'] : []);
      return { supported, levels: supported ? levels : [], variants };
    }
  } catch (_) {}
  if (/\b(gpt-4o(?:-mini)?|gpt-4-turbo|gpt-3\.5|claude-3-(?:haiku|sonnet|opus)|claude-2|llama-?3\.[0-3]?|mistral-7b)\b/i.test(m)) {
    return { supported: false, levels: [], variants: null };
  }
  const hasXHigh = /\b(gpt-5\.[1-9]|codex|claude-opus-5|gemini-4-neon|gemini-4-hydrogen)\b|-xhigh$/i.test(m);
  return {
    supported: true,
    levels: hasXHigh ? ['auto', 'low', 'medium', 'high', 'xhigh'] : ['auto', 'low', 'medium', 'high'],
    variants: null,
  };
};

// ---------- token / cost helpers (slash commands: /usage /cost /context) ----------
// Per-million-token list prices in USD. Matched by substring against the model
// id; the default is a mid-tier frontier rate so an unknown model still gives a
// sane order-of-magnitude estimate rather than $0.
export const PRICES = [
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
export const priceFor = (model) => {
  const m = PRICES.find((p) => p.re.test(String(model || '')));
  return m ? { in: m.in, out: m.out } : { in: 3, out: 15 };
};
export const fmtTokens = (n) => {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k';
  return String(v);
};
// Grouped exact count — used where the real number matters (context meter).
export const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
export const estimateCost = (model, prompt, completion) => {
  const p = priceFor(model);
  return ((Number(prompt) || 0) / 1e6) * p.in + ((Number(completion) || 0) / 1e6) * p.out;
};
export const fmtCost = (usd) => {
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
export const MODEL_WINDOW_CACHE = 'autobot:modelWindows';
export const contextWindowFor = (model) => {
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
export const usedTokens = (u) => {
  if (!u) return 0;
  const ctx = Number(u.context_tokens);
  const cacheRead = Number(u.cache_read_input_tokens) || 0;
  const cacheCreate = Number(u.cache_creation_input_tokens) || 0;
  if (Number.isFinite(ctx) && ctx > 0) {
    if (cacheRead + cacheCreate > ctx) return ctx + cacheRead + cacheCreate;
    return ctx;
  }
  const p = Number(u.prompt_tokens || u.input_tokens) || 0;
  const calls = Number(u.calls) || 0;
  if (p > 0) return calls > 1 ? Math.round(p / calls) : p;
  if (cacheRead + cacheCreate > 0) return cacheRead + cacheCreate;
  return 0;
};
export const USAGE_BY_CONV_KEY = 'autobot:usageByConv';
export function recordConvUsage(convId, usage) {
  if (!convId || !usage || typeof usage !== 'object') return;
  try {
    const map = loadJSON(USAGE_BY_CONV_KEY, {}) || {};
    const keys = Object.keys(map);
    if (keys.length > 80 && !map[convId]) {
      keys.sort((a, b) => (Number(map[a]?.at) || 0) - (Number(map[b]?.at) || 0));
      for (let i = 0; i < keys.length - 60; i++) delete map[keys[i]];
    }
    const prev = map[convId] || null;
    const nextCtx = usedTokens(usage);
    if (prev && nextCtx <= 0 && usedTokens(prev) > 0) {
      map[convId] = { ...prev, ...usage, context_tokens: prev.context_tokens || usedTokens(prev), prompt_tokens: usage.prompt_tokens || prev.prompt_tokens, at: Date.now() };
    } else {
      map[convId] = { ...usage, convId, at: Number(usage.at) || Date.now() };
    }
    saveJSON(USAGE_BY_CONV_KEY, map);
  } catch (_) {}
}
export function loadConvUsage(convId) {
  if (!convId) return null;
  try {
    const map = loadJSON(USAGE_BY_CONV_KEY, {}) || {};
    return map[convId] || null;
  } catch (_) {
    return null;
  }
}
export function estimateConvBaselineTokens(conv, provider) {
  if (!conv || !Array.isArray(conv.messages) || conv.messages.length === 0) return 0;
  let chars = 0;
  for (const m of conv.messages) {
    if (!m) continue;
    chars += msgText(m).length;
    if (Array.isArray(m.tools)) chars += JSON.stringify(m.tools).length;
    if (Array.isArray(m.attachments)) {
      for (const a of m.attachments) chars += (a && a.content ? String(a.content).length : (a && a.isImage ? 4000 : 120));
    }
  }
  const sysOverhead = provider && provider.supportsTools === false ? 300 : 2200;
  return Math.max(1, Math.round(chars / 3.8) + sysOverhead);
}
export function effectiveUsageForConv(lastUsage, activeConv, provider, live = null) {
  const cid = activeConv && activeConv.id;
  const hasMsgs = Boolean(activeConv && Array.isArray(activeConv.messages) && activeConv.messages.length > 0);
  const perConv = cid ? loadConvUsage(cid) : null;
  const globalMatches = Boolean(lastUsage && (!lastUsage.convId || (cid && lastUsage.convId === cid)));
  const liveHasData = Boolean(live && (live.content || (Array.isArray(live.tools) && live.tools.length)));
  if (!hasMsgs && !liveHasData) {
    if (globalMatches && usedTokens(lastUsage) > 0 && lastUsage.convId === cid) return lastUsage;
    return null;
  }
  let candidate = perConv;
  if (globalMatches && usedTokens(lastUsage) > usedTokens(perConv)) candidate = lastUsage;
  if (!candidate && globalMatches && lastUsage) candidate = lastUsage;
  const liveChars = live ? (String(live.content || '').length + JSON.stringify(live.tools || []).length) : 0;
  const baselineEst = (hasMsgs ? estimateConvBaselineTokens(activeConv, provider) : 0)
    + (liveChars > 0 ? Math.round(liveChars / 3.8) : 0);
  const candTokens = usedTokens(candidate);
  const poisonedSmall = Boolean(baselineEst >= 400 && candTokens < baselineEst * 0.2);
  if (candidate && candTokens > 0 && !poisonedSmall) return candidate;
  if (baselineEst <= 0) return candidate || null;
  return {
    ...(candidate || {}),
    prompt_tokens: Math.max(Number(candidate && candidate.prompt_tokens) || 0, baselineEst),
    context_tokens: baselineEst,
    completion_tokens: Number(candidate && candidate.completion_tokens) || 0,
    total_tokens: Math.max(Number(candidate && candidate.total_tokens) || 0, baselineEst + (Number(candidate && candidate.completion_tokens) || 0)),
    calls: Number(candidate && candidate.calls) || 1,
    model: (candidate && candidate.model) || (live && live.model) || (provider && provider.model) || '',
    estimated: true,
    convId: cid || null,
  };
}
export const formatContextPct = (used, win) => {
  if (!(win > 0) || !(used > 0)) return '0%';
  const raw = (used / win) * 100;
  if (raw < 1) return '<1%';
  return Math.min(100, Math.round(raw)) + '%';
};
export const msgText = (m) => {
  const c = m && m.content;
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x && typeof x === 'object' ? (x.text || '') : String(x))).join('\n');
  try { return JSON.stringify(c); } catch { return String(c); }
};

// ---------- payload builders (pure) ----------
export const buildDirectives = (styleId, reasoningLevel, opts = {}) => {
  const customList = Array.isArray(opts.customStyles) ? opts.customStyles : [];
  const mergedStyles = [...STYLES];
  for (const cs of customList) {
    if (!cs || !cs.id) continue;
    const idx = mergedStyles.findIndex((s) => s.id === cs.id);
    const normalized = {
      id: cs.id,
      name: cs.name || cs.id,
      hint: cs.hint || '',
      prompt: cs.prompt || cs.directive || '',
    };
    if (idx >= 0) mergedStyles[idx] = normalized;
    else mergedStyles.push(normalized);
  }
  const style = mergedStyles.find((s) => s.id === styleId);
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
// Never ship a credential in the renderer bundle. The default is the keyless
// local FreeLLMAPI router; a real key is only ever typed by the user (and then
// persisted per endpoint in `autobot:providerKeys` / main's settings file).
export const DEFAULT_PROVIDER = { baseURL: 'http://localhost:3001/v1', apiKey: '', model: 'auto', routingMode: 'direct', temperature: 0.7, maxTokens: 8192, reasoningLevel: 'auto', supportsTools: true };

// ---------- persistence helpers ----------
export function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
export function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// Dismiss a popover on outside mousedown, Escape, or when focus moves into a
// guest <webview>/<iframe> (clicks inside a guest never reach this document, but
// the host window blurs). A plain app switch does NOT dismiss: a sign-in that
// opened the system browser, or a native file dialog, must not lose the menu.
export function useDismiss(open, refs, close) {
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
export function toggleDictation(inputRef, setDictating) {
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
export const TEXT_EXT = /\.(txt|md|markdown|json|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|hpp|cs|php|html|css|scss|less|xml|yaml|yml|toml|ini|sh|bash|zsh|fish|sql|log|csv|tsv|vue|svelte|graphql|gql|prisma|env|conf|gitignore|dockerfile)$/i;
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|tiff?)$/i;
export const EXTRACT_DOC_EXT = /\.(pdf|docx|xlsx|xls|xlsm|ods|pptx|zip|tar\.gz|tgz|epub|odt|rtf|csv|tsv)$/i;
export function readBlobAsDataUrl(blob) { return new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(blob); }); }
export async function filesToAttachments(files) {
  const out = [];
  for (const f of Array.from(files || [])) {
    const att = { name: f.name, path: f.path || '', size: f.size, isText: false, isImage: false, content: null, dataUrl: null };
    if (IMAGE_EXT.test(f.name)) {
      att.isImage = true;
      if (f.size <= 8 * 1024 * 1024) att.dataUrl = await readBlobAsDataUrl(f);
    } else if (EXTRACT_DOC_EXT.test(f.name) && f.size <= 25 * 1024 * 1024 && typeof window !== 'undefined' && window.autobot && typeof window.autobot.extractAttachment === 'function') {
      try {
        const ab = typeof f.arrayBuffer === 'function' ? await f.arrayBuffer() : null;
        const extRes = await window.autobot.extractAttachment({
          name: f.name,
          path: f.path || '',
          buffer: ab ? Array.from(new Uint8Array(ab)) : null,
        });
        if (extRes && extRes.content) {
          att.content = extRes.content;
          att.isText = true;
          att.extractedFormat = extRes.format || '';
        }
      } catch (_) {}
      if (!att.content && TEXT_EXT.test(f.name) && f.size <= 200 * 1024) {
        try { const txt = await f.text(); if (!txt.includes('\u0000')) { att.content = txt; att.isText = true; } } catch (_) {}
      }
    } else if (TEXT_EXT.test(f.name) && f.size <= 200 * 1024) {
      try { const txt = await f.text(); if (!txt.includes('\u0000')) { att.content = txt; att.isText = true; } } catch (_) {}
    }
    out.push(att);
  }
  return out;
}


export function uid() { return 'x' + Math.random().toString(36).slice(2) + Date.now().toString(36); }

// Re-render on a timer while a run is active so elapsed time / spinners stay live.
export function useTicker(active, ms = 500) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  return m + 'm ' + (s % 60) + 's';
}

let __lastCopiedText = '';
let __lastCopiedAt = 0;

function emitCopiedOnce(text, kind) {
  const now = Date.now();
  if (text === __lastCopiedText && (now - __lastCopiedAt) < 350) return;
  __lastCopiedText = text;
  __lastCopiedAt = now;
  try {
    window.dispatchEvent(new CustomEvent('akron:copied', { detail: { text, kind } }));
  } catch (_) {}
}

/**
 * Copy text to the system clipboard using Electron's native OS clipboard IPC first,
 * verifying read-back, then falling back to navigator.clipboard and hidden textarea copy.
 */
export async function copyTextToClipboard(text) {
  const str = String(text == null ? '' : text);
  if (!str) return false;
  let copied = false;
  try {
    if (typeof window !== 'undefined' && window.autobot && typeof window.autobot.clipboardWrite === 'function') {
      const r = await window.autobot.clipboardWrite(str);
      if (r && r.ok !== false) {
        if (r.verified === true || typeof window.autobot.clipboardRead !== 'function') {
          copied = true;
        } else {
          const check = await window.autobot.clipboardRead().catch(() => '');
          if (check === str) copied = true;
        }
      }
    }
  } catch (_) {}
  if (!copied) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(str);
        copied = true;
      }
    } catch (_) {}
  }
  if (!copied && typeof document !== 'undefined') {
    let ta = null;
    const sel = typeof window !== 'undefined' && window.getSelection ? window.getSelection() : null;
    const savedRanges = [];
    if (sel) {
      for (let i = 0; i < sel.rangeCount; i++) savedRanges.push(sel.getRangeAt(i));
    }
    try {
      ta = document.createElement('textarea');
      ta.value = str;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      copied = document.execCommand('copy');
    } catch (_) {
    } finally {
      if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
      if (sel) {
        try {
          sel.removeAllRanges();
          for (const r of savedRanges) sel.addRange(r);
        } catch (_) {}
      }
    }
  }
  return copied;
}

export async function readTextFromClipboard() {
  try {
    if (typeof window !== 'undefined' && window.autobot && typeof window.autobot.clipboardRead === 'function') {
      const t = await window.autobot.clipboardRead();
      if (typeof t === 'string' && t.length > 0) return t;
    }
  } catch (_) {}
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.readText === 'function') {
      const t = await navigator.clipboard.readText();
      if (typeof t === 'string' && t.length > 0) return t;
    }
  } catch (_) {}
  return '';
}

function setNativeInputValue(el, nextValue) {
  if (!el) return;
  try {
    const proto = el.tagName === 'TEXTAREA'
      ? (typeof window !== 'undefined' && window.HTMLTextAreaElement && window.HTMLTextAreaElement.prototype)
      : (typeof window !== 'undefined' && window.HTMLInputElement && window.HTMLInputElement.prototype);
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, 'value')?.set : null;
    if (typeof setter === 'function') setter.call(el, nextValue);
    else el.value = nextValue;
  } catch (_) {
    el.value = nextValue;
  }
}

function insertTextIntoEditable(el, text) {
  if (!el || text == null) return false;
  const str = String(text);
  try {
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const start = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
      const next = el.value.slice(0, start) + str + el.value.slice(end);
      setNativeInputValue(el, next);
      const caret = start + str.length;
      try { el.setSelectionRange(caret, caret); } catch (_) {}
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      document.execCommand('insertText', false, str);
      return true;
    }
  } catch (_) {}
  return false;
}

export function getActiveSelectedText() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return '';
  try {
    const sel = window.getSelection ? window.getSelection() : null;
    const domStr = sel ? String(sel.toString() || '') : '';
    if (domStr && domStr.trim().length > 0) return domStr;
  } catch (_) {}
  try {
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && typeof ae.selectionStart === 'number' && typeof ae.selectionEnd === 'number' && ae.selectionEnd > ae.selectionStart) {
      const sub = String(ae.value || '').slice(ae.selectionStart, ae.selectionEnd);
      if (sub && sub.trim().length > 0) return sub;
    }
  } catch (_) {}
  try {
    const cached = window.__akronLastSelection;
    if (cached && cached.text && (Date.now() - (cached.at || 0) < 15000)) {
      return cached.text;
    }
  } catch (_) {}
  return '';
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__akronClipboardTrackerInstalled) {
  window.__akronClipboardTrackerInstalled = true;
  window.__akronLastSelection = { text: '', msgId: '', at: 0 };
  window.__akronGetSelectedText = getActiveSelectedText;

  const isMac = /mac/i.test(String((navigator && (navigator.platform || navigator.userAgent)) || ''));

  const updateCachedSelection = () => {
    try {
      const sel = window.getSelection ? window.getSelection() : null;
      const s = sel ? String(sel.toString() || '') : '';
      if (s && s.trim().length > 0) {
        let msgId = '';
        const node = sel.anchorNode || sel.focusNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const msgEl = el && el.closest ? el.closest('.msg[data-msg-id]') : null;
        if (msgEl) msgId = msgEl.getAttribute('data-msg-id') || '';
        window.__akronLastSelection = { text: s, msgId, at: Date.now() };
      }
    } catch (_) {}
  };

  document.addEventListener('selectionchange', updateCachedSelection, true);
  document.addEventListener('mouseup', updateCachedSelection, true);
  document.addEventListener('keyup', updateCachedSelection, true);

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    const t = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    if (t && t.closest && t.closest('.copy-btn, .response-action-btn, .msg-user-mini-btn, .msg-toolbar, .conv-pop-item, .response-share-menu')) {
      return;
    }
    setTimeout(() => {
      try {
        const sel = window.getSelection ? window.getSelection() : null;
        const s = sel ? String(sel.toString() || '') : '';
        if (!s || !s.trim()) {
          window.__akronLastSelection = { text: '', msgId: '', at: 0 };
        }
      } catch (_) {}
    }, 120);
  }, true);

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = String(e.key || '').toLowerCase();
    const code = e.code;
    const modOnly = (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey;
    const ae = document.activeElement;
    const inEditable = !!(ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable));
    const inMonaco = !!(ae && ae.closest && ae.closest('.monaco-editor'));
    const inTerminal = !!(ae && ae.closest && ae.closest('.xterm'));

    // Ctrl+C / Cmd+C anywhere with active/cached selection (except inside Monaco or xterm)
    if (modOnly && (k === 'c' || code === 'KeyC') && !inMonaco && !inTerminal) {
      const txt = getActiveSelectedText();
      if (!txt) return;
      e.preventDefault();
      e.stopPropagation();
      copyTextToClipboard(txt).then((ok) => {
        if (ok) emitCopiedOnce(txt, 'selection');
      });
      return;
    }

    // On macOS, Cocoa binds Ctrl+V to pageDown, Ctrl+A to lineStart, etc. Make Ctrl+V/Ctrl+X/Ctrl+A work cleanly everywhere!
    if (isMac && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !inMonaco && !inTerminal) {
      if (k === 'v' || code === 'KeyV') {
        e.preventDefault();
        e.stopPropagation();
        const target = inEditable ? ae : document.querySelector('.composer textarea');
        readTextFromClipboard().then((txt) => {
          if (txt && target) {
            if (!inEditable) { try { target.focus(); } catch (_) {} }
            insertTextIntoEditable(target, txt);
            return;
          }
          if (!txt && typeof window !== 'undefined' && window.autobot && typeof window.autobot.clipboardReadImage === 'function') {
            window.autobot.clipboardReadImage().then((imgRes) => {
              if (imgRes && imgRes.ok && imgRes.hasImage && imgRes.dataUrl) {
                window.dispatchEvent(new CustomEvent('akron:clipboard-image', { detail: imgRes }));
              }
            }).catch(() => {});
          }
        });
        return;
      }
      if (inEditable && (k === 'x' || code === 'KeyX') && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
        const s = ae.selectionStart;
        const en = ae.selectionEnd;
        if (typeof s === 'number' && typeof en === 'number' && en > s) {
          e.preventDefault();
          e.stopPropagation();
          const cutText = ae.value.slice(s, en);
          setNativeInputValue(ae, ae.value.slice(0, s) + ae.value.slice(en));
          try { ae.setSelectionRange(s, s); } catch (_) {}
          ae.dispatchEvent(new Event('input', { bubbles: true }));
          copyTextToClipboard(cutText);
        }
        return;
      }
      if (inEditable && (k === 'a' || code === 'KeyA') && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) {
        e.preventDefault();
        e.stopPropagation();
        try { ae.select(); } catch (_) {}
        return;
      }
    }
  }, true);

  window.addEventListener('copy', (e) => {
    const ae = document.activeElement;
    if (ae && ae.closest && (ae.closest('.monaco-editor') || ae.closest('.xterm'))) return;
    const txt = getActiveSelectedText();
    if (!txt) return;
    try {
      if (e.clipboardData) {
        e.clipboardData.setData('text/plain', txt);
        e.preventDefault();
      }
    } catch (_) {}
    copyTextToClipboard(txt).then((ok) => {
      if (ok) emitCopiedOnce(txt, 'selection');
    });
  }, true);

  document.addEventListener('click', (e) => {
    const t = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    const btn = t && t.closest ? t.closest('.copy-btn') : null;
    if (!btn) return;
    let code = '';
    try {
      code = btn.dataset && btn.dataset.code ? decodeURIComponent(btn.dataset.code) : '';
    } catch (_) {
      code = (btn.dataset && btn.dataset.code) || '';
    }
    if (!code) {
      const cb = btn.closest('.codeblock, .artifact-body');
      const codeEl = cb ? cb.querySelector('pre code, pre') : null;
      if (codeEl) code = codeEl.textContent || '';
    }
    if (!code) return;
    e.stopPropagation();
    copyTextToClipboard(code).then((ok) => {
      if (!ok) return;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      emitCopiedOnce(code, 'code');
    });
  }, true);
}

/**
 * Extract plain markdown/text content from a message, reconstructing from segments
 * when m.content is empty or partial.
 */
export function extractMessageText(m) {
  if (!m) return '';
  if (m.content != null && String(m.content).length > 0) return String(m.content);
  if (Array.isArray(m.segments) && m.segments.length > 0) {
    return m.segments
      .filter((s) => s && s.type !== 'thinking' && s.text)
      .map((s) => s.text)
      .join('\n\n');
  }
  return '';
}

const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtMessageFullTimestamp(ts) {
  const num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return '';
  try {
    return new Date(num).toLocaleString();
  } catch {
    return '';
  }
}

export function fmtMessageTimestamp(ts, format = 'date-time') {
  const num = Number(ts);
  if (!Number.isFinite(num) || num <= 0) return '';
  const d = new Date(num);
  if (Number.isNaN(d.getTime())) return '';

  const pad2 = (n) => String(n).padStart(2, '0');
  const hh = d.getHours();
  const mm = pad2(d.getMinutes());
  const ss = pad2(d.getSeconds());
  const mon = SHORT_MONTHS[d.getMonth()];
  const day = d.getDate();
  const yr = d.getFullYear();
  const mode = format === 'short' || !format ? 'date-time' : format;

  if (mode === 'iso') {
    return `${yr}-${pad2(d.getMonth() + 1)}-${pad2(day)} ${pad2(hh)}:${mm}:${ss}`;
  }
  if (mode === '12h') {
    const h12 = hh % 12 || 12;
    const ampm = hh >= 12 ? 'PM' : 'AM';
    return `${mon} ${day} · ${h12}:${mm} ${ampm}`;
  }

  const now = new Date();
  const time24 = `${pad2(hh)}:${mm}`;

  if (mode === '24h') {
    return `${day} ${mon} · ${time24}`;
  }

  if (mode === 'relative') {
    const diffSec = Math.max(0, Math.round((now.getTime() - d.getTime()) / 1000));
    if (diffSec < 45) return `just now · ${time24}`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago · ${time24}`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago · ${time24}`;
    return `${day} ${mon} · ${time24}`;
  }

  const sameDay =
    yr === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    day === now.getDate();
  if (sameDay) return `Today · ${time24}`;
  if (yr !== now.getFullYear()) return `${day} ${mon} ${yr} · ${time24}`;
  return `${day} ${mon} · ${time24}`;
}

export function shortPath(p) {
  p = String(p || '').replace(/\\/g, '/');
  const parts = p.split('/').filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// Turn a raw tool call into the human line Example shows ("Writing index.html").
export function describeTool(name, args) {
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
    case 'GenerateImage': case 'create_image': return { verb: 'Generating image', target: String(a.prompt || a.output_path || '').slice(0, 60), icon: 'Palette' };
    case 'EditImage': case 'edit_image': return { verb: 'Editing image', target: shortPath(a.input_path || a.path), icon: 'Palette' };
    case 'GenerateVideo': case 'generate_video': return { verb: 'Generating video', target: String(a.prompt || a.output_path || '').slice(0, 60), icon: 'Play' };
    case 'EditVideo': case 'edit_video': return { verb: 'Editing video', target: shortPath(a.input_path || a.path), icon: 'Play' };
    case 'ReadDocument': return { verb: 'Reading document', target: shortPath(a.path || a.file_path), icon: 'File' };
    case 'GenerateDocument': return { verb: 'Creating document', target: String(a.format || a.output_path || '').slice(0, 50), icon: 'FileAdd' };
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

export function timeGreeting() {
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
export const MARK = '#10B981';
export const MARK_GLOW = '#A7F3D0';
export const COMPACT_RAYS = [0, 45, 90, 135, 180, 225, 270, 315];

export function CompactMark({ size, active }) {
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
export function FullMark({ size, active }) {
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

export function Logo({ size = 20, active = false }) {
  return size < 30 ? <CompactMark size={size} active={active} /> : <FullMark size={size} active={active} />;
}

// ---------- Conversation export / share ----------
// Claude Desktop's "Share chat" publishes a public link; Akron Code has no backend, so
// the local equivalent is a self-contained HTML share file (open in any browser, no
// server) plus Markdown/JSON export. All three route through the renderer and land in
// a native save dialog via `autobot:saveFile`.
export function convToMarkdown(conv) {
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

export function convToHtml(conv) {
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