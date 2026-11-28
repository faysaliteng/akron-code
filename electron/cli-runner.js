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

const CLI_DEFS = {
  claude: { cliId: 'claude-code', bins: ['claude'] },
  chatgpt: { cliId: 'codex', bins: ['codex'] },
  codex: { cliId: 'codex', bins: ['codex'] },
  grok: { cliId: 'grok', bins: ['grok'] },
  antigravity: { cliId: 'gemini-cli', bins: ['gemini', 'agy'] },
  google: { cliId: 'gemini-cli', bins: ['gemini', 'agy'] },
  gemini: { cliId: 'gemini-cli', bins: ['gemini', 'agy'] },
  kimi: { cliId: 'kimi-code', bins: ['kimi'] },
  moonshot: { cliId: 'kimi-code', bins: ['kimi'] },
  'kimi-code': { cliId: 'kimi-code', bins: ['kimi'] },
  zcode: { cliId: 'zcode', bins: ['zcode'] },
};

function providerKind(provider) {
  if (!provider || typeof provider !== 'object') return '';
  if (provider.cliKind && CLI_DEFS[provider.cliKind]) return provider.cliKind;
  const op = String(provider.oauthProvider || '').split(':')[0].toLowerCase().trim();
  if (op && CLI_DEFS[op]) return op;
  const cid = String(provider.cliId || '').toLowerCase().trim();
  if (cid === 'claude-code') return 'claude';
  if (cid === 'codex') return 'chatgpt';
  if (cid === 'grok') return 'grok';
  if (cid === 'gemini-cli' || cid === 'agy' || cid === 'gemini') return 'antigravity';
  if (cid === 'kimi-code' || cid === 'kimi') return 'kimi';
  if (cid === 'zcode') return 'zcode';
  const tr = String(provider.transport || '').toLowerCase().trim();
  if (tr === 'anthropic') return 'claude';
  if (tr === 'codex') return 'chatgpt';
  if (tr === 'google') return 'antigravity';
  if (tr === 'grok') return 'grok';
  if (tr === 'kimi') return 'kimi';
  if (tr === 'zcode') return 'zcode';
  const m = String(provider.model || '').toLowerCase().trim();
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
  const dirs = [
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    path.join(os.homedir(), '.grok', 'bin'),
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
  const preferredBin = String((provider && provider.cliBin) || '').trim();
  const candidates = preferredBin && !preferredBin.includes('/') && !preferredBin.includes('\\')
    ? [preferredBin, ...def.bins.filter((b) => b !== preferredBin)]
    : (preferredBin ? [path.basename(preferredBin), ...def.bins.filter((b) => b !== path.basename(preferredBin))] : [...def.bins]);

  if (typeof opts.resolveBin === 'function') {
    const custom = await opts.resolveBin({ kind, cliId: def.cliId, bins: candidates, provider });
    if (custom) return { kind, bin: custom, cliId: def.cliId, source: 'custom' };
  }

  // Only honor an explicit full cliBin path immediately when it is NOT a bundled seed path
  // (stale bundled paths passed from old sessions must never shadow self-updated userData copies).
  if (preferredBin && (preferredBin.includes('/') || preferredBin.includes('\\')) && !isBundledSeedPath(preferredBin) && fs.existsSync(preferredBin)) {
    return { kind, bin: preferredBin, cliId: def.cliId, source: 'explicit' };
  }

  // 1. Live self-updated copy via runtimes manager (`source === 'installed'`)
  const rt = opts.runtimes || getDefaultRuntimes();
  let rtResolved = null;
  if (rt && typeof rt.resolve === 'function' && def.cliId) {
    try {
      rtResolved = await rt.resolve(def.cliId);
      if (rtResolved && rtResolved.source === 'installed' && rtResolved.bin && fs.existsSync(rtResolved.bin)) {
        return { kind, bin: rtResolved.bin, cliId: def.cliId, source: 'installed', version: rtResolved.version || '' };
      }
    } catch (_) {}
  }

  // 2. Direct lookup inside userData/runtimes/<id>/current (symlink + current.ptr)
  const userDataBin = resolveUserDataRuntime(def.cliId, candidates, opts);
  if (userDataBin) {
    return { kind, bin: userDataBin, cliId: def.cliId, source: 'installed' };
  }

  if (process.env.AKRON_ISOLATE_RUNTIMES === '1') {
    for (const bn of candidates) {
      const hit = whichOnPath(bn);
      if (hit) return { kind, bin: hit, cliId: def.cliId, source: 'system' };
    }
  }

  // 3. Bundled seed (`rtResolved.source === 'bundled'` -> Resources -> repo vendor/runtimes)
  if (rtResolved && rtResolved.bin && fs.existsSync(rtResolved.bin)) {
    return { kind, bin: rtResolved.bin, cliId: def.cliId, source: rtResolved.source || 'bundled', version: rtResolved.version || '' };
  }
  const bundled = resolveBundledRuntime(def.cliId, candidates);
  if (bundled) return { kind, bin: bundled, cliId: def.cliId, source: 'bundled' };

  // 4. Explicit bundled seed fallback or PATH
  if (preferredBin && (preferredBin.includes('/') || preferredBin.includes('\\')) && fs.existsSync(preferredBin)) {
    return { kind, bin: preferredBin, cliId: def.cliId, source: 'bundled' };
  }
  for (const bn of candidates) {
    const hit = whichOnPath(bn);
    if (hit) return { kind, bin: hit, cliId: def.cliId, source: 'system' };
  }
  return { kind, bin: candidates[0] || '', cliId: def.cliId, source: 'missing' };
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

  if (kind === 'zcode') {
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
    const args = ['-p', fullPrompt];
    if (model && !opts.omitModel) args.push('-m', model);
    return args;
  }

  // Gemini CLI / Antigravity (`agy` / `gemini`)
  const fullPrompt = systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
  const useShortOutFlag = binName.startsWith('gemini');
  const args = ['-p', fullPrompt, useShortOutFlag ? '-o' : '--output-format', 'stream-json'];
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
  if (/^(write|edit|multiedit|applypatch|notebookedit|file_edit|fileedit|patch)/.test(lowName)) {
    return String(args.file_path || args.path || args.target_file || args.file || '');
  }
  return '';
}

function parseNdjsonEvent(ev, state, emitEvt, onDelta, onToolDelta) {
  if (!ev || typeof ev !== 'object') return;
  const t = String(ev.type || '');

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
}

function isOutdatedCliError(text) {
  const s = String(text || '');
  return /\b426\b|upgrade\s+required|client\s+version.*(?:outdated|unsupported|too\s+old|must\s+be\s+updated)|minimum\s+supported\s+version|please\s+(?:upgrade|update)\s+(?:your\s+)?(?:grok|claude|codex|gemini|kimi)|version\s+[0-9.]+\s+(?:or\s+newer\s+)?is\s+required/i.test(s);
}

async function selfHealOutdatedCli(resolved, { runtimes = null, selfHealUpdate = null, spawnImpl = null } = {}) {
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
  runtimes = null,
  resolveBin = null,
  selfHealUpdate = null,
  userRuntimesDir = '',
  spawnImpl = null,
  timeoutMs = 0,
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
  const runOnce = (omitModel, binToRun = resolved.bin) => new Promise((resolve, reject) => {
    const args = buildCliInvocation(resolved.kind, provider, prompt, systemPrompt, {
      cwd,
      permissions,
      singleTurn,
      bin: binToRun,
      omitModel,
    });
    const env = { ...process.env };
    // Never force API key overrides when running subscription CLI sessions.
    if (resolved.kind === 'claude' && !String((provider && provider.apiKey) || '').trim()) {
      delete env.ANTHROPIC_API_KEY;
    }

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

    const child = effectiveSpawn(binToRun, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let buf = '';
    let stderrBuf = '';
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
        parseNdjsonEvent(parsed, state, forwardEmit, onDelta, onToolDelta);
      } catch (_) {}
    };

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          handleLine(line);
        }
      });
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderrBuf += chunk.toString('utf8');
      });
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
      const errText = state.cliError || stderrBuf.trim();
      if (state.cliError || (code !== 0 && !state.streamedText && !state.resultText && !state.finalText)) {
        const err = new Error(errText || `${resolved.kind} CLI exited with code ${code}`);
        if (/not authenticated|login|sign in|unauthorized/i.test(err.message)) {
          err.status = 401;
          err.code = 'provider_needs_signin';
          err.human = true;
        } else if (/429|rate limit|allowance|quota/i.test(err.message)) {
          err.status = 429;
          err.transient = true;
        }
        err._canRetryWithoutModel = !omitModel && /does not support this model|version .* required|unknown.*model|model.*not.*found|not available|invalid.*model/i.test(errText);
        reject(err);
        return;
      }

      const content = state.streamedText || state.resultText || state.finalText || '';
      emit({ type: 'done_usage', usage: state.usage, model: state.model });
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

