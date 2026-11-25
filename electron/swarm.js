'use strict';
// Supervisor-led multi-agent swarm with complexity-based model routing.
//
// This is the local equivalent of what the Claude app/Claude Code do when a
// task is big enough to need a team: a *lead* model (the supervisor) reads the
// goal, splits it into independent subtasks, tags each subtask with a
// complexity tier, the host routes every subtask to the model tier that fits it
// (small/cheap for mechanical work, frontier for heavy or critical work), the
// subtasks run concurrently on *different* models, and finally the supervisor
// reviews the results and merges them into one answer.
//
// Nothing here imports llm.js. The caller injects `runAgent`, which keeps this
// module pure and testable, and avoids a require cycle.

const TIER_RANK = { small: 0, heavy: 1, critical: 2 };

// ---------- tiers ----------

function normalizeTier(t, fallback) {
  const v = String(t == null ? '' : t).toLowerCase().trim();
  if (!v) return fallback || 'heavy';
  if (/^(small|cheap|fast|light|mini|nano|tiny)$/.test(v)) return 'small';
  if (/^(heavy|large|big|frontier|strong|pro|max)$/.test(v)) return 'heavy';
  if (/^(critical|urgent|hardest|top|supervisor)$/.test(v)) return 'critical';
  // Common natural-language phrasings a supervisor model emits.
  if (/simple|trivial|mechanical|boilerplate|format|typo/.test(v)) return 'small';
  if (/complex|hard|difficult|architect|security|review/.test(v)) return 'critical';
  return fallback || 'heavy';
}

// ---------- roster ----------

// Swarm is restricted to "big frontier" models. A provider opts in either by an
// explicit `frontier: true` flag or by matching a known frontier model family.
// Cheap/local models never enter a swarm roster (they remain fair game for the
// automatic Task/Agent multi-agent path).
const FRONTIER_RE = /(kimi|moonshot|deepseek|glm|zhipu|chatgpt|gpt-?[45]|\bo[1-4]\b|claude|sonnet|opus|gemini[- ]?(pro|ultra)|qwen.*(max|235b)|grok|command-r-plus|mistral-large|frontier)/i;
function isFrontier(p) {
  if (!p) return false;
  if (p.frontier === true) return true;
  const s = [p.model, p.name].filter(Boolean).join(' ');
  return FRONTIER_RE.test(s);
}

// Build the pool of models the swarm may use. The orchestrator's provider list
// is the pool; each entry may carry a `tier` (set in Settings). The currently
// selected provider is always present so a swarm still works with the
// orchestrator disabled — it simply runs every subtask on one model.
function buildRoster(opts = {}) {
  const { orchestrator, provider, frontierOnly } = opts;
  const roster = [];
  const seen = new Set();
  const add = (p, fallbackTier, role) => {
    if (!p || !p.baseURL) return;
    const key = String(p.baseURL) + '|' + String(p.model || '');
    if (seen.has(key)) return;
    seen.add(key);
    roster.push({
      id: p.id || key,
      name: p.name || p.model || 'model',
      baseURL: p.baseURL,
      apiKey: p.apiKey || '',
      model: p.model || '',
      temperature: p.temperature,
      maxTokens: p.maxTokens,
      reasoningLevel: p.reasoningLevel,
      supportsTools: p.supportsTools !== false,
      frontier: isFrontier(p),
      tier: normalizeTier(p.tier, fallbackTier),
      role,
    });
  };

  const provs = (orchestrator && Array.isArray(orchestrator.providers)) ? orchestrator.providers : [];
  provs.forEach((p, i) => add(p, 'heavy', orchestrator && orchestrator.activeIndex === i ? 'active' : 'pool'));
  // The active provider is last but tagged critical when it is the only model,
  // so a single-model setup still gets sensible routing.
  if (provider) add(provider, roster.length ? 'heavy' : 'critical', 'active');

  // Swarm: keep only frontier models. Mutate in place so callers hold the same
  // array reference.
  if (frontierOnly) {
    const keep = roster.filter((r) => r.frontier);
    roster.length = 0;
    if (keep.length) {
      roster.push(...keep);
    } else {
      // Never dead-end the user: if nothing in the pool is recognisably
      // frontier, fall back to the provider that is actually in use (or the
      // orchestrator's active entry), so a swarm still runs on one model.
      const pick = provider
        || (provs[orchestrator && orchestrator.activeIndex] || provs[0]);
      if (pick) {
        seen.clear();
        add(pick, 'critical', 'active');
      }
    }
  }
  return roster;
}

