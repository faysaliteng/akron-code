'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const AREAS = ['about', 'preferences', 'people', 'routines', 'lessons'];
const DEFAULT_STORE = path.join(os.homedir(), '.autobot', 'curated-memory.json');

const API_PREFIX_RE = new RegExp(
  '(?:' +
    ['sk', 'ant'].join('-') + '|' +
    ['sk', 'proj'].join('-') + '|' +
    ['sk', 'live'].join('-') + '|' +
    ['gh', 'p_'].join('') + '|' +
    ['gh', 'o_'].join('') + '|' +
    ['A', 'Iza'].join('') +
  ')[A-Za-z0-9_-]{8,}',
  'i'
);

const PRIVATE_KEY_RE = new RegExp('-----BEGIN [A-Z ]*PRIVATE KEY-----', 'i');

function defaultState() {
  return { enabled: false, autoCurate: false, entries: [], updatedAt: 0 };
}

function loadState(storePath = DEFAULT_STORE) {
  const fp = storePath || DEFAULT_STORE;
  try {
    if (fs.existsSync(fp)) {
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return {
          enabled: parsed.enabled !== false,
          autoCurate: Boolean(parsed.autoCurate),
          entries: Array.isArray(parsed.entries) ? parsed.entries : [],
          updatedAt: Number(parsed.updatedAt) || 0,
        };
      }
    }
  } catch (_) {}
  return defaultState();
}

