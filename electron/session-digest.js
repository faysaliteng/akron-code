'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const sessionlog = require('./sessionlog');

function clip(s, max) {
  const txt = String(s || '').replace(/\s+/g, ' ').trim();
  if (!txt) return '';
  return txt.length > max ? txt.slice(0, max - 1) + '…' : txt;
}

function safeConvDir(convId) {
  return String(convId || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function readTurnFiles(convId, sessionsRoot = null) {
  if (!convId) return [];
  const root = sessionsRoot || sessionlog.ROOT || path.join(os.homedir(), '.autobot', 'sessions');
  const rawDir = path.join(root, String(convId));
  const dir = fs.existsSync(rawDir) ? rawDir : path.join(root, safeConvDir(convId));
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch (_) {
    return [];
  }
}

function extractTurnAnchors(filePath) {
  const turnId = path.basename(filePath, '.jsonl');
  let title = '';
  let ts = 0;
  const anchors = [];
  let lines = [];
  try {
    lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch (_) {
    return { turnId, title, ts, anchors };
  }

  for (let idx = 0; idx < lines.length; idx++) {
    let ev;
    try { ev = JSON.parse(lines[idx]); } catch (_) { continue; }
    if (!ev || typeof ev !== 'object') continue;
    const stepId = `${turnId}:s${idx}`;
    if (ev.t && !ts) ts = ev.t;
    if (ev.title && !title) title = String(ev.title);

    if (ev.type === 'turn') {
      const uTxt = clip(ev.prompt || ev.user || ev.text || title, 280);
      if (uTxt) {
        anchors.push({
          anchorType: 'U',
          stepId,
          turnId,
          role: 'user',
          toolName: '',
          text: uTxt,
          ts: ev.t || Date.now(),
        });
      }
    } else if (ev.type === 'tool') {
      const argStr = clip(typeof ev.args === 'string' ? ev.args : JSON.stringify(ev.args || {}), 180);
      anchors.push({
        anchorType: 'K',
        stepId,
        turnId,
        role: 'tool',
        toolName: String(ev.name || 'tool'),
        text: `${ev.name || 'tool'}(${argStr})`,
        ts: ev.t || Date.now(),
      });
    } else if (ev.type === 'toolResult' && ev.isError) {
      anchors.push({
        anchorType: 'K',
        stepId,
        turnId,
        role: 'toolError',
        toolName: String(ev.name || 'tool'),
        text: `ERR ${clip(ev.result || ev.output || '', 220)}`,
        ts: ev.t || Date.now(),
      });
    } else if (ev.type === 'text' && ev.text) {
      const summary = clip(ev.text, 260);
      if (summary) {
        anchors.push({
          anchorType: 'K',
          stepId,
          turnId,
          role: 'assistant',
          toolName: '',
          text: summary,
          ts: ev.t || Date.now(),
        });
      }
    }
  }
  return { turnId, title, ts, anchors };
}

function buildTrajectoryDigest({
  convId,
  sessionsRoot = null,
  maxTokens = 600,
  maxChars = null,
} = {}) {
  const charBudget = Math.max(240, Number(maxChars) || Math.floor((Number(maxTokens) || 600) * 4));
  const files = readTurnFiles(convId, sessionsRoot);
  const anchors = [];
  let title = '';
  for (const fp of files) {
    const t = extractTurnAnchors(fp);
    if (t.title) title = t.title;
    anchors.push(...t.anchors);
  }

  const lines = [];
  let used = 0;
  const kept = [];
  for (const a of anchors) {
    const line = `[${a.anchorType} ${a.stepId}] ${a.text}`;
    if (used + line.length + 1 > charBudget) break;
    lines.push(line);
    kept.push(a);
    used += line.length + 1;
  }

  return {
    convId,
    title: title || convId,
    totalAnchors: anchors.length,
    includedAnchors: kept.length,
    truncated: kept.length < anchors.length,
    charBudget,
    digest: lines.join('\n'),
    anchors: kept,
  };
}

module.exports = {
  extractTurnAnchors,
  buildTrajectoryDigest,
  readTurnFiles,
};
