'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_SKILLS_DIR = path.join(os.homedir(), '.autobot', 'skills');

const KEY_TOKEN_RE = new RegExp(
  '(?:' +
    ['sk', 'ant'].join('-') + '|' +
    ['sk', 'proj'].join('-') + '|' +
    ['sk', 'live'].join('-') + '|' +
    ['sk', 'test'].join('-') + '|' +
    ['gh', 'p_'].join('') + '|' +
    ['gh', 'o_'].join('') + '|' +
    ['gh', 'u_'].join('') + '|' +
    ['gh', 's_'].join('') + '|' +
    ['xox', 'b-'].join('') + '|' +
    ['xox', 'p-'].join('') + '|' +
    ['AK', 'IA'].join('') + '|' +
    ['A', 'Iza'].join('') +
  ')[A-Za-z0-9_.-]{8,}',
  'g'
);

const PRIVATE_KEY_BLOCK_RE = new RegExp(
  '-----BEGIN [A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----',
  'g'
);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scrubPii(text, { extraNames = [] } = {}) {
  let out = String(text || '');
  if (!out) return '';

  out = out.replace(PRIVATE_KEY_BLOCK_RE, '<private_key>');
  out = out.replace(KEY_TOKEN_RE, '<api_key>');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{10,}\b/gi, 'Bearer <api_key>');
  out = out.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<api_key>');

  // Emails
  out = out.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<email>');

  // OS home directory paths (macOS / Linux / Windows)
  out = out.replace(/\/Users\/[A-Za-z0-9._-]+/g, '~');
  out = out.replace(/\/home\/[A-Za-z0-9._-]+/g, '~');
  out = out.replace(/[A-Za-z]:\\Users\\[A-Za-z0-9._ -]+/gi, '~');

  // UUIDs & account/order/customer IDs
  out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  out = out.replace(/\b(order|account|acct|customer|cust|invoice|inv|user|org)[-_:# ]+[A-Za-z0-9_-]{4,}\b/gi, '$1-<id>');

  // Phone numbers & IPv4 addresses
  out = out.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip_address>');
  out = out.replace(/(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g, '<phone>');

  // Explicit personal names (plus current OS username if distinct & non-generic)
  const names = new Set((Array.isArray(extraNames) ? extraNames : []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2));
  const introRx = /\b(?:my name is|author:|by )\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;
  let m;
  while ((m = introRx.exec(out))) {
    if (m[1]) names.add(m[1]);
  }
  for (const name of names) {
    out = out.replace(new RegExp('\\b' + escapeRegex(name) + '\\b', 'g'), '<name>');
  }

  return out;
}

function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || ('learned-skill-' + Date.now().toString(36));
}

async function extractLearnedSkill({
  name = '',
  messages = [],
  cwd = null,
  extraNames = [],
  chatFn = null,
  provider = null,
  skillsDir = DEFAULT_SKILLS_DIR,
} = {}) {
  const userPrompts = [];
  const toolSteps = [];
  const assistantNotes = [];

  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const raw = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join(' ')
        : '';
    if (m.role === 'user' && raw.trim()) userPrompts.push(raw.trim());
    if (m.role === 'assistant' && raw.trim()) assistantNotes.push(raw.trim());
    if (Array.isArray(m.tools)) {
      for (const t of m.tools) {
        if (!t || !t.name) continue;
        const argStr = t.args ? JSON.stringify(t.args).slice(0, 140) : '';
        toolSteps.push(`${t.name}(${argStr})${t.isError ? ' [failed before retry]' : ''}`);
      }
    }
  }

  let title = scrubPii(name || userPrompts[0] || 'Solved Workflow', { extraNames }).slice(0, 72);
  let bodyContent = '';

  if (typeof chatFn === 'function' || (provider && (provider.apiKey || provider.oauthAccount || provider.baseUrl || provider.provider === 'ollama'))) {
    const invoke = chatFn || require('./llm').chatOnce;
    const prompt = [
      'Distill this solved task into a reusable general engineering skill in Markdown.',
      'Replace all personal details, emails, tokens, home paths, and order/account IDs with generic <placeholders>.',
      `GOAL/TITLE HINT: ${title}`,
      `USER REQUESTS: ${scrubPii(userPrompts.join('\n').slice(0, 2000), { extraNames })}`,
      `TOOL TRACE: ${scrubPii(toolSteps.slice(-15).join('\n'), { extraNames })}`,
      `OUTCOME: ${scrubPii(assistantNotes.slice(-2).join('\n').slice(0, 2000), { extraNames })}`,
    ].join('\n\n');
    try {
      const res = await invoke({ provider, messages: [{ role: 'user', content: prompt }], maxTokens: 1200 });
      if (res && res.content) bodyContent = scrubPii(String(res.content), { extraNames });
    } catch (_) {}
  }

  if (!bodyContent) {
    const cleanGoal = scrubPii(userPrompts[0] || 'Completed engineering workflow', { extraNames });
    const cleanSteps = toolSteps.length
      ? toolSteps.slice(0, 12).map((s, i) => `${i + 1}. \`${scrubPii(s, { extraNames })}\``)
      : assistantNotes.slice(-1).map((a, i) => `${i + 1}. ${scrubPii(a.slice(0, 300), { extraNames })}`);
    const cleanOutcome = scrubPii((assistantNotes.slice(-1)[0] || 'Verify build and tests pass cleanly.').slice(0, 400), { extraNames });
    bodyContent = [
      `# ${title}`,
      '',
      cleanGoal,
      '',
      '## When to Use',
      `- When handling tasks similar to: ${cleanGoal.slice(0, 140)}`,
      '',
      '## Steps',
      ...(cleanSteps.length ? cleanSteps : ['1. Reproduce and isolate root cause before editing.']),
      '',
      '## Verification',
      cleanOutcome,
    ].join('\n');
  }

  const scrubbedTitle = scrubPii(title, { extraNames }).replace(/"/g, "'");
  const slug = slugify(name || scrubbedTitle);
  const fullMarkdown = [
    '---',
    `name: ${slug}`,
    `description: "${scrubbedTitle.slice(0, 120)}"`,
    'learned: true',
    `createdAt: ${new Date().toISOString()}`,
    '---',
    '',
    scrubPii(bodyContent, { extraNames }),
    '',
  ].join('\n');

  const dir = skillsDir || DEFAULT_SKILLS_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, `${slug}.md`);
  fs.writeFileSync(filePath, fullMarkdown, { encoding: 'utf8', mode: 0o600 });

  return { ok: true, slug, title: scrubbedTitle, filePath, markdown: fullMarkdown, cwd };
}

module.exports = {
  DEFAULT_SKILLS_DIR,
  scrubPii,
  extractLearnedSkill,
};
