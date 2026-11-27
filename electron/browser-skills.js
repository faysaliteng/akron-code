'use strict';
/**
 * Akron Browser Bot 2.0 Replayable Skills:
 * Records interactive flows (click, type, select, navigate, press) as portable
 * Markdown/JSON skill files under `~/.autobot/browser-skills/` and replays them
 * deterministically with ZERO LLM tokens and automatic semantic self-healing on
 * selector drift.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_DIR = path.join(os.homedir(), '.autobot', 'browser-skills');

function safeSlug(name) {
  return String(name || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function serializeBrowserSkill(skill) {
  const meta = {
    name: String(skill.name || 'untitled'),
    description: String(skill.description || ''),
    startUrl: String(skill.startUrl || ''),
    createdAt: skill.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    healedCount: Number(skill.healedCount) || 0,
  };
  const header = [
    '---',
    `name: ${JSON.stringify(meta.name)}`,
    `description: ${JSON.stringify(meta.description)}`,
    `startUrl: ${JSON.stringify(meta.startUrl)}`,
    `createdAt: ${JSON.stringify(meta.createdAt)}`,
    `updatedAt: ${JSON.stringify(meta.updatedAt)}`,
    `healedCount: ${meta.healedCount}`,
    '---',
    '',
    '```json',
    JSON.stringify({ steps: Array.isArray(skill.steps) ? skill.steps : [] }, null, 2),
    '```',
    '',
  ].join('\n');
  return header;
}

function parseBrowserSkill(raw, filePath = '') {
  const text = String(raw || '');
  const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  const meta = {};
  let body = text;
  if (fm) {
    body = fm[2];
    for (const line of fm[1].split('\n')) {
      const m = /^([a-zA-Z0-9_]+):\s*(.*)$/.exec(line.trim());
      if (!m) continue;
      try { meta[m[1]] = JSON.parse(m[2]); } catch (_) { meta[m[1]] = m[2]; }
    }
  }
  const block = /```json\s*([\s\S]*?)```/.exec(body);
  let steps = [];
  if (block) {
    try {
      const parsed = JSON.parse(block[1]);
      if (parsed && Array.isArray(parsed.steps)) steps = parsed.steps;
    } catch (_) {}
  }
  const slug = path.basename(filePath || '', '.md') || safeSlug(meta.name);
  return {
    slug,
    name: meta.name || slug,
    description: meta.description || '',
    startUrl: meta.startUrl || '',
    createdAt: meta.createdAt || '',
    updatedAt: meta.updatedAt || '',
    healedCount: Number(meta.healedCount) || 0,
    steps,
    filePath: filePath || undefined,
  };
}

function saveSkill(skill, dir = DEFAULT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const slug = safeSlug(skill.slug || skill.name);
  const filePath = path.join(dir, `${slug}.md`);
  const content = serializeBrowserSkill({ ...skill, name: skill.name || slug });
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, slug, filePath };
}

function loadSkill(nameOrSlug, dir = DEFAULT_DIR) {
  const slug = safeSlug(nameOrSlug);
  const filePath = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return null;
  return parseBrowserSkill(fs.readFileSync(filePath, 'utf8'), filePath);
}

function listSkills(dir = DEFAULT_DIR) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  return files.map((f) => parseBrowserSkill(fs.readFileSync(path.join(dir, f), 'utf8'), path.join(dir, f)));
}

function deleteSkill(nameOrSlug, dir = DEFAULT_DIR) {
  const slug = safeSlug(nameOrSlug);
  const filePath = path.join(dir, `${slug}.md`);
  if (!fs.existsSync(filePath)) return { ok: true, deleted: false };
  fs.unlinkSync(filePath);
  return { ok: true, deleted: true, slug };
}

function tokenJaccard(a, b) {
  const setA = new Set(String(a || '').toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(String(b || '').toLowerCase().split(/\W+/).filter(Boolean));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

/**
 * Self-healing element matcher against live AX/DOM snapshot refs.
 * Priority: exact testId -> exact id -> exact ariaLabel -> exact role+name -> placeholder -> fuzzy text.
 */
