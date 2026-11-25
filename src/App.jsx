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

// ---------- Anthropicons (Claude's icon font, PUA U+E000+) ----------
const iconChar = (name) => {
  const cp = iconsMap[name];
  if (!cp) return '';
  return String.fromCodePoint(parseInt(cp, 10));
};

function Icon({ name, size = 16, className = '', title, style }) {
  return (
    <span
      className={'icon ' + className}
      style={{ fontSize: size, lineHeight: 1, width: size, height: size, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', ...style }}
      aria-hidden={title ? undefined : true}
      title={title}
    >
      {iconChar(name)}
    </span>
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

  // --- DeepSeek ---
  { name: 'DeepSeek (official)', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '', supportsTools: true },
  { name: 'DeepSeek Reasoner', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', apiKey: '', supportsTools: true },

  // --- TokenRouter (Kimi K3.1 Pro + DeepSeek V4.1 Flash) ---
  { name: 'TokenRouter · Kimi K3.1 Pro', baseURL: 'https://api.tokenrouter.com/v1', model: 'moonshotai/kimi-k3.1-pro', apiKey: 'sk-0xqsYQbMGNtG59gMI40gWfX7inTdZDuURr3DaBlymVuNKCwJ', supportsTools: true, maxTokens: 8192, reasoningLevel: 'auto' },
  { name: 'TokenRouter · DeepSeek V4.1 Flash', baseURL: 'https://api.tokenrouter.com/v1', model: 'deepseek/deepseek-v4.1-flash-1017', apiKey: 'sk-0xqsYQbMGNtG59gMI40gWfX7inTdZDuURr3DaBlymVuNKCwJ', supportsTools: true, maxTokens: 8192, reasoningLevel: 'auto' },

  // --- Free tiers (OpenAI-compatible) ---
  { name: 'Groq (free tier)', baseURL: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', apiKey: '', supportsTools: true },
  { name: 'Cerebras (free)', baseURL: 'https://api.cerebras.ai/v1', model: 'llama3.1-8b', apiKey: '', supportsTools: true },
  { name: 'Mistral (La Plateforme)', baseURL: 'https://api.mistral.ai/v1', model: 'mistral-small-latest', apiKey: '', supportsTools: true },
  { name: 'Cohere', baseURL: 'https://api.cohere.com/v1', model: 'command-r-plus', apiKey: '', supportsTools: true },
  { name: 'Z.ai / Zhipu (GLM)', baseURL: 'https://api.z.ai/api/paas/v4', model: 'glm-4-plus', apiKey: '', supportsTools: true },
  { name: 'NVIDIA NIM', baseURL: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3.5-bolt-e4b', apiKey: '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', supportsTools: true },
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

// ---------- Styles (Claude Desktop parity: preset writing styles) ----------
const STYLES = [
  { id: 'default', name: 'Default', hint: '', prompt: '' },
  { id: 'concise', name: 'Concise', hint: 'Keep it short', prompt: 'Be concise and direct. Prefer short answers, bullet points, and skip preamble.' },
  { id: 'explanatory', name: 'Explanatory', hint: 'Explain everything', prompt: 'Explain concepts thoroughly. Define terms, give context, and walk through reasoning step by step.' },
  { id: 'formal', name: 'Formal', hint: 'Professional tone', prompt: 'Use a formal, professional tone. Avoid slang and contractions. Structure answers clearly.' },
  { id: 'casual', name: 'Casual', hint: 'Friendly tone', prompt: 'Use a friendly, casual, conversational tone.' },
  { id: 'code', name: 'Code-first', hint: 'Prioritize code', prompt: 'Prioritize working code and concrete examples over prose. Include full, runnable snippets.' },
];

// ---------- payload builders (pure) ----------
const buildDirectives = (styleId, reasoningLevel, opts = {}) => {
  const style = STYLES.find((s) => s.id === styleId);
  const d = [];
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
    const s = typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return ''; } })();
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, n || 110);
  };
  const lines = list.slice(-15).map((t) => {
    const a = t.args || {};
    const target = a.path || a.file || a.command || a.query || a.url || a.name || a.description || a.prompt || '';
    const bad = /^(Error|Tool error)/i.test(String(t.result || '').trim());
    return `- ${t.name}${target ? '(' + clip(target, 90) + ')' : ''} → ${bad ? 'ERROR: ' : ''}${clip(t.result, 110) || '(no result)'}`;
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

const DEFAULT_PROVIDER = { baseURL: 'https://integrate.api.nvidia.com/v1', apiKey: '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', model: 'nvidia/nemotron-3.5-bolt-e4b', temperature: 0.7, maxTokens: 8192, reasoningLevel: 'auto', supportsTools: true };

// ---------- persistence helpers ----------
function loadJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

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
  const [provider, setProvider] = useState(() => ({ ...DEFAULT_PROVIDER, ...loadJSON('autobot:provider', {}) }));
  const [providerKeys, setProviderKeys] = useState(() => loadJSON('autobot:providerKeys', {}));
  const [settings, setSettings] = useState(() => loadJSON('autobot:settings', { theme: 'dark', useMemory: true, locale: 'en' }));
  const T = useCallback((k) => _t(settings.locale, k), [settings.locale]);
  const [orchestrator, setOrchestrator] = useState(() => ({ enabled: false, providers: [], activeIndex: -1 }));
  const [features, setFeatures] = useState(() => ({ computerUse: true, chrome: false, bridges: false, quickEntry: true, computerUseTeach: false, buddy: false, remoteControl: false, extensions: false, developerMode: false, trustedFolders: false, chromeHost: '127.0.0.1', chromePort: 9222 }));
  const [account, setAccount] = useState(() => loadJSON('autobot:account', {
    signedIn: false,
    authMethod: null, // null | 'anthropic' | 'sso'
    email: '',
    plan: 'Free', // Free | Pro | Max
    sso: { enabled: false, idpName: '', issuer: '', clientId: '', domain: '' },
    sync: { enabled: false, lastSync: null, status: 'never', deviceCount: 1 },
  }));
  const [panel, setPanel] = useState('chats'); // chats | memory | skills | notebooks | mcp | artifacts | terminal | projects
  const [showSettings, setShowSettings] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [streaming, setStreaming] = useState(false);
  // Wall-clock start of the active run — powers the live "Working · 12s" row.
  const [runStartedAt, setRunStartedAt] = useState(0);
  const [queued, setQueued] = useState([]); // messages typed while a reply streams
  const [thinking, setThinking] = useState('');
  const [live, setLive] = useState(null); // { content, tools: [] }
  const [cwd, setCwd] = useState('');
  const [error, setError] = useState('');
  const [question, setQuestion] = useState(null); // { id, type, text, options }

  const [memory, setMemory] = useState([]);
  const [skills, setSkills] = useState([]);
  const [mcpServers, setMcpServers] = useState([]);
  const [mcpForm, setMcpForm] = useState({ transport: 'stdio', command: '', args: '', url: '' });
  const [subAgents, setSubAgents] = useState([]); // { name, status }
  const [notebooks, setNotebooks] = useState([]); // names
  const [activeNotebook, setActiveNotebook] = useState(null);
  const [notebookCells, setNotebookCells] = useState([]);
  const [terminal, setTerminal] = useState({ tabs: [], active: null }); // { tabs: [{id,cwd,running,output}], active }
  const [artifactsExplicit, setArtifactsExplicit] = useState([]); // { name, language, content }
  const [notice, setNotice] = useState(''); // transient banner (SendUserMessage / SetGoal)
  const [attachments, setAttachments] = useState([]); // { name, path, size, isText, content }
  // Reasoning / thinking level is stored on the provider object so it (a) drives
  // the prompt directive and (b) is sent to the API as `reasoning_effort`.
  const reasoningLevel = provider.reasoningLevel || 'auto';
  const setReasoningLevel = (lv) => setProvider((p) => ({ ...p, reasoningLevel: lv }));
  const [styleId, setStyleId] = useState('default');
  const [showSearch, setShowSearch] = useState(false);
  const [showPalette, setShowPalette] = useState(false); // Command Palette (⌘K)
  const [showFind, setShowFind] = useState(false);       // in-chat Find (⌘F)
  const [findQuery, setFindQuery] = useState('');
  const [webSearch, setWebSearch] = useState(false);
  const [dictating, setDictating] = useState(false);
  const [projects, setProjects] = useState(() => loadJSON('autobot:projects', [])); // { id, name, instructions }
  const [activeProject, setActiveProject] = useState(() => loadJSON('autobot:activeProject', null));
  const [sessionPane, setSessionPane] = useState({ type: null, width: 460 }); // type: null | 'browser' | 'files' | 'terminal' | 'diff'
  const [previewUrl, setPreviewUrl] = useState(null); // file the browser pane should show (generated site)
  const [voiceMode, setVoiceMode] = useState(false); // full-duplex conversational voice session
  const [permissions, setPermissions] = useState(() => loadJSON('autobot:permissions', 'auto')); // 'auto' | 'ask' (B8 Claude Code mode)
  const [permission, setPermission] = useState(null); // pending permission prompt { id, tool, args, summary }

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

  // Claude parity: session panes coexist with chat and toggle via dispatchToggleSessionPane semantics
  const toggleSessionPane = useCallback((type) => {
    setSessionPane((p) => (p.type === type ? { ...p, type: null } : { ...p, type }));
    // Opening a session pane always returns the main area to the chat context
    setPanel('chats');
  }, []);

  // persist
  useEffect(() => { saveJSON('autobot:convs', convs); }, [convs]);
  useEffect(() => { saveJSON('autobot:activeId', activeId); }, [activeId]);
  useEffect(() => { saveJSON('autobot:provider', provider); }, [provider]);
  useEffect(() => { saveJSON('autobot:providerKeys', providerKeys); }, [providerKeys]);
  // Mirror the active provider into the main-process settings so headless runs
  // (scheduled tasks) use the same model the user picked.
  useEffect(() => { try { window.autobot.setSettings({ provider }); } catch (_) {} }, [provider]);
  useEffect(() => { saveJSON('autobot:settings', settings); }, [settings]);
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

  // Claude parity: CmdOrCtrl+Shift+B toggles the Browser session pane
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

  // Claude parity: CmdOrCtrl+K command palette, CmdOrCtrl+F in-chat find
  useEffect(() => {
    const onKey = (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 'k' || e.key === 'K') { e.preventDefault(); setShowPalette((v) => !v); }
      else if (e.key === 'f' || e.key === 'F') { e.preventDefault(); setShowFind((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
        && /^(delta|thinking|tool|toolResult|done|complete|cancelled|error|notice|limit|retry)$/.test(evt.type)) return;
      switch (evt.type) {
        case 'retry':
          // The turn was cut at the token limit and is being re-generated. Drop
          // the truncated attempt so the transcript shows one clean answer, the
          // way Claude replaces a cut-off message instead of stacking a second.
          setLive((l) => {
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
          setLive((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            if (last && last.type === 'text') segments[segments.length - 1] = { type: 'text', text: last.text + evt.text };
            else segments.push({ type: 'text', text: evt.text });
            return { ...base, content: base.content + evt.text, segments };
          });
          break;
        case 'thinking':
          // Claude shows reasoning inline in the transcript ("Thought for 4s"),
          // not just in the status line. Keep it as an ordered segment so the
          // record reads: thinking → text → tools → text, in the real order.
          setThinking((t) => t + evt.text);
          setLive((l) => {
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
        case 'tool':
          setLive((l) => {
            const base = l || { content: '', tools: [], segments: [] };
            const segments = (base.segments || []).slice();
            const last = segments[segments.length - 1];
            if (last && last.type === 'tools') segments[segments.length - 1] = { type: 'tools', ids: [...last.ids, evt.id] };
            else segments.push({ type: 'tools', ids: [evt.id] });
            return { ...base, tools: [...base.tools, { id: evt.id, name: evt.name, args: evt.args, result: null, status: 'running' }], segments };
          });
          break;
        case 'toolResult':
          setLive((l) => {
            if (!l) return l;
            return { ...l, tools: l.tools.map((t) => (t.id === evt.id ? { ...t, result: evt.result, status: evt.isError ? 'error' : 'done' } : t)) };
          });
          break;
        case 'done':
        case 'complete':
          commitLive();
          break;
        case 'cancelled':
          // Stopping keeps whatever the model had already produced.
          commitLive();
          break;
        case 'error':
          // Preserve anything already streamed, then show the failure.
          commitLive();
          setError(cleanErr(evt.message));
          break;
        case 'question':
          setQuestion({ id: evt.id, type: 'question', text: evt.question, options: evt.options || [] });
          break;
        case 'plan':
          setQuestion({ id: evt.id, type: 'plan', text: evt.plan, options: [] });
          break;
        case 'permission':
          setPermission({ id: evt.id, tool: evt.tool, args: evt.args || {}, summary: evt.summary || '' });
          break;
        case 'subagent':
          if (evt.status === 'started') {
            setSubAgents((s) => [...s, { name: evt.name, status: 'running' }]);
          } else {
            setSubAgents((s) => s.map((a) => (a.name === evt.name ? { ...a, status: 'done' } : a)));
          }
          break;
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
          setNotice('Goal: ' + evt.goal);
          break;
        case 'notice':
          // Context compaction and other system-level messages from the agent.
          setNotice(String(evt.text || ''));
          break;
        case 'limit':
          setNotice(`Paused after ${evt.steps} tool turns — the runaway safety valve, not a step limit. Say "continue" to carry on.`);
          break;
        default:
          break;
      }
    });
    return off;
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, live, thinking]);

  // Which conversation the in-flight run belongs to (survives chat switching).
  const runConvRef = useRef(null);
  const runActiveRef = useRef(false);
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
    setThinking('');
    const startedAt = runStartedAtRef.current;
    setLive((l) => {
      if (l && (l.content || l.tools.length)) {
        // Bind the reply to the conversation the run was started from — the user
        // may have switched chats while it streamed.
        const msg = { id: uid(), role: 'assistant', content: l.content, tools: l.tools, segments: l.segments, ts: Date.now(), durationMs: startedAt ? Date.now() - startedAt : 0 };
        setConvs((cs) => cs.map((c) => (c.id === target ? { ...c, messages: [...c.messages, msg] } : c)));
      }
      return null;
    });
  }, []);

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
    // Claude parity: a message sent while a reply is streaming is not dropped —
    // it is queued and dispatched the moment the current turn finishes.
    if (streamingRef.current) {
      if (override === undefined) inputRef.current.value = '';
      if (!Array.isArray(attsOverride)) setAttachments([]);
      setQueued((q) => [...q, { id: uid(), text, atts, convId: activeId }]);
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
    const directives = buildDirectives(styleId, provider.reasoningLevel, { webSearch, project: activeProject });
    if (directives.length) payloadMessages.unshift({ role: 'system', content: directives.join('\n') });

    // Only consume the composer's attachment tray when this send came from the
    // composer — a queued message carries its own snapshot.
    if (!Array.isArray(attsOverride)) setAttachments([]);

    // Pin the run to its conversation before any event can arrive.
    runConvRef.current = convId;
    runActiveRef.current = true;
    setStreaming(true);
    setRunStartedAt(Date.now());
    setThinking('');
    setLive({ content: '', tools: [] });
    setSubAgents([]);
    const runId = uid();
    runIdRef.current = runId;

    await window.autobot.run({
      runId,
      messages: payloadMessages,
      provider,
      cwd: runCwd || undefined,
      useMemory: settings.useMemory,
      orchestrator,
      permissions,
      convId,
      title: convsRef.current.find((c) => c.id === convId)?.title || autoTitle,
    });
  }, [activeId, convs, provider, cwd, settings.useMemory, streaming, orchestrator, attachments, styleId, webSearch, activeProject, permissions]);

  const stop = useCallback(() => {
    if (runIdRef.current) window.autobot.cancel(runIdRef.current);
  }, []);

  // Claude parity: anything queued while a reply was streaming is dispatched the
  // instant that run settles — no message is ever swallowed.
  useEffect(() => {
    if (streaming || !queued.length) return;
    const [next, ...rest] = queued;
    setQueued(rest);
    // Deliver into the conversation it was typed in, but never yank the view:
    // the user may have moved to another chat while it waited.
    send(next.text, next.atts, next.convId);
  }, [streaming, queued, send]);

  const unqueue = useCallback((id) => setQueued((q) => q.filter((x) => x.id !== id)), []);
  // Stop the live run so the queued message goes out immediately.
  const sendQueuedNow = useCallback(() => {
    if (runIdRef.current) window.autobot.cancel(runIdRef.current);
  }, []);

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

  const answerPermission = useCallback(async (allow) => {
    if (!permission) return;
    const id = permission.id;
    setPermission(null);
    await window.autobot.answerPermission(id, allow);
  }, [permission]);

  // The live stream belongs to one conversation; don't paint it into another one.
  const liveForActive = live && (!runConvRef.current || runConvRef.current === activeId) ? live : null;

  // Starting a new chat must not discard an in-flight run's stream — that run is
  // committed to its own conversation and `liveForActive` keeps it off-screen.
  const newChat = () => { if (!streamingRef.current) setLive(null); setActiveId(null); setError(''); setPanel('chats'); inputRef.current?.focus(); };
  const selectConv = (id) => { setActiveId(id); setPanel('chats'); };
  const deleteConv = (id) => {
    setConvs((cs) => cs.filter((c) => c.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const copyMessage = (m) => { navigator.clipboard?.writeText(m.content || '').catch(() => {}); };

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
    if (streaming) return;
    const conv = convsRef.current.find((c) => c.id === convId);
    if (!conv) return;
    const msgs = conv.messages;
    let userIdx = idx - 1;
    while (userIdx >= 0 && msgs[userIdx].role !== 'user') userIdx--;
    if (userIdx < 0) return;
    const kept = msgs.slice(0, userIdx + 1);
    setConvs((cs) => cs.map((c) => (c.id === convId ? { ...c, messages: kept } : c)));
    const payloadMessages = buildPayloadMessages(kept);
    const directives = buildDirectives(styleId, provider.reasoningLevel, { webSearch, project: activeProject });
    if (directives.length) payloadMessages.unshift({ role: 'system', content: directives.join('\n') });
    setStreaming(true);
    setRunStartedAt(Date.now());
    setThinking('');
    setLive({ content: '', tools: [] });
    setSubAgents([]);
    const runId = uid();
    runIdRef.current = runId;
    await window.autobot.run({
      runId, messages: payloadMessages, provider,
      cwd: cwd || undefined, useMemory: settings.useMemory, orchestrator, permissions,
      convId, title: conv.title || '',
    });
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
    const r = await window.autobot.testProvider(provider);
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

  // ---- Slash commands (client-side quick actions) ----
  const runSlashCommand = (cmd) => {
    switch (cmd) {
      case 'help':
        appendAssistant('Slash commands:\n`/help` — this help\n`/clear` — clear current conversation\n`/compact` — summarize then clear\n`/model` — open provider settings\n`/review` — review note\n`/memory` — open memory panel\n`/reset` — clear memory + conversations\n`/status` — show provider/model/tool status\n`/notebooks` — open notebooks\n`/terminal` — open terminal');
        break;
      case 'clear':
        clearActiveConversation();
        break;
      case 'compact':
        appendAssistant('⚠️ `/compact` — summarizing then clearing. (Full context compaction runs automatically on the next turn.)');
        break;
      case 'model':
        setShowSettings(true);
        break;
      case 'review':
        appendAssistant('Review note: recent changes are tracked in the Artifacts panel. Open Artifacts to inspect code produced this session.');
        break;
      case 'memory':
        setPanel('memory');
        break;
      case 'reset':
        clearMemory();
        setConvs([]);
        setActiveId(null);
        setLive(null);
        setError('Reset complete.');
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
      default:
        appendAssistant('Unknown slash command: `/' + cmd + '`');
    }
  };

  const appendAssistant = (content) => {
    const msg = { id: uid(), role: 'assistant', content, ts: Date.now() };
    const id = activeIdRef.current;
    if (!id) {
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
    setLive(null);
  };

  const artifacts = useMemo(() => {
    const blocks = [];
    for (const m of messages) if (m.role === 'assistant') blocks.push(...extractCodeBlocks(m.content));
    if (live) blocks.push(...extractCodeBlocks(live.content));
    for (const a of artifactsExplicit) blocks.push({ lang: a.language || 'text', code: a.content, label: a.name });
    return blocks;
  }, [messages, live, artifactsExplicit]);

  return (
    <div className="app" data-theme={settings.theme} dir={localeDir(settings.locale)} lang={settings.locale}>
      <div className="titlebar"><Logo size={16} /><span className="brand">Helio Bot</span><span className="sub">{T('brand.sub')}</span></div>

      <div className="layout">
        {/* Sidebar — Claude parity: wordmark / search / collapse, New chat, Recents, Tools, account+settings */}
        <aside className={'sidebar' + (sidebarCollapsed ? ' collapsed' : '')}>
          <div className="sidebar-head">
            <div className="wordmark"><Logo size={18} /><span className="brand">Helio Bot</span></div>
            <div className="sidebar-actions">
              <button className="icon-btn" title={T('sidebar.search')} onClick={() => setShowSearch(true)}><Icon name="Search" size={17} /></button>
              <button className="icon-btn" title={sidebarCollapsed ? T('sidebar.expand') : T('sidebar.collapse')} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
                <Icon name={sidebarCollapsed ? 'SidebarOpen' : 'SidebarClose'} size={17} />
              </button>
            </div>
          </div>

          <button className="newchat" onClick={newChat}><Icon name="Add" size={16} /><span className="label">{T('sidebar.newChat')}</span></button>

          <div className="sidebar-scroll">
            <div className="section-label">{T('sidebar.recents')}</div>
            <div className="convlist">
              {convs.map((c) => (
                <div key={c.id} className={'conv ' + (c.id === activeId && panel === 'chats' ? 'on' : '')} onClick={() => selectConv(c.id)}>
                  <Icon name="Chat" size={15} className="conv-ico" />
                  <div className="conv-title">{c.title || 'Untitled'}</div>
                  <button className="conv-del" onClick={(e) => { e.stopPropagation(); deleteConv(c.id); }}><Icon name="Trash" size={13} /></button>
                </div>
              ))}
              {convs.length === 0 && <div className="muted">No conversations yet</div>}
            </div>

            <div className="section-label">{T('sidebar.tools')}</div>
            <nav className="sidenav">
              <button className={panel === 'artifacts' ? 'on' : ''} onClick={() => setPanel('artifacts')}><Icon name="Artifacts" size={15} /><span className="label">{T('sidebar.artifacts')}</span><span className="count">{artifacts.length}</span></button>
              <button className={panel === 'memory' ? 'on' : ''} onClick={() => setPanel('memory')}><Icon name="Memory" size={15} /><span className="label">{T('sidebar.memory')}</span><span className="count">{memory.length}</span></button>
              <button className={panel === 'skills' ? 'on' : ''} onClick={() => setPanel('skills')}><Icon name="Lightbulb" size={15} /><span className="label">{T('sidebar.skills')}</span><span className="count">{skills.filter((s) => s.enabled !== false).length}</span></button>
              <button className={panel === 'projects' ? 'on' : ''} onClick={() => setPanel('projects')}><Icon name="Folder" size={15} /><span className="label">{T('sidebar.projects')}</span><span className="count">{projects.length}</span></button>
              <button className={panel === 'plugins' ? 'on' : ''} onClick={() => setPanel('plugins')}><Icon name="Plugin" size={15} /><span className="label">{T('sidebar.plugins')}</span></button>
              <button className={panel === 'scheduled' ? 'on' : ''} onClick={() => setPanel('scheduled')}><Icon name="Clock" size={15} /><span className="label">{T('sidebar.scheduled')}</span></button>
              <button className={panel === 'notebooks' ? 'on' : ''} onClick={() => setPanel('notebooks')}><Icon name="Book" size={15} /><span className="label">{T('sidebar.notebooks')}</span></button>
              <button className={panel === 'mcp' ? 'on' : ''} onClick={() => setPanel('mcp')}><Icon name="Connectors" size={15} /><span className="label">{T('sidebar.mcp')}</span><span className="count">{mcpServers.length}</span></button>
              <button className={panel === 'terminal' ? 'on' : ''} onClick={() => setPanel('terminal')}><Icon name="CommandLine" size={15} /><span className="label">{T('sidebar.terminal')}</span></button>
              <button className={panel === 'code' ? 'on' : ''} onClick={() => setPanel('code')}><Icon name="Code" size={15} /><span className="label">{T('sidebar.code')}</span></button>
              <button className={sessionPane.type === 'browser' ? 'on' : ''} onClick={() => toggleSessionPane('browser')}><Icon name="Globe" size={15} /><span className="label">{T('sidebar.browser')}</span></button>
            </nav>
          </div>

          <div className="sidebar-foot">
            <button className="account-row" onClick={() => setShowSettings(true)}>
              <span className="avatar-dot">HB</span>
              <span className="account-name">Helio Bot</span>
            </button>
            <button className="icon-btn settings-icon" title={T('sidebar.settings')} onClick={() => setShowSettings(true)}><Icon name="Settings" size={17} /></button>
          </div>
        </aside>

        {/* Main */}
        <main className="main">
          <div className="main-split">
            <div className="main-content">
              {panel === 'chats' && <ChatView messages={messages} live={liveForActive} thinking={liveForActive ? thinking : ''} subAgents={subAgents} copyBlock={copyBlock} applyBlock={applyBlock} bottomRef={bottomRef} convId={activeId} copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage} conv={active} exportConv={exportConv} T={T} runStartedAt={runStartedAt} />}
              {panel === 'artifacts' && <ArtifactsView blocks={artifacts} />}
              {panel === 'memory' && <MemoryView memory={memory} addMemory={addMemory} clearMemory={clearMemory} />}
              {panel === 'skills' && <SkillsView skills={skills} toggleSkill={toggleSkill} setAllSkills={setAllSkills} refreshSkills={refreshSkills} />}
              {panel === 'notebooks' && <NotebooksView notebooks={notebooks} activeNotebook={activeNotebook} notebookCells={notebookCells} setNotebookCells={setNotebookCells} openNotebook={openNotebook} newNotebook={newNotebook} saveActiveNotebook={saveActiveNotebook} deleteActiveNotebook={deleteActiveNotebook} />}
              {panel === 'mcp' && <McpView mcpServers={mcpServers} mcpForm={mcpForm} setMcpForm={setMcpForm} connectMcp={connectMcp} disconnectMcp={disconnectMcp} />}
              {panel === 'terminal' && <TerminalView terminal={terminal} setTerminal={setTerminal} startTerminal={startTerminal} runInTerminal={runInTerminal} writeTerminal={writeTerminal} killTerminal={killTerminal} />}
              {panel === 'code' && <CodeView cwd={cwd} setCwd={setCwd} permissions={permissions} setPermissions={setPermissions} T={T} />}
              {panel === 'projects' && <ProjectsView projects={projects} setProjects={setProjects} activeProject={activeProject} setActiveProject={setActiveProject} />}
              {panel === 'plugins' && <PluginsView />}
              {panel === 'scheduled' && <ScheduledView />}
            </div>

            {sessionPane.type === 'browser' && (
              <SessionPane icon="Globe" title={T('sidebar.browser')} width={sessionPane.width} onWidth={(w) => setSessionPane((p) => ({ ...p, width: w }))} onHide={() => setSessionPane((p) => ({ ...p, type: null }))}>
                <BrowserView cwd={cwd} previewUrl={previewUrl} />
              </SessionPane>
            )}
          </div>

          {error && <div className="errorbar">{error}</div>}
          {notice && <div className="noticebar">{notice}</div>}

          <InputBar
            streaming={streaming} send={send} stop={stop} inputRef={inputRef} cwd={cwd} setCwd={setCwd} runSlashCommand={runSlashCommand}
            queued={queued.filter((q) => q.convId === activeId)} unqueue={unqueue} sendQueuedNow={sendQueuedNow}
            provider={provider} setProvider={setProvider} modelMenuOpen={modelMenuOpen} setModelMenuOpen={setModelMenuOpen} openSettings={() => setShowSettings(true)}
            providerKeys={providerKeys} setProviderKeys={setProviderKeys}
            attachments={attachments} setAttachments={setAttachments}
            reasoningLevel={reasoningLevel} setReasoningLevel={setReasoningLevel}
            styleId={styleId} setStyleId={setStyleId}
            webSearch={webSearch} setWebSearch={setWebSearch}
            dictating={dictating} setDictating={setDictating}
            voiceMode={voiceMode} startVoiceMode={startVoiceMode} stopVoiceMode={stopVoiceMode}
            sessionPane={sessionPane} toggleSessionPane={toggleSessionPane}
            permissions={permissions} setPermissions={setPermissions}
            T={T}
          />
        </main>
      </div>

      {showSettings && (
        <SettingsModal provider={provider} setProvider={setProvider} providerKeys={providerKeys} setProviderKeys={setProviderKeys} settings={settings} setSettings={setSettings} orchestrator={orchestrator} setOrchestrator={setOrchestrator} features={features} setFeatures={setFeatures} testProvider={testProvider} onClose={() => setShowSettings(false)} T={T} account={account} setAccount={setAccount} permissions={permissions} setPermissions={setPermissions} />
      )}

      {question && (
        <QuestionModal question={question} answer={answerQuestion} />
      )}

      {permission && (
        <PermissionModal permission={permission} answer={answerPermission} />
      )}

      {showSearch && (
        <SearchModal convs={convs} onOpen={(id) => { setShowSearch(false); selectConv(id); }} onClose={() => setShowSearch(false)} />
      )}

      {showPalette && (
        <CommandPalette
          onClose={() => setShowPalette(false)}
          onNewChat={newChat}
          onSearch={() => { setShowPalette(false); setShowSearch(true); }}
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

// Turn a raw tool call into the human line Claude shows ("Writing index.html").
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
    case 'Task': return { verb: 'Delegating', target: String(a.description || a.prompt || '').slice(0, 60), icon: 'Sparkles' };
    case 'AskUser': case 'exitPlanMode': return { verb: 'Waiting on you', target: '', icon: 'Clock' };
    default: return { verb: String(name || 'Working'), target: base(a.path || a.file_path || ''), icon: 'Wrench' };
  }
}

// One-line "what the agent is doing right now" banner above the reply.
function RunActivity({ live, thinking, startedAt }) {
  const now = useTicker(Boolean(live), 500);
  const tools = (live && live.tools) || [];
  const segments = (live && live.segments) || [];
  const running = tools.find((t) => t.status === 'running');
  // Plan/approval tools are bookkeeping — the banner says "Working 5 steps"
  // forever if we let TodoWrite win. Prefer real work, then the current phase.
  const work = tools.filter((t) => t.name !== 'TodoWrite' && t.name !== 'exitPlanMode');
  const last = running || work[work.length - 1] || null;
  const lastSeg = segments[segments.length - 1];
  let label = 'Thinking';
  let target = '';
  if (running) {
    const d = describeTool(running.name, running.args);
    label = d.verb + '…';
    target = d.target;
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
      <span className="activity-spin"><Icon name="Spinner" size={13} /></span>
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

// Helio Bot sunburst mark (user-supplied SVG), scaled to any size.
function Logo({ size = 20 }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 240 240" xmlns="http://www.w3.org/2000/svg" aria-label="Helio Bot">
      <rect width="240" height="240" rx="54" fill="#F6F3EC" />
      <rect x="2" y="2" width="236" height="236" rx="52" stroke="#E8E2D5" strokeWidth="2" />
      <g transform="translate(120, 120)">
        <path d="M 0 -76 C 4 -76, 7 -32, 4 -12 C 1 -6, -1 -6, -4 -12 C -7 -32, -4 -76, 0 -76 Z" fill="#D97757" transform="rotate(-4)" />
        <path d="M 0 78 C 4 78, 7 34, 4 13 C 1 7, -1 7, -4 13 C -7 34, -4 78, 0 78 Z" fill="#D97757" transform="rotate(2)" />
        <path d="M 0 -74 C 4 -74, 6 -30, 3 -11 C 1 -6, -1 -6, -3 -11 C -6 -30, -4 -74, 0 -74 Z" fill="#D97757" transform="rotate(42)" />
        <path d="M 0 75 C 4 75, 6 31, 3 12 C 1 6, -1 6, -3 12 C -6 31, -4 75, 0 75 Z" fill="#D97757" transform="rotate(46)" />
        <path d="M 0 -77 C 4 -77, 7 -33, 4 -12 C 1 -6, -1 -6, -4 -12 C -7 -33, -4 -77, 0 -77 Z" fill="#D97757" transform="rotate(88)" />
        <path d="M 0 74 C 4 74, 6 30, 3 11 C 1 6, -1 6, -3 11 C -6 30, -4 74, 0 74 Z" fill="#D97757" transform="rotate(93)" />
        <path d="M 0 -72 C 3.5 -72, 6 -28, 3 -11 C 1 -6, -1 -6, -3 -11 C -6 -28, -3.5 -72, 0 -72 Z" fill="#D97757" transform="rotate(134)" />
        <path d="M 0 76 C 4 76, 6.5 32, 3.5 12 C 1 6, -1 6, -3.5 12 C -6.5 32, -4 76, 0 76 Z" fill="#D97757" transform="rotate(137)" />
        <path d="M 0 -54 C 2.5 -54, 4 -22, 2 -9 C 0.5 -5, -0.5 -5, -2 -9 C -4 -22, -2.5 -54, 0 -54 Z" fill="#E3967B" transform="rotate(20)" />
        <path d="M 0 -52 C 2.5 -52, 4 -20, 2 -9 C 0.5 -5, -0.5 -5, -2 -9 C -4 -20, -2.5 -52, 0 -52 Z" fill="#E3967B" transform="rotate(112)" />
        <path d="M 0 55 C 2.5 55, 4 23, 2 9 C 0.5 5, -0.5 5, -2 9 C -4 23, -2.5 55, 0 55 Z" fill="#E3967B" transform="rotate(22)" />
        <path d="M 0 50 C 2.5 50, 4 20, 2 9 C 0.5 5, -0.5 5, -2 9 C -4 20, -2.5 50, 0 50 Z" fill="#E3967B" transform="rotate(110)" />
        <circle cx="0" cy="0" r="8" fill="#D97757" />
      </g>
    </svg>
  );
}

// ---------- Conversation export / share ----------
// Claude Desktop's "Share chat" publishes a public link; Helio Bot has no backend, so
// the local equivalent is a self-contained HTML share file (open in any browser, no
// server) plus Markdown/JSON export. All three route through the renderer and land in
// a native save dialog via `autobot:saveFile`.
function convToMarkdown(conv) {
  const title = conv.title || 'Untitled conversation';
  const lines = ['# ' + title, ''];
  const ts = new Date(conv.ts || Date.now()).toISOString();
  lines.push('> Exported from Helio Bot — ' + ts, '');
  for (const m of conv.messages || []) {
    const who = m.role === 'user' ? '**You**' : '**Helio Bot**';
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
    const role = m.role === 'user' ? 'You' : 'Helio Bot';
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
.msg.assistant{background:#fbfbf9} .role{font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#b45309;margin-bottom:8px}
.msg.user .role{color:#0b5fff} .content pre{background:#f0f0ee;padding:12px;border-radius:8px;overflow:auto}
.content img{max-width:100%} .att{color:#666;font-size:13px;margin-top:6px} img.att{max-width:100%;border-radius:8px;margin-top:8px}
</style></head><body><h1>${title}</h1><div class="meta">Exported from Helio Bot — ${ts}</div>${body}</body></html>`;
}

// ---------- Chat view ----------
function ChatView({ messages, live, thinking, subAgents, copyBlock, applyBlock, bottomRef, convId, copyMessage, editMessage, deleteMessage, retryMessage, conv, exportConv, T, runStartedAt }) {
  return (
    <div className="chat" onClick={(e) => { copyBlock(e); applyBlock(e); }}>
      {conv && (
        <div className="conv-toolbar">
          <div className="conv-toolbar-title">{conv.title || 'Untitled'}</div>
          <ExportMenu conv={conv} exportConv={exportConv} T={T} />
        </div>
      )}
      {messages.length === 0 && !live && (
        <div className="welcome">
          <Logo size={56} />
          <h1>{timeGreeting()}</h1>
          <p className="muted">{T('welcome.prompt')}</p>
        </div>
      )}
      {messages.map((m, i) => <Message key={m.id} m={m} convId={convId} idx={i} copyMessage={copyMessage} editMessage={editMessage} deleteMessage={deleteMessage} retryMessage={retryMessage} />)}
      {subAgents.length > 0 && (
        <div className="subagents">
          {subAgents.map((a, i) => (
            <span key={i} className={'subagent ' + a.status}><Icon name={a.status === 'running' ? 'Clock' : 'Check'} size={12} /> {a.name}</span>
          ))}
        </div>
      )}
      {live && <div className="msg assistant">
        <div className="avatar avatar-assistant"><Logo size={20} /></div>
        <div className="body">
          <RunActivity live={live} thinking={thinking} startedAt={runStartedAt} />
          {live.segments && live.segments.length > 0 ? (
            <SegmentView segments={live.segments} tools={live.tools} streaming />
          ) : (
            <>
              {live.tools.length > 0 && (
                <div className="tools">
                  {live.tools.map((t) => <ToolCard key={t.id} t={t} />)}
                </div>
              )}
              {live.content ? <div className="md streaming" dangerouslySetInnerHTML={{ __html: renderMarkdown(live.content) + '<span class="cursor">▍</span>' }} /> : null}
            </>
          )}
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
// Claude's transcript carries the model's reasoning as a collapsible block you
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
      return <div className="tools" key={'seg-t-' + i}>{rows.map((t) => <ToolCard key={t.id} t={t} />)}</div>;
    }
    const txt = s.text || '';
    if (!txt.trim()) return null;
    const caret = streaming && i === lastIdx ? '<span class="cursor">▍</span>' : '';
    return <div className={'md' + (streaming ? ' streaming' : '')} key={'seg-m-' + i} dangerouslySetInnerHTML={{ __html: renderMarkdown(txt) + caret }} />;
  });
}

function Message({ m, convId, idx, copyMessage, editMessage, deleteMessage, retryMessage }) {
  const [copied, setCopied] = useState(false);
  const doCopy = () => { copyMessage(m); setCopied(true); setTimeout(() => setCopied(false), 1200); };
  const images = (m.attachments || []).filter((a) => a.isImage && a.dataUrl);
  const otherAtts = (m.attachments || []).filter((a) => !(a.isImage && a.dataUrl));
  return (
    <div className={'msg ' + m.role}>
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
                {m.tools.map((t) => <ToolCard key={t.id} t={t} />)}
              </div>
            )}
            <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.content) }} />
          </>
        )}
        {m.role === 'assistant' && m.durationMs > 800 && (
          <div className="worked-for"><Icon name="Clock" size={12} /> Worked for {fmtElapsed(m.durationMs)}</div>
        )}
      </div>
      <div className="msg-toolbar">
        <button className="icon-btn" title={copied ? 'Copied' : 'Copy'} onClick={doCopy}><Icon name={copied ? 'Check' : 'Copy'} size={15} /></button>
        {m.role === 'user' && <button className="icon-btn" title="Edit" onClick={() => editMessage(m)}><Icon name="Edit" size={15} /></button>}
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

// Claude renders the agent's todo list as a live checklist; a raw
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

function ToolCard({ t }) {
  const todos = t.name === 'TodoWrite' && t.args && Array.isArray(t.args.todos) ? t.args.todos : null;
  const [open, setOpen] = useState(Boolean(todos && todos.length));
  const d = describeTool(t.name, t.args);
  let argStr = '';
  try { argStr = JSON.stringify(t.args || {}); } catch {}
  const status = t.status === 'error' ? 'error' : t.status === 'running' ? 'running' : 'done';
  return (
    <div className={'toolcard ' + status}>
      <div className="toolcard-head" onClick={() => setOpen(!open)}>
        <span className="tool-ico"><Icon name={d.icon} size={14} /></span>
        <span className="tool-name">{d.verb}</span>
        {d.target ? <span className="tool-args" title={argStr}>{d.target}</span> : <span className="tool-args" />}
        <span className="tool-state">
          {status === 'running' && <Icon name="Spinner" size={13} className="spin" />}
          {status === 'error' && <Icon name="Warning" size={13} />}
          {status === 'done' && <Icon name="Check" size={13} />}
        </span>
        <span className="caret"><Icon name={open ? 'CaretUp' : 'CaretRight'} size={11} /></span>
      </div>
      {open && todos && todos.length > 0 && <TodoList todos={todos} />}
      {open && !(todos && todos.length) && (t.result != null || argStr) && (
        <pre className="tool-result">{t.result != null ? String(t.result).slice(0, 4000) : argStr}</pre>
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
    import('mermaid')
      .then((mod) => {
        const mermaid = mod.default || mod;
        if (cancelled) return;
        mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'strict' });
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

function ArtifactsView({ blocks }) {
  const [idx, setIdx] = useState(0);
  const [mode, setMode] = useState('preview'); // 'preview' | 'code'
  const block = blocks[idx];
  let highlighted = '';
  if (block) {
    try {
      highlighted = block.lang && hljs.getLanguage(block.lang) ? hljs.highlight(block.code, { language: block.lang }).value : hljs.highlightAuto(block.code).value;
    } catch {}
  }
  const canPreview = block && ['html', 'htm', 'xml', 'svg', 'mermaid', 'react', 'jsx', 'js', 'markdown', 'md', 'text', 'txt'].includes((block.lang || 'text').toLowerCase().trim());
  return (
    <div className="panel artifacts">
      <h2>Artifacts</h2>
      {blocks.length === 0 && <p className="muted">No code artifacts yet. Ask Helio Bot to write code and it will appear here.</p>}
      {blocks.length > 0 && (
        <>
          <div className="artifact-tabs">
            {blocks.map((b, i) => (
              <button key={i} className={i === idx ? 'on' : ''} onClick={() => { setIdx(i); setMode('preview'); }}>{b.label || b.lang} #{i + 1}</button>
            ))}
          </div>
          {block && (
            <div className="artifact-body">
              <div className="artifact-toolbar">
                <div className="codeblock-head"><span>{block.lang}</span></div>
                <div className="artifact-toggle">
                  <button className={mode === 'preview' ? 'on' : ''} onClick={() => setMode('preview')} disabled={!canPreview}>Preview</button>
                  <button className={mode === 'code' ? 'on' : ''} onClick={() => setMode('code')}>Code</button>
                  <button className="copy-btn" data-code={encodeURIComponent(block.code)} onClick={(e) => { const btn = e.currentTarget; const c = decodeURIComponent(btn.dataset.code || ''); navigator.clipboard?.writeText(c).then(() => { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200); }); }}>Copy</button>
                  <button onClick={() => window.autobot.openArtifactWindow({ name: block.label || block.lang, language: block.lang, content: block.code })}>Open</button>
                  <button onClick={() => window.autobot.printToPdf({ defaultName: (block.label || 'artifact').replace(/[^\w.-]+/g, '_') + '.pdf', html: ['html', 'htm', 'svg'].includes((block.lang || '').toLowerCase()) ? block.code : undefined, content: block.code })}>PDF</button>
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

// ---------- Memory ----------
function MemoryView({ memory, addMemory, clearMemory }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Long-term memory</h2>
        <div><button onClick={addMemory}>+ Add</button> <button onClick={clearMemory}>Clear</button></div>
      </div>
      {memory.length === 0 && <p className="muted">Memory is empty. Use the "memory_add" tool in chat, or add a note here.</p>}
      {memory.map((e, i) => (
        <div key={i} className="memitem">
          <div className="mem-ts">{new Date(e.ts).toLocaleString()}</div>
          <div>{e.content}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- Skills ----------
const SKILL_SOURCE_LABELS = { bundled: 'Claude', opencode: 'OpenCode', claude: 'Claude Skills', custom: 'Custom' };
const SKILL_SOURCE_ORDER = ['bundled', 'opencode', 'claude', 'custom'];

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

// ---------- Plugins & Connectors (Claude Desktop parity: directory + install) ----------
function PluginsView() {
  const [items, setItems] = useState([]);
  const [cats, setCats] = useState([]);
  const [q, setQ] = useState('');
  const [type, setType] = useState('all');
  const [cat, setCat] = useState('all');
  const [installedOnly, setInstalledOnly] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const refresh = useCallback(async () => {
    const opts = {};
    if (type !== 'all') opts.type = type;
    if (cat !== 'all') opts.category = cat;
    if (installedOnly) opts.installedOnly = true;
    const query = q.trim();
    const list = query
      ? await window.autobot.searchPlugins(query, { ...opts, limit: 200 })
      : await window.autobot.listPlugins(opts);
    setItems(Array.isArray(list) ? list : []);
  }, [q, type, cat, installedOnly]);

  useEffect(() => { window.autobot.pluginCategories().then((c) => setCats(Array.isArray(c) ? c : [])); }, []);
  useEffect(() => { refresh(); }, [refresh]);

  const setInstalled = async (id, on) => {
    setErr('');
    setBusy(true);
    try {
      const r = on ? await window.autobot.installPlugin(id) : await window.autobot.uninstallPlugin(id);
      if (r && r.ok === false) setErr(r.error);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const installedCount = items.filter((i) => i.installed).length;

  return (
    <div className="panel plugins-panel">
      <div className="panel-head">
        <h2>Plugins &amp; Connectors</h2>
        <span className="muted">{installedCount} installed · {items.length} shown</span>
      </div>
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

      {err && <p className="form-error">{err}</p>}
      {items.length === 0 && <p className="muted">No plugins or connectors match.</p>}

      <div className="plugin-grid">
        {items.map((it) => (
          <div key={it.id} className={'plugin-card' + (it.installed ? ' installed' : '')}>
            <div className="plugin-card-head">
              <div>
                <b>{it.name}</b>
                <span className="skill-src">{it.category} · {it.type}</span>
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
              {it.installed && it.requiresSignIn && <span className="badge warn">needs sign-in</span>}
              {it.installed && !it.requiresSignIn && <span className="badge ok">installed</span>}
            </div>
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

// ---------- Projects (Claude Desktop parity: bundled custom instructions) ----------
function ProjectsView({ projects, setProjects, activeProject, setActiveProject }) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');

  const createProject = () => {
    const n = name.trim();
    if (!n) return;
    setProjects((ps) => [...ps, { id: uid(), name: n, instructions: instructions.trim(), ts: Date.now() }]);
    setName(''); setInstructions('');
  };
  const deleteProject = (id) => {
    setProjects((ps) => ps.filter((p) => p.id !== id));
    if (activeProject === id) setActiveProject(null);
  };
  const toggleProject = (id) => setActiveProject((cur) => (cur === id ? null : id));
  const updateInstructions = (id, val) => setProjects((ps) => ps.map((p) => (p.id === id ? { ...p, instructions: val } : p)));

  return (
    <div className="panel">
      <h2>Projects</h2>
      <p className="muted">Projects bundle custom instructions that are automatically injected into every message while a project is active (toggle a project to activate it).</p>
      <div className="project-new">
        <input placeholder="Project name" value={name} onChange={(e) => setName(e.target.value)} />
        <textarea placeholder="Custom instructions (injected into the system prompt)…" rows={3} value={instructions} onChange={(e) => setInstructions(e.target.value)} />
        <button onClick={createProject} disabled={!name.trim()}>Create project</button>
      </div>
      {projects.map((p) => (
        <div key={p.id} className={'projectitem' + (activeProject === p.id ? ' active' : '')}>
          <div className="projectitem-head">
            <button className="project-toggle" onClick={() => toggleProject(p.id)} title={activeProject === p.id ? 'Active — click to deactivate' : 'Click to activate'}>
              <Icon name={activeProject === p.id ? 'Check' : 'Folder'} size={15} /> {p.name}
            </button>
            <button className="icon-btn" onClick={() => deleteProject(p.id)}><Icon name="Trash" size={13} /></button>
          </div>
          <textarea rows={2} placeholder="Instructions…" value={p.instructions} onChange={(e) => updateInstructions(p.id, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

// ---------- MCP ----------
function McpView({ mcpServers, mcpForm, setMcpForm, connectMcp, disconnectMcp }) {
  const transport = mcpForm.transport || 'stdio';
  return (
    <div className="panel">
      <h2>MCP Servers</h2>
      <p className="muted">Connect external Model Context Protocol servers over stdio, SSE, or streamable-HTTP. Their tools become available to Helio Bot automatically.</p>
      <div className="mcp-form">
        <select value={transport} onChange={(e) => setMcpForm({ ...mcpForm, transport: e.target.value })}>
          <option value="stdio">stdio</option>
          <option value="sse">sse</option>
          <option value="http">streamable-http</option>
        </select>
        {transport === 'stdio' ? (
          <>
            <input placeholder="command (e.g. npx -y @modelcontextprotocol/server-filesystem)" value={mcpForm.command} onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value })} />
            <input placeholder="args (space-separated)" value={mcpForm.args} onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value })} />
          </>
        ) : (
          <input placeholder="URL (e.g. https://host/mcp or /sse)" value={mcpForm.url} onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value })} />
        )}
        <button onClick={connectMcp}>Connect</button>
      </div>
      {mcpServers.map((s) => (
        <div key={s.serverId} className="mcpserver">
          <div className="mcpserver-head"><b>{s.name}</b><button onClick={() => disconnectMcp(s.serverId)}>Disconnect</button></div>
          <div className="tools">{s.tools.map((t) => <span key={t.name} className="toolchip" title={t.description}>{t.name}</span>)}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- Notebooks ----------
function NotebooksView({ notebooks, activeNotebook, notebookCells, setNotebookCells, openNotebook, newNotebook, saveActiveNotebook, deleteActiveNotebook }) {
  return (
    <div className="panel">
      <div className="panel-head"><h2>Notebooks</h2>
        <div><button onClick={newNotebook}>+ New</button> <button onClick={saveActiveNotebook} disabled={!activeNotebook}>Save</button> <button onClick={deleteActiveNotebook} disabled={!activeNotebook}>Delete</button></div>
      </div>
      <div className="notebook-layout">
        <div className="notebook-list">
          {notebooks.length === 0 && <p className="muted">No notebooks yet.</p>}
          {notebooks.map((n) => (
            <button key={n} className={'notebook-item ' + (n === activeNotebook ? 'on' : '')} onClick={() => openNotebook(n)}>{n}</button>
          ))}
        </div>
        <div className="notebook-editor">
          {!activeNotebook && <p className="muted">Select or create a notebook to edit cells.</p>}
          {activeNotebook && (
            <>
              <h3>{activeNotebook}</h3>
              {notebookCells.map((c, i) => (
                <div key={i} className="nbcell">
                  <div className="nbcell-head">
                    <input className="nblang" value={c.language || ''} placeholder="language (e.g. js, py, md)" onChange={(e) => setNotebookCells((cs) => cs.map((x, j) => (j === i ? { ...x, language: e.target.value } : x)))} />
                  </div>
                  <textarea className="nbsrc" value={c.source || ''} placeholder="cell source…" onChange={(e) => setNotebookCells((cs) => cs.map((x, j) => (j === i ? { ...x, source: e.target.value } : x)))} />
                </div>
              ))}
              <button className="nbadd" onClick={() => setNotebookCells((cs) => [...cs, { language: 'md', source: '' }])}>+ Add cell</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

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

function BrowserView({ cwd, previewUrl }) {
  // `launch` is the URL handed to <webview src> at mount and never changes afterwards.
  // `url` tracks the live location. Keeping src stable stops React from re-issuing a
  // navigation on every did-navigate (which aborted and duplicated in-flight loads).
  const [tabs, setTabs] = useState([{ id: 'tab1', launch: 'https://www.google.com', url: 'https://www.google.com', title: 'New Tab', loading: false }]);
  const [activeId, setActiveId] = useState('tab1');
  const [omnibox, setOmnibox] = useState('');
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [findRes, setFindRes] = useState(null); // {active, total}
  const webviews = useRef({});
  const omniboxRef = useRef(null);
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;

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
    setTabs((ts) => {
      if (ts.length <= 1) return [{ id: 'tab' + nextTabNum.current++, launch: 'https://www.google.com', url: 'https://www.google.com', title: 'New Tab', loading: false }];
      return ts.filter((t) => t.id !== id);
    });
    if (activeId === id) {
      const remaining = tabs.filter((t) => t.id !== id);
      setActiveId(remaining.length ? remaining[0].id : 'tab1');
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

  const bindWebview = (id) => (el) => {
    if (!el || webviews.current[id]) return;
    webviews.current[id] = el;
    const isActive = () => activeIdRef.current === id;
    el.addEventListener('did-start-loading', () => patchTab(id, { loading: true }));
    el.addEventListener('did-stop-loading', () => patchTab(id, { loading: false }));
    el.addEventListener('did-navigate', (e) => { patchTab(id, { url: e.url }); if (isActive()) setOmnibox(e.url); });
    el.addEventListener('did-navigate-in-page', (e) => { patchTab(id, { url: e.url }); if (isActive()) setOmnibox(e.url); });
    el.addEventListener('page-title-updated', (e) => patchTab(id, { title: e.title || 'Untitled' }));
    el.addEventListener('did-fail-load', (e) => { if (e.errorCode !== -3) patchTab(id, { loading: false }); });
    el.addEventListener('dom-ready', () => {
      try { const wid = el.getWebContentsId(); if (wid) window.autobot.browserRegister(wid); } catch {}
      try { const u = el.getURL(); patchTab(id, { url: u }); if (isActive()) setOmnibox(u); } catch {}
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

  return (
    <div className="browser-panel">
      <div className="browser-tabs">
        {tabs.map((t) => (
          <div key={t.id} className={'browser-tab ' + (t.id === activeId ? 'on' : '')} onClick={() => selectTab(t.id)} title={t.url}>
            {t.loading ? <Icon name="Spinner" size={12} className="spin" /> : <Icon name="Globe" size={12} />}
            <span className="browser-tab-title">{t.title || 'New Tab'}</span>
            <button className="browser-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}><Icon name="X" size={11} /></button>
          </div>
        ))}
        <button className="browser-tab-add" onClick={() => openTab()} title="New tab"><Icon name="Add" size={14} /></button>
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
        <button className={'icon-btn' + (findOpen ? ' on' : '')} onClick={() => setFindOpen(!findOpen)} title="Find in page"><Icon name="Search" size={15} /></button>
        <button className="icon-btn" onClick={openTab} title="New tab"><Icon name="Add" size={15} /></button>
      </div>

      {findOpen && (
        <div className="browser-find">
          <input autoFocus value={findText} onChange={(e) => runFind(e.target.value)} placeholder="Find in page…" />
          <span className="find-res">{findRes ? `${findRes.active}/${findRes.total}` : ''}</span>
          <button className="icon-btn" onClick={() => runFind('')}><Icon name="X" size={13} /></button>
        </div>
      )}

      <div className="browser-stage">
        {tabs.map((t) => (
          <webview
            key={t.id}
            ref={bindWebview(t.id)}
            className="browser-webview"
            style={{ display: t.id === activeId ? 'flex' : 'none' }}
            src={t.launch || t.url}
            partition="persist:autobot"
          />
        ))}
      </div>
    </div>
  );
}

// ---------- Session pane (Claude parity: coexisting resizable pane toggled via dispatchToggleSessionPane) ----------
function SessionPane({ icon, title, width, onWidth, onHide, children }) {
  const dragRef = useRef(null);
  const startX = useRef(0);
  const startW = useRef(0);

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

  return (
    <div className="session-pane" style={{ width }}>
      <div ref={dragRef} className="session-pane-divider" onMouseDown={onDragStart} title="Drag to resize" />
      <div className="session-pane-head">
        <Icon name={icon} size={15} />
        <span className="session-pane-title">{title}</span>
        <button className="icon-btn session-pane-hide" onClick={onHide} title={'Hide ' + title}><Icon name="X" size={15} /></button>
      </div>
      <div className="session-pane-body">{children}</div>
    </div>
  );
}

// ---------- Input bar (composer) — Claude parity: model-selector pill bottom-left, attach + style + think + send right ----------
const PERM_MODES = [
  { id: 'auto',        title: 'perm.auto',        desc: 'perm.autoDesc',        icon: 'LockOpen' },
  { id: 'ask',         title: 'perm.manual',      desc: 'perm.manualDesc',      icon: 'LockShield' },
  { id: 'acceptEdits', title: 'perm.acceptEdits', desc: 'perm.acceptEditsDesc', icon: 'Lock' },
  { id: 'plan',        title: 'perm.plan',        desc: 'perm.planDesc',        icon: 'Sliders' },
  { id: 'bypass',      title: 'perm.bypass',      desc: 'perm.bypassDesc',      icon: 'Keyboard' },
];
const PERM_SHORT = { auto: 'perm.auto', ask: 'perm.manual', acceptEdits: 'perm.acceptEdits', plan: 'perm.plan', bypass: 'perm.bypass' };

function InputBar({ streaming, send, stop, inputRef, cwd, setCwd, runSlashCommand, provider, setProvider, providerKeys, setProviderKeys, modelMenuOpen, setModelMenuOpen, openSettings, attachments, setAttachments, reasoningLevel, setReasoningLevel, styleId, setStyleId, webSearch, setWebSearch, dictating, setDictating, voiceMode, startVoiceMode, stopVoiceMode, sessionPane, toggleSessionPane, permissions, setPermissions, queued, unqueue, sendQueuedNow, T }) {
  const [styleOpen, setStyleOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [permOpen, setPermOpen] = useState(false);
  // Tracks whether the composer holds text so that, while a reply is streaming,
  // the send arrow can appear alongside the stop button (Claude parity: type a
  // follow-up mid-stream and the arrow queues it instead of being lost).
  const [hasText, setHasText] = useState(() => !!((inputRef.current && inputRef.current.value) || '').trim());
  const permWrapRef = useRef(null);
  const [keyStatus, setKeyStatus] = useState(() => loadJSON('autobot:keyStatus', {}));
  const [keyProbing, setKeyProbing] = useState(false);
  // Local model discovery: an Ollama box only runs the models that were pulled,
  // so the preset's hard-coded `llama3.1` pointed at a model that often does not
  // exist (404 → "cannot use"), and nothing else ever showed up in the picker.
  const [ollama, setOllama] = useState({});
  const [ollamaBusy, setOllamaBusy] = useState(false);

  const scanOllama = useCallback(async () => {
    const bases = new Set();
    for (const p of PRESETS) {
      const b = normBase(p.baseURL);
      if (b && LOCAL_BASE.test(b)) bases.add(b);
    }
    const activeBase = normBase(provider.baseURL);
    if (activeBase && LOCAL_BASE.test(activeBase)) bases.add(activeBase);
    if (!bases.size) return {};
    const found = {};
    for (const b of bases) {
      const res = await Promise.resolve(window.autobot.ollamaModels(b)).catch(() => null);
      if (res) found[b] = res;
    }
    setOllama((prev) => ({ ...prev, ...found }));
    return found;
  }, [provider.baseURL]);

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
    const base = normBase(p.baseURL);
    const map = providerKeys || {};
    return p.apiKey || map[base] || PRESET_KEYS[base] || (base && base === normBase(provider.baseURL) ? provider.apiKey : '') || '';
  }, [providerKeys, provider.baseURL, provider.apiKey]);

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
      if (statusOf(keyStatus, base, apiKey)) continue; // fresh verdict already cached
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
    return () => { cancelled = true; };
  }, [modelMenuOpen, keyFor, keyStatus]);

  // The composer pill mirrors the active endpoint, so probe it once on load too.
  useEffect(() => {
    if (modelMenuOpen) return;
    const base = normBase(provider.baseURL);
    if (!base) return;
    const apiKey = providerKeys[base] || PRESET_KEYS[base] || provider.apiKey || '';
    if (!apiKey && !LOCAL_BASE.test(base)) return;
    if (statusOf(keyStatus, base, apiKey)) return;
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
  }, [provider.baseURL, provider.apiKey, providerKeys, modelMenuOpen, keyStatus]);

  const activeBase = normBase(provider.baseURL);
  const activeKey = providerKeys[activeBase] || PRESET_KEYS[activeBase] || provider.apiKey || '';
  const activeKeyState = statusOf(keyStatus, activeBase, activeKey);
  const activeDot = activeKeyState ? (activeKeyState.state === 'ok' ? 'ok' : (activeKeyState.state === 'out' || activeKeyState.state === 'badkey') ? 'out' : null) : null;
  const modelMenuRef = useRef(null);

  // What the picker lists: every preset, except a reachable Ollama preset, which
  // expands into one row per model the server actually reports.
  const pickerRows = [];
  for (const p of PRESETS) {
    const base = normBase(p.baseURL);
    const scan = ollama[base];
    if (scan && scan.ok && scan.models && scan.models.length) {
      for (const m of scan.models) {
        pickerRows.push({
          key: base + '|' + m.name,
          preset: p,
          model: m.name,
          label: m.name.split('/').pop().replace(/:latest$/, ''),
          prov: p.name.replace(/\s*\(.*\)$/, '') + ' · installed',
          local: true,
        });
      }
      continue;
    }
    pickerRows.push({ key: p.name, preset: p, model: p.model, label: (p.model || 'custom').split('/').pop(), prov: p.name });
  }
  const ollamaEmpty = PRESETS.some((p) => {
    const b = normBase(p.baseURL);
    return /:11434\b/.test(b) && ollama[b] && !(ollama[b].ok && ollama[b].models && ollama[b].models.length);
  });

  // Claude parity: opening the picker scrolls the current model into view.
  useEffect(() => {
    if (!modelMenuOpen) return;
    const el = modelMenuRef.current && modelMenuRef.current.querySelector('.model-opt.on');
    if (el) el.scrollIntoView({ block: 'center' });
  }, [modelMenuOpen]);

  // Permissions dropdown: outside-click dismiss + 1..5 shortcut selection (Claude parity)
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
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = (inputRef.current?.value || '').trim();
      if (text.startsWith('/')) {
        const cmd = text.slice(1).trim().toLowerCase().split(/\s+/)[0];
        inputRef.current.value = '';
        setHasText(false);
        runSlashCommand(cmd);
      } else {
        send();
        setHasText(false);
      }
    }
  };

  const pickModel = (p, model) => {
    const base = normBase(p.baseURL);
    const key = keyFor(p);
    setProvider((v) => ({ ...v, baseURL: p.baseURL, model: model || p.model, apiKey: key, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto' }));
    if (key && base) setProviderKeys((m) => ({ ...(m || {}), [base]: key }));
    setModelMenuOpen(false);
  };

  // Unconfigured preset → preload it and jump straight to the key field.
  const configurePreset = (p) => {
    setProvider((v) => ({ ...v, baseURL: p.baseURL, model: p.model || v.model, apiKey: keyFor(p), supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto' }));
    setModelMenuOpen(false);
    openSettings();
  };

  const attachFiles = async () => {
    const files = await window.autobot.pickFiles();
    if (files && files.length) setAttachments((a) => [...a, ...files]);
  };
  const removeAttachment = (i) => setAttachments((a) => a.filter((_, j) => j !== i));

  const modelLabel = (provider.model || '').split('/').pop() || 'Select model';
  const activeStyle = STYLES.find((s) => s.id === styleId) || STYLES[0];

  return (
    <div className={'inputbar' + (dragOver ? ' drag-over' : '')} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={(e) => { e.preventDefault(); setDragOver(false); }} onDrop={onDropFiles}>
      <div className="cwdbar">
        <span className="cwd"><Icon name="Folder" size={13} /> {cwd || '~'}</span>
        <button className="cwd-pick" onClick={async () => { const d = await window.autobot.pickFolder(); if (d) { setCwd(d); const id = loadJSON('autobot:activeId', null); if (id) window.autobot.setWorkspace(id, d).catch(() => {}); } }}>Change</button>
      </div>

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

      {queued && queued.length > 0 && (
        <div className="queue-bar">
          <div className="queue-head">
            <span className="queue-label"><Icon name="Clock" size={12} /> Queued · {queued.length}</span>
            <button className="queue-sendnow" onClick={sendQueuedNow}>Send now</button>
          </div>
          <div className="queue-list">
            {queued.map((q) => {
              const label = (q.text || '').trim() || (q.atts && q.atts.length ? '📎 ' + q.atts.map((a) => a.name).join(', ') : '');
              return (
                <div key={q.id} className="queue-chip" title={label}>
                  <span className="queue-text">{label.slice(0, 120)}</span>
                  {q.atts && q.atts.length ? <span className="queue-count">{q.atts.length} file{q.atts.length > 1 ? 's' : ''}</span> : null}
                  <button className="queue-x" onClick={() => unqueue(q.id)} title="Remove queued message"><Icon name="X" size={11} /></button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="composer">
        <textarea ref={inputRef} rows={1} placeholder={T('composer.placeholder')} onKeyDown={onKey} onInput={(e) => setHasText(!!e.target.value.trim())} onPaste={onPasteFiles} />
        <div className="composer-foot">
          <div className="composer-actions">
            <button className="icon-btn attach-btn" title="Attach files" onClick={attachFiles}><Icon name="Attachment" size={17} /></button>

            {/* Style selector */}
            <div className="style-wrap">
              <button className={'icon-btn' + (styleId !== 'default' ? ' active' : '')} title={'Style: ' + activeStyle.name} onClick={() => setStyleOpen(!styleOpen)}>
                <Icon name="Styles" size={17} />
              </button>
              {styleOpen && (
                <div className="style-menu">
                  <div className="model-menu-head">Style</div>
                  {STYLES.map((s) => (
                    <button key={s.id} className={'model-opt' + (styleId === s.id ? ' on' : '')} onClick={() => { setStyleId(s.id); setStyleOpen(false); }}>
                      <span className="model-opt-name">{s.name}</span>
                      {s.hint && <span className="model-opt-prov">{s.hint}</span>}
                      {styleId === s.id && <Icon name="Check" size={13} className="model-check" />}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Reasoning / thinking level (Auto · Low · Medium · High) */}
            <label className={'reason-pick' + (reasoningLevel !== 'auto' ? ' active' : '')} title={'Reasoning / thinking level: ' + reasoningLevel}>
              <Icon name="ExtendedThinking" size={16} />
              <select value={reasoningLevel} onChange={(e) => setReasoningLevel(e.target.value)} aria-label="Reasoning level">
                <option value="auto">Auto</option>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>

            {/* Web search toggle */}
            <button className={'icon-btn' + (webSearch ? ' active' : '')} title={webSearch ? 'Web search: on' : 'Web search: off'} onClick={() => setWebSearch(!webSearch)}>
              <Icon name="Globe" size={17} />
            </button>

            {/* Built-in browser toggle — opens/closes the browser session pane */}
            <button className={'icon-btn' + (sessionPane && sessionPane.type === 'browser' ? ' active' : '')} title={sessionPane && sessionPane.type === 'browser' ? T('composer.browserClose') : T('composer.browser')} onClick={() => toggleSessionPane('browser')}>
              <Icon name="Window" size={17} />
            </button>

            {/* Voice dictation */}
            <button className={'icon-btn' + (dictating ? ' active' : '')} title={dictating ? 'Listening…' : 'Dictate'} onClick={() => toggleDictation(inputRef, setDictating)}>
              <Icon name="Microphone" size={17} />
            </button>

            {/* Voice Mode — full-duplex conversational loop */}
            <button className={'icon-btn' + (voiceMode ? ' active voice-on' : '')} title={voiceMode ? T('composer.voice') : T('composer.voice')} onClick={() => (voiceMode ? stopVoiceMode() : startVoiceMode())}>
              <Icon name="Voice" size={17} />
            </button>
          </div>

          <div className="composer-right">
            <div className="model-pill-wrap">
              <button className={'model-pill' + (modelMenuOpen ? ' open' : '')} onClick={() => setModelMenuOpen(!modelMenuOpen)} title="Change model">
                <Icon name="Agent" size={14} className="model-ico" />
                <span className="model-name">{modelLabel}</span>
                {activeDot && <span className={'model-dot ' + activeDot} title={activeKeyState.detail || ''} />}
                <Icon name={modelMenuOpen ? 'CaretUp' : 'CaretDown'} size={12} className="model-caret" />
              </button>
              {modelMenuOpen && (
                <div className="model-menu" ref={modelMenuRef}>
                  <div className="model-menu-head">Model · this session{keyProbing ? ' · checking keys…' : ''}</div>
                  {pickerRows.map((r) => {
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
                        title={r.local ? 'Local Ollama model — ' + r.model : (ollamaDown ? 'Ollama is not running — click to connect' : st.label)}
                        onClick={() => {
                          if (r.local) return pickModel(r.preset, r.model);
                          if (ollamaDown) return connectOllama();
                          if (st.row === 'dim') return configurePreset(r.preset);
                          return pickModel(r.preset, r.model);
                        }}
                      >
                        <span className={'model-dot ' + (r.local ? 'ok' : st.dot)} />
                        <span className="model-opt-name">{r.label}</span>
                        <span className="model-opt-prov">{ollamaDown ? 'click to connect' : r.prov}</span>
                        {active && <Icon name="Check" size={13} className="model-check" />}
                      </button>
                    );
                  })}
                  {ollamaEmpty && (
                    <button className="model-opt model-connect" disabled={ollamaBusy} onClick={connectOllama}>
                      <Icon name="Plug" size={14} />
                      <span className="model-opt-name">{ollamaBusy ? 'Connecting to Ollama…' : 'Connect Ollama (local)'}</span>
                      <span className="model-opt-prov">{ollamaBusy ? '' : 'starts the server'}</span>
                    </button>
                  )}
                  <div className="model-menu-divider" />
                  <button className="model-opt" onClick={() => { setModelMenuOpen(false); openSettings(); }}>
                    <Icon name="Settings" size={14} /><span className="model-opt-name">Manage providers…</span>
                  </button>
                </div>
              )}
            </div>

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

            {streaming && <button className="send stop" onClick={stop} title="Stop"><Icon name="Stop" size={16} /></button>}
            {(!streaming || hasText) && (
              <button
                className={'send' + (streaming ? ' queued' : '')}
                onClick={() => { send(); setHasText(false); }}
                title={streaming ? 'Queue message' : 'Send'}
              >
                <Icon name="ArrowUp" size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- Settings ----------
// ---------- Account & Billing (local equivalent of Claude's account/SSO/plan surface) ----------
// Honest scaffold: identity/SSO/plan/sync state is local (~/.autobot + localStorage); the
// OAuth and upgrade actions open the real Anthropic endpoints in the default browser. True
// cloud SSO/device-sync needs an account backend — documented as the residual B7 gap.
const ANTHROPIC_OAUTH_URL = 'https://claude.ai/login';
const ANTHROPIC_UPGRADE_URL = 'https://claude.ai/upgrade';

function AccountSection({ account, setAccount, T }) {
  const set = (patch) => setAccount((a) => ({ ...a, ...patch }));
  const setSSO = (k) => (e) => setAccount((a) => ({ ...a, sso: { ...a.sso, [k]: e.target.value } }));

  const signIn = () => {
    window.autobot.openExternal(ANTHROPIC_OAUTH_URL);
    set({ signedIn: true, authMethod: 'anthropic' });
  };
  const signOut = () => set({ signedIn: false, authMethod: null, email: '', sync: { ...account.sync, enabled: false, status: 'signed-out' } });
  const syncNow = () => setAccount((a) => ({ ...a, sync: { ...a.sync, lastSync: new Date().toISOString(), status: 'synced' } }));
  const importHistory = () => {
    // Local equivalent of "import Claude.ai history": open the export page in-browser.
    window.autobot.openExternal('https://claude.ai/settings/export');
    setAccount((a) => ({ ...a, sync: { ...a.sync, status: 'import-ready' } }));
  };
  const planLabel = (p) => (p === 'Pro' ? 'Pro' : p === 'Max' ? 'Max' : 'Free');

  return (
    <div className="account-section">
      <h3><Icon name="User" size={14} /> {T('account.title')}</h3>

      <div className="account-card">
        {account.signedIn ? (
          <>
            <div className="account-id">
              <div className="account-avatar"><Icon name="User" size={18} /></div>
              <div className="account-meta">
                <div className="account-email">{account.email || 'signed-in-user'}</div>
                <div className="account-plan">
                  <span className={'plan-badge plan-' + account.plan.toLowerCase()}>{planLabel(account.plan)}</span>
                  <span className="account-auth">{account.authMethod === 'sso' ? 'SSO' : 'Anthropic'}</span>
                </div>
              </div>
            </div>
            <div className="account-actions">
              <button onClick={() => window.autobot.openExternal(ANTHROPIC_UPGRADE_URL)}><Icon name="ArrowUp" size={13} /> {T('account.upgrade')}</button>
              <button onClick={signOut}><Icon name="Logout" size={13} /> {T('account.signOut')}</button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">{T('account.signedOut')} — {T('account.signIn.hint')}</p>
            <button className="primary" onClick={signIn}><Icon name="ArrowInSquare" size={14} /> {T('account.signIn')}</button>
          </>
        )}
      </div>

      {account.signedIn && (
        <label>{T('account.email')}<input value={account.email || ''} onChange={(e) => set({ email: e.target.value })} placeholder="you@example.com" /></label>
      )}

      <label>{T('account.plan')}
        <select value={account.plan} onChange={(e) => set({ plan: e.target.value })}>
          <option value="Free">Free</option>
          <option value="Pro">Pro</option>
          <option value="Max">Max</option>
        </select>
      </label>

      <h4>{T('account.sso')}</h4>
      <label className="check"><input type="checkbox" checked={!!account.sso.enabled} onChange={(e) => setAccount((a) => ({ ...a, sso: { ...a.sso, enabled: e.target.checked }, authMethod: e.target.checked && a.authMethod !== 'anthropic' ? 'sso' : a.authMethod }))} /> {T('account.sso.enable')}</label>
      {account.sso.enabled && (
        <div className="row-grid">
          <label>{T('account.sso.idp')}<input value={account.sso.idpName || ''} onChange={setSSO('idpName')} placeholder="Okta / Entra ID / Google" /></label>
          <label>{T('account.sso.issuer')}<input value={account.sso.issuer || ''} onChange={setSSO('issuer')} placeholder="https://idp.corp.com" /></label>
          <label>{T('account.sso.clientId')}<input value={account.sso.clientId || ''} onChange={setSSO('clientId')} placeholder="sp-…" /></label>
          <label>{T('account.sso.domain')}<input value={account.sso.domain || ''} onChange={setSSO('domain')} placeholder="corp.com" /></label>
        </div>
      )}

      <h4>{T('account.sync')}</h4>
      <label className="check"><input type="checkbox" checked={!!account.sync.enabled} onChange={(e) => setAccount((a) => ({ ...a, sync: { ...a.sync, enabled: e.target.checked } }))} /> {T('account.sync.enable')}</label>
      <div className="account-actions">
        <button onClick={syncNow}><Icon name="ArrowClockwise" size={13} /> {T('account.sync.now')}</button>
        <button onClick={importHistory}><Icon name="Download" size={13} /> {T('account.import')}</button>
      </div>
      <div className="account-sync-meta">
        <span>{T('account.sync.last')}: {account.sync.lastSync ? new Date(account.sync.lastSync).toLocaleString() : T('account.sync.never')}</span>
        <span>{T('account.sync.devices')}: {account.sync.deviceCount || 1}</span>
      </div>
    </div>
  );
}

function SettingsModal({ provider, setProvider, providerKeys, setProviderKeys, settings, setSettings, orchestrator, setOrchestrator, features, setFeatures, testProvider, onClose, T, account, setAccount, permissions, setPermissions }) {
  const set = (k) => (e) => setProvider({ ...provider, [k]: e.target.value });
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

  // Local Ollama — list only the models this machine actually has, and offer to
  // start the server if it is not running.
  const [ollama, setOllama] = useState({ ok: false, base: '', models: [], detail: '' });
  const [ollamaBusy, setOllamaBusy] = useState(false);
  const applyOllamaModel = (name) => {
    const base = ollama.base || 'http://localhost:11434/v1';
    setProvider((v) => ({ ...v, baseURL: base, model: name, apiKey: '', supportsTools: true }));
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

  const providers = orchestrator.providers || [];
  const updateProviderEntry = (i, patch) => {
    const next = providers.map((p, j) => (j === i ? { ...p, ...patch } : p));
    saveOrch({ ...orchestrator, providers: next });
  };
  const addProvider = () => {
    const entry = { id: 'p' + Date.now().toString(36), name: 'Provider ' + (providers.length + 1), baseURL: provider.baseURL || 'http://localhost:11434/v1', apiKey: '', model: provider.model || 'llama3.1' };
    saveOrch({ ...orchestrator, providers: [...providers, entry], activeIndex: providers.length ? orchestrator.activeIndex : 0 });
  };
  const removeProvider = (i) => {
    const next = providers.filter((_, j) => j !== i);
    saveOrch({ ...orchestrator, providers: next, activeIndex: next.length ? Math.min(Math.max(0, orchestrator.activeIndex), next.length - 1) : -1 });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{T('settings.title')}</h2>

        <h3>{T('settings.provider')}</h3>
        <div className="presets">
          {PRESETS.map((p) => (
            <button key={p.name} className={provider.baseURL === p.baseURL && provider.model === p.model ? 'on' : ''} onClick={() => { const k = p.apiKey || keyForEntry(p.baseURL); setProvider((v) => ({ ...v, baseURL: p.baseURL, model: p.model, apiKey: k, supportsTools: p.supportsTools !== false, maxTokens: p.maxTokens != null ? p.maxTokens : v.maxTokens, reasoningLevel: p.reasoningLevel || v.reasoningLevel || 'auto' })); if (k) setKeyForEntry(p.baseURL, k); }}>{p.name}</button>
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
                <button
                  type="button"
                  key={m.name}
                  className={'ollama-model' + (provider.model === m.name ? ' on' : '')}
                  title={m.family ? m.family : m.name}
                  onClick={() => applyOllamaModel(m.name)}
                >
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

        <h3><Icon name="Settings" size={14} /> {T('settings.orchestrator')}</h3>
        <label className="check"><input type="checkbox" checked={!!orchestrator.enabled} onChange={(e) => saveOrch({ ...orchestrator, enabled: e.target.checked })} /> Enable — auto-switch to the next provider on rate-limit / limit-reached</label>
        {orchestrator.enabled && (
          <div className="orch-list">
            {providers.length === 0 && <p className="muted">No providers added. Add 100+ API keys below; Helio Bot will fail over in order.</p>}
            {providers.map((p, i) => (
              <div key={p.id || i} className={'orch-item ' + (i === orchestrator.activeIndex ? 'on' : '')}>
                <label className="orch-radio"><input type="radio" name="orch-active" checked={i === orchestrator.activeIndex} onChange={() => saveOrch({ ...orchestrator, activeIndex: i })} title="Start here" /> #{i + 1}</label>
                <input value={p.name || ''} onChange={(e) => updateProviderEntry(i, { name: e.target.value })} placeholder="name" />
                <input value={p.baseURL || ''} onChange={(e) => updateProviderEntry(i, { baseURL: e.target.value })} placeholder="baseURL" />
                <input value={p.model || ''} onChange={(e) => updateProviderEntry(i, { model: e.target.value })} placeholder="model" />
                <input value={p.apiKey || ''} onChange={(e) => updateProviderEntry(i, { apiKey: e.target.value })} placeholder="apiKey" type="password" />
                <button className="orch-del" onClick={() => removeProvider(i)}>×</button>
              </div>
            ))}
            <button onClick={addProvider}>+ Add provider</button>
          </div>
        )}

        <h3><Icon name="Lightbulb" size={14} /> {T('settings.features')}</h3>
        <label className="check"><input type="checkbox" checked={!!features.computerUse} onChange={(e) => saveFeat({ ...features, computerUse: e.target.checked })} /> Computer Use (screen + mouse/keyboard via macOS automation)</label>
        <label className="check"><input type="checkbox" checked={!!features.chrome} onChange={(e) => saveFeat({ ...features, chrome: e.target.checked })} /> Chrome control (CDP)</label>
        {features.chrome && (
          <div className="row">
            <label>Chrome host<input value={features.chromeHost} onChange={(e) => saveFeat({ ...features, chromeHost: e.target.value })} /></label>
            <label>Chrome port<input type="number" value={features.chromePort} onChange={(e) => saveFeat({ ...features, chromePort: Number(e.target.value) })} /></label>
          </div>
        )}
        <label className="check"><input type="checkbox" checked={!!features.bridges} onChange={(e) => saveFeat({ ...features, bridges: e.target.checked })} /> Bot bridges (webhook server for hearthbot/slackbot/teamsbot/webagent)</label>
        <label className="check"><input type="checkbox" checked={!!features.quickEntry} onChange={(e) => saveFeat({ ...features, quickEntry: e.target.checked })} /> Quick Entry (global hotkey CmdOrCtrl+Shift+Space)</label>
        <label className="check"><input type="checkbox" checked={!!features.computerUseTeach} onChange={(e) => saveFeat({ ...features, computerUseTeach: e.target.checked })} /> Computer Use — teach & watch/record</label>

        <h3><Icon name="Users" size={14} /> Buddy & Remote Control</h3>
        <label className="check"><input type="checkbox" checked={!!features.buddy} onChange={(e) => saveFeat({ ...features, buddy: e.target.checked })} /> Buddy (pair-hunting co-pilot)</label>
        <label className="check"><input type="checkbox" checked={!!features.remoteControl} onChange={(e) => saveFeat({ ...features, remoteControl: e.target.checked })} /> Remote Control (Drive / co-browsing session)</label>

        <h3><Icon name="Code" size={14} /> Developer</h3>
        <label className="check"><input type="checkbox" checked={!!features.extensions} onChange={(e) => saveFeat({ ...features, extensions: e.target.checked })} /> Extensions (custom tools / MCP servers)</label>
        <label className="check"><input type="checkbox" checked={!!features.developerMode} onChange={(e) => saveFeat({ ...features, developerMode: e.target.checked })} /> Developer mode (debug tools + local exec consent)</label>
        <label className="check"><input type="checkbox" checked={!!features.trustedFolders} onChange={(e) => saveFeat({ ...features, trustedFolders: e.target.checked })} /> Trusted folders (pre-approve shell exec in these dirs)</label>

        <h3>{T('settings.behavior')}</h3>
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
        <label className="check"><input type="checkbox" checked={settings.useMemory} onChange={(e) => setSettings({ ...settings, useMemory: e.target.checked })} /> Inject long-term memory into prompts</label>
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

        <AccountSection account={account} setAccount={setAccount} T={T} />

        <div className="modal-actions">
          <button onClick={testProvider}>Test connection</button>
          <button className="primary" onClick={onClose}>{T('settings.done')}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Interactive question / plan approval ----------
function QuestionModal({ question, answer }) {
  const [text, setText] = useState('');
  const isPlan = question.type === 'plan';
  const options = question.options || [];

  const submit = (ans) => answer(ans);

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>{isPlan ? 'Plan approval' : 'Helio Bot needs your input'}</h2>
        <div className="question-text">{question.text}</div>

        {!isPlan && options.length > 0 && (
          <div className="qoptions">
            {options.map((o, i) => {
              const label = typeof o === 'string' ? o : (o.label || o.value || String(o));
              const desc = typeof o === 'object' ? o.description : null;
              return (
                <button key={i} className="qopt" onClick={() => submit(label)}>
                  <b>{label}</b>
                  {desc && <span>{desc}</span>}
                </button>
              );
            })}
          </div>
        )}

        <textarea
          className="qinput"
          placeholder={isPlan ? 'Add a note (optional)…' : 'Or type your own answer…'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !isPlan) { e.preventDefault(); submit(text); } }}
        />

        <div className="modal-actions">
          {isPlan ? (
            <>
              <button onClick={() => submit('Plan rejected.' + (text ? ' Note: ' + text : ''))}>Reject</button>
              <button className="primary" onClick={() => submit('Plan approved. Proceed.' + (text ? ' Note: ' + text : ''))}>Approve plan</button>
            </>
          ) : (
            <button className="primary" onClick={() => submit(text)}>Submit</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------- B8 permission prompt (Claude Code mode) ----------
function PermissionModal({ permission, answer }) {
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Helio Bot requests permission</h2>
        <div className="perm-tool">{permission.tool}</div>
        <pre className="perm-summary">{permission.summary}</pre>
        <div className="modal-actions">
          <button onClick={() => answer(false)}>Deny</button>
          <button className="primary" onClick={() => answer(true)}>Allow</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Search (Claude parity: fuzzy search across conversations + messages) ----------
function SearchModal({ convs, onOpen, onClose }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const query = q.trim().toLowerCase();
  const results = useMemo(() => {
    if (!query) return [];
    const out = [];
    for (const c of convs) {
      if (c.title && c.title.toLowerCase().includes(query)) {
        out.push({ conv: c, snippet: c.title, match: 'title' });
        continue;
      }
      for (const m of c.messages || []) {
        const body = (m.content || '').toLowerCase();
        const idx = body.indexOf(query);
        if (idx !== -1) {
          const start = Math.max(0, idx - 30);
          const snippet = (m.content || '').slice(start, start + 120);
          out.push({ conv: c, snippet, match: m.role });
          break;
        }
      }
    }
    return out.slice(0, 30);
  }, [query, convs]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal search-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-box">
          <Icon name="Search" size={16} />
          <input ref={inputRef} placeholder="Search conversations…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }} />
          {q && <button className="icon-btn" onClick={() => setQ('')}><Icon name="X" size={14} /></button>}
        </div>
        <div className="search-results">
          {!query && <p className="muted">Type to search your conversations and messages.</p>}
          {query && results.length === 0 && <p className="muted">No matches for "{q}".</p>}
          {results.map((r, i) => (
            <button key={i} className="search-hit" onClick={() => onOpen(r.conv.id)}>
              <Icon name="Chat" size={14} />
              <div className="search-hit-body">
                <div className="search-hit-title">{r.conv.title || 'Untitled'}</div>
                <div className="search-hit-snippet">{r.snippet}</div>
              </div>
              <span className="search-hit-kind">{r.match}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- Command Palette (⌘K) — Claude parity ----------
function CommandPalette({ onClose, onNewChat, onSearch, onToggleBrowser, onToggleCode, onSettings, onQuickEntry, onAbout, onExport, onToggleSidebar, onToggleTheme }) {
  const [q, setQ] = useState('');
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const COMMANDS = [
    { key: 'new', label: 'New chat', icon: 'Add', run: onNewChat },
    { key: 'search', label: 'Search conversations…', icon: 'Search', run: onSearch },
    { key: 'browser', label: 'Toggle browser pane', icon: 'Globe', run: onToggleBrowser },
    { key: 'code', label: 'Code mode', icon: 'Code', run: onToggleCode },
    { key: 'sidebar', label: 'Toggle sidebar', icon: 'SidebarClose', run: onToggleSidebar },
    { key: 'theme', label: 'Toggle theme', icon: 'Lightbulb', run: onToggleTheme },
    { key: 'quick', label: 'Quick Entry…', icon: 'CommandLine', run: onQuickEntry },
    { key: 'export', label: 'Export current conversation', icon: 'Download', run: onExport },
    { key: 'settings', label: 'Settings…', icon: 'Settings', run: onSettings },
    { key: 'about', label: 'About Helio Bot', icon: 'Chat', run: onAbout },
  ];

  const query = q.trim().toLowerCase();
  const items = query ? COMMANDS.filter((c) => c.label.toLowerCase().includes(query)) : COMMANDS;
  const [sel, setSel] = useState(0);
  useEffect(() => { setSel(0); }, [query]);

  const run = (c) => { onClose(); c.run(); };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal palette-modal" onClick={(e) => e.stopPropagation()}>
        <div className="search-box">
          <Icon name="CommandLine" size={16} />
          <input
            ref={inputRef}
            placeholder="Type a command…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
              else if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
              else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
            }}
          />
        </div>
        <div className="palette-list">
          {items.map((c, i) => (
            <button key={c.key} className={'palette-item ' + (i === sel ? 'sel' : '')} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <Icon name={c.icon} size={15} />
              <span>{c.label}</span>
            </button>
          ))}
          {items.length === 0 && <p className="muted">No matching command.</p>}
        </div>
      </div>
    </div>
  );
}

// ---------- In-chat Find (⌘F) — Claude parity ----------
function FindBar({ query, setQuery, messages, onClose }) {
  const [idx, setIdx] = useState(0);
  const inputRef = useRef(null);
  useEffect(() => { inputRef.current?.focus(); }, []);

  const hits = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    const out = [];
    for (const m of messages) {
      const body = String(m.content || '');
      let i = body.toLowerCase().indexOf(q);
      while (i !== -1) {
        out.push({ role: m.role, start: i, snippet: body.slice(Math.max(0, i - 25), i + 75) });
        i = body.toLowerCase().indexOf(q, i + 1);
        if (out.length > 200) return out;
      }
    }
    return out;
  }, [query, messages]);

  const cur = hits.length ? Math.min(idx, hits.length - 1) : 0;

  return (
    <div className="findbar">
      <div className="search-box">
        <Icon name="Search" size={14} />
        <input
          ref={inputRef}
          placeholder="Find in conversation…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'Enter') { e.preventDefault(); setIdx((i) => (hits.length ? (i + 1) % hits.length : 0)); }
          }}
        />
        <span className="find-count">{hits.length ? (cur + 1) + '/' + hits.length : '0/0'}</span>
        <button className="icon-btn" onClick={() => setIdx((i) => (hits.length ? (i - 1 + hits.length) % hits.length : 0))}><Icon name="ArrowUp" size={14} /></button>
        <button className="icon-btn" onClick={() => setIdx((i) => (hits.length ? (i + 1) % hits.length : 0))}><Icon name="ArrowDown" size={14} /></button>
        <button className="icon-btn" onClick={onClose}><Icon name="X" size={14} /></button>
      </div>
      {query && hits.length > 0 && <div className="find-result"><span className="find-role">{hits[cur].role}</span> …{hits[cur].snippet}…</div>}
    </div>
  );
}
