'use strict';
/**
 * Built-in Dependency & Optional LSP Manager.
 * Probes bundled packages (Monaco, xterm + addons, PTY host, ripgrep, @parcel/watcher,
 * Browser Bot, REA) and manages auto-install/repair for optional LSP servers in ~/.autobot/lsp-servers.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_LSP_ROOT = path.join(os.homedir(), '.autobot', 'lsp-servers');

const OPTIONAL_LSPS = [
  {
    id: 'typescript',
    label: 'TypeScript / JavaScript LSP',
    pkg: 'typescript-language-server typescript',
    npmPkg: 'typescript-language-server',
    bin: 'typescript-language-server',
    languages: 'ts, tsx, js, jsx',
  },
  {
    id: 'python',
    label: 'Python LSP (Pyright)',
    pkg: 'pyright',
    npmPkg: 'pyright',
    bin: 'pyright-langserver',
    languages: 'py',
  },
  {
    id: 'web',
    label: 'HTML / CSS / JSON LSP',
    pkg: 'vscode-langservers-extracted',
    npmPkg: 'vscode-langservers-extracted',
    bin: 'vscode-html-language-server',
    languages: 'html, css, json',
  },
];

function checkModuleResolvable(modName) {
  try {
    require.resolve(modName);
    return true;
  } catch (_) {
    try {
      const p = path.join(__dirname, '..', 'node_modules', ...modName.split('/'));
      return fs.existsSync(p);
    } catch (__) {
      return false;
    }
  }
}

function findBin(binName, lspRoot = DEFAULT_LSP_ROOT) {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const dirs = [
    path.join(lspRoot, 'node_modules', '.bin'),
    ...(process.env.PATH ? process.env.PATH.split(path.delimiter) : []),
    ...(process.platform !== 'win32' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'] : []),
  ];
  for (const d of dirs) {
    if (!d) continue;
    for (const c of [path.join(d, binName), ext ? path.join(d, binName + ext) : null].filter(Boolean)) {
      try {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
      } catch (_) {}
    }
  }
  return null;
}

function resolveRipgrepBinary() {
  try {
    const { rgPath } = require('@vscode/ripgrep');
    if (rgPath) {
      const unpacked = rgPath.replace(/app\.asar([\\/])/i, 'app.asar.unpacked$1');
      if (fs.existsSync(unpacked)) return unpacked;
      if (fs.existsSync(rgPath)) return rgPath;
    }
  } catch (_) {}
  return findBin('rg') || null;
}

function readInstalledLspVersion(npmPkg, lspRoot = DEFAULT_LSP_ROOT) {
  if (!npmPkg) return '';
  try {
    const pkgJsonPath = path.join(lspRoot, 'node_modules', ...String(npmPkg).split('/'), 'package.json');
    if (!fs.existsSync(pkgJsonPath)) return '';
    const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    return String((parsed && parsed.version) || '').trim();
  } catch (_) {
    return '';
  }
}

function compareSemver(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length, 3);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

function getDependenciesStatus({ lspRoot = DEFAULT_LSP_ROOT } = {}) {
  const rgBin = resolveRipgrepBinary();
  let parcelWatcherOk = false;
  try {
    require('@parcel/watcher');
    parcelWatcherOk = true;
  } catch (_) {}

  const rootDir = path.join(__dirname, '..');
  const bundled = [
    { id: 'monaco', label: 'Monaco Editor (Offline Workers)', ok: checkModuleResolvable('monaco-editor'), detail: 'Built-in ES workers & IntelliSense' },
    { id: 'xterm', label: 'xterm.js + Search/WebLinks/Serialize', ok: checkModuleResolvable('@xterm/xterm') && checkModuleResolvable('@xterm/addon-search') && checkModuleResolvable('@xterm/addon-web-links') && checkModuleResolvable('@xterm/addon-serialize'), detail: 'Interactive terminal + addons' },
    { id: 'ripgrep', label: 'Ripgrep Search (@vscode/ripgrep)', ok: !!rgBin, detail: rgBin || 'JS fallback active' },
    { id: 'watcher', label: 'File Watcher (@parcel/watcher)', ok: parcelWatcherOk, detail: parcelWatcherOk ? 'Native @parcel/watcher active' : 'fs.watch fallback active' },
    { id: 'pty', label: 'PTY Terminal Host', ok: fs.existsSync(path.join(rootDir, 'electron', 'ide', 'pty-worker.js')), detail: process.platform === 'win32' ? 'ConPTY worker' : 'Kernel PTY + worker' },
    { id: 'ssh2', label: 'SSH Host Client (ssh2)', ok: checkModuleResolvable('ssh2'), detail: 'Built-in SSH + PTY transport' },
    { id: 'browser-bot', label: 'Akron Browser Bot Extension', ok: fs.existsSync(path.join(rootDir, 'resources', 'akron-browser-bot', 'manifest.json')), detail: 'Bundled extension + 8766 bridge' },
  ];

  const lspServers = OPTIONAL_LSPS.map((item) => {
    const binPath = findBin(item.bin, lspRoot);
    return {
      ...item,
      installed: !!binPath,
      installedVersion: binPath ? readInstalledLspVersion(item.npmPkg, lspRoot) : '',
      path: binPath || '',
    };
  });

  return {
    ok: true,
    bundled,
    lspServers,
    lspRoot,
    healthyCount: bundled.filter((b) => b.ok).length,
    totalBundled: bundled.length,
  };
}

async function verifyNpmIntegrity(npmPkg) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(npmPkg)}/latest`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, error: `npm registry HTTP ${res.status}` };
    const meta = await res.json();
    return {
      ok: true,
      version: meta.version || '',
      integrity: (meta.dist && meta.dist.integrity) || '',
    };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

function runNpmInstall(args, cwd) {
  const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return new Promise((resolve) => {
    execFile(npmBin, args, {
      cwd,
      timeout: 180000,
      maxBuffer: 8 * 1024 * 1024,
      shell: process.platform === 'win32',
      windowsHide: true,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: String(stdout || ''),
        stderr: String(stderr || '') || (err ? err.message : ''),
      });
    });
  });
}

async function installLspServer(id, { lspRoot = DEFAULT_LSP_ROOT, onProgress } = {}) {
  const spec = OPTIONAL_LSPS.find((x) => x.id === id);
  if (!spec) return { ok: false, error: 'Unknown LSP package: ' + id };

  fs.mkdirSync(lspRoot, { recursive: true });
  const pkgJson = path.join(lspRoot, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: 'akron-code-lsp', private: true, version: '1.0.0' }, null, 2));
  }

  if (onProgress) onProgress({ id, phase: 'metadata', message: `Checking ${spec.npmPkg} integrity…` });
  const meta = await verifyNpmIntegrity(spec.npmPkg);

  if (onProgress) onProgress({ id, phase: 'install', message: `Installing ${spec.pkg}${meta.version ? ' v' + meta.version : ''}…` });
  const pkgs = spec.pkg.split(/\s+/).filter(Boolean);
  const res = await runNpmInstall(['install', '--no-audit', '--no-fund', '--prefix', lspRoot, ...pkgs], lspRoot);
  if (!res.ok) {
    return { ok: false, id, error: (res.stderr || res.stdout || 'npm install failed').slice(-320) };
  }
  const binPath = findBin(spec.bin, lspRoot);
  if (onProgress) onProgress({ id, phase: 'done', message: binPath ? `Installed at ${binPath}` : 'Installed' });
  return {
    ok: !!binPath,
    id,
    version: meta.version || '',
    integrity: meta.integrity || '',
    path: binPath || '',
    status: getDependenciesStatus({ lspRoot }),
  };
}

async function checkAndUpdateInstalledLsps({
  lspRoot = DEFAULT_LSP_ROOT,
  apply = true,
  onProgress,
  fetchRegistry = verifyNpmIntegrity,
  installer = installLspServer,
} = {}) {
  const results = [];
  let checkedCount = 0;
  let updatedCount = 0;
  let updatesAvailable = 0;

  for (const spec of OPTIONAL_LSPS) {
    const binPath = findBin(spec.bin, lspRoot);
    if (!binPath) continue;
    checkedCount++;
    const currentVersion = readInstalledLspVersion(spec.npmPkg, lspRoot);
    if (onProgress) onProgress({ id: spec.id, phase: 'check', message: `Checking ${spec.label} updates…` });
    const meta = await fetchRegistry(spec.npmPkg);
    if (!meta || !meta.ok || !meta.version) {
      results.push({ id: spec.id, label: spec.label, ok: false, currentVersion, error: (meta && meta.error) || 'Registry lookup failed' });
      continue;
    }
    const updateAvailable = !currentVersion || compareSemver(meta.version, currentVersion) > 0;
    if (updateAvailable) updatesAvailable++;
    if (updateAvailable && apply) {
      const ins = await installer(spec.id, { lspRoot, onProgress });
      if (ins && ins.ok) updatedCount++;
      results.push({
        id: spec.id,
        label: spec.label,
        ok: !!(ins && ins.ok),
        updated: !!(ins && ins.ok),
        updateAvailable,
        previousVersion: currentVersion,
        version: (ins && ins.version) || meta.version,
        error: (ins && !ins.ok && ins.error) || '',
      });
    } else {
      results.push({
        id: spec.id,
        label: spec.label,
        ok: true,
        updated: false,
        updateAvailable,
        currentVersion,
        latestVersion: meta.version,
      });
    }
  }

  return {
    ok: true,
    checkedCount,
    updatedCount,
    updatesAvailable,
    results,
    status: getDependenciesStatus({ lspRoot }),
  };
}

module.exports = {
  DEFAULT_LSP_ROOT,
  OPTIONAL_LSPS,
  getDependenciesStatus,
  installLspServer,
  findBin,
  resolveRipgrepBinary,
  readInstalledLspVersion,
  compareSemver,
  checkAndUpdateInstalledLsps,
};
