'use strict';
/**
 * Built-in REA (`https://github.com/morluto/rea`, `rea-agents`) integration.
 *
 * Locates a supported Node.js runtime (^22.23.4 || ^24.22.1 || >=26.12.1 —
 * needed because Electron embeds Node 20 while REA targets Node 22/24/26+),
 * discovers the installed `rea-agents` package (userData, app resources, Volta,
 * Homebrew, global npm, or PATH/npx), connects its 263-tool MCP server on stdio
 * under serverId "rea", and provides one-shot CLI / doctor / install helpers.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const mcpSchema = require('./mcp-schema');

const MAX_CLI_BYTES = 200 * 1024;
let cachedNode = null;
let cachedInstall = null;
let inflightConnect = null;

function isSupportedNodeVersion(ver) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(ver || '').trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  if (major === 22) return minor > 23 || (minor === 23 && patch >= 4);
  if (major === 24) return minor > 22 || (minor === 22 && patch >= 1);
  if (major >= 26) return major > 26 || minor > 12 || (minor === 12 && patch >= 1);
  return false;
}

function defaultExtraPathDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    dirs.push(
      path.join(localApp, 'Volta', 'bin'),
      path.join(appData, 'npm'),
      'C:\\Program Files\\nodejs',
    );
  } else {
    dirs.push(
      path.join(home, '.volta', 'bin'),
      '/opt/homebrew/bin',
      '/opt/homebrew/sbin',
      '/usr/local/bin',
      path.join(home, '.local', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.cargo', 'bin'),
      path.join(home, '.asdf', 'shims'),
      path.join(home, '.mise', 'shims'),
      path.join(home, '.local', 'share', 'mise', 'shims'),
      path.join(home, '.fnm', 'aliases', 'default', 'bin'),
      '/Applications/Hopper Disassembler v4.app/Contents/MacOS',
      '/Applications/Wireshark.app/Contents/MacOS',
    );
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        const vers = fs.readdirSync(nvmDir).sort().reverse();
        if (vers.length) dirs.push(path.join(nvmDir, vers[0], 'bin'));
      }
    } catch (_) {}
  }
  return dirs;
}

function enrichProcessPath() {
  const cur = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const curSet = new Set(cur);
  const add = [];
  for (const d of defaultExtraPathDirs()) {
    try {
      if (d && !curSet.has(d) && fs.existsSync(d)) {
        curSet.add(d);
        add.push(d);
      }
    } catch (_) {}
  }
  if (add.length) {
    process.env.PATH = add.concat(cur).join(path.delimiter);
  }
  return process.env.PATH || '';
}

function compareSemverDesc(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return 0;
}

function probeNodeBinary(binPath) {
  try {
    if (!binPath) return null;
    if (path.isAbsolute(binPath) && !fs.existsSync(binPath)) return null;
    const out = execFileSync(binPath, ['-v'], { encoding: 'utf8', timeout: 2500, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!isSupportedNodeVersion(out)) return null;
    return { nodePath: binPath, version: out };
  } catch (_) {
    return null;
  }
}

function resolveNodeRuntime(opts = {}) {
  if (cachedNode && !opts.force) {
    if (fs.existsSync(cachedNode.nodePath) || !path.isAbsolute(cachedNode.nodePath)) return cachedNode;
  }
  enrichProcessPath();
  const home = os.homedir();
  const candidates = [];
  if (process.env.AKRON_REA_NODE) candidates.push(process.env.AKRON_REA_NODE);

  // Volta exact node image binaries (bypasses Volta's shim pinning to older project node if any)
  try {
    const voltaNodes = path.join(home, '.volta', 'tools', 'image', 'node');
    if (fs.existsSync(voltaNodes)) {
      const vers = fs.readdirSync(voltaNodes).sort(compareSemverDesc);
      for (const v of vers) {
        candidates.push(path.join(voltaNodes, v, process.platform === 'win32' ? 'node.exe' : 'bin', process.platform === 'win32' ? '' : 'node'));
      }
    }
  } catch (_) {}

  if (process.platform === 'win32') {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Volta', 'bin', 'node.exe'),
      'C:\\Program Files\\nodejs\\node.exe',
      'node.exe',
    );
  } else {
    candidates.push(
      path.join(home, '.volta', 'bin', 'node'),
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
    );
    try {
      const nvmDir = path.join(home, '.nvm', 'versions', 'node');
      if (fs.existsSync(nvmDir)) {
        for (const v of fs.readdirSync(nvmDir).sort(compareSemverDesc)) {
          candidates.push(path.join(nvmDir, v, 'bin', 'node'));
        }
      }
    } catch (_) {}
    candidates.push('node');
  }

  for (const cand of candidates) {
    const clean = path.normalize(cand);
    const hit = probeNodeBinary(clean);
    if (hit) {
      cachedNode = hit;
      return hit;
    }
  }
  return null;
}

function inspectPkgDir(dir) {
  try {
    const pkgFile = path.join(dir, 'package.json');
    const reaMjs = path.join(dir, 'scripts', 'rea.mjs');
    if (!fs.existsSync(pkgFile) || !fs.existsSync(reaMjs)) return null;
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (pkg.name !== 'rea-agents') return null;
    return {
      mode: 'package',
      dir,
      reaMjsPath: reaMjs,
      version: String(pkg.version || ''),
      skillDir: fs.existsSync(path.join(dir, 'skills', 'reverse-engineer-anything'))
        ? path.join(dir, 'skills', 'reverse-engineer-anything')
        : null,
    };
  } catch (_) {
    return null;
  }
}

function resolveReaInstallation(opts = {}) {
  if (cachedInstall && !opts.force) {
    if (cachedInstall.mode === 'npx' || (cachedInstall.reaMjsPath && fs.existsSync(cachedInstall.reaMjsPath))) {
      return cachedInstall;
    }
  }
  enrichProcessPath();
  const home = os.homedir();
  const userDataDir = opts.userDataDir || path.join(home, '.autobot');
  const candidates = [
    path.join(userDataDir, 'rea', 'node_modules', 'rea-agents'),
  ];
  try {
    if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'rea', 'node_modules', 'rea-agents'));
  } catch (_) {}
  candidates.push(
    path.join(__dirname, '..', 'resources', 'rea', 'node_modules', 'rea-agents'),
    path.join(home, '.volta', 'tools', 'image', 'packages', 'rea-agents', 'lib', 'node_modules', 'rea-agents'),
    path.join(home, '.volta', 'tools', 'image', 'packages', 'rea-agents', 'node_modules', 'rea-agents'),
    '/opt/homebrew/lib/node_modules/rea-agents',
    '/usr/local/lib/node_modules/rea-agents',
    path.join(home, '.npm-global', 'lib', 'node_modules', 'rea-agents'),
  );
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, 'npm', 'node_modules', 'rea-agents'));
  }

  for (const dir of candidates) {
    const hit = inspectPkgDir(dir);
    if (hit) {
      cachedInstall = hit;
      return hit;
    }
  }

  // Try resolving `rea` binary from PATH
  for (const pDir of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const bin = path.join(pDir, process.platform === 'win32' ? 'rea.cmd' : 'rea');
    try {
      if (!fs.existsSync(bin)) continue;
      const real = fs.realpathSync(bin);
      // Case: .../node_modules/rea-agents/scripts/rea.mjs
      const up2 = path.resolve(path.dirname(real), '..');
      const hit = inspectPkgDir(up2);
      if (hit) {
        cachedInstall = hit;
        return hit;
      }
      // Volta shim or shell wrapper: fall back cleanly if non-shim binary
      if (!real.endsWith('volta-shim')) {
        const hitBin = { mode: 'bin', binPath: real, reaMjsPath: real, version: '' };
        cachedInstall = hitBin;
        return hitBin;
      }
    } catch (_) {}
  }

  // Fallback: npx
  const nodeRt = resolveNodeRuntime();
  const npxPath = nodeRt && path.isAbsolute(nodeRt.nodePath)
    ? path.join(path.dirname(nodeRt.nodePath), process.platform === 'win32' ? 'npx.cmd' : 'npx')
    : (process.platform === 'win32' ? 'npx.cmd' : 'npx');
  if (fs.existsSync(npxPath) || !path.isAbsolute(npxPath)) {
    const npxInstall = { mode: 'npx', command: npxPath, argsPrefix: ['-y', 'rea-agents@6.10.1'], version: '6.10.1' };
    cachedInstall = npxInstall;
    return npxInstall;
  }

  return null;
}

function buildSpawnSpec(opts = {}) {
  const nodeRt = resolveNodeRuntime();
  const inst = resolveReaInstallation(opts);
  if (!inst) return { error: 'rea-agents is not installed and npx is unavailable.' };
  const env = { ...process.env };
  if (nodeRt && path.isAbsolute(nodeRt.nodePath)) {
    const binDir = path.dirname(nodeRt.nodePath);
    env.PATH = binDir + path.delimiter + (env.PATH || '');
  }
  if (inst.mode === 'package') {
    if (!nodeRt) {
      return { error: 'REA requires Node.js ^22.23.4 || ^24.22.1 || >=26.12.1, which was not found on this system.' };
    }
    return { command: nodeRt.nodePath, argsPrefix: [inst.reaMjsPath], env, inst, nodeRt };
  }
  if (inst.mode === 'bin') {
    return { command: inst.binPath, argsPrefix: [], env, inst, nodeRt };
  }
  return { command: inst.command, argsPrefix: inst.argsPrefix || ['-y', 'rea-agents@6.10.1'], env, inst, nodeRt };
}

async function ensureConnected(mcpClient, opts = {}) {
  if (!mcpClient) throw new Error('MCP client required');
  const existing = mcpClient.servers && mcpClient.servers.get('rea');
  if (existing && !existing.exited && Array.isArray(existing.fullTools) && existing.fullTools.length > 0 && !opts.force) {
    return {
      serverId: 'rea',
      name: existing.name || 'rea',
      toolCount: existing.fullTools.length,
      tools: existing.fullTools,
      cached: true,
    };
  }
  if (inflightConnect && !opts.force) return inflightConnect;

  inflightConnect = (async () => {
    const spec = buildSpawnSpec(opts);
    if (spec.error) throw new Error(spec.error);
    if (existing) {
      try { mcpClient.disconnect('rea'); } catch (_) {}
    }
    const info = await mcpClient.connect({
      serverId: 'rea',
      name: 'rea',
      transport: 'stdio',
      command: spec.command,
      args: [...spec.argsPrefix, 'mcp'],
      env: spec.env,
      initTimeoutMs: Number(opts.initTimeoutMs) || 30000,
    });
    const entry = mcpClient.servers.get(info.serverId);
    if (entry && (!entry.fullTools || !entry.fullTools.length)) entry.fullTools = info.tools || [];
    return {
      serverId: info.serverId,
      name: info.name || 'rea',
      toolCount: (info.tools || []).length,
      tools: info.tools || [],
      cached: false,
    };
  })().finally(() => {
    inflightConnect = null;
  });

  return inflightConnect;
}

async function searchReaTools(mcpClient, query, limit = 10, opts = {}) {
  await ensureConnected(mcpClient, opts);
  const entry = mcpClient.servers.get('rea');
  const fullTools = (entry && entry.fullTools ? entry.fullTools : []).map((t) => ({
    name: `mcp__rea__${t.name}`,
    description: `[REA] ${t.description || ''}`,
    inputSchema: t.inputSchema,
  }));
  const hits = mcpSchema.searchMcpTools(fullTools, query || '', 'rea').slice(0, Math.max(1, Math.min(Number(limit) || 10, 25)));
  return { total: fullTools.length, hits };
}

async function callReaTool(mcpClient, toolName, toolArgs, opts = {}) {
  const cleanName = String(toolName || '').trim().replace(/^mcp__rea__/, '');
  if (!cleanName) throw new Error('REA tool name is required');
  await ensureConnected(mcpClient, opts);
  return await mcpClient.callTool('rea', cleanName, toolArgs || {});
}

function runCli(cliArgs, opts = {}) {
  const spec = buildSpawnSpec(opts);
  if (spec.error) {
    return Promise.resolve({ ok: false, exitCode: 1, stdout: '', stderr: spec.error });
  }
  const argv = Array.isArray(cliArgs)
    ? cliArgs.map(String)
    : String(cliArgs || '').trim().split(/\s+/).filter(Boolean);
  const timeoutMs = Math.max(2000, Math.min(Number(opts.timeoutMs) || 120000, 600000));
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      if (opts.signal && onAbort) opts.signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      resolve(res);
    };
    let child;
    try {
      child = spawn(spec.command, [...spec.argsPrefix, ...argv], {
        cwd: opts.cwd || process.cwd(),
        env: spec.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return finish({ ok: false, exitCode: 1, stdout: '', stderr: e.message || String(e) });
    }
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish({ ok: false, exitCode: 130, stdout, stderr: stderr + '\n[aborted]' });
    };
    if (opts.signal) {
      if (opts.signal.aborted) return onAbort();
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      finish({ ok: false, exitCode: 124, stdout, stderr: stderr + `\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      if (stdout.length < MAX_CLI_BYTES) stdout += d.toString().slice(0, MAX_CLI_BYTES - stdout.length);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < MAX_CLI_BYTES) stderr += d.toString().slice(0, MAX_CLI_BYTES - stderr.length);
    });
    child.on('error', (e) => finish({ ok: false, exitCode: 1, stdout, stderr: stderr || e.message || String(e) }));
    child.on('close', (code) => finish({ ok: code === 0, exitCode: code == null ? 1 : code, stdout, stderr }));
  });
}

function skillIsBundled() {
  try {
    if (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'skills', 'reverse-engineer-anything', 'SKILL.md'))) return true;
  } catch (_) {}
  return fs.existsSync(path.join(__dirname, '..', 'resources', 'skills', 'reverse-engineer-anything', 'SKILL.md'));
}

function status(mcpClient, opts = {}) {
  const nodeRt = resolveNodeRuntime();
  const inst = resolveReaInstallation(opts);
  const entry = mcpClient && mcpClient.servers ? mcpClient.servers.get('rea') : null;
  const connected = Boolean(entry && !entry.exited && Array.isArray(entry.fullTools) && entry.fullTools.length > 0);
  const available = Boolean(inst && (inst.mode !== 'package' || nodeRt));
  return {
    ok: available,
    available,
    connected,
    serverId: 'rea',
    version: (inst && inst.version) || '',
    mode: (inst && inst.mode) || 'missing',
    nodePath: (nodeRt && nodeRt.nodePath) || '',
    nodeVersion: (nodeRt && nodeRt.version) || '',
    reaPath: (inst && (inst.dir || inst.reaMjsPath || inst.command)) || '',
    toolCount: entry && Array.isArray(entry.fullTools) ? entry.fullTools.length : 0,
    skillBundled: skillIsBundled(),
  };
}

async function doctor(mcpClient, opts = {}) {
  const cli = await runCli(['doctor'], { ...opts, timeoutMs: 30000 });
  return {
    ok: cli.ok,
    exitCode: cli.exitCode,
    output: [cli.stdout, cli.stderr].filter(Boolean).join('\n').trim(),
    status: status(mcpClient, opts),
  };
}

async function installOrUpdate({ userDataDir, mcpClient } = {}) {
  const nodeRt = resolveNodeRuntime({ force: true });
  if (!nodeRt) throw new Error('Node.js ^22.23.4 || ^24.22.1 || >=26.12.1 is required to install REA.');
  const targetDir = path.join(userDataDir || path.join(os.homedir(), '.autobot'), 'rea');
  fs.mkdirSync(targetDir, { recursive: true });
  const npmBin = path.isAbsolute(nodeRt.nodePath)
    ? path.join(path.dirname(nodeRt.nodePath), process.platform === 'win32' ? 'npm.cmd' : 'npm')
    : (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const env = { ...process.env };
  if (path.isAbsolute(nodeRt.nodePath)) {
    env.PATH = path.dirname(nodeRt.nodePath) + path.delimiter + (env.PATH || '');
  }
  const out = await new Promise((resolve) => {
    let buf = '';
    const proc = spawn(npmBin, ['install', '--no-audit', '--no-fund', '--prefix', targetDir, 'rea-agents@latest'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, out: buf + '\n[install timed out]' }); }, 180000);
    proc.stdout.on('data', (d) => { buf += d.toString(); });
    proc.stderr.on('data', (d) => { buf += d.toString(); });
    proc.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out: e.message }); });
    proc.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: buf }); });
  });
  if (!out.ok) throw new Error('REA install failed: ' + out.out.slice(-400));
  cachedInstall = null;
  if (mcpClient) {
    try { await ensureConnected(mcpClient, { userDataDir, force: true }); } catch (_) {}
  }
  return { ok: true, output: out.out.slice(-1000), status: status(mcpClient, { userDataDir }) };
}

function resetCaches() {
  cachedNode = null;
  cachedInstall = null;
}

module.exports = {
  enrichProcessPath,
  isSupportedNodeVersion,
  resolveNodeRuntime,
  resolveReaInstallation,
  ensureConnected,
  searchReaTools,
  callReaTool,
  runCli,
  status,
  doctor,
  installOrUpdate,
  resetCaches,
};
