'use strict';
/**
 * Customizations Token Budget Analyzer (20,000-token cap with Global/Project
 * attribution and deterministic @path on-demand demotion).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_CAP_TOKENS = 20000;

function estimateTokens(textOrObj) {
  const s = typeof textOrObj === 'string' ? textOrObj : JSON.stringify(textOrObj || '');
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function readSafe(p) {
  try {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return fs.readFileSync(p, 'utf8');
  } catch (_) {}
  return '';
}

function discoverRuleFiles(cwd, homeDir) {
  const found = [];
  const home = homeDir || require('os').homedir();
  const candidates = [
    { scope: 'Global', kind: 'rule', path: path.join(home, '.claude', 'CLAUDE.md'), name: '~/.claude/CLAUDE.md' },
    { scope: 'Global', kind: 'rule', path: path.join(home, '.autobot', 'AKRON.md'), name: '~/.autobot/AKRON.md' },
  ];
  if (cwd) {
    candidates.push(
      { scope: 'Project', kind: 'rule', path: path.join(cwd, 'CLAUDE.md'), name: 'CLAUDE.md' },
      { scope: 'Project', kind: 'rule', path: path.join(cwd, 'AKRON.md'), name: 'AKRON.md' },
      { scope: 'Project', kind: 'rule', path: path.join(cwd, '.claude', 'CLAUDE.md'), name: '.claude/CLAUDE.md' },
    );
  }
  for (const c of candidates) {
    const content = readSafe(c.path);
    if (content) {
      found.push({
        id: `rule:${c.scope}:${c.name}`,
        name: c.name,
        scope: c.scope,
        kind: c.kind,
        path: c.path,
        tokens: estimateTokens(content),
        pinned: c.name === 'CLAUDE.md' || c.name === 'AKRON.md',
      });
    }
  }
  return found;
}

function analyzeCustomizationBudget({
  cwd = '',
  homeDir = '',
  globalRules = [],
  projectRules = [],
  skills = [],
  mcpTools = [],
  memoryItems = [],
  capTokens = DEFAULT_CAP_TOKENS,
} = {}) {
  const cap = Math.max(1000, Number(capTokens) || DEFAULT_CAP_TOKENS);
  const rawItems = [];

  if (cwd || homeDir) {
    rawItems.push(...discoverRuleFiles(cwd, homeDir));
  }

  const pushRule = (r, scope) => {
    if (!r) return;
    const text = typeof r === 'string' ? r : (r.content || r.instructions || r.text || '');
    const tokens = Number(r.tokens) || estimateTokens(text);
    rawItems.push({
      id: r.id || `${scope}:${r.name || rawItems.length}`,
      name: r.name || `${scope} Rule`,
      scope,
      kind: 'rule',
      path: r.path || r.name || '',
      tokens,
      pinned: !!r.pinned,
    });
  };

  for (const r of (Array.isArray(globalRules) ? globalRules : [])) pushRule(r, 'Global');
  for (const r of (Array.isArray(projectRules) ? projectRules : [])) pushRule(r, 'Project');

  for (const sk of (Array.isArray(skills) ? skills : [])) {
    if (!sk || sk.enabled === false) continue;
    const scope = sk.source === 'project' ? 'Project' : 'Global';
    const tokens = Number(sk.tokens) || estimateTokens(`${sk.name}\n${sk.description || ''}\n${sk.instructions || sk.body || ''}`);
    rawItems.push({
      id: `skill:${sk.name}`,
      name: sk.name || 'Skill',
      scope,
      kind: 'skill',
      path: sk.file || sk.path || `@skill:${sk.name || 'skill'}`,
      tokens,
      pinned: !!sk.pinned,
    });
  }

  for (const t of (Array.isArray(mcpTools) ? mcpTools : [])) {
    if (!t) continue;
    const scope = t.scope === 'Project' ? 'Project' : 'Global';
    const tokens = Number(t.tokens) || estimateTokens(t.schema || t.description || t);
    rawItems.push({
      id: `mcp:${t.name || rawItems.length}`,
      name: t.name || 'MCP Tool',
      scope,
      kind: 'mcp',
      path: t.server ? `@mcp:${t.server}/${t.name}` : `@mcp:${t.name || 'tool'}`,
      tokens,
      pinned: !!t.pinned,
    });
  }

  for (const m of (Array.isArray(memoryItems) ? memoryItems : [])) {
    if (!m) continue;
    rawItems.push({
      id: `mem:${m.id || rawItems.length}`,
      name: m.title || m.area || 'Memory',
      scope: m.scope === 'Project' ? 'Project' : 'Global',
      kind: 'memory',
      path: '@memory',
      tokens: Number(m.tokens) || estimateTokens(m.content || m),
      pinned: !!m.pinned,
    });
  }

  const totalTokens = rawItems.reduce((sum, x) => sum + (Number(x.tokens) || 0), 0);
  const demoteIds = new Set();

  if (totalTokens > cap) {
    // Demote largest unpinned items (preferring skills/mcp/global bulk first) until <= cap
    let running = totalTokens;
    const candidates = rawItems
      .filter((x) => !x.pinned)
      .sort((a, b) => {
        const scopeBiasA = a.scope === 'Global' ? 1 : 0;
        const scopeBiasB = b.scope === 'Global' ? 1 : 0;
        if (b.tokens !== a.tokens) return b.tokens - a.tokens;
        return scopeBiasB - scopeBiasA;
      });
    for (const c of candidates) {
      if (running <= cap) break;
      demoteIds.add(c.id);
      running -= Math.max(0, c.tokens - 16); // @path mention costs ~16 tokens
    }
  }

  const items = rawItems.map((it) => {
    const demoted = demoteIds.has(it.id);
    const mentionRef = it.path
      ? (it.path.startsWith('@') ? it.path : `@${cwd && it.path.startsWith(cwd) ? path.relative(cwd, it.path) : it.path}`)
      : `@${it.name}`;
    return {
      ...it,
      demoted,
      effectiveTokens: demoted ? 16 : it.tokens,
      mentionRef,
    };
  });

  const activeTokens = items.reduce((s, it) => s + it.effectiveTokens, 0);
  const globalTokens = items.filter((i) => i.scope === 'Global').reduce((s, i) => s + i.tokens, 0);
  const projectTokens = items.filter((i) => i.scope === 'Project').reduce((s, i) => s + i.tokens, 0);

  return {
    capTokens: cap,
    totalTokens,
    activeTokens,
    globalTokens,
    projectTokens,
    overBudget: totalTokens > cap,
    usagePct: Math.min(100, Math.round((totalTokens / cap) * 100)),
    activeUsagePct: Math.min(100, Math.round((activeTokens / cap) * 100)),
    demotedCount: demoteIds.size,
    items,
    activeItems: items.filter((i) => !i.demoted),
    demotedItems: items.filter((i) => i.demoted),
  };
}

function estimateSessionContext({
  messages = [],
  tools = null,
  model = '',
  modelWindow = 0,
  autoCompactRatio = 0.8,
  customCompactTokens = 0,
} = {}) {
  let resolvedWin = Number(modelWindow) || 0;
  if (resolvedWin <= 0 && model) {
    try {
      resolvedWin = require('./model-catalog').contextWindowFor(model);
    } catch (_) {}
  }
  const windowTokens = Math.max(4096, resolvedWin || 128000);
  const ratio = Number(autoCompactRatio) > 0 && Number(autoCompactRatio) < 1 ? Number(autoCompactRatio) : 0.8;
  const thresholdTokens = Number(customCompactTokens) > 0
    ? Math.max(2048, Math.min(Number(customCompactTokens), Math.round(windowTokens * 0.9)))
    : Math.max(2048, Math.round(windowTokens * ratio));
  let systemTokens = 0;
  let messageTokens = 0;
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || typeof m !== 'object') continue;
    const t = estimateTokens(m.content || '') + (Array.isArray(m.tool_calls) ? estimateTokens(m.tool_calls) : 0) + 16;
    if (m.role === 'system') systemTokens += t;
    else messageTokens += t;
  }
  const toolTokens = (Array.isArray(tools) && tools.length) ? estimateTokens(tools) : 0;
  const totalTokens = systemTokens + messageTokens + toolTokens;
  const usageRatio = windowTokens > 0 ? (totalTokens / windowTokens) : 0;
  return {
    totalTokens,
    systemTokens,
    messageTokens,
    toolTokens,
    windowTokens,
    thresholdTokens,
    usageRatio,
    usagePct: Math.min(100, Math.round(usageRatio * 100)),
    shouldCompact: totalTokens >= thresholdTokens,
  };
}

module.exports = {
  DEFAULT_CAP_TOKENS,
  estimateTokens,
  analyzeCustomizationBudget,
  estimateSessionContext,
};