function healStepTarget(step, refs = []) {
  const fp = (step && step.fingerprint) || {};
  const list = Array.isArray(refs) ? refs : [];
  if (!list.length) return null;

  let best = null;
  let bestScore = 0;
  let reason = '';

  for (const cand of list) {
    if (!cand) continue;
    let score = 0;
    let why = '';
    if (fp.testId && cand.testId && fp.testId === cand.testId) {
      score = 100;
      why = 'matched data-testid';
    } else if (fp.id && cand.id && fp.id === cand.id) {
      score = 92;
      why = 'matched id';
    } else if (fp.ariaLabel && cand.ariaLabel && fp.ariaLabel.toLowerCase() === cand.ariaLabel.toLowerCase()) {
      score = 88;
      why = 'matched aria-label';
    } else if (fp.role && fp.name && cand.role === fp.role && cand.name && cand.name.toLowerCase() === fp.name.toLowerCase()) {
      score = 84;
      why = 'matched role+name';
    } else if (fp.placeholder && cand.placeholder && fp.placeholder.toLowerCase() === cand.placeholder.toLowerCase()) {
      score = 78;
      why = 'matched placeholder';
    } else if (fp.nameAttr && cand.nameAttr && fp.nameAttr === cand.nameAttr) {
      score = 74;
      why = 'matched name attribute';
    } else {
      const sim = tokenJaccard(fp.name || fp.text || '', cand.name || cand.text || '');
      const roleBonus = fp.role && cand.role === fp.role ? 20 : 0;
      const computed = Math.round(sim * 60) + roleBonus;
      if (computed > 42) {
        score = computed;
        why = 'fuzzy accessible-name match';
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = cand;
      reason = why;
    }
  }

  if (!best) return null;
  return {
    candidate: best,
    score: bestScore,
    reason,
    newSelector: best.selector || best.ref,
  };
}

/**
 * Deterministic zero-token skill replay.
 * driver must provide async methods: click(target), type(target, text), select(target, val),
 * navigate(url), press(key), snapshot() -> { refs: [...] }
 */
async function replaySkill(skill, driver, opts = {}) {
  if (!skill || !Array.isArray(skill.steps)) {
    throw new Error('Valid skill with steps[] required');
  }
  const dir = opts.dir || DEFAULT_DIR;
  const persistHeals = opts.persist !== false;
  const results = [];
  let healedCount = 0;
  let mutated = false;

  if (skill.startUrl && typeof driver.navigate === 'function' && !opts.skipStartUrl) {
    await driver.navigate(skill.startUrl);
  }

  for (let i = 0; i < skill.steps.length; i++) {
    const step = skill.steps[i] || {};
    const action = String(step.action || '').toLowerCase();
    if (action === 'navigate' && step.url) {
      const r = await driver.navigate(step.url);
      results.push({ step: i, action, ok: r?.ok !== false, healed: false });
      continue;
    }
    if (action === 'press' && step.key) {
      const r = await driver.press(step.key);
      results.push({ step: i, action, ok: r?.ok !== false, healed: false });
      continue;
    }

    const execTarget = async (target) => {
      if (action === 'click') return await driver.click(target);
      if (action === 'type') return await driver.type(target, step.text ?? step.value ?? '');
      if (action === 'select') return await driver.select(target, step.value ?? '');
      if (action === 'hover' && driver.hover) return await driver.hover(target);
      throw new Error(`Unsupported replay action "${action}"`);
    };

    const primaryTarget = step.selector || step.ref;
    let r = await execTarget(primaryTarget);
    let healed = false;
    let healReason = '';

    if (r && r.found === false && typeof driver.snapshot === 'function') {
      const snap = await driver.snapshot();
      const match = healStepTarget(step, (snap && snap.refs) || []);
      if (match) {
        const retry = await execTarget(match.newSelector);
        if (retry && retry.found !== false && retry.ok !== false) {
          r = retry;
          healed = true;
          healReason = match.reason;
          healedCount++;
          mutated = true;
          step.selector = match.newSelector;
          step.lastHealedAt = new Date().toISOString();
          step.healHistory = [...(step.healHistory || []), { from: primaryTarget, to: match.newSelector, reason: healReason }];
        }
      }
    }

    const ok = r && r.ok !== false && r.found !== false;
    results.push({ step: i, action, target: step.selector || step.ref, ok, healed, healReason });
    if (!ok) {
      return { ok: false, failedAtStep: i, stepsRun: i + 1, healedCount, llmTokensUsed: 0, results };
    }
  }

  if (mutated && persistHeals && skill.name) {
    skill.healedCount = (Number(skill.healedCount) || 0) + healedCount;
    saveSkill(skill, dir);
  }

  return {
    ok: true,
    stepsRun: results.length,
    healedCount,
    llmTokensUsed: 0,
    results,
  };
}

module.exports = {
  DEFAULT_DIR,
  safeSlug,
  serializeBrowserSkill,
  parseBrowserSkill,
  saveSkill,
  loadSkill,
  listSkills,
  deleteSkill,
  healStepTarget,
  replaySkill,
};
