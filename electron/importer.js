'use strict';
/**
 * 1-Click Read-Only External Configuration Importer
 * Discovers & non-destructively imports rules, MCP servers, and preferences from:
 *   - Cursor (~/.cursor/mcp.json, .cursorrules, .cursor/rules/*.mdc)
 *   - Claude Code (~/.claude/CLAUDE.md, ~/.claude.json, .claude/agents/*.md)
 *   - VS Code (User/settings.json theme/editor prefs)
 *
 * SECURITY INVARIANT: Never writes, touches, or deletes source files/directories.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

function readTextSafe(p) {
  try {
    if (p && fs.existsSync(p) && fs.statSync(p).isFile()) {
      return fs.readFileSync(p, 'utf8');
    }
  } catch (_) {}
  return null;
}

function readJsonSafe(p) {
  const txt = readTextSafe(p);
  if (!txt) return null;
  try { return JSON.parse(txt); } catch (_) { return null; }
}

function defaultVsCodeSettingsPaths(homeDir, platform = process.platform) {
  const home = homeDir || os.homedir();
  const out = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'settings.json'),
    path.join(home, '.config', 'Code', 'User', 'settings.json'),
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'settings.json'),
    path.join(home, '.vscode', 'settings.json'),
  ];
  if (platform === 'darwin') return [out[0], out[3]];
  if (platform === 'win32') return [out[2], out[3]];
  return [out[1], out[3]];
}

function scanExternalConfigs({ homeDir = os.homedir(), cwd = process.cwd(), vsCodeSettingsPath = '' } = {}) {
  const items = [];

  // 1. Cursor
  const cursorMcpPath = path.join(homeDir, '.cursor', 'mcp.json');
  const cursorMcp = readJsonSafe(cursorMcpPath);
  if (cursorMcp && cursorMcp.mcpServers && typeof cursorMcp.mcpServers === 'object') {
    const names = Object.keys(cursorMcp.mcpServers);
    if (names.length) {
      items.push({
        id: 'cursor:mcp',
        source: 'cursor',
        kind: 'mcp',
        label: `Cursor MCP Servers (${names.length})`,
        path: cursorMcpPath,
        count: names.length,
        preview: names.join(', '),
        payload: cursorMcp.mcpServers,
      });
    }
  }

  const cursorRulesFile = path.join(cwd, '.cursorrules');
  const cursorRulesText = readTextSafe(cursorRulesFile);
  if (cursorRulesText && cursorRulesText.trim()) {
    items.push({
      id: 'cursor:rules-file',
      source: 'cursor',
      kind: 'rules',
      label: '.cursorrules (Project)',
      path: cursorRulesFile,
      bytes: Buffer.byteLength(cursorRulesText, 'utf8'),
      preview: cursorRulesText.trim().slice(0, 120),
      payload: { filename: '.cursorrules', content: cursorRulesText },
    });
  }

  const mdcDir = path.join(cwd, '.cursor', 'rules');
  try {
    if (fs.existsSync(mdcDir) && fs.statSync(mdcDir).isDirectory()) {
      const mdcFiles = fs.readdirSync(mdcDir).filter((f) => /\.(mdc|md)$/i.test(f)).sort();
      for (const f of mdcFiles) {
        const fp = path.join(mdcDir, f);
        const content = readTextSafe(fp);
        if (content) {
          items.push({
            id: `cursor:mdc:${f}`,
            source: 'cursor',
            kind: 'rules',
            label: `Cursor Rule: ${f}`,
            path: fp,
            bytes: Buffer.byteLength(content, 'utf8'),
            preview: content.trim().slice(0, 120),
            payload: { filename: f, content },
          });
        }
      }
    }
  } catch (_) {}

  // 2. Claude Code
  const claudeGlobalMd = path.join(homeDir, '.claude', 'CLAUDE.md');
  const claudeMdText = readTextSafe(claudeGlobalMd);
  if (claudeMdText && claudeMdText.trim()) {
    items.push({
      id: 'claude:global-md',
      source: 'claude',
      kind: 'rules',
      label: 'Global ~/.claude/CLAUDE.md',
      path: claudeGlobalMd,
      bytes: Buffer.byteLength(claudeMdText, 'utf8'),
      preview: claudeMdText.trim().slice(0, 120),
      payload: { filename: 'CLAUDE.global.md', content: claudeMdText },
    });
  }

  const claudeJsonPath = path.join(homeDir, '.claude.json');
  const claudeJson = readJsonSafe(claudeJsonPath);
  if (claudeJson && claudeJson.mcpServers && typeof claudeJson.mcpServers === 'object') {
    const names = Object.keys(claudeJson.mcpServers);
    if (names.length) {
      items.push({
        id: 'claude:mcp',
        source: 'claude',
        kind: 'mcp',
        label: `Claude Code MCP Servers (${names.length})`,
        path: claudeJsonPath,
        count: names.length,
        preview: names.join(', '),
        payload: claudeJson.mcpServers,
      });
    }
  }

  const claudeAgentsDir = path.join(cwd, '.claude', 'agents');
  try {
    if (fs.existsSync(claudeAgentsDir) && fs.statSync(claudeAgentsDir).isDirectory()) {
      const files = fs.readdirSync(claudeAgentsDir).filter((f) => f.endsWith('.md')).sort();
      for (const f of files) {
        const fp = path.join(claudeAgentsDir, f);
        const content = readTextSafe(fp);
        if (content) {
          items.push({
            id: `claude:agent:${f}`,
            source: 'claude',
            kind: 'agent',
            label: `Claude Sub-Agent: ${f}`,
            path: fp,
            bytes: Buffer.byteLength(content, 'utf8'),
            preview: content.trim().slice(0, 120),
            payload: { filename: f, content },
          });
        }
      }
    }
  } catch (_) {}

  // 3. VS Code settings.json
  const vsPaths = vsCodeSettingsPath ? [vsCodeSettingsPath] : defaultVsCodeSettingsPaths(homeDir);
  for (const vp of vsPaths) {
    const vs = readJsonSafe(vp);
    if (vs && typeof vs === 'object') {
      const prefs = {};
      if (vs['editor.fontFamily']) prefs.monoFont = String(vs['editor.fontFamily']);
      if (vs['editor.fontSize']) prefs.editorFontSize = Number(vs['editor.fontSize']) || 14;
      if (vs['editor.tabSize']) prefs.tabSize = Number(vs['editor.tabSize']) || 2;
      if (vs['workbench.colorTheme']) prefs.colorTheme = String(vs['workbench.colorTheme']);
      if (Object.keys(prefs).length) {
        items.push({
          id: 'vscode:settings',
          source: 'vscode',
          kind: 'preferences',
          label: 'VS Code Editor Preferences',
          path: vp,
          preview: Object.entries(prefs).map(([k, v]) => `${k}=${v}`).join(', '),
          payload: prefs,
        });
        break;
      }
    }
  }

  return {
    ok: true,
    readOnlySource: true,
    scannedAt: new Date().toISOString(),
    count: items.length,
    items,
  };
}

function importExternalConfigs({
  items = [],
  selectedIds = null,
  targetDir = path.join(os.homedir(), '.autobot'),
} = {}) {
  const chosenSet = Array.isArray(selectedIds) ? new Set(selectedIds) : null;
  const toApply = (Array.isArray(items) ? items : []).filter((it) => !chosenSet || chosenSet.has(it.id));

  fs.mkdirSync(targetDir, { recursive: true });
  const rulesDir = path.join(targetDir, 'imported-rules');
  const agentsDir = path.join(targetDir, 'agents');
  const mcpPath = path.join(targetDir, 'imported-mcp.json');
  const prefsPath = path.join(targetDir, 'imported-prefs.json');

  const applied = [];
  const mergedMcp = readJsonSafe(mcpPath) || {};
  const mergedPrefs = readJsonSafe(prefsPath) || {};

  for (const item of toApply) {
    if (!item || !item.payload) continue;
    if (item.kind === 'mcp') {
      Object.assign(mergedMcp, item.payload);
      applied.push({ id: item.id, kind: 'mcp', target: mcpPath });
    } else if (item.kind === 'rules') {
      fs.mkdirSync(rulesDir, { recursive: true });
      const safeName = path.basename(String(item.payload.filename || item.id).replace(/[^a-zA-Z0-9._-]+/g, '_'));
      const outPath = path.join(rulesDir, safeName.endsWith('.md') || safeName.endsWith('.mdc') || safeName === '.cursorrules' ? safeName : `${safeName}.md`);
      fs.writeFileSync(outPath, String(item.payload.content || ''), 'utf8');
      applied.push({ id: item.id, kind: 'rules', target: outPath });
    } else if (item.kind === 'agent') {
      fs.mkdirSync(agentsDir, { recursive: true });
      const safeName = path.basename(String(item.payload.filename || `${item.id}.md`));
      const outPath = path.join(agentsDir, safeName);
      fs.writeFileSync(outPath, String(item.payload.content || ''), 'utf8');
      applied.push({ id: item.id, kind: 'agent', target: outPath });
    } else if (item.kind === 'preferences') {
      Object.assign(mergedPrefs, item.payload);
      applied.push({ id: item.id, kind: 'preferences', target: prefsPath });
    }
  }

  if (Object.keys(mergedMcp).length) {
    fs.writeFileSync(mcpPath, JSON.stringify(mergedMcp, null, 2), 'utf8');
  }
  if (Object.keys(mergedPrefs).length) {
    fs.writeFileSync(prefsPath, JSON.stringify(mergedPrefs, null, 2), 'utf8');
  }

  return {
    ok: true,
    readOnlySourcePreserved: true,
    importedCount: applied.length,
    targetDir,
    applied,
  };
}

module.exports = {
  scanExternalConfigs,
  importExternalConfigs,
  defaultVsCodeSettingsPaths,
};