function saveState(state, storePath = DEFAULT_STORE) {
  const fp = storePath || DEFAULT_STORE;
  fs.mkdirSync(path.dirname(fp), { recursive: true, mode: 0o700 });
  const next = { ...state, updatedAt: Date.now() };
  const tmp = `${fp}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 6)}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, fp);
  try { fs.chmodSync(fp, 0o600); } catch (_) {}
  return next;
}

function setAutoCurate(enabled, storePath = DEFAULT_STORE) {
  const st = loadState(storePath);
  st.autoCurate = Boolean(enabled);
  if (st.autoCurate) st.enabled = true;
  return saveState(st, storePath);
}

function stripUntrustedFromUserText(text) {
  let s = String(text || '');
  s = s.replace(/<untrusted\b[^>]*>[\s\S]*?<\/untrusted>/gi, ' ');
  s = s.replace(/<tool_use>[\s\S]*?<\/tool_use>/gi, ' ');
  s = s.replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function extractUserOnlyMessages(convs = []) {
  const out = [];
  for (const c of Array.isArray(convs) ? convs : []) {
    if (!c) continue;
    const convId = c.id || '';
    const msgs = Array.isArray(c.messages) ? c.messages : [];
    for (const m of msgs) {
      if (!m || m.role !== 'user') continue;
      const raw = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join(' ')
          : '';
      const clean = stripUntrustedFromUserText(raw);
      if (clean.length >= 6) {
        out.push({
          convId,
          msgId: m.id || '',
          text: clean,
          ts: m.ts || Date.now(),
        });
      }
    }
  }
  return out;
}

function normWs(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function verifyVerbatimQuote(quote, userText) {
  const q = normWs(quote);
  const t = normWs(userText);
  if (!q || q.length < 6 || !t) return false;
  return t.includes(q);
}

function isSensitiveContent(text) {
  const s = String(text || '');
  if (!s) return false;
  if (API_PREFIX_RE.test(s) || PRIVATE_KEY_RE.test(s)) return true;
  if (/\b\d{3}-\d{2}-\d{4}\b/.test(s)) return true; // SSN
  if (/\b(?:password|passwd|secret_key|private_key|api[_ ]?key|bearer\s+[a-z0-9._-]{10,}|credit\s*card|cvv)\b/i.test(s)) return true;
  if (/\b(?:diagnosed\s+with|prescription\s+for|medical\s+record|ssn)\b/i.test(s)) return true;
  return false;
}

function heuristicExtractFacts(userMessages, existingActive = []) {
  const facts = [];
  const patterns = [
    { area: 'preferences', re: /\b(?:i\s+(?:always|usually|strongly)?\s*prefer|please\s+always|never\s+use|always\s+use|keep\s+my)\b[^.!?\n]{6,140}[.!?]?/i },
    { area: 'about', re: /\b(?:my\s+name\s+is|i\s+work\s+(?:at|on)|i\s+am\s+(?:a|an|building))\b[^.!?\n]{4,140}[.!?]?/i },
    { area: 'people', re: /\b(?:my\s+(?:teammate|colleague|manager|cofounder|partner)\s+[A-Z][a-z]+)\b[^.!?\n]{4,140}[.!?]?/i },
    { area: 'routines', re: /\b(?:every\s+(?:morning|day|week|monday|friday)|my\s+daily\s+routine)\b[^.!?\n]{5,140}[.!?]?/i },
    { area: 'lessons', re: /\b(?:remember\s+that|lesson\s+learned|do\s+not\s+forget\s+to)\b[^.!?\n]{5,140}[.!?]?/i },
  ];

  for (const um of userMessages) {
    const sentences = um.text.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
    for (const sent of sentences) {
      for (const p of patterns) {
        if (p.re.test(sent) && sent.length >= 10 && sent.length <= 220) {
          const supersedes = existingActive
            .filter((e) => e.area === p.area && e.content.toLowerCase() !== sent.toLowerCase() && (
              (p.area === 'about' && /my name is/i.test(sent) && /my name is/i.test(e.content)) ||
              (p.area === 'preferences' && /prefer|always use/i.test(sent) && e.content.slice(0, 14).toLowerCase() === sent.slice(0, 14).toLowerCase())
            ))
            .map((e) => e.id);
          facts.push({
            area: p.area,
            content: sent,
            quote: sent,
            convId: um.convId,
            sourceMsgId: um.msgId,
            replaces: supersedes,
          });
          break;
        }
      }
    }
  }
  return facts;
}

async function curateFromConversations({
  convs = [],
  storePath = DEFAULT_STORE,
  chatFn = null,
  provider = null,
} = {}) {
  const state = loadState(storePath);
  const userMsgs = extractUserOnlyMessages(convs);
  if (!userMsgs.length) return { ok: true, added: 0, archived: 0, rejected: 0, entries: state.entries };

  const activeExisting = state.entries.filter((e) => !e.archived);
  let candidates = [];

  if (typeof chatFn === 'function' || (provider && (provider.apiKey || provider.oauthAccount || provider.baseUrl || provider.provider === 'ollama'))) {
    const invoke = chatFn || require('./llm').chatOnce;
    const prompt = [
      'Extract durable user memories from ONLY the USER MESSAGES below.',
      'Rules:',
      '1. Classify area cleanly: about | preferences | people | routines | lessons.',
      '2. Every fact MUST copy a verbatim substring quote from the cited sourceMsgId message.',
      '3. NEVER include passwords, API keys, secrets, SSNs, or medical info.',
      '4. If a new fact obsoletes an existing entry, list its id in "replaces": ["..."].',
      'Return strict JSON: {"facts":[{"area":"preferences","content":"...","quote":"exact verbatim quote","convId":"...","sourceMsgId":"...","replaces":[]}]}',
      '',
      'EXISTING ACTIVE ENTRIES:',
      JSON.stringify(activeExisting.slice(0, 30).map((e) => ({ id: e.id, area: e.area, content: e.content }))),
      '',
      'USER MESSAGES:',
      JSON.stringify(userMsgs.slice(-40)),
    ].join('\n');

    try {
      const res = await invoke({ provider, messages: [{ role: 'user', content: prompt }], maxTokens: 1600 });
      const txt = String((res && res.content) || '').trim();
      const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(txt);
      const cand = fence ? fence[1].trim() : txt;
      const start = cand.indexOf('{');
      const end = cand.lastIndexOf('}');
      const parsed = JSON.parse(start >= 0 && end > start ? cand.slice(start, end + 1) : cand);
      if (Array.isArray(parsed.facts)) candidates = parsed.facts;
    } catch (_) {
      candidates = heuristicExtractFacts(userMsgs, activeExisting);
    }
  } else {
    candidates = heuristicExtractFacts(userMsgs, activeExisting);
  }

  let added = 0;
  let archived = 0;
  let rejected = 0;

  for (const c of candidates) {
    if (!c || !c.content || !c.quote) { rejected++; continue; }
    const area = AREAS.includes(String(c.area || '').toLowerCase()) ? String(c.area).toLowerCase() : 'lessons';
    const content = normWs(c.content);
    const quote = normWs(c.quote);
    if (isSensitiveContent(content) || isSensitiveContent(quote)) { rejected++; continue; }

    // Verify quote against the cited user message (or any user message cleanly — NEVER assistant/untrusted)
    const cited = c.sourceMsgId
      ? userMsgs.find((u) => u.msgId === c.sourceMsgId && (!c.convId || u.convId === c.convId))
      : null;
    const matchedMsg = cited && verifyVerbatimQuote(quote, cited.text)
      ? cited
      : userMsgs.find((u) => verifyVerbatimQuote(quote, u.text));

    if (!matchedMsg) {
      rejected++;
      continue;
    }

    const dup = state.entries.find((e) => !e.archived && normWs(e.content).toLowerCase() === content.toLowerCase());
    if (dup) continue;

    const id = 'mem_' + crypto.createHash('sha256').update(`${area}:${content}:${quote}`).digest('hex').slice(0, 12);
    if (Array.isArray(c.replaces) && c.replaces.length) {
      for (const oldId of c.replaces) {
        const old = state.entries.find((e) => e.id === oldId && !e.archived);
        if (old) {
          old.archived = true;
          old.replacedBy = id;
          old.updatedAt = Date.now();
          archived++;
        }
      }
    }

    state.entries.unshift({
      id,
      area,
      content,
      quote,
      convId: matchedMsg.convId,
      sourceMsgId: matchedMsg.msgId,
      archived: false,
      replacedBy: null,
      ts: matchedMsg.ts || Date.now(),
      updatedAt: Date.now(),
    });
    added++;
  }

  saveState(state, storePath);
  return { ok: true, added, archived, rejected, entries: state.entries, state };
}

function updateCuratedEntry(id, patch = {}, storePath = DEFAULT_STORE) {
  const st = loadState(storePath);
  const idx = st.entries.findIndex((e) => e.id === id);
  if (idx < 0) return { ok: false, error: 'Entry not found' };
  const nextArea = patch.area && AREAS.includes(patch.area) ? patch.area : st.entries[idx].area;
  const nextContent = patch.content != null ? normWs(patch.content) : st.entries[idx].content;
  if (isSensitiveContent(nextContent)) return { ok: false, error: 'Sensitive credentials/PII cannot be stored in curated memory' };
  st.entries[idx] = { ...st.entries[idx], area: nextArea, content: nextContent, updatedAt: Date.now() };
  saveState(st, storePath);
  return { ok: true, entry: st.entries[idx], state: st };
}

function deleteCuratedEntry(id, storePath = DEFAULT_STORE) {
  const st = loadState(storePath);
  const prev = st.entries.length;
  st.entries = st.entries.filter((e) => e.id !== id);
  saveState(st, storePath);
  return { ok: true, removed: st.entries.length !== prev, state: st };
}

function formatCuratedPromptBlock(storePath = DEFAULT_STORE) {
  const st = loadState(storePath);
  const active = st.entries.filter((e) => !e.archived);
  if (!active.length) return '';
  return '# Curated User Memory (quote-verified)\n' +
    active.slice(0, 40).map((e) => `- [${e.area}] ${e.content}`).join('\n');
}

module.exports = {
  AREAS,
  loadState,
  saveState,
  setAutoCurate,
  stripUntrustedFromUserText,
  extractUserOnlyMessages,
  verifyVerbatimQuote,
  isSensitiveContent,
  curateFromConversations,
  updateCuratedEntry,
  deleteCuratedEntry,
  formatCuratedPromptBlock,
};
