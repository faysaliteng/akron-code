'use strict';
/**
 * Akron Code Companion Terminal CLI (`akron`)
 * Multi-turn coding agent harness wired to OAuth/SecretStore hydration, tools,
 * os-sandbox, checkpoints (/undo), SQLite+WAL session-db (--continue / --resume),
 * daemon lifecycle (`akron daemon`), Duet Review, and Eval runner.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

function useColor(stream = process.stderr) {
  return Boolean(stream && stream.isTTY && !process.env.NO_COLOR);
}

function paint(stream, colorCode, text) {
  if (!useColor(stream)) return String(text);
  return `${colorCode}${text}${ANSI.reset}`;
}

function runDoctor({ cwd = process.cwd(), json = false } = {}) {
  const root = path.resolve(__dirname, '..', '..');
  const checks = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      checks.push({ name, ok: true, detail: String(detail || 'ok') });
    } catch (e) {
      checks.push({ name, ok: false, detail: e && e.message ? e.message : String(e) });
    }
  };

  check('node', () => process.version);
  check('git', () => execFileSync('git', ['--version'], { encoding: 'utf8' }).trim());
  check('ripgrep', () => {
    const rg = require('@vscode/ripgrep');
    if (!rg.rgPath || !fs.existsSync(rg.rgPath)) throw new Error('rg binary missing');
    return rg.rgPath;
  });
  check('brand-seal', () => {
    const bg = require('../brand-guard');
    const r = bg.verifyBrandIntegrity();
    if (!r.ok) throw new Error((r.problems || []).join('; '));
    return `${r.checkedFiles} sealed assets verified`;
  });
  check('sqlite-session-db', () => {
    const db = require('../session-db');
    if (!db || typeof db.walPathFor !== 'function' || typeof db.searchMessages !== 'function') {
      throw new Error('session-db WAL+BM25 incomplete');
    }
    return 'SQLite WASM + WAL + BM25 ready';
  });
  check('codebase-index-v2', () => {
    const idx = require('../ide/codebase-index');
    if (!idx || Number(idx.MAX_FILE_BYTES) < 1024 * 1024 || Number(idx.VECTOR_DIM) !== 384) {
      throw new Error('codebase-index v2 incomplete');
    }
    return `AST + 384d Hybrid RRF ready (max ${idx.MAX_FILE_BYTES}B)`;
  });
  check('browser-bot-v2', () => {
    const v2 = require('../browser-bot-v2');
    if (typeof v2.computeTotp !== 'function' || typeof v2.buildCompactAxSnapshot !== 'function') throw new Error('browser-bot-v2 incomplete');
    return 'AX + Vault TOTP + Handoff ready';
  });
  check('tools-registry', () => {
    const { toolDefinitions } = require('../tools');
    return `${toolDefinitions.length} tools loaded`;
  });
  check('cwd', () => cwd);

  const ok = checks.every((c) => c.ok);
  const report = { ok, version: require(path.join(root, 'package.json')).version, checks };
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(`Akron Code CLI Doctor (v${report.version})\n`);
    for (const c of checks) {
      process.stdout.write(`  ${c.ok ? '✓' : '✗'} ${c.name.padEnd(20)} ${c.detail}\n`);
    }
  }
  return ok ? 0 : 1;
}

function isMutatingToolName(name) {
  return /^(Write|Edit|MultiEdit|ApplyPatch|Bash|PowerShell|KillShell|NotebookEdit|DeleteFile|CreateCustomTool|DeleteCustomTool)$/i.test(String(name || ''));
}

async function promptTtyApproval(toolName, args) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const preview = args && (args.path || args.file_path || args.command || '');
  const question = `\nAllow ${toolName}${preview ? ` (${String(preview).slice(0, 80)})` : ''}? [y/N] `;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(String(ans || '').trim()));
    });
  });
}

function buildCliSystemContext({ cwd }) {
  return [
    `You are running in the Akron Code Terminal Agent CLI (${cwd}).`,
    'Inspect files and run verification commands cleanly using your tools rather than guessing.',
  ].join('\n');
}

async function runAgentCliTurn({
  prompt,
  cwd = process.cwd(),
  model = '',
  mode = '',
  maxTurns = 0,
  permissionMode = 'ask',
  yolo = false,
  continueLast = false,
  resumeId = '',
  json = false,
  streamJson = false,
  providerOverride = null,
  orchestratorOverride = null,
  priorMessages = null,
  convId = '',
  sessionDbPath = null,
  runAgentImpl = null,
} = {}) {
  const startedAt = Date.now();
  const rootDir = path.resolve(cwd || process.cwd());
  const sessionDb = require('../session-db');
  const { resolveRuntimeForTurn } = require('../provider-hydrate');
  const llm = require('../llm');
  const { toolDefinitions } = require('../tools');
  const dbOpts = sessionDbPath ? { dbPath: sessionDbPath } : {};

  let activeConvId = convId || resumeId || '';
  let history = Array.isArray(priorMessages) ? priorMessages.map((m) => ({ ...m })) : [];

  if (!history.length && (resumeId || continueLast)) {
    try {
      await sessionDb.initSessionDb(dbOpts);
      if (!activeConvId && continueLast) {
        const list = await sessionDb.listConversations({ ...dbOpts, limit: 1 });
        if (list && list[0] && list[0].id) activeConvId = list[0].id;
      }
      if (activeConvId) {
        const prev = await sessionDb.getConversation(activeConvId, dbOpts);
        if (prev && Array.isArray(prev.messages)) {
          history = prev.messages.filter((m) => m && m.role && (m.role === 'user' || m.role === 'assistant'));
        }
      }
    } catch (_) {}
  }
  if (!activeConvId) {
    activeConvId = `cli_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  let runtime;
  if (providerOverride) {
    runtime = {
      provider: providerOverride,
      orchestrator: orchestratorOverride || null,
      oauthAccounts: [],
      ollamaModels: [],
      autoRouterConfig: null,
      hydrateProvider: async (p) => p,
    };
  } else {
    runtime = await resolveRuntimeForTurn({ modelOverride: model, modeOverride: mode });
    if (orchestratorOverride) runtime.orchestrator = orchestratorOverride;
  }

  const normalizedPerm = yolo
    ? 'bypass'
    : (['auto', 'ask', 'plan', 'acceptEdits', 'bypass'].includes(String(permissionMode)) ? String(permissionMode) : 'ask');

  const userMsg = { role: 'user', content: String(prompt || ''), ts: startedAt };
  const turnMessages = [
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: 'user', content: String(prompt || '') },
  ];

  const emitNdjson = (obj) => {
    if (!streamJson) return;
    try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  };

  let usedModel = (runtime.provider && runtime.provider.model) || model || 'unconfigured';
  let assistantText = '';
  let usage = null;
  let turns = 0;
  let mutatedCount = 0;
  const toolTraces = [];
  let fatalError = null;

  const isQuietStdout = json || streamJson;
  const hasUsableBackend = Boolean(
    runtime.provider && (
      runtime.provider.oauthProvider ||
      runtime.provider.accessToken ||
      (runtime.provider.apiKey && runtime.provider.baseURL) ||
      (/11434/.test(String(runtime.provider.baseURL || '')) && runtime.provider.model) ||
      (runtime.orchestrator && Array.isArray(runtime.orchestrator.providers) && runtime.orchestrator.providers.length) ||
      runAgentImpl
    )
  );

  emitNdjson({ type: 'init', convId: activeConvId, cwd: rootDir, model: usedModel, permissionMode: normalizedPerm });

  const approveTool = async (name, args) => {
    if (normalizedPerm === 'bypass' || normalizedPerm === 'auto') return true;
    if (normalizedPerm === 'acceptEdits' && !/^(Bash|PowerShell|KillShell)$/i.test(name)) return true;
    if (!isMutatingToolName(name)) return true;
    return await promptTtyApproval(name, args);
  };

  try {
    if (!hasUsableBackend) {
      throw new Error('No signed-in OAuth account, API key provider, or local Ollama model is configured. Open Akron Code Settings to sign in or pass --model / provider config.');
    }

    const runner = runAgentImpl || llm.runAgent;
    const origLog = console.log;
    // Keep --json and --stream-json stdout completely parseable
    if (isQuietStdout) console.log = () => {};
    let finalMsgs;
    try {
      finalMsgs = await runner({
        provider: runtime.provider,
        orchestrator: runtime.orchestrator,
        messages: turnMessages,
        cwd: rootDir,
        maxSteps: Number(maxTurns) > 0 ? Number(maxTurns) : 0,
        permissionMode: normalizedPerm,
        approveTool,
        convId: activeConvId,
        hydrateProvider: runtime.hydrateProvider,
        oauthAccounts: runtime.oauthAccounts,
        ollamaModels: runtime.ollamaModels,
        autoRouterConfig: runtime.autoRouterConfig,
        systemSuffix: buildCliSystemContext({ cwd: rootDir }),
        turnStart: true,
        emit: (evt) => {
          if (!evt || typeof evt !== 'object') return;
          if (evt.type === 'route' && evt.model) {
            usedModel = evt.model;
            emitNdjson({ type: 'route', model: evt.model });
          } else if (evt.type === 'delta' && evt.text) {
            assistantText += evt.text;
            if (streamJson) emitNdjson({ type: 'delta', text: evt.text });
            else if (!json && !isQuietStdout) process.stdout.write(evt.text);
          } else if (evt.type === 'tool' || evt.type === 'tool_start') {
            turns++;
            const rec = { id: evt.id, name: evt.name, args: evt.args, status: 'running' };
            toolTraces.push(rec);
            emitNdjson({ type: 'tool_start', name: evt.name, args: evt.args });
            if (!isQuietStdout) {
              const target = evt.args && (evt.args.path || evt.args.file_path || evt.args.command || evt.args.query || '');
              process.stderr.write(paint(process.stderr, ANSI.cyan, `● ${evt.name}`) + (target ? paint(process.stderr, ANSI.dim, ` ${String(target).slice(0, 72)}`) : '') + '\n');
            }
          } else if (evt.type === 'toolResult' || evt.type === 'tool_end') {
            const hasErr = Boolean(evt.isError || evt.error);
            const hit = toolTraces.find((t) => (evt.id && t.id === evt.id) || (t.name === evt.name && t.status === 'running'));
            if (hit) {
              hit.status = hasErr ? 'error' : 'done';
              hit.output = evt.result != null ? String(evt.result).slice(0, 800) : '';
            }
            if (isMutatingToolName(evt.name) && !hasErr) mutatedCount++;
            emitNdjson({ type: 'tool_end', name: evt.name, error: hasErr });
          } else if (evt.type === 'done') {
            if (evt.usage) usage = evt.usage;
            if (evt.model) usedModel = evt.model;
          } else if (evt.type === 'error' && evt.message) {
            fatalError = new Error(evt.message);
          }
        },
      });
    } finally {
      console.log = origLog;
    }

    const lastAssistant = Array.isArray(finalMsgs)
      ? [...finalMsgs].reverse().find((m) => m && m.role === 'assistant')
      : null;
    if (!assistantText && lastAssistant) {
      if (typeof lastAssistant.content === 'string') assistantText = lastAssistant.content;
      else if (Array.isArray(lastAssistant.content)) {
        assistantText = lastAssistant.content.map((b) => (typeof b === 'string' ? b : (b && b.text) || '')).join('');
      }
    }
    if (lastAssistant && lastAssistant.model) usedModel = lastAssistant.model;
    if (!assistantText && Array.isArray(finalMsgs)) {
      assistantText = '';
    }
    if (!isQuietStdout && assistantText && !assistantText.endsWith('\n')) {
      process.stdout.write('\n');
    } else if (!isQuietStdout && assistantText && !turns) {
      // ensure newline if deltas already printed without trailing newline
    }
  } catch (err) {
    fatalError = err;
  }

  const completedAt = Date.now();
  const durationMs = completedAt - startedAt;

  // Persist conversation to WASM SQLite + WAL sidecar unless skipped
  const nextMessages = [
    ...history,
    userMsg,
    {
      role: 'assistant',
      content: fatalError ? `Error: ${fatalError.message}` : (assistantText || ''),
      model: usedModel,
      tools: toolTraces,
      ts: completedAt,
    },
  ];
  try {
    await sessionDb.initSessionDb(dbOpts);
    await sessionDb.upsertConversation({
      id: activeConvId,
      title: String(prompt || 'CLI Session').slice(0, 80),
      cwd: rootDir,
      model: usedModel,
      provider: { model: usedModel },
      createdAt: history[0]?.ts || startedAt,
      updatedAt: completedAt,
      messages: nextMessages,
    }, dbOpts);
    sessionDb.flushAll();
  } catch (_) {}

  const summary = {
    ok: !fatalError,
    mode: 'agent',
    convId: activeConvId,
    cwd: rootDir,
    prompt,
    model: usedModel,
    permissionMode: normalizedPerm,
    turns: Math.max(1, turns),
    toolCalls: toolTraces.map((t) => ({ name: t.name, status: t.status })),
    toolCount: toolDefinitions.length,
    mutatedFiles: mutatedCount,
    durationMs,
    usage,
    response: assistantText,
    ...(fatalError ? { error: fatalError.message } : {}),
  };

  if (streamJson) {
    emitNdjson({ type: 'result', ...summary });
  } else if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    if (fatalError) {
      process.stderr.write(paint(process.stderr, ANSI.red, `Error: ${fatalError.message}\n`));
    } else {
      if (mutatedCount > 0) {
        try {
          const statOut = execFileSync('git', ['diff', '--stat'], { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
          if (statOut) process.stderr.write(paint(process.stderr, ANSI.green, `\nChanged files:\n${statOut}\n`));
        } catch (_) {}
      }
      process.stderr.write(paint(process.stderr, ANSI.dim, `[${usedModel} · ${toolTraces.length} tool(s) · ${(durationMs / 1000).toFixed(2)}s · session ${activeConvId}]\n`));
    }
  }

  return { exitCode: fatalError ? 1 : 0, summary, messages: nextMessages };
}

async function runHeadlessPrompt(opts = {}) {
  const res = await runAgentCliTurn({
    ...opts,
    permissionMode: opts.permissionMode || (opts.yolo ? 'bypass' : 'auto'),
  });
  return res.exitCode;
}

async function runReviewCli({ cwd = process.cwd(), adversarial = false, withModel = '', ci = false, json = false } = {}) {
  const duet = require('../duet-review');
  const bundle = duet.buildDuetBundle({ cwd });
  let reviewResult = null;
  const { resolveRuntimeForTurn } = require('../provider-hydrate');
  let runtime = null;
  try { runtime = await resolveRuntimeForTurn({ modelOverride: withModel }); } catch (_) {}

  if (bundle.files.length && runtime && runtime.provider && (runtime.provider.apiKey || runtime.provider.oauthProvider || runtime.provider.accessToken)) {
    try {
      reviewResult = await duet.runDuetReview({
        cwd,
        primaryProvider: runtime.provider,
        orchestrator: runtime.orchestrator,
        withSpec: withModel,
        adversarial,
      });
    } catch (_) {}
  }

  const summary = reviewResult || {
    ok: true,
    offlineBundleOnly: true,
    adversarial,
    withModel: withModel || 'auto',
    fileCount: bundle.fileCount,
    added: bundle.added,
    removed: bundle.removed,
    guidelinesIncluded: bundle.guidelinesIncluded,
    callersCount: bundle.callersCount,
    findings: [],
    summary: bundle.fileCount ? `Prepared Duet Review bundle for ${bundle.fileCount} changed file(s).` : 'Working tree clean — 0 changed files.',
  };

  if (json) {
    process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  } else {
    process.stdout.write(`Akron Duet Review: ${summary.summary}\n`);
    for (const f of (summary.findings || [])) {
      process.stdout.write(`  [${String(f.severity || 'info').toUpperCase()}] ${f.file}:${f.line || ''} ${f.title}\n`);
    }
  }
  if (ci && (summary.findings || []).some((f) => f.severity === 'critical' || f.severity === 'high')) {
    return 1;
  }
  return 0;
}

function runEvalCli(target = 'all') {
  const root = path.resolve(__dirname, '..', '..');
  const map = {
    security: path.join(root, 'evals', 'security', 'run.js'),
    coding: path.join(root, 'evals', 'coding', 'run.js'),
    browser: path.join(root, 'evals', 'browser', 'run.js'),
    all: path.join(root, 'evals', 'report.js'),
  };
  const script = map[target] || map.all;
  if (!fs.existsSync(script)) {
    process.stderr.write(`Eval runner not found: ${script}\n`);
    return 1;
  }
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', cwd: root });
  return typeof r.status === 'number' ? r.status : 1;
}

async function runRepl({ cwd = process.cwd(), model = '', mode = '', permissionMode = 'ask', yolo = false, resumeId = '', continueLast = false } = {}) {
  const checkpoints = require('../checkpoints');
  const sessionDb = require('../session-db');
  let activeModel = model;
  let activeMode = mode;
  let convId = resumeId || `cli_${Date.now().toString(36)}`;
  let messages = [];

  if (resumeId || continueLast) {
    try {
      await sessionDb.initSessionDb();
      if (!resumeId && continueLast) {
        const list = await sessionDb.listConversations({ limit: 1 });
        if (list && list[0]) convId = list[0].id;
      }
      const prev = await sessionDb.getConversation(convId);
      if (prev && Array.isArray(prev.messages)) messages = prev.messages;
    } catch (_) {}
  }

  process.stdout.write(
    paint(process.stdout, ANSI.bold, `Akron Code Terminal Agent (${cwd})`) +
    paint(process.stdout, ANSI.dim, `\nCommands: /help, /model [id], /status, /diff, /undo, /clear, /review, /doctor, exit\n`)
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'akron> ' });
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) { rl.prompt(); continue; }
    if (trimmed === 'exit' || trimmed === 'quit' || trimmed === '/exit') break;
    if (trimmed === '/help') {
      process.stdout.write([
        '  /help           Show commands',
        '  /model [id]     Show or switch active model/account/Auto mode',
        '  /status         Show session ID, turns, and permissions',
        '  /diff           Show working tree git diff',
        '  /undo           Rewind files to the last checkpoint snapshot',
        '  /clear          Start a fresh conversation',
        '  /review         Run Duet Adversarial Review on current changes',
        '  /doctor         Run diagnostics',
        '',
      ].join('\n'));
    } else if (trimmed === '/doctor') {
      runDoctor({ cwd });
    } else if (trimmed === '/review') {
      await runReviewCli({ cwd });
    } else if (trimmed === '/clear') {
      messages = [];
      convId = `cli_${Date.now().toString(36)}`;
      process.stdout.write('Cleared conversation context.\n');
    } else if (trimmed === '/status') {
      process.stdout.write(`Session: ${convId} · Messages: ${messages.length} · Model: ${activeModel || 'default'} · Mode: ${activeMode || 'default'}\n`);
    } else if (trimmed.startsWith('/model')) {
      const next = trimmed.slice(6).trim();
      if (next) {
        activeModel = next;
        process.stdout.write(`Active model set to: ${activeModel}\n`);
      } else {
        process.stdout.write(`Current model: ${activeModel || 'configured default'}\n`);
      }
    } else if (trimmed === '/diff') {
      try {
        const diffOut = execFileSync('git', ['diff'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        process.stdout.write(diffOut || '(working tree clean)\n');
      } catch (e) {
        process.stdout.write(`git diff failed: ${e.message}\n`);
      }
    } else if (trimmed === '/undo') {
      const cps = checkpoints.listCheckpoints(convId);
      if (!cps.length) {
        process.stdout.write('No checkpoints available for this session.\n');
      } else {
        const res = checkpoints.restore(convId, cps[cps.length - 1].id);
        process.stdout.write(`Rewound ${res.restored.length} file(s), removed ${res.removed.length} file(s).\n`);
      }
    } else {
      const out = await runAgentCliTurn({
        prompt: trimmed,
        cwd,
        model: activeModel,
        mode: activeMode,
        permissionMode,
        yolo,
        priorMessages: messages,
        convId,
      });
      if (out && Array.isArray(out.messages)) messages = out.messages;
    }
    rl.prompt();
  }
  rl.close();
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let json = false;
  let streamJson = false;
  let adversarial = false;
  let ci = false;
  let withModel = '';
  let model = '';
  let mode = '';
  let maxTurns = 0;
  let permissionMode = 'ask';
  let yolo = false;
  let continueLast = false;
  let resumeId = '';
  let cwd = process.cwd();
  let port = 9477;
  let prompt = '';
  const pos = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--stream-json') streamJson = true;
    else if (a === '--adversarial') adversarial = true;
    else if (a === '--ci') ci = true;
    else if (a === '--yolo') { yolo = true; permissionMode = 'bypass'; }
    else if (a === '--continue' || a === '-c') continueLast = true;
    else if ((a === '--resume' || a === '-r') && args[i + 1]) resumeId = args[++i];
    else if ((a === '--model' || a === '-m') && args[i + 1]) model = args[++i];
    else if (a === '--mode' && args[i + 1]) mode = args[++i];
    else if (a === '--max-turns' && args[i + 1]) maxTurns = Number(args[++i]) || 0;
    else if (a === '--permission-mode' && args[i + 1]) permissionMode = args[++i];
    else if (a === '--with' && args[i + 1]) withModel = args[++i];
    else if (a === '--cwd' && args[i + 1]) cwd = path.resolve(args[++i]);
    else if (a === '--port' && args[i + 1]) port = Number(args[++i]) || 9477;
    else if ((a === '-p' || a === '--prompt') && args[i + 1]) prompt = args[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write([
        'Usage: akron [command] [options]',
        '  akron                         Interactive multi-turn coding agent REPL',
        '  akron -p "<prompt>"           Headless multi-turn coding agent run',
        '    --model <id>                Override model or account:<prov>:<acct>::<model>',
        '    --mode <auto|direct|orchestrator>',
        '    --max-turns <n>             Cap tool turns per invocation',
        '    --permission-mode <auto|ask|plan>',
        '    --yolo                      Bypass interactive permission prompts (CI)',
        '    --continue / --resume <id>  Continue or resume persisted SQLite session',
        '    --json / --stream-json      Structured JSON or NDJSON stream output',
        '  akron daemon <start|stop|status|install|uninstall>',
        '  akron review [--adversarial] [--with <model>] [--ci]',
        '  akron remote start [--port 9477]',
        '  akron doctor [--json]',
        '  akron eval [security|coding|browser|all]',
        '',
      ].join('\n'));
      return 0;
    } else pos.push(a);
  }

  if (prompt) {
    const res = await runAgentCliTurn({
      prompt,
      cwd,
      model,
      mode,
      maxTurns,
      permissionMode,
      yolo,
      continueLast,
      resumeId,
      json,
      streamJson,
    });
    return res.exitCode;
  }

  const cmd = pos[0] || '';
  if (!cmd) {
    return await runRepl({ cwd, model, mode, permissionMode, yolo, resumeId, continueLast });
  }
  if (cmd === 'doctor') return runDoctor({ cwd, json });
  if (cmd === 'review') return await runReviewCli({ cwd, adversarial, withModel, ci, json });
  if (cmd === 'eval') return runEvalCli(pos[1] || 'all');
  if (cmd === 'daemon') {
    const daemon = require('../daemon');
    const sub = pos[1] || 'status';
    if (sub === 'start') {
      const foreground = args.includes('--foreground');
      const r = await daemon.startDaemon({ port: port !== 9477 ? port : 0, cwd, foreground, json });
      if (json || !foreground) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      if (foreground && r.ok) await new Promise(() => {}); // run until SIGTERM/SIGINT
      return r.ok ? 0 : 1;
    }
    if (sub === 'stop') {
      const r = daemon.stopDaemon();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      return r.ok ? 0 : 1;
    }
    if (sub === 'status') {
      const r = daemon.daemonStatus();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      return 0;
    }
    if (sub === 'install') {
      const r = daemon.installDaemonService();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      return r.ok ? 0 : 1;
    }
    if (sub === 'uninstall') {
      const r = daemon.uninstallDaemonService();
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
      return r.ok ? 0 : 1;
    }
  }
  if (cmd === 'remote' && pos[1] === 'start') {
    const rs = require('../remote-server');
    const inst = rs.createRemoteServer({ port, workspaceRoot: cwd });
    const started = await inst.start();
    process.stdout.write(JSON.stringify(started, null, 2) + '\n');
    return started && started.ok ? 0 : 1;
  }
  process.stderr.write(`Unknown command: ${cmd}. Try "akron --help".\n`);
  return 1;
}

module.exports = { main, runDoctor, runAgentCliTurn, runHeadlessPrompt, runReviewCli, runEvalCli, runRepl };
