'use strict';
/**
 * Official CLI subprocess runner for subscription-backed providers.
 *
 * Instead of extracting CLI tokens or sending spoofed headers to private consumer
 * endpoints, subscription models (`claude`, `codex`, `grok`, `antigravity`/`gemini`)
 * execute the official bundled CLI binary as a managed subprocess in headless
 * JSON/NDJSON streaming mode and normalize events back into Akron Code's UI.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

let _defaultRuntimesGetter = null;
function setDefaultRuntimesGetter(fn) {
  _defaultRuntimesGetter = typeof fn === 'function' ? fn : null;
}
function getDefaultRuntimes() {
  try { return _defaultRuntimesGetter ? _defaultRuntimesGetter() : null; } catch (_) { return null; }
}

const BIN_CACHE_TTL_MS = 5 * 60 * 1000;
const _binCache = new Map();
function invalidateCliBinaryCache(kind = '') {
  if (!kind) { _binCache.clear(); return; }
  const low = String(kind).toLowerCase();
  for (const k of [..._binCache.keys()]) {
    if (k.startsWith(low + '|')) _binCache.delete(k);
  }
}

let _lastMcpConfigJson = '';
let _lastMcpConfigPath = '';
function writeIsolatedMcpConfigFile(opts = {}) {
  let servers = opts.mcpServers;
  if (!servers) {
    try {
      const mcpMod = require('./mcp');
      servers = typeof mcpMod.getActiveHealthyMcpServers === 'function'
        ? mcpMod.getActiveHealthyMcpServers({ includeInternalRea: Boolean(opts.includeRea || opts.includeInternalRea) })
        : {};
    } catch (_) {
      servers = {};
    }
  }
  const payload = JSON.stringify({ mcpServers: servers || {} });
  const target = path.join(os.tmpdir(), `akron-mcp-${process.pid}.json`);
  if (payload !== _lastMcpConfigJson || _lastMcpConfigPath !== target || !fs.existsSync(target)) {
    fs.writeFileSync(target, payload, { mode: 0o600 });
    _lastMcpConfigJson = payload;
    _lastMcpConfigPath = target;
  }
  return target;
}

const CLI_DEFS = {
  claude: { cliId: 'claude-code', bins: ['claude'] },
  chatgpt: { cliId: 'codex', bins: ['codex'] },
  codex: { cliId: 'codex', bins: ['codex'] },
  grok: { cliId: 'grok', bins: ['grok'] },
  agy: { cliId: 'antigravity-cli', fallbackCliIds: ['gemini-cli'], bins: ['agy', 'antigravity', 'gemini'] },
  antigravity: { cliId: 'antigravity-cli', fallbackCliIds: ['gemini-cli'], bins: ['agy', 'antigravity', 'gemini'] },
  google: { cliId: 'antigravity-cli', fallbackCliIds: ['gemini-cli'], bins: ['agy', 'antigravity', 'gemini'] },
  gemini: { cliId: 'gemini-cli', fallbackCliIds: ['antigravity-cli'], bins: ['gemini', 'agy'] },
  kimi: { cliId: 'kimi-code', bins: ['kimi'] },
  moonshot: { cliId: 'kimi-code', bins: ['kimi'] },
  'kimi-code': { cliId: 'kimi-code', bins: ['kimi'] },
  copilot: { cliId: 'github-copilot', bins: ['copilot'] },
  'github-copilot': { cliId: 'github-copilot', bins: ['copilot'] },
  zcode: { cliId: 'zcode', bins: ['zcode'] },
};

function providerKind(provider) {
  if (!provider || typeof provider !== 'object') return '';
  if (provider.cliKind && CLI_DEFS[provider.cliKind]) return provider.cliKind;
  const op = String(provider.oauthProvider || '').split(':')[0].toLowerCase().trim();
  if (op && CLI_DEFS[op]) return op === 'github-copilot' ? 'copilot' : op;
  const cid = String(provider.cliId || '').toLowerCase().trim();
  if (cid === 'claude-code') return 'claude';
  if (cid === 'codex') return 'chatgpt';
  if (cid === 'grok') return 'grok';
  if (cid === 'antigravity-cli' || cid === 'gemini-cli' || cid === 'agy' || cid === 'gemini') return 'antigravity';
  if (cid === 'kimi-code' || cid === 'kimi') return 'kimi';
  if (cid === 'github-copilot' || cid === 'copilot') return 'copilot';
  if (cid === 'zcode') return 'zcode';
  const tr = String(provider.transport || '').toLowerCase().trim();
  if (tr === 'anthropic') return 'claude';
  if (tr === 'codex') return 'chatgpt';
  if (tr === 'google') return 'antigravity';
  if (tr === 'grok') return 'grok';
  if (tr === 'kimi') return 'kimi';
  if (tr === 'copilot') return 'copilot';
  if (tr === 'zcode') return 'zcode';
  const m = String(provider.model || '').toLowerCase().trim();
  if (/^copilot-|^mai-code-/i.test(m)) return 'copilot';
  if (/^claude-/.test(m)) return 'claude';
  if (/^(gpt-|o[1-9]|codex)/.test(m)) return 'chatgpt';
  if (/^grok-/.test(m)) return 'grok';
  if (/^gemini-/.test(m)) return 'antigravity';
  if (/^kimi-/.test(m) && (provider.oauthProvider || provider.cliMode || provider.transport === 'cli')) return 'kimi';
  return '';
}

function isCliProvider(provider) {
  if (!provider || typeof provider !== 'object') return false;
  if (provider.cliMode === true || provider.transport === 'cli') return true;
  if (provider.transport === 'openai' || provider.transport === 'zai') return false;
  if (String(provider.apiKey || '').trim() && !provider.oauthProvider && !provider.oauth) return false;
  return Boolean((provider.oauth || provider.oauthProvider) && !String(provider.apiKey || '').trim() && providerKind(provider));
}

function detectZcodeCli() {
  return whichOnPath('zcode') || '';
}

function whichOnPath(binName) {
  const isWin = process.platform === 'win32';
  const exts = isWin ? ['', '.exe', '.cmd', '.bat'] : [''];
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.grok', 'bin'),
    ...(process.platform === 'darwin'
      ? ['/Applications/Antigravity.app/Contents/Resources/app/bin', '/Applications/Antigravity.app/Contents/Resources/bin']
      : (isWin
        ? [path.join(localAppData, 'agy', 'bin'), path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app', 'bin')]
        : ['/usr/share/antigravity/bin'])),
  ];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = path.join(d, binName + ext);
      try {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
          if (!isWin) fs.accessSync(p, fs.constants.X_OK);
          return p;
        }
      } catch (_) {}
    }
  }
  return '';
}

function isBundledSeedPath(p) {
  if (!p) return false;
  const norm = path.resolve(String(p)).replace(/\\/g, '/').toLowerCase();
  return norm.includes('/vendor/runtimes/')
    || norm.includes('/contents/resources/runtimes/')
    || norm.includes('/resources/runtimes/');
}

function candidateUserRuntimesDirs(opts = {}) {
  const out = [];
  const push = (d) => {
    if (!d) return;
    const norm = path.resolve(String(d));
    if (!out.includes(norm)) out.push(norm);
  };
  if (opts.userRuntimesDir) push(opts.userRuntimesDir);
  if (process.env.AKRON_USER_RUNTIMES_DIR) push(process.env.AKRON_USER_RUNTIMES_DIR);
  if (process.env.AUTOBOT_HOME) push(path.join(process.env.AUTOBOT_HOME, 'runtimes'));
  if (process.env.AKRON_ISOLATE_RUNTIMES !== '1') {
    try {
      const electron = require('electron');
      if (electron && electron.app && typeof electron.app.getPath === 'function') {
        push(path.join(electron.app.getPath('userData'), 'runtimes'));
      }
    } catch (_) {}
    const home = os.homedir();
    if (process.platform === 'darwin') {
      push(path.join(home, 'Library', 'Application Support', 'Akron Code', 'runtimes'));
      push(path.join(home, 'Library', 'Application Support', 'akronbot', 'runtimes'));
    } else if (process.platform === 'win32') {
      const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
      push(path.join(appData, 'Akron Code', 'runtimes'));
      push(path.join(appData, 'akronbot', 'runtimes'));
    } else {
      const cfg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
      push(path.join(cfg, 'Akron Code', 'runtimes'));
      push(path.join(cfg, 'akronbot', 'runtimes'));
    }
    push(path.join(home, '.autobot', 'runtimes'));
  }
  return out;
}

function resolveUserDataRuntime(cliId, binNames, opts = {}) {
  if (!cliId) return '';
  const isWin = process.platform === 'win32';
  for (const root of candidateUserRuntimesDirs(opts)) {
    const cliRoot = path.join(root, cliId);
    if (!fs.existsSync(cliRoot)) continue;
    const versionDirs = [];
    const curLink = path.join(cliRoot, 'current');
    try {
      const linkTarget = fs.readlinkSync(curLink);
      const absTarget = path.isAbsolute(linkTarget) ? linkTarget : path.join(cliRoot, linkTarget);
      if (fs.existsSync(absTarget) && fs.statSync(absTarget).isDirectory()) versionDirs.push(absTarget);
    } catch (_) {
      try {
        if (fs.existsSync(curLink) && fs.statSync(curLink).isDirectory()) versionDirs.push(curLink);
      } catch (__) {}
    }
    const ptrFile = path.join(cliRoot, 'current.ptr');
    try {
      if (fs.existsSync(ptrFile)) {
        const ptrVal = fs.readFileSync(ptrFile, 'utf8').trim();
        if (ptrVal) {
          const absPtr = path.isAbsolute(ptrVal) ? ptrVal : path.join(cliRoot, ptrVal);
          if (fs.existsSync(absPtr) && fs.statSync(absPtr).isDirectory() && !versionDirs.includes(absPtr)) {
            versionDirs.push(absPtr);
          }
        }
      }
    } catch (_) {}

    for (const vDir of versionDirs) {
      for (const bn of binNames) {
        const exts = isWin && !/\.(exe|cmd|bat)$/i.test(bn) ? ['.exe', '.cmd', ''] : [''];
        for (const ext of exts) {
          const cand = path.join(vDir, 'bin', bn + ext);
          try {
            if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
          } catch (_) {}
        }
      }
    }
  }
  return '';
}

function resolveBundledRuntime(cliId, binNames) {
  const isWin = process.platform === 'win32';
  const roots = [
    process.resourcesPath ? path.join(process.resourcesPath, 'runtimes') : '',
    path.resolve(__dirname, '..', 'vendor', 'runtimes'),
  ].filter(Boolean);
  for (const r of roots) {
    for (const bn of binNames) {
      const exts = isWin && !/\.(exe|cmd|bat)$/i.test(bn) ? ['.exe', '.cmd', ''] : [''];
      for (const ext of exts) {
        const cand = path.join(r, cliId, 'bin', bn + ext);
        try {
          if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
        } catch (_) {}
      }
    }
  }
  return '';
}

async function resolveCliBinary(provider, opts = {}) {
  const kind = providerKind(provider);
  const def = CLI_DEFS[kind] || { cliId: String((provider && provider.cliId) || ''), bins: [] };
  let preferredBin = String((provider && provider.cliBin) || '').trim();
  if ((kind === 'antigravity' || kind === 'agy' || kind === 'google') && path.basename(preferredBin).toLowerCase().startsWith('gemini')) {
    preferredBin = '';
  }
  const useCache = !opts.runtimes && !opts.resolveBin && !opts.userRuntimesDir && !opts.bypassCache;
  const cacheKey = `${kind}|${def.cliId || ''}|${preferredBin}|${process.env.AKRON_ISOLATE_RUNTIMES === '1' ? 'iso' : 'std'}`;
  if (useCache) {
    const cached = _binCache.get(cacheKey);
    if (cached && (Date.now() - cached.ts) < BIN_CACHE_TTL_MS && (!cached.val.bin || cached.val.source === 'missing' || fs.existsSync(cached.val.bin))) {
      return cached.val;
    }
  }
  const cacheAndReturn = (val) => {
    if (useCache && val && val.bin && val.source !== 'missing') {
      _binCache.set(cacheKey, { ts: Date.now(), val });
    }
    return val;
  };
  const candidates = preferredBin && !preferredBin.includes('/') && !preferredBin.includes('\\')
    ? [preferredBin, ...def.bins.filter((b) => b !== preferredBin)]
    : (preferredBin ? [path.basename(preferredBin), ...def.bins.filter((b) => b !== path.basename(preferredBin))] : [...def.bins]);
  const cliIds = [def.cliId, ...((def && Array.isArray(def.fallbackCliIds)) ? def.fallbackCliIds : [])].filter(Boolean);
  const primaryCliId = cliIds[0] || def.cliId || '';

  if (typeof opts.resolveBin === 'function') {
    const custom = await opts.resolveBin({ kind, cliId: primaryCliId, bins: candidates, provider });
    if (custom) return { kind, bin: custom, cliId: primaryCliId, source: 'custom' };
  }

  // Only honor an explicit full cliBin path immediately when it is NOT a bundled seed path
  // (stale bundled paths passed from old sessions must never shadow self-updated userData copies).
  if (preferredBin && (preferredBin.includes('/') || preferredBin.includes('\\')) && !isBundledSeedPath(preferredBin) && fs.existsSync(preferredBin)) {
    return cacheAndReturn({ kind, bin: preferredBin, cliId: primaryCliId, source: 'explicit' });
  }

  const binsForCid = (cid) => {
    if (cid === 'antigravity-cli') return ['agy', 'antigravity'];
    if (cid === 'gemini-cli') return ['gemini'];
    return candidates;
  };

  // Resolve each cliId in priority order across ALL tiers (self-updated -> userData -> bundled -> PATH)
  // before falling back to any secondary cliId (so antigravity-cli `agy` always beats legacy gemini-cli).
  const rt = opts.runtimes || getDefaultRuntimes();
  for (const cid of cliIds) {
    const cBins = binsForCid(cid);
    let rtBundled = null;
    if (rt && typeof rt.resolve === 'function') {
      try {
        const r = await rt.resolve(cid);
        if (r && r.source === 'installed' && r.bin && fs.existsSync(r.bin)) {
          return cacheAndReturn({ kind, bin: r.bin, cliId: cid, source: 'installed', version: r.version || '' });
        }
        if (r && r.bin && fs.existsSync(r.bin)) rtBundled = { ...r, cliId: cid };
      } catch (_) {}
    }

    const userDataBin = resolveUserDataRuntime(cid, cBins, opts);
    if (userDataBin) {
      return cacheAndReturn({ kind, bin: userDataBin, cliId: cid, source: 'installed' });
    }

    if (process.env.AKRON_ISOLATE_RUNTIMES === '1') {
      for (const bn of cBins) {
        const hit = whichOnPath(bn);
        if (hit) return cacheAndReturn({ kind, bin: hit, cliId: cid, source: 'system' });
      }
    }

    if (rtBundled && rtBundled.bin && fs.existsSync(rtBundled.bin)) {
      return cacheAndReturn({ kind, bin: rtBundled.bin, cliId: cid, source: rtBundled.source || 'bundled', version: rtBundled.version || '' });
    }

    const bundled = resolveBundledRuntime(cid, cBins);
    if (bundled) return cacheAndReturn({ kind, bin: bundled, cliId: cid, source: 'bundled' });

    for (const bn of cBins) {
      const hit = whichOnPath(bn);
      if (hit) return cacheAndReturn({ kind, bin: hit, cliId: cid, source: 'system' });
    }
  }

  // Explicit bundled seed fallback or remaining candidates on PATH
  if (preferredBin && (preferredBin.includes('/') || preferredBin.includes('\\')) && fs.existsSync(preferredBin)) {
    return cacheAndReturn({ kind, bin: preferredBin, cliId: primaryCliId, source: 'bundled' });
  }
  for (const bn of candidates) {
    const hit = whichOnPath(bn);
    if (hit) return cacheAndReturn({ kind, bin: hit, cliId: primaryCliId, source: 'system' });
  }
  return { kind, bin: candidates[0] || '', cliId: primaryCliId, source: 'missing' };
}

function formatMessagesPrompt(messages) {
  const sysParts = [];
  const convo = [];
  for (const m of messages || []) {
    if (!m || typeof m !== 'object') continue;
    const content = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).filter(Boolean).join('\n') : '');
    if (!content.trim()) continue;
    if (m.role === 'system' || m.role === 'developer') {
      sysParts.push(content.trim());
    } else if (m.role === 'user') {
      convo.push({ role: 'user', content });
    } else if (m.role === 'assistant') {
      convo.push({ role: 'assistant', content });
    }
  }
  const lastUserIdx = convo.map((c) => c.role).lastIndexOf('user');
  let prompt = '';
  if (convo.length <= 1) {
    prompt = (convo[0] && convo[0].content) || '';
  } else {
    const prior = convo.slice(0, Math.max(0, lastUserIdx)).map((c) => `${c.role === 'user' ? 'User' : 'Assistant'}: ${c.content}`).join('\n\n');
    const latest = (lastUserIdx >= 0 ? convo[lastUserIdx].content : convo[convo.length - 1].content) || '';
    prompt = prior ? `Previous conversation context:\n${prior}\n\nCurrent request:\n${latest}` : latest;
  }
  return { systemPrompt: sysParts.join('\n\n').slice(0, 12000), prompt };
}

function mapPermissionMode(kind, permissions) {
  const perm = String(permissions || 'auto').toLowerCase();
  if (kind === 'claude') {
    if (perm === 'plan') return 'plan';
    if (perm === 'bypass') return 'bypassPermissions';
    if (perm === 'acceptEdits' || perm === 'acceptedits') return 'acceptEdits';
    if (perm === 'ask' || perm === 'default') return 'default';
    return 'auto';
  }
  if (kind === 'chatgpt' || kind === 'codex') {
    if (perm === 'plan') return 'read-only';
    if (perm === 'bypass') return 'danger-full-access';
    return 'workspace-write';
  }
  if (kind === 'grok') {
    if (perm === 'plan') return 'plan';
    if (perm === 'bypass') return 'bypassPermissions';
    if (perm === 'ask') return 'default';
    return 'auto';
  }
  if (kind === 'antigravity' || kind === 'gemini' || kind === 'google') {
    if (perm === 'plan') return 'plan';
    if (perm === 'bypass') return 'yolo';
    return 'auto_edit';
  }
  if (kind === 'kimi' || kind === 'moonshot' || kind === 'kimi-code') {
    if (perm === 'plan') return 'plan';
    if (perm === 'acceptEdits' || perm === 'acceptedits') return 'yolo';
    return 'auto';
  }
  return 'auto';
}

function normalizeAgyModelSlug(model, reasoningLevel) {
  const m = String(model || '').trim();
  if (!m) return '';
  const low = m.toLowerCase();
  const rlRaw = String(reasoningLevel || '').toLowerCase().trim();
  const effort3 = ['low', 'medium', 'high'].includes(rlRaw) ? rlRaw : 'high';
  const effort4 = ['low', 'medium', 'high', 'xhigh'].includes(rlRaw) ? rlRaw : 'high';
  if (low === 'gemini-4-orchestrator' || low === 'orchestrator') return 'gemini-pro-orchestrator-neon';
  if (low === 'gemini-4-orchestrator-carbon') return 'gemini-pro-orchestrator';
  if (low === 'gemini-4-orchestrator-argon') return 'gemini-pro-orchestrator-argon';
  if (/^gemini-pro-orchestrator(?:-(?:neon|argon))?$/i.test(low)) return low;
  if (low === 'gemini-4-carbon' || low === 'gemini-4-carbon-xhigh') return `gemini-4-carbon-${effort3}`;
  if (low === 'gemini-4-argon' || low === 'gemini-4-argon-xhigh') return `gemini-4-argon-${effort3}`;
  if (low === 'gemini-4-neon') return `gemini-4-neon-${effort4}`;
  if (low === 'gemini-4-hydrogen') return `gemini-4-hydrogen-${effort4}`;
  if (low === 'gemini-4-hydrogen-sonar' || low === 'gemini-4-hydrogen-tiered-high') return 'gemini-4-hydrogen-high';
  if (low === 'gemini-4-hydrogen-tiered-xhigh') return 'gemini-4-hydrogen-xhigh';
  if (low === 'gemini-3.8-flash-tiered') return 'gemini-3.8-flash-high';
  if (low === 'gemini-flash-worker-agy') return 'gemini-3.8-flash-low';
  if (/^gemini-4-(?:carbon|argon|neon|hydrogen)-(?:low|medium|high|xhigh)$/i.test(low)) return low;
  if (/^gemini-3\.8-flash-(?:low|medium|high)$/i.test(low)) return low;
  if (/^gemini-3\.1-pro-preview$/i.test(low)) return 'gemini-4-carbon-high';
  if (/^gemini-(?:2\.5|3(?:\.[158])?)-flash/i.test(low)) return 'gemini-3.8-flash-high';
  if (/^gemini-2\.5-pro$/i.test(low) || /^gemini-(?:2\.5|3(?:\.[15])?)\b/i.test(low)) {
    return /flash/i.test(low) ? 'gemini-3.8-flash-high' : 'gemini-4-neon-high';
  }
  return m;
}

function normalizeKimiModelSlug(model) {
  const m = String(model || '').trim();
  if (!m) return '';
  if (m.includes('/')) return m;
  const low = m.toLowerCase();
  if (low === 'kimi-k3.1-pro') return 'kimi-code/k3.1-pro';
  if (low === 'kimi-k3') return 'kimi-code/k3';
  if (low === 'kimi-k3-256k') return 'kimi-code/k3-256k';
  if (low === 'kimi-k3.1-pro-highspeed') return 'kimi-code/k3.1-pro-highspeed';
  if (low === 'kimi-k2.7-highspeed' || low === 'kimi-for-coding-highspeed') return 'kimi-code/kimi-for-coding-highspeed';
  if (low === 'kimi-k2.8' || low === 'kimi-k2.6' || low === 'kimi-k2.5' || low === 'kimi-for-coding') return 'kimi-code/kimi-for-coding';
  return m;
}

function normalizeCopilotModelSlug(model) {
  const m = String(model || '').trim();
  if (!m) return 'auto';
  const low = m.toLowerCase();
  if (low === 'copilot-auto' || low === 'auto') return 'auto';
  if (low === 'copilot-claude-opus-4-6') return 'claude-opus-4.6';
  if (low === 'copilot-claude-sonnet-4-5') return 'claude-sonnet-4.5';
  if (low === 'copilot-gpt-5-4') return 'gpt-5.4';
  if (low === 'copilot-gpt-5') return 'gpt-5';
  if (low === 'copilot-gemini-3-1-pro') return 'gemini-3.1-pro';
  if (low.startsWith('copilot-')) return m.slice('copilot-'.length);
  return m;
}

function getCopilotMcpFlags(prompt = '', opts = {}) {
  const args = ['--no-auto-update'];
  const pText = String(prompt || '');
  const needsGhMcp = /\b(pull request|github issue|gh pr|gh issue|actions workflow|octokit)\b/i.test(pText);
  if (!needsGhMcp && opts.disableBuiltinMcps !== false) {
    args.push('--disable-builtin-mcps');
  }
  const needsRea = /\b(reverse[\s-]?engineer|decompile|disassembl|ghidra|radare|rizin|macho|apktool|frida|firmware)\b/i.test(pText);
  try {
    const cfgPath = opts.copilotMcpConfig || path.join(os.homedir(), '.copilot', 'mcp-config.json');
    if (fs.existsSync(cfgPath)) {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const servers = parsed && parsed.mcpServers && typeof parsed.mcpServers === 'object' ? Object.keys(parsed.mcpServers) : [];
      for (const sName of servers) {
        if (sName === 'rea' && needsRea) continue;
        args.push('--disable-mcp-server', sName);
      }
    }
  } catch (_) {}
  return args;
}

function ensureGeminiTrustedFolder(folderPath, opts = {}) {
  try {
    const rawFolder = String(folderPath || '').trim();
    if (!rawFolder) return false;
    const home = opts.homeDir || process.env.GEMINI_CLI_HOME || os.homedir();
    const geminiDir = path.join(home, '.gemini');
    const trustFile = path.join(geminiDir, 'trustedFolders.json');
    let cur = {};
    try {
      if (fs.existsSync(trustFile)) {
        const parsed = JSON.parse(fs.readFileSync(trustFile, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) cur = parsed;
      }
    } catch (_) {}
    const targets = new Set([path.resolve(rawFolder)]);
    try { targets.add(fs.realpathSync(rawFolder)); } catch (_) {}
    let changed = false;
    for (const t of targets) {
      if (cur[t] !== 'TRUST_FOLDER') {
        cur[t] = 'TRUST_FOLDER';
        changed = true;
      }
    }
    if (!changed) return true;
    fs.mkdirSync(geminiDir, { recursive: true });
    const tmp = `${trustFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, trustFile);
    return true;
  } catch (_) {
    return false;
  }
}

function stripBenignCliStderr(rawStderr) {
  const lines = String(rawStderr || '').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/Approval mode overridden to "default" because the current folder is not trusted/i.test(t)) continue;
    if (/^Loaded cached credentials\.?$/i.test(t)) continue;
    if (/^Fetching available models\.{0,3}$/i.test(t)) continue;
    if (/^YOLO mode is enabled\b/i.test(t)) continue;
    if (/^warning:\s+ignoring unsupported stream/i.test(t)) continue;
    if (/^warning:\s*--mode\s+\S+\s+is not available/i.test(t)) continue;
    if (/^Warning:\s*(?:Basic terminal detected|256-color support not detected)/i.test(t)) continue;
    if (/^Reading additional input from stdin\.{0,3}$/i.test(t)) continue;
    if (/^(?:Changes\s+[+-]\d+\s+[+-]\d+|AI Credits\s+[\d.]+|Tokens\s+↑|Resume\s+copilot\s+--resume=|To authenticate,\s+visit)/i.test(t)) continue;
    if (/^\(node:\d+\)\s*\[DEP\d+\]\s*DeprecationWarning:/i.test(t)) continue;
    if (/^\(Use `node --trace-deprecation/i.test(t)) continue;
    if (/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+(?:WARN|INFO)\s+/i.test(t)) continue;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function buildCliInvocation(kind, provider, prompt, systemPrompt, opts = {}) {
  const model = String((provider && provider.model) || '').trim();
  const cwd = opts.cwd || process.cwd();
  const isSingleTurn = opts.singleTurn === true;
  const binName = path.basename(String(opts.bin || '')).toLowerCase();

  if (kind === 'claude') {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (model && !opts.omitModel) args.push('--model', model);
    if (isSingleTurn) args.push('--max-turns', '1');
    if (systemPrompt && isSingleTurn === false) {
      args.push('--append-system-prompt', systemPrompt);
    } else if (systemPrompt && isSingleTurn) {
      args.push('--append-system-prompt', systemPrompt);
    }
    const pm = mapPermissionMode('claude', opts.permissions);
    if (pm === 'bypassPermissions') {
      args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
    } else if (pm) {
      args.push('--permission-mode', pm);
    }
    if (opts.noSessionPersistence !== false) args.push('--no-session-persistence');
    return args;
  }

  if (kind === 'chatgpt' || kind === 'codex') {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd];
    if (model && !opts.omitModel) args.push('-m', model);
    const sb = mapPermissionMode('codex', opts.permissions);
    if (sb === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', sb);
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    args.push(fullPrompt);
    return args;
  }

  if (kind === 'grok') {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', fullPrompt, '--output-format', 'streaming-json', '--cwd', cwd];
    if (model && !opts.omitModel) args.push('-m', model);
    if (isSingleTurn) args.push('--max-turns', '1');
    args.push('--permission-mode', mapPermissionMode('grok', opts.permissions));
    const rl = String((provider && provider.reasoningLevel) || '').toLowerCase();
    if (['low', 'medium', 'high'].includes(rl)) args.push('--reasoning-effort', rl);
    return args;
  }

  if (kind === 'kimi' || kind === 'moonshot' || kind === 'kimi-code') {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', fullPrompt, '--output-format', 'stream-json', '--add-dir', cwd];
    if (model && !opts.omitModel) args.push('-m', model);
    const kPerm = mapPermissionMode('kimi', opts.permissions);
    if (kPerm === 'plan') args.push('--plan');
    else if (kPerm === 'yolo') args.push('-y');
    else args.push('--auto');
    return args;
  }

  if (kind === 'copilot') {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', fullPrompt, '--output-format', 'json', '--no-color', '-C', cwd, ...getCopilotMcpFlags(fullPrompt)];
    const cModel = normalizeCopilotModelSlug(model);
    if (cModel && !opts.omitModel) args.push('--model', cModel);
    const perm = String(opts.permissions || 'auto').toLowerCase();
    if (perm === 'plan') args.push('--plan');
    else args.push('--yolo');
    const rl = String((provider && provider.reasoningLevel) || '').toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(rl)) args.push('--reasoning-effort', rl);
    return args;
  }

  if (kind === 'zcode') {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', fullPrompt];
    if (model && !opts.omitModel) args.push('-m', model);
    return args;
  }

  // Antigravity CLI (`agy`) vs Gemini CLI (`gemini`)
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const useAgy = binName.startsWith('agy') || binName.startsWith('antigravity') || (!binName && (kind === 'agy' || kind === 'antigravity'));
  if (useAgy) {
    const args = ['-p', fullPrompt, '--output-format', 'stream-json', '--add-dir', cwd];
    const agyModel = model ? normalizeAgyModelSlug(model, provider && provider.reasoningLevel) : '';
    if (agyModel && !opts.omitModel) args.push('--model', agyModel);
    if (isSingleTurn || opts.fastTurn) args.push('--disable-slash-commands');
    const perm = String(opts.permissions || 'auto').toLowerCase();
    if (perm === 'bypass' || perm === 'auto') args.push('--dangerously-skip-permissions');
    else if (perm === 'plan') args.push('--mode', 'plan');
    else if (perm === 'acceptedits') args.push('--mode', 'accept-edits');
    const rl = String((provider && provider.reasoningLevel) || '').toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(rl) && !/orchestrator/i.test(agyModel)) {
      args.push('--effort', rl);
    }
    return args;
  }

  const args = ['-p', fullPrompt, '-o', 'stream-json', '--skip-trust'];
  if (model && !opts.omitModel) args.push('-m', model);
  args.push('--approval-mode', mapPermissionMode('antigravity', opts.permissions));
  return args;
}

function killChildTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      try {
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        return;
      } catch (_) {}
    }
    child.kill('SIGTERM');
    const t = setTimeout(() => {
      try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {}
    }, 250);
    if (t && typeof t.unref === 'function') t.unref();
  } catch (_) {}
}

function extractFileEditPath(name, args) {
  const lowName = String(name || '').toLowerCase();
  if (!args || typeof args !== 'object') return '';
  if (/^(write|edit|multiedit|applypatch|notebookedit|file_edit|fileedit|patch|write_to_file|replace_file_content|multi_replace_file_content)/.test(lowName)) {
    return String(args.file_path || args.TargetFile || args.path || args.target_file || args.file || '');
  }
  return '';
}

function parseNdjsonEvent(ev, state, emitEvt, onDelta, onToolDelta) {
  if (!ev || typeof ev !== 'object') return;
  const t = String(ev.type || '');
  const agyEv = String(ev.event || '');

  // Antigravity CLI (`agy`) `--output-format stream-json` NDJSON events (`init`, `step_update`, `result`)
  if (agyEv) {
    if (agyEv === 'init' && ev.init && ev.init.model) {
      state.model = String(ev.init.model);
      return;
    }
    if (agyEv === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
      const su = ev.step_update;
      if (su.step_type === 'agent_response' && typeof su.text_delta === 'string' && su.text_delta) {
        state.streamedText += su.text_delta;
        onDelta(su.text_delta, false);
        emitEvt({ type: 'text', text: su.text_delta });
      } else if (su.step_type === 'thinking' && typeof su.text_delta === 'string' && su.text_delta) {
        onDelta(su.text_delta, true);
        emitEvt({ type: 'thinking', text: su.text_delta });
      } else if (su.step_type === 'tool' && su.tool_info) {
        const ti = su.tool_info;
        const tName = ti.name || su.tool_name || 'tool';
        const args = ti.parameters || ti.arguments || {};
        const stepId = `agy:${su.step_index != null ? su.step_index : tName}`;
        if (!state.seenToolIds.has(stepId)) {
          state.seenToolIds.add(stepId);
          const filePath = extractFileEditPath(tName, args);
          if (filePath) emitEvt({ type: 'file_edit', path: filePath, tool: tName });
          emitEvt({ type: 'tool_use', id: stepId, name: tName, args });
          emitEvt({ type: 'tool', id: stepId, name: tName, args });
        }
        if (su.state === 'DONE') {
          const isErr = Boolean(ti.error);
          const resStr = isErr
            ? String((ti.error && ti.error.message) || ti.error || 'tool error')
            : String(ti.output || '');
          emitEvt({ type: 'toolResult', id: stepId, name: tName, result: resStr, isError: isErr });
        }
      }
      if (su.usage && typeof su.usage === 'object') {
        const inTok = Number(su.usage.input_tokens) || 0;
        const outTok = Number(su.usage.output_tokens) || 0;
        state.usage = {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: Number(su.usage.total_tokens) || (inTok + outTok),
        };
      }
      return;
    }
    if (agyEv === 'result' && ev.result && typeof ev.result === 'object') {
      const r = ev.result;
      if (r.status && r.status !== 'SUCCESS') {
        state.cliError = String(r.error || `Antigravity CLI exited with status ${r.status}`);
      } else if (typeof r.response === 'string' && r.response) {
        state.resultText = r.response;
        if (!state.streamedText && !state.finalText) {
          onDelta(r.response, false);
          emitEvt({ type: 'text', text: r.response });
        }
      }
      if (r.usage && typeof r.usage === 'object') {
        const inTok = Number(r.usage.input_tokens) || 0;
        const outTok = Number(r.usage.output_tokens) || 0;
        state.usage = {
          input_tokens: inTok,
          output_tokens: outTok,
          total_tokens: Number(r.usage.total_tokens) || (inTok + outTok),
        };
      }
      return;
    }
  }

  // Claude stream-json / Gemini stream-json / generic NDJSON events
  if (t === 'stream_event' && ev.event && typeof ev.event === 'object') {
    const e = ev.event;
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta' && typeof e.delta.text === 'string') {
        state.streamedText += e.delta.text;
        onDelta(e.delta.text, false);
        emitEvt({ type: 'text', text: e.delta.text });
      } else if (e.delta.type === 'thinking_delta' && typeof e.delta.thinking === 'string') {
        onDelta(e.delta.thinking, true);
        emitEvt({ type: 'thinking', text: e.delta.thinking });
      } else if (e.delta.type === 'input_json_delta' && typeof e.delta.partial_json === 'string' && onToolDelta) {
        onToolDelta({ index: e.index, partialJson: e.delta.partial_json });
      }
    } else if (e.type === 'content_block_start' && e.content_block && e.content_block.type === 'tool_use') {
      const b = e.content_block;
      const filePath = extractFileEditPath(b.name, b.input);
      if (filePath) emitEvt({ type: 'file_edit', path: filePath, tool: b.name });
      emitEvt({ type: 'tool_use', id: b.id || '', name: b.name || '', args: b.input || {} });
      emitEvt({ type: 'tool', id: b.id || '', name: b.name || '', args: b.input || {} });
    } else if (e.type === 'message_start' && e.message && e.message.model) {
      state.model = String(e.message.model);
    } else if (e.type === 'message_delta' && e.usage) {
      state.usage = {
        input_tokens: Number(e.usage.input_tokens) || 0,
        output_tokens: Number(e.usage.output_tokens) || 0,
        total_tokens: (Number(e.usage.input_tokens) || 0) + (Number(e.usage.output_tokens) || 0),
      };
    }
    return;
  }

  if (t === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    if (ev.message.model) state.model = String(ev.message.model);
    for (const block of ev.message.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'thinking' && block.thinking && !state.seenAssistantIds.has(`th:${block.thinking.length}:${ev.uuid || ''}`)) {
        state.seenAssistantIds.add(`th:${block.thinking.length}:${ev.uuid || ''}`);
        emitEvt({ type: 'thinking', text: String(block.thinking) });
      } else if (block.type === 'tool_use') {
        const key = block.id || `${block.name}:${JSON.stringify(block.input || {})}`;
        if (!state.seenToolIds.has(key)) {
          state.seenToolIds.add(key);
          const args = block.input || {};
          const filePath = extractFileEditPath(block.name, args);
          if (filePath) emitEvt({ type: 'file_edit', path: filePath, tool: block.name });
          emitEvt({ type: 'tool_use', id: key, name: block.name || 'tool', args });
          emitEvt({ type: 'tool', id: key, name: block.name || 'tool', args });
        }
      } else if (block.type === 'text' && typeof block.text === 'string' && block.text && !state.streamedText) {
        state.finalText = block.text;
        onDelta(block.text, false);
        emitEvt({ type: 'text', text: block.text });
      }
    }
    return;
  }

  if (t === 'user' && ev.message && Array.isArray(ev.message.content)) {
    for (const block of ev.message.content) {
      if (block && block.type === 'tool_result') {
        const out = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '');
        emitEvt({ type: 'toolResult', id: block.tool_use_id || '', result: out, isError: Boolean(block.is_error) });
      }
    }
    return;
  }

  if (t === 'rate_limit_event') {
    const info = ev.rate_limit_info || {};
    emitEvt({ type: 'rate_limit', info });
    if (info.status && info.status !== 'allowed' && info.status !== 'allowed_warning') {
      state.rateLimitError = `CLI rate limit (${info.rateLimitType || info.status})`;
    }
    return;
  }

  if (t === 'result') {
    if (ev.is_error) {
      state.cliError = String(ev.error || ev.result || 'CLI returned an error');
    } else if (typeof ev.result === 'string' && ev.result) {
      state.resultText = ev.result;
      if (!state.streamedText && !state.finalText) {
        onDelta(ev.result, false);
        emitEvt({ type: 'text', text: ev.result });
      }
    }
    if (ev.usage && typeof ev.usage === 'object') {
      const inTok = Number(ev.usage.input_tokens || ev.usage.prompt_tokens) || 0;
      const outTok = Number(ev.usage.output_tokens || ev.usage.completion_tokens) || 0;
      state.usage = {
        input_tokens: inTok,
        output_tokens: outTok,
        total_tokens: Number(ev.usage.total_tokens) || (inTok + outTok),
      };
    } else if (ev.stats && typeof ev.stats === 'object') {
      const inTok = Number(ev.stats.input_tokens) || 0;
      const outTok = Number(ev.stats.output_tokens) || 0;
      state.usage = { input_tokens: inTok, output_tokens: outTok, total_tokens: Number(ev.stats.total_tokens) || (inTok + outTok) };
    }
    return;
  }

  // Codex CLI `--json` NDJSON schema
  if ((t === 'item.completed' || t === 'item.started') && ev.item && typeof ev.item === 'object') {
    const it = ev.item;
    if (it.type === 'agent_message' && typeof it.text === 'string' && it.text) {
      state.streamedText += (state.streamedText ? '\n' : '') + it.text;
      onDelta(it.text, false);
      emitEvt({ type: 'text', text: it.text });
    } else if (it.type === 'reasoning' && typeof it.text === 'string' && it.text) {
      onDelta(it.text, true);
      emitEvt({ type: 'thinking', text: it.text });
    } else if (it.type === 'file_change' && Array.isArray(it.changes)) {
      for (const ch of it.changes) {
        if (ch && ch.path) emitEvt({ type: 'file_edit', path: ch.path, kind: ch.kind || 'update' });
      }
    } else if (it.type === 'command_execution' || it.type === 'mcp_tool_call') {
      const toolName = it.type === 'command_execution' ? 'Bash' : (it.tool || it.name || 'mcp');
      const args = it.type === 'command_execution' ? { command: it.command || '' } : (it.arguments || {});
      if (t === 'item.started') {
        emitEvt({ type: 'tool_use', id: it.id || '', name: toolName, args });
        emitEvt({ type: 'tool', id: it.id || '', name: toolName, args });
      } else {
        emitEvt({ type: 'toolResult', id: it.id || '', name: toolName, result: String(it.aggregated_output || it.result || ''), isError: Number(it.exit_code || 0) !== 0 });
      }
    }
    return;
  }
  if (t === 'turn.completed' && ev.usage) {
    const inTok = Number(ev.usage.input_tokens) || 0;
    const outTok = Number(ev.usage.output_tokens) || 0;
    state.usage = { input_tokens: inTok, output_tokens: outTok, total_tokens: inTok + outTok };
    return;
  }

  // Kimi Code CLI `stream-json` assistant / content / tool_calls events
  if (ev.role === 'assistant' && !ev.message) {
    if (typeof ev.reasoning_content === 'string' && ev.reasoning_content) {
      onDelta(ev.reasoning_content, true);
      emitEvt({ type: 'thinking', text: ev.reasoning_content });
    }
    if (typeof ev.content === 'string' && ev.content) {
      state.streamedText += ev.content;
      onDelta(ev.content, false);
      emitEvt({ type: 'text', text: ev.content });
    } else if (Array.isArray(ev.content)) {
      for (const part of ev.content) {
        if (!part || typeof part !== 'object') continue;
        if ((part.type === 'think' || part.type === 'thinking') && (part.think || part.thinking || part.text)) {
          const th = String(part.think || part.thinking || part.text);
          onDelta(th, true);
          emitEvt({ type: 'thinking', text: th });
        } else if (part.type === 'text' && typeof part.text === 'string' && part.text) {
          state.streamedText += part.text;
          onDelta(part.text, false);
          emitEvt({ type: 'text', text: part.text });
        }
      }
    }
    if (Array.isArray(ev.tool_calls)) {
      for (const tc of ev.tool_calls) {
        if (!tc) continue;
        const name = (tc.function && tc.function.name) || tc.name || 'tool';
        let args = (tc.function && tc.function.arguments) || tc.arguments || tc.input || {};
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch (_) { args = {}; }
        }
        const filePath = extractFileEditPath(name, args);
        if (filePath) emitEvt({ type: 'file_edit', path: filePath, tool: name });
        emitEvt({ type: 'tool_use', id: tc.id || '', name, args });
        emitEvt({ type: 'tool', id: tc.id || '', name, args });
      }
    }
    return;
  }

  // Normalized / Grok / Gemini streaming-json fallback events
  if (t === 'thinking' && typeof ev.text === 'string') {
    onDelta(ev.text, true);
    emitEvt({ type: 'thinking', text: ev.text });
  } else if ((t === 'delta' || t === 'text' || t === 'message') && (typeof ev.text === 'string' || typeof ev.content === 'string')) {
    const txt = typeof ev.text === 'string' ? ev.text : ev.content;
    if (ev.role !== 'user' && txt) {
      state.streamedText += txt;
      onDelta(txt, false);
      emitEvt({ type: 'text', text: txt });
    }
  } else if (t === 'tool_use') {
    const args = ev.args || ev.input || {};
    const filePath = extractFileEditPath(ev.name, args);
    if (filePath) emitEvt({ type: 'file_edit', path: filePath, tool: ev.name });
    emitEvt({ type: 'tool_use', id: ev.id || '', name: ev.name || '', args });
    emitEvt({ type: 'tool', id: ev.id || '', name: ev.name || '', args });
  } else if (t === 'file_edit' && ev.path) {
    emitEvt({ type: 'file_edit', path: ev.path, tool: ev.tool || 'Edit' });
  } else if (t === 'error' || t === 'turn.failed') {
    state.cliError = String((ev.error && ev.error.message) || ev.message || 'CLI execution failed');
  }

  // GitHub Copilot CLI `--output-format json` JSONL schema
  if (t === 'assistant.message_delta' && ev.data && typeof ev.data.deltaContent === 'string' && ev.data.deltaContent) {
    state.streamedText += ev.data.deltaContent;
    onDelta(ev.data.deltaContent, false);
    emitEvt({ type: 'text', text: ev.data.deltaContent });
    return;
  }
  if (t === 'assistant.message' && ev.data && typeof ev.data.content === 'string') {
    if (ev.data.model) state.model = ev.data.model;
    if (ev.data.content) {
      state.finalText = ev.data.content;
      if (!state.streamedText) {
        onDelta(ev.data.content, false);
        emitEvt({ type: 'text', text: ev.data.content });
      }
    }
    if (Array.isArray(ev.data.toolRequests)) {
      for (const tr of ev.data.toolRequests) {
        if (!tr || state.seenToolIds.has(tr.toolCallId || tr.id || tr.name)) continue;
        state.seenToolIds.add(tr.toolCallId || tr.id || tr.name);
        const name = tr.name || 'tool';
        const args = tr.arguments || {};
        const filePath = extractFileEditPath(name, args);
        if (filePath) emitEvt({ type: 'file_edit', path: filePath, tool: name });
        emitEvt({ type: 'tool_use', id: tr.toolCallId || '', name, args });
        emitEvt({ type: 'tool', id: tr.toolCallId || '', name, args });
      }
    }
    return;
  }
  if (t === 'session.auto_mode_resolved' && ev.data && Array.isArray(ev.data.availableModels)) {
    try {
      const mc = require('./model-catalog');
      const items = ev.data.availableModels
        .filter((id) => typeof id === 'string' && id.trim())
        .map((id) => ({ id: id.startsWith('copilot-') ? id : `copilot-${id.replace(/\./g, '-')}`, label: id, contextWindow: 1000000 }));
      if (items.length && mc && typeof mc.register === 'function') mc.register('copilot', items);
    } catch (_) {}
    return;
  }
}

function isOutdatedCliError(text) {
  const s = String(text || '');
  return /\b426\b|upgrade\s+required|client\s+version.*(?:outdated|unsupported|too\s+old|must\s+be\s+updated)|minimum\s+supported\s+version|please\s+(?:upgrade|update)\s+(?:your\s+)?(?:grok|claude|codex|gemini|agy|antigravity|kimi)|version\s+[0-9.]+\s+(?:or\s+newer\s+)?is\s+required/i.test(s);
}

async function selfHealOutdatedCli(resolved, { runtimes = null, selfHealUpdate = null, spawnImpl = null } = {}) {
  invalidateCliBinaryCache(resolved && resolved.kind);
  if (typeof selfHealUpdate === 'function') {
    return selfHealUpdate(resolved);
  }
  const rt = runtimes || getDefaultRuntimes();
  if (rt && resolved && resolved.cliId && typeof rt.install === 'function') {
    try {
      return await rt.install(resolved.cliId, undefined, { force: true });
    } catch (_) {}
  }
  if (resolved && resolved.bin && fs.existsSync(resolved.bin)) {
    const effSpawn = spawnImpl || spawn;
    await new Promise((resolve) => {
      try {
        const child = effSpawn(resolved.bin, ['update'], { stdio: 'ignore', windowsHide: true });
        const t = setTimeout(() => { killChildTree(child); resolve(); }, 60000);
        if (t && typeof t.unref === 'function') t.unref();
        child.on('exit', () => { clearTimeout(t); resolve(); });
        child.on('error', () => { clearTimeout(t); resolve(); });
      } catch (_) { resolve(); }
    });
  }
  return null;
}

const WARM_POOL_TTL_MS = 90 * 1000;
const _warmPool = new Map(); // poolKey -> entry
const _warmPoolFlights = new Map();

function buildCliRuntimeEnv(kind, binBase, provider = {}) {
  const env = { ...process.env };
  if (!env.TERM || env.TERM === 'dumb') env.TERM = 'xterm-256color';
  if (!env.COLORTERM) env.COLORTERM = 'truecolor';
  if (process.platform !== 'win32') {
    const curPath = String(env.PATH || '');
    const parts = curPath.split(path.delimiter).filter(Boolean);
    for (const d of ['/opt/homebrew/bin', '/usr/local/bin']) {
      if (!parts.includes(d) && fs.existsSync(d)) parts.push(d);
    }
    env.PATH = parts.join(path.delimiter);
  }
  if (kind === 'claude' && !String((provider && provider.apiKey) || '').trim()) {
    delete env.ANTHROPIC_API_KEY;
  }
  if (binBase.startsWith('gemini') && String((provider && provider.apiKey) || '').trim()) {
    env.GEMINI_API_KEY = String(provider.apiKey).trim();
  }
  if (kind === 'copilot') {
    env.COPILOT_AUTO_UPDATE = 'false';
    const cTok = String((provider && provider.copilotToken) || '').trim();
    if (cTok) env.COPILOT_GITHUB_TOKEN = cTok;
  }
  return env;
}

function warmPoolKey(kind, bin, cwd, model, permissions) {
  return [
    String(kind || ''),
    String(bin || ''),
    path.resolve(String(cwd || process.cwd())),
    String(model || ''),
    String(permissions || 'auto').toLowerCase(),
  ].join('|');
}

function disposeWarmEntry(entry) {
  if (!entry) return;
  if (entry.idleTimer) { try { clearTimeout(entry.idleTimer); } catch (_) {} entry.idleTimer = null; }
  if (entry.child) { try { killChildTree(entry.child); } catch (_) {} entry.child = null; }
}

function clearWarmCliPool(onlyKind = '') {
  const low = String(onlyKind || '').toLowerCase();
  for (const [k, entry] of [..._warmPool.entries()]) {
    if (low && !k.startsWith(low + '|')) continue;
    _warmPool.delete(k);
    disposeWarmEntry(entry);
  }
}

function getWarmCliPoolStats() {
  const keys = [];
  for (const [k, entry] of _warmPool.entries()) {
    keys.push({
      key: k,
      kind: entry.kind,
      model: entry.model,
      cwd: entry.cwd,
      ageMs: Date.now() - entry.createdAt,
      alive: Boolean(entry.child && entry.child.exitCode == null && !entry.child.killed),
    });
  }
  return { size: keys.length, entries: keys };
}

function warmSpecForKind(kind, binToRun, provider, { cwd, permissions, mcpConfigFile } = {}) {
  const model = String((provider && provider.model) || '').trim();
  const binBase = path.basename(String(binToRun || '')).toLowerCase();
  const perm = String(permissions || 'auto').toLowerCase();

  if (kind === 'claude') {
    const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (model) args.push('--model', model);
    const pm = mapPermissionMode('claude', perm);
    if (pm === 'bypassPermissions') args.push('--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions');
    else if (pm) args.push('--permission-mode', pm);
    args.push('--setting-sources', '', '--strict-mcp-config', '--mcp-config', mcpConfigFile || writeIsolatedMcpConfigFile());
    args.push('--no-session-persistence');
    return { protocol: 'claude-stream-json', args };
  }

  if ((kind === 'antigravity' || kind === 'agy' || kind === 'google') && (binBase.startsWith('agy') || binBase.startsWith('antigravity'))) {
    const agyModel = model ? normalizeAgyModelSlug(model, provider && provider.reasoningLevel) : '';
    const args = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands', '--add-dir', cwd];
    if (agyModel) args.push('--model', agyModel);
    if (perm === 'bypass' || perm === 'auto') args.push('--dangerously-skip-permissions');
    else if (perm === 'plan') args.push('--mode', 'plan');
    else if (perm === 'acceptedits') args.push('--mode', 'accept-edits');
    args.push('-p=');
    return { protocol: 'agy-stream-json', args };
  }

  if (kind === 'chatgpt' || kind === 'codex') {
    const args = ['exec', '--json', '--skip-git-repo-check', '-C', cwd];
    if (model) args.push('-m', model);
    const sb = mapPermissionMode('codex', perm);
    if (sb === 'danger-full-access') args.push('--dangerously-bypass-approvals-and-sandbox');
    else args.push('-s', sb);
    args.push('-');
    return { protocol: 'codex-stdin', args };
  }

  if (kind === 'copilot') {
    const wireModel = normalizeCopilotModelSlug(model);
    const args = ['--acp', ...getCopilotMcpFlags('')];
    if (wireModel && wireModel !== 'auto') args.push('--model', wireModel);
    if (perm === 'plan') args.push('--plan');
    else args.push('--yolo');
    const rl = String((provider && provider.reasoningLevel) || '').toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(rl)) args.push('--reasoning-effort', rl);
    return { protocol: 'copilot-acp', args };
  }

  return null;
}

async function warmCliWorker(provider, opts = {}) {
  if (!provider || typeof provider !== 'object') return null;
  if (process.env.AKRON_DISABLE_WARM_CLI === '1') return null;
  if (process.env.NODE_TEST_CONTEXT && opts.forceWarmPool !== true) return null;

  const cwd = opts.cwd || process.cwd();
  const permissions = opts.permissions || 'auto';
  const resolved = await resolveCliBinary(provider, { runtimes: opts.runtimes, resolveBin: opts.resolveBin, userRuntimesDir: opts.userRuntimesDir });
  if (!resolved || !resolved.bin || !fs.existsSync(resolved.bin)) return null;

  const kind = resolved.kind;
  const binBase = path.basename(String(resolved.bin)).toLowerCase();
  if (kind === 'antigravity' || binBase.startsWith('gemini')) {
    ensureGeminiTrustedFolder(cwd);
  }
  const model = String((provider && provider.model) || '').trim();
  const k = warmPoolKey(kind, resolved.bin, cwd, model, permissions);
  const existing = _warmPool.get(k);
  if (existing && existing.child && existing.child.exitCode == null && !existing.child.killed) {
    return existing;
  }
  if (_warmPoolFlights.has(k)) return _warmPoolFlights.get(k);

  const task = (async () => {
    try {
      const mcpConfigFile = kind === 'claude' ? writeIsolatedMcpConfigFile({ includeInternalRea: false }) : '';
      const spec = warmSpecForKind(kind, resolved.bin, provider, { cwd, permissions, mcpConfigFile });
      if (!spec) {
        // Pre-warm OS page cache & trust config for non-persistent CLIs (grok, kimi, gemini)
        try {
          const prime = (opts.spawnImpl || spawn)(resolved.bin, ['--version'], { cwd, stdio: 'ignore', windowsHide: true });
          const pt = setTimeout(() => { try { prime.kill(); } catch (_) {} }, 1500);
          if (pt && typeof pt.unref === 'function') pt.unref();
          if (prime && typeof prime.unref === 'function') prime.unref();
        } catch (_) {}
        return null;
      }

      // Evict oldest warm process if pool exceeds 4 idle slots to keep RAM tight
      while (_warmPool.size >= 4) {
        const firstKey = _warmPool.keys().next().value;
        const old = _warmPool.get(firstKey);
        _warmPool.delete(firstKey);
        disposeWarmEntry(old);
      }

      const env = buildCliRuntimeEnv(kind, binBase, provider);
      if (resolved.bin === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
      const child = (opts.spawnImpl || spawn)(resolved.bin, spec.args, {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const entry = {
        key: k,
        kind,
        bin: resolved.bin,
        cwd,
        model,
        protocol: spec.protocol,
        child,
        createdAt: Date.now(),
        preBufferedStdout: '',
        preBufferedStderr: '',
        alive: true,
        idleTimer: null,
        onStdout: null,
        onStderr: null,
        onExit: null,
        acpSessionId: '',
        acpReadyPromise: null,
      };
      let resolveAcpReady = null;
      let acpLineBuf = '';
      if (spec.protocol === 'copilot-acp') {
        entry.acpReadyPromise = new Promise((r) => { resolveAcpReady = r; });
        const acpTimeout = setTimeout(() => {
          if (resolveAcpReady) { const fn = resolveAcpReady; resolveAcpReady = null; fn(''); }
        }, 12000);
        if (acpTimeout && typeof acpTimeout.unref === 'function') acpTimeout.unref();
        entry.onStdout = (d) => {
          const chunk = d.toString('utf8');
          acpLineBuf += chunk;
          let nl;
          while ((nl = acpLineBuf.indexOf('\n')) !== -1) {
            const ln = acpLineBuf.slice(0, nl).trim();
            acpLineBuf = acpLineBuf.slice(nl + 1);
            if (!ln || ln[0] !== '{') continue;
            try {
              const msg = JSON.parse(ln);
              if (msg.id === 1 && child.stdin && child.stdin.writable) {
                child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd, mcpServers: [] } }) + '\n');
              } else if (msg.id === 2) {
                clearTimeout(acpTimeout);
                const sid = String((msg.result && msg.result.sessionId) || '');
                entry.acpSessionId = sid;
                if (resolveAcpReady) { const fn = resolveAcpReady; resolveAcpReady = null; fn(sid); }
              }
            } catch (_) {}
          }
        };
      } else {
        entry.onStdout = (d) => {
          if (entry.preBufferedStdout.length < 65536) entry.preBufferedStdout += d.toString('utf8');
        };
      }
      entry.onStderr = (d) => {
        if (entry.preBufferedStderr.length < 16384) entry.preBufferedStderr += d.toString('utf8');
      };
      entry.onExit = () => {
        entry.alive = false;
        if (resolveAcpReady) { const fn = resolveAcpReady; resolveAcpReady = null; fn(''); }
        if (_warmPool.get(k) === entry) {
          _warmPool.delete(k);
          if (entry.idleTimer) { try { clearTimeout(entry.idleTimer); } catch (_) {} entry.idleTimer = null; }
        }
      };
      if (child.stdout) child.stdout.on('data', entry.onStdout);
      if (child.stderr) child.stderr.on('data', entry.onStderr);
      child.once('exit', entry.onExit);
      child.once('error', entry.onExit);
      if (child.stdin) child.stdin.on('error', () => {});

      if (spec.protocol === 'copilot-acp' && child.stdin && child.stdin.writable) {
        try {
          child.stdin.write(JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'akron-code', version: '1.7.0' } },
          }) + '\n');
        } catch (_) {}
      }

      entry.idleTimer = setTimeout(() => {
        if (_warmPool.get(k) === entry) {
          _warmPool.delete(k);
          disposeWarmEntry(entry);
        }
      }, Number(opts.warmTtlMs) || WARM_POOL_TTL_MS);
      if (entry.idleTimer && typeof entry.idleTimer.unref === 'function') entry.idleTimer.unref();

      _warmPool.set(k, entry);
      return entry;
    } catch (_) {
      return null;
    } finally {
      _warmPoolFlights.delete(k);
    }
  })();

  _warmPoolFlights.set(k, task);
  return task;
}

function acquireWarmWorker(kind, binToRun, cwd, model, permissions) {
  const k = warmPoolKey(kind, binToRun, cwd, model, permissions);
  const entry = _warmPool.get(k);
  if (!entry) return null;
  _warmPool.delete(k);
  if (entry.idleTimer) { try { clearTimeout(entry.idleTimer); } catch (_) {} entry.idleTimer = null; }
  const c = entry.child;
  if (!c || !entry.alive || c.exitCode != null || c.killed || !c.stdin || c.stdin.destroyed || c.stdin.writable === false) {
    disposeWarmEntry(entry);
    return null;
  }
  try {
    if (c.stdout && entry.onStdout) c.stdout.off('data', entry.onStdout);
    if (c.stderr && entry.onStderr) c.stderr.off('data', entry.onStderr);
    if (entry.onExit) {
      c.off('exit', entry.onExit);
      c.off('error', entry.onExit);
    }
  } catch (_) {}
  entry.child = null;
  return {
    child: c,
    protocol: entry.protocol,
    preBufferedStdout: entry.preBufferedStdout,
    preBufferedStderr: entry.preBufferedStderr,
    acpSessionId: entry.acpSessionId || '',
    acpReadyPromise: entry.acpReadyPromise || null,
  };
}

async function runCliTurn({
  provider,
  messages,
  onDelta = () => {},
  onToolDelta = null,
  emit = () => {},
  signal = null,
  cwd = process.cwd(),
  permissions = 'auto',
  singleTurn = false,
  fastTurn = false,
  runtimes = null,
  resolveBin = null,
  selfHealUpdate = null,
  userRuntimesDir = '',
  spawnImpl = null,
  timeoutMs = 0,
  forceWarmPool = false,
  inheritGlobalClaudePlugins = false,
}) {
  if (signal && signal.aborted) {
    throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  }

  let resolved = await resolveCliBinary(provider, { runtimes, resolveBin, userRuntimesDir });
  if (!resolved.bin) {
    const err = new Error(`No CLI runtime binary found for provider "${provider && provider.model || resolved.kind}".`);
    err.code = 'cli_binary_missing';
    throw err;
  }

  const { systemPrompt, prompt } = formatMessagesPrompt(messages);
  const effectiveSpawn = spawnImpl || spawn;
  const runOnce = async (omitModel, binToRun = resolved.bin) => {
    const binBase = path.basename(String(binToRun || '')).toLowerCase();
    if (resolved.kind === 'antigravity' || binBase.startsWith('gemini')) {
      ensureGeminiTrustedFolder(cwd);
    }
    const modelStr = String((provider && provider.model) || '').trim();
    const wantWarm = !omitModel && (!spawnImpl || forceWarmPool === true);
    let warm = wantWarm ? acquireWarmWorker(resolved.kind, binToRun, cwd, modelStr, permissions) : null;
    let acpSessionId = '';
    if (warm && warm.protocol === 'copilot-acp') {
      acpSessionId = warm.acpSessionId || (warm.acpReadyPromise
        ? await Promise.race([warm.acpReadyPromise, new Promise((r) => setTimeout(() => r(''), 6000))])
        : '');
      if (!acpSessionId) {
        killChildTree(warm.child);
        warm = null;
      }
    }

    return new Promise((resolve, reject) => {
    const state = {
      model: String((provider && provider.model) || resolved.kind),
      streamedText: '',
      finalText: '',
      resultText: '',
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      seenToolIds: new Set(),
      seenAssistantIds: new Set(),
      cliError: '',
      rateLimitError: '',
    };

    let child;
    let buf = '';
    let stderrBuf = '';
    const isCopilotAcp = Boolean(warm && warm.child && warm.protocol === 'copilot-acp' && acpSessionId);
    if (warm && warm.child) {
      child = warm.child;
      buf = warm.preBufferedStdout || '';
      stderrBuf = warm.preBufferedStderr || '';
      const warmPrompt = systemPrompt ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${prompt}` : prompt;
      if (!isCopilotAcp) {
        try {
          if (warm.protocol === 'claude-stream-json') {
            child.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: warmPrompt } }) + '\n');
            child.stdin.end();
          } else if (warm.protocol === 'agy-stream-json') {
            child.stdin.write(JSON.stringify({ event: 'user', message: { role: 'user', content: warmPrompt } }) + '\n');
            child.stdin.end();
          } else {
            child.stdin.write(warmPrompt + '\n');
            child.stdin.end();
          }
        } catch (_) {}
      }
    } else {
      let args = buildCliInvocation(resolved.kind, provider, prompt, systemPrompt, {
        cwd,
        permissions,
        singleTurn,
        fastTurn,
        bin: binToRun,
        omitModel,
      });
      if (resolved.kind === 'claude' && inheritGlobalClaudePlugins !== true) {
        const needsRea = /\b(reverse[\s-]?engineer|decompile|disassembl|ghidra|radare|rizin|macho|apktool|frida|firmware)\b/i.test(prompt);
        const mcpCfg = writeIsolatedMcpConfigFile({ includeRea: needsRea });
        if (!args.includes('--setting-sources')) args.push('--setting-sources', '');
        if (!args.includes('--strict-mcp-config')) args.push('--strict-mcp-config', '--mcp-config', mcpCfg);
        if ((singleTurn || fastTurn) && !args.includes('--disable-slash-commands')) {
          args.push('--disable-slash-commands');
          if (!args.includes('--effort')) args.push('--effort', 'low');
        }
      }
      if (resolved.kind === 'kimi') {
        args = args.filter((a) => a !== '--auto' && a !== '-y' && a !== '--yolo');
        const mi = args.indexOf('-m');
        if (mi >= 0 && args[mi + 1]) args[mi + 1] = normalizeKimiModelSlug(args[mi + 1]);
      }
      const env = buildCliRuntimeEnv(resolved.kind, binBase, provider);
      if (binToRun === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';

      child = effectiveSpawn(binToRun, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    }

    let settled = false;
    let timer = null;
    const onAbort = () => {
      killChildTree(child);
      cleanup();
      if (!settled) {
        settled = true;
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
      }
    };
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (signal) {
        try { signal.removeEventListener('abort', onAbort); } catch (_) {}
      }
    };

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const maxMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : (Number(process.env.AKRON_CLI_TIMEOUT_MS) || 300000);
    if (maxMs > 0) {
      timer = setTimeout(() => {
        killChildTree(child);
        cleanup();
        if (!settled) {
          settled = true;
          const err = new Error(`${resolved.kind} CLI timed out after ${Math.round(maxMs / 1000)}s`);
          err.transient = true;
          reject(err);
        }
      }, maxMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }

    const forwardEmit = (e) => {
      try { emit(e); } catch (_) {}
    };

    const handleLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (trimmed[0] !== '{') {
        state.streamedText += (state.streamedText ? '\n' : '') + line;
        onDelta(line, false);
        forwardEmit({ type: 'text', text: line });
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (isCopilotAcp && parsed && typeof parsed === 'object' && (parsed.jsonrpc === '2.0' || parsed.method === 'session/update' || parsed.id != null)) {
          if (parsed.method === 'session/update' && parsed.params && parsed.params.update) {
            const u = parsed.params.update;
            if (u.sessionUpdate === 'agent_message_chunk' && u.content && typeof u.content.text === 'string' && u.content.text) {
              state.streamedText += u.content.text;
              onDelta(u.content.text, false);
              forwardEmit({ type: 'text', text: u.content.text });
            } else if (u.sessionUpdate === 'agent_thought_chunk' && u.content && typeof u.content.text === 'string' && u.content.text) {
              onDelta(u.content.text, true);
              forwardEmit({ type: 'thinking', text: u.content.text });
            } else if (u.sessionUpdate === 'tool_call') {
              const tName = u.title || u.name || 'tool';
              const args = u.rawInput || u.input || {};
              const fp = extractFileEditPath(tName, args);
              if (fp) forwardEmit({ type: 'file_edit', path: fp, tool: tName });
              forwardEmit({ type: 'tool_use', id: u.toolCallId || u.id || '', name: tName, args });
              forwardEmit({ type: 'tool', id: u.toolCallId || u.id || '', name: tName, args });
            } else if (u.sessionUpdate === 'tool_call_update' && (u.status === 'completed' || u.status === 'failed')) {
              forwardEmit({ type: 'toolResult', id: u.toolCallId || u.id || '', name: u.title || 'tool', result: String(u.rawOutput || u.output || ''), isError: u.status === 'failed' });
            }
          } else if (parsed.id === 3) {
            if (parsed.error) {
              state.cliError = String((parsed.error && parsed.error.message) || parsed.error || 'Copilot ACP failed');
            } else if (parsed.result && parsed.result.usage && typeof parsed.result.usage === 'object') {
              const ru = parsed.result.usage;
              const inTok = Number(ru.inputTokens || ru.input_tokens) || 0;
              const outTok = Number(ru.outputTokens || ru.output_tokens) || 0;
              state.usage = { input_tokens: inTok, output_tokens: outTok, total_tokens: Number(ru.totalTokens || ru.total_tokens) || (inTok + outTok) };
            }
            if (!settled) {
              settled = true;
              cleanup();
              killChildTree(child);
              if (state.cliError) {
                reject(new Error(state.cliError));
                return;
              }
              const content = state.streamedText || state.resultText || state.finalText || '';
              forwardEmit({ type: 'done_usage', usage: state.usage, model: state.model });
              if (!omitModel && (!spawnImpl || forceWarmPool === true)) {
                const wTimer = setImmediate(() => {
                  warmCliWorker(provider, { cwd, permissions, runtimes, resolveBin, userRuntimesDir, spawnImpl, forceWarmPool }).catch(() => {});
                });
                if (wTimer && typeof wTimer.unref === 'function') wTimer.unref();
              }
              resolve({
                role: 'assistant',
                content,
                tool_calls: [],
                cliHandledTools: !singleTurn,
                finish_reason: 'stop',
                model: state.model,
                usage: state.usage,
              });
            }
          }
          return;
        }
        parseNdjsonEvent(parsed, state, forwardEmit, onDelta, onToolDelta);
      } catch (_) {}
    };

    const consumeStdout = (textChunk) => {
      buf += textChunk;
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        handleLine(line);
      }
    };
    if (buf) consumeStdout('');

    if (child.stdout) {
      child.stdout.on('data', (chunk) => consumeStdout(chunk.toString('utf8')));
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
      });
    }
    if (isCopilotAcp && child.stdin && child.stdin.writable) {
      const warmPrompt = systemPrompt ? `<system_instructions>\n${systemPrompt}\n</system_instructions>\n\n${prompt}` : prompt;
      try {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'session/prompt',
          params: { sessionId: acpSessionId, prompt: [{ type: 'text', text: warmPrompt }] },
        }) + '\n');
      } catch (_) {}
    }

    child.on('error', (err) => {
      cleanup();
      if (!settled) { settled = true; reject(err); }
    });

    child.on('close', (code) => {
      cleanup();
      if (settled) return;
      if (buf.trim()) handleLine(buf);
      settled = true;

      if (signal && signal.aborted) {
        reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
        return;
      }
      if (state.rateLimitError) {
        const err = new Error(state.rateLimitError);
        err.status = 429;
        err.transient = true;
        reject(err);
        return;
      }
      const cleanedStderr = stripBenignCliStderr(stderrBuf);
      let rawErrText = state.cliError || cleanedStderr || stderrBuf.trim();
      if (resolved.kind === 'kimi' && /Prompt turn ended with reason:\s*failed/i.test(rawErrText)) {
        const kimiDetail = extractKimiLastTurnError();
        if (kimiDetail) rawErrText = `${rawErrText} — ${kimiDetail}`;
      }
      if (state.cliError || (code !== 0 && !state.streamedText && !state.resultText && !state.finalText)) {
        let msg = rawErrText || `${resolved.kind} CLI exited with code ${code}`;
        if (/no longer supported for Gemini Code Assist for individuals/i.test(msg)) {
          msg = 'Google deprecated individual consumer OAuth on gemini-cli. Use Antigravity CLI (agy) in Settings → Runtimes & Updates (https://antigravity.google) or configure a GEMINI_API_KEY.';
        }
        const err = new Error(msg);
        if (/\b402\b|\b403\b.*(?:subscription does not have access|upgrade your plan)|payment required|usage balance exhausted|out of credit|insufficient[_ ]?(?:credit|balance)|upgrade your plan to keep coding/i.test(msg)) {
          err.status = /\b403\b/.test(msg) ? 403 : 402;
          err.creditExhausted = true;
          err.retryHopeless = true;
          err.human = true;
        } else if (/\b401\b|missing bearer|not authenticated|authentication required|please set an auth method|no longer supported for gemini code assist|login required|sign in|unauthorized/i.test(msg)) {
          err.status = 401;
          err.code = 'provider_needs_signin';
          err.human = true;
        } else if (/429|rate limit|allowance|quota/i.test(msg)) {
          err.status = 429;
          err.transient = true;
        } else {
          err.cliFailover = true;
        }
        err._canRetryWithoutModel = !omitModel && /does not support this model|version .* required|unknown.*model|model.*not.*found|not available|invalid.*model|not recognized as a known model|invalid model selection/i.test(rawErrText);
        reject(err);
        return;
      }

      const content = state.streamedText || state.resultText || state.finalText || '';
      emit({ type: 'done_usage', usage: state.usage, model: state.model });
      if (!omitModel && (!spawnImpl || forceWarmPool === true)) {
        const wTimer = setImmediate(() => {
          warmCliWorker(provider, { cwd, permissions, runtimes, resolveBin, userRuntimesDir, spawnImpl, forceWarmPool }).catch(() => {});
        });
        if (wTimer && typeof wTimer.unref === 'function') wTimer.unref();
      }
      resolve({
        role: 'assistant',
        content,
        tool_calls: [],
        cliHandledTools: !singleTurn,
        finish_reason: 'stop',
        model: state.model,
        usage: state.usage,
      });
    });
  });
  };

  try {
    return await runOnce(false);
  } catch (err) {
    if (err && isOutdatedCliError(err.message)) {
      try { emit({ type: 'notice', text: `Updating ${resolved.kind} CLI automatically (426 Upgrade Required)…` }); } catch (_) {}
      await selfHealOutdatedCli(resolved, { runtimes, selfHealUpdate, spawnImpl: effectiveSpawn });
      const refreshed = await resolveCliBinary({ ...(provider || {}), cliBin: '' }, { runtimes, resolveBin, userRuntimesDir });
      if (refreshed && refreshed.bin) resolved = refreshed;
      return runOnce(false, resolved.bin);
    }
    if (err && err._canRetryWithoutModel) {
      return runOnce(true);
    }
    throw err;
  }
}

function extractKimiLastTurnError() {
  try {
    const sessRoot = path.join(os.homedir(), '.kimi-code', 'sessions');
    if (!fs.existsSync(sessRoot)) return '';
    const cutoff = Date.now() - 20000;
    const candidates = [];
    for (const wd of fs.readdirSync(sessRoot, { withFileTypes: true })) {
      if (!wd.isDirectory()) continue;
      const wdPath = path.join(sessRoot, wd.name);
      for (const sd of fs.readdirSync(wdPath, { withFileTypes: true })) {
        if (!sd.isDirectory()) continue;
        const logFile = path.join(wdPath, sd.name, 'logs', 'kimi-code.log');
        try {
          const st = fs.statSync(logFile);
          if (st.mtimeMs >= cutoff) candidates.push({ logFile, mtimeMs: st.mtimeMs });
        } catch (_) {}
      }
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const c of candidates.slice(0, 3)) {
      const txt = fs.readFileSync(c.logFile, 'utf8');
      const lines = txt.split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!/errorMessage=/.test(line)) continue;
        const em = /errorMessage="([^"]+)"/.exec(line);
        const sc = /statusCode=(\d+)/.exec(line);
        if (em && em[1]) {
          return sc ? `HTTP ${sc[1]}: ${em[1]}` : em[1];
        }
      }
    }
  } catch (_) {}
  return '';
}

function parseCliModelsOutput(provId, rawText) {
  const txt = String(rawText || '')
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .trim();
  if (!txt) return [];
  let modelCatalog = null;
  try { modelCatalog = require('./model-catalog'); } catch (_) {}
  const ctxFor = (id, explicitWin = 0) => {
    const n = Number(explicitWin);
    if (Number.isFinite(n) && n > 0) return n;
    return modelCatalog ? modelCatalog.contextWindowFor(id, provId) : 0;
  };
  const pretty = (id) => String(id || '')
    .split('-')
    .map((w) => (/^(gpt|o\d+|glm)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');

  // 1. JSON array or { models / data } envelope (including Kimi object-map `models`)
  if (txt.startsWith('{') || txt.startsWith('[')) {
    try {
      const parsed = JSON.parse(txt);
      const rawModels = Array.isArray(parsed) ? parsed : (parsed.models || parsed.data || []);
      if (Array.isArray(rawModels) && rawModels.length) {
        return rawModels.map((m) => {
          const id = String((m && (m.id || m.name || m.model || m.slug)) || m || '').trim();
          if (!id) return null;
          const win = Number(m && (m.contextWindow || m.context_window || m.context_length || m.maxTokens || m.inputTokenLimit)) || 0;
          return {
            id,
            label: String((m && (m.label || m.displayName || m.display_name)) || pretty(id)),
            contextWindow: ctxFor(id, win),
            thinking: m && typeof m.thinking === 'boolean' ? m.thinking : true,
            recommended: Boolean(m && m.default),
          };
        }).filter(Boolean);
      }
      if (!Array.isArray(rawModels) && rawModels && typeof rawModels === 'object') {
        const mapped = Object.entries(rawModels).map(([k, m]) => {
          const id = String(k || (m && m.model) || '').trim();
          if (!id || !m || typeof m !== 'object') return null;
          const win = Number(m.maxContextSize || m.contextWindow || m.context_window || m.maxTokens || 0) || 0;
          return {
            id,
            label: String(m.displayName || m.display_name || m.label || pretty(id)),
            contextWindow: ctxFor(id, win),
            thinking: Array.isArray(m.capabilities) ? m.capabilities.includes('thinking') : (typeof m.thinking === 'boolean' ? m.thinking : true),
            recommended: Boolean(m.default),
          };
        }).filter(Boolean);
        if (mapped.length) return mapped;
      }
    } catch (_) {}
  }

  // 2. CLI bullet format (`* grok-4.7 (default)`) OR two-column tab/space table (`gemini-4-neon-high\tGemini 4 Neon (High)`)
  const out = [];
  const seen = new Set();
  for (const line of txt.split(/\r\n|\r|\n/)) {
    if (/fetching available models/i.test(line.trim())) continue;
    let id = '';
    let tail = '';
    let explicitLabel = '';
    const bullet = /^\s*(?:[*•-]|\d+\.)\s+([a-zA-Z0-9._:/-]{2,80})(.*)$/.exec(line);
    if (bullet) {
      id = bullet[1].trim();
      tail = bullet[2] || '';
    } else {
      const cols = /^\s*([a-zA-Z0-9._:/-]{2,80})(?:\t+|\s{2,})(.+)$/.exec(line);
      if (cols && !/^(name|model|id|available)$/i.test(cols[1].trim())) {
        id = cols[1].trim();
        explicitLabel = cols[2].trim();
        tail = explicitLabel;
      }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const isDefault = /\(default\)/i.test(tail);
    let explicitWin = 0;
    const mWin = /(\d+(?:\.\d+)?)\s*([mMkK])\b/.exec(tail);
    if (mWin) {
      explicitWin = Math.round(Number(mWin[1]) * (mWin[2].toLowerCase() === 'm' ? 1000000 : 1000));
    }
    out.push({
      id,
      label: explicitLabel || pretty(id),
      contextWindow: ctxFor(id, explicitWin),
      thinking: true,
      recommended: isDefault,
    });
  }
  return out;
}

async function probeCliModels(provId, bin, opts = {}) {
  const id = String(provId || '').trim().toLowerCase();
  if (id === 'copilot' || id === 'github-copilot') {
    let mcModels = [];
    try {
      const mc = require('./model-catalog');
      const snap = mc && typeof mc.snapshot === 'function' ? mc.snapshot() : {};
      if (snap && snap.copilot && typeof snap.copilot === 'object') {
        mcModels = Object.entries(snap.copilot).map(([mid, meta]) => ({
          id: mid,
          label: (meta && meta.label) || mid,
          contextWindow: Number(meta && meta.contextWindow) || 1000000,
          thinking: true,
        }));
      }
    } catch (_) {}
    return mcModels;
  }
  if (!bin) return [];
  const argsByProv = {
    grok: ['models'],
    antigravity: ['models'],
    agy: ['models'],
    google: ['models'],
    kimi: ['provider', 'list', '--json'],
  };
  const baseName = path.basename(String(bin || '')).toLowerCase();
  if ((id === 'antigravity' || id === 'google') && baseName.startsWith('gemini')) return [];
  const args = opts.args || argsByProv[id];
  if (!args) return [];
  const timeoutMs = Number(opts.timeoutMs) || 8000;
  return new Promise((resolve) => {
    try {
      const { execFile } = require('child_process');
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) return resolve([]);
        resolve(parseCliModelsOutput(id, stdout));
      });
    } catch (_) {
      resolve([]);
    }
  });
}

module.exports = {
  CLI_DEFS,
  providerKind,
  isCliProvider,
  whichOnPath,
  detectZcodeCli,
  setDefaultRuntimesGetter,
  resolveUserDataRuntime,
  invalidateCliBinaryCache,
  writeIsolatedMcpConfigFile,
  warmCliWorker,
  clearWarmCliPool,
  getWarmCliPoolStats,
  isOutdatedCliError,
  resolveCliBinary,
  probeCliModels,
  parseCliModelsOutput,
  formatMessagesPrompt,
  mapPermissionMode,
  normalizeAgyModelSlug,
  normalizeKimiModelSlug,
  normalizeCopilotModelSlug,
  getCopilotMcpFlags,
  ensureGeminiTrustedFolder,
  stripBenignCliStderr,
  buildCliInvocation,
  parseNdjsonEvent,
  runCliTurn,
};