function parseCliModelsOutput(provId, rawText) {
  const txt = String(rawText || '').trim();
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

  // 1. JSON array or { models / data } envelope
  if (txt.startsWith('{') || txt.startsWith('[')) {
    try {
      const parsed = JSON.parse(txt);
      const list = Array.isArray(parsed) ? parsed : (parsed.models || parsed.data || []);
      if (Array.isArray(list) && list.length) {
        return list.map((m) => {
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
    } catch (_) {}
  }

  // 2. CLI bullet format (`* grok-4.7 (default)` / `- grok-4.7-build-fast` / `• grok-4.5 (1M)`)
  const out = [];
  const seen = new Set();
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*(?:[*•-]|\d+\.)\s+([a-zA-Z0-9._:/-]{2,80})(.*)$/.exec(line);
    if (!m) continue;
    const id = m[1].trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const tail = m[2] || '';
    const isDefault = /\(default\)/i.test(tail);
    let explicitWin = 0;
    const mWin = /(\d+(?:\.\d+)?)\s*([mMkK])\b/.exec(tail);
    if (mWin) {
      explicitWin = Math.round(Number(mWin[1]) * (mWin[2].toLowerCase() === 'm' ? 1000000 : 1000));
    }
    out.push({
      id,
      label: pretty(id),
      contextWindow: ctxFor(id, explicitWin),
      thinking: true,
      recommended: isDefault,
    });
  }
  return out;
}

async function probeCliModels(provId, bin, opts = {}) {
  const id = String(provId || '').trim().toLowerCase();
  if (!bin) return [];
  const argsByProv = {
    grok: ['models'],
  };
  const args = opts.args || argsByProv[id];
  if (!args) return [];
  const timeoutMs = Number(opts.timeoutMs) || 5000;
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
  isOutdatedCliError,
  resolveCliBinary,
  probeCliModels,
  parseCliModelsOutput,
  formatMessagesPrompt,
  mapPermissionMode,
  buildCliInvocation,
  parseNdjsonEvent,
  runCliTurn,
};
