'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const schedulerMod = require('./scheduler');
const schedulerLock = require('./scheduler-lock');
const remoteServer = require('./remote-server');
const providerHydrate = require('./provider-hydrate');
const llm = require('./llm');
const duetReview = require('./duet-review');

function defaultDataDir() {
  return process.env.AKRON_DAEMON_DATA_DIR
    ? path.resolve(process.env.AKRON_DAEMON_DATA_DIR)
    : path.join(os.homedir(), '.autobot');
}

function pidFilePath(dataDir = defaultDataDir()) {
  return path.join(String(dataDir || defaultDataDir()), 'daemon.pid.json');
}

function logFilePath(dataDir = defaultDataDir()) {
  return path.join(String(dataDir || defaultDataDir()), 'daemon.log');
}

function readDaemonState(dataDir = defaultDataDir()) {
  const fp = pidFilePath(dataDir);
  try {
    if (!fs.existsSync(fp)) return null;
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

function writeDaemonState(dataDir, info) {
  const fp = pidFilePath(dataDir);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = `${fp}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, fp);
}

function removeDaemonState(dataDir) {
  const fp = pidFilePath(dataDir);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch (_) {}
}

function daemonStatus({ dataDir = defaultDataDir() } = {}) {
  const state = readDaemonState(dataDir);
  const alive = Boolean(state && schedulerLock.isPidAlive(state.pid));
  const lease = schedulerLock.readSchedulerLease(dataDir);
  const leaseAlive = Boolean(lease && schedulerLock.isPidAlive(lease.pid));
  return {
    ok: true,
    running: alive,
    pid: alive ? state.pid : null,
    port: alive ? state.port : null,
    host: alive ? state.host : null,
    cwd: state?.cwd || null,
    startedAt: state?.startedAt || null,
    dataDir,
    pidFile: pidFilePath(dataDir),
    logFile: logFilePath(dataDir),
    schedulerLease: lease ? { ...lease, alive: leaseAlive } : null,
  };
}

async function runScheduledTaskInDaemon(task) {
  const workDir = task.cwd || process.cwd();
  const runtime = await providerHydrate.resolveRuntimeForTurn({
    modelOverride: task.model || '',
  });
  const history = await llm.runAgent({
    provider: runtime.provider,
    orchestrator: runtime.orchestrator,
    messages: [{ role: 'user', content: String(task.prompt || '') }],
    cwd: workDir,
    maxSteps: 12,
    permissionMode: 'auto',
    approveTool: async () => true,
    hydrateProvider: runtime.hydrateProvider,
    oauthAccounts: runtime.oauthAccounts,
    ollamaModels: runtime.ollamaModels,
    autoRouterConfig: runtime.autoRouterConfig,
  });
  const lastAssistant = Array.isArray(history)
    ? [...history].reverse().find((m) => m && m.role === 'assistant' && m.content)
    : null;
  const text = lastAssistant ? String(lastAssistant.content) : '';
  return {
    ok: !!text,
    summary: text.slice(0, 1200) || '(task finished with no output)',
    model: (runtime.provider && runtime.provider.model) || 'auto',
  };
}

async function runWebhookReviewInDaemon({ cwd, diffSummary, pr, prompt }) {
  const runtime = await providerHydrate.resolveRuntimeForTurn({});
  const provider = runtime && runtime.provider;
  const isOllama = provider && /11434/.test(String(provider.baseURL || '')) && provider.model;
  const hasCreds = Boolean(provider && (provider.apiKey || provider.oauthProvider || provider.accessToken || isOllama));
  if (typeof duetReview.runDuetReview === 'function' && hasCreds) {
    const rev = await duetReview.runDuetReview({
      cwd,
      diffText: diffSummary,
      primaryProvider: provider,
      orchestrator: runtime.orchestrator,
      hydrateProvider: runtime.hydrateProvider,
      adversarial: true,
    });
    if (rev && rev.ok) return rev;
  }
  const summary = pr
    ? `Akron Code automated review for PR #${pr.number || '?'} (${pr.title || 'update'})`
    : 'Akron Code automated webhook review completed';
  return {
    ok: true,
    summary: prompt ? `${summary}\n${String(prompt).slice(0, 300)}` : summary,
  };
}

async function startDaemonForeground({
  dataDir = defaultDataDir(),
  cwd = process.cwd(),
  port = 9478,
  host = '127.0.0.1',
  token = process.env.AKRON_REMOTE_TOKEN || '',
  webhookSecret = process.env.AKRON_GITHUB_WEBHOOK_SECRET || '',
  githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const activeToken = String(token || '').trim() || crypto.randomBytes(24).toString('hex');
  const activeSecret = String(webhookSecret || '').trim();
  const sched = schedulerMod.createScheduler({
    tasksFile: path.join(dataDir, 'scheduled-tasks.json'),
  });

  const leaseCheck = schedulerLock.acquireSchedulerLease({
    dataDir,
    owner: 'daemon',
    pid: process.pid,
  });

  const rs = remoteServer.createRemoteServer({
    port: Number(port) || 0,
    host,
    token: activeToken,
    workspaceRoot: cwd,
    dataDir,
    webhookSecret: activeSecret,
    githubToken,
    onWebhookReview: runWebhookReviewInDaemon,
  });
  const started = await rs.start();

  sched.start(runScheduledTaskInDaemon, () => {}, {
    shouldSkipTick: () => !schedulerLock.canOwnerRunScheduler({ dataDir, owner: 'daemon', pid: process.pid }),
  });

  const hbTimer = setInterval(() => {
    try {
      schedulerLock.refreshSchedulerLease({ dataDir, owner: 'daemon', pid: process.pid });
    } catch (_) {}
  }, 10_000);
  if (typeof hbTimer.unref === 'function') hbTimer.unref();

  writeDaemonState(dataDir, {
    pid: process.pid,
    port: started.port,
    host: started.host,
    cwd,
    token: activeToken,
    startedAt: Date.now(),
    schedulerAcquired: leaseCheck.acquired,
  });

  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    clearInterval(hbTimer);
    try { sched.stop(); } catch (_) {}
    try { schedulerLock.releaseSchedulerLease({ dataDir, owner: 'daemon', pid: process.pid }); } catch (_) {}
    try { await rs.stop(); } catch (_) {}
    removeDaemonState(dataDir);
  };

  process.once('SIGTERM', () => { shutdown().finally(() => process.exit(0)); });
  process.once('SIGINT', () => { shutdown().finally(() => process.exit(0)); });

  return {
    ok: true,
    foreground: true,
    pid: process.pid,
    port: started.port,
    host: started.host,
    token: activeToken,
    dataDir,
    schedulerAcquired: leaseCheck.acquired,
    stop: shutdown,
  };
}

async function startDaemon({
  dataDir = defaultDataDir(),
  cwd = process.cwd(),
  port = 9478,
  host = '127.0.0.1',
  foreground = false,
  webhookSecret = process.env.AKRON_GITHUB_WEBHOOK_SECRET || '',
  githubToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '',
} = {}) {
  const existing = daemonStatus({ dataDir });
  if (existing.running) {
    return {
      ok: true,
      alreadyRunning: true,
      pid: existing.pid,
      port: existing.port,
      host: existing.host,
      dataDir,
    };
  }
  if (foreground) {
    return await startDaemonForeground({ dataDir, cwd, port, host, webhookSecret, githubToken });
  }

  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const binScript = path.join(__dirname, '..', 'bin', 'akron.js');
  const logFp = logFilePath(dataDir);
  const outFd = fs.openSync(logFp, 'a');
  const childArgs = [binScript, 'daemon', 'start', '--foreground', '--cwd', cwd, '--port', String(port || 0)];
  const child = spawn(process.execPath, childArgs, {
    cwd,
    detached: true,
    stdio: ['ignore', outFd, outFd],
    env: {
      ...process.env,
      AKRON_DAEMON_DATA_DIR: dataDir,
      ...(webhookSecret ? { AKRON_GITHUB_WEBHOOK_SECRET: webhookSecret } : {}),
      ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    },
  });
  try { fs.closeSync(outFd); } catch (_) {}
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const st = readDaemonState(dataDir);
    if (st && st.pid === child.pid && schedulerLock.isPidAlive(st.pid)) {
      return {
        ok: true,
        pid: st.pid,
        port: st.port,
        host: st.host,
        dataDir,
        logFile: logFp,
      };
    }
    await new Promise((r) => setTimeout(r, 120));
  }

  const alive = schedulerLock.isPidAlive(child.pid);
  return {
    ok: alive,
    pid: alive ? child.pid : null,
    dataDir,
    logFile: logFp,
    error: alive ? undefined : 'Daemon failed to become ready in 5s',
  };
}

function stopDaemon({ dataDir = defaultDataDir(), timeoutMs = 4000 } = {}) {
  const state = readDaemonState(dataDir);
  if (!state || !state.pid) {
    return { ok: true, stopped: false, reason: 'Daemon not running' };
  }
  if (!schedulerLock.isPidAlive(state.pid)) {
    removeDaemonState(dataDir);
    return { ok: true, stopped: false, reason: 'Stale pid file cleaned' };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, error: err.message };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!schedulerLock.isPidAlive(state.pid)) {
      removeDaemonState(dataDir);
      return { ok: true, stopped: true, pid: state.pid };
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  try { process.kill(state.pid, 'SIGKILL'); } catch (_) {}
  removeDaemonState(dataDir);
  return { ok: true, stopped: true, forced: true, pid: state.pid };
}

function serviceDescriptor({
  platform = process.platform,
  homeDir = os.homedir(),
  nodeBin = process.execPath,
  cliPath = path.join(__dirname, '..', 'bin', 'akron.js'),
  dataDir = defaultDataDir(),
  cwd = process.cwd(),
} = {}) {
  if (platform === 'darwin') {
    const filePath = path.join(homeDir, 'Library', 'LaunchAgents', 'com.akronlogic.akron-code-daemon.plist');
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key><string>com.akronlogic.akron-code-daemon</string>',
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${nodeBin}</string>`,
      `    <string>${cliPath}</string>`,
      '    <string>daemon</string><string>start</string><string>--foreground</string>',
      `    <string>--cwd</string><string>${cwd}</string>`,
      '  </array>',
      `  <key>WorkingDirectory</key><string>${cwd}</string>`,
      '  <key>RunAtLoad</key><true/>',
      '  <key>KeepAlive</key><true/>',
      `  <key>StandardOutPath</key><string>${path.join(dataDir, 'daemon.log')}</string>`,
      `  <key>StandardErrorPath</key><string>${path.join(dataDir, 'daemon.log')}</string>`,
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return { kind: 'launchd', filePath, content };
  }
  if (platform === 'linux') {
    const filePath = path.join(homeDir, '.config', 'systemd', 'user', 'akron-code-daemon.service');
    const content = [
      '[Unit]',
      'Description=Akron Code Background Daemon',
      'After=network.target',
      '',
      '[Service]',
      `ExecStart="${nodeBin}" "${cliPath}" daemon start --foreground --cwd "${cwd}"`,
      `WorkingDirectory=${cwd}`,
      'Restart=on-failure',
      'RestartSec=5',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return { kind: 'systemd-user', filePath, content };
  }
  const winDir = path.join(homeDir, 'AppData', 'Roaming', 'AkronCode');
  const filePath = path.join(winDir, 'akron-code-daemon.cmd');
  const content = `@echo off\r\n"${nodeBin}" "${cliPath}" daemon start --foreground --cwd "${cwd}"\r\n`;
  return {
    kind: 'windows-task',
    filePath,
    content,
    taskName: 'AkronCodeDaemon',
    schtasksArgs: ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'AkronCodeDaemon', '/TR', `"${filePath}"`],
  };
}

function installDaemonService(opts = {}) {
  const desc = serviceDescriptor(opts);
  fs.mkdirSync(path.dirname(desc.filePath), { recursive: true });
  fs.writeFileSync(desc.filePath, desc.content, 'utf8');
  return { ok: true, installed: true, ...desc };
}

function uninstallDaemonService(opts = {}) {
  const desc = serviceDescriptor(opts);
  let removed = false;
  try {
    if (fs.existsSync(desc.filePath)) {
      fs.unlinkSync(desc.filePath);
      removed = true;
    }
  } catch (err) {
    return { ok: false, error: err.message, filePath: desc.filePath };
  }
  return { ok: true, uninstalled: true, removed, kind: desc.kind, filePath: desc.filePath };
}

module.exports = {
  pidFilePath,
  logFilePath,
  daemonStatus,
  startDaemon,
  startDaemonForeground,
  stopDaemon,
  serviceDescriptor,
  installDaemonService,
  uninstallDaemonService,
};