// Pick the model a subtask of `tier` should run on. Exact tier wins; otherwise
// pick the nearest tier, preferring cheaper models for small work and stronger
// models for heavy/critical work.
function pickProvider(roster, tier) {
  if (!roster || !roster.length) return null;
  const want = normalizeTier(tier);
  const exact = roster.find((r) => r.tier === want);
  if (exact) return exact;
  const rank = TIER_RANK[want];
  const sorted = [...roster].sort((a, b) => {
    const da = Math.abs(TIER_RANK[a.tier] - rank);
    const db = Math.abs(TIER_RANK[b.tier] - rank);
    if (da !== db) return da - db;
    // Tie-break: small tasks fall to the cheapest, others to the strongest.
    return want === 'small' ? TIER_RANK[a.tier] - TIER_RANK[b.tier] : TIER_RANK[b.tier] - TIER_RANK[a.tier];
  });
  return sorted[0];
}

// Group the roster by tier for display / planning prompts.
function rosterSummary(roster) {
  const by = { small: [], heavy: [], critical: [] };
  for (const r of roster || []) (by[r.tier] || by.heavy).push(r.model || r.name);
  return Object.entries(by)
    .filter(([, v]) => v.length)
    .map(([k, v]) => `${k}: ${[...new Set(v)].join(', ')}`)
    .join(' | ') || 'single model';
}

// ---------- JSON extraction ----------

// Supervisor models are chatty: they wrap JSON in prose or fences. Extract the
// first balanced JSON object, ignoring braces inside strings.
function extractJSON(text) {
  const s = String(text == null ? '' : text);
  const candidates = [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) candidates.push(fence[1]);
  candidates.push(s);
  for (const c of candidates) {
    for (let start = c.indexOf('{'); start !== -1; start = c.indexOf('{', start + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < c.length; i++) {
        const ch = c[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(c.slice(start, i + 1)); } catch (_) { break; }
          }
        }
      }
    }
  }
  return null;
}

// Normalize whatever the supervisor produced into a stable task list.
function normalizePlan(raw, opts = {}) {
  const maxTasks = Math.max(1, Math.min(Number(opts.maxTasks) || 6, 12));
  if (!raw || typeof raw !== 'object') return null;
  let list = Array.isArray(raw.subtasks) ? raw.subtasks
    : Array.isArray(raw.tasks) ? raw.tasks
      : Array.isArray(raw.steps) ? raw.steps
        : null;
  if (!list) return null;
  const tasks = [];
  list.slice(0, maxTasks).forEach((t, i) => {
    if (!t) return;
    if (typeof t === 'string') {
      tasks.push({ id: 't' + (i + 1), title: t.slice(0, 80), prompt: t, tier: 'heavy', model: null });
      return;
    }
    const prompt = t.prompt || t.instructions || t.task || t.description || '';
    const title = t.title || t.name || t.description || prompt;
    if (!String(prompt || title).trim()) return;
    tasks.push({
      id: String(t.id || 't' + (i + 1)),
      title: String(title || '').slice(0, 120),
      prompt: String(prompt || title),
      tier: normalizeTier(t.tier || t.complexity || t.model_tier, 'heavy'),
      model: t.model ? String(t.model) : null,
    });
  });
  if (!tasks.length) return null;
  return {
    subtasks: tasks,
    synthesis: typeof raw.synthesis === 'string' ? raw.synthesis
      : typeof raw.merge === 'string' ? raw.merge : '',
    notes: typeof raw.notes === 'string' ? raw.notes : '',
  };
}

