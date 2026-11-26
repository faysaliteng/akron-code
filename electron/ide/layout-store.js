'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function layoutsDir() {
  const dir = path.join(os.homedir(), '.autobot', 'ide-layouts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

function normalizeCwdKey(cwd) {
  const clean = String(cwd || '').trim().replace(/[\\/]+$/, '');
  const norm = process.platform === 'win32' ? clean.toLowerCase() : clean;
  return crypto.createHash('sha256').update(norm || 'default').digest('hex').slice(0, 16);
}

function layoutFileFor(cwd) {
  return path.join(layoutsDir(), `${normalizeCwdKey(cwd)}.json`);
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sanitizeLayout(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const openTabs = Array.isArray(raw.openTabs)
    ? raw.openTabs
      .filter((t) => t && typeof t.path === 'string' && t.path.trim())
      .slice(0, 25)
      .map((t) => ({ path: t.path, pinned: !!t.pinned }))
    : [];

  const viewStates = {};
  if (raw.viewStates && typeof raw.viewStates === 'object') {
    for (const [k, v] of Object.entries(raw.viewStates).slice(0, 40)) {
      if (!k || !v || typeof v !== 'object') continue;
      viewStates[k] = {
        line: clampNum(v.line, 1, 1000000, 1),
        column: clampNum(v.column, 1, 100000, 1),
        scrollTop: clampNum(v.scrollTop, 0, 10000000, 0),
      };
    }
  }

  let terminalSerialized = typeof raw.terminalSerialized === 'string' ? raw.terminalSerialized : '';
  if (Buffer.byteLength(terminalSerialized, 'utf8') > 65536) {
    terminalSerialized = terminalSerialized.slice(-60000);
  }

  const validLeftTabs = new Set(['explorer', 'search', 'git', 'changes']);
  const validBottomTabs = new Set(['terminal', 'problems', 'output']);

  return {
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    openTabs,
    activeTabPath: typeof raw.activeTabPath === 'string' ? raw.activeTabPath : null,
    splitTabPath: typeof raw.splitTabPath === 'string' ? raw.splitTabPath : null,
    viewStates,
    leftTab: raw.leftTab === null ? null : (validLeftTabs.has(raw.leftTab) ? raw.leftTab : 'explorer'),
    leftW: clampNum(raw.leftW, 170, 460, 244),
    bottomTab: raw.bottomTab === null ? null : (validBottomTabs.has(raw.bottomTab) ? raw.bottomTab : 'terminal'),
    bottomH: clampNum(raw.bottomH, 110, 460, 210),
    rightOpen: typeof raw.rightOpen === 'boolean' ? raw.rightOpen : true,
    rightW: clampNum(raw.rightW, 300, 620, 390),
    ghostEnabled: !!raw.ghostEnabled,
    terminalSerialized,
    updatedAt: Date.now(),
  };
}

function loadLayout(cwd) {
  try {
    if (!cwd || !String(cwd).trim()) return { ok: true, layout: null };
    const fp = layoutFileFor(cwd);
    if (!fs.existsSync(fp)) return { ok: true, layout: null };
    const parsed = JSON.parse(fs.readFileSync(fp, 'utf8'));
    return { ok: true, layout: sanitizeLayout(parsed) };
  } catch (e) {
    return { ok: false, error: e.message || String(e), layout: null };
  }
}

function saveLayout(cwd, layout) {
  try {
    if (!cwd || !String(cwd).trim()) return { ok: false, error: 'cwd required' };
    const clean = sanitizeLayout({ ...(layout || {}), cwd: String(cwd) });
    const fp = layoutFileFor(cwd);
    const tmp = `${fp}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, fp);
    try { fs.chmodSync(fp, 0o600); } catch (_) {}
    return { ok: true, path: fp };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

module.exports = {
  loadLayout,
  saveLayout,
  sanitizeLayout,
  normalizeCwdKey,
  layoutFileFor,
};
