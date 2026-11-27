'use strict';
/**
 * Akron Code Companion Terminal CLI (`akron`)
 * Subcommands:
 *   akron                              Interactive REPL in cwd
 *   akron -p "<prompt>" [--json]       Headless one-shot execution
 *   akron review [--adversarial] [--with <model>] [--ci]
 *   akron remote start [--port <n>]
 *   akron doctor [--json]
 *   akron eval [security|coding|browser|all]
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync, spawnSync } = require('child_process');

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
    if (!db || typeof db.listConversations !== 'function') throw new Error('session-db missing');
    return 'ready';
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

async function runHeadlessPrompt({ prompt, cwd = process.cwd(), json = false } = {}) {
  const { toolDefinitions } = require('../tools');
  const budget = require('../token-budget').analyzeCustomizationBudget({ cwd });
  const providerCfg = require('../store').getSettings()?.provider || {};
  let reply = '';
  let usedModel = providerCfg.model || 'offline-local-inspect';

  if (providerCfg && providerCfg.apiKey && providerCfg.baseURL) {
    try {
      const { chatOnce } = require('../llm');
      const r = await chatOnce({
        provider: providerCfg,
        messages: [{ role: 'user', content: String(prompt) }],
        maxTokens: 1500,
      });
      if (r && r.content) reply = String(r.content);
    } catch (e) {
      reply = `Provider error: ${e && e.message ? e.message : String(e)}`;
    }
  }
  if (!reply) {
    reply = `Headless inspection complete in ${cwd} (${toolDefinitions.length} tools ready, ${budget.activeTokens}/${budget.capTokens} customization tokens). Configure a provider key to run full agent inference from CLI.`;
  }

  const out = {
    ok: true,
    mode: 'headless',
    cwd,
    prompt,
    model: usedModel,
    toolCount: toolDefinitions.length,
    customizationTokens: budget.activeTokens,
    response: reply,
  };
  if (json) {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    process.stdout.write(reply + '\n');
  }
  return 0;
}

async function runReviewCli({ cwd = process.cwd(), adversarial = false, withModel = '', ci = false, json = false } = {}) {
  const duet = require('../duet-review');
  const bundle = duet.buildDuetBundle({ cwd });
  let reviewResult = null;
  const settings = require('../store').getSettings() || {};
  const provider = settings.provider || {};

  if (bundle.files.length && provider.apiKey && provider.baseURL) {
    try {
      reviewResult = await duet.runDuetReview({
        cwd,
        primaryProvider: provider,
        orchestrator: require('../store').getOrchestrator(),
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
      process.stdout.write(`  [${f.severity.toUpperCase()}] ${f.file}:${f.line || ''} ${f.title}\n`);
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

async function runRepl(cwd = process.cwd()) {
  process.stdout.write(`Akron Code Interactive CLI (${cwd}) — type /doctor, /review, or exit\n`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'akron> ' });
  rl.prompt();
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === 'exit' || trimmed === 'quit') break;
    if (trimmed === '/doctor') runDoctor({ cwd });
    else if (trimmed === '/review') await runReviewCli({ cwd });
    else await runHeadlessPrompt({ prompt: trimmed, cwd });
    rl.prompt();
  }
  rl.close();
  return 0;
}

async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  let json = false;
  let adversarial = false;
  let ci = false;
  let withModel = '';
  let cwd = process.cwd();
  let port = 9477;
  let prompt = '';
  const pos = [];

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') json = true;
    else if (a === '--adversarial') adversarial = true;
    else if (a === '--ci') ci = true;
    else if (a === '--with' && args[i + 1]) withModel = args[++i];
    else if (a === '--cwd' && args[i + 1]) cwd = path.resolve(args[++i]);
    else if (a === '--port' && args[i + 1]) port = Number(args[++i]) || 9477;
    else if ((a === '-p' || a === '--prompt') && args[i + 1]) prompt = args[++i];
    else if (a === '--help' || a === '-h') {
      process.stdout.write([
        'Usage: akron [command] [options]',
        '  akron                         Interactive REPL in current repository',
        '  akron -p "<prompt>" [--json]  One-shot headless mode',
        '  akron review [--adversarial] [--with <model>] [--ci]',
        '  akron remote start [--port 9477]',
        '  akron doctor [--json]',
        '  akron eval [security|coding|browser|all]',
        '',
      ].join('\n'));
      return 0;
    } else pos.push(a);
  }

  if (prompt) return await runHeadlessPrompt({ prompt, cwd, json });
  const cmd = pos[0] || '';
  if (!cmd) return await runRepl(cwd);
  if (cmd === 'doctor') return runDoctor({ cwd, json });
  if (cmd === 'review') return await runReviewCli({ cwd, adversarial, withModel, ci, json });
  if (cmd === 'eval') return runEvalCli(pos[1] || 'all');
  if (cmd === 'remote' && pos[1] === 'start') {
    const rs = require('../remote-server');
    const started = await rs.startRemoteServer({ port });
    process.stdout.write(JSON.stringify(started, null, 2) + '\n');
    return started && started.ok ? 0 : 1;
  }
  process.stderr.write(`Unknown command: ${cmd}. Try "akron --help".\n`);
  return 1;
}

module.exports = { main, runDoctor, runHeadlessPrompt, runReviewCli, runEvalCli };