// ---------- prompts ----------

const SUPERVISOR_PLAN_PROMPT = `You are the SUPERVISOR (lead) of a multi-agent team.
Decompose the user's goal into independent subtasks that can run CONCURRENTLY on
different models. Rules:
- 2 to N subtasks (N = {MAX}). Prefer 3-5 for a substantial build.
- Each subtask must be self-contained: another agent will receive only that
  subtask's text plus the original goal, with no memory of this conversation.
- Give each subtask a complexity tier:
  * "small"  — mechanical, short, formatting, lookups, simple prose, boilerplate.
  * "heavy"  — real implementation work, writing a component, research, analysis.
  * "critical" — architecture, security, correctness review, the hard core of the task.
- Assign distinct output files/areas per subtask so concurrent agents do not
  overwrite each other. Say which files each subtask owns.
- Add a "synthesis" instruction describing how the results should be merged.

The available model tiers are: {ROSTER}
Route expensive tiers to work that needs them and cheap tiers to mechanical work.

Reply with ONLY a JSON object, no prose, no markdown fence:
{"subtasks":[{"id":"t1","title":"short label","tier":"small|heavy|critical","prompt":"complete instructions for that agent","owns":["path/or/area"]}],"synthesis":"how to merge the results"}

USER GOAL:
{GOAL}`;

const SUPERVISOR_MERGE_PROMPT = `You are the SUPERVISOR (lead) of a multi-agent team that has just
finished its subtasks. Read every result below and produce the single final answer
for the user. Rules:
- Be complete: include the file paths that were created and what works.
- Call out anything that failed or was skipped, plainly.
- Do not invent work that no agent reported doing.
- If the subtasks produce a deliverable (website/code), state where it lives and
  that it is on disk.
{FILES}
SUBTASK RESULTS:
{RESULTS}`;

function workerPrompt(goal, task) {
  const owns = Array.isArray(task.owns) && task.owns.length
    ? `\nYou own these files/areas: ${task.owns.join(', ')}. Do not modify files owned by other agents.`
    : '\nOnly create/modify the files this task needs. Other agents are editing other files concurrently.';
  return `You are one worker on a multi-agent team. Other workers are working on OTHER
parts of the same goal at the same time in the same project folder.
YOUR SUBTASK (${task.tier} tier): ${task.title}
${task.prompt}${owns}

OVERALL GOAL (context only — do not redo work outside your subtask):
${goal}

Do your subtask now and finish with a short report of what you created/changed.`;
}

// ---------- runner ----------

// Decompose the goal with the supervisor. Returns { subtasks, synthesis } or null.
async function decompose(opts) {
  const { runAgent, supervisor, roster, goal, emit = () => {}, maxTasks = 6 } = opts;
  if (typeof runAgent !== 'function' || !supervisor) return null;
  const prompt = SUPERVISOR_PLAN_PROMPT
    .replace('{MAX}', String(maxTasks))
    .replace('{ROSTER}', rosterSummary(roster))
    .replace('{GOAL}', goal);
  let text = '';
  try {
    const out = await runAgent({
      provider: supervisor,
      messages: [{ role: 'user', content: prompt }],
      maxSteps: opts.maxSteps || 0,
      cwd: opts.cwd,
      signal: opts.signal,
      useMemory: false,
      emit: (evt) => emit({ ...evt, subagent: 'supervisor', role: 'supervisor' }),
    });
    const last = [...(out || [])].reverse().find((m) => m.role === 'assistant' && m.content);
    text = last ? last.content : '';
  } catch (e) {
    emit({ type: 'swarm', phase: 'plan-failed', error: e.message });
    return null;
  }
  const parsed = extractJSON(text);
  const plan = normalizePlan(parsed, { maxTasks });
  if (!plan) emit({ type: 'swarm', phase: 'plan-unparsed', raw: String(text).slice(0, 600) });
  return plan;
}

// Run the whole supervisor → workers → review loop.
// opts: { goal, runAgent, provider, orchestrator, emit, tasks?, concurrency?,
//         maxTasks?, maxSteps?, cwd?, signal?, critique?, supervisor? }
async function swarm(goal, opts = {}) {
  const { runAgent } = opts;
  if (typeof runAgent !== 'function') throw new Error('swarm requires a runAgent function');
  if (!goal || !String(goal).trim()) throw new Error('swarm requires a goal');
  const emit = opts.emit || (() => {});
  const started = Date.now();
  // Swarm runs only on frontier models: the supervisor and every worker draw
  // from a frontier-only roster. (Automatic Task/Agent delegation still uses
  // the full pool, including cheap models, and is unaffected.)
  const roster = buildRoster({ orchestrator: opts.orchestrator, provider: opts.provider, frontierOnly: true });

  // Supervisor: an explicit pin wins; otherwise the strongest tier available.
  const supervisor = opts.supervisor
    ? { ...opts.supervisor, tier: 'critical' }
    : (pickProvider(roster, 'critical') || (opts.provider ? { ...opts.provider, tier: 'critical' } : null));

  if (!supervisor) throw new Error('swarm has no model to run on (configure a provider or an orchestrator tier)');
  // The supervisor is normally already in the roster; only append it when the
  // topology has no critical-tier entry (single-model setups).
  const supKey = String(supervisor.baseURL || '') + '|' + String(supervisor.model || '');
  if (!roster.some((r) => String(r.baseURL || '') + '|' + String(r.model || '') === supKey)) {
    roster.push({ ...supervisor, tier: 'critical', role: 'supervisor' });
  }

  emit({
    type: 'swarm',
    phase: 'start',
    goal,
    supervisor: { model: supervisor.model, baseURL: supervisor.baseURL },
    roster: roster.map((r) => ({ model: r.model, tier: r.tier })),
  });

  // ---- 1. Plan ----
  let plan = null;
  let source = 'supervisor';
  if (Array.isArray(opts.tasks) && opts.tasks.length) {
    plan = normalizePlan({ subtasks: opts.tasks, synthesis: opts.synthesis }, { maxTasks: opts.maxTasks });
    source = 'caller';
  }
  if (!plan) {
    plan = await decompose({
      runAgent, supervisor, roster, goal, emit,
      maxTasks: opts.maxTasks, maxSteps: opts.maxSteps, cwd: opts.cwd, signal: opts.signal,
    });
  }
  if (!plan) {
    source = 'fallback';
    plan = { subtasks: [{ id: 't1', title: 'Complete the goal', prompt: goal, tier: 'heavy', model: null, owns: [] }], synthesis: '' };
  }

  const tasks = plan.subtasks.map((t, i) => {
    const provider = t.model
      ? { ...pickProvider(roster, t.tier), model: t.model }
      : pickProvider(roster, t.tier);
    return {
      ...t,
      index: i,
      provider,
      model: provider ? provider.model : null,
      tier: provider ? provider.tier : t.tier,
    };
  });

  emit({
    type: 'swarm',
    phase: 'planned',
    source,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, tier: t.tier, model: t.model })),
  });

  // ---- 2. Dispatch: every subtask is a distinct prompt on its own model ----
  const limit = Math.max(1, Number(opts.concurrency) || 4);
  const results = new Array(tasks.length);
  let cursor = 0;

  const runOne = async (task) => {
    const name = task.title || task.id;
    const agentId = String(task.id);
    const p = task.provider || opts.provider;
    const t0 = Date.now();
    emit({ type: 'subagent', id: agentId, name, status: 'running', role: 'worker', tier: task.tier, model: p ? p.model : null });
    try {
      const out = await runAgent({
        provider: p,
        messages: [{ role: 'user', content: workerPrompt(String(goal), task) }],
        maxSteps: opts.maxSteps || 0,
        cwd: opts.cwd,
        signal: opts.signal,
        useMemory: opts.useMemory,
        emit: (evt) => emit({ ...evt, subagent: name, agentId, tier: task.tier, model: p ? p.model : null }),
      });
      const last = [...(out || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      const result = last ? last.content : '(worker finished with no text)';
      const ms = Date.now() - t0;
      emit({ type: 'subagent', id: agentId, name, status: 'done', role: 'worker', tier: task.tier, model: p ? p.model : null, ms });
      return { id: agentId, title: task.title, tier: task.tier, model: p ? p.model : null,
        baseURL: p ? p.baseURL : null, status: 'done', ms, result };
    } catch (e) {
      const ms = Date.now() - t0;
      emit({ type: 'subagent', id: agentId, name, status: 'error', role: 'worker', tier: task.tier, model: p ? p.model : null, ms });
      return { id: agentId, title: task.title, tier: task.tier, model: p ? p.model : null,
        baseURL: p ? p.baseURL : null, status: 'error', ms, result: 'Error: ' + e.message };
    }
  };

  const next = async () => {
    while (cursor < tasks.length) {
      const i = cursor++;
      results[i] = await runOne(tasks[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, next));

  const done = results.filter(Boolean);
  emit({ type: 'swarm', phase: 'dispatched', results: done.map((r) => ({ id: r.id, title: r.title, tier: r.tier, model: r.model, status: r.status, ms: r.ms })) });

  // ---- 3. Supervisor review / merge ----
  let answer = '';
  let reviewError = null;
  if (opts.critique !== false) {
    emit({ type: 'subagent', id: 'supervisor', name: 'supervisor (review)', status: 'running', role: 'supervisor', tier: 'critical', model: supervisor.model });
    const report = done.map((r) => `### ${r.title} — ${r.tier} — ${r.model || 'model'} — ${r.status} (${r.ms}ms)\n${r.result}`).join('\n\n');
    const files = done.filter((r) => /\.(html?|css|js|jsx|tsx|ts|json|md|py)\b/i.test(r.result)).length
      ? '\nThe team reported creating files. Make sure the final answer names the entry file.\n' : '';
    try {
      const out = await runAgent({
        provider: supervisor,
        messages: [{
          role: 'user',
          content: SUPERVISOR_MERGE_PROMPT
            .replace('{FILES}', files)
            .replace('{RESULTS}', report)
            .replace('{GOAL}', String(goal)) + (plan.synthesis ? `\n\nMERGE INSTRUCTION FROM THE PLAN: ${plan.synthesis}` : ''),
        }],
        maxSteps: opts.maxSteps || 0,
        cwd: opts.cwd,
        signal: opts.signal,
        useMemory: false,
        emit: (evt) => emit({ ...evt, subagent: 'supervisor', role: 'supervisor' }),
      });
      const last = [...(out || [])].reverse().find((m) => m.role === 'assistant' && m.content);
      answer = last ? last.content : '';
    } catch (e) {
      reviewError = e.message;
    }
    emit({ type: 'subagent', id: 'supervisor', name: 'supervisor (review)', status: reviewError ? 'error' : 'done', role: 'supervisor', tier: 'critical', model: supervisor.model });
  }

  if (!answer) {
    answer = done.map((r) => `### ${r.title} (${r.tier} · ${r.model || 'model'})\n${r.result}`).join('\n\n');
  }

  const summary = {
    supervisor: { model: supervisor.model, baseURL: supervisor.baseURL },
    planSource: source,
    tasks,
    results: done,
    answer,
    reviewError,
    ms: Date.now() - started,
  };
  emit({ type: 'swarm', phase: 'done', ms: summary.ms, answer: answer.slice(0, 4000) });
  return summary;
}

module.exports = {
  TIER_RANK, normalizeTier, buildRoster, pickProvider, rosterSummary,
  extractJSON, normalizePlan, swarm, decompose,
  SUPERVISOR_PLAN_PROMPT, SUPERVISOR_MERGE_PROMPT,
};
